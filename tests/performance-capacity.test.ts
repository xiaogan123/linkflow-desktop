import assert from 'node:assert/strict';
import test from 'node:test';
import {CHANNELS,matchChannels} from '../src/integrations/catalog';
import {capacityFor,capacitySnapshotIndex} from '../src/main/planner';
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
