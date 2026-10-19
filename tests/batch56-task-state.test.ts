import test from 'node:test';
import assert from 'node:assert/strict';
import {maintainWaitingTasks} from '../src/main/task-recovery';
import {assertHumanWaitOpen, taskTransition} from '../src/main/task-state';
import {createHumanAction} from '../src/shared/human-action';
import type {Channel, Settings, Site, Task} from '../src/shared/types';

const since='2026-10-18T00:00:00.000Z';
const overdue=new Date('2026-10-21T00:00:00.000Z');

function task(partial:Partial<Task>={}):Task{
  return {id:'fixture-task',siteId:'fixture-site',channelId:'rant',sourceDomain:'example.com',status:'queued',createdAt:since,updatedAt:since,scheduledAt:since,attempts:0,message:'fixture',...partial};
}

test('durably unsent Batch 5 intents may leave uncertainty; a sending registration stays locked',()=>{
  const registration={version:1 as const,channelId:'rant' as const,operationId:'fixture-registration',createdAt:since,sendGuardVersion:1 as const};
  const pending=task({status:'needs_input',reasonCode:'submission_unknown',checkpoint:'batch5_account_pending',batch5Registration:{...registration,stage:'reserved'}});
  const resumed=taskTransition(pending,{status:'queued',reasonCode:undefined});
  assert.equal(resumed.status,'queued');assert.equal(resumed.reasonCode,undefined);
  assert.throws(()=>taskTransition({...pending,batch5Registration:{...registration,stage:'sending'}},{status:'queued'}),{reasonCode:'submission_unknown'});

  const article=task({status:'needs_input',reasonCode:'submission_unknown',checkpoint:'batch5_publish_submitting',batch5:{version:1,channelId:'rant',operationId:'fixture-publication',sourceHash:'a'.repeat(64),requestHash:'b'.repeat(64),createdAt:since,stage:'reserved'}});
  assert.equal(taskTransition(article,{status:'queued',reasonCode:undefined}).reasonCode,undefined);
  assert.throws(()=>taskTransition({...article,batch5:{...article.batch5!,stage:'submitting'}},{status:'queued'}),{reasonCode:'submission_unknown'});
});

test('only the email-code checkpoint creates an email-code reason',()=>{
  const registration=task({status:'running',checkpoint:'account_registration_submitted'});
  const handoff=taskTransition(registration,{status:'needs_input'},new Date(since));
  assert.equal(handoff.reasonCode,'human_required');assert.ok(handoff.humanAction);
  const pending=taskTransition({...registration,checkpoint:'email_code_pending'},{status:'needs_input'},new Date(since));
  assert.equal(pending.reasonCode,'email_code_pending');
});

test('delivered email stays attached through queued and running retry reasons',()=>{
  const mail:NonNullable<Task['emailWait']>={kind:'link',recipient:'owner@example.com',since,nextPollAt:since,expiresAt:'2026-10-18T02:00:00.000Z',consumedMessageIds:['delivered-once'],continuation:'browser'};
  const delivered=task({status:'running',checkpoint:'account_registration_submitted',emailWait:mail});
  const deferred=taskTransition(delivered,{status:'queued',reasonCode:'temporary_failure'});
  assert.deepEqual({...delivered,...deferred}.emailWait,mail);
  const resumed=taskTransition({...delivered,...deferred},{status:'running'});
  assert.deepEqual({...delivered,...deferred,...resumed}.emailWait,mail);
  assert.equal(taskTransition({...delivered,...deferred},{status:'failed',reasonCode:'temporary_failure'}).emailWait,undefined);
});

test('an overdue human clock applies at the human stop, not queued or running work',()=>{
  const site={id:'fixture-site',status:'ready'} as Site;
  const channel={id:'rant',enabled:true,submitUrl:'https://example.com/submit'} as Channel;
  const settings={autoRun:true} as Settings;
  const stopped=task({status:'needs_input',checkpoint:'manual_submission',reasonCode:'human_required'});
  const action=createHumanAction(stopped,{kind:'other'},new Date(since));
  Object.assign(stopped,{humanAction:action,waitingSince:action.since,waitingDeadlineAt:action.deadline});
  const queued={...stopped,...taskTransition(stopped,{status:'queued',reasonCode:undefined},new Date(since))};
  assert.equal(queued.waitingDeadlineAt,action.deadline);
  assert.doesNotThrow(()=>assertHumanWaitOpen(queued,overdue));
  maintainWaitingTasks([queued],[site],[channel],settings,overdue);
  assert.equal(queued.status,'queued');
  const running={...queued,...taskTransition(queued,{status:'running'},overdue)};
  assert.doesNotThrow(()=>assertHumanWaitOpen(running,overdue));
  maintainWaitingTasks([running],[site],[channel],settings,overdue);
  assert.equal(running.status,'running');
  const returned={...running,...taskTransition(running,{status:'needs_input',reasonCode:'human_required'},overdue)};
  assert.equal(returned.waitingDeadlineAt,action.deadline);
  assert.throws(()=>assertHumanWaitOpen(returned,overdue),{reasonCode:'human_timeout'});
  maintainWaitingTasks([returned],[site],[channel],settings,overdue);
  assert.equal(returned.status,'skipped');assert.equal(returned.reasonCode,'human_timeout');
  assert.throws(()=>taskTransition(returned,{status:'queued'},overdue),{reasonCode:'human_timeout'});
});
