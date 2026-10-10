import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {connectDeno} from '../src/main/deno-management';
import {readDenoApps,checkDenoSelectedApp,validDenoReadAccount,validStoredDenoToken} from '../src/integrations/deno-connection';
import {validateBackup} from '../src/main/backup-validation';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {CHANNELS} from '../src/integrations/catalog';
import type {Site} from '../src/shared/types';

const appId='11111111-1111-4111-8111-111111111111',otherId='22222222-2222-4222-8222-222222222222';
const siteId='33333333-3333-4333-8333-333333333333';
const token='deno_test_owner_token_1234567890';
const app={id:appId,slug:'owner-publication'};
const stamp='2026-10-10T00:00:00.000Z';
const input=()=>({token,appId,declaredOrgSlug:'owner-org',label:'Dedicated publication',siteIds:[siteId],dedicatedAppAcknowledged:true as const});
const json=(body:unknown,headers:Record<string,string>={})=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json',...headers}});
function remote(calls:string[]=[]){return async(url:string,init:RequestInit)=>{
  calls.push(url);assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');assert.deepEqual(init.headers,{Authorization:'Bearer '+token,Accept:'application/json'});assert.equal(init.body,undefined);
  if(url==='https://api.deno.com/v2/apps?limit=100')return json([app]);
  if(url==='https://api.deno.com/v2/apps/'+appId)return json({...app,layers:[],created_at:stamp,updated_at:stamp,env_vars:[{key:'PRIVATE',value:'do-not-retain'}]});
  if(url==='https://api.deno.com/v2/apps/'+appId+'/revisions?limit=30')return json([{id:'rev-1',status:'succeeded',labels:{private:'do-not-retain'}}]);
  if(url==='https://api.deno.com/v2/revisions/rev-1')return json({id:'rev-1',status:'succeeded',timelines:[{name:'Production',context:'production',hostnames:['private.example']}]});
  throw Error('unexpected URL');
}}
function fixture(){const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=false;state.sites=[{id:siteId,url:'https://site.example/',domain:'site.example',name:'Fixture',email:'owner@example.com',description:'Fixture',category:'content',language:'en',monthlyTarget:2,status:'ready',createdAt:stamp} satisfies Site]});const vault={encryptSecrets:(x:Record<string,string>)=>Object.fromEntries(Object.entries(x).map(([k,v])=>[k,'encrypted:'+v]))};return {store,vault}}

test('Deno reads only fixed host GETs, exact UUID detail and revisions, and persists no list or private detail',async()=>{
  const {store,vault}=fixture(),calls:string[]=[];
  try{
    const saved=await connectDeno(store,vault,input(),{fetch:remote(calls)});
    assert.deepEqual(calls,['https://api.deno.com/v2/apps?limit=100','https://api.deno.com/v2/apps/'+appId,'https://api.deno.com/v2/apps/'+appId+'/revisions?limit=30','https://api.deno.com/v2/revisions/rev-1']);
    assert(validDenoReadAccount(saved));assert.equal(saved.status,'unknown');assert.equal(saved.denoReadAccess?.identity,'app_verified_org_declared');
    assert.equal(store.read().accountBindings[0].accountId,saved.id);
    assert.equal(validStoredDenoToken(tokenFromStore(store,saved.id),saved),true);
    const serialized=JSON.stringify(store.read());for(const value of [token,'PRIVATE','do-not-retain','rev-1','private.example',otherId])assert(!serialized.includes(value));
    assert.equal(CHANNELS.find(x=>x.id==='deno')?.enabled,false);
    assert.equal(channelExecutionReadiness(store.read(),siteId,{...CHANNELS.find(x=>x.id==='deno')!,enabled:true,automation:'api'}).kind,'handoff_required');
    const backup={state:store.read(),secrets:{['account:'+saved.id]:tokenFromStore(store,saved.id)}};
    assert.deepEqual(validateBackup(backup),backup);
  }finally{store.close()}
});
function tokenFromStore(store:Store,id:string){return store.allCiphers()['account:'+id]?.slice('encrypted:'.length)}

test('Deno list follows bounded same-host cursor link and refuses alternate host or redirect',async()=>{
  let calls=0;
  const apps=await readDenoApps(token,{fetch:async(url)=>{calls++;if(calls===1){assert.equal(url,'https://api.deno.com/v2/apps?limit=100');return json([app],{Link:'</v2/apps?cursor=next&limit=100>; rel="next"'})}assert.equal(url,'https://api.deno.com/v2/apps?cursor=next&limit=100');return json([{id:otherId,slug:'another-app'}])}});
  assert.deepEqual(apps,[app,{id:otherId,slug:'another-app'}]);
  for(const link of ['<https://other.example/v2/apps?cursor=x>; rel="next"','</v2/apps/other?cursor=x>; rel="next"','</v2/apps?cursor=x&redirect=1>; rel="next"'])await assert.rejects(readDenoApps(token,{fetch:async()=>json([app],{Link:link})}),/分页链接/);
  await assert.rejects(readDenoApps(token,{fetch:async()=>new Response('{}',{status:302,headers:{Location:'https://other.example/'}})}));
});

test('Deno bounds response body and timeout without exposing token or contacting an alternate host',async()=>{
  await assert.rejects(readDenoApps(token,{fetch:async()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'1048577'}})}),/限制/);
  await assert.rejects(readDenoApps(token,{fetch:async()=>json('x'.repeat(1048577))}),/限制/);
  let signal:AbortSignal|undefined;
  await assert.rejects(readDenoApps(token,{timeoutMs:5,fetch:async(_url,init)=>{signal=init.signal as AbortSignal;return new Promise(()=>{})}}),/超时/);
  assert.equal(signal?.aborted,true);
  await assert.rejects(readDenoApps(token,{fetch:async()=>{throw Error('network '+token)}}),error=>error instanceof Error&&!error.message.includes(token));
  await assert.rejects(checkDenoSelectedApp(token,appId,{fetch:async(url)=>url.endsWith('/revisions/rev-1')?json({id:'other'}):url.includes('/revisions?')?json([{id:'rev-1'}]):url.endsWith(appId)?json(app):json([app])}),/详情与列表身份不一致/);
});

test('Deno rejects missing app, detail mismatch, revision malformed, auth errors and cancellation without saving',async()=>{
  const {store,vault}=fixture();
  try{
    for(const fetcher of [
      async()=>json([]),
      async(url:string)=>url.includes('/revisions')?json({items:[]}):url.endsWith(appId)?json({...app,id:otherId}):json([app]),
      async(url:string)=>url.includes('/revisions')?json({items:[]}):url.endsWith(appId)?json(app):json([app]),
      async()=>new Response('{}',{status:401,headers:{'content-type':'application/json'}})
    ])await assert.rejects(connectDeno(store,vault,input(),{fetch:fetcher}));
    const abort=new AbortController();abort.abort();await assert.rejects(connectDeno(store,vault,input(),{fetch:remote(),signal:abort.signal}),/取消/);
    assert.equal(store.read().accounts.length,0);assert.deepEqual(store.allCiphers(),{});
  }finally{store.close()}
});

test('Deno reconnect preserves app account; another UUID or declared organization cannot overwrite it',async()=>{
  const {store,vault}=fixture();
  try{
    const first=await connectDeno(store,vault,input(),{fetch:remote()});
    const again=await connectDeno(store,vault,{...input(),accountId:first.id,label:'Renamed locally'},{fetch:remote()});
    assert.equal(first.id,again.id);assert.equal(store.read().accounts.length,1);
    await assert.rejects(connectDeno(store,vault,{...input(),accountId:first.id,appId:otherId},{fetch:remote()}),/不同应用 UUID/);
    const corrected=await connectDeno(store,vault,{...input(),accountId:first.id,declaredOrgSlug:'other-org'},{fetch:remote()});
    assert.equal(corrected.id,first.id);assert.equal(corrected.denoReadAccess?.declaredOrgSlug,'other-org');
    await assert.rejects(connectDeno(store,vault,{...input(),dedicatedAppAcknowledged:false as never},{fetch:remote()}),/格式/);
    assert.equal(store.read().accounts.length,1);
  }finally{store.close()}
});

test('Deno declared organization note accepts 32, 33 and 64 characters with zero sites through backup and same-app reconnect',async()=>{
  for(const length of [32,33,64]){
    const {store,vault}=fixture();
    try{
      const declaredOrgSlug='a'.repeat(length),entry={...input(),declaredOrgSlug,siteIds:[]};
      const first=await connectDeno(store,vault,entry,{fetch:remote()});
      assert(validDenoReadAccount(first),`normal ${length}-character note must be persistable`);
      assert.equal(store.read().accountBindings.length,0);
      const backup={state:store.read(),secrets:{['account:'+first.id]:tokenFromStore(store,first.id)}};
      assert.deepEqual(validateBackup(backup),backup);
      const again=await connectDeno(store,vault,{...entry,accountId:first.id},{fetch:remote()});
      assert.equal(again.id,first.id);
      assert.equal(again.denoReadAccess?.declaredOrgSlug,declaredOrgSlug);
    }finally{store.close()}
  }
});

test('Deno backup rejects forged ready status, changed UUID, extra proof fields and token mismatch',async()=>{
  const {store,vault}=fixture();
  try{
    const saved=await connectDeno(store,vault,input(),{fetch:remote()});
    const backup={state:store.read(),secrets:{['account:'+saved.id]:tokenFromStore(store,saved.id)}};
    for(const mutate of [
      (x:typeof backup)=>{x.state.accounts[0].status='registered'},
      (x:typeof backup)=>{x.state.accounts[0].denoReadAccess!.appId=otherId},
      (x:typeof backup)=>{Object.assign(x.state.accounts[0].denoReadAccess!,{canPublish:true})},
      (x:typeof backup)=>{x.secrets['account:'+saved.id]=JSON.stringify({version:1,token:'different_token_1234567890'})}
    ]){const copy=structuredClone(backup);mutate(copy);assert.throws(()=>validateBackup(copy))}
  }finally{store.close()}
});
