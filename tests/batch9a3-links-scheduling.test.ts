import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/main/controller';
import {Store} from '../src/main/store';
import {dueLinkChecks} from '../src/main/link-maintenance';
import {CHANNELS} from '../src/integrations/catalog';
import type {Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const stamp='2026-10-19T10:00:00.000Z',old='2026-08-01T10:00:00.000Z';
const site:Site={id:'11111111-1111-4111-8111-111111111111',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Example software guide',category:'software',language:'en',monthlyTarget:3,status:'ready',createdAt:old,topicsCheckedAt:stamp};
const vault={ready:true,available:()=>true,get:async()=>undefined} as unknown as Vault;
function task(index=0,extra:Partial<Task>={}):Task{return {id:`22222222-2222-4222-8222-${String(index).padStart(12,'0')}`,siteId:site.id,channelId:'telegraph',sourceDomain:'telegra.ph',status:'live',createdAt:old,updatedAt:old,scheduledAt:old,attempts:1,message:'fixture',publicUrl:`https://telegra.ph/example-${index}`,firstLiveAt:old,verifiedAt:old,lastCheckedAt:old,nextCheckAt:old,linkRecheckVersion:1,linkCheck:'found',health:'healthy',...extra}}
function fixture(tasks:Task[]){const store=new Store(':memory:');store.update(state=>{state.sites=[structuredClone(site)];state.tasks=tasks;state.settings.autoRun=true;state.settings.notify=false;state.settings.monitorSearch=false});return store}
const found=(url:string)=>({found:true,outcome:'found' as const,url,rel:'follow',reason:'found',reasonCode:'link_found' as const,indexable:true});

test('b9a3 reconciliation cap is limited to receipt channels and exempts submitted trials',()=>{
  const values=[task(0,{channelId:'tantive',firstLiveAt:undefined,reconcileAttempts:3}),task(1,{channelId:'agentswiki',firstLiveAt:undefined,reconcileAttempts:3}),task(2,{channelId:'thethings',firstLiveAt:undefined,submittedAt:'2026-10-19T04:00:00.000Z',reconcileAttempts:3})];
  const store=fixture(values);
  try{assert.deepEqual(dueLinkChecks(store.read(),new Date(stamp),10,CHANNELS).map(value=>value.id),[values[1].id,values[2].id])}finally{store.close()}
});

test('b9a3 AI disconnect marks every due local queued task without consuming schedules',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(stamp)});
  const values=[0,1,2].map(index=>task(index,{status:'queued',publicUrl:undefined,firstLiveAt:undefined,verifiedAt:undefined,lastCheckedAt:undefined,nextCheckAt:undefined,linkCheck:undefined,health:undefined,attempts:0,scheduledAt:`2026-10-${10+index}T10:00:00.000Z`,scheduling:{version:1,month:'2026-10',slot:index,target:3,effectiveTarget:3,reschedules:index}}));
  const future=task(3,{status:'queued',publicUrl:undefined,firstLiveAt:undefined,scheduledAt:'2026-10-25T10:00:00.000Z'}),remote=task(4,{status:'queued',submittedAt:old,firstLiveAt:undefined});
  const store=fixture([...values,future,remote]),controller=new Controller(store,vault,'fixture',{channelCatalog:CHANNELS.filter(channel=>channel.id==='telegraph')});
  try{
    for(let day=19;day<=21;day++){
      t.mock.timers.setTime(Date.parse(`2026-10-${day}T10:00:00.000Z`));controller.plan();
      for(const original of values){const saved=store.read().tasks.find(value=>value.id===original.id)!;assert.equal(saved.status,'queued');assert.equal(saved.checkpoint,'ai_setup_required');assert.equal(saved.scheduledAt,original.scheduledAt);assert.equal(saved.scheduling?.reschedules,original.scheduling?.reschedules);assert.equal(saved.missedPublicationAt,undefined)}
    }
    assert.equal(store.read().tasks.find(value=>value.id===future.id)?.checkpoint,undefined);assert.equal(store.read().tasks.find(value=>value.id===remote.id)?.checkpoint,undefined);
    controller.runtime.aiReady=true;controller.plan();
    for(const original of values){const saved=store.read().tasks.find(value=>value.id===original.id)!;assert.equal(saved.status,'queued');assert.equal(saved.checkpoint,undefined);assert.equal(saved.scheduledAt,new Date().toISOString());assert.equal(saved.scheduling?.reschedules,original.scheduling?.reschedules);assert.equal(saved.missedPublicationAt,undefined)}
  }finally{controller.stop();store.close()}
});

test('b9a3 scheduler leaves an in-flight manual link check untouched and accepts its result',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(stamp)});
  const value=task(),store=fixture([value]);store.update(state=>{state.sites[0].status='paused'});
  let release!:(value:ReturnType<typeof found>)=>void,reads=0;
  const pending=new Promise<ReturnType<typeof found>>(resolve=>{release=resolve});
  const controller=new Controller(store,vault,'fixture',{recheckLink:async()=>{reads++;return pending}});
  try{
    const verification=controller.verify(value.id);assert.equal(reads,1);
    await controller.tick();assert.equal(reads,1);assert.equal(store.read().tasks[0].linkRecheckAt,undefined);
    release(found(value.publicUrl!));await verification;
    const saved=store.read().tasks[0];assert.equal(saved.lastCheckedAt,stamp);assert.equal(saved.linkCheck,'found');assert.ok(saved.linkObservation);assert.equal(saved.linkRecheckAt,undefined);
  }finally{release(found(value.publicUrl!));controller.stop();store.close()}
});

test('b9a3 AI disconnect preserves a pending registration checkpoint and email wait',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(stamp)});
  const channel=CHANNELS.find(value=>value.id==='github')!,accountId='33333333-3333-4333-8333-333333333333';
  const wait:NonNullable<Task['emailWait']>={kind:'code',recipient:site.email,since:stamp,nextPollAt:'2026-10-19T10:01:00.000Z',expiresAt:'2026-10-19T10:15:00.000Z',consumedMessageIds:[],continuation:'browser'};
  const value=task(0,{channelId:channel.id,sourceDomain:channel.domain,accountId,status:'queued',checkpoint:'account_registration_submitted',scheduledAt:stamp,publicUrl:undefined,firstLiveAt:undefined,verifiedAt:undefined,lastCheckedAt:undefined,nextCheckAt:undefined,linkCheck:undefined,health:undefined,emailWait:wait});
  const store=fixture([value]);store.update(state=>{
    state.accounts=[{id:accountId,channelId:channel.id,username:'fixture',email:site.email,status:'needs_verification',credentialKind:'password',hasPassword:true,createdAt:stamp,lastUsedAt:stamp}];
    state.accountBindings=[{id:'44444444-4444-4444-8444-444444444444',siteId:site.id,channelId:channel.id,accountId,createdAt:stamp,updatedAt:stamp}];
    state.sites[0].qualifications={developer:site.url};
  });
  const controller=new Controller(store,vault,'fixture',{channelCatalog:[channel]});
  try{controller.plan();const saved=store.read().tasks.find(item=>item.id===value.id)!;assert.equal(saved.status,'queued');assert.equal(saved.checkpoint,'account_registration_submitted');assert.deepEqual(saved.emailWait,wait);assert.equal(saved.scheduledAt,stamp)}finally{controller.stop();store.close()}
});

test('b9a3 scheduling and metrics writes cannot discard a completed link observation',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(stamp)});
  const value=task(),store=fixture([value]);let release!:(value:ReturnType<typeof found>)=>void;
  const controller=new Controller(store,vault,'fixture',{recheckLink:()=>new Promise(resolve=>{release=resolve})});
  try{
    const verification=controller.verify(value.id);
    store.update(state=>{state.tasks[0].linkRecheckAt='2026-10-20T10:00:00.000Z';state.tasks[0].nextCheckAt='2026-10-21T10:00:00.000Z';state.tasks[0].metrics=[]});
    release(found(value.publicUrl!));await verification;
    const saved=store.read().tasks[0];assert.equal(saved.lastCheckedAt,stamp);assert.ok(saved.linkObservation);assert.equal(saved.linkRecheckAt,undefined);assert.deepEqual(saved.metrics,[]);
  }finally{controller.stop();store.close()}
});

test('b9a3 a changed public URL still rejects an obsolete in-flight result',async()=>{
  const value=task(),store=fixture([value]);let release!:(value:ReturnType<typeof found>)=>void;
  const controller=new Controller(store,vault,'fixture',{recheckLink:()=>new Promise(resolve=>{release=resolve})});
  try{const verification=controller.verify(value.id);store.update(state=>{state.tasks[0].publicUrl='https://telegra.ph/replacement'});release(found(value.publicUrl!));await verification;assert.equal(store.read().tasks[0].lastCheckedAt,old);assert.equal(store.read().tasks[0].linkObservation,undefined)}finally{controller.stop();store.close()}
});

test('9a3 follow-up: a recovered task is not expired by an old backoff clock, and a live backoff still expires',async()=>{
  const {maintainWaitingTasks}=await import('../src/main/task-recovery');
  const now=new Date('2026-10-20T12:00:00.000Z'),old=new Date(now.getTime()-80*3600000).toISOString();
  const site={id:'11111111-1111-4111-8111-111111111111',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Fixture',category:'content',language:'en',monthlyTarget:2,status:'ready',createdAt:old} as never;
  const channel={id:'fixture-api',enabled:true} as never;
  const base={id:'22222222-2222-4222-8222-222222222222',siteId:'11111111-1111-4111-8111-111111111111',channelId:'fixture-api',sourceDomain:'example.org',status:'queued',createdAt:old,updatedAt:old,scheduledAt:now.toISOString(),attempts:0,message:'fixture',temporaryBackoffCount:1,temporaryBackoffStartedAt:old} as never;
  const settings={autoRun:true,timezone:'UTC',maxAttempts:3,dailyAiLimit:40} as never;
  // Deferred for cadence after the review passed: no temporary reason any more.
  const recovered=[{...(base as object),reasonCode:undefined}] as never[];
  maintainWaitingTasks(recovered as never,[site],[channel],settings,now);
  assert.equal((recovered[0] as {status:string}).status,'queued');
  // AI disconnected: kept for the reconnect recovery.
  const paused=[{...(base as object),reasonCode:'temporary_failure',checkpoint:'ai_setup_required'}] as never[];
  maintainWaitingTasks(paused as never,[site],[channel],settings,now);
  assert.equal((paused[0] as {status:string}).status,'queued');
  // Still inside the same temporary failure after 72 hours: stops.
  const stuck=[{...(base as object),reasonCode:'temporary_failure'}] as never[];
  maintainWaitingTasks(stuck as never,[site],[channel],settings,now);
  assert.equal((stuck[0] as {status:string}).status,'failed');
});
