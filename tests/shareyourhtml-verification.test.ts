import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {renderShareYourHtmlArticle} from '../src/integrations/shareyourhtml-article';
import type {ShareYourHtmlReadbackResult} from '../src/integrations/shareyourhtml-verifier';
import {verifyStoredShareYourHtmlPublication} from '../src/main/shareyourhtml-verification';
import {shareYourHtmlDraftHash,shareYourHtmlSiteIdentityHash} from '../src/main/shareyourhtml-publication';
import {Store} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import type {Channel,Site,Task} from '../src/shared/types';

const taskId='11111111-1111-4111-8111-111111111111',siteId='22222222-2222-4222-8222-222222222222';
const slug='lf-11111111111141118111111111111111',url=`https://${slug}.shareyourhtml.com`,topic='https://example.com/guides/reviewed-topic';
const created='2026-10-09T00:00:00.000Z',checked='2026-10-10T00:00:00.000Z',editKey='01234567-89ab-cdef-0123-456789abcdef';
const draft={title:'Reviewed article',description:'Exact description',body:`## Detail\n\nSee the [reviewed topic](${topic}).`};
function site():Site{return {id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Fixture',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:created,topics:[{url:topic,discoveredAt:created}]}}
function channel():Channel{return {id:'shareyourhtml',name:'ShareYourHTML',domain:'shareyourhtml.com',url:'https://shareyourhtml.com/',submitUrl:'https://shareyourhtml.com/pages',categories:['content'],languages:['*'],kind:'article',emailRequired:false,accountRequired:false,articleRequired:true,free:'yes',freeNote:'Fixture',automation:'api',quality:'B',qualityReason:'Fixture',provenance:'custom',requirements:[],evidenceStatus:'rules_checked',rulesUrl:'https://shareyourhtml.com/terms',checkedAt:'2026-10-09',notes:'Fixture',allowedHosts:['shareyourhtml.com'],enabled:true}}
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'syh-verify-')),store=new Store(join(dir,'state.sqlite')),s=site(),c=channel(),rendered=renderShareYourHtmlArticle({draft,targetUrl:topic,language:'en',slug});
 const claim:NonNullable<Task['shareYourHtml']>={operationId:'shareyourhtml_11111111111141118111111111111111',slug,sourceHash:rendered.sourceHash,requestHash:rendered.requestHash,createdAt:created,stage:'api_receipt',requestedExpiry:'never',publicVerification:'pending',reviewedDraftRevision:4,reviewedDraftHash:shareYourHtmlDraftHash(draft),siteId,siteIdentityHash:shareYourHtmlSiteIdentityHash(s)};
 const task:Task={id:taskId,siteId,channelId:'shareyourhtml',sourceDomain:'shareyourhtml.com',status:'review',health:'pending',createdAt:created,scheduledAt:created,updatedAt:created,attempts:1,message:'Pending',topicUrl:topic,draft:structuredClone(draft),draftRevision:4,submittedAt:created,publicUrl:url,checkpoint:'shareyourhtml_api_receipt',shareYourHtml:claim};
 const secret=JSON.stringify({version:1,taskId,operationId:claim.operationId,slug,publicUrl:url,sourceHash:claim.sourceHash,requestHash:claim.requestHash,reviewedDraftHash:claim.reviewedDraftHash,reviewedDraftRevision:4,siteId,siteIdentityHash:claim.siteIdentityHash,editKey});
 store.restore({...store.read(),sites:[s],tasks:[task],customChannels:[c],settings:{...store.read().settings,channelOverrides:{shareyourhtml:true}}},{[`publication:${taskId}`]:'cipher'});
 const vault={get:async()=>secret} as unknown as Vault,resolve=(state:ReturnType<Store['read']>)=>state.customChannels?.[0];
 return {store,vault,resolve,cleanup(){store.close();rmSync(dir,{recursive:true,force:true})}};
}
const visible=(page:'not_restricted'|'restricted'='not_restricted'):ShareYourHtmlReadbackResult=>({status:'visible_match',message:'raw ignored',publicUrl:url,content:'visible',targetLinks:[{href:topic,rel:['nofollow','ugc']}],indexing:{page,directives:page==='restricted'?['noindex']:[],robots:'unknown'}});
const failed=(status:'visibility_unknown'|'content_mismatch'|'unreachable'):ShareYourHtmlReadbackResult=>({status,message:'raw ignored',publicUrl:url,content:status==='content_mismatch'?'mismatch':'unknown',targetLinks:[],indexing:{page:'unknown',directives:[],robots:'unknown'}});

test('trusted wrapper verifies exact receipt and keeps noindex separate from visible content',async()=>{const f=fixture();try{
 const out=await verifyStoredShareYourHtmlPublication(f.store,f.vault,{taskId,resolveChannel:f.resolve,now:()=>new Date(checked)},{verifyReadback:async()=>visible('restricted')});
 assert.equal(out.status,'verified');const t=f.store.read().tasks[0];assert.equal(t.status,'live');assert.equal(t.health,'healthy');assert.equal(t.firstLiveAt,checked);assert.equal(t.verifiedAt,checked);assert.equal(t.linkRel,'nofollow ugc');assert.equal(t.shareYourHtmlReadback?.indexing.page,'restricted');assert.equal(t.shareYourHtml?.publicVerification,'pending');assert.equal(f.store.getCipher(`publication:${taskId}`),'cipher');
}finally{f.cleanup()}});

test('unknown first readback records evidence without minting first live',async()=>{const f=fixture();try{
 const out=await verifyStoredShareYourHtmlPublication(f.store,f.vault,{taskId,resolveChannel:f.resolve,now:()=>new Date(checked)},{verifyReadback:async()=>failed('visibility_unknown')});
 assert.equal(out.status,'pending');const t=f.store.read().tasks[0];assert.equal(t.status,'review');assert.equal(t.health,'unknown');assert.equal(t.firstLiveAt,undefined);assert.equal(t.verifiedAt,undefined);assert.equal(t.linkCheck,'invalid');assert.equal(t.shareYourHtmlReadback?.status,'visibility_unknown');
}finally{f.cleanup()}});

test('loss and recovery preserve original first-live identity and ciphertext',async()=>{const f=fixture();try{
 await verifyStoredShareYourHtmlPublication(f.store,f.vault,{taskId,resolveChannel:f.resolve,now:()=>new Date(checked)},{verifyReadback:async()=>visible()});
 const lost='2026-10-12T00:00:00.000Z';await verifyStoredShareYourHtmlPublication(f.store,f.vault,{taskId,resolveChannel:f.resolve,now:()=>new Date(lost)},{verifyReadback:async()=>failed('content_mismatch')});
 let t=f.store.read().tasks[0];assert.equal(t.status,'needs_input');assert.equal(t.health,'missing');assert.equal(t.firstLiveAt,checked);assert.equal(t.lostAt,lost);
 const recovered='2026-10-14T00:00:00.000Z';await verifyStoredShareYourHtmlPublication(f.store,f.vault,{taskId,resolveChannel:f.resolve,now:()=>new Date(recovered)},{verifyReadback:async()=>visible()});
 t=f.store.read().tasks[0];assert.equal(t.status,'live');assert.equal(t.health,'healthy');assert.equal(t.firstLiveAt,checked);assert.equal(t.verifiedAt,recovered);assert.equal(t.lostAt,undefined);assert.equal(f.store.getCipher(`publication:${taskId}`),'cipher');
}finally{f.cleanup()}});

test('invalid cipher or paused binding makes zero readback requests',async()=>{for(const mutate of ['cipher','pause','disable'] as const){const f=fixture();let reads=0;try{
 if(mutate==='cipher')f.vault={get:async()=>'{"bad":true}'} as unknown as Vault;
 if(mutate==='pause')f.store.update(state=>{state.sites[0].status='paused'});
 if(mutate==='disable')f.store.update(state=>{state.settings.channelOverrides.shareyourhtml=false});
 const out=await verifyStoredShareYourHtmlPublication(f.store,f.vault,{taskId,resolveChannel:state=>({...f.resolve(state)!,enabled:f.resolve(state)!.enabled&&state.settings.channelOverrides.shareyourhtml!==false})},{verifyReadback:async()=>{reads++;return visible()}});
 assert.equal(out.status,'stale');assert.equal(reads,0);assert.equal(f.store.read().tasks[0].firstLiveAt,undefined);
 }finally{f.cleanup()}}});

test('task change or cancellation while awaiting discards late success atomically',async()=>{for(const cancel of [false,true]){const f=fixture(),abort=new AbortController();let release!:()=>void;try{
 const gate=new Promise<void>(resolve=>{release=resolve});const run=verifyStoredShareYourHtmlPublication(f.store,f.vault,{taskId,resolveChannel:f.resolve,signal:abort.signal,now:()=>new Date(checked)},{verifyReadback:async()=>{await gate;return visible()}});
 await new Promise(resolve=>setImmediate(resolve));if(cancel)abort.abort();else f.store.update(state=>{state.settings.notify=!state.settings.notify});release();const out=await run;assert.equal(out.status,'stale');assert.equal(f.store.read().tasks[0].firstLiveAt,undefined);assert.equal(f.store.getCipher(`publication:${taskId}`),'cipher');
 }finally{f.cleanup()}}});


test('Store rejects inconsistent readback mutation atomically and preserves ciphertext',async()=>{const f=fixture();try{
 await verifyStoredShareYourHtmlPublication(f.store,f.vault,{taskId,resolveChannel:f.resolve,now:()=>new Date(checked)},{verifyReadback:async()=>visible()});
 const before=f.store.read(),cipher=f.store.getCipher(`publication:${taskId}`);
 assert.throws(()=>f.store.update(state=>{state.tasks[0].shareYourHtmlReadback!.targetLinks[0].href='https://wrong.example/';state.events.push({id:'bad',at:checked,level:'info',message:'must roll back'})}),/ShareYourHTML/);
 assert.deepEqual(f.store.read(),before);assert.equal(f.store.getCipher(`publication:${taskId}`),cipher);
}finally{f.cleanup()}});


test('oversized or unsupported observation metadata is conservatively stored as unknown',async()=>{const f=fixture();try{
 const oversized=visible();oversized.targetLinks=Array.from({length:33},(_,index)=>({href:topic,rel:[`token_${index}`]}));
 const out=await verifyStoredShareYourHtmlPublication(f.store,f.vault,{taskId,resolveChannel:f.resolve,now:()=>new Date(checked)},{verifyReadback:async()=>oversized});
 assert.equal(out.status,'pending');const saved=f.store.read().tasks[0];assert.equal(saved.firstLiveAt,undefined);assert.equal(saved.shareYourHtmlReadback?.status,'visibility_unknown');assert.deepEqual(saved.shareYourHtmlReadback?.targetLinks,[]);
}finally{f.cleanup()}});
