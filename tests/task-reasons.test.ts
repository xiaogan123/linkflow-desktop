import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_COOLDOWN_DAYS,
  TaskReasonError,
  errorReasonCode,
  isHumanTaskReason,
  taskCooldownUntil,
} from '../src/shared/task-reasons';
import {migrateTaskReason} from '../src/main/task-reason-migration';
import {taskTransition} from '../src/main/task-state';
import {publicationOpportunity,taskOccupiesSource} from '../src/shared/publication';
import type {Channel,Site,Task} from '../src/shared/types';

test('task reason cooldowns are fixed UTC durations and transient reasons stay unlocked', () => {
  const at = '2026-10-18T04:00:00.000Z';
  assert.equal(TASK_COOLDOWN_DAYS.content_rejected, 45);
  assert.equal(taskCooldownUntil('content_rejected', at), '2026-12-02T04:00:00.000Z');
  assert.equal(taskCooldownUntil('human_timeout', at), '2026-11-01T04:00:00.000Z');
  assert.equal(taskCooldownUntil('temporary_failure', at), undefined);
  assert.equal(taskCooldownUntil('channel_disabled', at), undefined);
  assert.equal(taskCooldownUntil('referral_blocked', at), undefined);
  assert.equal(taskCooldownUntil('unknown', 'not-a-date'), undefined);
});

test('referral blocks use a typed reason without cooling or locking the platform', () => {
  const at = new Date('2026-10-18T04:00:00.000Z');
  const task:Task={id:'fixture',siteId:'site',channelId:'channel',sourceDomain:'example.com',status:'queued',createdAt:at.toISOString(),scheduledAt:at.toISOString(),updatedAt:at.toISOString(),attempts:0,message:'fixture'};
  const blocked=taskTransition(task,{status:'needs_input',checkpoint:'referral_guard'},at);
  assert.equal(blocked.reasonCode,'referral_blocked');
  assert.equal(blocked.cooldownUntil,undefined);
  assert.equal(blocked.waitingDeadlineAt,undefined);

  const legacy:Task={...task,status:'needs_input',reason:'含推荐信息'};
  assert.equal(migrateTaskReason(legacy,at),true);
  assert.equal(legacy.reasonCode,'referral_blocked');
  assert.equal(legacy.reason,undefined);
  assert.equal(legacy.suitabilityReason,undefined);
  assert.equal(legacy.cooldownUntil,undefined);

  const site:Site={id:'site',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Example site',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:at.toISOString()};
  const channel:Channel={id:'channel',name:'Directory',domain:'directory.example.com',url:'https://directory.example.com/',submitUrl:'https://directory.example.com/submit',categories:['content'],languages:['en'],kind:'directory',emailRequired:false,accountRequired:false,articleRequired:false,free:'yes',freeNote:'',automation:'manual',quality:'B',qualityReason:'',rulesUrl:'https://directory.example.com/rules',checkedAt:at.toISOString(),notes:'',allowedHosts:['directory.example.com'],enabled:true};
  const pending={...legacy,channelId:channel.id,sourceDomain:channel.domain};
  assert.equal(taskOccupiesSource(pending),false);
  assert.equal(publicationOpportunity(site,channel,[pending],at,'UTC').allowed,true);
  const submitted={...pending,submittedAt:at.toISOString()};
  assert.equal(taskOccupiesSource(submitted),true);
  assert.equal(publicationOpportunity(site,channel,[submitted],at,'UTC').allowed,false);
});

test('human reasons exclude uncertain submissions and completed wait timeouts', () => {
  assert.equal(isHumanTaskReason('captcha_required'), true);
  assert.equal(isHumanTaskReason('manual_review'), true);
  assert.equal(isHumanTaskReason('submission_unknown'), false);
  assert.equal(isHumanTaskReason('human_timeout'), false);
});

test('typed task errors expose a stable code and nested causes remain compatible', () => {
  const original = new TaskReasonError('evidence_insufficient', 'fixture', {retryAfterMs: 500});
  assert.equal(original.code, 'evidence_insufficient');
  assert.equal(original.reasonCode, 'evidence_insufficient');
  assert.equal(original.retryAfterMs, 500);
  assert.equal(errorReasonCode(new Error('outer', {cause: original})), 'evidence_insufficient');
  assert.equal(errorReasonCode({code: 'format_invalid'}), 'format_invalid');
  assert.equal(errorReasonCode({code: 'E_TIMEOUT', cause: {reasonCode: 'temporary_failure'}}), 'temporary_failure');
  assert.equal(errorReasonCode({code: 'not_a_task_reason'}), undefined);
});

test('only a definite batch5 refusal can replace unknown without removing the submission lock',()=>{
  const at='2026-10-18T10:00:00.000Z';
  const task:Task={id:'fixture',siteId:'site',channelId:'yeetmd',sourceDomain:'yeet.md',status:'review',createdAt:at,scheduledAt:at,updatedAt:at,submittedAt:at,attempts:1,message:'fixture',reasonCode:'submission_unknown',batch5:{version:1,channelId:'yeetmd',operationId:'fixture-operation',sourceHash:'a'.repeat(64),requestHash:'b'.repeat(64),createdAt:at,stage:'submitting'}};
  const rejection=taskTransition(task,{status:'failed',checkpoint:'batch5_rejected',reasonCode:'format_invalid'});
  assert.equal(rejection.reasonCode,'format_invalid');assert.equal(rejection.submittedAt,undefined);
  assert.equal({...task,...rejection}.submittedAt,at);
  assert.equal(taskTransition(task,{status:'failed',reasonCode:'format_invalid'}).reasonCode,'submission_unknown');
  assert.equal(taskTransition({...task,publicUrl:'https://yeet.md/s/example123'},{status:'failed',checkpoint:'batch5_rejected',reasonCode:'platform_rejected'}).reasonCode,'submission_unknown');
  assert.throws(()=>taskTransition(task,{status:'queued'}),{reasonCode:'submission_unknown'});
});
