import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS} from '../src/integrations/catalog';
import {accountForSiteChannel,bindAccount,bindSelectedAccountSites,channelExecutionReadiness,isLegacySharedGeneratedTaskAccount,unresolvedIdentityPublication} from '../src/main/account-bindings';
import {retireAccount,retireLegacyAccounts} from '../src/main/account-retirement';
import {validateBackup} from '../src/main/backup-validation';
import {emptyState,migrateState,Store} from '../src/main/store';
import type {Account,Site,Task} from '../src/shared/types';

const stamp='2026-10-18T00:00:00.000Z';
const siteId='11111111-1111-4111-8111-111111111111',otherId='22222222-2222-4222-8222-222222222222',accountId='33333333-3333-4333-8333-333333333333';
function site(id=siteId):Site{return {id,domain:'example.com',url:'https://example.com/',name:'Example Site',description:'Public educational guides.',email:'owner@example.com',category:'content',language:'en',monthlyTarget:2,status:'ready',createdAt:stamp}}
function fixture(channelId='nostr'){
  const state=emptyState();state.sites=[site(),site(otherId)];
  const account:Account={id:accountId,channelId,email:'',username:'a'.repeat(64),source:'generated',status:'registered',createdAt:stamp,hasPassword:true,credentialKind:'api_token'};state.accounts=[account];
  state.accountBindings=[{id:'44444444-4444-4444-8444-444444444444',siteId:otherId,channelId,accountId,createdAt:stamp,updatedAt:stamp}];
  const task:Task={id:'55555555-5555-4555-8555-555555555555',siteId,channelId,accountId,sourceDomain:CHANNELS.find(item=>item.id===channelId)!.domain,status:'needs_input',checkpoint:'account_handoff',attempts:0,createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,message:''};state.tasks=[task];
  return {state,account,task,channel:CHANNELS.find(item=>item.id===channelId)!};
}

for(const id of ['nostr','telegraph']){
  test(`${id}: an unbound task still identifies a legacy shared identity`,()=>{
    const {state,task}=fixture(id);assert.equal(isLegacySharedGeneratedTaskAccount(state,task),true);
    state.accountBindings.push({...state.accountBindings[0],id:'different',siteId,accountId:'new-account'});
    assert.equal(isLegacySharedGeneratedTaskAccount(state,task),false);
  });
  test(`${id}: readiness and binding use the same bounded pending publication guard`,()=>{
    const {state,task,channel}=fixture(id);task.submittedAt=stamp;task.checkpoint=id==='telegraph'?'telegraph_publish_uncertain':'nostr_publish_submitting';
    const replacement={...state.accounts[0],id:'66666666-6666-4666-8666-666666666666'};state.accounts.push(replacement);
    assert.equal(channelExecutionReadiness(state,siteId,channel).blockingTask?.id,task.id);
    assert.throws(()=>bindAccount(state,replacement.id,siteId,channel),new RegExp(task.id));
    for(const patch of [{reconcileAttempts:3},{status:'skipped'},{status:'expired'},{deferredAt:stamp},{reviewUntil:'2026-01-01T00:00:00.000Z'}] as Partial<Task>[]){
      const copy=structuredClone(state);Object.assign(copy.tasks[0],patch);
      assert.equal(unresolvedIdentityPublication(copy,siteId,id,replacement.id),undefined);
      assert.equal(channelExecutionReadiness(copy,siteId,channel).kind,'autocreate');
      assert.doesNotThrow(()=>bindAccount(copy,replacement.id,siteId,channel));
    }
  });
}

test('shared registered identity stays usable for its frozen owner and Rentry anonymous identity has no public-owner conflict',()=>{
  const {state,account,task}=fixture('verbose');Object.assign(account,{username:'siteauthor',publicationUrl:'https://verbose.blog/siteauthor'});
  state.accountBindings[0].createdAt='2026-10-01T00:00:00.000Z';
  account.ownerSiteId=otherId;
  assert.doesNotThrow(()=>bindAccount(state,accountId,otherId,CHANNELS.find(item=>item.id==='verbose')!));
  assert.throws(()=>bindAccount(state,accountId,siteId,CHANNELS.find(item=>item.id==='verbose')!));
  account.channelId=task.channelId=state.accountBindings[0].channelId='rentry';account.username='anonymous';delete account.publicationUrl;
  const channel=CHANNELS.find(item=>item.id==='rentry')!;
  assert.doesNotThrow(()=>bindAccount(state,accountId,siteId,channel));
  assert.equal(channelExecutionReadiness(state,siteId,channel).kind,'ready');
});

test('saving an unchanged shared legacy binding does not rebind or reject metadata edits',()=>{
  const {state,channel}=fixture();state.accountBindings.push({...state.accountBindings[0],id:'second',siteId});
  assert.throws(()=>bindAccount(state,accountId,siteId,channel));
  assert.doesNotThrow(()=>bindSelectedAccountSites(state,accountId,[siteId,otherId],channel));
  assert.equal(state.accountBindings.length,2);
});

for(const id of ['colony','notebin','agenthow','verbose'])test(`${id}: retired identities do not reserve an automatic identity slot`,()=>{
  const {state,account}=fixture(id);state.accountBindings=[];state.tasks=[];
  retireAccount(state,account.id,new Date(stamp));
  const channel=CHANNELS.find(item=>item.id===id)!;
  assert.equal(channelExecutionReadiness(state,siteId,channel).kind,'autocreate');
  assert.equal(accountForSiteChannel(state,siteId,id),undefined);
  assert.equal(accountForSiteChannel(state,siteId,id,account.id)?.id,account.id);
});

test('legacy retirement migration and backup roundtrip preserve identity, task, credentials and final check address',()=>{
  const {state,account,task}=fixture('verbose');Object.assign(account,{registrationAttempts:1,username:'linkflow-author',publicationUrl:'https://verbose.blog/linkflow-author'});
  state.accountBindings=[];task.linkCheckFinalUrl='https://example-site.com/final';
  const original=structuredClone(account);const migrated=migrateState(state);assert.ok(migrated.accounts[0].retiredAt);
  assert.equal(migrated.accounts[0].ownerSiteId,siteId);
  assert.deepEqual({...migrated.accounts[0],retiredAt:undefined,ownerSiteId:undefined},{...original,retiredAt:undefined,ownerSiteId:undefined});
  const restored=validateBackup({state:migrated,secrets:{['account:'+accountId]:'synthetic-account-secret'}});
  assert.equal(restored.state.tasks[0].accountId,accountId);assert.equal(restored.state.tasks[0].linkCheckFinalUrl,task.linkCheckFinalUrl);
  assert.equal(restored.secrets['account:'+accountId],'synthetic-account-secret');assert.equal(restored.state.accounts[0].retiredAt,migrated.accounts[0].retiredAt);
});

test('retired identities cannot be unretired, removed or have account credentials overwritten',()=>{
  const store=new Store(':memory:');try{
    const {state,account}=fixture('verbose');state.tasks=[];state.accountBindings=[];
    Object.assign(account,{username:'siteauthor',publicationUrl:'https://verbose.blog/siteauthor'});
    store.updateWithCiphers(draft=>{draft.accounts=state.accounts}, {['account:'+accountId]:'old-cipher'});
    store.update(draft=>retireAccount(draft,accountId));
    assert.throws(()=>store.update(draft=>{delete draft.accounts[0].retiredAt}));
    assert.throws(()=>store.updateWithCiphers(()=>{}, {['account:'+accountId]:'new-cipher'}));
    assert.throws(()=>store.update(draft=>{draft.accounts=[]}));
    assert.equal(store.getCipher('account:'+accountId),'old-cipher');
  }finally{store.close()}
});

function usableNotebin(id:string):Account{
  const rootAccountId='account_12345678',keyId='key_12345678',hash='a'.repeat(64),scopes=['note:read','note:create'] as const;
  const proof={version:1,rootAccountId,keyId,rootKeyFingerprint:hash,whoamiResponseHash:hash,noteKeyFingerprint:hash,keyListResponseHash:hash,noteReadResponseHash:hash,verifiedAt:stamp,audience:'https://notebin.ca',scopes:[...scopes],rootIdentity:'exact_readback',keyBinding:'exact_response'};
  const journal={localAccountId:id,signup:{stage:'ready',receipt:{localAccountId:id,rootAccountId},rootKeyFingerprint:hash},rootBinding:{binding:'exact_readback',localAccountId:id,rootAccountId,rootKeyFingerprint:hash,whoamiResponseHash:hash},mint:{stage:'ready',receipt:{localAccountId:id,rootAccountId,audience:proof.audience,scopes:[...scopes],tokenFingerprint:hash,binding:'exact_response',keyId}}};
  return {id,channelId:'notebin',email:'',username:'pow-root',source:'generated',credentialKind:'api_token',createdAt:stamp,status:'registered',hasPassword:true,verifiedAt:stamp,notebin:proof,notebinJournal:journal} as unknown as Account;
}

for(const id of ['verbose','notebin'])test(`${id}: retired pending publications block before preparation only while reconciliation remains available`,()=>{
  const {state,task,channel}=fixture(id),replacementId='66666666-6666-4666-8666-666666666666';
  const make=(id:string):Account=>channel.id==='notebin'?usableNotebin(id):{...state.accounts[0],id,retiredAt:undefined,username:'neutral-author',publicationUrl:'https://verbose.blog/neutral-author',registrationAttempts:1};
  state.accounts=[{...make(accountId),retiredAt:stamp}];state.accountBindings[0].siteId=siteId;
  task.submittedAt=stamp;task.reconcileAttempts=0;
  const original=structuredClone(task);
  assert.equal(channelExecutionReadiness(state,siteId,channel).blockingTask?.id,task.id);
  state.accounts.push(make(replacementId));assert.throws(()=>bindAccount(state,replacementId,siteId,channel),new RegExp(task.id));
  task.publicUrl='https://example-site.com/unconfirmed';
  assert.equal(channelExecutionReadiness(state,siteId,channel).blockingTask?.id,task.id);
  assert.throws(()=>bindAccount(state,replacementId,siteId,channel),new RegExp(task.id));
  for(const change of [{status:'skipped'},{status:'expired'},{reconcileAttempts:3},{deferredAt:stamp}] as Partial<Task>[]){
    const copy=structuredClone(state);Object.assign(copy.tasks[0],change);
    assert.equal(channelExecutionReadiness(copy,siteId,channel).blockingTask,undefined);
    assert.doesNotThrow(()=>bindAccount(copy,replacementId,siteId,channel));
    assert.equal(copy.tasks[0].accountId,original.accountId);assert.equal(copy.tasks[0].submittedAt,original.submittedAt);
    assert.equal(copy.accountBindings[0].accountId,replacementId);
  }
  if(id==='verbose')for(const change of [{status:'skipped'},{reconcileAttempts:3}] as Partial<Task>[]){const copy=structuredClone(state);Object.assign(copy.tasks[0],change,{checkpoint:'verbose_account_create_pending',publicUrl:undefined,submittedAt:undefined});assert.equal(channelExecutionReadiness(copy,siteId,channel).blockingTask,undefined);assert.doesNotThrow(()=>bindAccount(copy,replacementId,siteId,channel));}
});
