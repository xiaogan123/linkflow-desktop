import {randomUUID} from 'node:crypto';
import {MAIL_AUTOMATION_MESSAGES} from '../shared/mail-automation';
import type {Store,State} from './store';
import {mailboxIdentityChanged,normalizeMailbox,saveMailbox,type MailboxInput} from './mail-settings';

export type MailboxWrite=MailboxInput&{password?:string;siteIds?:string[]};
type Encrypt=(secrets:Record<string,string>)=>Record<string,string>;

function bindSites(state:State,mailboxId:string,siteIds:string[]|undefined){if(!siteIds)return;const selected=new Set(siteIds);if([...selected].some(id=>!state.sites.some(site=>site.id===id)))throw Error('绑定的网站不存在');for(const site of state.sites){if(selected.has(site.id))site.mailboxId=mailboxId;else if(site.mailboxId===mailboxId)delete site.mailboxId}}
function secret(input:MailboxWrite){if(input.password===undefined)return;const value=input.host.trim().toLowerCase().replace(/\.$/,'')==='imap.gmail.com'?input.password.replace(/\s/g,''):input.password;if(!value)throw Error('收件箱密码不能为空');return value}

export function saveMailboxAtomic(store:Store,input:MailboxWrite,encrypt:Encrypt):string{
  const before=store.read(),old=input.id?before.mailboxes.find(item=>item.id===input.id):undefined;if(input.id&&!old)throw Error('收件箱不存在');
  const normalized={...normalizeMailbox(input),id:input.id??randomUUID(),password:input.password,siteIds:input.siteIds},identityChanged=!!old&&mailboxIdentityChanged(old,normalized);
  const apply=(state:State)=>{const mailbox=saveMailbox(state,normalized,!!input.password);bindSites(state,mailbox.id,input.siteIds)};apply(structuredClone(before));
  const clear=secret(normalized),ciphers=clear?encrypt({['mailbox:'+normalized.id]:clear}):{},deletes=identityChanged&&!clear?['mailbox:'+normalized.id]:[];
  store.updateWithCiphers(apply,ciphers,deletes);return normalized.id;
}

export function importMailboxesAtomic(store:Store,items:MailboxWrite[],encrypt:Encrypt):string[]{
  const normalized=items.map(item=>({...item,...normalizeMailbox(item),id:item.id??randomUUID()}));if(new Set(normalized.map(item=>item.id)).size!==normalized.length)throw Error('导入包含重复收件箱 ID');
  const boundSites=normalized.flatMap(item=>item.siteIds??[]);if(new Set(boundSites).size!==boundSites.length)throw Error('同一网站不能在一次导入中绑定多个收件箱');
  const before=store.read(),invalidated=normalized.filter(item=>{const old=before.mailboxes.find(mailbox=>mailbox.id===item.id);return !!old&&mailboxIdentityChanged(old,item)&&!item.password}).map(item=>'mailbox:'+item.id);
  const apply=(state:State)=>{for(const item of normalized){saveMailbox(state,item,!!item.password);bindSites(state,item.id,item.siteIds)}};apply(structuredClone(before));
  const secrets=Object.fromEntries(normalized.map(item=>['mailbox:'+item.id,secret(item)] as const).filter((entry):entry is readonly[string,string]=>!!entry[1])),ciphers=Object.keys(secrets).length?encrypt(secrets):{};
  store.updateWithCiphers(apply,ciphers,invalidated);return normalized.map(item=>item.id);
}

export interface MailboxSaveTestOptions {
  getPassword?:(key:string)=>Promise<string|undefined>;
  test?:(mailbox:import('../shared/types').Mailbox,password:string)=>Promise<{ok:boolean;message:string}>;
  now?:()=>Date;
}

/** Test the exact proposed connection, then commit its credential and honest result together. */
export async function saveMailboxAndTestAtomic(store:Store,input:MailboxWrite,encrypt:Encrypt,options:MailboxSaveTestOptions={}):Promise<{id:string;ok:boolean;message:string}>{
  const [result]=await importMailboxesAndTestAtomic(store,[input],encrypt,options);
  return result;
}

export async function importMailboxesAndTestAtomic(store:Store,items:MailboxWrite[],encrypt:Encrypt,options:MailboxSaveTestOptions={}):Promise<Array<{id:string;ok:boolean;message:string}>>{
  const before=store.read(),normalized=items.map(item=>({...item,...normalizeMailbox(item),id:item.id??randomUUID()}));
  if(new Set(normalized.map(item=>item.id)).size!==normalized.length)throw Error('导入包含重复收件箱 ID');
  const siteIds=normalized.flatMap(item=>item.siteIds??[]);
  if(new Set(siteIds).size!==siteIds.length)throw Error('同一网站不能在一次导入中绑定多个收件箱');
  const oldById=new Map(before.mailboxes.map(mailbox=>[mailbox.id,mailbox]));
  for(const item of items)if(item.id&&!oldById.has(item.id))throw Error('收件箱不存在');
  const applyInput=(state:State)=>{for(const item of normalized){saveMailbox(state,item,!!item.password);bindSites(state,item.id,item.siteIds)}};
  applyInput(structuredClone(before));
  const secrets:Record<string,string>={},expected:Record<string,string|undefined>={},deletes:string[]=[];
  const tested:Array<{id:string;ok:boolean;message:string}>=[];
  const {testMailbox}=await import('../integrations/mail');
  for(const item of normalized){
    const key='mailbox:'+item.id,old=oldById.get(item.id),changed=!!old&&mailboxIdentityChanged(old,item),clear=secret(item);
    expected[key]=store.getCipher(key);
    if(clear)secrets[key]=clear;
    else if(changed)deletes.push(key);
    const password=clear??(!changed&&old?await options.getPassword?.(key):undefined)??'';
    const stamp=(options.now?.()??new Date()).toISOString();
    const mailbox={...old,...item,createdAt:old?.createdAt??stamp,updatedAt:stamp,hasPassword:!!password};
    // Never pass the write payload (which contains the password) to state persistence.
    const {password:_password,siteIds:_sites,...connection}=mailbox;
    let result:{ok:boolean;message:string};
    try{result=await (options.test??testMailbox)(connection,password)}catch{result={ok:false,message:MAIL_AUTOMATION_MESSAGES.connectionFailed}}
    tested.push({id:item.id,...result});
  }
  const ciphers=Object.keys(secrets).length?encrypt(secrets):{},stamp=(options.now?.()??new Date()).toISOString();
  store.updateWithCiphers(state=>{
    for(const item of normalized)if(JSON.stringify(state.mailboxes.find(mailbox=>mailbox.id===item.id))!==JSON.stringify(oldById.get(item.id)))throw Error(MAIL_AUTOMATION_MESSAGES.identityChanged);
    applyInput(state);
    for(const result of tested){const mailbox=state.mailboxes.find(item=>item.id===result.id)!;mailbox.updatedAt=stamp;mailbox.verifiedAt=result.ok?stamp:undefined;mailbox.lastError=result.ok?undefined:result.message}
  },ciphers,deletes,expected);
  return tested;
}
