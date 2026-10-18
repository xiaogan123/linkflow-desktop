import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {carcinusHash,carcinusPublicUrl,carcinusRequest,carcinusRestoreUrl,type CarcinusDependencies,type CarcinusPayload,type CarcinusReceipt} from '../src/integrations/carcinus';
import {validateBackup,validateLocalBackup} from '../src/main/backup-validation';
import type {CarcinusExistingPageExport} from '../src/main/carcinus-existing';
import {Controller} from '../src/main/controller';
import {emptyState,Store} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {encryptBackup,decryptBackup} from '../src/main/backup';
import type {Site} from '../src/shared/types';

const at='2026-10-18T10:00:00.000Z',createdAt='2026-10-17T09:00:00.000Z',preflightAt='2026-10-17T08:59:59.000Z';
const siteId='77777777-7777-4777-8777-777777777777',identity='existing-example-guide',targetUrl='https://example.net/guides/original-page',writeToken='carcinus_existing_fixture_token_1234567890';
const publicUrl=carcinusPublicUrl(identity),restoreUrl=carcinusRestoreUrl(identity);
const html=`<!doctype html>\n<html lang="en"><head><title>Original deployment recovery guide</title><link rel="canonical" href="${publicUrl}"><style>body{font-family:system-ui;color:#222}</style></head><body><main><article><h1>Original deployment recovery guide</h1><p>This independently useful guide documents how to preserve an existing managed page without creating a replacement identity.</p><h2>Recovery boundary</h2><p>Keep the original receipt and verify the public object before changing local state.</p><p>Read the <a href="${targetUrl}">original project guide</a>.</p></article></main></body></html>`;
const publicHtml=html.replace('<style>body{font-family:system-ui;color:#222}</style>','');
const payload:CarcinusPayload={identity,purpose:'A human-operated publisher previously created this exact public guide for the linked site.',htmlTemplate:html,isAssistantMemoryBackup:false};
const request=carcinusRequest(payload);
const receipt:CarcinusReceipt={operationId:'carcinus_77777777777747778777777777777777',identity,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt,preflightCheckedAt:preflightAt,preflightStatus:404,publicUrl,restoreUrl,tokenFingerprint:carcinusHash(writeToken)};
const provenance={payloadFileSha256:'1'.repeat(64),reviewSha256:'2'.repeat(64),manifestSha256:'3'.repeat(64),resultSha256:'4'.repeat(64)};
function exported(overrides:Partial<CarcinusExistingPageExport>={}):CarcinusExistingPageExport{return {version:1,kind:'linkflow_carcinus_existing_page',targetUrl,payload,receipt,writeToken,provenance,...overrides}}
function site():Site{return {id:siteId,domain:'example.net',url:'https://example.net/',email:'owner@example.net',name:'Example Project',description:'Synthetic existing page connection fixture',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:createdAt,analyzedAt:createdAt,topics:[{url:targetUrl,discoveredAt:createdAt}]}}
function fixture(){const dir=mkdtempSync(join(tmpdir(),'carcinus-existing-')),path=join(dir,'state.sqlite'),store=new Store(path),state=emptyState();state.settings.autoRun=false;state.settings.notify=false;state.sites=[site()];store.update(current=>Object.assign(current,state));return {dir,path,store,cleanup(){try{store.close()}catch{}rmSync(dir,{recursive:true,force:true})}}}
function response(url:string,body:string,status=200,type='application/json'){const result=new Response(body,{status,headers:{'content-type':type}});Object.defineProperty(result,'url',{value:url});Object.defineProperty(result,'redirected',{value:false});return result}
function reads(hook?:(url:string,index:number)=>void){const calls:Array<{url:string;method:string}>=[];const fetch:NonNullable<CarcinusDependencies['fetch']>=async(url,init)=>{const method=init.method??'GET';calls.push({url,method});hook?.(url,calls.length);assert.equal(method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.equal(init.body,undefined);if(url==='https://carcinus.org/robots.txt')return response(url,'User-agent: *\nAllow: /',200,'text/plain');if(url===publicUrl)return response(url,publicHtml,200,'text/html');if(url===restoreUrl)return response(url,JSON.stringify({identity,publicHtml:publicUrl,restoreEndpoint:restoreUrl}));throw Error('unexpected '+url)};return {calls,fetch}}


// Randomized authenticated keychain substitute, never the real OS keychain.
const compiled=await build({stdin:{contents:`export {Vault} from './src/main/vault'; export {safeStorage as testKeychain} from 'electron';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',plugins:[{
  name:'randomized-test-keychain',setup(builder){
    builder.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'test-keychain'}));
    builder.onLoad({filter:/.*/,namespace:'test-keychain'},()=>({contents:`
      import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
      const key=randomBytes(32);
      export const safeStorage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=>"fixture",
        encryptString(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([c.update(value,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]);},
        decryptString(bytes){const d=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));d.setAuthTag(bytes.subarray(12,28));return Buffer.concat([d.update(bytes.subarray(28)),d.final()]).toString('utf8');}};
    `,loader:'js'}));
  },
}]});
const compiledModule={exports:{} as {Vault:new(store:Store)=>Vault;testKeychain:{decryptString(bytes:Buffer):string}}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),compiledModule,compiledModule.exports);
const RealVault=compiledModule.exports.Vault;

for(const kind of ['portable','local'] as const)test(`${kind} validated backup restores identical protected identity and receipt in place with randomized encryption`,async()=>{
  const f=fixture(),vault=new RealVault(f.store),transport=reads(),controller=new Controller(f.store,vault,'fixture',{carcinusDependencies:{fetch:transport.fetch,now:()=>new Date(at)}});
  let fresh:Store|undefined;
  try{
    await controller.connectCarcinusExistingPage({siteId,exportJson:JSON.stringify(exported())});controller.stop();
    const original=f.store.read(),oldCiphers=f.store.allCiphers(),secrets=vault.exportSecrets();
    const data=kind==='portable'
      ?validateBackup(decryptBackup(encryptBackup({state:original,secrets},'synthetic-backup-passphrase'),'synthetic-backup-passphrase'))
      :validateLocalBackup({state:original,ciphers:oldCiphers},compiledModule.exports.testKeychain.decryptString);
    // This is the original defect: fresh nonce bytes must not be mistaken for a new token.
    const reencrypted=vault.encryptSecrets(data.secrets);assert.notDeepEqual(reencrypted,oldCiphers);
    assert.throws(()=>f.store.restore(data.state,reencrypted),/Carcinus/);
    assert.deepEqual(f.store.read(),original);assert.deepEqual(f.store.allCiphers(),oldCiphers);
    const restored=vault.prepareRestoredSecrets(data.secrets);assert.deepEqual(restored,oldCiphers);
    f.store.restore(data.state,restored);assert.deepEqual(JSON.parse(JSON.stringify(f.store.read())),JSON.parse(JSON.stringify(original)));assert.deepEqual(f.store.allCiphers(),oldCiphers);
    // A distinct destination has no matching ciphertext and must encrypt normally.
    fresh=new Store(join(f.dir,'fresh.sqlite'));const freshVault=new RealVault(fresh);
    fresh.restore(data.state,freshVault.prepareRestoredSecrets(data.secrets));assert.deepEqual(freshVault.exportSecrets(),secrets);
    assert.notDeepEqual(fresh.allCiphers(),oldCiphers);
    assert.equal(transport.calls.length,3);
  }finally{fresh?.close();controller.stop();f.cleanup()}
});

test('restore preparation never treats different protected token or receipt plaintext as unchanged',async()=>{
 const f=fixture(),vault=new RealVault(f.store),transport=reads(),controller=new Controller(f.store,vault,'fixture',{carcinusDependencies:{fetch:transport.fetch,now:()=>new Date(at)}});
 try{
  await controller.connectCarcinusExistingPage({siteId,exportJson:JSON.stringify(exported())});controller.stop();
  const original=f.store.read(),oldCiphers=f.store.allCiphers(),secrets=vault.exportSecrets();
  for(const key of Object.keys(secrets)){
    const altered=secrets[key].includes(writeToken)?secrets[key].replaceAll(writeToken,'carcinus_different_fixture_token_9876543210'):secrets[key]+' ';
    const changed={...secrets,[key]:altered},prepared=vault.prepareRestoredSecrets(changed);
    assert.notEqual(prepared[key],oldCiphers[key]);assert.throws(()=>f.store.restore(original,prepared),/Carcinus/);
    assert.deepEqual(f.store.read(),original);assert.deepEqual(f.store.allCiphers(),oldCiphers);
  }
  assert.throws(()=>f.store.restore(original,vault.prepareRestoredSecrets({})),/Carcinus/);
  assert.deepEqual(f.store.allCiphers(),oldCiphers);
 }finally{controller.stop();f.cleanup()}
});

test('restore preparation keeps exact values only, encrypts new values, and fails before writes on damaged ciphertext',()=>{
 const store=new Store(':memory:'),vault=new RealVault(store);
 try{
  const initial=vault.encryptSecrets({same:'original secret',changed:'old secret'});for(const [key,value]of Object.entries(initial))store.setCipher(key,value);
  const prepared=vault.prepareRestoredSecrets({same:'original secret',changed:'new secret',added:'added secret'});
  assert.equal(prepared.same,initial.same);assert.notEqual(prepared.changed,initial.changed);
  assert.equal(compiledModule.exports.testKeychain.decryptString(Buffer.from(prepared.added,'base64')),'added secret');
  assert.deepEqual(store.allCiphers(),initial);
  store.setCipher('same','invalid cipher');const damaged=store.allCiphers();
  assert.throws(()=>vault.prepareRestoredSecrets({same:'original secret'}));assert.deepEqual(store.allCiphers(),damaged);
 }finally{store.close()}
});
