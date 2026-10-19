import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {Store,migrateState} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {validateBackup} from '../src/main/backup-validation';
import {publicationDraftHash} from '../src/main/publication-snapshot';
import {CHANNELS} from '../src/integrations/catalog';
import type {Site,Task} from '../src/shared/types';
import {applySiteOriginMigration} from '../src/main/site-origin-migration';

const stamp='2026-10-01T00:00:00.000Z';
const runAt='2026-10-18T12:17:00.000Z';
test.beforeEach(t=>{(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse(runAt)})});
const site:Site={id:'11111111-1111-4111-8111-111111111111',domain:'example.com',url:'https://example.com',email:'owner@example.com',name:'Example',description:'Educational documentation',language:'en',category:'content',status:'ready',createdAt:stamp,monthlyTarget:1};
const task:Task={id:'22222222-2222-4222-8222-222222222222',siteId:site.id,channelId:'telegraph',sourceDomain:'telegra.ph',status:'queued',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',draft:{title:'Guide',description:'Educational guide',body:'Read [the guide](https://example.com/guide).'}};
const vault={ready:true,available:()=>true} as never;

test('first submission saves a frozen snapshot in the same transaction and roundtrips backup',()=>{
  const store=new Store(':memory:');
  try{
    store.update(state=>{state.sites=[structuredClone(site)];state.tasks=[structuredClone(task)]});
    store.update(state=>{state.tasks[0].submittedAt=stamp;state.tasks[0].status='review'});
    const frozen=store.read().tasks[0].publicationSnapshot!;
    assert.equal(frozen.contentHash,publicationDraftHash(task.draft!));assert.deepEqual(frozen.draft,task.draft);
    store.update(state=>{state.sites[0].name='Renamed site';state.sites[0].language='zh';state.tasks[0].draft!.body='Local later edit'});
    assert.deepEqual(store.read().tasks[0].publicationSnapshot,frozen);
    const restored=validateBackup({state:store.read(),secrets:{}});
    assert.deepEqual(restored.state.tasks[0].publicationSnapshot,frozen);
    const corrupt=structuredClone(restored);corrupt.state.tasks[0].publicationSnapshot!.draft.body='tampered';
    assert.throws(()=>validateBackup(corrupt));
    const legacy=structuredClone(restored.state);delete legacy.tasks[0].publicationSnapshot;
    assert.equal(migrateState(legacy).tasks[0].publicationSnapshot,undefined,'do not fabricate a historical snapshot from current site data');
  }finally{store.close()}
});

test('cycle recheck uses current and recorded old domains without rerendering or requiring the old account binding',async()=>{
  const store=new Store(':memory:');let calls=0;
  try{
    store.update(state=>{state.sites=[structuredClone(site)];state.tasks=[{...structuredClone(task),status:'live',publicUrl:'https://telegra.ph/example-guide-10-01',submittedAt:stamp,firstLiveAt:stamp,health:'healthy',linkCheck:'found'}]});
    store.update(state=>applySiteOriginMigration(state,{siteId:site.id,expectedDomain:site.domain,expectedUrl:site.url,newUrl:'https://example-site.com',operatorAuthorized:true},new Date('2026-10-02T00:00:00.000Z')));
    const controller=new Controller(store,vault,'fixture',{recheckLink:async(url,current,old)=>{
      calls++;assert.equal(current,'https://example-site.com');assert.ok(old?.includes(site.url));
      return {found:true,outcome:'found',url,rel:'nofollow',reason:'链接指向旧域名',reasonCode:'legacy_origin',matchedOrigin:site.url,usesLegacyOrigin:true,indexable:true};
    },verifyTelegraph:async()=>{throw Error('must not rerender historical content')}});
    await controller.verify(task.id);
    const saved=store.read().tasks[0];assert.equal(calls,1);assert.equal(saved.status,'live');assert.equal(saved.linkCheck,'found');assert.equal(saved.linkCheckReason,'legacy_origin');assert.equal(saved.linkRel,'nofollow');assert.equal(saved.linkIndexable,true);
    assert.equal(validateBackup({state:store.read(),secrets:{}}).state.tasks[0].linkUsesLegacyOrigin,true);
  }finally{store.close()}
});

test('a pre-publication referral cleanup invalidates old approval instead of publishing changed text',async()=>{
  const store=new Store(':memory:');let writes=0;
  try{
    store.update(state=>{state.settings.autoRun=true;state.settings.timezone='UTC';state.settings.articleReviewMode='manual';state.sites=[{...structuredClone(site),topicsCheckedAt:runAt}];state.tasks=[{...structuredClone(task),scheduledAt:runAt,articleApprovedAt:stamp,draft:{...task.draft!,body:task.draft!.body+'\n邀请码：TEST1234。'}}]});
    const controller=new Controller(store,vault,'fixture',{channelCatalog:CHANNELS,executeTask:async()=>{writes++;return {status:'live',message:'unexpected'}}});
    controller.runtime.aiReady=true;await controller.tick();
    const saved=store.read().tasks[0];assert.equal(writes,0);assert.doesNotMatch(saved.draft?.body??'',/TEST1234/);assert.equal(saved.articleApprovedAt,undefined);assert.equal(saved.status,'needs_input');
  }finally{store.close()}
});

test('unusable cleaned content records the local referral reason and cannot publish',async()=>{
  const store=new Store(':memory:');let writes=0;
  try{
    store.update(state=>{state.settings.autoRun=true;state.settings.timezone='UTC';state.settings.articleReviewMode='manual';state.sites=[{...structuredClone(site),topicsCheckedAt:runAt}];state.tasks=[{...structuredClone(task),scheduledAt:runAt,articleApprovedAt:stamp,draft:{...task.draft!,title:'Referral code: TEST1234'}}]});
    const controller=new Controller(store,vault,'fixture',{executeTask:async()=>{writes++;return {status:'live',message:'unexpected'}}});controller.runtime.aiReady=true;await controller.tick();
    assert.equal(writes,0);assert.equal(store.read().tasks[0].reasonCode,'referral_blocked');assert.equal(store.read().tasks[0].reason,undefined);assert.equal(store.read().tasks[0].cooldownUntil,undefined);assert.equal(store.read().tasks[0].status,'failed');
  }finally{store.close()}
});

test('an already submitted remote draft with referral information is blocked without rewriting its receipt or source',()=>{
  const store=new Store(':memory:');
  try{
    const submitted={...structuredClone(task),status:'review' as const,submittedAt:stamp,checkpoint:'telegraph_publish_uncertain',draft:{...task.draft!,body:'Safe guide.\nReferral code: TEST1234'}};
    store.update(state=>{state.sites=[structuredClone(site)];state.tasks=[submitted]});
    const controller=new Controller(store,vault,'fixture');
    const guard=controller as unknown as {prepareReferralGuard(id:string,finalCheck:boolean):boolean};
    assert.equal(guard.prepareReferralGuard(task.id,true),false);
    const saved=store.read().tasks[0];
    assert.equal(saved.reasonCode,'referral_blocked');assert.equal(saved.reason,undefined);assert.equal(saved.cooldownUntil,undefined);assert.equal(saved.status,'needs_input');
    assert.equal(saved.submittedAt,stamp);assert.equal(saved.checkpoint,submitted.checkpoint);assert.deepEqual(saved.draft,submitted.draft);
  }finally{store.close()}
});
