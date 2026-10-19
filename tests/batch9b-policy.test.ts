import {CHANNELS} from '../src/integrations/catalog';
import {articleContentHash,articleContextHash,articleReviewStillValid} from '../src/main/article-review';
import {applySiteUpdate} from '../src/main/site-service';
import {validateBackup} from '../src/main/backup-validation';
import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState,migrateState,Store} from '../src/main/store';
import {applySiteAnalysis,hasPendingManualReview,publicationDailySummary,remoteContentTodos} from '../src/shared/batch9b-policy';
import {siteReferralCodes,containsReferralInformation} from '../src/shared/referral-policy';
import {reservesMonthlySlot} from '../src/shared/publication';
import {RendererReadiness} from '../src/main/renderer-readiness';
import {Controller} from '../src/main/controller';
import {analyzeWebsiteHtml} from '../src/integrations/web';
import type {Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';
const stamp='2026-10-19T00:00:00.000Z';
const site:Site={id:'11111111-1111-4111-8111-111111111111',url:'https://example.com/',domain:'example.com',name:'Original',description:'Original description',email:'',category:'finance',language:'zh',status:'ready',monthlyTarget:4,createdAt:'2026-01-01T00:00:00.000Z'};
const task:Task={id:'22222222-2222-4222-8222-222222222222',siteId:site.id,channelId:'telegraph',sourceDomain:'telegra.ph',status:'needs_input',reasonCode:'manual_review',createdAt:stamp,updatedAt:stamp,scheduledAt:stamp,attempts:0,message:'',draft:{title:'Title',description:'Description',body:'Body'}};
test('new defaults are automatic; migration freezes inherited old modes once',()=>{
  assert.equal(emptyState().settings.articleReviewMode,'ai');
  for(const mode of ['manual','ai'] as const){const state=emptyState();delete state.reviewDefaultsVersion;state.settings.articleReviewMode=mode;state.sites=[structuredClone(site),{...site,id:'explicit',articleReviewMode:'manual'}];migrateState(state);assert.equal(state.sites[0].articleReviewMode,mode);assert.equal(state.sites[1].articleReviewMode,'manual');assert.equal(state.settings.articleReviewMode,'ai');state.settings.articleReviewMode='manual';migrateState(state);assert.equal(state.settings.articleReviewMode,'manual')}
});
test('analysis fills blanks and proposes address changes without replacing identity',()=>{
  const current={...site,description:''};applySiteAnalysis(current,{name:'Changed',description:'Filled',category:'general',url:'https://example-site.com/',domain:'example-site.com'},new Date(stamp));
  assert.equal(current.name,'Original');assert.equal(current.description,'Filled');assert.equal(current.category,'finance');assert.equal(current.url,site.url);assert.equal(current.domain,site.domain);assert.deepEqual(current.analysisProposal,{url:'https://example-site.com/',domain:'example-site.com',analyzedAt:stamp});
});
test('pending review occupies month and blocks another draft only for its own site',()=>{
  assert.equal(reservesMonthlySlot(task,new Date(stamp),'UTC'),true);assert.equal(hasPendingManualReview([task],site.id,'another'),true);assert.equal(hasPendingManualReview([task],site.id,task.id),false);assert.equal(hasPendingManualReview([task],'other'),false);assert.equal(reservesMonthlySlot({...task,scheduledAt:'2026-11-01T00:00:00Z'},new Date(stamp),'UTC'),false);
});
test('referral labels and five digit codes share the snapshot detector',()=>{
  for(const label of ['邀请人ID','邀请ID','优惠码','注册码','promo code','affiliate code','referral ID'])assert.equal(containsReferralInformation(`${label}: 12345`),true,label);
  const snapshot={sources:[{text:'页面优惠码 ABCD1234'}]};const codes=siteReferralCodes(site,snapshot);assert.deepEqual(codes,['ABCD1234']);assert.equal(containsReferralInformation('注册时填写 ABCD1234',codes),true);assert.equal(containsReferralInformation('共计 12345 个条目'),false);
  assert.deepEqual(analyzeWebsiteHtml('<html><body><p>邀请码：ABCD1234</p></body></html>',site.url).referralCodes,['ABCD1234']);
});
test('remote findings produce read-only todos without changing a live task',()=>{
 const original={...task,status:'live' as const,firstLiveAt:stamp,publicUrl:'https://example-site.com/post',remoteContentScan:{version:1 as const,checkedAt:stamp,referral:true,legacyMarkers:['blogger_data_linkflow']}};
 assert.deepEqual(remoteContentTodos([original]).map(row=>row.kind),['referral','legacy_marker']);assert.equal(original.status,'live');
});
test('daily summary includes success and failure for the local calendar date',()=>{
 const rows=[{...task,firstLiveAt:stamp,status:'live' as const},{...task,id:'failed',status:'failed' as const},{...task,id:'old',status:'failed' as const,updatedAt:'2026-10-17T00:00:00Z'}];assert.deepEqual(publicationDailySummary(rows,new Date(stamp),'UTC'),{success:1,failure:1});
});
test('startup waits for renderer acknowledgement after a snapshot and resets on navigation',async()=>{
 const gate=new RendererReadiness();assert.equal(gate.acknowledge(),false);gate.snapshotDelivered();assert.equal(gate.isReady(),false);const ready=gate.wait();assert.equal(gate.acknowledge(),true);await ready;gate.reset();assert.equal(gate.isReady(),false);assert.equal(gate.acknowledge(),false);
});
test('website analysis uses separate daily quota without consuming writing calls',async()=>{
 const store=new Store(':memory:');store.update(s=>{s.sites=[structuredClone(site)];s.settings.autoRun=false;s.settings.dailyAnalysisAiLimit=1});let calls=0;
 const controller=new Controller(store,{ready:true,get:async()=>undefined} as unknown as Vault,'fixture',{analyzeWebsite:async()=>({...site}),discoverTopics:async()=>({topics:[],checkedAt:stamp}),discoverTechnicalMaterial:async()=>undefined,aiFactory:(_settings,_vault,count)=>({json:async()=>{count?.();calls++;return {name:'Changed',description:'Changed',category:'general',language:'en'} as any}})});
 controller.runtime.aiReady=true;
 try{await controller.analyze(site.id);await controller.analyze(site.id);assert.equal(calls,1);assert.equal(Object.values(store.read().usage).reduce((a,b)=>a+b,0),0);assert.equal(Object.values(store.read().analysisUsage??{}).reduce((a,b)=>a+b,0),1);assert.equal(store.read().sites[0].name,site.name)}finally{controller.stop();store.close()}
});

test('background re-analysis of guessed fields never stops a working site, spends retries only on real AI attempts and gives up after three',async()=>{
 const guessed={...structuredClone(site),category:'general' as const,heuristicFields:['category'] as Site['heuristicFields'],analysisRetryAt:stamp};
 const store=new Store(':memory:');store.update(s=>{s.sites=[guessed];s.settings.autoRun=false;s.settings.dailyAnalysisAiLimit=10});
 let fetchFail=true,aiFail=false,calls=0;
 const controller=new Controller(store,{ready:true,get:async()=>undefined} as unknown as Vault,'fixture',{analyzeWebsite:async()=>{if(fetchFail)throw Error('timeout');return {...site}},discoverTopics:async()=>({topics:[],checkedAt:stamp}),discoverTechnicalMaterial:async()=>undefined,aiFactory:(_settings,_vault,count)=>({json:async()=>{count?.();calls++;if(aiFail)throw Error('AI down');return {name:'Original',description:'Original description',category:'finance',language:'zh'} as any}})});
 controller.runtime.aiReady=true;
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:store.read().settings.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 try{
  // A failed fetch leaves the site ready and only moves the retry.
  await controller.analyze(site.id,true);let current=store.read().sites[0];
  assert.equal(current.status,'ready');assert.equal(current.error,undefined);assert.equal(current.analysisRetries,1);assert.ok(Date.parse(current.analysisRetryAt!)>Date.now());
  // Half of today's analysis allowance is kept for the owner's new sites: no AI call, and no retry is spent.
  fetchFail=false;store.update(s=>{s.analysisUsage={[today]:5}});
  await controller.analyze(site.id,true);current=store.read().sites[0];
  assert.equal(calls,0);assert.equal(current.category,'general');assert.equal(current.analysisRetries,1);assert.ok(current.analysisRetryAt);
  // Two more real attempts that fail use up the three retries.
  aiFail=true;store.update(s=>{s.analysisUsage={}});
  await controller.analyze(site.id,true);await controller.analyze(site.id,true);current=store.read().sites[0];
  assert.equal(calls,2);assert.equal(current.analysisRetries,3);assert.equal(current.analysisRetryAt,undefined);assert.equal(current.status,'ready');
  // The owner can still analyze by hand, which uses the AI and closes the guess.
  aiFail=false;await controller.analyze(site.id);current=store.read().sites[0];
  assert.equal(current.category,'finance');assert.equal(current.heuristicFields,undefined);assert.equal(current.analysisRetries,undefined);assert.equal(current.analysisRetryAt,undefined);
 }finally{controller.stop();store.close()}
});

test('initial automatic placeholders accept identified facts before later reanalysis becomes fill-only',()=>{
 const current={...site,status:'analyzing' as const,name:site.domain,category:'general' as const,language:'en',description:''};
 applySiteAnalysis(current,{name:'Example Brand',category:'finance',language:'zh',description:'Public facts'},new Date(stamp));
 assert.deepEqual([current.name,current.category,current.language],['Example Brand','finance','zh']);
 applySiteAnalysis(current,{name:'Overwrite',category:'software',language:'en'},new Date(stamp));
 assert.deepEqual([current.name,current.category,current.language],['Example Brand','finance','zh']);
});
test('descriptive site edits preserve an accepted frozen draft and review',()=>{
 const state=emptyState();state.sites=[{...site}];state.tasks=[{...task,status:'queued',articleReview:{status:'passed',reason:'Fixture',evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)}}];
 const original=structuredClone(state.tasks[0]);applySiteUpdate(state,{id:site.id,name:'Changed',language:'en',category:'software'});
 assert.deepEqual(state.tasks[0],original);assert.equal(state.sites[0].name,'Changed');
});
test('new snapshot, analysis and format failure fields survive repeated strict backup validation',()=>{
 const state=emptyState();state.sites=[{...site,referralCodes:['ABCD1234'],analysisProposal:{url:'https://example-site.com/',analyzedAt:stamp}}];state.analysisUsage={'2026-10-19':2};
 state.tasks=[{...task,status:'failed',reasonCode:'format_repair_exhausted',formatRepairFailures:2,formatRepairDraft:{title:'Invalid',description:'Repair',body:'x'.repeat(30001)},remoteContentScan:{version:1,checkedAt:stamp,referral:true,legacyMarkers:['legacy_brand_token']}}];
 const restored=validateBackup({state,secrets:{}});assert.equal(restored.state.tasks[0].formatRepairDraft?.body.length,30001);assert.deepEqual(validateBackup(restored),restored);
});
test('daily cursor retains results completed after yesterday summary',()=>{
 const late={...task,status:'live' as const,firstLiveAt:'2026-10-18T18:00:00.000Z'};
 assert.deepEqual(publicationDailySummary([late],new Date(stamp),'UTC','2026-10-18T09:00:00.000Z'),{success:1,failure:0});
});

test('old passed reviews migrate without replacing receipt hashes and survive metadata changes',()=>{
 const state=emptyState(),channel=CHANNELS.find(row=>row.id==='telegraph')!;state.sites=[{...site}];const reviewed={...task,status:'queued' as const,reasonCode:undefined};
 const contextHash=articleContextHash(site,channel,state.settings,undefined,4);
 reviewed.articleReview={status:'passed',reason:'Legacy pass',reviewContractVersion:4,evidenceUrls:[],draftRevision:0,contentHash:articleContentHash(reviewed),contextHash};state.tasks=[reviewed];
 migrateState(state);assert.equal(state.tasks[0].articleReview?.bindingVersion,2);assert.equal(state.tasks[0].articleReview?.contextHash,contextHash);assert.ok(state.tasks[0].articleReview?.bindingHash);
 state.sites[0].description='Updated metadata';assert.equal(articleReviewStillValid(state.tasks[0],state.sites[0],channel,state.settings),true);
 const restored=validateBackup({state,secrets:{}});assert.equal(restored.state.tasks[0].articleReview?.contextHash,contextHash);
 state.tasks[0].draft={...state.tasks[0].draft!,body:'Changed content'};assert.equal(articleReviewStillValid(state.tasks[0],state.sites[0],channel,state.settings),false);
});
