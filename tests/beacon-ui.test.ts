import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CHANNELS} from '../src/integrations/catalog';
import {emptyState} from '../src/main/store';
import type {Account,Site,Snapshot,Task} from '../src/shared/types';
import {accountNextStep,accountReadiness,connectionAction} from '../src/ui/account-guidance';
import {connectionOverview,isBeaconConnectionAccount} from '../src/ui/channel-connections';
import {channelOnboardingView} from '../src/ui/channel-onboarding';
import {builtInAccessClass} from '../src/integrations/channel-access-class';
import {hasRemotePublicationIntent,hasUnresolvedExternalAttempt} from '../src/shared/publication';
import {channelReadinessForDisplay,taskHasSubmissionEvidence,taskHasUnconfirmedSubmission,taskNeedsTelegraphReconciliation} from '../src/ui/presentation';

const at='2026-10-24T01:00:00.000Z',email='owner@example.test';
const ready:Account={id:'00000000-0000-4000-8000-000000000001',channelId:'beacon',email,username:email,status:'registered',credentialKind:'api_token',hasPassword:true,createdAt:at,verifiedAt:at,beacon:{version:1,stage:'ready',emailHash:createHash('sha256').update(email).digest('hex'),apiKeyFingerprint:'a'.repeat(64),checkedAt:at}};
const channel=CHANNELS.find(value=>value.id==='beacon')!;
function row(account?:Account,enabled=true){
  const data={...emptyState(),channels:[{...channel,enabled}],accounts:account?[account]:[],sites:[],tasks:[],accountBindings:[]} as unknown as Snapshot;
  return connectionOverview(data).find(value=>value.id==='beacon')!;
}

test('Beacon email setup is not presented as anonymous, wallet, or a manual token import',()=>{
  assert.equal(builtInAccessClass(channel),'email_auto');
  assert.equal(channelOnboardingView(channel).kind,'ai_account');
  assert.equal(row().state,'first_connection');
  assert.match(row().detail,/Gmail.*收信邮箱.*到期任务自动收码/);
  assert.equal(connectionAction(row()).kind,'none');
  assert.equal(row(ready,false).state,'unavailable');
});

test('Beacon UI requires a verified account proof and site binding before saying reusable',()=>{
  assert.equal(isBeaconConnectionAccount(ready),true);
  assert.equal(row(ready).state,'connected');
  assert.deepEqual(accountReadiness(ready,1,true),{needsAttention:false,reusable:true});
  assert.deepEqual(accountReadiness(ready,0,true),{needsAttention:true,reusable:false});
  for(const broken of [{...ready,beacon:undefined},{...ready,hasPassword:false},{...ready,verifiedAt:undefined},{...ready,beacon:{...ready.beacon!,apiKeyFingerprint:''}}]){
    assert.equal(isBeaconConnectionAccount(broken),false);
    assert.equal(accountReadiness(broken,1,true).reusable,false);
    assert.equal(row(broken).state,'attention');
  }
});

test('Beacon pending and uncertain stages preserve original connection instead of suggesting signup again',()=>{
  for(const stage of ['send_intent','send_unknown','send_opaque','code_sent','verify_intent','verify_unknown','verify_opaque'] as const){
    const pending:Account={...ready,status:'needs_verification',hasPassword:false,verifiedAt:undefined,beacon:undefined,beaconEmail:{version:1,stage,emailHash:ready.beacon!.emailHash,requestedAt:at,siteId:'00000000-0000-4000-8000-000000000002',senderDomain:'mail.beacon.host'}};
    assert.equal(accountReadiness(pending,1,true).reusable,false);
    assert.match(accountNextStep(pending,1,true),stage==='code_sent'?/等待原邮箱验证/:/请勿重复注册|不会重复请求验证码/);
    assert.deepEqual(connectionAction(row(pending)),{kind:'locate',label:'查看保存的发布账号'});
  }
});

test('Beacon waits for the site-linked verified mailbox, then reuses one verified account',()=>{
  const site={id:'site',email,mailboxId:'mailbox'} as Site;
  const data={...emptyState(),channels:[channel],accounts:[],sites:[site],mailboxes:[{id:'mailbox',host:'imap.gmail.com',user:email,aliases:[],hasPassword:true,verifiedAt:at}],accountBindings:[]} as unknown as Snapshot;
  assert.equal(channelReadinessForDisplay(data,site,channel),'autocreate');
  assert.equal(channelReadinessForDisplay({...data,mailboxes:[]},site,channel),'handoff_required');
  assert.equal(channelReadinessForDisplay({...data,mailboxes:[{...data.mailboxes[0],lastError:'Authentication failed'}]},site,channel),'handoff_required');
  // The site's public contact address may differ; the explicitly linked mailbox owns the account.
  assert.equal(channelReadinessForDisplay(data,{...site,email:'public-contact@example.test'},channel),'autocreate');
  assert.equal(channelReadinessForDisplay(data,{...site,mailboxId:undefined},channel),'handoff_required');
  assert.equal(channelReadinessForDisplay({...data,accounts:[ready]},site,channel),'autocreate');
  assert.equal(channelReadinessForDisplay({...data,accounts:[{...ready,email:'other@example.test'}]},site,channel),'handoff_required');
});

test('Beacon restored publication evidence prevents new submission and offers bounded GET reconciliation',()=>{
  for(const stage of ['submitting','opaque_response','api_receipt','published'] as const){
    const task={id:'task',siteId:'site',channelId:'beacon',status:'review',beacon:{stage,publicUrl:'https://fixture.beacon.host/'},reconcileAttempts:0} as Task;
    assert.equal(hasRemotePublicationIntent(task),true);
    assert.equal(hasUnresolvedExternalAttempt(task),true);
    assert.equal(taskHasSubmissionEvidence(task),true);
    assert.equal(taskHasUnconfirmedSubmission(task),stage!=='published');
    assert.equal(taskNeedsTelegraphReconciliation({...task,submittedAt:at,publicUrl:task.beacon!.publicUrl}),stage!=='published');
    assert.equal(taskNeedsTelegraphReconciliation({...task,submittedAt:at,reconcileAttempts:3}),false);
    assert.equal(taskNeedsTelegraphReconciliation({...task,submittedAt:at,status:'skipped'}),false);
  }
});
