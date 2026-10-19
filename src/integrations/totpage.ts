import {createHash} from 'node:crypto';

export const TOTPAGE_ORIGIN='https://tot.page';
export const TOTPAGE_RETENTION='No verified retention guarantee; anyone with the open link can edit or delete the page';
export const TOTPAGE_CREATE_URL='https://api.tot.page/v1/documents';
export const totpageCreateUrl=(_title:string)=>TOTPAGE_CREATE_URL;
export const TOTPAGE_MAX_CONTENT_BYTES=120_000;
export const TOTPAGE_ID=/^[A-Za-z0-9_-]{22}$/;
const HASH=/^[a-f0-9]{64}$/;
const OP=/^totpage_[a-f0-9]{32}$/;
const MAX_RESPONSE=256*1024;
const pendingOperations=new Set<Promise<unknown>>();

export interface TotpageIntent {operationId:string;sourceHash:string;requestHash:string;createdAt:string}
export interface TotpageReceipt extends TotpageIntent {id:string;publicUrl:string}
export interface TotpageOpaqueResponse extends TotpageIntent {version:1;kind:'totpage_opaque_response';status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string}
export interface TotpagePersistence {
  persistIntent(intent:TotpageIntent):Promise<void>;
  assertReadyToSubmit(intent:TotpageIntent):true;
  persistOpaqueResponse(response:TotpageOpaqueResponse):Promise<void>;
  loadOpaqueResponse():Promise<TotpageOpaqueResponse|undefined>;
  promoteReceipt(receipt:TotpageReceipt):Promise<void>;
}
export interface TotpageDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}
export type TotpageDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status';
export type TotpageCreateResult={status:'not_started';reason:'invalid_content'|'intent_not_persisted'|'authorization_changed'}|{status:'unknown';intent:TotpageIntent;diagnostic:TotpageDiagnostic;opaqueResponseSaved:boolean}|{status:'created';receipt:TotpageReceipt};

export const totpageHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function trackTotpagePendingOperation<T>(pending:Promise<T>):Promise<T>{let tracked:Promise<T>;tracked=Promise.resolve(pending).then(value=>{pendingOperations.delete(tracked);return value},error=>{pendingOperations.delete(tracked);throw error});pendingOperations.add(tracked);return tracked}
export async function drainTotpagePendingOperations():Promise<void>{while(pendingOperations.size)await Promise.allSettled([...pendingOperations])}
export function totpagePendingOperationCount(){return pendingOperations.size}
export function totpagePublicUrl(id:string){if(!TOTPAGE_ID.test(id))throw Error('TOT.page 对象 ID 无效');return `${TOTPAGE_ORIGIN}/${id}`}
export function totpageRequest(html:string,title:string){const body=JSON.stringify({kind:'html',body:html,title});return {body,sourceHash:totpageHash(html),requestHash:totpageHash(`POST\n${TOTPAGE_CREATE_URL}\naccept:application/json\ncontent-type:application/json\n\n${body}`)}}
export function validTotpageIntent(intent:TotpageIntent){return OP.test(intent.operationId)&&HASH.test(intent.sourceHash)&&HASH.test(intent.requestHash)&&Number.isFinite(Date.parse(intent.createdAt))&&new Date(intent.createdAt).toISOString()===intent.createdAt}
function sameIntent(a:TotpageIntent,b:TotpageIntent){return a.operationId===b.operationId&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}

// JSON.parse validates syntax; this lexical pass separately rejects duplicate keys at every depth.
function uniqueJsonKeys(text:string):boolean{
 const stack:Array<Set<string>|null>=[];
 for(let i=0;i<text.length;i++){
  const c=text[i];if(c==='{'||c==='['){stack.push(c==='{'?new Set<string>():null);if(stack.length>64)return false}
  else if(c==='}'||c===']')stack.pop();
  else if(c==='"'){const start=i;for(i++;i<text.length;i++){if(text[i]==='\\'){i++;continue}if(text[i]==='"')break}let end=i+1;while(/\s/.test(text[end]??'')&&end<text.length)end++;if(text[end]===':'){const key=JSON.parse(text.slice(start,i+1)) as string,current=stack.at(-1);if(!current||current.has(key))return false;current.add(key)}}
 }return true;
}
function parseResponse(opaque:TotpageOpaqueResponse,intent:TotpageIntent,html:string,title:string,nowMs:number):{receipt:TotpageReceipt}|{diagnostic:TotpageDiagnostic}{
  const request=totpageRequest(html,title);if(!sameIntent(opaque,intent)||request.requestHash!==intent.requestHash||request.sourceHash!==intent.sourceHash)return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400||opaque.responseUrl&&opaque.responseUrl!==totpageCreateUrl(title))return {diagnostic:'redirect'};
  if(opaque.status!==201)return {diagnostic:'http_status'};
  if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(opaque.bodyBase64,'base64'))}catch{return {diagnostic:'decode'}}
  let parsed:unknown;try{parsed=JSON.parse(text);if(!uniqueJsonKeys(text))return {diagnostic:'duplicate_field'}}catch{return {diagnostic:'json'}}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {diagnostic:'schema'};const value=parsed as Record<string,unknown>;
  if(Object.keys(value).sort().join(',')!=='document,workspace')return {diagnostic:'schema'};
  const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
  const doc=value.document,ws=value.workspace;if(!record(doc)||!record(ws))return {diagnostic:'schema'};
  const required=['id','workspace_id','doc_path','kind','version','share_url','file_url'],optional=['title','body','created_at','updated_at','requires_approval'];
  if(required.some(key=>!Object.hasOwn(doc,key))||Object.keys(doc).some(key=>!required.includes(key)&&!optional.includes(key))||['id','share_url','slug','visibility'].some(key=>!Object.hasOwn(ws,key))||Object.keys(ws).some(key=>!['id','share_url','slug','visibility','org_id'].includes(key)))return {diagnostic:'schema'};
  if(Object.hasOwn(doc,'requires_approval')&&doc.requires_approval!==false||Object.hasOwn(ws,'org_id')&&ws.org_id!==null)return {diagnostic:'schema'};
  if(typeof ws.slug!=='string'||!TOTPAGE_ID.test(ws.slug)||typeof ws.id!=='string'||!/^ws_[A-Za-z0-9_-]{10,80}$/.test(ws.id)||typeof doc.id!=='string'||!/^doc_[A-Za-z0-9_-]{10,80}$/.test(doc.id)||doc.workspace_id!==ws.id||doc.doc_path!=='index.html'||doc.kind!=='html'||ws.visibility!=='open')return {diagnostic:'schema'};
  const url=totpagePublicUrl(ws.slug);
  if(doc.share_url!==url||ws.share_url!==url||doc.title!==undefined&&doc.title!==title||doc.body!==undefined&&doc.body!==html)return {diagnostic:'schema'};
  if(doc.version===null?doc.file_url!==null:typeof doc.version!=='string'||!/^[a-f0-9]{40,64}$/.test(doc.version)||doc.file_url!==`${url}/index.html@${doc.version}`)return {diagnostic:'schema'};
  for(const key of ['created_at','updated_at'])if(doc[key]!==undefined&&(typeof doc[key]!=='string'||!Number.isFinite(Date.parse(doc[key] as string))))return {diagnostic:'schema'};
  if(!Number.isFinite(nowMs)||!validTotpageIntent(intent))return {diagnostic:'schema'};
  // No secret ownership is implied: anyone who obtains the public link can modify this open workspace.
  return {receipt:{operationId:intent.operationId,sourceHash:intent.sourceHash,requestHash:intent.requestHash,createdAt:intent.createdAt,id:ws.slug,publicUrl:url}};
}

export const parseStoredTotpageCreateResponse=parseResponse;
class BodyLimitError extends Error{}
function discard(response:Response){if(response.body&&!response.body.locked)void trackTotpagePendingOperation(response.body.cancel()).catch(()=>undefined)}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{const tracked=trackTotpagePendingOperation(pending);if(signal.aborted){void tracked.then(value=>late?.(value),()=>undefined);return Promise.reject(Error('abort'))}return new Promise((resolve,reject)=>{let done=false;const stop=()=>{if(done)return;done=true;signal.removeEventListener('abort',stop);reject(Error('abort'))};signal.addEventListener('abort',stop,{once:true});void tracked.then(value=>{signal.removeEventListener('abort',stop);if(done){late?.(value);return}done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(Error('transport'))})})}
async function bounded(response:Response,signal:AbortSignal):Promise<Uint8Array>{const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_RESPONSE))throw new BodyLimitError();if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>MAX_RESPONSE)throw new BodyLimitError();parts.push(next.value)}}finally{reader.releaseLock()}return Buffer.concat(parts.map(value=>Buffer.from(value)))}
function opaqueFrom(response:Response,bytes:Uint8Array,intent:TotpageIntent):TotpageOpaqueResponse{return {...intent,version:1,kind:'totpage_opaque_response',status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:totpageHash(bytes)}}

export async function createTotpagePage(input:{operationId:string;html:string;title:string;reviewed:true},persistence:TotpagePersistence,deps:TotpageDependencies={}):Promise<TotpageCreateResult>{
  if(input.reviewed!==true||!OP.test(input.operationId))throw Error('Totpage 缺少已审核的单次发布编号');
  if(deps.signal?.aborted)return {status:'not_started',reason:'authorization_changed'};
  const request=totpageRequest(input.html,input.title);if(!input.html||!/^<!doctype html>/i.test(input.html)||Buffer.from(input.html,'utf8').toString('utf8')!==input.html||Buffer.byteLength(input.html,'utf8')>TOTPAGE_MAX_CONTENT_BYTES||!input.title||input.title!==input.title.trim()||input.title.length>512||/[\u0000-\u001f\u007f]/.test(input.title))return {status:'not_started',reason:'invalid_content'};
  const intent:TotpageIntent={operationId:input.operationId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};if(!validTotpageIntent(intent))throw Error('Totpage 提交信息无效');
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  if(deps.signal?.aborted)return {status:'unknown',intent,diagnostic:'transport',opaqueResponseSaved:false};
  const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const timeout=Math.min(60_000,Math.max(50,deps.timeoutMs??25_000)),timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.();let response:Response|undefined;
  const preserve=async(value:Response)=>{try{const late=new AbortController(),lateTimer=setTimeout(()=>late.abort(),timeout);lateTimer.unref?.();try{await persistence.persistOpaqueResponse(opaqueFrom(value,await bounded(value,late.signal),intent))}finally{clearTimeout(lateTimer)}}catch{try{await persistence.persistOpaqueResponse(opaqueFrom(value,new Uint8Array(),intent))}catch{/* The durable intent still blocks replay. */}discard(value)}};
  try{const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));response=await abortable(Promise.resolve(transport(totpageCreateUrl(input.title),{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json','content-type':'application/json'},body:request.body})),controller.signal,value=>{void trackTotpagePendingOperation(preserve(value)).catch(()=>undefined)});const opaque=opaqueFrom(response,await bounded(response,controller.signal),intent);try{await persistence.persistOpaqueResponse(opaque)}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:false}}const parsed=parseResponse(opaque,intent,input.html,input.title,(deps.now?.()??new Date()).getTime());if('diagnostic' in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic,opaqueResponseSaved:true};try{await persistence.promoteReceipt(parsed.receipt);return {status:'created',receipt:parsed.receipt}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}}catch(error){controller.abort();let opaqueResponseSaved=false;if(response){try{await persistence.persistOpaqueResponse(opaqueFrom(response,new Uint8Array(),intent));opaqueResponseSaved=true}catch{/* The durable intent still blocks replay. */}discard(response)}return {status:'unknown',intent,diagnostic:error instanceof BodyLimitError?'body_limit':'transport',opaqueResponseSaved}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external);if(response&&controller.signal.aborted)discard(response)}
}
