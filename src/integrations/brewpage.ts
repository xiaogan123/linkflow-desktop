import {createHash} from 'node:crypto';

export const BREWPAGE_ORIGIN='https://brewpage.app';
export const BREWPAGE_OWNER_URL=`${BREWPAGE_ORIGIN}/api/owner-token`;
export const BREWPAGE_CREATE_URL=`${BREWPAGE_ORIGIN}/api/html?ns=public&ttl=30&format=markdown`;
export const BREWPAGE_MAX_RESPONSE_BYTES=128*1024;
export const BREWPAGE_MAX_REMOTE_SIZE_BYTES=2*1024*1024;
export const BREWPAGE_ID=/^[A-Za-z0-9]{10}$/;
const TOKEN=/^[A-Za-z0-9]{32}$/,HASH=/^[a-f0-9]{64}$/,UUID=/^[0-9a-f-]{36}$/i,OP=/^brewpage_[a-f0-9]{32}$/,UTC_RFC3339=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

export interface BrewPageIntent {operationId:string;ownerAccountId:string;filename:string;sourceHash:string;requestHash:string;createdAt:string}
export interface BrewPageOpaqueResponse extends BrewPageIntent {version:1;kind:'brewpage_owner_response'|'brewpage_create_response';status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string}
export interface BrewPageOwner {ownerId:string;token:string}
export interface BrewPageReceipt extends BrewPageIntent {ownerId:string;id:string;publicUrl:string;expiresAt:string;sizeBytes:number;hostingVersion:number}
export interface BrewPageRecoveryEvidence extends BrewPageReceipt {version:1;kind:'brewpage_get_recovery';recoveredAt:string;galleryBodiesBase64:string[];galleryBodySha256:string[];sourceBodyBase64:string;sourceBodySha256:string;hostingBodyBase64:string;hostingBodySha256:string}
export interface BrewPagePersistence {
  readonly ownerAccountId:string;
  persistOwnerIntent(value:BrewPageIntent,knownOwnerId?:string):Promise<void>;
  assertOwnerRequestAuthorized(value:BrewPageIntent):true;
  persistOpaqueResponse(value:BrewPageOpaqueResponse):Promise<void>;
  loadOpaqueResponse():Promise<BrewPageOpaqueResponse|undefined>;
  promoteOwner(value:BrewPageOwner):Promise<void>;
  persistCreateIntent(value:BrewPageIntent):Promise<void>;
  assertCreateAuthorized(value:BrewPageIntent):true;
  promoteReceipt(value:BrewPageReceipt):Promise<void>;
  promoteRecoveredReceipt(value:BrewPageReceipt,evidence:BrewPageRecoveryEvidence):Promise<void>;
  recordRecoveryGet():Promise<number>;
}
export interface BrewPageDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}
export type BrewPageDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'duplicate_field'|'schema'|'redirect'|'media_type'|'http_status';
export type BrewPageRemoteResult<T>={status:'ok';value:T}|{status:'unknown';diagnostic:BrewPageDiagnostic;opaqueResponseSaved:boolean};

export const brewPageHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function validBrewPageToken(value:unknown):value is string{return typeof value==='string'&&TOKEN.test(value)}
export function validBrewPageRemoteSize(value:unknown):value is number{return Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=BREWPAGE_MAX_REMOTE_SIZE_BYTES}
export function normalizeBrewPageUtcTimestamp(value:unknown):string|undefined{
  if(typeof value!=='string')return;const match=UTC_RFC3339.exec(value);if(!match)return;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),hour=Number(match[4]),minute=Number(match[5]),second=Number(match[6]),milliseconds=Number((match[7]??'').padEnd(3,'0').slice(0,3));
  if(year<1||month<1||month>12||day<1||hour>23||minute>59||second>59)return;
  const maximumDay=new Date(Date.UTC(year,month,0)).getUTCDate();if(day>maximumDay)return;
  const date=new Date(0);date.setUTCFullYear(year,month-1,day);date.setUTCHours(hour,minute,second,milliseconds);
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day||date.getUTCHours()!==hour||date.getUTCMinutes()!==minute||date.getUTCSeconds()!==second||date.getUTCMilliseconds()!==milliseconds)return;
  return date.toISOString();
}
export function brewPageOwnerId(token:string){return brewPageHash(token)}
export function brewPagePublicUrl(id:string){if(!BREWPAGE_ID.test(id))throw Error('BrewPage ID 无效');return `${BREWPAGE_ORIGIN}/public/${id}`}
export function validBrewPageIntent(value:BrewPageIntent){return OP.test(value.operationId)&&UUID.test(value.ownerAccountId)&&/^[A-Za-z0-9][A-Za-z0-9._-]{3,119}\.md$/.test(value.filename)&&HASH.test(value.sourceHash)&&HASH.test(value.requestHash)&&normalizeBrewPageUtcTimestamp(value.createdAt)===value.createdAt}
export function brewPageRequest(content:string,filename:string){const body=JSON.stringify({content,filename});return {body,sourceHash:brewPageHash(content),requestHash:brewPageHash(body)}}
export function validBrewPageHostingReadbackDelivery(value:Record<string,unknown>){return value.deliveryMode==='path'&&value.effectiveDeliveryMode==='path'&&(value.requestedDeliveryMode==='path'&&value.deliveryModeMatched===true||value.requestedDeliveryMode===null&&value.deliveryModeMatched===null)}

function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
type StrictJsonResult={ok:true;value:unknown}|{ok:false;duplicate:boolean};
function strictJson(text:string):StrictJsonResult{
  let i=0,duplicate=false;const ws=()=>{while(/[\s]/u.test(text[i]??''))i++};
  const str=()=>{const start=i;if(text[i++]!=='"')throw 0;while(i<text.length){const c=text[i++];if(c==='"')return JSON.parse(text.slice(start,i)) as string;if(c==='\\'){const e=text[i++];if(e==='u'){if(!/^[0-9a-f]{4}$/i.test(text.slice(i,i+4)))throw 0;i+=4}else if(!'"\\/bfnrt'.includes(e??''))throw 0}else if(c<' ')throw 0}throw 0};
  const value=():void=>{ws();const c=text[i];if(c==='"'){str();return}if(c==='{'){i++;ws();const keys=new Set<string>();if(text[i]==='}'){i++;return}for(;;){ws();const key=str();if(keys.has(key))duplicate=true;keys.add(key);ws();if(text[i++]!==':')throw 0;value();ws();if(text[i]===','){i++;continue}if(text[i++]==='}')return;throw 0}}if(c==='['){i++;ws();if(text[i]===']'){i++;return}for(;;){value();ws();if(text[i]===','){i++;continue}if(text[i++]===']')return;throw 0}}const match=text.slice(i).match(/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/);if(!match)throw 0;i+=match[0].length};
  try{value();ws();if(i!==text.length)return {ok:false,duplicate};const parsed=JSON.parse(text) as unknown;return duplicate?{ok:false,duplicate:true}:{ok:true,value:parsed}}catch{return {ok:false,duplicate}}
}
export function parseBrewPageStrictJson(text:string):unknown|undefined{const result=strictJson(text);return result.ok?result.value:undefined}
function decode(base64:string):string|undefined{try{const bytes=Buffer.from(base64,'base64');if(bytes.toString('base64')!==base64)return;return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}catch{return}}
function exactKeys(value:Record<string,unknown>,required:string[],optional:string[]=[]){const allowed=new Set([...required,...optional]);return required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>allowed.has(key))}

export function parseBrewPageOwnerResponse(opaque:BrewPageOpaqueResponse,intent:BrewPageIntent):BrewPageOwner|{diagnostic:BrewPageDiagnostic}{
  if(!sameIntent(opaque,intent)||opaque.kind!=='brewpage_owner_response')return {diagnostic:'schema'};const envelope=envelopeError(opaque,BREWPAGE_OWNER_URL,200);if(envelope)return {diagnostic:envelope};const text=decode(opaque.bodyBase64);if(text===undefined)return {diagnostic:'decode'};const decoded=strictJson(text);if(!decoded.ok)return {diagnostic:decoded.duplicate?'duplicate_field':'json'};const value=decoded.value;if(!object(value)||!exactKeys(value,['token','ownerId'])||!validBrewPageToken(value.token)||value.ownerId!==brewPageOwnerId(value.token))return {diagnostic:'schema'};return {token:value.token,ownerId:value.ownerId as string}
}
export function parseBrewPageCreateResponse(opaque:BrewPageOpaqueResponse,intent:BrewPageIntent,owner:BrewPageOwner,content:string,now=new Date()):BrewPageReceipt|{diagnostic:BrewPageDiagnostic}{
  if(!sameIntent(opaque,intent)||opaque.kind!=='brewpage_create_response')return {diagnostic:'schema'};if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400||opaque.responseUrl&&opaque.responseUrl!==BREWPAGE_CREATE_URL)return {diagnostic:'redirect'};if(![200,201].includes(opaque.status))return {diagnostic:'http_status'};if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};const text=decode(opaque.bodyBase64);if(text===undefined)return {diagnostic:'decode'};const decoded=strictJson(text);if(!decoded.ok)return {diagnostic:decoded.duplicate?'duplicate_field':'json'};const value=decoded.value;
  const required=['id','namespace','link','ownerLink','expiresAt','sizeBytes','tags','ownerToken','result','managementLink','routingCohort','deliveryMode','requestedDeliveryMode','effectiveDeliveryMode','deliveryModeMatched','access','modeLocked','hostingVersion'];const optional=['visibilityNotice','deliveryModeReason','deliveryNotice'];if(!object(value)||!exactKeys(value,required,optional)||!BREWPAGE_ID.test(String(value.id))||value.namespace!=='public'||value.link!==brewPagePublicUrl(String(value.id))||value.ownerLink!==`${BREWPAGE_ORIGIN}/api/html/public/${value.id}`||value.managementLink!==`${BREWPAGE_ORIGIN}/manage/html/public/${value.id}`||value.routingCohort!=='new-v1'||value.deliveryMode!=='path'||value.requestedDeliveryMode!=='path'||value.effectiveDeliveryMode!=='path'||value.deliveryModeMatched!==true||value.access!=='public'||value.modeLocked!==false||value.hostingVersion!==1||value.ownerToken!==owner.token||!validBrewPageRemoteSize(value.sizeBytes)||!Array.isArray(value.tags)||value.tags.length!==0||!object(value.result)||brewPageHash(content)!==intent.sourceHash||brewPageRequest(content,intent.filename).requestHash!==intent.requestHash)return {diagnostic:'schema'};
  const result=value.result as Record<string,unknown>,created=opaque.status===201&&result.code==='success'&&result.action==='created',duplicate=opaque.status===200&&result.code==='duplicate'&&['merged','updated'].includes(String(result.action));if(!created&&!duplicate||!exactKeys(result,['code','action'],['reason','extras']))return {diagnostic:'schema'};const expiresAt=normalizeBrewPageUtcTimestamp(value.expiresAt),createdAt=normalizeBrewPageUtcTimestamp(intent.createdAt);if(!expiresAt||!createdAt||!Number.isFinite(now.getTime()))return {diagnostic:'schema'};const expires=Date.parse(expiresAt),createdAtMs=Date.parse(createdAt);if(expires<=now.getTime()||expires<=createdAtMs||expires>createdAtMs+30*86400000+300000)return {diagnostic:'schema'};return {...intent,ownerId:owner.ownerId,id:String(value.id),publicUrl:String(value.link),expiresAt,sizeBytes:Number(value.sizeBytes),hostingVersion:1}
}

function sameIntent(a:BrewPageIntent,b:BrewPageIntent){return a.operationId===b.operationId&&a.ownerAccountId===b.ownerAccountId&&a.filename===b.filename&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}
function envelopeError(opaque:BrewPageOpaqueResponse,url:string,status:number):BrewPageDiagnostic|undefined{if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400||opaque.responseUrl&&opaque.responseUrl!==url)return 'redirect';if(opaque.status!==status)return 'http_status';if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return 'media_type'}
function discard(response:Response){if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
const pending=new Set<Promise<void>>();function track(value:Promise<void>){pending.add(value);void value.finally(()=>pending.delete(value))}
export async function drainBrewPageLateResponses(timeoutMs=15000){const deadline=Date.now()+timeoutMs;while(pending.size&&Date.now()<deadline){await Promise.race([Promise.allSettled([...pending]),new Promise(resolve=>setTimeout(resolve,Math.max(1,Math.min(100,deadline-Date.now()))))])}return pending.size===0}
function abortable<T>(promise:Promise<T>,signal:AbortSignal,late?:(value:T)=>Promise<void>):Promise<T>{if(signal.aborted){if(late)track(promise.then(late,()=>undefined));return Promise.reject(Error('abort'))}return new Promise((resolve,reject)=>{let done=false,lateTracked=false;const preserveLate=()=>{if(late&&!lateTracked){lateTracked=true;track(promise.then(late,()=>undefined))}};const stop=()=>{if(done)return;done=true;preserveLate();reject(Error('abort'))};signal.addEventListener('abort',stop,{once:true});void promise.then(value=>{signal.removeEventListener('abort',stop);if(done){preserveLate();return}done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(Error('transport'))})})}
class BodyLimitError extends Error{}
async function bounded(response:Response,signal:AbortSignal,abort=()=>{}):Promise<Uint8Array>{
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>BREWPAGE_MAX_RESPONSE_BYTES)){abort();discard(response);throw new BodyLimitError()}
  if(!response.body)return new Uint8Array();
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0,complete=false;
  try{
    for(;;){const item=await abortable(reader.read(),signal);if(item.done){complete=true;break}size+=item.value.byteLength;if(size>BREWPAGE_MAX_RESPONSE_BYTES){abort();void reader.cancel().catch(()=>undefined);throw new BodyLimitError()}parts.push(item.value)}
  }catch(error){abort();void reader.cancel().catch(()=>undefined);throw error}
  finally{if(!complete)void reader.cancel().catch(()=>undefined);try{reader.releaseLock()}catch{}}
  return Buffer.concat(parts.map(value=>Buffer.from(value)));
}
function opaque(response:Response,bytes:Uint8Array,intent:BrewPageIntent,kind:BrewPageOpaqueResponse['kind']):BrewPageOpaqueResponse{return {...intent,version:1,kind,status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:brewPageHash(bytes)}}

async function requestOpaque(url:string,init:RequestInit,intent:BrewPageIntent,kind:BrewPageOpaqueResponse['kind'],persistence:BrewPagePersistence,deps:BrewPageDependencies):Promise<BrewPageRemoteResult<BrewPageOpaqueResponse>>{const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const timer=setTimeout(()=>controller.abort(),Math.min(60000,Math.max(50,deps.timeoutMs??20000)));timer.unref?.();const preserve=async(response:Response)=>{try{const c=new AbortController(),t=setTimeout(()=>c.abort(),15000);t.unref?.();try{await persistence.persistOpaqueResponse(opaque(response,await bounded(response,c.signal,()=>c.abort()),intent,kind))}finally{clearTimeout(t)}}catch{discard(response)}};try{const transport=deps.fetch??((u:string,i:RequestInit)=>fetch(u,i)),response=await abortable(Promise.resolve(transport(url,{...init,signal:controller.signal})),controller.signal,preserve),saved=opaque(response,await bounded(response,controller.signal,()=>controller.abort()),intent,kind);try{await persistence.persistOpaqueResponse(saved)}catch{return {status:'unknown',diagnostic:'opaque_persistence',opaqueResponseSaved:false}}return {status:'ok',value:saved}}catch(error){return {status:'unknown',diagnostic:error instanceof BodyLimitError?'body_limit':'transport',opaqueResponseSaved:false}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external)}}

export async function mintBrewPageOwner(intent:BrewPageIntent,persistence:BrewPagePersistence,deps:BrewPageDependencies={}):Promise<BrewPageRemoteResult<BrewPageOwner>>{await persistence.persistOwnerIntent(intent);try{persistence.assertOwnerRequestAuthorized(intent)}catch{return {status:'unknown',diagnostic:'transport',opaqueResponseSaved:false}}const raw=await requestOpaque(BREWPAGE_OWNER_URL,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{accept:'application/json','user-agent':'Mozilla/5.0'}},intent,'brewpage_owner_response',persistence,deps);if(raw.status==='unknown')return raw;const parsed=parseBrewPageOwnerResponse(raw.value,intent);if('diagnostic' in parsed)return {status:'unknown',diagnostic:parsed.diagnostic,opaqueResponseSaved:true};try{await persistence.promoteOwner(parsed);return {status:'ok',value:parsed}}catch{return {status:'unknown',diagnostic:'opaque_persistence',opaqueResponseSaved:true}}}
export async function createBrewPage(intent:BrewPageIntent,content:string,owner:BrewPageOwner,persistence:BrewPagePersistence,deps:BrewPageDependencies={}):Promise<BrewPageRemoteResult<BrewPageReceipt>>{if(brewPageHash(content)!==intent.sourceHash)return {status:'unknown',diagnostic:'schema',opaqueResponseSaved:false};try{await persistence.persistCreateIntent(intent);persistence.assertCreateAuthorized(intent)}catch{return {status:'unknown',diagnostic:'transport',opaqueResponseSaved:false}}const raw=await requestOpaque(BREWPAGE_CREATE_URL,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{accept:'application/json','content-type':'application/json','user-agent':'Mozilla/5.0','x-owner-token':owner.token,'x-delivery-mode':'path'},body:JSON.stringify({content,filename:intent.filename})},intent,'brewpage_create_response',persistence,deps);if(raw.status==='unknown')return raw;const parsed=parseBrewPageCreateResponse(raw.value,intent,owner,content,deps.now?.()??new Date());if('diagnostic' in parsed)return {status:'unknown',diagnostic:parsed.diagnostic,opaqueResponseSaved:true};try{await persistence.promoteReceipt(parsed);return {status:'ok',value:parsed}}catch{return {status:'unknown',diagnostic:'opaque_persistence',opaqueResponseSaved:true}}}

export const brewPageTesting={strictJson,sameIntent};
