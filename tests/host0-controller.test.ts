import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Controller} from '../src/main/controller';
import {Store} from '../src/main/store';
import {buildChannelTermsCache,reviewedChannelTermsCache} from '../src/main/article-evidence';
import {currentArticlePublicationContext,host0OriginalPurpose} from '../src/main/article-publication-context';
import {reviewArticleDraft} from '../src/main/article-review';
import {validateBackup} from '../src/main/backup-validation';
import {connectPublisherToken} from '../src/main/publisher-token-management';
import {CHANNELS} from '../src/integrations/catalog';
import {HOST0_API,host0Document,host0ReservedSlug,runHost0ConnectedTask} from '../src/integrations/host0';
import type {Vault} from '../src/main/vault';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const at='2026-10-30T09:00:00.000Z',target='https://software.example.org/guide',apiKey=`h0_${'a'.repeat(40)}`;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
async function setup(){
  const site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Software Example',description:'Maintained software guide',email:'owner@example.org',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:at,topics:[{url:target,discoveredAt:at}],qualifications:{software:'https://software.example.org/'}};
  const catalog=CHANNELS.find(row=>row.id==='host0');assert.ok(catalog);
  const channel:Channel={...catalog,enabled:true};
  const policy='Publish original software documentation. Do not create spam, bulk search manipulation, or affiliate link farms.';
  const guidance='Upload static files to create one app from your own documentation.';
  channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(channel,[{url:channel.rulesUrl,kind:'content_policy',text:policy,appliesTo:'host0',applicability:'verified'},{url:'https://host0.ai/agents',kind:'product_guidance',text:guidance,appliesTo:'host0',applicability:'verified'}]),{finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'});
  const account:Account={id:randomUUID(),channelId:'host0',email:'owner@example.org',username:'owner@example.org',ownerSiteId:site.id,publicationUrl:'https://host0.ai/',createdAt:at,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token'};
  const task:Task={id:randomUUID(),siteId:site.id,channelId:'host0',accountId:account.id,sourceDomain:channel.domain,status:'queued',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'test',draftRevision:1,topicUrl:target,
    draft:{title:'Reproducing a software release',description:'An original diagnostic guide.',body:`Written by an AI assistant for Software Example. Reproduce the configuration, compare release notes, and document failures. See the [maintained project guide](${target}). Disclosure: we maintain Software Example and the linked project.`}};
  task.host0OriginalPurpose=host0OriginalPurpose(task);
  const store=new Store(':memory:');const state=store.read();state.settings.articleReviewMode='ai';
  const review=await reviewArticleDraft(task,site,channel,state.settings,{json:async()=>({verdict:'pass',reason:'The original guide is useful.',citations:[{url:site.url,quote:site.description}],policyAssessment:{useKind:'original_editorial',verdict:'compatible',reason:'One original document fits static hosting.',citations:[{url:'https://host0.ai/agents',quote:'Upload static files to create one app from your own documentation.',purpose:'hosting_purpose'},{url:channel.rulesUrl,quote:'Do not create spam, bulk search manipulation, or affiliate link farms.',purpose:'use_restriction'}]}} as never)},undefined,{account,publicationContext:currentArticlePublicationContext([task],task),fetchHtml:async url=>({url,html:`<main><p>${url===site.url?site.description:url===channel.rulesUrl?policy:guidance}</p></main>`})});
  assert.equal(review.status,'passed',review.reason);task.articleReview=review;
  store.update(s=>{s.sites=[site];s.accounts=[account];s.tasks=[task];s.accountBindings=[{id:randomUUID(),siteId:site.id,channelId:'host0',accountId:account.id,createdAt:at,updatedAt:at}];s.settings.autoRun=true;s.settings.articleReviewMode='ai';s.settings.channelOverrides.host0=true;s.channelTermsCache??={};s.channelTermsCache.host0=channel.termsCache!});
  const vault={ready:true,available:()=>true,get:async(key:string)=>{const v=store.getCipher(key);return v?.startsWith('enc:')?Buffer.from(v.slice(4),'base64').toString():undefined},set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'enc:'+Buffer.from(value).toString('base64')]))} as unknown as Vault;
  store.updateWithCiphers(()=>{},vault.encryptSecrets({[`account:${account.id}`]:JSON.stringify({version:1,apiKey,email:account.email})}));
  const slug=host0ReservedSlug(task.id),url=`https://${slug}.host0.app/`,appId='app_123456789',deployment='deployment_123456789',doc=host0Document(site,task);
  let appCreated=false,visibility='private',posts=0,writes=0,controller:Controller|undefined,afterCreate:(()=>void)|undefined,loseCreateResponse=false;
  const fetch=async(path:string,init:RequestInit)=>{
    if(init.method!=='GET')writes++;
    if(path===`${HOST0_API}/account`)return json({email:account.email,plan:{id:'free'},limits:{account:{max_apps:100,max_public_apps:3},upload:{max_files:1000,max_file_bytes:3145728,max_total_bytes:104857600}},usage:{public_apps:0,max_public_apps:3,stored_bytes:0,storage_quota_bytes:524288000,over_visit_limit:false}});
    if(path===`${HOST0_API}/apps`&&init.method==='GET')return json({apps:appCreated?[{id:appId,slug}]:[]});
    if(path===`${HOST0_API}/slugs/${slug}`)return json({slug,available:!appCreated});
    if(path===`${HOST0_API}/apps/${slug}`&&init.method==='GET')return appCreated?json({id:appId,slug,name:task.draft!.title,owner_email:account.email,visibility,url:url.slice(0,-1)}):json({error:'not_found'},404);
    if(path===`${HOST0_API}/apps`&&init.method==='POST'){posts++;appCreated=true;afterCreate?.();if(loseCreateResponse)throw Error('response lost');return json({id:appId,slug},201)}
    if(path===`${HOST0_API}/apps/${appId}`&&init.method==='GET')return json({id:appId,slug,name:task.draft!.title,owner_email:account.email,visibility,url:url.slice(0,-1)});
    if(path===`${HOST0_API}/apps/${appId}/files/index.html`)return new Response(doc.html,{headers:{'content-type':'application/octet-stream'}});
    if(path===`${HOST0_API}/apps/${appId}/deployments`&&init.method==='POST')return json({deployment_id:deployment},201);
    if(path===`${HOST0_API}/deployments/${deployment}/files/index.html`&&init.method==='PUT')return new Response(null,{status:204});
    if(path===`${HOST0_API}/deployments/${deployment}/files/robots.txt`&&init.method==='PUT')return new Response(null,{status:204});
    if(path===`${HOST0_API}/deployments/${deployment}/finalize`&&init.method==='POST')return json({status:'live',url:url.slice(0,-1),deployment_id:deployment,version:1,previous_version:null});
    if(path===`${HOST0_API}/apps/${appId}`&&init.method==='PATCH'){visibility='public';return json({visibility:'public'})}
    if(path===url)return new Response(doc.html.replace('</body>','<div>Hosted on host0</div><script src="/analytics.js"></script></body>'),{headers:{'content-type':'text/html'}});
    if(path===`${url}robots.txt`)return new Response('User-agent: *\nAllow: /\n',{headers:{'content-type':'text/plain'}});
    throw Error(`unexpected ${init.method} ${path}`);
  };
  const start=()=>{controller=new Controller(store,vault,'fixture',{channelCatalog:[channel],batch5Dependencies:{fetch}});store.update(s=>{s.tasks[0].status='running'});return (controller as unknown as {context:(task:Task,signal:AbortSignal)=>ExecutionContext}).context(store.read().tasks[0],new AbortController().signal)};
  return {store,vault,site,account,task,doc,url,start,close:()=>{controller?.stop();store.close()},posts:()=>posts,writes:()=>writes,setAfterCreate:(value:()=>void)=>{afterCreate=value},setLostResponse:()=>{loseCreateResponse=true}};
}

test('controller completes six guarded host0 writes and encrypted backup recovery',async()=>{
  const f=await setup();try{const context=f.start(),journal=context.host0Journal!,baseArm=journal.arm.bind(journal);let armError='';journal.arm=async(intent,step)=>{try{await baseArm(intent,step)}catch(error){armError='arm '+step+': '+String(error);throw error}};const result=await runHost0ConnectedTask(context);assert.equal(result.status,'review',JSON.stringify(result));assert.equal(f.writes(),6,JSON.stringify({result,armError,journal:await context.host0Journal?.load()}));assert.equal(f.posts(),1);assert.equal(f.store.read().tasks[0].publicUrl,f.url);const publication=await f.vault.get(`publication:${f.task.id}`);assert.ok(publication);const secrets={[`account:${f.account.id}`]:await f.vault.get(`account:${f.account.id}`)??'',[`publication:${f.task.id}`]:publication};assert.equal(validateBackup({state:f.store.read(),secrets}).state.tasks[0].publicUrl,f.url)}finally{f.close()}
});

test('controller blocks POST after late channel revocation while preserving intent and never replaying',async()=>{
  const f=await setup();try{const context=f.start(),journal=context.host0Journal!;const arm=journal.arm.bind(journal);journal.arm=async(intent,step)=>{await arm(intent,step);if(step==='create_app')f.store.update(s=>{s.settings.channelOverrides.host0=false})};const result=await runHost0ConnectedTask(context);assert.equal(result.reasonCode,'submission_unknown');assert.equal(f.posts(),0);assert.equal((await journal.load())?.steps.create_app?.stage,'sending');f.store.update(s=>{s.settings.channelOverrides.host0=true});const restarted=f.start();const retry=await runHost0ConnectedTask(restarted);assert.equal(retry.reasonCode,'submission_unknown');assert.equal(f.posts(),0)}finally{f.close()}
});

 test('unknown host0 create result is kept encrypted and restart only reads',async()=>{
  const f=await setup();try{f.setLostResponse();const context=f.start(),first=await runHost0ConnectedTask(context);assert.equal(first.reasonCode,'submission_unknown');assert.equal(f.posts(),1);assert.equal((await context.host0Journal!.load())?.steps.create_app?.stage,'sending');const restarted=f.start();const again=await runHost0ConnectedTask(restarted);assert.equal(again.reasonCode,'submission_unknown');assert.equal(f.posts(),1)}finally{f.close()}
});

 test('successful create response is encrypted even when the site pauses before readback',async()=>{
  const f=await setup();try{f.setAfterCreate(()=>f.store.update(s=>{s.sites[0].status='paused'}));const context=f.start(),first=await runHost0ConnectedTask(context);assert.equal(first.reasonCode,'submission_unknown');assert.equal(f.posts(),1);assert.equal((await context.host0Journal!.load())?.steps.create_app?.stage,'response');assert.ok(f.store.getCipher(`publication:${f.task.id}`));assert.equal(f.writes(),1);const restarted=f.start(),again=await runHost0ConnectedTask(restarted);assert.equal(again.status,'needs_input');assert.equal(f.posts(),1)}finally{f.close()}
});

 test('host0 read-only token connection binds one software site and encrypted backup identity',async()=>{
  const f=await setup();const store=new Store(':memory:');try{store.update(s=>{s.sites=[f.site]});const vault={encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'enc:'+Buffer.from(value).toString('base64')]))} as Vault;let reads=0;const account=await connectPublisherToken(store,vault,{channelId:'host0',token:apiKey,siteIds:[f.site.id]},{fetch:async(url,init)=>{assert.equal(url,`${HOST0_API}/account`);assert.equal(init.method,'GET');reads++;return json({email:f.account.email,plan:{id:'free'},limits:{account:{max_apps:100,max_public_apps:3},upload:{max_files:1000,max_file_bytes:3145728,max_total_bytes:104857600}},usage:{public_apps:0,max_public_apps:3,stored_bytes:0,storage_quota_bytes:524288000,over_visit_limit:false}})}});assert.equal(reads,1);assert.equal(account.ownerSiteId,f.site.id);assert.equal(store.read().accountBindings[0].accountId,account.id);const secret=Buffer.from(store.getCipher(`account:${account.id}`)!.slice(4),'base64').toString();assert.equal(validateBackup({state:store.read(),secrets:{[`account:${account.id}`]:secret}}).state.accounts[0].email,f.account.email)}finally{store.close();f.close()}
});
