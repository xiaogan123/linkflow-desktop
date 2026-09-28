import {randomUUID} from 'node:crypto';
import type {Store,State} from './store';
import {mailboxIdentityChanged,normalizeMailbox,saveMailbox,type MailboxInput} from './mail-settings';

export type MailboxWrite=MailboxInput&{password?:string;siteIds?:string[]};
type Encrypt=(secrets:Record<string,string>)=>Record<string,string>;

function bindSites(state:State,mailboxId:string,siteIds:string[]|undefined){if(!siteIds)return;const selected=new Set(siteIds);if([...selected].some(id=>!state.sites.some(site=>site.id===id)))throw Error('绑定的网站不存在');for(const site of state.sites){if(selected.has(site.id))site.mailboxId=mailboxId;else if(site.mailboxId===mailboxId)delete site.mailboxId}}
function secret(input:MailboxWrite){if(input.password===undefined)return;const value=input.host.trim().toLowerCase().replace(/\.$/,'')==='imap.gmail.com'?input.password.replace(/\s/g,''):input.password;if(!value)throw Error('收件箱密码不能为空');return value}

export function saveMailboxAtomic(store:Store,input:MailboxWrite,encrypt:Encrypt):string{
  const before=store.read(),old=input.id?before.mailboxes.find(item=>item.id===input.id):undefined;if(input.id&&!old)throw Error('收件箱不存在');
  const normalized={...normalizeMailbox(input),id:input.id??randomUUID(),password:input.password,siteIds:input.siteIds},identityChanged=!!old&&mailboxIdentityChanged(old,normalized);
  const apply=(state:State)=>{const mailbox=saveMailbox(state,normalized,false);if(input.password)mailbox.hasPassword=true;bindSites(state,mailbox.id,input.siteIds)};apply(structuredClone(before));
  const clear=secret(normalized),ciphers=clear?encrypt({['mailbox:'+normalized.id]:clear}):{},deletes=identityChanged&&!clear?['mailbox:'+normalized.id]:[];
  store.updateWithCiphers(apply,ciphers,deletes);return normalized.id;
}

export function importMailboxesAtomic(store:Store,items:MailboxWrite[],encrypt:Encrypt):string[]{
  const normalized=items.map(item=>({...item,...normalizeMailbox(item),id:item.id??randomUUID()}));if(new Set(normalized.map(item=>item.id)).size!==normalized.length)throw Error('导入包含重复收件箱 ID');
  const boundSites=normalized.flatMap(item=>item.siteIds??[]);if(new Set(boundSites).size!==boundSites.length)throw Error('同一网站不能在一次导入中绑定多个收件箱');
  const before=store.read(),invalidated=normalized.filter(item=>{const old=before.mailboxes.find(mailbox=>mailbox.id===item.id);return !!old&&mailboxIdentityChanged(old,item)&&!item.password}).map(item=>'mailbox:'+item.id);
  const apply=(state:State)=>{for(const item of normalized){const mailbox=saveMailbox(state,item,false);if(item.password)mailbox.hasPassword=true;bindSites(state,mailbox.id,item.siteIds)}};apply(structuredClone(before));
  const secrets=Object.fromEntries(normalized.map(item=>['mailbox:'+item.id,secret(item)] as const).filter((entry):entry is readonly[string,string]=>!!entry[1])),ciphers=Object.keys(secrets).length?encrypt(secrets):{};
  store.updateWithCiphers(apply,ciphers,invalidated);return normalized.map(item=>item.id);
}
