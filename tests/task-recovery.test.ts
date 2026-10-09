import test from 'node:test';
import assert from 'node:assert/strict';
import {maintainWaitingTasks,recoverWithAlternativeTopic,resumeDeferredTask} from '../src/main/task-recovery';
import {defaultSettings,emptyState} from '../src/main/store';
import {validateBackup} from '../src/main/backup-validation';
import {CHANNELS} from '../src/integrations/catalog';
import type {Site,Task} from '../src/shared/types';
const stamp='2026-10-01T00:00:00.000Z',now=new Date('2026-10-03T01:00:00.000Z');
const site:Site={id:'s',url:'https://example.com',domain:'example.com',name:'Example',description:'Original guides',email:'owner@example.com',category:'content',language:'en',status:'ready',monthlyTarget:2,createdAt:stamp,articleReviewMode:'manual'};
const channel=CHANNELS.find(c=>c.id==='telegraph')!;
const settings={...defaultSettings(),autoRun:true};
function task(extra:Partial<Task>={}):Task{return {id:'t',siteId:'s',channelId:channel.id,sourceDomain:channel.domain,status:'needs_input',checkpoint:'article_review',createdAt:stamp,updatedAt:stamp,scheduledAt:stamp,waitingSince:stamp,attempts:0,message:'等待审稿',draft:{title:'A',description:'B',body:'Original'},cost:{aiCalls:2},...extra}}
test('an imported remote Blogger draft without a submission timestamp cannot switch topic',()=>{
 const state=emptyState(),siteId='11111111-1111-4111-8111-111111111111';
 state.settings={...settings,articleReviewMode:'ai'};
 state.sites=[{...site,id:siteId,articleReviewMode:'ai',topics:[{url:'https://example.com/guide-one',discoveredAt:stamp},{url:'https://example.com/guide-two',discoveredAt:stamp}]}];
 state.tasks=[task({id:'22222222-2222-4222-8222-222222222222',siteId,channelId:'blogger',sourceDomain:'blogspot.com',status:'failed',checkpoint:'channel_wait',topicUrl:'https://example.com/guide-one',
  blogger:{blogId:'123456',postId:'654321',operationId:'synthetic-operation',contentHash:'a'.repeat(64),stage:'draft'},
  articleReview:{status:'failed',reason:'Needs correction',reasonCode:'content_rejected',evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)}
 })];
 const restored=validateBackup({state,secrets:{}}).state,before=structuredClone(restored.tasks[0]);
 assert.equal(before.submittedAt,undefined);
 maintainWaitingTasks(restored.tasks,restored.sites,CHANNELS,restored.settings,now);
 assert.deepEqual(restored.tasks[0],before);
});

test('publisher receipts alone preserve remote work through timeout, recovery and deferred resume',()=>{
 const receipts:Partial<Task>[]=[
  {channelId:'blogger',blogger:{blogId:'123456',postId:'654321',operationId:'synthetic-operation',contentHash:'a'.repeat(64),stage:'draft'}},
  {channelId:'paragraph',paragraph:{publicationId:'fixture-publication',slug:'fixture-post',contentHash:'a'.repeat(64),stage:'draft',postId:'fixture-post'}},
  {channelId:'bluesky',bluesky:{did:'did:plc:abcdefghijklmnopqrstuvwx',rkey:'fixture-post',recordHash:'a'.repeat(64),recordCreatedAt:stamp,stage:'creating'}},
  {channelId:'nostr',nostr:{pubkey:'a'.repeat(64),eventId:'b'.repeat(64),identifier:'fixture-post',contentHash:'c'.repeat(64),createdAt:Math.floor(Date.parse(stamp)/1000),stage:'submitting'}}
 ];
 for(const saved of receipts){
  const receipt={sourceDomain:CHANNELS.find(c=>c.id===saved.channelId)!.domain,...saved};
  const waiting=task(receipt),temporary=task({...receipt,status:'failed',checkpoint:'system_wait',recoveryEligible:true,nextCheckAt:stamp});
  for(const current of [waiting,temporary]){
   const before=structuredClone(current);
   maintainWaitingTasks([current],[site],CHANNELS,settings,now);
   assert.deepEqual(current,before,receipt.channelId);
  }
  const deferred=task({...receipt,status:'skipped',deferredAt:stamp}),before=structuredClone(deferred);
  assert.throws(()=>resumeDeferredTask([deferred],deferred.id,settings,now),/外部提交/,receipt.channelId);
  assert.deepEqual(deferred,before);
  if(receipt.blogger||receipt.paragraph){
   const confirmed=task({...receipt,status:'failed',checkpoint:'system_wait',submittedAt:stamp,recoveryEligible:true,nextCheckAt:stamp}),originalDraft=structuredClone(confirmed.draft);
   maintainWaitingTasks([confirmed],[site],CHANNELS,settings,now);
   assert.equal(confirmed.status,'queued');assert.equal(confirmed.recoveryAttempts,1);
   assert.deepEqual(confirmed.draft,originalDraft);assert.equal(confirmed.cost?.aiCalls,2);
   assert.deepEqual(confirmed.blogger,receipt.blogger);assert.deepEqual(confirmed.paragraph,receipt.paragraph);
  }
 }
});

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
 const t=task({status:'failed',checkpoint:'system_wait',recoveryEligible:true,nextCheckAt:stamp,cost:{aiCalls:4},topicUrl:'https://example.com/guide',accountId:'account'}),originalDraft=structuredClone(t.draft);
 maintainWaitingTasks([t],[site],[channel],settings,now);assert.equal(t.status,'queued');assert.equal(t.recoveryAttempts,1);assert.equal(t.cost?.aiCalls,4);
 Object.assign(t,{status:'failed',checkpoint:'system_wait',recoveryEligible:true,nextCheckAt:stamp,message:'临时故障，将在次日进行最后一轮有预算的恢复。'});maintainWaitingTasks([t],[site],[channel],settings,now);assert.equal(t.status,'failed');assert.equal(t.nextCheckAt,undefined);assert.equal(t.recoveryEligible,false);assert.match(t.message,/不再安排自动恢复/);assert.equal(t.cost?.aiCalls,4);assert.deepEqual(t.draft,originalDraft);assert.equal(t.topicUrl,'https://example.com/guide');assert.equal(t.accountId,'account');
 const budget=task({status:'failed',checkpoint:'system_wait',recoveryEligible:true,nextCheckAt:stamp,cost:{aiCalls:6}});
 const policy=task({status:'failed',checkpoint:'channel_wait',nextCheckAt:stamp});
 maintainWaitingTasks([budget,policy],[site],[channel],settings,now);assert.equal(budget.status,'failed');assert.equal(budget.nextCheckAt,undefined);assert.equal(budget.recoveryEligible,false);assert.match(budget.message,/AI 处理次数上限/);assert.equal(budget.cost?.aiCalls,6);assert.equal(policy.status,'failed');
});

test('exhausted legacy recovery metadata is normalized without touching future eligible or external work',()=>{
 const future='2026-10-04T01:00:00.000Z';
 const eligible=task({status:'failed',checkpoint:'system_wait',recoveryEligible:true,nextCheckAt:future,cost:{aiCalls:5},message:'临时故障，等待冷却结束。'}),eligibleBefore=structuredClone(eligible);
 const external=task({status:'failed',checkpoint:'system_wait',submittedAt:stamp,recoveryAttempts:1,recoveryEligible:true,nextCheckAt:stamp,cost:{aiCalls:6},message:'外部提交结果待确认。'}),externalBefore=structuredClone(external);
 maintainWaitingTasks([eligible,external],[site],[channel],settings,now);
 assert.deepEqual(eligible,eligibleBefore);assert.deepEqual(external,externalBefore);
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

test('one rejected article switches topic on the same task and archives the prior draft and review',()=>{
 const aiSite:Site={...site,articleReviewMode:'ai',topics:[{url:'https://example.com/guide-one',discoveredAt:stamp},{url:'https://example.com/guide-two',discoveredAt:'2026-10-02T00:00:00.000Z'}]};
 const review={status:'failed' as const,reason:'Unsupported claim remains',reasonCode:'content_rejected' as const,checks:{factualAccuracy:'fail',authorRelationship:'pass',affiliateDisclosure:'pass',independentValue:'pass',financialSafety:'pass',channelRules:'pass'} as const,evidenceUrls:['https://example.com/guide-one'],draftRevision:2,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)};
 const rejected=task({status:'failed',checkpoint:'channel_wait',topicUrl:'https://example.com/guide-one',draftRevision:2,articleRepairAttempts:1,articleReview:review,cost:{aiCalls:4}}),id=rejected.id;
 maintainWaitingTasks([rejected],[aiSite],[channel],settings,now);
 assert.equal(rejected.id,id);assert.equal(rejected.status,'queued');assert.equal(rejected.topicUrl,'https://example.com/guide-two');assert.equal(rejected.topicSwitchAttempts,1);assert.equal(rejected.cost?.aiCalls,4);
 assert.equal(rejected.draft,undefined);assert.equal(rejected.articleReview,undefined);assert.equal(rejected.articleRepairAttempts,0);assert.equal(rejected.articleAttempts?.length,1);assert.equal(rejected.articleAttempts?.[0].topicUrl,'https://example.com/guide-one');assert.equal(rejected.articleAttempts?.[0].draft?.body,'Original');assert.equal(rejected.articleAttempts?.[0].articleReview?.reasonCode,'content_rejected');
 Object.assign(rejected,{status:'failed',checkpoint:'channel_wait',draft:{title:'B',description:'B',body:'Second'},articleReview:{...review,draftRevision:3},cost:{aiCalls:6}});
 maintainWaitingTasks([rejected],[aiSite],[channel],settings,now);assert.equal(rejected.status,'failed');assert.equal(rejected.topicUrl,'https://example.com/guide-two');assert.equal(rejected.topicSwitchAttempts,1);assert.equal(rejected.checkpoint,'article_rejected');
});

test('an invalid topic with only one AI call left stops before a replacement draft or review',()=>{
 const aiSite:Site={...site,articleReviewMode:'ai',topics:[{url:'https://example.com/privacy.html',discoveredAt:stamp},{url:'https://example.com/guides/safe-checklist',discoveredAt:stamp}]};
 const invalid=task({status:'failed',checkpoint:'system_wait',topicUrl:'https://example.com/privacy.html',articleReview:{status:'failed',reason:'Source evidence did not match',reasonCode:'evidence_invalid',evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)},cost:{aiCalls:5},recoveryEligible:true,nextCheckAt:stamp});
 maintainWaitingTasks([invalid],[aiSite],[channel],settings,now);
 assert.equal(invalid.status,'failed');assert.equal(invalid.checkpoint,'topic_recovery_budget');assert.equal(invalid.topicUrl,'https://example.com/privacy.html');assert.equal(invalid.topicSwitchAttempts,undefined);assert.equal(invalid.cost?.aiCalls,5);assert.equal(invalid.nextCheckAt,undefined);assert.match(invalid.message,/不足两次.*付费前停止/);
});

test('topic switching respects pause, manual mode, disabled channels and uncertain submission boundaries',()=>{
 const baseSite:Site={...site,articleReviewMode:'ai',topics:[{url:'https://example.com/guide-one',discoveredAt:stamp},{url:'https://example.com/guide-two',discoveredAt:stamp}]};
 const review={status:'failed' as const,reason:'Rejected',reasonCode:'content_rejected' as const,evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)};
 const cases=[
  {site:{...baseSite,status:'paused' as const},channel,settings,task:task({status:'failed',checkpoint:'channel_wait',topicUrl:'https://example.com/guide-one',articleReview:review})},
  {site:baseSite,channel,settings:{...settings,autoRun:false},task:task({status:'failed',checkpoint:'channel_wait',topicUrl:'https://example.com/guide-one',articleReview:review})},
  {site:{...baseSite,articleReviewMode:'manual' as const},channel,settings,task:task({status:'failed',checkpoint:'channel_wait',topicUrl:'https://example.com/guide-one',articleReview:review})},
  {site:baseSite,channel:{...channel,enabled:false},settings,task:task({status:'failed',checkpoint:'channel_wait',topicUrl:'https://example.com/guide-one',articleReview:review})},
  {site:baseSite,channel,settings,task:task({status:'failed',checkpoint:'telegraph_publish_uncertain',topicUrl:'https://example.com/guide-one',articleReview:review})},
 ];
 for(const value of cases){const before=structuredClone(value.task),result=recoverWithAlternativeTopic(value.task,value.site,value.channel,[value.task],value.settings,now);assert.equal(result.kind,'ineligible');assert.deepEqual(value.task,before)}
});

test('an alternative never reuses a topic archived by another task',()=>{
 const aiSite:Site={...site,articleReviewMode:'ai',topics:[{url:'https://example.com/guide-one',discoveredAt:stamp},{url:'https://example.com/guide-two',discoveredAt:stamp},{url:'https://example.com/guide-three',discoveredAt:stamp}]};
 const review={status:'failed' as const,reason:'Rejected',reasonCode:'content_rejected' as const,evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)};
 const current=task({status:'failed',checkpoint:'channel_wait',topicUrl:'https://example.com/guide-one',articleReview:review,cost:{aiCalls:2}});
 const historical=task({id:'other',status:'failed',topicUrl:'https://example.com/old',articleAttempts:[{topicUrl:'https://example.com/guide-two',recordedAt:stamp,reason:'Previously rejected'}]});
 const result=recoverWithAlternativeTopic(current,aiSite,channel,[current,historical],settings,now);
 assert.equal(result.kind,'switched');assert.equal(current.topicUrl,'https://example.com/guide-three');
});

test('an alternative softly prefers an ASCII locale prefix matching the site language',()=>{
 const aiSite:Site={...site,language:'zh-CN',articleReviewMode:'ai',topics:[{url:'https://example.com/guide-one',discoveredAt:stamp},{url:'https://example.com/en/guides/newer',discoveredAt:'2026-10-02T00:00:00.000Z'},{url:'https://example.com/zh-hans/guides/older',discoveredAt:stamp}]};
 const current=task({status:'failed',checkpoint:'channel_wait',topicUrl:'https://example.com/guide-one',articleReview:{status:'failed',reason:'Rejected',reasonCode:'content_rejected',evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)}});
 assert.equal(recoverWithAlternativeTopic(current,aiSite,channel,[current],settings,now).kind,'switched');assert.equal(current.topicUrl,'https://example.com/zh-hans/guides/older');
});

test('alternative topics remain reserved by a different publisher receipt without submission metadata',()=>{
 const aiSite:Site={...site,articleReviewMode:'ai',topics:[{url:'https://example.com/guide-one',discoveredAt:stamp},{url:'https://example.com/guide-two',discoveredAt:stamp},{url:'https://example.com/guide-three',discoveredAt:stamp}]};
 const review={status:'failed' as const,reason:'Needs correction',reasonCode:'content_rejected' as const,evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)};
 const receipts:Partial<Task>[]=[
  {channelId:'blogger',blogger:{blogId:'123456',postId:'654321',operationId:'synthetic-operation',contentHash:'a'.repeat(64),stage:'draft'}},
  {channelId:'paragraph',paragraph:{publicationId:'fixture-publication',slug:'fixture-post',contentHash:'a'.repeat(64),stage:'draft',postId:'fixture-post'}},
  {channelId:'bluesky',checkpoint:'bluesky_publish_uncertain'},
 ];
 for(const receipt of receipts)for(const status of ['failed','skipped','expired'] as const){
  const current=task({status:'failed',checkpoint:'channel_wait',topicUrl:'https://example.com/guide-one',articleReview:review});
  const other=task({...receipt,id:'other',status,topicUrl:'https://example.com/guide-two/'}),before=structuredClone(other);
  const result=recoverWithAlternativeTopic(current,aiSite,channel,[current,other],settings,now);
  assert.equal(result.kind,'switched');assert.equal(current.topicUrl,'https://example.com/guide-three',`${receipt.channelId}:${status}`);
  assert.deepEqual(other,before);assert.equal(current.cost?.aiCalls,2);assert.equal(current.articleAttempts?.[0].draft?.body,'Original');
 }
 const current=task({status:'failed',checkpoint:'channel_wait',topicUrl:'https://example.com/guide-one',articleReview:review});
 const held=task({...receipts[0],id:'held',status:'failed',topicUrl:'https://example.com/guide-two'});
 const result=recoverWithAlternativeTopic(current,{...aiSite,topics:aiSite.topics!.slice(0,2)},channel,[current,held],settings,now);
 assert.equal(result.kind,'blocked');assert.equal(current.topicUrl,'https://example.com/guide-one');
 assert.equal(current.topicSwitchAttempts,undefined);assert.equal(current.draft?.body,'Original');assert.equal(current.cost?.aiCalls,2);
});

test('a released registration-only wait or unsubmitted failure does not reserve an alternative topic',()=>{
 const aiSite:Site={...site,articleReviewMode:'ai',topics:[{url:'https://example.com/guide-one',discoveredAt:stamp},{url:'https://example.com/guide-two',discoveredAt:stamp}]};
 const review={status:'failed' as const,reason:'Needs correction',reasonCode:'content_rejected' as const,evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)};
 for(const extra of [
  {channelId:'paper-wf',status:'skipped',checkpoint:'paper_account_create_pending',accountId:'original-account',deferredAt:stamp},
  {channelId:'blogger',status:'failed',checkpoint:'article_rejected'},
 ] satisfies Partial<Task>[]){
  const current=task({status:'failed',checkpoint:'channel_wait',topicUrl:'https://example.com/guide-one',articleReview:review});
  const other=task({...extra,id:'other',topicUrl:'https://example.com/guide-two'}),before=structuredClone(other);
  assert.equal(recoverWithAlternativeTopic(current,aiSite,channel,[current,other],settings,now).kind,'switched');
  assert.equal(current.topicUrl,'https://example.com/guide-two');assert.deepEqual(other,before);
 }
});
