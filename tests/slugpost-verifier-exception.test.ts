import {strict as assert} from 'node:assert';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {parseSlugPostOpaque,slugPostOpaqueFromCapture,slugPostRequest,slugPostPublicUrl,type SlugPostIntent,type SlugPostPersistence} from '../src/integrations/slugpost';
import {submitSlugPostUi} from '../src/integrations/slugpost-browser';
import {runSlugPostTask,verifySlugPostPublication} from '../src/integrations/slugpost-publisher';
import {CHANNELS} from '../src/integrations/catalog';
import {Controller} from '../src/main/controller';
import {marked} from 'marked';
import {createSlugPostPublicationPersistence,slugPostTaskIdentity} from '../src/main/slugpost-publication';
import {emptyState,Store} from '../src/main/store';
import {validateBackup} from '../src/main/backup-validation';
import type {ExecutionContext,Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';
test('first verifier exception leaves a restorable pending SlugPost receipt',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'linkflow-slugpost-controller-')),store=new Store(join(dir,'state.sqlite'));
  const taskId='11111111-1111-4111-8111-111111111111',siteId='22222222-2222-4222-8222-222222222222',at='2026-10-13T00:00:00.000Z';
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
  const controller=new Controller(store,vault,'fixture',{channelCatalog:[{...CHANNELS.find(value=>value.id==='slugpost')!,enabled:true}],verifySlugPost:async()=>{throw Error('synthetic verifier exception')},slugPostDependencies:{createWindow:async()=>window as never,timeoutMs:1000,publicFetch}});controller.runtime.aiReady=true;
  try{await controller.tick();const result=store.read().tasks[0];const secret=await vault.get('publication:'+taskId);let backupError='';try{validateBackup({state:store.read(),secrets:{['publication:'+taskId]:secret!}})}catch(e){backupError=String(e)};assert.equal(clicks,1);assert.equal(result.slugPost?.stage,'ui_receipt');assert.equal(result.health,'pending');assert.equal(backupError,'')}
  finally{controller.stop();store.close();rmSync(dir,{recursive:true,force:true})}
});
