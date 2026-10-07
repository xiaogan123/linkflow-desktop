import test from 'node:test';
import assert from 'node:assert/strict';
import {duplicatePublicBody} from '../src/integrations/topics';
import {CHANNELS} from '../src/integrations/catalog';
import {emptyState} from '../src/main/store';
import {channelExecutionReadiness,bindAccount} from '../src/main/account-bindings';
import {makePlan,nextTask,socialPublicationAt,reflowQueuedSchedules} from '../src/main/planner';
import {graphemeLength,socialDraftError} from '../src/shared/social-content';
import {publicationCounts,publicationFormatCounts,publicationOpportunity} from '../src/shared/publication';
import {taskPresentation,taskHasSubmissionEvidence} from '../src/ui/presentation';
import type {Account,Site,Task} from '../src/shared/types';

const at=new Date('2026-10-06T00:00:00Z');
const channel=CHANNELS.find(item=>item.id==='bluesky')!;
const did='did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
function site(id='a'):Site{return {id,domain:`${id}.example.com`,url:`https://${id}.example.com/`,email:'owner@example.com',name:'Owned education site',description:'Original information verification tutorials',category:'finance',language:'en',status:'ready',createdAt:at.toISOString(),monthlyTarget:2,articleReviewMode:'ai',topics:[{url:`https://${id}.example.com/guides/check`,discoveredAt:at.toISOString()}]};}
function account():Account{return {id:'identity',channelId:'bluesky',username:did,displayName:'@author.bsky.social',email:'',credentialKind:'api_token',status:'registered',hasPassword:true,createdAt:at.toISOString()};}
function task(id='t',siteId='a'):Task{return {id,siteId,channelId:'bluesky',accountId:'identity',sourceDomain:'bsky.app',status:'queued',createdAt:at.toISOString(),scheduledAt:at.toISOString(),updatedAt:at.toISOString(),attempts:0,message:'fixture',topicUrl:`https://${siteId}.example.com/guides/check`};}
function state(){const s=emptyState();s.settings.timezone='UTC';s.settings.autoRun=true;s.accounts=[account()];s.sites=[site('a'),site('b'),site('c')];for(const item of s.sites)bindAccount(s,'identity',item.id,channel,at);return s;}
const text='One check: compare the source date before trusting a claim. Commercial relationship disclosure: We operate this site and may earn referral commissions.\nhttps://a.example.com/guides/check';

test('short-content draft retains exact related URL and does not truncate Unicode',()=>{
  const t={...task(),draft:{title:'Local label',description:'Local label',body:text}};
  assert.equal(socialDraftError(t,site(),channel),undefined);
  assert.equal(graphemeLength('👨‍👩‍👧‍👦'),1);
  assert.match(socialDraftError({...t,draft:{...t.draft,body:text+'\nhttps://other.example.com/'}},site(),channel)??'',/一个相关/);
  assert.match(socialDraftError({...t,draft:{...t.draft,body:text.replace('/guides/check','/guides/other')}},site(),channel)??'',/一致/);
  assert.match(socialDraftError({...t,draft:{...t.draft,body:'x'.repeat(301)+'\nhttps://a.example.com/guides/check'}},site(),channel)??'',/不会截断/);
  assert.match(socialDraftError({...t,draft:{...t.draft,body:'a'+'\u0301'.repeat(1600)+'\nhttps://a.example.com/guides/check'}},site(),channel)??'',/3000/);
  assert.match(socialDraftError({...t,draft:{...t.draft,body:text.replace('https://a.example.com/guides/check','[guide](https://a.example.com/guides/check)')}},site(),channel)??'',/纯文本/);
});

test('Bluesky never spends work without explicit usable site binding',()=>{
  const s=state();s.accountBindings=[];
  assert.equal(channelExecutionReadiness(s,'a',channel).kind,'handoff_required');
  assert.deepEqual(makePlan(s,s.sites[0],[{channel,score:90,reason:'related'}],at),[]);
  bindAccount(s,'identity','a',channel,at);assert.equal(channelExecutionReadiness(s,'a',channel).kind,'ready');
  s.accounts[0].status='credentials_invalid';assert.equal(channelExecutionReadiness(s,'a',channel).kind,'handoff_required');
});

test('one shared account is scheduled at least one day apart across domains',()=>{
  const s=state();
  const planned=s.sites.map(item=>makePlan(s,item,[{channel,score:90,reason:'related'}],at)[0]);
  assert.equal(planned.length,3);assert(planned.every(Boolean));
  assert.deepEqual(planned.map(item=>Date.parse(item.scheduledAt)-at.getTime()),[0,86400000,2*86400000]);
  assert.equal(nextTask(s,at,[channel])?.id,planned[0].id);
  planned[0].submittedAt=at.toISOString();planned[0].status='review';
  assert.equal(nextTask(s,new Date(at.getTime()+3600000),[channel]),undefined);
  assert.equal(nextTask(s,new Date(at.getTime()+86400000),[channel])?.id,planned[1].id);
});

test('a Blogger blog shared by several domains also gets one destination slot per day',()=>{
  const s=state(),blogger=CHANNELS.find(item=>item.id==='blogger')!;
  s.accounts[0]={...account(),channelId:'blogger',username:'100',credentialKind:'oauth'};
  s.accountBindings=[];
  for(const item of s.sites){item.blogger={blogId:'200',url:'https://owned.example.blogspot.com/'};bindAccount(s,'identity',item.id,blogger,at);}
  const planned=s.sites.map(item=>makePlan(s,item,[{channel:blogger,score:90,reason:'related'}],at)[0]);
  assert.deepEqual(planned.map(item=>Date.parse(item.scheduledAt)-at.getTime()),[0,86400000,2*86400000]);
  planned[0].submittedAt=at.toISOString();planned[0].status='review';
  assert.equal(nextTask(s,new Date(at.getTime()+3600000),[blogger]),undefined);
});

test('late shared-destination completion spills queued siblings into next month honestly',()=>{
  for(const channelId of ['bluesky','blogger']){
    const s=state(),c=CHANNELS.find(item=>item.id===channelId)!,late=new Date('2026-10-30T00:00:00Z');
    if(channelId==='blogger'){
      s.accounts[0]={...account(),channelId:'blogger',username:'100',credentialKind:'oauth'};s.accountBindings=[];
      for(const item of s.sites){item.blogger={blogId:'200',url:'https://owned.example.blogspot.com/'};bindAccount(s,'identity',item.id,c,at);}
    }
    s.tasks=s.sites.map(item=>({...task('t-'+item.id,item.id),channelId}));
    Object.assign(s.tasks[0],{status:'live',submittedAt:late.toISOString(),firstLiveAt:late.toISOString(),publicUrl:channelId==='bluesky'?`https://bsky.app/profile/${did}/post/fixture`:'https://owned.example.blogspot.com/2026/10/check.html'});
    reflowQueuedSchedules(s,[c],late);
    assert.equal(s.tasks[1].scheduledAt,'2026-10-31T00:00:00.000Z');
    assert.equal(s.tasks[2].scheduledAt,'2026-11-01T00:00:00.000Z');
    assert.equal(s.tasks.filter(item=>item.status==='queued'&&item.scheduledAt.startsWith('2026-10')).length,1);
  }
});

test('unknown remote submission locks its original account and cannot be re-bound',()=>{
  const s=state(),t=task();t.status='needs_input';t.submittedAt=at.toISOString();t.checkpoint='bluesky_create_accepted';t.bluesky={did,rkey:'fixture',recordHash:'a'.repeat(64),recordCreatedAt:at.toISOString(),stage:'creating'};s.tasks=[t];
  s.accounts.push({...account(),id:'other',username:'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'});
  assert.throws(()=>bindAccount(s,'other','a',channel,at),/保留原身份/);
  assert.equal(publicationOpportunity(s.sites[0],channel,s.tasks,at,'UTC',{officialApiConnected:true}).allowed,false);
  assert.equal(taskHasSubmissionEvidence(t),true);
  assert.equal(taskPresentation(t,'ai',true).label,'自动查询发布结果');
  assert.equal(socialPublicationAt(s,'b','bluesky',at,{includeReservations:false}).getTime(),at.getTime()+86400000);
});

test('short public results have their own count and cannot manufacture unique sources',()=>{
  const short={...task(),status:'live' as const,publicUrl:`https://bsky.app/profile/${did}/post/fixture`,firstLiveAt:at.toISOString(),health:'healthy' as const,linkCheck:'found' as const};
  const article={...short,id:'article',channelId:'telegraph',sourceDomain:'telegra.ph',publicUrl:'https://telegra.ph/fixture'};
  const duplicate={...short,id:'copy'};
  assert.equal(publicationCounts('a',[short,article,duplicate],at,'UTC').monthlyPages,2);
  const split=publicationFormatCounts('a',[short,article,duplicate],at,'UTC');
  assert.equal(split.social.monthlyPages,1);assert.equal(split.articlesAndProfiles.monthlyPages,1);
  assert.equal(split.social.monthlySources,1);
});

test('short identical public text cannot be republished by changing its private labels or destination link',()=>{
  const first='Compare the source date before trusting a claim. Commercial relationship disclosure: We operate this site and earn referral commissions.\nhttps://a.example.com/guides/check';
  const second=first.replace('a.example.com','b.example.com');
  assert.equal(duplicatePublicBody(second,[first]),true);
  const financial='Check the commission rate and payment schedule against current official terms before using an offer. Commercial relationship disclosure: We operate this site and earn referral commissions.\nhttps://example.com/guides/check';
  assert.equal(duplicatePublicBody(financial.replace('https://example.com','https://other.example.com'),[financial]),true);
  assert.equal(duplicatePublicBody('Read the original study methodology before judging its conclusions.\nhttps://b.example.com/guides/check',[first]),false);
});
