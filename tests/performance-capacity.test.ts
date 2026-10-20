import assert from 'node:assert/strict';
import test from 'node:test';
import {CHANNELS,matchChannels} from '../src/integrations/catalog';
import {availableNetworkPlatforms,capacityFor,capacitySnapshotIndex,channelLinkQuality} from '../src/main/planner';
import {SCHEDULING_DEFAULTS} from '../src/shared/scheduling';
import {publicationOpportunity} from '../src/shared/publication';
import {emptyState} from '../src/main/store';
import type {Site,Task} from '../src/shared/types';

const stamp='2026-10-17T00:00:00.000Z';
function site(index:number):Site{return {id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,domain:`capacity-${index}.example.test`,url:`https://capacity-${index}.example.test/`,email:`owner-${index}@example.test`,name:`Capacity ${index}`,description:'Fixture',category:'developer',language:'en',monthlyTarget:3,status:'ready',createdAt:stamp,analyzedAt:stamp,qualifications:{developer:'fixture'}}}
function task(id:string,siteId:string,channelId:string,sourceDomain:string,extra:Partial<Task>={}):Task{return {id,siteId,channelId,sourceDomain,status:'queued',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',health:'pending',history:[],cost:{aiCalls:0},...extra}}

test('capacity snapshot index is identical to the full-state calculation with cross-site source occupancy',()=>{
  const state=emptyState(),sites=[site(0),site(1),site(2)];state.sites=sites;state.settings.timezone='UTC';
  state.tasks=[
    task('10000000-0000-4000-8000-000000000000',sites[0].id,'telegraph','telegra.ph'),
    task('10000000-0000-4000-8000-000000000001',sites[1].id,'telegraph','telegra.ph',{status:'live',publicUrl:'https://example.test/one',firstLiveAt:stamp,verifiedAt:stamp,lastCheckedAt:stamp,linkCheck:'found',publicationMethod:'client'}),
    task('10000000-0000-4000-8000-000000000002',sites[2].id,'github-gist','gist.github.com',{status:'failed'}),
  ];
  const now=new Date(stamp),index=capacitySnapshotIndex(state,now,'UTC');
  for(const current of sites){const matches=matchChannels(current,CHANNELS);assert.deepEqual(capacityFor(current,state.tasks,matches,CHANNELS,now,'UTC',state),capacityFor(current,state.tasks,matches,CHANNELS,now,'UTC',state,index));}
});

test('one network platform list computed for many sites gives the same capacity as computing it per site',()=>{
  const state=emptyState(),sites=[site(0),site(1),site(2)];state.sites=sites;state.settings.timezone='UTC';
  state.tasks=[task('10000000-0000-4000-8000-000000000010',sites[1].id,'telegraph','telegra.ph',{status:'live',publicUrl:'https://example.test/two',firstLiveAt:stamp,verifiedAt:stamp,lastCheckedAt:stamp,linkCheck:'found',publicationMethod:'client'})];
  const now=new Date(stamp),network=availableNetworkPlatforms(state,CHANNELS,now);
  for(const current of sites){const matches=matchChannels(current,CHANNELS);assert.deepEqual(capacityFor(current,state.tasks,matches,CHANNELS,now,'UTC',state,undefined,network),capacityFor(current,state.tasks,matches,CHANNELS,now,'UTC',state));}
});

test('capacity uses the scheduler\'s first-month target, so a new site with its first page booked is not reported short',()=>{
  const state=emptyState(),fresh=site(0);state.sites=[fresh];state.settings.timezone='UTC';
  state.tasks=[task('10000000-0000-4000-8000-000000000020',fresh.id,'telegraph','telegra.ph',{scheduledAt:'2026-10-20T00:00:00.000Z'})];
  const capacity=capacityFor(fresh,state.tasks,matchChannels(fresh,CHANNELS),CHANNELS,new Date(stamp),'UTC',state);
  assert.equal(capacity.blockingReason,undefined);assert.equal(capacity.reason,undefined);
});

test('topic choice follows a replaced topic list and a changed site address, never a stale cached one',()=>{
  const channel=CHANNELS.find(item=>item.id==='telegraph')!,now=new Date(stamp),current={...site(0),topics:[{url:'https://capacity-0.example.test/guides/first-article/',title:'First article',discoveredAt:stamp}]} as Site;
  assert.equal(publicationOpportunity(current,channel,[],now,'UTC').topicUrl,'https://capacity-0.example.test/guides/first-article');
  current.topics=[{url:'https://capacity-0.example.test/guides/second-article/',title:'Second article',discoveredAt:stamp}];
  assert.equal(publicationOpportunity(current,channel,[],now,'UTC').topicUrl,'https://capacity-0.example.test/guides/second-article');
  // Same list, but the site moved: its old pages are no longer its own articles.
  const moved={...current,domain:'moved.example.test',url:'https://moved.example.test/'};
  assert.equal(publicationOpportunity(moved,channel,[],now,'UTC').topicUrl,undefined);
});

test('platform choice leans away from Telegraph and toward lucid.page by how often their pages were found in Google',()=>{
  const byId=(id:string)=>CHANNELS.find(item=>item.id===id)!;
  assert.equal(channelLinkQuality(byId('telegraph'),[]),SCHEDULING_DEFAULTS.linkQualityC*.5);
  const live={channelId:'telegraph',firstLiveAt:stamp,linkRel:'nofollow'} as Task;
  assert.equal(channelLinkQuality(byId('telegraph'),[live]),SCHEDULING_DEFAULTS.linkQualityNofollow*.5);
  assert.equal(channelLinkQuality(byId('lucid-page'),[]),SCHEDULING_DEFAULTS.linkQualityNofollow*1.3);
  assert.equal(channelLinkQuality(byId('supanote'),[]),SCHEDULING_DEFAULTS.linkQualityNofollow);
});
