import test from 'node:test';
import assert from 'node:assert/strict';
import {Store,emptyState} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {validateBackup} from '../src/main/backup-validation';
import {activateSiteOriginRecoveryGrant,applySiteOriginMigration,consumeSiteOriginRecoveryGrant,hasActiveSiteOriginRecoveryGrant,migrationAwareTopicKey,siteContextForTask} from '../src/main/site-origin-migration';
import {nextTask,recoverInterrupted} from '../src/main/planner';
import {maintainWaitingTasks} from '../src/main/task-recovery';
import {publicationOpportunity} from '../src/shared/publication';
import type {Channel,Site,Task} from '../src/shared/types';

const siteId='11111111-1111-4111-8111-111111111111',telegraphId='22222222-2222-4222-8222-222222222222',recoveryId='33333333-3333-4333-8333-333333333333',failedId='44444444-4444-4444-8444-444444444444',futureId='55555555-5555-4555-8555-555555555555',bindingId='66666666-6666-4666-8666-666666666666',accountId='77777777-7777-4777-8777-777777777777';
const oldRoot='https://old.example.com',newRoot='https://new.example.com',at='2026-10-17T04:00:00.000Z';
const site:Site={id:siteId,domain:'old.example.com',url:oldRoot,email:'owner@example.com',name:'Synthetic Guides',description:'Independent synthetic guides',category:'content',language:'en',monthlyTarget:2,status:'paused',createdAt:'2026-09-01T00:00:00.000Z',topicsCheckedAt:'2026-10-16T00:00:00.000Z',topics:[{url:oldRoot+'/guides/old-topic',discoveredAt:'2026-10-01T00:00:00.000Z'}],searchReports:{gsc:{checkedAt:'2026-10-16T00:00:00.000Z',method:'api',sources:[oldRoot+'/'],complete:true,message:'synthetic old-origin report'}}};
const base=(id:string,channelId:string,status:Task['status'],topicUrl?:string):Task=>({id,siteId,channelId,sourceDomain:channelId==='telegraph'?'telegra.ph':'synthetic.example.net',status,createdAt:'2026-10-01T00:00:00.000Z',scheduledAt:'2026-10-16T00:00:00.000Z',updatedAt:'2026-10-16T00:00:00.000Z',attempts:0,message:'synthetic fixture',...(topicUrl?{topicUrl}:{})});
const telegraph:Task={...base(telegraphId,'telegraph','live',oldRoot+'/guides/published'),submittedAt:'2026-10-05T00:00:00.000Z',publicUrl:'https://telegra.ph/synthetic-guide-10-05',firstLiveAt:'2026-10-05T00:01:00.000Z',verifiedAt:'2026-10-05T00:02:00.000Z',lastCheckedAt:'2026-10-16T00:00:00.000Z',nextCheckAt:'2026-10-23T00:00:00.000Z',health:'healthy',linkCheck:'found',linkRel:'',publicationMethod:'client',consecutiveMissing:0};
const archivedDraft={title:'Old source draft',description:'Synthetic archived description',body:'Archived synthetic body with [source](https://old.example.com/guides/recover).'};
const oldReview={status:'failed' as const,reason:'Synthetic source moved',reasonCode:'invalid_topic' as const,reviewedAt:'2026-10-16T00:00:00.000Z',evidenceUrls:[oldRoot+'/guides/recover'],draftRevision:2,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)};
const recovery:Task={...base(recoveryId,'nostr','failed',oldRoot+'/guides/recover'),attempts:3,cost:{aiCalls:2,amount:0.1,currency:'USD'},topicSwitchAttempts:1,articleAttempts:[{topicUrl:oldRoot+'/guides/original',recordedAt:'2026-10-15T00:00:00.000Z',reason:'Synthetic archived attempt',draft:{title:'Archived attempt',description:'Archived',body:'Archived body'},draftRevision:1}],draft:archivedDraft,draftRevision:2,articleRepairAttempts:1,draftUpdatedAt:'2026-10-16T00:00:00.000Z',articleReview:oldReview,articleApprovedAt:'2026-10-16T00:00:00.000Z',checkpoint:'invalid_topic'};
const failed:Task={...base(failedId,'betterthanhtml','failed',oldRoot+'/guides/failed'),attempts:2,cost:{aiCalls:6},checkpoint:'article_rejected'};
const future:Task={...base(futureId,'supanote','queued',oldRoot+'/guides/future'),scheduledAt:'2026-10-24T00:00:00.000Z'};
const automaticChannel=(id:string):Channel=>({id,name:id,domain:`${id}.example.net`,url:`https://${id}.example.net`,submitUrl:`https://${id}.example.net/new`,categories:['general'],languages:['en'],kind:'article',contentFormat:'social',emailRequired:false,accountRequired:false,articleRequired:true,free:'yes',freeNote:'synthetic',automation:'api',quality:'A',qualityReason:'synthetic',rulesUrl:`https://${id}.example.net/rules`,checkedAt:'2026-10-17',notes:'synthetic',allowedHosts:[`${id}.example.net`],enabled:true,provenance:'built-in'});

function fixture(){const store=new Store(':memory:');store.update(state=>{state.sites=[structuredClone(site)];state.tasks=[structuredClone(telegraph),structuredClone(recovery),structuredClone(failed),structuredClone(future)];state.accounts=[{id:accountId,channelId:'synthetic-binding',email:'owner@example.com',username:'synthetic-account',createdAt:at,status:'unknown',hasPassword:false,source:'imported'}];state.accountBindings=[{id:bindingId,siteId,channelId:'synthetic-binding',accountId,createdAt:at,updatedAt:at}]});return store}
function originState(){const state=emptyState();state.sites=[structuredClone(site)];return state}
function batch5RegistrationTask(stage:NonNullable<Task['batch5Registration']>['stage'],channelId:'rant'|'slopit'='rant'):Task{return {...base('88888888-8888-4888-8888-888888888888',channelId,'queued',oldRoot+'/guides/registered'),sourceDomain:channelId==='rant'?'rant.li':'slop.it',batch5Registration:{version:1,channelId,operationId:`${channelId}:register:${siteId}`,createdAt:'2026-10-16T00:00:00.000Z',stage}}}
function bindLegacyBatch5Account(state:ReturnType<typeof emptyState>,channelId:'rant'|'slopit',task?:Task){state.accounts=[{id:accountId,channelId,email:'owner@example.com',username:'synthetic-account',createdAt:at,status:'unknown',hasPassword:true,source:'generated',credentialKind:'api_token',registrationAttempts:1}];state.accountBindings=[{id:bindingId,siteId,channelId,accountId,createdAt:at,updatedAt:at}];if(task){task.accountId=accountId;state.tasks=[task]}}

test('finite site-origin migration preserves identity, history, budgets and bindings while refreshing only safe current views',()=>{
  const store=fixture();try{
    store.update(state=>{applySiteOriginMigration(state,{siteId,expectedDomain:'old.example.com',expectedUrl:oldRoot,newUrl:newRoot,operatorAuthorized:true,recoveryTaskId:recoveryId,resumeStatus:'ready'},new Date(at))});
    const state=store.read(),saved=state.sites[0],record=state.siteOriginMigrations![0],restored=state.tasks.find(task=>task.id===recoveryId)!,untouched=state.tasks.find(task=>task.id===failedId)!,pristine=state.tasks.find(task=>task.id===futureId)!;
    assert.deepEqual({id:saved.id,domain:saved.domain,url:saved.url,status:saved.status,monthlyTarget:saved.monthlyTarget},{id:siteId,domain:'new.example.com',url:newRoot,status:'ready',monthlyTarget:2});
    assert.equal(saved.topics,undefined);assert.equal(saved.topicsCheckedAt,undefined);assert.equal(saved.searchReports,undefined);
    assert.equal(record.before.searchReports?.gsc?.sources[0],oldRoot+'/');assert.equal(record.before.topics?.[0].url,oldRoot+'/guides/old-topic');
    assert.equal(record.telegraphTasks[0].taskId,telegraphId);assert.equal(siteContextForTask(state,telegraph)?.url,oldRoot);assert.equal(siteContextForTask(state,telegraph)?.name,site.name);
    assert.equal(state.tasks.find(task=>task.id===telegraphId)?.firstLiveAt,telegraph.firstLiveAt);
    assert.deepEqual(state.accountBindings,[{id:bindingId,siteId,channelId:'synthetic-binding',accountId,createdAt:at,updatedAt:at}]);
    assert.equal(restored.topicUrl,newRoot+'/guides/recover');assert.equal(restored.attempts,3);assert.deepEqual(restored.cost,recovery.cost);assert.equal(restored.topicSwitchAttempts,1);assert.deepEqual(restored.articleAttempts,recovery.articleAttempts);assert.equal(restored.articleRepairAttempts,1);assert.equal(restored.draft,undefined);assert.equal(restored.articleReview,undefined);assert.equal(restored.articleApprovedAt,undefined);assert.equal(restored.checkpoint,'site_origin_migration_recovery');
    assert.deepEqual(record.recovery?.before.draft,archivedDraft);assert.deepEqual(record.recovery?.before.articleReview,oldReview);assert.equal(record.recovery?.before.attempts,3);
    assert.deepEqual(untouched,failed);assert.equal(pristine.topicUrl,newRoot+'/guides/future');assert.equal(pristine.status,'queued');assert.equal(pristine.attempts,0);
    assert.equal(migrationAwareTopicKey(state,siteId,oldRoot+'/guides/published'),migrationAwareTopicKey(state,siteId,newRoot+'/guides/published'));
    saved.topics=[{url:newRoot+'/guides/published',discoveredAt:at},{url:newRoot+'/guides/fresh',discoveredAt:at}];
    const channel={...automaticChannel('telegraph'),domain:'telegra.ph',allowedHosts:['telegra.ph']};
    const context={officialApiConnected:true,topicKey:(value:string|undefined)=>migrationAwareTopicKey(state,siteId,value)};
    const waiting=publicationOpportunity(saved,channel,state.tasks,new Date(at),'UTC',context);
    assert.equal(waiting.allowed,false);assert.equal(waiting.blockingReason,'cadence_wait');
    assert.equal(waiting.nextAvailableAt,new Date(Date.parse(telegraph.firstLiveAt!)+30*86400000).toISOString());
    const opportunity=publicationOpportunity(saved,channel,state.tasks,new Date('2026-11-04T12:11:00.000Z'),'UTC',context);
    assert.equal(opportunity.allowed,true);assert.equal(opportunity.topicUrl,newRoot+'/guides/fresh');
    assert.equal(state.tasks.find(task=>task.id===telegraphId)?.publicUrl,telegraph.publicUrl);
    assert.equal(state.tasks.filter(task=>task.channelId==='telegraph').length,1);
  }finally{store.close()}
});

test('migration rejects foreign external receipts and stale or unsafe origins',()=>{
  for(const mutate of [
    (state:ReturnType<Store['read']>)=>{state.tasks.push({...base('88888888-8888-4888-8888-888888888888','lucid-page','review'),submittedAt:at})},
    (state:ReturnType<Store['read']>)=>{state.sites[0].url='https://changed.example.com'},
  ]){const store=fixture();try{assert.throws(()=>store.update(state=>{mutate(state);applySiteOriginMigration(state,{siteId,expectedDomain:'old.example.com',expectedUrl:oldRoot,newUrl:newRoot,operatorAuthorized:true},new Date(at))}))}finally{store.close()}}
  const store=fixture();try{assert.throws(()=>store.update(state=>{applySiteOriginMigration(state,{siteId,expectedDomain:'old.example.com',expectedUrl:oldRoot,newUrl:'https://127.0.0.1',operatorAuthorized:true},new Date(at))}),/公开|真实|Private|reserved/)}finally{store.close()}
});

test('migration preview preserves durable Rant and SlopIt registration identities before a first article',()=>{
  for(const channelId of ['rant','slopit'] as const)for(const stage of ['registered','reserved','request_unknown'] as const){
      const state=originState();state.tasks=[batch5RegistrationTask(stage,channelId)];
      assert.throws(()=>applySiteOriginMigration(state,{siteId,expectedDomain:'old.example.com',expectedUrl:oldRoot,newUrl:newRoot,operatorAuthorized:true},new Date(at)),/Rant.*SlopIt.*注册/);
      assert.equal(state.sites[0].url,oldRoot);
      assert.equal(state.siteOriginMigrations?.length??0,0);
    }
});

test('migration preview preserves a legacy generated Batch 5 account unless durable evidence proves no request was sent or accepted',()=>{
  for(const channelId of ['rant','slopit'] as const){
    const state=originState();bindLegacyBatch5Account(state,channelId);
    assert.throws(()=>applySiteOriginMigration(state,{siteId,expectedDomain:'old.example.com',expectedUrl:oldRoot,newUrl:newRoot,operatorAuthorized:true},new Date(at)),/避免旧来源重复注册/);
  }
  for(const [stage,channelId] of [['rejected','rant'],['not_sent','slopit']] as const){
    const state=originState(),task=batch5RegistrationTask(stage,channelId);bindLegacyBatch5Account(state,channelId,task);
    const record=applySiteOriginMigration(state,{siteId,expectedDomain:'old.example.com',expectedUrl:oldRoot,newUrl:newRoot,operatorAuthorized:true},new Date(at));
    assert.equal(record.after.url,newRoot,stage);
    assert.equal(state.sites[0].url,newRoot,stage);
  }
});

test('store makes the migration archive immutable and recovery grant single-use with exact context',()=>{
  const store=fixture();try{
    store.update(state=>{applySiteOriginMigration(state,{siteId,expectedDomain:'old.example.com',expectedUrl:oldRoot,newUrl:newRoot,operatorAuthorized:true,recoveryTaskId:recoveryId},new Date(at))});
    assert.throws(()=>store.update(state=>{state.siteOriginMigrations![0].before.name='rewritten'}),/不能删除或改写|快照/);
    assert.throws(()=>store.update(state=>{state.tasks.find(task=>task.id===recoveryId)!.attempts=0}),/不能清零|上下文/);
    store.update(state=>consumeSiteOriginRecoveryGrant(state,siteId,recoveryId,new Date('2026-10-17T04:01:00.000Z')));
    assert.equal(store.read().siteOriginMigrations![0].recovery?.consumedAt,'2026-10-17T04:01:00.000Z');
    store.update(state=>{const task=state.tasks.find(value=>value.id===futureId)!;task.status='review';task.submittedAt='2026-10-24T00:01:00.000Z';task.checkpoint='synthetic_submitting'});
    assert.equal(store.read().tasks.find(value=>value.id===futureId)?.submittedAt,'2026-10-24T00:01:00.000Z');
    assert.throws(()=>store.update(state=>consumeSiteOriginRecoveryGrant(state,siteId,recoveryId,new Date('2026-10-17T04:02:00.000Z'))),/没有可用/);
    assert.throws(()=>store.update(state=>{delete state.siteOriginMigrations![0].recovery!.consumedAt}),/不能回退|不能删除或改写/);
  }finally{store.close()}
});

test('operator migration recovery queues the same task once without resetting prior work',()=>{
  const store=fixture();try{
    store.update(state=>{state.settings.autoRun=true;applySiteOriginMigration(state,{siteId,expectedDomain:'old.example.com',expectedUrl:oldRoot,newUrl:newRoot,operatorAuthorized:true,recoveryTaskId:recoveryId,resumeStatus:'ready'},new Date(at));activateSiteOriginRecoveryGrant(state,siteId,recoveryId,new Date('2026-10-17T04:01:00.000Z'))});
    const state=store.read(),task=state.tasks.find(value=>value.id===recoveryId)!;
    assert.equal(task.status,'queued');assert.equal(task.checkpoint,'site_origin_migration_recovery');assert.equal(task.attempts,3);assert.equal(task.cost?.aiCalls,2);assert.equal(task.topicSwitchAttempts,1);assert.equal(task.topicUrl,newRoot+'/guides/recover');assert.equal(hasActiveSiteOriginRecoveryGrant(state,task),true);
    assert.equal(nextTask(state,new Date('2026-10-17T04:02:00.000Z'),[automaticChannel('nostr')])?.id,recoveryId);
    task.checkpoint=undefined;assert.equal(nextTask(state,new Date('2026-10-17T04:02:00.000Z'),[automaticChannel('nostr')]),undefined);
    assert.throws(()=>store.update(current=>activateSiteOriginRecoveryGrant(current,siteId,recoveryId,new Date('2026-10-17T04:02:00.000Z'))),/没有可用/);
    assert.equal(store.read().tasks.find(value=>value.id===recoveryId)?.status,'queued');
  }finally{store.close()}
});

test('a claimed migration recovery cannot be resurrected or reset after interruption',()=>{
  const store=fixture();try{
    store.update(state=>{state.settings.autoRun=true;applySiteOriginMigration(state,{siteId,expectedDomain:'old.example.com',expectedUrl:oldRoot,newUrl:newRoot,operatorAuthorized:true,recoveryTaskId:recoveryId,resumeStatus:'ready'},new Date(at));activateSiteOriginRecoveryGrant(state,siteId,recoveryId,new Date('2026-10-17T04:01:00.000Z'));const task=state.tasks.find(value=>value.id===recoveryId)!;assert.equal(hasActiveSiteOriginRecoveryGrant(state,task),true);task.status='running';task.attempts=4;task.checkpoint=undefined});
    store.update(state=>recoverInterrupted(state,new Date('2026-10-17T05:00:00.000Z')));
    const interrupted=store.read().tasks.find(value=>value.id===recoveryId)!;
    assert.equal(interrupted.status,'failed');assert.equal(interrupted.attempts,4);assert.equal(interrupted.checkpoint,'site_origin_migration_recovery_consumed');assert.equal(interrupted.recoveryEligible,false);assert.equal(interrupted.nextCheckAt,undefined);
    store.update(state=>maintainWaitingTasks(state.tasks,state.sites,[automaticChannel('nostr')],state.settings,new Date('2026-10-19T05:00:00.000Z')));
    const later=store.read().tasks.find(value=>value.id===recoveryId)!;assert.equal(later.status,'failed');assert.equal(later.attempts,4);assert.equal(later.recoveryEligible,false);assert.equal(nextTask(store.read(),new Date('2026-10-19T05:01:00.000Z'),[automaticChannel('nostr')]),undefined);
  }finally{store.close()}
});

test('a consumed migration recovery replaces a queued repair promise with its terminal status once',()=>{
  const store=fixture();try{
    store.update(state=>{applySiteOriginMigration(state,{siteId,expectedDomain:'old.example.com',expectedUrl:oldRoot,newUrl:newRoot,operatorAuthorized:true,recoveryTaskId:recoveryId,resumeStatus:'ready'},new Date(at));activateSiteOriginRecoveryGrant(state,siteId,recoveryId,new Date('2026-10-17T04:01:00.000Z'));state.tasks.find(value=>value.id===recoveryId)!.attempts=4});
    const controller=new Controller(store,{ready:true,available:()=>true} as never,'fixture');
    controller.patch(recoveryId,{status:'failed',attempts:4,message:'独立审核发现可修订内容，AI 将自动修稿一次并重新审核。'});
    const saved=store.read().tasks.find(value=>value.id===recoveryId)!;
    assert.equal(saved.checkpoint,'site_origin_migration_recovery_consumed');
    assert.match(saved.message,/自动修稿已停止/);
    assert.doesNotMatch(saved.message,/AI 将自动修稿一次并重新审核/);
    assert.equal((saved.message.match(/一次性网站迁移恢复已结束/g)??[]).length,1);
    controller.stop();
  }finally{store.close()}
});

test('migration recovery grant is bound to the original channel, identity and same mapped path',()=>{
  const changes:Array<(task:Task)=>void>=[
    task=>{task.channelId='supanote'},
    task=>{task.sourceDomain='changed.example.net'},
    task=>{task.topicUrl=newRoot+'/guides/different'},
    task=>{task.accountId='99999999-9999-4999-8999-999999999999'},
  ];
  for(const change of changes){
    const store=fixture();try{
      const before=store.read();
      assert.throws(()=>store.update(state=>{applySiteOriginMigration(state,{siteId,expectedDomain:'old.example.com',expectedUrl:oldRoot,newUrl:newRoot,operatorAuthorized:true,recoveryTaskId:recoveryId},new Date(at));change(state.tasks.find(value=>value.id===recoveryId)!);activateSiteOriginRecoveryGrant(state,siteId,recoveryId,new Date('2026-10-17T04:01:00.000Z'))}),/上下文已改变/);
      assert.deepEqual(store.read(),before);
    }finally{store.close()}
  }
  for(const change of changes){
    const store=fixture();try{
      store.update(state=>{applySiteOriginMigration(state,{siteId,expectedDomain:'old.example.com',expectedUrl:oldRoot,newUrl:newRoot,operatorAuthorized:true,recoveryTaskId:recoveryId},new Date(at));activateSiteOriginRecoveryGrant(state,siteId,recoveryId,new Date('2026-10-17T04:01:00.000Z'))});
      store.update(state=>change(state.tasks.find(value=>value.id===recoveryId)!));
      const state=store.read();assert.equal(hasActiveSiteOriginRecoveryGrant(state,state.tasks.find(value=>value.id===recoveryId)!),false);
    }finally{store.close()}
  }
});

test('portable backup preserves and validates the origin archive and consumed recovery grant',()=>{
  const store=fixture();try{
    store.update(state=>{applySiteOriginMigration(state,{siteId,expectedDomain:'old.example.com',expectedUrl:oldRoot,newUrl:newRoot,operatorAuthorized:true,recoveryTaskId:recoveryId},new Date(at))});
    store.update(state=>consumeSiteOriginRecoveryGrant(state,siteId,recoveryId,new Date('2026-10-17T04:01:00.000Z')));
    const exported=store.read(),restored=validateBackup({state:exported,secrets:{}}).state;
    assert.deepEqual(restored.siteOriginMigrations,exported.siteOriginMigrations);assert.equal(restored.schemaVersion,3);
    const fresh=new Store(':memory:');try{fresh.restore(restored,{});assert.deepEqual(fresh.read().siteOriginMigrations,exported.siteOriginMigrations)}finally{fresh.close()}
    const preMigration=fixture();try{assert.throws(()=>store.restore(preMigration.read(),{}),/迁移快照不能删除|恢复许可/)}finally{preMigration.close()}
    const tampered=structuredClone({state:exported,secrets:{}});tampered.state.siteOriginMigrations![0].before.domain='tampered.example.com';
    assert.throws(()=>validateBackup(tampered),/快照|迁移|Telegraph/);
  }finally{store.close()}
});

test('origin migration maps editable content and link constraints without changing publication history',async()=>{
  const {siteAllowsLinkTarget}=await import('../src/shared/site-content');
  const {mergeDiscoveredSiteTopics}=await import('../src/main/site-service');
  const store=fixture();try{
    store.update(state=>{state.sites[0].linkTargets=[oldRoot+'/',oldRoot+'/guides/manual'];state.sites[0].topicOverrides={added:[{url:oldRoot+'/guides/manual',title:'Manual title',discoveredAt:at}],excluded:[oldRoot+'/guides/excluded']}});
    const oldPublished=structuredClone(store.read().tasks.find(t=>t.id===telegraphId));
    store.update(state=>{applySiteOriginMigration(state,{siteId,expectedDomain:'old.example.com',expectedUrl:oldRoot,newUrl:newRoot,operatorAuthorized:true},new Date(at))});
    const state=store.read(),current=state.sites[0];
    assert.deepEqual(current.linkTargets,[newRoot+'/',newRoot+'/guides/manual']);
    assert.equal(siteAllowsLinkTarget(current,newRoot+'/'),true);
    assert.equal(current.topicOverrides?.added[0].url,newRoot+'/guides/manual');
    assert.deepEqual(current.topicOverrides?.excluded,[newRoot+'/guides/excluded']);
    assert.deepEqual(state.siteOriginMigrations?.[0].before.linkTargets,[oldRoot+'/',oldRoot+'/guides/manual']);
    assert.deepEqual(state.tasks.find(t=>t.id===telegraphId),oldPublished);
    const topics=mergeDiscoveredSiteTopics(current,[{url:newRoot+'/guides/new',discoveredAt:at},{url:newRoot+'/guides/excluded',discoveredAt:at}],new Set());
    assert.ok(topics.every(t=>new URL(t.url).origin===newRoot));
    assert.equal(topics.some(t=>t.url.endsWith('/excluded')),false);
    const restored=validateBackup({state,secrets:{}}).state;
    assert.deepEqual(restored.sites[0].linkTargets,current.linkTargets);
    assert.deepEqual(restored.siteOriginMigrations?.[0].before.topicOverrides,state.siteOriginMigrations?.[0].before.topicOverrides);
  }finally{store.close()}
});


test('origin migration accepts the same www alias as the content editor',async()=>{
  const {updateSiteContent}=await import('../src/main/site-service');
  const store=fixture();try{
    store.update(state=>updateSiteContent(state,{id:siteId,topics:[{url:'https://www.old.example.com/guides/manual'}],linkTargets:['https://www.old.example.com/'],forbiddenTerms:[]},new Date(at)));
    store.update(state=>{applySiteOriginMigration(state,{siteId,expectedDomain:'old.example.com',expectedUrl:oldRoot,newUrl:newRoot,operatorAuthorized:true},new Date(at))});
    assert.deepEqual(store.read().sites[0].linkTargets,[newRoot+'/']);
    assert.equal(store.read().sites[0].topicOverrides?.added[0].url,newRoot+'/guides/manual');
  }finally{store.close()}
});
