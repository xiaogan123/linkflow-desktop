import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {CHANNELS} from '../src/integrations/catalog';
import {bindAccount} from '../src/main/account-bindings';
import {connectGist} from '../src/main/gist-management';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {taskAutomaticFollowupAt,taskHasAutomaticFollowup,taskPresentation} from '../src/ui/presentation';
import type {Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const siteId='11111111-1111-4111-8111-111111111111';
const taskId='22222222-2222-4222-8222-222222222222';
const accountId='33333333-3333-4333-8333-333333333333';
const stamp='2026-10-06T00:00:00.000Z';
const vault={ready:true,available:()=>true,get:async()=>undefined,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})} as unknown as Vault;

function fixture(channelId='github-gist'){
  const store=new Store(':memory:');
  store.update(state=>{
    state.settings.autoRun=true;
    state.settings.articleReviewMode='ai';
    state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(channel=>[channel.id,channel.id===channelId]));
    state.sites=[{
      id:siteId,url:'https://example.com/',domain:'example.com',email:'owner@example.com',name:'Example',
      description:'Original technical guides',category:'developer',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp,
      analyzedAt:stamp,topicsCheckedAt:new Date().toISOString(),qualifications:{developer:'https://example.com/project'},
      topics:[{url:'https://example.com/guide',discoveredAt:stamp}],
      ...(channelId==='blogger'?{blogger:{blogId:'100',url:'https://example.blogspot.com/'}}:{}),
    }];
    state.accounts=[{id:accountId,channelId,email:'owner@example.com',username:'original-owner',credentialKind:channelId==='blogger'?'oauth':'api_token',status:'registered',hasPassword:true,createdAt:stamp}];
    state.accountBindings=[{id:'44444444-4444-4444-8444-444444444444',siteId,channelId,accountId,createdAt:stamp,updatedAt:stamp}];
    state.tasks=[{
      id:taskId,siteId,channelId,accountId,sourceDomain:channelId==='blogger'?'example.blogspot.com':'gist.github.com',status:'queued',
      createdAt:stamp,updatedAt:stamp,scheduledAt:stamp,attempts:0,message:'fixture',
      draft:{title:'Practical guide',description:'A reusable technical guide',body:'Original reproducible technical documentation with a useful complete checklist.'},
      cost:{aiCalls:2},
    }];
  });
  return store;
}

function controller(store:Store){
  let writes=0,reviews=0;
  const value=new Controller(store,vault,'fixture',{
    discoverTopics:async()=>({topics:[],checkedAt:new Date().toISOString()}),
    reviewArticle:async(task,site,channel,settings)=>{
      reviews++;
      return {status:'passed',reason:'Synthetic independent review',reviewedAt:new Date().toISOString(),evidenceUrls:[site.url,channel.rulesUrl],draftRevision:task.draftRevision??0,contentHash:articleContentHash(task),contextHash:articleContextHash(site,channel,settings)};
    },
    executeTask:async()=>{writes++;return {status:'review',message:'Synthetic execution, no external request'};},
  });
  value.runtime.aiReady=true;
  return {value,counts:()=>({writes,reviews})};
}

test('restoring an explicit eligibility wait continues the same task and preserves its draft and cost',async()=>{
  const store=fixture(),gist=CHANNELS.find(channel=>channel.id==='github-gist')!;
  store.update(state=>{const task=state.tasks[0];task.attempts=1;task.articleReview={status:'passed',reason:'Review for the old qualification context',reviewedAt:stamp,evidenceUrls:[state.sites[0].url,gist.rulesUrl],draftRevision:task.draftRevision??0,contentHash:articleContentHash(task),contextHash:articleContextHash(state.sites[0],gist,state.settings)};});
  const original=structuredClone(store.read().tasks[0]),{value,counts}=controller(store);
  try{
    store.update(state=>state.sites[0].qualifications={});
    await value.tick();
    let saved=store.read().tasks[0];
    assert.equal(saved.status,'needs_input');
    assert.equal(saved.checkpoint,'eligibility_wait');
    assert.deepEqual(counts(),{writes:0,reviews:0});

    store.update(state=>state.sites[0].qualifications={developer:'https://example.com/replacement-project'});
    await value.tick();
    saved=store.read().tasks[0];
    assert.equal(saved.id,original.id);
    assert.deepEqual(saved.draft,original.draft);
    assert.deepEqual(saved.cost,original.cost);
    assert.equal(saved.attempts,original.attempts+1);
    assert.notEqual(saved.articleReview?.contextHash,original.articleReview?.contextHash);
    assert.equal(store.read().tasks.length,1);
    assert.deepEqual(counts(),{writes:1,reviews:1});
  }finally{store.close();}
});

test('eligibility recovery respects automatic pause, site pause, manual review, and exhausted task budget',async t=>{
  for(const boundary of ['automatic-pause','site-pause','manual-review','budget-exhausted'] as const)await t.test(boundary,async()=>{
    const store=fixture(),{value,counts}=controller(store);
    try{
      store.update(state=>{
        const task=state.tasks[0];task.status='needs_input';task.checkpoint='eligibility_wait';
        if(boundary==='automatic-pause')state.settings.autoRun=false;
        if(boundary==='site-pause')state.sites[0].status='paused';
        if(boundary==='manual-review'){state.sites[0].articleReviewMode='manual';task.articleApprovedAt=stamp;}
        if(boundary==='budget-exhausted')task.cost={aiCalls:6};
      });
      await value.tick();
      const saved=store.read().tasks[0];
      assert.equal(saved.id,taskId);
      assert.deepEqual(saved.draft,{title:'Practical guide',description:'A reusable technical guide',body:'Original reproducible technical documentation with a useful complete checklist.'});
      assert.deepEqual(counts(),{writes:0,reviews:0});
      if(boundary==='manual-review'){assert.equal(saved.status,'needs_input');assert.equal(saved.checkpoint,'article_review');assert.equal(saved.articleApprovedAt,undefined);}
      else {assert.equal(saved.status,'needs_input');assert.equal(saved.checkpoint,'eligibility_wait');}
    }finally{store.close();}
  });
});

test('a verified same-channel replacement resumes an unsubmitted invalid-credential task only once',async()=>{
  const store=fixture(),gist=CHANNELS.find(channel=>channel.id==='github-gist')!;store.update(state=>state.tasks[0].attempts=1);
  const original=structuredClone(store.read().tasks[0]),{value,counts}=controller(store);
  try{
    store.update(state=>state.accounts[0].status='credentials_invalid');
    value.plan();
    assert.equal(store.read().tasks[0].checkpoint,'account_handoff');
    const replacement=await connectGist(store,vault,'synthetic-fixture-token',async()=> 'replacement-owner');
    store.update(state=>bindAccount(state,replacement.id,siteId,gist));

    await value.tick();
    const saved=store.read().tasks[0];
    assert.equal(saved.id,original.id);
    assert.equal(saved.accountId,replacement.id);
    assert.deepEqual(saved.draft,original.draft);
    assert.deepEqual(saved.cost,original.cost);
    assert.equal(saved.attempts,original.attempts+1);
    assert.equal(store.read().tasks.length,1);
    assert.deepEqual(counts(),{writes:1,reviews:1});
  }finally{store.close();}
});

test('replacement never bypasses a restricted identity or an existing remote publication intent',async t=>{
  for(const boundary of ['restricted','submitted','checkpoint-only','blogger-draft'] as const)await t.test(boundary,async()=>{
    const channelId=boundary==='blogger-draft'?'blogger':'github-gist',store=fixture(channelId),channel=CHANNELS.find(item=>item.id===channelId)!;
    let reads=0,writes=0;
    store.update(state=>{
      const task=state.tasks[0];state.accounts[0].status=boundary==='restricted'?'restricted':'credentials_invalid';
      task.status=boundary==='checkpoint-only'?'queued':'needs_input';task.checkpoint='account_handoff';
      if(boundary==='submitted')Object.assign(task,{submittedAt:stamp,checkpoint:'submitting'});
      if(boundary==='checkpoint-only')task.checkpoint='submitting';
      if(boundary==='blogger-draft')Object.assign(task,{submittedAt:stamp,checkpoint:'blogger_draft_created',blogger:{blogId:'100',postId:'200',operationId:'operation',contentHash:'a'.repeat(64),stage:'draft'}});
      const replacementId='55555555-5555-4555-8555-555555555555';
      state.accounts.push({...state.accounts[0],id:replacementId,username:'replacement',status:'registered'});
      bindAccount(state,replacementId,siteId,channel);
    });
    const value=new Controller(store,vault,'fixture',{reconcileBlogger:async()=>{reads++;return {status:'unknown'};},executeTask:async()=>{writes++;return {status:'review',message:'unexpected'};}});value.runtime.aiReady=true;
    try{
      await value.tick();
      const saved=store.read().tasks[0];
      assert.equal(saved.accountId,accountId);
      assert.equal(writes,0);
      if(boundary==='blogger-draft')assert.equal(reads,1);else assert.equal(reads,0);
      if(boundary==='checkpoint-only')assert.equal(saved.checkpoint,'submitting');
    }finally{store.close();}
  });
});

test('Blogger uncertain insert displays its bounded read-only follow-up time',async()=>{
  const store=fixture('blogger');let reads=0,writes=0;
  store.update(state=>Object.assign(state.tasks[0],{status:'needs_input',submittedAt:stamp,checkpoint:'blogger_insert_submitting',blogger:{blogId:'100',operationId:'operation',contentHash:'a'.repeat(64),stage:'inserting'}}));
  const value=new Controller(store,vault,'fixture',{reconcileBlogger:async()=>{reads++;return {status:'unknown'};},executeTask:async()=>{writes++;return {status:'review',message:'unexpected'};}});value.runtime.aiReady=true;
  try{
    await value.tick();
    const saved=store.read().tasks[0],presentation=taskPresentation(saved,'ai',true);
    assert.equal(reads,1);assert.equal(writes,0);
    assert.equal(saved.reconcileAttempts,1);assert.ok(saved.reconcileAfter);
    assert.deepEqual(presentation,{kind:'system_retry',label:'自动查询发布结果',tone:'blue'});
    assert.equal(taskHasAutomaticFollowup(saved,true),true);
    assert.equal(taskAutomaticFollowupAt(saved,true),saved.reconcileAfter);
    assert.doesNotMatch(presentation.label,/重发|重投/);

    const exhausted={...saved,reconcileAttempts:3};
    assert.equal(taskHasAutomaticFollowup(exhausted,true),false);
    assert.equal(taskPresentation(exhausted,'ai',true).kind,'user_action');
    assert.equal(taskAutomaticFollowupAt(saved,false),undefined);
  }finally{store.close();}
});
