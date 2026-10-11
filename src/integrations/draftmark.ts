import {createHash} from 'node:crypto';

export const DRAFTMARK_ORIGIN='https://draftmark.app';
export const DRAFTMARK_CREATE_URL=`${DRAFTMARK_ORIGIN}/api/v1/docs`;
export const DRAFTMARK_MAX_REQUEST_BYTES=100*1024;
export const DRAFTMARK_MAX_RESPONSE_BYTES=16*1024;
const OP=/^draftmark_[a-f0-9]{32}$/;
const SLUG=/^[A-Za-z0-9_-]{8}$/;
const HASH=/^[a-f0-9]{64}$/;
const MAGIC=/^tok_[A-Za-z0-9_-]{43}$/;
const API_KEY=/^key_[A-Za-z0-9_-]{43}$/;

export interface DraftmarkRequest {title:string;content:string;visibility:'public'}
export interface DraftmarkIntent {operationId:string;sourceHash:string;requestHash:string;createdAt:string}
export interface DraftmarkOpaqueResponse extends DraftmarkIntent {version:1;kind:'draftmark_opaque_response';status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string}
export interface DraftmarkReceipt extends DraftmarkIntent {slug:string;publicUrl:string}
export interface DraftmarkPersistence {
  persistIntent(value:DraftmarkIntent):Promise<void>;
  assertReadyToSubmit(value:DraftmarkIntent):true;
  persistOpaqueResponse(value:DraftmarkOpaqueResponse):Promise<void>;
  loadOpaqueResponse():Promise<DraftmarkOpaqueResponse|undefined>;
  promoteCreated(value:{receipt:DraftmarkReceipt;magicToken:string;apiKey:string}):Promise<void>;
}
export interface DraftmarkDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}
export type DraftmarkDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status';
export type DraftmarkCreateResult=
  |{status:'not_started';reason:'request_too_large'|'intent_not_persisted'|'authorization_changed'}
  |{status:'unknown';intent:DraftmarkIntent;diagnostic:DraftmarkDiagnostic;opaqueResponseSaved:boolean}
  |{status:'created';receipt:DraftmarkReceipt};

const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function draftmarkPublicUrl(slug:string){if(!SLUG.test(slug))throw Error('Draftmark slug 无效');return `${DRAFTMARK_ORIGIN}/share/${slug}`}
export function validDraftmarkMagicToken(value:unknown):value is string{return typeof value==='string'&&MAGIC.test(value)}
export function validDraftmarkApiKey(value:unknown):value is string{return typeof value==='string'&&API_KEY.test(value)}
export function validDraftmarkIntent(value:DraftmarkIntent){return OP.test(value.operationId)&&HASH.test(value.sourceHash)&&HASH.test(value.requestHash)&&Number.isFinite(Date.parse(value.createdAt))&&new Date(value.createdAt).toISOString()===value.createdAt}

function topLevelKeys(text:string):string[]|undefined{
  let i=0;const ws=()=>{while(/\s/u.test(text[i]??''))i++};const string=()=>{const start=i;if(text[i++]!=='"')return;while(i<text.length){const c=text[i++];if(c==='"'){try{const value=JSON.parse(text.slice(start,i));return typeof value==='string'?value:undefined}catch{return}}if(c==='\\'){const e=text[i++];if(e==='u'){const hex=text.slice(i,i+4);if(!/^[0-9a-f]{4}$/i.test(hex))return;i+=4}else if(!'"\\/bfnrt'.includes(e??''))return}else if(c<' ')return}};
  const skip=()=>{ws();if(text[i]==='"')return string()!==undefined;let depth=0,inString=false,escape=false;for(;i<text.length;i++){const c=text[i];if(inString){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')inString=false;continue}if(c==='"'){inString=true;continue}if(c==='{'||c==='['){depth++;continue}if(c==='}'||c===']'){if(depth===0)return true;depth--;continue}if(depth===0&&c===',')return true}return !inString&&depth===0};
  ws();if(text[i++]!=='{')return;const keys:string[]=[];ws();if(text[i]==='}')return keys;for(;;){ws();const key=string();if(key===undefined)return;keys.push(key);ws();if(text[i++]!==':')return;if(!skip())return;ws();if(text[i]===','){i++;continue}if(text[i]==='}'){i++;ws();return i===text.length?keys:undefined}return}
}

function sameIntent(a:DraftmarkIntent,b:DraftmarkIntent){return a.operationId===b.operationId&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}
export function draftmarkRequest(title:string,content:string){const value:DraftmarkRequest={title,content,visibility:'public'},body=JSON.stringify(value);return {value,body,sourceHash:sha256(`${title}\n\u0000${content}`),requestHash:sha256(body)}}
export function parseDraftmarkCreateResponse(bodyBase64:string,intent:DraftmarkIntent):{receipt:DraftmarkReceipt;magicToken:string;apiKey:string}|{diagnostic:'decode'|'json'|'duplicate_field'|'schema'}{
  let decoded:string;try{decoded=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(bodyBase64,'base64'))}catch{return {diagnostic:'decode'}}
  const keys=topLevelKeys(decoded);if(!keys)return {diagnostic:'json'};if(new Set(keys).size!==keys.length)return {diagnostic:'duplicate_field'};
  let value:unknown;try{value=JSON.parse(decoded)}catch{return {diagnostic:'json'}}
  if(!object(value)||Object.keys(value).sort().join(',')!=='api_key,magic_token,slug,url'||typeof value.slug!=='string'||!SLUG.test(value.slug)||value.url!==draftmarkPublicUrl(value.slug)||!validDraftmarkMagicToken(value.magic_token)||!validDraftmarkApiKey(value.api_key))return {diagnostic:'schema'};
  return {receipt:{...intent,slug:value.slug as string,publicUrl:value.url as string},magicToken:value.magic_token,apiKey:value.api_key};
}
export function parseStoredDraftmarkCreateResponse(opaque:DraftmarkOpaqueResponse,intent:DraftmarkIntent):ReturnType<typeof parseDraftmarkCreateResponse>|{diagnostic:'redirect'|'media_type'|'http_status'|'schema'}{
  if(!sameIntent(opaque,intent)||opaque.bodySha256!==sha256(Buffer.from(opaque.bodyBase64,'base64')))return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400||opaque.responseUrl&&opaque.responseUrl!==DRAFTMARK_CREATE_URL)return {diagnostic:'redirect'};
  if(opaque.status!==201)return {diagnostic:'http_status'};
  if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  return parseDraftmarkCreateResponse(opaque.bodyBase64,intent);
}

class BodyLimitError extends Error{}
function discard(response:Response){if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{if(signal.aborted){void pending.then(value=>late?.(value),()=>undefined);return Promise.reject(Error('abort'))}return new Promise((resolve,reject)=>{let done=false;const stop=()=>{if(done)return;done=true;reject(Error('abort'))};signal.addEventListener('abort',stop,{once:true});void pending.then(value=>{signal.removeEventListener('abort',stop);if(done){late?.(value);return}done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(Error('transport'))})})}
async function bounded(response:Response,signal:AbortSignal):Promise<Uint8Array>{const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>DRAFTMARK_MAX_RESPONSE_BYTES))throw new BodyLimitError();if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>DRAFTMARK_MAX_RESPONSE_BYTES)throw new BodyLimitError();parts.push(next.value)}}finally{reader.releaseLock()}return Buffer.concat(parts.map(value=>Buffer.from(value)))}
function opaqueFrom(response:Response,bytes:Uint8Array,intent:DraftmarkIntent):DraftmarkOpaqueResponse{return {...intent,version:1,kind:'draftmark_opaque_response',status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:sha256(bytes)}}

export async function createDraftmarkDocument(input:{operationId:string;title:string;content:string},persistence:DraftmarkPersistence,deps:DraftmarkDependencies={}):Promise<DraftmarkCreateResult>{
  const request=draftmarkRequest(input.title,input.content);if(Buffer.byteLength(request.body)>DRAFTMARK_MAX_REQUEST_BYTES)return {status:'not_started',reason:'request_too_large'};
  const intent:DraftmarkIntent={operationId:input.operationId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};if(!validDraftmarkIntent(intent))throw Error('Draftmark 提交输入无效');
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const timer=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(50,deps.timeoutMs??15_000)));timer.unref?.();let response:Response|undefined;
  const preserve=async(value:Response)=>{try{const late=new AbortController(),lateTimer=setTimeout(()=>late.abort(),Math.min(15_000,deps.timeoutMs??15_000));lateTimer.unref?.();try{await persistence.persistOpaqueResponse(opaqueFrom(value,await bounded(value,late.signal),intent))}finally{clearTimeout(lateTimer)}}catch{discard(value)}};
  try{const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));response=await abortable(Promise.resolve(transport(DRAFTMARK_CREATE_URL,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json','content-type':'application/json'},body:request.body})),controller.signal,value=>{void preserve(value)});const opaque=opaqueFrom(response,await bounded(response,controller.signal),intent);try{await persistence.persistOpaqueResponse(opaque)}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:false}}const parsed=parseStoredDraftmarkCreateResponse(opaque,intent);if('diagnostic' in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic,opaqueResponseSaved:true};try{await persistence.promoteCreated(parsed);return {status:'created',receipt:parsed.receipt}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}
  }catch(error){return {status:'unknown',intent,diagnostic:error instanceof BodyLimitError?'body_limit':'transport',opaqueResponseSaved:false}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external);if(response&&controller.signal.aborted)discard(response)}
}

export const draftmarkTesting={topLevelKeys,sameIntent,SLUG,OP,MAGIC,API_KEY};
