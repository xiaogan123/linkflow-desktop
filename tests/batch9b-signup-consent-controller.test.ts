import test,{beforeEach,type TestContext} from 'node:test';
beforeEach(t=>(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-19T10:17:00.000Z')}));
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {createHumanAction} from '../src/shared/human-action';
import {SIGNUP_SCRIPTS,type SignupScript} from '../src/integrations/signup-executor';
import mock from '../src/integrations/signup-scripts/mock-local.json';
import type {SignupExecutionHooks,SignupTaskState} from '../src/shared/signup';
import type {Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

test('controller records one version-bound owner consent before the irreversible signup checkpoint',async()=>{
  const scripts=SIGNUP_SCRIPTS as Map<string,SignupScript>;
  scripts.set('mock-local',mock as SignupScript);
  const store=new Store(':memory:'),vault={get:async()=>undefined,available:()=>false} as unknown as Vault;
  const controller=new Controller(store,vault,'fixture');
  const at=new Date().toISOString(),siteId='11111111-1111-4111-8111-111111111111',accountId='22222222-2222-4222-8222-222222222222',taskId='33333333-3333-4333-8333-333333333333';
  const signup:SignupTaskState={version:1,scriptId:mock.id,scriptVersion:mock.version,identityId:accountId,stepIndex:3,status:'human',runtimeId:'runtime',updatedAt:at,aiLocateCalls:0,aiLocatedStepIds:[],humanReason:'consent_required'};
  const task:Task={id:taskId,siteId,channelId:'mock-local',accountId,sourceDomain:'example.com',status:'needs_input',checkpoint:'account_registration_human',reasonCode:'agreement_required',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'',signup,humanAction:createHumanAction({channelId:'mock-local',sourceDomain:'example.com',reasonCode:'agreement_required'}, {kind:'consent'})};
  try{
    store.update(state=>{state.settings.autoRun=true;state.sites.push({id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Example',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:at});state.accounts.push({id:accountId,channelId:'mock-local',username:'example_user',email:'owner@example.com',status:'draft',hasPassword:true,createdAt:at});state.tasks.push(task)});
    const hooks=(controller as unknown as {signupHooks:(task:Task,signal:AbortSignal)=>SignupExecutionHooks}).signupHooks(task,new AbortController().signal);
    assert.equal(hooks.hasSiteOwnerSignupConsent?.(),false);
    assert.equal(hooks.hasSuccessfulRegistrationRecord?.(),false);
    await assert.rejects(hooks.persist({...signup,status:'irreversible',irreversible:{stepId:'submit',at}}),/同意状态/);
    assert.equal(store.read().accounts[0].registrationAttempts,undefined);
    store.update(state=>{state.settings.autoRun=false});
    await controller.doneHumanAction(taskId);
    const consent=store.read().settings.signupConsents?.['mock-local'];
    assert.equal(consent?.scriptId,mock.id);assert.equal(consent?.scriptVersion,mock.version);
    assert.equal(store.read().tasks[0].status,'queued');
    assert.equal(hooks.hasSiteOwnerSignupConsent?.(),true);
    store.update(state=>{state.settings.autoRun=true;state.tasks[0].status='running'});
    await hooks.persist({...signup,status:'irreversible',irreversible:{stepId:'submit',at}});
    assert.equal(store.read().accounts[0].registrationAttempts,1);
    store.update(state=>{const previous=state.tasks[0].signup!;state.tasks[0].signup={...previous,status:'done',irreversible:{...previous.irreversible!,completed:true}};state.accounts[0].status='registered';state.settings.signupConsents=undefined});
    assert.equal(hooks.hasSiteOwnerSignupConsent?.(),false);
    assert.equal(hooks.hasSuccessfulRegistrationRecord?.(),true);
  }finally{controller.pause();store.close();scripts.delete('mock-local')}
});
