import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {batch5AccountDeletionPlan,batch5LocalAccountId,createBatch5AccountPersistence,createBatch5Persistence} from '../src/main/batch5-publication';
import {channelExecutionReadiness,setSelectedAccountSites,unbindAccount} from '../src/main/account-bindings';
import {claimChannelTrial} from '../src/main/channel-trials';
import {CHANNELS} from '../src/integrations/catalog';
import {validateBackup} from '../src/main/backup-validation';
import {emptyState,Store} from '../src/main/store';
import type {Batch5AccountIntent} from '../src/integrations/batch5-contract';
import type {Site,Task} from '../src/shared/types';

const at='2026-10-18T00:00:00.000Z',siteId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222';
const site:Site={id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Independent guides',category:'finance',language:'zh-CN',monthlyTarget:1,status:'ready',createdAt:at};
const task=(id=taskId):Task=>({id,siteId,channelId:'rant',sourceDomain:'rant.li',status:'running',createdAt:at,updatedAt:at,scheduledAt:at,attempts:1,message:'fixture'});
const intent:Batch5AccountIntent={version:1,channelId:'rant',siteId,operationId:'b5_account_fixture_operation',requestHash:'a'.repeat(64),createdAt:at,username:'example-site',password:'synthetic-password'};

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'linkflow-b5-registration-')),store=new Store(join(directory,'state.sqlite')),state=emptyState();
  state.settings.timezone='UTC';state.sites=[site];state.tasks=[task()];store.update(value=>Object.assign(value,state));
  const vault={
    get:async(key:string)=>{const cipher=store.getCipher(key);return cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():undefined},
    encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`])),
  };
  return {directory,store,vault,close(){store.close();rmSync(directory,{recursive:true,force:true})}};
}

test('registration intent persists its true clock and old backups remain compatible',async()=>{
  const f=fixture(),identityKey=`batch5:identity:rant:${siteId}`;
  try{
    const persistence=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});await persistence.saveAccountIntent(intent);
    const saved=f.store.read(),summary=saved.tasks[0].batch5Registration;
    assert.deepEqual(summary,{version:1,channelId:'rant',operationId:intent.operationId,createdAt:at,stage:'reserved',sendGuardVersion:1});
    assert.equal(saved.tasks[0].accountId,batch5LocalAccountId('rant',siteId));
    const raw=(await f.vault.get(identityKey))!;
    assert.doesNotThrow(()=>validateBackup({state:saved,secrets:{[identityKey]:raw}}));
    const old=structuredClone(saved);delete old.tasks[0].batch5Registration;
    const legacyJournal=JSON.parse(raw);delete legacyJournal.registration;
    assert.doesNotThrow(()=>validateBackup({state:old,secrets:{[identityKey]:JSON.stringify(legacyJournal)}}));
    assert.throws(()=>f.store.update(state=>{state.tasks[0].batch5Registration!.createdAt='2026-10-19T00:00:00.000Z'}));
  }finally{f.close()}
});

test('only durable no-request or definite rejection can delete a generated identity atomically',async()=>{
  for(const terminal of ['not_sent','rejected'] as const){
    const f=fixture(),identityKey=`batch5:identity:rant:${siteId}`;
    try{
      const persistence=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});await persistence.saveAccountIntent(intent);
      assert.equal(batch5AccountDeletionPlan(f.store,siteId).blocked,true);
      assert.throws(()=>f.store.updateWithCiphers(()=>{}, {},[identityKey]));
      if(terminal==='not_sent')await persistence.markAccountRegistration(intent,'not_sent');
      else await persistence.saveAccountOpaqueResponse({version:1,intent,status:409,contentType:'application/json',responseUrl:'https://rant.li/api/auth/signup',bodyBase64:Buffer.from('{"error":"collision"}').toString('base64'),bodyComplete:true});
      const plan=batch5AccountDeletionPlan(f.store,siteId);assert.equal(plan.blocked,false);assert.deepEqual(plan.cipherKeys,[identityKey]);
      const savedIdentity=(await f.vault.get(identityKey))!;
      assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[identityKey]:savedIdentity}}));
      assert.deepEqual(plan.accountIds,[batch5LocalAccountId('rant',siteId)]);
      f.store.updateWithCiphers(state=>{
        state.sites=state.sites.filter(value=>value.id!==siteId);state.tasks=state.tasks.filter(value=>value.siteId!==siteId);
        state.accountBindings=state.accountBindings.filter(value=>value.siteId!==siteId&&!plan.accountIds.includes(value.accountId));
        state.accounts=state.accounts.filter(value=>!plan.accountIds.includes(value.id));
      },{},plan.cipherKeys);
      assert.equal(f.store.getCipher(identityKey),undefined);assert.equal(f.store.read().accounts.length,0);
    }finally{f.close()}
  }
});

test('backup summaries cannot turn an unknown signup into a deletable or registered identity',async()=>{
  const f=fixture(),identityKey=`batch5:identity:rant:${siteId}`;
  try{
    const persistence=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});
    await persistence.saveAccountIntent(intent);await persistence.markAccountRegistration(intent,'request_unknown');
    const raw=(await f.vault.get(identityKey))!,state=f.store.read();
    for(const stage of ['not_sent','rejected','registered'] as const){
      const changed=structuredClone(state);changed.tasks[0].batch5Registration!.stage=stage;
      assert.throws(()=>validateBackup({state:changed,secrets:{[identityKey]:raw}}),/registration journal/,stage);
    }
    for(const change of ['operationId','createdAt','channelId','accountId'] as const){
      const changed=structuredClone(state),summary=changed.tasks[0].batch5Registration!;
      if(change==='operationId')summary.operationId='other-operation';
      if(change==='createdAt')summary.createdAt='2026-10-19T00:00:00.000Z';
      if(change==='channelId')summary.channelId='slopit';
      if(change==='accountId')changed.tasks[0].accountId=undefined;
      assert.throws(()=>validateBackup({state:changed,secrets:{[identityKey]:raw}}),change);
    }
    assert.throws(()=>validateBackup({state,secrets:{}}),/registration journal/);
    assert.equal(batch5AccountDeletionPlan(f.store,siteId).blocked,true);
  }finally{f.close()}
});

test('no-request backup requires durable journal proof rather than absence of a response',async()=>{
  const f=fixture(),identityKey=`batch5:identity:rant:${siteId}`;
  try{
    const persistence=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});
    await persistence.saveAccountIntent(intent);await persistence.markAccountRegistration(intent,'not_sent');
    const state=f.store.read(),raw=(await f.vault.get(identityKey))!;
    assert.doesNotThrow(()=>validateBackup({state,secrets:{[identityKey]:raw}}));
    const noProof=JSON.parse(raw);delete noProof.registration;
    assert.throws(()=>validateBackup({state,secrets:{[identityKey]:JSON.stringify(noProof)}}),/registration journal/);
  }finally{f.close()}
});

test('unknown and registered identities stay protected and no-request survives a later task',async()=>{
  const f=fixture();
  try{
    const first=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});await first.saveAccountIntent(intent);await first.markAccountRegistration(intent,'request_unknown');
    assert.equal(batch5AccountDeletionPlan(f.store,siteId).blocked,true);
    await first.saveAccountReceipt({version:1,intent,accountId:'example-site',publicUrl:'https://rant.li/example-site/',secret:'synthetic-token',rawResponse:'{"code":201}'});
    assert.equal(f.store.read().tasks[0].batch5Registration?.stage,'registered');assert.equal(batch5AccountDeletionPlan(f.store,siteId).blocked,true);
  }finally{f.close()}

  const secondFixture=fixture();
  try{
    const first=createBatch5AccountPersistence(secondFixture.store,secondFixture.vault,taskId,()=>{});await first.saveAccountIntent(intent);await first.markAccountRegistration(intent,'not_sent');
    const laterId='33333333-3333-4333-8333-333333333333';secondFixture.store.update(state=>state.tasks.push(task(laterId)));
    const later=createBatch5AccountPersistence(secondFixture.store,secondFixture.vault,laterId,()=>{});
    assert.deepEqual(await later.loadAccountRegistration('rant',siteId),{version:1,channelId:'rant',operationId:intent.operationId,createdAt:at,stage:'not_sent',sendGuardVersion:1});
    await assert.rejects(later.markAccountRegistration(intent,'request_unknown'));
    assert.equal(secondFixture.store.read().tasks[0].batch5Registration?.stage,'not_sent');
  }finally{secondFixture.close()}
});

test('legacy migrated origins cannot register again under a new site ID, while proven unaccepted requests remain recoverable',async()=>{
  for(const stage of ['request_unknown','registered','not_sent','rejected'] as const){
    const f=fixture(),restored=new Store(join(f.directory,'restored.sqlite'));
    try{
      const persistence=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});
      await persistence.saveAccountIntent(intent);
      if(stage==='registered')await persistence.saveAccountReceipt({version:1,intent,accountId:'example-site',publicUrl:'https://rant.li/example-site/',secret:'synthetic-token',rawResponse:'{}'});
      else if(stage==='rejected')await persistence.saveAccountOpaqueResponse({version:1,intent,status:409,contentType:'application/json',responseUrl:'https://rant.li/api/auth/signup',bodyBase64:Buffer.from('{}').toString('base64'),bodyComplete:true});
      else await persistence.markAccountRegistration(intent,stage);
      const legacy=f.store.read(),before={id:siteId,domain:site.domain,url:site.url,name:site.name,language:site.language,status:site.status,monthlyTarget:site.monthlyTarget};
      const after={domain:'example-site.com',url:'https://example-site.com',name:site.name,language:site.language};
      Object.assign(legacy.sites[0],after);
      legacy.siteOriginMigrations=[{version:1,siteId,migratedAt:at,before,after,telegraphTasks:[]}];
      restored.restore(legacy,f.store.allCiphers());
      const newSiteId='44444444-4444-4444-8444-444444444444',newTaskId='55555555-5555-4555-8555-555555555555';
      restored.update(state=>{state.sites.push({...site,id:newSiteId});state.tasks.push({...task(newTaskId),siteId:newSiteId});});
      const vault={...f.vault,get:async(key:string)=>{const value=restored.getCipher(key);return value?.startsWith('enc:')?Buffer.from(value.slice(4),'base64url').toString():undefined;}};
      const next=createBatch5AccountPersistence(restored,vault,newTaskId,()=>{}),newIntent={...intent,siteId:newSiteId,operationId:'new-site-operation'};
      if(stage==='registered'||stage==='request_unknown'){
        await assert.rejects(next.saveAccountIntent(newIntent),{name:'Batch5IdentitySingleSiteError'});
        assert.equal(restored.read().accounts.length,1);
        assert.equal(restored.getCipher(`batch5:identity:rant:${newSiteId}`),undefined);
      }else{
        await next.saveAccountIntent(newIntent);
        assert.equal(restored.read().accounts.length,2);
      }
    }finally{restored.close();f.close();}
  }
});

test('a proved-unsent signup can replace its operation without changing its identity',async()=>{
  const f=fixture(),identityKey=`batch5:identity:rant:${siteId}`;
  try{
    const persistence=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});
    await persistence.saveAccountIntent(intent);await persistence.markAccountRegistration(intent,'not_sent');
    const next={...intent,operationId:'b5_account_retry_operation',createdAt:'2026-10-19T00:00:00.000Z'};
    await persistence.replaceUnsentAccountIntent!(intent,next);
    const summary=f.store.read().tasks[0].batch5Registration;
    assert.equal(summary?.operationId,next.operationId);assert.equal(summary?.stage,'reserved');assert.equal(summary?.sendGuardVersion,1);
    assert.equal((await persistence.loadAccountIntent('rant',siteId))?.password,intent.password);
    const raw=(await f.vault.get(identityKey))!;
    assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[identityKey]:raw}}));
    await persistence.markAccountRegistration(next,'sending',next.createdAt);
    await assert.rejects(persistence.replaceUnsentAccountIntent!(next,{...next,operationId:'b5_account_third_operation'}));
    assert.equal(f.store.read().tasks[0].batch5Registration?.stage,'sending');
  }finally{f.close()}
});

test('a durable 429 releases one send slot after 24 hours, preserving the same intent',async()=>{
  const f=fixture(),identityKey=`batch5:identity:rant:${siteId}`;
  try{
    const persistence=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});
    await persistence.saveAccountIntent(intent);
    for(let count=1;count<=3;count++){
      const stamp=new Date(Date.parse(at)+(count-1)*86_400_000).toISOString();
      await persistence.markAccountRegistration(intent,'sending',stamp);
      await persistence.saveAccountOpaqueResponse({version:1,intent,status:429,contentType:'application/json',responseUrl:'https://rant.li/api/auth/signup',bodyBase64:Buffer.from('{}').toString('base64'),bodyComplete:true,receivedAt:stamp});
      const summary=f.store.read().tasks[0].batch5Registration;
      assert.equal(summary?.rateLimitCount,count);assert.equal(summary?.stage,count===3?'rejected':'rate_limited');
      const raw=(await f.vault.get(identityKey))!;
      assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[identityKey]:raw}}));
      if(count<3)await assert.rejects(persistence.markAccountRegistration(intent,'sending',new Date(Date.parse(stamp)+86_399_999).toISOString()));
    }
    await assert.rejects(persistence.markAccountRegistration(intent,'sending',new Date(Date.parse(at)+3*86_400_000).toISOString()));
    assert.equal((await persistence.loadAccountIntent('rant',siteId))?.operationId,intent.operationId);
  }finally{f.close()}
});

test('a legacy complete 429 revives the original intent and atomically undoes its wrongly counted trial failure',async()=>{
  const f=fixture(),identityKey=`batch5:identity:rant:${siteId}`,observedAt='2026-10-20T00:00:00.000Z';
  let legacyStore:Store|undefined,reopened:Store|undefined,manualStore:Store|undefined;
  try{
    const persistence=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});
    await persistence.saveAccountIntent(intent);
    await persistence.markAccountRegistration(intent,'sending',at);
    await persistence.saveAccountOpaqueResponse({version:1,intent,status:429,contentType:'application/json',responseUrl:'https://rant.li/api/auth/signup',bodyBase64:Buffer.from('{}').toString('base64'),bodyComplete:true,receivedAt:at,responseExact:true});
    const legacyJournal=JSON.parse((await f.vault.get(identityKey))!);
    legacyJournal.registration={version:1,channelId:'rant',operationId:intent.operationId,createdAt:at,stage:'rejected'};
    delete legacyJournal.opaque.receivedAt;delete legacyJournal.opaque.responseExact;
    const legacyCipher=f.vault.encryptSecrets({[identityKey]:JSON.stringify(legacyJournal)});
    const legacyState=f.store.read();
    legacyState.tasks[0].batch5Registration=legacyJournal.registration;
    legacyState.tasks[0].status='needs_input';legacyState.tasks[0].reasonCode='channel_disabled';
    legacyState.tasks[0].trialFailure='legacy 429';legacyState.tasks[0].trialFailureOperationId=intent.operationId;
    legacyState.settings.channelTrials={rant:{trial:true,failures:2,evaluatedTaskIds:[taskId],evaluatedFailureOperationIds:['other-failure',intent.operationId],disabledAt:at,autoDisabledOverride:true,reason:'legacy 429'}};
    legacyState.settings.channelOverrides.rant=false;
    assert.doesNotThrow(()=>validateBackup({state:legacyState,secrets:{[identityKey]:JSON.stringify(legacyJournal)}}));
    legacyStore=new Store(join(f.directory,'legacy.sqlite'));
    legacyStore.restore(legacyState,{...f.store.allCiphers(),...legacyCipher});
    legacyStore.close();legacyStore=undefined;
    reopened=new Store(join(f.directory,'legacy.sqlite'));
    const reopenedVault={...f.vault,get:async(key:string)=>{const cipher=reopened!.getCipher(key);return cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():undefined}};
    const revived=createBatch5AccountPersistence(reopened,reopenedVault,taskId,()=>{});
    await revived.reviveLegacyRateLimit!(intent,observedAt);
    const state=reopened.read(),trial=state.settings.channelTrials?.rant;
    assert.equal(state.tasks[0].batch5Registration?.stage,'rate_limited');
    assert.equal(state.tasks[0].batch5Registration?.rateLimitCount,1);
    assert.equal(state.tasks[0].batch5Registration?.lastRateLimitedAt,observedAt);
    assert.equal(state.tasks[0].batch5Registration?.operationId,intent.operationId);
    assert.equal(state.tasks[0].trialFailure,undefined);assert.equal(state.tasks[0].trialFailureOperationId,undefined);
    assert.equal(trial?.failures,1);assert.deepEqual(trial?.evaluatedFailureOperationIds,['other-failure']);
    assert.equal(trial?.disabledAt,undefined);assert.equal(trial?.autoDisabledOverride,undefined);
    assert.equal(state.settings.channelOverrides.rant,undefined);
    const revivedRaw=(await reopenedVault.get(identityKey))!;
    assert.doesNotThrow(()=>validateBackup({state,secrets:{[identityKey]:revivedRaw}}));
    await assert.rejects(revived.markAccountRegistration(intent,'sending','2026-10-20T23:59:59.999Z'));
    await revived.markAccountRegistration(intent,'sending','2026-10-21T00:00:00.000Z');
    assert.equal((await revived.loadAccountIntent('rant',siteId))?.operationId,intent.operationId);
    assert.equal((await revived.loadAccountOpaqueResponse('rant',siteId)),undefined);
    legacyState.settings.channelTrials!.rant.autoDisabledOverride=false;
    manualStore=new Store(join(f.directory,'manual.sqlite'));
    manualStore.restore(legacyState,{...f.store.allCiphers(),...legacyCipher});
    const manualVault={...f.vault,get:async(key:string)=>{const cipher=manualStore!.getCipher(key);return cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():undefined}};
    await createBatch5AccountPersistence(manualStore,manualVault,taskId,()=>{}).reviveLegacyRateLimit!(intent,observedAt);
    const manuallyDisabled=manualStore.read();
    assert.equal(manuallyDisabled.settings.channelTrials?.rant.failures,1);
    assert.equal(manuallyDisabled.settings.channelTrials?.rant.disabledAt,at);
    assert.equal(manuallyDisabled.settings.channelOverrides.rant,false);
  }finally{manualStore?.close();reopened?.close();legacyStore?.close();f.close()}
});

test('legacy 401/403/409 and unproved reserved intents never revive as a 429',async()=>{
  for(const status of [401,403,409]){
    const f=fixture(),identityKey=`batch5:identity:rant:${siteId}`;
    try{
      const persistence=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});
      await persistence.saveAccountIntent(intent);
      await persistence.markAccountRegistration(intent,'sending',at);
      await persistence.saveAccountOpaqueResponse({version:1,intent,status,contentType:'application/json',responseUrl:'https://rant.li/api/auth/signup',bodyBase64:Buffer.from('{}').toString('base64'),bodyComplete:true,responseExact:true});
      const legacyJournal=JSON.parse((await f.vault.get(identityKey))!);
      delete legacyJournal.registration.sendGuardVersion;
      const cipher=f.vault.encryptSecrets({[identityKey]:JSON.stringify(legacyJournal)});
      f.store.updateWithCiphers(state=>{delete state.tasks[0].batch5Registration!.sendGuardVersion},cipher,[],{[identityKey]:f.store.getCipher(identityKey)});
      assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[identityKey]:JSON.stringify(legacyJournal)}}));
      await assert.rejects(persistence.reviveLegacyRateLimit!(intent,'2026-10-20T00:00:00.000Z'));
      assert.equal(f.store.read().tasks[0].batch5Registration?.stage,'rejected');
    }finally{f.close()}
  }
  const f=fixture(),identityKey=`batch5:identity:rant:${siteId}`;
  try{
    const persistence=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});
    await persistence.saveAccountIntent(intent);
    const legacyJournal=JSON.parse((await f.vault.get(identityKey))!);
    delete legacyJournal.registration.sendGuardVersion;
    const cipher=f.vault.encryptSecrets({[identityKey]:JSON.stringify(legacyJournal)});
    f.store.updateWithCiphers(state=>{delete state.tasks[0].batch5Registration!.sendGuardVersion},cipher,[],{[identityKey]:f.store.getCipher(identityKey)});
    await assert.rejects(persistence.reviveLegacyRateLimit!(intent,'2026-10-20T00:00:00.000Z'));
    await assert.rejects(persistence.markAccountRegistration(intent,'sending','2026-10-20T00:00:00.000Z'));
    assert.equal(f.store.read().tasks[0].batch5Registration?.stage,'reserved');
  }finally{f.close()}
});

test('third exact 429 is a durable terminal refusal even when its response body is incomplete',async()=>{
  const f=fixture(),identityKey=`batch5:identity:rant:${siteId}`;
  let reopened:Store|undefined;
  try{
    const persistence=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});
    await persistence.saveAccountIntent(intent);
    for(let count=1;count<=3;count++){
      const stamp=new Date(Date.parse(at)+(count-1)*86_400_000).toISOString();
      await persistence.markAccountRegistration(intent,'sending',stamp);
      await persistence.saveAccountOpaqueResponse({version:1,intent,status:429,contentType:'application/json',responseUrl:'https://rant.li/api/auth/signup',bodyBase64:count===3?'':Buffer.from('{}').toString('base64'),bodyComplete:count<3,receivedAt:stamp,responseExact:true});
    }
    assert.equal(f.store.read().tasks[0].batch5Registration?.stage,'rejected');
    assert.equal(f.store.read().tasks[0].batch5Registration?.rateLimitCount,3);
    const raw=(await f.vault.get(identityKey))!;
    assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[identityKey]:raw}}));
    reopened=new Store(join(f.directory,'state.sqlite'));
    const reopenedVault={...f.vault,get:async(key:string)=>{const cipher=reopened!.getCipher(key);return cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():undefined}};
    const read=createBatch5AccountPersistence(reopened,reopenedVault,taskId,()=>{});
    assert.equal((await read.loadAccountRegistration('rant',siteId))?.stage,'rejected');
    assert.equal((await read.loadAccountOpaqueResponse('rant',siteId))?.bodyComplete,false);
    await assert.rejects(read.markAccountRegistration(intent,'sending','2026-10-21T00:00:00.000Z'));
  }finally{reopened?.close();f.close()}
});

test('exact 401/403/409 headers remain durable refusals when the response body is incomplete',async()=>{
  for(const status of [401,403,409]){
    const f=fixture(),identityKey=`batch5:identity:rant:${siteId}`;
    let reopened:Store|undefined;
    try{
      const persistence=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});
      await persistence.saveAccountIntent(intent);
      await persistence.markAccountRegistration(intent,'sending',at);
      await persistence.saveAccountOpaqueResponse({version:1,intent,status,contentType:'application/json',responseUrl:'https://rant.li/api/auth/signup',bodyBase64:'',bodyComplete:false,responseExact:true});
      assert.equal(f.store.read().tasks[0].batch5Registration?.stage,'rejected');
      const raw=(await f.vault.get(identityKey))!;
      assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[identityKey]:raw}}));
      reopened=new Store(join(f.directory,'state.sqlite'));
      const vault={...f.vault,get:async(key:string)=>{const cipher=reopened!.getCipher(key);return cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():undefined}};
      const read=createBatch5AccountPersistence(reopened,vault,taskId,()=>{});
      assert.equal((await read.loadAccountRegistration('rant',siteId))?.stage,'rejected');
      assert.equal((await read.loadAccountOpaqueResponse('rant',siteId))?.bodyComplete,false);
      await assert.rejects(read.markAccountRegistration(intent,'sending',at));
    }finally{reopened?.close();f.close()}
  }
});

test('rejected and uncertain generated identities are unavailable to the scheduler',async()=>{
  const channel=CHANNELS.find(value=>value.id==='rant');assert.ok(channel);
  for(const stage of ['not_sent','sending','request_unknown','rejected'] as const){
    const f=fixture();
    try{
      const persistence=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});
      await persistence.saveAccountIntent(intent);
      if(stage==='rejected')await persistence.saveAccountOpaqueResponse({version:1,intent,status:409,contentType:'application/json',responseUrl:'https://rant.li/api/auth/signup',bodyBase64:Buffer.from('{}').toString('base64'),bodyComplete:true});
      else await persistence.markAccountRegistration(intent,stage,at);
      assert.equal(channelExecutionReadiness(f.store.read(),siteId,channel).kind,stage==='not_sent'?'autocreate':'handoff_required');
    }finally{f.close()}
  }
});

test('signup sending time is durable and survives an unknown response',async()=>{
  const f=fixture(),identityKey=`batch5:identity:rant:${siteId}`,sentAt='2026-10-20T00:00:00.000Z';
  try{
    const persistence=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});
    await persistence.saveAccountIntent(intent);
    await persistence.markAccountRegistration(intent,'sending',sentAt);
    await persistence.markAccountRegistration(intent,'request_unknown');
    assert.equal(f.store.read().tasks[0].batch5Registration?.sentAt,sentAt);
    const raw=(await f.vault.get(identityKey))!;
    assert.equal(JSON.parse(raw).registration.sentAt,sentAt);
    assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[identityKey]:raw}}));
  }finally{f.close()}
});

test('reserved publication begins its seven-day clock when sending is durably recorded',async t=>{
  const f=fixture(),publicationKey=`publication:${taskId}`;
  const publication={version:1 as const,channelId:'rant',siteId,operationId:'b5_publication_delayed',sourceHash:'a'.repeat(64),requestHash:'b'.repeat(64),createdAt:at};
  try{
    const persistence=createBatch5Persistence(f.store,f.vault,taskId,()=>{});
    await persistence.reserveIntent!(publication);
    f.store.update(state=>claimChannelTrial(state,CHANNELS.find(value=>value.id==='rant')!,state.tasks[0]));
    const sentAt='2026-10-30T00:00:00.000Z';t.mock.timers.enable({apis:['Date'],now:Date.parse(sentAt)});
    await persistence.markSending!(publication);
    const saved=f.store.read().tasks[0];
    assert.equal(saved.submittedAt,at,'intent identity remains unchanged');
    assert.equal(saved.trialSendStartedAt,sentAt);
    assert.equal(f.store.read().settings.channelTrials?.rant.activeTaskId,taskId,'the old reservation is not timed out before POST');
    assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[publicationKey]:(f.store.getCipher(publicationKey)??'').startsWith('enc:')?Buffer.from(f.store.getCipher(publicationKey)!.slice(4),'base64url').toString():''}}));
  }finally{f.close()}
});

test('account editor rejects removing a generated Rant binding and readiness keeps the rejected site blocked',async()=>{
  const f=fixture(),channel=CHANNELS.find(value=>value.id==='rant')!;
  try{
    const persistence=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});
    await persistence.saveAccountIntent(intent);
    await persistence.saveAccountOpaqueResponse({version:1,intent,status:409,contentType:'application/json',responseUrl:'https://rant.li/api/auth/signup',bodyBase64:Buffer.from('{}').toString('base64'),bodyComplete:true});
    const accountId=batch5LocalAccountId('rant',siteId),before=f.store.read();
    assert.throws(()=>f.store.update(state=>setSelectedAccountSites(state,accountId,new Set(),channel)));
    assert.deepEqual(f.store.read(),before,'the editor transaction rolls back');
    assert.equal(channelExecutionReadiness(before,siteId,channel).kind,'handoff_required');
    const broken=structuredClone(before);broken.accountBindings=[];
    assert.equal(channelExecutionReadiness(broken,siteId,channel).kind,'handoff_required','summary blocks even if an older build removed the binding');
    assert.equal(batch5AccountDeletionPlan(f.store,siteId).blocked,false);
  }finally{f.close()}
});

test('a software-generated Rant account cannot lose its site binding',async()=>{
  const f=fixture();
  try{
    const persistence=createBatch5AccountPersistence(f.store,f.vault,taskId,()=>{});
    await persistence.saveAccountIntent(intent);await persistence.markAccountRegistration(intent,'not_sent');
    const accountId=batch5LocalAccountId('rant',siteId);
    assert.throws(()=>f.store.update(state=>unbindAccount(state,accountId,siteId,'rant')));
    assert.equal(f.store.read().accountBindings.find(value=>value.accountId===accountId)?.siteId,siteId);
    assert.equal(batch5AccountDeletionPlan(f.store,siteId).blocked,false);
  }finally{f.close()}
});

test('publication reserve survives authorization loss without a submitted timestamp',async()=>{
  const f=fixture(),publicationKey=`publication:${taskId}`;
  const publication={version:1 as const,channelId:'rant',siteId,operationId:'b5_publication_fixture',sourceHash:'a'.repeat(64),requestHash:'b'.repeat(64),createdAt:at};
  try{
    let authorized=true;
    const persistence=createBatch5Persistence(f.store,f.vault,taskId,()=>{if(!authorized)throw Error('authorization changed')});
    await persistence.reserveIntent!(publication);authorized=false;
    await assert.rejects(persistence.markSending!(publication));
    assert.equal(f.store.read().tasks[0].batch5?.stage,'reserved');assert.equal(f.store.read().tasks[0].submittedAt,undefined);
    const raw=(await f.vault.get(publicationKey))!;
    assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[publicationKey]:raw}}));
    authorized=true;await persistence.markSending!(publication);
    assert.equal(f.store.read().tasks[0].batch5?.stage,'submitting');assert.equal(f.store.read().tasks[0].submittedAt,at);
    await assert.rejects(persistence.markSending!(publication));
  }finally{f.close()}
});
