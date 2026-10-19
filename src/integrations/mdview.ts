import {createHash} from 'node:crypto';
import {pstrsTopLevelKeys} from './pstrs';

export const MDVIEW_ORIGIN='https://mdview.io';
export const MDVIEW_CREATE_URL=`${MDVIEW_ORIGIN}/api/public/publish`;
export const MDVIEW_EXPIRES_DAYS=30;
export const MDVIEW_MAX_CONTENT_BYTES=120_000;
export const MDVIEW_MAX_RESPONSE_BYTES=256*1024;
export const MDVIEW_MAX_HTML_BYTES=2_000_000;
export const MDVIEW_SHORT_ID=/^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
export const MDVIEW_DOCUMENT_ID=/^[A-Za-z0-9_-]{1,128}$/;
const HASH=/^[a-f0-9]{64}$/,OP=/^mdview_[a-f0-9]{32}$/;
const pendingOperations=new Set<Promise<unknown>>();

export interface MDViewIntent {operationId:string;sourceHash:string;requestHash:string;createdAt:string}
export interface MDViewReceipt extends MDViewIntent {documentId:string;shortId:string;publicUrl:string;markdownUrl:string;expiresAt:number}
export interface MDViewOpaqueResponse extends MDViewIntent {version:1;kind:'mdview_opaque_response';capturedAt:string;status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string;bodyComplete:boolean}
export interface MDViewPersistence {
  persistIntent(intent:MDViewIntent):Promise<void>;
  assertReadyToSubmit(intent:MDViewIntent):true;
  persistOpaqueResponse(response:MDViewOpaqueResponse):Promise<void>;
  loadOpaqueResponse():Promise<MDViewOpaqueResponse|undefined>;
  promoteReceipt(receipt:MDViewReceipt):Promise<void>;
}
export interface MDViewNativeRequest {url:string;method:'GET';resourceType:string}
export interface MDViewRenderedPage {url:string;title:string;articleText:string;articleHtml:string;allArticleTextVisible:boolean;links:Array<{href:string;rel:string[];text:string;visible:boolean}>;robots:Array<{name:string;content:string}>;responseRobots:string[];responseStatus:number;responseMediaType:string;responseBodyBytes:number;responseEncodedBodyBytes:number;canonicals:string[];hasRefresh:boolean;hasPasswordGate:boolean;hasLoginGate:boolean;nativeRequests:MDViewNativeRequest[]}
export interface MDViewRenderHooks {onBeforeRequest?:(request:MDViewNativeRequest)=>void;onResponseHeaders?:(headers:Record<string,string[]>)=>void|Promise<void>;onScreenshot?:(png:Uint8Array)=>void|Promise<void>}
export interface MDViewDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date;renderPage?:(url:string,signal:AbortSignal,hooks?:MDViewRenderHooks)=>Promise<MDViewRenderedPage>}
export type MDViewDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status';
export type MDViewCreateResult={status:'not_started';reason:'invalid_content'|'intent_not_persisted'|'authorization_changed'}|{status:'unknown';intent:MDViewIntent;diagnostic:MDViewDiagnostic;opaqueResponseSaved:boolean}|{status:'created';receipt:MDViewReceipt};

export const mdviewHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function trackMDViewPendingOperation<T>(pending:Promise<T>):Promise<T>{let tracked:Promise<T>;tracked=Promise.resolve(pending).then(value=>{pendingOperations.delete(tracked);return value},error=>{pendingOperations.delete(tracked);throw error});pendingOperations.add(tracked);return tracked}
export async function drainMDViewPendingOperations(timeoutMs=30_000):Promise<boolean>{const deadline=Date.now()+Math.max(0,timeoutMs);while(pendingOperations.size&&Date.now()<deadline)await Promise.race([Promise.allSettled([...pendingOperations]),new Promise(resolve=>setTimeout(resolve,Math.max(1,Math.min(100,deadline-Date.now()))))]);return pendingOperations.size===0}
export function mdviewPendingOperationCount(){return pendingOperations.size}
export function mdviewPublicUrl(shortId:string){if(!MDVIEW_SHORT_ID.test(shortId))throw Error('MDView 短链接标识无效');return `${MDVIEW_ORIGIN}/s/${shortId}`}
export function mdviewMarkdownUrl(shortId:string){return `${mdviewPublicUrl(shortId)}.md`}
export function mdviewApiUrl(shortId:string){if(!MDVIEW_SHORT_ID.test(shortId))throw Error('MDView 短链接标识无效');return `${MDVIEW_ORIGIN}/api/shares/${shortId}`}
export function mdviewRequest(title:string,content:string){const body=JSON.stringify({title,content,expiresInDays:MDVIEW_EXPIRES_DAYS});return {body,sourceHash:mdviewHash(`${title}\n\0${content}`),requestHash:mdviewHash(`POST\n${MDVIEW_CREATE_URL}\naccept:application/json\ncontent-type:application/json\n\n${body}`)}}
function exactDate(value:string){return Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value}
export function validMDViewIntent(value:MDViewIntent){return OP.test(value.operationId)&&HASH.test(value.sourceHash)&&HASH.test(value.requestHash)&&exactDate(value.createdAt)}
function sameIntent(a:MDViewIntent,b:MDViewIntent){return a.operationId===b.operationId&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}

export function parseStoredMDViewCreateResponse(opaque:MDViewOpaqueResponse,intent:MDViewIntent,title:string,content:string):{receipt:MDViewReceipt}|{diagnostic:MDViewDiagnostic}{
  const request=mdviewRequest(title,content),bytes=Buffer.from(opaque.bodyBase64,'base64');
  if(!sameIntent(opaque,intent)||request.sourceHash!==intent.sourceHash||request.requestHash!==intent.requestHash||bytes.toString('base64')!==opaque.bodyBase64||mdviewHash(bytes)!==opaque.bodySha256||!opaque.bodyComplete)return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400||opaque.responseUrl&&opaque.responseUrl!==MDVIEW_CREATE_URL)return {diagnostic:'redirect'};
  if(opaque.status<200||opaque.status>=300)return {diagnostic:'http_status'};
  if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}catch{return {diagnostic:'decode'}}
  const keys=pstrsTopLevelKeys(text);if(!keys)return {diagnostic:'json'};if(new Set(keys).size!==keys.length)return {diagnostic:'duplicate_field'};
  let parsed:unknown;try{parsed=JSON.parse(text)}catch{return {diagnostic:'json'}}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed).sort().join(',')!=='contentSize,documentId,expiresAt,markdownUrl,shareUrl,shortId,title,viewerUrl')return {diagnostic:'schema'};
  const value=parsed as Record<string,unknown>;
  if(typeof value.documentId!=='string'||!MDVIEW_DOCUMENT_ID.test(value.documentId)||typeof value.shortId!=='string'||!MDVIEW_SHORT_ID.test(value.shortId)||value.title!==title||value.viewerUrl!==mdviewPublicUrl(value.shortId)||value.shareUrl!==value.viewerUrl||value.markdownUrl!==mdviewMarkdownUrl(value.shortId)||typeof value.expiresAt!=='string'||!exactDate(value.expiresAt)||!Number.isSafeInteger(value.contentSize)||Number(value.contentSize)<0||Number(value.contentSize)>2_000_000)return {diagnostic:'schema'};
  const created=Date.parse(intent.createdAt),captured=Date.parse(opaque.capturedAt),expires=Date.parse(value.expiresAt);if(!exactDate(opaque.capturedAt)||captured<created-300_000||captured>created+300_000||expires<captured+14*86_400_000||expires>created+31*86_400_000+300_000)return {diagnostic:'schema'};
  return {receipt:{...intent,documentId:value.documentId,shortId:value.shortId,publicUrl:mdviewPublicUrl(value.shortId),markdownUrl:mdviewMarkdownUrl(value.shortId),expiresAt:expires}};
}

class BodyReadError extends Error{constructor(readonly bytes:Uint8Array,readonly limit=false){super(limit?'body_limit':'transport')}}
class BodyLimitError extends BodyReadError{constructor(bytes=new Uint8Array()){super(bytes,true)}}
function discard(response:Response){if(response.body&&!response.body.locked)void trackMDViewPendingOperation(response.body.cancel()).catch(()=>undefined)}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{const tracked=trackMDViewPendingOperation(pending);if(signal.aborted){void tracked.then(value=>late?.(value),()=>undefined);return Promise.reject(Error('abort'))}return new Promise((resolve,reject)=>{let done=false;const stop=()=>{if(done)return;done=true;signal.removeEventListener('abort',stop);reject(Error('abort'))};signal.addEventListener('abort',stop,{once:true});void tracked.then(value=>{signal.removeEventListener('abort',stop);if(done){late?.(value);return}done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(Error('transport'))})})}
async function bounded(response:Response,signal:AbortSignal){const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MDVIEW_MAX_RESPONSE_BYTES))throw new BodyLimitError();if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Buffer[]=[];let size=0;try{for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;const chunk=Buffer.from(next.value),remaining=MDVIEW_MAX_RESPONSE_BYTES-size;if(chunk.length>remaining){if(remaining>0)parts.push(chunk.subarray(0,remaining));throw new BodyLimitError(Buffer.concat(parts))}parts.push(chunk);size+=chunk.length}return Buffer.concat(parts)}catch(error){if(error instanceof BodyReadError)throw error;throw new BodyReadError(Buffer.concat(parts))}finally{try{reader.releaseLock()}catch{}}}
function opaqueFrom(response:Response,bytes:Uint8Array,intent:MDViewIntent,now:()=>Date,bodyComplete=true):MDViewOpaqueResponse{return {...intent,version:1,kind:'mdview_opaque_response',capturedAt:now().toISOString(),status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:mdviewHash(bytes),bodyComplete}}

export async function createMDViewPage(input:{operationId:string;title:string;content:string;reviewed:true},persistence:MDViewPersistence,deps:MDViewDependencies={}):Promise<MDViewCreateResult>{
  if(input.reviewed!==true||!OP.test(input.operationId))throw Error('MDView 缺少已审核的单次发布编号');if(deps.signal?.aborted)return {status:'not_started',reason:'authorization_changed'};
  const request=mdviewRequest(input.title,input.content);if(!input.title||input.title!==input.title.trim()||[...input.title].length>200||/[\r\n\u0000-\u001f\u007f]/u.test(input.title)||!input.content||input.content!==input.content.trim()||Buffer.from(input.content,'utf8').toString('utf8')!==input.content||Buffer.byteLength(input.content,'utf8')>MDVIEW_MAX_CONTENT_BYTES)return {status:'not_started',reason:'invalid_content'};
  const now=deps.now??(()=>new Date()),intent:MDViewIntent={operationId:input.operationId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:now().toISOString()};if(!validMDViewIntent(intent))throw Error('MDView 提交信息无效');
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}try{if(persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  if(deps.signal?.aborted)return {status:'unknown',intent,diagnostic:'transport',opaqueResponseSaved:false};const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const timeout=Math.min(60_000,Math.max(50,deps.timeoutMs??25_000)),timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.();let response:Response|undefined,responseBytes:Uint8Array|undefined;
  const preserve=async(value:Response)=>{let captured:Uint8Array|undefined;try{const late=new AbortController(),lateTimer=setTimeout(()=>late.abort(),timeout);lateTimer.unref?.();try{captured=await bounded(value,late.signal);await persistence.persistOpaqueResponse(opaqueFrom(value,captured,intent,now))}finally{clearTimeout(lateTimer)}}catch(error){try{await persistence.persistOpaqueResponse(opaqueFrom(value,error instanceof BodyReadError?error.bytes:new Uint8Array(),intent,now,false))}catch{}discard(value)}};
  try{const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));response=await abortable(Promise.resolve(transport(MDVIEW_CREATE_URL,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json','content-type':'application/json'},body:request.body})),controller.signal,value=>{void trackMDViewPendingOperation(preserve(value)).catch(()=>undefined)});responseBytes=await bounded(response,controller.signal);const opaque=opaqueFrom(response,responseBytes,intent,now);try{await persistence.persistOpaqueResponse(opaque)}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:false}}const parsed=parseStoredMDViewCreateResponse(opaque,intent,input.title,input.content);if('diagnostic'in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic,opaqueResponseSaved:true};try{await persistence.promoteReceipt(parsed.receipt);return {status:'created',receipt:parsed.receipt}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}}catch(error){controller.abort();let saved=false;if(response&&responseBytes===undefined){try{await persistence.persistOpaqueResponse(opaqueFrom(response,error instanceof BodyReadError?error.bytes:new Uint8Array(),intent,now,false));saved=true}catch{}discard(response)}return {status:'unknown',intent,diagnostic:error instanceof BodyLimitError?'body_limit':'transport',opaqueResponseSaved:saved}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external);if(response&&controller.signal.aborted)discard(response)}
}
