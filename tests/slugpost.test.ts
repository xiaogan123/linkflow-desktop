import {pinPublicationFixtures} from './helpers/publication-snapshot';
import {beforeEach,type TestContext} from 'node:test';
beforeEach(t=>{if(["controller performs one official UI click and keeps the owned result across another tick", "a reopened Controller resumes the same proven unarmed intent with one first click"].includes(t.name))(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-13T10:17:00.000Z')});});
import {strict as assert} from 'node:assert';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {parseSlugPostOpaque,slugPostOpaqueFromCapture,slugPostRequest,slugPostPublicUrl,type SlugPostIntent,type SlugPostPersistence} from '../src/integrations/slugpost';
import {guardSession,submitSlugPostUi,type SlugPostBoundaryEvent} from '../src/integrations/slugpost-browser';
import {runSlugPostTask,verifySlugPostPublication,slugPostPreflightNeverArmed} from '../src/integrations/slugpost-publisher';
import {CHANNELS} from '../src/integrations/catalog';
import {Controller} from '../src/main/controller';
import {marked} from 'marked';
import {createSlugPostPublicationPersistence,slugPostTaskIdentity} from '../src/main/slugpost-publication';
import {emptyState,Store} from '../src/main/store';
import {validateBackup} from '../src/main/backup-validation';
import type {ExecutionContext,Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const content='# A useful software guide\n\nAn independently useful explanation. [Project documentation](https://example.org/docs).';
const slug='docs-a0b1c2d3e4f5';
const request=slugPostRequest(content,slug);
const intent:SlugPostIntent={operationId:'slugpost_0123456789abcdef0123456789abcdef',slug,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:'2026-10-13T00:00:00.000Z'};
function opaque(body:string,status=200){return slugPostOpaqueFromCapture(intent,{status,mimeType:'application/json',url:'https://slugpost.com/publish',body,base64Encoded:false})!}
test('request boundary enforces frozen UI body, current authorization and one POST',()=>{
  let filter:(details:Record<string,unknown>,callback:(result:{cancel:boolean})=>void)=>void=()=>{};
  const session={setPermissionRequestHandler:()=>{},setPermissionCheckHandler:()=>{},on:()=>{},webRequest:{onBeforeRequest:(_filter:unknown,handler:typeof filter)=>{filter=handler}}};
  const evidence:SlugPostBoundaryEvent[]=[],arm=guardSession(session as never,event=>evidence.push(event)),body=Buffer.from(request.body),endpoint='https://slugpost.com/publish';let authorized=true;
  const permits=(details:Record<string,unknown>)=>{let allowed=false;filter(details,result=>{allowed=!result.cancel});return allowed};
  const post=(uploadData:unknown)=>({method:'POST',url:endpoint,uploadData});
  assert.equal(permits(post([{bytes:body}])),false);
  arm(body,()=>authorized,intent.requestHash);
  assert.equal(permits(post([{bytes:Buffer.from(JSON.stringify({content:'UNAPPROVED BODY',slug:'wrong',format:'html',domain:'wrong.example'}))}])),false);
  assert.equal(permits(post(undefined)),false);
  assert.equal(permits(post([{bytes:body,file:'/tmp/unapproved'}])),false);
  authorized=false;assert.equal(permits(post([{bytes:body}])),false);
  authorized=true;assert.equal(permits(post([{bytes:new Uint8Array(body.subarray(0,8))},{bytes:new Uint8Array(body.subarray(8))}])),true);
  assert.equal(permits(post([{bytes:body}])),false);
  assert.deepEqual(evidence.map(value=>value.stage),['armed','dispatch_denied','dispatch_denied','dispatch_denied','dispatch_denied','dispatch_allowed','dispatch_denied']);
  assert.equal(evidence.every(value=>value.requestHash===intent.requestHash),true);
});

test('request boundary cancels the exact POST when durable dispatch evidence fails',()=>{
  let filter:(details:Record<string,unknown>,callback:(result:{cancel:boolean})=>void)=>void=()=>{};
  const session={setPermissionRequestHandler:()=>{},setPermissionCheckHandler:()=>{},on:()=>{},webRequest:{onBeforeRequest:(_filter:unknown,handler:typeof filter)=>{filter=handler}}};
  let calls=0;const arm=guardSession(session as never,event=>{calls++;if(event.stage==='dispatch_allowed')throw Error('synthetic fsync failure')});const body=Buffer.from(request.body);
  arm(body,()=>true,intent.requestHash);let allowed=false;filter({method:'POST',url:'https://slugpost.com/publish',uploadData:[{bytes:body}]},result=>{allowed=!result.cancel});
  assert.equal(allowed,false);assert.equal(calls,3);
});
test('only the original slug and encrypted UI response can establish an owned receipt',()=>{
  const raw=opaque(JSON.stringify({success:true,slug,edit_token:'opaque_token_12345678'}));
  assert.equal(parseSlugPostOpaque(raw,intent,content)?.publicUrl,slugPostPublicUrl(slug));
  assert.equal(parseSlugPostOpaque(raw,intent,content)?.editToken,'opaque_token_12345678');
  assert.equal(parseSlugPostOpaque(opaque(JSON.stringify({success:true,slug:'other-slug',edit_token:'opaque_token_12345678'})),intent,content),undefined);
  assert.equal(parseSlugPostOpaque(opaque('{"success":true,"slug":"'+slug+'","slug":"'+slug+'","edit_token":"opaque_token_12345678"}'),intent,content),undefined);
  assert.equal(parseSlugPostOpaque(opaque(JSON.stringify({success:true,slug,edit_token:'opaque_token_12345678'}),206),intent,content),undefined);
  assert.equal(parseSlugPostOpaque(raw,intent,content+' changed'),undefined);
});

test('official editor click is single and its own response is persisted before parsing',async()=>{
  const debuggerEvents=new EventEmitter();let attached=false,clicks=0,saved=0;
  const debuggerMock=Object.assign(debuggerEvents,{isAttached:()=>attached,attach:()=>{attached=true},sendCommand:async(method:string)=>method==='Network.getResponseBody'?{body:JSON.stringify({success:true,slug,edit_token:'opaque_token_12345678'}),base64Encoded:false}:{}});
  const web={debugger:debuggerMock,executeJavaScriptInIsolatedWorld:async(_world:number,commands:Array<{code:string}>)=>{
    const code=commands[0].code;
    if(code.includes('challenge:/captcha'))return {ok:true,challenge:false};
    if(code.includes("return buttons[0].disabled?'pending':'ready'"))return 'ready';if(code.includes("buttons[0].click()")){
      clicks++;
      queueMicrotask(()=>{
        debuggerEvents.emit('message',{},'Network.requestWillBeSent',{requestId:'one',request:{url:'https://slugpost.com/publish',method:'POST'}});
        debuggerEvents.emit('message',{},'Network.responseReceived',{requestId:'one',response:{url:'https://slugpost.com/publish',status:200,mimeType:'application/json'}});
        debuggerEvents.emit('message',{},'Network.loadingFinished',{requestId:'one'});
      });return true;
    }
    return true;
  }};
  const window={webContents:web,loadURL:async(url:string)=>assert.equal(url,'https://slugpost.com/publish'),isDestroyed:()=>false,destroy:()=>{}};
  const persistence:SlugPostPersistence={persistIntent:async()=>{},assertReadyToSubmit:()=>true,persistBoundary:()=>{},persistOpaqueResponse:async()=>{saved++},loadOpaqueResponse:async()=>undefined,promoteReceipt:async()=>{}};
  const evidence:SlugPostBoundaryEvent[]=[];const result=await submitSlugPostUi({intent,content},persistence,{createWindow:async()=>window as never,timeoutMs:1000,onBoundaryEvent:event=>evidence.push(event)});
  assert.equal(result.status,'captured');assert.equal(clicks,1);assert.equal(saved,1);
  assert.equal(result.opaque&&parseSlugPostOpaque(result.opaque,intent,content)?.publicUrl,slugPostPublicUrl(slug));
  assert.deepEqual(evidence.map(value=>value.stage),['armed','click_started']);
});

test('invoked click with an unconfirmed result is unknown and keeps ordered non-secret evidence',async()=>{
  const debuggerMock=Object.assign(new EventEmitter(),{isAttached:()=>false,attach:()=>{},sendCommand:async()=>({})});
  const window={webContents:{debugger:debuggerMock,executeJavaScriptInIsolatedWorld:async(_world:number,commands:Array<{code:string}>)=>commands[0].code.includes('challenge:/captcha')?{ok:true,challenge:false}:commands[0].code.includes("return buttons[0].disabled?'pending':'ready'")?'ready':commands[0].code.includes('buttons[0].click()')?false:true},loadURL:async()=>{},isDestroyed:()=>false,destroy:()=>{}};
  const persistence:SlugPostPersistence={persistIntent:async()=>{},assertReadyToSubmit:()=>true,persistBoundary:()=>{},persistOpaqueResponse:async()=>{},loadOpaqueResponse:async()=>undefined,promoteReceipt:async()=>{}};
  const evidence:SlugPostBoundaryEvent[]=[],result=await submitSlugPostUi({intent,content},persistence,{createWindow:async()=>window as never,timeoutMs:1000,onBoundaryEvent:event=>evidence.push(event)});
  assert.equal(result.status,'unknown');assert.equal(result.reason,'click_not_confirmed');assert.deepEqual(evidence.map(value=>value.stage),['armed','click_started']);assert.deepEqual(evidence.map(value=>value.sequence),[1,2]);
});

test('challenge in the official editor stops before any publish click',async()=>{
  let clicked=false;const debuggerMock=Object.assign(new EventEmitter(),{isAttached:()=>false,attach:()=>{},sendCommand:async()=>({})});
  const window={webContents:{debugger:debuggerMock,executeJavaScriptInIsolatedWorld:async(_world:number,commands:Array<{code:string}>)=>{if(commands[0].code.includes('buttons[0].click()'))clicked=true;return {ok:true,challenge:true}}},loadURL:async()=>{},isDestroyed:()=>false,destroy:()=>{}};
  const persistence:SlugPostPersistence={persistIntent:async()=>{},assertReadyToSubmit:()=>true,persistBoundary:()=>{},persistOpaqueResponse:async()=>{},loadOpaqueResponse:async()=>undefined,promoteReceipt:async()=>{}};
  const result=await submitSlugPostUi({intent,content},persistence,{createWindow:async()=>window as never,timeoutMs:1000});
  assert.equal(result.status,'not_started');assert.equal(clicked,false);
});

test('missing durable boundary writer stops before opening the editor or POST',async()=>{
  let windows=0;
  const missingWriter={persistIntent:async()=>{},assertReadyToSubmit:()=>true,persistOpaqueResponse:async()=>{},loadOpaqueResponse:async()=>undefined,promoteReceipt:async()=>{}} as unknown as SlugPostPersistence;
  const result=await submitSlugPostUi({intent,content},missingWriter,{createWindow:async()=>{windows++;throw Error('must not open')}});
  assert.deepEqual(result,{status:'not_started',reason:'evidence_unavailable'});assert.equal(windows,0);
});

test('first navigation completes before CDP enable; navigation or CDP failure sends no POST',async()=>{
  const persistence:SlugPostPersistence={persistIntent:async()=>{},assertReadyToSubmit:()=>true,persistBoundary:()=>{},persistOpaqueResponse:async()=>{},loadOpaqueResponse:async()=>undefined,promoteReceipt:async()=>{}};
  for(const failure of ['none','navigation','cdp'] as const){
    const calls:string[]=[];let loaded=false,clicked=false;
    const debuggerMock=Object.assign(new EventEmitter(),{isAttached:()=>false,attach:()=>{assert.equal(loaded,true);calls.push('attach')},sendCommand:async(method:string)=>{assert.equal(method,'Network.enable');assert.equal(loaded,true);calls.push('enable');if(failure==='cdp')throw Error('synthetic CDP failure');return {}}});
    const window={webContents:{debugger:debuggerMock,executeJavaScriptInIsolatedWorld:async(_world:number,commands:Array<{code:string}>)=>{if(commands[0].code.includes('buttons[0].click()'))clicked=true;return {ok:true,challenge:true}}},loadURL:async(url:string)=>{assert.equal(url,'https://slugpost.com/publish');calls.push('load');if(failure==='navigation')throw Error('synthetic navigation failure');loaded=true},isDestroyed:()=>false,destroy:()=>{}};
    const result=await submitSlugPostUi({intent,content},persistence,{createWindow:async()=>window as never,timeoutMs:1000});
    assert.equal(result.status,'not_started');assert.equal(clicked,false);
    assert.deepEqual(calls,failure==='navigation'?['load']:failure==='cdp'?['load','attach','enable']:['load','attach','enable']);
  }
});

test('store and encrypted backup bind a single fixed-slug intent to the original draft',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'linkflow-slugpost-')),store=new Store(join(dir,'state.sqlite'));
  const taskId='11111111-1111-4111-8111-111111111111',siteId='22222222-2222-4222-8222-222222222222';
  const site:Site={id:siteId,domain:'example.org',url:'https://example.org/',email:'owner@example.org',name:'Example software',description:'Developer software',category:'software',language:'en',monthlyTarget:1,articleReviewMode:'manual',qualifications:{software:'https://example.org/product',developer:'https://example.org/docs'},status:'ready',createdAt:intent.createdAt,analyzedAt:intent.createdAt};
  const task:Task={id:taskId,siteId,channelId:'slugpost',sourceDomain:'slugpost.com',status:'running',createdAt:intent.createdAt,scheduledAt:intent.createdAt,updatedAt:intent.createdAt,attempts:0,message:'fixture',topicUrl:'https://example.org/docs',draft:{title:'A useful software guide',description:'Independent guide',body:'An independently useful explanation. [Project documentation](https://example.org/docs).'},draftRevision:1,articleApprovedAt:intent.createdAt};
  const state=emptyState();state.settings.autoRun=true;state.sites=[site];state.tasks=[task];store.update(current=>Object.assign(current,state));
  const vault={get:async(key:string)=>{const cipher=store.getCipher(key);return cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():undefined},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))} as unknown as Vault;
  try{
    const identity=slugPostTaskIdentity(task,site)!;const fixed:SlugPostIntent={operationId:'slugpost_11111111111141118111111111111111',slug:identity.slug,sourceHash:identity.sourceHash,requestHash:identity.requestHash,createdAt:intent.createdAt};
    const persistence=createSlugPostPublicationPersistence(store,vault,{taskId,siteId,assertSubmissionAuthorized:()=>true});
    await persistence.persistIntent(fixed);assert.equal(persistence.assertReadyToSubmit(fixed),true);
    await assert.rejects(()=>persistence.persistIntent(fixed));
    assert.throws(()=>store.update(current=>{current.tasks[0].draft!.body+=' changed'}));
    const raw=slugPostOpaqueFromCapture(fixed,{status:200,mimeType:'application/json',url:'https://slugpost.com/publish',body:JSON.stringify({success:true,slug:fixed.slug,edit_token:'opaque_token_12345678'}),base64Encoded:false})!;
    await persistence.persistOpaqueResponse(raw);
    const receipt=parseSlugPostOpaque(raw,fixed,identity.content)!;await persistence.promoteReceipt(receipt);
    const saved=store.read();assert.equal(saved.tasks[0].slugPost?.stage,'ui_receipt');assert.equal(saved.tasks[0].publicUrl,receipt.publicUrl);assert.equal(JSON.stringify(saved).includes('opaque_token_12345678'),false);
    const secret=await vault.get('publication:'+taskId);assert.equal(JSON.parse(secret!).bodyBase64,raw.bodyBase64);
    assert.doesNotThrow(()=>validateBackup({state:saved,secrets:{['publication:'+taskId]:secret!}}));
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});

test('public acceptance requires the same full SSR article, native link and crawl policy',async()=>{
  const site={url:'https://example.org/'} as Site;
  const draft={title:'A useful software guide',description:'Independent guide',body:'An independently useful explanation. [Project documentation](https://example.org/docs).'};
  const task={id:'11111111-1111-4111-8111-111111111111',channelId:'slugpost',sourceDomain:'slugpost.com',topicUrl:'https://example.org/docs',draft,submittedAt:intent.createdAt,checkpoint:'slugpost_ui_receipt'} as Task;
  const identity=slugPostTaskIdentity(task,site)!;task.slugPost={operationId:'slugpost_11111111111141118111111111111111',slug:identity.slug,sourceHash:identity.sourceHash,requestHash:identity.requestHash,createdAt:intent.createdAt,stage:'ui_receipt'};task.publicUrl=slugPostPublicUrl(identity.slug);
  const html=(content=identity.content,robots='')=>`<!doctype html><html><head><title>${draft.title}</title><link rel="canonical" href="/${identity.slug}">${robots}</head><body><main><div class="prose">${String(marked.parse(content,{gfm:true,async:false}))}</div></main></body></html>`;
  let page=html(),robots='User-agent: *\nAllow: /\nDisallow: /api/';const publicFetch={resolve:async()=>[{address:'93.184.216.34',family:4 as const}],request:async(url:URL)=>({status:200,headers:{'content-type':url.pathname==='/robots.txt'?'text/plain':'text/html'},body:Buffer.from(url.pathname==='/robots.txt'?robots:page)})};
  const verify=()=>verifySlugPostPublication(task,site,'https://example.org/docs',{publicFetch},true);
  assert.equal((await verify()).found,true);
  assert.equal((await verifySlugPostPublication(task,site,'https://example.org/docs',{publicFetch},false)).found,false);
  page=html(identity.content,'<meta name="robots" content="noindex">');assert.equal((await verify()).found,false);
  page=html(identity.content.replace('https://example.org/docs','https://unrelated.example/'));assert.equal((await verify()).found,false);
  page=html();robots='User-agent: *\nAllow: /\n\nUser-agent: Googlebot\nDisallow: /';assert.equal((await verify()).found,false);
});

test('controller performs one official UI click and keeps the owned result across another tick',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'linkflow-slugpost-controller-')),store=new Store(join(dir,'state.sqlite'));
  const taskId='11111111-1111-4111-8111-111111111111',siteId='22222222-2222-4222-8222-222222222222',at='2026-10-13T10:17:00.000Z';
  const site:Site={id:siteId,domain:'example.org',url:'https://example.org/',email:'owner@example.org',name:'Example software',description:'Developer software',category:'software',language:'en',monthlyTarget:1,articleReviewMode:'manual',qualifications:{software:'https://example.org/product',developer:'https://example.org/docs'},status:'ready',createdAt:at,analyzedAt:at,topicsCheckedAt:new Date().toISOString(),topics:[{url:'https://example.org/docs',discoveredAt:at}]};
  const task:Task={id:taskId,siteId,channelId:'slugpost',sourceDomain:'slugpost.com',status:'queued',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'fixture',topicUrl:'https://example.org/docs',draft:{title:'A useful software guide',description:'Independent guide',body:'An independently useful explanation. [Project documentation](https://example.org/docs).'},draftRevision:1,articleApprovedAt:at};
  const identity=slugPostTaskIdentity(task,site)!,publicUrl=slugPostPublicUrl(identity.slug),state=emptyState();state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='manual';state.settings.timezone='UTC';state.sites=[site];state.tasks=[task];store.update(current=>Object.assign(current,state));
  const vault={ready:true,available:()=>true,get:async(key:string)=>{const cipher=store.getCipher(key);return cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():undefined},set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))} as unknown as Vault;
  let clicks=0;const events=new EventEmitter();let attached=false;
  const debuggerMock=Object.assign(events,{isAttached:()=>attached,attach:()=>{attached=true},sendCommand:async(method:string)=>method==='Network.getResponseBody'?{body:JSON.stringify({success:true,slug:identity.slug,edit_token:'opaque_token_12345678'}),base64Encoded:false}:{}});
  const web={debugger:debuggerMock,executeJavaScriptInIsolatedWorld:async(_world:number,commands:Array<{code:string}>)=>{const code=commands[0].code;if(code.includes('challenge:/captcha'))return {ok:true,challenge:false};if(code.includes("return buttons[0].disabled?'pending':'ready'"))return 'ready';if(code.includes('buttons[0].click()')){clicks++;queueMicrotask(()=>{events.emit('message',{},'Network.requestWillBeSent',{requestId:'one',request:{url:'https://slugpost.com/publish',method:'POST'}});events.emit('message',{},'Network.responseReceived',{requestId:'one',response:{url:'https://slugpost.com/publish',status:200,mimeType:'application/json'}});events.emit('message',{},'Network.loadingFinished',{requestId:'one'})});return true}return true}};
  const window={webContents:web,loadURL:async()=>{},isDestroyed:()=>false,destroy:()=>{}};
  const page=`<!doctype html><html><head><link rel="canonical" href="/${identity.slug}"></head><body><main><div class="prose">${String(marked.parse(identity.content,{gfm:true,async:false}))}</div></main></body></html>`;
  const publicFetch={resolve:async()=>[{address:'93.184.216.34',family:4 as const}],request:async(url:URL)=>({status:200,headers:{'content-type':url.pathname==='/robots.txt'?'text/plain':'text/html'},body:Buffer.from(url.pathname==='/robots.txt'?'User-agent: *\nAllow: /':page)})};
  const controller=new Controller(pinPublicationFixtures(store),vault,'fixture',{channelCatalog:[{...CHANNELS.find(value=>value.id==='slugpost')!,enabled:true,promotionPolicy:'allowed' as const}],slugPostDependencies:{createWindow:async()=>window as never,timeoutMs:1000,publicFetch}});controller.runtime.aiReady=true;
  try{await controller.tick();let result=store.read().tasks[0];assert.equal(clicks,1);assert.equal(result.publicUrl,publicUrl);assert.equal(result.slugPost?.stage,'published');assert.equal(result.status,'live');assert.deepEqual(result.slugPost?.boundaryJournal?.map(value=>value.stage),['armed','click_started']);await controller.tick();result=store.read().tasks[0];assert.equal(clicks,1);assert.equal(result.slugPost?.stage,'published');const secret=await vault.get('publication:'+taskId);assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets:{['publication:'+taskId]:secret!}}))}
  finally{controller.stop();store.close();rmSync(dir,{recursive:true,force:true})}
});

test('206 UI response remains encrypted and cannot trigger a second click',async()=>{
  const site={url:'https://example.org/'} as Site;
  const task={id:'11111111-1111-4111-8111-111111111111',channelId:'slugpost',sourceDomain:'slugpost.com',topicUrl:'https://example.org/docs',draft:{title:'A useful software guide',description:'Independent guide',body:'An independently useful explanation. [Project documentation](https://example.org/docs).'}} as Task;
  let saved:ReturnType<typeof opaque>|undefined,clicks=0;const events=new EventEmitter();let attached=false;
  const persistence:SlugPostPersistence={persistIntent:async()=>{},assertReadyToSubmit:()=>true,persistBoundary:()=>{},persistOpaqueResponse:async(value)=>{saved=value},loadOpaqueResponse:async()=>saved,promoteReceipt:async()=>{throw Error('206 must not promote')}};
  const debuggerMock=Object.assign(events,{isAttached:()=>attached,attach:()=>{attached=true},sendCommand:async(method:string)=>method==='Network.getResponseBody'?{body:JSON.stringify({success:true,slug:'wrong-slug',edit_token:'opaque_token_12345678'}),base64Encoded:false}:{}});
  const web={debugger:debuggerMock,executeJavaScriptInIsolatedWorld:async(_world:number,commands:Array<{code:string}>)=>{const code=commands[0].code;if(code.includes('challenge:/captcha'))return {ok:true,challenge:false};if(code.includes("return buttons[0].disabled?'pending':'ready'"))return 'ready';if(code.includes('buttons[0].click()')){clicks++;queueMicrotask(()=>{events.emit('message',{},'Network.requestWillBeSent',{requestId:'one',request:{url:'https://slugpost.com/publish',method:'POST'}});events.emit('message',{},'Network.responseReceived',{requestId:'one',response:{url:'https://slugpost.com/publish',status:206,mimeType:'application/json'}});events.emit('message',{},'Network.loadingFinished',{requestId:'one'})});return true}return true}};
  const window={webContents:web,loadURL:async()=>{},isDestroyed:()=>false,destroy:()=>{}};
  const context={site,task,channel:{id:'slugpost',domain:'slugpost.com',automation:'browser',articleRequired:true,accountRequired:false},slugPostPersistence:persistence,signal:new AbortController().signal} as ExecutionContext;
  const first=await runSlugPostTask(context,{createWindow:async()=>window as never,timeoutMs:1000});assert.equal(first.slugPost?.stage,'opaque_response');assert.equal(clicks,1);assert.equal(saved?.status,206);
  context.task={...task,slugPost:first.slugPost,submittedAt:first.submittedAt,checkpoint:first.checkpoint};
  const publicFetch={resolve:async()=>[{address:'93.184.216.34',family:4 as const}],request:async()=>({status:404,headers:{'content-type':'text/html'},body:Buffer.alloc(0)})};
  const second=await runSlugPostTask(context,{createWindow:async()=>{throw Error('unexpected browser')},timeoutMs:1000,publicFetch});assert.equal(second.slugPost?.stage,'opaque_response');assert.equal(clicks,1);
});

test('fresh Controller recovers the same encrypted response without reopening the publisher',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'linkflow-slugpost-recovery-')),store=new Store(join(dir,'state.sqlite'));
  const taskId='11111111-1111-4111-8111-111111111111',siteId='22222222-2222-4222-8222-222222222222',at='2026-10-13T10:17:00.000Z';
  const site:Site={id:siteId,domain:'example.org',url:'https://example.org/',email:'owner@example.org',name:'Example software',description:'Developer software',category:'software',language:'en',monthlyTarget:1,articleReviewMode:'manual',qualifications:{software:'https://example.org/product',developer:'https://example.org/docs'},status:'ready',createdAt:at,analyzedAt:at,topicsCheckedAt:new Date().toISOString()};
  const task:Task={id:taskId,siteId,channelId:'slugpost',sourceDomain:'slugpost.com',status:'review',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'fixture',topicUrl:'https://example.org/docs',draft:{title:'A useful software guide',description:'Independent guide',body:'An independently useful explanation. [Project documentation](https://example.org/docs).'},draftRevision:1,articleApprovedAt:at,health:'pending'};
  const identity=slugPostTaskIdentity(task,site)!,fixed:SlugPostIntent={operationId:'slugpost_11111111111141118111111111111111',slug:identity.slug,sourceHash:identity.sourceHash,requestHash:identity.requestHash,createdAt:at};
  task.slugPost={...fixed,stage:'opaque_response'};task.submittedAt=at;task.checkpoint='slugpost_opaque_response';
  const raw=slugPostOpaqueFromCapture(fixed,{status:200,mimeType:'application/json',url:'https://slugpost.com/publish',body:JSON.stringify({success:true,slug:fixed.slug,edit_token:'opaque_token_12345678'}),base64Encoded:false})!;
  const state=emptyState();state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='manual';state.sites=[site];state.tasks=[task];store.update(current=>Object.assign(current,state));
  const cipher=`enc:${Buffer.from(JSON.stringify(raw)).toString('base64url')}`;store.updateWithCiphers(()=>{},{['publication:'+taskId]:cipher});
  const vault={ready:true,available:()=>true,get:async(key:string)=>{const value=store.getCipher(key);return value?.startsWith('enc:')?Buffer.from(value.slice(4),'base64url').toString():undefined},set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))} as unknown as Vault;
  const page=`<!doctype html><html><head><link rel="canonical" href="/${fixed.slug}"></head><body><main><div class="prose">${String(marked.parse(identity.content,{gfm:true,async:false}))}</div></main></body></html>`;
  const publicFetch={resolve:async()=>[{address:'93.184.216.34',family:4 as const}],request:async(url:URL)=>({status:200,headers:{'content-type':url.pathname==='/robots.txt'?'text/plain':'text/html'},body:Buffer.from(url.pathname==='/robots.txt'?'User-agent: *\nAllow: /':page)})};
  const controller=new Controller(pinPublicationFixtures(store),vault,'fixture',{channelCatalog:[{...CHANNELS.find(value=>value.id==='slugpost')!,enabled:true,promotionPolicy:'allowed' as const}],slugPostDependencies:{createWindow:async()=>{throw Error('publisher must stay closed')},publicFetch}});controller.runtime.aiReady=true;
  try{await controller.tick();const result=store.read().tasks[0];assert.equal(result.status,'live');assert.equal(result.slugPost?.stage,'published');assert.equal(result.publicUrl,slugPostPublicUrl(fixed.slug));assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets:{['publication:'+taskId]:JSON.stringify(raw)}}))}
  finally{controller.stop();store.close();rmSync(dir,{recursive:true,force:true})}
});

test('a client-rendered editor may hydrate after loadURL without arming early',async()=>{
  const events=new EventEmitter(),boundaries:SlugPostBoundaryEvent[]=[];let inspections=0,clicks=0,saved=0;
  const debuggerMock=Object.assign(events,{isAttached:()=>false,attach:()=>{},sendCommand:async(method:string)=>method==='Network.getResponseBody'?{body:JSON.stringify({success:true,slug,edit_token:'opaque_token_12345678'}),base64Encoded:false}:{}});
  const window={webContents:{debugger:debuggerMock,executeJavaScriptInIsolatedWorld:async(_world:number,commands:Array<{code:string}>)=>{
    const code=commands[0].code;
    if(code.includes('challenge:/captcha')){inspections++;assert.equal(boundaries.length,0);assert.equal(clicks,0);return {ok:inspections>=4,challenge:false}}
    if(code.includes("return buttons[0].disabled?'pending':'ready'"))return 'ready';if(code.includes('buttons[0].click()')){clicks++;queueMicrotask(()=>{events.emit('message',{},'Network.requestWillBeSent',{requestId:'one',request:{url:'https://slugpost.com/publish',method:'POST'}});events.emit('message',{},'Network.responseReceived',{requestId:'one',response:{url:'https://slugpost.com/publish',status:200,mimeType:'application/json'}});events.emit('message',{},'Network.loadingFinished',{requestId:'one'})})}
    return true;
  }},loadURL:async()=>{},isDestroyed:()=>false,destroy:()=>{}};
  const persistence:SlugPostPersistence={persistIntent:async()=>{},assertReadyToSubmit:()=>true,persistBoundary:event=>boundaries.push(event),persistOpaqueResponse:async()=>{saved++},loadOpaqueResponse:async()=>undefined,promoteReceipt:async()=>{}};
  const result=await submitSlugPostUi({intent,content},persistence,{createWindow:async()=>window as never,timeoutMs:1000});
  assert.equal(result.status,'captured');assert.equal(inspections,4);assert.equal(clicks,1);assert.equal(saved,1);assert.deepEqual(boundaries.map(x=>x.stage),['armed','click_started']);
});

test('debounced slug availability GET enables the exact form before one guarded click',async()=>{
  const events=new EventEmitter(),boundaries:SlugPostBoundaryEvent[]=[];let filledAt=0,checks=0,clicks=0,saved=0;
  const debuggerMock=Object.assign(events,{isAttached:()=>false,attach:()=>{},sendCommand:async(method:string)=>method==='Network.getResponseBody'?{body:JSON.stringify({success:true,slug,edit_token:'opaque_token_12345678'}),base64Encoded:false}:{}});
  const window={webContents:{debugger:debuggerMock,executeJavaScriptInIsolatedWorld:async(_world:number,commands:Array<{code:string}>)=>{
    const code=commands[0].code;
    if(code.includes('challenge:/captcha'))return {ok:true,challenge:false,locationOk:true};
    if(code.includes('const set=(element,value,prototype)')){filledAt=Date.now();return true}
    if(code.includes("return buttons[0].disabled?'pending':'ready'")){checks++;assert.equal(boundaries.length,0);return Date.now()-filledAt>=1250?'ready':'pending'}
    if(code.includes('buttons[0].click()')){clicks++;assert.ok(Date.now()-filledAt>=1250);queueMicrotask(()=>{events.emit('message',{},'Network.requestWillBeSent',{requestId:'one',request:{url:'https://slugpost.com/publish',method:'POST'}});events.emit('message',{},'Network.responseReceived',{requestId:'one',response:{url:'https://slugpost.com/publish',status:200,mimeType:'application/json'}});events.emit('message',{},'Network.loadingFinished',{requestId:'one'})});return true}
    throw Error('unexpected script');
  }},loadURL:async()=>{},isDestroyed:()=>false,destroy:()=>{}};
  const persistence:SlugPostPersistence={persistIntent:async()=>{},assertReadyToSubmit:()=>true,persistBoundary:event=>boundaries.push(event),persistOpaqueResponse:async()=>{saved++},loadOpaqueResponse:async()=>undefined,promoteReceipt:async()=>{}};
  const result=await submitSlugPostUi({intent,content},persistence,{createWindow:async()=>window as never,timeoutMs:3000});
  assert.equal(result.status,'captured');assert.ok(checks>=10);assert.equal(clicks,1);assert.equal(saved,1);assert.deepEqual(boundaries.map(x=>x.stage),['armed','click_started']);
});

test('post-fill pending, cancellation, challenge, changed fields and closed window stop before arming',async()=>{
  for(const stop of ['timeout','cancel','challenge','changed','closed'] as const){
    const abort=new AbortController(),boundaries:SlugPostBoundaryEvent[]=[];let checks=0,clicks=0,closed=false;
    const debuggerMock=Object.assign(new EventEmitter(),{isAttached:()=>false,attach:()=>{},sendCommand:async()=>({})});
    const window={webContents:{debugger:debuggerMock,executeJavaScriptInIsolatedWorld:async(_world:number,commands:Array<{code:string}>)=>{
      const code=commands[0].code;if(code.includes('challenge:/captcha'))return {ok:true,challenge:false,locationOk:true};
      if(code.includes('const set=(element,value,prototype)'))return true;
      if(code.includes("return buttons[0].disabled?'pending':'ready'")){checks++;if(checks===2){if(stop==='cancel')abort.abort();if(stop==='closed')closed=true;if(stop==='challenge')return 'challenge';if(stop==='changed')return 'changed'}return 'pending'}
      if(code.includes('buttons[0].click()'))clicks++;throw Error('unexpected script');
    }},loadURL:async()=>{},isDestroyed:()=>closed,destroy:()=>{closed=true}};
    const persistence:SlugPostPersistence={persistIntent:async()=>{},assertReadyToSubmit:()=>true,persistBoundary:event=>boundaries.push(event),persistOpaqueResponse:async()=>{},loadOpaqueResponse:async()=>undefined,promoteReceipt:async()=>{}};
    const result=await submitSlugPostUi({intent,content},persistence,{createWindow:async()=>window as never,timeoutMs:1000,signal:abort.signal});
    assert.deepEqual(result,{status:'not_started',reason:{timeout:'editor_not_ready',cancel:'authorization_changed',challenge:'editor_unavailable_or_challenge',changed:'editor_changed',closed:'editor_changed'}[stop]});
    assert.equal(boundaries.length,0);assert.equal(clicks,0);assert.ok(checks>=2);
  }
});

test('an editor that never hydrates times out without filling, arming or clicking',async()=>{
  const boundaries:SlugPostBoundaryEvent[]=[];let inspections=0,otherScripts=0,destroyed=false;
  const debuggerMock=Object.assign(new EventEmitter(),{isAttached:()=>false,attach:()=>{},sendCommand:async()=>({})});
  const window={webContents:{debugger:debuggerMock,executeJavaScriptInIsolatedWorld:async(_world:number,commands:Array<{code:string}>)=>{if(commands[0].code.includes('challenge:/captcha')){inspections++;return {ok:false,challenge:false}}otherScripts++;return true}},loadURL:async()=>{},isDestroyed:()=>destroyed,destroy:()=>{destroyed=true}};
  const persistence:SlugPostPersistence={persistIntent:async()=>{},assertReadyToSubmit:()=>true,persistBoundary:event=>boundaries.push(event),persistOpaqueResponse:async()=>{},loadOpaqueResponse:async()=>undefined,promoteReceipt:async()=>{}};
  const started=Date.now(),result=await submitSlugPostUi({intent,content},persistence,{createWindow:async()=>window as never,timeoutMs:1000});
  assert.deepEqual(result,{status:'not_started',reason:'editor_loading_timeout'});assert.ok(inspections>=2&&inspections<=12);assert.equal(otherScripts,0);assert.equal(boundaries.length,0);assert.equal(destroyed,true);assert.ok(Date.now()-started<2000);
});

test('hydration polling stops on cancellation, challenge or unexpected location before any arm',async()=>{
  for(const stop of ['cancel','challenge','location'] as const){
    const abort=new AbortController(),boundaries:SlugPostBoundaryEvent[]=[];let inspections=0,otherScripts=0;
    const debuggerMock=Object.assign(new EventEmitter(),{isAttached:()=>false,attach:()=>{},sendCommand:async()=>({})});
    const window={webContents:{debugger:debuggerMock,executeJavaScriptInIsolatedWorld:async(_world:number,commands:Array<{code:string}>)=>{if(!commands[0].code.includes('challenge:/captcha')){otherScripts++;return true}inspections++;if(inspections===2){if(stop==='cancel')abort.abort();return {ok:false,challenge:stop==='challenge',locationOk:stop!=='location'}}return {ok:false,challenge:false}}},loadURL:async()=>{},isDestroyed:()=>false,destroy:()=>{}};
    const persistence:SlugPostPersistence={persistIntent:async()=>{},assertReadyToSubmit:()=>true,persistBoundary:event=>boundaries.push(event),persistOpaqueResponse:async()=>{},loadOpaqueResponse:async()=>undefined,promoteReceipt:async()=>{}};
    const result=await submitSlugPostUi({intent,content},persistence,{createWindow:async()=>window as never,timeoutMs:1000,signal:abort.signal});
    assert.equal(result.status,'not_started');assert.equal(result.reason,stop==='cancel'?'authorization_changed':stop==='challenge'?'editor_unavailable_or_challenge':'editor_changed');assert.equal(inspections,2);assert.equal(otherScripts,0);assert.equal(boundaries.length,0);
  }
});

test('a reopened Controller resumes the same proven unarmed intent with one first click',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'linkflow-slugpost-resume-'));let store=new Store(join(dir,'state.sqlite'));
  const taskId='11111111-1111-4111-8111-111111111111',siteId='22222222-2222-4222-8222-222222222222',at='2026-10-13T10:17:00.000Z';
  const site:Site={id:siteId,domain:'example.org',url:'https://example.org/',email:'owner@example.org',name:'Example software',description:'Developer software',category:'software',language:'en',monthlyTarget:1,articleReviewMode:'manual',qualifications:{software:'https://example.org/product',developer:'https://example.org/docs'},status:'ready',createdAt:at,analyzedAt:at,topicsCheckedAt:new Date().toISOString(),topics:[{url:'https://example.org/docs',discoveredAt:at}]};
  const task:Task={id:taskId,siteId,channelId:'slugpost',sourceDomain:'slugpost.com',status:'queued',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'fixture',topicUrl:'https://example.org/docs',draft:{title:'A useful software guide',description:'Independent guide',body:'An independently useful explanation. [Project documentation](https://example.org/docs).'},draftRevision:1,articleApprovedAt:at};
  const identity=slugPostTaskIdentity(task,site)!,publicUrl=slugPostPublicUrl(identity.slug),state=emptyState();state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='manual';state.settings.timezone='UTC';state.sites=[site];state.tasks=[task];store.update(current=>Object.assign(current,state));
  const vault={ready:true,available:()=>true,get:async(key:string)=>{const cipher=store.getCipher(key);return cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():undefined},set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))} as unknown as Vault;
  let clicks=0,opens=0;const events=new EventEmitter();let attached=false;
  const debuggerMock=Object.assign(events,{isAttached:()=>attached,attach:()=>{attached=true},sendCommand:async(method:string)=>method==='Network.getResponseBody'?{body:JSON.stringify({success:true,slug:identity.slug,edit_token:'opaque_token_12345678'}),base64Encoded:false}:{}});
  const web={debugger:debuggerMock,executeJavaScriptInIsolatedWorld:async(_world:number,commands:Array<{code:string}>)=>{const code=commands[0].code;if(code.includes('challenge:/captcha'))return {ok:true,challenge:false};if(code.includes("return buttons[0].disabled?'pending':'ready'"))return 'ready';if(code.includes('buttons[0].click()')){clicks++;queueMicrotask(()=>{events.emit('message',{},'Network.requestWillBeSent',{requestId:'one',request:{url:'https://slugpost.com/publish',method:'POST'}});events.emit('message',{},'Network.responseReceived',{requestId:'one',response:{url:'https://slugpost.com/publish',status:200,mimeType:'application/json'}});events.emit('message',{},'Network.loadingFinished',{requestId:'one'})});return true}return true}};
  const window={webContents:web,loadURL:async()=>{if(++opens===1)throw Error('synthetic initial navigation failed before any arm')},isDestroyed:()=>false,destroy:()=>{}};
  const page=`<!doctype html><html><head><link rel="canonical" href="/${identity.slug}"></head><body><main><div class="prose">${String(marked.parse(identity.content,{gfm:true,async:false}))}</div></main></body></html>`;
  const publicFetch={resolve:async()=>[{address:'93.184.216.34',family:4 as const}],request:async(url:URL)=>({status:200,headers:{'content-type':url.pathname==='/robots.txt'?'text/plain':'text/html'},body:Buffer.from(url.pathname==='/robots.txt'?'User-agent: *\nAllow: /':page)})};
  const services={channelCatalog:[{...CHANNELS.find(value=>value.id==='slugpost')!,enabled:true,promotionPolicy:'allowed' as const}],slugPostDependencies:{createWindow:async()=>window as never,timeoutMs:1000,publicFetch}};
  let controller=new Controller(pinPublicationFixtures(store),vault,'fixture',services);controller.runtime.aiReady=true;
  try{await controller.tick();const before=store.read().tasks[0];assert.equal(clicks,0);assert.deepEqual(before.slugPost?.boundaryJournal,[]);assert.equal(slugPostPreflightNeverArmed(before),true);assert.equal(before.message.includes('编辑器打开或检查失败'),true);controller.stop();store.close();store=new Store(join(dir,'state.sqlite'));controller=new Controller(pinPublicationFixtures(store),vault,'fixture',services);controller.runtime.aiReady=true;await controller.tick();let result=store.read().tasks[0];assert.equal(result.slugPost?.operationId,before.slugPost?.operationId);assert.equal(result.slugPost?.slug,before.slugPost?.slug);assert.equal(result.submittedAt,before.submittedAt);assert.equal(clicks,1);assert.equal(result.publicUrl,publicUrl);assert.equal(result.slugPost?.stage,'published');assert.equal(result.status,'live');assert.deepEqual(result.slugPost?.boundaryJournal?.map(value=>value.stage),['armed','click_started']);await controller.tick();result=store.read().tasks[0];assert.equal(clicks,1);assert.equal(result.slugPost?.stage,'published');const secret=await vault.get('publication:'+taskId);assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets:{['publication:'+taskId]:secret!}}))}
  finally{controller.stop();store.close();rmSync(dir,{recursive:true,force:true})}
});

test('unarmed continuation excludes legacy, armed, public and stopped tasks',()=>{
  const current={status:'review',slugPost:{...intent,stage:'submitting',boundaryJournal:[]}} as unknown as Task;
  assert.equal(slugPostPreflightNeverArmed(current),true);
  for(const changed of [{...current,slugPost:{...intent,stage:'submitting'}},{...current,slugPost:{...current.slugPost!,boundaryJournal:[{sequence:1,stage:'armed',at:intent.createdAt,requestHash:intent.requestHash}]}},{...current,publicUrl:slugPostPublicUrl(slug)},{...current,status:'skipped'},{...current,slugPost:{...current.slugPost!,stage:'opaque_response'}}])assert.equal(slugPostPreflightNeverArmed(changed as Task),false);
});
