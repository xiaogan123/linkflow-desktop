import {createHash} from 'node:crypto';

export const HERE_NOW_ORIGIN='https://here.now';
export const HERE_NOW_CREATE_URL=`${HERE_NOW_ORIGIN}/api/v1/publish`;
export const HERE_NOW_MAX_JSON_BYTES=256*1024;
export const HERE_NOW_MAX_HTML_BYTES=5*1024*1024;
export const HERE_NOW_CONTENT_TYPE='text/html; charset=utf-8';
const SLUG=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_UPLOAD_HEADERS=new Set(['authorization','connection','content-length','cookie','host','proxy-authorization','set-cookie','transfer-encoding']);

export interface HereNowIntent {operationId:string;accountId:string;remoteAccountId:string;sourceHash:string;requestHash:string;createdAt:string}
export interface HereNowOpaqueResponse extends HereNowIntent {kind:'here_now_create_response';version:1;status:number;contentType:string;responseUrl:string;redirected:boolean;bodyBase64:string;bodySha256:string}
export interface HereNowUploadTarget {path:'index.html';method:'PUT';url:string;headers:Record<string,string>}
export interface HereNowCreateReceipt extends HereNowIntent {slug:string;siteUrl:string;versionId:string;finalizeUrl:string;expiresAt:string;upload:HereNowUploadTarget}
export interface HereNowDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}
export interface HereNowPersistence {
  persistIntent(value:HereNowIntent):Promise<void>;
  assertWriteAuthorized(value:HereNowIntent,phase:'create'|'upload'|'finalize'):true;
  persistOpaque(value:HereNowOpaqueResponse):Promise<void>;
  loadOpaque():Promise<HereNowOpaqueResponse|undefined>;
  markStage(value:HereNowCreateReceipt,stage:'staged'|'uploaded'|'finalize_unknown'|'api_receipt'):Promise<void>;
  markCreateUnknown(value:HereNowIntent):Promise<void>;
}
export type HereNowDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'schema'|'redirect'|'media_type'|'http_status'|'expired'|'upload_rejected'|'finalize_rejected';

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export const hereNowSha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function validHereNowApiKey(value:unknown):value is string{return typeof value==='string'&&/^hnk_[A-Za-z0-9_-]{16,8188}$/.test(value)&&value.length<=8192}
export function validHereNowIntent(value:HereNowIntent){return /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value.operationId)&&UUID.test(value.accountId)&&UUID.test(value.remoteAccountId)&&HASH.test(value.sourceHash)&&HASH.test(value.requestHash)&&Number.isFinite(Date.parse(value.createdAt))&&new Date(value.createdAt).toISOString()===value.createdAt}
export function hereNowSiteUrl(slug:string){if(!SLUG.test(slug))throw Error('here.now slug 无效');return `https://${slug}.here.now/`}
export function hereNowRequest(html:string,title:string,description:string){
  const bytes=Buffer.byteLength(html,'utf8');if(bytes<1||bytes>HERE_NOW_MAX_HTML_BYTES)throw Error('here.now HTML 大小无效');
  const sourceHash=hereNowSha256(html),body=JSON.stringify({files:[{path:'index.html',size:bytes,contentType:HERE_NOW_CONTENT_TYPE,hash:sourceHash}],ttlSeconds:null,displayName:title.slice(0,80),displayDescription:description.slice(0,280)});
  return {body,sourceHash,requestHash:hereNowSha256(body),bytes};
}

function exactSiteUrl(value:unknown,slug:string):value is string{return value===hereNowSiteUrl(slug)}
function uploadUrl(value:unknown):value is string{
  if(typeof value!=='string'||value.length>8192)return false;
  try{const url=new URL(value),host=url.hostname.toLowerCase();return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&!!url.search&&host.endsWith('.r2.cloudflarestorage.com')&&host!=='r2.cloudflarestorage.com'&&url.pathname.startsWith('/')}catch{return false}
}
function uploadHeaders(value:unknown):value is Record<string,string>{
  if(!object(value)||Object.keys(value).length>32)return false;
  return Object.entries(value).every(([name,item])=>/^[A-Za-z0-9-]{1,64}$/.test(name)&&typeof item==='string'&&item.length<=2048&&!/[\r\n]/.test(item)&&!FORBIDDEN_UPLOAD_HEADERS.has(name.toLowerCase()));
}
function exactPublishStatus(value:unknown,accountId:string,state:'pending'|'live'){
  return object(value)&&value.requestAuth==='api_key'&&value.ownership==='personal'&&value.accountId===accountId&&value.persistence==='permanent'&&value.expiresAt===null&&value.state===state;
}
function decode(base64:string,expectedHash:string):unknown{const bytes=Buffer.from(base64,'base64');if(bytes.toString('base64')!==base64||!HASH.test(expectedHash)||hereNowSha256(bytes)!==expectedHash)throw Error('decode');const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);return JSON.parse(text)}

export function parseHereNowCreateResponse(opaque:HereNowOpaqueResponse,intent:HereNowIntent,now=new Date(),requireFreshUpload=false):HereNowCreateReceipt|{diagnostic:Exclude<HereNowDiagnostic,'transport'|'body_limit'|'opaque_persistence'|'upload_rejected'|'finalize_rejected'>}{
  if(JSON.stringify({operationId:opaque.operationId,accountId:opaque.accountId,remoteAccountId:opaque.remoteAccountId,sourceHash:opaque.sourceHash,requestHash:opaque.requestHash,createdAt:opaque.createdAt})!==JSON.stringify(intent))return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseUrl!==HERE_NOW_CREATE_URL)return {diagnostic:'redirect'};
  if(opaque.status!==200)return {diagnostic:'http_status'};
  if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  let value:unknown;try{value=decode(opaque.bodyBase64,opaque.bodySha256)}catch(error){return {diagnostic:error instanceof SyntaxError?'json':'decode'}}
  if(!object(value)||typeof value.slug!=='string'||!SLUG.test(value.slug)||!exactSiteUrl(value.siteUrl,value.slug)||('anonymous' in value&&value.anonymous!==false)||('expiresAt' in value&&value.expiresAt!==null)||'claimToken' in value||'claimUrl' in value||value.isLive!==false||value.requiresFinalize!==true||!exactPublishStatus(value.publishStatus,intent.remoteAccountId,'pending')||!object(value.upload))return {diagnostic:'schema'};
  const upload=value.upload,uploads=upload.uploads;
  if(typeof upload.versionId!=='string'||upload.versionId.length<1||upload.versionId.length>128||!Array.isArray(uploads)||uploads.length!==1||(Object.hasOwn(upload,'skipped')&&(!Array.isArray(upload.skipped)||upload.skipped.length!==0))||!Number.isInteger(upload.expiresInSeconds)||Number(upload.expiresInSeconds)<30||Number(upload.expiresInSeconds)>3600)return {diagnostic:'schema'};
  const target=uploads[0];if(!object(target)||target.path!=='index.html'||target.method!=='PUT'||!uploadUrl(target.url)||!uploadHeaders(target.headers))return {diagnostic:'schema'};
  const finalizeUrl=`${HERE_NOW_ORIGIN}/api/v1/publish/${value.slug}/finalize`;if(upload.finalizeUrl!==finalizeUrl)return {diagnostic:'schema'};
  const expiresAt=new Date(new Date(intent.createdAt).getTime()+Number(upload.expiresInSeconds)*1000).toISOString();if(requireFreshUpload&&Date.parse(expiresAt)<=now.getTime())return {diagnostic:'expired'};
  return {...intent,slug:value.slug,siteUrl:value.siteUrl as string,versionId:upload.versionId,finalizeUrl,expiresAt,upload:{path:'index.html',method:'PUT',url:target.url as string,headers:target.headers as Record<string,string>}};
}

export function parseHereNowFinalizeResponse(value:unknown,receipt:HereNowCreateReceipt):boolean{
  return object(value)&&value.success===true&&value.slug===receipt.slug&&value.siteUrl===receipt.siteUrl&&value.currentVersionId===receipt.versionId&&exactPublishStatus(value.publishStatus,receipt.remoteAccountId,'live')&&(!Array.isArray(value.warnings)||value.warnings.length===0);
}

class LimitError extends Error{}
function discard(response:Response){if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
function abortable<T>(pending:Promise<T>,signal:AbortSignal){if(signal.aborted)return Promise.reject(Error('abort'));return new Promise<T>((resolve,reject)=>{const abort=()=>{cleanup();reject(Error('abort'))},cleanup=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});pending.then(value=>{cleanup();resolve(value)},error=>{cleanup();reject(error)})})}
export async function readHereNowResponseBytes(response:Response,maximum:number,signal:AbortSignal){const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum))throw new LimitError();if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0,complete=false;try{for(;;){const next=await abortable(reader.read(),signal);if(next.done){complete=true;break}size+=next.value.byteLength;if(size>maximum)throw new LimitError();parts.push(next.value)}}finally{if(!complete)void reader.cancel().catch(()=>undefined);try{reader.releaseLock()}catch{}}return Buffer.concat(parts.map(value=>Buffer.from(value)))}
export async function fetchHereNowBounded(url:string,init:RequestInit,deps:HereNowDependencies,maximum:number){const controller=new AbortController(),abort=()=>controller.abort();deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)controller.abort();const timer=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(100,deps.timeoutMs??15_000)));timer.unref?.();let response:Response|undefined;try{const pending=(deps.fetch??fetch)(url,{...init,signal:controller.signal});void pending.then(value=>{if(controller.signal.aborted)discard(value)},()=>undefined);response=await abortable(pending,controller.signal);const bytes=await readHereNowResponseBytes(response,maximum,controller.signal);return {response,bytes}}catch(error){if(response)discard(response);throw error}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort);if(response&&controller.signal.aborted)discard(response)}}
const request=fetchHereNowBounded;
function opaque(response:Response,bytes:Uint8Array,intent:HereNowIntent):HereNowOpaqueResponse{return {...intent,kind:'here_now_create_response',version:1,status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:hereNowSha256(bytes)}}

export async function createHereNowSite(input:{operationId:string;accountId:string;remoteAccountId:string;apiKey:string;html:string;title:string;description:string},persistence:HereNowPersistence,deps:HereNowDependencies={}):Promise<{status:'created';receipt:HereNowCreateReceipt}|{status:'unknown';intent:HereNowIntent;diagnostic:HereNowDiagnostic}>{
  if(!validHereNowApiKey(input.apiKey))throw Error('here.now API key 无效');const prepared=hereNowRequest(input.html,input.title,input.description),intent:HereNowIntent={operationId:input.operationId,accountId:input.accountId,remoteAccountId:input.remoteAccountId,sourceHash:prepared.sourceHash,requestHash:prepared.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};if(!validHereNowIntent(intent))throw Error('here.now 提交信息无效');await persistence.persistIntent(intent);persistence.assertWriteAuthorized(intent,'create');let response:Response|undefined;
  try{const result=await request(HERE_NOW_CREATE_URL,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${input.apiKey}`,'x-herenow-client':'site-publisher'},body:prepared.body},deps,HERE_NOW_MAX_JSON_BYTES);response=result.response;const saved=opaque(response,result.bytes,intent);try{await persistence.persistOpaque(saved)}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence'}}const parsed=parseHereNowCreateResponse(saved,intent,deps.now?.()??new Date(),true);if('diagnostic' in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic};await persistence.markStage(parsed,'staged');return {status:'created',receipt:parsed}}catch(error){await persistence.markCreateUnknown(intent).catch(()=>undefined);return {status:'unknown',intent,diagnostic:error instanceof LimitError?'body_limit':'transport'}}finally{if(response&&!response.bodyUsed)discard(response)}
}

export async function uploadHereNowSite(receipt:HereNowCreateReceipt,html:string,persistence:HereNowPersistence,deps:HereNowDependencies={}):Promise<'uploaded'|'unknown'|'expired'>{
  if(Date.parse(receipt.expiresAt)<= (deps.now?.()??new Date()).getTime())return 'expired';persistence.assertWriteAuthorized(receipt,'upload');try{const result=await request(receipt.upload.url,{method:'PUT',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:receipt.upload.headers,body:html},deps,8192),response=result.response;if(response.redirected||response.url!==receipt.upload.url||response.status<200||response.status>=300)return 'unknown';await persistence.markStage(receipt,'uploaded');return 'uploaded'}catch{return 'unknown'}
}

export async function finalizeHereNowSite(receipt:HereNowCreateReceipt,apiKey:string,persistence:HereNowPersistence,deps:HereNowDependencies={}):Promise<'finalized'|'unknown'|'expired'>{
  if(!validHereNowApiKey(apiKey))throw Error('here.now API key 无效');if(Date.parse(receipt.expiresAt)<= (deps.now?.()??new Date()).getTime())return 'expired';persistence.assertWriteAuthorized(receipt,'finalize');try{const result=await request(receipt.finalizeUrl,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${apiKey}`,'x-herenow-client':'site-publisher'},body:JSON.stringify({versionId:receipt.versionId})},deps,HERE_NOW_MAX_JSON_BYTES),response=result.response;if(response.redirected||response.url!==receipt.finalizeUrl||response.status!==200||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json'){await persistence.markStage(receipt,'finalize_unknown');return 'unknown'}let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(result.bytes))}catch{await persistence.markStage(receipt,'finalize_unknown');return 'unknown'}if(!parseHereNowFinalizeResponse(value,receipt)){await persistence.markStage(receipt,'finalize_unknown');return 'unknown'}await persistence.markStage(receipt,'api_receipt');return 'finalized'}catch{await persistence.markStage(receipt,'finalize_unknown').catch(()=>undefined);return 'unknown'}
}

export const hereNowTesting={uploadUrl,uploadHeaders,exactPublishStatus,SLUG};
