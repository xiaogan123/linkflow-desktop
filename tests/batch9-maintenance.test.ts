import {recheckLink} from '../src/integrations/web';
import test,{beforeEach,type TestContext} from 'node:test';
beforeEach(t=>(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-19T10:17:00.000Z')}));
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {Controller} from '../src/main/controller';
import type {Vault} from '../src/main/vault';
import type {Site,Task} from '../src/shared/types';
import {applyLinkResult} from '../src/main/planner';
import {dueLinkChecks,migrateLinkChecks,nextLinkCheck,platformSurvival,reconcilePlatformSurvival} from '../src/main/link-maintenance';
import {temporaryRetry} from '../src/main/temporary-retry';
import {enableStoppedChannelTrial} from '../src/main/settings-service';
import {publicationCounts} from '../src/shared/publication';
import {CHANNELS} from '../src/integrations/catalog';
import {validateBackup} from '../src/main/backup-validation';

const now=new Date('2026-10-19T10:00:00Z'),stamp=now.toISOString(),old='2026-09-01T10:00:00.000Z';
const site:Site={id:'11111111-1111-4111-8111-111111111111',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Changed name',description:'Example',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:old};
const task=(extra:Partial<Task>={}):Task=>({id:'22222222-2222-4222-8222-222222222222',siteId:site.id,channelId:'telegraph',sourceDomain:'telegra.ph',status:'live',createdAt:old,updatedAt:old,scheduledAt:old,attempts:1,message:'fixture',publicUrl:'https://telegra.ph/example-article',firstLiveAt:old,verifiedAt:old,publicationMethod:'client',linkCheck:'found',health:'healthy',...extra});
const vault={ready:true,available:()=>true,get:async()=>undefined} as unknown as Vault;
const found={found:true,outcome:'found' as const,url:task().publicUrl!,rel:'nofollow',reason:'fixture',reasonCode:'link_found' as const,indexable:true};

test('link cadence is days 1, 7, 30, then monthly; archived sites are always monthly',()=>{
 const t=task({firstLiveAt:stamp});
 for(const [elapsed,next] of [[0,1],[1,7],[7,30],[30,60],[60,90]])assert.equal(nextLinkCheck(t,new Date(now.getTime()+elapsed*86400000)),new Date(now.getTime()+next*86400000).toISOString());
 assert.equal(nextLinkCheck(t,now,true),new Date(now.getTime()+30*86400000).toISOString());
});

test('upgrade covers every historical URL once; bounded rounds avoid repeat-platform bursts',()=>{
 const tasks=['failed','skipped','expired','live','review'].map((status,i)=>task({id:String(i),channelId:i%2?'platform-b':'telegraph',status:status as Task['status']}));
 migrateLinkChecks(tasks,now);assert.ok(tasks.every(t=>t.linkRecheckVersion===1&&t.linkRecheckAt));
 const initial=tasks.map(t=>t.linkRecheckAt);migrateLinkChecks(tasks,new Date(now.getTime()+86400000));assert.deepEqual(tasks.map(t=>t.linkRecheckAt),initial);
 const store=new Store(':memory:');try{const state=store.read();state.sites=[site];state.tasks=tasks;
 const due=dueLinkChecks(state,new Date(now.getTime()+86400000));assert.equal(due.length,2);assert.equal(new Set(due.map(t=>t.channelId)).size,2);
 tasks[0].lastCheckedAt=stamp;assert.equal(dueLinkChecks(state,now).some(t=>t.channelId==='telegraph'),false);
 }finally{store.close()}
});

test('terminal historical pages use link-only checks despite old drafts; found restores results and missing preserves terminal state',async()=>{
 for(const status of ['failed','skipped','expired'] as const){
  const store=new Store(':memory:');store.update(s=>{s.sites=[site];s.tasks=[task({status,firstLiveAt:undefined,draft:{title:'Old title',description:'Old',body:'Old body'}})]});let calls=0;
  const controller=new Controller(store,vault,'fixture',{recheckLink:async()=>{calls++;return found}});
  try{await controller.verify(task().id);const saved=store.read().tasks[0];assert.equal(calls,1);assert.equal(saved.status,'live');assert.ok(saved.firstLiveAt);assert.equal(publicationCounts(site.id,[saved],new Date(),'UTC').currentPages,1)}finally{controller.stop();store.close()}
  const t=task({status,firstLiveAt:undefined});applyLinkResult(t,{...found,found:false,outcome:'absent',reasonCode:'link_absent'},now);assert.equal(t.status,status);assert.equal(t.firstLiveAt,undefined);
 }
});

test('a lost live link keeps publication history without a todo and can become live again',()=>{
 const t=task();applyLinkResult(t,{...found,found:false,outcome:'absent',reasonCode:'link_absent'},now);
 assert.equal(t.status,'live');assert.equal(t.lostAt,stamp);assert.equal(t.firstLiveAt,old);assert.equal(t.humanAction,undefined);assert.equal(t.reasonCode,undefined);
 assert.equal(publicationCounts(site.id,[t],now,'UTC').currentPages,0);
 applyLinkResult(t,found,new Date(now.getTime()+86400000));assert.equal(t.lostAt,undefined);assert.equal(t.firstLiveAt,old);
});

test('archived and disabled platforms continue read-only checks',async()=>{
 const store=new Store(':memory:');store.update(s=>{s.sites=[{...site,status:'paused',archivedAt:stamp}];s.tasks=[task()];s.settings.channelOverrides.telegraph=false});let calls=0;
 const controller=new Controller(store,vault,'fixture',{recheckLink:async()=>{calls++;return found}});
 try{const before=Date.now();await controller.verify(task().id);const saved=store.read().tasks[0];assert.equal(calls,1);assert.ok(Date.parse(saved.nextCheckAt!)>=before+30*86400000)}finally{controller.stop();store.close()}
});

test('mature sample threshold pauses the whole platform once, exposes one todo and owner recovery sticks',()=>{
 const store=new Store(':memory:');try{
 store.update(s=>{s.sites=[site];s.tasks=Array.from({length:5},(_,i)=>task({id:`22222222-2222-4222-8222-${String(i).padStart(12,'0')}`,publicUrl:`https://telegra.ph/example-${i}`,...(i<2?{lostAt:stamp,health:'missing',linkCheck:'absent'}:{})}));reconcilePlatformSurvival(s,now)});
 assert.equal(platformSurvival(store.read().tasks,now).telegraph.survivalRate,.6);assert.equal(store.read().settings.channelOverrides.telegraph,false);
 const controller=new Controller(store,vault,'fixture');try{assert.equal(controller.snapshot().platformSurvivalTodos?.length,1);controller.plan();assert.equal(controller.snapshot().platformSurvivalTodos?.length,1)}finally{controller.stop()}
 enableStoppedChannelTrial(store,'telegraph',CHANNELS);store.update(s=>reconcilePlatformSurvival(s,now));assert.equal(store.read().settings.channelOverrides.telegraph,true);assert.equal(store.read().settings.platformSurvival?.telegraph.pausedAt,undefined);
 const data=validateBackup({state:store.read(),secrets:{}});assert.ok(data.state.settings.platformSurvival?.telegraph.resumedAt);
 }finally{store.close()}
 for(const [count,lost,paused] of [[4,4,false],[10,3,false],[10,4,true]] as const){const store=new Store(':memory:');try{const s=store.read();s.tasks=Array.from({length:count},(_,i)=>task({publicUrl:`https://telegra.ph/sample-${i}`,...(i<lost?{lostAt:stamp,linkCheck:'absent' as const}:{})}));reconcilePlatformSurvival(s,now);assert.equal(!!s.settings.platformSurvival?.telegraph.pausedAt,paused)}finally{store.close()}}
});

test('temporary unsent failures wait 2h and 8h then move off that platform without resetting AI spend',()=>{
 const t=task({status:'running',publicUrl:undefined,firstLiveAt:undefined,verifiedAt:undefined,cost:{aiCalls:2}});
 Object.assign(t,temporaryRetry(t,'temporary_failure',now));assert.equal(t.scheduledAt,'2026-10-19T12:00:00.000Z');
 Object.assign(t,temporaryRetry(t,'temporary_failure',new Date(t.scheduledAt)));assert.equal(t.scheduledAt,'2026-10-19T20:00:00.000Z');
 Object.assign(t,temporaryRetry(t,'temporary_failure',new Date(t.scheduledAt)));assert.equal(t.status,'queued');assert.equal(t.channelId,'');assert.deepEqual(t.failedPlatformIds,['telegraph']);assert.equal(t.cost?.aiCalls,2);
 assert.equal(temporaryRetry({...t,submittedAt:stamp}),undefined);
});

test('finance snapshot count cache follows successful store writes and cannot be mutated by callers',()=>{
 const store=new Store(':memory:');store.update(s=>{s.sites=[{...site,category:'finance'}]});const controller=new Controller(store,vault,'fixture');
 try{const before=store.revision,first=controller.snapshot().financePlatformCounts;const cache=(controller as unknown as {financeCountCache:unknown}).financeCountCache;controller.snapshot();assert.equal((controller as unknown as {financeCountCache:unknown}).financeCountCache,cache);if(first?.[site.id])first[site.id].count=-1;assert.notEqual(controller.snapshot().financePlatformCounts?.[site.id].count,-1);store.update(s=>{s.settings.channelOverrides.telegraph=false});assert.equal(store.revision,before+1);controller.snapshot();assert.notEqual((controller as unknown as {financeCountCache:unknown}).financeCountCache,cache)}finally{controller.stop();store.close()}
});


test('pause metrics count losses from the same mature sample as the survival rate',()=>{
 const metric=platformSurvival([task({lostAt:'2026-09-02T10:00:00.000Z'})],now).telegraph;
 assert.equal(metric.survivalRate,0);assert.equal(metric.sampleSize,1);assert.equal(metric.lostCount,1);
});

test('link-only presence cannot resolve a referral hold on an already submitted draft',async()=>{
 const store=new Store(':memory:');let reads=0;
 store.update(state=>{state.sites=[site];state.tasks=[task({status:'needs_input',reasonCode:'referral_blocked',submittedAt:old,firstLiveAt:undefined,draft:{title:'Guide',description:'Guide',body:'Referral code: TEST1234'}})]});
 const controller=new Controller(store,vault,'fixture',{recheckLink:async()=>{reads++;return found}});
 try{await controller.verify(task().id);const saved=store.read().tasks[0];assert.equal(reads,0);assert.equal(saved.status,'needs_input');assert.equal(saved.reasonCode,'referral_blocked');assert.equal(saved.firstLiveAt,undefined)}finally{controller.stop();store.close()}
});


test('authoritative HTTP 404 and 410 record loss even for client-rendered platforms',async()=>{
 for(const channelId of ['mdshare','bluesky','whitewind','hackmd'])for(const status of [404,410]){
  const store=new Store(':memory:');store.update(state=>{state.sites=[site];state.tasks=[task({channelId})]});
  const controller=new Controller(store,vault,'fixture',{recheckLink:async(url,target,legacy,expected,signal)=>recheckLink(url,target,legacy,expected,signal,{
    resolve:async()=>[{address:'8.8.8.8',family:4}],request:async()=>({status,headers:{'content-type':'text/html'},body:Buffer.alloc(0)})})});
  try{await controller.verify(task().id);const saved=store.read().tasks[0];assert.equal(saved.linkCheck,'absent');assert.equal(saved.health,'missing');assert.ok(saved.lostAt);assert.equal(saved.status,'live');assert.equal(saved.humanAction,undefined)}finally{controller.stop();store.close()}
 }
});
