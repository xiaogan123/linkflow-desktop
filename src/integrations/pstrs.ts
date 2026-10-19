import {createHash} from 'node:crypto';

export const PSTRS_ORIGIN='https://paster.abhicracker.com';
export const PSTRS_CREATE_URL=`${PSTRS_ORIGIN}/`;
export const PSTRS_MAX_CONTENT_BYTES=1_000_000;
export const PSTRS_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;
const HASH=/^[a-f0-9]{64}$/;
const OP=/^pstrs_[a-f0-9]{32}$/;
const MAX_RESPONSE=64*1024;

export interface PstrsIntent {operationId:string;sourceHash:string;requestHash:string;createdAt:string}
export interface PstrsReceipt extends PstrsIntent {id:string;publicUrl:string;expiresAt:number}
export interface PstrsOpaqueResponse extends PstrsIntent {version:1;kind:'pstrs_opaque_response';status:number;contentType:string;tokenHeader:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string}
export interface PstrsPersistence {
  persistIntent(intent:PstrsIntent):Promise<void>;
  assertReadyToSubmit(intent:PstrsIntent):true;
  persistOpaqueResponse(response:PstrsOpaqueResponse):Promise<void>;
  loadOpaqueResponse():Promise<PstrsOpaqueResponse|undefined>;
  promoteReceipt(receipt:PstrsReceipt):Promise<void>;
}
export interface PstrsDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}
export type PstrsDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status'|'partial_status';
export type PstrsCreateResult={status:'not_started';reason:'invalid_content'|'intent_not_persisted'|'authorization_changed'}|{status:'unknown';intent:PstrsIntent;diagnostic:PstrsDiagnostic;opaqueResponseSaved:boolean}|{status:'created';receipt:PstrsReceipt};

export const pstrsHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function pstrsPublicUrl(id:string){if(!PSTRS_ID.test(id))throw Error('PST.RS 文章 ID 无效');return `${PSTRS_ORIGIN}/${id}.md`}
export function pstrsRawUrl(id:string){if(!PSTRS_ID.test(id))throw Error('PST.RS 文章 ID 无效');return `${PSTRS_ORIGIN}/raw/${id}`}
export function pstrsRequest(content:string){return {body:content,sourceHash:pstrsHash(content),requestHash:pstrsHash(`POST\n${PSTRS_CREATE_URL}\naccept:application/json\ncontent-type:application/octet-stream\nx-paste-ext:md\nx-paste-ttl:1y\n\n${content}`)}}
export function validPstrsIntent(intent:PstrsIntent){return OP.test(intent.operationId)&&HASH.test(intent.sourceHash)&&HASH.test(intent.requestHash)&&Number.isFinite(Date.parse(intent.createdAt))&&new Date(intent.createdAt).toISOString()===intent.createdAt}
function sameIntent(a:PstrsIntent,b:PstrsIntent){return a.operationId===b.operationId&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}

// Duplicate top-level JSON fields must not silently replace a receipt or management token.
export function pstrsTopLevelKeys(text:string):string[]|undefined{
  let i=0;const ws=()=>{while(/\s/u.test(text[i]??''))i++};
  const str=():string|undefined=>{const start=i;if(text[i++]!=='"')return;while(i<text.length){const c=text[i++];if(c==='"'){try{return JSON.parse(text.slice(start,i)) as string}catch{return}}if(c==='\\'){const e=text[i++];if(e==='u'){if(!/^[0-9a-f]{4}$/i.test(text.slice(i,i+4)))return;i+=4}else if(!'"\\/bfnrt'.includes(e??''))return}else if(c<' ')return}};
  const skip=()=>{ws();if(text[i]==='"')return str()!==undefined;let depth=0,inString=false,escaped=false;for(;i<text.length;i++){const c=text[i];if(inString){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')inString=false;continue}if(c==='"'){inString=true;continue}if(c==='{'||c==='['){depth++;continue}if(c==='}'||c===']'){if(depth===0)return true;depth--;continue}if(depth===0&&c===',')return true}return !inString&&depth===0};
  ws();if(text[i++]!=='{')return;const keys:string[]=[];ws();if(text[i]==='}')return keys;for(;;){ws();const key=str();if(key===undefined)return;keys.push(key);ws();if(text[i++]!==':')return;if(!skip())return;ws();if(text[i]===','){i++;continue}if(text[i]==='}'){i++;ws();return i===text.length?keys:undefined}return}
}
function safeReceiptUrl(value:unknown,id:string):boolean{if(typeof value!=='string'||value.length>2048)return false;try{const url=new URL(value);return url.origin===PSTRS_ORIGIN&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname===`/${id}`}catch{return false}}
function parseResponse(opaque:PstrsOpaqueResponse,intent:PstrsIntent,content:string,nowMs:number):{receipt:PstrsReceipt}|{diagnostic:PstrsDiagnostic}{
  const request=pstrsRequest(content);if(!sameIntent(opaque,intent)||request.requestHash!==intent.requestHash||request.sourceHash!==intent.sourceHash)return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400||opaque.responseUrl&&opaque.responseUrl!==PSTRS_CREATE_URL)return {diagnostic:'redirect'};
  if(opaque.status===206)return {diagnostic:'partial_status'};if(opaque.status!==201)return {diagnostic:'http_status'};
  if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(opaque.bodyBase64,'base64'))}catch{return {diagnostic:'decode'}}
  const keys=pstrsTopLevelKeys(text);if(!keys)return {diagnostic:'json'};if(new Set(keys).size!==keys.length)return {diagnostic:'duplicate_field'};
  let parsed:unknown;try{parsed=JSON.parse(text)}catch{return {diagnostic:'json'}}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {diagnostic:'schema'};const value=parsed as Record<string,unknown>;
  const fields=Object.keys(value).sort().join(',');
  if(!(fields==='expires_at,id,token,url'||fields==='expires_at,ext,id,token,url'&&value.ext==='md')||typeof value.id!=='string'||!PSTRS_ID.test(value.id)||!safeReceiptUrl(value.url,value.id)||typeof value.token!=='string'||value.token.length<1||value.token.length>4096||opaque.tokenHeader&&opaque.tokenHeader!==value.token||!Number.isSafeInteger(value.expires_at)||Number(value.expires_at)<=0)return {diagnostic:'schema'};
  const raw=Number(value.expires_at),createdMs=Date.parse(intent.createdAt),expiryMs=pstrsExpiryMs(raw);if(!Number.isFinite(nowMs)||!Number.isFinite(createdMs)||Math.abs(nowMs-createdMs)>60_000||expiryMs<=createdMs+60_000||expiryMs>createdMs+31536000_000+300_000)return {diagnostic:'schema'};
  return {receipt:{...intent,id:value.id,publicUrl:pstrsPublicUrl(value.id),expiresAt:raw}};
}
export const parseStoredPstrsCreateResponse=parseResponse;
export function pstrsExpiryMs(value:number){return value*1000}
class BodyLimitError extends Error{}
function discard(response:Response){if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{if(signal.aborted){void pending.then(value=>late?.(value),()=>undefined);return Promise.reject(Error('abort'))}return new Promise((resolve,reject)=>{let done=false;const stop=()=>{if(done)return;done=true;signal.removeEventListener('abort',stop);reject(Error('abort'))};signal.addEventListener('abort',stop,{once:true});void pending.then(value=>{signal.removeEventListener('abort',stop);if(done){late?.(value);return}done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(Error('transport'))})})}
async function bounded(response:Response,signal:AbortSignal):Promise<Uint8Array>{const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_RESPONSE))throw new BodyLimitError();if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>MAX_RESPONSE)throw new BodyLimitError();parts.push(next.value)}}finally{reader.releaseLock()}return Buffer.concat(parts.map(value=>Buffer.from(value)))}
function opaqueFrom(response:Response,bytes:Uint8Array,intent:PstrsIntent):PstrsOpaqueResponse{return {...intent,version:1,kind:'pstrs_opaque_response',status:response.status,contentType:response.headers.get('content-type')??'',tokenHeader:response.headers.get('x-paste-token')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:pstrsHash(bytes)}}

export async function createPstrsPaste(input:{operationId:string;content:string;reviewed:true},persistence:PstrsPersistence,deps:PstrsDependencies={}):Promise<PstrsCreateResult>{
  if(input.reviewed!==true||!OP.test(input.operationId))throw Error('PST.RS 缺少已审核的单次发布编号');
  if(deps.signal?.aborted)return {status:'not_started',reason:'authorization_changed'};
  const request=pstrsRequest(input.content);if(!input.content||input.content!==input.content.trim()||Buffer.byteLength(input.content,'utf8')>PSTRS_MAX_CONTENT_BYTES)return {status:'not_started',reason:'invalid_content'};
  const intent:PstrsIntent={operationId:input.operationId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};if(!validPstrsIntent(intent))throw Error('PST.RS 提交信息无效');
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  if(deps.signal?.aborted)return {status:'unknown',intent,diagnostic:'transport',opaqueResponseSaved:false};
  const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const timeout=Math.min(60_000,Math.max(50,deps.timeoutMs??25_000)),timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.();let response:Response|undefined;
  const preserve=async(value:Response)=>{try{const late=new AbortController(),lateTimer=setTimeout(()=>late.abort(),timeout);lateTimer.unref?.();try{await persistence.persistOpaqueResponse(opaqueFrom(value,await bounded(value,late.signal),intent))}finally{clearTimeout(lateTimer)}}catch{try{await persistence.persistOpaqueResponse(opaqueFrom(value,new Uint8Array(),intent))}catch{/* The durable intent still blocks replay. */}discard(value)}};
  try{const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));response=await abortable(Promise.resolve(transport(PSTRS_CREATE_URL,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json','content-type':'application/octet-stream','x-paste-ext':'md','x-paste-ttl':'1y'},body:request.body})),controller.signal,value=>{void preserve(value)});const opaque=opaqueFrom(response,await bounded(response,controller.signal),intent);try{await persistence.persistOpaqueResponse(opaque)}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:false}}const parsed=parseResponse(opaque,intent,input.content,(deps.now?.()??new Date()).getTime());if('diagnostic' in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic,opaqueResponseSaved:true};try{await persistence.promoteReceipt(parsed.receipt);return {status:'created',receipt:parsed.receipt}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}}catch(error){controller.abort();let opaqueResponseSaved=false;if(response){try{await persistence.persistOpaqueResponse(opaqueFrom(response,new Uint8Array(),intent));opaqueResponseSaved=true}catch{/* The durable intent still blocks replay. */}discard(response)}return {status:'unknown',intent,diagnostic:error instanceof BodyLimitError?'body_limit':'transport',opaqueResponseSaved}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external);if(response&&controller.signal.aborted)discard(response)}
}
