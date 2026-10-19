import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState,migrateState} from '../src/main/store';
import {randomUUID} from 'node:crypto';
import {validateBackup} from '../src/main/backup-validation';
import {maintainWaitingTasks} from '../src/main/task-recovery';
import {applyTemporaryRetryState,temporaryRetry} from '../src/main/temporary-retry';
import {nextTask,schedulableTaskMatches,selectTaskPlatform} from '../src/main/planner';
import type {Channel,Site,Task} from '../src/shared/types';

const NOW=new Date('2026-10-20T12:00:00.000Z');
const site:Site={id:'site',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Guides',category:'software',language:'en',status:'ready',monthlyTarget:4,createdAt:'2026-09-01T00:00:00.000Z'};
function task(extra:Partial<Task>={}):Task{return {id:'task',siteId:site.id,channelId:'first',sourceDomain:'first.example.com',status:'running',createdAt:'2026-10-01T00:00:00.000Z',scheduledAt:NOW.toISOString(),updatedAt:NOW.toISOString(),attempts:2,message:'fixture',...extra}}
function channel(id:string):Channel{return {id,name:id,domain:`${id}.example.com`,url:`https://${id}.example.com/`,submitUrl:`https://${id}.example.com/new`,categories:['software'],languages:['en'],kind:'article',emailRequired:false,accountRequired:false,articleRequired:true,free:'yes',freeNote:'fixture',automation:'api',quality:'B',qualityReason:'fixture',provenance:'built-in',rulesUrl:`https://${id}.example.com/rules`,checkedAt:'2026-09-01',notes:'fixture',allowedHosts:[`${id}.example.com`],enabled:true}}

test('independent temporary failures allow three backoffs without reducing attempts and then stop',()=>{
  const state=emptyState(),value=task({temporaryRetryCount:2,temporaryRetryStage:'review'});state.sites=[site];state.tasks=[value];
  for(let index=0;index<3;index++){
    const at=new Date(NOW.getTime()+index*3600000),result=applyTemporaryRetryState(state,value.id,'ai_rate_limited',at,{scope:'independent',stage:'review'});
    assert.equal(result.kind,'retry');assert.equal(value.status,'queued');assert.equal(value.attempts,2);
    assert.equal(value.channelId,'first');assert.equal(value.temporaryRetryCount,2);assert.equal(value.temporaryRetryStage,'review');
    assert.equal(value.temporaryBackoffCount,index+1);assert.equal(value.temporaryBackoffStartedAt,NOW.toISOString());
    assert.equal(value.scheduledAt,new Date(at.getTime()+(index===0?2:8)*3600000).toISOString());assert.equal(value.failedPlatformIds,undefined);
  }
  applyTemporaryRetryState(state,value.id,'ai_rate_limited',new Date(NOW.getTime()+4*3600000),{scope:'independent',stage:'review'});
  assert.equal(value.status,'failed');assert.equal(value.checkpoint,'system_wait');assert.equal(value.nextCheckAt,undefined);
  assert.equal(value.recoveryEligible,false);assert.equal(value.attempts,2);assert.equal(value.temporaryBackoffCount,3);
});

test('independent retry expires at 72 hours even when fewer than three backoffs were used',()=>{
  const value=task({temporaryBackoffCount:1,temporaryBackoffStartedAt:NOW.toISOString()});
  const retry=temporaryRetry(value,'temporary_failure',new Date(NOW.getTime()+72*3600000),{scope:'independent'});
  assert.equal(retry?.status,'failed');assert.equal(retry?.checkpoint,'system_wait');assert.equal(retry?.nextCheckAt,undefined);
  assert.equal(retry?.recoveryEligible,false);assert.equal(retry?.channelId,undefined);assert.equal(retry?.failedPlatformIds,undefined);
});

test('a due independent retry remains selectable after the ordinary attempts limit',()=>{
  const state=emptyState(),first=channel('first'),value=task({status:'queued',reasonCode:'temporary_failure',attempts:state.settings.maxAttempts,temporaryBackoffCount:3,temporaryBackoffStartedAt:NOW.toISOString()});state.sites=[site];state.tasks=[value];state.settings.autoRun=true;
  assert.equal(nextTask(state,new Date(NOW.getTime()+60000),[first])?.id,value.id);
  value.temporaryBackoffCount=undefined;assert.equal(nextTask(state,new Date(NOW.getTime()+60000),[first]),undefined);
});

test('maintenance expires queued independent retries at 72 hours without another execution',()=>{
  const state=emptyState(),value=task({status:'queued',reasonCode:'temporary_failure',temporaryBackoffCount:1,temporaryBackoffStartedAt:NOW.toISOString()});state.sites=[site];state.tasks=[value];state.settings.autoRun=true;
  maintainWaitingTasks(state.tasks,state.sites,[channel('first')],state.settings,new Date(NOW.getTime()+72*3600000));
  assert.equal(value.status,'failed');assert.equal(value.checkpoint,'system_wait');assert.equal(value.recoveryEligible,false);assert.equal(value.nextCheckAt,undefined);assert.equal(value.attempts,2);
});

test('retry origin survives backup restore and legacy origin is frozen during migration',()=>{
  const state=emptyState(),siteId=randomUUID(),value=task({id:randomUUID(),siteId,status:'queued',reasonCode:'temporary_failure',temporaryBackoffCount:2,temporaryBackoffStartedAt:NOW.toISOString()});state.sites=[{...site,id:siteId}];state.tasks=[value];
  const restored=validateBackup({state,secrets:{}}).state;
  assert.equal(restored.tasks[0].temporaryBackoffStartedAt,NOW.toISOString());
  delete state.tasks[0].temporaryBackoffStartedAt;const migrated=migrateState(state);
  assert.equal(migrated.tasks[0].temporaryBackoffStartedAt,value.updatedAt);
  migrated.tasks[0].updatedAt=new Date(NOW.getTime()+86400000).toISOString();
  assert.equal(migrateState(migrated).tasks[0].temporaryBackoffStartedAt,NOW.toISOString());
});

test('platform retry counts are scoped to the execution stage',()=>{
  const state=emptyState(),value=task({temporaryRetryCount:2,temporaryRetryStage:'review'});state.sites=[site];state.tasks=[value];
  const result=applyTemporaryRetryState(state,value.id,'temporary_failure',NOW,{scope:'platform',stage:'publish'});
  assert.equal(result.kind,'retry');assert.equal(value.channelId,'first');assert.equal(value.temporaryRetryCount,1);assert.equal(value.temporaryRetryStage,'publish');assert.equal(value.scheduledAt,'2026-10-20T14:00:00.000Z');
  Object.assign(value,temporaryRetry(value,'temporary_failure',new Date(value.scheduledAt),{scope:'platform',stage:'publish'}));
  assert.equal(value.temporaryRetryCount,2);assert.equal(value.channelId,'first');
});

test('failed platform exclusions expire after thirty days including legacy entries',()=>{
  const state=emptyState(),value=task({channelId:'',sourceDomain:'',status:'queued',failedPlatformIds:['first','second'],failedPlatformAt:{first:'2026-09-20T11:59:59.000Z',second:'2026-10-19T12:00:00.000Z'}});state.sites=[site];state.tasks=[value];
  const matches=[{channel:channel('first'),score:1,reason:'first'},{channel:channel('second'),score:1,reason:'second'}];
  assert.deepEqual(schedulableTaskMatches(state,value,matches,NOW).map(item=>item.match.channel.id),['first']);
  value.failedPlatformIds=['first'];value.failedPlatformAt=undefined;value.updatedAt='2026-09-20T11:59:59.000Z';
  assert.deepEqual(schedulableTaskMatches(state,value,matches,NOW).map(item=>item.match.channel.id).sort(),['first','second']);
});

test('exhausting every otherwise valid exclusion clears the set and selects now instead of deferring 366 days',()=>{
  const state=emptyState(),value=task({channelId:'',sourceDomain:'',status:'queued',failedPlatformIds:['first'],failedPlatformAt:{first:NOW.toISOString()}}),first=channel('first');state.sites=[site];state.tasks=[value];
  const selected=selectTaskPlatform(state,value,[{channel:first,score:1,reason:'first'}],NOW);
  assert.equal(selected?.id,'first');assert.equal(value.channelId,'first');assert.equal(value.failedPlatformIds,undefined);assert.equal(value.failedPlatformAt,undefined);assert.ok(Date.parse(value.scheduledAt)<NOW.getTime()+86400000);
});
