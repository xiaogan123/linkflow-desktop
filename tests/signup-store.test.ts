import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store,type State} from '../src/main/store';
import type {Task} from '../src/shared/types';

const stamp='2026-10-18T00:00:00.000Z';
const taskId='11111111-1111-4111-8111-111111111111',siteId='22222222-2222-4222-8222-222222222222',accountId='33333333-3333-4333-8333-333333333333';
const emailKey=`signup:${taskId}:email`,apiKey=`signup:${taskId}:api_key`,tokenKey=`signup:${taskId}:token`;
function task(irreversible=false):Task{return {id:taskId,siteId,channelId:'fixture',accountId,sourceDomain:'platform.example.com',status:'queued',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',checkpoint:'signup_resume',
  signup:{version:1,scriptId:'mock-local-signup',scriptVersion:1,identityId:accountId,stepIndex:2,status:'waiting_email',runtimeId:'fixture-window',updatedAt:stamp,aiLocateCalls:1,aiLocatedStepIds:['fixture-field'],...(irreversible?{irreversible:{stepId:'submit',at:stamp,completed:true as const}}:{})},
  emailWait:{kind:'code',recipient:'owner@example.com',since:stamp,nextPollAt:stamp,expiresAt:'2026-10-18T00:10:00.000Z',consumedMessageIds:['fixture-message'],continuation:'signup'}};}
function fixture(irreversible=false,path=':memory:'){
  const store=new Store(path);
  store.update(state=>{
    state.tasks=[task(irreversible)];
    state.accounts=[{id:accountId,channelId:'fixture',email:'owner@example.com',username:'fixture',status:'draft',createdAt:stamp,hasPassword:false,source:'generated',registrationAttempts:irreversible?1:0}];
  });
  store.setCipher(emailKey,'encrypted-email');store.setCipher(apiKey,'encrypted-api-key');store.setCipher(tokenKey,'encrypted-token');
  store.setCipher('account:'+accountId,'unrelated-account-secret');
  return store;
}

test('removing a pre-submit task atomically removes its signup ciphers before notifying observers',()=>{
  const store=fixture();let observed=false;
  try{
    store.onChange=()=>{observed=true;assert.equal(store.read().tasks.length,0);assert.equal(store.getCipher(emailKey),undefined);assert.equal(store.getCipher(apiKey),undefined);assert.equal(store.getCipher(tokenKey),undefined)};
    store.update(state=>{state.tasks=[]});assert.equal(observed,true);
    assert.equal(store.getCipher('account:'+accountId),'unrelated-account-secret');
  }finally{store.close()}
});

test('clearing delivered mail through update cleans email while preserving extracted API credentials',()=>{
  const store=fixture(true);
  try{
    store.update(state=>{state.tasks[0].status='skipped';state.tasks[0].emailWait=undefined});
    assert.equal(store.getCipher(emailKey),undefined);assert.equal(store.getCipher(apiKey),'encrypted-api-key');assert.equal(store.getCipher(tokenKey),'encrypted-token');
    assert.ok(store.read().tasks[0].signup?.irreversible);
  }finally{store.close()}
});

test('cipher transactions clean removed email state and cannot write a late orphan email delivery',()=>{
  const store=fixture(true);
  try{
    store.updateWithCiphers(state=>{state.tasks[0].emailWait=undefined},{[emailKey]:'late-email',[apiKey]:'new-encrypted-api-key'});
    assert.equal(store.getCipher(emailKey),undefined);assert.equal(store.getCipher(apiKey),'new-encrypted-api-key');assert.equal(store.getCipher(tokenKey),'encrypted-token');
  }finally{store.close()}
});

test('cipher transactions clean all signup keys on removable task deletion',()=>{
  const store=fixture();
  try{store.updateWithCiphers(state=>{state.tasks=[]},{[tokenKey]:'late-token'});assert.equal(store.getCipher(emailKey),undefined);assert.equal(store.getCipher(apiKey),undefined);assert.equal(store.getCipher(tokenKey),undefined)}finally{store.close()}
});

test('irreversible signup evidence blocks deletion, identity replacement, rollback and AI budget resets',()=>{
  const changes:Array<(state:State)=>void>=[
    state=>{state.tasks=[]},state=>{state.tasks[0].signup=undefined},state=>{state.tasks[0].accountId=siteId},
    state=>{state.tasks[0].signup!.identityId=siteId},state=>{state.tasks[0].signup!.scriptId='other-script'},state=>{state.tasks[0].signup!.scriptVersion=2},
    state=>{state.tasks[0].signup!.stepIndex=0},state=>{state.tasks[0].signup!.aiLocateCalls=0},state=>{state.tasks[0].signup!.aiLocatedStepIds=[]},
    state=>{state.tasks[0].signup!.irreversible=undefined},state=>{state.tasks[0].signup!.irreversible!.completed=undefined},
    state=>{state.tasks[0].signup!.irreversible!.at='2026-10-18T00:01:00.000Z'},
  ];
  for(const change of changes){
    const store=fixture(true);try{const before=store.read(),ciphers=store.allCiphers();assert.throws(()=>store.update(change));assert.deepEqual(store.read(),before);assert.deepEqual(store.allCiphers(),ciphers)}finally{store.close()}
  }
});

test('pre-submit navigation may safely restart from step zero without resetting its selector budget',()=>{
  const store=fixture();
  try{store.update(state=>{state.tasks[0].signup!.stepIndex=0;state.tasks[0].signup!.runtimeId='replacement-window'});assert.equal(store.read().tasks[0].signup?.stepIndex,0);assert.equal(store.read().tasks[0].signup?.aiLocateCalls,1)}finally{store.close()}
});

test('attempted registration retains its account identity and attempts while allowing credential correction',()=>{
  const changes:Array<(state:State)=>void>=[state=>{state.accounts=[]},state=>{state.accounts[0].email='other@example.com'},state=>{state.accounts[0].username='other'},state=>{state.accounts[0].channelId='other'},state=>{state.accounts[0].registrationAttempts=0},state=>{state.accounts[0].registrationAttempts=undefined}];
  for(const change of changes){const store=fixture(true);try{const before=store.read();assert.throws(()=>store.update(change));assert.deepEqual(store.read(),before)}finally{store.close()}}
  const store=fixture(true);
  try{store.updateWithCiphers(state=>{state.accounts[0].hasPassword=true;state.accounts[0].status='registered'},{['account:'+accountId]:'corrected-encrypted-password'});assert.equal(store.getCipher('account:'+accountId),'corrected-encrypted-password');assert.equal(store.read().accounts[0].registrationAttempts,1)}finally{store.close()}
});

test('completed signup permits profile correction but retains account channel and attempt evidence',()=>{
  const store=fixture(true);
  try{
    store.update(state=>{state.tasks[0].signup!.status='done'});
    store.update(state=>{state.accounts[0].email='updated@example.com';state.accounts[0].username='updated-profile'});
    assert.equal(store.read().accounts[0].email,'updated@example.com');
    assert.throws(()=>store.update(state=>{state.accounts[0].channelId='another-platform'}));
    assert.throws(()=>store.update(state=>{state.accounts=[]}));
    assert.throws(()=>store.update(state=>{state.accounts[0].registrationAttempts=0}));
  }finally{store.close()}
});

test('completed irreversible step permits a distinct later irreversible step and completion',()=>{
  const store=fixture(true);
  try{
    store.update(state=>{const signup=state.tasks[0].signup!;signup.stepIndex=3;signup.irreversible={stepId:'verify-link',at:'2026-10-18T00:01:00.000Z'};signup.status='irreversible'});
    assert.throws(()=>store.update(state=>{state.tasks[0].signup!.irreversible={stepId:'another-submit',at:'2026-10-18T00:02:00.000Z'}}));
    store.update(state=>{const signup=state.tasks[0].signup!;signup.irreversible!.completed=true;signup.status='running'});
    store.update(state=>{const signup=state.tasks[0].signup!;signup.stepIndex=4;signup.status='done';state.tasks[0].emailWait=undefined});
    assert.equal(store.read().tasks[0].signup?.status,'done');assert.equal(store.getCipher(apiKey),'encrypted-api-key');
    assert.throws(()=>store.update(state=>{state.tasks[0].signup!.status='running'}));
  }finally{store.close()}
});

test('older restore cannot erase an irreversible checkpoint or reset the task budget',()=>{
  const store=fixture(true);
  try{
    const before=store.read(),old=structuredClone(before);old.tasks[0].signup!.irreversible=undefined;old.tasks[0].signup!.stepIndex=0;
    assert.throws(()=>store.restore(old,store.allCiphers()));assert.deepEqual(store.read(),before);
  }finally{store.close()}
});

test('restart preserves irreversible evidence and cleans legacy orphan email ciphers',()=>{
  const directory=mkdtempSync(join(tmpdir(),'signup-store-')),path=join(directory,'state.sqlite');
  let store:Store|undefined;
  try{
    store=fixture(true,path);store.setCipher('signup:44444444-4444-4444-8444-444444444444:token','orphan-token');store.close();store=undefined;
    store=new Store(path);assert.ok(store.read().tasks[0].signup?.irreversible);assert.equal(store.getCipher('signup:44444444-4444-4444-8444-444444444444:token'),undefined);
    assert.throws(()=>store!.update(state=>{state.tasks=[]}));assert.equal(store.getCipher(apiKey),'encrypted-api-key');
  }finally{store?.close();rmSync(directory,{recursive:true,force:true})}
});

test('cleanup transaction rolls state and ciphers back together when SQLite persistence fails',()=>{
  const directory=mkdtempSync(join(tmpdir(),'signup-store-rollback-')),path=join(directory,'state.sqlite'),store=fixture(false,path);
  const mutable=store as unknown as {persist(state:State):void},persist=mutable.persist.bind(store);let notices=0;
  store.onChange=()=>{notices++};
  try{
    const before=store.read();mutable.persist=state=>{persist(state);throw Error('fixture-write-failure')};
    assert.throws(()=>store.update(state=>{state.tasks[0].emailWait=undefined}),/fixture-write-failure/);
    assert.deepEqual(store.read(),before);assert.equal(store.getCipher(emailKey),'encrypted-email');assert.equal(notices,0);
    const db=new DatabaseSync(path);const row=db.prepare('SELECT body FROM state WHERE id=1').get() as {body:string};db.close();
    assert.ok((JSON.parse(row.body) as State).tasks[0].emailWait);
  }finally{store.close();rmSync(directory,{recursive:true,force:true})}
});
