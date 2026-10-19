import {primeWritingFixtureStore,profileWriterResult} from './writing-fixture';
import {applyEvidencePatchResult,articleDraftPreflight,buildArticleEvidenceSnapshot,buildChannelTermsCache,reviewedChannelTermsCache,type ArticlePatch} from '../src/main/article-evidence';
import {createWritingProfile} from '../src/shared/writing-profile';
import {TaskReasonError} from '../src/shared/task-reasons';
import {SCHEDULING_MESSAGES} from '../src/shared/scheduling';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store,migrateState,emptyState} from '../src/main/store';
import {Controller as MainController,type ControllerServices} from '../src/main/controller';
import {articleContentHash,articleContextHash,articleReviewBindingHash,articleReviewTargetUrl,reviewArticleDraft} from '../src/main/article-review';
import {CHANNELS} from '../src/integrations/catalog';
import type {ArticleReview,ExecutionContext,Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';
import {validateBackup} from '../src/main/backup-validation';
import {runGistTask} from '../src/integrations/gist';
import {dateKey,nextTask,reservesSlot} from '../src/main/planner';
import {TopicDiscoveryError} from '../src/integrations/topics';
import {unbindAccount} from '../src/main/account-bindings';
import {createHumanAction} from '../src/shared/human-action';
import {SCHEDULING_NEW_MESSAGES} from '../src/shared/scheduling-messages';
import {BATCH9A3_RETRY_MESSAGES} from '../src/shared/batch9a3-messages';

// Controller tests isolate every public read, AI provider and publisher by default.
class Controller extends MainController{
  constructor(store:Store,vault:Vault,directory:string,services:ControllerServices={}){
    super(store,vault,directory,{
      readTopicEvidence:async(_site,url)=>({url,title:'Source guide',text:'Public documentation for the original technical workflow and its boundaries.',contentHash:'e'.repeat(64)}),
      collectArticleEvidence:async currentSite=>[{url:currentSite.url,kind:'site',text:currentSite.description,excerpt:currentSite.description}],
      prepareChannelTerms:async current=>reviewedChannelTermsCache(buildChannelTermsCache(current,[{url:current.rulesUrl,kind:'rules',text:'Original articles and disclosed promotional links are allowed.',appliesTo:current.id,applicability:'verified'}]),{finance:'allowed',promotion:'allowed',disclosurePlacement:'end'}),
      reviewArticle:(task,site,channel,settings,ai,signal,deps)=>reviewArticleDraft(task,site,channel,settings,ai,signal,{...deps,fetchHtml:async()=>{throw Error('Unexpected unmocked evidence transport')}}),
      aiFactory:()=>({json:async<T>()=>{throw Error('Unexpected unmocked AI provider')}}),
      executeTask:async()=>{throw Error('Unexpected unmocked publisher')},...services,
    });
  }
}
test.beforeEach(context=>(context as import('node:test').TestContext).mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-18T12:17:00.000Z')}));

const siteId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222',defaultAccountId='44444444-4444-4444-8444-444444444444';
const fixtureChannelIds=new Set(['github-gist','telegraph','github']);
function site():Site{return {topics:[{url:'https://review.example.com/guide-one',discoveredAt:new Date().toISOString()}],topicsCheckedAt:new Date().toISOString(),id:siteId,domain:'review.example.com',url:'https://review.example.com/',email:'owner@review.example.com',name:'Review Fixture',description:'Financial comparison and affiliate referral program',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:'2026-09-01T00:00:00.000Z',analyzedAt:'2026-09-01T00:00:00.000Z',qualifications:{developer:'https://review.example.com/project'}}}
function task(status:Task['status']='queued'):Task{return {id:taskId,siteId,channelId:'github-gist',sourceDomain:'gist.github.com',status,createdAt:'2026-09-01T00:00:00.000Z',scheduledAt:new Date().toISOString(),updatedAt:'2026-09-01T00:00:00.000Z',attempts:0,message:'fixture',checkpoint:'article_review',draftRevision:1,draft:{title:'Operator checklist',description:'A reusable technical checklist.',body:'We operate and maintain Review Fixture. We participate in its affiliate referral program and may receive a commission. Use this reproducible checklist to compare public eligibility rules and record source dates. [Official site](https://review.example.com/)'}}}
const fakeVault={ready:true,available:()=>true,get:async()=>undefined,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})} as unknown as Vault;
function passed(t:Task,s:Site,settings:ReturnType<Store['read']>['settings']):ArticleReview{const channel=CHANNELS.find(item=>item.id==='github-gist')!;return {status:'passed',reason:'All checks passed with public evidence.',reviewedAt:'2026-09-30T00:00:00.000Z',evidenceUrls:[s.url,channel.rulesUrl],draftRevision:t.draftRevision??0,contentHash:articleContentHash(t),contextHash:articleContextHash(s,channel,settings)}}
function fixture(options:{mode?:'manual'|'ai';status?:Task['status'];submitted?:boolean;review?:ArticleReview}={}){
  const store=new Store(':memory:');store.update(state=>{state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(channel=>[channel.id,fixtureChannelIds.has(channel.id)]));state.settings.articleReviewMode=options.mode??'ai';state.settings.autoRun=true;state.settings.dailyAiLimit=40;state.sites=[site()];state.accounts=[{id:defaultAccountId,channelId:'github-gist',username:'fixture-owner',email:'owner@example.com',status:'registered',credentialKind:'api_token',hasPassword:true,createdAt:'2026-09-01T00:00:00.000Z'}];const value=task(options.status);value.accountId=defaultAccountId;if(options.submitted){value.submittedAt='2026-09-30T00:00:00.000Z';value.status='needs_input'}if(options.review)value.articleReview=options.review;state.tasks=[value]});return store;
}

test('AI pass is a separate review call and publishes once with a bound synthetic approval',async()=>{
  const store=fixture();let reviews=0,executions=0,approvedAt='';const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{reviews++;return passed(t,s,settings)},executeTask:async(context:ExecutionContext)=>{executions++;approvedAt=context.task.articleApprovedAt??'';return {status:'review',message:'submitted'}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(reviews,1);assert.equal(executions,1);assert.ok(approvedAt);assert.equal(saved.articleReview?.status,'passed');assert.equal(saved.status,'review');await controller.tick();assert.equal(executions,1)}finally{store.close()}
});

test('b9a3 deterministic preflight failures clear the draft once and stop a repeated failure before review or publishing',async()=>{
  for(const code of ['length_invalid','disclosure_missing','link_count_invalid','language_invalid','site_forbidden_term','site_target_not_allowed','fact_manifest_invalid'] as const){
    const store=fixture();let writerCalls=0,reviewCalls=0,published=0;
    store.update(state=>{
      const value=state.tasks[0],currentSite=state.sites[0];value.cost={aiCalls:1};state.settings.maxAttempts=1;
      value.evidenceSnapshot=buildArticleEvidenceSnapshot(currentSite,undefined,[{url:currentSite.url,kind:'site',text:currentSite.description}]);
      if(code==='length_invalid'){
        currentSite.writingProfile=createWritingProfile(currentSite);
        value.writingEnvelope={disclosure:'Managed disclosure.',risk:'Risk.',signature:'Example',link:'',targetUrl:currentSite.url};
        value.draft!.body+='\n\nManaged disclosure.';
      }
      if(code==='disclosure_missing')value.draft!.body='The source and the guide explain how this software works with a public snapshot. [Source](https://review.example.com/)';
      if(code==='link_count_invalid')value.draft!.body+=' [Second](https://review.example.com/another)';
      if(code==='language_invalid')value.draft!.body='这是完全用中文撰写的正文。'.repeat(20)+' Affiliate disclosure. [来源](https://review.example.com/)';
      if(code==='site_forbidden_term')currentSite.forbiddenTerms=['reusable'];
      if(code==='site_target_not_allowed')currentSite.linkTargets=['https://review.example.com/allowed'];
      if(code==='fact_manifest_invalid')value.factManifest=[{claim:'The guide',url:currentSite.url,quote:'x'}];
    });
    const invalid=structuredClone(store.read().tasks[0]);
    assert.equal(articleDraftPreflight(invalid,store.read().sites[0],CHANNELS.find(value=>value.id==='github-gist')!),code);
    const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{reviewCalls++;return passed(t,s,settings)},executeTask:async()=>{published++;return {status:'review',message:'unexpected'}}});controller.runtime.aiReady=true;
    controller.generateDraft=async()=>{writerCalls++;store.update(state=>{const value=state.tasks.find(item=>item.id===taskId)!;value.draft=invalid.draft;value.writingEnvelope=invalid.writingEnvelope;value.evidenceSnapshot=invalid.evidenceSnapshot;value.factManifest=invalid.factManifest;value.cost!.aiCalls++;value.draftRevision=(value.draftRevision??0)+1})};
    try{
      await controller.tick();let saved=store.read().tasks.find(value=>value.id===taskId)!;
      assert.equal(saved.status,'queued',code);
      assert.deepEqual(saved.draft,invalid.draft,code);assert.equal(saved.formatRepairFailures,1,code);assert.equal(saved.recoveryAttempts,undefined,code);
      await controller.tick();saved=store.read().tasks.find(value=>value.id===taskId)!;
      assert.equal(saved.status,'failed',code);assert.equal(saved.checkpoint,'system_wait',code);assert.equal(saved.recoveryEligible,false,code);assert.equal(saved.nextCheckAt,undefined,code);
      assert.equal(saved.formatRepairFailures,2,code);assert.equal(saved.reasonCode,'format_repair_exhausted',code);
      assert.equal(writerCalls,1,code);assert.equal(reviewCalls,0,code);assert.equal(published,0,code);assert.equal(saved.cost?.aiCalls,2,code);
      for(let round=0;round<3;round++)controller.plan();assert.equal(store.read().tasks.find(value=>value.id===taskId)?.status,'failed',code);
    }finally{store.close()}
  }
});

test('b9a3 deterministic review input failures rewrite only once within the original task budget',async()=>{
  for(const code of ['evidence_invalid'] as const){
    const store=fixture();store.update(state=>{state.tasks[0].cost={aiCalls:1}});let writes=0,reviews=0,published=0;
    const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{reviews++;return {...passed(t,s,settings),status:'failed',reasonCode:code,failureStage:'input',reason:'deterministic fixture failure'}},executeTask:async()=>{published++;return {status:'review',message:'unexpected'}}});controller.runtime.aiReady=true;
    controller.generateDraft=async()=>{writes++;store.update(state=>{const value=state.tasks.find(item=>item.id===taskId)!;value.draft=task().draft;value.cost!.aiCalls++;value.draftRevision=(value.draftRevision??0)+1})};
    try{
      await controller.tick();let saved=store.read().tasks.find(value=>value.id===taskId)!;
      assert.equal(saved.status,'queued',code);assert.equal(saved.draft,undefined,code);assert.equal(saved.recoveryAttempts,1,code);
      await controller.tick();saved=store.read().tasks.find(value=>value.id===taskId)!;
      assert.equal(saved.status,'failed',code);assert.equal(saved.checkpoint,'system_wait',code);assert.equal(saved.recoveryEligible,false,code);assert.equal(saved.nextCheckAt,undefined,code);
      assert.equal(writes,1,code);assert.equal(reviews,2,code);assert.equal(published,0,code);assert.equal(saved.cost?.aiCalls,2,code);assert.equal(saved.temporaryBackoffCount,undefined,code);
      assert.equal(saved.message,BATCH9A3_RETRY_MESSAGES.rewriteStopped('deterministic fixture failure'));
    }finally{store.close()}
  }
});

test('b9a3 deterministic failures with insufficient rewrite and review budget stop without a new draft',async()=>{
  const store=fixture();store.update(state=>{state.tasks[0].cost={aiCalls:3}});let writes=0;
  const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>({...passed(t,s,settings),status:'failed',reasonCode:'format_invalid',failureStage:'input',reason:'deterministic fixture failure'})});controller.runtime.aiReady=true;controller.generateDraft=async()=>{writes++};
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(saved.status,'failed');assert.equal(saved.checkpoint,'system_wait');assert.equal(saved.nextCheckAt,undefined);assert.equal(saved.recoveryEligible,false);assert.ok(saved.draft);assert.equal(writes,0);assert.equal(saved.cost?.aiCalls,3)}finally{store.close()}
});

test('b9a3 publisher format rejection stops without independent backoff or automatic recovery',async()=>{
  const store=fixture(),controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>passed(t,s,settings),executeTask:async()=>({status:'failed',reasonCode:'format_invalid',message:'fixture platform format rejection'})});controller.runtime.aiReady=true;
  try{
    await controller.tick();const saved=store.read().tasks.find(value=>value.id===taskId)!;
    assert.equal(saved.status,'failed');assert.equal(saved.checkpoint,'channel_wait');assert.equal(saved.temporaryRetryCount,0);
    assert.equal(saved.temporaryBackoffCount,undefined);assert.equal(saved.recoveryAttempts,undefined);assert.ok(saved.draft);
  }finally{store.close()}
});

test('9a3 follow-up: an invalid AI review reply re-reviews the same draft after a bounded backoff',async()=>{
  for(const failureStage of ['response',undefined] as const)for(const code of ['format_invalid','evidence_invalid'] as const){
    const store=fixture();store.update(state=>{state.tasks[0].cost={aiCalls:2}});const original=structuredClone(store.read().tasks[0].draft);let writes=0;
    const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>({...passed(t,s,settings),status:'failed',reasonCode:code,failureStage,reason:'fixture invalid review response'})});controller.runtime.aiReady=true;controller.generateDraft=async()=>{writes++};
    try{
      await controller.tick();const saved=store.read().tasks.find(value=>value.id===taskId)!;
      // A legacy format failure of unknown stage asks for a re-draft; with one call left there would be none
      // for the review that must follow, so the draft is kept and the task stops instead of paying for nothing.
      const redraftWithoutReviewBudget=code==='format_invalid'&&failureStage===undefined;
      assert.equal(saved.status,redraftWithoutReviewBudget?'failed':'queued');assert.deepEqual(saved.draft,original);
      if(redraftWithoutReviewBudget)assert.equal(saved.reasonCode,'format_repair_exhausted');
      assert.equal(saved.recoveryAttempts,undefined);assert.equal(writes,0);
      if(code==='format_invalid'){assert.equal(saved.formatRepairFailures,1);assert.equal(saved.temporaryBackoffCount,undefined);assert.equal(saved.nextCheckAt,undefined)}
      else {assert.equal(saved.temporaryBackoffCount,1);assert.ok(saved.nextCheckAt)}
      const restored=validateBackup({state:store.read(),secrets:{['account:'+defaultAccountId]:'fixture-token'}}).state.tasks.find(value=>value.id===taskId)!;
      assert.equal(restored.articleReview?.failureStage,failureStage);assert.deepEqual(restored.draft,original);
    }finally{store.close()}
  }
});

test('b9a3 rejected retry persistence falls through to ordinary failure handling and leaves no running task',async()=>{
  const store=fixture(),update=store.update.bind(store);let rejected=0;
  store.update=(fn:Parameters<Store['update']>[0])=>{
    const draft=structuredClone(store.read());fn(draft);
    const value=draft.tasks.find(item=>item.id===taskId);
    if(value?.temporaryRetryCount===1&&rejected===0){rejected++;throw Error('fixture retry persistence rejected')}
    return update(fn);
  };
  const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>passed(t,s,settings),executeTask:async()=>{throw new TaskReasonError('temporary_failure','fixture platform timeout')}});controller.runtime.aiReady=true;
  try{
    await controller.tick();const state=store.read(),saved=state.tasks.find(value=>value.id===taskId)!;
    assert.equal(rejected,1);assert.notEqual(saved.status,'running');assert.equal(saved.status,'queued');assert.equal(saved.attempts,1);
    assert.equal(saved.temporaryRetryCount,0);assert.equal(state.tasks.length,1);assert.equal(controller.runtime.busy,false);
  }finally{store.close()}
});

test('b9a2 old review failures cannot capture an account handoff during maintenance',()=>{
  const store=fixture();
  store.update(state=>{
    const value=state.tasks[0];state.accounts=[];value.accountId=undefined;
    value.status='needs_input';value.checkpoint='account_handoff';value.reasonCode='account_handoff';value.temporaryRetryCount=1;
    value.articleReview={...passed(value,state.sites[0],state.settings),status:'failed',reasonCode:'ai_unavailable'};
    value.humanAction=createHumanAction(value,{kind:'account_login'});
    value.waitingSince=value.humanAction.since;value.waitingDeadlineAt=value.humanAction.deadline;
  });
  const controller=new Controller(store,fakeVault,'fixture');controller.runtime.aiReady=true;
  try{
    for(let tick=0;tick<4;tick++)controller.plan();
    const saved=store.read().tasks.find(value=>value.id===taskId)!;
    assert.equal(saved.status,'needs_input');assert.equal(saved.checkpoint,'account_handoff');
    assert.equal(saved.channelId,'github-gist');assert.equal(saved.temporaryRetryCount,1);assert.ok(saved.humanAction);
    assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets:{}}));
  }finally{store.close()}
});

test('b9a2 disconnected AI preserves overdue work and reconnect makes it immediately due',context=>{
  const store=fixture(),controller=new Controller(store,fakeVault,'fixture');
  store.update(state=>{const value=state.tasks[0];value.checkpoint='ai_setup_required';value.scheduledAt='2026-10-01T00:00:00.000Z';value.scheduling={version:1,month:'2026-10',slot:0,target:1,effectiveTarget:1,reschedules:0}});
  try{
    for(const day of [18,22,26,30]){
      context.mock.timers.setTime(Date.parse(`2026-10-${day}T12:17:00.000Z`));controller.plan();
      const saved=store.read().tasks.find(value=>value.id===taskId)!;
      assert.equal(saved.status,'queued');assert.equal(saved.scheduledAt,'2026-10-01T00:00:00.000Z');
      assert.equal(saved.scheduling?.reschedules,0);assert.equal(saved.missedPublicationAt,undefined);
    }
    controller.runtime.aiReady=true;controller.plan();
    const saved=store.read().tasks.find(value=>value.id===taskId)!;
    assert.equal(saved.checkpoint,undefined);assert.equal(saved.scheduledAt,new Date().toISOString());
    assert.equal(nextTask(store.read(),new Date(),controller.channels())?.id,taskId);
  }finally{store.close()}
});

test('b9a3 the sole deterministic rewrite stays selectable across AI disconnect and reconnect at the attempt limit',()=>{
  const store=fixture(),controller=new Controller(store,fakeVault,'fixture');
  store.update(state=>{state.settings.maxAttempts=1;Object.assign(state.tasks[0],{attempts:1,recoveryAttempts:1,draft:undefined,checkpoint:undefined,reasonCode:'format_invalid',cost:{aiCalls:1}})});
  try{
    assert.equal(nextTask(store.read(),new Date(),controller.channels())?.id,taskId);
    for(let round=0;round<2;round++){
      controller.runtime.aiReady=false;controller.plan();let saved=store.read().tasks.find(value=>value.id===taskId)!;
      assert.equal(saved.status,'queued');assert.equal(saved.checkpoint,'ai_setup_required');assert.equal(saved.reasonCode,'format_invalid');
      controller.runtime.aiReady=true;controller.plan();saved=store.read().tasks.find(value=>value.id===taskId)!;
      assert.equal(saved.status,'queued');assert.equal(saved.checkpoint,undefined);assert.equal(saved.reasonCode,'format_invalid');
      assert.equal(saved.attempts,1);assert.equal(saved.recoveryAttempts,1);assert.equal(saved.cost?.aiCalls,1);
      assert.equal(nextTask(store.read(),new Date(),controller.channels())?.id,taskId);
    }
  }finally{store.close()}
});

test('b9a3 three independent backoffs stay selectable across AI disconnect and reconnect without reducing attempts',()=>{
  for(const code of ['temporary_failure','ai_rate_limited'] as const){
    const store=fixture(),controller=new Controller(store,fakeVault,'fixture');
    const startedAt=new Date(Date.now()-18*3600000).toISOString();
    store.update(state=>{Object.assign(state.tasks[0],{attempts:state.settings.maxAttempts,temporaryBackoffCount:3,temporaryBackoffStartedAt:startedAt,reasonCode:code,cost:{aiCalls:2}})});
    try{
      assert.equal(nextTask(store.read(),new Date(),controller.channels())?.id,taskId);
      controller.plan();let saved=store.read().tasks.find(value=>value.id===taskId)!;
      assert.equal(saved.status,'queued');assert.equal(saved.checkpoint,'ai_setup_required');assert.equal(saved.reasonCode,code);
      controller.runtime.aiReady=true;controller.plan();saved=store.read().tasks.find(value=>value.id===taskId)!;
      assert.equal(saved.status,'queued');assert.equal(saved.checkpoint,undefined);assert.equal(saved.reasonCode,code);
      assert.equal(saved.attempts,store.read().settings.maxAttempts);assert.equal(saved.temporaryBackoffCount,3);
      assert.equal(saved.temporaryBackoffStartedAt,startedAt);assert.equal(saved.cost?.aiCalls,2);
      assert.equal(nextTask(store.read(),new Date(),controller.channels())?.id,taskId);
    }finally{store.close()}
  }
});

test('b9a2 a prepare human stop after AI reconnect remains a human stop',async()=>{
  const store=fixture();store.update(state=>{state.tasks[0].checkpoint='ai_setup_required'});
  let preparations=0;
  const controller=new Controller(store,fakeVault,'fixture',{prepareTask:async()=>{preparations++;return {status:'needs_input',reasonCode:'phone_required',message:'fixture'}}});controller.runtime.aiReady=true;
  try{
    await controller.tick();await controller.tick();const saved=store.read().tasks.find(value=>value.id===taskId)!;
    assert.equal(preparations,1);assert.equal(saved.status,'needs_input');assert.equal(saved.checkpoint,undefined);
    assert.equal(saved.humanAction?.kind,'phone');assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets:{['account:'+defaultAccountId]:'fixture-token'}}));
  }finally{store.close()}
});

test('b9a2 a post-draft eligibility loss closes the task and never promises draft recovery',async()=>{
  const store=fixture();store.update(state=>{state.tasks[0].draft=undefined});let executions=0;
  const controller=new Controller(store,fakeVault,'fixture',{executeTask:async()=>{executions++;return {status:'review',message:'unexpected'}}});controller.runtime.aiReady=true;
  controller.generateDraft=async()=>{store.update(state=>{state.tasks.find(value=>value.id===taskId)!.draft=task().draft;state.sites[0].qualifications=undefined;state.sites[0].category='general'})};
  try{
    await controller.tick();let saved=store.read().tasks.find(value=>value.id===taskId)!;
    assert.equal(saved.status,'skipped');assert.equal(saved.reasonCode,'channel_ineligible');assert.equal(saved.message,SCHEDULING_NEW_MESSAGES.channelIneligible);assert.equal(executions,0);
    store.update(state=>{state.sites[0].qualifications=site().qualifications;state.sites[0].category='software'});controller.plan();
    saved=store.read().tasks.find(value=>value.id===taskId)!;assert.equal(saved.status,'skipped');
  }finally{store.close()}
});

test('b9a2 a passed review starts a fresh publication retry budget',async()=>{
  const store=fixture();store.update(state=>{state.tasks[0].temporaryRetryCount=2;state.tasks[0].temporaryRetryStage='review';state.tasks[0].temporaryBackoffCount=2});
  let executions=0;
  const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>passed(t,s,settings),executeTask:async()=>{executions++;throw new TaskReasonError('temporary_failure','fixture')}});controller.runtime.aiReady=true;
  try{
    await controller.tick();const saved=store.read().tasks.find(value=>value.id===taskId)!;
    assert.equal(executions,1);assert.equal(saved.status,'queued');assert.equal(saved.channelId,'github-gist');assert.ok(saved.draft);
    assert.equal(saved.temporaryRetryStage,'publish');assert.equal(saved.temporaryRetryCount,1);assert.equal(saved.failedPlatformIds,undefined);
    assert.ok(Date.parse(saved.scheduledAt)>=Date.now()+2*3600000-1000);
  }finally{store.close()}
});

test('b9a2 writer timeouts and AI failures inside a publisher never mark a platform failed',async()=>{
  for(const phase of ['writer','publisher'] as const){
    const store=fixture();store.update(state=>{const value=state.tasks[0];value.temporaryRetryCount=2;value.temporaryRetryStage='publish';if(phase==='writer')value.draft=undefined});
    const controller=new Controller(store,fakeVault,'fixture',{
      aiFactory:()=>({json:async<T>()=>{throw new TaskReasonError('temporary_failure','fixture AI unavailable')}}),
      reviewArticle:async(t,s,_c,settings)=>passed(t,s,settings),
      executeTask:async context=>{await context.ai.json('fixture',{});return {status:'review',message:'unexpected'}},
    });controller.runtime.aiReady=true;
    if(phase==='writer')controller.generateDraft=async()=>{throw new TaskReasonError('temporary_failure','fixture writer timeout')};
    try{
      await controller.tick();const saved=store.read().tasks.find(value=>value.id===taskId)!;
      assert.equal(saved.status,'queued',phase);assert.equal(saved.channelId,'github-gist',phase);
      assert.equal(saved.failedPlatformIds,undefined,phase);assert.equal(saved.temporaryRetryCount,2,phase);assert.equal(saved.temporaryBackoffCount,1,phase);
    }finally{store.close()}
  }
});

test('b9a2 browser-style error results preserve AI provenance without hiding a later platform failure',async()=>{
  for(const recoveredAi of [false,true]){
    const store=fixture();store.update(state=>{const value=state.tasks[0];value.temporaryRetryCount=2;value.temporaryRetryStage='publish'});
    const controller=new Controller(store,fakeVault,'fixture',{
      aiFactory:()=>({json:async<T>()=>{throw new TaskReasonError('temporary_failure','fixture AI timeout')}}),
      reviewArticle:async(t,s,_c,settings)=>passed(t,s,settings),
      executeTask:async context=>{
        try{await context.ai.json('fixture',{})}catch{
          if(!recoveredAi)return {status:'needs_input',reasonCode:'temporary_failure',failureOrigin:'ai',message:'fixture AI timeout'};
        }
        return {status:'failed',reasonCode:'temporary_failure',message:'fixture platform unavailable after recovered AI'};
      },
    });controller.runtime.aiReady=true;
    try{
      await controller.tick();const saved=store.read().tasks.find(value=>value.id===taskId)!;
      assert.equal(saved.status,'queued');assert.equal('failureOrigin' in saved,false);
      if(recoveredAi){assert.equal(saved.channelId,'');assert.deepEqual(saved.failedPlatformIds,['github-gist'])}
      else{assert.equal(saved.channelId,'github-gist');assert.equal(saved.failedPlatformIds,undefined);assert.equal(saved.temporaryBackoffCount,1)}
    }finally{store.close()}
  }
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
    assert.equal(state.tasks.some(item=>item.status==='queued'&&!item.channelId&&item.scheduling?.version===1),true);
    const accountId='55555555-5555-4555-8555-555555555555';store.update(next=>next.accounts.push({id:accountId,channelId:'github-gist',username:'owner',email:'owner@users.noreply.github.com',status:'registered',credentialKind:'api_token',hasPassword:true,createdAt:'2026-09-01T00:00:00.000Z'}));controller.plan();
    const resumed=store.read().tasks.find(item=>item.channelId==='github-gist');assert.equal(resumed?.status,'queued');assert.equal(resumed?.accountId,accountId);
  }finally{store.close()}
});

test('transient evidence review failures back off without blaming or replacing the platform',async()=>{
  const store=fixture();store.update(state=>{state.tasks[0].cost={aiCalls:2}});let reviews=0,executions=0;const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{reviews++;return {...passed(t,s,settings),status:'failed',reason:'公开证据网络暂时不可用',reasonCode:'evidence_fetch_failed'}},executeTask:async()=>{executions++;return {status:'review',message:'unexpected'}}});controller.runtime.aiReady=true;
  try{
    await controller.tick();let saved=store.read().tasks.find(item=>item.id===taskId)!;
    assert.equal(saved.status,'queued');assert.equal(saved.attempts,1);assert.equal(saved.temporaryBackoffCount,1);assert.equal(saved.temporaryRetryCount,undefined);
    assert.ok(Date.parse(saved.scheduledAt)>=Date.now()+2*3600000-60000);
    store.update(state=>{state.tasks.find(item=>item.id===taskId)!.scheduledAt=new Date().toISOString()});
    await controller.tick();saved=store.read().tasks.find(item=>item.id===taskId)!;
    assert.equal(saved.status,'queued');assert.equal(saved.attempts,2);assert.equal(saved.temporaryBackoffCount,2);assert.equal(saved.temporaryRetryCount,undefined);
    assert.ok(Date.parse(saved.scheduledAt)>=Date.now()+8*3600000-60000);
    store.update(state=>{state.tasks.find(item=>item.id===taskId)!.scheduledAt=new Date().toISOString()});
    await controller.tick();saved=store.read().tasks.find(item=>item.id===taskId)!;
    assert.equal(reviews,3);assert.equal(executions,0);assert.equal(saved.status,'queued');
    assert.equal(saved.channelId,'github-gist');assert.ok(saved.draft);
    assert.equal(saved.failedPlatformIds,undefined);assert.equal(saved.temporaryBackoffCount,3);
    assert.equal(saved.cost?.aiCalls,2);
    store.update(state=>{state.tasks.find(item=>item.id===taskId)!.scheduledAt=new Date().toISOString()});
    await controller.tick();saved=store.read().tasks.find(item=>item.id===taskId)!;
    assert.equal(reviews,4);assert.equal(saved.status,'failed');assert.equal(saved.checkpoint,'system_wait');
    assert.equal(saved.recoveryEligible,false);assert.equal(saved.nextCheckAt,undefined);assert.equal(saved.attempts,4);
  }finally{store.close()}
});

test('daily AI exhaustion redistributes remaining work into future business hours',async()=>{
  const store=fixture();const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>({...passed(t,s,settings),status:'failed',reason:'[placeholder review]',reasonCode:'ai_daily_limit'}),executeTask:async()=>({status:'review',message:'unexpected'})});controller.runtime.aiReady=true;
  try{const before=new Date();for(let run=0;run<2;run++){await controller.tick();const state=store.read(),saved=state.tasks.find(item=>item.id===taskId)!;assert.equal(saved.status,'queued');assert.equal(saved.attempts,0);assert.equal(saved.nextCheckAt,saved.scheduledAt);assert.notEqual(dateKey(saved.scheduledAt,state.settings.timezone),dateKey(before,state.settings.timezone));assert.equal(saved.reasonCode,'ai_daily_limit');assert.equal(saved.message,SCHEDULING_MESSAGES.ai_daily_limit);const hour=new Intl.DateTimeFormat('en-US',{timeZone:state.settings.timezone,hour:'numeric',hourCycle:'h23'}).format(new Date(saved.scheduledAt));assert.ok(Number(hour)>=9&&Number(hour)<=23);if(run===0)store.update(next=>{next.tasks.find(item=>item.id===taskId)!.scheduledAt=new Date().toISOString()})}}finally{store.close()}
});

test('execution-stage daily AI limits defer to a future capacity slot without consuming an attempt',async()=>{
  const original=SCHEDULING_MESSAGES.ai_daily_limit;Object.assign(SCHEDULING_MESSAGES,{ai_daily_limit:'[placeholder schedule]'});
  try{for(const throws of [false,true]){
    const store=fixture(),controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>passed(t,s,settings),executeTask:async()=>{if(throws)throw new TaskReasonError('ai_daily_limit','[placeholder error]');return {status:'failed',reasonCode:'ai_daily_limit',message:'[placeholder result]'}}});controller.runtime.aiReady=true;
    try{const before=new Date();await controller.tick();const state=store.read(),saved=state.tasks[0];assert.equal(saved.status,'queued');assert.equal(saved.attempts,0);assert.equal(saved.nextCheckAt,saved.scheduledAt);assert.notEqual(dateKey(saved.scheduledAt,state.settings.timezone),dateKey(before,state.settings.timezone));assert.equal(saved.reasonCode,'ai_daily_limit');assert.equal(saved.message,'[placeholder schedule]')}finally{store.close()}
  }}finally{Object.assign(SCHEDULING_MESSAGES,{ai_daily_limit:original})}
});

test('unknown channel policy is a system wait and never a publication permission',async()=>{
  const store=fixture();let executions=0,notices=0;const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>({...passed(t,s,settings),status:'failed',reason:'only API guidance found',reasonCode:'policy_not_found'}),executeTask:async()=>{executions++;return {status:'review',message:'unexpected'}}});controller.runtime.aiReady=true;controller.onNotice=()=>{notices++};
  try{await controller.tick();const saved=store.read().tasks.find(item=>item.id===taskId)!;assert.equal(saved.status,'failed');assert.equal(saved.checkpoint,'channel_wait');assert.match(saved.message,/许可仍未确认/);assert.equal(executions,0);assert.equal(notices,0)}finally{store.close()}
});

test('an existing registration transaction keeps its checkpoint and only continues inside the verification window',()=>{
  const store=fixture(),channel=CHANNELS.find(item=>item.id==='github')!,recent=new Date().toISOString();
  store.update(state=>{const current=state.tasks[0],account=state.accounts[0];current.channelId=channel.id;current.sourceDomain=channel.domain;current.checkpoint='account_registration_submitted';current.scheduledAt=new Date().toISOString();account.channelId=channel.id;account.email=state.sites[0].email;account.status='needs_verification';account.credentialKind='password';account.lastUsedAt=recent;state.accountBindings=[{id:'binding',siteId,channelId:channel.id,accountId:account.id,createdAt:recent,updatedAt:recent}]});
  const controller=new Controller(store,fakeVault,'fixture');
  try{
    controller.plan();let state=store.read(),saved=state.tasks[0];assert.equal(saved.status,'queued');assert.equal(saved.checkpoint,'account_registration_submitted');assert.equal(nextTask(state,new Date(),CHANNELS)?.id,taskId);
    store.update(next=>{const account=next.accounts[0];account.lastUsedAt='2026-09-01T00:00:00.000Z';const current=next.tasks[0];current.status='queued';current.scheduledAt=new Date().toISOString()});controller.plan();state=store.read();saved=state.tasks.find(item=>item.id===taskId)!;
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
  const controller=new Controller(store,fakeVault,'fixture');controller.runtime.aiReady=true;
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
  const before=structuredClone(store.read().tasks),controller=new Controller(store,fakeVault,'fixture');controller.runtime.aiReady=true;
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

test('draft, site or review-mode changes invalidate an in-flight approval before publication',async()=>{
  for(const mutate of [
    (store:Store)=>store.update(state=>{state.tasks[0].draft!.body+=' changed';state.tasks[0].draftRevision=(state.tasks[0].draftRevision??0)+1}),
    (store:Store)=>store.update(state=>{state.sites[0].description='changed'}),
    (store:Store)=>store.update(state=>{state.sites[0].articleReviewMode='manual'})
  ]){const store=fixture();let release!:()=>void,executions=0;const wait=new Promise<void>(resolve=>{release=resolve});const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{await wait;return passed(t,s,settings)},executeTask:async()=>{executions++;return {status:'review',message:'should not run'}}});controller.runtime.aiReady=true;
    try{const running=controller.tick();await new Promise(resolve=>setImmediate(resolve));mutate(store);release();await running;assert.equal(executions,0);assert.equal(store.read().tasks[0].status,'needs_input');assert.match(store.read().tasks[0].message,/条件发生变化/)}finally{store.close()}}
});

test('changing the selected AI model does not invalidate an in-flight review of the same article',async()=>{
  const store=fixture();let release!:()=>void,executions=0,reviews=0;const wait=new Promise<void>(resolve=>{release=resolve});
  const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(task,site,_channel,settings)=>{reviews++;await wait;return passed(task,site,settings)},executeTask:async()=>{executions++;return {status:'review',message:'submitted'}}});controller.runtime.aiReady=true;
  try{const running=controller.tick();await new Promise(resolve=>setImmediate(resolve));store.update(state=>{state.settings.model='another-fixture-model'});release();await running;assert.equal(reviews,1);assert.equal(executions,1);assert.equal(store.read().tasks[0].articleReview?.status,'passed')}finally{store.close()}
});

test('explicit manual mode keeps the human article gate and never invokes AI review',async()=>{
  const legacy=emptyState();delete (legacy.settings as Partial<typeof legacy.settings>).articleReviewMode;assert.equal(migrateState(legacy).settings.articleReviewMode,'ai');
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

function preparePatchFixture(store:Store){
  store.update(state=>{const current=state.tasks[0],owner=state.sites[0];current.cost={aiCalls:1};current.factManifest=[];current.evidenceSnapshot=buildArticleEvidenceSnapshot(owner,undefined,[{url:owner.url,kind:'site',text:owner.description+' Public source documentation for an article and its scope.'}])});
}
function patchPass(task:Task,site:Site,settings:ReturnType<Store['read']>['settings'],patches:ArticlePatch[]):ArticleReview{
  const result=applyEvidencePatchResult(task.draft!,task.factManifest,patches,task.evidenceSnapshot!);assert.ok(result);
  return {...passed({...task,...result,draftRevision:(task.draftRevision??0)+1},site,settings),patches,factManifest:result.factManifest};
}
const rolePatch:ArticlePatch={field:'body',find:'We operate and maintain Review Fixture.',replace:'Review Fixture.'};

test('a review patch changes only the identified span and publishes without a whole-draft rewrite or second AI review',async()=>{
  const store=fixture();preparePatchFixture(store);const before=structuredClone(store.read().tasks[0]);let reviews=0,providerCalls=0,rewrites=0,executions=0;
  const controller=new Controller(store,fakeVault,'fixture',{aiFactory:(_settings,_vault,onCall)=>({json:async<T>()=>{onCall?.();providerCalls++;return {} as T}}),reviewArticle:async(task,site,_channel,settings,ai)=>{reviews++;await ai.json('independent review',{});return patchPass(task,site,settings,[rolePatch])},executeTask:async context=>{executions++;assert.equal(context.task.draftRevision,2);assert.equal(context.task.articleReview?.status,'passed');return {status:'review',message:'submitted'}}});controller.runtime.aiReady=true;
  controller.generateDraft=async()=>{rewrites++;throw Error('whole-draft rewrite must not run')};
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(reviews,1);assert.equal(providerCalls,1);assert.equal(rewrites,0);assert.equal(executions,1);assert.equal(saved.cost?.aiCalls,2);assert.equal(saved.draft!.body,before.draft!.body.replace(rolePatch.find,rolePatch.replace));assert.equal(saved.articleRepairAttempts,undefined)}finally{store.close()}
});

test('rejection, review outage and an explicit platform prohibition never trigger a whole-draft rewrite or publication',async()=>{
  for(const scenario of ['rejected','outage','prohibited']){const store=fixture();store.update(state=>{state.settings.channelOverrides.telegraph=false});let reviews=0,rewrites=0,executions=0;
    const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(task,site,_channel,settings)=>{reviews++;return {...passed(task,site,settings),status:'failed',reasonCode:scenario==='outage'?'ai_unavailable':'content_rejected',reason:'Not supported',...(scenario==='prohibited'?{checks:{factualAccuracy:'pass',authorRelationship:'pass',affiliateDisclosure:'pass',independentValue:'pass',financialSafety:'pass',channelRules:'fail'} as const}:{})}},executeTask:async()=>{executions++;return {status:'review',message:'unexpected'}}});controller.runtime.aiReady=true;
    controller.generateDraft=async()=>{rewrites++;throw Error('whole-draft rewrite must not run')};
    try{await controller.tick();await controller.tick();await controller.tick();assert.equal(rewrites,0);assert.equal(reviews,1);assert.equal(executions,0);const saved=store.read().tasks.find(task=>task.id===taskId)!;assert.equal(saved.status,scenario==='outage'?'queued':'failed');if(scenario==='outage')assert.ok(Date.parse(saved.scheduledAt)>Date.now())}finally{store.close()}
  }
});

test('pause before a paid patch review or immediately after saving its revision cannot publish until resumed',async()=>{
  for(const savedRevision of [false,true]){const store=fixture();preparePatchFixture(store);let reviews=0,providerCalls=0,rewrites=0,executions=0,paused=false;
    const controller=new Controller(store,fakeVault,'fixture',{aiFactory:(_settings,_vault,onCall)=>({json:async<T>()=>{onCall?.();providerCalls++;return {} as T}}),reviewArticle:async(task,site,_channel,settings,ai)=>{reviews++;if(!savedRevision&&!paused){paused=true;controller.pause();throw Error('任务已暂停')}await ai.json('independent review',{});return task.draft!.body.includes(rolePatch.find)?patchPass(task,site,settings,[rolePatch]):passed(task,site,settings)},executeTask:async()=>{executions++;return {status:'review',message:'submitted'}}});controller.runtime.aiReady=true;
    controller.generateDraft=async()=>{rewrites++;throw Error('whole-draft rewrite must not run')};
    const update=store.update.bind(store);store.update=((mutator:Parameters<Store['update']>[0])=>{update(mutator);if(savedRevision&&!paused&&store.read().tasks[0].draftRevision===2){paused=true;controller.pause()}}) as Store['update'];
    try{await controller.tick();assert.equal(paused,true);assert.equal(executions,0);assert.equal(store.read().settings.autoRun,false);store.update(state=>{state.settings.autoRun=true;state.tasks[0].scheduledAt=new Date().toISOString()});await controller.tick();const saved=store.read().tasks[0];assert.equal(executions,1);assert.equal(rewrites,0);assert.equal(providerCalls,1);assert.equal(reviews,savedRevision?1:2);assert.equal(saved.draftRevision,2);assert.equal(saved.cost?.aiCalls,2)}finally{store.close()}
  }
});

test('a rejected unpublished topic keeps its task and cost, generates one alternate draft, then requires a fresh review',async()=>{
  const store=fixture({status:'failed'});store.update(state=>{const t=state.tasks[0];state.sites[0].topics=[{url:'https://review.example.com/guide-one',discoveredAt:'2026-09-01T00:00:00.000Z'},{url:'https://review.example.com/guide-two',discoveredAt:'2026-09-02T00:00:00.000Z'}];t.topicUrl='https://review.example.com/guide-one';t.checkpoint='channel_wait';t.articleRepairAttempts=1;t.cost={aiCalls:1};t.draftRevision=2;t.articleReview={...passed(t,state.sites[0],state.settings),status:'failed',reasonCode:'content_rejected',reason:'The repaired draft still conflicts with evidence.'};});
  primeWritingFixtureStore(store);let providerCalls=0,reviews=0,executions=0;
  const controller=new Controller(store,fakeVault,'fixture',{
    readTopicEvidence:async(_site,url)=>({url,title:'Guide two',text:'A verified guide with enough source text for a new article.',contentHash:'c'.repeat(64)}),
    collectArticleEvidence:async()=>[],
    aiFactory:(_settings,_vault,onCall)=>({json:async<T>(_instruction:string,data:unknown)=>{onCall?.();providerCalls++;return profileWriterResult({title:'Alternate guide',description:'A fresh evidence-based guide.',body:'A new article based only on the second verified topic.'},data) as T}}),
    reviewArticle:async(t,s,c,settings,ai)=>{reviews++;await ai.json('independent review',{});return {...passed(t,s,settings),bindingVersion:2,targetUrl:articleReviewTargetUrl(t,s),termsHash:c.termsCache?.conclusionHash,contextHash:articleReviewBindingHash(t,s,c)}},
    executeTask:async context=>{executions++;assert.equal(context.task.topicUrl,'https://review.example.com/guide-two');assert.equal(context.task.articleReview?.status,'passed');return {status:'review',message:'submitted'}},
  });controller.runtime.aiReady=true;
  try{
    controller.plan();const switched=store.read().tasks[0];assert.equal(switched.id,taskId);assert.equal(switched.topicUrl,'https://review.example.com/guide-two');assert.equal(switched.cost?.aiCalls,1);assert.equal(switched.draft,undefined);assert.equal(switched.articleReview,undefined);assert.equal(switched.articleAttempts?.[0].topicUrl,'https://review.example.com/guide-one');
    await controller.tick();const saved=store.read().tasks[0];assert.equal(saved.id,taskId);assert.equal(saved.cost?.aiCalls,3);assert.equal(saved.topicSwitchAttempts,1);assert.equal(saved.draftRevision,3);assert.equal(saved.status,'review',saved.message);assert.equal(providerCalls,2);assert.equal(reviews,1);assert.equal(executions,1);
  }finally{store.close()}
});

function legacyAuthorOnlyReview(t:Task,s:Site,settings:ReturnType<Store['read']>['settings']):ArticleReview{
  return {...passed(t,s,settings),status:'failed',reasonCode:'content_rejected',reason:'The author relationship is not publicly established.',reviewContractVersion:3,
    checks:{factualAccuracy:'pass',authorRelationship:'unknown',affiliateDisclosure:'pass',independentValue:'pass',financialSafety:'pass',channelRules:'pass'}};
}

test('a legacy author-only rejection at four calls preserves its evidence without another paid repair or review',async()=>{
  const store=fixture({status:'failed'});store.update(state=>{const task=state.tasks[0];task.checkpoint='channel_wait';task.attempts=1;task.articleAutomationVersion=3;task.cost={aiCalls:4};task.articleReview=legacyAuthorOnlyReview(task,state.sites[0],state.settings);state.accountBindings=[{id:'66666666-6666-4666-8666-666666666666',siteId,channelId:'github-gist',accountId:defaultAccountId,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z'}]});
  const original=structuredClone(store.read().tasks[0]);let writerCalls=0,reviewCalls=0,executions=0;
  const services:ControllerServices={aiFactory:(_settings,_vault,onCall)=>({json:async<T>()=>{onCall?.();writerCalls++;return {} as T}}),reviewArticle:async(task,site,_channel,settings)=>{reviewCalls++;return passed(task,site,settings)},executeTask:async()=>{executions++;return {status:'review',message:'unexpected'}}};
  const controller=new Controller(store,fakeVault,'fixture',services);controller.runtime.aiReady=true;
  try{controller.plan();controller.plan();const restarted=new Controller(store,fakeVault,'fixture',services);restarted.runtime.aiReady=true;await restarted.tick();restarted.plan();await restarted.tick();const saved=store.read().tasks.find(task=>task.id===taskId)!;assert.equal(saved.status,'failed');assert.equal(saved.cost?.aiCalls,4);assert.equal(saved.id,taskId);assert.deepEqual(saved.draft,original.draft);assert.deepEqual(saved.articleReview,original.articleReview);assert.equal(saved.articleReviewMigration,undefined);assert.equal(saved.articleRepairAttempts,undefined);assert.equal(writerCalls,0);assert.equal(reviewCalls,0);assert.equal(executions,0)}finally{store.close()}
});

test('contract migration cannot reset an exhausted budget or discard previous repair and topic evidence',async()=>{
  for(const previousRepair of [0,1])for(const priorTopic of [false,true]){const store=fixture({status:'failed'});store.update(state=>{const task=state.tasks[0];task.checkpoint='channel_wait';task.attempts=1;task.articleAutomationVersion=3;task.articleRepairAttempts=previousRepair;task.cost={aiCalls:4,amount:0.12,currency:'USD'};task.articleReview=legacyAuthorOnlyReview(task,state.sites[0],state.settings);state.accountBindings=[{id:'66666666-6666-4666-8666-666666666666',siteId,channelId:'github-gist',accountId:defaultAccountId,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z'}];if(priorTopic){task.topicSwitchAttempts=1;task.articleAttempts=[{topicUrl:'https://review.example.com/older-guide',recordedAt:'2026-09-29T00:00:00.000Z',reason:'Prior genuine topic attempt',draft:{title:'Older topic',description:'Archived',body:'Original archived draft'},draftRevision:0,articleRepairAttempts:0}]}});
    const before=structuredClone(store.read().tasks[0]);let paidCalls=0,reviewCalls=0,executions=0;
    const controller=new Controller(store,fakeVault,'fixture',{aiFactory:(_settings,_vault,onCall)=>({json:async<T>()=>{onCall?.();paidCalls++;return {} as T}}),reviewArticle:async(task,site,_channel,settings)=>{reviewCalls++;return passed(task,site,settings)},executeTask:async()=>{executions++;return {status:'review',message:'unexpected'}}});controller.runtime.aiReady=true;
    try{controller.plan();controller.plan();await controller.tick();controller.plan();await controller.tick();const saved=store.read().tasks.find(task=>task.id===taskId)!;assert.equal(saved.status,'failed');assert.deepEqual(saved.cost,before.cost);assert.equal(saved.articleRepairAttempts,previousRepair);assert.deepEqual(saved.articleAttempts,before.articleAttempts);assert.deepEqual(saved.draft,before.draft);assert.deepEqual(saved.articleReview,before.articleReview);assert.equal(saved.articleReviewMigration,undefined);assert.equal(paidCalls,0);assert.equal(reviewCalls,0);assert.equal(executions,0)}finally{store.close()}
  }
});

test('a migration queued before Gist unbind stops before any AI call and only the same explicit binding can resume it',async()=>{
  const store=fixture({status:'failed'});store.update(state=>{const t=state.tasks[0];t.checkpoint='channel_wait';t.attempts=1;t.articleAutomationVersion=3;t.articleRepairAttempts=1;t.cost={aiCalls:1};t.articleReview=legacyAuthorOnlyReview(t,state.sites[0],state.settings);state.accountBindings=[{id:'66666666-6666-4666-8666-666666666666',siteId,channelId:'github-gist',accountId:defaultAccountId,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z'}]});let calls=0;
  const controller=new Controller(store,fakeVault,'fixture',{aiFactory:(_settings,_vault,onCall)=>({json:async<T>()=>{onCall?.();calls++;return {} as T}})});controller.runtime.aiReady=true;
  try{controller.plan();assert.equal(store.read().tasks[0].checkpoint,'article_repair');store.update(state=>unbindAccount(state,defaultAccountId,siteId,'github-gist'));await controller.tick();const stopped=store.read().tasks[0];assert.equal(stopped.status,'needs_input');assert.equal(stopped.checkpoint,'account_handoff');assert.equal(stopped.cost?.aiCalls,1);assert.equal(calls,0);controller.plan();assert.equal(store.read().tasks[0].status,'needs_input');store.update(state=>state.accountBindings=[{id:'66666666-6666-4666-8666-666666666666',siteId,channelId:'github-gist',accountId:defaultAccountId,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:new Date().toISOString()}]);controller.plan();assert.equal(store.read().tasks[0].status,'queued');assert.equal(store.read().tasks[0].checkpoint,'article_repair');assert.equal(store.read().tasks[0].cost?.aiCalls,1)}finally{store.close()}
});

test('reconnecting after the migrated draft was saved reviews that revision without rewriting it',async()=>{
  const store=fixture({status:'failed'});store.update(state=>{const t=state.tasks[0];t.checkpoint='channel_wait';t.attempts=1;t.articleAutomationVersion=3;t.articleRepairAttempts=1;t.cost={aiCalls:1};t.articleReview=legacyAuthorOnlyReview(t,state.sites[0],state.settings);state.accountBindings=[{id:'66666666-6666-4666-8666-666666666666',siteId,channelId:'github-gist',accountId:defaultAccountId,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z'}]});let writers=0,reviews=0;
  const controller=new Controller(store,fakeVault,'fixture',{aiFactory:(_settings,_vault,onCall)=>({json:async<T>(instruction:string)=>{onCall?.();if(instruction==='independent review')return {} as T;writers++;return {} as T}}),reviewArticle:async(t,s,c,settings,ai)=>{reviews++;await ai.json('independent review',{});return {...passed(t,s,settings),contextHash:articleContextHash(s,c,settings)}},executeTask:async()=>({status:'review',message:'submitted'})});controller.runtime.aiReady=true;
  try{controller.plan();store.update(state=>{const t=state.tasks[0];t.draft={...t.draft!,body:t.draft!.body+' Revised disclosure.'};t.draftRevision=2;t.articleReview=undefined;t.articleRepairAttempts=2;t.cost!.aiCalls=2;t.status='needs_input';t.checkpoint='account_handoff'});controller.plan();assert.equal(store.read().tasks[0].status,'queued');assert.notEqual(store.read().tasks[0].checkpoint,'article_repair');await controller.tick();const saved=store.read().tasks[0];assert.equal(writers,0);assert.equal(reviews,1);assert.equal(saved.draftRevision,2);assert.equal(saved.cost?.aiCalls,3);assert.equal(saved.status,'review')}finally{store.close()}
});

test('a changed legacy revision needs a fresh independent review while manual mode stops without a rewrite',async()=>{
  for(const changed of ['draft','repair-count','manual-mode'] as const){const store=fixture({status:'failed'});store.update(state=>{const task=state.tasks[0];task.checkpoint='channel_wait';task.articleAutomationVersion=3;task.cost={aiCalls:1};task.articleReview=legacyAuthorOnlyReview(task,state.sites[0],state.settings);state.accountBindings=[{id:'66666666-6666-4666-8666-666666666666',siteId,channelId:'github-gist',accountId:defaultAccountId,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z'}]});let paidCalls=0,reviews=0,rewrites=0,executions=0;
    const controller=new Controller(store,fakeVault,'fixture',{aiFactory:(_settings,_vault,onCall)=>({json:async<T>()=>{onCall?.();paidCalls++;return {} as T}}),reviewArticle:async(task,site,_channel,settings,ai)=>{reviews++;if(changed==='draft')assert.match(task.draft!.body,/edited after migration/);await ai.json('independent review',{});return passed(task,site,settings)},executeTask:async()=>{executions++;return {status:'review',message:'submitted'}}});controller.runtime.aiReady=true;controller.generateDraft=async()=>{rewrites++;throw Error('whole rewrite must not run')};
    try{controller.plan();store.update(state=>{if(changed==='draft'){state.tasks[0].draft!.body+=' edited after migration';state.tasks[0].draftRevision=2}if(changed==='repair-count')state.tasks[0].articleRepairAttempts=1;if(changed==='manual-mode')state.sites[0].articleReviewMode='manual'});await controller.tick();const saved=store.read().tasks[0];assert.equal(rewrites,0);assert.equal(reviews,changed==='manual-mode'?0:1);assert.equal(paidCalls,changed==='manual-mode'?0:1);assert.equal(executions,changed==='manual-mode'?0:1);assert.equal(saved.cost?.aiCalls,changed==='manual-mode'?1:2);if(changed==='manual-mode')assert.equal(saved.status,'needs_input');else assert.equal(saved.articleReview?.contentHash,articleContentHash(saved))}finally{store.close()}
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
  const store=fixture();store.update(state=>{state.sites[0].topics=[{url:'https://review.example.com/guides/redirect',discoveredAt:'2026-09-01T00:00:00.000Z'},{url:'https://review.example.com/guides/usable',discoveredAt:'2026-09-02T00:00:00.000Z'}];const t=state.tasks[0];t.topicUrl='https://review.example.com/guides/redirect';t.draft=undefined;t.draftRevision=0;t.checkpoint=undefined;});let providerCalls=0;
  const controller=new Controller(store,fakeVault,'fixture',{readTopicEvidence:async()=>{throw new TopicDiscoveryError('invalid_topic',false)},collectArticleEvidence:async()=>{throw Error('topic evidence must be checked first')},aiFactory:(_settings,_vault,onCall)=>({json:async<T>()=>{onCall?.();providerCalls++;return {} as T}})});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(saved.id,taskId);assert.equal(saved.status,'queued');assert.equal(saved.topicUrl,'https://review.example.com/guides/usable');assert.equal(saved.topicSwitchAttempts,1);assert.equal(saved.articleAttempts?.[0].topicUrl,'https://review.example.com/guides/redirect');assert.equal(saved.cost?.aiCalls??0,0);assert.equal(providerCalls,0)}finally{store.close()}
});

test('an invalid-topic review result switches an existing draft without spending reviewer AI budget',async()=>{
  const store=fixture();store.update(state=>{state.sites[0].topics=[{url:'https://review.example.com/guides/redirect',discoveredAt:'2026-09-01T00:00:00.000Z'},{url:'https://review.example.com/guides/usable',discoveredAt:'2026-09-02T00:00:00.000Z'}];const t=state.tasks[0];t.topicUrl='https://review.example.com/guides/redirect';t.cost={aiCalls:1};});let reviews=0,executions=0;
  const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>{reviews++;return {...passed(t,s,settings),status:'failed',reasonCode:'invalid_topic',reason:'Final topic redirect is administrative.'}},executeTask:async()=>{executions++;return {status:'review',message:'unexpected'}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(saved.status,'queued');assert.equal(saved.topicUrl,'https://review.example.com/guides/usable');assert.equal(saved.topicSwitchAttempts,1);assert.equal(saved.cost?.aiCalls,1);assert.equal(saved.draft,undefined);assert.equal(saved.articleAttempts?.[0].articleReview?.reasonCode,'invalid_topic');assert.equal(reviews,1);assert.equal(executions,0)}finally{store.close()}
});

test('coded browser execution failures leave needs-input through bounded recovery or terminal cooldown',async()=>{
  for(const code of ['ai_task_limit','format_invalid','temporary_failure','platform_rejected'] as const){
    const store=fixture();let executions=0;
    const controller=new Controller(store,fakeVault,'fixture',{reviewArticle:async(t,s,_c,settings)=>passed(t,s,settings),executeTask:async()=>{executions++;return {status:'needs_input',reasonCode:code,message:'[placeholder browser failure]'}}});
    controller.runtime.aiReady=true;
    try{
      await controller.tick();const saved=store.read().tasks.find(item=>item.id===taskId)!;
      assert.equal(saved.reasonCode,code);assert.equal(saved.waitingDeadlineAt,undefined);assert.equal(executions,1);
      if(code==='ai_task_limit'||code==='platform_rejected'){assert.equal(saved.status,'failed');assert.ok(saved.cooldownUntil)}
      else if(code==='format_invalid'){assert.equal(saved.status,'failed');assert.equal(saved.checkpoint,'channel_wait');assert.equal(saved.recoveryEligible,false)}
      else{assert.equal(saved.status,'queued');assert.ok(Date.parse(saved.scheduledAt)>Date.now());assert.equal(saved.cooldownUntil,undefined)}
    }finally{store.close()}
  }
});

test('uncoded definite Gist refusals finish with cooldown but a saved invalid identity waits for its owner',async()=>{
  for(const invalidCredential of [false,true]){
    const store=fixture();
    const controller=new Controller(store,fakeVault,'fixture',{
      reviewArticle:async(t,s,_c,settings)=>passed(t,s,settings),
      executeTask:async()=>{
        if(invalidCredential)store.update(state=>{state.accounts[0].status='credentials_invalid'});
        return {status:'needs_input',checkpoint:'gist_rejected',message:'[placeholder refusal]'};
      },
    });
    controller.runtime.aiReady=true;
    try{
      await controller.tick();const saved=store.read().tasks.find(item=>item.id===taskId)!;
      assert.equal(saved.status,invalidCredential?'needs_input':'failed');
      assert.equal(saved.reasonCode,invalidCredential?'account_handoff':'platform_rejected');
      assert.equal(!!saved.cooldownUntil,!invalidCredential);assert.equal(!!saved.waitingDeadlineAt,invalidCredential);
    }finally{store.close()}
  }
});
