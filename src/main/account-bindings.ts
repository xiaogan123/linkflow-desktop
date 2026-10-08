import {randomUUID} from 'node:crypto';
import type {Account,Channel,SiteAccountBinding,Task} from '../shared/types';
import type {State} from './store';
import {validProseAccount} from '../integrations/prose';

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
  if(channelId==='wordpress-com'||channelId==='leaflet')return state.accounts.filter(account=>account.channelId===channelId);
  if(['paper-wf','mataroa','verbose','prose','rentry'].includes(channelId))return state.accounts.filter(account=>account.channelId===channelId&&!(channelId==='mataroa'&&account.mataroaExcludedSiteIds?.includes(siteId))&&!(channelId==='verbose'&&account.verboseExcludedSiteIds?.includes(siteId))&&!(channelId==='rentry'&&account.rentryExcludedSiteIds?.includes(siteId)));
  return state.accounts.filter(account=>account.channelId===channelId&&(channelId==='github-gist'||lower(account.email)===lower(site.publicEmail||site.email)));
}

/** Resolve the same account for readiness, planning, and execution. */
export function accountForSiteChannel(state:State,siteId:string,channelId:string,accountId?:string):Account|undefined{
  if(accountId)return state.accounts.find(account=>account.id===accountId&&account.channelId===channelId);
  const binding=state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channelId);
  if(binding){const account=state.accounts.find(account=>account.id===binding.accountId);return channelId==='mataroa'&&account?.mataroaExcludedSiteIds?.includes(siteId)||channelId==='verbose'&&account?.verboseExcludedSiteIds?.includes(siteId)||channelId==='rentry'&&account?.rentryExcludedSiteIds?.includes(siteId)?undefined:account;}
  if(channelId==='wordpress-com'||channelId==='leaflet')return;
  const candidates=candidateAccounts(state,siteId,channelId);
  if(['paper-wf','mataroa','verbose','prose','rentry'].includes(channelId))return candidates.length===1?candidates[0]:undefined;
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

/** Classify whether an automatic channel can run before spending generation or review calls. */
export function channelExecutionReadiness(state:State,siteId:string,channel:Channel,accountId?:string):{kind:ChannelExecutionReadiness;account?:Account}{
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
  if(channel.kind==='profile'){
    if(profileAccountConflict(state,accountId,siteId,channel.id))throw Error('该资料页账号已绑定其他网站的公开或待确认结果；为避免覆盖原链接，请先核实原提交或选择其他账号。');
  }
  if(channel.id==='paragraph'){if(account.credentialKind!=='api_token'||account.status!=='registered'||!account.hasPassword||!account.publicationUrl)throw Error('请先验证本人 Paragraph 出版物连接');const url=new URL(account.publicationUrl);if(url.origin!=='https://paragraph.com'||!/^\/@[^/]+\/?$/.test(url.pathname)||url.search||url.hash)throw Error('出版物地址无效');site.paragraph={publicationId:account.username,url:url.toString()};}
  if(channel.id==='wordpress-com'&&!validWordPressAccount(account))throw Error('请先验证本人 WordPress.com 免费托管博客授权');
  if(channel.id==='leaflet'&&!validLeafletAccount(account))throw Error('请先为 Leaflet 单独验证本人 bsky.social 账号与应用专用密码');
  if(channel.id==='prose'&&!validProseAccount(account))throw Error('请先验证本人 Prose 出版身份与专用 SSH 密钥');
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
