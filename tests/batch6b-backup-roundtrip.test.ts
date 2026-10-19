import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {validateBackup} from '../src/main/backup-validation';
import {decryptBackup, encryptBackup} from '../src/main/backup';
import {maintainWaitingTasks} from '../src/main/task-recovery';
import {applySiteUpdate} from '../src/main/site-service';
import {Controller} from '../src/main/controller';
import {activateSiteOriginRecoveryGrant, applySiteOriginMigration} from '../src/main/site-origin-migration';
import {createHumanAction} from '../src/shared/human-action';
import {CHANNELS} from '../src/integrations/catalog';
import type {Channel, Site, Task} from '../src/shared/types';

const at='2026-10-18T00:00:00.000Z';
const later=new Date('2026-10-21T00:00:00.000Z');
const siteId='11111111-1111-4111-8111-111111111111';
const taskId='22222222-2222-4222-8222-222222222222';
const channel:Channel={...CHANNELS[0],automation:'manual',enabled:true};
const site:Site={id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Fixture site',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:at,articleReviewMode:'ai'};

function task(partial:Partial<Task>):Task{
  return {id:taskId,siteId,channelId:channel.id,sourceDomain:channel.domain,status:'needs_input',createdAt:at,updatedAt:at,scheduledAt:at,attempts:0,message:'Fixture',...partial};
}

function withStores(run:(source:Store)=>void):void{
  const source=new Store(':memory:');
  try{
    source.update(state=>{
      state.settings.articleReviewMode='ai';
      state.sites=[structuredClone(site)];
    });
    run(source);
  }finally{source.close()}
}

function exportValidateRestore(source:Store):Task{
  const exported={state:source.read(),secrets:source.allCiphers()};
  const passphrase='batch6b-synthetic-roundtrip-passphrase';
  const validated=validateBackup(decryptBackup(encryptBackup(exported,passphrase),passphrase));
  const restored=new Store(':memory:');
  try{
    restored.restore(validated.state,validated.secrets);
    return restored.read().tasks[0];
  }finally{restored.close()}
}

test('Store backup roundtrip retires an unsent referral guard without cooldown',()=>withStores(source=>{
  source.update(state=>state.tasks.push(task({checkpoint:'referral_guard',reasonCode:'referral_blocked'})));
  source.update(state=>{maintainWaitingTasks(state.tasks,state.sites,[channel],state.settings,later)});
  const saved=source.read().tasks[0],restored=exportValidateRestore(source);
  for(const value of [saved,restored]){
    assert.equal(value.status,'failed');assert.equal(value.reasonCode,'referral_blocked');
    assert.equal(value.humanAction,undefined);assert.equal(value.waitingDeadlineAt,undefined);
    assert.equal(value.cooldownUntil,undefined);
  }
}));

test('Store backup roundtrip skips an ineligible channel without a human stop',()=>withStores(source=>{
  source.update(state=>state.tasks.push(task({checkpoint:'eligibility_wait',reasonCode:'channel_ineligible'})));
  source.update(state=>{maintainWaitingTasks(state.tasks,state.sites,[channel],state.settings,later)});
  const saved=source.read().tasks[0],restored=exportValidateRestore(source);
  for(const value of [saved,restored]){
    assert.equal(value.status,'skipped');assert.equal(value.reasonCode,'channel_ineligible');
    assert.equal(value.humanAction,undefined);assert.equal(value.waitingDeadlineAt,undefined);
  }
}));

test('Store backup roundtrip converts failed article review to a valid manual action',()=>withStores(source=>{
  source.update(state=>state.tasks.push(task({status:'failed',checkpoint:'article_review',reasonCode:'content_rejected',draft:{title:'Example',description:'Fixture',body:'Original draft'}})));
  source.update(state=>{applySiteUpdate(state,{id:siteId,articleReviewMode:'manual'},new Date(at))});
  const saved=source.read().tasks[0],restored=exportValidateRestore(source);
  for(const value of [saved,restored]){
    assert.equal(value.status,'needs_input');assert.equal(value.reasonCode,'manual_review');
    assert.equal(value.humanAction?.since,at);assert.equal(value.humanAction?.deadline,'2026-10-20T00:00:00.000Z');
    assert.equal(value.draft?.body,'Original draft');
  }
}));

test('Store backup roundtrip clears a forced-failed migration recovery action',()=>withStores(source=>{
  const oldRoot='https://old.example.com',newRoot='https://new.example.com';
  source.update(state=>{
    Object.assign(state.sites[0],{domain:'old.example.com',url:oldRoot,status:'paused'});
    state.tasks.push(task({status:'failed',reasonCode:'invalid_topic',checkpoint:'invalid_topic',topicUrl:oldRoot+'/guide',attempts:3}));
  });
  source.update(state=>{
    applySiteOriginMigration(state,{siteId,expectedDomain:'old.example.com',expectedUrl:oldRoot,newUrl:newRoot,operatorAuthorized:true,recoveryTaskId:taskId,resumeStatus:'ready'},new Date(at));
    activateSiteOriginRecoveryGrant(state,siteId,taskId,new Date('2026-10-18T00:01:00.000Z'));
    state.tasks[0].attempts=4;
  });
  const controller=new Controller(source,{ready:true,available:()=>true} as never,'fixture');
  try{
    const current=source.read().tasks[0];
    controller.patch(taskId,{status:'needs_input',reasonCode:'human_required',humanAction:createHumanAction(current,{kind:'other'},new Date(at))});
    const saved=source.read().tasks[0],restored=exportValidateRestore(source);
    for(const value of [saved,restored]){
      assert.equal(value.status,'failed');assert.equal(value.checkpoint,'site_origin_migration_recovery_consumed');
      assert.equal(value.humanAction,undefined);assert.equal(value.waitingSince,undefined);
    }
  }finally{controller.stop()}
}));

test('Store encrypted backup roundtrip preserves a pending email confirmation and its secret binding',()=>withStores(source=>{
  const accountId='33333333-3333-4333-8333-333333333333',mailboxId='44444444-4444-4444-8444-444444444444';
  const wait:NonNullable<Task['emailWait']>={kind:'code',recipient:'owner@example.com',since:at,nextPollAt:'2026-10-18T00:00:45.000Z',expiresAt:'2026-10-18T00:10:00.000Z',mailboxId,consumedMessageIds:['confirmation-message'],continuation:'browser'};
  const current=task({channelId:'fixture-channel',accountId,checkpoint:'email_confirmation',reasonCode:'human_required',emailConfirmation:{wait,messageId:'confirmation-message'}});
  current.humanAction=createHumanAction(current,{kind:'email_confirmation',expiresAt:wait.expiresAt},new Date(at));
  current.waitingSince=current.humanAction.since;current.waitingDeadlineAt=current.humanAction.deadline;
  source.update(state=>{
    state.accounts=[{id:accountId,channelId:current.channelId,email:site.email,username:'fixture',status:'draft',hasPassword:false,mailboxId,createdAt:at}];
    state.mailboxes=[{id:mailboxId,label:'Fixture',host:'imap.example.com',port:993,user:site.email,secure:true,hasPassword:true,aliases:[],createdAt:at,updatedAt:at,verifiedAt:at}];
    state.emailConsumptions=[{channelId:current.channelId,recipient:wait.recipient,messageIds:['confirmation-message']}];
    state.tasks=[current];
  });
  source.setCipher(`mailbox:${mailboxId}`,'fixture-password');
  source.setCipher(`signup:${taskId}:email`,JSON.stringify({kind:'code',value:'834792',recipient:wait.recipient,expiresAt:wait.expiresAt}));
  const restored=exportValidateRestore(source);
  assert.deepEqual(restored.emailConfirmation,current.emailConfirmation);assert.equal(restored.humanAction?.kind,'email_confirmation');
  assert.equal(restored.emailWait,undefined);assert.equal(JSON.stringify(restored).includes('834792'),false);
}));
