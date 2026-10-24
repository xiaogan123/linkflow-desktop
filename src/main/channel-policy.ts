import {createHash} from 'node:crypto';
import type {Channel,ChannelEvidenceSource,ChannelPolicyDecision,Site} from '../shared/types';
import type {State} from './store';
import {channelSuitability} from '../integrations/eligibility';

const TELEGRAPH_API_URL='https://telegra.ph/api';
const TELEGRAPH_GUIDANCE_URL='https://telegram.org/blog/telegraph';
const CHANNEL_POLICY_DECISION_MS=90*86400000;

function canonicalPolicyUrl(value:string):string|undefined{
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)return;
    const path=url.pathname.length>1?url.pathname.replace(/\/+$/,''):url.pathname;
    return `${url.origin}${path}`;
  }catch{return}
}

export function channelEvidenceSources(channel:Channel):ChannelEvidenceSource[]{
  return channel.evidenceSources??[{url:channel.rulesUrl,kind:'content_policy',appliesTo:channel.id,applicability:'verified'}];
}

export function canConfirmMissingPolicy(channel:Channel){
  if(channel.provenance!=='built-in'||channel.id!=='telegraph'||channel.domain!=='telegra.ph'||canonicalPolicyUrl(channel.rulesUrl)!==TELEGRAPH_API_URL)return false;
  const evidence=channel.evidenceSources??[];
  const signatures=evidence.map(source=>source.appliesTo==='telegraph'&&source.applicability==='verified'
    ?`${source.kind}:${canonicalPolicyUrl(source.url)}`:'');
  const expected=new Set([`api:${TELEGRAPH_API_URL}`,`product_guidance:${TELEGRAPH_GUIDANCE_URL}`]);
  return signatures.length===expected.size&&signatures.every(signature=>expected.has(signature))&&new Set(signatures).size===expected.size;
}

/** Evidence coverage only; this does not claim all platform policies are known. */
export function supportsOfficialGuidanceReview(channel:Channel){
  const hartSources=channel.evidenceSources??[];
  const hart=channel.provenance==='built-in'&&channel.id==='hart'&&channel.domain==='hart.intrane.fr'&&channel.rulesUrl==='https://hart.intrane.fr/llms.txt'
    &&channel.audience?.length===1&&channel.audience[0]==='software'&&channel.requirements?.length===2&&channel.requirements.includes('software')&&channel.requirements.includes('developer')
    &&hartSources.length===2&&hartSources.every(source=>source.appliesTo==='hart'&&source.applicability==='verified')
    &&hartSources.filter(source=>source.kind==='api'&&source.url==='https://hart.intrane.fr/llms.txt').length===1
    &&hartSources.filter(source=>source.kind==='product_guidance'&&source.url==='https://hart.intrane.fr/').length===1;
  const paper=channel.provenance==='built-in'&&channel.id==='paper-wf'&&channel.domain==='paper.wf'&&channel.rulesUrl==='https://paper.wf/about'&&channel.evidenceSources?.length===2&&channel.evidenceSources.every(source=>source.appliesTo==='paper-wf'&&source.applicability==='verified'&&(source.kind==='api'&&source.url==='https://developers.write.as/docs/api/'||source.kind==='product_guidance'&&source.url==='https://paper.wf/about'))&&new Set(channel.evidenceSources.map(source=>source.kind)).size===2;
  const verbose=channel.provenance==='built-in'&&channel.id==='verbose'&&channel.domain==='verbose.blog'&&channel.rulesUrl==='https://verbose.blog/why'&&channel.evidenceSources?.length===2&&channel.evidenceSources.every(source=>source.appliesTo==='verbose'&&source.applicability==='verified'&&(source.kind==='api'&&source.url==='https://verbose.blog/docs'||source.kind==='product_guidance'&&source.url==='https://verbose.blog/why'))&&new Set(channel.evidenceSources.map(source=>source.kind)).size===2;
  const betterThanHtml=channel.provenance==='built-in'&&channel.id==='betterthanhtml'&&channel.domain==='betterthanhtml.com'&&channel.rulesUrl==='https://betterthanhtml.com/ai'&&channel.evidenceSources?.length===1&&channel.evidenceSources[0]?.url==='https://betterthanhtml.com/ai'&&channel.evidenceSources[0]?.kind==='product_guidance'&&channel.evidenceSources[0]?.appliesTo==='betterthanhtml'&&channel.evidenceSources[0]?.applicability==='verified';
  const supanote=channel.provenance==='built-in'&&channel.id==='supanote'&&channel.domain==='supanote.app'&&channel.rulesUrl==='https://supanote.app/terms'&&channel.evidenceSources?.length===2&&channel.evidenceSources.every(source=>source.appliesTo==='supanote'&&source.applicability==='verified'&&(source.kind==='api'&&source.url==='https://supanote.app/docs'||source.kind==='content_policy'&&source.url==='https://supanote.app/terms'))&&new Set(channel.evidenceSources.map(source=>source.kind)).size===2;
  const docsMdSource='https://github.com/invisible-hand/docs-md.com/tree/199f9a2656f83ed2918ee1d1f0ee8bf6734b2a2e';
  const docsMd=channel.provenance==='built-in'&&channel.id==='docs-md'&&channel.domain==='docs-md.com'&&channel.rulesUrl==='https://docs-md.com/'&&channel.evidenceSources?.length===1&&channel.evidenceSources[0]?.url===docsMdSource&&channel.evidenceSources[0]?.kind==='api'&&channel.evidenceSources[0]?.appliesTo==='docs-md'&&channel.evidenceSources[0]?.applicability==='verified';
  const markdropHomepage='https://www.markdrop.in/';
  const markdropRoutes='https://github.com/himanshkukreja/markdrop/blob/592689c45344c9451642e1905ced52a8f0e0d5e6/backend/app/routers/documents.py';
  const markdropSchema='https://github.com/himanshkukreja/markdrop/blob/592689c45344c9451642e1905ced52a8f0e0d5e6/backend/app/schemas/document.py';
  const markdropSources=channel.evidenceSources??[];
  const markdrop=channel.provenance==='built-in'&&channel.id==='markdrop'&&channel.domain==='markdrop.in'&&channel.rulesUrl===markdropHomepage&&markdropSources.length===3&&markdropSources.every(source=>source.appliesTo==='markdrop'&&source.applicability==='verified')&&markdropSources.filter(source=>source.kind==='product_guidance'&&source.url===markdropHomepage).length===1&&markdropSources.filter(source=>source.kind==='api'&&(source.url===markdropRoutes||source.url===markdropSchema)).length===2&&new Set(markdropSources.map(source=>source.url)).size===3;
  const draftmarkSources=channel.evidenceSources??[],draftmark=channel.provenance==='built-in'&&channel.id==='draftmark'&&channel.domain==='draftmark.app'&&channel.rulesUrl==='https://draftmark.app/terms'&&draftmarkSources.length===2&&draftmarkSources.every(source=>source.appliesTo==='draftmark'&&source.applicability==='verified')&&draftmarkSources.filter(source=>source.kind==='product_guidance'&&source.url==='https://draftmark.app/').length===1&&draftmarkSources.filter(source=>source.kind==='content_policy'&&source.url==='https://draftmark.app/terms').length===1;
  const memoryWikiSources=channel.evidenceSources??[],memoryWiki=channel.provenance==='built-in'&&channel.id==='memorywiki'&&channel.domain==='memory.wiki'&&channel.rulesUrl==='https://memory.wiki/terms'&&memoryWikiSources.length===2&&memoryWikiSources.every(source=>source.appliesTo==='memorywiki'&&source.applicability==='verified')&&memoryWikiSources.filter(source=>source.kind==='api'&&source.url==='https://memory.wiki/docs/api').length===1&&memoryWikiSources.filter(source=>source.kind==='content_policy'&&source.url==='https://memory.wiki/terms').length===1;
  const katbin=channel.provenance==='built-in'&&channel.id==='katbin'&&channel.domain==='katb.in'&&channel.rulesUrl==='https://katb.in/'&&channel.evidenceSources?.length===2&&channel.evidenceSources.some(source=>source.url==='https://github.com/SphericalKat/katbin/tree/6a288d1886bf0db5e7103d478c562b160c7380cb'&&source.kind==='api'&&source.appliesTo==='katbin'&&source.applicability==='verified')&&channel.evidenceSources.some(source=>source.url==='https://katb.in/'&&source.kind==='product_guidance'&&source.appliesTo==='katbin'&&source.applicability==='verified');
  const mdshareSources=channel.evidenceSources??[],mdshare=channel.provenance==='built-in'&&channel.id==='mdshare'&&channel.domain==='mdshare.org'&&channel.rulesUrl==='https://mdshare.org/legal/terms'&&mdshareSources.length===3&&mdshareSources.filter(source=>source.url==='https://mdshare.org/docs'&&source.appliesTo==='mdshare'&&source.applicability==='verified'&&(source.kind==='api'||source.kind==='product_guidance')).length===2&&mdshareSources.some(source=>source.url==='https://mdshare.org/legal/terms'&&source.kind==='content_policy'&&source.appliesTo==='mdshare'&&source.applicability==='verified');
  const pstrsSources=channel.evidenceSources??[],pstrs=channel.provenance==='built-in'&&channel.id==='pstrs'&&channel.domain==='paster.abhicracker.com'&&channel.rulesUrl==='https://paster.abhicracker.com/'&&pstrsSources.length===2&&pstrsSources.some(source=>source.url==='https://paster.abhicracker.com/'&&source.kind==='api'&&source.appliesTo==='pstrs'&&source.applicability==='verified')&&pstrsSources.some(source=>source.url==='https://paster.abhicracker.com/web'&&source.kind==='product_guidance'&&source.appliesTo==='pstrs'&&source.applicability==='verified');
  const nextgenSlidesSources=channel.evidenceSources??[],nextgenSlides=channel.provenance==='built-in'&&channel.id==='nextgen-slides'&&channel.domain==='nextgenslides.dev'&&channel.rulesUrl==='https://nextgenslides.dev/deploy'&&nextgenSlidesSources.length===2&&nextgenSlidesSources.some(source=>source.url==='https://nextgenslides.dev/deploy'&&source.kind==='api'&&source.appliesTo==='nextgen-slides'&&source.applicability==='verified')&&nextgenSlidesSources.some(source=>source.url==='https://github.com/MadsNyl/nextgen-slides'&&source.kind==='product_guidance'&&source.appliesTo==='nextgen-slides'&&source.applicability==='verified')&&new Set(nextgenSlidesSources.map(source=>source.url)).size===2;
  const yourwebsSources=channel.evidenceSources??[],yourwebs=channel.provenance==='built-in'&&channel.id==='yourwebs'&&channel.domain==='yourwebs.cc'&&channel.rulesUrl==='https://yourwebs.cc/skill.md'&&yourwebsSources.length===2&&yourwebsSources.some(source=>source.url==='https://yourwebs.cc/skill.md'&&source.kind==='api'&&source.appliesTo==='yourwebs'&&source.applicability==='verified')&&yourwebsSources.some(source=>source.url==='https://github.com/sugarforever/yourwebs-skill/blob/main/reference/api.md'&&source.kind==='product_guidance'&&source.appliesTo==='yourwebs'&&source.applicability==='verified')&&new Set(yourwebsSources.map(source=>source.url)).size===2;
  const totpageSources=channel.evidenceSources??[],totpage=channel.provenance==='built-in'&&channel.id==='totpage'&&channel.domain==='tot.page'&&channel.rulesUrl==='https://tot.page/agents.md'&&totpageSources.length===2&&totpageSources.some(source=>source.url==='https://tot.page/agents.md'&&source.kind==='api'&&source.appliesTo==='totpage'&&source.applicability==='verified')&&totpageSources.some(source=>source.url==='https://github.com/plannotator/tot'&&source.kind==='product_guidance'&&source.appliesTo==='totpage'&&source.applicability==='verified')&&new Set(totpageSources.map(source=>source.url)).size===2;
  const mdviewSources=channel.evidenceSources??[],mdview=channel.provenance==='built-in'&&channel.id==='mdview'&&channel.domain==='mdview.io'&&channel.rulesUrl==='https://mdview.io/terms'&&mdviewSources.length===2&&mdviewSources.some(source=>source.url==='https://mdview.io/agents.md'&&source.kind==='api'&&source.appliesTo==='mdview'&&source.applicability==='verified')&&mdviewSources.some(source=>source.url==='https://mdview.io/terms'&&source.kind==='content_policy'&&source.appliesTo==='mdview'&&source.applicability==='verified')&&new Set(mdviewSources.map(source=>source.url)).size===2;
  const txtsbsSources=channel.evidenceSources??[],txtsbs=channel.provenance==='built-in'&&channel.id==='txtsbs'&&channel.domain==='txt.sbs'&&channel.rulesUrl==='https://txt.sbs/terms-of-use'&&txtsbsSources.length===2&&txtsbsSources.some(source=>source.url==='https://txt.sbs/'&&source.kind==='product_guidance'&&source.appliesTo==='txtsbs'&&source.applicability==='verified')&&txtsbsSources.some(source=>source.url==='https://txt.sbs/terms-of-use'&&source.kind==='content_policy'&&source.appliesTo==='txtsbs'&&source.applicability==='verified')&&new Set(txtsbsSources.map(source=>source.url)).size===2;
  const theThingsSources=channel.evidenceSources??[],theThings=channel.provenance==='built-in'&&channel.id==='thethings'&&channel.domain==='thethings.ai'&&channel.rulesUrl==='https://thethings.ai/'&&theThingsSources.length===2&&theThingsSources.some(source=>source.url==='https://thethings.ai/'&&source.kind==='product_guidance'&&source.appliesTo==='thethings'&&source.applicability==='verified')&&theThingsSources.some(source=>source.url==='https://thethings.ai/connect'&&source.kind==='api'&&source.appliesTo==='thethings'&&source.applicability==='verified')&&new Set(theThingsSources.map(source=>source.url)).size===2;
  const pastyxSources=channel.evidenceSources??[],pastyx=channel.provenance==='built-in'&&channel.id==='pastyx'&&channel.domain==='pastyx.pages.dev'&&channel.rulesUrl==='https://pastyx.pages.dev/terms'&&pastyxSources.length===2&&pastyxSources.some(source=>source.url==='https://pastyx.pages.dev/docs'&&source.kind==='api'&&source.appliesTo==='pastyx'&&source.applicability==='verified')&&pastyxSources.some(source=>source.url==='https://pastyx.pages.dev/terms'&&source.kind==='content_policy'&&source.appliesTo==='pastyx'&&source.applicability==='verified')&&new Set(pastyxSources.map(source=>source.url)).size===2;
  const agentdropSources=channel.evidenceSources??[],agentdrop=channel.provenance==='built-in'&&channel.id==='agentdrop'&&channel.domain==='www.agent-drop.co'&&channel.rulesUrl==='https://www.agent-drop.co/skill.md'&&agentdropSources.length===2&&agentdropSources.some(source=>source.url==='https://www.agent-drop.co/skill.md'&&source.kind==='api'&&source.appliesTo==='agentdrop'&&source.applicability==='verified')&&agentdropSources.some(source=>source.url==='https://github.com/sugarforever/agentdrop-skill/blob/main/reference/api.md'&&source.kind==='product_guidance'&&source.appliesTo==='agentdrop'&&source.applicability==='verified')&&new Set(agentdropSources.map(source=>source.url)).size===2;
  const shipPageSources=channel.evidenceSources??[],shipPage=channel.provenance==='built-in'&&channel.id==='shippage'&&channel.domain==='shippage.ai'&&channel.rulesUrl==='https://shippage.ai/terms'&&shipPageSources.length===3&&shipPageSources.some(source=>source.url==='https://shippage.ai/api'&&source.kind==='api'&&source.appliesTo==='shippage'&&source.applicability==='verified')&&shipPageSources.some(source=>source.url==='https://shippage.ai/terms'&&source.kind==='content_policy'&&source.appliesTo==='shippage'&&source.applicability==='verified')&&shipPageSources.some(source=>source.url==='https://github.com/jieshu666/ShipPage-Skill/tree/6f0d43776d0aa977cbe3efdde967f936ee345eef'&&source.kind==='product_guidance'&&source.appliesTo==='shippage'&&source.applicability==='verified')&&new Set(shipPageSources.map(source=>source.url)).size===3;
  const pastemystSources=channel.evidenceSources??[],pastemyst=channel.provenance==='built-in'&&channel.id==='pastemyst'&&channel.domain==='paste.myst.rs'&&channel.rulesUrl==='https://paste.myst.rs/legal'&&pastemystSources.length===3&&pastemystSources.some(source=>source.url==='https://github.com/CodeMyst/pastemyst/tree/ac1e63cb1a3696b7e3a4458959a1ec0b879904de'&&source.kind==='api'&&source.appliesTo==='pastemyst'&&source.applicability==='verified')&&pastemystSources.some(source=>source.url==='https://paste.myst.rs/api-docs/index'&&source.kind==='product_guidance'&&source.appliesTo==='pastemyst'&&source.applicability==='verified')&&pastemystSources.some(source=>source.url==='https://paste.myst.rs/legal'&&source.kind==='content_policy'&&source.appliesTo==='pastemyst'&&source.applicability==='unconfirmed');
  const markdownPasteSources=channel.evidenceSources??[],markdownPaste=channel.provenance==='built-in'&&channel.id==='markdownpaste'&&channel.domain==='markdownpasteit.vercel.app'&&channel.rulesUrl==='https://markdownpasteit.vercel.app/docs'&&markdownPasteSources.length===2&&markdownPasteSources.some(source=>source.url==='https://github.com/randishdeviant/markdown-paste/tree/5deb03c549a5f26e8b926fe99180b1ab00417520'&&source.kind==='api'&&source.appliesTo==='markdownpaste'&&source.applicability==='verified')&&markdownPasteSources.some(source=>source.url==='https://markdownpasteit.vercel.app/docs'&&source.kind==='product_guidance'&&source.appliesTo==='markdownpaste'&&source.applicability==='verified');
  const carcinusSources=channel.evidenceSources??[],carcinus=channel.provenance==='built-in'&&channel.id==='carcinus'&&channel.domain==='carcinus.org'&&channel.rulesUrl==='https://carcinus.org/docs/agents'&&carcinusSources.length===2&&carcinusSources.some(source=>source.url==='https://carcinus.org/docs/agents'&&source.kind==='api'&&source.appliesTo==='carcinus'&&source.applicability==='verified')&&carcinusSources.some(source=>source.url==='https://carcinus.org/profile-microsite'&&source.kind==='product_guidance'&&source.appliesTo==='carcinus'&&source.applicability==='verified')&&new Set(carcinusSources.map(source=>source.url)).size===2;
  return (canConfirmMissingPolicy(channel)||hart||paper||verbose||betterThanHtml||supanote||docsMd||markdrop||draftmark||memoryWiki||katbin||mdshare||pstrs||nextgenSlides||yourwebs||totpage||mdview||txtsbs||theThings||pastyx||agentdrop||shipPage||pastemyst||markdownPaste||carcinus)&&channel.automation==='api'&&channel.kind==='article'&&channel.articleRequired;
}

function legacyChannelPolicyScopeHash(site:Site,channel:Channel){
  return createHash('sha256').update(JSON.stringify({version:2,site:{id:site.id,domain:site.domain,url:site.url,category:site.category,language:site.language},channel:{id:channel.id,domain:channel.domain,rulesUrl:channel.rulesUrl,evidenceSources:channelEvidenceSources(channel),audience:channel.audience,promotionPolicy:channel.promotionPolicy,promotionPolicySource:channel.promotionPolicySource,languages:channel.languages,retentionDays:channel.retentionDays,irreversible:channel.irreversible}})).digest('hex');
}
function legacyV1ScopeHashes(site:Site,channel:Channel):string[]{
  const identity={site:{id:site.id,domain:site.domain,url:site.url},channel:{id:channel.id,domain:channel.domain,rulesUrl:channel.rulesUrl}};
  const sources=channelEvidenceSources(channel);
  return [
    {version:1,...identity,channel:{...identity.channel,evidenceSources:sources}},
    {version:1,...identity,channel:{...identity.channel,checkedAt:channel.checkedAt,notes:channel.notes,evidenceSources:sources}},
  ].map(value=>createHash('sha256').update(JSON.stringify(value)).digest('hex'));
}
function legacyScopeHashes(site:Site,channel:Channel):string[]{
  // Only canonical equivalents of the two trusted Telegraph sources are
  // accepted. This preserves ordering/trailing-slash catalog edits without
  // turning an unrelated or newly asserted policy source into authorization.
  const api:ChannelEvidenceSource={url:TELEGRAPH_API_URL,kind:'api',appliesTo:'telegraph',applicability:'verified'};
  const guidance:ChannelEvidenceSource={url:TELEGRAPH_GUIDANCE_URL,kind:'product_guidance',appliesTo:'telegraph',applicability:'verified'};
  const evidenceVariants=[channel.evidenceSources!,[api,guidance],[guidance,api]];
  const catalogVariants=evidenceVariants.flatMap(evidenceSources=>[channel.rulesUrl,TELEGRAPH_API_URL,`${TELEGRAPH_API_URL}/`].map(rulesUrl=>({...channel,rulesUrl,evidenceSources})));
  const hashes:string[]=[];
  for(const candidate of catalogVariants){
    const original={...candidate,audience:['general'] as Channel['audience'],promotionPolicy:'unknown' as const,promotionPolicySource:TELEGRAPH_API_URL,languages:['*'],retentionDays:undefined,irreversible:undefined,checkedAt:'2026-09-27'};
    hashes.push(legacyChannelPolicyScopeHash(site,candidate),legacyChannelPolicyScopeHash(site,original),...legacyV1ScopeHashes(site,candidate),...legacyV1ScopeHashes(site,original));
  }
  return [...new Set(hashes)];
}
/** The choice is bound to the exact site id/domain/url and Telegraph domain.
 * Applicable catalog copy and canonical evidence ordering can change separately;
 * the owner must confirm again after 90 days or any bound identity change.
 */
export function channelPolicyScopeHash(site:Site,channel:Channel){
  return createHash('sha256').update(JSON.stringify({version:3,site:{id:site.id,domain:site.domain,url:site.url},channel:{id:channel.id,domain:channel.domain}})).digest('hex');
}

export function currentChannelPolicyDecision(site:Site,channel:Channel,now:Date=new Date()):ChannelPolicyDecision|undefined{
  const decision=site.channelPolicyDecisions?.[channel.id],stamp=Date.parse(decision?.confirmedAt??'');
  if(!canConfirmMissingPolicy(channel)||!channelSuitability(site,channel).eligible||decision?.decision!=='use_without_confirmed_policy'||!Number.isFinite(stamp)||stamp>now.getTime()||now.getTime()-stamp>CHANNEL_POLICY_DECISION_MS)return;
  const currentHash=channelPolicyScopeHash(site,channel);
  if(decision.scopeHash!==currentHash&&!legacyScopeHashes(site,channel).includes(decision.scopeHash))return;
  return {...decision,scopeHash:currentHash};
}

/** On local state load, persist the compatible v1/v2 owner choice in v3 form. */
export function migrateChannelPolicyScopeHashes(state:State,channels:readonly Channel[],now=new Date()):void{
  for(const site of state.sites){
    for(const channel of channels){
      const stored=site.channelPolicyDecisions?.[channel.id];
      if(!stored||stored.scopeHash===channelPolicyScopeHash(site,channel))continue;
      const current=currentChannelPolicyDecision(site,channel,now);
      if(current)stored.scopeHash=current.scopeHash;
    }
  }
}

/** Called only after the main-process native confirmation. No edit/import path grants this decision. */
export function applyChannelPolicyDecision(state:State,siteId:string,channel:Channel,allow:boolean,now:Date=new Date()){
  const site=state.sites.find(item=>item.id===siteId);if(!site)throw Error('网站不存在');
  if(!canConfirmMissingPolicy(channel))throw Error('此平台不能使用缺少内容政策的确认方式');
  const stamp=now.toISOString();
  if(allow){site.channelPolicyDecisions??={};site.channelPolicyDecisions[channel.id]={decision:'use_without_confirmed_policy',scopeHash:channelPolicyScopeHash(site,channel),confirmedAt:stamp};}
  else if(site.channelPolicyDecisions)delete site.channelPolicyDecisions[channel.id];
  for(const task of state.tasks.filter(item=>item.siteId===siteId&&item.channelId===channel.id&&!item.submittedAt&&!item.firstLiveAt)){
    task.articleApprovedAt=undefined;task.articleReview=undefined;task.updatedAt=stamp;
    if(task.draft&&task.checkpoint==='article_review'&&['queued','needs_input','failed'].includes(task.status)){
      task.status=allow?'queued':'needs_input';task.scheduledAt=stamp;
      task.message=allow?'你已确认使用此平台，等待新的 AI 复核':'平台使用确认已撤回，等待你处理';
    }
  }
}
