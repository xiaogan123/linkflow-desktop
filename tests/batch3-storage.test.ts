import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encryptBackup,decryptBackup} from '../src/main/backup';
import {validateBackup} from '../src/main/backup-validation';
import {emptyState,migrateState,Store,type State} from '../src/main/store';
import {buildArticleEvidenceSnapshot,buildChannelTermsCache} from '../src/main/article-evidence';
import {createWritingProfile,createWritingEnvelope} from '../src/shared/writing-profile';
import {decorateManagedDraft} from '../src/main/draft-contract';
import type {Task,Channel} from '../src/shared/types';

const siteId='22222222-2222-4222-8222-222222222222',taskId='11111111-1111-4111-8111-111111111111',stamp='2026-10-18T12:34:00.000Z';
function fixture(){
  const state=emptyState();
  const site={id:siteId,domain:'example.com',url:'https://example.com/',email:'editor@example.com',name:'Example',description:'Synthetic educational site',category:'content' as const,language:'zh',monthlyTarget:5,status:'ready' as const,createdAt:stamp,timezone:'Asia/Singapore',planStatus:{month:'2026-10',target:5,effectiveTarget:3,capacity:300,reasonCode:'platform_capacity' as const,message:'[placeholder]'}};
  const profile=createWritingProfile(site),envelope=createWritingEnvelope(profile,site,taskId,{topicUrl:'https://example.com/article',requireTopicLink:true});
  state.sites.push({...site,writingProfile:profile});
  const snapshot=buildArticleEvidenceSnapshot(site,{url:'https://example.com/article',text:'The waiting period is 30 days. These conditions apply only to the documented process.'},[{url:site.url,kind:'site',text:'Synthetic source material.'}],new Date(stamp));
  const cache=buildChannelTermsCache({id:'fixture-channel'},[{url:'https://example.com/rules',kind:'content_policy',text:'Educational financial content is allowed. Affiliate promotion is permitted with public disclosure.',appliesTo:'fixture-channel',applicability:'verified'}],undefined,new Date(stamp));
  state.channelTermsCache={'fixture-channel':cache};
  const review={status:'failed' as const,reason:'[placeholder]',reasonCode:'review_changes_requested' as const,reviewedAt:stamp,evidenceUrls:[site.url],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64),termsHash:cache.conclusionHash,patches:[{field:'body' as const,find:'30 days',replace:'a waiting period of 30 days'}]};
  const task:Task={id:taskId,siteId,accountId:undefined,channelId:'fixture-channel',sourceDomain:'example.com',status:'live',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,submittedAt:stamp,firstLiveAt:stamp,publicUrl:'https://example.com/published',attempts:1,message:'[placeholder]',draft:{title:'The waiting period',description:'Source-based explanation',body:'The waiting period is 30 days.'},draftRevision:1,cost:{aiCalls:3},history:[{at:stamp,status:'live',message:'[placeholder]'}],scheduling:{version:1,month:'2026-10',slot:0,target:5,effectiveTarget:3,reschedules:2,selectionAt:stamp,publicIdentity:'fixture-channel:site-a',nextPublishAt:stamp,attemptedAt:stamp},writingGenre:'tutorial',writingEnvelope:envelope,diversityRepairStage:2,evidenceSnapshot:snapshot,topicUrl:snapshot.topicUrl,factManifest:[{claim:'The waiting period is 30 days.',url:snapshot.topicUrl!,quote:'The waiting period is 30 days.'}],articleReview:review,articleAttempts:[{recordedAt:stamp,reason:'[placeholder]',draft:{title:'Old title',description:'Old summary',body:'Old body'},articleReview:review}]};
  state.tasks.push(task);
  return {state,secrets:{}};
}

test('batch three fields survive encrypted strict backup roundtrip and SQLite restart',()=>{
  const input=fixture();
  const restored=validateBackup(decryptBackup(encryptBackup(input,'synthetic-backup-passphrase'),'synthetic-backup-passphrase'));
  assert.deepEqual(restored,input);
  const folder=mkdtempSync(join(tmpdir(),'linkflow-batch3-')),path=join(folder,'state.sqlite');
  try{
    const store=new Store(path);try{store.restore(restored.state,{});assert.deepEqual(store.read(),input.state)}finally{store.close()}
    const reopened=new Store(path);try{assert.deepEqual(reopened.read(),input.state)}finally{reopened.close()}
  }finally{rmSync(folder,{recursive:true,force:true})}
});

test('a snapshot taken after a www or trailing-slash redirect still restores from backup',()=>{
  const input=fixture();
  input.state.tasks[0].topicUrl='https://www.example.com/article/';
  input.state.tasks[0].contentRepairAttempts=1;
  const restored=validateBackup(decryptBackup(encryptBackup(input,'synthetic-backup-passphrase'),'synthetic-backup-passphrase'));
  assert.equal(restored.state.tasks[0].evidenceSnapshot?.topicUrl,'https://example.com/article');
  assert.equal(restored.state.tasks[0].contentRepairAttempts,1);
  // Evidence for another topic is stale: the backup still restores, without that evidence.
  const moved=fixture();moved.state.tasks[0].topicUrl='https://example.com/other';
  const reopened=validateBackup(decryptBackup(encryptBackup(moved,'synthetic-backup-passphrase'),'synthetic-backup-passphrase'));
  assert.equal(reopened.state.tasks[0].evidenceSnapshot,undefined);assert.equal(reopened.state.tasks[0].factManifest,undefined);
});

test('native plain-text and HTML program envelopes survive strict backup restoration',()=>{
  for(const channelId of ['agenthow','raindrop','agentriot','txtsbs','berrry']){
    const input=fixture(),site=input.state.sites[0],task=input.state.tasks[0];
    task.channelId=channelId;task.topicUrl='https://example.com/article?a=1&b=2';task.writingEnvelope=undefined;
    task.status='queued';delete task.submittedAt;delete task.firstLiveAt;delete task.publicUrl;delete task.evidenceSnapshot;
    const managed=decorateManagedDraft({...task.draft!,body:channelId==='berrry'?'<!doctype html><html><body><p>Content</p></body></html>':'<p>Content</p>'},site,{id:channelId,articleRequired:true,languages:['*']} as Channel,task);
    task.draft=managed.draft;task.writingEnvelope=managed.envelope;
    task.draftHistory=[{at:stamp,draft:task.draft,writingEnvelope:managed.envelope}];
    const restored=validateBackup(decryptBackup(encryptBackup(input,'fixture-passphrase'),'fixture-passphrase')).state.tasks[0];
    assert.deepEqual(restored.writingEnvelope,task.writingEnvelope,channelId);assert.deepEqual(restored.draft,task.draft);assert.deepEqual(restored.draftHistory,task.draftHistory);
    if(channelId==='txtsbs'){
      task.writingEnvelope!.link=task.writingEnvelope!.link.replace('</a>','<script>bad()</script></a>');
      assert.throws(()=>validateBackup(input));
    }
  }
});

test('old backups retain drafts, attempts and history while profiles are created lazily',()=>{
  const input=fixture(),task=input.state.tasks[0];
  delete input.state.channelTermsCache;delete input.state.sites[0].writingProfile;delete input.state.sites[0].planStatus;delete input.state.sites[0].timezone;
  delete task.scheduling;delete task.writingGenre;delete task.writingEnvelope;delete task.diversityRepairStage;delete task.evidenceSnapshot;delete task.factManifest;
  delete task.articleReview?.patches;delete task.articleReview?.termsHash;
  for(const attempt of task.articleAttempts??[]){delete attempt.articleReview?.patches;delete attempt.articleReview?.termsHash}
  const expected=structuredClone(task),restored=validateBackup(input).state;
  assert.deepEqual(restored.tasks[0],expected);
  assert.equal(restored.sites[0].writingProfile,undefined);
  assert.deepEqual(restored.channelTermsCache,{});
  const existing=fixture().state,profileBefore=structuredClone(existing.sites[0].writingProfile);
  migrateState(existing);
  assert.deepEqual(existing.sites[0].writingProfile,profileBefore);
});

test('strict backup validation rejects malformed editorial, schedule, evidence and cache fields',()=>{
  const record=(value:unknown)=>value as Record<string,unknown>;
  const mutations:Array<[string,(state:State)=>void]>=[
    ['profile seed',state=>{record(state.sites[0].writingProfile).seed=-1}],
    ['profile fingerprint',state=>{record(state.sites[0].writingProfile).fingerprint='forged'}],
    ['profile unknown field',state=>{record(state.sites[0].writingProfile).unexpected=true}],
    ['profile variant count',state=>{record(state.sites[0].writingProfile?.variants).risks=[]}],
    ['timezone',state=>{state.sites[0].timezone='Invalid/Timezone'}],
    ['plan target',state=>{state.sites[0].planStatus!.effectiveTarget=6}],
    ['schedule retry bound',state=>{state.tasks[0].scheduling!.reschedules=3}],
    ['schedule target',state=>{state.tasks[0].scheduling!.effectiveTarget=6}],
    ['schedule month',state=>{state.tasks[0].scheduling!.month='2026-13'}],
    ['schedule unknown field',state=>{record(state.tasks[0].scheduling).solverState=true}],
    ['schedule attempted date',state=>{record(state.tasks[0].scheduling).attemptedAt='tomorrow'}],
    ['genre',state=>{record(state.tasks[0]).writingGenre='fictional_case'}],
    ['diversity stage',state=>{record(state.tasks[0]).diversityRepairStage=4}],
    ['envelope different link',state=>{state.tasks[0].writingEnvelope!.link='https://example.com/other'}],
    ['envelope referral target',state=>{state.tasks[0].writingEnvelope!.targetUrl='https://example.com/?ref=synthetic'}],
    ['snapshot hash',state=>{state.tasks[0].evidenceSnapshot!.contentHash='0'.repeat(64)}],
    ['snapshot truncation flag',state=>{state.tasks[0].evidenceSnapshot!.sources[0].truncated=true}],
    ['snapshot source size',state=>{state.tasks[0].evidenceSnapshot!.sources[0].sourceCharacters=1}],
    ['fact count',state=>{state.tasks[0].factManifest=Array(81).fill(state.tasks[0].factManifest![0])}],
    ['fact unknown field',state=>{record(state.tasks[0].factManifest![0]).invented=true}],
    ['patch count',state=>{state.tasks[0].articleReview!.patches=Array(13).fill(state.tasks[0].articleReview!.patches![0])}],
    ['patch field',state=>{record(state.tasks[0].articleReview!.patches![0]).field='draft'}],
    ['review terms hash',state=>{state.tasks[0].articleReview!.termsHash='not-a-hash'}],
    ['terms source hash',state=>{state.channelTermsCache!['fixture-channel'].sourceHash='f'.repeat(64)}],
    ['terms conclusion hash',state=>{state.channelTermsCache!['fixture-channel'].conclusionHash='f'.repeat(64)}],
    ['terms summary size',state=>{state.channelTermsCache!['fixture-channel'].summary='x'.repeat(601)}],
    ['terms cache key',state=>{state.channelTermsCache!['wrong-channel']=state.channelTermsCache!['fixture-channel']}],
  ];
  for(const [label,mutate] of mutations){const input=fixture();mutate(input.state);assert.throws(()=>validateBackup(input),label)}
});
