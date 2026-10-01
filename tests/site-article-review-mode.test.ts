import test from 'node:test';
import assert from 'node:assert/strict';
import {getArticleReviewMode} from '../src/shared/article-review-mode';
import {emptyState,migrateState,Store} from '../src/main/store';
import {applySiteUpdate} from '../src/main/site-service';
import {saveSettingsAtomic} from '../src/main/settings-service';
import {AddSite,EditSite} from '../src/main/validation';
import {validateBackup} from '../src/main/backup-validation';
import {Controller} from '../src/main/controller';
import type {ArticleReview,Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const firstSiteId='11111111-1111-4111-8111-111111111111',secondSiteId='22222222-2222-4222-8222-222222222222';
const stamp='2026-10-01T00:00:00.000Z';
function site(id=firstSiteId,mode?:'manual'|'ai'):Site{return {id,domain:id===firstSiteId?'first.example.com':'second.example.com',url:`https://${id===firstSiteId?'first.example.com':'second.example.com'}/`,email:'owner@example.com',publicEmail:'owner@example.com',name:id===firstSiteId?'First':'Second',description:'Operator-authored guides',category:'content',language:'en',monthlyTarget:1,...(mode?{articleReviewMode:mode}:{}),status:'paused',createdAt:stamp,analyzedAt:stamp}}
function review():ArticleReview{return {status:'passed',reason:'fixture approval',reviewedAt:stamp,evidenceUrls:['https://publisher.example/rules'],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)}}
function task(id:string,siteId:string,status:Task['status']='needs_input'):Task{return {id,siteId,channelId:'telegraph',sourceDomain:'telegra.ph',status,createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'waiting',checkpoint:'article_review',draftRevision:1,draft:{title:'Guide',description:'Useful guide',body:'Operator-authored article body.'},articleApprovedAt:stamp,articleReview:review()}}
const fakeVault={ready:true,available:()=>true,get:async()=>undefined,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})} as unknown as Vault;

test('effective mode gives a valid site override priority and legacy sites inherit the global default',()=>{
  assert.equal(getArticleReviewMode(site(firstSiteId,'ai'),{articleReviewMode:'manual'}),'ai');
  assert.equal(getArticleReviewMode(site(firstSiteId,'manual'),{articleReviewMode:'ai'}),'manual');
  assert.equal(getArticleReviewMode(site(),{articleReviewMode:'ai'}),'ai');
  assert.equal(getArticleReviewMode(undefined,{articleReviewMode:'manual'}),'manual');
  assert.equal(getArticleReviewMode({articleReviewMode:'broken' as 'ai'},{articleReviewMode:'ai'}),'manual');
  assert.equal(getArticleReviewMode(undefined,{articleReviewMode:undefined as unknown as 'ai'}),'manual');
});

test('site input accepts omitted or explicit modes and rejects illegal values',()=>{
  const base={domain:'example.com',email:'owner@example.com',monthlyTarget:2};
  assert.equal(AddSite.parse(base).articleReviewMode,undefined);
  assert.equal(AddSite.parse({...base,articleReviewMode:'ai'}).articleReviewMode,'ai');
  assert.throws(()=>AddSite.parse({...base,articleReviewMode:'unreviewed'}));
  assert.throws(()=>EditSite.parse({id:firstSiteId,articleReviewMode:'unreviewed'}));
});

test('unchanged edit payload preserves draft and approval while a real content change invalidates them',()=>{
  const state=emptyState(),value=site(firstSiteId,'manual'),pending=task('33333333-3333-4333-8333-333333333333',firstSiteId);state.sites=[value];state.tasks=[pending];
  applySiteUpdate(state,{id:value.id,name:value.name,description:value.description,category:value.category,language:value.language,email:value.email,publicEmail:value.publicEmail,monthlyTarget:value.monthlyTarget,articleReviewMode:'manual'},new Date(stamp));
  assert.deepEqual(state.tasks[0].draft,pending.draft);assert.deepEqual(state.tasks[0].articleReview,pending.articleReview);assert.equal(state.tasks[0].articleApprovedAt,stamp);
  applySiteUpdate(state,{id:value.id,name:'Updated name'},new Date('2026-10-01T01:00:00.000Z'));
  assert.equal(state.tasks[0].draft,undefined);assert.equal(state.tasks[0].articleReview,undefined);assert.equal(state.tasks[0].articleApprovedAt,undefined);
});

test('manual to AI keeps the pending draft, preserves pauses, and leaves submitted and other-site records unchanged',()=>{
  const state=emptyState(),first=site(firstSiteId,'manual'),second=site(secondSiteId,'manual'),pending=task('33333333-3333-4333-8333-333333333333',firstSiteId),submitted={...task('44444444-4444-4444-8444-444444444444',firstSiteId,'review'),submittedAt:stamp},other=task('55555555-5555-4555-8555-555555555555',secondSiteId);
  state.settings.autoRun=false;state.settings.articleReviewMode='manual';state.sites=[first,second];state.tasks=[pending,submitted,other];
  const result=applySiteUpdate(state,{id:first.id,articleReviewMode:'ai'},new Date(stamp));
  assert.equal(result.reviewModeChanged,true);assert.equal(state.settings.autoRun,false);assert.equal(state.sites[0].status,'paused');assert.deepEqual(state.tasks[0].draft,pending.draft);assert.equal(state.tasks[0].articleReview,undefined);assert.equal(state.tasks[0].articleApprovedAt,undefined);
  assert.deepEqual(state.tasks[1],submitted);assert.deepEqual(state.tasks[2],other);
  const store=new Store(':memory:');try{store.update(saved=>Object.assign(saved,state));const controller=new Controller(store,fakeVault,'fixture');controller.resumeArticleReviews(first.id);const restored=store.read();assert.equal(restored.tasks[0].status,'queued');assert.equal(restored.tasks[2].status,'needs_input');assert.equal(restored.settings.autoRun,false);assert.equal(restored.sites[0].status,'paused')}finally{store.close()}
});

test('AI to manual invalidates old authorization without deleting the draft or altering submitted work',()=>{
  const state=emptyState(),value=site(firstSiteId,'ai'),pending=task('33333333-3333-4333-8333-333333333333',firstSiteId,'queued'),submitted={...task('44444444-4444-4444-8444-444444444444',firstSiteId,'review'),submittedAt:stamp};state.settings.articleReviewMode='manual';state.sites=[value];state.tasks=[pending,submitted];
  applySiteUpdate(state,{id:value.id,articleReviewMode:'manual'},new Date(stamp));
  assert.equal(state.tasks[0].status,'needs_input');assert.deepEqual(state.tasks[0].draft,pending.draft);assert.equal(state.tasks[0].articleReview,undefined);assert.equal(state.tasks[0].articleApprovedAt,undefined);assert.deepEqual(state.tasks[1],submitted);
});

test('global mode reconciliation affects only inheriting legacy sites',()=>{
  const store=new Store(':memory:');try{
    store.update(state=>{state.settings.articleReviewMode='manual';state.settings.autoRun=false;state.sites=[site(firstSiteId),site(secondSiteId,'manual'),site('66666666-6666-4666-8666-666666666666','ai')];state.tasks=[task('33333333-3333-4333-8333-333333333333',firstSiteId),task('44444444-4444-4444-8444-444444444444',secondSiteId),task('55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666')]});
    const controller=new Controller(store,fakeVault,'fixture'),changed=saveSettingsAtomic(store,fakeVault,{articleReviewMode:'ai'}).reviewModeSites;for(const id of changed)controller.resumeArticleReviews(id);const state=store.read();
    assert.deepEqual(changed,[firstSiteId]);assert.equal(state.tasks[0].status,'queued');assert.equal(state.tasks[0].articleReview,undefined);assert.deepEqual(state.tasks[1].articleReview,review());assert.deepEqual(state.tasks[2].articleReview,review());assert.equal(state.settings.autoRun,false);
  }finally{store.close()}
});

test('store migration keeps missing site overrides for inheritance and fails closed on corrupt modes',()=>{
  const legacy=emptyState();legacy.settings.articleReviewMode='ai';legacy.sites=[site()];const inherited=migrateState(legacy);assert.equal(inherited.sites[0].articleReviewMode,undefined);assert.equal(getArticleReviewMode(inherited.sites[0],inherited.settings),'ai');
  const corrupt=emptyState();(corrupt.settings as unknown as {articleReviewMode:unknown}).articleReviewMode='invalid';(corrupt.sites as unknown as Array<Record<string,unknown>>).push({...site(),articleReviewMode:'invalid'});const repaired=migrateState(corrupt);assert.equal(repaired.settings.articleReviewMode,'manual');assert.equal(repaired.sites[0].articleReviewMode,'manual');
});

test('backup roundtrip preserves valid site modes and rejects an invalid override',()=>{
  const state=emptyState();state.sites=[site(firstSiteId,'ai'),site(secondSiteId)];const restored=validateBackup({state,secrets:{}}).state;assert.equal(restored.sites[0].articleReviewMode,'ai');assert.equal(restored.sites[1].articleReviewMode,undefined);
  const invalid=structuredClone(state) as unknown as {sites:Array<Record<string,unknown>>};invalid.sites[0].articleReviewMode='unreviewed';assert.throws(()=>validateBackup({state:invalid,secrets:{}}));
});


test('saving a mode-only UI edit on a legacy site without publicEmail preserves its draft',()=>{
  const state=emptyState(),value=site(firstSiteId,'manual');delete value.publicEmail;
  state.sites=[value];state.tasks=[task('33333333-3333-4333-8333-333333333333',firstSiteId)];
  const draft=structuredClone(state.tasks[0].draft);
  applySiteUpdate(state,{id:value.id,name:value.name,description:value.description,category:value.category,language:value.language,email:value.email,publicEmail:value.email,monthlyTarget:value.monthlyTarget,articleReviewMode:'ai'});
  assert.deepEqual(state.tasks[0].draft,draft);assert.equal(state.tasks[0].articleApprovedAt,undefined);assert.equal(state.tasks[0].articleReview,undefined);
});

test('the persisted settings commit already revokes legacy approvals when switching to manual',()=>{
  const store=new Store(':memory:');try{
    store.update(state=>{state.settings.articleReviewMode='ai';state.sites=[site(firstSiteId),site(secondSiteId,'ai')];state.tasks=[task('33333333-3333-4333-8333-333333333333',firstSiteId,'queued'),task('44444444-4444-4444-8444-444444444444',secondSiteId,'queued')]});
    const commits:ReturnType<Store['read']>[]=[];
    store.onChange=()=>{commits.push(store.read())};
    const result=saveSettingsAtomic(store,fakeVault,{articleReviewMode:'manual'}),saved=store.read();
    assert.equal(commits.length,1);assert.equal(commits[0].tasks[0].articleApprovedAt,undefined);assert.equal(commits[0].tasks[0].articleReview,undefined);assert.deepEqual(result.reviewModeSites,[firstSiteId]);assert.equal(saved.tasks[0].articleApprovedAt,undefined);assert.equal(saved.tasks[0].status,'needs_input');assert.equal(saved.tasks[1].articleApprovedAt,stamp);
  }finally{store.close()}
});
