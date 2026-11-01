import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import type {Batch5Dependencies} from './batch5-contract';
import {connectedRequest,noIndex,parseConnectedJson,type ConnectedResponse} from './batch5-connected';
import {randomUUID} from 'node:crypto';
import {articleReviewStillValid} from '../main/article-review';
import type {Account,ExecutionResult,LinkResult,Task} from '../shared/types';
import type {Batch5DomainStage,Batch5Intent,Batch5OpaqueResponse,Batch5Receipt,Batch5TaskState} from './batch5-contract';
import {batch5State,connectedDependencies,persistBatch5Receipt,persistBatch5Response,stateFromIntent,type ConnectedContext} from './batch5-connected';
import {renderShareYourHtmlArticle} from './shareyourhtml-article';

export const SHIPSTATIC_API='https://api.shipstatic.com';
const KEY=/^ship-[a-f0-9]{32}$/;
const DEPLOYMENT=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.shipstatic\.com$/;
const DOMAIN=/^[a-z0-9](?:[a-z0-9-]{4,61}[a-z0-9])?\.shipstatic\.com$/;
const MAX_HTML=200_000;
const ROBOTS='User-agent: *\nAllow: /\n';

export interface ShipStaticDeployment {deployment:string;url:string;rawResponse:string}
export interface ShipStaticDomain {domain:string;url:string;deployment:string;status:'live';rawResponse:string}
export interface ShipStaticDocument {html:string;targetUrl:string;sha256:string}
export interface ShipStaticRequest {key:string;domain:string;document:ShipStaticDocument;operationId:string}

function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
function validDeployment(value:unknown):value is string{return typeof value==='string'&&DEPLOYMENT.test(value)}
export function validShipStaticDomain(value:unknown):value is string{
  return typeof value==='string'&&DOMAIN.test(value)&&!/^([a-z]+-){2}[a-z0-9]{7}\.shipstatic\.com$/.test(value);
}
function headers(key:string):HeadersInit{
  if(!KEY.test(key))throw Error('shipstatic_key_invalid');
  return {accept:'application/json',authorization:`Bearer ${key}`};
}
function json(response:ConnectedResponse):Record<string,unknown>{
  const value=parseConnectedJson(response);if(!value)throw Error('shipstatic_json_invalid');return value;
}
function blocked(response:ConnectedResponse):boolean{
  return noIndex(response)||/(?:^|[,\s])(?:(?:googlebot|bingbot)\s*:\s*)?(?:none|noindex)(?=$|[,\s])/i.test(response.robotsHeader);
}
function deployment(value:Record<string,unknown>,rawResponse:string):ShipStaticDeployment{
  if(!validDeployment(value.deployment)||value.url!==`https://${value.deployment}`||value.status!=='success'
    ||value.password!==false||'claim' in value||'expires' in value)throw Error('shipstatic_deployment_invalid');
  return {deployment:value.deployment,url:value.url,rawResponse};
}
export function parseShipStaticDeploymentResponse(response:ConnectedResponse):ShipStaticDeployment{
  if(response.status!==201&&response.status!==200||response.url!==`${SHIPSTATIC_API}/deployments`&&!response.url.startsWith(`${SHIPSTATIC_API}/deployments/`))throw Error('shipstatic_deployment_response_invalid');
  return deployment(json(response),response.body);
}
function domain(value:Record<string,unknown>,expected:string,remote:string,rawResponse:string):ShipStaticDomain{
  if(value.domain!==expected||value.url!==`https://${expected}`||value.deployment!==remote||value.status!=='live'
    ||value.verification!=='verified'||value.paused!==null)throw Error('shipstatic_domain_invalid');
  return {domain:expected,url:value.url,deployment:remote,status:'live',rawResponse};
}

export function shipStaticDocument(html:string,targetUrl:string):ShipStaticDocument{
  const bytes=Buffer.byteLength(html,'utf8');if(bytes<1||bytes>MAX_HTML)throw Error('shipstatic_html_size');
  const target=new URL(targetUrl);if(target.protocol!=='https:'||target.username||target.password||target.hash)throw Error('shipstatic_target_invalid');
  const $=load(html);if($('a[href]').filter((_i,element)=>$(element).attr('href')===target.href).length!==1)throw Error('shipstatic_target_count');
  if($('meta[name="robots"],meta[name="googlebot"],meta[name="bingbot"]').filter((_i,element)=>/\bnoindex\b/i.test($(element).attr('content')??'')).length)throw Error('shipstatic_noindex_document');
  return {html,targetUrl:target.href,sha256:createHash('sha256').update(html).digest('hex')};
}

/** GET-only gate. Free plan and its domain/deployment capacity must be explicit. */
export async function probeShipStaticAccount(key:string,deps:Batch5Dependencies={},signal=new AbortController().signal):Promise<{email:string;remainingDomains:number;remainingDeployments:number}>{
  const response=await connectedRequest(`${SHIPSTATIC_API}/account`,{method:'GET',headers:headers(key)},deps,signal,32_000);
  if(response.status!==200)throw Error('shipstatic_account_unavailable');
  const value=json(response),plan=value.plan,usage=value.usage,caps=value.caps;
  if(typeof value.email!=='string'||!value.email.includes('@')||value.email.length>254||plan!=='free'
    ||!object(usage)||!object(caps)||!Number.isInteger(usage.platformDomains)||!Number.isInteger(caps.platformDomains)
    ||!Number.isInteger(usage.deployments)||!Number.isInteger(caps.deployments))throw Error('shipstatic_free_account_unproven');
  const remainingDomains=Number(caps.platformDomains)-Number(usage.platformDomains);
  const remainingDeployments=Number(caps.deployments)-Number(usage.deployments);
  if(remainingDomains<0||remainingDeployments<0)throw Error('shipstatic_capacity_invalid');
  return {email:value.email,remainingDomains,remainingDeployments};
}

/** One authenticated, idempotency-keyed upload. Caller must durably reserve and arm its intent first. */
/** Read the exact original deployment before any domain binding decision. */
export async function readShipStaticDeployment(key:string,remote:string,deps:Batch5Dependencies={},signal=new AbortController().signal):Promise<ShipStaticDeployment>{
  if(!validDeployment(remote))throw Error('shipstatic_deployment_id_invalid');
  const response=await connectedRequest(`${SHIPSTATIC_API}/deployments/${remote}`,{method:'GET',headers:headers(key)},deps,signal,64_000);
  if(response.status!==200)throw Error('shipstatic_deployment_unavailable');
  return deployment(json(response),response.body);
}

/** Acceptance is deliberately against the domain, never the noindex deployment preview. */
export async function verifyShipStaticPublic(input:ShipStaticRequest,remote:string,deps:Batch5Dependencies={},signal=new AbortController().signal):Promise<boolean>{
  const bound=await bindReadOnly(input.key,input.domain,remote,deps,signal);if(!bound)return false;
  const page=await connectedRequest(`${bound.url}/`,{method:'GET',headers:{accept:'text/html'}},deps,signal,MAX_HTML+8192);
  if(page.status!==200||!/^text\/html\b/i.test(page.contentType)||blocked(page)||page.body!==input.document.html)return false;
  const $=load(page.body);if($('a[href]').filter((_i,element)=>$(element).attr('href')===input.document.targetUrl).length!==1)return false;
  const robots=await connectedRequest(`${bound.url}/robots.txt`,{method:'GET'},deps,signal,1024);
  return robots.status===200&&!blocked(robots)&&robots.body===ROBOTS;
}

export async function bindReadOnly(key:string,name:string,remote:string,deps:Batch5Dependencies={},signal=new AbortController().signal):Promise<ShipStaticDomain|undefined>{
  if(!validShipStaticDomain(name)||!validDeployment(remote))return;
  const response=await connectedRequest(`${SHIPSTATIC_API}/domains/${name}`,{method:'GET',headers:headers(key)},deps,signal,32_000);
  if(response.status!==200)return;
  try{return domain(json(response),name,remote,response.body)}catch{return}
}

interface Credential {version:1;apiKey:string;email:string;domain:string}
function credential(raw:string|undefined):Credential|undefined{
  try{const value:unknown=JSON.parse(raw??'null');if(!object(value)||value.version!==1||typeof value.apiKey!=='string'||!KEY.test(value.apiKey)
    ||typeof value.email!=='string'||!value.email.includes('@')||!validShipStaticDomain(value.domain))return;
    return {version:1,apiKey:value.apiKey,email:value.email,domain:value.domain};}catch{return}
}
function owner(context:ConnectedContext):Account|undefined{
  const account=context.getAccount();return account?.channelId==='shipstatic'&&account.id===context.task.accountId&&account.status==='registered'
    &&account.hasPassword&&account.credentialKind==='api_token'&&account.ownerSiteId===context.site.id?account:undefined;
}
function document(context:ConnectedContext):ShipStaticDocument{
  if(!['software','developer','ai'].includes(context.site.category)||!context.task.draft||!context.task.topicUrl)throw Error('shipstatic_document_invalid');
  const target=new URL(context.task.topicUrl),source=new URL(context.site.url);
  if(target.protocol!=='https:'||source.protocol!=='https:'||target.hostname!==source.hostname)throw Error('shipstatic_target_invalid');
  const rendered=renderShareYourHtmlArticle({draft:{title:context.task.draft.title,description:context.task.draft.description,body:context.task.draft.body},
    targetUrl:target.href,language:context.site.language,slug:'shipstatic-docs'});
  return shipStaticDocument(rendered.html,target.href);
}
function requestHash(doc:ShipStaticDocument,domain:string):string{return createHash('sha256').update(`${doc.sha256}\n${domain}`).digest('hex')}
function exactDocument(context:ConnectedContext,intent:Batch5Intent,domain:string):ShipStaticDocument|undefined{
  try{const doc=document(context);return intent.channelId==='shipstatic'&&intent.siteId===context.site.id&&intent.sourceHash===doc.sha256
    &&intent.requestHash===requestHash(doc,domain)?doc:undefined;}catch{return}
}
function opaqueResponse(value:Batch5OpaqueResponse|undefined,intent:Batch5Intent):ConnectedResponse|undefined{
  if(!value||!value.bodyComplete||JSON.stringify(value.intent)!==JSON.stringify(intent)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bodyBase64))return;
  const bytes=Buffer.from(value.bodyBase64,'base64');if(bytes.toString('base64')!==value.bodyBase64)return;
  return {status:value.status,url:value.responseUrl,contentType:value.contentType,body:bytes.toString('utf8'),robotsHeader:''};
}
function unknown(message:string):ExecutionResult{return {status:'review',reasonCode:'submission_unknown',message}}
function responseOpaque(intent:Batch5Intent,response:ConnectedResponse):Batch5OpaqueResponse{return {version:1,intent,status:response.status,contentType:response.contentType,
  responseUrl:response.url,bodyBase64:Buffer.from(response.body).toString('base64'),bodyComplete:true};}
async function accountAndVacancy(secret:Credential,deps:Batch5Dependencies,signal:AbortSignal,needDeployment=true):Promise<boolean>{
  const probe=await probeShipStaticAccount(secret.apiKey,deps,signal);if(probe.email.toLowerCase()!==secret.email.toLowerCase()
    ||probe.remainingDomains<1||needDeployment&&probe.remainingDeployments<1)return false;
  const response=await connectedRequest(`${SHIPSTATIC_API}/domains/${secret.domain}`,{method:'GET',headers:headers(secret.apiKey)},deps,signal,32_000);
  return response.status===404;
}
async function originalDeployment(context:ConnectedContext,secret:Credential,intent:Batch5Intent,deps:Batch5Dependencies):Promise<ShipStaticDeployment|undefined>{
  const persistence=context.batch5Persistence!;const receipt=await persistence.loadReceipt();let original:ShipStaticDeployment|undefined;
  if(receipt){if(JSON.stringify(receipt.intent)!==JSON.stringify(intent)||!receipt.remoteId)return;original={deployment:receipt.remoteId,url:receipt.publicUrl,rawResponse:receipt.rawResponse};}
  else {const response=opaqueResponse(await persistence.loadOpaqueResponse(),intent);if(!response)return;
    try{original=parseShipStaticDeploymentResponse(response)}catch{return}}
  try{const current=await readShipStaticDeployment(secret.apiKey,original.deployment,deps,context.signal);
    if(current.deployment!==original.deployment||current.url!==original.url)return;
    if(!receipt)await persistBatch5Receipt(context,{version:1,intent,publicUrl:original.url,remoteId:original.deployment,rawResponse:original.rawResponse},owner(context)!.id,original.deployment);
    return original;}catch{return}
}
export async function reconcileShipStaticTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<{status:'found';publicUrl:string;batch5:Batch5TaskState}|{status:'unknown'}>{
  const persistence=context.batch5Persistence,account=owner(context);if(!persistence||!account)return {status:'unknown'};
  const intent=await persistence.loadIntent();if(!intent)return {status:'unknown'};
  const secret=credential(await context.secrets.get(`account:${account.id}`));if(!secret||secret.email.toLowerCase()!==account.username.toLowerCase()
    ||account.publicationUrl!==`https://${secret.domain}/`)return {status:'unknown'};
  const doc=exactDocument(context,intent,secret.domain);if(!doc)return {status:'unknown'};
  const deps=connectedDependencies(context,overrides);
  try{const probe=await probeShipStaticAccount(secret.apiKey,deps,context.signal);if(probe.email.toLowerCase()!==secret.email.toLowerCase())return {status:'unknown'};
    const original=await originalDeployment(context,secret,intent,deps);if(!original)return {status:'unknown'};
    const stage=await persistence.loadDomainStage?.();if(!stage||stage.domain!==secret.domain||stage.remoteId!==original.deployment)return {status:'unknown'};
    const bound=await bindReadOnly(secret.apiKey,secret.domain,original.deployment,deps,context.signal);if(!bound)return {status:'unknown'};
    const existing=await persistence.loadDomainReceipt?.();
    const receipt:Batch5Receipt=existing??{version:1,intent,publicUrl:bound.url+'/',remoteId:original.deployment,rawResponse:bound.rawResponse};
    if(receipt.publicUrl!==bound.url+'/'||receipt.remoteId!==original.deployment)return {status:'unknown'};
    if(!existing)await persistence.saveDomainReceipt?.(receipt);
    if(!await verifyShipStaticPublic({key:secret.apiKey,domain:secret.domain,document:doc,operationId:intent.operationId},original.deployment,deps,context.signal))return {status:'unknown'};
    const state=persistence.currentTaskState?.()??stateFromIntent(intent,'api_receipt',account.id,original.deployment,receipt.publicUrl);
    return {status:'found',publicUrl:receipt.publicUrl,batch5:state};}catch{return {status:'unknown'}}
}
export async function runShipStaticTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<ExecutionResult>{
  if(context.channel.id!=='shipstatic'||context.task.channelId!=='shipstatic'||context.channel.automation!=='api')return {status:'needs_input',message:'ShipStatic 任务类型无效'};
  const persistence=context.batch5Persistence,account=owner(context);if(!persistence?.reserveIntent||!persistence.markSending||!persistence.assertReadyToSubmit
    ||!persistence.markDomainSending||!persistence.assertReadyToBind||!persistence.saveDomainOpaqueResponse||!persistence.saveDomainReceipt||!account)
    return {status:'needs_input',message:'ShipStatic 缺少账号或持久化写前闸'};
  if(await persistence.loadIntent()||batch5State(context)||context.task.submittedAt||context.task.publicUrl){const found=await reconcileShipStaticTask(context,overrides);
    return found.status==='found'?{status:'review',message:'ShipStatic 原事务只读对账成功，待公开页验收',publicUrl:found.publicUrl,batch5:found.batch5}
      :unknown('ShipStatic 原事务状态不明；只会 GET 对账，不会再次部署或绑定域名');}
  const secret=credential(await context.secrets.get(`account:${account.id}`));if(!secret||secret.email.toLowerCase()!==account.username.toLowerCase()
    ||account.publicationUrl!==`https://${secret.domain}/`)return {status:'needs_input',message:'ShipStatic 账号绑定无效'};
  const deps=connectedDependencies(context,overrides);let doc:ShipStaticDocument;
  try{if(!articleReviewStillValid(context.task,context.site,context.channel,context.settings,account,context.getArticlePublicationContext?.()))throw Error('review');
    doc=document(context);if(!await accountAndVacancy(secret,deps,context.signal))throw Error('capacity');}
  catch{return {status:'needs_input',message:'ShipStatic 审核、Free 配额或专用域名未通过只读预检'}}
  const intent:Batch5Intent={version:1,channelId:'shipstatic',operationId:randomUUID(),siteId:context.site.id,sourceHash:doc.sha256,requestHash:requestHash(doc,secret.domain),createdAt:(deps.now?.()??new Date()).toISOString()};
  try{await persistence.reserveIntent(intent);context.checkpoint({batch5:stateFromIntent(intent,'reserved',account.id),checkpoint:'batch5_reserved'} as Partial<Task>)}
  catch{return {status:'needs_input',message:'ShipStatic 加密意图未保存'}}
  try{if(!await accountAndVacancy(secret,deps,context.signal))throw Error('capacity');await persistence.assertReadyToSubmit(intent);await persistence.markSending(intent);
    context.checkpoint({batch5:stateFromIntent(intent,'submitting',account.id),checkpoint:'batch5_submitting',submittedAt:intent.createdAt} as Partial<Task>)}
  catch{return unknown('ShipStatic 写前权限或配额变化；意图已保存，后续只读对账')}
  let response:ConnectedResponse;
  try{const body=new FormData();body.append('files[]',new Blob([doc.html],{type:'text/html'}),'index.html');body.append('files[]',new Blob([ROBOTS],{type:'text/plain'}),'robots.txt');
    response=await connectedRequest(`${SHIPSTATIC_API}/deployments`,{method:'POST',headers:{...headers(secret.apiKey),'Idempotency-Key':intent.operationId},body},deps,context.signal,64_000);
    await persistBatch5Response(persistence,intent,response);}catch{return unknown('ShipStatic 部署结果不明；只会 GET 对账')}
  let original:ShipStaticDeployment;try{original=parseShipStaticDeploymentResponse(response)}catch{return unknown('ShipStatic 部署响应不明；只会 GET 对账')}
  try{const readback=await readShipStaticDeployment(secret.apiKey,original.deployment,deps,context.signal);if(readback.deployment!==original.deployment)throw Error('remote');
    await persistBatch5Receipt(context,{version:1,intent,publicUrl:original.url,remoteId:original.deployment,rawResponse:response.body},account.id,original.deployment)}
  catch{return unknown('ShipStatic 部署收据或只读回查未完成；只会 GET 对账')}
  const stage:Batch5DomainStage={version:1,intent,domain:secret.domain,remoteId:original.deployment};
  try{if(!articleReviewStillValid(context.task,context.site,context.channel,context.settings,account,context.getArticlePublicationContext?.())
      ||!await accountAndVacancy(secret,deps,context.signal,false))throw Error('capacity');await persistence.markDomainSending(stage);
    await persistence.assertReadyToBind(stage);}catch{return unknown('ShipStatic 域名写前权限或配额变化；不会重试绑定')}
  let bindResponse:ConnectedResponse;
  try{bindResponse=await connectedRequest(`${SHIPSTATIC_API}/domains/${secret.domain}`,{method:'PUT',headers:{...headers(secret.apiKey),'content-type':'application/json'},
    body:JSON.stringify({deployment:original.deployment})},deps,context.signal,32_000);
    await persistence.saveDomainOpaqueResponse(responseOpaque(intent,bindResponse));}
  catch{return unknown('ShipStatic 域名绑定结果不明；只会 GET 对账')}
  if(bindResponse.status!==200&&bindResponse.status!==201)return unknown('ShipStatic 域名绑定响应不明；只会 GET 对账');
  const found=await reconcileShipStaticTask(context,overrides);
  return found.status==='found'?{status:'review',message:'ShipStatic 公开域名及原生链接已读回，待平台验收',publicUrl:found.publicUrl,batch5:found.batch5}
    :unknown('ShipStatic 域名结果尚未核实；只会 GET 对账');
}
export async function verifyShipStaticPublication(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<LinkResult>{
  const found=await reconcileShipStaticTask(context,overrides);return found.status==='found'
    ?{found:true,outcome:'found',url:found.publicUrl,rel:'nofollow ugc noopener noreferrer',reason:'ShipStatic 公开 HTML、唯一原生目标链接及抓取权限已核对',indexable:true}
    :{found:false,outcome:'unreachable',url:context.task.publicUrl??'https://shipstatic.com/',rel:'',reason:'ShipStatic 只读验收尚未完成'};
}
