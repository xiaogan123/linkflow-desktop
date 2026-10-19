import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {capacityFor,makePlan,recoverInterrupted,selectTaskPlatform} from '../src/main/planner';
import {emptyState} from '../src/main/store';
import {canonicalPublicPageUrl,publicationCounts,publicationOpportunity,taskOccupiesSource} from '../src/shared/publication';
import type {Channel,Site,Task} from '../src/shared/types';

const day=86400000;
const at=(value:string)=>new Date(`${value}T12:00:00.000Z`);
const topic=(n:number)=>({url:`https://example.com/topic-${n}`,title:`Topic ${n}`,discoveredAt:'2026-08-01T00:00:00.000Z'});
function site(topics:Site['topics']=[topic(1),topic(2),topic(3)]):Site{return {id:randomUUID(),domain:'example.com',url:'https://example.com',email:'hello@example.com',name:'Example',description:'Example software',category:'software',language:'en',monthlyTarget:2,qualifications:{developer:'https://example.com/developer'},status:'ready',createdAt:'2026-01-01T00:00:00.000Z',analyzedAt:'2026-01-01T00:00:00.000Z',...(topics===undefined?{}:{topics})}}
function article(id:'telegraph'|'github-gist'):Channel{return {id,name:id,domain:id==='telegraph'?'telegra.ph':'gist.github.com',url:'https://example.test',submitUrl:'https://example.test',categories:['software'],languages:['en'],kind:'article',emailRequired:false,accountRequired:true,articleRequired:true,free:'yes',freeNote:'',automation:'api',quality:'A',qualityReason:'',provenance:'built-in',rulesUrl:'https://example.test/rules',checkedAt:'2026-01-01',notes:'',allowedHosts:[],enabled:true}}
function generic(id:string,automation:Channel['automation']='browser'):Channel{return {id,name:id,domain:`${id}.example`,url:'https://example.test',submitUrl:'https://example.test',categories:['software'],languages:['en'],kind:'directory',emailRequired:false,accountRequired:false,articleRequired:false,free:'yes',freeNote:'',automation,quality:'B',qualityReason:'',provenance:'built-in',rulesUrl:'https://example.test/rules',checkedAt:'2026-01-01',notes:'',allowedHosts:[],enabled:true}}
function task(siteId:string,channel:Channel,partial:Partial<Task>={}):Task{return {id:randomUUID(),siteId,channelId:channel.id,sourceDomain:channel.domain,status:'queued',createdAt:'2026-09-01T00:00:00.000Z',scheduledAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z',attempts:0,message:'fixture',...partial}}
function live(siteId:string,channel:Channel,date:string,url?:string,topicUrl?:string):Task{return task(siteId,channel,{status:'live',firstLiveAt:at(date).toISOString(),publicUrl:url,topicUrl,health:url?'healthy':undefined,linkCheck:url?'found':undefined})}
function connect(state:ReturnType<typeof emptyState>,target:Site,channel:Channel){state.accounts.push({id:randomUUID(),channelId:channel.id,email:channel.id==='github-gist'?'owner@users.noreply.github.com':target.email,username:'owner',createdAt:'2026-01-01T00:00:00.000Z',status:'registered',hasPassword:true,credentialKind:'api_token'})}

test('canonical public page counts deduplicate URLs at their earliest first-live month',()=>{
  const target=site(),channel=article('telegraph');
  const tasks=[
    live(target.id,channel,'2026-08-31','https://WWW.telegra.ph/post/?utm_source=x#part'),
    live(target.id,channel,'2026-09-05','https://telegra.ph/post'),
    live(target.id,channel,'2026-09-08','https://telegra.ph/second/'),
    live(target.id,channel,'2026-09-09'),
  ];
  assert.equal(canonicalPublicPageUrl(tasks[0].publicUrl),'https://telegra.ph/post');
  assert.deepEqual(publicationCounts(target.id,tasks,at('2026-09-15'),'UTC'),{currentPages:2,monthlyPages:1,currentSources:1,monthlySources:1});
});

test('existing-link evidence and unknown URLs never manufacture newly published pages',()=>{
  const target=site(),channel=generic('directory');
  const tasks=[
    task(target.id,channel,{status:'skipped',checkpoint:'existing_link',firstLiveAt:at('2026-09-01').toISOString(),publicUrl:'https://directory.example/profile'}),
    live(target.id,channel,'2026-09-03','https://www.directory.example/profile?utm_campaign=x'),
    live(target.id,channel,'2026-09-04'),
  ];
  assert.deepEqual(publicationCounts(target.id,tasks,at('2026-09-15'),'UTC'),{currentPages:0,monthlyPages:0,currentSources:0,monthlySources:0});
});

test('two real pages on one platform count as pages while source metrics remain independent',()=>{
  const target=site(),channel=article('telegraph'),tasks=[live(target.id,channel,'2026-09-01','https://telegra.ph/one'),live(target.id,channel,'2026-09-12','https://telegra.ph/two')];
  assert.deepEqual(publicationCounts(target.id,tasks,at('2026-09-20'),'UTC'),{currentPages:2,monthlyPages:2,currentSources:1,monthlySources:1});
});

test('official article repeats require a connected API, a fresh topic and thirty days',()=>{
  const target=site(),channel=article('telegraph'),first=live(target.id,channel,'2026-09-01','https://telegra.ph/one',topic(1).url);assert.equal(publicationOpportunity(target,channel,[first],at('2026-09-05'),'UTC').blockingReason,'account_required');const waiting=publicationOpportunity(target,channel,[first],at('2026-09-05'),'UTC',{officialApiConnected:true});assert.equal(waiting.allowed,false);assert.equal(waiting.nextAvailableAt,at('2026-10-01').toISOString());const ready=publicationOpportunity(target,channel,[first],at('2026-10-01'),'UTC',{officialApiConnected:true});assert.equal(ready.allowed,true);assert.equal(ready.topicUrl,topic(2).url);const second=live(target.id,channel,'2026-10-01','https://telegra.ph/two',topic(2).url);const next=publicationOpportunity(target,channel,[first,second],at('2026-10-02'),'UTC',{officialApiConnected:true});assert.equal(next.allowed,true);assert.equal(next.scheduledAt,at('2026-10-31').toISOString());
});

test('topics are unique across channels and legacy live tasks without topic still enforce cadence',()=>{
  const target=site(),gist=article('github-gist'),telegraph=article('telegraph'),used=live(target.id,gist,'2026-08-01','https://gist.github.com/owner/one',topic(1).url),legacy=live(target.id,telegraph,'2026-09-10');const waiting=publicationOpportunity(target,telegraph,[used,legacy],at('2026-09-15'),'UTC',{officialApiConnected:true});assert.equal(waiting.allowed,false);assert.equal(waiting.nextAvailableAt,at('2026-10-10').toISOString());const opportunity=publicationOpportunity(target,telegraph,[used,legacy],at('2026-10-10'),'UTC',{officialApiConnected:true});assert.equal(opportunity.topicUrl,topic(2).url);const unknown=site();delete unknown.topics;assert.equal(publicationOpportunity(unknown,telegraph,[{...legacy,siteId:unknown.id}],at('2026-09-15'),'UTC',{officialApiConnected:true}).blockingReason,'topics_unknown');
});

test('unresolved external submissions remain blocked even if a newer task succeeded',()=>{
  const target=site(),channel=article('telegraph');
  const unknown=task(target.id,channel,{status:'failed',checkpoint:'telegraph_publish_uncertain',submittedAt:at('2026-09-01').toISOString(),topicUrl:'https://example.com/topic-1'});
  const success=live(target.id,channel,'2026-09-10','https://telegra.ph/two','https://example.com/topic-2');
  const result=publicationOpportunity(target,channel,[unknown,success],at('2026-09-25'),'UTC',{officialApiConnected:true});
  assert.equal(result.allowed,false);assert.equal(result.blockingReason,'cooldown');assert.equal(result.nextAvailableAt,undefined);
});

test('planning reserves other-platform receipts and uncertain checkpoints without submission timestamps',()=>{
  const receipt:Task['blogger']={blogId:'123',postId:'456',operationId:'operation',contentHash:'a'.repeat(64),stage:'draft'};
  for(const external of [
    {channelId:'blogger',checkpoint:'system_wait',blogger:receipt},
    {channelId:'paragraph',checkpoint:'system_wait',paragraph:{publicationId:'publication',postId:'post',slug:'article',contentHash:'b'.repeat(64),stage:'draft' as const}},
    {channelId:'bluesky',checkpoint:'bluesky_create_uncertain'},
  ])for(const status of ['failed','skipped','expired'] as const){
    const target=site(),channel=article('telegraph');
    const pending=task(target.id,generic(external.channelId),{...external,status,topicUrl:'https://www.example.com/topic-1/?utm_source=test#section'}),before=structuredClone(pending);
    const result=publicationOpportunity(target,channel,[pending],at('2026-09-15'),'UTC');
    assert.equal(result.topicUrl,'https://example.com/topic-2',`${external.channelId}:${status}`);
    assert.equal(taskOccupiesSource(pending),true);
    assert.equal(publicationOpportunity({...target,topics:[topic(1)]},channel,[pending],at('2026-09-15'),'UTC').blockingReason,'topics_exhausted');
    const state=emptyState();state.settings.timezone='UTC';state.sites.push(target);state.tasks.push(pending);
    const made=makePlan(state,target,[{channel,score:100,reason:'ready'}],at('2026-09-15'));
    assert.ok(made.length);assert.equal(made[0].channelId,'');assert.ok(selectTaskPlatform(state,made[0],[{channel,score:100,reason:'ready'}],new Date(made[0].scheduledAt)));assert.equal(made[0].topicUrl,'https://example.com/topic-2');assert.deepEqual(pending,before);
    assert.equal(publicationOpportunity(target,channel,[{...pending,siteId:'unrelated-site'}],at('2026-09-15'),'UTC').topicUrl,'https://example.com/topic-1');
  }
});

test('an older Blogger receipt still blocks new same-platform work after a newer successful post',()=>{
  const target=site(),channel:Channel={...article('telegraph'),id:'blogger',domain:'blogspot.com'};
  const pending=task(target.id,channel,{status:'failed',checkpoint:'system_wait',topicUrl:topic(1).url,blogger:{blogId:'123',postId:'456',operationId:'operation',contentHash:'a'.repeat(64),stage:'draft'}});
  const success=live(target.id,channel,'2026-09-10','https://example.blogspot.com/2026/09/second.html',topic(2).url);
  const result=publicationOpportunity(target,channel,[pending,success],at('2026-09-25'),'UTC',{officialApiConnected:true});
  assert.equal(result.allowed,false);assert.equal(result.blockingReason,'cooldown');assert.equal(result.nextAvailableAt,undefined);
});

test('released registration-only waits free their topic for other platforms but never permit duplicate registration',()=>{
  for(const channelId of ['paper-wf','mataroa','verbose']){
    const target=site(),channel=article('telegraph'),publisher:Channel={...channel,id:channelId,domain:`${channelId}.example`};
    const checkpoint=channelId==='paper-wf'?'paper_account_create_pending':`${channelId}_account_create_pending`;
    const registration=task(target.id,publisher,{status:'skipped',deferredAt:at('2026-09-03').toISOString(),checkpoint,accountId:'account',topicUrl:topic(1).url});
    assert.equal(publicationOpportunity(target,channel,[registration],at('2026-09-15'),'UTC').topicUrl,topic(1).url);
    assert.equal(taskOccupiesSource(registration),false);
    assert.equal(publicationOpportunity(target,publisher,[registration],at('2026-09-15'),'UTC').allowed,false);
    assert.equal(publicationOpportunity(target,channel,[{...registration,status:'needs_input'}],at('2026-09-15'),'UTC').topicUrl,topic(2).url);
    assert.equal(publicationOpportunity(target,channel,[{...registration,accountId:undefined}],at('2026-09-15'),'UTC').topicUrl,topic(1).url);
    assert.equal(publicationOpportunity(target,channel,[{...registration,blogger:{blogId:'123',operationId:'operation',contentHash:'a'.repeat(64),stage:'inserting'}}],at('2026-09-15'),'UTC').topicUrl,topic(2).url);
  }
});

test('a newer success supersedes only an older failed task with no external attempt',()=>{
  const target=site(),channel=article('telegraph');
  const old=task(target.id,channel,{status:'failed',checkpoint:'system_wait',createdAt:at('2026-09-01').toISOString(),topicUrl:'https://example.com/topic-1'});
  const success=live(target.id,channel,'2026-09-10','https://telegra.ph/two','https://example.com/topic-2');
  const result=publicationOpportunity(target,channel,[old,success],at('2026-10-10'),'UTC',{officialApiConnected:true});
  assert.equal(result.allowed,true);assert.equal(result.topicUrl,'https://example.com/topic-1');
});

test('finite recovery metadata reserves the original retry but an abandoned transient failure does not lock planning',()=>{
  const target=site(),channel=generic('directory'),base={status:'failed' as const,checkpoint:'system_wait',cost:{aiCalls:1},articleReview:{status:'failed' as const,reason:'offline',reasonCode:'ai_unavailable' as const,evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)}};
  const recoverable=task(target.id,channel,{...base,recoveryEligible:true,recoveryAttempts:0,nextCheckAt:at('2026-09-20').toISOString()});
  const allowed=publicationOpportunity(target,channel,[recoverable],at('2026-09-15'),'UTC');
  assert.equal(allowed.allowed,false);assert.equal(allowed.nextAvailableAt,at('2026-09-20').toISOString());
  recoverable.recoveryEligible=false;
  const abandoned=publicationOpportunity(target,channel,[recoverable],at('2026-09-15'),'UTC');
  assert.equal(abandoned.allowed,true);assert.equal(abandoned.scheduledAt,at('2026-09-15').toISOString());
});

test('a task budget failure cools down for 30 days and then releases a fresh task',()=>{
  const state=emptyState();state.settings.timezone='UTC';const target=site();state.sites.push(target);const channel=generic('directory');
  state.tasks.push(task(target.id,channel,{status:'failed',checkpoint:'system_wait',reasonCode:'ai_task_limit',cooldownUntil:'2026-10-01T12:00:00.000Z',cost:{aiCalls:6},message:'placeholder'}));
  const matches=[{channel,score:100,reason:'directory'}];
  assert.equal(makePlan(state,target,matches,at('2026-09-15')).length,0);assert.equal(makePlan(state,target,matches,at('2026-09-16')).length,0);assert.equal(state.tasks.length,1);
  const capacity=capacityFor(target,state.tasks,matches,[channel],at('2026-09-15'),'UTC',state);
  assert.equal(capacity.eligibleUnused,1);assert.equal(capacity.eligiblePages,0);assert.equal(capacity.blockingReason,'budget_exhausted');assert.equal(capacity.nextAvailableAt,'2026-10-01T12:00:00.000Z');
  assert.equal(makePlan(state,target,matches,at('2026-10-02')).length,1);assert.equal(state.tasks.length,2);
});

test('paused sites are not mutated by interrupted-task recovery',()=>{
  const state=emptyState(),target=site(),channel=generic('directory');target.status='paused';state.sites.push(target);
  const interrupted=task(target.id,channel,{status:'running',checkpoint:'article_review',cost:{aiCalls:1},articleReview:{status:'running',reason:'checking',evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)}});state.tasks.push(interrupted);
  const before=structuredClone(interrupted);recoverInterrupted(state,at('2026-09-15'));assert.deepEqual(state.tasks[0],before);
});

test('execution chooses an eligible platform after the day reservation and excludes the thirty-day cooldown',()=>{
  const state=emptyState();state.settings.timezone='UTC';const target=site();state.sites=[target];const gist=article('github-gist'),telegraph=article('telegraph');connect(state,target,gist);connect(state,target,telegraph);state.tasks.push(live(target.id,telegraph,'2026-09-01','https://telegra.ph/current',topic(1).url),live(target.id,gist,'2026-08-01','https://gist.github.com/owner/old',topic(2).url));const matches=[{channel:telegraph,score:100,reason:'higher score'},{channel:gist,score:1,reason:'unused'}],made=makePlan(state,target,matches,at('2026-09-15'));assert.equal(made[0]?.channelId,'');const selected=selectTaskPlatform(state,made[0],matches,new Date(made[0].scheduledAt));assert.equal(selected?.id,'github-gist');assert.equal(made[0].topicUrl,topic(3).url);
});

test('month-end cadence rejection does not stop a later executable candidate',()=>{
  const state=emptyState();state.settings.timezone='UTC';const target=site();state.sites=[target];const gist=article('github-gist'),telegraph=article('telegraph');connect(state,target,gist);state.tasks.push(live(target.id,gist,'2026-09-22','https://gist.github.com/owner/one',topic(1).url));const matches=[{channel:gist,score:100,reason:'connected'},{channel:telegraph,score:1,reason:'autocreate'}],made=makePlan(state,target,matches,at('2026-09-29'));assert.deepEqual(made,[]);assert.equal(publicationOpportunity(target,telegraph,state.tasks,at('2026-09-29'),'UTC').allowed,true);
});

test('capacity reports repeatable page opportunity separately from unused sources',()=>{
  const state=emptyState();state.settings.timezone='UTC';const target=site();state.sites.push(target);const telegraph=article('telegraph');connect(state,target,telegraph);
  state.tasks.push(live(target.id,telegraph,'2026-08-01','https://telegra.ph/one','https://example.com/topic-1'));
  const matches=[{channel:telegraph,score:100,reason:'article'}];
  const capacity=capacityFor(target,state.tasks,matches,[telegraph],at('2026-09-15'),'UTC',state);
  assert.equal(capacity.eligibleUnused,0);assert.equal(capacity.automaticUnused,0);assert.equal(capacity.currentSources,1);assert.equal(capacity.eligiblePages,1);assert.equal(capacity.automaticPages,1);assert.ok(capacity.nextAvailableAt&&Date.parse(capacity.nextAvailableAt)>at('2026-09-15').getTime());
});

test('capacity does not promise the same remaining topic to two channels',()=>{
  const state=emptyState();state.settings.timezone='UTC';const target=site([topic(1),topic(2)]);target.monthlyTarget=3;state.sites.push(target);
  const telegraph=article('telegraph'),gist=article('github-gist');connect(state,target,telegraph);connect(state,target,gist);
  state.tasks.push(live(target.id,telegraph,'2026-08-01','https://telegra.ph/one','https://example.com/topic-1'));
  const matches=[{channel:telegraph,score:100,reason:'telegraph'},{channel:gist,score:90,reason:'gist'}];
  const capacity=capacityFor(target,state.tasks,matches,[telegraph,gist],at('2026-09-01'),'UTC',state);
  assert.equal(capacity.eligiblePages,1);assert.equal(capacity.automaticPages,1);
});

test('invalid cached pages are excluded before planning and remain the automatic blocker beside manual capacity',()=>{
  const state=emptyState();state.settings.timezone='UTC';const target=site([{url:'https://example.com/privacy.html',title:'Privacy',discoveredAt:'2026-08-01T00:00:00.000Z'}]);state.sites.push(target);
  const telegraph=article('telegraph'),manual=generic('manual','manual');connect(state,target,telegraph);
  const matches=[{channel:telegraph,score:100,reason:'article'},{channel:manual,score:10,reason:'manual'}];
  const opportunity=publicationOpportunity(target,telegraph,[],at('2026-09-15'),'UTC',{officialApiConnected:true});
  assert.equal(opportunity.allowed,false);assert.equal(opportunity.blockingReason,'invalid_topic');assert.equal(makePlan(state,target,matches,at('2026-09-15')).length,0);
  const capacity=capacityFor(target,state.tasks,matches,[telegraph,manual],at('2026-09-15'),'UTC',state);
  assert.equal(capacity.eligiblePages,1);assert.equal(capacity.automaticPages,0);assert.equal(capacity.blockingReason,'invalid_topic');
});

test('structured article rejection is not reclassified as budget exhaustion by its human message',()=>{
  const target=site(),channel=article('telegraph');
  const stopped=task(target.id,channel,{status:'failed',checkpoint:'article_rejected',topicUrl:'https://example.com/topic-2',topicSwitchAttempts:1,cost:{aiCalls:4},message:'备用选题仍未通过，已达到一次换题上限。',articleReview:{status:'failed',reason:'still rejected',reasonCode:'content_rejected',evidenceUrls:[],draftRevision:3,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)}});
  const result=publicationOpportunity(target,channel,[stopped],at('2026-09-15'),'UTC',{officialApiConnected:true});
  assert.equal(result.allowed,false);assert.equal(result.blockingReason,'article_rejected');
});

test('planning softly prefers a topic path matching the site language locale',()=>{
  const target=site([{url:'https://example.com/en/guides/newer',discoveredAt:'2026-09-10T00:00:00.000Z'},{url:'https://example.com/zh-hans/guides/older',discoveredAt:'2026-09-01T00:00:00.000Z'}]);target.language='zh-CN';const channel=article('telegraph');
  const result=publicationOpportunity(target,channel,[],at('2026-09-15'),'UTC',{officialApiConnected:true});
  assert.equal(result.topicUrl,'https://example.com/zh-hans/guides/older');
});

test('capacity explains when the cross-platform interval pushes all work past month end',()=>{
  const state=emptyState();state.settings.timezone='UTC';const target=site();state.sites=[target];const oldChannel=generic('old'),nextChannel=generic('next');state.tasks.push(live(target.id,oldChannel,'2026-09-29','https://old.example/page'));const capacity=capacityFor(target,state.tasks,[{channel:nextChannel,score:100,reason:'next'}],[oldChannel,nextChannel],at('2026-09-29'),'UTC',state);assert.equal(capacity.automaticPages,0);assert.ok(capacity.blockingReason);
});
