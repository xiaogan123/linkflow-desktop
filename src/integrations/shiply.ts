import {createHash} from 'node:crypto';

export const SHIPLY_ORIGIN='https://shiply.now';
export const SHIPLY_CREATE_URL=`${SHIPLY_ORIGIN}/api/v1/publish`;
export const SHIPLY_MAX_JSON_BYTES=256*1024;
export const SHIPLY_MAX_HTML_BYTES=5*1024*1024;
export const SHIPLY_CONTENT_TYPE='text/html';
const SLUG=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_UPLOAD_HEADERS=new Set(['authorization','connection','content-length','cookie','host','proxy-authorization','set-cookie','transfer-encoding']);

export interface ShiplyIntent {operationId:string;accountId:string;emailHash:string;sourceHash:string;requestHash:string;createdAt:string}
export interface ShiplyOpaqueResponse extends ShiplyIntent {kind:'shiply_create_response';version:1;status:number;contentType:string;responseUrl:string;redirected:boolean;bodyBase64:string;bodySha256:string}
export interface ShiplyUploadTarget {path:'index.html';method:'PUT';url:string;headers:Record<string,string>}
export interface ShiplyCreateReceipt extends ShiplyIntent {slug:string;siteUrl:string;versionId:string;finalizeUrl:string;expiresAt:string;upload:ShiplyUploadTarget}
export interface ShiplyDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}
export interface ShiplyPersistence {
  persistIntent(value:ShiplyIntent):Promise<void>;
  assertWriteAuthorized(value:ShiplyIntent,phase:'create'|'upload'|'finalize'):true;
  persistOpaque(value:ShiplyOpaqueResponse):Promise<void>;
  loadOpaque():Promise<ShiplyOpaqueResponse|undefined>;
  markStage(value:ShiplyCreateReceipt,stage:'staged'|'upload_unknown'|'uploaded'|'finalize_unknown'|'api_receipt'):Promise<void>;
  markCreateUnknown(value:ShiplyIntent):Promise<void>;
}
export type ShiplyDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'schema'|'redirect'|'media_type'|'http_status'|'expired'|'upload_rejected'|'finalize_rejected';

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export const shiplySha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function validShiplyApiKey(value:unknown):value is string{return typeof value==='string'&&/^shp_[A-Za-z0-9_-]{16,8188}$/.test(value)&&value.length<=8192}
export function validShiplyIntent(value:ShiplyIntent){return /^shiply_[a-f0-9]{32}$/.test(value.operationId)&&UUID.test(value.accountId)&&HASH.test(value.emailHash)&&HASH.test(value.sourceHash)&&HASH.test(value.requestHash)&&Number.isFinite(Date.parse(value.createdAt))&&new Date(value.createdAt).toISOString()===value.createdAt}
export function shiplySiteUrl(slug:string){if(!SLUG.test(slug))throw Error('shiply.now slug 无效');return `https://${slug}.shiply.now/`}
export function shiplyRequest(html:string,title:string,description:string){
  const bytes=Buffer.byteLength(html,'utf8');if(bytes<1||bytes>SHIPLY_MAX_HTML_BYTES)throw Error('shiply.now HTML 大小无效');
  const sourceHash=shiplySha256(html),body=JSON.stringify({files:[{path:'index.html',size:bytes,contentType:SHIPLY_CONTENT_TYPE,hash:sourceHash}],viewer:{title:title.slice(0,80),description:description.slice(0,280)}});
  return {body,sourceHash,requestHash:shiplySha256(body),bytes};
}

function exactSiteUrl(value:unknown,slug:string):value is string{return value===shiplySiteUrl(slug)}
function uploadUrl(value:unknown):value is string{
  if(typeof value!=='string'||value.length>8192)return false;
  try{const url=new URL(value),host=url.hostname.toLowerCase();return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&!!url.search&&(host.endsWith('.r2.cloudflarestorage.com')||host.endsWith('.s3.amazonaws.com')||/^s3\.[a-z0-9-]+\.amazonaws\.com$/.test(host)||host.endsWith('.storage.googleapis.com'))&&url.pathname.startsWith('/')}catch{return false}
}
function uploadHeaders(value:unknown):value is Record<string,string>{
  if(!object(value)||Object.keys(value).length>32)return false;
  return Object.entries(value).every(([name,item])=>/^[A-Za-z0-9-]{1,64}$/.test(name)&&typeof item==='string'&&item.length<=2048&&!/[\r\n]/.test(item)&&!FORBIDDEN_UPLOAD_HEADERS.has(name.toLowerCase()));
}
function decode(base64:string,expectedHash:string):unknown{const bytes=Buffer.from(base64,'base64');if(bytes.toString('base64')!==base64||!HASH.test(expectedHash)||shiplySha256(bytes)!==expectedHash)throw Error('decode');const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);return JSON.parse(text)}

export function parseShiplyCreateResponse(opaque:ShiplyOpaqueResponse,intent:ShiplyIntent,now=new Date(),requireFreshUpload=false):ShiplyCreateReceipt|{diagnostic:Exclude<ShiplyDiagnostic,'transport'|'body_limit'|'opaque_persistence'|'upload_rejected'|'finalize_rejected'>}{
  if(JSON.stringify({operationId:opaque.operationId,accountId:opaque.accountId,emailHash:opaque.emailHash,sourceHash:opaque.sourceHash,requestHash:opaque.requestHash,createdAt:opaque.createdAt})!==JSON.stringify(intent))return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseUrl!==SHIPLY_CREATE_URL)return {diagnostic:'redirect'};
  if(opaque.status!==200)return {diagnostic:'http_status'};
  if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  let value:unknown;try{value=decode(opaque.bodyBase64,opaque.bodySha256)}catch(error){return {diagnostic:error instanceof SyntaxError?'json':'decode'}}
  if(!object(value)||typeof value.slug!=='string'||!SLUG.test(value.slug)||!exactSiteUrl(value.siteUrl,value.slug)||'claimToken' in value||'claimUrl' in value||('toUpdate' in value&&(typeof value.toUpdate!=='string'||Buffer.byteLength(value.toUpdate,'utf8')<1||Buffer.byteLength(value.toUpdate,'utf8')>8192))||('expiresAt' in value&&value.expiresAt!==null)||!object(value.upload))return {diagnostic:'schema'};
  const upload=value.upload,uploads=upload.uploads;
  if(typeof upload.versionId!=='string'||upload.versionId.length<1||upload.versionId.length>128||!Array.isArray(uploads)||uploads.length!==1||(Object.hasOwn(upload,'skipped')&&(!Array.isArray(upload.skipped)||upload.skipped.length!==0))||!Number.isInteger(upload.expiresInSeconds)||Number(upload.expiresInSeconds)<30||Number(upload.expiresInSeconds)>3600)return {diagnostic:'schema'};
  const target=uploads[0];if(!object(target)||target.path!=='index.html'||target.method!=='PUT'||!uploadUrl(target.url)||!uploadHeaders(target.headers))return {diagnostic:'schema'};
  const finalizeUrl=`${SHIPLY_ORIGIN}/api/v1/publish/${value.slug}/finalize`;if(upload.finalizeUrl!==finalizeUrl)return {diagnostic:'schema'};
  const expiresAt=new Date(new Date(intent.createdAt).getTime()+Number(upload.expiresInSeconds)*1000).toISOString();if(requireFreshUpload&&Date.parse(expiresAt)<=now.getTime())return {diagnostic:'expired'};
  return {...intent,slug:value.slug,siteUrl:value.siteUrl as string,versionId:upload.versionId,finalizeUrl,expiresAt,upload:{path:'index.html',method:'PUT',url:target.url as string,headers:target.headers as Record<string,string>}};
}

export function parseShiplyFinalizeResponse(value:unknown,receipt:ShiplyCreateReceipt):boolean{
  return object(value)&&value.success===true&&value.slug===receipt.slug&&value.currentVersionId===receipt.versionId;
}

class LimitError extends Error{}
function discard(response:Response){if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
function abortable<T>(pending:Promise<T>,signal:AbortSignal){if(signal.aborted)return Promise.reject(Error('abort'));return new Promise<T>((resolve,reject)=>{const abort=()=>{cleanup();reject(Error('abort'))},cleanup=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});pending.then(value=>{cleanup();resolve(value)},error=>{cleanup();reject(error)})})}
export async function readShiplyResponseBytes(response:Response,maximum:number,signal:AbortSignal){const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum))throw new LimitError();if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0,complete=false;try{for(;;){const next=await abortable(reader.read(),signal);if(next.done){complete=true;break}size+=next.value.byteLength;if(size>maximum)throw new LimitError();parts.push(next.value)}}finally{if(!complete)void reader.cancel().catch(()=>undefined);try{reader.releaseLock()}catch{}}return Buffer.concat(parts.map(value=>Buffer.from(value)))}
export async function fetchShiplyBounded(url:string,init:RequestInit,deps:ShiplyDependencies,maximum:number){const controller=new AbortController(),abort=()=>controller.abort();deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)controller.abort();const timer=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(100,deps.timeoutMs??15_000)));timer.unref?.();let response:Response|undefined;try{const pending=(deps.fetch??fetch)(url,{...init,signal:controller.signal});void pending.then(value=>{if(controller.signal.aborted)discard(value)},()=>undefined);response=await abortable(pending,controller.signal);const bytes=await readShiplyResponseBytes(response,maximum,controller.signal);return {response,bytes}}catch(error){if(response)discard(response);throw error}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort);if(response&&controller.signal.aborted)discard(response)}}
const request=fetchShiplyBounded;
function opaque(response:Response,bytes:Uint8Array,intent:ShiplyIntent):ShiplyOpaqueResponse{return {...intent,kind:'shiply_create_response',version:1,status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:shiplySha256(bytes)}}

export async function createShiplySite(input:{operationId:string;accountId:string;emailHash:string;apiKey:string;html:string;title:string;description:string},persistence:ShiplyPersistence,deps:ShiplyDependencies={}):Promise<{status:'created';receipt:ShiplyCreateReceipt}|{status:'unknown';intent:ShiplyIntent;diagnostic:ShiplyDiagnostic;stage:'submitting'|'create_unknown'|'opaque_response'}>{
  if(!validShiplyApiKey(input.apiKey))throw Error('shiply.now API key 无效');const prepared=shiplyRequest(input.html,input.title,input.description),intent:ShiplyIntent={operationId:input.operationId,accountId:input.accountId,emailHash:input.emailHash,sourceHash:prepared.sourceHash,requestHash:prepared.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};if(!validShiplyIntent(intent))throw Error('shiply.now 意图无效');await persistence.persistIntent(intent);persistence.assertWriteAuthorized(intent,'create');let response:Response|undefined;
  let bytes:Uint8Array;try{const result=await request(SHIPLY_CREATE_URL,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${input.apiKey}`},body:prepared.body},deps,SHIPLY_MAX_JSON_BYTES);response=result.response;bytes=result.bytes}catch(error){let stage:'submitting'|'create_unknown'='submitting';try{await persistence.markCreateUnknown(intent);stage='create_unknown'}catch{}return {status:'unknown',intent,diagnostic:error instanceof LimitError?'body_limit':'transport',stage}}
  const saved=opaque(response,bytes,intent);try{await persistence.persistOpaque(saved)}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',stage:'submitting'}}const parsed=parseShiplyCreateResponse(saved,intent,deps.now?.()??new Date(),true);if('diagnostic' in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic,stage:'opaque_response'};await persistence.markStage(parsed,'staged');return {status:'created',receipt:parsed}
}

export async function uploadShiplySite(receipt:ShiplyCreateReceipt,html:string,persistence:ShiplyPersistence,deps:ShiplyDependencies={}):Promise<'uploaded'|'unknown'|'expired'>{
  if(Date.parse(receipt.expiresAt)<= (deps.now?.()??new Date()).getTime())return 'expired';if(shiplySha256(html)!==receipt.sourceHash)throw Error('shiply.now 上传内容已改变');persistence.assertWriteAuthorized(receipt,'upload');await persistence.markStage(receipt,'upload_unknown');try{const result=await request(receipt.upload.url,{method:'PUT',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:receipt.upload.headers,body:html},deps,8192),response=result.response;if(response.redirected||response.url!==receipt.upload.url||response.status<200||response.status>=300)return 'unknown';await persistence.markStage(receipt,'uploaded');return 'uploaded'}catch{return 'unknown'}
}

export async function finalizeShiplySite(receipt:ShiplyCreateReceipt,apiKey:string,persistence:ShiplyPersistence,deps:ShiplyDependencies={}):Promise<'finalized'|'unknown'|'expired'>{
  if(!validShiplyApiKey(apiKey))throw Error('shiply.now API key 无效');if(Date.parse(receipt.expiresAt)<= (deps.now?.()??new Date()).getTime())return 'expired';persistence.assertWriteAuthorized(receipt,'finalize');await persistence.markStage(receipt,'finalize_unknown');try{const result=await request(receipt.finalizeUrl,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${apiKey}`},body:JSON.stringify({versionId:receipt.versionId})},deps,SHIPLY_MAX_JSON_BYTES),response=result.response;if(response.redirected||response.url!==receipt.finalizeUrl||response.status!==200||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')return 'unknown';let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(result.bytes))}catch{return 'unknown'}if(!parseShiplyFinalizeResponse(value,receipt))return 'unknown';await persistence.markStage(receipt,'api_receipt');return 'finalized'}catch{return 'unknown'}
}

export const shiplyTesting={uploadUrl,uploadHeaders,SLUG};
