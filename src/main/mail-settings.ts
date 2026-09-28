import {randomUUID} from 'node:crypto';
import type {Mailbox,Settings} from '../shared/types';
import type {State} from './store';
/** A saved mailbox secret belongs to one server, port and account, never a newly selected provider. */
export function mailboxIdentityChanged<P extends Pick<Settings['mail'],'host'|'port'|'user'|'secure'>,N extends Pick<Settings['mail'],'host'|'port'|'user'|'secure'>>(previous:P,next:N):boolean{
  const host=(value:string)=>value.trim().toLowerCase().replace(/\.$/,'');
  return host(previous.host)!==host(next.host)||previous.port!==next.port||previous.secure!==next.secure||previous.user.trim()!==next.user.trim();
}

export interface MailboxInput {id?:string;label:string;host:string;port:number;user:string;secure:true;aliases?:string[]}
export type NormalizedMailboxInput=Omit<MailboxInput,'aliases'>&{aliases:string[]};
export interface MailboxTestInput {id?:string;label?:string;host?:string;port?:number;user?:string;secure?:true;password?:string;aliases?:string[]}
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeMailbox(input:MailboxInput):NormalizedMailboxInput{
  const host=input.host.trim().toLowerCase().replace(/\.$/,'');
  const user=input.user.trim(),label=input.label.trim(),aliases=[...new Set((input.aliases??[]).map(value=>value.trim().toLowerCase()).filter(Boolean))];
  if(!label||label.length>100)throw Error('收件箱名称需要 1–100 个字符');
  if(!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host))throw Error('请填写有效的 IMAP 服务器域名');
  if(!EMAIL.test(user))throw Error('请填写有效的收件箱账号');
  if(!Number.isInteger(input.port)||input.port<1||input.port>65535)throw Error('请填写有效的 IMAP 端口');
  if(input.secure!==true)throw Error('收件箱必须使用 TLS');
  if(aliases.some(value=>!EMAIL.test(value)))throw Error('收件箱别名中存在无效邮箱地址');
  return {id:input.id,label,host,port:input.port,user,secure:true,aliases};
}

export function saveMailbox(state:State,input:MailboxInput,hasNewPassword=false,now=new Date()):Mailbox{
  const value=normalizeMailbox(input),old=value.id?state.mailboxes.find(item=>item.id===value.id):undefined;
  if(state.mailboxes.some(item=>item.id!==value.id&&item.host===value.host&&item.port===value.port&&item.user.toLowerCase()===value.user.toLowerCase()))throw Error('该 IMAP 账号已存在');
  const stamp=now.toISOString(),identityChanged=!!old&&mailboxIdentityChanged(old,value);
  const mailbox:Mailbox={...old,...value,id:old?.id??value.id??randomUUID(),createdAt:old?.createdAt??stamp,updatedAt:stamp,hasPassword:hasNewPassword||(!identityChanged&&old?.hasPassword)||false,verifiedAt:identityChanged?undefined:old?.verifiedAt,lastError:identityChanged?undefined:old?.lastError};
  state.mailboxes=state.mailboxes.filter(item=>item.id!==mailbox.id);state.mailboxes.push(mailbox);return mailbox;
}

export function deleteMailbox(state:State,id:string):void{
  if(!state.mailboxes.some(item=>item.id===id))throw Error('收件箱不存在');
  if(state.sites.some(site=>site.mailboxId===id)||state.accounts.some(account=>account.mailboxId===id))throw Error('收件箱仍被网站或账号引用，请先更换绑定');
  state.mailboxes=state.mailboxes.filter(item=>item.id!==id);
}

export function prepareMailboxTest(saved:Mailbox|undefined,input:MailboxTestInput,storedPassword?:string,now=new Date()):{mailbox:Mailbox;password:string;identityChanged:boolean;canMarkVerified:boolean}{
  const candidate=normalizeMailbox({id:saved?.id,label:input.label??saved?.label??input.user??'',host:input.host??saved?.host??'',port:input.port??saved?.port??993,user:input.user??saved?.user??'',secure:true,aliases:input.aliases??saved?.aliases??[]});
  const identityChanged=!!saved&&mailboxIdentityChanged(saved,candidate),password=input.password??(!identityChanged?storedPassword:undefined)??'';
  const stamp=now.toISOString(),mailbox:Mailbox={...saved,...candidate,id:saved?.id??'preview',hasPassword:!!password,createdAt:saved?.createdAt??stamp,updatedAt:stamp};
  return {mailbox,password,identityChanged,canMarkVerified:!!saved&&!identityChanged&&!!storedPassword&&password===storedPassword};
}
