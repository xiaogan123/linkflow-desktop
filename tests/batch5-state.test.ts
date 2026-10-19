import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reuseBlueskyForLeaflet} from '../src/main/atproto-reuse';
import {atprotoIdentityConflict,channelExecutionReadiness} from '../src/main/account-bindings';
import {CHANNELS} from '../src/integrations/catalog';
import {emptyState,Store,migrateState} from '../src/main/store';
import {claimChannelTrial,trialTaskAvailable,reconcileChannelTrials} from '../src/main/channel-trials';
import {createBatch5Persistence,createBatch5AccountPersistence,batch5LocalAccountId} from '../src/main/batch5-publication';
import {validateBackup} from '../src/main/backup-validation';
import {publicationCounts,reservesMonthlySlot} from '../src/shared/publication';
import {availableNetworkPlatforms,nextTask} from '../src/main/planner';
import type {Task,Site} from '../src/shared/types';
import type {Batch5Intent} from '../src/integrations/batch5-contract';

const at='2026-10-18T06:00:00.000Z';
const siteId='22222222-2222-4222-8222-222222222222',taskId='11111111-1111-4111-8111-111111111111';
const site:Site={id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Independent financial education',language:'zh-CN',category:'finance',monthlyTarget:2,status:'ready',createdAt:at};
const task=(extra:Partial<Task>={}):Task=>({id:taskId,siteId,channelId:'yeetmd',sourceDomain:'yeet.md',status:'running',createdAt:at,updatedAt:at,scheduledAt:at,attempts:1,message:'fixture',...extra});
const channel={...CHANNELS.find(value=>value.id==='yeetmd')!,trial:true};
const intent:Batch5Intent={version:1,channelId:'yeetmd',siteId,operationId:'batch5-fixture',sourceHash:'1'.repeat(64),requestHash:'2'.repeat(64),createdAt:at};
function state(){const s=emptyState();s.settings.timezone='UTC';s.sites=[site];s.tasks=[task()];return s;}

test('trial lease spans all sites and survives a restart/backup',()=>{
  const s=state(),other=task({id:'33333333-3333-4333-8333-333333333333',siteId:'44444444-4444-4444-8444-444444444444',status:'queued'});s.tasks.push(other);
  assert.equal(claimChannelTrial(s,channel,s.tasks[0]),true);
  assert.equal(trialTaskAvailable(s,channel,other.id),false);
  const restored=migrateState(structuredClone(s));assert.equal(trialTaskAvailable(restored,channel,other.id),false);
});
test('first acceptance requires a visible indexable link and persists trial=false',()=>{
  const s=state();claimChannelTrial(s,channel,s.tasks[0]);
  Object.assign(s.tasks[0],{status:'live',firstLiveAt:at,linkCheck:'found',linkIndexable:false});reconcileChannelTrials(s,[channel],new Date(at));assert.equal(s.settings.channelTrials?.yeetmd.trial,true);
  s.tasks[0].linkIndexable=true;reconcileChannelTrials(s,[channel],new Date(at));assert.equal(s.settings.channelTrials?.yeetmd.trial,false);assert.equal(s.settings.channelTrials?.yeetmd.promotedAt,at);
});
test('explicit platform failures disable a trial; reason codes and writing failures do not',()=>{
  const s=state();claimChannelTrial(s,channel,s.tasks[0]);s.tasks[0].status='failed';s.tasks[0].reasonCode='content_rejected';reconcileChannelTrials(s,[channel]);assert.equal(s.settings.channelTrials?.yeetmd.failures,0);
  s.tasks[0].status='running';claimChannelTrial(s,channel,s.tasks[0]);s.tasks[0].reasonCode='platform_rate_limited';reconcileChannelTrials(s,[channel]);assert.equal(s.settings.channelTrials?.yeetmd.failures,0);
  s.tasks[0].trialFailure='publisher rate limit';reconcileChannelTrials(s,[channel]);reconcileChannelTrials(s,[channel]);assert.equal(s.settings.channelTrials?.yeetmd.failures,1);
  const next=task({id:'33333333-3333-4333-8333-333333333333',status:'queued'});s.tasks.push(next);assert.equal(claimChannelTrial(s,channel,next),true);next.status='failed';next.reasonCode='platform_rejected';next.trialFailure='publisher rejected';reconcileChannelTrials(s,[channel]);assert.equal(s.settings.channelOverrides.yeetmd,false);assert.equal(next.status,'needs_input');assert.equal(next.reasonCode,'channel_disabled');
});
test('unknown remote result keeps the platform trial locked',()=>{const s=state();claimChannelTrial(s,channel,s.tasks[0]);Object.assign(s.tasks[0],{status:'needs_input',reasonCode:'submission_unknown',submittedAt:at});reconcileChannelTrials(s,[channel]);assert.equal(trialTaskAvailable(s,channel,'other-task'),false);assert.equal(s.settings.channelTrials?.yeetmd.failures,0);});
test('temporary publications never count toward the monthly target or reserve its slots',()=>{
  const t=task({temporaryPage:true,status:'live',firstLiveAt:at,publicUrl:'https://yeet.md/s/example',linkCheck:'found',health:'healthy'});
  assert.equal(publicationCounts(siteId,[t],new Date(at),'UTC').monthlyPages,0);assert.equal(reservesMonthlySlot({...t,status:'review'},new Date(at),'UTC'),false);
  const s=state(),temporary={...channel,retentionDays:30};assert.equal(availableNetworkPlatforms(s,[temporary]).length,0);
});
test('new metadata does not invalidate old backups and temporary catalog pages migrate',()=>{
  const s=state();s.tasks=[task({channelId:'brewpage',sourceDomain:'brewpage.app',status:'queued'})];delete s.settings.channelTrials;
  const restored=validateBackup({state:s,secrets:{}}).state;assert.equal(restored.tasks[0].temporaryPage,true);assert.deepEqual(restored.settings.channelTrials?.brewpage,{trial:true,failures:0,evaluatedTaskIds:[]});
});

test('trial backup roundtrip preserves appearance and archived site content with an empty public email',()=>{
  const s=emptyState();
  s.settings.appearance='dark';
  s.settings.channelTrials!.yeetmd={trial:true,failures:1,evaluatedTaskIds:[taskId],evaluatedFailureOperationIds:['fixture-operation']};
  s.sites=[{
    ...site,email:'',publicEmail:'',status:'paused',archivedAt:at,
    topicOverrides:{added:[{url:'https://example.com/guide',title:'Guide',discoveredAt:at}],excluded:['https://example.com/old-guide']},
    linkTargets:['https://example.com/guide'],forbiddenTerms:['fixture phrase'],
  }];
  const restored=validateBackup({state:s,secrets:{}}).state;
  assert.deepEqual(restored.sites,s.sites);
  assert.equal(restored.settings.appearance,'dark');
  assert.deepEqual(restored.settings.channelTrials,s.settings.channelTrials);
  const reopened=migrateState(structuredClone(restored));
  assert.deepEqual(reopened.sites,s.sites);
  assert.equal(reopened.settings.appearance,'dark');
  assert.deepEqual(reopened.settings.channelTrials,s.settings.channelTrials);
});

test('legacy settings initialize appearance and trial markers together without changing existing history',()=>{
  const s=state();
  s.tasks=[task({status:'queued',attempts:0,history:[{at,status:'queued',message:'fixture history'}]})];
  delete s.settings.appearance;
  delete s.settings.channelTrials;
  const migrated=migrateState(structuredClone(s));
  assert.equal(migrated.settings.appearance,'system');
  assert.deepEqual(migrated.settings.channelTrials,emptyState().settings.channelTrials);
  assert.deepEqual(migrated.tasks[0].history,s.tasks[0].history);
  assert.equal(migrated.tasks[0].id,taskId);
  assert.deepEqual(migrateState(structuredClone(migrated)),migrated);
});

function fixture(){const directory=mkdtempSync(join(tmpdir(),'linkflow-b5-state-')),store=new Store(join(directory,'state.sqlite'));store.update(value=>Object.assign(value,state()));const vault={get:async(key:string)=>{const cipher=store.getCipher(key);return cipher?Buffer.from(cipher.slice(4),'base64url').toString():undefined;},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))};return {store,vault,directory,close(){store.close();rmSync(directory,{recursive:true,force:true});}};}
test('publication intent and secret receipt commit atomically and unknown restart cannot reset them',async()=>{
  const f=fixture();try{const p=createBatch5Persistence(f.store,f.vault,taskId,()=>{});await p.saveIntent(intent);assert.equal(f.store.read().tasks[0].batch5?.stage,'submitting');assert.ok(f.store.getCipher(`publication:${taskId}`));await assert.rejects(p.saveIntent(intent));
    const next=createBatch5Persistence(f.store,f.vault,taskId,()=>{throw Error('no second authorization');});assert.deepEqual(await next.loadIntent(),intent);
    await next.saveReceipt({version:1,intent,publicUrl:'https://yeet.md/s/fixture',remoteId:'fixture',secret:'synthetic-delete-token',rawResponse:'{"id":"fixture"}'});
    assert.equal(JSON.stringify(f.store.read()).includes('synthetic-delete-token'),false);assert.equal(f.store.read().tasks[0].batch5?.stage,'api_receipt');
    assert.throws(()=>f.store.update(s=>{s.tasks[0].batch5=undefined;s.tasks[0].submittedAt=undefined;}));
    const raw=await f.vault.get(`publication:${taskId}`);assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[`publication:${taskId}`]:raw}}));
    assert.throws(()=>validateBackup({state:f.store.read(),secrets:{}}));
  }finally{f.close();}
});
test('encryption failure prevents both intent commit and network authorization',async()=>{
  const f=fixture();try{let authorized=0;const p=createBatch5Persistence(f.store,{...f.vault,encryptSecrets:()=>{throw Error('locked');}},taskId,()=>{authorized++;});await assert.rejects(p.saveIntent(intent));assert.equal(f.store.read().tasks[0].batch5,undefined);assert.equal(f.store.getCipher(`publication:${taskId}`),undefined);assert.equal(authorized,1);}finally{f.close();}
});
test('Rant rolling 24-hour budget and per-site identity are atomic',async()=>{
  const f=fixture();try{f.store.update(s=>{s.tasks=[];s.sites=[];for(let n=1;n<=4;n++){const id=`${n}2222222-2222-4222-8222-222222222222`;s.sites.push({...site,id});s.tasks.push(task({id:`${n}1111111-1111-4111-8111-111111111111`,siteId:id,channelId:'rant',sourceDomain:'rant.li'}));}});
    for(let n=1;n<=4;n++){const t=f.store.read().tasks[n-1],p=createBatch5AccountPersistence(f.store,f.vault,t.id,()=>{}),value={version:1 as const,channelId:'rant',siteId:t.siteId,operationId:`fixture-${n}`,requestHash:'3'.repeat(64),createdAt:at,username:`fixture${n}`,password:'synthetic-password'};if(n<=2){await p.saveAccountIntent(value);await assert.rejects(p.saveAccountIntent(value));}else await assert.rejects(p.saveAccountIntent(value));}
    assert.equal(f.store.read().accounts.length,2);assert.equal(JSON.stringify(f.store.read()).includes('synthetic-password'),false);
    const first=f.store.read().tasks[0],local=batch5LocalAccountId('rant',first.siteId);assert.equal(first.accountId,local);
  }finally{f.close();}
});

test('legacy registration without a summary releases after seven days from task creation without failure',()=>{
  const s=state(),rant={...CHANNELS.find(value=>value.id==='rant')!,trial:true};s.tasks[0].channelId='rant';claimChannelTrial(s,rant,s.tasks[0]);
  Object.assign(s.tasks[0],{status:'needs_input',checkpoint:'batch5_account_pending',reasonCode:'submission_unknown',accountId:batch5LocalAccountId('rant',siteId)});
  reconcileChannelTrials(s,[rant],new Date('2026-10-25T05:59:59.999Z'));
  assert.equal(s.settings.channelTrials?.rant.activeTaskId,taskId);
  reconcileChannelTrials(s,[rant],new Date('2026-10-25T06:00:00.000Z'));
  assert.equal(s.settings.channelTrials?.rant.activeTaskId,undefined);assert.equal(s.settings.channelTrials?.rant.failures,0);
  assert.equal(trialTaskAvailable(s,rant,taskId),false);
});

test('durable unknown registration expires once from intent creation and never becomes writable again',()=>{
  const s=state(),rant={...CHANNELS.find(value=>value.id==='rant')!,trial:true},registration={version:1 as const,channelId:'rant' as const,operationId:'rant-register-fixture',createdAt:at,stage:'request_unknown' as const};
  s.tasks[0].channelId='rant';claimChannelTrial(s,rant,s.tasks[0]);
  Object.assign(s.tasks[0],{status:'needs_input',checkpoint:'batch5_account_pending',reasonCode:'submission_unknown',accountId:batch5LocalAccountId('rant',siteId),batch5Registration:registration});
  reconcileChannelTrials(s,[rant],new Date('2026-10-25T05:59:59.999Z'));
  assert.equal(s.settings.channelTrials?.rant.activeTaskId,taskId);
  reconcileChannelTrials(s,[rant],new Date('2026-10-25T06:00:00.000Z'));
  reconcileChannelTrials(s,[rant],new Date('2026-10-26T06:00:00.000Z'));
  assert.equal(s.settings.channelTrials?.rant.failures,0);
  assert.equal(s.settings.channelTrials?.rant.activeTaskId,undefined);
  assert.equal(s.tasks[0].trialFailureOperationId,undefined);
  assert.equal(claimChannelTrial(s,rant,s.tasks[0]),false);
  const other=task({id:'33333333-3333-4333-8333-333333333333',channelId:'rant',sourceDomain:'rant.li',status:'queued'});s.tasks.push(other);
  assert.equal(claimChannelTrial(s,rant,other),true);
  assert.equal(trialTaskAvailable(migrateState(structuredClone(s)),rant,taskId),false);
});


test('ATProto local projections share DID ownership and cannot create a duplicate Leaflet identity',async()=>{
  const f=fixture(),accountId='77777777-7777-4777-8777-777777777777',second='88888888-8888-4888-8888-888888888888',did='did:plc:syntheticexample';
  try{
    f.store.update(s=>{s.sites.push({...site,id:second});s.accounts.push({id:accountId,channelId:'bluesky',email:'',username:did,status:'registered',hasPassword:true,credentialKind:'api_token',source:'imported',createdAt:at});s.accountBindings.push({id:accountId,siteId,channelId:'bluesky',accountId,createdAt:at,updatedAt:at});});
    f.store.setCipher(`account:${accountId}`,f.vault.encryptSecrets({secret:JSON.stringify({version:1,did,handle:'author.example.com',appPassword:'synthetic-app-password',accessJwt:'fixture-access',refreshJwt:'fixture-refresh'})}).secret);
    const projected=await reuseBlueskyForLeaflet(f.store,f.vault,siteId);assert.ok(projected);
    f.store.update(s=>{s.accountBindings.find(binding=>binding.channelId==='bluesky')!.siteId=second;});
    assert.equal(atprotoIdentityConflict(f.store.read(),did,second),true);
    assert.equal(await reuseBlueskyForLeaflet(f.store,f.vault,second),undefined);
    assert.equal(f.store.read().accounts.filter(account=>account.channelId==='leaflet').length,1);
    assert.equal(channelExecutionReadiness(f.store.read(),second,CHANNELS.find(c=>c.id==='whitewind')!).kind,'handoff_required');
  }finally{f.close();}
});


test('Rant rolling registration ceiling does not reset across local midnight',async()=>{
  const f=fixture();
  try{
    f.store.update(s=>{s.settings.timezone='Asia/Singapore';s.tasks[0].channelId='rant';s.tasks[0].sourceDomain='rant.li';for(let n=1;n<=3;n++)s.accounts.push({id:`${n}7777777-7777-4777-8777-777777777777`,channelId:'rant',email:'',username:`fixture${n}`,status:'unknown',hasPassword:false,source:'generated',credentialKind:'password',createdAt:'2026-10-17T23:30:00.000Z',registrationAttempts:1});});
    const p=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});
    await assert.rejects(p.saveAccountIntent({version:1,channelId:'rant',siteId,operationId:'daily-limit',requestHash:'a'.repeat(64),createdAt:'2026-10-18T01:00:00.000Z',username:'fixture-next',password:'synthetic-password'}));
    assert.equal(f.store.read().accounts.length,3);assert.equal(f.store.getCipher(`batch5:identity:rant:${siteId}`),undefined);
  }finally{f.close();}
});
