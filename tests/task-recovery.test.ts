import test from 'node:test';
import assert from 'node:assert/strict';
import {maintainWaitingTasks,resumeDeferredTask} from '../src/main/task-recovery';
import {defaultSettings} from '../src/main/store';
import {CHANNELS} from '../src/integrations/catalog';
import type {Site,Task} from '../src/shared/types';
const stamp='2026-10-01T00:00:00.000Z',now=new Date('2026-10-03T01:00:00.000Z');
const site:Site={id:'s',url:'https://example.com',domain:'example.com',name:'Example',description:'Original guides',email:'owner@example.com',category:'content',language:'en',status:'ready',monthlyTarget:2,createdAt:stamp,articleReviewMode:'manual'};
const channel=CHANNELS.find(c=>c.id==='telegraph')!;
const settings={...defaultSettings(),autoRun:true};
function task(extra:Partial<Task>={}):Task{return {id:'t',siteId:'s',channelId:channel.id,sourceDomain:channel.domain,status:'needs_input',checkpoint:'article_review',createdAt:stamp,updatedAt:stamp,scheduledAt:stamp,waitingSince:stamp,attempts:0,message:'等待审稿',draft:{title:'A',description:'B',body:'Original'},cost:{aiCalls:2},...extra}}
test('48h manual waits defer original draft while external/unknown/system states stay unchanged',()=>{
 const waiting=task(),submitted=task({id:'submitted',submittedAt:stamp}),registration=task({id:'registration',checkpoint:'account_registration_submitted'}),system=task({id:'system',checkpoint:'system_vault_unavailable'}),policy=task({id:'policy',checkpoint:'channel_wait'});
 const tasks=[waiting,submitted,registration,system,policy];maintainWaitingTasks(tasks,[site],[channel],settings,now);
 assert.equal(waiting.status,'skipped');assert.ok(waiting.deferredAt);assert.equal(waiting.draft?.body,'Original');assert.equal(waiting.cost?.aiCalls,2);
 for(const t of tasks.slice(1))assert.equal(t.status,'needs_input');
});
test('legacy wait starts now and paused execution never ages or changes task state',()=>{
 const t=task({waitingSince:undefined}),old=structuredClone(t);maintainWaitingTasks([t],[site],[channel],{...settings,autoRun:false},now);assert.deepEqual(t,old);
 maintainWaitingTasks([t],[{...site,status:'paused'}],[channel],settings,now);assert.deepEqual(t,old);
 maintainWaitingTasks([t],[site],[channel],settings,now);assert.equal(t.waitingSince,now.toISOString());assert.equal(t.status,'needs_input');
});
test('temporary recovery is once on same id with cumulative cost and cannot revive policy failure',()=>{
 const t=task({status:'failed',checkpoint:'system_wait',recoveryEligible:true,nextCheckAt:stamp,cost:{aiCalls:4}});
 maintainWaitingTasks([t],[site],[channel],settings,now);assert.equal(t.status,'queued');assert.equal(t.recoveryAttempts,1);assert.equal(t.cost?.aiCalls,4);
 Object.assign(t,{status:'failed',checkpoint:'system_wait',recoveryEligible:true,nextCheckAt:stamp});maintainWaitingTasks([t],[site],[channel],settings,now);assert.equal(t.status,'failed');
 const budget=task({status:'failed',checkpoint:'system_wait',recoveryEligible:true,nextCheckAt:stamp,cost:{aiCalls:6}});
 const policy=task({status:'failed',checkpoint:'channel_wait',nextCheckAt:stamp});
 maintainWaitingTasks([budget,policy],[site],[channel],settings,now);assert.equal(budget.status,'failed');assert.equal(policy.status,'failed');
});
test('restoring deferred work preserves draft and budget, and refuses a competing task or unknown submission',()=>{
 const t=task({status:'skipped',deferredAt:stamp});resumeDeferredTask([t],t.id,settings,now);assert.equal(t.status,'queued');assert.equal(t.deferredAt,undefined);assert.equal(t.cost?.aiCalls,2);assert.equal(t.draft?.body,'Original');assert.equal(t.checkpoint,'article_review');
 const d=task({status:'skipped',deferredAt:stamp});assert.throws(()=>resumeDeferredTask([d,task({id:'other',status:'queued'})],d.id,settings,now),/已有其他任务/);
 assert.throws(()=>resumeDeferredTask([task({status:'skipped',deferredAt:stamp,submittedAt:stamp})],'t',settings,now),/外部提交/);
 assert.throws(()=>resumeDeferredTask([task({status:'skipped',deferredAt:stamp,cost:{aiCalls:6}})],'t',settings,now),/预算/);
});

test('recovery cannot revive an older failed draft after newer successful or active work',()=>{
 for(const other of [task({id:'new',status:'live',firstLiveAt:'2026-10-02T00:00:00Z'}),task({id:'new',status:'queued'})]){
  const old=task({status:'failed',checkpoint:'system_wait',recoveryEligible:true,nextCheckAt:stamp});maintainWaitingTasks([old,other],[site],[channel],settings,now);assert.equal(old.status,'failed');assert.equal(old.nextCheckAt,undefined);assert.equal(old.recoveryEligible,false);
 }
});

test('failed unknown submission blocks recovery of a separate earlier task',()=>{
 const old=task({status:'failed',checkpoint:'system_wait',recoveryEligible:true,nextCheckAt:stamp});
 const uncertain=task({id:'uncertain',status:'failed',checkpoint:'telegraph_publish_uncertain',submittedAt:stamp});
 maintainWaitingTasks([old,uncertain],[site],[channel],settings,now);assert.equal(old.status,'failed');assert.equal(old.nextCheckAt,undefined);assert.equal(old.recoveryEligible,false);assert.equal(uncertain.status,'failed');
});
