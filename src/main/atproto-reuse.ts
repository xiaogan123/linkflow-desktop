import {BATCH5_MESSAGES} from '../shared/batch5-messages';
import type {Store} from './store';
import type {Vault} from './vault';
import type {Account} from '../shared/types';
import {atprotoIdentityConflict,leafletAccountDid} from './account-bindings';
import {batch5LocalAccountId} from './batch5-publication';

/** A local connection projection: no signup, login, or other external request. */
export async function reuseBlueskyForLeaflet(store:Pick<Store,'read'|'getCipher'|'updateWithCiphers'>,vault:Pick<Vault,'get'|'encryptSecrets'>,siteId:string):Promise<Account|undefined>{
  const before=store.read(),existing=before.accountBindings.find(value=>value.siteId===siteId&&value.channelId==='leaflet');
  if(existing)return before.accounts.find(value=>value.id===existing.accountId);
  const binding=before.accountBindings.find(value=>value.siteId===siteId&&value.channelId==='bluesky');
  const account=before.accounts.find(value=>value.id===binding?.accountId&&value.channelId==='bluesky'&&!value.retiredAt);
  if(!account||account.status!=='registered'||!account.hasPassword||account.credentialKind!=='api_token'||before.accountBindings.some(value=>value.accountId===account.id&&value.siteId!==siteId)||before.tasks.some(task=>task.accountId===account.id&&task.siteId!==siteId&&(!!task.submittedAt||!!task.publicUrl||!!task.firstLiveAt)))return;
  const sourceKey=`account:${account.id}`,sourceCipher=store.getCipher(sourceKey),raw=await vault.get(sourceKey);if(!raw)return;
  let credential:Record<string,unknown>;try{credential=JSON.parse(raw);}catch{return;}
  if(credential.version!==1||credential.did!==account.username||typeof credential.handle!=='string'||typeof credential.appPassword!=='string'||typeof credential.accessJwt!=='string'||typeof credential.refreshJwt!=='string')return;
  if(atprotoIdentityConflict(before,account.username,siteId))return;
  const previous=before.accounts.find(value=>leafletAccountDid(value)===account.username);
  if(previous?.retiredAt)return;
  const id=previous?.id??batch5LocalAccountId('leaflet',siteId),now=new Date().toISOString(),key=`account:${id}`;
  const projected:Account={id,channelId:'leaflet',username:credential.handle,publicationUrl:`https://leaflet.pub/p/${credential.did}`,email:'',credentialKind:'api_token',hasPassword:true,status:'registered',source:'imported',createdAt:now,verifiedAt:account.verifiedAt};
  const ciphers=vault.encryptSecrets({[key]:raw});
  store.updateWithCiphers(state=>{
    if(atprotoIdentityConflict(state,account.username,siteId)||state.accounts.find(value=>value.id===account.id)?.retiredAt||state.accountBindings.some(value=>value.accountId===account.id&&value.siteId!==siteId)||state.tasks.some(task=>task.accountId===account.id&&task.siteId!==siteId&&(!!task.submittedAt||!!task.publicUrl||!!task.firstLiveAt))||state.accountBindings.some(value=>value.siteId===siteId&&value.channelId==='leaflet')||!state.accountBindings.some(value=>value.siteId===siteId&&value.channelId==='bluesky'&&value.accountId===account.id)||state.accounts.some(value=>leafletAccountDid(value)===account.username&&value.id!==id))throw Error(BATCH5_MESSAGES.authorizationChanged);
    if(previous){const old=state.accounts.find(value=>value.id===id);if(!old||old.retiredAt)throw Error(BATCH5_MESSAGES.authorizationChanged);Object.assign(old,projected);}else state.accounts.push(projected);state.accountBindings.push({id,siteId,channelId:'leaflet',accountId:id,createdAt:now,updatedAt:now});
  },ciphers,[],{[sourceKey]:sourceCipher,[key]:store.getCipher(key)});
  return projected;
}
