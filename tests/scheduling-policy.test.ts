import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState} from '../src/main/store';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {availableNetworkPlatforms,claimPublicationExecution,deferAiLimitedTasks,deferTaskSchedule,makePlan,nextTask,publicationExecutionAt,reflowQueuedSchedules,selectTaskPlatform,taskPlatformIdentityAvailable,scheduleEvents} from '../src/main/planner';
import {SCHEDULING_DEFAULTS,estimateDailyAiLimit,eligiblePlatforms,findDeferredReservation,importSpreadDays,isPublishingTime,monthlyCapacity,planMonthlyReservations,platformDailyLimit,publicationGate,randomScheduleOnDay,samePlatformGapDays,schedulingDay,schedulingMinute,seededSchedulingRandom,selectWeightedPlatform} from '../src/shared/scheduling';
import {medianPlatformJaccard,simulateNetworkSchedule} from '../src/shared/scheduling-simulation';
import type {Channel,Site,Task} from '../src/shared/types';
const STAMP='2026-09-01T00:00:00.000Z',DAY=86400000;
function site(id='site',monthlyTarget=4,createdAt='2026-08-01T00:00:00.000Z'):Site{return {id,domain:'example.com',url:'https://example.com',email:'owner@example.com',name:'Example',description:'Educational software guides',category:'software',language:'en',status:'ready',monthlyTarget,createdAt,topics:Array.from({length:20},(_,i)=>({url:`https://example.com/article-${i}`,discoveredAt:STAMP}))}}
function channel(id='telegraph'):Channel{return {id,name:'Example publisher',domain:'publisher.example',url:'https://publisher.example',submitUrl:'https://publisher.example/new',categories:['software'],languages:['en'],kind:'article',emailRequired:false,accountRequired:false,articleRequired:true,free:'yes',freeNote:'',automation:'api',quality:'B',qualityReason:'fixture',provenance:'built-in',rulesUrl:'https://publisher.example/rules',checkedAt:STAMP,notes:'',allowedHosts:['publisher.example'],enabled:true}}
function task(id='task',siteId='site',channelId='telegraph',at='2026-09-10T10:11:00.000Z'):Task{return {id,siteId,channelId,sourceDomain:channelId?'publisher.example':'',status:'queued',createdAt:STAMP,scheduledAt:at,updatedAt:STAMP,attempts:0,message:'fixture'}}
const platforms=Array.from({length:15},(_,i)=>({id:`platform-${i}`}));

test('import spread is clamped and first natural month only reserves one article',()=>{
  assert.deepEqual([1,20,100,1000].map(importSpreadDays),[3,3,15,21]);
  const values=Array.from({length:100},(_,i)=>site(`site-${i}`,8,STAMP)),slots=planMonthlyReservations(values,platforms,[],new Date(STAMP),'UTC');
  assert.equal(slots.length,100);assert.equal(new Set(slots.map(slot=>slot.siteId)).size,100);
  assert.ok(slots.every(slot=>slot.target===1&&slot.effectiveTarget===1&&slot.at>'2026-09-01T23:59:59Z'&&slot.at<'2026-09-17'));
});
test('a month-end import preserves its first-post spread across the natural-month boundary',()=>{
  const imported='2026-10-31T00:00:00.000Z',values=Array.from({length:100},(_,i)=>site(`month-end-${i}`,4,imported));
  assert.equal(planMonthlyReservations(values,platforms,[],new Date(imported),'UTC').length,0);
  const slots=planMonthlyReservations(values,platforms,[],new Date('2026-11-01T00:00:00Z'),'UTC');
  for(const value of values){const first=slots.filter(slot=>slot.siteId===value.id).sort((a,b)=>a.at.localeCompare(b.at))[0];assert.ok(first);assert.ok(first.at>='2026-11-01'&&first.at<'2026-11-16');}
});
test('one network platform union supplies the same scaling basis to sites with different capabilities',()=>{
  const state=emptyState();state.settings.timezone='UTC';state.sites=Array.from({length:100},(_,i)=>site(`capacity-${i}`,8));
  const all=platforms.map(platform=>channel(platform.id)),network=availableNetworkPlatforms(state,all);
  assert.equal(network.length,15);
  const constrained=makePlan(state,state.sites[0],[{channel:all[0],score:1,reason:'only local platform'}],new Date(STAMP),network);
  const ordinary=makePlan(state,state.sites[1],all.map(channel=>({channel,score:1,reason:'all local platforms'})),new Date(STAMP),network);
  assert.equal(state.sites[0].planStatus?.capacity,450);assert.equal(state.sites[1].planStatus?.capacity,450);
  assert.ok(constrained.length<=1);assert.ok(ordinary.length>=4&&ordinary.length<=5);assert.equal(state.sites[0].planStatus?.reasonCode,'platform_capacity');
});
test('monthly reservations cover separate month segments with real 72-hour minimum gaps',()=>{
  const value=site('stable-site',8),slots=planMonthlyReservations([value],platforms,[],new Date(STAMP),'UTC');
  assert.equal(slots.length,8);
  for(let index=1;index<slots.length;index++)assert.ok(Date.parse(slots[index].at)-Date.parse(slots[index-1].at)>=3*DAY);
  assert.deepEqual(planMonthlyReservations([value],platforms,[],new Date(STAMP),'UTC'),slots);
});
test('timezone scheduling observes local 09:00–23:00 and avoids exact hours across DST dates',()=>{
  for(const timeZone of ['Asia/Singapore','America/New_York','Europe/Berlin'])for(const day of ['2026-03-08','2026-10-25','2026-11-01']){
    const random=seededSchedulingRandom(timeZone+day);for(let i=0;i<30;i++){const at=randomScheduleOnDay(day,timeZone,random);assert.equal(schedulingDay(at,timeZone),day);assert.ok(isPublishingTime(at,timeZone));assert.notEqual(schedulingMinute(at,timeZone)%60,0);}
  }
});
test('capacity reduction uses a uniform ratio and stable largest remainders',()=>{
  const sites=Array.from({length:100},(_,i)=>site(`site-${i}`,8)),limited=monthlyCapacity(sites,platforms,new Date(STAMP),'UTC');
  assert.equal(limited.capacity,450);assert.equal([...limited.targets.values()].reduce((a,b)=>a+b),450);assert.deepEqual(new Set(limited.targets.values()),new Set([4,5]));
  assert.equal(estimateDailyAiLimit(100,4,30,100),44);
});
test('automatic planning stores only a day reservation and remains idempotent',()=>{
  const state=emptyState(),value=site();state.sites=[value];state.settings.timezone='UTC';
  const matches=platforms.map(p=>({channel:channel(p.id),score:1,reason:'fixture'}));
  const made=makePlan(state,value,matches,new Date(STAMP));assert.equal(made.length,4);
  assert.ok(made.every(item=>item.channelId===''&&item.sourceDomain===''&&!item.accountId&&item.scheduling?.version===1));
  assert.equal(makePlan(state,value,matches,new Date(STAMP)).length,0);
  const at=new Date(made[0].scheduledAt);assert.equal(nextTask(state,at,matches.map(m=>m.channel))?.id,made[0].id);
  const selected=selectTaskPlatform(state,made[0],matches,at);assert.ok(selected);assert.equal(made[0].channelId,selected.id);assert.ok(made[0].scheduling?.publicIdentity);
});
test('every platform obeys the default daily cap, including Telegraph, Gist and Nostr',()=>{
  for(const id of ['telegraph','github-gist','nostr','custom-publisher']){
    const result=eligiblePlatforms({siteId:'second',platforms:[{id}],events:[{id:'old',siteId:'first',channelId:id,at:'2026-09-10T09:11:00Z',success:true}],at:new Date('2026-09-10T22:11:00Z'),timeZone:'UTC',expectedMonthlyVolume:100});assert.deepEqual(result,[],id);
  }
  assert.equal(platformDailyLimit('blogger'),2);
});
test('an independent publication platform allows two sites but never a third',()=>{
  const base={siteId:'second',platforms:[{id:'blogger'}],events:[{id:'one',siteId:'first',channelId:'blogger',at:'2026-09-10T09:11:00Z',success:true}],at:new Date('2026-09-10T12:11:00Z'),timeZone:'UTC',expectedMonthlyVolume:100};
  assert.equal(eligiblePlatforms(base).length,1);assert.equal(eligiblePlatforms({...base,siteId:'third',events:[...base.events,{...base.events[0],id:'two',siteId:'second'}]}).length,0);
});
test('a public identity cannot move to another site even on a later date',()=>{
  const input={siteId:'second',platforms:[{id:'blogger',identity:'public-author'}],events:[{id:'old',siteId:'first',channelId:'blogger',identity:'public-author',at:'2026-08-01T10:11:00Z',success:true}],at:new Date('2026-09-10T12:11:00Z'),timeZone:'UTC',expectedMonthlyVolume:100};assert.deepEqual(eligiblePlatforms(input),[]);
});
test('same site and platform wait a stable 30–45 days, independent of natural month',()=>{
  const base={siteId:'site',platforms:[{id:'telegraph'}],events:[{id:'old',siteId:'site',channelId:'telegraph',at:'2026-08-20T10:11:00Z',success:true}],timeZone:'UTC',expectedMonthlyVolume:100};
  const gap=samePlatformGapDays('site','telegraph',base.events[0].at),allowed=new Date(Date.parse(base.events[0].at)+gap*DAY);
  assert.ok(gap>=30&&gap<=45);assert.equal(eligiblePlatforms({...base,at:new Date(allowed.getTime()-60000)}).length,0);assert.equal(eligiblePlatforms({...base,at:allowed}).length,1);
});
test('monthly platform quota uses actual publication evidence and an inflated plan cannot raise it',()=>{
  const actual=Array.from({length:3},(_,i)=>({id:`old-${i}`,siteId:`other-${i}`,channelId:'telegraph',at:`2026-09-0${i+1}T10:11:00Z`,success:true}));
  const input={siteId:'site',platforms:[{id:'telegraph'}],events:actual,at:new Date('2026-09-10T10:11:00Z'),timeZone:'UTC',expectedMonthlyVolume:10_000};
  assert.equal(eligiblePlatforms(input).length,0);
  const reservations=Array.from({length:100},(_,i)=>({id:`planned-${i}`,siteId:`planned-site-${i}`,channelId:`planned-platform-${i}`,at:'2026-09-20T10:11:00Z'}));
  const failures=reservations.map(event=>({...event,id:'failed-'+event.id,success:true,failed:true}));
  assert.equal(eligiblePlatforms({...input,events:[...actual,...reservations,...failures]}).length,0);
  const otherPublications=Array.from({length:12},(_,i)=>({id:`other-live-${i}`,siteId:`other-live-site-${i}`,channelId:`other-platform-${i%4}`,at:'2026-09-05T10:11:00Z',success:true}));
  assert.equal(eligiblePlatforms({...input,events:[...actual,...otherPublications],expectedMonthlyVolume:1}).length,1);
});
test('real failed tasks keep attempt pacing without inflating confirmed publication volume',()=>{
  const state=emptyState();state.settings.timezone='UTC';state.sites=[site('next-site')];
  const confirmed=Array.from({length:3},(_,i)=>{const value=task(`live-${i}`,`live-site-${i}`,'telegraph',`2026-09-0${i+1}T10:11:00Z`);value.status='live';value.firstLiveAt=value.scheduledAt;return value});
  const rejected=Array.from({length:12},(_,i)=>{const value=task(`failed-${i}`,`failed-site-${i}`,`other-platform-${i}`,'2026-09-09T10:11:00Z');value.status=i%2?'needs_input':'failed';value.reasonCode='platform_rejected';value.checkpoint='channel_wait';value.scheduling={version:1,month:'2026-09',slot:0,target:1,effectiveTarget:1,reschedules:0,attemptedAt:value.scheduledAt,nextPublishAt:'2026-09-09T11:41:00Z'};return value});
  state.tasks=[...confirmed,...rejected];const events=scheduleEvents(state.tasks,state);
  for(const value of events.filter(event=>event.id.startsWith('failed-'))){assert.equal(value.failed,true);assert.equal(value.submitted,false);assert.equal(value.attempted,true);assert.equal(value.success,false);}
  const input={siteId:'next-site',platforms:[{id:'telegraph'}],events,at:new Date('2026-09-10T10:11:00Z'),timeZone:'UTC',expectedMonthlyVolume:100_000};
  assert.equal(eligiblePlatforms(input).length,0);
  assert.equal(eligiblePlatforms({...input,platforms:[{id:'other-platform-0'}],at:new Date('2026-09-09T12:11:00Z')}).length,0);
  const pending=task('next','next-site','new-platform','2026-09-09T10:12:00Z');state.tasks.push(pending);
  assert.equal(publicationExecutionAt(state,pending,new Date(pending.scheduledAt)).toISOString(),'2026-09-09T11:41:00.000Z');
});
test('unknown submissions cannot increase another platform quota and keep their own potential publications reserved',()=>{
  const confirmed=Array.from({length:3},(_,i)=>{const value=task(`live-${i}`,`live-site-${i}`,'telegraph',`2026-09-0${i+1}T10:11:00Z`);value.status='live';value.firstLiveAt=value.scheduledAt;return value});
  const unknown=Array.from({length:12},(_,i)=>{const value=task(`unknown-${i}`,`unknown-site-${i}`,`other-platform-${i}`,'2026-09-05T10:11:00Z');value.status='needs_input';value.reasonCode='submission_unknown';value.checkpoint='submission_uncertain';value.submittedAt=value.scheduledAt;return value});
  const events=scheduleEvents([...confirmed,...unknown]);
  const input={siteId:'next-site',platforms:[{id:'telegraph'}],events,at:new Date('2026-09-10T10:11:00Z'),timeZone:'UTC',expectedMonthlyVolume:100_000};
  assert.equal(eligiblePlatforms(input).length,0);
  assert.equal(eligiblePlatforms({...input,events:scheduleEvents(unknown.slice(0,3).map(value=>({...value,channelId:'telegraph'})))}).length,0);
  const publishedHistory=unknown.map(value=>({...value,status:'failed' as const,reasonCode:'platform_rejected' as const,firstLiveAt:value.scheduledAt,submittedAt:undefined}));
  const historicalEvents=scheduleEvents(publishedHistory);assert.ok(historicalEvents.every(event=>event.success&&!event.failed));
  assert.equal(eligiblePlatforms({...input,events:[...scheduleEvents(confirmed),...historicalEvents]}).length,1);
});
test('four platforms honestly stop at twelve monthly publications while five can advance from fifteen to sixteen',()=>{
  const month=new Date(STAMP),sites=Array.from({length:100},(_,i)=>site(`bounded-site-${i}`,4));
  assert.equal(monthlyCapacity(sites,platforms.slice(0,4),month,'UTC').capacity,12);
  const history=(count:number)=>Array.from({length:count},(_,i)=>({id:`actual-${i}`,siteId:`actual-site-${i}`,channelId:`platform-${Math.floor(i/3)}`,at:`2026-09-0${i%3+1}T10:11:00Z`,success:true}));
  const input={siteId:'next-site',at:new Date('2026-09-10T10:11:00Z'),timeZone:'UTC',expectedMonthlyVolume:100_000};
  assert.equal(eligiblePlatforms({...input,platforms:platforms.slice(0,4),events:history(12)}).length,0);
  assert.equal(eligiblePlatforms({...input,platforms:platforms.slice(0,5),events:history(15)}).length,5);
});
test('weighted platform concentration is invariant to an inflated monthly plan',()=>{
  const events=[{id:'past',siteId:'past-site',channelId:'platform-0',at:'2026-09-01T10:11:00Z',success:true}];
  const input={siteId:'next-site',platforms:platforms.slice(0,5),events,at:new Date('2026-09-10T10:11:00Z'),timeZone:'UTC'};
  for(let i=0;i<20;i++){
    assert.equal(selectWeightedPlatform({...input,expectedMonthlyVolume:1,random:()=>i/20})?.id,selectWeightedPlatform({...input,expectedMonthlyVolume:100_000,random:()=>i/20})?.id);
  }
});

test('weighted selection respects hard gates before considering large quality weights',()=>{
  const chosen=selectWeightedPlatform({siteId:'site',platforms:[{id:'full',linkQuality:10000},{id:'available',linkQuality:1}],events:[{id:'old',siteId:'other',channelId:'full',at:'2026-09-10T10:11:00Z',success:true}],at:new Date('2026-09-10T11:11:00Z'),timeZone:'UTC',expectedMonthlyVolume:100,random:()=>0});assert.equal(chosen?.id,'available');
});
test('wake-up reschedules missed work twice and releases its third missed slot without publishing',()=>{
  const state=emptyState();state.settings.timezone='UTC';state.sites=[site()];const value=task('old','site','');state.tasks=[value];
  const first=new Date('2026-09-10T13:12:00Z');reflowQueuedSchedules(state,platforms.map(p=>channel(p.id)),first);assert.equal(value.scheduling?.reschedules,1);assert.ok(Date.parse(value.scheduledAt)>first.getTime()+12*3600000);
  const second=new Date(Date.parse(value.scheduledAt)+3*3600000);reflowQueuedSchedules(state,platforms.map(p=>channel(p.id)),second);assert.equal(value.scheduling?.reschedules,2);
  reflowQueuedSchedules(state,platforms.map(p=>channel(p.id)),new Date(Date.parse(value.scheduledAt)+3*3600000));assert.equal(value.status,'skipped');assert.equal(value.reasonCode,'schedule_missed');assert.equal(value.submittedAt,undefined);
});
test('wake-up never changes possible external writes or paused sites',()=>{
  const state=emptyState();state.settings.timezone='UTC';state.sites=[site()];const value=task();value.submittedAt=value.scheduledAt;value.checkpoint='submitting';state.tasks=[value];const original=structuredClone(value);
  assert.deepEqual(reflowQueuedSchedules(state,[],new Date('2026-09-20T10:11:00Z')),[]);assert.deepEqual(value,original);
  value.submittedAt=undefined;value.checkpoint=undefined;state.sites[0].status='paused';assert.deepEqual(reflowQueuedSchedules(state,[],new Date('2026-09-20T10:11:00Z')),[]);
});
test('AI exhaustion spreads legacy and new tasks into future capacity without midnight pile-up',()=>{
  const state=emptyState();state.settings.timezone='UTC';state.settings.dailyAiLimit=10;state.sites=Array.from({length:12},(_,i)=>site(`site-${i}`));state.tasks=state.sites.map((value,i)=>task(`task-${i}`,value.id,'','2026-09-10T10:11:00Z'));
  const result=deferAiLimitedTasks(state,platforms.map(p=>channel(p.id)),new Date('2026-09-10T12:11:00Z'));assert.equal(result.length,12);
  const counts=new Map<string,number>();for(const value of state.tasks){assert.ok(isPublishingTime(new Date(value.scheduledAt),'UTC'));assert.ok(value.scheduledAt>'2026-09-11');const day=schedulingDay(value.scheduledAt,'UTC');counts.set(day,(counts.get(day)??0)+1);assert.equal(value.reasonCode,'ai_daily_limit');assert.equal(value.nextCheckAt,value.scheduledAt);}
  assert.ok(counts.size>=3);assert.ok([...counts.values()].every(count=>count<=4));
});
test('content conflicts defer only the specified task with full 72-hour spacing and daily capacity',()=>{
  const state=emptyState();state.settings.timezone='UTC';state.settings.dailyAiLimit=10;
  state.sites=[site('site'),site('other')];
  const conflicted=task('conflicted','site',''),anchor=task('anchor','site','platform-0','2026-09-12T22:41:00Z');
  anchor.status='live';anchor.firstLiveAt=anchor.scheduledAt;
  const other=task('other','other','','2026-09-11T14:11:00Z');state.tasks=[conflicted,anchor,other];
  const preserved=structuredClone([anchor,other]),now=new Date('2026-09-10T12:11:00Z');
  const when=deferTaskSchedule(state,conflicted,platforms.map(value=>channel(value.id)),now,at=>schedulingDay(at,'UTC')>='2026-09-15');
  assert.ok(when);assert.equal(conflicted.scheduledAt,when.toISOString());assert.equal(conflicted.reasonCode,'diversity_deferred');
  assert.ok(when.getTime()-Date.parse(anchor.firstLiveAt!)>=3*DAY);assert.ok(isPublishingTime(when,'UTC'));
  assert.deepEqual([anchor,other],preserved);assert.equal(state.tasks.length,3);
});
test('single-task deferral obeys occupied network days and a caller predicate without unbounded retries',()=>{
  const now=new Date('2026-09-10T12:11:00Z'),events=Array.from({length:5},(_,i)=>({id:`busy-${i}`,siteId:`other-${i}`,at:`2026-09-${String(i+11).padStart(2,'0')}T12:11:00Z`}));
  const at=findDeferredReservation(site(),[{id:'platform-0'}],events,now,'UTC','single-task',undefined,date=>schedulingDay(date,'UTC')>='2026-09-16');
  assert.ok(at);assert.ok(schedulingDay(at,'UTC')>='2026-09-16');
  let calls=0;assert.equal(findDeferredReservation(site(),platforms,[],now,'UTC','reject-all',undefined,()=>{calls++;return false}),undefined);
  assert.ok(calls>0&&calls<=SCHEDULING_DEFAULTS.maxLookaheadDays);
  const state=emptyState();state.settings.timezone='UTC';state.sites=[site()];const value=task();state.tasks=[value];const before=structuredClone(value);
  assert.equal(deferTaskSchedule(state,value,platforms.map(p=>channel(p.id)),now,()=>false),undefined);assert.deepEqual(value,before);
  value.submittedAt=value.scheduledAt;value.checkpoint='submitting';const submitted=structuredClone(value);
  assert.equal(deferTaskSchedule(state,value,platforms.map(p=>channel(p.id)),now),undefined);assert.deepEqual(value,submitted);
});
test('a failed or unknown attempt still persists the global twenty-five to ninety minute interval',()=>{
  const state=emptyState();state.settings.timezone='UTC';state.sites=[site('first'),site('second')];const first=task('first','first'),second=task('second','second','github-gist');state.tasks=[first,second];const at=new Date('2026-09-10T10:11:00Z');
  assert.equal(claimPublicationExecution(state,first,at,()=>0),true);assert.equal(first.scheduling?.attemptedAt,at.toISOString());first.status='failed';
  assert.equal(publicationExecutionAt(state,second,at).toISOString(),'2026-09-10T10:36:00.000Z');assert.equal(claimPublicationExecution(state,second,at),false);
  first.scheduling!.nextPublishAt='2026-09-10T11:41:00Z';assert.equal(publicationExecutionAt(state,second,at).toISOString(),'2026-09-10T11:41:00.000Z');
});
test('legacy fixed-platform work is rechecked immediately before publish',()=>{
  const state=emptyState();state.settings.timezone='UTC';state.sites=[site('first'),site('second')];const old=task('old','first'),value=task('new','second');old.firstLiveAt='2026-09-10T09:11:00Z';old.status='live';state.tasks=[old,value];
  const at=new Date('2026-09-10T12:11:00Z');assert.ok(publicationExecutionAt(state,value,at).getTime()>at.getTime());assert.equal(selectTaskPlatform(state,value,[{channel:channel(),score:1,reason:'fixture'}],at),undefined);assert.ok(value.scheduledAt>'2026-09-11');
});
test('a fixed task without accountId cannot implicitly borrow a globally ready author bound to another site',()=>{
  const state=emptyState();state.sites=[site('owner'),site('other')];
  const selected=channel('agenthow'),accountId='shared-author';
  state.accounts=[{id:accountId,channelId:selected.id,email:'',username:'example-author',createdAt:STAMP,status:'registered',hasPassword:true,credentialKind:'api_token',source:'generated',agentHow:{version:1,stage:'ready',operationId:'example-registration',requestHash:'b'.repeat(64),actorId:'a_'+'a'.repeat(32),label:'example-author',keyFingerprint:'c'.repeat(64),checkedAt:STAMP}}];
  state.accountBindings=[{id:'owner-binding',siteId:'owner',channelId:selected.id,accountId,createdAt:STAMP,updatedAt:STAMP}];
  const pending=task('fixed','other',selected.id);state.tasks=[pending];const before=structuredClone(state);
  assert.equal(pending.accountId,undefined);assert.equal(channelExecutionReadiness(state,'owner',selected).kind,'ready');assert.equal(channelExecutionReadiness(state,'other',selected).kind,'autocreate');assert.equal(channelExecutionReadiness(state,'other',selected).account?.id,accountId);assert.equal(taskPlatformIdentityAvailable(state,pending,selected),false);assert.deepEqual(state,before);
  assert.equal(taskPlatformIdentityAvailable(state,{...pending,siteId:'owner'},selected),true);
  state.accounts.push({...state.accounts[0],id:'duplicate-local-record'});
  assert.equal(taskPlatformIdentityAvailable(state,{...pending,accountId:'duplicate-local-record'},selected),false);
});
test('an unclaimed automatic identity stays available for creation by its own site',()=>{
  const state=emptyState();state.sites=[site()];const selected=channel('agenthow'),pending=task('new','site',selected.id),before=structuredClone(state);
  assert.equal(taskPlatformIdentityAvailable(state,pending,selected),true);assert.deepEqual(state,before);
  state.accounts=[{id:'past-author',channelId:selected.id,email:'',username:'example-author',createdAt:STAMP,status:'registered',hasPassword:true,credentialKind:'api_token'}];
  const prior=task('prior','different-site',selected.id);prior.accountId='past-author';prior.firstLiveAt=prior.scheduledAt;prior.status='live';state.tasks=[prior,pending];
  assert.equal(taskPlatformIdentityAvailable(state,pending,selected),false);
});
test('legacy public identity ownership is derived from state without new metadata',()=>{
  const state=emptyState();state.settings.timezone='UTC';state.sites=[site('first'),site('second')];const accountId='example-account';state.accounts=[{id:accountId,channelId:'nostr',username:'a'.repeat(64),email:'',createdAt:STAMP,status:'registered',hasPassword:true,credentialKind:'api_token'}];
  const old=task('old','first','nostr','2026-07-01T10:11:00Z');old.accountId=accountId;old.status='live';old.firstLiveAt=old.scheduledAt;const value=task('new','second','nostr');value.accountId=accountId;state.tasks=[old,value];const at=new Date('2026-09-10T12:11:00Z');assert.ok(publicationExecutionAt(state,value,at).getTime()>=at.getTime()+300*DAY);
});
test('publication gate never authorizes a write during local quiet hours',()=>{
  for(const hour of [0,1,8,23]){const now=new Date(`2026-09-10T${String(hour).padStart(2,'0')}:11:00Z`),at=publicationGate(undefined,undefined,now,'UTC');assert.ok(at.getTime()>now.getTime());assert.ok(isPublishingTime(at,'UTC'));}
});
test('a late attempt and its saved interval cross midnight without shortening the wait',()=>{
  const gate=(attempt:string,saved:string|undefined,now:string)=>publicationGate(attempt,saved,new Date(now),'UTC').toISOString();
  assert.equal(gate('2026-09-10T22:30:00Z','2026-09-10T22:55:00Z','2026-09-10T22:59:00Z'),'2026-09-10T22:59:00.000Z');
  assert.equal(gate('2026-09-10T22:45:00Z','2026-09-10T23:10:00Z','2026-09-10T22:59:00Z'),'2026-09-11T09:01:00.000Z');
  assert.equal(gate('2026-09-10T22:45:00Z','2026-09-10T22:50:00Z','2026-09-10T22:59:00Z'),'2026-09-11T09:01:00.000Z');
  assert.equal(gate('2026-09-10T22:45:00Z','invalid','2026-09-10T22:59:00Z'),'2026-09-11T09:01:00.000Z');
  assert.equal(gate('2026-09-10T22:45:00Z','2026-09-10T23:10:00Z','2026-09-11T00:30:00Z'),'2026-09-11T09:01:00.000Z');
});
test('execution gate uses each site timezone across midnight and DST',()=>{
  const state=emptyState(),value=site('local-site',1);value.timezone='Asia/Singapore';state.sites=[value];state.settings.timezone='UTC';
  const queued=task('local-task',value.id,'telegraph','2026-09-09T10:11:00Z');state.tasks=[queued];
  assert.equal(publicationExecutionAt(state,queued,new Date('2026-09-10T14:59:00Z')).toISOString(),'2026-09-10T14:59:00.000Z');
  assert.equal(publicationExecutionAt(state,queued,new Date('2026-09-10T15:00:00Z')).toISOString(),'2026-09-11T01:01:00.000Z');
  assert.equal(claimPublicationExecution(state,queued,new Date('2026-09-10T15:00:00Z'),()=>0),false);
  assert.equal(publicationGate(undefined,undefined,new Date('2026-03-08T12:59:00Z'),'America/New_York').toISOString(),'2026-03-08T13:01:00.000Z');
  assert.equal(publicationGate(undefined,undefined,new Date('2026-11-01T13:00:00Z'),'America/New_York').toISOString(),'2026-11-01T14:01:00.000Z');
});
for(const monthlyTarget of [1,2,4,8])test(`100 sites × 3 months use the production scheduling policy, monthly target ${monthlyTarget}`,()=>{
  const sites=Array.from({length:100},(_,i)=>site(`site-${i}`,monthlyTarget,STAMP));const result=simulateNetworkSchedule(sites,platforms,new Date(STAMP),3,'UTC',`network-${monthlyTarget}`),{events}=result;
  assert.ok(events.length>=280);assert.equal(result.reserved,events.length+result.released);
  const platformDays=new Map<string,Set<string>>(),identityOwners=new Map<string,Set<string>>(),identityDays=new Map<string,number>(),monthCounts=new Map<string,number>(),platformMonths=new Map<string,number>(),bySitePlatform=new Map<string,number[]>();
  for(const event of events){
    const day=schedulingDay(event.at,'UTC'),month=day.slice(0,7);assert.ok(isPublishingTime(new Date(event.at),'UTC'));
    const key=event.channelId+'|'+day,set=platformDays.get(key)??new Set<string>();set.add(event.siteId);platformDays.set(key,set);assert.ok(set.size<=platformDailyLimit(event.channelId!));
    const owners=identityOwners.get(event.identity!)??new Set<string>();owners.add(event.siteId);identityOwners.set(event.identity!,owners);assert.equal(owners.size,1);
    const identityDay=event.identity+'|'+day;identityDays.set(identityDay,(identityDays.get(identityDay)??0)+1);assert.equal(identityDays.get(identityDay),1);
    monthCounts.set(month,(monthCounts.get(month)??0)+1);const platformMonth=event.channelId+'|'+month;platformMonths.set(platformMonth,(platformMonths.get(platformMonth)??0)+1);assert.ok(platformMonths.get(platformMonth)!<=Math.max(3,Math.floor(monthCounts.get(month)!*.25)));
    const sitePlatform=event.siteId+'|'+event.channelId,times=bySitePlatform.get(sitePlatform)??[];times.push(Date.parse(event.at));bySitePlatform.set(sitePlatform,times);
  }
  for(const [key,count] of platformMonths){const month=key.slice(-7);assert.ok(count<=Math.max(3,(monthCounts.get(month)??0)*.25),`${key}: ${count}/${monthCounts.get(month)}`);}
  for(const times of bySitePlatform.values())for(let i=1;i<times.length;i++)assert.ok(times[i]-times[i-1]>=30*DAY);
  assert.ok(events.filter(event=>schedulingDay(event.at,'UTC')==='2026-09-01').length<=10);
  for(const [month,total] of monthCounts){const days=month==='2026-10'?31:30;assert.ok(events.filter(event=>schedulingDay(event.at,'UTC')===month+'-01').length<=total/days*1.5);}
  assert.ok(medianPlatformJaccard(events,sites.map(value=>value.id))<=.35);
  for(let i=1;i<events.length;i++)assert.ok(Date.parse(events[i].at)-Date.parse(events[i-1].at)>=SCHEDULING_DEFAULTS.publishGapMinMinutes*60000);
});
