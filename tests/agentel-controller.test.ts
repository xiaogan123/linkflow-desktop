import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {articleReviewStillValid,reviewArticleDraft} from '../src/main/article-review';
import {buildChannelTermsCache,reviewedChannelTermsCache} from '../src/main/article-evidence';
import {agentelOriginalPurpose,agentelSingleArticleCandidate,currentArticlePublicationContext} from '../src/main/article-publication-context';
import {CHANNELS} from '../src/integrations/catalog';
import {connectPublisherToken} from '../src/main/publisher-token-management';
import {reconcileAgentelConnectedTask,runAgentelConnectedTask} from '../src/main/agentel-publisher';
import {validateBackup} from '../src/main/backup-validation';
import {unbindAccount} from '../src/main/account-bindings';
import {createAgentelEncryptedJournal,agentelBackupMatches,agentelRegistrationBackupMatches,parseAgentelCredential} from '../src/main/agentel-publication';
import {AGENTEL_API,AGENTEL_ORIGIN,runAgentelPublication,runAgentelRegistration,type AgentelArticle,type AgentelIdentity} from '../src/integrations/agentel';
import type {Vault} from '../src/main/vault';
import type {Site,Task,Channel,ExecutionContext} from '../src/shared/types';

const at='2026-10-30T01:00:00.000Z';
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fixture(){
  const store=new Store(':memory:'),siteId=randomUUID(),accountId=randomUUID(),taskId=randomUUID(),target='https://software.example.org/guide';
  const site:Site={id:siteId,domain:'software.example.org',url:'https://software.example.org/',name:'Software Example',description:'Maintained software guide',email:'owner@example.org',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:at,topics:[{url:target,discoveredAt:at}],qualifications:{software:'https://software.example.org/'}};
  const identity:AgentelIdentity={name:'Software Research AI Assistant',slug:'software-research-ai-assistant',description:'AI assistant documenting practical software integration research for Software Example.',category:'coding',installationId:'software-research-ai-assistant'};
  const article:AgentelArticle={title:'Reproducing a software integration',content:`Written by an AI assistant for Software Example. I reproduced the integration and recorded the limits. Source: ${target}. Disclosure: we maintain Software Example.`,targetUrl:target,siteUrl:site.url};
  const task:Task={id:taskId,siteId,channelId:'agentel',accountId,sourceDomain:'agentel.tech',status:'running',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'test',topicUrl:target,draftRevision:1,draft:{title:article.title,description:'A practical original note',body:article.content}};
  store.update(s=>{s.sites=[site];s.settings.autoRun=true});
  const vault={get:async(key:string)=>{const cipher=store.getCipher(key);return cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64').toString():undefined},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'enc:'+Buffer.from(value).toString('base64')]))} as Vault;
  const authorize=(state:ReturnType<Store['read']>,current?:Task)=>{if(state.sites.find(s=>s.id===siteId)?.status!=='ready'||!state.settings.autoRun||current&&current.status!=='running')throw Error('authorization revoked')};
  const registrationJournal=createAgentelEncryptedJournal(store,vault,{siteId,accountId,identity,authorize});
  const registrationOptions=(fetch:(url:string,init:RequestInit)=>Promise<Response>)=>({journal:registrationJournal,siteId,authorize:()=>authorize(store.read()),dependencies:{fetch},signal:new AbortController().signal,now:()=>new Date(at)});
  const publicationJournal=()=>createAgentelEncryptedJournal(store,vault,{siteId,accountId,taskId,article,credential:{agentId:'agent_test-1',slug:identity.slug,apiKey:'agentel_live_test_secret'},authorize});
  const publicationOptions=(fetch:(url:string,init:RequestInit)=>Promise<Response>)=>({journal:publicationJournal(),siteId,taskId,authorize:()=>authorize(store.read(),store.read().tasks.find(t=>t.id===taskId)),dependencies:{fetch},signal:new AbortController().signal,now:()=>new Date(at)});
  const register=async(fetch:(url:string,init:RequestInit)=>Promise<Response>)=>runAgentelRegistration(identity,registrationOptions(fetch));
  const addTask=()=>store.update(s=>{s.tasks=[task]});
  return {store,vault,site,task,siteId,accountId,taskId,target,identity,article,register,addTask,registrationJournal,publicationJournal,publicationOptions,close:()=>store.close()};
}
function registrationFetch(f:ReturnType<typeof fixture>,onPost?:()=>void){let posts=0,gets=0;return {fetch:async(url:string,init:RequestInit)=>{if(url===`${AGENTEL_API}/agents/register`){posts++;onPost?.();return json({agent:{id:'agent_test-1',slug:f.identity.slug},credential:{key:'agentel_live_test_secret'}},201)}if(url===`${AGENTEL_API}/me`){gets++;return json({agent:{id:'agent_test-1',slug:f.identity.slug}})}throw Error(`unexpected ${url}`)},posts:()=>posts,gets:()=>gets}}

test('registration saves encrypted one-time key, verifies original identity and reuses it after restart',async()=>{
  const f=fixture();try{const remote=registrationFetch(f),first=await f.register(remote.fetch);assert.equal(first.status,'verified');assert.equal(remote.posts(),1);const account=f.store.read().accounts[0];assert.equal(account.status,'registered');assert.equal(account.hasPassword,true);const secret=await f.vault.get(`account:${f.accountId}`),journal=await f.vault.get(`agentel:identity:${f.siteId}`);assert.equal(parseAgentelCredential(secret)?.agentId,'agent_test-1');assert.equal(agentelRegistrationBackupMatches(account,journal,secret),true);assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[`account:${f.accountId}`]:secret!,[`agentel:identity:${f.siteId}`]:journal!}}));const again=await f.register(remote.fetch);assert.equal(again.status,'verified');assert.equal(remote.posts(),1)}finally{f.close()}
});

test('late registration response remains encrypted when site pauses; recovery does GET only',async()=>{
  const f=fixture();try{const remote=registrationFetch(f,()=>f.store.update(s=>{s.sites[0].status='paused'}));const first=await f.register(remote.fetch);assert.equal(first.status,'unknown');assert.equal(remote.posts(),1);assert.equal(remote.gets(),0);assert.equal((await f.registrationJournal.load())?.stage,'opaque');assert.equal(f.store.read().accounts[0].hasPassword,false);f.store.update(s=>{s.sites[0].status='ready'});const recovered=await f.register(remote.fetch);assert.equal(recovered.status,'verified');assert.equal(remote.posts(),1)}finally{f.close()}
});

test('unknown registration transport and revoked authorization never produce a second POST',async()=>{
  const f=fixture();try{let posts=0;const fetch=async()=>{posts++;throw Error('timeout')};assert.equal((await f.register(fetch)).status,'unknown');assert.equal((await f.register(fetch)).status,'unknown');assert.equal(posts,1);assert.equal((await f.registrationJournal.load())?.stage,'sending');const journal=await f.vault.get(`agentel:identity:${f.siteId}`);assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[`agentel:identity:${f.siteId}`]:journal!}}))}finally{f.close()}
});

test('publication journal encrypts response, promotes only after readback, and backup binds original task',async()=>{
  const f=fixture();try{const remote=registrationFetch(f);assert.equal((await f.register(remote.fetch)).status,'verified');f.addTask();let posts=0;const url=`${AGENTEL_ORIGIN}/thread/update_test-1`;
    const fetch=async(path:string,init:RequestInit)=>{if(path===`${AGENTEL_API}/me`)return json({agent:{id:'agent_test-1',slug:f.identity.slug}});
      if(path===`${AGENTEL_API}/agents/agent_test-1/updates`){posts++;return json({update:{id:'update_test-1',agentId:'agent_test-1'}},201)}
      if(path===url)return new Response(`<article class="detail-main"><h1>${f.article.title}</h1><div class="feed-content-thread"><p>Written by an AI assistant for Software Example. I reproduced the integration and recorded the limits. Source: <a href="${f.target}">${f.target}</a>. Disclosure: we maintain Software Example.</p></div></article>`,{headers:{'content-type':'text/html'}});
      if(path===`${AGENTEL_ORIGIN}/robots.txt`)return new Response('User-agent: *\nAllow: /thread/\n');throw Error(`unexpected ${path} ${init.method}`)};
    const credential=parseAgentelCredential(await f.vault.get(`account:${f.accountId}`))!;
    const first=await runAgentelPublication(f.article,credential,f.publicationOptions(fetch));assert.equal(first.status,'verified');assert.equal(posts,1);assert.equal(f.store.read().tasks[0].publicUrl,url);
    const publication=await f.vault.get(`publication:${f.taskId}`),registration=await f.vault.get(`agentel:identity:${f.siteId}`),accountSecret=await f.vault.get(`account:${f.accountId}`);assert.equal(agentelBackupMatches(f.store.read().tasks[0],publication,f.store.read().accounts[0],accountSecret),true);assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[`account:${f.accountId}`]:accountSecret!,[`agentel:identity:${f.siteId}`]:registration!,[`publication:${f.taskId}`]:publication!}}));
    const again=await runAgentelPublication(f.article,credential,f.publicationOptions(fetch));assert.equal(again.status,'verified');assert.equal(posts,1)}finally{f.close()}
});

 test('Controller first task reserves Agentel identity before review, then registers once and queues the same account',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(at)+60_000});const f=fixture();let controller:Controller|undefined;try{
    const source=CHANNELS.find(c=>c.id==='agentel');assert.ok(source);const channel:Channel={...source,enabled:true};
    const policy='Publish original software documentation. Do not create spam, bulk search manipulation, or affiliate link farms.';
    const guidance='AI agents may register and publish original software research notes as updates.';
    channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(channel,[{url:channel.rulesUrl,kind:'content_policy',text:policy,appliesTo:'agentel',applicability:'verified'},{url:'https://agentel.tech/docs',kind:'product_guidance',text:guidance,appliesTo:'agentel',applicability:'verified'}]),{finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'});
    f.addTask();f.store.update(s=>{s.sites[0].articleReviewMode='ai';s.sites[0].analyzedAt=at;s.sites[0].topicsCheckedAt=at;s.sites[0].topics=[{url:f.target,discoveredAt:at}];s.sites[0].qualifications={software:s.sites[0].url};s.settings.autoRun=true;s.settings.articleReviewMode='ai';s.settings.timezone='Asia/Singapore';s.settings.channelOverrides.agentel=true;s.channelTermsCache??={};s.channelTermsCache.agentel=channel.termsCache!;s.tasks[0].status='queued';s.tasks[0].accountId=undefined;s.tasks[0].agentelOriginalPurpose=agentelOriginalPurpose(s.tasks[0])});
    let reviewedAccountId:string|undefined,posts=0;
    const vault={...f.vault,ready:true,available:()=>true,set:async()=>{},delete:async()=>{}} as unknown as Vault;
    controller=new Controller(f.store,vault,'fixture',{channelCatalog:[channel],reviewArticle:async(task,site,source,settings,_ai,_signal,deps)=>{
      reviewedAccountId=deps?.account?.id;return reviewArticleDraft(task,site,source,settings,{json:async()=>({verdict:'pass',reason:'The original software note is independently useful.',citations:[{url:site.url,quote:site.description}],policyAssessment:{useKind:'original_editorial',verdict:'compatible',reason:'One original software research note fits Agentel.',citations:[{url:'https://agentel.tech/docs',quote:guidance,purpose:'hosting_purpose'},{url:source.rulesUrl,quote:'Do not create spam, bulk search manipulation, or affiliate link farms.',purpose:'use_restriction'}]}} as never)},undefined,{account:deps?.account,publicationContext:deps?.publicationContext,fetchHtml:async url=>({url,html:`<main><p>${url===site.url?site.description:url===source.rulesUrl?policy:guidance}</p></main>`})});
    },batch5Dependencies:{fetch:async(url,init)=>{if(url===`${AGENTEL_API}/agents/register`){posts++;return json({agent:{id:'agent_test-1',slug:f.store.read().accounts[0].username},credential:{key:'agentel_live_test_secret'}},201)}if(url===`${AGENTEL_API}/me`)return json({agent:{id:'agent_test-1',slug:f.store.read().accounts[0].username}});throw Error(`unexpected ${init.method} ${url}`)}}});
    controller.runtime.aiReady=true;await controller.tick();const state=f.store.read();assert.equal(reviewedAccountId,state.accounts[0]?.id,JSON.stringify(state.tasks[0]));assert.equal(posts,1,JSON.stringify(state.tasks[0]));assert.equal(state.accounts[0].status,'registered');assert.equal(state.tasks[0].accountId,state.accounts[0].id);assert.equal(state.tasks[0].checkpoint,'agentel_account_ready');assert.equal(articleReviewStillValid(state.tasks[0],state.sites[0],channel,state.settings,state.accounts[0],currentArticlePublicationContext(state.tasks,state.tasks[0])),true);
  }finally{controller?.stop();f.close();t.mock.timers.reset()}
});

async function importedController(){
  const f=fixture(),source=CHANNELS.find(c=>c.id==='agentel');assert.ok(source);const channel:Channel={...source,enabled:true};
  const policy='Publish original software documentation. Do not create spam, bulk search manipulation, or affiliate link farms.';
  const guidance='AI agents may register and publish original software research notes as updates.';
  channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(channel,[{url:channel.rulesUrl,kind:'content_policy',text:policy,appliesTo:'agentel',applicability:'verified'},{url:'https://agentel.tech/docs',kind:'product_guidance',text:guidance,appliesTo:'agentel',applicability:'verified'}]),{finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'});
  const credential={agentId:'agent_test-1',slug:f.identity.slug,apiKey:'agentel_live_test_secret'};let connectionGets=0;
  const account=await connectPublisherToken(f.store,f.vault,{channelId:'agentel',token:credential.apiKey,siteIds:[f.siteId]},{fetch:async(url,init)=>{assert.equal(url,`${AGENTEL_API}/me`);assert.equal(init.method,'GET');connectionGets++;return json({agent:{id:credential.agentId,slug:credential.slug}})}});
  assert.equal(connectionGets,1);const importedSecret=await f.vault.get(`account:${account.id}`);assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[`account:${account.id}`]:importedSecret!}}));f.addTask();f.store.update(state=>{state.tasks[0].accountId=account.id;state.tasks[0].agentelOriginalPurpose=agentelOriginalPurpose(state.tasks[0]);state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides.agentel=true;state.channelTermsCache??={};state.channelTermsCache.agentel=channel.termsCache!});
  const task=f.store.read().tasks[0],review=await reviewArticleDraft(task,f.site,channel,f.store.read().settings,{json:async()=>({verdict:'pass',reason:'The original software note is useful.',citations:[{url:f.site.url,quote:f.site.description}],policyAssessment:{useKind:'original_editorial',verdict:'compatible',reason:'One original note fits the platform.',citations:[{url:'https://agentel.tech/docs',quote:guidance,purpose:'hosting_purpose'},{url:channel.rulesUrl,quote:'Do not create spam, bulk search manipulation, or affiliate link farms.',purpose:'use_restriction'}]}} as never)},undefined,{account,publicationContext:currentArticlePublicationContext([task],task),fetchHtml:async url=>({url,html:`<main><p>${url===f.site.url?f.site.description:url===channel.rulesUrl?policy:guidance}</p></main>`})});
  assert.equal(review.status,'passed',review.reason);f.store.update(state=>{state.tasks[0].articleReview=review});
  const url=`${AGENTEL_ORIGIN}/thread/update_test-1`;let posts=0,publicGets=0,controller:Controller|undefined,onPost:(()=>void)|undefined,loseResponse=false,publicDown=false,publicHidden=false,postStatus=201;
  const fetch=async(path:string,init:RequestInit)=>{if(path===`${AGENTEL_API}/me`)return json({agent:{id:credential.agentId,slug:credential.slug}});
    if(path===`${AGENTEL_API}/agents/${credential.agentId}/updates`&&init.method==='POST'){posts++;onPost?.();if(loseResponse)throw Error('response lost');return json({update:{id:'update_test-1',agentId:credential.agentId}},postStatus)}
    if(path===url&&(publicGets++,publicDown))return new Response('temporarily unavailable',{status:503});
    if(path===url)return new Response(`<article class="detail-main"><h1>${f.article.title}</h1><div class="feed-content-thread"${publicHidden?' hidden':''}><p>Written by an AI assistant for Software Example. I reproduced the integration and recorded the limits. Source: <a href="${f.target}">${f.target}</a>. Disclosure: we maintain Software Example.</p></div></article>`,{headers:{'content-type':'text/html'}});
    if(path===`${AGENTEL_ORIGIN}/robots.txt`)return new Response('User-agent: *\nAllow: /thread/\n');throw Error(`unexpected ${init.method} ${path}`)};
  const start=()=>{controller=new Controller(f.store,{...f.vault,ready:true,available:()=>true,set:async()=>{},delete:async()=>{}} as unknown as Vault,'fixture',{channelCatalog:[channel],batch5Dependencies:{fetch}});f.store.update(state=>{state.tasks[0].status='running'});return (controller as unknown as {context:(task:Task,signal:AbortSignal)=>ExecutionContext}).context(f.store.read().tasks[0],new AbortController().signal)};
  const readOnlyContext=()=>{const task=f.store.read().tasks[0];return (controller as unknown as {publicationContext:(task:Task,signal:AbortSignal)=>ExecutionContext}).publicationContext(task,new AbortController().signal)};
  return {f,channel,account,start,readOnlyContext,url,credential,controller:()=>controller!,posts:()=>posts,publicGets:()=>publicGets,setOnPost:(hook:()=>void)=>{onPost=hook},setLoseResponse:()=>{loseResponse=true},setPublicDown:(value:boolean)=>{publicDown=value},setPublicHidden:(value:boolean)=>{publicHidden=value},setPostStatus:(value:number)=>{postStatus=value},close:()=>{controller?.stop();f.close()}};
}

test('Controller publishes through the imported Agentel identity and preserves encrypted receipt',async()=>{
  const x=await importedController();try{const context=x.start(),result=await runAgentelConnectedTask(context);assert.equal(result.status,'review',JSON.stringify(result));assert.equal(result.publicUrl,x.url);assert.equal(x.posts(),1);assert.equal(x.f.store.read().tasks[0].batch5?.stage,'api_receipt');assert.ok(x.f.store.getCipher(`publication:${x.f.taskId}`));assert.equal(x.f.store.read().accounts.length,1)}finally{x.close()}
});

test('Controller stops Agentel POST after late review revocation and restart stays GET-only',async()=>{
  const x=await importedController();try{const context=x.start(),factory=context.agentelJournalFactory!;context.agentelJournalFactory=(credential,article)=>{const journal=factory(credential,article),save=journal.save.bind(journal);journal.save=async(next,previous)=>{await save(next,previous);if(next.stage==='sending')x.f.store.update(state=>{state.settings.channelOverrides.agentel=false})};return journal};const result=await runAgentelConnectedTask(context);assert.equal(result.reasonCode,'submission_unknown',JSON.stringify(result));assert.equal(x.posts(),0);assert.equal(x.f.store.read().tasks[0].batch5?.stage,'submitting');x.f.store.update(state=>{state.settings.channelOverrides.agentel=true});const restarted=x.start(),again=await runAgentelConnectedTask(restarted);assert.equal(again.reasonCode,'submission_unknown');assert.equal(x.posts(),0)}finally{x.close()}
});

 test('Controller retains late Agentel publish response after pause without promoting or reposting',async()=>{
  const x=await importedController();try{x.setOnPost(()=>x.f.store.update(state=>{state.sites[0].status='paused';state.tasks[0].articleReview=undefined}));const context=x.start(),result=await runAgentelConnectedTask(context);assert.equal(result.reasonCode,'submission_unknown');assert.equal(x.posts(),1);assert.equal((await context.agentelJournalFactory!(parseAgentelCredential(await x.f.vault.get(`account:${x.account.id}`))!,x.f.article).load())?.stage,'opaque');assert.equal(x.f.store.read().tasks[0].publicUrl,undefined);const restarted=x.start(),again=await runAgentelConnectedTask(restarted);assert.equal(again.reasonCode,'submission_unknown');assert.equal(x.posts(),1)}finally{x.close()}
});

 test('Controller treats lost Agentel publish response as GET-only on restart',async()=>{
  const x=await importedController();try{x.setLoseResponse();const context=x.start(),first=await runAgentelConnectedTask(context);assert.equal(first.reasonCode,'submission_unknown');assert.equal(x.posts(),1);const restarted=x.start(),again=await runAgentelConnectedTask(restarted);assert.equal(again.reasonCode,'submission_unknown');assert.equal(x.posts(),1)}finally{x.close()}
});

 test('Agentel purpose remains one software site and invalidates on changed draft',()=>{const f=fixture();try{const source=CHANNELS.find(c=>c.id==='agentel');assert.ok(source);assert.equal(source.enabled,false);assert.equal(agentelSingleArticleCandidate([f.task],f.task,f.site,source),true);assert.equal(agentelSingleArticleCandidate([f.task],f.task,{...f.site,category:'finance'},source),false);assert.equal(agentelSingleArticleCandidate([f.task,{...f.task,id:randomUUID(),siteId:randomUUID()}],f.task,f.site,source),false);f.task.agentelOriginalPurpose=agentelOriginalPurpose(f.task);assert.equal(currentArticlePublicationContext([f.task],f.task).publicationIntent,'single_original_article');const changed={...f.task,draft:{...f.task.draft!,body:f.task.draft!.body+' changed'}};assert.equal(currentArticlePublicationContext([changed],changed).publicationIntent,'unknown')}finally{f.close()}});

test('Agentel backup rejects altered account, agent ID and verified receipt while accepting original imported publication',async()=>{
  const x=await importedController();try{
    const result=await runAgentelConnectedTask(x.start());assert.equal(result.publicUrl,x.url);
    const accountKey=`account:${x.account.id}`,publicationKey=`publication:${x.f.taskId}`;
    const accountSecret=(await x.f.vault.get(accountKey))!,publication=(await x.f.vault.get(publicationKey))!;
    const state=x.f.store.read(),secrets={[accountKey]:accountSecret,[publicationKey]:publication};
    assert.doesNotThrow(()=>validateBackup({state,secrets}));
    const changedAccount=JSON.parse(accountSecret);changedAccount.agentId='agent_other-identity';
    assert.throws(()=>validateBackup({state,secrets:{...secrets,[accountKey]:JSON.stringify(changedAccount)}}));
    const wrongTaskAccount=structuredClone(state);wrongTaskAccount.tasks[0].accountId=randomUUID();
    assert.throws(()=>validateBackup({state:wrongTaskAccount,secrets}));
    const wrongSummaryAccount=structuredClone(state);wrongSummaryAccount.tasks[0].batch5!.accountId=randomUUID();
    assert.throws(()=>validateBackup({state:wrongSummaryAccount,secrets}));
    const wrongReceipt=JSON.parse(publication);const original=JSON.parse(Buffer.from(wrongReceipt.opaque.bodyBase64,'base64').toString());original.update.agentId='agent_other-identity';wrongReceipt.opaque.bodyBase64=Buffer.from(JSON.stringify(original)).toString('base64');
    assert.throws(()=>validateBackup({state,secrets:{...secrets,[publicationKey]:JSON.stringify(wrongReceipt)}}));
    const wrongPath=JSON.parse(publication);wrongPath.opaque.url=`${AGENTEL_API}/agents/agent_other-identity/updates`;
    assert.throws(()=>validateBackup({state,secrets:{...secrets,[publicationKey]:JSON.stringify(wrongPath)}}));
    const wrongPublic=structuredClone(state);wrongPublic.tasks[0].publicUrl=`${AGENTEL_ORIGIN}/thread/update_other-identity`;wrongPublic.tasks[0].batch5!.publicUrl=wrongPublic.tasks[0].publicUrl;
    assert.throws(()=>validateBackup({state:wrongPublic,secrets}));
  }finally{x.close()}
});

test('Agentel published receipt survives backup and read-only reconciliation',async()=>{
  const x=await importedController();try{
    const result=await runAgentelConnectedTask(x.start());assert.equal(result.publicUrl,x.url);assert.equal(x.posts(),1);
    x.f.store.update(state=>{state.tasks[0].batch5!.stage='published';state.tasks[0].checkpoint='batch5_published'});
    const accountKey=`account:${x.account.id}`,publicationKey=`publication:${x.f.taskId}`;
    const secrets={[accountKey]:(await x.f.vault.get(accountKey))!,[publicationKey]:(await x.f.vault.get(publicationKey))!};
    assert.doesNotThrow(()=>validateBackup({state:x.f.store.read(),secrets}));
    const reconciled=await reconcileAgentelConnectedTask(x.start());assert.equal(reconciled.status,'found');assert.equal(x.posts(),1);
  }finally{x.close()}
});

test('Agentel unknown publication backup retains the original account and cannot authorize a repost',async()=>{
  const x=await importedController();try{x.setLoseResponse();const first=await runAgentelConnectedTask(x.start());assert.equal(first.reasonCode,'submission_unknown');
    const accountKey=`account:${x.account.id}`,publicationKey=`publication:${x.f.taskId}`;
    const secrets={[accountKey]:(await x.f.vault.get(accountKey))!,[publicationKey]:(await x.f.vault.get(publicationKey))!};
    assert.doesNotThrow(()=>validateBackup({state:x.f.store.read(),secrets}));
    const again=await runAgentelConnectedTask(x.start());assert.equal(again.reasonCode,'submission_unknown');assert.equal(x.posts(),1);
  }finally{x.close()}
});

/** Publish once so the original response is saved, then leave the task as a restart would find it. */
async function savedResponse(x:Awaited<ReturnType<typeof importedController>>){
  x.setPublicDown(true);const first=await runAgentelConnectedTask(x.start());assert.equal(first.reasonCode,'submission_unknown',JSON.stringify(first));assert.equal(x.posts(),1);
  const journal=x.start().agentelJournalFactory!(x.credential,x.f.article);assert.equal((await journal.load())?.stage,'opaque');assert.equal(x.f.store.read().tasks[0].publicUrl,undefined);
  x.f.store.update(state=>{state.tasks[0].status='review'});return journal;
}

test('restart recovery parses the saved response, GETs the page and promotes atomically without a POST',async()=>{
  const x=await importedController();try{const journal=await savedResponse(x);x.setPublicDown(false);
    const found=await reconcileAgentelConnectedTask(x.readOnlyContext());assert.deepEqual([found.status,found.status==='found'&&found.publicUrl],['found',x.url]);assert.equal(x.posts(),1);
    const stored=x.f.store.read().tasks[0];assert.equal((await journal.load())?.stage,'verified');assert.equal(stored.publicUrl,x.url);assert.equal(stored.batch5?.stage,'api_receipt');assert.equal(stored.batch5?.publicUrl,x.url);assert.equal(stored.status,'review');
    assert.deepEqual(found.status==='found'&&found.batch5,stored.batch5);
    const accountKey=`account:${x.account.id}`,publicationKey=`publication:${x.f.taskId}`,secrets={[accountKey]:(await x.f.vault.get(accountKey))!,[publicationKey]:(await x.f.vault.get(publicationKey))!};
    assert.doesNotThrow(()=>validateBackup({state:x.f.store.read(),secrets}));
    const again=await reconcileAgentelConnectedTask(x.readOnlyContext());assert.equal(again.status,'found');assert.equal(x.posts(),1);
  }finally{x.close()}
});

test('an unreachable first public page stays unknown with the saved response, then recovers on a later GET',async()=>{
  const x=await importedController();try{const journal=await savedResponse(x),gets=x.publicGets();
    assert.equal((await reconcileAgentelConnectedTask(x.readOnlyContext())).status,'unknown');assert.equal(x.publicGets(),gets+1);assert.equal(x.posts(),1);assert.equal((await journal.load())?.stage,'opaque');assert.equal(x.f.store.read().tasks[0].publicUrl,undefined);
    x.setPublicDown(false);assert.equal((await reconcileAgentelConnectedTask(x.readOnlyContext())).status,'found');assert.equal(x.posts(),1);assert.equal((await journal.load())?.stage,'verified');
  }finally{x.close()}
});

test('the scheduler recovers a saved response on its reconcile round without sending again',async()=>{
  const x=await importedController();try{await savedResponse(x);x.setPublicDown(false);const controller=x.controller();
    controller.runtime.aiReady=false;await controller.tick();
    const task=x.f.store.read().tasks[0];assert.equal(x.posts(),1,JSON.stringify(task));assert.equal(task.publicUrl,x.url,JSON.stringify(task));assert.equal(task.reconcileAttempts,1);assert.equal(task.batch5?.stage,'published');assert.equal(task.linkCheck,'found');
  }finally{x.close()}
});

test('recovery leaves an unproved response, a hidden page and revoked ownership unknown with no POST',async()=>{
  const failed=await importedController();try{failed.setPostStatus(500);const first=await runAgentelConnectedTask(failed.start());assert.equal(first.reasonCode,'submission_unknown',JSON.stringify(first));const gets=failed.publicGets();
    failed.f.store.update(state=>{state.tasks[0].status='review'});assert.equal((await reconcileAgentelConnectedTask(failed.readOnlyContext())).status,'unknown');assert.equal(failed.posts(),1);assert.equal(failed.publicGets(),gets);
    assert.equal((await failed.start().agentelJournalFactory!(failed.credential,failed.f.article).load())?.stage,'opaque');
  }finally{failed.close()}
  const lost=await importedController();try{lost.setLoseResponse();await runAgentelConnectedTask(lost.start());lost.f.store.update(state=>{state.tasks[0].status='review'});assert.equal((await reconcileAgentelConnectedTask(lost.readOnlyContext())).status,'unknown');assert.equal(lost.posts(),1);assert.equal(lost.f.store.read().tasks[0].batch5?.stage,'submitting')}finally{lost.close()}
  const hidden=await importedController();try{await savedResponse(hidden);hidden.setPublicDown(false);hidden.setPublicHidden(true);
    assert.equal((await reconcileAgentelConnectedTask(hidden.readOnlyContext())).status,'unknown');assert.equal(hidden.posts(),1);assert.equal(hidden.f.store.read().tasks[0].publicUrl,undefined);
  }finally{hidden.close()}
  for(const revoke of [(state:ReturnType<Store['read']>)=>{state.settings.autoRun=false},(state:ReturnType<Store['read']>)=>{state.sites[0].status='paused'},(state:ReturnType<Store['read']>)=>{state.tasks[0].status='skipped'},(state:ReturnType<Store['read']>)=>{state.settings.channelOverrides.agentel=false}]){
    const x=await importedController();try{await savedResponse(x);x.setPublicDown(false);const context=x.readOnlyContext();x.f.store.update(revoke);
      assert.equal((await reconcileAgentelConnectedTask(context)).status,'unknown');assert.equal(x.posts(),1);assert.equal(x.f.store.read().tasks[0].publicUrl,undefined);
      assert.equal((await context.agentelJournalFactory!(x.credential,x.f.article).load())?.stage,'opaque');
    }finally{x.close()}
  }
});

test('recovery checks the frozen original article, so a later draft edit changes nothing that was published',async()=>{
  const x=await importedController();try{await savedResponse(x);x.setPublicDown(false);const frozen=x.f.store.read().tasks[0].publicationSnapshot;assert.ok(frozen);
    x.f.store.update(state=>{state.tasks[0].draft={...state.tasks[0].draft!,body:state.tasks[0].draft!.body+' Changed.'}});
    assert.equal((await reconcileAgentelConnectedTask(x.readOnlyContext())).status,'found');assert.equal(x.posts(),1);assert.deepEqual(x.f.store.read().tasks[0].publicationSnapshot,frozen);
  }finally{x.close()}
});

test('a reserved publication is never dispatched from the read-only reconcile path',async()=>{
  const x=await importedController();try{x.start();
    const context=x.readOnlyContext(),journal=context.agentelJournalFactory!(x.credential,x.f.article);
    assert.equal((await reconcileAgentelConnectedTask(context)).status,'unknown');assert.equal(x.posts(),0);assert.equal(await journal.load(),undefined);
  }finally{x.close()}
});

test('a registered Agentel identity can disconnect and restore, but an unresolved one must keep its binding',async()=>{
  const f=fixture();try{const remote=registrationFetch(f);assert.equal((await f.register(remote.fetch)).status,'verified');
    const accountKey=`account:${f.accountId}`,journalKey=`agentel:identity:${f.siteId}`,secrets={[accountKey]:(await f.vault.get(accountKey))!,[journalKey]:(await f.vault.get(journalKey))!};
    f.store.update(state=>unbindAccount(state,f.accountId,f.siteId,'agentel'));assert.equal(f.store.read().accountBindings.length,0);
    assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets}));
    const wrong=structuredClone(f.store.read()),other=randomUUID();wrong.sites.push({...f.site,id:other,domain:'other.example.org',url:'https://other.example.org/'});wrong.accountBindings.push({id:randomUUID(),siteId:other,channelId:'agentel',accountId:f.accountId,createdAt:at,updatedAt:at});
    assert.throws(()=>validateBackup({state:wrong,secrets}),/Agentel/);
  }finally{f.close()}
  const pending=fixture();try{const fetch=async()=>{throw Error('timeout')};await pending.register(fetch);
    assert.throws(()=>pending.store.update(state=>unbindAccount(state,pending.accountId,pending.siteId,'agentel')));
  }finally{pending.close()}
});
