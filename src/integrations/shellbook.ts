import {createHash} from 'node:crypto';
import {
  openAgentChatMutation,
  readOpenAgentChatJson,
  type OpenAgentChatDependencies,
  type OpenAgentChatOpaqueResponse,
} from './openagentchat';

// Shellbook does not document idempotent writes. The shared transport captures
// the complete response before callers parse it; callers must persist a fixed
// intent before invoking either mutation and must never repeat an unknown POST.
export const SHELLBOOK_ORIGIN='https://shellbook.io';
export const SHELLBOOK_API=`${SHELLBOOK_ORIGIN}/api/v1`;
export const SHELLBOOK_REGISTER=`${SHELLBOOK_API}/agents/register`;
export const SHELLBOOK_ME=`${SHELLBOOK_API}/agents/me`;
export const SHELLBOOK_PROFILE=`${SHELLBOOK_API}/agents/profile`;
export const SHELLBOOK_POSTS=`${SHELLBOOK_API}/posts`;
export const SHELLBOOK_SEARCH=`${SHELLBOOK_API}/search`;
export const SHELLBOOK_ROBOTS=`${SHELLBOOK_ORIGIN}/robots.txt`;
export const SHELLBOOK_MAX_RESPONSE_BYTES=512*1024;
export const SHELLBOOK_NAME=/^[a-z0-9_-]{2,30}$/;
export const SHELLBOOK_UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
export interface ShellbookDependencies extends OpenAgentChatDependencies {fixedAccountId?:string}
export type ShellbookOpaqueResponse=OpenAgentChatOpaqueResponse;
export const shellbookHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const shellbookPublicUrl=(id:string)=>`${SHELLBOOK_ORIGIN}/post/${id}`;
export const shellbookPostApiUrl=(id:string)=>`${SHELLBOOK_POSTS}/${id}`;
export const shellbookProfileUrl=(name:string)=>`${SHELLBOOK_PROFILE}?name=${encodeURIComponent(name)}`;
export const shellbookSearchUrl=(title:string)=>`${SHELLBOOK_SEARCH}?q=${encodeURIComponent(title)}`;

export interface ShellbookAgent {id:string;name:string}
export interface ShellbookPost {
  id:string;authorId:string;authorName:string;title:string;content:string;
  targetUrl:string;createdAt:string;submoltId:string;subshell:string;publicUrl:string;
}
export interface ShellbookCreateReceipt {
  id:string;authorId:string;title:string;content:string;targetUrl:string;
  createdAt:string;submoltId:string;publicUrl:string;
}
export interface ShellbookSearchCandidate {
  id:string;authorName:string;title:string;createdAt:string;subshell:string;publicUrl:string;
}
export interface ShellbookMutationIdentity {
  kind:'registration'|'publication';operationId:string;requestHash:string;
  accountId:string;sourceHash?:string;
}
export interface ShellbookAccountSecret {
  version:1;kind:'shellbook_account';operationId:string;requestHash:string;
  name:string;createdAt:string;token?:string;opaqueResponse?:ShellbookOpaqueResponse;
}
export interface ShellbookPageSecret {
  version:1;kind:'shellbook_page';operationId:string;requestHash:string;
  sourceHash:string;createdAt:string;opaqueResponse?:ShellbookOpaqueResponse;
  recoveryEvidence?:ShellbookRecoveryEvidence;
}
interface ShellbookRecoveryEvidenceBase {
  version:1;kind:'shellbook_get_recovery';provenance:'bounded_search_recent_detail_public';
  operationId:string;accountId:string;requestHash:string;sourceHash:string;
  intentCreatedAt:string;recoveredAt:string;candidateCount:number;
}
export interface ShellbookSearchRecoveryEvidence extends ShellbookRecoveryEvidenceBase {
  provenance:'bounded_search_recent_detail_public';
  reads:{me:string;search:string;recent:string;details:string[];publicPage:string;robots:string};
  searchResults:ShellbookSearchCandidate[];recentResults:ShellbookSearchCandidate[];
  details:ShellbookPost[];post:ShellbookPost;
}
export interface ShellbookCreateRecoveryEvidence extends Omit<ShellbookRecoveryEvidenceBase,'provenance'> {
  provenance:'create_receipt_detail';candidateCount:1;
  reads:{me:string;detail:string};createReceipt:ShellbookCreateReceipt;post:ShellbookPost;
}
export type ShellbookRecoveryEvidence=ShellbookSearchRecoveryEvidence|ShellbookCreateRecoveryEvidence;
export interface ShellbookRecoveryBinding {
  operationId:string;accountId:string;agentId:string;agentName:string;
  requestHash:string;sourceHash:string;intentCreatedAt:string;
  title:string;content:string;targetUrl:string;subshell:string;
  postId:string;remoteCreatedAt:string;publicUrl:string;
}

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const clean=(value:unknown,min:number,max:number):value is string=>typeof value==='string'&&value.length>=min&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const exactDate=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const exactObject=(value:unknown,required:string[],optional:string[]=[]):value is Record<string,unknown>=>record(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));

function agentValue(value:unknown):unknown {
  if(record(value)&&record(value.agent))return value.agent;
  if(record(value)&&record(value.data)&&record(value.data.agent))return value.data.agent;
  return value;
}

export function parseShellbookAgent(value:unknown):ShellbookAgent|undefined {
  const candidate=agentValue(value);
  if(!record(candidate)||typeof candidate.id!=='string'||!SHELLBOOK_UUID.test(candidate.id)||typeof candidate.name!=='string'||!SHELLBOOK_NAME.test(candidate.name))return;
  return {id:candidate.id,name:candidate.name};
}

export function parseShellbookRegistration(value:unknown):{agent:ShellbookAgent;token:string}|undefined {
  const root=record(value)&&record(value.data)?value.data:value,agent=parseShellbookAgent(root);
  if(!agent||!record(root)||!clean(root.api_key,20,4096)||!/^mf_[A-Za-z0-9_-]+$/.test(root.api_key))return;
  return {agent,token:root.api_key};
}

function postValue(value:unknown):unknown {
  if(record(value)&&record(value.post))return value.post;
  if(record(value)&&record(value.data)&&record(value.data.post))return value.data.post;
  return value;
}

export function parseShellbookPost(value:unknown):ShellbookPost|undefined {
  const candidate=postValue(value);
  if(!record(candidate)||typeof candidate.id!=='string'||!SHELLBOOK_UUID.test(candidate.id)||typeof candidate.author_id!=='string'||!SHELLBOOK_UUID.test(candidate.author_id)||!record(candidate.author)||typeof candidate.author.name!=='string'||!SHELLBOOK_NAME.test(candidate.author.name)||!clean(candidate.title,1,300)||typeof candidate.content!=='string'||candidate.content.length<10||candidate.content.length>40_000||/[\u0000\u000b\u000c\u000e-\u001f\u007f]/.test(candidate.content)||typeof candidate.url!=='string'||candidate.url.length>2048||!exactDate(candidate.created_at)||candidate.is_deleted!==false||candidate.deleted_at!==null||typeof candidate.submolt_id!=='string'||!SHELLBOOK_UUID.test(candidate.submolt_id)||!record(candidate.subshell)||typeof candidate.subshell.name!=='string'||!/^[a-z0-9_]{2,24}$/.test(candidate.subshell.name))return;
  try{const target=new URL(candidate.url);if(target.protocol!=='https:'||target.username||target.password||target.port||target.hash)return}catch{return}
  return {id:candidate.id,authorId:candidate.author_id,authorName:candidate.author.name,title:candidate.title,content:candidate.content,targetUrl:candidate.url,createdAt:new Date(candidate.created_at as string).toISOString(),submoltId:candidate.submolt_id,subshell:candidate.subshell.name,publicUrl:shellbookPublicUrl(candidate.id)};
}

export function parseShellbookCreateReceipt(value:unknown):ShellbookCreateReceipt|undefined {
  const candidate=postValue(value);
  if(!record(candidate)||typeof candidate.id!=='string'||!SHELLBOOK_UUID.test(candidate.id)||typeof candidate.author_id!=='string'||!SHELLBOOK_UUID.test(candidate.author_id)||!clean(candidate.title,1,300)||typeof candidate.content!=='string'||candidate.content.length<10||candidate.content.length>40_000||/[\u0000\u000b\u000c\u000e-\u001f\u007f]/.test(candidate.content)||typeof candidate.url!=='string'||candidate.url.length>2048||!exactDate(candidate.created_at)||candidate.is_deleted!==false||candidate.deleted_at!==null||typeof candidate.submolt_id!=='string'||!SHELLBOOK_UUID.test(candidate.submolt_id))return;
  try{const target=new URL(candidate.url);if(target.protocol!=='https:'||target.username||target.password||target.port||target.hash)return}catch{return}
  return {id:candidate.id,authorId:candidate.author_id,title:candidate.title,content:candidate.content,targetUrl:candidate.url,createdAt:new Date(candidate.created_at as string).toISOString(),submoltId:candidate.submolt_id,publicUrl:shellbookPublicUrl(candidate.id)};
}

function named(value:unknown,pattern:RegExp):string|undefined {const name=record(value)?value.name:value;return typeof name==='string'&&pattern.test(name)?name:undefined}
export function parseShellbookSearchCandidates(value:unknown,exactTitle:string):ShellbookSearchCandidate[]|undefined {
  const root=record(value)&&record(value.data)?value.data:value;
  const items=Array.isArray(root)?root:record(root)&&Array.isArray(root.posts)?root.posts:record(root)&&Array.isArray(root.results)?root.results:record(root)&&Array.isArray(root.items)?root.items:undefined;
  if(!items||items.length>200||!clean(exactTitle,1,300))return;
  const out:ShellbookSearchCandidate[]=[];
  for(const item of items){if(!record(item)||item.title!==exactTitle)continue;const authorName=named(item.author,SHELLBOOK_NAME),subshell=named(item.subshell,/^[a-z0-9_]{2,24}$/);if(typeof item.id!=='string'||!SHELLBOOK_UUID.test(item.id)||!authorName||!subshell||!exactDate(item.created_at))return;out.push({id:item.id,authorName,title:exactTitle,createdAt:new Date(item.created_at as string).toISOString(),subshell,publicUrl:shellbookPublicUrl(item.id)})}
  return out;
}

export function parseShellbookPostList(value:unknown):ShellbookPost[]|undefined {
  const root=record(value)&&record(value.data)?value.data:value;
  const items=Array.isArray(root)?root:record(root)&&Array.isArray(root.posts)?root.posts:record(root)&&Array.isArray(root.results)?root.results:record(root)&&Array.isArray(root.items)?root.items:undefined;
  if(!items||items.length>200)return;
  const parsed=items.map(parseShellbookPost).filter((item):item is ShellbookPost=>!!item);
  return parsed.length===items.length?parsed:undefined;
}

export function shellbookRegistrationRequest(name:string,description:string){
  if(!SHELLBOOK_NAME.test(name)||!clean(description,1,1000))throw Error('Shellbook 账号资料无效');
  const body=JSON.stringify({name,description});
  return {body,requestHash:shellbookHash(`POST\n${SHELLBOOK_REGISTER}\ncontent-type:application/json\n\n${body}`)};
}

export function shellbookPostRequest(title:string,content:string,url:string,subshell='agents'){
  if(!clean(title,1,300)||content.length<10||content.length>40_000||/[\u0000\u000b\u000c\u000e-\u001f\u007f]/.test(content)||!/^[a-z0-9_]{2,24}$/.test(subshell))throw Error('Shellbook 稿件无效');
  try{const target=new URL(url);if(target.protocol!=='https:'||target.username||target.password||target.port||target.hash)throw Error()}catch{throw Error('Shellbook 目标网址无效')}
  const body=JSON.stringify({title,content,url,subshell});
  return {body,sourceHash:shellbookHash(content),requestHash:shellbookHash(`POST\n${SHELLBOOK_POSTS}\ncontent-type:application/json\n\n${body}`)};
}

export const shellbookMutation=openAgentChatMutation;
export const readShellbookJson=readOpenAgentChatJson;

export function parseShellbookOpaque(value:ShellbookOpaqueResponse,url:string):unknown|undefined {
  if(value.requestUrl!==url||!value.bodyComplete||value.status<200||value.status>=300||value.redirected||value.responseType==='opaqueredirect'||value.responseUrl&&value.responseUrl!==url||value.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return;
  try{const bytes=Buffer.from(value.bodyBase64,'base64');if(bytes.length>SHELLBOOK_MAX_RESPONSE_BYTES||bytes.toString('base64')!==value.bodyBase64||shellbookHash(bytes)!==value.bodySha256)return;return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{return}
}

function validOpaque(value:unknown):value is ShellbookOpaqueResponse {
  if(!exactObject(value,['version','capturedAt','requestUrl','status','contentType','responseUrl','redirected','responseType','headers','bodyBase64','bodySha256','bodyComplete'])||value.version!==1||!exactDate(value.capturedAt)||typeof value.requestUrl!=='string'||!Number.isSafeInteger(value.status)||typeof value.contentType!=='string'||typeof value.responseUrl!=='string'||typeof value.redirected!=='boolean'||typeof value.responseType!=='string'||!Array.isArray(value.headers)||value.headers.length>128||value.headers.some(item=>!Array.isArray(item)||item.length!==2||typeof item[0]!=='string'||typeof item[1]!=='string')||typeof value.bodyBase64!=='string'||typeof value.bodySha256!=='string'||!SHA.test(value.bodySha256)||typeof value.bodyComplete!=='boolean')return false;
  try{const bytes=Buffer.from(value.bodyBase64,'base64');return bytes.length<=SHELLBOOK_MAX_RESPONSE_BYTES&&bytes.toString('base64')===value.bodyBase64&&shellbookHash(bytes)===value.bodySha256}catch{return false}
}

export function validShellbookPublicationOpaque(value:unknown):value is ShellbookOpaqueResponse {
  if(!validOpaque(value)||value.requestUrl!==SHELLBOOK_POSTS||value.status<100||value.status>599||value.redirected||value.responseType==='opaqueredirect'||value.responseType.length>32||value.contentType.length>256||value.responseUrl.length>2048||value.responseUrl&&value.responseUrl!==SHELLBOOK_POSTS)return false;
  return value.headers.every(([name,header])=>name.length<=128&&header.length<=8192);
}

export function validShellbookAccountSecret(value:unknown):value is ShellbookAccountSecret {
  return exactObject(value,['version','kind','operationId','requestHash','name','createdAt'],['token','opaqueResponse'])&&value.version===1&&value.kind==='shellbook_account'&&typeof value.operationId==='string'&&/^shellbook_register_[a-f0-9]{32}$/.test(value.operationId)&&typeof value.requestHash==='string'&&SHA.test(value.requestHash)&&typeof value.name==='string'&&SHELLBOOK_NAME.test(value.name)&&exactDate(value.createdAt)&&(value.token===undefined||clean(value.token,20,4096)&&/^mf_[A-Za-z0-9_-]+$/.test(value.token))&&(value.opaqueResponse===undefined||validOpaque(value.opaqueResponse));
}

export function validShellbookPageSecret(value:unknown):value is ShellbookPageSecret {
  return exactObject(value,['version','kind','operationId','requestHash','sourceHash','createdAt'],['opaqueResponse','recoveryEvidence'])&&value.version===1&&value.kind==='shellbook_page'&&typeof value.operationId==='string'&&/^shellbook_post_[a-f0-9]{32}$/.test(value.operationId)&&typeof value.requestHash==='string'&&SHA.test(value.requestHash)&&typeof value.sourceHash==='string'&&SHA.test(value.sourceHash)&&exactDate(value.createdAt)&&(value.opaqueResponse===undefined||validShellbookPublicationOpaque(value.opaqueResponse))&&(value.recoveryEvidence===undefined||validShellbookRecoveryEvidence(value.recoveryEvidence));
}

function validStoredPost(post:unknown):post is ShellbookPost {
  if(!exactObject(post,['id','authorId','authorName','title','content','targetUrl','createdAt','submoltId','subshell','publicUrl'])||typeof post.id!=='string'||!SHELLBOOK_UUID.test(post.id)||typeof post.authorId!=='string'||!SHELLBOOK_UUID.test(post.authorId)||typeof post.authorName!=='string'||!SHELLBOOK_NAME.test(post.authorName)||!clean(post.title,1,300)||typeof post.content!=='string'||post.content.length<10||post.content.length>40_000||/[\u0000\u000b\u000c\u000e-\u001f\u007f]/.test(post.content)||typeof post.targetUrl!=='string'||post.targetUrl.length>2048||!exactDate(post.createdAt)||typeof post.submoltId!=='string'||!SHELLBOOK_UUID.test(post.submoltId)||typeof post.subshell!=='string'||!/^[a-z0-9_]{2,24}$/.test(post.subshell)||typeof post.publicUrl!=='string'||post.publicUrl.length>2048)return false;
  try{for(const url of [post.targetUrl,post.publicUrl]){const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||parsed.hash)return false}}catch{return false}return post.publicUrl===shellbookPublicUrl(post.id);
}

function validStoredCreateReceipt(value:unknown):value is ShellbookCreateReceipt {return exactObject(value,['id','authorId','title','content','targetUrl','createdAt','submoltId','publicUrl'])&&parseShellbookCreateReceipt({id:value.id,author_id:value.authorId,title:value.title,content:value.content,url:value.targetUrl,created_at:value.createdAt,submolt_id:value.submoltId,is_deleted:false,deleted_at:null})?.publicUrl===value.publicUrl}
function validStoredCandidate(value:unknown):value is ShellbookSearchCandidate {return exactObject(value,['id','authorName','title','createdAt','subshell','publicUrl'])&&typeof value.id==='string'&&SHELLBOOK_UUID.test(value.id)&&typeof value.authorName==='string'&&SHELLBOOK_NAME.test(value.authorName)&&clean(value.title,1,300)&&exactDate(value.createdAt)&&typeof value.subshell==='string'&&/^[a-z0-9_]{2,24}$/.test(value.subshell)&&value.publicUrl===shellbookPublicUrl(value.id)}

export function validShellbookRecoveryEvidence(value:unknown):value is ShellbookRecoveryEvidence {
  if(!record(value)||value.version!==1||value.kind!=='shellbook_get_recovery'||typeof value.operationId!=='string'||!/^shellbook_post_[a-f0-9]{32}$/.test(value.operationId)||typeof value.accountId!=='string'||!SHELLBOOK_UUID.test(value.accountId)||typeof value.requestHash!=='string'||!SHA.test(value.requestHash)||typeof value.sourceHash!=='string'||!SHA.test(value.sourceHash)||!exactDate(value.intentCreatedAt)||!exactDate(value.recoveredAt))return false;
  let readUrls:string[];
  if(value.provenance==='create_receipt_detail'){
    if(!exactObject(value,['version','kind','provenance','operationId','accountId','requestHash','sourceHash','intentCreatedAt','recoveredAt','candidateCount','reads','createReceipt','post'])||value.candidateCount!==1||!exactObject(value.reads,['me','detail'])||!validStoredCreateReceipt(value.createReceipt)||!validStoredPost(value.post))return false;
    readUrls=Object.values(value.reads) as string[];
  }else if(value.provenance==='bounded_search_recent_detail_public'){
    if(!exactObject(value,['version','kind','provenance','operationId','accountId','requestHash','sourceHash','intentCreatedAt','recoveredAt','candidateCount','reads','searchResults','recentResults','details','post'])||typeof value.candidateCount!=='number'||!Number.isSafeInteger(value.candidateCount)||value.candidateCount<1||value.candidateCount>5||!exactObject(value.reads,['me','search','recent','details','publicPage','robots'])||!Array.isArray(value.reads.details)||value.reads.details.length!==value.candidateCount||!Array.isArray(value.searchResults)||value.searchResults.length>200||value.searchResults.some(item=>!validStoredCandidate(item))||!Array.isArray(value.recentResults)||value.recentResults.length>200||value.recentResults.some(item=>!validStoredCandidate(item))||!Array.isArray(value.details)||value.details.length!==value.candidateCount||value.details.some(item=>!validStoredPost(item))||!validStoredPost(value.post))return false;
    readUrls=[value.reads.me,value.reads.search,value.reads.recent,...value.reads.details,value.reads.publicPage,value.reads.robots];
  }else return false;
  if(readUrls.some(item=>typeof item!=='string'||item.length>4096))return false;try{for(const url of readUrls){const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||parsed.hash)return false}}catch{return false}
  return Buffer.byteLength(JSON.stringify(value))<=SHELLBOOK_MAX_RESPONSE_BYTES;
}

export function shellbookRecoveryEvidenceMatches(value:unknown,expected:ShellbookRecoveryBinding):value is ShellbookRecoveryEvidence {
  if(!validShellbookRecoveryEvidence(value)||value.operationId!==expected.operationId||value.accountId!==expected.accountId||value.requestHash!==expected.requestHash||value.sourceHash!==expected.sourceHash||value.intentCreatedAt!==expected.intentCreatedAt||value.post.id!==expected.postId||value.post.authorId!==expected.agentId||value.post.authorName!==expected.agentName||value.post.title!==expected.title||value.post.content!==expected.content||value.post.targetUrl!==expected.targetUrl||value.post.createdAt!==expected.remoteCreatedAt||value.post.subshell!==expected.subshell||value.post.publicUrl!==expected.publicUrl||value.sourceHash!==shellbookHash(expected.content))return false;
  const delta=Math.abs(Date.parse(expected.remoteCreatedAt)-Date.parse(expected.intentCreatedAt));if(!Number.isFinite(delta)||delta>10*60_000||Date.parse(value.recoveredAt)<Date.parse(expected.remoteCreatedAt))return false;
  const exact=(post:ShellbookPost)=>post.authorId===expected.agentId&&post.authorName===expected.agentName&&post.title===expected.title&&post.content===expected.content&&post.targetUrl===expected.targetUrl&&post.subshell===expected.subshell&&Math.abs(Date.parse(post.createdAt)-Date.parse(expected.intentCreatedAt))<=10*60_000;
  if(value.provenance==='create_receipt_detail'){
    const receipt=value.createReceipt;if(receipt.id!==value.post.id||receipt.authorId!==value.post.authorId||receipt.title!==value.post.title||receipt.content!==value.post.content||receipt.targetUrl!==value.post.targetUrl||receipt.createdAt!==value.post.createdAt||receipt.submoltId!==value.post.submoltId||receipt.publicUrl!==value.post.publicUrl||!exact(value.post))return false;
    return value.reads.me===SHELLBOOK_ME&&value.reads.detail===shellbookPostApiUrl(expected.postId)&&expected.publicUrl===shellbookPublicUrl(expected.postId);
  }
  const summary=(item:ShellbookSearchCandidate)=>item.authorName===expected.agentName&&item.title===expected.title&&item.subshell===expected.subshell&&Math.abs(Date.parse(item.createdAt)-Date.parse(expected.intentCreatedAt))<=10*60_000,candidates=[...new Map([...value.searchResults,...value.recentResults].filter(summary).map(item=>[item.id,item])).values()],ids=candidates.map(item=>item.id).sort(),detailIds=value.details.map(item=>item.id).sort();if(ids.length!==value.candidateCount||JSON.stringify(ids)!==JSON.stringify(detailIds)||value.details.filter(exact).length!==1||JSON.stringify(value.details.find(exact))!==JSON.stringify(value.post))return false;
  return value.reads.me===SHELLBOOK_ME&&value.reads.search===shellbookSearchUrl(expected.title)&&value.reads.recent===SHELLBOOK_POSTS&&JSON.stringify(value.reads.details)===JSON.stringify(ids.map(shellbookPostApiUrl))&&value.reads.publicPage===expected.publicUrl&&value.reads.robots===SHELLBOOK_ROBOTS&&expected.publicUrl===shellbookPublicUrl(expected.postId);
}

async function limitedBody(response:Response,signal:AbortSignal):Promise<Uint8Array>{
  const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>SHELLBOOK_MAX_RESPONSE_BYTES))throw Error('Shellbook readback too large');
  if(!response.body)return new Uint8Array();const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const next=await reader.read();if(signal.aborted)throw Error('Shellbook readback aborted');if(next.done)break;size+=next.value.length;if(size>SHELLBOOK_MAX_RESPONSE_BYTES)throw Error('Shellbook readback too large');chunks.push(next.value)}const out=new Uint8Array(size);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length}return out}finally{try{reader.releaseLock()}catch{}}
}

export async function readShellbookStatus(url:string,token:string|undefined,deps:ShellbookDependencies={}):Promise<{status:number;value?:unknown}>{
  const controller=new AbortController(),timeout=Math.min(60_000,Math.max(100,deps.timeoutMs??25_000)),abort=()=>controller.abort();deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)controller.abort();const timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.();
  try{const headers:Record<string,string>={accept:'application/json'};if(token)headers.authorization=`Bearer ${token}`;const response=await (deps.fetch??((u:string,i:RequestInit)=>fetch(u,i)))(url,{method:'GET',headers,signal:controller.signal,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});if(response.redirected||response.url&&response.url!==url)throw Error('Shellbook readback redirected');if(response.status===404)return {status:404};if(response.status!==200||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')throw Error('Shellbook readback invalid');const bytes=await limitedBody(response,controller.signal);return {status:200,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort)}
}
