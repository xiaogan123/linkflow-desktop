import {createHash} from 'node:crypto';

export const NOTEBIN_ORIGIN='https://notebin.ca';
export const NOTEBIN_AUTHORITY_ORIGIN='https://pastebin.ca';
export const NOTEBIN_CHALLENGE_URL=`${NOTEBIN_AUTHORITY_ORIGIN}/api/v1/auth/pow/challenge`;
export const NOTEBIN_SIGNUP_URL=`${NOTEBIN_AUTHORITY_ORIGIN}/api/v1/auth/pow/signup`;
export const NOTEBIN_WHOAMI_URL=`${NOTEBIN_AUTHORITY_ORIGIN}/api/v1/auth/whoami`;
export const NOTEBIN_KEYS_URL=`${NOTEBIN_AUTHORITY_ORIGIN}/api/v1/account/keys`;
export const NOTEBIN_NOTES_URL=`${NOTEBIN_ORIGIN}/api/v1/notes`;
export const NOTEBIN_OWNED_ITEMS_URL=`${NOTEBIN_ORIGIN}/api/v1/account/items`;
export const NOTEBIN_IMPLEMENTATION_CONTRACT_SHA256='177f7746e5851d9522bb56e964d9220d148d83f7ee53c7729a119f25e2695b6a';
export const NOTEBIN_MAX_CHALLENGE_BYTES=16*1024;
export const NOTEBIN_MAX_AUTH_RESPONSE_BYTES=64*1024;
export const NOTEBIN_MAX_ITEM_RESPONSE_BYTES=512*1024;
export const NOTEBIN_MAX_MARKDOWN_BYTES=256*1024;
export const NOTEBIN_MAX_POW_DIFFICULTY_BITS=22;
export const NOTEBIN_MAX_POW_ATTEMPTS=4_194_304;
export const NOTEBIN_MAX_POW_MS=15_000;

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const OPERATION=/^notebin_(?:signup|mint|publish)_[a-f0-9]{32}$/;
const ACCOUNT_ID=/^[A-Za-z0-9_-]{8,128}$/;
const CHALLENGE_ID=/^[A-Za-z0-9._~:-]{8,512}$/;
const API_KEY=/^pbca_live_[\x21-\x7e]{8,1000}$/;
const ITEM_ID=/^[A-Za-z0-9_-]{1,128}$/;

export type NotebinOperation='signup'|'mint'|'publish';
export interface NotebinRuntimeGate {
  version:1;
  service:'notebin.ca';
  contractSha256:typeof NOTEBIN_IMPLEMENTATION_CONTRACT_SHA256;
  sourceHarnessSha256:string;
  approvedAt:string;
  approvedOperations:readonly NotebinOperation[];
}
export interface NotebinSignupClaim {
  version:1;
  operation:'signup';
  operationId:string;
  localAccountId:string;
  displayNameHash:string;
  createdAt:string;
}
export interface NotebinPowChallenge {
  challengeId:string;
  prefix:string;
  difficultyBits:number;
  expiresAt?:number;
  responseHash:string;
}
export interface NotebinIntent {
  version:1;
  operation:NotebinOperation;
  operationId:string;
  localAccountId:string;
  rootAccountId?:string;
  createdAt:string;
  requestHash:string;
  sourceHash?:string;
  noteKeyFingerprint?:string;
}
export interface NotebinOpaqueResponse extends NotebinIntent {
  kind:'notebin_opaque_response';
  status:number;
  contentType:string;
  responseUrl:string;
  redirected:boolean;
  responseType:string;
  bodyBase64:string;
  bodySha256:string;
}
export interface NotebinIdentityReceipt {
  localAccountId:string;
  rootAccountId:string;
  createdAt:string;
  signupRequestHash:string;
}
export interface NotebinRootIdentityBinding {
  localAccountId:string;
  rootAccountId:string;
  rootKeyFingerprint:string;
  whoamiResponseHash:string;
  keyListResponseHash?:string;
  verifiedAt:string;
  binding:'exact_readback';
}
export interface NotebinKeyReceipt {
  localAccountId:string;
  rootAccountId:string;
  audience:typeof NOTEBIN_ORIGIN;
  scopes:readonly ['note:read','note:create'];
  tokenFingerprint:string;
  binding:'exact_response'|'exact_readback'|'pending_readback';
  keyId?:string;
  readbackResponseHash?:string;
  readbackVerifiedAt?:string;
  createdAt:string;
  requestHash:string;
}
export interface NotebinContentApproval {
  version:1;
  sourceHash:string;
  requestHash:string;
  approvedAt:string;
  reviewer:string;
}
export interface NotebinPublicationReceipt {
  operationId:string;
  localAccountId:string;
  rootAccountId:string;
  noteKeyFingerprint:string;
  requestHash:string;
  sourceHash:string;
  createdAt:string;
  itemId:string;
  publicUrl:string;
  viewUrl:string;
  rawUrl:string;
  remoteCreatedAt:number;
  retention:'no_scheduled_expiry'|'expiring'|'unknown';
  expiresAt?:number|null;
  ownership:'pending'|'owned_list_match';
}
export interface NotebinItem {
  id:string;
  kind:'note';
  title:string|null;
  description:string|null;
  visibility:'public'|'unlisted';
  contentType:string|null;
  sizeBytes:number;
  createdAt:number;
  expiresAt?:number|null;
  expiresAtPresent:boolean;
  views:number;
  url:string;
  viewUrl:string;
  rawUrl:string;
  markdown?:string;
  scanState?:string;
}
export interface NotebinRecoveryContract {
  version:1;
  contractSha256:typeof NOTEBIN_IMPLEMENTATION_CONTRACT_SHA256;
  sourceHarnessSha256:string;
  observedAt:string;
  scanStateRequired:boolean;
  acceptedScanStates:readonly string[];
  maxOwnedPages:number;
  ownedPageLimit:number;
  recoveryWindowMs:number;
}
export interface NotebinRecoveryPage {
  cursor:string|null;
  nextCursor:string|null;
  items:NotebinItem[];
}
export interface NotebinRecoveryEvidenceBase {
  version:1;
  provenance:'bounded_owned_list_and_detail';
  operationId:string;
  localAccountId:string;
  rootAccountId:string;
  noteKeyFingerprint:string;
  sourceHash:string;
  requestHash:string;
  intentCreatedAt:string;
  recoveredAt:string;
  contract:NotebinRecoveryContract;
  pages:NotebinRecoveryPage[];
  detail:NotebinItem;
}
export interface NotebinRecoveryEvidence extends NotebinRecoveryEvidenceBase {
  originalStage:'intent'|'opaque_response';
}
export interface NotebinIdentityBinding {
  localAccountId:string;
  rootAccountId:string;
  audience:typeof NOTEBIN_ORIGIN;
  scopes:readonly ['note:read','note:create'];
  tokenFingerprint:string;
  binding:'exact_response'|'exact_readback';
}
export interface NotebinSignupState {
  claim:NotebinSignupClaim;
  challenge?:NotebinPowChallenge;
  intent?:NotebinIntent;
  opaque?:NotebinOpaqueResponse;
  receipt?:NotebinIdentityReceipt;
}
export interface NotebinSignupPersistence {
  claimSignup(claim:NotebinSignupClaim):Promise<'claimed'|'existing'>;
  loadSignupState():Promise<NotebinSignupState|undefined>;
  persistChallenge(claim:NotebinSignupClaim,challenge:NotebinPowChallenge):Promise<void>;
  persistIntent(intent:NotebinIntent):Promise<void>;
  assertAuthorized(intent:NotebinIntent):true|Promise<true>;
  persistOpaqueResponse(response:NotebinOpaqueResponse):Promise<void>;
  promoteIdentity(receipt:NotebinIdentityReceipt,rootApiKey:string):Promise<void>;
}
export interface NotebinMintPersistence {
  claimIntent(intent:NotebinIntent):Promise<'claimed'|'existing'>;
  loadOpaqueResponse():Promise<NotebinOpaqueResponse|undefined>;
  assertAuthorized(intent:NotebinIntent):true|Promise<true>;
  persistOpaqueResponse(response:NotebinOpaqueResponse):Promise<void>;
  promoteKey(receipt:NotebinKeyReceipt,noteApiKey:string):Promise<void>;
}
export interface NotebinPublicationPersistence {
  claimIntent(intent:NotebinIntent):Promise<'claimed'|'existing'>;
  loadOpaqueResponse():Promise<NotebinOpaqueResponse|undefined>;
  assertAuthorized(intent:NotebinIntent):true|Promise<true>;
  persistOpaqueResponse(response:NotebinOpaqueResponse):Promise<void>;
  preserveReceipt(receipt:NotebinPublicationReceipt):Promise<void>;
  preserveRecoveredReceipt(receipt:NotebinPublicationReceipt,evidence:NotebinRecoveryEvidenceBase):Promise<void>;
  promoteOwned?(receipt:NotebinPublicationReceipt):Promise<void>;
}
export interface NotebinDependencies {
  fetch?:(url:string,init:RequestInit)=>Promise<Response>;
  now?:()=>Date;
  monotonicNow?:()=>number;
  timeoutMs?:number;
  signal?:AbortSignal;
  gate?:NotebinRuntimeGate;
  pow?:{maxDifficultyBits?:number;maxAttempts?:number;maxMs?:number;yieldEvery?:number};
}
export type NotebinIdentityResult=
  |{status:'ready';receipt:NotebinIdentityReceipt}
  |{status:'not_started';reason:'runtime_gate_closed'|'invalid_pow_limits'|'intent_conflict'}
  |{status:'unknown';reason:string;opaqueSaved:boolean};
export type NotebinMintResult=
  |{status:'ready'|'pending_binding';receipt:NotebinKeyReceipt}
  |{status:'not_started';reason:'runtime_gate_closed'|'intent_conflict'|'invalid_root_identity'}
  |{status:'unknown';reason:string;opaqueSaved:boolean};
export type NotebinPublishResult=
  |{status:'created'|'pending_retention';receipt:NotebinPublicationReceipt}
  |{status:'not_started';reason:'runtime_gate_closed'|'intent_conflict'|'approval_mismatch'|'invalid_key_binding'|'request_too_large'}
  |{status:'unknown';reason:string;opaqueSaved:boolean};

const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exactDate=(value:string)=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const sortedUnique=(values:readonly string[])=>[...new Set(values)].sort();
const exactKeys=(value:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[])=>{
  const keys=Object.keys(value),allowed=new Set([...required,...optional]);
  return required.every(key=>Object.hasOwn(value,key))&&keys.every(key=>allowed.has(key));
};
export const notebinTokenFingerprint=(token:string)=>sha256(`notebin-token\0${token}`);

export function validNotebinRuntimeGate(gate:NotebinRuntimeGate|undefined,operation:NotebinOperation){
  return !!gate&&gate.version===1&&gate.service==='notebin.ca'&&gate.contractSha256===NOTEBIN_IMPLEMENTATION_CONTRACT_SHA256&&HASH.test(gate.sourceHarnessSha256)&&exactDate(gate.approvedAt)&&gate.approvedOperations.includes(operation);
}
export function validNotebinIntent(value:NotebinIntent){
  if(value.version!==1||!['signup','mint','publish'].includes(value.operation)||!OPERATION.test(value.operationId)||!UUID.test(value.localAccountId)||!exactDate(value.createdAt)||!HASH.test(value.requestHash))return false;
  if(value.operation==='signup')return value.rootAccountId===undefined&&value.sourceHash===undefined&&value.noteKeyFingerprint===undefined;
  if(!value.rootAccountId||!ACCOUNT_ID.test(value.rootAccountId))return false;
  if(value.operation==='mint')return value.sourceHash===undefined&&value.noteKeyFingerprint===undefined;
  return !!value.sourceHash&&HASH.test(value.sourceHash)&&!!value.noteKeyFingerprint&&HASH.test(value.noteKeyFingerprint);
}
export function validNotebinSignupClaim(value:NotebinSignupClaim){return value.version===1&&value.operation==='signup'&&OPERATION.test(value.operationId)&&UUID.test(value.localAccountId)&&HASH.test(value.displayNameHash)&&exactDate(value.createdAt)}
function sameClaim(a:NotebinSignupClaim,b:NotebinSignupClaim){return a.version===b.version&&a.operation===b.operation&&a.operationId===b.operationId&&a.localAccountId===b.localAccountId&&a.displayNameHash===b.displayNameHash&&a.createdAt===b.createdAt}
export function sameNotebinIntent(a:NotebinIntent,b:NotebinIntent){return a.version===b.version&&a.operation===b.operation&&a.operationId===b.operationId&&a.localAccountId===b.localAccountId&&a.rootAccountId===b.rootAccountId&&a.createdAt===b.createdAt&&a.requestHash===b.requestHash&&a.sourceHash===b.sourceHash&&a.noteKeyFingerprint===b.noteKeyFingerprint}

function topLevelKeys(text:string):string[]|undefined{
  let index=0;const whitespace=()=>{while(/\s/u.test(text[index]??''))index++};
  const readString=()=>{const start=index;if(text[index++]!=='"')return;while(index<text.length){const char=text[index++];if(char==='"'){try{const parsed=JSON.parse(text.slice(start,index));return typeof parsed==='string'?parsed:undefined}catch{return}}if(char==='\\'){const escape=text[index++];if(escape==='u'){const hex=text.slice(index,index+4);if(!/^[0-9a-f]{4}$/i.test(hex))return;index+=4}else if(!'"\\/bfnrt'.includes(escape??''))return}else if(char<' ')return}};
  const skipValue=()=>{whitespace();if(text[index]==='"')return readString()!==undefined;let depth=0,inString=false,escaped=false;for(;index<text.length;index++){const char=text[index];if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;continue}if(char==='"'){inString=true;continue}if(char==='{'||char==='['){depth++;continue}if(char==='}'||char===']'){if(depth===0)return true;depth--;continue}if(depth===0&&char===',')return true}return !inString&&depth===0};
  whitespace();if(text[index++]!=='{')return;const keys:string[]=[];whitespace();if(text[index]==='}')return keys;for(;;){whitespace();const key=readString();if(key===undefined)return;keys.push(key);whitespace();if(text[index++]!==':')return;if(!skipValue())return;whitespace();if(text[index]===','){index++;continue}if(text[index]==='}'){index++;whitespace();return index===text.length?keys:undefined}return}
}
function strictJson(bytes:Uint8Array):{value:unknown;keys:string[]}|undefined{
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}catch{return}
  const keys=topLevelKeys(text);if(!keys||new Set(keys).size!==keys.length)return;
  try{return {value:JSON.parse(text) as unknown,keys}}catch{return}
}
function safeSameOriginUrl(value:unknown,origin:string,itemId?:string){
  if(typeof value!=='string'||value.length>2048)return;
  try{const url=new URL(value);if(url.origin!==origin||url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.pathname.length>1024||url.pathname.includes('/../')||url.pathname.includes('/./'))return;if(itemId&&!url.pathname.split('/').map(segment=>decodeURIComponent(segment)).includes(itemId))return;return url.href}catch{return}
}
function validRootKey(value:unknown):value is string{return typeof value==='string'&&API_KEY.test(value)&&!/[\s,;]/.test(value)}
function validAccountId(value:unknown):value is string{return typeof value==='string'&&ACCOUNT_ID.test(value)}
function contentTypeJson(value:string){return value.split(';',1)[0].trim().toLowerCase()==='application/json'}

export function parseNotebinChallenge(bytes:Uint8Array):NotebinPowChallenge|undefined{
  const decoded=strictJson(bytes);if(!decoded||!object(decoded.value)||!exactKeys(decoded.value,['challenge_id','prefix','difficulty_bits'],['expires_at','hint']))return;
  const value=decoded.value;if(typeof value.challenge_id!=='string'||!CHALLENGE_ID.test(value.challenge_id)||typeof value.prefix!=='string'||value.prefix.length<1||Buffer.byteLength(value.prefix,'utf8')>512||!Number.isInteger(value.difficulty_bits)||Number(value.difficulty_bits)<1||Number(value.difficulty_bits)>NOTEBIN_MAX_POW_DIFFICULTY_BITS)return;
  if(Object.hasOwn(value,'expires_at')&&(!Number.isSafeInteger(value.expires_at)||Number(value.expires_at)<0)||Object.hasOwn(value,'hint')&&(typeof value.hint!=='string'||Buffer.byteLength(value.hint,'utf8')>4096))return;
  return {challengeId:value.challenge_id,prefix:value.prefix,difficultyBits:Number(value.difficulty_bits),...(Object.hasOwn(value,'expires_at')?{expiresAt:Number(value.expires_at)}:{}),responseHash:sha256(bytes)};
}
function leadingZeroBits(bytes:Uint8Array){let bits=0;for(const byte of bytes){if(byte===0){bits+=8;continue}for(let mask=0x80;(byte&mask)===0;mask>>=1)bits++;break}return bits}
export async function solveNotebinPow(challenge:NotebinPowChallenge,options:NotebinDependencies['pow']={},signal?:AbortSignal,clock:()=>number=()=>performance.now(),wallClock:()=>number=()=>Date.now()):Promise<number|undefined>{
  const maxDifficulty=Math.min(NOTEBIN_MAX_POW_DIFFICULTY_BITS,Math.max(1,options?.maxDifficultyBits??NOTEBIN_MAX_POW_DIFFICULTY_BITS));
  const maxAttempts=Math.min(NOTEBIN_MAX_POW_ATTEMPTS,Math.max(1,options?.maxAttempts??NOTEBIN_MAX_POW_ATTEMPTS));
  const maxMs=Math.min(NOTEBIN_MAX_POW_MS,Math.max(10,options?.maxMs??NOTEBIN_MAX_POW_MS));
  const yieldEvery=Math.min(65_536,Math.max(64,options?.yieldEvery??4096));
  if(challenge.difficultyBits>maxDifficulty||challenge.expiresAt!==undefined&&challenge.expiresAt<=wallClock())return;
  const started=clock();
  for(let nonce=0;nonce<maxAttempts;nonce++){
    if(signal?.aborted||clock()-started>maxMs||challenge.expiresAt!==undefined&&challenge.expiresAt<=wallClock())return;
    const digest=createHash('sha256').update(challenge.prefix+String(nonce)).digest();
    if(leadingZeroBits(digest)>=challenge.difficultyBits)return nonce;
    if(nonce>0&&nonce%yieldEvery===0)await new Promise<void>(resolve=>setImmediate(resolve));
  }
}

class RequestFailure extends Error{constructor(readonly kind:'timeout'|'transport'|'body_limit'|'route'|'decode'){super(kind)}}
function routeAllowed(url:string){return [NOTEBIN_CHALLENGE_URL,NOTEBIN_SIGNUP_URL,NOTEBIN_WHOAMI_URL,NOTEBIN_KEYS_URL,NOTEBIN_NOTES_URL].includes(url)}
function timerSignal(timeoutMs:number,external?:AbortSignal){const controller=new AbortController(),abort=()=>controller.abort();external?.addEventListener('abort',abort,{once:true});if(external?.aborted)controller.abort();const timer=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(1,timeoutMs)));timer.unref?.();return {signal:controller.signal,stop:()=>{clearTimeout(timer);external?.removeEventListener('abort',abort)}}}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void){if(signal.aborted){void pending.then(value=>late?.(value),()=>undefined);return Promise.reject(new RequestFailure('timeout'))}return new Promise<T>((resolve,reject)=>{let finished=false;const abort=()=>{if(finished)return;finished=true;reject(new RequestFailure('timeout'))};signal.addEventListener('abort',abort,{once:true});void pending.then(value=>{signal.removeEventListener('abort',abort);if(finished){late?.(value);return}finished=true;resolve(value)},error=>{signal.removeEventListener('abort',abort);if(finished)return;finished=true;reject(error instanceof RequestFailure?error:new RequestFailure('transport'))})})}
function discard(response:Response){if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
async function boundedBytes(response:Response,maximum:number,signal:AbortSignal){
  const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum)){discard(response);throw new RequestFailure('body_limit')}
  const chunks:Uint8Array[]=[];let size=0;if(response.body){const reader=response.body.getReader();try{for(;;){const item=await abortable(reader.read(),signal);if(item.done)break;size+=item.value.byteLength;if(size>maximum)throw new RequestFailure('body_limit');chunks.push(item.value)}}catch(error){void reader.cancel().catch(()=>undefined);throw error}finally{try{reader.releaseLock()}catch{/* A stalled underlying read may retain its discarded lock until cancellation settles. */}}}
  return Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)));
}
function responseMatches(response:Response,url:string){return !response.redirected&&response.type!=='opaqueredirect'&&!(response.status>=300&&response.status<400)&&(!response.url||response.url===url)}
function makeOpaque(response:Response,bytes:Uint8Array,intent:NotebinIntent):NotebinOpaqueResponse{return {...intent,kind:'notebin_opaque_response',status:response.status,contentType:(response.headers.get('content-type')??'').slice(0,512),responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:sha256(bytes)}}
export function inspectNotebinOpaqueResponse(value:NotebinOpaqueResponse,maximum=NOTEBIN_MAX_ITEM_RESPONSE_BYTES){
  if(value.kind!=='notebin_opaque_response'||!validNotebinIntent(value)||!Number.isInteger(value.status)||value.status<100||value.status>599||typeof value.contentType!=='string'||value.contentType.length>512||typeof value.responseUrl!=='string'||value.responseUrl.length>2048||typeof value.redirected!=='boolean'||typeof value.responseType!=='string'||value.responseType.length>64||typeof value.bodyBase64!=='string'||!HASH.test(value.bodySha256))return {valid:false as const};
  const bytes=Buffer.from(value.bodyBase64,'base64');if(bytes.length>maximum||bytes.toString('base64')!==value.bodyBase64||sha256(bytes)!==value.bodySha256)return {valid:false as const};return {valid:true as const,bytes};
}
async function capturedRequest(url:string,init:RequestInit,maximum:number,deps:NotebinDependencies,onCaptured:(response:Response,bytes:Uint8Array)=>Promise<void>){
  if(!routeAllowed(url))throw new RequestFailure('route');const timeout=deps.timeoutMs??20_000,foreground=timerSignal(timeout,deps.signal),transport=deps.fetch??((input:string,options:RequestInit)=>fetch(input,options));
  const pending=Promise.resolve(transport(url,{...init,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:foreground.signal}));
  const captured=pending.then(async response=>{const bodyClock=timerSignal(timeout);try{const bytes=await boundedBytes(response,maximum,bodyClock.signal);await onCaptured(response,bytes);return {response,bytes}}finally{bodyClock.stop()}});
  try{return await abortable(captured,foreground.signal)}finally{foreground.stop();void captured.catch(()=>undefined)}
}
function safeReason(error:unknown){return error instanceof RequestFailure?error.kind:'persistence_or_contract'}
function signupBody(challenge:NotebinPowChallenge,nonce:number,displayName:string){return JSON.stringify({challenge_id:challenge.challengeId,nonce:String(nonce),display_name:displayName})}
function mintBody(){return JSON.stringify({audience:NOTEBIN_ORIGIN,scopes:['note:read','note:create']})}
export function notebinNoteRequest(title:string,description:string,markdown:string){
  if(typeof title!=='string'||!title.trim()||title.length>300||typeof description!=='string'||description.length>1000||typeof markdown!=='string'||!markdown.trim())throw Error('Notebin 稿件输入无效');
  const sourceBytes=Buffer.byteLength(markdown,'utf8');if(sourceBytes>NOTEBIN_MAX_MARKDOWN_BYTES)throw Error('Notebin 稿件超过 256 KiB');
  const value={markdown,title,description,visibility:'public' as const},body=JSON.stringify(value);return {value,body,sourceBytes,sourceHash:sha256(markdown),requestHash:sha256(body)};
}

function parseSignupOpaque(opaque:NotebinOpaqueResponse,intent:NotebinIntent){
  const inspected=inspectNotebinOpaqueResponse(opaque,NOTEBIN_MAX_AUTH_RESPONSE_BYTES);if(!inspected.valid||!sameNotebinIntent(opaque,intent)||!responseMatches(opaqueLike(opaque),NOTEBIN_SIGNUP_URL)||opaque.status!==200||!contentTypeJson(opaque.contentType))return;
  const decoded=strictJson(inspected.bytes);if(!decoded||!object(decoded.value)||!exactKeys(decoded.value,['account_id','api_key'])||!validAccountId(decoded.value.account_id)||!validRootKey(decoded.value.api_key))return;
  return {rootAccountId:decoded.value.account_id,rootApiKey:decoded.value.api_key};
}
function opaqueLike(value:NotebinOpaqueResponse){return {redirected:value.redirected,type:value.responseType,status:value.status,url:value.responseUrl} as Response}

export async function createNotebinIdentity(input:{operationId:string;localAccountId:string;displayName:string;createdAt:string},persistence:NotebinSignupPersistence,deps:NotebinDependencies={}):Promise<NotebinIdentityResult>{
  if(!validNotebinRuntimeGate(deps.gate,'signup'))return {status:'not_started',reason:'runtime_gate_closed'};
  if(!OPERATION.test(input.operationId)||!UUID.test(input.localAccountId)||!exactDate(input.createdAt)||typeof input.displayName!=='string'||input.displayName.trim()!==input.displayName||input.displayName.length<3||input.displayName.length>80||/[\u0000-\u001f\u007f]/.test(input.displayName))return {status:'not_started',reason:'intent_conflict'};
  const claim:NotebinSignupClaim={version:1,operation:'signup',operationId:input.operationId,localAccountId:input.localAccountId,displayNameHash:sha256(input.displayName),createdAt:input.createdAt};
  let claimed:'claimed'|'existing';try{claimed=await persistence.claimSignup(claim)}catch{return {status:'not_started',reason:'intent_conflict'}}
  let state=await persistence.loadSignupState();if(!state||!sameClaim(state.claim,claim))return {status:'not_started',reason:'intent_conflict'};
  if(state.receipt)return {status:'ready',receipt:state.receipt};
  const wallClock=()=> (deps.now?.()??new Date()).getTime();
  let challenge=state.challenge;
  if(challenge?.expiresAt!==undefined&&challenge.expiresAt<=wallClock()&&!state.intent&&!state.opaque)challenge=undefined;
  if(!challenge){
    if(state.intent||state.opaque)return {status:'unknown',reason:'注册请求已声明但挑战回执缺失；不会重取挑战或重复注册',opaqueSaved:!!state.opaque};
    try{await capturedRequest(NOTEBIN_CHALLENGE_URL,{method:'GET',headers:{accept:'application/json'}},NOTEBIN_MAX_CHALLENGE_BYTES,deps,async(response,bytes)=>{if(!responseMatches(response,NOTEBIN_CHALLENGE_URL)||response.status!==200||!contentTypeJson(response.headers.get('content-type')??''))throw new RequestFailure('decode');const parsed=parseNotebinChallenge(bytes);if(!parsed||parsed.expiresAt!==undefined&&parsed.expiresAt<=wallClock())throw new RequestFailure('decode');await persistence.persistChallenge(claim,parsed);challenge=parsed})}catch(error){return {status:'unknown',reason:`PoW 挑战未形成可复用回执（${safeReason(error)}）；不会自动重建身份`,opaqueSaved:false}}
  }
  if(!challenge||challenge.difficultyBits>(deps.pow?.maxDifficultyBits??NOTEBIN_MAX_POW_DIFFICULTY_BITS))return {status:'not_started',reason:'invalid_pow_limits'};
  let intent=state.intent,body:string|undefined;
  if(!intent){const nonce=await solveNotebinPow(challenge,deps.pow,deps.signal,deps.monotonicNow,wallClock);if(nonce===undefined){if(challenge.expiresAt!==undefined&&challenge.expiresAt<=wallClock())return {status:'unknown',reason:'PoW 挑战在求解期间过期；未发送注册请求',opaqueSaved:false};return {status:'not_started',reason:'invalid_pow_limits'}}body=signupBody(challenge,nonce,input.displayName);if(challenge.expiresAt!==undefined&&challenge.expiresAt<=wallClock())return {status:'unknown',reason:'PoW 挑战在注册意图持久化前过期；未发送注册请求',opaqueSaved:false};intent={version:1,operation:'signup',operationId:input.operationId,localAccountId:input.localAccountId,createdAt:input.createdAt,requestHash:sha256(body)};try{await persistence.persistIntent(intent)}catch{return {status:'unknown',reason:'注册请求意图未能持久化；未发送注册请求',opaqueSaved:false}}}
  else if(!validNotebinIntent(intent)||intent.operation!=='signup')return {status:'not_started',reason:'intent_conflict'};
  let opaque=state.opaque,opaqueSaved=!!opaque;
  if(!opaque){
    if(!body)return {status:'unknown',reason:'注册请求已声明但请求体不可重建；不会重复挑战或注册',opaqueSaved:false};
    try{if(await persistence.assertAuthorized(intent)!==true)throw Error('authorization');if(challenge.expiresAt!==undefined&&challenge.expiresAt<=wallClock())return {status:'unknown',reason:'PoW 挑战在注册派发前过期；未发送注册请求',opaqueSaved:false};await capturedRequest(NOTEBIN_SIGNUP_URL,{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body},NOTEBIN_MAX_AUTH_RESPONSE_BYTES,deps,async(response,bytes)=>{const value=makeOpaque(response,bytes,intent!);await persistence.persistOpaqueResponse(value);opaque=value;opaqueSaved=true})}catch(error){return {status:'unknown',reason:`注册结果不明（${safeReason(error)}）；不会重复注册`,opaqueSaved}}
  }
  if(!opaque)return {status:'unknown',reason:'注册结果缺失；不会重复注册',opaqueSaved};
  const parsed=parseSignupOpaque(opaque,intent);if(!parsed)return {status:'unknown',reason:'注册原始响应不符合冻结契约；已保留且不会重发',opaqueSaved:true};
  const receipt:NotebinIdentityReceipt={localAccountId:input.localAccountId,rootAccountId:parsed.rootAccountId,createdAt:input.createdAt,signupRequestHash:intent.requestHash};
  try{await persistence.promoteIdentity(receipt,parsed.rootApiKey)}catch{return {status:'unknown',reason:'注册密钥已返回但本机原子保存未完成；不会重发',opaqueSaved:true}}
  return {status:'ready',receipt};
}

function parseMintOpaque(opaque:NotebinOpaqueResponse,intent:NotebinIntent){
  const inspected=inspectNotebinOpaqueResponse(opaque,NOTEBIN_MAX_AUTH_RESPONSE_BYTES);if(!inspected.valid||!sameNotebinIntent(opaque,intent)||!responseMatches(opaqueLike(opaque),NOTEBIN_KEYS_URL)||opaque.status!==200||!contentTypeJson(opaque.contentType))return;
  const decoded=strictJson(inspected.bytes);if(!decoded||!object(decoded.value))return;const value=decoded.value,allowed=['id','prefix','label','scopes','created_at','last_used_at','revoked_at','expires_at','audience','token'];if(!Object.keys(value).every(key=>allowed.includes(key))||!validRootKey(value.token))return;
  let exact=true;if(Object.hasOwn(value,'audience')){if(value.audience!==NOTEBIN_ORIGIN)return}else exact=false;
  if(Object.hasOwn(value,'scopes')){if(!Array.isArray(value.scopes)||!value.scopes.every(scope=>typeof scope==='string')||JSON.stringify(sortedUnique(value.scopes as string[]))!==JSON.stringify(['note:create','note:read']))return}else exact=false;
  if(Object.hasOwn(value,'id')&&(typeof value.id!=='string'||!ACCOUNT_ID.test(value.id)))return;
  return {token:value.token,keyId:typeof value.id==='string'?value.id:undefined,binding:exact?'exact_response' as const:'pending_readback' as const};
}
export async function mintNotebinKey(input:{operationId:string;localAccountId:string;rootAccountId:string;rootApiKey:string;rootBinding:NotebinRootIdentityBinding;createdAt:string},persistence:NotebinMintPersistence,deps:NotebinDependencies={}):Promise<NotebinMintResult>{
  if(!validNotebinRuntimeGate(deps.gate,'mint'))return {status:'not_started',reason:'runtime_gate_closed'};
  if(!OPERATION.test(input.operationId)||!UUID.test(input.localAccountId)||!validAccountId(input.rootAccountId)||!validRootKey(input.rootApiKey)||!exactDate(input.createdAt)||input.rootBinding.binding!=='exact_readback'||input.rootBinding.localAccountId!==input.localAccountId||input.rootBinding.rootAccountId!==input.rootAccountId||input.rootBinding.rootKeyFingerprint!==notebinTokenFingerprint(input.rootApiKey)||!HASH.test(input.rootBinding.whoamiResponseHash)||input.rootBinding.keyListResponseHash!==undefined&&!HASH.test(input.rootBinding.keyListResponseHash)||!exactDate(input.rootBinding.verifiedAt))return {status:'not_started',reason:'invalid_root_identity'};
  const body=mintBody(),intent:NotebinIntent={version:1,operation:'mint',operationId:input.operationId,localAccountId:input.localAccountId,rootAccountId:input.rootAccountId,createdAt:input.createdAt,requestHash:sha256(body)};
  let claimed:'claimed'|'existing';try{claimed=await persistence.claimIntent(intent)}catch{return {status:'not_started',reason:'intent_conflict'}}let opaque=await persistence.loadOpaqueResponse(),opaqueSaved=!!opaque;
  if(claimed==='existing'&&!opaque)return {status:'unknown',reason:'密钥铸造意图已存在但没有确定回执；不会重复 POST',opaqueSaved:false};
  if(!opaque){try{if(await persistence.assertAuthorized(intent)!==true)throw Error('authorization');await capturedRequest(NOTEBIN_KEYS_URL,{method:'POST',headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${input.rootApiKey}`},body},NOTEBIN_MAX_AUTH_RESPONSE_BYTES,deps,async(response,bytes)=>{const value=makeOpaque(response,bytes,intent);await persistence.persistOpaqueResponse(value);opaque=value;opaqueSaved=true})}catch(error){return {status:'unknown',reason:`专用密钥结果不明（${safeReason(error)}）；不会重复铸造`,opaqueSaved}}}
  if(!opaque)return {status:'unknown',reason:'专用密钥回执缺失；不会重复铸造',opaqueSaved};const parsed=parseMintOpaque(opaque,intent);if(!parsed)return {status:'unknown',reason:'专用密钥响应或 HTTP 状态不符合冻结契约；不会改用 Cookie 或登录绕过',opaqueSaved:true};
  const receipt:NotebinKeyReceipt={localAccountId:input.localAccountId,rootAccountId:input.rootAccountId,audience:NOTEBIN_ORIGIN,scopes:['note:read','note:create'],tokenFingerprint:notebinTokenFingerprint(parsed.token),binding:parsed.binding,keyId:parsed.keyId,createdAt:input.createdAt,requestHash:intent.requestHash};
  try{await persistence.promoteKey(receipt,parsed.token)}catch{return {status:'unknown',reason:'专用密钥已返回但本机原子保存未完成；不会重复铸造',opaqueSaved:true}}return {status:receipt.binding==='exact_response'?'ready':'pending_binding',receipt};
}

export function parseNotebinItem(value:unknown):NotebinItem|undefined{
  if(!object(value)||!exactKeys(value,['id','kind','title','description','visibility','content_type','size_bytes','created_at','views','url','view_url','raw_url'],['expires_at','markdown','scan_state']))return;
  if(typeof value.id!=='string'||!ITEM_ID.test(value.id)||value.kind!=='note'||value.title!==null&&typeof value.title!=='string'||value.description!==null&&typeof value.description!=='string'||!['public','unlisted'].includes(String(value.visibility))||value.content_type!==null&&typeof value.content_type!=='string'||!Number.isSafeInteger(value.size_bytes)||Number(value.size_bytes)<0||Number(value.size_bytes)>NOTEBIN_MAX_MARKDOWN_BYTES||!Number.isSafeInteger(value.created_at)||Number(value.created_at)<0||!Number.isSafeInteger(value.views)||Number(value.views)<0)return;
  const expiresPresent=Object.hasOwn(value,'expires_at');if(expiresPresent&&value.expires_at!==null&&(!Number.isSafeInteger(value.expires_at)||Number(value.expires_at)<0))return;
  if(Object.hasOwn(value,'markdown')&&typeof value.markdown!=='string'||Object.hasOwn(value,'scan_state')&&(typeof value.scan_state!=='string'||value.scan_state.length>128))return;
  const url=safeSameOriginUrl(value.url,NOTEBIN_ORIGIN,value.id),viewUrl=safeSameOriginUrl(value.view_url,NOTEBIN_ORIGIN,value.id),rawUrl=safeSameOriginUrl(value.raw_url,NOTEBIN_ORIGIN,value.id);if(!url||!viewUrl||!rawUrl)return;
  return {id:value.id,kind:'note',title:value.title as string|null,description:value.description as string|null,visibility:value.visibility as 'public'|'unlisted',contentType:value.content_type as string|null,sizeBytes:Number(value.size_bytes),createdAt:Number(value.created_at),expiresAt:expiresPresent?value.expires_at as number|null:undefined,expiresAtPresent:expiresPresent,views:Number(value.views),url,viewUrl,rawUrl,...(typeof value.markdown==='string'?{markdown:value.markdown}:{}),...(typeof value.scan_state==='string'?{scanState:value.scan_state}:{})};
}
export function parseNotebinItemList(value:unknown){if(!object(value)||!exactKeys(value,['items','next_cursor'])||!Array.isArray(value.items)||value.items.length>100||value.next_cursor!==null&&(typeof value.next_cursor!=='string'||value.next_cursor.length>1024))return;const items=value.items.map(parseNotebinItem);if(items.some(item=>!item))return;return {items:items as NotebinItem[],nextCursor:value.next_cursor as string|null}}
function receiptFromItem(item:NotebinItem,intent:NotebinIntent):NotebinPublicationReceipt{return {operationId:intent.operationId,localAccountId:intent.localAccountId,rootAccountId:intent.rootAccountId!,noteKeyFingerprint:intent.noteKeyFingerprint!,requestHash:intent.requestHash,sourceHash:intent.sourceHash!,createdAt:intent.createdAt,itemId:item.id,publicUrl:item.viewUrl,viewUrl:item.viewUrl,rawUrl:item.rawUrl,remoteCreatedAt:item.createdAt,retention:!item.expiresAtPresent?'unknown':item.expiresAt===null?'no_scheduled_expiry':'expiring',...(item.expiresAtPresent?{expiresAt:item.expiresAt}:{}),ownership:'pending'}}
function parsePublishOpaque(opaque:NotebinOpaqueResponse,intent:NotebinIntent,request:ReturnType<typeof notebinNoteRequest>){const inspected=inspectNotebinOpaqueResponse(opaque);if(!inspected.valid||!sameNotebinIntent(opaque,intent)||!responseMatches(opaqueLike(opaque),NOTEBIN_NOTES_URL)||opaque.status!==200||!contentTypeJson(opaque.contentType))return;const decoded=strictJson(inspected.bytes),item=decoded&&parseNotebinItem(decoded.value);if(!item||item.title!==request.value.title||item.description!==request.value.description||item.visibility!=='public')return;return receiptFromItem(item,intent)}
function exactKeyBinding(binding:NotebinIdentityBinding,noteApiKey:string,localAccountId:string,rootAccountId:string){return binding.localAccountId===localAccountId&&binding.rootAccountId===rootAccountId&&binding.audience===NOTEBIN_ORIGIN&&JSON.stringify(binding.scopes)===JSON.stringify(['note:read','note:create'])&&['exact_response','exact_readback'].includes(binding.binding)&&binding.tokenFingerprint===notebinTokenFingerprint(noteApiKey)&&validRootKey(noteApiKey)}

export async function publishNotebinNote(input:{operationId:string;localAccountId:string;rootAccountId:string;noteApiKey:string;keyBinding:NotebinIdentityBinding;createdAt:string;title:string;description:string;markdown:string;approval:NotebinContentApproval},persistence:NotebinPublicationPersistence,deps:NotebinDependencies={}):Promise<NotebinPublishResult>{
  if(!validNotebinRuntimeGate(deps.gate,'publish'))return {status:'not_started',reason:'runtime_gate_closed'};
  if(!exactKeyBinding(input.keyBinding,input.noteApiKey,input.localAccountId,input.rootAccountId)||!OPERATION.test(input.operationId)||!UUID.test(input.localAccountId)||!validAccountId(input.rootAccountId)||!exactDate(input.createdAt))return {status:'not_started',reason:'invalid_key_binding'};
  let request:ReturnType<typeof notebinNoteRequest>;try{request=notebinNoteRequest(input.title,input.description,input.markdown)}catch{return {status:'not_started',reason:'request_too_large'}}
  if(input.approval.version!==1||input.approval.sourceHash!==request.sourceHash||input.approval.requestHash!==request.requestHash||!exactDate(input.approval.approvedAt)||!input.approval.reviewer.trim())return {status:'not_started',reason:'approval_mismatch'};
  const intent:NotebinIntent={version:1,operation:'publish',operationId:input.operationId,localAccountId:input.localAccountId,rootAccountId:input.rootAccountId,createdAt:input.createdAt,requestHash:request.requestHash,sourceHash:request.sourceHash,noteKeyFingerprint:input.keyBinding.tokenFingerprint};
  let claimed:'claimed'|'existing';try{claimed=await persistence.claimIntent(intent)}catch{return {status:'not_started',reason:'intent_conflict'}}let opaque=await persistence.loadOpaqueResponse(),opaqueSaved=!!opaque;
  if(claimed==='existing'&&!opaque)return {status:'unknown',reason:'创建意图已存在但没有确定回执；只能 GET 对账，禁止第二次 POST',opaqueSaved:false};
  if(!opaque){try{if(await persistence.assertAuthorized(intent)!==true)throw Error('authorization');await capturedRequest(NOTEBIN_NOTES_URL,{method:'POST',headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${input.noteApiKey}`},body:request.body},NOTEBIN_MAX_ITEM_RESPONSE_BYTES,deps,async(response,bytes)=>{const value=makeOpaque(response,bytes,intent);await persistence.persistOpaqueResponse(value);opaque=value;opaqueSaved=true})}catch(error){return {status:'unknown',reason:`笔记创建结果不明（${safeReason(error)}）；只能只读对账`,opaqueSaved}}}
  if(!opaque)return {status:'unknown',reason:'笔记创建回执缺失；只能只读对账',opaqueSaved};const receipt=parsePublishOpaque(opaque,intent,request);if(!receipt)return {status:'unknown',reason:'笔记原始响应不符合冻结契约；已加密保留且不会重发',opaqueSaved:true};
  try{await persistence.preserveReceipt(receipt)}catch{return {status:'unknown',reason:'笔记回执已返回但持久化未原子完成；不会重发',opaqueSaved:true}}return {status:receipt.retention==='no_scheduled_expiry'?'created':'pending_retention',receipt};
}

export const notebinTesting={sha256,leadingZeroBits,strictJson,topLevelKeys,safeSameOriginUrl,validRootKey,receiptFromItem,parseSignupOpaque,parseMintOpaque,parsePublishOpaque,exactKeyBinding,signupBody,mintBody};
