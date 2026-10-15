import {createHash,randomBytes as secureRandomBytes} from 'node:crypto';
import {pstrsTopLevelKeys} from './pstrs';

export const PASTYX_ORIGIN='https://pastyx.pages.dev';
export const PASTYX_CREATE_URL=`${PASTYX_ORIGIN}/api/paste`;
export const PASTYX_AUTHOR='Linkflow promotional content publisher';
export const PASTYX_MAX_CONTENT_BYTES=1_000_000;
export const PASTYX_MAX_RESPONSE_BYTES=256*1024;
export const PASTYX_MAX_HTML_BYTES=2_000_000;
export const PASTYX_ID=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,198}[A-Za-z0-9])?$/;
const EDIT_KEY=/^[A-Za-z0-9_-]{43}$/,HASH=/^[a-f0-9]{64}$/,OP=/^pastyx_[a-f0-9]{32}$/;
const pendingOperations=new Set<Promise<unknown>>();

export interface PastyXArticle {title:string;author:string;content:string}
export interface PastyXRequest {content:string;title:string;author:string;expiry:'never';editKey:string;burnAfterRead:false}
export interface PastyXIntent {operationId:string;sourceHash:string;requestHash:string;editKeyHash:string;createdAt:string}
export interface PastyXReceipt extends PastyXIntent {id:string;publicUrl:string}
export interface PastyXOpaqueResponse extends PastyXIntent {version:1;kind:'pastyx_opaque_response';capturedAt:string;status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string;bodyComplete:boolean}
export interface PastyXSecretRecord {version:1;kind:'pastyx_secret';editKey:string;intent:PastyXIntent;opaqueResponse?:PastyXOpaqueResponse}
export interface PastyXPersistence {
  persistIntent(intent:PastyXIntent,editKey:string):Promise<void>;
  assertReadyToSubmit(intent:PastyXIntent):true;
  persistOpaqueResponse(response:PastyXOpaqueResponse):Promise<void>;
  loadRecord():Promise<PastyXSecretRecord|undefined>;
  promoteReceipt(receipt:PastyXReceipt):Promise<void>;
}
export interface PastyXNativeRequest {url:string;method:'GET';resourceType:string}
export interface PastyXRenderedCandidate {selector:string;html:string;text:string;allTextVisible:boolean;links:Array<{href:string;rel:string[];text:string;visible:boolean}>}
export interface PastyXRenderedPage {url:string;documentTitle:string;headings:Array<{text:string;visible:boolean}>;bylines:Array<{text:string;visible:boolean}>;candidates:PastyXRenderedCandidate[];robots:Array<{name:string;content:string}>;responseRobots:string[];responseStatus:number;responseMediaType:string;responseBodyBytes:number;responseEncodedBodyBytes:number;canonicals:string[];hasRefresh:boolean;hasPasswordGate:boolean;hasLoginGate:boolean;nativeRequests:PastyXNativeRequest[]}
export interface PastyXRenderHooks {onBeforeRequest?:(request:PastyXNativeRequest)=>void;onResponseHeaders?:(headers:Record<string,string[]>)=>void|Promise<void>;onScreenshot?:(png:Uint8Array)=>void|Promise<void>}
export interface PastyXDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date;randomBytes?:(size:number)=>Uint8Array;renderPage?:(url:string,signal:AbortSignal,hooks?:PastyXRenderHooks)=>Promise<PastyXRenderedPage>}
export type PastyXDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status';
export type PastyXCreateResult={status:'not_started';reason:'invalid_content'|'intent_not_persisted'|'authorization_changed'}|{status:'unknown';intent:PastyXIntent;diagnostic:PastyXDiagnostic;opaqueResponseSaved:boolean}|{status:'created';receipt:PastyXReceipt};

export const pastyxHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function trackPastyXPendingOperation<T>(pending:Promise<T>):Promise<T>{let tracked:Promise<T>;tracked=Promise.resolve(pending).then(value=>{pendingOperations.delete(tracked);return value},error=>{pendingOperations.delete(tracked);throw error});pendingOperations.add(tracked);return tracked}
export async function drainPastyXPendingOperations(timeoutMs=30_000):Promise<boolean>{const deadline=Date.now()+Math.max(0,timeoutMs);while(pendingOperations.size&&Date.now()<deadline)await Promise.race([Promise.allSettled([...pendingOperations]),new Promise(resolve=>setTimeout(resolve,Math.max(1,Math.min(100,deadline-Date.now()))))]);return pendingOperations.size===0}
export function pastyxPendingOperationCount(){return pendingOperations.size}
export function validPastyXEditKey(value:unknown):value is string{return typeof value==='string'&&EDIT_KEY.test(value)}
export function pastyxPublicUrl(id:string){if(!PASTYX_ID.test(id))throw Error('PastyX 页面身份无效');return `${PASTYX_ORIGIN}/${id}`}
export function pastyxApiUrl(id:string){if(!PASTYX_ID.test(id))throw Error('PastyX 页面身份无效');return `${PASTYX_CREATE_URL}/${id}`}
export function pastyxRequest(article:PastyXArticle,editKey:string){
  const value:PastyXRequest={content:article.content,title:article.title,author:article.author,expiry:'never',editKey,burnAfterRead:false},body=JSON.stringify(value);
  const sourceHash=pastyxHash(JSON.stringify([article.title,article.author,article.content,'never',false]));
  return {value,body,sourceHash,editKeyHash:pastyxHash(editKey),requestHash:pastyxHash(`POST\n${PASTYX_CREATE_URL}\naccept:application/json\ncontent-type:application/json\n\n${body}`)};
}
function exactDate(value:string){return Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value}
export function validPastyXIntent(value:PastyXIntent){return OP.test(value.operationId)&&HASH.test(value.sourceHash)&&HASH.test(value.requestHash)&&HASH.test(value.editKeyHash)&&exactDate(value.createdAt)}
export function samePastyXIntent(a:PastyXIntent,b:PastyXIntent){return a.operationId===b.operationId&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.editKeyHash===b.editKeyHash&&a.createdAt===b.createdAt}

export function parseStoredPastyXCreateResponse(opaque:PastyXOpaqueResponse,intent:PastyXIntent,article:PastyXArticle,editKey:string):{receipt:PastyXReceipt}|{diagnostic:PastyXDiagnostic}{
  const request=pastyxRequest(article,editKey),bytes=Buffer.from(opaque.bodyBase64,'base64');
  if(!samePastyXIntent(opaque,intent)||request.sourceHash!==intent.sourceHash||request.requestHash!==intent.requestHash||request.editKeyHash!==intent.editKeyHash||bytes.toString('base64')!==opaque.bodyBase64||pastyxHash(bytes)!==opaque.bodySha256||!opaque.bodyComplete)return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400||opaque.responseUrl&&opaque.responseUrl!==PASTYX_CREATE_URL)return {diagnostic:'redirect'};
  if(opaque.status!==200&&opaque.status!==201)return {diagnostic:'http_status'};
  if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}catch{return {diagnostic:'decode'}}
  const keys=pstrsTopLevelKeys(text);if(!keys)return {diagnostic:'json'};if(new Set(keys).size!==keys.length)return {diagnostic:'duplicate_field'};
  let parsed:unknown;try{parsed=JSON.parse(text)}catch{return {diagnostic:'json'}}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed).sort().join(',')!=='author,expiresAt,hasEditKey,hasPassword,id,title,url')return {diagnostic:'schema'};
  const value=parsed as Record<string,unknown>;
  if(typeof value.id!=='string'||!PASTYX_ID.test(value.id)||value.title!==article.title||value.author!==article.author||value.expiresAt!==null||value.hasPassword!==false||value.hasEditKey!==true||value.url!==pastyxPublicUrl(value.id))return {diagnostic:'schema'};
  const created=Date.parse(intent.createdAt),captured=Date.parse(opaque.capturedAt);if(!exactDate(opaque.capturedAt)||captured<created-300_000||captured>created+300_000)return {diagnostic:'schema'};
  return {receipt:{...intent,id:value.id,publicUrl:pastyxPublicUrl(value.id)}};
}

class BodyReadError extends Error{constructor(readonly bytes:Uint8Array,readonly limit=false){super(limit?'body_limit':'transport')}}
class BodyLimitError extends BodyReadError{constructor(bytes=new Uint8Array()){super(bytes,true)}}
function discard(response:Response){if(response.body&&!response.body.locked)void trackPastyXPendingOperation(response.body.cancel()).catch(()=>undefined)}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{const tracked=trackPastyXPendingOperation(pending);if(signal.aborted){void tracked.then(value=>late?.(value),()=>undefined);return Promise.reject(Error('abort'))}return new Promise((resolve,reject)=>{let done=false;const stop=()=>{if(done)return;done=true;signal.removeEventListener('abort',stop);reject(Error('abort'))};signal.addEventListener('abort',stop,{once:true});void tracked.then(value=>{signal.removeEventListener('abort',stop);if(done){late?.(value);return}done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(Error('transport'))})})}
async function bounded(response:Response,signal:AbortSignal){const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>PASTYX_MAX_RESPONSE_BYTES))throw new BodyLimitError();if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Buffer[]=[];let size=0;try{for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;const chunk=Buffer.from(next.value),remaining=PASTYX_MAX_RESPONSE_BYTES-size;if(chunk.length>remaining){if(remaining>0)parts.push(chunk.subarray(0,remaining));throw new BodyLimitError(Buffer.concat(parts))}parts.push(chunk);size+=chunk.length}return Buffer.concat(parts)}catch(error){if(error instanceof BodyReadError)throw error;throw new BodyReadError(Buffer.concat(parts))}finally{try{reader.releaseLock()}catch{}}}
function opaqueFrom(response:Response,bytes:Uint8Array,intent:PastyXIntent,now:()=>Date,bodyComplete=true):PastyXOpaqueResponse{return {...intent,version:1,kind:'pastyx_opaque_response',capturedAt:now().toISOString(),status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:pastyxHash(bytes),bodyComplete}}

export async function createPastyXPaste(input:{operationId:string;article:PastyXArticle;reviewed:true},persistence:PastyXPersistence,deps:PastyXDependencies={}):Promise<PastyXCreateResult>{
  if(input.reviewed!==true||!OP.test(input.operationId))throw Error('PastyX 缺少已审核的单次发布身份');if(deps.signal?.aborted)return {status:'not_started',reason:'authorization_changed'};
  const validUtf8=(value:string,max:number)=>Buffer.from(value,'utf8').toString('utf8')===value&&Buffer.byteLength(value,'utf8')<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),trimmed=(value:string,max:number)=>value===value.trim()&&validUtf8(value,max),article=input.article;
  if(!article.title||[...article.title].length>200||!trimmed(article.title,1000)||!article.author||[...article.author].length>120||!trimmed(article.author,1000)||!article.content.trim()||!validUtf8(article.content,PASTYX_MAX_CONTENT_BYTES))return {status:'not_started',reason:'invalid_content'};
  const generated=deps.randomBytes?.(32)??secureRandomBytes(32),editKey=Buffer.from(generated).toString('base64url');if(generated.byteLength!==32||!validPastyXEditKey(editKey))throw Error('PastyX 编辑密钥生成失败');
  const now=deps.now??(()=>new Date()),request=pastyxRequest(article,editKey),intent:PastyXIntent={operationId:input.operationId,sourceHash:request.sourceHash,requestHash:request.requestHash,editKeyHash:request.editKeyHash,createdAt:now().toISOString()};if(!validPastyXIntent(intent))throw Error('PastyX 发布身份无效');
  try{await persistence.persistIntent(intent,editKey)}catch{return {status:'not_started',reason:'intent_not_persisted'}}try{if(persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  if(deps.signal?.aborted)return {status:'unknown',intent,diagnostic:'transport',opaqueResponseSaved:false};const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const timeout=Math.min(60_000,Math.max(50,deps.timeoutMs??25_000)),timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.();let response:Response|undefined,responseBytes:Uint8Array|undefined;
  const preserve=async(value:Response)=>{let captured:Uint8Array|undefined;try{const late=new AbortController(),lateTimer=setTimeout(()=>late.abort(),timeout);lateTimer.unref?.();try{captured=await bounded(value,late.signal);await persistence.persistOpaqueResponse(opaqueFrom(value,captured,intent,now))}finally{clearTimeout(lateTimer)}}catch(error){try{await persistence.persistOpaqueResponse(opaqueFrom(value,error instanceof BodyReadError?error.bytes:new Uint8Array(),intent,now,false))}catch{}discard(value)}};
  try{const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));response=await abortable(Promise.resolve(transport(PASTYX_CREATE_URL,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json','content-type':'application/json'},body:request.body})),controller.signal,value=>{void trackPastyXPendingOperation(preserve(value)).catch(()=>undefined)});responseBytes=await bounded(response,controller.signal);const opaque=opaqueFrom(response,responseBytes,intent,now);try{await persistence.persistOpaqueResponse(opaque)}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:false}}const parsed=parseStoredPastyXCreateResponse(opaque,intent,article,editKey);if('diagnostic'in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic,opaqueResponseSaved:true};try{await persistence.promoteReceipt(parsed.receipt);return {status:'created',receipt:parsed.receipt}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}}catch(error){controller.abort();let saved=false;if(response&&responseBytes===undefined){try{await persistence.persistOpaqueResponse(opaqueFrom(response,error instanceof BodyReadError?error.bytes:new Uint8Array(),intent,now,false));saved=true}catch{}discard(response)}return {status:'unknown',intent,diagnostic:error instanceof BodyLimitError?'body_limit':'transport',opaqueResponseSaved:saved}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external);if(response&&controller.signal.aborted)discard(response)}
}

export const pastyxTesting={EDIT_KEY,OP,exactDate};
