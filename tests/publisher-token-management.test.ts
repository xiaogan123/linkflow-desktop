import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {emptyState,Store} from '../src/main/store';
import type {Account,Channel,SiteAccountBinding} from '../src/shared/types';
import {encryptBackup,decryptBackup} from '../src/main/backup';
import {validateBackup} from '../src/main/backup-validation';
import {connectPublisherToken} from '../src/main/publisher-token-management';
import {setSelectedAccountSites,unbindAccount} from '../src/main/account-bindings';
import {createBatch5Persistence} from '../src/main/batch5-publication';
import {CHANNELS} from '../src/integrations/catalog';
import {publisherFor} from '../src/integrations/publishers';
import {batch5PublicChannel,inspectBatch5RenderedBody} from '../src/main/batch5-renderer';
const SITE='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const TOKEN='synthetic-mastodon-token-12345678';
function fixture(){
 const store=new Store(':memory:');store.update(s=>{s.settings.autoRun=false;s.sites=[SITE,OTHER].map((id,i)=>({id,domain:`sample${i}.example.com`,url:`https://sample${i}.example.com/`,email:'',name:'Example software',description:'Original documentation',category:'software' as const,language:'en',monthlyTarget:2,status:'ready' as const,createdAt:'2026-10-28T00:00:00.000Z'}));});
 const vault={encryptSecrets:(v:Record<string,string>)=>Object.fromEntries(Object.entries(v).map(([k,v])=>[k,`cipher:${v}`]))};
 const fetch=async()=>new Response(JSON.stringify({id:'123',acct:'example_author',url:'https://mastodon.social/@example_author',bot:true,indexable:true}),{headers:{'content-type':'application/json'}});
 return {store,vault,fetch};
}
test('connected publishing routes remain disabled until live acceptance; Mastodon uses short-content generation',()=>{
 for(const id of ['mastodon','netlify','cloudflare-pages']){const c=CHANNELS.find(c=>c.id===id)!;assert.equal(c.enabled,false);assert.equal(c.accessClass,'connect_once');assert.ok(publisherFor(c));}
 assert.equal(CHANNELS.find(c=>c.id==='mastodon')!.contentFormat,'social');
 assert.equal(batch5PublicChannel('https://mastodon.social/@example_author/123'),'mastodon');
 assert.equal(batch5PublicChannel('https://evil.example.com/@example_author/123'),undefined);
});
test('Cloudflare connects only a verified empty Direct Upload project to one website without POST',async()=>{
 const f=fixture(),providerAccountId='a'.repeat(32),projectId='12345678-1234-1234-1234-123456789abc',tokenId='b'.repeat(32),projectName='software-guide-pages';
 const methods:string[]=[];let occupied=false;
 const fetch=async(url:string,init:RequestInit)=>{
  methods.push(init.method??'GET');
  const result=url.endsWith('/user/tokens/verify')?{id:tokenId,status:'active'}
   :url.endsWith('/deployments?per_page=1&page=1')?occupied?[{id:'87654321-4321-4321-4321-cba987654321'}]:[]
   :{id:projectId,name:url.includes('/another-project')?'another-project':projectName,subdomain:`${url.includes('/another-project')?'another-project':projectName}.pages.dev`,production_branch:'main',source:null,
     canonical_deployment:occupied?{id:'87654321-4321-4321-4321-cba987654321'}:null,latest_deployment:null};
  return new Response(JSON.stringify({success:true,result}),{headers:{'content-type':'application/json'}});
 };
 try{
  const input={channelId:'cloudflare-pages' as const,token:'cloudflare-token-123456',providerAccountId,projectName,siteIds:[SITE]};
  const a=await connectPublisherToken(f.store,f.vault,input,{fetch});
  assert.equal(a.ownerSiteId,SITE);assert.equal(a.username,providerAccountId);assert.equal(a.cloudflarePages?.projectId,projectId);
  assert.equal(a.publicationUrl,`https://${projectName}.pages.dev/`);assert.deepEqual(methods,['GET','GET','GET']);
  assert.ok(f.store.getCipher(`account:${a.id}`)?.includes('apiToken'));assert.equal(JSON.stringify(a).includes(input.token),false);
  const backup={state:f.store.read(),secrets:{[`account:${a.id}`]:f.store.getCipher(`account:${a.id}`)!.slice(7)}};
  const restored=validateBackup(decryptBackup(encryptBackup(backup,'synthetic-backup-passphrase'),'synthetic-backup-passphrase'));
  assert.deepEqual(restored.state.accounts[0].cloudflarePages,a.cloudflarePages);
  const imported=new Store(':memory:');try{imported.restore(restored.state,f.store.allCiphers());assert.deepEqual(imported.read().accounts[0].cloudflarePages,a.cloudflarePages)}finally{imported.close()}
  const forged=structuredClone(backup);forged.state.accounts[0].cloudflarePages!.projectName='other-project';
  assert.throws(()=>validateBackup(forged),/Cloudflare Pages/);
  assert.throws(()=>f.store.update(state=>{state.accounts[0].cloudflarePages!.projectName='other-project'}),/Cloudflare Pages/);
  assert.equal(f.store.read().accounts[0].cloudflarePages?.projectName,projectName);
  const before=JSON.stringify(f.store.read());
  await assert.rejects(connectPublisherToken(f.store,f.vault,{...input,siteIds:[OTHER],accountId:a.id},{fetch}),/固定于其他网站/);
  assert.equal(JSON.stringify(f.store.read()),before);
  await assert.rejects(connectPublisherToken(f.store,f.vault,{...input,projectName:'another-project',accountId:a.id},{fetch}),/固定于其他网站或项目/);
  assert.equal(JSON.stringify(f.store.read()),before);
  occupied=true;
  await assert.rejects(connectPublisherToken(f.store,f.vault,{...input,accountId:undefined},{fetch}),/连接未通过/);
  assert.equal(JSON.stringify(f.store.read()),before);
  assert.ok(methods.every(method=>method==='GET'));
 }finally{f.store.close();}
});
test('ShipStatic connects a Free account and vacant named domain using GET only',async()=>{
 const f=fixture(),token=`ship-${'a'.repeat(32)}`,domain='reviewed-software-guide.shipstatic.com';
 const methods:string[]=[];
 const fetch=async(url:string,init:RequestInit)=>{methods.push(`${init.method} ${url}`);
  if(url.endsWith('/account'))return new Response(JSON.stringify({email:'writer@example.com',plan:'free',usage:{platformDomains:0,deployments:0},caps:{platformDomains:1,deployments:100}}),{headers:{'content-type':'application/json'}});
  return new Response(JSON.stringify({error:'not_found'}),{status:404,headers:{'content-type':'application/json'}});
 };
 try{const input={channelId:'shipstatic' as const,token,shipStaticDomain:domain,siteIds:[SITE]};
  const a=await connectPublisherToken(f.store,f.vault,input,{fetch});
  assert.equal(a.ownerSiteId,SITE);assert.equal(a.username,'writer@example.com');assert.equal(a.publicationUrl,`https://${domain}/`);
  assert.deepEqual(methods,[`GET https://api.shipstatic.com/account`,`GET https://api.shipstatic.com/domains/${domain}`]);
  assert.equal(JSON.stringify(f.store.read()).includes(token),false);
  const secret=f.store.getCipher(`account:${a.id}`)!.slice(7),backup={state:f.store.read(),secrets:{[`account:${a.id}`]:secret}};
  assert.doesNotThrow(()=>validateBackup(backup));
  await assert.rejects(connectPublisherToken(f.store,f.vault,{...input,siteIds:[OTHER],accountId:a.id},{fetch}),/固定于其他网站/);
  assert.ok(methods.every(m=>m.startsWith('GET ')));
 }finally{f.store.close();}
});
test('Netlify and Mastodon token accounts survive encrypted backup roundtrip with bound secrets',async()=>{
 for(const channelId of ['mastodon','netlify'] as const){
  const f=fixture();try{
   const fetch=channelId==='mastodon'?f.fetch:async(url:string)=>new Response(JSON.stringify(url.endsWith('/user')?{id:'user-123',full_name:'Example Owner'}:[{id:'team-123',type_name:'Free',has_stripe_payment_method:false,auto_topup_enabled:false,payment_method_id:null,owner_ids:['user-123']}]),{headers:{'content-type':'application/json'}});
   const account=await connectPublisherToken(f.store,f.vault,{channelId,token:TOKEN,siteIds:[SITE]},{fetch});
   const key=`account:${account.id}`,backup={state:f.store.read(),secrets:{[key]:f.store.getCipher(key)!.slice(7)}};
   const restored=validateBackup(decryptBackup(encryptBackup(backup,'synthetic-backup-passphrase'),'synthetic-backup-passphrase'));
   assert.equal(restored.state.accounts[0].username,account.username);assert.equal(restored.secrets[key],backup.secrets[key]);
   assert.throws(()=>validateBackup({...backup,secrets:{[key]:'forged-token'}}));
  }finally{f.store.close();}
 }
});
test('Mastodon connects through GET, persists encrypted token and preserves original connection on rejected identity',async()=>{
 const f=fixture();try{
  const a=await connectPublisherToken(f.store,f.vault,{channelId:'mastodon',token:TOKEN,siteIds:[SITE]},{fetch:f.fetch});
  assert.equal(a.credentialKind,'api_token');assert.equal(JSON.stringify(a).includes(TOKEN),false);assert.equal(f.store.getCipher(`account:${a.id}`),`cipher:${TOKEN}`);
  const before=JSON.stringify(f.store.read());
  await assert.rejects(connectPublisherToken(f.store,f.vault,{channelId:'mastodon',token:TOKEN,siteIds:[OTHER],accountId:a.id},{fetch:f.fetch}),/其他网站/);
  assert.equal(JSON.stringify(f.store.read()),before);
 }finally{f.store.close();}
});
test('concurrent site deletion and cancellation cannot install a new token',async()=>{
 for(const cancellation of [false,true]){const f=fixture(),abort=new AbortController();try{
  await assert.rejects(connectPublisherToken(f.store,f.vault,{channelId:'mastodon',token:TOKEN,siteIds:[SITE]}, {signal:abort.signal,fetch:async()=>{const response=await f.fetch();if(cancellation)abort.abort();else f.store.update(s=>{s.sites=s.sites.filter(v=>v.id!==SITE);});return response;}}));
  assert.equal(f.store.read().accounts.length,0);assert.equal(f.store.read().accountBindings.length,0);
 }finally{f.store.close();}}
});
test('account must allow public search and declare automation before credentials are stored',async()=>{
 const f=fixture();try{
  await assert.rejects(connectPublisherToken(f.store,f.vault,{channelId:'mastodon',token:TOKEN,siteIds:[SITE]},{fetch:async()=>new Response(JSON.stringify({id:'123',acct:'example_author',url:'https://mastodon.social/@example_author',bot:false,indexable:true}),{headers:{'content-type':'application/json'}})}));
  assert.equal(f.store.read().accounts.length,0);
 }finally{f.store.close();}
});

test('Mastodon URL decoration may shorten visible text without accepting hidden or changed links',()=>{
 const target='https://example.com/guide',text=`A useful explanation ${target}`;
 const page={url:'https://mastodon.social/@example_author/123',headHtml:'',robots:[],refresh:false,bodyHtml:`<div data-batch5-article><p>A useful explanation <a href="${target}"><span hidden>https://</span><span>example.com/guide</span></a></p></div>`};
 assert.equal(inspectBatch5RenderedBody(page,target,'',text).found,true);
 assert.equal(inspectBatch5RenderedBody({...page,bodyHtml:page.bodyHtml.replace('<a href','<a hidden href')},target,'',text).found,false);
 assert.equal(inspectBatch5RenderedBody({...page,bodyHtml:page.bodyHtml.replace('A useful','An altered')},target,'',text).found,false);
 assert.equal(inspectBatch5RenderedBody({...page,bodyHtml:page.bodyHtml.replace('<span hidden>https://</span><span>example.com/guide</span>','UNREVIEWED PROMOTION')},target,'',text).found,false);
 assert.equal(inspectBatch5RenderedBody({...page,robots:['none']},target,'',text).found,false);
});


test('pending original publication prevents new-identity binding and unbinding, including durable journal',async()=>{
 for(const durable of [false,true]){const f=fixture();try{
  const a=await connectPublisherToken(f.store,f.vault,{channelId:'mastodon',token:TOKEN,siteIds:[SITE]},{fetch:f.fetch});
  const at='2026-10-28T00:00:00.000Z',taskId='33333333-3333-4333-8333-333333333333';
  f.store.update(s=>{s.tasks.push({id:taskId,siteId:SITE,channelId:'mastodon',accountId:a.id,sourceDomain:'mastodon.social',status:'needs_input',createdAt:at,updatedAt:at,scheduledAt:at,attempts:1,message:'fixture',...(!durable?{submittedAt:at}:{})});});
  if(durable){const journal=createBatch5Persistence(f.store,{...f.vault,get:async(key:string)=>f.store.getCipher(key)?.slice(7)},taskId,()=>{});
   const intent={version:1 as const,channelId:'mastodon',siteId:SITE,operationId:'synthetic-pending',sourceHash:'1'.repeat(64),requestHash:'2'.repeat(64),createdAt:at};
   await journal.reserveIntent!(intent);await journal.markSending!(intent);
  }
  const before=JSON.stringify(f.store.read());
  const changed=async()=>new Response(JSON.stringify({id:'456',acct:'second_author',url:'https://mastodon.social/@second_author',bot:true,indexable:true}),{headers:{'content-type':'application/json'}});
  await assert.rejects(connectPublisherToken(f.store,f.vault,{channelId:'mastodon',token:TOKEN,siteIds:[SITE]},{fetch:changed}),/原发布/);
  assert.equal(JSON.stringify(f.store.read()),before);
  assert.throws(()=>f.store.update(s=>unbindAccount(s,a.id,SITE,'mastodon')),/原发布/);
  assert.equal(JSON.stringify(f.store.read()),before);
 }finally{f.store.close();}}
});

test('Leafmill identifies email by read-only probe and backup binds encrypted key to that identity',async()=>{
 const f=fixture();try{
  const calls:string[]=[];
  const fetch=async(url:string,init?:RequestInit)=>{calls.push(`${init?.method??'GET'} ${url}`);return new Response(JSON.stringify({email:'writer@example.com',articleCount:0}),{headers:{'content-type':'application/json'}})};
  const a=await connectPublisherToken(f.store,f.vault,{channelId:'leafmill',token:TOKEN,siteIds:[SITE]},{fetch});
  assert.equal(a.email,'writer@example.com');assert.equal(a.username,a.email);assert.equal(a.publicationUrl,'https://leafmill.net/');
  assert.deepEqual(calls,['GET https://leafmill.net/api/v1/me']);assert.equal(JSON.stringify(f.store.read()).includes(TOKEN),false);
  const key=`account:${a.id}`,backup={state:f.store.read(),secrets:{[key]:f.store.getCipher(key)!.slice(7)}};
  const restored=validateBackup(decryptBackup(encryptBackup(backup,'synthetic-backup-passphrase'),'synthetic-backup-passphrase'));
  assert.equal(restored.state.accounts[0].email,a.email);
  const forged=structuredClone(backup);forged.state.accounts[0].email='someone-else@example.com';
  assert.throws(()=>validateBackup(forged),/Leafmill/);
  const before=JSON.stringify(f.store.read());
  await assert.rejects(connectPublisherToken(f.store,f.vault,{channelId:'leafmill',token:TOKEN,siteIds:[OTHER],accountId:a.id},{fetch}),/其他网站/);
  assert.equal(JSON.stringify(f.store.read()),before);
 }finally{f.store.close();}
});

test('the account editor cannot clear a new publisher binding that an individual unbind refuses',()=>{
  const state=emptyState(),accountId=randomUUID(),siteId=randomUUID(),at='2026-10-20T12:00:00.000Z';
  for(const channelId of ['agentel','clawprint']){
    state.accounts=[{id:accountId,channelId,source:'generated',status:'unknown',registrationAttempts:1,email:'',hasPassword:false,createdAt:at,updatedAt:at} as unknown as Account];
    state.accountBindings=[{accountId,siteId,channelId,createdAt:at} as unknown as SiteAccountBinding];
    assert.throws(()=>setSelectedAccountSites(state,accountId,new Set(),{id:channelId} as Channel),/未确认/);
    assert.equal(state.accountBindings.length,1);
  }
});
