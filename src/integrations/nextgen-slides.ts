import {createHash} from 'node:crypto';

export const NEXTGEN_SLIDES_ORIGIN='https://nextgenslides.dev';
export const NEXTGEN_SLIDES_RETENTION='90 days since last visit; no guaranteed permanence or artificial keep-alive';
export const NEXTGEN_SLIDES_CREATE_URL=`${NEXTGEN_SLIDES_ORIGIN}/api/deploy`;
export const nextgenSlidesCreateUrl=(title:string)=>`${NEXTGEN_SLIDES_CREATE_URL}?${new URLSearchParams({title})}`;
export const NEXTGEN_SLIDES_MAX_CONTENT_BYTES=120_000;
export const NEXTGEN_SLIDES_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const HASH=/^[a-f0-9]{64}$/;
const OP=/^nextgenSlides_[a-f0-9]{32}$/;
const MAX_RESPONSE=64*1024;
const pendingOperations=new Set<Promise<unknown>>();

export interface NextgenSlidesIntent {operationId:string;sourceHash:string;requestHash:string;createdAt:string}
export interface NextgenSlidesReceipt extends NextgenSlidesIntent {id:string;publicUrl:string}
export interface NextgenSlidesOpaqueResponse extends NextgenSlidesIntent {version:1;kind:'nextgenSlides_opaque_response';status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string}
export interface NextgenSlidesPersistence {
  persistIntent(intent:NextgenSlidesIntent):Promise<void>;
  assertReadyToSubmit(intent:NextgenSlidesIntent):true;
  persistOpaqueResponse(response:NextgenSlidesOpaqueResponse):Promise<void>;
  loadOpaqueResponse():Promise<NextgenSlidesOpaqueResponse|undefined>;
  promoteReceipt(receipt:NextgenSlidesReceipt):Promise<void>;
}
export interface NextgenSlidesDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}
export type NextgenSlidesDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status';
export type NextgenSlidesCreateResult={status:'not_started';reason:'invalid_content'|'intent_not_persisted'|'authorization_changed'}|{status:'unknown';intent:NextgenSlidesIntent;diagnostic:NextgenSlidesDiagnostic;opaqueResponseSaved:boolean}|{status:'created';receipt:NextgenSlidesReceipt};

export const nextgenSlidesHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function trackNextgenSlidesPendingOperation<T>(pending:Promise<T>):Promise<T>{let tracked:Promise<T>;tracked=Promise.resolve(pending).then(value=>{pendingOperations.delete(tracked);return value},error=>{pendingOperations.delete(tracked);throw error});pendingOperations.add(tracked);return tracked}
export async function drainNextgenSlidesPendingOperations():Promise<void>{while(pendingOperations.size)await Promise.allSettled([...pendingOperations])}
export function nextgenSlidesPendingOperationCount(){return pendingOperations.size}
export function nextgenSlidesPublicUrl(id:string){if(!NEXTGEN_SLIDES_ID.test(id))throw Error('NextGen Slides 对象 ID 无效');return `${NEXTGEN_SLIDES_ORIGIN}/s/${id}`}
export function nextgenSlidesRequest(html:string,title:string){return {body:html,sourceHash:nextgenSlidesHash(html),requestHash:nextgenSlidesHash(`POST\n${nextgenSlidesCreateUrl(title)}\naccept:application/json\ncontent-type:text/html; charset=utf-8\n\n${html}`)}}
export function validNextgenSlidesIntent(intent:NextgenSlidesIntent){return OP.test(intent.operationId)&&HASH.test(intent.sourceHash)&&HASH.test(intent.requestHash)&&Number.isFinite(Date.parse(intent.createdAt))&&new Date(intent.createdAt).toISOString()===intent.createdAt}
function sameIntent(a:NextgenSlidesIntent,b:NextgenSlidesIntent){return a.operationId===b.operationId&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}

import {pstrsTopLevelKeys as nextgenSlidesTopLevelKeys} from './pstrs';
function parseResponse(opaque:NextgenSlidesOpaqueResponse,intent:NextgenSlidesIntent,html:string,title:string,nowMs:number):{receipt:NextgenSlidesReceipt}|{diagnostic:NextgenSlidesDiagnostic}{
  const request=nextgenSlidesRequest(html,title);if(!sameIntent(opaque,intent)||request.requestHash!==intent.requestHash||request.sourceHash!==intent.sourceHash)return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400||opaque.responseUrl&&opaque.responseUrl!==nextgenSlidesCreateUrl(title))return {diagnostic:'redirect'};
  if(opaque.status!==201)return {diagnostic:'http_status'};
  if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(opaque.bodyBase64,'base64'))}catch{return {diagnostic:'decode'}}
  const keys=nextgenSlidesTopLevelKeys(text);if(!keys)return {diagnostic:'json'};if(new Set(keys).size!==keys.length)return {diagnostic:'duplicate_field'};
  let parsed:unknown;try{parsed=JSON.parse(text)}catch{return {diagnostic:'json'}}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {diagnostic:'schema'};const value=parsed as Record<string,unknown>;
  if(Object.keys(value).sort().join(',')!=='id,updateKey,url'||typeof value.id!=='string'||!NEXTGEN_SLIDES_ID.test(value.id)||value.url!==nextgenSlidesPublicUrl(value.id)||typeof value.updateKey!=='string'||value.updateKey.length<16||value.updateKey.length>8192||/[\s\u0000-\u001f\u007f]/.test(value.updateKey))return {diagnostic:'schema'};
  if(!Number.isFinite(nowMs)||!validNextgenSlidesIntent(intent))return {diagnostic:'schema'};
  // The management capability stays only inside the encrypted opaque response.
  return {receipt:{...intent,id:value.id,publicUrl:nextgenSlidesPublicUrl(value.id)}};
}

export const parseStoredNextgenSlidesCreateResponse=parseResponse;
class BodyLimitError extends Error{}
function discard(response:Response){if(response.body&&!response.body.locked)void trackNextgenSlidesPendingOperation(response.body.cancel()).catch(()=>undefined)}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{const tracked=trackNextgenSlidesPendingOperation(pending);if(signal.aborted){void tracked.then(value=>late?.(value),()=>undefined);return Promise.reject(Error('abort'))}return new Promise((resolve,reject)=>{let done=false;const stop=()=>{if(done)return;done=true;signal.removeEventListener('abort',stop);reject(Error('abort'))};signal.addEventListener('abort',stop,{once:true});void tracked.then(value=>{signal.removeEventListener('abort',stop);if(done){late?.(value);return}done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(Error('transport'))})})}
async function bounded(response:Response,signal:AbortSignal):Promise<Uint8Array>{const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_RESPONSE))throw new BodyLimitError();if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>MAX_RESPONSE)throw new BodyLimitError();parts.push(next.value)}}finally{reader.releaseLock()}return Buffer.concat(parts.map(value=>Buffer.from(value)))}
function opaqueFrom(response:Response,bytes:Uint8Array,intent:NextgenSlidesIntent):NextgenSlidesOpaqueResponse{return {...intent,version:1,kind:'nextgenSlides_opaque_response',status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:nextgenSlidesHash(bytes)}}

export async function createNextgenSlidesPage(input:{operationId:string;html:string;title:string;reviewed:true},persistence:NextgenSlidesPersistence,deps:NextgenSlidesDependencies={}):Promise<NextgenSlidesCreateResult>{
  if(input.reviewed!==true||!OP.test(input.operationId))throw Error('NextgenSlides 缺少已审核的单次发布身份');
  if(deps.signal?.aborted)return {status:'not_started',reason:'authorization_changed'};
  const request=nextgenSlidesRequest(input.html,input.title);if(!input.html||!/^<!doctype html>/i.test(input.html)||Buffer.from(input.html,'utf8').toString('utf8')!==input.html||Buffer.byteLength(input.html,'utf8')>NEXTGEN_SLIDES_MAX_CONTENT_BYTES||!input.title||input.title!==input.title.trim()||input.title.length>512||/[\u0000-\u001f\u007f]/.test(input.title))return {status:'not_started',reason:'invalid_content'};
  const intent:NextgenSlidesIntent={operationId:input.operationId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};if(!validNextgenSlidesIntent(intent))throw Error('NextgenSlides 发布身份无效');
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  if(deps.signal?.aborted)return {status:'unknown',intent,diagnostic:'transport',opaqueResponseSaved:false};
  const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const timeout=Math.min(60_000,Math.max(50,deps.timeoutMs??25_000)),timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.();let response:Response|undefined;
  const preserve=async(value:Response)=>{try{const late=new AbortController(),lateTimer=setTimeout(()=>late.abort(),timeout);lateTimer.unref?.();try{await persistence.persistOpaqueResponse(opaqueFrom(value,await bounded(value,late.signal),intent))}finally{clearTimeout(lateTimer)}}catch{try{await persistence.persistOpaqueResponse(opaqueFrom(value,new Uint8Array(),intent))}catch{/* The durable intent still blocks replay. */}discard(value)}};
  try{const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));response=await abortable(Promise.resolve(transport(nextgenSlidesCreateUrl(input.title),{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json','content-type':'text/html; charset=utf-8'},body:request.body})),controller.signal,value=>{void trackNextgenSlidesPendingOperation(preserve(value)).catch(()=>undefined)});const opaque=opaqueFrom(response,await bounded(response,controller.signal),intent);try{await persistence.persistOpaqueResponse(opaque)}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:false}}const parsed=parseResponse(opaque,intent,input.html,input.title,(deps.now?.()??new Date()).getTime());if('diagnostic' in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic,opaqueResponseSaved:true};try{await persistence.promoteReceipt(parsed.receipt);return {status:'created',receipt:parsed.receipt}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}}catch(error){controller.abort();let opaqueResponseSaved=false;if(response){try{await persistence.persistOpaqueResponse(opaqueFrom(response,new Uint8Array(),intent));opaqueResponseSaved=true}catch{/* The durable intent still blocks replay. */}discard(response)}return {status:'unknown',intent,diagnostic:error instanceof BodyLimitError?'body_limit':'transport',opaqueResponseSaved}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external);if(response&&controller.signal.aborted)discard(response)}
}
