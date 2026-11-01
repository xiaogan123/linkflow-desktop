import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {articleReviewStillValid,channelTermsBlockReason,reviewArticleDraft} from '../src/main/article-review';
import {buildChannelTermsCache,reviewedChannelTermsCache} from '../src/main/article-evidence';
import {emptyState} from '../src/main/store';
import type {AiPort,ArticlePublicationContext,Channel,Site,Task} from '../src/shared/types';

const POLICY='You may publish and host your own original documents on this service. Do not publish affiliate link farms or bulk pages intended to manipulate search rankings.';
const PURPOSE_CONTEXT:ArticlePublicationContext={scope:'isolated_acceptance_only',sameChannelTasks:1,distinctSites:1,publicationIntent:'single_original_article',workflowPurpose:'expand_backlink_channels',knownContentPattern:'unknown'};
function fixture(category:Site['category']){
  const stamp=new Date().toISOString(),site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Example Software',description:'Example Software documents a desktop checklist.',email:'owner@example.org',category,language:'en',monthlyTarget:1,status:'ready',createdAt:stamp};
  const channel:Channel={id:'policy-fixture',name:'Policy Fixture',domain:'host.example.org',url:'https://host.example.org/',submitUrl:'https://host.example.org/new',categories:['software','finance'],languages:['*'],kind:'article',emailRequired:false,accountRequired:false,articleRequired:true,free:'yes',freeNote:'fixture',automation:'api',quality:'B',qualityReason:'fixture',rulesUrl:'https://host.example.org/terms',checkedAt:'2026-10-24',notes:'fixture',allowedHosts:['host.example.org'],enabled:true,evidenceSources:[{url:'https://host.example.org/terms',kind:'content_policy',appliesTo:'policy-fixture',applicability:'verified'}]};
  channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(channel,[{url:channel.rulesUrl,kind:'content_policy',text:POLICY,appliesTo:channel.id,applicability:'verified'}]),{finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'});
  const task:Task={id:randomUUID(),siteId:site.id,channelId:channel.id,sourceDomain:channel.domain,status:'running',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'fixture',draftRevision:1,draft:{title:'A desktop diagnosis checklist',description:'An original method.',body:`Record the action and the observed behavior. Compare the result with the expected behavior before changing a setting. Read the [project source](${site.url}). Disclosure: this document describes our own Example Software project.`}};
  return {site,channel,task};
}

test('an unknown promotion policy blocks every site category until the owner decides, and no review AI is spent',async()=>{
  for(const category of ['software','ai','general','finance'] as const){
    const {site,channel,task}=fixture(category);
    assert.equal(channelTermsBlockReason(site,channel,channel.termsCache),'policy_unknown',category);
    let calls=0;const ai:AiPort={json:async()=>{calls++;throw Error('must not call AI')}};
    const review=await reviewArticleDraft(task,site,channel,{...emptyState().settings,articleReviewMode:'ai'},ai,undefined,{termsAi:ai,fetchHtml:async url=>({url,html:`<main><p>${url===channel.rulesUrl?POLICY:channel.termsCache?.sources.find(source=>source.url===url)?.text??site.description}</p></main>`})});
    assert.equal(review.status,'failed',category);assert.equal(calls,0,category);
  }
});

function fetcher(site:Site,channel:Channel){return async(url:string)=>({url,html:`<main><p>${url===channel.rulesUrl?POLICY:channel.termsCache?.sources.find(source=>source.url===url)?.text??site.description}</p></main>`})}
function answer(site:Site,channel:Channel){return {verdict:'pass',reason:'The original software checklist is supported by the source and has independent utility.',citations:[{url:site.url,quote:site.description}],policyAssessment:{useKind:'original_editorial',verdict:'compatible',reason:'This one original software document fits the cited hosting purpose and avoids the stated restriction.',citations:[{url:channel.rulesUrl,quote:'You may publish and host your own original documents on this service.',purpose:'hosting_purpose'},{url:channel.rulesUrl,quote:'Do not publish affiliate link farms or bulk pages intended to manipulate search rankings.',purpose:'use_restriction'}]}}}

test('a single original software document reaches purpose review without changing platform unknown',async()=>{
  const {site,channel,task}=fixture('software'),settings={...emptyState().settings,articleReviewMode:'ai' as const};let calls=0,seen:unknown,prompt='';
  const ai:AiPort={json:async(instruction,input)=>{calls++;prompt=instruction;seen=input;return answer(site,channel) as never}};
  const review=await reviewArticleDraft(task,site,channel,settings,ai,undefined,{publicationContext:PURPOSE_CONTEXT,fetchHtml:fetcher(site,channel)});
  assert.equal(review.status,'passed',review.reason);assert.equal(calls,1);
  assert.equal(channelTermsBlockReason(site,channel,channel.termsCache),'policy_unknown');
  assert.equal(review.policyAssessment?.publicationContext?.workflowPurpose,'expand_backlink_channels');
  assert.match(prompt,/整体目标是研发多个自动发布外链渠道/);
  assert.deepEqual((seen as {policyContext:{publicationContext:ArticlePublicationContext}}).policyContext.publicationContext,PURPOSE_CONTEXT);
  assert.equal(articleReviewStillValid({...task,articleReview:review},site,channel,settings),false,'fresh context is mandatory at publication');
  assert.equal(articleReviewStillValid({...task,articleReview:review},site,channel,settings,undefined,PURPOSE_CONTEXT),true);
});

test('software purpose review does not spend AI for absent intent, bulk or known promotional patterns',async()=>{
  for(const context of [undefined,{...PURPOSE_CONTEXT,workflowPurpose:undefined},{...PURPOSE_CONTEXT,publicationIntent:'unknown'},{...PURPOSE_CONTEXT,sameChannelTasks:2},{...PURPOSE_CONTEXT,sameAccountTasks:2},{...PURPOSE_CONTEXT,distinctSites:2},...(['promotion','affiliate_link_farm','bulk_search_manipulation'] as const).map(knownContentPattern=>({...PURPOSE_CONTEXT,knownContentPattern}))] as Array<ArticlePublicationContext|undefined>){
    const {site,channel,task}=fixture('software');let calls=0;const ai:AiPort={json:async()=>{calls++;throw Error('purpose AI should not run')}};
    const review=await reviewArticleDraft(task,site,channel,{...emptyState().settings,articleReviewMode:'ai'},ai,undefined,{publicationContext:context,fetchHtml:fetcher(site,channel)});
    assert.equal(review.status,'failed');assert.equal(review.reasonCode,context?.knownContentPattern==='affiliate_link_farm'||context?.knownContentPattern==='bulk_search_manipulation'?'content_rejected':'policy_unknown');assert.equal(calls,0);
  }
});

test('a single-article context does not admit finance or other non-software categories',async()=>{
  for(const category of ['finance','ai','general'] as const){
    const {site,channel,task}=fixture(category);let calls=0;
    const review=await reviewArticleDraft(task,site,channel,{...emptyState().settings,articleReviewMode:'ai'},{json:async()=>{calls++;throw Error('not eligible')}} ,undefined,{publicationContext:PURPOSE_CONTEXT,fetchHtml:fetcher(site,channel)});
    assert.equal(review.status,'failed',category);assert.equal(review.reasonCode,'policy_unknown',category);assert.equal(calls,0,category);
  }
});

test('no verified hosting policy source cannot be promoted by an AI answer',async()=>{
  const {site,channel,task}=fixture('software');channel.evidenceSources=[{url:channel.rulesUrl,kind:'content_policy',appliesTo:'other-channel',applicability:'verified'}];let calls=0;
  const review=await reviewArticleDraft(task,site,channel,{...emptyState().settings,articleReviewMode:'ai'},{json:async()=>{calls++;return answer(site,channel) as never}},undefined,{publicationContext:PURPOSE_CONTEXT,fetchHtml:fetcher(site,channel)});
  assert.equal(review.status,'failed');assert.equal(calls,0);
});

test('an explicit marketing draft is not relabeled as software editorial by purpose review',async()=>{
  const {site,channel,task}=fixture('software');task.draft={...task.draft!,body:`This is a marketing article for our Example Software project. Try the product through the [project source](${site.url}). Disclosure: this document promotes our own Example Software project.`};
  let seen:unknown;const review=await reviewArticleDraft(task,site,channel,{...emptyState().settings,articleReviewMode:'ai'},{json:async(_instruction,input)=>{seen=(input as {draft:unknown}).draft;return {...answer(site,channel),policyAssessment:{...answer(site,channel).policyAssessment,useKind:'promotion'}} as never}},undefined,{publicationContext:PURPOSE_CONTEXT,fetchHtml:fetcher(site,channel)});
  assert.deepEqual(seen,task.draft);assert.equal(review.status,'failed');assert.equal(review.reasonCode,'policy_unknown');
});

test('purpose review rejects marketing, affiliate, finance, ambiguity, missing hosting support and mismatched citations',async()=>{
  for(const change of [
    (value:ReturnType<typeof answer>)=>({...value,policyAssessment:{...value.policyAssessment,useKind:'promotion'}}),
    (value:ReturnType<typeof answer>)=>({...value,policyAssessment:{...value.policyAssessment,useKind:'affiliate'}}),
    (value:ReturnType<typeof answer>)=>({...value,policyAssessment:{...value.policyAssessment,useKind:'financial'}}),
    (value:ReturnType<typeof answer>)=>({...value,policyAssessment:{...value.policyAssessment,verdict:'unknown'}}),
    (value:ReturnType<typeof answer>)=>({...value,policyAssessment:{...value.policyAssessment,citations:value.policyAssessment.citations.slice(1)}}),
    (value:ReturnType<typeof answer>)=>({...value,policyAssessment:{...value.policyAssessment,citations:[{...value.policyAssessment.citations[0],quote:'This host welcomes all marketing campaigns.'},value.policyAssessment.citations[1]]}}),
  ]){
    const {site,channel,task}=fixture('software');const review=await reviewArticleDraft(task,site,channel,{...emptyState().settings,articleReviewMode:'ai'}, {json:async()=>change(answer(site,channel)) as never},undefined,{publicationContext:PURPOSE_CONTEXT,fetchHtml:fetcher(site,channel)});
    assert.equal(review.status,'failed');assert.ok(['policy_unknown','evidence_invalid'].includes(review.reasonCode??''),review.reasonCode);
  }
});

test('an applicable policy prohibition remains a content rejection even when it also permits hosting',async()=>{
  const {site,channel,task}=fixture('software'),forbiddenPolicy='You may publish and host your own original documents on this service. Do not publish promotional content of any kind.';
  channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(channel,[{url:channel.rulesUrl,kind:'content_policy',text:forbiddenPolicy,appliesTo:channel.id,applicability:'verified'}]),{finance:'unknown',promotion:'forbidden',disclosurePlacement:'unknown'});
  let calls=0;const review=await reviewArticleDraft(task,site,channel,{...emptyState().settings,articleReviewMode:'ai'},{json:async()=>{calls++;return answer(site,channel) as never}},undefined,{publicationContext:PURPOSE_CONTEXT,fetchHtml:async url=>({url,html:`<main><p>${url===channel.rulesUrl?forbiddenPolicy:site.description}</p></main>`})});
  assert.equal(review.status,'failed');assert.equal(calls,0);
});

test('purpose approval binds exact article, terms and all workflow counts; old or tampered context fails',async()=>{
  const {site,channel,task}=fixture('software'),settings={...emptyState().settings,articleReviewMode:'ai' as const};
  const review=await reviewArticleDraft(task,site,channel,settings,{json:async()=>answer(site,channel) as never},undefined,{publicationContext:PURPOSE_CONTEXT,fetchHtml:fetcher(site,channel)});
  assert.equal(review.status,'passed',review.reason);
  const changes=[{...PURPOSE_CONTEXT,sameChannelTasks:2},{...PURPOSE_CONTEXT,distinctSites:2},{...PURPOSE_CONTEXT,workflowPurpose:'ordinary_publication' as const},{...PURPOSE_CONTEXT,knownContentPattern:'promotion' as const}];
  for(const publicationContext of changes)assert.equal(articleReviewStillValid({...task,articleReview:{...review,policyAssessment:{...review.policyAssessment!,publicationContext}}},site,channel,settings,undefined,PURPOSE_CONTEXT),false);
  for(const currentContext of changes)assert.equal(articleReviewStillValid({...task,articleReview:review},site,channel,settings,undefined,currentContext),false);
  assert.equal(articleReviewStillValid({...task,id:randomUUID(),articleReview:review},site,channel,settings,undefined,PURPOSE_CONTEXT),false,'same draft on another task cannot inherit approval');
  assert.equal(articleReviewStillValid({...task,siteId:randomUUID(),articleReview:review},site,channel,settings,undefined,PURPOSE_CONTEXT),false);
  assert.equal(articleReviewStillValid({...task,channelId:'other-channel',articleReview:review},site,channel,settings,undefined,PURPOSE_CONTEXT),false);
  assert.equal(articleReviewStillValid({...task,draft:{...task.draft!,body:task.draft!.body+' New text.'},articleReview:review},site,channel,settings,undefined,PURPOSE_CONTEXT),false);
  assert.equal(articleReviewStillValid({...task,articleReview:review},site,{...channel,termsCache:{...channel.termsCache!,conclusionHash:'f'.repeat(64)}},settings,undefined,PURPOSE_CONTEXT),false);
  assert.equal(articleReviewStillValid({...task,articleReview:{...review,policyAssessment:{...review.policyAssessment!,publicationContext:{...PURPOSE_CONTEXT,workflowPurpose:undefined}}}},site,channel,settings,undefined,PURPOSE_CONTEXT),false);
});

test('purpose approval binds the specific publishing account and its live account count',async()=>{
  const {site,channel,task}=fixture('software'),settings={...emptyState().settings,articleReviewMode:'ai' as const};
  const account={id:randomUUID(),channelId:channel.id,username:'software-owner',publicationUrl:'https://host.example.org/software-owner'};
  const boundTask={...task,accountId:account.id},context={...PURPOSE_CONTEXT,sameAccountTasks:1};
  const review=await reviewArticleDraft(boundTask,site,channel,settings,{json:async()=>answer(site,channel) as never},undefined,{account,publicationContext:context,fetchHtml:fetcher(site,channel)});
  assert.equal(review.status,'passed',review.reason);
  assert.equal(articleReviewStillValid({...boundTask,articleReview:review},site,channel,settings,account,context),true);
  assert.equal(articleReviewStillValid({...boundTask,accountId:randomUUID(),articleReview:review},site,channel,settings,account,context),false);
  assert.equal(articleReviewStillValid({...boundTask,articleReview:review},site,channel,settings,{...account,id:randomUUID()},context),false);
  assert.equal(articleReviewStillValid({...boundTask,articleReview:review},site,channel,settings,account,{...context,sameAccountTasks:2}),false);
});

function hostingGuidanceFixture(){
  const value=fixture('software'),url='https://host.example.org/docs/hosting';
  const guidance={url,kind:'product_guidance' as const,appliesTo:value.channel.id,applicability:'verified' as const};
  value.channel.evidenceSources!.push(guidance);
  const sources=[...value.channel.termsCache!.sources,{...guidance,text:'Host original documentation websites with your own HTML. Public pages may be removed for abuse.'}];
  value.channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(value.channel,sources),{finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'});
  const result=answer(value.site,value.channel);
  result.policyAssessment.citations[0]={url,quote:'Host original documentation websites with your own HTML.',purpose:'hosting_purpose'};
  return {...value,url,result};
}

test('verified product guidance supports hosting purpose without granting promotional permission',async()=>{
  const {site,channel,task,result,url}=hostingGuidanceFixture(),settings={...emptyState().settings,articleReviewMode:'ai' as const};let seen:any;
  const review=await reviewArticleDraft(task,site,channel,settings,{json:async(_instruction,input)=>{seen=input;return result as never}},undefined,{publicationContext:PURPOSE_CONTEXT,fetchHtml:fetcher(site,channel)});
  assert.equal(review.status,'passed',review.reason);
  assert.equal(channel.termsCache!.promotion,'unknown');
  assert.equal(channelTermsBlockReason(site,channel,channel.termsCache),'policy_unknown');
  assert.ok(seen.policyContext.sources.some((source:any)=>source.url===url&&source.kind==='product_guidance'));
  assert.equal(articleReviewStillValid({...task,articleReview:review},site,channel,settings,undefined,PURPOSE_CONTEXT),true);
  // A new restriction beside an unchanged quoted sentence must invalidate the prior purpose review.
  const changed=structuredClone(channel);
  const sources=changed.termsCache!.sources.map(source=>source.url===url?{...source,text:source.text+' Do not host automatically generated articles.'}:source);
  changed.termsCache=buildChannelTermsCache(changed,sources,changed.termsCache);
  assert.equal(changed.termsCache.conclusionHash,channel.termsCache!.conclusionHash,'legal promotion decision is unchanged');
  assert.equal(articleReviewStillValid({...task,articleReview:review},site,changed,settings,undefined,PURPOSE_CONTEXT),false,'full hosting evidence is bound independently of legal conclusion hash');
});

test('product guidance cannot supply legal restrictions and API-only hosting claims remain insufficient',async()=>{
  for(const mode of ['guidance_restriction','api_purpose','undeclared_guidance','wrong_channel'] as const){
    const {site,channel,task,result,url}=hostingGuidanceFixture();
    if(mode==='guidance_restriction')result.policyAssessment.citations[1]={url,quote:'Public pages may be removed for abuse.',purpose:'use_restriction'};
    if(mode==='api_purpose'){
      channel.evidenceSources![1].kind='api';channel.termsCache!.sources[1].kind='api';
      channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(channel,channel.termsCache!.sources),{finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'});
    }
    if(mode==='undeclared_guidance')channel.evidenceSources=channel.evidenceSources!.slice(0,1);
    if(mode==='wrong_channel')channel.evidenceSources![1].appliesTo='different-host';
    const review=await reviewArticleDraft(task,site,channel,{...emptyState().settings,articleReviewMode:'ai'}, {json:async()=>result as never},undefined,{publicationContext:PURPOSE_CONTEXT,fetchHtml:fetcher(site,channel)});
    assert.equal(review.status,'failed',mode);assert.equal(review.reasonCode,'evidence_invalid',mode);
  }
});

test('product guidance without verified legal policy cannot enter the original-purpose exception',async()=>{
  const {site,channel,task,result}=hostingGuidanceFixture();
  channel.evidenceSources=channel.evidenceSources!.slice(1);
  channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(channel,channel.termsCache!.sources.slice(1)),{finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'});
  let calls=0;const review=await reviewArticleDraft(task,site,channel,{...emptyState().settings,articleReviewMode:'ai'}, {json:async()=>{calls++;return result as never}},undefined,{publicationContext:PURPOSE_CONTEXT,fetchHtml:fetcher(site,channel)});
  assert.equal(review.status,'failed');assert.equal(review.reasonCode,'policy_unknown');assert.equal(calls,0);
});
