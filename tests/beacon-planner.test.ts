import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {bindAccount} from '../src/main/account-bindings';
import {availableNetworkPlatforms,claimPublicationExecution,makePlan,publicationExecutionAt,selectTaskPlatform,taskPlatformIdentityAvailable} from '../src/main/planner';
import {emptyState} from '../src/main/store';
import {CHANNELS} from '../src/integrations/catalog';
import {samePlatformGapDays,schedulingDay} from '../src/shared/scheduling';
import type {Account,Channel,Site,Task} from '../src/shared/types';

const now=new Date('2026-11-02T12:00:00.000Z'),stamp='2026-10-20T08:00:00.000Z',accountId='93333333-3333-4333-8333-333333333333';
const siteIds=['91111111-1111-4111-8111-111111111111','92222222-2222-4222-8222-222222222222'] as const;
// The catalog keeps beacon off by default; these tests exercise the flow as if it were switched on.
const channel={...CHANNELS.find(value=>value.id==='beacon')!,enabled:true};
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');

function site(id:string,index:number):Site{return {id,domain:`beacon-planner-${index}.example.com`,url:`https://beacon-planner-${index}.example.com/`,email:`public-${index}@example.com`,name:`Beacon planner ${index}`,description:'Independent software documentation.',category:'software',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:stamp,topics:[{url:`https://beacon-planner-${index}.example.com/releases/one`,discoveredAt:stamp}],qualifications:{software:`https://beacon-planner-${index}.example.com/product`,developer:`https://beacon-planner-${index}.example.com/releases`}}}
function account():Account{const email='shared-owner@example.com',checkedAt=stamp;return {id:accountId,channelId:'beacon',email,username:'remote-owner',credentialKind:'api_token',status:'registered',hasPassword:true,source:'imported',createdAt:stamp,registeredAt:stamp,verifiedAt:checkedAt,beacon:{version:1,stage:'ready',emailHash:sha(email),apiKeyFingerprint:sha('synthetic-api-key'),remoteAccountIdHash:sha('remote-owner'),checkedAt}}}
function fixture(){const state=emptyState(),sites=siteIds.map((id,index)=>site(id,index));state.settings.autoRun=true;state.settings.timezone='UTC';state.settings.articleReviewMode='ai';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(value=>[value.id,value.id==='beacon']));state.sites=sites;state.accounts=[account()];for(const value of sites)bindAccount(state,accountId,value.id,channel,new Date(stamp));return {state,sites}}
const matches=(value:Site)=>[{channel,score:100,reason:`Beacon planner fixture for ${value.id}`}];

test('real planner rotates two bound sites through one Beacon owner without treating the key as a shared public page',()=>{
  const {state,sites}=fixture(),network=availableNetworkPlatforms(state,[channel],now),beacon=network.find(value=>value.id==='beacon');
  assert.ok(beacon);assert.deepEqual(new Set(beacon.eligibleSiteIds),new Set(siteIds));
  const created=sites.flatMap(value=>makePlan(state,value,matches(value),now,network));assert.equal(created.length,2);assert.equal(new Set(created.map(value=>value.siteId)).size,2);
  for(const task of [...created].sort((left,right)=>left.scheduledAt.localeCompare(right.scheduledAt))){const selected=selectTaskPlatform(state,task,matches(state.sites.find(value=>value.id===task.siteId)!),new Date(task.scheduledAt));assert.equal(selected?.id,'beacon');assert.equal(task.accountId,accountId);assert.equal(taskPlatformIdentityAvailable(state,task,channel),true)}
  const [first,second]=[...created].sort((left,right)=>left.scheduledAt.localeCompare(right.scheduledAt)),firstAt=new Date(first.scheduledAt);assert.equal(claimPublicationExecution(state,first,firstAt,()=>0),true);first.status='review';first.submittedAt=firstAt.toISOString();
  const rotated=publicationExecutionAt(state,second,firstAt),firstDay=schedulingDay(firstAt,'UTC'),rotatedDay=schedulingDay(rotated,'UTC');assert.notEqual(rotatedDay,firstDay);assert.ok(rotated.getTime()>firstAt.getTime());assert.ok(rotated.getTime()<=firstAt.getTime()+2*86400000);assert.equal(taskPlatformIdentityAvailable(state,second,channel),true);
});

test('Beacon site-scoped scheduler identity keeps the same-site platform gap and cross-site daily capacity',()=>{
  const {state,sites}=fixture(),firstAt=new Date('2026-11-03T12:00:00.000Z'),first:Task={id:'94444444-4444-4444-8444-444444444444',siteId:sites[0].id,channelId:'beacon',accountId,sourceDomain:'beacon.host',status:'live',createdAt:stamp,scheduledAt:firstAt.toISOString(),updatedAt:firstAt.toISOString(),submittedAt:firstAt.toISOString(),firstLiveAt:firstAt.toISOString(),publicUrl:'https://first-beacon-page.beacon.host/',attempts:1,message:'fixture'};
  state.tasks=[first];const sameSite:Task={id:'95555555-5555-4555-8555-555555555555',siteId:sites[0].id,channelId:'beacon',accountId,sourceDomain:'beacon.host',status:'queued',createdAt:stamp,scheduledAt:new Date(firstAt.getTime()+86400000).toISOString(),updatedAt:stamp,attempts:0,message:'fixture'},otherSite:Task={...sameSite,id:'96666666-6666-4666-8666-666666666666',siteId:sites[1].id};state.tasks.push(sameSite,otherSite);
  const sameAt=publicationExecutionAt(state,sameSite,new Date(sameSite.scheduledAt)),requiredGap=samePlatformGapDays(sites[0].id,'beacon',firstAt.toISOString());assert.ok(sameAt.getTime()>=firstAt.getTime()+requiredGap*86400000);assert.equal(taskPlatformIdentityAvailable(state,sameSite,channel),true);
  const otherAt=publicationExecutionAt(state,otherSite,new Date(otherSite.scheduledAt));assert.ok(otherAt.getTime()<firstAt.getTime()+3*86400000);assert.equal(taskPlatformIdentityAvailable(state,otherSite,channel),true);
});
