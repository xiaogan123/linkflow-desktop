import {createHash} from 'node:crypto';

const CREATE_URL='https://api.ht-ml.app/v1/sites';
const API_ORIGIN='https://api.ht-ml.app';
const SITE_ID=/^[a-z0-9][a-z0-9-]{3,63}$/;
const OPERATION_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const HASH=/^[a-f0-9]{64}$/;
const MAX_HTML_BYTES=120_000,MAX_RESPONSE_BYTES=64*1024;

export interface HtmlAppIntent{operationId:string;sourceHash:string;requestHash:string;createdAt:string}
export interface HtmlAppReceipt extends HtmlAppIntent{siteId:string;publicUrl:string}
export interface HtmlAppPersistence{
  persistIntent(intent:HtmlAppIntent):Promise<void>;
  assertReadyToSubmit(intent:HtmlAppIntent):true;
  persistCreatedAtomically(value:{receipt:HtmlAppReceipt;updateKey:string}):Promise<void>;
}
export interface HtmlAppDependencies{fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}
export type HtmlAppCreateDiagnostic='transport'|'body_limit'|'decode'|'json'|'schema'|'redirect'|'media_type'|'http_status';
export type HtmlAppResult=
  |{status:'not_started';reason:'intent_not_persisted'|'authorization_changed'}
  |{status:'blocked';intent:HtmlAppIntent}
  |{status:'unknown';intent:HtmlAppIntent;diagnostic:HtmlAppCreateDiagnostic}
  |{status:'created';receipt:HtmlAppReceipt}
  |{status:'created_persistence_unknown';receipt:HtmlAppReceipt};

const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function htmlAppPublicUrl(siteId:string){if(!SITE_ID.test(siteId))throw Error('ht-ml.app site id 无效');return `https://${siteId}.ht-ml.app/`}
function validIntent(value:HtmlAppIntent){return OPERATION_ID.test(value.operationId)&&HASH.test(value.sourceHash)&&HASH.test(value.requestHash)&&new Date(value.createdAt).toISOString()===value.createdAt}
function validUpdateKey(value:unknown):value is string{return typeof value==='string'&&value.length>=16&&value.length<=8192&&!/[\s\u0000-\u001f\u007f]/.test(value)}
function discard(response:Response){if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
class CreateResponseError extends Error{constructor(readonly diagnostic:'body_limit'|'decode'){super(diagnostic)}}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{
  if(signal.aborted){void pending.then(value=>late?.(value),()=>undefined);return Promise.reject(Error('abort'))}
  return new Promise<T>((resolve,reject)=>{let done=false;const stop=()=>{if(done)return;done=true;reject(Error('abort'))};signal.addEventListener('abort',stop,{once:true});void pending.then(value=>{signal.removeEventListener('abort',stop);if(done){late?.(value);return}done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(Error('transport'))})});
}
async function bounded(response:Response,signal:AbortSignal){
  const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_RESPONSE_BYTES))throw new CreateResponseError('body_limit');
  if(!response.body)return '';
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>MAX_RESPONSE_BYTES)throw new CreateResponseError('body_limit');parts.push(next.value)}}finally{reader.releaseLock()}
  try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(parts.map(part=>Buffer.from(part))))}catch(error){if(error instanceof CreateResponseError)throw error;throw new CreateResponseError('decode')}
}
function exactCreateResponse(value:unknown,intent:HtmlAppIntent):{receipt:HtmlAppReceipt;updateKey:string}|undefined{
  if(!object(value)||Object.keys(value).sort().join(',')!=='site_id,status,update_key,url'||value.status!=='active'||typeof value.site_id!=='string'||!SITE_ID.test(value.site_id)||!validUpdateKey(value.update_key))return;
  const publicUrl=htmlAppPublicUrl(value.site_id);if(value.url!==publicUrl)return;
  return {receipt:{...intent,siteId:value.site_id,publicUrl},updateKey:value.update_key};
}
export function htmlAppIdentity(html:string){
  if(typeof html!=='string'||!html.startsWith('<!doctype html>\n')||Buffer.byteLength(html)>MAX_HTML_BYTES)throw Error('ht-ml.app HTML 无效');
  const body=JSON.stringify({html_content:html});return {sourceHash:sha256(html),requestHash:sha256(body),body};
}
export async function createHtmlAppSite(input:{operationId:string;reviewed:true;html:string;priorIntent?:HtmlAppIntent},persistence:HtmlAppPersistence,deps:HtmlAppDependencies={}):Promise<HtmlAppResult>{
  if(input.reviewed!==true||!OPERATION_ID.test(input.operationId))throw Error('ht-ml.app 提交输入无效');
  const identity=htmlAppIdentity(input.html);
  if(input.priorIntent){if(!validIntent(input.priorIntent))throw Error('ht-ml.app 原意图无效');return {status:'blocked',intent:{...input.priorIntent}}}
  const intent={operationId:input.operationId,sourceHash:identity.sourceHash,requestHash:identity.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(persistence.assertReadyToSubmit({...intent})!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  const controller=new AbortController(),abort=()=>controller.abort();deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)controller.abort();
  const timeout=Math.min(60_000,Math.max(50,deps.timeoutMs??15_000)),timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.();let response:Response|undefined;
  try{
    const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));
    response=await abortable(Promise.resolve(transport(CREATE_URL,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json','content-type':'application/json'},body:identity.body})),controller.signal,discard);
    if(response.redirected||response.type==='opaqueredirect'||response.status>=300&&response.status<400||response.url&&response.url!==CREATE_URL)return {status:'unknown',intent,diagnostic:'redirect'};
    const text=await bounded(response,controller.signal);
    if(response.status!==200)return {status:'unknown',intent,diagnostic:'http_status'};
    if(response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')return {status:'unknown',intent,diagnostic:'media_type'};
    let parsed:unknown;try{parsed=JSON.parse(text)}catch{return {status:'unknown',intent,diagnostic:'json'}}
    const known=exactCreateResponse(parsed,intent);if(!known)return {status:'unknown',intent,diagnostic:'schema'};
    try{await persistence.persistCreatedAtomically(known);return {status:'created',receipt:known.receipt}}
    catch{return {status:'created_persistence_unknown',receipt:known.receipt}}
  }catch(error){return {status:'unknown',intent,diagnostic:error instanceof CreateResponseError?error.diagnostic:'transport'}}
  finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort);if(response&&controller.signal.aborted)discard(response)}
}

export const htmlAppTesting={CREATE_URL,API_ORIGIN,exactCreateResponse,validIntent,validUpdateKey};
