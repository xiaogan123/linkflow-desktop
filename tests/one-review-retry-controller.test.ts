import test,{beforeEach,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {dateKey} from '../src/main/planner';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {CHANNELS} from '../src/integrations/catalog';
import type {ArticleReview,Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const SITE_ID='11111111-1111-4111-8111-111111111111';
const TASK_ID='22222222-2222-4222-8222-222222222222';
const STAMP='2026-10-17T01:00:00.000Z';
beforeEach(t=>(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-19T10:17:00.000Z')}));
const channel=CHANNELS.find(item=>item.id==='telegraph')!;
const fakeVault={ready:true,available:()=>true,get:async()=>undefined,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})} as unknown as Vault;

function site():Site{return {id:SITE_ID,domain:'retry-fixture.invalid',url:'https://retry-fixture.invalid/',email:'owner@retry-fixture.invalid',publicEmail:'public@retry-fixture.invalid',name:'Synthetic retry fixture',description:'A synthetic educational publishing fixture.',category:'content',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:STAMP,analyzedAt:STAMP}}
function task():Task{return {id:TASK_ID,siteId:SITE_ID,channelId:channel.id,sourceDomain:channel.domain,status:'needs_input',createdAt:STAMP,scheduledAt:STAMP,updatedAt:STAMP,attempts:0,message:'Synthetic restored review requires explicit action.',checkpoint:'article_review',draftRevision:3,draft:{title:'Synthetic review retry',description:'Synthetic summary.',body:'Synthetic article body used only for an isolated controller test.'},cost:{aiCalls:4}}}
function fixture(){
  const store=new Store(':memory:');
  store.update(state=>{state.settings.articleReviewMode='ai';state.settings.autoRun=false;state.settings.dailyAiLimit=40;state.settings.model='synthetic-review-model';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id===channel.id]));const currentSite=site(),currentTask=task();currentTask.articleReview={status:'failed',reason:'Synthetic restored result cannot authorize publication.',reasonCode:'passed',reviewContractVersion:4,reviewedAt:STAMP,evidenceUrls:[],draftRevision:3,contentHash:articleContentHash(currentTask),contextHash:articleContextHash(currentSite,channel,state.settings)};state.sites=[currentSite];state.tasks=[currentTask]});
  return store;
}
function review(task:Task,currentSite:Site,settings:ReturnType<Store['read']>['settings'],status:'passed'|'failed'='passed'):ArticleReview{return {status,reason:status==='passed'?'Synthetic independent review passed.':'Synthetic independent review rejected the draft.',reasonCode:status==='passed'?'passed':'content_rejected',reviewedAt:'2026-10-17T01:05:00.000Z',evidenceUrls:[currentSite.url,channel.rulesUrl],draftRevision:task.draftRevision??0,contentHash:articleContentHash(task),contextHash:articleContextHash(currentSite,channel,settings)}}

test('an explicit retry cannot exceed the four-call lifetime limit or reach publication',async()=>{
  const store=fixture();let providerCalls=0,executions=0,reviews=0;
  const controller=new Controller(store,fakeVault,'synthetic',{aiFactory:(_settings,_vault,onCall)=>({json:async<T>()=>{onCall?.();providerCalls++;return {} as T}}),reviewArticle:async(current,currentSite,_channel,settings)=>{reviews++;return review(current,currentSite,settings)},executeTask:async()=>{executions++;return {status:'review',message:'must not execute'}}});controller.runtime.aiReady=true;
  try{assert.throws(()=>controller.oneReviewRetrySummary(TASK_ID),{code:'ai_task_limit'});await assert.rejects(controller.reviewArticleOnce(TASK_ID),{code:'ai_task_limit'});const saved=store.read().tasks[0];assert.equal(saved.cost?.aiCalls,4);assert.equal(saved.oneReviewRetry,undefined);assert.equal(saved.status,'needs_input');assert.equal(providerCalls,0);assert.equal(reviews,0);assert.equal(executions,0);assert.equal(saved.topicSwitchAttempts,undefined);assert.equal(saved.articleRepairAttempts,undefined)}finally{store.close()}
});

test('legacy six-call history stays intact but cannot authorize an additional paid review',async()=>{
  const store=fixture();store.update(state=>state.tasks[0].cost={aiCalls:6,inputTokens:11,outputTokens:7});let calls=0;
  const controller=new Controller(store,fakeVault,'synthetic',{reviewArticle:async(current,currentSite,_channel,settings)=>{calls++;return review(current,currentSite,settings,'failed')}});controller.runtime.aiReady=true;
  try{const before=structuredClone(store.read().tasks[0]);await assert.rejects(controller.reviewArticleOnce(TASK_ID),{code:'ai_task_limit'});const saved=store.read().tasks[0];assert.deepEqual(saved,before);assert.equal(calls,0);assert.equal(saved.oneReviewRetry,undefined);assert.equal(saved.nextCheckAt,undefined);assert.equal(saved.topicSwitchAttempts,undefined);assert.equal(saved.articleRepairAttempts,undefined)}finally{store.close()}
});

test('the budget gate runs before a reviewer can return without starting a paid request',async()=>{
  const store=fixture();let calls=0;
  const controller=new Controller(store,fakeVault,'synthetic',{reviewArticle:async(current,currentSite,_channel,settings)=>{calls++;return review(current,currentSite,settings)}});controller.runtime.aiReady=true;
  try{await assert.rejects(controller.reviewArticleOnce(TASK_ID),{code:'ai_task_limit'});assert.equal(calls,0);assert.equal(store.read().tasks[0].cost?.aiCalls,4);assert.equal(store.read().tasks[0].oneReviewRetry,undefined);await assert.rejects(controller.reviewArticleOnce(TASK_ID),{code:'ai_task_limit'})}finally{store.close()}
});

test('daily exhaustion cannot create a grant that bypasses the lifetime budget',async()=>{
  const store=fixture();store.update(state=>{const key=dateKey(new Date(),state.settings.timezone);state.settings.dailyAiLimit=1;state.usage[key]=1});let calls=0;
  const controller=new Controller(store,fakeVault,'synthetic',{aiFactory:(_settings,_vault,onCall)=>({json:async<T>()=>{onCall?.();calls++;return {} as T}})});controller.runtime.aiReady=true;
  try{const usage=structuredClone(store.read().usage);await assert.rejects(controller.reviewArticleOnce(TASK_ID),{code:'ai_task_limit'});assert.equal(calls,0);assert.deepEqual(store.read().usage,usage);assert.equal(store.read().tasks[0].oneReviewRetry,undefined);assert.equal(store.read().tasks[0].cost?.aiCalls,4)}finally{store.close()}
});

test('concurrent retry clicks cannot race past the lifetime budget or leave an active grant',async()=>{
  const store=fixture();let calls=0;
  const controller=new Controller(store,fakeVault,'synthetic',{reviewArticle:async(current,currentSite,_channel,settings)=>{calls++;return review(current,currentSite,settings)}});controller.runtime.aiReady=true;
  try{const outcomes=await Promise.allSettled([controller.reviewArticleOnce(TASK_ID),controller.reviewArticleOnce(TASK_ID)]);assert.equal(outcomes.every(result=>result.status==='rejected'&&(result.reason as {code:string}).code==='ai_task_limit'),true);assert.equal(calls,0);assert.equal(store.read().tasks[0].cost?.aiCalls,4);assert.equal(store.read().tasks[0].oneReviewRetry,undefined);assert.equal(controller.runtime.busy,false)}finally{store.close()}
});
