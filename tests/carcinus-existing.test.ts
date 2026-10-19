import {pinPublicationFixtures} from './helpers/publication-snapshot';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {CHANNELS} from '../src/integrations/catalog';
import {CARCINUS_RETENTION,carcinusHash,carcinusPayload,carcinusPublicUrl,carcinusRequest,carcinusRestoreUrl,type CarcinusDependencies,type CarcinusPayload,type CarcinusReceipt} from '../src/integrations/carcinus';
import {validateBackup} from '../src/main/backup-validation';
import {carcinusExistingTaskId,parseCarcinusExistingPageExport,parseCarcinusExistingPageSecret,type CarcinusExistingPageExport} from '../src/main/carcinus-existing';
import {Controller} from '../src/main/controller';
import {emptyState,Store} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import {publicationCounts,publicationOpportunity} from '../src/shared/publication';
import type {Site,Snapshot} from '../src/shared/types';
import {accountNextStep,connectionAction} from '../src/ui/account-guidance';
import {connectionOverview} from '../src/ui/channel-connections';

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
function fakeVault(store:Store):Vault{return {ready:true,available:()=>true,get:async(key:string)=>{const value=store.getCipher(key);return value?.startsWith('enc:')?Buffer.from(value.slice(4),'base64url').toString():undefined},set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'enc:'+Buffer.from(value).toString('base64url')]))} as unknown as Vault}
function fixture(){const dir=mkdtempSync(join(tmpdir(),'carcinus-existing-')),path=join(dir,'state.sqlite'),store=new Store(path),state=emptyState();state.settings.autoRun=false;state.settings.notify=false;state.sites=[site()];store.update(current=>Object.assign(current,state));return {dir,path,store,cleanup(){try{store.close()}catch{}rmSync(dir,{recursive:true,force:true})}}}
function response(url:string,body:string,status=200,type='application/json'){const result=new Response(body,{status,headers:{'content-type':type}});Object.defineProperty(result,'url',{value:url});Object.defineProperty(result,'redirected',{value:false});return result}
function reads(hook?:(url:string,index:number)=>void){const calls:Array<{url:string;method:string}>=[];const fetch:NonNullable<CarcinusDependencies['fetch']>=async(url,init)=>{const method=init.method??'GET';calls.push({url,method});hook?.(url,calls.length);assert.equal(method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.equal(init.body,undefined);if(url==='https://carcinus.org/robots.txt')return response(url,'User-agent: *\nAllow: /',200,'text/plain');if(url===publicUrl)return response(url,publicHtml,200,'text/html');if(url===restoreUrl)return response(url,JSON.stringify({identity,publicHtml:publicUrl,restoreEndpoint:restoreUrl}));throw Error('unexpected '+url)};return {calls,fetch}}
async function connect(f:ReturnType<typeof fixture>,transport=reads()){const controller=new Controller(pinPublicationFixtures(f.store),fakeVault(f.store),'fixture',{carcinusDependencies:{fetch:transport.fetch,now:()=>new Date(at)}});try{const account=await controller.connectCarcinusExistingPage({siteId,exportJson:JSON.stringify(exported())});return {controller,account,transport}}catch(error){controller.stop();throw error}}
async function plaintextSecrets(store:Store,vault:Vault){const state=store.read(),account=state.accounts[0],task=state.tasks[0];return {['account:'+account.id]:(await vault.get('account:'+account.id))!,['publication:'+task.id]:(await vault.get('publication:'+task.id))!}}

test('ordinary Controller imports one existing page with three GETs, encrypted secrets and no new publication',async()=>{
  const f=fixture();let controller:Controller|undefined;
  try{
    const connected=await connect(f);controller=connected.controller;const {account,transport}=connected,state=f.store.read(),task=state.tasks[0],binding=state.accountBindings[0];
    assert.deepEqual(transport.calls.map(value=>[value.method,value.url]),[['GET','https://carcinus.org/robots.txt'],['GET',publicUrl],['GET',restoreUrl]]);
    assert.equal(account.carcinus?.version,3);assert.equal(account.source,'imported');assert.equal(account.registrationAttempts,0);assert.equal(binding.accountId,account.id);assert.equal(binding.siteId,siteId);
    assert.equal(task.id,carcinusExistingTaskId(identity));assert.equal(task.status,'skipped');assert.equal(task.checkpoint,'existing_link');assert.equal(task.publicationMethod,'external');assert.equal(task.submittedAt,undefined);assert.equal(task.firstLiveAt,undefined);assert.equal(task.linkCheck,'found');assert.equal(task.carcinus,undefined);assert.equal(task.carcinusInput,undefined);assert.equal(task.articleReview,undefined);assert.equal(task.articleApprovedAt,undefined);assert.equal(task.cost?.aiCalls,0);
    assert.ok(f.store.getCipher('account:'+account.id)?.startsWith('enc:'));assert.ok(f.store.getCipher('publication:'+task.id)?.startsWith('enc:'));assert.equal(JSON.stringify(state).includes(writeToken),false);
    const secrets=await plaintextSecrets(f.store,fakeVault(f.store));assert.equal(secrets['account:'+account.id],writeToken);assert.ok(parseCarcinusExistingPageSecret(secrets['publication:'+task.id]));assert.doesNotThrow(()=>validateBackup({state,secrets}));
    assert.deepEqual(publicationCounts(siteId,state.tasks,new Date(at),'UTC'),{currentPages:0,monthlyPages:0,currentSources:0,monthlySources:0});
  }finally{controller?.stop();f.cleanup()}
});

test('restart and portable restore preserve the original object and verification remains GET-only',async()=>{
  const f=fixture(),firstReads=reads();let first=new Controller(pinPublicationFixtures(f.store),fakeVault(f.store),'fixture',{carcinusDependencies:{fetch:firstReads.fetch,now:()=>new Date(at)}}),restored:Store|undefined,second:Controller|undefined;
  try{
    await first.connectCarcinusExistingPage({siteId,exportJson:JSON.stringify(exported())});first.stop();const original=f.store.read(),secrets=await plaintextSecrets(f.store,fakeVault(f.store)),validated=validateBackup({state:original,secrets});
    const restoredPath=join(f.dir,'restored.sqlite');restored=new Store(restoredPath);const restoredVault=fakeVault(restored);restored.restore(validated.state,restoredVault.encryptSecrets(validated.secrets));const transport=reads();second=new Controller(pinPublicationFixtures(restored),restoredVault,'restored',{carcinusDependencies:{fetch:transport.fetch,now:()=>new Date(at)}});
    await second.verify(carcinusExistingTaskId(identity));const task=restored.read().tasks[0];assert.equal(transport.calls.length,3);assert.equal(transport.calls.some(value=>value.method==='POST'),false);assert.equal(task.status,'skipped');assert.equal(task.checkpoint,'existing_link');assert.equal(task.firstLiveAt,undefined);assert.equal(task.submittedAt,undefined);assert.equal(task.linkCheck,'found');assert.doesNotThrow(()=>validateBackup({state:restored!.read(),secrets:validated.secrets}));
  }finally{first.stop();second?.stop();restored?.close();f.cleanup()}
});

test('duplicate import, another identity, removal and a second planned page are all blocked',async()=>{
  const f=fixture();let controller:Controller|undefined;
  try{
    const transport=reads(),connected=await connect(f,transport);controller=connected.controller;const before=transport.calls.length,state=f.store.read(),account=state.accounts[0];
    await assert.rejects(controller.connectCarcinusExistingPage({siteId,exportJson:JSON.stringify(exported())}),/已有身份|第二个对象/);assert.equal(transport.calls.length,before);
    const otherPayload={...payload,identity:'another-existing-guide'},otherRequest=carcinusRequest(otherPayload),otherReceipt={...receipt,identity:otherPayload.identity,sourceHash:otherRequest.sourceHash,requestHash:otherRequest.requestHash,publicUrl:carcinusPublicUrl(otherPayload.identity),restoreUrl:carcinusRestoreUrl(otherPayload.identity)};await assert.rejects(controller.connectCarcinusExistingPage({siteId,exportJson:JSON.stringify(exported({payload:otherPayload,receipt:otherReceipt}))}),/已有身份|第二个对象|无效/);assert.equal(transport.calls.length,before);
    assert.throws(()=>f.store.update(current=>{current.accounts=[]}),/Carcinus/);assert.throws(()=>f.store.update(current=>{current.accountBindings=[]}),/Carcinus/);assert.throws(()=>controller!.deleteSite(siteId),/不能删除/);
    const channel={...CHANNELS.find(value=>value.id==='carcinus')!,enabled:true},opportunity=publicationOpportunity(site(),channel,state.tasks,new Date(at),'UTC');assert.equal(opportunity.allowed,false);assert.match(opportunity.reason,/第二个任务|一张固定公开页/);assert.equal(account.carcinus?.version,3);
  }finally{controller?.stop();f.cleanup()}
});

test('backup rejects changed provenance, receipt, token and lifecycle instead of manufacturing historical approval',async t=>{
  const f=fixture();let controller:Controller|undefined;
  try{const connected=await connect(f);controller=connected.controller;const state=f.store.read(),secrets=await plaintextSecrets(f.store,fakeVault(f.store)),account=state.accounts[0],task=state.tasks[0];
    const cases:Array<[string,()=>{state:typeof state;secrets:Record<string,string>}]>=[
      ['receipt',()=>{const changed=structuredClone(state);changed.tasks[0].carcinusExisting!.provenanceSha256='9'.repeat(64);return {state:changed,secrets}}],
      ['token',()=>({state,secrets:{...secrets,['account:'+account.id]:'different_fixture_token_123456789'}})],
      ['secret',()=>{const changed={...secrets,['publication:'+task.id]:JSON.stringify({...JSON.parse(secrets['publication:'+task.id]),targetUrl:'https://example.net/guides/changed'})};return {state,secrets:changed}}],
      ['lifecycle',()=>{const changed=structuredClone(state);changed.tasks[0].firstLiveAt=at;return {state:changed,secrets}}],
    ];for(const [name,make] of cases)await t.test(name,()=>assert.throws(()=>validateBackup(make()),/Carcinus/));
  }finally{controller?.stop();f.cleanup()}
});

test('exact ciphertext CAS and per-GET state guard reject a late credential replacement',async()=>{
  const f=fixture();let controller:Controller|undefined;
  try{const initial=await connect(f);controller=initial.controller;const task=f.store.read().tasks[0],key='publication:'+task.id,original=f.store.getCipher(key)!;const transport=reads((_url,index)=>{if(index===1)f.store.setCipher(key,'enc:'+Buffer.from('late replacement').toString('base64url'))});(controller as unknown as {services:{carcinusDependencies?:CarcinusDependencies}}).services.carcinusDependencies={fetch:transport.fetch,now:()=>new Date(at)};
    await assert.rejects(controller.verify(task.id),/加密字段|连接已变更/);assert.equal(transport.calls.length,1);assert.equal(transport.calls[0].method,'GET');const after=f.store.read().tasks[0];assert.equal(after.status,'skipped');assert.equal(after.firstLiveAt,undefined);assert.equal(after.submittedAt,undefined);f.store.setCipher(key,original);
  }finally{controller?.stop();f.cleanup()}
});

test('generic invalid exports fail before network and UI exposes the read-only connection path even while publishing is disabled',async()=>{
  assert.ok(parseCarcinusExistingPageExport(exported()));assert.equal(parseCarcinusExistingPageExport(JSON.stringify({...exported(),writeToken:'short'})),undefined);
  const unsafePayload={...payload,htmlTemplate:html.replace('body{font-family:system-ui;color:#222}','@import url(https://example.org/tracker.css)')},unsafeRequest=carcinusRequest(unsafePayload);assert.equal(parseCarcinusExistingPageExport(exported({payload:unsafePayload,receipt:{...receipt,sourceHash:unsafeRequest.sourceHash,requestHash:unsafeRequest.requestHash}})),undefined);
  for(const css of ['body{background:url(https://example.org/tracker)}','body{background:URL (https://example.org/tracker)}','@IMPORT "https://example.org/tracker.css"','body{background:u\\72l(https://example.org/tracker)}']){const changed={...payload,htmlTemplate:html.replace('body{font-family:system-ui;color:#222}',css)},request=carcinusRequest(changed);assert.equal(parseCarcinusExistingPageExport(exported({payload:changed,receipt:{...receipt,sourceHash:request.sourceHash,requestHash:request.requestHash}})),undefined,css)}
  const wrongCanonicalPayload={...payload,htmlTemplate:html.replace(publicUrl,'https://carcinus.org/public/other-existing-guide/index.html')},wrongCanonicalRequest=carcinusRequest(wrongCanonicalPayload);assert.equal(parseCarcinusExistingPageExport(exported({payload:wrongCanonicalPayload,receipt:{...receipt,sourceHash:wrongCanonicalRequest.sourceHash,requestHash:wrongCanonicalRequest.requestHash}})),undefined);
  const disabledChannels=CHANNELS.map(channel=>channel.id==='carcinus'?{...channel,enabled:false}:channel);const f=fixture(),transport=reads(),controller=new Controller(pinPublicationFixtures(f.store),fakeVault(f.store),'fixture',{channelCatalog:disabledChannels,carcinusDependencies:{fetch:transport.fetch,now:()=>new Date(at)}});
  try{await assert.rejects(controller.connectCarcinusExistingPage({siteId,exportJson:'{}'}),/导出记录无效/);assert.equal(transport.calls.length,0);const before=connectionOverview({accounts:[],accountBindings:[],sites:[site()],tasks:[],channels:disabledChannels} as Pick<Snapshot,'accounts'|'accountBindings'|'sites'|'tasks'|'channels'>).find(row=>row.id==='carcinus')!;assert.equal(before.state,'first_connection');assert.equal(connectionAction(before).kind,'connect');await controller.connectCarcinusExistingPage({siteId,exportJson:JSON.stringify(exported())});const snapshot=controller.snapshot(),after=connectionOverview(snapshot).find(row=>row.id==='carcinus')!,account=snapshot.accounts[0];assert.equal(after.state,'read_only');assert.equal(connectionAction(after).kind,'connect');assert.match(after.detail,/不计为新增发布|不计为新发布/);assert.match(accountNextStep(account,1,false),/不计新发布/);assert.equal(carcinusHash(JSON.stringify(carcinusPayload(payload))).length,64);assert.equal(CARCINUS_RETENTION.length>20,true)}finally{controller.stop();f.cleanup()}
});
