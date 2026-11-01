import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {currentArticlePublicationContext,leafmillOriginalPurpose,leafmillSingleArticleCandidate,
  LEAFMILL_SINGLE_ARTICLE_DRAFT_RULE} from '../src/main/article-publication-context';
import {validateBackup} from '../src/main/backup-validation';
import {emptyState} from '../src/main/store';
import {schedulableTaskMatches,selectTaskPlatform} from '../src/main/planner';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {buildChannelTermsCache,reviewedChannelTermsCache} from '../src/main/article-evidence';
import {CHANNELS} from '../src/integrations/catalog';
import {articleReviewStillValid,channelTermsBlockReason,reviewArticleDraft} from '../src/main/article-review';
import type {Channel,Site,Task} from '../src/shared/types';

const stamp='2026-10-29T12:00:00.000Z';
function fixture(){
  const site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Software Example',
    description:'Software documentation',email:'owner@example.org',category:'software',language:'en',monthlyTarget:1,
    status:'ready',createdAt:stamp};
  const channel={id:'leafmill',singleSiteOnly:true} as Channel;
  const task:Task={id:randomUUID(),siteId:site.id,channelId:'leafmill',sourceDomain:'leafmill.net',status:'queued',
    createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'test',draftRevision:1,
    draft:{title:'A useful software checklist',description:'Original troubleshooting steps.',
      body:'Check the response before changing a setting. Read the [public version list](https://software.example.org/). Disclosure: this document describes our own Software Example project.'}};
  return {site,channel,task};
}

test('Leafmill alone may ask for a single original software draft; finance and second-site batches cannot',()=>{
  const {site,channel,task}=fixture();
  assert.match(LEAFMILL_SINGLE_ARTICLE_DRAFT_RULE,/原创软件操作文档/);
  assert.equal(leafmillSingleArticleCandidate([task],task,site,channel),true);
  assert.equal(leafmillSingleArticleCandidate([task],task,{...site,category:'finance'},channel),false);
  assert.equal(leafmillSingleArticleCandidate([task],task,site,{...channel,singleSiteOnly:false}),false);
  assert.equal(leafmillSingleArticleCandidate([task,{...task,id:randomUUID(),siteId:randomUUID()}],task,site,channel),false);
});

test('planner defers Leafmill policy unknown to a sole software draft review, while forbidden and batches remain blocked',()=>{
  const {site,task}=fixture(),state=emptyState(),catalog=CHANNELS.find(item=>item.id==='leafmill');assert.ok(catalog);
  const channel={...catalog,enabled:true},policy='Original software documents may be hosted here. No bulk SEO pages or affiliate link farms.';
  channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(channel,[{url:channel.rulesUrl,kind:'content_policy',text:policy,appliesTo:'leafmill',applicability:'verified'}]),
    {finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'});
  state.sites=[site];state.tasks=[{...task,channelId:'',sourceDomain:''}];state.settings.channelOverrides.leafmill=true;
  site.topics=[{url:'https://software.example.org/guide',discoveredAt:stamp}];
  site.qualifications={software:'https://software.example.org/'};
  const accountId=randomUUID();state.accounts=[{id:accountId,channelId:'leafmill',email:'owner@example.org',username:'owner@example.org',
    publicationUrl:'https://leafmill.net/',createdAt:stamp,status:'registered',hasPassword:true,credentialKind:'api_token',source:'imported'}];
  state.accountBindings=[{id:randomUUID(),siteId:site.id,channelId:'leafmill',accountId,createdAt:stamp,updatedAt:stamp}];
  const match={channel,score:100,reason:'software documentation'};
  assert.equal(channelExecutionReadiness(state,site.id,channel).kind,'ready');
  assert.equal(schedulableTaskMatches(state,state.tasks[0],[match],new Date(stamp)).length,1);
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(stamp))?.id,'leafmill');
  const second={...task,id:randomUUID(),siteId:randomUUID()};state.tasks.push(second);
  state.tasks[0].channelId='';state.tasks[0].sourceDomain='';
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(stamp)),undefined);
  state.tasks.pop();channel.termsCache={...channel.termsCache,promotion:'forbidden'};
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(stamp)),undefined);
});

test('the explicit draft request receipt binds task, site, revision and original content; absent or changed evidence stays unknown',()=>{
  const {task}=fixture();
  assert.equal(currentArticlePublicationContext([task],task).publicationIntent,'unknown');
  task.leafmillOriginalPurpose=leafmillOriginalPurpose(task);
  assert.deepEqual(currentArticlePublicationContext([task],task),{scope:'visible_workspace_only',sameChannelTasks:1,distinctSites:1,
    publicationIntent:'single_original_article',workflowPurpose:'expand_backlink_channels',knownContentPattern:'unknown'});
  for(const changed of [{...task,id:randomUUID()},{...task,siteId:randomUUID()},
    {...task,draftRevision:2},{...task,draft:{...task.draft!,body:task.draft!.body+' Changed.'}},
    {...task,channelId:'other'}]){
    assert.equal(currentArticlePublicationContext([changed],changed).publicationIntent,'unknown');
  }
  const other={...task,id:randomUUID(),siteId:randomUUID()};
  assert.deepEqual(currentArticlePublicationContext([task,other],task).sameChannelTasks,2);
  assert.deepEqual(currentArticlePublicationContext([task,other],task).distinctSites,2);
});

test('backup roundtrip retains the bounded purpose receipt and rejects malformed fields',()=>{
  const {site,task}=fixture();task.leafmillOriginalPurpose=leafmillOriginalPurpose(task);
  const state=emptyState();state.sites=[site];state.tasks=[task];
  const restored=validateBackup({state,secrets:{}});
  assert.deepEqual(restored.state.tasks[0].leafmillOriginalPurpose,task.leafmillOriginalPurpose);
  const malformed=structuredClone(state);malformed.tasks[0].leafmillOriginalPurpose={...task.leafmillOriginalPurpose,contentHash:'bad'};
  assert.throws(()=>validateBackup({state:malformed,secrets:{}}));
});

test('a genuine review AI call decides the frozen single software draft while platform policy stays unknown',async()=>{
  const {site,task}=fixture(),catalog=CHANNELS.find(item=>item.id==='leafmill');assert.ok(catalog);
  const channel={...catalog,enabled:true},policy='You may publish and host your own original documents. Do not publish affiliate link farms or bulk pages intended to manipulate search rankings.';
  channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(channel,[{url:channel.rulesUrl,kind:'content_policy',text:policy,appliesTo:'leafmill',applicability:'verified'}]),
    {finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'});
  const accountId=randomUUID(),account={id:accountId,channelId:'leafmill',email:'owner@example.org',username:'owner@example.org',
    publicationUrl:'https://leafmill.net/',createdAt:stamp,status:'registered' as const,hasPassword:true,credentialKind:'api_token' as const,source:'imported' as const};
  task.accountId=accountId;task.leafmillOriginalPurpose=leafmillOriginalPurpose(task);
  const context=currentArticlePublicationContext([task],task),settings={...emptyState().settings,articleReviewMode:'ai' as const};
  let calls=0;const review=await reviewArticleDraft(task,site,channel,settings,{json:async()=>{calls++;return {verdict:'pass',reason:'The software checklist is independently useful.',
    citations:[{url:site.url,quote:site.description}],policyAssessment:{useKind:'original_editorial',verdict:'compatible',reason:'One original software document fits the stated hosting purpose.',citations:[
      {url:channel.rulesUrl,quote:'You may publish and host your own original documents.',purpose:'hosting_purpose'},
      {url:channel.rulesUrl,quote:'Do not publish affiliate link farms or bulk pages intended to manipulate search rankings.',purpose:'use_restriction'}]}} as never}},
    undefined,{account,publicationContext:context,fetchHtml:async url=>({url,html:`<main><p>${url===channel.rulesUrl?policy:site.description}</p></main>`})});
  assert.equal(calls,1,review.reason);assert.equal(review.status,'passed',review.reason);
  assert.equal(channelTermsBlockReason(site,channel,channel.termsCache),'policy_unknown');
  assert.equal(articleReviewStillValid({...task,articleReview:review},site,channel,settings,account),false);
  assert.equal(articleReviewStillValid({...task,articleReview:review},site,channel,settings,account,context),true);
  const added={...task,id:randomUUID(),siteId:randomUUID()};
  assert.equal(articleReviewStillValid({...task,articleReview:review},site,channel,settings,account,
    currentArticlePublicationContext([task,added],task)),false,'a newly planned second site revokes the frozen purpose review');
  assert.equal(articleReviewStillValid({...task,leafmillOriginalPurpose:undefined,articleReview:review},site,channel,settings,account,
    currentArticlePublicationContext([task],{...task,leafmillOriginalPurpose:undefined})),false,'missing source intent cannot use an old pass');
});
