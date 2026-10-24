import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {BEACON_SEND_OTP_URL,BEACON_VERIFY_OTP_URL} from '../src/integrations/beacon';
import {beaconEmailJournalKey,parseBeaconEmailJournal,recoverBeaconEmail,requestBeaconCode,scanBeaconVerification,validBeaconEmailAccount,verifyBeaconCode,type BeaconEmailAccount} from '../src/main/beacon-email';
import {emptyState,Store} from '../src/main/store';
import type {Channel,ExecutionContext,Mailbox,Site,Task} from '../src/shared/types';
import type {VerificationMailClient} from '../src/integrations/mail';
import type {Vault} from '../src/main/vault';

const at='2026-10-24T08:00:00.000Z',email='owner@example.com',code='123456',apiKey=`chk_fixture_${'k'.repeat(24)}`;
const siteId='11111111-1111-4111-8111-111111111111',secondSiteId='22222222-2222-4222-8222-222222222222',thirdSiteId='33333333-3333-4333-8333-333333333333';
const mailboxId='44444444-4444-4444-8444-444444444444';
const channel={id:'beacon',name:'Beacon',domain:'beacon.host',url:'https://beacon.host',submitUrl:'https://beacon.host/v1/publish',categories:['general'],languages:['en'],kind:'article',emailRequired:true,accountRequired:true,articleRequired:true,free:'yes',freeNote:'fixture',automation:'api',quality:'B',qualityReason:'fixture',provenance:'built-in',evidenceStatus:'source_checked',rulesUrl:'https://beacon.host',checkedAt:at,notes:'fixture',allowedHosts:['beacon.host'],enabled:true} as Channel;
const site=(id:string,domain:string):Site=>({id,domain,url:`https://${domain}/`,email,name:domain,description:'fixture',category:'general',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:at,mailboxId} as Site);
const task=(id:string,owner:string):Task=>({id,siteId:owner,channelId:'beacon',sourceDomain:'beacon.host',status:'queued',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'fixture'});
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
function response(url:string,value:unknown,status=200){const result=new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});Object.defineProperty(result,'url',{value:url});return result}
function fixture(){
  const store=new Store(':memory:'),plain=new Map<string,string>();let failAccountEncryption=false;
  const vault={ready:true,available:()=>true,get:async(key:string)=>plain.get(key),set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>{if(failAccountEncryption&&key.startsWith('account:'))throw Error('synthetic encryption failure');plain.set(key,value);return [key,`enc:${Buffer.from(value).toString('base64url')}`]}))} as unknown as Vault;
  const state=emptyState();state.sites=[site(siteId,'one.example.com'),site(secondSiteId,'two.example.com'),site(thirdSiteId,'three.example.com')];state.tasks=[task('55555555-5555-4555-8555-555555555555',siteId),task('66666666-6666-4666-8666-666666666666',secondSiteId)];store.update(current=>Object.assign(current,state));
  const authorize=()=>true as const;return {store,vault,plain,authorize,setFailAccountEncryption(value:boolean){failAccountEncryption=value},close(){store.close()}};
}
async function request(f:ReturnType<typeof fixture>,fetch:(url:string,init:RequestInit)=>Promise<Response>){return requestBeaconCode(f.store,f.vault,email,{siteId,channel,assertAuthorized:f.authorize,allowExternalWrite:true,now:()=>new Date(at),fetch})}

test('request stores intent and raw response only in encrypted journal, then binds a ten-minute email wait',async()=>{const f=fixture(),calls:string[]=[];try{
  const account=await request(f,async(url,init)=>{calls.push(url);assert.equal(init.method,'POST');assert.deepEqual(JSON.parse(String(init.body)),{email});assert.ok(f.store.getCipher(beaconEmailJournalKey((f.store.read().accounts[0] as BeaconEmailAccount).id)));return response(url,{success:true})});
  assert.deepEqual(calls,[BEACON_SEND_OTP_URL]);assert.equal(account.beaconEmail?.stage,'code_sent');assert.equal(account.beaconEmail?.senderDomain,'mail.beacon.host');const savedTask=f.store.read().tasks[0];assert.equal(savedTask.checkpoint,'waiting_email');assert.equal((savedTask.emailWait as any).continuation,'beacon');assert.equal(Date.parse(savedTask.emailWait!.expiresAt)-Date.parse(savedTask.emailWait!.since),10*60_000);
  const publicState=JSON.stringify(f.store.read());assert.equal(publicState.includes(code),false);assert.equal(publicState.includes('requestHash'),false);assert.equal(publicState.includes('codeHash'),false);const journal=parseBeaconEmailJournal(await f.vault.get(beaconEmailJournalKey(account.id)),account);assert.ok(journal?.send.opaque);assert.ok(journal?.send.receipt);assert.equal(validBeaconEmailAccount(account),true);
}finally{f.close()}});

test('same pending email never sends a second request, including after an unknown transport result',async()=>{const f=fixture();let posts=0;try{
  await assert.rejects(()=>request(f,async()=>{posts++;throw Error('synthetic reset')}),/结果不明/);const account=f.store.read().accounts[0] as BeaconEmailAccount;assert.equal(account.beaconEmail?.stage,'send_unknown');await assert.rejects(()=>request(f,async()=>{posts++;throw Error('must not call')}),/不会重复请求/);assert.equal(posts,1);await assert.rejects(()=>recoverBeaconEmail(f.store,f.vault,{accountId:account.id},{channel,assertAuthorized:f.authorize,now:()=>new Date(at)}),/尚不可恢复/);assert.equal(posts,1);
}finally{f.close()}});

test('verification saves one reusable account key, binds multiple sites, and omits OTP hashes from public state',async()=>{const f=fixture();let verifyPosts=0;try{
  const pending=await request(f,async url=>response(url,{success:true}));const verified=await verifyBeaconCode(f.store,f.vault,{accountId:pending.id,code,siteIds:[siteId,secondSiteId]},{channel,assertAuthorized:f.authorize,allowExternalWrite:true,now:()=>new Date(at),fetch:async(url,init)=>{verifyPosts++;assert.equal(url,BEACON_VERIFY_OTP_URL);assert.deepEqual(JSON.parse(String(init.body)),{email,code});return response(url,{apiKey,account:{id:'remote-owner',email}})}});
  assert.equal(verifyPosts,1);assert.equal(verified.beaconEmail?.stage,'ready');assert.equal(verified.beaconEmail?.apiKeyFingerprint,sha(apiKey));assert.ok(f.store.getCipher(`account:${verified.id}`)?.startsWith('enc:'));assert.equal(f.store.read().accountBindings.filter(value=>value.channelId==='beacon').length,2);assert.equal(f.store.read().tasks[0].emailWait,undefined);const state=JSON.stringify(f.store.read());assert.equal(state.includes(code),false);assert.equal(state.includes(sha(code)),false);assert.equal(state.includes('codeHash'),false);
  let duplicatePosts=0;const reused=await requestBeaconCode(f.store,f.vault,email,{siteId:thirdSiteId,channel,assertAuthorized:f.authorize,allowExternalWrite:true,fetch:async()=>{duplicatePosts++;throw Error('must not call')}});assert.equal(reused.id,verified.id);assert.equal(duplicatePosts,0);assert.equal(f.store.read().accountBindings.filter(value=>value.channelId==='beacon').length,3);
}finally{f.close()}});

test('encrypted successful verification response recovers without another POST after key promotion failure',async()=>{const f=fixture();let posts=0;try{
  const pending=await request(f,async url=>response(url,{success:true}));f.setFailAccountEncryption(true);await assert.rejects(()=>verifyBeaconCode(f.store,f.vault,{accountId:pending.id,code,siteIds:[siteId]},{channel,assertAuthorized:f.authorize,allowExternalWrite:true,now:()=>new Date(at),fetch:async url=>{posts++;return response(url,{apiKey,account:{id:'remote-owner',email}})}}),/结果不明/);assert.equal((f.store.read().accounts[0] as BeaconEmailAccount).beaconEmail?.stage,'verify_opaque');f.setFailAccountEncryption(false);const recovered=await recoverBeaconEmail(f.store,f.vault,{accountId:pending.id,siteIds:[siteId]},{channel,assertAuthorized:f.authorize,now:()=>new Date(at)});assert.equal(recovered.beaconEmail?.stage,'ready');assert.equal(posts,1);
}finally{f.close()}});

test('recovery closes the crash window after account key commit but before email journal reaches ready',async()=>{const f=fixture();let posts=0;try{
  const pending=await request(f,async url=>response(url,{success:true})),crashingStore={read:()=>f.store.read(),getCipher:(key:string)=>f.store.getCipher(key),updateWithCiphers:f.store.updateWithCiphers.bind(f.store),update:()=>{throw Error('synthetic crash after account commit')}};
  await assert.rejects(()=>verifyBeaconCode(crashingStore as never,f.vault,{accountId:pending.id,code,siteIds:[siteId]},{channel,assertAuthorized:f.authorize,allowExternalWrite:true,now:()=>new Date(at),fetch:async url=>{posts++;return response(url,{apiKey,account:{id:'remote-owner',email}})}}),/结果不明/);const interrupted=f.store.read().accounts[0] as BeaconEmailAccount;assert.equal(interrupted.beaconEmail?.stage,'verify_opaque');assert.equal(interrupted.status,'registered');assert.ok(f.store.getCipher(`account:${pending.id}`));assert.equal(validBeaconEmailAccount(interrupted),true);
  const recovered=await recoverBeaconEmail(f.store,f.vault,{accountId:pending.id,siteIds:[siteId]},{channel,assertAuthorized:f.authorize,now:()=>new Date(at)});assert.equal(recovered.beaconEmail?.stage,'ready');assert.equal(posts,1);
}finally{f.close()}});

test('expired or email-mismatched six-digit verification cannot create a usable account',async()=>{const f=fixture();let posts=0;try{
  const pending=await request(f,async url=>response(url,{success:true}));await assert.rejects(()=>verifyBeaconCode(f.store,f.vault,{accountId:pending.id,code,siteIds:[siteId]},{channel,assertAuthorized:f.authorize,allowExternalWrite:true,now:()=>new Date(Date.parse(at)+10*60_000),fetch:async()=>{posts++;throw Error('must not call')}}),/十分钟/);assert.equal(posts,0);await assert.rejects(()=>verifyBeaconCode(f.store,f.vault,{accountId:pending.id,code,siteIds:[siteId]},{channel,assertAuthorized:f.authorize,allowExternalWrite:true,now:()=>new Date(at),fetch:async url=>{posts++;return response(url,{apiKey,account:{id:'remote-owner',email:'other@example.com'}})}}),/被拒/);assert.equal(posts,1);assert.notEqual((f.store.read().accounts[0] as BeaconEmailAccount).beaconEmail?.stage,'ready');assert.equal(f.store.getCipher(`account:${pending.id}`),undefined);
}finally{f.close()}});

test('Beacon mail scan filters sender, recipient and INTERNALDATE before reading any body',async()=>{const f=fixture();try{
  const pending=await request(f,async url=>response(url,{success:true})),saved=f.store.read(),account=saved.accounts[0] as BeaconEmailAccount,wait=saved.tasks[0].emailWait!,mailbox={id:mailboxId,label:'Gmail',host:'imap.gmail.com',port:993,user:email,secure:true,hasPassword:true,aliases:[],createdAt:at,updatedAt:at,verifiedAt:at} as Mailbox;
  let sourceFetches=0,searchQuery:unknown;const unrelated={envelope:{from:[{address:'news@example.net'}],to:[{address:email}]},internalDate:new Date(at)};
  const client={usable:true,connect:async()=>{},getMailboxLock:async()=>({release(){}}),logout:async()=>{},list:async()=>[],search:async(query:unknown)=>{searchQuery=query;return [7]},fetch:async function*(range:string,query:{source?:unknown}){assert.equal(range,'7');if(query.source){sourceFetches++;yield {...unrelated,source:Buffer.from('Subject: verification code 123456\r\n\r\ncode: 123456')}}else yield unrelated}} as unknown as VerificationMailClient;
  const context={mailbox,settings:{mail:mailbox},site:saved.sites[0],channel,task:{...saved.tasks[0],emailWait:wait},signal:new AbortController().signal,secrets:{get:async(key:string)=>key.startsWith('mailbox:')?'password':f.plain.get(key)},getAccount:()=>account} as unknown as ExecutionContext;
  const result=await scanBeaconVerification(context,{now:new Date(Date.parse(at)+60_000),dependencies:{createClient:()=>client}});assert.deepEqual(result,{kind:'none'});assert.equal(sourceFetches,0);assert.deepEqual(searchQuery,{to:email,since:new Date(Date.parse(at)-10*60_000),from:'beacon.host'});
}finally{f.close()}});

test('Beacon mail scan accepts one authenticated Gmail message only after the narrow envelope pass',async()=>{const f=fixture();try{
  await request(f,async url=>response(url,{success:true}));const saved=f.store.read(),account=saved.accounts[0] as BeaconEmailAccount,wait=saved.tasks[0].emailWait!,mailbox={id:mailboxId,label:'Gmail',host:'imap.gmail.com',port:993,user:email,secure:true,hasPassword:true,aliases:[],createdAt:at,updatedAt:at,verifiedAt:at} as Mailbox,received=new Date(Date.parse(at)+60_000),envelope={from:[{address:'no-reply@mail.beacon.host'}],to:[{address:email}],date:received,messageId:'<beacon-fixture@example>'};
  const source=Buffer.from(['Received: from mail.beacon.host by mx.google.com;','Authentication-Results: mx.google.com; dkim=pass header.d=beacon.host header.i=@beacon.host','From: Beacon <no-reply@mail.beacon.host>',`To: ${email}`,`Date: ${received.toUTCString()}`,'Message-ID: <beacon-fixture@example>','Subject: Your verification code: 123456','','Your verification code: 123456'].join('\r\n'));let metadataFetches=0,sourceFetches=0;
  const client={usable:true,connect:async()=>{},getMailboxLock:async()=>({release(){}}),logout:async()=>{},list:async()=>[],search:async()=>[8],fetch:async function*(range:string,query:{source?:unknown}){assert.equal(range,'8');if(query.source){sourceFetches++;yield {envelope,internalDate:received,source}}else{metadataFetches++;yield {envelope,internalDate:received}}}} as unknown as VerificationMailClient;
  const context={mailbox,settings:{mail:mailbox},site:saved.sites[0],channel,task:{...saved.tasks[0],emailWait:wait},signal:new AbortController().signal,secrets:{get:async(key:string)=>key.startsWith('mailbox:')?'password':f.plain.get(key)},getAccount:()=>account} as unknown as ExecutionContext;
  const result=await scanBeaconVerification(context,{now:received,dependencies:{createClient:()=>client}});assert.equal(metadataFetches,1);assert.equal(sourceFetches,1);assert.equal(result.kind,'code');if(result.kind==='code')assert.equal(result.code,code);
}finally{f.close()}});
