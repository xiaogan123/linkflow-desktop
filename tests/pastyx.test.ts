import {pinPublicationFixtures} from './helpers/publication-snapshot';
import {beforeEach,type TestContext} from 'node:test';
beforeEach(t=>{if(["normal Controller performs one POST and exactly three reads, keeps the key out of state, and creates a restorable live task", "ciphertext survives reopen and verification only checks the published HTML", "unknown create and rendered mismatch cannot become live or cause another POST"].includes(t.name))(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse(at)+60000});});
import {periodicFixtureCheck} from './helpers/periodic-link-check';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {load} from 'cheerio';
import {marked} from 'marked';
import {CHANNELS} from '../src/integrations/catalog';
import {
  createPastyXPaste,drainPastyXPendingOperations,parseStoredPastyXCreateResponse,
  pastyxApiUrl,pastyxHash,pastyxPendingOperationCount,pastyxPublicUrl,pastyxRequest,
  trackPastyXPendingOperation,PASTYX_AUTHOR,PASTYX_CREATE_URL,PASTYX_MAX_HTML_BYTES,
  type PastyXIntent,type PastyXOpaqueResponse,type PastyXPersistence,type PastyXRenderedPage,
  type PastyXSecretRecord,
} from '../src/integrations/pastyx';
import {pastyxPublisherTesting,verifyPastyXPublication} from '../src/integrations/pastyx-publisher';
import {validateBackup} from '../src/main/backup-validation';
import {Controller,isConfirmedPastyXResultUrl} from '../src/main/controller';
import {parsePastyXPublicationSecret,pastyxTaskIdentity} from '../src/main/pastyx-publication';
import {emptyState,Store} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import type {Site,Task} from '../src/shared/types';

const at='2026-10-15T10:00:00.000Z';
const taskId='11111111-1111-4111-8111-111111111111';
const siteId='22222222-2222-4222-8222-222222222222';
const pageId='guide-Ab3z';
const target='https://github.com/xiaogan123/linkflow-desktop';
const url=pastyxPublicUrl(pageId);
const keyBytes=new Uint8Array(32).fill(7);
const editKey=Buffer.from(keyBytes).toString('base64url');
const draft={
  title:'Verifying a Synthetic Markdown Link',
  description:'Synthetic fixture for checking the article boundary and intended destination.',
  body:`A checker should confirm the link that belongs to the article.

## Identify the article boundary

Inspect the rendered article container before counting anchors.

## Compare the intended destination

This example uses the [Linkflow public project repository](${target}) as relevant implementation context.

## Keep the evidence honest

This article describes a general verification method for public software documentation.`,
};

function site():Site{return {id:siteId,domain:'github.com',url:target,email:'owner@example.test',name:'Linkflow',description:'Desktop software project',category:'software',language:'en',monthlyTarget:1,articleReviewMode:'manual',qualifications:{software:target,developer:target},status:'ready',createdAt:at,analyzedAt:at,topicsCheckedAt:at,topics:[{url:target,discoveredAt:at}]}}
function task(extra:Partial<Task>={}):Task{return {id:taskId,siteId,channelId:'pastyx',sourceDomain:'pastyx.pages.dev',status:'queued',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'fixture',topicUrl:target,draft,draftRevision:1,articleApprovedAt:at,health:'pending',...extra}}
function identity(){const value=pastyxTaskIdentity(task(),site());assert.ok(value);return value}
function request(){return pastyxRequest(identity(),editKey)}
function intent():PastyXIntent{const value=request();return {operationId:'pastyx_11111111111141118111111111111111',sourceHash:value.sourceHash,requestHash:value.requestHash,editKeyHash:value.editKeyHash,createdAt:at}}
function responseValue(){const value=identity();return {id:pageId,title:value.title,author:value.author,expiresAt:null,hasPassword:false,hasEditKey:true,url}}
function apiValue(){const value=identity();return {id:pageId,title:value.title,author:value.author,content:value.content,expiresAt:null,hasPassword:false,hasEditKey:true,views:0,createdAt:at,updatedAt:at,burnAfterRead:false}}
function response(status=200,body:unknown=responseValue(),type='application/json'){return new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'content-type':type}})}
function memory(){let attempted=false,record:PastyXSecretRecord|undefined,receipt:unknown;const order:string[]=[];const persistence:PastyXPersistence={async persistIntent(value,key){if(attempted)throw Error('repeated');attempted=true;record={version:1,kind:'pastyx_secret',editKey:key,intent:value};order.push('intent')},assertReadyToSubmit(){return true},async persistOpaqueResponse(value){assert.ok(record);record={...record,opaqueResponse:value};order.push('opaque')},async loadRecord(){return record},async promoteReceipt(value){receipt=value;order.push('receipt')}};return {persistence,order,getRecord:()=>record,getReceipt:()=>receipt}}
function rendered():PastyXRenderedPage{
  const value=identity(),inner=String(marked.parse(value.content,{async:false,gfm:true})),html=`<article class="markdown-body article__content">${inner}</article>`,text=load(html,undefined,false).root().text(),bytes=Buffer.byteLength(html);
  return {url,documentTitle:value.title,headings:[{text:value.title,visible:true}],bylines:[{text:value.author,visible:true}],candidates:[{selector:'article.markdown-body.article__content',html,text,allTextVisible:true,links:[{href:target,rel:[],text:'Linkflow public project repository',visible:true}]}],robots:[],responseRobots:[],responseStatus:200,responseMediaType:'text/html',responseBodyBytes:bytes,responseEncodedBodyBytes:bytes,canonicals:[url],hasRefresh:false,hasPasswordGate:false,hasLoginGate:false,nativeRequests:[{url,method:'GET',resourceType:'mainFrame'}]};
}
function vault(store:Store):Vault{return {ready:true,available:()=>true,get:async(key:string)=>{const cipher=store.getCipher(key);return cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():undefined},set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))} as unknown as Vault}
function fixture(){const dir=mkdtempSync(join(tmpdir(),'linkflow-pastyx-')),path=join(dir,'state.sqlite'),store=new Store(path),state=emptyState();state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='manual';state.settings.timezone='UTC';state.settings.channelOverrides={pastyx:true};state.sites=[site()];state.tasks=[task({scheduledAt:new Date(Date.now()-60_000).toISOString()})];store.update(current=>Object.assign(current,state));return {dir,path,store,cleanup(){try{store.close()}catch{}rmSync(dir,{recursive:true,force:true})}}}
function dependencies(store:Store,calls:Array<{method:string;url:string}>,options:{badCreate?:boolean;badRender?:boolean;robots?:string}={}){return {now:()=>new Date(at),randomBytes:()=>keyBytes,fetch:async(requestUrl:string,init:RequestInit)=>{const method=init.method??'GET';calls.push({method,url:requestUrl});if(method==='POST'){
    const saved=store.read().tasks[0],cipher=store.getCipher(`publication:${taskId}`);assert.equal(saved.pastyx?.stage,'submitting');assert.equal(saved.checkpoint,'pastyx_create_submitting');assert.ok(cipher);assert.equal(cipher!.includes(editKey),false);assert.equal(String(init.body),request().body);assert.deepEqual(Object.keys(JSON.parse(String(init.body))),['content','title','author','expiry','editKey','burnAfterRead']);assert.deepEqual(JSON.parse(String(init.body)),{content:identity().content,title:identity().title,author:site().name,expiry:'never',editKey,burnAfterRead:false});assert.equal(new Headers(init.headers).has('authorization'),false);return options.badCreate?response(403,{error:'disabled'}):response();
  }if(requestUrl===pastyxApiUrl(pageId))return response(200,apiValue());assert.equal(requestUrl,'https://pastyx.pages.dev/robots.txt');return new Response(options.robots??'User-agent: *\nAllow: /\nDisallow: /edit/\nDisallow: /api/\n',{status:200,headers:{'content-type':'text/plain'}})},renderPage:async(requestUrl:string)=>{calls.push({method:'GET',url:requestUrl});return options.badRender?{...rendered(),candidates:[{...rendered().candidates[0],allTextVisible:false}]}:rendered()}}}
const enabledCatalog=CHANNELS.map(channel=>channel.id==='pastyx'?{...channel,enabled:true}:channel);

test('catalog is enabled after controlled live acceptance and the request remains the fixed anonymous envelope',()=>{
  const channel=CHANNELS.find(value=>value.id==='pastyx');assert.ok(channel);assert.equal(channel.enabled,true);assert.equal(channel.accountRequired,false);assert.equal(channel.emailRequired,false);assert.equal(channel.automation,'api');assert.equal(channel.evidenceStatus,'rules_checked');
  assert.deepEqual(request().value,{content:identity().content,title:identity().title,author:site().name,expiry:'never',editKey,burnAfterRead:false});
  assert.equal(Object.prototype.hasOwnProperty.call(request().value,'email'),false);assert.equal(Object.prototype.hasOwnProperty.call(request().value,'password'),false);
  assert.equal(pastyxTaskIdentity(task({draft:{...draft,body:'No target link'}}),site()),undefined);
});

test('historical PastyX author is read only when the saved source hash matches',()=>{
  const fresh=identity();
  assert.equal(fresh.author,site().name);
  const legacy=pastyxRequest({...fresh,author:'Linkflow promotional content publisher'},editKey);
  for(const stage of ['submitting','opaque_response'] as const){
    const saved=task({pastyx:{operationId:intent().operationId,sourceHash:legacy.sourceHash,requestHash:legacy.requestHash,editKeyHash:legacy.editKeyHash,createdAt:at,stage}});
    assert.equal(pastyxTaskIdentity(saved,site())?.author,'Linkflow promotional content publisher');
    assert.equal(pastyxTaskIdentity(saved,site())?.sourceHash,legacy.sourceHash);
  }
  const neutral=pastyxRequest({...fresh,author:PASTYX_AUTHOR},editKey);
  const savedNeutral=task({pastyx:{operationId:intent().operationId,sourceHash:neutral.sourceHash,requestHash:neutral.requestHash,editKeyHash:neutral.editKeyHash,createdAt:at,stage:'submitting'}});
  assert.equal(pastyxTaskIdentity(savedNeutral,site())?.author,PASTYX_AUTHOR);
  const unrelated=task({pastyx:{operationId:intent().operationId,sourceHash:'0'.repeat(64),requestHash:legacy.requestHash,editKeyHash:legacy.editKeyHash,createdAt:at,stage:'submitting'}});
  assert.equal(pastyxTaskIdentity(unrelated,site())?.author,site().name);
});

test('single POST saves the generated edit key and intent before transport, then seals opaque bytes before receipt',async()=>{
  const m=memory(),calls:Array<{url:string;init:RequestInit}>=[],result=await createPastyXPaste({operationId:intent().operationId,article:identity(),reviewed:true},m.persistence,{now:()=>new Date(at),randomBytes:()=>keyBytes,fetch:async(requestUrl,init)=>{assert.equal(m.getRecord()?.editKey,editKey);calls.push({url:requestUrl,init});return response()}});
  assert.equal(result.status,'created');assert.deepEqual(m.order,['intent','opaque','receipt']);assert.equal(calls.length,1);assert.equal(calls[0].url,PASTYX_CREATE_URL);assert.equal(calls[0].init.method,'POST');assert.equal(calls[0].init.redirect,'manual');assert.equal(calls[0].init.credentials,'omit');assert.equal(m.getRecord()?.opaqueResponse?.bodySha256,pastyxHash(Buffer.from(m.getRecord()!.opaqueResponse!.bodyBase64,'base64')));assert.deepEqual(m.getReceipt(),result.status==='created'?result.receipt:undefined);
});

test('duplicate or added fields, wrong identities, redirects, media mismatch and failure status remain unknown',async t=>{
  const valid=JSON.stringify(responseValue()),cases=[valid.replace(`"id":"${pageId}"`,`"id":"${pageId}","id":"${pageId}"`),valid.replace(/}$/,',"extra":1}'),JSON.stringify({...responseValue(),url:'https://pastyx.pages.dev/other'})];
  for(const [index,body] of cases.entries())await t.test(`strict-${index}`,async()=>{const m=memory(),result=await createPastyXPaste({operationId:intent().operationId,article:identity(),reviewed:true},m.persistence,{now:()=>new Date(at),randomBytes:()=>keyBytes,fetch:async()=>response(200,body)});assert.equal(result.status,'unknown');assert.deepEqual(m.order,['intent','opaque'])});
  for(const variant of [{status:302,type:'application/json'},{status:202,type:'application/json'},{status:200,type:'text/plain'}])await t.test(`${variant.status}-${variant.type}`,async()=>{const m=memory(),result=await createPastyXPaste({operationId:intent().operationId,article:identity(),reviewed:true},m.persistence,{now:()=>new Date(at),randomBytes:()=>keyBytes,fetch:async()=>response(variant.status,valid,variant.type)});assert.equal(result.status,'unknown');assert.deepEqual(m.order,['intent','opaque'])});
});

test('stored create evidence is bound to the exact edit key, request, response and complete body',async()=>{
  const m=memory(),result=await createPastyXPaste({operationId:intent().operationId,article:identity(),reviewed:true},m.persistence,{now:()=>new Date(at),randomBytes:()=>keyBytes,fetch:async()=>response()});assert.equal(result.status,'created');const opaque=m.getRecord()!.opaqueResponse!;assert.ok('receipt' in parseStoredPastyXCreateResponse(opaque,intent(),identity(),editKey));
  for(const change of [{bodyComplete:false},{responseUrl:'https://pastyx.pages.dev/api/other'},{redirected:true},{status:403},{bodySha256:'0'.repeat(64)},{sourceHash:'0'.repeat(64)}])assert.ok('diagnostic' in parseStoredPastyXCreateResponse({...opaque,...change},intent(),identity(),editKey));
  assert.ok('diagnostic' in parseStoredPastyXCreateResponse(opaque,intent(),identity(),'A'.repeat(43)));
});

test('a response after the deadline is retained by the pending drain and the POST is never replayed',async()=>{
  const m=memory();let posts=0;const result=await createPastyXPaste({operationId:intent().operationId,article:identity(),reviewed:true},m.persistence,{now:()=>new Date(at),randomBytes:()=>keyBytes,timeoutMs:50,fetch:async()=>{posts++;await new Promise(resolve=>setTimeout(resolve,80));return response()}});assert.equal(result.status,'unknown');assert.equal(posts,1);assert.deepEqual(m.order,['intent']);await drainPastyXPendingOperations();assert.equal(posts,1);assert.deepEqual(m.order,['intent','opaque']);assert.equal(m.getReceipt(),undefined);
});

test('pending operation drain is bounded without dropping the operation',async()=>{let release:()=>void=()=>{};const pending=trackPastyXPendingOperation(new Promise<void>(resolve=>{release=resolve}));assert.equal(await drainPastyXPendingOperations(5),false);assert.equal(pastyxPendingOperationCount(),1);release();await pending;assert.equal(await drainPastyXPendingOperations(5),true);assert.equal(pastyxPendingOperationCount(),0)});

test('native acceptance requires exact visible full Markdown, author, title, one native link and crawlable policy',async t=>{
  assert.ok(pastyxPublisherTesting.exactRendered(rendered(),url,identity().title,identity().author,identity().content,target));const base=rendered(),candidate=base.candidates[0];const variants:PastyXRenderedPage[]=[{...base,responseStatus:404},{...base,responseMediaType:'text/plain'},{...base,responseBodyBytes:PASTYX_MAX_HTML_BYTES+1},{...base,responseEncodedBodyBytes:PASTYX_MAX_HTML_BYTES+1},{...base,nativeRequests:[...base.nativeRequests,...base.nativeRequests]},{...base,headings:[]},{...base,bylines:[]},{...base,candidates:[{...candidate,text:'changed',html:'<article class="markdown-body article__content"><p>changed</p></article>'}]},{...base,candidates:[{...candidate,allTextVisible:false}]},{...base,candidates:[{...candidate,links:[{...candidate.links[0],visible:false}]}]},{...base,canonicals:[url,'https://pastyx.pages.dev/other']},{...base,robots:[{name:'googlebot',content:'noindex'}]},{...base,responseRobots:['nofollow']},{...base,hasRefresh:true}];for(const [index,page] of variants.entries())await t.test(String(index+1),()=>assert.equal(pastyxPublisherTesting.exactRendered(page,url,identity().title,identity().author,identity().content,target),undefined));
});

test('normal Controller performs one POST and exactly three reads, keeps the key out of state, and creates a restorable live task',async()=>{
  const f=fixture(),calls:Array<{method:string;url:string}>=[],v=vault(f.store),controller=new Controller(pinPublicationFixtures(f.store),v,'fixture',{channelCatalog:enabledCatalog,pastyxDependencies:dependencies(f.store,calls)});controller.runtime.aiReady=true;try{await controller.tick();const state=f.store.read(),saved=state.tasks[0];assert.equal(calls.filter(value=>value.method==='POST').length,1,JSON.stringify(saved));assert.deepEqual(calls.filter(value=>value.method==='GET').map(value=>value.url),[pastyxApiUrl(pageId),url,'https://pastyx.pages.dev/robots.txt']);assert.equal(saved.status,'live',JSON.stringify(saved));assert.equal(saved.health,'healthy');assert.equal(saved.pastyx?.stage,'published');assert.equal(saved.publicUrl,url);assert.equal(JSON.stringify(state).includes(editKey),false);assert.equal(isConfirmedPastyXResultUrl(saved,url,site()),true);const raw=(await v.get(`publication:${taskId}`))!;assert.ok(parsePastyXPublicationSecret(raw));assert.equal(parsePastyXPublicationSecret(raw)?.editKey,editKey);assert.equal(f.store.getCipher(`publication:${taskId}`)?.includes(editKey),false);assert.doesNotThrow(()=>validateBackup({state,secrets:{[`publication:${taskId}`]:raw}}));assert.throws(()=>f.store.update(state=>{state.tasks[0].draft!.body='changed'}));assert.throws(()=>f.store.updateWithCiphers(()=>{}, {},[`publication:${taskId}`]));const tampered=JSON.parse(raw);tampered.editKey='B'.repeat(43);assert.throws(()=>validateBackup({state,secrets:{[`publication:${taskId}`]:JSON.stringify(tampered)}}))}finally{controller.stop();f.cleanup()}
});

test('ciphertext survives reopen and verification only checks the published HTML',async()=>{
  const f=fixture(),firstCalls:Array<{method:string;url:string}>=[],first=new Controller(pinPublicationFixtures(f.store),vault(f.store),'fixture',{channelCatalog:enabledCatalog,pastyxDependencies:dependencies(f.store,firstCalls)});first.runtime.aiReady=true;let reopened:Store|undefined;try{await first.tick();first.stop();f.store.close();reopened=new Store(f.path);const raw=(await vault(reopened).get(`publication:${taskId}`))!;assert.ok(parsePastyXPublicationSecret(raw));assert.doesNotThrow(()=>validateBackup({state:reopened!.read(),secrets:{[`publication:${taskId}`]:raw}}));const calls:Array<{method:string;url:string}>=[],second=new Controller(pinPublicationFixtures(reopened),vault(reopened),'fixture',{channelCatalog:enabledCatalog,recheckLink:periodicFixtureCheck(dependencies(reopened,calls).fetch!),pastyxDependencies:dependencies(reopened,calls)});second.runtime.aiReady=true;try{await second.verify(taskId);assert.equal(calls.some(value=>value.method==='POST'),false);assert.deepEqual(calls.map(value=>value.url),[url]);assert.equal(reopened.read().tasks[0].pastyx?.stage,'published')}finally{second.stop()}}finally{first.stop();try{reopened?.close()}catch{}rmSync(f.dir,{recursive:true,force:true})}
});

test('unknown create and rendered mismatch cannot become live or cause another POST',async()=>{
  const f=fixture(),calls:Array<{method:string;url:string}>=[],v=vault(f.store),controller=new Controller(pinPublicationFixtures(f.store),v,'fixture',{channelCatalog:enabledCatalog,pastyxDependencies:dependencies(f.store,calls,{badCreate:true})});controller.runtime.aiReady=true;try{await controller.tick();let saved=f.store.read().tasks[0];assert.equal(saved.pastyx?.stage,'opaque_response');assert.equal(saved.publicUrl,undefined);assert.equal(calls.filter(value=>value.method==='POST').length,1);await controller.tick();saved=f.store.read().tasks[0];assert.equal(calls.filter(value=>value.method==='POST').length,1);assert.notEqual(saved.status,'live');const record=parsePastyXPublicationSecret((await v.get(`publication:${taskId}`))!);assert.ok(record?.opaqueResponse);assert.ok('diagnostic' in parseStoredPastyXCreateResponse(record!.opaqueResponse!,intent(),identity(),record!.editKey))}finally{controller.stop();f.cleanup()}
  const published=task({status:'review',submittedAt:at,publicUrl:url,checkpoint:'pastyx_api_receipt',pastyx:{...intent(),stage:'api_receipt',id:pageId}}),dummy={read:()=>({tasks:[published]})} as unknown as Store,result=await verifyPastyXPublication(published,site(),target,dependencies(dummy,[],{badRender:true}));assert.equal(result.found,false);assert.equal(result.outcome,'invalid');
});

test('disabled catalog prevents planning and all network traffic',()=>{const f=fixture(),calls:Array<{method:string;url:string}>=[],controller=new Controller(pinPublicationFixtures(f.store),vault(f.store),'fixture',{channelCatalog:CHANNELS,pastyxDependencies:dependencies(f.store,calls)});controller.runtime.aiReady=true;try{controller.plan();assert.equal(calls.length,0);assert.notEqual(f.store.read().tasks[0].status,'live')}finally{controller.stop();f.cleanup()}});
