import test from 'node:test';
import assert from 'node:assert/strict';
import {Store,emptyState} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {bindAccount,channelExecutionReadiness,unbindAccount} from '../src/main/account-bindings';
import {validateBackup} from '../src/main/backup-validation';
import {socialPublicationAt,recoverInterrupted} from '../src/main/planner';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {CHANNELS} from '../src/integrations/catalog';
import type {Account,MataroaReceipt,Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const stamp='2026-10-07T00:00:00.000Z';
const firstSiteId='11111111-1111-4111-8111-111111111111';
const secondSiteId='22222222-2222-4222-8222-222222222222';
const accountId='33333333-3333-4333-8333-333333333333';
const taskId='44444444-4444-4444-8444-444444444444';
const username='writer';
const hash='a'.repeat(64);
const channel=()=>{const found=CHANNELS.find(item=>item.id==='mataroa');assert.ok(found);return found};
const site=(id:string):Site=>({id,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Educational guides',category:'content',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:stamp,analyzedAt:stamp,topicsCheckedAt:new Date().toISOString(),topics:[{url:'https://example.com/guides/topic',discoveredAt:stamp}]});
const account=():Account=>({id:accountId,channelId:'mataroa',email:'',username,publicationUrl:`https://${username}.mataroa.blog/`,credentialKind:'api_token',status:'registered',hasPassword:true,source:'generated',registrationAttempts:1,createdAt:stamp,verifiedAt:stamp});
const receipt=(stage:MataroaReceipt['stage']='submitting',slug?:string):MataroaReceipt=>({username,contentHash:hash,publishedDate:'2026-10-07',stage,...(slug?{slug}:{})});
const task=(status:Task['status']='queued'):Task=>({id:taskId,siteId:firstSiteId,channelId:'mataroa',accountId,sourceDomain:'mataroa.blog',status,createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',topicUrl:'https://example.com/guides/topic'});
const vault=()=>({ready:true,available:()=>true,get:async()=>undefined,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})}) as unknown as Vault;

function pendingStore(){
  const store=new Store(':memory:');
  store.update(state=>{state.settings.autoRun=true;state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='mataroa']));state.sites=[site(firstSiteId)];state.accounts=[account()];state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId:firstSiteId,channelId:'mataroa',accountId,createdAt:stamp,updatedAt:stamp}];state.tasks=[{...task('needs_input'),submittedAt:stamp,checkpoint:'mataroa_publish_submitting',mataroa:receipt()}]});
  return store;
}

test('Mataroa can create one author, reuse it across sites, and freeze an unresolved task identity',()=>{
  const state=emptyState();state.sites=[site(firstSiteId),site(secondSiteId)];
  assert.equal(channelExecutionReadiness(state,firstSiteId,channel()).kind,'autocreate');
  state.accounts=[account()];
  assert.equal(channelExecutionReadiness(state,firstSiteId,channel()).kind,'ready');
  assert.equal(channelExecutionReadiness(state,secondSiteId,channel()).account?.id,accountId);
  const other={...account(),id:'66666666-6666-4666-8666-666666666666',username:'other',publicationUrl:'https://other.mataroa.blog/'};
  state.accounts.push(other);
  assert.equal(channelExecutionReadiness(state,firstSiteId,channel()).kind,'handoff_required');
  bindAccount(state,accountId,firstSiteId,channel());
  assert.equal(channelExecutionReadiness(state,firstSiteId,channel()).kind,'ready');
  state.tasks=[{...task('needs_input'),submittedAt:stamp,checkpoint:'mataroa_publish_submitting',mataroa:receipt()}];
  assert.throws(()=>bindAccount(state,other.id,firstSiteId,channel()),/待核验/);
});

test('shared Mataroa author reserves a full day across sites and interrupted intent remains pending',()=>{
  const state=emptyState();state.sites=[site(firstSiteId),site(secondSiteId)];state.accounts=[account()];
  state.tasks=[{...task('needs_input'),submittedAt:stamp,checkpoint:'mataroa_publish_submitting',mataroa:receipt()}];
  const requested=new Date(Date.parse(stamp)+3600000);
  assert.equal(socialPublicationAt(state,secondSiteId,'mataroa',requested).toISOString(),new Date(Date.parse(stamp)+86400000).toISOString());
  state.tasks[0]={...task('running'),checkpoint:'mataroa_account_create_pending'};
  recoverInterrupted(state,new Date(Date.parse(stamp)+3600000));
  assert.equal(state.tasks[0].status,'needs_input');
  assert.equal(state.tasks[0].checkpoint,'mataroa_account_create_pending');
});

test('backup retains Mataroa receipt and rejects changed author, source, or missing submission time',()=>{
  const state=emptyState();state.sites=[site(firstSiteId)];state.accounts=[account()];state.tasks=[{...task('needs_input'),submittedAt:stamp,checkpoint:'mataroa_publish_submitting',mataroa:receipt()}];
  const input={state,secrets:{['account:'+accountId]:'encrypted-fixture'}};
  assert.deepEqual(validateBackup(structuredClone(input)).state.tasks[0].mataroa,receipt());
  for(const mutate of [
    (copy:typeof input)=>{copy.state.tasks[0].mataroa!.username='other'},
    (copy:typeof input)=>{copy.state.tasks[0].sourceDomain='other.example'},
    (copy:typeof input)=>{delete copy.state.tasks[0].submittedAt},
  ]){const copy=structuredClone(input);mutate(copy);assert.throws(()=>validateBackup(copy),/Mataroa 回执/)}
  const published=structuredClone(input);published.state.tasks[0].mataroa={...receipt(),stage:'published'};
  assert.throws(()=>validateBackup(published));
});

test('uncertain Mataroa publication only reconciles, accepts matching receipt, and verifies without another write',async()=>{
  const store=pendingStore();let reads=0,writes=0,verified=0;
  const controller=new Controller(store,vault(),'fixture',{reconcileMataroa:async()=>{reads++;return reads===1?{status:'unknown'}:{status:'found',publicUrl:`https://${username}.mataroa.blog/p/verified-post/`,mataroa:receipt('published','verified-post')}},verifyMataroa:async()=>{verified++;return {found:true,url:`https://${username}.mataroa.blog/p/verified-post/`,rel:'',reason:'matched'}},executeTask:async()=>{writes++;return {status:'failed',message:'unexpected write'}}});
  controller.runtime.aiReady=true;
  try{
    await controller.tick();assert.equal(reads,1);assert.equal(writes,0);assert.equal(store.read().tasks[0].publicUrl,undefined);
    store.update(state=>{state.tasks[0].reconcileAfter=stamp});
    await controller.tick();const saved=store.read().tasks[0];
    assert.equal(reads,2);assert.equal(writes,0);assert.equal(verified,1);
    assert.equal(saved.mataroa?.slug,'verified-post');assert.equal(saved.publicUrl,`https://${username}.mataroa.blog/p/verified-post/`);
    assert.equal(saved.sourceDomain,'mataroa.blog');
  }finally{store.close()}
});

test('original Mataroa account-create wait resumes after same-author connection without resetting draft or AI cost',async()=>{
  const store=new Store(':memory:');
  store.update(state=>{state.settings.autoRun=true;state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='mataroa']));state.sites=[site(firstSiteId)];state.accounts=[{...account(),status:'needs_verification',verifiedAt:undefined}];state.tasks=[{...task('needs_input'),checkpoint:'mataroa_account_create_pending',attempts:1,draft:{title:'Kept',description:'Kept',body:'Original draft'},draftRevision:1,cost:{aiCalls:2,amount:1.5},articleReview:{status:'passed',reason:'Earlier context',evidenceUrls:[],draftRevision:1,contentHash:hash,contextHash:'b'.repeat(64)}}]});
  const secretStore={get:async()=>undefined,set:async()=>{},delete:async()=>{}};
  try{
    const {connectArticleAccount}=await import('../src/main/article-connections');
    await connectArticleAccount(store,secretStore,{channelId:'mataroa',username,credential:'synthetic-secret',siteIds:[firstSiteId],accountId},async()=>({username,url:`https://${username}.mataroa.blog/`}));
    const controller=new Controller(store,vault(),'fixture');controller.plan();
    const saved=store.read().tasks.find(item=>item.id===taskId)!;
    assert.equal(saved.status,'queued');assert.equal(saved.checkpoint,'article_review');
    assert.equal(saved.accountId,accountId);assert.equal(saved.draft?.title,'Kept');
    assert.equal(saved.cost?.aiCalls,2);assert.equal(saved.cost?.amount,1.5);
    assert.equal(saved.articleReview,undefined);
  }finally{store.close()}
});

test('a paused Mataroa run retains returned slug and matching public receipt without reopening submission',async()=>{
  const store=new Store(':memory:');
  store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='manual';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='mataroa']));state.sites=[{...site(firstSiteId),articleReviewMode:'manual'}];state.accounts=[account()];state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId:firstSiteId,channelId:'mataroa',accountId,createdAt:stamp,updatedAt:stamp}];state.tasks=[{...task(),draft:{title:'Original',description:'Evidence',body:'Original guide text with disclosure and a source URL https://example.com/guides/topic'},draftRevision:1,articleApprovedAt:stamp}]});
  let writes=0;let controller:Controller;
  controller=new Controller(store,vault(),'fixture',{executeTask:async context=>{
    writes++;
    const submittedAt=new Date().toISOString();
    context.checkpoint({mataroa:receipt(),checkpoint:'mataroa_publish_submitting',submittedAt,draft:context.task.draft});
    controller.pause();
    context.checkpoint({mataroa:receipt('submitting','known-slug'),checkpoint:'mataroa_publish_submitting',submittedAt});
    context.checkpoint({mataroa:receipt('published','known-slug'),checkpoint:'mataroa_published',submittedAt,publicUrl:`https://${username}.mataroa.blog/blog/known-slug/`});
    return {status:'review',message:'synthetic returned receipt'};
  }});controller.runtime.aiReady=true;
  try{
    await controller.tick();const saved=store.read().tasks.find(item=>item.id===taskId)!;
    assert.equal(writes,1);assert.equal(saved.status,'needs_input');
    assert.equal(saved.mataroa?.slug,'known-slug');assert.equal(saved.mataroa?.stage,'published');
    assert.equal(saved.publicUrl,`https://${username}.mataroa.blog/blog/known-slug/`);
    assert.equal(store.read().settings.autoRun,false);
  }finally{store.close()}
});

test('Mataroa checkpoint rejects changed author, body hash, date, and returned URL',async()=>{
  const store=new Store(':memory:');
  store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='manual';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='mataroa']));state.sites=[{...site(firstSiteId),articleReviewMode:'manual'}];state.accounts=[account()];state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId:firstSiteId,channelId:'mataroa',accountId,createdAt:stamp,updatedAt:stamp}];state.tasks=[{...task(),draft:{title:'Original',description:'Evidence',body:'Original guide text with disclosure and a source URL https://example.com/guides/topic'},draftRevision:1,articleApprovedAt:stamp}]});
  let rejected=0;
  const controller=new Controller(store,vault(),'fixture',{executeTask:async context=>{
    const submittedAt=new Date().toISOString();
    context.checkpoint({mataroa:receipt(),checkpoint:'mataroa_publish_submitting',submittedAt,draft:context.task.draft});
    const validUrl=`https://${username}.mataroa.blog/blog/known-slug/`;
    for(const bad of [
      {mataroa:{...receipt('published','known-slug'),username:'other'},publicUrl:validUrl},
      {mataroa:{...receipt('published','known-slug'),contentHash:'b'.repeat(64)},publicUrl:validUrl},
      {mataroa:{...receipt('published','known-slug'),publishedDate:'2026-10-08'},publicUrl:validUrl},
      {mataroa:receipt('published','known-slug'),publicUrl:'https://other.mataroa.blog/blog/known-slug/'},
    ]){assert.throws(()=>context.checkpoint({...bad,checkpoint:'mataroa_published',submittedAt}),/回执/);rejected++}
    return {status:'review',message:'uncertain'};
  }});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(rejected,4);assert.equal(saved.mataroa?.stage,'submitting');assert.equal(saved.publicUrl,undefined)}finally{store.close()}
});

test('Mataroa automatic article execution waits for a separate AI review bound to its author',async()=>{
  const store=new Store(':memory:');
  store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='mataroa']));state.sites=[site(firstSiteId)];state.accounts=[account()];state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId:firstSiteId,channelId:'mataroa',accountId,createdAt:stamp,updatedAt:stamp}];state.tasks=[{...task(),draft:{title:'Original',description:'Evidence',body:'Original guide text with disclosure and a source URL https://example.com/guides/topic'},draftRevision:1}]});
  const order:string[]=[];
  const controller=new Controller(store,vault(),'fixture',{reviewArticle:async(t,s,c,settings,_ai,_signal,deps)=>{
    order.push('review');assert.equal(deps?.account?.username,username);
    return {status:'passed',reason:'synthetic independent review',reviewedAt:new Date().toISOString(),evidenceUrls:[s.url,c.rulesUrl],draftRevision:t.draftRevision??0,contentHash:articleContentHash(t),contextHash:articleContextHash(s,c,settings,deps?.account)};
  },executeTask:async context=>{order.push('publish');assert.ok(context.task.articleApprovedAt);return {status:'review',message:'synthetic'}}});
  controller.runtime.aiReady=true;
  try{await controller.tick();assert.deepEqual(order,['review','publish']);assert.equal(store.read().tasks[0].articleReview?.status,'passed')}finally{store.close()}
});

test('explicit Mataroa unbind persists an opt-out; rebinding deliberately restores automatic readiness',()=>{
  const state=emptyState();state.sites=[site(firstSiteId),site(secondSiteId)];state.accounts=[account()];
  bindAccount(state,accountId,firstSiteId,channel());
  assert.equal(channelExecutionReadiness(state,firstSiteId,channel(),accountId).kind,'ready');
  unbindAccount(state,accountId,firstSiteId,'mataroa');
  assert.deepEqual(state.accounts[0].mataroaExcludedSiteIds,[firstSiteId]);
  assert.equal(channelExecutionReadiness(state,firstSiteId,channel(),accountId).kind,'handoff_required');
  assert.equal(channelExecutionReadiness(state,firstSiteId,channel()).kind,'handoff_required');
  assert.equal(channelExecutionReadiness(state,secondSiteId,channel()).kind,'ready');
  const contradictory=structuredClone(state);
  contradictory.accountBindings.push({id:'66666666-6666-4666-8666-666666666666',siteId:firstSiteId,channelId:'mataroa',accountId,createdAt:stamp,updatedAt:stamp});
  assert.throws(()=>validateBackup({state:contradictory,secrets:{['account:'+accountId]:'encrypted-fixture'}}),/撤销记录冲突/);
  const imported=validateBackup({state,secrets:{['account:'+accountId]:'encrypted-fixture'}}).state;
  assert.deepEqual(imported.accounts[0].mataroaExcludedSiteIds,[firstSiteId]);
  assert.equal(channelExecutionReadiness(imported,firstSiteId,channel(),accountId).kind,'handoff_required');
  bindAccount(imported,accountId,firstSiteId,channel());
  assert.equal(imported.accounts[0].mataroaExcludedSiteIds?.includes(firstSiteId),false);
  assert.equal(channelExecutionReadiness(imported,firstSiteId,channel(),accountId).kind,'ready');
});

test('explicit empty Mataroa site selection revokes every existing site, including an already pinned task',async()=>{
  const store=new Store(':memory:');store.update(state=>{state.sites=[site(firstSiteId),site(secondSiteId)];state.accounts=[account()];state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId:firstSiteId,channelId:'mataroa',accountId,createdAt:stamp,updatedAt:stamp}];state.tasks=[task()]});
  const secretStore={get:async()=>undefined,set:async()=>{},delete:async()=>{}};
  try{
    const {connectArticleAccount}=await import('../src/main/article-connections');
    await connectArticleAccount(store,secretStore,{channelId:'mataroa',username,credential:'synthetic-secret',siteIds:[],accountId},async()=>({username,url:`https://${username}.mataroa.blog/`}));
    const state=store.read();assert.equal(state.accountBindings.length,0);
    assert.deepEqual(new Set(state.accounts[0].mataroaExcludedSiteIds),new Set([firstSiteId,secondSiteId]));
    assert.equal(channelExecutionReadiness(state,firstSiteId,channel(),accountId).kind,'handoff_required');
    assert.equal(channelExecutionReadiness(state,secondSiteId,channel()).kind,'handoff_required');
  }finally{store.close()}
});
