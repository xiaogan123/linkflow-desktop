import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS,matchChannels} from '../src/integrations/catalog';
import {emptyState} from '../src/main/store';
import {makePlan,markVerified,monthKey} from '../src/main/planner';
import type {Site,Task} from '../src/shared/types';

const now=new Date('2026-11-02T12:00:00.000Z');
const ids=['betterthanhtml','lucid-page','supanote'];
const channels=CHANNELS.filter(channel=>ids.includes(channel.id));
function fixture(count=6){
  const state=emptyState();state.settings.timezone='UTC';state.settings.autoRun=true;state.settings.articleReviewMode='ai';
  state.sites=Array.from({length:count},(_,i):Site=>({id:`study-${i}`,domain:`study-${i}.example`,url:`https://study-${i}.example`,email:'owner@example.com',name:'Original education',description:'Independent educational articles',category:'education',language:'en',monthlyTarget:2,articleReviewMode:'ai',status:'ready',createdAt:'2026-10-01T00:00:00.000Z',topics:Array.from({length:8},(_,n)=>({url:`https://study-${i}.example/lessons/topic-${n}`,discoveredAt:'2026-10-01T00:00:00.000Z'}))}));
  return state;
}
function plan(state:ReturnType<typeof fixture>,at=now){return state.sites.map(site=>makePlan(state,site,matchChannels(site,channels),at))}
function published(siteId:string,channelId:string,when=now.toISOString()):Task{
  const channel=channels.find(item=>item.id===channelId)!;
  return {id:`published-${siteId}-${channelId}`,siteId,channelId,sourceDomain:channel.domain,status:'live',createdAt:when,scheduledAt:when,updatedAt:when,firstLiveAt:when,publicUrl:`https://${channel.domain}/synthetic-${siteId}`,health:'healthy',linkCheck:'found',attempts:1,message:'Synthetic publication'};
}

test('equally relevant ready sources are shared across sites without changing existing reservations',()=>{
  const state=fixture(),matches=matchChannels(state.sites[0],channels);
  assert.equal(matches.length,3);assert.equal(new Set(matches.map(item=>item.score)).size,1);
  const rows=plan(state),counts=ids.map(id=>state.tasks.filter(task=>task.channelId===id).length);
  assert(rows.every(tasks=>tasks.length===2&&new Set(tasks.map(task=>task.sourceDomain)).size===2));
  assert.deepEqual(counts,[4,4,4]);
  assert.equal(new Set(rows.map(tasks=>tasks.map(task=>task.channelId).sort().join(','))).size,3);
  for(const tasks of rows)assert(Date.parse(tasks[1].scheduledAt)-Date.parse(tasks[0].scheduledAt)>=7*86400000);
  for(const id of ids){const dates=state.tasks.filter(task=>task.channelId===id).map(task=>Date.parse(task.scheduledAt)).sort((a,b)=>a-b);assert(dates.every((value,i)=>i===0||value-dates[i-1]>=86400000))}
  const before=structuredClone(state.tasks);assert(plan(state).every(tasks=>tasks.length===0));assert.deepEqual(state.tasks,before);
});

test('each site still visits its previously unused source before repeating next month',()=>{
  const state=fixture(),first=plan(state);
  const unused=first.map(tasks=>ids.find(id=>!tasks.some(task=>task.channelId===id))!);
  for(const task of state.tasks)markVerified(task,new Date(task.scheduledAt),`https://${task.sourceDomain}/synthetic-${task.siteId}`,'nofollow');
  const next=plan(state,new Date('2026-12-02T12:00:00.000Z'));
  assert(next.every((tasks,i)=>tasks.length===2&&tasks[0].channelId===unused[i]));
  assert(state.sites.every(site=>new Set(state.tasks.filter(task=>task.siteId===site.id).map(task=>task.channelId)).size===3));
});

test('source distribution never promotes a less relevant or unconnected candidate',()=>{
  const state=fixture(1),site=state.sites[0];site.monthlyTarget=1;
  state.tasks.push(published('other','betterthanhtml'));
  const matches=matchChannels(site,channels).map(item=>({...item,score:item.channel.id==='betterthanhtml'?100:90}));
  const gist=CHANNELS.find(channel=>channel.id==='github-gist')!;
  const made=makePlan(state,site,[{channel:gist,score:1000,reason:'No connected account'},...matches],now);
  assert.equal(made[0].channelId,'betterthanhtml');
});

test('disabled, overridden and original-task cooldown sources remain excluded',()=>{
  const state=fixture(1),site=state.sites[0];state.settings.channelOverrides.supanote=false;
  const blocked:Task={id:'cooldown',siteId:site.id,channelId:'betterthanhtml',sourceDomain:'betterthanhtml.com',status:'failed',checkpoint:'system_wait',recoveryEligible:true,recoveryAttempts:0,cost:{aiCalls:1},createdAt:now.toISOString(),scheduledAt:now.toISOString(),updatedAt:now.toISOString(),attempts:1,message:'Synthetic transient failure',nextCheckAt:'2026-11-03T12:00:00.000Z'};
  state.tasks.push(blocked);const before=structuredClone(blocked);
  const candidates=CHANNELS.filter(channel=>[...ids,'docs-md','rentry'].includes(channel.id));
  assert.deepEqual(makePlan(state,site,matchChannels(site,candidates),now).map(task=>task.channelId),['lucid-page']);
  assert.deepEqual(blocked,before);
});

test('monthly source preference counts distinct other sites, using the configured month and source aliases',()=>{
  const state=fixture(1),site=state.sites[0];site.monthlyTarget=1;state.settings.timezone='Asia/Singapore';
  const boundary=new Date('2026-10-31T18:00:00.000Z');assert.equal(monthKey(boundary,state.settings.timezone),'2026-11');
  const first=published('other-a','betterthanhtml',boundary.toISOString());first.sourceDomain='WWW.BetterThanHtml.com.';
  state.tasks.push(first,{...first,id:'duplicate-record'},published('other-b','lucid-page',boundary.toISOString()));
  const future=published('other-c','supanote','2026-12-01T00:00:00.000Z');delete future.firstLiveAt;delete future.publicUrl;future.status='queued';
  const expired=published('other-d','supanote','2026-10-01T00:00:00.000Z');
  const skipped={...published('other-e','supanote'),status:'skipped' as const,checkpoint:'existing_link'};
  state.tasks.push(future,expired,skipped);
  assert.equal(makePlan(state,site,matchChannels(site,channels),boundary)[0].channelId,'supanote');
});
