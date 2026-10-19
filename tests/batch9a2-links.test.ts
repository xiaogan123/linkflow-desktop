import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/main/controller';
import {Store} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import type {Channel,Site,Task} from '../src/shared/types';
import {dueLinkChecks,platformSurvival,platformSurvivalTodos,reconcilePlatformSurvival} from '../src/main/link-maintenance';
import {applyLinkResult} from '../src/main/planner';
import {publicationCounts} from '../src/shared/publication';
import {CHANNELS} from '../src/integrations/catalog';
import {pinPublicationFixtures} from './helpers/publication-snapshot';

const now=new Date('2026-10-19T10:00:00.000Z');
const old='2026-08-01T10:00:00.000Z';
const site:Site={id:'11111111-1111-4111-8111-111111111111',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Example site',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:old};
const task=(extra:Partial<Task>={}):Task=>({id:'22222222-2222-4222-8222-222222222222',siteId:site.id,channelId:'telegraph',sourceDomain:'telegra.ph',status:'live',createdAt:old,updatedAt:old,scheduledAt:old,attempts:1,message:'fixture',publicUrl:'https://telegra.ph/example',firstLiveAt:old,verifiedAt:old,lastCheckedAt:old,nextCheckAt:old,publicationMethod:'client',linkCheck:'found',health:'healthy',...extra});
const found={found:true,outcome:'found' as const,url:'https://telegra.ph/example',rel:'follow',reason:'found',reasonCode:'link_found' as const,indexable:true};
const vault={ready:true,available:()=>true,get:async()=>undefined} as unknown as Vault;

function stateWith(tasks:Task[]){const store=new Store(':memory:');store.update(state=>{state.sites=[site];state.tasks=tasks});return store}

test('a skipped agent verification is deferred for 24 hours and releases the due slot without HTTP',async()=>{
  const pending=task({channelId:'agentboard',sourceDomain:'www.agentboard.ai',status:'review',submittedAt:old,draft:{title:'Example',description:'Example',body:'Example'},firstLiveAt:undefined,verifiedAt:undefined,lastCheckedAt:undefined,nextCheckAt:old,linkCheck:undefined,health:'pending'});
  const store=pinPublicationFixtures(stateWith([pending])),controller=new Controller(store,vault,'fixture',{channelCatalog:CHANNELS.map(channel=>channel.id==='agentboard'?{...channel,enabled:true}:channel)});
  try{
    const before=Date.now();await controller.verify(pending.id);const saved=store.read().tasks[0];
    assert.ok(Date.parse(saved.linkRecheckAt!)>=before+86400000);
    assert.equal(dueLinkChecks(store.read(),new Date(before+1000)).length,0);
  }finally{controller.stop();store.close()}
});

test('migration recheck is one-shot and exhausted receipt reconciliation is not polled forever',()=>{
  const observed=task({linkRecheckAt:'2026-10-01T00:00:00.000Z',lastCheckedAt:'2026-10-02T00:00:00.000Z',nextCheckAt:'2026-11-01T00:00:00.000Z'});
  const exhausted=task({id:'33333333-3333-4333-8333-333333333333',channelId:'tantive',status:'review',firstLiveAt:undefined,reconcileAttempts:3,linkRecheckAt:old,lastCheckedAt:undefined,nextCheckAt:old});
  const store=stateWith([observed,exhausted]);
  try{assert.deepEqual(dueLinkChecks(store.read(),now).map(item=>item.id),[])}finally{store.close()}
});

test('temporary and retention-limited pages are excluded from survival and stop checks after expiry',()=>{
  const shippage=CHANNELS.find(channel=>channel.id==='shippage');assert.ok(shippage?.retentionDays);
  const temporary=Array.from({length:5},(_,index)=>task({id:`44444444-4444-4444-8444-${String(index).padStart(12,'0')}`,channelId:'shippage',sourceDomain:'shippage.ai',publicUrl:`https://shippage.ai/example-${index}`,lostAt:'2026-09-01T00:00:00.000Z',linkCheck:'absent',health:'missing',temporaryPage:index===0}));
  const store=stateWith(temporary);
  try{
    assert.equal(platformSurvival(temporary,now,CHANNELS).shippage,undefined);
    reconcilePlatformSurvival(store.read(),now,CHANNELS);
    assert.notEqual(store.read().settings.channelOverrides.shippage,false);
    assert.equal(dueLinkChecks(store.read(),now,3,CHANNELS).length,0);
  }finally{store.close()}
});

test('owner resume ignores the old cohort but five mature post-resume observations can pause again',()=>{
  const resumedAt='2026-09-01T00:00:00.000Z';
  const oldLosses=Array.from({length:5},(_,index)=>task({id:`55555555-5555-4555-8555-${String(index).padStart(12,'0')}`,publicUrl:`https://telegra.ph/old-${index}`,firstLiveAt:'2026-07-01T00:00:00.000Z',lostAt:'2026-08-01T00:00:00.000Z',linkCheck:'absent',health:'missing'}));
  const store=stateWith(oldLosses);store.update(state=>{state.settings.platformSurvival={telegraph:{sampleSize:5,lostCount:5,survivalRate:0,pausedAt:undefined,resumedAt}};state.settings.channelOverrides.telegraph=true});
  try{
    store.update(state=>reconcilePlatformSurvival(state,now,CHANNELS));let saved=store.read();
    assert.equal(saved.settings.platformSurvival?.telegraph.pausedAt,undefined);assert.equal(saved.settings.platformSurvival?.telegraph.sampleSize,0);
    const newCohort=Array.from({length:5},(_,index)=>task({id:`66666666-6666-4666-8666-${String(index).padStart(12,'0')}`,publicUrl:`https://telegra.ph/new-${index}`,firstLiveAt:'2026-09-05T00:00:00.000Z',...(index<2?{lostAt:'2026-10-10T00:00:00.000Z',linkCheck:'absent' as const,health:'missing' as const}:{})}));
    store.update(state=>{state.tasks.push(...newCohort);reconcilePlatformSurvival(state,now,CHANNELS)});saved=store.read();
    assert.ok(saved.settings.platformSurvival?.telegraph.pausedAt);assert.equal(saved.settings.channelOverrides.telegraph,false);
    assert.equal(saved.settings.platformSurvival?.telegraph.sampleSize,5);assert.equal(saved.settings.platformSurvival?.telegraph.lostCount,2);
    assert.match(platformSurvivalTodos(saved,CHANNELS)[0].message,/满 30 天的 5 条外链里有 2 条被删/);
  }finally{store.close()}
});

test('unreachable live observations are neither losses nor survival samples',()=>{
  const unreachable=task();applyLinkResult(unreachable,{...found,found:false,outcome:'unreachable',reasonCode:'page_unreachable'},now);
  assert.equal(unreachable.status,'live');assert.equal(unreachable.health,'unknown');assert.equal(unreachable.linkCheck,'unreachable');assert.equal(unreachable.lostAt,undefined);
  assert.deepEqual(platformSurvival([unreachable],now,CHANNELS).telegraph,{sampleSize:0,lostCount:0,survivalRate:1});
});

test('newest unreachable duplicate suppresses an older healthy URL sample',()=>{
  const older=task({id:'77777777-7777-4777-8777-777777777777',lastCheckedAt:'2026-10-01T00:00:00.000Z'}),newer=task({id:'88888888-8888-4888-8888-888888888888',lastCheckedAt:'2026-10-18T00:00:00.000Z',health:'unknown',linkCheck:'unreachable'});
  const metric=platformSurvival([older,newer],now,CHANNELS).telegraph;
  assert.equal(metric.sampleSize,0);assert.equal(metric.lostCount,0);assert.equal(metric.survivalRate,1);
});

test('active pause freezes its mature evidence after recovery or an inconclusive observation',()=>{
  const losses=Array.from({length:5},(_,index)=>task({id:`99999999-9999-4999-8999-${String(index).padStart(12,'0')}`,publicUrl:`https://telegra.ph/frozen-${index}`,...(index<2?{lostAt:'2026-10-01T00:00:00.000Z',linkCheck:'absent' as const,health:'missing' as const}:{})}));
  const store=stateWith(losses);
  try{
    store.update(state=>reconcilePlatformSurvival(state,now,CHANNELS));const paused=structuredClone(store.read().settings.platformSurvival?.telegraph);assert.ok(paused?.pausedAt);
    store.update(state=>{for(const item of state.tasks){item.lostAt=undefined;item.linkCheck='found';item.health='healthy'}reconcilePlatformSurvival(state,new Date(now.getTime()+86400000),CHANNELS)});
    assert.deepEqual(store.read().settings.platformSurvival?.telegraph,paused);
    store.update(state=>{for(const item of state.tasks){item.linkCheck='unreachable';item.health='unknown'}reconcilePlatformSurvival(state,new Date(now.getTime()+2*86400000),CHANNELS)});
    assert.deepEqual(store.read().settings.platformSurvival?.telegraph,paused);
    assert.match(platformSurvivalTodos(store.read(),CHANNELS)[0].message,/满 30 天的 5 条外链里有 2 条被删/);
  }finally{store.close()}
});

test('historical recovery uses attempted time, records recoveredAt, and only increases current pages',async()=>{
  const attempted='2026-08-15T10:00:00.000Z',historical=task({status:'expired',firstLiveAt:undefined,verifiedAt:undefined,lastCheckedAt:undefined,nextCheckAt:old,scheduling:{version:1,month:'2026-08',slot:0,target:1,effectiveTarget:1,reschedules:0,attemptedAt:attempted}});
  const store=stateWith([historical]),controller=new Controller(store,vault,'fixture',{recheckLink:async()=>found});
  try{
    await controller.verify(historical.id);const saved=store.read().tasks[0],counts=publicationCounts(site.id,[saved],now,'UTC');
    assert.equal(saved.firstLiveAt,attempted);assert.ok(saved.recoveredAt);assert.equal(saved.status,'live');
    assert.equal(counts.currentPages,1);assert.equal(counts.monthlyPages,0);
  }finally{controller.stop();store.close()}
});
