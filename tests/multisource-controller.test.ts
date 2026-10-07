import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {CHANNELS} from '../src/integrations/catalog';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {applySiteUpdate} from '../src/main/site-service';
import {saveTaskDraft} from '../src/main/task-draft';
import type {ArticleReview,ExecutionContext,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const siteId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222';
const paragraphAccount='33333333-3333-4333-8333-333333333333',nostrAccount='44444444-4444-4444-8444-444444444444';
const publicationId='PublicationFixture0001',postId='PostFixture000000001',pubkey='a'.repeat(64);
const stamp=new Date(Date.now()-60_000).toISOString();
const draft={title:'A reproducible operational review',description:'Documented checks and limitations.',body:'This independent guide records inputs, verification steps, limitations, and the operator relationship in enough detail for readers to reproduce the checks.'};
function channel(id:string){return CHANNELS.find(item=>item.id===id)!}
function vault(){return {ready:true,available:()=>true,get:async()=> 'synthetic-local-vault-record',set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})} as unknown as Vault}
function passed(task:Task,context:ReturnType<Store['read']>,channelId=task.channelId):ArticleReview{const site=context.sites.find(item=>item.id===task.siteId)!,selected=channel(channelId);return {status:'passed',reason:'Synthetic independent review',reasonCode:'passed',reviewedAt:stamp,evidenceUrls:[site.url,selected.rulesUrl],draftRevision:task.draftRevision??0,contentHash:articleContentHash(task),contextHash:articleContextHash(site,selected,context.settings)}}

function storeFor(channelId:'paragraph'|'nostr',withTask=true){
  const store=new Store(':memory:');
  store.update(state=>{
    state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id===channelId]));
    state.sites=[{id:siteId,url:'https://example.com/',domain:'example.com',email:'owner@example.com',name:'Example',description:'Original educational guides',category:'content',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:stamp,analyzedAt:stamp,topicsCheckedAt:new Date().toISOString(),topics:[{url:'https://example.com/guides/verification',discoveredAt:stamp}],...(channelId==='paragraph'?{paragraph:{publicationId,url:'https://paragraph.com/@fixture-publication/'}}:{})}];
    if(channelId==='paragraph')state.accounts=[{id:paragraphAccount,channelId,email:'',username:publicationId,displayName:'Fixture Publication',publicationUrl:'https://paragraph.com/@fixture-publication/',credentialKind:'api_token',status:'registered',hasPassword:true,source:'imported',createdAt:stamp}];
    else state.accounts=[{id:nostrAccount,channelId,email:'',username:pubkey,credentialKind:'api_token',status:'registered',hasPassword:true,source:'generated',createdAt:stamp}];
    const accountId=channelId==='paragraph'?paragraphAccount:nostrAccount;
    state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId,channelId,accountId,createdAt:stamp,updatedAt:stamp}];
    if(withTask){
      const base:Task={id:taskId,siteId,channelId,accountId,sourceDomain:channelId==='paragraph'?'paragraph.com':'njump.me',status:'needs_input',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'uncertain',submittedAt:stamp,draft:structuredClone(draft),draftRevision:1,topicUrl:'https://example.com/guides/verification',cost:{aiCalls:1}};
      if(channelId==='paragraph')Object.assign(base,{checkpoint:'paragraph_insert_submitting',paragraph:{publicationId,slug:'fixture-article',contentHash:'c'.repeat(64),stage:'inserting'}});
      else Object.assign(base,{checkpoint:'nostr_publish_submitting',nostr:{pubkey,eventId:'b'.repeat(64),identifier:'fixture-article',contentHash:'d'.repeat(64),createdAt:1,stage:'submitting'}});
      state.tasks=[base];
    }
  });
  return store;
}

test('Controller plans a real Nostr article without a human-created account',()=>{
  const store=storeFor('nostr',false);try{
    store.update(state=>{state.accounts=[];state.accountBindings=[]});
    const controller=new Controller(store,vault(),'fixture');controller.plan();
    const tasks=store.read().tasks;assert.equal(tasks.length,1);assert.equal(tasks[0].channelId,'nostr');assert.equal(tasks[0].accountId,undefined);assert.equal(tasks[0].status,'queued');assert.equal(tasks[0].topicUrl,'https://example.com/guides/verification');
  }finally{store.close()}
});

test('unknown Paragraph and Nostr submissions receive only three bounded reads and no write',async t=>{
  for(const channelId of ['paragraph','nostr'] as const)await t.test(channelId,async()=>{
    const store=storeFor(channelId),original=structuredClone(store.read().tasks[0]);let reads=0,writes=0;
    const services=channelId==='paragraph'
      ?{reconcileParagraph:async()=>{reads++;return {status:'unknown' as const}},executeTask:async()=>{writes++;return {status:'review' as const,message:'unexpected write'}}}
      :{reconcileNostr:async()=>{reads++;return {status:'unknown' as const}},executeTask:async()=>{writes++;return {status:'review' as const,message:'unexpected write'}}};
    const controller=new Controller(store,vault(),'fixture',services);controller.runtime.aiReady=true;
    try{
      for(let index=0;index<5;index++){store.update(state=>state.tasks[0].reconcileAfter=stamp);await controller.tick()}
      const saved=store.read().tasks[0];assert.equal(reads,3);assert.equal(writes,0);assert.equal(saved.id,original.id);assert.equal(saved.submittedAt,original.submittedAt);assert.deepEqual(saved.paragraph,original.paragraph);assert.deepEqual(saved.nostr,original.nostr);assert.equal(saved.reconcileAttempts,3);assert.equal(saved.publicUrl,undefined);assert.equal(store.read().tasks.length,1);
    }finally{store.close()}
  });
});

test('a recovered Paragraph draft keeps its task and postId but must pass a fresh independent review',async()=>{
  const store=storeFor('paragraph');store.update(state=>state.tasks[0].articleReview=passed(state.tasks[0],state));
  const before=structuredClone(store.read().tasks[0]),found={publicationId,slug:before.paragraph!.slug,contentHash:before.paragraph!.contentHash,stage:'draft' as const,postId};let reads=0,reviews=0,writes=0;
  const controller=new Controller(store,vault(),'fixture',{
    reconcileParagraph:async()=>{reads++;return {status:'draft',paragraph:found}},
    reviewArticle:async(task,_site,_channel,_settings)=>{reviews++;return passed(task,store.read())},
    executeTask:async(context:ExecutionContext)=>{writes++;assert.equal(context.task.id,before.id);assert.equal(context.task.paragraph?.postId,postId);assert.equal(context.task.paragraph?.stage,'draft');assert.equal(context.task.articleReview?.status,'passed');return {status:'needs_input',message:'synthetic publication stop'}},
  });controller.runtime.aiReady=true;
  try{
    await controller.tick();const saved=store.read().tasks[0];assert.equal(reads,1);assert.equal(reviews,1);assert.equal(writes,1);assert.equal(saved.id,before.id);assert.equal(saved.paragraph?.postId,postId);assert.equal(store.read().tasks.length,1);
  }finally{store.close()}
});

test('pause, manual-mode transition, and draft edits cannot automatically reuse an earlier approval',async t=>{
  await t.test('paused site',async()=>{const store=storeFor('paragraph');let reads=0,writes=0;const controller=new Controller(store,vault(),'fixture',{reconcileParagraph:async()=>{reads++;return {status:'unknown'}},executeTask:async()=>{writes++;return {status:'review',message:'unexpected'}}});controller.runtime.aiReady=true;try{controller.sitePause(siteId,true);await controller.tick();assert.equal(reads,0);assert.equal(writes,0);assert.equal(store.read().sites[0].status,'paused')}finally{store.close()}});

  await t.test('manual review after recovering a remote draft',async()=>{const store=storeFor('paragraph');store.update(state=>{const task=state.tasks[0];task.articleApprovedAt=stamp;task.articleReview=passed(task,state);applySiteUpdate(state,{id:siteId,articleReviewMode:'manual'},new Date(stamp))});const current=store.read().tasks[0],found={publicationId,slug:current.paragraph!.slug,contentHash:current.paragraph!.contentHash,stage:'draft' as const,postId};let writes=0,reviews=0;const controller=new Controller(store,vault(),'fixture',{reconcileParagraph:async()=>({status:'draft',paragraph:found}),reviewArticle:async(task)=>{reviews++;return passed(task,store.read())},executeTask:async()=>{writes++;return {status:'needs_input',message:'unexpected'}}});controller.runtime.aiReady=true;try{await controller.tick();const saved=store.read().tasks[0];assert.equal(writes,0);assert.equal(reviews,0);assert.equal(saved.status,'needs_input');assert.equal(saved.checkpoint,'article_review');assert.equal(saved.articleApprovedAt,undefined)}finally{store.close()}});

  await t.test('edited draft',async()=>{const store=storeFor('paragraph');store.update(state=>{const task=state.tasks[0];delete task.submittedAt;delete task.paragraph;task.status='needs_input';task.checkpoint='article_review';task.articleApprovedAt=stamp;task.articleReview=passed(task,state);saveTaskDraft(state,task.id,{...task.draft!,body:task.draft!.body+' A newly verified limitation is included.'},new Date(stamp))});let reviews=0,writes=0;const controller=new Controller(store,vault(),'fixture',{reviewArticle:async(task)=>{reviews++;return passed(task,store.read())},executeTask:async()=>{writes++;return {status:'needs_input',message:'synthetic stop'}}});controller.runtime.aiReady=true;try{const before=store.read().tasks[0];assert.equal(before.articleApprovedAt,undefined);assert.equal(before.articleReview,undefined);await controller.tick();assert.equal(reviews,1);assert.equal(writes,1)}finally{store.close()}});
});
