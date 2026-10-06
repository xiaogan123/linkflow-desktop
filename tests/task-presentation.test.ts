import test from 'node:test';
import assert from 'node:assert/strict';
import type {ArticleReviewReasonCode,Channel,Site,Snapshot,Task} from '../src/shared/types';
import {articleReviewDetail,canRestartArticleReview,canRetryTaskManually,channelReadinessForDisplay,isUserActionTask,taskHasAutomaticFollowup,taskPresentation,taskReservesPlanningSlot,taskSortRank,taskWorkKind} from '../src/ui/presentation';

const stamp='2026-10-03T00:00:00.000Z';
const site:Site={id:'site-1',domain:'example.com',url:'https://example.com',email:'owner@example.com',publicEmail:'owner@example.com',name:'Example',description:'Example software',category:'software',language:'zh',monthlyTarget:2,articleReviewMode:'ai',status:'ready',createdAt:stamp};
const channel=(id:string,automation:Channel['automation'],accountRequired=true):Channel=>({id,name:id,domain:`${id}.example`,url:`https://${id}.example`,submitUrl:`https://${id}.example/new`,categories:['general'],languages:['zh'],kind:'profile',emailRequired:true,accountRequired,articleRequired:false,free:'yes',freeNote:'fixture',automation,quality:'A',qualityReason:'fixture',rulesUrl:`https://${id}.example/rules`,checkedAt:'2026-10-03',notes:'',allowedHosts:[`${id}.example`],enabled:true});
const task=(status:Task['status']='queued'):Task=>({id:'task-1',siteId:site.id,channelId:'telegraph',sourceDomain:'telegra.ph',status,createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture'});
const failedReview=(reasonCode:ArticleReviewReasonCode)=>({status:'failed' as const,reason:'fixture failure',reasonCode,reviewedAt:stamp,evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)});

test('terminal invalid topic has a precise label without offering a generic paid retry',()=>{
  const invalid={...task('failed'),checkpoint:'invalid_topic'};
  assert.equal(taskPresentation(invalid,'ai').label,'需要新的文章选题');
  assert.equal(isUserActionTask(invalid,'ai'),false);
  assert.equal(canRetryTaskManually(invalid,'ai'),false);
  const stopped={...invalid,checkpoint:'topic_recovery_budget'};
  assert.equal(taskPresentation(stopped,'ai').label,'自动处理额度不足');
  assert.equal(isUserActionTask(stopped,'ai'),false);
  assert.equal(canRetryTaskManually(stopped,'ai'),false);
});

test('policy and evidence dispositions never become human review labels',()=>{
  for(const reasonCode of ['policy_unknown','policy_not_found','evidence_invalid','input_too_long','content_rejected'] as const){
    const value={...task('failed'),checkpoint:'channel_wait',articleReview:failedReview(reasonCode)};
    assert.equal(taskWorkKind(value,'ai'),'channel_wait',reasonCode);
    assert.equal(isUserActionTask(value,'ai'),false,reasonCode);
    assert.equal(canRestartArticleReview(value,'ai'),false,reasonCode);
  }
  const policy={...task('failed'),checkpoint:'channel_wait',articleReview:failedReview('policy_not_found')};
  assert.equal(taskPresentation(policy,'ai').label,'等待渠道许可证据');
  assert.match(articleReviewDetail(policy,'ai'),/新证据/);
  assert.doesNotMatch(articleReviewDetail(policy,'ai'),/决定|例外/);
});

test('temporary review failures are system work before and after retry exhaustion',()=>{
  const queued={...task('queued'),checkpoint:'article_review',articleReview:failedReview('evidence_fetch_failed')};
  const exhausted={...queued,status:'failed' as const,checkpoint:'system_wait'};
  assert.deepEqual([taskPresentation(queued,'ai').kind,taskPresentation(queued,'ai').label],['system_retry','系统将自动重试']);
  assert.deepEqual([taskPresentation(exhausted,'ai').kind,taskPresentation(exhausted,'ai').label],['system_retry','系统处理已暂停']);
  assert.equal(isUserActionTask(exhausted,'ai'),false);
  assert.equal(taskHasAutomaticFollowup(exhausted),false);
  assert.equal(taskHasAutomaticFollowup(queued),true);
  assert.ok(taskSortRank(queued,'ai')<taskSortRank(exhausted,'ai'));
});

test('current handoff state overrides stale failed review metadata',()=>{
  for(const checkpoint of ['account_handoff','submission_uncertain']){
    const value={...task('needs_input'),checkpoint,...(checkpoint==='submission_uncertain'?{submittedAt:stamp}:{}),articleReview:failedReview('evidence_fetch_failed')};
    assert.equal(taskWorkKind(value,'ai'),'user_action',checkpoint);
  }
});

test('display readiness prefers a usable compatible identity and rejects profile conflicts',()=>{
  const gist={...channel('github-gist','api'),kind:'article' as const},telegraph={...channel('telegraph','api'),kind:'article' as const},github=channel('github','browser');
  const base={sites:[site],tasks:[],channels:[gist,telegraph,github],accounts:[],mailboxes:[],accountBindings:[],events:[],settings:{provider:'codex' as const,codexPath:'codex',model:'',articleReviewMode:'ai' as const,apiBase:'',hasApiKey:false,autoRun:true,launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:false,version:'fixture',platform:'win32-x64',dataPath:'fixture',aiCallsToday:0}} satisfies Snapshot;
  const stale={id:'stale',channelId:gist.id,email:site.email,username:'stale',createdAt:stamp,status:'credentials_invalid' as const,hasPassword:false,credentialKind:'api_token' as const};
  const ready={...stale,id:'ready',status:'registered' as const,hasPassword:true};
  assert.equal(channelReadinessForDisplay({...base,accounts:[stale,ready]},site,gist),'ready');
  assert.equal(channelReadinessForDisplay({...base,accounts:[{...ready,channelId:telegraph.id,credentialKind:'password'}]},site,telegraph),'autocreate');
  const otherSite={...site,id:'site-2',domain:'other.example',url:'https://other.example'};
  const profileAccount={...ready,channelId:github.id,credentialKind:'password' as const};
  const reserved={...task('live'),siteId:otherSite.id,channelId:github.id,accountId:profileAccount.id,publicUrl:'https://github.example/owner'};
  assert.equal(channelReadinessForDisplay({...base,sites:[site,otherSite],accounts:[profileAccount],tasks:[reserved]},site,github),'handoff_required');
  const registration={...task('needs_input'),siteId:otherSite.id,channelId:github.id,accountId:profileAccount.id,checkpoint:'account_registration_submitted'};
  assert.equal(channelReadinessForDisplay({...base,sites:[site,otherSite],accounts:[profileAccount],tasks:[registration]},site,github),'handoff_required');
});

test('manual review, account handoff and ordinary failure remain real user actions',()=>{
  const manual={...task('needs_input'),checkpoint:'article_review',draft:{title:'t',description:'d',body:'b'}};
  const handoff={...task('needs_input'),checkpoint:'account_handoff'};
  const verification={...task('needs_input'),checkpoint:'account_registration_submitted'};
  const failed=task('failed');
  assert.equal(taskPresentation(manual,'manual').label,'稿件待人工审核');
  assert.equal(taskPresentation(handoff,'ai').label,'需要连接账号');
  assert.equal(taskPresentation(verification,'ai').label,'需要完成账号验证');
  assert.equal(isUserActionTask(failed,'ai'),true);
  assert.equal(canRetryTaskManually(failed,'ai'),true);
});

test('display readiness follows backend account and Telegraph autocreate contract',()=>{
  const gist=channel('github-gist','api'),telegraph=channel('telegraph','api'),github=channel('github','browser'),manual=channel('manual','manual');
  const data={sites:[site],tasks:[],channels:[gist,telegraph,github,manual],accounts:[{id:'gist-account',channelId:'github-gist',email:'',username:'owner',createdAt:stamp,status:'registered' as const,hasPassword:true,credentialKind:'api_token' as const}],mailboxes:[],accountBindings:[{id:'binding',siteId:site.id,channelId:'github-gist',accountId:'gist-account',createdAt:stamp,updatedAt:stamp}],events:[],settings:{provider:'codex' as const,codexPath:'codex',model:'',articleReviewMode:'ai' as const,apiBase:'',hasApiKey:false,autoRun:true,launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:false,version:'fixture',platform:'win32-x64',dataPath:'fixture',aiCallsToday:0}} satisfies Snapshot;
  assert.equal(channelReadinessForDisplay(data,site,gist),'ready');
  assert.equal(channelReadinessForDisplay(data,site,telegraph),'autocreate');
  assert.equal(channelReadinessForDisplay(data,site,github),'handoff_required');
  assert.equal(channelReadinessForDisplay(data,site,manual),'manual');
});

test('slot presentation matches submitted and non-submitted handoff behavior',()=>{
  const handoff={...task('needs_input'),checkpoint:'account_handoff'};
  const uncertain={...task('needs_input'),checkpoint:'submission_uncertain'};
  assert.equal(taskReservesPlanningSlot(handoff),false);
  assert.equal(taskReservesPlanningSlot(uncertain),true);
});
