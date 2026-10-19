import assert from 'node:assert/strict';
import test from 'node:test';
import {Store,migrateState,emptyState} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {capturePublicationSnapshots,publicationReadSource,publicationSite} from '../src/main/publication-snapshot';
import {containsPublicationReferralInformation} from '../src/shared/referral-policy';
import {isArticleTopicUrl} from '../src/shared/topic-policy';
import {CHANNELS} from '../src/integrations/catalog';
import type {Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const stamp='2026-10-19T10:17:00.000Z',siteId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222';
const site:Site={id:siteId,name:'Example Site',domain:'example.com',url:'https://example.com/',email:'owner@example.com',description:'Educational guides.',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp,topics:[{url:'https://example.com/guides/first',discoveredAt:stamp}]};
const task:Task={id:taskId,siteId,channelId:'telegraph',sourceDomain:'telegra.ph',status:'queued',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',topicUrl:site.topics![0].url,draft:{title:'Guide',description:'Example guide',body:'Independent educational guidance.'}};
const vault={ready:true,available:()=>true,get:async()=>undefined,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})} as unknown as Vault;

test('clearing a rejected submission removes its snapshot and a retry captures the new draft',()=>{
 const store=new Store(':memory:');
 try{
  store.update(s=>{s.sites=[structuredClone(site)];s.tasks=[structuredClone(task)]});
  store.update(s=>{s.tasks[0].submittedAt=stamp});
  const frozen=store.read().tasks[0].publicationSnapshot!;assert.equal(frozen.draft.title,'Guide');
  store.update(s=>{s.tasks[0].submittedAt=undefined});
  assert.equal(store.read().tasks[0].publicationSnapshot,undefined);
  store.update(s=>{s.tasks[0].draft!.title='Updated guide';s.tasks[0].submittedAt=stamp});
  assert.equal(store.read().tasks[0].publicationSnapshot?.draft.title,'Updated guide');
  const unsubmitted={...task,publicationSnapshot:frozen};
  assert.equal(publicationReadSource(unsubmitted,{...site,name:'Current name'}).site.name,'Current name');
  assert.equal(publicationSite(unsubmitted,{...site,name:'Current name'})?.name,'Current name');
  const state=emptyState();state.sites=[site];state.tasks=[unsubmitted];
  assert.equal(migrateState(state).tasks[0].publicationSnapshot,undefined);
 }finally{store.close()}
});

test('discovery and referral guard agree on own-site redirect paths',()=>{
 for(const path of ['/go/example','/r/example','/out/example']){
  const url=`https://example.com${path}`;
  assert.equal(isArticleTopicUrl(url,site),false,path);
  assert.equal(containsPublicationReferralInformation({...task,topicUrl:url},site),true,path);
 }
 assert.equal(isArticleTopicUrl('https://example.com/guides/router',site),true);
});

test('a blocked unsubmitted referral target switches topic in the same task without resetting cost',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse(stamp)});
 const store=new Store(':memory:');store.update(s=>{s.settings.autoRun=true;s.settings.articleReviewMode='ai';s.sites=[structuredClone(site)];s.tasks=[{...structuredClone(task),status:'running',topicUrl:'https://example.com/go/example',cost:{aiCalls:1}}]});
 const controller=new Controller(store,vault,'fixture',{channelCatalog:CHANNELS});
 try{
  store.update(s=>{s.tasks[0].status='running'});
  const guarded=controller as unknown as {prepareReferralGuard(id:string):boolean};
  assert.equal(guarded.prepareReferralGuard(taskId),false);
  const saved=store.read().tasks[0];assert.equal(saved.id,taskId);assert.equal(saved.topicUrl,site.topics![0].url);assert.equal(saved.topicSwitchAttempts,1);assert.equal(saved.cost?.aiCalls,1);assert.equal(saved.submittedAt,undefined);assert.equal(saved.status,'queued');
 }finally{controller.stop();store.close()}
});

test('refreshTopics retains the topic referenced by a submitted historical task',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse(stamp)});
 const store=new Store(':memory:');store.update(s=>{s.sites=[structuredClone(site)];s.tasks=[{...structuredClone(task),status:'review',submittedAt:stamp}]});
 const controller=new Controller(store,vault,'fixture',{discoverTopics:async()=>({topics:[{url:'https://example.com/guides/new',discoveredAt:stamp}],checkedAt:stamp})});
 try{
  await (controller as unknown as {refreshTopics(site:Site):Promise<void>}).refreshTopics(site);
  assert.deepEqual(store.read().sites[0].topics?.map(value=>value.url),[site.topics![0].url,'https://example.com/guides/new']);
 }finally{controller.stop();store.close()}
});
