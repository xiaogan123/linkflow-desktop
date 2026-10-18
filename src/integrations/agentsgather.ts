import {createHash} from 'node:crypto';
import {openAgentChatStreamingMutation,parseOpenAgentChatOpaque,readOpenAgentChatJson,validOpenAgentChatOpaqueResponse,type OpenAgentChatDependencies,type OpenAgentChatOpaqueResponse,type OpenAgentChatNativeRequest,type OpenAgentChatRenderHooks} from './openagentchat';

export const AGENTSGATHER_ORIGIN='https://agentsgather.org';
export const AGENTSGATHER_CREATE=`${AGENTSGATHER_ORIGIN}/api/v1/anonymous.create`;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const id=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
function unicode(value:unknown):value is string {
  return typeof value==='string'&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    &&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
export interface AgentsGatherDraft {title:string;body:string}
export interface AgentsGatherIntent {
  version:1;taskId:string;requestId:string;sourceHash:string;requestHash:string;createdAt:string;
}
export interface AgentsGatherReceipt extends AgentsGatherIntent {postId:number;publicUrl:string;readUrl:string;postReadUrl:string}
export interface AgentsGatherPublicationSecret {version:1;kind:'agentsgather_publication';intent:AgentsGatherIntent;opaqueResponse?:OpenAgentChatOpaqueResponse;receipt?:AgentsGatherReceipt}
export interface AgentsGatherRenderedPage {url:string;documentTitle:string;headings:Array<{text:string;visible:boolean}>;candidates:Array<{selector:string;html:string;text:string;allTextVisible:boolean;links:Array<{href:string;rel:string[];text:string;visible:boolean}>}>;robots:Array<{name:string;content:string}>;canonicals:string[];ogTitles:string[];ogUrls:string[];jsonLd:unknown[];hasRefresh:boolean;hasPasswordGate:boolean;hasLoginGate:boolean;responseRobots:string[];responseLinks:string[];responseStatus:number;responseMediaType:string;responseBodyBytes:number;responseEncodedBodyBytes:number;nativeRequests:OpenAgentChatNativeRequest[];occlusionClear:true}
export interface AgentsGatherDependencies extends OpenAgentChatDependencies {renderPage?:(url:string,signal:AbortSignal,hooks?:OpenAgentChatRenderHooks)=>Promise<AgentsGatherRenderedPage>}
export interface AgentsGatherPersistence {
  loadPriorRaw():Promise<string|undefined>;
  persistIntent(intent:AgentsGatherIntent):Promise<void>;
  assertAuthorized(intent:AgentsGatherIntent):true;
  persistOpaque(intent:AgentsGatherIntent,response:OpenAgentChatOpaqueResponse):Promise<void>;
  persistReceipt(intent:AgentsGatherIntent,receipt:AgentsGatherReceipt):Promise<void>;
}
export function agentsGatherPublicUrl(postId:number){if(!id(postId))throw Error('Agents Gather 页面编号无效');return `${AGENTSGATHER_ORIGIN}/threads/${postId}`}
export function agentsGatherPostApi(postId:number){if(!id(postId))throw Error('Agents Gather 页面编号无效');return `${AGENTSGATHER_ORIGIN}/api/v1/post?id=${postId}`}
export function agentsGatherThreadApi(postId:number){if(!id(postId))throw Error('Agents Gather 页面编号无效');return `${AGENTSGATHER_ORIGIN}/api/v1/thread?id=${postId}`}
export function agentsGatherRequest(draft:AgentsGatherDraft,requestId:string){
  if(!record(draft)||Object.keys(draft).sort().join(',')!=='body,title'||!unicode(draft.title)||!draft.title.trim()||draft.title!==draft.title.trim()||/[\r\n\t]/.test(draft.title)||Buffer.byteLength(draft.title)>200||!unicode(draft.body)||!draft.body.trim()||[...draft.title,...draft.body].length>5000||!UUID.test(requestId))throw Error('Agents Gather 标题或正文超出限制，或原请求编号无效');
  const payload={title:draft.title,body:draft.body,request_id:requestId},body=JSON.stringify(payload);
  return {payload,body,sourceHash:sha(JSON.stringify({title:draft.title,body:draft.body})),requestHash:sha(`POST\n${AGENTSGATHER_CREATE}\ncontent-type:application/json\n\n${body}`)};
}
export function validAgentsGatherIntent(value:unknown):value is AgentsGatherIntent {
  if(!record(value)||value.version!==1||typeof value.taskId!=='string'||!UUID.test(value.taskId)||typeof value.requestId!=='string'||!UUID.test(value.requestId)||typeof value.sourceHash!=='string'||!SHA.test(value.sourceHash)||typeof value.requestHash!=='string'||!SHA.test(value.requestHash)||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt)))return false;
  return new Date(value.createdAt).toISOString()===value.createdAt;
}
export function parseAgentsGatherReceipt(value:unknown,intent:AgentsGatherIntent):AgentsGatherReceipt|undefined {
  if(!validAgentsGatherIntent(intent)||!record(value)||value.ok!==true||!id(value.id)||value.anonymous!==true||value.request_id!==intent.requestId)return;
  // This adapter creates only top-level discussions. Never accept a reply or a
  // caller-controlled readback URL from the server as the intended publication.
  // The official API returns root-relative links; derive all request URLs from
  // the fixed origin and ID, accepting only those exact forms or absolute URLs.
  const exactUrl=(actual:unknown,expected:string)=>actual===expected||actual===expected.slice(AGENTSGATHER_ORIGIN.length);
  if(value.thread_id!==undefined&&value.thread_id!==value.id||!exactUrl(value.url,agentsGatherPublicUrl(value.id))||!exactUrl(value.read_url,agentsGatherThreadApi(value.id))||!exactUrl(value.post_read_url,agentsGatherPostApi(value.id)))return;
  return {...intent,postId:value.id,publicUrl:agentsGatherPublicUrl(value.id),readUrl:agentsGatherThreadApi(value.id),postReadUrl:agentsGatherPostApi(value.id)};
}
export function parseAgentsGatherAnonymousPost(value:unknown,receipt:AgentsGatherReceipt,draft:AgentsGatherDraft){
  if(!record(value)||value.ok!==true||!record(value.post))return;
  const p=value.post;
  if(p.id!==receipt.postId||p.thread_id!==undefined||p.author_id!==0||p.anonymous!==true||p.author!=='Anonymous'||p.kind!=='discussion'||p.title!==draft.title||p.body!==draft.body||p.url!==`/threads/${receipt.postId}`
    ||!id(p.created)||!id(p.updated)||!id(p.activity)||p.updated<p.created||p.activity<p.updated
    ||typeof p.score!=='number'||!Number.isSafeInteger(p.score)||typeof p.locked!=='boolean'||!unicode(p.tags)||p.tags.length>2000
    ||typeof p.replies!=='number'||!Number.isSafeInteger(p.replies)||p.replies<0
    ||!Number.isFinite(new Date(p.created*1000).getTime())||!Number.isFinite(new Date(p.updated*1000).getTime())||!Number.isFinite(new Date(p.activity*1000).getTime()))return;
  return {postId:receipt.postId,publicUrl:receipt.publicUrl,title:draft.title,body:draft.body,createdAt:new Date(p.created*1000).toISOString(),updatedAt:new Date(p.updated*1000).toISOString()};
}
/** No POST retry, even though the service documents idempotent request IDs. */
export async function createAgentsGatherDiscussion(input:{taskId:string;requestId:string;draft:AgentsGatherDraft},persistence:AgentsGatherPersistence,deps:OpenAgentChatDependencies={}){
  if(!UUID.test(input.taskId))throw Error('Agents Gather 任务编号无效');
  const request=agentsGatherRequest(input.draft,input.requestId);
  // Corrupt/partial prior evidence also blocks creating another public post.
  if(await persistence.loadPriorRaw()!==undefined)return {status:'prior_intent' as const};
  const intent:AgentsGatherIntent={version:1,taskId:input.taskId,requestId:input.requestId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started' as const}}
  const opaque=await openAgentChatStreamingMutation(AGENTSGATHER_CREATE,{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:request.body},response=>persistence.persistOpaque(intent,response),()=>persistence.assertAuthorized(intent),deps);
  const receipt=opaque&&parseAgentsGatherReceipt(parseOpenAgentChatOpaque(opaque,AGENTSGATHER_CREATE,200),intent);
  if(!receipt)return {status:'unknown' as const,intent};
  try{await persistence.persistReceipt(intent,receipt);return {status:'created' as const,receipt}}
  catch{return {status:'persistence_unknown' as const,intent}}
}
export async function readAgentsGatherDiscussion(receipt:AgentsGatherReceipt,draft:AgentsGatherDraft,deps:OpenAgentChatDependencies={}){
  const request=agentsGatherRequest(draft,receipt.requestId);
  if(!validAgentsGatherIntent(receipt)||request.sourceHash!==receipt.sourceHash||request.requestHash!==receipt.requestHash||receipt.publicUrl!==agentsGatherPublicUrl(receipt.postId)||receipt.readUrl!==agentsGatherThreadApi(receipt.postId)||receipt.postReadUrl!==agentsGatherPostApi(receipt.postId))throw Error('Agents Gather 原稿与原始回执不一致');
  return parseAgentsGatherAnonymousPost(await readOpenAgentChatJson(agentsGatherPostApi(receipt.postId),undefined,deps),receipt,draft);
}

export function validAgentsGatherReceipt(value:unknown):value is AgentsGatherReceipt {
  if(!record(value)||!validAgentsGatherIntent(value)||!id(value.postId)||value.publicUrl!==agentsGatherPublicUrl(value.postId)||value.readUrl!==agentsGatherThreadApi(value.postId)||value.postReadUrl!==agentsGatherPostApi(value.postId))return false;
  return true;
}
export function validAgentsGatherPublicationSecret(value:unknown):value is AgentsGatherPublicationSecret {
  if(!record(value)||Object.keys(value).some(key=>!['version','kind','intent','opaqueResponse','receipt'].includes(key))||value.version!==1||value.kind!=='agentsgather_publication'||!validAgentsGatherIntent(value.intent))return false;
  if(value.opaqueResponse!==undefined&&(!validOpenAgentChatOpaqueResponse(value.opaqueResponse)||value.opaqueResponse.requestUrl!==AGENTSGATHER_CREATE))return false;
  if(value.receipt!==undefined&&(!validAgentsGatherReceipt(value.receipt)||value.receipt.version!==value.intent.version||value.receipt.taskId!==value.intent.taskId||value.receipt.requestId!==value.intent.requestId||value.receipt.sourceHash!==value.intent.sourceHash||value.receipt.requestHash!==value.intent.requestHash||value.receipt.createdAt!==value.intent.createdAt))return false;
  if(value.receipt){
    if(!value.opaqueResponse)return false;
    const parsed=parseAgentsGatherReceipt(parseOpenAgentChatOpaque(value.opaqueResponse,AGENTSGATHER_CREATE,200),value.intent);
    if(!parsed||JSON.stringify(parsed)!==JSON.stringify(value.receipt))return false;
  }
  return true;
}
