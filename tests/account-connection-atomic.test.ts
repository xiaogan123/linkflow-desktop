import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {connectBluesky} from '../src/main/bluesky-management';
import {connectParagraph} from '../src/main/paragraph-management';
import {CHANNELS} from '../src/integrations/catalog';
import type {SecretStore,Site} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const stamp=new Date().toISOString(),one='11111111-1111-4111-8111-111111111111',two='22222222-2222-4222-8222-222222222222';
const did='did:plc:abcdefghijklmnopqrstuvwx',password='abcd-efgh-ijkl-mnop';
const publication={id:'PublicationFixture0001',name:'Fixture Publication',ownerUserId:'OwnerFixture00000001',slug:'fixture-publication'};
function fixture(){
  const store=new Store(':memory:'),secrets=new Map<string,string>();
  const vault:SecretStore={get:async key=>secrets.get(key),set:async(key,value)=>{secrets.set(key,value)},delete:async key=>{secrets.delete(key)}};
  store.update(state=>{state.settings.autoRun=false;state.sites=[one,two].map((id,index):Site=>({id,url:`https://site${index}.example.com/`,domain:`site${index}.example.com`,name:'Fixture',email:'owner@example.com',description:'Original educational publication',category:'content',language:'en',monthlyTarget:2,status:'ready',createdAt:stamp}))});
  const remote=async()=>new Response(JSON.stringify({did,handle:'fixture.bsky.social',accessJwt:'synthetic.access.token',refreshJwt:'synthetic.refresh.token',active:true}),{status:200,headers:{'content-type':'application/json'}});
  const paragraph=async()=>new Response(JSON.stringify(publication),{status:200,headers:{'content-type':'application/json'}});
  return {store,secrets,vault,remote,paragraph};
}

test('Bluesky identity and explicit bindings are committed before automatic work can resume',async()=>{
  const {store,vault,remote}=fixture();let release!:()=>void,observedBindings=-1;
  const gate=new Promise<void>(resolve=>release=resolve);
  store.update(state=>{state.settings.autoRun=true;state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(channel=>[channel.id,false]))});
  const controller=new Controller(store,Object.assign(vault,{ready:true,available:()=>true}) as Vault,'fixture',{discoverTopics:async()=>{observedBindings=store.read().accountBindings.length;await gate;return {topics:[],checkedAt:stamp}}});
  try{
    const account=await controller.manageIdentity(()=>connectBluesky(store,vault,'fixture.bsky.social',password,{fetch:remote},undefined,{siteIds:[one,two]}));
    assert.equal(observedBindings,2);assert.equal(controller.hasPendingWork(),true);
    assert.equal(store.read().accounts[0].id,account.id);assert.deepEqual(store.read().accountBindings.map(binding=>binding.siteId),[one,two]);
  }finally{controller.pause();release();await new Promise(resolve=>setImmediate(resolve));store.close()}
});

test('invalid selected site fails before authentication and leaves account and vault untouched',async()=>{
  const {store,vault,secrets,remote}=fixture();let calls=0;
  try{
    await assert.rejects(connectBluesky(store,vault,'fixture.bsky.social',password,{fetch:async()=>{calls++;return remote()}},undefined,{siteIds:['missing']}),/网站/);
    assert.equal(calls,0);assert.equal(secrets.size,0);assert.equal(store.read().accounts.length,0);
  }finally{store.close()}
});

test('failed Bluesky binding restores the original credential and all prior bindings',async()=>{
  const {store,vault,secrets,remote}=fixture();
  try{
    const account=await connectBluesky(store,vault,'fixture.bsky.social',password,{fetch:remote},undefined,{siteIds:[one]});
    store.update(state=>state.tasks.push({id:'33333333-3333-4333-8333-333333333333',siteId:two,channelId:'bluesky',accountId:'44444444-4444-4444-8444-444444444444',sourceDomain:'bsky.app',status:'needs_input',submittedAt:stamp,checkpoint:'bluesky_create_submitting',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'uncertain'}));
    const before=store.read(),previous=secrets.get('account:'+account.id);
    await assert.rejects(connectBluesky(store,vault,'fixture.bsky.social','qrst-uvwx-yz12-3456',{fetch:remote},account.id,{siteIds:[one,two]}));
    assert.deepEqual(store.read(),before);assert.equal(secrets.get('account:'+account.id),previous);
  }finally{store.close()}
});

test('site removed during authentication cannot leave a new account or orphan credential',async()=>{
  const {store,vault,secrets,remote}=fixture();
  try{
    await assert.rejects(connectBluesky(store,vault,'fixture.bsky.social',password,{fetch:async()=>{store.update(state=>state.sites=state.sites.filter(site=>site.id!==one));return remote()}},undefined,{siteIds:[one]}));
    assert.equal(secrets.size,0);assert.equal(store.read().accounts.length,0);assert.equal(store.read().accountBindings.length,0);
  }finally{store.close()}
});

test('a new Bluesky connection adds selected sites to an existing DID; explicit editing replaces selections',async()=>{
  const {store,vault,remote}=fixture();
  try{
    const first=await connectBluesky(store,vault,'fixture.bsky.social',password,{fetch:remote},undefined,{siteIds:[one]});
    const second=await connectBluesky(store,vault,'fixture.bsky.social',password,{fetch:remote},undefined,{siteIds:[two]});
    assert.equal(first.id,second.id);assert.deepEqual(store.read().accountBindings.map(binding=>binding.siteId),[one,two]);
    await connectBluesky(store,vault,'fixture.bsky.social',password,{fetch:remote},first.id,{siteIds:[two]});
    assert.deepEqual(store.read().accountBindings.map(binding=>binding.siteId),[two]);
  }finally{store.close()}
});

test('a new Paragraph connection adds selected sites to an existing publication; explicit editing replaces selections',async()=>{
  const {store,vault,paragraph}=fixture();
  try{
    const first=await connectParagraph(store,vault,'synthetic-paragraph-key',[one],undefined,{fetch:paragraph});
    const second=await connectParagraph(store,vault,'synthetic-paragraph-key',[two],undefined,{fetch:paragraph});
    assert.equal(first.id,second.id);assert.deepEqual(store.read().accountBindings.map(binding=>binding.siteId),[one,two]);
    assert.equal(store.read().sites[0].paragraph?.publicationId,publication.id);
    await connectParagraph(store,vault,'synthetic-paragraph-key',[two],first.id,{fetch:paragraph});
    assert.deepEqual(store.read().accountBindings.map(binding=>binding.siteId),[two]);
  }finally{store.close()}
});
