import {siteMonthTarget} from '../shared/scheduling';
import {hasRemotePublicationIntent,hasUnresolvedExternalAttempt,reservesMonthlySlot} from '../shared/publication';
import type {Channel,Task} from '../shared/types';
import {boundAccount} from './account-bindings';
import {currentArticlePublicationContext} from './article-publication-context';
import {articleReviewStillValid} from './article-review';
import {monthKey} from './planner';
import type {State} from './store';
import {taskTransition} from './task-state';
import {TASK_AI_BUDGET,hasExternalAttempt} from './task-recovery';

/** A reservation holding nothing: no platform, draft, AI spend or attempt. Deleting one loses no work. */
export function isEmptyReservation(task:Task):boolean{
  return task.status==='queued'&&!task.channelId&&!task.sourceDomain&&!task.draft&&!task.cost?.aiCalls&&!task.attempts
    &&!task.submittedAt&&!task.publicUrl&&!task.firstLiveAt&&!task.humanAction&&!task.deferredAt&&!task.temporaryPage&&!task.recoveredAt
    &&!hasUnresolvedExternalAttempt(task)&&!hasRemotePublicationIntent(task);
}

/** Up to 1.2.43 every AI-limited day re-created a site's reservation each minute; keep only what the month's target allows. */
function pruneSurplusReservations(state:State,now:Date):number{
  let removed=0;
  for(const site of state.sites){
    const timeZone=site.timezone??state.settings.timezone,month=monthKey(now,timeZone),own=state.tasks.filter(task=>task.siteId===site.id);
    const empty=own.filter(isEmptyReservation).sort((a,b)=>a.scheduledAt.localeCompare(b.scheduledAt)||a.id.localeCompare(b.id));
    if(!empty.length)continue;
    const emptyIds=new Set(empty.map(task=>task.id));
    const occupied=own.filter(task=>!emptyIds.has(task.id)&&!task.temporaryPage&&!task.recoveredAt&&(!!task.firstLiveAt||reservesMonthlySlot(task,now,timeZone)||hasUnresolvedExternalAttempt(task))&&monthKey(task.submittedAt??task.firstLiveAt??task.scheduledAt,timeZone)===month).length;
    let room=Math.max(0,siteMonthTarget(site,now,state.settings.timezone)-occupied);
    const keep=new Set<string>();
    for(const task of empty){
      if(room>0&&(reservesMonthlySlot(task,now,timeZone))){keep.add(task.id);room--}
    }
    const drop=new Set(empty.filter(task=>!keep.has(task.id)).map(task=>task.id));
    if(!drop.size)continue;
    state.tasks=state.tasks.filter(task=>!drop.has(task.id));
    removed+=drop.size;
  }
  return removed;
}

/** Fully reviewed drafts that timed out only because a publisher hand-off was wrongly shown as a manual review. */
function restoreTimedOutDrafts(state:State,channels:Channel[],now:Date):number{
  let restored=0;const stamp=now.toISOString();
  for(const task of state.tasks){
    if(task.status!=='skipped'||task.reasonCode!=='human_timeout'||task.checkpoint!=='article_review'||!task.draft||task.articleReview?.status!=='passed')continue;
    const site=state.sites.find(item=>item.id===task.siteId&&item.status==='ready'),channel=channels.find(item=>item.id===task.channelId);
    if(!site||!channel?.enabled||channel.accountRequired||hasExternalAttempt(task)||hasRemotePublicationIntent(task)||task.submittedAt||task.publicUrl||task.firstLiveAt||task.attempts>=state.settings.maxAttempts)continue;
    if(state.tasks.some(other=>other.id!==task.id&&other.siteId===task.siteId&&(other.channelId===task.channelId||!!task.topicUrl&&other.topicUrl===task.topicUrl)&&(!['failed','skipped','expired'].includes(other.status)||hasExternalAttempt(other))))continue;
    const reviewValid=articleReviewStillValid(task,site,channel,state.settings,boundAccount(state,task),currentArticlePublicationContext(state.tasks,task));
    if(!reviewValid&&(task.cost?.aiCalls??0)>=TASK_AI_BUDGET)continue;
    // human_timeout is final for a real wait on a person; this wait never needed one, so only this repair lifts it.
    const before=structuredClone(task);
    try{
      task.reasonCode=undefined;
      Object.assign(task,taskTransition(task,{status:'queued',reasonCode:undefined,deferredAt:undefined,humanAction:undefined,waitingSince:undefined,waitingDeadlineAt:undefined,waitingReminderAt:undefined,cooldownUntil:undefined,scheduledAt:stamp,updatedAt:stamp,nextCheckAt:undefined,...(reviewValid?{}:{articleReview:undefined,articleApprovedAt:undefined}),message:'原稿已恢复，继续自动发布。'},now,true));
      restored++;
    }catch{Object.keys(task).forEach(key=>delete (task as unknown as Record<string,unknown>)[key]);Object.assign(task,before)}
  }
  return restored;
}

/** One-shot repair of the state left by 1.2.43 and earlier; afterwards the planner keeps it clean. */
export function repairQueueOnce(state:State,channels:Channel[],now=new Date()):{restored:number;removed:number}|undefined{
  if(state.queueRepair===1)return;
  const restored=restoreTimedOutDrafts(state,channels,now),removed=pruneSurplusReservations(state,now);
  state.queueRepair=1;
  return {restored,removed};
}
