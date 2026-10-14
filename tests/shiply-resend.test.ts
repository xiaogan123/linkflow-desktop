import assert from 'node:assert/strict';
import test from 'node:test';
import {SHIPLY_ORIGIN,shiplySha256} from '../src/integrations/shiply';
import {resendExpiredShiplyCode,verifyShiplyCode} from '../src/main/shiply-management';
import {validateBackup} from '../src/main/backup-validation';
import {Store} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import type {Account,Task} from '../src/shared/types';

const accountId='11111111-2222-4333-8444-555555555555';
const taskId='22222222-3333-4444-8555-666666666666';
const email='owner@example.test';
const firstRequestedAt='2026-10-14T00:00:00.000Z';
const resendAt='2026-10-14T00:10:00.001Z';
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

test('a current code is never duplicated, including the exact ten-minute boundary',async t=>{
  for(const [name,now] of [['inside','2026-10-14T00:09:59.999Z'],['boundary','2026-10-14T00:10:00.000Z']] as const)await t.test(name,async()=>{const store=fixture();let calls=0;try{await assert.rejects(()=>resendExpiredShiplyCode(store,accountId,{now:()=>new Date(now),fetch:async()=>{calls++;return response(`${SHIPLY_ORIGIN}/api/auth/agent/request-code`)}}),/明确过期/);assert.equal(calls,0);assert.equal(store.read().accounts[0].shiply?.requestedAt,firstRequestedAt);assert.equal(store.read().accounts[0].shiply?.previousRequestedAt,undefined)}finally{store.close()}})
});

test('the resend stage transition is a compare-and-set gate for concurrent calls',async()=>{
  const store=fixture();let calls=0,release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve});
  try{const first=resendExpiredShiplyCode(store,accountId,{now:()=>new Date(resendAt),fetch:async url=>{calls++;entered();await gate;return response(url)}});await started;await assert.rejects(()=>resendExpiredShiplyCode(store,accountId,{now:()=>new Date(resendAt),fetch:async url=>{calls++;return response(url)}}),/重发一次/);assert.equal(calls,1);release();await first;assert.equal(store.read().accounts[0].shiply?.stage,'code_sent')}finally{store.close()}
});

test('unknown request, verification and ready states never expose resend',async t=>{
  for(const stage of ['request_unknown','verifying','verify_unknown','verify_opaque','ready'] as const)await t.test(stage,async()=>{const ready=stage==='ready',store=fixture(stage,ready?{status:'registered',hasPassword:true,verifiedAt:firstRequestedAt,registeredAt:firstRequestedAt}:{});let calls=0;try{await assert.rejects(()=>resendExpiredShiplyCode(store,accountId,{now:()=>new Date(resendAt),fetch:async url=>{calls++;return response(url)}}),/重发一次/);assert.equal(calls,0)}finally{store.close()}})
});

test('key, verify response and publication evidence each block resend before the network',async t=>{
  for(const kind of ['key','verify','publication'] as const)await t.test(kind,async()=>{const store=fixture();let calls=0;try{if(kind==='key')store.setCipher(`account:${accountId}`,'cipher:key');if(kind==='verify')store.setCipher(`shiply:identity:${accountId}:verify`,'cipher:response');if(kind==='publication')store.update(state=>{state.tasks.push({id:taskId,siteId:'33333333-4444-4555-8666-777777777777',channelId:'shiply',accountId,sourceDomain:'shiply.now',status:'review',createdAt:firstRequestedAt,scheduledAt:firstRequestedAt,updatedAt:firstRequestedAt,attempts:0,message:'fixture',submittedAt:firstRequestedAt} as Task)});await assert.rejects(()=>resendExpiredShiplyCode(store,accountId,{now:()=>new Date(resendAt),fetch:async url=>{calls++;return response(url)}}),/验证、key 或发布歧义/);assert.equal(calls,0)}finally{store.close()}})
});

test('an uncertain resend preserves both request times, becomes terminal, and remains backup-valid',async()=>{
  const store=fixture();try{await assert.rejects(()=>resendExpiredShiplyCode(store,accountId,{now:()=>new Date(resendAt),fetch:async()=>{throw Error('offline')}}),/重发结果不明/);const saved=store.read().accounts[0];assert.equal(saved.id,accountId);assert.equal(saved.shiply?.stage,'request_unknown');assert.equal(saved.shiply?.previousRequestedAt,firstRequestedAt);assert.equal(saved.shiply?.requestedAt,resendAt);assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets:{}}));let calls=0;await assert.rejects(()=>resendExpiredShiplyCode(store,accountId,{now:()=>new Date('2026-10-14T01:00:00.000Z'),fetch:async url=>{calls++;return response(url)}}),/重发一次/);assert.equal(calls,0)}finally{store.close()}
});

test('a successful resend is the only recovery resend for that identity',async()=>{
  const store=fixture();try{await resendExpiredShiplyCode(store,accountId,{now:()=>new Date(resendAt),fetch:async url=>response(url)});let calls=0;await assert.rejects(()=>resendExpiredShiplyCode(store,accountId,{now:()=>new Date('2026-10-14T00:20:00.002Z'),fetch:async url=>{calls++;return response(url)}}),/重发一次/);assert.equal(calls,0);assert.equal(store.read().accounts[0].shiply?.previousRequestedAt,firstRequestedAt)}finally{store.close()}
});
