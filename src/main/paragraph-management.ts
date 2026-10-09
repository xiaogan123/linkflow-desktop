import {randomUUID} from 'node:crypto';
import type {Account,SecretStore} from '../shared/types';
import type {Store} from './store';
import type {Vault} from './vault';
import {bindAccount} from './account-bindings';
import {CHANNELS} from '../integrations/catalog';
import {validateParagraphApiKey,connectParagraphPublication,type ParagraphDependencies} from '../integrations/paragraph';

type StateStore=Pick<Store,'read'|'updateWithCiphers'>;
type AtomicVault=Pick<Vault,'encryptSecrets'>;

function memorySecrets(){
  const values=new Map<string,string>();
  const store:SecretStore={get:async key=>values.get(key),set:async(key,value)=>{values.set(key,value)},delete:async key=>{values.delete(key)}};
  return {store,get:(key:string)=>values.get(key)};
}

export async function connectParagraph(
  store:StateStore,vault:AtomicVault,apiKey:string,siteIds:string[],existingAccountId?:string,
  dependencies:ParagraphDependencies={},
):Promise<Account>{
  const before=store.read(),selected=new Set(siteIds);
  if([...selected].some(id=>!before.sites.some(site=>site.id===id)))throw Error('所选网站已不存在');
  const requested=existingAccountId?before.accounts.find(account=>account.id===existingAccountId&&account.channelId==='paragraph'):undefined;
  if(existingAccountId&&!requested)throw Error('要更新的 Paragraph 连接不存在');
  const publication=await validateParagraphApiKey(apiKey,dependencies);
  if(dependencies.signal?.aborted)throw Error('Paragraph 连接已取消');
  if(requested&&requested.username!==publication.id)throw Error('API key 属于另一出版物，请新增连接，不会覆盖原有身份');
  const previous=requested??before.accounts.find(account=>account.channelId==='paragraph'&&account.username===publication.id);
  const id=previous?.id??randomUUID(),captured=memorySecrets();
  let confirmed:Awaited<ReturnType<typeof connectParagraphPublication>>;
  try{confirmed=await connectParagraphPublication(captured.store,id,apiKey,dependencies);}
  catch(error){if(dependencies.signal?.aborted)throw Error('Paragraph 连接已取消');throw error}
  if(dependencies.signal?.aborted)throw Error('Paragraph 连接已取消');
  if(confirmed.id!==publication.id||confirmed.url!==publication.url||confirmed.ownerUserId!==publication.ownerUserId||confirmed.slug!==publication.slug)throw Error('验证期间出版物身份发生变化');
  const secret=captured.get('account:'+id);if(!secret)throw Error('Paragraph 凭据验证未完成');
  const now=new Date().toISOString();
  const account:Account={...previous,id,channelId:'paragraph',credentialKind:'api_token',email:'',username:publication.id,displayName:publication.name,publicationUrl:publication.url,createdAt:previous?.createdAt??now,updatedAt:now,verifiedAt:now,status:'registered',hasPassword:true,source:'imported',diagnostic:undefined};
  const key='account:'+id,ciphers=vault.encryptSecrets({[key]:secret});if(typeof ciphers[key]!=='string'||!ciphers[key])throw Error('Paragraph 凭据未能加密');
  if(dependencies.signal?.aborted)throw Error('Paragraph 连接已取消');
  store.updateWithCiphers(state=>{
    if([...selected].some(siteId=>!state.sites.some(site=>site.id===siteId)))throw Error('所选网站已不存在');
    const current=state.accounts.find(item=>item.id===id);
    if(previous&&(!current||current.channelId!=='paragraph'||current.username!==publication.id))throw Error('连接期间账号身份发生变化');
    if(!previous&&current)throw Error('连接期间账号身份发生变化');
    state.accounts=state.accounts.filter(item=>item.id!==id);state.accounts.push(account);
    const channel=CHANNELS.find(item=>item.id==='paragraph')!;
    for(const siteId of selected)bindAccount(state,id,siteId,channel);
    // Only the explicit edit drawer shows all previous bindings for replacement.
    if(requested)state.accountBindings=state.accountBindings.filter(binding=>binding.accountId!==id||binding.channelId!=='paragraph'||selected.has(binding.siteId));
  },ciphers);
  return account;
}
