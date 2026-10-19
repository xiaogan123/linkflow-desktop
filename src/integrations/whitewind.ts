import {BATCH5_CONNECTED_MESSAGES as M,BATCH5_MESSAGES} from '../shared/batch5-messages';
import {randomUUID} from 'node:crypto';
import {articleReviewStillValid} from '../main/article-review';
import type {Account, ExecutionResult, LinkResult} from '../shared/types';
import type {Batch5Dependencies, Batch5Intent, Batch5Receipt, Batch5TaskState} from './batch5-contract';
import {batch5State, connectedDependencies, connectedRequest, hashBatch5, lockedBatch5,
  parseConnectedJson, persistBatch5Intent, persistBatch5Receipt, persistBatch5Response,
  stateFromIntent, type ConnectedContext} from './batch5-connected';

const CHANNEL='whitewind',COLLECTION='com.whtwnd.blog.entry';
const PDS='https://bsky.social',PUBLIC='https://whtwnd.com';
const MAX_RECORD_RESPONSE_BYTES=1_000_000;
const DID=/^did:(?:plc|web):[A-Za-z0-9:._%-]{1,240}$/;
const TID=/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

interface Credential {version:1;appPassword:string;handle:string;did:string}
interface Article {title:string;content:string;target:string;record:Record<string,unknown>}

function credential(value:string|undefined,account:Account):Credential|undefined {
  try{const data:unknown=JSON.parse(value??'null');if(!data||typeof data!=='object')return;
    const item=data as Record<string,unknown>;
    if(item.version!==1||typeof item.appPassword!=='string'||! /^[a-z0-9]{4}(?:-[a-z0-9]{4}){3}$/i.test(item.appPassword)
      ||typeof item.did!=='string'||!DID.test(item.did)||item.did!==account.username
      ||typeof item.handle!=='string'||! /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(item.handle))return;
    return item as unknown as Credential;
  }catch{return}
}

function fixedAccount(context:ConnectedContext):Account|undefined {
  const account=context.getAccount();
  return account?.channelId==='bluesky'&&account.id===context.task.accountId&&account.status==='registered'
    &&account.hasPassword&&account.credentialKind==='api_token'&&DID.test(account.username)?account:undefined;
}

/** TID keeps the original transaction's clock and identity after restart. */
export function whiteWindRkey(intent:Batch5Intent):string {
  const millis=Date.parse(intent.createdAt);
  if(!Number.isFinite(millis))throw Error('invalid_intent_time');
  const random=Number.parseInt(hashBatch5(intent.operationId).slice(0,3),16)&1023;
  let value=(BigInt(millis)*1000n<<10n)|BigInt(random);
  const alphabet='234567abcdefghijklmnopqrstuvwxyz';let result='';
  for(let i=0;i<13;i++){result=alphabet[Number(value&31n)]+result;value>>=5n}
  if(!TID.test(result))throw Error('invalid_rkey');
  return result;
}

function publicUrl(handle:string,rkey:string):string {
  if(!TID.test(rkey)||! /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(handle))throw Error('invalid_public_url');
  return `${PUBLIC}/${handle}/${rkey}`;
}

function article(context:ConnectedContext,createdAt:string):Article {
  const draft=context.task.draft,target=context.task.topicUrl;
  if(!draft||!target||!context.task.articleApprovedAt&&context.task.articleReview?.status!=='passed')throw Error('review_required');
  if(!draft.title.trim()||draft.title.length>1000||/[\u0000-\u001f\u007f]/.test(draft.title))throw Error('invalid_title');
  if(!draft.body.trim()||draft.body.length>100000||Buffer.byteLength(draft.body,'utf8')>256000
    ||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draft.body))throw Error('invalid_content');
  if(draft.description&&draft.description.length>1000)throw Error('invalid_subtitle');
  const site=new URL(context.site.url),link=new URL(target);
  if(site.protocol!=='https:'||link.protocol!=='https:'||link.hostname!==site.hostname||link.username||link.password||link.hash
    ||!draft.body.includes(link.toString()))throw Error('invalid_target');
  const record:Record<string,unknown>={$type:COLLECTION,content:draft.body,createdAt,title:draft.title,visibility:'public'};
  if(draft.description)record.subtitle=draft.description;
  return {title:draft.title,content:draft.body,target:link.toString(),record};
}

function requestBody(did:string,rkey:string,value:Article):string {
  // WhiteWind's own editor sends validate:false for this app-specific lexicon.
  return JSON.stringify({repo:did,collection:COLLECTION,rkey,validate:false,record:value.record});
}
/** Exact PDS record path used by the public-payload guard. */
export const whiteWindTesting={article,requestBody};

function exactIntent(context:ConnectedContext,intent:Batch5Intent,account:Account,secret:Credential):{article:Article;rkey:string;body:string}|undefined {
  if(intent.channelId!==CHANNEL||intent.siteId!==context.site.id)return;
  try{const rkey=whiteWindRkey(intent),value=article(context,intent.createdAt),body=requestBody(secret.did,rkey,value);
    if(hashBatch5(value.content)!==intent.sourceHash||hashBatch5(body)!==intent.requestHash
      ||batch5State(context)?.accountId&&batch5State(context)?.accountId!==account.id)return;
    return {article:value,rkey,body};
  }catch{return}
}

function recordUrl(did:string,rkey:string):string {
  const url=new URL('/xrpc/com.atproto.repo.getRecord',PDS);
  url.searchParams.set('repo',did);url.searchParams.set('collection',COLLECTION);url.searchParams.set('rkey',rkey);
  return url.toString();
}

function sameRecord(actual:Record<string,unknown>,expected:Record<string,unknown>):boolean {
  const canonical=(value:Record<string,unknown>)=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
  return canonical(actual)===canonical(expected);
}

function exactRemote(data:Record<string,unknown>|undefined,did:string,rkey:string,expected:Article):data is Record<string,unknown>&{uri:string;cid:string;value:Record<string,unknown>} {
  const uri=`at://${did}/${COLLECTION}/${rkey}`;
  return !!data&&data.uri===uri&&typeof data.cid==='string'&&data.cid.length>=8
    &&!!data.value&&typeof data.value==='object'&&!Array.isArray(data.value)
    &&sameRecord(data.value as Record<string,unknown>,expected.record);
}

function resultUnknown(context:ConnectedContext,message:string):ExecutionResult {
  return {...lockedBatch5(context,message),reasonCode:'submission_unknown'};
}

export async function reconcileWhiteWindTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<{status:'found';publicUrl:string;batch5:Batch5TaskState}|{status:'unknown'}>{
  const persistence=context.batch5Persistence,account=fixedAccount(context);
  if(!persistence||!account||context.channel.id!==CHANNEL||context.task.channelId!==CHANNEL)return {status:'unknown'};
  const intent=await persistence.loadIntent();if(!intent)return {status:'unknown'};
  const secret=credential(await context.secrets.get(`account:${account.id}`),account);if(!secret)return {status:'unknown'};
  const exact=exactIntent(context,intent,account,secret);if(!exact)return {status:'unknown'};
  const url=publicUrl(secret.handle,exact.rkey),prior=await persistence.loadReceipt();
  if(prior&&prior.intent.operationId!==intent.operationId)return {status:'unknown'};
  try{
    const deps=connectedDependencies(context,overrides),response=await connectedRequest(recordUrl(secret.did,exact.rkey),{method:'GET',headers:{accept:'application/json'}},deps,context.signal,MAX_RECORD_RESPONSE_BYTES);
    if(response.status!==200)return {status:'unknown'};
    const data=parseConnectedJson(response);if(!exactRemote(data,secret.did,exact.rkey,exact.article))return {status:'unknown'};
    const receipt:Batch5Receipt=prior??{version:1,intent,publicUrl:url,remoteId:exact.rkey,rawResponse:response.body};
    if(receipt.publicUrl!==url||receipt.remoteId!==exact.rkey)return {status:'unknown'};
    const state=await persistBatch5Receipt(context,receipt,account.id,exact.rkey);
    return {status:'found',publicUrl:url,batch5:state};
  }catch{return {status:'unknown'}}
}

export async function runWhiteWindTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<ExecutionResult>{
  if(context.channel.id!==CHANNEL||context.task.channelId!==CHANNEL||context.channel.automation!=='api')return {status:'needs_input',message:M.whitewind.invalidTask};
  const account=fixedAccount(context),persistence=context.batch5Persistence;
  if(!account)return {status:'needs_input',message:M.whitewind.accountMissing};
  if(!persistence)return {status:'needs_input',message:M.whitewind.journalMissing};
  const prior=await persistence.loadIntent();
  if(prior||batch5State(context)||context.task.submittedAt||context.task.publicUrl){
    const found=await reconcileWhiteWindTask(context,overrides);
    return found.status==='found'?{status:'review',message:M.whitewind.priorRead,publicUrl:found.publicUrl,batch5:found.batch5} as ExecutionResult
      :resultUnknown(context,M.whitewind.priorUnknown);
  }
  const secret=credential(await context.secrets.get(`account:${account.id}`),account);
  if(!secret)return {status:'needs_input',message:M.whitewind.credentialInvalid};
  const deps=connectedDependencies(context,overrides),createdAt=(deps.now?.()??new Date()).toISOString();
  if(!articleReviewStillValid(context.task,context.site,context.channel,context.settings,account))return {status:'needs_input',message:M.whitewind.reviewExpired};
  let session:Record<string,unknown>|undefined;
  try{const response=await connectedRequest(`${PDS}/xrpc/com.atproto.server.createSession`,{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify({identifier:secret.handle,password:secret.appPassword})},deps,context.signal);
    if(response.status===429)return {status:'failed',reasonCode:'platform_rate_limited',message:M.whitewind.loginRateLimited};
    if(response.status!==200)return {status:'needs_input',message:M.whitewind.loginFailed};
    session=parseConnectedJson(response);
    if(session?.did!==secret.did||typeof session.accessJwt!=='string'||session.accessJwt.length<16)return {status:'needs_input',message:M.whitewind.loginMismatch};
  }catch{return {status:'failed',reasonCode:'temporary_failure',message:M.whitewind.loginUnavailable}}
  const operationId=randomUUID(),seed:Batch5Intent={version:1,channelId:CHANNEL,operationId,siteId:context.site.id,sourceHash:'',requestHash:'',createdAt};
  let exact:Article,rkey:string,body:string;
  try{rkey=whiteWindRkey(seed);exact=article(context,createdAt);body=requestBody(secret.did,rkey,exact)}
  catch{return {status:'needs_input',reasonCode:'format_invalid',message:M.whitewind.draftInvalid}}
  const intent:Batch5Intent={...seed,sourceHash:hashBatch5(exact.content),requestHash:hashBatch5(body)};
  try{await persistBatch5Intent(context,intent,account.id,rkey)}
  catch{return {status:'needs_input',message:M.whitewind.intentSaveFailed}}
  try{await persistence.assertReadyToSubmit?.(intent)}
  catch{return {status:'review',message:BATCH5_MESSAGES.authorizationChanged,batch5:stateFromIntent(intent,'submitting',account.id,rkey),submittedAt:intent.createdAt}}
  let response;
  try{response=await connectedRequest(`${PDS}/xrpc/com.atproto.repo.createRecord`,{method:'POST',headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${session.accessJwt}`},body},deps,context.signal,MAX_RECORD_RESPONSE_BYTES);
    await persistBatch5Response(persistence,intent,response);
  }catch{return resultUnknown(context,M.whitewind.submissionUnknown)}
  if(response.status===429)return {status:'failed',reasonCode:'platform_rate_limited',checkpoint:'batch5_rejected',message:M.whitewind.rateLimited,trialFailure:M.whitewind.rateLimited};
  if([400,413,415,422].includes(response.status))return {status:'failed',reasonCode:'format_invalid',checkpoint:'batch5_rejected',message:M.whitewind.formatInvalid};
  if(response.status===401||response.status===403)return {status:'failed',reasonCode:'account_handoff',checkpoint:'batch5_rejected',message:M.whitewind.accountHandoff};
  if(response.status>=400&&response.status<500&&response.status!==408)return {status:'failed',reasonCode:'platform_rejected',checkpoint:'batch5_rejected',message:M.whitewind.rejected,trialFailure:M.whitewind.rejected};
  if(response.status!==200&&response.status!==201)return resultUnknown(context,M.whitewind.statusUnknown);
  const data=parseConnectedJson(response);
  if(data?.uri!==`at://${secret.did}/${COLLECTION}/${rkey}`||typeof data.cid!=='string'||data.cid.length<8)return resultUnknown(context,M.whitewind.receiptInvalid);
  const receipt:Batch5Receipt={version:1,intent,publicUrl:publicUrl(secret.handle,rkey),remoteId:rkey,rawResponse:response.body};
  try{const state=await persistBatch5Receipt(context,receipt,account.id,rkey);
    return {status:'review',message:M.whitewind.receiptSaved,publicUrl:receipt.publicUrl,batch5:state} as ExecutionResult;
  }catch{return resultUnknown(context,M.whitewind.receiptSaveUnknown)}
}

export async function verifyWhiteWindPublication(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<LinkResult>{
  const url=context.task.publicUrl??`${PUBLIC}/`,state=batch5State(context),persistence=context.batch5Persistence;
  const unavailable=(reason:string):LinkResult=>({found:false,outcome:'unreachable',url,rel:'',reason});
  const invalid=(reason:string):LinkResult=>({found:false,outcome:'invalid',url,rel:'',reason,indexable:false});
  if(!state||state.channelId!==CHANNEL||!persistence)return unavailable(M.whitewind.journalIncomplete);
  let matched:Awaited<ReturnType<typeof reconcileWhiteWindTask>>;
  try{matched=await reconcileWhiteWindTask(context,overrides)}catch{return unavailable(M.whitewind.originalUnreadable)}
  if(matched.status!=='found')return unavailable(M.whitewind.originalUnreadable);
  const deps=connectedDependencies(context,overrides),draft=context.task.draft,target=context.task.topicUrl;
  if(!draft||!target||!deps.renderPage)return unavailable(M.whitewind.rendererUnavailable);
  try{const visible=await deps.renderPage(matched.publicUrl,target,draft.title,draft.body,context.signal);
    if(!visible.found||!visible.indexable)return invalid(M.whitewind.publicInvalid);
    return {found:true,outcome:'found',url:matched.publicUrl,rel:visible.rel,reason:M.whitewind.verified,indexable:true};
  }catch{return unavailable(M.whitewind.publicUnavailable)}
}
