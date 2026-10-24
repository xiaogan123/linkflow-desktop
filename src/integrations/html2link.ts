import {createHash} from 'node:crypto';
import {HTML2LINK_FILENAME,HTML2LINK_MAX_FILE_BYTES,html2LinkRequestHash,type Html2LinkRenderedArticle} from './html2link-article';
import {pstrsTopLevelKeys as topLevelKeys} from './pstrs';

export const HTML2LINK_ORIGIN='https://html2link.dev';
export const HTML2LINK_CREATE_URL=`${HTML2LINK_ORIGIN}/api/upload`;
export const HTML2LINK_ROBOTS_URL=`${HTML2LINK_ORIGIN}/robots.txt`;
export const HTML2LINK_MAX_RESPONSE_BYTES=64*1024;

const OP=/^html2link_[a-f0-9]{32}$/;
const HASH=/^[a-f0-9]{64}$/;
const SLUG=/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const SUBDOMAIN_SLUG=/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export interface Html2LinkIntent {operationId:string;sourceHash:string;requestHash:string;createdAt:string}
export interface Html2LinkReceipt extends Html2LinkIntent {slug:string;publicUrl:string}
export interface Html2LinkOpaqueResponse extends Html2LinkIntent {
  version:1;
  kind:'html2link_opaque_response';
  status:number;
  contentType:string;
  responseUrl:string;
  redirected:boolean;
  responseType:string;
  bodyBase64:string;
  bodySha256:string;
}

/** Full response and update token are capabilities and must remain encrypted. */
export interface Html2LinkPersistence {
  readonly secretStorage:'encrypted';
  persistIntent(intent:Html2LinkIntent):Promise<void>;
  assertReadyToSubmit(intent:Html2LinkIntent):true;
  persistOpaqueResponse(response:Html2LinkOpaqueResponse):Promise<void>;
  loadOpaqueResponse():Promise<Html2LinkOpaqueResponse|undefined>;
  promoteReceipt(value:{receipt:Html2LinkReceipt;updateToken:string}):Promise<void>;
}

export interface Html2LinkCreateDependencies {
  fetch?:(url:string,init:RequestInit)=>Promise<Response>;
  signal?:AbortSignal;
  timeoutMs?:number;
  now?:()=>Date;
  /** Explicit one-call authorization; omitted and false never touch the network. */
  allowExternalWrite?:boolean;
}

export type Html2LinkDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status';
export type Html2LinkCreateResult=
  |{status:'not_started';reason:'external_write_disabled'|'invalid_content'|'intent_not_persisted'|'authorization_changed'}
  |{status:'blocked';intent:Html2LinkIntent;reason:'prior_submission'}
  |{status:'unknown';intent:Html2LinkIntent;diagnostic:Html2LinkDiagnostic;opaqueResponseSaved:boolean}
  |{status:'created';receipt:Html2LinkReceipt};

const pendingOperations=new Set<Promise<unknown>>();
export const html2LinkHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function trackHtml2LinkPendingOperation<T>(pending:Promise<T>):Promise<T>{let tracked:Promise<T>;tracked=Promise.resolve(pending).then(value=>{pendingOperations.delete(tracked);return value},error=>{pendingOperations.delete(tracked);throw error});pendingOperations.add(tracked);return tracked}
export async function drainHtml2LinkPendingOperations():Promise<void>{while(pendingOperations.size)await Promise.allSettled([...pendingOperations])}
export function html2LinkPendingOperationCount(){return pendingOperations.size}

export function validHtml2LinkIntent(value:Html2LinkIntent):boolean{return OP.test(value.operationId)&&HASH.test(value.sourceHash)&&HASH.test(value.requestHash)&&Number.isFinite(Date.parse(value.createdAt))&&new Date(value.createdAt).toISOString()===value.createdAt}
function sameIntent(a:Html2LinkIntent,b:Html2LinkIntent){return a.operationId===b.operationId&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}
function validUpdateToken(value:unknown):value is string{return typeof value==='string'&&value.length>=16&&value.length<=8192&&!/[\s\u0000-\u001f\u007f]/u.test(value)}

export function html2LinkPublicUrl(slug:string):string{if(!SLUG.test(slug))throw Error('html2link slug 无效');return `${HTML2LINK_ORIGIN}/x/${slug}`}
export function html2LinkSubdomainPublicUrl(slug:string):string{if(!SUBDOMAIN_SLUG.test(slug))throw Error('html2link 子域 slug 无效');return `https://${slug}.html2link.dev/`}
export function parseHtml2LinkPublicUrl(value:unknown):{slug:string;publicUrl:string}|undefined{
  if(typeof value!=='string'||value.length>2048)return;
  try{
    const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||value!==url.href)return;
    const legacy=url.origin===HTML2LINK_ORIGIN?url.pathname.match(/^\/x\/([A-Za-z0-9][A-Za-z0-9_-]{2,127})$/):null;
    if(legacy){const publicUrl=html2LinkPublicUrl(legacy[1]);return publicUrl===value?{slug:legacy[1],publicUrl}:undefined}
    const host=url.hostname.match(/^([a-z0-9-]+)\.html2link\.dev$/);if(!host||url.pathname!=='/'||!SUBDOMAIN_SLUG.test(host[1]))return;
    const publicUrl=html2LinkSubdomainPublicUrl(host[1]);return publicUrl===value?{slug:host[1],publicUrl}:undefined;
  }catch{return}
}
export function html2LinkRobotsUrl(publicUrl:string):string|undefined{const parsed=parseHtml2LinkPublicUrl(publicUrl);return parsed?`${new URL(parsed.publicUrl).origin}/robots.txt`:undefined}

export function parseStoredHtml2LinkCreateResponse(opaque:Html2LinkOpaqueResponse,intent:Html2LinkIntent,expected:Pick<Html2LinkRenderedArticle,'sourceHash'|'requestHash'>):{receipt:Html2LinkReceipt;updateToken:string}|{diagnostic:Html2LinkDiagnostic}{
  if(!sameIntent(opaque,intent)||expected.sourceHash!==intent.sourceHash||expected.requestHash!==intent.requestHash||html2LinkHash(Buffer.from(opaque.bodyBase64,'base64'))!==opaque.bodySha256)return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400||opaque.responseUrl&&opaque.responseUrl!==HTML2LINK_CREATE_URL)return {diagnostic:'redirect'};
  if(![200,201].includes(opaque.status))return {diagnostic:'http_status'};
  if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  let text:string;try{const bytes=Buffer.from(opaque.bodyBase64,'base64');if(bytes.toString('base64')!==opaque.bodyBase64)return {diagnostic:'decode'};text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}catch{return {diagnostic:'decode'}}
  const keys=topLevelKeys(text);if(!keys)return {diagnostic:'json'};if(new Set(keys).size!==keys.length)return {diagnostic:'duplicate_field'};
  let parsed:unknown;try{parsed=JSON.parse(text)}catch{return {diagnostic:'json'}}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {diagnostic:'schema'};const value=parsed as Record<string,unknown>,known=parseHtml2LinkPublicUrl(value.url);
  if(!known||!validUpdateToken(value.updateToken)||value.slug!==undefined&&value.slug!==known.slug)return {diagnostic:'schema'};
  return {receipt:{...intent,...known},updateToken:value.updateToken};
}

class BodyLimitError extends Error{}
function discard(response:Response){if(response.body&&!response.body.locked)void trackHtml2LinkPendingOperation(response.body.cancel()).catch(()=>undefined)}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{const tracked=trackHtml2LinkPendingOperation(pending);if(signal.aborted){void tracked.then(value=>late?.(value),()=>undefined);return Promise.reject(Error('abort'))}return new Promise((resolve,reject)=>{let done=false;const stop=()=>{if(done)return;done=true;signal.removeEventListener('abort',stop);reject(Error('abort'))};signal.addEventListener('abort',stop,{once:true});void tracked.then(value=>{signal.removeEventListener('abort',stop);if(done){late?.(value);return}done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(Error('transport'))})})}
async function bounded(response:Response,signal:AbortSignal):Promise<Uint8Array>{const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>HTML2LINK_MAX_RESPONSE_BYTES))throw new BodyLimitError();if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>HTML2LINK_MAX_RESPONSE_BYTES)throw new BodyLimitError();parts.push(next.value)}}finally{reader.releaseLock()}return Buffer.concat(parts.map(value=>Buffer.from(value)))}
function opaqueFrom(response:Response,bytes:Uint8Array,intent:Html2LinkIntent):Html2LinkOpaqueResponse{return {...intent,version:1,kind:'html2link_opaque_response',status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:html2LinkHash(bytes)}}

export async function createHtml2LinkPublication(input:{operationId:string;reviewed:true;article:Html2LinkRenderedArticle;priorIntent?:Html2LinkIntent},persistence:Html2LinkPersistence,deps:Html2LinkCreateDependencies={}):Promise<Html2LinkCreateResult>{
  if(deps.allowExternalWrite!==true)return {status:'not_started',reason:'external_write_disabled'};
  if(input.reviewed!==true||!OP.test(input.operationId)||persistence.secretStorage!=='encrypted')throw Error('html2link 缺少已审核的单次发布编号或加密保存位置');
  if(input.priorIntent){if(!validHtml2LinkIntent(input.priorIntent))throw Error('html2link 原提交信息无效');return {status:'blocked',intent:{...input.priorIntent},reason:'prior_submission'}}
  const article=input.article;if(!article.html.startsWith('<!doctype html>\n')||Buffer.byteLength(article.html,'utf8')!==article.byteLength||article.byteLength>HTML2LINK_MAX_FILE_BYTES||html2LinkHash(article.html)!==article.sourceHash||article.requestHash!==html2LinkRequestHash(article.sourceHash,article.byteLength))return {status:'not_started',reason:'invalid_content'};
  const intent:Html2LinkIntent={operationId:input.operationId,sourceHash:article.sourceHash,requestHash:article.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};if(!validHtml2LinkIntent(intent))throw Error('html2link 提交信息无效');
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  if(deps.signal?.aborted)return {status:'unknown',intent,diagnostic:'transport',opaqueResponseSaved:false};
  const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const timeout=Math.min(60_000,Math.max(50,deps.timeoutMs??25_000)),timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.();let response:Response|undefined;
  const preserve=async(value:Response)=>{try{const late=new AbortController(),lateTimer=setTimeout(()=>late.abort(),timeout);lateTimer.unref?.();try{await persistence.persistOpaqueResponse(opaqueFrom(value,await bounded(value,late.signal),intent))}finally{clearTimeout(lateTimer)}}catch{try{await persistence.persistOpaqueResponse(opaqueFrom(value,new Uint8Array(),intent))}catch{/* Durable intent still blocks replay. */}discard(value)}};
  try{
    // Match the official client's untyped multipart file part.
    const form=new FormData();form.append('file',new Blob([article.html]),HTML2LINK_FILENAME);
    const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));response=await abortable(Promise.resolve(transport(HTML2LINK_CREATE_URL,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json'},body:form})),controller.signal,value=>{void trackHtml2LinkPendingOperation(preserve(value)).catch(()=>undefined)});
    const opaque=opaqueFrom(response,await bounded(response,controller.signal),intent);try{await persistence.persistOpaqueResponse(opaque)}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:false}}
    const parsed=parseStoredHtml2LinkCreateResponse(opaque,intent,article);if('diagnostic' in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic,opaqueResponseSaved:true};
    try{await persistence.promoteReceipt(parsed);return {status:'created',receipt:parsed.receipt}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}
  }catch(error){controller.abort();let opaqueResponseSaved=false;if(response){try{await persistence.persistOpaqueResponse(opaqueFrom(response,new Uint8Array(),intent));opaqueResponseSaved=true}catch{/* Durable intent still blocks replay. */}discard(response)}return {status:'unknown',intent,diagnostic:error instanceof BodyLimitError?'body_limit':'transport',opaqueResponseSaved}}
  finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external);if(response&&controller.signal.aborted)discard(response)}
}

export const html2LinkTesting={OP,SLUG,SUBDOMAIN_SLUG,validUpdateToken,sameIntent,opaqueFrom};
