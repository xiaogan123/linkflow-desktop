import {recordOnlineHour} from '../src/shared/runtime-hours';
import test,{beforeEach,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {Controller} from '../src/main/controller';
import {Store} from '../src/main/store';
import {validateBackup} from '../src/main/backup-validation';
import {CHANNELS} from '../src/integrations/catalog';
import {SIGNUP_SCRIPTS,type SignupScript} from '../src/integrations/signup-executor';
import mockScript from '../src/integrations/signup-scripts/mock-local.json';
import {createHumanAction} from '../src/shared/human-action';
import {emailValueKey,mailConsumptionIds} from '../src/main/email-waits';
import {scanVerificationBatch,type VerificationMailClient} from '../src/integrations/mail';
import {requestShiplyCode,resendExpiredShiplyCode} from '../src/main/shiply-management';
import type {Account,Channel,Task,Site,ExecutionContext} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const sid='11111111-1111-4111-8111-111111111111',tid='22222222-2222-4222-8222-222222222222',mid='33333333-3333-4333-8333-333333333333',aid='44444444-4444-4444-8444-444444444444',sid2='55555555-5555-4555-8555-555555555555',tid2='66666666-6666-4666-8666-666666666666';
beforeEach(t=>{
  const clock=t as TestContext,now=Date.parse('2026-10-19T10:17:00.000Z');
  const interval=['human-action-2','human-action-4','human-action-5','6c reopening','6c delayed close'].some(prefix=>t.name.startsWith(prefix));
  if(interval)clock.mock.timers.enable({apis:['Date','setInterval'],now});
  else clock.mock.timers.enable({apis:['Date'],now});
});
function fixture(){
  const stamp=new Date().toISOString(),store=new Store(':memory:');
  const site:Site={id:sid,url:'https://example.com/',domain:'example.com',email:'owner@example.com',name:'Example',description:'Fixture',category:'content',language:'en',status:'ready',monthlyTarget:1,createdAt:stamp,mailboxId:mid};
  const task:Task={id:tid,siteId:sid,channelId:'fixture-browser',sourceDomain:'platform.example.com',status:'needs_input',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',accountId:aid};
  const channel:Channel={...CHANNELS.find(value=>value.id==='telegraph')!,id:task.channelId,domain:task.sourceDomain,automation:'browser',emailRequired:true,enabled:true,allowedHosts:[task.sourceDomain],submitUrl:'https://platform.example.com/signup'};
  const account:Account={id:aid,channelId:task.channelId,email:site.email,username:'fixture',mailboxId:mid,status:'needs_verification',hasPassword:true,source:'generated',createdAt:new Date(Date.now()-3600_000).toISOString(),lastUsedAt:stamp,registrationAttempts:1};
  store.update(state=>{state.sites=[site];state.tasks=[task];state.accounts=[account];state.settings.autoRun=true;state.settings.notify=false;state.mailboxes=[{id:mid,label:'Fixture',host:'imap.example.com',port:993,user:site.email,secure:true,hasPassword:true,aliases:[],createdAt:stamp,updatedAt:stamp,verifiedAt:stamp}]});
  const vault={ready:true,available:()=>true,get:async(key:string)=>store.getCipher(key)?.slice(10),encryptSecrets:(secrets:Record<string,string>)=>Object.fromEntries(Object.entries(secrets).map(([key,value])=>[key,'encrypted:'+value]))} as unknown as Vault;
  const controller=new Controller(store,vault,'fixture',{channelCatalog:[channel]});controller.runtime.busy=true;
  return {stamp,store,site,task,account,channel,vault,controller,close(){controller.stop();store.close()}};
}
function human(f:ReturnType<typeof fixture>,kind:NonNullable<Parameters<typeof createHumanAction>[1]>['kind']='captcha'){
  f.controller.patch(tid,{status:'needs_input',reasonCode:kind==='account_login'?'account_handoff':'human_required',humanAction:createHumanAction(f.task,{kind}),checkpoint:'account_registration_human'});
}
function scripted(f:ReturnType<typeof fixture>){f.store.update(state=>{state.tasks[0].signup={version:1,scriptId:mockScript.id,scriptVersion:1,identityId:aid,stepIndex:0,status:'human',runtimeId:'fixture',updatedAt:f.stamp,aiLocateCalls:0,aiLocatedStepIds:[]}});const map=SIGNUP_SCRIPTS as Map<string,SignupScript>;map.set(f.channel.id,{...structuredClone(mockScript) as SignupScript,platformId:f.channel.id});return ()=>map.delete(f.channel.id)}

test('mail-1 registration adoption preserves every human stop and requires actual submission time',()=>{
  const f=fixture();try{
    for(const reasonCode of ['human_required','account_handoff','email_exists'] as const){
      f.store.update(state=>Object.assign(state.tasks[0],{checkpoint:'account_registration_submitted',reasonCode:reasonCode==='email_exists'?'human_required':reasonCode,humanAction:createHumanAction(f.task,{kind:'account_login'})}));
      const before=f.store.read().tasks[0];f.controller.registerPendingEmailTasks();assert.deepEqual(f.store.read().tasks[0],before);
    }
    f.controller.patch(tid,{status:'queued'});f.controller.patch(tid,{status:'needs_input',checkpoint:'email_code_pending'});
    f.controller.registerPendingEmailTasks();const task=f.store.read().tasks[0];assert.equal(task.emailWait?.since,f.account.lastUsedAt);assert.notEqual(task.emailWait?.since,f.account.createdAt);assert.ok(task.emailWaitRegisteredAt);
    f.controller.patch(tid,{emailWait:undefined,checkpoint:'email_code_pending'});f.controller.registerPendingEmailTasks();assert.equal(f.store.read().tasks[0].emailWait,undefined);
  }finally{f.close()}
});

test('mail-1 consumed message survives delivery clearing and real Store export restore',async()=>{
  const f=fixture();f.controller.stop();
  const controller=new Controller(f.store,f.vault,'fixture',{channelCatalog:[f.channel],scanMail:async()=>({kind:'link',url:'https://platform.example.com/verify?token=fixture',snippet:'verify',messageId:'once-only'})});controller.runtime.busy=true;
  try{
    controller.patch(tid,{checkpoint:'email_code_pending'});controller.registerPendingEmailTasks();f.store.update(state=>{state.tasks[0].emailWait!.nextPollAt=f.stamp});await controller.tick();await setImmediate();
    assert.ok(f.store.getCipher(emailValueKey(tid)));controller.patch(tid,{emailWait:undefined});assert.equal(f.store.getCipher(emailValueKey(tid)),undefined);
    assert.deepEqual(mailConsumptionIds(f.store.read(),f.channel.id,f.site.email),['once-only']);
    const backup=validateBackup(JSON.parse(JSON.stringify({state:f.store.read(),secrets:{[`account:${aid}`]:"fixture-password",[`mailbox:${mid}`]:"fixture-password"}}))),restored=new Store(':memory:');
    try{restored.restore(backup.state,f.vault.encryptSecrets(backup.secrets));assert.deepEqual(mailConsumptionIds(restored.read(),f.channel.id,f.site.email),['once-only']);assert.ok(restored.read().tasks[0].emailWaitRegisteredAt)}finally{restored.close()}
    controller.patch(tid,{status:'needs_input',checkpoint:'email_code_pending'});controller.registerPendingEmailTasks();assert.equal(f.store.read().tasks[0].emailWait,undefined);
  }finally{controller.stop();f.close()}
});

test('mail-3 untested failed and OAuth mailboxes cannot enter automatic waits',()=>{
  for(const update of [{verifiedAt:undefined},{lastError:'authentication failed'},{host:'outlook.office365.com'}]){
    const f=fixture();try{f.controller.patch(tid,{checkpoint:'email_code_pending'});f.store.update(state=>Object.assign(state.mailboxes[0],update));f.controller.registerPendingEmailTasks();const task=f.store.read().tasks[0];assert.equal(task.emailWait,undefined);assert.equal(task.checkpoint,'email_code_pending');assert.equal(task.reasonCode,'account_handoff');assert.ok(task.humanAction?.deadline)}finally{f.close()}
  }
});

test('mail-3 authentication failure writes mailbox error and immediately preserves a human handoff',async()=>{
  const f=fixture();f.controller.stop();const controller=new Controller(f.store,f.vault,'fixture',{channelCatalog:[f.channel],scanMail:async()=>{throw Object.assign(Error('authentication failed'),{authenticationFailed:true})}});controller.runtime.busy=true;controller.runtime.mailReady=true;
  try{controller.patch(tid,{checkpoint:'email_code_pending'});controller.registerPendingEmailTasks();f.store.update(state=>{state.tasks[0].emailWait!.nextPollAt=f.stamp});await controller.tick();await setImmediate();assert.ok(f.store.read().mailboxes[0].lastError);assert.equal(controller.runtime.mailReady,false);assert.ok(f.store.read().tasks[0].humanAction);assert.equal(f.store.read().tasks[0].emailWait,undefined)}finally{controller.stop();f.close()}
});

test('mail-9 human-action-3 production scriptless done requeues without a mocked completion port',async()=>{
  for(const kind of ['captcha','phone','consent','other','selector_drift'] as const){
    const f=fixture();try{assert.equal(SIGNUP_SCRIPTS.size,0);human(f,kind);await f.controller.doneHumanAction(tid);const task=f.store.read().tasks[0];assert.equal(task.status,'queued');assert.equal(task.humanAction,undefined);assert.equal(task.checkpoint,'account_registration_submitted');assert.equal(f.store.read().accounts[0].registrationAttempts,1);assert.equal(f.store.read().accounts[0].status,'needs_verification')}finally{f.close()}
  }
});

test('human-action-3 scriptless done honors retry publication and attempt guards',async()=>{
  for(const extra of [{submittedAt:new Date().toISOString()},{attempts:3},{firstLiveAt:new Date().toISOString()},{checkpoint:'submitting'}]){
    const f=fixture();try{human(f);f.store.update(state=>Object.assign(state.tasks[0],extra));await assert.rejects(f.controller.doneHumanAction(tid));assert.equal(f.store.read().tasks[0].status,'needs_input');assert.equal(f.store.read().accounts[0].registrationAttempts,1)}finally{f.close()}
  }
});

test('human-action-2 concurrent open reuses one pending window and one timer',async t=>{
  const f=fixture(),remove=scripted(f);let opened=0,polls=0,release!:()=>void,windowSignal:AbortSignal|undefined;
  f.controller.stop();const controller=new Controller(f.store,f.vault,'fixture',{channelCatalog:[f.channel],hasHumanBrowser:()=>true,openHumanBrowser:async context=>{opened++;windowSignal=context.signal;if(opened===1)await new Promise<void>(resolve=>release=resolve)},humanBrowserComplete:async()=>{polls++;return false}});controller.runtime.busy=true;
  try{human(f);const first=controller.openHumanAction(tid),second=controller.openHumanAction(tid);assert.equal(opened,1);release();await Promise.all([first,second]);await controller.openHumanAction(tid);assert.equal(opened,2);assert.equal(windowSignal?.aborted,false);t.mock.timers.tick(1500);await setImmediate();assert.equal(polls,1);controller.stop();assert.equal(windowSignal?.aborted,true);t.mock.timers.tick(3000);await setImmediate();assert.equal(polls,1)}finally{remove();controller.stop();f.close();t.mock.timers.reset()}
});

test('human-action-4 scriptless windows never poll and closed scripted windows stop polling',async t=>{
  const f=fixture();let polls=0,closed:(()=>void)|undefined;
  f.controller.stop();const controller=new Controller(f.store,f.vault,'fixture',{channelCatalog:[f.channel],hasHumanBrowser:()=>true,openHumanBrowser:async(_context,onClosed)=>{closed=onClosed},humanBrowserComplete:async()=>{polls++;return false}});controller.runtime.busy=true;
  let remove=()=>{};try{human(f);await controller.openHumanAction(tid);t.mock.timers.tick(9000);await setImmediate();assert.equal(polls,0);closed!();remove=scripted(f);await controller.openHumanAction(tid);t.mock.timers.tick(1500);await setImmediate();assert.equal(polls,1);closed!();t.mock.timers.tick(9000);await setImmediate();assert.equal(polls,1)}finally{remove();controller.stop();f.close();t.mock.timers.reset()}
});

test('human-action-5 completion stops polling before a pending external verification',async t=>{
  const f=fixture(),remove=scripted(f);let verifications=0;
  f.controller.stop();const controller=new Controller(f.store,f.vault,'fixture',{channelCatalog:[f.channel],hasHumanBrowser:()=>true,openHumanBrowser:async()=>{},humanBrowserComplete:async()=>true});controller.runtime.busy=true;
  controller.verify=async()=>{verifications++};
  try{human(f);await controller.openHumanAction(tid);f.store.update(state=>{state.tasks[0].submittedAt=f.stamp;state.tasks[0].publicUrl='https://platform.example.com/p/fixture'});t.mock.timers.tick(1500);await setImmediate();assert.equal(verifications,1);t.mock.timers.tick(15000);await setImmediate();assert.equal(verifications,1)}finally{remove();controller.stop();f.close();t.mock.timers.reset()}
});

test('human-action-7 notification bookkeeping performs no write when nothing is due',async()=>{
  const f=fixture();let writes=0;f.store.update(state=>{state.settings.notify=true;recordOnlineHour(state.settings,new Date())});f.controller.onNotice=()=>{};const original=f.store.update.bind(f.store);f.store.update=(fn)=>{writes++;original(fn)};
  try{f.controller.patch(tid,{message:'changed'});assert.equal(writes,1);writes=0;await f.controller.tick();assert.equal(writes,0)}finally{f.close()}
});

test('mail-10 Shiply adoption follows the requested site rather than shared recipient order',()=>{
  const f=fixture();f.controller.stop();const channel={...f.channel,id:'shiply',domain:'shiply.now',automation:'api' as const};const controller=new Controller(f.store,f.vault,'fixture',{channelCatalog:[channel]});controller.runtime.busy=true;
  try{f.store.update(state=>{state.sites.push({...f.site,id:sid2,url:'https://example-site.com/',domain:'example-site.com'});state.tasks=[{...f.task,channelId:'shiply',sourceDomain:'shiply.now',accountId:undefined},{...f.task,id:tid2,siteId:sid2,channelId:'shiply',sourceDomain:'shiply.now',accountId:undefined}];state.tasks.forEach(task=>Object.assign(task,{checkpoint:'email_code_pending',reasonCode:'email_code_pending'}));state.accounts=[{...f.account,channelId:'shiply',shiply:{version:1,emailHash:'a'.repeat(64),siteId:sid2,requestedAt:f.stamp,stage:'code_sent'}}]});controller.registerPendingEmailTasks();assert.equal(f.store.read().tasks[0].emailWait,undefined);assert.equal(f.store.read().tasks[1].emailWait?.continuation,'shiply');assert.equal(f.store.read().tasks[1].accountId,aid)}finally{controller.stop();f.close()}
});

test('mail-10 Shiply code request durably records selected site before transport',async()=>{
  const f=fixture();f.store.update(state=>{state.accounts=[]});
  try{await assert.rejects(requestShiplyCode(f.store,'owner@example.com',{siteId:sid,fetch:async()=>{assert.equal(f.store.read().accounts[0].shiply?.siteId,sid);throw Error('offline fixture')}}));assert.equal(f.store.read().accounts[0].shiply?.siteId,sid);assert.equal(f.store.read().accounts[0].mailboxId,mid)}finally{f.close()}
});

test('mail-1 another existing identity or email-exists diagnosis prevents automatic consumption',()=>{
  for(const conflict of ['diagnostic','other-account'] as const){
    const f=fixture();try{
      f.controller.patch(tid,{checkpoint:'email_code_pending'});
      f.store.update(state=>{if(conflict==='diagnostic')state.accounts[0].diagnostic={code:'email_exists',message:'fixture',at:f.stamp,retryable:false};else state.accounts.push({...f.account,id:tid2,status:'registered'})});
      f.controller.registerPendingEmailTasks();const task=f.store.read().tasks[0];assert.equal(task.emailWait,undefined);assert.equal(task.checkpoint,'account_registration_human');assert.equal(task.humanAction?.kind,'account_login');
    }finally{f.close()}
  }
});

test('mail-1 Store migration retains legacy consumed ids when the old wait is cleared',()=>{
  const f=fixture(),restored=new Store(':memory:');
  try{
    const legacy=f.store.read();legacy.tasks[0].checkpoint='waiting_email';legacy.tasks[0].emailWait={kind:'link',recipient:f.site.email,since:f.stamp,nextPollAt:f.stamp,expiresAt:new Date(Date.now()+600_000).toISOString(),mailboxId:mid,continuation:'browser',consumedMessageIds:['legacy-used']};
    restored.restore(legacy,{});restored.update(state=>{state.tasks[0].emailWait=undefined});assert.deepEqual(mailConsumptionIds(restored.read(),f.channel.id,f.site.email),['legacy-used']);assert.equal(restored.read().tasks[0].emailWaitRegisteredAt,f.stamp);
  }finally{restored.close();f.close()}
});

test('human-action-1 Store migration clears old mislabeled system waits without losing their task',()=>{
  for(const checkpoint of ['referral_guard','eligibility_wait']){
    const f=fixture(),restored=new Store(':memory:');try{human(f);const legacy=f.store.read();legacy.tasks[0].checkpoint=checkpoint;restored.restore(legacy,{});const task=restored.read().tasks[0];assert.equal(task.id,tid);assert.equal(task.status,checkpoint==='referral_guard'?'failed':'skipped');assert.equal(task.humanAction,undefined);assert.equal(task.waitingDeadlineAt,undefined);assert.equal(task.reasonCode,checkpoint==='referral_guard'?'referral_blocked':'channel_ineligible')}finally{restored.close();f.close()}
  }
});

test('mail-1 a large durable ledger keeps strict wait backup bounds without evicting consumed messages',()=>{
  const f=fixture();try{
    const ids=Array.from({length:1001},(_,index)=>`used-${index}`);
    f.store.update(state=>{state.emailConsumptions=[{channelId:f.channel.id,recipient:f.site.email,messageIds:ids}]});
    f.controller.patch(tid,{checkpoint:'email_code_pending'});f.controller.registerPendingEmailTasks();
    assert.equal(f.store.read().tasks[0].emailWait!.consumedMessageIds.length,100);
    const restored=validateBackup({state:f.store.read(),secrets:{[`account:${aid}`]:'fixture-password',[`mailbox:${mid}`]:'fixture-password'}});
    assert.deepEqual(mailConsumptionIds(restored.state,f.channel.id,f.site.email),ids);
  }finally{f.close()}
});

test('mail-1 an identity conflict appearing during a scan cannot consume or claim the message',async()=>{
  const f=fixture();f.controller.stop();let release!:(value:{kind:'link';url:string;snippet:string;messageId:string})=>void;
  const controller=new Controller(f.store,f.vault,'fixture',{channelCatalog:[f.channel],scanMail:async()=>new Promise(resolve=>{release=resolve})});controller.runtime.busy=true;
  try{
    controller.patch(tid,{checkpoint:'email_code_pending'});controller.registerPendingEmailTasks();f.store.update(state=>{state.tasks[0].emailWait!.nextPollAt=f.stamp});await controller.tick();await setImmediate();
    f.store.update(state=>{state.accounts.push({...f.account,id:tid2,status:'registered'})});release({kind:'link',url:'https://platform.example.com/verify?token=fixture',snippet:'fixture',messageId:'belongs-to-other-account'});await setImmediate();
    assert.equal(f.store.getCipher(emailValueKey(tid)),undefined);assert.deepEqual(mailConsumptionIds(f.store.read(),f.channel.id,f.site.email),[]);assert.ok(f.store.read().tasks[0].humanAction);assert.equal(f.store.read().tasks[0].status,'needs_input');
  }finally{controller.stop();f.close()}
});


test('6c Shiply request -> real transition -> real mail scanner -> verified account runs once',async()=>{
  const f=fixture();f.controller.stop();
  const channel={...CHANNELS.find(value=>value.id==='shiply')!};
  const requests:string[]=[];
  const fetch=async(url:string,init:RequestInit)=>{
    requests.push(url);
    if(url.endsWith('/verify-code'))assert.equal(JSON.parse(String(init.body)).code,'834792');
    const response=new Response(url.endsWith('/verify-code')?JSON.stringify({email:f.site.email,apiKey:'shp_'+'A'.repeat(32)}):'{}',{status:200,headers:{'content-type':'application/json'}});
    Object.defineProperty(response,'url',{value:url});return response;
  };
  const client:VerificationMailClient={usable:true,on:()=>{},connect:async()=>{},logout:async()=>{},list:async()=>[],getMailboxLock:async()=>({release(){}}),search:async()=>[1],fetch:async function*(){
    yield {envelope:{from:[{address:'noreply@shiply.now'}],to:[{address:f.site.email}],date:f.stamp,subject:'Verification code',messageId:'real-path-message'},internalDate:f.stamp,
      source:Buffer.from('Received: from mail.shiply.now by mx.google.com with ESMTPS; Sun, 18 Oct 2026 00:00:00 +0000\r\nAuthentication-Results: mx.google.com; dkim=pass header.i=@shiply.now\r\nSubject: Verification code\r\nMessage-ID: <real-path-message>\r\n\r\nVerification code: 834792')};
  }};
  const controller=new Controller(f.store,f.vault,'fixture',{channelCatalog:[channel],shiplyDependencies:{fetch},scanMail:async context=>(await scanVerificationBatch([context],{dependencies:{createClient:()=>client}})).get(context.task.id)!});
  controller.runtime.busy=true;
  try{
    f.store.update(state=>{state.accounts=[];state.mailboxes[0].host='imap.gmail.com';Object.assign(state.tasks[0],{channelId:'shiply',sourceDomain:'shiply.now',accountId:undefined})});
    f.store.setCipher(`mailbox:${mid}`,'encrypted:fixture-password');
    controller.patch(tid,{status:'needs_input',checkpoint:'account_handoff'});
    assert.equal(f.store.read().tasks[0].reasonCode,'account_handoff');
    await requestShiplyCode(f.store,f.site.email,{siteId:sid,fetch,now:()=>new Date(f.stamp)});
    assert.equal(f.store.read().tasks[0].reasonCode,'email_code_pending');
    assert.equal(f.store.read().tasks[0].humanAction,undefined);
    controller.registerPendingEmailTasks();
    assert.equal(f.store.read().tasks[0].checkpoint,'waiting_email');
    f.store.update(state=>{state.tasks[0].emailWait!.nextPollAt=f.stamp});
    await controller.tick();
    await (controller as unknown as {emailWaits:{poll:()=>Promise<void>}}).emailWaits.poll();
    assert.equal(f.store.read().tasks[0].status,'queued',JSON.stringify({task:f.store.read().tasks[0],requests}));
    assert.equal(f.store.read().accounts[0].shiply?.stage,'ready');
    assert.equal(f.store.read().accounts[0].status,'registered');
    assert.deepEqual(f.store.read().accountBindings.map(value=>value.siteId),[sid]);
    await controller.tick();await setImmediate();
    assert.deepEqual(requests.map(url=>new URL(url).pathname),['/api/auth/agent/request-code','/api/auth/agent/verify-code']);
    assert.equal(mailConsumptionIds(f.store.read(),'shiply',f.site.email).length,1);
  }finally{controller.stop();f.close()}
});

test('6c snapshots expose completion support and mail completion cannot renew an unresolved wait',async()=>{
  const f=fixture();try{
    for(const kind of ['captcha','phone','consent','other','selector_drift','email_code_ambiguous','account_login'] as const){
      human(f,kind);
      const capability=f.controller.snapshot().humanActionCapabilities![tid];
      assert.equal(capability.canDone,true);
      assert.equal(capability.mode,['email_code_ambiguous','account_login'].includes(kind)?'page_check':'resume');
      if(capability.mode==='page_check'){
        const before=f.store.read().tasks[0];await assert.rejects(f.controller.doneHumanAction(tid));
        assert.deepEqual(f.store.read().tasks[0],before);
        assert.equal(f.store.read().tasks[0].emailWait,undefined);
      }
    }
    f.store.update(state=>{state.tasks[0].submittedAt=f.stamp});
    assert.equal(f.controller.snapshot().humanActionCapabilities![tid].canDone,false);
    await assert.rejects(f.controller.doneHumanAction(tid));
  }finally{f.close()}
});

test('6c reopening a retained scripted window restarts a stopped read-only check',async t=>{
  const f=fixture(),remove=scripted(f);let polls=0;
  f.controller.stop();const controller=new Controller(f.store,f.vault,'fixture',{channelCatalog:[f.channel],hasHumanBrowser:()=>true,openHumanBrowser:async()=>{},humanBrowserComplete:async()=>{polls++;return false}});controller.runtime.busy=true;
  try{human(f);await controller.openHumanAction(tid);t.mock.timers.tick(1500);await setImmediate();assert.equal(polls,1);
    (controller as unknown as {stopHumanChecks:(id:string,keep:boolean)=>void}).stopHumanChecks(tid,true);
    await controller.openHumanAction(tid);t.mock.timers.tick(1500);await setImmediate();assert.equal(polls,2);
  }finally{remove();controller.stop();f.close();t.mock.timers.reset()}
});


test('6c a busy scripted code wait retains its declared type when admitted later',async()=>{
  const f=fixture(),registry=SIGNUP_SCRIPTS as Map<string,SignupScript>;
  registry.set(f.channel.id,{...structuredClone(mockScript) as SignupScript,platformId:f.channel.id});
  const remove=()=>registry.delete(f.channel.id);
  try{
    // First task owns this mailbox slot; the second reaches await_email_code.
    f.controller.patch(tid,{status:'queued'});
    f.controller.patch(tid,{status:'needs_input',checkpoint:'email_code_pending'});
    f.controller.registerPendingEmailTasks();
    f.store.update(state=>{state.tasks.push({...f.task,id:tid2,status:'running',signup:{version:1,scriptId:mockScript.id,scriptVersion:1,identityId:aid,stepIndex:4,status:'waiting_email',runtimeId:'fixture',updatedAt:f.stamp,aiLocateCalls:0,aiLocatedStepIds:[]}})});
    const signal=new AbortController().signal;
    const context=(f.controller as unknown as {context:(task:Task,signal:AbortSignal)=>ExecutionContext}).context(f.store.read().tasks[1],signal);
    assert.equal(await context.signupHooks!.awaitEmail!({kind:'code',stepId:'mail',scriptId:mockScript.id,allowedHosts:f.channel.allowedHosts},signal),undefined);
    assert.equal(f.store.read().tasks[1].checkpoint,'email_code_pending');
    assert.equal(f.store.read().tasks[1].humanAction,undefined);
    f.controller.patch(tid,{status:'skipped',reasonCode:'user_skipped'});
    f.controller.registerPendingEmailTasks();
    assert.equal(f.store.read().tasks[1].emailWait?.kind,'code');
    assert.equal(f.store.read().tasks[1].emailWait?.continuation,'signup');
    assert.equal(f.store.read().tasks[1].checkpoint,'waiting_email');
  }finally{remove();f.close()}
});


test('6c explicit Shiply renewal after a real mail timeout admits the fresh request',async()=>{
  const f=fixture();f.controller.stop();const channel=CHANNELS.find(value=>value.id==='shiply')!;
  const controller=new Controller(f.store,f.vault,'fixture',{channelCatalog:[channel],scanMail:async()=>{throw Error('Expired code must not scan')}});controller.runtime.busy=true;
  let requests=0;const fetch=async(url:string)=>{requests++;const result=new Response('{}',{status:200,headers:{'content-type':'application/json'}});Object.defineProperty(result,'url',{value:url});return result};
  try{
    f.store.update(state=>{state.accounts=[];Object.assign(state.tasks[0],{channelId:'shiply',sourceDomain:'shiply.now',accountId:undefined})});
    controller.patch(tid,{status:'needs_input',checkpoint:'account_handoff'});
    const account=await requestShiplyCode(f.store,f.site.email,{siteId:sid,fetch,now:()=>new Date(Date.now()-660_000)});
    controller.registerPendingEmailTasks();await controller.tick();await (controller as unknown as {emailWaits:{poll:()=>Promise<void>}}).emailWaits.poll();
    assert.equal(f.store.read().tasks[0].checkpoint,'email_verification_human');assert.equal(f.store.read().tasks[0].humanAction?.kind,'account_login');
    const renewed=await resendExpiredShiplyCode(f.store,account.id,{fetch});
    assert.equal(f.store.read().tasks[0].reasonCode,'email_code_pending');assert.equal(f.store.read().tasks[0].humanAction,undefined);
    controller.registerPendingEmailTasks();assert.equal(f.store.read().tasks[0].emailWait?.since,renewed.shiply!.requestedAt);
    assert.equal(f.store.read().tasks[0].checkpoint,'waiting_email');assert.equal(requests,2);assert.equal(f.store.read().accounts.length,1);
  }finally{controller.stop();f.close()}
});


test('6c delayed close from an old window cannot retire the replacement window checks',async t=>{
  const f=fixture(),remove=scripted(f);let hasWindow=false,polls=0;
  const callbacks:Array<()=>void>=[],signals:AbortSignal[]=[];
  f.controller.stop();const controller=new Controller(f.store,f.vault,'fixture',{channelCatalog:[f.channel],hasHumanBrowser:()=>hasWindow,openHumanBrowser:async(context,onClosed)=>{signals.push(context.signal);callbacks.push(onClosed!);hasWindow=true},humanBrowserComplete:async()=>{polls++;return false}});controller.runtime.busy=true;
  try{
    human(f);await controller.openHumanAction(tid);hasWindow=false;await controller.openHumanAction(tid);
    assert.equal(signals[0].aborted,true);assert.equal(signals[1].aborted,false);
    callbacks[0]();t.mock.timers.tick(1500);await setImmediate();
    assert.equal(polls,1);assert.equal(signals[1].aborted,false);
  }finally{remove();controller.stop();f.close();t.mock.timers.reset()}
});

test('6d Shiply code request waits for mail only when the inbox can read it',async()=>{
  for(const ready of [true,false]){
    const f=fixture();f.controller.stop();
    try{
      f.store.update(state=>{state.accounts=[];state.tasks=[{...f.task,channelId:'shiply',sourceDomain:'shiply.now',accountId:undefined,checkpoint:'account_handoff',reasonCode:'account_handoff'}];if(!ready)state.mailboxes[0].verifiedAt=undefined});
      const fetch=async(url:string)=>{const value=new Response('{}',{status:200,headers:{'content-type':'application/json'}});Object.defineProperty(value,'url',{value:url});Object.defineProperty(value,'redirected',{value:false});return value};
      await requestShiplyCode(f.store,'owner@example.com',{siteId:sid,fetch});
      const task=f.store.read().tasks[0];
      assert.equal(task.checkpoint,ready?'email_code_pending':'account_handoff');
      assert.equal(task.reasonCode,ready?'email_code_pending':'account_handoff');
    }finally{f.close()}
  }
});
