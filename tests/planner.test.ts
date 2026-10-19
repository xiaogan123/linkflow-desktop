import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, emptyState } from '../src/main/store';
import { dateKey, monthKey, makePlan, nextTask, markVerified, recoverInterrupted, expireReviews, liveThisMonth, applyLinkResult, reservesSlot, reservesMonthlySlot, earliestPublicationAt, reflowQueuedSchedules, selectTaskPlatform, publicationExecutionAt } from '../src/main/planner';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {samePlatformGapDays} from '../src/shared/scheduling';
import type { Channel, Site, Task } from '../src/shared/types';

const now=new Date('2026-09-26T04:11:00Z');
const early=new Date('2026-09-05T04:00:00Z');
function fixture(){const s=emptyState();s.settings.timezone='Asia/Singapore';const site:Site={id:randomUUID(),domain:'example.com',url:'https://example.com',email:'hello@example.com',name:'Example',description:'A software tool',category:'software',language:'en',monthlyTarget:2,status:'ready',createdAt:'2026-08-01T00:00:00.000Z',analyzedAt:now.toISOString()};s.sites.push(site);const matches=Array.from({length:6},(_,i)=>({channel:{id:'c'+i,domain:`channel${i}.com`,automation:'browser',free:'yes',enabled:true} as Channel,score:90,reason:'Relevant'}));return {s,site,matches}}
function telegraph():Channel{return {id:'telegraph',name:'Telegraph',domain:'telegra.ph',url:'https://telegra.ph',submitUrl:'https://api.telegra.ph/createPage',categories:['software'],languages:['en'],kind:'article',emailRequired:false,accountRequired:true,articleRequired:true,free:'yes',freeNote:'',automation:'api',quality:'A',qualityReason:'official API',provenance:'built-in',rulesUrl:'https://telegra.ph/api',checkedAt:'2026-09-01',notes:'',allowedHosts:['telegra.ph'],enabled:true}}
test('natural month follows configured timezone, including UTC boundary',()=>{assert.equal(dateKey('2026-09-30T20:00:00Z','Asia/Singapore'),'2026-10-01');assert.equal(monthKey('2026-10-01T01:00:00Z','America/Los_Angeles'),'2026-09')});
test('default quota reserves two days and chooses neither source before execution',()=>{
  const {s,site,matches}=fixture(),made=makePlan(s,site,matches,early);assert.equal(made.length,2);assert.ok(made.every(task=>!task.channelId&&!task.sourceDomain&&monthKey(task.scheduledAt,s.settings.timezone)==='2026-09'));assert.ok(Date.parse(made[1].scheduledAt)-Date.parse(made[0].scheduledAt)>=3*86400000);
});

test('repeated planner calls and app ticks are idempotent',()=>{const {s,site,matches}=fixture();makePlan(s,site,matches,early);makePlan(s,site,matches,early);assert.equal(s.tasks.length,2)});
test('pending reviews keep their source blocked without consuming a later month target',()=>{
  const {s,site,matches}=fixture();makePlan(s,site,matches,early);for(const task of s.tasks){task.status='review';task.reviewUntil='2026-10-20T00:00:00Z'}const made=makePlan(s,site,matches,new Date('2026-10-01T00:00:00Z'));assert.equal(made.length,2);assert.ok(made.every(task=>task.channelId===''&&monthKey(task.scheduledAt,s.settings.timezone)==='2026-10'));
});

test('verification counts once in first-live month even on later reverification',()=>{const {s,site,matches}=fixture();makePlan(s,site,matches,now);const t=s.tasks[0];markVerified(t,new Date('2026-10-02T00:00:00Z'),'https://channel0.com/page','nofollow');markVerified(t,new Date('2026-11-02T00:00:00Z'),'https://channel0.com/page','nofollow');assert.equal(liveThisMonth(site.id,s.tasks,new Date('2026-10-05'),s.settings.timezone),1);assert.equal(liveThisMonth(site.id,s.tasks,new Date('2026-11-05'),s.settings.timezone),0)});
test('expired review releases slot but source remains used',()=>{
  const {s,site,matches}=fixture();const [task]=makePlan(s,site,matches,now);task.channelId='c0';task.sourceDomain='channel0.com';task.status='review';task.reviewUntil='2026-09-25T00:00:00Z';expireReviews(s,now);assert.equal(task.status,'expired');const made=makePlan(s,site,matches,now);assert.equal(made.length,1);assert.equal(task.sourceDomain,'channel0.com');assert.equal(made[0].channelId,'');
});

test('paused sites keep expired review tasks unchanged',()=>{const {s,site,matches}=fixture();const [task]=makePlan(s,site,matches,early);task.status='review';task.reviewUntil='2026-09-25T00:00:00Z';site.status='paused';const before=structuredClone(task);expireReviews(s,now);assert.deepEqual(task,before)});
test('paused sites and unknown-priced/manual channels do not enter auto queue',()=>{
  const {s,site,matches}=fixture();site.status='paused';assert.equal(makePlan(s,site,matches,early).length,0);site.status='ready';matches[0].channel.free='unknown';matches[1].channel.automation='manual';matches[2].channel.enabled=false;s.settings.channelOverrides.c3=false;const made=makePlan(s,site,matches,early);assert.equal(made.length,2);for(const task of made){const channel=selectTaskPlatform(s,task,matches,new Date(task.scheduledAt));assert.ok(channel&&['c4','c5'].includes(channel.id));}
});

test('interrupted final submission never retries automatically',()=>{const {s,site,matches}=fixture();makePlan(s,site,matches,early);s.tasks[0].status='running';s.tasks[0].checkpoint='submitting';s.tasks[1].status='running';recoverInterrupted(s,now);assert.equal(s.tasks[0].status,'needs_input');assert.equal(s.tasks[1].status,'queued')});
test('restart preserves terminal batch 5 HTTP rejection and its submitted journal',()=>{
  for(const reasonCode of ['platform_rejected','platform_rate_limited','format_invalid','account_handoff'] as const){
    const {s,site,matches}=fixture(),[task]=makePlan(s,site,matches,early);
    task.status='failed';task.channelId='yeetmd';task.checkpoint='batch5_rejected';task.reasonCode=reasonCode;task.submittedAt=early.toISOString();task.attempts=1;task.message='HTTP rejected';
    const before=structuredClone(task);recoverInterrupted(s,now);assert.deepEqual(task,before,reasonCode);
  }
  const {s,site,matches}=fixture(),[uncertain]=makePlan(s,site,matches,early);
  uncertain.status='failed';uncertain.channelId='yeetmd';uncertain.checkpoint='batch5_rejected';uncertain.reasonCode='submission_unknown';uncertain.submittedAt=early.toISOString();
  recoverInterrupted(s,now);assert.equal(uncertain.status,'needs_input');assert.equal(uncertain.reasonCode,'submission_unknown');
});
test('lowered quota respects outstanding review before queued task',()=>{const {s,site,matches}=fixture();makePlan(s,site,matches,early);site.monthlyTarget=1;s.tasks[0].status='review';s.tasks[1].scheduledAt=now.toISOString();assert.equal(nextTask(s,now),undefined)});
test('finished quota and pause stop new claims',()=>{
  const {s,site,matches}=fixture();const [task]=makePlan(s,site,matches,now);task.scheduledAt=now.toISOString();assert.equal(nextTask(s,now)?.id,task.id);s.settings.autoRun=false;assert.equal(nextTask(s,now),undefined);s.settings.autoRun=true;site.monthlyTarget=1;delete site.planStatus;markVerified(task,now,'https://channel0.com/a','');assert.equal(nextTask(s,new Date('2026-09-30')),undefined);
});

test('attempt limit and future schedule cannot be claimed',()=>{const {s,site,matches}=fixture();makePlan(s,site,matches,now);s.tasks[0].attempts=s.settings.maxAttempts;assert.equal(nextTask(s,now),undefined)});
test('durably unsent batch 5 registration and publication can resume beyond the generic attempt cap',()=>{
  const {s,site,matches}=fixture(),[task]=makePlan(s,site,matches,now);
  s.tasks=[task];Object.assign(task,{channelId:'rant',sourceDomain:'rant.li',scheduledAt:now.toISOString(),attempts:s.settings.maxAttempts,reasonCode:'submission_unknown'});
  const registration={version:1 as const,channelId:'rant' as const,operationId:'registration',createdAt:now.toISOString(),sendGuardVersion:1 as const};
  for(const stage of ['not_sent','rate_limited','reserved'] as const){
    task.batch5Registration={...registration,stage};task.checkpoint='batch5_account_pending';task.status='queued';
    assert.equal(nextTask(s,now)?.id,task.id,stage);
  }
  task.batch5Registration={...registration,stage:'sending'};
  assert.equal(nextTask(s,now),undefined,'sending may have reached the provider');
  task.batch5Registration={...registration,stage:'reserved',sendGuardVersion:undefined};
  assert.equal(nextTask(s,now),undefined,'legacy reserved has no durable send guard');
  task.batch5Registration=undefined;
  task.batch5={version:1,channelId:'rant',operationId:'publication',sourceHash:'a'.repeat(64),requestHash:'b'.repeat(64),createdAt:now.toISOString(),stage:'reserved'};
  task.checkpoint='batch5_publish_submitting';
  assert.equal(nextTask(s,now)?.id,task.id,'a reserved article intent has not sent a POST');
  task.status='running';recoverInterrupted(s,now);
  assert.equal(task.status,'queued');
  assert.equal(nextTask(s,now)?.id,task.id);
  task.batch5.stage='submitting';
  assert.equal(nextTask(s,now),undefined,'submitting may have reached the provider');
});
test('account preparation uses its own bounded retry count after earlier task attempts',()=>{
  const {s,site,matches}=fixture(),[task]=makePlan(s,site,matches,now);
  s.tasks=[task];Object.assign(task,{channelId:'rant',sourceDomain:'rant.li',scheduledAt:now.toISOString(),attempts:s.settings.maxAttempts,prepareAttempts:1});
  assert.equal(nextTask(s,now)?.id,task.id);
  task.prepareAttempts=2;
  assert.equal(nextTask(s,now)?.id,task.id);
  task.prepareAttempts=3;
  assert.equal(nextTask(s,now),undefined,'the separate preparation budget is exhausted');
  task.prepareAttempts=1;
  task.batch5Registration={version:1,channelId:'rant',operationId:'possibly-sent',createdAt:now.toISOString(),stage:'sending'};
  assert.equal(nextTask(s,now),undefined,'a sending registration cannot borrow the preparation retry budget');
});
test('missed months do not multiply quota debt',()=>{
  const {s,site,matches}=fixture();const made=makePlan(s,site,matches,new Date('2027-02-15'));assert.ok(made.length>0&&made.length<=2);assert.ok(made.every(task=>monthKey(task.scheduledAt,s.settings.timezone)==='2027-02'));
});

test('SQLite update rollback leaves unchanged state on callback error',()=>{const store=new Store(':memory:');assert.throws(()=>store.update(s=>{s.settings.dailyAiLimit=1;throw Error('reject')}));assert.equal(store.read().settings.dailyAiLimit,40);store.close()});
test('SQLite snapshot is independent and secrets never enter state',()=>{const store=new Store(':memory:');store.setCipher('apiKey','encrypted-cipher');const snapshot=store.read();snapshot.settings.model='edited';assert.equal(store.read().settings.model,'');assert(!JSON.stringify(store.read()).includes('encrypted-cipher'));assert.equal(store.getCipher('apiKey'),'encrypted-cipher');store.close()});
test('restored queued final submission is quarantined before task claim',()=>{const {s,site,matches}=fixture();makePlan(s,site,matches,now);s.tasks[0].submittedAt=now.toISOString();s.tasks[0].checkpoint='submitting';recoverInterrupted(s,now);assert.equal(s.tasks[0].status,'needs_input');assert.equal(nextTask(s,now),undefined)});
test('restart before final write restores the reserved retry attempt',()=>{
  const {s,site,matches}=fixture();const [task]=makePlan(s,site,matches,now);task.scheduledAt=now.toISOString();task.status='running';task.attempts=s.settings.maxAttempts;recoverInterrupted(s,now);assert.equal(task.attempts,s.settings.maxAttempts-1);assert.equal(nextTask(s,now)?.id,task.id);
});

test('restart never repeats an in-flight paid AI call without a saved result',()=>{const {s,site,matches}=fixture();const [task]=makePlan(s,site,matches,now);task.status='running';task.attempts=1;task.checkpoint='article_review';task.draft={title:'t',description:'d',body:'b'};task.articleReview={status:'running',reason:'checking',evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)};recoverInterrupted(s,now);assert.equal(task.status,'failed');assert.equal(task.checkpoint,'system_wait');assert.equal(task.attempts,1);assert.match(task.message,/不会.*重复付费/);assert.notEqual(nextTask(s,now)?.id,task.id)});

test('network errors preserve live evidence while confirmed absent pages retain history without attention',()=>{const {s,site,matches}=fixture();const [t]=makePlan(s,site,matches,now);markVerified(t,now,'https://channel0.com/post','nofollow');applyLinkResult(t,{found:false,outcome:'unreachable',url:t.publicUrl!,rel:'',reason:'HTTP 503'},new Date('2026-09-27'));assert.equal(t.status,'live');assert.equal(t.linkCheck,'unreachable');const first=t.firstLiveAt;applyLinkResult(t,{found:false,outcome:'absent',url:t.publicUrl!,rel:'',reason:'No direct link'},new Date('2026-09-28'));assert.equal(t.status,'live');assert.ok(t.lostAt);assert.equal(t.humanAction,undefined);assert.equal(t.firstLiveAt,first)});
test('official API article channels can enter monthly queue',()=>{
  const {s,site,matches}=fixture();matches[0].channel.automation='api';const [task]=makePlan(s,site,matches,now);assert.equal(task.channelId,'');const selected=selectTaskPlatform(s,task,[matches[0]],new Date(task.scheduledAt));assert.equal(selected?.id,'c0');
});

test('an accountless plan prefers Telegraph self-provisioning over a higher-score third-party login',()=>{
  const {s,site}=fixture();site.monthlyTarget=1;const gist={id:'github-gist',domain:'gist.github.com',automation:'api',accountRequired:true,free:'yes',enabled:true} as Channel,telegraph={id:'telegraph',domain:'telegra.ph',automation:'api',accountRequired:true,free:'yes',enabled:true} as Channel;const matches=[{channel:gist,score:100,reason:'gist'},{channel:telegraph,score:1,reason:'telegraph'}];const [task]=makePlan(s,site,matches,now);assert.equal(task.channelId,'');assert.equal(selectTaskPlatform(s,task,matches,new Date(task.scheduledAt))?.id,'telegraph');assert.equal(channelExecutionReadiness(s,site.id,telegraph).kind,'autocreate');
});

test('a verified API identity is attached only when its platform is selected',()=>{
  const {s,site}=fixture();site.monthlyTarget=1;const gist={id:'github-gist',domain:'gist.github.com',automation:'api',accountRequired:true,free:'yes',enabled:true} as Channel;const accountId=randomUUID();s.accounts.push({id:accountId,channelId:'github-gist',email:'owner@example.com',username:'example-author',createdAt:now.toISOString(),status:'registered',hasPassword:true,credentialKind:'api_token'});site.qualifications={developer:'https://example.com/developer'};site.topics=[{url:'https://example.com/guides/one',discoveredAt:now.toISOString()}];const matches=[{channel:gist,score:1,reason:'connected'}],made=makePlan(s,site,matches,now);assert.equal(made[0].accountId,undefined);assert.equal(selectTaskPlatform(s,made[0],matches,new Date(made[0].scheduledAt))?.id,'github-gist');assert.equal(made[0].accountId,accountId);
});

test('a never-submitted generated Telegraph identity remains self-provisionable',()=>{
  const {s,site}=fixture(),channel={id:'telegraph',domain:'telegra.ph',automation:'api',accountRequired:true,free:'yes',enabled:true} as Channel;
  const accountId=randomUUID();s.accounts.push({id:accountId,channelId:channel.id,email:site.email,username:'fixture',createdAt:now.toISOString(),status:'draft',source:'generated',registrationAttempts:0,hasPassword:false,credentialKind:'api_token'});
  assert.deepEqual(channelExecutionReadiness(s,site.id,channel),{kind:'autocreate'},'matching email alone cannot select a Telegraph identity');
  s.accountBindings.push({id:randomUUID(),siteId:site.id,channelId:channel.id,accountId,createdAt:now.toISOString(),updatedAt:now.toISOString()});
  assert.deepEqual(channelExecutionReadiness(s,site.id,channel),{kind:'autocreate',account:s.accounts[0]});
});

test('Telegraph never treats an imported password as an API token or replaces an uncertain API identity',()=>{
  const {s,site}=fixture(),channel={id:'telegraph',domain:'telegra.ph',automation:'api',accountRequired:true,free:'yes',enabled:true} as Channel;
  const passwordId=randomUUID();s.accounts.push({id:passwordId,channelId:channel.id,email:site.email,username:'legacy-password',createdAt:now.toISOString(),status:'registered',hasPassword:true,credentialKind:'password'});
  assert.deepEqual(channelExecutionReadiness(s,site.id,channel),{kind:'autocreate'});assert.equal(channelExecutionReadiness(s,site.id,channel,passwordId).kind,'handoff_required');
  const uncertainId=randomUUID();s.accounts.push({id:uncertainId,channelId:channel.id,email:site.email,username:'uncertain-token',createdAt:now.toISOString(),status:'unknown',hasPassword:true,credentialKind:'api_token'});
  assert.deepEqual(channelExecutionReadiness(s,site.id,channel),{kind:'autocreate'},'an unrelated email match does not bind the uncertain identity');
  s.accountBindings.push({id:randomUUID(),siteId:site.id,channelId:channel.id,accountId:uncertainId,createdAt:now.toISOString(),updatedAt:now.toISOString()});
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

test('future ready reservation does not starve an effectively due autocreate task',()=>{
  const {s,site}=fixture();site.monthlyTarget=2;
  const selfProvision=telegraph(),ready={id:'lucid-page',domain:'lucid.page',automation:'api',accountRequired:false,free:'yes',enabled:true} as Channel;
  const past=new Date(now.getTime()-15*86400000).toISOString(),future=new Date(now.getTime()+3*86400000).toISOString();
  const base={siteId:site.id,status:'queued' as const,createdAt:past,updatedAt:past,attempts:0,message:'queued'};
  const live:Task={id:randomUUID(),...base,channelId:'prior',sourceDomain:'prior.example',status:'live',scheduledAt:past,submittedAt:past,firstLiveAt:past,publicUrl:'https://prior.example/page'};
  const due:Task={id:randomUUID(),...base,channelId:'telegraph',sourceDomain:'telegra.ph',scheduledAt:now.toISOString(),checkpoint:'article_review',cost:{aiCalls:2}};
  const later:Task={id:randomUUID(),...base,channelId:'lucid-page',sourceDomain:'lucid.page',scheduledAt:future};
  s.tasks.push(live,due,later);
  assert.equal(channelExecutionReadiness(s,site.id,selfProvision).kind,'autocreate');
  assert.equal(channelExecutionReadiness(s,site.id,ready).kind,'ready');
  assert.equal(nextTask(s,now,[selfProvision,ready])?.id,due.id);
  assert.equal(due.attempts,0);assert.equal(due.cost?.aiCalls,2);assert.equal(due.scheduledAt,now.toISOString());
  const other={...site,id:randomUUID(),domain:'other.example',url:'https://other.example'};s.sites.push(other);
  s.tasks.push({...later,id:randomUUID(),siteId:other.id});
  assert.equal(nextTask(s,now,[selfProvision,ready])?.id,due.id);
  site.monthlyTarget=1;assert.equal(nextTask(s,now,[selfProvision,ready]),undefined);
  site.monthlyTarget=2;due.attempts=s.settings.maxAttempts;assert.equal(nextTask(s,now,[selfProvision,ready]),undefined);
  due.attempts=0;
  const review:Task={...later,id:randomUUID(),status:'review',scheduledAt:now.toISOString()};s.tasks.push(review);
  assert.equal(nextTask(s,now,[selfProvision,ready]),undefined);
  s.tasks.pop();
  s.tasks.splice(s.tasks.indexOf(due),1);assert.equal(nextTask(s,now,[selfProvision,ready]),undefined);
});

test('a scheduled-past ready task with a future effective publication time does not take a due slot',()=>{
  const {s,site}=fixture();site.monthlyTarget=2;
  const selfProvision=telegraph(),ready={id:'lucid-page',domain:'lucid.page',automation:'api',accountRequired:false,free:'yes',enabled:true} as Channel;
  const past=new Date(now.getTime()-8*86400000).toISOString(),yesterday=new Date(now.getTime()-86400000).toISOString();
  const base={siteId:site.id,createdAt:past,updatedAt:past,attempts:0,message:'queued'};
  const live:Task={id:randomUUID(),...base,channelId:'lucid-page',sourceDomain:'lucid.page',status:'live',scheduledAt:past,submittedAt:past,firstLiveAt:past,publicUrl:'https://lucid.page/prior'};
  const delayed:Task={id:randomUUID(),...base,channelId:'lucid-page',sourceDomain:'lucid.page',status:'queued',scheduledAt:yesterday};
  const due:Task={id:randomUUID(),...base,channelId:'telegraph',sourceDomain:'telegra.ph',status:'queued',scheduledAt:now.toISOString()};
  s.tasks.push(live,delayed,due);
  assert.equal(nextTask(s,now,[selfProvision,ready])?.id,due.id);
  s.tasks.pop();assert.equal(nextTask(s,now,[selfProvision,ready]),undefined);
});

test('account handoff and manual work release capacity while uncertain publication remains reserved',()=>{
  const {s,site,matches}=fixture();site.monthlyTarget=1;
  const handoff:Task={id:randomUUID(),siteId:site.id,channelId:'github-gist',sourceDomain:'gist.github.com',status:'needs_input',checkpoint:'account_handoff',createdAt:now.toISOString(),scheduledAt:now.toISOString(),updatedAt:now.toISOString(),attempts:0,message:'connect'};
  s.tasks.push(handoff);assert.equal(reservesSlot(handoff,now),false);assert.equal(makePlan(s,site,matches,now).length,1);
  const uncertain={...handoff,id:randomUUID(),sourceDomain:'uncertain.example',checkpoint:'submitting',submittedAt:now.toISOString()};assert.equal(reservesSlot(uncertain,now),true);
  const manual={...handoff,id:randomUUID(),sourceDomain:'manual.example',checkpoint:'manual_submission'};assert.equal(reservesSlot(manual,now),false);
});

test('released tasks keep source history deduplicated without creating account handoffs',()=>{
  const {s,site}=fixture();site.monthlyTarget=2;const channel={id:'telegraph',domain:'telegra.ph',automation:'api',accountRequired:true,free:'yes',enabled:true} as Channel,matches=[{channel,score:1,reason:'telegraph'}];makePlan(s,site,matches,now);makePlan(s,site,matches,now);assert.equal(s.tasks.length,1);assert.equal(s.tasks.filter(task=>task.checkpoint==='account_handoff').length,0);assert.equal(s.tasks[0].channelId,'');
});

test('a late first publication dynamically postpones the next platform before claim',()=>{
  const {s,site,matches}=fixture(),made=makePlan(s,site,matches,early),first=made[0],second=made[1];first.channelId='c0';first.sourceDomain='channel0.com';markVerified(first,new Date('2026-09-10T04:00:00Z'),'https://channel0.com/late','nofollow');second.channelId='c1';second.sourceDomain='channel1.com';second.scheduledAt='2026-09-11T04:00:00Z';assert.equal(nextTask(s,new Date(second.scheduledAt)),undefined);assert.ok(publicationExecutionAt(s,second,new Date(second.scheduledAt)).getTime()>=Date.parse(first.firstLiveAt!)+3*86400000);
});

test('runtime cadence uses varied thirty-to-forty-five days for one platform and three across platforms',()=>{
  const {s,site}=fixture();const task:Task={id:randomUUID(),siteId:site.id,channelId:'c0',sourceDomain:'channel0.com',status:'review',createdAt:early.toISOString(),scheduledAt:early.toISOString(),updatedAt:early.toISOString(),submittedAt:early.toISOString(),attempts:1,message:'submitted'};s.tasks.push(task);assert.equal(earliestPublicationAt(site.id,'c0',s.tasks,early,{includeReservations:false}).getTime(),early.getTime()+samePlatformGapDays(site.id,'c0',early.toISOString())*86400000);assert.equal(earliestPublicationAt(site.id,'c1',s.tasks,early,{includeReservations:false}).getTime(),early.getTime()+3*86400000);
});

test('manual scheduling helper includes queued reservations unless runtime validation opts out',()=>{
  const {s,site,matches}=fixture();const [task]=makePlan(s,site,matches,early);task.channelId='c0';const at=new Date(task.scheduledAt);assert.equal(earliestPublicationAt(site.id,'c0',s.tasks,at).getTime(),at.getTime()+samePlatformGapDays(site.id,'c0',task.scheduledAt)*86400000);assert.equal(earliestPublicationAt(site.id,'c0',s.tasks,at,{includeReservations:false}).getTime(),at.getTime());
});

test('a next-month queued task reserves its own month without consuming the current target',()=>{
  const {s,site,matches}=fixture();const future:Task={id:randomUUID(),siteId:site.id,channelId:'future',sourceDomain:'future.example',status:'queued',createdAt:early.toISOString(),scheduledAt:'2026-10-01T04:00:00Z',updatedAt:early.toISOString(),attempts:0,message:'queued'};s.tasks.push(future);assert.equal(reservesMonthlySlot(future,new Date('2026-09-20T04:00:00Z'),s.settings.timezone),false);const made=makePlan(s,site,matches,new Date('2026-09-20T04:00:00Z'));assert.equal(made.length,1);assert.ok(Date.parse(made[0].scheduledAt)>Date.parse('2026-09-20T04:00:00Z'));assert.equal(reservesMonthlySlot(future,new Date('2026-10-01T04:00:00Z'),s.settings.timezone),true);
});

test('a submitted task occupies the submission month instead of its original schedule month',()=>{
  const {s,site}=fixture();const task:Task={id:randomUUID(),siteId:site.id,channelId:'submitted',sourceDomain:'submitted.example',status:'needs_input',checkpoint:'submission_uncertain',createdAt:'2026-09-01T04:00:00.000Z',scheduledAt:'2026-09-28T04:00:00.000Z',submittedAt:'2026-10-01T04:00:00.000Z',updatedAt:'2026-10-01T04:00:00.000Z',attempts:1,message:'verify'};
  assert.equal(reservesMonthlySlot(task,new Date('2026-09-29T04:00:00.000Z'),s.settings.timezone),false);assert.equal(reservesMonthlySlot(task,new Date('2026-10-02T04:00:00.000Z'),s.settings.timezone),true);
});

test('queued schedules reflow in order while preserving cross-month task identity',()=>{
  const {s,site,matches}=fixture();site.monthlyTarget=3;const made=makePlan(s,site,matches,new Date('2026-09-01T04:00:00Z')),ids=made.map(task=>task.id);for(const task of made)task.scheduledAt='2026-09-15T04:00:00Z';reflowQueuedSchedules(s,matches.map(match=>match.channel),new Date('2026-09-18T04:00:00Z'));assert.deepEqual(s.tasks.map(task=>task.id),ids);assert.ok(made.every(task=>task.status==='queued'&&Date.parse(task.scheduledAt)>Date.parse('2026-09-18T04:00:00Z')));const dates=made.map(task=>Date.parse(task.scheduledAt)).sort((a,b)=>a-b);assert.ok(dates.every((at,i)=>i===0||at-dates[i-1]>=2*86400000));
});

test('a prior-month queued task rolls forward under the same identity and occupies the new target',()=>{
  const {s,site,matches}=fixture();site.monthlyTarget=1;const [queued]=makePlan(s,site,matches,new Date('2026-09-29T04:00:00Z')),id=queued.id;reflowQueuedSchedules(s,matches.map(match=>match.channel),new Date('2026-10-01T04:00:00Z'));assert.equal(queued.id,id);assert.equal(queued.status,'queued');assert.ok(queued.scheduledAt>'2026-10-01T04:00:00Z');assert.equal(makePlan(s,site,matches,new Date('2026-10-01T04:00:00Z')).length,0);
});

test('cross-month reflow preserves draft, cumulative budget, recovery count, and registration checkpoint',()=>{
  const {s,site}=fixture();site.monthlyTarget=2;
  const costly:Task={id:randomUUID(),siteId:site.id,channelId:'c0',sourceDomain:'channel0.com',status:'queued',createdAt:'2026-09-01T04:00:00.000Z',scheduledAt:'2026-09-29T04:00:00.000Z',updatedAt:'2026-09-29T04:00:00.000Z',attempts:1,message:'queued',checkpoint:'article_review',draft:{title:'kept',description:'kept',body:'kept'},cost:{aiCalls:6},recoveryAttempts:1};
  const registration:Task={id:randomUUID(),siteId:site.id,channelId:'c1',sourceDomain:'channel1.com',status:'queued',createdAt:'2026-09-01T04:00:00.000Z',scheduledAt:'2026-09-30T04:00:00.000Z',updatedAt:'2026-09-30T04:00:00.000Z',attempts:1,message:'queued',checkpoint:'account_registration_submitted',cost:{aiCalls:2},recoveryAttempts:0};
  s.tasks.push(costly,registration);const ids=s.tasks.map(task=>task.id);
  reflowQueuedSchedules(s,[],new Date('2026-10-01T04:00:00Z'));
  assert.deepEqual(s.tasks.map(task=>task.id),ids);assert.deepEqual(costly.draft,{title:'kept',description:'kept',body:'kept'});assert.equal(costly.cost?.aiCalls,6);assert.equal(costly.recoveryAttempts,1);assert.equal(costly.checkpoint,'article_review');assert.equal(registration.checkpoint,'account_registration_submitted');assert.equal(registration.cost?.aiCalls,2);
});

test('runtime thirty-day gate preserves an original queued draft across a month boundary',()=>{
  const {s,site}=fixture();s.settings.timezone='UTC';site.monthlyTarget=3;const channel=telegraph(),base={siteId:site.id,channelId:channel.id,sourceDomain:channel.domain,createdAt:early.toISOString(),updatedAt:early.toISOString(),attempts:1,message:'fixture'};const live:Task={id:randomUUID(),...base,status:'live',scheduledAt:'2026-09-12T10:11:00Z',firstLiveAt:'2026-09-12T10:11:00Z',publicUrl:'https://telegra.ph/example'};const queued:Task={id:randomUUID(),...base,status:'queued',scheduledAt:'2026-09-20T10:11:00Z',attempts:0,draft:{title:'kept',description:'kept',body:'kept'},cost:{aiCalls:2},recoveryAttempts:1};s.tasks=[live,queued];const at=new Date(queued.scheduledAt),when=publicationExecutionAt(s,queued,at);assert.ok(when.getTime()>=Date.parse(live.firstLiveAt!)+30*86400000);assert.equal(nextTask(s,at,[channel]),undefined);assert.equal(queued.cost?.aiCalls,2);assert.equal(queued.draft?.title,'kept');
});

test('wake-up does not preselect or move future legacy slots while the thirty-day helper remains available',()=>{
  const {s,site}=fixture();const base={siteId:site.id,channelId:'same',sourceDomain:'same.example',status:'queued' as const,createdAt:early.toISOString(),updatedAt:early.toISOString(),attempts:0,message:'queued'},first:Task={id:randomUUID(),...base,scheduledAt:'2026-09-05T04:00:00Z'},second:Task={id:randomUUID(),...base,scheduledAt:'2026-09-12T04:00:00Z'};s.tasks=[first,second];assert.deepEqual(reflowQueuedSchedules(s,[],new Date('2026-09-01T04:00:00Z')),[]);assert.equal(second.scheduledAt,'2026-09-12T04:00:00Z');assert.ok(earliestPublicationAt(site.id,'same',[first],new Date(second.scheduledAt)).getTime()>=Date.parse(first.scheduledAt)+30*86400000);
});

test('an unverified URL without success or submission does not become a rolling cadence anchor',()=>{
  const {s,site,matches}=fixture();site.monthlyTarget=2;
  s.tasks.push({id:randomUUID(),siteId:site.id,channelId:'legacy',sourceDomain:'legacy.example',status:'needs_input',createdAt:'2026-09-01T04:00:00.000Z',scheduledAt:'2026-09-01T04:00:00.000Z',updatedAt:'2026-09-01T04:00:00.000Z',attempts:0,message:'verify',publicUrl:'https://legacy.example/unverified'});
  const queued:Task={id:randomUUID(),siteId:site.id,channelId:'c1',sourceDomain:'channel1.com',status:'queued',createdAt:'2026-09-01T04:00:00.000Z',scheduledAt:'2026-09-08T04:00:00.000Z',updatedAt:'2026-09-01T04:00:00.000Z',attempts:0,message:'queued'};s.tasks.push(queued);
  assert.equal(nextTask(s,new Date('2026-09-08T04:11:00Z'))?.id,queued.id);
});

test('a historical URL-only review does not consume every later monthly target',()=>{
  const {s,site,matches}=fixture();site.monthlyTarget=1;s.tasks.push({id:randomUUID(),siteId:site.id,channelId:'legacy',sourceDomain:'legacy.example',status:'needs_input',createdAt:'2026-08-01T04:00:00Z',scheduledAt:'2026-08-01T04:00:00Z',updatedAt:'2026-08-01T04:00:00Z',attempts:0,message:'verify',publicUrl:'https://legacy.example/unverified'});const made=makePlan(s,site,matches,new Date('2026-09-08T04:00:00Z'));assert.equal(made.length,1);assert.equal(monthKey(made[0].scheduledAt,s.settings.timezone),'2026-09');
});
