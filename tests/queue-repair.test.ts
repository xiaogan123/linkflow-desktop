import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState} from '../src/main/store';
import {deferAiLimitedTasks,makePlan,nextTask,reflowQueuedSchedules,selectTaskPlatform} from '../src/main/planner';
import {dueLinkChecks} from '../src/main/link-maintenance';
import {onlineThroughout,recordOnlineHour} from '../src/shared/runtime-hours';
import {isEmptyReservation,repairQueueOnce} from '../src/main/queue-repair';
import {validateBackup} from '../src/main/backup-validation';
import {CHANNELS} from '../src/integrations/catalog';
import type {Channel,Site,Task} from '../src/shared/types';

const fixed='2026-10-05T06:00:00.000Z',siteId='11111111-1111-4111-8111-111111111111';
const lucid=():Channel=>({...CHANNELS.find(item=>item.id==='lucid-page')!,enabled:true});
const site=(extra:Partial<Site>={}):Site=>({id:siteId,domain:'example.test',url:'https://example.test/',email:'owner@example.test',name:'Example',description:'Guides',category:'content',language:'en',monthlyTarget:2,articleReviewMode:'ai',status:'ready',createdAt:'2026-08-01T00:00:00.000Z',analyzedAt:'2026-08-01T00:00:00.000Z',topicsCheckedAt:fixed,topics:Array.from({length:30},(_,index)=>({url:`https://example.test/guides/${index}`,discoveredAt:fixed})),...extra});
const reservation=(id:string,scheduledAt:string,extra:Partial<Task>={}):Task=>({id,siteId,channelId:'',sourceDomain:'',status:'queued',createdAt:fixed,scheduledAt,updatedAt:fixed,attempts:0,message:'fixture',...extra});

test('work pushed into a later month keeps its place, so the planner cannot refill the month every minute',()=>{
  const state=emptyState();state.settings.timezone='UTC';state.sites=[site()];
  const channel=lucid(),matches=[{channel,score:1,reason:'fixture'}];
  for(let minute=0;minute<30;minute++){
    const now=new Date(Date.parse(fixed)+minute*60000);
    for(const task of makePlan(state,state.sites[0],matches,now)){
      // An AI-limited day pushes each reservation past the current month, weeks apart when the network is full.
      task.scheduledAt=new Date(Date.parse('2026-11-20T09:00:00.000Z')+minute*7*86400000).toISOString();task.reasonCode='ai_daily_limit';
    }
  }
  assert.ok(state.tasks.length>=1);
  assert.ok(state.tasks.length<=2,`created ${state.tasks.length} reservations`);
});

test('a task pushed out in an earlier month never reduces a later month',()=>{
  const state=emptyState();state.settings.timezone='UTC';state.sites=[site({monthlyTarget:1})];
  state.tasks=[{...reservation('22222222-2222-4222-8222-222222222222','2027-03-01T01:00:00.000Z',{createdAt:'2026-09-20T01:00:00.000Z'}),draft:{title:'T',description:'D',body:'B'}}];
  const created=makePlan(state,state.sites[0],[{channel:lucid(),score:1,reason:'fixture'}],new Date(fixed));
  assert.equal(created.length,1);
});

test('a due reservation with no usable platform looks again tomorrow instead of parking a year out',()=>{
  const state=emptyState();state.settings.timezone='UTC';state.sites=[site()];
  const now=new Date(fixed),task=reservation('33333333-3333-4333-8333-333333333333',fixed);state.tasks=[task];
  assert.equal(selectTaskPlatform(state,task,[],now),undefined);
  assert.equal(task.reasonCode,'platform_capacity');assert.equal(Date.parse(task.scheduledAt),now.getTime()+86400000);
});

test('queue repair keeps the month target, deletes empty surplus, and leaves any task holding work alone',()=>{
  const state=emptyState();state.queueRepair=undefined;state.settings.timezone='UTC';state.sites=[site()];
  const now=new Date('2026-11-01T06:00:00.000Z');
  const drafted=reservation('22222222-2222-4222-8222-222222222222','2027-03-01T01:00:00.000Z',{draft:{title:'T',description:'D',body:'B'}});
  state.tasks=[
    ...['a','b','c','d'].map((tag,index)=>reservation(`${tag.repeat(8)}-1111-4111-8111-111111111111`,`2026-11-${String(index+1).padStart(2,'0')}T09:00:00.000Z`)),
    reservation('e'.repeat(8)+'-1111-4111-8111-111111111111','2027-10-31T01:00:00.000Z',{reasonCode:'ai_daily_limit'}),
    drafted,
  ];
  assert.equal(isEmptyReservation(drafted),false);
  assert.deepEqual(repairQueueOnce(state,[],now),{restored:0,removed:3});
  assert.equal(state.tasks.length,3);assert.ok(state.tasks.some(task=>task.id===drafted.id));
  assert.equal(state.queueRepair,1);
  state.tasks.push(reservation('f'.repeat(8)+'-1111-4111-8111-111111111111','2027-10-31T01:00:00.000Z'));
  assert.equal(repairQueueOnce(state,[],now),undefined);assert.equal(state.tasks.length,4);
});

test('the repair flag survives strict backup validation',()=>{
  const state=emptyState();state.queueRepair=1;
  assert.equal(emptyState().queueRepair,1);
  assert.equal(validateBackup({version:1,exportedAt:fixed,state,secrets:{}} as never).state.queueRepair,1);
});

const drafted=(extra:Partial<Task>={}):Task=>reservation('44444444-4444-4444-8444-444444444444','2026-10-05T09:30:00.000Z',{channelId:'katbin',sourceDomain:'katb.in',draft:{title:'T',description:'D',body:'B'},articleApprovedAt:fixed,cost:{aiCalls:2,amount:0},scheduling:{version:1,month:'2026-10',slot:0,target:2,effectiveTarget:2,reschedules:2},...extra});
const reflowState=(...tasks:Task[])=>{const state=emptyState();state.settings.timezone='UTC';state.settings.autoRun=true;state.sites=[site(),site({id:'55555555-5555-4555-8555-555555555555',domain:'other.test',url:'https://other.test/'})];state.tasks=tasks;return state};
const otherSitePost=(at:string,id='66666666-6666-4666-8666-666666666666')=>reservation(id,at,{siteId:'55555555-5555-4555-8555-555555555555',channelId:'katbin',sourceDomain:'katb.in',status:'live',submittedAt:at,firstLiveAt:at,scheduling:{version:1,month:'2026-10',slot:0,target:2,effectiveTarget:2,reschedules:0,attemptedAt:at}});
const once=(reschedules:number)=>({scheduling:{version:1 as const,month:'2026-10',slot:0,target:2,effectiveTarget:2,reschedules}});

test('a ready task waiting only on the gate keeps its place without a miss, even behind a queue of others',()=>{
  // Due at 09:30; another site took katbin's daily slot at 09:40, after this task's time.
  const held=drafted(once(1)),queued=drafted({...once(0),id:'88888888-8888-4888-8888-888888888888',scheduledAt:'2026-10-05T09:20:00.000Z'}),state=reflowState(held,queued,otherSitePost('2026-10-05T09:40:00.000Z'));
  for(let minute=0;minute<=24*60;minute+=15){const at=new Date(Date.parse('2026-10-05T09:31:00.000Z')+minute*60000);recordOnlineHour(state.settings,at);reflowQueuedSchedules(state,[lucid()],at)}
  assert.equal(held.status,'queued');assert.equal(held.scheduling?.reschedules,1);assert.equal(held.scheduledAt,'2026-10-05T09:30:00.000Z');
  assert.equal(queued.scheduling?.reschedules,0);assert.equal(queued.scheduledAt,'2026-10-05T09:20:00.000Z');
  assert.equal(nextTask(state,new Date('2026-10-06T10:07:00.000Z'),[lucid()])?.id,queued.id);
});

const online=(state:ReturnType<typeof reflowState>,from:string,to:Date)=>{for(let at=Date.parse(from);at<=to.getTime();at+=15*60000)recordOnlineHour(state.settings,new Date(at));recordOnlineHour(state.settings,to);return state};

test('online hours: a gap means the app was closed, and the hour the check runs in counts as online',()=>{
  const settings={timezone:'UTC',onlineHours:[] as {day:string;mask:number}[]};
  for(const hour of ["09","10","11"])recordOnlineHour(settings,new Date(`2026-10-05T${hour}:30:00.000Z`));
  assert.equal(onlineThroughout(settings,new Date('2026-10-05T09:00:00.000Z'),new Date('2026-10-05T12:00:10.000Z')),true);
  assert.equal(onlineThroughout(settings,new Date('2026-10-05T08:30:00.000Z'),new Date('2026-10-05T12:00:10.000Z')),false);
  settings.onlineHours=settings.onlineHours.map(record=>({...record,mask:record.mask&~(1<<10)}));
  assert.equal(onlineThroughout(settings,new Date('2026-10-05T09:00:00.000Z'),new Date('2026-10-05T12:00:10.000Z')),false);
});

test('work missed while the app was closed is spread out again, and a month boundary moves it into the new month',()=>{
  const closed=drafted(once(0));reflowQueuedSchedules(reflowState(closed),[lucid()],new Date('2026-10-05T12:00:00.000Z'));
  assert.equal(closed.scheduling?.reschedules,1);assert.equal(closed.reasonCode,'schedule_missed');assert.ok(closed.scheduledAt>'2026-10-06');
  const late=drafted({...once(0),scheduledAt:'2026-10-31T22:00:00.000Z'}),now=new Date('2026-11-01T01:00:00.000Z');reflowQueuedSchedules(online(reflowState(late),late.scheduledAt,now),[lucid()],now);
  assert.equal(late.scheduling?.reschedules,1);assert.equal(late.scheduling?.month,'2026-11');assert.ok(late.scheduledAt>'2026-11-01');
});

test('a task that cannot run, or has waited for days, is an ordinary miss while other sites keep publishing',()=>{
  const now=new Date('2026-10-05T12:00:00.000Z');
  const blocked=drafted({...once(1),reasonCode:'human_timeout'});reflowQueuedSchedules(online(reflowState(blocked,otherSitePost('2026-10-05T11:50:00.000Z')),blocked.scheduledAt,now),[lucid()],now);
  assert.equal(blocked.scheduling?.reschedules,2);assert.equal(blocked.reasonCode,'schedule_missed');
  const away=drafted(once(1));reflowQueuedSchedules(reflowState(away,otherSitePost('2026-10-05T09:10:00.000Z')),[lucid()],new Date('2026-10-28T07:00:00.000Z'));
  assert.equal(away.scheduling?.reschedules,2);assert.equal(away.reasonCode,'schedule_missed');
});

test('a written draft is moved when its reschedules run out, until it was approved a month ago; an empty reservation is released',()=>{
  const now=new Date('2026-10-09T12:00:00.000Z');
  const paid=drafted({createdAt:'2026-09-01T06:00:00.000Z'});reflowQueuedSchedules(reflowState(paid),[lucid()],now);
  assert.equal(paid.status,'queued');assert.equal(paid.draft?.title,'T');assert.ok(Date.parse(paid.scheduledAt)>now.getTime());assert.equal(paid.scheduling?.reschedules,2);
  const stale=drafted({createdAt:'2026-09-01T06:00:00.000Z',articleApprovedAt:'2026-09-02T06:00:00.000Z'});reflowQueuedSchedules(reflowState(stale),[lucid()],now);
  assert.equal(stale.status,'skipped');assert.equal(stale.checkpoint,'schedule_exhausted');assert.equal(stale.draft?.title,'T');
  const empty=drafted({draft:undefined,articleApprovedAt:undefined,cost:undefined,channelId:'',sourceDomain:''});reflowQueuedSchedules(reflowState(empty),[lucid()],now);
  assert.equal(empty.status,'skipped');assert.equal(empty.checkpoint,'schedule_exhausted');
});

test('when the daily AI limit is reached, work still waiting from an earlier day is moved too, so it is not retried every minute',()=>{
  const now=new Date('2026-10-06T12:00:00.000Z'),waiting=drafted(once(0));const state=reflowState(waiting);
  assert.equal(deferAiLimitedTasks(state,[lucid()],now).length,1);
  assert.equal(waiting.reasonCode,'ai_daily_limit');assert.ok(Date.parse(waiting.scheduledAt)>now.getTime());
});

test('a known TheThings page keeps its daily read-only check after the first three attempts, for 30 days',()=>{
  const state=emptyState();state.sites=[site()];const submitted='2026-10-27T04:51:00.000Z';
  const page=reservation('77777777-7777-4777-8777-777777777777',submitted,{channelId:'thethings',sourceDomain:'thethings.ai',status:'needs_input',reasonCode:'submission_unknown',submittedAt:submitted,publicUrl:'https://thethings.ai/p/scratch/abc',reconcileAttempts:3,lastCheckedAt:submitted,theThings:{stage:'api_receipt'} as Task['theThings']});
  state.tasks=[page];
  assert.deepEqual(dueLinkChecks(state,new Date('2026-11-02T12:00:00.000Z'),3,[]).map(task=>task.id),[page.id]);
  assert.deepEqual(dueLinkChecks(state,new Date('2026-12-01T12:00:00.000Z'),3,[]),[]);
  page.status='skipped';
  assert.deepEqual(dueLinkChecks(state,new Date('2026-11-02T12:00:00.000Z'),3,[]),[]);
  page.status='needs_input';page.channelId='katbin';
  assert.deepEqual(dueLinkChecks(state,new Date('2026-11-02T12:00:00.000Z'),3,[]),[]);
});
