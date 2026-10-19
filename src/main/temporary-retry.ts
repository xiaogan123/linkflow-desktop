import {randomUUID} from 'node:crypto';
import type {Task,TaskCost,TaskReasonCode} from '../shared/types';
import {hasUnresolvedExternalAttempt} from '../shared/publication';
import {schedulingDay} from '../shared/scheduling';
import {MAINTENANCE_MESSAGES} from '../shared/maintenance-messages';
import {BATCH9A3_RETRY_MESSAGES} from '../shared/batch9a3-messages';
import type {State} from './store';
import {taskTransition} from './task-state';
import {clearOtherChannelInputs} from './channel-inputs';

const FAILED_PLATFORM_TTL_MS=30*86400000;
export type TemporaryRetryStage='review'|'publish';
export interface TemporaryRetryOptions {scope?:'platform'|'independent';stage?:TemporaryRetryStage}

function canRetryLocally(task:Task):boolean{
  return !hasUnresolvedExternalAttempt(task)&&!task.submittedAt&&!task.publicUrl&&!task.batch5&&
    (!task.batch5Registration||task.batch5Registration.stage==='registered');
}

function exclusionTimestamp(task:Task,channelId:string):number{
  const value=task.failedPlatformAt?.[channelId]??task.updatedAt??task.createdAt;
  const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:0;
}

export function activeFailedPlatformIds(task:Task,now=new Date()):string[]{
  const cutoff=now.getTime()-FAILED_PLATFORM_TTL_MS;
  return [...new Set(task.failedPlatformIds??[])].filter(channelId=>exclusionTimestamp(task,channelId)>cutoff);
}

function failedPlatformPatch(task:Task,now:Date):Pick<Task,'failedPlatformIds'|'failedPlatformAt'>{
  const failedPlatformIds=[...new Set([...activeFailedPlatformIds(task,now),task.channelId].filter(Boolean))];
  const failedPlatformAt=Object.fromEntries(failedPlatformIds.map(channelId=>[channelId,
    channelId===task.channelId?now.toISOString():task.failedPlatformAt?.[channelId]??task.updatedAt??task.createdAt]));
  return {failedPlatformIds,failedPlatformAt};
}

function replacementPatch(task:Task,now:Date):Partial<Task>{
  return {status:'queued',reasonCode:undefined,checkpoint:undefined,temporaryRetryCount:0,attempts:0,
    temporaryRetryStage:undefined,temporaryBackoffCount:undefined,temporaryBackoffStartedAt:undefined,
    channelId:'',sourceDomain:'',accountId:undefined,...failedPlatformPatch(task,now),
    draft:undefined,articleReview:undefined,articleApprovedAt:undefined,evidenceSnapshot:undefined,factManifest:undefined,
    draftRevision:undefined,articleRepairAttempts:undefined,topicContentHash:undefined,articleReviewMigration:undefined,
    humanAction:undefined,waitingSince:undefined,waitingDeadlineAt:undefined,waitingReminderAt:undefined,
    cooldownUntil:undefined,deferredAt:undefined,reviewUntil:undefined,reconcileAfter:undefined,
    emailWaitRegisteredAt:undefined,emailWait:undefined,emailConfirmation:undefined,signup:undefined,temporaryPage:undefined,
    ...clearOtherChannelInputs(),
    scheduledAt:now.toISOString(),nextCheckAt:undefined,recoveryEligible:false,message:MAINTENANCE_MESSAGES.platformReplaced};
}

/** Only locally unsent work can retry or move. Receipt recovery never calls a publisher twice. */
export function temporaryRetry(task:Task,reasonCode:TaskReasonCode='temporary_failure',now=new Date(),options:TemporaryRetryOptions={}):Partial<Task>|undefined {
  if(!canRetryLocally(task)||task.replacementTaskId)return undefined;
  const scope=options.scope??'platform',stage=options.stage??'publish';
  if(scope==='independent'){
    const count=task.temporaryBackoffCount??0,startedAt=task.temporaryBackoffStartedAt??now.toISOString();
    if(count>=3||now.getTime()-Date.parse(startedAt)>=72*3600000)return {
      status:'failed',reasonCode,checkpoint:'system_wait',temporaryBackoffStartedAt:startedAt,
      recoveryEligible:false,nextCheckAt:undefined,message:BATCH9A3_RETRY_MESSAGES.temporaryStopped,
    };
    const hours=count===0?2:8;
    const scheduledAt=new Date(now.getTime()+hours*3600000).toISOString();
    return {status:'queued',reasonCode,temporaryBackoffCount:count+1,temporaryBackoffStartedAt:startedAt,
      scheduledAt,nextCheckAt:scheduledAt,recoveryEligible:false,message:MAINTENANCE_MESSAGES.temporaryRetry(hours)};
  }
  const count=task.temporaryRetryStage===undefined||task.temporaryRetryStage===stage?task.temporaryRetryCount??0:0,hours=[2,8][count];
  if(hours!==undefined){
    const scheduledAt=new Date(now.getTime()+hours*3600000).toISOString();
    return {status:'queued',reasonCode,temporaryRetryCount:count+1,temporaryRetryStage:stage,attempts:Math.max(0,task.attempts-1),
      scheduledAt,nextCheckAt:scheduledAt,recoveryEligible:false,message:MAINTENANCE_MESSAGES.temporaryRetry(hours)};
  }
  // A registered Batch 5 summary is tied to its original channel and account.
  // Call applyTemporaryRetryState so the journal remains on a skipped task.
  if(task.batch5Registration||task.signup||task.oneReviewRetry)return undefined;
  return replacementPatch(task,now);
}

export type TemporaryRetryResult={kind:'retry'|'switched'|'replaced'|'blocked'|'already_replaced';taskId?:string};

/** Apply retry and channel switch inside one Store.update transaction. */
export function applyTemporaryRetryState(state:State,taskId:string,reasonCode:TaskReasonCode='temporary_failure',now=new Date(),options:TemporaryRetryOptions={}):TemporaryRetryResult{
  const task=state.tasks.find(item=>item.id===taskId);
  if(!task)return {kind:'blocked'};
  if(task.replacementTaskId)return {kind:'already_replaced',taskId:task.replacementTaskId};
  if(!canRetryLocally(task))return {kind:'blocked'};
  const retry=temporaryRetry(task,reasonCode,now,options);
  const switching=retry?.channelId==='';
  if(retry&&!switching){
    Object.assign(task,taskTransition(task,retry,now),{updatedAt:now.toISOString()});
    return {kind:'retry',taskId};
  }
  if(options.scope==='independent')return {kind:'blocked'};
  if(!task.batch5Registration&&!task.signup&&!task.oneReviewRetry){
    if(!retry)return {kind:'blocked'};
    const site=state.sites.find(item=>item.id===task.siteId);if(!site)return {kind:'blocked'};
    const zone=site.timezone??state.settings.timezone;
    Object.assign(task,taskTransition(task,retry,now,true),{updatedAt:now.toISOString()});
    task.scheduling??={version:1,month:schedulingDay(now,zone).slice(0,7),slot:0,
      target:site.monthlyTarget,effectiveTarget:site.planStatus?.effectiveTarget??site.monthlyTarget,reschedules:0};
    return {kind:'switched',taskId};
  }
  const site=state.sites.find(item=>item.id===task.siteId);
  if(!site||task.batch5Registration&&task.batch5Registration.stage!=='registered')return {kind:'blocked'};
  const replacementId=randomUUID(),stamp=now.toISOString(),zone=site.timezone??state.settings.timezone;
  const replacement:Task={
    id:replacementId,siteId:task.siteId,channelId:'',sourceDomain:'',status:'queued',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,
    attempts:0,message:MAINTENANCE_MESSAGES.platformReplaced,replacesTaskId:task.id,
    ...failedPlatformPatch(task,now),temporaryRetryCount:0,temporaryRetryStage:undefined,temporaryBackoffCount:undefined,
    ...(task.cost?{cost:structuredClone(task.cost)}:{}),
    scheduling:{version:1,month:schedulingDay(now,zone).slice(0,7),slot:task.scheduling?.slot??0,
      target:site.monthlyTarget,effectiveTarget:site.planStatus?.effectiveTarget??site.monthlyTarget,reschedules:0},
  };
  // Preserve the original account, registration summary and encrypted journal.
  Object.assign(task,taskTransition(task,{status:'skipped',reasonCode,checkpoint:'platform_replaced',
    nextCheckAt:undefined,recoveryEligible:false,message:MAINTENANCE_MESSAGES.platformReplaced,replacementTaskId:replacementId},now),{updatedAt:stamp});
  state.tasks.push(replacement);
  return {kind:'replaced',taskId:replacementId};
}

/** Replacement tasks carry cumulative cost for budget checks; only their delta is newly incurred. */
export function incrementalTaskCost(task:Task,tasks:readonly Task[]):TaskCost|undefined{
  const cost=task.cost;if(!cost)return;
  const previous=task.replacesTaskId?tasks.find(item=>item.id===task.replacesTaskId)?.cost:undefined;
  if(!previous)return {...cost};
  const difference=(key:'aiCalls'|'durationMs'|'inputTokens'|'outputTokens')=>Math.max(0,(cost[key]??0)-(previous[key]??0));
  const sameCurrency=(cost.currency??'')===(previous.currency??'');
  return {aiCalls:difference('aiCalls'),durationMs:difference('durationMs'),inputTokens:difference('inputTokens'),
    outputTokens:difference('outputTokens'),
    ...(cost.amount!==undefined?{amount:sameCurrency?Math.max(0,cost.amount-(previous.amount??0)):cost.amount}:{}),
    ...(cost.currency?{currency:cost.currency}:{})};
}

export interface ActualCostSummary {aiCalls:number;durationMs:number;inputTokens:number;outputTokens:number;amountsByCurrency:Record<string,number>}
export function totalActualTaskCost(tasks:readonly Task[]):ActualCostSummary{
  const summary:ActualCostSummary={aiCalls:0,durationMs:0,inputTokens:0,outputTokens:0,amountsByCurrency:{}};
  for(const task of tasks){
    const cost=incrementalTaskCost(task,tasks);if(!cost)continue;
    summary.aiCalls+=cost.aiCalls;summary.durationMs+=cost.durationMs??0;summary.inputTokens+=cost.inputTokens??0;summary.outputTokens+=cost.outputTokens??0;
    if(cost.amount!==undefined){const currency=cost.currency??'unknown';summary.amountsByCurrency[currency]=(summary.amountsByCurrency[currency]??0)+cost.amount;}
  }
  return summary;
}
