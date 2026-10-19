import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureTerms,primeWritingFixtureStore} from './writing-fixture';
import {Controller} from '../src/main/controller';
import {Store} from '../src/main/store';
import {reviewArticleDraft} from '../src/main/article-review';
import {TASK_AI_BUDGET} from '../src/main/task-recovery';
import type {AiPort,Channel,Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';
const now='2026-11-16T10:17:00.000Z',old='2026-10-01T10:17:00.000Z';
const site:Site={id:'11111111-1111-4111-8111-111111111111',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Technical documentation',language:'en',category:'developer',status:'ready',createdAt:old,monthlyTarget:2,articleReviewMode:'ai',topicsCheckedAt:now,topics:[{url:'https://example.com/guide',title:'Source materials',discoveredAt:old}]};
const channel:Channel={id:'fixture-article',name:'Example Publisher',domain:'publisher.example.com',url:'https://publisher.example.com/',submitUrl:'https://publisher.example.com/new',categories:['developer'],languages:['*'],kind:'article',emailRequired:false,accountRequired:false,articleRequired:true,free:'yes',freeNote:'',automation:'api',quality:'B',qualityReason:'',rulesUrl:'https://publisher.example.com/rules',evidenceSources:[{url:'https://publisher.example.com/rules',kind:'content_policy',appliesTo:'fixture-article',applicability:'verified'}],checkedAt:'2026-10-01',notes:'',allowedHosts:['publisher.example.com'],enabled:true};
const task:Task={id:'22222222-2222-4222-8222-222222222222',siteId:site.id,channelId:channel.id,sourceDomain:channel.domain,status:'queued',createdAt:now,scheduledAt:now,updatedAt:now,attempts:0,message:'',topicUrl:'https://example.com/guide'};
const source='The guide explains how to record source material and keep the original wording available for readers.';
const rules='Financial and crypto educational content is allowed. Promotional links are allowed with disclosure at the end of the article.';
const vault={ready:true,available:()=>true,get:async()=>undefined} as unknown as Vault;
function fixture(){const store=new Store(':memory:');store.update(state=>{state.settings.timezone='UTC';state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.sites=[structuredClone(site)];state.tasks=[structuredClone(task)]});primeWritingFixtureStore(store);return store}

test('one snapshot feeds writing and review; a valid article dispatches in two paid calls',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse(now)});
 const store=fixture();let topicReads=0,siteReads=0,termsReads=0,calls=0,writes=0;let writerSnapshot:unknown,reviewSnapshot:unknown;
 const controller=new Controller(store,vault,'fixture',{
  channelCatalog:[channel],
  prepareChannelTerms:async current=>fixtureTerms(current),
  discoverTopics:async()=>({topics:site.topics!,checkedAt:now}),
  readTopicEvidence:async(_site,url)=>{topicReads++;return {url,title:'Source materials',text:source,contentHash:'a'.repeat(64)}},
  collectArticleEvidence:async(_site,_channel,_signal,deps)=>{siteReads++;assert.equal(deps?.topicEvidence?.text,source);return [{url:site.url,kind:'site',text:source,excerpt:source}]},
  aiFactory:(_settings,_vault,onCall)=>({json:async<T>(_instruction:string,data:unknown)=>{
   onCall!();calls++;
   if(calls===1){const input=data as {evidenceSnapshot:unknown;writingProfile:{length:{min:number}}};writerSnapshot=input.evidenceSnapshot;let body='';while(body.replace(/\s/g,'').length<input.writingProfile.length.min+60)body+='The documented process keeps the source available. A reader can compare each statement with the original material and record its scope. '; return {title:'Working with source material',description:'Practical documentation guidance',body,facts:[]} as T}
   const input=data as {evidenceSnapshot?:unknown;evidence:Array<{url:string;text:string}>};reviewSnapshot=input.evidence;
   return {verdict:'pass',reason:'Supported by the shared sources',citations:[{url:task.topicUrl,quote:source}]} as T;
  }}),
  reviewArticle:(task,site,channel,settings,ai,signal,deps)=>reviewArticleDraft(task,site,channel,settings,ai,signal,{...deps,fetchHtml:async url=>{termsReads++;assert.equal(url,channel.rulesUrl);return {url,html:`<main>${rules}</main>`}}}),
  executeTask:async()=>{writes++;return {status:'review',submittedAt:now,message:'Accepted, awaiting readback'}},
 });controller.runtime.aiReady=true;
 try{await controller.tick();const saved=store.read().tasks.find(value=>value.id===task.id)!;assert.equal(controller.runtime.error,undefined);assert.equal(calls,2,JSON.stringify(saved.articleReview));assert.equal(writes,1,saved.message);assert.equal(topicReads,1);assert.equal(siteReads,1);assert.equal(termsReads,1);assert.deepEqual(saved.evidenceSnapshot,writerSnapshot);assert.ok(JSON.stringify(reviewSnapshot).includes(source));assert.equal(saved.articleReview?.status,'passed');assert.ok(saved.scheduling?.nextPublishAt);assert.equal(saved.cost?.aiCalls,2);assert.ok(store.read().channelTermsCache?.[channel.id]);}finally{controller.stop();store.close()}
});

test('three calls are a lifetime ceiling including the old one-off review entry point',async()=>{
 const store=fixture();let calls=0;store.update(state=>state.tasks[0].cost={aiCalls:2});
 const controller=new Controller(store,vault,'fixture',{channelCatalog:[channel],aiFactory:(_s,_v,onCall)=>({json:async<T>()=>{onCall!();calls++;return {} as T}})});controller.runtime.aiReady=true;
 try{const ai=(controller as unknown as {ai(id:string):AiPort}).ai(task.id);await ai.json('',{});await assert.rejects(ai.json('',{}),{code:'ai_task_limit'});assert.equal(calls,1);assert.equal(store.read().tasks[0].cost?.aiCalls,TASK_AI_BUDGET);assert.throws(()=>controller.oneReviewRetrySummary(task.id),{code:'ai_task_limit'});}finally{controller.stop();store.close()}
});
