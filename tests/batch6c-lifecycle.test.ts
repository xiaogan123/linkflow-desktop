import test from 'node:test';
import assert from 'node:assert/strict';
import {Store,emptyState} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {taskTransition} from '../src/main/task-state';
import {validateBackup} from '../src/main/backup-validation';
import {decryptBackup,encryptBackup} from '../src/main/backup';
import {emailValueKey,mailConsumptionIds} from '../src/main/email-waits';
import {bindAccount} from '../src/main/account-bindings';
import {hasUnresolvedExternalAttempt,isPendingPublisherRegistration} from '../src/shared/publication';
import {createHumanAction} from '../src/shared/human-action';
import {CHANNELS} from '../src/integrations/catalog';
import type {Account,Channel,Site,Task} from '../src/shared/types';

const at='2026-10-18T00:00:00.000Z';
const expiry='2026-10-18T02:00:00.000Z';
const siteId='11111111-1111-4111-8111-111111111111';
const taskId='22222222-2222-4222-8222-222222222222';
const accountId='33333333-3333-4333-8333-333333333333';
const channel:Channel={...CHANNELS[0],enabled:true};
const site:Site={id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Fixture site',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:at};
const wait:NonNullable<Task['emailWait']>={kind:'link',recipient:site.email,since:at,nextPollAt:'2026-10-18T00:01:00.000Z',expiresAt:expiry,consumedMessageIds:['already-used'],continuation:'browser'};
const delivery=JSON.stringify({kind:'link',value:'https://example.com/verify?token=fixture',recipient:site.email,expiresAt:expiry});

function task(partial:Partial<Task>={}):Task{
  return {id:taskId,siteId,channelId:channel.id,sourceDomain:channel.domain,status:'needs_input',checkpoint:'waiting_email',emailWait:structuredClone(wait),createdAt:at,updatedAt:at,scheduledAt:at,attempts:0,message:'Fixture',...partial};
}

function withWait(run:(store:Store)=>void):void{
  const store=new Store(':memory:');
  try{
    store.update(state=>{state.sites=[structuredClone(site)];state.tasks=[task()]});
    store.setCipher(emailValueKey(taskId),delivery);
    run(store);
  }finally{store.close()}
}

function roundtrip(store:Store):{task:Task;secrets:Record<string,string>}{
  const exported={state:store.read(),secrets:store.allCiphers()};
  const passphrase='batch6c-fixture-backup-passphrase';
  const valid=validateBackup(decryptBackup(encryptBackup(exported,passphrase),passphrase));
  const restored=new Store(':memory:');
  try{restored.restore(valid.state,valid.secrets);return {task:restored.read().tasks[0],secrets:restored.allCiphers()}}
  finally{restored.close()}
}

test('task:skip controller path retires the wait and encrypted delivery atomically',()=>withWait(store=>{
  const controller=new Controller(store,{ready:true,available:()=>true} as never,'fixture');
  try{
    controller.patch(taskId,{status:'skipped',reasonCode:'user_skipped',message:'Fixture skip'});
    const saved=store.read().tasks[0],restored=roundtrip(store);
    for(const value of [saved,restored.task]){
      assert.equal(value.status,'skipped');
      assert.equal(value.emailWait,undefined);
      assert.equal(value.emailWaitRegisteredAt,at);
    }
    assert.equal(store.getCipher(emailValueKey(taskId)),undefined);
    assert.equal(restored.secrets[emailValueKey(taskId)],undefined);
    assert.deepEqual(mailConsumptionIds(store.read(),channel.id,site.email),['already-used']);
  }finally{controller.stop()}
}));

test('direct Store planning writes retire stale waits across defer, handoff and terminal states',()=>{
  const cases:Array<{name:string;status:Task['status'];checkpoint:string;reasonCode:Task['reasonCode']}>= [
    {name:'AI defer',status:'queued',checkpoint:'waiting_email',reasonCode:'ai_daily_limit'},
    {name:'eligibility',status:'needs_input',checkpoint:'eligibility_wait',reasonCode:'channel_ineligible'},
    {name:'account handoff',status:'needs_input',checkpoint:'account_handoff',reasonCode:'account_handoff'},
    {name:'failure',status:'failed',checkpoint:'waiting_email',reasonCode:'temporary_failure'},
    {name:'completion',status:'live',checkpoint:'waiting_email',reasonCode:undefined},
  ];
  for(const scenario of cases)withWait(store=>{
    store.update(state=>Object.assign(state.tasks[0],{status:scenario.status,checkpoint:scenario.checkpoint,reasonCode:scenario.reasonCode}));
    const saved=store.read().tasks[0],restored=roundtrip(store);
    assert.equal(saved.emailWait,undefined,scenario.name);
    assert.equal(restored.task.emailWait,undefined,scenario.name);
    assert.equal(store.getCipher(emailValueKey(taskId)),undefined,scenario.name);
    assert.deepEqual(mailConsumptionIds(store.read(),channel.id,site.email),['already-used']);
  });
});

test('delivered registration keeps mail material only through queued/running resume',()=>withWait(store=>{
  store.update(state=>Object.assign(state.tasks[0],taskTransition(state.tasks[0],{status:'queued',checkpoint:'account_registration_submitted',reasonCode:undefined})));
  assert.ok(store.read().tasks[0].emailWait);
  assert.equal(roundtrip(store).secrets[emailValueKey(taskId)],delivery);
  store.update(state=>Object.assign(state.tasks[0],taskTransition(state.tasks[0],{status:'running'})));
  assert.ok(store.read().tasks[0].emailWait);
  // Page-load retries and AI deferrals keep the delivered link and its cipher.
  for(const reasonCode of ['temporary_failure','ai_daily_limit','diversity_deferred'] as const){
    store.update(state=>Object.assign(state.tasks[0],taskTransition(state.tasks[0],{status:'queued',reasonCode})));
    assert.ok(store.read().tasks[0].emailWait,reasonCode);
    assert.equal(store.getCipher(emailValueKey(taskId)),delivery,reasonCode);
  }
  store.update(state=>Object.assign(state.tasks[0],taskTransition(state.tasks[0],{status:'failed',reasonCode:'temporary_failure'})));
  assert.equal(store.read().tasks[0].emailWait,undefined);
  assert.equal(store.getCipher(emailValueKey(taskId)),undefined);
}));

test('strict backup restore repairs only lifecycle-orphaned mail waits',()=>withWait(store=>{
  const stale={state:store.read(),secrets:store.allCiphers()};
  stale.state.emailConsumptions=[];
  stale.state.tasks[0].emailWaitRegisteredAt=undefined;
  Object.assign(stale.state.tasks[0],{status:'skipped',reasonCode:'user_skipped'});
  const validated=validateBackup(stale);
  assert.equal(validated.state.tasks[0].emailWait,undefined);
  assert.equal(validated.state.tasks[0].emailWaitRegisteredAt,at);
  assert.equal(validated.secrets[emailValueKey(taskId)],undefined);
  assert.deepEqual(mailConsumptionIds(validated.state,channel.id,site.email),['already-used']);
  const restored=new Store(':memory:');
  try{restored.restore(validated.state,validated.secrets);assert.equal(restored.read().tasks[0].emailWait,undefined)}
  finally{restored.close()}

  const wrongRecipient={state:store.read(),secrets:store.allCiphers()};
  wrongRecipient.state.tasks[0].emailWait!.recipient='other@example.com';
  assert.throws(()=>validateBackup(wrongRecipient));
  const unknownField={state:store.read(),secrets:store.allCiphers()};
  Object.assign(unknownField.state.tasks[0].emailWait!,{unexpected:true});
  assert.throws(()=>validateBackup(unknownField));
}));

test('old system checkpoints lose only their stale human action during strict backup restore',()=>{
  const source=new Store(':memory:');
  try{
    const pending=task({checkpoint:'account_registration_human',reasonCode:'account_handoff',emailWait:undefined});
    const action=createHumanAction(pending,{kind:'account_login'},new Date(at));
    source.update(state=>{
      state.sites=[structuredClone(site)];
      state.tasks=[{...pending,humanAction:action,waitingSince:action.since,waitingDeadlineAt:action.deadline}];
    });
    for(const checkpoint of ['eligibility_wait','referral_guard']){
      const old={state:source.read(),secrets:source.allCiphers()};
      old.state.tasks[0].checkpoint=checkpoint;
      const validated=validateBackup(old);
      const restored=new Store(':memory:');
      try{
        restored.restore(validated.state,validated.secrets);
        const saved=restored.read().tasks[0];
        assert.equal(saved.status,checkpoint==='referral_guard'?'failed':'skipped');
        assert.equal(saved.reasonCode,checkpoint==='eligibility_wait'?'channel_ineligible':'referral_blocked');
        assert.equal(saved.humanAction,undefined);
        assert.equal(saved.waitingDeadlineAt,undefined);
      }finally{restored.close()}
    }
    const badPlatform={state:source.read(),secrets:source.allCiphers()};
    badPlatform.state.tasks[0].checkpoint='eligibility_wait';
    badPlatform.state.tasks[0].humanAction!.platform='another-channel';
    assert.throws(()=>validateBackup(badPlatform));
    const unrelated={state:source.read(),secrets:source.allCiphers()};
    unrelated.state.tasks[0].status='queued';
    assert.throws(()=>validateBackup(unrelated));
  }finally{source.close()}
});

test('registration human checkpoint retains remote registration and single-profile ownership',()=>{
  // Only an explicit mail checkpoint waits for email; other post-registration
  // stops (Telegraph, unexpected pages) remain human waits with a deadline.
  const submitted=task({status:'running',checkpoint:'account_registration_submitted',emailWait:undefined});
  const stopped=taskTransition(submitted,{status:'needs_input'});
  assert.equal(stopped.reasonCode,'human_required');
  assert.ok(stopped.humanAction?.deadline);
  const awaitingCode=task({status:'running',checkpoint:'email_code_pending',emailWait:undefined});
  assert.equal(taskTransition(awaitingCode,{status:'needs_input'}).reasonCode,'email_code_pending');
  const pending=task({status:'needs_input',checkpoint:'account_registration_human',reasonCode:'account_handoff',emailWait:undefined,submittedAt:at});
  assert.equal(isPendingPublisherRegistration(pending),true);
  assert.equal(hasUnresolvedExternalAttempt(pending),false);
  const codePending={...pending,checkpoint:'email_code_pending',reasonCode:'email_code_pending' as const};
  assert.equal(isPendingPublisherRegistration(codePending),true);
  assert.equal(hasUnresolvedExternalAttempt(codePending),false);

  const profile:Channel={...channel,id:'fixture-profile',kind:'profile',automation:'manual'};
  const secondSite:Site={...site,id:'44444444-4444-4444-8444-444444444444',domain:'second.example.com',url:'https://second.example.com/'};
  const account:Account={id:accountId,channelId:profile.id,email:site.email,username:'fixture',createdAt:at,status:'registered',hasPassword:false,source:'imported'};
  for(const checkpoint of ['account_registration_human','email_code_pending']){
    const state=emptyState();state.sites=[site,secondSite];state.accounts=[account];
    state.tasks=[{...pending,accountId,channelId:profile.id,sourceDomain:profile.domain,checkpoint,submittedAt:undefined}];
    assert.throws(()=>bindAccount(state,accountId,secondSite.id,profile),/资料页账号已绑定其他网站/);
  }
});


test('legacy signup deferrals at the attempt limit become visible handoffs without restoring a submit budget',()=>{
  for(const checkpoint of [undefined,'signup_deferred']){
    const legacy=emptyState();legacy.sites=[site];
    legacy.accounts=[{id:accountId,channelId:'fixture-browser',email:site.email,username:'fixture',createdAt:at,status:'draft',source:'generated',hasPassword:false,registrationAttempts:1}];
    const signup:NonNullable<Task['signup']>={version:1,scriptId:'fixture',scriptVersion:1,identityId:accountId,stepIndex:2,status:'running',runtimeId:'fixture',updatedAt:at,aiLocateCalls:0,aiLocatedStepIds:[],irreversible:{stepId:'submit',at,completed:true}};
    legacy.tasks=[task({channelId:'fixture-browser',sourceDomain:'platform.example.com',status:'queued',checkpoint,emailWait:undefined,accountId,attempts:legacy.settings.maxAttempts,signup})];
    const restored=new Store(':memory:');
    try{
      restored.restore(structuredClone(legacy),{});const saved=restored.read().tasks[0];
      assert.equal(saved.status,'needs_input');assert.equal(saved.checkpoint,'account_registration_human');assert.ok(saved.humanAction);
      assert.equal(saved.attempts,legacy.settings.maxAttempts);assert.deepEqual(saved.signup?.irreversible,signup.irreversible);
      assert.equal(restored.read().accounts[0].registrationAttempts,1);
      const published=structuredClone(legacy);Object.assign(published.tasks[0],{submittedAt:at,publicUrl:'https://example.com/fixture',checkpoint:'submitted'});
      restored.restore(published,{});assert.equal(restored.read().tasks[0].status,'queued');assert.equal(restored.read().tasks[0].signup?.status,'running');
    }finally{restored.close()}
  }
});
