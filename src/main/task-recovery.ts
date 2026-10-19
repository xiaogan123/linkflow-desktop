import {containsReferralInformation,siteReferralCodes} from '../shared/referral-policy';
import type {ArticleReviewReasonCode,Channel, Settings, Site, Task,TaskReasonCode} from '../shared/types';
import {getArticleReviewMode} from '../shared/article-review-mode';
import {articleTopicLanguageScore,canonicalPublicPageUrl,hasRecoverablePublisherDraftReceipt,hasRemotePublicationIntent,hasUnresolvedExternalAttempt,isPendingPublisherRegistration} from '../shared/publication';
export {isPendingPublisherRegistration} from '../shared/publication';
import {isArticleTopicUrl} from '../shared/topic-policy';
import {isHumanTaskReason,TASK_REASON_MESSAGES,TASK_FLOW_MESSAGES,TaskReasonError,taskCooldownUntil} from '../shared/task-reasons';
import {createHumanAction} from '../shared/human-action';
import {taskTransition} from './task-state';
import {BATCH9A3_RETRY_MESSAGES} from '../shared/batch9a3-messages';

export const TASK_AI_BUDGET=3;

/** Consecutive format failures repair the retained draft once, then stop. */
export function formatRepairDecision(task:Task,review:import('../shared/types').ArticleReview):{attempts:number;exhausted:boolean;repair?:{reason:string;draft:NonNullable<Task['draft']>}}{
  if(review.status!=='failed'||review.reasonCode!=='format_invalid')return {attempts:0,exhausted:false};
  const attempts=Math.min(2,(task.formatRepairFailures??0)+1),exhausted=attempts>=2;
  return {attempts,exhausted,...(!exhausted&&task.draft?{repair:{reason:review.reason,draft:task.draft}}:{})};
}
const TEMPORARY_REVIEW=new Set(['ai_unavailable','evidence_fetch_failed','evidence_invalid']);
const TEMPORARY_TASK=new Set<TaskReasonCode>(['temporary_failure','platform_rate_limited','ai_rate_limited']);
const ALTERNATIVE_TOPIC_CODES=new Set<ArticleReviewReasonCode>(['content_rejected','invalid_topic']);
/** A receipt still protects remote work when an imported task lacks its submission timestamp. */
export function hasExternalAttempt(task:Task){return hasUnresolvedExternalAttempt(task)}

function isTemporaryFailure(task:Task):boolean{
  return TEMPORARY_TASK.has(task.reasonCode as TaskReasonCode)||TEMPORARY_REVIEW.has(task.articleReview?.reasonCode??'');
}

export type AlternativeTopicRecoveryResult=
  |{kind:'not_applicable'|'ineligible'}
  |{kind:'switched';topicUrl:string}
  |{kind:'blocked';blockingReason:'invalid_topic'|'article_rejected'|'budget_exhausted';message:string};

function alternativeTopic(task:Task,site:Site,tasks:Task[]):string|undefined{
  const tried=new Set<string>();
  const remember=(value:string|undefined)=>{const canonical=canonicalPublicPageUrl(value);if(canonical)tried.add(canonical)};
  remember(task.topicUrl);for(const attempt of task.articleAttempts??[])remember(attempt.topicUrl);
  for(const other of tasks){
    if(other.id===task.id||other.siteId!==task.siteId)continue;
    for(const attempt of other.articleAttempts??[])remember(attempt.topicUrl);
    const reserved=(hasExternalAttempt(other)&&!isPendingPublisherRegistration(other))||!['failed','skipped','expired'].includes(other.status)||!!other.reasonCode;
    if(reserved)remember(other.topicUrl);
  }
  // The same codes the referral guard uses, including those the evidence snapshot saw.
  const codes=siteReferralCodes(site,task.evidenceSnapshot);let siteHost:string|undefined;try{siteHost=new URL(site.url).hostname}catch{siteHost=undefined}
  return (site.topics??[]).map((topic,index)=>({topic,index,canonical:canonicalPublicPageUrl(topic.url),language:articleTopicLanguageScore(topic,site.language),updated:Date.parse(topic.lastModified??topic.discoveredAt)}))
    .filter((item):item is typeof item&{canonical:string}=>!!item.canonical&&isArticleTopicUrl(item.canonical,site)&&!tried.has(item.canonical)
      // A replacement that itself carries a referral marker would be blocked the same way.
      &&!containsReferralInformation(item.canonical,codes,siteHost))
    .sort((a,b)=>b.language-a.language||(Number.isFinite(a.updated)&&Number.isFinite(b.updated)?b.updated-a.updated:0)||a.index-b.index)[0]?.canonical;
}

function competingWork(task:Task,tasks:Task[]):boolean{
  return tasks.some(other=>other.id!==task.id&&other.siteId===task.siteId&&(other.channelId===task.channelId||!!task.topicUrl&&canonicalPublicPageUrl(other.topicUrl)===canonicalPublicPageUrl(task.topicUrl))&&
    ((hasExternalAttempt(other)&&!other.firstLiveAt)||(!!other.firstLiveAt&&Date.parse(other.firstLiveAt)>Date.parse(task.createdAt))||!['failed','skipped','expired','live'].includes(other.status)));
}

/**
 * Replace one rejected/unusable topic on the original task. The previous material
 * remains as evidence, while task id and cumulative cost stay unchanged.
 */
export function recoverWithAlternativeTopic(task:Task,site:Site,channel:Channel,tasks:Task[],settings:Settings,now=new Date(),invalidEvidence=false):AlternativeTopicRecoveryResult{
  if(!task.topicUrl)return {kind:'not_applicable'};
  const code=task.articleReview?.reasonCode,invalidCurrent=invalidEvidence||code==='invalid_topic'||!isArticleTopicUrl(task.topicUrl,site);
  if(!invalidCurrent&&(!code||!ALTERNATIVE_TOPIC_CODES.has(code)))return {kind:'not_applicable'};
  if(code==='content_rejected'&&task.articleReview?.checks?.channelRules==='fail')return {kind:'ineligible'};
  if(!settings.autoRun||site.status!=='ready'||getArticleReviewMode(site,settings)!=='ai'||!channel.enabled||channel.automation==='manual'||(channel.kind!=='article'&&channel.contentFormat!=='social')||!channel.articleRequired||
    !(['queued','running','failed'].includes(task.status)||task.status==='needs_input'&&task.reasonCode==='referral_blocked')||!!task.deferredAt||hasExternalAttempt(task)||competingWork(task,tasks)
    // A registration or publication receipt already on the platform belongs to this topic; never swap it.
    ||hasRemotePublicationIntent(task)||isPendingPublisherRegistration(task))return {kind:'ineligible'};
  const stamp=now.toISOString(),switched=task.topicSwitchAttempts??task.articleAttempts?.length??0;
  const block=(blockingReason:'invalid_topic'|'article_rejected'|'budget_exhausted',message:string):AlternativeTopicRecoveryResult=>{
    const reasonCode:TaskReasonCode=blockingReason==='budget_exhausted'?'ai_task_limit':blockingReason==='invalid_topic'?'invalid_topic':'content_rejected';
    const sameTerminal=task.status==='failed'&&task.reasonCode===reasonCode;
    const cooldownUntil=sameTerminal
      ?task.cooldownUntil??taskCooldownUntil(reasonCode,task.updatedAt)
      :taskCooldownUntil(reasonCode,now);
    Object.assign(task,taskTransition(task,{status:'failed',checkpoint:blockingReason==='budget_exhausted'?'topic_recovery_budget':blockingReason,reasonCode,
      recoveryEligible:false,nextCheckAt:undefined,
      updatedAt:sameTerminal?task.updatedAt:stamp,message},now),{cooldownUntil});
    return {kind:'blocked',blockingReason,message};
  };
  if(switched>=1)return block(invalidCurrent?'invalid_topic':'article_rejected',invalidCurrent?'当前及备用选题均不是可用的正文页面，已停止该任务且不会重复换题。':'备用选题的稿件仍未通过 AI 复核，已达到一次换题上限。');
  // One call left is exactly one more review of this draft ("追加一次 AI 复核"); leave the task where that is offered.
  if(TASK_AI_BUDGET-(task.cost?.aiCalls??0)===1)return {kind:'ineligible'};
  if(TASK_AI_BUDGET-(task.cost?.aiCalls??0)<2)return block('budget_exhausted','当前任务剩余的 AI 次数不足两次，无法同时完成备用选题的新稿与 AI 复核；已在付费前停止。');
  const next=alternativeTopic(task,site,tasks);
  if(!next)return block(invalidCurrent?'invalid_topic':'article_rejected',invalidCurrent?'当前选题不是正文页面，且没有尚未尝试的有效备用选题；未调用 AI。':'稿件未通过 AI 复核，且没有尚未尝试的有效备用选题。');
  task.history??=[];task.history.push({at:stamp,status:task.status,message:task.message,linkCheck:task.linkCheck});task.history=task.history.slice(-50);
  task.articleAttempts=[...(task.articleAttempts??[]),{topicUrl:task.topicUrl,recordedAt:stamp,reason:task.articleReview?.reason??task.message,...(task.draft?{draft:structuredClone(task.draft)}:{}),...(task.draftRevision!==undefined?{draftRevision:task.draftRevision}:{}),...(task.articleRepairAttempts!==undefined?{articleRepairAttempts:task.articleRepairAttempts}:{}),...(task.articleReview?{articleReview:structuredClone(task.articleReview)}:{})}].slice(-1);
  Object.assign(task,taskTransition(task,{topicUrl:next,topicContentHash:undefined,evidenceSnapshot:undefined,factManifest:undefined,topicSwitchAttempts:switched+1,draft:undefined,articleReview:undefined,articleApprovedAt:undefined,...(task.channelId==='agentboard'?{agentboardInput:undefined}:{}),articleRepairAttempts:0,draftUpdatedAt:undefined,status:'queued',checkpoint:undefined,reasonCode:undefined,attempts:0,scheduledAt:stamp,updatedAt:stamp,nextCheckAt:undefined,recoveryEligible:false,message:'已保留上一选题的稿件与审核记录，正在同一任务内改用一个尚未尝试的正文选题；已使用的 AI 次数不重置。'},now));
  return {kind:'switched',topicUrl:next};
}

export function maintainWaitingTasks(tasks:Task[],sites:Site[],channels:Channel[],settings:Settings,now=new Date()):Task[]{
  const reminders:Task[]=[];
  if(!settings.autoRun)return reminders;
  const stamp=now.toISOString();
  for(const task of tasks){
    const site=sites.find(item=>item.id===task.siteId),channel=channels.find(item=>item.id===task.channelId);
    if(!site||site.status!=='ready'||!channel?.enabled||task.deferredAt)continue;
    if(task.reasonCode==='referral_blocked'&&task.topicUrl&&!hasExternalAttempt(task)&&!hasRemotePublicationIntent(task)&&!isPendingPublisherRegistration(task)
      &&containsReferralInformation(task.topicUrl,siteReferralCodes(site,task.evidenceSnapshot),new URL(site.url).hostname)){
      const alternative=recoverWithAlternativeTopic(task,site,channel,tasks,settings,now,true);
      if(alternative.kind==='switched'||alternative.kind==='blocked')continue;
    }
    // Only a task still inside this backoff expires; a recovered or AI-paused task keeps its schedule.
    if(task.status==='queued'&&!hasExternalAttempt(task)&&task.temporaryBackoffStartedAt&&(task.temporaryBackoffCount??0)>0&&
      isTemporaryFailure(task)&&task.checkpoint!=='ai_setup_required'&&
      now.getTime()-Date.parse(task.temporaryBackoffStartedAt)>=72*3600000){
      Object.assign(task,taskTransition(task,{status:'failed',reasonCode:task.reasonCode??'temporary_failure',checkpoint:'system_wait',
        recoveryEligible:false,nextCheckAt:undefined,updatedAt:stamp,message:BATCH9A3_RETRY_MESSAGES.temporaryStopped},now));continue;
    }
    if(hasExternalAttempt(task)&&!hasRecoverablePublisherDraftReceipt(task)&&!task.humanAction)continue;
    const checkpointReason=task.checkpoint==='referral_guard'?'referral_blocked'
      :task.checkpoint==='eligibility_wait'?'channel_ineligible':undefined;
    if(task.status==='needs_input'&&!hasExternalAttempt(task)&&task.reasonCode!=='submission_unknown'&&(checkpointReason||task.checkpoint==='ai_setup_required')){
      Object.assign(task,taskTransition(task,{reasonCode:checkpointReason,...(task.checkpoint==='ai_setup_required'?{checkpoint:'ai_setup_required'}:{}),humanAction:undefined,updatedAt:stamp},now));
    }
    if(task.status==='needs_input'&&!isHumanTaskReason(task.reasonCode)&&
      (task.humanAction||task.waitingSince||task.waitingDeadlineAt||task.waitingReminderAt)){
      Object.assign(task,taskTransition(task,{reasonCode:task.reasonCode,humanAction:undefined,updatedAt:stamp},now));
    }
    if(task.status==='failed'&&task.checkpoint==='system_wait'&&task.nextCheckAt&&tasks.some(other=>other.id!==task.id&&other.siteId===task.siteId&&(other.channelId===task.channelId||!!task.topicUrl&&canonicalPublicPageUrl(other.topicUrl)===canonicalPublicPageUrl(task.topicUrl))&&((hasExternalAttempt(other)&&!other.firstLiveAt)||(!!other.firstLiveAt&&Date.parse(other.firstLiveAt)>Date.parse(task.createdAt))||!['failed','skipped','expired','live'].includes(other.status)))){
      Object.assign(task,{recoveryEligible:false,nextCheckAt:undefined,message:'已有其他进行中任务、成功结果或待确认的提交，保留旧任务记录，不再恢复旧稿。'});continue;
    }
    if(task.status==='failed'&&['channel_wait','system_wait','article_rejected','invalid_topic'].includes(task.checkpoint??'')&&task.articleReview?.status==='failed'){
      const alternative=recoverWithAlternativeTopic(task,site,channel,tasks,settings,now);
      if(alternative.kind==='switched'||alternative.kind==='blocked')continue;
    }
    if(!hasExternalAttempt(task)&&task.status==='failed'&&task.checkpoint==='system_wait'&&((task.recoveryAttempts??0)>=1||(task.cost?.aiCalls??0)>=TASK_AI_BUDGET)&&(task.nextCheckAt!==undefined||task.recoveryEligible===true)){
      const reasonCode=(task.cost?.aiCalls??0)>=TASK_AI_BUDGET?'ai_task_limit':task.reasonCode??'temporary_failure';
      Object.assign(task,{reasonCode,cooldownUntil:taskCooldownUntil(reasonCode,now),recoveryEligible:false,nextCheckAt:undefined,updatedAt:stamp,message:TASK_FLOW_MESSAGES.recoveryExhausted});continue;
    }
    // Exactly one additional recovery cycle, on the original task and cumulative budget.
    if(task.status==='failed'&&task.checkpoint==='system_wait'&&(isTemporaryFailure(task)||task.recoveryEligible===true)&&task.nextCheckAt&&Date.parse(task.nextCheckAt)<=now.getTime()&&(task.recoveryAttempts??0)<1&&(task.cost?.aiCalls??0)<TASK_AI_BUDGET){
      Object.assign(task,taskTransition(task,{status:'queued',checkpoint:task.draft?'article_review':undefined,reasonCode:undefined,scheduledAt:stamp,updatedAt:stamp,nextCheckAt:undefined,recoveryAttempts:(task.recoveryAttempts??0)+1,recoveryEligible:false,attempts:0,message:'临时故障已过冷却期，将沿用原稿再做最后一轮 AI 复核（计入本篇 AI 次数）。'},now));continue;
    }
    if(task.status!=='needs_input'||hasExternalAttempt(task)&&!task.humanAction)continue;
    if(task.checkpoint==='waiting_email'&&task.emailWait)continue;
    const manualReview=task.checkpoint==='article_review'&&getArticleReviewMode(site,settings)==='manual';
    if(!isHumanTaskReason(task.reasonCode)&&!task.humanAction)continue;
    const proposed=createHumanAction(task,{...task.humanAction,url:task.humanAction?.url||channel.submitUrl},now);
    Object.assign(task,taskTransition(task,{reasonCode:task.reasonCode,humanAction:proposed},now));
    const action=task.humanAction;
    // A newly durable external attempt can retire a stale local handoff.
    if(!action)continue;
    const observed=new Date(action.since),deadline=new Date(action.deadline);
    task.waitingSince=action.since; // Old waits start when observed by this version, not retroactively.
    task.waitingDeadlineAt=action.deadline;
    if(now.getTime()>=deadline.getTime()){
      Object.assign(task,taskTransition(task,{status:'skipped',reasonCode:'human_timeout',deferredAt:undefined,recoveryEligible:false,nextCheckAt:undefined,updatedAt:stamp,message:isPendingPublisherRegistration(task)?TASK_FLOW_MESSAGES.registrationTimeout:TASK_FLOW_MESSAGES.humanTimeout},now));
      continue;
    }
    if(manualReview&&!task.waitingReminderAt&&now.getTime()>=observed.getTime()+24*3600000){task.waitingReminderAt=stamp;action.notifiedAt=stamp;task.updatedAt=stamp;reminders.push(task)}
  }
  return reminders;
}

/** Resume the preserved task; never create a second task to reset its budget. */
export function resumeDeferredTask(tasks:Task[],id:string,settings:Settings,now=new Date()){
  const task=tasks.find(item=>item.id===id);
  if(!task?.deferredAt||task.status!=='skipped')throw Error('只有已跳过并保留稿件的任务才能这样恢复；这个任务当前状态不符合，请刷新后再试。');
  if(task.reasonCode==='human_timeout')throw new TaskReasonError('human_timeout',TASK_REASON_MESSAGES.human_timeout);
  const registration=isPendingPublisherRegistration(task);
  if(hasExternalAttempt(task)&&!registration)throw Error('已有外部提交记录，不能重复执行');
  if((task.cost?.aiCalls??0)>=TASK_AI_BUDGET||task.attempts>=settings.maxAttempts)throw Error('该任务已达处理次数上限，请保留原记录核查原因');
  if(tasks.some(item=>item.id!==id&&item.siteId===task.siteId&&(item.channelId===task.channelId||!!task.topicUrl&&canonicalPublicPageUrl(item.topicUrl)===canonicalPublicPageUrl(task.topicUrl))&&(!['failed','skipped','expired'].includes(item.status)||hasExternalAttempt(item))))throw Error('同平台或选题已有其他任务，请先查看并合并已有记录');
  Object.assign(task,taskTransition(task,{status:registration?'needs_input':'queued',reasonCode:registration?'human_required':undefined,deferredAt:undefined,humanAction:undefined,waitingSince:undefined,waitingDeadlineAt:undefined,waitingReminderAt:undefined,scheduledAt:now.toISOString(),updatedAt:now.toISOString(),message:registration?'已恢复原账号验证等待；仅验证原发布账号，保留稿件和剩余次数，不会重新注册。':'已恢复保留的稿件；按当前发布模式继续，已使用的 AI 次数不重置。'},now));
}
