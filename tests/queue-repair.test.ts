import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState} from '../src/main/store';
import {makePlan,selectTaskPlatform} from '../src/main/planner';
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
