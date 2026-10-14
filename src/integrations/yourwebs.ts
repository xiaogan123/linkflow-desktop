import {createHash} from 'node:crypto';

export const YOURWEBS_ORIGIN='https://yourwebs.cc';
export const YOURWEBS_PUBLIC_SUFFIX='yourwebs.app';
export const YOURWEBS_ANONYMOUS_TTL_MS=30*86400_000;
export const YOURWEBS_CREATE_URL=`${YOURWEBS_ORIGIN}/api/v1/pages`;
export const YOURWEBS_MAX_CONTENT_BYTES=1_000_000;
export const YOURWEBS_ID=/^[A-Za-z0-9_-]{1,64}$/;
export const YOURWEBS_SUBDOMAIN=/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const HASH=/^[a-f0-9]{64}$/;
const OP=/^yourwebs_[a-f0-9]{32}$/;
const MAX_RESPONSE=64*1024;
const pendingOperations=new Set<Promise<unknown>>();

export interface YourwebsIntent {operationId:string;sourceHash:string;requestHash:string;createdAt:string}
export interface YourwebsReceipt extends YourwebsIntent {id:string;subdomain:string;publicUrl:string;remoteCreatedAt:number;expiresAt:number}
export interface YourwebsOpaqueResponse extends YourwebsIntent {version:1;kind:'yourwebs_opaque_response';status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string}
export interface YourwebsPersistence {
  persistIntent(intent:YourwebsIntent):Promise<void>;
  assertReadyToSubmit(intent:YourwebsIntent):true;
  persistOpaqueResponse(response:YourwebsOpaqueResponse):Promise<void>;
  loadOpaqueResponse():Promise<YourwebsOpaqueResponse|undefined>;
  promoteReceipt(receipt:YourwebsReceipt):Promise<void>;
}
export interface YourwebsDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}
export type YourwebsDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status';
export type YourwebsCreateResult={status:'not_started';reason:'invalid_content'|'intent_not_persisted'|'authorization_changed'}|{status:'unknown';intent:YourwebsIntent;diagnostic:YourwebsDiagnostic;opaqueResponseSaved:boolean}|{status:'created';receipt:YourwebsReceipt};

export const yourwebsHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function trackYourwebsPendingOperation<T>(pending:Promise<T>):Promise<T>{let tracked:Promise<T>;tracked=Promise.resolve(pending).then(value=>{pendingOperations.delete(tracked);return value},error=>{pendingOperations.delete(tracked);throw error});pendingOperations.add(tracked);return tracked}
export async function drainYourwebsPendingOperations():Promise<void>{while(pendingOperations.size)await Promise.allSettled([...pendingOperations])}
export function yourwebsPendingOperationCount(){return pendingOperations.size}
export function yourwebsPublicUrl(subdomain:string){if(!YOURWEBS_SUBDOMAIN.test(subdomain)||subdomain.includes('--'))throw Error('Yourwebs 子域无效');return `https://${subdomain}.${YOURWEBS_PUBLIC_SUFFIX}/`}
export function yourwebsRequest(html:string,title:string){const body=JSON.stringify({html,title});return {body,sourceHash:yourwebsHash(html),requestHash:yourwebsHash(`POST\n${YOURWEBS_CREATE_URL}\naccept:application/json\ncontent-type:application/json\n\n${body}`)}}
export function validYourwebsIntent(intent:YourwebsIntent){return OP.test(intent.operationId)&&HASH.test(intent.sourceHash)&&HASH.test(intent.requestHash)&&Number.isFinite(Date.parse(intent.createdAt))&&new Date(intent.createdAt).toISOString()===intent.createdAt}
function sameIntent(a:YourwebsIntent,b:YourwebsIntent){return a.operationId===b.operationId&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}

import {pstrsTopLevelKeys as yourwebsTopLevelKeys} from './pstrs';
function parseResponse(opaque:YourwebsOpaqueResponse,intent:YourwebsIntent,html:string,title:string,nowMs:number):{receipt:YourwebsReceipt}|{diagnostic:YourwebsDiagnostic}{
  const request=yourwebsRequest(html,title);if(!sameIntent(opaque,intent)||request.requestHash!==intent.requestHash||request.sourceHash!==intent.sourceHash)return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400||opaque.responseUrl&&opaque.responseUrl!==YOURWEBS_CREATE_URL)return {diagnostic:'redirect'};
  if(opaque.status!==201)return {diagnostic:'http_status'};
  if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(opaque.bodyBase64,'base64'))}catch{return {diagnostic:'decode'}}
  const keys=yourwebsTopLevelKeys(text);if(!keys)return {diagnostic:'json'};if(new Set(keys).size!==keys.length)return {diagnostic:'duplicate_field'};
  let parsed:unknown;try{parsed=JSON.parse(text)}catch{return {diagnostic:'json'}}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {diagnostic:'schema'};const value=parsed as Record<string,unknown>;
  if(Object.keys(value).sort().join(',')!=='created_at,id,size_bytes,status,subdomain,title,total_views,updated_at,url'||typeof value.id!=='string'||!YOURWEBS_ID.test(value.id)||typeof value.subdomain!=='string'||!YOURWEBS_SUBDOMAIN.test(value.subdomain)||value.subdomain.includes('--')||value.title!==title||value.status!=='active'||value.size_bytes!==Buffer.byteLength(html,'utf8')||!Number.isSafeInteger(value.total_views)||Number(value.total_views)<0||!Number.isSafeInteger(value.created_at)||!Number.isSafeInteger(value.updated_at))return {diagnostic:'schema'};
  const publicUrl=yourwebsPublicUrl(value.subdomain);if(value.url!==publicUrl&&value.url!==publicUrl.slice(0,-1))return {diagnostic:'schema'};
  const created=Number(value.created_at),updated=Number(value.updated_at),localCreated=Date.parse(intent.createdAt);
  if(!Number.isFinite(nowMs)||Math.abs(nowMs-localCreated)>60_000||Math.abs(created-localCreated)>300_000||updated<created||updated>localCreated+300_000)return {diagnostic:'schema'};
  return {receipt:{...intent,id:value.id,subdomain:value.subdomain,publicUrl,remoteCreatedAt:created,expiresAt:created+YOURWEBS_ANONYMOUS_TTL_MS}};
}

export const parseStoredYourwebsCreateResponse=parseResponse;
export function yourwebsExpiryMs(value:number){return value}
class BodyLimitError extends Error{}
function discard(response:Response){if(response.body&&!response.body.locked)void trackYourwebsPendingOperation(response.body.cancel()).catch(()=>undefined)}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{const tracked=trackYourwebsPendingOperation(pending);if(signal.aborted){void tracked.then(value=>late?.(value),()=>undefined);return Promise.reject(Error('abort'))}return new Promise((resolve,reject)=>{let done=false;const stop=()=>{if(done)return;done=true;signal.removeEventListener('abort',stop);reject(Error('abort'))};signal.addEventListener('abort',stop,{once:true});void tracked.then(value=>{signal.removeEventListener('abort',stop);if(done){late?.(value);return}done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(Error('transport'))})})}
async function bounded(response:Response,signal:AbortSignal):Promise<Uint8Array>{const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_RESPONSE))throw new BodyLimitError();if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>MAX_RESPONSE)throw new BodyLimitError();parts.push(next.value)}}finally{reader.releaseLock()}return Buffer.concat(parts.map(value=>Buffer.from(value)))}
function opaqueFrom(response:Response,bytes:Uint8Array,intent:YourwebsIntent):YourwebsOpaqueResponse{return {...intent,version:1,kind:'yourwebs_opaque_response',status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:yourwebsHash(bytes)}}

export async function createYourwebsPage(input:{operationId:string;html:string;title:string;reviewed:true},persistence:YourwebsPersistence,deps:YourwebsDependencies={}):Promise<YourwebsCreateResult>{
  if(input.reviewed!==true||!OP.test(input.operationId))throw Error('Yourwebs 缺少已审核的单次发布身份');
  if(deps.signal?.aborted)return {status:'not_started',reason:'authorization_changed'};
  const request=yourwebsRequest(input.html,input.title);if(!input.html||!/^<!doctype html>/i.test(input.html)||Buffer.from(input.html,'utf8').toString('utf8')!==input.html||Buffer.byteLength(input.html,'utf8')>YOURWEBS_MAX_CONTENT_BYTES||!input.title||input.title!==input.title.trim()||input.title.length>512||/[\u0000-\u001f\u007f]/.test(input.title))return {status:'not_started',reason:'invalid_content'};
  const intent:YourwebsIntent={operationId:input.operationId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};if(!validYourwebsIntent(intent))throw Error('Yourwebs 发布身份无效');
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  if(deps.signal?.aborted)return {status:'unknown',intent,diagnostic:'transport',opaqueResponseSaved:false};
  const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const timeout=Math.min(60_000,Math.max(50,deps.timeoutMs??25_000)),timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.();let response:Response|undefined;
  const preserve=async(value:Response)=>{try{const late=new AbortController(),lateTimer=setTimeout(()=>late.abort(),timeout);lateTimer.unref?.();try{await persistence.persistOpaqueResponse(opaqueFrom(value,await bounded(value,late.signal),intent))}finally{clearTimeout(lateTimer)}}catch{try{await persistence.persistOpaqueResponse(opaqueFrom(value,new Uint8Array(),intent))}catch{/* The durable intent still blocks replay. */}discard(value)}};
  try{const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));response=await abortable(Promise.resolve(transport(YOURWEBS_CREATE_URL,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json','content-type':'application/json'},body:request.body})),controller.signal,value=>{void trackYourwebsPendingOperation(preserve(value)).catch(()=>undefined)});const opaque=opaqueFrom(response,await bounded(response,controller.signal),intent);try{await persistence.persistOpaqueResponse(opaque)}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:false}}const parsed=parseResponse(opaque,intent,input.html,input.title,(deps.now?.()??new Date()).getTime());if('diagnostic' in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic,opaqueResponseSaved:true};try{await persistence.promoteReceipt(parsed.receipt);return {status:'created',receipt:parsed.receipt}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}}catch(error){controller.abort();let opaqueResponseSaved=false;if(response){try{await persistence.persistOpaqueResponse(opaqueFrom(response,new Uint8Array(),intent));opaqueResponseSaved=true}catch{/* The durable intent still blocks replay. */}discard(response)}return {status:'unknown',intent,diagnostic:error instanceof BodyLimitError?'body_limit':'transport',opaqueResponseSaved}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external);if(response&&controller.signal.aborted)discard(response)}
}
