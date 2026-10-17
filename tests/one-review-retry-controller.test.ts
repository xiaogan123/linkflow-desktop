import test from 'node:test';
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
const channel=CHANNELS.find(item=>item.id==='telegraph')!;
const fakeVault={ready:true,available:()=>true,get:async()=>undefined,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})} as unknown as Vault;

function site():Site{return {id:SITE_ID,domain:'retry-fixture.invalid',url:'https://retry-fixture.invalid/',email:'owner@retry-fixture.invalid',publicEmail:'public@retry-fixture.invalid',name:'Synthetic retry fixture',description:'A synthetic educational publishing fixture.',category:'content',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:STAMP,analyzedAt:STAMP}}
function task():Task{return {id:TASK_ID,siteId:SITE_ID,channelId:channel.id,sourceDomain:channel.domain,status:'needs_input',createdAt:STAMP,scheduledAt:STAMP,updatedAt:STAMP,attempts:0,message:'Synthetic restored review requires explicit action.',checkpoint:'article_review',draftRevision:3,draft:{title:'Synthetic review retry',description:'Synthetic summary.',body:'Synthetic article body used only for an isolated controller test.'},cost:{aiCalls:6}}}
function fixture(){
  const store=new Store(':memory:');
  store.update(state=>{state.settings.articleReviewMode='ai';state.settings.autoRun=false;state.settings.dailyAiLimit=40;state.settings.model='synthetic-review-model';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id===channel.id]));const currentSite=site(),currentTask=task();currentTask.articleReview={status:'failed',reason:'Synthetic restored result cannot authorize publication.',reasonCode:'passed',reviewContractVersion:4,reviewedAt:STAMP,evidenceUrls:[],draftRevision:3,contentHash:articleContentHash(currentTask),contextHash:articleContextHash(currentSite,channel,state.settings)};state.sites=[currentSite];state.tasks=[currentTask]});
  return store;
}
function review(task:Task,currentSite:Site,settings:ReturnType<Store['read']>['settings'],status:'passed'|'failed'='passed'):ArticleReview{return {status,reason:status==='passed'?'Synthetic independent review passed.':'Synthetic independent review rejected the draft.',reasonCode:status==='passed'?'passed':'content_rejected',reviewedAt:'2026-10-17T01:05:00.000Z',evidenceUrls:[currentSite.url,channel.rulesUrl],draftRevision:task.draftRevision??0,contentHash:articleContentHash(task),contextHash:articleContextHash(currentSite,channel,settings)}}

test('the explicit one-shot review consumes call 7 once and returns a pass only to the normal queue',async()=>{
  const store=fixture();let providerCalls=0,executions=0;
  const controller=new Controller(store,fakeVault,'synthetic',{aiFactory:(_settings,_vault,onCall,onUsage)=>({json:async<T>()=>{onCall?.();providerCalls++;onUsage?.({inputTokens:11,outputTokens:7});return {} as T}}),reviewArticle:async(currentTask,currentSite,_channel,settings,ai)=>{await ai.json('synthetic independent review',{});return review(currentTask,currentSite,settings)},executeTask:async()=>{executions++;return {status:'review',message:'must not execute from the one-shot method'}}});controller.runtime.aiReady=true;
  try{
    assert.equal(controller.oneReviewRetrySummary(TASK_ID).draftRevision,3);
    const result=await controller.reviewArticleOnce(TASK_ID),saved=store.read().tasks[0];
    assert.equal(result.status,'passed');assert.equal(providerCalls,1);assert.equal(executions,0);assert.equal(saved.cost?.aiCalls,7);assert.equal(saved.cost?.inputTokens,11);assert.equal(saved.oneReviewRetry?.status,'consumed');assert.equal(saved.articleReview?.status,'passed');assert.equal(saved.status,'queued');assert.match(saved.message,/正常任务队列/);
    await assert.rejects(controller.reviewArticleOnce(TASK_ID),/already_recorded|不能追加/);assert.equal(providerCalls,1);
  }finally{store.close()}
});

test('a consumed rejection stops without repair, topic switching, publication or another grant',async()=>{
  const store=fixture();let providerCalls=0,executions=0;
  const controller=new Controller(store,fakeVault,'synthetic',{aiFactory:(_settings,_vault,onCall)=>({json:async<T>()=>{onCall?.();providerCalls++;return {} as T}}),reviewArticle:async(currentTask,currentSite,_channel,settings,ai)=>{await ai.json('synthetic independent review',{});return review(currentTask,currentSite,settings,'failed')},executeTask:async()=>{executions++;return {status:'review',message:'unexpected'}}});controller.runtime.aiReady=true;
  try{const result=await controller.reviewArticleOnce(TASK_ID),saved=store.read().tasks[0];assert.equal(result.status,'failed');assert.equal(providerCalls,1);assert.equal(executions,0);assert.equal(saved.cost?.aiCalls,7);assert.equal(saved.oneReviewRetry?.status,'consumed');assert.equal(saved.status,'failed');assert.equal(saved.checkpoint,'article_review');assert.equal(saved.nextCheckAt,undefined);assert.equal(saved.topicSwitchAttempts,undefined);assert.equal(saved.articleRepairAttempts,undefined);assert.match(saved.message,/不会自动修稿、换题或再次追加/);await assert.rejects(controller.reviewArticleOnce(TASK_ID))}finally{store.close()}
});

test('returning before ai.json invalidates the sole authorization without spending or allowing reuse',async()=>{
  const store=fixture(),controller=new Controller(store,fakeVault,'synthetic',{reviewArticle:async(currentTask,currentSite,_channel,settings)=>review(currentTask,currentSite,settings)});controller.runtime.aiReady=true;
  try{await assert.rejects(controller.reviewArticleOnce(TASK_ID),/未在请求开始前完成消费/);const saved=store.read().tasks[0];assert.equal(saved.cost?.aiCalls,6);assert.equal(saved.oneReviewRetry?.status,'invalidated');assert.equal(saved.oneReviewRetry?.status==='invalidated'&&saved.oneReviewRetry.invalidationReason,'request_not_started');await assert.rejects(controller.reviewArticleOnce(TASK_ID),/already_recorded|不能追加/)}finally{store.close()}
});

test('daily exhaustion is checked in the same pre-dispatch transaction and permanently closes the grant',async()=>{
  const store=fixture();store.update(state=>{const key=dateKey(new Date(),state.settings.timezone);state.settings.dailyAiLimit=1;state.usage[key]=1});let providerCalls=0;
  const controller=new Controller(store,fakeVault,'synthetic',{aiFactory:(_settings,_vault,onCall)=>({json:async<T>()=>{onCall?.();providerCalls++;return {} as T}}),reviewArticle:async(currentTask,currentSite,_channel,settings,ai)=>{await ai.json('synthetic independent review',{});return review(currentTask,currentSite,settings)}});controller.runtime.aiReady=true;
  try{await assert.rejects(controller.reviewArticleOnce(TASK_ID),/今日 AI 调用已达上限/);const saved=store.read().tasks[0];assert.equal(providerCalls,0);assert.equal(saved.cost?.aiCalls,6);assert.equal(saved.oneReviewRetry?.status,'invalidated');assert.equal(saved.oneReviewRetry?.status==='invalidated'&&saved.oneReviewRetry.invalidationReason,'request_not_started')}finally{store.close()}
});

test('a second click is rejected while the first one-shot request is in flight',async()=>{
  const store=fixture();let release!:()=>void,started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve}),wait=new Promise<void>(resolve=>{release=resolve});
  const controller=new Controller(store,fakeVault,'synthetic',{aiFactory:(_settings,_vault,onCall)=>({json:async<T>()=>{onCall?.();started();await wait;return {} as T}}),reviewArticle:async(currentTask,currentSite,_channel,settings,ai)=>{await ai.json('synthetic independent review',{});return review(currentTask,currentSite,settings)}});controller.runtime.aiReady=true;
  try{const first=controller.reviewArticleOnce(TASK_ID);await began;await assert.rejects(controller.reviewArticleOnce(TASK_ID),/等待当前操作完成/);release();await first;assert.equal(store.read().tasks[0].cost?.aiCalls,7)}finally{store.close()}
});
