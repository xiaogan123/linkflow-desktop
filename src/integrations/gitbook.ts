import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import {marked} from 'marked';
import {applyDeclaredArticleVisibility,publicPagePolicy,styleConcealsArticle} from './article-visibility';
import {inspectRenderedArticle} from './article-rendering';
import {agentsGatherRobotsAllows} from './agentsgather-public';

export const GITBOOK_API_ORIGIN='https://api.gitbook.com';
export const GITBOOK_API_ROOT=`${GITBOOK_API_ORIGIN}/v1`;
export const GITBOOK_MAX_RESPONSE_BYTES=256*1024;
export const GITBOOK_MAX_PAGE_BYTES=1024*1024;

const ID=/^[A-Za-z0-9_-]{1,255}$/;
const SLUG=/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const OPERATION=/^gitbook_[a-f0-9]{32}$/;
const HASH=/^[a-f0-9]{64}$/;
const CONTROL=/[\u0000-\u001f\u007f]/u;
const DOCUMENT_CONTROL=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

type JsonObject=Record<string,unknown>;
export type GitBookStage='change_request'|'page'|'merge'|'site_publish';
export interface GitBookDependencies{fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date;allowExternalWrite?:boolean}

export interface GitBookArticle{title:string;slug:string;markdown:string;targetUrl:string;sourceHash:string;targetUrlHash:string}
export interface GitBookBinding{
  organizationId:string;siteId:string;siteSpaceId:string;spaceId:string;
  authenticatedUserIdHash:string;organizationMemberIdHash:string;soleAdmin:true;
  organizationPlan:string;organizationTrialStatus:string;
  siteType:'basic';siteAppliedType:'basic';siteVisibility:'public';sitePublished:boolean;
  sitePublishedUrl?:string;siteSpacePublishedUrl?:string;spaceRevision:string;
  bindingHash:string;tokenHash:string;
}

interface GitBookIntentBase{version:1;kind:'gitbook_intent';stage:GitBookStage;operationId:string;bindingHash:string;tokenHash:string;requestHash:string;createdAt:string}
export interface GitBookChangeRequestIntent extends GitBookIntentBase{stage:'change_request';subject:string}
export interface GitBookPageIntent extends GitBookIntentBase{stage:'page';changeRequestId:string;slug:string;title:string;sourceHash:string;targetUrlHash:string}
export interface GitBookMergeIntent extends GitBookIntentBase{stage:'merge';changeRequestId:string;slug:string;sourceHash:string}
export interface GitBookSitePublishIntent extends GitBookIntentBase{stage:'site_publish'}
export type GitBookIntent=GitBookChangeRequestIntent|GitBookPageIntent|GitBookMergeIntent|GitBookSitePublishIntent;

export interface GitBookOpaqueResponse{version:1;kind:'gitbook_opaque_response';stage:GitBookStage;operationId:string;requestHash:string;endpoint:string;status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string;capturedAt:string}
export interface GitBookChangeRequestReceipt extends GitBookChangeRequestIntent{changeRequestId:string;status:string}
export interface GitBookPageReceipt extends GitBookPageIntent{pageId:string;pageRef:string;location:string}
export interface GitBookMergeReceipt extends GitBookMergeIntent{revision:string;result:'merge'}
export interface GitBookSitePublishReceipt extends GitBookSitePublishIntent{publicUrl:string;published:true}
export type GitBookReceipt=GitBookChangeRequestReceipt|GitBookPageReceipt|GitBookMergeReceipt|GitBookSitePublishReceipt;

/** Callbacks must use durable storage. The PAT itself never enters an intent or receipt. */
export interface GitBookPersistence{
  readonly secretStorage:'encrypted';
  persistIntent(intent:GitBookIntent):Promise<void>;
  assertReadyToSubmit(intent:GitBookIntent):true;
  persistOpaqueResponse(response:GitBookOpaqueResponse):Promise<void>;
  loadOpaqueResponse(stage:GitBookStage,operationId:string):Promise<GitBookOpaqueResponse|undefined>;
  promoteReceipt(receipt:GitBookReceipt):Promise<void>;
}

export type GitBookDiagnostic='transport'|'body_limit'|'opaque_persistence'|'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema';
type NotStarted={status:'not_started';reason:'external_write_disabled'|'invalid_input'|'intent_not_persisted'|'authorization_changed'|'binding_unconfirmed'};
type Blocked<I extends GitBookIntent>={status:'blocked';reason:'prior_submission';intent:I};
type Unknown<I extends GitBookIntent>={status:'unknown';intent:I;diagnostic:GitBookDiagnostic;opaqueResponseSaved:boolean};
type Rejected<I extends GitBookIntent>={status:'rejected';intent:I;diagnostic:'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'};
type StoragePending<I extends GitBookIntent,R extends GitBookReceipt>={status:'storage_pending';intent:I;receipt:R};
export type GitBookWriteResult<I extends GitBookIntent,R extends GitBookReceipt>=NotStarted|Blocked<I>|Unknown<I>|Rejected<I>|StoragePending<I,R>|{status:'created';receipt:R};
export type GitBookMergeResult=GitBookWriteResult<GitBookMergeIntent,GitBookMergeReceipt>|{status:'manual_resolution_required';intent:GitBookMergeIntent;revision:string};
export type GitBookSitePublishResult=GitBookWriteResult<GitBookSitePublishIntent,GitBookSitePublishReceipt>|{status:'already_published';publicUrl:string}|{status:'payment_required';intent:GitBookSitePublishIntent};

export type GitBookBindingProbe=
  |{status:'usable';binding:GitBookBinding}
  |{status:'unconfirmed';reason:'organization_or_site_plan_evidence'|'site_not_published'|'schema';evidence?:{organizationPlan:string;organizationTrialStatus:string;siteType:string;siteAppliedType:string}}
  |{status:'invalid';reason:'identity'|'visibility'|'permissions'|'site_space'|'schema'}
  |{status:'unavailable';reason:'network'};
export type GitBookVerification=
  |{status:'usable';publicUrl:string;rel:string;robots:'allowed'|'not_declared';pageSha256:string}
  |{status:'invalid'|'unavailable';reason:'binding'|'response'|'indexing'|'robots'|'content'|'network'};

const object=(value:unknown):value is JsonObject=>!!value&&typeof value==='object'&&!Array.isArray(value);
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const safe=(value:unknown,maximum=255):value is string=>typeof value==='string'&&value.length>0&&value.length<=maximum&&value===value.trim()&&!CONTROL.test(value);
const iso=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value));
function exactHttps(value:string){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||!url.hostname||(url.port&&url.port!=='443'))throw Error('GitBook URL must be public HTTPS');url.hash='';return url.href}
export function validGitBookToken(value:unknown):value is string{return typeof value==='string'&&value.length>=16&&value.length<=4096&&!/[\s\u0000-\u001f\u007f]/u.test(value)}
function encodedId(value:string){if(!ID.test(value))throw Error('GitBook identifier invalid');return encodeURIComponent(value)}
export const gitBookOrganizationUrl=(organizationId:string)=>`${GITBOOK_API_ROOT}/orgs/${encodedId(organizationId)}`;
export const GITBOOK_AUTHENTICATED_USER_URL=`${GITBOOK_API_ROOT}/user`;
export const gitBookOrganizationMembersUrl=(organizationId:string)=>`${gitBookOrganizationUrl(organizationId)}/members?limit=1000`;
export const gitBookSiteUrl=(organizationId:string,siteId:string)=>`${gitBookOrganizationUrl(organizationId)}/sites/${encodedId(siteId)}`;
export const gitBookSiteSpacesUrl=(organizationId:string,siteId:string)=>`${gitBookSiteUrl(organizationId,siteId)}/site-spaces?default=true&limit=100`;
export const gitBookSitePublishUrl=(organizationId:string,siteId:string)=>`${gitBookSiteUrl(organizationId,siteId)}/publish`;
export const gitBookSpaceUrl=(spaceId:string)=>`${GITBOOK_API_ROOT}/spaces/${encodedId(spaceId)}`;
export const gitBookChangeRequestsUrl=(spaceId:string,status?:string)=>`${gitBookSpaceUrl(spaceId)}/change-requests${status?`?status=${encodeURIComponent(status)}&limit=100`:''}`;
export const gitBookChangeRequestUrl=(spaceId:string,changeRequestId:string)=>`${gitBookChangeRequestsUrl(spaceId)}/${encodedId(changeRequestId)}`;
export const gitBookChangeRequestContentUrl=(spaceId:string,changeRequestId:string)=>`${gitBookChangeRequestUrl(spaceId,changeRequestId)}/content?compat=false`;
export const gitBookMergeUrl=(spaceId:string,changeRequestId:string)=>`${gitBookChangeRequestUrl(spaceId,changeRequestId)}/merge`;
export const gitBookPageReadUrl=(spaceId:string,slug:string,changeRequestId?:string)=>`${changeRequestId?gitBookChangeRequestUrl(spaceId,changeRequestId):gitBookSpaceUrl(spaceId)}/content/path/${encodeURIComponent(slug)}?format=markdown&format.markdown.refs=stable&computed=false`;

function bindingDigest(value:Omit<GitBookBinding,'bindingHash'>){return sha(JSON.stringify(value))}
function validBinding(value:GitBookBinding){
  if(!ID.test(value.organizationId)||!ID.test(value.siteId)||!ID.test(value.siteSpaceId)||!ID.test(value.spaceId)||!HASH.test(value.tokenHash)||!HASH.test(value.authenticatedUserIdHash)||!HASH.test(value.organizationMemberIdHash)||value.soleAdmin!==true||!safe(value.organizationPlan)||!safe(value.organizationTrialStatus)||!safe(value.spaceRevision))return false;
  if(value.siteType!=='basic'||value.siteAppliedType!=='basic'||value.siteVisibility!=='public')return false;
  try{if(value.sitePublishedUrl&&exactHttps(value.sitePublishedUrl)!==value.sitePublishedUrl)return false;if(value.siteSpacePublishedUrl&&exactHttps(value.siteSpacePublishedUrl)!==value.siteSpacePublishedUrl)return false}catch{return false}
  const {bindingHash,...rest}=value;return HASH.test(bindingHash)&&bindingHash===bindingDigest(rest);
}
export function prepareGitBookArticle(input:{title:string;slug:string;markdown:string;targetUrl:string}):GitBookArticle{
  if(!safe(input.title)||!SLUG.test(input.slug)||typeof input.markdown!=='string'||!input.markdown.trim()||DOCUMENT_CONTROL.test(input.markdown)||Buffer.byteLength(input.markdown)>256*1024)throw Error('GitBook article invalid');
  const targetUrl=exactHttps(input.targetUrl),html=marked.parse(input.markdown,{async:false,gfm:true});if(typeof html!=='string')throw Error('GitBook Markdown invalid');
  const $=load(html),matches=$('a[href]').toArray().some(node=>{try{return exactHttps($(node).attr('href')??'')===targetUrl&&$(node).text().trim().length>0}catch{return false}});if(!matches)throw Error('GitBook article must contain the reviewed native link');
  return Object.freeze({title:input.title,slug:input.slug,markdown:input.markdown,targetUrl,sourceHash:sha(input.markdown),targetUrlHash:sha(targetUrl)});
}
function validArticle(value:GitBookArticle){try{return prepareGitBookArticle(value).sourceHash===value.sourceHash&&sha(value.targetUrl)===value.targetUrlHash}catch{return false}}

function discard(response:Response){if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
class BodyLimit extends Error{}
class ReadFailure extends Error{constructor(readonly kind:'invalid'|'unavailable'){super(kind)}}
function aborter(deps:GitBookDependencies){const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const handle=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(50,deps.timeoutMs??20_000)));handle.unref?.();return {controller,dispose(){clearTimeout(handle);deps.signal?.removeEventListener('abort',external)}}}
async function bounded(response:Response,maximum:number,signal:AbortSignal){const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum)){discard(response);throw new BodyLimit()}if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){if(signal.aborted)throw Error('abort');const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maximum){void reader.cancel().catch(()=>undefined);throw new BodyLimit()}parts.push(next.value)}}finally{reader.releaseLock()}return Buffer.concat(parts.map(part=>Buffer.from(part)))}
function media(response:Response){return response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()??''}
function decode(bytes:Uint8Array){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)) as unknown}catch{throw new ReadFailure('invalid')}}
async function read(url:string,token:string,deps:GitBookDependencies,allow404=false,accept='application/json',maximum=GITBOOK_MAX_RESPONSE_BYTES){const timed=aborter(deps);let response:Response|undefined;try{const transport=deps.fetch??((target:string,init:RequestInit)=>fetch(target,init));response=await transport(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:timed.controller.signal,headers:{accept,authorization:`Bearer ${token}`}});if(response.redirected||response.type==='opaqueredirect'||response.status>=300&&response.status<400||response.url&&response.url!==url)throw new ReadFailure('invalid');if(allow404&&response.status===404){discard(response);return {response,bytes:new Uint8Array()}}if(response.status!==200)throw new ReadFailure(response.status>=500||[408,429].includes(response.status)?'unavailable':'invalid');return {response,bytes:await bounded(response,maximum,timed.controller.signal)}}catch(error){if(response&&!response.bodyUsed)discard(response);if(error instanceof ReadFailure)throw error;throw new ReadFailure('unavailable')}finally{timed.dispose()}}

function permission(value:unknown,name:string){return object(value)&&value[name]===true}
function publishedUrl(value:unknown){if(!object(value)||typeof value.published!=='string')return undefined;try{return exactHttps(value.published)}catch{return undefined}}
export async function probeGitBookBinding(input:{organizationId:string;siteId:string;spaceId:string;token:string},deps:GitBookDependencies={}):Promise<GitBookBindingProbe>{
  if(!ID.test(input.organizationId)||!ID.test(input.siteId)||!ID.test(input.spaceId)||!validGitBookToken(input.token))return {status:'invalid',reason:'identity'};
  try{
    const [userRead,membersRead,orgRead,siteRead,spaceRead,spacesRead]=await Promise.all([
      read(GITBOOK_AUTHENTICATED_USER_URL,input.token,deps),
      read(gitBookOrganizationMembersUrl(input.organizationId),input.token,deps),
      read(gitBookOrganizationUrl(input.organizationId),input.token,deps),
      read(gitBookSiteUrl(input.organizationId,input.siteId),input.token,deps),
      read(gitBookSpaceUrl(input.spaceId),input.token,deps),
      read(gitBookSiteSpacesUrl(input.organizationId,input.siteId),input.token,deps),
    ]);
    if([userRead,membersRead,orgRead,siteRead,spaceRead,spacesRead].some(item=>media(item.response)!=='application/json'))return {status:'invalid',reason:'schema'};
    const user=decode(userRead.bytes),members=decode(membersRead.bytes),org=decode(orgRead.bytes),site=decode(siteRead.bytes),space=decode(spaceRead.bytes),siteSpaces=decode(spacesRead.bytes);
    if(!object(user)||user.object!=='user'||!ID.test(String(user.id??''))||!object(members)||!Array.isArray(members.items)||members.items.length!==1||!object(members.items[0])||members.count!==undefined&&members.count!==1||members.next!==undefined)return {status:'invalid',reason:'permissions'};
    const member=members.items[0];if(member.object!=='member'||!ID.test(String(member.id??''))||member.role!=='admin'||member.disabled!==false||!object(member.user)||member.user.object!=='user'||member.user.id!==user.id)return {status:'invalid',reason:'permissions'};
    if(!object(org)||org.id!==input.organizationId||!safe(org.plan)||!object(org.trial)||!safe(org.trial.status))return {status:'invalid',reason:'schema'};
    if(!object(site)||site.id!==input.siteId)return {status:'invalid',reason:'identity'};
    if(!safe(site.type)||!safe(site.appliedType)||typeof site.published!=='boolean'||!object(site.permissions))return {status:'invalid',reason:'schema'};
    if(site.type!=='basic'||site.appliedType!=='basic')return {status:'unconfirmed',reason:'organization_or_site_plan_evidence',evidence:{organizationPlan:org.plan,organizationTrialStatus:org.trial.status,siteType:site.type,siteAppliedType:site.appliedType}};
    if(site.visibility!=='public')return {status:'invalid',reason:'visibility'};
    if(!permission(site.permissions,'admin')&&!permission(site.permissions,'create'))return {status:'invalid',reason:'permissions'};
    if(!object(space)||space.id!==input.spaceId||!safe(space.revision)||!object(space.permissions))return {status:'invalid',reason:'schema'};
    const spaceOrg=typeof space.organization==='string'?space.organization:typeof space.organizationId==='string'?space.organizationId:object(space.organization)&&typeof space.organization.id==='string'?space.organization.id:undefined;
    if(spaceOrg!==input.organizationId)return {status:'invalid',reason:'identity'};
    if(!permission(space.permissions,'edit')||!permission(space.permissions,'merge'))return {status:'invalid',reason:'permissions'};
    if(!object(siteSpaces)||!Array.isArray(siteSpaces.items)||siteSpaces.items.length!==1||!object(siteSpaces.items[0])||siteSpaces.count!==undefined&&siteSpaces.count!==1||siteSpaces.next!==undefined)return {status:'invalid',reason:'site_space'};
    const siteSpace=siteSpaces.items[0];
    if(!safe(siteSpace.id)||!object(siteSpace.space)||siteSpace.space.id!==input.spaceId||siteSpace.draft!==false||siteSpace.default===false)return {status:'invalid',reason:'site_space'};
    const siteUrl=publishedUrl(site.urls),siteSpaceUrl=publishedUrl(siteSpace.urls);
    if(site.published===true&&(!siteUrl||!siteSpaceUrl))return {status:'invalid',reason:'schema'};
    const partial:Omit<GitBookBinding,'bindingHash'>={organizationId:input.organizationId,siteId:input.siteId,siteSpaceId:siteSpace.id,spaceId:input.spaceId,authenticatedUserIdHash:sha(String(user.id)),organizationMemberIdHash:sha(String(member.id)),soleAdmin:true,organizationPlan:org.plan,organizationTrialStatus:org.trial.status,siteType:'basic',siteAppliedType:'basic',siteVisibility:'public',sitePublished:site.published,spaceRevision:space.revision,tokenHash:sha(input.token),...(siteUrl?{sitePublishedUrl:siteUrl}:{}),...(siteSpaceUrl?{siteSpacePublishedUrl:siteSpaceUrl}:{})};
    return {status:'usable',binding:{...partial,bindingHash:bindingDigest(partial)}};
  }catch(error){if(error instanceof ReadFailure&&error.kind==='invalid')return {status:'invalid',reason:'schema'};return {status:'unavailable',reason:'network'}}
}

function requestHash(endpoint:string,body:string){return sha(`POST ${endpoint}\ncontent-type:application/json\n${body}`)}
function validIntent(value:GitBookIntent){
  if(!object(value)||value.version!==1||value.kind!=='gitbook_intent'||!['change_request','page','merge','site_publish'].includes(value.stage)||!OPERATION.test(value.operationId)||!HASH.test(value.bindingHash)||!HASH.test(value.tokenHash)||!HASH.test(value.requestHash)||!iso(value.createdAt))return false;
  if(value.stage==='change_request')return safe(value.subject,255);
  if(value.stage==='page')return ID.test(value.changeRequestId)&&SLUG.test(value.slug)&&safe(value.title)&&HASH.test(value.sourceHash)&&HASH.test(value.targetUrlHash);
  if(value.stage==='merge')return ID.test(value.changeRequestId)&&SLUG.test(value.slug)&&HASH.test(value.sourceHash);
  return true;
}
function strictOpaque(value:GitBookOpaqueResponse,intent:GitBookIntent,endpoint:string){
  if(!object(value)||value.version!==1||value.kind!=='gitbook_opaque_response'||value.stage!==intent.stage||value.operationId!==intent.operationId||value.requestHash!==intent.requestHash||value.endpoint!==endpoint||!HASH.test(value.bodySha256)||!iso(value.capturedAt))return false;
  const bytes=Buffer.from(value.bodyBase64,'base64');return bytes.length<=GITBOOK_MAX_RESPONSE_BYTES&&bytes.toString('base64')===value.bodyBase64&&sha(bytes)===value.bodySha256;
}
function opaqueDiagnostic(value:GitBookOpaqueResponse,intent:GitBookIntent,endpoint:string,statuses:number[]){
  if(!strictOpaque(value,intent,endpoint))return 'schema' as const;
  if(value.redirected||value.responseType==='opaqueredirect'||value.status>=300&&value.status<400||value.responseUrl&&value.responseUrl!==endpoint)return 'redirect' as const;
  if(!statuses.includes(value.status))return 'http_status' as const;
  if(value.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return 'media_type' as const;
}
function opaqueJson(value:GitBookOpaqueResponse):{value:unknown}|{diagnostic:'decode'|'json'}{let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(value.bodyBase64,'base64'))}catch{return {diagnostic:'decode'}}try{return {value:JSON.parse(text) as unknown}}catch{return {diagnostic:'json'}}}
async function capture(intent:GitBookIntent,endpoint:string,body:string,token:string,persistence:GitBookPersistence,deps:GitBookDependencies):Promise<{opaque?:GitBookOpaqueResponse;diagnostic?:'transport'|'body_limit'|'opaque_persistence'}>{
  const timed=aborter(deps);let response:Response|undefined;
  try{
    const transport=deps.fetch??((target:string,init:RequestInit)=>fetch(target,init));
    response=await transport(endpoint,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:timed.controller.signal,headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${token}`},body});
    const bytes=await bounded(response,GITBOOK_MAX_RESPONSE_BYTES,timed.controller.signal);
    const opaque:GitBookOpaqueResponse={version:1,kind:'gitbook_opaque_response',stage:intent.stage,operationId:intent.operationId,requestHash:intent.requestHash,endpoint,status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:sha(bytes),capturedAt:(deps.now?.()??new Date()).toISOString()};
    try{await persistence.persistOpaqueResponse(opaque)}catch{return {diagnostic:'opaque_persistence'}}return {opaque};
  }catch(error){if(response&&!response.bodyUsed)discard(response);return {diagnostic:error instanceof BodyLimit?'body_limit':'transport'}}finally{timed.dispose()}
}
async function preflight<I extends GitBookIntent>(intent:I,prior:I|undefined,binding:GitBookBinding,token:string,persistence:GitBookPersistence,deps:GitBookDependencies):Promise<NotStarted|Blocked<I>|undefined>{
  if(deps.allowExternalWrite!==true)return {status:'not_started',reason:'external_write_disabled'};
  if(persistence.secretStorage!=='encrypted'||!validGitBookToken(token)||!validBinding(binding)||binding.tokenHash!==sha(token)||intent.bindingHash!==binding.bindingHash||intent.tokenHash!==binding.tokenHash||!validIntent(intent))return {status:'not_started',reason:'invalid_input'};
  if(prior)return validIntent(prior)&&prior.stage===intent.stage&&prior.operationId===intent.operationId&&prior.requestHash===intent.requestHash&&prior.bindingHash===intent.bindingHash?{status:'blocked',reason:'prior_submission',intent:{...prior}}:{status:'not_started',reason:'invalid_input'};
  try{await persistence.persistIntent({...intent})}catch{return {status:'not_started',reason:'intent_not_persisted'}}
}
function authorize<I extends GitBookIntent>(intent:I,persistence:GitBookPersistence):NotStarted|undefined{try{if(persistence.assertReadyToSubmit({...intent})!==true)throw Error('denied')}catch{return {status:'not_started',reason:'authorization_changed'}}}
async function promote<I extends GitBookIntent,R extends GitBookReceipt>(intent:I,receipt:R,persistence:GitBookPersistence):Promise<{status:'created';receipt:R}|StoragePending<I,R>>{try{await persistence.promoteReceipt(receipt);return {status:'created',receipt}}catch{return {status:'storage_pending',intent,receipt}}}
function rejected<I extends GitBookIntent>(intent:I,diagnostic:'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'):Rejected<I>{return {status:'rejected',intent,diagnostic}}
function unknown<I extends GitBookIntent>(intent:I,diagnostic:GitBookDiagnostic,opaqueResponseSaved:boolean):Unknown<I>{return {status:'unknown',intent,diagnostic,opaqueResponseSaved}}

export function gitBookChangeRequestSubject(article:GitBookArticle,operationId:string){if(!validArticle(article)||!OPERATION.test(operationId))throw Error('GitBook change request subject invalid');return `${article.title} [${operationId.slice(-12)}]`}
export async function createGitBookChangeRequest(input:{operationId:string;binding:GitBookBinding;token:string;article:GitBookArticle;priorIntent?:GitBookChangeRequestIntent},persistence:GitBookPersistence,deps:GitBookDependencies={}):Promise<GitBookWriteResult<GitBookChangeRequestIntent,GitBookChangeRequestReceipt>>{
  const subject=gitBookChangeRequestSubject(input.article,input.operationId),endpoint=gitBookChangeRequestsUrl(input.binding.spaceId),body=JSON.stringify({subject});
  const intent:GitBookChangeRequestIntent={version:1,kind:'gitbook_intent',stage:'change_request',operationId:input.operationId,bindingHash:input.binding.bindingHash,tokenHash:sha(input.token),subject,requestHash:requestHash(endpoint,body),createdAt:(deps.now?.()??new Date()).toISOString()};
  const stop=await preflight(intent,input.priorIntent,input.binding,input.token,persistence,deps);if(stop)return stop;
  const denied=authorize(intent,persistence);if(denied)return denied;
  const captured=await capture(intent,endpoint,body,input.token,persistence,deps);if(!captured.opaque)return unknown(intent,captured.diagnostic!,false);
  const parsed=parseGitBookChangeRequestResponse(captured.opaque,intent,input.binding);if('diagnostic'in parsed)return rejected(intent,parsed.diagnostic);return promote(intent,parsed.receipt,persistence);
}
export function parseGitBookChangeRequestResponse(response:GitBookOpaqueResponse,intent:GitBookChangeRequestIntent,binding:GitBookBinding):{receipt:GitBookChangeRequestReceipt}|{diagnostic:'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'}{
  const endpoint=gitBookChangeRequestsUrl(binding.spaceId),invalid=opaqueDiagnostic(response,intent,endpoint,[201]);if(invalid)return {diagnostic:invalid};const parsed=opaqueJson(response);if('diagnostic'in parsed)return parsed;const value=parsed.value;
  if(!object(value)||!ID.test(String(value.id??''))||!safe(value.status)||value.subject!==intent.subject)return {diagnostic:'schema'};
  return {receipt:{...intent,changeRequestId:String(value.id),status:value.status}};
}

function pageBody(article:GitBookArticle){return JSON.stringify({changes:[{operation:'insert_page',document:{markdown:article.markdown},title:article.title,slug:article.slug,ref:article.slug,noIndex:false,noRobotsIndex:false}]})}
export async function insertGitBookPage(input:{operationId:string;binding:GitBookBinding;token:string;changeRequestId:string;article:GitBookArticle;priorIntent?:GitBookPageIntent},persistence:GitBookPersistence,deps:GitBookDependencies={}):Promise<GitBookWriteResult<GitBookPageIntent,GitBookPageReceipt>>{
  if(!ID.test(input.changeRequestId)||!validArticle(input.article))return {status:'not_started',reason:'invalid_input'};
  const endpoint=gitBookChangeRequestContentUrl(input.binding.spaceId,input.changeRequestId),body=pageBody(input.article);
  const intent:GitBookPageIntent={version:1,kind:'gitbook_intent',stage:'page',operationId:input.operationId,bindingHash:input.binding.bindingHash,tokenHash:sha(input.token),changeRequestId:input.changeRequestId,slug:input.article.slug,title:input.article.title,sourceHash:input.article.sourceHash,targetUrlHash:input.article.targetUrlHash,requestHash:requestHash(endpoint,body),createdAt:(deps.now?.()??new Date()).toISOString()};
  const stop=await preflight(intent,input.priorIntent,input.binding,input.token,persistence,deps);if(stop)return stop;
  try{const existing=await read(gitBookPageReadUrl(input.binding.spaceId,input.article.slug,input.changeRequestId),input.token,deps,true);if(existing.response.status!==404)return rejected(intent,'schema')}catch{return unknown(intent,'transport',false)}
  const denied=authorize(intent,persistence);if(denied)return denied;
  const captured=await capture(intent,endpoint,body,input.token,persistence,deps);if(!captured.opaque)return unknown(intent,captured.diagnostic!,false);
  const parsed=parseGitBookPageResponse(captured.opaque,intent,input.binding);if('diagnostic'in parsed)return rejected(intent,parsed.diagnostic);return promote(intent,parsed.receipt,persistence);
}
export function parseGitBookPageResponse(response:GitBookOpaqueResponse,intent:GitBookPageIntent,binding:GitBookBinding):{receipt:GitBookPageReceipt}|{diagnostic:'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'}{
  const endpoint=gitBookChangeRequestContentUrl(binding.spaceId,intent.changeRequestId),invalid=opaqueDiagnostic(response,intent,endpoint,[200]);if(invalid)return {diagnostic:invalid};const parsed=opaqueJson(response);if('diagnostic'in parsed)return parsed;const value=parsed.value;
  if(!object(value)||!Array.isArray(value.changes)||value.changes.length!==1||!object(value.changes[0]))return {diagnostic:'schema'};const change=value.changes[0];
  if(change.object!=='created_page'||change.ref!==intent.slug||!object(change.page)||!ID.test(String(change.page.id??''))||!object(change.page.urls)||!safe(change.page.urls.location,2048))return {diagnostic:'schema'};
  return {receipt:{...intent,pageId:String(change.page.id),pageRef:change.ref,location:change.page.urls.location}};
}

// format=markdown exposes MarkdownDocument fields at page level. Mutation
// payloads use the separate, nested `document: {markdown}` shape.
function pageMarkdown(value:unknown){if(!object(value)||typeof value.markdown!=='string')return;return value.markdown}
function markdownMatches(value:unknown,article:GitBookArticle){
  const markdown=pageMarkdown(value);if(markdown===undefined)return false;
  try{
    const expected=marked.parse(article.markdown,{async:false,gfm:true}),actual=marked.parse(markdown,{async:false,gfm:true});if(typeof expected!=='string'||typeof actual!=='string')return false;
    const a=load(expected),b=load(actual),normalize=(text:string)=>text.replace(/\s+/gu,' ').trim();
    if(normalize(a.root().text())!==normalize(b.root().text()))return false;
    return b('a[href]').toArray().some(node=>{try{return exactHttps(b(node).attr('href')??'')===article.targetUrl&&b(node).text().trim().length>0}catch{return false}});
  }catch{return false}
}

export async function mergeGitBookChangeRequest(input:{operationId:string;binding:GitBookBinding;token:string;changeRequestId:string;article:GitBookArticle;priorIntent?:GitBookMergeIntent},persistence:GitBookPersistence,deps:GitBookDependencies={}):Promise<GitBookMergeResult>{
  if(!ID.test(input.changeRequestId)||!validArticle(input.article))return {status:'not_started',reason:'invalid_input'};
  const endpoint=gitBookMergeUrl(input.binding.spaceId,input.changeRequestId),body='{}';
  const intent:GitBookMergeIntent={version:1,kind:'gitbook_intent',stage:'merge',operationId:input.operationId,bindingHash:input.binding.bindingHash,tokenHash:sha(input.token),changeRequestId:input.changeRequestId,slug:input.article.slug,sourceHash:input.article.sourceHash,requestHash:requestHash(endpoint,body),createdAt:(deps.now?.()??new Date()).toISOString()};
  const stop=await preflight(intent,input.priorIntent,input.binding,input.token,persistence,deps);if(stop)return stop;
  try{const page=await read(gitBookPageReadUrl(input.binding.spaceId,input.article.slug,input.changeRequestId),input.token,deps);if(media(page.response)!=='application/json'||!markdownMatches(decode(page.bytes),input.article))return rejected(intent,'schema')}catch{return unknown(intent,'transport',false)}
  const denied=authorize(intent,persistence);if(denied)return denied;
  const captured=await capture(intent,endpoint,body,input.token,persistence,deps);if(!captured.opaque)return unknown(intent,captured.diagnostic!,false);
  const parsed=parseGitBookMergeResponse(captured.opaque,intent,input.binding);if('diagnostic'in parsed)return rejected(intent,parsed.diagnostic);if(parsed.result==='conflicts')return {status:'manual_resolution_required',intent,revision:parsed.revision};return promote(intent,{...intent,revision:parsed.revision,result:'merge'},persistence);
}
export function parseGitBookMergeResponse(response:GitBookOpaqueResponse,intent:GitBookMergeIntent,binding:GitBookBinding):{revision:string;result:'merge'|'conflicts'}|{diagnostic:'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'}{
  const endpoint=gitBookMergeUrl(binding.spaceId,intent.changeRequestId),invalid=opaqueDiagnostic(response,intent,endpoint,[200]);if(invalid)return {diagnostic:invalid};const parsed=opaqueJson(response);if('diagnostic'in parsed)return parsed;const value=parsed.value;
  if(!object(value)||!safe(value.revision)||!['merge','conflicts'].includes(String(value.result)))return {diagnostic:'schema'};return {revision:value.revision,result:value.result as 'merge'|'conflicts'};
}

function sitePublishReceipt(value:unknown,intent:GitBookSitePublishIntent,siteId:string){if(!object(value)||value.id!==siteId||value.type!=='basic'||value.appliedType!=='basic'||value.visibility!=='public'||value.published!==true)return;const publicUrl=publishedUrl(value.urls);if(!publicUrl)return;return {...intent,publicUrl,published:true as const}}
export async function publishGitBookSite(input:{operationId:string;binding:GitBookBinding;token:string;priorIntent?:GitBookSitePublishIntent},persistence:GitBookPersistence,deps:GitBookDependencies={}):Promise<GitBookSitePublishResult>{
  if(input.binding.sitePublished&&input.binding.sitePublishedUrl)return {status:'already_published',publicUrl:input.binding.sitePublishedUrl};
  const endpoint=gitBookSitePublishUrl(input.binding.organizationId,input.binding.siteId),body='{}';
  const intent:GitBookSitePublishIntent={version:1,kind:'gitbook_intent',stage:'site_publish',operationId:input.operationId,bindingHash:input.binding.bindingHash,tokenHash:sha(input.token),requestHash:requestHash(endpoint,body),createdAt:(deps.now?.()??new Date()).toISOString()};
  const stop=await preflight(intent,input.priorIntent,input.binding,input.token,persistence,deps);if(stop)return stop;
  const denied=authorize(intent,persistence);if(denied)return denied;
  const captured=await capture(intent,endpoint,body,input.token,persistence,deps);if(!captured.opaque)return unknown(intent,captured.diagnostic!,false);
  const invalid=opaqueDiagnostic(captured.opaque,intent,endpoint,[200]);if(invalid)return rejected(intent,invalid);const parsed=opaqueJson(captured.opaque);if('diagnostic'in parsed)return rejected(intent,parsed.diagnostic);const value=parsed.value;
  if(object(value)&&value.type==='checkout'&&safe(value.sessionId,4096))return {status:'payment_required',intent};
  const receipt=sitePublishReceipt(value,intent,input.binding.siteId);if(!receipt)return rejected(intent,'schema');return promote(intent,receipt,persistence);
}

function sameBase(intent:GitBookIntent,binding:GitBookBinding,token:string){return validIntent(intent)&&validBinding(binding)&&validGitBookToken(token)&&intent.bindingHash===binding.bindingHash&&intent.tokenHash===sha(token)}
async function recoverOpaque<R extends GitBookReceipt>(intent:GitBookIntent,persistence:GitBookPersistence,parse:(opaque:GitBookOpaqueResponse)=>R|undefined){const opaque=await persistence.loadOpaqueResponse(intent.stage,intent.operationId);if(!opaque)return;const receipt=parse(opaque);if(!receipt)return;try{await persistence.promoteReceipt(receipt);return {status:'created' as const,receipt}}catch{return {status:'storage_pending' as const,intent,receipt}}}

export async function recoverGitBookChangeRequest(intent:GitBookChangeRequestIntent,binding:GitBookBinding,token:string,persistence:GitBookPersistence,deps:GitBookDependencies={}):Promise<{status:'created';receipt:GitBookChangeRequestReceipt}|StoragePending<GitBookChangeRequestIntent,GitBookChangeRequestReceipt>|{status:'found';receipt:GitBookChangeRequestReceipt}|{status:'unknown'}>{
  if(!sameBase(intent,binding,token))return {status:'unknown'};
  try{
    const saved=await recoverOpaque(intent,persistence,opaque=>{const parsed=parseGitBookChangeRequestResponse(opaque,intent,binding);return 'receipt'in parsed?parsed.receipt:undefined});if(saved)return saved as {status:'created';receipt:GitBookChangeRequestReceipt}|StoragePending<GitBookChangeRequestIntent,GitBookChangeRequestReceipt>;
    const result=await read(`${gitBookChangeRequestsUrl(binding.spaceId,'draft')}`,token,deps);if(media(result.response)!=='application/json')return {status:'unknown'};const value=decode(result.bytes);if(!object(value)||!Array.isArray(value.items))return {status:'unknown'};
    const matches=value.items.filter(item=>object(item)&&item.subject===intent.subject&&ID.test(String(item.id??''))&&safe(item.status));if(matches.length!==1||!object(matches[0]))return {status:'unknown'};const item=matches[0];
    return {status:'found',receipt:{...intent,changeRequestId:String(item.id),status:String(item.status)}};
  }catch{return {status:'unknown'}}
}
export async function recoverGitBookPage(intent:GitBookPageIntent,binding:GitBookBinding,article:GitBookArticle,token:string,persistence:GitBookPersistence,deps:GitBookDependencies={}):Promise<{status:'created';receipt:GitBookPageReceipt}|StoragePending<GitBookPageIntent,GitBookPageReceipt>|{status:'found';pageId:string;slug:string}|{status:'unknown'}>{
  if(!sameBase(intent,binding,token)||!validArticle(article)||intent.slug!==article.slug||intent.sourceHash!==article.sourceHash||intent.targetUrlHash!==article.targetUrlHash)return {status:'unknown'};
  try{
    const saved=await recoverOpaque(intent,persistence,opaque=>{const parsed=parseGitBookPageResponse(opaque,intent,binding);return 'receipt'in parsed?parsed.receipt:undefined});if(saved)return saved as {status:'created';receipt:GitBookPageReceipt}|StoragePending<GitBookPageIntent,GitBookPageReceipt>;
    const result=await read(gitBookPageReadUrl(binding.spaceId,intent.slug,intent.changeRequestId),token,deps);if(media(result.response)!=='application/json')return {status:'unknown'};const value=decode(result.bytes);if(!object(value)||!ID.test(String(value.id??''))||value.title!==intent.title||value.type!=='document'||value.noIndex===true||value.noRobotsIndex===true||!(value.slug===intent.slug||typeof value.path==='string'&&(value.path===intent.slug||value.path.endsWith(`/${intent.slug}`)))||!markdownMatches(value,article))return {status:'unknown'};return {status:'found',pageId:String(value.id),slug:intent.slug};
  }catch{return {status:'unknown'}}
}
export async function recoverGitBookMerge(intent:GitBookMergeIntent,binding:GitBookBinding,article:GitBookArticle,token:string,persistence:GitBookPersistence,deps:GitBookDependencies={}):Promise<{status:'created';receipt:GitBookMergeReceipt}|StoragePending<GitBookMergeIntent,GitBookMergeReceipt>|{status:'found';revision:string}|{status:'unknown'}>{
  if(!sameBase(intent,binding,token)||!validArticle(article)||intent.slug!==article.slug||intent.sourceHash!==article.sourceHash)return {status:'unknown'};
  try{
    const saved=await recoverOpaque(intent,persistence,opaque=>{const parsed=parseGitBookMergeResponse(opaque,intent,binding);return 'result'in parsed&&parsed.result==='merge'?{...intent,revision:parsed.revision,result:'merge' as const}:undefined});if(saved)return saved as {status:'created';receipt:GitBookMergeReceipt}|StoragePending<GitBookMergeIntent,GitBookMergeReceipt>;
    const [cr,page]=await Promise.all([read(gitBookChangeRequestUrl(binding.spaceId,intent.changeRequestId),token,deps),read(gitBookPageReadUrl(binding.spaceId,intent.slug),token,deps)]);if(media(cr.response)!=='application/json'||media(page.response)!=='application/json')return {status:'unknown'};const crValue=decode(cr.bytes),pageValue=decode(page.bytes);if(!object(crValue)||crValue.status!=='merged'||!safe(crValue.revision)||!markdownMatches(pageValue,article))return {status:'unknown'};return {status:'found',revision:crValue.revision};
  }catch{return {status:'unknown'}}
}
export async function recoverGitBookSitePublish(intent:GitBookSitePublishIntent,binding:GitBookBinding,token:string,persistence:GitBookPersistence,deps:GitBookDependencies={}):Promise<{status:'created';receipt:GitBookSitePublishReceipt}|StoragePending<GitBookSitePublishIntent,GitBookSitePublishReceipt>|{status:'found';publicUrl:string}|{status:'unknown'}>{
  if(!sameBase(intent,binding,token))return {status:'unknown'};
  try{
    const saved=await recoverOpaque(intent,persistence,opaque=>{const endpoint=gitBookSitePublishUrl(binding.organizationId,binding.siteId),invalid=opaqueDiagnostic(opaque,intent,endpoint,[200]);if(invalid)return;const parsed=opaqueJson(opaque);return 'value'in parsed?sitePublishReceipt(parsed.value,intent,binding.siteId):undefined});if(saved)return saved as {status:'created';receipt:GitBookSitePublishReceipt}|StoragePending<GitBookSitePublishIntent,GitBookSitePublishReceipt>;
    const result=await read(gitBookSiteUrl(binding.organizationId,binding.siteId),token,deps);if(media(result.response)!=='application/json')return {status:'unknown'};const receipt=sitePublishReceipt(decode(result.bytes),intent,binding.siteId);return receipt?{status:'found',publicUrl:receipt.publicUrl}:{status:'unknown'};
  }catch{return {status:'unknown'}}
}

async function readPublic(url:string,deps:GitBookDependencies,accept:string,maximum:number,allow404=false,redirectTarget?:string):Promise<{response:Response;bytes:Uint8Array}>{const timed=aborter(deps);let response:Response|undefined;try{const transport=deps.fetch??((target:string,init:RequestInit)=>fetch(target,init));response=await transport(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:timed.controller.signal,headers:{accept}});if(response.redirected||response.type==='opaqueredirect'||response.url&&response.url!==url)throw new ReadFailure('invalid');if(response.status>=300&&response.status<400){const location=response.headers.get('location');if(!redirectTarget||![301,302,307,308].includes(response.status)||!location)throw new ReadFailure('invalid');let resolved:URL,expected:URL,source:URL;try{resolved=new URL(location,url);expected=new URL(redirectTarget);source=new URL(url)}catch{throw new ReadFailure('invalid')}if(resolved.href!==expected.href||resolved.href===source.href||resolved.protocol!=='https:'||resolved.origin!==source.origin||resolved.username||resolved.password||resolved.search||resolved.hash)throw new ReadFailure('invalid');discard(response);return readPublic(expected.href,deps,accept,maximum,allow404)}if(allow404&&response.status===404){discard(response);return {response,bytes:new Uint8Array()}}if(response.status!==200)throw new ReadFailure(response.status>=500||[408,429].includes(response.status)?'unavailable':'invalid');return {response,bytes:await bounded(response,maximum,timed.controller.signal)}}catch(error){if(response&&!response.bodyUsed)discard(response);if(error instanceof ReadFailure)throw error;throw new ReadFailure('unavailable')}finally{timed.dispose()}}
function articlePublicUrl(base:string,slug:string){const url=new URL(base);if(!url.pathname.endsWith('/'))url.pathname+=`/`;url.pathname+=slug;url.search='';url.hash='';return url.href}
function normalizedDomText(value:string){return value.normalize('NFC').replace(/\s+/gu,' ').trim()}
function gitBookElementHidden($:ReturnType<typeof load>,element:unknown){
  let current=$(element as Parameters<typeof $>[0]);
  while(current.length){
    const name=((current.get(0) as {tagName?:string}|undefined)?.tagName??'').toLowerCase(),classes=new Set((current.attr('class')??'').split(/\s+/u).filter(Boolean));
    if(['head','script','style','template','noscript'].includes(name)||current.is('[hidden],[aria-hidden="true"]')||['hidden','invisible','collapse','sr-only'].some(value=>classes.has(value))||styleConcealsArticle(current.attr('style')??''))return true;
    current=current.parent();
  }
  return false;
}
function inspectPublicPage(html:string,article:GitBookArticle,url:string,robotsHeader:string){
  const $=load(html);applyDeclaredArticleVisibility($);const mains=$('main').toArray(),gitBookRoots=$('[data-content-ref-root]').toArray();
  if(gitBookRoots.length){
    if(mains.length!==1||gitBookElementHidden($,mains[0])||gitBookRoots.length!==1)return;
    const containers=$(mains[0]).children('div').toArray().filter(element=>$(element).children('header').children('h1').length>0&&$(element).children('[data-content-ref-root]').length>0);
    if(containers.length===1){
      const headers=$(containers[0]).children('header').toArray(),headings=$(containers[0]).children('header').children('h1').toArray(),roots=$(containers[0]).children('[data-content-ref-root]').toArray();
      if(headers.length===1&&headings.length===1&&roots.length===1&&!gitBookElementHidden($,headings[0])&&normalizedDomText($(headings[0]).text())===normalizedDomText(article.title)){
        const result=inspectRenderedArticle(html,article.markdown,article.targetUrl,'main > div:has(> header > h1) > [data-content-ref-root]',{title:article.title,pageUrl:url,robotsHeader});
        if(result.found)return result;
      }
    }
    return;
  }
  for(const selector of ['main article','article','main']){const result=inspectRenderedArticle(html,article.markdown,article.targetUrl,selector,{title:article.title,pageUrl:url,robotsHeader});if(result.found)return result}
}
export async function verifyGitBookPublication(binding:GitBookBinding,article:GitBookArticle,token:string,deps:GitBookDependencies={}):Promise<GitBookVerification>{
  if(!validBinding(binding)||!validArticle(article)||!validGitBookToken(token)||binding.tokenHash!==sha(token))return {status:'invalid',reason:'binding'};
  try{
    const current=await probeGitBookBinding({organizationId:binding.organizationId,siteId:binding.siteId,spaceId:binding.spaceId,token},deps);if(current.status!=='usable'||current.binding.siteSpaceId!==binding.siteSpaceId||current.binding.authenticatedUserIdHash!==binding.authenticatedUserIdHash||current.binding.organizationMemberIdHash!==binding.organizationMemberIdHash||!current.binding.sitePublished||!current.binding.siteSpacePublishedUrl)return {status:'invalid',reason:'binding'};
    const apiPage=await read(gitBookPageReadUrl(binding.spaceId,article.slug),token,deps);if(media(apiPage.response)!=='application/json')return {status:'invalid',reason:'response'};const apiValue=decode(apiPage.bytes);
    // The OpenAPI defaults both flags to false and the live API omits them
    // when unset. Explicit true is rejected; the public HTML/robots checks
    // below independently verify the effective indexing result.
    if(!object(apiValue)||apiValue.title!==article.title||apiValue.noIndex===true||apiValue.noRobotsIndex===true||!markdownMatches(apiValue,article))return {status:'invalid',reason:'content'};
    const publicUrl=articlePublicUrl(current.binding.siteSpacePublishedUrl,article.slug),origin=new URL(publicUrl).origin,robotsUrl=`${origin}/robots.txt`,siteSpaceRobotsUrl=new URL('robots.txt',current.binding.siteSpacePublishedUrl).href;
    const [page,robots]=await Promise.all([readPublic(publicUrl,deps,'text/html',GITBOOK_MAX_PAGE_BYTES),readPublic(robotsUrl,deps,'text/plain',GITBOOK_MAX_RESPONSE_BYTES,true,siteSpaceRobotsUrl===robotsUrl?undefined:siteSpaceRobotsUrl)]);
    if(media(page.response)!=='text/html')return {status:'invalid',reason:'response'};const html=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(page.bytes),robotsHeader=page.response.headers.get('x-robots-tag')??'',$=load(html);applyDeclaredArticleVisibility($);if(!publicPagePolicy($,publicUrl,robotsHeader).valid)return {status:'invalid',reason:'indexing'};
    let robotsState:'allowed'|'not_declared'='not_declared';if(robots.response.status===200){if(!media(robots.response).startsWith('text/plain'))return {status:'invalid',reason:'robots'};const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(robots.bytes),path=new URL(publicUrl).pathname;if(!['googlebot','bingbot'].every(agent=>agentsGatherRobotsAllows(text,path,agent)))return {status:'invalid',reason:'robots'};robotsState='allowed'}
    const inspected=inspectPublicPage(html,article,publicUrl,robotsHeader);if(!inspected)return {status:'invalid',reason:'content'};return {status:'usable',publicUrl,rel:inspected.rel,robots:robotsState,pageSha256:sha(page.bytes)};
  }catch(error){if(error instanceof ReadFailure&&error.kind==='invalid')return {status:'invalid',reason:'response'};return {status:'unavailable',reason:'network'}}
}

