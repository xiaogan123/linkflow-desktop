import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Account} from '../shared/types';
import type {Store} from './store';
import type {Vault} from './vault';
import {bindAccount} from './account-bindings';
import {CHANNELS} from '../integrations/catalog';
import {checkDenoSelectedApp,denoTokenFingerprint,serializeDenoToken,validDenoReadAccount,type DenoConnectionDependencies} from '../integrations/deno-connection';

const orgSlug=z.string().trim().regex(/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/);
export const DenoConnectionInput=z.object({token:z.string().min(1).max(4096),appId:z.string().uuid(),declaredOrgSlug:orgSlug,label:z.string().trim().min(1).max(80),siteIds:z.array(z.string().uuid()).max(1000),dedicatedAppAcknowledged:z.literal(true),accountId:z.string().uuid().optional()}).strict();
type Input=z.infer<typeof DenoConnectionInput>;

/** The API app response proves an accessible app UUID, not organization ownership. */
export async function connectDeno(store:Pick<Store,'read'|'updateWithCiphers'>,vault:Pick<Vault,'encryptSecrets'>,input:Input,dependencies:DenoConnectionDependencies={}):Promise<Account>{
  const parsed=DenoConnectionInput.safeParse(input);if(!parsed.success)throw Error('Deno 连接资料格式无效');
  const data=parsed.data,before=store.read(),selected=new Set(data.siteIds);
  if([...selected].some(id=>!before.sites.some(site=>site.id===id)))throw Error('所选网站已不存在');
  const requested=data.accountId?before.accounts.find(account=>account.id===data.accountId&&account.channelId==='deno'):undefined;
  if(data.accountId&&(!requested||!validDenoReadAccount(requested)))throw Error('原 Deno 只读连接不存在或需要重新建立');
  if(requested&&requested.denoReadAccess?.appId!==data.appId.toLowerCase())throw Error('不同应用 UUID 请新增连接，不能覆盖原连接');
  const matches=before.accounts.filter(account=>account.channelId==='deno'&&account.denoReadAccess?.appId===data.appId.toLowerCase());
  if(matches.length>1||matches.some(account=>!validDenoReadAccount(account)))throw Error('本机 Deno 应用连接记录不一致');
  const previous=requested??matches[0];
  const detail=await checkDenoSelectedApp(data.token,data.appId,dependencies);
  if(dependencies.signal?.aborted)throw Error('Deno 连接已取消');
  const now=new Date().toISOString(),id=previous?.id??randomUUID();
  const account:Account={id,channelId:'deno',email:'',displayName:data.label,username:detail.id,source:'imported',credentialKind:'api_token',status:'unknown',hasPassword:true,createdAt:previous?.createdAt??now,updatedAt:now,denoReadAccess:{version:1,checkedAt:now,appId:detail.id,appSlug:detail.slug,declaredOrgSlug:data.declaredOrgSlug,tokenFingerprint:denoTokenFingerprint(data.token),identity:'app_verified_org_declared'}};
  if(!validDenoReadAccount(account))throw Error('Deno 应用连接资料无法安全保存');
  const key='account:'+id,ciphers=vault.encryptSecrets({[key]:serializeDenoToken(data.token)});
  if(typeof ciphers[key]!=='string'||!ciphers[key])throw Error('Deno 组织令牌未能加密');
  if(dependencies.signal?.aborted)throw Error('Deno 连接已取消');
  store.updateWithCiphers(state=>{
    if(dependencies.signal?.aborted)throw Error('Deno 连接已取消');
    if([...selected].some(siteId=>!state.sites.some(site=>site.id===siteId)))throw Error('所选网站已不存在');
    const current=state.accounts.find(item=>item.id===id);
    if(previous?JSON.stringify(current)!==JSON.stringify(previous):!!current)throw Error('验证期间连接记录发生变化');
    if(state.accounts.some(item=>item.id!==id&&item.channelId==='deno'&&item.denoReadAccess?.appId===detail.id))throw Error('验证期间同一 Deno 应用已连接');
    state.accounts=state.accounts.filter(item=>item.id!==id);state.accounts.push(account);
    const channel=CHANNELS.find(item=>item.id==='deno')!;
    for(const siteId of selected)bindAccount(state,id,siteId,channel);
    if(requested)state.accountBindings=state.accountBindings.filter(binding=>binding.accountId!==id||binding.channelId!=='deno'||selected.has(binding.siteId));
  },ciphers);
  return account;
}
