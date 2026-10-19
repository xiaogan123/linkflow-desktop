import assert from 'node:assert/strict';
import test from 'node:test';
import {validateBackup} from '../src/main/backup-validation';
import {emptyState} from '../src/main/store';
import type {Task} from '../src/shared/types';

const first='2026-10-01T00:00:00.000Z';
const checked='2026-10-19T00:00:00.000Z';
const next='2026-11-18T00:00:00.000Z';
const publicUrl='https://platform.example/post/1';

function observedBackup(){
  const state=emptyState();
  state.sites.push({id:'11111111-1111-4111-8111-111111111111',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Fixture',category:'content',language:'en',status:'ready',monthlyTarget:1,createdAt:first});
  const task:Task={id:'22222222-2222-4222-8222-222222222222',siteId:state.sites[0].id,channelId:'fixture',sourceDomain:'platform.example',status:'live',createdAt:first,scheduledAt:first,updatedAt:checked,attempts:1,message:'fixture',submittedAt:first,publicUrl,firstLiveAt:first,verifiedAt:checked,lastCheckedAt:checked,nextCheckAt:next,linkCheck:'found',linkCheckReason:'link_found',linkRel:'nofollow',health:'healthy',consecutiveMissing:0,linkRecheckVersion:1,linkObservation:{version:1,checkedAt:checked,publicUrl}};
  state.tasks.push(task);
  state.settings.onlineHours=[{day:'2026-10-18',mask:0x110000}];
  state.settings.platformSurvival={fixture:{sampleSize:6,lostCount:2,survivalRate:4/6,pausedAt:checked}};
  return {state,secrets:{}};
}

test('observed links and compact monitoring metadata survive backup with exact observation binding',()=>{
  const backup=observedBackup();
  const restored=validateBackup(backup);
  assert.deepEqual(restored.state.tasks[0].linkObservation,backup.state.tasks[0].linkObservation);
  assert.deepEqual(restored.state.settings.onlineHours,backup.state.settings.onlineHours);
  assert.deepEqual(restored.state.settings.platformSurvival,backup.state.settings.platformSurvival);
  for(const mutate of [
    (task:Task)=>{task.linkObservation!.publicUrl='https://other.example/post/1'},
    (task:Task)=>{task.linkObservation!.checkedAt=first},
    (task:Task)=>{task.linkCheck='absent'},
    (task:Task)=>{task.status='failed'},
  ]){
    const tampered=observedBackup();mutate(tampered.state.tasks[0]);
    assert.throws(()=>validateBackup(tampered),/复查状态/);
  }
});

test('new scheduling and replacement task metadata survives backup validation',()=>{
  const backup=observedBackup(),task=backup.state.tasks[0];
  Object.assign(task,{trialSendStartedAt:first,failedPlatformIds:['other-platform'],failedPlatformAt:{'other-platform':first},temporaryRetryCount:2,temporaryRetryStage:'publish',temporaryBackoffCount:1,recoveredAt:checked,linkRecheckAt:next,missedPublicationAt:first,replacementTaskId:'33333333-3333-4333-8333-333333333333',replacesTaskId:'44444444-4444-4444-8444-444444444444'});
  const restored=validateBackup(backup).state.tasks[0];
  assert.equal(restored.trialSendStartedAt,first);
  assert.deepEqual(restored.failedPlatformIds,['other-platform']);
  assert.equal(restored.temporaryRetryCount,2);
  assert.deepEqual(restored.failedPlatformAt,{'other-platform':first});
  assert.equal(restored.temporaryRetryStage,'publish');assert.equal(restored.temporaryBackoffCount,1);assert.equal(restored.recoveredAt,checked);
  assert.equal(restored.linkRecheckAt,next);
  assert.equal(restored.missedPublicationAt,first);
  assert.equal(restored.replacementTaskId,task.replacementTaskId);
  assert.equal(restored.replacesTaskId,task.replacesTaskId);
});

test('legacy failed-platform dates are migrated once and do not slide with later task updates',()=>{
  const backup=observedBackup();backup.state.tasks[0].failedPlatformIds=['other-platform'];
  const restored=validateBackup(backup),task=restored.state.tasks[0];
  assert.deepEqual(task.failedPlatformAt,{'other-platform':checked});
  task.updatedAt=next;
  assert.deepEqual(validateBackup(restored).state.tasks[0].failedPlatformAt,{'other-platform':checked});
});


test('periodic unknown states retain their loss history and reject invented lifecycle metadata',()=>{
  const backup=observedBackup(),task=backup.state.tasks[0];
  Object.assign(task,{health:'unknown',linkCheck:'unreachable',linkCheckReason:'page_unreachable'});
  assert.doesNotThrow(()=>validateBackup(backup));
  for(const mutate of [
    (value:Task)=>{value.status='review'},(value:Task)=>{value.status='needs_input'},
    (value:Task)=>{value.consecutiveMissing=1},(value:Task)=>{value.reviewKind='lost_link'},
    (value:Task)=>{value.nextCheckAt=value.lastCheckedAt},
  ]){const tampered=structuredClone(backup);mutate(tampered.state.tasks[0]);assert.throws(()=>validateBackup(tampered));}
  Object.assign(task,{lostAt:checked,consecutiveMissing:1});assert.doesNotThrow(()=>validateBackup(backup));
});
