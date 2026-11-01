import {randomUUID} from 'node:crypto';
import {load} from 'cheerio';
import {marked} from 'marked';
import {articleReviewStillValid} from '../main/article-review';
import type {Account,ExecutionResult,LinkResult,Task} from '../shared/types';
import type {Batch5Dependencies,Batch5Intent,Batch5OpaqueResponse,Batch5Receipt,Batch5TaskState} from './batch5-contract';
import {batch5State,connectedDependencies,connectedRequest,hashBatch5,noIndex,parseConnectedJson,
  persistBatch5Receipt,persistBatch5Response,stateFromIntent,type ConnectedContext} from './batch5-connected';

const ORIGIN='https://leafmill.net';
const CHANNEL='leafmill';
const EMAIL=/^[^\s@<>]{1,128}@[^\s@<>]{1,190}$/;
const KEY=/^[^\s\u0000-\u001f\u007f]{8,512}$/;
const SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface LeafmillCredential {version:1;email:string;apiKey:string}
interface Article {title:string;body:string;description:string;target:string;sourceHash:string;requestHash:string}
interface Published {slug:string;url:string;rawResponse:string}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const email=(value:unknown):value is string=>typeof value==='string'&&EMAIL.test(value)&&value.length<=254&&value===value.trim();
const key=(value:unknown):value is string=>typeof value==='string'&&KEY.test(value);
const normalized=(value:string)=>value.replace(/\s+/g,' ').trim();
const auth=(apiKey:string):HeadersInit=>({authorization:`Bearer ${apiKey}`,accept:'application/json'});
const unknown=(message:string):ExecutionResult=>({status:'review',reasonCode:'submission_unknown',message});

function credential(raw:string|undefined):LeafmillCredential|undefined{
  try{const value:unknown=JSON.parse(raw??'null');if(!record(value)||value.version!==1||!email(value.email)||!key(value.apiKey))return;
    return {version:1,email:value.email,apiKey:value.apiKey};}catch{return}
}
function account(context:ConnectedContext):Account|undefined{
  const value=context.getAccount();
  return value?.channelId===CHANNEL&&value.id===context.task.accountId&&value.status==='registered'&&value.hasPassword
    &&value.credentialKind==='api_token'&&email(value.email)&&value.username===value.email?value:undefined;
}
function publicationUrl(value:unknown,slug:unknown):string|undefined{
  if(typeof slug!=='string'||!SLUG.test(slug)||typeof value!=='string')return;
  try{const url=new URL(value);return url.protocol==='https:'&&url.origin===ORIGIN&&url.pathname===`/${slug}`
    &&!url.search&&!url.hash&&!url.username&&!url.password?url.href:undefined}catch{return}
}
function published(value:Record<string,unknown>|undefined):Published|undefined{
  if(!value||value.expiresAt!==null)return;
  const url=publicationUrl(value.url,value.slug);return url?{slug:value.slug as string,url,rawResponse:JSON.stringify(value)}:undefined;
}

/** The owner reads the one-time email code; this helper never reads an inbox. */
export async function requestLeafmillSignInCode(address:string,deps:Batch5Dependencies={},signal:AbortSignal=new AbortController().signal):Promise<void>{
  if(!email(address))throw Error('leafmill_email_invalid');
  const response=await connectedRequest(`${ORIGIN}/api/auth/request-code`,{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify({email:address})},deps,signal,16_384);
  const value=parseConnectedJson(response);if(response.status!==200||value?.success!==true||value.requiresCodeEntry!==true)throw Error('leafmill_code_request_unconfirmed');
}
export async function verifyLeafmillSignInCode(address:string,code:string,deps:Batch5Dependencies={},signal:AbortSignal=new AbortController().signal):Promise<LeafmillCredential>{
  if(!email(address)||! /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(code))throw Error('leafmill_code_invalid');
  const response=await connectedRequest(`${ORIGIN}/api/auth/verify-code`,{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify({email:address,code})},deps,signal,16_384);
  const value=parseConnectedJson(response);if(response.status!==200||value?.success!==true||value.email!==address||!key(value.apiKey))throw Error('leafmill_code_verification_unconfirmed');
  return {version:1,email:address,apiKey:value.apiKey};
}
export async function probeLeafmillConnection(secret:LeafmillCredential,deps:Batch5Dependencies={},signal:AbortSignal=new AbortController().signal):Promise<{email:string}>{
  if(!email(secret.email)||!key(secret.apiKey))throw Error('leafmill_credential_invalid');
  const remote=await probeLeafmillApiKey(secret.apiKey,deps,signal);
  if(remote.email!==secret.email)throw Error('leafmill_account_mismatch');
  return remote;
}
/** Read-only token probe for the generic connection screen; the email comes from the service. */
export async function probeLeafmillApiKey(apiKey:string,deps:Batch5Dependencies={},signal:AbortSignal=new AbortController().signal):Promise<{email:string}>{
  if(!key(apiKey))throw Error('leafmill_credential_invalid');
  const response=await connectedRequest(`${ORIGIN}/api/v1/me`,{method:'GET',headers:auth(apiKey)},deps,signal,16_384);
  const value=parseConnectedJson(response);if(response.status!==200||!email(value?.email))throw Error('leafmill_account_unverified');
  return {email:value.email};
}

function article(context:ConnectedContext):Article{
  const draft=context.task.draft,targetRaw=context.task.topicUrl;
  if(!draft||!targetRaw||!['software','developer','ai'].includes(context.site.category))throw Error('leafmill_document_invalid');
  const target=new URL(targetRaw),source=new URL(context.site.url);
  if(target.protocol!=='https:'||source.protocol!=='https:'||target.hostname!==source.hostname||target.username||target.password
    ||target.href.length>2048)throw Error('leafmill_target_invalid');
  const title=draft.title.trim(),body=draft.body,description=draft.description.trim();
  if(!title||title.length>200||!body||Buffer.byteLength(body,'utf8')>500_000||description.length>500)throw Error('leafmill_document_invalid');
  const rendered=load(marked.parse(body,{async:false}) as string);
  const links=rendered('a[href]').toArray();
  if(links.length!==1||rendered(links[0]).attr('href')!==target.href)throw Error('leafmill_target_count');
  const request=JSON.stringify({title,body,description});
  return {title,body,description,target:target.href,sourceHash:hashBatch5(JSON.stringify({title,body,description,target:target.href})),requestHash:hashBatch5(request)};
}
function exactArticle(context:ConnectedContext,intent:Batch5Intent):Article|undefined{
  if(intent.channelId!==CHANNEL||intent.siteId!==context.site.id)return;
  try{const value=article(context);return value.sourceHash===intent.sourceHash&&value.requestHash===intent.requestHash?value:undefined}catch{return}
}
function fromOpaque(value:Batch5OpaqueResponse|undefined,intent:Batch5Intent):Published|undefined{
  if(!value||value.status!==201||value.responseUrl!==`${ORIGIN}/api/v1/publish`||!value.bodyComplete
    ||!/^application\/json\b/i.test(value.contentType)||JSON.stringify(value.intent)!==JSON.stringify(intent)
    ||typeof value.bodyBase64!=='string'||value.bodyBase64.length>65_536||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bodyBase64))return;
  const bytes=Buffer.from(value.bodyBase64,'base64');if(bytes.toString('base64')!==value.bodyBase64)return;
  try{const parsed:unknown=JSON.parse(bytes.toString('utf8'));const item=published(record(parsed)?parsed:undefined);
    return item?{...item,rawResponse:bytes.toString('utf8')}:undefined}catch{return}
}
/** Only a credential-free rendered proof can accept pages whose CSS/JS may change visibility. */
async function publicAccepted(url:string,doc:Article,deps:Batch5Dependencies,signal:AbortSignal):Promise<{rel:string}|undefined>{
  const page=await connectedRequest(url,{method:'GET',headers:{accept:'text/html'}},deps,signal,256_000);
  if(page.status!==200||!/^text\/html\b/i.test(page.contentType)||noIndex(page)
    ||/(?:^|[,\s])(?:[a-z0-9_-]+\s*:\s*)?(?:none|noindex)(?=$|[,\s])/i.test(page.robotsHeader))return;
  const $=load(page.body);
  if($('meta[name="robots"],meta[name="googlebot"],meta[name="bingbot"]').toArray().some(e=>/\b(?:none|noindex)\b/i.test($(e).attr('content')??''))
    ||$('meta[http-equiv]').toArray().some(e=>($(e).attr('http-equiv')??'').toLowerCase()==='refresh'))return;
  const canonical=$('link[rel="canonical"]').attr('href');if(canonical&&canonical!==url)return;
  const robots=await connectedRequest(`${ORIGIN}/robots.txt`,{method:'GET'},deps,signal,16_384);
  if(robots.status!==200||noIndex(robots)||robots.body.split(/\r?\n/).some(line=>/^\s*Disallow\s*:\s*\/?\S+/i.test(line)))return;
  const dynamic=$('style,link[rel~="stylesheet"],[style]').length>0
    ||$('script').toArray().some(e=>($(e).attr('type')??'').toLowerCase()!=='application/ld+json');
  if(dynamic){if(!deps.renderPage)return;
    const rendered=await deps.renderPage(url,doc.target,doc.title,doc.body,signal);
    return rendered.found&&rendered.indexable&&typeof rendered.rel==='string'?{rel:rendered.rel}:undefined;
  }
  const hidden=(e:unknown)=>{const node=$(e as never);const style=node.attr('style')??'';
    return node.attr('hidden')!==undefined||node.attr('inert')!==undefined||node.attr('aria-hidden')?.toLowerCase()==='true'
      ||/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?)(?:\s*!important)?\s*(?:;|$)/i.test(style)};
  const targets=$('a[href]').toArray().filter(e=>$(e).attr('href')===doc.target);
  if(targets.length!==1||$(targets[0]).parents().addBack().toArray().some(hidden))return;
  const rel=($(targets[0]).attr('rel')??'').trim();
  const expected=load(marked.parse(doc.body,{async:false}) as string);
  const pieces=expected('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre').toArray().map(e=>normalized(expected(e).text())).filter(Boolean);
  const visible=$('body').clone();if(!visible.length||visible.toArray().some(hidden))return;
  visible.find('*').toArray().forEach(e=>{if(hidden(e)||['script','style','noscript','template','svg'].includes(e.tagName.toLowerCase()))$(e).remove()});
  const publicText=normalized(visible.text());
  if(!publicText.includes(normalized(doc.title))||pieces.length===0||pieces.some(piece=>!publicText.includes(piece)))return;
  return {rel};
}
async function readBack(context:ConnectedContext,doc:Article,entry:Published,deps:Batch5Dependencies):Promise<{rel:string}|undefined>{
  const response=await connectedRequest(`${ORIGIN}/api/v1/articles/${entry.slug}`,{method:'GET',headers:{accept:'application/json'}},deps,context.signal,32_768);
  const item=parseConnectedJson(response);
  return response.status===200&&item?.slug===entry.slug&&item?.url===entry.url&&item?.title===doc.title&&item?.expiresAt===null
    ?await publicAccepted(entry.url,doc,deps,context.signal):undefined;
}
export async function reconcileLeafmillTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<{status:'found';publicUrl:string;rel:string;batch5:Batch5TaskState}|{status:'unknown'}>{
  const persistence=context.batch5Persistence,owner=account(context);if(!persistence||!owner)return {status:'unknown'};
  const intent=await persistence.loadIntent();if(!intent)return {status:'unknown'};
  const doc=exactArticle(context,intent),secret=credential(await context.secrets.get(`account:${owner.id}`));
  if(!doc||!secret||secret.email!==owner.email)return {status:'unknown'};
  try{
    const deps=connectedDependencies(context,overrides);await probeLeafmillConnection(secret,deps,context.signal);
    const receipt=await persistence.loadReceipt();if(receipt&&JSON.stringify(receipt.intent)!==JSON.stringify(intent))return {status:'unknown'};
    const opaque=receipt?undefined:fromOpaque(await persistence.loadOpaqueResponse(),intent);
    const url=receipt?.publicUrl??opaque?.url;
    const slug=url&&new URL(url).pathname.slice(1);if(!url||!publicationUrl(url,slug))return {status:'unknown'};
    const entry={slug:slug!,url,rawResponse:receipt?.rawResponse??opaque!.rawResponse};
    if(receipt?.remoteId&&receipt.remoteId!==slug)return {status:'unknown'};
    const accepted=await readBack(context,doc,entry,deps);if(!accepted)return {status:'unknown'};
    const state=await persistBatch5Receipt(context,receipt??{version:1,intent,publicUrl:url,remoteId:slug,rawResponse:entry.rawResponse},owner.id,slug!);
    return {status:'found',publicUrl:url,rel:accepted.rel,batch5:state};
  }catch{return {status:'unknown'}}
}
export async function runLeafmillTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<ExecutionResult>{
  if(context.channel.id!==CHANNEL||context.task.channelId!==CHANNEL||context.channel.automation!=='api')return {status:'needs_input',message:'Leafmill 任务类型无效'};
  const persistence=context.batch5Persistence,owner=account(context);
  if(!persistence?.reserveIntent||!persistence.markSending||!persistence.assertReadyToSubmit||!owner)return {status:'needs_input',message:'Leafmill 缺少已验证账号或持久化写前闸'};
  if(await persistence.loadIntent()||batch5State(context)||context.task.submittedAt||context.task.publicUrl){
    const found=await reconcileLeafmillTask(context,overrides);
    return found.status==='found'?{status:'review',message:'Leafmill 原事务已只读验收',publicUrl:found.publicUrl,batch5:found.batch5}
      :unknown('Leafmill 原发布结果不明；不会再次 POST');
  }
  const secret=credential(await context.secrets.get(`account:${owner.id}`));
  if(!secret||secret.email!==owner.email)return {status:'needs_input',message:'Leafmill 授权账号绑定无效'};
  const deps=connectedDependencies(context,overrides);
  try{await probeLeafmillConnection(secret,deps,context.signal)}catch{return {status:'needs_input',message:'Leafmill 邮箱账号尚未由 /me 核实'}}
  let doc:Article;
  try{if(!articleReviewStillValid(context.task,context.site,context.channel,context.settings,owner,context.getArticlePublicationContext?.()))throw Error('review_invalid');doc=article(context)}
  catch{return {status:'needs_input',reasonCode:'format_invalid',message:'Leafmill 仅接受当前审核通过且含唯一目标链接的软件文档'}}
  const intent:Batch5Intent={version:1,channelId:CHANNEL,operationId:randomUUID(),siteId:context.site.id,sourceHash:doc.sourceHash,
    requestHash:doc.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};
  try{await persistence.reserveIntent(intent);context.checkpoint({batch5:stateFromIntent(intent,'reserved',owner.id),checkpoint:'batch5_reserved'} as Partial<Task>)}
  catch{return {status:'needs_input',message:'Leafmill 加密发布意图未保存'}}
  try{await persistence.assertReadyToSubmit(intent);await persistence.markSending(intent);
    context.checkpoint({batch5:stateFromIntent(intent,'submitting',owner.id),checkpoint:'batch5_submitting',submittedAt:intent.createdAt} as Partial<Task>)}
  catch{return unknown('Leafmill 写前权限变化；意图已保存，后续只读对账')}
  let response;
  try{response=await connectedRequest(`${ORIGIN}/api/v1/publish`,{method:'POST',headers:{...auth(secret.apiKey),'content-type':'application/json'},
    body:JSON.stringify({title:doc.title,body:doc.body,description:doc.description})},deps,context.signal,32_768);
    await persistBatch5Response(persistence,intent,response)}
  catch{return unknown('Leafmill 发布结果不明；不会再次 POST')}
  if(response.status===429)return {status:'failed',reasonCode:'platform_rate_limited',message:'Leafmill 发布频率受限；不会重发'};
  if(response.status>=400&&response.status<500&&response.status!==408)return {status:'failed',reasonCode:'platform_rejected',message:'Leafmill 拒绝发布；不会重发'};
  if(response.status!==201)return unknown('Leafmill 发布响应状态不明；不会再次 POST');
  const entry=published(parseConnectedJson(response));if(!entry)return unknown('Leafmill 未证明文章永久可用；不会再次 POST');
  const receipt:Batch5Receipt={version:1,intent,publicUrl:entry.url,remoteId:entry.slug,rawResponse:response.body};
  try{const state=await persistBatch5Receipt(context,receipt,owner.id,entry.slug);
    return {status:'review',message:'Leafmill 永久文章收据已保存，待公开页验收',publicUrl:entry.url,batch5:state}}
  catch{return unknown('Leafmill 发布收据保存不明；不会再次 POST')}
}
export async function verifyLeafmillPublication(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<LinkResult>{
  const fallback=context.task.publicUrl??ORIGIN;
  try{const found=await reconcileLeafmillTask(context,overrides);
    return found.status==='found'?{found:true,outcome:'found',url:found.publicUrl,rel:found.rel,reason:'Leafmill 原文、原生目标链接和抓取条件已匿名核对',indexable:true}
      :{found:false,outcome:'unreachable',url:fallback,rel:'',reason:'Leafmill 事务或公开页尚未通过只读验收'};
  }catch{return {found:false,outcome:'unreachable',url:fallback,rel:'',reason:'Leafmill 只读验收暂不可用'}}
}

export const leafmillTesting={credential,publicationUrl,article,published};
