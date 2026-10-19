import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {connectHackMd,HackMdManagementError} from '../src/main/hackmd-management';
import {batch5NoIndex,batch5PublicChannel} from '../src/main/batch5-renderer';
import type {Site,Task} from '../src/shared/types';

const SITE1='11111111-1111-4111-8111-111111111111',SITE2='22222222-2222-4222-8222-222222222222';
const NOW='2026-10-18T12:00:00.000Z',TOKEN='hackmd-token-example-123456789';
const me=(id='remote-user-123456789')=>new Response(JSON.stringify({id,name:'Example Author',userPath:'example-author',email:null,photo:'',teams:[],upgraded:false}),
  {status:200,headers:{'content-type':'application/json'}});

function fixture(){
  const store=new Store(':memory:');
  store.update(state=>{state.settings.autoRun=false;state.sites=[SITE1,SITE2].map((id,index):Site=>({id,domain:`site${index}.example.com`,url:`https://site${index}.example.com/`,
    email:'',name:'Example Site',description:'Educational material',category:'finance',language:'zh-CN',monthlyTarget:2,status:'ready',createdAt:NOW}))});
  const vault={encryptSecrets:(clear:Record<string,string>)=>Object.fromEntries(Object.entries(clear).map(([key,value])=>[key,`encrypted:${value}`]))};
  const requests:Array<{url:string;method:string;authorization:string}>=[];
  let identity='remote-user-123456789';
  const fetch=async(url:string,init:RequestInit)=>{requests.push({url,method:String(init.method),authorization:String((init.headers as Record<string,string>).authorization)});return me(identity)};
  const connect=(siteIds=[SITE1],accountId?:string)=>connectHackMd(store,vault,{token:TOKEN,siteIds,accountId},{fetch,now:()=>new Date(NOW)});
  return {store,connect,requests,setIdentity:(id:string)=>{identity=id}};
}

test('HackMD connection verifies identity by GET and atomically stores one encrypted token and site binding',async()=>{
  const f=fixture();try{
    const account=await f.connect();assert.equal(account.channelId,'hackmd');assert.equal(account.username,'remote-user-123456789');
    assert.deepEqual(f.requests,[{url:'https://api.hackmd.io/v1/me',method:'GET',authorization:`Bearer ${TOKEN}`}]);
    assert.equal(f.store.getCipher(`account:${account.id}`),`encrypted:${TOKEN}`);
    assert.deepEqual(f.store.read().accountBindings.map(binding=>binding.siteId),[SITE1]);
    assert.equal(JSON.stringify(account).includes(TOKEN),false);
  }finally{f.store.close()}
});

test('HackMD connection rejects two sites and refuses token rotation to a different user',async()=>{
  const f=fixture();try{
    await assert.rejects(f.connect([SITE1,SITE2]),error=>error instanceof HackMdManagementError&&error.code==='site_missing');
    assert.equal(f.requests.length,0);
    const account=await f.connect(),before=f.store.read(),cipher=f.store.getCipher(`account:${account.id}`);
    f.setIdentity('another-user-123456789');
    await assert.rejects(f.connect([SITE1],account.id),error=>error instanceof HackMdManagementError&&error.code==='identity_mismatch');
    assert.deepEqual(f.store.read(),before);assert.equal(f.store.getCipher(`account:${account.id}`),cipher);
  }finally{f.store.close()}
});

test('HackMD connection cannot rebind a site after a pending publish intent',async()=>{
  const f=fixture();try{
    const account=await f.connect();
    f.store.update(state=>{state.tasks.push({id:'33333333-3333-4333-8333-333333333333',siteId:SITE1,channelId:'hackmd',accountId:account.id,
      sourceDomain:'hackmd.io',status:'review',createdAt:NOW,scheduledAt:NOW,updatedAt:NOW,attempts:1,message:'Pending',submittedAt:NOW} as Task)});
    const before=f.store.read();await assert.rejects(f.connect([SITE2],account.id),error=>error instanceof HackMdManagementError&&error.code==='identity_mismatch');
    assert.deepEqual(f.store.read(),before);
  }finally{f.store.close()}
});

test('Batch5 native renderer accepts only exact WhiteWind and HackMD public page URLs',()=>{
  assert.equal(batch5PublicChannel('https://hackmd.io/public-note-123456789'),'hackmd');
  assert.equal(batch5PublicChannel('https://whtwnd.com/writer.bsky.social/3mc52c5hfyj2z'),'whitewind');
  for(const url of ['http://hackmd.io/public-note-123456789','https://hackmd.io/public-note-123456789?x=1',
    'https://evil.example.com/public-note-123456789','https://whtwnd.com/writer.bsky.social/3mc52c5hfyj2z/edit']){
    assert.equal(batch5PublicChannel(url),undefined);
  }
});

test('Batch5 renderer interprets scoped X-Robots-Tag and meta noindex directives',()=>{
  assert.equal(batch5NoIndex('googlebot:noindex'),true);
  assert.equal(batch5NoIndex('none'),true);
  assert.equal(batch5NoIndex('index, follow'),false);
});
