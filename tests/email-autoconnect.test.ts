import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Controller} from '../src/main/controller';
import {Store} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import {CHANNELS} from '../src/integrations/catalog';
import type {Account,ExecutionContext,Mailbox,Site,Task} from '../src/shared/types';
import {requestHereNowCode,resendHereNowCode,verifyHereNowCode,recoverHereNowVerifiedResponse,hereNowVerifyKey} from '../src/main/here-now-email';
import {validHereNowAccount} from '../src/main/here-now-management';
import {requestShiplyCode,validShiplyAccount} from '../src/main/shiply-management';
import {shiplySha256} from '../src/integrations/shiply';
import {hereNowSha256} from '../src/integrations/here-now';
import {bindAccount,channelExecutionReadiness} from '../src/main/account-bindings';
import {scanVerificationBatch,type VerificationMailClient} from '../src/integrations/mail';
import {validateBackup} from '../src/main/backup-validation';

const stamp='2026-10-20T00:00:00.000Z',email='owner@example.test',personalId='99999999-9999-4999-8999-999999999999',hereKey='hnk_'+'a'.repeat(64),shiplyKey='shp_'+'A'.repeat(32);
const now=()=>new Date(stamp);
function response(url:string,value:unknown,status=200){const reply=new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});Object.defineProperty(reply,'url',{value:url});return reply}
function fixture(channelId='here-now',count=1){
  const store=new Store(':memory:'),path=mkdtempSync(join(tmpdir(),'email-autoconnect-')),secrets=new Map<string,string>(),mailbox:Mailbox={id:randomUUID(),label:'Fixture',host:'imap.gmail.com',port:993,user:email,secure:true,hasPassword:true,verifiedAt:stamp,aliases:[],createdAt:stamp,updatedAt:stamp};
  secrets.set(`mailbox:${mailbox.id}`,'fixture-password');
  const vault={ready:true,available:()=>true,get:async(key:string)=>secrets.get(key),encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>{secrets.set(key,value);return [key,'cipher:'+Buffer.from(value).toString('base64url')]}))} as unknown as Vault;
  store.update(state=>{state.settings.autoRun=true;state.settings.notify=false;state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(channel=>[channel.id,channel.id===channelId]));state.mailboxes=[mailbox];
    state.sites=Array.from({length:count},(_,i):Site=>({id:randomUUID(),domain:`site${i}.example.test`,url:`https://site${i}.example.test/`,name:'Fixture',description:'Software',email:`site${i}@example.test`,publicEmail:`site${i}@example.test`,mailboxId:mailbox.id,category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp,analyzedAt:stamp,topicsCheckedAt:new Date().toISOString(),qualifications:{software:`https://site${i}.example.test/product`,developer:`https://site${i}.example.test/releases`}}));
    state.tasks=state.sites.map(site=>({id:randomUUID(),siteId:site.id,channelId,sourceDomain:channelId==='shiply'?'shiply.now':'here.now',status:'needs_input',checkpoint:'account_handoff',reasonCode:'account_handoff',message:'Fixture',createdAt:stamp,updatedAt:stamp,scheduledAt:stamp,attempts:0}));
  });
  return {store,vault,secrets,mailbox,path,close(){store.close();rmSync(path,{recursive:true,force:true})}};
}
function hereFetch(calls:Array<{url:string;method:string;body:unknown}>,override?:unknown){return async(url:string,init:RequestInit)=>{
  calls.push({url,method:String(init.method),body:typeof init.body==='string'?JSON.parse(init.body):undefined});
  if(url.endsWith('/request-code'))return response(url,{success:true});
  if(url.endsWith('/verify-code'))return response(url,override??{apiKey:hereKey,keyReused:true});
  if(url.endsWith('/email-change'))return response(url,{email,pending:null});
  if(url.endsWith('/accounts'))return response(url,{accounts:[{accountId:personalId,type:'personal',status:'active',provisioningStatus:'active',role:'admin'}]});
  throw Error('unexpected endpoint');
}}
function readyShiply(f:ReturnType<typeof fixture>):Account{
  const account:Account={id:randomUUID(),channelId:'shiply',email,username:email,status:'registered',source:'generated',hasPassword:true,credentialKind:'api_token',createdAt:stamp,registeredAt:stamp,verifiedAt:stamp,mailboxId:f.mailbox.id,shiply:{version:1,emailHash:shiplySha256(email),requestedAt:stamp,stage:'ready',keyFingerprint:shiplySha256(shiplyKey)}};
  f.store.update(state=>state.accounts.push(account));f.secrets.set(`account:${account.id}`,shiplyKey);return account;
}

test('automatic first request uses the mailbox address once for 97 sites and never aliases or duplicates',async()=>{
  for(const channelId of ['shiply','here-now']){
    const f=fixture(channelId,97),calls:Array<{url:string;method:string;body:unknown}>=[],fetch=hereFetch(calls),controller=new Controller(f.store,f.vault,f.path,{shiplyDependencies:{now,fetch},hereNowDependencies:{now,fetch}});
    try{const first=controller.connectPendingEmailAccounts();assert.equal(controller.connectPendingEmailAccounts(),first);await first;await controller.connectPendingEmailAccounts();
      assert.equal(calls.length,1);assert.deepEqual(calls[0].body,{email});assert.equal(f.store.read().accounts.length,1);assert.equal(f.store.read().accounts[0].email,email);assert.equal(f.store.read().tasks.filter(task=>task.checkpoint==='waiting_email').length,1);
    }finally{controller.stop();f.close()}
  }
});

test('missing mailbox password, untested mailbox and missing vault password cannot auto-request',async()=>{
  for(const failure of ['flag','test','vault','binding']){
    const f=fixture('shiply'),calls:unknown[]=[],controller=new Controller(f.store,f.vault,f.path,{shiplyDependencies:{fetch:async()=>{calls.push(1);throw Error('must not request')}}});
    try{if(failure==='vault')f.secrets.clear();else f.store.update(state=>{if(failure==='flag')state.mailboxes[0].hasPassword=false;if(failure==='test')state.mailboxes[0].verifiedAt=undefined;if(failure==='binding')state.sites[0].mailboxId=undefined});await controller.connectPendingEmailAccounts();assert.equal(calls.length,0);assert.equal(f.store.read().accounts.length,0);assert.equal(f.store.read().tasks[0].checkpoint,'account_handoff')}
    finally{controller.stop();f.close()}
  }
});

test('a verified Shiply email account serves only its own site; the other 96 sites are neither bound nor sent a new code',async()=>{
  const f=fixture('shiply',97),account=readyShiply(f),controller=new Controller(f.store,f.vault,f.path,{shiplyDependencies:{fetch:async()=>{throw Error('must not request')}}});
  try{f.store.update(state=>bindAccount(state,account.id,state.sites[0].id,CHANNELS.find(value=>value.id==='shiply')!));await controller.connectPendingEmailAccounts();const state=f.store.read();assert.equal(state.accounts.length,1);assert.equal(state.accountBindings.length,1);for(const [index,site] of state.sites.entries())assert.equal(channelExecutionReadiness(state,site.id,CHANNELS.find(value=>value.id==='shiply')!).kind,index===0?'ready':'handoff_required');assert.equal(state.accounts[0].source,'generated')}
  finally{controller.stop();f.close()}
});

test('invalid key, changed email, pending identity and unknown result cannot be reused or trigger a new request',async()=>{
  for(const kind of ['bad-key','bad-email','pending','unknown','username']){
    const f=fixture('shiply',2),account=readyShiply(f),calls:unknown[]=[],controller=new Controller(f.store,f.vault,f.path,{shiplyDependencies:{fetch:async()=>{calls.push(1);throw Error('must not request')}}});
    try{if(kind==='bad-key')f.secrets.set(`account:${account.id}`,'invalid');f.store.update(state=>{state.tasks[0].accountId=account.id;state.tasks[1].accountId=account.id;const a=state.accounts[0];if(kind==='bad-email')a.email='changed@example.test';if(kind==='username')a.username='someone';if(kind==='pending'||kind==='unknown'){a.hasPassword=false;a.status='needs_verification';a.shiply!.stage=kind==='pending'?'code_sent':'verify_unknown';a.shiply!.siteId=state.sites[0].id}});await controller.connectPendingEmailAccounts();assert.equal(calls.length,0);assert.equal(f.store.read().accounts.length,1);assert.equal(f.store.read().accountBindings.length,0)}finally{controller.stop();f.close()}
  }
});

test('here email verifies once with stable named key, persists opaque response before identity reads and preserves bindings',async()=>{
  const f=fixture('here-now',2),calls:Array<{url:string;method:string;body:unknown}>=[],base=hereFetch(calls);
  try{const account=await requestHereNowCode(f.store,email,{siteId:f.store.read().sites[0].id,now,fetch:base});
    const fetch=async(url:string,init:RequestInit)=>{if(init.method==='GET'){assert.ok(f.store.getCipher(hereNowVerifyKey(account.id)));assert.equal(f.store.read().accounts[0].hereNowEmail?.stage,'verify_opaque')}return base(url,init)};
    const saved=await verifyHereNowCode(f.store,f.vault,{accountId:account.id,code:'ABCD-2345',siteIds:f.store.read().sites.map(site=>site.id)},{now,fetch});
    assert.ok(validHereNowAccount(saved));assert.equal(saved.hereNowEmail?.stage,'ready');assert.equal(f.store.read().accountBindings.length,2);assert.deepEqual(calls.find(call=>call.url.endsWith('/verify-code'))?.body,{email,code:'ABCD-2345',keyName:'site-publishing'});assert.doesNotMatch(JSON.stringify(f.store.read()),new RegExp(hereKey));
    await assert.rejects(()=>verifyHereNowCode(f.store,f.vault,{accountId:account.id,code:'ABCD-2345',siteIds:[]},{now,fetch}));assert.equal(calls.filter(call=>call.url.endsWith('/verify-code')).length,1);
    const restored=validateBackup({version:1,state:f.store.read(),secrets:Object.fromEntries(f.secrets)});assert.equal(restored.state.accounts[0].hereNowEmail?.stage,'ready');
  }finally{f.close()}
});

test('legacy fallback or keyMintError stays opaque, survives backup and never makes an identity read',async()=>{
  for(const body of [{apiKey:'legacy-key',keyMintError:'key_cap'},{apiKey:hereKey,keyMintError:'rate_limit'},{apiKey:hereKey,email:'other@example.test'}]){
    const f=fixture(),calls:Array<{url:string;method:string;body:unknown}>=[],fetch=hereFetch(calls,body);
    try{const account=await requestHereNowCode(f.store,email,{now,fetch});await assert.rejects(()=>verifyHereNowCode(f.store,f.vault,{accountId:account.id,code:'ABCD-2345',siteIds:[]},{now,fetch}));assert.equal(f.store.read().accounts[0].hereNowEmail?.stage,'verify_opaque');assert.equal(f.secrets.has(`account:${account.id}`),false);assert.equal(calls.filter(call=>call.method==='GET').length,0);assert.ok(validateBackup({version:1,state:f.store.read(),secrets:Object.fromEntries(f.secrets)}));await assert.rejects(()=>resendHereNowCode(f.store,account.id,{now:()=>new Date(Date.parse(stamp)+700_000),fetch}));assert.equal(calls.filter(call=>call.method==='POST').length,2)}finally{f.close()}
  }
});

test('an opaque here response recovers with identity GETs only after an interrupted identity check',async()=>{
  const f=fixture(),calls:Array<{url:string;method:string;body:unknown}>=[],base=hereFetch(calls);
  try{const account=await requestHereNowCode(f.store,email,{now,fetch:base});await assert.rejects(()=>verifyHereNowCode(f.store,f.vault,{accountId:account.id,code:'ABCD-2345',siteIds:[]},{now,fetch:async(url,init)=>{if(init.method==='GET')throw Error('offline');return base(url,init)}}));const restored=validateBackup({version:1,state:f.store.read(),secrets:Object.fromEntries(f.secrets)});assert.equal(restored.state.accounts[0].hereNowEmail?.stage,'verify_opaque');calls.length=0;const saved=await recoverHereNowVerifiedResponse(f.store,f.vault,{accountId:account.id,siteIds:[f.store.read().sites[0].id]},{now,fetch:base});assert.ok(validHereNowAccount(saved));assert.deepEqual(calls.map(call=>call.method),['GET','GET']);assert.equal(f.store.read().accountBindings.length,1)}finally{f.close()}
});

test('explicit here renewal preserves the original account and old request time, resets expired waits only once',async()=>{
  const f=fixture(),calls:Array<{url:string;method:string;body:unknown}>=[],fetch=hereFetch(calls);
  try{const site=f.store.read().sites[0],account=await requestHereNowCode(f.store,email,{now,siteId:site.id,fetch});const after=()=>new Date(Date.parse(stamp)+600_001);await assert.rejects(()=>resendHereNowCode(f.store,account.id,{now,fetch}));const saved=await resendHereNowCode(f.store,account.id,{now:after,fetch});assert.equal(saved.id,account.id);assert.equal(saved.hereNowEmail?.previousRequestedAt,stamp);assert.equal(saved.hereNowEmail?.requestedAt,after().toISOString());assert.equal(f.store.read().accounts.length,1);await assert.rejects(()=>resendHereNowCode(f.store,account.id,{now:after,fetch}));assert.equal(calls.length,2);assert.equal(f.store.read().tasks[0].checkpoint,'email_code_pending')}
  finally{f.close()}
});

test('unknown request and verify results never resend; changed recipient never submits an OTP',async()=>{
  for(const kind of ['request','verify','changed-email']){
    const f=fixture(),calls:Array<{url:string;method:string;body:unknown}>=[],base=hereFetch(calls);
    try{
      if(kind==='request'){await assert.rejects(()=>requestHereNowCode(f.store,email,{now,fetch:async()=>{throw Error('timeout')}}));assert.equal(f.store.read().accounts[0].hereNowEmail?.stage,'request_unknown')}
      else{const account=await requestHereNowCode(f.store,email,{now,fetch:base});if(kind==='changed-email')f.store.update(state=>{state.accounts[0].email='different@example.test'});await assert.rejects(()=>verifyHereNowCode(f.store,f.vault,{accountId:account.id,code:'ABCD-2345',siteIds:[]},{now,fetch:async()=>{throw Error('timeout')}}));assert.equal(f.store.read().accounts[0].hereNowEmail?.stage,kind==='verify'?'verify_unknown':'code_sent')}
      await assert.rejects(()=>resendHereNowCode(f.store,f.store.read().accounts[0].id,{now:()=>new Date(Date.parse(stamp)+700_000),fetch:base}));await assert.rejects(()=>requestHereNowCode(f.store,f.store.read().accounts[0].email,{now,fetch:base}));assert.ok(calls.length<=1);
    }finally{f.close()}
  }
});

test('pause and skipped task discard late automatic request results without registering mail or verifying',async()=>{
  for(const action of ['pause','skip']){
    const f=fixture('shiply'),calls:unknown[]=[],pending:{resolve?:(reply:Response)=>void}={},controller=new Controller(f.store,f.vault,f.path,{shiplyDependencies:{now,fetch:async url=>{calls.push(1);return new Promise(done=>{pending.resolve=()=>done(response(url,{success:true}))})}}});
    try{const work=controller.connectPendingEmailAccounts();while(!pending.resolve)await new Promise(resolve=>setImmediate(resolve));if(action==='pause')controller.pause();else f.store.update(state=>{state.tasks[0].status='skipped'});pending.resolve(response('https://shiply.now/api/auth/agent/request-code',{}));await work;assert.equal(calls.length,1);assert.equal(f.store.read().tasks[0].emailWait,undefined);assert.equal(f.store.read().tasks[0].status,action==='skip'?'skipped':'needs_input');assert.equal(f.store.read().accounts[0].hasPassword,false)}finally{controller.stop();f.close()}
  }
});

async function scanHere(input:{channel?:string;context?:boolean;codes?:string[];before?:boolean;auth?:boolean;recipient?:string;consumed?:string[]}={}){
  const f=fixture(),channel=CHANNELS.find(value=>value.id===(input.channel??'here-now'))!,account:Account={id:randomUUID(),channelId:channel.id,email,username:email,createdAt:stamp,status:'needs_verification',hasPassword:false,hereNowEmail:{version:1,emailHash:hereNowSha256(email),requestedAt:stamp,keyName:'site-publishing',stage:'code_sent'}},task=f.store.read().tasks[0],date=new Date(Date.parse(stamp)+(input.before?-1000:1000)).toISOString(),body=(input.codes??['ABCD-2345']).map(code=>`Your verification code is ${code}.`).join(' ');
  const messageId='here-login-message',source=Buffer.from(`Received: from mail.${channel.domain} by mx.google.com with ESMTPS; Tue, 20 Oct 2026 00:00:01 +0000\r\nAuthentication-Results: mx.google.com; dkim=${input.auth===false?'fail':'pass'} header.d=${channel.domain}\r\nSubject: Verification code\r\n\r\n${body}`),client:VerificationMailClient={usable:true,on:()=>{},connect:async()=>{},logout:async()=>{},list:async()=>[],getMailboxLock:async()=>({release(){}}),search:async()=>[1],fetch:async function*(){yield {envelope:{from:[{address:`noreply@${channel.domain}`}],to:[{address:input.recipient??email}],date,messageId},internalDate:date,source}}};
  const context={task:{...task,accountId:account.id,channelId:channel.id,emailWait:input.context===false?undefined:{kind:'code',continuation:'here-now',since:stamp,recipient:email,mailboxId:f.mailbox.id,nextPollAt:stamp,expiresAt:new Date(Date.parse(stamp)+600_000).toISOString(),consumedMessageIds:input.consumed??[]}},site:f.store.read().sites[0],channel,mailbox:f.mailbox,settings:f.store.read().settings,secrets:{get:async()=> 'fixture-password'},getAccount:()=>account,signal:new AbortController().signal} as unknown as ExecutionContext;
  try{return (await scanVerificationBatch([context],{now:new Date(Date.parse(stamp)+60_000),dependencies:{createClient:()=>client,parse:async()=>({text:body,subject:'Verification code',messageId})}})).get(task.id)!}finally{f.close()}
}

test('here automatic mail continuation becomes a verified bound account and clears the transport wait',async()=>{
  const f=fixture(),calls:Array<{url:string;method:string;body:unknown}>=[],fetch=hereFetch(calls),controller=new Controller(f.store,f.vault,f.path,{hereNowDependencies:{fetch},scanMail:async()=>({kind:'code',code:'ABCD-2345',snippet:'Verification code',messageId:'automatic-message'})});
  try{await controller.connectPendingEmailAccounts();assert.equal(f.store.read().tasks[0].checkpoint,'waiting_email');f.store.update(state=>{state.tasks[0].emailWait!.nextPollAt=new Date(0).toISOString()});await (controller as unknown as {emailWaits:{poll():Promise<void>}}).emailWaits.poll();const state=f.store.read();assert.ok(validHereNowAccount(state.accounts[0]));assert.equal(state.tasks[0].status,'queued');assert.equal(state.tasks[0].emailWait,undefined);assert.equal(state.tasks[0].checkpoint,undefined);assert.equal(state.accountBindings.length,1);assert.equal(state.emailConsumptions![0].messageIds[0],'automatic-message');assert.equal(calls.filter(call=>call.method==='POST').length,2)}finally{controller.stop();f.close()}
});

test('an in-flight mail result cannot verify after account email or mailbox binding changes',async()=>{
  for(const change of ['account-email','site-mailbox','mailbox-record']){
    const f=fixture(),calls:Array<{url:string;method:string;body:unknown}>=[],fetch=hereFetch(calls);let deliver:((result:{kind:'code';code:string;snippet:string;messageId:string})=>void)|undefined;
    const controller=new Controller(f.store,f.vault,f.path,{hereNowDependencies:{fetch},scanMail:async()=>new Promise(done=>{deliver=done})});
    try{await controller.connectPendingEmailAccounts();f.store.update(state=>{state.tasks[0].emailWait!.nextPollAt=new Date(0).toISOString()});const work=(controller as unknown as {emailWaits:{poll():Promise<void>}}).emailWaits.poll();while(!deliver)await new Promise(resolve=>setImmediate(resolve));f.store.update(state=>{if(change==='account-email')state.accounts[0].email='changed@example.test';if(change==='site-mailbox')state.sites[0].mailboxId=undefined;if(change==='mailbox-record')state.mailboxes[0].updatedAt=new Date(Date.now()+1000).toISOString()});deliver({kind:'code',code:'ABCD-2345',snippet:'Verification code',messageId:'stale-binding'});await work;assert.equal(calls.filter(call=>call.url.endsWith('/verify-code')).length,0);assert.equal(f.store.read().accounts[0].hasPassword,false);assert.equal(f.store.read().emailConsumptions?.length??0,0)}finally{controller.stop();f.close()}
  }
});

test('a ready here.now connection stays with the site that verified it and is never fanned out to other sites',async()=>{
  const f=fixture('here-now',97),calls:Array<{url:string;method:string;body:unknown}>=[],fetch=hereFetch(calls),controller=new Controller(f.store,f.vault,f.path,{hereNowDependencies:{now,fetch}});
  try{const account=await requestHereNowCode(f.store,email,{now,fetch,siteId:f.store.read().sites[0].id});await verifyHereNowCode(f.store,f.vault,{accountId:account.id,code:'ABCD-2345',siteIds:[f.store.read().sites[0].id]},{now,fetch});calls.length=0;await controller.connectPendingEmailAccounts();assert.equal(f.store.read().accountBindings.length,1);assert.equal(f.store.read().accountBindings[0].siteId,f.store.read().sites[0].id);assert.equal(f.store.read().accounts.length,1);assert.equal(calls.length,0)}finally{controller.stop();f.close()}
});

test('here alphanumeric code is accepted only in its original request context and platform',async()=>{
  assert.equal((await scanHere()).kind,'code');for(const input of [{context:false},{channel:'shiply'},{recipient:'other@example.test'},{before:true},{consumed:['here-login-message']}])assert.equal((await scanHere(input)).kind,'none');assert.equal((await scanHere({auth:false})).kind,'ambiguous');assert.equal((await scanHere({codes:['ABCD-2345','EFGH-6789']})).kind,'ambiguous');
});

test('automatic email connection waits until the task scheduled time for both first request and ready reuse',async()=>{
  for(const channelId of ['shiply','here-now'])for(const ready of [false,true]){
    const f=fixture(channelId),calls:Array<{url:string;method:string;body:unknown}>=[],fetch=hereFetch(calls);
    if(ready&&channelId==='shiply')readyShiply(f);
    if(ready&&channelId==='here-now'){const account:Account={id:randomUUID(),channelId,email,username:personalId,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token',createdAt:stamp,mailboxId:f.mailbox.id,hereNow:{version:1,checkedAt:stamp,accountId:personalId,keyFingerprint:hereNowSha256(hereKey),identity:'verified_personal'}};f.store.update(state=>state.accounts.push(account));f.secrets.set(`account:${account.id}`,hereKey)}
    const controller=new Controller(f.store,f.vault,f.path,{shiplyDependencies:{fetch},hereNowDependencies:{fetch}});
    try{f.store.update(state=>{state.tasks[0].scheduledAt='2099-01-01T00:00:00.000Z'});await controller.connectPendingEmailAccounts();assert.equal(calls.length,0);assert.equal(f.store.read().accounts.length,ready?1:0);assert.equal(f.store.read().accountBindings.length,0);assert.equal(f.store.read().tasks[0].accountId,undefined);assert.equal(f.store.read().tasks[0].checkpoint,'account_handoff')}finally{controller.stop();f.close()}
  }
});

test('ready account key await is scoped identity work and rechecks site mailbox account and binding atomically',async()=>{
  for(const channelId of ['shiply','here-now'])for(const change of ['site-pause','site-mailbox','mailbox-user','account-email','binding','future-task']){
    const f=fixture(channelId);let account:Account;
    if(channelId==='shiply')account=readyShiply(f);else{account={id:randomUUID(),channelId,email,username:personalId,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token',createdAt:stamp,mailboxId:f.mailbox.id,hereNow:{version:1,checkedAt:stamp,accountId:personalId,keyFingerprint:hereNowSha256(hereKey),identity:'verified_personal'}};f.store.update(state=>state.accounts.push(account));f.secrets.set(`account:${account.id}`,hereKey)}
    let release:(()=>void)|undefined;const get=f.vault.get.bind(f.vault);f.vault.get=async key=>{if(key===`account:${account.id}`)await new Promise<void>(resolve=>{release=resolve});return get(key)};
    const controller=new Controller(f.store,f.vault,f.path);
    try{const work=controller.connectPendingEmailAccounts();while(!release)await new Promise(resolve=>setImmediate(resolve));const siteId=f.store.read().sites[0].id,taskId=f.store.read().tasks[0].id;
      const busy={identity:controller.busyFor({identity:true}),site:controller.busyFor({siteIds:[siteId]}),task:controller.busyFor({taskIds:[taskId]}),account:controller.busyFor({accountIds:[account.id]})};
      f.store.update(state=>{if(change==='site-pause')state.sites[0].status='paused';if(change==='site-mailbox')state.sites[0].mailboxId=undefined;if(change==='mailbox-user')state.mailboxes[0].user='changed@example.test';if(change==='account-email')state.accounts[0].email='changed@example.test';if(change==='future-task')state.tasks[0].scheduledAt='2099-01-01T00:00:00.000Z';if(change==='binding')state.accountBindings.push({id:randomUUID(),siteId,channelId,accountId:account.id,createdAt:stamp,updatedAt:stamp})});
      release();await work;assert.deepEqual(busy,{identity:true,site:true,task:true,account:true});assert.equal(f.store.read().accountBindings.length,change==='binding'?1:0);assert.equal(f.store.read().tasks[0].accountId,undefined);assert.equal(controller.busyFor({identity:true,siteIds:[siteId],taskIds:[taskId],accountIds:[account.id]}),false);
    }finally{release?.();controller.stop();f.close()}
  }
});

test('automatic email requests wait while a manual identity connection holds the existing identity scope',async()=>{
  const f=fixture('shiply'),calls:Array<{url:string;method:string;body:unknown}>=[],controller=new Controller(f.store,f.vault,f.path,{shiplyDependencies:{fetch:hereFetch(calls)}});let entered=false,release:(()=>void)|undefined;
  const manual=controller.manageIdentity(async()=>{entered=true;await new Promise<void>(resolve=>{release=resolve})});
  try{while(!entered)await new Promise(resolve=>setImmediate(resolve));await controller.connectPendingEmailAccounts();assert.equal(calls.length,0);assert.equal(f.store.read().accounts.length,0)}finally{f.store.update(state=>{state.settings.autoRun=false});release?.();await manual;controller.stop();await new Promise(resolve=>setImmediate(resolve));f.close()}
});

test('failed email verification preserves skipped paused or replaced waits and retains its encrypted response',async()=>{
  for(const channelId of ['shiply','here-now'])for(const change of ['skip','pause','recipient','request','mailbox','site-mailbox','unchanged']){
    const f=fixture(channelId),calls:Array<{url:string;method:string;body:unknown}>=[];let fail:(()=>void)|undefined;
    const verify=async(_store:unknown,_vault:unknown,input:{accountId:string;code:string;siteIds:string[]}):Promise<Account>=>{
      const accountId=input.accountId;await new Promise<void>(resolve=>{fail=resolve});
      const secret=channelId==='shiply'?`shiply:identity:${accountId}:verify`:hereNowVerifyKey(accountId),ciphers=f.vault.encryptSecrets({[secret]:'fixture retained opaque response'});
      f.store.updateWithCiphers(state=>{const account=state.accounts.find(value=>value.id===accountId)!;if(channelId==='shiply')account.shiply!.stage='verify_opaque';else account.hereNowEmail!.stage='verify_opaque'},ciphers);
      throw Error('simulated verify response failure');
    };
    const controller=new Controller(f.store,f.vault,f.path,{shiplyDependencies:{fetch:hereFetch(calls)},hereNowDependencies:{fetch:hereFetch(calls)},scanMail:async()=>({kind:'code',code:channelId==='shiply'?'123456':'ABCD-2345',snippet:'Verification code',messageId:'failing-verification'}),verifyMailHereNow:verify,verifyMailShiply:verify});
    try{await controller.connectPendingEmailAccounts();f.store.update(state=>{state.tasks[0].emailWait!.nextPollAt=new Date(0).toISOString()});const work=(controller as unknown as {emailWaits:{poll():Promise<void>}}).emailWaits.poll();while(!fail)await new Promise(resolve=>setImmediate(resolve));const accountId=f.store.read().accounts[0].id;
      if(change==='skip')controller.patch(f.store.read().tasks[0].id,{status:'skipped',reasonCode:'user_skipped',message:'Skipped'});
      else if(change==='pause')controller.pause();
      else f.store.update(state=>{if(change==='recipient')state.accounts[0].email='changed@example.test';if(change==='request'){const journal=channelId==='shiply'?state.accounts[0].shiply!:state.accounts[0].hereNowEmail!;journal.requestedAt=new Date(Date.parse(journal.requestedAt)+1000).toISOString()}if(change==='mailbox')state.mailboxes[0].user='changed@example.test';if(change==='site-mailbox')state.sites[0].mailboxId=undefined});
      const before=structuredClone(f.store.read().tasks[0]);fail();await work;const current=f.store.read().tasks[0];if(change==='unchanged'){assert.equal(current.status,'needs_input');assert.equal(current.humanAction?.kind,'account_login')}else assert.deepEqual(current,before);
      assert.ok(f.store.getCipher(channelId==='shiply'?`shiply:identity:${accountId}:verify`:hereNowVerifyKey(accountId)));
    }finally{fail?.();controller.stop();f.close()}
  }
});
