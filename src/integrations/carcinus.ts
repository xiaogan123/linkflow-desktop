import {createHash} from 'node:crypto';
import {drainOpenAgentChatPendingOperations,isOpenAgentChatOpaqueProgress,openAgentChatPendingOperationCount,openAgentChatStreamingMutation,type OpenAgentChatOpaqueResponse} from './openagentchat';

export const CARCINUS_ORIGIN='https://carcinus.org';
export const CARCINUS_CREATE_URL=`${CARCINUS_ORIGIN}/api/v2/agent/bootstrap`;
export const CARCINUS_RETENTION='Beta service: no fixed expiry is documented, and uptime, persistence, endpoint stability, and preservation are not guaranteed';
export const CARCINUS_MAX_HTML_BYTES=120_000;
export const CARCINUS_IDENTITY=/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const HASH=/^[a-f0-9]{64}$/;
const OP=/^carcinus_[a-f0-9]{32}$/;
const MAX_RESPONSE=256*1024;
const pendingOperations=new Set<Promise<unknown>>();
const pendingCaptures=new Set<string>();

export interface CarcinusPayload {identity:string;purpose:string;htmlTemplate:string;isAssistantMemoryBackup:false}
export interface CarcinusIntent {operationId:string;identity:string;sourceHash:string;requestHash:string;createdAt:string;preflightCheckedAt:string;preflightStatus:404}
export interface CarcinusReceipt extends CarcinusIntent {publicUrl:string;restoreUrl:string;tokenFingerprint:string}
export interface CarcinusOpaqueResponse extends CarcinusIntent {version:1;kind:'carcinus_opaque_response';capturedAt:string;requestUrl:string;status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;headers:Array<[string,string]>;bodyBase64:string;bodySha256:string;bodyComplete:boolean}
export interface CarcinusPersistence {
  persistPreflight(intent:CarcinusIntent):Promise<void>;
  persistIntent(intent:CarcinusIntent):Promise<void>;
  assertReadyToSubmit(intent:CarcinusIntent):true;
  persistOpaqueResponse(response:CarcinusOpaqueResponse):Promise<void>;
  loadOpaqueResponse():Promise<CarcinusOpaqueResponse|undefined>;
  promoteManaged(value:{receipt:CarcinusReceipt;writeToken:string}):Promise<void>;
}
export interface CarcinusDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}
export type CarcinusDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status';
export type CarcinusCreateResult={status:'not_started';reason:'invalid_content'|'intent_not_persisted'|'authorization_changed'}|{status:'unknown';intent:CarcinusIntent;diagnostic:CarcinusDiagnostic;opaqueResponseSaved:boolean}|{status:'created';receipt:CarcinusReceipt};

export const carcinusHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function trackCarcinusPendingOperation<T>(pending:Promise<T>):Promise<T>{let tracked:Promise<T>;tracked=Promise.resolve(pending).then(value=>{pendingOperations.delete(tracked);return value},error=>{pendingOperations.delete(tracked);throw error});pendingOperations.add(tracked);return tracked}
export async function drainCarcinusPendingOperations(timeoutMs=5_000):Promise<boolean>{const deadline=performance.now()+Math.min(60_000,Math.max(0,timeoutMs));while(pendingOperations.size||openAgentChatPendingOperationCount()){const remaining=deadline-performance.now();if(remaining<=0)return false;let timer:ReturnType<typeof setTimeout>|undefined;const settled=await Promise.race([Promise.all([Promise.allSettled([...pendingOperations]),drainOpenAgentChatPendingOperations(remaining)]).then(([,shared])=>shared),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),Math.ceil(remaining))})]);if(timer)clearTimeout(timer);if(!settled)return false}return true}
export function carcinusPendingOperationCount(){return pendingOperations.size+openAgentChatPendingOperationCount()}
export function carcinusCapturePending(operationId:string){return pendingCaptures.has(operationId)}
export function carcinusPublicUrl(identity:string){if(!CARCINUS_IDENTITY.test(identity))throw Error('Carcinus identity invalid');return `${CARCINUS_ORIGIN}/public/${identity}/index.html`}
export function carcinusPublicDirectoryUrl(identity:string){if(!CARCINUS_IDENTITY.test(identity))throw Error('Carcinus identity invalid');return `${CARCINUS_ORIGIN}/public/${identity}/`}
export function carcinusRestoreUrl(identity:string){if(!CARCINUS_IDENTITY.test(identity))throw Error('Carcinus identity invalid');return `${CARCINUS_CREATE_URL}/${identity}/restore`}
export function carcinusPayload(input:{identity:string;purpose:string;htmlTemplate:string}):CarcinusPayload{return {identity:input.identity,purpose:input.purpose,htmlTemplate:input.htmlTemplate,isAssistantMemoryBackup:false}}
export function carcinusRequest(input:{identity:string;purpose:string;htmlTemplate:string}){const body=JSON.stringify(carcinusPayload(input));return {body,sourceHash:carcinusHash(input.htmlTemplate),requestHash:carcinusHash(`POST\n${CARCINUS_CREATE_URL}\naccept:application/json\ncontent-type:application/json\n\n${body}`)}}
export function validCarcinusToken(value:unknown):value is string{return typeof value==='string'&&value.length>=16&&Buffer.byteLength(value,'utf8')<=8192&&!/[\s\u0000-\u001f\u007f]/.test(value)}
export function validCarcinusIntent(intent:CarcinusIntent){return OP.test(intent.operationId)&&CARCINUS_IDENTITY.test(intent.identity)&&HASH.test(intent.sourceHash)&&HASH.test(intent.requestHash)&&intent.preflightStatus===404&&[intent.createdAt,intent.preflightCheckedAt].every(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value)&&Date.parse(intent.preflightCheckedAt)<=Date.parse(intent.createdAt)}
function sameIntent(a:CarcinusIntent,b:CarcinusIntent){return a.operationId===b.operationId&&a.identity===b.identity&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt&&a.preflightCheckedAt===b.preflightCheckedAt&&a.preflightStatus===b.preflightStatus}

// JSON.parse validates syntax; this lexical pass separately rejects duplicate keys at every depth.
function uniqueJsonKeys(text:string):boolean{
  const stack:Array<Set<string>|null>=[];
  for(let i=0;i<text.length;i++){
    const c=text[i];if(c==='{'||c==='['){stack.push(c==='{'?new Set<string>():null);if(stack.length>64)return false}
    else if(c==='}'||c===']')stack.pop();
    else if(c==='"'){const start=i;for(i++;i<text.length;i++){if(text[i]==='\\'){i++;continue}if(text[i]==='"')break}let end=i+1;while(/\s/.test(text[end]??'')&&end<text.length)end++;if(text[end]===':'){const key=JSON.parse(text.slice(start,i+1)) as string,current=stack.at(-1);if(!current||current.has(key))return false;current.add(key)}}
  }return stack.length===0;
}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
function exactUrl(value:unknown,allowed:string[]):value is string{if(typeof value!=='string'||!allowed.includes(value))return false;try{const url=new URL(value);return url.origin===CARCINUS_ORIGIN&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash}catch{return false}}
function parseResponse(opaque:CarcinusOpaqueResponse,intent:CarcinusIntent,input:{identity:string;purpose:string;htmlTemplate:string}):{receipt:CarcinusReceipt;writeToken:string}|{diagnostic:CarcinusDiagnostic}{
  const request=carcinusRequest(input);if(!validCarcinusOpaqueResponse(opaque)||!sameIntent(opaque,intent)||request.requestHash!==intent.requestHash||request.sourceHash!==intent.sourceHash||intent.identity!==input.identity||opaque.requestUrl!==CARCINUS_CREATE_URL||!opaque.bodyComplete)return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400||opaque.responseUrl&&opaque.responseUrl!==CARCINUS_CREATE_URL)return {diagnostic:'redirect'};
  if(opaque.status<200||opaque.status>=300)return {diagnostic:'http_status'};
  if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(opaque.bodyBase64,'base64'))}catch{return {diagnostic:'decode'}}
  let parsed:unknown;try{parsed=JSON.parse(text);if(!uniqueJsonKeys(text))return {diagnostic:'duplicate_field'}}catch{return {diagnostic:'json'}}
  if(!record(parsed)||!record(parsed.urls)||!record(parsed.bot))return {diagnostic:'schema'};
  const publicUrl=carcinusPublicUrl(intent.identity),directoryUrl=carcinusPublicDirectoryUrl(intent.identity),restoreUrl=carcinusRestoreUrl(intent.identity),bot=parsed.bot,urls=parsed.urls;
  const returnedIdentity=typeof bot.botName==='string'?bot.botName:typeof bot.identity==='string'?bot.identity:undefined;
  if(returnedIdentity!==intent.identity||!validCarcinusToken(bot.writeToken)||!exactUrl(urls.publicHtml,[publicUrl,directoryUrl])||!exactUrl(urls.restoreProfile,[restoreUrl]))return {diagnostic:'schema'};
  return {receipt:{...intent,publicUrl,restoreUrl,tokenFingerprint:carcinusHash(bot.writeToken)},writeToken:bot.writeToken};
}
export const parseStoredCarcinusCreateResponse=parseResponse;

function transportPart(value:CarcinusOpaqueResponse):OpenAgentChatOpaqueResponse{const {operationId:_,identity:__,sourceHash:___,requestHash:____,createdAt:_____,preflightCheckedAt:______,preflightStatus:_______,kind:________,...transport}=value;return transport}
function opaqueFrom(value:OpenAgentChatOpaqueResponse,intent:CarcinusIntent):CarcinusOpaqueResponse{
  const source=Buffer.from(value.bodyBase64,'base64'),bytes=source.subarray(0,MAX_RESPONSE),complete=value.bodyComplete&&source.length<=MAX_RESPONSE;
  return {...intent,...value,version:1,kind:'carcinus_opaque_response',bodyBase64:bytes.toString('base64'),bodySha256:carcinusHash(bytes),bodyComplete:complete};
}
export function validCarcinusOpaqueResponse(value:unknown):value is CarcinusOpaqueResponse{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;const v=value as CarcinusOpaqueResponse;
  if(!validCarcinusIntent(v)||v.version!==1||v.kind!=='carcinus_opaque_response'||!Number.isFinite(Date.parse(v.capturedAt))||new Date(v.capturedAt).toISOString()!==v.capturedAt||v.requestUrl!==CARCINUS_CREATE_URL||!Number.isSafeInteger(v.status)||v.status<100||v.status>599||typeof v.contentType!=='string'||v.contentType.length>512||typeof v.responseUrl!=='string'||v.responseUrl.length>2048||typeof v.redirected!=='boolean'||typeof v.responseType!=='string'||v.responseType.length>64||!Array.isArray(v.headers)||v.headers.length>128||v.headers.some(item=>!Array.isArray(item)||item.length!==2||typeof item[0]!=='string'||typeof item[1]!=='string'||item[0].length>256||item[1].length>8192)||typeof v.bodyBase64!=='string'||typeof v.bodySha256!=='string'||!HASH.test(v.bodySha256)||typeof v.bodyComplete!=='boolean')return false;
  try{const bytes=Buffer.from(v.bodyBase64,'base64');return bytes.length<=MAX_RESPONSE&&bytes.toString('base64')===v.bodyBase64&&carcinusHash(bytes)===v.bodySha256}catch{return false}
}
export function isCarcinusOpaqueProgress(previous:CarcinusOpaqueResponse,next:CarcinusOpaqueResponse):boolean{return validCarcinusOpaqueResponse(previous)&&validCarcinusOpaqueResponse(next)&&sameIntent(previous,next)&&isOpenAgentChatOpaqueProgress(transportPart(previous),transportPart(next))}

export async function createCarcinusSite(input:{intent:CarcinusIntent;purpose:string;htmlTemplate:string;reviewed:true},persistence:CarcinusPersistence,deps:CarcinusDependencies={}):Promise<CarcinusCreateResult>{
  const {intent}=input,request=carcinusRequest({identity:intent.identity,purpose:input.purpose,htmlTemplate:input.htmlTemplate});
  if(input.reviewed!==true||!validCarcinusIntent(intent)||request.sourceHash!==intent.sourceHash||request.requestHash!==intent.requestHash||!input.purpose||input.purpose!==input.purpose.trim()||input.purpose.length>1000||/[\u0000-\u001f\u007f]/.test(input.purpose)||!/^<!doctype html>/i.test(input.htmlTemplate)||Buffer.from(input.htmlTemplate,'utf8').toString('utf8')!==input.htmlTemplate||Buffer.byteLength(input.htmlTemplate,'utf8')>CARCINUS_MAX_HTML_BYTES)return {status:'not_started',reason:'invalid_content'};
  if(deps.signal?.aborted)return {status:'not_started',reason:'authorization_changed'};
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  if(deps.signal?.aborted)return {status:'unknown',intent,diagnostic:'transport',opaqueResponseSaved:false};
  let latest:CarcinusOpaqueResponse|undefined,overLimit=false,persistFailed=false;
  pendingCaptures.add(intent.operationId);
  const persist=async(value:OpenAgentChatOpaqueResponse)=>{const bytes=Buffer.from(value.bodyBase64,'base64');if(bytes.length>MAX_RESPONSE)overLimit=true;const next=opaqueFrom(value,intent);try{await persistence.persistOpaqueResponse(next);latest=next;if(next.bodyComplete)pendingCaptures.delete(intent.operationId)}catch(error){persistFailed=true;throw error}};
  const captured=await openAgentChatStreamingMutation(CARCINUS_CREATE_URL,{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:request.body},persist,()=>persistence.assertReadyToSubmit(intent),deps);
  if(captured||openAgentChatPendingOperationCount()===0)pendingCaptures.delete(intent.operationId);
  else{
    // Observe settlement only in the background. Recovery never waits here, and
    // a non-cooperative transport remains conservatively receipt-writable until
    // process restart instead of being terminalized while it can still reply.
    const timeout=Math.min(60_000,Math.max(100,Number.isFinite(deps.timeoutMs)?deps.timeoutMs!:25_000));
    void trackCarcinusPendingOperation(drainOpenAgentChatPendingOperations(timeout).then(settled=>{if(settled)pendingCaptures.delete(intent.operationId)})).catch(()=>undefined);
  }
  if(!latest)latest=await persistence.loadOpaqueResponse();
  if(!latest)return {status:'unknown',intent,diagnostic:persistFailed?'opaque_persistence':'transport',opaqueResponseSaved:false};
  if(!latest.bodyComplete)return {status:'unknown',intent,diagnostic:overLimit?'body_limit':persistFailed?'opaque_persistence':'transport',opaqueResponseSaved:true};
  const parsed=parseResponse(latest,intent,{identity:intent.identity,purpose:input.purpose,htmlTemplate:input.htmlTemplate});if('diagnostic' in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic,opaqueResponseSaved:true};try{await persistence.promoteManaged(parsed);return {status:'created',receipt:parsed.receipt}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}
}

