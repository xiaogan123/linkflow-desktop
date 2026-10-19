import {hasLegacyPublicIdentityMarker} from '../shared/public-identity-policy';
import {hasRemotePublicationIntent} from '../shared/publication';
import type {Account,Site,SiteAccountBinding,Task} from '../shared/types';

type IdentityState={accounts:Account[];accountBindings:SiteAccountBinding[];tasks:Task[];sites:Site[]};

/** Retirement preserves the original identity and credentials for read-only recovery. */
export function retireAccount(state:IdentityState,accountId:string,now=new Date()):void{
  const account=state.accounts.find(item=>item.id===accountId);
  if(account&&!account.retiredAt)account.retiredAt=now.toISOString();
}

const SETTLED_STAGES=new Set(['ready','unmanaged']);

/**
 * Registration of this identity is complete. An identity whose registration result is still open must
 * never be retired: retiring it would let the planner register a second identity on the same platform.
 */
export function identityRegistrationSettled(state:IdentityState,account:Account):boolean{
  if(account.status!=='registered')return false;
  for(const value of Object.values(account)){
    if(value&&typeof value==='object'&&!Array.isArray(value)&&'stage' in value){
      const stage=(value as {stage?:unknown}).stage;
      if(typeof stage==='string'&&!SETTLED_STAGES.has(stage))return false;
    }
  }
  // Tasks still waiting on this identity's registration keep it in place.
  return !state.tasks.some(task=>task.accountId===account.id&&!task.firstLiveAt&&/(?:register|registration|account_create|signup|intent)/i.test(task.checkpoint??''));
}

/** Upgrade tool-branded generated identities without deleting their historical ownership. */
export function retireLegacyAccounts(state:IdentityState,now=new Date()):void{
  for(const account of state.accounts){
    if(account.channelId!=='rentry'&&hasLegacyPublicIdentityMarker(account)&&identityRegistrationSettled(state,account))retireAccount(state,account.id,now);
  }
}

/** The frozen owner, unless that site has since been deleted; then ownership is derived again. */
export function liveOwnerSiteId(state:Pick<IdentityState,'sites'>,account:Pick<Account,'ownerSiteId'>|undefined):string|undefined{
  return account?.ownerSiteId&&state.sites.some(site=>site.id===account.ownerSiteId)?account.ownerSiteId:undefined;
}

export function firstIdentitySite(state:IdentityState,accountId:string,channelId:string):string|undefined{
  const account=state.accounts.find(item=>item.id===accountId&&item.channelId===channelId);
  const owner=liveOwnerSiteId(state,account);if(owner)return owner;
  const sites=new Map(state.sites.map(site=>[site.id,site.createdAt]));
  const order=(a:{siteId:string;at:string},b:{siteId:string;at:string})=>
    a.at.localeCompare(b.at)||(sites.get(a.siteId)??'').localeCompare(sites.get(b.siteId)??'')||a.siteId.localeCompare(b.siteId);
  // The task that initiated registration is stronger evidence than a pre-existing binding.
  const taskUses=state.tasks.filter(item=>item.accountId===accountId&&item.channelId===channelId&&sites.has(item.siteId)).map(item=>({siteId:item.siteId,at:item.createdAt}));
  if(taskUses.length)return taskUses.sort(order)[0].siteId;
  const bindings=state.accountBindings.filter(item=>item.accountId===accountId&&item.channelId===channelId&&sites.has(item.siteId)).map(item=>({siteId:item.siteId,at:item.createdAt}));
  return bindings.sort(order)[0]?.siteId;
}

/** Freeze historical ownership once, so later binding and task edits cannot change it. */
export function migrateIdentityOwners(state:IdentityState):void{
  for(const account of state.accounts){
    // Carcinus already has an immutable site ownership proof; changing its account shape
    // during restore would invalidate that proof's exact transition guard.
    if(account.ownerSiteId||account.source!=='generated'||['rentry','carcinus'].includes(account.channelId))continue;
    const owner=firstIdentitySite(state,account.id,account.channelId);
    if(owner)account.ownerSiteId=owner;
  }
}

/** A transfer is an explicit local decision tied to the current owner and a real target site. */
export function transferIdentityOwner(state:IdentityState,accountId:string,toSiteId:string,confirmation:{confirmed:true;fromSiteId:string;toSiteId:string}):void{
  const account=state.accounts.find(item=>item.id===accountId);
  if(!account||account.retiredAt||account.source!=='generated'||['rentry','carcinus','telegraph','nostr'].includes(account.channelId))throw Error(ACCOUNT_IDENTITY_MESSAGES.ownerUnavailable);
  // Once the identity has published or attempted to publish, its public history ties it to that site.
  // A registered (or registering) identity already has a public profile written for the original site.
  if(account.status==='registered'||state.tasks.some(task=>task.accountId===account.id&&/(?:register|registration|account_create|signup)/i.test(task.checkpoint??'')))throw Error(ACCOUNT_IDENTITY_MESSAGES.ownerRegistered);
  if(state.tasks.some(task=>task.accountId===account.id&&(task.submittedAt||task.publicUrl||task.firstLiveAt||task.checkpoint?.includes('submitting')||hasRemotePublicationIntent(task))))throw Error(ACCOUNT_IDENTITY_MESSAGES.ownerPublished);
  const fromSiteId=firstIdentitySite(state,account.id,account.channelId);
  if(!fromSiteId||!confirmation||confirmation.confirmed!==true||confirmation.fromSiteId!==fromSiteId||confirmation.toSiteId!==toSiteId)throw Error(ACCOUNT_IDENTITY_MESSAGES.ownerConfirmation);
  if(!state.sites.some(site=>site.id===toSiteId))throw Error(ACCOUNT_IDENTITY_MESSAGES.ownerTargetMissing);
  account.ownerSiteId=toSiteId;
}

/** An older backup may restore content, but cannot revive an identity retired locally. */
export function preserveRetiredAccountsOnRestore(previous:IdentityState,next:IdentityState):void{
  const retired=new Map(previous.accounts.filter(account=>account.retiredAt).map(account=>[account.id,account]));
  for(const account of next.accounts){
    const before=retired.get(account.id);if(!before)continue;
    // Undoing a site deletion with a backup brings that site's own identities back with it.
    if(before.retiredReason==='site_deleted'&&next.sites.some(site=>site.id===before.retiredSiteId))continue;
    account.retiredAt=before.retiredAt;
    if(before.retiredReason){account.retiredReason=before.retiredReason;account.retiredSiteId=before.retiredSiteId}
  }
}

/** Generated identities that speak only for this site (its name, disclosure, homepage); shared ones stay. */
export function siteOwnedIdentityIds(state:IdentityState,siteId:string,keep:readonly string[]=[]):string[]{
  return state.accounts.filter(account=>account.source==='generated'&&!account.retiredAt&&!keep.includes(account.id)&&!['rentry','carcinus'].includes(account.channelId)
    &&(account.ownerSiteId??firstIdentitySite(state,account.id,account.channelId))===siteId
    &&!state.accountBindings.some(binding=>binding.accountId===account.id&&binding.siteId!==siteId)
    &&!state.tasks.some(task=>task.accountId===account.id&&task.siteId!==siteId)).map(account=>account.id);
}

export function assertRetiredAccounts(previous:IdentityState,next:IdentityState,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  for(const before of previous.accounts){
    if(!before.retiredAt)continue;
    const after=next.accounts.find(account=>account.id===before.id);
    // Local inbox labels can still be edited. Public identity, credentials and retirement cannot.
    const identity=(account:Account)=>{const {mailboxId,updatedAt,lastUsedAt,diagnostic,mataroaExcludedSiteIds,verboseExcludedSiteIds,rentryExcludedSiteIds,...saved}=account;return saved};
    const identityKeys=new Set([...Object.keys(previousCiphers),...Object.keys(nextCiphers)].filter(key=>key===`account:${before.id}`||key.startsWith(`notebin:identity:${before.id}:`)));
    const credentialsChanged=[...identityKeys].some(key=>previousCiphers[key]!==nextCiphers[key]);
    const newSubmission=next.tasks.some(task=>task.accountId===before.id&&task.submittedAt&&!previous.tasks.some(prior=>prior.id===task.id&&prior.accountId===before.id&&!!prior.submittedAt));
    if(!after||JSON.stringify(identity(before))!==JSON.stringify(identity(after))||credentialsChanged||newSubmission)throw Error(ACCOUNT_IDENTITY_MESSAGES.retired);
  }
}

export const ACCOUNT_IDENTITY_MESSAGES={
  readOnly:'当前操作仅检查历史记录，不能提交。',
  retired:'旧发布账号已退役，保留密钥用于检查。',
  pending:(task:Task)=>`历史任务 ${task.id} 的发布结果待检查，处理完成后再更换发布账号。`,
  registrationPending:'这个账号的注册结果还没确认，暂时不能删除，确认后再处理。',
  ownerUnavailable:'这个发布账号不能转移归属。',
  ownerPublished:'这个账号已经为原网站发过内容，不能改归其他网站；请为新网站另建账号。',
  ownerRegistered:'这个账号已在平台上建好（或正在建）公开资料，资料写的是原网站，不能改归其他网站；请为新网站另建账号。',
  ownerConfirmation:'请确认原网站和目标网站后再转移归属。',
  ownerTargetMissing:'目标站点不存在，不能转移发布账号归属。',
} as const;
