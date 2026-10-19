import {validObservedLinkState} from '../src/main/periodic-link-state';
import {validateBackup} from '../src/main/backup-validation';
import {pinPublicationFixtures} from './helpers/publication-snapshot';
import {primeWritingFixtureStore} from './writing-fixture';
import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {Controller,type ControllerServices} from '../src/main/controller';
import {Store} from '../src/main/store';
import {publicationDraftHash} from '../src/main/publication-snapshot';
import {makeTantiveIntent} from '../src/integrations/tantive';
import {CHANNELS} from '../src/integrations/catalog';
import {createSynthfolkPlannedInput} from '../src/integrations/synthfolk-publisher';
import type {Account,Site,Task} from '../src/shared/types';

const stamp='2026-10-01T00:00:00.000Z';
const runAt='2026-10-18T12:17:00.000Z';
test.beforeEach(t=>{(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse(runAt)})});
const site:Site={id:'11111111-1111-4111-8111-111111111111',domain:'example.com',url:'https://example.com',email:'owner@example.com',name:'Example',description:'Public educational documentation',language:'en',category:'content',status:'ready',createdAt:stamp,monthlyTarget:1,topicsCheckedAt:new Date().toISOString()};
const base:Task={id:'22222222-2222-4222-8222-222222222222',siteId:site.id,channelId:'telegraph',sourceDomain:'telegra.ph',status:'queued',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',draft:{title:'Guide',description:'Educational guide',body:'Read [the guide](https://example.com/guide).'}};
const vault={ready:true,available:()=>true,get:async()=>undefined} as never;
function account(channelId:string):Account{return {id:'33333333-3333-4333-8333-333333333333',channelId,email:'',username:channelId==='nostr'?'a'.repeat(64):'neutral-author',displayName:'Example publisher',status:'registered',source:'generated',credentialKind:'api_token',hasPassword:true,createdAt:stamp}}
function fixture(tasks:Task[],services:ControllerServices={},sites:Site[]=[site]){
  const store=new Store(':memory:');
  store.update(state=>{state.settings.autoRun=true;state.settings.timezone='UTC';state.settings.notify=false;state.settings.monitorSearch=false;state.sites=structuredClone(sites).map(value=>({...value,topicsCheckedAt:runAt}));state.tasks=structuredClone(tasks).map(value=>({...value,scheduledAt:value.status==='queued'?runAt:value.scheduledAt}))});
  return {store,controller:new Controller(pinPublicationFixtures(store),vault,'fixture',{channelCatalog:CHANNELS.map(channel=>({...channel,enabled:true})),...services})};
}

for(const channelId of ['telegraph','nostr'])for(const deferred of [false,true])for(const boundHere of [false,true]){
  test(`plan releases only the pinned legacy ${channelId} identity without resuming ${deferred?'deferred':'skipped'} work (local binding=${boundHere})`,()=>{
    const old=account(channelId),other={...site,id:'11111111-1111-4111-8111-111111111112',domain:'example-site.com',url:'https://example-site.com'};
    const waiting:Task={...base,channelId,accountId:old.id,status:deferred?'needs_input':'skipped',checkpoint:'account_handoff',...(deferred?{deferredAt:stamp}:{})};
    const live:Task={...base,id:'22222222-2222-4222-8222-222222222223',channelId,status:'live',accountId:old.id,publicUrl:'https://telegra.ph/example-live-10-01',firstLiveAt:stamp};
    const f=fixture([waiting,live],{},[site,other]);
    try{
      f.store.update(state=>{state.accounts=[old];state.accountBindings=[{id:'44444444-4444-4444-8444-444444444444',siteId:other.id,channelId,accountId:old.id,createdAt:stamp,updatedAt:stamp},...(boundHere?[{id:'44444444-4444-4444-8444-444444444445',siteId:site.id,channelId,accountId:old.id,createdAt:stamp,updatedAt:stamp}]:[])]});
      f.controller.plan();const saved=f.store.read().tasks.find(task=>task.id===base.id)!;
      assert.equal(saved.accountId,undefined);assert.equal(saved.status,waiting.status);assert.equal(saved.checkpoint,'account_handoff');assert.equal(saved.deferredAt,waiting.deferredAt);
      assert.equal(f.store.read().tasks.find(task=>task.id===live.id)?.status,'live');
    }finally{f.store.close()}
  });
}

for(const unavailable of ['channel','site'] as const)test(`accepted link skipped for unavailable ${unavailable} still receives a monthly read-only check`,async()=>{
  let calls=0;const f=fixture([{...base,status:'live',publicUrl:'https://telegra.ph/example-10-01',firstLiveAt:stamp}],{recheckLink:async url=>{calls++;return {found:true,outcome:'found',url,rel:'nofollow',reasonCode:'link_found',reason:'fixture'}}});
  try{
    f.store.update(state=>{if(unavailable==='channel')state.settings.channelOverrides.telegraph=false;else state.sites[0].status='paused'});
    const before=Date.now();await f.controller.verify(base.id);const next=Date.parse(f.store.read().tasks[0].nextCheckAt!);
    assert.equal(next,Date.parse('2026-10-31T00:00:00.000Z'));assert.equal(calls,1);
    await f.controller.tick();assert.equal(f.store.read().tasks[0].nextCheckAt,new Date(next).toISOString());
  }finally{f.store.close()}
});

test('three disabled links cannot monopolize later ticks ahead of an enabled live link',async()=>{
  let calls=0;const tasks=Array.from({length:4},(_,index)=>({...base,id:`22222222-2222-4222-8222-22222222222${index+2}`,channelId:index===3?'blogger':'telegraph',status:'live' as const,publicUrl:`https://${index===3?'example.blogspot.com':'telegra.ph'}/guide-${index}`,firstLiveAt:stamp}));
  const f=fixture(tasks,{recheckLink:async(url)=>{calls++;return {found:true,outcome:'found',url,rel:'nofollow',reasonCode:'link_found',reason:'found'}}});
  try{f.store.update(state=>{state.settings.channelOverrides.telegraph=false;for(const task of state.tasks){task.nextCheckAt=stamp;task.linkRecheckAt=stamp}});await f.controller.tick();await f.controller.tick();
    assert.equal(calls,2);for(const saved of f.store.read().tasks)assert.ok(saved.nextCheckAt);assert.equal(f.store.read().tasks[3].linkCheck,'found');
  }finally{f.store.close()}
});

for(const channelId of ['mdshare','bluesky','whitewind','hackmd'])test(`accepted ${channelId} static absence stays unknown and preserves linkRel`,async()=>{
  const f=fixture([{...base,channelId,status:'live',publicUrl:'https://example.com/published',firstLiveAt:stamp,verifiedAt:stamp,consecutiveMissing:0,linkRel:'nofollow',health:'healthy'}],{recheckLink:async(url)=>({found:false,outcome:'absent',url,rel:'unknown',reasonCode:'link_absent',reason:'absent'})});
  try{await f.controller.verify(base.id);const saved=f.store.read().tasks[0];assert.equal(saved.health,'unknown');assert.notEqual(saved.status,'lost_link');assert.equal(saved.status,'live');assert.equal(saved.linkRel,'nofollow');assert.equal(saved.linkCheckReason,'visibility_unknown');assert.equal(validObservedLinkState(saved),true);if(channelId==='mdshare')assert.throws(()=>validateBackup({state:f.store.read(),secrets:{}}),/缺少返回记录/);else assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{}}))}finally{f.store.close()}
});

test('manual Telegraph URL on an uncertain task with a draft goes through strict verification',async()=>{
  let strict=0,loose=0;const f=fixture([{...base,status:'review',submittedAt:stamp,checkpoint:'telegraph_publish_uncertain',publicUrl:'https://telegra.ph/unrelated-page-10-01',reviewKind:'manual_url'}],{
    verifyTelegraph:async context=>{strict++;assert.deepEqual(context.task.draft,base.draft);return {found:false,outcome:'invalid',url:context.task.publicUrl!,rel:'unknown',reason:'original article mismatch'}},
    recheckLink:async(url)=>{loose++;return {found:true,outcome:'found',url,rel:'nofollow',reasonCode:'link_found',reason:'page contains a link'}},verifyLink:async(url)=>{loose++;return {found:true,url,rel:'nofollow',reason:'page contains a link'}},
  });
  try{await f.controller.verify(base.id);const saved=f.store.read().tasks[0];assert.equal(strict,1);assert.equal(loose,0);assert.equal(saved.firstLiveAt,undefined);assert.equal(saved.linkCheck,'invalid');assert.equal(saved.checkpoint,'telegraph_publish_uncertain')}finally{f.store.close()}
});

test('a mismatching recheck records the final redirect destination without adopting it as the publication',async()=>{
  const publicUrl='https://telegra.ph/original-10-01',finalUrl='https://telegra.ph/unrelated-10-01';
  const f=fixture([{...base,status:'live',publicUrl,firstLiveAt:stamp}],{recheckLink:async()=>({found:false,outcome:'invalid',url:finalUrl,rel:'unknown',reasonCode:'source_redirect_mismatch',reason:'redirect mismatch'})});
  try{await f.controller.verify(base.id);const saved=f.store.read().tasks[0];assert.equal(saved.publicUrl,publicUrl);assert.equal(saved.linkCheckFinalUrl,finalUrl);assert.equal(saved.linkCheckReason,'source_redirect_mismatch')}finally{f.store.close()}
});

for(const channelId of ['telegraph','nostr'])test(`${channelId} identifies the historical task blocking a new identity before any paid call`,async()=>{
  const old=account(channelId),previous={...base,id:'22222222-2222-4222-8222-222222222223',channelId,accountId:old.id,status:'needs_input' as const,submittedAt:stamp,checkpoint:channelId==='telegraph'?'telegraph_publish_uncertain':'nostr_publish_submitting',reconcileAttempts:1,reconcileAfter:new Date(Date.now()+3600000).toISOString()};
  let calls=0;const f=fixture([{...base,channelId,draft:undefined},previous],{aiFactory:()=>({json:async<T>()=>{calls++;throw Error('AI must not run') as T}})});
  try{f.store.update(state=>{state.accounts=[old]});f.controller.runtime.aiReady=true;await f.controller.tick();const saved=f.store.read().tasks.find(task=>task.id===base.id)!;
    assert.equal(saved.status,'needs_input');assert.match(saved.message,new RegExp(previous.id));assert.equal(calls,0);
    await assert.rejects(f.controller.generateDraft(base.id),new RegExp(previous.id));assert.equal(calls,0);
  }finally{f.store.close()}
});

test('the controller blocks referral information in Telegraph author_name before AI or publishing',async()=>{
  let calls=0;const f=fixture([base],{executeTask:async()=>{calls++;throw Error('must not publish')},aiFactory:()=>({json:async<T>()=>{calls++;throw Error('must not generate') as T}})},[{...site,name:'Referral code TEST1234'}]);
  try{f.controller.runtime.aiReady=true;await f.controller.tick();const saved=f.store.read().tasks[0];assert.equal(saved.status,'failed');assert.equal(saved.checkpoint,'referral_guard');assert.equal(calls,0);assert.deepEqual(saved.draft,base.draft)}finally{f.store.close()}
});

for(const field of ['account','publicLink'] as const)test(`controller referral guard checks structured ${field}`,()=>{
  const owned=account('telegraph');if(field==='account')owned.displayName='Referral code TEST1234';
  const f=fixture([{...base,channelId:field==='account'?'telegraph':'agentriot',...(field==='account'?{accountId:owned.id}:{topicUrl:'https://example.com/docs?ref=TEST1234'})}]);
  try{if(field==='account')f.store.update(state=>{state.accounts=[owned]});const guard=f.controller as unknown as {prepareReferralGuard(id:string):boolean};assert.equal(guard.prepareReferralGuard(base.id),false);assert.equal(f.store.read().tasks[0].checkpoint,field==='publicLink'?'invalid_topic':'referral_guard');assert.equal(f.store.read().tasks[0].submittedAt,undefined)}finally{f.store.close()}
});

for(const usable of [true,false])test(`Synthfolk referral cleanup ${usable?'rebuilds its planned profile with the original account':'stops an unusable profile without paid repair'}`,()=>{
  const currentSite={...site,category:'software' as const},draft={title:usable?'Example Assistant':'Referral code TEST1234',description:'Public documentation assistant',body:usable?'The assistant explains the documented project workflow and helps readers find the source material. It preserves uncertainty when the public documentation cannot support an answer.\nReferral code TEST1234.':'Referral code TEST1234 provides the complete public profile text with enough words for the original input to be accepted before local referral cleanup.'};
  const task={...base,channelId:'synthfolk',draft,draftRevision:1};
  const planned=createSynthfolkPlannedInput(task,currentSite,account('synthfolk').id);assert.ok(planned);
  const f=fixture([{...task,synthfolkInput:planned,articleApprovedAt:stamp,articleRepairAttempts:0,cost:{aiCalls:2}}],{},[currentSite]);
  try{const guard=f.controller as unknown as {prepareReferralGuard(id:string,finalCheck:boolean):boolean};guard.prepareReferralGuard(base.id,true);const saved=f.store.read().tasks[0];
    assert.equal(saved.articleApprovedAt,undefined);assert.equal(saved.articleReview,undefined);assert.equal(saved.articleRepairAttempts,0);assert.equal(saved.cost?.aiCalls,2);
    if(usable){assert.equal(saved.synthfolkInput?.accountId,planned.accountId);assert.notEqual(saved.synthfolkInput?.sourceHash,planned.sourceHash);assert.equal(saved.synthfolkInput?.draftRevision,2);assert.equal(saved.synthfolkInput?.approval,undefined);assert.equal(saved.checkpoint,'article_review')}
    else{assert.equal(saved.status,'failed');assert.equal(saved.checkpoint,'referral_guard');assert.equal(saved.synthfolkInput?.accountId,planned.accountId,'a blocked cleanup keeps the original planned identity');assert.equal(saved.draft?.title,draft.title,'a blocked cleanup never overwrites the original draft')}
  }finally{f.store.close()}
});

for(const channelId of ['blogger','paragraph'])test(`${channelId} keeps an unconfirmed remote draft on read-only reconciliation despite an obsolete topic`,async()=>{
  let reads=0,writes=0,reviews=0;const owned=account(channelId),task:Task={...base,channelId,accountId:owned.id,status:'queued',topicUrl:'https://example.com/register',submittedAt:stamp,checkpoint:channelId==='blogger'?'blogger_draft_created':'paragraph_draft_created'};
  const f=fixture([task],{reconcileBlogger:async()=>{reads++;return {status:'unknown'}},reconcileParagraph:async()=>{reads++;return {status:'unknown'}},reviewArticle:async()=>{reviews++;throw Error('remote outcome pending')},executeTask:async()=>{writes++;throw Error('remote outcome pending')}});
  try{f.store.update(state=>{state.accounts=[owned]});f.controller.runtime.aiReady=true;await f.controller.tick();const saved=f.store.read().tasks[0];assert.equal(reads,1);assert.equal(writes,0);assert.equal(reviews,0);assert.equal(saved.checkpoint,task.checkpoint);assert.equal(saved.submittedAt,stamp);assert.notEqual(saved.checkpoint,'invalid_topic');assert.deepEqual(saved.draft,task.draft)}finally{f.store.close()}
});

test('manual generation retains blocked material for correction and signals that it cannot be copied',async()=>{
  const manual={...CHANNELS.find(channel=>channel.id==='telegraph')!,automation:'manual' as const,articleRequired:false,accountRequired:false};
  const f=fixture([{...base,draft:undefined}],{channelCatalog:[manual],aiFactory:()=>({json:async<T>()=>({title:'Example guide',description:'Referral code TEST1234',body:''}) as T})});
  primeWritingFixtureStore(f.store);
  try{await assert.rejects(f.controller.generateDraft(base.id),/推荐信息/);const saved=f.store.read().tasks[0];assert.equal(saved.status,'failed');assert.equal(saved.checkpoint,'referral_guard');assert.match(saved.draft!.description,/TEST1234/)}finally{f.store.close()}
});

for(const replacementBinding of [false,true])test(`strict Telegraph verification reads the pinned old identity with ${replacementBinding?'a replacement':'no current'} binding`,async()=>{
  let calls=0;const old=account('telegraph'),replacement={...old,id:'33333333-3333-4333-8333-333333333334',username:'replacement-author'};
  const f=fixture([{...base,accountId:old.id,status:'review',submittedAt:stamp,checkpoint:'telegraph_publish_uncertain',reviewKind:'manual_url',publicUrl:'https://telegra.ph/original-10-01'}],{verifyTelegraph:async context=>{calls++;assert.equal((await context.getAccount())?.id,old.id);return {found:true,outcome:'found',url:context.task.publicUrl!,rel:'nofollow',reason:'original article confirmed'}}});
  try{f.store.update(state=>{state.accounts=[old,replacement];if(replacementBinding)state.accountBindings=[{id:'44444444-4444-4444-8444-444444444444',siteId:site.id,channelId:'telegraph',accountId:replacement.id,createdAt:stamp,updatedAt:stamp}]});
    await f.controller.verify(base.id);assert.equal(calls,1);assert.equal(f.store.read().tasks[0].status,'live');assert.equal(f.store.read().tasks[0].accountId,old.id);
  }finally{f.store.close()}
});

test('Tantive dedicated reconciliation receives the submitted snapshot after site and draft edits',async()=>{
  const originalDraft={title:'Original guide',description:'Source guide',body:'A detailed original technical guide with its source https://example.com/guide'};
  const intent=makeTantiveIntent({name:'Example assistant',title:originalDraft.title,room:'questions',body:originalDraft.body},{randomUUID:()=> '33333333-3333-4333-8333-333333333333',now:()=>new Date(stamp)}).intent;
  const task:Task={...base,channelId:'tantive',sourceDomain:'tantive.space',status:'needs_input',submittedAt:stamp,checkpoint:'tantive_publish_unknown',draft:originalDraft,tantive:{...intent,stage:'publish_unknown'},publicationSnapshot:{version:1,source:'submitted_draft',capturedAt:stamp,siteName:site.name,siteUrl:site.url,targetUrl:'https://example.com/guide',language:'en',draft:originalDraft,contentHash:publicationDraftHash(originalDraft)}};
  const store=new Store(':memory:');let reads=0;
  try{store.updateWithCiphers(state=>{state.settings.autoRun=true;state.settings.notify=false;state.sites=[{...site,name:'Renamed site',language:'zh'}];state.tasks=[task]},{[`publication:${task.id}`]:'encrypted-fixture'});
    const controller=new Controller(pinPublicationFixtures(store),vault,'fixture',{channelCatalog:[{...CHANNELS.find(channel=>channel.id==='tantive')!,enabled:true}],reconcileTantive:async context=>{reads++;assert.equal(context.site.name,site.name);assert.equal(context.site.language,'en');assert.equal(context.site.url,site.url);assert.deepEqual(context.task.draft,originalDraft);assert.equal(context.task.topicUrl,'https://example.com/guide');return {status:'unknown'}}});
    await controller.tick();assert.equal(reads,1);assert.equal(store.read().tasks[0].checkpoint,task.checkpoint);assert.equal(store.read().sites[0].name,'Renamed site');
  }finally{store.close()}
});
