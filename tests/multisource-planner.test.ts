import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState} from '../src/main/store';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {makePlan,monthKey,reservesMonthlySlot} from '../src/main/planner';
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

test('a credential-free Nostr identity replaces one pristine duplicate Telegraph reservation',()=>{
  const {state,value,task}=fixture(),id=task.id,createdAt=task.createdAt;
  assert.equal(channelExecutionReadiness(state,value.id,nostr).kind,'autocreate');
  assert.deepEqual(makePlan(state,value,matches(telegraph,nostr),at),[]);
  assert.equal(task.id,id);assert.equal(task.createdAt,createdAt);assert.equal(task.channelId,'nostr');assert.equal(task.sourceDomain,'njump.me');assert.equal(task.accountId,undefined);
  assert.equal(task.topicUrl,topic(value,'two').url);assert.equal(task.scheduledAt,'2026-10-08T00:00:00.000Z');assert.equal(monthKey(task.scheduledAt,'UTC'),'2026-10');
  assert.equal(state.tasks.filter(item=>reservesMonthlySlot(item,at,'UTC')).length,1);
  const once=structuredClone(task);makePlan(state,value,matches(telegraph,nostr),at);assert.deepEqual(task,once);
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

test('a ready Paragraph publication recomputes its account and shared-destination day',()=>{
  const {state,value,task}=fixture(),other=site('site-b'),paragraph=CHANNELS.find(channel=>channel.id==='paragraph')!;task.scheduledAt='2026-10-11T00:00:00.000Z';
  value.paragraph={publicationId:'publication-1',url:'https://paragraph.com/@owner'};other.paragraph={...value.paragraph};other.topics=[topic(other,'one')];state.sites.push(other);
  state.accounts.push({id:'paragraph-account',channelId:'paragraph',email:'owner@example.com',username:'publication-1',createdAt:'2026-10-01T00:00:00.000Z',status:'registered',hasPassword:true,credentialKind:'api_token'});
  for(const item of [value,other])state.accountBindings.push({id:'binding-'+item.id,siteId:item.id,channelId:'paragraph',accountId:'paragraph-account',createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'});
  state.tasks.push({id:'other-paragraph',siteId:other.id,channelId:'paragraph',accountId:'paragraph-account',sourceDomain:'paragraph.com',status:'queued',createdAt:'2026-10-01T00:00:00.000Z',scheduledAt:'2026-10-11T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z',attempts:0,message:'queued',topicUrl:topic(other,'one').url});
  makePlan(state,value,matches(telegraph,paragraph),at);
  assert.equal(task.channelId,'paragraph');assert.equal(task.accountId,'paragraph-account');assert.equal(task.sourceDomain,'paragraph.com');assert.equal(task.scheduledAt,'2026-10-12T00:00:00.000Z');
});
