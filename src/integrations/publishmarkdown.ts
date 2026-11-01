import {randomUUID} from 'node:crypto';
import {load} from 'cheerio';
import {marked} from 'marked';
import {articleReviewStillValid} from '../main/article-review';
import type {Account,ExecutionResult,LinkResult,Task} from '../shared/types';
import type {Batch5Dependencies,Batch5Intent,Batch5OpaqueResponse,Batch5TaskState} from './batch5-contract';
import {batch5State,connectedDependencies,connectedRequest,hashBatch5,parseConnectedJson,persistBatch5Receipt,persistBatch5Response,stateFromIntent,type ConnectedContext} from './batch5-connected';
import {renderShareYourHtmlArticle} from './shareyourhtml-article';

export const PUBLISHMARKDOWN_ORIGIN='https://publishmarkdown.com';
export const PUBLISHMARKDOWN_API=PUBLISHMARKDOWN_ORIGIN+'/v1/api';
const CHANNEL='publishmarkdown',KEY=/^[A-Za-z0-9_-]{16,512}$/,IDENTIFIER=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const normalize=(v:string)=>v.replace(/\s+/g,' ').trim();
const noindex=(value:string)=>/(?:^|[:,\s])(?:noindex|none)(?=$|[,;\s])/i.test(value);
const unknown=(message:string):ExecutionResult=>({status:'review',reasonCode:'submission_unknown',message});
export interface PublishMarkdownCredential {version:1;apiKey:string}
interface Document {title:string;body:string;content:string;target:string;request:string;sourceHash:string;requestHash:string}
interface Published {identifier:string;url:string;rawResponse:string}

export function parsePublishMarkdownCredential(raw:string|undefined):PublishMarkdownCredential|undefined {
 try{const v:unknown=JSON.parse(raw??'null');if(object(v)&&v.version===1&&typeof v.apiKey==='string'&&KEY.test(v.apiKey))return {version:1,apiKey:v.apiKey}}catch{/* untrusted credential */}
}
/** The API has no documented /me route. This identifier is explicitly a local key fingerprint. */
export function publishMarkdownKeyIdentity(apiKey:string):string{if(!KEY.test(apiKey))throw Error('publishmarkdown_key_invalid');return `publishmarkdown-key:${hashBatch5(apiKey)}`}
const auth=(secret:PublishMarkdownCredential):HeadersInit=>({'api-key':secret.apiKey,'content-type':'application/json',accept:'application/json'});
function account(context:ConnectedContext,secret?:PublishMarkdownCredential):Account|undefined {
 const a=context.getAccount();return a?.channelId===CHANNEL&&a.id===context.task.accountId&&a.status==='registered'&&!a.retiredAt&&a.hasPassword&&a.credentialKind==='api_token'
  &&a.email===''&&/^publishmarkdown-key:[a-f0-9]{64}$/.test(a.username)&&(!secret||a.username===publishMarkdownKeyIdentity(secret.apiKey))?a:undefined;
}
export async function probePublishMarkdownConnection(secret:PublishMarkdownCredential,deps:Batch5Dependencies={},signal:AbortSignal=new AbortController().signal):Promise<{authenticated:true;identitySource:'local_key_fingerprint';username:string;totalDocuments:number}>{
 if(!parsePublishMarkdownCredential(JSON.stringify(secret)))throw Error('publishmarkdown_credential_invalid');
 const r=await connectedRequest(PUBLISHMARKDOWN_API+'/markdown?limit=50&offset=0',{method:'GET',headers:auth(secret)},deps,signal,1_000_000),v=parseConnectedJson(r);
 if(r.status!==200||v?.status!=='success'||!object(v.data)||!Array.isArray(v.data.items)||v.data.items.length>50||v.data.offset!==0
  ||!Number.isSafeInteger(v.data.limit)||Number(v.data.limit)<1||Number(v.data.limit)>50||!Number.isSafeInteger(v.data.totalData)||Number(v.data.totalData)<v.data.items.length
  ||v.data.items.some(item=>!object(item)||typeof item.identifier!=='string'||!IDENTIFIER.test(item.identifier)))throw Error('publishmarkdown_owner_list_unproven');
 return {authenticated:true,identitySource:'local_key_fingerprint',username:publishMarkdownKeyIdentity(secret.apiKey),totalDocuments:Number(v.data.totalData)};
}
export function publishMarkdownDocument(context:ConnectedContext):Document {
 const a=account(context),draft=context.task.draft;if(!a||!draft||!context.task.topicUrl||context.site.category!=='software')throw Error('publishmarkdown_document_invalid');
 const target=new URL(context.task.topicUrl),home=new URL(context.site.url);
 if(home.protocol!=='https:'||target.protocol!=='https:'||target.hostname!==home.hostname||target.username||target.password||target.hash)throw Error('publishmarkdown_target_invalid');
 const title=draft.title.trim(),body=draft.body;if(!title||title.length>200||/[\r\n<>]/.test(title))throw Error('publishmarkdown_title_invalid');
 // Reuse the existing strict Markdown/URL validator without publishing its HTML template.
 renderShareYourHtmlArticle({draft,targetUrl:target.href,language:context.site.language,slug:'publishmarkdown-docs'});
 const content=`# ${title.replace(/[\\`*_{}\[\]()#+.!|>-]/g,'\\$&')}\n\n${body}`,$=load(marked.parse(content,{async:false}) as string),links=$('a[href]');
 if(links.length!==1||links.attr('href')!==target.href||Buffer.byteLength(content)>120_000)throw Error('publishmarkdown_single_target_required');
 // No identifier, password or expiry: create a fresh account-owned page, then prove null expiry via GET.
 const request=JSON.stringify({content});return {title,body,content,target:target.href,request,requestHash:hashBatch5(request),
  sourceHash:hashBatch5(JSON.stringify({taskId:context.task.id,siteId:context.site.id,accountId:a.id,keyIdentity:a.username,title,body,target:target.href}))};
}
export function publishMarkdownPublicUrl(value:unknown,identifier:unknown):string|undefined {
 if(typeof value!=='string'||typeof identifier!=='string'||!IDENTIFIER.test(identifier))return;
 return value===`${PUBLISHMARKDOWN_ORIGIN}/${identifier}`?value:undefined;
}
function published(value:unknown,rawResponse:string):Published|undefined {
 if(!object(value)||value.status!=='success'||!object(value.data))return;const url=publishMarkdownPublicUrl(value.data.url,value.data.identifier);
 return url?{identifier:value.data.identifier as string,url,rawResponse}:undefined;
}
function opaqueEntry(value:Batch5OpaqueResponse|undefined,intent:Batch5Intent):Published|undefined {
 if(!value||value.status!==200||value.responseUrl!==PUBLISHMARKDOWN_API+'/markdown'||!value.bodyComplete||!/^application\/json\b/i.test(value.contentType)
  ||JSON.stringify(value.intent)!==JSON.stringify(intent)||value.bodyBase64.length>100_000)return;
 try{const b=Buffer.from(value.bodyBase64,'base64');if(b.toString('base64')!==value.bodyBase64)return;const raw=new TextDecoder('utf-8',{fatal:true}).decode(b);return published(JSON.parse(raw),raw)}catch{return}
}
export function publishMarkdownRobotsAllows(text:string,path:string,agent:string):boolean {
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
 const robots=await connectedRequest(PUBLISHMARKDOWN_ORIGIN+'/robots.txt',{method:'GET',headers:{accept:'text/plain'}},deps,signal,64_000);
 if(robots.status!==200||!/^text\/plain\b/i.test(robots.contentType)||!['*','googlebot','bingbot'].every(agent=>publishMarkdownRobotsAllows(robots.body,new URL(entry.url).pathname,agent)))return;
 if(!deps.renderPage)return;const proof=await deps.renderPage(entry.url,doc.target,doc.title,doc.body,signal),rel=($(links[0]).attr('rel')??'').trim();
 return proof.found&&proof.indexable&&proof.rel===rel?{rel}:undefined;
}
async function readBack(entry:Published,doc:Document,intent:Batch5Intent,secret:PublishMarkdownCredential,deps:Batch5Dependencies,signal:AbortSignal):Promise<{rel:string}|undefined>{
 const r=await connectedRequest(`${PUBLISHMARKDOWN_API}/markdown/${entry.identifier}`,{method:'GET',headers:auth(secret)},deps,signal,500_000),v=parseConnectedJson(r);
 if(r.status!==200||v?.status!=='success'||!object(v.data))return;const d=v.data,created=typeof d.createdAt==='string'?Date.parse(d.createdAt):NaN,updated=typeof d.updatedAt==='string'?Date.parse(d.updatedAt):NaN,now=(deps.now?.()??new Date()).getTime();
 // expiredAt is the documented field; absence, aliases and string dates do not establish no expiry.
 if(d.identifier!==entry.identifier||d.content!==doc.content||d.expiredAt!==null||d.is_password_protected!==false
  ||!Number.isFinite(created)||!Number.isFinite(updated)||created<Date.parse(intent.createdAt)-60_000||created>now+60_000||updated<created||updated>now+60_000)return;
 return publicAccepted(entry,doc,deps,signal);
}
export async function reconcilePublishMarkdownTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<{status:'found';publicUrl:string;rel:string;batch5:Batch5TaskState}|{status:'unknown'}>{
 try{const p=context.batch5Persistence,owner=account(context);if(!p||!owner)return {status:'unknown'};
  const secret=parsePublishMarkdownCredential(await context.secrets.get(`account:${owner.id}`));if(!secret||!account(context,secret))return {status:'unknown'};
  const intent=await p.loadIntent();if(!intent||intent.channelId!==CHANNEL||intent.siteId!==context.site.id)return {status:'unknown'};
  const doc=publishMarkdownDocument(context);if(doc.sourceHash!==intent.sourceHash||doc.requestHash!==intent.requestHash)return {status:'unknown'};
  const entry=opaqueEntry(await p.loadOpaqueResponse(),intent);if(!entry)return {status:'unknown'};
  const receipt=await p.loadReceipt();if(receipt&&(JSON.stringify(receipt.intent)!==JSON.stringify(intent)||receipt.publicUrl!==entry.url||receipt.remoteId!==entry.identifier||receipt.rawResponse!==entry.rawResponse))return {status:'unknown'};
  const accepted=await readBack(entry,doc,intent,secret,connectedDependencies(context,overrides),context.signal);if(!accepted)return {status:'unknown'};
  const state=await persistBatch5Receipt(context,receipt??{version:1,intent,publicUrl:entry.url,remoteId:entry.identifier,rawResponse:entry.rawResponse},owner.id,entry.identifier);
  return {status:'found',publicUrl:entry.url,rel:accepted.rel,batch5:state};
 }catch{return {status:'unknown'}}
}
export async function runPublishMarkdownTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<ExecutionResult>{
 if(context.channel.id!==CHANNEL||context.task.channelId!==CHANNEL||context.task.siteId!==context.site.id||!context.channel.enabled||context.channel.automation!=='api')return {status:'needs_input',message:'Publish Markdown 平台或任务账号无效'};
 const p=context.batch5Persistence,owner=account(context);if(!p?.reserveIntent||!p.markSending||!p.assertReadyToSubmit||!owner)return {status:'needs_input',message:'Publish Markdown 缺少账号或持久化写前闸'};
 if(await p.loadIntent()||batch5State(context)||context.task.submittedAt||context.task.publicUrl){const found=await reconcilePublishMarkdownTask(context,overrides);return found.status==='found'?{status:'review',publicUrl:found.publicUrl,batch5:found.batch5,message:'Publish Markdown 原文和公开页已只读核对'}:unknown('Publish Markdown 原事务待核对，不重复 POST')}
 const secret=parsePublishMarkdownCredential(await context.secrets.get(`account:${owner.id}`));if(!secret||!account(context,secret))return {status:'needs_input',message:'Publish Markdown 本地密钥指纹不符'};
 const deps=connectedDependencies(context,overrides);let doc:Document;
 const reviewValid=()=>context.task.articleReview?.bindingVersion===2&&context.task.articleReview.reviewContractVersion===5&&articleReviewStillValid(context.task,context.site,context.channel,context.settings,context.getAccount(),context.getArticlePublicationContext?.());
 try{if(!reviewValid())throw Error('review');doc=publishMarkdownDocument(context);const probe=await probePublishMarkdownConnection(secret,deps,context.signal);if(probe.totalDocuments>=100)throw Error('free_capacity')}
 catch{return {status:'needs_input',message:'Publish Markdown 当前 V5 原稿审核、认证读取或免费容量尚未满足'}}
 const intent:Batch5Intent={version:1,channelId:CHANNEL,operationId:randomUUID(),siteId:context.site.id,sourceHash:doc.sourceHash,requestHash:doc.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};
 try{await p.reserveIntent(intent);context.checkpoint({batch5:stateFromIntent(intent,'reserved',owner.id),checkpoint:'batch5_reserved'} as Partial<Task>);
  await p.assertReadyToSubmit(intent);await p.markSending(intent);context.checkpoint({batch5:stateFromIntent(intent,'submitting',owner.id),checkpoint:'batch5_submitting',submittedAt:intent.createdAt} as Partial<Task>);
  const current=parsePublishMarkdownCredential(await context.secrets.get(`account:${owner.id}`)),currentDoc=publishMarkdownDocument(context);
  if(!current||JSON.stringify(current)!==JSON.stringify(secret)||!account(context,current)||!reviewValid()||currentDoc.requestHash!==intent.requestHash||currentDoc.sourceHash!==intent.sourceHash)throw Error('late_change');
  await p.assertReadyToSubmit(intent);
 }catch{return unknown('Publish Markdown 写前权限或原稿变化；保留意图，后续只读对账')}
 try{const response=await connectedRequest(PUBLISHMARKDOWN_API+'/markdown',{method:'POST',headers:auth(secret),body:doc.request},deps,context.signal,75_000);await persistBatch5Response(p,intent,response);
  if(response.status===429)return {status:'failed',reasonCode:'platform_rate_limited',message:'Publish Markdown 请求配额受限，原请求不重发'};
  if(response.status>=400&&response.status<500&&response.status!==408)return {status:'failed',reasonCode:'platform_rejected',message:'Publish Markdown 拒绝发布，原请求不重发'};
  const entry=response.status===200?published(parseConnectedJson(response),response.body):undefined;if(!entry)return unknown('Publish Markdown 创建响应不明，不重发');
  const state=await persistBatch5Receipt(context,{version:1,intent,publicUrl:entry.url,remoteId:entry.identifier,rawResponse:entry.rawResponse},owner.id,entry.identifier);
  return {status:'review',publicUrl:entry.url,batch5:state,message:'Publish Markdown 原收据已加密保存，待无到期原文及公开页核对'};
 }catch{return unknown('Publish Markdown 发布响应不明，保留原事务，不重发')}
}
export async function verifyPublishMarkdownPublication(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<LinkResult>{
 const found=await reconcilePublishMarkdownTask(context,overrides);return found.status==='found'?{found:true,outcome:'found',url:found.publicUrl,rel:found.rel,indexable:true,reason:'原 Markdown、无到期无密码、原生目标链接和公开抓取条件已核对；不保证服务存续或搜索收录'}
  :{found:false,outcome:'unreachable',url:context.task.publicUrl??PUBLISHMARKDOWN_ORIGIN,rel:'',reason:'Publish Markdown 原事务、到期状态或匿名公开页尚未通过核对'};
}
