import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import {agentsGatherRobotsAllows} from './agentsgather-public';
import {publicPagePolicy} from './article-visibility';

export const VALTOWN_API_ORIGIN='https://api.val.town';
export const VALTOWN_ACCOUNT_URL=`${VALTOWN_API_ORIGIN}/v1/me`;
export const VALTOWN_MY_VALS_URL=`${VALTOWN_API_ORIGIN}/v2/me/vals?limit=1&offset=0`;
export const VALTOWN_VALS_URL=`${VALTOWN_API_ORIGIN}/v2/vals`;
export const VALTOWN_HTTP_FILE_PATH='index.http.tsx';
export const VALTOWN_MAX_JSON_BYTES=128*1024;
export const VALTOWN_MAX_SOURCE_BYTES=512*1024;
export const VALTOWN_MAX_PUBLIC_BYTES=1024*1024;

const HASH=/^[a-f0-9]{64}$/;
const OPERATION=/^valtown_[a-f0-9]{32}$/;
const SAFE_ID=/^[A-Za-z0-9_-]{8,128}$/;
const USERNAME=/^[A-Za-z0-9_-]{1,64}$/;
const VAL_NAME=/^[A-Za-z][A-Za-z0-9_-]{1,62}[A-Za-z0-9]$/;
const CONTROL=/[\u0000-\u001f\u007f]/u;
type ObjectValue=Record<string,unknown>;
export type ValTownStage='val_create'|'http_file';
export type ValTownDiagnostic='transport'|'body_limit'|'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'|'opaque_persistence';

export interface ValTownDependencies{fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date;allowExternalWrite?:boolean}
export interface ValTownAccountBinding{version:1;kind:'valtown_account';ownerIdHash:string;username:string;tier:'free';tokenHash:string;valRead:'confirmed';valWrite:'not_proven_by_read_api';tokenExpiry:'not_exposed_by_api';checkedAt:string;bindingHash:string}
export interface ValTownArtifact{version:1;kind:'valtown_http_artifact';valName:string;description:string;filePath:typeof VALTOWN_HTTP_FILE_PATH;source:string;html:string;sourceHash:string;reviewedSourceHash:string;htmlHash:string;targetUrl:string;targetUrlHash:string}
interface IntentBase{version:1;kind:'valtown_publish';stage:ValTownStage;operationId:string;accountBindingHash:string;ownerIdHash:string;username:string;tokenHash:string;valName:string;sourceHash:string;htmlHash:string;targetUrlHash:string;requestHash:string;createdAt:string}
export interface ValTownValIntent extends IntentBase{stage:'val_create';descriptionHash:string}
export interface ValTownFileIntent extends IntentBase{stage:'http_file';valId:string;filePath:typeof VALTOWN_HTTP_FILE_PATH;descriptionHash:string;valCreatedAtRemote:string}
export type ValTownIntent=ValTownValIntent|ValTownFileIntent;
export interface ValTownOpaqueResponse{version:1;kind:'valtown_opaque_response';stage:ValTownStage;operationId:string;requestHash:string;status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string;capturedAt:string}
export interface ValTownValReceipt extends ValTownValIntent{valId:string;valHtmlUrl:string;createdAtRemote:string}
export interface ValTownFileReceipt extends ValTownFileIntent{fileId:string;fileVersion:number;fileHtmlUrl:string;moduleUrl:string;publicUrl:string;updatedAtRemote:string}
export type ValTownReceipt=ValTownValReceipt|ValTownFileReceipt;
export interface ValTownPersistence{
  readonly secretStorage:'encrypted';
  persistIntent(intent:ValTownIntent):Promise<void>;
  assertReadyToSubmit(intent:ValTownIntent):true;
  persistOpaqueResponse(response:ValTownOpaqueResponse):Promise<void>;
  loadOpaqueResponse(stage:ValTownStage,operationId:string):Promise<ValTownOpaqueResponse|undefined>;
  promoteReceipt(receipt:ValTownReceipt):Promise<void>;
}
export type ValTownProbeResult=
  |{status:'usable';binding:ValTownAccountBinding}
  |{status:'invalid'|'unavailable';reason:'token'|'account'|'tier'|'val_read'|'response'|'network'};
export type ValTownWriteResult=
  |{status:'not_started';reason:'external_write_disabled'|'invalid_input'|'account_check_required'|'intent_not_persisted'|'authorization_changed'|'remote_name_exists'|'remote_file_exists'}
  |{status:'blocked';reason:'prior_submission';intent:ValTownIntent}
  |{status:'unknown';intent:ValTownIntent;diagnostic:ValTownDiagnostic;opaqueResponseSaved:boolean}
  |{status:'rejected';intent:ValTownIntent;diagnostic:Exclude<ValTownDiagnostic,'transport'|'body_limit'|'opaque_persistence'>}
  |{status:'storage_pending';intent:ValTownIntent;receipt:ValTownReceipt}
  |{status:'created';receipt:ValTownReceipt};
export type ValTownRecovery=
  |{status:'found';receipt:ValTownReceipt}
  |{status:'storage_pending';receipt:ValTownReceipt}
  |{status:'found_unowned';reason:'get_cannot_prove_original_submission';valId:string;valHtmlUrl:string}
  |{status:'not_found'|'unknown'|'mismatch'};
export type ValTownVerification=
  |{status:'usable';publicUrl:string;robots:'allowed'|'not_declared';pageSha256:string}
  |{status:'invalid'|'unavailable';reason:'binding'|'account'|'val'|'file'|'content'|'public'|'indexing'|'robots'|'network'};

const object=(value:unknown):value is ObjectValue=>!!value&&typeof value==='object'&&!Array.isArray(value);
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const iso=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const safe=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&value===value.trim()&&!CONTROL.test(value);
export function validValTownToken(value:unknown):value is string{return typeof value==='string'&&value.length>=16&&value.length<=4096&&value===value.trim()&&!/\s/u.test(value)&&!CONTROL.test(value)}
function publicHttps(value:string){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)throw Error('public https URL required');return url}
function canonicalTarget(value:string){const url=publicHttps(value);url.hash='';return url.href}
function apiUrl(path:string){return `${VALTOWN_API_ORIGIN}${path}`}
export function valTownAliasUrl(username:string,valName:string){if(!USERNAME.test(username)||!VAL_NAME.test(valName))throw Error('invalid Val Town alias');return apiUrl(`/v2/alias/vals/${encodeURIComponent(username)}/${encodeURIComponent(valName)}`)}
export function valTownValUrl(valId:string){if(!SAFE_ID.test(valId))throw Error('invalid Val Town val id');return apiUrl(`/v2/vals/${encodeURIComponent(valId)}`)}
export function valTownFilesUrl(valId:string){return `${valTownValUrl(valId)}/files`}
export function valTownFileListUrl(valId:string){return `${valTownFilesUrl(valId)}?path=${encodeURIComponent(VALTOWN_HTTP_FILE_PATH)}&recursive=false&limit=100&offset=0`}
export function valTownFileContentUrl(valId:string){return `${valTownFilesUrl(valId)}/content?path=${encodeURIComponent(VALTOWN_HTTP_FILE_PATH)}`}

export function prepareValTownArtifact(input:{valName:string;description:string;source:string;html:string;targetUrl:string;reviewedSourceHash:string}):ValTownArtifact{
  if(!VAL_NAME.test(input.valName)||!safe(input.description,64)||typeof input.source!=='string'||Buffer.byteLength(input.source)>VALTOWN_MAX_SOURCE_BYTES||typeof input.html!=='string'||Buffer.byteLength(input.html)>VALTOWN_MAX_PUBLIC_BYTES||!HASH.test(input.reviewedSourceHash)||sha(input.source)!==input.reviewedSourceHash)throw Error('Val Town artifact invalid');
  if(!input.source.startsWith(`const html=${JSON.stringify(input.html)};\n`)||!input.source.includes('export default async function(req:Request):Promise<Response>'))throw Error('Val Town source is not bound to the reviewed HTML');
  const targetUrl=canonicalTarget(input.targetUrl),$=load(input.html),links=$('a[href]').toArray();
  if(links.length!==1||canonicalTarget($(links[0]).attr('href')??'')!==targetUrl||!$(links[0]).text().trim()||$('script[src],link[rel="stylesheet"],form').length)throw Error('Val Town HTML link/runtime boundary invalid');
  const policy=publicPagePolicy($);if(!policy.valid)throw Error('Val Town HTML is not indexable');
  return Object.freeze({version:1,kind:'valtown_http_artifact',valName:input.valName,description:input.description,filePath:VALTOWN_HTTP_FILE_PATH,source:input.source,html:input.html,sourceHash:sha(input.source),reviewedSourceHash:input.reviewedSourceHash,htmlHash:sha(input.html),targetUrl,targetUrlHash:sha(targetUrl)});
}
function validArtifact(value:ValTownArtifact){try{return object(value)&&value.version===1&&value.kind==='valtown_http_artifact'&&prepareValTownArtifact(value).sourceHash===value.sourceHash&&value.htmlHash===sha(value.html)&&value.targetUrlHash===sha(value.targetUrl)}catch{return false}}
function accountHash(value:Omit<ValTownAccountBinding,'bindingHash'>){return sha(JSON.stringify(value))}
function validBinding(value:ValTownAccountBinding){if(!object(value)||value.version!==1||value.kind!=='valtown_account'||!HASH.test(value.ownerIdHash)||!USERNAME.test(value.username)||value.tier!=='free'||!HASH.test(value.tokenHash)||value.valRead!=='confirmed'||value.valWrite!=='not_proven_by_read_api'||value.tokenExpiry!=='not_exposed_by_api'||!iso(value.checkedAt)||!HASH.test(value.bindingHash))return false;const {bindingHash,...base}=value;return accountHash(base)===bindingHash}
function sameBinding(a:ValTownAccountBinding,b:ValTownAccountBinding){return a.ownerIdHash===b.ownerIdHash&&a.username===b.username&&a.tier===b.tier&&a.tokenHash===b.tokenHash}
async function freshBinding(expected:ValTownAccountBinding,token:string,deps:ValTownDependencies){const result=await probeValTownAccount(token,deps);return result.status==='usable'&&sameBinding(expected,result.binding)}

class LimitError extends Error{}
class ReadError extends Error{constructor(readonly kind:'invalid'|'unavailable'){super(kind)}}
function discard(response:Response){if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
function timer(deps:ValTownDependencies){const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const handle=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(50,deps.timeoutMs??20_000)));handle.unref?.();return {controller,dispose(){clearTimeout(handle);deps.signal?.removeEventListener('abort',external)}}}
async function bounded(response:Response,maximum:number,signal:AbortSignal){const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maximum)){discard(response);throw new LimitError()}if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){if(signal.aborted)throw Error('aborted');const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maximum){void reader.cancel().catch(()=>undefined);throw new LimitError()}parts.push(next.value)}}finally{reader.releaseLock()}return Buffer.concat(parts.map(part=>Buffer.from(part)))}
async function request(url:string,init:RequestInit,deps:ValTownDependencies,maximum:number,allowed:number[]){const clock=timer(deps);let response:Response|undefined;try{const transport=deps.fetch??((target:string,options:RequestInit)=>fetch(target,options));response=await transport(url,{redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',...init,signal:clock.controller.signal});if(response.redirected||response.type==='opaqueredirect'||response.status>=300&&response.status<400||response.url&&response.url!==url)throw new ReadError('invalid');if(!allowed.includes(response.status))throw new ReadError(response.status>=500||[408,429].includes(response.status)?'unavailable':'invalid');return {response,bytes:await bounded(response,maximum,clock.controller.signal)}}catch(error){if(response&&!response.bodyUsed)discard(response);if(error instanceof LimitError||error instanceof ReadError)throw error;throw new ReadError('unavailable')}finally{clock.dispose()}}
function json(bytes:Uint8Array):unknown{try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)) as unknown}catch{throw new ReadError('invalid')}}
function media(response:Response){return response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()??''}
function auth(token:string){return {accept:'application/json',authorization:`Bearer ${token}`}}
function validPage(value:unknown){if(!object(value)||!Array.isArray(value.data)||!object(value.links))return false;return value.links.next===undefined||typeof value.links.next==='string'}

export async function probeValTownAccount(token:string,deps:ValTownDependencies={}):Promise<ValTownProbeResult>{
  if(!validValTownToken(token))return {status:'invalid',reason:'token'};
  try{
    const [me,vals]=await Promise.all([request(VALTOWN_ACCOUNT_URL,{method:'GET',headers:auth(token)},deps,VALTOWN_MAX_JSON_BYTES,[200]),request(VALTOWN_MY_VALS_URL,{method:'GET',headers:auth(token)},deps,VALTOWN_MAX_JSON_BYTES,[200])]);
    if(media(me.response)!=='application/json'||media(vals.response)!=='application/json')return {status:'invalid',reason:'response'};
    const user=json(me.bytes),page=json(vals.bytes);if(!object(user)||!SAFE_ID.test(String(user.id??''))||user.type!=='user'||!USERNAME.test(String(user.username??''))||!(typeof user.email==='string'||user.email===null)||!validPage(page))return {status:'invalid',reason:'account'};
    if(user.tier!=='free')return {status:'invalid',reason:'tier'};
    for(const item of (page as {data:unknown[]}).data)if(!object(item)||!SAFE_ID.test(String(item.id??''))||!safe(item.name,128)||!['public','unlisted','private'].includes(String(item.privacy)))return {status:'invalid',reason:'val_read'};
    const checkedAt=(deps.now?.()??new Date()).toISOString(),base:Omit<ValTownAccountBinding,'bindingHash'>={version:1,kind:'valtown_account',ownerIdHash:sha(String(user.id)),username:String(user.username),tier:'free',tokenHash:sha(token),valRead:'confirmed',valWrite:'not_proven_by_read_api',tokenExpiry:'not_exposed_by_api',checkedAt};
    return {status:'usable',binding:{...base,bindingHash:accountHash(base)}};
  }catch(error){return {status:error instanceof ReadError&&error.kind==='invalid'?'invalid':'unavailable',reason:error instanceof ReadError&&error.kind==='invalid'?'response':'network'}}
}

function valBody(artifact:ValTownArtifact){return JSON.stringify({name:artifact.valName,privacy:'public',description:artifact.description})}
function fileBody(artifact:ValTownArtifact){return JSON.stringify({content:artifact.source,type:'http'})}
export function valTownValRequestHash(artifact:ValTownArtifact){return sha(`POST ${VALTOWN_VALS_URL}\ncontent-type:application/json\n${valBody(artifact)}`)}
export function valTownFileRequestHash(valId:string,artifact:ValTownArtifact){return sha(`POST ${valTownFilesUrl(valId)}?path=${encodeURIComponent(VALTOWN_HTTP_FILE_PATH)}\ncontent-type:application/json\n${fileBody(artifact)}`)}
function intentBase(operationId:string,stage:ValTownStage,binding:ValTownAccountBinding,artifact:ValTownArtifact,token:string,requestHash:string,deps:ValTownDependencies):IntentBase{return {version:1,kind:'valtown_publish',stage,operationId,accountBindingHash:binding.bindingHash,ownerIdHash:binding.ownerIdHash,username:binding.username,tokenHash:sha(token),valName:artifact.valName,sourceHash:artifact.sourceHash,htmlHash:artifact.htmlHash,targetUrlHash:artifact.targetUrlHash,requestHash,createdAt:(deps.now?.()??new Date()).toISOString()}}
function validIntent(value:ValTownIntent){return object(value)&&value.version===1&&value.kind==='valtown_publish'&&['val_create','http_file'].includes(value.stage)&&OPERATION.test(value.operationId)&&HASH.test(value.accountBindingHash)&&HASH.test(value.ownerIdHash)&&USERNAME.test(value.username)&&HASH.test(value.tokenHash)&&VAL_NAME.test(value.valName)&&HASH.test(value.sourceHash)&&HASH.test(value.htmlHash)&&HASH.test(value.targetUrlHash)&&HASH.test(value.requestHash)&&iso(value.createdAt)&&(value.stage==='val_create'?HASH.test(value.descriptionHash):SAFE_ID.test(value.valId)&&value.filePath===VALTOWN_HTTP_FILE_PATH&&HASH.test(value.descriptionHash)&&iso(value.valCreatedAtRemote))}
function exactApiSelf(value:unknown,path:string){if(typeof value!=='string')return false;try{const url=new URL(value);return url.origin===VALTOWN_API_ORIGIN&&!url.search&&!url.hash&&url.pathname===path}catch{return false}}
function exactSite(value:unknown,origins:string[],suffix:string){if(typeof value!=='string')return false;try{const url=publicHttps(value);return origins.includes(url.origin)&&url.pathname.endsWith(suffix)&&!url.search}catch{return false}}
function exactSitePath(value:unknown,origins:string[],path:string){if(typeof value!=='string')return false;try{const url=publicHttps(value);return origins.includes(url.origin)&&url.pathname===path&&!url.search}catch{return false}}
function exactFileSelf(value:unknown,valId:string,path:string){if(typeof value!=='string')return false;try{const url=new URL(value),pathname=url.pathname;return url.origin===VALTOWN_API_ORIGIN&&!url.username&&!url.password&&!url.hash&&(pathname===`/v2/vals/${valId}/files`||pathname===`/v1/projects/${valId}/files`)&&url.searchParams.size===1&&url.searchParams.get('path')===path}catch{return false}}
function valReceipt(value:unknown,intent:ValTownValIntent):ValTownValReceipt|undefined{if(!object(value)||!SAFE_ID.test(String(value.id??''))||value.name!==intent.valName||value.privacy!=='public'||typeof value.description!=='string'||sha(value.description)!==intent.descriptionHash||!iso(value.createdAt)||Date.parse(value.createdAt)<Date.parse(intent.createdAt)-5*60_000||Date.parse(value.createdAt)>Date.parse(intent.createdAt)+60*60_000||!object(value.author)||value.author.type!=='user'||value.author.username!==intent.username||sha(String(value.author.id??''))!==intent.ownerIdHash||!object(value.links)||!exactApiSelf(value.links.self,`/v2/vals/${value.id}`)||!exactSitePath(value.links.html,['https://www.val.town','https://val.town'],`/x/${encodeURIComponent(intent.username)}/${encodeURIComponent(intent.valName)}/code/`)&&!exactSite(value.links.html,['https://www.val.town','https://val.town'],`/${encodeURIComponent(intent.username)}/${encodeURIComponent(intent.valName)}`))return;return {...intent,valId:String(value.id),valHtmlUrl:String(value.links.html),createdAtRemote:String(value.createdAt)}}
function endpoint(value:unknown){if(typeof value!=='string')return false;try{const url=publicHttps(value);return !url.search&&url.pathname==='/'&&(url.hostname.endsWith('.web.val.run')||url.hostname.endsWith('.val.run'))}catch{return false}}
function fileReceipt(value:unknown,intent:ValTownFileIntent):ValTownFileReceipt|undefined{if(!object(value)||!SAFE_ID.test(String(value.id??''))||value.path!==VALTOWN_HTTP_FILE_PATH||value.name!==VALTOWN_HTTP_FILE_PATH||value.type!=='http'||!Number.isSafeInteger(value.version)||Number(value.version)<0||!iso(value.updatedAt)||!object(value.links)||!exactFileSelf(value.links.self,intent.valId,VALTOWN_HTTP_FILE_PATH)&&!exactApiSelf(value.links.self,`/v2/vals/${intent.valId}/files/${value.id}`)&&!exactApiSelf(value.links.self,`/v2/files/${value.id}`)||!exactSitePath(value.links.html,['https://www.val.town','https://val.town'],`/x/${encodeURIComponent(intent.username)}/${encodeURIComponent(intent.valName)}/code/${VALTOWN_HTTP_FILE_PATH}`)&&!exactSite(value.links.html,['https://www.val.town','https://val.town'],`/${encodeURIComponent(intent.username)}/${encodeURIComponent(intent.valName)}/${VALTOWN_HTTP_FILE_PATH}`)||typeof value.links.module!=='string'||!endpoint(value.links.endpoint))return;try{const moduleUrl=publicHttps(String(value.links.module));if(moduleUrl.origin!=='https://esm.town'||moduleUrl.pathname!==`/v/${encodeURIComponent(intent.username)}/${encodeURIComponent(intent.valName)}/${VALTOWN_HTTP_FILE_PATH}`||moduleUrl.search)return}catch{return}return {...intent,fileId:String(value.id),fileVersion:Number(value.version),fileHtmlUrl:String(value.links.html),moduleUrl:String(value.links.module),publicUrl:new URL(String(value.links.endpoint)).href,updatedAtRemote:String(value.updatedAt)}}
function validOpaque(value:ValTownOpaqueResponse,intent:ValTownIntent){if(!object(value)||value.version!==1||value.kind!=='valtown_opaque_response'||value.stage!==intent.stage||value.operationId!==intent.operationId||value.requestHash!==intent.requestHash||!HASH.test(value.bodySha256)||!iso(value.capturedAt))return false;const bytes=Buffer.from(value.bodyBase64,'base64');return bytes.length<=VALTOWN_MAX_JSON_BYTES&&bytes.toString('base64')===value.bodyBase64&&sha(bytes)===value.bodySha256}
function parseOpaque(value:ValTownOpaqueResponse,intent:ValTownIntent):{receipt:ValTownReceipt}|{diagnostic:'redirect'|'media_type'|'http_status'|'decode'|'json'|'schema'}{if(!validOpaque(value,intent))return {diagnostic:'schema'};const expected=intent.stage==='val_create'?VALTOWN_VALS_URL:`${valTownFilesUrl(intent.valId)}?path=${encodeURIComponent(VALTOWN_HTTP_FILE_PATH)}`;if(value.redirected||value.responseType==='opaqueredirect'||value.status>=300&&value.status<400||value.responseUrl&&value.responseUrl!==expected)return {diagnostic:'redirect'};if(![200,201].includes(value.status))return {diagnostic:'http_status'};if(value.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};let parsed:unknown;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(value.bodyBase64,'base64')))}catch{return {diagnostic:'json'}}const receipt=intent.stage==='val_create'?valReceipt(parsed,intent):fileReceipt(parsed,intent);return receipt?{receipt}:{diagnostic:'schema'}}
async function capture(intent:ValTownIntent,url:string,body:string,token:string,persistence:ValTownPersistence,deps:ValTownDependencies){const clock=timer(deps);let response:Response|undefined;try{const transport=deps.fetch??((target:string,init:RequestInit)=>fetch(target,init));response=await transport(url,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:clock.controller.signal,headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${token}`},body});const bytes=await bounded(response,VALTOWN_MAX_JSON_BYTES,clock.controller.signal),opaque:ValTownOpaqueResponse={version:1,kind:'valtown_opaque_response',stage:intent.stage,operationId:intent.operationId,requestHash:intent.requestHash,status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:sha(bytes),capturedAt:(deps.now?.()??new Date()).toISOString()};try{await persistence.persistOpaqueResponse(opaque)}catch{return {diagnostic:'opaque_persistence' as const}}return {opaque}}catch(error){if(response&&!response.bodyUsed)discard(response);return {diagnostic:error instanceof LimitError?'body_limit' as const:'transport' as const}}finally{clock.dispose()}}
async function promote(receipt:ValTownReceipt,persistence:ValTownPersistence,intent:ValTownIntent):Promise<ValTownWriteResult>{try{await persistence.promoteReceipt(receipt);return {status:'created',receipt}}catch{return {status:'storage_pending',intent,receipt}}}
async function aliasRead(username:string,valName:string,token:string,deps:ValTownDependencies){const found=await request(valTownAliasUrl(username,valName),{method:'GET',headers:auth(token)},deps,VALTOWN_MAX_JSON_BYTES,[200,404]);if(found.response.status===404)return;return json(found.bytes)}
async function fileState(valId:string,token:string,deps:ValTownDependencies,allowMissing=false){const allowed=allowMissing?[200,404]:[200],[meta,content]=await Promise.all([request(valTownFileListUrl(valId),{method:'GET',headers:auth(token)},deps,VALTOWN_MAX_JSON_BYTES,allowed),request(valTownFileContentUrl(valId),{method:'GET',headers:{accept:'application/octet-stream',authorization:`Bearer ${token}`}},deps,VALTOWN_MAX_SOURCE_BYTES,allowed)]);if(meta.response.status===404&&content.response.status===404&&allowMissing)return;if(meta.response.status!==200)throw new ReadError('invalid');if(media(meta.response)!=='application/json')throw new ReadError('invalid');const page=json(meta.bytes);if(!object(page)||!Array.isArray(page.data)||!object(page.links)||page.links.next!==undefined)throw new ReadError('invalid');if(content.response.status===404){if(allowMissing&&page.data.length===0)return;throw new ReadError('invalid')}if(page.data.length!==1)throw new ReadError('invalid');return {metadata:page.data[0],source:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(content.bytes)}}

export async function createValTownVal(input:{operationId:string;account:ValTownAccountBinding;token:string;artifact:ValTownArtifact;reviewed:true;priorIntent?:ValTownIntent},persistence:ValTownPersistence,deps:ValTownDependencies={}):Promise<ValTownWriteResult>{
  if(deps.allowExternalWrite!==true)return {status:'not_started',reason:'external_write_disabled'};if(input.reviewed!==true)return {status:'not_started',reason:'account_check_required'};
  const intent:ValTownValIntent={...intentBase(input.operationId,'val_create',input.account,input.artifact,input.token,valTownValRequestHash(input.artifact),deps),stage:'val_create',descriptionHash:sha(input.artifact.description)};
  if(persistence.secretStorage!=='encrypted'||!validValTownToken(input.token)||!validBinding(input.account)||input.account.tokenHash!==sha(input.token)||!validArtifact(input.artifact)||!validIntent(intent))return {status:'not_started',reason:'invalid_input'};
  if(input.priorIntent)return validIntent(input.priorIntent)?{status:'blocked',reason:'prior_submission',intent:input.priorIntent}:{status:'not_started',reason:'invalid_input'};
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(await aliasRead(intent.username,intent.valName,input.token,deps))return {status:'not_started',reason:'remote_name_exists'}}catch{return {status:'unknown',intent,diagnostic:'transport',opaqueResponseSaved:false}}
  if(!await freshBinding(input.account,input.token,deps))return {status:'not_started',reason:'account_check_required'};
  try{if(persistence.assertReadyToSubmit(intent)!==true)throw Error('denied')}catch{return {status:'not_started',reason:'authorization_changed'}}
  const captured=await capture(intent,VALTOWN_VALS_URL,valBody(input.artifact),input.token,persistence,deps);if(!captured.opaque)return {status:'unknown',intent,diagnostic:captured.diagnostic!,opaqueResponseSaved:false};const parsed=parseOpaque(captured.opaque,intent);if('diagnostic'in parsed)return {status:'rejected',intent,diagnostic:parsed.diagnostic};return promote(parsed.receipt,persistence,intent);
}

export async function createValTownHttpFile(input:{operationId:string;account:ValTownAccountBinding;token:string;artifact:ValTownArtifact;valReceipt:ValTownValReceipt;reviewed:true;priorIntent?:ValTownIntent},persistence:ValTownPersistence,deps:ValTownDependencies={}):Promise<ValTownWriteResult>{
  if(deps.allowExternalWrite!==true)return {status:'not_started',reason:'external_write_disabled'};if(input.reviewed!==true)return {status:'not_started',reason:'account_check_required'};
  const intent:ValTownFileIntent={...intentBase(input.operationId,'http_file',input.account,input.artifact,input.token,valTownFileRequestHash(input.valReceipt.valId,input.artifact),deps),stage:'http_file',valId:input.valReceipt.valId,filePath:VALTOWN_HTTP_FILE_PATH,descriptionHash:input.valReceipt.descriptionHash,valCreatedAtRemote:input.valReceipt.createdAtRemote};
  if(persistence.secretStorage!=='encrypted'||!validValTownToken(input.token)||!validBinding(input.account)||input.account.tokenHash!==sha(input.token)||!validArtifact(input.artifact)||!validIntent(input.valReceipt)||input.valReceipt.stage!=='val_create'||input.valReceipt.accountBindingHash!==input.account.bindingHash||input.valReceipt.valName!==input.artifact.valName||input.valReceipt.sourceHash!==input.artifact.sourceHash||!validIntent(intent))return {status:'not_started',reason:'invalid_input'};
  if(input.priorIntent)return validIntent(input.priorIntent)?{status:'blocked',reason:'prior_submission',intent:input.priorIntent}:{status:'not_started',reason:'invalid_input'};
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(await fileState(intent.valId,input.token,deps,true))return {status:'not_started',reason:'remote_file_exists'}}catch{return {status:'unknown',intent,diagnostic:'transport',opaqueResponseSaved:false}}
  if(!await freshBinding(input.account,input.token,deps))return {status:'not_started',reason:'account_check_required'};
  try{if(persistence.assertReadyToSubmit(intent)!==true)throw Error('denied')}catch{return {status:'not_started',reason:'authorization_changed'}}
  const url=`${valTownFilesUrl(intent.valId)}?path=${encodeURIComponent(VALTOWN_HTTP_FILE_PATH)}`,captured=await capture(intent,url,fileBody(input.artifact),input.token,persistence,deps);if(!captured.opaque)return {status:'unknown',intent,diagnostic:captured.diagnostic!,opaqueResponseSaved:false};const parsed=parseOpaque(captured.opaque,intent);if('diagnostic'in parsed)return {status:'rejected',intent,diagnostic:parsed.diagnostic};return promote(parsed.receipt,persistence,intent);
}

export async function recoverValTownVal(intent:ValTownValIntent,account:ValTownAccountBinding,token:string,persistence:ValTownPersistence,deps:ValTownDependencies={}):Promise<ValTownRecovery>{
  if(!validIntent(intent)||intent.stage!=='val_create'||!validBinding(account)||intent.accountBindingHash!==account.bindingHash||intent.tokenHash!==sha(token))return {status:'mismatch'};
  const opaque=await persistence.loadOpaqueResponse('val_create',intent.operationId);if(opaque){const parsed=parseOpaque(opaque,intent);if(!('diagnostic'in parsed))return (await promote(parsed.receipt,persistence,intent)).status==='created'?{status:'found',receipt:parsed.receipt}:{status:'storage_pending',receipt:parsed.receipt}}
  try{const remote=await aliasRead(intent.username,intent.valName,token,deps);if(!remote)return {status:'not_found'};const receipt=valReceipt(remote,intent);if(!receipt)return {status:'mismatch'};return {status:'found_unowned',reason:'get_cannot_prove_original_submission',valId:receipt.valId,valHtmlUrl:receipt.valHtmlUrl}}catch{return {status:'unknown'}}
}

export async function recoverValTownHttpFile(intent:ValTownFileIntent,account:ValTownAccountBinding,artifact:ValTownArtifact,token:string,persistence:ValTownPersistence,deps:ValTownDependencies={}):Promise<ValTownRecovery>{
  if(!validIntent(intent)||intent.stage!=='http_file'||!validBinding(account)||!validArtifact(artifact)||intent.accountBindingHash!==account.bindingHash||intent.tokenHash!==sha(token)||intent.sourceHash!==artifact.sourceHash)return {status:'mismatch'};
  const opaque=await persistence.loadOpaqueResponse('http_file',intent.operationId);if(opaque){const parsed=parseOpaque(opaque,intent);if(!('diagnostic'in parsed))return (await promote(parsed.receipt,persistence,intent)).status==='created'?{status:'found',receipt:parsed.receipt}:{status:'storage_pending',receipt:parsed.receipt}}
  try{const state=await fileState(intent.valId,token,deps,true);if(!state)return {status:'not_found'};if(sha(state.source)!==intent.sourceHash)return {status:'mismatch'};const receipt=fileReceipt(state.metadata,intent);if(!receipt)return {status:'mismatch'};return (await promote(receipt,persistence,intent)).status==='created'?{status:'found',receipt}:{status:'storage_pending',receipt}}catch{return {status:'unknown'}}
}

export async function verifyValTownPublication(receipt:ValTownFileReceipt,account:ValTownAccountBinding,artifact:ValTownArtifact,token:string,deps:ValTownDependencies={}):Promise<ValTownVerification>{
  if(!validIntent(receipt)||receipt.stage!=='http_file'||!validBinding(account)||!validArtifact(artifact)||receipt.accountBindingHash!==account.bindingHash||receipt.tokenHash!==sha(token)||receipt.sourceHash!==artifact.sourceHash||receipt.htmlHash!==artifact.htmlHash||!endpoint(receipt.publicUrl))return {status:'invalid',reason:'binding'};
  const fresh=await probeValTownAccount(token,deps);if(fresh.status!=='usable')return {status:fresh.status,reason:fresh.status==='invalid'?'account':'network'};if(!sameBinding(account,fresh.binding))return {status:'invalid',reason:'binding'};
  try{
    const [val,state,page,robots]=await Promise.all([request(valTownValUrl(receipt.valId),{method:'GET',headers:auth(token)},deps,VALTOWN_MAX_JSON_BYTES,[200]),fileState(receipt.valId,token,deps),request(receipt.publicUrl,{method:'GET',headers:{accept:'text/html'}},deps,VALTOWN_MAX_PUBLIC_BYTES,[200]),request(new URL('/robots.txt',receipt.publicUrl).href,{method:'GET',headers:{accept:'text/plain'}},deps,VALTOWN_MAX_JSON_BYTES,[200,404])]);
    const valIntent:ValTownValIntent={...receipt,stage:'val_create',requestHash:'0'.repeat(64),descriptionHash:receipt.descriptionHash,createdAt:receipt.valCreatedAtRemote};
    const confirmedVal=media(val.response)==='application/json'?valReceipt(json(val.bytes),valIntent):undefined;if(!confirmedVal||confirmedVal.valId!==receipt.valId)return {status:'invalid',reason:'val'};
    if(!state)return {status:'invalid',reason:'file'};const reread=fileReceipt(state.metadata,receipt);if(!reread||reread.fileId!==receipt.fileId||reread.publicUrl!==receipt.publicUrl||sha(state.source)!==artifact.sourceHash)return {status:'invalid',reason:'file'};
    if(media(page.response)!=='text/html'||sha(page.bytes)!==artifact.htmlHash)return {status:'invalid',reason:'public'};const html=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(page.bytes),$=load(html);if(!publicPagePolicy($,receipt.publicUrl,page.response.headers.get('x-robots-tag')??'').valid)return {status:'invalid',reason:'indexing'};
    let robotsStatus:'allowed'|'not_declared'='not_declared';if(robots.response.status===200){if(media(robots.response)!=='text/plain')return {status:'invalid',reason:'robots'};const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(robots.bytes);if(!agentsGatherRobotsAllows(text,new URL(receipt.publicUrl).pathname,'*'))return {status:'invalid',reason:'robots'};robotsStatus='allowed'}
    return {status:'usable',publicUrl:receipt.publicUrl,robots:robotsStatus,pageSha256:sha(page.bytes)};
  }catch(error){return {status:error instanceof ReadError&&error.kind==='invalid'?'invalid':'unavailable',reason:error instanceof ReadError&&error.kind==='invalid'?'content':'network'}}
}
