import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Store} from '../src/main/store';
import {CHANNELS} from '../src/integrations/catalog';
import {clawprintOriginalPurpose,currentArticlePublicationContext} from '../src/main/article-publication-context';
import {buildChannelTermsCache,reviewedChannelTermsCache} from '../src/main/article-evidence';
import {reviewArticleDraft} from '../src/main/article-review';
import {onboardClawprintAccount,parseClawprintRegistrationJournal,reserveClawprintAccount} from '../src/main/clawprint-onboarding';
import {bindAccount,channelExecutionReadiness,unbindAccount} from '../src/main/account-bindings';
import {validateBackup} from '../src/main/backup-validation';
import {Controller} from '../src/main/controller';
import type {Vault} from '../src/main/vault';
import {connectPublisherToken} from '../src/main/publisher-token-management';
import type {Channel,Site,Task} from '../src/shared/types';

const at='2026-10-29T12:00:00.000Z',about='https://clawprint.org/about';
const invitation='Its contributors are AI agents. They publish poems, fiction, visual art, essays, field notes, and accounts of work in progress. Some build software.';
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function setup(){
  const store=new Store(':memory:');
  const site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Software Example',description:'Software release notes',email:'owner@example.org',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:at,topics:[{url:'https://software.example.org/releases',discoveredAt:at}]};
  const template=CHANNELS.find(value=>value.id==='clawprint');assert.ok(template);
  const channel:Channel={...template,termsCache:reviewedChannelTermsCache(buildChannelTermsCache(template,[{url:about,kind:'content_policy',text:invitation,appliesTo:'clawprint',applicability:'verified'}]),{finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'})};
  const task:Task={id:randomUUID(),siteId:site.id,channelId:'clawprint',sourceDomain:'clawprint.org',status:'running',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'test',draftRevision:1,topicUrl:'https://software.example.org/releases',draft:{title:'Recovering after an uncertain publish response',description:'A software field note.',body:'Check the saved intent and remote readback before another write. See [project releases](https://software.example.org/releases). Disclosure: this is our Software Example project.'}};
  task.clawprintOriginalPurpose=clawprintOriginalPurpose(task);
  store.update(state=>{state.sites=[site];state.tasks=[task]});
  const vault={get:async(key:string)=>{const value=store.getCipher(key);return value?Buffer.from(value.slice(7),'base64').toString('utf8'):undefined},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'cipher:'+Buffer.from(value).toString('base64')]))};
  // A new signup is closed in production; this flag only seeds the reserved state an earlier build could leave for recovery.
  const options={taskId:task.id,channel,signal:new AbortController().signal,assertAuthorized:()=>{},now:()=>new Date(at),allowNewRegistration:true};
  return {store,site,channel,task,vault,options};
}
async function approve(f:ReturnType<typeof setup>){
  const task=f.store.read().tasks[0],account=f.store.read().accounts[0],site=f.store.read().sites[0];
  const output=await reviewArticleDraft(task,site,f.channel,f.store.read().settings,{json:async()=>({verdict:'pass',reason:'Original operational field note',citations:[{url:site.url,quote:site.description}],policyAssessment:{useKind:'original_editorial',verdict:'compatible',reason:'The AI field note fits the editorial invitation.',citations:[{url:about,quote:invitation,purpose:'editorial_scope'}]}} as never)},undefined,{account,publicationContext:currentArticlePublicationContext(f.store.read().tasks,task),fetchHtml:async url=>({url,html:`<main><p>${url===about?invitation:site.description}</p></main>`})});
  assert.equal(output.status,'passed',output.reason);
  f.store.update(state=>{state.tasks[0].articleReview=output});
}

test('Clawprint reserves the same identity before review, then encrypts one registration and reuses it',async()=>{
  const f=setup();try{
    assert.equal(channelExecutionReadiness(f.store.read(),f.site.id,f.channel).kind,'handoff_required');
    const reserved=await reserveClawprintAccount(f.store,f.vault,f.options);assert.equal(reserved.status,'pending');
    const account=f.store.read().accounts[0];assert.equal(account.registrationAttempts,1);assert.equal(f.store.read().tasks[0].accountId,account.id);
    assert.equal(channelExecutionReadiness(f.store.read(),f.site.id,f.channel,account.id).kind,'autocreate');
    await approve(f);
    const calls:string[]=[];
    const result=await onboardClawprintAccount(f.store,f.vault,{...f.options,dependencies:{fetch:async(url,init)=>{calls.push(`${init.method} ${url}`);return url.endsWith('/api/register')?json({name:account.username,user_id:19,api_key:'clawprint-test-key-123456789'}):json({name:account.username,user_id:19})}}});
    assert.deepEqual(result,{status:'ready',accountId:account.id,created:true});assert.deepEqual(calls,['POST https://clawprint.org/api/register','GET https://clawprint.org/api/me']);
    const saved=f.store.read().accounts[0];assert.equal(saved.status,'registered');assert.equal(saved.hasPassword,true);assert.equal(saved.ownerSiteId,f.site.id);
    assert.equal(channelExecutionReadiness(f.store.read(),f.site.id,f.channel,account.id).kind,'ready');
    assert.ok(!f.store.getCipher(`account:${account.id}`)?.includes('clawprint-test-key'));
    assert.ok(!f.store.getCipher(`clawprint:identity:${f.site.id}`)?.includes('clawprint-test-key'));
    const secrets={[`clawprint:identity:${f.site.id}`]:(await f.vault.get(`clawprint:identity:${f.site.id}`))!,[`account:${account.id}`]:(await f.vault.get(`account:${account.id}`))!};
    assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets}));
    assert.throws(()=>validateBackup({state:f.store.read(),secrets:{[`account:${account.id}`]:secrets[`account:${account.id}`]}}));
    assert.throws(()=>validateBackup({state:f.store.read(),secrets:{...secrets,[`account:${account.id}`]:'different-token-123456789'}}));
    const again=await onboardClawprintAccount(f.store,f.vault,{...f.options,dependencies:{fetch:async()=>{throw Error('must not fetch')}}});
    assert.deepEqual(again,{status:'ready',accountId:account.id,created:false});
  }finally{f.store.close()}
});

test('an already connected owner account is reused without creating a registration journal',async()=>{
  const f=setup();try{
    const id=randomUUID();f.store.update(state=>{state.accounts.push({id,channelId:'clawprint',email:'',username:'ExistingWriter',ownerSiteId:f.site.id,createdAt:at,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token',registrationAttempts:0});state.accountBindings.push({id:randomUUID(),siteId:f.site.id,channelId:'clawprint',accountId:id,createdAt:at,updatedAt:at});state.tasks[0].accountId=id});
    assert.equal(channelExecutionReadiness(f.store.read(),f.site.id,f.channel,id).kind,'ready');
    assert.deepEqual(await reserveClawprintAccount(f.store,f.vault,f.options),{status:'ready',accountId:id,created:false});
    assert.equal(f.store.getCipher(`clawprint:identity:${f.site.id}`),undefined);
  }finally{f.store.close()}
});

test('token connection cannot replace an unresolved registration, but can reconnect the completed identity',async()=>{
  const f=setup();try{
    await reserveClawprintAccount(f.store,f.vault,f.options);let probes=0;
    await assert.rejects(connectPublisherToken(f.store,f.vault,{channelId:'clawprint',token:'replacement-token-123456789',siteIds:[f.site.id]},{fetch:async()=>{probes++;throw Error('unexpected read')}}),/原注册结果未确认/);
    assert.equal(probes,0);await approve(f);const account=f.store.read().accounts[0];
    assert.equal((await onboardClawprintAccount(f.store,f.vault,{...f.options,dependencies:{fetch:async url=>url.endsWith('/api/register')?json({name:account.username,user_id:41,api_key:'clawprint-test-key-123456789'}):json({name:account.username,user_id:41})}})).status,'ready');
    const connected=await connectPublisherToken(f.store,f.vault,{channelId:'clawprint',token:'replacement-token-123456789',siteIds:[f.site.id],accountId:account.id},{fetch:async()=>{probes++;return json({name:account.username,user_id:41})}});
    assert.equal(probes,1);assert.equal(connected.id,account.id);assert.equal(connected.source,'imported');
    const secrets={[`clawprint:identity:${f.site.id}`]:(await f.vault.get(`clawprint:identity:${f.site.id}`))!,[`account:${account.id}`]:(await f.vault.get(`account:${account.id}`))!};
    assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets}));
  }finally{f.store.close()}
});

test('uncertain registration response keeps the sending guard and never posts twice',async()=>{
  const f=setup();try{
    await reserveClawprintAccount(f.store,f.vault,f.options);await approve(f);let posts=0;
    const deps={fetch:async()=>{posts++;throw Error('connection reset')}};
    assert.equal((await onboardClawprintAccount(f.store,f.vault,{...f.options,dependencies:deps})).status,'pending');
    assert.equal((await onboardClawprintAccount(f.store,f.vault,{...f.options,dependencies:deps})).status,'pending');
    assert.equal(posts,1);assert.equal(parseClawprintRegistrationJournal(await f.vault.get(`clawprint:identity:${f.site.id}`))?.stage,'sending');
    assert.throws(()=>f.store.update(state=>unbindAccount(state,state.accounts[0].id,f.site.id,'clawprint')));
    assert.throws(()=>f.store.update(state=>{state.accounts.push({id:randomUUID(),channelId:'clawprint',email:'',username:'replacement',createdAt:at,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token'});bindAccount(state,state.accounts.at(-1)!.id,f.site.id,f.channel)}));
  }finally{f.store.close()}
});

test('encrypted opaque response recovers with GET after restart without another registration',async()=>{
  const f=setup();try{
    await reserveClawprintAccount(f.store,f.vault,f.options);await approve(f);const name=f.store.read().accounts[0].username;let posts=0,gets=0;
    const first=await onboardClawprintAccount(f.store,f.vault,{...f.options,dependencies:{fetch:async(url)=>{if(url.endsWith('/api/register')){posts++;return json({name,user_id:23,api_key:'clawprint-test-key-123456789'})}gets++;throw Error('offline')}}});
    assert.equal(first.status,'pending');assert.equal(parseClawprintRegistrationJournal(await f.vault.get(`clawprint:identity:${f.site.id}`))?.stage,'opaque');
    const resumed=await onboardClawprintAccount(f.store,f.vault,{...f.options,dependencies:{fetch:async(url)=>{assert.equal(url,'https://clawprint.org/api/me');gets++;return json({name,user_id:23})}}});
    assert.equal(resumed.status,'ready');assert.equal(posts,1);assert.equal(gets,2);assert.equal(f.store.read().accounts[0].status,'registered');
  }finally{f.store.close()}
});

test('a pause after registration response still encrypts the one-time key before any readback',async()=>{
  const f=setup();try{
    await reserveClawprintAccount(f.store,f.vault,f.options);await approve(f);
    const account=f.store.read().accounts[0];let posts=0,gets=0;
    const result=await onboardClawprintAccount(f.store,f.vault,{...f.options,dependencies:{fetch:async(url)=>{
      if(url.endsWith('/api/register')){posts++;f.store.update(state=>{state.sites[0].status='paused';state.tasks[0].articleReview=undefined});return json({name:account.username,user_id:53,api_key:'clawprint-paused-key-123456789'})}
      gets++;throw Error('readback must wait for authorization');
    }}});
    assert.equal(result.status,'pending');assert.equal(posts,1);assert.equal(gets,0);
    const raw=await f.vault.get(`clawprint:identity:${f.site.id}`),journal=parseClawprintRegistrationJournal(raw);
    assert.equal(journal?.stage,'opaque');assert.ok(journal?.opaque);assert.ok(!f.store.getCipher(`clawprint:identity:${f.site.id}`)?.includes('clawprint-paused-key'));
    f.store.update(state=>{state.sites[0].status='ready'});await approve(f);
    const resumed=await onboardClawprintAccount(f.store,f.vault,{...f.options,dependencies:{fetch:async url=>{assert.equal(url,'https://clawprint.org/api/me');gets++;return json({name:account.username,user_id:53})}}});
    assert.equal(resumed.status,'ready');assert.equal(posts,1);assert.equal(gets,1);
  }finally{f.store.close()}
});

test('controller task path registers after review and queues the same identity for publication',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(at)+60_000});
  const f=setup();let controller:Controller|undefined;try{
    f.store.update(state=>{state.sites[0].articleReviewMode='ai';state.sites[0].analyzedAt=at;state.sites[0].topicsCheckedAt=at;state.sites[0].qualifications={software:state.sites[0].url};state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides.clawprint=true;state.channelTermsCache??={};state.channelTermsCache.clawprint=f.channel.termsCache!});
    await reserveClawprintAccount(f.store,f.vault,f.options);await approve(f);
    f.store.update(state=>{state.tasks[0].status='queued'});
    const account=f.store.read().accounts[0],requests:string[]=[];
    controller=new Controller(f.store,{...f.vault,available:()=>true,ready:true,set:async()=>{},delete:async()=>{}} as unknown as Vault,'fixture',{channelCatalog:[f.channel],batch5Dependencies:{fetch:async(url,init)=>{requests.push(`${init.method} ${url}`);return url.endsWith('/api/register')?json({name:account.username,user_id:31,api_key:'clawprint-test-key-123456789'}):json({name:account.username,user_id:31})}}});
    controller.runtime.aiReady=true;await controller.tick();
    const after=f.store.read();assert.equal(after.accounts[0].status,'registered',JSON.stringify(after.tasks[0]));
    assert.equal(after.tasks[0].accountId,account.id);assert.equal(after.tasks[0].checkpoint,'clawprint_account_ready');
    assert.deepEqual(requests,['POST https://clawprint.org/api/register','GET https://clawprint.org/api/me']);
  }finally{controller?.stop();f.store.close();t.mock.timers.reset()}
});

test('a site without a connected key is not offered Clawprint and cannot start a signup',async()=>{
  const f=setup();try{
    const {allowNewRegistration:_closed,...production}=f.options;let requests=0;
    assert.equal(channelExecutionReadiness(f.store.read(),f.site.id,f.channel).kind,'handoff_required');
    const reserved=await reserveClawprintAccount(f.store,f.vault,production);assert.equal(reserved.status,'blocked');
    const onboarded=await onboardClawprintAccount(f.store,f.vault,{...production,dependencies:{fetch:async()=>{requests++;throw Error('must not fetch')}}});assert.equal(onboarded.status,'blocked');
    assert.equal(requests,0);assert.equal(f.store.read().accounts.length,0);assert.equal(f.store.read().accountBindings.length,0);assert.equal(f.store.getCipher(`clawprint:identity:${f.site.id}`),undefined);
    assert.doesNotMatch(readFileSync('src/main/controller.ts','utf8'),/allowNewRegistration/);
  }finally{f.store.close()}
});

test('a pending generated identity keeps its recovery path after new signups close',async()=>{
  const f=setup();try{
    await reserveClawprintAccount(f.store,f.vault,f.options);await approve(f);const account=f.store.read().accounts[0],{allowNewRegistration:_closed,...production}=f.options;
    assert.equal(channelExecutionReadiness(f.store.read(),f.site.id,f.channel,account.id).kind,'autocreate');
    const result=await onboardClawprintAccount(f.store,f.vault,{...production,dependencies:{fetch:async url=>url.endsWith('/api/register')?json({name:account.username,user_id:71,api_key:'clawprint-test-key-123456789'}):json({name:account.username,user_id:71})}});
    assert.deepEqual(result,{status:'ready',accountId:account.id,created:true});
  }finally{f.store.close()}
});

test('a disconnected Clawprint key is not selected, and a finished registration still restores',async()=>{
  const f=setup();try{
    await reserveClawprintAccount(f.store,f.vault,f.options);await approve(f);const account=f.store.read().accounts[0];
    await onboardClawprintAccount(f.store,f.vault,{...f.options,dependencies:{fetch:async url=>url.endsWith('/api/register')?json({name:account.username,user_id:83,api_key:'clawprint-test-key-123456789'}):json({name:account.username,user_id:83})}});
    f.store.update(state=>unbindAccount(state,account.id,f.site.id,'clawprint'));
    assert.equal(channelExecutionReadiness(f.store.read(),f.site.id,f.channel,account.id).kind,'handoff_required');
    assert.equal(channelExecutionReadiness(f.store.read(),f.site.id,f.channel).kind,'handoff_required');
    assert.equal((await reserveClawprintAccount(f.store,f.vault,f.options)).status,'blocked');
    const secrets={[`clawprint:identity:${f.site.id}`]:(await f.vault.get(`clawprint:identity:${f.site.id}`))!,[`account:${account.id}`]:(await f.vault.get(`account:${account.id}`))!};
    assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets}));
    const wrong=structuredClone(f.store.read()),other=randomUUID();wrong.sites.push({...f.site,id:other,domain:'other.example.org',url:'https://other.example.org/'});wrong.accountBindings.push({id:randomUUID(),siteId:other,channelId:'clawprint',accountId:account.id,createdAt:at,updatedAt:at});
    assert.throws(()=>validateBackup({state:wrong,secrets}),/Clawprint/);
  }finally{f.store.close()}
});

test('controller stops a task without a connected key before any review or signup',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(at)+60_000});
  const f=setup();let controller:Controller|undefined;try{
    f.store.update(state=>{state.sites[0].articleReviewMode='ai';state.sites[0].analyzedAt=at;state.sites[0].topicsCheckedAt=at;state.sites[0].qualifications={software:state.sites[0].url};state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides.clawprint=true;state.channelTermsCache??={};state.channelTermsCache.clawprint=f.channel.termsCache!;state.tasks[0].status='queued'});
    let reviews=0,requests=0;
    controller=new Controller(f.store,{...f.vault,available:()=>true,ready:true,set:async()=>{},delete:async()=>{}} as unknown as Vault,'fixture',{channelCatalog:[f.channel],reviewArticle:async()=>{reviews++;throw Error('must not review')},batch5Dependencies:{fetch:async()=>{requests++;throw Error('must not fetch')}}});
    controller.runtime.aiReady=true;await controller.tick();
    const state=f.store.read();assert.equal(reviews,0,JSON.stringify(state.tasks[0]));assert.equal(requests,0);assert.equal(state.accounts.length,0);assert.equal(state.accountBindings.length,0);
    assert.equal(f.store.getCipher(`clawprint:identity:${f.site.id}`),undefined);assert.equal(state.tasks[0].status,'needs_input',JSON.stringify(state.tasks[0]));assert.equal(state.tasks[0].submittedAt,undefined);
  }finally{controller?.stop();f.store.close();t.mock.timers.reset()}
});
