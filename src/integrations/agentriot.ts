import {createHash} from 'node:crypto';
import {
  isOpenAgentChatOpaqueProgress,
  openAgentChatStreamingMutation,
  type OpenAgentChatDependencies,
  type OpenAgentChatOpaqueResponse,
} from './openagentchat';

// AgentRiot does not document idempotent registration or update writes. The
// installation identity and the exact update payload are persisted before the
// only POST. An unknown result is reconciled through public GETs and is never
// retried as a mutation.
export const AGENTRIOT_ORIGIN='https://agentriot.com';
export const AGENTRIOT_PROTOCOL=`${AGENTRIOT_ORIGIN}/api/agent-protocol`;
export const AGENTRIOT_REGISTER=`${AGENTRIOT_ORIGIN}/api/agents/register`;
export const AGENTRIOT_ROBOTS=`${AGENTRIOT_ORIGIN}/robots.txt`;
export const AGENTRIOT_MAX_RESPONSE_BYTES=512*1024;
export const AGENTRIOT_SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const AGENTRIOT_ID=/^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|[A-Za-z][A-Za-z0-9_-]{2,199})$/i;
export const AGENTRIOT_SIGNAL_TYPES=['major_release','launch','funding','partnership','milestone','research','status','minor_release','bugfix','prompt_update'] as const;
export type AgentRiotSignalType=typeof AGENTRIOT_SIGNAL_TYPES[number];
const SHA=/^[a-f0-9]{64}$/;
const validSlug=(value:unknown):value is string=>typeof value==='string'&&value.length<=160&&AGENTRIOT_SLUG.test(value);

export type AgentRiotOpaqueResponse=OpenAgentChatOpaqueResponse;
export interface AgentRiotNativeRequest {url:string;method:'GET';resourceType:'mainFrame'|'stylesheet'|'font'}
export interface AgentRiotRenderedPage {
  url:string;documentTitle:string;title:string;summary:string;whatChanged:string;
  titleReadableRects:number;summaryReadableRects:number;whatChangedReadableRects:number;
  publicLinks:Array<{href:string;rel:string[];text:string;readableRects:number}>;
  robots:Array<{name:string;content:string}>;canonicals:string[];
  hasRefresh:boolean;hasPasswordGate:boolean;hasLoginGate:boolean;
  responseRobots:string[];responseLinks:string[];responseStatus:number;
  responseMediaType:string;responseBodyBytes:number;responseEncodedBodyBytes:number;
  nativeRequests:AgentRiotNativeRequest[];
}
export interface AgentRiotRenderHooks {onBeforeRequest?:(request:AgentRiotNativeRequest)=>void;onResponseHeaders?:(headers:Record<string,string[]>)=>void|Promise<void>;onScreenshot?:(png:Uint8Array)=>void|Promise<void>}
export interface AgentRiotPersistence {
  persistAccountOpaque(accountId:string,secret:AgentRiotAccountSecret):Promise<void>;
  persistPublicationIntent(secret:AgentRiotPageSecret,receipt:AgentRiotPublicationIntent):Promise<void>;
  persistPublicationOpaque(secret:AgentRiotPageSecret):Promise<void>;
  persistRecoveryEvidence(secret:AgentRiotPageSecret):Promise<void>;
}
export interface AgentRiotDependencies extends Omit<OpenAgentChatDependencies,'renderPage'> {
  fixedAccountId?:string;
  renderPage?:(url:string,signal:AbortSignal,hooks?:AgentRiotRenderHooks)=>Promise<AgentRiotRenderedPage>;
}
export interface AgentRiotUpdatePayload {title:string;summary:string;whatChanged:string;signalType:AgentRiotSignalType;publicLink:string;skillsTools?:string[]}
export interface AgentRiotAgentSummary {id:string;slug:string;name:string}
export interface AgentRiotUpdate {
  id:string;slug:string;title:string;summary:string;whatChanged:string;
  signalType:AgentRiotSignalType;publicLink:string|null;skillsTools:string[];
  createdAt:string;updatedAt:string;publicUrl:string;
  isFeedVisible?:boolean;visibility?:string;moderationStatus?:string;
}
export interface AgentRiotProfile extends AgentRiotAgentSummary {
  tagline:string;description:string;installationIdHash:string;status:string;
  postingStatus:string;lastPostedAt:string|null;updates:AgentRiotUpdate[];
}
export interface AgentRiotUpdateReceipt {id:string;slug:string;title:string;signalType:AgentRiotSignalType;createdAt:string;publicUrl:string}
export interface AgentRiotMutationIdentity {kind:'registration'|'publication';operationId:string;requestHash:string;accountId:string;sourceHash?:string}
export interface AgentRiotPublicationIntent {operationId:string;accountId:string;agentId:string;agentSlug:string;agentName:string;targetUrl:string;sourceHash:string;requestHash:string;createdAt:string;stage:'submitting'}
export interface AgentRiotAccountSecret {
  version:1;kind:'agentriot_account';operationId:string;requestHash:string;
  installationId:string;name:string;tagline:string;description:string;
  createdAt:string;apiKey?:string;opaqueResponse?:AgentRiotOpaqueResponse;
}
export interface AgentRiotPageSecret {
  version:1;kind:'agentriot_update';operationId:string;requestHash:string;
  sourceHash:string;agentSlug:string;payload:AgentRiotUpdatePayload;createdAt:string;
  opaqueResponse?:AgentRiotOpaqueResponse;recoveryEvidence?:AgentRiotRecoveryEvidence;
}
export interface AgentRiotRecoveryEvidence {
  version:1;kind:'agentriot_get_recovery';provenance:'public_profile_and_update_page';
  operationId:string;accountId:string;requestHash:string;sourceHash:string;
  intentCreatedAt:string;recoveredAt:string;candidateCount:1;
  reads:{profile:string;publicPage:string;robots:string};
  profile:AgentRiotProfile;update:AgentRiotUpdate;
}
export interface AgentRiotRecoveryBinding {
  operationId:string;accountId:string;agentId:string;agentSlug:string;agentName:string;
  requestHash:string;sourceHash:string;intentCreatedAt:string;
  payload:AgentRiotUpdatePayload;updateId:string;updateSlug:string;
  remoteCreatedAt:string;publicUrl:string;
}

export const agentriotHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const agentriotInstallationId=(accountId:string)=>`linkflow-desktop:${accountId.toLowerCase()}`;
export const agentriotProfileUrl=(slug:string)=>`${AGENTRIOT_ORIGIN}/api/agents/${encodeURIComponent(slug)}`;
export const agentriotUpdatesUrl=(slug:string)=>`${agentriotProfileUrl(slug)}/updates`;
export const agentriotPublicUrl=(agentSlug:string,updateSlug:string)=>`${AGENTRIOT_ORIGIN}/agents/${agentSlug}/updates/${updateSlug}`;

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exactObject=(value:unknown,required:string[],optional:string[]=[]):value is Record<string,unknown>=>record(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const clean=(value:unknown,min:number,max:number):value is string=>typeof value==='string'&&value.length>=min&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const exactDate=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const signalType=(value:unknown):value is AgentRiotSignalType=>typeof value==='string'&&(AGENTRIOT_SIGNAL_TYPES as readonly string[]).includes(value);
function safeHttps(value:unknown):value is string{if(typeof value!=='string'||value.length>2048)return false;try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash}catch{return false}}
function validTags(value:unknown):value is string[]{return Array.isArray(value)&&value.length<=5&&value.every(item=>clean(item,1,120))}
function samePayload(left:Pick<AgentRiotUpdate,'title'|'summary'|'whatChanged'|'signalType'|'publicLink'|'skillsTools'>|AgentRiotUpdatePayload,right:AgentRiotUpdatePayload):boolean{return left.title===right.title&&left.summary===right.summary&&left.whatChanged===right.whatChanged&&left.signalType===right.signalType&&left.publicLink===right.publicLink&&JSON.stringify(left.skillsTools??[])===JSON.stringify(right.skillsTools??[])}

export function parseAgentRiotAgentSummary(value:unknown):AgentRiotAgentSummary|undefined {
  const candidate=record(value)&&record(value.agent)?value.agent:value;
  if(!record(candidate)||typeof candidate.id!=='string'||!AGENTRIOT_ID.test(candidate.id)||!validSlug(candidate.slug)||!clean(candidate.name,1,120))return;
  return {id:candidate.id,slug:candidate.slug,name:candidate.name};
}

export function parseAgentRiotRegistration(value:unknown):{agent:AgentRiotAgentSummary;apiKey:string}|undefined {
  if(!record(value)||value.registrationStatus!=='created'||!clean(value.apiKey,16,256)||!/^agrt_[A-Za-z0-9_-]+$/.test(value.apiKey))return;
  const agent=parseAgentRiotAgentSummary(value.agent);return agent?{agent,apiKey:value.apiKey}:undefined;
}

export function parseAgentRiotUpdate(value:unknown,agentSlug:string):AgentRiotUpdate|undefined {
  if(!validSlug(agentSlug)||!record(value)||typeof value.id!=='string'||!AGENTRIOT_ID.test(value.id)||!validSlug(value.slug)||!clean(value.title,1,80)||!clean(value.summary,1,240)||!clean(value.whatChanged,1,500)||!signalType(value.signalType)||value.skillsTools!==undefined&&!validTags(value.skillsTools)||value.publicLink!==null&&!safeHttps(value.publicLink)||!exactDate(value.createdAt)||!exactDate(value.updatedAt))return;
  if(value.isFeedVisible!==undefined&&typeof value.isFeedVisible!=='boolean'||value.visibility!==undefined&&typeof value.visibility!=='string'||value.moderationStatus!==undefined&&typeof value.moderationStatus!=='string')return;
  return {id:value.id,slug:value.slug,title:value.title,summary:value.summary,whatChanged:value.whatChanged,signalType:value.signalType,publicLink:value.publicLink,skillsTools:value.skillsTools===undefined?[]:[...value.skillsTools],createdAt:new Date(value.createdAt).toISOString(),updatedAt:new Date(value.updatedAt).toISOString(),publicUrl:agentriotPublicUrl(agentSlug,value.slug),...(typeof value.isFeedVisible==='boolean'?{isFeedVisible:value.isFeedVisible}:{}),...(typeof value.visibility==='string'?{visibility:value.visibility}:{}),...(typeof value.moderationStatus==='string'?{moderationStatus:value.moderationStatus}:{})};
}

export function parseAgentRiotProfile(value:unknown):AgentRiotProfile|undefined {
  const profile=record(value)&&record(value.profile)?value.profile:undefined;if(!profile)return;
  const agent=parseAgentRiotAgentSummary(profile);if(!agent||!clean(profile.tagline,1,120)||!clean(profile.description,1,1000)||typeof profile.installationIdHash!=='string'||!SHA.test(profile.installationIdHash)||typeof profile.status!=='string'||typeof profile.postingStatus!=='string'||profile.lastPostedAt!==null&&!exactDate(profile.lastPostedAt)||!Array.isArray(profile.updates)||profile.updates.length>200)return;
  const updates=profile.updates.map(item=>parseAgentRiotUpdate(item,agent.slug));if(updates.some(item=>!item))return;
  return {...agent,tagline:profile.tagline,description:profile.description,installationIdHash:profile.installationIdHash,status:profile.status,postingStatus:profile.postingStatus,lastPostedAt:profile.lastPostedAt===null?null:new Date(profile.lastPostedAt as string).toISOString(),updates:updates as AgentRiotUpdate[]};
}

export function parseAgentRiotUpdateReceipt(value:unknown,agentSlug:string):AgentRiotUpdateReceipt|undefined {
  const update=record(value)&&record(value.update)?value.update:undefined;if(!validSlug(agentSlug)||!update||typeof update.id!=='string'||!AGENTRIOT_ID.test(update.id)||!validSlug(update.slug)||!clean(update.title,1,80)||!signalType(update.signalType)||!exactDate(update.createdAt))return;
  return {id:update.id,slug:update.slug,title:update.title,signalType:update.signalType,createdAt:new Date(update.createdAt).toISOString(),publicUrl:agentriotPublicUrl(agentSlug,update.slug)};
}

export function agentriotRegistrationRequest(installationId:string,name:string,tagline:string,description:string){
  if(!clean(installationId,1,256)||!AGENTRIOT_SLUG.test(name)||name.length>120||!clean(tagline,1,120)||!clean(description,1,1000))throw Error('AgentRiot identity is invalid');
  const body=JSON.stringify({installationId,name,tagline,description,softwareName:'LinkFlow'});
  return {body,requestHash:agentriotHash(`POST\n${AGENTRIOT_REGISTER}\ncontent-type:application/json\n\n${body}`)};
}

export function agentriotUpdateRequest(agentSlug:string,payload:AgentRiotUpdatePayload){
  if(!validSlug(agentSlug)||!clean(payload.title,1,80)||!clean(payload.summary,1,240)||!clean(payload.whatChanged,1,500)||!signalType(payload.signalType)||!safeHttps(payload.publicLink)||payload.skillsTools!==undefined&&!validTags(payload.skillsTools))throw Error('AgentRiot update is invalid');
  const normalized:AgentRiotUpdatePayload={title:payload.title,summary:payload.summary,whatChanged:payload.whatChanged,...(payload.skillsTools?.length?{skillsTools:[...payload.skillsTools]}:{}),signalType:payload.signalType,publicLink:payload.publicLink};
  const body=JSON.stringify(normalized),url=agentriotUpdatesUrl(agentSlug),sourceHash=agentriotHash(body);
  return {body,payload:normalized,sourceHash,requestHash:agentriotHash(`POST\n${url}\ncontent-type:application/json\n\n${body}`)};
}

export async function agentriotMutation(
  url:string,
  init:RequestInit,
  persist:(value:AgentRiotOpaqueResponse)=>Promise<void>,
  authorize:()=>true,
  deps:AgentRiotDependencies={},
):Promise<AgentRiotOpaqueResponse|undefined>{
  const transport:OpenAgentChatDependencies={
    ...(deps.fetch?{fetch:deps.fetch}:{}),
    ...(deps.signal?{signal:deps.signal}:{}),
    ...(deps.timeoutMs!==undefined?{timeoutMs:deps.timeoutMs}:{}),
    ...(deps.now?{now:deps.now}:{}),
  };
  return openAgentChatStreamingMutation(url,init,persist,authorize,transport);
}
export const isAgentRiotOpaqueProgress=isOpenAgentChatOpaqueProgress;

export function parseAgentRiotOpaque(value:AgentRiotOpaqueResponse,url:string,expectedStatus:number|readonly number[]):unknown|undefined {
  const statuses=Array.isArray(expectedStatus)?expectedStatus:[expectedStatus];
  if(value.requestUrl!==url||!statuses.includes(value.status)||!value.bodyComplete||value.redirected||value.responseType==='opaqueredirect'||value.responseUrl&&value.responseUrl!==url||value.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return;
  try{const bytes=Buffer.from(value.bodyBase64,'base64');if(bytes.length>AGENTRIOT_MAX_RESPONSE_BYTES||bytes.toString('base64')!==value.bodyBase64||agentriotHash(bytes)!==value.bodySha256)return;return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{return}
}

function validOpaque(value:unknown):value is AgentRiotOpaqueResponse {
  if(!exactObject(value,['version','capturedAt','requestUrl','status','contentType','responseUrl','redirected','responseType','headers','bodyBase64','bodySha256','bodyComplete'])||value.version!==1||!exactDate(value.capturedAt)||typeof value.requestUrl!=='string'||!Number.isSafeInteger(value.status)||typeof value.contentType!=='string'||typeof value.responseUrl!=='string'||typeof value.redirected!=='boolean'||typeof value.responseType!=='string'||!Array.isArray(value.headers)||value.headers.length>128||value.headers.some(item=>!Array.isArray(item)||item.length!==2||typeof item[0]!=='string'||typeof item[1]!=='string')||typeof value.bodyBase64!=='string'||typeof value.bodySha256!=='string'||!SHA.test(value.bodySha256)||typeof value.bodyComplete!=='boolean')return false;
  try{const bytes=Buffer.from(value.bodyBase64,'base64');return bytes.length<=AGENTRIOT_MAX_RESPONSE_BYTES&&bytes.toString('base64')===value.bodyBase64&&agentriotHash(bytes)===value.bodySha256}catch{return false}
}

export function validAgentRiotAccountSecret(value:unknown):value is AgentRiotAccountSecret {
  if(!exactObject(value,['version','kind','operationId','requestHash','installationId','name','tagline','description','createdAt'],['apiKey','opaqueResponse'])||value.version!==1||value.kind!=='agentriot_account'||typeof value.operationId!=='string'||!/^agentriot_register_[a-f0-9]{32}$/.test(value.operationId)||typeof value.requestHash!=='string'||!SHA.test(value.requestHash)||!clean(value.installationId,1,256)||typeof value.name!=='string'||!AGENTRIOT_SLUG.test(value.name)||value.name.length>120||!clean(value.tagline,1,120)||!clean(value.description,1,1000)||!exactDate(value.createdAt)||(value.apiKey!==undefined&&(!clean(value.apiKey,16,256)||!/^agrt_[A-Za-z0-9_-]+$/.test(value.apiKey)))||(value.opaqueResponse!==undefined&&(!validOpaque(value.opaqueResponse)||value.opaqueResponse.requestUrl!==AGENTRIOT_REGISTER)))return false;
  try{const request=agentriotRegistrationRequest(value.installationId,value.name,value.tagline,value.description);if(request.requestHash!==value.requestHash)return false}catch{return false}
  if(value.apiKey!==undefined){if(!value.opaqueResponse)return false;const parsed=parseAgentRiotOpaque(value.opaqueResponse,AGENTRIOT_REGISTER,201),registration=parsed===undefined?undefined:parseAgentRiotRegistration(parsed);if(!registration||registration.apiKey!==value.apiKey||registration.agent.name!==value.name||registration.agent.slug!==value.name)return false}
  return true;
}

export function validAgentRiotPageSecret(value:unknown):value is AgentRiotPageSecret {
  if(!exactObject(value,['version','kind','operationId','requestHash','sourceHash','agentSlug','payload','createdAt'],['opaqueResponse','recoveryEvidence'])||value.version!==1||value.kind!=='agentriot_update'||typeof value.operationId!=='string'||!/^agentriot_update_[a-f0-9]{32}$/.test(value.operationId)||typeof value.requestHash!=='string'||!SHA.test(value.requestHash)||typeof value.sourceHash!=='string'||!SHA.test(value.sourceHash)||!validSlug(value.agentSlug)||!exactDate(value.createdAt)||value.opaqueResponse!==undefined&&(!validOpaque(value.opaqueResponse)||value.opaqueResponse.requestUrl!==agentriotUpdatesUrl(value.agentSlug))||value.recoveryEvidence!==undefined&&!validAgentRiotRecoveryEvidence(value.recoveryEvidence))return false;
  try{const request=agentriotUpdateRequest(value.agentSlug,value.payload as AgentRiotUpdatePayload);return request.requestHash===value.requestHash&&request.sourceHash===value.sourceHash&&samePayload(request.payload,value.payload as AgentRiotUpdatePayload)}catch{return false}
}

function validStoredUpdate(value:unknown,agentSlug:string):value is AgentRiotUpdate {
  if(!validSlug(agentSlug)||!exactObject(value,['id','slug','title','summary','whatChanged','signalType','publicLink','skillsTools','createdAt','updatedAt','publicUrl'],['isFeedVisible','visibility','moderationStatus'])||typeof value.id!=='string'||!AGENTRIOT_ID.test(value.id)||!validSlug(value.slug)||!clean(value.title,1,80)||!clean(value.summary,1,240)||!clean(value.whatChanged,1,500)||!signalType(value.signalType)||value.publicLink!==null&&!safeHttps(value.publicLink)||!validTags(value.skillsTools)||!exactDate(value.createdAt)||!exactDate(value.updatedAt)||value.publicUrl!==agentriotPublicUrl(agentSlug,value.slug))return false;
  return (value.isFeedVisible===undefined||typeof value.isFeedVisible==='boolean')&&(value.visibility===undefined||typeof value.visibility==='string')&&(value.moderationStatus===undefined||typeof value.moderationStatus==='string');
}

function validStoredProfile(value:unknown):value is AgentRiotProfile {
  if(!exactObject(value,['id','slug','name','tagline','description','installationIdHash','status','postingStatus','lastPostedAt','updates'])||typeof value.id!=='string'||!AGENTRIOT_ID.test(value.id)||!validSlug(value.slug)||!clean(value.name,1,120)||!clean(value.tagline,1,120)||!clean(value.description,1,1000)||typeof value.installationIdHash!=='string'||!SHA.test(value.installationIdHash)||typeof value.status!=='string'||typeof value.postingStatus!=='string'||value.lastPostedAt!==null&&!exactDate(value.lastPostedAt)||!Array.isArray(value.updates)||value.updates.length>200)return false;
  const slug=value.slug;return value.updates.every(update=>validStoredUpdate(update,slug));
}

export function validAgentRiotRecoveryEvidence(value:unknown):value is AgentRiotRecoveryEvidence {
  if(!exactObject(value,['version','kind','provenance','operationId','accountId','requestHash','sourceHash','intentCreatedAt','recoveredAt','candidateCount','reads','profile','update'])||value.version!==1||value.kind!=='agentriot_get_recovery'||value.provenance!=='public_profile_and_update_page'||typeof value.operationId!=='string'||!/^agentriot_update_[a-f0-9]{32}$/.test(value.operationId)||typeof value.accountId!=='string'||!/^[a-f0-9-]{36}$/i.test(value.accountId)||typeof value.requestHash!=='string'||!SHA.test(value.requestHash)||typeof value.sourceHash!=='string'||!SHA.test(value.sourceHash)||!exactDate(value.intentCreatedAt)||!exactDate(value.recoveredAt)||value.candidateCount!==1||!exactObject(value.reads,['profile','publicPage','robots'])||Object.values(value.reads).some(item=>typeof item!=='string'||item.length>4096)||!validStoredProfile(value.profile)||!validStoredUpdate(value.update,value.profile.slug))return false;
  try{for(const url of Object.values(value.reads)){const parsed=new URL(url as string);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||parsed.hash)return false}}catch{return false}
  return Buffer.byteLength(JSON.stringify(value))<=AGENTRIOT_MAX_RESPONSE_BYTES;
}

export function agentriotRecoveryEvidenceMatches(value:unknown,expected:AgentRiotRecoveryBinding):value is AgentRiotRecoveryEvidence {
  if(!validAgentRiotRecoveryEvidence(value)||value.operationId!==expected.operationId||value.accountId!==expected.accountId||value.requestHash!==expected.requestHash||value.sourceHash!==expected.sourceHash||value.intentCreatedAt!==expected.intentCreatedAt||value.profile.id!==expected.agentId||value.profile.slug!==expected.agentSlug||value.profile.name!==expected.agentName||value.update.id!==expected.updateId||value.update.slug!==expected.updateSlug||value.update.createdAt!==expected.remoteCreatedAt||value.update.publicUrl!==expected.publicUrl||!samePayload(value.update,expected.payload)||value.sourceHash!==agentriotUpdateRequest(expected.agentSlug,expected.payload).sourceHash)return false;
  const delta=Math.abs(Date.parse(expected.remoteCreatedAt)-Date.parse(expected.intentCreatedAt));if(!Number.isFinite(delta)||delta>10*60_000||Date.parse(value.recoveredAt)<Date.parse(expected.remoteCreatedAt))return false;
  const candidates=value.profile.updates.filter(update=>samePayload(update,expected.payload)&&Math.abs(Date.parse(update.createdAt)-Date.parse(expected.intentCreatedAt))<=10*60_000);if(candidates.length!==1||JSON.stringify(candidates[0])!==JSON.stringify(value.update))return false;
  return value.reads.profile===agentriotProfileUrl(expected.agentSlug)&&value.reads.publicPage===expected.publicUrl&&value.reads.robots===AGENTRIOT_ROBOTS&&expected.publicUrl===agentriotPublicUrl(expected.agentSlug,expected.updateSlug);
}

async function limitedBody(response:Response,signal:AbortSignal):Promise<Uint8Array>{
  const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>AGENTRIOT_MAX_RESPONSE_BYTES))throw Error('AgentRiot readback too large');
  if(!response.body)return new Uint8Array();const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0,complete=false;const aborted=new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(Error('AgentRiot readback aborted')),{once:true}));
  try{for(;;){const next=await Promise.race([reader.read(),aborted]);if(next.done)break;size+=next.value.length;if(size>AGENTRIOT_MAX_RESPONSE_BYTES)throw Error('AgentRiot readback too large');chunks.push(next.value)}const out=new Uint8Array(size);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length}complete=true;return out}finally{if(!complete)void reader.cancel().catch(()=>undefined);try{reader.releaseLock()}catch{}}
}

export async function readAgentRiotStatus(url:string,deps:AgentRiotDependencies={}):Promise<{status:number;value?:unknown}>{
  const controller=new AbortController(),timeout=Math.min(60_000,Math.max(100,deps.timeoutMs??25_000)),abort=()=>controller.abort();deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)controller.abort();const timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.();
  try{const request=Promise.resolve((deps.fetch??((u:string,i:RequestInit)=>fetch(u,i)))(url,{method:'GET',headers:{accept:'application/json'},signal:controller.signal,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'})),aborted=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('AgentRiot readback aborted')),{once:true})),response=await Promise.race([request,aborted]).catch(error=>{void request.then(late=>late.body?.cancel()).catch(()=>undefined);throw error});if(response.redirected||response.url&&response.url!==url)throw Error('AgentRiot readback redirected');if(response.status===404){void response.body?.cancel().catch(()=>undefined);return {status:404}}if(response.status!==200||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json'){void response.body?.cancel().catch(()=>undefined);throw Error('AgentRiot readback invalid')}const bytes=await limitedBody(response,controller.signal);return {status:200,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort)}
}

export interface AgentRiotProtocol {protocolVersion:'2026.05.16';contentRulesVersion:'2026.05.12.deterministic-v1'}
export function parseAgentRiotProtocol(value:unknown):AgentRiotProtocol|undefined {
  if(!record(value)||value.protocolVersion!=='2026.05.16'||value.openApiUrl!=='/api/openapi'||!record(value.contract)||value.contract.version!=='2026.05.16'||value.contract.minimumSupportedVersion!=='2026.05.16'||value.contract.contentRulesVersion!=='2026.05.12.deterministic-v1'||!record(value.contract.limits)||!record(value.contract.limits.update))return;
  const limits=value.contract.limits.update;if(limits.title!==80||limits.summary!==240||limits.whatChanged!==500||limits.skillsTools!==5||limits.publicLink!==2048||!Array.isArray(value.contract.signalTypes)||JSON.stringify(value.contract.signalTypes)!==JSON.stringify(AGENTRIOT_SIGNAL_TYPES))return;
  return {protocolVersion:'2026.05.16',contentRulesVersion:'2026.05.12.deterministic-v1'};
}
export async function readAgentRiotProtocol(deps:AgentRiotDependencies={}):Promise<AgentRiotProtocol|undefined>{const result=await readAgentRiotStatus(AGENTRIOT_PROTOCOL,deps);return result.status===200?parseAgentRiotProtocol(result.value):undefined}

/** Only static same-origin render assets; never allow API routes or user query data. */
export function agentriotNativeAssetUrl(value:string,type:'stylesheet'|'font'):boolean{try{const u=new URL(value);return u.origin===AGENTRIOT_ORIGIN&&!u.username&&!u.password&&!u.hash&&(!u.search||/^\?dpl=[a-f0-9]{40}$/.test(u.search))&&(type==='font'?/^\/_next\/static\/media\/[A-Za-z0-9._-]+\.woff2$/:/^\/_next\/static\/(?:css|chunks)\/[A-Za-z0-9._-]+\.css$/).test(u.pathname)&&!u.pathname.includes('..')}catch{return false}}
