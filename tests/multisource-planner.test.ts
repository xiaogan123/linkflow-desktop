import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState} from '../src/main/store';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {availableNetworkPlatforms,makePlan,monthKey,rebalanceQueuedSources,reservesMonthlySlot,selectTaskPlatform} from '../src/main/planner';
import {monthlyCapacity} from '../src/shared/scheduling';
import {CHANNELS} from '../src/integrations/catalog';
import type {Channel,Site,Task} from '../src/shared/types';

const at=new Date('2026-10-07T00:00:00.000Z');
const topic=(site:Site,name:string)=>({url:`https://${site.domain}/guides/${name}`,discoveredAt:'2026-10-01T00:00:00.000Z'});
function article(id:string,domain:string,accountRequired=true):Channel{return {id,name:id,domain,url:`https://${domain}/`,submitUrl:`https://${domain}/publish`,categories:['content'],languages:['*'],kind:'article',emailRequired:false,accountRequired,articleRequired:true,free:'yes',freeNote:'fixture',automation:'api',quality:'C',qualityReason:'fixture',provenance:'built-in',rulesUrl:`https://${domain}/rules`,checkedAt:'2026-10-01',notes:'fixture',allowedHosts:[domain],enabled:true}}
const telegraph=CHANNELS.find(channel=>channel.id==='telegraph')!;
const nostr=CHANNELS.find(channel=>channel.id==='nostr')!;
function site(id='site-a'):Site{return {id,domain:`${id}.example.com`,url:`https://${id}.example.com/`,email:'owner@example.com',name:id,description:'Original educational guides',category:'content',language:'en',monthlyTarget:2,articleReviewMode:'ai',status:'ready',createdAt:'2026-09-01T00:00:00.000Z'}}
function live(value:Site,when='2026-10-01T00:00:00.000Z'):Task{return {id:'live-'+value.id,siteId:value.id,channelId:'telegraph',sourceDomain:'telegra.ph',status:'live',createdAt:when,scheduledAt:when,updatedAt:when,attempts:1,message:'live',topicUrl:topic(value,'one').url,publicUrl:'https://telegra.ph/live-'+value.id,firstLiveAt:when,verifiedAt:when,health:'healthy',linkCheck:'found'}}
function queued(value:Site,when='2026-10-05T00:00:00.000Z'):Task{return {id:'queued-'+value.id,siteId:value.id,channelId:'telegraph',sourceDomain:'telegra.ph',status:'queued',createdAt:'2026-09-20T00:00:00.000Z',scheduledAt:when,updatedAt:'2026-09-20T00:00:00.000Z',attempts:0,message:'legacy plan',reason:'legacy Telegraph',topicUrl:topic(value,'two').url}}
function fixture(){const state=emptyState(),value=site();state.settings.timezone='UTC';state.settings.autoRun=true;state.settings.articleReviewMode='manual';value.topics=[topic(value,'one'),topic(value,'two'),topic(value,'three')];state.sites=[value];state.tasks=[live(value),queued(value)];return {state,value,task:state.tasks[1]}}
const matches=(...channels:Channel[])=>channels.map((channel,index)=>({channel,score:100-index,reason:`${channel.id} eligible`}));

test('a pristine legacy reservation keeps its source until execution and a new day slot acquires a Nostr identity only then',()=>{
  const {state,value,task}=fixture(),before=structuredClone(task);assert.equal(channelExecutionReadiness(state,value.id,nostr).kind,'autocreate');assert.deepEqual(makePlan(state,value,matches(telegraph,nostr),at),[]);assert.deepEqual(task,before);task.channelId='';task.sourceDomain='';task.scheduledAt='2026-10-08T10:11:00Z';assert.equal(selectTaskPlatform(state,task,matches(telegraph,nostr),new Date(task.scheduledAt))?.id,'nostr');assert.equal(task.accountId,undefined);assert.equal(task.topicUrl,topic(value,'two').url);assert.equal(state.tasks.filter(item=>reservesMonthlySlot(item,at,'UTC')).length,1);
});

test('drafts, spending, remote uncertainty, confirmations, repairs, pauses, and manual mode are never reassigned',()=>{
  const cases:Array<[string,(state:ReturnType<typeof fixture>['state'],value:Site,task:Task)=>void]>=[
    ['draft',(_state,_site,task)=>{task.draft={title:'kept',description:'kept',body:'kept'}}],
    ['AI cost',(_state,_site,task)=>{task.cost={aiCalls:1,amount:0.01,currency:'USD'}}],
    ['non-AI cost',(_state,_site,task)=>{task.cost={aiCalls:0,durationMs:10}}],
    ['attempt',(_state,_site,task)=>{task.attempts=1}],
    ['unknown submission',(_state,_site,task)=>{task.submittedAt='2026-10-05T00:00:00.000Z';task.checkpoint='telegraph_publish_uncertain'}],
    ['manual confirmation',(_state,_site,task)=>{task.articleApprovedAt='2026-10-05T00:00:00.000Z'}],
    ['repair history',(_state,_site,task)=>{task.articleAttempts=[{topicUrl:task.topicUrl,recordedAt:'2026-10-05T00:00:00.000Z',reason:'kept'}]}],
    ['auto-run off',(state)=>{state.settings.autoRun=false}],
    ['manual review',(_state,value)=>{value.articleReviewMode='manual'}],
    ['paused site',(_state,value)=>{value.status='paused'}],
  ];
  for(const [label,mutate] of cases){
    const {state,value,task}=fixture();mutate(state,value,task);const before=structuredClone(task);
    makePlan(state,value,matches(telegraph,nostr),at);assert.deepEqual(task,before,label);
  }
});

test('blocked accounts and short posts cannot replace a full article reservation',()=>{
  const gist=article('github-gist','gist.github.com');
  const bluesky={...article('bluesky','bsky.app',false),kind:'community' as const,contentFormat:'social' as const};
  for(const candidate of [gist,bluesky]){
    const {state,value,task}=fixture(),before=structuredClone(task);
    makePlan(state,value,matches(telegraph,candidate),at);assert.deepEqual(task,before,candidate.id);
  }
});

test('a replacement that cannot fit this natural month leaves the old reservation intact',()=>{
  const {state,value,task}=fixture(),late=new Date('2026-10-29T00:00:00.000Z');value.monthlyTarget=3;task.scheduledAt=late.toISOString();
  state.tasks.push({id:'other-live',siteId:value.id,channelId:'other',sourceDomain:'other.example',status:'live',createdAt:'2026-10-26T00:00:00.000Z',scheduledAt:'2026-10-26T00:00:00.000Z',updatedAt:'2026-10-26T00:00:00.000Z',attempts:1,message:'live',topicUrl:topic(value,'three').url,publicUrl:'https://other.example/live',firstLiveAt:'2026-10-26T00:00:00.000Z'});
  const before=structuredClone(task);makePlan(state,value,matches(telegraph,nostr),late);assert.deepEqual(task,before);
});

test('a Paragraph identity bound to another site is never borrowed by a day reservation',()=>{
  const {state,value,task}=fixture(),other=site('site-b'),paragraph=CHANNELS.find(channel=>channel.id==='paragraph')!;value.paragraph={publicationId:'publication-1',url:'https://paragraph.com/@example'};other.paragraph={...value.paragraph};state.sites.push(other);state.accounts.push({id:'paragraph-account',channelId:'paragraph',email:'owner@example.com',username:'publication-1',createdAt:at.toISOString(),status:'registered',hasPassword:true,credentialKind:'api_token'});for(const item of [value,other])state.accountBindings.push({id:'binding-'+item.id,siteId:item.id,channelId:'paragraph',accountId:'paragraph-account',createdAt:at.toISOString(),updatedAt:at.toISOString()});task.channelId='';task.sourceDomain='';task.scheduledAt='2026-10-11T10:11:00Z';assert.equal(selectTaskPlatform(state,task,matches(paragraph),new Date(task.scheduledAt)),undefined);assert.equal(task.channelId,'');assert.equal(task.accountId,undefined);assert.equal(task.reasonCode,'platform_capacity');
});

test('an unpromoted trial contributes one network monthly slot and expands only after promotion',()=>{
 const state=emptyState(),first=site('first'),second=site('second'),trial={...article('trial-publisher','trial.example.com',false),trial:true};
 state.settings.timezone='UTC';state.sites=[first,second];
 for(const value of state.sites)value.topics=[topic(value,'one'),topic(value,'two')];
 const before=availableNetworkPlatforms(state,[trial]);
 assert.equal(before.length,1);assert.equal(before[0].monthlyLimit,1);
 assert.deepEqual(before[0].eligibleSiteIds,[first.id,second.id]);
 assert.equal(monthlyCapacity(state.sites,before,at,'UTC').capacity,1);
 const created=[...makePlan(state,first,matches(trial),at,before),...makePlan(state,second,matches(trial),at,before)];
 assert.equal(created.length,1);
 state.settings.channelTrials={...state.settings.channelTrials,[trial.id]:{trial:false,failures:0,evaluatedTaskIds:[created[0].id],promotedAt:at.toISOString()}};
 const after=availableNetworkPlatforms(state,[trial]);
 assert.equal(after[0].monthlyLimit,undefined);
 assert.equal(monthlyCapacity(state.sites,after,at,'UTC').capacity,3);
});

test('an active trial keeps its owning site monthly slot while other sites wait',()=>{
 const state=emptyState(),first=site('first'),second=site('second'),trial={...article('trial-publisher','trial.example.com',false),trial:true},task:Task={...queued(first),id:'active-trial',channelId:trial.id,sourceDomain:trial.domain,scheduledAt:'2026-10-08T10:11:00.000Z'};
 state.settings.timezone='UTC';state.sites=[first,second];state.tasks=[task];
 first.topics=[topic(first,'one'),topic(first,'two')];second.topics=[topic(second,'one'),topic(second,'two')];
 state.settings.channelTrials={...state.settings.channelTrials,[trial.id]:{trial:true,activeTaskId:task.id,failures:0,evaluatedTaskIds:[]}};
 const platforms=availableNetworkPlatforms(state,[trial]);
 assert.deepEqual(platforms[0].eligibleSiteIds,[first.id]);
 assert.deepEqual([...monthlyCapacity(state.sites,platforms,at,'UTC').targets],[[first.id,1],[second.id,0]]);
 assert.deepEqual(makePlan(state,first,matches(trial),at,platforms),[]);
 assert.equal(first.planStatus?.effectiveTarget,1);
 assert.deepEqual(makePlan(state,second,matches(trial),at,platforms),[]);
 assert.equal(second.planStatus?.effectiveTarget,0);
});

test('a paused trial owner reserves the lease without lending capacity to another site',()=>{
 const state=emptyState(),paused=site('paused-owner'),ready=site('ready-site'),trial={...article('trial-publisher','trial.example.com',false),trial:true},task:Task={...queued(paused),id:'paused-trial',channelId:trial.id,sourceDomain:trial.domain,status:'review',submittedAt:at.toISOString()};
 state.settings.timezone='UTC';paused.status='paused';state.sites=[paused,ready];state.tasks=[task];ready.topics=[topic(ready,'one')];
 state.settings.channelTrials={...state.settings.channelTrials,[trial.id]:{trial:true,activeTaskId:task.id,failures:0,evaluatedTaskIds:[],attemptSequence:1,activeAttemptSequence:1}};
 const platforms=availableNetworkPlatforms(state,[trial]);
 assert.equal(platforms.length,1);
 assert.deepEqual(platforms[0].eligibleSiteIds,[]);
 assert.deepEqual([...monthlyCapacity(state.sites.filter(value=>value.status==='ready'),platforms,at,'UTC').targets],[[ready.id,0]]);
 assert.deepEqual(makePlan(state,ready,matches(trial),at,platforms),[]);
 assert.equal(ready.planStatus?.effectiveTarget,0);
});

test('legacy source rebalance skips temporary pages and unavailable trials',()=>{
 const {state,value,task}=fixture(),temporary={...article('temporary','temporary.example.com',false),retentionDays:30},trial={...article('trial-source','trial.example.com',false),trial:true},accepted=nostr;
 task.autoSchedule={kind:'planner',channelId:task.channelId,sourceDomain:task.sourceDomain,baseAt:task.scheduledAt,plannedAt:task.scheduledAt,reservationTaskIds:[],appliedReleaseIds:[]};
 state.settings.channelTrials={...state.settings.channelTrials,[trial.id]:{trial:true,activeTaskId:'other-trial',failures:0,evaluatedTaskIds:[]}};
 const changes=rebalanceQueuedSources(state,value,matches(telegraph,temporary,trial,accepted),at);
 assert.equal(changes.length,1);
 assert.equal(changes[0].toChannelId,accepted.id);
 assert.equal(task.channelId,accepted.id);
 assert.equal(task.temporaryPage,undefined);
});
