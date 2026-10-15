import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import {validateBackup} from '../src/main/backup-validation';
import {createLargeLanguageAccount} from '../src/main/large-language-account';
import {LARGE_LANGUAGE_MANIFEST_URL,LARGE_LANGUAGE_SESSION_URL,LARGE_LANGUAGE_SUBMISSIONS_URL,drainLargeLanguagePendingOperations} from '../src/integrations/large-language';
const actor='11111111-1111-4111-8111-111111111111',token='test-token-'.repeat(4),stamp='2026-10-16T00:00:00.000Z';
const input={displayName:'Independent Assistant',responsibleHuman:'Example Author',producerType:'system' as const,producerName:'Example editing system',siteIds:[]};
const identity={actor_id:actor,display_name:input.displayName,type:'agent',credential_version:1,created_at:stamp,credential_fingerprint:null};
const registration={created:true,token,actor:{id:actor,displayName:input.displayName,type:'agent'},identity_receipt:identity,agent_contract:{version:'1.16',terms:'x'.repeat(17000)}};
const session={authenticated:true,actor:{id:actor,displayName:input.displayName,type:'agent'},identity_receipt:identity};
function response(url:string,value:unknown,status=200){const result=new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});Object.defineProperty(result,'url',{value:url});return result}
function fixture(){const dir=mkdtempSync(join(tmpdir(),'ll-create-'));let store=new Store(join(dir,'state.sqlite'));
 const plain=(value:string)=>Buffer.from(value.slice(4),'base64').toString();
 const vault={get:async(key:string)=>{const value=store.getCipher(key);return value&&plain(value)},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([k,v])=>[k,'enc:'+Buffer.from(v).toString('base64')]))} as unknown as Vault;
 return {get store(){return store},vault,reopen(){store.close();store=new Store(join(dir,'state.sqlite'))},backup(){const state=store.read(),secrets=Object.fromEntries(state.accounts.map(value=>[`account:${value.id}`,plain(store.getCipher(`account:${value.id}`)!)]));return validateBackup({state,secrets})},cleanup(){store.close();rmSync(dir,{recursive:true,force:true})}};
}
function transport(f:ReturnType<typeof fixture>,mode:'success'|'unknown'|'wrong-session'|'late'='success'){
 let posts=0,gets=0;return {get posts(){return posts},get gets(){return gets},fetch:async(url:string,init:RequestInit)=>{
  if(url===LARGE_LANGUAGE_MANIFEST_URL)return response(url,{version:'1.22.1',contract_version:'1.16',submission_schema_version:'1.3',canonical_origin:'https://large-language.ai'});
  assert.equal(url,LARGE_LANGUAGE_SESSION_URL);
  if(init.method==='POST'){posts++;assert.equal(posts,1);const account=f.store.read().accounts[0];assert.equal(account.largeLanguage?.stage,'intent');const secret=JSON.parse((await f.vault.get(`account:${account.id}`))!);assert.equal(secret.recoveryKey.length,43);assert.equal(secret.responsibleHuman,input.responsibleHuman);const body=JSON.parse(String(init.body));assert.equal(body.recovery_key,secret.recoveryKey);assert.equal(body.display_name,input.displayName);assert.equal(JSON.stringify(f.store.read()).includes(secret.recoveryKey),false);if(mode==='unknown')throw Error('transport lost');if(mode==='late')await new Promise(resolve=>setTimeout(resolve,150));return response(url,registration,201)}
  gets++;return response(url,mode==='wrong-session'?{...session,identity_receipt:{...identity,actor_id:'22222222-2222-4222-8222-222222222222'}}:session);
 }};
}
test('automatic no-email identity preserves a large observed envelope through backup and GET-only reuse',async()=>{const f=fixture(),t=transport(f);try{const account=await createLargeLanguageAccount(f.store,f.vault,input,{fetch:t.fetch,now:()=>new Date(stamp)});assert.equal(account.largeLanguage?.stage,'ready');assert.equal(account.source,'generated');const key=`account:${account.id}`,cipher=f.store.getCipher(key),plain=await f.vault.get(key);assert.ok(plain&&plain.length>16384);f.backup();f.reopen();const again=await createLargeLanguageAccount(f.store,f.vault,{...input,accountId:account.id},{fetch:t.fetch});assert.equal(again.id,account.id);assert.equal(t.posts,1);assert.equal(t.gets,2);assert.equal(f.store.getCipher(key),cipher)}finally{f.cleanup()}});
test('large publication envelopes get the same bounded and state-bound backup allowance',async()=>{const f=fixture(),t=transport(f);try{const account=await createLargeLanguageAccount(f.store,f.vault,input,{fetch:t.fetch,now:()=>new Date(stamp)}),siteId='22222222-2222-4222-8222-222222222222',taskId='33333333-3333-4333-8333-333333333333',operationId='ll_work_'+taskId.replaceAll('-',''),sourceHash='a'.repeat(64),requestHash='b'.repeat(64),body=Buffer.from(JSON.stringify({status:'held',agent_contract:'y'.repeat(17000)})),publication=JSON.stringify({version:1,kind:'large_language_publication',operationId,idempotencyKey:operationId,requestHash,sourceHash,createdAt:stamp,opaqueResponse:{version:1,capturedAt:stamp,requestUrl:LARGE_LANGUAGE_SUBMISSIONS_URL,status:202,contentType:'application/json',responseUrl:LARGE_LANGUAGE_SUBMISSIONS_URL,redirected:false,responseType:'basic',headers:[],bodyBase64:body.toString('base64'),bodySha256:createHash('sha256').update(body).digest('hex'),bodyComplete:true}}),state=f.store.read();assert.ok(publication.length>16384);state.sites.push({id:siteId,domain:'example.test',url:'https://example.test',email:'owner@example.test',name:'Example',description:'Example software site',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp,qualifications:{software:'https://example.test'}} as any);state.tasks.push({id:taskId,siteId,channelId:'large-language',sourceDomain:'large-language.ai',status:'review',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'Bounded backup regression',health:'pending',accountId:account.id,submittedAt:stamp,checkpoint:'large-language_opaque_response',draft:{title:'Bounded envelope',description:'Backup regression',body:'See [the project](https://example.test).'},draftRevision:1,articleApprovedAt:stamp,largeLanguage:{operationId,accountId:account.id,displayName:account.username,idempotencyKey:operationId,sourceHash,requestHash,createdAt:stamp,stage:'opaque_response'}} as any);const accountSecret=await f.vault.get(`account:${account.id}`);assert.ok(accountSecret);const restored=validateBackup({state,secrets:{[`account:${account.id}`]:accountSecret,[`publication:${taskId}`]:publication}});assert.equal(restored.secrets[`publication:${taskId}`],publication);const mismatched=structuredClone(restored);mismatched.state.tasks[0].largeLanguage!.requestHash='c'.repeat(64);assert.throws(()=>validateBackup(mismatched),/LargeLanguage/)}finally{f.cleanup()}});
test('unknown registration survives reopen and backup without another POST or identity',async()=>{const f=fixture(),t=transport(f,'unknown');try{await assert.rejects(createLargeLanguageAccount(f.store,f.vault,input,{fetch:t.fetch}));const before=f.store.read().accounts[0];f.backup();f.reopen();await assert.rejects(createLargeLanguageAccount(f.store,f.vault,input,{fetch:t.fetch}),/不会再次注册/);assert.equal(t.posts,1);assert.equal(t.gets,0);assert.equal(f.store.read().accounts[0].id,before.id)}finally{f.cleanup()}});
test('a saved receipt can recover through GET only after an identity mismatch',async()=>{const f=fixture(),bad=transport(f,'wrong-session');try{await assert.rejects(createLargeLanguageAccount(f.store,f.vault,input,{fetch:bad.fetch}),/同一作者/);assert.equal(f.store.read().accounts[0].largeLanguage?.stage,'opaque_response');f.backup();f.reopen();let gets=0;const account=await createLargeLanguageAccount(f.store,f.vault,input,{fetch:async(url,init)=>{assert.equal(init.method,'GET');assert.equal(url,LARGE_LANGUAGE_SESSION_URL);gets++;return response(url,session)}});assert.equal(account.largeLanguage?.stage,'ready');assert.equal(gets,1);assert.equal(bad.posts,1)}finally{f.cleanup()}});
test('late registration receipt is retained and recovered without replay',async()=>{const f=fixture(),t=transport(f,'late');try{await assert.rejects(createLargeLanguageAccount(f.store,f.vault,input,{fetch:t.fetch,timeoutMs:100}));await drainLargeLanguagePendingOperations();assert.equal(f.store.read().accounts[0].largeLanguage?.stage,'opaque_response');f.backup();await createLargeLanguageAccount(f.store,f.vault,input,{fetch:t.fetch});assert.equal(t.posts,1);assert.equal(f.store.read().accounts[0].largeLanguage?.stage,'ready')}finally{f.cleanup()}});
test('invalid declarations and changed provenance cause no registration',async()=>{const f=fixture(),t=transport(f);try{await assert.rejects(createLargeLanguageAccount(f.store,f.vault,{...input,responsibleHuman:''},{fetch:t.fetch}));assert.equal(t.posts,0);await createLargeLanguageAccount(f.store,f.vault,input,{fetch:t.fetch});await assert.rejects(createLargeLanguageAccount(f.store,f.vault,{...input,responsibleHuman:'Another person'},{fetch:t.fetch}),/不一致/);assert.equal(t.posts,1)}finally{f.cleanup()}});

test('registration dispatch holds when the exact encrypted intent is removed or replaced during freshness read',async()=>{
 for(const mode of ['removed','replaced'] as const){const f=fixture();let posts=0;try{
  await assert.rejects(createLargeLanguageAccount(f.store,f.vault,input,{fetch:async(url,init)=>{
   if(url===LARGE_LANGUAGE_MANIFEST_URL){const account=f.store.read().accounts[0],key=`account:${account.id}`;if(mode==='removed')f.store.deleteCipher(key);else{const original=JSON.parse((await f.vault.get(key))!);f.store.updateWithCiphers(()=>{},f.vault.encryptSecrets({[key]:JSON.stringify({...original,recoveryKey:'changed-recovery-key-'.repeat(3)})}))}return response(url,{version:'1.22.1',contract_version:'1.16',submission_schema_version:'1.3',canonical_origin:'https://large-language.ai'})}
   if(init.method==='POST')posts++;throw Error('unexpected transport');
  }}));assert.equal(posts,0);assert.equal(f.store.read().accounts.length,1);assert.equal(f.store.read().accounts[0].largeLanguage?.stage,'intent');
 }finally{f.cleanup()}}
});

test('concurrent duplicate registration cannot dispatch a second POST',async()=>{const f=fixture();let posts=0;let release!:()=>void;const manifest=new Promise<void>(resolve=>{release=resolve});const fetch=async(url:string,init:RequestInit)=>{if(url===LARGE_LANGUAGE_MANIFEST_URL){await manifest;return response(url,{version:'1.22.1',contract_version:'1.16',submission_schema_version:'1.3',canonical_origin:'https://large-language.ai'})}if(init.method==='POST'){posts++;throw Error('synthetic lost response')}throw Error('unexpected transport')};try{const first=createLargeLanguageAccount(f.store,f.vault,input,{fetch});await new Promise(resolve=>setImmediate(resolve));const second=createLargeLanguageAccount(f.store,f.vault,input,{fetch});release();await Promise.allSettled([first,second]);assert.equal(posts,1);assert.equal(f.store.read().accounts.length,1)}finally{f.cleanup()}});

 test('backup binds saved identity time and generated account response stage',async()=>{
  const f=fixture(),bad=transport(f,'wrong-session');try{
   await assert.rejects(createLargeLanguageAccount(f.store,f.vault,input,{fetch:bad.fetch,now:()=>new Date(stamp)}));
   const original=f.backup(),id=original.state.accounts[0].id,key=`account:${id}`;
   assert.ok(original.secrets[key].length>16384);
   const changedTime=structuredClone(original),secret=JSON.parse(changedTime.secrets[key]);secret.createdAt='2026-10-15T00:00:00.000Z';changedTime.secrets[key]=JSON.stringify(secret);
   assert.throws(()=>validateBackup(changedTime),/LargeLanguage/);
   const falseIntent=structuredClone(original);falseIntent.state.accounts[0].largeLanguage!.stage='intent';
   assert.throws(()=>validateBackup(falseIntent),/LargeLanguage/);
   const missingResponse=structuredClone(original),withoutResponse=JSON.parse(missingResponse.secrets[key]);delete withoutResponse.opaqueResponse;missingResponse.secrets[key]=JSON.stringify(withoutResponse);
   assert.throws(()=>validateBackup(missingResponse),/LargeLanguage/);
   const ready=await createLargeLanguageAccount(f.store,f.vault,input,{fetch:async(url)=>response(url,session)});assert.equal(ready.largeLanguage?.stage,'ready');f.backup();
   const missingToken=f.backup(),withoutToken=JSON.parse(missingToken.secrets[key]);delete withoutToken.token;missingToken.secrets[key]=JSON.stringify(withoutToken);missingToken.state.accounts[0].status='credentials_invalid';
   assert.throws(()=>validateBackup(missingToken),/LargeLanguage/);
  }finally{f.cleanup()}
 });
