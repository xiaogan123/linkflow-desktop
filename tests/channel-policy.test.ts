import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CHANNELS} from '../src/integrations/catalog';
import {applyChannelPolicyDecision,canConfirmMissingPolicy,channelPolicyScopeHash,currentChannelPolicyDecision,migrateChannelPolicyScopeHashes,supportsOfficialGuidanceReview} from '../src/main/channel-policy';
import {articleReviewStillValid,prepareChannelTerms,reviewArticleDraft} from '../src/main/article-review';
import {aiInputCharacters,MAX_AI_INPUT_CHARS} from '../src/integrations/ai';
import {emptyState,migrateState} from '../src/main/store';
import {validateBackup} from '../src/main/backup-validation';
import {saveTaskDraft} from '../src/main/task-draft';
import {TaskReasonError} from '../src/shared/task-reasons';
import type {AiPort,Site,Task} from '../src/shared/types';
const channel=CHANNELS.find(item=>item.id==='telegraph')!;
function fixture(){const state=emptyState(),stamp=new Date().toISOString();state.settings.articleReviewMode='ai';state.sites=[{id:'11111111-1111-4111-8111-111111111111',domain:'policy-fixture.com',url:'https://policy-fixture.com/',email:'owner@example.com',name:'Fixture',description:'Educational material',category:'finance',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp}];state.tasks=[{id:'22222222-2222-4222-8222-222222222222',siteId:state.sites[0].id,channelId:channel.id,sourceDomain:channel.domain,status:'needs_input',checkpoint:'article_review',createdAt:stamp,updatedAt:stamp,scheduledAt:stamp,attempts:0,message:'',draftRevision:1,draft:{title:'Source checklist',description:'Operator note',body:'We operate this website and receive referral commissions. This checklist records dates and compares public sources. Trading can lose money. Read the [public source](https://policy-fixture.com/).'}}];return state;}
const siteQuote='We operate this website and receive referral commissions.';
const channelQuote='Telegraph is a publishing tool that lets you create richly formatted posts.';
const fetchHtml=async(url:string)=>({url,html:url.startsWith('https://policy-fixture.com/')?'<p>'+siteQuote+'</p>':'<p>'+channelQuote+'</p>'});
const unknownTerms:AiPort={json:async()=>({finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown',reason:'No verified content policy supplied.',citations:[]}) as never};
const facts:AiPort={json:async()=>({verdict:'pass',reason:'The cited site fact matches.',citations:[{url:'https://policy-fixture.com/',quote:siteQuote}]}) as never};

test('official guidance with no stated prohibition is analyzed once and lets the fact review run',async()=>{
  const state=fixture(),candidate={...channel};let termsCalls=0,factCalls=0,termsInput:unknown;
  const termsAi:AiPort={json:async(_instruction,data)=>{termsCalls++;termsInput=data;return unknownTerms.json('',{})}};
  const review=await reviewArticleDraft(state.tasks[0],state.sites[0],candidate,state.settings,{json:async()=>{factCalls++;return facts.json('',{})}},undefined,{fetchHtml,termsAi,onTermsCache:cache=>{candidate.termsCache=cache}});
  // As before batch 9b: trusted guidance without a prohibition needs no owner decision; facts are still checked.
  assert.equal(review.status,'passed',review.reason);assert.equal(review.policyDecision,undefined);assert.equal(termsCalls,1);assert.equal(factCalls,1);
  assert.equal(candidate.termsCache?.finance,'unknown');assert.equal(candidate.termsCache?.promotion,'unknown');
  const sources=(termsInput as {sources:{kind:string}[]}).sources;assert.ok(sources.some(source=>source.kind==='api'));assert.ok(sources.some(source=>source.kind==='product_guidance'));
  const reused=await prepareChannelTerms(candidate,termsAi,undefined,{fetchHtml});assert.equal(reused.conclusionHash,candidate.termsCache?.conclusionHash);assert.equal(termsCalls,1);
});

test('an explicit current owner choice permits one fact-only review without re-analyzing guidance',async()=>{
  const state=fixture(),candidate={...channel};applyChannelPolicyDecision(state,state.sites[0].id,candidate,true);let factCalls=0,seen:unknown,instruction='';
  const review=await reviewArticleDraft(state.tasks[0],state.sites[0],candidate,state.settings,{json:async(prompt,data)=>{factCalls++;instruction=prompt;seen=data;return facts.json('',{})}},undefined,{fetchHtml,termsAi:unknownTerms,onTermsCache:cache=>{candidate.termsCache=cache}});
  assert.equal(review.status,'passed',review.reason);assert.equal(factCalls,1);assert.equal(review.checks,undefined);assert.equal(review.policyDecision,undefined);
  assert.match(instruction,/只核对稿件/);assert.doesNotMatch(instruction,/knownChannelRestrictions|channelRules/);
  assert.deepEqual((seen as {draft:unknown}).draft,state.tasks[0].draft);
  assert.ok((seen as {evidence:{kind:string}[]}).evidence.every(row=>!['api','rules','product_guidance','content_policy'].includes(row.kind)));
  assert.equal(articleReviewStillValid({...state.tasks[0],articleReview:review},state.sites[0],candidate,state.settings),true);
  // A guidance-only platform passes with unknown terms even without the owner's choice, exactly as at review time.
  assert.equal(articleReviewStillValid({...state.tasks[0],articleReview:review},{...state.sites[0],channelPolicyDecisions:{}},candidate,state.settings),true);
  // A prohibition still voids the review, e.g. the site was switched to finance on a platform that forbids it.
  const forbidden={...candidate,termsCache:{...candidate.termsCache!,finance:'forbidden' as const}};
  assert.equal(articleReviewStillValid({...state.tasks[0],articleReview:review},{...state.sites[0],category:'finance'},forbidden,state.settings),false);
});

test('fact rejection and fabricated citations remain blocked after a valid owner choice',async()=>{
  const state=fixture();applyChannelPolicyDecision(state,state.sites[0].id,channel,true);
  for(const output of [{verdict:'reject',reason:'Fact unsupported.',citations:[]},{verdict:'pass',reason:'Looks fine.',citations:[{url:state.sites[0].url,quote:'This source text was never fetched.'}]}]){
    const candidate={...channel},review=await reviewArticleDraft(state.tasks[0],state.sites[0],candidate,state.settings,{json:async()=>output as never},undefined,{fetchHtml,termsAi:unknownTerms});
    assert.equal(review.status,'failed');assert.ok(['content_rejected','evidence_invalid'].includes(review.reasonCode??''));
  }
});

test('policy decisions have explicit identity and ninety-day boundaries',()=>{
 const state=fixture(),now=new Date('2026-10-18T00:00:00.000Z');applyChannelPolicyDecision(state,state.sites[0].id,channel,true,now);assert.ok(currentChannelPolicyDecision(state.sites[0],channel,now));
 assert.equal(currentChannelPolicyDecision({...state.sites[0],id:'another'},channel,now),undefined);
 assert.equal(currentChannelPolicyDecision({...state.sites[0],domain:'changed.com'},channel,now),undefined);
 assert.equal(currentChannelPolicyDecision({...state.sites[0],url:'https://policy-fixture.com/moved'},channel,now),undefined);
 assert.ok(currentChannelPolicyDecision(state.sites[0],{...channel,notes:channel.notes+' changed'},now));
 assert.ok(currentChannelPolicyDecision(state.sites[0],channel,new Date(now.getTime()+90*86400000)));
 assert.equal(currentChannelPolicyDecision(state.sites[0],channel,new Date(now.getTime()+90*86400000+1)),undefined);
 assert.throws(()=>applyChannelPolicyDecision(state,state.sites[0].id,{...channel,provenance:'custom'},true));assert.equal(state.sites[0].channelPolicyDecisions![channel.id].scopeHash,channelPolicyScopeHash(state.sites[0],channel));
});

test('Telegraph confirmation preserves only canonical trusted evidence edits',()=>{
 const state=fixture(),owner=state.sites[0],now=new Date('2026-10-18T00:00:00.000Z');applyChannelPolicyDecision(state,owner.id,channel,true,now);
 const reordered={...channel,rulesUrl:`${channel.rulesUrl}/`,evidenceSources:[...channel.evidenceSources!].reverse().map(source=>({...source,url:`${source.url}/`}))};
 assert.equal(canConfirmMissingPolicy(reordered),true);
 assert.ok(currentChannelPolicyDecision(owner,reordered,now));
 const unsafe=[
  {...reordered,rulesUrl:'https://telegram.org/blog/telegraph'},
  {...reordered,evidenceSources:[...reordered.evidenceSources,{url:'https://example.com/policy',kind:'content_policy' as const,appliesTo:'telegraph',applicability:'verified' as const}]},
  {...reordered,evidenceSources:reordered.evidenceSources.map((source,index)=>index?source:{...source,url:`${source.url}?changed=1`})},
  {...reordered,evidenceSources:reordered.evidenceSources.map((source,index)=>index?source:{...source,applicability:'unconfirmed' as const})},
 ];
 for(const candidate of unsafe){assert.equal(canConfirmMissingPolicy(candidate),false);assert.equal(currentChannelPolicyDecision(owner,candidate,now),undefined)}
});
test('historical v1 and v2 owner choices migrate to v3 without granting another site',()=>{
 const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const originalNotes='通过官方 API 创建作者和文章，令牌仅加密保存在本机。现有官方来源为接口文档，不代表已确认所有内容或返佣推广规则；AI 无法核实时会交给用户。文章须有独立价值，明确作者与网站关系，不批量复制或堆放链接。';
 assert.equal(channel.notes,originalNotes);
 for(const version of ['early-v1','late-v1','v2'] as const){
  const state=fixture(),owner=state.sites[0],siteV1={id:owner.id,domain:owner.domain,url:owner.url};
  const base={id:channel.id,domain:channel.domain,rulesUrl:channel.rulesUrl};
  const scope=version==='early-v1'?{version:1,site:siteV1,channel:{...base,checkedAt:'2026-09-27',notes:originalNotes,evidenceSources:channel.evidenceSources}}:
   version==='late-v1'?{version:1,site:siteV1,channel:{...base,evidenceSources:channel.evidenceSources}}:
   {version:2,site:{...siteV1,category:owner.category,language:owner.language},channel:{...base,evidenceSources:channel.evidenceSources,audience:channel.audience,promotionPolicy:channel.promotionPolicy,promotionPolicySource:channel.promotionPolicySource,languages:channel.languages,retentionDays:channel.retentionDays,irreversible:channel.irreversible}};
  owner.channelPolicyDecisions={telegraph:{decision:'use_without_confirmed_policy',scopeHash:digest(scope),confirmedAt:new Date().toISOString()}};
  assert.equal(currentChannelPolicyDecision(owner,channel)?.scopeHash,channelPolicyScopeHash(owner,channel),version);
  migrateState(state);
  assert.equal(owner.channelPolicyDecisions.telegraph.scopeHash,channelPolicyScopeHash(owner,channel),version);
  assert.equal(currentChannelPolicyDecision({...owner,id:'another-site'},channel),undefined,version);
 }
});
test('scope v3 preserves a choice across still-applicable catalog edits and blocks incompatible use',()=>{
 const state=fixture(),owner=state.sites[0];applyChannelPolicyDecision(state,owner.id,channel,true);
 const changed={...channel,audience:['general','finance'] as NonNullable<typeof channel.audience>,languages:['en','zh'],promotionPolicy:'unknown' as const,notes:'Updated explanatory copy'};
 assert.ok(currentChannelPolicyDecision(owner,changed));
 assert.equal(currentChannelPolicyDecision(owner,{...changed,audience:['software']}),undefined);
 assert.equal(currentChannelPolicyDecision(owner,{...changed,languages:['zh']}),undefined);
 assert.equal(currentChannelPolicyDecision(owner,{...changed,promotionPolicy:'forbidden'}),undefined);
 const oldState=fixture(),oldOwner=oldState.sites[0];
 const oldScope={version:2,site:{id:oldOwner.id,domain:oldOwner.domain,url:oldOwner.url,category:oldOwner.category,language:oldOwner.language},channel:{id:channel.id,domain:channel.domain,rulesUrl:channel.rulesUrl,evidenceSources:channel.evidenceSources,audience:channel.audience,promotionPolicy:channel.promotionPolicy,promotionPolicySource:channel.promotionPolicySource,languages:channel.languages,retentionDays:channel.retentionDays,irreversible:channel.irreversible}};
 oldOwner.channelPolicyDecisions={telegraph:{decision:'use_without_confirmed_policy',scopeHash:createHash('sha256').update(JSON.stringify(oldScope)).digest('hex'),confirmedAt:new Date().toISOString()}};
 const safelyReordered={...changed,rulesUrl:`${changed.rulesUrl}/`,evidenceSources:[...changed.evidenceSources!].reverse()};
 migrateChannelPolicyScopeHashes(oldState,[safelyReordered]);
 assert.equal(oldOwner.channelPolicyDecisions.telegraph.scopeHash,channelPolicyScopeHash(oldOwner,safelyReordered));
});
test('grant/revoke do not replace drafts or unpause sites, and restore cannot grant authorization',()=>{
 const state=fixture(),draft=structuredClone(state.tasks[0].draft);state.sites[0].status='paused';state.settings.autoRun=false;applyChannelPolicyDecision(state,state.sites[0].id,channel,true);assert.deepEqual(state.tasks[0].draft,draft);assert.equal(state.tasks[0].status,'queued');assert.equal(state.sites[0].status,'paused');assert.equal(state.settings.autoRun,false);const restored=validateBackup({state,secrets:{}});assert.equal(restored.state.sites[0].channelPolicyDecisions,undefined);applyChannelPolicyDecision(state,state.sites[0].id,channel,false);assert.equal(state.tasks[0].status,'needs_input');
});
test('saving changed AI draft queues an independent review; manual, paused and submitted boundaries hold',()=>{
 const state=fixture();state.settings.autoRun=false;state.sites[0].status='paused';const changed={...state.tasks[0].draft!,body:state.tasks[0].draft!.body+' Updated.'};assert.equal(saveTaskDraft(state,state.tasks[0].id,changed),true);assert.equal(state.tasks[0].draftRevision,2);assert.equal(state.tasks[0].status,'queued');assert.equal(state.sites[0].status,'paused');assert.equal(state.settings.autoRun,false);assert.equal(state.tasks[0].articleApprovedAt,undefined);
 const manual=fixture();manual.sites[0].articleReviewMode='manual';assert.equal(saveTaskDraft(manual,manual.tasks[0].id,changed),false);assert.equal(manual.tasks[0].status,'needs_input');const submitted=fixture();submitted.tasks[0].submittedAt=new Date().toISOString();assert.throws(()=>saveTaskDraft(submitted,submitted.tasks[0].id,changed));assert.equal(submitted.tasks[0].draftRevision,1);
});

 test('channel confirmation never reactivates skipped article tasks',()=>{const state=fixture();state.tasks[0].status='skipped';for(const allow of [true,false]){applyChannelPolicyDecision(state,state.sites[0].id,channel,allow);assert.equal(state.tasks[0].status,'skipped');}});

test('policy source fetch errors and redirects fail before article facts are called',async()=>{
  const state=fixture();applyChannelPolicyDecision(state,state.sites[0].id,channel,true);let calls=0;
  for(const fetch of [async (_url:string)=>{throw Error('offline')},async (url:string)=>({url:url==='https://telegra.ph/api'?'https://telegra.ph/other':url,html:'<p>'+channelQuote+'</p>'})]){
    const review=await reviewArticleDraft(state.tasks[0],state.sites[0],{...channel},state.settings,{json:async()=>{calls++;return facts.json('',{})}},undefined,{fetchHtml:fetch,termsAi:unknownTerms});
    assert.equal(review.status,'failed');assert.equal(review.reasonCode,'evidence_fetch_failed');
  }
  assert.equal(calls,0);
});

test('official guidance channels retain strict source identity and unknown policy status',async()=>{
  for(const id of ['paper-wf','docs-md','markdrop','verbose']){
    const candidate=CHANNELS.find(item=>item.id===id)!;assert.equal(supportsOfficialGuidanceReview(candidate),true);
    const sourceText='Official product and API guidance for publishing public content.';
    const fetch=async(url:string)=>({url,html:'<p>'+sourceText+'</p>'});
    const cache=await prepareChannelTerms({...candidate,termsCache:undefined},unknownTerms,undefined,{fetchHtml:fetch});
    assert.equal(cache.reviewVersion,2,id);assert.equal(cache.finance,'unknown',id);assert.equal(cache.promotion,'unknown',id);
    for(const variant of [{...candidate,provenance:'custom' as const},{...candidate,domain:'elsewhere.invalid'},...((candidate.evidenceSources?.length??0)>1?[{...candidate,evidenceSources:candidate.evidenceSources?.slice(0,1)}]:[])])assert.equal(supportsOfficialGuidanceReview(variant),false);
  }
});

test('large official policy pages are bounded for the single terms review',async()=>{
  const candidate=CHANNELS.find(item=>item.id==='markdrop')!;let input:unknown,instruction='';
  const termsAi:AiPort={json:async(prompt,data)=>{instruction=prompt;input=data;return unknownTerms.json('',{})}};
  const cache=await prepareChannelTerms({...candidate,termsCache:undefined},termsAi,undefined,{fetchHtml:async url=>({url,html:'<p>'+'Official publishing guidance. '.repeat(1500)+'</p>'})});
  assert.equal(cache.reviewVersion,2);assert.ok(aiInputCharacters(instruction,input)<=MAX_AI_INPUT_CHARS);
  for(const source of (input as {sources:{text:string}[]}).sources)assert.ok(source.text.length<=8000);
});

test('a terms AI outage or quota is retried as an AI failure, and only an uncheckable answer leaves terms unknown',async()=>{
  for(const [error,code] of [[new TaskReasonError('temporary_failure','upstream 503'),'ai_unavailable'],[new TaskReasonError('ai_daily_limit','daily limit'),'ai_daily_limit']] as const){
    const state=fixture(),candidate={...channel};
    const review=await reviewArticleDraft(state.tasks[0],state.sites[0],candidate,state.settings,facts,undefined,{fetchHtml,termsAi:{json:async()=>{throw error}}});
    assert.equal(review.status,'failed');assert.equal(review.reasonCode,code);
  }
  const state=fixture(),candidate={...channel};
  const bad=await reviewArticleDraft(state.tasks[0],state.sites[0],candidate,state.settings,facts,undefined,{fetchHtml,termsAi:{json:async()=>({finance:'allowed'}) as never}});
  assert.equal(bad.reasonCode,'policy_unknown');
});

test('a platform without a verified policy page or official guidance gets its unknown terms without an AI call',async()=>{
  const base=CHANNELS.find(item=>item.id==='agentsgather')!;
  assert.equal(supportsOfficialGuidanceReview(base),false);
  let calls=0;const termsAi:AiPort={json:async()=>{calls++;return unknownTerms.json('',{})}};
  const cache=await prepareChannelTerms({...base},termsAi,undefined,{fetchHtml:async(url:string)=>({url,html:'<p>'+channelQuote+' Agents post through the documented API.</p>'})});
  assert.equal(calls,0);assert.equal(cache.reviewVersion,2);assert.equal(cache.promotion,'unknown');
});
