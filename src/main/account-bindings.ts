import {randomUUID} from 'node:crypto';
import type {Account,Channel,SiteAccountBinding,Task} from '../shared/types';
import type {State} from './store';

function lower(value:string){return value.trim().toLowerCase()}

export function boundAccount(state:State,task:Task):Account|undefined{
  if(task.accountId)return state.accounts.find(account=>account.id===task.accountId&&account.channelId===task.channelId);
  const binding=state.accountBindings.find(item=>item.siteId===task.siteId&&item.channelId===task.channelId);
  if(binding)return state.accounts.find(account=>account.id===binding.accountId);
  const site=state.sites.find(item=>item.id===task.siteId);
  if(!site)return;
  return state.accounts.find(account=>account.channelId===task.channelId&&(task.channelId==='github-gist'||lower(account.email)===lower(site.publicEmail||site.email)));
}

export function bindAccount(state:State,accountId:string,siteId:string,channel:Channel,now=new Date()):SiteAccountBinding{
  const account=state.accounts.find(item=>item.id===accountId);
  const site=state.sites.find(item=>item.id===siteId);
  if(!account||!site)throw Error('账号或网站不存在');
  if(account.channelId!==channel.id)throw Error('账号与渠道不匹配');
  if(channel.kind==='profile'){
    const historicalConflict=state.tasks.some(task=>task.accountId===accountId&&task.channelId===channel.id&&task.siteId!==siteId&&!!task.publicUrl);
    const conflict=historicalConflict||state.accountBindings.some(binding=>binding.accountId===accountId&&binding.channelId===channel.id&&binding.siteId!==siteId&&state.tasks.some(task=>task.siteId===binding.siteId&&task.channelId===channel.id&&!!task.publicUrl));
    if(conflict)throw Error('该资料页账号已绑定其他网站的公开结果；为避免覆盖原链接，请选择其他账号。');
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
