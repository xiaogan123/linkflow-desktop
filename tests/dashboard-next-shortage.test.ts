import test from 'node:test';
import assert from 'node:assert/strict';
import {demoSnapshot} from '../src/ui/demo';
import {nextTask,platformShortage,siteState} from '../src/ui/dashboard-model';
import type {Site,Snapshot,Task} from '../src/shared/types';

const now=new Date('2026-10-20T04:00:00Z');
const base=():Task=>({...structuredClone(demoSnapshot.tasks[0]),siteId:'site-a',status:'queued',firstLiveAt:undefined,submittedAt:undefined,temporaryPage:undefined,recoveredAt:undefined,checkpoint:undefined,attempts:0} as Task);
const at=(id:string,scheduledAt:string,patch:Partial<Task>={})=>({...base(),id,scheduledAt,...patch}) as Task;

test('"下一条" is upcoming work: a skipped or failed task in the past never stands in for the next publication',()=>{
  // The real case: skipped by the user while an earlier submission was still waiting on the platform's result.
  const skipped=at('skipped','2026-10-14T16:57:08Z',{status:'skipped',reasonCode:'user_skipped',checkpoint:'betterthanhtml_publish_submitting',submittedAt:'2026-10-14T17:01:08Z',nextCheckAt:'2026-10-15T17:01:11Z'} as Partial<Task>);
  const failed=at('failed','2026-10-16T02:00:00Z',{status:'failed'});
  const upcoming=at('upcoming','2026-10-21T02:00:00Z');
  assert.equal(nextTask([skipped,failed,upcoming],now,'site-a')?.id,'upcoming');
  assert.equal(nextTask([skipped,failed],now,'site-a'),undefined);
  assert.equal(nextTask([upcoming],now,'other-site'),undefined);
  const running=at('running','2026-10-19T02:00:00Z',{status:'running'});
  assert.equal(nextTask([running,upcoming],now,'site-a')?.id,'running');
  // Due a few minutes ago and still waiting for the runner: that is the next one, not a later task.
  const due=at('due','2026-10-20T03:50:00Z');
  assert.equal(nextTask([due,upcoming],now,'site-a')?.id,'due');
  assert.equal(nextTask([at('stale','2026-10-19T20:00:00Z'),upcoming],now,'site-a')?.id,'upcoming');
});

test('"平台不够" counts what is already booked this month, so a site with its month planned is not short of platforms',()=>{
  const site={...structuredClone(demoSnapshot.sites[0]),id:'site-a',status:'ready',monthlyTarget:6,createdAt:'2026-08-01T00:00:00Z',timezone:undefined,planStatus:undefined} as Site;
  const data=(tasks:Task[],automaticPages:number)=>({...structuredClone(demoSnapshot),settings:{...demoSnapshot.settings,timezone:'UTC'},sites:[site],tasks,capacity:[{...structuredClone(demoSnapshot.capacity?.[0] ?? {}),siteId:'site-a',automaticPages}]}) as unknown as Snapshot;
  const booked=['21','23','25','27','29'].map(day=>at(`b${day}`,`2026-10-${day}T02:00:00Z`));
  // Six this month, five booked: one more is needed and two automatic platforms remain.
  assert.equal(platformShortage(site,data(booked,2),now),false);
  // Nothing booked yet: six needed, only two automatic platforms.
  assert.equal(platformShortage(site,data([],2),now),true);
  // The planner's own verdict wins, and a site still analysing has no shortage yet.
  assert.equal(platformShortage({...site,planStatus:{reasonCode:'platform_capacity'}} as Site,data(booked,2),now),true);
  assert.equal(platformShortage({...site,status:'analyzing'} as Site,data([],0),now),false);
  // A site whose articles have not been read yet is getting ready, not short of platforms.
  const unread=data([],0);unread.capacity=[{...unread.capacity![0],blockingReason:'topics_unknown'}];
  assert.equal(platformShortage(site,unread,now),false);assert.equal(siteState(site,unread,now),'准备中');
  assert.equal(siteState({...site,topicsError:'公开选题暂未取得'} as Site,unread,now),'读不到文章');
  const noPlatform=data([],0);noPlatform.capacity=[{...noPlatform.capacity![0],blockingReason:'no_automatic_channel'}];
  assert.equal(platformShortage(site,noPlatform,now),true);assert.equal(siteState(site,noPlatform,now),'平台不够');
});
