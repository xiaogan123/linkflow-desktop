import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {marked} from 'marked';
import {CHANNELS} from '../src/integrations/catalog';
import {createPstrsPaste,pstrsPublicUrl,pstrsRequest,type PstrsIntent,type PstrsOpaqueResponse,type PstrsPersistence} from '../src/integrations/pstrs';
import {runPstrsTask,verifyPstrsPublication} from '../src/integrations/pstrs-publisher';
import {validateBackup} from '../src/main/backup-validation';
import {Controller,isConfirmedPstrsResultUrl} from '../src/main/controller';
import {pstrsTaskIdentity} from '../src/main/pstrs-publication';
import {emptyState,Store} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import type {ExecutionContext,Site,Task} from '../src/shared/types';

const at='2026-10-13T03:00:00.000Z',taskId='11111111-1111-4111-8111-111111111111',siteId='22222222-2222-4222-8222-222222222222',id='Abc_def-123',publicUrl=pstrsPublicUrl(id),expiresAt=Math.floor((Date.parse(at)+365*86400000)/1000);
const draft={title:'A safe request recovery guide',description:'Practical developer guide',body:'Before retrying a request, save its intent. The [project guide](https://example.test/guide) explains the complete recovery process.'};
function site():Site{return {id:siteId,domain:'example.test',url:'https://example.test/',email:'owner@example.test',name:'Example software',description:'Developer software',category:'software',language:'en',monthlyTarget:1,articleReviewMode:'manual',qualifications:{software:'https://example.test/product',developer:'https://example.test/guide'},status:'ready',createdAt:at,analyzedAt:at,topicsCheckedAt:at,topics:[{url:'https://example.test/guide',discoveredAt:at}]}}
function task(extra:Partial<Task>={}):Task{return {id:taskId,siteId,channelId:'pstrs',sourceDomain:'paster.abhicracker.com',status:'review',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'fixture',topicUrl:'https://example.test/guide',draft,draftRevision:1,articleApprovedAt:at,health:'pending',...extra}}
function identity(){const value=pstrsTaskIdentity(task(),site());assert.ok(value);return value}
function intent():PstrsIntent{const value=identity();return {operationId:'pstrs_11111111111141118111111111111111',sourceHash:value.sourceHash,requestHash:value.requestHash,createdAt:at}}
function response(status=201,body=JSON.stringify({id,url:`https://paster.abhicracker.com/${id}`,token:'fixture-token',expires_at:expiresAt})){return new Response(body,{status,headers:{'content-type':'application/json','x-paste-token':'fixture-token'}})}
function memory(){let attempted=false,opaque:PstrsOpaqueResponse|undefined,receipt:unknown;const order:string[]=[];const persistence:PstrsPersistence={async persistIntent(){if(attempted)throw Error('repeated');attempted=true;order.push('intent')},assertReadyToSubmit(){return true},async persistOpaqueResponse(value){opaque=value;order.push('opaque')},async loadOpaqueResponse(){return opaque},async promoteReceipt(value){receipt=value;order.push('receipt')}};return {persistence,order,getOpaque:()=>opaque,getReceipt:()=>receipt}}
function published(expires=expiresAt){return task({submittedAt:at,publicUrl,checkpoint:'pstrs_api_receipt',pstrs:{...intent(),stage:'api_receipt',id,expiresAt:expires}})}
function html(content=identity().content,robots=''){return `<!doctype html><html><head>${robots}</head><body><main><article>${String(marked.parse(content,{gfm:true,async:false}))}</article></main></body></html>`}
function fixture(){const dir=mkdtempSync(join(tmpdir(),'linkflow-pstrs-controller-')),store=new Store(join(dir,'state.sqlite')),state=emptyState();state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='manual';state.settings.timezone='UTC';state.settings.channelOverrides={pstrs:true};state.sites=[site()];state.tasks=[task({status:'queued'})];store.update(current=>Object.assign(current,state));return {dir,store,cleanup(){store.close();rmSync(dir,{recursive:true,force:true})}}}
function vault(store:Store):Vault{return {ready:true,available:()=>true,get:async(key:string)=>{const cipher=store.getCipher(key);return cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():undefined},set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))} as unknown as Vault}


test('PST.RS controller: failed first readback and verifier exception preserve restorable pending receipt',async()=>{
 for(const mode of ['raw-mismatch','transport','verifier-throws'] as const){const f=fixture(),v=vault(f.store),channel={...CHANNELS.find(x=>x.id==='pstrs')!,enabled:true};let posts=0;const controller=new Controller(f.store,v,'fixture',{channelCatalog:[channel],...(mode==='verifier-throws'?{verifyPstrs:async()=>{throw Error('simulated')}}:{}),pstrsDependencies:{now:()=>new Date(at),fetch:async(url,init)=>{if(init.method==='POST'){posts++;return response()}if(mode==='transport')throw Error('network');return new Response('mismatch',{headers:{'content-type':'text/plain'}})}}});controller.runtime.aiReady=true;
 try{await controller.tick();const state=f.store.read(),t=state.tasks[0],secret=await v.get('publication:'+taskId);assert.equal(posts,1);assert.equal(t.pstrs?.stage,'api_receipt');assert.equal(t.health,'pending',mode);assert.equal(t.linkCheck,undefined,mode);assert.doesNotThrow(()=>validateBackup({state,secrets:{['publication:'+taskId]:secret!}}),mode)}finally{controller.stop();f.cleanup()}}
});

test('PST.RS controller: opaque response fresh-controller recovery is read-only and produces restorable published receipt',async()=>{const m=memory();await createPstrsPaste({operationId:intent().operationId,content:identity().content,reviewed:true},m.persistence,{now:()=>new Date(at),fetch:async()=>response()});const f=fixture(),v=vault(f.store),channel={...CHANNELS.find(x=>x.id==='pstrs')!,enabled:true},secret=JSON.stringify(m.getOpaque());f.store.updateWithCiphers(st=>{st.tasks=[task({submittedAt:at,checkpoint:'pstrs_opaque_response',pstrs:{...intent(),stage:'opaque_response'}})]},v.encryptSecrets({['publication:'+taskId]:secret}));const calls:string[]=[];const c=new Controller(f.store,v,'fixture',{channelCatalog:[channel],pstrsDependencies:{now:()=>new Date(at),fetch:async(u,i)=>{calls.push(i.method??'GET');assert.equal(i.method,'GET');return new Response(u.includes('/raw/')?identity().content:u.endsWith('/robots.txt')?'User-agent: *\nAllow: /':html(),{headers:{'content-type':u.endsWith('.md')?'text/html':'text/plain'}})}}});c.runtime.aiReady=true;try{await c.tick();const st=f.store.read();assert.equal(st.tasks[0].status,'live',JSON.stringify(st.tasks[0]));assert.equal(st.tasks[0].pstrs?.stage,'published');assert.deepEqual(calls,['GET','GET','GET']);assert.doesNotThrow(()=>validateBackup({state:st,secrets:{['publication:'+taskId]:secret}}));}finally{c.stop();f.cleanup()}});
