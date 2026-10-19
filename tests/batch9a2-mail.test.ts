import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Controller,type ControllerServices} from '../src/main/controller';
import {validateBackup} from '../src/main/backup-validation';
import {emailValueKey} from '../src/main/email-waits';
import {emptyState,Store} from '../src/main/store';
import {createHumanAction} from '../src/shared/human-action';
import {CHANNELS} from '../src/integrations/catalog';
import type {Account,Channel,Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const siteId='11111111-1111-4111-8111-111111111111';
const taskId='22222222-2222-4222-8222-222222222222';
const accountId='33333333-3333-4333-8333-333333333333';
const mailboxId='44444444-4444-4444-8444-444444444444';
const oldMailboxId='55555555-5555-4555-8555-555555555555';

function shiplyFixture(){
  const now=new Date(),stamp=now.toISOString(),store=new Store(':memory:'),channel={...CHANNELS.find(value=>value.id==='shiply')!,enabled:true};
  const site:Site={id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Fixture',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp};
  const task:Task={id:taskId,siteId,channelId:'shiply',sourceDomain:'shiply.now',status:'needs_input',checkpoint:'email_verification_human',reasonCode:'account_handoff',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',accountId};
  task.humanAction=createHumanAction(task,{kind:'account_login'},now);task.waitingSince=task.humanAction.since;task.waitingDeadlineAt=task.humanAction.deadline;
  const account:Account={id:accountId,channelId:'shiply',email:site.email,username:site.email,credentialKind:'api_token',status:'registered',hasPassword:true,source:'generated',createdAt:stamp,shiply:{version:1,emailHash:createHash('sha256').update(site.email).digest('hex'),siteId,requestedAt:stamp,stage:'ready',keyFingerprint:'a'.repeat(64)}};
  store.update(state=>{state.sites=[site];state.tasks=[task];state.accounts=[account];state.accountBindings=[{id:mailboxId,siteId,channelId:'shiply',accountId,createdAt:stamp,updatedAt:stamp}];state.settings.autoRun=true});
  const controller=new Controller(store,{ready:true,available:()=>true} as Vault,'fixture',{channelCatalog:[channel]});
  return {store,controller,close(){controller.stop();store.close()}};
}

test('batch9a2 Shiply account-login mail handoff resumes when the original account is ready and bound',()=>{
  const f=shiplyFixture();try{
    f.controller.runtime.aiReady=true;
    f.controller.plan();const saved=f.store.read().tasks[0];
    assert.equal(saved.status,'queued');assert.equal(saved.checkpoint,undefined);assert.equal(saved.humanAction,undefined);
    assert.equal(saved.waitingSince,undefined);assert.equal(saved.waitingDeadlineAt,undefined);
  }finally{f.close()}
});

function confirmationFixture(resolveMailLink:NonNullable<ControllerServices['resolveMailLink']>){
  const now=new Date(),stamp=now.toISOString(),expiresAt=new Date(now.getTime()+10*60_000).toISOString(),store=new Store(':memory:');
  const channel:Channel={id:'fixture-browser',name:'Fixture',domain:'platform.example.com',url:'https://platform.example.com/',submitUrl:'https://platform.example.com/signup',categories:['general'],languages:['*'],kind:'article',emailRequired:true,accountRequired:true,articleRequired:true,free:'yes',freeNote:'fixture',automation:'browser',quality:'C',qualityReason:'fixture',rulesUrl:'https://platform.example.com/rules',checkedAt:'2026-10-19',notes:'fixture',allowedHosts:['platform.example.com'],enabled:true};
  const site:Site={id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Fixture',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp,mailboxId};
  const wait:NonNullable<Task['emailWait']>={kind:'link',recipient:site.email,since:stamp,nextPollAt:stamp,expiresAt,mailboxId,consumedMessageIds:['tracker-message'],continuation:'browser'};
  const task:Task={id:taskId,siteId,channelId:channel.id,sourceDomain:channel.domain,status:'needs_input',checkpoint:'email_confirmation',reasonCode:'human_required',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',accountId,emailConfirmation:{wait,messageId:'tracker-message'}};
  task.humanAction=createHumanAction(task,{kind:'email_confirmation',snippet:'[已隐藏]',expiresAt},now);task.waitingSince=task.humanAction.since;task.waitingDeadlineAt=task.humanAction.deadline;
  const account:Account={id:accountId,channelId:channel.id,email:site.email,username:'fixture',mailboxId,status:'unknown',hasPassword:true,source:'generated',createdAt:stamp,registrationAttempts:1};
  const mailbox={id:mailboxId,label:'Fixture',host:'imap.example.com',port:993,user:site.email,secure:true as const,hasPassword:true,aliases:[],createdAt:stamp,updatedAt:stamp,verifiedAt:stamp};
  const tracker='https://tracking.example.net/click?token=fixture',key=emailValueKey(taskId),plain=new Map([[key,JSON.stringify({kind:'link',value:tracker,recipient:site.email,expiresAt})]]);
  const vault={ready:true,available:()=>true,get:async(value:string)=>plain.get(value),delete:async(value:string)=>{plain.delete(value);store.deleteCipher(value)},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([value,payload])=>{plain.set(value,payload);return [value,`enc:${Buffer.from(payload).toString('base64url')}`]}))} as unknown as Vault;
  store.updateWithCiphers(state=>{state.sites=[site];state.tasks=[task];state.accounts=[account];state.mailboxes=[mailbox];state.emailConsumptions=[{channelId:channel.id,recipient:site.email,messageIds:['tracker-message']}];state.settings.autoRun=false},vault.encryptSecrets({[key]:plain.get(key)!}));
  const controller=new Controller(store,vault,'fixture',{channelCatalog:[channel],resolveMailLink});controller.runtime.busy=true;
  return {store,controller,plain,key,tracker,close(){controller.stop();store.close()}};
}

test('batch9a2 confirmed tracker resolves once and only the whitelisted platform URL resumes registration',async()=>{
  const resolved='https://platform.example.com/verify?token=fixture',calls:string[]=[];
  const f=confirmationFixture(async(value)=>{calls.push(value);return {kind:'resolved',url:resolved}});try{
    await f.controller.doneHumanAction(taskId);const saved=f.store.read().tasks[0];
    assert.deepEqual(calls,[f.tracker]);assert.equal(saved.status,'queued');assert.equal(saved.checkpoint,'account_registration_submitted');
    assert.equal(saved.emailConfirmation,undefined);assert.equal(saved.emailWait?.kind,'link');assert.equal(saved.humanAction,undefined);
    assert.equal(JSON.parse(f.plain.get(f.key)!).value,resolved);
  }finally{f.close()}
});

test('batch9a2 a tracker that does not resolve to a platform verification URL becomes a manual handoff',async()=>{
  let calls=0;const f=confirmationFixture(async()=>{calls++;return {kind:'resolved',url:'https://other.example.com/verify?token=fixture'}});try{
    await f.controller.doneHumanAction(taskId);const saved=f.store.read().tasks[0];
    assert.equal(calls,1);assert.equal(saved.status,'needs_input');assert.equal(saved.checkpoint,'email_verification_human');
    assert.equal(saved.humanAction?.kind,'account_login');assert.equal(saved.emailConfirmation,undefined);assert.equal(saved.emailWait,undefined);
    assert.equal(f.store.getCipher(f.key),undefined);
  }finally{f.close()}
});

function staleWaitBackup(status:'live'|'skipped'){
  const stamp='2026-10-18T00:00:00.000Z',state=emptyState();
  const site:Site={id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Fixture',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp};
  const wait:NonNullable<Task['emailWait']>={kind:'link',recipient:site.email,since:stamp,nextPollAt:'2026-10-18T00:01:00.000Z',expiresAt:'2026-10-20T00:00:00.000Z',mailboxId:oldMailboxId,consumedMessageIds:['old-message'],continuation:'browser'};
  const task:Task={id:taskId,siteId,channelId:'fixture-browser',sourceDomain:'platform.example.com',status,createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',emailWait:wait,...(status==='skipped'?{reasonCode:'human_timeout' as const,checkpoint:'email_verification_human'}:{})};
  if(status==='skipped'){
    task.humanAction=createHumanAction(task,{kind:'account_login'},new Date(stamp));task.waitingSince=task.humanAction.since;task.waitingDeadlineAt=task.humanAction.deadline;
  }
  state.sites=[site];state.tasks=[task];
  return {state,secrets:{[`signup:${taskId}:email`]:JSON.stringify({kind:'link',value:'https://platform.example.com/verify?token=fixture',recipient:site.email,expiresAt:wait.expiresAt})}};
}

test('batch9a2 restore drops inactive waits before mailbox drift without reviving terminal tasks',()=>{
  for(const status of ['live','skipped'] as const){
    const input=staleWaitBackup(status),before=structuredClone(input.state.tasks[0]),restored=validateBackup(input),saved=restored.state.tasks[0];
    assert.equal(saved.status,before.status);assert.equal(saved.checkpoint,before.checkpoint);assert.deepEqual(saved.humanAction,before.humanAction);
    assert.equal(saved.emailWait,undefined);assert.equal(saved.emailWaitRegisteredAt,before.emailWait?.since);
    assert.deepEqual(restored.state.emailConsumptions,[{channelId:before.channelId,recipient:'owner@example.com',messageIds:['old-message']}]);
    assert.equal(restored.secrets[`signup:${taskId}:email`],undefined);
  }
});
