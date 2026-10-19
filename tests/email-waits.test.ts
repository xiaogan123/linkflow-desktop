import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {EmailWaitCoordinator,mailConsumptionIds,mailIdentityConflict,recordMailConsumption} from '../src/main/email-waits';
import {scanVerificationBatch,type VerificationMailClient} from '../src/integrations/mail';
import {taskTransition} from '../src/main/task-state';
import type {ExecutionContext,Mailbox,Site,Task} from '../src/shared/types';
import type {VerificationResult} from '../src/shared/mail-automation';
import {createHumanAction} from '../src/shared/human-action';

const stamp='2026-10-18T00:00:00.000Z';
const site:Site={id:'11111111-1111-4111-8111-111111111111',domain:'example.com',url:'https://example.com',name:'Example',email:'owner@example.com',description:'Example',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp};
const task:Task={id:'22222222-2222-4222-8222-222222222222',siteId:site.id,channelId:'example',sourceDomain:'example-site.com',status:'running',createdAt:stamp,updatedAt:stamp,scheduledAt:stamp,attempts:0,message:'fixture'};
const mailbox:Mailbox={id:'44444444-4444-4444-8444-444444444444',label:'Fixture',host:'imap.example.com',port:993,user:'owner@example.com',secure:true,hasPassword:true,aliases:[],createdAt:stamp,updatedAt:stamp,verifiedAt:stamp};
function fixture(scan:()=>Promise<VerificationResult>,confirm?:(task:Task,result:Extract<VerificationResult,{kind:'confirmation_required'}>)=>Promise<void>){
  let clock=new Date(stamp),consumed=0,patches=0;
  const store=new Store(':memory:');
  store.update(state=>{state.settings.autoRun=true;state.settings.mail.hasPassword=true;state.sites=[site];state.tasks=[structuredClone(task)];state.mailboxes=[mailbox]});
  const patch=(id:string,partial:Partial<Task>)=>{patches++;store.update(state=>{const saved=state.tasks.find(value=>value.id===id)!;Object.assign(saved,taskTransition(saved,partial,clock))})};
  const waits=new EmailWaitCoordinator(store,{patch,now:()=>clock,context:current=>({task:current,settings:store.read().settings,mailbox} as ExecutionContext),scan,
    recordConsumed:(current,messageId)=>{let accepted=false;store.update(state=>{accepted=recordMailConsumption(state,current.channelId,current.emailWait!.recipient,messageId)});return accepted},consume:async()=>{consumed++},confirm});
  const register=()=>waits.register(store.read().tasks[0],{kind:'code',recipient:'owner+example@example.com',mailboxId:mailbox.id,continuation:'browser'});
  return {store,waits,register,patch,advance:(ms:number)=>{clock=new Date(clock.getTime()+ms)},consumed:()=>consumed,patches:()=>patches};
}

test('registration returns without scanning and no pending mail never connects',async()=>{
  let scans=0;const f=fixture(async()=>{scans++;return {kind:'none'}});
  try{await f.waits.poll();assert.equal(scans,0);f.register();assert.equal(scans,0);assert.equal(f.store.read().tasks[0].checkpoint,'waiting_email');assert.equal(f.store.read().tasks[0].humanAction,undefined);await f.waits.poll();assert.equal(scans,0);f.advance(45_000);await f.waits.poll();assert.equal(scans,1);await f.waits.poll();assert.equal(scans,1);f.advance(60_000);await f.waits.poll();assert.equal(scans,2)}finally{f.store.close()}
});

test('a pending IMAP scan leaves another task runnable and is never duplicated',async()=>{
  let resolve!:(result:VerificationResult)=>void,scans=0;
  const f=fixture(()=>{scans++;return new Promise(done=>{resolve=done})});
  try{
    f.register();f.advance(45_000);const pending=f.waits.poll();assert.equal(f.waits.poll(),pending);
    f.store.update(state=>state.tasks.push({...task,id:'33333333-3333-4333-8333-333333333333',status:'queued'}));
    // This is the publication loop's independent claim while the IMAP promise is unresolved.
    const other=f.store.read().tasks.find(value=>value.status==='queued')!;
    f.patch(other.id,{status:'running'});assert.equal(f.store.read().tasks[1].status,'running');assert.equal(scans,1);
    resolve({kind:'code',code:'834792',snippet:'OTP: 834792',messageId:'fixture-message'});await pending;
    assert.equal(f.consumed(),1);assert.equal(f.store.read().tasks[0].status,'queued');assert.deepEqual(f.store.read().tasks[0].emailWait?.consumedMessageIds,['fixture-message']);
    assert.deepEqual(mailConsumptionIds(f.store.read(),'example','owner+example@example.com'),['fixture-message']);
  }finally{f.store.close()}
});

test('ambiguous email is a structured expiring handoff that cannot be silently reenrolled',async()=>{
  const f=fixture(async()=>({kind:'ambiguous',candidates:['834792','917352'],snippet:'code 834792; OTP 917352'}));
  try{f.register();f.advance(45_000);await f.waits.poll();const saved=f.store.read().tasks[0];assert.equal(f.consumed(),0);assert.equal(saved.humanAction?.kind,'email_code_ambiguous');assert.equal(saved.humanAction?.expiresAt,'2026-10-18T00:10:00.000Z');assert.match(saved.humanAction?.snippet??'',/834792/);assert.equal(saved.emailWait,undefined);assert.equal(f.register(),undefined);assert.equal(f.store.read().tasks[0].humanAction?.kind,'email_code_ambiguous')}finally{f.store.close()}
});

test('same channel and recipient has one active wait and preserves consumed IDs after wait removal',async()=>{
  const f=fixture(async()=>({kind:'code',code:'834792',snippet:'OTP 834792',messageId:'shared-message'}));
  try{
    const second={...task,id:'33333333-3333-4333-8333-333333333333'};
    f.store.update(state=>{state.tasks.push(second)});
    f.register();
    assert.equal(f.waits.register(second,{kind:'code',recipient:'owner+example@example.com',mailboxId:mailbox.id,continuation:'browser'}),undefined);
    f.advance(45_000);await f.waits.poll();assert.equal(f.consumed(),1);
    assert.ok(f.waits.register(f.store.read().tasks[1],{kind:'code',recipient:'owner+example@example.com',mailboxId:mailbox.id,continuation:'browser'}));
    f.store.update(state=>{state.tasks[0].emailWait=undefined});
    const enrolled=f.waits.register(f.store.read().tasks[1],{kind:'code',recipient:'owner+example@example.com',mailboxId:mailbox.id,continuation:'browser'});
    assert.deepEqual(enrolled?.consumedMessageIds,['shared-message']);
  }finally{f.store.close()}
});

test('repeated occupancy observations do not rewrite an unchanged queued wait',()=>{
  const f=fixture(async()=>({kind:'none'}));
  try{
    const second={...task,id:'33333333-3333-4333-8333-333333333333'};
    f.store.update(state=>state.tasks.push(second));f.register();
    const input={kind:'code' as const,recipient:'owner+example@example.com',mailboxId:mailbox.id,continuation:'browser' as const};
    f.waits.register(f.store.read().tasks[1],input);
    const afterFirst=f.patches(),saved=structuredClone(f.store.read().tasks[1]);
    for(let tick=0;tick<20;tick++){f.advance(60_000);f.waits.register(f.store.read().tasks[1],input)}
    assert.equal(f.patches(),afterFirst);assert.deepEqual(f.store.read().tasks[1],saved);
    assert.equal(saved.reasonCode,'email_code_pending');
  }finally{f.store.close()}
});

test('a per-message confirmation reserves its message and never consumes or resumes automatically',async()=>{
  let confirmations=0;
  const result:Extract<VerificationResult,{kind:'confirmation_required'}>={kind:'confirmation_required',candidate:{kind:'code',code:'834792'},snippet:'Verification email',messageId:'confirmation-message'};
  const f=fixture(async()=>result,async(current,received)=>{
    confirmations++;assert.deepEqual(received,result);
    f.patch(current.id,{status:'needs_input',checkpoint:'email_confirmation',reasonCode:'human_required',
      humanAction:createHumanAction(current,{kind:'email_confirmation',expiresAt:current.emailWait!.expiresAt},new Date('2026-10-18T00:00:45.000Z')),
      emailConfirmation:{wait:current.emailWait!,messageId:received.messageId!},emailWait:undefined});
  });
  try{
    f.register();f.advance(45_000);await f.waits.poll();
    const saved=f.store.read().tasks[0];
    assert.equal(confirmations,1);assert.equal(f.consumed(),0);assert.equal(saved.status,'needs_input');assert.equal(saved.humanAction?.kind,'email_confirmation');
    assert.equal(saved.emailWait,undefined);assert.equal(saved.emailConfirmation?.messageId,'confirmation-message');
    assert.deepEqual(mailConsumptionIds(f.store.read(),'example','owner+example@example.com'),['confirmation-message']);
    assert.equal(JSON.stringify(saved).includes('834792'),false);
    f.advance(60_000);await f.waits.poll();assert.equal(confirmations,1);assert.equal(f.register(),undefined);
  }finally{f.store.close()}
});

test('confirmation candidates require matching wait type and a persistence handler',async()=>{
  const noHandler=fixture(async()=>({kind:'confirmation_required',candidate:{kind:'code',code:'834792'},snippet:'Verification',messageId:'unhandled-message'}));
  try{
    noHandler.register();noHandler.advance(45_000);await noHandler.waits.poll();
    assert.equal(noHandler.store.read().tasks[0].humanAction?.kind,'email_code_ambiguous');assert.equal(noHandler.consumed(),0);
    assert.deepEqual(mailConsumptionIds(noHandler.store.read(),'example','owner+example@example.com'),[]);
  }finally{noHandler.store.close()}
  const mismatch=fixture(async()=>({kind:'confirmation_required',candidate:{kind:'link',url:'https://example-site.com/verify?token=fixture'},snippet:'Verification',messageId:'mismatched-message'}),async()=>{throw Error('must not confirm a link for a code wait')});
  try{
    mismatch.register();mismatch.advance(45_000);await mismatch.waits.poll();
    assert.equal(mismatch.store.read().tasks[0].checkpoint,'waiting_email');assert.equal(mismatch.consumed(),0);
    assert.deepEqual(mailConsumptionIds(mismatch.store.read(),'example','owner+example@example.com'),[]);
  }finally{mismatch.store.close()}
});

test('known separate account for the same platform and address cannot receive another identity\'s mail',async()=>{
  let scans=0;const f=fixture(async()=>{scans++;return {kind:'none'}});
  try{
    const account={id:'55555555-5555-4555-8555-555555555555',channelId:'example',email:'owner+example@example.com',username:'other',createdAt:stamp,status:'registered' as const,hasPassword:true};
    f.store.update(state=>{state.accounts.push(account)});
    assert.equal(mailIdentityConflict(f.store.read(),undefined,'example','Owner+Example@example.com'),true);
    assert.equal(f.register(),undefined);assert.equal(f.store.read().tasks[0].emailWait,undefined);
    f.store.update(state=>{state.accounts=[]});
    f.register();f.store.update(state=>{state.accounts.push(account)});
    f.advance(45_000);await f.waits.poll();
    assert.equal(scans,0);assert.equal(f.store.read().tasks[0].humanAction?.kind,'account_login');
  }finally{f.store.close()}
});

test('one mailbox authentication failure stops every wait and reports it once',async()=>{
  const f=fixture(async()=>{throw Error('per-task scanner must not run')});
  try{
    const second={...task,id:'33333333-3333-4333-8333-333333333333'};
    f.store.update(state=>{state.tasks.push(second)});
    f.register();f.waits.register(second,{kind:'code',recipient:'other@example.com',mailboxId:mailbox.id,continuation:'browser'});
    f.advance(45_000);
    let scans=0,failures=0;
    const waits=new EmailWaitCoordinator(f.store,{patch:f.patch,now:()=>new Date('2026-10-18T00:00:45.000Z'),context:current=>({task:current,settings:f.store.read().settings,mailbox} as ExecutionContext),
      scan:async()=>{throw Error('individual scan must not run')},scanBatch:async()=>{scans++;throw Object.assign(Error('Authentication failed'),{serverResponseCode:'AUTHENTICATIONFAILED'})},
      recordConsumed:()=>{throw Error('no candidate')},consume:async()=>{throw Error('no candidate')},onAuthenticationFailure:()=>{failures++}});
    await waits.poll();
    assert.equal(scans,1);assert.equal(failures,1);
    assert.deepEqual(f.store.read().tasks.map(item=>item.humanAction?.kind),['account_login','account_login']);
    assert.ok(f.store.read().tasks.every(item=>item.emailWait===undefined));
  }finally{f.store.close()}
});

test('expiry and late results after pause do not consume a code',async()=>{
  const expired=fixture(async()=>{throw Error('must not connect')});
  try{expired.register();expired.advance(10*60_000);await expired.waits.poll();assert.equal(expired.store.read().tasks[0].humanAction?.kind,'account_login')}finally{expired.store.close()}
  let resolve!:(value:VerificationResult)=>void;const f=fixture(()=>new Promise(done=>{resolve=done}));
  try{f.register();f.advance(45_000);const pending=f.waits.poll();f.store.update(state=>{state.settings.autoRun=false});resolve({kind:'code',code:'834792',snippet:'OTP 834792',messageId:'late'});await pending;assert.equal(f.consumed(),0);assert.equal(f.store.read().tasks[0].status,'needs_input')}finally{f.store.close()}
});

test('saved polling time survives restart and recipient replacement rejects an in-flight result',async()=>{
  let resolve!:(value:VerificationResult)=>void;const f=fixture(()=>new Promise(done=>{resolve=done}));
  try{f.register();f.advance(45_000);const pending=f.waits.poll();f.store.update(state=>{state.tasks[0].emailWait!.recipient='different@example.com'});resolve({kind:'code',code:'834792',snippet:'OTP 834792',messageId:'replacement'});await pending;assert.equal(f.consumed(),0);assert.equal(f.store.read().tasks[0].emailWait?.nextPollAt,'2026-10-18T00:01:45.000Z')}finally{f.store.close()}
});

test('coordinator uses the real scanner with fake IMAP and never reuses a consumed message across tasks',async()=>{
  const f=fixture(async()=>{throw Error('stub scanner must not run')});
  try{
    f.store.update(state=>{state.mailboxes[0].host='imap.gmail.com'});
    let clock=new Date(stamp),connects=0,consumed=0;
    const source=Buffer.from('Received: from mail.example-site.com by mx.google.com with ESMTPS; Sun, 18 Oct 2026 00:00:00 +0000\r\nAuthentication-Results: mx.google.com; dkim=pass header.d=example-site.com\r\nSubject: OTP 123456\r\n\r\nOTP 123456');
    const client:VerificationMailClient={usable:true,on:()=>{},connect:async()=>{connects++},logout:async()=>{},list:async()=>[],getMailboxLock:async()=>({release(){}}),search:async()=>[1],fetch:async function*(){yield {envelope:{from:[{address:'noreply@example-site.com'}],to:[{address:'owner+example@example.com'}],date:stamp,subject:'OTP 123456',messageId:'shared-message'},internalDate:stamp,source}}};
    const real=new EmailWaitCoordinator(f.store,{patch:f.patch,now:()=>clock,
      context:(current,signal)=>({task:current,site,channel:{domain:'example-site.com',allowedHosts:['example-site.com']},mailbox:{...mailbox,host:'imap.gmail.com'},settings:f.store.read().settings,secrets:{get:async()=> 'fixture-password'},getAccount:()=>undefined,signal} as unknown as ExecutionContext),
      scan:async()=>{throw Error('single scanner must not run')},
      scanBatch:contexts=>scanVerificationBatch(contexts,{now:clock,dependencies:{createClient:()=>client,parse:async()=>({subject:'OTP 123456',messageId:'shared-message'})}}),
      recordConsumed:(current,messageId)=>{let accepted=false;f.store.update(state=>{accepted=recordMailConsumption(state,current.channelId,current.emailWait!.recipient,messageId)});return accepted},
      consume:async()=>{consumed++}});
    f.register();clock=new Date(clock.getTime()+45_000);await real.poll();
    assert.equal(connects,1);assert.equal(consumed,1);
    f.store.update(state=>{state.tasks[0].emailWait=undefined;state.tasks.push({...task,id:'33333333-3333-4333-8333-333333333333'})});
    real.register(f.store.read().tasks[1],{kind:'code',recipient:'owner+example@example.com',mailboxId:mailbox.id,continuation:'browser'});
    clock=new Date(clock.getTime()+45_000);await real.poll();
    assert.equal(connects,2);assert.equal(consumed,1);assert.equal(f.store.read().tasks[1].checkpoint,'waiting_email');
    assert.deepEqual(mailConsumptionIds(f.store.read(),'example','owner+example@example.com'),['shared-message']);
  }finally{f.store.close()}
});
