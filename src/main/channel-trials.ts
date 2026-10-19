import type {Channel,Settings,Task} from '../shared/types';
import {BATCH5_MESSAGES} from '../shared/batch5-messages';
import {TRIAL_MESSAGES} from '../shared/trial-messages';
import type {State} from './store';

const TRIAL_ACCEPTANCE_MS=7*24*60*60*1000;

export interface ChannelTrialState {
  trial: boolean;
  activeTaskId?: string;
  failures: number;
  /** Legacy task history also lets a late accepted page undo an earlier failure. */
  evaluatedTaskIds: string[];
  evaluatedFailureOperationIds?: string[];
  /** A claim after a released failure starts a new attempt, even for the same task. */
  attemptSequence?: number;
  activeAttemptSequence?: number;
  lastEvaluatedAttemptSequence?: number;
  autoDisabledOverride?: boolean;
  promotedAt?: string;
  disabledAt?: string;
  reason?: string;
}

function acceptedTrialPage(task:Task):boolean {
  return !!task.firstLiveAt&&task.linkCheck==='found'&&task.linkIndexable===true;
}

function legacyTrialAttempt(task:Task):boolean {
  if(task.firstLiveAt||['failed','skipped','expired','live'].includes(task.status))return false;
  return task.status==='running'||task.status==='review'||task.status==='needs_input'&&
    (!!task.submittedAt||task.reasonCode==='submission_unknown'||unresolvedRegistration(task));
}

export function channelIsTrial(channel:Channel,settings:Settings):boolean {
  if(channel.trial===false)return false;
  return settings.channelTrials?.[channel.id]?.trial ?? channel.trial ?? false;
}

/** Existing published pages predate the trial lease; terminal old tasks do not reserve it. */
export function migrateChannelTrials(state:State,channels:Channel[]):void {
  state.settings.channelTrials??={};
  for(const channel of channels){
    const existing=state.settings.channelTrials[channel.id];
    // Presence is the migration marker. Runtime reconciliation owns an existing
    // lease; rescanning all history on every restart could promote an unrelated task.
    if(existing||!channel.trial)continue;
    const tasks=state.tasks.filter(task=>task.channelId===channel.id);
    const historicalSuccess=tasks.find(acceptedTrialPage);
    const legacyActive=historicalSuccess?undefined:tasks.find(legacyTrialAttempt);
    const trial:ChannelTrialState={trial:true,failures:0,evaluatedTaskIds:[]};
    state.settings.channelTrials[channel.id]=trial;
    if(historicalSuccess){
      trial.trial=false;
      trial.promotedAt=historicalSuccess.firstLiveAt!;
      trial.evaluatedTaskIds.push(historicalSuccess.id);
    }else if(legacyActive){
      trial.activeTaskId=legacyActive.id;
      trial.attemptSequence=1;
      trial.activeAttemptSequence=1;
    }
  }
}

function unresolvedRegistration(task:Task):boolean {
  const registration=task.batch5Registration;
  return !task.batch5&&!task.submittedAt&&(
    task.checkpoint==='batch5_account_pending'&&task.reasonCode==='submission_unknown'||!!registration&&(
    registration.stage==='sending'||registration.stage==='request_unknown'||
    registration.stage==='reserved'&&registration.sendGuardVersion!==1));
}

function unresolvedRegistrationAcceptance(task:Task):{startedAt:string;operationId:string}|undefined {
  const registration=task.batch5Registration;
  if(!unresolvedRegistration(task))return undefined;
  if(!registration)return {startedAt:task.createdAt,operationId:task.id};
  return ['reserved','sending','request_unknown'].includes(registration.stage)
    ?{startedAt:registration.sentAt??registration.createdAt,operationId:registration.operationId}:undefined;
}

/** Reads keep running after a lease expires; these checkpoints never authorize a write. */
export function trialVerificationNextCheck(task:Task,now=new Date()):string|undefined {
  const started=Date.parse(task.trialSendStartedAt??task.submittedAt??'');
  if(task.firstLiveAt||!Number.isFinite(started))return undefined;
  const next=[6,24,72,168].map(hours=>started+hours*3600000).find(at=>at>now.getTime());
  return next===undefined?undefined:new Date(next).toISOString();
}

export function trialTaskAvailable(state:State,channel:Channel,taskId:string):boolean {
  if(!channelIsTrial(channel,state.settings))return true;
  const trial=state.settings.channelTrials?.[channel.id];
  if(trial?.disabledAt||trial?.activeTaskId&&trial.activeTaskId!==taskId)return false;
  // A timed-out publication remains read-only. Reclaiming that same task must
  // never turn its released trial slot into another write opportunity.
  const task=state.tasks.find(value=>value.id===taskId);
  if(!trial?.activeTaskId&&trial?.evaluatedTaskIds.includes(taskId)&&task&&(!!task.submittedAt||unresolvedRegistration(task)))return false;
  return true;
}

/** Acquired in the same state transaction that starts an execution attempt. */
export function claimChannelTrial(state:State,channel:Channel,task:Task):boolean {
  if(!channelIsTrial(channel,state.settings))return true;
  if(!trialTaskAvailable(state,channel,task.id))return false;
  state.settings.channelTrials??={};
  const trial=state.settings.channelTrials[channel.id]??={trial:true,failures:0,evaluatedTaskIds:[]};
  if(trial.activeTaskId===task.id)return true;
  trial.attemptSequence=(trial.attemptSequence??0)+1;
  trial.activeAttemptSequence=trial.attemptSequence;
  trial.activeTaskId=task.id;
  // A publisher must explicitly mark a failure in this attempt. A previous
  // attempt's evidence must not be counted again as soon as the task is reclaimed.
  task.trialFailure=undefined;
  task.trialFailureOperationId=undefined;
  return true;
}

function releaseTrial(trial:ChannelTrialState,task?:Task):void {
  if(task&&!trial.evaluatedTaskIds.includes(task.id))trial.evaluatedTaskIds.push(task.id);
  trial.lastEvaluatedAttemptSequence=trial.activeAttemptSequence;
  trial.activeTaskId=undefined;
  trial.activeAttemptSequence=undefined;
}

function promoteTrial(state:State,channel:Channel,trial:ChannelTrialState,task:Task,now:Date):void {
  const wasAutoDisabled=!!trial.disabledAt&&trial.autoDisabledOverride!==false;
  trial.trial=false;
  trial.failures=0;
  trial.promotedAt=now.toISOString();
  trial.disabledAt=undefined;
  trial.reason=undefined;
  releaseTrial(trial,task);
  if(wasAutoDisabled)delete state.settings.channelOverrides[channel.id];
  trial.autoDisabledOverride=undefined;
}

/** Reconcile one current attempt; old results can still turn a trial into a proven channel. */
export function reconcileChannelTrials(state:State,channels:Channel[],now=new Date()):void {
  const temporary=new Set(channels.filter(channel=>channel.retentionDays!==undefined).map(channel=>channel.id));
  for(const task of state.tasks)if(temporary.has(task.channelId))task.temporaryPage=true;
  for(const channel of channels){
    if(!channelIsTrial(channel,state.settings))continue;
    const trial=state.settings.channelTrials?.[channel.id];
    if(!trial)continue;
    // Only an explicit true can be distinguished from the false written by the
    // automatic stop. Re-enabling starts a fresh two-attempt trial.
    if(trial.disabledAt&&state.settings.channelOverrides[channel.id]===true){
      trial.disabledAt=undefined;
      trial.autoDisabledOverride=undefined;
      trial.failures=0;
      trial.reason=undefined;
    }
    // The verifier may discover a page after its trial failure was counted,
    // including after the second failure automatically disabled the channel.
    const accepted=state.tasks.find(task=>task.channelId===channel.id&&acceptedTrialPage(task)
      &&(task.id===trial.activeTaskId||trial.evaluatedTaskIds.includes(task.id)));
    if(accepted){promoteTrial(state,channel,trial,accepted,now);continue;}
    if(trial.disabledAt)continue;
    const task=state.tasks.find(value=>value.id===trial.activeTaskId);
    if(!task){delete trial.activeTaskId;delete trial.activeAttemptSequence;continue;}
    if(trial.activeAttemptSequence!==undefined&&trial.lastEvaluatedAttemptSequence===trial.activeAttemptSequence){
      releaseTrial(trial);continue;
    }
    // An old state could re-claim a task after taskId-only evaluation. Release
    // that stale lease; the next claim receives a fresh sequence number.
    if(trial.activeAttemptSequence===undefined&&trial.evaluatedTaskIds.includes(task.id)){
      releaseTrial(trial);continue;
    }
    // A definite negative response caused by our payload or credentials is a
    // finished write attempt, not a page waiting for first acceptance. Keep its
    // durable submittedAt for replay protection, but release the experiment.
    if(task.checkpoint==='batch5_rejected'&&['format_invalid','account_handoff'].includes(task.reasonCode??'')){
      task.trialFailure=undefined;
      releaseTrial(trial,task);
      continue;
    }
    if(task.status==='skipped'){
      task.trialFailure=undefined;
      releaseTrial(trial,task);
      continue;
    }
    if(!task.submittedAt&&!unresolvedRegistration(task)&&state.sites.some(site=>site.id===task.siteId&&site.status!=='ready')){
      task.trialFailure=undefined;
      releaseTrial(trial,task);
      continue;
    }
    let failure=task.trialFailure;
    if(!failure&&!task.firstLiveAt){
      const registration=unresolvedRegistrationAcceptance(task);
      const started=Date.parse(registration?.startedAt??task.trialSendStartedAt??task.submittedAt??'');
      if(Number.isFinite(started)&&now.getTime()-started>=TRIAL_ACCEPTANCE_MS){
        const definite=task.trialLastDefinitiveOutcome??task.linkCheck;
        if(definite==='absent'||definite==='invalid'){
          failure=TRIAL_MESSAGES.acceptanceTimedOut;
          task.trialFailure=failure;
        }else{
          // Offline time, unknown signup results and unreadable pages provide no
          // evidence about the platform. Release capacity without permitting a resend.
          releaseTrial(trial,task);
          continue;
        }
      }
    }
    if(failure){
      const operationId=task.trialFailureOperationId;
      if(operationId&&trial.evaluatedFailureOperationIds?.includes(operationId)){
        releaseTrial(trial,task);continue;
      }
      if(operationId)(trial.evaluatedFailureOperationIds??=[]).push(operationId);
      trial.failures++;trial.reason=failure;releaseTrial(trial,task);
      if(trial.failures>=2){
        trial.disabledAt=now.toISOString();trial.autoDisabledOverride=state.settings.channelOverrides[channel.id]!==false;state.settings.channelOverrides[channel.id]=false;
        task.status='needs_input';task.message=`${BATCH5_MESSAGES.trialDisabled} ${failure}`;
        task.reasonCode='channel_disabled';
      }
    }else if(!task.submittedAt&&!unresolvedRegistration(task)&&(
      task.status==='queued'&&(!task.batch5||task.batch5.stage==='reserved')||
      ['failed','skipped','expired','needs_input'].includes(task.status))){
      // Local writing or setup failures release the lease without judging the platform.
      trial.activeTaskId=undefined;trial.activeAttemptSequence=undefined;
    }
  }
}
