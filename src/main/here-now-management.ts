import {randomUUID} from 'node:crypto';
import {CHANNELS} from '../integrations/catalog';
import {inspectHereNowIdentity,type HereNowIdentity} from '../integrations/here-now-account';
import type {HereNowDependencies} from '../integrations/here-now';
import type {Account} from '../shared/types';
import {bindAccount,unbindAccount} from './account-bindings';
import type {Store} from './store';
import type {Vault} from './vault';

type StateStore=Pick<Store,'read'|'updateWithCiphers'>;
type AtomicVault=Pick<Vault,'get'|'encryptSecrets'>;
export interface HereNowConnectionInput {apiKey?:string;existingSiteUrl?:string;siteIds:string[];accountId?:string}

export function validHereNowAccount(account:Account|undefined):account is Account&{hereNow:NonNullable<Account['hereNow']>}{
  const data=account?.hereNow;
  return !!account&&account.channelId==='here-now'&&account.credentialKind==='api_token'&&account.status==='registered'&&account.hasPassword&&account.source==='imported'&&!!data&&data.version===1&&data.identity==='verified_personal'&&/^[0-9a-f-]{36}$/i.test(data.accountId)&&/^[a-f0-9]{64}$/.test(data.keyFingerprint)&&account.username===data.accountId&&(!data.existingSiteUrl||data.existingSiteUrl===`https://${data.existingSlug}.here.now/`);
}

function identityMatches(account:Account,identity:HereNowIdentity){return account.hereNow?.accountId===identity.accountId&&account.email===identity.email}
export async function connectHereNow(store:StateStore,vault:AtomicVault,input:HereNowConnectionInput,deps:HereNowDependencies={}):Promise<Account>{
  const before=store.read(),selected=new Set(input.siteIds);if([...selected].some(id=>!before.sites.some(site=>site.id===id)))throw Error('所选网站已不存在');const requested=input.accountId?before.accounts.find(account=>account.id===input.accountId&&account.channelId==='here-now'):undefined;if(input.accountId&&!requested)throw Error('要更新的 here.now 连接不存在');
  const supplied=input.apiKey?.trim(),stored=supplied?undefined:requested?await vault.get(`account:${requested.id}`):undefined,apiKey=supplied||stored;if(!apiKey)throw Error(requested?'未找到原 here.now 命名 API key；请重新粘贴后验证':'请粘贴 here.now 命名 API key');
  const identity=await inspectHereNowIdentity(apiKey,input.existingSiteUrl??requested?.hereNow?.existingSiteUrl,deps);if(deps.signal?.aborted)throw Error('here.now 连接已取消');const duplicates=before.accounts.filter(account=>account.channelId==='here-now'&&account.hereNow?.accountId===identity.accountId);if(duplicates.length>1)throw Error('本机 here.now 个人身份记录不一致');const existing=requested??duplicates[0];if(existing&&!identityMatches(existing,identity))throw Error('新 key 属于另一个 here.now 个人身份，不会覆盖原连接');if(requested&&!supplied&&requested.hereNow?.keyFingerprint!==identity.keyFingerprint)throw Error('本机 here.now key 与已保存身份不一致');if(existing&&existing.hereNow?.keyFingerprint!==identity.keyFingerprint&&before.tasks.some(task=>task.accountId===existing.id&&task.channelId==='here-now'&&!task.firstLiveAt&&!!(task.hereNow||task.submittedAt||task.publicUrl)))throw Error('原 here.now 发布仍待对账，暂不更换 key');
  const id=existing?.id??randomUUID(),now=new Date().toISOString(),account:Account={...existing,id,channelId:'here-now',email:identity.email,username:identity.accountId,displayName:identity.displayName,publicationUrl:identity.existingSiteUrl,credentialKind:'api_token',status:'registered',hasPassword:true,source:'imported',createdAt:existing?.createdAt??now,updatedAt:now,registeredAt:existing?.registeredAt??now,verifiedAt:now,diagnostic:undefined,hereNow:{version:1,checkedAt:now,accountId:identity.accountId,keyFingerprint:identity.keyFingerprint,identity:'verified_personal',existingSlug:identity.existingSlug,existingSiteUrl:identity.existingSiteUrl}};
  const key=`account:${id}`,ciphers=supplied?vault.encryptSecrets({[key]:apiKey}):{};if(supplied&&(!ciphers[key]||ciphers[key]===apiKey))throw Error('here.now API key 未能加密');
  store.updateWithCiphers(state=>{if(deps.signal?.aborted)throw Error('here.now 连接已取消');if([...selected].some(siteId=>!state.sites.some(site=>site.id===siteId)))throw Error('所选网站已不存在');const current=state.accounts.find(item=>item.id===id);if(existing?JSON.stringify(current)!==JSON.stringify(existing):!!current)throw Error('验证期间 here.now 连接发生变化');if(state.accounts.some(item=>item.id!==id&&item.channelId==='here-now'&&item.hereNow?.accountId===identity.accountId))throw Error('同一 here.now 个人身份已连接');state.accounts=state.accounts.filter(item=>item.id!==id);state.accounts.push(account);const channel=CHANNELS.find(item=>item.id==='here-now');if(!channel)throw Error('here.now 渠道尚未就绪');if(existing)for(const binding of [...state.accountBindings])if(binding.accountId===id&&binding.channelId==='here-now'&&!selected.has(binding.siteId))unbindAccount(state,id,binding.siteId,'here-now');for(const siteId of selected)bindAccount(state,id,siteId,channel)},ciphers);
  return account;
}
