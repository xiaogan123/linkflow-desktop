import test from 'node:test';
import assert from 'node:assert/strict';
import type {Channel,Settings,Site,Task} from '../src/shared/types';
import {emptyState} from '../src/main/store';
import {decryptBackup,encryptBackup} from '../src/main/backup';
import {validateBackup} from '../src/main/backup-validation';
import {
  consumeOneReviewRetry,
  grantOneReviewRetry,
  invalidateOneReviewRetry,
  ONE_REVIEW_RETRY_PURPOSE,
  oneReviewRetryBinding,
  oneReviewRetryEligibility,
  type OneReviewRetryContext,
} from '../src/main/one-review-retry';

const SITE_ID='11111111-1111-4111-8111-111111111111';
const TASK_ID='22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID='33333333-3333-4333-8333-333333333333';
const STAMP='2026-10-17T01:00:00.000Z';
const TOKEN='synthetic-operation-token-'.padEnd(64,'x');

function settings():Settings{return {provider:'codex',codexPath:'codex',model:'synthetic-review-model',articleReviewMode:'ai',apiBase:'https://api.synthetic.example/v1',hasApiKey:false,autoRun:false,launchAtLogin:false,notify:false,timezone:'UTC',maxAttempts:3,maxSteps:18,dailyAiLimit:40,channelOverrides:{},mail:{host:'mail.synthetic.example',port:993,user:'fixture@synthetic.example',secure:true,hasPassword:false}}}
function site():Site{return {id:SITE_ID,domain:'site.synthetic.example',url:'https://site.synthetic.example/',email:'owner@synthetic.example',publicEmail:'public@synthetic.example',name:'Synthetic Site',description:'Synthetic description used only by a unit test.',category:'content',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:STAMP}}
function channel():Channel{return {id:'synthetic-review',name:'Synthetic Review',domain:'channel.synthetic.example',url:'https://channel.synthetic.example/',submitUrl:'https://channel.synthetic.example/submit',categories:['content'],languages:['en'],kind:'article',emailRequired:false,accountRequired:false,articleRequired:true,free:'yes',freeNote:'Synthetic fixture',automation:'api',quality:'C',qualityReason:'Synthetic fixture',rulesUrl:'https://channel.synthetic.example/rules',checkedAt:'2026-10-17',notes:'Synthetic policy fixture',allowedHosts:['channel.synthetic.example'],enabled:true}}
function task():Task{return {id:TASK_ID,siteId:SITE_ID,channelId:'synthetic-review',accountId:ACCOUNT_ID,sourceDomain:'channel.synthetic.example',status:'failed',createdAt:STAMP,scheduledAt:STAMP,updatedAt:STAMP,attempts:1,message:'Synthetic failed review',draft:{title:'Synthetic title',description:'Synthetic description',body:'Synthetic article body with no real site or publication data.'},draftRevision:3,cost:{aiCalls:6},checkpoint:'article_review'}}

function fixture(){
  const currentTask=task(),currentSite=site(),currentChannel=channel(),currentSettings=settings();
  const context:OneReviewRetryContext={site:currentSite,channel:currentChannel,settings:currentSettings,account:{id:ACCOUNT_ID,channelId:currentChannel.id,username:'synthetic-author'}};
  const binding=oneReviewRetryBinding(currentTask,context);
  currentTask.articleReview={status:'failed',reason:'Synthetic invalid response shape.',reasonCode:'format_invalid',reviewContractVersion:4,reviewedAt:STAMP,evidenceUrls:['https://site.synthetic.example/evidence'],draftRevision:binding.draftRevision,contentHash:binding.contentHash,contextHash:binding.contextHash};
  return {task:currentTask,site:currentSite,channel:currentChannel,settings:currentSettings,context};
}

test('one explicit grant is bound to the failed draft and consumed exactly from call 6 to call 7',()=>{
  const value=fixture(),grant=grantOneReviewRetry(value.task,value.context,TOKEN,new Date(STAMP));
  value.task.oneReviewRetry=grant;
  assert.equal(JSON.stringify(value.task).includes(TOKEN),false);
  consumeOneReviewRetry(value.task,value.context,{purpose:ONE_REVIEW_RETRY_PURPOSE,operationToken:TOKEN},new Date('2026-10-17T01:01:00.000Z'));
  assert.equal(value.task.cost?.aiCalls,7);
  assert.equal(value.task.oneReviewRetry?.status,'consumed');
  assert.throws(()=>consumeOneReviewRetry(value.task,value.context,{purpose:ONE_REVIEW_RETRY_PURPOSE,operationToken:TOKEN}),/\u5df2\u7ec8\u7ed3/);
  assert.throws(()=>grantOneReviewRetry(value.task,value.context,TOKEN),/already_recorded/);
});

test('generation, repair and topic actions cannot spend the review-only grant',()=>{
  for(const purpose of ['article_generation','article_repair','topic_switch']){
    const value=fixture();value.task.oneReviewRetry=grantOneReviewRetry(value.task,value.context,TOKEN,new Date(STAMP));
    const before=structuredClone(value.task);
    assert.throws(()=>consumeOneReviewRetry(value.task,value.context,{purpose,operationToken:TOKEN} as never),/\u53ea\u80fd\u7528\u4e8e\u72ec\u7acb\u6587\u7ae0\u5ba1\u6838/);
    assert.deepEqual(value.task,before);
  }
});

test('wrong tokens, double clicks and changed draft or review context fail without spending the grant',()=>{
  const mutations:Array<(value:ReturnType<typeof fixture>)=>void>=[
    value=>{value.task.draft={...value.task.draft!,body:value.task.draft!.body+' changed'}},
    value=>{value.task.draftRevision=4},
    value=>{value.task.topicUrl='https://site.synthetic.example/other'},
    value=>{value.context={...value.context,settings:{...value.settings,provider:'api'}}},
    value=>{value.context={...value.context,settings:{...value.settings,model:'different-synthetic-model'}}},
    value=>{value.context={...value.context,site:{...value.site,description:'Changed synthetic context'}}},
    value=>{value.context={...value.context,channel:{...value.channel,notes:'Changed synthetic rules'}}},
    value=>{value.context={...value.context,account:{...value.context.account!,id:'44444444-4444-4444-8444-444444444444'}}},
  ];
  for(const mutate of mutations){
    const value=fixture();value.task.oneReviewRetry=grantOneReviewRetry(value.task,value.context,TOKEN,new Date(STAMP));mutate(value);
    const before=structuredClone(value.task);
    assert.throws(()=>consumeOneReviewRetry(value.task,value.context,{purpose:ONE_REVIEW_RETRY_PURPOSE,operationToken:TOKEN}));
    assert.deepEqual(value.task,before);
  }
  const value=fixture();value.task.oneReviewRetry=grantOneReviewRetry(value.task,value.context,TOKEN,new Date(STAMP));
  assert.throws(()=>consumeOneReviewRetry(value.task,value.context,{purpose:ONE_REVIEW_RETRY_PURPOSE,operationToken:'wrong-operation-token-'.padEnd(64,'y')}),/\u4ee4\u724c\u4e0d\u5339\u914d/);
  assert.equal(value.task.cost?.aiCalls,6);
});

test('only an exact current failed review at call 6 is eligible',()=>{
  const restored=fixture();restored.task.status='needs_input';assert.equal(oneReviewRetryEligibility(restored.task,restored.context).eligible,true);
  for(const mutate of [
    (value:ReturnType<typeof fixture>)=>{value.task.cost={aiCalls:5}},
    (value:ReturnType<typeof fixture>)=>{value.task.cost={aiCalls:7}},
    (value:ReturnType<typeof fixture>)=>{value.task.checkpoint='article_repair'},
    (value:ReturnType<typeof fixture>)=>{value.task.articleReview={...value.task.articleReview!,status:'passed'}},
    (value:ReturnType<typeof fixture>)=>{value.task.articleReview={...value.task.articleReview!,contentHash:'0'.repeat(64)}},
    (value:ReturnType<typeof fixture>)=>{value.task.submittedAt=STAMP},
    (value:ReturnType<typeof fixture>)=>{value.task.status='queued'},
  ]){const value=fixture();mutate(value);assert.equal(oneReviewRetryEligibility(value.task,value.context).eligible,false)}
});

test('restart or cancellation invalidates an unused grant and never restores the authorization',()=>{
  for(const reason of ['restart','cancelled','request_not_started','binding_changed'] as const){
    const value=fixture();value.task.oneReviewRetry=grantOneReviewRetry(value.task,value.context,TOKEN,new Date(STAMP));
    invalidateOneReviewRetry(value.task,reason,new Date('2026-10-17T01:02:00.000Z'));
    assert.equal(value.task.oneReviewRetry.status,'invalidated');
    assert.equal(value.task.cost?.aiCalls,6);
    assert.throws(()=>consumeOneReviewRetry(value.task,value.context,{purpose:ONE_REVIEW_RETRY_PURPOSE,operationToken:TOKEN}),/\u5df2\u7ec8\u7ed3/);
    assert.throws(()=>grantOneReviewRetry(value.task,value.context,TOKEN),/already_recorded/);
  }
});

function backupState(currentTask:Task,currentSite:Site,currentSettings:Settings){
  const state=emptyState();state.settings=currentSettings;state.sites=[currentSite];state.tasks=[currentTask];
  state.accounts=[{id:ACCOUNT_ID,channelId:'synthetic-review',email:'account@synthetic.example',username:'synthetic-author',createdAt:STAMP,status:'registered',hasPassword:false}];
  state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId:SITE_ID,channelId:'synthetic-review',accountId:ACCOUNT_ID,createdAt:STAMP,updatedAt:STAMP}];
  return state;
}

test('backup import preserves the one-shot record, invalidates an unused grant, and preserves a consumed grant',()=>{
  const unused=fixture();unused.task.oneReviewRetry=grantOneReviewRetry(unused.task,unused.context,TOKEN,new Date(STAMP));
  const unusedBackup={state:backupState(unused.task,unused.site,unused.settings),secrets:{}};
  const encrypted=encryptBackup(unusedBackup,'synthetic-backup-passphrase-2026');
  const restoredUnused=validateBackup(decryptBackup(encrypted,'synthetic-backup-passphrase-2026')).state.tasks[0];
  assert.equal(restoredUnused.oneReviewRetry?.status,'invalidated');
  assert.equal(restoredUnused.oneReviewRetry?.status==='invalidated'&&restoredUnused.oneReviewRetry.invalidationReason,'backup_import');
  assert.equal(restoredUnused.cost?.aiCalls,6);
  assert.equal(JSON.stringify(restoredUnused).includes(TOKEN),false);

  const used=fixture();used.task.oneReviewRetry=grantOneReviewRetry(used.task,used.context,TOKEN,new Date(STAMP));
  consumeOneReviewRetry(used.task,used.context,{purpose:ONE_REVIEW_RETRY_PURPOSE,operationToken:TOKEN},new Date('2026-10-17T01:01:00.000Z'));
  const restoredUsed=validateBackup({state:backupState(used.task,used.site,used.settings),secrets:{}}).state.tasks[0];
  assert.deepEqual(restoredUsed.oneReviewRetry,used.task.oneReviewRetry);
  assert.equal(restoredUsed.cost?.aiCalls,7);
});

test('a review granted before account creation keeps its null binding after the normal account is created',()=>{
  const value=fixture();
  value.task.accountId=undefined;
  value.context={...value.context,account:undefined};
  const binding=oneReviewRetryBinding(value.task,value.context);
  value.task.articleReview={...value.task.articleReview!,draftRevision:binding.draftRevision,contentHash:binding.contentHash,contextHash:binding.contextHash};
  value.task.oneReviewRetry=grantOneReviewRetry(value.task,value.context,TOKEN,new Date(STAMP));
  consumeOneReviewRetry(value.task,value.context,{purpose:ONE_REVIEW_RETRY_PURPOSE,operationToken:TOKEN},new Date('2026-10-17T01:01:00.000Z'));
  assert.equal(value.task.oneReviewRetry.accountId,null);
  value.task.accountId=ACCOUNT_ID;
  const restored=validateBackup({state:backupState(value.task,value.site,value.settings),secrets:{}}).state.tasks[0];
  assert.equal(restored.accountId,ACCOUNT_ID);
  assert.equal(restored.oneReviewRetry?.accountId,null);
  assert.equal(restored.oneReviewRetry?.status,'consumed');
});

test('backup validation rejects malformed or count-inconsistent one-shot records',()=>{
  const value=fixture();value.task.oneReviewRetry=grantOneReviewRetry(value.task,value.context,TOKEN,new Date(STAMP));
  consumeOneReviewRetry(value.task,value.context,{purpose:ONE_REVIEW_RETRY_PURPOSE,operationToken:TOKEN},new Date('2026-10-17T01:01:00.000Z'));
  const state=backupState(value.task,value.site,value.settings);
  const wrongCount=structuredClone(state);wrongCount.tasks[0].cost={aiCalls:6};
  assert.throws(()=>validateBackup({state:wrongCount,secrets:{}}),/\u5355\u6b21\u8ffd\u52a0\u5ba1\u6838/);
  const wrongHash=structuredClone(state);wrongHash.tasks[0].oneReviewRetry!.operationTokenHash='not-a-hash';
  assert.throws(()=>validateBackup({state:wrongHash,secrets:{}}));
  const reversedTime=structuredClone(state);if(reversedTime.tasks[0].oneReviewRetry?.status==='consumed')reversedTime.tasks[0].oneReviewRetry.consumedAt='2026-10-17T00:59:00.000Z';
  assert.throws(()=>validateBackup({state:reversedTime,secrets:{}}),/\u5355\u6b21\u8ffd\u52a0\u5ba1\u6838/);
});
