import {randomUUID} from 'node:crypto';
import type {Account,Channel,SiteAccountBinding,Task} from '../shared/types';
import type {State} from './store';

export type ChannelExecutionReadiness='ready'|'autocreate'|'handoff_required'|'manual';

function lower(value:string){return value.trim().toLowerCase()}
function reservesSingleProfile(task:Task):boolean{
  return !!task.publicUrl||!!task.submittedAt||[
    'submitting','submitted','submission_uncertain','account_registration_submitted',
    'telegraph_publish_submitting','telegraph_publish_uncertain','telegraph_published','gist_published',
  ].includes(task.checkpoint??'');
}
function profileAccountConflict(state:State,accountId:string,siteId:string,channelId:string):boolean{
  const historical=state.tasks.some(task=>task.accountId===accountId&&task.channelId===channelId&&task.siteId!==siteId&&reservesSingleProfile(task));
  return historical||state.accountBindings.some(binding=>binding.accountId===accountId&&binding.channelId===channelId&&binding.siteId!==siteId&&state.tasks.some(task=>task.siteId===binding.siteId&&task.channelId===channelId&&reservesSingleProfile(task)));
}

function candidateAccounts(state:State,siteId:string,channelId:string):Account[]{
  const site=state.sites.find(item=>item.id===siteId);if(!site)return [];
  return state.accounts.filter(account=>account.channelId===channelId&&(channelId==='github-gist'||lower(account.email)===lower(site.publicEmail||site.email)));
}

function accountForSiteChannel(state:State,siteId:string,channelId:string,accountId?:string):Account|undefined{
  if(accountId)return state.accounts.find(account=>account.id===accountId&&account.channelId===channelId);
  const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channelId);
  if(binding)return state.accounts.find(account=>account.id===binding.accountId);
  const candidates=candidateAccounts(state,siteId,channelId);
  const usableCandidates=['telegraph','github-gist'].includes(channelId)?candidates.filter(account=>account.credentialKind==='api_token'):candidates;
  return usableCandidates.find(account=>account.status==='registered'&&account.hasPassword)
    ??usableCandidates.find(account=>account.status==='unknown'&&account.hasPassword)
    ??usableCandidates[0];
}

export function boundAccount(state:State,task:Task):Account|undefined{
  return accountForSiteChannel(state,task.siteId,task.channelId,task.accountId);
}

/** Classify whether an automatic channel can run before spending generation or review calls. */
export function channelExecutionReadiness(state:State,siteId:string,channel:Channel,accountId?:string):{kind:ChannelExecutionReadiness;account?:Account}{
  if(channel.automation==='manual')return {kind:'manual'};
  if(!channel.accountRequired)return {kind:'ready'};
  const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channel.id);
  const compatible=(candidate:Account)=>channel.automation==='api'?candidate.credentialKind==='api_token':candidate.credentialKind!=='api_token';
  let account=accountForSiteChannel(state,siteId,channel.id,accountId);
  if(!accountId&&!binding){
    const candidates=candidateAccounts(state,siteId,channel.id).filter(compatible);
    account=candidates.find(candidate=>candidate.status==='registered'&&candidate.hasPassword)
      ??candidates.find(candidate=>candidate.status==='unknown'&&candidate.hasPassword)
      ??candidates[0]
      ??account;
  }
  if(accountId&&!account)return {kind:'handoff_required'};
  if(account){
    if(!compatible(account)){
      if(!accountId&&!binding&&channel.id==='telegraph'&&channel.automation==='api')return {kind:'autocreate'};
      return {kind:'handoff_required',account};
    }
    if(channel.kind==='profile'&&profileAccountConflict(state,account.id,siteId,channel.id))return {kind:'handoff_required',account};
    if(channel.id==='telegraph'&&channel.automation==='api'&&account.status==='draft'&&account.source==='generated'&&account.credentialKind==='api_token'&&(account.registrationAttempts??0)<1)return {kind:'autocreate',account};
    const apiReady=channel.automation==='api'&&account.status==='registered'&&account.hasPassword&&account.credentialKind==='api_token';
    const browserReady=channel.automation==='browser'&&account.hasPassword&&['registered','unknown'].includes(account.status);
    if(apiReady||browserReady)return {kind:'ready',account};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='telegraph'&&channel.automation==='api')return {kind:'autocreate'};
  return {kind:'handoff_required'};
}

export function bindAccount(state:State,accountId:string,siteId:string,channel:Channel,now=new Date()):SiteAccountBinding{
  const account=state.accounts.find(item=>item.id===accountId);
  const site=state.sites.find(item=>item.id===siteId);
  if(!account||!site)throw Error('账号或网站不存在');
  if(account.channelId!==channel.id)throw Error('账号与渠道不匹配');
  if(channel.kind==='profile'){
    if(profileAccountConflict(state,accountId,siteId,channel.id))throw Error('该资料页账号已绑定其他网站的公开或待确认结果；为避免覆盖原链接，请先核实原提交或选择其他账号。');
  }
  const stamp=now.toISOString();
  const existing=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channel.id);
  if(existing){existing.accountId=accountId;existing.updatedAt=stamp;return existing}
  const binding={id:randomUUID(),siteId,channelId:channel.id,accountId,createdAt:stamp,updatedAt:stamp};
  state.accountBindings.push(binding);
  return binding;
}

export function unbindAccount(state:State,accountId:string,siteId:string,channelId:string):void{
  state.accountBindings=state.accountBindings.filter(item=>!(item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId));
}

export function attachTaskAccount(state:State,taskId:string,channel:Channel):Account|undefined{
  const task=state.tasks.find(item=>item.id===taskId);if(!task)return;
  let account=boundAccount(state,task);
  if(account){bindAccount(state,account.id,task.siteId,channel);task.accountId=account.id;}
  return account;
}
