import {createHash} from 'node:crypto';

export const MEMORYWIKI_ORIGIN='https://memory.wiki';
export const MEMORYWIKI_CREATE_URL=`${MEMORYWIKI_ORIGIN}/api/docs`;
export const MEMORYWIKI_MAX_MARKDOWN_BYTES=490_000;
export const MEMORYWIKI_MAX_REQUEST_BYTES=512_000;
export const MEMORYWIKI_MAX_RESPONSE_BYTES=64*1024;
export const MEMORYWIKI_ID=/^[A-Za-z0-9_-]{8}$/;
const EDIT_TOKEN=/^[A-Za-z0-9_-]{32}$/;
const HASH=/^[a-f0-9]{64}$/;
const OP=/^memorywiki_[a-f0-9]{32}$/;
const FORBIDDEN_KEYS=new Set(['__proto__','constructor','prototype']);

export interface MemoryWikiRequest {markdown:string;title:string;isDraft:false;editMode:'token';source:'api'}
export interface MemoryWikiIntent {operationId:string;sourceHash:string;requestHash:string;createdAt:string}
export interface MemoryWikiOpaqueResponse extends MemoryWikiIntent {version:1;kind:'memorywiki_opaque_response';status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string}
export interface MemoryWikiReceipt extends MemoryWikiIntent {id:string;publicUrl:string;remoteCreatedAt:string;remoteUpdatedAt?:string;deduplicated:boolean}
export interface MemoryWikiPersistence {
  persistIntent(value:MemoryWikiIntent):Promise<void>;
  assertReadyToSubmit(value:MemoryWikiIntent):true;
  persistOpaqueResponse(value:MemoryWikiOpaqueResponse):Promise<void>;
  loadOpaqueResponse():Promise<MemoryWikiOpaqueResponse|undefined>;
  promoteReceipt(value:MemoryWikiReceipt):Promise<void>;
}
export interface MemoryWikiDependencies {
  fetch?:(url:string,init:RequestInit)=>Promise<Response>;
  signal?:AbortSignal;
  timeoutMs?:number;
  now?:()=>Date;
  trackLateResponse?:(work:Promise<void>)=>void;
  trackPendingWork?:(work:Promise<void>)=>void;
  renderArticle?:(html:string,pageUrl:string,selector:string,signal:AbortSignal)=>Promise<MemoryWikiRenderedArticle>;
}
export interface MemoryWikiResourceReplay {
  mode:'minimal'|'pinned_shell';
  styleSheets:number;
  styleBytes:number;
  styleSha256:string[];
  appliedStyleSheets:number;
  inertScripts:number;
  inertInlineScripts:number;
  inertImages:number;
  inertLinks:number;
}
export interface MemoryWikiRenderedArticle {
  pageUrl:string;
  selector:string;
  articleCount:number;
  articleText:string;
  articleHtml:string;
  allArticleTextVisible:boolean;
  links:Array<{href:string;rel:string[];text:string;visible:boolean}>;
  externalRequests:number;
  resourceReplay:MemoryWikiResourceReplay;
}
export type MemoryWikiDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status';
export type MemoryWikiCreateResult=
  |{status:'not_started';reason:'invalid_content'|'intent_not_persisted'|'authorization_changed'}
  |{status:'unknown';intent:MemoryWikiIntent;diagnostic:MemoryWikiDiagnostic;opaqueResponseSaved:boolean}
  |{status:'created';receipt:MemoryWikiReceipt};

export const memoryWikiHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function memoryWikiPublicUrl(id:string){if(!MEMORYWIKI_ID.test(id))throw Error('Memory.wiki 文档 ID 无效');return `${MEMORYWIKI_ORIGIN}/${id}`}
export function memoryWikiRawUrl(id:string){if(!MEMORYWIKI_ID.test(id))throw Error('Memory.wiki 文档 ID 无效');return `${MEMORYWIKI_ORIGIN}/raw/${id}`}
export function memoryWikiRequest(title:string,markdown:string){const value:MemoryWikiRequest={markdown,title,isDraft:false,editMode:'token',source:'api'},body=JSON.stringify(value);return {value,body,sourceHash:memoryWikiHash(`${title}\n\u0000${markdown}`),requestHash:memoryWikiHash(body)}}
export function validMemoryWikiIntent(value:MemoryWikiIntent){return OP.test(value.operationId)&&HASH.test(value.sourceHash)&&HASH.test(value.requestHash)&&Number.isFinite(Date.parse(value.createdAt))&&new Date(value.createdAt).toISOString()===value.createdAt}

/** Parse keys before JSON.parse so duplicate and escaped credential keys cannot be collapsed. */
export function memoryWikiTopLevelKeys(text:string):string[]|undefined{
  let i=0;const ws=()=>{while(/\s/u.test(text[i]??''))i++};
  const str=():string|undefined=>{const start=i;if(text[i++]!=='"')return;while(i<text.length){const c=text[i++];if(c==='"'){try{const value=JSON.parse(text.slice(start,i));return typeof value==='string'?value:undefined}catch{return}}if(c==='\\'){const e=text[i++];if(e==='u'){if(!/^[0-9a-f]{4}$/i.test(text.slice(i,i+4)))return;i+=4}else if(!'"\\/bfnrt'.includes(e??''))return}else if(c<' ')return}};
  const skip=()=>{ws();if(text[i]==='"')return str()!==undefined;let depth=0,inString=false,escaped=false;for(;i<text.length;i++){const c=text[i];if(inString){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')inString=false;continue}if(c==='"'){inString=true;continue}if(c==='{'||c==='['){depth++;continue}if(c==='}'||c===']'){if(depth===0)return true;depth--;continue}if(depth===0&&c===',')return true}return !inString&&depth===0};
  ws();if(text[i++]!=='{')return;const keys:string[]=[];ws();if(text[i]==='}')return keys;for(;;){ws();const key=str();if(key===undefined)return;keys.push(key);ws();if(text[i++]!==':')return;if(!skip())return;ws();if(text[i]===','){i++;continue}if(text[i]==='}'){i++;ws();return i===text.length?keys:undefined}return}
}

function sameIntent(a:MemoryWikiIntent,b:MemoryWikiIntent){return a.operationId===b.operationId&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}
function canonicalDate(value:unknown):string|undefined{if(typeof value!=='string'||value.length>64)return;const time=Date.parse(value);if(!Number.isFinite(time))return;return new Date(time).toISOString()}
function plainObject(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype}
function parseResponse(opaque:MemoryWikiOpaqueResponse,intent:MemoryWikiIntent,title:string,markdown:string):{receipt:MemoryWikiReceipt;editToken:string}|{diagnostic:MemoryWikiDiagnostic}{
  const request=memoryWikiRequest(title,markdown);if(!sameIntent(opaque,intent)||request.sourceHash!==intent.sourceHash||request.requestHash!==intent.requestHash||opaque.bodySha256!==memoryWikiHash(Buffer.from(opaque.bodyBase64,'base64')))return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400||opaque.responseUrl&&opaque.responseUrl!==MEMORYWIKI_CREATE_URL)return {diagnostic:'redirect'};
  if(opaque.status!==200)return {diagnostic:'http_status'};
  if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(opaque.bodyBase64,'base64'))}catch{return {diagnostic:'decode'}}
  const keys=memoryWikiTopLevelKeys(text);if(!keys)return {diagnostic:'json'};if(new Set(keys).size!==keys.length)return {diagnostic:'duplicate_field'};if(keys.some(key=>FORBIDDEN_KEYS.has(key)))return {diagnostic:'schema'};
  let parsed:unknown;try{parsed=JSON.parse(text)}catch{return {diagnostic:'json'}}
  if(!plainObject(parsed))return {diagnostic:'schema'};const value=parsed as Record<string,unknown>,fields=Object.keys(value).sort().join(','),normal=fields==='created_at,editToken,id,markdown,updated_at',dedup=fields==='created_at,deduplicated,editToken,id';
  if(!normal&&!dedup||typeof value.id!=='string'||!MEMORYWIKI_ID.test(value.id)||typeof value.editToken!=='string'||!EDIT_TOKEN.test(value.editToken)||normal&&value.markdown!==markdown||dedup&&value.deduplicated!==true)return {diagnostic:'schema'};
  const remoteCreatedAt=canonicalDate(value.created_at),remoteUpdatedAt=normal?canonicalDate(value.updated_at):undefined,local=Date.parse(intent.createdAt);if(!remoteCreatedAt||normal&&!remoteUpdatedAt)return {diagnostic:'schema'};const created=Date.parse(remoteCreatedAt),updated=remoteUpdatedAt?Date.parse(remoteUpdatedAt):created;
  if(Math.abs(created-local)>120_000||updated<created||updated-local>120_000||normal&&updated!==created)return {diagnostic:'schema'};
  return {receipt:{...intent,id:value.id,publicUrl:memoryWikiPublicUrl(value.id),remoteCreatedAt,...(remoteUpdatedAt?{remoteUpdatedAt}:{}),deduplicated:dedup},editToken:value.editToken};
}
export const parseStoredMemoryWikiCreateResponse=parseResponse;

class BodyLimitError extends Error{}
function discard(response:Response,track?:(work:Promise<void>)=>void){if(response.body&&!response.body.locked){const work=response.body.cancel().catch(()=>undefined);track?.(work);void work}}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>Promise<void>,track?:(work:Promise<void>)=>void):Promise<T>{
  const handOff=()=>{if(late){const work=pending.then(late,()=>undefined);track?.(work);void work.catch(()=>undefined)}};
  if(signal.aborted){handOff();return Promise.reject(Error('abort'))}
  return new Promise((resolve,reject)=>{let done=false;const stop=()=>{if(done)return;done=true;signal.removeEventListener('abort',stop);handOff();reject(Error('abort'))};signal.addEventListener('abort',stop,{once:true});void pending.then(value=>{signal.removeEventListener('abort',stop);if(done)return;done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(Error('transport'))})})
}
async function bounded(response:Response,signal:AbortSignal,track?:(work:Promise<void>)=>void){
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MEMORYWIKI_MAX_RESPONSE_BYTES)){discard(response,track);throw new BodyLimitError()}
  if(!response.body)return new Uint8Array();
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0,complete=false;
  try{for(;;){const next=await abortable(reader.read(),signal,async()=>{},track);if(next.done){complete=true;break}size+=next.value.byteLength;if(size>MEMORYWIKI_MAX_RESPONSE_BYTES)throw new BodyLimitError();parts.push(next.value)}}finally{if(!complete){const work=reader.cancel().catch(()=>undefined);track?.(work);void work}reader.releaseLock()}
  return Buffer.concat(parts.map(part=>Buffer.from(part)))
}
function opaqueFrom(response:Response,bytes:Uint8Array,intent:MemoryWikiIntent):MemoryWikiOpaqueResponse{return {...intent,version:1,kind:'memorywiki_opaque_response',status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:memoryWikiHash(bytes)}}

export async function createMemoryWikiDocument(input:{operationId:string;title:string;markdown:string;reviewed:true},persistence:MemoryWikiPersistence,deps:MemoryWikiDependencies={}):Promise<MemoryWikiCreateResult>{
  if(input.reviewed!==true||!OP.test(input.operationId))throw Error('Memory.wiki 缺少已审核的单次发布编号');
  if(deps.signal?.aborted)return {status:'not_started',reason:'authorization_changed'};
  const request=memoryWikiRequest(input.title,input.markdown),first=input.markdown.split(/\r?\n/,1)[0];if(!input.title||input.title!==input.title.trim()||first!==`# ${input.title}`||Buffer.byteLength(input.markdown,'utf8')>MEMORYWIKI_MAX_MARKDOWN_BYTES||Buffer.byteLength(request.body,'utf8')>MEMORYWIKI_MAX_REQUEST_BYTES)return {status:'not_started',reason:'invalid_content'};
  const intent:MemoryWikiIntent={operationId:input.operationId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};if(!validMemoryWikiIntent(intent))throw Error('Memory.wiki 提交信息无效');
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  if(deps.signal?.aborted)return {status:'unknown',intent,diagnostic:'transport',opaqueResponseSaved:false};
  const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});const timer=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(50,deps.timeoutMs??15_000)));timer.unref?.();let response:Response|undefined;
  const preserve=async(value:Response)=>{const late=new AbortController(),lateTimer=setTimeout(()=>late.abort(),Math.min(15_000,Math.max(50,deps.timeoutMs??15_000)));lateTimer.unref?.();try{await persistence.persistOpaqueResponse(opaqueFrom(value,await bounded(value,late.signal,deps.trackPendingWork),intent))}catch{late.abort();discard(value,deps.trackPendingWork)}finally{clearTimeout(lateTimer)}};
  try{
    const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));response=await abortable(Promise.resolve(transport(MEMORYWIKI_CREATE_URL,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json','content-type':'application/json'},body:request.body})),controller.signal,preserve,deps.trackLateResponse);
    const opaque=opaqueFrom(response,await bounded(response,controller.signal,deps.trackPendingWork),intent);try{await persistence.persistOpaqueResponse(opaque)}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:false}}
    const parsed=parseResponse(opaque,intent,input.title,input.markdown);if('diagnostic' in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic,opaqueResponseSaved:true};
    try{await persistence.promoteReceipt(parsed.receipt);return {status:'created',receipt:parsed.receipt}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}
  }catch(error){controller.abort();if(response)discard(response,deps.trackPendingWork);return {status:'unknown',intent,diagnostic:error instanceof BodyLimitError?'body_limit':'transport',opaqueResponseSaved:false}}
  finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external);if(response&&controller.signal.aborted)discard(response,deps.trackPendingWork)}
}

export const memoryWikiTesting={sameIntent,canonicalDate,plainObject,EDIT_TOKEN,OP};
