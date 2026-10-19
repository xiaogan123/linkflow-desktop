import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS} from '../src/integrations/catalog';
import {synthfolkStructuredProfile} from '../src/integrations/synthfolk-publisher';
import {accountForSiteChannel,channelExecutionReadiness,bindAccount,unresolvedIdentityPublication} from '../src/main/account-bindings';
import {firstIdentitySite,migrateIdentityOwners,retireAccount,siteOwnedIdentityIds,transferIdentityOwner} from '../src/main/account-retirement';
import {saveAccountAtomic} from '../src/main/account-service';
import {emptyState,migrateState,Store} from '../src/main/store';
import {hasLegacyPublicIdentityMarker} from '../src/shared/public-identity-policy';
import type {Account,Channel,Site,Snapshot,Task} from '../src/shared/types';
import {channelReadinessForDisplay} from '../src/ui/presentation';
import {Controller} from '../src/main/controller';
import type {Vault} from '../src/main/vault';

const at='2026-10-18T00:00:00.000Z';
const siteA='11111111-1111-4111-8111-111111111111';
const siteB='22222222-2222-4222-8222-222222222222';
const accountId='33333333-3333-4333-8333-333333333333';
const taskA='44444444-4444-4444-8444-444444444444';
const taskB='55555555-5555-4555-8555-555555555555';
const bindingA='66666666-6666-4666-8666-666666666666';

function site(id:string,name='Example Site'):Site{return {id,domain:'example.com',url:'https://example.com/',name,description:'Educational content.',email:'owner@example.com',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:at}}
function task(id:string,siteId:string,channelId:string,checkpoint='account_registration_submitted'):Task{return {id,siteId,channelId,accountId,sourceDomain:'example.com',status:'needs_input',checkpoint,attempts:1,createdAt:at,scheduledAt:at,updatedAt:at,message:''}}
function account(channelId:string,source:'generated'|'imported'='generated'):Account{return {id:accountId,channelId,email:'owner@example.com',username:'example-author',createdAt:at,status:'unknown',hasPassword:false,source}}
function binding(siteId:string,channelId:string,id=bindingA){return {id,siteId,channelId,accountId,createdAt:at,updatedAt:at}}

test('owner migration prefers the registration task, freezes ties by site date/id and transfers only after exact confirmation',()=>{
  const state=emptyState();state.sites=[site(siteB),site(siteA)];state.accounts=[account('example-channel')];
  state.accountBindings=[{...binding(siteB,'example-channel'),createdAt:'2026-10-01T00:00:00.000Z'}];
  state.tasks=[task(taskB,siteB,'example-channel'),task(taskA,siteA,'example-channel')];
  assert.equal(firstIdentitySite(state,accountId,'example-channel'),siteA);
  migrateIdentityOwners(state);
  assert.equal(state.accounts[0].ownerSiteId,siteA);
  state.tasks[0].createdAt='2026-09-01T00:00:00.000Z';
  assert.equal(firstIdentitySite(state,accountId,'example-channel'),siteA);
  // While a registration is in flight the profile already names site A: no transfer.
  assert.throws(()=>transferIdentityOwner(state,accountId,siteB,{confirmed:true,fromSiteId:siteA,toSiteId:siteB}),/公开资料/);
  for(const item of state.tasks)item.checkpoint='draft';
  assert.throws(()=>transferIdentityOwner(state,accountId,siteB,{confirmed:true,fromSiteId:siteB,toSiteId:siteB}),/确认/);
  transferIdentityOwner(state,accountId,siteB,{confirmed:true,fromSiteId:siteA,toSiteId:siteB});
  assert.equal(state.accounts[0].ownerSiteId,siteB);
  assert.throws(()=>transferIdentityOwner(state,accountId,'77777777-7777-4777-8777-777777777777',{confirmed:true,fromSiteId:siteB,toSiteId:'77777777-7777-4777-8777-777777777777'}),/不存在/);
  state.accounts[0].status='registered';
  assert.throws(()=>transferIdentityOwner(state,accountId,siteA,{confirmed:true,fromSiteId:siteB,toSiteId:siteA}),/公开资料/);
});

test('binding a newly generated identity freezes its initiating site immediately',()=>{
  const state=emptyState();state.sites=[site(siteA),site(siteB)];state.accounts=[account('example-channel')];
  const channel={id:'example-channel',automation:'browser',kind:'article',accountRequired:true} as Channel;
  bindAccount(state,accountId,siteA,channel,new Date(at));
  assert.equal(state.accounts[0].ownerSiteId,siteA);
});

test('equal task timestamps choose older site creation before site id',()=>{
  const state=emptyState();state.sites=[{...site(siteA),createdAt:'2026-10-19T00:00:00.000Z'},site(siteB)];
  state.accounts=[account('example-channel')];
  state.tasks=[task(taskA,siteA,'example-channel'),task(taskB,siteB,'example-channel')];
  migrateIdentityOwners(state);
  assert.equal(state.accounts[0].ownerSiteId,siteB);
});

test('account edit retains existing binding records, binds only additions and limits retired edits to local mailbox',()=>{
  const store=new Store(':memory:');
  const channel={id:'example-channel',automation:'browser',kind:'article',accountRequired:true} as Channel;
  try{
    const original=binding(siteA,channel.id);
    store.update(state=>{
      state.sites=[site(siteA),site(siteB)];state.accounts=[account(channel.id,'imported')];state.accountBindings=[original];
      state.mailboxes=[{id:'77777777-7777-4777-8777-777777777777',label:'Local Inbox',host:'mail.example.com',port:993,user:'owner@example.com',secure:true,hasPassword:false,aliases:[],createdAt:at,updatedAt:at}];
    });
    saveAccountAtomic(store,{id:accountId,channelId:channel.id,email:'owner@example.com',username:'example-author',siteIds:[siteA,siteB]},channel,()=>{throw Error('no encryption expected')},new Date('2026-10-19T00:00:00.000Z'));
    const after=store.read();
    assert.deepEqual(after.accountBindings.find(value=>value.siteId===siteA),original);
    assert.equal(after.accountBindings.find(value=>value.siteId===siteB)?.createdAt,'2026-10-19T00:00:00.000Z');
    store.update(state=>retireAccount(state,accountId,new Date(at)));
    const retiredBindings=store.read().accountBindings;
    saveAccountAtomic(store,{id:accountId,channelId:channel.id,email:'owner@example.com',username:'example-author',mailboxId:'77777777-7777-4777-8777-777777777777',siteIds:[siteA,siteB]},channel,()=>{throw Error('no encryption expected')});
    assert.equal(store.read().accounts[0].mailboxId,'77777777-7777-4777-8777-777777777777');
    assert.deepEqual(store.read().accountBindings,retiredBindings);
    assert.throws(()=>saveAccountAtomic(store,{id:accountId,channelId:channel.id,email:'owner@example.com',username:'replacement',siteIds:[siteA,siteB]},channel,()=>({})),/已退役/);
    assert.throws(()=>saveAccountAtomic(store,{id:accountId,channelId:channel.id,email:'owner@example.com',username:'example-author',password:'replacement',siteIds:[siteA,siteB]},channel,()=>({})),/已退役/);
    assert.throws(()=>saveAccountAtomic(store,{id:accountId,channelId:channel.id,email:'owner@example.com',username:'example-author',siteIds:[siteA]},channel,()=>({})),/已退役/);
  }finally{store.close()}
});

test('changing a single-site imported binding removes the old site before validating the new one',()=>{
  const store=new Store(':memory:');
  const channel={id:'example-channel',automation:'browser',kind:'article',accountRequired:true,singleSiteOnly:true} as Channel;
  try{
    store.update(state=>{state.sites=[site(siteA),site(siteB)];state.accounts=[account(channel.id,'imported')];state.accountBindings=[binding(siteA,channel.id)]});
    saveAccountAtomic(store,{id:accountId,channelId:channel.id,email:'owner@example.com',username:'example-author',siteIds:[siteB]},channel,()=>({}));
    assert.deepEqual(store.read().accountBindings.map(value=>value.siteId),[siteB]);
  }finally{store.close()}
});

test('a frozen generated owner rejects a no-task A-to-B edit until the exact transfer is confirmed',()=>{
  const store=new Store(':memory:');
  const channel={id:'example-channel',automation:'browser',kind:'article',accountRequired:true,singleSiteOnly:true} as Channel;
  const input={id:accountId,channelId:channel.id,email:'owner@example.com',username:'example-author',siteIds:[siteB]};
  try{
    store.update(state=>{state.sites=[site(siteA),site(siteB)];state.accounts=[account(channel.id)];bindAccount(state,accountId,siteA,channel,new Date(at))});
    assert.equal(store.read().accounts[0].ownerSiteId,siteA);
    assert.throws(()=>saveAccountAtomic(store,input,channel,()=>({})),/归属其他网站/);
    assert.deepEqual(store.read().accountBindings.map(value=>value.siteId),[siteA]);
    store.update(state=>transferIdentityOwner(state,accountId,siteB,{confirmed:true,fromSiteId:siteA,toSiteId:siteB}));
    saveAccountAtomic(store,input,channel,()=>({}));
    assert.deepEqual(store.read().accountBindings.map(value=>value.siteId),[siteB]);
    assert.equal(store.read().accounts[0].ownerSiteId,siteB);
  }finally{store.close()}
});

test('Telegraph submitted registration without submittedAt blocks replacement in backend and display',()=>{
  const state=emptyState(),channel=CHANNELS.find(item=>item.id==='telegraph')!;
  state.sites=[site(siteA),site(siteB)];state.accounts=[account('telegraph')];
  state.accountBindings=[binding(siteA,'telegraph'),binding(siteB,'telegraph','77777777-7777-4777-8777-777777777777')];
  state.tasks=[task(taskA,siteA,'telegraph')];
  assert.equal(unresolvedIdentityPublication(state,siteA,'telegraph')?.id,taskA);
  assert.equal(channelExecutionReadiness(state,siteA,channel).kind,'handoff_required');
  assert.equal(channelReadinessForDisplay({...state,channels:[channel]} as unknown as Snapshot,state.sites[0],channel),'handoff_required');
  state.tasks[0].checkpoint='account_handoff';
  assert.equal(unresolvedIdentityPublication(state,siteA,'telegraph'),undefined);
  assert.equal(channelExecutionReadiness(state,siteA,channel).kind,'autocreate');
  assert.equal(channelReadinessForDisplay({...state,channels:[channel]} as unknown as Snapshot,state.sites[0],channel),'autocreate');
});

test('generated Synthfolk profile removes tool marker from public labels but keeps the exact Website destination',()=>{
  const branded={...site(siteA,'Linkflow Guides'),domain:'linkflow.example.com',url:'https://linkflow.example.com/'};
  const target='https://linkflow.example.com/guide';
  const draft={title:'Linkflow Research Assistant',description:'Assistant for Linkflow guides',body:'Linkflow material is reviewed by a human.'};
  const profile=synthfolkStructuredProfile({draft,topicUrl:target},branded,undefined,accountId);
  assert.equal(profile.website,target);
  assert.doesNotMatch([profile.handle,profile.name,profile.headline,profile.about].join(' '),/linkflow/i);
  assert.equal(hasLegacyPublicIdentityMarker({...account('synthfolk'),username:profile.handle,displayName:profile.name,synthfolk:{version:1,stage:'ready',operationId:'fixture',requestHash:'fixture',sourceHash:'fixture',...profile,claimed:true}}),false);
});

test('restoring an older backup cannot revive an account retired after that backup',()=>{
  const store=new Store(':memory:');
  try{
    store.update(state=>{state.sites=[site(siteA)];state.accounts=[account('example-channel','imported')]});
    const backup=structuredClone(migrateState(store.read()));
    store.update(state=>retireAccount(state,accountId,new Date(at)));
    store.restore(backup,{});
    assert.equal(store.read().accounts[0].retiredAt,at);
  }finally{store.close()}
});

test('a deleted owner site no longer locks its identity, and a published identity cannot be moved to another site',()=>{
  const state=emptyState();state.sites=[site(siteA),site(siteB)];state.accounts=[{...account('example-channel'),ownerSiteId:'77777777-7777-4777-8777-777777777777'}];
  // The frozen owner was deleted: ownership is derived again from what is left.
  assert.equal(firstIdentitySite(state,accountId,'example-channel'),undefined);
  state.tasks=[task(taskB,siteB,'example-channel')];
  assert.equal(firstIdentitySite(state,accountId,'example-channel'),siteB);
  // Once it has submitted for its site, its public history stays with that site.
  state.accounts[0].ownerSiteId=siteB;state.tasks[0]={...state.tasks[0],submittedAt:at};
  assert.throws(()=>transferIdentityOwner(state,accountId,siteA,{confirmed:true,fromSiteId:siteB,toSiteId:siteA}),/不能改归其他网站/);
  state.accounts=[{...state.accounts[0],channelId:'telegraph'}];
  assert.throws(()=>transferIdentityOwner(state,accountId,siteA,{confirmed:true,fromSiteId:siteB,toSiteId:siteA}),/不能转移/);
});

test('deleting a site retires its own generated identity so no other site takes it over, and restoring the site brings it back',()=>{
  const store=new Store(':memory:');
  const channel={id:'example-channel',automation:'browser',kind:'article',accountRequired:true,singleSiteOnly:true} as Channel;
  store.update(state=>{state.settings.autoRun=false;state.sites=[site(siteA),site(siteB)];state.accounts=[account(channel.id)];bindAccount(state,accountId,siteA,channel,new Date(at))});
  const backup=structuredClone(store.read());
  const controller=new Controller(store,{ready:true,get:async()=>undefined} as unknown as Vault,'fixture',{});
  try{
    controller.deleteSite(siteA);
    let state=store.read();
    const kept=state.accounts.find(item=>item.id===accountId)!;
    assert.ok(kept.retiredAt);assert.equal(kept.retiredReason,'site_deleted');assert.equal(kept.retiredSiteId,siteA);
    assert.equal(accountForSiteChannel(state,siteB,channel.id),undefined);
    // Site B may still get its own identity: it is treated as if the deleted site's one did not exist.
    const without=structuredClone(state);without.accounts=[];without.accountBindings=[];
    assert.equal(channelExecutionReadiness(state,siteB,channel).kind,channelExecutionReadiness(without,siteB,channel).kind);
    store.restore(backup,{});state=store.read();
    assert.equal(state.accounts.find(item=>item.id===accountId)?.retiredAt,undefined);
    assert.equal(accountForSiteChannel(state,siteA,channel.id)?.id,accountId);
  }finally{controller.stop();store.close()}
});


test('a shared identity another site still uses is not retired with a deleted site',()=>{
  const state=emptyState();state.sites=[site(siteA),site(siteB)];
  state.accounts=[{...account('telegraph'),ownerSiteId:siteA}];
  state.accountBindings=[binding(siteA,'telegraph'),binding(siteB,'telegraph','77777777-7777-4777-8777-777777777777')];
  assert.deepEqual(siteOwnedIdentityIds(state,siteA),[]);
  state.accountBindings=[binding(siteA,'telegraph')];
  assert.deepEqual(siteOwnedIdentityIds(state,siteA),[accountId]);
});
