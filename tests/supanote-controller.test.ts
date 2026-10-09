import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {marked} from 'marked';
import {CHANNELS} from '../src/integrations/catalog';
import type {SupanoteTransport} from '../src/integrations/supanote';
import {Controller} from '../src/main/controller';
import {nextTask} from '../src/main/planner';
import {validateBackup} from '../src/main/backup-validation';
import {parseSupanotePublicationSecret,supanoteTaskContentHash} from '../src/main/supanote-publication';
import {Store,emptyState} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import type {ExecutionContext,Site,Task} from '../src/shared/types';

const stamp='2026-10-09T00:00:00.000Z';
const taskId='11111111-1111-4111-8111-111111111111';
const siteId='22222222-2222-4222-8222-222222222222';
const publicId='note_cycle_44';
const publicUrl=`https://supanote.app/n/${publicId}`;
const token='manage_cycle_44_secret';
const draft={title:'A reviewed Supanote guide',description:'Fixture',body:'# A reviewed Supanote guide\n\nA complete reviewed Markdown guide with the original [source](https://example.test/guide).'};

function channel(){const value=CHANNELS.find(item=>item.id==='supanote');assert.ok(value);return value}
async function enabled<T>(run:()=>Promise<T>):Promise<T>{const value=channel(),before=value.enabled;value.enabled=true;try{return await run()}finally{value.enabled=before}}
function site():Site{return {id:siteId,domain:'example.test',url:'https://example.test/',email:'owner@example.test',name:'Example',description:'Independent guides',category:'content',language:'en',monthlyTarget:1,articleReviewMode:'manual',status:'ready',createdAt:stamp,analyzedAt:stamp,topicsCheckedAt:new Date().toISOString(),topics:[{url:'https://example.test/guide',discoveredAt:stamp}]}}
function task(extra:Partial<Task>={}):Task{return {id:taskId,siteId,channelId:'supanote',sourceDomain:'supanote.app',status:'queued',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',topicUrl:'https://example.test/guide',draft,draftRevision:1,articleApprovedAt:stamp,health:'pending',...extra}}
function configure(store:Store,taskValue=task()){const state=emptyState();state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='manual';state.settings.timezone='UTC';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='supanote']));state.sites=[site()];state.tasks=[taskValue];store.update(current=>Object.assign(current,state))}
function vault(store:Store,available=true):Vault{return {ready:available,available:()=>available,get:async(key:string)=>store.getCipher(key),set:async(key:string,value:string)=>store.setCipher(key,value),delete:async(key:string)=>store.deleteCipher(key),encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))} as unknown as Vault}
function fixture(taskValue=task()){const directory=mkdtempSync(join(tmpdir(),'linkflow-supanote-controller-')),path=join(directory,'state.sqlite'),store=new Store(path);configure(store,taskValue);return {directory,path,store,cleanup(){try{store.close()}catch{}rmSync(directory,{recursive:true,force:true})}}}
function publicHtml(valid=false){const rendered=String(marked.parse(valid?draft.body:'Different public body.',{async:false,gfm:true})).replaceAll('<a href=',`<a rel="ugc nofollow noopener noreferrer" href=`);return `<!doctype html><html><head><link rel="canonical" href="${publicUrl}"><meta name="robots" content="index,follow"></head><body><div id="note-view-container"><div data-tab-content="tab-rendered" class="prose-content">${rendered}</div></div></body></html>`}
function transport(store:Store,requests:Array<{method:string;url:string;body?:string}>,validPublic=false):SupanoteTransport{return async(url,init)=>{const method=init.method??'GET',body=typeof init.body==='string'?init.body:undefined;requests.push({method,url,...(body?{body}:{})});if(method==='POST'){const saved=store.read().tasks[0];assert.equal(saved.articleApprovedAt,stamp);assert.equal(saved.checkpoint,'supanote_publish_submitting');assert.equal(saved.supanote?.stage,'submitting');assert.equal(saved.submittedAt,saved.supanote?.createdAt);assert.deepEqual(JSON.parse(body!),{title:draft.title,content:draft.body,contentType:'markdown',visibility:'public',expiration:'never'});return new Response(JSON.stringify({publicId,url:`${publicUrl}?token=${token}&created=1`}),{status:200,headers:{'content-type':'application/json'}})}if(url===`https://supanote.app/api/v1/notes/${publicId}`)return new Response(JSON.stringify({success:true,data:{publicId,title:draft.title,content:draft.body,contentType:'markdown',visibility:'public',expiresAt:null}}),{status:200,headers:{'content-type':'application/json'}});if(url==='https://supanote.app/robots.txt')return new Response('User-agent: *\nAllow: /',{status:200,headers:{'content-type':'text/plain'}});assert.equal(url,publicUrl);return new Response(publicHtml(validPublic),{status:200,headers:{'content-type':'text/html'}})}}

test('disabled Supanote cannot be scheduled even when a settings override is true',async()=>{
  const f=fixture(),value=channel(),before=value.enabled;value.enabled=false;try{const controller=new Controller(f.store,vault(f.store),'fixture');controller.runtime.aiReady=true;await controller.tick();const saved=f.store.read().tasks[0];assert.equal(saved.status,'skipped');assert.equal(saved.submittedAt,undefined);assert.equal(saved.supanote,undefined)}finally{value.enabled=before;f.cleanup()}
});

test('enabled Supanote is a planner-ready no-account route',()=>{
  const state=emptyState();state.settings.autoRun=true;state.settings.channelOverrides={supanote:true};state.sites=[site()];state.tasks=[task()];assert.equal(channel().enabled,true);assert.equal(nextTask(state,new Date(stamp),CHANNELS)?.id,taskId);
});

test('the real Controller dispatcher claims once, encrypts the token, and keeps API-only evidence pending',async()=>enabled(async()=>{
  const f=fixture(),requests:Array<{method:string;url:string;body?:string}>=[];
  const controller=new Controller(f.store,vault(f.store),'fixture',{supanoteDependencies:{fetch:transport(f.store,requests)}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=f.store.read().tasks[0],cipher=f.store.getCipher('publication:'+taskId);assert.equal(requests.filter(item=>item.method==='POST').length,1);assert.equal(requests.filter(item=>item.method==='GET').length,3);assert.equal(saved.status,'review');assert.equal(saved.health,'pending');assert.equal(saved.linkCheck,undefined);assert.equal(saved.firstLiveAt,undefined);assert.equal(saved.verifiedAt,undefined);assert.equal(saved.checkpoint,'supanote_api_receipt');assert.equal(saved.publicUrl,publicUrl);assert.equal(saved.supanote?.stage,'api_receipt');assert.equal(saved.supanote?.contentHash,supanoteTaskContentHash(saved));assert.ok(cipher?.startsWith('enc:'));assert.equal(cipher?.includes(token),false);const envelope=JSON.parse(Buffer.from(cipher!.slice(4),'base64url').toString());assert.deepEqual(parseSupanotePublicationSecret(JSON.stringify(envelope)),envelope);assert.equal(JSON.stringify(saved).includes(token),false);assert.equal(f.store.read().events.some(event=>event.message.includes(token)),false)}finally{f.cleanup()}
}));

test('exact visible fulltext promotes the original receipt and produces a restorable backup',async()=>enabled(async()=>{
  const f=fixture(),requests:Array<{method:string;url:string;body?:string}>=[],controller=new Controller(f.store,vault(f.store),'fixture',{supanoteDependencies:{fetch:transport(f.store,requests,true)}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=f.store.read().tasks[0];assert.equal(requests.filter(item=>item.method==='POST').length,1);assert.equal(requests.filter(item=>item.method==='GET').length,3);assert.equal(saved.status,'live');assert.equal(saved.health,'healthy');assert.equal(saved.linkCheck,'found');assert.equal(saved.checkpoint,'supanote_published');assert.equal(saved.supanote?.stage,'published');assert.equal(saved.publicUrl,publicUrl);assert.match(saved.linkRel??'',/nofollow/);const restored=validateBackup({state:f.store.read(),secrets:{['publication:'+taskId]:JSON.stringify({version:1,taskId,publicId,publicUrl,token})}});assert.equal(restored.state.tasks[0].supanote?.stage,'published');assert.equal(restored.state.tasks[0].status,'live') }finally{f.cleanup()}
}));

test('SQLite restart performs read-only reconciliation and never sends a replacement POST',async()=>enabled(async()=>{
  const f=fixture(),first:Array<{method:string;url:string;body?:string}>=[];let reopened:Store|undefined;
  try{const initial=new Controller(f.store,vault(f.store),'fixture',{supanoteDependencies:{fetch:transport(f.store,first)}});initial.runtime.aiReady=true;await initial.tick();f.store.close();reopened=new Store(f.path);const second:Array<{method:string;url:string;body?:string}>=[];const controller=new Controller(reopened,vault(reopened),'fixture',{supanoteDependencies:{fetch:transport(reopened,second)}});controller.runtime.aiReady=true;await controller.tick();const saved=reopened.read().tasks[0];assert.equal(first.filter(item=>item.method==='POST').length,1);assert.equal(second.filter(item=>item.method==='POST').length,0);assert.ok(second.length>=1);assert.ok(second.every(item=>item.method==='GET'));assert.equal(saved.supanote?.stage,'api_receipt');assert.equal(saved.status,'review');assert.equal(saved.health,'pending')}
  finally{try{reopened?.close()}catch{}rmSync(f.directory,{recursive:true,force:true})}
}));

test('a receipt and encrypted token for the original claim survive a controller pause',async()=>enabled(async()=>{
  const f=fixture(),controller=new Controller(f.store,vault(f.store),'fixture');controller.runtime.aiReady=true;f.store.update(state=>{state.tasks[0].status='running';state.tasks[0].attempts=1});
  try{const current=f.store.read().tasks[0],context=(controller as unknown as {context(task:Task,signal:AbortSignal):ExecutionContext}).context(current,new AbortController().signal),persistence=context.supanotePersistence;assert.ok(persistence);const intent={operationId:'supanote_11111111111141118111111111111111',contentHash:supanoteTaskContentHash(current)!,createdAt:new Date().toISOString()};await persistence.persistIntent(intent);controller.pause();await persistence.persistReceipt({publicId,publicUrl,contentHash:intent.contentHash});await persistence.persistManageToken({publicId,token});const saved=f.store.read().tasks[0];assert.equal(f.store.read().settings.autoRun,false);assert.equal(saved.supanote?.operationId,intent.operationId);assert.equal(saved.supanote?.stage,'api_receipt');assert.equal(saved.publicUrl,publicUrl);assert.ok(f.store.getCipher('publication:'+taskId)?.startsWith('enc:'))}finally{f.cleanup()}
}));

test('a late public verifier result cannot promote a changed draft or receipt',async()=>enabled(async()=>{
  const pending=task({status:'review',submittedAt:stamp,checkpoint:'supanote_api_receipt',publicUrl,supanote:{operationId:'supanote_11111111111141118111111111111111',contentHash:'',createdAt:stamp,stage:'api_receipt',publicId}});pending.supanote!.contentHash=supanoteTaskContentHash(pending)!;
  const f=fixture(pending),controller=new Controller(f.store,vault(f.store),'fixture',{verifySupanote:async()=>{f.store.update(state=>{state.tasks[0].draft!.body+=' changed while verifying'});return {found:true,outcome:'found',url:publicUrl,rel:'nofollow ugc',reason:'synthetic visible match'}}});controller.runtime.aiReady=true;
  try{await controller.verify(taskId);const state=f.store.read(),saved=state.tasks[0];assert.equal(saved.status,'review');assert.equal(saved.supanote?.stage,'api_receipt');assert.equal(saved.checkpoint,'supanote_api_receipt');assert.equal(saved.firstLiveAt,undefined);assert.equal(saved.linkCheck,undefined);assert.equal(state.events.some(event=>event.taskId===taskId&&event.message.includes('外链已核验生效')),false)}finally{f.cleanup()}
}));
