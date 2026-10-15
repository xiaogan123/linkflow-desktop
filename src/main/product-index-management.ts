import {randomUUID} from 'node:crypto';
import {validateProductIndexToken,type ProductIndexDependencies} from '../integrations/product-index';
import {CHANNELS} from '../integrations/catalog';
import type {Account} from '../shared/types';
import {bindAccount} from './account-bindings';
import type {Store} from './store';
import type {Vault} from './vault';

type StateStore=Pick<Store,'read'|'updateWithCiphers'>;
export async function connectProductIndex(store:StateStore,vault:Pick<Vault,'encryptSecrets'>,input:{token:string;accountId?:string;siteIds:string[]},deps:ProductIndexDependencies={}){
  const token=input.token.trim();if(token.length<8||token.length>512)throw Error('GitHub 令牌格式无效');const identity=await validateProductIndexToken(token,deps),state=store.read(),target=input.accountId?state.accounts.find(account=>account.id===input.accountId&&account.channelId==='product-index'):undefined;
  if(input.accountId&&!target)throw Error('AI Product Index GitHub 身份不存在');if(target&&target.username.toLowerCase()!==identity.login.toLowerCase())throw Error('新令牌属于不同 GitHub 身份，不会覆盖已有连接；请新增连接。');
  const same=state.accounts.find(account=>account.channelId==='product-index'&&account.username.toLowerCase()===identity.login.toLowerCase()),old=target??same,accountId=old?.id??randomUUID(),siteIds=[...new Set(input.siteIds)];if(siteIds.some(siteId=>!state.sites.some(site=>site.id===siteId)))throw Error('所选网站不存在');
  const now=identity.checkedAt,account:Account={...old,id:accountId,channelId:'product-index',credentialKind:'api_token',email:'',username:identity.login,displayName:`GitHub · ${identity.login}`,createdAt:old?.createdAt??now,updatedAt:now,verifiedAt:now,status:'registered',hasPassword:true,source:'imported',diagnostic:undefined,productIndex:{version:1,login:identity.login,tokenFingerprint:identity.tokenFingerprint,checkedAt:identity.checkedAt,identity:'github_user_readback'}};
  const key=`account:${account.id}`,cipher=vault.encryptSecrets({[key]:token})[key];if(!cipher||cipher===token)throw Error('GitHub 令牌未加密');const channel=CHANNELS.find(value=>value.id==='product-index');if(!channel)throw Error('AI Product Index 渠道尚未就绪');
  store.updateWithCiphers(current=>{if(siteIds.some(siteId=>!current.sites.some(site=>site.id===siteId)))throw Error('连接期间所选网站已改变');const existing=current.accounts.find(value=>value.id===account.id);if(existing&&(existing.channelId!=='product-index'||existing.username.toLowerCase()!==identity.login.toLowerCase()))throw Error('连接期间 GitHub 身份已改变');current.accounts=current.accounts.filter(value=>value.id!==account.id);current.accounts.push(account);for(const siteId of siteIds)bindAccount(current,account.id,siteId,channel);current.accountBindings=current.accountBindings.filter(binding=>binding.accountId!==account.id||binding.channelId!=='product-index'||siteIds.includes(binding.siteId))},{[key]:cipher});
  return account;
}
