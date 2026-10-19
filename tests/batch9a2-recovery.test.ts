import test from 'node:test';
import assert from 'node:assert/strict';
import {applyLinkResult,scheduleEvents} from '../src/main/planner';
import {publicationCounts,reservesMonthlySlot} from '../src/shared/publication';
import {planMonthlyReservations} from '../src/shared/scheduling';
import type {Site,Task} from '../src/shared/types';

const now=new Date('2026-10-19T12:00:00.000Z');
const createdAt='2026-10-01T00:00:00.000Z';
const site:Site={id:'site',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Guides',category:'content',language:'en',status:'ready',monthlyTarget:1,createdAt:'2026-08-01T00:00:00.000Z'};
function task(extra:Partial<Task>={}):Task{return {id:'task',siteId:site.id,channelId:'fixture',sourceDomain:'platform.example.com',status:'expired',createdAt,scheduledAt:createdAt,updatedAt:createdAt,attempts:1,message:'fixture',publicUrl:'https://platform.example.com/post',...extra}}
const result={found:true,outcome:'found' as const,url:'https://platform.example.com/post',rel:'follow',reason:'fixture',reasonCode:'link_found' as const,indexable:true};

test('b9a2 historical first-live fallback follows submitted, attempted, created, and never exceeds now',()=>{
  const attemptedAt='2026-10-03T00:00:00.000Z',submittedAt='2026-10-05T00:00:00.000Z';
  const scheduling={version:1 as const,month:'2026-10',slot:0,target:1,effectiveTarget:1,reschedules:0,attemptedAt};
  for(const [extra,expected] of [
    [{submittedAt,scheduling},submittedAt],
    [{scheduling},attemptedAt],
    [{},createdAt],
    [{submittedAt:'2026-11-01T00:00:00.000Z'},now.toISOString()],
  ] as Array<[Partial<Task>,string]>){
    const value=task(extra);applyLinkResult(value,result,now);
    assert.equal(value.firstLiveAt,expected);assert.equal(value.recoveredAt,now.toISOString());assert.equal(value.status,'live');
  }
});

test('b9a2 a recovered page from this month counts only as currently valid and leaves a monthly slot',()=>{
  const value=task({submittedAt:'2026-10-05T00:00:00.000Z'});applyLinkResult(value,result,now);
  assert.deepEqual(publicationCounts(site.id,[value],now,'UTC'),{currentPages:1,currentSources:1,monthlyPages:0,monthlySources:0});
  assert.equal(reservesMonthlySlot(value,now,'UTC'),false);
  const events=scheduleEvents([value]);assert.equal(events[0].recovered,true);assert.equal(events[0].supplementary,true);
  const reservations=planMonthlyReservations([site],[{id:'other'}],events,now,'UTC');
  assert.equal(reservations.length,1);assert.equal(reservations[0].siteId,site.id);
});
