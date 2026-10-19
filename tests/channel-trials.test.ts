import assert from 'node:assert/strict';
import test from 'node:test';
import {CHANNELS} from '../src/integrations/catalog';
import {claimChannelTrial,migrateChannelTrials,reconcileChannelTrials,trialTaskAvailable,channelIsTrial,trialVerificationNextCheck} from '../src/main/channel-trials';
import {validateBackup} from '../src/main/backup-validation';
import {emptyState,migrateState} from '../src/main/store';
import type {Task} from '../src/shared/types';

const channel=CHANNELS.find(value=>value.id==='yeetmd')!;
const submitted='2026-10-01T00:00:00.000Z';
const taskId='11111111-1111-4111-8111-111111111111';
const nextId='22222222-2222-4222-8222-222222222222';
const siteId='33333333-3333-4333-8333-333333333333';
function task(id=taskId):Task{return {id,siteId,channelId:channel.id,sourceDomain:channel.domain,status:'running',createdAt:submitted,scheduledAt:submitted,updatedAt:submitted,attempts:1,message:'fixture'};}
function state(){
  const value=emptyState();
  value.settings.timezone='UTC';
  value.sites=[{id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Fixture',category:'general',language:'en',monthlyTarget:2,status:'ready',createdAt:submitted}];
  value.tasks=[task()];
  return value;
}

test('a repeated claim keeps one attempt; a later claim of the same task can promote',()=>{
  const value=state(),current=value.tasks[0];
  assert.equal(claimChannelTrial(value,channel,current),true);
  assert.equal(claimChannelTrial(value,channel,current),true);
  assert.equal(value.settings.channelTrials?.yeetmd.attemptSequence,1);
  current.status='failed';current.reasonCode='platform_rate_limited';current.trialFailure='publisher rate limit';
  reconcileChannelTrials(value,[channel],new Date(submitted));
  assert.equal(value.settings.channelTrials?.yeetmd.failures,1);
  assert.equal(value.settings.channelTrials?.yeetmd.activeTaskId,undefined);

  current.status='running';
  assert.equal(claimChannelTrial(value,channel,current),true);
  assert.equal(value.settings.channelTrials?.yeetmd.attemptSequence,2);
  assert.equal(current.trialFailure,undefined);
  reconcileChannelTrials(value,[channel],new Date(submitted));
  assert.equal(value.settings.channelTrials?.yeetmd.failures,1);
  Object.assign(current,{status:'live',firstLiveAt:submitted,linkCheck:'found',linkIndexable:true});
  reconcileChannelTrials(value,[channel],new Date(submitted));
  assert.equal(value.settings.channelTrials?.yeetmd.trial,false);
  assert.equal(value.settings.channelTrials?.yeetmd.failures,0);
  assert.doesNotThrow(()=>validateBackup({state:value,secrets:{}}));
});

test('AI and bare reason codes do not count as platform failures',()=>{
  const value=state(),current=value.tasks[0];
  claimChannelTrial(value,channel,current);
  Object.assign(current,{status:'failed',reasonCode:'ai_rate_limited'});
  reconcileChannelTrials(value,[channel]);
  assert.equal(value.settings.channelTrials?.yeetmd.failures,0);
  current.status='running';claimChannelTrial(value,channel,current);
  Object.assign(current,{status:'failed',reasonCode:'platform_rejected'});
  reconcileChannelTrials(value,[channel]);
  assert.equal(value.settings.channelTrials?.yeetmd.failures,0);
  assert.equal(value.settings.channelTrials?.yeetmd.activeTaskId,undefined);
});

test('late valid readback promotes a trial after two failures auto-disable it',()=>{
  const value=state(),first=value.tasks[0];
  claimChannelTrial(value,channel,first);
  first.trialFailure='first failure';first.status='review';first.submittedAt=submitted;
  reconcileChannelTrials(value,[channel],new Date(submitted));
  const second=task(nextId);value.tasks.push(second);
  claimChannelTrial(value,channel,second);
  second.trialFailure='second failure';second.status='failed';
  reconcileChannelTrials(value,[channel],new Date(submitted));
  assert.equal(value.settings.channelTrials?.yeetmd.disabledAt,submitted);
  assert.equal(value.settings.channelOverrides.yeetmd,false);

  Object.assign(first,{status:'live',firstLiveAt:submitted,linkCheck:'found',linkIndexable:true});
  reconcileChannelTrials(value,[channel],new Date('2026-10-02T00:00:00.000Z'));
  assert.equal(value.settings.channelTrials?.yeetmd.trial,false);
  assert.equal(value.settings.channelTrials?.yeetmd.disabledAt,undefined);
  assert.equal(value.settings.channelTrials?.yeetmd.failures,0);
  assert.equal(value.settings.channelOverrides.yeetmd,undefined);
});

test('an explicit user enable starts a fresh trial after an automatic stop',()=>{
  const value=state(),trial={trial:true,failures:2,evaluatedTaskIds:[taskId],disabledAt:submitted,autoDisabledOverride:true,reason:'fixture'};
  value.settings.channelTrials={yeetmd:trial};
  value.settings.channelOverrides.yeetmd=false;
  reconcileChannelTrials(value,[channel],new Date(submitted));
  assert.equal(trial.disabledAt,submitted);
  value.settings.channelOverrides.yeetmd=true;
  reconcileChannelTrials(value,[channel],new Date(submitted));
  assert.equal(trial.disabledAt,undefined);
  assert.equal(trial.failures,0);
  assert.equal(trial.reason,undefined);
  assert.equal(trial.autoDisabledOverride,undefined);
  assert.equal(trialTaskAvailable(value,channel,nextId),true);
});

test('a user can re-enable after closing a channel before its second in-flight failure',()=>{
  const value=state(),first=value.tasks[0];
  claimChannelTrial(value,channel,first);
  first.trialFailure='first failure';
  reconcileChannelTrials(value,[channel],new Date(submitted));
  const second=task(nextId);value.tasks.push(second);
  assert.equal(claimChannelTrial(value,channel,second),true);
  value.settings.channelOverrides.yeetmd=false;
  second.trialFailure='second failure';
  reconcileChannelTrials(value,[channel],new Date(submitted));
  const trial=value.settings.channelTrials!.yeetmd;
  assert.equal(trial.disabledAt,submitted);
  assert.equal(trial.autoDisabledOverride,false);
  assert.equal(trialTaskAvailable(value,channel,'next-attempt'),false);
  value.settings.channelOverrides.yeetmd=true;
  reconcileChannelTrials(value,[channel],new Date(submitted));
  assert.equal(trial.disabledAt,undefined);
  assert.equal(trial.failures,0);
  assert.equal(trialTaskAvailable(value,channel,'next-attempt'),true);
});

test('unreachable read waits; seven-day acceptance timeout releases without failure and releases the lease',()=>{
  const value=state(),current=value.tasks[0];
  claimChannelTrial(value,channel,current);
  Object.assign(current,{status:'review',submittedAt:submitted,publicUrl:'https://yeet.md/s/fixture',linkCheck:'unreachable'});
  reconcileChannelTrials(value,[channel],new Date('2026-10-07T23:59:59.000Z'));
  assert.equal(value.settings.channelTrials?.yeetmd.failures,0);
  assert.equal(value.settings.channelTrials?.yeetmd.activeTaskId,taskId);
  reconcileChannelTrials(value,[channel],new Date('2026-10-08T00:00:00.000Z'));
  reconcileChannelTrials(value,[channel],new Date('2026-10-09T00:00:00.000Z'));
  assert.equal(value.settings.channelTrials?.yeetmd.failures,0);
  assert.equal(value.settings.channelTrials?.yeetmd.activeTaskId,undefined);
  assert.equal(trialTaskAvailable(value,channel,nextId),true);
  assert.equal(trialTaskAvailable(value,channel,taskId),false);
  assert.equal(current.status,'review');
  assert.equal(current.submittedAt,submitted);
  assert.equal(current.publicUrl,'https://yeet.md/s/fixture');
  assert.equal(current.trialFailure,undefined);
});

test('skipping a submitted trial releases its lease without judging the platform',()=>{
  const value=state(),current=value.tasks[0];
  claimChannelTrial(value,channel,current);
  Object.assign(current,{status:'skipped',submittedAt:submitted,publicUrl:'https://yeet.md/s/fixture',linkCheck:'unreachable'});
  reconcileChannelTrials(value,[channel],new Date('2026-10-20T00:00:00.000Z'));
  assert.equal(value.settings.channelTrials?.yeetmd.failures,0);
  assert.equal(value.settings.channelTrials?.yeetmd.activeTaskId,undefined);
  assert.equal(current.trialFailure,undefined);
  assert.equal(trialTaskAvailable(value,channel,nextId),true);
  assert.equal(trialTaskAvailable(value,channel,taskId),false);
});

test('migration promotes historical live pages and ignores old terminal submissions',()=>{
  const successful=state();
  Object.assign(successful.tasks[0],{status:'live',submittedAt:submitted,firstLiveAt:submitted,linkCheck:'found',linkIndexable:true});
  delete successful.settings.channelTrials;
  const promoted=migrateState(successful);
  assert.equal(promoted.settings.channelTrials?.yeetmd.trial,false);

  for(const status of ['failed','skipped','expired'] as const){
    const old=state();old.tasks[0].status=status;old.tasks[0].submittedAt=submitted;
    delete old.settings.channelTrials;
    const restored=migrateState(old);
    assert.equal(restored.settings.channelTrials?.yeetmd.trial,true);
    assert.equal(trialTaskAvailable(restored,channel,nextId),true);
  }
});

test('new states already carry trial migration markers and keep them across a backup roundtrip',()=>{
  const fresh=emptyState();
  assert.deepEqual(validateBackup({state:fresh,secrets:{}}).state,fresh);
  const value=state();
  assert.equal(value.settings.channelTrials?.yeetmd.trial,true);
  Object.assign(value.tasks[0],{status:'live',firstLiveAt:submitted,linkCheck:'found',linkIndexable:true});
  const restored=validateBackup({state:value,secrets:{}});
  assert.deepEqual(restored.state.settings.channelTrials,value.settings.channelTrials);
  assert.equal(restored.state.settings.channelTrials?.yeetmd.trial,true,'an unrelated later page cannot become legacy migration evidence');
});

test('migration runs once, requires a found indexable page, and reserves one legacy attempt',()=>{
  const pristine=state();pristine.tasks=[];
  Reflect.deleteProperty(pristine.settings,'channelTrials');
  migrateChannelTrials(pristine,[channel]);
  assert.equal(pristine.settings.channelTrials?.yeetmd.trial,true);
  const later=task(nextId);Object.assign(later,{status:'live',firstLiveAt:submitted,linkCheck:'found',linkIndexable:true});pristine.tasks.push(later);
  migrateChannelTrials(pristine,[channel]);
  assert.equal(pristine.settings.channelTrials?.yeetmd.trial,true,'a later task is not mistaken for pre-migration history');

  const unproven=state();
  Object.assign(unproven.tasks[0],{status:'live',submittedAt:submitted,firstLiveAt:submitted,linkCheck:'found',linkIndexable:false});
  Reflect.deleteProperty(unproven.settings,'channelTrials');
  migrateChannelTrials(unproven,[channel]);
  assert.equal(unproven.settings.channelTrials?.yeetmd.trial,true);

  const inflight=state();
  Object.assign(inflight.tasks[0],{status:'review',submittedAt:submitted});
  Reflect.deleteProperty(inflight.settings,'channelTrials');
  migrateChannelTrials(inflight,[channel]);
  assert.equal(inflight.settings.channelTrials?.yeetmd.activeTaskId,taskId);
  assert.equal(trialTaskAvailable(inflight,channel,nextId),false);

  const unrelated=task(nextId);
  Object.assign(unrelated,{status:'live',firstLiveAt:submitted,linkCheck:'found',linkIndexable:true});
  inflight.tasks.push(unrelated);
  migrateChannelTrials(inflight,[channel]);
  assert.equal(inflight.settings.channelTrials?.yeetmd.trial,true);
  assert.equal(inflight.settings.channelTrials?.yeetmd.activeTaskId,taskId);
});

test('migration repairs an old evaluated task lease without consuming a later attempt',()=>{
  const value=state();
  value.settings.channelTrials={yeetmd:{trial:true,activeTaskId:taskId,failures:1,evaluatedTaskIds:[taskId]}};
  migrateChannelTrials(value,[channel]);
  reconcileChannelTrials(value,[channel]);
  assert.equal(value.settings.channelTrials.yeetmd.activeTaskId,undefined);
  value.tasks[0].status='running';
  assert.equal(claimChannelTrial(value,channel,value.tasks[0]),true);
  assert.equal(value.settings.channelTrials.yeetmd.activeAttemptSequence,1);
});

for(const outcome of ['absent','invalid'] as const)test(`seven-day release remembers a definite ${outcome} despite later unreadable checks`,()=>{
  const value=state(),current=value.tasks[0];claimChannelTrial(value,channel,current);
  Object.assign(current,{status:'review',submittedAt:submitted,publicUrl:'https://yeet.md/s/fixture',linkCheck:'unreachable',trialLastDefinitiveOutcome:outcome});
  reconcileChannelTrials(value,[channel],new Date('2026-10-08T00:00:00Z'));
  reconcileChannelTrials(value,[channel],new Date('2026-10-09T00:00:00Z'));
  assert.equal(value.settings.channelTrials?.yeetmd.failures,1);
  assert.equal(value.settings.channelTrials?.yeetmd.activeTaskId,undefined);
  assert.doesNotThrow(()=>validateBackup({state:value,secrets:{}}));
});

test('pausing an unsubmitted trial releases the shared lease and a submitted one remains read only',()=>{
  const value=state(),current=value.tasks[0];claimChannelTrial(value,channel,current);
  current.status='queued';value.sites[0].status='paused';
  reconcileChannelTrials(value,[channel],new Date(submitted));
  assert.equal(value.settings.channelTrials?.yeetmd.activeTaskId,undefined);
  assert.equal(value.settings.channelTrials?.yeetmd.failures,0);
  value.sites[0].status='ready';claimChannelTrial(value,channel,current);
  current.submittedAt=submitted;value.sites[0].status='paused';
  reconcileChannelTrials(value,[channel],new Date(submitted));
  assert.equal(value.settings.channelTrials?.yeetmd.activeTaskId,current.id);
  reconcileChannelTrials(value,[channel],new Date('2026-10-09T00:00:00Z'));
  assert.equal(value.settings.channelTrials?.yeetmd.failures,0);
  assert.equal(value.settings.channelTrials?.yeetmd.activeTaskId,undefined);
});

test('running signup retries keep the lease while a definitely unsent queued preparation releases it',()=>{
  const rant=CHANNELS.find(value=>value.id==='rant')!;
  for(const stage of ['not_sent','rate_limited','registered'] as const){
    const value=state(),current=value.tasks[0];current.channelId='rant';current.sourceDomain='rant.li';
    current.batch5Registration={version:1,channelId:'rant',operationId:`op-${stage}`,createdAt:submitted,stage,sendGuardVersion:1};
    assert.equal(claimChannelTrial(value,rant,current),true);
    reconcileChannelTrials(value,[rant],new Date(submitted));
    assert.equal(value.settings.channelTrials?.rant.activeTaskId,current.id,`${stage} running must retain its lease`);
    current.status='queued';reconcileChannelTrials(value,[rant],new Date(submitted));
    assert.equal(value.settings.channelTrials?.rant.activeTaskId,undefined,`${stage} queued is definitely unsent`);
    assert.equal(value.settings.channelTrials?.rant.failures,0);
    assert.equal(trialTaskAvailable(value,rant,nextId),true);
  }
});

test('unknown signup and publication acceptance use the durable send time for seven days',()=>{
  const rant=CHANNELS.find(value=>value.id==='rant')!,sentAt='2026-10-10T00:00:00.000Z';
  const value=state(),current=value.tasks[0];current.channelId='rant';current.sourceDomain='rant.li';
  current.batch5Registration={version:1,channelId:'rant',operationId:'op-unknown',createdAt:submitted,stage:'sending',sendGuardVersion:1,sentAt};
  current.checkpoint='batch5_account_pending';current.status='needs_input';
  assert.equal(claimChannelTrial(value,rant,current),true);
  reconcileChannelTrials(value,[rant],new Date('2026-10-12T00:00:00.000Z'));
  assert.equal(value.settings.channelTrials?.rant.activeTaskId,current.id);
  reconcileChannelTrials(value,[rant],new Date('2026-10-17T00:00:00.000Z'));
  assert.equal(value.settings.channelTrials?.rant.activeTaskId,undefined);
  assert.equal(value.settings.channelTrials?.rant.failures,0);
  assert.equal(trialTaskAvailable(value,rant,current.id),false,'an unknown registration is read only after release');

  const publication=state(),publishedTask=publication.tasks[0];
  claimChannelTrial(publication,channel,publishedTask);
  publishedTask.status='review';publishedTask.submittedAt=submitted;publishedTask.trialSendStartedAt=sentAt;
  assert.equal(trialVerificationNextCheck(publishedTask,new Date(sentAt)),'2026-10-10T06:00:00.000Z');
  reconcileChannelTrials(publication,[channel],new Date('2026-10-12T00:00:00.000Z'));
  assert.equal(publication.settings.channelTrials?.yeetmd.activeTaskId,publishedTask.id);
  reconcileChannelTrials(publication,[channel],new Date('2026-10-17T00:00:00.000Z'));
  assert.equal(publication.settings.channelTrials?.yeetmd.activeTaskId,undefined);
  assert.equal(publication.settings.channelTrials?.yeetmd.failures,0);
});

test('a catalog promotion overrides a persisted trial flag',()=>{
  const value=state();assert.equal(channelIsTrial({...channel,trial:false},value.settings),false);
});
