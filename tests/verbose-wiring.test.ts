import test from 'node:test';
import assert from 'node:assert/strict';
import {Store,emptyState} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {bindAccount,channelExecutionReadiness,unbindAccount} from '../src/main/account-bindings';
import {validateBackup} from '../src/main/backup-validation';
import {makePlan,nextTask,recoverInterrupted,socialPublicationAt} from '../src/main/planner';
import {verbosePostSlug} from '../src/shared/publication';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {CHANNELS} from '../src/integrations/catalog';
import type {Account,Site,Task,VerboseReceipt} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const at='2026-10-08T00:00:00.000Z',siteId='11111111-1111-4111-8111-111111111111';
const otherSiteId='22222222-2222-4222-8222-222222222222';
const accountId='33333333-3333-4333-8333-333333333333';
const taskId='44444444-4444-4444-8444-444444444444';
const username='reading-notes-test',hash='a'.repeat(64),slug=verbosePostSlug(taskId,hash);
const url=`https://verbose.blog/${username}/${slug}`;
const channel=()=>{const found=CHANNELS.find(item=>item.id==='verbose');assert.ok(found);return found};
const site=(id=siteId):Site=>({id,domain:'example.test',url:'https://example.test/',email:'owner@example.test',name:'Example',description:'Educational guides',category:'content',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:at,analyzedAt:at,topicsCheckedAt:new Date().toISOString(),topics:[{url:'https://example.test/guide',discoveredAt:at}]});
const account=(extra:Partial<Account>={}):Account=>({id:accountId,channelId:'verbose',email:'',username,publicationUrl:`https://verbose.blog/${username}`,credentialKind:'api_token',status:'registered',hasPassword:true,source:'generated',registrationAttempts:1,createdAt:at,verifiedAt:at,...extra});
const receipt=(stage:VerboseReceipt['stage']='submitting'):VerboseReceipt=>({username,slug,contentHash:hash,stage});
const task=(status:Task['status']='queued'):Task=>({id:taskId,siteId,channelId:'verbose',accountId,sourceDomain:'verbose.blog',status,createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'fixture',topicUrl:'https://example.test/guide'});
const vault=()=>({ready:true,available:()=>true,get:async()=>undefined,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})}) as unknown as Vault;
async function enabled<T>(run:()=>Promise<T>):Promise<T>{const entry=channel(),previous=entry.enabled;entry.enabled=true;try{return await run()}finally{entry.enabled=previous}}

test('Verbose only joins automatic planning when enabled and never claims a task with a saved post intent',()=>{
  const state=emptyState(),value=site();state.sites=[value];state.settings.timezone='UTC';
  const when=new Date(at),match=[{channel:{...channel(),enabled:false},score:100,reason:'fixture'}];
  assert.deepEqual(makePlan(state,value,match,when),[]);
  match[0].channel.enabled=true;
  const made=makePlan(state,value,match,when);
  assert.equal(made.length,1);assert.equal(made[0].channelId,'verbose');assert.equal(made[0].sourceDomain,'verbose.blog');
  assert.equal(nextTask(state,when,match.map(item=>item.channel))?.id,made[0].id);
  Object.assign(made[0],{submittedAt:at,verbose:{username,slug:verbosePostSlug(made[0].id,hash),contentHash:hash,stage:'submitting' as const},checkpoint:'verbose_publish_submitting'});
  assert.equal(nextTask(state,when,match.map(item=>item.channel)),undefined);
});

test('Verbose shares one generated identity, keeps a 24-hour destination gap, and preserves explicit unbind',()=>{
  const state=emptyState();state.sites=[site(),site(otherSiteId)];
  assert.equal(channelExecutionReadiness(state,siteId,{...channel(),enabled:true}).kind,'autocreate');
  state.accounts=[account()];
  assert.equal(channelExecutionReadiness(state,otherSiteId,{...channel(),enabled:true}).account?.id,accountId);
  bindAccount(state,accountId,siteId,{...channel(),enabled:true});
  state.tasks=[{...task('needs_input'),submittedAt:at,checkpoint:'verbose_publish_submitting',verbose:receipt()}];
  assert.equal(socialPublicationAt(state,otherSiteId,'verbose',new Date(Date.parse(at)+3600000)).toISOString(),new Date(Date.parse(at)+86400000).toISOString());
  unbindAccount(state,accountId,siteId,'verbose');
  assert.deepEqual(state.accounts[0].verboseExcludedSiteIds,[siteId]);
  assert.equal(channelExecutionReadiness(state,siteId,{...channel(),enabled:true},accountId).kind,'handoff_required');
  assert.equal(channelExecutionReadiness(state,otherSiteId,{...channel(),enabled:true}).kind,'ready');
  state.tasks[0]={...task('running'),checkpoint:'verbose_account_create_pending'};
  recoverInterrupted(state,new Date(Date.parse(at)+3600000));
  assert.equal(state.tasks[0].status,'needs_input');
  assert.equal(state.tasks[0].checkpoint,'verbose_account_create_pending');
});

test('Verbose one-time registration can resume with the original token, but an unknown tokenless attempt cannot signup again',()=>{
  const state=emptyState();state.sites=[site()];
  state.accounts=[account({status:'draft',hasPassword:false,registrationAttempts:0})];
  assert.equal(channelExecutionReadiness(state,siteId,{...channel(),enabled:true}).kind,'autocreate');
  state.accounts[0]={...state.accounts[0],status:'unknown',registrationAttempts:1,hasPassword:false};
  assert.equal(channelExecutionReadiness(state,siteId,{...channel(),enabled:true}).kind,'handoff_required');
  state.accounts[0].hasPassword=true;
  assert.equal(channelExecutionReadiness(state,siteId,{...channel(),enabled:true}).kind,'autocreate');
});

test('after restart, a saved one-time token resumes only the original read-only profile check',async()=>enabled(async()=>{
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='verbose']));state.sites=[site()];state.accounts=[account({status:'unknown',hasPassword:true})];state.tasks=[{...task('needs_input'),checkpoint:'verbose_account_create_pending',attempts:1,cost:{aiCalls:2,amount:1.25}}]});
  try{
    const controller=new Controller(store,vault(),'fixture');controller.plan();
    const saved=store.read().tasks[0];assert.equal(saved.status,'queued');assert.equal(saved.checkpoint,'verbose_account_create_pending');assert.equal(saved.accountId,accountId);assert.equal(saved.cost?.aiCalls,2);assert.equal(saved.cost?.amount,1.25);
    store.update(state=>{state.tasks[0].status='needs_input';state.accounts[0].hasPassword=false});controller.plan();
    assert.equal(store.read().tasks[0].status,'needs_input');
  }finally{store.close()}
}));

test('Verbose backup retains the exact original receipt and rejects author, source, slug, URL, and revoke conflicts',()=>{
  const state=emptyState();state.sites=[site()];state.accounts=[account()];state.tasks=[{...task('needs_input'),submittedAt:at,checkpoint:'verbose_publish_submitting',verbose:receipt()}];
  const input={state,secrets:{['account:'+accountId]:'encrypted-fixture'}};
  assert.deepEqual(validateBackup(structuredClone(input)).state.tasks[0].verbose,receipt());
  state.tasks[0].articleApprovedAt=at;state.tasks[0].articleReview={status:'passed',reason:'earlier review',reviewedAt:at,evidenceUrls:[],draftRevision:0,contentHash:hash,contextHash:'b'.repeat(64)};
  const restored=validateBackup(structuredClone(input)).state.tasks[0];
  assert.deepEqual(restored.verbose,receipt());assert.equal(restored.articleApprovedAt,undefined);assert.equal(restored.articleReview?.status,'failed');
  for(const mutate of [
    (copy:typeof input)=>{copy.state.tasks[0].verbose!.username='other'},
    (copy:typeof input)=>{copy.state.tasks[0].sourceDomain='other.test'},
    (copy:typeof input)=>{copy.state.tasks[0].verbose!.slug='lf-other'},
    (copy:typeof input)=>{delete copy.state.tasks[0].submittedAt},
    (copy:typeof input)=>{copy.state.tasks[0].publicUrl='https://verbose.blog/other/post'},
  ]){const copy=structuredClone(input);mutate(copy);assert.throws(()=>validateBackup(copy))}
  const published=structuredClone(input);published.state.tasks[0].verbose=receipt('published');published.state.tasks[0].checkpoint='verbose_published';published.state.tasks[0].publicUrl=url;
  assert.equal(validateBackup(published).state.tasks[0].publicUrl,url);
  published.state.tasks[0].publicUrl=url+'/';assert.throws(()=>validateBackup(published),/Verbose 回执/);
  const revoked=structuredClone(input);revoked.state.accounts[0].verboseExcludedSiteIds=[siteId];revoked.state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId,channelId:'verbose',accountId,createdAt:at,updatedAt:at}];
  assert.throws(()=>validateBackup(revoked),/撤销记录冲突/);
});

test('backup keeps a one-time Verbose signup intent and its original saved token status',()=>{
  const state=emptyState();state.sites=[site()];state.accounts=[account({status:'unknown',verifiedAt:undefined})];state.tasks=[{...task('needs_input'),checkpoint:'verbose_account_create_pending',attempts:1,cost:{aiCalls:2}}];
  const input={state,secrets:{['account:'+accountId]:'encrypted-fixture'}};
  const restored=validateBackup(structuredClone(input)).state;
  assert.equal(restored.tasks[0].checkpoint,'verbose_account_create_pending');assert.equal(restored.tasks[0].accountId,accountId);assert.equal(restored.accounts[0].hasPassword,true);assert.equal(restored.tasks[0].cost?.aiCalls,2);
  const altered=structuredClone(input);altered.state.accounts[0].registrationAttempts=0;
  assert.throws(()=>validateBackup(altered),/Verbose 注册身份/);
});

test('uncertain Verbose submission uses bounded read-only reconcile and verifies the same receipt without another write',async()=>enabled(async()=>{
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='verbose']));state.sites=[site()];state.accounts=[account()];state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId,channelId:'verbose',accountId,createdAt:at,updatedAt:at}];state.tasks=[{...task('needs_input'),submittedAt:at,checkpoint:'verbose_publish_submitting',verbose:receipt()}]});
  let reads=0,writes=0,verified=0;
  const controller=new Controller(store,vault(),'fixture',{reconcileVerbose:async()=>{reads++;return reads===1?{status:'unknown'}:{status:'found',publicUrl:url,verbose:receipt('published')}},verifyVerbose:async()=>{verified++;return {found:true,url,rel:'nofollow ugc',reason:'matched'}},executeTask:async()=>{writes++;return {status:'failed',message:'unexpected write'}}});
  controller.runtime.aiReady=true;
  try{
    await controller.tick();assert.equal(reads,1);assert.equal(writes,0);assert.equal(store.read().tasks[0].publicUrl,undefined);
    store.update(state=>{state.tasks[0].reconcileAfter=at});
    await controller.tick();const saved=store.read().tasks[0];
    assert.equal(reads,2);assert.equal(writes,0);assert.equal(verified,1);
    assert.equal(saved.verbose?.stage,'published');assert.equal(saved.publicUrl,url);assert.equal(saved.sourceDomain,'verbose.blog');
  }finally{store.close()}
}));

test('Verbose cannot checkpoint another author or slug and preserves a positive receipt after pause',async()=>enabled(async()=>{
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='manual';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='verbose']));state.sites=[{...site(),articleReviewMode:'manual'}];state.accounts=[account()];state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId,channelId:'verbose',accountId,createdAt:at,updatedAt:at}];state.tasks=[{...task(),draft:{title:'Original',description:'Evidence',body:'Guide with https://example.test/guide and promotion disclosure'},draftRevision:1,articleApprovedAt:at}]});
  let writes=0;let controller:Controller;
  controller=new Controller(store,vault(),'fixture',{executeTask:async context=>{
    writes++;const submittedAt=new Date().toISOString();
    context.checkpoint({verbose:receipt(),checkpoint:'verbose_publish_submitting',submittedAt});
    for(const bad of [
      {verbose:{...receipt('published'),username:'other'},publicUrl:url},
      {verbose:{...receipt('published'),slug:'other'},publicUrl:url},
      {verbose:{...receipt('published'),contentHash:'b'.repeat(64)},publicUrl:url},
      {verbose:receipt('published'),publicUrl:url+'/'},
    ])assert.throws(()=>context.checkpoint({...bad,checkpoint:'verbose_published',submittedAt}),/回执/);
    controller.pause();
    context.checkpoint({verbose:receipt('published'),checkpoint:'verbose_published',submittedAt,publicUrl:url});
    return {status:'review',message:'synthetic',publicUrl:url,verbose:receipt('published')};
  }});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(writes,1);assert.equal(saved.status,'needs_input');assert.equal(saved.verbose?.stage,'published');assert.equal(saved.publicUrl,url);assert.equal(store.read().settings.autoRun,false)}finally{store.close()}
}));

test('Verbose automatic article execution waits for a separate review tied to the same publisher identity',async()=>enabled(async()=>{
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='verbose']));state.sites=[site()];state.accounts=[account()];state.accountBindings=[{id:'55555555-5555-8555-8555-555555555555',siteId,channelId:'verbose',accountId,createdAt:at,updatedAt:at}];state.tasks=[{...task(),draft:{title:'Original',description:'Evidence',body:'Guide with https://example.test/guide and commercial relationship disclosure'},draftRevision:1}]});
  const order:string[]=[];
  const controller=new Controller(store,vault(),'fixture',{reviewArticle:async(t,s,c,settings,_ai,_signal,deps)=>{order.push('review');assert.equal(deps?.account?.username,username);return {status:'passed',reason:'synthetic independent review',reviewedAt:new Date().toISOString(),evidenceUrls:[s.url,c.rulesUrl],draftRevision:t.draftRevision??0,contentHash:articleContentHash(t),contextHash:articleContextHash(s,c,settings,deps?.account)}},executeTask:async context=>{order.push('publish');assert.ok(context.task.articleApprovedAt);return {status:'review',message:'synthetic'}}});controller.runtime.aiReady=true;
  try{await controller.tick();assert.deepEqual(order,['review','publish']);assert.equal(store.read().tasks[0].articleReview?.status,'passed')}finally{store.close()}
}));

test('a rejected Verbose article remains unpublished under the normal independent-review gate',async()=>enabled(async()=>{
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='verbose']));state.sites=[site()];state.accounts=[account()];state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId,channelId:'verbose',accountId,createdAt:at,updatedAt:at}];state.tasks=[{...task(),draft:{title:'Original',description:'Evidence',body:'Guide with https://example.test/guide and commercial relationship disclosure'},draftRevision:1}]});
  let writes=0;
  const controller=new Controller(store,vault(),'fixture',{reviewArticle:async(t,s,c,settings,_ai,_signal,deps)=>({status:'failed',reason:'fixture rejection',reasonCode:'content_rejected',reviewedAt:new Date().toISOString(),evidenceUrls:[s.url,c.rulesUrl],draftRevision:t.draftRevision??0,contentHash:articleContentHash(t),contextHash:articleContextHash(s,c,settings,deps?.account)}),executeTask:async()=>{writes++;return {status:'review',message:'unexpected write'}}});controller.runtime.aiReady=true;
  try{await controller.tick();assert.equal(writes,0);assert.equal(store.read().tasks[0].articleReview?.status,'failed');assert.equal(store.read().tasks[0].verbose,undefined)}finally{store.close()}
}));
