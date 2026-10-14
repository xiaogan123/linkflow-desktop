import {randomUUID} from 'node:crypto';
import {validNotebinAccount} from '../shared/notebin-account';
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
import {validShipPageAccount} from './shippage-publication';

export type ChannelExecutionReadiness='ready'|'autocreate'|'handoff_required'|'manual';

function lower(value:string){return value.trim().toLowerCase()}
function reservesSingleProfile(task:Task):boolean{
  return !!task.publicUrl||!!task.submittedAt||[
    'submitting','submitted','submission_uncertain','account_registration_submitted',
    'telegraph_publish_submitting','telegraph_publish_uncertain','telegraph_published','gist_published',
  ].includes(task.checkpoint??'');
}
function profileAccountConflict(state:State,accountId:string,siteId:string,channelId:string):boolean{
  const historical=state.tasks.some(task=>task.accountId===accountId&&task.channelId===channelId&&task.siteId!==siteId&&reservesSingleProfile(task));
  return historical||state.accountBindings.some(binding=>binding.accountId===accountId&&binding.channelId===channelId&&binding.siteId!==siteId&&state.tasks.some(task=>task.siteId===binding.siteId&&task.channelId===channelId&&reservesSingleProfile(task)));
}

function candidateAccounts(state:State,siteId:string,channelId:string):Account[]{
  const site=state.sites.find(item=>item.id===siteId);if(!site||['nostr','hive'].includes(channelId))return [];
  if(['wordpress-com','leaflet','raindrop','notebin'].includes(channelId))return state.accounts.filter(account=>account.channelId===channelId);
  if(channelId==='here-now')return state.accounts.filter(account=>account.channelId==='here-now');
  if(channelId==='shiply')return state.accounts.filter(account=>account.channelId==='shiply');
  if(['paper-wf','mataroa','verbose','prose','rentry','deed-page','brewpage','shippage'].includes(channelId))return state.accounts.filter(account=>account.channelId===channelId&&!(channelId==='mataroa'&&account.mataroaExcludedSiteIds?.includes(siteId))&&!(channelId==='verbose'&&account.verboseExcludedSiteIds?.includes(siteId))&&!(channelId==='rentry'&&account.rentryExcludedSiteIds?.includes(siteId)));
  return state.accounts.filter(account=>account.channelId===channelId&&(channelId==='github-gist'||lower(account.email)===lower(site.publicEmail||site.email)));
}

/** Resolve the same account for readiness, planning, and execution. */
export function accountForSiteChannel(state:State,siteId:string,channelId:string,accountId?:string):Account|undefined{
  if(accountId)return state.accounts.find(account=>account.id===accountId&&account.channelId===channelId);
  const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channelId);
  if(binding){const account=state.accounts.find(account=>account.id===binding.accountId);return channelId==='mataroa'&&account?.mataroaExcludedSiteIds?.includes(siteId)||channelId==='verbose'&&account?.verboseExcludedSiteIds?.includes(siteId)||channelId==='rentry'&&account?.rentryExcludedSiteIds?.includes(siteId)?undefined:account;}
  if(['wordpress-com','leaflet','raindrop'].includes(channelId))return;
  const candidates=candidateAccounts(state,siteId,channelId);
  if(channelId==='notebin')return candidates.length===1?candidates[0]:undefined;
  if(channelId==='here-now')return candidates.length===1?candidates[0]:undefined;
  if(channelId==='shiply')return candidates.length===1?candidates[0]:undefined;
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
export function channelExecutionReadiness(state:State,siteId:string,channel:Channel,accountId?:string):{kind:ChannelExecutionReadiness;account?:Account}{
  if(channel.id==='deno')return {kind:'handoff_required',account:accountForSiteChannel(state,siteId,channel.id,accountId)};
  if(channel.id==='markest')return {kind:'handoff_required',account:accountForSiteChannel(state,siteId,channel.id,accountId)};
  if(channel.automation==='manual')return {kind:'manual'};
  if(channel.id==='blogger'){
    const site=state.sites.find(item=>item.id===siteId),binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='blogger');
    const account=state.accounts.find(item=>item.id===(accountId??binding?.accountId)&&item.channelId==='blogger');
    return {kind:site?.blogger&&binding&&account&&binding.accountId===account.id&&account.credentialKind==='oauth'&&account.status==='registered'&&account.hasPassword?'ready':'handoff_required',account};
  }
  if(channel.id==='wordpress-com'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='wordpress-com');
    const account=state.accounts.find(item=>item.id===(accountId??binding?.accountId)&&item.channelId==='wordpress-com');
    return {kind:binding&&account&&binding.accountId===account.id&&validWordPressAccount(account)?'ready':'handoff_required',account};
  }
  if(channel.id==='leaflet'){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='leaflet');
    const account=state.accounts.find(item=>item.id===(accountId??binding?.accountId)&&item.channelId==='leaflet');
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
  if(['bluesky','paragraph'].includes(channel.id)){
    const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channel.id);
    const account=state.accounts.find(item=>item.id===(accountId??binding?.accountId)&&item.channelId===channel.id);
    return {kind:(channel.id!=='paragraph'||state.sites.find(item=>item.id===siteId)?.paragraph?.publicationId===account?.username)&&binding&&account&&binding.accountId===account.id&&account.credentialKind==='api_token'&&account.status==='registered'&&account.hasPassword?'ready':'handoff_required',account};
  }
  if(!channel.accountRequired)return {kind:'ready'};
  const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channel.id);
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
    if(!compatible(account)){
      if(!accountId&&!binding&&['telegraph','nostr'].includes(channel.id)&&channel.automation==='api')return {kind:'autocreate'};
      return {kind:'handoff_required',account};
    }
    if(channel.kind==='profile'&&profileAccountConflict(state,account.id,siteId,channel.id))return {kind:'handoff_required',account};
    if(['telegraph','nostr'].includes(channel.id)&&channel.automation==='api'&&account.status==='draft'&&account.source==='generated'&&account.credentialKind==='api_token'&&(account.registrationAttempts??0)<1)return {kind:'autocreate',account};
    const apiReady=channel.automation==='api'&&account.status==='registered'&&account.hasPassword&&account.credentialKind==='api_token';
    const browserReady=channel.automation==='browser'&&account.hasPassword&&['registered','unknown'].includes(account.status);
    if(apiReady||browserReady)return {kind:'ready',account};
    return {kind:'handoff_required',account};
  }
  if(['telegraph','nostr'].includes(channel.id)&&channel.automation==='api')return {kind:'autocreate'};
  return {kind:'handoff_required'};
}

export function bindAccount(state:State,accountId:string,siteId:string,channel:Channel,now=new Date()):SiteAccountBinding{
  const account=state.accounts.find(item=>item.id===accountId);
  const site=state.sites.find(item=>item.id===siteId);
  if(!account||!site)throw Error('账号或网站不存在');
  if(account.channelId!==channel.id)throw Error('账号与渠道不匹配');
  if(channel.id==='bluesky'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='bluesky'&&!task.firstLiveAt&&!task.publicUrl&&(task.submittedAt||task.bluesky)&&task.accountId!==accountId))throw Error('该网站有 Bluesky 发布结果待核验，保留原身份处理完成后再更换。');
  if(channel.id==='mataroa'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='mataroa'&&task.checkpoint==='mataroa_account_create_pending'&&task.accountId&&task.accountId!==accountId))throw Error('该网站的 Mataroa 首次注册仍归属原身份，不能改绑账号。');
  if(channel.id==='verbose'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='verbose'&&task.checkpoint==='verbose_account_create_pending'&&task.accountId&&task.accountId!==accountId))throw Error('该网站的 Verbose 首次注册仍归属原身份，不能改绑账号。');
  if(['paragraph','nostr'].includes(channel.id)&&state.tasks.some(task=>task.siteId===siteId&&task.channelId===channel.id&&!task.firstLiveAt&&!task.publicUrl&&(task.submittedAt||task.paragraph||task.nostr)&&task.accountId!==accountId))throw Error('该网站有发布结果待核验，保留原身份处理完成后再更换。');
  if(['paper-wf','hive','mataroa','verbose','rentry'].includes(channel.id)&&state.tasks.some(task=>task.siteId===siteId&&task.channelId===channel.id&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.paper||task.hive||task.mataroa||task.verbose||task.rentry)&&task.accountId!==accountId))throw Error('该网站有发布结果待核验，保留原身份处理完成后再更换。');
  if(channel.id==='prose'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='prose'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.prose)&&task.accountId!==accountId))throw Error('该网站有 Prose 发布结果待核验，必须保留原出版身份。');
  if(channel.id==='wordpress-com'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='wordpress-com'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.wordpress)&&task.accountId!==accountId))throw Error('该网站有 WordPress.com 发布结果待核验，必须保留原博客身份。');
  if(channel.id==='leaflet'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='leaflet'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.leaflet)&&task.accountId!==accountId))throw Error('该网站有 Leaflet 发布结果待核验，必须保留原 DID 身份。');
  if(channel.id==='raindrop'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='raindrop'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.raindrop)&&task.accountId!==accountId))throw Error('该网站有 Raindrop 条目待核验，必须保留原所有者与合集身份。');
  if(channel.id==='here-now'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='here-now'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.hereNow)&&task.accountId!==accountId))throw Error('该网站有 here.now 版本待核验，必须保留原个人身份。');
  if(channel.id==='shiply'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='shiply'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.shiply)&&task.accountId!==accountId))throw Error('该网站有 shiply.now 版本待核验，必须保留原个人身份。');
  if(channel.id==='vibedrop'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='vibedrop'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.vibedrop)&&task.accountId!==accountId))throw Error('该网站有 VibeDrop 发布待核验，必须保留原匿名密钥。');
  if(channel.id==='notebin'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='notebin'&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.notebin||task.notebinJournal)&&task.accountId!==accountId))throw Error('该网站有 Notebin 发布待核验，必须保留原 PoW 身份和专用密钥。');
  if(channel.kind==='profile'){
    if(profileAccountConflict(state,accountId,siteId,channel.id))throw Error('该资料页账号已绑定其他网站的公开或待确认结果；为避免覆盖原链接，请先核实原提交或选择其他账号。');
  }
  if(channel.id==='paragraph'){if(account.credentialKind!=='api_token'||account.status!=='registered'||!account.hasPassword||!account.publicationUrl)throw Error('请先验证本人 Paragraph 出版物连接');const url=new URL(account.publicationUrl);if(url.origin!=='https://paragraph.com'||!/^\/@[^/]+\/?$/.test(url.pathname)||url.search||url.hash)throw Error('出版物地址无效');site.paragraph={publicationId:account.username,url:url.toString()};}
  if(channel.id==='wordpress-com'&&!validWordPressAccount(account))throw Error('请先验证本人 WordPress.com 免费托管博客授权');
  if(channel.id==='leaflet'&&!validLeafletAccount(account))throw Error('请先为 Leaflet 单独验证本人 bsky.social 账号与应用专用密码');
  if(channel.id==='raindrop'&&!validRaindropAccount(account))throw Error('请先验证本人 Raindrop Test token 与公开专用根合集');
  if(channel.id==='deno'&&!validDenoReadAccount(account))throw Error('请先通过 Deno 专用入口验证只读连接');
  if(channel.id==='markest'&&!validMarkestReadAccount(account))throw Error('请先通过 Markest 专用入口验证读取连接');
  if(channel.id==='markest'&&state.tasks.some(task=>task.siteId===siteId&&task.channelId==='markest'&&task.accountId!==accountId&&reservesSingleProfile(task)))throw Error('该网站已有 Markest 结果记录，不能改变原连接');
  if(channel.id==='prose'&&!validProseAccount(account))throw Error('请先验证本人 Prose 出版身份与专用 SSH 密钥');
  if(channel.id==='deed-page'&&!validDeedPageAccount(account))throw Error('deed.page 所有者令牌不可用');
  if(channel.id==='brewpage'&&!validBrewPageAccount(account))throw Error('BrewPage 所有者令牌不可用');
  if(channel.id==='here-now'&&!validHereNowAccount(account))throw Error('请先验证 here.now 个人账户与命名 API key');
  if(channel.id==='shiply'&&!validShiplyAccount(account))throw Error('请先验证 shiply.now 邮箱账户与 API key');
  if(channel.id==='vibedrop'&&!validVibeDropAccount(account))throw Error('VibeDrop 匿名密钥不可用');
  if(channel.id==='notebin'&&!validNotebinAccount(account))throw Error('Notebin PoW 身份或专用密钥不可用');
  if(['paper-wf','hive','mataroa','verbose','rentry'].includes(channel.id)&&!validPublisherIdentity(account,channel.id as 'paper-wf'|'hive'|'mataroa'|'verbose'|'rentry'))throw Error(channel.id==='rentry'?'Rentry 本机发布密钥不可用':'请先验证本人出版账号及其公开地址');
  if(channel.id==='mataroa'&&account.mataroaExcludedSiteIds?.includes(siteId))account.mataroaExcludedSiteIds=account.mataroaExcludedSiteIds.filter(id=>id!==siteId);
  if(channel.id==='verbose'&&account.verboseExcludedSiteIds?.includes(siteId))account.verboseExcludedSiteIds=account.verboseExcludedSiteIds.filter(id=>id!==siteId);
  if(channel.id==='rentry'&&account.rentryExcludedSiteIds?.includes(siteId))account.rentryExcludedSiteIds=account.rentryExcludedSiteIds.filter(id=>id!==siteId);
  const stamp=now.toISOString();
  const existing=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channel.id);
  if(existing){existing.accountId=accountId;existing.updatedAt=stamp;return existing}
  const binding={id:randomUUID(),siteId,channelId:channel.id,accountId,createdAt:stamp,updatedAt:stamp};
  state.accountBindings.push(binding);
  return binding;
}

export function unbindAccount(state:State,accountId:string,siteId:string,channelId:string):void{
  const account=state.accounts.find(item=>item.id===accountId&&item.channelId===channelId);
  if(channelId==='wordpress-com'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.wordpress)))throw Error('该网站有 WordPress.com 发布结果待核验，必须保留原博客身份。');
  if(channelId==='leaflet'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.leaflet)))throw Error('该网站有 Leaflet 发布结果待核验，必须保留原 DID 身份。');
  if(channelId==='raindrop'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.raindrop)))throw Error('该网站有 Raindrop 条目待核验，必须保留原所有者与合集身份。');
  if(channelId==='here-now'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.hereNow)))throw Error('该网站有 here.now 版本待核验，必须保留原个人身份。');
  if(channelId==='shiply'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.shiply)))throw Error('该网站有 shiply.now 版本待核验，必须保留原个人身份。');
  if(channelId==='vibedrop'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.vibedrop)))throw Error('该网站有 VibeDrop 发布待核验，必须保留原匿名密钥。');
  if(channelId==='notebin'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.notebin||task.notebinJournal)))throw Error('该网站有 Notebin 发布待核验，必须保留原 PoW 身份和专用密钥。');
  if(channelId==='brewpage'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!!task.brewPage))throw Error('BrewPage 原发布意图仍绑定此所有者身份，不能解除关联。');
  if(channelId==='prose'&&state.accountBindings.some(item=>item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId)&&state.tasks.some(task=>task.accountId===accountId&&task.siteId===siteId&&task.channelId===channelId&&!task.firstLiveAt&&(task.submittedAt||task.publicUrl||task.prose)))throw Error('该网站有 Prose 发布结果待核验，必须保留原出版身份。');
  if(channelId==='mataroa'&&account&&state.sites.some(site=>site.id===siteId))account.mataroaExcludedSiteIds=[...new Set([...(account.mataroaExcludedSiteIds??[]),siteId])];
  if(channelId==='verbose'&&account&&state.sites.some(site=>site.id===siteId))account.verboseExcludedSiteIds=[...new Set([...(account.verboseExcludedSiteIds??[]),siteId])];
  if(channelId==='rentry'&&account&&state.sites.some(site=>site.id===siteId))account.rentryExcludedSiteIds=[...new Set([...(account.rentryExcludedSiteIds??[]),siteId])];
  state.accountBindings=state.accountBindings.filter(item=>!(item.accountId===accountId&&item.siteId===siteId&&item.channelId===channelId));
}

export function attachTaskAccount(state:State,taskId:string,channel:Channel):Account|undefined{
  const task=state.tasks.find(item=>item.id===taskId);if(!task)return;
  let account=boundAccount(state,task);
  if(account){bindAccount(state,account.id,task.siteId,channel);task.accountId=account.id;}
  return account;
}
