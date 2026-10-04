import type {Channel, Settings, Site, Task} from '../shared/types';
import {getArticleReviewMode} from '../shared/article-review-mode';
import {canonicalPublicPageUrl,hasBloggerDraftReceipt} from '../shared/publication';

export const TASK_AI_BUDGET=6;
const TEMPORARY=new Set(['ai_unavailable','evidence_fetch_failed','format_invalid','evidence_invalid']);
/** A time limit is not permission to repeat an external or unknown operation. */
export function hasExternalAttempt(task:Task){return !!(task.submittedAt||task.publicUrl||task.firstLiveAt)||/submitt|uncertain|published|registration/.test(task.checkpoint??'')}
export function maintainWaitingTasks(tasks:Task[],sites:Site[],channels:Channel[],settings:Settings,now=new Date()){
  if(!settings.autoRun)return;
  const stamp=now.toISOString();
  for(const task of tasks){
    const site=sites.find(item=>item.id===task.siteId),channel=channels.find(item=>item.id===task.channelId);
    if(!site||site.status!=='ready'||!channel?.enabled||(hasExternalAttempt(task)&&!hasBloggerDraftReceipt(task))||task.deferredAt)continue;
    if(task.status==='failed'&&task.checkpoint==='system_wait'&&task.nextCheckAt&&tasks.some(other=>other.id!==task.id&&other.siteId===task.siteId&&(other.channelId===task.channelId||!!task.topicUrl&&canonicalPublicPageUrl(other.topicUrl)===canonicalPublicPageUrl(task.topicUrl))&&((hasExternalAttempt(other)&&!other.firstLiveAt)||(!!other.firstLiveAt&&Date.parse(other.firstLiveAt)>Date.parse(task.createdAt))||!['failed','skipped','expired','live'].includes(other.status)))){
      Object.assign(task,{recoveryEligible:false,nextCheckAt:undefined,message:'已有其他进行中任务、成功结果或待确认的提交，保留旧任务记录，不再恢复旧稿。'});continue;
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
