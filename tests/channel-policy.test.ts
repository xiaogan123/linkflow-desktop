import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS} from '../src/integrations/catalog';
import {applyChannelPolicyDecision,channelPolicyScopeHash,currentChannelPolicyDecision,supportsOfficialGuidanceReview} from '../src/main/channel-policy';
import {articleReviewStillValid,reviewArticleDraft} from '../src/main/article-review';
import {emptyState} from '../src/main/store';
import {validateBackup} from '../src/main/backup-validation';
import {saveTaskDraft} from '../src/main/task-draft';
import type {AiPort,ArticleChecks,Site,Task} from '../src/shared/types';
const channel=CHANNELS.find(item=>item.id==='telegraph')!;
function fixture(){const state=emptyState(),stamp=new Date().toISOString();state.settings.articleReviewMode='ai';state.sites=[{id:'11111111-1111-4111-8111-111111111111',domain:'policy-fixture.com',url:'https://policy-fixture.com/',email:'owner@example.com',name:'Fixture',description:'Educational material',category:'finance',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp}];state.tasks=[{id:'22222222-2222-4222-8222-222222222222',siteId:state.sites[0].id,channelId:channel.id,sourceDomain:channel.domain,status:'needs_input',checkpoint:'article_review',createdAt:stamp,updatedAt:stamp,scheduledAt:stamp,attempts:0,message:'',draftRevision:1,draft:{title:'Source checklist',description:'Operator note',body:'We operate this website and receive referral commissions. This checklist records dates and compares public sources. Trading can lose money.'}}];return state;}
const checks:ArticleChecks={factualAccuracy:'pass',authorRelationship:'pass',affiliateDisclosure:'pass',independentValue:'pass',financialSafety:'pass',channelRules:'unknown'};
const siteQuote='We operate this website and receive referral commissions.';
const channelQuote='Telegraph is a publishing tool that lets you create richly formatted posts.';
const fetchHtml=async(url:string)=>({url,html:url.startsWith('https://policy-fixture.com/')?'<p>'+siteQuote+'</p>':'<p>'+channelQuote+'</p>'});
function model(values:Record<string,unknown>={}):AiPort{return {json:async()=>({knownChannelRestrictions:'pass',verdict:'unknown',reason:'Content and use fit the known official guidance; full policy remains unknown.',checks:{...checks},citations:[{url:'https://policy-fixture.com/',quote:siteQuote},{url:'https://telegram.org/blog/telegraph',quote:channelQuote}],...values}) as never};}

test('official Telegraph guidance runs independent AI review without fabricating a policy decision',async()=>{
 const state=fixture();let calls=0;const semantic=model();let input:unknown,instruction='';
 const r=await reviewArticleDraft(state.tasks[0],state.sites[0],channel,state.settings,{json:async(...args)=>{calls++;instruction=args[0];input=args[1];return semantic.json(...args)}},undefined,{fetchHtml});
 assert.equal(calls,1);assert.equal(r.status,'passed');assert.equal(r.reasonCode,'passed');assert.equal(r.checks?.channelRules,'unknown');assert.equal(r.policyDecision,undefined);assert.equal(state.sites[0].channelPolicyDecisions,undefined);assert.match(r.reason,/尚未找到完整适用内容政策/);assert.match(instruction,/knownChannelRestrictions/);
 assert.deepEqual((input as {draft:unknown}).draft,state.tasks[0].draft);assert.equal(articleReviewStillValid({...state.tasks[0],articleReview:r},state.sites[0],channel,state.settings),true);
 const sources=(input as {evidence:{kind:string}[]}).evidence;assert.ok(sources.some(item=>item.kind==='api'));assert.ok(sources.some(item=>item.kind==='product_guidance'));assert.equal(sources.some(item=>item.kind==='content_policy'),false);
});

test('guidance review requires an explicit independent known-restrictions result',async()=>{
 for(const update of [{knownChannelRestrictions:'unknown'},{knownChannelRestrictions:'fail'},{knownChannelRestrictions:undefined},{knownChannelRestrictions:'allowed'},{verdict:'pass',checks:{...checks,channelRules:'pass'}}]){
  const state=fixture(),r=await reviewArticleDraft(state.tasks[0],state.sites[0],channel,state.settings,model(update),undefined,{fetchHtml});assert.equal(r.status,'failed');
  if(update.knownChannelRestrictions==='fail')assert.equal(r.checks?.channelRules,'fail');
 }
});

test('missing policy cannot bypass an explicit prohibition even with an old native decision',async()=>{
 const state=fixture();applyChannelPolicyDecision(state,state.sites[0].id,channel,true);
 const r=await reviewArticleDraft(state.tasks[0],state.sites[0],channel,state.settings,model({verdict:'reject',knownChannelRestrictions:'fail',reason:'The fetched official guidance explicitly prohibits this use.'}),undefined,{fetchHtml});
 assert.equal(r.status,'failed');assert.equal(r.checks?.channelRules,'fail');assert.equal(r.reasonCode,'content_rejected');
});

test('automatic guidance review is limited to exact trusted built-in Telegraph sources',async()=>{
 const source=channel.evidenceSources!;
 const variants=[{...channel,provenance:'custom' as const},{...channel,id:'other'},{...channel,automation:'browser' as const},{...channel,evidenceSources:[source[0]]},{...channel,evidenceSources:[source[0],{...source[1],url:'https://telegra.ph/Terms-01-01'}]},{...channel,evidenceSources:[source[0],{...source[1],appliesTo:'other'}]},{...channel,evidenceSources:[source[0],{...source[1],applicability:'unconfirmed' as const}]}];
 for(const candidate of variants){
  assert.equal(supportsOfficialGuidanceReview(candidate),false);const state=fixture();let calls=0;
  const r=await reviewArticleDraft(state.tasks[0],state.sites[0],candidate,state.settings,{json:async()=>{calls++;return {} as never}},undefined,{fetchHtml});assert.equal(calls,0);assert.equal(r.status,'failed');assert.equal(r.reasonCode,'policy_not_found');
 }
});
test('legacy confirmed use still requires fresh content and known-guidance checks',async()=>{
 const state=fixture();applyChannelPolicyDecision(state,state.sites[0].id,channel,true);const r=await reviewArticleDraft(state.tasks[0],state.sites[0],channel,state.settings,model(),undefined,{fetchHtml});assert.equal(r.status,'passed');assert.equal(r.reasonCode,'passed');assert.equal(r.checks?.channelRules,'unknown');assert.equal(r.policyDecision,undefined);assert.equal(articleReviewStillValid({...state.tasks[0],articleReview:r},state.sites[0],channel,state.settings),true);
 const changed={...state.sites[0],channelPolicyDecisions:{}};assert.equal(articleReviewStillValid({...state.tasks[0],articleReview:r},changed,channel,state.settings),false);
});
test('confirmed channel cannot override content unknown/fail, explicit policy fail or rejection',async()=>{
 for(const update of [{checks:{...checks,factualAccuracy:'unknown'}},{checks:{...checks,authorRelationship:'unknown'}},{checks:{...checks,affiliateDisclosure:'fail'}},{checks:{...checks,independentValue:'fail'}},{checks:{...checks,financialSafety:'unknown'}},{checks:{...checks,channelRules:'fail'}},{verdict:'reject'}]){const state=fixture();applyChannelPolicyDecision(state,state.sites[0].id,channel,true);const r=await reviewArticleDraft(state.tasks[0],state.sites[0],channel,state.settings,model(update),undefined,{fetchHtml});assert.equal(r.status,'failed');}
});
test('confirmed use cannot override fetch failure, fake citation or a source redirect',async()=>{
 const state=fixture();applyChannelPolicyDecision(state,state.sites[0].id,channel,true);
 for(const deps of [{fetchHtml:async()=>{throw Error('network')}},{fetchHtml:async(url:string)=>url==='https://telegra.ph/api'?{url:'https://telegra.ph/third-party-post',html:'<p>'+channelQuote+'</p>'}:fetchHtml(url)}]){const r=await reviewArticleDraft(state.tasks[0],state.sites[0],channel,state.settings,model(),undefined,deps);assert.equal(r.status,'failed');assert.equal(r.reasonCode,'evidence_fetch_failed');}
 const r=await reviewArticleDraft(state.tasks[0],state.sites[0],channel,state.settings,model({citations:[{url:state.sites[0].url,quote:'This never appeared in the real source.'}]}),undefined,{fetchHtml});assert.equal(r.status,'failed');assert.equal(r.reasonCode,'evidence_invalid');
});
test('policy decisions bind identity and evidence, expire and cannot be granted to custom channels',()=>{
 const state=fixture(),now=new Date();applyChannelPolicyDecision(state,state.sites[0].id,channel,true,now);assert.ok(currentChannelPolicyDecision(state.sites[0],channel,now));assert.equal(currentChannelPolicyDecision({...state.sites[0],id:'another'},channel,now),undefined);assert.equal(currentChannelPolicyDecision({...state.sites[0],domain:'changed.com'},channel,now),undefined);assert.equal(currentChannelPolicyDecision(state.sites[0],{...channel,notes:channel.notes+' changed'},now),undefined);assert.equal(currentChannelPolicyDecision(state.sites[0],channel,new Date(now.getTime()+91*86400000)),undefined);assert.throws(()=>applyChannelPolicyDecision(state,state.sites[0].id,{...channel,provenance:'custom'},true));assert.equal(state.sites[0].channelPolicyDecisions![channel.id].scopeHash,channelPolicyScopeHash(state.sites[0],channel));
});
test('grant/revoke do not replace drafts or unpause sites, and restore cannot grant authorization',()=>{
 const state=fixture(),draft=structuredClone(state.tasks[0].draft);state.sites[0].status='paused';state.settings.autoRun=false;applyChannelPolicyDecision(state,state.sites[0].id,channel,true);assert.deepEqual(state.tasks[0].draft,draft);assert.equal(state.tasks[0].status,'queued');assert.equal(state.sites[0].status,'paused');assert.equal(state.settings.autoRun,false);const restored=validateBackup({state,secrets:{}});assert.equal(restored.state.sites[0].channelPolicyDecisions,undefined);applyChannelPolicyDecision(state,state.sites[0].id,channel,false);assert.equal(state.tasks[0].status,'needs_input');
});
test('saving changed AI draft queues an independent review; manual, paused and submitted boundaries hold',()=>{
 const state=fixture();state.settings.autoRun=false;state.sites[0].status='paused';const changed={...state.tasks[0].draft!,body:state.tasks[0].draft!.body+' Updated.'};assert.equal(saveTaskDraft(state,state.tasks[0].id,changed),true);assert.equal(state.tasks[0].draftRevision,2);assert.equal(state.tasks[0].status,'queued');assert.equal(state.sites[0].status,'paused');assert.equal(state.settings.autoRun,false);assert.equal(state.tasks[0].articleApprovedAt,undefined);
 const manual=fixture();manual.sites[0].articleReviewMode='manual';assert.equal(saveTaskDraft(manual,manual.tasks[0].id,changed),false);assert.equal(manual.tasks[0].status,'needs_input');const submitted=fixture();submitted.tasks[0].submittedAt=new Date().toISOString();assert.throws(()=>saveTaskDraft(submitted,submitted.tasks[0].id,changed));assert.equal(submitted.tasks[0].draftRevision,1);
});

 test('channel confirmation never reactivates skipped article tasks',()=>{const state=fixture();state.tasks[0].status='skipped';for(const allow of [true,false]){applyChannelPolicyDecision(state,state.sites[0].id,channel,allow);assert.equal(state.tasks[0].status,'skipped');}});
 test('AI provider failure is separate from evidence fetching failure',async()=>{const state=fixture();applyChannelPolicyDecision(state,state.sites[0].id,channel,true);const r=await reviewArticleDraft(state.tasks[0],state.sites[0],channel,state.settings,{json:async()=>{throw Error('provider unavailable')}},undefined,{fetchHtml});assert.equal(r.reasonCode,'ai_unavailable');});

test('guidance approval still requires real citations from both site and channel',async()=>{
 for(const citations of [[{url:'https://policy-fixture.com/',quote:siteQuote}],[{url:'https://telegram.org/blog/telegraph',quote:channelQuote}],[{url:'https://policy-fixture.com/',quote:siteQuote},{url:'https://telegra.ph/api',quote:'The API expressly approves all affiliate promotions.'}]]){
  const state=fixture(),r=await reviewArticleDraft(state.tasks[0],state.sites[0],channel,state.settings,model({citations}),undefined,{fetchHtml});assert.equal(r.status,'failed');assert.equal(r.reasonCode,'evidence_invalid');
 }
});
