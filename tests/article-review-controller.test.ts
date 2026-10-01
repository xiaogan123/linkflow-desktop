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

const siteId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222';
function site():Site{return {id:siteId,domain:'review-fixture.com',url:'https://review-fixture.com/',email:'owner@review-fixture.com',name:'Review Fixture',description:'Financial comparison and affiliate referral program',category:'finance',language:'en',monthlyTarget:1,status:'ready',createdAt:'2026-09-01T00:00:00.000Z',analyzedAt:'2026-09-01T00:00:00.000Z',qualifications:{developer:'https://review-fixture.com/project'}}}
function task(status:Task['status']='queued'):Task{return {id:taskId,siteId,channelId:'github-gist',sourceDomain:'gist.github.com',status,createdAt:'2026-09-01T00:00:00.000Z',scheduledAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z',attempts:0,message:'fixture',checkpoint:'article_review',draftRevision:1,draft:{title:'Operator checklist',description:'A reusable technical checklist.',body:'We operate and maintain Review Fixture. We participate in its affiliate referral program and may receive a commission. Use this reproducible checklist to compare public eligibility rules and record source dates. [Official site](https://review-fixture.com/)'}}}
const fakeVault={ready:true,available:()=>true,get:async()=>undefined,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})} as unknown as Vault;
function passed(t:Task,s:Site,settings:ReturnType<Store['read']>['settings']):ArticleReview{const channel=CHANNELS.find(item=>item.id==='github-gist')!;return {status:'passed',reason:'All checks passed with public evidence.',reviewedAt:'2026-09-30T00:00:00.000Z',evidenceUrls:[s.url,channel.rulesUrl],draftRevision:t.draftRevision??0,contentHash:articleContentHash(t),contextHash:articleContextHash(s,channel,settings)}}
function fixture(options:{mode?:'manual'|'ai';status?:Task['status'];submitted?:boolean;review?:ArticleReview}={}){
  const store=new Store(':memory:');store.update(state=>{state.settings.articleReviewMode=options.mode??'ai';state.settings.autoRun=true;state.settings.dailyAiLimit=40;state.sites=[site()];const value=task(options.status);if(options.submitted){value.submittedAt='2026-09-30T00:00:00.000Z';value.status='needs_input'}if(options.review)value.articleReview=options.review;state.tasks=[value]});return store;
}

test('AI pass is a separate review call and publishes once with a bound synthetic approval',async()=>{
  const store=fixture();let reviews=0,executions=0,approvedAt='';const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{reviews++;return passed(t,s,settings)},executeTask:async(context:ExecutionContext)=>{executions++;approvedAt=context.task.articleApprovedAt??'';return {status:'review',message:'submitted'}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(reviews,1);assert.equal(executions,1);assert.ok(approvedAt);assert.equal(saved.articleReview?.status,'passed');assert.equal(saved.status,'review');await controller.tick();assert.equal(executions,1)}finally{store.close()}
});

test('ordinary content API articles also require the independent AI review',async()=>{
  const store=fixture();store.update(state=>{state.sites[0].category='content';state.sites[0].description='Operator-authored publishing guides';state.tasks[0].channelId='telegraph';state.tasks[0].sourceDomain='telegra.ph'});let reviews=0,executions=0;const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,c,settings)=>{reviews++;return {status:'passed',reason:'checked',reviewedAt:'2026-09-30T00:00:00.000Z',evidenceUrls:[s.url,c.rulesUrl],draftRevision:t.draftRevision??0,contentHash:articleContentHash(t),contextHash:articleContextHash(s,c,settings)}},executeTask:async()=>{executions++;return {status:'review',message:'submitted'}}});controller.runtime.aiReady=true;
  try{await controller.tick();assert.equal(reviews,1);assert.equal(executions,1);assert.equal(store.read().tasks[0].articleReview?.status,'passed')}finally{store.close()}
});

test('site mode overrides the global gate in both directions',async()=>{
  const aiStore=fixture({mode:'manual'});aiStore.update(state=>{state.sites[0].articleReviewMode='ai';state.tasks[0].articleApprovedAt='2026-09-30T00:00:00.000Z'});let aiReviews=0,aiExecutions=0;const aiController=new Controller(aiStore,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{aiReviews++;return passed(t,s,settings)},executeTask:async()=>{aiExecutions++;return {status:'review',message:'submitted'}}});aiController.runtime.aiReady=true;
  try{await aiController.tick();assert.equal(aiReviews,1);assert.equal(aiExecutions,1)}finally{aiStore.close()}
  const manualStore=fixture({mode:'ai'});manualStore.update(state=>{state.sites[0].articleReviewMode='manual'});let manualReviews=0,manualExecutions=0;const manualController=new Controller(manualStore,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{manualReviews++;return passed(t,s,settings)},executeTask:async()=>{manualExecutions++;return {status:'review',message:'unexpected'}}});manualController.runtime.aiReady=true;
  try{await manualController.tick();assert.equal(manualStore.read().tasks[0].status,'needs_input');assert.equal(manualReviews,0);assert.equal(manualExecutions,0)}finally{manualStore.close()}
});

test('reject and unknown outcomes stop at needs_input without publication or automatic rerun',async()=>{
  for(const reason of ['公开事实与稿件冲突','公开证据不足，无法核实']){const store=fixture();let reviews=0,executions=0;const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{reviews++;return {...passed(t,s,settings),status:'failed',reason}},executeTask:async()=>{executions++;return {status:'review',message:'should not run'}}});controller.runtime.aiReady=true;
    try{await controller.tick();assert.equal(store.read().tasks[0].status,'needs_input');assert.equal(store.read().tasks[0].articleReview?.status,'failed');assert.equal(executions,0);await controller.tick();assert.equal(reviews,1);assert.equal(executions,0)}finally{store.close()}}
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
  const state=emptyState(),s=site(),t=task('queued');state.sites=[s];state.settings.articleReviewMode='ai';t.articleApprovedAt='2026-09-30T00:00:00.000Z';t.articleReview=passed(t,s,state.settings);state.tasks=[t];
  const restored=validateBackup({state,secrets:{}}).state.tasks[0];assert.equal(restored.articleApprovedAt,undefined);assert.equal(restored.articleReview?.status,'failed');assert.match(restored.articleReview?.reason??'',/必须重新核对/);assert.deepEqual(restored.articleReview?.evidenceUrls,t.articleReview.evidenceUrls);
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
