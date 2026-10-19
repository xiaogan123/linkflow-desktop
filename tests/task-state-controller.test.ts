import {SCHEDULING_MESSAGES} from '../src/shared/scheduling';
import {REFERRAL_MESSAGES} from '../src/shared/referral-messages';
import test,{beforeEach,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/main/controller';
import {nextTask,recoverInterrupted} from '../src/main/planner';
import {Store} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import {taskTransition,assertHumanWaitOpen} from '../src/main/task-state';
import {CHANNELS} from '../src/integrations/catalog';
import {TASK_REASON_MESSAGES, TASK_WAIT_MESSAGES, TASK_FLOW_MESSAGES} from '../src/shared/task-reasons';
import type {Site, Task} from '../src/shared/types';

const now = new Date('2026-10-18T06:00:00.000Z');
beforeEach(t=>(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-18T10:17:00.000Z')}));
const stamp = now.toISOString();
const site: Site = {id:'11111111-1111-4111-8111-111111111111', domain:'example.com', url:'https://example.com/', email:'owner@example.com', name:'Example', description:'Original publishing guides', category:'content', language:'en', monthlyTarget:1, status:'ready', createdAt:stamp, articleReviewMode:'manual', topics:[{url:'https://example.com/guide-one',discoveredAt:stamp},{url:'https://example.com/guide-two',discoveredAt:stamp}]};
function task(extra: Partial<Task> = {}): Task {
  return {id:'22222222-2222-4222-8222-222222222222',siteId:site.id,channelId:'telegraph',sourceDomain:'telegra.ph',status:'queued',createdAt:stamp,updatedAt:stamp,scheduledAt:stamp,attempts:0,message:'[placeholder]',topicUrl:'https://example.com/guide-one',draft:{title:'Original',description:'Original',body:'Original draft'},...extra};
}
const vault = {ready:true,available:()=>true,get:async()=>undefined} as unknown as Vault;

test('human wait starts at transition and stays fixed through observations and resume', () => {
  const current = task();
  Object.assign(current, taskTransition(current, {status:'needs_input', reasonCode:'captcha_required'}, now));
  assert.equal(current.waitingSince, stamp);
  assert.equal(current.waitingDeadlineAt, '2026-10-20T06:00:00.000Z');
  Object.assign(current, taskTransition(current, {status:'needs_input', message:'[different placeholder]'}, new Date('2026-10-19T06:00:00Z')));
  assert.equal(current.waitingDeadlineAt, '2026-10-20T06:00:00.000Z');
  Object.assign(current, taskTransition(current, {status:'queued'}, now));
  assert.equal(current.reasonCode, undefined);
  assert.equal(current.waitingDeadlineAt, '2026-10-20T06:00:00.000Z');
  Object.assign(current, taskTransition(current, {status:'needs_input', reasonCode:'phone_required'}, new Date('2026-10-21T06:00:00Z')));
  assert.equal(current.waitingDeadlineAt, '2026-10-20T06:00:00.000Z');
});

test('explicit failure reasons persist cooldowns without extending them on repeated updates', () => {
  const current = task();
  Object.assign(current, taskTransition(current, {status:'failed',reasonCode:'content_rejected'}, now));
  assert.equal(current.cooldownUntil, '2026-12-02T06:00:00.000Z');
  Object.assign(current, taskTransition(current, {status:'failed',message:'[replacement]'}, new Date('2026-10-19T06:00:00Z')));
  assert.equal(current.cooldownUntil, '2026-12-02T06:00:00.000Z');
  Object.assign(current, taskTransition(current, {status:'failed',reasonCode:'temporary_failure'}, now));
  assert.equal(current.cooldownUntil, undefined);
});

test('submission evidence never receives an automatic human deadline', () => {
  for (const evidence of [{submittedAt:stamp},{publicUrl:'https://example-site.com/original'},{reasonCode:'submission_unknown' as const}]) {
    const current=task(evidence);
    Object.assign(current,taskTransition(current,{status:'needs_input'},now));
    assert.equal(current.reasonCode,'submission_unknown');
    assert.equal(current.waitingDeadlineAt,undefined);
  }
});

function fixture(wait:Task) {
  const store=new Store(':memory:');
  store.update(state=>{
    state.sites=[structuredClone(site)];state.tasks=[wait];state.settings.autoRun=true;state.settings.notify=true;state.settings.timezone='UTC';
    state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(channel=>[channel.id,['telegraph','rentry'].includes(channel.id)]));
  });
  const channelCatalog=CHANNELS.filter(channel=>['telegraph','rentry'].includes(channel.id)).map(channel=>({...channel,enabled:true}));
  return {store,controller:new Controller(store,vault,'test',{channelCatalog})};
}

test('placeholder messages leave the 24h reminder and same-month 48h replacement intact', () => {
  const extraTables=[SCHEDULING_MESSAGES,REFERRAL_MESSAGES],extraSaved=extraTables.map(table=>({...table}));
  for(const table of extraTables)for(const key of Object.keys(table))Object.assign(table,{[key]:'[placeholder]'});
  const messages={...TASK_REASON_MESSAGES},waitingMessages={...TASK_WAIT_MESSAGES},flowMessages={...TASK_FLOW_MESSAGES};
  for(const key of Object.keys(TASK_REASON_MESSAGES) as Array<keyof typeof TASK_REASON_MESSAGES>)TASK_REASON_MESSAGES[key]='[placeholder]';
  for(const key of Object.keys(TASK_WAIT_MESSAGES) as Array<keyof typeof TASK_WAIT_MESSAGES>)Object.assign(TASK_WAIT_MESSAGES,{[key]:'[placeholder]'});
  for(const key of Object.keys(TASK_FLOW_MESSAGES) as Array<keyof typeof TASK_FLOW_MESSAGES>)Object.assign(TASK_FLOW_MESSAGES,{[key]:'[placeholder]'});
  const clock=new Date(),entered=new Date(clock.getTime()-25*3_600_000).toISOString();
  const {store,controller}=fixture(task({status:'needs_input',reasonCode:'manual_review',checkpoint:'article_review',waitingSince:entered,waitingDeadlineAt:new Date(Date.parse(entered)+48*3_600_000).toISOString()}));
  let notices=0;controller.onNotice=()=>{notices++};
  try {
    controller.plan();controller.plan();
    let original=store.read().tasks.find(item=>item.id===task().id)!;
    assert.equal(notices,1);assert.ok(original.waitingReminderAt);assert.equal(original.status,'needs_input');
    store.update(state=>{const current=state.tasks[0];current.waitingSince=new Date(clock.getTime()-49*3_600_000).toISOString();current.waitingDeadlineAt=new Date(clock.getTime()-3_600_000).toISOString()});
    controller.plan();
    const state=store.read();original=state.tasks.find(item=>item.id===task().id)!;
    assert.equal(original.status,'skipped');assert.equal(original.reasonCode,'human_timeout');assert.ok(original.cooldownUntil);
    assert.equal(original.draft?.body,'Original draft');assert.equal(original.submittedAt,undefined);
    const replacement=state.tasks.find(item=>item.id!==original.id&&item.status==='queued');
    assert.ok(replacement);assert.notEqual(replacement.channelId,original.channelId);assert.equal(replacement.draft,undefined);
    assert.equal(replacement.scheduledAt.slice(0,7),clock.toISOString().slice(0,7));
    assert.equal(notices,1);
  } finally {store.close();extraTables.forEach((table,index)=>Object.assign(table,extraSaved[index]));Object.assign(TASK_REASON_MESSAGES,messages);Object.assign(TASK_WAIT_MESSAGES,waitingMessages);Object.assign(TASK_FLOW_MESSAGES,flowMessages)}
});

test('disabled channel skip records its cause and a normal manual skip records its cooldown', () => {
  const {store,controller}=fixture(task());
  try {
    store.update(state=>{state.settings.channelOverrides.telegraph=false});controller.plan();
    const original=store.read().tasks.find(item=>item.id===task().id)!;
    assert.equal(original.status,'skipped');assert.equal(original.reasonCode,'channel_disabled');assert.equal(original.cooldownUntil,undefined);
    controller.patch(original.id,{status:'skipped',reasonCode:'user_skipped',message:'[placeholder]'});
    assert.equal(store.read().tasks.find(item=>item.id===original.id)?.reasonCode,'user_skipped');
    assert.ok(store.read().tasks.find(item=>item.id===original.id)?.cooldownUntil);
  } finally {store.close()}
});

test('expired human approval cannot revive an abandoned draft between planner ticks',()=>{
  const waiting=task({status:'needs_input',reasonCode:'manual_review',waitingDeadlineAt:stamp});
  assert.throws(()=>assertHumanWaitOpen(waiting,now),{code:'human_timeout'});
  const ended=task({status:'skipped',reasonCode:'human_timeout'});
  assert.throws(()=>taskTransition(ended,{status:'queued'},now),{code:'human_timeout'});
});

test('reason-only unknown submission cannot be cleared by retry or restart',()=>{
  const unknown=task({status:'needs_input',reasonCode:'submission_unknown',checkpoint:undefined,draft:undefined});
  assert.throws(()=>taskTransition(unknown,{status:'queued'},now),{code:'submission_unknown'});
  const {store}=fixture({...unknown,status:'running'});
  try{const state=store.read();recoverInterrupted(state,now);assert.equal(state.tasks[0].status,'needs_input');assert.equal(state.tasks[0].reasonCode,'submission_unknown');state.tasks[0].status='queued';assert.equal(nextTask(state,now),undefined)}finally{store.close()}
});

test('switching to AI review cannot revive an overdue manual draft or an unknown submission',()=>{
  for(const extra of [{reasonCode:'manual_review' as const,waitingDeadlineAt:'2000-01-01T00:00:00.000Z'},{reasonCode:'submission_unknown' as const}]){
    const {store,controller}=fixture(task({status:'needs_input',checkpoint:'article_review',...extra}));
    try{store.update(state=>state.sites[0].articleReviewMode='ai');controller.resumeArticleReviews();const saved=store.read().tasks[0];assert.equal(saved.status,extra.reasonCode==='manual_review'?'skipped':'needs_input');assert.equal(saved.reasonCode,extra.reasonCode==='manual_review'?'human_timeout':'submission_unknown')}finally{store.close()}
  }
});

test('skipping preserves the only evidence of an unknown external submission',()=>{
  const current=task({status:'needs_input',reasonCode:'submission_unknown',checkpoint:undefined});
  Object.assign(current,taskTransition(current,{status:'skipped',reasonCode:'user_skipped',message:'[placeholder]'},now));
  assert.equal(current.status,'skipped');assert.equal(current.reasonCode,'submission_unknown');assert.equal(current.cooldownUntil,undefined);
  assert.throws(()=>taskTransition(current,{status:'queued'},new Date('2027-01-01T00:00:00Z')),{code:'submission_unknown'});
});

test('a definite platform refusal without submission evidence ends the wait with a fixed cooldown',()=>{
  for(const checkpoint of ['gist_rejected','telegraph_publish_rejected']){
    const current=task({status:'running',draft:undefined});
    Object.assign(current,taskTransition(current,{status:'needs_input',checkpoint,message:'[placeholder refusal]'},now));
    assert.equal(current.status,'failed');assert.equal(current.reasonCode,'platform_rejected');
    assert.equal(current.cooldownUntil,'2026-11-17T06:00:00.000Z');assert.equal(current.waitingDeadlineAt,undefined);
    Object.assign(current,taskTransition(current,{status:'failed',message:'[new placeholder]'},new Date('2026-10-19T06:00:00Z')));
    assert.equal(current.cooldownUntil,'2026-11-17T06:00:00.000Z');
  }
  const unknown=task({status:'needs_input',reasonCode:'submission_unknown',submittedAt:stamp});
  Object.assign(unknown,taskTransition(unknown,{status:'needs_input',checkpoint:'gist_rejected',reasonCode:'platform_rejected'},now));
  assert.equal(unknown.reasonCode,'submission_unknown');assert.equal(unknown.cooldownUntil,undefined);
});
