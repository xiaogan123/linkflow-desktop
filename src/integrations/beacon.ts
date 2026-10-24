import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import {applyDeclaredArticleVisibility,publicPagePolicy} from './article-visibility';
import {inspectRenderedArticle} from './article-rendering';
import {agentsGatherRobotsAllows} from './agentsgather-public';
import {renderShareYourHtmlArticle,type ShareYourHtmlArticleDraft} from './shareyourhtml-article';

export const BEACON_ORIGIN='https://beacon.host';
export const BEACON_SEND_OTP_URL=`${BEACON_ORIGIN}/v1/auth/send-otp`;
export const BEACON_VERIFY_OTP_URL=`${BEACON_ORIGIN}/v1/auth/verify-otp`;
export const BEACON_PUBLISH_URL=`${BEACON_ORIGIN}/v1/publish`;
export const BEACON_SITES_URL=`${BEACON_ORIGIN}/v1/sites`;
export const BEACON_MAX_RESPONSE_BYTES=256*1024;
export const BEACON_MAX_PAGE_BYTES=512*1024;
const BEACON_SITE_PAGE_SIZE=100;
const BEACON_MAX_SITE_PAGES=100;

const OPERATION=/^beacon_[a-f0-9]{32}$/;
const SLUG=/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const HASH=/^[a-f0-9]{64}$/;
const OTP=/^[0-9]{6}$/;
const CONTROL=/[\u0000-\u001f\u007f]/u;

type BeaconIntentKind='send_otp'|'verify_otp'|'publish';
export interface BeaconOtpIntent{kind:'send_otp';operationId:string;email:string;requestHash:string;createdAt:string}
export interface BeaconVerifyIntent{kind:'verify_otp';operationId:string;email:string;codeHash:string;requestHash:string;createdAt:string}
export interface BeaconPublishIntent{kind:'publish';operationId:string;slug:string;publicUrl:string;sourceHash:string;markdownHash:string;targetUrlHash:string;requestHash:string;apiKeyHash:string;createdAt:string}
export type BeaconIntent=BeaconOtpIntent|BeaconVerifyIntent|BeaconPublishIntent;
export interface BeaconOpaqueResponse{version:1;kind:'beacon_opaque_response';stage:BeaconIntentKind;operationId:string;requestHash:string;status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string;recordedAt:string}
export interface BeaconOtpSentReceipt extends BeaconOtpIntent{sentAt:string;cooldownUntil:string;expiresAt:string}
export interface BeaconApiKeyReceipt extends BeaconVerifyIntent{apiKeySha256:string;accountId?:string;accountEmail?:string}
export interface BeaconPublicationReceipt extends BeaconPublishIntent{versionId:string;anonymous:false;expiresAt:null}
export interface BeaconArticle{html:string;markdown:string;title:string;targetUrl:string;sourceHash:string;requestHash:string;byteLength:number;slug:string}

/** Every callback is expected to be backed by encrypted, durable storage. */
export interface BeaconPersistence{
  readonly secretStorage:'encrypted';
  persistIntent(intent:BeaconIntent):Promise<void>;
  assertReadyToSubmit(intent:BeaconIntent):true;
  persistOpaqueResponse(response:BeaconOpaqueResponse):Promise<void>;
  loadOpaqueResponse(stage:BeaconIntentKind,operationId:string):Promise<BeaconOpaqueResponse|undefined>;
  promoteOtpSent(receipt:BeaconOtpSentReceipt):Promise<void>;
  promoteApiKey(value:{receipt:BeaconApiKeyReceipt;apiKey:string}):Promise<void>;
  promotePublication(receipt:BeaconPublicationReceipt):Promise<void>;
}
export interface BeaconDependencies{fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date;allowExternalWrite?:boolean}
export type BeaconDiagnostic='transport'|'body_limit'|'opaque_persistence'|'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema';
type NotStarted={status:'not_started';reason:'external_write_disabled'|'invalid_input'|'intent_not_persisted'|'authorization_changed'};
type Blocked<I extends BeaconIntent>={status:'blocked';reason:'prior_submission';intent:I};
type Unknown<I extends BeaconIntent>={status:'unknown';intent:I;diagnostic:BeaconDiagnostic;opaqueResponseSaved:boolean};
type Rejected<I extends BeaconIntent>={status:'rejected';intent:I;diagnostic:'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'};
export type BeaconSendOtpResult=NotStarted|Blocked<BeaconOtpIntent>|Unknown<BeaconOtpIntent>|Rejected<BeaconOtpIntent>|{status:'sent';receipt:BeaconOtpSentReceipt};
export type BeaconVerifyOtpResult=NotStarted|Blocked<BeaconVerifyIntent>|Unknown<BeaconVerifyIntent>|Rejected<BeaconVerifyIntent>|{status:'verified';receipt:BeaconApiKeyReceipt};
export type BeaconPublishResult=NotStarted|Blocked<BeaconPublishIntent>|Unknown<BeaconPublishIntent>|Rejected<BeaconPublishIntent>|{status:'created';receipt:BeaconPublicationReceipt};
export type BeaconVerification={status:'usable';receipt:BeaconPublicationReceipt;rel:string;robots:'allowed'|'not_declared';pageSha256:string}|{status:'invalid'|'unavailable';reason:'binding'|'owner'|'response'|'content'|'indexing'|'robots'|'network'};
export type BeaconRecovery={status:'accepted';receipt:BeaconPublicationReceipt;verification:Extract<BeaconVerification,{status:'usable'}>}|{status:'published_unverified';receipt:BeaconPublicationReceipt;verification:Exclude<BeaconVerification,{status:'usable'}>}|{status:'unknown'};

const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const iso=(value:string)=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
function validEmail(value:string){return value===value.trim()&&value.length<=254&&!CONTROL.test(value)&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)}
export function validBeaconApiKey(value:unknown):value is string{return typeof value==='string'&&value.startsWith('chk_')&&value.length>4&&value.length<=4096&&!/[\s\u0000-\u001f\u007f]/u.test(value)}
export function beaconPublicUrl(slug:string){if(!SLUG.test(slug))throw Error('Beacon slug 无效');return `https://${slug}.beacon.host/`}
export function beaconSiteUrl(slug:string){if(!SLUG.test(slug))throw Error('Beacon slug 无效');return `${BEACON_SITES_URL}/${slug}`}
function exactPublicUrl(value:unknown,wanted:string){if(typeof value!=='string')return false;try{const url=new URL(value);return !url.username&&!url.password&&!url.search&&!url.hash&&url.href===wanted}catch{return false}}
function requestBody(article:Pick<BeaconArticle,'html'|'slug'|'title'>){return JSON.stringify({files:[{path:'index.html',content:article.html,encoding:'utf8'}],slug:article.slug,title:article.title})}
export function beaconPublishRequestHash(article:Pick<BeaconArticle,'html'|'slug'|'title'>){return sha(`POST ${BEACON_PUBLISH_URL}\ncontent-type:application/json\n${requestBody(article)}`)}

export function renderBeaconArticle(input:{draft:ShareYourHtmlArticleDraft;targetUrl:string;language:string;slug:string}):BeaconArticle{
  if(!SLUG.test(input.slug))throw Error('Beacon slug 无效');
  const rendered=renderShareYourHtmlArticle({...input,slug:input.slug});
  const article={html:rendered.html,markdown:input.draft.body,title:input.draft.title,targetUrl:rendered.targetUrl,sourceHash:rendered.sourceHash,requestHash:'',byteLength:Buffer.byteLength(rendered.html),slug:input.slug};
  article.requestHash=beaconPublishRequestHash(article);
  return Object.freeze(article);
}
function validBeaconArticle(article:BeaconArticle){
  if(!SLUG.test(article.slug)||sha(article.html)!==article.sourceHash||beaconPublishRequestHash(article)!==article.requestHash||Buffer.byteLength(article.html)!==article.byteLength)return false;
  const $=load(article.html),titles=$('head > title'),headings=$('main > article > header > h1');
  if(titles.length!==1||headings.length!==1||titles.text()!==article.title||headings.text()!==article.title)return false;
  return inspectRenderedArticle(article.html,article.markdown,article.targetUrl,'main > article > section',{title:article.title}).found;
}

function validBase(intent:BeaconIntent){return OPERATION.test(intent.operationId)&&HASH.test(intent.requestHash)&&iso(intent.createdAt)}
export function validBeaconIntent(intent:BeaconIntent):boolean{
  if(!validBase(intent))return false;
  if(intent.kind==='send_otp')return validEmail(intent.email)&&intent.requestHash===sha(JSON.stringify({email:intent.email}));
  if(intent.kind==='verify_otp')return validEmail(intent.email)&&HASH.test(intent.codeHash)&&intent.requestHash===sha(JSON.stringify({email:intent.email,codeHash:intent.codeHash}));
  return SLUG.test(intent.slug)&&intent.publicUrl===beaconPublicUrl(intent.slug)&&HASH.test(intent.sourceHash)&&HASH.test(intent.markdownHash)&&HASH.test(intent.targetUrlHash)&&HASH.test(intent.apiKeyHash);
}
function sameOpaque(response:BeaconOpaqueResponse,intent:BeaconIntent){return response.version===1&&response.kind==='beacon_opaque_response'&&response.stage===intent.kind&&response.operationId===intent.operationId&&response.requestHash===intent.requestHash&&HASH.test(response.bodySha256)&&iso(response.recordedAt)}
function strictBase64(value:string){const bytes=Buffer.from(value,'base64');return bytes.length<=BEACON_MAX_RESPONSE_BYTES&&bytes.toString('base64')===value}
function responseDiagnostic(response:BeaconOpaqueResponse,intent:BeaconIntent,successStatus:number|number[]):BeaconDiagnostic|undefined{
  if(!sameOpaque(response,intent)||!strictBase64(response.bodyBase64)||sha(Buffer.from(response.bodyBase64,'base64'))!==response.bodySha256)return 'schema';
  const wanted=Array.isArray(successStatus)?successStatus:[successStatus];
  if(response.redirected||response.responseType==='opaqueredirect'||response.status>=300&&response.status<400)return 'redirect';
  if(response.responseUrl&&response.responseUrl!==endpoint(intent.kind))return 'redirect';
  if(!wanted.includes(response.status))return 'http_status';
  if(response.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return 'media_type';
}
function decodeJson(response:BeaconOpaqueResponse):{value:unknown}|{diagnostic:'decode'|'json'}{
  let text:string;
  try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(response.bodyBase64,'base64'))}catch{return {diagnostic:'decode'}}
  try{return {value:JSON.parse(text) as unknown}}catch{return {diagnostic:'json'}}
}
function endpoint(kind:BeaconIntentKind){return kind==='send_otp'?BEACON_SEND_OTP_URL:kind==='verify_otp'?BEACON_VERIFY_OTP_URL:BEACON_PUBLISH_URL}
function discard(response:Response){if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
class BodyLimitError extends Error{}
class ReadError extends Error{constructor(readonly kind:'invalid'|'unavailable'){super(kind)}}
async function bounded(response:Response,maximum:number,signal:AbortSignal){
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum)){discard(response);throw new BodyLimitError()}
  if(!response.body)return new Uint8Array();
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{for(;;){if(signal.aborted)throw Error('abort');const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maximum){void reader.cancel().catch(()=>undefined);throw new BodyLimitError()}parts.push(next.value)}}finally{reader.releaseLock()}
  return Buffer.concat(parts.map(part=>Buffer.from(part)));
}
function controller(deps:BeaconDependencies){const value=new AbortController(),external=()=>value.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)value.abort();const timer=setTimeout(()=>value.abort(),Math.min(60_000,Math.max(50,deps.timeoutMs??20_000)));timer.unref?.();return {value,dispose(){clearTimeout(timer);deps.signal?.removeEventListener('abort',external)}}}
async function capturePost(intent:BeaconIntent,body:string,headers:Record<string,string>,persistence:BeaconPersistence,deps:BeaconDependencies):Promise<{opaque?:BeaconOpaqueResponse;diagnostic?:'transport'|'body_limit'|'opaque_persistence'}>{
  const abort=controller(deps);let response:Response|undefined;
  try{
    const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));
    response=await transport(endpoint(intent.kind),{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:abort.value.signal,headers:{accept:'application/json','content-type':'application/json',...headers},body});
    const bytes=await bounded(response,BEACON_MAX_RESPONSE_BYTES,abort.value.signal);
    const opaque:BeaconOpaqueResponse={version:1,kind:'beacon_opaque_response',stage:intent.kind,operationId:intent.operationId,requestHash:intent.requestHash,status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:sha(bytes),recordedAt:(deps.now?.()??new Date()).toISOString()};
    try{await persistence.persistOpaqueResponse(opaque)}catch{return {diagnostic:'opaque_persistence'}}
    return {opaque};
  }catch(error){abort.value.abort();if(response)discard(response);return {diagnostic:error instanceof BodyLimitError?'body_limit':'transport'}}finally{abort.dispose()}
}
async function prepare<I extends BeaconIntent>(intent:I,prior:I|undefined,persistence:BeaconPersistence,deps:BeaconDependencies):Promise<NotStarted|Blocked<I>|undefined>{
  if(deps.allowExternalWrite!==true)return {status:'not_started',reason:'external_write_disabled'};
  if(persistence.secretStorage!=='encrypted'||!validBeaconIntent(intent))return {status:'not_started',reason:'invalid_input'};
  if(prior)return validBeaconIntent(prior)&&prior.kind===intent.kind&&prior.operationId===intent.operationId&&prior.requestHash===intent.requestHash?{status:'blocked',reason:'prior_submission',intent:{...prior}}:{status:'not_started',reason:'invalid_input'};
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
}

export async function sendBeaconOtp(input:{operationId:string;email:string;priorIntent?:BeaconOtpIntent},persistence:BeaconPersistence,deps:BeaconDependencies={}):Promise<BeaconSendOtpResult>{
  const createdAt=(deps.now?.()??new Date()).toISOString(),body=JSON.stringify({email:input.email}),intent:BeaconOtpIntent={kind:'send_otp',operationId:input.operationId,email:input.email,requestHash:sha(body),createdAt};
  const stop=await prepare(intent,input.priorIntent,persistence,deps);if(stop)return stop;
  const captured=await capturePost(intent,body,{},persistence,deps);if(!captured.opaque)return {status:'unknown',intent,diagnostic:captured.diagnostic!,opaqueResponseSaved:false};
  const parsed=parseBeaconOtpResponse(captured.opaque,intent);if('diagnostic'in parsed)return parsed.diagnostic==='http_status'?{status:'rejected',intent,diagnostic:parsed.diagnostic}:{status:'rejected',intent,diagnostic:parsed.diagnostic};
  try{await persistence.promoteOtpSent(parsed);return {status:'sent',receipt:parsed}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}
}
export function parseBeaconOtpResponse(response:BeaconOpaqueResponse,intent:BeaconOtpIntent):BeaconOtpSentReceipt|{diagnostic:Extract<BeaconDiagnostic,'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'>}{
  const invalid=responseDiagnostic(response,intent,200);if(invalid)return {diagnostic:invalid as Extract<BeaconDiagnostic,'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'>};
  const decoded=decodeJson(response);if('diagnostic'in decoded)return decoded;const value=decoded.value;
  if(!value||typeof value!=='object'||Array.isArray(value)||(value as Record<string,unknown>).success!==true)return {diagnostic:'schema'};
  const sent=Date.parse(intent.createdAt);return {...intent,sentAt:intent.createdAt,cooldownUntil:new Date(sent+60_000).toISOString(),expiresAt:new Date(sent+10*60_000).toISOString()};
}
export async function recoverBeaconOtp(intent:BeaconOtpIntent,persistence:BeaconPersistence):Promise<{status:'recovered';receipt:BeaconOtpSentReceipt}|{status:'rejected';diagnostic:Extract<BeaconDiagnostic,'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'>}|{status:'unknown'}>{
  if(persistence.secretStorage!=='encrypted'||!validBeaconIntent(intent))return {status:'unknown'};const opaque=await persistence.loadOpaqueResponse('send_otp',intent.operationId);if(!opaque)return {status:'unknown'};const parsed=parseBeaconOtpResponse(opaque,intent);if('diagnostic'in parsed)return {status:'rejected',diagnostic:parsed.diagnostic};try{await persistence.promoteOtpSent(parsed);return {status:'recovered',receipt:parsed}}catch{return {status:'unknown'}}
}

export async function verifyBeaconOtp(input:{operationId:string;email:string;code:string;priorIntent?:BeaconVerifyIntent},persistence:BeaconPersistence,deps:BeaconDependencies={}):Promise<BeaconVerifyOtpResult>{
  const codeHash=sha(input.code),createdAt=(deps.now?.()??new Date()).toISOString(),intent:BeaconVerifyIntent={kind:'verify_otp',operationId:input.operationId,email:input.email,codeHash,requestHash:sha(JSON.stringify({email:input.email,codeHash})),createdAt};
  if(!OTP.test(input.code))return {status:'not_started',reason:'invalid_input'};
  const stop=await prepare(intent,input.priorIntent,persistence,deps);if(stop)return stop;
  const captured=await capturePost(intent,JSON.stringify({email:input.email,code:input.code}),{},persistence,deps);if(!captured.opaque)return {status:'unknown',intent,diagnostic:captured.diagnostic!,opaqueResponseSaved:false};
  const parsed=parseBeaconVerifyResponse(captured.opaque,intent);if('diagnostic'in parsed)return {status:'rejected',intent,diagnostic:parsed.diagnostic};
  try{await persistence.promoteApiKey(parsed);return {status:'verified',receipt:parsed.receipt}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}
}
export function parseBeaconVerifyResponse(response:BeaconOpaqueResponse,intent:BeaconVerifyIntent):{receipt:BeaconApiKeyReceipt;apiKey:string}|{diagnostic:Extract<BeaconDiagnostic,'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'>}{
  const invalid=responseDiagnostic(response,intent,200);if(invalid)return {diagnostic:invalid as Extract<BeaconDiagnostic,'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'>};
  const decoded=decodeJson(response);if('diagnostic'in decoded)return decoded;const value=decoded.value;
  if(!value||typeof value!=='object'||Array.isArray(value))return {diagnostic:'schema'};const body=value as Record<string,unknown>,apiKey=body.apiKey;
  if(!validBeaconApiKey(apiKey))return {diagnostic:'schema'};
  let accountId:string|undefined,accountEmail:string|undefined;
  if(body.account!==undefined){if(!body.account||typeof body.account!=='object'||Array.isArray(body.account))return {diagnostic:'schema'};const account=body.account as Record<string,unknown>;if(account.id!==undefined&&(typeof account.id!=='string'||!account.id||CONTROL.test(account.id)))return {diagnostic:'schema'};if(account.email!==undefined&&(typeof account.email!=='string'||account.email.toLowerCase()!==intent.email.toLowerCase()))return {diagnostic:'schema'};accountId=account.id as string|undefined;accountEmail=account.email as string|undefined}
  return {receipt:{...intent,apiKeySha256:sha(apiKey),accountId,accountEmail},apiKey};
}
export async function recoverBeaconApiKey(intent:BeaconVerifyIntent,persistence:BeaconPersistence):Promise<{status:'recovered';receipt:BeaconApiKeyReceipt}|{status:'rejected';diagnostic:Extract<BeaconDiagnostic,'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'>}|{status:'unknown'}>{
  if(persistence.secretStorage!=='encrypted'||!validBeaconIntent(intent))return {status:'unknown'};const opaque=await persistence.loadOpaqueResponse('verify_otp',intent.operationId);if(!opaque)return {status:'unknown'};const parsed=parseBeaconVerifyResponse(opaque,intent);if('diagnostic'in parsed)return {status:'rejected',diagnostic:parsed.diagnostic};try{await persistence.promoteApiKey(parsed);return {status:'recovered',receipt:parsed.receipt}}catch{return {status:'unknown'}}
}

export async function publishBeaconArticle(input:{operationId:string;apiKey:string;article:BeaconArticle;priorIntent?:BeaconPublishIntent},persistence:BeaconPersistence,deps:BeaconDependencies={}):Promise<BeaconPublishResult>{
  const intent:BeaconPublishIntent={kind:'publish',operationId:input.operationId,slug:input.article.slug,publicUrl:beaconPublicUrl(input.article.slug),sourceHash:input.article.sourceHash,markdownHash:sha(input.article.markdown),targetUrlHash:sha(input.article.targetUrl),requestHash:input.article.requestHash,apiKeyHash:sha(input.apiKey),createdAt:(deps.now?.()??new Date()).toISOString()};
  if(!validBeaconApiKey(input.apiKey)||!validBeaconArticle(input.article))return {status:'not_started',reason:'invalid_input'};
  const stop=await prepare(intent,input.priorIntent,persistence,deps);if(stop)return stop;
  const captured=await capturePost(intent,requestBody(input.article),{authorization:`Bearer ${input.apiKey}`},persistence,deps);if(!captured.opaque)return {status:'unknown',intent,diagnostic:captured.diagnostic!,opaqueResponseSaved:false};
  const parsed=parseBeaconPublishResponse(captured.opaque,intent);if('diagnostic'in parsed)return parsed.diagnostic==='http_status'?{status:'rejected',intent,diagnostic:parsed.diagnostic}:{status:'rejected',intent,diagnostic:parsed.diagnostic};
  try{await persistence.promotePublication(parsed);return {status:'created',receipt:parsed}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}
}
export function parseBeaconPublishResponse(response:BeaconOpaqueResponse,intent:BeaconPublishIntent):BeaconPublicationReceipt|{diagnostic:Extract<BeaconDiagnostic,'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'>}{
  const invalid=responseDiagnostic(response,intent,[200,201]);if(invalid)return {diagnostic:invalid as Extract<BeaconDiagnostic,'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'>};
  const decoded=decodeJson(response);if('diagnostic'in decoded)return decoded;const value=decoded.value;if(!value||typeof value!=='object'||Array.isArray(value))return {diagnostic:'schema'};const body=value as Record<string,unknown>;
  const resultUrl=typeof body.pageUrl==='string'?body.pageUrl:body.url;
  if(body.slug!==intent.slug||!exactPublicUrl(resultUrl,intent.publicUrl)||body.anonymous!==false||body.expiresAt!==null||typeof body.versionId!=='string'||!body.versionId||CONTROL.test(body.versionId))return {diagnostic:'schema'};
  return {...intent,versionId:body.versionId,anonymous:false,expiresAt:null};
}

async function get(url:string,headers:Record<string,string>,deps:BeaconDependencies,maximum:number,allow404=false){
  const abort=controller(deps);let response:Response|undefined;
  try{const transport=deps.fetch??((target:string,init:RequestInit)=>fetch(target,init));response=await transport(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:abort.value.signal,headers});if(response.redirected||response.type==='opaqueredirect'||response.status>=300&&response.status<400||response.url&&response.url!==url)throw new ReadError('invalid');if(response.status===404&&allow404)return {response,bytes:new Uint8Array()};if(response.status!==200)throw new ReadError(response.status>=500||[408,429].includes(response.status)?'unavailable':'invalid');return {response,bytes:await bounded(response,maximum,abort.value.signal)}}catch(error){if(response&&!response.bodyUsed)discard(response);if(error instanceof ReadError)throw error;throw new ReadError('unavailable')}finally{abort.dispose()}
}
async function jsonGet(url:string,apiKey:string,deps:BeaconDependencies){const result=await get(url,{accept:'application/json',authorization:`Bearer ${apiKey}`},deps,BEACON_MAX_RESPONSE_BYTES);if(result.response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')throw new ReadError('invalid');try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result.bytes)) as unknown}catch{throw new ReadError('invalid')}}
function ownerRecord(value:unknown,intent:BeaconPublishIntent,versionId?:string){if(!value||typeof value!=='object'||Array.isArray(value))return;const root=value as Record<string,unknown>,site=(root.site??root) as Record<string,unknown>,version=root.currentVersion as Record<string,unknown>|null|undefined;if(!site||typeof site!=='object'||Array.isArray(site)||site.slug!==intent.slug||!exactPublicUrl(site.url,intent.publicUrl)||site.expiresAt!==null||typeof site.currentVersionId!=='string'||!site.currentVersionId)return;const current=site.currentVersionId as string;if(versionId&&current!==versionId)return;if(root.site!==undefined&&(!version||version.id!==current||version.status!=='live'))return;return current}
async function ownedSiteListed(intent:BeaconPublishIntent,versionId:string,apiKey:string,deps:BeaconDependencies){
  let expectedTotal:number|undefined;
  for(let page=0;page<BEACON_MAX_SITE_PAGES;page++){
    const offset=page*BEACON_SITE_PAGE_SIZE,value=await jsonGet(`${BEACON_SITES_URL}?limit=${BEACON_SITE_PAGE_SIZE}&offset=${offset}`,apiKey,deps);
    if(!value||typeof value!=='object'||Array.isArray(value))throw new ReadError('invalid');const body=value as Record<string,unknown>,data=body.data;
    if(!Array.isArray(data)||data.length>BEACON_SITE_PAGE_SIZE||body.limit!==BEACON_SITE_PAGE_SIZE||body.offset!==offset||!Number.isSafeInteger(body.totalCount)||Number(body.totalCount)<0||Number(body.totalCount)>BEACON_SITE_PAGE_SIZE*BEACON_MAX_SITE_PAGES)throw new ReadError('invalid');
    const total=Number(body.totalCount);if(expectedTotal===undefined)expectedTotal=total;else if(total!==expectedTotal)throw new ReadError('invalid');if(offset>total||offset+data.length>total)throw new ReadError('invalid');
    if(data.some(site=>ownerRecord(site,intent,versionId)===versionId))return true;
    if(offset+data.length>=total)return false;
    if(data.length!==BEACON_SITE_PAGE_SIZE)throw new ReadError('invalid');
  }
  throw new ReadError('invalid');
}

export async function verifyBeaconPublication(receipt:BeaconPublicationReceipt,article:BeaconArticle,apiKey:string,deps:BeaconDependencies={}):Promise<BeaconVerification>{
  if(!validBeaconIntent(receipt)||!validBeaconArticle(article)||receipt.apiKeyHash!==sha(apiKey)||!validBeaconApiKey(apiKey)||receipt.sourceHash!==article.sourceHash||receipt.markdownHash!==sha(article.markdown)||receipt.targetUrlHash!==sha(article.targetUrl)||receipt.requestHash!==article.requestHash||receipt.slug!==article.slug||receipt.publicUrl!==beaconPublicUrl(article.slug)||receipt.anonymous!==false||receipt.expiresAt!==null)return {status:'invalid',reason:'binding'};
  try{
    const robotsUrl=new URL('/robots.txt',receipt.publicUrl).href;
    const [detail,page,robots]=await Promise.all([jsonGet(beaconSiteUrl(receipt.slug),apiKey,deps),get(receipt.publicUrl,{accept:'text/html'},deps,BEACON_MAX_PAGE_BYTES),get(robotsUrl,{accept:'text/plain'},deps,64*1024,true)]);
    if(ownerRecord(detail,receipt,receipt.versionId)!==receipt.versionId)return {status:'invalid',reason:'owner'};
    if(page.response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='text/html')return {status:'invalid',reason:'response'};
    const html=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(page.bytes),$=load(html);applyDeclaredArticleVisibility($);if(!publicPagePolicy($,receipt.publicUrl,page.response.headers.get('x-robots-tag')??'').valid)return {status:'invalid',reason:'indexing'};
    let robotsState:'allowed'|'not_declared'='not_declared';if(robots.response.status===200){const text=new TextDecoder('utf-8',{fatal:true}).decode(robots.bytes).replace(/\r\n|\r/g,'\n'),path=new URL(receipt.publicUrl).pathname;if(!robots.response.headers.get('content-type')?.toLowerCase().startsWith('text/plain')||!['googlebot','bingbot'].every(agent=>agentsGatherRobotsAllows(text,path,agent)))return {status:'invalid',reason:'robots'};robotsState='allowed'}
    const inspected=inspectRenderedArticle(html,article.markdown,article.targetUrl,'main > article > section',{pageUrl:receipt.publicUrl,robotsHeader:page.response.headers.get('x-robots-tag')??'',title:article.title});if(!inspected.found)return {status:'invalid',reason:'content'};
    return {status:'usable',receipt,rel:inspected.rel,robots:robotsState,pageSha256:sha(page.bytes)};
  }catch(error){return {status:error instanceof ReadError&&error.kind==='invalid'?'invalid':'unavailable',reason:error instanceof ReadError&&error.kind==='invalid'?'response':'network'}}
}

export async function recoverBeaconPublication(intent:BeaconPublishIntent,article:BeaconArticle,apiKey:string,persistence:BeaconPersistence,deps:BeaconDependencies={}):Promise<BeaconRecovery>{
  if(!validBeaconIntent(intent)||!validBeaconArticle(article)||intent.apiKeyHash!==sha(apiKey)||!validBeaconApiKey(apiKey)||intent.sourceHash!==article.sourceHash||intent.markdownHash!==sha(article.markdown)||intent.targetUrlHash!==sha(article.targetUrl)||intent.requestHash!==article.requestHash)return {status:'unknown'};
  const opaque=await persistence.loadOpaqueResponse('publish',intent.operationId);if(opaque){const parsed=parseBeaconPublishResponse(opaque,intent);if(!('diagnostic'in parsed)){try{await persistence.promotePublication(parsed)}catch{/* the encrypted receipt may already exist */}const verification=await verifyBeaconPublication(parsed,article,apiKey,deps);return verification.status==='usable'?{status:'accepted',receipt:parsed,verification}:{status:'published_unverified',receipt:parsed,verification}}}
  try{
    const detail=await jsonGet(beaconSiteUrl(intent.slug),apiKey,deps),versionId=ownerRecord(detail,intent);
    if(!versionId||!await ownedSiteListed(intent,versionId,apiKey,deps))return {status:'unknown'};
    const receipt:BeaconPublicationReceipt={...intent,versionId,anonymous:false,expiresAt:null};try{await persistence.promotePublication(receipt)}catch{/* verification can still return the recovered receipt */}
    const verification=await verifyBeaconPublication(receipt,article,apiKey,deps);return verification.status==='usable'?{status:'accepted',receipt,verification}:{status:'published_unverified',receipt,verification};
  }catch{return {status:'unknown'}}
}

