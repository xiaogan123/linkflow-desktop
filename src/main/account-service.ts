import {randomUUID} from 'node:crypto';
import type {Account,Channel} from '../shared/types';
import {bindAccount,setSelectedAccountSites} from './account-bindings';
import {ACCOUNT_IDENTITY_MESSAGES} from './account-retirement';
import type {State,Store} from './store';

export interface AccountWrite {
  id?:string;
  channelId:string;
  email:string;
  username:string;
  password?:string;
  mailboxId?:string|null;
  siteIds?:string[];
}

type Encrypt=(secrets:Record<string,string>)=>Record<string,string>;

function identityChanged(previous:Account,next:AccountWrite):boolean{
  return previous.channelId!==next.channelId||previous.email.trim().toLowerCase()!==next.email.trim().toLowerCase()||previous.username!==next.username;
}

/** Build and validate the complete account/binding draft before touching encrypted storage. */
export function saveAccountAtomic(store:Store,input:AccountWrite,channel:Channel,encrypt:Encrypt,now=new Date()):string{
  const before=store.read(),old=input.id?before.accounts.find(account=>account.id===input.id):undefined;
  if(input.id&&!old)throw Error('账号不存在');
  if(channel.id!==input.channelId)throw Error('账号与平台不匹配');
  if(channel.id==='markest'||channel.id==='deno'||channel.automation==='api'||old?.credentialKind==='api_token'||old?.credentialKind==='oauth')throw Error(channel.id==='telegraph'?'Telegraph 发布账号由任务自动准备，无需导入邮箱或密码；已有发布账号请编辑绑定。':'API 发布账号请使用专用连接入口；已有发布账号请编辑绑定。');
  if(input.mailboxId&&!before.mailboxes.some(mailbox=>mailbox.id===input.mailboxId))throw Error('收件箱不存在');
  if(old?.retiredAt){
    const existingSites=new Set(before.accountBindings.filter(binding=>binding.accountId===old.id).map(binding=>binding.siteId));
    const requestedSites=input.siteIds&&new Set(input.siteIds);
    if(input.channelId!==old.channelId||input.email!==old.email||input.username!==old.username||input.password
      ||requestedSites&&(requestedSites.size!==existingSites.size||[...requestedSites].some(siteId=>!existingSites.has(siteId))))throw Error(ACCOUNT_IDENTITY_MESSAGES.retired);
  }
  if(before.accounts.some(account=>account.id!==input.id&&account.channelId===input.channelId&&account.email.toLowerCase()===input.email.toLowerCase()))throw Error('该平台已有此邮箱账号');
  const changed=!!old&&identityChanged(old,input);
  if(changed&&before.tasks.some(task=>task.accountId===old?.id))throw Error('该账号已归属历史任务，请新增账号以保留当时发布账号');
  const repairedCredentials=old?.status==='credentials_invalid'&&!!input.password;
  const status=old?.status==='restricted'&&!changed?'restricted':!old||changed||repairedCredentials?'unknown':old.status;
  const stamp=now.toISOString(),id=old?.id??randomUUID(),hasNewSecret=!!input.password;
  const account:Account={...old,id,channelId:input.channelId,email:input.email,username:input.username,mailboxId:input.mailboxId===null?undefined:input.mailboxId??old?.mailboxId,createdAt:old?.createdAt??stamp,updatedAt:stamp,status,source:old?.source??'imported',hasPassword:hasNewSecret||(!changed&&old?.hasPassword)||false,diagnostic:status==='restricted'?old?.diagnostic:undefined};
  const apply=(state:State)=>{
    state.accounts=state.accounts.filter(item=>item.id!==id);state.accounts.push(account);
    if(old?.retiredAt)return;
    if(input.siteIds||old&&old.channelId!==input.channelId){
      const selected=new Set(input.siteIds??[]);
      if([...selected].some(siteId=>!state.sites.some(site=>site.id===siteId)))throw Error('绑定的网站不存在');
      if(old?.channelId===input.channelId)setSelectedAccountSites(state,id,selected,channel,now);
      else{
        state.accountBindings=state.accountBindings.filter(binding=>binding.accountId!==id);
        for(const siteId of selected)bindAccount(state,id,siteId,channel,now);
      }
    }
  };
  apply(structuredClone(before));
  const ciphers=hasNewSecret?encrypt({['account:'+id]:input.password!}):{};
  const deletes=changed&&!hasNewSecret?['account:'+id]:[];
  store.updateWithCiphers(apply,ciphers,deletes);
  return id;
}
