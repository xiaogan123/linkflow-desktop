import test from 'node:test';
import assert from 'node:assert/strict';
import {Store,migrateState,emptyState} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {CHANNELS} from '../src/integrations/catalog';
import type {ArticleReview,ExecutionContext,Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';
import {validateBackup} from '../src/main/backup-validation';
import {runGistTask} from '../src/integrations/gist';
import {dateKey,nextTask,reservesSlot} from '../src/main/planner';
import {TopicDiscoveryError} from '../src/integrations/topics';
import {unbindAccount} from '../src/main/account-bindings';

const siteId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222',defaultAccountId='44444444-4444-4444-8444-444444444444';
const fixtureChannelIds=new Set(['github-gist','telegraph','github']);
function site():Site{return {topics:[{url:'https://review-fixture.com/guide-one',discoveredAt:new Date().toISOString()}],topicsCheckedAt:new Date().toISOString(),id:siteId,domain:'review-fixture.com',url:'https://review-fixture.com/',email:'owner@review-fixture.com',name:'Review Fixture',description:'Financial comparison and affiliate referral program',category:'finance',language:'en',monthlyTarget:1,status:'ready',createdAt:'2026-09-01T00:00:00.000Z',analyzedAt:'2026-09-01T00:00:00.000Z',qualifications:{developer:'https://review-fixture.com/project'}}}
function task(status:Task['status']='queued'):Task{return {id:taskId,siteId,channelId:'github-gist',sourceDomain:'gist.github.com',status,createdAt:'2026-09-01T00:00:00.000Z',scheduledAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z',attempts:0,message:'fixture',checkpoint:'article_review',draftRevision:1,draft:{title:'Operator checklist',description:'A reusable technical checklist.',body:'We operate and maintain Review Fixture. We participate in its affiliate referral program and may receive a commission. Use this reproducible checklist to compare public eligibility rules and record source dates. [Official site](https://review-fixture.com/)'}}}
const fakeVault={ready:true,available:()=>true,get:async()=>undefined,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})} as unknown as Vault;
function passed(t:Task,s:Site,settings:ReturnType<Store['read']>['settings']):ArticleReview{const channel=CHANNELS.find(item=>item.id==='github-gist')!;return {status:'passed',reason:'All checks passed with public evidence.',reviewedAt:'2026-09-30T00:00:00.000Z',evidenceUrls:[s.url,channel.rulesUrl],draftRevision:t.draftRevision??0,contentHash:articleContentHash(t),contextHash:articleContextHash(s,channel,settings)}}
function fixture(options:{mode?:'manual'|'ai';status?:Task['status'];submitted?:boolean;review?:ArticleReview}={}){
  const store=new Store(':memory:');store.update(state=>{state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(channel=>[channel.id,fixtureChannelIds.has(channel.id)]));state.settings.articleReviewMode=options.mode??'ai';state.settings.autoRun=true;state.settings.dailyAiLimit=40;state.sites=[site()];state.accounts=[{id:defaultAccountId,channelId:'github-gist',username:'fixture-owner',email:'owner@example.com',status:'registered',credentialKind:'api_token',hasPassword:true,createdAt:'2026-09-01T00:00:00.000Z'}];const value=task(options.status);value.accountId=defaultAccountId;if(options.submitted){value.submittedAt='2026-09-30T00:00:00.000Z';value.status='needs_input'}if(options.review)value.articleReview=options.review;state.tasks=[value]});return store;
}

test('AI pass is a separate review call and publishes once with a bound synthetic approval',async()=>{
  const store=fixture();let reviews=0,executions=0,approvedAt='';const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{reviews++;return passed(t,s,settings)},executeTask:async(context:ExecutionContext)=>{executions++;approvedAt=context.task.articleApprovedAt??'';return {status:'review',message:'submitted'}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(reviews,1);assert.equal(executions,1);assert.ok(approvedAt);assert.equal(saved.articleReview?.status,'passed');assert.equal(saved.status,'review');await controller.tick();assert.equal(executions,1)}finally{store.close()}
});

test('ordinary content API articles also require the independent AI review',async()=>{
  const store=fixture();store.update(state=>{state.sites[0].category='content';state.sites[0].description='Operator-authored publishing guides';state.tasks[0].channelId='telegraph';state.tasks[0].sourceDomain='telegra.ph';state.tasks[0].accountId=undefined});let reviews=0,executions=0;const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,c,settings)=>{reviews++;return {status:'passed',reason:'checked',reviewedAt:'2026-09-30T00:00:00.000Z',evidenceUrls:[s.url,c.rulesUrl],draftRevision:t.draftRevision??0,contentHash:articleContentHash(t),contextHash:articleContextHash(s,c,settings)}},executeTask:async()=>{executions++;return {status:'review',message:'submitted'}}});controller.runtime.aiReady=true;
  try{await controller.tick();assert.equal(reviews,1);assert.equal(executions,1);assert.equal(store.read().tasks[0].articleReview?.status,'passed')}finally{store.close()}
});

test('site mode overrides the global gate in both directions',async()=>{
  const aiStore=fixture({mode:'manual'});aiStore.update(state=>{state.sites[0].articleReviewMode='ai';state.tasks[0].articleApprovedAt='2026-09-30T00:00:00.000Z'});let aiReviews=0,aiExecutions=0;const aiController=new Controller(aiStore,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{aiReviews++;return passed(t,s,settings)},executeTask:async()=>{aiExecutions++;return {status:'review',message:'submitted'}}});aiController.runtime.aiReady=true;
  try{await aiController.tick();assert.equal(aiReviews,1);assert.equal(aiExecutions,1)}finally{aiStore.close()}
  const manualStore=fixture({mode:'ai'});manualStore.update(state=>{state.sites[0].articleReviewMode='manual'});let manualReviews=0,manualExecutions=0;const manualController=new Controller(manualStore,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{manualReviews++;return passed(t,s,settings)},executeTask:async()=>{manualExecutions++;return {status:'review',message:'unexpected'}}});manualController.runtime.aiReady=true;
  try{await manualController.tick();assert.equal(manualStore.read().tasks[0].status,'needs_input');assert.equal(manualReviews,0);assert.equal(manualExecutions,0)}finally{manualStore.close()}
});

test('semantic review rejection releases the slot without publication or automatic rerun',async()=>{
  for(const reason of ['公开事实与稿件冲突','公开证据不足，无法核实']){const store=fixture();let reviews=0,executions=0;const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{reviews++;return {...passed(t,s,settings),status:'failed',reason}},executeTask:async()=>{executions++;return {status:'review',message:'should not run'}}});controller.runtime.aiReady=true;
    try{await controller.tick();assert.equal(store.read().tasks[0].status,'failed');assert.equal(store.read().tasks[0].checkpoint,'channel_wait');assert.match(store.read().tasks[0].message,/不会.*重复/);assert.equal(store.read().tasks[0].articleReview?.status,'failed');assert.equal(reviews,1);assert.equal(executions,0)}finally{store.close()}}
});

test('missing Gist identity becomes one user handoff before any paid work and does not block Telegraph',async()=>{
  const store=fixture();store.update(state=>{state.accounts=[];state.tasks[0].accountId=undefined});let reviews=0,executions=0;
  const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{reviews++;return passed(t,s,settings)},executeTask:async()=>{executions++;return {status:'review',message:'unexpected'}}});controller.runtime.aiReady=true;
  try{
    controller.plan();const state=store.read(),gist=state.tasks.find(item=>item.channelId==='github-gist');
    assert.equal(reviews,0);assert.equal(executions,0);assert.equal(gist?.status,'needs_input');assert.equal(gist?.checkpoint,'account_handoff');
    assert.equal(state.tasks.some(item=>item.channelId==='telegraph'&&item.status==='queued'),true);
    const accountId='55555555-5555-4555-8555-555555555555';store.update(next=>next.accounts.push({id:accountId,channelId:'github-gist',username:'owner',email:'owner@users.noreply.github.com',status:'registered',credentialKind:'api_token',hasPassword:true,createdAt:'2026-09-01T00:00:00.000Z'}));controller.plan();
    const resumed=store.read().tasks.find(item=>item.channelId==='github-gist');assert.equal(resumed?.status,'queued');assert.equal(resumed?.accountId,accountId);
  }finally{store.close()}
});

test('transient review failures get one bounded retry and then release the slot',async()=>{
  const store=fixture();let reviews=0,executions=0;const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{reviews++;return {...passed(t,s,settings),status:'failed',reason:'公开证据网络暂时不可用',reasonCode:'evidence_fetch_failed'}},executeTask:async()=>{executions++;return {status:'review',message:'unexpected'}}});controller.runtime.aiReady=true;
  try{
    await controller.tick();let saved=store.read().tasks.find(item=>item.id===taskId)!;assert.equal(saved.status,'queued');assert.equal(saved.attempts,1);assert.ok(Date.parse(saved.scheduledAt)>Date.now());
    store.update(state=>{state.tasks.find(item=>item.id===taskId)!.scheduledAt=new Date(0).toISOString()});await controller.tick();saved=store.read().tasks.find(item=>item.id===taskId)!;
    assert.equal(reviews,2);assert.equal(executions,0);assert.equal(saved.status,'failed');assert.equal(saved.checkpoint,'system_wait');assert.equal(saved.attempts,2);
  }finally{store.close()}
});

test('daily AI exhaustion resumes on the next configured local day',async()=>{
  const store=fixture();const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>({...passed(t,s,settings),status:'failed',reason:'AI 核对未通过：今日 AI 调用已达上限',reasonCode:'ai_unavailable'}),executeTask:async()=>({status:'review',message:'unexpected'})});controller.runtime.aiReady=true;
  try{const before=new Date();for(let run=0;run<2;run++){await controller.tick();const state=store.read(),saved=state.tasks.find(item=>item.id===taskId)!;assert.equal(saved.status,'queued');assert.equal(saved.attempts,0);assert.equal(saved.nextCheckAt,saved.scheduledAt);assert.notEqual(dateKey(saved.scheduledAt,state.settings.timezone),dateKey(before,state.settings.timezone));assert.match(saved.message,/下一个本地自然日/);if(run===0)store.update(next=>{next.tasks.find(item=>item.id===taskId)!.scheduledAt=new Date(0).toISOString()})}}finally{store.close()}
});

test('execution-stage daily AI limits wait for the next local day without consuming an attempt',async()=>{
  for(const throws of [false,true]){
    const store=fixture(),controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>passed(t,s,settings),executeTask:async()=>{if(throws)throw Error('今日 AI 调用已达上限，明天继续');return {status:'failed',message:'今日 AI 调用已达上限，明天继续'}}});controller.runtime.aiReady=true;
    try{const before=new Date();await controller.tick();const state=store.read(),saved=state.tasks[0];assert.equal(saved.status,'queued');assert.equal(saved.attempts,0);assert.equal(saved.nextCheckAt,saved.scheduledAt);assert.notEqual(dateKey(saved.scheduledAt,state.settings.timezone),dateKey(before,state.settings.timezone));assert.match(saved.message,/下一个本地自然日/)}finally{store.close()}
  }
});

test('unknown channel policy is a system wait and never a publication permission',async()=>{
  const store=fixture();let executions=0,notices=0;const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>({...passed(t,s,settings),status:'failed',reason:'only API guidance found',reasonCode:'policy_not_found'}),executeTask:async()=>{executions++;return {status:'review',message:'unexpected'}}});controller.runtime.aiReady=true;controller.onNotice=()=>{notices++};
  try{await controller.tick();const saved=store.read().tasks.find(item=>item.id===taskId)!;assert.equal(saved.status,'failed');assert.equal(saved.checkpoint,'channel_wait');assert.match(saved.message,/许可仍未确认/);assert.equal(executions,0);assert.equal(notices,0)}finally{store.close()}
});

test('an existing registration transaction keeps its checkpoint and only continues inside the verification window',()=>{
  const store=fixture(),channel=CHANNELS.find(item=>item.id==='github')!,recent=new Date().toISOString();
  store.update(state=>{const current=state.tasks[0],account=state.accounts[0];current.channelId=channel.id;current.sourceDomain=channel.domain;current.checkpoint='account_registration_submitted';current.scheduledAt=new Date(0).toISOString();account.channelId=channel.id;account.email=state.sites[0].email;account.status='needs_verification';account.credentialKind='password';account.lastUsedAt=recent;state.accountBindings=[{id:'binding',siteId,channelId:channel.id,accountId:account.id,createdAt:recent,updatedAt:recent}]});
  const controller=new Controller(store,fakeVault,'fixture');
  try{
    controller.plan();let state=store.read(),saved=state.tasks[0];assert.equal(saved.status,'queued');assert.equal(saved.checkpoint,'account_registration_submitted');assert.equal(nextTask(state,new Date(),CHANNELS)?.id,taskId);
    store.update(next=>{const account=next.accounts[0];account.lastUsedAt='2026-09-01T00:00:00.000Z';const current=next.tasks[0];current.status='queued';current.scheduledAt=new Date(0).toISOString()});controller.plan();state=store.read();saved=state.tasks.find(item=>item.id===taskId)!;
    assert.equal(saved.status,'needs_input');assert.equal(saved.checkpoint,'account_registration_submitted');assert.match(saved.message,/保留原注册事务/);assert.equal(reservesSlot(saved,new Date()),false);
  }finally{store.close()}
});

test('an unsubmitted article task switches from a pinned invalid account only to a verified same-channel identity',async()=>{
  const store=fixture(),readyId='55555555-5555-4555-8555-555555555555';let reviews=0,executedStatus='';
  store.update(state=>{state.accounts[0].status='credentials_invalid';state.accounts.push({...state.accounts[0],id:readyId,username:'ready-owner',status:'registered'})});
  const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{reviews++;return passed(t,s,settings)},executeTask:async context=>{executedStatus=context.getAccount()?.status??'missing';return {status:'needs_input',message:'fixture'}}});controller.runtime.aiReady=true;
  try{await controller.tick();const state=store.read(),saved=state.tasks.find(item=>item.id===taskId)!;assert.equal(reviews,1);assert.equal(executedStatus,'registered');assert.equal(saved.accountId,readyId);assert.equal(state.accounts.find(item=>item.id===defaultAccountId)?.status,'credentials_invalid')}finally{store.close()}
});

test('a restricted pinned identity is preserved and never replaced to continue publication',()=>{
  const store=fixture(),readyId='55555555-5555-4555-8555-555555555555';
  store.update(state=>{state.accounts[0].status='restricted';state.accounts.push({...state.accounts[0],id:readyId,username:'ready-owner',status:'registered'})});
  const controller=new Controller(store,fakeVault,'fixture');
  try{controller.plan();const saved=store.read().tasks.find(item=>item.id===taskId)!;assert.equal(saved.status,'needs_input');assert.equal(saved.accountId,defaultAccountId);assert.equal(saved.checkpoint,'account_handoff')}finally{store.close()}
});

test('Telegraph self-provisioning does not resolve a legacy password identity at execution',async()=>{
  const store=fixture();let seenCredential='not-executed';
  store.update(state=>{state.sites[0].category='content';const current=state.tasks[0];current.channelId='telegraph';current.sourceDomain='telegra.ph';current.accountId=undefined;Object.assign(state.accounts[0],{channelId:'telegraph',email:state.sites[0].email,credentialKind:'password',source:'imported'})});
  const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,c,settings)=>({...passed(t,s,settings),contextHash:articleContextHash(s,c,settings)}),executeTask:async context=>{seenCredential=context.getAccount()?.credentialKind??'none';return {status:'needs_input',message:'fixture'}}});controller.runtime.aiReady=true;
  try{await controller.tick();assert.equal(seenCredential,'none');assert.equal(store.read().accounts[0].credentialKind,'password')}finally{store.close()}
});

test('planning resumes legacy AI policy waits with a fresh review while preserving drafts and manual mode',()=>{
  const store=fixture(),stamp='2026-09-30T00:00:00.000Z';
  store.update(state=>{
    state.accounts=[];state.sites=[];state.tasks=[];
    for(let index=0;index<3;index++){
      const currentSite={...site(),id:`11111111-1111-4111-8111-11111111111${index}`,domain:`site-${index}.example`,url:`https://site-${index}.example/`,qualifications:undefined};
      const currentTask={...task('needs_input'),id:`22222222-2222-4222-8222-22222222222${index}`,siteId:currentSite.id,channelId:'telegraph',sourceDomain:'telegra.ph',accountId:undefined,articleApprovedAt:stamp};
      currentTask.articleReview={...passed(currentTask,currentSite,state.settings),status:'failed',reason:'Only API guidance was found.',reasonCode:index===1?'policy_unknown':'policy_not_found'};
      state.sites.push(currentSite);state.tasks.push(currentTask);
    }
    const manualSite={...site(),id:'33333333-3333-4333-8333-333333333333',domain:'manual.example',url:'https://manual.example/',articleReviewMode:'manual' as const,qualifications:undefined};
    const manualTask={...task('needs_input'),id:'44444444-4444-4444-8444-444444444444',siteId:manualSite.id,channelId:'telegraph',sourceDomain:'telegra.ph',accountId:undefined,articleApprovedAt:stamp};
    manualTask.articleReview={...passed(manualTask,manualSite,state.settings),status:'failed',reason:'Only API guidance was found.',reasonCode:'policy_not_found'};
    state.sites.push(manualSite);state.tasks.push(manualTask);
  });
  const before=structuredClone(store.read().tasks),controller=new Controller(store,fakeVault,'fixture');
  try{
    controller.plan();const after=store.read().tasks;
    for(let index=0;index<3;index++){assert.equal(after[index].status,'queued');assert.equal(after[index].checkpoint,'article_review');assert.equal(reservesSlot(after[index],new Date()),true);assert.deepEqual(after[index].draft,before[index].draft);assert.equal(after[index].articleReview,undefined);assert.equal(after[index].articleApprovedAt,undefined);assert.ok(after[index].articleAutomationVersion)}
    assert.equal(after[3].status,'needs_input');assert.equal(after[3].checkpoint,'article_review');assert.deepEqual(after[3].draft,before[3].draft);assert.deepEqual(after[3].articleReview,before[3].articleReview);assert.equal(after[3].articleApprovedAt,stamp);
  }finally{store.close()}
});

test('pause during AI review aborts the run and cannot publish a late pass',async()=>{
  const store=fixture();let release!:()=>void,executions=0;const wait=new Promise<void>(resolve=>{release=resolve});const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{await wait;return passed(t,s,settings)},executeTask:async()=>{executions++;return {status:'review',message:'should not run'}}});controller.runtime.aiReady=true;
  try{const running=controller.tick();await new Promise(resolve=>setImmediate(resolve));controller.pause();release();await running;const saved=store.read().tasks[0];assert.equal(executions,0);assert.equal(saved.status,'queued');assert.equal(saved.articleReview,undefined);assert.equal(store.read().settings.autoRun,false)}finally{store.close()}
});

test('draft, site, or selected model changes during review invalidate the result before publication',async()=>{
  for(const mutate of [
    (store:Store)=>store.update(state=>{state.tasks[0].draft!.body+=' changed';state.tasks[0].draftRevision=(state.tasks[0].draftRevision??0)+1}),
    (store:Store)=>store.update(state=>{state.sites[0].description='changed'}),
    (store:Store)=>store.update(state=>{state.sites[0].articleReviewMode='manual'}),
    (store:Store)=>store.update(state=>{state.settings.model='changed-model'})
  ]){const store=fixture();let release!:()=>void,executions=0;const wait=new Promise<void>(resolve=>{release=resolve});const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{await wait;return passed(t,s,settings)},executeTask:async()=>{executions++;return {status:'review',message:'should not run'}}});controller.runtime.aiReady=true;
    try{const running=controller.tick();await new Promise(resolve=>setImmediate(resolve));mutate(store);release();await running;assert.equal(executions,0);assert.equal(store.read().tasks[0].status,'needs_input');assert.match(store.read().tasks[0].message,/条件发生变化/)}finally{store.close()}}
});

test('legacy/manual mode keeps the human article gate and never invokes AI review',async()=>{
  const legacy=emptyState();delete (legacy.settings as Partial<typeof legacy.settings>).articleReviewMode;assert.equal(migrateState(legacy).settings.articleReviewMode,'manual');
  const store=fixture({mode:'manual'});let reviews=0,executions=0;const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{reviews++;return passed(t,s,settings)},executeTask:async()=>{executions++;return {status:'review',message:'should not run'}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(saved.status,'needs_input');assert.equal(saved.checkpoint,'article_review');assert.equal(reviews,0);assert.equal(executions,0)}finally{store.close()}
});

test('enabling AI resumes only untouched article_review tasks and never submitted or failed reviews',async()=>{
  const resumable=fixture({status:'needs_input'});try{const controller=new Controller(resumable,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>passed(t,s,settings),executeTask:async()=>({status:'review',message:'submitted'})});controller.runtime.aiReady=true;controller.resumeArticleReviews();assert.equal(resumable.read().tasks[0].status,'queued');await controller.tick();assert.equal(resumable.read().tasks[0].status,'review')}finally{resumable.close()}
  const submitted=fixture({status:'needs_input',submitted:true});try{const controller=new Controller(submitted,fakeVault,'fixture');controller.resumeArticleReviews();assert.equal(submitted.read().tasks[0].status,'needs_input')}finally{submitted.close()}
  const failedStore=fixture({status:'needs_input'});try{const state=failedStore.read(),failed={...passed(state.tasks[0],state.sites[0],state.settings),status:'failed' as const};failedStore.update(s=>s.tasks[0].articleReview=failed);const controller=new Controller(failedStore,fakeVault,'fixture');controller.resumeArticleReviews();assert.equal(failedStore.read().tasks[0].status,'needs_input')}finally{failedStore.close()}
});

test('restored review evidence is preserved but cannot authorize publication',()=>{
  const state=emptyState(),s=site(),t=task('queued');state.sites=[s];state.settings.articleReviewMode='ai';t.articleApprovedAt='2026-09-30T00:00:00.000Z';t.articleReview={...passed(t,s,state.settings),reviewContractVersion:4};t.articleAttempts=[{recordedAt:'2026-09-30T00:00:00.000Z',reason:'previous rejection',draft:structuredClone(t.draft),draftRevision:t.draftRevision,articleReview:{...t.articleReview,status:'failed',reasonCode:'content_rejected'}}];state.tasks=[t];
  const restored=validateBackup({state,secrets:{}}).state.tasks[0];assert.equal(restored.articleApprovedAt,undefined);assert.equal(restored.articleReview?.status,'failed');assert.equal(restored.articleReview?.reviewContractVersion,4);assert.match(restored.articleReview?.reason??'',/必须重新核对/);assert.deepEqual(restored.articleReview?.evidenceUrls,t.articleReview.evidenceUrls);assert.equal(restored.articleAttempts?.[0].articleReview?.reviewContractVersion,4);
});

test('backup retains the one-time contract migration snapshot and rejects a changed historical draft',()=>{
  const state=emptyState(),s=site(),t=task('failed');state.sites=[s];state.settings.articleReviewMode='ai';t.checkpoint='channel_wait';t.articleAutomationVersion=4;t.articleRepairAttempts=1;t.articleReview=legacyAuthorOnlyReview(t,s,state.settings);t.articleReviewMigration={contractVersion:4,recordedAt:'2026-10-07T00:00:00.000Z',priorRepairAttempts:1,draft:structuredClone(t.draft!),draftRevision:t.draftRevision!,review:structuredClone(t.articleReview)};state.tasks=[t];
  const restored=validateBackup({state,secrets:{}}).state.tasks[0];assert.deepEqual(restored.articleReviewMigration,t.articleReviewMigration);assert.equal(restored.articleReview?.status,'failed');
  const altered=structuredClone(state);altered.tasks[0].articleReviewMigration!.draft.body+=' changed';assert.throws(()=>validateBackup({state:altered,secrets:{}}),/旧审核迁移记录与原稿不一致/);
});

test('all settings writes are blocked while review is in flight while plan pause still aborts',async()=>{
  const store=fixture();let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve});const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{await wait;return passed(t,s,settings)},executeTask:async()=>({status:'review',message:'unexpected'})});controller.runtime.aiReady=true;
  try{const running=controller.tick();await new Promise(resolve=>setImmediate(resolve));assert.throws(()=>controller.assertSettingsWritable(),/暂停执行/);controller.pause();assert.equal(store.read().settings.autoRun,false);release();await running}finally{store.close()}
});

for(const mutation of ['pause-setting','disable-channel','site-review-mode'] as const)test(`submission checkpoint revalidates ${mutation} after real Gist account verification`,async()=>{
  const store=fixture(),accountId='33333333-3333-4333-8333-333333333333';store.update(state=>{state.accounts=[{id:accountId,channelId:'github-gist',username:'octocat',email:'owner@example.com',status:'registered',credentialKind:'api_token',hasPassword:true,createdAt:'2026-09-01T00:00:00.000Z'}];state.tasks[0].accountId=accountId;state.tasks[0].draft!.body+='\n\nRecord inputs and outputs in a reusable technical checklist, compare each item with public documentation, and leave unknown fields unset.'});
  let posts=0;const vault={...fakeVault,get:async()=> 'synthetic-token-12345'} as unknown as Vault;const controller=new Controller(store,vault,'fixture',{reviewArticle:async(t,s,_c,settings)=>passed(t,s,settings),executeTask:context=>runGistTask(context,{fetch:async(url,init)=>{if(url.endsWith('/user')){store.update(state=>{if(mutation==='pause-setting')state.settings.autoRun=false;else if(mutation==='disable-channel')state.settings.channelOverrides['github-gist']=false;else state.sites[0].articleReviewMode='manual'});return new Response(JSON.stringify({login:'octocat'}),{status:200,headers:{'content-type':'application/json'}})}if(init.method==='POST'){posts++;return new Response('{}',{status:503,headers:{'content-type':'application/json'}})}throw Error('unexpected request')}})});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(posts,0);assert.equal(saved.submittedAt,undefined);assert.notEqual(saved.checkpoint,'submitting');assert.match(saved.message,/提交已取消/)}finally{store.close()}
});

test('legacy Telegraph policy dead end resumes once under the new review contract',async()=>{
  const store=fixture({status:'failed'});store.update(state=>{const t=state.tasks[0];t.channelId='telegraph';t.sourceDomain='telegra.ph';t.accountId=undefined;t.checkpoint='channel_wait';t.attempts=3;t.articleReview={...passed(t,state.sites[0],state.settings),status:'failed',reasonCode:'policy_not_found',reason:'Legacy pre-review policy check'};});
  let reviews=0,executions=0;const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,c,settings)=>{reviews++;return {...passed(t,s,settings),contextHash:articleContextHash(s,c,settings),status:'failed',reasonCode:'policy_unknown',reason:'New actual uncertainty'}},executeTask:async()=>{executions++;return {status:'review',message:'unexpected'}}});controller.runtime.aiReady=true;
  try{controller.plan();let t=store.read().tasks.find(t=>t.id===taskId)!;assert.equal(t.status,'queued');assert.equal(t.attempts,0);assert.ok(t.articleAutomationVersion);assert.equal(t.articleReview,undefined);await controller.tick();controller.plan();controller.plan();t=store.read().tasks.find(t=>t.id===taskId)!;assert.equal(t.status,'failed');assert.equal(reviews,1);assert.equal(executions,0)}finally{store.close()}
});

test('policy recovery preserves pauses, human mode, unsupported sources and uncertain submissions',()=>{
  const cases=['paused','global-pause','manual','disabled','submitted','public','previously-live','uncertain','different-channel','content-rejected'] as const;
  for(const scenario of cases){const store=fixture({status:'failed'});store.update(state=>{const t=state.tasks[0];t.channelId='telegraph';t.sourceDomain='telegra.ph';t.accountId=undefined;t.checkpoint='channel_wait';t.articleReview={...passed(t,state.sites[0],state.settings),status:'failed',reasonCode:'policy_not_found',reason:'legacy'};
    if(scenario==='paused')state.sites[0].status='paused';if(scenario==='global-pause')state.settings.autoRun=false;if(scenario==='manual')state.sites[0].articleReviewMode='manual';if(scenario==='disabled')state.settings.channelOverrides.telegraph=false;if(scenario==='submitted')t.submittedAt=new Date().toISOString();if(scenario==='public')t.publicUrl='https://telegra.ph/fixture';if(scenario==='previously-live')t.firstLiveAt=new Date().toISOString();if(scenario==='uncertain')t.checkpoint='telegraph_publish_uncertain';if(scenario==='different-channel')t.channelId='github-gist';if(scenario==='content-rejected')t.articleReview.reasonCode='content_rejected';});
    const controller=new Controller(store,fakeVault,'fixture');try{controller.plan();assert.equal(store.read().tasks.find(t=>t.id===taskId)!.status,scenario==='submitted'?'needs_input':'failed',scenario)}finally{store.close()}
  }
});

test('automatic content repair runs once then a separate fresh review before publication',async()=>{
  const store=fixture();let reviews=0,repairs=0,executions=0;const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{reviews++;return reviews===1?{...passed(t,s,settings),status:'failed',reasonCode:'content_rejected',reason:'Remove unsupported claim'}:passed(t,s,settings)},executeTask:async context=>{executions++;assert.equal(context.task.draftRevision,2);assert.equal(context.task.articleReview?.status,'passed');return {status:'review',message:'submitted'}}});controller.runtime.aiReady=true;
  controller.generateDraft=async(id,_signal,repair)=>{repairs++;assert.match(repair!.reason,/unsupported/);controller.patch(id,{draft:{...repair!.draft,body:repair!.draft.body+' Revised using verified evidence.'},draftRevision:2,articleReview:undefined,articleApprovedAt:undefined})};
  try{await controller.tick();assert.equal(store.read().tasks[0].checkpoint,'article_repair');assert.equal(executions,0);await controller.tick();assert.equal(reviews,2);assert.equal(repairs,1);assert.equal(executions,1);assert.equal(store.read().tasks[0].articleRepairAttempts,1)}finally{store.close()}
});

test('rejected repair and repair outage do not loop or publish; explicit platform prohibition is not repaired',async()=>{
  for(const scenario of ['rejected','outage','prohibited']){const store=fixture();store.update(state=>{state.settings.channelOverrides.telegraph=false});let reviews=0,repairs=0,executions=0;const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{reviews++;return {...passed(t,s,settings),status:'failed',reasonCode:'content_rejected',reason:'Not supported',...(scenario==='prohibited'?{checks:{factualAccuracy:'pass',authorRelationship:'pass',affiliateDisclosure:'pass',independentValue:'pass',financialSafety:'pass',channelRules:'fail'} as const}:{})}},executeTask:async()=>{executions++;return {status:'review',message:'unexpected'}}});controller.runtime.aiReady=true;
    controller.generateDraft=async(id,_signal,repair)=>{repairs++;if(scenario==='outage')throw Error('AI transport disconnected');controller.patch(id,{draft:{...repair!.draft,body:repair!.draft.body+' Revised'},draftRevision:2,articleReview:undefined})};
    try{await controller.tick();await controller.tick();await controller.tick();assert.equal(repairs,scenario==='prohibited'?0:1);assert.equal(reviews,scenario==='rejected'?2:1);assert.equal(executions,0);assert.equal(store.read().tasks.find(t=>t.id===taskId)!.status,'failed')}finally{store.close()}
  }
});

test('pausing repair before a paid call or after saving the new revision resumes at the correct step',async()=>{
  for(const savedRevision of [false,true]){const store=fixture();store.update(state=>{state.settings.channelOverrides.telegraph=false});let reviews=0,repairs=0,executions=0;
    const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{reviews++;return reviews===1?{...passed(t,s,settings),status:'failed',reasonCode:'content_rejected',reason:'Correctable detail'}:passed(t,s,settings)},executeTask:async()=>{executions++;return {status:'review',message:'submitted'}}});controller.runtime.aiReady=true;
    controller.generateDraft=async(id,_signal,repair)=>{repairs++;if(savedRevision||repairs>1)controller.patch(id,{draft:{...repair!.draft,body:repair!.draft.body+' Fixed'},draftRevision:2,articleReview:undefined});if(repairs===1){controller.pause();throw Error('任务已暂停')}};
    try{await controller.tick();await controller.tick();const paused=store.read().tasks[0];assert.equal(paused.status,'queued');assert.equal(paused.articleRepairAttempts,savedRevision?1:0);assert.equal(paused.checkpoint,savedRevision?'article_review':'article_repair');assert.equal(executions,0);store.update(s=>{s.settings.autoRun=true});await controller.tick();assert.equal(executions,1);assert.equal(repairs,savedRevision?1:2);assert.equal(reviews,2);assert.equal(store.read().tasks[0].articleRepairAttempts,1)}finally{store.close()}
  }
});

test('a rejected unpublished topic keeps its task and cost, generates one alternate draft, then requires a fresh review',async()=>{
  const store=fixture({status:'failed'});store.update(state=>{const t=state.tasks[0];state.sites[0].topics=[{url:'https://review-fixture.com/guide-one',discoveredAt:'2026-09-01T00:00:00.000Z'},{url:'https://review-fixture.com/guide-two',discoveredAt:'2026-09-02T00:00:00.000Z'}];t.topicUrl='https://review-fixture.com/guide-one';t.checkpoint='channel_wait';t.articleRepairAttempts=1;t.cost={aiCalls:4};t.draftRevision=2;t.articleReview={...passed(t,state.sites[0],state.settings),status:'failed',reasonCode:'content_rejected',reason:'The repaired draft still conflicts with evidence.'};});
  let providerCalls=0,reviews=0,executions=0;
  const controller=new Controller(store,fakeVault,'fixture',{
    readTopicEvidence:async(_site,url)=>({url,title:'Guide two',text:'A verified guide with enough source text for a new article.',contentHash:'c'.repeat(64)}),
    collectArticleEvidence:async()=>[],
    aiFactory:(_settings,_vault,onCall)=>({json:async<T>()=>{onCall?.();providerCalls++;return {title:'Alternate guide',description:'A fresh evidence-based guide.',body:'A new article based only on the second verified topic.'} as T}}),
    reviewArticle:async(t,s,_c,settings,ai)=>{reviews++;await ai.json('independent review',{});return passed(t,s,settings)},
    executeTask:async context=>{executions++;assert.equal(context.task.topicUrl,'https://review-fixture.com/guide-two');assert.equal(context.task.articleReview?.status,'passed');return {status:'review',message:'submitted'}},
  });controller.runtime.aiReady=true;
  try{
    controller.plan();const switched=store.read().tasks[0];assert.equal(switched.id,taskId);assert.equal(switched.topicUrl,'https://review-fixture.com/guide-two');assert.equal(switched.cost?.aiCalls,4);assert.equal(switched.draft,undefined);assert.equal(switched.articleReview,undefined);assert.equal(switched.articleAttempts?.[0].topicUrl,'https://review-fixture.com/guide-one');
    await controller.tick();const saved=store.read().tasks[0];assert.equal(saved.id,taskId);assert.equal(saved.cost?.aiCalls,6);assert.equal(saved.topicSwitchAttempts,1);assert.equal(saved.draftRevision,3);assert.equal(saved.status,'review');assert.equal(providerCalls,2);assert.equal(reviews,1);assert.equal(executions,1);
  }finally{store.close()}
});

function legacyAuthorOnlyReview(t:Task,s:Site,settings:ReturnType<Store['read']>['settings']):ArticleReview{
  return {...passed(t,s,settings),status:'failed',reasonCode:'content_rejected',reason:'The author relationship is not publicly established.',reviewContractVersion:3,
    checks:{factualAccuracy:'pass',authorRelationship:'unknown',affiliateDisclosure:'pass',independentValue:'pass',financialSafety:'pass',channelRules:'pass'}};
}

test('a legacy author-only rejection resumes once through revision and full independent review on the original budget',async()=>{
  const store=fixture({status:'failed'});
  store.update(state=>{const t=state.tasks[0];t.checkpoint='channel_wait';t.attempts=1;t.articleAutomationVersion=3;t.cost={aiCalls:4};t.articleReview=legacyAuthorOnlyReview(t,state.sites[0],state.settings);state.accountBindings=[{id:'66666666-6666-4666-8666-666666666666',siteId,channelId:'github-gist',accountId:defaultAccountId,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z'}]});
  const original=structuredClone(store.read().tasks[0]),newBody=original.draft!.body.replace('We operate and maintain Review Fixture.','This article is promotional content made for the linked website. The author publishes this promotional article, not an independent third-party recommendation.');
  let writerCalls=0,reviewCalls=0,executions=0;
  const services={collectArticleEvidence:async()=>[],aiFactory:(_settings:unknown,_vault:unknown,onCall?:()=>void)=>({json:async<T>(instruction:string)=>{onCall?.();if(instruction==='independent review')return {} as T;writerCalls++;return {...original.draft!,body:newBody} as T}}),
    reviewArticle:async(t:Task,s:Site,c:(typeof CHANNELS)[number],settings:ReturnType<Store['read']>['settings'],ai:{json:<T>(instruction:string,input:unknown)=>Promise<T>})=>{reviewCalls++;await ai.json('independent review',{});assert.equal(t.draftRevision,2);return {...passed(t,s,settings),contextHash:articleContextHash(s,c,settings)}},
    executeTask:async(context:ExecutionContext)=>{executions++;assert.equal(context.task.articleReview?.status,'passed');assert.equal(context.task.articleReview?.reviewContractVersion,4);return {status:'review' as const,message:'submitted'}}};
  const controller=new Controller(store,fakeVault,'fixture',services as ConstructorParameters<typeof Controller>[3]);controller.runtime.aiReady=true;
  try{
    controller.plan();controller.plan();let saved=store.read().tasks.find(item=>item.id===taskId)!;
    assert.equal(saved.status,'queued');assert.equal(saved.checkpoint,'article_repair');assert.equal(saved.articleAutomationVersion,4);assert.equal(saved.attempts,1);assert.equal(saved.cost?.aiCalls,4);
    assert.deepEqual(saved.draft,original.draft);assert.deepEqual(saved.articleReviewMigration?.draft,original.draft);assert.deepEqual(saved.articleReviewMigration?.review,original.articleReview);assert.equal(saved.articleAttempts,undefined);assert.ok(saved.history?.length);
    const restarted=new Controller(store,fakeVault,'fixture',services as ConstructorParameters<typeof Controller>[3]);restarted.runtime.aiReady=true;restarted.plan();
    assert.equal(store.read().tasks.find(item=>item.id===taskId)?.cost?.aiCalls,4);
    await restarted.tick();saved=store.read().tasks.find(item=>item.id===taskId)!;
    assert.equal(writerCalls,1);assert.equal(reviewCalls,1);assert.equal(executions,1);assert.equal(saved.id,taskId);assert.equal(saved.cost?.aiCalls,6);assert.equal(saved.articleRepairAttempts,1);assert.equal(saved.draft?.body,newBody);assert.deepEqual(saved.articleReviewMigration?.review,original.articleReview);
    restarted.plan();await restarted.tick();assert.equal(store.read().tasks.find(item=>item.id===taskId)?.cost?.aiCalls,6);assert.equal(writerCalls,1);assert.equal(reviewCalls,1);
  }finally{store.close()}
});

test('contract-four upgrade adds one bounded repair after an ordinary repair and preserves prior topic evidence',async()=>{
  for(const previousRepair of [0,1])for(const priorTopic of [false,true]){
    const store=fixture({status:'failed'});store.update(state=>{const t=state.tasks[0];t.checkpoint='channel_wait';t.attempts=1;t.articleAutomationVersion=3;t.articleRepairAttempts=previousRepair;t.cost={aiCalls:4,amount:0.12,currency:'USD'};t.articleReview=legacyAuthorOnlyReview(t,state.sites[0],state.settings);state.accountBindings=[{id:'66666666-6666-4666-8666-666666666666',siteId,channelId:'github-gist',accountId:defaultAccountId,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z'}];if(priorTopic){t.topicSwitchAttempts=1;t.articleAttempts=[{topicUrl:'https://review-fixture.com/older-guide',recordedAt:'2026-09-29T00:00:00.000Z',reason:'Prior genuine topic attempt',draft:{title:'Older topic',description:'Archived',body:'Original archived draft'},draftRevision:0,articleRepairAttempts:0}]}});
    const before=structuredClone(store.read().tasks[0]);let writerCalls=0,reviewCalls=0,executions=0;
    const controller=new Controller(store,fakeVault,'fixture',{collectArticleEvidence:async()=>[],aiFactory:(_settings,_vault,onCall)=>({json:async<T>(instruction:string)=>{onCall?.();if(instruction==='independent review')return {} as T;writerCalls++;return {...before.draft!,body:before.draft!.body+' This revised disclosure describes the author as the promotional publisher, not an independent third-party reviewer.'} as T}}),reviewArticle:async(t,s,c,settings,ai)=>{reviewCalls++;await ai.json('independent review',{});return {...passed(t,s,settings),contextHash:articleContextHash(s,c,settings)}},executeTask:async()=>{executions++;return {status:'review',message:'submitted'}}});controller.runtime.aiReady=true;
    try{
      controller.plan();controller.plan();let saved=store.read().tasks.find(item=>item.id===taskId)!;
      assert.equal(saved.checkpoint,'article_repair');assert.equal(saved.articleRepairAttempts,previousRepair);assert.deepEqual(saved.cost,before.cost);assert.deepEqual(saved.articleAttempts,before.articleAttempts);assert.deepEqual(saved.articleReviewMigration?.review,before.articleReview);assert.deepEqual(saved.articleReviewMigration?.draft,before.draft);
      await controller.tick();saved=store.read().tasks.find(item=>item.id===taskId)!;
      assert.equal(writerCalls,1);assert.equal(reviewCalls,1);assert.equal(executions,1);assert.equal(saved.cost?.aiCalls,6);assert.equal(saved.cost?.amount,0.12);assert.equal(saved.articleRepairAttempts,previousRepair+1);assert.deepEqual(saved.articleAttempts,before.articleAttempts);
      controller.plan();await controller.tick();assert.equal(writerCalls,1);assert.equal(reviewCalls,1);
    }finally{store.close()}
  }
});

test('a migration queued before Gist unbind stops before any AI call and only the same explicit binding can resume it',async()=>{
  const store=fixture({status:'failed'});store.update(state=>{const t=state.tasks[0];t.checkpoint='channel_wait';t.attempts=1;t.articleAutomationVersion=3;t.articleRepairAttempts=1;t.cost={aiCalls:4};t.articleReview=legacyAuthorOnlyReview(t,state.sites[0],state.settings);state.accountBindings=[{id:'66666666-6666-4666-8666-666666666666',siteId,channelId:'github-gist',accountId:defaultAccountId,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z'}]});let calls=0;
  const controller=new Controller(store,fakeVault,'fixture',{aiFactory:(_settings,_vault,onCall)=>({json:async<T>()=>{onCall?.();calls++;return {} as T}})});controller.runtime.aiReady=true;
  try{controller.plan();assert.equal(store.read().tasks[0].checkpoint,'article_repair');store.update(state=>unbindAccount(state,defaultAccountId,siteId,'github-gist'));await controller.tick();const stopped=store.read().tasks[0];assert.equal(stopped.status,'needs_input');assert.equal(stopped.checkpoint,'account_handoff');assert.equal(stopped.cost?.aiCalls,4);assert.equal(calls,0);controller.plan();assert.equal(store.read().tasks[0].status,'needs_input');store.update(state=>state.accountBindings=[{id:'66666666-6666-4666-8666-666666666666',siteId,channelId:'github-gist',accountId:defaultAccountId,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:new Date().toISOString()}]);controller.plan();assert.equal(store.read().tasks[0].status,'queued');assert.equal(store.read().tasks[0].checkpoint,'article_repair');assert.equal(store.read().tasks[0].cost?.aiCalls,4)}finally{store.close()}
});

test('reconnecting after the migrated draft was saved reviews that revision without rewriting it',async()=>{
  const store=fixture({status:'failed'});store.update(state=>{const t=state.tasks[0];t.checkpoint='channel_wait';t.attempts=1;t.articleAutomationVersion=3;t.articleRepairAttempts=1;t.cost={aiCalls:4};t.articleReview=legacyAuthorOnlyReview(t,state.sites[0],state.settings);state.accountBindings=[{id:'66666666-6666-4666-8666-666666666666',siteId,channelId:'github-gist',accountId:defaultAccountId,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z'}]});let writers=0,reviews=0;
  const controller=new Controller(store,fakeVault,'fixture',{aiFactory:(_settings,_vault,onCall)=>({json:async<T>(instruction:string)=>{onCall?.();if(instruction==='independent review')return {} as T;writers++;return {} as T}}),reviewArticle:async(t,s,c,settings,ai)=>{reviews++;await ai.json('independent review',{});return {...passed(t,s,settings),contextHash:articleContextHash(s,c,settings)}},executeTask:async()=>({status:'review',message:'submitted'})});controller.runtime.aiReady=true;
  try{controller.plan();store.update(state=>{const t=state.tasks[0];t.draft={...t.draft!,body:t.draft!.body+' Revised disclosure.'};t.draftRevision=2;t.articleReview=undefined;t.articleRepairAttempts=2;t.cost!.aiCalls=5;t.status='needs_input';t.checkpoint='account_handoff'});controller.plan();assert.equal(store.read().tasks[0].status,'queued');assert.notEqual(store.read().tasks[0].checkpoint,'article_repair');await controller.tick();const saved=store.read().tasks[0];assert.equal(writers,0);assert.equal(reviews,1);assert.equal(saved.draftRevision,2);assert.equal(saved.cost?.aiCalls,6);assert.equal(saved.status,'review')}finally{store.close()}
});

test('a queued legacy repair never spends AI when its draft, repair count, or review mode changes',async()=>{
  for(const changed of ['draft','repair-count','manual-mode'] as const){
    const store=fixture({status:'failed'});store.update(state=>{const t=state.tasks[0];t.checkpoint='channel_wait';t.attempts=1;t.articleAutomationVersion=3;t.cost={aiCalls:4};t.articleReview=legacyAuthorOnlyReview(t,state.sites[0],state.settings);state.accountBindings=[{id:'66666666-6666-4666-8666-666666666666',siteId,channelId:'github-gist',accountId:defaultAccountId,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z'}]});let calls=0;
    const controller=new Controller(store,fakeVault,'fixture',{aiFactory:(_settings,_vault,onCall)=>({json:async<T>()=>{onCall?.();calls++;return {} as T}})});controller.runtime.aiReady=true;
    try{controller.plan();store.update(state=>{if(changed==='draft')state.tasks[0].draft!.body+=' edited after migration';if(changed==='repair-count')state.tasks[0].articleRepairAttempts=1;if(changed==='manual-mode')state.sites[0].articleReviewMode='manual'});await controller.tick();const saved=store.read().tasks[0];assert.equal(saved.status,'needs_input',changed);assert.equal(saved.cost?.aiCalls,4,changed);assert.equal(calls,0,changed)}finally{store.close()}
  }
});

test('legacy review migration excludes manual, external, spent, changed, incomplete, and non-author failures',()=>{
  const scenarios=['manual','approved','paused','disabled','submitted','external-method','receipt','budget','attempts','changed-hash','missing-check','other-fail','v4-review','already-migrated','explicit-unbind','gist-unbind'] as const;
  for(const scenario of scenarios){
    const store=fixture({status:'failed'});store.update(state=>{const t=state.tasks[0];t.checkpoint='channel_wait';t.articleAutomationVersion=3;t.cost={aiCalls:4};t.articleReview=legacyAuthorOnlyReview(t,state.sites[0],state.settings);state.accountBindings=[{id:'66666666-6666-4666-8666-666666666666',siteId,channelId:'github-gist',accountId:defaultAccountId,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z'}];
      if(scenario==='manual')state.sites[0].articleReviewMode='manual';
      if(scenario==='approved')t.articleApprovedAt='2026-10-01T00:00:00.000Z';
      if(scenario==='paused')state.sites[0].status='paused';
      if(scenario==='disabled')state.settings.channelOverrides['github-gist']=false;
      if(scenario==='submitted')t.submittedAt='2026-10-01T00:00:00.000Z';
      if(scenario==='external-method')t.publicationMethod='external';
      if(scenario==='receipt')t.bluesky={did:'did:plc:fixture',rkey:'post',recordHash:'a'.repeat(64),recordCreatedAt:'2026-10-01T00:00:00.000Z',stage:'creating'};
      if(scenario==='budget')t.cost={aiCalls:5};
      if(scenario==='attempts')t.attempts=state.settings.maxAttempts;
      if(scenario==='changed-hash')t.draft!.body+=' altered';
      if(scenario==='missing-check')delete (t.articleReview!.checks as unknown as Record<string,string>).affiliateDisclosure;
      if(scenario==='other-fail')t.articleReview!.checks!.financialSafety='fail';
      if(scenario==='v4-review')t.articleReview!.reviewContractVersion=4;
      if(scenario==='already-migrated')t.articleAutomationVersion=4;
      if(scenario==='explicit-unbind'){
        state.settings.channelOverrides.mataroa=true;t.channelId='mataroa';t.sourceDomain='mataroa.blog';
        state.accounts=[{id:defaultAccountId,channelId:'mataroa',username:'fixtureauthor',email:'',publicationUrl:'https://fixtureauthor.mataroa.blog/',status:'registered',credentialKind:'api_token',hasPassword:true,source:'generated',mataroaExcludedSiteIds:[siteId],createdAt:'2026-09-01T00:00:00.000Z'}];
        state.accountBindings=[];
      }
      if(scenario==='gist-unbind')unbindAccount(state,defaultAccountId,siteId,'github-gist');
    });
    const controller=new Controller(store,fakeVault,'fixture');try{controller.plan();const saved=store.read().tasks.find(item=>item.id===taskId)!;assert.notEqual(saved.checkpoint,'article_repair',scenario);assert.equal(saved.articleReviewMigration,undefined,scenario);assert.equal(saved.cost?.aiCalls,scenario==='budget'?5:4,scenario)}finally{store.close()}
  }
});

test('a same-site topic that redirects to an administrative page switches before any AI call',async()=>{
  const store=fixture();store.update(state=>{state.sites[0].topics=[{url:'https://review-fixture.com/guides/redirect',discoveredAt:'2026-09-01T00:00:00.000Z'},{url:'https://review-fixture.com/guides/usable',discoveredAt:'2026-09-02T00:00:00.000Z'}];const t=state.tasks[0];t.topicUrl='https://review-fixture.com/guides/redirect';t.draft=undefined;t.draftRevision=0;t.checkpoint=undefined;});let providerCalls=0;
  const controller=new Controller(store,fakeVault,'fixture',{readTopicEvidence:async()=>{throw new TopicDiscoveryError('invalid_topic',false)},collectArticleEvidence:async()=>{throw Error('topic evidence must be checked first')},aiFactory:(_settings,_vault,onCall)=>({json:async<T>()=>{onCall?.();providerCalls++;return {} as T}})});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(saved.id,taskId);assert.equal(saved.status,'queued');assert.equal(saved.topicUrl,'https://review-fixture.com/guides/usable');assert.equal(saved.topicSwitchAttempts,1);assert.equal(saved.articleAttempts?.[0].topicUrl,'https://review-fixture.com/guides/redirect');assert.equal(saved.cost?.aiCalls??0,0);assert.equal(providerCalls,0)}finally{store.close()}
});

test('an invalid-topic review result switches an existing draft without spending reviewer AI budget',async()=>{
  const store=fixture();store.update(state=>{state.sites[0].topics=[{url:'https://review-fixture.com/guides/redirect',discoveredAt:'2026-09-01T00:00:00.000Z'},{url:'https://review-fixture.com/guides/usable',discoveredAt:'2026-09-02T00:00:00.000Z'}];const t=state.tasks[0];t.topicUrl='https://review-fixture.com/guides/redirect';t.cost={aiCalls:4};});let reviews=0,executions=0;
  const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{reviews++;return {...passed(t,s,settings),status:'failed',reasonCode:'invalid_topic',reason:'Final topic redirect is administrative.'}},executeTask:async()=>{executions++;return {status:'review',message:'unexpected'}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(saved.status,'queued');assert.equal(saved.topicUrl,'https://review-fixture.com/guides/usable');assert.equal(saved.topicSwitchAttempts,1);assert.equal(saved.cost?.aiCalls,4);assert.equal(saved.draft,undefined);assert.equal(saved.articleAttempts?.[0].articleReview?.reasonCode,'invalid_topic');assert.equal(reviews,1);assert.equal(executions,0)}finally{store.close()}
});
