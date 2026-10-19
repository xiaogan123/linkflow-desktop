import test,{beforeEach,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {Controller} from '../src/main/controller';
import {Store} from '../src/main/store';
import {CHANNELS} from '../src/integrations/catalog';
import {createHumanAction} from '../src/shared/human-action';
import {maintainSignupCircuits} from '../src/main/signup-circuit';
import {emailValueKey} from '../src/main/email-waits';
import type {SignupTaskState} from '../src/shared/signup';
import {SIGNUP_SCRIPTS,type SignupScript} from '../src/integrations/signup-executor';
import mockScript from '../src/integrations/signup-scripts/mock-local.json';
import type {Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const sid='11111111-1111-4111-8111-111111111111',tid='22222222-2222-4222-8222-222222222222',mid='33333333-3333-4333-8333-333333333333',aid='44444444-4444-4444-8444-444444444444';
beforeEach(t=>{
  const clock=t as TestContext,now=Date.parse('2026-10-19T10:17:00.000Z');
  if(t.name==='human window polls every 1.5 seconds and continues without the user clicking done')clock.mock.timers.enable({apis:['Date','setInterval'],now});
  else clock.mock.timers.enable({apis:['Date'],now});
});
function fixture(){
  const stamp=new Date().toISOString(),store=new Store(':memory:'),values=new Map<string,string>();
  const site:Site={id:sid,url:'https://example.com',domain:'example.com',email:'owner@example.com',name:'Example',description:'Publishing guides',category:'content',language:'en',status:'ready',monthlyTarget:1,createdAt:stamp,topicsCheckedAt:stamp,mailboxId:mid};
  const task:Task={id:tid,siteId:sid,channelId:'telegraph',sourceDomain:'telegra.ph',status:'needs_input',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture'};
  store.update(state=>{state.settings.autoRun=true;state.settings.notify=false;state.sites=[site];state.tasks=[task];state.mailboxes=[{id:mid,label:'Example',host:'imap.example.com',port:993,user:site.email,secure:true,aliases:[],hasPassword:true,verifiedAt:stamp,createdAt:stamp,updatedAt:stamp}];state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(channel=>[channel.id,['telegraph','shiply'].includes(channel.id)]))});
  const vault={ready:true,available:()=>true,get:async(key:string)=>values.get(key)??store.getCipher(key)?.slice('encrypted:'.length),set:async(key:string,value:string)=>{values.set(key,value)},delete:async(key:string)=>{values.delete(key)},encryptSecrets:(secrets:Record<string,string>)=>Object.fromEntries(Object.entries(secrets).map(([k,v])=>[k,'encrypted:'+v]))} as unknown as Vault;
  return {stamp,store,vault,site,task};
}


function installHumanScript(){
  const registry=SIGNUP_SCRIPTS as Map<string,SignupScript>;
  registry.set('telegraph',{...structuredClone(mockScript) as SignupScript,platformId:'telegraph'});
  return ()=>registry.delete('telegraph');
}

test('controller main loop completes another preparation while mail is still pending',async()=>{
  const f=fixture();let release!:(value:{kind:'none'})=>void,scans=0,prepared=0;
  f.store.update(state=>{
    state.tasks[0].checkpoint='waiting_email';state.tasks[0].emailWait={kind:'code',recipient:f.site.email,since:f.stamp,nextPollAt:f.stamp,expiresAt:new Date(Date.now()+600_000).toISOString(),mailboxId:mid,consumedMessageIds:[],continuation:'browser'};
    state.sites.push({...f.site,id:'55555555-5555-4555-8555-555555555555',url:'https://example-site.com',domain:'example-site.com'});
    state.tasks.push({...f.task,id:'66666666-6666-4666-8666-666666666666',siteId:state.sites[1].id,status:'queued'});
  });
  const controller=new Controller(f.store,f.vault,'fixture',{scanMail:async()=>{scans++;return new Promise(done=>{release=done})},prepareTask:async()=>{prepared++;return {status:'needs_input',reasonCode:'human_required',message:'fixture preparation'}}});controller.runtime.aiReady=true;
  try{await controller.tick();assert.equal(scans,1);assert.equal(prepared,1);assert.equal(controller.runtime.busy,false);assert.equal(f.store.read().tasks[0].checkpoint,'waiting_email');release({kind:'none'});await setImmediate()}finally{controller.stop();f.store.close()}
});

test('Shiply existing code intent automatically consumes exactly one matching code',async()=>{
  const f=fixture();let verified=0;
  f.store.update(state=>{Object.assign(state.tasks[0],{channelId:'shiply',sourceDomain:'shiply.now',checkpoint:'email_code_pending',reasonCode:'email_code_pending',accountId:aid});state.accounts=[{id:aid,channelId:'shiply',email:f.site.email,username:f.site.email,mailboxId:mid,status:'needs_verification',credentialKind:'api_token',source:'generated',hasPassword:false,createdAt:f.stamp,shiply:{version:1,emailHash:'a'.repeat(64),requestedAt:f.stamp,siteId:sid,stage:'code_sent'}}]});
  const controller=new Controller(f.store,f.vault,'fixture',{scanMail:async()=>({kind:'code',code:'834792',snippet:'OTP 834792',messageId:'message-one'}),verifyMailShiply:async(_store,_vault,input)=>{verified++;assert.equal(input.accountId,aid);assert.equal(input.code,'834792');assert.deepEqual(input.siteIds,[sid]);return f.store.read().accounts[0]}});
  controller.runtime.busy=true;
  try{controller.registerPendingEmailTasks();f.store.update(state=>{if(state.tasks[0].emailWait)state.tasks[0].emailWait.nextPollAt=f.stamp});await controller.tick();await setImmediate();await controller.tick();await setImmediate();assert.equal(verified,1);assert.equal(f.store.read().tasks[0].status,'queued');assert.equal(f.store.read().tasks[0].emailWait,undefined)}finally{controller.stop();f.store.close()}
});

test('human done validates successful page condition; skip preserves the original task',async()=>{
  const removeScript=installHumanScript();const f=fixture();let completed=false,opened=0;
  f.store.update(state=>{state.tasks[0].checkpoint='account_registration_human';state.tasks[0].accountId=aid;state.accounts=[{id:aid,channelId:'telegraph',email:f.site.email,username:'fixture',status:'draft',source:'generated',hasPassword:true,createdAt:f.stamp}];state.tasks[0].signup={version:1,scriptId:mockScript.id,scriptVersion:1,identityId:aid,stepIndex:0,status:'human',runtimeId:'fixture',updatedAt:f.stamp,aiLocateCalls:0,aiLocatedStepIds:[]};state.tasks[0].reasonCode='captcha_required';state.tasks[0].humanAction=createHumanAction(state.tasks[0],{kind:'captcha'})});
  const controller=new Controller(f.store,f.vault,'fixture',{hasHumanBrowser:()=>true,openHumanBrowser:async()=>{opened++},humanBrowserComplete:async()=>completed});controller.runtime.busy=true;
  try{await controller.openHumanAction(tid);assert.equal(opened,1);await assert.rejects(controller.doneHumanAction(tid));assert.equal(f.store.read().tasks[0].status,'needs_input');completed=true;await controller.doneHumanAction(tid);assert.equal(f.store.read().tasks[0].status,'queued');assert.equal(f.store.read().tasks[0].humanAction,undefined);controller.patch(tid,{status:'needs_input',reasonCode:'phone_required'});controller.skipHumanAction(tid);assert.equal(f.store.read().tasks.find(value=>value.id===tid)?.reasonCode,'user_skipped')}finally{removeScript();controller.stop();f.store.close()}
});

test('only expiring human actions notify immediately; ordinary waits aggregate',()=>{
  const f=fixture(),notices:string[]=[];f.store.update(state=>{state.settings.notify=true});
  const controller=new Controller(f.store,f.vault,'fixture');controller.onNotice=(title,body)=>notices.push(title+body);
  try{controller.patch(tid,{status:'needs_input',reasonCode:'captcha_required'});assert.equal(notices.length,0);controller.patch(tid,{humanAction:createHumanAction(f.task,{kind:'email_code_ambiguous',expiresAt:new Date(Date.now()+600_000).toISOString()}),reasonCode:'human_required'});assert.equal(notices.length,1);controller.patch(tid,{message:'fixture changed'});assert.equal(notices.length,1)}finally{controller.stop();f.store.close()}
});

test('scriptless mail done requires a fresh read-only page check without renewing stale verification',async()=>{
  const f=fixture();f.store.update(state=>{state.tasks[0].accountId=aid;state.tasks[0].reasonCode='account_handoff';state.tasks[0].humanAction=createHumanAction(state.tasks[0],{kind:'account_login'});state.accounts=[{id:aid,channelId:'telegraph',email:f.site.email,username:'fixture',source:'imported',status:'registered',hasPassword:true,createdAt:'2026-01-01T00:00:00.000Z',verifiedAt:'2026-01-01T00:00:00.000Z'}]});
  const controller=new Controller(f.store,f.vault,'fixture',{humanBrowserComplete:async()=>false});
  controller.runtime.busy=true;try{await assert.rejects(controller.doneHumanAction(tid));assert.equal(f.store.read().tasks[0].status,'needs_input');assert.equal(f.store.read().accounts[0].verifiedAt,'2026-01-01T00:00:00.000Z')}finally{controller.stop();f.store.close()}
});

test('delivery commits encrypted value and queue state together and clearing wait removes transient cipher',async()=>{
  const f=fixture();f.store.update(state=>{state.tasks[0].checkpoint='waiting_email';state.tasks[0].emailWait={kind:'code',recipient:f.site.email,since:f.stamp,nextPollAt:f.stamp,expiresAt:new Date(Date.now()+600_000).toISOString(),mailboxId:mid,consumedMessageIds:[],continuation:'browser'}});
  const controller=new Controller(f.store,f.vault,'fixture',{scanMail:async()=>({kind:'code',code:'834792',snippet:'OTP 834792',messageId:'delivery-once'})});controller.runtime.busy=true;
  try{await controller.tick();await setImmediate();const saved=f.store.read().tasks[0];assert.equal(saved.status,'queued');assert.deepEqual(saved.emailWait?.consumedMessageIds,['delivery-once']);assert.equal(JSON.parse((await f.vault.get(emailValueKey(tid)))!).value,'834792');controller.patch(tid,{emailWait:undefined});assert.equal(f.store.getCipher(emailValueKey(tid)),undefined)}finally{controller.stop();f.store.close()}
});

test('three platform failures consolidate one handoff and delay future signup for seven days',()=>{
  const f=fixture(),now=new Date(f.stamp),until=new Date(now.getTime()+7*86_400_000).toISOString();
  const signup=(index:number):SignupTaskState=>({version:1,scriptId:'fixture',scriptVersion:1,identityId:aid,stepIndex:1,status:'human',runtimeId:'fixture',updatedAt:new Date(now.getTime()-index*1000).toISOString(),aiLocateCalls:0,aiLocatedStepIds:[],failure:'selector_missing',humanReason:'selector_drift'});
  f.store.update(state=>{state.tasks=[0,1,2].map(index=>({...f.task,id:index===0?tid:`fixture-${index}`,signup:signup(index),humanAction:createHumanAction(f.task,{kind:'selector_drift'}),reasonCode:'human_required'}));state.tasks.push({...f.task,id:'future-task',status:'queued'});maintainSignupCircuits(state,now)});
  try{let tasks=f.store.read().tasks;assert.equal(tasks.filter(value=>!!value.humanAction).length,1);assert.equal(tasks.find(value=>value.id==='future-task')?.scheduledAt,until);f.store.update(state=>{state.tasks.push({...f.task,id:'circuit-card',signup:{...signup(0),failure:undefined,humanReason:'circuit_open'},humanAction:createHumanAction(f.task,{kind:'selector_drift'})});maintainSignupCircuits(state,now)});tasks=f.store.read().tasks;assert.equal(tasks.filter(value=>!!value.humanAction).length,1);assert.equal(tasks[0].signup?.updatedAt,f.stamp)}finally{f.store.close()}
});

test('ordinary human notices are one summary per local calendar day, including newly added waits',async()=>{
  const f=fixture(),notices:string[]=[];f.store.update(state=>{state.settings.notify=true;state.tasks[0].reasonCode='phone_required';state.tasks[0].humanAction=createHumanAction(state.tasks[0],{kind:'phone'})});
  const controller=new Controller(f.store,f.vault,'fixture');controller.runtime.busy=true;controller.onNotice=title=>notices.push(title);
  try{await controller.tick();assert.equal(notices.length,1);f.store.update(state=>state.tasks.push({...f.task,id:'later-wait',reasonCode:'captcha_required',humanAction:createHumanAction(f.task,{kind:'captcha'})}));await controller.tick();assert.equal(notices.length,1);assert.ok(f.store.read().settings.humanActionSummaryDate)}finally{controller.stop();f.store.close()}
});

test('pause after registering mail leaves a valid durable waiting state for the next poll',async()=>{
  const f=fixture();f.store.update(state=>{state.tasks[0].status='queued'});
  let controller:Controller;
  controller=new Controller(f.store,f.vault,'fixture',{prepareTask:async context=>{
    await context.signupHooks!.awaitEmail!({kind:'code',stepId:'code',scriptId:'fixture',allowedHosts:context.channel.allowedHosts},context.signal);
    controller.pause();
    return {status:'needs_input',checkpoint:'waiting_email',reasonCode:undefined,message:'fixture'};
  }});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=f.store.read().tasks[0];assert.equal(saved.status,'needs_input');assert.equal(saved.checkpoint,'waiting_email');assert.equal(saved.reasonCode,undefined);assert.ok(saved.emailWait);assert.equal(saved.humanAction,undefined)}finally{controller.stop();f.store.close()}
});

test('a declared local script resumes its original draft identity after queued mail delivery',async()=>{
  const f=fixture(),script=structuredClone(mockScript) as SignupScript;
  const channel={...CHANNELS.find(value=>value.id==='telegraph')!,id:script.platformId,domain:'example.com',url:'https://example.com',submitUrl:'https://example.com/signup',rulesUrl:'https://example.com/rules',allowedHosts:['example.com'],automation:'browser' as const,kind:'profile' as const,articleRequired:false,accountRequired:true,emailRequired:true};
  const registry=SIGNUP_SCRIPTS as Map<string,SignupScript>;registry.set(channel.id,script);
  f.store.update(state=>{state.settings.channelOverrides[channel.id]=true;state.accounts=[{id:aid,channelId:channel.id,email:f.site.email,username:'fixture',status:'draft',source:'generated',hasPassword:true,registrationAttempts:1,createdAt:f.stamp}];Object.assign(state.tasks[0],{channelId:channel.id,sourceDomain:channel.domain,accountId:aid,status:'queued',checkpoint:'signup_resume',signup:{version:1,scriptId:script.id,scriptVersion:1,identityId:aid,stepIndex:4,status:'waiting_email',runtimeId:'fixture',updatedAt:f.stamp,aiLocateCalls:0,aiLocatedStepIds:[],irreversible:{stepId:'submit',at:f.stamp,completed:true}}})});
  let prepared=0;const controller=new Controller(f.store,f.vault,'fixture',{channelCatalog:[channel],prepareTask:async context=>{prepared++;assert.equal(context.getAccount()?.id,aid);return {status:'needs_input',reasonCode:'human_required',message:'fixture'}}});controller.runtime.aiReady=true;
  try{controller.plan();assert.equal(f.store.read().tasks[0].status,'queued');await controller.tick();assert.equal(prepared,1);assert.equal(f.store.read().accounts.length,1);assert.equal(f.store.read().accounts[0].registrationAttempts,1)}finally{controller.stop();f.store.close();registry.delete(channel.id)}
});

test('full signup human completion keeps the original window signal alive for publication continuation',async()=>{
  const removeScript=installHumanScript();const f=fixture();let windowSignal:AbortSignal|undefined;
  f.store.update(state=>{state.tasks[0].checkpoint='account_registration_human';state.tasks[0].accountId=aid;state.accounts=[{id:aid,channelId:'telegraph',email:f.site.email,username:'fixture',status:'draft',source:'generated',hasPassword:true,createdAt:f.stamp}];state.tasks[0].signup={version:1,scriptId:mockScript.id,scriptVersion:1,identityId:aid,stepIndex:0,status:'human',runtimeId:'fixture',updatedAt:f.stamp,aiLocateCalls:0,aiLocatedStepIds:[]};state.tasks[0].reasonCode='captcha_required';state.tasks[0].humanAction=createHumanAction(state.tasks[0],{kind:'captcha'});state.tasks[0].signup={version:1,scriptId:mockScript.id,scriptVersion:1,identityId:aid,stepIndex:0,status:'human',runtimeId:'fixture',updatedAt:f.stamp,aiLocateCalls:0,aiLocatedStepIds:[],humanReason:'captcha'};state.tasks[0].accountId=aid;state.accounts=[{id:aid,channelId:'telegraph',email:f.site.email,username:'fixture',status:'draft',source:'generated',hasPassword:true,createdAt:f.stamp}]});
  const controller=new Controller(f.store,f.vault,'fixture',{hasHumanBrowser:()=>true,openHumanBrowser:async context=>{windowSignal=context.signal},humanBrowserComplete:async context=>{await context.signupHooks!.persist({...context.task.signup!,status:'done',humanReason:undefined});return true}});controller.runtime.busy=true;
  try{await controller.openHumanAction(tid);await controller.doneHumanAction(tid);assert.equal(windowSignal?.aborted,false);assert.equal(f.store.read().tasks[0].status,'queued');assert.equal(f.store.read().tasks[0].signup?.status,'done')}finally{removeScript();controller.stop();f.store.close()}
});

test('human window polls every 1.5 seconds and continues without the user clicking done',async t=>{
  const removeScript=installHumanScript();const f=fixture();let polls=0,complete=false;
  f.store.update(state=>{state.tasks[0].checkpoint='account_registration_human';state.tasks[0].accountId=aid;state.accounts=[{id:aid,channelId:'telegraph',email:f.site.email,username:'fixture',status:'draft',source:'generated',hasPassword:true,createdAt:f.stamp}];state.tasks[0].signup={version:1,scriptId:mockScript.id,scriptVersion:1,identityId:aid,stepIndex:0,status:'human',runtimeId:'fixture',updatedAt:f.stamp,aiLocateCalls:0,aiLocatedStepIds:[]};state.tasks[0].reasonCode='captcha_required';state.tasks[0].humanAction=createHumanAction(state.tasks[0],{kind:'captcha'})});
  const controller=new Controller(f.store,f.vault,'fixture',{hasHumanBrowser:()=>true,openHumanBrowser:async()=>{},humanBrowserComplete:async()=>{polls++;return complete}});controller.runtime.busy=true;
  try{await controller.openHumanAction(tid);t.mock.timers.tick(1499);assert.equal(polls,0);t.mock.timers.tick(1);await setImmediate();assert.equal(polls,1);assert.equal(f.store.read().tasks[0].status,'needs_input');complete=true;t.mock.timers.tick(1500);await setImmediate();assert.equal(polls,2);assert.equal(f.store.read().tasks[0].status,'queued');t.mock.timers.tick(3000);await setImmediate();assert.equal(polls,2)}finally{removeScript();controller.stop();f.store.close();t.mock.timers.reset()}
});

test('selector fallback respects shared daily and task AI budgets with attributable costs',async()=>{
  const f=fixture();f.store.update(state=>{state.tasks[0].status='queued';state.settings.dailyAiLimit=1});
  let calls=0;const controller=new Controller(f.store,f.vault,'fixture',{aiFactory:(_settings,_vault,onCall)=>({json:async<T>()=>{onCall?.();calls++;return {selector:'#email'} as T}}),prepareTask:async context=>{
    const request={stepId:'email',selector:'#missing',page:{controls:[]}};
    assert.equal(await context.signupHooks!.locate!(request,context.signal),'#email');
    await assert.rejects(context.signupHooks!.locate!(request,context.signal));
    return {status:'needs_input',reasonCode:'human_required',message:'fixture'};
  }});controller.runtime.aiReady=true;
  try{await controller.tick();assert.equal(calls,1);assert.equal(f.store.read().tasks[0].cost?.aiCalls??0,1);assert.equal(Object.values(f.store.read().usage).reduce((sum,value)=>sum+value,0),1)}finally{controller.stop();f.store.close()}
});

test('6c repeated signup deferrals do not exhaust attempts or strand the queued task',async()=>{
  const f=fixture(),script=structuredClone(mockScript) as SignupScript;
  const channel={...CHANNELS.find(value=>value.id==='telegraph')!,id:script.platformId,domain:'example.com',url:'https://example.com',submitUrl:'https://example.com/signup',rulesUrl:'https://example.com/rules',allowedHosts:['example.com'],automation:'browser' as const,kind:'profile' as const,articleRequired:false,accountRequired:true,emailRequired:true};
  const registry=SIGNUP_SCRIPTS as Map<string,SignupScript>;registry.set(channel.id,script);let executions=0;
  f.store.update(state=>{state.settings.channelOverrides[channel.id]=true;state.accounts=[{id:aid,channelId:channel.id,email:f.site.email,username:'fixture',status:'draft',source:'generated',hasPassword:true,registrationAttempts:0,createdAt:f.stamp}];Object.assign(state.tasks[0],{channelId:channel.id,sourceDomain:channel.domain,accountId:aid,status:'queued',draft:{title:'Example profile',description:'Fixture description',body:'Example profile description https://example.com'},articleApprovedAt:f.stamp,signup:{version:1,scriptId:script.id,scriptVersion:1,identityId:aid,stepIndex:0,status:'running',runtimeId:'fixture',updatedAt:f.stamp,aiLocateCalls:0,aiLocatedStepIds:[]}})});
  const controller=new Controller(f.store,f.vault,'fixture',{channelCatalog:[channel],aiFactory:()=>({json:async()=>{throw Error('Unexpected AI request in offline fixture')}}) as never,executeTask:async context=>{executions++;return {status:'queued',checkpoint:'signup_deferred',message:'Fixture deferred',scheduledAt:new Date(Date.now()+900_000).toISOString(),signup:context.task.signup}}});controller.runtime.aiReady=true;
  try{
    for(let i=0;i<4;i++){
      await controller.tick();const saved=f.store.read().tasks[0];assert.equal(saved.status,'queued');assert.equal(saved.attempts,0,JSON.stringify({checkpoint:saved.checkpoint,message:saved.message,executions}));assert.equal(saved.checkpoint,'signup_deferred');
      f.store.update(state=>{state.tasks[0].scheduledAt=new Date(Date.now()-1000).toISOString()});
    }
    assert.equal(executions,4);
  }finally{controller.stop();f.store.close();registry.delete(channel.id)}
});
