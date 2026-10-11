import {createHash} from 'node:crypto';

export const MARKDROP_API_ORIGIN='https://api.markdrop.in';
export const MARKDROP_CREATE_URL=`${MARKDROP_API_ORIGIN}/api/v1/documents`;
export const MARKDROP_MAX_RESPONSE_BYTES=64*1024;
export const MARKDROP_RESPONSE_METADATA_RESERVE_BYTES=40*1024;
export const MARKDROP_MAX_REQUEST_BYTES=MARKDROP_MAX_RESPONSE_BYTES-MARKDROP_RESPONSE_METADATA_RESERVE_BYTES;
const OP=/^markdrop_[a-f0-9]{32}$/;
const SLUG=/^[a-z0-9][a-z0-9_-]{1,48}[a-z0-9]$/;
const HASH=/^[a-f0-9]{64}$/;

export interface MarkdropRequest {title:string;content:string;custom_slug:string;expires_in:'never';encrypted:false;access_level:'link'}
export interface MarkdropIntent {operationId:string;slug:string;sourceHash:string;requestHash:string;createdAt:string}
export interface MarkdropOpaqueResponse extends MarkdropIntent {version:1;kind:'markdrop_opaque_response';status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string}
export interface MarkdropReceipt extends MarkdropIntent {publicUrl:string}
export interface MarkdropPersistence {
  persistIntent(value:MarkdropIntent):Promise<void>;
  assertReadyToSubmit(value:MarkdropIntent):true;
  persistOpaqueResponse(value:MarkdropOpaqueResponse):Promise<void>;
  loadOpaqueResponse():Promise<MarkdropOpaqueResponse|undefined>;
  promoteCreated(value:{receipt:MarkdropReceipt;editSecret:string}):Promise<void>;
}
export interface MarkdropDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}
export type MarkdropDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status';
export type MarkdropCreateResult=
  |{status:'not_started';reason:'request_too_large'|'intent_not_persisted'|'authorization_changed'}
  |{status:'unknown';intent:MarkdropIntent;diagnostic:MarkdropDiagnostic;opaqueResponseSaved:boolean}
  |{status:'created';receipt:MarkdropReceipt};

const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function markdropPublicUrl(slug:string){if(!SLUG.test(slug))throw Error('Markdrop slug 无效');return `https://markdrop.in/${slug}`}
export function validMarkdropEditSecret(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=8192&&!/[\s\u0000-\u001f\u007f]/u.test(value)}
export function validMarkdropIntent(value:MarkdropIntent){return OP.test(value.operationId)&&SLUG.test(value.slug)&&HASH.test(value.sourceHash)&&HASH.test(value.requestHash)&&Number.isFinite(Date.parse(value.createdAt))&&new Date(value.createdAt).toISOString()===value.createdAt}

function topLevelKeys(text:string):string[]|undefined{
  let i=0;const ws=()=>{while(/\s/u.test(text[i]??''))i++};const string=()=>{const start=i;if(text[i++]!=='"')return;while(i<text.length){const c=text[i++];if(c==='"'){try{const value=JSON.parse(text.slice(start,i));return typeof value==='string'?value:undefined}catch{return}}if(c==='\\'){const e=text[i++];if(e==='u'){const hex=text.slice(i,i+4);if(!/^[0-9a-f]{4}$/i.test(hex))return;i+=4}else if(!'"\\/bfnrt'.includes(e??''))return}else if(c<' ')return}};
  const skip=()=>{ws();if(text[i]==='"')return string()!==undefined;let depth=0,inString=false,escape=false;for(;i<text.length;i++){const c=text[i];if(inString){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')inString=false;continue}if(c==='"'){inString=true;continue}if(c==='{'||c==='['){depth++;continue}if(c==='}'||c===']'){if(depth===0)return true;depth--;continue}if(depth===0&&c===',')return true}return !inString&&depth===0};
  ws();if(text[i++]!=='{')return;const keys:string[]=[];ws();if(text[i]==='}')return keys;for(;;){ws();const key=string();if(key===undefined)return;keys.push(key);ws();if(text[i++]!==':')return;if(!skip())return;ws();if(text[i]===','){i++;continue}if(text[i]==='}'){i++;ws();return i===text.length?keys:undefined}return}
}

const allowed=new Set(['slug','url','folder_path','title','content','created_at','updated_at','expires_at','views','is_password_protected','is_owned','is_owner','id','google_doc_url','google_doc_stale','vscode_synced','encrypted','kind','mime','renderer','type_label','size_bytes','original_filename','artifact_url','download_url','edit_secret']);
// The official service declares Pydantic datetime response fields and creates them with
// datetime.now(timezone.utc); persisted Mongo values may also round-trip as naive UTC.
function remoteDate(value:unknown){
  if(typeof value!=='string')return false;
  const match=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}|\d{6}))?(Z|[+-]\d{2}:\d{2})?$/);if(!match)return false;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),hour=Number(match[4]),minute=Number(match[5]),second=Number(match[6]);
  if(year<1||month<1||month>12||hour>23||minute>59||second>59)return false;
  const leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];if(day<1||day>days[month-1])return false;
  const zone=match[8];if(zone&&zone!=='Z'){const offset=zone.slice(1).split(':').map(Number);if(offset[0]>14||offset[1]>59||offset[0]===14&&offset[1]!==0||zone==='-00:00')return false;}
  return true;
}
export function parseMarkdropDocument(value:unknown,request:MarkdropRequest,expectSecret:boolean):{receiptBody:{publicUrl:string};editSecret?:string}|undefined{
  if(!object(value)||Object.keys(value).some(key=>!allowed.has(key)))return;
  if(value.slug!==request.custom_slug||value.url!==markdropPublicUrl(request.custom_slug)||value.title!==request.title||value.content!==request.content||!remoteDate(value.created_at)||!remoteDate(value.updated_at)||value.expires_at!==null||value.encrypted!==false||value.is_password_protected!==false||value.kind!=='markdown')return;
  if(!Array.isArray(value.folder_path)||value.folder_path.some(v=>typeof v!=='string')||typeof value.views!=='number'||!Number.isSafeInteger(value.views)||value.views<0||typeof value.is_owned!=='boolean'||typeof value.is_owner!=='boolean'||value.id!==null&&typeof value.id!=='string'||value.google_doc_url!==null&&typeof value.google_doc_url!=='string'||typeof value.google_doc_stale!=='boolean'||typeof value.vscode_synced!=='boolean'||value.mime!==null&&typeof value.mime!=='string'||value.renderer!==null&&typeof value.renderer!=='string'||value.type_label!==null&&typeof value.type_label!=='string'||value.size_bytes!==null&&(!Number.isSafeInteger(value.size_bytes)||Number(value.size_bytes)<0)||value.original_filename!==null&&typeof value.original_filename!=='string'||value.artifact_url!==null&&typeof value.artifact_url!=='string'||value.download_url!==null&&typeof value.download_url!=='string')return;
  if(expectSecret?!validMarkdropEditSecret(value.edit_secret):Object.hasOwn(value,'edit_secret'))return;
  return {receiptBody:{publicUrl:markdropPublicUrl(request.custom_slug)},...(expectSecret?{editSecret:value.edit_secret as string}:{})};
}
export function parseMarkdropCreateResponse(bodyBase64:string,intent:MarkdropIntent,request:MarkdropRequest):{receipt:MarkdropReceipt;editSecret:string}|{diagnostic:'decode'|'json'|'duplicate_field'|'schema'}{
  let decoded:string;try{decoded=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(bodyBase64,'base64'))}catch{return {diagnostic:'decode'}}
  const keys=topLevelKeys(decoded);if(!keys)return {diagnostic:'json'};if(new Set(keys).size!==keys.length)return {diagnostic:'duplicate_field'};
  let value:unknown;try{value=JSON.parse(decoded)}catch{return {diagnostic:'json'}}const parsed=parseMarkdropDocument(value,request,true);if(!parsed?.editSecret)return {diagnostic:'schema'};return {receipt:{...intent,publicUrl:parsed.receiptBody.publicUrl},editSecret:parsed.editSecret};
}
export function parseMarkdropReadResponse(text:string,request:MarkdropRequest):boolean{const keys=topLevelKeys(text);if(!keys||new Set(keys).size!==keys.length)return false;let value:unknown;try{value=JSON.parse(text)}catch{return false}return !!parseMarkdropDocument(value,request,false)}
function sameIntent(a:MarkdropIntent,b:MarkdropIntent){return a.operationId===b.operationId&&a.slug===b.slug&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}
export function parseStoredMarkdropCreateResponse(opaque:MarkdropOpaqueResponse,intent:MarkdropIntent,request:MarkdropRequest):{receipt:MarkdropReceipt;editSecret:string}|{diagnostic:'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status'}{
  if(!sameIntent(opaque,intent)||markdropRequest(request.title,request.content,request.custom_slug).requestHash!==intent.requestHash)return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400||opaque.responseUrl&&opaque.responseUrl!==MARKDROP_CREATE_URL)return {diagnostic:'redirect'};
  if(opaque.status!==201)return {diagnostic:'http_status'};
  if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  return parseMarkdropCreateResponse(opaque.bodyBase64,intent,request);
}

class BodyLimitError extends Error{}
function discard(response:Response){if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{if(signal.aborted){void pending.then(value=>late?.(value),()=>undefined);return Promise.reject(Error('abort'))}return new Promise((resolve,reject)=>{let done=false;const stop=()=>{if(done)return;done=true;reject(Error('abort'))};signal.addEventListener('abort',stop,{once:true});void pending.then(value=>{signal.removeEventListener('abort',stop);if(done){late?.(value);return}done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(Error('transport'))})})}
async function bounded(response:Response,signal:AbortSignal):Promise<Uint8Array>{const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MARKDROP_MAX_RESPONSE_BYTES))throw new BodyLimitError();if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>MARKDROP_MAX_RESPONSE_BYTES)throw new BodyLimitError();parts.push(next.value)}}finally{reader.releaseLock()}return Buffer.concat(parts.map(value=>Buffer.from(value)))}
function opaqueFrom(response:Response,bytes:Uint8Array,intent:MarkdropIntent):MarkdropOpaqueResponse{return {...intent,version:1,kind:'markdrop_opaque_response',status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:sha256(bytes)}}

export function markdropRequest(title:string,content:string,slug:string){const value:MarkdropRequest={title,content,custom_slug:slug,expires_in:'never',encrypted:false,access_level:'link'},body=JSON.stringify(value);return {value,body,sourceHash:sha256(`${title}\n\u0000${content}`),requestHash:sha256(body)}}
export async function createMarkdropDocument(input:{operationId:string;title:string;content:string;slug:string},persistence:MarkdropPersistence,deps:MarkdropDependencies={}):Promise<MarkdropCreateResult>{
  const request=markdropRequest(input.title,input.content,input.slug);if(Buffer.byteLength(request.body)>MARKDROP_MAX_REQUEST_BYTES)return {status:'not_started',reason:'request_too_large'};
  const intent:MarkdropIntent={operationId:input.operationId,slug:input.slug,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};if(!validMarkdropIntent(intent))throw Error('Markdrop 提交输入无效');
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const timer=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(50,deps.timeoutMs??15_000)));timer.unref?.();let response:Response|undefined;
  const preserve=async(value:Response)=>{try{const lateController=new AbortController(),lateTimer=setTimeout(()=>lateController.abort(),Math.min(15_000,deps.timeoutMs??15_000));lateTimer.unref?.();try{await persistence.persistOpaqueResponse(opaqueFrom(value,await bounded(value,lateController.signal),intent))}finally{clearTimeout(lateTimer)}}catch{discard(value)}};
  try{const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));response=await abortable(Promise.resolve(transport(MARKDROP_CREATE_URL,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json','content-type':'application/json'},body:request.body})),controller.signal,value=>{void preserve(value)});const opaque=opaqueFrom(response,await bounded(response,controller.signal),intent);try{await persistence.persistOpaqueResponse(opaque)}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:false}}const parsed=parseStoredMarkdropCreateResponse(opaque,intent,request.value);if('diagnostic' in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic,opaqueResponseSaved:true};try{await persistence.promoteCreated(parsed);return {status:'created',receipt:parsed.receipt}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}
  }catch(error){return {status:'unknown',intent,diagnostic:error instanceof BodyLimitError?'body_limit':'transport',opaqueResponseSaved:false}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external);if(response&&controller.signal.aborted)discard(response)}
}

export const markdropTesting={topLevelKeys,SLUG,OP,sameIntent,remoteDate};
