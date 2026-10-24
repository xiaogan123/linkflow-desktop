import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import {marked} from 'marked';
import {applyDeclaredArticleVisibility,publicPagePolicy} from './article-visibility';
import {inspectRenderedArticle} from './article-rendering';
import {agentsGatherRobotsAllows} from './agentsgather-public';

export const MDLIB_ORIGIN='https://mdlib.dev';
export const MDLIB_DOCUMENTS_URL=`${MDLIB_ORIGIN}/v1/docs`;
export const MDLIB_ACCOUNT_PROBE_URL=`${MDLIB_DOCUMENTS_URL}?page=1&limit=1&sort=created`;
export const MDLIB_ROBOTS_URL=`${MDLIB_ORIGIN}/robots.txt`;
export const MDLIB_MAX_RESPONSE_BYTES=64*1024;
export const MDLIB_MAX_PAGE_BYTES=1024*1024;
export const MDLIB_MAX_MARKDOWN_BYTES=500*1024;

const OPERATION=/^mdlib_[a-f0-9]{32}$/;
const SLUG=/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/;
const HASH=/^[a-f0-9]{64}$/;
const API_KEY=/^mdlib_[A-Za-z0-9_-]+$/;
const EDIT_KEY=/^ek_[A-Za-z0-9_-]+$/;
const CONTROL=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
type JsonObject=Record<string,unknown>;
export type MdlibDiagnostic='transport'|'body_limit'|'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'|'opaque_persistence';

export interface MdlibDependencies{fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date;allowExternalWrite?:boolean}
export interface MdlibDocument{title:string;markdown:string;targetUrl:string;slug:string;sourceHash:string;targetUrlHash:string;requestHash:string}
export interface MdlibPublishIntent{version:1;kind:'mdlib_publish';operationId:string;slug:string;title:string;sourceHash:string;targetUrlHash:string;requestHash:string;apiKeyHash:string;createdAt:string}
export interface MdlibOpaqueResponse{version:1;kind:'mdlib_opaque_response';operationId:string;requestHash:string;status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string;capturedAt:string}
export interface MdlibPublicationReceipt extends MdlibPublishIntent{publicUrl:string;createdAtRemote:string;expiresAt:null;editKeySha256:string;management:{apiKey:'documented';editKey:'encrypted'}}
/** All callbacks must be backed by durable encrypted storage. */
export interface MdlibPersistence{
  readonly secretStorage:'encrypted';
  persistIntent(intent:MdlibPublishIntent):Promise<void>;
  assertReadyToSubmit(intent:MdlibPublishIntent):true;
  persistOpaqueResponse(response:MdlibOpaqueResponse):Promise<void>;
  loadOpaqueResponse(operationId:string):Promise<MdlibOpaqueResponse|undefined>;
  promotePublication(value:{receipt:MdlibPublicationReceipt;editKey:string}):Promise<void>;
}
export type MdlibAccountProbeResult=
  |{status:'unconfirmed';authenticated:'not_established';responseSha256:string;reason:'official_list_response_schema_not_documented';documentManagement:'api_key_documented';plan:'not_exposed_by_public_api';accountExpiry:'not_exposed_by_public_api'}
  |{status:'unknown';diagnostic:Exclude<MdlibDiagnostic,'opaque_persistence'>};
export type MdlibPublishResult=
  |{status:'not_started';reason:'external_write_disabled'|'invalid_input'|'account_check_required'|'intent_not_persisted'|'authorization_changed'}
  |{status:'blocked';reason:'prior_submission';intent:MdlibPublishIntent}
  |{status:'unknown';intent:MdlibPublishIntent;diagnostic:MdlibDiagnostic;opaqueResponseSaved:boolean}
  |{status:'rejected';intent:MdlibPublishIntent;diagnostic:'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'}
  |{status:'created';receipt:MdlibPublicationReceipt};
export type MdlibVerification=
  |{status:'usable';receipt:MdlibPublicationReceipt;rel:string;robots:'allowed'|'not_declared';pageSha256:string}
  |{status:'invalid'|'unavailable';reason:'binding'|'status'|'expiry'|'response'|'indexing'|'robots'|'content'|'network'};
export type MdlibRecovery=
  |{status:'accepted';receipt:MdlibPublicationReceipt;verification:Extract<MdlibVerification,{status:'usable'}>}
  |{status:'published_unverified';receipt:MdlibPublicationReceipt;verification:Exclude<MdlibVerification,{status:'usable'}>}
  |{status:'storage_pending';reason:'publication_secret_not_confirmed';receipt:MdlibPublicationReceipt;verification:MdlibVerification}
  |{status:'found_unowned';reason:'public_get_cannot_prove_account_ownership_or_recover_edit_key';publicUrl:string;expiresAt:null}
  |{status:'unknown'};

const object=(value:unknown):value is JsonObject=>!!value&&typeof value==='object'&&!Array.isArray(value);
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const iso=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const safeText=(value:unknown,maximum:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=maximum&&value===value.trim()&&!CONTROL.test(value);
export function validMdlibApiKey(value:unknown):value is string{return typeof value==='string'&&value.length<=4096&&API_KEY.test(value)&&!CONTROL.test(value)}
function validEditKey(value:unknown):value is string{return typeof value==='string'&&value.length<=4096&&EDIT_KEY.test(value)&&!CONTROL.test(value)}
function canonicalTarget(value:string){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||!url.hostname||(url.port&&url.port!=='443'))throw Error('mdlib target URL must be public HTTPS');url.hash='';return url.href}
export function mdlibStatusUrl(slug:string){if(!SLUG.test(slug))throw Error('mdlib slug invalid');return `${MDLIB_DOCUMENTS_URL}/${slug}/status`}
export function mdlibFallbackPublicUrl(slug:string){if(!SLUG.test(slug))throw Error('mdlib slug invalid');return `${MDLIB_ORIGIN}/d/${slug}`}
function bodyFor(document:Pick<MdlibDocument,'markdown'|'slug'|'title'>){return JSON.stringify({markdown:document.markdown,title:document.title,slug:document.slug,is_public:true})}
export function mdlibRequestHash(document:Pick<MdlibDocument,'markdown'|'slug'|'title'>){return sha(`POST ${MDLIB_DOCUMENTS_URL}\ncontent-type:application/json\n${bodyFor(document)}`)}
export function prepareMdlibDocument(input:{title:string;markdown:string;targetUrl:string;slug:string}):MdlibDocument{
  if(!safeText(input.title,255)||!SLUG.test(input.slug)||typeof input.markdown!=='string'||!input.markdown.trim()||CONTROL.test(input.markdown)||Buffer.byteLength(input.markdown)>MDLIB_MAX_MARKDOWN_BYTES)throw Error('mdlib document invalid');
  const targetUrl=canonicalTarget(input.targetUrl),rendered=marked.parse(input.markdown,{async:false,gfm:true});if(typeof rendered!=='string')throw Error('mdlib markdown invalid');
  const $=load(rendered),links=$('a[href]').toArray().filter(node=>{try{return canonicalTarget($(node).attr('href')??'')===targetUrl&&$(node).text().trim().length>0}catch{return false}});if(!links.length)throw Error('mdlib markdown must contain the reviewed target link');
  const document={title:input.title,markdown:input.markdown,targetUrl,slug:input.slug,sourceHash:sha(input.markdown),targetUrlHash:sha(targetUrl),requestHash:''};document.requestHash=mdlibRequestHash(document);return Object.freeze(document);
}
function validDocument(value:MdlibDocument){if(!safeText(value.title,255)||!SLUG.test(value.slug)||typeof value.markdown!=='string'||Buffer.byteLength(value.markdown)>MDLIB_MAX_MARKDOWN_BYTES||sha(value.markdown)!==value.sourceHash||sha(value.targetUrl)!==value.targetUrlHash||mdlibRequestHash(value)!==value.requestHash)return false;try{return prepareMdlibDocument({title:value.title,markdown:value.markdown,targetUrl:value.targetUrl,slug:value.slug}).requestHash===value.requestHash}catch{return false}}
function validIntent(value:MdlibPublishIntent){return object(value)&&value.version===1&&value.kind==='mdlib_publish'&&OPERATION.test(value.operationId)&&SLUG.test(value.slug)&&safeText(value.title,255)&&HASH.test(value.sourceHash)&&HASH.test(value.targetUrlHash)&&HASH.test(value.requestHash)&&HASH.test(value.apiKeyHash)&&iso(value.createdAt)}
function validPublicUrl(value:unknown,slug:string):value is string{if(typeof value!=='string')return false;try{const url=new URL(value),segments=url.pathname.split('/').filter(Boolean);return url.origin===MDLIB_ORIGIN&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&segments.at(-1)===slug&&url.href===value}catch{return false}}
function validReceipt(value:MdlibPublicationReceipt){return validIntent(value)&&validPublicUrl(value.publicUrl,value.slug)&&iso(value.createdAtRemote)&&value.expiresAt===null&&HASH.test(value.editKeySha256)&&object(value.management)&&value.management.apiKey==='documented'&&value.management.editKey==='encrypted'}

function discard(response:Response){if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
class BodyLimit extends Error{}
class ReadFailure extends Error{constructor(readonly kind:'invalid'|'unavailable'){super(kind)}}
function timer(deps:MdlibDependencies){const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const handle=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(50,deps.timeoutMs??20_000)));handle.unref?.();return {controller,dispose(){clearTimeout(handle);deps.signal?.removeEventListener('abort',external)}}}
async function bounded(response:Response,maximum:number,signal:AbortSignal){const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum)){discard(response);throw new BodyLimit()}if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){if(signal.aborted)throw Error('abort');const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maximum){void reader.cancel().catch(()=>undefined);throw new BodyLimit()}parts.push(next.value)}}finally{reader.releaseLock()}return Buffer.concat(parts.map(part=>Buffer.from(part)))}
async function get(url:string,headers:Record<string,string>,deps:MdlibDependencies,maximum:number,allow404=false){const abort=timer(deps);let response:Response|undefined;try{const transport=deps.fetch??((target:string,init:RequestInit)=>fetch(target,init));response=await transport(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:abort.controller.signal,headers});if(response.redirected||response.type==='opaqueredirect'||response.status>=300&&response.status<400||response.url&&response.url!==url)throw new ReadFailure('invalid');if(allow404&&response.status===404){discard(response);return {response,bytes:new Uint8Array()}}if(response.status!==200)throw new ReadFailure(response.status>=500||[408,429].includes(response.status)?'unavailable':'invalid');return {response,bytes:await bounded(response,maximum,abort.controller.signal)}}catch(error){if(response&&!response.bodyUsed)discard(response);if(error instanceof ReadFailure)throw error;throw new ReadFailure('unavailable')}finally{abort.dispose()}}
function json(bytes:Uint8Array):unknown{try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)) as unknown}catch{throw new ReadFailure('invalid')}}
function media(response:Response){return response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()??''}

export async function probeMdlibAccount(apiKey:string,deps:MdlibDependencies={}):Promise<MdlibAccountProbeResult>{
  if(!validMdlibApiKey(apiKey))return {status:'unknown',diagnostic:'schema'};
  try{
    const result=await get(MDLIB_ACCOUNT_PROBE_URL,{accept:'application/json',authorization:`Bearer ${apiKey}`},deps,MDLIB_MAX_RESPONSE_BYTES);
    if(media(result.response)!=='application/json')return {status:'unknown',diagnostic:'media_type'};
    const value=json(result.bytes);
    if(!object(value)||typeof value.error==='string')return {status:'unknown',diagnostic:'schema'};
    return {status:'unconfirmed',authenticated:'not_established',responseSha256:sha(result.bytes),reason:'official_list_response_schema_not_documented',documentManagement:'api_key_documented',plan:'not_exposed_by_public_api',accountExpiry:'not_exposed_by_public_api'};
  }catch(error){return {status:'unknown',diagnostic:error instanceof BodyLimit?'body_limit':error instanceof ReadFailure&&error.kind==='invalid'?'http_status':'transport'}}
}

async function capture(intent:MdlibPublishIntent,body:string,apiKey:string,persistence:MdlibPersistence,deps:MdlibDependencies):Promise<{opaque?:MdlibOpaqueResponse;diagnostic?:'transport'|'body_limit'|'opaque_persistence'}>{
  const abort=timer(deps);let response:Response|undefined;
  try{
    const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));
    response=await transport(MDLIB_DOCUMENTS_URL,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:abort.controller.signal,headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${apiKey}`},body});
    const bytes=await bounded(response,MDLIB_MAX_RESPONSE_BYTES,abort.controller.signal);
    const opaque:MdlibOpaqueResponse={version:1,kind:'mdlib_opaque_response',operationId:intent.operationId,requestHash:intent.requestHash,status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:sha(bytes),capturedAt:(deps.now?.()??new Date()).toISOString()};
    try{await persistence.persistOpaqueResponse(opaque)}catch{return {diagnostic:'opaque_persistence'}}
    return {opaque};
  }catch(error){if(response&&!response.bodyUsed)discard(response);return {diagnostic:error instanceof BodyLimit?'body_limit':'transport'}}finally{abort.dispose()}
}
function strictOpaque(value:MdlibOpaqueResponse,intent:MdlibPublishIntent){
  if(!object(value)||value.version!==1||value.kind!=='mdlib_opaque_response'||value.operationId!==intent.operationId||value.requestHash!==intent.requestHash||!HASH.test(value.bodySha256)||!iso(value.capturedAt))return false;
  const bytes=Buffer.from(value.bodyBase64,'base64');return bytes.length<=MDLIB_MAX_RESPONSE_BYTES&&bytes.toString('base64')===value.bodyBase64&&sha(bytes)===value.bodySha256;
}
export function parseMdlibPublishResponse(response:MdlibOpaqueResponse,intent:MdlibPublishIntent):{receipt:MdlibPublicationReceipt;editKey:string}|{diagnostic:'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'}{
  if(!strictOpaque(response,intent))return {diagnostic:'schema'};
  if(response.redirected||response.responseType==='opaqueredirect'||response.status>=300&&response.status<400||response.responseUrl&&response.responseUrl!==MDLIB_DOCUMENTS_URL)return {diagnostic:'redirect'};
  if(![200,201].includes(response.status))return {diagnostic:'http_status'};
  if(response.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  let text:string,value:unknown;
  try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(response.bodyBase64,'base64'))}catch{return {diagnostic:'decode'}}
  try{value=JSON.parse(text) as unknown}catch{return {diagnostic:'json'}}
  if(!object(value)||value.slug!==intent.slug||!validPublicUrl(value.url,intent.slug)||!validEditKey(value.edit_key)||!iso(value.created_at)||value.expires_at!==null)return {diagnostic:'schema'};
  const editKey=value.edit_key;
  return {editKey,receipt:{...intent,publicUrl:value.url,createdAtRemote:value.created_at,expiresAt:null,editKeySha256:sha(editKey),management:{apiKey:'documented',editKey:'encrypted'}}};
}

export async function publishMdlibDocument(input:{operationId:string;apiKey:string;document:MdlibDocument;reviewed:true;accountApiReadConfirmed:true;accountNoExpiryConfirmed:true;priorIntent?:MdlibPublishIntent},persistence:MdlibPersistence,deps:MdlibDependencies={}):Promise<MdlibPublishResult>{
  if(deps.allowExternalWrite!==true)return {status:'not_started',reason:'external_write_disabled'};
  if(input.reviewed!==true||input.accountApiReadConfirmed!==true||input.accountNoExpiryConfirmed!==true)return {status:'not_started',reason:'account_check_required'};
  const intent:MdlibPublishIntent={version:1,kind:'mdlib_publish',operationId:input.operationId,slug:input.document.slug,title:input.document.title,sourceHash:input.document.sourceHash,targetUrlHash:input.document.targetUrlHash,requestHash:input.document.requestHash,apiKeyHash:sha(input.apiKey),createdAt:(deps.now?.()??new Date()).toISOString()};
  if(persistence.secretStorage!=='encrypted'||!validMdlibApiKey(input.apiKey)||!validDocument(input.document)||!validIntent(intent))return {status:'not_started',reason:'invalid_input'};
  if(input.priorIntent)return validIntent(input.priorIntent)?{status:'blocked',reason:'prior_submission',intent:{...input.priorIntent}}:{status:'not_started',reason:'invalid_input'};
  try{await persistence.persistIntent({...intent})}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(persistence.assertReadyToSubmit({...intent})!==true)throw Error('denied')}catch{return {status:'not_started',reason:'authorization_changed'}}
  const captured=await capture(intent,bodyFor(input.document),input.apiKey,persistence,deps);
  if(!captured.opaque)return {status:'unknown',intent,diagnostic:captured.diagnostic!,opaqueResponseSaved:false};
  const parsed=parseMdlibPublishResponse(captured.opaque,intent);if('diagnostic'in parsed)return {status:'rejected',intent,diagnostic:parsed.diagnostic};
  try{await persistence.promotePublication(parsed);return {status:'created',receipt:parsed.receipt}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}
}

function statusRecord(value:unknown,slug:string,title:string){
  if(!object(value)||value.slug!==slug||value.title!==title||!Number.isSafeInteger(value.word_count)||Number(value.word_count)<0||!iso(value.created_at)||!iso(value.updated_at)||!(value.expires_at===null||iso(value.expires_at)))return;
  return {expiresAt:value.expires_at as string|null};
}
async function readStatus(slug:string,title:string,deps:MdlibDependencies){
  const result=await get(mdlibStatusUrl(slug),{accept:'application/json'},deps,MDLIB_MAX_RESPONSE_BYTES,true);
  if(result.response.status===404)return;
  if(media(result.response)!=='application/json')throw new ReadFailure('invalid');
  return statusRecord(json(result.bytes),slug,title);
}
function inspectPage(html:string,document:MdlibDocument,pageUrl:string,robotsHeader:string){
  for(const selector of ['main article','article','main']){
    const result=inspectRenderedArticle(html,document.markdown,document.targetUrl,selector,{title:document.title,pageUrl,robotsHeader});
    if(result.found)return result;
  }
  return;
}

export async function verifyMdlibPublication(receipt:MdlibPublicationReceipt,document:MdlibDocument,apiKey:string,deps:MdlibDependencies={}):Promise<MdlibVerification>{
  if(!validReceipt(receipt)||!validDocument(document)||!validMdlibApiKey(apiKey)||receipt.apiKeyHash!==sha(apiKey)||receipt.slug!==document.slug||receipt.title!==document.title||receipt.sourceHash!==document.sourceHash||receipt.targetUrlHash!==document.targetUrlHash||receipt.requestHash!==document.requestHash)return {status:'invalid',reason:'binding'};
  try{
    const [status,page,robots]=await Promise.all([
      readStatus(receipt.slug,receipt.title,deps),
      get(receipt.publicUrl,{accept:'text/html'},deps,MDLIB_MAX_PAGE_BYTES),
      get(MDLIB_ROBOTS_URL,{accept:'text/plain'},deps,MDLIB_MAX_RESPONSE_BYTES,true),
    ]);
    if(!status)return {status:'invalid',reason:'status'};
    if(status.expiresAt!==null)return {status:'invalid',reason:'expiry'};
    if(media(page.response)!=='text/html')return {status:'invalid',reason:'response'};
    const html=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(page.bytes),robotsHeader=page.response.headers.get('x-robots-tag')??'',$=load(html);
    applyDeclaredArticleVisibility($);
    if(!publicPagePolicy($,receipt.publicUrl,robotsHeader).valid)return {status:'invalid',reason:'indexing'};
    let robotsState:'allowed'|'not_declared'='not_declared';
    if(robots.response.status===200){
      if(!media(robots.response).startsWith('text/plain'))return {status:'invalid',reason:'robots'};
      const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(robots.bytes),path=new URL(receipt.publicUrl).pathname;
      if(!['googlebot','bingbot'].every(agent=>agentsGatherRobotsAllows(text,path,agent)))return {status:'invalid',reason:'robots'};
      robotsState='allowed';
    }
    const inspected=inspectPage(html,document,receipt.publicUrl,robotsHeader);if(!inspected)return {status:'invalid',reason:'content'};
    return {status:'usable',receipt,rel:inspected.rel,robots:robotsState,pageSha256:sha(page.bytes)};
  }catch(error){return {status:error instanceof ReadFailure&&error.kind==='invalid'?'invalid':'unavailable',reason:error instanceof ReadFailure&&error.kind==='invalid'?'response':'network'}}
}

export async function recoverMdlibPublication(intent:MdlibPublishIntent,document:MdlibDocument,apiKey:string,persistence:MdlibPersistence,deps:MdlibDependencies={}):Promise<MdlibRecovery>{
  if(!validIntent(intent)||!validDocument(document)||!validMdlibApiKey(apiKey)||intent.apiKeyHash!==sha(apiKey)||intent.slug!==document.slug||intent.title!==document.title||intent.sourceHash!==document.sourceHash||intent.targetUrlHash!==document.targetUrlHash||intent.requestHash!==document.requestHash)return {status:'unknown'};
  try{
    const opaque=await persistence.loadOpaqueResponse(intent.operationId);
    if(opaque){
      const parsed=parseMdlibPublishResponse(opaque,intent);
      if(!('diagnostic'in parsed)){
        let promoted=false;try{await persistence.promotePublication(parsed);promoted=true}catch{/* A later recovery may safely retry the encrypted promotion. */}
        const verification=await verifyMdlibPublication(parsed.receipt,document,apiKey,deps);
        if(!promoted)return {status:'storage_pending',reason:'publication_secret_not_confirmed',receipt:parsed.receipt,verification};
        return verification.status==='usable'?{status:'accepted',receipt:parsed.receipt,verification}:{status:'published_unverified',receipt:parsed.receipt,verification};
      }
    }
    // The public status/page pair can locate content, but the documented public
    // schemas expose neither ownership nor the one-time edit key. Keep that gap explicit.
    const status=await readStatus(intent.slug,intent.title,deps);if(!status||status.expiresAt!==null)return {status:'unknown'};
    const publicUrl=mdlibFallbackPublicUrl(intent.slug),page=await get(publicUrl,{accept:'text/html'},deps,MDLIB_MAX_PAGE_BYTES),html=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(page.bytes),robotsHeader=page.response.headers.get('x-robots-tag')??'';
    if(media(page.response)!=='text/html'||!inspectPage(html,document,publicUrl,robotsHeader))return {status:'unknown'};
    return {status:'found_unowned',reason:'public_get_cannot_prove_account_ownership_or_recover_edit_key',publicUrl,expiresAt:null};
  }catch{return {status:'unknown'}}
}
