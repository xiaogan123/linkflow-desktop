import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {decryptBackup,encryptBackup} from '../src/main/backup';
import {validateBackup} from '../src/main/backup-validation';
import {beaconTaskIdentity} from '../src/main/beacon-publication';
import {emptyState} from '../src/main/store';
import type {Account,Site,Task} from '../src/shared/types';

const at='2026-10-24T08:00:00.000Z',sentAt=at,expiresAt='2026-10-24T08:10:00.000Z',verifiedAt='2026-10-24T08:02:00.000Z';
const siteId='11111111-1111-4111-8111-111111111111',accountId='22222222-2222-4222-8222-222222222222',taskId='33333333-3333-4333-8333-333333333333',bindingId='44444444-4444-4444-8444-444444444444';
const email='beacon-fixture@example.test',apiKey=`chk_fixture_${'a'.repeat(32)}`,remoteId='fixture-remote-owner',target='https://example.com/release';
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
type BackupFixture={state:ReturnType<typeof emptyState>;secrets:Record<string,string>};
const site:Site={id:siteId,domain:'example.com',url:'https://example.com/',email:'editor@example.test',name:'Fixture',description:'Synthetic backup fixture.',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:at,topics:[{url:target,discoveredAt:at}]};
const sendIntent={kind:'send_otp' as const,operationId:`beacon_${sha(`send:${accountId}`).slice(0,32)}`,email,requestHash:sha(JSON.stringify({email})),createdAt:at};
const sendBytes=Buffer.from('s'.repeat(20_000)),sendOpaque={version:1 as const,kind:'beacon_opaque_response' as const,stage:'send_otp' as const,operationId:sendIntent.operationId,requestHash:sendIntent.requestHash,status:200,contentType:'application/json',responseUrl:'https://api.beacon.host/v1/auth/send-otp',redirected:false,responseType:'basic',bodyBase64:sendBytes.toString('base64'),bodySha256:sha(sendBytes),recordedAt:at};
const sendReceipt={...sendIntent,sentAt,cooldownUntil:'2026-10-24T08:01:00.000Z',expiresAt};
const codeHash=sha('000000'),verifyIntent={kind:'verify_otp' as const,operationId:`beacon_${sha(`verify:${accountId}`).slice(0,32)}`,email,codeHash,requestHash:sha(JSON.stringify({email,codeHash})),createdAt:verifiedAt};
const verifyBytes=Buffer.from(JSON.stringify({apiKey,accountId:remoteId,email})),verifyOpaque={version:1 as const,kind:'beacon_opaque_response' as const,stage:'verify_otp' as const,operationId:verifyIntent.operationId,requestHash:verifyIntent.requestHash,status:200,contentType:'application/json',responseUrl:'https://api.beacon.host/v1/auth/verify-otp',redirected:false,responseType:'basic',bodyBase64:verifyBytes.toString('base64'),bodySha256:sha(verifyBytes),recordedAt:verifiedAt};
const verifyReceipt={...verifyIntent,apiKeySha256:sha(apiKey),accountId:remoteId,accountEmail:email};
const emailJournal=(ready:boolean)=>JSON.stringify({version:1,kind:'beacon_email',accountId,email,siteId,createdAt:at,send:{intent:sendIntent,opaque:sendOpaque,receipt:sendReceipt},...(ready?{verify:{intent:verifyIntent,opaque:verifyOpaque,receipt:verifyReceipt}}:{})});

function pendingBackup():BackupFixture{
  const state=emptyState();state.sites=[site];
  const account:Account={id:accountId,channelId:'beacon',email,username:email,credentialKind:'api_token',status:'needs_verification',hasPassword:false,source:'imported',createdAt:at,updatedAt:at,beaconEmail:{version:1,stage:'code_sent',emailHash:sha(email),requestedAt:at,expiresAt,siteId,senderDomain:'mail.beacon.host'}};
  const task:Task={id:taskId,siteId,channelId:'beacon',accountId,sourceDomain:'beacon.host',status:'needs_input',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'waiting',checkpoint:'waiting_email',emailWaitRegisteredAt:at,emailWait:{kind:'code',recipient:email,since:at,nextPollAt:'2026-10-24T08:00:45.000Z',expiresAt,consumedMessageIds:[],continuation:'beacon'}};
  state.accounts=[account];state.tasks=[task];return {state,secrets:{[`beacon-email:${accountId}`]:emailJournal(false)}};
}

function readyBackup(emailStage:'ready'|'verify_opaque'='ready'):BackupFixture{
  const state=emptyState();state.sites=[site];
  const proof={version:1 as const,stage:'ready' as const,emailHash:sha(email),apiKeyFingerprint:sha(apiKey),remoteAccountIdHash:sha(remoteId),checkedAt:verifiedAt};
  const account:Account={id:accountId,channelId:'beacon',email,username:remoteId,credentialKind:'api_token',status:'registered',hasPassword:true,source:'imported',createdAt:at,updatedAt:verifiedAt,registeredAt:at,verifiedAt,beacon:proof,beaconEmail:{version:1,stage:emailStage,emailHash:sha(email),requestedAt:at,expiresAt,siteId,senderDomain:'mail.beacon.host',...(emailStage==='ready'?{apiKeyFingerprint:sha(apiKey),verifiedAt}:{})}};
  const draft={title:'Recover a timed-out submission safely',description:'A bounded recovery walkthrough.',body:`Keep one durable intent before a remote write, then recover only through bounded reads.\n\nSee the [release notes](${target}) for the tested behavior.`};
  const task:Task={id:taskId,siteId,channelId:'beacon',accountId,sourceDomain:'beacon.host',status:'review',createdAt:at,scheduledAt:at,updatedAt:at,attempts:1,message:'intent saved',draft,draftRevision:1,topicUrl:target,submittedAt:verifiedAt,health:'pending',checkpoint:'beacon_submitting',articleReview:{status:'passed',reason:'Synthetic review.',reasonCode:'passed',reviewContractVersion:2,bindingVersion:2,bindingHash:'1'.repeat(64),targetUrl:target,termsHash:'2'.repeat(64),checks:{factualAccuracy:'pass',authorRelationship:'pass',affiliateDisclosure:'pass',independentValue:'pass',financialSafety:'pass',channelRules:'pass'},reviewedAt:verifiedAt,evidenceUrls:[target],draftRevision:1,contentHash:'3'.repeat(64),contextHash:'1'.repeat(64)}};
  const slug=`beacon-${taskId.replace(/-/g,'').slice(0,16)}`,identity=beaconTaskIdentity(task,site,slug)!;
  const intent={kind:'publish' as const,operationId:`beacon_${taskId.replace(/-/g,'')}`,slug,publicUrl:`https://${slug}.beacon.host/`,sourceHash:identity.article.sourceHash,markdownHash:sha(draft.body),targetUrlHash:sha(target),requestHash:identity.article.requestHash,apiKeyHash:sha(apiKey),createdAt:verifiedAt};
  task.beacon={kind:'publish',operationId:intent.operationId,slug,publicUrl:intent.publicUrl,sourceHash:intent.sourceHash,markdownHash:intent.markdownHash,targetUrlHash:intent.targetUrlHash,requestHash:intent.requestHash,createdAt:intent.createdAt,accountId,stage:'submitting'};
  state.accounts=[account];state.tasks=[task];state.accountBindings=[{id:bindingId,siteId,channelId:'beacon',accountId,createdAt:verifiedAt,updatedAt:verifiedAt}];
  const ownerHash=sha(JSON.stringify({accountId,emailHash:proof.emailHash,apiKeyFingerprint:proof.apiKeyFingerprint,remoteAccountIdHash:proof.remoteAccountIdHash,checkedAt:proof.checkedAt,bindingId,siteId}));
  const publication={version:1,kind:'beacon_publication',binding:{version:1,taskId,siteId,accountId,slug,draftRevision:1,reviewHash:sha(JSON.stringify(task.articleReview)),targetUrlHash:sha(target),ownerHash,sourceHash:intent.sourceHash,requestHash:intent.requestHash},intent};
  const accountSecret={version:1,kind:'beacon_account',accountId,email,apiKey,apiKeySha256:sha(apiKey),remoteAccountId:remoteId,verifiedAt};
  return {state,secrets:{[`beacon-email:${accountId}`]:emailJournal(true),[`account:${accountId}`]:JSON.stringify(accountSecret),[`publication:${taskId}`]:JSON.stringify(publication)}};
}

test('Beacon pending and ready publication states survive strict authenticated backup roundtrips without dropping recovery fields',()=>{
  for(const original of [pendingBackup(),readyBackup(),readyBackup('verify_opaque')]){
    const restored=validateBackup(decryptBackup(encryptBackup(original,'beacon-backup-passphrase'),'beacon-backup-passphrase'));
    assert.deepEqual(JSON.parse(JSON.stringify(restored)),JSON.parse(JSON.stringify(original)));assert.ok(restored.secrets[`beacon-email:${accountId}`].length>16_384);
    if(original.state.tasks[0].beacon)assert.equal(JSON.stringify(restored.state.tasks[0].articleReview),JSON.stringify(original.state.tasks[0].articleReview));
  }
});

test('Beacon restore rejects missing, cross-wired, tampered, and orphaned account/email/publication secrets',()=>{
  const base=readyBackup();
  for(const key of [`beacon-email:${accountId}`,`account:${accountId}`,`publication:${taskId}`]){const broken=structuredClone(base);delete broken.secrets[key];assert.throws(()=>validateBackup(broken),/Beacon|登录信息/)}
  const wrongAccount=structuredClone(base),accountSecret=JSON.parse(wrongAccount.secrets[`account:${accountId}`]);accountSecret.accountId='55555555-5555-4555-8555-555555555555';wrongAccount.secrets[`account:${accountId}`]=JSON.stringify(accountSecret);assert.throws(()=>validateBackup(wrongAccount),/Beacon/);
  const wrongPublication=structuredClone(base),publication=JSON.parse(wrongPublication.secrets[`publication:${taskId}`]);publication.binding.ownerHash='0'.repeat(64);wrongPublication.secrets[`publication:${taskId}`]=JSON.stringify(publication);assert.throws(()=>validateBackup(wrongPublication),/Beacon/);
  const changedBody=structuredClone(base);changedBody.state.tasks[0].draft!.body+=' changed after review';assert.throws(()=>validateBackup(changedBody),/Beacon/);
  const unsafeReceipt=structuredClone(base);(unsafeReceipt.state.tasks[0].beacon as any).apiKeyHash=sha(apiKey);assert.throws(()=>validateBackup(unsafeReceipt));
  const orphan=structuredClone(base);orphan.secrets['beacon-email:66666666-6666-4666-8666-666666666666']=orphan.secrets[`beacon-email:${accountId}`];assert.throws(()=>validateBackup(orphan),/Beacon|归属|加密信息/);
});

test('Beacon pending wait and journal ownership cannot be detached or silently normalized',()=>{
  const base=pendingBackup(),wrongRecipient=structuredClone(base);wrongRecipient.state.tasks[0].emailWait!.recipient='other@example.test';assert.throws(()=>validateBackup(wrongRecipient));
  const wrongContinuation=structuredClone(base);wrongContinuation.state.tasks[0].emailWait!.continuation='signup';assert.throws(()=>validateBackup(wrongContinuation));
  const tampered=structuredClone(base),journal=JSON.parse(tampered.secrets[`beacon-email:${accountId}`]);journal.send.opaque.bodyBase64=Buffer.from('changed').toString('base64');tampered.secrets[`beacon-email:${accountId}`]=JSON.stringify(journal);assert.throws(()=>validateBackup(tampered),/Beacon/);
});
