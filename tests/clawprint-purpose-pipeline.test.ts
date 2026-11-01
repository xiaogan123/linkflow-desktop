import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {clawprintOriginalPurpose,clawprintSingleArticleCandidate,currentArticlePublicationContext,
  CLAWPRINT_SINGLE_ARTICLE_DRAFT_RULE} from '../src/main/article-publication-context';
import {buildChannelTermsCache,reviewedChannelTermsCache} from '../src/main/article-evidence';
import {articleReviewStillValid,channelTermsBlockReason,reviewArticleDraft} from '../src/main/article-review';
import {validateBackup} from '../src/main/backup-validation';
import {emptyState} from '../src/main/store';
import {schedulableTaskMatches,selectTaskPlatform} from '../src/main/planner';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {CHANNELS} from '../src/integrations/catalog';
import type {Account,Channel,Site,Task} from '../src/shared/types';

const stamp='2026-10-29T12:00:00.000Z';
const about='https://clawprint.org/about';
const invitation='Its contributors are AI agents. They publish poems, fiction, visual art, essays, field notes, and accounts of work in progress. Some build software.';
const target='https://software.example.org/releases';

function fixture(options:{sourceUrl?:string;sourceKind?:'api'|'content_policy';applicability?:'verified'|'unconfirmed';promotion?:'unknown'|'forbidden'}={}){
  const site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Software Example',
    description:'Public software release documentation',email:'owner@example.org',category:'software',language:'en',monthlyTarget:1,
    status:'ready',createdAt:stamp,topics:[{url:target,discoveredAt:stamp}]};
  const template=CHANNELS.find(item=>item.id==='leafmill');assert.ok(template);
  const sourceUrl=options.sourceUrl??about,sourceKind=options.sourceKind??'content_policy',applicability=options.applicability??'verified';
  const channel:Channel={...template,id:'clawprint',name:'Clawprint',domain:'clawprint.org',url:'https://clawprint.org/',
    rulesUrl:sourceUrl,submitUrl:'https://clawprint.org/api/posts',singleSiteOnly:true,enabled:true,
    evidenceSources:[{url:sourceUrl,kind:sourceKind,appliesTo:'clawprint',applicability}]};
  channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(channel,[{url:sourceUrl,kind:sourceKind,text:invitation,
    appliesTo:'clawprint',applicability}]),{finance:'unknown',promotion:options.promotion??'unknown',disclosurePlacement:'unknown'});
  const account:Account={id:randomUUID(),channelId:'clawprint',username:'SoftwareNotes',email:'',publicationUrl:'https://clawprint.org/u/SoftwareNotes',
    createdAt:stamp,status:'registered',hasPassword:true,credentialKind:'api_token'};
  const task:Task={id:randomUUID(),siteId:site.id,channelId:'clawprint',accountId:account.id,sourceDomain:'clawprint.org',
    status:'queued',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'test',draftRevision:1,topicUrl:target,
    draft:{title:'Recovering after an uncertain publish response',description:'A software field note with failure handling steps.',
      body:`Check the saved intent and remote readback before considering another write. See the [project releases](${target}) for context. Disclosure: this document describes our own Software Example project. The procedure is a proposal, not a guarantee.`}};
  task.clawprintOriginalPurpose=clawprintOriginalPurpose(task);
  const settings={...emptyState().settings,articleReviewMode:'ai' as const};
  return {site,channel,account,task,settings,policy:invitation};
}

async function review(f:ReturnType<typeof fixture>,assessment?:{useKind:'original_editorial'|'promotion'|'unknown';verdict:'compatible'|'forbidden'|'unknown';reason:string;citations:{url:string;quote:string;purpose:'editorial_scope'|'hosting_purpose'|'use_restriction'}[]}){
  let calls=0;
  const output=await reviewArticleDraft(f.task,f.site,f.channel,f.settings,{json:async()=>{calls++;
    return {verdict:'pass',reason:'The troubleshooting note provides independent operational value.',
      citations:[{url:f.site.url,quote:f.site.description}],policyAssessment:assessment??{
        useKind:'original_editorial',verdict:'compatible',reason:'The AI field note fits the publisher editorial scope.',
        citations:[{url:about,quote:invitation,purpose:'editorial_scope'}]}} as never;}},undefined,
    {account:f.account,publicationContext:currentArticlePublicationContext([f.task],f.task),
      fetchHtml:async url=>({url,html:`<main><p>${url===f.channel.rulesUrl?f.policy:f.site.description}</p></main>`})});
  return {output,calls};
}

test('only one generated original software field note receives the Clawprint purpose context',()=>{
  const f=fixture();assert.match(CLAWPRINT_SINGLE_ARTICLE_DRAFT_RULE,/AI 作者亲历/);
  assert.equal(clawprintSingleArticleCandidate([f.task],f.task,f.site,f.channel),true);
  assert.equal(currentArticlePublicationContext([f.task],f.task).publicationIntent,'single_original_article');
  assert.equal(currentArticlePublicationContext([f.task],f.task).workflowPurpose,'expand_backlink_channels');
  for(const changed of [{...f.task,clawprintOriginalPurpose:undefined},{...f.task,id:randomUUID()},
    {...f.task,siteId:randomUUID()},{...f.task,draftRevision:2},
    {...f.task,draft:{...f.task.draft!,body:f.task.draft!.body+' Changed.'}},
    {...f.task,channelId:'leafmill'}])
    assert.equal(currentArticlePublicationContext([changed],changed).publicationIntent,'unknown');
  assert.equal(clawprintSingleArticleCandidate([f.task],f.task,{...f.site,category:'finance'},f.channel),false);
  assert.equal(clawprintSingleArticleCandidate([f.task],f.task,f.site,{...f.channel,singleSiteOnly:false}),false);
  assert.equal(clawprintSingleArticleCandidate([f.task,{...f.task,id:randomUUID()}],f.task,f.site,f.channel),false);
});

test('planner offers the sole software draft for review but rejects a second site or forbidden policy',()=>{
  const f=fixture(),state=emptyState();state.sites=[f.site];state.tasks=[{...f.task,channelId:'',sourceDomain:'',clawprintOriginalPurpose:undefined}];
  state.accounts=[f.account];state.accountBindings=[{id:randomUUID(),siteId:f.site.id,channelId:'clawprint',accountId:f.account.id,
    createdAt:stamp,updatedAt:stamp}];state.settings.channelOverrides.clawprint=true;
  f.site.qualifications={software:f.site.url};
  const match={channel:f.channel,score:100,reason:'original software field note'};
  assert.equal(channelExecutionReadiness(state,f.site.id,f.channel).kind,'ready');
  assert.equal(schedulableTaskMatches(state,state.tasks[0],[match],new Date(stamp)).length,1);
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(stamp))?.id,'clawprint');
  state.tasks.push({...f.task,id:randomUUID(),siteId:randomUUID()});
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(stamp)),undefined);
  state.tasks.pop();f.channel.termsCache={...f.channel.termsCache!,promotion:'forbidden'};
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(stamp)),undefined);
});

test('planner never selects Clawprint for an eligible software site without a connected key',()=>{
  const f=fixture(),state=emptyState();state.sites=[f.site];state.tasks=[{...f.task,channelId:'',sourceDomain:'',accountId:undefined,clawprintOriginalPurpose:undefined}];
  state.settings.channelOverrides.clawprint=true;f.site.qualifications={software:f.site.url};
  const match={channel:f.channel,score:100,reason:'original software field note'};
  assert.equal(channelExecutionReadiness(state,f.site.id,f.channel).kind,'handoff_required');
  assert.equal(schedulableTaskMatches(state,state.tasks[0],[match],new Date(stamp)).length,0);
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(stamp)),undefined);
  state.accounts=[f.account];
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(stamp)),undefined);
  state.accountBindings=[{id:randomUUID(),siteId:f.site.id,channelId:'clawprint',accountId:f.account.id,createdAt:stamp,updatedAt:stamp}];
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(stamp))?.id,'clawprint');
});

test('provider editorial invitation permits one genuine review without upgrading promotion policy',async()=>{
  const f=fixture(),{output,calls}=await review(f);
  assert.equal(calls,1,output.reason);assert.equal(output.status,'passed',output.reason);
  assert.equal(output.policyAssessment?.citations[0].purpose,'editorial_scope');
  assert.equal(channelTermsBlockReason(f.site,f.channel,f.channel.termsCache),'policy_unknown');
  assert.equal(articleReviewStillValid({...f.task,articleReview:output},f.site,f.channel,f.settings,f.account),false);
  assert.equal(articleReviewStillValid({...f.task,articleReview:output},f.site,f.channel,f.settings,f.account,
    currentArticlePublicationContext([f.task],f.task)),true);
  for(const changed of [{...f.task,clawprintOriginalPurpose:undefined},{...f.task,draft:{...f.task.draft!,body:f.task.draft!.body+' edited'}},
    {...f.task,accountId:randomUUID()}])
    assert.equal(articleReviewStillValid({...changed,articleReview:output},f.site,f.channel,f.settings,f.account,
      currentArticlePublicationContext([changed],changed)),false);
  const second={...f.task,id:randomUUID(),siteId:randomUUID()};
  assert.equal(articleReviewStillValid({...f.task,articleReview:output},f.site,f.channel,f.settings,f.account,
    currentArticlePublicationContext([f.task,second],f.task)),false);
});

test('unverified or unrelated sources, bad quotations, and a forbidden policy cannot pass',async()=>{
  for(const options of [{sourceKind:'api' as const},{applicability:'unconfirmed' as const},{promotion:'forbidden' as const}]){
    const f=fixture(options),{output,calls}=await review(f);assert.equal(output.status,'failed');assert.equal(calls,0);
  }
  for(const assessment of [
    {useKind:'original_editorial' as const,verdict:'compatible' as const,reason:'Generic hosting only',citations:[{url:about,quote:invitation,purpose:'hosting_purpose' as const}]},
    {useKind:'promotion' as const,verdict:'compatible' as const,reason:'Promotion',citations:[{url:about,quote:invitation,purpose:'editorial_scope' as const}]},
    {useKind:'unknown' as const,verdict:'compatible' as const,reason:'Unknown intent',citations:[{url:about,quote:invitation,purpose:'editorial_scope' as const}]},
    {useKind:'original_editorial' as const,verdict:'compatible' as const,reason:'Bad quote',citations:[{url:about,quote:'This exact invitation is not on the provider page.',purpose:'editorial_scope' as const}]},
    {useKind:'original_editorial' as const,verdict:'compatible' as const,reason:'Wrong source',citations:[{url:'https://example.net/about',quote:invitation,purpose:'editorial_scope' as const}]},
  ]){const f=fixture(),{output}=await review(f,assessment);assert.equal(output.status,'failed',assessment.reason)}
  const f=fixture();f.site.category='finance';assert.equal((await review(f)).calls,0);
  const copied=fixture();copied.task.clawprintOriginalPurpose=undefined;assert.equal((await review(copied)).calls,0);
  const repeated=fixture();const second={...repeated.task,id:randomUUID(),accountId:repeated.account.id};
  assert.equal(currentArticlePublicationContext([repeated.task,second],repeated.task).sameAccountTasks,2);
});

test('backup retains Clawprint marker and formal editorial assessment',async()=>{
  const f=fixture(),{output}=await review(f);assert.equal(output.status,'passed',output.reason);
  f.task.articleReview=output;const state=emptyState();state.sites=[f.site];state.tasks=[f.task];state.accounts=[f.account];
  const secrets={[`account:${f.account.id}`]:JSON.stringify({version:1,apiKey:'test-only-api-key-123456'})};
  const restored=validateBackup({state,secrets});
  assert.deepEqual(restored.state.tasks[0].clawprintOriginalPurpose,f.task.clawprintOriginalPurpose);
  assert.equal(restored.state.tasks[0].articleReview?.policyAssessment?.citations[0].purpose,'editorial_scope');
  const malformed=structuredClone(state);malformed.tasks[0].clawprintOriginalPurpose={...f.task.clawprintOriginalPurpose!,contentHash:'bad'};
  assert.throws(()=>validateBackup({state:malformed,secrets}));
});
