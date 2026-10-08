import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {connectProseAccount,type ProseConnectionVault} from '../src/main/article-connections';
import {validSerializedProseCredentials} from '../src/integrations/prose';
import type {Channel,ProseReceipt,Site} from '../src/shared/types';
import type {ProseIdentity,ProseTransport} from '../src/integrations/prose-transport';

const SITE_ONE='11111111-1111-4111-8111-111111111111',SITE_TWO='22222222-2222-4222-8222-222222222222',TASK_ID='33333333-3333-4333-8333-333333333333',NOW='2026-10-09T00:00:00.000Z';
const KEY='synthetic-prose-private-key';
const IDENTITY:ProseIdentity={name:'fixture-author',id:'pico-user-fixture',createdAt:NOW,plusExpiresAt:null,keyFingerprint:'SHA256:'+'A'.repeat(43),publishingEligibility:'unknown'};
const PROSE_CHANNEL:Channel={id:'prose',name:'Prose',domain:'prose.sh',url:'https://prose.sh/',submitUrl:'https://prose.sh/',categories:['content'],languages:['en'],kind:'article',emailRequired:false,accountRequired:true,articleRequired:true,free:'yes',freeNote:'fixture',automation:'api',quality:'A',qualityReason:'fixture',provenance:'built-in',rulesUrl:'https://prose.sh/',checkedAt:'2026-10-09',notes:'disabled fixture',allowedHosts:['prose.sh','pico.sh'],enabled:false};

class FixtureVault implements ProseConnectionVault{
  failEncrypt=false;
  constructor(private store:Store){}
  async get(key:string){const value=this.store.getCipher(key);return value&&value.startsWith('fixture:')?Buffer.from(value.slice(8),'base64').toString('utf8'):undefined}
  encryptSecrets(values:Record<string,string>){if(this.failEncrypt)throw Error('raw '+KEY);return Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'fixture:'+Buffer.from(value).toString('base64')]))}
}
function site(id:string,index:number):Site{return {id,url:`https://site${index}.example.com/`,domain:`site${index}.example.com`,name:'Fixture',email:'owner@example.com',description:'Educational publication',category:'content',language:'en',monthlyTarget:2,status:'ready',createdAt:NOW}}
function fixture(){const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=false;state.sites=[site(SITE_ONE,1),site(SITE_TWO,2)]});return {store,vault:new FixtureVault(store)}}
function transport(identity:ProseIdentity=IDENTITY,onRead?:()=>void|Promise<void>):Pick<ProseTransport,'readIdentity'>{return {readIdentity:async()=>{await onRead?.();return structuredClone(identity)}}}
function secret(store:Store,id:string){const value=store.getCipher('account:'+id);if(!value?.startsWith('fixture:'))throw Error('missing fixture cipher');return Buffer.from(value.slice(8),'base64').toString('utf8')}

test('fresh Prose connection only reads identity, then atomically stores an ineligible account, binding, and strict secret',async()=>{
  const {store,vault}=fixture();let reads=0;
  try{
    const account=await connectProseAccount(store,vault,{privateKey:KEY,passphrase:'fixture-passphrase',siteIds:[SITE_ONE]},PROSE_CHANNEL,{transport:transport(IDENTITY,()=>{reads++})});
    const saved=store.read();assert.equal(reads,1);assert.equal(account.status,'needs_verification');assert.equal(saved.accounts[0].status,'needs_verification');assert.equal(saved.accounts[0].diagnostic?.code,'verification_required');assert.match(saved.accounts[0].diagnostic?.message??'',/邀请.*当前不会自动发布/);assert.equal(saved.accounts[0].publicationUrl,'https://fixture-author.prose.sh/');assert.deepEqual(saved.accountBindings.map(item=>item.siteId),[SITE_ONE]);assert.equal(validSerializedProseCredentials(secret(store,account.id),account),true);assert.equal(JSON.stringify(saved).includes(KEY),false);assert.equal(JSON.stringify(store.allCiphers()).includes(KEY),false);
  }finally{store.close()}
});

test('invalid site and pre-aborted request stop before SSH identity access or encryption',async()=>{
  for(const input of [{siteIds:['missing'],signal:undefined},{siteIds:[SITE_ONE],signal:(()=>{const c=new AbortController();c.abort();return c.signal})()}]){
    const {store,vault}=fixture();let reads=0,encryptions=0;const original=vault.encryptSecrets.bind(vault);vault.encryptSecrets=values=>{encryptions++;return original(values)};
    try{await assert.rejects(connectProseAccount(store,vault,{privateKey:KEY,siteIds:input.siteIds},PROSE_CHANNEL,{transport:transport(IDENTITY,()=>{reads++}),signal:input.signal}),/网站|取消/);assert.equal(reads,0);assert.equal(encryptions,0);assert.equal(store.read().accounts.length,0);assert.deepEqual(store.allCiphers(),{})}finally{store.close()}
  }
});

test('credentials that cannot fit the 16384-byte secret contract stop before SSH identity access',async()=>{
  const {store,vault}=fixture();let reads=0;try{await assert.rejects(connectProseAccount(store,vault,{privateKey:'k'.repeat(16_000),passphrase:'p'.repeat(300),siteIds:[SITE_ONE]},PROSE_CHANNEL,{transport:transport(IDENTITY,()=>{reads++})}),/记录上限/);assert.equal(reads,0);assert.equal(store.read().accounts.length,0);assert.deepEqual(store.allCiphers(),{})}finally{store.close()}
});

test('cancelled identity response is ignored even when a fixture transport returns late',async()=>{
  const {store,vault}=fixture(),abort=new AbortController();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>{void resolve});let mark!:()=>void;const seen=new Promise<void>(resolve=>mark=resolve);
  try{
    const pending=connectProseAccount(store,vault,{privateKey:KEY,siteIds:[SITE_ONE]},PROSE_CHANNEL,{signal:abort.signal,transport:transport(IDENTITY,async()=>{mark();await gate})});
    await seen;abort.abort();release();await assert.rejects(pending,/取消/);assert.equal(store.read().accounts.length,0);assert.deepEqual(store.allCiphers(),{});void started;
  }finally{store.close()}
});

test('site or existing account changes while identity is awaited fail closed',async()=>{
  for(const mutate of ['site','account'] as const){
    const {store,vault}=fixture();let release!:()=>void,mark!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),seen=new Promise<void>(resolve=>mark=resolve);
    try{
      let accountId:string|undefined;
      if(mutate==='account')accountId=(await connectProseAccount(store,vault,{privateKey:KEY,siteIds:[SITE_ONE]},PROSE_CHANNEL,{transport:transport()})).id;
      const beforeCipher=accountId?store.getCipher('account:'+accountId):undefined;
      const pending=connectProseAccount(store,vault,{privateKey:KEY,siteIds:[SITE_ONE],accountId},PROSE_CHANNEL,{transport:transport(IDENTITY,async()=>{mark();await gate})});await seen;
      store.update(state=>{if(mutate==='site')state.sites=state.sites.filter(item=>item.id!==SITE_ONE);else state.accounts.find(item=>item.id===accountId)!.displayName='changed-during-read'});release();
      await assert.rejects(pending,/未保存|已改变|不存在/);if(accountId)assert.equal(store.getCipher('account:'+accountId),beforeCipher);
    }finally{store.close()}
  }
});

test('same username with another platform id is rejected and a key fingerprint cannot change after any receipt',async()=>{
  const {store,vault}=fixture();
  try{
    const account=await connectProseAccount(store,vault,{privateKey:KEY,siteIds:[SITE_ONE]},PROSE_CHANNEL,{transport:transport()}),before=store.read(),beforeCipher=store.getCipher('account:'+account.id);
    await assert.rejects(connectProseAccount(store,vault,{privateKey:KEY+'different',siteIds:[SITE_ONE],accountId:account.id},PROSE_CHANNEL,{transport:transport({...IDENTITY,id:'other-platform-id'})}),/另一 Prose 出版身份/);assert.deepEqual(store.read(),before);assert.equal(store.getCipher('account:'+account.id),beforeCipher);
    const receipt:ProseReceipt={username:IDENTITY.name,platformUserId:IDENTITY.id,keyFingerprint:IDENTITY.keyFingerprint,filename:'lf-33333333333343338333333333333333.md',sourceHash:'a'.repeat(64),stage:'published'};
    store.update(state=>state.tasks.push({id:TASK_ID,siteId:SITE_ONE,channelId:'prose',accountId:account.id,sourceDomain:'prose.sh',status:'live',createdAt:NOW,scheduledAt:NOW,updatedAt:NOW,attempts:1,message:'fixture',prose:receipt,firstLiveAt:NOW}));const withReceipt=store.read();
    await assert.rejects(connectProseAccount(store,vault,{privateKey:KEY+'rotated',siteIds:[SITE_ONE],accountId:account.id},PROSE_CHANNEL,{transport:transport({...IDENTITY,keyFingerprint:'SHA256:'+'B'.repeat(43)})}),/不能更换密钥指纹|未保存/);assert.deepEqual(store.read(),withReceipt);assert.equal(store.getCipher('account:'+account.id),beforeCipher);
  }finally{store.close()}
});

test('unresolved receipt blocks unbinding and leaves the prior account, binding, and cipher unchanged',async()=>{
  const {store,vault}=fixture();
  try{
    const account=await connectProseAccount(store,vault,{privateKey:KEY,siteIds:[SITE_ONE,SITE_TWO]},PROSE_CHANNEL,{transport:transport()});
    store.update(state=>state.tasks.push({id:TASK_ID,siteId:SITE_ONE,channelId:'prose',accountId:account.id,sourceDomain:'prose.sh',status:'needs_input',createdAt:NOW,scheduledAt:NOW,updatedAt:NOW,attempts:1,message:'unknown',prose:{username:IDENTITY.name,platformUserId:IDENTITY.id,keyFingerprint:IDENTITY.keyFingerprint,filename:'lf-33333333333343338333333333333333.md',sourceHash:'a'.repeat(64),stage:'submitting'}}));
    const before=store.read(),beforeCipher=store.getCipher('account:'+account.id);await assert.rejects(connectProseAccount(store,vault,{privateKey:KEY,siteIds:[SITE_TWO],accountId:account.id},PROSE_CHANNEL,{transport:transport()}),/未保存/);assert.deepEqual(store.read(),before);assert.equal(store.getCipher('account:'+account.id),beforeCipher);
  }finally{store.close()}
});

test('vault and database failures never expose the supplied key or partially save connection state',async()=>{
  for(const failure of ['vault','store'] as const){const {store,vault}=fixture();try{if(failure==='vault')vault.failEncrypt=true;else store.updateWithCiphers=(()=>{throw Error('database failed with '+KEY)}) as typeof store.updateWithCiphers;let message='';try{await connectProseAccount(store,vault,{privateKey:KEY,siteIds:[SITE_ONE]},PROSE_CHANNEL,{transport:transport()})}catch(error){message=String((error as Error).message)}assert.equal(message.includes(KEY),false);assert.equal(store.read().accounts.length,0);assert.equal(store.read().accountBindings.length,0);assert.deepEqual(store.allCiphers(),{})}finally{store.close()}}
});

test('same-key reconnect preserves an already accepted account state',async()=>{
  const {store,vault}=fixture();try{const account=await connectProseAccount(store,vault,{privateKey:KEY,siteIds:[SITE_ONE]},PROSE_CHANNEL,{transport:transport()});store.update(state=>{const current=state.accounts.find(item=>item.id===account.id)!;current.status='registered';current.diagnostic=undefined});const updated=await connectProseAccount(store,vault,{privateKey:KEY,siteIds:[SITE_ONE,SITE_TWO],accountId:account.id},PROSE_CHANNEL,{transport:transport()});assert.equal(updated.status,'registered');assert.equal(store.read().accounts[0].status,'registered');assert.deepEqual(store.read().accountBindings.map(item=>item.siteId).sort(),[SITE_ONE,SITE_TWO])}finally{store.close()}}
);
