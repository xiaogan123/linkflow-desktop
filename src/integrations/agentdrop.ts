import {createHash} from 'node:crypto';

export const AGENTDROP_ORIGIN='https://www.agent-drop.co';
export const AGENTDROP_ANONYMOUS_TTL_MS=30*86400000;
export const AGENTDROP_API_ORIGIN='https://api.agent-drop.co';
export const AGENTDROP_CREATE_URL=`${AGENTDROP_API_ORIGIN}/api/v1/sites`;
export const agentdropCreateUrl=(_title:string)=>AGENTDROP_CREATE_URL;
export const AGENTDROP_MAX_CONTENT_BYTES=120_000;
export const AGENTDROP_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const OP=/^agentdrop_[a-f0-9]{32}$/;
const MAX_RESPONSE=64*1024;
const pendingOperations=new Set<Promise<unknown>>();

export interface AgentDropIntent {operationId:string;sourceHash:string;requestHash:string;createdAt:string}
export interface AgentDropReceipt extends AgentDropIntent {id:string;publicUrl:string;expiresAt:number}
export interface AgentDropOpaqueResponse extends AgentDropIntent {version:1;kind:'agentdrop_opaque_response';status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string}
export interface AgentDropPersistence {
  persistIntent(intent:AgentDropIntent):Promise<void>;
  assertReadyToSubmit(intent:AgentDropIntent):true;
  persistOpaqueResponse(response:AgentDropOpaqueResponse):Promise<void>;
  loadOpaqueResponse():Promise<AgentDropOpaqueResponse|undefined>;
  promoteReceipt(receipt:AgentDropReceipt):Promise<void>;
}
export interface AgentDropNativeRequest {url:string;method:'GET';resourceType:string;routeClass:'public_page'|'static_asset'|'font'|'anonymous_session'|'convex_sync'|'raw_content'}
export interface AgentDropReadOnlyQueryProof {connectFrames:number;queryFrames:number;queryId:number;udfPath:'sites:getBySlug';slug:string;authenticated:false}
export interface AgentDropRenderedPage {
  url:string;
  title:string;
  bodyText:string;
  articleText:string;
  allArticleTextVisible:boolean;
  links:Array<{source:'anchor'|'streamdown_safety_button';href:string;rel:string[];text:string;visible:boolean}>;
  articleHtml:string;
  robots:Array<{name:string;content:string}>;
  responseRobots:string[];
  canonicals:string[];
  hasRefresh:boolean;
  hasPasswordGate:boolean;
  hasLoginGate:boolean;
  nativeRequests:AgentDropNativeRequest[];
  blockedAnalyticsRequests:number;
  readOnlyQuery:AgentDropReadOnlyQueryProof;
  contentRequestUrl:string;
  screenshotPng:Uint8Array;
}
export interface AgentDropRenderHooks {
  onBeforeRequest?:(request:AgentDropNativeRequest)=>void;
  onBlockedAnalyticsRequest?:(value:{url:string;method:string;resourceType:string})=>void;
}
export interface AgentDropDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date;renderPage?:(url:string,signal:AbortSignal,hooks?:AgentDropRenderHooks)=>Promise<AgentDropRenderedPage>}
export type AgentDropDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status';
export type AgentDropCreateResult={status:'not_started';reason:'invalid_content'|'intent_not_persisted'|'authorization_changed'}|{status:'unknown';intent:AgentDropIntent;diagnostic:AgentDropDiagnostic;opaqueResponseSaved:boolean}|{status:'created';receipt:AgentDropReceipt};

export const agentdropHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function trackAgentDropPendingOperation<T>(pending:Promise<T>):Promise<T>{let tracked:Promise<T>;tracked=Promise.resolve(pending).then(value=>{pendingOperations.delete(tracked);return value},error=>{pendingOperations.delete(tracked);throw error});pendingOperations.add(tracked);return tracked}
export async function drainAgentDropPendingOperations():Promise<void>{while(pendingOperations.size)await Promise.allSettled([...pendingOperations])}
export function agentdropPendingOperationCount(){return pendingOperations.size}
export function agentdropPublicUrl(id:string){if(!AGENTDROP_ID.test(id))throw Error('AgentDrop 对象 ID 无效');return `${AGENTDROP_ORIGIN}/${id}`}
export function agentdropRequest(html:string,title:string){const body=JSON.stringify({kind:'markdown',visibility:'public',title,content:html});return {body,sourceHash:agentdropHash(html),requestHash:agentdropHash(`POST\n${AGENTDROP_CREATE_URL}\naccept:application/json\ncontent-type:application/json\n\n${body}`)}}
export function validAgentDropIntent(intent:AgentDropIntent){return OP.test(intent.operationId)&&HASH.test(intent.sourceHash)&&HASH.test(intent.requestHash)&&Number.isFinite(Date.parse(intent.createdAt))&&new Date(intent.createdAt).toISOString()===intent.createdAt}
function sameIntent(a:AgentDropIntent,b:AgentDropIntent){return a.operationId===b.operationId&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}

import {pstrsTopLevelKeys as agentdropTopLevelKeys} from './pstrs';
function parseResponse(opaque:AgentDropOpaqueResponse,intent:AgentDropIntent,html:string,title:string,nowMs:number):{receipt:AgentDropReceipt}|{diagnostic:AgentDropDiagnostic}{
  const request=agentdropRequest(html,title);if(!sameIntent(opaque,intent)||request.requestHash!==intent.requestHash||request.sourceHash!==intent.sourceHash)return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400||opaque.responseUrl&&opaque.responseUrl!==agentdropCreateUrl(title))return {diagnostic:'redirect'};
  if(![200,201].includes(opaque.status))return {diagnostic:'http_status'};
  if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(opaque.bodyBase64,'base64'))}catch{return {diagnostic:'decode'}}
  const keys=agentdropTopLevelKeys(text);if(!keys)return {diagnostic:'json'};if(new Set(keys).size!==keys.length)return {diagnostic:'duplicate_field'};
  let parsed:unknown;try{parsed=JSON.parse(text)}catch{return {diagnostic:'json'}}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {diagnostic:'schema'};const value=parsed as Record<string,unknown>;
  if(typeof value.slug!=='string'||!AGENTDROP_ID.test(value.slug)||value.url!==agentdropPublicUrl(value.slug)||typeof value.editToken!=='string'||value.editToken.length<16||value.editToken.length>8192||/[\s\u0000-\u001f\u007f]/.test(value.editToken)||value.kind!=='markdown')return {diagnostic:'schema'};
  const expectedManage=new URL(`/manage/${value.slug}`,AGENTDROP_ORIGIN);expectedManage.searchParams.set('t',value.editToken);
  if(typeof value.manageUrl!=='string'||value.manageUrl!==expectedManage.href||value.visibility!==undefined&&value.visibility!=='public'||value.owned!==undefined&&value.owned!==false||value.retentionDays!==undefined&&value.retentionDays!==30)return {diagnostic:'schema'};
  const expiresAt=Number(value.expiresAt),createdMs=Date.parse(intent.createdAt);
  if(!Number.isFinite(nowMs)||!validAgentDropIntent(intent)||typeof value.expiresAt!=='number'||!Number.isSafeInteger(expiresAt)||Math.abs(expiresAt-createdMs-AGENTDROP_ANONYMOUS_TTL_MS)>300000)return {diagnostic:'schema'};
  // editToken and the secret-bearing manageUrl remain only in the encrypted response.
  return {receipt:{...intent,id:value.slug,publicUrl:agentdropPublicUrl(value.slug),expiresAt}};
}

export const parseStoredAgentDropCreateResponse=parseResponse;
class BodyLimitError extends Error{}
function discard(response:Response){if(response.body&&!response.body.locked)void trackAgentDropPendingOperation(response.body.cancel()).catch(()=>undefined)}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{const tracked=trackAgentDropPendingOperation(pending);if(signal.aborted){void tracked.then(value=>late?.(value),()=>undefined);return Promise.reject(Error('abort'))}return new Promise((resolve,reject)=>{let done=false;const stop=()=>{if(done)return;done=true;signal.removeEventListener('abort',stop);reject(Error('abort'))};signal.addEventListener('abort',stop,{once:true});void tracked.then(value=>{signal.removeEventListener('abort',stop);if(done){late?.(value);return}done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(Error('transport'))})})}
async function bounded(response:Response,signal:AbortSignal):Promise<Uint8Array>{const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_RESPONSE))throw new BodyLimitError();if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>MAX_RESPONSE)throw new BodyLimitError();parts.push(next.value)}}finally{reader.releaseLock()}return Buffer.concat(parts.map(value=>Buffer.from(value)))}
function opaqueFrom(response:Response,bytes:Uint8Array,intent:AgentDropIntent):AgentDropOpaqueResponse{return {...intent,version:1,kind:'agentdrop_opaque_response',status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:agentdropHash(bytes)}}

export async function createAgentDropPage(input:{operationId:string;html:string;title:string;reviewed:true},persistence:AgentDropPersistence,deps:AgentDropDependencies={}):Promise<AgentDropCreateResult>{
  if(input.reviewed!==true||!OP.test(input.operationId))throw Error('AgentDrop 缺少已审核的单次发布编号');
  if(deps.signal?.aborted)return {status:'not_started',reason:'authorization_changed'};
  const request=agentdropRequest(input.html,input.title);if(!input.html||!/^# [^\n]+\n\n/.test(input.html)||/<\/?[a-z][^>\n]*>/i.test(input.html)||/!\[/.test(input.html)||Buffer.from(input.html,'utf8').toString('utf8')!==input.html||Buffer.byteLength(input.html,'utf8')>AGENTDROP_MAX_CONTENT_BYTES||!input.title||input.title!==input.title.trim()||input.title.length>512||/[\u0000-\u001f\u007f]/.test(input.title))return {status:'not_started',reason:'invalid_content'};
  const intent:AgentDropIntent={operationId:input.operationId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};if(!validAgentDropIntent(intent))throw Error('AgentDrop 提交信息无效');
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  if(deps.signal?.aborted)return {status:'unknown',intent,diagnostic:'transport',opaqueResponseSaved:false};
  const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const timeout=Math.min(60_000,Math.max(50,deps.timeoutMs??25_000)),timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.();let response:Response|undefined;
  const preserve=async(value:Response)=>{try{const late=new AbortController(),lateTimer=setTimeout(()=>late.abort(),timeout);lateTimer.unref?.();try{await persistence.persistOpaqueResponse(opaqueFrom(value,await bounded(value,late.signal),intent))}finally{clearTimeout(lateTimer)}}catch{try{await persistence.persistOpaqueResponse(opaqueFrom(value,new Uint8Array(),intent))}catch{/* The durable intent still blocks replay. */}discard(value)}};
  try{const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));response=await abortable(Promise.resolve(transport(agentdropCreateUrl(input.title),{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json','content-type':'application/json'},body:request.body})),controller.signal,value=>{void trackAgentDropPendingOperation(preserve(value)).catch(()=>undefined)});const opaque=opaqueFrom(response,await bounded(response,controller.signal),intent);try{await persistence.persistOpaqueResponse(opaque)}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:false}}const parsed=parseResponse(opaque,intent,input.html,input.title,(deps.now?.()??new Date()).getTime());if('diagnostic' in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic,opaqueResponseSaved:true};try{await persistence.promoteReceipt(parsed.receipt);return {status:'created',receipt:parsed.receipt}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}}catch(error){controller.abort();let opaqueResponseSaved=false;if(response){try{await persistence.persistOpaqueResponse(opaqueFrom(response,new Uint8Array(),intent));opaqueResponseSaved=true}catch{/* The durable intent still blocks replay. */}discard(response)}return {status:'unknown',intent,diagnostic:error instanceof BodyLimitError?'body_limit':'transport',opaqueResponseSaved}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external);if(response&&controller.signal.aborted)discard(response)}
}
