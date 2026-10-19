import {createHash} from 'node:crypto';

export const MARKDOWNPASTE_ORIGIN='https://markdownpasteit.vercel.app';
export const MARKDOWNPASTE_CREATE_URL=`${MARKDOWNPASTE_ORIGIN}/api/paste`;
export const MARKDOWNPASTE_ID=/^[A-Za-z0-9_-]{8}$/;
const HASH=/^[a-f0-9]{64}$/;
const OP=/^markdownpaste_[a-f0-9]{32}$/;
const MAX_RESPONSE=64*1024;
const MAX_CONTENT=16*1024;

export interface MarkdownPasteIntent {operationId:string;sourceHash:string;requestHash:string;createdAt:string}
export interface MarkdownPasteReceipt extends MarkdownPasteIntent {id:string;publicUrl:string;remoteCreatedAt:string}
export interface MarkdownPasteOpaqueResponse extends MarkdownPasteIntent {version:1;kind:'markdownpaste_opaque_response';status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string}
export interface MarkdownPastePersistence {
  persistIntent(intent:MarkdownPasteIntent):Promise<void>;
  assertReadyToSubmit(intent:MarkdownPasteIntent):true;
  persistOpaqueResponse(response:MarkdownPasteOpaqueResponse):Promise<void>;
  loadOpaqueResponse():Promise<MarkdownPasteOpaqueResponse|undefined>;
  promoteReceipt(receipt:MarkdownPasteReceipt):Promise<void>;
}
export interface MarkdownPasteDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}
export type MarkdownPasteDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status';
export type MarkdownPasteCreateResult={status:'not_started';reason:'invalid_content'|'intent_not_persisted'|'authorization_changed'}|{status:'unknown';intent:MarkdownPasteIntent;diagnostic:MarkdownPasteDiagnostic;opaqueResponseSaved:boolean}|{status:'created';receipt:MarkdownPasteReceipt};

export const markdownPasteHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function markdownPastePublicUrl(id:string){if(!MARKDOWNPASTE_ID.test(id))throw Error('Markdown Pastebin 文章 ID 无效');return `${MARKDOWNPASTE_ORIGIN}/p/${id}`}
export function markdownPasteRequest(content:string){const body=JSON.stringify({content,expires_in:0});return {body,sourceHash:markdownPasteHash(content),requestHash:markdownPasteHash(body)}}
export function validMarkdownPasteIntent(intent:MarkdownPasteIntent){return OP.test(intent.operationId)&&HASH.test(intent.sourceHash)&&HASH.test(intent.requestHash)&&Number.isFinite(Date.parse(intent.createdAt))&&new Date(intent.createdAt).toISOString()===intent.createdAt}
function sameIntent(a:MarkdownPasteIntent,b:MarkdownPasteIntent){return a.operationId===b.operationId&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}

// A duplicate top-level JSON key must never silently replace a remote receipt field.
export function markdownPasteTopLevelKeys(text:string):string[]|undefined{
  let i=0;const ws=()=>{while(/\s/u.test(text[i]??''))i++};
  const str=():string|undefined=>{const start=i;if(text[i++]!=='"')return;while(i<text.length){const c=text[i++];if(c==='"'){try{return JSON.parse(text.slice(start,i)) as string}catch{return}}if(c==='\\'){const e=text[i++];if(e==='u'){if(!/^[0-9a-f]{4}$/i.test(text.slice(i,i+4)))return;i+=4}else if(!'"\\/bfnrt'.includes(e??''))return}else if(c<' ')return}};
  const skip=()=>{ws();if(text[i]==='"')return str()!==undefined;let depth=0,inString=false,escaped=false;for(;i<text.length;i++){const c=text[i];if(inString){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')inString=false;continue}if(c==='"'){inString=true;continue}if(c==='{'||c==='['){depth++;continue}if(c==='}'||c===']'){if(depth===0)return true;depth--;continue}if(depth===0&&c===',')return true}return !inString&&depth===0};
  ws();if(text[i++]!=='{')return;const keys:string[]=[];ws();if(text[i]==='}')return keys;for(;;){ws();const key=str();if(key===undefined)return;keys.push(key);ws();if(text[i++]!==':')return;if(!skip())return;ws();if(text[i]===','){i++;continue}if(text[i]==='}'){i++;ws();return i===text.length?keys:undefined}return}
}
function parseResponse(opaque:MarkdownPasteOpaqueResponse,intent:MarkdownPasteIntent,content:string):{receipt:MarkdownPasteReceipt}|{diagnostic:MarkdownPasteDiagnostic}{
  if(!sameIntent(opaque,intent)||markdownPasteRequest(content).requestHash!==intent.requestHash||markdownPasteRequest(content).sourceHash!==intent.sourceHash)return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400||opaque.responseUrl&&opaque.responseUrl!==MARKDOWNPASTE_CREATE_URL)return {diagnostic:'redirect'};
  if(opaque.status!==200)return {diagnostic:'http_status'};
  if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(opaque.bodyBase64,'base64'))}catch{return {diagnostic:'decode'}}
  const keys=markdownPasteTopLevelKeys(text);if(!keys)return {diagnostic:'json'};if(new Set(keys).size!==keys.length)return {diagnostic:'duplicate_field'};
  let parsed:unknown;try{parsed=JSON.parse(text)}catch{return {diagnostic:'json'}}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {diagnostic:'schema'};
  const value=parsed as Record<string,unknown>;
  if(Object.keys(value).sort().join(',')!=='created_at,expires_at,id,url'||typeof value.id!=='string'||!MARKDOWNPASTE_ID.test(value.id)||value.url!==markdownPastePublicUrl(value.id)||typeof value.created_at!=='string'||!Number.isFinite(Date.parse(value.created_at))||new Date(value.created_at).toISOString()!==value.created_at||value.expires_at!==null)return {diagnostic:'schema'};
  return {receipt:{...intent,id:value.id,publicUrl:markdownPastePublicUrl(value.id),remoteCreatedAt:value.created_at}};
}
export const parseStoredMarkdownPasteCreateResponse=parseResponse;
class BodyLimitError extends Error{}
function discard(response:Response){if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{if(signal.aborted){void pending.then(value=>late?.(value),()=>undefined);return Promise.reject(Error('abort'))}return new Promise((resolve,reject)=>{let done=false;const stop=()=>{if(done)return;done=true;signal.removeEventListener('abort',stop);reject(Error('abort'))};signal.addEventListener('abort',stop,{once:true});void pending.then(value=>{signal.removeEventListener('abort',stop);if(done){late?.(value);return}done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(Error('transport'))})})}
async function bounded(response:Response,signal:AbortSignal):Promise<Uint8Array>{const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_RESPONSE))throw new BodyLimitError();if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>MAX_RESPONSE)throw new BodyLimitError();parts.push(next.value)}}finally{reader.releaseLock()}return Buffer.concat(parts.map(value=>Buffer.from(value)))}
function opaqueFrom(response:Response,bytes:Uint8Array,intent:MarkdownPasteIntent):MarkdownPasteOpaqueResponse{return {...intent,version:1,kind:'markdownpaste_opaque_response',status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:markdownPasteHash(bytes)}}

export async function createMarkdownPastePaste(input:{operationId:string;content:string;reviewed:true},persistence:MarkdownPastePersistence,deps:MarkdownPasteDependencies={}):Promise<MarkdownPasteCreateResult>{
  if(input.reviewed!==true||!OP.test(input.operationId))throw Error('MarkdownPaste 缺少已审核的单次发布编号');
  const request=markdownPasteRequest(input.content);if(!input.content||input.content!==input.content.trim()||Buffer.byteLength(input.content,'utf8')>MAX_CONTENT||Buffer.byteLength(request.body)>MAX_CONTENT+512)return {status:'not_started',reason:'invalid_content'};
  const intent:MarkdownPasteIntent={operationId:input.operationId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};if(!validMarkdownPasteIntent(intent))throw Error('MarkdownPaste 提交信息无效');
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const timeout=Math.min(60_000,Math.max(50,deps.timeoutMs??25_000)),timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.();let response:Response|undefined;
  const preserve=async(value:Response)=>{try{const late=new AbortController(),lateTimer=setTimeout(()=>late.abort(),timeout);lateTimer.unref?.();try{await persistence.persistOpaqueResponse(opaqueFrom(value,await bounded(value,late.signal),intent))}finally{clearTimeout(lateTimer)}}catch{discard(value)}};
  try{const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));response=await abortable(Promise.resolve(transport(MARKDOWNPASTE_CREATE_URL,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json','content-type':'application/json'},body:request.body})),controller.signal,value=>{void preserve(value)});const opaque=opaqueFrom(response,await bounded(response,controller.signal),intent);try{await persistence.persistOpaqueResponse(opaque)}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:false}}const parsed=parseResponse(opaque,intent,input.content);if('diagnostic' in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic,opaqueResponseSaved:true};try{await persistence.promoteReceipt(parsed.receipt);return {status:'created',receipt:parsed.receipt}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}}catch(error){controller.abort();if(response)discard(response);return {status:'unknown',intent,diagnostic:error instanceof BodyLimitError?'body_limit':'transport',opaqueResponseSaved:false}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external);if(response&&controller.signal.aborted)discard(response)}
}

