import {randomUUID} from 'node:crypto';
import type {Account,SecretStore} from '../shared/types';
import type {Store} from './store';
import {bindAccount} from './account-bindings';
import {CHANNELS} from '../integrations/catalog';
import {validateParagraphApiKey,connectParagraphPublication,type ParagraphDependencies} from '../integrations/paragraph';

export async function connectParagraph(
  store:Pick<Store,'read'|'update'>,vault:SecretStore,apiKey:string,siteIds:string[],existingAccountId?:string,
  dependencies:ParagraphDependencies={},
):Promise<Account>{
  const before=store.read(),selected=new Set(siteIds);
  if([...selected].some(id=>!before.sites.some(site=>site.id===id)))throw Error('所选网站已不存在');
  const requested=existingAccountId?before.accounts.find(account=>account.id===existingAccountId&&account.channelId==='paragraph'):undefined;
  if(existingAccountId&&!requested)throw Error('要更新的 Paragraph 连接不存在');
  const publication=await validateParagraphApiKey(apiKey,dependencies);
  if(requested&&requested.username!==publication.id)throw Error('API key 属于另一出版物，请新增连接，不会覆盖原有身份');
  const previous=requested??before.accounts.find(account=>account.channelId==='paragraph'&&account.username===publication.id);
  const id=previous?.id??randomUUID(),oldSecret=await vault.get('account:'+id),now=new Date().toISOString();
  try{
    const confirmed=await connectParagraphPublication(vault,id,apiKey,dependencies);
    if(confirmed.id!==publication.id||confirmed.url!==publication.url)throw Error('验证期间出版物身份发生变化');
    const account:Account={...previous,id,channelId:'paragraph',credentialKind:'api_token',email:'',username:publication.id,displayName:publication.name,publicationUrl:publication.url,createdAt:previous?.createdAt??now,updatedAt:now,verifiedAt:now,status:'registered',hasPassword:true,source:'imported',diagnostic:undefined};
    store.update(state=>{
      if([...selected].some(siteId=>!state.sites.some(site=>site.id===siteId)))throw Error('所选网站已不存在');
      const current=state.accounts.find(item=>item.id===id);
      if(current&&(current.channelId!=='paragraph'||current.username!==publication.id))throw Error('连接期间账号身份发生变化');
      state.accounts=state.accounts.filter(item=>item.id!==id);state.accounts.push(account);
      const channel=CHANNELS.find(item=>item.id==='paragraph')!;
      for(const siteId of selected)bindAccount(state,id,siteId,channel);
      state.accountBindings=state.accountBindings.filter(binding=>binding.accountId!==id||binding.channelId!=='paragraph'||selected.has(binding.siteId));
    });
    return account;
  }catch(error){
    if(oldSecret===undefined)await vault.delete('account:'+id);else await vault.set('account:'+id,oldSecret);
    throw error;
  }
}
