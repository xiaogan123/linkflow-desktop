import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState} from '../src/main/store';
import {availableNetworkPlatforms,recoverInterrupted,reflowQueuedSchedules,scheduleEvents,schedulableTaskMatches} from '../src/main/planner';
import {eligiblePlatforms,findDeferredReservation,planMonthlyReservations,samePlatformGapDays,scheduleOnPreferredHour,schedulingMinute,selectWeightedPlatform} from '../src/shared/scheduling';
import {missedPublicationsLast7Days,onlineHoursLast7Days,recordOnlineHour} from '../src/shared/runtime-hours';
import type {Channel,Site,Task} from '../src/shared/types';

const DAY=86400000;
const site:Site={id:'site',domain:'example.com',url:'https://example.com',email:'owner@example.com',name:'Example',description:'software guides',category:'software',language:'en',status:'ready',monthlyTarget:4,createdAt:'2026-09-01T00:00:00Z'};
function channel(id:string):Channel{return {id,name:id,domain:`${id}.example.com`,url:`https://${id}.example.com`,submitUrl:`https://${id}.example.com/new`,categories:['software'],languages:['en'],kind:'article',emailRequired:false,accountRequired:false,articleRequired:true,free:'yes',freeNote:'',automation:'api',quality:'B',qualityReason:'fixture',provenance:'built-in',rulesUrl:`https://${id}.example.com/rules`,checkedAt:'2026-09-01',notes:'',allowedHosts:[`${id}.example.com`],enabled:true}}
function task(id:string,channelId=''):Task{return {id,siteId:'site',channelId,sourceDomain:channelId?`${channelId}.example.com`:'',status:'queued',createdAt:'2026-10-01T00:00:00Z',scheduledAt:'2026-10-15T12:11:00Z',updatedAt:'2026-10-01T00:00:00Z',attempts:0,message:'fixture'}}

test('b9a2 AI setup waiting never consumes missed publication reschedules',()=>{
  const state=emptyState(),value=task('ai-wait','first');
  value.checkpoint='ai_setup_required';value.scheduling={version:1,month:'2026-10',slot:0,target:4,effectiveTarget:4,reschedules:0};
  state.sites=[site];state.tasks=[value];state.settings.autoRun=true;
  const scheduledAt=value.scheduledAt;
  for(const date of ['2026-10-20','2026-10-24','2026-10-28','2026-11-02']){
    assert.deepEqual(reflowQueuedSchedules(state,[channel('first')],new Date(`${date}T12:11:00Z`)),[]);
    assert.equal(value.status,'queued');assert.equal(value.scheduledAt,scheduledAt);
    assert.equal(value.scheduling.reschedules,0);assert.equal(value.missedPublicationAt,undefined);
  }
});

test('one or two allowed AI calls still find a near-term deferral day',()=>{
  const now=new Date('2026-10-10T12:11:00Z');
  for(const limit of [1,2]){
    const result=findDeferredReservation(site,[{id:'first'}],[],now,'UTC',`limit-${limit}`,limit);
    assert.ok(result&&result.getTime()>now.getTime()&&result.getTime()<now.getTime()+7*DAY);
  }
});

test('first-ready site after its import opening window receives a remaining-month first post',()=>{
  const newSite={...site,createdAt:'2026-10-01T00:00:00Z'},now=new Date('2026-10-20T12:00:00Z');
  const slots=planMonthlyReservations([newSite],[{id:'first'}],[],now,'UTC');
  assert.equal(slots.length,1);assert.ok(slots[0].at>now.toISOString()&&slots[0].at<'2026-11-01');
});

test('monthly article gaps stay within thirty percent when there are available days',()=>{
  const existingSite={...site,createdAt:'2026-08-01T00:00:00Z',monthlyTarget:8};
  const slots=planMonthlyReservations([existingSite],Array.from({length:15},(_,i)=>({id:`p-${i}`})),[],new Date('2026-09-01T00:00:00Z'),'UTC');
  assert.equal(slots.length,8);
  const average=30/8;
  for(let i=1;i<slots.length;i++){
    const gap=(Date.parse(slots[i].at)-Date.parse(slots[i-1].at))/DAY;
    assert.ok(gap>=average*.7&&gap<=average*1.3,`${gap} days`);
  }
});

test('same-platform spacing varies deterministically from thirty to forty-five days',()=>{
  const values=Array.from({length:50},(_,i)=>samePlatformGapDays(`site-${i}`,'first','2026-09-01T10:11:00Z'));
  assert.ok(values.every(value=>value>=30&&value<=45));assert.ok(new Set(values).size>8);
  assert.equal(samePlatformGapDays('site-1','first','2026-09-01T10:11:00Z'),values[1]);
});

test('platform choice avoids a pairwise ninety-day overlap above one half when another channel is available',()=>{
  const events=[
    {id:'own',siteId:'site',channelId:'a',at:'2026-09-01T10:11:00Z',success:true},
    {id:'other-a',siteId:'other',channelId:'a',at:'2026-09-02T10:11:00Z',success:true},
    {id:'other-b',siteId:'other',channelId:'b',at:'2026-09-03T10:11:00Z',success:true},
  ];
  const base={siteId:'site',events,at:new Date('2026-10-20T10:11:00Z'),timeZone:'UTC',expectedMonthlyVolume:100,random:()=>0};
  assert.deepEqual(eligiblePlatforms({...base,platforms:[{id:'b'},{id:'c'}]}).map(value=>value.id),['b','c']);
  assert.equal(selectWeightedPlatform({...base,platforms:[{id:'b',linkQuality:100},{id:'c',linkQuality:1}]})?.id,'c');
  assert.equal(selectWeightedPlatform({...base,platforms:[{id:'b'}]})?.id,'b','a sole candidate remains usable');
});

test('lost links lower selection weight without erasing past publication quotas',()=>{
  const old=task('old','a');old.status='live';old.firstLiveAt='2026-07-01T10:11:00Z';old.scheduledAt=old.firstLiveAt;old.lostAt='2026-07-31T10:11:00Z';old.linkCheck='absent';
  const lost=scheduleEvents([old]),retained=scheduleEvents([{...old,lostAt:undefined,linkCheck:'found'}]);
  assert.equal(lost[0].success,true);assert.equal(lost[0].retained,false);assert.equal(retained[0].retained,true);
  const base={siteId:'site',platforms:[{id:'a'},{id:'b'}],at:new Date('2026-10-20T10:11:00Z'),timeZone:'UTC',expectedMonthlyVolume:10};
  const picks=(events:typeof lost)=>Array.from({length:100},(_,i)=>selectWeightedPlatform({...base,events,random:()=>i/100})?.id).filter(id=>id==='a').length;
  assert.ok(picks(lost)<picks(retained));
});

test('online hours keep fourteen compact local days and guide future publication hours',()=>{
  const settings:{timezone:string;onlineHours?:Array<{day:string;mask:number}>}={timezone:'Asia/Singapore'};
  const first=new Date('2026-10-01T07:10:00Z');
  assert.equal(recordOnlineHour(settings,first),true);assert.equal(recordOnlineHour(settings,new Date('2026-10-01T07:55:00Z')),false);
  for(let day=2;day<=16;day++)recordOnlineHour(settings,new Date(`2026-10-${String(day).padStart(2,'0')}T07:10:00Z`));
  assert.equal(settings.onlineHours?.length,14);assert.equal(settings.onlineHours?.[0].day,'2026-10-03');
  assert.equal(onlineHoursLast7Days(settings,new Date('2026-10-16T07:15:00Z')),7);
  const at=scheduleOnPreferredHour('2026-10-20','Asia/Singapore',settings.onlineHours,()=>0);
  assert.equal(Math.floor(schedulingMinute(at,'Asia/Singapore')/60),15);
});

test('seven-day missed count uses durable miss timestamps even after a task reason changes',()=>{
  const now=new Date('2026-10-20T12:00:00Z');
  assert.equal(missedPublicationsLast7Days([{missedPublicationAt:'2026-10-19T00:00:00Z'},{missedPublicationAt:'2026-10-12T00:00:00Z'},{}],now),1);
});

test('recovery quarantines ambiguous batch-five account sending, unknown and legacy reservation states',()=>{
  for(const stage of ['sending','request_unknown','reserved'] as const){
    const state=emptyState(),value=task(stage,'rant');state.sites=[site];state.tasks=[value];value.status='running';value.checkpoint='batch5_account_pending';
    value.batch5Registration={version:1,channelId:'rant',operationId:'example-operation',createdAt:'2026-10-01T00:00:00Z',stage};
    recoverInterrupted(state,new Date('2026-10-20T12:00:00Z'));
    assert.equal(value.status,'needs_input',stage);assert.equal(value.reasonCode,'submission_unknown',stage);assert.equal(value.checkpoint,'batch5_account_pending',stage);
  }
});

test('batch-five preparation exhaustion blocks seven days then permits a new schedulable task',()=>{
  const state=emptyState(),value=task('exhausted','first'),candidate=task('candidate'),first=channel('first');
  state.sites=[site];state.tasks=[value,candidate];value.status='needs_input';value.checkpoint='batch5_prepare_exhausted';value.updatedAt='2026-10-01T00:00:00Z';
  const matches=[{channel:first,score:1,reason:'fixture'}];
  assert.deepEqual(schedulableTaskMatches(state,candidate,matches,new Date('2026-10-07T23:59:59Z')),[]);
  assert.equal(schedulableTaskMatches(state,candidate,matches,new Date('2026-10-08T00:00:00Z')).length,1);
  assert.deepEqual(availableNetworkPlatforms(state,[first],new Date('2026-10-07T23:59:59Z')),[]);
  assert.equal(availableNetworkPlatforms(state,[first],new Date('2026-10-08T00:00:00Z')).length,1);
});

test('a channel recorded as failed on this task is excluded from the next platform choice',()=>{
  const state=emptyState(),candidate=task('candidate'),first=channel('first'),second=channel('second');state.sites=[site];state.tasks=[candidate];
  candidate.failedPlatformIds=['first'];
  assert.deepEqual(schedulableTaskMatches(state,candidate,[{channel:first,score:1,reason:'first'},{channel:second,score:1,reason:'second'}],new Date('2026-10-15T12:11:00Z')).map(item=>item.match.channel.id),['second']);
});
