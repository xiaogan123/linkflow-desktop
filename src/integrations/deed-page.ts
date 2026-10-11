import {createHash} from 'node:crypto';

export const DEED_PAGE_ORIGIN='https://deed.page';
export const DEED_PAGE_CREATE_URL=`${DEED_PAGE_ORIGIN}/v1/sites`;
export const DEED_PAGE_MAX_RESPONSE_BYTES=64*1024;
const OP=/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const SLUG=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HASH=/^[a-f0-9]{64}$/;
const VERSION=/^v[1-9][0-9]{0,11}$/;

export interface DeedPageIntent {operationId:string;ownerAccountId:string;slug:string;sourceHash:string;requestHash:string;createdAt:string}
export interface DeedPageOpaqueResponse extends DeedPageIntent {version:1;kind:'deed_page_opaque_response';status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string}
export interface DeedPageReceipt extends DeedPageIntent {publicUrl:string;version:string}
export interface DeedPagePersistence {
  readonly ownerAccountId:string;
  persistIntent(value:DeedPageIntent):Promise<void>;
  assertReadyToSubmit(value:DeedPageIntent):true;
  persistOpaqueResponse(value:DeedPageOpaqueResponse):Promise<void>;
  loadOpaqueResponse():Promise<DeedPageOpaqueResponse|undefined>;
  promoteCreated(value:{receipt:DeedPageReceipt;token?:string}):Promise<void>;
  promoteRecovered(value:{receipt:DeedPageReceipt}):Promise<void>;
}
export interface DeedPageDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}
export type DeedPageDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status';
export type DeedPageCreateResult=
  |{status:'not_started';reason:'intent_not_persisted'|'authorization_changed'}
  |{status:'unknown';intent:DeedPageIntent;diagnostic:DeedPageDiagnostic;opaqueResponseSaved:boolean}
  |{status:'created';receipt:DeedPageReceipt};

const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function deedPagePublicUrl(slug:string){if(!SLUG.test(slug))throw Error('deed.page slug 无效');return `https://${slug}.deed.page/`}
export function validDeedPageToken(value:unknown):value is string{return typeof value==='string'&&value.startsWith('deed_tok_')&&value.length>9&&value.length<=8192&&!/[\s\u0000-\u001f\u007f]/u.test(value)}
export function validDeedPageIntent(value:DeedPageIntent){return OP.test(value.operationId)&&SLUG.test(value.slug)&&HASH.test(value.sourceHash)&&HASH.test(value.requestHash)&&/^[0-9a-f-]{36}$/i.test(value.ownerAccountId)&&Number.isFinite(Date.parse(value.createdAt))&&new Date(value.createdAt).toISOString()===value.createdAt}

function topLevelKeys(text:string):string[]|undefined{
  let i=0;const ws=()=>{while(/\s/u.test(text[i]??''))i++};const string=()=>{const start=i;if(text[i++]!=='"')return;while(i<text.length){const c=text[i++];if(c==='"'){try{const value=JSON.parse(text.slice(start,i));return typeof value==='string'?value:undefined}catch{return}}if(c==='\\'){const e=text[i++];if(e==='u'){const hex=text.slice(i,i+4);if(!/^[0-9a-f]{4}$/i.test(hex))return;i+=4}else if(!'"\\/bfnrt'.includes(e??''))return}else if(c<' ')return}};
  const skip=()=>{ws();if(text[i]==='"')return string()!==undefined;let depth=0,inString=false,escape=false;for(;i<text.length;i++){const c=text[i];if(inString){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')inString=false;continue}if(c==='"'){inString=true;continue}if(c==='{'||c==='['){depth++;continue}if(c==='}'||c===']'){if(depth===0)return true;depth--;continue}if(depth===0&&c===',')return true}return !inString&&depth===0};
  ws();if(text[i++]!=='{')return;const keys:string[]=[];ws();if(text[i]==='}')return keys;for(;;){ws();const key=string();if(key===undefined)return;keys.push(key);ws();if(text[i++]!==':')return;if(!skip())return;ws();if(text[i]===','){i++;continue}if(text[i]==='}'){i++;ws();return i===text.length?keys:undefined}return}
}

function exactSignature(value:unknown):boolean{return value===null||object(value)&&Object.keys(value).sort().join(',')==='alg,kid,value'&&value.alg==='Ed25519'&&typeof value.kid==='string'&&value.kid.length>0&&value.kid.length<=256&&typeof value.value==='string'&&/^[A-Za-z0-9_-]+$/.test(value.value)}
export function parseDeedPageCreateResponse(text:string,intent:DeedPageIntent,expectToken:boolean):{receipt:DeedPageReceipt;token?:string}|{diagnostic:'decode'|'json'|'duplicate_field'|'schema'}{
  let decoded:string;try{decoded=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(text,'base64'))}catch{return {diagnostic:'decode'}}
  const keys=topLevelKeys(decoded);if(!keys)return {diagnostic:'json'};if(new Set(keys).size!==keys.length)return {diagnostic:'duplicate_field'};
  let value:unknown;try{value=JSON.parse(decoded)}catch{return {diagnostic:'json'}}
  if(!object(value))return {diagnostic:'schema'};
  const allowed=new Set(['ok','url','path_url','slug','version','unchanged','permanent','expires_at','bytes','files','plan','version_url','restored_from','token','token_note','manifest_url','signature']);
  if(Object.keys(value).some(key=>!allowed.has(key))||value.ok!==true||value.slug!==intent.slug||value.url!==deedPagePublicUrl(intent.slug)||value.path_url!==value.url||value.version!=='v1'||value.unchanged!==false||value.permanent!==true||value.expires_at!==null||value.bytes!==undefined&&(typeof value.bytes!=='number'||!Number.isSafeInteger(value.bytes)||value.bytes<0)||value.files!==1||value.plan!=='free')return {diagnostic:'schema'};
  if(!Object.hasOwn(value,'bytes')||typeof value.bytes!=='number'||!VERSION.test(String(value.version)))return {diagnostic:'schema'};
  if(value.version_url!==undefined&&typeof value.version_url!=='string'||value.restored_from!==undefined||value.manifest_url!==undefined&&typeof value.manifest_url!=='string'||value.signature!==undefined&&!exactSignature(value.signature)||value.token_note!==undefined&&typeof value.token_note!=='string')return {diagnostic:'schema'};
  if(expectToken?!validDeedPageToken(value.token):value.token!==undefined)return {diagnostic:'schema'};
  return {receipt:{...intent,publicUrl:deedPagePublicUrl(intent.slug),version:value.version as string},...(expectToken?{token:value.token as string}:{})};
}

function sameIntent(a:DeedPageIntent,b:DeedPageIntent){return a.operationId===b.operationId&&a.ownerAccountId===b.ownerAccountId&&a.slug===b.slug&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}
export function parseStoredDeedPageCreateResponse(opaque:DeedPageOpaqueResponse,intent:DeedPageIntent,expectToken:boolean,expectedBytes:number):{receipt:DeedPageReceipt;token?:string}|{diagnostic:'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status'}{
  if(!sameIntent(opaque,intent))return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400||opaque.responseUrl&&opaque.responseUrl!==DEED_PAGE_CREATE_URL)return {diagnostic:'redirect'};
  if(opaque.status!==201)return {diagnostic:'http_status'};
  if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  const parsed=parseDeedPageCreateResponse(opaque.bodyBase64,intent,expectToken);if('diagnostic' in parsed)return parsed;
  let body:unknown;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(opaque.bodyBase64,'base64')))}catch{return {diagnostic:'decode'}}
  if(!object(body)||(body as Record<string,unknown>).bytes!==expectedBytes)return {diagnostic:'schema'};
  return parsed;
}

function discard(response:Response){if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{if(signal.aborted){void pending.then(value=>late?.(value),()=>undefined);return Promise.reject(Error('abort'))}return new Promise((resolve,reject)=>{let done=false;const stop=()=>{if(done)return;done=true;reject(Error('abort'))};signal.addEventListener('abort',stop,{once:true});void pending.then(value=>{signal.removeEventListener('abort',stop);if(done){late?.(value);return}done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(Error('transport'))})})}
class BodyLimitError extends Error{}
async function bounded(response:Response,signal:AbortSignal):Promise<Uint8Array>{const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>DEED_PAGE_MAX_RESPONSE_BYTES))throw new BodyLimitError();if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>DEED_PAGE_MAX_RESPONSE_BYTES)throw new BodyLimitError();parts.push(next.value)}}finally{reader.releaseLock()}return Buffer.concat(parts.map(value=>Buffer.from(value)))}

export function deedPageRequest(slug:string,html:string){const body=JSON.stringify({slug,files:{'index.html':html}});return {body,sourceHash:sha256(html),requestHash:sha256(body)}}

export async function createDeedPageSite(input:{operationId:string;ownerAccountId:string;slug:string;html:string;token?:string},persistence:DeedPagePersistence,deps:DeedPageDependencies={}):Promise<DeedPageCreateResult>{
  const request=deedPageRequest(input.slug,input.html),intent:DeedPageIntent={operationId:input.operationId,ownerAccountId:input.ownerAccountId,slug:input.slug,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};if(!validDeedPageIntent(intent)||input.token!==undefined&&!validDeedPageToken(input.token))throw Error('deed.page 提交输入无效');
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  const controller=new AbortController(),abort=()=>controller.abort();deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)controller.abort();const timer=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(50,deps.timeoutMs??15_000)));timer.unref?.();let response:Response|undefined;
  try{
    const headers:Record<string,string>={accept:'application/json','content-type':'application/json','idempotency-key':intent.operationId,'x-client':'linkflow-desktop/1.2.19'};if(input.token)headers.authorization=`Bearer ${input.token}`;
    const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));response=await abortable(Promise.resolve(transport(DEED_PAGE_CREATE_URL,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers,body:request.body})),controller.signal,discard);
    const bytes=await bounded(response,controller.signal),opaque:DeedPageOpaqueResponse={...intent,version:1,kind:'deed_page_opaque_response',status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:sha256(bytes)};
    try{await persistence.persistOpaqueResponse(opaque)}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:false}}
    const parsed=parseStoredDeedPageCreateResponse(opaque,intent,!input.token,Buffer.byteLength(input.html,'utf8'));if('diagnostic' in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic,opaqueResponseSaved:true};
    try{await persistence.promoteCreated(parsed);return {status:'created',receipt:parsed.receipt}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}
  }catch(error){return {status:'unknown',intent,diagnostic:error instanceof BodyLimitError?'body_limit':'transport',opaqueResponseSaved:false}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort);if(response&&controller.signal.aborted)discard(response)}
}

export const deedPageTesting={topLevelKeys,VERSION,SLUG};
