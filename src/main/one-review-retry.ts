import {createHash,timingSafeEqual} from 'node:crypto';
import type {Account,Channel,OneReviewRetry,OneReviewRetryBinding,Settings,Site,Task} from '../shared/types';
import {getArticleReviewMode} from '../shared/article-review-mode';
import {articleContentHash,articleContextHash,articleReviewBindingHash} from './article-review';
import {hasExternalAttempt} from './task-recovery';

export const ONE_REVIEW_RETRY_BASE_AI_CALLS=2;
export const ONE_REVIEW_RETRY_TOTAL_AI_CALLS=3;
export const ONE_REVIEW_RETRY_PURPOSE='independent_article_review' as const;

export interface OneReviewRetryContext {
  site:Site;
  channel:Channel;
  settings:Settings;
  account?:Pick<Account,'id'|'channelId'|'username'|'publicationUrl'>;
}

export type OneReviewRetryIneligibility=
  |'already_recorded'
  |'wrong_task_binding'
  |'wrong_account_binding'
  |'review_mode_disabled'
  |'not_failed_article_review'
  |'stale_failed_review'
  |'wrong_checkpoint'
  |'wrong_ai_call_count'
  |'draft_missing'
  |'external_attempt_exists';

export type OneReviewRetryEligibility=
  |{eligible:true;binding:OneReviewRetryBinding}
  |{eligible:false;reason:OneReviewRetryIneligibility};

class ReviewRetryBindingError extends Error {
  constructor(readonly reasonCode:'wrong_task_binding'|'wrong_account_binding',message:string){super(message)}
}

function tokenHash(operationToken:string){return createHash('sha256').update(operationToken,'utf8').digest('hex')}
function validOperationToken(value:string){return value.length>=32&&value.length<=512&&!/\s/.test(value)}
function equalHash(left:string,right:string){
  if(!/^[a-f0-9]{64}$/.test(left)||!areSameLength(left,right))return false;
  return timingSafeEqual(Buffer.from(left,'hex'),Buffer.from(right,'hex'));
}
function areSameLength(left:string,right:string){return left.length===right.length}
function sameBinding(left:OneReviewRetryBinding,right:OneReviewRetryBinding){
  return left.siteId===right.siteId&&left.channelId===right.channelId&&left.accountId===right.accountId
    &&left.draftRevision===right.draftRevision&&left.contentHash===right.contentHash&&left.contextHash===right.contextHash
    &&left.provider===right.provider&&left.model===right.model;
}
function grantBinding(grant:OneReviewRetry):OneReviewRetryBinding{
  return {siteId:grant.siteId,channelId:grant.channelId,accountId:grant.accountId,draftRevision:grant.draftRevision,contentHash:grant.contentHash,contextHash:grant.contextHash,provider:grant.provider,model:grant.model};
}
function iso(now:Date){const value=now.toISOString();if(!Number.isFinite(Date.parse(value)))throw Error('时间无效');return value}
type OneReviewRetryState={tasks:Task[]};
const persistedGrantIdentity=(grant:OneReviewRetry)=>JSON.stringify({version:grant.version,purpose:grant.purpose,operationTokenHash:grant.operationTokenHash,siteId:grant.siteId,channelId:grant.channelId,accountId:grant.accountId,draftRevision:grant.draftRevision,contentHash:grant.contentHash,contextHash:grant.contextHash,provider:grant.provider,model:grant.model,grantedAt:grant.grantedAt});
const validIso=(value:string)=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;

/** Persisted grants form a monotonic one-shot ledger, including across restore. */
export function assertOneReviewRetryTransition(previous:OneReviewRetryState,next:OneReviewRetryState,allowImported=false):void{
  for(const task of next.tasks){
    const retry=task.oneReviewRetry;if(!retry)continue;
    const calls=task.cost?.aiCalls??0,terminalAt=retry.status==='consumed'?retry.consumedAt:retry.status==='invalidated'?retry.invalidatedAt:undefined;
    if(retry.version!==1||retry.purpose!==ONE_REVIEW_RETRY_PURPOSE||retry.siteId!==task.siteId||retry.channelId!==task.channelId||retry.accountId!==null&&retry.accountId!==task.accountId||retry.provider.length>200||retry.model.length>500||!/^[a-f0-9]{64}$/.test(retry.operationTokenHash)||!/^[a-f0-9]{64}$/.test(retry.contentHash)||!/^[a-f0-9]{64}$/.test(retry.contextHash)||!validIso(retry.grantedAt)||terminalAt!==undefined&&(!validIso(terminalAt)||Date.parse(terminalAt)<Date.parse(retry.grantedAt))||retry.status==='granted'&&calls!==ONE_REVIEW_RETRY_BASE_AI_CALLS||retry.status==='invalidated'&&calls<ONE_REVIEW_RETRY_BASE_AI_CALLS||retry.status==='consumed'&&calls<ONE_REVIEW_RETRY_TOTAL_AI_CALLS)throw Error('单次追加审核保存记录无效');
    const priorTask=previous.tasks.find(value=>value.id===task.id),prior=priorTask?.oneReviewRetry;
    if(!prior){if(!allowImported&&retry.status!=='granted')throw Error('单次追加审核必须先保存授权');continue}
    if(persistedGrantIdentity(prior)!==persistedGrantIdentity(retry)||calls<(priorTask?.cost?.aiCalls??0))throw Error('单次追加审核授权或调用计数不能替换、清零或回退');
    if(prior.status==='granted'){
      if(retry.status==='granted'&&JSON.stringify(retry)!==JSON.stringify(prior))throw Error('待使用的单次追加审核授权不能改写');
    }else if(JSON.stringify(retry)!==JSON.stringify(prior))throw Error('已结束的单次追加审核记录不能改写或回退');
  }
  for(const task of previous.tasks){
    if(task.oneReviewRetry&&!next.tasks.find(value=>value.id===task.id)?.oneReviewRetry)throw Error('单次追加审核记录不能删除');
  }
}

export function oneReviewRetryBinding(task:Task,context:OneReviewRetryContext):OneReviewRetryBinding{
  if(task.siteId!==context.site.id||task.channelId!==context.channel.id)throw new ReviewRetryBindingError('wrong_task_binding','任务与审核上下文不一致');
  if(context.account&&context.account.channelId!==context.channel.id)throw new ReviewRetryBindingError('wrong_account_binding','审核账号与平台不一致');
  if(task.accountId&&context.account?.id!==task.accountId)throw new ReviewRetryBindingError('wrong_account_binding','审核账号与任务绑定不一致');
  return {
    siteId:task.siteId,
    channelId:task.channelId,
    accountId:task.accountId??context.account?.id??null,
    draftRevision:task.draftRevision??0,
    contentHash:articleContentHash(task),
    contextHash:task.articleReview?.bindingVersion===2
      ?articleReviewBindingHash(task,context.site,context.channel)
      :articleContextHash(context.site,context.channel,context.settings,context.account,task.articleReview?.reviewContractVersion??4),
    provider:context.settings.provider,
    model:context.settings.model,
  };
}

export function oneReviewRetryEligibility(task:Task,context:OneReviewRetryContext):OneReviewRetryEligibility{
  if(task.oneReviewRetry)return {eligible:false,reason:'already_recorded'};
  let binding:OneReviewRetryBinding;
  try{binding=oneReviewRetryBinding(task,context)}catch(error){return {eligible:false,reason:error instanceof ReviewRetryBindingError?error.reasonCode:'wrong_task_binding'}}
  if(getArticleReviewMode(context.site,context.settings)!=='ai')return {eligible:false,reason:'review_mode_disabled'};
  if(!['failed','needs_input'].includes(task.status))return {eligible:false,reason:'not_failed_article_review'};
  if(!task.draft)return {eligible:false,reason:'draft_missing'};
  if(!['article_review','system_wait','channel_wait'].includes(task.checkpoint??''))return {eligible:false,reason:'wrong_checkpoint'};
  if(hasExternalAttempt(task))return {eligible:false,reason:'external_attempt_exists'};
  if((task.cost?.aiCalls??0)!==ONE_REVIEW_RETRY_BASE_AI_CALLS)return {eligible:false,reason:'wrong_ai_call_count'};
  const review=task.articleReview;
  if(!review||review.status!=='failed')return {eligible:false,reason:'not_failed_article_review'};
  if(review.draftRevision!==binding.draftRevision||review.contentHash!==binding.contentHash||review.contextHash!==binding.contextHash)return {eligible:false,reason:'stale_failed_review'};
  return {eligible:true,binding};
}

/**
 * Records the sole user authorization. The raw token is returned to the caller's
 * in-memory operation and is never persisted; a restart therefore cannot resume it.
 */
export function grantOneReviewRetry(task:Task,context:OneReviewRetryContext,operationToken:string,now:Date=new Date()):OneReviewRetry{
  if(!validOperationToken(operationToken))throw Error('单次审核操作令牌无效');
  const eligibility=oneReviewRetryEligibility(task,context);
  if(!eligibility.eligible)throw Error(`当前任务不能授权单次追加审核：${eligibility.reason}`);
  return {...eligibility.binding,version:1,purpose:ONE_REVIEW_RETRY_PURPOSE,status:'granted',operationTokenHash:tokenHash(operationToken),grantedAt:iso(now)};
}

/**
 * Call only inside the same Store transaction that increments the daily usage.
 * It must run immediately before the independent review request is dispatched.
 */
export function consumeOneReviewRetry(
  task:Task,
  context:OneReviewRetryContext,
  request:{purpose:typeof ONE_REVIEW_RETRY_PURPOSE;operationToken:string},
  now:Date=new Date(),
):void{
  if(request.purpose!==ONE_REVIEW_RETRY_PURPOSE)throw Error('单次追加机会只能用于文章 AI 复核');
  const grant=task.oneReviewRetry;
  if(!grant||grant.status!=='granted')throw Error('单次追加审核未授权或已结束');
  if(!validOperationToken(request.operationToken)||!equalHash(grant.operationTokenHash,tokenHash(request.operationToken)))throw Error('单次追加审核操作令牌不匹配');
  const binding=oneReviewRetryBinding(task,context);
  if(!sameBinding(grantBinding(grant),binding))throw Error('单次追加审核绑定已变化');
  if((task.cost?.aiCalls??0)!==ONE_REVIEW_RETRY_BASE_AI_CALLS)throw Error('单次追加审核计数起点无效');
  if(!['article_review','system_wait','channel_wait'].includes(task.checkpoint??'')||hasExternalAttempt(task))throw Error('单次追加审核任务阶段已变化');
  const review=task.articleReview;
  if(!review||review.status!=='failed'||review.draftRevision!==binding.draftRevision||review.contentHash!==binding.contentHash||review.contextHash!==binding.contextHash)throw Error('单次追加审核的失败记录已变化');
  task.cost={...(task.cost??{aiCalls:0}),aiCalls:ONE_REVIEW_RETRY_TOTAL_AI_CALLS};
  task.oneReviewRetry={...grant,status:'consumed',consumedAt:iso(now)};
}

export function invalidateOneReviewRetry(
  task:Task,
  reason:'cancelled'|'restart'|'backup_import'|'request_not_started'|'binding_changed',
  now:Date=new Date(),
):void{
  const grant=task.oneReviewRetry;
  if(!grant||grant.status!=='granted')throw Error('没有可失效的单次追加审核授权');
  task.oneReviewRetry={...grant,status:'invalidated',invalidatedAt:iso(now),invalidationReason:reason};
}
