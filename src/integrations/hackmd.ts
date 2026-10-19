import {BATCH5_CONNECTED_MESSAGES as M,BATCH5_MESSAGES} from '../shared/batch5-messages';
import {articleReviewStillValid} from '../main/article-review';
import type {Account, ExecutionResult, LinkResult} from '../shared/types';
import type {Batch5Dependencies, Batch5Intent, Batch5Receipt, Batch5TaskState} from './batch5-contract';
import {batch5State, connectedDependencies, connectedRequest, hashBatch5, lockedBatch5,
  newBatch5Intent, parseConnectedJson, persistBatch5Receipt,
  persistBatch5Response, stateFromIntent, type ConnectedContext} from './batch5-connected';

const CHANNEL='hackmd',API='https://api.hackmd.io/v1',PUBLIC='https://hackmd.io';
const MAX_NOTE_RESPONSE_BYTES=1_400_000;
const NOTE_ID=/^[A-Za-z0-9_-]{6,128}$/;

interface Article {title:string;content:string;target:string;body:string}
interface Note {id:string;shortId:string;title:string;content:string;readPermission:string;writePermission:string}

function accountFor(context:ConnectedContext):Account|undefined {
  const account=context.getAccount();
  return account?.channelId===CHANNEL&&account.id===context.task.accountId&&account.status==='registered'
    &&account.hasPassword&&account.credentialKind==='api_token'?account:undefined;
}

function tokenFrom(raw:string|undefined):string|undefined {
  if(!raw)return;
  let value=raw;
  try{const parsed:unknown=JSON.parse(raw);if(parsed&&typeof parsed==='object'&&'token'in parsed){value=(parsed as {token:unknown}).token as string}}catch{/* Raw token. */}
  return typeof value==='string'&&value.length>=16&&Buffer.byteLength(value,'utf8')<=8192
    &&!/\s|[\u0000-\u001f\u007f]/.test(value)?value:undefined;
}

function article(context:ConnectedContext):Article {
  const draft=context.task.draft,target=context.task.topicUrl;
  if(!draft||!target||!draft.title.trim()||!draft.body.trim())throw Error('draft_missing');
  if(draft.title.length>200||Buffer.byteLength(draft.body,'utf8')>500000
    ||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draft.body))throw Error('draft_invalid');
  const site=new URL(context.site.url),link=new URL(target);
  if(site.protocol!=='https:'||link.protocol!=='https:'||link.hostname!==site.hostname||link.username||link.password||link.hash
    ||!draft.body.includes(link.toString()))throw Error('target_invalid');
  const body=JSON.stringify({title:draft.title,content:draft.body,readPermission:'guest',writePermission:'owner'});
  return {title:draft.title,content:draft.body,target:link.toString(),body};
}
/** Exact guest-readable note body used by the public-payload guard. */
export const hackMdTesting={article};

function exactIntent(context:ConnectedContext,intent:Batch5Intent,account:Account):Article|undefined {
  if(intent.channelId!==CHANNEL||intent.siteId!==context.site.id||batch5State(context)?.accountId&&batch5State(context)?.accountId!==account.id)return;
  try{const value=article(context);return hashBatch5(value.content)===intent.sourceHash&&hashBatch5(value.body)===intent.requestHash?value:undefined}
  catch{return}
}

function publicUrl(shortId:string):string|undefined {
  return NOTE_ID.test(shortId)?`${PUBLIC}/${shortId}`:undefined;
}

function note(value:Record<string,unknown>|undefined):Note|undefined {
  if(!value||typeof value.id!=='string'||!NOTE_ID.test(value.id)||typeof value.shortId!=='string'||!NOTE_ID.test(value.shortId)
    ||typeof value.title!=='string'||typeof value.content!=='string'||typeof value.readPermission!=='string'
    ||typeof value.writePermission!=='string')return;
  return value as unknown as Note;
}

function exactNote(value:Note|undefined,expected:Article):value is Note {
  return !!value&&value.title===expected.title&&value.content===expected.content
    &&value.readPermission==='guest'&&value.writePermission==='owner';
}

function unknown(context:ConnectedContext,message:string):ExecutionResult {
  return {...lockedBatch5(context,message),reasonCode:'submission_unknown'};
}

async function readNote(noteId:string,token:string,deps:Batch5Dependencies,signal:AbortSignal):Promise<Note|undefined>{
  if(!NOTE_ID.test(noteId))return;
  const response=await connectedRequest(`${API}/notes/${noteId}`,{method:'GET',headers:{accept:'application/json',authorization:`Bearer ${token}`}},deps,signal,MAX_NOTE_RESPONSE_BYTES);
  return response.status===200?note(parseConnectedJson(response)):undefined;
}

async function findOriginal(intent:Batch5Intent,expected:Article,token:string,deps:Batch5Dependencies,signal:AbortSignal):Promise<Note|undefined>{
  const response=await connectedRequest(`${API}/notes`,{method:'GET',headers:{accept:'application/json',authorization:`Bearer ${token}`}},deps,signal,2*1024*1024);
  if(response.status!==200||!/^application\/json\b/i.test(response.contentType))return;
  let list:unknown;try{list=JSON.parse(response.body)}catch{return}
  if(!Array.isArray(list)||list.length>2000)return;
  const candidates=list.filter(item=>item&&typeof item==='object'&&item.title===expected.title&&typeof item.id==='string'&&NOTE_ID.test(item.id));
  if(candidates.length>20)return; // Conserve the documented 400 calls/month quota.
  const matches:Note[]=[];
  for(const candidate of candidates){const remote=await readNote(candidate.id,token,deps,signal);if(exactNote(remote,expected))matches.push(remote)}
  return matches.length===1?matches[0]:undefined;
}

export async function reconcileHackMdTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<{status:'found';publicUrl:string;batch5:Batch5TaskState}|{status:'unknown'}>{
  const persistence=context.batch5Persistence,account=accountFor(context);
  if(!persistence||!account||context.channel.id!==CHANNEL||context.task.channelId!==CHANNEL)return {status:'unknown'};
  const intent=await persistence.loadIntent();if(!intent)return {status:'unknown'};
  const expected=exactIntent(context,intent,account);if(!expected)return {status:'unknown'};
  const token=tokenFrom(await context.secrets.get(`account:${account.id}`));if(!token)return {status:'unknown'};
  const prior=await persistence.loadReceipt();if(prior&&prior.intent.operationId!==intent.operationId)return {status:'unknown'};
  const deps=connectedDependencies(context,overrides);
  try{
    const remote=prior?.remoteId?await readNote(prior.remoteId,token,deps,context.signal)
      :await findOriginal(intent,expected,token,deps,context.signal);
    if(!exactNote(remote,expected))return {status:'unknown'};
    const url=publicUrl(remote.shortId);if(!url||prior&&prior.publicUrl!==url)return {status:'unknown'};
    const receipt:Batch5Receipt=prior??{version:1,intent,publicUrl:url,remoteId:remote.id,rawResponse:JSON.stringify(remote)};
    const state=await persistBatch5Receipt(context,receipt,account.id,remote.id);
    return {status:'found',publicUrl:url,batch5:state};
  }catch{return {status:'unknown'}}
}

export async function runHackMdTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<ExecutionResult>{
  if(context.channel.id!==CHANNEL||context.task.channelId!==CHANNEL||context.channel.automation!=='api')return {status:'needs_input',message:M.hackmd.invalidTask};
  const account=accountFor(context),persistence=context.batch5Persistence;
  if(!account)return {status:'needs_input',message:M.hackmd.accountMissing};
  if(!persistence)return {status:'needs_input',message:M.hackmd.journalMissing};
  const prior=await persistence.loadIntent();
  const reserved=!!prior&&batch5State(context)?.stage==='reserved'&&!context.task.submittedAt&&!context.task.publicUrl;
  if(!reserved&&(prior||batch5State(context)||context.task.submittedAt||context.task.publicUrl)){
    const result=await reconcileHackMdTask(context,overrides);
    return result.status==='found'?{status:'review',message:M.hackmd.priorRead,publicUrl:result.publicUrl,batch5:result.batch5} as ExecutionResult
      :unknown(context,M.hackmd.priorUnknown);
  }
  const token=tokenFrom(await context.secrets.get(`account:${account.id}`));
  if(!token)return {status:'needs_input',message:M.hackmd.tokenInvalid};
  if(!articleReviewStillValid(context.task,context.site,context.channel,context.settings,account))return {status:'needs_input',message:M.hackmd.reviewExpired};
  let value:Article;try{value=article(context)}catch{return {status:'needs_input',reasonCode:'format_invalid',message:M.hackmd.draftInvalid}}
  const deps=connectedDependencies(context,overrides),createdAt=(deps.now?.()??new Date()).toISOString();
  const intent=prior??newBatch5Intent(context,value.body,value.content,createdAt);
  if(reserved&&!exactIntent(context,intent,account))return unknown(context,M.hackmd.priorUnknown);
  if(!persistence.reserveIntent||!persistence.markSending)return {status:'needs_input',message:M.hackmd.journalMissing};
  if(!reserved){try{await persistence.reserveIntent(intent)}catch{return {status:'needs_input',message:M.hackmd.intentSaveFailed}}}
  const deferUnsent=():ExecutionResult=>{
    if(persistence.currentTaskState?.()?.stage!=='reserved')return unknown(context,M.hackmd.submissionUnknown);
    return {status:'queued',message:BATCH5_MESSAGES.authorizationChanged,checkpoint:'batch5_reserved',
      batch5:stateFromIntent(intent,'reserved',account.id),scheduledAt:new Date((deps.now?.()??new Date()).getTime()+3600000).toISOString()};
  };
  try{await persistence.assertReadyToSubmit?.(intent)}catch{return deferUnsent()}
  try{await persistence.markSending(intent)}catch{return deferUnsent()}
  let response;
  try{response=await connectedRequest(`${API}/notes`,{method:'POST',headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${token}`},body:value.body},deps,context.signal,MAX_NOTE_RESPONSE_BYTES);
    await persistBatch5Response(persistence,intent,response);
  }catch{return unknown(context,M.hackmd.submissionUnknown)}
  if(response.status===429)return {status:'failed',reasonCode:'platform_rate_limited',checkpoint:'batch5_rejected',message:M.hackmd.rateLimited,trialFailure:M.hackmd.rateLimited};
  if([400,413,415,422].includes(response.status))return {status:'failed',reasonCode:'format_invalid',checkpoint:'batch5_rejected',message:M.hackmd.formatInvalid};
  if(response.status===401||response.status===403)return {status:'failed',reasonCode:'account_handoff',checkpoint:'batch5_rejected',message:M.hackmd.accountHandoff};
  if(response.status>=400&&response.status<500&&response.status!==408)return {status:'failed',reasonCode:'platform_rejected',checkpoint:'batch5_rejected',message:M.hackmd.rejected,trialFailure:M.hackmd.rejected};
  if(response.status!==201)return unknown(context,M.hackmd.statusUnknown);
  const created=note(parseConnectedJson(response));
  if(!exactNote(created,value))return unknown(context,M.hackmd.receiptInvalid);
  const url=publicUrl(created.shortId);if(!url)return unknown(context,M.hackmd.urlInvalid);
  const receipt:Batch5Receipt={version:1,intent,publicUrl:url,remoteId:created.id,rawResponse:response.body};
  try{const state=await persistBatch5Receipt(context,receipt,account.id,created.id);
    return {status:'review',message:M.hackmd.receiptSaved,publicUrl:url,batch5:state} as ExecutionResult;
  }catch{return unknown(context,M.hackmd.receiptSaveUnknown)}
}

export async function verifyHackMdPublication(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<LinkResult>{
  const url=context.task.publicUrl??`${PUBLIC}/`,state=batch5State(context),persistence=context.batch5Persistence;
  const unavailable=(reason:string):LinkResult=>({found:false,outcome:'unreachable',url,rel:'',reason});
  const invalid=(reason:string):LinkResult=>({found:false,outcome:'invalid',url,rel:'',reason,indexable:false});
  if(!state||state.channelId!==CHANNEL||!persistence)return unavailable(M.hackmd.journalIncomplete);
  let matched:Awaited<ReturnType<typeof reconcileHackMdTask>>;
  try{matched=await reconcileHackMdTask(context,overrides)}catch{return unavailable(M.hackmd.originalUnreadable)}
  if(matched.status!=='found')return unavailable(M.hackmd.originalUnreadable);
  const deps=connectedDependencies(context,overrides),draft=context.task.draft,target=context.task.topicUrl;
  if(!draft||!target||!deps.renderPage)return unavailable(M.hackmd.rendererUnavailable);
  try{const visible=await deps.renderPage(matched.publicUrl,target,draft.title,draft.body,context.signal);
    if(!visible.found||!visible.indexable)return invalid(M.hackmd.publicInvalid);
    return {found:true,outcome:'found',url:matched.publicUrl,rel:visible.rel,reason:M.hackmd.verified,indexable:true};
  }catch{return unavailable(M.hackmd.publicUnavailable)}
}
