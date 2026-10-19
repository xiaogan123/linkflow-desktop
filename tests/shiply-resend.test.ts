import assert from 'node:assert/strict';
import test from 'node:test';
import {SHIPLY_ORIGIN,shiplySha256} from '../src/integrations/shiply';
import {resendExpiredShiplyCode,verifyShiplyCode} from '../src/main/shiply-management';
import {validateBackup} from '../src/main/backup-validation';
import {Store} from '../src/main/store';
import {createHumanAction} from '../src/shared/human-action';
import type {Vault} from '../src/main/vault';
import type {Account,Site,Task} from '../src/shared/types';

const accountId='11111111-2222-4333-8444-555555555555';
const taskId='22222222-3333-4444-8555-666666666666';
const email='owner@example.test';
const firstRequestedAt='2026-10-14T00:00:00.000Z';
const resendAt='2026-10-14T00:10:00.001Z';
const secondResendAt='2026-10-14T00:20:00.002Z';
const key='shp_'+ 'A'.repeat(32);

function response(url:string,body='{}'){const value=new Response(body,{status:200,headers:{'content-type':'application/json'}});Object.defineProperty(value,'url',{value:url});Object.defineProperty(value,'redirected',{value:false});return value}
function pending(stage:NonNullable<Account['shiply']>['stage']='code_sent',overrides:Partial<Account>={}):Account{return {id:accountId,channelId:'shiply',email,username:email,credentialKind:'api_token',status:'needs_verification',hasPassword:false,source:'generated',createdAt:firstRequestedAt,updatedAt:firstRequestedAt,shiply:{version:1,emailHash:shiplySha256(email),requestedAt:firstRequestedAt,stage},...overrides}}
function fixture(stage:NonNullable<Account['shiply']>['stage']='code_sent',overrides:Partial<Account>={}){const store=new Store(':memory:');store.update(state=>{state.accounts.push(pending(stage,overrides))});return store}

test('expired code resends once on the same account and the new code can complete that identity',async()=>{
  const store=fixture(),requestCalls:string[]=[];
  try{
    const resent=await resendExpiredShiplyCode(store,accountId,{now:()=>new Date(resendAt),fetch:async(url,init)=>{requestCalls.push(`${init.method} ${url}`);assert.deepEqual(JSON.parse(String(init.body)),{email});return response(url)}});
    assert.equal(resent.id,accountId);assert.equal(resent.email,email);assert.equal(resent.createdAt,firstRequestedAt);assert.deepEqual(resent.shiply,{version:1,emailHash:shiplySha256(email),previousRequestedAt:firstRequestedAt,requestedAt:resendAt,stage:'code_sent'});assert.deepEqual(requestCalls,[`POST ${SHIPLY_ORIGIN}/api/auth/agent/request-code`]);assert.equal(store.read().accounts.length,1);
    const plaintext=new Map<string,string>(),vault={get:async(name:string)=>plaintext.get(name),encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([name,value])=>{plaintext.set(name,value);return [name,'cipher:'+Buffer.from(value).toString('base64url')]}))} as unknown as Vault;
    const ready=await verifyShiplyCode(store,vault,{accountId,code:'123456',siteIds:[]},{now:()=>new Date('2026-10-14T00:11:00.000Z'),fetch:async(url,init)=>{assert.equal(JSON.parse(String(init.body)).code,'123456');return response(url,JSON.stringify({apiKey:key,email}))}});
    assert.equal(ready.id,accountId);assert.equal(ready.shiply?.stage,'ready');assert.equal(ready.shiply?.previousRequestedAt,firstRequestedAt);assert.equal(ready.shiply?.requestedAt,resendAt);
    const backup={state:store.read(),secrets:Object.fromEntries(plaintext)};assert.doesNotThrow(()=>validateBackup(backup));const tampered=structuredClone(backup);tampered.state.accounts[0].shiply!.previousRequestedAt=tampered.state.accounts[0].shiply!.requestedAt;assert.throws(()=>validateBackup(tampered),/Shiply/);
  }finally{store.close()}
});
test('resending an expired Shiply code adopts confirmation and ambiguous mail stops',async()=>{
  const siteId='33333333-4444-4555-8666-777777777777',mailboxId='44444444-5555-4666-8777-888888888888';
  for(const stop of ['email_confirmation','email_verification_human'] as const){
    const store=fixture();try{
      const site:Site={id:siteId,domain:'example.com',url:'https://example.com/',email,mailboxId,name:'Example',description:'Fixture',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:firstRequestedAt};
      const wait:NonNullable<Task['emailWait']>={kind:'code',recipient:email,since:firstRequestedAt,nextPollAt:firstRequestedAt,expiresAt:'2026-10-14T00:10:00.000Z',mailboxId,consumedMessageIds:['old-code'],continuation:'shiply'};
      const task:Task={id:taskId,siteId,channelId:'shiply',accountId,sourceDomain:'shiply.now',status:'needs_input',checkpoint:stop,reasonCode:'human_required',createdAt:firstRequestedAt,scheduledAt:firstRequestedAt,updatedAt:firstRequestedAt,attempts:0,message:'fixture'};
      task.humanAction=createHumanAction(task,{kind:stop==='email_confirmation'?'email_confirmation':'email_code_ambiguous',expiresAt:wait.expiresAt},new Date(firstRequestedAt));
      task.waitingSince=task.humanAction.since;task.waitingDeadlineAt=task.humanAction.deadline;
      if(stop==='email_confirmation')task.emailConfirmation={wait,messageId:'old-code'};
      store.update(state=>{state.sites=[site];state.mailboxes=[{id:mailboxId,label:'Fixture',host:'imap.example.com',port:993,user:email,secure:true,hasPassword:true,aliases:[],createdAt:firstRequestedAt,updatedAt:firstRequestedAt,verifiedAt:firstRequestedAt}];state.accounts[0].mailboxId=mailboxId;state.accounts[0].shiply!.siteId=siteId;state.tasks=[task]});
      if(stop==='email_confirmation')store.setCipher(`signup:${taskId}:email`,'cipher:old-code');
      await resendExpiredShiplyCode(store,accountId,{now:()=>new Date(resendAt),fetch:async url=>response(url)});
      const saved=store.read().tasks[0];
      assert.equal(saved.checkpoint,'email_code_pending',stop);assert.equal(saved.humanAction,undefined);assert.equal(saved.emailConfirmation,undefined);
      assert.equal(store.getCipher(`signup:${taskId}:email`),undefined);
    }finally{store.close()}
  }
});

test('a current code is never duplicated, including the exact ten-minute boundary',async t=>{
  for(const [name,now] of [['inside','2026-10-14T00:09:59.999Z'],['boundary','2026-10-14T00:10:00.000Z']] as const)await t.test(name,async()=>{const store=fixture();let calls=0;try{await assert.rejects(()=>resendExpiredShiplyCode(store,accountId,{now:()=>new Date(now),fetch:async()=>{calls++;return response(`${SHIPLY_ORIGIN}/api/auth/agent/request-code`)}}),/明确过期/);assert.equal(calls,0);assert.equal(store.read().accounts[0].shiply?.requestedAt,firstRequestedAt);assert.equal(store.read().accounts[0].shiply?.previousRequestedAt,undefined)}finally{store.close()}})
});

test('invalid rolling request history is rejected before the network without changing state',async t=>{
  for(const [name,value] of [['empty string',''],['null',null],['numeric zero',0],['numeric year',2000],['year string','2000'],['date only','2000-01-01'],['noncanonical timezone','2026-10-13T00:00:00.000+00:00'],['invalid calendar date','2026-02-30T00:00:00.000Z'],['unordered',firstRequestedAt]] as const)await t.test(name,async()=>{const store=fixture();let calls=0;try{store.update(state=>{(state.accounts[0].shiply as unknown as {previousRequestedAt?:unknown}).previousRequestedAt=value});const before=store.read();await assert.rejects(()=>resendExpiredShiplyCode(store,accountId,{now:()=>new Date(resendAt),fetch:async url=>{calls++;return response(url)}}),/请求历史有效/);assert.equal(calls,0);assert.deepEqual(store.read(),before)}finally{store.close()}})
});

test('the resend stage transition is a compare-and-set gate for concurrent calls',async()=>{
  const store=fixture();let calls=0,release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve});
  try{await resendExpiredShiplyCode(store,accountId,{now:()=>new Date(resendAt),fetch:async url=>response(url)});const first=resendExpiredShiplyCode(store,accountId,{now:()=>new Date(secondResendAt),fetch:async url=>{calls++;entered();await gate;return response(url)}});await started;await assert.rejects(()=>resendExpiredShiplyCode(store,accountId,{now:()=>new Date(secondResendAt),fetch:async url=>{calls++;return response(url)}}),/手动请求新验证码/);assert.equal(calls,1);release();await first;const saved=store.read().accounts[0];assert.equal(saved.shiply?.stage,'code_sent');assert.equal(saved.shiply?.previousRequestedAt,resendAt);assert.equal(saved.shiply?.requestedAt,secondResendAt)}finally{store.close()}
});

test('unknown request, verification and ready states never expose resend',async t=>{
  for(const stage of ['request_unknown','verifying','verify_unknown','verify_opaque','ready'] as const)await t.test(stage,async()=>{const ready=stage==='ready',store=fixture(stage,ready?{status:'registered',hasPassword:true,verifiedAt:firstRequestedAt,registeredAt:firstRequestedAt}:{});let calls=0;try{await assert.rejects(()=>resendExpiredShiplyCode(store,accountId,{now:()=>new Date(resendAt),fetch:async url=>{calls++;return response(url)}}),/手动请求新验证码/);assert.equal(calls,0)}finally{store.close()}})
});

test('key, verify response and publication evidence each block a later renewal before the network',async t=>{
  for(const kind of ['key','verify','publication'] as const)await t.test(kind,async()=>{const store=fixture();let calls=0;try{await resendExpiredShiplyCode(store,accountId,{now:()=>new Date(resendAt),fetch:async url=>response(url)});if(kind==='key')store.setCipher(`account:${accountId}`,'cipher:key');if(kind==='verify')store.setCipher(`shiply:identity:${accountId}:verify`,'cipher:response');if(kind==='publication')store.update(state=>{state.tasks.push({id:taskId,siteId:'33333333-4444-4555-8666-777777777777',channelId:'shiply',accountId,sourceDomain:'shiply.now',status:'review',createdAt:firstRequestedAt,scheduledAt:firstRequestedAt,updatedAt:firstRequestedAt,attempts:0,message:'fixture',submittedAt:firstRequestedAt} as Task)});await assert.rejects(()=>resendExpiredShiplyCode(store,accountId,{now:()=>new Date(secondResendAt),fetch:async url=>{calls++;return response(url)}}),/验证、key 或发布歧义/);assert.equal(calls,0)}finally{store.close()}})
});

test('an uncertain resend preserves both request times, becomes terminal, and remains backup-valid',async()=>{
  const store=fixture();try{await resendExpiredShiplyCode(store,accountId,{now:()=>new Date(resendAt),fetch:async url=>response(url)});await assert.rejects(()=>resendExpiredShiplyCode(store,accountId,{now:()=>new Date(secondResendAt),fetch:async()=>{throw Error('offline')}}),/续码结果不明/);const saved=store.read().accounts[0];assert.equal(saved.id,accountId);assert.equal(saved.shiply?.stage,'request_unknown');assert.equal(saved.shiply?.previousRequestedAt,resendAt);assert.equal(saved.shiply?.requestedAt,secondResendAt);assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets:{}}));let calls=0;await assert.rejects(()=>resendExpiredShiplyCode(store,accountId,{now:()=>new Date('2026-10-14T01:00:00.000Z'),fetch:async url=>{calls++;return response(url)}}),/手动请求新验证码/);assert.equal(calls,0)}finally{store.close()}
});

test('two sequential expired-code renewals keep one identity and roll the request timestamps',async()=>{
  const store=fixture();let calls=0;try{await resendExpiredShiplyCode(store,accountId,{now:()=>new Date(resendAt),fetch:async url=>{calls++;return response(url)}});await assert.rejects(()=>resendExpiredShiplyCode(store,accountId,{now:()=>new Date('2026-10-14T00:20:00.001Z'),fetch:async url=>{calls++;return response(url)}}),/明确过期/);assert.equal(calls,1);const renewed=await resendExpiredShiplyCode(store,accountId,{now:()=>new Date(secondResendAt),fetch:async url=>{calls++;return response(url)}});assert.equal(calls,2);assert.equal(renewed.id,accountId);assert.equal(renewed.email,email);assert.equal(renewed.createdAt,firstRequestedAt);assert.equal(store.read().accounts.length,1);assert.deepEqual(renewed.shiply,{version:1,emailHash:shiplySha256(email),previousRequestedAt:resendAt,requestedAt:secondResendAt,stage:'code_sent'});assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets:{}}));const tampered={state:structuredClone(store.read()),secrets:{}};tampered.state.accounts[0].shiply!.previousRequestedAt=tampered.state.accounts[0].shiply!.requestedAt;assert.throws(()=>validateBackup(tampered),/Shiply/)}finally{store.close()}
});


test('malformed current request time blocks resend and verification without a request or mutation',async t=>{
  for(const value of [0,2000,'2000','2026-02-30T00:00:00.000Z','2026-10-14T00:00:00Z','2026-10-14T00:00:00.000+00:00'])await t.test(String(value),async()=>{const store=fixture();let calls=0;try{store.update(state=>{(state.accounts[0].shiply as unknown as {requestedAt:unknown}).requestedAt=value});const before=store.read(),deps={now:()=>new Date(resendAt),fetch:async(url:string)=>{calls++;return response(url)}};await assert.rejects(()=>resendExpiredShiplyCode(store,accountId,deps));await assert.rejects(()=>verifyShiplyCode(store,{} as Vault,{accountId,code:'123456',siteIds:[]},deps));assert.equal(calls,0);assert.deepEqual(store.read(),before)}finally{store.close()}});
});
