import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {makePlan,selectTaskPlatform} from '../src/main/planner';
import {defaultSettings,emptyState} from '../src/main/store';
import {hasExternalAttempt,maintainWaitingTasks} from '../src/main/task-recovery';
import {publicationOpportunity} from '../src/shared/publication';
import {taskCooldownUntil,type TaskReasonCode} from '../src/shared/task-reasons';
import type {Channel,Site,Task} from '../src/shared/types';

const DAY=86_400_000;
const START='2026-10-01T00:00:00.000Z';
const topic=(number:number)=>({url:`https://example.com/guide-${number}`,title:`Guide ${number}`,discoveredAt:START});
function site(review:'ai'|'manual'='ai'):Site{return {id:'site',domain:'example.com',url:'https://example.com',email:'owner@example.com',name:'Example',description:'Independent guides',category:'content',language:'en',monthlyTarget:2,qualifications:{developer:'https://example.com/developer'},articleReviewMode:review,status:'ready',createdAt:START,topics:[topic(1),topic(2),topic(3)]}}
function channel(id:'telegraph'|'github-gist'|'agentswiki'='telegraph',enabled=true):Channel{return {id,name:id,domain:`${id}.example`,url:'https://publisher.example',submitUrl:'https://publisher.example/new',categories:['content'],languages:['en'],kind:'article',emailRequired:false,accountRequired:false,articleRequired:true,free:'yes',freeNote:'',automation:'api',quality:'A',qualityReason:'fixture',provenance:'built-in',rulesUrl:'https://publisher.example/rules',checkedAt:START,notes:'',allowedHosts:[],enabled}}
function task(extra:Partial<Task>={}):Task{return {id:randomUUID(),siteId:'site',channelId:'telegraph',sourceDomain:'telegraph.example',status:'failed',createdAt:START,scheduledAt:START,updatedAt:START,attempts:0,message:'placeholder',topicUrl:topic(1).url,draft:{title:'Old draft',description:'Old summary',body:'Old body'},...extra}}

test('reason-coded terminal work uses the requested cooldown windows and then selects a fresh topic',()=>{
  const cases:Array<{code:TaskReasonCode;days:number;status:'failed'|'skipped'}>=[
    {code:'content_rejected',days:45,status:'failed'},
    {code:'platform_rejected',days:30,status:'failed'},
    {code:'human_timeout',days:14,status:'skipped'},
    {code:'user_skipped',days:30,status:'skipped'},
  ];
  for(const {code,days,status} of cases){
    const old=task({status,reasonCode:code,cooldownUntil:taskCooldownUntil(code,START)}),entry=channel();
    const before=publicationOpportunity(site(),entry,[old],new Date(Date.parse(START)+(days-1)*DAY),'UTC',{officialApiConnected:true});
    assert.equal(before.allowed,false,code);assert.equal(before.nextAvailableAt,taskCooldownUntil(code,START),code);
    const after=publicationOpportunity(site(),entry,[old],new Date(Date.parse(START)+days*DAY),'UTC',{officialApiConnected:true});
    assert.equal(after.allowed,true,code);assert.equal(after.topicUrl,topic(2).url,code);
  }
});

test('an expired cooldown creates a different task with a new topic and no carried draft',()=>{
  const state=emptyState(),target=site(),entry=channel();state.settings.timezone='UTC';state.sites=[target];
  const old=task({reasonCode:'content_rejected',cooldownUntil:'2026-09-15T00:00:00.000Z',createdAt:'2026-08-01T00:00:00.000Z',updatedAt:'2026-08-01T00:00:00.000Z'});state.tasks=[old];
  const created=makePlan(state,target,[{channel:entry,score:100,reason:'eligible'}],new Date(START));
  assert.equal(created.length,1);assert.notEqual(created[0].id,old.id);assert.equal(created[0].channelId,'');assert.equal(selectTaskPlatform(state,created[0],[{channel:entry,score:100,reason:'eligible'}],new Date(created[0].scheduledAt))?.id,'telegraph');assert.equal(created[0].topicUrl,topic(2).url);assert.equal(created[0].draft,undefined);assert.equal(created[0].cost,undefined);
  assert.equal(old.draft?.body,'Old body');
});

test('re-enabling a disabled channel releases it immediately and a transient failure does not create a cooldown',()=>{
  const disabled=task({status:'skipped',reasonCode:'channel_disabled'});
  assert.equal(publicationOpportunity(site(),channel('telegraph',false),[disabled],new Date(START),'UTC').allowed,false);
  const enabled=publicationOpportunity(site(),channel(),[disabled],new Date(START),'UTC',{officialApiConnected:true});
  assert.equal(enabled.allowed,true);assert.equal(enabled.topicUrl,topic(2).url);

  const transient=task({reasonCode:'temporary_failure'}),available=publicationOpportunity(site(),channel(),[transient],new Date(START),'UTC',{officialApiConnected:true});
  assert.equal(available.allowed,true);assert.equal(available.topicUrl,topic(2).url);
});

test('a transient original-task retry keeps its id, draft and cumulative budget before planning is released',()=>{
  const retryAt='2026-10-02T00:00:00.000Z',original=task({reasonCode:'temporary_failure',checkpoint:'system_wait',recoveryEligible:true,recoveryAttempts:0,nextCheckAt:retryAt,cost:{aiCalls:2}}),id=original.id,draft=structuredClone(original.draft);
  const blocked=publicationOpportunity(site(),channel(),[original],new Date(START),'UTC',{officialApiConnected:true});
  assert.equal(blocked.allowed,false);assert.equal(blocked.nextAvailableAt,retryAt);
  const reminders=maintainWaitingTasks([original],[site()],[channel()],{...defaultSettings(),autoRun:true},new Date(retryAt));
  assert.deepEqual(reminders,[]);assert.equal(original.id,id);assert.equal(original.status,'queued');assert.equal(original.recoveryAttempts,1);assert.equal(original.cost?.aiCalls,2);assert.deepEqual(original.draft,draft);assert.equal(original.reasonCode,undefined);
});

test('daily maintenance never extends an existing terminal review cooldown',()=>{
  const rejected=task({status:'failed',checkpoint:'article_rejected',topicSwitchAttempts:1,reasonCode:undefined,cooldownUntil:undefined,
    articleReview:{status:'failed',reason:'Rejected',reasonCode:'content_rejected',evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)}}),settings={...defaultSettings(),autoRun:true};
  const first=new Date('2026-10-02T00:00:00.000Z'),second=new Date('2026-10-03T00:00:00.000Z');
  maintainWaitingTasks([rejected],[site()],[channel()],settings,first);
  assert.equal(rejected.reasonCode,'content_rejected');assert.equal(rejected.cooldownUntil,'2026-11-16T00:00:00.000Z');assert.equal(rejected.updatedAt,first.toISOString());
  maintainWaitingTasks([rejected],[site()],[channel()],settings,second);
  assert.equal(rejected.cooldownUntil,'2026-11-16T00:00:00.000Z');assert.equal(rejected.updatedAt,first.toISOString());
});

test('platform cooldown switches to another platform without reading display text',()=>{
  const state=emptyState(),target=site(),primary=channel(),alternate=channel('github-gist');state.settings.timezone='UTC';state.sites=[target];state.tasks=[task({reasonCode:'platform_rejected',cooldownUntil:'2026-10-31T00:00:00.000Z',message:'placeholder'})];
  const created=makePlan(state,target,[{channel:primary,score:100,reason:'primary'},{channel:alternate,score:90,reason:'alternate'}],new Date(START));
  assert.equal(created.length,1);assert.equal(created[0].channelId,'');assert.equal(selectTaskPlatform(state,created[0],[{channel:primary,score:100,reason:'primary'},{channel:alternate,score:90,reason:'alternate'}],new Date(created[0].scheduledAt))?.id,'github-gist');assert.equal(created[0].channelId,'github-gist');assert.equal(created[0].topicUrl,topic(2).url);
});

test('Agents Wiki and AgentsGather receipts are permanent submission evidence while registration metadata is not',()=>{
  const agentsWiki:NonNullable<Task['agentsWiki']>={operationId:'agentswiki_article_fixture',accountId:'account',remoteAccountId:'remote',idempotencyKey:'fixture-key',sourceHash:'a'.repeat(64),requestHash:'b'.repeat(64),createdAt:START,stage:'submitting'};
  const agentsGather:NonNullable<Task['agentsGather']>={requestId:'fixture-request',sourceHash:'a'.repeat(64),requestHash:'b'.repeat(64),createdAt:START,stage:'submitting'};
  for(const receipt of [{agentsWiki},{agentsGather}]){
    const submitted=task({...receipt,status:'failed',reasonCode:'temporary_failure',submittedAt:undefined,publicUrl:undefined,message:'placeholder'});
    assert.equal(hasExternalAttempt(submitted),true);
    const result=publicationOpportunity(site(),channel(),[submitted],new Date('2027-10-01T00:00:00.000Z'),'UTC',{officialApiConnected:true});
    assert.equal(result.allowed,false);assert.equal(result.nextAvailableAt,undefined);
  }
  const registration=task({channelId:'agentswiki',sourceDomain:'agentswiki.example',status:'needs_input',checkpoint:'agentswiki_registration_unknown',reasonCode:'account_handoff',submittedAt:START,draft:undefined});
  assert.equal(hasExternalAttempt(registration),false);
  const unknown=task({status:'needs_input',checkpoint:'legacy_unknown',reasonCode:'submission_unknown',submittedAt:undefined,draft:undefined});
  assert.equal(hasExternalAttempt(unknown),true);
});

test('manual review reminds once at 24h and every no-publication human wait is abandoned at 48h',()=>{
  const manualSite=site('manual'),entry=channel(),review=task({status:'needs_input',checkpoint:'article_review',reasonCode:'manual_review',waitingSince:START,waitingDeadlineAt:'2026-10-03T00:00:00.000Z'}),settings={...defaultSettings(),autoRun:true};
  const first=maintainWaitingTasks([review],[manualSite],[entry],settings,new Date('2026-10-02T01:00:00.000Z'));
  assert.deepEqual(first.map(item=>item.id),[review.id]);assert.equal(review.waitingReminderAt,'2026-10-02T01:00:00.000Z');assert.equal(review.status,'needs_input');
  assert.deepEqual(maintainWaitingTasks([review],[manualSite],[entry],settings,new Date('2026-10-02T02:00:00.000Z')),[]);
  maintainWaitingTasks([review],[manualSite],[entry],settings,new Date('2026-10-03T01:00:00.000Z'));
  assert.equal(review.status,'skipped');assert.equal(review.reasonCode,'human_timeout');assert.equal(review.cooldownUntil,'2026-10-17T01:00:00.000Z');assert.equal(review.deferredAt,undefined);

  const registration=task({channelId:'agentswiki',sourceDomain:'agentswiki.example',status:'needs_input',checkpoint:'agentswiki_registration_unknown',reasonCode:'account_handoff',waitingSince:START,waitingDeadlineAt:'2026-10-03T00:00:00.000Z',draft:undefined});
  maintainWaitingTasks([registration],[manualSite],[channel('agentswiki')],settings,new Date('2026-10-03T01:00:00.000Z'));
  assert.equal(registration.status,'skipped');assert.equal(registration.reasonCode,'human_timeout');

  const external=task({status:'needs_input',reasonCode:'submission_unknown',waitingSince:START,waitingDeadlineAt:'2026-10-03T00:00:00.000Z',draft:undefined}),before=structuredClone(external);
  maintainWaitingTasks([external],[manualSite],[entry],settings,new Date('2026-10-03T01:00:00.000Z'));
  assert.deepEqual(external,before);
});

test('a retained Notebin journal intent alone remains possible article submission evidence',()=>{
  const old=task({status:'needs_input',reasonCode:'human_required',waitingSince:START,waitingDeadlineAt:'2026-10-03T00:00:00.000Z',notebinJournal:{stage:'intent'} as Task['notebinJournal']});
  assert.equal(hasExternalAttempt(old),true);
  const before=structuredClone(old);maintainWaitingTasks([old],[site()], [channel()],{...defaultSettings(),autoRun:true},new Date('2026-10-18T00:00:00Z'));
  assert.deepEqual(old,before);assert.equal(publicationOpportunity(site(),channel(),[old],new Date('2027-01-01T00:00:00Z'),'UTC').allowed,false);
});

test('exhausting transient retries does not impersonate AI exhaustion or lock the platform',()=>{
  const old=task({reasonCode:'temporary_failure',checkpoint:'system_wait',recoveryAttempts:1,recoveryEligible:true,nextCheckAt:START,cost:{aiCalls:2}});
  const before=structuredClone(old.draft);
  maintainWaitingTasks([old],[site()],[channel()],{...defaultSettings(),autoRun:true},new Date(START));
  assert.equal(old.status,'failed');assert.equal(old.reasonCode,'temporary_failure');assert.equal(old.cooldownUntil,undefined);
  assert.equal(old.recoveryEligible,false);assert.equal(old.nextCheckAt,undefined);assert.equal(old.cost?.aiCalls,2);assert.deepEqual(old.draft,before);
  const result=publicationOpportunity(site(),channel(),[old],new Date(START),'UTC',{officialApiConnected:true});
  assert.equal(result.allowed,true);assert.equal(result.topicUrl,topic(2).url);
});

test('three paid AI calls stop the original retry while retaining the draft and cumulative cost',()=>{
  const old=task({reasonCode:'temporary_failure',checkpoint:'system_wait',recoveryAttempts:0,recoveryEligible:true,nextCheckAt:START,cost:{aiCalls:3}}),id=old.id,before=structuredClone(old.draft);
  maintainWaitingTasks([old],[site()],[channel()],{...defaultSettings(),autoRun:true},new Date(START));
  assert.equal(old.id,id);assert.equal(old.status,'failed');assert.equal(old.reasonCode,'ai_task_limit');assert.equal(old.recoveryEligible,false);assert.equal(old.nextCheckAt,undefined);assert.equal(old.cost?.aiCalls,3);assert.deepEqual(old.draft,before);
  assert.equal(publicationOpportunity(site(),channel(),[old],new Date(START),'UTC',{officialApiConnected:true}).blockingReason,'budget_exhausted');
});

test('a referral-marked topic is swapped only on a task that has nothing on the platform yet',()=>{
  const current=site(),referral='https://example.com/guide-1?ref=ABCD1234';
  const base=task({status:'needs_input',reasonCode:'referral_blocked',topicUrl:referral,checkpoint:'referral_guard'});
  const fresh=structuredClone(base);
  maintainWaitingTasks([fresh],[current],[channel('agentswiki')].map(value=>({...value,id:'telegraph'})),{...defaultSettings(),autoRun:true},new Date(START));
  assert.notEqual(fresh.topicUrl,referral);
  // A registration already in flight keeps its topic and checkpoint.
  for(const extra of [{checkpoint:'account_registration_submitted'},{colony:{stage:'intent'}}] as Partial<Task>[]){
    const inFlight={...structuredClone(base),...extra};
    maintainWaitingTasks([inFlight],[current],[channel('agentswiki')].map(value=>({...value,id:'telegraph'})),{...defaultSettings(),autoRun:true},new Date(START));
    assert.equal(inFlight.topicUrl,referral,JSON.stringify(extra));
    assert.equal(inFlight.checkpoint,extra.checkpoint??'referral_guard');
  }
});
