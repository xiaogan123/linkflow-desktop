import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {connectMarkest} from '../src/main/markest-management';
import {checkMarkestReadAccess,markestKeyFingerprint,serializeMarkestKey,validMarkestReadAccount} from '../src/integrations/markest-connection';
import {validateBackup} from '../src/main/backup-validation';
import {saveAccountAtomic} from '../src/main/account-service';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {CHANNELS} from '../src/integrations/catalog';
import type {Account,Site} from '../src/shared/types';

const stamp='2026-10-09T00:00:00.000Z',one='11111111-1111-4111-8111-111111111111',two='22222222-2222-4222-8222-222222222222';
const key='mk_live_'+'a'.repeat(48),otherKey='mk_live_'+'b'.repeat(48),channel=CHANNELS.find(item=>item.id==='markest')!;
const response=(body:unknown={pastes:[],total:0},status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const input=(siteIds:string[]=[one])=>({apiKey:key,declaredEmail:'author@example.com',label:'My reader publication',siteIds});
function fixture(){
  const store=new Store(':memory:');
  store.update(state=>{state.settings.autoRun=false;state.sites=[one,two].map((id,index):Site=>({id,url:`https://site${index}.example.com/`,domain:`site${index}.example.com`,name:'Fixture',email:'author@example.com',description:'Original reader guide',category:'content',language:'en',monthlyTarget:2,status:'ready',createdAt:stamp}))});
  const vault={encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([k,v])=>[k,'encrypted:'+v]))};
  const remote=async()=>response();
  return {store,vault,remote};
}
function backup(store:Store){return {state:store.read(),secrets:Object.fromEntries(Object.entries(store.allCiphers()).map(([k,v])=>[k,v.slice('encrypted:'.length)]))}}

test('Markest validates only one fixed GET and discards all private paste fields',async()=>{
  const {store,vault}=fixture();let calls=0;
  try{
    const account=await connectMarkest(store,vault,input(),{fetch:async(url,init)=>{calls++;assert.equal(url,'https://marke.st/api/v1/pastes');assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');assert.deepEqual(init.headers,{Authorization:'Bearer '+key,Accept:'application/json'});assert.equal(init.body,undefined);return response({pastes:[{id:'private-paste-id',content:'private-content-not-to-retain',email:'private@example.com'}],total:1})}});
    assert.equal(calls,1);assert.equal(account.status,'unknown');assert.equal(account.registeredAt,undefined);assert.equal(account.verifiedAt,undefined);assert.equal(account.publicationUrl,undefined);assert(validMarkestReadAccount(account));
    assert.equal(store.read().accountBindings[0].accountId,account.id);assert.equal(store.allCiphers()['account:'+account.id],'encrypted:'+serializeMarkestKey(key));
    const state=JSON.stringify(store.read());for(const secret of [key,'private-paste-id','private-content-not-to-retain','private@example.com'])assert(!state.includes(secret));
  }finally{store.close()}
});

test('Markest malformed input and pre-cancelled request never contact the server',async()=>{
  let calls=0;const fetch=async()=>{calls++;return response()};
  await assert.rejects(checkMarkestReadAccess('invalid',{fetch}),/格式/);
  const abort=new AbortController();abort.abort();await assert.rejects(checkMarkestReadAccess(key,{fetch,signal:abort.signal}),/取消/);
  const {store,vault}=fixture();try{await assert.rejects(connectMarkest(store,vault,{...input(),siteIds:['invalid']},{fetch}),/格式/);await assert.rejects(connectMarkest(store,vault,input(['33333333-3333-4333-8333-333333333333']),{fetch}),/网站/);assert.equal(store.read().accounts.length,0);assert.deepEqual(store.allCiphers(),{});assert.equal(calls,0)}finally{store.close()}
});

test('Markest rejects non-authoritative status, redirect, content type and JSON without leaking response text',async()=>{
  const factories:Array<()=>Response>=[... [401,403,429,500,302].map(status=>()=>response({error:key},status)),()=>new Response(key,{headers:{'content-type':'text/html'}}),()=>new Response(key,{headers:{'content-type':'application/json'}}),()=>response({pastes:[]}),()=>response({pastes:[{}],total:1}),()=>response({pastes:[{id:'one'}],total:0}),()=>response({pastes:[],total:-1}),()=>{const r=response();Object.defineProperty(r,'url',{value:'https://unexpected.example.com/api'});return r},()=>{const r=response();Object.defineProperty(r,'redirected',{value:true});return r}];
  for(const factory of factories)await assert.rejects(checkMarkestReadAccess(key,{fetch:async()=>factory()}),error=>error instanceof Error&&!error.message.includes(key));
  await assert.rejects(checkMarkestReadAccess(key,{fetch:async()=>{throw Error('network '+key)}}),error=>error instanceof Error&&!error.message.includes(key));
});

test('Markest response size, stalled headers and stalled bodies are bounded and cancelled',async()=>{
  await assert.rejects(checkMarkestReadAccess(key,{fetch:async()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'1048577'}})}),/限制/);
  await assert.rejects(checkMarkestReadAccess(key,{fetch:async()=>new Response('x'.repeat(1048577),{headers:{'content-type':'application/json'}})}),/限制/);
  let signal:AbortSignal|undefined;
  await assert.rejects(checkMarkestReadAccess(key,{timeoutMs:5,fetch:async(_url,init)=>{signal=init.signal as AbortSignal;return new Promise(()=>{})}}),/超时/);assert.equal(signal?.aborted,true);
  let cancelled=false;const body=new ReadableStream<Uint8Array>({pull:()=>new Promise(()=>{}),cancel:()=>{cancelled=true}});
  await assert.rejects(checkMarkestReadAccess(key,{timeoutMs:5,fetch:async()=>new Response(body,{headers:{'content-type':'application/json'}})}),/超时/);assert.equal(cancelled,true);
  const abort=new AbortController();const pending=checkMarkestReadAccess(key,{signal:abort.signal,fetch:async()=>new Promise(()=>{})});abort.abort();await assert.rejects(pending,/取消/);
});

test('Markest same key reuses one local identity; different key cannot replace it',async()=>{
  const {store,vault,remote}=fixture();try{
    const first=await connectMarkest(store,vault,input(),{fetch:remote});
    const second=await connectMarkest(store,vault,input([two]),{fetch:remote});assert.equal(first.id,second.id);assert.equal(store.read().accounts.length,1);assert.equal(store.read().accountBindings.length,2);
    await connectMarkest(store,vault,{...input([two]),accountId:first.id},{fetch:remote});assert.deepEqual(store.read().accountBindings.map(b=>b.siteId),[two]);
    let calls=0;const before=store.read(),ciphers=store.allCiphers();await assert.rejects(connectMarkest(store,vault,{...input(),apiKey:otherKey,accountId:first.id},{fetch:async()=>{calls++;return response()}}),/不同 key/);assert.equal(calls,0);assert.deepEqual(store.read(),before);assert.deepEqual(store.allCiphers(),ciphers);
    const other=await connectMarkest(store,vault,{...input([]),apiKey:otherKey},{fetch:remote});assert.notEqual(other.id,first.id);assert.equal(store.read().accounts.length,2);
  }finally{store.close()}
});

test('Markest site removal, cancellation, encryption and binding failures leave no partial account/cipher',async()=>{
  for(const mode of ['site','cancel','encrypt','binding']){
    const {store,vault}=fixture();const abort=new AbortController();
    try{
      if(mode==='binding')store.update(state=>state.tasks.push({id:'33333333-3333-4333-8333-333333333333',siteId:one,accountId:'44444444-4444-4444-8444-444444444444',channelId:'markest',sourceDomain:'marke.st',status:'needs_input',createdAt:stamp,updatedAt:stamp,scheduledAt:stamp,submittedAt:stamp,attempts:1,message:'uncertain'}));
      const before=store.read();await assert.rejects(connectMarkest(store,mode==='encrypt'?{encryptSecrets:()=>{throw Error('encryption unavailable')}}:vault,input(),{signal:abort.signal,fetch:async()=>{if(mode==='site')store.update(state=>state.sites=state.sites.filter(s=>s.id!==one));if(mode==='cancel')abort.abort();return response()}}));
      assert.equal(store.read().accounts.length,0);assert.equal(store.read().accountBindings.length,0);assert.deepEqual(store.allCiphers(),{});if(mode!=='site')assert.deepEqual(store.read(),before);
    }finally{store.close()}
  }
});

test('Markest re-verification refuses concurrent account mutation and duplicate key insertion',async()=>{
  for(const mode of ['edit','duplicate']){
    const {store,vault,remote}=fixture();try{
      const account=await connectMarkest(store,vault,input(),{fetch:remote}),ciphers=store.allCiphers();
      await assert.rejects(connectMarkest(store,vault,{...input([two]),accountId:account.id},{fetch:async()=>{store.update(state=>{if(mode==='edit')state.accounts[0].displayName='Concurrent edit';else state.accounts.push({...account,id:'55555555-5555-4555-8555-555555555555'})});return response()}}),/变化|已连接/);
      assert.equal(store.read().accountBindings.length,1);assert.deepEqual(store.allCiphers(),ciphers);if(mode==='edit')assert.equal(store.read().accounts[0].displayName,'Concurrent edit');
    }finally{store.close()}
  }
});

test('Markest cipher persistence failure rolls back state and earlier encrypted values',async()=>{
  const {store,vault,remote}=fixture();try{
    const account=await connectMarkest(store,vault,input(),{fetch:remote}),before=store.read(),ciphers=store.allCiphers();
    const setCipher=store.setCipher.bind(store);
    store.setCipher=(key,value)=>{setCipher(key,value);throw Error('Synthetic SQLite failure')};
    await assert.rejects(connectMarkest(store,vault,{...input([two]),accountId:account.id},{fetch:remote}),/SQLite/);
    assert.deepEqual(store.read(),before);assert.deepEqual(store.allCiphers(),ciphers);
  }finally{store.close()}
});

test('Markest cancellation after encryption still prevents the atomic commit',async()=>{
  const {store,vault,remote}=fixture();const abort=new AbortController();try{
    await assert.rejects(connectMarkest(store,{encryptSecrets:values=>{const result=vault.encryptSecrets(values);abort.abort();return result}},input(),{fetch:remote,signal:abort.signal}),/取消/);
    assert.equal(store.read().accounts.length,0);assert.equal(store.read().accountBindings.length,0);assert.deepEqual(store.allCiphers(),{});
  }finally{store.close()}
});

test('Markest backups retain strict read-only proof and credential correlation',async()=>{
  const {store,vault,remote}=fixture();try{
    const account=await connectMarkest(store,vault,input(),{fetch:remote});const data=backup(store);
    assert.deepEqual(validateBackup(data),data);assert.equal(account.markestReadAccess!.keyFingerprint,markestKeyFingerprint(key));
    const mutations:Array<(x:ReturnType<typeof backup>)=>void>=[x=>{x.state.accounts[0].status='registered'},x=>{x.state.accounts[0].verifiedAt=stamp},x=>{x.state.accounts[0].channelId='github'},x=>{x.state.accounts[0].markestReadAccess!.keyFingerprint='c'.repeat(64)},x=>{x.secrets['account:'+account.id]=serializeMarkestKey(otherKey)},x=>{x.secrets['account:'+account.id]=JSON.stringify({version:1,apiKey:key,canPublish:true})},x=>{Object.assign(x.state.accounts[0].markestReadAccess!,{canPublish:true})},x=>{x.state.accounts.push({...x.state.accounts[0],id:'55555555-5555-4555-8555-555555555555'})},x=>{delete x.state.accounts[0].markestReadAccess}];
    for(const mutate of mutations){const copy=structuredClone(data);mutate(copy);assert.throws(()=>validateBackup(copy))}
  }finally{store.close()}
});

test('Markest cannot become automatic through a key, generic import or forged registered state',async()=>{
  const {store,vault,remote}=fixture();try{
    assert.equal(channel.enabled,false);assert.equal(channel.automation,'manual');
    const account=await connectMarkest(store,vault,input(),{fetch:remote});
    for(const automation of ['manual','api','browser'] as const){for(const status of ['unknown','registered'] as const){const state=store.read();state.accounts[0].status=status;assert.equal(channelExecutionReadiness(state,one,{...channel,enabled:true,automation}).kind,'handoff_required')}}
    let encrypted=false;assert.throws(()=>saveAccountAtomic(store,{channelId:'markest',email:'author@example.com',username:'author',password:'not-a-key'},channel,()=>{encrypted=true;return {}}),/专用连接/);assert.equal(encrypted,false);
    const forged={...account,status:'registered'} as Account;assert.equal(validMarkestReadAccount(forged),false);
  }finally{store.close()}
});
