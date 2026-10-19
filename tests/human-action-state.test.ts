import test from 'node:test';
import assert from 'node:assert/strict';
import type {Account, Site, Task} from '../src/shared/types';
import {createHumanAction, collectHumanActionNotifications, HUMAN_ACTION_KINDS, humanActionReason, validHumanAction} from '../src/shared/human-action';
import {taskTransition, assertHumanWaitOpen} from '../src/main/task-state';
import {migrateTaskReason} from '../src/main/task-reason-migration';
import {maintainWaitingTasks} from '../src/main/task-recovery';
import {defaultSettings, emptyState} from '../src/main/store';
import {validateBackup} from '../src/main/backup-validation';
import {CHANNELS} from '../src/integrations/catalog';

const since='2026-10-18T00:00:00.000Z',deadline='2026-10-20T00:00:00.000Z';
const siteId='11111111-1111-4111-8111-111111111111';
const taskId='22222222-2222-4222-8222-222222222222';
const accountId='33333333-3333-4333-8333-333333333333';
const mailboxId='44444444-4444-4444-8444-444444444444';
const site:Site={id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Example fixture',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:since};
function task(extra:Partial<Task>={}):Task{return {id:taskId,siteId,channelId:'fixture-channel',sourceDomain:'platform.example.com',status:'queued',createdAt:since,updatedAt:since,scheduledAt:since,attempts:0,message:'fixture',...extra};}
function waiting(kind:typeof HUMAN_ACTION_KINDS[number]='captcha',extra:Partial<Task>={}):Task{
  const value=task({status:'needs_input',reasonCode:humanActionReason(kind),...extra});
  value.humanAction=createHumanAction(value,{kind},new Date(since));
  value.waitingSince=value.humanAction.since;value.waitingDeadlineAt=value.humanAction.deadline;
  return value;
}
function backup(value:Task,account?:Account){
  const state=emptyState();state.sites=[structuredClone(site)];state.tasks=[value];
  if(account)state.accounts=[account];
  return {state,secrets:{} as Record<string,string>};
}
function account():Account{return {id:accountId,channelId:'fixture-channel',email:'owner@example.com',username:'fixture',createdAt:since,status:'draft',hasPassword:false,source:'generated'};}
function emailWait():NonNullable<Task['emailWait']>{return {kind:'code',recipient:'owner@example.com',since,nextPollAt:'2026-10-18T00:00:30.000Z',expiresAt:'2026-10-18T00:15:00.000Z',consumedMessageIds:[],continuation:'browser'};}
function emailDelivery():string{return JSON.stringify({kind:'code',value:'123456',recipient:'owner@example.com',expiresAt:emailWait().expiresAt});}
function signup():NonNullable<Task['signup']>{return {version:1,scriptId:'mock-local-signup',scriptVersion:1,identityId:accountId,stepIndex:2,status:'waiting_email',runtimeId:'fixture-runtime',updatedAt:since,aiLocateCalls:0,aiLocatedStepIds:[],irreversible:{stepId:'submit',at:since}};}
function confirmationBackup(){
  const wait={...emailWait(),mailboxId};
  const value=waiting('email_confirmation',{checkpoint:'email_confirmation',accountId,emailConfirmation:{wait,messageId:'confirmation-message'}});
  value.humanAction!.expiresAt=wait.expiresAt;
  const input=backup(value,{...account(),mailboxId});
  input.state.mailboxes=[{id:mailboxId,label:'Fixture',host:'imap.example.com',port:993,user:'owner@example.com',secure:true,hasPassword:true,aliases:[],createdAt:since,updatedAt:since,verifiedAt:since}];
  input.state.emailConsumptions=[{channelId:value.channelId,recipient:wait.recipient,messageIds:['confirmation-message']}];
  input.secrets[`mailbox:${mailboxId}`]='fixture-password';
  input.secrets[`signup:${taskId}:email`]=emailDelivery();
  return input;
}

test('b9a2 AI setup only queues an explicit setup transition and is cleared on running',()=>{
  const value=task();
  Object.assign(value,taskTransition(value,{status:'needs_input',checkpoint:'ai_setup_required'},new Date(since)));
  assert.equal(value.status,'queued');assert.equal(value.humanAction,undefined);
  const stale={...value};
  Object.assign(stale,taskTransition(stale,{status:'needs_input',reasonCode:'account_handoff'},new Date(since)));
  assert.equal(stale.status,'needs_input');assert.equal(stale.humanAction?.kind,'account_login');assert.equal(stale.checkpoint,undefined);
  Object.assign(value,taskTransition(value,{status:'running'},new Date(since)));
  assert.equal(value.checkpoint,undefined);
  Object.assign(value,taskTransition(value,{status:'needs_input',reasonCode:'captcha_required'},new Date(since)));
  assert.equal(value.status,'needs_input');assert.equal((value as Task).humanAction?.kind,'captcha');
  assert.doesNotThrow(()=>validateBackup(backup(value)));
});

test('b9a2 a pre-review human stop clears the stale failed review',()=>{
  const value=task({articleReview:{status:'failed',reason:'fixture',reasonCode:'ai_unavailable',evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)}});
  Object.assign(value,taskTransition(value,{status:'needs_input',checkpoint:'account_handoff',reasonCode:'account_handoff'},new Date(since)));
  assert.equal(value.articleReview,undefined);assert.equal(value.humanAction?.kind,'account_login');
  assert.doesNotThrow(()=>validateBackup(backup(value)));
});

test('all structured human kinds map to existing reasons and fixed first-observation deadlines',()=>{
  for(const kind of HUMAN_ACTION_KINDS){
    const value=task();
    Object.assign(value,taskTransition(value,{status:'needs_input',humanAction:createHumanAction(value,{kind},new Date(since))},new Date(since)));
    assert.equal(value.reasonCode,humanActionReason(kind));assert.equal(value.humanAction?.deadline,deadline);
    const saved=structuredClone(value.humanAction);
    Object.assign(value,taskTransition(value,{status:'needs_input',message:'new observation'},new Date('2026-10-19T01:00:00.000Z')));
    assert.deepEqual(value.humanAction,saved);assert.equal(value.waitingDeadlineAt,deadline);
  }
});

test('changing a typed human reason updates its action while preserving the original clock',()=>{
  const value=waiting();
  Object.assign(value,taskTransition(value,{reasonCode:'phone_required'},new Date('2026-10-19T00:00:00.000Z')));
  assert.equal(value.humanAction?.kind,'phone');assert.equal(value.humanAction?.instruction,'phone');
  assert.equal(value.humanAction?.since,since);assert.equal(value.humanAction?.deadline,deadline);
});

test('email transport remains automatic while a real needs_input stop gains a deadline',()=>{
  const value=task({status:'running'});
  Object.assign(value,taskTransition(value,{status:'needs_input',checkpoint:'waiting_email',reasonCode:undefined,emailWait:emailWait(),message:'captcha phone agreement'},new Date(since)));
  assert.equal(value.humanAction,undefined);assert.equal(value.reasonCode,undefined);assert.equal(value.waitingSince,undefined);
  migrateTaskReason(value,new Date('2026-10-19T00:00:00.000Z'));
  assert.equal(value.reasonCode,undefined);assert.equal(value.humanAction,undefined);
  const explicit=taskTransition(task(),{status:'needs_input',reasonCode:undefined,message:'captcha'},new Date(since));
  assert.equal(explicit.reasonCode,'human_required');assert.equal(explicit.humanAction?.deadline,deadline);
});

test('nonhuman checkpoint transitions clear stale human waits and keep their structured reasons',()=>{
  const referral=waiting('captcha');
  Object.assign(referral,taskTransition(referral,{status:'needs_input',checkpoint:'referral_guard',reasonCode:'referral_blocked'},new Date(since)));
  assert.equal(referral.status,'failed');assert.equal(referral.reasonCode,'referral_blocked');assert.equal(referral.humanAction,undefined);assert.equal(referral.waitingDeadlineAt,undefined);
  const eligibility=waiting('phone');
  Object.assign(eligibility,taskTransition(eligibility,{checkpoint:'eligibility_wait'},new Date(since)));
  assert.equal(eligibility.status,'skipped');assert.equal(eligibility.reasonCode,'channel_ineligible');assert.equal(eligibility.humanAction,undefined);assert.equal(eligibility.waitingSince,undefined);
});

test('handoff navigation drops token query/hash, masks credentials and preserves ambiguous code context',()=>{
  const action=createHumanAction(task(),{url:'https://platform.example.com/login?token=fixture-secret#fixture',snippet:'owner@example.com code 123456 password=fixture-secret https://example.com/verify?token=fixture'},new Date(since));
  assert.equal(action.url,'https://platform.example.com/login');assert.ok(validHumanAction(action));
  for(const secret of ['owner@example.com','fixture-secret','token=fixture'])assert.equal(action.snippet?.includes(secret),false);
  assert.equal(action.snippet?.includes('123456'),true);
  assert.equal(createHumanAction(task(),{url:'javascript:alert(1)'},new Date(since)).url,'');
});

test('legacy human migration persists the same action and never resets its wait on later loads',()=>{
  const value=task({status:'needs_input',message:'需要人工完成验证码。'});
  assert.equal(migrateTaskReason(value,new Date(since)),true);assert.equal(value.humanAction?.kind,'captcha');
  const first=structuredClone(value);
  assert.equal(migrateTaskReason(value,new Date('2026-11-01T00:00:00.000Z')),false);assert.deepEqual(value,first);
});

test('all human kinds time out at 48h, preserve work and enter the existing 14-day cooldown',()=>{
  const channel={...CHANNELS[0],id:'fixture-channel',automation:'browser' as const};
  for(const kind of HUMAN_ACTION_KINDS){
    const value=waiting(kind,{draft:{title:'Fixture',description:'Fixture',body:'Original'},cost:{aiCalls:2}});
    maintainWaitingTasks([value],[site],[channel],defaultSettings(),new Date(deadline));
    assert.equal(value.status,'skipped');assert.equal(value.reasonCode,'human_timeout');
    assert.equal(value.cooldownUntil,'2026-11-03T00:00:00.000Z');assert.equal(value.draft?.body,'Original');assert.equal(value.cost?.aiCalls,2);
    assert.throws(()=>assertHumanWaitOpen(value,new Date(deadline)),error=>(error as {reasonCode:string}).reasonCode==='human_timeout');
  }
});

test('user-skipped human actions remain valid retained backup evidence',()=>{
  const value=waiting('consent'),action=structuredClone(value.humanAction);
  Object.assign(value,taskTransition(value,{status:'skipped',reasonCode:'user_skipped'},new Date(since)));
  assert.deepEqual(value.humanAction,action);
  assert.deepEqual(validateBackup(backup(value)).state.tasks[0].humanAction,action);
});

test('registration-only waits release capacity at 48h without removing their identity or resubmission evidence',()=>{
  const channel={...CHANNELS[0],id:'fixture-channel',automation:'browser' as const};
  const value=waiting('account_login',{accountId,checkpoint:'account_registration_submitted',submittedAt:since});
  maintainWaitingTasks([value],[site],[channel],defaultSettings(),new Date(deadline));
  assert.equal(value.status,'skipped');assert.equal(value.reasonCode,'human_timeout');assert.equal(value.accountId,accountId);
  assert.equal(value.submittedAt,since);assert.equal(value.checkpoint,'account_registration_submitted');
  assert.throws(()=>taskTransition(value,{status:'queued'},new Date(deadline)));
});

test('expiring verification notifies immediately then joins daily summary after expiry',()=>{
  const expiring=waiting('email_code_ambiguous');expiring.humanAction!.expiresAt='2026-10-18T00:15:00.000Z';
  const ordinary=waiting('phone');ordinary.id='55555555-5555-4555-8555-555555555555';
  const first=collectHumanActionNotifications([expiring,ordinary],new Date(since),'Asia/Singapore');
  assert.deepEqual(first.immediate,[expiring]);assert.deepEqual(first.daily,[ordinary]);
  assert.deepEqual(collectHumanActionNotifications([expiring,ordinary],new Date('2026-10-18T01:00:00.000Z'),'Asia/Singapore'),{immediate:[],daily:[expiring]});
  assert.deepEqual(collectHumanActionNotifications([expiring,ordinary],new Date('2026-10-18T02:00:00.000Z'),'Asia/Singapore'),{immediate:[],daily:[]});
  const next=collectHumanActionNotifications([expiring,ordinary],new Date('2026-10-18T16:01:00.000Z'),'Asia/Singapore');
  assert.deepEqual(next.immediate,[]);assert.deepEqual(next.daily,[expiring,ordinary]);
});

test('new expiring verification is not suppressed by an earlier ordinary daily reminder',()=>{
  const value=waiting('account_login');
  collectHumanActionNotifications([value],new Date(since));
  const action=createHumanAction(value,{kind:'captcha',expiresAt:'2026-10-18T00:15:00.000Z'},new Date(since));
  Object.assign(value,taskTransition(value,{humanAction:action},new Date(since)));
  assert.deepEqual(collectHumanActionNotifications([value],new Date(since)).immediate,[value]);
});

test('strict backup roundtrips human action and accepts old tasks without Batch6 state',()=>{
  const value=waiting('consent');
  assert.deepEqual(validateBackup(backup(value)).state.tasks[0].humanAction,value.humanAction);
  assert.equal(validateBackup(backup(task())).state.tasks.length,1);
});

test('backup rejects human action deadline, binding, extra secret and instruction tampering',()=>{
  const changes:Array<(value:Record<string,unknown>)=>void>=[
    value=>{value.deadline='2026-10-21T00:00:00.000Z';},value=>{value.platform='different-channel';},
    value=>{value.code='123456';},value=>{value.instruction='arbitrary imported instruction';},
    value=>{value.url='https://platform.example.com/login?token=fixture';},value=>{value.notifiedAt='2026-10-17T00:00:00.000Z';},
  ];
  for(const change of changes){const input=backup(waiting());change(input.state.tasks[0].humanAction as unknown as Record<string,unknown>);assert.throws(()=>validateBackup(input));}
});

test('email waits restore without human conversion and reject wrong recipient, continuation and chronology',()=>{
  const value=task({status:'needs_input',checkpoint:'waiting_email',emailWait:emailWait()});
  const restored=validateBackup(backup(value)).state.tasks[0];
  assert.deepEqual(restored.emailWait,value.emailWait);assert.equal(restored.humanAction,undefined);assert.equal(restored.reasonCode,undefined);
  for(const partial of [{recipient:'other@example.com'},{continuation:'shiply' as const},{nextPollAt:'2026-10-18T00:16:00.000Z'},{consumedMessageIds:['one','one']}]){
    assert.throws(()=>validateBackup(backup({...value,emailWait:{...emailWait(),...partial}})));
  }
  const changed=validateBackup(backup({...value,emailWait:{...emailWait(),mailboxId}}));
  assert.equal(changed.state.tasks[0].checkpoint,'email_verification_human');
  assert.equal(changed.state.tasks[0].humanAction?.kind,'account_login');
  assert.equal(changed.state.tasks[0].emailWait,undefined);
});

test('signup/email state and transient secret bind to the preserved task identity and survive delivery',()=>{
  for(const checkpoint of ['signup_resume','account_registration_submitted']){
    const value=task({status:'queued',checkpoint,accountId,signup:signup(),emailWait:{...emailWait(),continuation:'signup'}});
    const input=backup(value,account());input.secrets[`signup:${taskId}:email`]=emailDelivery();input.secrets[`signup:${taskId}:api_key`]='fixture-api-key';
    const restored=validateBackup(input);
    assert.deepEqual(restored.state.tasks[0].signup,value.signup);assert.equal(restored.secrets[`signup:${taskId}:email`],emailDelivery());
  }
  const browser=backup(task({status:'queued',checkpoint:'account_registration_submitted',emailWait:emailWait()}));
  browser.secrets[`signup:${taskId}:email`]=emailDelivery();assert.equal(validateBackup(browser).state.tasks[0].signup,undefined);
  browser.secrets[`signup:${taskId}:api_key`]='fixture-api-key';assert.throws(()=>validateBackup(browser));
});

test('signup backup rejects orphan identity, plaintext task secrets, and unsafe success declarations',()=>{
  const original=task({status:'needs_input',checkpoint:'waiting_email',accountId,signup:signup(),emailWait:{...emailWait(),continuation:'signup'}});
  const changes:Array<(value:Record<string,unknown>)=>void>=[value=>{value.identityId=mailboxId;},value=>{value.apiKey='fixture';},value=>{value.aiLocateCalls=0;value.aiLocatedStepIds=['field'];},value=>{value.successCondition={url:'https://example.com/?token=fixture'};}];
  for(const change of changes){const input=backup(structuredClone(original),account());change(input.state.tasks[0].signup as unknown as Record<string,unknown>);assert.throws(()=>validateBackup(input));}
  const orphan=backup(task());orphan.secrets[`signup:${taskId}:email`]='123456';assert.throws(()=>validateBackup(orphan));
});

test('encrypted email delivery rejects mismatched recipient, kind, expiry and unrecognized payload fields',()=>{
  for(const partial of [{recipient:'other@example.com'},{kind:'link',value:'https://platform.example.com/verify?token=fixture'},{expiresAt:deadline},{password:'fixture'}]){
    const input=backup(task({status:'queued',checkpoint:'account_registration_submitted',emailWait:emailWait()}));
    input.secrets[`signup:${taskId}:email`]=JSON.stringify({...JSON.parse(emailDelivery()),...partial});
    assert.throws(()=>validateBackup(input));
  }
});

test('pending one-click email confirmation roundtrips its binding and vault-only delivery',()=>{
  const input=confirmationBackup(),restored=validateBackup(input);
  assert.deepEqual(restored.state.tasks[0].emailConfirmation,input.state.tasks[0].emailConfirmation);
  assert.equal(restored.state.tasks[0].humanAction?.kind,'email_confirmation');
  assert.equal(restored.secrets[`signup:${taskId}:email`],emailDelivery());
  assert.equal(JSON.stringify(restored.state.tasks[0]).includes('123456'),false);
  const scripted=confirmationBackup();scripted.state.tasks[0].signup=signup();scripted.state.tasks[0].emailConfirmation!.wait.continuation='signup';
  assert.equal(validateBackup(scripted).state.tasks[0].signup?.status,'waiting_email');
});

test('confirmation backup rejects missing proof and malformed action bindings',()=>{
  const changes:Array<(input:ReturnType<typeof confirmationBackup>)=>void>=[
    input=>{delete input.secrets[`signup:${taskId}:email`]},
    input=>{input.state.emailConsumptions=[]},
    input=>{input.state.tasks[0].emailConfirmation!.messageId='different-message'},
    input=>{input.state.tasks[0].accountId=mailboxId},
    input=>{input.state.accounts[0].email='other@example.com'},
    input=>{input.state.tasks[0].humanAction!.expiresAt='2026-10-18T00:16:00.000Z'},
    input=>{input.state.tasks[0].humanAction!.kind='email_code_ambiguous';input.state.tasks[0].humanAction!.instruction='email_code_ambiguous'},
    input=>{input.state.tasks[0].emailWait=emailWait()},
    input=>{input.state.tasks[0].emailConfirmation!.wait.continuation='shiply'},
    input=>{(input.state.tasks[0].emailConfirmation as unknown as Record<string,unknown>).code='123456'},
  ];
  for(const change of changes){const input=confirmationBackup();change(input);assert.throws(()=>validateBackup(input))}
  const noDescriptor=confirmationBackup();noDescriptor.state.tasks[0].emailConfirmation=undefined;assert.throws(()=>validateBackup(noDescriptor));
});
test('confirmation backup repairs changed inbox binding and deletes its delivery secret',()=>{
  for(const change of [(input:ReturnType<typeof confirmationBackup>)=>{input.state.accounts[0].mailboxId=undefined},(input:ReturnType<typeof confirmationBackup>)=>{input.state.accounts[0].mailboxId=undefined;input.state.mailboxes=[];delete input.secrets[`mailbox:${mailboxId}`]}]){
    const input=confirmationBackup();change(input);
    const restored=validateBackup(input),task=restored.state.tasks[0];
    assert.equal(task.checkpoint,'email_verification_human');
    assert.equal(task.reasonCode,'account_handoff');
    assert.equal(task.humanAction?.kind,'account_login');
    assert.equal(task.emailConfirmation,undefined);
    assert.equal(restored.secrets[`signup:${taskId}:email`],undefined);
    assert.deepEqual(restored.state.emailConsumptions?.[0]?.messageIds,['confirmation-message']);
  }
});
