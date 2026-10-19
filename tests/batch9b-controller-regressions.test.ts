import assert from 'node:assert/strict';
import test,{beforeEach,type TestContext} from 'node:test';
import {Store} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {CHANNELS} from '../src/integrations/catalog';
import {articleContentHash,articleContextHash,TermsReviewInvalidError} from '../src/main/article-review';
import {errorReasonCode,TaskReasonError} from '../src/shared/task-reasons';
import {publicationOpportunity} from '../src/shared/publication';
import {selectTaskPlatform} from '../src/main/planner';
import type {Vault} from '../src/main/vault';
const siteId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222',accountId='44444444-4444-4444-8444-444444444444';
beforeEach(t=>(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-19T12:17:00.000Z')}));
const vault={ready:true,available:()=>true,get:async()=>undefined,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})} as unknown as Vault;
function setup(){const store=new Store(':memory:'),stamp=new Date().toISOString();store.update(s=>{s.settings.channelOverrides=Object.fromEntries(CHANNELS.map(c=>[c.id,c.id==='github-gist']));s.settings.autoRun=true;s.sites=[{id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Review Fixture',description:'Technical checklist',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp,analyzedAt:stamp,topics:[{url:'https://example.com/guide',discoveredAt:stamp}],topicsCheckedAt:stamp,qualifications:{developer:'https://example.com/project'}}];s.accounts=[{id:accountId,channelId:'github-gist',username:'fixture-owner',email:'owner@example.com',status:'registered',credentialKind:'api_token',hasPassword:true,createdAt:stamp}];s.tasks=[{id:taskId,siteId,channelId:'github-gist',sourceDomain:'gist.github.com',status:'queued',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',checkpoint:'article_review',draftRevision:1,draft:{title:'Operator checklist',description:'A reusable technical checklist.',body:'We operate and maintain Review Fixture. Use this reproducible checklist to compare public eligibility rules and record source dates. [Official site](https://example.com/)'},accountId,cost:{aiCalls:1}}]});return store}
test('malformed review responses preserve the draft and use the third call for review only',async()=>{
 const store=setup();let reviews=0,writes=0,published=0;
 const controller=new Controller(store,vault,'fixture',{aiFactory:(_s,_v,count)=>({json:async()=>{count?.();return {} as never}}),reviewArticle:async(t,s,c,settings,ai)=>{reviews++;await ai.json('',{});return {status:'failed',reasonCode:'format_invalid',failureStage:'response',reason:'Malformed response',draftRevision:t.draftRevision??0,contentHash:articleContentHash(t),contextHash:articleContextHash(s,c,settings),evidenceUrls:[]}},executeTask:async()=>{published++;throw Error('unexpected publish')}});controller.runtime.aiReady=true;
 controller.generateDraft=async()=>{writes++;throw Error('writer must not run')};
 try{const original=store.read().tasks[0].draft;await controller.tick();assert.equal(store.read().tasks[0].status,'queued');await controller.tick();const result=store.read().tasks[0];assert.deepEqual([reviews,writes,published,result.cost?.aiCalls],[2,0,0,3]);assert.equal(result.status,'failed');assert.equal(result.reasonCode,'format_repair_exhausted');assert.deepEqual(result.draft,original);assert.equal(result.cooldownUntil,undefined)}finally{controller.stop();store.close()}
});
test('a rejected format repair leaves a terminal task instead of a stranded running task',async()=>{
 const store=setup();store.update(s=>{s.sites[0].forbiddenTerms=['reusable']});const controller=new Controller(store,vault,'fixture',{executeTask:async()=>{throw Error('unexpected publish')}});controller.runtime.aiReady=true;controller.generateDraft=async()=>{throw new TaskReasonError('format_repair_exhausted','Rejected repair')};
 try{await controller.tick();const result=store.read().tasks[0];assert.equal(result.status,'failed');assert.equal(result.reasonCode,'format_repair_exhausted');assert.equal(result.recoveryEligible,false);assert.ok(result.draft);assert.equal(controller.runtime.busy,false)}finally{controller.stop();store.close()}
});

test('analysis quota exhaustion delays only the task that needs analysis',async()=>{
 const store=setup(),otherId='33333333-3333-4333-8333-333333333333';store.update(s=>{s.tasks.push({...s.tasks[0],id:otherId,draft:undefined,siteId:'55555555-5555-4555-8555-555555555555'});s.sites.push({...s.sites[0],id:'55555555-5555-4555-8555-555555555555',domain:'example-site.com',url:'https://example-site.com/'});});
 const untouched=structuredClone(store.read().tasks[1]);
 const controller=new Controller(store,vault,'fixture',{reviewArticle:async(t,s,c,settings)=>({status:'failed',reasonCode:'analysis_daily_limit',reason:'Analysis unavailable until tomorrow',failureStage:'input',draftRevision:t.draftRevision??0,contentHash:articleContentHash(t),contextHash:articleContextHash(s,c,settings),evidenceUrls:[]})});controller.runtime.aiReady=true;
 try{await controller.tick();const state=store.read();assert.equal(state.tasks[0].reasonCode,'analysis_daily_limit',JSON.stringify(state.tasks[0]));assert.equal(state.tasks[0].status,'queued');assert.equal(state.tasks[1].scheduledAt,untouched.scheduledAt);assert.equal(state.tasks[1].reasonCode,untouched.reasonCode);assert.deepEqual(state.usage,{})}finally{controller.stop();store.close()}
});
test('live page recheck reports referral text and legacy branding without a write or state downgrade',async()=>{
 const store=setup();store.update(s=>{Object.assign(s.tasks[0],{status:'live',publicUrl:'https://gist.github.com/fixture/post',firstLiveAt:s.tasks[0].createdAt,verifiedAt:s.tasks[0].createdAt,health:'healthy',linkCheck:'found'});s.sites[0].referralCodes=['ABCD1234']});let reads=0,writes=0;
 const controller=new Controller(store,vault,'fixture',{recheckLink:async(url)=>{reads++;return {found:true,outcome:'found',url,rel:'sponsored',reasonCode:'link_found',reason:'Fixture',publicContent:{text:'Invitation: ABCD1234',html:'<p data-linkflow="true">Invitation: ABCD1234</p>'}}},executeTask:async()=>{writes++;throw Error('must not publish')}});
 try{const firstLiveAt=store.read().tasks[0].firstLiveAt;await controller.verify(taskId);const result=store.read().tasks[0];assert.deepEqual([reads,writes,result.status,result.firstLiveAt,result.linkRel],[1,0,'live',firstLiveAt,'nofollow']);assert.equal(result.remoteContentScan?.referral,true);assert.ok(result.remoteContentScan?.legacyMarkers.includes('blogger_data_linkflow'));assert.deepEqual(controller.snapshot().remoteContentTodos?.map(row=>row.kind),['referral','legacy_marker']);assert.equal('publicContent' in result,false)}finally{controller.stop();store.close()}
});

test('an oversized review retains its paid draft without a fresh task or cross-channel rewrite',async t=>{
 const store=setup();
 store.update(state=>{state.tasks[0].topicUrl=state.sites[0].topics![0].url});
 const original=structuredClone(store.read().tasks[0]);
 const controller=new Controller(store,vault,'fixture',{
  reviewArticle:async(task,site,channel,settings)=>({status:'failed',reasonCode:'evidence_truncated',failureStage:'input',reason:'Protected evidence cannot fit.',draftRevision:task.draftRevision??0,contentHash:articleContentHash(task),contextHash:articleContextHash(site,channel,settings),evidenceUrls:[]}),
  executeTask:async()=>{throw Error('unexpected publish')},
 });
 controller.runtime.aiReady=true;
 try{
  await controller.tick();controller.plan();
  const state=store.read();
  assert.equal(state.tasks.length,1);
  assert.equal(state.tasks[0].id,original.id);
  assert.deepEqual(state.tasks[0].draft,original.draft);
  assert.deepEqual(state.tasks[0].cost,original.cost);
  assert.equal(state.tasks[0].reasonCode,'evidence_truncated');
  const other=CHANNELS.find(channel=>channel.id==='telegraph')!;
  assert.equal(publicationOpportunity(state.sites[0],other,state.tasks,new Date(),'Asia/Singapore').allowed,false);
  for(const id of ['txtsbs','pastyx','swarmmemo']){
   const single=CHANNELS.find(channel=>channel.id===id)!;
   assert.equal(publicationOpportunity(state.sites[0],single,state.tasks,new Date(),'Asia/Singapore').allowed,false,id);
   const own={...state.tasks[0],channelId:id,sourceDomain:single.domain,topicUrl:undefined};
   assert.equal(publicationOpportunity(state.sites[0],single,[own],new Date(),'Asia/Singapore').allowed,false,id);
  }
  // A legacy task can retain its target in the review rather than topicUrl.
  const legacy={...state.tasks[0],topicUrl:undefined,articleReview:{...state.tasks[0].articleReview!,targetUrl:original.topicUrl}};
  assert.equal(publicationOpportunity(state.sites[0],other,[legacy],new Date(),'Asia/Singapore').allowed,false);
  // Other topics remain usable; the platform itself is not locked.
  store.update(current=>{
   current.sites[0].topics!.push({url:'https://example.com/another-guide',discoveredAt:new Date().toISOString()});
  });
  controller.plan();
  store.update(current=>{
   const next=current.tasks.find(task=>task.id!==original.id)!;
   assert.ok(next);
   const channel=CHANNELS.find(item=>item.id==='github-gist')!;
   selectTaskPlatform(current,next,[{channel,score:100,reason:'fixture'}],new Date(next.scheduledAt));
   assert.equal(next.topicUrl,'https://example.com/another-guide');
  });
 }finally{controller.stop();store.close()}
});

test('a draft with a price prediction is rewritten once with the reason, then stops without locking the platform',async()=>{
 const store=setup();store.update(s=>{s.tasks[0].draft!.body+=' Bitcoin price will reach $200,000 in 2027.'});
 const repairs:Array<{reason:string;kind?:string}|undefined>=[];
 const controller=new Controller(store,vault,'fixture',{executeTask:async()=>{throw Error('unexpected publish')}});controller.runtime.aiReady=true;
 controller.generateDraft=async(_id,_signal,repair)=>{repairs.push(repair&&{reason:repair.reason,kind:repair.kind});store.update(s=>{s.tasks[0].draft={...s.tasks[0].draft!,body:s.tasks[0].draft!.body+' '}})};
 try{
  await controller.tick();let result=store.read().tasks[0];
  assert.equal(repairs.length,1);assert.equal(repairs[0]?.kind,'content');assert.match(repairs[0]!.reason,/价格预测/);
  assert.equal(result.status,'queued');assert.equal(result.checkpoint,'article_review');assert.equal(result.cooldownUntil,undefined);
  // The rewrite still predicts a price: stop here, keep the draft, and leave the platform open for other drafts.
  await controller.tick();result=store.read().tasks[0];
  assert.equal(repairs.length,1);assert.equal(result.status,'failed');assert.equal(result.reasonCode,'format_repair_exhausted');assert.equal(result.cooldownUntil,undefined);assert.ok(result.draft);
 }finally{controller.stop();store.close()}
});

test('an earlier format repair does not use up the one price-prediction rewrite',async()=>{
 const store=setup();store.update(s=>{s.tasks[0].draft!.body+=' Bitcoin price will reach $200,000 in 2027.';s.tasks[0].formatRepairFailures=1});
 const repairs:Array<{reason:string;kind?:string}|undefined>=[];
 const controller=new Controller(store,vault,'fixture',{executeTask:async()=>{throw Error('unexpected publish')}});controller.runtime.aiReady=true;
 controller.generateDraft=async(_id,_signal,repair)=>{repairs.push(repair&&{reason:repair.reason,kind:repair.kind});store.update(s=>{s.tasks[0].draft={...s.tasks[0].draft!,body:'A neutral explanation of the documented process.'}})};
 try{
  await controller.tick();const result=store.read().tasks[0];
  assert.equal(repairs.length,1);assert.equal(repairs[0]?.kind,'content');
  assert.equal(result.status,'queued');assert.equal(result.contentRepairAttempts,1);assert.equal(result.formatRepairFailures,1);
 }finally{controller.stop();store.close()}
});

test('an AI outage or the daily limit during the one rewrite gives the attempt back and keeps the draft',async()=>{
 for(const code of ['ai_daily_limit','temporary_failure'] as const){
  const store=setup();store.update(s=>{s.tasks[0].draft!.body+=' Bitcoin price will reach $200,000 in 2027.'});
  const controller=new Controller(store,vault,'fixture',{executeTask:async()=>{throw Error('unexpected publish')}});controller.runtime.aiReady=true;
  controller.generateDraft=async()=>{throw new TaskReasonError(code,'AI unavailable')};
  try{
   await controller.tick();const result=store.read().tasks[0];
   assert.equal(result.status,'queued',code);assert.equal(result.reasonCode,code);assert.equal(result.contentRepairAttempts,undefined,code);assert.ok(result.draft,code);
  }finally{controller.stop();store.close()}
 }
});

test('an uncheckable terms answer switches the platform once per day instead of failing each draft as a format error',async()=>{
 const store=setup(),otherId='33333333-3333-4333-8333-333333333333';
 store.update(s=>{s.tasks[0].draft=undefined;s.tasks[0].draftRevision=0;s.tasks.push({...structuredClone(s.tasks[0]),id:otherId})});
 let terms=0;
 const controller=new Controller(store,vault,'fixture',{executeTask:async()=>{throw Error('unexpected publish')},prepareChannelTerms:async()=>{terms++;throw new TermsReviewInvalidError()}});controller.runtime.aiReady=true;
 try{
  await controller.generateDraft(taskId).then(()=>assert.fail('expected a platform switch'),error=>assert.equal(errorReasonCode(error),'channel_ineligible'));
  await controller.generateDraft(otherId).then(()=>assert.fail('expected a platform switch'),error=>assert.equal(errorReasonCode(error),'channel_ineligible'));
  assert.equal(terms,1);
  for(const task of store.read().tasks)assert.equal(task.formatRepairFailures,undefined);
 }finally{controller.stop();store.close()}
});
