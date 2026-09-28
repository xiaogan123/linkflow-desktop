import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {emptyState,migrateState,Store} from '../src/main/store';
import {applyLinkResult,currentLive,expireReviews,liveThisMonth} from '../src/main/planner';
import {bindAccount,boundAccount} from '../src/main/account-bindings';
import {prepareMailboxTest,saveMailbox} from '../src/main/mail-settings';
import {createAi,discoverApiModels,discoverCodexModels,scopedApiSecrets} from '../src/integrations/ai';
import {testMailbox} from '../src/integrations/mail';
import {preferredBrowserLaunch} from '../src/main/external-browser';
import {validateBackup} from '../src/main/backup-validation';
import {importChannelMetrics,saveCustomChannel} from '../src/integrations/channel-library';
import {CHANNELS} from '../src/integrations/catalog';
import {importMailboxesAtomic,saveMailboxAtomic} from '../src/main/mailbox-service';
import {saveAccountAtomic} from '../src/main/account-service';
import type {Account,Channel,Site,Task} from '../src/shared/types';

const siteId='11111111-1111-4111-8111-111111111111',otherSiteId='22222222-2222-4222-8222-222222222222',accountId='33333333-3333-4333-8333-333333333333';
function site(id=siteId,email='owner@example.com'):Site{return {id,domain:id===siteId?'example.com':'other.example',url:`https://${id===siteId?'example.com':'other.example'}`,email,name:'Example',description:'',category:'content',language:'en',monthlyTarget:2,status:'ready',createdAt:'2026-09-01T00:00:00.000Z'}}
function task():Task{return {id:'44444444-4444-4444-8444-444444444444',siteId,channelId:'profile',sourceDomain:'profiles.example.org',status:'live',createdAt:'2026-09-01T00:00:00.000Z',scheduledAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z',attempts:1,message:'live',publicUrl:'https://profiles.example.org/example',firstLiveAt:'2026-09-01T00:00:00.000Z',linkCheck:'found'} }
function channel(kind:Channel['kind']='profile'):Channel{return {id:'profile',name:'Profile',domain:'profiles.example.org',url:'https://profiles.example.org',submitUrl:'https://profiles.example.org/edit',categories:['content'],languages:['*'],kind,emailRequired:true,accountRequired:true,articleRequired:false,free:'yes',freeNote:'free',automation:'browser',quality:'C',qualityReason:'fixture',rulesUrl:'https://profiles.example.org/rules',checkedAt:'2026-09-01',notes:'fixture',allowedHosts:['profiles.example.org'],enabled:true}}

test('legacy state migration creates a separate mailbox and stable task identity without secret fields',()=>{
 const legacy=emptyState();legacy.schemaVersion=undefined;legacy.sites=[site()];legacy.settings.mail={host:'imap.example.com',port:993,user:'owner@example.com',secure:true,hasPassword:true};
 const account:Account={id:accountId,channelId:'profile',email:'owner@example.com',username:'owner',createdAt:'2026-09-01T00:00:00.000Z',status:'registered',hasPassword:true};legacy.accounts=[account];legacy.tasks=[task()];legacy.mailboxes=[];legacy.accountBindings=[];
 const migrated=migrateState(legacy);assert.equal(migrated.mailboxes.length,1);assert.equal(migrated.sites[0].mailboxId,migrated.mailboxes[0].id);assert.equal(migrated.tasks[0].accountId,accountId);assert.equal(boundAccount(migrated,migrated.tasks[0])?.id,accountId);assert.equal('password' in migrated.mailboxes[0],false);assert.equal('password' in migrated.accounts[0],false);
});

test('a confirmed lost link stays historically counted, leaves current health, and recovers without resubmission',()=>{
 const value=task(),missingAt=new Date('2026-09-10T00:00:00.000Z');applyLinkResult(value,{outcome:'absent',found:false,url:value.publicUrl!,rel:'',reason:'missing'},missingAt);
 assert.equal(value.status,'needs_input');assert.equal(value.health,'missing');assert.equal(value.reviewKind,'lost_link');assert.equal(value.attempts,1);assert.equal(liveThisMonth(siteId,[value],missingAt,'UTC'),1);assert.equal(currentLive(siteId,[value]),0);assert.ok(value.nextCheckAt);
 applyLinkResult(value,{outcome:'found',found:true,url:value.publicUrl!,rel:'nofollow',reason:''},new Date('2026-09-17T00:00:00.000Z'));
 assert.equal(value.status,'live');assert.equal(value.health,'healthy');assert.equal(value.attempts,1);assert.equal(value.firstLiveAt,'2026-09-01T00:00:00.000Z');assert.ok((value.history?.length??0)>=2);
});

test('a never-confirmed manual result expires as review timeout rather than a lost link',()=>{
 const state=emptyState(),value={...task(),status:'review' as const,firstLiveAt:undefined,linkCheck:undefined,health:'unknown' as const,reviewKind:'manual_url' as const,reviewUntil:'2026-09-02T00:00:00.000Z'};state.tasks=[value];expireReviews(state,new Date('2026-09-03T00:00:00.000Z'));
 assert.equal(value.status,'expired');assert.equal(value.health,'unknown');assert.match(value.message,/尚未确认/);assert.doesNotMatch(value.message,/外链已失效/);
});

test('profile binding blocks overwriting another site while article identities can be shared',()=>{
 const state=emptyState();state.sites=[site(),site(otherSiteId,'other@example.com')];state.accounts=[{id:accountId,channelId:'profile',email:'owner@example.com',username:'owner',createdAt:'2026-09-01T00:00:00.000Z',status:'registered',hasPassword:true}];state.tasks=[{...task(),accountId}];bindAccount(state,accountId,siteId,channel());
 assert.throws(()=>bindAccount(state,accountId,otherSiteId,channel()),/避免覆盖/);assert.doesNotThrow(()=>bindAccount(state,accountId,otherSiteId,channel('article')));
});

test('mailboxes keep independent password metadata and never persist a supplied secret',()=>{
 const state=emptyState(),first=saveMailbox(state,{label:'Primary',host:'imap.example.com',port:993,user:'one@example.com',secure:true,aliases:['alias@example.com']},true,new Date('2026-09-01'));
 assert.equal(first.hasPassword,true);assert.equal('password' in first,false);const changed=saveMailbox(state,{id:first.id,label:'Primary',host:'imap.other.example',port:993,user:'one@example.com',secure:true,aliases:[]},false,new Date('2026-09-02'));assert.equal(changed.hasPassword,false);
});

test('mailbox connection test uses edited identity and never reuses or verifies the saved destination',async()=>{
 const state=emptyState(),saved=saveMailbox(state,{label:'Primary',host:'imap.old.example',port:993,user:'one@example.com',secure:true,aliases:[]},true,new Date('2026-09-01'));
 const changed=prepareMailboxTest(saved,{id:saved.id,host:'imap.new.example',user:'two@example.com',port:993,secure:true,password:'new-password'},'old-password');assert.equal(changed.mailbox.host,'imap.new.example');assert.equal(changed.mailbox.user,'two@example.com');assert.equal(changed.password,'new-password');assert.equal(changed.canMarkVerified,false);
 let observed='';const result=await testMailbox(changed.mailbox,changed.password,(mailbox,password)=>{observed=`${mailbox.host}|${mailbox.user}|${password}`;return {usable:true,connect:async()=>{},getMailboxLock:async()=>({release(){}}),logout:async()=>{}}});assert.equal(result.ok,true);assert.equal(observed,'imap.new.example|two@example.com|new-password');
 const noNewSecret=prepareMailboxTest(saved,{id:saved.id,host:'imap.new.example',user:'two@example.com',port:993,secure:true},'old-password');assert.equal(noNewSecret.password,'');assert.equal(noNewSecret.canMarkVerified,false);
 const exactSaved=prepareMailboxTest(saved,{id:saved.id},'old-password');assert.equal(exactSaved.password,'old-password');assert.equal(exactSaved.canMarkVerified,true);
});

test('model discovery reports remote API candidates and truthful Codex CLI limitations',async()=>{
 let authorization='';const settings={...emptyState().settings,provider:'api' as const,model:'model-b'};
 const api=await discoverApiModels(settings,{get:async()=> 'synthetic-key',set:async()=>{},delete:async()=>{}},async(_url,init)=>{authorization=new Headers(init?.headers).get('authorization')??'';return new Response(JSON.stringify({data:[{id:'model-b'},{id:'model-a'},{id:'model-a'},{}]}),{status:200})});
 assert.equal(authorization,'Bearer synthetic-key');assert.deepEqual(api.models.map(model=>model.id),['model-a','model-b']);assert.equal(JSON.stringify(api).includes('synthetic-key'),false);
 const codex=await discoverCodexModels({...settings,provider:'codex',model:''},async()=>[]);assert.equal(codex.models.length,0);assert.equal(codex.defaultModel,undefined);assert.equal(codex.source,'unavailable');assert.match(codex.message,/未能取得/);
});

test('mailbox writes persist metadata and its encrypted secret in one transaction',()=>{
 const store=new Store(':memory:');try{
  store.update(state=>state.sites=[site()]);
  const encrypt=(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'cipher:'+value]));
  const id=saveMailboxAtomic(store,{label:'Primary',host:'imap.example.com',port:993,user:'one@example.com',secure:true,password:'first',siteIds:[siteId]},encrypt);
  assert.equal(store.read().mailboxes[0].id,id);assert.equal(store.read().sites[0].mailboxId,id);assert.equal(store.getCipher('mailbox:'+id),'cipher:first');
  saveMailboxAtomic(store,{id,label:'Primary',host:'imap.changed.example',port:993,user:'one@example.com',secure:true,password:'second',siteIds:[siteId]},encrypt);
  assert.equal(store.read().mailboxes[0].host,'imap.changed.example');assert.equal(store.getCipher('mailbox:'+id),'cipher:second');
  saveMailboxAtomic(store,{id,label:'Primary',host:'imap.final.example',port:993,user:'two@example.com',secure:true,siteIds:[siteId]},encrypt);
  assert.equal(store.read().mailboxes[0].hasPassword,false);assert.equal(store.getCipher('mailbox:'+id),undefined);
 }finally{store.close()}
});

test('mailbox encryption and import validation failures roll back the whole batch',()=>{
 const store=new Store(':memory:');try{
  store.update(state=>state.sites=[site()]);const before=store.read();
  assert.throws(()=>saveMailboxAtomic(store,{label:'Primary',host:'imap.example.com',port:993,user:'one@example.com',secure:true,password:'secret'},()=>{throw Error('keychain unavailable')}),/keychain/);
  assert.deepEqual(store.read(),before);assert.deepEqual(store.allCiphers(),{});
  const duplicate='55555555-5555-4555-8555-555555555555',item={id:duplicate,label:'Primary',host:'imap.example.com',port:993,user:'one@example.com',secure:true as const};
  assert.throws(()=>importMailboxesAtomic(store,[item,{...item,label:'Other',user:'two@example.com'}],values=>values),/重复/);assert.deepEqual(store.read(),before);
  assert.throws(()=>importMailboxesAtomic(store,[{...item,siteIds:[otherSiteId],password:'secret'}],values=>values),/网站不存在/);assert.deepEqual(store.read(),before);assert.deepEqual(store.allCiphers(),{});
  assert.throws(()=>saveMailboxAtomic(store,{label:'Gmail',host:'imap.gmail.com',port:993,user:'one@gmail.com',secure:true,password:'   '},values=>values),/不能为空/);assert.deepEqual(store.read(),before);assert.deepEqual(store.allCiphers(),{});
 }finally{store.close()}
});

test('modern state never resurrects a deleted mailbox or copies a legacy mail secret to a new identity',()=>{
 const directory=mkdtempSync(join(tmpdir(),'linkflow-store-')),path=join(directory,'state.sqlite');let store:Store|undefined;try{
  store=new Store(path);store.update(state=>{state.settings.mail={host:'imap.old.example',port:993,user:'old@example.com',secure:true,hasPassword:true};state.mailboxes=[{id:'55555555-5555-4555-8555-555555555555',label:'New',host:'imap.new.example',port:993,user:'new@example.com',secure:true,hasPassword:false,aliases:[],createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z'}]});store.setCipher('mailPassword','legacy-cipher');store.close();
  store=new Store(path);assert.equal(store.getCipher('mailbox:55555555-5555-4555-8555-555555555555'),undefined);store.update(state=>{state.mailboxes=[]});store.close();store=new Store(path);assert.equal(store.read().mailboxes.length,0);
 }finally{try{store?.close()}catch{}rmSync(directory,{recursive:true,force:true})}
 const modern=emptyState();modern.settings.mail={host:'imap.old.example',port:993,user:'old@example.com',secure:true,hasPassword:true};modern.mailboxes=[{id:'55555555-5555-4555-8555-555555555555',label:'New',host:'imap.new.example',port:993,user:'new@example.com',secure:true,hasPassword:false,aliases:[],createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z'}];const restored=validateBackup({state:modern,secrets:{mailPassword:'legacy-secret'}});assert.equal(restored.secrets['mailbox:55555555-5555-4555-8555-555555555555'],undefined);
});

test('only a true legacy backup migrates its matching mail secret to the generated mailbox',()=>{
 const legacy=emptyState();legacy.schemaVersion=undefined;legacy.mailboxes=[];legacy.settings.mail={host:'imap.legacy.example',port:993,user:'legacy@example.com',secure:true,hasPassword:true};const restored=validateBackup({state:legacy,secrets:{mailPassword:'legacy-secret'}}),mailbox=restored.state.mailboxes[0];assert.equal(mailbox.host,'imap.legacy.example');assert.equal(restored.secrets['mailbox:'+mailbox.id],'legacy-secret');
 assert.throws(()=>validateBackup({state:{...emptyState(),schemaVersion:99},secrets:{}}),/版本高于/);
});

test('account identity changes clear old credentials and failed preflight never replaces them',()=>{
 const store=new Store(':memory:');try{
  store.update(state=>state.sites=[site(),site(otherSiteId,'other@example.com')]);
  const encrypt=(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'cipher:'+value]));
  const id=saveAccountAtomic(store,{channelId:'profile',email:'owner@example.com',username:'owner',password:'first',siteIds:[siteId]},channel(),encrypt,new Date('2026-09-01'));
  assert.equal(store.getCipher('account:'+id),'cipher:first');
  store.update(state=>state.tasks=[{...task(),accountId:id}]);let encryptionCalls=0;
  assert.throws(()=>saveAccountAtomic(store,{id,channelId:'profile',email:'owner@example.com',username:'owner',password:'replacement',siteIds:[otherSiteId]},channel(),values=>{encryptionCalls++;return encrypt(values)}),/避免覆盖/);
  assert.equal(encryptionCalls,0);assert.equal(store.getCipher('account:'+id),'cipher:first');assert.equal(store.read().accountBindings[0].siteId,siteId);
  store.update(state=>{state.tasks=[];state.accountBindings=[]});
  saveAccountAtomic(store,{id,channelId:'profile',email:'new@example.com',username:'new-owner'},channel(),encrypt,new Date('2026-09-02'));
  assert.equal(store.getCipher('account:'+id),undefined);assert.equal(store.read().accounts[0].hasPassword,false);assert.equal(store.read().accounts[0].email,'new@example.com');
 }finally{store.close()}
});

test('account encryption failure leaves both metadata and secret storage unchanged',()=>{
 const store=new Store(':memory:');try{const before=store.read();assert.throws(()=>saveAccountAtomic(store,{channelId:'profile',email:'owner@example.com',username:'owner',password:'secret'},channel(),()=>{throw Error('keychain unavailable')}),/keychain/);assert.deepEqual(store.read(),before);assert.deepEqual(store.allCiphers(),{})}finally{store.close()}
});

test('model discovery never sends a saved key to a different normalized API destination',async()=>{
 let reads=0;const fallback={get:async()=>{reads++;return 'saved-a-key'},set:async()=>{},delete:async()=>{}};
 const changed=scopedApiSecrets('https://api-a.example/v1/','https://api-b.example/v1',undefined,fallback);assert.equal(await changed.get('apiKey'),undefined);assert.equal(reads,0);
 const same=scopedApiSecrets('https://api-a.example/v1/','https://api-a.example/v1',undefined,fallback);assert.equal(await same.get('apiKey'),'saved-a-key');assert.equal(reads,1);
 const supplied=scopedApiSecrets('https://api-a.example/v1','https://api-b.example/v1','new-b-key',fallback);assert.equal(await supplied.get('apiKey'),'new-b-key');assert.equal(reads,1);
});

test('API usage is recorded only when the provider returns real usage fields',async()=>{
 const previous=globalThis.fetch;let usage:unknown;
 globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}],usage:{prompt_tokens:12,completion_tokens:3,total_cost:0.004,currency:'USD'}}),{status:200});
 try{const settings={...emptyState().settings,provider:'api' as const,model:'synthetic-model'};const result=await createAi(settings,{get:async()=> 'synthetic-key',set:async()=>{},delete:async()=>{}},undefined,value=>{usage=value}).json<{ok:boolean}>('return ok',{});assert.equal(result.ok,true);assert.deepEqual(usage,{inputTokens:12,outputTokens:3,amount:0.004,currency:'USD'})}finally{globalThis.fetch=previous}
});

test('external browser preference uses a separate process launch without session copying',()=>{
 assert.deepEqual(preferredBrowserLaunch('https://example.com','chrome','darwin'),{command:'/usr/bin/open',args:['-a','Google Chrome','https://example.com']});assert.equal(preferredBrowserLaunch('https://example.com','system','darwin'),undefined);
});

test('backup restore reuses strict custom-channel and metric validation',()=>{
 const state=emptyState();state.customChannels=[{...channel('article'),id:'custom-55555555-5555-4555-8555-555555555555',domain:'profiles.example.org',url:'https://profiles.example.org/',submitUrl:'http://profiles.example.org/submit',automation:'manual',provenance:'custom',evidenceStatus:'user_added'}];
 assert.throws(()=>validateBackup({state,secrets:{}}),/HTTPS/);
 const metrics=emptyState();metrics.channelMetrics={telegraph:{authority:{name:'Example',value:10,source:'https://metrics.example.org',asOf:'2099-01-01'}}};assert.throws(()=>validateBackup({state:metrics,secrets:{}}),/不晚于今天/);
});

test('validated backup preserves a real custom-channel id and sourced metrics',()=>{
 const state=emptyState(),custom=saveCustomChannel([],{name:'Example Community',domain:'community.example.org',submitUrl:'https://community.example.org/submit',categories:['content'],languages:['en'],kind:'community',free:'conditional',freeNote:'Manual review',rulesUrl:'https://community.example.org/rules',notes:'Synthetic fixture',enabled:true},CHANNELS);state.customChannels=custom;
 state.channelMetrics=importChannelMetrics({},[{channelId:custom[0].id,authority:{name:'Synthetic score',value:42,source:'https://metrics.example.org/method',asOf:'2026-09-28',scope:'domain'},traffic:{monthly:1234,source:'https://metrics.example.org/traffic',asOf:'2026-09-28',region:'Global',period:'2026-08',metric:'visits',estimated:true}}],[...CHANNELS,...custom]);
 const restored=validateBackup({state,secrets:{}}).state;assert.equal(restored.customChannels?.[0].id,custom[0].id);assert.deepEqual(restored.channelMetrics?.[custom[0].id],state.channelMetrics[custom[0].id]);
});
