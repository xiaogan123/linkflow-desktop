import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS,matchChannels} from '../src/integrations/catalog';
import {emptyState} from '../src/main/store';
import {makePlan,markVerified,monthKey,selectTaskPlatform,availableNetworkPlatforms} from '../src/main/planner';
import type {Site,Task} from '../src/shared/types';

const now=new Date('2026-11-02T12:00:00.000Z');
const ids=['betterthanhtml','lucid-page','supanote','telegraph'];
const channels=CHANNELS.filter(channel=>ids.includes(channel.id));
function fixture(count=6){
  const state=emptyState();state.settings.timezone='UTC';state.settings.autoRun=true;state.settings.articleReviewMode='ai';
  state.sites=Array.from({length:count},(_,i):Site=>({id:`study-${i}`,domain:`study-${i}.example`,url:`https://study-${i}.example`,email:'owner@example.com',name:'Original education',description:'Independent educational articles',category:'education',language:'en',monthlyTarget:2,articleReviewMode:'ai',status:'ready',createdAt:'2026-10-01T00:00:00.000Z',topics:Array.from({length:8},(_,n)=>({url:`https://study-${i}.example/lessons/topic-${n}`,discoveredAt:'2026-10-01T00:00:00.000Z'}))}));
  return state;
}
function plan(state:ReturnType<typeof fixture>,at=now){return state.sites.map(site=>makePlan(state,site,matchChannels(site,channels),at,availableNetworkPlatforms(state,channels)))}
function published(siteId:string,channelId:string,when=now.toISOString()):Task{
  const channel=channels.find(item=>item.id===channelId)!;
  return {id:`published-${siteId}-${channelId}`,siteId,channelId,sourceDomain:channel.domain,status:'live',createdAt:when,scheduledAt:when,updatedAt:when,firstLiveAt:when,publicUrl:`https://${channel.domain}/synthetic-${siteId}`,health:'healthy',linkCheck:'found',attempts:1,message:'Synthetic publication'};
}

test('equally relevant ready sources are shared across sites without changing existing reservations',()=>{
  const state=fixture(),rows=plan(state);assert.ok(rows.every(tasks=>tasks.length===2&&tasks.every(task=>task.channelId==='')));for(const tasks of rows)assert.ok(Date.parse(tasks[1].scheduledAt)-Date.parse(tasks[0].scheduledAt)>=3*86400000);const before=structuredClone(state.tasks);assert.ok(plan(state).every(tasks=>tasks.length===0));assert.deepEqual(state.tasks,before);for(const task of [...state.tasks].sort((a,b)=>a.scheduledAt.localeCompare(b.scheduledAt))){const requested=task.scheduledAt,selected=selectTaskPlatform(state,task,matchChannels(state.sites.find(site=>site.id===task.siteId)!,channels),new Date(requested));if(selected)markVerified(task,new Date(requested),`https://${task.sourceDomain}/synthetic-${task.siteId}-${task.id}`,'nofollow');else{assert.equal(task.reasonCode,'platform_capacity');assert.ok(task.scheduledAt>requested);assert.equal(task.submittedAt,undefined);}}assert.ok(new Set(state.tasks.filter(task=>task.firstLiveAt).map(task=>task.channelId)).size>=2);assert.equal(state.tasks.length,12);
});

test('new-month platform selection respects thirty days and preserves prior publication history',()=>{
  const state=fixture(1);plan(state);for(const task of state.tasks){const selected=selectTaskPlatform(state,task,matchChannels(state.sites[0],channels),new Date(task.scheduledAt));assert.ok(selected);markVerified(task,new Date(task.scheduledAt),`https://${task.sourceDomain}/synthetic-${task.id}`,'nofollow');}const old=structuredClone(state.tasks),next=plan(state,new Date('2026-12-02T12:00:00Z'));assert.equal(next[0].length,2);assert.ok(next[0].every(task=>!task.channelId));for(const task of next[0]){const selected=selectTaskPlatform(state,task,matchChannels(state.sites[0],channels),new Date(task.scheduledAt));assert.ok(selected);const prior=old.find(item=>item.channelId===selected.id);if(prior)assert.ok(Date.parse(task.scheduledAt)-Date.parse(prior.firstLiveAt!)>=30*86400000);}assert.deepEqual(state.tasks.slice(0,old.length),old);
});

test('weighted source selection excludes unconnected and ineligible candidates',()=>{
  const state=fixture(1),site=state.sites[0];site.monthlyTarget=1;const gist=CHANNELS.find(channel=>channel.id==='github-gist')!,matches=[{channel:gist,score:1000,reason:'No connected account'},...matchChannels(site,channels)];const [task]=makePlan(state,site,matches,now);assert.equal(task.channelId,'');const selected=selectTaskPlatform(state,task,matches,new Date(task.scheduledAt));assert.ok(selected);assert.notEqual(selected.id,'github-gist');
});

test('disabled, overridden and original-task cooldown sources remain excluded',()=>{
  const state=fixture(1),site=state.sites[0];site.monthlyTarget=1;state.settings.channelOverrides.supanote=false;const blocked:Task={id:'cooldown',siteId:site.id,channelId:'betterthanhtml',sourceDomain:'betterthanhtml.com',status:'failed',checkpoint:'system_wait',recoveryEligible:true,recoveryAttempts:0,cost:{aiCalls:1},createdAt:now.toISOString(),scheduledAt:now.toISOString(),updatedAt:now.toISOString(),attempts:1,message:'Synthetic transient failure',nextCheckAt:'2026-12-03T12:00:00Z'},before=structuredClone(blocked);state.tasks=[blocked];const candidates=CHANNELS.filter(channel=>['betterthanhtml','lucid-page','supanote','docs-md','rentry'].includes(channel.id)).map(channel=>channel.id==='docs-md'?{...channel,enabled:false}:channel),matches=matchChannels(site,candidates),[task]=makePlan(state,site,matches,now);assert.ok(task);assert.equal(selectTaskPlatform(state,task,matches,new Date(task.scheduledAt))?.id,'lucid-page');assert.deepEqual(blocked,before);
});

test('configured local day excludes busy platforms before random selection',()=>{
  const state=fixture(1),site=state.sites[0];site.monthlyTarget=1;state.settings.timezone='Asia/Singapore';const boundary=new Date('2026-10-31T18:11:00Z');assert.equal(monthKey(boundary,state.settings.timezone),'2026-11');state.tasks=[published('other-a','betterthanhtml',boundary.toISOString()),published('other-b','lucid-page',boundary.toISOString())];const available=channels.filter(channel=>channel.id!=='telegraph'),matches=matchChannels(site,available),[task]=makePlan(state,site,matches,boundary);assert.ok(task);assert.equal(task.channelId,'');const selected=selectTaskPlatform(state,task,matches,boundary);assert.equal(selected?.id,'supanote');
});
