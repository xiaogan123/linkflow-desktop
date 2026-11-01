import {randomUUID} from 'node:crypto';
import {load} from 'cheerio';
import {marked} from 'marked';
import {articleReviewStillValid} from '../main/article-review';
import type {Account,ExecutionResult,LinkResult,Task} from '../shared/types';
import type {Batch5Dependencies,Batch5Intent,Batch5OpaqueResponse,Batch5Receipt,Batch5TaskState} from './batch5-contract';
import {batch5State,connectedDependencies,connectedRequest,hashBatch5,parseConnectedJson,persistBatch5Receipt,persistBatch5Response,stateFromIntent,type ConnectedContext} from './batch5-connected';

export const MARKED_SHARE_API='https://share.markedapp.com/api/v1';
export const MARKED_SHARE_ORIGIN='https://markedb.in';
const CHANNEL='marked-share',KEY=/^[A-Za-z0-9_-]{16,512}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const email=(v:unknown):v is string=>typeof v==='string'&&/^[^\s@<>]{1,128}@[^\s@<>]{1,190}$/.test(v)&&v.length<=254;
const normalize=(s:string)=>s.replace(/\s+/g,' ').trim();
const noindex=(value:string)=>/(?:^|[:,\s])(?:noindex|none)(?=$|[,;\s])/i.test(value);
const unknown=(message:string):ExecutionResult=>({status:'review',reasonCode:'submission_unknown',message});
export interface MarkedShareCredential {version:1;apiToken:string;deviceKey:string;email:string}
interface Document {title:string;body:string;target:string;request:string;sourceHash:string;requestHash:string}
interface Published {id:string;privateId:string;url:string;contentHash:string;createdAt:string;rawResponse:string}

export function parseMarkedShareCredential(raw:string|undefined):MarkedShareCredential|undefined {
  try{const v:unknown=JSON.parse(raw??'null');if(object(v)&&v.version===1&&email(v.email)&&typeof v.apiToken==='string'&&KEY.test(v.apiToken)&&typeof v.deviceKey==='string'&&KEY.test(v.deviceKey))return {version:1,apiToken:v.apiToken,deviceKey:v.deviceKey,email:v.email};}catch{/* untrusted stored credential */}
}
/** This is a local token identity, never a claimed remote /me user ID or verified email. */
export function markedShareAccountUsername(secret:MarkedShareCredential):string{return `marked-share:${hashBatch5(secret.apiToken).slice(0,24)}`}
const auth=(secret:MarkedShareCredential,write=false):Record<string,string>=>({authorization:`Bearer ${secret.apiToken}`,accept:'application/json',...(write?{'X-Device-Key':secret.deviceKey}:{})});
function account(context:ConnectedContext,secret?:MarkedShareCredential):Account|undefined {
  const a=context.getAccount();return a?.channelId===CHANNEL&&a.id===context.task.accountId&&a.status==='registered'&&!a.retiredAt&&a.hasPassword&&a.credentialKind==='api_token'
    &&email(a.email)&&(!secret||a.email===secret.email&&a.username===markedShareAccountUsername(secret))?a:undefined;
}
export async function probeMarkedShareConnection(secret:MarkedShareCredential,deps:Batch5Dependencies={},signal:AbortSignal=new AbortController().signal):Promise<{authenticated:true;email:string;identitySource:'local_credential';username:string;visibleDocuments:number}>{
  if(!parseMarkedShareCredential(JSON.stringify(secret)))throw Error('marked_share_credential_invalid');
  const r=await connectedRequest(`${MARKED_SHARE_API}/documents?limit=25&page=1`,{method:'GET',headers:auth(secret)},deps,signal,1_000_000);
  if(r.status!==200||!/^application\/json\b/i.test(r.contentType))throw Error('marked_share_auth_unproven');
  let list:unknown;try{list=JSON.parse(r.body)}catch{throw Error('marked_share_list_invalid')}
  if(!Array.isArray(list)||list.length>25||list.some(v=>!object(v)||typeof v.id!=='string'||typeof v.content_hash!=='string'))throw Error('marked_share_list_invalid');
  return {authenticated:true,email:secret.email,identitySource:'local_credential',username:markedShareAccountUsername(secret),visibleDocuments:list.length};
}
export function markedShareDocument(context:ConnectedContext):Document {
  const draft=context.task.draft,topic=context.task.topicUrl;if(!draft||!topic||context.site.category!=='software')throw Error('marked_share_software_document_required');
  const target=new URL(topic),home=new URL(context.site.url);
  if(target.protocol!=='https:'||home.protocol!=='https:'||target.hostname!==home.hostname||target.username||target.password||target.hash||target.href.length>2048)throw Error('marked_share_target_invalid');
  const title=draft.title.trim(),body=draft.body;
  if(!title||title.length>200||!body.trim()||Buffer.byteLength(body)>200_000)throw Error('marked_share_document_invalid');
  const $=load(marked.parse(body,{async:false}) as string),links=$('a[href]');
  if(links.length!==1||links.attr('href')!==target.href||$('script,iframe,frame,base,form,input,meta,link,style').length)throw Error('marked_share_native_target_required');
  const request=JSON.stringify({document:{title,body_markdown:body,visibility:'public',allow_remix:false}});
  return {title,body,target:target.href,request,sourceHash:hashBatch5(JSON.stringify({taskId:context.task.id,accountId:context.task.accountId,title,body,target:target.href})),requestHash:hashBatch5(request)};
}
export function markedSharePublicUrl(value:unknown):string|undefined {
  if(typeof value!=='string')return;try{const u=new URL(value);if(u.protocol==='https:'&&u.origin===MARKED_SHARE_ORIGIN&&!u.username&&!u.password&&!u.search&&!u.hash&&/^\/[A-Za-z0-9_-]{1,128}$/.test(u.pathname))return u.href}catch{/* malformed receipt */}
}
/** Same public code on the provider's observed official host; never a private ID or session bridge. */
export function markedShareNativeUrl(value:unknown):string|undefined{
  const original=markedSharePublicUrl(value);return original?'https://share.markedapp.com'+new URL(original).pathname:undefined;
}
function published(v:unknown,rawResponse:string):Published|undefined {
  if(!object(v)||typeof v.id!=='string'||!/^[A-Za-z0-9_-]{4,128}$/.test(v.id)||typeof v.private_id!=='string'||!UUID.test(v.private_id)
    ||typeof v.content_hash!=='string'||!/^[a-f0-9]{64}$/.test(v.content_hash)||v.visibility!=='public'||('allow_remix'in v&&v.allow_remix!==false)
    ||v.link_password_enabled!==false||v.expires_at!==null||typeof v.created_at!=='string'||!Number.isFinite(Date.parse(v.created_at)))return;
  const url=markedSharePublicUrl(v.url);return url?{id:v.id,privateId:v.private_id,url,contentHash:v.content_hash,createdAt:v.created_at,rawResponse}:undefined;
}
function opaqueEntry(value:Batch5OpaqueResponse|undefined,intent:Batch5Intent):Published|undefined {
  if(!value||value.status!==201||value.responseUrl!==`${MARKED_SHARE_API}/documents`||!value.bodyComplete||!/^application\/json\b/i.test(value.contentType)
    ||JSON.stringify(value.intent)!==JSON.stringify(intent)||value.bodyBase64.length>1_000_000)return;
  try{const b=Buffer.from(value.bodyBase64,'base64');if(b.toString('base64')!==value.bodyBase64)return;const raw=new TextDecoder('utf-8',{fatal:true}).decode(b);return published(JSON.parse(raw),raw)}catch{return}
}
/** Applies each crawler's own group: a training-bot ban is not a Google/Bing search ban. */
export function markedShareRobotsAllows(text:string,path:string,agent:string):boolean {
  type Group={agents:string[];rules:{allow:boolean;path:string}[]};const groups:Group[]=[];let current:Group|undefined;
  for(const raw of text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/)){const match=/^([^:]+):\s*(.*)$/.exec(raw.replace(/#.*/,'').trim());if(!match)continue;
    const key=match[1].trim().toLowerCase(),value=match[2].trim();
    if(key==='user-agent'){if(!current||current.rules.length){current={agents:[],rules:[]};groups.push(current)}current.agents.push(value.toLowerCase())}
    else if((key==='allow'||key==='disallow')&&current&&value)current.rules.push({allow:key==='allow',path:value});
  }
  const exact=groups.filter(g=>g.agents.includes(agent.toLowerCase())),active=exact.length?exact:groups.filter(g=>g.agents.includes('*'));let best:{allow:boolean;length:number}|undefined;
  for(const r of active.flatMap(g=>g.rules)){const end=r.path.endsWith('$'),base=end?r.path.slice(0,-1):r.path,pattern=base.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*');
    if(!new RegExp(`^${pattern}${end?'$':''}`).test(path))continue;const length=Buffer.byteLength(base.replaceAll('*',''));if(!best||length>best.length||length===best.length&&r.allow)best={allow:r.allow,length};
  }return best?.allow??true;
}
async function publicAccepted(entry:Published,doc:Document,deps:Batch5Dependencies,signal:AbortSignal):Promise<{rel:string}|undefined>{
  const nativeUrl=markedShareNativeUrl(entry.url);if(!nativeUrl)return;
  const page=await connectedRequest(nativeUrl,{method:'GET',headers:{accept:'text/html'}},deps,signal,750_000);
  if(page.status!==200||!/^text\/html\b/i.test(page.contentType)||noindex(page.robotsHeader))return;
  const $=load(page.body);
  if($('iframe,frame,base').length||$('meta[http-equiv]').toArray().some(e=>($(e).attr('http-equiv')??'').toLowerCase()==='refresh')
    ||$('meta[name]').toArray().some(e=>/^(?:robots|googlebot|bingbot)$/i.test($(e).attr('name')??'')&&noindex($(e).attr('content')??''))
    ||$('link[rel~="canonical"]').toArray().some(e=>$(e).attr('href')!==nativeUrl))return;
  const targets=$('a[href]').toArray().filter(e=>$(e).attr('href')===doc.target);if(targets.length!==1)return;
  const hidden=(e:unknown)=>{const n=$(e as never);return n.attr('hidden')!==undefined||n.attr('inert')!==undefined||n.attr('aria-hidden')?.toLowerCase()==='true'};
  if($(targets[0]).parents().addBack().toArray().some(hidden))return;
  const expected=load(marked.parse(doc.body,{async:false}) as string),pieces=expected('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre').toArray().map(e=>normalize(expected(e).text())).filter(Boolean);
  const visible=$('body').clone();visible.find('*').toArray().forEach(e=>{if(hidden(e)||['script','style','noscript','template','svg'].includes(e.tagName.toLowerCase()))$(e).remove()});
  const text=normalize(visible.text());if(!text.includes(normalize(doc.title))||!pieces.length||pieces.some(piece=>!text.includes(piece)))return;
  for(const origin of [MARKED_SHARE_ORIGIN,'https://share.markedapp.com']){
    const robots=await connectedRequest(`${origin}/robots.txt`,{method:'GET',headers:{accept:'text/plain'}},deps,signal,64_000);
    if(robots.status!==200||!/^text\/plain\b/i.test(robots.contentType)||!['*','googlebot','bingbot'].every(agent=>markedShareRobotsAllows(robots.body,new URL(entry.url).pathname,agent)))return;
  }
  // The receipt short URL stays unchanged; browser verification uses its observed same-code official alias.
  if(!deps.renderPage)return;const proof=await deps.renderPage(nativeUrl,doc.target,doc.title,doc.body,signal);
  const rel=($(targets[0]).attr('rel')??'').trim();return proof.found&&proof.indexable&&proof.rel===rel?{rel}:undefined;
}
async function readBack(entry:Published,doc:Document,secret:MarkedShareCredential,deps:Batch5Dependencies,signal:AbortSignal):Promise<{rel:string}|undefined>{
  const r=await connectedRequest(`${MARKED_SHARE_API}/documents/${entry.privateId}`,{method:'GET',headers:auth(secret)},deps,signal,750_000),v=parseConnectedJson(r),fresh=published(v,r.body);
  if(r.status!==200||!v||v.allow_remix!==false||!fresh||fresh.id!==entry.id||fresh.privateId!==entry.privateId||fresh.url!==entry.url||fresh.contentHash!==entry.contentHash||fresh.createdAt!==entry.createdAt
    ||v.title!==doc.title||v.body_markdown!==doc.body)return;
  return publicAccepted(entry,doc,deps,signal);
}
export async function reconcileMarkedShareTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<{status:'found';publicUrl:string;rel:string;batch5:Batch5TaskState}|{status:'unknown'}>{
  try{const p=context.batch5Persistence,owner=account(context);if(!p||!owner)return {status:'unknown'};
    const secret=parseMarkedShareCredential(await context.secrets.get(`account:${owner.id}`));if(!secret||!account(context,secret))return {status:'unknown'};
    const intent=await p.loadIntent();if(!intent||intent.channelId!==CHANNEL||intent.siteId!==context.site.id)return {status:'unknown'};
    const doc=markedShareDocument(context);if(doc.sourceHash!==intent.sourceHash||doc.requestHash!==intent.requestHash)return {status:'unknown'};
    const entry=opaqueEntry(await p.loadOpaqueResponse(),intent);if(!entry)return {status:'unknown'};
    const receipt=await p.loadReceipt();if(receipt&&(JSON.stringify(receipt.intent)!==JSON.stringify(intent)||receipt.publicUrl!==entry.url||receipt.remoteId!==entry.id||receipt.rawResponse!==entry.rawResponse))return {status:'unknown'};
    const accepted=await readBack(entry,doc,secret,connectedDependencies(context,overrides),context.signal);if(!accepted)return {status:'unknown'};
    const state=await persistBatch5Receipt(context,receipt??{version:1,intent,publicUrl:entry.url,remoteId:entry.id,rawResponse:entry.rawResponse},owner.id,entry.id);
    return {status:'found',publicUrl:entry.url,rel:accepted.rel,batch5:state};
  }catch{return {status:'unknown'}}
}
export async function runMarkedShareTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<ExecutionResult>{
  if(context.channel.id!==CHANNEL||context.task.channelId!==CHANNEL||context.task.siteId!==context.site.id||!context.channel.enabled||context.channel.automation!=='api')return {status:'needs_input',message:'Marked Share 平台或任务账号无效'};
  const p=context.batch5Persistence,owner=account(context);if(!p?.reserveIntent||!p.markSending||!p.assertReadyToSubmit||!owner)return {status:'needs_input',message:'Marked Share 缺少账号或持久化写前闸'};
  if(await p.loadIntent()||batch5State(context)||context.task.submittedAt||context.task.publicUrl){const found=await reconcileMarkedShareTask(context,overrides);return found.status==='found'?{status:'review',publicUrl:found.publicUrl,batch5:found.batch5,message:'Marked Share 原文和公开页已只读核对'}:unknown('Marked Share 原事务待核对，不重复 POST')}
  const secret=parseMarkedShareCredential(await context.secrets.get(`account:${owner.id}`));if(!secret||!account(context,secret))return {status:'needs_input',message:'Marked Share 本地令牌指纹与邮箱绑定不符'};
  const deps=connectedDependencies(context,overrides);let doc:Document;
  const reviewValid=()=>context.task.articleReview?.bindingVersion===2&&context.task.articleReview.reviewContractVersion===5&&articleReviewStillValid(context.task,context.site,context.channel,context.settings,context.getAccount(),context.getArticlePublicationContext?.());
  try{if(!reviewValid())throw Error('review');doc=markedShareDocument(context);const probe=await probeMarkedShareConnection(secret,deps,context.signal);if(probe.visibleDocuments>=25)throw Error('free_capacity');}
  catch{return {status:'needs_input',message:'Marked Share 当前 V5 原稿审核、认证读取或免费容量尚未满足'}}
  const intent:Batch5Intent={version:1,channelId:CHANNEL,operationId:randomUUID(),siteId:context.site.id,sourceHash:doc.sourceHash,requestHash:doc.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};
  try{await p.reserveIntent(intent);context.checkpoint({batch5:stateFromIntent(intent,'reserved',owner.id),checkpoint:'batch5_reserved'} as Partial<Task>);
    await p.assertReadyToSubmit(intent);await p.markSending(intent);context.checkpoint({batch5:stateFromIntent(intent,'submitting',owner.id),checkpoint:'batch5_submitting',submittedAt:intent.createdAt} as Partial<Task>);
    const current=parseMarkedShareCredential(await context.secrets.get(`account:${owner.id}`));
    const currentDoc=markedShareDocument(context);
    if(!current||JSON.stringify(current)!==JSON.stringify(secret)||!account(context,current)||!reviewValid()||currentDoc.requestHash!==intent.requestHash||currentDoc.sourceHash!==intent.sourceHash)throw Error('late_change');
    await p.assertReadyToSubmit(intent);
  }catch{return unknown('Marked Share 写前权限或原稿变化；保留意图，后续只读对账')}
  try{const response=await connectedRequest(`${MARKED_SHARE_API}/documents`,{method:'POST',headers:{...auth(secret,true),'content-type':'application/json'},body:doc.request},deps,context.signal,750_000);
    await persistBatch5Response(p,intent,response);
    if(response.status===429)return {status:'failed',reasonCode:'platform_rate_limited',message:'Marked Share 发布频率受限，原请求不重发'};
    if(response.status>=400&&response.status<500&&response.status!==408)return {status:'failed',reasonCode:'platform_rejected',message:'Marked Share 拒绝发布，原请求不重发'};
    const entry=response.status===201?published(parseConnectedJson(response),response.body):undefined;if(!entry)return unknown('Marked Share 创建响应未证明公开且无到期，不重发');
    const state=await persistBatch5Receipt(context,{version:1,intent,publicUrl:entry.url,remoteId:entry.id,rawResponse:entry.rawResponse},owner.id,entry.id);
    return {status:'review',publicUrl:entry.url,batch5:state,message:'Marked Share 创建收据已加密保存，待原文和匿名公开页核对'};
  }catch{return unknown('Marked Share 发布响应不明，保留原事务，不重发')}
}
export async function verifyMarkedSharePublication(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<LinkResult>{
  const found=await reconcileMarkedShareTask(context,overrides);return found.status==='found'?{found:true,outcome:'found',url:found.publicUrl,rel:found.rel,indexable:true,reason:'原始 Markdown、原生目标链接和公开抓取条件已核对；不代表搜索收录'}
    :{found:false,outcome:'unreachable',url:context.task.publicUrl??MARKED_SHARE_ORIGIN,rel:'',reason:'Marked Share 原事务或匿名公开页尚未通过核对'};
}
export const markedShareTesting={published,opaqueEntry,publicAccepted};
