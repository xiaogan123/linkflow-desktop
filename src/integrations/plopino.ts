import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import {applyDeclaredArticleVisibility,elementConcealed,publicPagePolicy,withPageNofollow} from './article-visibility';
import {htmlAppPublisherTesting} from './html-app-publisher';

export const PLOPINO_ORIGIN='https://plopino.com';
export const PLOPINO_REGISTER_URL=`${PLOPINO_ORIGIN}/api/auth/register`;
export const PLOPINO_LOGIN_URL=`${PLOPINO_ORIGIN}/api/auth/login`;
export const PLOPINO_ME_URL=`${PLOPINO_ORIGIN}/api/auth/me`;
export const PLOPINO_BOARDS_URL=`${PLOPINO_ORIGIN}/api/boards`;
export const PLOPINO_QUOTA_URL=`${PLOPINO_ORIGIN}/api/quota`;
export const PLOPINO_UPLOAD_URL=`${PLOPINO_ORIGIN}/api/boards/upload`;
export const PLOPINO_MAX_ARTICLE_BYTES=1024*1024;
export const PLOPINO_MAX_RESPONSE_BYTES=256*1024;
const BOARD=/^https:\/\/plopino\.com\/b\/([A-Za-z0-9_-]+)\/?$/;
const BOARD_ID=/^[A-Za-z0-9_-]+$/;
const USERNAME=/^[A-Za-z0-9_-]{3,32}$/;
const EMAIL=/^[^\s@]{1,64}@[^\s@]{1,185}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION=/^[a-z0-9][a-z0-9_-]{7,127}$/i;
const HASH=/^[a-f0-9]{64}$/;

export type PlopinoOperationKind='register'|'publish';
export interface PlopinoIntent {version:1;kind:PlopinoOperationKind;operationId:string;accountId:string;createdAt:string;requestHash:string}
export interface PlopinoOpaqueResponse {version:1;kind:'plopino_opaque_response';operation:PlopinoOperationKind;operationId:string;accountId:string;createdAt:string;requestHash:string;status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string}
export interface PlopinoAccountInput {accountId:string;username:string;email:string;password:string;operationId:string;createdAt:string}
export interface PlopinoLoginInput {accountId:string;email:string;password:string}
export interface PlopinoPublicationInput {accountId:string;username:string;email:string;sessionCookie:string;operationId:string;createdAt:string;html:string;targetUrl:string}
export interface PlopinoAccountReceipt {accountId:string;username:string;email:string;sessionCookie:string;verifiedAt:string}
export interface PlopinoPublicationReceipt {operationId:string;accountId:string;publicUrl:string;boardId:string;sourceHash:string;requestHash:string;createdAt:string;ownership:'pending'|'account_list_match';accountDefaultRetention:'pending'|'no_default_expiry';boardExpiry:'unknown';deletion:'unknown'}
export interface PlopinoPublicEvidence {checkedAt:string;publicUrl:string;bodySha256:string;targetHref:string;targetRel:string;robotsAllowed:true;metaIndexable:true;headerIndexable:true}
export interface PlopinoAcceptanceEvidence {identityMatched:true;boardListMatched:true;public:true;hasContent:true;tier:'user';retentionDays:null;publicEvidence:PlopinoPublicEvidence}
export interface PlopinoPersistence {
  persistIntent(intent:PlopinoIntent,secret?:string):Promise<void>;
  assertAuthorized(intent:PlopinoIntent):true|Promise<true>;
  persistOpaqueResponse(response:PlopinoOpaqueResponse):Promise<void>;
  persistSessionCandidate(intent:PlopinoIntent,sessionCookie:string):Promise<void>;
  promoteRegistered(receipt:PlopinoAccountReceipt):Promise<void>;
  preservePendingPublication(receipt:PlopinoPublicationReceipt):Promise<void>;
  loadOpaqueResponse?():Promise<PlopinoOpaqueResponse|undefined>;
  promotePublished?(receipt:PlopinoPublicationReceipt,evidence:PlopinoAcceptanceEvidence):Promise<void>;
}
export interface PlopinoDependencies {fetch?:typeof fetch;now?:()=>Date;timeoutMs?:number;signal?:AbortSignal}
export type PlopinoAccountResult={status:'registered';receipt:PlopinoAccountReceipt}|{status:'unknown';intent:PlopinoIntent;reason:string;opaqueSaved:boolean};
export type PlopinoPublishResult=
  |{status:'published';intent:PlopinoIntent;receipt:PlopinoPublicationReceipt;evidence:PlopinoAcceptanceEvidence}
  |{status:'pending';intent:PlopinoIntent;receipt:PlopinoPublicationReceipt;reason:string;opaqueSaved:true}
  |{status:'not_submitted';intent:PlopinoIntent;reason:string;opaqueSaved:false}
  |{status:'unknown';intent:PlopinoIntent;reason:string;opaqueSaved:boolean};

const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const exactDate=(value:string)=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function safeUrl(value:string){try{const url=new URL(value);return url.origin===PLOPINO_ORIGIN&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash?url:undefined}catch{return}}
export function validPlopinoIntent(value:PlopinoIntent){return value.version===1&&['register','publish'].includes(value.kind)&&OPERATION.test(value.operationId)&&UUID.test(value.accountId)&&exactDate(value.createdAt)&&HASH.test(value.requestHash)}
function validateAccount(input:PlopinoAccountInput){if(!UUID.test(input.accountId)||!USERNAME.test(input.username)||!EMAIL.test(input.email)||input.email.length>254||input.password.length<6||input.password.length>128||!exactDate(input.createdAt)||!OPERATION.test(input.operationId))throw Error('Plopino 账号输入不符合固定注册契约')}
export function validPlopinoSession(value:string){return value.length>=16&&value.length<=4096&&!/[\s;,\r\n]/.test(value)}
type SessionCookie={state:'absent'}|{state:'invalid'}|{state:'valid';value:string};
function sessionCookieFrom(response:Response,name:string,now=new Date()):SessionCookie{
  const values=response.headers.getSetCookie?.()??(response.headers.get('set-cookie')?[response.headers.get('set-cookie')!]:[]);
  const cookies=values.flatMap(line=>line.split(/,\s*(?=[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/));
  const matches=cookies.filter(line=>line.trimStart().startsWith(`${name}=`));
  if(!matches.length)return {state:'absent'};
  const parts=matches.at(-1)!.split(';').map(value=>value.trim()),pair=parts.shift()!,separator=pair.indexOf('='),value=separator>=0?pair.slice(separator+1):'';
  if(pair.slice(0,separator)!==name||!validPlopinoSession(value))return {state:'invalid'};
  let path='',domain='';
  for(const raw of parts){
    const index=raw.indexOf('='),key=(index<0?raw:raw.slice(0,index)).trim().toLowerCase(),attribute=index<0?'':raw.slice(index+1).trim();
    if(key==='max-age'){if(!/^-?\d+$/.test(attribute)||Number(attribute)<=0)return {state:'invalid'}}
    else if(key==='expires'){const expires=Date.parse(attribute);if(!Number.isFinite(expires)||expires<=now.getTime())return {state:'invalid'}}
    else if(key==='domain')domain=attribute.toLowerCase().replace(/^\./,'');
    else if(key==='path')path=attribute;
  }
  if(path!=='/'||(domain&&domain!=='plopino.com'))return {state:'invalid'};
  return {state:'valid',value};
}
function cookieFrom(response:Response,name:string,now=new Date()){const cookie=sessionCookieFrom(response,name,now);return cookie.state==='valid'?cookie.value:undefined}
async function discard(response:Response){if(response.body&&!response.body.locked)await response.body.cancel().catch(()=>undefined)}
class TimedReadError extends Error{constructor(){super('timeout')}}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void){
  if(signal.aborted){void pending.then(value=>late?.(value),()=>undefined);return Promise.reject(new TimedReadError())}
  return new Promise<T>((resolve,reject)=>{let done=false;const stop=()=>{if(done)return;done=true;reject(new TimedReadError())};signal.addEventListener('abort',stop,{once:true});void pending.then(value=>{signal.removeEventListener('abort',stop);if(done){late?.(value);return}done=true;resolve(value)},error=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(error)})});
}
async function boundedBytes(response:Response,maximum:number,signal:AbortSignal){
  const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum)){await discard(response);throw Error('body_limit')}
  const chunks:Uint8Array[]=[];let size=0;if(response.body){const reader=response.body.getReader();try{for(;;){const item=await abortable(reader.read(),signal);if(item.done)break;size+=item.value.byteLength;if(size>maximum)throw Error('body_limit');chunks.push(item.value)}}catch(error){await reader.cancel().catch(()=>undefined);throw error}finally{reader.releaseLock()}}
  return Buffer.concat(chunks.map(value=>Buffer.from(value)));
}
function decode(bytes:Uint8Array,response?:Response){try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}catch{if(response)void discard(response);throw Error('decode')}}
function makeOpaque(response:Response,body:Uint8Array,intent:PlopinoIntent):PlopinoOpaqueResponse{return {version:1,kind:'plopino_opaque_response',operation:intent.kind,operationId:intent.operationId,accountId:intent.accountId,createdAt:intent.createdAt,requestHash:intent.requestHash,status:response.status,contentType:(response.headers.get('content-type')??'').slice(0,512),responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(body).toString('base64'),bodySha256:sha(body)}}
function requestHash(kind:PlopinoOperationKind,input:string){return sha(`${kind}\0${input}`)}
function timerSignal(timeoutMs:number,external?:AbortSignal){const controller=new AbortController(),abort=()=>controller.abort();external?.addEventListener('abort',abort,{once:true});if(external?.aborted)controller.abort();const timer=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(100,timeoutMs)));timer.unref?.();return {signal:controller.signal,stop:()=>{clearTimeout(timer);external?.removeEventListener('abort',abort)}}}
async function requestBytes(url:string,init:RequestInit,maximum:number,deps:PlopinoDependencies,onResponse?:(response:Response)=>void|Promise<void>,onCaptured?:(response:Response,bytes:Uint8Array)=>void|Promise<void>){
  const exact=safeUrl(url);if(!exact||exact.href!==url)throw Error('route');const timeoutMs=deps.timeoutMs??30_000,clock=timerSignal(timeoutMs,deps.signal);
  const responsePending=Promise.resolve((deps.fetch??fetch)(url,{...init,redirect:'manual',credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',signal:clock.signal}));
  const captured=responsePending.then(async response=>{await onResponse?.(response);const captureClock=timerSignal(timeoutMs);try{const bytes=await boundedBytes(response,maximum,captureClock.signal);await onCaptured?.(response,bytes);return {response,bytes}}catch(error){await discard(response);throw error}finally{captureClock.stop()}});
  try{return await abortable(captured,clock.signal)}finally{clock.stop();void captured.catch(()=>undefined)}
}
function responseOriginValid(response:Response,expected:string){return !response.redirected&&response.type!=='opaqueredirect'&&!(response.status>=300&&response.status<400)&&(!response.url||response.url===expected)}
function safeReason(error:unknown){const value=error instanceof Error?error.message:'';return ['body_limit','decode','route','timeout'].includes(value)?value:'transport_or_contract'}
function exactMe(value:unknown,username:string,email:string){if(!object(value)||!object(value.user))return false;return value.user.username===username&&typeof value.user.email==='string'&&value.user.email.toLowerCase()===email.toLowerCase()}
function exactOwnerId(value:unknown){return Number.isSafeInteger(value)&&Number(value)>0?Number(value):undefined}
async function whoami(username:string,email:string,sessionCookie:string,deps:PlopinoDependencies,onSessionCandidate?:(sessionCookie:string)=>void|Promise<void>){
  if(!validPlopinoSession(sessionCookie))return {valid:false as const,sessionCookie};let rotated=sessionCookie,invalidRotation=false;
  const {response,bytes}=await requestBytes(PLOPINO_ME_URL,{method:'GET',headers:{accept:'application/json',cookie:`gw_session=${sessionCookie}`}},PLOPINO_MAX_RESPONSE_BYTES,deps,async current=>{if(!responseOriginValid(current,PLOPINO_ME_URL))return;const candidate=sessionCookieFrom(current,'gw_session',deps.now?.()??new Date());if(candidate.state==='invalid'){invalidRotation=true;return}if(candidate.state==='valid'&&candidate.value!==rotated){rotated=candidate.value;await onSessionCandidate?.(candidate.value)}});
  if(invalidRotation||!responseOriginValid(response,PLOPINO_ME_URL)||response.status!==200||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')return {valid:false as const,sessionCookie:rotated};
  let value:unknown;try{value=JSON.parse(decode(bytes,response))}catch{return {valid:false as const,sessionCookie:rotated}}return {valid:exactMe(value,username,email),sessionCookie:rotated,ownerId:object(value)&&object(value.user)?exactOwnerId(value.user.id):undefined};
}
export async function verifyPlopinoSession(username:string,email:string,sessionCookie:string,deps:PlopinoDependencies={},onSessionCandidate?:(sessionCookie:string)=>void|Promise<void>){return whoami(username,email,sessionCookie,deps,onSessionCandidate)}

export async function registerPlopinoAccount(input:PlopinoAccountInput,persistence:PlopinoPersistence,deps:PlopinoDependencies={}):Promise<PlopinoAccountResult>{
  validateAccount(input);const payload=JSON.stringify({username:input.username,email:input.email,password:input.password}),intent:PlopinoIntent={version:1,kind:'register',operationId:input.operationId,accountId:input.accountId,createdAt:input.createdAt,requestHash:requestHash('register',payload)};if(!validPlopinoIntent(intent))throw Error('Plopino 注册意图无效');
  await persistence.persistIntent(intent,input.password);await persistence.assertAuthorized(intent);let opaqueSaved=false;
  try{let sessionCandidate:string|undefined;const {response}=await requestBytes(PLOPINO_REGISTER_URL,{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:payload},PLOPINO_MAX_RESPONSE_BYTES,deps,async current=>{if(!responseOriginValid(current,PLOPINO_REGISTER_URL)||current.status<200||current.status>=300)return;const candidate=cookieFrom(current,'gw_session',deps.now?.()??new Date());if(candidate){sessionCandidate=candidate;await persistence.persistSessionCandidate(intent,candidate)}},async(current,bytes)=>{await persistence.persistOpaqueResponse(makeOpaque(current,bytes,intent));opaqueSaved=true});const session=sessionCandidate??cookieFrom(response,'gw_session',deps.now?.()??new Date());if(!responseOriginValid(response,PLOPINO_REGISTER_URL)||response.status<200||response.status>=300||!session)return {status:'unknown',intent,reason:'注册响应没有形成可核验的同源会话；不会重发',opaqueSaved};const me=await whoami(input.username,input.email,session,deps,candidate=>persistence.persistSessionCandidate(intent,candidate));if(!me.valid)return {status:'unknown',intent,reason:'注册会话未通过精确账号归属核验；候选会话已加密保存且不会重发',opaqueSaved};const receipt={accountId:input.accountId,username:input.username,email:input.email,sessionCookie:me.sessionCookie,verifiedAt:(deps.now?.()??new Date()).toISOString()};await persistence.promoteRegistered(receipt);return {status:'registered',receipt}}
  catch(error){return {status:'unknown',intent,reason:`Plopino 注册结果不明（${safeReason(error)}）；不会重发`,opaqueSaved}}
}

export async function loginPlopinoAccount(input:PlopinoLoginInput,deps:PlopinoDependencies={},onSessionCandidate?:(value:string)=>void|Promise<void>):Promise<PlopinoAccountReceipt>{
  if(!UUID.test(input.accountId)||!EMAIL.test(input.email)||input.email.length>254||input.password.length<6||input.password.length>128)throw Error('Plopino 登录输入无效');
  const payload=JSON.stringify({email:input.email,password:input.password}),{response}=await requestBytes(PLOPINO_LOGIN_URL,{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:payload},PLOPINO_MAX_RESPONSE_BYTES,deps);
  const session=cookieFrom(response,'gw_session',deps.now?.()??new Date());if(!responseOriginValid(response,PLOPINO_LOGIN_URL)||response.status<200||response.status>=300||!session)throw Error('Plopino 登录未返回可核验会话');await onSessionCandidate?.(session);
  const meUrl=PLOPINO_ME_URL,{response:meResponse,bytes}=await requestBytes(meUrl,{method:'GET',headers:{accept:'application/json',cookie:`gw_session=${session}`}},PLOPINO_MAX_RESPONSE_BYTES,deps);if(!responseOriginValid(meResponse,meUrl)||meResponse.status!==200||meResponse.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')throw Error('Plopino 登录身份无法核验');let parsed:unknown;try{parsed=JSON.parse(decode(bytes,meResponse))}catch{throw Error('Plopino 登录身份无法核验')}if(!object(parsed)||!object(parsed.user)||typeof parsed.user.username!=='string'||!USERNAME.test(parsed.user.username)||typeof parsed.user.email!=='string'||parsed.user.email.toLowerCase()!==input.email.toLowerCase())throw Error('Plopino 登录身份与邮箱不一致');
  const rotated=sessionCookieFrom(meResponse,'gw_session',deps.now?.()??new Date());if(rotated.state==='invalid')throw Error('Plopino 登录会话轮换无效');const final=rotated.state==='valid'?rotated.value:session;if(final!==session)await onSessionCandidate?.(final);return {accountId:input.accountId,username:parsed.user.username,email:parsed.user.email.toLowerCase(),sessionCookie:final,verifiedAt:(deps.now?.()??new Date()).toISOString()};
}

export function plopinoPublicationIdentity(input:PlopinoPublicationInput){
  if(!UUID.test(input.accountId)||!USERNAME.test(input.username)||!EMAIL.test(input.email)||!validPlopinoSession(input.sessionCookie)||!exactDate(input.createdAt)||!OPERATION.test(input.operationId))throw Error('Plopino 发布身份无效');
  const bytes=Buffer.byteLength(input.html,'utf8');if(!/^<!doctype html>/i.test(input.html)||bytes<256||bytes>PLOPINO_MAX_ARTICLE_BYTES)throw Error('Plopino 只接受大小合规的完整 HTML');let target:URL;try{target=new URL(input.targetUrl);if(target.protocol!=='https:'||target.username||target.password||target.port)throw Error('invalid')}catch{throw Error('Plopino 目标链接无效')}
  const content=plopinoContentIdentity(input.html),intent:PlopinoIntent={version:1,kind:'publish',operationId:input.operationId,accountId:input.accountId,createdAt:input.createdAt,requestHash:content.requestHash};return {...content,intent,targetUrl:target.href};
}
export function plopinoContentIdentity(html:string){const bytes=Buffer.byteLength(html,'utf8');if(!/^<!doctype html>/i.test(html)||bytes<256||bytes>PLOPINO_MAX_ARTICLE_BYTES)throw Error('Plopino 只接受大小合规的完整 HTML');const sourceHash=sha(html);return {bytes,sourceHash,requestHash:requestHash('publish',`${sourceHash}\0${bytes}\0index.html`)}}
function sameIntent(a:PlopinoIntent,b:Pick<PlopinoIntent,'version'|'kind'|'operationId'|'accountId'|'createdAt'|'requestHash'>){return a.version===b.version&&a.kind===b.kind&&a.operationId===b.operationId&&a.accountId===b.accountId&&a.createdAt===b.createdAt&&a.requestHash===b.requestHash}
const UNINTERPRETED_BOARD_FIELDS=['ownerId','userId','accountId','deleted','isDeleted','status','expiresAt','expiry','expires'] as const;
function hasUninterpretedBoardMetadata(value:Record<string,unknown>){return UNINTERPRETED_BOARD_FIELDS.some(key=>Object.prototype.hasOwnProperty.call(value,key))}
function exactKeys(value:Record<string,unknown>,keys:readonly string[]){const actual=Object.keys(value).sort(),expected=[...keys].sort();return actual.length===expected.length&&actual.every((key,index)=>key===expected[index])}
function exactBoardUrl(value:unknown){if(typeof value!=='string')return;const match=value.match(BOARD);return match?{id:match[1],url:`${PLOPINO_ORIGIN}/b/${match[1]}`}:undefined}
function parseObservedUpload(opaque:PlopinoOpaqueResponse,intent:PlopinoIntent,sourceHash:string,username:string,sourceBytes:number):{receipt:PlopinoPublicationReceipt;ownerId:number}|undefined{
  if(!inspectPlopinoOpaqueResponse(opaque).valid||opaque.operation!=='publish'||!sameIntent(intent,{...opaque,version:1,kind:'publish'})||opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status<200||opaque.status>=300||opaque.responseUrl&&opaque.responseUrl!==PLOPINO_UPLOAD_URL||opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return;
  let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(opaque.bodyBase64,'base64')))}catch{return}if(!object(value))return;
  if(!exactKeys(value,['ok','id','url','board','anonymous','htmlFiles'])||value.ok!==true||value.anonymous!==false||!Array.isArray(value.htmlFiles)||value.htmlFiles.length!==1||!object(value.htmlFiles[0])||!exactKeys(value.htmlFiles[0],['path','url'])||value.htmlFiles[0].path!=='index.html'||!object(value.board))return;const board=value.board,htmlFile=value.htmlFiles[0];
  if(!exactKeys(board,['id','name','public','owner','ttl','expireAt','createdAt','updatedAt','size','files','hasContent','thumb','displayVersion','versions','url'])||hasUninterpretedBoardMetadata(value)||hasUninterpretedBoardMetadata(board)||!object(board.owner)||!exactKeys(board.owner,['id','username']))return;
  const ownerId=exactOwnerId(board.owner.id);if(!ownerId||board.owner.username!==username||board.name!=='index.html'||board.public!==true||board.hasContent!==true||board.ttl!==null||board.expireAt!==null||board.size!==sourceBytes||board.files!==1||board.thumb!==false||board.displayVersion!==null||!Array.isArray(board.versions)||board.versions.length!==0||!Number.isSafeInteger(board.createdAt)||!Number.isSafeInteger(board.updatedAt)||Number(board.createdAt)<=0||Number(board.updatedAt)<Number(board.createdAt))return;
  const urls=[Object.prototype.hasOwnProperty.call(value,'url')?value.url:undefined,board&&Object.prototype.hasOwnProperty.call(board,'url')?board.url:undefined].filter(v=>v!==undefined).map(exactBoardUrl);if(!urls.length||urls.some(v=>!v))return;const first=urls[0]!;if(urls.some(v=>v!.id!==first.id||v!.url!==first.url)||htmlFile.url!==`${first.url}/index.html`)return;
  const ids=[value.id,value.boardId,board?.id,board?.boardId].filter(v=>v!==undefined);if(ids.some(v=>typeof v!=='string'||v!==first.id))return;
  return {ownerId,receipt:{operationId:intent.operationId,accountId:intent.accountId,publicUrl:first.url,boardId:first.id,sourceHash,requestHash:intent.requestHash,createdAt:intent.createdAt,ownership:'pending',accountDefaultRetention:'pending',boardExpiry:'unknown',deletion:'unknown'}};
}
function parseUploadOpaque(opaque:PlopinoOpaqueResponse,intent:PlopinoIntent,sourceHash:string,username='',sourceBytes=-1){return parseObservedUpload(opaque,intent,sourceHash,username,sourceBytes)?.receipt}
async function jsonGet(url:string,sessionCookie:string,deps:PlopinoDependencies){const {response,bytes}=await requestBytes(url,{method:'GET',headers:{accept:'application/json',cookie:`gw_session=${sessionCookie}`}},PLOPINO_MAX_RESPONSE_BYTES,deps);if(!responseOriginValid(response,url)||response.status!==200||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')throw Error('read_contract');try{return JSON.parse(decode(bytes,response)) as unknown}catch{throw Error('read_contract')}}
function exactBoardList(value:unknown,receipt:PlopinoPublicationReceipt,username='',ownerId=-1,sourceBytes=-1){if(!object(value)||!Array.isArray(value.boards))return false;const expected=exactBoardUrl(receipt.publicUrl);if(!expected||expected.id!==receipt.boardId)return false;const matches=value.boards.filter(board=>object(board)&&board.id===receipt.boardId&&exactBoardUrl(board.url)?.url===expected.url);if(matches.length!==1)return false;const board=matches[0];return exactKeys(board,['id','name','public','owner','ttl','expireAt','createdAt','updatedAt','size','files','hasContent','thumb','displayVersion','versions','url'])&&!hasUninterpretedBoardMetadata(board)&&object(board.owner)&&exactKeys(board.owner,['id','username'])&&board.owner.id===ownerId&&board.owner.username===username&&board.name==='index.html'&&board.public===true&&board.hasContent===true&&board.ttl===null&&board.expireAt===null&&board.size===sourceBytes&&board.files===1&&typeof board.thumb==='boolean'&&board.displayVersion===null&&Array.isArray(board.versions)&&board.versions.length===0&&Number.isSafeInteger(board.createdAt)&&Number.isSafeInteger(board.updatedAt)&&Number(board.createdAt)>0&&Number(board.updatedAt)>=Number(board.createdAt)}
function exactQuota(value:unknown){return object(value)&&exactKeys(value,['tier','daily','maxBytes','storage','retentionDays','signup'])&&value.tier==='user'&&value.daily===null&&value.maxBytes===52_428_800&&value.retentionDays===null&&value.signup===null&&object(value.storage)&&exactKeys(value.storage,['used','limit'])&&Number.isSafeInteger(value.storage.used)&&Number(value.storage.used)>=0&&value.storage.limit===524_288_000&&Number(value.storage.used)<=Number(value.storage.limit)}
function robotsAllowsBoards(text:string,path='/b/example/'){const allows=htmlAppPublisherTesting.robotsAllows;return allows(text,path,'*')&&allows(text,path,'googlebot')&&allows(text,path,'bingbot')}
function metadataAttribute(value:string){return value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;')}
function exactProviderMetadataHtml(actual:string,expected:string,publicUrl:string){const close='</head>',at=expected.lastIndexOf(close);if(at<0||expected.indexOf(close)!==at||!actual.startsWith(expected.slice(0,at))||!actual.endsWith(expected.slice(at)))return false;const insertion=actual.slice(at,actual.length-(expected.length-at));if(!insertion)return actual===expected;const expectedDocument=load(expected),title=expectedDocument('head > title').first().text(),description=expectedDocument('head > meta[name="description"]').first().attr('content');if(!title||description===undefined)return false;const meta=(key:'property'|'name',name:string,content:string)=>`<meta ${key}="${name}" content="${metadataAttribute(content)}">`,expectedInsertion=[meta('property','og:title',title),meta('property','og:description',description),meta('property','og:image',`${publicUrl}/thumb.jpg`),meta('property','og:image:width','800'),meta('property','og:image:height','450'),meta('property','og:url',`${publicUrl}/`),meta('property','og:type','website'),meta('property','og:site_name','Plopino'),meta('property','og:locale','en'),meta('name','twitter:card','summary_large_image')].join('');return insertion===expectedInsertion}
export async function verifyPlopinoPublicArticle(receipt:PlopinoPublicationReceipt,expectedHtml:string,targetUrl:string,deps:PlopinoDependencies={}):Promise<PlopinoPublicEvidence>{
  const match=receipt.publicUrl.match(BOARD);if(!match||match[1]!==receipt.boardId||sha(expectedHtml)!==receipt.sourceHash)throw Error('Plopino 公开核验身份不一致');const page=await requestBytes(receipt.publicUrl,{method:'GET',headers:{accept:'text/html'}},PLOPINO_MAX_ARTICLE_BYTES,deps);if(!responseOriginValid(page.response,receipt.publicUrl)||page.response.status!==200||page.response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='text/html')throw Error('Plopino 公开页不可用');const pageText=decode(page.bytes,page.response);if(pageText!==expectedHtml&&!exactProviderMetadataHtml(pageText,expectedHtml,receipt.publicUrl))throw Error('Plopino 公开页正文与已审核 HTML 不一致');const $=load(pageText),target=new URL(targetUrl).href;applyDeclaredArticleVisibility($);const visibleTargets=$('a[href]').toArray().filter(node=>{let href='';try{href=new URL($(node).attr('href')!,receipt.publicUrl).href}catch{return false}if(href!==target)return false;return !$(node).parents().addBack().toArray().some(element=>elementConcealed($,element))});if(visibleTargets.length!==1)throw Error('Plopino 公开页缺少唯一可见原生目标链接');const policy=publicPagePolicy($,receipt.publicUrl,page.response.headers.get('x-robots-tag')??'');if(!policy.valid)throw Error('Plopino 公开页禁止索引');const targetRel=withPageNofollow($(visibleTargets[0]).attr('rel')??'',policy.nofollow)||'follow';const robotsUrl=`${PLOPINO_ORIGIN}/robots.txt`,robots=await requestBytes(robotsUrl,{method:'GET',headers:{accept:'text/plain'}},128*1024,deps);if(!responseOriginValid(robots.response,robotsUrl)||robots.response.status!==200||robots.response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='text/plain'||!robotsAllowsBoards(decode(robots.bytes,robots.response),new URL(receipt.publicUrl).pathname))throw Error('Plopino robots 禁止 board 路径');return {checkedAt:(deps.now?.()??new Date()).toISOString(),publicUrl:receipt.publicUrl,bodySha256:sha(page.bytes),targetHref:target,targetRel,robotsAllowed:true,metaIndexable:true,headerIndexable:true};
}
export async function acceptPlopinoPublication(input:PlopinoPublicationInput,receipt:PlopinoPublicationReceipt,deps:PlopinoDependencies={},onSessionCandidate?:(value:string)=>void|Promise<void>,observedOwnerId?:number):Promise<PlopinoAcceptanceEvidence>{
  const identity=plopinoPublicationIdentity(input);if(receipt.operationId!==identity.intent.operationId||receipt.accountId!==input.accountId||receipt.sourceHash!==identity.sourceHash||receipt.requestHash!==identity.intent.requestHash||receipt.createdAt!==input.createdAt||receipt.publicUrl.match(BOARD)?.[1]!==receipt.boardId||!BOARD_ID.test(receipt.boardId))throw Error('Plopino 原回执与当前任务不一致');
  const me=await whoami(input.username,input.email,input.sessionCookie,deps,onSessionCandidate);if(!me.valid||!me.ownerId||observedOwnerId!==me.ownerId)throw Error('Plopino 账号身份不一致');const boards=await jsonGet(PLOPINO_BOARDS_URL,me.sessionCookie,deps);if(!exactBoardList(boards,receipt,input.username,me.ownerId,identity.bytes))throw Error('Plopino 账号列表未唯一确认原 board');const quota=await jsonGet(PLOPINO_QUOTA_URL,me.sessionCookie,deps);if(!exactQuota(quota))throw Error('Plopino 当前账号默认保留策略不符');const publicEvidence=await verifyPlopinoPublicArticle(receipt,input.html,identity.targetUrl,deps);return {identityMatched:true,boardListMatched:true,public:true,hasContent:true,tier:'user',retentionDays:null,publicEvidence};
}
export async function publishPlopinoArticle(input:PlopinoPublicationInput,persistence:PlopinoPersistence,deps:PlopinoDependencies={}):Promise<PlopinoPublishResult>{
  const identity=plopinoPublicationIdentity(input),{intent}=identity;if(!validPlopinoIntent(intent))throw Error('Plopino 发布意图无效');let opaque=await persistence.loadOpaqueResponse?.(),opaqueSaved=!!opaque,sessionCookie=input.sessionCookie;
  if(!opaque){const me=await whoami(input.username,input.email,sessionCookie,deps,candidate=>persistence.persistSessionCandidate(intent,candidate));if(!me.valid)return {status:'not_submitted',intent,reason:'发送前账号会话未通过精确核验；未上传且未锁定发布意图',opaqueSaved:false};sessionCookie=me.sessionCookie;await persistence.persistIntent(intent);await persistence.assertAuthorized(intent);const form=new FormData();form.append('file',new Blob([input.html],{type:'text/html;charset=utf-8'}),'index.html');
    try{const captured=await requestBytes(PLOPINO_UPLOAD_URL,{method:'POST',headers:{accept:'application/json',cookie:`gw_session=${sessionCookie}`,'user-agent':'linkflow-plopino'},body:form},PLOPINO_MAX_RESPONSE_BYTES,deps,undefined,async(response,bytes)=>{const saved=makeOpaque(response,bytes,intent);await persistence.persistOpaqueResponse(saved);opaque=saved;opaqueSaved=true});opaque??=makeOpaque(captured.response,captured.bytes,intent)}catch(error){return {status:'unknown',intent,reason:`Plopino 上传结果不明（${safeReason(error)}）；不会重发`,opaqueSaved}}
  }
  const observed=parseObservedUpload(opaque,intent,identity.sourceHash,input.username,identity.bytes),receipt=observed?.receipt;if(!receipt)return {status:'unknown',intent,reason:'上传响应不符合固定同源 board 契约；不会重发',opaqueSaved:true};
  try{await persistence.preservePendingPublication(receipt)}catch{return {status:'pending',intent,receipt,reason:'上传回执已加密保存，本地任务回执尚未原子晋级；不会重发',opaqueSaved:true}}
  try{const evidence=await acceptPlopinoPublication({...input,sessionCookie},receipt,deps,candidate=>persistence.persistSessionCandidate(intent,candidate),observed.ownerId);const accepted={...receipt,ownership:'account_list_match' as const,accountDefaultRetention:'no_default_expiry' as const};await persistence.promotePublished?.(accepted,evidence);return {status:'published',intent,receipt:accepted,evidence}}
  catch{return {status:'pending',intent,receipt,reason:'原 board 已返回；账号列表、默认保留策略或公开全文尚未全部核验，只读恢复且不会重发',opaqueSaved:true}}
}

export function inspectPlopinoOpaqueResponse(value:PlopinoOpaqueResponse){if(value.version!==1||value.kind!=='plopino_opaque_response'||!['register','publish'].includes(value.operation)||!OPERATION.test(value.operationId)||!UUID.test(value.accountId)||!exactDate(value.createdAt)||!HASH.test(value.requestHash)||!Number.isInteger(value.status)||value.status<100||value.status>599||value.bodyBase64.length>PLOPINO_MAX_RESPONSE_BYTES*2||value.contentType.length>512||value.responseUrl.length>2048||value.responseType.length>64)return {valid:false as const};const body=Buffer.from(value.bodyBase64,'base64');if(body.length>PLOPINO_MAX_RESPONSE_BYTES||body.toString('base64')!==value.bodyBase64||sha(body)!==value.bodySha256)return {valid:false as const};let json:unknown;try{json=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body))}catch{return {valid:true as const,json:false as const,status:value.status,bodyBytes:body.length,bodySha256:value.bodySha256}}return {valid:true as const,json:true as const,status:value.status,bodyBytes:body.length,bodySha256:value.bodySha256,topLevelKeys:object(json)?Object.keys(json).sort():[]}}

export const plopinoTesting={validIntent:validPlopinoIntent,exactMe,robotsAllowsBoards,publicationIdentity:plopinoPublicationIdentity,cookieFrom,responseOriginValid,sessionCookieFrom,parseUploadOpaque,exactBoardList,exactQuota,exactProviderMetadataHtml,sameIntent};
