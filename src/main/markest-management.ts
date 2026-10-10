import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Account} from '../shared/types';
import type {Store} from './store';
import type {Vault} from './vault';
import {bindAccount} from './account-bindings';
import {CHANNELS} from '../integrations/catalog';
import {checkMarkestReadAccess,markestKeyFingerprint,serializeMarkestKey,validMarkestReadAccount,type MarkestConnectionDependencies} from '../integrations/markest-connection';

export const MarkestConnectionInput=z.object({apiKey:z.string().trim().regex(/^mk_live_[a-fA-F0-9]{48}$/),declaredEmail:z.email().max(254),label:z.string().trim().min(1).max(80),siteIds:z.array(z.string().uuid()).max(1000),accountId:z.string().uuid().optional()}).strict();
type Input=z.infer<typeof MarkestConnectionInput>;
export async function connectMarkest(store:Pick<Store,'read'|'updateWithCiphers'>,vault:Pick<Vault,'encryptSecrets'>,input:Input,dependencies:MarkestConnectionDependencies={}):Promise<Account>{
  const parsed=MarkestConnectionInput.safeParse(input);if(!parsed.success)throw Error('Markest 连接资料格式无效');
  const data=parsed.data,before=store.read(),selected=new Set(data.siteIds),fingerprint=markestKeyFingerprint(data.apiKey);
  if([...selected].some(id=>!before.sites.some(site=>site.id===id)))throw Error('所选网站已不存在');
  const requested=data.accountId?before.accounts.find(account=>account.id===data.accountId&&account.channelId==='markest'):undefined;
  if(data.accountId&&(!requested||!validMarkestReadAccount(requested)))throw Error('原 Markest 只读连接不存在或需要重新建立');
  if(requested?.markestReadAccess?.keyFingerprint&&requested.markestReadAccess.keyFingerprint!==fingerprint)throw Error('不同 key 请新增连接，不能覆盖原连接');
  const matches=before.accounts.filter(account=>account.channelId==='markest'&&account.markestReadAccess?.keyFingerprint===fingerprint);
  if(matches.length>1||matches.some(account=>!validMarkestReadAccount(account)))throw Error('本机 Markest 连接记录不一致，请先检查');
  const previous=requested??matches[0],id=previous?.id??randomUUID();
  await checkMarkestReadAccess(data.apiKey,dependencies);
  if(dependencies.signal?.aborted)throw Error('Markest 连接已取消');
  const now=new Date().toISOString();
  const account:Account={id,channelId:'markest',email:data.declaredEmail,displayName:data.label,username:'local-key:'+fingerprint,source:'imported',credentialKind:'api_token',status:'unknown',hasPassword:true,createdAt:previous?.createdAt??now,updatedAt:now,markestReadAccess:{version:1,checkedAt:now,keyFingerprint:fingerprint,identity:'user_declared'}};
  const key='account:'+id,ciphers=vault.encryptSecrets({[key]:serializeMarkestKey(data.apiKey)});
  if(typeof ciphers[key]!=='string'||!ciphers[key])throw Error('Markest key 未能加密');
  if(dependencies.signal?.aborted)throw Error('Markest 连接已取消');
  store.updateWithCiphers(state=>{
    if(dependencies.signal?.aborted)throw Error('Markest 连接已取消');
    if([...selected].some(siteId=>!state.sites.some(site=>site.id===siteId)))throw Error('所选网站已不存在');
    const current=state.accounts.find(item=>item.id===id);
    if(previous?JSON.stringify(current)!==JSON.stringify(previous):!!current)throw Error('验证期间连接记录发生变化');
    if(state.accounts.some(item=>item.id!==id&&item.channelId==='markest'&&item.markestReadAccess?.keyFingerprint===fingerprint))throw Error('验证期间同一 key 已连接');
    state.accounts=state.accounts.filter(item=>item.id!==id);state.accounts.push(account);
    const channel=CHANNELS.find(item=>item.id==='markest')!;
    for(const siteId of selected)bindAccount(state,id,siteId,channel);
    if(requested)state.accountBindings=state.accountBindings.filter(binding=>binding.accountId!==id||binding.channelId!=='markest'||selected.has(binding.siteId));
  },ciphers);
  return account;
}
