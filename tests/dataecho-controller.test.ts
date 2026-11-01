import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Controller} from '../src/main/controller';
import {Store} from '../src/main/store';
import {buildChannelTermsCache,reviewedChannelTermsCache} from '../src/main/article-evidence';
import {currentArticlePublicationContext,dataEchoOriginalPurpose} from '../src/main/article-publication-context';
import {reviewArticleDraft} from '../src/main/article-review';
import {validateBackup} from '../src/main/backup-validation';
import {connectPublisherToken} from '../src/main/publisher-token-management';
import {CHANNELS} from '../src/integrations/catalog';
import {DATAECHO_API,dataEchoDocument,runDataEchoConnectedTask} from '../src/integrations/dataecho';
import type {Vault} from '../src/main/vault';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const at='2026-10-30T09:00:00.000Z',target='https://software.example.org/guide',apiKey=`de_${'a'.repeat(40)}`;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
async function setup(){
  const site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Software Example',description:'Maintained software guide',email:'owner@example.org',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:at,topics:[{url:target,discoveredAt:at}],qualifications:{software:'https://software.example.org/'}};
  const catalog=CHANNELS.find(row=>row.id==='dataecho');assert.ok(catalog);
  const channel:Channel={...catalog,enabled:true};
  const policy='Publish original software documentation. Do not create spam, bulk search manipulation, or affiliate link farms.';
  const guidance='Upload static files to create one app from your own documentation.';
  channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(channel,[{url:channel.rulesUrl,kind:'content_policy',text:policy,appliesTo:'dataecho',applicability:'verified'},{url:'https://dataecho.ai/docs',kind:'product_guidance',text:guidance,appliesTo:'dataecho',applicability:'verified'}]),{finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'});
  const account:Account={id:randomUUID(),channelId:'dataecho',email:'owner@example.org',username:'test_owner',ownerSiteId:site.id,publicationUrl:'https://dataecho.ai/',createdAt:at,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token'};
  const task:Task={id:randomUUID(),siteId:site.id,channelId:'dataecho',accountId:account.id,sourceDomain:channel.domain,status:'queued',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'test',draftRevision:1,topicUrl:target,
    draft:{title:'Reproducing a software release',description:'An original diagnostic guide.',body:`Written by an AI assistant for Software Example. Reproduce the configuration, compare release notes, and document failures. See the [maintained project guide](${target}). Disclosure: we maintain Software Example and the linked project.`}};
  task.dataechoOriginalPurpose=dataEchoOriginalPurpose(task);
  const store=new Store(':memory:');const state=store.read();state.settings.articleReviewMode='ai';
  const review=await reviewArticleDraft(task,site,channel,state.settings,{json:async()=>({verdict:'pass',reason:'The original guide is useful.',citations:[{url:site.url,quote:site.description}],policyAssessment:{useKind:'original_editorial',verdict:'compatible',reason:'One original document fits static hosting.',citations:[{url:'https://dataecho.ai/docs',quote:'Upload static files to create one app from your own documentation.',purpose:'hosting_purpose'},{url:channel.rulesUrl,quote:'Do not create spam, bulk search manipulation, or affiliate link farms.',purpose:'use_restriction'}]}} as never)},undefined,{account,publicationContext:currentArticlePublicationContext([task],task),fetchHtml:async url=>({url,html:`<main><p>${url===site.url?site.description:url===channel.rulesUrl?policy:guidance}</p></main>`})});
  assert.equal(review.status,'passed',review.reason);task.articleReview=review;
  store.update(s=>{s.sites=[site];s.accounts=[account];s.tasks=[task];s.accountBindings=[{id:randomUUID(),siteId:site.id,channelId:'dataecho',accountId:account.id,createdAt:at,updatedAt:at}];s.settings.autoRun=true;s.settings.articleReviewMode='ai';s.settings.channelOverrides.dataecho=true;s.channelTermsCache??={};s.channelTermsCache.dataecho=channel.termsCache!});
  const vault={ready:true,available:()=>true,get:async(key:string)=>{const v=store.getCipher(key);return v?.startsWith('enc:')?Buffer.from(v.slice(4),'base64').toString():undefined},set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'enc:'+Buffer.from(value).toString('base64')]))} as unknown as Vault;
  store.updateWithCiphers(()=>{},vault.encryptSecrets({[`account:${account.id}`]:JSON.stringify({version:1,apiKey,email:account.email,username:account.username})}));
  const slug='software-guide-ab12',url=`https://${slug}.dataecho.ai/`,versionId='version_123456789',doc=dataEchoDocument(site,task);
  const uploads=doc.files.map(file=>({path:file.path,method:'PUT',url:`https://${'a'.repeat(32)}.r2.cloudflarestorage.com/bucket/${file.path}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=${'b'.repeat(64)}`,headers:{'Content-Type':file.contentType}}));
  const create={slug,siteUrl:url,upload:{versionId,uploads,skipped:[],finalizeUrl:`${DATAECHO_API}/publish/${slug}/finalize`}};
  let posts=0,writes=0,controller:Controller|undefined,afterCreate:(()=>void)|undefined,loseCreateResponse=false;
  const fetch=async(path:string,init:RequestInit)=>{
    if(init.method!=='GET')writes++;
    if(path===`${DATAECHO_API}/profile`&&init.method==='GET')return json({username:account.username,profileUrl:`/@${account.username}`});
    if(path===`${DATAECHO_API}/publish`&&init.method==='POST'){posts++;afterCreate?.();if(loseCreateResponse)throw Error('response lost');return json(create,201)}
    if(uploads.some(file=>file.url===path)&&init.method==='PUT')return new Response(null,{status:204});
    if(path===create.upload.finalizeUrl&&init.method==='POST')return json({ok:true});
    if(path===`${DATAECHO_API}/publish/${slug}`&&init.method==='GET')return json({slug,siteUrl:url,currentVersionId:versionId,pendingVersionId:null,anonymous:false,passwordProtected:false,payGated:false,spaMode:false,kind:'static',expiresAt:null,files:doc.files.map(({path,size,hash,contentType})=>({path,size,hash,contentType}))});
    if(path===url)return new Response(doc.html,{headers:{'content-type':'text/html'}});
    if(path===`${url}robots.txt`)return new Response('User-agent: *\nAllow: /\n',{headers:{'content-type':'text/plain'}});
    throw Error(`unexpected ${init.method} ${path}`);
  };
  const start=()=>{controller=new Controller(store,vault,'fixture',{channelCatalog:[channel],batch5Dependencies:{fetch}});store.update(s=>{s.tasks[0].status='running'});return (controller as unknown as {context:(task:Task,signal:AbortSignal)=>ExecutionContext}).context(store.read().tasks[0],new AbortController().signal)};
  return {store,vault,site,account,task,doc,url,start,close:()=>{controller?.stop();store.close()},posts:()=>posts,writes:()=>writes,setAfterCreate:(value:()=>void)=>{afterCreate=value},setLostResponse:()=>{loseCreateResponse=true}};
}


test('DataEcho production controller uses four guarded writes and preserves backup identity',async()=>{
 const f=await setup();try{const context=f.start(),result=await runDataEchoConnectedTask(context);assert.equal(result.publicUrl,f.url,JSON.stringify(result));assert.equal(f.writes(),4);assert.equal(f.posts(),1);
 const secrets={[`account:${f.account.id}`]:(await f.vault.get(`account:${f.account.id}`))!,[`publication:${f.task.id}`]:(await f.vault.get(`publication:${f.task.id}`))!};
 assert.equal(validateBackup({state:f.store.read(),secrets}).state.tasks[0].publicUrl,f.url);
 const changed=JSON.parse(secrets[`account:${f.account.id}`]);changed.username='other_owner';assert.throws(()=>validateBackup({state:f.store.read(),secrets:{...secrets,[`account:${f.account.id}`]:JSON.stringify(changed)}}),/DataEcho/);
 }finally{f.close()}
});
test('DataEcho controller blocks late revocation after durable arm and never repeats creation',async()=>{
 const f=await setup();try{const context=f.start(),journal=context.dataEchoJournal!,arm=journal.arm.bind(journal);journal.arm=async(intent,step)=>{await arm(intent,step);if(step==='create')f.store.update(s=>{s.settings.channelOverrides.dataecho=false})};
 const result=await runDataEchoConnectedTask(context);assert.equal(result.reasonCode,'submission_unknown');assert.equal(f.posts(),0);assert.equal((await journal.load())?.steps.create?.stage,'sending');
 f.store.update(s=>{s.settings.channelOverrides.dataecho=true});assert.equal((await runDataEchoConnectedTask(f.start())).reasonCode,'submission_unknown');assert.equal(f.posts(),0);
 }finally{f.close()}
});
test('DataEcho lost create result remains encrypted and restart never writes again',async()=>{
 const f=await setup();try{f.setLostResponse();const c=f.start();assert.equal((await runDataEchoConnectedTask(c)).reasonCode,'submission_unknown');assert.equal(f.posts(),1);assert.equal((await c.dataEchoJournal!.load())?.steps.create?.stage,'sending');assert.equal((await runDataEchoConnectedTask(f.start())).reasonCode,'submission_unknown');assert.equal(f.posts(),1)}finally{f.close()}
});
test('DataEcho original create response is saved when site pauses midflight',async()=>{
 const f=await setup();try{f.setAfterCreate(()=>f.store.update(s=>{s.sites[0].status='paused'}));const c=f.start();assert.equal((await runDataEchoConnectedTask(c)).reasonCode,'submission_unknown');assert.equal(f.writes(),1);assert.equal((await c.dataEchoJournal!.load())?.steps.create?.stage,'response')}finally{f.close()}
});
test('DataEcho token connection remotely binds username and locally labels email; backup rejects identity drift',async()=>{
 const f=await setup(),store=new Store(':memory:');try{store.update(s=>{s.sites=[f.site]});let gets=0;const account=await connectPublisherToken(store,f.vault,{channelId:'dataecho',token:apiKey,siteIds:[f.site.id],dataEchoEmail:f.account.email},{fetch:async(url,init)=>{assert.equal(url,DATAECHO_API+'/profile');assert.equal(init.method,'GET');gets++;return json({username:'test_owner',profileUrl:'/@test_owner'})}});
 assert.equal(gets,1);assert.equal(account.username,'test_owner');assert.equal(account.ownerSiteId,f.site.id);const raw=Buffer.from(store.getCipher(`account:${account.id}`)!.slice(4),'base64').toString();assert.equal(validateBackup({state:store.read(),secrets:{[`account:${account.id}`]:raw}}).state.accounts[0].email,f.account.email);
 await assert.rejects(connectPublisherToken(store,f.vault,{channelId:'dataecho',token:apiKey,siteIds:[f.site.id],accountId:account.id,dataEchoEmail:f.account.email},{fetch:async()=>json({username:'another_owner',profileUrl:'/@another_owner'})}),/其他账号/);
 }finally{store.close();f.close()}
});
test('DataEcho original purpose marker is bound to exact task and draft',async()=>{
 const f=await setup();try{assert.equal(currentArticlePublicationContext([f.task],f.task).publicationIntent,'single_original_article');const changed=structuredClone(f.task);changed.draft!.body+=' changed';assert.equal(currentArticlePublicationContext([changed],changed).publicationIntent,'unknown');delete changed.dataechoOriginalPurpose;assert.equal(currentArticlePublicationContext([changed],changed).publicationIntent,'unknown')}finally{f.close()}
});
