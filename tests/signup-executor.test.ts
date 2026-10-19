import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import type {BrowserWindow} from 'electron';
import mock from '../src/integrations/signup-scripts/mock-local.json';
import {isSignupScript,runSignupScript,signupCircuitUntil,SIGNUP_SCRIPTS,type SignupScript,type SignupStep,type SignupBrowserPort,type SignupExecutionInput} from '../src/integrations/signup-executor';
import {canCheckHumanRegistration,isAllowedBrowserRequest,signupBrowserPort,humanActionBrowserComplete,verifyPendingAccount,verifyScriptlessHumanRegistration,resumeSignupHumanAction,signupBrowserResult,needsDeterministicSignup,runBrowserTask} from '../src/integrations/browser';
import {TaskReasonError} from '../src/shared/task-reasons';
import type {SignupTaskState} from '../src/shared/signup';
import type {ExecutionContext} from '../src/shared/types';

const fixedNow=new Date('2026-10-18T00:00:00.000Z');
function script(steps?:SignupStep[]):SignupScript {const value=structuredClone(mock) as SignupScript;if(steps)value.steps=steps;return value;}
function fixture(){
  let current='about:blank',closed=false,success=false,captcha=false,phone=false,manualReview=false,time=fixedNow.getTime(),emailReady=true,dispatches=0,shown=0;
  const durable:SignupTaskState[]=[],vault=new Map<string,string>(),values=new Map<string,string>(),actions:Array<{action:string;selector:string}>=[],missing=new Set<string>(),pauses:number[]=[];
  const port:SignupBrowserPort={runtimeId:'runtime-one',isClosed:()=>closed,url:()=>current,canOpen:url=>new URL(url).hostname==='example.com',open:async url=>{current=url;},inspect:async()=>({captcha,phone,manualReview,controls:[{tag:'input',type:'text',id:'email',name:'email',label:values.get('#email')??'Email'}]}),matches:async condition=>(!condition.css||!missing.has(condition.css)&&(condition.css!=='#success'||success))&&(!condition.text||condition.text==='Ready')&&(!condition.url||current===condition.url),probeIrreversible:async selector=>missing.has(selector)?'missing':'ready',act:async(action,selector,value)=>{actions.push({action,selector});if(missing.has(selector))return false;if(action==='extract')return 'mock-api-key-private';if(action==='fill')values.set(selector,value!);if(action==='irreversible'){dispatches++;if(selector==='#verify')success=true;}return true;},pause:async ms=>{pauses.push(ms);time+=ms;},show:()=>{shown++;},close:()=>{closed=true;}};
  const input:SignupExecutionInput={taskId:'task-one',identity:{id:'identity-one',username:'example_user',email:'owner@example.com',password:async()=> 'mock-password-private'},financialContent:false,browser:port,hooks:{persist:async state=>{durable.push(structuredClone(state));},awaitEmail:async()=>emailReady?'123456':undefined,hasSiteOwnerSignupConsent:()=>true},secrets:{set:async(key,value)=>{vault.set(key,value);}},signal:new AbortController().signal,now:()=>new Date(time)};
  return {input,port,durable,vault,values,actions,missing,pauses,get dispatches(){return dispatches;},get closed(){return closed;},get shown(){return shown;},set captcha(value:boolean){captcha=value;},set phone(value:boolean){phone=value;},set manualReview(value:boolean){manualReview=value;},set emailReady(value:boolean){emailReady=value;},set success(value:boolean){success=value;},set closed(value:boolean){closed=value;}};
}
function registrationHandoff(state:SignupTaskState):ExecutionContext['task']{
  return {id:'task-one',status:'needs_input',checkpoint:'account_registration_human',humanAction:{kind:'captcha'},signup:state} as ExecutionContext['task'];
}

test('local mock script is validated and no public platform script is opted in',()=>{
  assert(isSignupScript(mock));assert.equal(SIGNUP_SCRIPTS.size,0);
  assert(!isSignupScript({...mock,steps:[{id:'unknown',action:'eval'},{id:'done',action:'done'}]}));
  assert(!isSignupScript({...mock,steps:[{id:'same',action:'done'},{id:'same',action:'done'}]}));
  assert(!isSignupScript(script([{id:'wait',action:'wait',condition:{css:'#email'},timeoutMs:60001},{id:'done',action:'done'}])));
  assert(!isSignupScript({...mock,success:{css:''}}));
});
test('first irreversible registration waits for owner consent; a durable success record also authorizes later registration',async()=>{
  const first=fixture();let consent=false;
  first.input.hooks.hasSiteOwnerSignupConsent=()=>consent;
  const held=await runSignupScript(script(),first.input);
  assert.equal(held.status,'human');assert.equal(held.state.humanReason,'consent_required');assert.equal(first.dispatches,0);
  assert.equal(first.durable.some(state=>!!state.irreversible),false);
  consent=true;first.port.runtimeId='new-window';
  const resumed=await runSignupScript(script(),{...first.input,state:held.state});
  assert.equal(resumed.status,'done');assert.equal(first.dispatches,2);
  const later=fixture();later.input.hooks.hasSiteOwnerSignupConsent=()=>false;later.input.hooks.hasSuccessfulRegistrationRecord=()=>true;
  assert.equal((await runSignupScript(script(),later.input)).status,'done');assert.equal(later.dispatches,2);
});
test('resumed email waits finish from full page evidence without consuming mail or clicking again',async()=>{
  for(const changedRuntime of [false,true])for(const mailAction of ['await_email_code','await_email_link'] as const){
    const f=fixture(),s=script();s.steps[4]={id:'mail',action:mailAction};f.emailReady=false;
    const pending=await runSignupScript(s,f.input);assert.equal(pending.status,'waiting_email');assert.equal(f.dispatches,1);
    f.success=true;if(changedRuntime)f.port.runtimeId='replacement-window';
    let mailReads=0,locates=0,opens=0;f.input.hooks.awaitEmail=async()=>{mailReads++;return '123456';};f.input.hooks.locate=async()=>{locates++;return '#unexpected';};f.port.open=async()=>{opens++;};
    const before=f.actions.length,result=await runSignupScript(s,{...f.input,state:pending.state});
    assert.equal(result.status,'done');assert.equal(f.dispatches,1);assert.equal(mailReads,0);assert.equal(locates,0);assert.equal(opens,0);
    assert.deepEqual(f.actions.slice(before),[{action:'extract',selector:'#key'}]);
    assert.equal(f.vault.get('signup:task-one:api_key'),'mock-api-key-private');assert.equal(f.closed,true);
  }
});
test('a completed page missing its declared key stays human without replaying verification',async()=>{
  const f=fixture(),s=script();f.emailReady=false;
  const pending=await runSignupScript(s,f.input);f.success=true;f.missing.add('#key');
  const before=f.actions.length,result=await runSignupScript(s,{...f.input,state:pending.state});
  assert.equal(result.status,'human');assert.equal(result.state.humanReason,'human_step');assert.equal(f.dispatches,1);
  assert.deepEqual(f.actions.slice(before),[{action:'extract',selector:'#key'}]);assert.equal(f.vault.size,0);assert.equal(f.closed,false);
});
test('fill -> asynchronous email code -> extract goes to vault and closes on declared success without AI',async()=>{
  const f=fixture();let aiCalls=0;f.input.hooks.locate=async()=>{aiCalls++;return undefined;};f.emailReady=false;
  const first=await runSignupScript(script(),f.input);
  assert.equal(first.status,'waiting_email');assert.equal(first.state.stepIndex,4);assert.equal(f.dispatches,1);assert.equal(f.closed,false);
  assert.equal(f.values.get('#email'),'owner@example.com');
  const intent=f.durable.find(state=>state.status==='irreversible');assert.equal(intent?.irreversible?.stepId,'submit');assert.equal(intent?.irreversible?.completed,undefined);
  f.emailReady=true;const result=await runSignupScript(script(),{...f.input,state:first.state});
  assert.equal(result.status,'done');assert.equal(f.dispatches,2);assert.equal(f.values.get('#code'),'123456');assert.equal(f.vault.get('signup:task-one:api_key'),'mock-api-key-private');assert.equal(f.closed,true);assert.equal(aiCalls,0);
  const persisted=JSON.stringify(f.durable);for(const secret of ['123456','mock-api-key-private','mock-password-private','owner@example.com'])assert(!persisted.includes(secret),secret);
});
test('restart or missing browser never resubmits an irreversible registration',async()=>{
  const f=fixture();f.emailReady=false;const first=await runSignupScript(script(),f.input);assert.equal(f.dispatches,1);
  f.port.runtimeId='new-runtime';const restarted=await runSignupScript(script(),{...f.input,state:first.state});assert.equal(restarted.state.humanReason,'window_lost');assert.equal(f.dispatches,1);
  const pending={...first.state,status:'irreversible' as const,irreversible:{stepId:'submit',at:fixedNow.toISOString()}};
  f.port.runtimeId='runtime-one';const unknown=await runSignupScript(script(),{...f.input,state:pending});assert.equal(unknown.state.humanReason,'irreversible_unknown');assert.equal(f.dispatches,1);
  f.closed=true;const lost=await runSignupScript(script(),{...f.input,state:first.state});assert.equal(lost.state.humanReason,'window_lost');assert.equal(f.dispatches,1);
});
for(const kind of ['captcha','phone','manualReview'] as const)test(`visible ${kind} hands off before fields, submit, or AI`,async()=>{
  const f=fixture();f[kind]=true;let calls=0;f.input.hooks.locate=async()=>{calls++;return undefined;};
  const result=await runSignupScript(script(),f.input);
  assert.equal(result.status,'human');assert.equal(result.state.humanReason,kind==='manualReview'?'manual_review':kind);assert.equal(f.actions.length,0);assert.equal(f.dispatches,0);assert.equal(calls,0);
});
test('missing or unverified policy fields and existing identity fail closed',async()=>{
  for(const patch of [{verified:false},{allowAutoRegistration:false},{allowMultipleAccounts:undefined},{sourceUrl:''},{checkedAt:''}]){
    const f=fixture(),s=script();Object.assign(s.policy,patch);const result=await runSignupScript(s,f.input);assert.equal(result.state.humanReason,'policy_unverified');assert.equal(f.actions.length,0);
  }
  const f=fixture();f.input.financialContent=true;assert.equal((await runSignupScript(script(),f.input)).state.humanReason,'policy_unverified');
  const existing=fixture();existing.input.identity.existingAccount=true;assert.equal((await runSignupScript(script(),existing.input)).state.humanReason,'existing_identity');assert.equal(existing.dispatches,0);
});
test('a durable intent must complete before dispatch and failed persistence cannot submit',async()=>{
  const f=fixture();let blocked=false;
  f.input.hooks.persist=async state=>{if(state.status==='irreversible'){blocked=true;assert.equal(f.dispatches,0);throw Error('disk unavailable');}f.durable.push(structuredClone(state));};
  await assert.rejects(runSignupScript(script(),f.input),/disk unavailable/);assert.equal(blocked,true);assert.equal(f.dispatches,0);
});
test('lost page result after click retains intent and cannot retry on restart',async()=>{
  const f=fixture(),act=f.port.act;f.port.act=async(...args)=>{const result=await act(...args);if(args[0]==='irreversible')throw Error('lost renderer');return result;};
  const first=await runSignupScript(script(),f.input);assert.equal(f.dispatches,1);assert.equal(first.state.irreversible?.completed,undefined);
  const second=await runSignupScript(script(),{...f.input,state:first.state});assert.equal(second.state.humanReason,'irreversible_unknown');assert.equal(f.dispatches,1);
});
test('selector fallback is one locate per missing step and two per task, stored separately',async()=>{
  const f=fixture();let calls=0;for(const name of ['#one','#two','#three'])f.missing.add(name);
  f.input.hooks.locate=async()=>{calls++;return '#resolved';};
  const s=script([{id:'open',action:'open',url:'https://example.com/signup'},...['one','two','three'].map(id=>({id,action:'fill' as const,selector:'#'+id,ref:'identity.email' as const})),{id:'done',action:'done'}]);
  const result=await runSignupScript(s,f.input);assert.equal(calls,2);assert.equal(result.state.aiLocateCalls,2);assert.deepEqual(result.state.aiLocatedStepIds,['one','two']);assert.equal(result.state.humanReason,'selector_drift');
  const bad=fixture();bad.missing.add('#code');let one=0;bad.input.hooks.locate=async()=>{one++;return '#code';};
  const failed=await runSignupScript(script(),bad.input);await runSignupScript(script(),{...bad.input,state:failed.state});assert.equal(one,1);
});
test('irreversible selector drift is located before the durable intent and only dispatched once',async()=>{
  const f=fixture();f.missing.add('#register');f.emailReady=false;
  f.input.hooks.locate=async request=>{assert.equal(request.stepId,'submit');assert.equal(f.durable.some(state=>state.status==='irreversible'),false);return '#new-register';};
  const result=await runSignupScript(script(),f.input);assert.equal(result.status,'waiting_email');assert.equal(f.dispatches,1);assert(f.actions.some(action=>action.action==='irreversible'&&action.selector==='#new-register'));
});
test('ambiguous submit never records an irreversible intent',async()=>{
  const f=fixture();f.port.probeIrreversible=async()=> 'missing';
  const result=await runSignupScript(script(),f.input);
  assert.equal(result.state.humanReason,'selector_drift');assert.equal(result.state.failure,'selector_missing');
  assert.equal(f.dispatches,0);assert.equal(f.durable.some(state=>state.status==='irreversible'),false);
  assert.deepEqual(f.pauses,[1250,1250,1250]);
});
test('a disabled submit and an invisible CAPTCHA do not count as selector failures',async()=>{
  for(const [probe,reason] of [['disabled','selector_drift'],['captcha','captcha']] as const){
    const f=fixture();f.port.probeIrreversible=async()=>probe;
    const result=await runSignupScript(script(),f.input);
    assert.equal(result.state.humanReason,reason);assert.equal(result.state.failure,undefined);
    assert.equal(result.state.irreversible,undefined);assert.equal(f.dispatches,0);
    assert.equal(signupCircuitUntil(script().id,[result.state,result.state,result.state],fixedNow),undefined);
  }
});
test('a failed guarded dispatch keeps its durable intent and only allows read-only recovery',async()=>{
  const f=fixture(),s=script();const act=f.port.act;
  f.port.act=async(...args)=>args[0]==='irreversible'?false:act(...args);
  const first=await runSignupScript(s,f.input);
  assert.equal(first.status,'human');assert.equal(first.state.humanReason,'irreversible_unknown');
  assert.equal(first.state.failure,undefined);assert.equal(first.state.irreversible?.completed,undefined);assert.equal(f.dispatches,0);
  assert.equal((await runSignupScript(s,{...f.input,state:first.state})).state.humanReason,'irreversible_unknown');
  assert.equal(f.dispatches,0);
  let account={status:'draft'};
  const context={task:registrationHandoff(first.state),signupHooks:f.input.hooks,secrets:f.input.secrets,getAccount:()=>account,saveAccount:async(value:typeof account)=>{account=value;}} as unknown as ExecutionContext;
  f.success=true;assert.equal(await resumeSignupHumanAction(context,s,f.port),'done');
  assert.equal(account.status,'registered');assert.equal(f.dispatches,0);
});
test('submit preflight waits for a disabled button and then records one intent',async()=>{
  const f=fixture();let probes=0;f.port.probeIrreversible=async()=>++probes>=2?'ready':'disabled';f.emailReady=false;
  const result=await runSignupScript(script(),f.input);
  assert.equal(result.status,'waiting_email');assert.equal(f.dispatches,1);
  assert.equal(f.durable.filter(state=>state.status==='irreversible').length,1);
  assert.deepEqual(f.pauses,[1250]);
});
test('email link must satisfy both script and browser host guards before intent',async()=>{
  const s=script([{id:'open',action:'open',url:'https://example.com/signup'},{id:'mail',action:'await_email_link'},{id:'done',action:'done'}]);
  const f=fixture();f.port.canOpen=url=>!url.includes('/verify');f.input.hooks.awaitEmail=async()=> 'https://example.com/verify?token=private';
  const result=await runSignupScript(s,f.input);
  assert.equal(result.state.humanReason,'execution_failed');assert.equal(result.state.irreversible,undefined);
  assert.equal(f.port.url(),'https://example.com/signup');
});
test('AI limit propagates and failed locator call does not consume the local selector budget',async()=>{
  const f=fixture();f.missing.add('#email');f.input.hooks.locate=async()=>{throw new TaskReasonError('ai_daily_limit','quota');};
  const s=script([{id:'open',action:'open',url:'https://example.com/signup'},{id:'email',action:'fill',selector:'#email',ref:'identity.email'},{id:'done',action:'done'}]);
  await assert.rejects(runSignupScript(s,f.input),(error:unknown)=>error instanceof TaskReasonError&&error.reasonCode==='ai_daily_limit');
  assert(f.durable.every(state=>state.aiLocateCalls===0));assert.equal(f.dispatches,0);
});
test('post-submit selector drift and AI limits preserve the registration handoff',async()=>{
  for(const aiLimit of [false,true]){
    const f=fixture(),s=script();f.emailReady=false;
    const pending=await runSignupScript(s,f.input);assert.equal(pending.status,'waiting_email');assert.equal(f.dispatches,1);
    f.emailReady=true;f.missing.add('#code');
    if(aiLimit)f.input.hooks.locate=async()=>{throw new TaskReasonError('ai_task_limit','quota');};
    const result=await runSignupScript(s,{...f.input,state:pending.state});
    assert.equal(result.status,'human');assert.equal(result.state.failure,undefined);
    assert.equal(result.state.irreversible?.completed,true);assert.equal(f.dispatches,1);
    assert.equal(result.state.humanReason,aiLimit?'execution_failed':'selector_drift');
    assert.equal(signupCircuitUntil(s.id,[result.state,result.state,result.state],fixedNow),undefined);
  }
});
test('transient page load defers without a platform failure or submit intent',async()=>{
  const f=fixture();f.port.open=async()=>{throw Error('offline');};
  const result=await runSignupScript(script(),f.input);
  assert.equal(result.status,'deferred');assert.equal(result.scheduledAt,'2026-10-18T00:15:00.000Z');
  assert.equal(result.state.failure,undefined);assert.equal(result.state.irreversible,undefined);
  const mapped=signupBrowserResult(result,{task:{} as ExecutionContext['task']});assert.equal(mapped.status,'queued');assert.equal(mapped.checkpoint,'signup_deferred');
});
test('fallback receives no field values or verification secrets',async()=>{
  const f=fixture();f.missing.add('#verify');let requestCopy='';f.input.hooks.locate=async request=>{requestCopy=JSON.stringify(request);return '#new-verify';};
  const result=await runSignupScript(script(),f.input);assert.equal(result.status,'human'); // changed button does not prove declared success
  assert(!requestCopy.includes('owner@example.com'));assert(!requestCopy.includes('123456'));assert(!requestCopy.includes('mock-password-private'));
});
test('wait polls at 1.25 seconds; done, URL assertions and explicit human steps need declared evidence',async()=>{
  const f=fixture();f.missing.add('#missing');const result=await runSignupScript(script([{id:'open',action:'open',url:'https://example.com/signup'},{id:'wait',action:'wait',condition:{css:'#missing'},timeoutMs:2000},{id:'done',action:'done'}]),f.input);
  assert.equal(result.state.humanReason,'selector_drift');assert.deepEqual(f.pauses,[1250,1250]);
  for(const step of [{id:'assert',action:'assert_url',url:'https://example.com/elsewhere'},{id:'human',action:'human'}] as SignupStep[]){
    const next=fixture();const r=await runSignupScript(script([{id:'open',action:'open',url:'https://example.com/signup'},step,{id:'done',action:'done'}]),next.input);assert.equal(r.status,'human');assert.equal(next.closed,false);
  }
});
test('email links reject off-platform actions before navigation and record one-time link intent',async()=>{
  const s=script([{id:'open',action:'open',url:'https://example.com/signup'},{id:'mail',action:'await_email_link'},{id:'done',action:'done'}]);
  const f=fixture();f.input.hooks.awaitEmail=async()=> 'https://outside.example/verify?token=private';assert.equal((await runSignupScript(s,f.input)).status,'human');assert.equal(f.port.url(),'https://example.com/signup');
  const valid=fixture();valid.success=true;valid.input.hooks.awaitEmail=async()=> 'https://example.com/verify?token=private';const r=await runSignupScript(s,valid.input);assert.equal(r.status,'done');assert.equal(r.state.irreversible?.stepId,'mail');assert(!JSON.stringify(valid.durable).includes('token=private'));
});
test('three consecutive platform failures open one seven-day circuit, ordinary handoff/success breaks it',()=>{
  const base={version:1,scriptId:'mock-local-signup',scriptVersion:1,identityId:'identity',stepIndex:0,status:'human',runtimeId:'runtime',aiLocateCalls:0,aiLocatedStepIds:[],failure:'selector_missing'} as const;
  const records=[0,1,2].map(offset=>({...base,aiLocatedStepIds:[],updatedAt:new Date(fixedNow.getTime()-offset*1000).toISOString()})) as SignupTaskState[];
  assert.equal(signupCircuitUntil(base.scriptId,records,fixedNow),'2026-10-25T00:00:00.000Z');
  const circuitCard={...records[0],humanReason:'circuit_open' as const,failure:undefined,updatedAt:new Date(fixedNow.getTime()+1000).toISOString()};
  assert.equal(signupCircuitUntil(base.scriptId,[...records,circuitCard],fixedNow),'2026-10-25T00:00:00.000Z');
  assert.equal(signupCircuitUntil(base.scriptId,[...records,{...circuitCard,status:'running'}],fixedNow),'2026-10-25T00:00:00.000Z');
  assert.equal(signupCircuitUntil(base.scriptId,[...records,{...records[0],status:'done',failure:undefined}],new Date(fixedNow.getTime()+1)),undefined);
  assert.equal(signupCircuitUntil(base.scriptId,records,new Date('2026-10-26T00:00:00.000Z')),undefined);
  assert.equal(signupCircuitUntil(base.scriptId,[records[0],{...records[1],failure:'execution_failed'},records[2]],fixedNow),undefined);
  const submitted={...records[0],irreversible:{stepId:'submit',at:fixedNow.toISOString(),completed:true as const},updatedAt:new Date(fixedNow.getTime()+1000).toISOString()};
  assert.equal(signupCircuitUntil(base.scriptId,[...records,submitted],fixedNow),undefined);
  const f=fixture();f.input.hooks.listPlatformStates=()=>records;return runSignupScript(script(),f.input).then(result=>{assert.equal(result.status,'deferred');assert.equal(result.scheduledAt,'2026-10-25T00:00:00.000Z');assert.equal(result.state.humanReason,undefined);assert.equal(f.dispatches,0);});
});

test('captcha allowlist applies only to exact declared frames and POST; top-level remains platform-only',()=>{
  const request=(url:string,resourceType='subFrame',method='GET',captcha=['captcha.example.net'])=>isAllowedBrowserRequest({url,resourceType,method},['example.com'],captcha);
  assert(request('https://captcha.example.net/widget'));assert(request('https://captcha.example.net/check','xhr','POST'));
  assert(!request('https://captcha.example.net/widget','mainFrame'));assert(!request('https://sub.captcha.example.net/widget'));assert(!request('http://captcha.example.net/widget'));assert(!request('https://user:pass@captcha.example.net/widget'));assert(!request('https://captcha.example.net:8443/widget'));
  assert(!request('https://captcha.example.net/widget','subFrame','GET',[]));assert(!request('https://other.example/check','xhr','POST'));assert(request('https://other.example/style.css','stylesheet','GET'));
  assert(request('https://app.example.com/register','mainFrame','POST'));
  assert(request('https://captcha.example.net/widget','object'));
  assert(!request('https://other.example/document','object'));
  assert(request('wss://example.com/live','webSocket'));
  assert(request('wss://captcha.example.net/live','webSocket'));
  assert(!request('wss://other.example/live','webSocket'));
  assert(!request('ws://example.com/live','webSocket'));
});
test('human completion without a locally declared script cannot claim success',async()=>{
  assert.equal(await humanActionBrowserComplete({channel:{id:'unregistered-platform'},task:{id:'task-one'}} as never),false);
});
test('scriptless mail handoff only marks a retained, allowlisted verified account page',async()=>{
  let url='https://example.com/account',text='Verification successful',saved:unknown,observed=0;
  const window={isDestroyed:()=>false,webContents:{getURL:()=>url,executeJavaScriptInIsolatedWorld:async()=>{observed++;return {text,controls:[]};}},loadURL:()=>{throw Error('unexpected navigation');}} as unknown as BrowserWindow;
  const context={channel:{allowedHosts:['example.com']},task:{id:'task-one',status:'needs_input',checkpoint:'account_registration_human',humanAction:{kind:'account_login'}},getAccount:()=>({id:'account-one',status:'draft',registeredAt:undefined,verifiedAt:undefined}),saveAccount:async(value:unknown)=>{saved=value;}} as unknown as ExecutionContext;
  assert.equal(await verifyScriptlessHumanRegistration(context,window),true);
  assert.equal((saved as {status:string}).status,'registered');assert.equal(typeof (saved as {verifiedAt:string}).verifiedAt,'string');
  saved=undefined;text='Please check your email';assert.equal(await verifyScriptlessHumanRegistration(context,window),false);assert.equal(saved,undefined);
  context.task.checkpoint='article_review';assert.equal(await verifyScriptlessHumanRegistration(context,window),false);assert.equal(observed,2);
  context.task.checkpoint='email_verification_human';url='https://outside.example/account';assert.equal(await verifyScriptlessHumanRegistration(context,window),false);assert.equal(observed,2);
});
test('scriptless planner and mailbox registration stops share the read-only completion whitelist',async()=>{
  let reads=0,saves=0;
  const window={isDestroyed:()=>false,webContents:{getURL:()=> 'https://example.com/account',executeJavaScriptInIsolatedWorld:async()=>{reads++;return {text:'Verification successful',controls:[]};}}} as unknown as BrowserWindow;
  const task={id:'task-one',status:'needs_input',checkpoint:'account_registration_submitted',humanAction:{kind:'account_login'}};
  const context={channel:{allowedHosts:['example.com']},task,getAccount:()=>({id:'account-one',status:'draft'}),saveAccount:async()=>{saves++;}} as unknown as ExecutionContext;
  for(const checkpoint of ['account_registration_submitted','account_handoff']){
    task.checkpoint=checkpoint;assert.equal(canCheckHumanRegistration(context.task,undefined,context.getAccount()),true);
    assert.equal(await verifyScriptlessHumanRegistration(context,window),true);
  }
  assert.equal(reads,2);assert.equal(saves,2);
  task.checkpoint='article_review';assert.equal(await verifyScriptlessHumanRegistration(context,window),false);assert.equal(reads,2);
});
test('a busy mailbox leaves a scriptless registration in the explicit mail queue',async()=>{
  const window={webContents:{executeJavaScriptInIsolatedWorld:async()=>({text:'Check your email',controls:[]})},loadURL:()=>{throw Error('unexpected navigation');}} as unknown as BrowserWindow;
  const context={task:{id:'task-one',checkpoint:'account_registration_submitted'},channel:{id:'example-platform',emailRequired:true,allowedHosts:['example.com']},getAccount:()=>({id:'account-one',status:'draft',email:'owner@example.com'}),saveAccount:async()=>{},signupHooks:{awaitEmail:async()=>undefined,emailWaitRegistered:()=>false,emailWaitQueued:()=>true},signal:new AbortController().signal} as unknown as ExecutionContext;
  const result=await verifyPendingAccount(context,window);
  assert.equal(typeof result,'object');assert.equal((result as {checkpoint:string}).checkpoint,'email_code_pending');assert.equal((result as {reasonCode:string}).reasonCode,'email_code_pending');
});

/** Minimal native DOM surface checks adapter behavior rather than script text. */
test('browser adapter only repeats navigation clicks; submit controls require an irreversible action',async()=>{
  class Form {get action(){return 'https://example.com/signup';}}
  class Element {disabled=false;id='register';type='submit';innerText='Register';textContent='';labels=[];form=new Form();clicks=0;getBoundingClientRect(){return {width:20,height:20};}getAttribute(name:string){return name==='type'?this.type:null;}hasAttribute(){return false;}closest(){return null;}click(){this.clicks++;}}
  class Button extends Element {}class Input extends Element {}class Area extends Element {}class Anchor extends Element {href='https://example.com/dashboard';}
  const button=new Button(),link=new Anchor();link.form=undefined as never;
  const context={document:{querySelectorAll:(selector:string)=>selector==='#register'?[button]:selector==='#link'?[link]:[]},location:{href:'https://example.com/signup'},getComputedStyle:()=>({display:'block',visibility:'visible'}),HTMLButtonElement:Button,HTMLInputElement:Input,HTMLTextAreaElement:Area,HTMLAnchorElement:Anchor,HTMLFormElement:Form,URL,Event};
  const events=new EventEmitter();const window=Object.assign(events,{isDestroyed:()=>false,webContents:{getURL:()=>context.location.href,executeJavaScriptInIsolatedWorld:async(_id:number,scripts:Array<{code:string}>)=>vm.runInNewContext(scripts[0].code,context)},show(){},close(){}}) as unknown as BrowserWindow;
  const port=signupBrowserPort(window,['example.com']);assert.equal(await port.act('click','#register'),false);assert.equal(button.clicks,0);assert.equal(await port.act('irreversible','#register'),true);assert.equal(button.clicks,1);assert.equal(await port.act('click','#link'),true);assert.equal(link.clicks,1);
});

test('a deferred or completed signup marks its window closed before Electron finishes closing',()=>{
  let destroys=0,closes=0,shows=0;
  const window={isDestroyed:()=>false,webContents:{getURL:()=> 'https://example.com/signup'},destroy:()=>{destroys++;},close:()=>{closes++;},show:()=>{shows++;}} as unknown as BrowserWindow;
  const port=signupBrowserPort(window,['example.com']);
  assert.equal(port.isClosed(),false);
  port.close();assert.equal(port.isClosed(),true);assert.equal(destroys,1);assert.equal(closes,0);
  port.show();port.close();assert.equal(shows,0);assert.equal(destroys,1);
});


test('a human CAPTCHA handoff does not replay a registration while the form still remains',async()=>{
  const f=fixture(),s=script();f.captcha=true;let opens=0;const open=f.port.open;f.port.open=async url=>{opens++;await open(url);};
  const first=await runSignupScript(s,f.input);assert.equal(first.state.humanReason,'captcha');assert.deepEqual(first.state.successCondition,s.success);
  const humanContext={task:registrationHandoff(first.state),signupHooks:f.input.hooks,secrets:f.input.secrets} as unknown as ExecutionContext;
  assert.equal(await resumeSignupHumanAction(humanContext,s,f.port),false);
  f.captcha=false;assert.equal(await resumeSignupHumanAction(humanContext,s,f.port),false);
  const paused=await runSignupScript(s,{...f.input,state:first.state});assert.equal(paused.status,'human');assert.equal(f.dispatches,0);assert.equal(opens,1);
  f.success=true;assert.equal(await resumeSignupHumanAction(humanContext,s,f.port),'done');
  assert.equal(f.dispatches,0);assert.equal(f.closed,true);assert.equal(f.vault.get('signup:task-one:api_key'),'mock-api-key-private');
});
test('a replaced human window cannot reset the script to its opening step',async()=>{
  const first=fixture();first.captcha=true;const stopped=await runSignupScript(script(),first.input);
  const next=fixture();next.port.runtimeId='new-window';
  const result=await runSignupScript(script(),{...next.input,state:stopped.state});
  assert.equal(result.state.humanReason,'window_lost');assert.equal(result.state.stepIndex,stopped.state.stepIndex);
  assert.equal(result.state.runtimeId,stopped.state.runtimeId);assert.equal(next.actions.length,0);assert.equal(next.dispatches,0);
});
test('completed signup and publication handoffs cannot use registration completion',async()=>{
  const f=fixture(),s=script();await f.port.open('https://example.com/signup');f.success=true;
  const base:SignupTaskState={version:1,scriptId:s.id,scriptVersion:s.version,identityId:'identity-one',stepIndex:3,status:'human',runtimeId:f.port.runtimeId,updatedAt:fixedNow.toISOString(),aiLocateCalls:0,aiLocatedStepIds:[],humanReason:'human_step'};
  for(const [status,checkpoint] of [['done','account_registration_human'],['human','article_review']] as const){
    const context={task:{...registrationHandoff(base),checkpoint,signup:{...base,status}},signupHooks:f.input.hooks,secrets:f.input.secrets} as unknown as ExecutionContext;
    assert.equal(await resumeSignupHumanAction(context,s,f.port),false);
  }
  assert.equal(f.durable.length,0);assert.equal(f.closed,false);
});
test('an explicit human step cannot advance on an intermediate condition alone',async()=>{
  const f=fixture(),s=script([{id:'open',action:'open',url:'https://example.com/signup'},{id:'captcha',action:'human',reason:'captcha'},{id:'mail',action:'await_email_code'},{id:'code',action:'fill',selector:'#code',ref:'email.code'},{id:'verify',action:'irreversible',selector:'#verify'},{id:'key',action:'extract',selector:'#key',target:'api_key'},{id:'done',action:'done'}]);
  const first=await runSignupScript(s,f.input);assert.equal(first.state.stepIndex,1);
  const context={task:registrationHandoff(first.state),signupHooks:f.input.hooks,secrets:f.input.secrets} as unknown as ExecutionContext;
  assert.equal(await resumeSignupHumanAction(context,s,f.port),false);assert.equal(f.durable.at(-1)?.stepIndex,1);assert.equal(f.dispatches,0);
  f.success=true;assert.equal(await resumeSignupHumanAction(context,s,f.port),'done');assert.equal(f.dispatches,0);
});
test('read-only completion accepts registration stop variants and replacement windows only on full success',async()=>{
  for(const status of ['human','waiting_email'] as const)for(const checkpoint of ['account_registration_human','email_verification_human','account_registration_submitted','account_handoff']){
    const f=fixture(),s=script();await f.port.open('https://example.com/account');
    const state:SignupTaskState={version:1,scriptId:s.id,scriptVersion:s.version,identityId:'identity-one',stepIndex:4,status,runtimeId:'closed-old-window',updatedAt:fixedNow.toISOString(),aiLocateCalls:0,aiLocatedStepIds:[],irreversible:{stepId:'submit',at:fixedNow.toISOString(),completed:true}};
    const task={...registrationHandoff(state),checkpoint};
    const context={task,signupHooks:f.input.hooks,secrets:f.input.secrets,getAccount:()=>({id:'identity-one',status:'draft'}),saveAccount:async()=>{}} as unknown as ExecutionContext;
    assert.equal(canCheckHumanRegistration(task,s,context.getAccount()),true);
    assert.equal(await resumeSignupHumanAction(context,s,f.port),false);assert.equal(f.durable.length,0);assert.equal(f.actions.length,0);
    f.success=true;assert.equal(await resumeSignupHumanAction(context,s,f.port),'done');
    assert.deepEqual(f.actions,[{action:'extract',selector:'#key'}]);assert.equal(f.dispatches,0);assert.equal(f.durable.at(-1)?.status,'done');
  }
  const f=fixture(),s=script();f.captcha=true;const stopped=await runSignupScript(s,f.input);
  const task=registrationHandoff(stopped.state);
  assert.equal(canCheckHumanRegistration({...task,status:'queued'},s),false);
  assert.equal(canCheckHumanRegistration({...task,humanAction:undefined},s),false);
  assert.equal(canCheckHumanRegistration({...task,checkpoint:'article_review'},s),false);
  assert.equal(canCheckHumanRegistration({...task,signup:{...stopped.state,status:'done'}},s),false);
  assert.equal(canCheckHumanRegistration(task,{...s,version:s.version+1}),false);
});
test('intermediate success never clears an uncertain submit and full success still captures credentials',async()=>{
  const f=fixture(),s=script();await f.port.open('https://example.com/signup');
  const state:SignupTaskState={version:1,scriptId:s.id,scriptVersion:1,identityId:'identity-one',stepIndex:3,status:'human',runtimeId:f.port.runtimeId,updatedAt:fixedNow.toISOString(),aiLocateCalls:0,aiLocatedStepIds:[],humanReason:'irreversible_unknown',irreversible:{stepId:'submit',at:fixedNow.toISOString()}};
  const context={task:registrationHandoff(state),signupHooks:f.input.hooks,secrets:f.input.secrets} as unknown as ExecutionContext;
  assert.equal(await resumeSignupHumanAction(context,s,f.port),false);assert.equal(f.dispatches,0);
  f.success=true;assert.equal(await resumeSignupHumanAction(context,s,f.port),'done');assert.equal(f.durable.at(-1)?.irreversible?.completed,true);assert.equal(f.vault.get('signup:task-one:api_key'),'mock-api-key-private');assert.equal(f.closed,true);
});
test('a legacy irreversible step cannot resume from a form still visible after human action',async()=>{
  const f=fixture(),s=script();await f.port.open('https://example.com/signup');
  const legacy={...s,steps:s.steps.map(step=>step.id==='submit'?{...step,resumeWhen:{css:'#email'}}:step)} as SignupScript;
  const state:SignupTaskState={version:1,scriptId:s.id,scriptVersion:s.version,identityId:'identity-one',stepIndex:3,status:'human',runtimeId:f.port.runtimeId,updatedAt:fixedNow.toISOString(),aiLocateCalls:0,aiLocatedStepIds:[],humanReason:'captcha',successCondition:{css:'#email'}};
  let account={status:'draft'};
  const context={task:registrationHandoff(state),signupHooks:f.input.hooks,secrets:f.input.secrets,getAccount:()=>account,saveAccount:async(value:typeof account)=>{account=value;}} as unknown as ExecutionContext;
  assert.equal(await resumeSignupHumanAction(context,legacy,f.port),false);
  assert.equal(f.durable.length,0);assert.equal(f.dispatches,0);
  f.captcha=true;f.success=true;
  assert.equal(await resumeSignupHumanAction(context,legacy,f.port),'done');
  assert.equal(f.dispatches,0);assert.equal(account.status,'registered');
});
test('mail pending results suppress human reasons only when an actual wait was registered',async()=>{
  const f=fixture();f.emailReady=false;const result=await runSignupScript(script(),f.input);assert.equal(result.status,'waiting_email');
  const waiting=signupBrowserResult(result,{task:{} as ExecutionContext['task'],signupHooks:{...f.input.hooks,emailWaitRegistered:()=>true}});
  assert.equal(waiting.checkpoint,'waiting_email');assert.equal(waiting.reasonCode,undefined);
  const handoff=signupBrowserResult(result,{task:{} as ExecutionContext['task'],signupHooks:{...f.input.hooks,emailWaitRegistered:()=>false}});
  assert.equal(handoff.checkpoint,'account_handoff');assert.equal(handoff.reasonCode,'account_handoff');
  const queued=signupBrowserResult(result,{task:{} as ExecutionContext['task'],signupHooks:{...f.input.hooks,emailWaitRegistered:()=>false,emailWaitQueued:()=>true}});
  assert.equal(queued.checkpoint,'email_code_pending');assert.equal(queued.reasonCode,'email_code_pending');
});
test('completed signup finalizes once and then routes to the publication path',async()=>{
  const s=script(),f=fixture();const done=await runSignupScript(s,f.input);assert.equal(done.status,'done');
  assert.equal(needsDeterministicSignup({status:'draft'},done.state),false);assert.equal(needsDeterministicSignup({status:'registered'},done.state),false);
  assert.equal((await runSignupScript({...s,version:s.version+1},{...f.input,state:done.state})).status,'done');
  const registry=SIGNUP_SCRIPTS as Map<string,SignupScript>;registry.set(s.platformId,s);
  try{
    const account={status:'registered'};const context={channel:{id:s.platformId,automation:'browser'},task:{id:'task-one',signup:done.state,checkpoint:'existing_link',publicUrl:'https://example.com/public'},getAccount:()=>account} as unknown as ExecutionContext;
    const published=await runBrowserTask(context);assert.equal(published.status,'skipped');assert.equal(published.checkpoint,'existing_link');assert.equal(context.task.signup?.status,'done');
    const degraded={...context,task:{...context.task,checkpoint:'account_verified',publicUrl:undefined},getAccount:()=>({status:'draft'})} as ExecutionContext;
    const blocked=await runBrowserTask(degraded);assert.equal(blocked.status,'needs_input');assert.equal(blocked.checkpoint,'account_registration_human');
  }finally{registry.delete(s.platformId);}
});


test('single-account policy blocks draft B when distinct identity A is done or has an irreversible record',async()=>{
  const first=fixture(),s=script();const a=await runSignupScript(s,first.input);assert.equal(a.status,'done');
  for(const prior of [a.state,{...a.state,status:'human' as const,irreversible:{stepId:'submit',at:fixedNow.toISOString()}}]){
    const second=fixture();second.input.identity.id='identity-two';second.input.hooks.listPlatformStates=()=>[prior];
    const result=await runSignupScript(s,second.input);assert.equal(result.state.humanReason,'existing_identity');assert.equal(second.dispatches,0);assert.equal(second.actions.length,0);
  }
  const same=fixture();same.input.hooks.listPlatformStates=()=>[a.state];assert.equal((await runSignupScript(s,same.input)).status,'done');
});
test('single-account policy also checks fresh platform accounts and rechecks before the next mutation',async()=>{
  const existing=fixture();existing.input.hooks.hasOtherPlatformIdentity=()=>true;
  const blocked=await runSignupScript(script(),existing.input);assert.equal(blocked.state.humanReason,'existing_identity');assert.equal(existing.dispatches,0);
  const concurrent=fixture();let other=false;concurrent.input.hooks.hasOtherPlatformIdentity=()=>other;concurrent.input.hooks.awaitEmail=async()=>{other=true;return '123456';};
  const stopped=await runSignupScript(script(),concurrent.input);assert.equal(stopped.state.humanReason,'existing_identity');assert.equal(concurrent.dispatches,1);assert(!concurrent.actions.some(action=>action.action==='irreversible'&&action.selector==='#verify'));
});

test('a new platform identity observed while persisting the intent prevents dispatch',async()=>{
  const f=fixture();let other=false;f.input.hooks.hasOtherPlatformIdentity=()=>other;
  f.input.hooks.persist=async state=>{f.durable.push(structuredClone(state));if(state.status==='irreversible')other=true;};
  const result=await runSignupScript(script(),f.input);assert.equal(result.state.humanReason,'existing_identity');assert.equal(f.dispatches,0);assert.equal(result.state.irreversible?.completed,undefined);
});

test('a new window safely replays pre-submit navigation and fields while preserving the locator budget',async()=>{
  const before=fixture(),abort=new AbortController();before.input.signal=abort.signal;
  before.input.hooks.persist=async state=>{before.durable.push(structuredClone(state));if(state.status==='running'&&state.stepIndex===3)abort.abort();};
  const paused=await runSignupScript(script(),before.input);assert.equal(paused.status,'cancelled');assert.equal(paused.state.stepIndex,3);assert.equal(paused.state.irreversible,undefined);assert.equal(before.dispatches,0);
  const fresh=fixture();fresh.port.runtimeId='fresh-window';fresh.emailReady=false;
  const budgeted={...paused.state,aiLocateCalls:1 as const,aiLocatedStepIds:['prior-selector']};
  const resumed=await runSignupScript(script(),{...fresh.input,state:budgeted});assert.equal(resumed.status,'waiting_email');assert.equal(fresh.values.get('#email'),'owner@example.com');assert.equal(fresh.dispatches,1);assert.equal(resumed.state.aiLocateCalls,1);assert.deepEqual(resumed.state.aiLocatedStepIds,['prior-selector']);
  assert.equal(fresh.durable[0].stepIndex,0);assert.equal(fresh.durable[0].runtimeId,'fresh-window');
  const after=fixture();after.port.runtimeId='later-window';const blocked=await runSignupScript(script(),{...after.input,state:resumed.state});assert.equal(blocked.state.humanReason,'window_lost');assert.equal(after.actions.length,0);assert.equal(after.dispatches,0);
});
