import {createHash} from 'node:crypto';
import {openAgentChatStreamingMutation,parseOpenAgentChatOpaque,readOpenAgentChatJson,type OpenAgentChatDependencies,type OpenAgentChatOpaqueResponse} from './openagentchat';

export const AGENTBOARD_ORIGIN='https://www.agentboard.ai';
export const AGENTBOARD_FIRST_THREAD=`${AGENTBOARD_ORIGIN}/api/threads`;
export const AGENTBOARD_ME=`${AGENTBOARD_ORIGIN}/api/me`;
export const AGENTBOARD_BOARDS=`${AGENTBOARD_ORIGIN}/api/boards`;
const THREAD=/^thr_[a-f0-9]{16}$/;
const AGENT=/^agt_[a-f0-9]{16}$/;
const BOARD=/^brd_[a-f0-9]{16}$/;
const HANDLE=/^[a-z0-9][a-z0-9_-]{1,79}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,min:number,max:number):v is string=>typeof v==='string'&&v.length>=min&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const line=(v:unknown,min:number,max:number):v is string=>text(v,min,max)&&v===v.trim()&&!/[\r\n\t]/.test(v);
const date=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v));
export const agentboardHash=(value:string)=>createHash('sha256').update(value).digest('hex');
export function agentboardThreadUrl(id:string){if(!THREAD.test(id))throw Error('Agentboard thread ID 无效');return `${AGENTBOARD_ORIGIN}/t/${id}`}
export function agentboardThreadApi(id:string){if(!THREAD.test(id))throw Error('Agentboard thread ID 无效');return `${AGENTBOARD_FIRST_THREAD}/${id}`}
export function agentboardAgentUrl(handle:string){if(!HANDLE.test(handle))throw Error('Agentboard handle 无效');return `${AGENTBOARD_ORIGIN}/a/${handle}`}
export function agentboardBoardApi(slug:string){if(!/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug))throw Error('Agentboard board 无效');return `${AGENTBOARD_ORIGIN}/api/boards/${slug}`}
export function agentboardBoardThreadsApi(slug:string){return `${agentboardBoardApi(slug)}/threads`}
export function validAgentboardCredential(value:unknown):value is string{return typeof value==='string'&&/^agb_[a-f0-9]{32,512}$/.test(value)}
export interface AgentboardAgentDraft{name:string;description:string;homepage:string;operatorName:string}
export interface AgentboardBoard{id:string;slug:string;title:string;description:string|null;publicUrl:string;apiUrl:string}
export interface AgentboardFirstDraft{agent:AgentboardAgentDraft;board:'introductions';title:string;body:string}
export interface AgentboardThread{id:string;boardId:string;agentId:string;title:string;body:string;createdAt:string;publicUrl:string;apiUrl:string}
export interface AgentboardAgent{id:string;handle:string;name:string;description:string;homepage:string;operatorName:string;publicUrl:string}
export interface AgentboardFirstReceipt{credential:string;handle:string;name:string;agentUrl:string;thread:AgentboardThread}
export interface AgentboardFirstIntent{version:1;accountId:string;taskId:string;requestKey:string;requestHash:string;sourceHash:string;targetUrl:string;createdAt:string}
export interface AgentboardFirstPersistence{
  loadPriorRaw():Promise<string|undefined>;
  persistIntent(intent:AgentboardFirstIntent):Promise<void>;
  assertAuthorized(intent:AgentboardFirstIntent):true;
  persistOpaque(intent:AgentboardFirstIntent,response:OpenAgentChatOpaqueResponse):Promise<void>;
  persistCreated(intent:AgentboardFirstIntent,receipt:AgentboardFirstReceipt):Promise<void>;
}
function targetUrl(value:unknown){if(typeof value!=='string'||value.length>2048)return false;try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash&&u.hostname.includes('.')&&!u.hostname.endsWith('.local')&&!/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)}catch{return false}}
export function agentboardFirstRequest(value:unknown,target:string,requestKey:string){
  if(!record(value)||Object.keys(value).sort().join(',')!=='agent,board,body,title'||!record(value.agent)||Object.keys(value.agent).sort().join(',')!=='description,homepage,name,operatorName'||!line(value.agent.name,2,80)||!line(value.agent.description,1,1000)||!line(value.agent.operatorName,1,120)||!targetUrl(value.agent.homepage)||!targetUrl(target)||value.board!=='introductions'||!line(value.title,1,200)||!text(value.body,40,20_000)||!value.body.includes(target)||!/^[A-Za-z0-9_.:-]{8,128}$/.test(requestKey))throw Error('Agentboard 首帖必须使用已审核的单一真实项目资料和固定请求键');
  const draft=value as unknown as AgentboardFirstDraft;
  const payload:AgentboardFirstDraft={agent:{name:draft.agent.name,description:draft.agent.description,homepage:draft.agent.homepage,operatorName:draft.agent.operatorName},board:'introductions',title:draft.title,body:draft.body};
  const body=JSON.stringify(payload);
  return {payload,body,sourceHash:agentboardHash(body),requestHash:agentboardHash(`POST\n${AGENTBOARD_FIRST_THREAD}\ncontent-type:application/json\nidempotency-key:${requestKey}\n\n${body}`)};
}
export function parseAgentboardThread(value:unknown):AgentboardThread|undefined{
  const t=record(value)&&record(value.thread)?value.thread:value;
  if(!record(t)||typeof t.id!=='string'||!THREAD.test(t.id)||typeof t.boardId!=='string'||!BOARD.test(t.boardId)||typeof t.agentId!=='string'||!AGENT.test(t.agentId)||!line(t.title,1,200)||!text(t.body,1,20_000)||!date(t.createdAt)||t.url!==agentboardThreadUrl(t.id)||t.apiUrl!==agentboardThreadApi(t.id))return;
  return {id:t.id,boardId:t.boardId,agentId:t.agentId,title:t.title,body:t.body,createdAt:new Date(t.createdAt).toISOString(),publicUrl:t.url as string,apiUrl:t.apiUrl as string};
}
export function parseAgentboardAgent(value:unknown):AgentboardAgent|undefined{
  const a=record(value)&&record(value.agent)?value.agent:value;
  if(!record(a)||typeof a.id!=='string'||!AGENT.test(a.id)||typeof a.handle!=='string'||!HANDLE.test(a.handle)||!line(a.name,2,80)||!line(a.description,1,1000)||!targetUrl(a.homepage)||!line(a.operatorName,1,120)||a.status!=='active'||a.url!==agentboardAgentUrl(a.handle))return;
  return {id:a.id,handle:a.handle,name:a.name,description:a.description,homepage:a.homepage as string,operatorName:a.operatorName,publicUrl:a.url as string};
}
export function parseAgentboardBoard(value:unknown):AgentboardBoard|undefined{
  const b=record(value)&&record(value.board)?value.board:value;
  if(!record(b)||typeof b.id!=='string'||!BOARD.test(b.id)||typeof b.slug!=='string'||!/^[a-z0-9][a-z0-9-]{1,79}$/.test(b.slug)||!line(b.title,1,200)||b.description!==null&&!text(b.description,0,2000)||b.url!==`${AGENTBOARD_ORIGIN}/b/${b.slug}`||b.apiUrl!==agentboardBoardThreadsApi(b.slug))return;
  return {id:b.id,slug:b.slug,title:b.title,description:b.description as string|null,publicUrl:b.url as string,apiUrl:b.apiUrl as string};
}
export function parseAgentboardBoards(value:unknown):AgentboardBoard[]|undefined{
  if(!record(value)||!Array.isArray(value.boards)||value.boards.length>1000)return;
  const boards=value.boards.map(parseAgentboardBoard);if(boards.some(board=>!board))return;
  const out=boards as AgentboardBoard[];if(new Set(out.map(board=>board.slug)).size!==out.length||new Set(out.map(board=>board.id)).size!==out.length)return;return out;
}
export async function readAgentboardBoard(slug:string,deps:OpenAgentChatDependencies={}):Promise<AgentboardBoard>{const board=parseAgentboardBoard(await readOpenAgentChatJson(agentboardBoardApi(slug),undefined,deps));if(!board||board.slug!==slug)throw Error('Agentboard 版块读回未匹配');return board}
export async function readAgentboardBoards(deps:OpenAgentChatDependencies={}):Promise<AgentboardBoard[]>{const boards=parseAgentboardBoards(await readOpenAgentChatJson(AGENTBOARD_BOARDS,undefined,deps));if(!boards)throw Error('Agentboard 版块列表无效');return boards}
export function parseAgentboardFirst(value:unknown,draft:AgentboardFirstDraft,boardId:string):AgentboardFirstReceipt|undefined{
  if(!record(value)||!validAgentboardCredential(value.credential)||!record(value.agent)||typeof value.agent.handle!=='string'||!HANDLE.test(value.agent.handle)||value.agent.name!==draft.agent.name||value.agent.url!==agentboardAgentUrl(value.agent.handle))return;
  const thread=parseAgentboardThread(value);
  if(!BOARD.test(boardId)||!thread||thread.boardId!==boardId||thread.title!==draft.title||thread.body!==draft.body)return;
  // The atomic response documents handle/name/url, not agent.id. Ownership is
  // established separately through authenticated /api/me and thread.agentId.
  return {credential:value.credential,handle:value.agent.handle,name:value.agent.name as string,agentUrl:value.agent.url as string,thread};
}
export async function createAgentboardFirst(input:{accountId:string;taskId:string;requestKey:string;targetUrl:string;boardId:string;draft:AgentboardFirstDraft},persistence:AgentboardFirstPersistence,deps:OpenAgentChatDependencies={}){
  if(!UUID.test(input.accountId)||!UUID.test(input.taskId)||!BOARD.test(input.boardId))throw Error('Agentboard 固定身份或版块无效');
  const request=agentboardFirstRequest(input.draft,input.targetUrl,input.requestKey);
  // Even corrupt prior intent blocks a second atomic registration. A platform
  // replay rotates its credential; this client never silently replays it.
  if(await persistence.loadPriorRaw()!==undefined)return {status:'prior_intent' as const};
  const intent:AgentboardFirstIntent={version:1,accountId:input.accountId,taskId:input.taskId,requestKey:input.requestKey,requestHash:request.requestHash,sourceHash:request.sourceHash,targetUrl:input.targetUrl,createdAt:(deps.now?.()??new Date()).toISOString()};
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started' as const}};
  const opaque=await openAgentChatStreamingMutation(AGENTBOARD_FIRST_THREAD,{method:'POST',headers:{accept:'application/json','content-type':'application/json','idempotency-key':input.requestKey},body:request.body},v=>persistence.persistOpaque(intent,v),()=>persistence.assertAuthorized(intent),deps);
  if(!opaque)return {status:'unknown' as const,intent};
  const parsed=opaque.status===200||opaque.status===201?parseOpenAgentChatOpaque(opaque,AGENTBOARD_FIRST_THREAD,opaque.status):undefined;
  const receipt=parseAgentboardFirst(parsed,input.draft,input.boardId);
  if(!receipt)return {status:'unknown' as const,intent};
  try{await persistence.persistCreated(intent,receipt);return {status:'created' as const,intent,thread:receipt.thread,handle:receipt.handle}}
  catch{return {status:'persistence_unknown' as const,intent}}
}
export async function readAgentboardOwnedThread(receipt:AgentboardFirstReceipt,draft:AgentboardFirstDraft,boardId:string,deps:OpenAgentChatDependencies={}){
  if(!validAgentboardCredential(receipt.credential)||!THREAD.test(receipt.thread.id))throw Error('Agentboard 私密回执无效');
  const own=parseAgentboardAgent(await readOpenAgentChatJson(AGENTBOARD_ME,receipt.credential,deps));
  if(!own||own.handle!==receipt.handle||own.publicUrl!==receipt.agentUrl||own.name!==draft.agent.name||own.description!==draft.agent.description||own.homepage!==draft.agent.homepage||own.operatorName!==draft.agent.operatorName||own.id!==receipt.thread.agentId)throw Error('Agentboard 原身份未匹配');
  const thread=parseAgentboardThread(await readOpenAgentChatJson(agentboardThreadApi(receipt.thread.id),undefined,deps));
  if(!thread||thread.agentId!==own.id||thread.boardId!==boardId||thread.title!==draft.title||thread.body!==draft.body||JSON.stringify(thread)!==JSON.stringify(receipt.thread))throw Error('Agentboard 原首帖回读未匹配');
  return {agent:own,thread};
}

// An existing project identity uses the authenticated route. It never creates
// another identity or repeats its introductory thread for a different site.
export interface AgentboardDiscussionDraft {board:string;title:string;body:string}
export interface AgentboardDiscussionIntent {version:1;accountId:string;agentId:string;taskId:string;requestKey:string;requestHash:string;sourceHash:string;targetUrl:string;createdAt:string;board:string}
export interface AgentboardDiscussionPersistence {
  loadPriorRaw():Promise<string|undefined>;
  persistIntent(intent:AgentboardDiscussionIntent):Promise<void>;
  assertAuthorized(intent:AgentboardDiscussionIntent):true;
  persistOpaque(intent:AgentboardDiscussionIntent,response:OpenAgentChatOpaqueResponse):Promise<void>;
  persistCreated(intent:AgentboardDiscussionIntent,thread:AgentboardThread):Promise<void>;
}
export function agentboardDiscussionRequest(value:unknown,target:string,requestKey:string){
  if(!record(value)||Object.keys(value).sort().join(',')!=='board,body,title'||typeof value.board!=='string'||value.board==='introductions'||!/^[a-z0-9][a-z0-9-]{1,79}$/.test(value.board)||!line(value.title,1,200)||!text(value.body,40,20_000)||!targetUrl(target)||!value.body.includes(target)||!/^[A-Za-z0-9_.:-]{8,128}$/.test(requestKey))throw Error('Agentboard 后续讨论需要独立审核的相关内容，不能重复项目介绍');
  const draft=value as unknown as AgentboardDiscussionDraft,url=agentboardBoardThreadsApi(draft.board),body=JSON.stringify({title:draft.title,body:draft.body});
  return {url,body,sourceHash:agentboardHash(body),requestHash:agentboardHash(`POST\n${url}\ncontent-type:application/json\nidempotency-key:${requestKey}\n\n${body}`)};
}
export async function createAgentboardDiscussion(input:{accountId:string;taskId:string;requestKey:string;targetUrl:string;boardId:string;agent:AgentboardAgent;credential:string;draft:AgentboardDiscussionDraft},persistence:AgentboardDiscussionPersistence,deps:OpenAgentChatDependencies={}){
  if(!UUID.test(input.accountId)||!UUID.test(input.taskId)||!BOARD.test(input.boardId)||!validAgentboardCredential(input.credential)||!parseAgentboardAgent({...input.agent,status:'active',url:input.agent.publicUrl}))throw Error('Agentboard 原账号或私密凭据无效');
  const request=agentboardDiscussionRequest(input.draft,input.targetUrl,input.requestKey);
  if(await persistence.loadPriorRaw()!==undefined)return {status:'prior_intent' as const};
  // Reconfirm the same identity before saving the one-shot mutation intent.
  const owner=parseAgentboardAgent(await readOpenAgentChatJson(AGENTBOARD_ME,input.credential,deps));
  if(!owner||JSON.stringify(owner)!==JSON.stringify(input.agent))throw Error('Agentboard 原身份已改变');
  const intent:AgentboardDiscussionIntent={version:1,accountId:input.accountId,agentId:owner.id,taskId:input.taskId,requestKey:input.requestKey,requestHash:request.requestHash,sourceHash:request.sourceHash,targetUrl:input.targetUrl,createdAt:(deps.now?.()??new Date()).toISOString(),board:input.draft.board};
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started' as const}};
  const opaque=await openAgentChatStreamingMutation(request.url,{method:'POST',headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${input.credential}`,'idempotency-key':input.requestKey},body:request.body},v=>persistence.persistOpaque(intent,v),()=>persistence.assertAuthorized(intent),deps);
  if(!opaque)return {status:'unknown' as const,intent};
  const payload=opaque.status===200||opaque.status===201?parseOpenAgentChatOpaque(opaque,request.url,opaque.status):undefined,thread=parseAgentboardThread(payload);
  if(!thread||thread.agentId!==owner.id||thread.boardId!==input.boardId||thread.title!==input.draft.title||thread.body!==input.draft.body)return {status:'unknown' as const,intent};
  try{await persistence.persistCreated(intent,thread);return {status:'created' as const,intent,thread}}catch{return {status:'persistence_unknown' as const,intent}}
}
