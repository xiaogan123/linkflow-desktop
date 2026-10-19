import {pinPublicationFixtures} from './helpers/publication-snapshot';
import {beforeEach,type TestContext} from 'node:test';
beforeEach(t=>{if(["the real Controller registry performs one create, saves the per-page key, verifies, and a restart never re-POSTs"].includes(t.name))(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse(now)+60000});});
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {CHANNELS} from '../src/integrations/catalog';
import {createHtmlAppSite,type HtmlAppIntent,type HtmlAppPersistence} from '../src/integrations/html-app';
import {htmlAppPublisherTesting,reconcileHtmlAppTask,runHtmlAppTask,verifyHtmlAppPublication} from '../src/integrations/html-app-publisher';
import {publisherFor} from '../src/integrations/publishers';
import {validateBackup} from '../src/main/backup-validation';
import {acceptHtmlAppPublicNotice,createHtmlAppPublicationPersistence,htmlAppTaskIdentity,parseHtmlAppPublicationSecret} from '../src/main/html-app-publication';
import {Controller} from '../src/main/controller';
import {Store,emptyState} from '../src/main/store';
import {saveSettingsAtomic} from '../src/main/settings-service';
import {HTML_APP_PUBLIC_NOTICE_ACKNOWLEDGEMENT,HTML_APP_TERMS_URL,htmlAppPublicNoticeAccepted} from '../src/shared/html-app-notice';
import type {Vault} from '../src/main/vault';
import type {ExecutionContext,Site,Task} from '../src/shared/types';

const now='2026-10-11T10:00:00.000Z',taskId='11111111-1111-4111-8111-111111111111',siteId='22222222-2222-4222-8222-222222222222';
const remoteId='testabcd',publicUrl=`https://${remoteId}.ht-ml.app/`,updateKey='secret_update_key_123456789';
const draft={title:'Safe release workflow',description:'A practical guide',body:'Use a frozen build and compare checksums against the [official release](https://example.com/releases).'};
function site():Site{return {id:siteId,domain:'example.com',url:'https://example.com/',email:'local@example.test',name:'Example software',description:'Developer software',category:'software',language:'en',monthlyTarget:1,articleReviewMode:'manual',qualifications:{software:'https://example.com/product',developer:'https://example.com/releases'},status:'ready',createdAt:now,analyzedAt:now,topicsCheckedAt:new Date().toISOString(),topics:[{url:'https://example.com/releases',discoveredAt:now}]}}
function task(extra:Partial<Task>={}):Task{return {id:taskId,siteId,channelId:'html-app',sourceDomain:'ht-ml.app',status:'running',createdAt:now,scheduledAt:now,updatedAt:now,attempts:1,message:'fixture',topicUrl:'https://example.com/releases',draft,articleApprovedAt:now,...extra}}
function channel(){const value=CHANNELS.find(item=>item.id==='html-app');assert.ok(value);return {...value,enabled:true}}
function context(value:Task,persistence?:HtmlAppPersistence):ExecutionContext{return {site:site(),channel:channel(),task:value,settings:{provider:'codex',codexPath:'codex',model:'',articleReviewMode:'manual',apiBase:'https://api.openai.com/v1',hasApiKey:false,autoRun:true,launchAtLogin:false,notify:false,timezone:'UTC',maxAttempts:3,maxSteps:18,dailyAiLimit:40,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},secrets:{get:async()=>undefined,set:async()=>{},delete:async()=>{}},ai:{json:async()=>{throw Error('unused')}},signal:new AbortController().signal,...(persistence?{htmlAppPersistence:persistence}:{}),getAccount:()=>undefined,saveAccount:async()=>{},checkpoint:()=>{},log:()=>{}}}
function success(){return new Response(JSON.stringify({site_id:remoteId,update_key:updateKey,status:'active',url:publicUrl}),{status:200,headers:{'content-type':'application/json'}})}
function memory(){const intents:HtmlAppIntent[]=[];let authorized=true,created:unknown;const value:HtmlAppPersistence={persistIntent:async v=>{intents.push(v)},assertReadyToSubmit:()=>{if(!authorized)throw Error('revoked');return true},persistCreatedAtomically:async v=>{created=v}};return {value,intents,setAuthorized:(v:boolean)=>{authorized=v},created:()=>created}}

test('accepted catalog registers a bounded built-in publisher and keeps public terms',()=>{const stored=CHANNELS.find(value=>value.id==='html-app');assert.ok(stored);assert.equal(stored.enabled,true);assert.equal(stored.accountRequired,false);assert.equal(stored.automation,'api');assert.equal(stored.rulesUrl,'https://ht-ml.app/terms');assert.match(stored.notes,/公开|public/);assert.ok(publisherFor(stored))});

test('deterministic HTML rejects raw HTML, images, and drafts without the reviewed native link',()=>{const good=htmlAppTaskIdentity(task(),site());assert.ok(good);assert.doesNotMatch(good.html,/<script|<img|https?:\/\/[^"']+\.(?:png|jpe?g|gif|webp)/i);for(const body of ['<script>alert(1)</script>\n\n[release](https://example.com/releases)','![remote](https://example.com/image.png)\n\n[release](https://example.com/releases)','Useful text without the reviewed link'])assert.equal(htmlAppTaskIdentity(task({draft:{...draft,body}}),site()),undefined)});

test('ht-ml preserves a canonical public RFC section citation without weakening the exact target link',()=>{const rfc='https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods',value=htmlAppTaskIdentity(task({draft:{...draft,body:`Read the [idempotency definition](${rfc}) and use the [official release](https://example.com/releases).`}}),site());assert.ok(value);assert.match(value.html,/href="https:\/\/www\.rfc-editor\.org\/rfc\/rfc9110\.html#name-idempotent-methods"/);assert.match(value.html,/href="https:\/\/example\.com\/releases"/);assert.equal(htmlAppTaskIdentity(task({draft:{...draft,body:'Only [the RFC](https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods).'}}),site()),undefined)});

test('one authorized create sends exact body once and never exposes update_key',async()=>{const store=memory(),identity=htmlAppTaskIdentity(task(),site());assert.ok(identity);const calls:Array<{url:string;init:RequestInit}>=[];const result=await createHtmlAppSite({operationId:'html_app_operation_1',reviewed:true,html:identity.html},store.value,{now:()=>new Date(now),fetch:async(url,init)=>{calls.push({url,init});return success()}});assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.ht-ml.app/v1/sites');assert.equal(calls[0].init.method,'POST');assert.equal(calls[0].init.redirect,'manual');assert.equal(calls[0].init.credentials,'omit');assert.deepEqual(JSON.parse(String(calls[0].init.body)),{html_content:identity.html});assert.equal(result.status,'created');assert.equal(JSON.stringify(result).includes(updateKey),false);assert.ok(store.created())});

test('official optional message is accepted without relaxing identity or active URL binding',async()=>{
  const identity=htmlAppTaskIdentity(task(),site())!;
  for(const message of [null,'Site created successfully']){
    const saved=memory();const result=await createHtmlAppSite({operationId:'html_app_contract_1',reviewed:true,html:identity.html},saved.value,{fetch:async()=>new Response(JSON.stringify({site_id:remoteId,update_key:updateKey,status:'active',url:publicUrl,message}),{status:200,headers:{'content-type':'application/json'}})});
    assert.equal(result.status,'created');assert.ok(saved.created());
  }
  for(const extra of [{message:{}},{message:'x'.repeat(2049)},{unexpected:true},{url:null},{status:'pending_assets'}]){
    const saved=memory();const result=await createHtmlAppSite({operationId:'html_app_contract_2',reviewed:true,html:identity.html},saved.value,{fetch:async()=>new Response(JSON.stringify({site_id:remoteId,update_key:updateKey,status:'active',url:publicUrl,...extra}),{status:200,headers:{'content-type':'application/json'}})});
    assert.equal(result.status,'unknown');assert.equal(saved.created(),undefined);
  }
});

test('prior intent, failed intent CAS, and revoked pre-write authorization all make zero POSTs',async()=>{const identity=htmlAppTaskIdentity(task(),site());assert.ok(identity);const prior={operationId:'html_app_prior_1',sourceHash:'a'.repeat(64),requestHash:'b'.repeat(64),createdAt:now};let calls=0;const blocked=await createHtmlAppSite({operationId:'html_app_operation_1',reviewed:true,html:identity.html,priorIntent:prior},memory().value,{fetch:async()=>{calls++;return success()}});assert.equal(blocked.status,'blocked');const failing:HtmlAppPersistence={persistIntent:async()=>{throw Error('private')},assertReadyToSubmit:()=>true,persistCreatedAtomically:async()=>{}};assert.equal((await createHtmlAppSite({operationId:'html_app_operation_2',reviewed:true,html:identity.html},failing,{fetch:async()=>{calls++;return success()}})).status,'not_started');const revoked=memory();revoked.setAuthorized(false);assert.equal((await createHtmlAppSite({operationId:'html_app_operation_3',reviewed:true,html:identity.html},revoked.value,{fetch:async()=>{calls++;return success()}})).status,'not_started');assert.equal(calls,0)});

test('unknown create failures preserve only bounded diagnostic enums and never leak raw response data',async t=>{const identity=htmlAppTaskIdentity(task(),site());assert.ok(identity);const cases=[
  {name:'redirect',diagnostic:'redirect',message:'重定向或来源不一致',fetch:async()=>new Response('',{status:302,headers:{location:'https://attacker.invalid/'}})},
  {name:'schema',diagnostic:'schema',message:'字段不符合固定契约',fetch:async()=>new Response(JSON.stringify({site_id:remoteId,update_key:updateKey,status:'active',url:'https://wrong.invalid/'}),{status:200,headers:{'content-type':'application/json'}})},
  {name:'transport',diagnostic:'transport',message:'网络传输或超时失败',fetch:async()=>{throw Error(updateKey)}},
  {name:'timeout',diagnostic:'transport',message:'网络传输或超时失败',fetch:async()=>new Promise<Response>(()=>{})},
  {name:'body',diagnostic:'body_limit',message:'响应体长度无效或超出上限',fetch:async()=>new Response('x'.repeat(70_000),{status:200,headers:{'content-type':'application/json'}})},
  {name:'decode',diagnostic:'decode',message:'响应不是有效 UTF-8 文本',fetch:async()=>new Response(Uint8Array.of(0xff),{status:200,headers:{'content-type':'application/json'}})},
  {name:'json',diagnostic:'json',message:'响应不是有效 JSON',fetch:async()=>new Response(`{"update_key":"${updateKey}"`,{status:200,headers:{'content-type':'application/json'}})},
  {name:'media',diagnostic:'media_type',message:'响应媒体类型不是 JSON',fetch:async()=>new Response(JSON.stringify({update_key:updateKey}),{status:200,headers:{'content-type':'text/plain'}})},
  {name:'http',diagnostic:'http_status',message:'响应状态不是 200',fetch:async()=>new Response(JSON.stringify({update_key:updateKey}),{status:418,headers:{'content-type':'application/json'}})},
] as const;
  for(const item of cases)await t.test(item.name,async()=>{let calls=0;const result=await createHtmlAppSite({operationId:`html_app_${item.name}_1`,reviewed:true,html:identity.html},memory().value,{timeoutMs:50,fetch:async()=>{calls++;return item.fetch()}});assert.equal(result.status,'unknown');if(result.status==='unknown')assert.equal(result.diagnostic,item.diagnostic);assert.equal(calls,1);assert.equal(JSON.stringify(result).includes(updateKey),false);const execution=await runHtmlAppTask(context(task(),memory().value),{timeoutMs:50,fetch:item.fetch});assert.equal(execution.status,'review');assert.match(execution.message,new RegExp(item.message));assert.equal(execution.message.includes(updateKey),false);assert.equal(execution.message.includes('attacker.invalid'),false);assert.equal(execution.message.includes('wrong.invalid'),false)});
  const base=memory(),failing={...base.value,persistCreatedAtomically:async()=>{throw Error(updateKey)}};let calls=0;const result=await createHtmlAppSite({operationId:'html_app_atomic_1',reviewed:true,html:identity.html},failing,{fetch:async()=>{calls++;return success()}});assert.equal(result.status,'created_persistence_unknown');assert.equal(calls,1);assert.equal(JSON.stringify(result).includes(updateKey),false)
});

test('store and cipher commit atomically, restart receipt blocks replay, and a secret-save failure leaves only the permanent intent',async()=>{const dir=mkdtempSync(join(tmpdir(),'html-app-'));const store=new Store(join(dir,'state.sqlite'));try{store.update(state=>{state.settings.autoRun=true;state.sites=[site()];state.tasks=[task()]});acceptHtmlAppPublicNotice(store,HTML_APP_PUBLIC_NOTICE_ACKNOWLEDGEMENT,{now:()=>new Date(now)});let allow=true;const vault={encryptSecrets(values:Record<string,string>){if(!allow)throw Error('secret');return Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))}};const bridge=createHtmlAppPublicationPersistence(store,vault,{taskId,siteId,now:()=>new Date(now),assertSubmissionAuthorized:()=>true});const identity=htmlAppTaskIdentity(task(),site());assert.ok(identity);const intent={operationId:'html_app_operation_4',sourceHash:identity.sourceHash,requestHash:identity.requestHash,createdAt:now};await bridge.persistIntent(intent);assert.equal(store.read().tasks[0].checkpoint,'html_app_create_submitting');allow=false;await assert.rejects(bridge.persistCreatedAtomically({receipt:{...intent,siteId:remoteId,publicUrl},updateKey}));assert.equal(store.read().tasks[0].htmlApp?.stage,'submitting');assert.equal(store.getCipher(`publication:${taskId}`),undefined);let posts=0;const result=await runHtmlAppTask(context(store.read().tasks[0],createHtmlAppPublicationPersistence(store,vault,{taskId,siteId,expectedIntent:intent,assertSubmissionAuthorized:()=>true})),{fetch:async()=>{posts++;return success()}});assert.equal(posts,0);assert.equal(result.status,'review')}finally{store.close();rmSync(dir,{recursive:true,force:true})}});

test('notice removal after durable intent prevents the real write and permanently preserves no-replay state',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'html-app-notice-race-')),store=new Store(join(dir,'state.sqlite'));
  try{
    store.update(state=>{state.settings.autoRun=true;state.sites=[site()];state.tasks=[task()]});
    acceptHtmlAppPublicNotice(store,HTML_APP_PUBLIC_NOTICE_ACKNOWLEDGEMENT,{now:()=>new Date(now)});
    const bridge=createHtmlAppPublicationPersistence(store,{encryptSecrets:values=>values},{taskId,siteId,now:()=>new Date(now),assertSubmissionAuthorized:()=>true});
    const persistence:HtmlAppPersistence={...bridge,persistIntent:async intent=>{await bridge.persistIntent(intent);store.update(state=>{delete state.settings.htmlAppPublicNotice})}};
    let posts=0;const identity=htmlAppTaskIdentity(task(),site());assert.ok(identity);
    const result=await createHtmlAppSite({operationId:'html_app_notice_race',reviewed:true,html:identity.html},persistence,{fetch:async()=>{posts++;return success()}});
    assert.equal(result.status,'not_started');assert.equal(posts,0);assert.equal(store.read().tasks[0].checkpoint,'html_app_create_submitting');assert.equal(store.read().tasks[0].htmlApp?.stage,'submitting');
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});

function saved():Task{const value=task({status:'review',health:'pending',submittedAt:now,checkpoint:'html_app_api_receipt',publicUrl});const identity=htmlAppTaskIdentity(value,site());assert.ok(identity);value.htmlApp={operationId:'html_app_operation_5',sourceHash:identity.sourceHash,requestHash:identity.requestHash,createdAt:now,stage:'api_receipt',siteId:remoteId};return value}
function reads(options:{html?:string;robotsStatus?:number;robots?:string;pageHeaders?:Record<string,string>;api?:unknown}={}){const identity=htmlAppTaskIdentity(task(),site())!;return async(url:string)=>{if(url===`https://api.ht-ml.app/v1/sites/${remoteId}`)return new Response(JSON.stringify(options.api??{site_id:remoteId,status:'active',assets:[],help_endpoints:[]}),{status:200,headers:{'content-type':'application/json'}});if(url===`${publicUrl}robots.txt`)return new Response(options.robots??'{"detail":"Not Found"}',{status:options.robotsStatus??404,headers:{'content-type':options.robotsStatus===200?'text/plain':'application/json'}});assert.equal(url,publicUrl);return new Response(options.html??identity.html,{status:200,headers:{'content-type':'text/html',...options.pageHeaders}})}}

test('anonymous API, exact full HTML, native target link and a normal robots 404 close readback',async()=>{const value=saved(),result=await verifyHtmlAppPublication(value,site(),value.topicUrl!,{fetch:reads()});assert.equal(result.found,true);const recovered=await reconcileHtmlAppTask(context(value),{fetch:reads()});assert.equal(recovered.status,'found');if(recovered.status==='found')assert.equal(recovered.htmlApp.stage,'published')});

test('verification fails on hidden/different HTML, assets, page directives, and crawler-specific robots blocks',async t=>{const identity=htmlAppTaskIdentity(task(),site())!;for(const [name,options] of [
  ['different html',{html:identity.html.replace('<article>','<article hidden>')}],
  ['assets',{api:{site_id:remoteId,status:'active',assets:[{relative_path:'x.png'}]}}],
  ['x robots',{pageHeaders:{'x-robots-tag':'googlebot: noindex'}}],
  ['googlebot robots',{robotsStatus:200,robots:'User-agent: *\nAllow: /\nUser-agent: Googlebot\nDisallow: /'}],
  ['bingbot robots',{robotsStatus:200,robots:'User-agent: *\nAllow: /\nUser-agent: Bingbot\nDisallow: /'}],
] as const)await t.test(name,async()=>{const result=await verifyHtmlAppPublication(saved(),site(),task().topicUrl!,{fetch:reads(options)});assert.equal(result.found,false,name);assert.equal(result.outcome,'invalid',name)})});

test('robots matcher gives specific Googlebot and Bingbot groups precedence over wildcard',()=>{const text='User-agent: *\nAllow: /\nUser-agent: Googlebot\nDisallow: /\nUser-agent: Bingbot\nDisallow: /';assert.equal(htmlAppPublisherTesting.robotsAllows(text,'/','*'),true);assert.equal(htmlAppPublisherTesting.robotsAllows(text,'/','googlebot'),false);assert.equal(htmlAppPublisherTesting.robotsAllows(text,'/','bingbot'),false)});

test('serialized publication secret accepts only the bound per-page key shape',()=>{const parsed=parseHtmlAppPublicationSecret(JSON.stringify({version:1,taskId,operationId:'html_app_operation_1',siteId:remoteId,publicUrl,sourceHash:'a'.repeat(64),requestHash:'b'.repeat(64),updateKey}));assert.ok(parsed);assert.equal(parseHtmlAppPublicationSecret(JSON.stringify({...parsed,publicUrl:'https://other.ht-ml.app/'})),undefined)});

test('the versioned public notice is accepted only through its exact service action and survives strict backup validation',()=>{
  const dir=mkdtempSync(join(tmpdir(),'html-app-notice-')),store=new Store(join(dir,'state.sqlite'));
  try{
    const forged={version:1 as const,acceptedAt:now,termsUrl:HTML_APP_TERMS_URL};
    saveSettingsAtomic(store,{encryptSecrets:()=>({})},{htmlAppPublicNotice:forged});
    assert.equal(store.read().settings.htmlAppPublicNotice,undefined);
    assert.throws(()=>acceptHtmlAppPublicNotice(store,{...HTML_APP_PUBLIC_NOTICE_ACKNOWLEDGEMENT,fullContentPublic:false} as never));
    const accepted=acceptHtmlAppPublicNotice(store,HTML_APP_PUBLIC_NOTICE_ACKNOWLEDGEMENT,{now:()=>new Date(now)});
    assert.equal(accepted.resumed,0);assert.equal(htmlAppPublicNoticeAccepted(store.read().settings.htmlAppPublicNotice),true);
    assert.equal(validateBackup({state:store.read(),secrets:{}}).state.settings.htmlAppPublicNotice?.acceptedAt,now);
    const malformed=store.read();malformed.settings.htmlAppPublicNotice={...forged,version:2 as never};
    assert.throws(()=>validateBackup({state:malformed,secrets:{}}));
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});

test('the real Controller registry performs one create, saves the per-page key, verifies, and a restart never re-POSTs',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'html-app-controller-')),path=join(dir,'state.sqlite'),store=new Store(path),catalog=CHANNELS.map(value=>value.id==='html-app'?{...value,enabled:true}:value);
  const state=emptyState();state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='manual';state.settings.timezone='UTC';state.settings.channelOverrides=Object.fromEntries(catalog.map(value=>[value.id,value.id==='html-app']));state.sites=[site()];state.tasks=[task({status:'queued',attempts:0,health:'pending',draftRevision:1,scheduledAt:new Date(Date.now()-60_000).toISOString()})];store.update(current=>Object.assign(current,state));
  const vault={ready:true,available:()=>true,get:async(key:string)=>store.getCipher(key),set:async(key:string,value:string)=>store.setCipher(key,value),delete:async(key:string)=>store.deleteCipher(key),encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))} as unknown as Vault;
  const calls:{method:string;url:string}[]=[];const fetch=async(url:string,init:RequestInit)=>{calls.push({method:String(init.method),url});if(init.method==='POST')return success();return reads()(url)};
  let reopened:Store|undefined;
  try{const controller=new Controller(pinPublicationFixtures(store),vault,'isolated',{channelCatalog:catalog,htmlAppDependencies:{fetch}});controller.runtime.aiReady=true;await controller.tick();assert.equal(calls.filter(value=>value.method==='POST').length,0);assert.equal(store.read().tasks[0].checkpoint,'html_app_public_notice');assert.equal(store.read().tasks[0].status,'needs_input');const notice=acceptHtmlAppPublicNotice(store,HTML_APP_PUBLIC_NOTICE_ACKNOWLEDGEMENT,{now:()=>new Date(Date.now()-1_000)});assert.equal(notice.resumed,1);assert.equal(store.read().tasks[0].status,'queued');await controller.tick();const saved=store.read().tasks[0],cipher=store.getCipher(`publication:${taskId}`);assert.equal(calls.filter(value=>value.method==='POST').length,1);assert.equal(saved.status,'live');assert.equal(saved.htmlApp?.stage,'published');assert.ok(cipher?.startsWith('enc:'));assert.equal(cipher?.includes(updateKey),false);const plaintext=Buffer.from(cipher!.slice(4),'base64url').toString();const restored=validateBackup({state:store.read(),secrets:{[`publication:${taskId}`]:plaintext}});assert.equal(restored.state.tasks[0].htmlApp?.stage,'published');assert.equal(restored.state.tasks[0].status,'live');assert.throws(()=>validateBackup({state:store.read(),secrets:{}}));assert.throws(()=>controller.deleteSite(siteId));store.close();reopened=new Store(path);const second:{method:string;url:string}[]=[];const controller2=new Controller(pinPublicationFixtures(reopened),vault,'isolated',{channelCatalog:catalog,htmlAppDependencies:{fetch:async(url,init)=>{second.push({method:String(init.method),url});return reads()(url)}}});controller2.runtime.aiReady=true;await controller2.tick();assert.equal(second.some(value=>value.method==='POST'),false)}finally{try{reopened?.close()}catch{}try{store.close()}catch{}rmSync(dir,{recursive:true,force:true})}
});

test('recovery keeps the API receipt backup-safe when a second verification read is temporarily unavailable',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'html-app-recovery-')),store=new Store(join(dir,'state.sqlite')),catalog=CHANNELS.map(value=>value.id==='html-app'?{...value,enabled:true}:value);
  const recovered=saved(),identity=htmlAppTaskIdentity(recovered,site());assert.ok(identity);const receipt=recovered.htmlApp!;
  const secret=JSON.stringify({version:1,taskId,operationId:receipt.operationId,siteId:receipt.siteId,publicUrl,sourceHash:receipt.sourceHash,requestHash:receipt.requestHash,updateKey});
  const state=emptyState();state.settings.autoRun=true;state.settings.notify=false;state.settings.timezone='UTC';state.settings.channelOverrides=Object.fromEntries(catalog.map(value=>[value.id,value.id==='html-app']));state.sites=[site()];state.tasks=[recovered];store.update(current=>Object.assign(current,state));store.setCipher(`publication:${taskId}`,'enc:fixture');
  const vault={ready:true,available:()=>true,get:async()=>secret,set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>values} as unknown as Vault;
  let readsCompleted=0,posts=0;const successfulReads=reads();
  const controller=new Controller(pinPublicationFixtures(store),vault,'isolated',{channelCatalog:catalog,htmlAppDependencies:{fetch:async(url,init)=>{if(init.method==='POST'){posts++;return success()}readsCompleted++;if(readsCompleted<=3)return successfulReads(url);return new Response('',{status:429,headers:{'content-type':'application/json'}})}}});controller.runtime.aiReady=true;
  try{
    await controller.tick();const after=store.read(),taskAfter=after.tasks[0];assert.equal(posts,0);assert.equal(readsCompleted,4);assert.equal(taskAfter.htmlApp?.stage,'api_receipt');assert.equal(taskAfter.checkpoint,'html_app_api_receipt');assert.equal(taskAfter.firstLiveAt,undefined);assert.equal(taskAfter.verifiedAt,undefined);assert.ok(taskAfter.reconcileAfter);await controller.tick();assert.equal(readsCompleted,4);
    const restored=validateBackup({state:after,secrets:{[`publication:${taskId}`]:secret}});assert.equal(restored.state.tasks[0].htmlApp?.stage,'api_receipt');
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});
