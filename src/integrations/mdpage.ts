import {randomUUID} from 'node:crypto';
import {load} from 'cheerio';
import {marked} from 'marked';
import {articleReviewStillValid} from '../main/article-review';
import type {Account,ExecutionResult,LinkResult,Task} from '../shared/types';
import type {Batch5Dependencies,Batch5Intent,Batch5OpaqueResponse,Batch5TaskState} from './batch5-contract';
import {batch5State,connectedDependencies,connectedRequest,hashBatch5,parseConnectedJson,persistBatch5Receipt,persistBatch5Response,stateFromIntent,type ConnectedContext} from './batch5-connected';
import {renderShareYourHtmlArticle} from './shareyourhtml-article';

export const MDPAGE_ORIGIN='https://md.page';
export const MDPAGE_API=MDPAGE_ORIGIN+'/api';
const CHANNEL='mdpage',KEY=/^mdp_[A-Za-z0-9_-]{20,200}$/,IDENTIFIER=/^[A-Za-z0-9_-]{4,128}$/,USERNAME=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,USERID=/^[A-Za-z0-9_-]{6,128}$/;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const normalize=(v:string)=>v.replace(/\s+/g,' ').trim();
const noindex=(value:string)=>/(?:^|[:,\s])(?:noindex|none)(?=$|[,;\s])/i.test(value);
const unknown=(message:string):ExecutionResult=>({status:'review',reasonCode:'submission_unknown',message});
export interface MdpageCredential {version:1;apiKey:string;userId:string;username:string}
interface Document {title:string;body:string;content:string;slug:string;username:string;target:string;request:string;sourceHash:string;requestHash:string}
interface Published {identifier:string;url:string;rawResponse:string}

export function parseMdpageCredential(raw:string|undefined):MdpageCredential|undefined {
 try{const v:unknown=JSON.parse(raw??'null');if(object(v)&&v.version===1&&typeof v.apiKey==='string'&&KEY.test(v.apiKey)&&typeof v.userId==='string'&&USERID.test(v.userId)&&typeof v.username==='string'&&USERNAME.test(v.username))return {version:1,apiKey:v.apiKey,userId:v.userId,username:v.username}}catch{/* untrusted credential */}
}
const auth=(secret:Pick<MdpageCredential,'apiKey'>):HeadersInit=>({authorization:`Bearer ${secret.apiKey}`,'content-type':'application/json',accept:'application/json'});
function account(context:ConnectedContext,secret?:MdpageCredential):Account|undefined {
 const a=context.getAccount();if(!a||a.channelId!==CHANNEL||a.id!==context.task.accountId||a.ownerSiteId!==context.site.id||a.status!=='registered'||a.retiredAt||!a.hasPassword||a.credentialKind!=='api_token'||a.email!==''||!USERID.test(a.username))return;
 try{const u=new URL(a.publicationUrl??''),username=u.hostname.slice(0,-8);if(!USERNAME.test(username)||u.href!==`https://${username}.md.page/`||secret&&(a.username!==secret.userId||username!==secret.username))return;return a}catch{return}
}
export async function probeMdpageConnection(apiKey:string,deps:Batch5Dependencies={},signal:AbortSignal=new AbortController().signal):Promise<{authenticated:true;identitySource:'remote_me';userId:string;username:string;totalPages:number}>{
 if(!KEY.test(apiKey))throw Error('mdpage_credential_invalid');
 const owner=await connectedRequest(MDPAGE_API+'/me',{method:'GET',headers:auth({apiKey})},deps,signal,64_000),v=parseConnectedJson(owner);
 if(owner.status!==200||typeof v?.id!=='string'||!USERID.test(v.id)||typeof v.username!=='string'||!USERNAME.test(v.username))throw Error('mdpage_owner_unproven');
 const pages=await ownerPages({apiKey},deps,signal);
 return {authenticated:true,identitySource:'remote_me',userId:v.id,username:v.username,totalPages:pages.length};
}
async function ownerPages(secret:Pick<MdpageCredential,'apiKey'>,deps:Batch5Dependencies,signal:AbortSignal):Promise<Record<string,unknown>[]>{
 const r=await connectedRequest(MDPAGE_API+'/pages',{method:'GET',headers:auth(secret)},deps,signal,1_000_000),v=parseConnectedJson(r);
 if(r.status!==200||!Array.isArray(v?.pages)||v.pages.length>10||v.pages.some(p=>!object(p)||typeof p.id!=='string'||!IDENTIFIER.test(p.id)||typeof p.slug!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug)||!['public','private'].includes(String(p.visibility))))throw Error('mdpage_pages_unproven');
 return v.pages as Record<string,unknown>[];
}
export function mdpageDocument(context:ConnectedContext):Document {
 const a=account(context),draft=context.task.draft;if(!a||!draft||!context.task.topicUrl||context.site.category!=='software')throw Error('mdpage_document_invalid');
 const target=new URL(context.task.topicUrl),home=new URL(context.site.url);
 if(home.protocol!=='https:'||target.protocol!=='https:'||target.hostname!==home.hostname||target.username||target.password||target.hash)throw Error('mdpage_target_invalid');
 const title=draft.title.trim(),body=draft.body;if(!title||title.length>200||/[\r\n<>]/.test(title))throw Error('mdpage_title_invalid');
 // Reuse the existing strict Markdown/URL validator without publishing its HTML template.
 renderShareYourHtmlArticle({draft,targetUrl:target.href,language:context.site.language,slug:'mdpage-docs'});
 const content=body,$=load(marked.parse(content,{async:false}) as string),links=$('a[href]');
 if(links.length!==1||links.attr('href')!==target.href||Buffer.byteLength(content)>500_000)throw Error('mdpage_single_target_required');
 const username=new URL(a.publicationUrl!).hostname.slice(0,-8),slug='task-'+hashBatch5(context.task.id).slice(0,24);
 const request=JSON.stringify({markdown:content,title,slug,visibility:'public'});return {title,body,content,slug,username,target:target.href,request,requestHash:hashBatch5(request),
  sourceHash:hashBatch5(JSON.stringify({taskId:context.task.id,siteId:context.site.id,accountId:a.id,userId:a.username,username,title,body,target:target.href}))};
}
export function mdpagePublicUrl(value:unknown,username:string,slug:string):string|undefined {
 if(typeof value!=='string'||!USERNAME.test(username)||!/^task-[a-f0-9]{24}$/.test(slug))return;
 return value===`https://${username}.md.page/${slug}`?value:undefined;
}
function published(v:unknown,rawResponse:string,doc:Document):Published|undefined {
 if(!object(v)||typeof v.id!=='string'||!IDENTIFIER.test(v.id)||v.slug!==doc.slug||v.visibility!=='public'||['expires_at','expiresAt'].some(k=>k in v&&v[k]!==null)||'claimUrl'in v)return;
 const url=mdpagePublicUrl(v.url,doc.username,doc.slug);return url?{identifier:v.id,url,rawResponse}:undefined;
}
export function mdpageOriginalReceipt(value:Batch5OpaqueResponse|undefined,intent:Batch5Intent,doc:Document):Published|undefined {
 if(intent.channelId!==CHANNEL||!value||value.status!==201||value.responseUrl!==MDPAGE_API+'/pages'||!value.bodyComplete||!/^application\/json\b/i.test(value.contentType)
  ||JSON.stringify(value.intent)!==JSON.stringify(intent)||value.bodyBase64.length>100_000)return;
 try{const b=Buffer.from(value.bodyBase64,'base64');if(b.toString('base64')!==value.bodyBase64)return;const raw=new TextDecoder('utf-8',{fatal:true}).decode(b);return published(JSON.parse(raw),raw,doc)}catch{return}
}
export function mdpageRobotsAllows(text:string,path:string,agent:string):boolean {
 type Group={agents:string[];rules:{allow:boolean;path:string}[]};const groups:Group[]=[];let group:Group|undefined;
 for(const raw of text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/)){const match=/^([^:]+):\s*(.*)$/.exec(raw.replace(/#.*/,'').trim());if(!match)continue;
  const key=match[1].trim().toLowerCase(),value=match[2].trim();if(key==='user-agent'){if(!group||group.rules.length){group={agents:[],rules:[]};groups.push(group)}group.agents.push(value.toLowerCase())}
  else if((key==='allow'||key==='disallow')&&group&&value)group.rules.push({allow:key==='allow',path:value});
 }
 const exact=groups.filter(g=>g.agents.includes(agent.toLowerCase())),active=exact.length?exact:groups.filter(g=>g.agents.includes('*'));let best:{allow:boolean;length:number}|undefined;
 for(const rule of active.flatMap(g=>g.rules)){const end=rule.path.endsWith('$'),base=end?rule.path.slice(0,-1):rule.path,pattern=base.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*');
  if(!new RegExp(`^${pattern}${end?'$':''}`).test(path))continue;const length=Buffer.byteLength(base.replaceAll('*',''));if(!best||length>best.length||length===best.length&&rule.allow)best={allow:rule.allow,length};
 }return best?.allow??true;
}
async function publicAccepted(entry:Published,doc:Document,deps:Batch5Dependencies,signal:AbortSignal):Promise<{rel:string}|undefined>{
 const page=await connectedRequest(entry.url,{method:'GET',headers:{accept:'text/html'}},deps,signal,1_000_000);
 if(page.status!==200||!/^text\/html\b/i.test(page.contentType)||noindex(page.robotsHeader))return;
 const $=load(page.body);if($('iframe,frame,base').length||$('meta[http-equiv]').toArray().some(e=>($(e).attr('http-equiv')??'').toLowerCase()==='refresh')
  ||$('meta[name]').toArray().some(e=>/^(?:robots|googlebot|bingbot)$/i.test($(e).attr('name')??'')&&noindex($(e).attr('content')??''))
  ||$('link[rel~="canonical"]').toArray().some(e=>$(e).attr('href')!==entry.url))return;
 const links=$('a[href]').toArray().filter(e=>$(e).attr('href')===doc.target);if(links.length!==1)return;
 const hidden=(e:unknown)=>{const n=$(e as never);return n.attr('hidden')!==undefined||n.attr('inert')!==undefined||n.attr('aria-hidden')?.toLowerCase()==='true'};
 if($(links[0]).parents().addBack().toArray().some(hidden))return;
 const expected=load(marked.parse(doc.content,{async:false}) as string),pieces=expected('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre').toArray().map(e=>normalize(expected(e).text())).filter(Boolean);
 const visible=$('body').clone();visible.find('*').toArray().forEach(e=>{if(hidden(e)||['script','style','noscript','template','svg'].includes(e.tagName.toLowerCase()))$(e).remove()});
 const text=normalize(visible.text());if(!text.includes(normalize(doc.title))||!pieces.length||pieces.some(piece=>!text.includes(piece)))return;
 const robots=await connectedRequest(new URL('/robots.txt',entry.url).href,{method:'GET',headers:{accept:'text/plain'}},deps,signal,64_000);
 if(robots.status!==404&&(robots.status!==200||!/^text\/plain\b/i.test(robots.contentType)||!['*','googlebot','bingbot'].every(agent=>mdpageRobotsAllows(robots.body,new URL(entry.url).pathname,agent))))return;
 if(!deps.renderPage)return;const proof=await deps.renderPage(entry.url,doc.target,doc.title,doc.body,signal),rel=($(links[0]).attr('rel')??'').trim();
 return proof.found&&proof.indexable&&proof.rel===rel?{rel}:undefined;
}
async function readBack(entry:Published,doc:Document,intent:Batch5Intent,secret:MdpageCredential,deps:Batch5Dependencies,signal:AbortSignal):Promise<{rel:string}|undefined>{
 const owner=await connectedRequest(MDPAGE_API+'/me',{method:'GET',headers:auth(secret)},deps,signal,64_000),identity=parseConnectedJson(owner);
 if(owner.status!==200||identity?.id!==secret.userId||identity.username!==secret.username)return;
 const matches=(await ownerPages(secret,deps,signal)).filter(p=>p.id===entry.identifier),d=matches[0];if(matches.length!==1)return;
 const date=(v:unknown)=>typeof v==='string'?Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(v)?v.replace(' ','T')+'Z':v):NaN;
 const created=date(d.created_at),updated=date(d.updated_at),now=(deps.now?.()??new Date()).getTime();
 if(d.slug!==doc.slug||d.title!==doc.title||d.visibility!=='public'||d.revision_count!==1||typeof d.created_via!=='string'||!d.created_via.startsWith('api:')||['expires_at','expiresAt'].some(k=>k in d&&d[k]!==null)
  ||!Number.isFinite(created)||!Number.isFinite(updated)||created<Date.parse(intent.createdAt)-60_000||created>now+60_000||updated<created||updated>now+60_000)return;
 return publicAccepted(entry,doc,deps,signal);
}
export async function reconcileMdpageTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<{status:'found';publicUrl:string;rel:string;batch5:Batch5TaskState}|{status:'unknown'}>{
 try{const p=context.batch5Persistence,owner=account(context);if(!p||!owner)return {status:'unknown'};
  const secret=parseMdpageCredential(await context.secrets.get(`account:${owner.id}`));if(!secret||!account(context,secret))return {status:'unknown'};
  const intent=await p.loadIntent();if(!intent||intent.channelId!==CHANNEL||intent.siteId!==context.site.id)return {status:'unknown'};
  const doc=mdpageDocument(context);if(doc.sourceHash!==intent.sourceHash||doc.requestHash!==intent.requestHash)return {status:'unknown'};
  const entry=mdpageOriginalReceipt(await p.loadOpaqueResponse(),intent,doc);if(!entry)return {status:'unknown'};
  const receipt=await p.loadReceipt();if(receipt&&(JSON.stringify(receipt.intent)!==JSON.stringify(intent)||receipt.publicUrl!==entry.url||receipt.remoteId!==entry.identifier||receipt.rawResponse!==entry.rawResponse))return {status:'unknown'};
  const accepted=await readBack(entry,doc,intent,secret,connectedDependencies(context,overrides),context.signal);if(!accepted)return {status:'unknown'};
  const state=await persistBatch5Receipt(context,receipt??{version:1,intent,publicUrl:entry.url,remoteId:entry.identifier,rawResponse:entry.rawResponse},owner.id,entry.identifier);
  return {status:'found',publicUrl:entry.url,rel:accepted.rel,batch5:state};
 }catch{return {status:'unknown'}}
}
export async function runMdpageTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<ExecutionResult>{
 if(context.channel.id!==CHANNEL||context.task.channelId!==CHANNEL||context.task.siteId!==context.site.id||!context.channel.enabled||context.channel.automation!=='api')return {status:'needs_input',message:'MD.page 平台或任务账号无效'};
 const p=context.batch5Persistence,owner=account(context);if(!p?.reserveIntent||!p.markSending||!p.assertReadyToSubmit||!owner)return {status:'needs_input',message:'MD.page 缺少账号或持久化写前闸'};
 if(await p.loadIntent()||batch5State(context)||context.task.submittedAt||context.task.publicUrl){const found=await reconcileMdpageTask(context,overrides);return found.status==='found'?{status:'review',publicUrl:found.publicUrl,batch5:found.batch5,message:'MD.page 原文和公开页已只读核对'}:unknown('MD.page 原事务待核对，不重复 POST')}
 const secret=parseMdpageCredential(await context.secrets.get(`account:${owner.id}`));if(!secret||!account(context,secret))return {status:'needs_input',message:'MD.page 已绑定远端账号不符'};
 const deps=connectedDependencies(context,overrides);let doc:Document;
 const reviewValid=()=>context.task.articleReview?.bindingVersion===2&&context.task.articleReview.reviewContractVersion===5&&articleReviewStillValid(context.task,context.site,context.channel,context.settings,context.getAccount(),context.getArticlePublicationContext?.());
 try{if(!reviewValid())throw Error('review');doc=mdpageDocument(context);const probe=await probeMdpageConnection(secret.apiKey,deps,context.signal);if(probe.userId!==secret.userId||probe.username!==secret.username||probe.totalPages>=10)throw Error('owner_or_capacity');if((await ownerPages(secret,deps,context.signal)).some(p=>p.slug===doc.slug))throw Error('slug_occupied')}
 catch{return {status:'needs_input',message:'MD.page 当前 V5 原稿审核、认证读取或免费容量尚未满足'}}
 const intent:Batch5Intent={version:1,channelId:CHANNEL,operationId:randomUUID(),siteId:context.site.id,sourceHash:doc.sourceHash,requestHash:doc.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};
 try{await p.reserveIntent(intent);context.checkpoint({batch5:stateFromIntent(intent,'reserved',owner.id),checkpoint:'batch5_reserved'} as Partial<Task>);
  await p.assertReadyToSubmit(intent);await p.markSending(intent);context.checkpoint({batch5:stateFromIntent(intent,'submitting',owner.id),checkpoint:'batch5_submitting',submittedAt:intent.createdAt} as Partial<Task>);
  const current=parseMdpageCredential(await context.secrets.get(`account:${owner.id}`)),currentDoc=mdpageDocument(context);
  if(!current||JSON.stringify(current)!==JSON.stringify(secret)||!account(context,current)||!reviewValid()||currentDoc.requestHash!==intent.requestHash||currentDoc.sourceHash!==intent.sourceHash)throw Error('late_change');
  await p.assertReadyToSubmit(intent);
 }catch{return unknown('MD.page 写前权限或原稿变化；保留意图，后续只读对账')}
 try{const response=await connectedRequest(MDPAGE_API+'/pages',{method:'POST',headers:auth(secret),body:doc.request},deps,context.signal,75_000);await persistBatch5Response(p,intent,response);
  if(response.status===429)return {status:'failed',reasonCode:'platform_rate_limited',message:'MD.page 请求配额受限，原请求不重发'};
  if(response.status>=400&&response.status<500&&response.status!==408)return {status:'failed',reasonCode:'platform_rejected',message:'MD.page 拒绝发布，原请求不重发'};
  const entry=response.status===201?published(parseConnectedJson(response),response.body,doc):undefined;if(!entry)return unknown('MD.page 创建响应不明，不重发');
  const state=await persistBatch5Receipt(context,{version:1,intent,publicUrl:entry.url,remoteId:entry.identifier,rawResponse:entry.rawResponse},owner.id,entry.identifier);
  return {status:'review',publicUrl:entry.url,batch5:state,message:'MD.page 原收据已加密保存，待原公开正文及公开页核对'};
 }catch{return unknown('MD.page 发布响应不明，保留原事务，不重发')}
}
export async function verifyMdpagePublication(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<LinkResult>{
 const found=await reconcileMdpageTask(context,overrides);return found.status==='found'?{found:true,outcome:'found',url:found.publicUrl,rel:found.rel,indexable:true,reason:'原账户永久页面、原稿、原生目标链接和公开抓取条件已核对；不保证服务存续或搜索收录'}
  :{found:false,outcome:'unreachable',url:context.task.publicUrl??MDPAGE_ORIGIN,rel:'',reason:'MD.page 原事务、所属账号或匿名公开页尚未通过核对'};
}
