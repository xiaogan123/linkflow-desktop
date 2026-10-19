import assert from 'node:assert/strict';
import test,{beforeEach,type TestContext} from 'node:test';

import {Store} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {CHANNELS} from '../src/integrations/catalog';
import {AiMalformedOutputError} from '../src/integrations/ai';
import {errorReasonCode} from '../src/shared/task-reasons';
const siteId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222',accountId='44444444-4444-4444-8444-444444444444',otherId='33333333-3333-4333-8333-333333333333';
beforeEach(t=>(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-19T12:17:00.000Z')}));
const vault={ready:true,available:()=>true,get:async()=>undefined,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})} as any;
function setup(){const store=new Store(':memory:'),stamp=new Date().toISOString();store.update((s:any)=>{s.settings.channelOverrides=Object.fromEntries(CHANNELS.map((c:any)=>[c.id,c.id==='github-gist']));s.settings.autoRun=true;s.sites=[{id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Review Fixture',description:'Technical checklist',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp,analyzedAt:stamp,topics:[{url:'https://example.com/guide',discoveredAt:stamp}],topicsCheckedAt:stamp,qualifications:{developer:'https://example.com/project'}}];s.accounts=[{id:accountId,channelId:'github-gist',username:'fixture-owner',email:'owner@example.com',status:'registered',credentialKind:'api_token',hasPassword:true,createdAt:stamp}];s.tasks=[{id:taskId,siteId,channelId:'github-gist',sourceDomain:'gist.github.com',status:'queued',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',checkpoint:'article_review',draftRevision:1,draft:{title:'Operator checklist',description:'A reusable technical checklist.',body:'We operate and maintain Review Fixture. Use this reproducible checklist to compare public eligibility rules and record source dates. [Official site](https://example.com/)'},accountId,cost:{aiCalls:1}}]});return store}
for(const [label,make] of [['cut off',()=>new AiMalformedOutputError('AI 输出达到长度上限，被截断','{"finance":"allo',{},true)],['empty',()=>new AiMalformedOutputError('AI 未返回有效 JSON','')]] as const){
test(`terms review output that is ${label} is an AI outage on the draft path, not a failed article`,async()=>{
 const store=setup();
 store.update((s:any)=>{s.tasks[0].draft=undefined;s.tasks[0].draftRevision=0;s.tasks[0].checkpoint=undefined;s.tasks.push({...structuredClone(s.tasks[0]),id:otherId})});
 let terms=0;
 const controller=new Controller(store,vault,'fixture',{executeTask:async()=>{throw Error('unexpected publish')},prepareChannelTerms:async()=>{terms++;throw make()}});controller.runtime.aiReady=true;
 try{
  assert.equal(await controller.generateDraft(taskId).then(()=>'ok',(e:any)=>errorReasonCode(e)),'temporary_failure');
  for(let i=0;i<6;i++)await controller.tick();
  for(const task of store.read().tasks){
   assert.notEqual(task.reasonCode,'format_invalid');assert.notEqual(task.reasonCode,'format_repair_exhausted');
   assert.equal(task.status,'queued');assert.equal(task.reasonCode,'temporary_failure');assert.ok(task.nextCheckAt);assert.doesNotMatch(task.message,/稿件检查没通过/);
  }
  // Backoff: the outage is not retried again and again within the same minute.
  assert.ok(terms<=3,`terms calls ${terms}`);
 }finally{controller.stop();store.close()}
});}
