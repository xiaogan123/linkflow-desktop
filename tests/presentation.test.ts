import test from 'node:test';
import assert from 'node:assert/strict';
import type {ArticleReviewReasonCode,Task} from '../src/shared/types';
import {canResumeDeferredTask,canRetryTaskManually,taskAutomaticFollowupAt,taskCanAutoRecover,taskHasAutomaticFollowup,taskNeedsTelegraphReconciliation,taskPresentation,taskWorkKind} from '../src/ui/presentation';

const stamp='2026-10-04T00:00:00.000Z';
const task=(overrides:Partial<Task>={}):Task=>({id:'task-1',siteId:'site-1',channelId:'telegraph',sourceDomain:'telegra.ph',status:'failed',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'fixture',...overrides});
const failedReview=(reasonCode:ArticleReviewReasonCode)=>({status:'failed' as const,reason:'fixture',reasonCode,reviewedAt:stamp,evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)});

test('only one bounded final system recovery is presented as automatic',()=>{
  const eligible=task({checkpoint:'system_wait',nextCheckAt:'2026-10-05T00:00:00.000Z',recoveryAttempts:0,cost:{aiCalls:5},articleReview:failedReview('ai_unavailable')});
  assert.equal(taskCanAutoRecover(eligible),true);
  assert.equal(taskHasAutomaticFollowup(eligible),true);
  assert.equal(taskAutomaticFollowupAt(eligible),eligible.nextCheckAt);
  assert.equal(taskPresentation(eligible,'ai').label,'等待最后一次自动恢复');
  for(const exhausted of [
    {...eligible,recoveryAttempts:1},
    {...eligible,cost:{aiCalls:6}},
    {...eligible,nextCheckAt:undefined},
  ]){
    assert.equal(taskCanAutoRecover(exhausted),false);
    assert.equal(taskHasAutomaticFollowup(exhausted),false);
    assert.equal(taskPresentation(exhausted,'ai').label,'系统处理已暂停');
  }
  const rejected={...eligible,articleReview:failedReview('content_rejected')};
  assert.equal(taskCanAutoRecover(rejected),false);
  assert.equal(taskHasAutomaticFollowup(rejected),false);
  assert.equal(taskPresentation(rejected,'ai').label,'稿件核对未通过');
});

test('an interrupted AI marker can authorize the same bounded recovery without review metadata',()=>{
  const interrupted=task({checkpoint:'system_wait',nextCheckAt:'2026-10-05T00:00:00.000Z',recoveryEligible:true,recoveryAttempts:0,cost:{aiCalls:1}});
  assert.equal(taskCanAutoRecover(interrupted),true);
  const invalidEvidence=task({checkpoint:'system_wait',nextCheckAt:'2026-10-05T00:00:00.000Z',recoveryEligible:true,recoveryAttempts:0,cost:{aiCalls:3},articleReview:failedReview('evidence_invalid')});
  assert.equal(taskWorkKind(invalidEvidence,'ai'),'system_retry');
  assert.equal(taskCanAutoRecover(invalidEvidence),true);
});

test('Telegraph unknown submissions query automatically three times and never expose resend',()=>{
  const uncertain=task({status:'needs_input',checkpoint:'telegraph_publish_uncertain',submittedAt:stamp,reconcileAttempts:2,reconcileAfter:'2026-10-04T01:00:00.000Z'});
  assert.equal(taskNeedsTelegraphReconciliation(uncertain),true);
  assert.equal(taskWorkKind(uncertain,'ai'),'system_retry');
  assert.equal(taskPresentation(uncertain,'ai').label,'自动查询发布结果');
  assert.equal(taskAutomaticFollowupAt(uncertain),uncertain.reconcileAfter);
  assert.equal(canRetryTaskManually(uncertain,'ai'),false);

  const exhausted={...uncertain,reconcileAttempts:3};
  assert.equal(taskNeedsTelegraphReconciliation(exhausted),false);
  assert.equal(taskWorkKind(exhausted,'ai'),'user_action');
  assert.equal(taskPresentation(exhausted,'ai').label,'需要确认发布结果');
  assert.equal(taskHasAutomaticFollowup(exhausted),false);
  assert.equal(canRetryTaskManually(exhausted,'ai'),false);
  assert.doesNotMatch(taskPresentation(exhausted,'ai').label,/重发|重试/);
});

test('a disabled Telegraph channel never promises an automatic result query',()=>{
  const uncertain=task({status:'needs_input',checkpoint:'telegraph_publish_uncertain',submittedAt:stamp,reconcileAttempts:1});
  assert.equal(taskNeedsTelegraphReconciliation(uncertain,false),false);
  assert.equal(taskAutomaticFollowupAt(uncertain,false),undefined);
  assert.equal(taskHasAutomaticFollowup(uncertain,false),false);
  assert.equal(taskWorkKind(uncertain,'ai',false),'user_action');
  assert.equal(taskPresentation(uncertain,'ai',false).label,'需要确认发布结果');
});

test('a disabled channel blocks execution recovery but keeps read-only published-page checks',()=>{
  const recovery=task({channelId:'github-gist',checkpoint:'system_wait',nextCheckAt:'2026-10-05T00:00:00.000Z',recoveryEligible:true,recoveryAttempts:0,cost:{aiCalls:2}});
  assert.equal(taskCanAutoRecover(recovery,false),false);
  assert.equal(taskAutomaticFollowupAt(recovery,false),undefined);
  assert.equal(taskHasAutomaticFollowup(recovery,false),false);
  assert.equal(taskPresentation(recovery,'ai',false).label,'系统处理已暂停');

  const queued=task({channelId:'github-gist',status:'queued',scheduledAt:'2026-10-05T00:00:00.000Z'});
  assert.equal(taskAutomaticFollowupAt(queued,false),undefined);
  assert.equal(taskHasAutomaticFollowup(queued,false),false);

  const published=task({channelId:'github-gist',status:'live',publicUrl:'https://gist.github.com/example/result',firstLiveAt:stamp,nextCheckAt:'2026-10-05T00:00:00.000Z'});
  assert.equal(taskAutomaticFollowupAt(published,false),published.nextCheckAt);
  assert.equal(taskHasAutomaticFollowup(published,false),true);
});

test('deferred human work keeps a distinct label and only the unsubmitted original can resume',()=>{
  const deferred=task({status:'skipped',checkpoint:'manual_submission',deferredAt:'2026-10-06T00:00:00.000Z',draft:{title:'saved',description:'saved',body:'saved'}});
  assert.equal(taskWorkKind(deferred,'manual'),'deferred');
  assert.equal(taskPresentation(deferred,'manual').label,'已搁置');
  assert.equal(canResumeDeferredTask(deferred),true);
  assert.equal(canRetryTaskManually(deferred,'manual'),false);

  const unsafe={...deferred,checkpoint:'telegraph_publish_uncertain',submittedAt:stamp,reconcileAttempts:3};
  assert.equal(canResumeDeferredTask(unsafe),false);
  assert.equal(taskWorkKind(unsafe,'ai'),'user_action');
  assert.equal(taskPresentation(unsafe,'ai').label,'需要确认发布结果');
  assert.equal(canRetryTaskManually(unsafe,'ai'),false);
});


test('claimed Blogger draft displays the scheduled bounded recovery instead of a manual handoff',()=>{
 const draft=task({channelId:'blogger',checkpoint:'system_wait',submittedAt:stamp,nextCheckAt:'2026-10-05T00:00:00.000Z',recoveryEligible:true,recoveryAttempts:0,cost:{aiCalls:2},blogger:{blogId:'123',postId:'456',operationId:'op',contentHash:'a'.repeat(64),stage:'draft'}});
 assert.equal(taskCanAutoRecover(draft),true);
 assert.equal(taskWorkKind(draft,'ai'),'system_retry');
 assert.equal(taskPresentation(draft,'ai').label,'等待最后一次自动恢复');
 for(const blocked of [{...draft,recoveryAttempts:1},{...draft,blogger:{...draft.blogger!,stage:'inserting' as const}},{...draft,cost:{aiCalls:6}}])assert.equal(taskWorkKind(blocked,'ai'),'user_action');
 assert.equal(taskWorkKind(draft,'ai',false),'user_action');
});

test('Paper and Hive uncertain results show bounded automatic queries without a resend action',()=>{
 for(const channelId of ['paper-wf','hive']){
  const receipt=channelId==='paper-wf'?{paper:{username:'fixture',slug:'fixture-post',contentHash:'a'.repeat(64),stage:'submitting' as const}}:{hive:{author:'fixture',permlink:'fixture-post',contentHash:'a'.repeat(64),stage:'submitting' as const}};
  const uncertain=task({channelId,status:'needs_input',checkpoint:channelId==='paper-wf'?'paper_publish_submitting':'hive_publish_submitting',submittedAt:stamp,reconcileAttempts:1,reconcileAfter:'2026-10-04T01:00:00.000Z',...receipt});
  assert.equal(taskPresentation(uncertain,'ai').label,'自动查询发布结果');assert.equal(taskAutomaticFollowupAt(uncertain),uncertain.reconcileAfter);assert.equal(canRetryTaskManually(uncertain,'ai'),false);
  assert.equal(taskHasAutomaticFollowup({...uncertain,reconcileAttempts:3}),false);assert.equal(taskHasAutomaticFollowup(uncertain,false),false);
  const brokenCheckpoint={...uncertain,checkpoint:undefined,submittedAt:undefined};assert.equal(canRetryTaskManually(brokenCheckpoint,'ai'),false);assert.equal(canResumeDeferredTask({...brokenCheckpoint,deferredAt:stamp}),false);
 }
});
