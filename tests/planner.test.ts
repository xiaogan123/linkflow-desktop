import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, emptyState } from '../src/main/store';
import { dateKey, monthKey, makePlan, nextTask, markVerified, recoverInterrupted, expireReviews, liveThisMonth, applyLinkResult, reservesSlot } from '../src/main/planner';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import type { Channel, Site, Task } from '../src/shared/types';

const now=new Date('2026-09-26T04:00:00Z');
function fixture(){const s=emptyState();s.settings.timezone='Asia/Singapore';const site:Site={id:randomUUID(),domain:'example.com',url:'https://example.com',email:'hello@example.com',name:'Example',description:'A software tool',category:'software',language:'en',monthlyTarget:2,status:'ready',createdAt:now.toISOString(),analyzedAt:now.toISOString()};s.sites.push(site);const matches=Array.from({length:6},(_,i)=>({channel:{id:'c'+i,domain:`channel${i}.com`,automation:'browser',free:'yes',enabled:true} as Channel,score:90,reason:'Relevant'}));return {s,site,matches}}
test('natural month follows configured timezone, including UTC boundary',()=>{assert.equal(dateKey('2026-09-30T20:00:00Z','Asia/Singapore'),'2026-10-01');assert.equal(monthKey('2026-10-01T01:00:00Z','America/Los_Angeles'),'2026-09')});
test('default quota creates exactly two distinct sources within current month',()=>{const {s,site,matches}=fixture();const made=makePlan(s,site,matches,now);assert.equal(made.length,2);assert.equal(new Set(made.map(t=>t.sourceDomain)).size,2);assert(made.every(t=>monthKey(t.scheduledAt,s.settings.timezone)==='2026-09'))});
test('repeated planner calls and app ticks are idempotent',()=>{const {s,site,matches}=fixture();makePlan(s,site,matches,now);makePlan(s,site,matches,now);assert.equal(s.tasks.length,2)});
test('pending reviews reserve next-month slots without duplicated tasks',()=>{const {s,site,matches}=fixture();makePlan(s,site,matches,now);for(const t of s.tasks){t.status='review';t.reviewUntil='2026-10-20T00:00:00Z'}assert.equal(makePlan(s,site,matches,new Date('2026-10-01T00:00:00Z')).length,0)});
test('verification counts once in first-live month even on later reverification',()=>{const {s,site,matches}=fixture();makePlan(s,site,matches,now);const t=s.tasks[0];markVerified(t,new Date('2026-10-02T00:00:00Z'),'https://channel0.com/page','nofollow');markVerified(t,new Date('2026-11-02T00:00:00Z'),'https://channel0.com/page','nofollow');assert.equal(liveThisMonth(site.id,s.tasks,new Date('2026-10-05'),s.settings.timezone),1);assert.equal(liveThisMonth(site.id,s.tasks,new Date('2026-11-05'),s.settings.timezone),0)});
test('expired review releases slot but source remains used',()=>{const {s,site,matches}=fixture();makePlan(s,site,matches,now);s.tasks[0].status='review';s.tasks[0].reviewUntil='2026-09-25T00:00:00Z';const source=s.tasks[0].sourceDomain;expireReviews(s,now);assert.equal(s.tasks[0].status,'expired');const made=makePlan(s,site,matches,now);assert.equal(made.length,1);assert.notEqual(made[0].sourceDomain,source)});
test('paused sites and unknown-priced/manual channels do not enter auto queue',()=>{const {s,site,matches}=fixture();site.status='paused';assert.equal(makePlan(s,site,matches,now).length,0);site.status='ready';matches[0].channel.free='unknown';matches[1].channel.automation='manual';matches[2].channel.enabled=false;s.settings.channelOverrides.c3=false;const made=makePlan(s,site,matches,now);assert.deepEqual(made.map(t=>t.channelId),['c4','c5'])});
test('interrupted final submission never retries automatically',()=>{const {s,site,matches}=fixture();makePlan(s,site,matches,now);s.tasks[0].status='running';s.tasks[0].checkpoint='submitting';s.tasks[1].status='running';recoverInterrupted(s,now);assert.equal(s.tasks[0].status,'needs_input');assert.equal(s.tasks[1].status,'queued')});
test('lowered quota respects outstanding review before queued task',()=>{const {s,site,matches}=fixture();makePlan(s,site,matches,now);site.monthlyTarget=1;s.tasks[0].status='review';s.tasks[1].scheduledAt=now.toISOString();assert.equal(nextTask(s,now),undefined)});
test('finished quota and pause stop new claims',()=>{const {s,site,matches}=fixture();makePlan(s,site,matches,now);assert(nextTask(s,now));s.settings.autoRun=false;assert.equal(nextTask(s,now),undefined);s.settings.autoRun=true;site.monthlyTarget=1;markVerified(s.tasks[0],now,'https://channel0.com/a','');assert.equal(nextTask(s,new Date('2026-09-30')),undefined)});
test('attempt limit and future schedule cannot be claimed',()=>{const {s,site,matches}=fixture();makePlan(s,site,matches,now);s.tasks[0].attempts=s.settings.maxAttempts;assert.equal(nextTask(s,now),undefined)});
test('missed months do not multiply quota debt',()=>{const {s,site,matches}=fixture();assert.equal(makePlan(s,site,matches,new Date('2027-02-15')).length,2)});
test('SQLite update rollback leaves unchanged state on callback error',()=>{const store=new Store(':memory:');assert.throws(()=>store.update(s=>{s.settings.dailyAiLimit=1;throw Error('reject')}));assert.equal(store.read().settings.dailyAiLimit,40);store.close()});
test('SQLite snapshot is independent and secrets never enter state',()=>{const store=new Store(':memory:');store.setCipher('apiKey','encrypted-cipher');const snapshot=store.read();snapshot.settings.model='edited';assert.equal(store.read().settings.model,'');assert(!JSON.stringify(store.read()).includes('encrypted-cipher'));assert.equal(store.getCipher('apiKey'),'encrypted-cipher');store.close()});
test('restored queued final submission is quarantined before task claim',()=>{const {s,site,matches}=fixture();makePlan(s,site,matches,now);s.tasks[0].submittedAt=now.toISOString();s.tasks[0].checkpoint='submitting';recoverInterrupted(s,now);assert.equal(s.tasks[0].status,'needs_input');assert.equal(nextTask(s,now),undefined)});
test('restart before final write restores the reserved retry attempt',()=>{const {s,site,matches}=fixture();makePlan(s,site,matches,now);s.tasks[0].status='running';s.tasks[0].attempts=s.settings.maxAttempts;recoverInterrupted(s,now);assert.equal(s.tasks[0].attempts,s.settings.maxAttempts-1);assert.equal(nextTask(s,now)?.id,s.tasks[0].id)});
test('restart never repeats an in-flight paid AI call without a saved result',()=>{const {s,site,matches}=fixture();const [task]=makePlan(s,site,matches,now);task.status='running';task.attempts=1;task.checkpoint='article_review';task.draft={title:'t',description:'d',body:'b'};task.articleReview={status:'running',reason:'checking',evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)};recoverInterrupted(s,now);assert.equal(task.status,'failed');assert.equal(task.checkpoint,'system_wait');assert.equal(task.attempts,1);assert.match(task.message,/不会.*重复付费/);assert.notEqual(nextTask(s,now)?.id,task.id)});

test('network errors preserve live evidence while confirmed absent pages need attention',()=>{const {s,site,matches}=fixture();const [t]=makePlan(s,site,matches,now);markVerified(t,now,'https://channel0.com/post','nofollow');applyLinkResult(t,{found:false,outcome:'unreachable',url:t.publicUrl!,rel:'',reason:'HTTP 503'},new Date('2026-09-27'));assert.equal(t.status,'live');assert.equal(t.linkCheck,'unreachable');const first=t.firstLiveAt;applyLinkResult(t,{found:false,outcome:'absent',url:t.publicUrl!,rel:'',reason:'No direct link'},new Date('2026-09-28'));assert.equal(t.status,'needs_input');assert.equal(t.firstLiveAt,first)});
test('official API article channels can enter monthly queue',()=>{const {s,site,matches}=fixture();matches[0].channel.automation='api';assert.equal(makePlan(s,site,matches,now)[0].channelId,'c0')});

test('an accountless plan prefers Telegraph self-provisioning over a higher-score third-party login',()=>{
  const {s,site}=fixture();site.monthlyTarget=1;
  const gist={id:'github-gist',domain:'gist.github.com',automation:'api',accountRequired:true,free:'yes',enabled:true} as Channel;
  const telegraph={id:'telegraph',domain:'telegra.ph',automation:'api',accountRequired:true,free:'yes',enabled:true} as Channel;
  const made=makePlan(s,site,[{channel:gist,score:100,reason:'gist'},{channel:telegraph,score:1,reason:'telegraph'}],now);
  assert.deepEqual(made.map(task=>[task.channelId,task.status]),[['telegraph','queued']]);
  assert.equal(channelExecutionReadiness(s,site.id,telegraph).kind,'autocreate');
});

test('a verified API account outranks Telegraph self-provisioning',()=>{
  const {s,site}=fixture();site.monthlyTarget=1;
  const gist={id:'github-gist',domain:'gist.github.com',automation:'api',accountRequired:true,free:'yes',enabled:true} as Channel;
  const telegraph={id:'telegraph',domain:'telegra.ph',automation:'api',accountRequired:true,free:'yes',enabled:true} as Channel;
  const accountId=randomUUID();s.accounts.push({id:randomUUID(),channelId:'github-gist',email:'stale@users.noreply.github.com',username:'stale',createdAt:now.toISOString(),status:'credentials_invalid',hasPassword:false,credentialKind:'api_token'},{id:accountId,channelId:'github-gist',email:'owner@users.noreply.github.com',username:'owner',createdAt:now.toISOString(),status:'registered',hasPassword:true,credentialKind:'api_token'});
  const made=makePlan(s,site,[{channel:telegraph,score:100,reason:'telegraph'},{channel:gist,score:1,reason:'gist'}],now);
  assert.equal(made[0].channelId,'github-gist');assert.equal(made[0].accountId,accountId);
});

test('a never-submitted generated Telegraph identity remains self-provisionable',()=>{
  const {s,site}=fixture(),channel={id:'telegraph',domain:'telegra.ph',automation:'api',accountRequired:true,free:'yes',enabled:true} as Channel;
  const accountId=randomUUID();s.accounts.push({id:accountId,channelId:channel.id,email:site.email,username:'fixture',createdAt:now.toISOString(),status:'draft',source:'generated',registrationAttempts:0,hasPassword:false,credentialKind:'api_token'});
  assert.deepEqual(channelExecutionReadiness(s,site.id,channel),{kind:'autocreate',account:s.accounts[0]});
});

test('Telegraph never treats an imported password as an API token or replaces an uncertain API identity',()=>{
  const {s,site}=fixture(),channel={id:'telegraph',domain:'telegra.ph',automation:'api',accountRequired:true,free:'yes',enabled:true} as Channel;
  const passwordId=randomUUID();s.accounts.push({id:passwordId,channelId:channel.id,email:site.email,username:'legacy-password',createdAt:now.toISOString(),status:'registered',hasPassword:true,credentialKind:'password'});
  assert.deepEqual(channelExecutionReadiness(s,site.id,channel),{kind:'autocreate'});assert.equal(channelExecutionReadiness(s,site.id,channel,passwordId).kind,'handoff_required');
  const uncertainId=randomUUID();s.accounts.push({id:uncertainId,channelId:channel.id,email:site.email,username:'uncertain-token',createdAt:now.toISOString(),status:'unknown',hasPassword:true,credentialKind:'api_token'});
  const stopped=channelExecutionReadiness(s,site.id,channel);assert.equal(stopped.kind,'handoff_required');assert.equal(stopped.account?.id,uncertainId);assert.equal(s.accounts.find(item=>item.id===passwordId)?.credentialKind,'password');
});

test('a profile identity already used for another site is not considered ready',()=>{
  const {s,site}=fixture(),otherSite={...site,id:randomUUID(),domain:'other.example',url:'https://other.example'};
  s.sites.push(otherSite);
  const channel={id:'github',domain:'github.com',kind:'profile',automation:'browser',accountRequired:true,free:'yes',enabled:true} as Channel;
  const accountId=randomUUID();s.accounts.push({id:accountId,channelId:channel.id,email:site.email,username:'owner',createdAt:now.toISOString(),status:'registered',hasPassword:true,credentialKind:'password'});
  s.tasks.push({id:randomUUID(),siteId:otherSite.id,channelId:channel.id,accountId,sourceDomain:channel.domain,status:'live',createdAt:now.toISOString(),scheduledAt:now.toISOString(),updatedAt:now.toISOString(),attempts:1,message:'live',publicUrl:'https://github.com/owner'});
  assert.equal(channelExecutionReadiness(s,site.id,channel).kind,'handoff_required');
});

test('runner claims a ready account before an older self-provisioning task',()=>{
  const {s,site}=fixture();site.monthlyTarget=1;const accountId=randomUUID();
  const gist={id:'github-gist',domain:'gist.github.com',automation:'api',accountRequired:true,free:'yes',enabled:true} as Channel,telegraph={id:'telegraph',domain:'telegra.ph',automation:'api',accountRequired:true,free:'yes',enabled:true} as Channel;
  s.accounts.push({id:accountId,channelId:'github-gist',email:'owner@users.noreply.github.com',username:'owner',createdAt:now.toISOString(),status:'registered',hasPassword:true,credentialKind:'api_token'});
  const base={siteId:site.id,status:'queued' as const,createdAt:now.toISOString(),updatedAt:now.toISOString(),attempts:0,message:'queued'};
  s.tasks.push({id:randomUUID(),...base,channelId:'telegraph',sourceDomain:'telegra.ph',scheduledAt:new Date(now.getTime()-60000).toISOString()},{id:randomUUID(),...base,channelId:'github-gist',accountId,sourceDomain:'gist.github.com',scheduledAt:now.toISOString()});
  assert.equal(nextTask(s,now,[telegraph,gist])?.channelId,'github-gist');
});

test('account handoff and manual work release capacity while uncertain publication remains reserved',()=>{
  const {s,site,matches}=fixture();site.monthlyTarget=1;
  const handoff:Task={id:randomUUID(),siteId:site.id,channelId:'github-gist',sourceDomain:'gist.github.com',status:'needs_input',checkpoint:'account_handoff',createdAt:now.toISOString(),scheduledAt:now.toISOString(),updatedAt:now.toISOString(),attempts:0,message:'connect'};
  s.tasks.push(handoff);assert.equal(reservesSlot(handoff,now),false);assert.equal(makePlan(s,site,matches,now).length,1);
  const uncertain={...handoff,id:randomUUID(),sourceDomain:'uncertain.example',checkpoint:'submitting',submittedAt:now.toISOString()};assert.equal(reservesSlot(uncertain,now),true);
  const manual={...handoff,id:randomUUID(),sourceDomain:'manual.example',checkpoint:'manual_submission'};assert.equal(reservesSlot(manual,now),false);
});

test('released tasks keep source history deduplicated and only one account handoff is staged',()=>{
  const {s,site}=fixture();site.monthlyTarget=2;
  const blocked={id:'github-gist',domain:'gist.github.com',automation:'api',accountRequired:true,free:'yes',enabled:true} as Channel;
  const blockedTwo={id:'github-profile',domain:'github.com',automation:'browser',accountRequired:true,free:'yes',enabled:true} as Channel;
  const telegraph={id:'telegraph',domain:'telegra.ph',automation:'api',accountRequired:true,free:'yes',enabled:true} as Channel;
  const matches=[{channel:blocked,score:100,reason:'blocked'},{channel:blockedTwo,score:90,reason:'blocked2'},{channel:telegraph,score:1,reason:'telegraph'}];
  makePlan(s,site,matches,now);makePlan(s,site,matches,now);
  assert.equal(s.tasks.filter(task=>task.checkpoint==='account_handoff').length,1);
  assert.equal(s.tasks.filter(task=>task.channelId==='telegraph').length,1);
  assert.equal(new Set(s.tasks.map(task=>task.sourceDomain)).size,s.tasks.length);
});
