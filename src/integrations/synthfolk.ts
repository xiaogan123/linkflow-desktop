import {createHash} from 'node:crypto';
import {
  drainOpenAgentChatPendingOperations,isOpenAgentChatOpaqueProgress,openAgentChatPendingOperationCount,
  openAgentChatStreamingMutation,parseOpenAgentChatOpaque,readOpenAgentChatJson,
  type OpenAgentChatDependencies,type OpenAgentChatOpaqueResponse,
} from './openagentchat';

export const SYNTHFOLK_ORIGIN='https://synthfolk.ai';
export const SYNTHFOLK_REGISTER=`${SYNTHFOLK_ORIGIN}/api/v1/agents`;
export const SYNTHFOLK_ME=`${SYNTHFOLK_ORIGIN}/api/v1/me`;
export const SYNTHFOLK_HANDLE=/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const API_KEY=/^anp_[A-Za-z0-9_-]{16,4096}$/;

export interface SynthfolkProfileDraft {handle:string;name:string;headline:string;about:string;operator:string;website:string;availability:'closed';skills:string[]}
export type SynthfolkProfile=Omit<SynthfolkProfileDraft,'operator'>&{operator:string|null;url:string;claimed:boolean}
export interface SynthfolkRegistrationIntent {version:1;accountId:string;taskId:string;handle:string;createdAt:string;requestHash:string;sourceHash:string;targetUrl:string}
export interface SynthfolkRegistrationReceipt {profile:SynthfolkProfile;apiKey:string;claimUrl:string|null}
export interface SynthfolkAccountSecret {
  version:1;kind:'synthfolk_account';mode:'generated'|'imported';operationId:string;requestHash:string;
  profileDraft:SynthfolkProfileDraft;intent?:SynthfolkRegistrationIntent;opaqueResponse?:OpenAgentChatOpaqueResponse;
  receipt?:SynthfolkRegistrationReceipt;
}
export interface SynthfolkRegistrationPersistence {
  accountId?:string;
  loadSecret?():Promise<SynthfolkAccountSecret|undefined>;
  loadPriorRaw():Promise<string|undefined>;
  persistIntent(intent:SynthfolkRegistrationIntent):Promise<void>;
  assertAuthorized(intent:SynthfolkRegistrationIntent):true;
  persistOpaque(intent:SynthfolkRegistrationIntent,response:OpenAgentChatOpaqueResponse):Promise<void>;
  persistRegistered(intent:SynthfolkRegistrationIntent,receipt:SynthfolkRegistrationReceipt):Promise<void>;
}

export const synthfolkHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const validSynthfolkApiKey=(value:unknown):value is string=>typeof value==='string'&&API_KEY.test(value);
export const drainSynthfolkPendingOperations=drainOpenAgentChatPendingOperations;
export const synthfolkPendingOperationCount=openAgentChatPendingOperationCount;
export function synthfolkProfileUrl(handle:string){if(!SYNTHFOLK_HANDLE.test(handle))throw Error('Synthfolk handle 无效');return `${SYNTHFOLK_ORIGIN}/agents/${handle}`}
export function synthfolkProfileApi(handle:string){if(!SYNTHFOLK_HANDLE.test(handle))throw Error('Synthfolk handle 无效');return `${SYNTHFOLK_ORIGIN}/api/v1/profiles/${handle}`}
export function exactSynthfolkStylesheetUrl(value:string){try{const url=new URL(value);return url.origin===SYNTHFOLK_ORIGIN&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&/^\/_next\/static\/immutable\/chunks\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.css$/.test(url.pathname)}catch{return false}}

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:unknown,required:string[],optional:string[]=[]):value is Record<string,unknown>=>record(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
const text=(value:unknown,min:number,max:number):value is string=>typeof value==='string'&&value.length>=min&&value.length<=max&&value===value.trim()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const date=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value));
function httpsUrl(value:unknown){if(typeof value!=='string'||value.length>2048)return false;try{const parsed=new URL(value);return parsed.protocol==='https:'&&!parsed.username&&!parsed.password&&!parsed.port&&!parsed.hash&&parsed.hostname.includes('.')&&!parsed.hostname.endsWith('.local')&&!/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)}catch{return false}}

export function synthfolkRegistrationRequest(value:unknown,targetUrl:string){
  if(!exact(value,['about','availability','handle','headline','name','operator','skills','website'])||typeof value.handle!=='string'||!SYNTHFOLK_HANDLE.test(value.handle)||!text(value.name,1,80)||!text(value.headline,1,160)||!text(value.about,40,4000)||!text(value.operator,1,120)||!httpsUrl(value.website)||value.website!==targetUrl||value.availability!=='closed'||!Array.isArray(value.skills)||!value.skills.length||value.skills.length>30||value.skills.some(item=>!text(item,1,40))||new Set(value.skills).size!==value.skills.length)throw Error('Synthfolk 仅接受已审核的真实 AI 项目资料；目标链接必须一致');
  const draft=value as unknown as SynthfolkProfileDraft;
  const payload:SynthfolkProfileDraft={handle:draft.handle,name:draft.name,headline:draft.headline,about:draft.about,operator:draft.operator,website:draft.website,availability:'closed',skills:[...draft.skills]};
  const body=JSON.stringify(payload);return {payload,body,sourceHash:synthfolkHash(body),requestHash:synthfolkHash(`POST\n${SYNTHFOLK_REGISTER}\ncontent-type:application/json\n\n${body}`)};
}

function operatorName(value:unknown):string|null|undefined{
  if(value===null)return null;
  if(!record(value)||!text(value.name,1,120))return;
  if(value.url!==undefined&&value.url!==null&&!httpsUrl(value.url))return;
  return value.name;
}
export function parseSynthfolkProfile(value:unknown):SynthfolkProfile|undefined{
  if(!record(value)||value.kind!=='agent'||typeof value.handle!=='string'||!SYNTHFOLK_HANDLE.test(value.handle)||!text(value.name,1,80)||!text(value.headline,1,160)||!text(value.about,1,4000)||!httpsUrl(value.website)||!['open','busy','closed'].includes(String(value.availability))||value.url!==synthfolkProfileUrl(value.handle)||!record(value.agent)||typeof value.agent.claimed!=='boolean'||!Array.isArray(value.skills))return;
  const operator=operatorName(value.operator);if(operator===undefined||value.agent.claimed!==(operator!==null))return;
  const skills=value.skills.map(skill=>typeof skill==='string'?skill:record(skill)?skill.name:undefined);if(skills.some(skill=>!text(skill,1,40))||new Set(skills).size!==skills.length)return;
  return {handle:value.handle,name:value.name,headline:value.headline,about:value.about,operator,website:value.website as string,availability:value.availability as 'closed',url:value.url as string,claimed:value.agent.claimed,skills:skills as string[]};
}
export function synthfolkProfileMatches(profile:SynthfolkProfile,draft:SynthfolkProfileDraft){return profile.handle===draft.handle&&profile.name===draft.name&&profile.headline===draft.headline&&profile.about===draft.about&&(profile.claimed?profile.operator===draft.operator:profile.operator===null)&&profile.website===draft.website&&profile.availability===draft.availability&&profile.url===synthfolkProfileUrl(draft.handle)&&JSON.stringify([...profile.skills].sort())===JSON.stringify([...draft.skills].sort())}
export function parseSynthfolkRegistration(value:unknown,draft:SynthfolkProfileDraft):SynthfolkRegistrationReceipt|undefined{
  if(!record(value)||!validSynthfolkApiKey(value.api_key)||value.profile_url!==synthfolkProfileUrl(draft.handle))return;
  const profile=parseSynthfolkProfile(value.agent);if(!profile||!synthfolkProfileMatches(profile,draft))return;
  let claimUrl:null|string=null;
  if(value.claim_url!==null&&value.claim_url!==undefined){if(typeof value.claim_url!=='string'||value.claim_url.length>4096)return;try{const parsed=new URL(value.claim_url);if(parsed.origin!==SYNTHFOLK_ORIGIN||parsed.username||parsed.password||parsed.hash||!/^\/claim(?:\/|$)/.test(parsed.pathname))return;claimUrl=parsed.href}catch{return}}
  return {profile,apiKey:value.api_key,claimUrl};
}
export function validSynthfolkIntent(value:unknown):value is SynthfolkRegistrationIntent{return exact(value,['version','accountId','taskId','handle','createdAt','requestHash','sourceHash','targetUrl'])&&value.version===1&&typeof value.accountId==='string'&&UUID.test(value.accountId)&&typeof value.taskId==='string'&&UUID.test(value.taskId)&&typeof value.handle==='string'&&SYNTHFOLK_HANDLE.test(value.handle)&&date(value.createdAt)&&typeof value.requestHash==='string'&&HASH.test(value.requestHash)&&typeof value.sourceHash==='string'&&HASH.test(value.sourceHash)&&httpsUrl(value.targetUrl)}
export function validSynthfolkOpaque(value:unknown):value is OpenAgentChatOpaqueResponse{
  if(!record(value)||value.version!==1||!date(value.capturedAt)||value.requestUrl!==SYNTHFOLK_REGISTER||typeof value.status!=='number'||!Number.isSafeInteger(value.status)||typeof value.contentType!=='string'||typeof value.responseUrl!=='string'||typeof value.redirected!=='boolean'||typeof value.responseType!=='string'||!Array.isArray(value.headers)||typeof value.bodyBase64!=='string'||typeof value.bodySha256!=='string'||!HASH.test(value.bodySha256)||typeof value.bodyComplete!=='boolean')return false;
  try{const bytes=Buffer.from(value.bodyBase64,'base64');return bytes.length<=512*1024&&bytes.toString('base64')===value.bodyBase64&&synthfolkHash(bytes)===value.bodySha256}catch{return false}
}
export function validSynthfolkAccountSecret(value:unknown):value is SynthfolkAccountSecret{
  if(!exact(value,['version','kind','mode','operationId','requestHash','profileDraft'],['intent','opaqueResponse','receipt'])||value.version!==1||value.kind!=='synthfolk_account'||!['generated','imported'].includes(String(value.mode))||typeof value.operationId!=='string'||!/^synthfolk_(?:register|import)_[a-f0-9]{32}$/.test(value.operationId)||typeof value.requestHash!=='string'||!HASH.test(value.requestHash))return false;
  let draft:SynthfolkProfileDraft,request:ReturnType<typeof synthfolkRegistrationRequest>;try{request=synthfolkRegistrationRequest(value.profileDraft,(value.profileDraft as SynthfolkProfileDraft).website);draft=request.payload}catch{return false}
  if(value.opaqueResponse!==undefined&&!validSynthfolkOpaque(value.opaqueResponse))return false;
  let receipt:SynthfolkRegistrationReceipt|undefined;
  if(value.receipt!==undefined){
    if(!record(value.receipt)||!validSynthfolkApiKey(value.receipt.apiKey)||!record(value.receipt.profile))return false;
    receipt=value.receipt as unknown as SynthfolkRegistrationReceipt;const profile=receipt.profile;
    if(!parseSynthfolkRegistration({agent:{...profile,kind:'agent',operator:profile.operator===null?null:{name:profile.operator},agent:{claimed:profile.claimed}},api_key:receipt.apiKey,profile_url:profile.url,claim_url:receipt.claimUrl},draft))return false;
  }
  if(value.mode==='generated'){
    if(!/^synthfolk_register_[a-f0-9]{32}$/.test(value.operationId)||!validSynthfolkIntent(value.intent)||value.intent.accountId.replace(/-/g,'').toLowerCase()!==value.operationId.slice('synthfolk_register_'.length)||value.intent.handle!==draft.handle||value.intent.requestHash!==request.requestHash||value.intent.requestHash!==value.requestHash||value.intent.sourceHash!==request.sourceHash||value.intent.targetUrl!==draft.website)return false;
    if(receipt){
      if(!value.opaqueResponse||value.opaqueResponse.status!==201||value.opaqueResponse.bodyComplete!==true)return false;
      const original=parseSynthfolkRegistration(parseOpenAgentChatOpaque(value.opaqueResponse,SYNTHFOLK_REGISTER,201),draft);if(!original||!same(original,receipt))return false;
    }
  }else if(!/^synthfolk_import_[a-f0-9]{32}$/.test(value.operationId)||value.intent!==undefined||value.opaqueResponse!==undefined||!receipt||receipt.claimUrl!==null||receipt.profile.claimed!==true||receipt.profile.operator===null)return false;
  return true;
}

export async function registerSynthfolkProfile(input:{accountId:string;taskId:string;draft:SynthfolkProfileDraft;targetUrl:string},persistence:SynthfolkRegistrationPersistence,deps:OpenAgentChatDependencies={}){
  if(!UUID.test(input.accountId)||!UUID.test(input.taskId)||persistence.accountId!==undefined&&persistence.accountId!==input.accountId)throw Error('Synthfolk 固定身份无效');
  const request=synthfolkRegistrationRequest(input.draft,input.targetUrl);
  // Any prior encrypted journal permanently blocks a second public registration.
  if(await persistence.loadPriorRaw()!==undefined)return {status:'prior_intent' as const};
  const intent:SynthfolkRegistrationIntent={version:1,accountId:input.accountId,taskId:input.taskId,handle:input.draft.handle,createdAt:(deps.now?.()??new Date()).toISOString(),requestHash:request.requestHash,sourceHash:request.sourceHash,targetUrl:input.targetUrl};
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started' as const}}
  const opaque=await openAgentChatStreamingMutation(SYNTHFOLK_REGISTER,{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:request.body},value=>persistence.persistOpaque(intent,value),()=>persistence.assertAuthorized(intent),deps);
  if(!opaque)return {status:'unknown' as const,intent};
  const receipt=parseSynthfolkRegistration(parseOpenAgentChatOpaque(opaque,SYNTHFOLK_REGISTER,201),input.draft);
  if(!receipt)return {status:'unknown' as const,intent};
  try{await persistence.persistRegistered(intent,receipt);return {status:'registered' as const,intent,profile:receipt.profile}}
  catch{return {status:'persistence_unknown' as const,intent}}
}

export async function readSynthfolkOwnProfile(draft:SynthfolkProfileDraft,key:string,deps:OpenAgentChatDependencies={}){
  if(!validSynthfolkApiKey(key))throw Error('Synthfolk API key 无效');
  const own=parseSynthfolkProfile(await readOpenAgentChatJson(SYNTHFOLK_ME,key,deps));
  const publicProfile=parseSynthfolkProfile(await readOpenAgentChatJson(synthfolkProfileApi(draft.handle),undefined,deps));
  if(!own||!publicProfile||!synthfolkProfileMatches(own,draft)||!synthfolkProfileMatches(publicProfile,draft)||JSON.stringify(own)!==JSON.stringify(publicProfile))throw Error('Synthfolk 账号及公开资料不匹配');
  return publicProfile;
}
export async function readSynthfolkPublicProfile(handle:string,deps:OpenAgentChatDependencies={}){return parseSynthfolkProfile(await readOpenAgentChatJson(synthfolkProfileApi(handle),undefined,deps))}

export const synthfolkTesting={isOpenAgentChatOpaqueProgress};
