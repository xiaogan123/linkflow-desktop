import {randomUUID} from 'node:crypto';
import {CHANNELS} from '../integrations/catalog';
import {
  canonicalRaindropPublicUrl,listRaindropCollections,raindropTokenFingerprint,
  RaindropError,readRaindropCollection,verifyRaindropPublicCollection,type RaindropDependencies,
} from '../integrations/raindrop';
import type {Account,RaindropCollectionResult} from '../shared/types';
import {AccountBindingError,bindAccount,unbindAccount} from './account-bindings';
import type {Store} from './store';
import type {Vault} from './vault';

type StateStore=Pick<Store,'read'|'updateWithCiphers'>;
type AtomicVault=Pick<Vault,'encryptSecrets'>;
export interface RaindropSelection {token:string;collectionId:string;publicUrl:string;siteIds:string[];accountId?:string}

export type RaindropManagementErrorCode='connection_missing'|'site_missing'|'cancelled'|'invalid_selection'|'remote_unverified'|'identity_changed'|'identity_mismatch'|'history_bound'|'reconciliation_pending'|'encryption_failed'|'channel_unavailable'|'connection_failed';
export class RaindropManagementError extends Error{
  constructor(readonly code:RaindropManagementErrorCode,message:string,options?:ErrorOptions){super(message,options);this.name='RaindropManagementError'}
}
const EXPOSED_RAINDROP_ERRORS:ReadonlySet<RaindropManagementErrorCode>=new Set(['connection_missing','site_missing','cancelled','invalid_selection','identity_changed','identity_mismatch','history_bound','reconciliation_pending']);

function cancelled(signal?:AbortSignal){if(signal?.aborted)throw new RaindropManagementError('cancelled','Raindrop 连接已取消')}

export async function discoverRaindropCollections(token:string,deps:RaindropDependencies={}):Promise<RaindropCollectionResult>{
  cancelled(deps.signal);const result=await listRaindropCollections(token,deps);cancelled(deps.signal);return result;
}

/** Token, account metadata and site bindings become visible in one SQLite transaction. */
export async function connectRaindrop(store:StateStore,vault:AtomicVault,input:RaindropSelection,deps:RaindropDependencies={}):Promise<Account>{
  const selected=new Set(input.siteIds),before=store.read(),requested=input.accountId?before.accounts.find(account=>account.id===input.accountId&&account.channelId==='raindrop'):undefined;
  if(input.accountId&&!requested)throw new RaindropManagementError('connection_missing','要更新的 Raindrop 连接不存在');
  const validateSites=(state:ReturnType<StateStore['read']>)=>{if([...selected].some(id=>!state.sites.some(site=>site.id===id)))throw new RaindropManagementError('site_missing','所选网站已不存在')};validateSites(before);cancelled(deps.signal);
  try{
    const discovered=await listRaindropCollections(input.token,deps);cancelled(deps.signal);
    const listed=discovered.collections.find(item=>item.id===input.collectionId);
    if(!listed||listed.parentId!==undefined||!listed.public||listed.accessLevel!==4||listed.ownerId!==discovered.ownerId)throw new RaindropManagementError('invalid_selection','请选择本人所有、已公开的专用根合集');
    const remote=await readRaindropCollection(input.token,input.collectionId,deps);cancelled(deps.signal);
    if(remote.id!==listed.id||remote.ownerId!==listed.ownerId||remote.accessLevel!==4||!remote.public||remote.parentId!==undefined)throw new RaindropManagementError('remote_unverified','Raindrop 选定合集的所有者、访问权或根层级无法核对');
    const publicUrl=canonicalRaindropPublicUrl(input.publicUrl),page=await verifyRaindropPublicCollection(publicUrl,remote.id,remote.ownerId,deps);cancelled(deps.signal);
    const latest=store.read();validateSites(latest);
    const existing=input.accountId?latest.accounts.find(account=>account.id===input.accountId&&account.channelId==='raindrop'):latest.accounts.find(account=>account.channelId==='raindrop'&&account.raindrop?.ownerId===remote.ownerId&&account.raindrop.collectionId===remote.id);
    if(input.accountId&&!existing)throw new RaindropManagementError('identity_changed','Raindrop 发布账号在连接期间发生变化');
    if(existing&&(existing.raindrop?.ownerId!==remote.ownerId||existing.raindrop.collectionId!==remote.id))throw new RaindropManagementError('identity_mismatch','新 Test token 或合集属于另一个发布账号，不会覆盖原连接');
    if(requested&&existing&&(requested.raindrop?.ownerId!==existing.raindrop?.ownerId||requested.raindrop?.collectionId!==existing.raindrop?.collectionId||requested.raindrop?.publicUrl!==existing.raindrop?.publicUrl||requested.raindrop?.tokenFingerprint!==existing.raindrop?.tokenFingerprint||requested.raindrop?.tokenVersion!==existing.raindrop?.tokenVersion))throw new RaindropManagementError('identity_changed','Raindrop 发布账号在连接期间发生变化');
    if(!requested&&existing&&existing.raindrop?.publicUrl!==publicUrl)throw new RaindropManagementError('identity_changed','Raindrop 发布账号在连接期间发生变化');
    const hasHistory=!!existing&&latest.tasks.some(task=>task.accountId===existing.id&&task.channelId==='raindrop'&&!!(task.raindrop||task.submittedAt||task.publicUrl||task.firstLiveAt));
    if(hasHistory&&existing!.raindrop!.publicUrl!==publicUrl)throw new RaindropManagementError('history_bound','该 Raindrop 连接已绑定历史返回记录，不能更换公开页');
    const id=existing?.id??randomUUID(),now=new Date().toISOString(),fingerprint=raindropTokenFingerprint(input.token),sameToken=existing?.raindrop?.tokenFingerprint===fingerprint,tokenVersion=sameToken?existing!.raindrop!.tokenVersion:(existing?.raindrop?.tokenVersion??0)+1;
    if(existing&&!sameToken&&latest.tasks.some(task=>task.accountId===existing.id&&task.channelId==='raindrop'&&!task.firstLiveAt&&!!(task.raindrop||task.submittedAt||task.publicUrl)))throw new RaindropManagementError('reconciliation_pending','原 Raindrop 提交仍待核对，暂不更换 Test token；先用原发布账号完成检查');
    const account:Account={...existing,id,channelId:'raindrop',email:'',username:remote.ownerId,displayName:page.title,publicationUrl:publicUrl,credentialKind:'api_token',hasPassword:true,status:'registered',source:'imported',createdAt:existing?.createdAt??now,updatedAt:now,verifiedAt:now,diagnostic:undefined,raindrop:{version:1,ownerId:remote.ownerId,collectionId:remote.id,publicUrl,tokenFingerprint:fingerprint,tokenVersion,connectedAt:now,...(existing?.raindrop?.acceptedAt?{acceptedAt:existing.raindrop.acceptedAt}:{})}};
    const key=`account:${id}`,ciphers=vault.encryptSecrets({[key]:input.token});if(typeof ciphers[key]!=='string'||!ciphers[key])throw new RaindropManagementError('encryption_failed','Raindrop Test token 未能加密');cancelled(deps.signal);
    store.updateWithCiphers(state=>{
      validateSites(state);cancelled(deps.signal);
      const current=state.accounts.find(item=>item.id===id);
      if(existing&&(!current||current.channelId!=='raindrop'||current.raindrop?.ownerId!==existing.raindrop?.ownerId||current.raindrop?.collectionId!==existing.raindrop?.collectionId||current.raindrop?.publicUrl!==existing.raindrop?.publicUrl||current.raindrop?.tokenFingerprint!==existing.raindrop?.tokenFingerprint||current.raindrop?.tokenVersion!==existing.raindrop?.tokenVersion))throw new RaindropManagementError('identity_changed','Raindrop 发布账号在连接期间发生变化');
      if(!existing&&current)throw new RaindropManagementError('identity_changed','Raindrop 发布账号在连接期间发生变化');
      if(state.accounts.some(item=>item.id!==id&&item.channelId==='raindrop'&&item.raindrop?.ownerId===remote.ownerId&&item.raindrop.collectionId===remote.id))throw new RaindropManagementError('identity_changed','Raindrop 发布账号在连接期间发生变化');
      const currentHasHistory=!!current&&state.tasks.some(task=>task.accountId===current.id&&task.channelId==='raindrop'&&!!(task.raindrop||task.submittedAt||task.publicUrl||task.firstLiveAt));
      if(currentHasHistory&&current!.raindrop!.publicUrl!==publicUrl)throw new RaindropManagementError('history_bound','该 Raindrop 连接已绑定历史返回记录，不能更换公开页');
      if(current&&!sameToken&&state.tasks.some(task=>task.accountId===current.id&&task.channelId==='raindrop'&&!task.firstLiveAt&&!!(task.raindrop||task.submittedAt||task.publicUrl)))throw new RaindropManagementError('reconciliation_pending','原 Raindrop 提交仍待核对，暂不更换 Test token；先用原发布账号完成检查');
      state.accounts=state.accounts.filter(item=>item.id!==id);state.accounts.push(account);
      const channel=CHANNELS.find(item=>item.id==='raindrop');if(!channel)throw new RaindropManagementError('channel_unavailable','Raindrop 平台尚未就绪');
      if(requested)for(const binding of [...state.accountBindings])if(binding.accountId===id&&binding.channelId==='raindrop'&&!selected.has(binding.siteId))unbindAccount(state,id,binding.siteId,'raindrop');
      for(const siteId of selected)bindAccount(state,id,siteId,channel);
    },ciphers);
    return account;
  }catch(error){
    if((error instanceof RaindropManagementError&&EXPOSED_RAINDROP_ERRORS.has(error.code))||error instanceof AccountBindingError||(error instanceof RaindropError&&error.code==='display_hidden'))throw error;
    throw new RaindropManagementError('connection_failed','Raindrop 连接未完成；请检查本人 Test token、公开专用根合集和实际分享地址，原连接与任务已保留',{cause:error});
  }
}
