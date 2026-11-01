import {load} from 'cheerio';
import {articleReviewStillValid} from '../main/article-review';
import {socialDraftError} from '../shared/social-content';
import type {Account,ExecutionResult,LinkResult} from '../shared/types';
import type {Batch5Dependencies,Batch5Intent,Batch5OpaqueResponse,Batch5Receipt,Batch5TaskState} from './batch5-contract';
import {batch5State,connectedDependencies,connectedRequest,hashBatch5,lockedBatch5,newBatch5Intent,
  parseConnectedJson,persistBatch5Receipt,persistBatch5Response,stateFromIntent,type ConnectedContext} from './batch5-connected';

const CHANNEL='mastodon',ORIGIN='https://mastodon.social';
const ACCT=/^[A-Za-z0-9_]{1,30}$/,ID=/^[0-9]{1,30}$/;
const CONNECT_HELP='请连接 mastodon.social 原有账号的用户令牌，并在账号设置中开启机器人标记和允许搜索引擎索引。';

export interface MastodonConnection {id:string;acct:string;url:string;bot:true;indexable:true}
interface Approved {text:string;target:string;body:string}

function tokenFrom(raw:string|undefined):string|undefined {
  if(!raw)return;
  let value:unknown=raw;
  try{const parsed:unknown=JSON.parse(raw);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))value=(parsed as Record<string,unknown>).token}catch{/* Raw token. */}
  return typeof value==='string'&&value.length>=16&&Buffer.byteLength(value,'utf8')<=8192
    &&!/\s|[\u0000-\u001f\u007f]/.test(value)?value:undefined;
}

function accountFor(context:ConnectedContext):Account|undefined {
  const account=context.getAccount();
  return account?.channelId===CHANNEL&&account.id===context.task.accountId&&account.status==='registered'
    &&account.hasPassword&&account.credentialKind==='api_token'&&ACCT.test(account.username)
    &&account.publicationUrl===`${ORIGIN}/@${account.username}`?account:undefined;
}

/** Probe only the fixed host. The caller saves the token only after this returns successfully. */
export async function probeMastodonConnection(token:string,deps:Batch5Dependencies={},signal:AbortSignal=new AbortController().signal):Promise<MastodonConnection>{
  if(!tokenFrom(token))throw Error('Mastodon 用户令牌无效');
  let response;
  try{response=await connectedRequest(`${ORIGIN}/api/v1/accounts/verify_credentials`,
    {method:'GET',headers:{accept:'application/json',authorization:`Bearer ${token}`}},deps,signal,256*1024)}
  catch{throw Error('Mastodon 账号暂时无法验证')}
  if(response.status===401||response.status===403)throw Error('Mastodon 用户令牌无效、权限不足，或账号尚未完成验证');
  if(response.status!==200)throw Error('Mastodon 账号暂时无法验证');
  const data=parseConnectedJson(response),id=data?.id,acct=data?.acct,url=data?.url;
  if(typeof id!=='string'||!ID.test(id)||typeof acct!=='string'||!ACCT.test(acct)||url!==`${ORIGIN}/@${acct}`)
    throw Error('Mastodon 返回的账号不属于 mastodon.social 本地用户');
  if(!data||data.bot!==true||data.indexable!==true)throw Error(CONNECT_HELP);
  return {id,acct,url,bot:true,indexable:true};
}

function approved(context:ConnectedContext):Approved {
  const draft=context.task.draft,target=context.task.topicUrl;
  if(!draft||!target)throw Error('请先审核 Mastodon 短文和唯一正文链接');
  const format=socialDraftError(context.task,context.site,{...context.channel,contentFormat:'social'});
  if(format)throw Error(format);
  if(!draft.body.trim()||/[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draft.body))throw Error('Mastodon 短文含无效字符');
  const site=new URL(context.site.url),url=new URL(target);
  if(site.protocol!=='https:'||url.protocol!=='https:'||url.hostname!==site.hostname||url.username||url.password||url.hash)
    throw Error('Mastodon 短文必须链接本站已检查的正文页面');
  const textWithoutTarget=draft.body.replace(url.toString(),'');
  if(/@/.test(textWithoutTarget))throw Error('Mastodon 短文不得提及其他账号');
  if(/[#＃]/.test(textWithoutTarget))throw Error('Mastodon 短文暂不支持标签链接，请保留唯一正文链接');
  const body=new URLSearchParams({status:draft.body,visibility:'public'}).toString();
  return {text:draft.body,target:url.toString(),body};
}

function exactIntent(context:ConnectedContext,intent:Batch5Intent,account:Account):Approved|undefined {
  if(intent.channelId!==CHANNEL||intent.siteId!==context.site.id||batch5State(context)?.accountId&&batch5State(context)?.accountId!==account.id)return;
  try{const value=approved(context);return hashBatch5(value.text)===intent.sourceHash&&hashBatch5(value.body)===intent.requestHash?value:undefined}catch{return}
}

function statusUrl(acct:string,id:string):string|undefined {return ACCT.test(acct)&&ID.test(id)?`${ORIGIN}/@${acct}/${id}`:undefined}

export function mastodonUrlLabelMatches(label:string,target:string):boolean {
  return label===target||label===target.replace(/^https:\/\//,'');
}

/** Mastodon renders a URL as a decorated anchor, so compare its href and all other visible text. */
function exactStatus(data:Record<string,unknown>|undefined,ownerId:string,acct:string,id:string,expected:Approved):boolean {
  if(!data||data.id!==id||data.url!==statusUrl(acct,id)||data.visibility!=='public'
    ||data.in_reply_to_id!==null||data.reblog!==null||data.spoiler_text!==''
    ||!Array.isArray(data.mentions)||data.mentions.length!==0
    ||!Array.isArray(data.media_attachments)||data.media_attachments.length!==0||data.poll!==null
    ||!data.account||typeof data.account!=='object'||Array.isArray(data.account)
    ||(data.account as Record<string,unknown>).id!==ownerId||typeof data.content!=='string')return false;
  const $=load(`<div id="mastodon-status">${data.content}</div>`),root=$('#mastodon-status');
  if(root.find('a').length!==1||root.find('a').attr('href')!==expected.target||!mastodonUrlLabelMatches(root.find('a').text(),expected.target))return false;
  root.find('a').replaceWith(expected.target);root.find('br').replaceWith(' ');root.find('p').after(' ');
  const normalize=(value:string)=>value.replace(/\s+/gu,' ').trim();
  return normalize(root.text())===normalize(expected.text);
}

function unknown(context:ConnectedContext,message='Mastodon 提交结果无法确认；不会重复发布，请人工核对原账号。'):ExecutionResult {
  return {...lockedBatch5(context,message),reasonCode:'submission_unknown'};
}

function opaqueStatus(opaque:Batch5OpaqueResponse|undefined,intent:Batch5Intent):Record<string,unknown>|undefined {
  if(!opaque||opaque.intent.operationId!==intent.operationId||!opaque.bodyComplete||opaque.status!==200
    ||!/^application\/json\b/i.test(opaque.contentType)||opaque.responseUrl!==`${ORIGIN}/api/v1/statuses`)return;
  try{const raw=Buffer.from(opaque.bodyBase64,'base64').toString('utf8'),data:unknown=JSON.parse(raw);
    return data&&typeof data==='object'&&!Array.isArray(data)?data as Record<string,unknown>:undefined}catch{return}
}

export async function reconcileMastodonTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<{status:'found';publicUrl:string;batch5:Batch5TaskState}|{status:'unknown'}>{
  const persistence=context.batch5Persistence,account=accountFor(context);
  if(!persistence||!account||context.channel.id!==CHANNEL||context.task.channelId!==CHANNEL)return {status:'unknown'};
  const intent=await persistence.loadIntent();if(!intent)return {status:'unknown'};
  const expected=exactIntent(context,intent,account);if(!expected)return {status:'unknown'};
  const raw=await context.secrets.get(`account:${account.id}`),token=tokenFrom(raw);if(!token)return {status:'unknown'};
  const deps=connectedDependencies(context,overrides);
  try{
    const owner=await probeMastodonConnection(token,deps,context.signal);
    if(owner.acct!==account.username||owner.url!==account.publicationUrl)return {status:'unknown'};
    const prior=await persistence.loadReceipt();
    if(prior&&prior.intent.operationId!==intent.operationId)return {status:'unknown'};
    const identity=prior?{id:prior.remoteId,url:prior.publicUrl}:opaqueStatus(await persistence.loadOpaqueResponse(),intent);
    const identityId=identity?.id,identityUrl=identity?.url;
    if(typeof identityId!=='string'||!ID.test(identityId)||typeof identityUrl!=='string'||identityUrl!==statusUrl(owner.acct,identityId))return {status:'unknown'};
    const response=await connectedRequest(`${ORIGIN}/api/v1/statuses/${identityId}`,
      {method:'GET',headers:{accept:'application/json'}},deps,context.signal,512*1024);
    if(response.status!==200||!exactStatus(parseConnectedJson(response),owner.id,owner.acct,identityId,expected))return {status:'unknown'};
    const receipt:Batch5Receipt=prior??{version:1,intent,publicUrl:identityUrl,remoteId:identityId,rawResponse:response.body};
    const state=await persistBatch5Receipt(context,receipt,account.id,identityId);
    return {status:'found',publicUrl:identityUrl,batch5:state};
  }catch{return {status:'unknown'}}
}

export async function runMastodonTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<ExecutionResult>{
  if(context.channel.id!==CHANNEL||context.task.channelId!==CHANNEL||context.channel.automation!=='api')return {status:'needs_input',message:'Mastodon 任务配置无效'};
  const account=accountFor(context),persistence=context.batch5Persistence;
  if(!account)return {status:'needs_input',message:CONNECT_HELP};
  if(!persistence?.reserveIntent||!persistence.markSending)return {status:'needs_input',message:'Mastodon 加密发布日志不可用'};
  const prior=await persistence.loadIntent(),reserved=!!prior&&batch5State(context)?.stage==='reserved'&&!context.task.submittedAt&&!context.task.publicUrl;
  if(!reserved&&(prior||batch5State(context)||context.task.submittedAt||context.task.publicUrl)){
    const found=await reconcileMastodonTask(context,overrides);
    return found.status==='found'?{status:'review',message:'Mastodon 原帖已读回，等待匿名公开页验证',publicUrl:found.publicUrl,batch5:found.batch5}:unknown(context);
  }
  const token=tokenFrom(await context.secrets.get(`account:${account.id}`));
  if(!token)return {status:'needs_input',message:CONNECT_HELP};
  if(!articleReviewStillValid(context.task,context.site,context.channel,context.settings,account))return {status:'needs_input',message:'Mastodon 短文审核已失效，请重新审核'};
  let value:Approved;try{value=approved(context)}catch(error){return {status:'needs_input',reasonCode:'format_invalid',message:error instanceof Error?error.message:'Mastodon 短文格式无效'}}
  const deps=connectedDependencies(context,overrides),createdAt=(deps.now?.()??new Date()).toISOString();
  let owner:MastodonConnection;try{owner=await probeMastodonConnection(token,deps,context.signal)}
  catch(error){return {status:'needs_input',message:error instanceof Error?error.message:CONNECT_HELP}}
  if(owner.acct!==account.username||owner.url!==account.publicationUrl)return {status:'needs_input',message:'Mastodon 令牌对应的账号已变化，请重新连接'};
  const intent=prior??newBatch5Intent(context,value.body,value.text,createdAt);
  if(reserved&&!exactIntent(context,intent,account))return unknown(context,'Mastodon 原审核稿件与已保留发布计划不一致');
  if(!reserved){try{await persistence.reserveIntent(intent)}catch{return {status:'needs_input',message:'Mastodon 加密发布计划保存失败'}}}
  const defer=():ExecutionResult=>persistence.currentTaskState?.()?.stage==='reserved'
    ?{status:'queued',message:'发布授权已变化，保留原计划等待恢复',checkpoint:'batch5_reserved',batch5:stateFromIntent(intent,'reserved',account.id),scheduledAt:new Date((deps.now?.()??new Date()).getTime()+3600000).toISOString()}
    :unknown(context);
  try{await persistence.assertReadyToSubmit?.(intent)}catch{return defer()}
  try{await persistence.markSending(intent)}catch{return defer()}
  let response;
  try{response=await connectedRequest(`${ORIGIN}/api/v1/statuses`,{method:'POST',headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded',authorization:`Bearer ${token}`,'Idempotency-Key':intent.operationId},body:value.body},deps,context.signal,512*1024);
    await persistBatch5Response(persistence,intent,response)}catch{return unknown(context)}
  if(response.status===429)return {status:'failed',reasonCode:'platform_rate_limited',checkpoint:'batch5_rejected',message:'Mastodon 限流',trialFailure:'Mastodon 限流'};
  if([400,413,415,422].includes(response.status))return {status:'failed',reasonCode:'format_invalid',checkpoint:'batch5_rejected',message:'Mastodon 拒绝短文格式'};
  if(response.status===401||response.status===403)return {status:'failed',reasonCode:'account_handoff',checkpoint:'batch5_rejected',message:'Mastodon 账号权限或令牌已变化'};
  if(response.status>=400&&response.status<500&&response.status!==408)return {status:'failed',reasonCode:'platform_rejected',checkpoint:'batch5_rejected',message:'Mastodon 拒绝发布',trialFailure:'Mastodon 拒绝发布'};
  if(response.status!==200)return unknown(context);
  const data=parseConnectedJson(response),id=data?.id;
  if(typeof id!=='string'||!ID.test(id)||!exactStatus(data,owner.id,owner.acct,id,value))return unknown(context);
  const receipt:Batch5Receipt={version:1,intent,publicUrl:statusUrl(owner.acct,id)!,remoteId:id,rawResponse:response.body};
  try{const state=await persistBatch5Receipt(context,receipt,account.id,id);
    return {status:'review',message:'Mastodon API 原帖已保存，等待匿名公开页验证',publicUrl:receipt.publicUrl,batch5:state}}
  catch{return unknown(context)}
}

function robotsAllows(text:string,path:string,agent:string):boolean {
  const groups:Array<{agents:string[];rules:Array<{allow:boolean;value:string}>}>=[];
  let group:{agents:string[];rules:Array<{allow:boolean;value:string}>}={agents:[],rules:[]};
  const push=()=>{if(group.agents.length)groups.push(group);group={agents:[],rules:[]}};
  for(const line of text.replace(/^\uFEFF/,'').split(/\r\n|\n|\r/)){
    const match=line.replace(/#.*$/,'').trim().match(/^(user-agent|allow|disallow):\s*(.*)$/i);if(!match)continue;
    const key=match[1].toLowerCase(),value=match[2].trim();
    if(key==='user-agent'){if(group.rules.length)push();group.agents.push(value.toLowerCase())}
    else if(group.agents.length&&value)group.rules.push({allow:key==='allow',value});
  }push();
  const matching=groups.map(item=>({item,score:Math.max(...item.agents.map(value=>value==='*'?0:agent.toLowerCase().startsWith(value)?value.length:-1))})).filter(item=>item.score>=0);
  if(!matching.length)return true;
  const score=Math.max(...matching.map(item=>item.score)),rules=matching.filter(item=>item.score===score).flatMap(item=>item.item.rules);
  let winner:{allow:boolean;length:number}|undefined;
  for(const rule of rules){const pattern=rule.value.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*').replace(/\\\$$/,'$');
    if(!new RegExp(`^${pattern}`).test(path))continue;
    const next={allow:rule.allow,length:rule.value.length};if(!winner||next.length>winner.length||next.length===winner.length&&next.allow)winner=next;
  }
  return winner?.allow??true;
}

export async function verifyMastodonPublication(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<LinkResult>{
  const url=context.task.publicUrl??`${ORIGIN}/`,state=batch5State(context),persistence=context.batch5Persistence;
  const unavailable=(reason:string):LinkResult=>({found:false,outcome:'unreachable',url,rel:'',reason});
  const invalid=(reason:string):LinkResult=>({found:false,outcome:'invalid',url,rel:'',reason,indexable:false});
  if(!state||state.channelId!==CHANNEL||!persistence)return unavailable('Mastodon 原发布日志缺失');
  const found=await reconcileMastodonTask(context,overrides);if(found.status!=='found')return unavailable('Mastodon 原帖不能精确读回');
  const deps=connectedDependencies(context,overrides),draft=context.task.draft,target=context.task.topicUrl;
  if(!draft||!target||!deps.renderPage)return unavailable('Mastodon 匿名动态页渲染器未配置');
  try{
    const robots=await connectedRequest(`${ORIGIN}/robots.txt`,{method:'GET',headers:{accept:'text/plain'}},deps,context.signal,128*1024);
    if(robots.status!==200||!/^text\/plain\b/i.test(robots.contentType))return unavailable('Mastodon robots.txt 无法确认');
    if(!['*','googlebot','bingbot'].every(agent=>robotsAllows(robots.body,new URL(found.publicUrl).pathname,agent)))return invalid('Mastodon robots.txt 禁止抓取原帖');
    const visible=await deps.renderPage(found.publicUrl,target,draft.title,draft.body,context.signal);
    if(!visible.found||!visible.indexable)return invalid('Mastodon 匿名公开页缺少原生链接或带有 noindex');
    return {found:true,outcome:'found',url:found.publicUrl,rel:visible.rel,reason:'Mastodon 原帖和匿名公开页均已验证',indexable:true};
  }catch{return unavailable('Mastodon 匿名公开页暂时无法检查')}
}

export const mastodonTesting={approved,exactStatus,robotsAllows};
