import {createHash} from 'node:crypto';
import {pstrsTopLevelKeys} from './pstrs';

export const TXTSBS_ORIGIN='https://txt.sbs';
export const TXTSBS_CREATE_URL=`${TXTSBS_ORIGIN}/publish.php`;
export const TXTSBS_AUTHOR='AI assistant involved in Linkflow development';
export const TXTSBS_MAX_CONTENT_BYTES=120_000;
export const TXTSBS_MAX_RESPONSE_BYTES=256*1024;
export const TXTSBS_MAX_HTML_BYTES=2_000_000;
export const TXTSBS_ID=/^[A-Za-z0-9]{5}$/;
export const TXTSBS_SECRET=/^[A-Za-z0-9._~-]{1,512}$/;
const HASH=/^[a-f0-9]{64}$/,OP=/^txtsbs_[a-f0-9]{32}$/;
const pendingOperations=new Set<Promise<unknown>>();

export interface TxtSbsIntent {operationId:string;sourceHash:string;requestHash:string;createdAt:string}
export interface TxtSbsReceipt extends TxtSbsIntent {id:string;publicUrl:string}
export interface TxtSbsOpaqueResponse extends TxtSbsIntent {version:1;kind:'txtsbs_opaque_response';capturedAt:string;status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string;bodyComplete:boolean}
export interface TxtSbsPersistence {
  persistIntent(intent:TxtSbsIntent):Promise<void>;
  assertReadyToSubmit(intent:TxtSbsIntent):true;
  persistOpaqueResponse(response:TxtSbsOpaqueResponse):Promise<void>;
  loadOpaqueResponse():Promise<TxtSbsOpaqueResponse|undefined>;
  promoteReceipt(receipt:TxtSbsReceipt):Promise<void>;
}
export interface TxtSbsNativeRequest {url:string;method:'GET';resourceType:string}
export interface TxtSbsRenderedPage {url:string;documentTitle:string;titleText:string;abstractText:string;authorText:string;articleText:string;articleHtml:string;allMetadataTextVisible:boolean;allArticleTextVisible:boolean;links:Array<{href:string;rel:string[];text:string;visible:boolean}>;robots:Array<{name:string;content:string}>;responseRobots:string[];responseStatus:number;responseMediaType:string;responseBodyBytes:number;responseEncodedBodyBytes:number;canonicals:string[];hasRefresh:boolean;hasPasswordGate:boolean;hasLoginGate:boolean;nativeRequests:TxtSbsNativeRequest[]}
export interface TxtSbsRenderHooks {onBeforeRequest?:(request:TxtSbsNativeRequest)=>void;onResponseHeaders?:(headers:Record<string,string[]>)=>void|Promise<void>;onScreenshot?:(png:Uint8Array)=>void|Promise<void>}
export interface TxtSbsDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date;renderPage?:(url:string,signal:AbortSignal,hooks?:TxtSbsRenderHooks)=>Promise<TxtSbsRenderedPage>}
export type TxtSbsDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status';
export type TxtSbsCreateResult={status:'not_started';reason:'invalid_content'|'intent_not_persisted'|'authorization_changed'}|{status:'unknown';intent:TxtSbsIntent;diagnostic:TxtSbsDiagnostic;opaqueResponseSaved:boolean}|{status:'created';receipt:TxtSbsReceipt};
export interface TxtSbsArticle {title:string;abstract:string;author:string;content:string;showDate:true;showSerp:true}

export const txtsbsHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function trackTxtSbsPendingOperation<T>(pending:Promise<T>):Promise<T>{let tracked:Promise<T>;tracked=Promise.resolve(pending).then(value=>{pendingOperations.delete(tracked);return value},error=>{pendingOperations.delete(tracked);throw error});pendingOperations.add(tracked);return tracked}
export async function drainTxtSbsPendingOperations(timeoutMs=30_000):Promise<boolean>{const deadline=Date.now()+Math.max(0,timeoutMs);while(pendingOperations.size&&Date.now()<deadline)await Promise.race([Promise.allSettled([...pendingOperations]),new Promise(resolve=>setTimeout(resolve,Math.max(1,Math.min(100,deadline-Date.now()))))]);return pendingOperations.size===0}
export function txtsbsPendingOperationCount(){return pendingOperations.size}
export function txtsbsPublicUrl(id:string){if(!TXTSBS_ID.test(id))throw Error('txt.sbs 页面身份无效');return `${TXTSBS_ORIGIN}/${id}`}
export function txtsbsRequest(article:TxtSbsArticle){
  const body=new URLSearchParams({title:article.title,content:article.content,author:article.author,show_date:String(article.showDate),abstract:article.abstract,ajax:'1',show_serp:String(article.showSerp)}).toString();
  const source=JSON.stringify([article.title,article.abstract,article.author,article.content,article.showDate,article.showSerp]);
  return {body,sourceHash:txtsbsHash(source),requestHash:txtsbsHash(`POST\n${TXTSBS_CREATE_URL}\naccept:application/json\ncontent-type:application/x-www-form-urlencoded\n\n${body}`)};
}
function exactDate(value:string){return Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value}
export function validTxtSbsIntent(value:TxtSbsIntent){return OP.test(value.operationId)&&HASH.test(value.sourceHash)&&HASH.test(value.requestHash)&&exactDate(value.createdAt)}
function sameIntent(a:TxtSbsIntent,b:TxtSbsIntent){return a.operationId===b.operationId&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}

export function parseStoredTxtSbsCreateResponse(opaque:TxtSbsOpaqueResponse,intent:TxtSbsIntent,article:TxtSbsArticle):{receipt:TxtSbsReceipt;secret:string}|{diagnostic:TxtSbsDiagnostic}{
  const request=txtsbsRequest(article),bytes=Buffer.from(opaque.bodyBase64,'base64');
  if(!sameIntent(opaque,intent)||request.sourceHash!==intent.sourceHash||request.requestHash!==intent.requestHash||bytes.toString('base64')!==opaque.bodyBase64||txtsbsHash(bytes)!==opaque.bodySha256||!opaque.bodyComplete)return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400||opaque.responseUrl&&opaque.responseUrl!==TXTSBS_CREATE_URL)return {diagnostic:'redirect'};
  if(opaque.status!==200)return {diagnostic:'http_status'};
  // The publishing endpoint also labels its JSON receipt as text/html.
  const mediaType=opaque.contentType.split(';',1)[0].trim().toLowerCase();
  if(mediaType!=='application/json'&&mediaType!=='text/html')return {diagnostic:'media_type'};
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}catch{return {diagnostic:'decode'}}
  const keys=pstrsTopLevelKeys(text);if(!keys)return {diagnostic:'json'};if(new Set(keys).size!==keys.length)return {diagnostic:'duplicate_field'};
  let parsed:unknown;try{parsed=JSON.parse(text)}catch{return {diagnostic:'json'}}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed).sort().join(',')!=='id,secret')return {diagnostic:'schema'};
  const value=parsed as Record<string,unknown>;
  if(typeof value.id!=='string'||!TXTSBS_ID.test(value.id)||typeof value.secret!=='string'||!TXTSBS_SECRET.test(value.secret))return {diagnostic:'schema'};
  const created=Date.parse(intent.createdAt),captured=Date.parse(opaque.capturedAt);if(!exactDate(opaque.capturedAt)||captured<created-300_000||captured>created+300_000)return {diagnostic:'schema'};
  return {receipt:{...intent,id:value.id,publicUrl:txtsbsPublicUrl(value.id)},secret:value.secret};
}

class BodyReadError extends Error{constructor(readonly bytes:Uint8Array,readonly limit=false){super(limit?'body_limit':'transport')}}
class BodyLimitError extends BodyReadError{constructor(bytes=new Uint8Array()){super(bytes,true)}}
function discard(response:Response){if(response.body&&!response.body.locked)void trackTxtSbsPendingOperation(response.body.cancel()).catch(()=>undefined)}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{const tracked=trackTxtSbsPendingOperation(pending);if(signal.aborted){void tracked.then(value=>late?.(value),()=>undefined);return Promise.reject(Error('abort'))}return new Promise((resolve,reject)=>{let done=false;const stop=()=>{if(done)return;done=true;signal.removeEventListener('abort',stop);reject(Error('abort'))};signal.addEventListener('abort',stop,{once:true});void tracked.then(value=>{signal.removeEventListener('abort',stop);if(done){late?.(value);return}done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(Error('transport'))})})}
async function bounded(response:Response,signal:AbortSignal){const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>TXTSBS_MAX_RESPONSE_BYTES))throw new BodyLimitError();if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Buffer[]=[];let size=0;try{for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;const chunk=Buffer.from(next.value),remaining=TXTSBS_MAX_RESPONSE_BYTES-size;if(chunk.length>remaining){if(remaining>0)parts.push(chunk.subarray(0,remaining));throw new BodyLimitError(Buffer.concat(parts))}parts.push(chunk);size+=chunk.length}return Buffer.concat(parts)}catch(error){if(error instanceof BodyReadError)throw error;throw new BodyReadError(Buffer.concat(parts))}finally{try{reader.releaseLock()}catch{}}}
function opaqueFrom(response:Response,bytes:Uint8Array,intent:TxtSbsIntent,now:()=>Date,bodyComplete=true):TxtSbsOpaqueResponse{return {...intent,version:1,kind:'txtsbs_opaque_response',capturedAt:now().toISOString(),status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:txtsbsHash(bytes),bodyComplete}}

export async function createTxtSbsPage(input:{operationId:string;article:TxtSbsArticle;reviewed:true},persistence:TxtSbsPersistence,deps:TxtSbsDependencies={}):Promise<TxtSbsCreateResult>{
  if(input.reviewed!==true||!OP.test(input.operationId))throw Error('txt.sbs 缺少已审核的单次发布身份');if(deps.signal?.aborted)return {status:'not_started',reason:'authorization_changed'};
  const article=input.article,request=txtsbsRequest(article),validUtf8=(value:string,max:number)=>Buffer.from(value,'utf8').toString('utf8')===value&&Buffer.byteLength(value,'utf8')<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),trimmed=(value:string,max:number)=>value===value.trim()&&validUtf8(value,max);
  if(!article.title||![...article.title].length||[...article.title].length>200||!trimmed(article.title,1000)||!trimmed(article.abstract,4000)||!article.author||[...article.author].length>120||!trimmed(article.author,1000)||!article.content.trim()||!validUtf8(article.content,TXTSBS_MAX_CONTENT_BYTES)||article.showDate!==true||article.showSerp!==true)return {status:'not_started',reason:'invalid_content'};
  const now=deps.now??(()=>new Date()),intent:TxtSbsIntent={operationId:input.operationId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:now().toISOString()};if(!validTxtSbsIntent(intent))throw Error('txt.sbs 发布身份无效');
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}try{if(persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  if(deps.signal?.aborted)return {status:'unknown',intent,diagnostic:'transport',opaqueResponseSaved:false};const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const timeout=Math.min(60_000,Math.max(50,deps.timeoutMs??25_000)),timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.();let response:Response|undefined,responseBytes:Uint8Array|undefined;
  const preserve=async(value:Response)=>{let captured:Uint8Array|undefined;try{const late=new AbortController(),lateTimer=setTimeout(()=>late.abort(),timeout);lateTimer.unref?.();try{captured=await bounded(value,late.signal);await persistence.persistOpaqueResponse(opaqueFrom(value,captured,intent,now))}finally{clearTimeout(lateTimer)}}catch(error){try{await persistence.persistOpaqueResponse(opaqueFrom(value,error instanceof BodyReadError?error.bytes:new Uint8Array(),intent,now,false))}catch{}discard(value)}};
  try{const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));response=await abortable(Promise.resolve(transport(TXTSBS_CREATE_URL,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},body:request.body})),controller.signal,value=>{void trackTxtSbsPendingOperation(preserve(value)).catch(()=>undefined)});responseBytes=await bounded(response,controller.signal);const opaque=opaqueFrom(response,responseBytes,intent,now);try{await persistence.persistOpaqueResponse(opaque)}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:false}}const parsed=parseStoredTxtSbsCreateResponse(opaque,intent,article);if('diagnostic'in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic,opaqueResponseSaved:true};try{await persistence.promoteReceipt(parsed.receipt);return {status:'created',receipt:parsed.receipt}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}}catch(error){controller.abort();let saved=false;if(response&&responseBytes===undefined){try{await persistence.persistOpaqueResponse(opaqueFrom(response,error instanceof BodyReadError?error.bytes:new Uint8Array(),intent,now,false));saved=true}catch{}discard(response)}return {status:'unknown',intent,diagnostic:error instanceof BodyLimitError?'body_limit':'transport',opaqueResponseSaved:saved}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external);if(response&&controller.signal.aborted)discard(response)}
}
