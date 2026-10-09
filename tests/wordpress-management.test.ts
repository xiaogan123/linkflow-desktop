import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {WordPressConnections} from '../src/main/wordpress-management';
import type {WordPressOAuthOptions} from '../src/main/wordpress-oauth';
import type {Site} from '../src/shared/types';
const one='11111111-1111-4111-8111-111111111111',two='22222222-2222-4222-8222-222222222222';
const stamp=new Date().toISOString(),token='synthetic-wordpress-token',blog={ID:123,URL:'https://fixture-notes.wordpress.com/',name:'Fixture',jetpack:false,is_private:false,is_coming_soon:false,launch_status:'launched',capabilities:{publish_posts:true,edit_posts:true},user_can_manage:true};
function fixture(){
  const store=new Store(':memory:');const vault={get:async(key:string)=>store.getCipher(key),encryptSecrets:(values:Record<string,string>)=>values};
  store.update(s=>{s.settings.autoRun=false;s.sites=[one,two].map((id,index):Site=>({id,url:`https://site${index}.example.com/`,domain:`site${index}.example.com`,name:'Fixture',email:'owner@example.com',description:'Original notes',category:'content',language:'en',monthlyTarget:2,status:'ready',createdAt:stamp}))});
  let requests=0,ownerId=789;const deps={fetch:async(url:string,init:RequestInit)=>{requests++;assert.ok(!init.method||init.method==='GET');const path=new URL(url).pathname;return new Response(JSON.stringify(path.endsWith('/me')?{ID:ownerId}:path.endsWith('/me/sites')?{sites:[blog]}:blog),{headers:{'Content-Type':'application/json'}})}};
  const grant={accessToken:token,expiresAt:new Date(Date.now()+3600_000).toISOString(),blogId:'123'};
  const manager=new WordPressConnections(store,vault,deps,async()=>grant);
  const authorize=()=>manager.authorize({openExternal:async()=>{}});
  const close=()=>{manager.cancel();store.close()};
  return {store,vault,manager,authorize,close,grant,deps,secret:(key:string)=>store.getCipher(key),ciphers:()=>store.allCiphers(),setOwner:(value:number)=>{ownerId=value},requests:()=>requests};
}
test('WordPress authorizes without renderer credentials, then atomically saves a blog and site bindings',async()=>{
  const f=fixture();try{const session=await f.authorize();assert.equal(JSON.stringify(session).includes(token),false);assert.equal(Object.keys(f.ciphers()).length,0);assert.equal(f.manager.status().configured,false);assert.ok(Date.parse(session.expiresAt)<=Date.now()+300_000);assert.ok(Date.parse(session.expiresAt)<Date.parse(f.grant.expiresAt));
    const account=await f.manager.connect({sessionId:session.sessionId,blogId:'123',siteIds:[one]});assert.equal(account.credentialKind,'oauth');assert.equal(account.publicationUrl,blog.URL);assert.equal(f.store.read().accountBindings[0].siteId,one);assert.equal(JSON.parse(f.secret('account:'+account.id)!).accessToken,token);assert.equal(JSON.parse(f.secret('account:'+account.id)!).expiresAt,f.grant.expiresAt);
    await assert.rejects(f.manager.connect({sessionId:session.sessionId,blogId:'123',siteIds:[two]}),/过期/);
    const second=await f.authorize();const same=await f.manager.connect({sessionId:second.sessionId,blogId:'123',siteIds:[two]});assert.equal(same.id,account.id);assert.equal(f.store.read().accountBindings.length,2);
    const third=await f.authorize();await f.manager.connect({sessionId:third.sessionId,blogId:'123',siteIds:[two],accountId:account.id});assert.deepEqual(f.store.read().accountBindings.map(x=>x.siteId),[two]);
  }finally{f.close()}
});
test('WordPress unknown blog or removed site fails before storing credentials',async()=>{
  for(const wrong of ['blog','site']){const f=fixture();try{const session=await f.authorize(),before=f.requests();await assert.rejects(f.manager.connect({sessionId:session.sessionId,blogId:wrong==='blog'?'456':'123',siteIds:wrong==='site'?['missing']:[one]}));assert.equal(f.requests(),before);assert.equal(Object.keys(f.ciphers()).length,0);assert.equal(f.store.read().accounts.length,0);}finally{f.close()}}
});
test('WordPress changed authenticated owner rolls back credentials and stored identities',async()=>{
  const f=fixture();try{let session=await f.authorize();const account=await f.manager.connect({sessionId:session.sessionId,blogId:'123',siteIds:[one]}),before=f.store.read(),secret=f.secret('account:'+account.id);session=await f.authorize();f.setOwner(999);await assert.rejects(f.manager.connect({sessionId:session.sessionId,blogId:'123',siteIds:[two]}),/身份发生变化/);assert.deepEqual(f.store.read(),before);assert.equal(f.secret('account:'+account.id),secret);}finally{f.close()}
});
test('WordPress reconnect cannot silently switch the author on a shared blog',async()=>{
  const f=fixture();try{const first=await f.authorize();await f.manager.connect({sessionId:first.sessionId,blogId:'123',siteIds:[one]});const before=f.store.read(),secrets=f.ciphers();f.setOwner(999);const other=await f.authorize();await assert.rejects(f.manager.connect({sessionId:other.sessionId,blogId:'123',siteIds:[two]}),/原发布者/);assert.deepEqual(f.store.read(),before);assert.deepEqual(f.ciphers(),secrets);}finally{f.close()}
});
test('WordPress cancel invalidates an uncommitted grant and in-flight credential save',async()=>{
  const f=fixture();try{const session=await f.authorize();f.manager.cancel();await assert.rejects(f.manager.connect({sessionId:session.sessionId,blogId:'123',siteIds:[one]}),/过期/);
    const next=await f.authorize(),original=f.deps.fetch;let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve});
    f.deps.fetch=async(url,init)=>{if(new URL(url).pathname.endsWith('/me')){entered();await gate}return original(url,init)};
    const connecting=f.manager.connect({sessionId:next.sessionId,blogId:'123',siteIds:[one]});await reached;f.manager.cancel();release();await assert.rejects(connecting,/取消/);assert.equal(Object.keys(f.ciphers()).length,0);assert.equal(f.store.read().accounts.length,0);
  }finally{f.close()}
});
test('WordPress reconnect cannot drop an unresolved publication binding and rolls back credential changes',async()=>{
  const f=fixture();try{
    const first=await f.authorize(),account=await f.manager.connect({sessionId:first.sessionId,blogId:'123',siteIds:[one]});
    f.store.update(state=>state.tasks.push({id:'33333333-3333-4333-8333-333333333333',siteId:one,channelId:'wordpress-com',sourceDomain:'wordpress.com',accountId:account.id,status:'needs_input',createdAt:stamp,updatedAt:stamp,attempts:1,scheduledAt:stamp,submittedAt:stamp,message:'Pending',checkpoint:'wordpress_publish_submitting',wordpress:{blogId:'123',authorId:'789',slug:'lf-synthetic-aaaaaaaaaaaa',contentHash:'a'.repeat(64),stage:'submitting'}}));
    const before=f.store.read(),secrets=f.ciphers(),next=await f.authorize();
    await assert.rejects(f.manager.connect({sessionId:next.sessionId,blogId:'123',siteIds:[two],accountId:account.id}),/待核验/);
    assert.deepEqual(f.store.read(),before);assert.deepEqual(f.ciphers(),secrets);
  }finally{f.close()}
});
test('WordPress pending or expired authorization cannot be reused',async()=>{
  const f=fixture();try{f.grant.expiresAt=new Date(Date.now()-1000).toISOString();await assert.rejects(f.authorize(),/过期/);assert.equal(Object.keys(f.ciphers()).length,0);}finally{f.close()}
});
test('WordPress cancel during OAuth suppresses the late returned grant',async()=>{
  const f=fixture();let options:WordPressOAuthOptions|undefined,resolve!:(grant:typeof f.grant)=>void;
  const manager=new WordPressConnections(f.store,f.vault,f.deps,async o=>{options=o;return await new Promise(r=>{resolve=r})});
  try{const promise=manager.authorize({openExternal:async()=>{}});manager.cancel();assert.equal(options?.signal?.aborted,true);resolve(f.grant);await assert.rejects(promise,/取消/);assert.equal(Object.keys(f.ciphers()).length,0);}finally{manager.cancel();f.close()}
});
test('WordPress SQLite cipher failure rolls back the account and binding transaction',async()=>{
  const f=fixture();try{
    const session=await f.authorize(),before=f.store.read(),setCipher=f.store.setCipher.bind(f.store);f.store.setCipher=()=>{throw Error('synthetic cipher failure')};
    await assert.rejects(f.manager.connect({sessionId:session.sessionId,blogId:'123',siteIds:[one]}),/synthetic cipher failure/);f.store.setCipher=setCipher;
    assert.deepEqual(f.store.read(),before);assert.equal(Object.keys(f.ciphers()).length,0);
  }finally{f.close()}
});
