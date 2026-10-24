import test,{beforeEach,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Controller,type ControllerServices} from '../src/main/controller';
import {Store} from '../src/main/store';
import {taskTransition,assertHumanWaitOpen} from '../src/main/task-state';
import {maintainWaitingTasks} from '../src/main/task-recovery';
import {continuesPendingRegistration} from '../src/main/planner';
import {validateBackup} from '../src/main/backup-validation';
import {emailValueKey,mailConsumptionIds} from '../src/main/email-waits';
import {transferIdentityOwner} from '../src/main/account-retirement';
import {createHumanAction} from '../src/shared/human-action';
import {CHANNELS} from '../src/integrations/catalog';
import type {Task,Account,Site,Channel} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const sid='11111111-1111-4111-8111-111111111111',tid='22222222-2222-4222-8222-222222222222',mid='33333333-3333-4333-8333-333333333333',aid='44444444-4444-4444-8444-444444444444';
beforeEach(t=>(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-19T10:17:00.000Z')}));
function fixture(services:ControllerServices={},shiply=false){
  const stamp=new Date().toISOString(),store=new Store(':memory:');
  const channel:Channel=shiply?{...CHANNELS.find(value=>value.id==='shiply')!,enabled:true}:{...CHANNELS[0],id:'fixture-browser',domain:'platform.example.com',automation:'browser',emailRequired:true,enabled:true,allowedHosts:['platform.example.com'],submitUrl:'https://platform.example.com/signup'};
  const site:Site={id:sid,url:'https://example.com/',domain:'example.com',email:'owner@example.com',name:'Example',description:'Fixture',category:'content',language:'en',status:'ready',monthlyTarget:1,createdAt:stamp,mailboxId:mid};
  const task:Task={id:tid,siteId:sid,channelId:channel.id,sourceDomain:channel.domain,status:'needs_input',checkpoint:'email_code_pending',reasonCode:'email_code_pending',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',accountId:aid};
  const account:Account={id:aid,channelId:channel.id,email:site.email,username:shiply?site.email.trim().toLowerCase():'fixture',mailboxId:mid,status:'needs_verification',hasPassword:true,source:'generated',createdAt:stamp,lastUsedAt:stamp,registrationAttempts:1,...(shiply?{shiply:{version:1 as const,emailHash:createHash('sha256').update(site.email).digest('hex'),siteId:sid,requestedAt:stamp,stage:'code_sent' as const}}:{})};
  store.update(state=>{state.sites=[site];state.tasks=[task];state.accounts=[account];state.settings.autoRun=true;state.settings.notify=false;state.mailboxes=[{id:mid,label:'Fixture',host:'imap.example.com',port:993,user:site.email,secure:true,hasPassword:true,aliases:[],createdAt:stamp,updatedAt:stamp,verifiedAt:stamp}]});
  const vault={ready:true,available:()=>true,get:async(key:string)=>store.getCipher(key)?.slice(10),encryptSecrets:(secrets:Record<string,string>)=>Object.fromEntries(Object.entries(secrets).map(([key,value])=>[key,'encrypted:'+value]))} as unknown as Vault;
  const controller=new Controller(store,vault,'fixture',{channelCatalog:[channel],...services});controller.runtime.busy=true;
  return {stamp,store,site,task,account,channel,vault,controller,close(){controller.stop();store.close()}};
}
async function deliver(f:ReturnType<typeof fixture>){
  f.controller.registerPendingEmailTasks();f.store.update(state=>{state.tasks[0].emailWait!.nextPollAt=f.stamp});
  await (f.controller as unknown as {emailWaits:{poll():Promise<void>}}).emailWaits.poll();
}
function human(f:ReturnType<typeof fixture>,checkpoint:string,kind:'account_login'|'email_code_ambiguous'|'captcha'|'other'='account_login',reasonCode:Task['reasonCode']='account_handoff'){
  f.controller.patch(tid,{status:'needs_input',checkpoint,reasonCode,humanAction:createHumanAction(f.task,{kind})});
}

test('6d completion capability follows supported registration stops and rejects deterministic gates',async()=>{
  const f=fixture();try{
    for(const checkpoint of ['account_registration_submitted','account_registration_human','email_verification_human']){
      human(f,checkpoint);assert.deepEqual(f.controller.snapshot().humanActionCapabilities![tid],{canDone:true,mode:'page_check'});
      const before=f.store.read().tasks[0];await assert.rejects(f.controller.doneHumanAction(tid));assert.deepEqual(f.store.read().tasks[0],before);
    }
    for(const checkpoint of ['article_review','manual_submission','unknown_stop']){
      human(f,checkpoint,checkpoint==='unknown_stop'?'account_login':'other',checkpoint==='article_review'?'manual_review':'human_required');
      const before=f.store.read().tasks[0];assert.equal(f.controller.snapshot().humanActionCapabilities![tid].canDone,false);
      await assert.rejects(f.controller.doneHumanAction(tid));assert.deepEqual(f.store.read().tasks[0],before);
    }
  }finally{f.close()}
  const mismatched=fixture();try{human(mismatched,'account_registration_human','captcha','captcha_required');mismatched.store.update(state=>{state.tasks[0].signup={version:1,scriptId:'missing-script',scriptVersion:1,identityId:aid,stepIndex:0,status:'human',runtimeId:'old-window',updatedAt:mismatched.stamp,aiLocateCalls:0,aiLocatedStepIds:[]}});assert.equal(mismatched.controller.snapshot().humanActionCapabilities![tid].canDone,false);await assert.rejects(mismatched.controller.doneHumanAction(tid))}finally{mismatched.close()}
  const api=fixture({},true);try{human(api,'account_handoff');assert.equal(api.controller.snapshot().humanActionCapabilities![tid].canDone,false);await assert.rejects(api.controller.doneHumanAction(tid))}finally{api.close()}
});

test('6d resume and same deterministic gate keep original deadline across state and backup roundtrip',()=>{
  const f=fixture();try{
    for(const [checkpoint,reasonCode] of [['article_review','manual_review'],['manual_submission','human_required'],['account_handoff','account_handoff'],['account_registration_submitted','account_handoff']] as const){
      const since=new Date(Date.now()-47*3600_000),later=new Date(since.getTime()+47*3600_000);
      let current={...f.task,checkpoint,reasonCode,humanAction:createHumanAction(f.task,{kind:'account_login'},since)};
      Object.assign(current,taskTransition(current,{status:'needs_input'},since));const deadline=current.humanAction!.deadline;
      for(let count=0;count<3;count++){
        Object.assign(current,taskTransition(current,{status:'queued',humanAction:undefined,waitingSince:undefined,waitingDeadlineAt:undefined,reasonCode:undefined},later));
        assert.equal(current.waitingDeadlineAt,deadline);assert.equal(current.humanAction,undefined);
        Object.assign(current,taskTransition(current,{status:'running'},later));
        Object.assign(current,taskTransition(current,{status:'needs_input',checkpoint,reasonCode,humanAction:createHumanAction(f.task,{kind:'account_login'},later)},later));
        const action=(current as Task).humanAction!;assert.equal(action.since,since.toISOString());assert.equal(action.deadline,deadline);
      }
      f.store.update(state=>{state.tasks=[current]});
      const parsed=validateBackup({state:f.store.read(),secrets:{[`account:${aid}`]:'fixture-password',[`mailbox:${mid}`]:'fixture-password'}});
      assert.equal(parsed.state.tasks[0].waitingDeadlineAt,deadline);
      assert.throws(()=>assertHumanWaitOpen(current,new Date(deadline)),/./);
    }
  }finally{f.close()}
});

test('6d zero-attempt registration resumes expire even when account usage timestamp keeps advancing',()=>{
  const f=fixture();try{
    const since=new Date(Date.now()-49*3600_000);let current={...f.task,status:'running' as Task['status'],checkpoint:undefined,reasonCode:undefined};
    Object.assign(current,taskTransition(current,{status:'queued',checkpoint:'account_registration_submitted'},since));
    assert.equal(current.waitingSince,since.toISOString());assert.equal(current.attempts,0);
    // Fresh account activity cannot reopen the original registration window.
    const state=f.store.read();state.tasks=[current];state.accounts[0].lastUsedAt=new Date().toISOString();
    assert.equal(continuesPendingRegistration(state,current,f.channel,new Date()),false);
    // The task returns to a human stop that keeps the original clock, then times out normally.
    Object.assign(current,taskTransition(current,{status:'needs_input',reasonCode:'account_handoff'}));
    assert.ok(Date.parse(current.humanAction!.deadline)<=Date.now());
    assert.throws(()=>assertHumanWaitOpen(current));
    f.store.update(next=>{next.tasks=[current];maintainWaitingTasks(next.tasks,next.sites,[f.channel],next.settings,new Date())});
    const expired=f.store.read().tasks[0];
    assert.equal(expired.status,'skipped');assert.equal(expired.reasonCode,'human_timeout');assert.equal(expired.attempts,0);
    assert.throws(()=>taskTransition(expired,{status:'queued'}));
  }finally{f.close()}
});

test('6d a resolved account handoff keeps running after the original deadline instead of timing out',()=>{
  const f=fixture();try{
    const since=new Date(Date.now()-47*3600_000);
    let current:Task={...f.task,status:'needs_input',checkpoint:'account_handoff',reasonCode:undefined};
    Object.assign(current,taskTransition(current,{status:'needs_input',reasonCode:'account_handoff'},since));
    assert.ok(current.humanAction);
    // The user connects the account at hour 47; the verified requeue clears the clock.
    Object.assign(current,taskTransition(current,{status:'queued',checkpoint:undefined},new Date(),true));
    assert.equal(current.waitingDeadlineAt,undefined);assert.equal(current.waitingSince,undefined);
    // Hours later the queued task still starts, and a new stop gets a fresh 48 hours.
    const later=new Date(Date.now()+3*3600_000);
    Object.assign(current,taskTransition(current,{status:'running'},later));
    Object.assign(current,taskTransition(current,{status:'needs_input',reasonCode:'captcha_required'},later));
    assert.ok(Date.parse(current.humanAction!.deadline)>later.getTime()+47*3600_000);
    // Without verified resolution, requeueing keeps the old clock and a returning stop reuses it.
    let unresolved:Task={...f.task,status:'needs_input',checkpoint:'account_registration_human',reasonCode:undefined};
    Object.assign(unresolved,taskTransition(unresolved,{status:'needs_input',reasonCode:'human_required'},since));
    const deadline=unresolved.humanAction!.deadline;
    Object.assign(unresolved,taskTransition(unresolved,{status:'queued',checkpoint:undefined}));
    assert.doesNotThrow(()=>taskTransition(unresolved,{status:'running'},later));
    Object.assign(unresolved,taskTransition(unresolved,{status:'needs_input',reasonCode:'human_required'},later));
    assert.equal(unresolved.humanAction!.deadline,deadline);
  }finally{f.close()}
});
test('6d scriptless account verification clears non-Gmail confirmation clock before AI deferral and a new consent stop',()=>{
  const f=fixture();try{
    const initial=new Date(Date.now()-40*3600_000),after=new Date(Date.now()+26*3600_000);
    let current:Task={...f.task,status:'needs_input',checkpoint:'email_confirmation',reasonCode:'human_required'};
    const action=createHumanAction(current,{kind:'email_confirmation'},initial);
    current.humanAction=action;current.waitingSince=action.since;current.waitingDeadlineAt=action.deadline;
    Object.assign(current,taskTransition(current,{status:'queued',checkpoint:'account_registration_submitted',humanAction:undefined},new Date()));
    Object.assign(current,taskTransition(current,{status:'running'},new Date()));
    Object.assign(current,taskTransition(current,{checkpoint:'account_verified'},new Date()));
    assert.equal(current.waitingSince,undefined);assert.equal(current.waitingDeadlineAt,undefined);
    Object.assign(current,taskTransition(current,{status:'queued',reasonCode:'ai_daily_limit'},new Date()));
    Object.assign(current,taskTransition(current,{status:'running'},after));
    Object.assign(current,taskTransition(current,{status:'needs_input',reasonCode:'agreement_required'},after));
    assert.equal(current.humanAction?.since,after.toISOString());
    assert.equal(current.humanAction?.deadline,new Date(after.getTime()+48*3600_000).toISOString());
  }finally{f.close()}
});

test('6d Shiply scheduler resumes code-pending only with ready account bound to this site',()=>{
  for(const ready of [false,true])for(const bound of [false,true]){
    const f=fixture({},true);try{
      f.store.update(state=>{if(ready)Object.assign(state.accounts[0],{status:'registered',credentialKind:'api_token',shiply:{...state.accounts[0].shiply,stage:'ready',keyFingerprint:'a'.repeat(64)}});if(bound)state.accountBindings=[{id:mid,siteId:sid,channelId:'shiply',accountId:aid,createdAt:f.stamp,updatedAt:f.stamp}]});
      f.controller.plan();const current=f.store.read().tasks.find(value=>value.id===tid)!;
      assert.equal(current.status,ready&&bound?'queued':'needs_input',JSON.stringify({ready,bound,current}));
      if(!ready||!bound)assert.equal(current.checkpoint,'email_code_pending');
    }finally{f.close()}
  }
});
test('6d Shiply ready binding automatically resolves confirmation and ambiguous mail stops',async()=>{
  for(const kind of ['email_confirmation','email_code_ambiguous'] as const){
    const f=fixture({scanMail:async()=>({kind:'confirmation_required',candidate:{kind:'code',code:'482913'},snippet:'Verification code 482913',messageId:'shiply-mail'})},true);
    try{
      if(kind==='email_confirmation')await deliver(f);
      else human(f,'email_verification_human','email_code_ambiguous','human_required');
      const old=f.store.read().tasks[0].humanAction?.deadline;
      f.store.update(state=>{Object.assign(state.accounts[0],{status:'registered',hasPassword:true,credentialKind:'api_token',shiply:{...state.accounts[0].shiply,stage:'ready',keyFingerprint:'a'.repeat(64)}});state.accountBindings=[{id:mid,siteId:sid,channelId:'shiply',accountId:aid,createdAt:f.stamp,updatedAt:f.stamp}]});
      assert.ok(old);f.controller.plan();const saved=f.store.read().tasks[0];
      assert.equal(saved.status,'queued',kind);assert.equal(saved.waitingDeadlineAt,undefined);assert.equal(saved.emailConfirmation,undefined);
      assert.equal(f.store.getCipher(emailValueKey(tid)),undefined);
    }finally{f.close()}
  }
});

test('6d non-Gmail confirmation is one click, keeps token encrypted, restores and clears terminal data',async()=>{
  const f=fixture({scanMail:async()=>({kind:'confirmation_required',candidate:{kind:'link',url:'https://platform.example.com/verify?token=fixture-secret'},snippet:'Verification',messageId:'confirm-once'})});
  try{
    assert.deepEqual(f.controller.snapshot().mailboxReadiness![mid],{ready:true,level:'confirmation_required'});
    await deliver(f);const pending=f.store.read().tasks[0];
    assert.equal(pending.humanAction?.kind,'email_confirmation');assert.equal(pending.emailWait,undefined);assert.ok(pending.emailConfirmation);
    assert.equal(JSON.stringify(pending).includes('fixture-secret'),false);assert.equal(f.controller.snapshot().humanActionCapabilities![tid].mode,'confirm_email');
    const secrets=Object.fromEntries(Object.entries(f.store.allCiphers()).map(([key,value])=>[key,value.slice(10)]));
    Object.assign(secrets,{[`account:${aid}`]:'fixture-password',[`mailbox:${mid}`]:'fixture-password'});
    const validated=validateBackup({state:f.store.read(),secrets});const restored=new Store(':memory:');
    try{restored.restore(validated.state,f.vault.encryptSecrets(validated.secrets));assert.ok(restored.getCipher(emailValueKey(tid)));assert.equal(restored.read().tasks[0].humanAction?.kind,'email_confirmation')}finally{restored.close()}
    await f.controller.doneHumanAction(tid);const saved=f.store.read().tasks[0];
    assert.equal(saved.status,'queued');assert.equal(saved.emailConfirmation,undefined);assert.equal(saved.checkpoint,'account_registration_submitted');assert.ok(saved.emailWait);assert.ok(f.store.getCipher(emailValueKey(tid)));
    assert.deepEqual(mailConsumptionIds(f.store.read(),f.channel.id,f.site.email),['confirm-once']);
    await assert.rejects(f.controller.doneHumanAction(tid));
    f.controller.patch(tid,{status:'skipped',reasonCode:'user_skipped'});assert.equal(f.store.getCipher(emailValueKey(tid)),undefined);
  }finally{f.close()}
});
test('6d blocked identities cannot complete a pending email confirmation',async()=>{
  for(const blocked of ['email_exists','restricted','retired'] as const){
    const f=fixture({scanMail:async()=>({kind:'confirmation_required',candidate:{kind:'link',url:'https://platform.example.com/verify?token=fixture-secret'},snippet:'Verification',messageId:`blocked-${blocked}`})});
    try{
      await deliver(f);
      assert.equal(f.controller.snapshot().humanActionCapabilities![tid].mode,'confirm_email');
      f.store.update(state=>{
        const account=state.accounts[0];
        if(blocked==='email_exists')account.diagnostic={code:'email_exists',message:'fixture',at:f.stamp,retryable:false};
        else if(blocked==='restricted')account.status='restricted';
        else account.retiredAt=f.stamp;
      });
      assert.equal(f.controller.snapshot().humanActionCapabilities![tid].canDone,false);
      await assert.rejects(f.controller.doneHumanAction(tid));
    }finally{f.close()}
  }
});

test('6d confirmation state never stores a code from the mail snippet',async()=>{
  const code='482913',f=fixture({scanMail:async()=>({kind:'confirmation_required',candidate:{kind:'code',code},snippet:`Your verification code is ${code}`,messageId:'code-only'})},true);
  try{await deliver(f);const saved=f.store.read().tasks[0];
    assert.equal(saved.humanAction?.kind,'email_confirmation');
    assert.equal(JSON.stringify(saved).includes(code),false);
    assert.ok(saved.humanAction?.snippet?.includes('[已隐藏]'));
    assert.ok(f.store.getCipher(emailValueKey(tid)));
  }finally{f.close()}
});

test('6d expired, skipped and identity-changed confirmations cannot continue or expose the candidate',async()=>{
  for(const action of ['expire','skip','identity'] as const){
    const f=fixture({scanMail:async()=>({kind:'confirmation_required',candidate:{kind:'link',url:'https://platform.example.com/verify?token=fixture'},snippet:'Verification',messageId:'confirm-reject'})});
    try{await deliver(f);
      if(action==='expire')f.store.update(state=>{state.tasks[0].emailConfirmation!.wait.expiresAt=new Date(Date.now()-1000).toISOString()});
      if(action==='identity')f.store.update(state=>{state.accounts[0].email='changed@example.com'});
      if(action==='skip')f.controller.skipHumanAction(tid);
      await assert.rejects(f.controller.doneHumanAction(tid));assert.notEqual(f.store.read().tasks.find(value=>value.id===tid)!.status,'queued');
      if(action==='skip')assert.equal(f.store.getCipher(emailValueKey(tid)),undefined);
    }finally{f.close()}
  }
});

test('6d Shiply confirmation verifies once on concurrent clicks, then clears code ciphertext',async()=>{
  let calls=0,release!:()=>void,verified:Account;
  const f=fixture({scanMail:async()=>({kind:'confirmation_required',candidate:{kind:'code',code:'123456'},snippet:'Verification',messageId:'shiply-confirm'}),verifyMailShiply:async()=>{calls++;await new Promise<void>(resolve=>release=resolve);return verified}},true);
  try{verified=f.account;await deliver(f);assert.equal(calls,0);const first=f.controller.doneHumanAction(tid);await new Promise<void>(resolve=>setImmediate(resolve));await f.controller.doneHumanAction(tid);assert.equal(calls,1);f.store.update(state=>{Object.assign(state.accounts[0],{status:'registered',credentialKind:'api_token',shiply:{...state.accounts[0].shiply,stage:'ready',keyFingerprint:'a'.repeat(64)}});state.accountBindings=[{id:mid,siteId:sid,channelId:'shiply',accountId:aid,createdAt:f.stamp,updatedAt:f.stamp}]});release();await first;assert.equal(f.store.read().tasks[0].status,'queued');assert.equal(f.store.getCipher(emailValueKey(tid)),undefined);assert.equal(f.store.read().tasks[0].emailConfirmation,undefined)}finally{f.close()}
});

 test('6d Shiply confirmation recovers a persisted ready identity without verifying the code again',async()=>{
  let calls=0;const f=fixture({scanMail:async()=>({kind:'confirmation_required',candidate:{kind:'code',code:'123456'},snippet:'Verification',messageId:'ready-after-crash'}),verifyMailShiply:async()=>{calls++;throw Error('must not verify twice')}},true);
  try{await deliver(f);f.store.update(state=>{Object.assign(state.accounts[0],{status:'registered',credentialKind:'api_token',shiply:{...state.accounts[0].shiply,stage:'ready',keyFingerprint:'a'.repeat(64)}});state.accountBindings=[{id:mid,siteId:sid,channelId:'shiply',accountId:aid,createdAt:f.stamp,updatedAt:f.stamp}]});
    await f.controller.doneHumanAction(tid);assert.equal(calls,0);assert.equal(f.store.read().tasks[0].status,'queued');assert.equal(f.store.getCipher(emailValueKey(tid)),undefined);
  }finally{f.close()}
});

test('6d queued mail adoption switches to account handoff when its mailbox becomes unavailable',()=>{
  const f=fixture();try{
    f.store.update(state=>{state.mailboxes[0].lastError='fixture unavailable'});f.controller.registerPendingEmailTasks();
    const saved=f.store.read().tasks[0];assert.equal(saved.checkpoint,'email_code_pending');assert.equal(saved.reasonCode,'account_handoff');assert.equal(saved.emailWait,undefined);assert.ok(saved.humanAction?.deadline);
    f.controller.plan();assert.equal(f.store.read().tasks[0].status,'needs_input');assert.equal(f.store.read().tasks[0].checkpoint,'email_code_pending');
  }finally{f.close()}
});
test('6d a submitted browser registration keeps its checkpoint while the inbox is unavailable',()=>{
  const f=fixture();try{
    f.store.update(state=>{state.tasks[0].checkpoint='account_registration_submitted';state.accounts[0].status='unknown';state.mailboxes[0].lastError='fixture unavailable'});
    f.controller.registerPendingEmailTasks();const stopped=f.store.read().tasks[0];
    assert.equal(stopped.checkpoint,'account_registration_submitted');assert.equal(stopped.reasonCode,'account_handoff');
    assert.ok(stopped.humanAction?.deadline);
    f.controller.plan();const after=f.store.read().tasks[0];
    assert.equal(after.status,'needs_input');assert.equal(after.checkpoint,'account_registration_submitted');
  }finally{f.close()}
});

test('6d registration completion capability rejects blocked or unrelated account handoffs',async()=>{
  const f=fixture();try{
    human(f,'account_registration_human');
    for(const change of [(account:Account)=>{account.diagnostic={code:'email_exists',message:'fixture',at:f.stamp,retryable:false}},(account:Account)=>{account.status='restricted'},(account:Account)=>{account.retiredAt=f.stamp}]){
      const state=f.store.read();change(state.accounts[0]);
      const mode=(f.controller as unknown as {humanCompletionMode(task:Task,state:ReturnType<Store['read']>,channels:Channel[]):string}).humanCompletionMode(state.tasks[0],state,[f.channel]);
      assert.equal(mode,'unsupported');
    }
    f.store.update(state=>{state.accounts[0].status='registered'});
    human(f,'account_handoff');const blocked=f.store.read().tasks[0];
    assert.equal(f.controller.snapshot().humanActionCapabilities![tid].canDone,false);
    await assert.rejects(f.controller.doneHumanAction(tid));
    assert.equal(f.store.read().tasks[0].humanAction?.deadline,blocked.humanAction?.deadline);
  }finally{f.close()}
});

test('6d page completion rechecks readiness and cannot renew a conflict deadline',async()=>{
  let f:ReturnType<typeof fixture>;
  f=fixture({humanBrowserComplete:async()=>{
    f.store.update(state=>{const otherSiteId='55555555-5555-4555-8555-555555555555';state.accounts[0].status='registered';state.sites.push({...state.sites[0],id:otherSiteId,domain:'other.example.com',url:'https://other.example.com/'});state.accountBindings.push({id:'66666666-6666-4666-8666-666666666666',siteId:otherSiteId,channelId:f.channel.id,accountId:aid,createdAt:f.stamp,updatedAt:f.stamp});state.accounts[0].ownerSiteId=otherSiteId});
    return true;
  }});
  try{
    f.channel.accountRequired=true;
    human(f,'account_registration_submitted');const deadline=f.store.read().tasks[0].humanAction?.deadline;
    assert.equal(f.controller.snapshot().humanActionCapabilities![tid].canDone,true);
    await f.controller.doneHumanAction(tid);
    const saved=f.store.read().tasks[0];
    assert.equal(saved.waitingDeadlineAt,deadline);assert.equal(saved.status,'queued');
    human(f,'account_handoff');assert.equal(f.store.read().tasks[0].humanAction?.deadline,deadline);
    assert.equal(f.controller.snapshot().humanActionCapabilities![tid].canDone,false);
  }finally{f.close()}
});

test('6d capability evaluation reuses the supplied snapshot without new Store reads',()=>{
  const f=fixture();try{
    human(f,'account_registration_submitted');const state=f.store.read();
    let reads=0;const original=f.store.read.bind(f.store);
    f.store.read=()=>{reads++;return original()};
    const mode=(f.controller as unknown as {humanCompletionMode(task:Task,state:ReturnType<Store['read']>,channels:Channel[]):string}).humanCompletionMode;
    for(let count=0;count<50;count++)assert.equal(mode.call(f.controller,state.tasks[0],state,[f.channel]),'page_check');
    assert.equal(reads,0);
  }finally{f.close()}
});

test('6d proven article approval and read-only registration success retire only the resolved gate clock',async()=>{
  const f=fixture({humanBrowserComplete:async()=>true});try{
    const since=new Date(Date.now()-47*3600_000),now=new Date(),after=new Date(Date.now()+2*3600_000);
    human(f,'article_review','other','manual_review');f.store.update(state=>{const task=state.tasks[0],action=createHumanAction(f.task,{kind:'other'},since);Object.assign(task,{humanAction:action,waitingSince:action.since,waitingDeadlineAt:action.deadline})});
    f.controller.patch(tid,{articleApprovedAt:now.toISOString(),status:'queued',scheduledAt:after.toISOString()});
    assert.equal(f.store.read().tasks[0].waitingDeadlineAt,undefined);
    f.store.update(state=>maintainWaitingTasks(state.tasks,state.sites,[f.channel],state.settings,after));assert.equal(f.store.read().tasks[0].status,'queued');
    f.store.update(state=>{state.accounts[0].status='registered'});
    human(f,'account_registration_submitted');await f.controller.doneHumanAction(tid);assert.equal(f.store.read().tasks[0].waitingSince,undefined);assert.equal(f.store.read().tasks[0].waitingDeadlineAt,undefined);
  }finally{f.close()}
});
