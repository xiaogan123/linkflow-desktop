import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {CHANNELS} from '../src/integrations/catalog';
import type {AiPort,Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';
import {validateBackup} from '../src/main/backup-validation';
const stamp='2026-10-01T00:00:00.000Z',sid='11111111-1111-4111-8111-111111111111',tid='22222222-2222-4222-8222-222222222222';
const site:Site={id:sid,url:'https://example.com',domain:'example.com',email:'owner@example.com',name:'Example',description:'Original guides',category:'content',language:'en',status:'ready',monthlyTarget:2,articleReviewMode:'ai',createdAt:stamp};
const task:Task={id:tid,siteId:sid,channelId:'telegraph',sourceDomain:'telegra.ph',status:'needs_input',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'uncertain',submittedAt:stamp,checkpoint:'telegraph_publish_uncertain',draft:{title:'Article',description:'Useful article',body:'Full original article'}};
const vault={ready:true,available:()=>true,get:async()=>undefined,set:async()=>{},delete:async()=>{}} as unknown as Vault;
function fixture(){const store=new Store(':memory:');store.update(s=>{s.sites=[structuredClone(site)];s.settings.autoRun=true;s.settings.channelOverrides=Object.fromEntries(CHANNELS.map(c=>[c.id,false]));});return store}
test('failed topic refresh retains previous topics and retries at most once a day',async()=>{
 const store=fixture();store.update(s=>s.sites[0].topics=[{url:'https://example.com/original',discoveredAt:stamp}]);let calls=0;
 const c=new Controller(store,vault,'isolated',{discoverTopics:async()=>{calls++;throw Error('temporary')}});
 try{await c.tick();await c.tick();assert.equal(calls,1);assert.equal(store.read().sites[0].topics?.length,1);assert.ok(store.read().sites[0].topicsAttemptedAt);assert.equal(store.read().sites[0].topicsCheckedAt,undefined)}finally{store.close()}
});
test('successful discovery persists weekly pool without repeated network or AI',async()=>{
 const store=fixture();let calls=0;const c=new Controller(store,vault,'isolated',{discoverTopics:async()=>{calls++;return {topics:[{url:'https://example.com/new',lastModified:'2026-10-01',discoveredAt:stamp}],checkedAt:new Date().toISOString()}}});
 try{await c.tick();await c.tick();assert.equal(calls,1);assert.equal(store.read().sites[0].topics?.[0].url,'https://example.com/new');assert.deepEqual(store.read().usage,{})}finally{store.close()}
});
test('pausing during discovery prevents late result and additional planning',async()=>{
 const store=fixture();let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r);
 const c=new Controller(store,vault,'isolated',{discoverTopics:async()=>{started();await wait;return {topics:[{url:'https://example.com/new',discoveredAt:stamp}],checkedAt:new Date().toISOString()}}});
 try{const pending=c.tick();await ready;c.pause();release();await pending;assert.equal(store.read().sites[0].topics,undefined);assert.equal(store.read().settings.autoRun,false);assert.equal(store.read().tasks.length,0)}finally{store.close()}
});
test('unknown submission performs at most three read-only reconciliations and never republished',async()=>{
 const store=fixture();store.update(s=>{s.sites[0].topicsCheckedAt=new Date().toISOString();s.tasks=[structuredClone(task)];s.settings.channelOverrides.telegraph=true});let reads=0,writes=0;
 const c=new Controller(store,vault,'isolated',{reconcileTelegraph:async()=>{reads++;return {status:'unknown'}},executeTask:async()=>{writes++;return {status:'failed',message:'unexpected'}}});c.runtime.aiReady=true;
 try{for(let i=0;i<5;i++){store.update(s=>s.tasks[0].reconcileAfter=stamp);await c.tick()}assert.equal(reads,3);assert.equal(writes,0);assert.equal(store.read().tasks[0].status,'needs_input');assert.equal(store.read().tasks[0].publicUrl,undefined)}finally{store.close()}
});
test('positive reconciliation reattaches original receipt and verifies without invoking publisher',async()=>{
 const store=fixture();store.update(s=>{s.sites[0].topicsCheckedAt=new Date().toISOString();s.tasks=[structuredClone(task)];s.settings.channelOverrides.telegraph=true});let verified=0;
 const c=new Controller(store,vault,'isolated',{reconcileTelegraph:async()=>({status:'found',publicUrl:'https://telegra.ph/original-10-01'}),executeTask:async()=>{throw Error('must not publish')}});c.verify=async id=>{verified++;c.patch(id,{status:'live',firstLiveAt:stamp,lastCheckedAt:new Date().toISOString(),nextCheckAt:new Date(Date.now()+7*86400000).toISOString(),health:'healthy',linkCheck:'found'})};
 try{await c.tick();assert.equal(verified,1);assert.equal(store.read().tasks[0].publicUrl,'https://telegra.ph/original-10-01');assert.equal(store.read().tasks[0].submittedAt,stamp);assert.equal(store.read().tasks[0].reconcileAfter,undefined)}finally{store.close()}
});
test('six paid calls is cumulative per task; seventh fails before provider invocation',async()=>{
 const store=fixture();store.update(s=>s.tasks=[{...task,status:'queued',submittedAt:undefined,cost:{aiCalls:5}}]);let providerCalls=0;
 const c=new Controller(store,vault,'isolated',{aiFactory:(_s,_v,onCall)=>({json:async<T>()=>{onCall!();providerCalls++;return {} as T}})});
 try{const ai=(c as unknown as {ai(id:string):AiPort}).ai(tid);await ai.json('',{});await assert.rejects(()=>ai.json('',{}),/预算/);assert.equal(providerCalls,1);assert.equal(store.read().tasks[0].cost?.aiCalls,6);assert.equal(Object.values(store.read().usage).reduce((a,b)=>a+b,0),1)}finally{store.close()}
});
test('new topic and recovery fields survive backup validation without grants or secrets',()=>{
 const store=fixture();try{store.update(s=>{s.sites[0].topics=[{url:'https://example.com/guide',lastModified:'2026-10-01',discoveredAt:stamp}];s.tasks=[{...task,topicUrl:'https://example.com/guide',topicContentHash:'a'.repeat(64),topicSwitchAttempts:1,articleAttempts:[{topicUrl:'https://example.com/old-guide',recordedAt:stamp,reason:'rejected',draft:{title:'Old',description:'Old',body:'Old article'}}],recoveryAttempts:1,reconcileAttempts:2,reconcileAfter:stamp,waitingSince:stamp,deferredAt:stamp}]});const restored=validateBackup({state:store.read(),secrets:{}});assert.deepEqual(restored.state.sites[0].topics,store.read().sites[0].topics);assert.equal(restored.state.tasks[0].topicContentHash,'a'.repeat(64));assert.equal(restored.state.tasks[0].topicSwitchAttempts,1);assert.equal(restored.state.tasks[0].articleAttempts?.[0].draft?.body,'Old article');assert.equal(restored.state.tasks[0].recoveryAttempts,1);assert.equal(restored.state.tasks[0].reconcileAttempts,2)}finally{store.close()}
});

test('topic refresh retains selected pages reserved by unfinished work',async()=>{
 const store=fixture();store.update(s=>{s.sites[0].topics=[{url:'https://www.example.com/reserved/?utm_source=nav',discoveredAt:stamp}];s.tasks=[{...task,submittedAt:undefined,checkpoint:'article_review',topicUrl:'https://example.com/reserved'}]});
 const c=new Controller(store,vault,'isolated',{discoverTopics:async()=>({topics:[{url:'https://example.com/new',discoveredAt:stamp}],checkedAt:new Date().toISOString()})});
 try{await c.tick();assert.deepEqual(store.read().sites[0].topics?.map(t=>t.url),['https://www.example.com/reserved/?utm_source=nav','https://example.com/new'])}finally{store.close()}
});
test('disabled channel never starts reconciliation and pause discards a late receipt',async()=>{
 const store=fixture();store.update(s=>{s.sites[0].topicsCheckedAt=new Date().toISOString();s.tasks=[structuredClone(task)]});let calls=0,release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r);
 const c=new Controller(store,vault,'isolated',{reconcileTelegraph:async()=>{calls++;started();await wait;return {status:'found',publicUrl:'https://telegra.ph/original-10-01'}}});
 try{await c.tick();assert.equal(calls,0);store.update(s=>s.settings.channelOverrides.telegraph=true);const running=c.tick();await ready;c.pause();release();await running;assert.equal(calls,1);assert.equal(store.read().tasks[0].publicUrl,undefined)}finally{store.close()}
});

test('resuming a site after restart recovers only its interrupted work without touching another active site',()=>{
 const store=fixture();store.update(s=>{s.settings.autoRun=false;s.sites[0].status='paused';s.sites[0].analyzedAt=stamp;s.tasks=[{...task,status:'running',submittedAt:undefined,checkpoint:'article_review'}]});
 const c=new Controller(store,vault,'isolated');
 try{assert.equal(store.read().tasks[0].status,'running');store.update(s=>s.tasks.push({...task,id:'other',siteId:'other-site',status:'running'}));c.sitePause(sid,false);assert.equal(store.read().tasks[0].status,'queued');assert.equal(store.read().tasks[1].status,'running')}finally{store.close()}
});

test('topic refresh preserves selections held by deferred and recoverable drafts',async()=>{
 for(const status of ['skipped','failed'] as const){
  const store=fixture();store.update(s=>{s.sites[0].topics=[{url:'https://www.example.com/held/',discoveredAt:stamp}];s.tasks=[{...task,status,submittedAt:undefined,checkpoint:'system_wait',topicUrl:'https://example.com/held',recoveryEligible:status==='failed',deferredAt:status==='skipped'?stamp:undefined}]});
  const c=new Controller(store,vault,'isolated',{discoverTopics:async()=>({topics:[],checkedAt:new Date().toISOString()})});
  try{await c.tick();assert.equal(store.read().sites[0].topics?.[0].url,'https://www.example.com/held/')}finally{store.close()}
 }
});
