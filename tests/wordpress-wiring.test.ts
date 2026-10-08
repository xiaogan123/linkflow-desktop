import test from 'node:test';
import assert from 'node:assert/strict';
import {Store,emptyState} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {bindAccount,channelExecutionReadiness,unbindAccount} from '../src/main/account-bindings';
import {validateBackup} from '../src/main/backup-validation';
import {makePlan,nextTask,socialPublicationAt} from '../src/main/planner';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {channelReadinessForDisplay,taskNeedsTelegraphReconciliation} from '../src/ui/presentation';
import {CHANNELS} from '../src/integrations/catalog';
import {wordpressPostSlug} from '../src/integrations/wordpress';
import type {Account,Site,Snapshot,Task,WordPressReceipt} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const at='2026-10-08T00:00:00.000Z';
const siteId='11111111-1111-4111-8111-111111111111';
const otherSiteId='22222222-2222-4222-8222-222222222222';
const accountId='33333333-3333-4333-8333-333333333333';
const taskId='44444444-4444-4444-8444-444444444444';
const bindingId='55555555-5555-4555-8555-555555555555';
const blogId='12345',authorId='98765',postId='67890',hash='a'.repeat(64);
const slug=wordpressPostSlug(taskId,hash);
const root='https://research-notes.wordpress.com/';
const url=`${root}2026/10/${slug}/`;
const channel=()=>{const found=CHANNELS.find(item=>item.id==='wordpress-com');assert.ok(found);return found};
const lucid=()=>{const found=CHANNELS.find(item=>item.id==='lucid-page');assert.ok(found);return found};
const site=(id=siteId):Site=>({id,domain:id===siteId?'example.test':'second.test',url:id===siteId?'https://example.test/':'https://second.test/',email:id===siteId?'owner@example.test':'owner@second.test',name:'Example research',description:'Original educational research notes',category:'content',language:'en',monthlyTarget:2,articleReviewMode:'ai',status:'ready',createdAt:at,analyzedAt:at,topicsCheckedAt:new Date().toISOString(),topics:[{url:id===siteId?'https://example.test/guide':'https://second.test/guide',discoveredAt:at}],qualifications:{publication:id===siteId?'https://example.test/articles':'https://second.test/articles'}});
const account=(extra:Partial<Account>={}):Account=>({id:accountId,channelId:'wordpress-com',email:'',username:blogId,displayName:'Research Notes',publicationUrl:root,credentialKind:'oauth',status:'registered',hasPassword:true,source:'imported',createdAt:at,updatedAt:at,verifiedAt:at,...extra});
const receipt=(stage:WordPressReceipt['stage']='submitting',identified=false):WordPressReceipt=>({blogId,authorId,slug,contentHash:hash,stage,...(identified?{postId,url}:{})});
const draft={title:'A reproducible research checklist',description:'Practical evidence review steps',body:'## Review the source\n\nUse the original evidence and record each check before reaching a conclusion. This keeps the article useful on its own and gives readers a repeatable method with enough detail to apply it carefully.\n\n## Verify the result\n\nCompare the public claim against the cited page, keep the limits visible, and revisit changes over time. [Read the underlying guide](https://example.test/guide) before applying the checklist.'};
const task=(status:Task['status']='queued'):Task=>({id:taskId,siteId,channelId:'wordpress-com',accountId,sourceDomain:'wordpress.com',status,createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'fixture',topicUrl:'https://example.test/guide',draft,draftRevision:1});
const binding=(boundAccountId=accountId,forSite=siteId)=>({id:bindingId,siteId:forSite,channelId:'wordpress-com',accountId:boundAccountId,createdAt:at,updatedAt:at});
const credential=(owner=authorId,id=blogId)=>JSON.stringify({version:1,accessToken:'synthetic_token_123',expiresAt:'2099-01-01T00:00:00.000Z',blogId:id,ownerId:owner});
const vault=()=>({ready:true,available:()=>true,get:async()=>credential(),set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})}) as unknown as Vault;
async function enabled<T>(run:()=>Promise<T>):Promise<T>{const entry=channel(),previous=entry.enabled;entry.enabled=true;try{return await run()}finally{entry.enabled=previous}}

test('WordPress.com stays disabled by default and planning requires an explicit verified blog binding',()=>{
  assert.equal(channel().enabled,false);
  const state=emptyState(),first=site(),second=site(otherSiteId),automatic={...channel(),enabled:true};state.sites=[first,second];state.settings.timezone='UTC';state.accounts=[account()];
  assert.equal(channelExecutionReadiness(state,siteId,automatic).kind,'handoff_required');
  assert.equal(channelReadinessForDisplay(state as unknown as Snapshot,first,automatic),'handoff_required');
  const match=[{channel:automatic,score:100,reason:'fixture'}];
  assert.deepEqual(makePlan(state,first,match,new Date(at)),[]);
  bindAccount(state,accountId,siteId,automatic);bindAccount(state,accountId,otherSiteId,automatic);
  assert.equal(channelExecutionReadiness(state,siteId,automatic).kind,'ready');
  assert.equal(channelExecutionReadiness(state,otherSiteId,automatic).kind,'ready');
  assert.equal(channelReadinessForDisplay(state as unknown as Snapshot,first,automatic),'ready');
  assert.equal(makePlan(state,first,match,new Date(at)).length,1);
  assert.equal(makePlan(state,second,match,new Date(at)).length,1);
});

test('an unconnected WordPress.com task does not block another ready automatic channel',()=>{
  const state=emptyState(),value=site();state.sites=[value];state.settings.timezone='UTC';state.tasks=[task(),{...task(),id:'66666666-6666-4666-8666-666666666666',channelId:'lucid-page',accountId:undefined,sourceDomain:'lucid.page'}];
  const picked=nextTask(state,new Date(at),[{...channel(),enabled:true},{...lucid(),enabled:true}]);
  assert.equal(picked?.channelId,'lucid-page');
});

test('one connected WordPress.com blog enforces a 24-hour gap across bound sites',()=>{
  const state=emptyState();state.sites=[site(),site(otherSiteId)];state.accounts=[account()];state.accountBindings=[binding(),{...binding(accountId,otherSiteId),id:'77777777-7777-4777-8777-777777777777'}];state.tasks=[{...task('needs_input'),submittedAt:at,checkpoint:'wordpress_publish_submitting',wordpress:receipt()}];
  assert.equal(taskNeedsTelegraphReconciliation(state.tasks[0]),true);
  const requested=new Date(Date.parse(at)+3600000);
  assert.equal(socialPublicationAt(state,otherSiteId,'wordpress-com',requested).toISOString(),new Date(Date.parse(at)+86400000).toISOString());
});

test('WordPress.com backup preserves the receipt and cost, and rejects the wrong binding or post identity',()=>{
  const state=emptyState();state.sites=[site()];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[{...task('review'),submittedAt:at,checkpoint:'wordpress_published',wordpress:receipt('published',true),publicUrl:url,cost:{aiCalls:3,amount:1.25},articleApprovedAt:at,articleReview:{status:'passed',reason:'earlier independent review',reviewedAt:at,evidenceUrls:[root],draftRevision:1,contentHash:'b'.repeat(64),contextHash:'c'.repeat(64)}}];
  const input={state,secrets:{['account:'+accountId]:credential()}};
  const restored=validateBackup(structuredClone(input)).state.tasks[0];
  assert.deepEqual(restored.wordpress,receipt('published',true));assert.deepEqual(restored.cost,{aiCalls:3,amount:1.25});assert.equal(restored.articleReview?.status,'passed');
  const otherId='88888888-8888-4888-8888-888888888888';
  for(const mutate of [
    (copy:typeof input)=>{copy.state.accounts.push(account({id:otherId,username:'22222',publicationUrl:'https://other-notes.wordpress.com/'}));copy.state.accountBindings[0].accountId=otherId;copy.secrets['account:'+otherId]=credential('55555','22222')},
    (copy:typeof input)=>{copy.state.tasks[0].wordpress!.blogId='22222'},
    (copy:typeof input)=>{copy.state.tasks[0].wordpress!.authorId='55555'},
    (copy:typeof input)=>{copy.state.tasks[0].wordpress!.slug='lf-other-aaaaaaaaaaaa'},
    (copy:typeof input)=>{copy.state.tasks[0].wordpress!.url=`https://other-notes.wordpress.com/${slug}/`;copy.state.tasks[0].publicUrl=copy.state.tasks[0].wordpress!.url},
  ]){const copy=structuredClone(input);mutate(copy);assert.throws(()=>validateBackup(copy))}
});

test('settled WordPress.com history survives unbind or a future blog switch with its draft and secret intact',()=>{
  const state=emptyState();state.sites=[site()];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[{...task('live'),submittedAt:at,firstLiveAt:at,checkpoint:'wordpress_published',wordpress:receipt('published',true),publicUrl:url,linkCheck:'found',health:'healthy',cost:{aiCalls:3}}];
  const input={state,secrets:{['account:'+accountId]:credential()} as Record<string,string>};

  const unbound=structuredClone(input);unbindAccount(unbound.state,accountId,siteId,'wordpress-com');
  const restoredUnbound=validateBackup(unbound);
  assert.equal(restoredUnbound.state.accountBindings.length,0);assert.deepEqual(restoredUnbound.state.tasks[0].draft,draft);assert.deepEqual(restoredUnbound.state.tasks[0].wordpress,receipt('published',true));assert.equal(restoredUnbound.secrets['account:'+accountId],credential());

  const switched=structuredClone(input),replacementId='88888888-8888-4888-8888-888888888888';
  switched.state.accounts.push(account({id:replacementId,username:'22222',publicationUrl:'https://other-notes.wordpress.com/'}));switched.secrets['account:'+replacementId]=credential('55555','22222');
  bindAccount(switched.state,replacementId,siteId,channel());
  const restoredSwitched=validateBackup(switched);
  assert.equal(restoredSwitched.state.accountBindings[0].accountId,replacementId);assert.equal(restoredSwitched.state.tasks[0].accountId,accountId);assert.deepEqual(restoredSwitched.state.tasks[0].draft,draft);assert.deepEqual(restoredSwitched.state.tasks[0].wordpress,receipt('published',true));assert.equal(restoredSwitched.secrets['account:'+accountId],credential());
});

test('an unresolved WordPress.com submission keeps its original binding and rejects a restored mismatch',()=>{
  const state=emptyState();state.sites=[site()];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[{...task('needs_input'),submittedAt:at,checkpoint:'wordpress_publish_submitting',wordpress:receipt()}];
  assert.throws(()=>unbindAccount(state,accountId,siteId,'wordpress-com'),/待核验/);assert.equal(state.accountBindings[0].accountId,accountId);
  const replacementId='88888888-8888-4888-8888-888888888888',input={state,secrets:{['account:'+accountId]:credential()} as Record<string,string>};
  input.state.accounts.push(account({id:replacementId,username:'22222',publicationUrl:'https://other-notes.wordpress.com/'}));input.secrets['account:'+replacementId]=credential('55555','22222');input.state.accountBindings[0].accountId=replacementId;
  assert.throws(()=>validateBackup(input),/回执与任务绑定不一致/);
});

test('an uncertain WordPress.com POST is reconciled and verified without another write',async()=>enabled(async()=>{
  const stateTask={...task('needs_input'),submittedAt:at,checkpoint:'wordpress_publish_submitting',wordpress:receipt()};
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='wordpress-com']));state.sites=[site()];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[stateTask]});
  let reads=0,writes=0,verifies=0;
  const controller=new Controller(store,vault(),'fixture',{reconcileWordPress:async()=>{reads++;return {status:'found',publicUrl:url,wordpress:receipt('published',true)}},verifyWordPress:async()=>{verifies++;return {found:true,outcome:'found',url,rel:'nofollow ugc',reason:'matched'}},executeTask:async()=>{writes++;return {status:'failed',message:'unexpected write'}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(reads,1);assert.equal(writes,0);assert.equal(verifies,1);assert.equal(saved.wordpress?.stage,'published');assert.equal(saved.publicUrl,url);assert.equal(saved.checkpoint,'wordpress_published');assert.equal(saved.status,'live')}finally{store.close()}
}));

test('WordPress.com unknown POST recovery stops after the bounded third read and never republishes',async()=>enabled(async()=>{
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='wordpress-com']));state.sites=[site()];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[{...task('needs_input'),submittedAt:at,checkpoint:'wordpress_publish_submitting',wordpress:receipt(),reconcileAttempts:2,reconcileAfter:at}]});
  let reads=0,writes=0;const controller=new Controller(store,vault(),'fixture',{reconcileWordPress:async()=>{reads++;return {status:'unknown'}},executeTask:async()=>{writes++;return {status:'failed',message:'unexpected write'}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(reads,1);assert.equal(writes,0);assert.equal(saved.reconcileAttempts,3);assert.equal(saved.reconcileAfter,undefined);assert.equal(saved.status,'needs_input');assert.match(saved.message,/不能重发/)}finally{store.close()}
}));

test('WordPress.com checkpoints reject changed identity and preserve a returned receipt after pause',async()=>enabled(async()=>{
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='manual';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='wordpress-com']));state.sites=[{...site(),articleReviewMode:'manual'}];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[{...task(),articleApprovedAt:at}]});
  let writes=0;let controller:Controller;
  controller=new Controller(store,vault(),'fixture',{executeTask:async context=>{
    writes++;const submittedAt=new Date().toISOString();context.checkpoint({wordpress:receipt(),checkpoint:'wordpress_publish_submitting',submittedAt});
    for(const bad of [
      {...receipt('submitting',true),blogId:'22222'},
      {...receipt('submitting',true),authorId:'55555'},
      {...receipt('submitting',true),slug:'lf-other-aaaaaaaaaaaa'},
      {...receipt('submitting',true),contentHash:'b'.repeat(64)},
      {...receipt('submitting',true),url:`https://other-notes.wordpress.com/${slug}/`},
    ])assert.throws(()=>context.checkpoint({wordpress:bad,checkpoint:'wordpress_publish_submitting',submittedAt,publicUrl:bad.url}),/回执/);
    controller.pause();context.checkpoint({wordpress:receipt('submitting',true),checkpoint:'wordpress_publish_submitting',submittedAt,publicUrl:url});context.checkpoint({wordpress:receipt('published',true),checkpoint:'wordpress_published',submittedAt,publicUrl:url});
    return {status:'review',message:'synthetic',publicUrl:url,wordpress:receipt('published',true)};
  }});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(writes,1);assert.equal(saved.status,'needs_input');assert.equal(saved.wordpress?.stage,'published');assert.equal(saved.publicUrl,url);assert.equal(store.read().settings.autoRun,false)}finally{store.close()}
}));

test('WordPress.com execution waits for an independent review tied to the bound publication',async()=>enabled(async()=>{
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='wordpress-com']));state.sites=[site()];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[task()]});
  const order:string[]=[];const controller=new Controller(store,vault(),'fixture',{reviewArticle:async(t,s,c,settings,_ai,_signal,deps)=>{order.push('review');assert.equal(deps?.account?.username,blogId);assert.equal(deps?.account?.publicationUrl,root);return {status:'passed',reason:'synthetic independent review',reviewedAt:new Date().toISOString(),evidenceUrls:[s.url,c.rulesUrl,root],draftRevision:t.draftRevision??0,contentHash:articleContentHash(t),contextHash:articleContextHash(s,c,settings,deps?.account)}},executeTask:async context=>{order.push('publish');assert.ok(context.task.articleApprovedAt);return {status:'needs_input',message:'synthetic stop'}}});controller.runtime.aiReady=true;
  try{await controller.tick();assert.deepEqual(order,['review','publish']);assert.equal(store.read().tasks[0].articleReview?.status,'passed')}finally{store.close()}
}));

test('sites sharing one WordPress.com blog cannot publish the same public body twice',async()=>enabled(async()=>{
  const sameBody='## Evidence checklist\n\nUse the same repeatable evidence steps and preserve the limits for readers before reaching any conclusion.\n\n## Source\n\nReview the [underlying guide](https://example.test/guide) and disclose the promotional publishing relationship clearly.';
  const first={...task('live'),firstLiveAt:new Date(Date.now()-2*86400000).toISOString(),draft:{title:'Earlier',description:'Earlier',body:sameBody}},second:Task={...task(),id:'99999999-9999-4999-8999-999999999999',siteId:otherSiteId,topicUrl:'https://second.test/guide',draft:undefined,draftRevision:undefined};
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='wordpress-com']));state.sites=[site(),site(otherSiteId)];state.accounts=[account()];state.accountBindings=[binding(),{...binding(accountId,otherSiteId),id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}];state.tasks=[first,second]});
  let generations=0,reviews=0,writes=0;const controller=new Controller(store,vault(),'fixture',{aiFactory:(()=>({json:async()=>{generations++;return {title:'Duplicate',description:'Duplicate',body:sameBody.replace('https://example.test/guide','https://second.test/guide')}}})) as never,readTopicEvidence:async(_site,topicUrl)=>({url:topicUrl,title:'Guide',text:'Public evidence for the selected guide.',contentHash:'d'.repeat(64)}),collectArticleEvidence:async(currentSite,currentChannel)=>[{url:currentSite.url,kind:'site',text:'Public site evidence text for this fixture.',excerpt:'Public site evidence text for this fixture.'},{url:currentChannel.rulesUrl,kind:'content_policy',text:'Public policy evidence text for this fixture.',excerpt:'Public policy evidence text for this fixture.',appliesTo:currentChannel.id,applicability:'verified'}],reviewArticle:async()=>{reviews++;throw Error('duplicate should stop before review')},executeTask:async()=>{writes++;return {status:'failed',message:'duplicate should stop before publication'}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks.find(item=>item.id===second.id)!;assert.equal(generations,1);assert.equal(reviews,0);assert.equal(writes,0);assert.equal(saved.status,'failed');assert.equal(saved.checkpoint,'channel_wait');assert.match(saved.message,/重复/)}finally{store.close()}
}));

test('disabled WordPress.com work never reaches the publisher',async()=>{
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.channelOverrides['wordpress-com']=true;state.sites=[site()];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[{...task(),articleApprovedAt:at}]});let writes=0;
  const controller=new Controller(store,vault(),'fixture',{executeTask:async()=>{writes++;return {status:'review',message:'unexpected write'}}});controller.runtime.aiReady=true;
  try{await controller.tick();assert.equal(writes,0);assert.equal(store.read().tasks[0].status,'skipped');assert.match(store.read().tasks[0].message,/停用/)}finally{store.close()}
});
