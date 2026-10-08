import {randomUUID} from 'node:crypto';
import type {Account,SecretStore} from '../shared/types';
import type {Store} from './store';
import {bindAccount} from './account-bindings';
import {CHANNELS} from '../integrations/catalog';
import {connectPaperAccount} from '../integrations/paper';
import {connectHiveAccount} from '../integrations/hive';
import {connectMataroaAccount} from '../integrations/mataroa';

type ChannelId='paper-wf'|'hive'|'mataroa';
type Connector=(vault:SecretStore,id:string,username:string,credential:string)=>Promise<{username:string;url:string}>;
export interface ArticleConnectionInput {channelId:ChannelId;username:string;credential:string;siteIds:string[];accountId?:string}

/** Called only after the desktop's explicit secret-reveal confirmation. Never return a publishing key. */
export function accountLoginPassword(account:Account,secret:string|undefined):string{
  if(account.channelId==='paper-wf'||account.channelId==='mataroa'){
    try{
      const value=JSON.parse(secret??'') as Record<string,unknown>;
      if(value.version!==1||value.username!==account.username||typeof value.password!=='string'||!value.password||value.password.length>1024)throw Error();
      return value.password;
    }catch{throw Error('本机出版账号登录资料无效，请通过连接入口更新');}
  }
  if(['api_token','oauth'].includes(account.credentialKind??''))throw Error('API 令牌不支持明文显示，请通过连接入口更新');
  return secret??'';
}

/** Identity and selected bindings become visible together, after remote validation. */
export async function connectArticleAccount(store:Pick<Store,'read'|'update'>,vault:SecretStore,input:ArticleConnectionInput,connector?:Connector):Promise<Account>{
  const before=store.read(),selected=new Set(input.siteIds),username=input.username.trim().toLowerCase();
  if([...selected].some(id=>!before.sites.some(site=>site.id===id)))throw Error('所选网站已不存在');
  const requested=input.accountId?before.accounts.find(account=>account.id===input.accountId&&account.channelId===input.channelId):undefined;
  if(input.accountId&&!requested)throw Error('要更新的连接不存在');
  if(requested&&requested.username!==username)throw Error('这是另一账号，请新增连接；已有任务保留原身份');
  const previous=requested??before.accounts.find(account=>account.channelId===input.channelId&&account.username===username);
  const id=previous?.id??randomUUID(),oldSecret=await vault.get('account:'+id);
  try{
    const connect=connector??(input.channelId==='hive'?connectHiveAccount:input.channelId==='mataroa'?connectMataroaAccount:connectPaperAccount);
    const identity=await connect(vault,id,username,input.credential);
    if(identity.username!==username)throw Error('验证返回的账号与所选身份不一致');
    const now=new Date().toISOString();
    const account:Account={...previous,id,channelId:input.channelId,username,email:'',displayName:username,publicationUrl:identity.url,credentialKind:'api_token',status:'registered',hasPassword:true,source:previous?.source??'imported',createdAt:previous?.createdAt??now,updatedAt:now,verifiedAt:now,diagnostic:undefined};
    store.update(state=>{
      if([...selected].some(siteId=>!state.sites.some(site=>site.id===siteId)))throw Error('所选网站已不存在');
      const current=state.accounts.find(item=>item.id===id);
      if(current&&(current.channelId!==input.channelId||current.username!==username))throw Error('连接期间账号身份发生变化');
      if(input.channelId==='mataroa')account.mataroaExcludedSiteIds=state.sites.filter(site=>!selected.has(site.id)).map(site=>site.id);
      state.accounts=state.accounts.filter(item=>item.id!==id);state.accounts.push(account);
      const channel=CHANNELS.find(item=>item.id===input.channelId)!;
      for(const siteId of selected)bindAccount(state,id,siteId,channel);
      if(requested||input.channelId==='mataroa')state.accountBindings=state.accountBindings.filter(binding=>binding.accountId!==id||binding.channelId!==input.channelId||selected.has(binding.siteId));
    });
    return account;
  }catch(error){
    if(oldSecret===undefined)await vault.delete('account:'+id);else await vault.set('account:'+id,oldSecret);
    throw error;
  }
}
