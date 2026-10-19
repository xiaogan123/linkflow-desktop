import test from 'node:test';
import assert from 'node:assert/strict';
import {duplicatePublicBody} from '../src/integrations/topics';
import {CHANNELS} from '../src/integrations/catalog';
import {emptyState} from '../src/main/store';
import {channelExecutionReadiness,bindAccount} from '../src/main/account-bindings';
import {makePlan,nextTask,socialPublicationAt,reflowQueuedSchedules,publicationExecutionAt,dateKey} from '../src/main/planner';
import {graphemeLength,socialDraftError} from '../src/shared/social-content';
import {publicationCounts,publicationFormatCounts,publicationOpportunity} from '../src/shared/publication';
import {taskPresentation,taskHasSubmissionEvidence} from '../src/ui/presentation';
import type {Account,Site,Task} from '../src/shared/types';

const at=new Date('2026-10-06T12:17:00Z');
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

test('one shared public account cannot acquire publications for several domains',()=>{
  const s=state(),planned=s.sites.map(item=>makePlan(s,item,[{channel,score:90,reason:'related'}],at));assert.ok(planned.every(tasks=>tasks.length===0));const first={...task('first','a'),status:'live' as const,submittedAt:at.toISOString(),firstLiveAt:at.toISOString(),publicUrl:`https://bsky.app/profile/${did}/post/first`},second=task('second','b');s.tasks=[first,second];assert.equal(nextTask(s,at,[channel]),undefined);assert.ok(publicationExecutionAt(s,second,new Date(at.getTime()+86400000)).getTime()>at.getTime()+300*86400000);assert.equal(second.submittedAt,undefined);assert.equal(s.tasks.length,2);
});

test('one Blogger publication cannot be shared by several site identities',()=>{
  const s=state(),blogger=CHANNELS.find(item=>item.id==='blogger')!;s.accounts[0]={...account(),channelId:'blogger',username:'100',credentialKind:'oauth'};s.accountBindings=[];for(const item of s.sites){item.blogger={blogId:'200',url:'https://owned.example.blogspot.com/'};bindAccount(s,'identity',item.id,blogger,at);}const planned=s.sites.map(item=>makePlan(s,item,[{channel:blogger,score:90,reason:'related'}],at));assert.ok(planned.every(tasks=>tasks.length===0));const pending={...task('first','a'),channelId:'blogger',status:'review' as const,submittedAt:at.toISOString()};const second={...task('second','b'),channelId:'blogger'};s.tasks=[pending,second];assert.equal(nextTask(s,new Date(at.getTime()+86400000),[blogger]),undefined);assert.equal(s.tasks[0].submittedAt,at.toISOString());
});

test('late shared-destination history preserves queued identities and never makes another site borrow the author',()=>{
  for(const channelId of ['bluesky','blogger']){const s=state(),c=CHANNELS.find(item=>item.id===channelId)!,late=new Date('2026-10-30T12:17:00Z');if(channelId==='blogger'){s.accounts[0]={...account(),channelId:'blogger',username:'100',credentialKind:'oauth'};s.accountBindings=[];for(const item of s.sites){item.blogger={blogId:'200',url:'https://owned.example.blogspot.com/'};bindAccount(s,'identity',item.id,c,at);}}s.tasks=s.sites.map(item=>({...task('t-'+item.id,item.id),channelId}));Object.assign(s.tasks[0],{status:'live',submittedAt:late.toISOString(),firstLiveAt:late.toISOString(),publicUrl:channelId==='bluesky'?`https://bsky.app/profile/${did}/post/fixture`:'https://owned.example.blogspot.com/2026/10/check.html'});const ids=s.tasks.map(task=>task.id),first=structuredClone(s.tasks[0]);reflowQueuedSchedules(s,[c],late);assert.deepEqual(s.tasks.map(task=>task.id),ids);assert.deepEqual(s.tasks[0],first);for(const pending of s.tasks.slice(1)){assert.equal(pending.status,'queued');assert.equal(pending.scheduling?.reschedules,1);assert.ok(Date.parse(pending.scheduledAt)>late.getTime());assert.ok(publicationExecutionAt(s,pending,new Date(pending.scheduledAt)).getTime()>late.getTime()+300*86400000);assert.equal(pending.submittedAt,undefined);}}
});

test('unknown remote submission locks its original account and cannot be re-bound',()=>{
  const s=state(),t=task();t.status='needs_input';t.submittedAt=at.toISOString();t.checkpoint='bluesky_create_accepted';t.bluesky={did,rkey:'fixture',recordHash:'a'.repeat(64),recordCreatedAt:at.toISOString(),stage:'creating'};s.tasks=[t];
  s.accounts.push({...account(),id:'other',username:'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'});
  assert.throws(()=>bindAccount(s,'other','a',channel,at),/保留原发布账号处理完成后再更换/);
  assert.equal(publicationOpportunity(s.sites[0],channel,s.tasks,at,'UTC',{officialApiConnected:true}).allowed,false);
  assert.equal(taskHasSubmissionEvidence(t),true);
  assert.equal(taskPresentation(t,'ai',true).label,'自动查询发布结果');
  assert.equal(dateKey(socialPublicationAt(s,'b','bluesky',at,{includeReservations:false}),'UTC'),dateKey(new Date(at.getTime()+86400000),'UTC'));
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
