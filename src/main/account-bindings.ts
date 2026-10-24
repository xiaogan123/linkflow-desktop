import {BATCH5_MESSAGES} from '../shared/batch5-messages';
import {randomUUID} from 'node:crypto';
import {signupScriptFor} from '../integrations/signup-executor';
import {validNotebinAccount} from '../shared/notebin-account';
import {hasLegacyPublicIdentityMarker} from '../shared/public-identity-policy';
import {bloggerBlogIdConflict} from '../shared/blogger-ownership';
import {ACCOUNT_IDENTITY_MESSAGES,firstIdentitySite,liveOwnerSiteId} from './account-retirement';
export {validNotebinAccount} from '../shared/notebin-account';
import type {Account,Channel,SiteAccountBinding,Task} from '../shared/types';
import type {State} from './store';
import {validMarkestReadAccount} from '../integrations/markest-connection';
import {validDenoReadAccount} from '../integrations/deno-connection';
import {validProseAccount} from '../integrations/prose';
import {validDeedPageAccount} from './deed-page-publication';
import {validBrewPageAccount} from './brewpage-publication';
import {validHereNowAccount} from './here-now-management';
import {validShiplyAccount} from './shiply-management';
import {validVibeDropAccount} from './vibedrop-publication';
import {validWordcellAccount} from '../integrations/wordcell-publisher';
import {validShipPageAccount} from './shippage-publication';
import {validOpenAgentChatAccount} from '../integrations/openagentchat-publisher';
import {validShellbookAccount} from '../integrations/shellbook-publisher';
import {validAgentRiotAccount} from '../integrations/agentriot-publisher';
import {validAgentNotepadAccount} from '../integrations/agentnotepad-publisher';
import {validColonyAccount} from '../integrations/colony-publisher';
import {validAgentHowAccount} from '../integrations/agenthow-publisher';
import {validBerrryAccount} from '../integrations/berrry-publisher';
import {validLargeLanguageAccount} from '../integrations/large-language-publisher';
import {validProductIndexAccount} from './product-index-publication';
import {validSwarmMemoAccount} from '../integrations/swarmmemo-publisher';
import {validCarcinusAccount} from './carcinus-publication';
import {validSynthfolkAccount} from '../integrations/synthfolk-publisher';
import {validAgentsWikiAccount} from '../integrations/agentswiki-publisher';
import {validAgentboardAccount} from '../integrations/agentboard-publisher';
import {validBeaconAccount} from './beacon-publication';
import {validValTownAccount} from './valtown-publication';
import {validBitbucketAccount} from './bitbucket-publication';

export class AccountBindingError extends Error{
  constructor(readonly code:'pending_publication',message:string){super(message);this.name='AccountBindingError'}
}

export type ChannelExecutionReadiness='ready'|'autocreate'|'handoff_required'|'manual';

function lower(value:string){return value.trim().toLowerCase()}
function reservesSingleProfile(task:Task):boolean{
  return !!task.publicUrl||!!task.submittedAt||[
    'submitting','submitted','submission_uncertain','account_registration_submitted','account_registration_human','email_code_pending',
    'telegraph_publish_submitting','telegraph_publish_uncertain','telegraph_published','gist_published',
  ].includes(task.checkpoint??'');
}
function profileAccountConflict(state:State,accountId:string,siteId:string,channelId:string):boolean{
  const historical=state.tasks.some(task=>task.accountId===accountId&&task.channelId===channelId&&task.siteId!==siteId&&reservesSingleProfile(task));
  return historical||state.accountBindings.some(binding=>binding.accountId===accountId&&binding.channelId===channelId&&binding.siteId!==siteId&&state.tasks.some(task=>task.siteId===binding.siteId&&task.channelId===channelId&&reservesSingleProfile(task)));
}

/** Existing bindings and pinned tasks remain the ownership record for locally created identities. */
function identitySites(state:State,accountId:string,channelId:string):Set<string>{
  return new Set([
    ...state.accountBindings.filter(item=>item.accountId===accountId&&item.channelId===channelId).map(item=>item.siteId),
    ...state.tasks.filter(item=>item.accountId===accountId&&item.channelId===channelId).map(item=>item.siteId),
  ]);
}
function siteIdentityConflict(state:State,account:Account,siteId:string):boolean{
  if(account.channelId==='rentry')return false;
  if(account.source!=='generated'&&!['telegraph','nostr'].includes(account.channelId))return false;
  const owner=liveOwnerSiteId(state,account);
  if(owner&&!['telegraph','nostr'].includes(account.channelId))return owner!==siteId;
  const sites=identitySites(state,account.id,account.channelId);
  if(sites.size>1&&!['telegraph','nostr'].includes(account.channelId))return firstIdentitySite(state,account.id,account.channelId)!==siteId;
  return sites.size>1||sites.size===1&&!sites.has(siteId);
}
function otherSiteGeneratedIdentity(state:State,siteId:string,channelId:string):boolean{
  return state.accounts.some(account=>!account.retiredAt&&account.channelId===channelId&&account.source==='generated'&&siteIdentityConflict(state,account,siteId));
}

function brandedGeneratedIdentityForNewWork(state:State,siteId:string,channelId:string,selected?:Account):Account|undefined{
  if(selected)return !selected.retiredAt&&hasLegacyPublicIdentityMarker(selected)?selected:undefined;
  return state.accounts.find(account=>{
    if(account.retiredAt||account.channelId!==channelId||!hasLegacyPublicIdentityMarker(account))return false;
    const sites=identitySites(state,account.id,channelId);
    return sites.size===0||sites.has(siteId);
  });
}

function legacySharedGeneratedIdentity(state:State,siteId:string,channelId:string,accountId:string):boolean{
  if(!['telegraph','nostr'].includes(channelId))return false;
  const account=state.accounts.find(item=>item.id===accountId&&item.channelId===channelId);
  const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channelId);
  return !!account&&identitySites(state,accountId,channelId).size>1
    &&(binding?.accountId===accountId||!binding&&state.tasks.some(task=>task.siteId===siteId&&task.channelId===channelId&&task.accountId===accountId));
}

export function hasPendingIdentityBudget(task:Task,now=new Date()):boolean{
  return !['skipped','expired'].includes(task.status)&&!task.deferredAt&&(task.reconcileAttempts??0)<3
    &&(!task.reviewUntil||Date.parse(task.reviewUntil)>now.getTime());
}

export function unresolvedIdentityPublication(state:State,siteId:string,channelId:string,replacementAccountId?:string,now=new Date()):Task|undefined{
  return state.tasks.find(task=>task.siteId===siteId&&task.channelId===channelId&&task.accountId!==replacementAccountId
    &&hasPendingIdentityBudget(task,now)
    &&!task.firstLiveAt&&!task.publicUrl&&(!!task.submittedAt||channelId==='nostr'&&!!task.nostr
      ||channelId==='telegraph'&&['telegraph_account_create_pending','account_registration_submitted','telegraph_publish_submitting','telegraph_publish_uncertain'].includes(task.checkpoint??'')));
}

function unresolvedRetiredPublication(state:State,siteId:string,channelId:string,replacementAccountId?:string,now=new Date()):Task|undefined{
  const retiredIds=new Set(state.accounts.filter(account=>!!account.retiredAt).map(account=>account.id));
  const receiptFields=['paper','hive','mataroa','verbose','rentry','prose','wordpress','leaflet','raindrop','beacon','valtown','bitbucket','hereNow','shiply','vibedrop','wordcell','notebin','notebinJournal','nostr','paragraph','colony','agentHow','agentsWiki','synthfolk','agentboard'] as const;
  return state.tasks.find(task=>task.siteId===siteId&&task.channelId===channelId&&task.accountId!==replacementAccountId
    &&retiredIds.has(task.accountId??'')&&!task.firstLiveAt&&hasPendingIdentityBudget(task,now)
    &&(reservesSingleProfile(task)||receiptFields.some(field=>!!task[field])||/account_create_pending$/.test(task.checkpoint??'')));
}

/** Identifies an old shared binding; callers must separately reject any remote intent before moving a task. */
export function isLegacySharedGeneratedTaskAccount(state:State,task:Task):boolean{
  return !!task.accountId&&legacySharedGeneratedIdentity(state,task.siteId,task.channelId,task.accountId);
}

function candidateAccounts(state:State,siteId:string,channelId:string):Account[]{
  const site=state.sites.find(item=>item.id===siteId);if(!site||['telegraph','nostr','hive'].includes(channelId))return [];
  const available=(account:Account)=>!account.retiredAt&&account.channelId===channelId&&!siteIdentityConflict(state,account,siteId);
  if(['wordpress-com','leaflet','raindrop','wordcell','notebin','product-index','swarmmemo','agentboard','agentswiki','synthfolk','carcinus'].includes(channelId))return state.accounts.filter(available);
  if(channelId==='here-now')return state.accounts.filter(available);
  if(channelId==='shiply')return state.accounts.filter(available);
  if(channelId==='beacon')return state.accounts.filter(available);
  if(channelId==='valtown')return state.accounts.filter(available);
  if(channelId==='bitbucket')return state.accounts.filter(available);
  if(['paper-wf','mataroa','verbose','prose','rentry','deed-page','brewpage','shippage'].includes(channelId))return state.accounts.filter(account=>available(account)&&!(channelId==='mataroa'&&account.mataroaExcludedSiteIds?.includes(siteId))&&!(channelId==='verbose'&&account.verboseExcludedSiteIds?.includes(siteId))&&!(channelId==='rentry'&&account.rentryExcludedSiteIds?.includes(siteId)));
  return state.accounts.filter(account=>available(account)&&(channelId==='github-gist'||lower(account.email)===lower(site.publicEmail||site.email)));
}

/** Resolve the same account for readiness, planning, and execution. */
export function accountForSiteChannel(state:State,siteId:string,channelId:string,accountId?:string):Account|undefined{
  if(channelId==='whitewind'){const binding=state.accountBindings.find(item=>item.siteId===siteId&&['whitewind','bluesky'].includes(item.channelId)&&(!accountId||item.accountId===accountId));return state.accounts.find(account=>account.id===(accountId??binding?.accountId)&&account.channelId==='bluesky'&&!account.retiredAt);}
  if(accountId)return state.accounts.find(account=>account.id===accountId&&account.channelId===channelId);
  const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channelId);
  if(binding&&!legacySharedGeneratedIdentity(state,siteId,channelId,binding.accountId)){const account=state.accounts.find(account=>account.id===binding.accountId&&!account.retiredAt);if(account)return channelId==='mataroa'&&account.mataroaExcludedSiteIds?.includes(siteId)||channelId==='verbose'&&account.verboseExcludedSiteIds?.includes(siteId)||channelId==='rentry'&&account.rentryExcludedSiteIds?.includes(siteId)?undefined:account;}
  if(['wordpress-com','leaflet','raindrop'].includes(channelId))return;
  const candidates=candidateAccounts(state,siteId,channelId);
  if(channelId==='notebin')return candidates.length===1?candidates[0]:undefined;
  if(channelId==='wordcell')return candidates.length===1?candidates[0]:undefined;
  if(channelId==='product-index')return candidates.length===1?candidates[0]:undefined;
  if(channelId==='here-now')return candidates.length===1?candidates[0]:undefined;
  if(channelId==='shiply')return candidates.length===1?candidates[0]:undefined;
  if(channelId==='beacon')return candidates.length===1?candidates[0]:undefined;
  if(channelId==='valtown')return candidates.length===1?candidates[0]:undefined;
  if(channelId==='bitbucket')return candidates.length===1?candidates[0]:undefined;
  if(channelId==='swarmmemo')return candidates.length===1?candidates[0]:undefined;
  if(channelId==='carcinus')return candidates.length===1?candidates[0]:undefined;
  if(channelId==='synthfolk')return candidates.length===1?candidates[0]:undefined;
  if(channelId==='agentswiki')return candidates.length===1?candidates[0]:undefined;
  if(channelId==='agentboard')return candidates.length===1?candidates[0]:undefined;
  if(['paper-wf','mataroa','verbose','prose','rentry','deed-page','brewpage'].includes(channelId))return candidates.length===1?candidates[0]:undefined;
  const usableCandidates=['telegraph','github-gist','nostr'].includes(channelId)?candidates.filter(account=>account.credentialKind==='api_token'):candidates;
  return usableCandidates.find(account=>account.status==='registered'&&account.hasPassword)
    ??usableCandidates.find(account=>account.status==='unknown'&&account.hasPassword)
    ??usableCandidates[0];
}

export function boundAccount(state:State,task:Task):Account|undefined{
  return accountForSiteChannel(state,task.siteId,task.channelId,task.accountId);
}

function validPublisherIdentity(account:Account,channelId:'paper-wf'|'hive'|'mataroa'|'verbose'|'rentry'):boolean{
  if(account.channelId!==channelId||account.credentialKind!=='api_token'||account.status!=='registered'||!account.hasPassword)return false;
  if(channelId==='rentry')return account.source==='generated'&&account.email===''&&account.username==='anonymous'&&!account.publicationUrl;
  if(!account.publicationUrl)return false;
  try{
    const url=new URL(account.publicationUrl),username=account.username;
    if(channelId==='paper-wf'?!/^[a-z0-9][a-z0-9-]{2,63}$/.test(username):channelId==='mataroa'?!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(username):channelId==='verbose'?!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(username)||username.length<3||username.length>32:!/^[a-z][a-z0-9.-]{2,15}$/.test(username)||/[.-]$|[.-]{2}/.test(username))return false;
    if(url.protocol!=='https:'||url.port||url.username||url.password||url.search||url.hash)return false;
    return channelId==='paper-wf'?url.hostname==='paper.wf'&&url.pathname.replace(/\/$/,'')===`/${username}`:channelId==='mataroa'?url.hostname===`${username}.mataroa.blog`&&url.pathname.replace(/\/$/,'')==='':channelId==='verbose'?url.hostname==='verbose.blog'&&url.pathname===`/${username}`:url.hostname==='hive.blog'&&url.pathname.replace(/\/$/,'')===`/@${username}`;
  }catch{return false}
}

export function validWordPressAccount(account:Account):boolean{
  if(account.channelId!=='wordpress-com'||account.credentialKind!=='oauth'||account.status!=='registered'||!account.hasPassword||!/^[1-9][0-9]{0,19}$/.test(account.username)||!account.publicationUrl)return false;
  try{
    const url=new URL(account.publicationUrl),host=url.hostname.toLowerCase();
    return url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/'&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.wordpress\.com$/.test(host);
  }catch{return false}
}

function validLeafletHandle(value:string):boolean{
  if(value.length<3||value.length>253||value!==value.toLowerCase())return false;
  const labels=value.split('.');
  return labels.length>=2&&labels.every((label,index)=>label.length>=1&&label.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)&&(index!==labels.length-1||/[a-z]/.test(label)));
}

/** ATProto ownership follows the DID across local connection projections. */
export function atprotoAccountDid(account:Account):string|undefined {
  return account.channelId==='bluesky'&&/^did:(?:plc|web):/.test(account.username)?account.username:leafletAccountDid(account);
}
export function atprotoIdentityConflict(state:State,did:string,siteId:string):boolean {
  const ids=new Set(state.accounts.filter(account=>atprotoAccountDid(account)===did).map(account=>account.id));
  return state.accountBindings.some(binding=>ids.has(binding.accountId)&&binding.siteId!==siteId)||
    state.tasks.some(task=>!!task.accountId&&ids.has(task.accountId)&&task.siteId!==siteId&&(!!task.submittedAt||!!task.publicUrl||!!task.firstLiveAt));
}

export function leafletAccountDid(account:Account):string|undefined{
  if(!account.publicationUrl)return;
  const match=/^https:\/\/leaflet\.pub\/p\/(did:(?:plc|web):[A-Za-z0-9:._%-]{1,240})$/.exec(account.publicationUrl);
  return match?.[1];
}

export function validLeafletAccount(account:Account):boolean{
  return account.channelId==='leaflet'&&account.credentialKind==='api_token'&&account.status==='registered'&&account.hasPassword&&account.source==='imported'&&account.email===''&&validLeafletHandle(account.username)&&!!leafletAccountDid(account);
}

export function validRaindropAccount(account:Account):boolean{
  const binding=account.raindrop;
  if(account.channelId!=='raindrop'||account.credentialKind!=='api_token'||account.status!=='registered'||!account.hasPassword||account.source!=='imported'||account.email!==''||!binding||account.username!==binding.ownerId||account.publicationUrl!==binding.publicUrl)return false;
  try{const url=new URL(binding.publicUrl),safeId=(value:string)=>/^[1-9][0-9]*$/.test(value)&&Number.isSafeInteger(Number(value))&&String(Number(value))===value;return binding.version===1&&safeId(binding.ownerId)&&safeId(binding.collectionId)&&/^[a-f0-9]{64}$/.test(binding.tokenFingerprint)&&Number.isSafeInteger(binding.tokenVersion)&&binding.tokenVersion>0&&Number.isFinite(Date.parse(binding.connectedAt))&&url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname!=='/'&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.raindrop\.page$/.test(url.hostname)}catch{return false}
}


/** Classify whether an automatic channel can run before spending generation or review calls. */
/** Never open accounts in bulk: new generated identities are spread over days. */
export const ACCOUNT_CREATION_LIMITS={perChannelPerDay:2,totalPerDay:6} as const;
export function accountCreationBudgetExceeded(state:State,channelId:string,now=new Date()):boolean{
  const since=now.getTime()-86_400_000;
  const recent=state.accounts.filter(account=>account.source==='generated'&&Date.parse(account.createdAt)>=since);
  return recent.filter(account=>account.channelId===channelId).length>=ACCOUNT_CREATION_LIMITS.perChannelPerDay
    ||recent.length>=ACCOUNT_CREATION_LIMITS.totalPerDay;
}

export function channelExecutionReadiness(state:State,siteId:string,channel:Channel,accountId?:string):{kind:ChannelExecutionReadiness;account?:Account;blockingTask?:Task}{
  if(['slopit','rant'].includes(channel.id)){
    const unresolved=state.tasks.find(task=>task.siteId===siteId&&task.channelId===channel.id&&task.batch5Registration&&(
      ['rejected','request_unknown','sending'].includes(task.batch5Registration.stage)||
      task.batch5Registration.stage==='reserved'&&task.batch5Registration.sendGuardVersion!==1));
    if(unresolved)return {kind:'handoff_required',blockingTask:unresolved};
    const binding=state.accountBindings.find(value=>value.siteId===siteId&&value.channelId===channel.id),account=state.accounts.find(value=>value.id===(accountId??binding?.accountId)&&value.channelId===channel.id&&!value.retiredAt);
    if(accountId&&account?.id!==accountId||binding&&binding.accountId!==account?.id)return {kind:'handoff_required'};
    if(account?.status==='registered'&&account.hasPassword)return {kind:'ready',account};
    if(account?.source==='generated'&&account.registrationAttempts===1)return {kind:'autocreate',account};
    return account?{kind:'handoff_required',account}:{kind:'autocreate'};
  }
  if(channel.id==='whitewind'){
    const account=accountForSiteChannel(state,siteId,channel.id,accountId);
    const owner=account&&atprotoIdentityConflict(state,account.username,siteId);
    return {kind:account&&!owner&&account.status==='registered'&&account.hasPassword&&account.credentialKind==='api_token'?'ready':'handoff_required',account};
  }
  if(channel.id==='hackmd'){
    const binding=state.accountBindings.find(value=>value.siteId===siteId&&value.channelId==='hackmd'),account=state.accounts.find(value=>value.id===(accountId??binding?.accountId)&&value.channelId==='hackmd'&&!value.retiredAt);
    const conflict=account&&(state.accountBindings.some(value=>value.accountId===account.id&&value.siteId!==siteId)||state.tasks.some(task=>task.accountId===account.id&&task.siteId!==siteId&&(!!task.submittedAt||!!task.publicUrl||!!task.firstLiveAt)));
    return {kind:binding&&account&&!conflict&&account.status==='registered'&&account.hasPassword&&account.credentialKind==='api_token'?'ready':'handoff_required',account};
  }

  const retiredPending=unresolvedRetiredPublication(state,siteId,channel.id,accountId);
  if(retiredPending)return {kind:'handoff_required',blockingTask:retiredPending};
  // Explicit historical account resolution remains available via boundAccount; new work
  // must ignore retired bindings and counts everywhere below.
  state={...state,accountBindings:state.accountBindings.filter(binding=>!state.accounts.find(account=>account.id===binding.accountId)?.retiredAt),accounts:state.accounts.filter(account=>!account.retiredAt)};
  if(channel.accountRequired&&channel.automation!=='manual'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channel.id);
    const selectedId=accountId??(binding&&!legacySharedGeneratedIdentity(state,siteId,channel.id,binding.accountId)?binding.accountId:undefined);
    const blockingTask=['telegraph','nostr'].includes(channel.id)?unresolvedIdentityPublication(state,siteId,channel.id,selectedId):undefined;
    if(blockingTask&&(!accountId||blockingTask.accountId!==accountId))return {kind:'handoff_required',blockingTask};
    const selected=state.accounts.find(item=>item.id===(accountId??(!binding||legacySharedGeneratedIdentity(state,siteId,channel.id,binding.accountId)?undefined:binding.accountId))&&item.channelId===channel.id);
    if(selected&&siteIdentityConflict(state,selected,siteId))return {kind:'handoff_required',account:selected};
    const branded=brandedGeneratedIdentityForNewWork(state,siteId,channel.id,selected);
    if(branded)return {kind:'handoff_required',account:branded};
    // Telegraph and Nostr can safely mint one local identity per site. Registration-based
    // publishers with a prior locally created identity must not open another automatically.
    if(!selected&&!['telegraph','nostr'].includes(channel.id)&&otherSiteGeneratedIdentity(state,siteId,channel.id))return {kind:'handoff_required'};
  }
  if(channel.id==='carcinus'){
    const bindings=state.accountBindings.filter(item=>item.channelId==='carcinus'),binding=bindings.find(item=>item.siteId===siteId),accounts=state.accounts.filter(item=>item.channelId==='carcinus'),account=accountId?accounts.find(item=>item.id===accountId):accounts[0],tasks=state.tasks.filter(item=>item.channelId==='carcinus'&&(!!item.carcinus||!!item.submittedAt||!!item.publicUrl)),sameSite=tasks.every(item=>item.siteId===siteId);
    if(accounts.length>1||bindings.length>1||accountId&&!account||binding&&binding.accountId!==account?.id||!sameSite)return {kind:'handoff_required',account};
    if(account&&validCarcinusAccount(account))return {kind:binding?.accountId===account.id&&tasks.some(item=>item.siteId===siteId&&item.accountId===account.id)?'ready':'handoff_required',account};
    if(!account&&!bindings.length&&(tasks.length===0||sameSite))return {kind:'autocreate'};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='synthfolk'){
    const site=state.sites.find(item=>item.id===siteId),binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='synthfolk'),accounts=state.accounts.filter(item=>item.channelId==='synthfolk'),account=accountId?accounts.find(item=>item.id===accountId):accounts[0],matchesSite=!!site&&!!account?.synthfolk&&(site.url===account.synthfolk.website||site.topics?.some(topic=>topic.url===account.synthfolk!.website)===true);
    if(accounts.length>1||accountId&&!account||binding&&binding.accountId!==account?.id)return {kind:'handoff_required',account};
    if(account&&validSynthfolkAccount(account)&&matchesSite)return {kind:binding?.accountId===account.id?'ready':'autocreate',account};
    if(account?.source==='generated'&&account.credentialKind==='api_token'&&['draft','unknown'].includes(account.status)&&(account.registrationAttempts??0)===1&&matchesSite)return {kind:'autocreate',account};
    if(!account&&!binding)return {kind:'autocreate'};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='agentswiki'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='agentswiki'),accounts=state.accounts.filter(item=>item.channelId==='agentswiki'),account=accountId?accounts.find(item=>item.id===accountId):accounts[0];
    if(accounts.length>1||accountId&&!account||binding&&binding.accountId!==account?.id)return {kind:'handoff_required',account};
    if(account&&validAgentsWikiAccount(account))return {kind:binding?.accountId===account.id?'ready':'autocreate',account};
    if(account?.source==='generated'&&account.credentialKind==='api_token'&&['draft','unknown'].includes(account.status)&&(account.registrationAttempts??0)===1)return {kind:'autocreate',account};
    if(!account&&!binding)return {kind:'autocreate'};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='agentboard'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='agentboard'),accounts=state.accounts.filter(item=>item.channelId==='agentboard'),account=accountId?accounts.find(item=>item.id===accountId):accounts[0];
    if(accounts.length>1||accountId&&!account||binding&&binding.accountId!==account?.id)return {kind:'handoff_required',account};
    if(account&&validAgentboardAccount(account))return {kind:binding?.accountId===account.id?'ready':'autocreate',account};
    if(account?.source==='generated'&&account.credentialKind==='api_token'&&(account.registrationAttempts??0)===1&&(account.agentboard?.stage==='intent'&&account.status==='unknown'||account.agentboard?.stage==='receipt'&&account.status==='registered'))return {kind:binding?.accountId===account.id?'autocreate':'handoff_required',account};
    if(!account&&!binding){const reserved=state.tasks.some(task=>task.channelId==='agentboard'&&task.siteId!==siteId&&!task.accountId&&!task.submittedAt&&!task.publicUrl&&!task.firstLiveAt&&['queued','running','review','needs_input'].includes(task.status));return {kind:reserved?'handoff_required':'autocreate'}}
    return {kind:'handoff_required',account};
  }
  if(channel.id==='swarmmemo'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='swarmmemo'),accounts=state.accounts.filter(item=>item.channelId==='swarmmemo'),account=accountId?accounts.find(item=>item.id===accountId):accounts[0];
    if(accounts.length>1||accountId&&!account||binding&&binding.accountId!==account?.id)return {kind:'handoff_required',account};
    if(account&&validSwarmMemoAccount(account))return {kind:binding?.accountId===account.id?'ready':'autocreate',account};
    if(!account&&!binding)return {kind:'autocreate'};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='colony'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='colony'),accounts=state.accounts.filter(item=>item.channelId==='colony'),account=accountId?accounts.find(item=>item.id===accountId):accounts[0];
    if(accounts.length>1||accountId&&!account||binding&&binding.accountId!==account?.id)return {kind:'handoff_required',account};
    if(account&&validColonyAccount(account))return {kind:binding?.accountId===account.id?'ready':'autocreate',account};
    if(account?.source==='generated'&&account.credentialKind==='api_token'&&['draft','unknown'].includes(account.status)&&(account.registrationAttempts??0)===1)return {kind:'autocreate',account};
    if(!account&&!binding)return {kind:'autocreate'};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='agentnotepad'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='agentnotepad'),accounts=state.accounts.filter(item=>item.channelId==='agentnotepad'),account=accountId?accounts.find(item=>item.id===accountId):accounts[0];
    if(accounts.length>1||accountId&&!account||binding&&binding.accountId!==account?.id)return {kind:'handoff_required',account};
    if(account&&validAgentNotepadAccount(account))return {kind:binding?.accountId===account.id?'ready':'autocreate',account};
    if(account?.source==='generated'&&account.credentialKind==='api_token'&&['draft','unknown'].includes(account.status)&&(account.registrationAttempts??0)===1)return {kind:'autocreate',account};
    if(!account&&!binding)return {kind:'autocreate'};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='product-index'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='product-index');
    const account=accountForSiteChannel(state,siteId,'product-index',accountId);
    return {kind:binding&&account&&binding.accountId===account.id&&validProductIndexAccount(account)?'ready':'handoff_required',account};
  }
  if(channel.id==='openagentchat'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='openagentchat'),accounts=state.accounts.filter(item=>item.channelId==='openagentchat'),account=accountId?accounts.find(item=>item.id===accountId):accounts[0];
    if(accounts.length>1||accountId&&!account||binding&&binding.accountId!==account?.id)return {kind:'handoff_required',account};
    if(account&&validOpenAgentChatAccount(account))return {kind:binding?.accountId===account.id?'ready':'autocreate',account};
    if(account?.source==='generated'&&account.credentialKind==='api_token'&&['draft','unknown'].includes(account.status)&&(account.registrationAttempts??0)===1)return {kind:'autocreate',account};
    if(!account&&!binding)return {kind:'autocreate'};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='shellbook'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='shellbook'),accounts=state.accounts.filter(item=>item.channelId==='shellbook'),account=accountId?accounts.find(item=>item.id===accountId):accounts[0];
    if(accounts.length>1||accountId&&!account||binding&&binding.accountId!==account?.id)return {kind:'handoff_required',account};
    if(account&&validShellbookAccount(account))return {kind:binding?.accountId===account.id?'ready':'autocreate',account};
    if(account?.source==='generated'&&account.credentialKind==='api_token'&&['draft','unknown'].includes(account.status)&&(account.registrationAttempts??0)===1)return {kind:'autocreate',account};
    if(!account&&!binding)return {kind:'autocreate'};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='agentriot'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='agentriot'),accounts=state.accounts.filter(item=>item.channelId==='agentriot'),account=accountId?accounts.find(item=>item.id===accountId):accounts[0];
    if(accounts.length>1||accountId&&!account||binding&&binding.accountId!==account?.id)return {kind:'handoff_required',account};
    if(account&&validAgentRiotAccount(account))return {kind:binding?.accountId===account.id?'ready':'autocreate',account};
    if(account?.source==='generated'&&account.credentialKind==='api_token'&&['draft','unknown'].includes(account.status)&&(account.registrationAttempts??0)===1)return {kind:'autocreate',account};
    if(!account&&!binding)return {kind:'autocreate'};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='agenthow'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='agenthow'),accounts=state.accounts.filter(item=>item.channelId==='agenthow'),account=accountId?accounts.find(item=>item.id===accountId):accounts[0];
    if(accounts.length>1||accountId&&!account||binding&&binding.accountId!==account?.id)return {kind:'handoff_required',account};
    if(account&&validAgentHowAccount(account))return {kind:binding?.accountId===account.id?'ready':'autocreate',account};
    if(account?.source==='generated'&&account.credentialKind==='api_token'&&['draft','unknown'].includes(account.status)&&(account.registrationAttempts??0)===1)return {kind:'autocreate',account};
    if(!account&&!binding)return {kind:'autocreate'};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='berrry'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='berrry'),accounts=state.accounts.filter(item=>item.channelId==='berrry'),account=accountId?accounts.find(item=>item.id===accountId):accounts[0];
    if(accounts.length>1||accountId&&!account||binding&&binding.accountId!==account?.id)return {kind:'handoff_required',account};
    if(account&&validBerrryAccount(account))return {kind:binding?.accountId===account.id?'ready':'autocreate',account};
    if(account?.source==='generated'&&account.credentialKind==='api_token'&&['draft','unknown'].includes(account.status)&&(account.registrationAttempts??0)===1)return {kind:'autocreate',account};
    if(!account&&!binding)return {kind:'autocreate'};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='large-language'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='large-language'),accounts=state.accounts.filter(item=>item.channelId==='large-language'),account=accountId?accounts.find(item=>item.id===accountId):accounts[0];
    if(accounts.length>1||accountId&&!account||binding&&binding.accountId!==account?.id)return {kind:'handoff_required',account};
    if(account&&validLargeLanguageAccount(account))return {kind:binding?.accountId===account.id?'ready':'autocreate',account};
    if(account?.source==='generated'&&account.credentialKind==='api_token'&&['draft','unknown'].includes(account.status)&&(account.registrationAttempts??0)===1)return {kind:'autocreate',account};
    if(!account&&!binding)return {kind:'autocreate'};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='deno')return {kind:'handoff_required',account:accountForSiteChannel(state,siteId,channel.id,accountId)};
  if(channel.id==='markest')return {kind:'handoff_required',account:accountForSiteChannel(state,siteId,channel.id,accountId)};
  if(channel.automation==='manual')return {kind:'manual'};
  if(channel.id==='blogger'){
    const site=state.sites.find(item=>item.id===siteId),binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='blogger');
    const account=state.accounts.find(item=>item.id===(accountId??binding?.accountId)&&item.channelId==='blogger');
    const conflictingBlog=site?.blogger&&bloggerBlogIdConflict(state,siteId,site.blogger.blogId);
    return {kind:site?.blogger&&binding&&account&&binding.accountId===account.id&&account.credentialKind==='oauth'&&account.status==='registered'&&account.hasPassword&&!conflictingBlog?'ready':'handoff_required',account};
  }
  if(channel.id==='wordpress-com'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='wordpress-com');
    const account=state.accounts.find(item=>item.id===(accountId??binding?.accountId)&&item.channelId==='wordpress-com');
    return {kind:binding&&account&&binding.accountId===account.id&&validWordPressAccount(account)?'ready':'handoff_required',account};
  }
  if(channel.id==='leaflet'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='leaflet');
    const account=state.accounts.find(item=>item.id===(accountId??binding?.accountId)&&item.channelId==='leaflet');
    if(!binding&&!accountId){const linked=state.accountBindings.find(value=>value.siteId===siteId&&value.channelId==='bluesky'),shared=state.accounts.find(value=>value.id===linked?.accountId&&value.channelId==='bluesky'&&value.status==='registered'&&value.hasPassword&&!value.retiredAt);if(shared&&!state.accountBindings.some(value=>value.accountId===shared.id&&value.siteId!==siteId))return {kind:'autocreate'};}
    return {kind:binding&&account&&binding.accountId===account.id&&validLeafletAccount(account)?'ready':'handoff_required',account};
  }
  if(channel.id==='raindrop'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='raindrop');
    const account=state.accounts.find(item=>item.id===(accountId??binding?.accountId)&&item.channelId==='raindrop');
    return {kind:binding&&account&&binding.accountId===account.id&&validRaindropAccount(account)?'ready':'handoff_required',account};
  }
  if(channel.id==='plopino'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='plopino');
    const account=accountForSiteChannel(state,siteId,'plopino',accountId);
    if(accountId&&(!account||!binding||binding.accountId!==accountId))return {kind:'handoff_required',account};
    if(account&&account.credentialKind==='api_token'&&account.status==='registered'&&account.hasPassword&&binding?.accountId===account.id)return {kind:'ready',account};
    if(account?.source==='generated'&&account.credentialKind==='api_token'&&account.hasPassword&&['draft','unknown'].includes(account.status)&&(account.registrationAttempts??0)<=1&&(!binding||binding.accountId===account.id))return {kind:'autocreate',account};
    if(!accountId&&!binding&&state.accounts.every(item=>item.channelId!=='plopino'))return {kind:'autocreate'};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='vibedrop'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='vibedrop');
    const account=accountForSiteChannel(state,siteId,'vibedrop',accountId);
    if(accountId&&(!account||binding&&binding.accountId!==accountId))return {kind:'handoff_required',account};
    if(account&&validVibeDropAccount(account)&&binding?.accountId===account.id)return {kind:'ready',account};
    if(account?.source==='generated'&&account.credentialKind==='api_token'&&account.hasPassword&&['draft','unknown'].includes(account.status)&&(account.registrationAttempts??0)<=1&&(!binding||binding.accountId===account.id))return {kind:'autocreate',account};
    if(!accountId&&!binding&&state.accounts.every(item=>item.channelId!=='vibedrop'))return {kind:'autocreate'};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='wordcell'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='wordcell');
    const account=accountForSiteChannel(state,siteId,'wordcell',accountId),accounts=state.accounts.filter(item=>item.channelId==='wordcell');
    if(accounts.length>1||accountId&&(!account||binding&&binding.accountId!==accountId))return {kind:'handoff_required',account};
    if(account&&validWordcellAccount(account))return {kind:binding?.accountId===account.id?'ready':'autocreate',account};
    if(account?.source==='generated'&&account.credentialKind==='api_token'&&account.hasPassword&&['draft','unknown'].includes(account.status)&&(account.registrationAttempts??0)<=1&&(!binding||binding.accountId===account.id))return {kind:'autocreate',account};
    if(!account&&!binding)return {kind:'autocreate'};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='notebin'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='notebin');
    const account=accountForSiteChannel(state,siteId,'notebin',accountId);
    if(accountId&&(!account||binding&&binding.accountId!==accountId))return {kind:'handoff_required',account};
    if(account&&validNotebinAccount(account)&&binding?.accountId===account.id)return {kind:'ready',account};
    if(account&&validNotebinAccount(account)&&!binding)return {kind:'autocreate',account};
    if(account?.source==='generated'&&account.credentialKind==='api_token'&&['draft','unknown'].includes(account.status)&&(account.registrationAttempts??0)<=1&&(!binding||binding.accountId===account.id))return {kind:'autocreate',account};
    if(!accountId&&!binding&&state.accounts.every(item=>item.channelId!=='notebin'))return {kind:'autocreate'};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='shippage'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='shippage'),accounts=state.accounts.filter(item=>item.channelId==='shippage'),account=accountId?accounts.find(item=>item.id===accountId):accounts[0];
    if(accounts.length>1||accountId&&!account||binding&&binding.accountId!==account?.id)return {kind:'handoff_required',account};
    if(account&&validShipPageAccount(account))return {kind:binding?.accountId===account.id?'ready':'autocreate',account};
    if(!account&&!binding)return {kind:'autocreate'};
    if(account?.source==='generated'&&account.credentialKind==='api_token'&&account.status==='draft'&&!account.hasPassword&&(account.registrationAttempts??0)===0&&(!binding||binding.accountId===account.id))return {kind:'autocreate',account};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='paper-wf'||channel.id==='hive'||channel.id==='mataroa'||channel.id==='verbose'||channel.id==='rentry'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channel.id);
    const account=accountForSiteChannel(state,siteId,channel.id,accountId);
    if(channel.id==='mataroa'&&account?.mataroaExcludedSiteIds?.includes(siteId))return {kind:'handoff_required',account};
    if(channel.id==='verbose'&&account?.verboseExcludedSiteIds?.includes(siteId))return {kind:'handoff_required',account};
    if(channel.id==='rentry'&&account?.rentryExcludedSiteIds?.includes(siteId))return {kind:'handoff_required',account};
    if(accountId&&binding&&binding.accountId!==accountId)return {kind:'handoff_required',account};
    const bound=channel.id==='hive'?!!binding&&binding.accountId===account?.id:!binding||binding.accountId===account?.id;
    const ready=!!account&&validPublisherIdentity(account,channel.id)&&bound;
    if(ready)return {kind:'ready',account};
    if(['paper-wf','mataroa'].includes(channel.id)&&!binding&&account?.source==='generated'&&account.credentialKind==='api_token'&&account.hasPassword&&['draft','unknown'].includes(account.status)&&(account.registrationAttempts??0)<=1)return {kind:'autocreate',account};
    if(channel.id==='verbose'&&!binding&&account?.source==='generated'&&(
      account.status==='draft'&&(account.registrationAttempts??0)===0||
      account.status==='unknown'&&account.registrationAttempts===1&&account.hasPassword
    ))return {kind:'autocreate',account};
    if(['paper-wf','mataroa','verbose','rentry'].includes(channel.id)&&!accountId&&!binding&&state.accounts.every(item=>item.channelId!==channel.id))return {kind:'autocreate'};
    return {kind:'handoff_required',account};
  }
  if(channel.id==='prose'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='prose');
    const account=accountForSiteChannel(state,siteId,'prose',accountId);
    return {kind:binding&&account&&binding.accountId===account.id&&validProseAccount(account)?'ready':'handoff_required',account};
  }
  if(channel.id==='deed-page'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='deed-page');
    const account=accountForSiteChannel(state,siteId,'deed-page',accountId);
    if(accountId&&!account)return {kind:'handoff_required'};
    if(account)return {kind:validDeedPageAccount(account)&&(!binding||binding.accountId===account.id)?'ready':'handoff_required',account};
    return state.accounts.every(item=>item.channelId!=='deed-page')?{kind:'autocreate'}:{kind:'handoff_required'};
  }
  if(channel.id==='brewpage'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='brewpage');
    const account=accountForSiteChannel(state,siteId,'brewpage',accountId);
    if(accountId&&!account)return {kind:'handoff_required'};
    if(account)return {kind:validBrewPageAccount(account)&&(!binding||binding.accountId===account.id)?'ready':'handoff_required',account};
    return state.accounts.every(item=>item.channelId!=='brewpage')?{kind:'autocreate'}:{kind:'handoff_required'};
  }
  if(channel.id==='here-now'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='here-now');
    const account=accountForSiteChannel(state,siteId,'here-now',accountId);
    return {kind:binding&&account&&binding.accountId===account.id&&validHereNowAccount(account)?'ready':'handoff_required',account};
  }
  if(channel.id==='shiply'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='shiply');
    const account=accountForSiteChannel(state,siteId,'shiply',accountId);
    return {kind:binding&&account&&binding.accountId===account.id&&validShiplyAccount(account)?'ready':'handoff_required',account};
  }
  if(channel.id==='beacon'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='beacon');
    const account=accountForSiteChannel(state,siteId,'beacon',accountId);
    return {kind:binding&&account&&binding.accountId===account.id&&validBeaconAccount(account)?'ready':'handoff_required',account};
  }
  if(channel.id==='valtown'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='valtown');
    const account=accountForSiteChannel(state,siteId,'valtown',accountId);
    return {kind:binding&&account&&binding.accountId===account.id&&validValTownAccount(account)?'ready':'handoff_required',account};
  }
  if(channel.id==='bitbucket'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='bitbucket');
    const account=accountForSiteChannel(state,siteId,'bitbucket',accountId);
    return {kind:binding&&account&&binding.accountId===account.id&&validBitbucketAccount(account)?'ready':'handoff_required',account};
  }
  if(['bluesky','paragraph'].includes(channel.id)){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channel.id);
    const account=state.accounts.find(item=>item.id===(accountId??binding?.accountId)&&item.channelId===channel.id);
    return {kind:(channel.id!=='paragraph'||state.sites.find(item=>item.id===siteId)?.paragraph?.publicationId===account?.username)&&binding&&account&&binding.accountId===account.id&&account.credentialKind==='api_token'&&account.status==='registered'&&account.hasPassword?'ready':'handoff_required',account};
  }
  if(!channel.accountRequired)return {kind:'ready'};
  const storedBinding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channel.id);
  const signupScript=channel.automation==='browser'?signupScriptFor(channel.id):undefined;
  const binding=storedBinding&&!accountId&&legacySharedGeneratedIdentity(state,siteId,channel.id,storedBinding.accountId)?undefined:storedBinding;
  const compatible=(candidate:Account)=>channel.automation==='api'?candidate.credentialKind==='api_token':candidate.credentialKind!=='api_token'&&candidate.credentialKind!=='oauth';
  let account=accountForSiteChannel(state,siteId,channel.id,accountId);
  if(!accountId&&!binding){
    const candidates=candidateAccounts(state,siteId,channel.id).filter(compatible);
    account=candidates.find(candidate=>candidate.status==='registered'&&candidate.hasPassword)
      ??candidates.find(candidate=>candidate.status==='unknown'&&candidate.hasPassword)
      ??candidates[0]
      ??account;
  }
  if(accountId&&!account)return {kind:'handoff_required'};
  if(account){
    if(siteIdentityConflict(state,account,siteId))return {kind:'handoff_required',account};
    if(!compatible(account)){
      if(!accountId&&!binding&&['telegraph','nostr'].includes(channel.id)&&channel.automation==='api')return {kind:'autocreate'};
      return {kind:'handoff_required',account};
    }
    if(channel.kind==='profile'&&profileAccountConflict(state,account.id,siteId,channel.id))return {kind:'handoff_required',account};
    if(['telegraph','nostr'].includes(channel.id)&&channel.automation==='api'&&account.status==='draft'&&account.source==='generated'&&account.credentialKind==='api_token'&&(account.registrationAttempts??0)<1)return {kind:'autocreate',account};
    const apiReady=channel.automation==='api'&&account.status==='registered'&&account.hasPassword&&account.credentialKind==='api_token';
    const browserReady=channel.automation==='browser'&&account.hasPassword&&['registered','unknown'].includes(account.status);
    if(apiReady||browserReady)return {kind:'ready',account};
    if(signupScript&&account.status==='draft'&&account.source==='generated'&&account.hasPassword){
      const continuation=state.tasks.some(task=>task.siteId===siteId&&task.channelId===channel.id&&task.accountId===account!.id
        &&task.signup?.identityId===account!.id&&task.signup.scriptId===signupScript.id&&task.signup.scriptVersion===signupScript.version
        &&['queued','running','needs_input'].includes(task.status)&&task.reasonCode!=='human_timeout');
      if((account.registrationAttempts??0)===0||continuation)return {kind:'autocreate',account};
    }
    return {kind:'handoff_required',account};
  }
  if(signupScript&&!binding&&!state.accounts.some(value=>value.channelId===channel.id))return {kind:'autocreate'};
  if(['telegraph','nostr'].includes(channel.id)&&channel.automation==='api')return {kind:'autocreate'};
  return {kind:'handoff_required'};
}

export function bindAccount(state:State,accountId:string,siteId:string,channel:Channel,now=new Date()):SiteAccountBinding{
  const account=state.accounts.find(item=>item.id===accountId);
  const site=state.sites.find(item=>item.id===siteId);
  if(!account||!site)throw Error('账号或网站不存在');
  if(account.channelId!==channel.id&&!(channel.id==='whitewind'&&account.channelId==='bluesky'))throw Error('账号与平台不匹配');
  const atprotoDid=atprotoAccountDid(account);if(atprotoDid&&(['leaflet','whitewind'].includes(channel.id)||state.accounts.some(value=>value.channelId==='leaflet'&&leafletAccountDid(value)===atprotoDid))&&atprotoIdentityConflict(state,atprotoDid,siteId))throw Error(BATCH5_MESSAGES.identitySingleSite);
  if(channel.singleSiteOnly&&(state.accountBindings.some(binding=>binding.accountId===account.id&&binding.siteId!==siteId)||state.tasks.some(task=>task.accountId===account.id&&task.siteId!==siteId&&(!!task.submittedAt||!!task.publicUrl||!!task.firstLiveAt))))throw Error(BATCH5_MESSAGES.identitySingleSite);
  if(account.retiredAt)throw Error(ACCOUNT_IDENTITY_MESSAGES.retired);
  const retiredPending=unresolvedRetiredPublication(state,siteId,channel.id,accountId,now);
  if(retiredPending)throw Error(ACCOUNT_IDENTITY_MESSAGES.pending(retiredPending));
  if(channel.automation!=='manual'&&siteIdentityConflict(state,account,siteId))throw Error('该发布账号已归属其他网站，不能跨站绑定或继续发布。');
  if(channel.id==='bluesky'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='bluesky'&&!task.firstLiveAt&&!task.publicUrl&&(task.submittedAt||task.bluesky)&&task.accountId!==accountId))throw Error('该网站有 Bluesky 发布结果待检查，保留原发布账号处理完成后再更换。');
  if(channel.id==='mataroa'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='mataroa'&&task.checkpoint==='mataroa_account_create_pending'&&task.accountId&&task.accountId!==accountId&&(!state.accounts.find(previous=>previous.id===task.accountId)?.retiredAt||hasPendingIdentityBudget(task,now))))throw Error('该网站的 Mataroa 首次注册仍归属原发布账号，不能改绑账号。');
  if(channel.id==='verbose'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='verbose'&&task.checkpoint==='verbose_account_create_pending'&&task.accountId&&task.accountId!==accountId&&(!state.accounts.find(previous=>previous.id===task.accountId)?.retiredAt||hasPendingIdentityBudget(task,now))))throw Error('该网站的 Verbose 首次注册仍归属原发布账号，不能改绑账号。');
  if(channel.id==='paragraph'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId===channel.id&&!task.firstLiveAt&&!task.publicUrl&&(task.submittedAt||task.paragraph)&&task.accountId!==accountId))throw Error('该网站有发布结果待检查，保留原发布账号处理完成后再更换。');
  const blockingTask=['telegraph','nostr'].includes(channel.id)?unresolvedIdentityPublication(state,siteId,channel.id,accountId,now):undefined;
  if(blockingTask)throw Error(ACCOUNT_IDENTITY_MESSAGES.pending(blockingTask));
  if(['paper-wf','hive','mataroa','verbose','rentry'].includes(channel.id)&&state.tasks.some(task=>hasPendingIdentityBudget(task,now)&&task.siteId===siteId&&task.channelId===channel.id&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.paper||task.hive||task.mataroa||task.verbose||task.rentry)&&task.accountId!==accountId))throw Error('该网站有发布结果待检查，保留原发布账号处理完成后再更换。');
  if(channel.id==='prose'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='prose'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.prose)&&task.accountId!==accountId))throw Error('该网站有 Prose 发布结果待检查，必须保留原发布账号。');
  if(channel.id==='wordpress-com'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='wordpress-com'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.wordpress)&&task.accountId!==accountId))throw Error('该网站有 WordPress.com 发布结果待检查，必须保留原博客发布账号。');
  if(channel.id==='leaflet'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='leaflet'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.leaflet)&&task.accountId!==accountId))throw new AccountBindingError('pending_publication','该网站有 Leaflet 发布结果待检查，必须保留原 DID 发布账号。');
  if(channel.id==='raindrop'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='raindrop'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.raindrop)&&task.accountId!==accountId))throw new AccountBindingError('pending_publication','该网站有 Raindrop 条目待检查，必须保留原所有者账号和原合集。');
  if(channel.id==='here-now'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='here-now'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.hereNow)&&task.accountId!==accountId))throw Error('该网站有 here.now 版本待检查，必须保留原个人发布账号。');
  if(channel.id==='shiply'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='shiply'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.shiply)&&task.accountId!==accountId))throw Error('该网站有 shiply.now 版本待检查，必须保留原个人发布账号。');
  if(channel.id==='beacon'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='beacon'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.beacon)&&task.accountId!==accountId))throw Error('该网站有 Beacon 文档待检查，必须保留原邮箱发布账号。');
  if(channel.id==='valtown'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='valtown'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.valtown)&&task.accountId!==accountId))throw Error('该网站有 Val Town 文档待检查，必须保留原 token 发布账号。');
  if(channel.id==='bitbucket'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='bitbucket'&&(task.submittedAt||task.publicUrl||task.bitbucket)&&task.accountId!==accountId))throw Error('该 Bitbucket workspace 已有静态站事务或公开 root，不能换账号、覆盖或服务其他网站。');
  if(channel.id==='vibedrop'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='vibedrop'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.vibedrop)&&task.accountId!==accountId))throw Error('该网站有 VibeDrop 发布待检查，必须保留原匿名密钥。');
  if(channel.id==='wordcell'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='wordcell'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.wordcell)&&task.accountId!==accountId))throw Error('该网站有 Wordcell 发布待检查，必须保留原固定令牌。');
  if(channel.id==='notebin'&&state.tasks.some(task=>hasPendingIdentityBudget(task,now)&&task.siteId===siteId&&task.channelId==='notebin'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.notebin||task.notebinJournal)&&task.accountId!==accountId))throw Error('该网站有 Notebin 发布待检查，必须保留原 PoW 发布账号和专用密钥。');
  if(channel.id==='carcinus'){
    if(!validCarcinusAccount(account))throw Error('Carcinus 一次性管理令牌不可用');
    if(state.accounts.some(item=>item.channelId==='carcinus'&&item.id!==accountId)||state.accountBindings.some(item=>item.channelId==='carcinus'&&(item.accountId!==accountId||item.siteId!==siteId))||state.tasks.some(task=>task.channelId==='carcinus'&&task.siteId!==siteId&&(task.carcinus||task.submittedAt||task.publicUrl)))throw Error('Carcinus 只允许一个稳定发布账号和一张公开页，不能绑定其他网站。');
  }
  if(channel.kind==='profile'&&channel.id!=='synthfolk'){
    if(profileAccountConflict(state,accountId,siteId,channel.id))throw Error('该资料页账号已绑定其他网站的公开或待确认结果；为避免覆盖原链接，请先核实原提交或选择其他账号。');
  }
  if(channel.id==='paragraph'){if(account.credentialKind!=='api_token'||account.status!=='registered'||!account.hasPassword||!account.publicationUrl)throw Error('请先验证本人 Paragraph 出版物连接');const url=new URL(account.publicationUrl);if(url.origin!=='https://paragraph.com'||!/^\/@[^/]+\/?$/.test(url.pathname)||url.search||url.hash)throw Error('出版物地址无效');site.paragraph={publicationId:account.username,url:url.toString()};}
  if(channel.id==='wordpress-com'&&!validWordPressAccount(account))throw Error('请先验证本人 WordPress.com 免费托管博客授权');
  if(channel.id==='leaflet'&&!validLeafletAccount(account))throw Error('请先为 Leaflet 单独验证本人 bsky.social 账号与应用专用密码');
  if(channel.id==='raindrop'&&!validRaindropAccount(account))throw Error('请先验证本人 Raindrop Test token 与公开专用根合集');
  if(channel.id==='deno'&&!validDenoReadAccount(account))throw Error('请先通过 Deno 专用入口验证只读连接');
  if(channel.id==='markest'&&!validMarkestReadAccount(account))throw Error('请先通过 Markest 专用入口验证读取连接');
  if(channel.id==='markest'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='markest'&&task.accountId!==accountId&&reservesSingleProfile(task)))throw Error('该网站已有 Markest 结果记录，不能改变原连接');
  if(channel.id==='prose'&&!validProseAccount(account))throw Error('请先验证本人 Prose 发布账号与专用 SSH 密钥');
  if(channel.id==='deed-page'&&!validDeedPageAccount(account))throw Error('deed.page 所有者令牌不可用');
  if(channel.id==='brewpage'&&!validBrewPageAccount(account))throw Error('BrewPage 所有者令牌不可用');
  if(channel.id==='here-now'&&!validHereNowAccount(account))throw Error('请先验证 here.now 个人账户与命名 API key');
  if(channel.id==='shiply'&&!validShiplyAccount(account))throw Error('请先验证 shiply.now 邮箱账户与 API key');
  if(channel.id==='beacon'&&!validBeaconAccount(account))throw Error('请先验证 Beacon 邮箱账户与 API key');
  if(channel.id==='valtown'&&!validValTownAccount(account))throw Error('请先验证 Val Town Free 个人账号与 token');
  if(channel.id==='bitbucket'&&!validBitbucketAccount(account))throw Error('请先验证 Bitbucket Free 工作区、私有项目与 token');
  if(channel.id==='vibedrop'&&!validVibeDropAccount(account))throw Error('VibeDrop 匿名密钥不可用');
  if(channel.id==='wordcell'&&!validWordcellAccount(account))throw Error('Wordcell 固定托管令牌不可用');
  if(channel.id==='notebin'&&!validNotebinAccount(account))throw Error('Notebin PoW 发布账号或专用密钥不可用');
  if(channel.id==='carcinus'&&!validCarcinusAccount(account))throw Error('Carcinus 一次性管理令牌不可用');
  if(channel.id==='synthfolk'){
    if(!validSynthfolkAccount(account))throw Error('请先通过 Synthfolk 专用入口只读验证已有发布账号');
    if(site.url!==account.synthfolk.website&&!site.topics?.some(topic=>topic.url===account.synthfolk!.website))throw Error('Synthfolk 单一公开发布账号的 Website 与当前站点不一致');
  }
  if(channel.id==='agentswiki'&&!validAgentsWikiAccount(account))throw Error('Agents Wiki 发布账号或 API key 不可用');
  if(channel.id==='agentswiki'&&state.accounts.some(item=>!item.retiredAt&&item.channelId==='agentswiki'&&item.id!==accountId))throw Error('Agents Wiki 只能复用一个如实标明为 AI 代理的发布账号');
  if(['paper-wf','hive','mataroa','verbose','rentry'].includes(channel.id)&&!validPublisherIdentity(account,channel.id as 'paper-wf'|'hive'|'mataroa'|'verbose'|'rentry'))throw Error(channel.id==='rentry'?'Rentry 本机发布密钥不可用':'请先验证本人出版账号及其公开地址');
  if(channel.id==='mataroa'&&account.mataroaExcludedSiteIds?.includes(siteId))account.mataroaExcludedSiteIds=account.mataroaExcludedSiteIds.filter(id=>id!==siteId);
  if(channel.id==='verbose'&&account.verboseExcludedSiteIds?.includes(siteId))account.verboseExcludedSiteIds=account.verboseExcludedSiteIds.filter(id=>id!==siteId);
  if(channel.id==='rentry'&&account.rentryExcludedSiteIds?.includes(siteId))account.rentryExcludedSiteIds=account.rentryExcludedSiteIds.filter(id=>id!==siteId);
  const stamp=now.toISOString();
  const existing=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channel.id);
  if(existing){
    existing.accountId=accountId;existing.updatedAt=stamp;
    if(account.source==='generated'&&!liveOwnerSiteId(state,account)&&!['rentry','carcinus'].includes(account.channelId))account.ownerSiteId=firstIdentitySite(state,accountId,account.channelId)??siteId;
    return existing;
  }
  const binding={id:randomUUID(),siteId,channelId:channel.id,accountId,createdAt:stamp,updatedAt:stamp};
  state.accountBindings.push(binding);
  if(account.source==='generated'&&!liveOwnerSiteId(state,account)&&!['rentry','carcinus'].includes(account.channelId))account.ownerSiteId=firstIdentitySite(state,accountId,account.channelId)??siteId;
  return binding;
}

export function unbindAccount(state:State,accountId:string,siteId:string,channelId:string):void{
  const account=state.accounts.find(item=>item.id===accountId&&item.channelId===channelId);
  if(['rant','slopit'].includes(channelId)&&account?.source==='generated'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId))throw new AccountBindingError('pending_publication',BATCH5_MESSAGES.generatedAccountBound);
  if(channelId==='wordpress-com'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.wordpress)))throw Error('该网站有 WordPress.com 发布结果待检查，必须保留原博客发布账号。');
  if(channelId==='leaflet'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.leaflet)))throw new AccountBindingError('pending_publication','该网站有 Leaflet 发布结果待检查，必须保留原 DID 发布账号。');
  if(channelId==='raindrop'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.raindrop)))throw new AccountBindingError('pending_publication','该网站有 Raindrop 条目待检查，必须保留原所有者账号和原合集。');
  if(channelId==='here-now'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.hereNow)))throw Error('该网站有 here.now 版本待检查，必须保留原个人发布账号。');
  if(channelId==='shiply'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.shiply)))throw Error('该网站有 shiply.now 版本待检查，必须保留原个人发布账号。');
  if(channelId==='beacon'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.beacon)))throw Error('该网站有 Beacon 文档待检查，必须保留原邮箱发布账号。');
  if(channelId==='valtown'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.valtown)))throw Error('该网站有 Val Town 文档待检查，必须保留原 token 发布账号。');
  if(channelId==='bitbucket'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&(task.submittedAt||task.publicUrl||task.bitbucket)))throw Error('该网站有 Bitbucket 静态站事务或公开 root，必须保留原 token 账号与绑定。');
  if(channelId==='vibedrop'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.vibedrop)))throw Error('该网站有 VibeDrop 发布待检查，必须保留原匿名密钥。');
  if(channelId==='wordcell'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.wordcell)))throw Error('该网站有 Wordcell 发布待检查，必须保留原固定令牌。');
  if(channelId==='notebin'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.notebin||task.notebinJournal)))throw Error('该网站有 Notebin 发布待检查，必须保留原 PoW 发布账号和专用密钥。');
  if(channelId==='carcinus'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId))throw Error('Carcinus 单一发布账号与公开页绑定不能解除。');
  if(channelId==='brewpage'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!!task.brewPage))throw Error('BrewPage 原提交信息仍绑定此所有者账号，不能解除关联。');
  if(channelId==='prose'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.prose)))throw Error('该网站有 Prose 发布结果待检查，必须保留原发布账号。');
  if(channelId==='mataroa'&&account&&state.sites.some(site=>site.id===siteId))account.mataroaExcludedSiteIds=[...new Set([...(account.mataroaExcludedSiteIds??[]),siteId])];
  if(channelId==='verbose'&&account&&state.sites.some(site=>site.id===siteId))account.verboseExcludedSiteIds=[...new Set([...(account.verboseExcludedSiteIds??[]),siteId])];
  if(channelId==='rentry'&&account&&state.sites.some(site=>site.id===siteId))account.rentryExcludedSiteIds=[...new Set([...(account.rentryExcludedSiteIds??[]),siteId])];
  state.accountBindings=state.accountBindings.filter(item=>!(item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId));
}

/** Saving local account metadata must not re-authorize unchanged legacy bindings. */
export function bindSelectedAccountSites(state:State,accountId:string,siteIds:Iterable<string>,channel:Channel,now=new Date()):void{
  for(const siteId of siteIds){
    if(state.accountBindings.some(binding=>binding.accountId===accountId&&binding.siteId===siteId&&binding.channelId===channel.id))continue;
    bindAccount(state,accountId,siteId,channel,now);
  }
}

/** The account editor removes bindings through the same guards as an individual unbind. */
export function setSelectedAccountSites(state:State,accountId:string,selected:Set<string>,channel:Channel,now=new Date()):void{
  const protectedChannels=['rant','slopit','wordpress-com','leaflet','raindrop','prose','beacon','valtown','bitbucket','here-now','shiply','vibedrop','notebin','berrry','agenthow','swarmmemo','openagentchat','agentriot','shellbook','agentnotepad','colony','large-language'];
  if(protectedChannels.includes(channel.id))for(const binding of [...state.accountBindings]){
    if(binding.accountId===accountId&&binding.channelId===channel.id&&!selected.has(binding.siteId))
      unbindAccount(state,accountId,binding.siteId,channel.id);
  }
  state.accountBindings=state.accountBindings.filter(binding=>binding.accountId!==accountId||binding.channelId!==channel.id||selected.has(binding.siteId));
  bindSelectedAccountSites(state,accountId,selected,channel,now);
}

export function attachTaskAccount(state:State,taskId:string,channel:Channel):Account|undefined{
  const task=state.tasks.find(item=>item.id===taskId);if(!task)return;
  let account=boundAccount(state,task);
  if(account){if(channel.id!=='synthfolk'||validSynthfolkAccount(account))bindAccount(state,account.id,task.siteId,channel);task.accountId=account.id;}
  return account;
}
