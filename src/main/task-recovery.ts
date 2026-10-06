import type {ArticleReviewReasonCode,Channel, Settings, Site, Task} from '../shared/types';
import {getArticleReviewMode} from '../shared/article-review-mode';
import {articleTopicLanguageScore,canonicalPublicPageUrl,hasBloggerDraftReceipt} from '../shared/publication';
import {isArticleTopicUrl} from '../shared/topic-policy';

export const TASK_AI_BUDGET=6;
const TEMPORARY=new Set(['ai_unavailable','evidence_fetch_failed','format_invalid','evidence_invalid']);
const ALTERNATIVE_TOPIC_CODES=new Set<ArticleReviewReasonCode>(['content_rejected','evidence_invalid','invalid_topic']);
/** A time limit is not permission to repeat an external or unknown operation. */
export function hasExternalAttempt(task:Task){return !!(task.submittedAt||task.publicUrl||task.firstLiveAt)||/submitt|uncertain|published|registration/.test(task.checkpoint??'')}

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
    const reserved=!!(other.submittedAt||other.publicUrl||other.firstLiveAt)||!['failed','skipped','expired'].includes(other.status);
    if(reserved)remember(other.topicUrl);
  }
  return (site.topics??[]).map((topic,index)=>({topic,index,canonical:canonicalPublicPageUrl(topic.url),language:articleTopicLanguageScore(topic,site.language),updated:Date.parse(topic.lastModified??topic.discoveredAt)}))
    .filter((item):item is typeof item&{canonical:string}=>!!item.canonical&&isArticleTopicUrl(item.canonical,site)&&!tried.has(item.canonical))
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
  if(!settings.autoRun||site.status!=='ready'||getArticleReviewMode(site,settings)!=='ai'||!channel.enabled||channel.automation==='manual'||channel.kind!=='article'||!channel.articleRequired||
    !['queued','running','failed'].includes(task.status)||!!task.deferredAt||hasExternalAttempt(task)||competingWork(task,tasks))return {kind:'ineligible'};
  const stamp=now.toISOString(),switched=task.topicSwitchAttempts??task.articleAttempts?.length??0;
  const block=(blockingReason:'invalid_topic'|'article_rejected'|'budget_exhausted',message:string):AlternativeTopicRecoveryResult=>{
    Object.assign(task,{status:'failed',checkpoint:blockingReason==='budget_exhausted'?'topic_recovery_budget':blockingReason,recoveryEligible:false,nextCheckAt:undefined,updatedAt:stamp,message});
    return {kind:'blocked',blockingReason,message};
  };
  if(switched>=1)return block(invalidCurrent?'invalid_topic':'article_rejected',invalidCurrent?'当前及备用选题均不是可用的正文页面，已停止该任务且不会重复换题。':'备用选题的稿件仍未通过独立核对，已达到一次换题上限。');
  if(TASK_AI_BUDGET-(task.cost?.aiCalls??0)<2)return block('budget_exhausted','当前任务不足两次 AI 调用额度，无法同时完成备用选题的新稿与独立审核；已在付费前停止。');
  const next=alternativeTopic(task,site,tasks);
  if(!next)return block(invalidCurrent?'invalid_topic':'article_rejected',invalidCurrent?'当前选题不是正文页面，且没有尚未尝试的有效备用选题；未调用 AI。':'稿件未通过独立核对，且没有尚未尝试的有效备用选题。');
  task.history??=[];task.history.push({at:stamp,status:task.status,message:task.message,linkCheck:task.linkCheck});task.history=task.history.slice(-50);
  task.articleAttempts=[...(task.articleAttempts??[]),{topicUrl:task.topicUrl,recordedAt:stamp,reason:task.articleReview?.reason??task.message,...(task.draft?{draft:structuredClone(task.draft)}:{}),...(task.draftRevision!==undefined?{draftRevision:task.draftRevision}:{}),...(task.articleRepairAttempts!==undefined?{articleRepairAttempts:task.articleRepairAttempts}:{}),...(task.articleReview?{articleReview:structuredClone(task.articleReview)}:{})}].slice(-1);
  Object.assign(task,{topicUrl:next,topicContentHash:undefined,topicSwitchAttempts:switched+1,draft:undefined,articleReview:undefined,articleApprovedAt:undefined,articleRepairAttempts:0,draftUpdatedAt:undefined,status:'queued',checkpoint:undefined,attempts:0,scheduledAt:stamp,updatedAt:stamp,nextCheckAt:undefined,recoveryEligible:false,message:'已保留上一选题的稿件与审核记录，正在同一任务内改用一个尚未尝试的正文选题；累计 AI 预算不重置。'});
  return {kind:'switched',topicUrl:next};
}

export function maintainWaitingTasks(tasks:Task[],sites:Site[],channels:Channel[],settings:Settings,now=new Date()){
  if(!settings.autoRun)return;
  const stamp=now.toISOString();
  for(const task of tasks){
    const site=sites.find(item=>item.id===task.siteId),channel=channels.find(item=>item.id===task.channelId);
    if(!site||site.status!=='ready'||!channel?.enabled||(hasExternalAttempt(task)&&!hasBloggerDraftReceipt(task))||task.deferredAt)continue;
    if(task.status==='failed'&&task.checkpoint==='system_wait'&&task.nextCheckAt&&tasks.some(other=>other.id!==task.id&&other.siteId===task.siteId&&(other.channelId===task.channelId||!!task.topicUrl&&canonicalPublicPageUrl(other.topicUrl)===canonicalPublicPageUrl(task.topicUrl))&&((hasExternalAttempt(other)&&!other.firstLiveAt)||(!!other.firstLiveAt&&Date.parse(other.firstLiveAt)>Date.parse(task.createdAt))||!['failed','skipped','expired','live'].includes(other.status)))){
      Object.assign(task,{recoveryEligible:false,nextCheckAt:undefined,message:'已有其他进行中任务、成功结果或待确认的提交，保留旧任务记录，不再恢复旧稿。'});continue;
    }
    if(task.status==='failed'&&['channel_wait','system_wait','article_rejected','invalid_topic'].includes(task.checkpoint??'')&&task.articleReview?.status==='failed'){
      const alternative=recoverWithAlternativeTopic(task,site,channel,tasks,settings,now);
      if(alternative.kind==='switched'||alternative.kind==='blocked')continue;
    }
    // Exactly one additional recovery cycle, on the original task and cumulative budget.
    if(task.status==='failed'&&task.checkpoint==='system_wait'&&(TEMPORARY.has(task.articleReview?.reasonCode??'')||task.recoveryEligible===true)&&task.nextCheckAt&&Date.parse(task.nextCheckAt)<=now.getTime()&&(task.recoveryAttempts??0)<1&&(task.cost?.aiCalls??0)<TASK_AI_BUDGET){
      Object.assign(task,{status:'queued',checkpoint:task.draft?'article_review':undefined,scheduledAt:stamp,updatedAt:stamp,nextCheckAt:undefined,recoveryAttempts:(task.recoveryAttempts??0)+1,recoveryEligible:false,attempts:0,message:'临时故障冷却结束，沿用原稿进行最后一轮有预算的自动核对。'});continue;
    }
    if(task.status!=='needs_input'||hasExternalAttempt(task))continue;
    const manualReview=task.checkpoint==='article_review'&&getArticleReviewMode(site,settings)==='manual';
    const human=manualReview||channel.automation==='manual'||task.checkpoint==='account_handoff'||/验证码|手机验证|身份验证|平台协议/.test(task.message);
    if(!human||/system_|channel_wait|ai_setup/.test(task.checkpoint??''))continue;
    task.waitingSince??=stamp; // Old waits start when observed by this version, not retroactively.
    if(now.getTime()-Date.parse(task.waitingSince)>=48*3600000){
      Object.assign(task,{status:'skipped',deferredAt:stamp,updatedAt:stamp,message:'等待本人处理已超过两天，已暂时搁置并保留稿件和账号；其他可执行任务继续。'});
    }
  }
}

/** Resume the preserved task; never create a second task to reset its budget. */
export function resumeDeferredTask(tasks:Task[],id:string,settings:Settings,now=new Date()){
  const task=tasks.find(item=>item.id===id);
  if(!task?.deferredAt||task.status!=='skipped')throw Error('该任务不是已搁置任务');
  if(hasExternalAttempt(task))throw Error('已有外部提交记录，不能重复执行');
  if((task.cost?.aiCalls??0)>=TASK_AI_BUDGET||task.attempts>=settings.maxAttempts)throw Error('该任务已达处理预算，请保留原记录核查原因');
  if(tasks.some(item=>item.id!==id&&item.siteId===task.siteId&&(item.channelId===task.channelId||!!task.topicUrl&&canonicalPublicPageUrl(item.topicUrl)===canonicalPublicPageUrl(task.topicUrl))&&(!['failed','skipped','expired'].includes(item.status)||hasExternalAttempt(item))))throw Error('同平台或选题已有其他任务，请先查看并合并已有记录');
  Object.assign(task,{status:'queued',deferredAt:undefined,waitingSince:undefined,scheduledAt:now.toISOString(),updatedAt:now.toISOString(),message:'已恢复保留的稿件；按当前发布模式继续，原调用预算不重置。'});
}
