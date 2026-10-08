import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {connectLeaflet} from '../src/main/leaflet-management';
import type {LeafletManagementDependencies} from '../src/main/leaflet-management';
import type {SecretStore,Site,Task} from '../src/shared/types';

const one='11111111-1111-4111-8111-111111111111',two='22222222-2222-4222-8222-222222222222';
const did='did:plc:abcdefghijklmnopqrstuvwx',otherDid='did:plc:zyxwvutsrqponmlkjihgfedcb';
const at='2026-10-08T00:00:00.000Z';
function fixture(){
  const store=new Store(':memory:'),secrets=new Map<string,string>();
  const vault:SecretStore={get:async key=>secrets.get(key),set:async(key,value)=>{secrets.set(key,value)},delete:async key=>{secrets.delete(key)}};
  store.update(s=>{s.settings.autoRun=false;s.sites=[one,two].map((id,index):Site=>({id,url:`https://site${index}.example.com/`,domain:`site${index}.example.com`,name:'Fixture',email:'owner@example.com',description:'Original article',category:'content',language:'en',monthlyTarget:2,status:'ready',createdAt:at}))});
  let identity=did,sequence=0;
  const deps:LeafletManagementDependencies={connect:async(vault,id,handle)=>{sequence++;await vault.set(`account:${id}`,JSON.stringify({testSecret:sequence,did:identity}));return {username:handle.replace(/^@/,''),did:identity,publicationUrl:`https://leaflet.pub/p/${identity}`};}};
  const connect=(siteIds=[one],accountId?:string)=>connectLeaflet(store,vault,{handle:'author.bsky.social',appPassword:'aaaa-bbbb-cccc-dddd',siteIds,accountId},deps);
  return {store,secrets,vault,deps,connect,setDid:(value:string)=>{identity=value},calls:()=>sequence};
}
test('Leaflet connection saves only one independent account secret and explicit bindings',async()=>{
  const f=fixture();try{
    const account=await f.connect();assert.equal(account.channelId,'leaflet');assert.equal(account.credentialKind,'api_token');assert.equal(account.publicationUrl,`https://leaflet.pub/p/${did}`);assert.equal(f.secrets.size,1);assert.ok(f.secrets.has(`account:${account.id}`));assert.equal(f.store.read().accountBindings[0].siteId,one);assert.equal(JSON.stringify(account).includes('testSecret'),false);
    const same=await f.connect([two]);assert.equal(same.id,account.id);assert.equal(f.secrets.size,1);assert.equal(f.store.read().accountBindings.length,2);
    await f.connect([two],account.id);assert.deepEqual(f.store.read().accountBindings.map(item=>item.siteId),[two]);
  }finally{f.store.close()}
});
test('Leaflet missing selection or foreign repair account fails before credential verification',async()=>{
  const f=fixture();try{
    await assert.rejects(f.connect(['missing']),/不存在/);await assert.rejects(f.connect([],two),/不存在/);assert.equal(f.calls(),0);assert.equal(f.secrets.size,0);
  }finally{f.store.close()}
});
test('Leaflet reconnect cannot switch DID or expose temporary credentials',async()=>{
  const f=fixture();try{
    const account=await f.connect(),before=f.store.read(),saved=f.secrets.get(`account:${account.id}`);f.setDid(otherDid);
    await assert.rejects(f.connect([two],account.id),/另一个发布身份/);assert.deepEqual(f.store.read(),before);assert.equal(f.secrets.size,1);assert.equal(f.secrets.get(`account:${account.id}`),saved);
  }finally{f.store.close()}
});
test('Leaflet failed binding update rolls back the new credential and preserves pending intent',async()=>{
  const f=fixture();try{
    const account=await f.connect();f.store.update(s=>{s.tasks.push({id:'33333333-3333-4333-8333-333333333333',siteId:one,channelId:'leaflet',accountId:account.id,sourceDomain:'leaflet.pub',status:'review',createdAt:at,scheduledAt:at,updatedAt:at,attempts:1,message:'Pending',submittedAt:at,checkpoint:'leaflet_create_submitting',leaflet:{did,rkey:'3lzzzzzzzzzzz',recordHash:'a'.repeat(64),recordCreatedAt:at,stage:'creating'}} as Task)});
    const before=f.store.read(),saved=f.secrets.get(`account:${account.id}`);
    await assert.rejects(f.connect([two],account.id));assert.deepEqual(f.store.read(),before);assert.equal(f.secrets.size,1);assert.equal(f.secrets.get(`account:${account.id}`),saved);
  }finally{f.store.close()}
});
test('Leaflet connection discards verified credentials if a selected website disappears',async()=>{
  const f=fixture();try{
    const original=f.deps.connect!;f.deps.connect=async(...args)=>{const result=await original(...args);f.store.update(s=>{s.sites=[]});return result};
    await assert.rejects(f.connect(),/不存在/);assert.equal(f.secrets.size,0);assert.equal(f.store.read().accounts.length,0);
  }finally{f.store.close()}
});
test('Leaflet hostile connection errors never reach IPC and temporary secrets are cleaned',async()=>{
  const f=fixture();try{
    f.deps.connect=async(vault,id)=>{await vault.set(`account:${id}`,'temporary-sensitive');throw Error('appPassword=never-echo-me')};
    await assert.rejects(f.connect(),error=>error instanceof Error&&!error.message.includes('never-echo-me')&&error.message.includes('连接未完成'));assert.equal(f.secrets.size,0);assert.equal(f.store.read().accounts.length,0);
  }finally{f.store.close()}
});
test('Leaflet public identity must be the verified DID under the fixed hosting origin',async()=>{
  for(const url of ['https://evil.example.com/p/'+did,'https://leaflet.pub/p/'+otherDid,'https://leaflet.pub/p/'+did+'?x=1']){
    const f=fixture();try{f.deps.connect=async(vault,id)=>{await vault.set(`account:${id}`,'temporary');return {username:'author.bsky.social',did,publicationUrl:url}};await assert.rejects(f.connect());assert.equal(f.secrets.size,0);assert.equal(f.store.read().accounts.length,0);}finally{f.store.close()}
  }
});
