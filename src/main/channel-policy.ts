import {createHash} from 'node:crypto';
import type {Channel,ChannelEvidenceSource,ChannelPolicyDecision,Site} from '../shared/types';
import type {State} from './store';

export function channelEvidenceSources(channel:Channel):ChannelEvidenceSource[]{
  return channel.evidenceSources??[{url:channel.rulesUrl,kind:'content_policy',appliesTo:channel.id,applicability:'verified'}];
}

export function canConfirmMissingPolicy(channel:Channel){
  return channel.provenance==='built-in'&&channel.id==='telegraph'&&channel.domain==='telegra.ph'&&channel.rulesUrl==='https://telegra.ph/api'&&
    channel.evidenceSources?.length===2&&channel.evidenceSources.every(source=>source.appliesTo==='telegraph'&&source.applicability==='verified'&&
      (source.kind==='api'&&source.url==='https://telegra.ph/api'||source.kind==='product_guidance'&&source.url==='https://telegram.org/blog/telegraph'))&&
    new Set(channel.evidenceSources.map(source=>source.kind)).size===2;
}

/** Evidence coverage only; this does not claim all platform policies are known. */
export function supportsOfficialGuidanceReview(channel:Channel){
  const paper=channel.provenance==='built-in'&&channel.id==='paper-wf'&&channel.domain==='paper.wf'&&channel.rulesUrl==='https://paper.wf/about'&&channel.evidenceSources?.length===2&&channel.evidenceSources.every(source=>source.appliesTo==='paper-wf'&&source.applicability==='verified'&&(source.kind==='api'&&source.url==='https://developers.write.as/docs/api/'||source.kind==='product_guidance'&&source.url==='https://paper.wf/about'))&&new Set(channel.evidenceSources.map(source=>source.kind)).size===2;
  const verbose=channel.provenance==='built-in'&&channel.id==='verbose'&&channel.domain==='verbose.blog'&&channel.rulesUrl==='https://verbose.blog/why'&&channel.evidenceSources?.length===2&&channel.evidenceSources.every(source=>source.appliesTo==='verbose'&&source.applicability==='verified'&&(source.kind==='api'&&source.url==='https://verbose.blog/docs'||source.kind==='product_guidance'&&source.url==='https://verbose.blog/why'))&&new Set(channel.evidenceSources.map(source=>source.kind)).size===2;
  const betterThanHtml=channel.provenance==='built-in'&&channel.id==='betterthanhtml'&&channel.domain==='betterthanhtml.com'&&channel.rulesUrl==='https://betterthanhtml.com/ai'&&channel.evidenceSources?.length===1&&channel.evidenceSources[0]?.url==='https://betterthanhtml.com/ai'&&channel.evidenceSources[0]?.kind==='product_guidance'&&channel.evidenceSources[0]?.appliesTo==='betterthanhtml'&&channel.evidenceSources[0]?.applicability==='verified';
  const supanote=channel.provenance==='built-in'&&channel.id==='supanote'&&channel.domain==='supanote.app'&&channel.rulesUrl==='https://supanote.app/terms'&&channel.evidenceSources?.length===2&&channel.evidenceSources.every(source=>source.appliesTo==='supanote'&&source.applicability==='verified'&&(source.kind==='api'&&source.url==='https://supanote.app/docs'||source.kind==='content_policy'&&source.url==='https://supanote.app/terms'))&&new Set(channel.evidenceSources.map(source=>source.kind)).size===2;
  const docsMdSource='https://github.com/invisible-hand/docs-md.com/tree/199f9a2656f83ed2918ee1d1f0ee8bf6734b2a2e';
  const docsMd=channel.provenance==='built-in'&&channel.id==='docs-md'&&channel.domain==='docs-md.com'&&channel.rulesUrl==='https://docs-md.com/'&&channel.evidenceSources?.length===1&&channel.evidenceSources[0]?.url===docsMdSource&&channel.evidenceSources[0]?.kind==='api'&&channel.evidenceSources[0]?.appliesTo==='docs-md'&&channel.evidenceSources[0]?.applicability==='verified';
  return (canConfirmMissingPolicy(channel)||paper||verbose||betterThanHtml||supanote||docsMd)&&channel.automation==='api'&&channel.kind==='article'&&channel.articleRequired;
}

export function channelPolicyScopeHash(site:Site,channel:Channel){
  return createHash('sha256').update(JSON.stringify({version:1,site:{id:site.id,domain:site.domain,url:site.url},channel:{id:channel.id,domain:channel.domain,rulesUrl:channel.rulesUrl,checkedAt:channel.checkedAt,notes:channel.notes,evidenceSources:channelEvidenceSources(channel)}})).digest('hex');
}

export function currentChannelPolicyDecision(site:Site,channel:Channel,now:Date=new Date()):ChannelPolicyDecision|undefined{
  const decision=site.channelPolicyDecisions?.[channel.id],stamp=Date.parse(decision?.confirmedAt??'');
  if(!canConfirmMissingPolicy(channel)||decision?.decision!=='use_without_confirmed_policy'||decision.scopeHash!==channelPolicyScopeHash(site,channel)||!Number.isFinite(stamp)||stamp>now.getTime()||now.getTime()-stamp>90*86400000)return;
  return decision;
}

/** Called only after the main-process native confirmation. No edit/import path grants this decision. */
export function applyChannelPolicyDecision(state:State,siteId:string,channel:Channel,allow:boolean,now:Date=new Date()){
  const site=state.sites.find(item=>item.id===siteId);if(!site)throw Error('网站不存在');
  if(!canConfirmMissingPolicy(channel))throw Error('此渠道不能使用缺少内容政策的确认方式');
  const stamp=now.toISOString();
  if(allow){site.channelPolicyDecisions??={};site.channelPolicyDecisions[channel.id]={decision:'use_without_confirmed_policy',scopeHash:channelPolicyScopeHash(site,channel),confirmedAt:stamp};}
  else if(site.channelPolicyDecisions)delete site.channelPolicyDecisions[channel.id];
  for(const task of state.tasks.filter(item=>item.siteId===siteId&&item.channelId===channel.id&&!item.submittedAt&&!item.firstLiveAt)){
    task.articleApprovedAt=undefined;task.articleReview=undefined;task.updatedAt=stamp;
    if(task.draft&&task.checkpoint==='article_review'&&['queued','needs_input','failed'].includes(task.status)){
      task.status=allow?'queued':'needs_input';task.scheduledAt=stamp;
      task.message=allow?'你已确认使用此渠道，等待新的独立 AI 内容审核':'渠道使用确认已撤回，等待你处理';
    }
  }
}
