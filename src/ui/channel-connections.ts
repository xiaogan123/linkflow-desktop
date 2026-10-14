import type {Account,Snapshot} from '../shared/types';
import {validNotebinAccount} from '../shared/notebin-account';

export type ConnectionChannelId='slugpost'|'notebin'|'vibedrop'|'plopino'|'mataroa'|'verbose'|'rentry'|'lucid-page'|'betterthanhtml'|'supanote'|'docs-md'|'html-app'|'deed-page'|'brewpage'|'markdrop'|'katbin'|'agentdrop'|'mdshare'|'totpage'|'mdview'|'txtsbs'|'nextgen-slides'|'shippage'|'pstrs'|'yourwebs'|'pastemyst'|'markdownpaste'|'draftmark'|'memorywiki'|'here-now'|'shiply'|'paper-wf'|'hive'|'prose'|'markest'|'deno'|'nostr'|'github-gist'|'telegraph'|'blogger'|'wordpress-com'|'leaflet'|'paragraph'|'bluesky'|'raindrop';
export type ConnectionState='no_setup'|'first_connection'|'attention'|'connected'|'read_only'|'unavailable';
export interface ConnectionOverviewRow {
  id:ConnectionChannelId;
  name:string;
  format:'全文'|'短帖';
  state:ConnectionState;
  detail:string;
  connectedCount:number;
  boundSiteCount:number;
  checkedCount:number;
  attentionAccountId?:string;
}

const channels:{id:ConnectionChannelId;name:string;format:'全文'|'短帖';firstStep:string}[]=[
  {id:'slugpost',name:'SlugPost',format:'全文',firstStep:'免账号经官方网页发布原创全文；稿件须先审核，遇本人验证保留原任务。固定地址与编辑凭据在本机加密保存，结果不明不重发；没有长期保留保证。'},
  {id:'notebin',name:'Notebin',format:'全文',firstStep:'任务按官方代理协议完成一次有界 PoW 身份创建，再铸造最小权限专用密钥并加密保存；结果不明时不重建身份或重发。首次真实验收前渠道保持停用。'},
  {id:'vibedrop',name:'VibeDrop',format:'全文',firstStep:'任务自动建立并复用匿名发布身份，无需邮箱或手动创建令牌；凭据在本机加密保存，结果不明时只读核对原页面，不会重复发布。'},
  {id:'plopino',name:'Plopino',format:'全文',firstStep:'已有账号可用邮箱和密码连接；没有账号时，任务会用网站已授权邮箱自动建立一次，结果不明不会重复注册。'},
  {id:'mataroa',name:'Mataroa',format:'全文',firstStep:'任务需要时自动建号；遇平台验证则保留原身份。'},
  {id:'verbose',name:'Verbose.blog',format:'全文',firstStep:'实验渠道可在任务需要时自动建号；一次性令牌无法补发。'},
  {id:'rentry',name:'Rentry',format:'全文',firstStep:'无需注册账号；任务自动保存本机编辑凭据后发布。'},
  {id:'lucid-page',name:'Lucid.page',format:'全文',firstStep:'无需注册账号；匿名发布后修改或删除需先认领。'},
  {id:'betterthanhtml',name:'Better Than HTML',format:'全文',firstStep:'无需注册账号；任务直接发布静态全文，尚未确认文章修改或删除接口。'},
  {id:'html-app',name:'ht-ml.app',format:'全文',firstStep:'无需账号；公开内容可能被抓取或复制，服务不保证长期保留。'},
  {id:'deed-page',name:'deed.page',format:'全文',firstStep:'免注册发布静态全文；首次发布会加密保存一次性所有者令牌，后续文章复用同一免费所有者与配额。默认不设到期时间，但不保证长期可用或保留。'},
  {id:'brewpage',name:'BrewPage',format:'全文',firstStep:'免注册发布最长 30 天的原创 Markdown；首次任务获取并加密保存一个所有者令牌，同一网站持续复用。结果不明时只读对账，不重新获取身份或重发。'},
  {id:'katbin',name:'Katbin',format:'全文',firstStep:'免账号发布完整 Markdown；原始创建响应在本机加密保留。结果不明不重发；没有匿名编辑、删除或列表找回。'},
  {id:'nextgen-slides',name:'NextGen Slides',format:'全文',firstStep:'无需账号或邮箱。匿名网页在 90 天未访问后可能删除；原始响应加密保存，结果不明不重发。'},
  {id:'yourwebs',name:'Yourwebs',format:'全文',firstStep:'无需账号或邮箱。匿名网页保留 30 天；原始响应加密保存，结果不明不重发。'},
  {id:'totpage',name:'TOT.page',format:'全文',firstStep:'无需账号或邮箱。开放网页的保存期限未知，持公开链接者可修改或删除；原始响应加密保存，结果不明不重发。'},
  {id:'mdview',name:'MDView',format:'全文',firstStep:'当前停用：实际匿名页声明 noindex,nofollow；页面固定 30 天到期，原稿与回执保留，不重复投稿。'},
  {id:'txtsbs',name:'txt.sbs',format:'全文',firstStep:'无需账号或邮箱。通过官方公开表单发布静态 HTML 全文；管理密钥和原始回包仅在本机加密保存，结果不明不重发。平台可删除页面，不能保证永久保留。'},
  {id:'mdshare',name:'MDShare',format:'全文',firstStep:'免账号发布公开 Markdown；匿名写入开关未开放或结果不明即停止。API 原文与浏览器 JS 渲染正文均核验后才计入，首次真实验收前保持停用。'},
  {id:'agentdrop',name:'AgentDrop',format:'全文',firstStep:'无需账号或邮箱。匿名网页保留 30 天；原始响应加密保存，结果不明不重发。'},
  {id:'shippage',name:'ShipPage',format:'全文',firstStep:'首次任务用创建请求自动建立一个平台账号并加密保存 API key；所有网站复用这一账号，不以重复注册规避每月免费额度。每页固定 14 天到期，结果不明不重发、不换号、不自动续期。'},
  {id:'pstrs',name:'PST.RS',format:'全文',firstStep:'免账号发布最长 365 天的完整 Markdown；原始响应与管理令牌在本机加密保留。结果不明或 206 截断均不重发，过期不自动续期。'},
  {id:'pastemyst',name:'PasteMyst',format:'全文',firstStep:'免账号发布完整 Markdown；原始创建响应在本机加密保留。结果不明不重发；没有安全的匿名所有者编辑、删除或列表找回。'},
  {id:'markdownpaste',name:'Markdown Pastebin',format:'全文',firstStep:'免账号发布完整 Markdown；expires_in=0 只表示不主动过期。官方源码存在按 ID 无认证删除，客户端不会调用删除，不能视为永久或受保护存储。'},
  {id:'markdrop',name:'Markdrop',format:'全文',firstStep:'免注册发布 Markdown 全文；一次性编辑密钥使用操作系统加密后仅存本机。默认不到期，但不保证长期可用或保留。'},
  {id:'draftmark',name:'Draftmark',format:'全文',firstStep:'免注册发布公开 Markdown 全文；逐文档 magic token 和 API key 使用操作系统加密后仅存本机。没有免费层 SLA 或永久保留保证。'},
  {id:'memorywiki',name:'Memory.wiki',format:'全文',firstStep:'免注册发布公开 Markdown 全文；编辑令牌与原始回包只在本机加密保存。结果不明不重发或猜测 ID，空到期时间不代表永久 SLA。'},
  {id:'here-now',name:'here.now',format:'全文',firstStep:'一次连接已验证邮箱的个人账户命名 API key；可同时只读核对已有页面。匿名 24 小时页面不作为永久身份。'},
  {id:'shiply',name:'Shiply.now',format:'全文',firstStep:'向本人授权邮箱请求六位验证码，一次验证后加密保存 API key；后续复用同一账号。真实发布验收前停用。'},
  {id:'supanote',name:'Supanote',format:'全文',firstStep:'无需注册账号；匿名发布 Markdown。平台未返回管理令牌时不承诺可编辑或删除。'},
  {id:'docs-md',name:'Docs MD',format:'全文',firstStep:'无需注册账号；匿名分享经核对的 Markdown，编辑令牌只加密保存在本机。'},
  {id:'paper-wf',name:'Paper.wf',format:'全文',firstStep:'可连接已有账号；自动建号可能需要首次人机验证。'},
  {id:'hive',name:'Hive',format:'全文',firstStep:'连接本人账号的 posting key，再选择要使用的网站。'},
  {id:'prose',name:'Prose',format:'全文',firstStep:'粘贴本人受邀身份的专用 SSH 私钥，只读核对身份后选择网站。'},
  {id:'deno',name:'Deno Deploy',format:'全文',firstStep:'先由本人登录 Deno，创建专用组织和应用；粘贴该组织令牌，选择精确应用 UUID。仅只读连接，发布待验收。'},
  {id:'markest',name:'Markest',format:'全文',firstStep:'粘贴本人账户中手动创建的专用个人 key；仅验证读取，发布未启用。'},
  {id:'nostr',name:'Nostr',format:'全文',firstStep:'任务需要时自动建立作者身份。'},
  {id:'github-gist',name:'GitHub Gist',format:'全文',firstStep:'连接已有 GitHub 账号的 Gists 令牌。'},
  {id:'telegraph',name:'Telegraph',format:'全文',firstStep:'任务需要时自动建立作者身份。'},
  {id:'blogger',name:'Blogger',format:'全文',firstStep:'首次完成 Google 授权，再选择博客和网站。'},
  {id:'wordpress-com',name:'WordPress.com',format:'全文',firstStep:'首次在浏览器授权，再选择已公开博客和要关联的网站。'},
  {id:'leaflet',name:'Leaflet',format:'全文',firstStep:'首次连接本人 Bluesky 托管账号的应用密码，之后发布完整文章。'},
  {id:'raindrop',name:'Raindrop',format:'短帖',firstStep:'本人确认邮箱并在最外层建立专用公开合集；粘贴个人 Test token、选择合集和实际公开地址。'},
  {id:'paragraph',name:'Paragraph',format:'全文',firstStep:'连接已有 publication 的 API key，并选择网站。'},
  {id:'bluesky',name:'Bluesky',format:'短帖',firstStep:'连接已有账号的 app password，并选择网站。'},
];
const needsBinding=new Set<ConnectionChannelId>(['notebin','vibedrop','plopino','shippage','here-now','shiply','hive','prose','markest','deno','blogger','wordpress-com','leaflet','paragraph','bluesky','raindrop']);
const selfProvisioned=new Set<ConnectionChannelId>(['slugpost','notebin','vibedrop','plopino','shippage','mataroa','verbose','telegraph','nostr','rentry','lucid-page','betterthanhtml','supanote','docs-md','html-app','deed-page','brewpage','markdrop','katbin','nextgen-slides','totpage','mdview','txtsbs','mdshare','agentdrop','pstrs','yourwebs','pastemyst','markdownpaste','draftmark','memorywiki']);

const fingerprintPattern=/^[0-9a-f]{64}$/;

export function isDenoReadAccessAccount(account:Account){
  const proof=account.denoReadAccess;
  return account.channelId==='deno'&&account.status==='unknown'&&account.credentialKind==='api_token'&&account.source==='imported'&&account.hasPassword&&proof?.version===1&&proof.identity==='app_verified_org_declared'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(proof.appId)&&/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/.test(proof.appSlug)&&/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/.test(proof.declaredOrgSlug)&&account.username===proof.appId&&/^[0-9a-f]{64}$/.test(proof.tokenFingerprint)&&Number.isFinite(Date.parse(proof.checkedAt))&&!account.registeredAt&&!account.verifiedAt&&!account.publicationUrl&&!account.diagnostic&&!(account.registrationAttempts??0);
}

export function isMarkestReadAccessAccount(account:Account){
  if(account.channelId!=='markest'||account.status!=='unknown'||account.credentialKind!=='api_token'||account.source!=='imported'||!account.hasPassword)return false;
  const access=account.markestReadAccess;
  const usernameFingerprint=account.username.startsWith('local-key:')?account.username.slice('local-key:'.length):'';
  return access?.version===1
    &&access.identity==='user_declared'
    &&fingerprintPattern.test(access.keyFingerprint)
    &&fingerprintPattern.test(usernameFingerprint)
    &&access.keyFingerprint===usernameFingerprint
    &&Number.isFinite(Date.parse(access.checkedAt))
    &&!account.registeredAt
    &&!account.verifiedAt
    &&!account.publicationUrl
    &&!account.diagnostic
    &&!(account.registrationAttempts??0);
}

export function isRaindropConnectionAccount(account:Account){
  const binding=account.raindrop;
  if(account.channelId!=='raindrop'||account.status!=='registered'||account.credentialKind!=='api_token'||!account.hasPassword||account.source!=='imported'||account.email!==''||binding?.version!==1)return false;
  if(account.username!==binding.ownerId||account.publicationUrl!==binding.publicUrl)return false;
  if(!positiveRemoteId(binding.ownerId)||!positiveRemoteId(binding.collectionId)||!fingerprintPattern.test(binding.tokenFingerprint)||!Number.isSafeInteger(binding.tokenVersion)||binding.tokenVersion<1||!Number.isFinite(Date.parse(binding.connectedAt)))return false;
  try{
    const url=new URL(binding.publicUrl);
    return url.protocol==='https:'
      &&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash
      &&url.pathname!=='/'&&/^[\x21-\x7e]+$/.test(url.pathname)
      &&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.raindrop\.page$/.test(url.hostname.toLowerCase());
  }catch{return false}
}

export function isHereNowConnectionAccount(account:Account){
  const binding=account.hereNow;
  return account.channelId==='here-now'&&account.status==='registered'&&account.credentialKind==='api_token'&&account.source==='imported'&&account.hasPassword&&!!binding&&binding.version===1&&binding.identity==='verified_personal'&&account.username===binding.accountId&&fingerprintPattern.test(binding.keyFingerprint)&&Number.isFinite(Date.parse(binding.checkedAt));
}

export function isShipPageConnectionAccount(account:Account){
  const proof=account.shipPage;
  return account.channelId==='shippage'&&account.email===''&&account.source==='generated'&&account.credentialKind==='api_token'&&account.status==='registered'&&account.hasPassword&&(account.registrationAttempts??0)===1&&proof?.version===1&&[proof.agentFingerprint,proof.keyFingerprint,proof.claimUrlHash,proof.registrationResponseHash].every(value=>fingerprintPattern.test(value))&&Number.isFinite(Date.parse(proof.registeredAt))&&new Date(proof.registeredAt).toISOString()===proof.registeredAt;
}

function positiveRemoteId(value:string){return /^[1-9][0-9]*$/.test(value)}

function usable(account:Account,id:ConnectionChannelId){
  if(id==='notebin')return validNotebinAccount(account);
  if(id==='markest')return isMarkestReadAccessAccount(account);
  if(id==='deno')return isDenoReadAccessAccount(account);
  if(id==='raindrop')return isRaindropConnectionAccount(account);
  if(id==='here-now')return isHereNowConnectionAccount(account);
  if(id==='shiply')return account.channelId==='shiply'&&account.credentialKind==='api_token'&&account.status==='registered'&&account.hasPassword&&account.shiply?.stage==='ready';
  if(id==='shippage')return isShipPageConnectionAccount(account);
  return account.status==='registered'&&account.hasPassword&&account.credentialKind===(id==='blogger'||id==='wordpress-com'?'oauth':'api_token');
}

export function connectionOverview(data:Pick<Snapshot,'accounts'|'accountBindings'|'sites'|'tasks'|'channels'>|null):ConnectionOverviewRow[]{
  if(!data)return [];
  return channels.map(({id,name,format,firstStep})=>{
    const accounts=['slugpost','docs-md','katbin','agentdrop','mdshare','totpage','mdview','txtsbs','nextgen-slides','pstrs','yourwebs','pastemyst','markdownpaste','html-app','memorywiki'].includes(id)?[]:data.accounts.filter(account=>account.channelId===id);
    const connected=accounts.filter(account=>usable(account,id));
    const connectedIds=new Set(connected.map(account=>account.id));
    const accountById=new Map(connected.map(account=>[account.id,account]));
    const excluded=(account:Account,siteId:string)=>
      (id==='mataroa'?account.mataroaExcludedSiteIds:id==='verbose'?account.verboseExcludedSiteIds:id==='rentry'?account.rentryExcludedSiteIds:undefined)?.includes(siteId)===true;
    const boundSiteIds=new Set(data.accountBindings.filter(binding=>{
      if(binding.channelId!==id||!connectedIds.has(binding.accountId))return false;
      const site=data.sites.find(candidate=>candidate.id===binding.siteId);
      if(!site)return false;
      if(excluded(accountById.get(binding.accountId)!,site.id))return false;
      if(id==='blogger')return !!site.blogger?.blogId;
      if(id==='paragraph')return !!site.paragraph?.publicationId&&site.paragraph.publicationId===accountById.get(binding.accountId)?.username;
      return true;
    }).map(binding=>binding.siteId));
    // firstLiveAt is historical evidence even if the latest check later changes to absent.
    const checkedCount=data.tasks.filter(task=>task.channelId===id&&(!!task.firstLiveAt||task.linkCheck==='found')).length;
    const issue=accounts.find(account=>!usable(account,id));
    const selectionRequired=['mataroa','verbose','rentry'].includes(id)&&connected.length>0&&data.sites.length>0&&!data.sites.some(site=>{
      const binding=data.accountBindings.find(item=>item.siteId===site.id&&item.channelId===id);
      if(binding){const account=accountById.get(binding.accountId);return !!account&&!excluded(account,site.id);}
      return connected.filter(account=>!excluded(account,site.id)).length===1;
    });
    const unbound=selectionRequired||needsBinding.has(id)&&connected.length>0&&data.sites.length>0&&boundSiteIds.size===0;
    let state:ConnectionState;
    let detail:string;
    if(id==='deno'){
      if(issue){state='attention';detail='本机 Deno 只读连接需重新验证；发布仍未启用。';}
      else if(connected.length){state='read_only';detail=`${connected.length} 个应用 UUID 已只读验证${boundSiteIds.size?`，${boundSiteIds.size} 个网站已关联`:''}；组织名称由你声明；发布未启用，待真实验收。`;}
      else {state='first_connection';detail=firstStep;}
    }else if(id==='markest'){
      if(issue){state='attention';detail='本机记录未通过 Markest 只读连接校验；请重新粘贴原个人 key，或新增另一把 key。发布仍未启用。';}
      else if(connected.length){state='read_only';detail=`${connected.length} 个个人 key 已通过列表读取${boundSiteIds.size?`，保留 ${boundSiteIds.size} 个网站关联`:''}；仅验证读取，发布未启用。邮箱和身份由你声明。`;}
      else {state='first_connection';detail=firstStep;}
    }else if(!data.channels.find(channel=>channel.id===id&&channel.enabled)){
      state='unavailable';detail=id==='prose'?'可只读验证本人专用 SSH/SFTP 身份；邀请与真实发布资格尚待验收，当前不会自动发布。':id==='leaflet'?'真实授权和公开全文发布尚待验收；当前不会自动发布。':id==='raindrop'?'可连接本人账号、专用公开合集与 Test token；首篇真实发布和匿名读回尚待验收，当前不会自动发布。':id==='wordpress-com'?'浏览器授权和真实公开发布尚待验收；原身份与历史记录保留。':id==='shiply'?'邮箱身份与静态全文 API 已准备离线实现；真实账号和发布验收前保持停用。':id==='shippage'?'首次发布自动建立的唯一平台账号与 API key 仅在本机加密保存并跨网站复用；每页固定 14 天到期。真实验收前保持停用，不注册、不发布、不续期。':id==='docs-md'?'无需注册账号；真实托管公开页验收完成前保持停用。':id==='html-app'?'无需账号；正式启用后须在首次提交前阅读公开内容提示与条款并确认，真实发布验收前保持停用。':id==='deed-page'?'免注册静态全文；首次发布会生成一次性所有者令牌并只在本机加密保存。渠道当前停用时不会自动发布。':id==='brewpage'?'免注册原创 Markdown；所有者令牌仅在本机加密保存并持续复用，页面最长 30 天。当前停用时不执行发布，原所有者与历史记录保留。':id==='pastemyst'?'免账号 Markdown 全文；原始创建响应加密保留，结果不明不会重发或猜测文章 ID。没有安全的匿名所有者修改、删除或列表找回；渠道当前停用时不会自动发布。':id==='markdownpaste'?'免账号 Markdown 全文；expires_in=0 只表示不主动过期。官方源码存在按 ID 无认证删除，客户端不会调用；渠道当前停用时不会自动发布。':id==='katbin'?'免账号 Markdown 全文；原始创建响应加密保留，结果不明不会重发或猜测文章 ID。渠道当前停用时不会自动发布。':id==='mdshare'?'免账号公开 Markdown；匿名写入由站点开关控制，API 原文与浏览器 JS 渲染正文均验收前保持停用。':id==='mdview'?'当前停用：实际匿名页的 robots meta 与 X-Robots-Tag 均为 noindex,nofollow；页面固定 30 天到期，无匿名编辑、删除或列表找回能力。原稿与回执保留，不重复投稿。':id==='txtsbs'?'无需账号；经官方公开表单发布静态 HTML 全文，管理密钥和原始回包仅在本机加密保存。渠道当前停用时不会自动发布，原稿和回执保留。':id==='markdrop'?'免注册 Markdown 全文；一次性编辑密钥仅在本机加密保存。渠道当前停用时不会自动发布。':id==='draftmark'?'免注册公开 Markdown 全文；逐文档凭据仅在本机加密保存。真实发布验收前保持停用。':id==='memorywiki'?'免注册公开 Markdown 全文；编辑令牌与原始回包只在本机加密保存。首篇真实发布与四个只读端点验收前保持停用。':'渠道当前停用，不参与自动任务；原身份与历史记录保留。';
    }else if(selfProvisioned.has(id)&&!issue&&!unbound&&(!['plopino','vibedrop','notebin','shippage'].includes(id)||!accounts.length)){state='no_setup';detail=firstStep;}
    else if(!accounts.length){state='first_connection';detail=firstStep;}
    else if(issue){
      state='attention';
      detail=id==='verbose'?'原身份或一次性令牌需检查；不能重新注册换号。':['mataroa','paper-wf'].includes(id)&&issue.status==='needs_verification'?'首次验证待完成；沿用下方原身份继续，勿重复注册。':`${accounts.length-connected.length} 个本机身份需检查凭据或状态。`;
    }else if(unbound){state='attention';detail=selectionRequired?'原身份已保留；请选择要使用的身份并关联网站后继续。':'身份已保存在本机，尚未关联可发布的网站。';}
    else {state='connected';detail=`${connected.length} 个本机身份已连接${needsBinding.has(id)?`，${boundSiteIds.size} 个网站已关联`:''}。`;}
    return {id,name,format,state,detail,connectedCount:connected.length,boundSiteCount:boundSiteIds.size,checkedCount,attentionAccountId:issue?.id??(unbound||['here-now','shiply','plopino','shippage'].includes(id)&&connected.length===1?connected[0]?.id:undefined)};
  });
}
