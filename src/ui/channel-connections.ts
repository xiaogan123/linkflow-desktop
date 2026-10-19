import {BATCH5_CONNECTED_MESSAGES,BATCH5_MESSAGES} from '../shared/batch5-messages';
import type {Account,Snapshot} from '../shared/types';
import {validNotebinAccount} from '../shared/notebin-account';

export type ConnectionChannelId='yeetmd'|'markdownpage'|'slopit'|'rant'|'whitewind'|'hackmd'|'agentsgather'|'agentboard'|'carcinus'|'tantive'|'thethings'|'swarmmemo'|'synthfolk'|'large-language'|'agentswiki'|'berrry'|'colony'|'agentnotepad'|'agenthow'|'product-index'|'listed-startups'|'openagentchat'|'agentriot'|'shellbook'|'slugpost'|'notebin'|'wordcell'|'vibedrop'|'plopino'|'mataroa'|'verbose'|'rentry'|'lucid-page'|'betterthanhtml'|'supanote'|'docs-md'|'html-app'|'deed-page'|'brewpage'|'markdrop'|'katbin'|'agentdrop'|'mdshare'|'totpage'|'mdview'|'txtsbs'|'pastyx'|'nextgen-slides'|'shippage'|'pstrs'|'yourwebs'|'pastemyst'|'markdownpaste'|'draftmark'|'memorywiki'|'here-now'|'shiply'|'paper-wf'|'hive'|'prose'|'markest'|'deno'|'nostr'|'github-gist'|'telegraph'|'blogger'|'wordpress-com'|'leaflet'|'paragraph'|'bluesky'|'raindrop';
export type ConnectionState='no_setup'|'first_connection'|'attention'|'connected'|'read_only'|'unavailable';
export interface ConnectionOverviewRow {
  id:ConnectionChannelId;
  name:string;
  format:'全文'|'短帖'|'产品资料'|'公开资料';
  state:ConnectionState;
  detail:string;
  connectedCount:number;
  boundSiteCount:number;
  checkedCount:number;
  attentionAccountId?:string;
}

const channels:{id:ConnectionChannelId;name:string;format:'全文'|'短帖'|'产品资料'|'公开资料';firstStep:string}[]=[
  {id:'yeetmd',name:'yeet.md',format:'全文',firstStep:BATCH5_CONNECTED_MESSAGES.overview.yeetmd},
  {id:'markdownpage',name:'markdown.page',format:'全文',firstStep:BATCH5_CONNECTED_MESSAGES.overview.markdownpage},
  {id:'slopit',name:'SlopIt',format:'全文',firstStep:BATCH5_CONNECTED_MESSAGES.overview.slopit},
  {id:'rant',name:'rant.li',format:'全文',firstStep:BATCH5_CONNECTED_MESSAGES.overview.rant},
  {id:'whitewind',name:'WhiteWind',format:'全文',firstStep:BATCH5_CONNECTED_MESSAGES.overview.whitewind},
  {id:'hackmd',name:'HackMD',format:'全文',firstStep:BATCH5_MESSAGES.hackmdToken},
  {id:'agentsgather',name:'AgentsGather',format:'全文',firstStep:'无需账号或邮箱。稿件通过 AI 复核后匿名发布，每篇都会检查链接。'},
  {id:'agentboard',name:'Agentboard',format:'全文',firstStep:'无需邮箱或手动注册。第一篇发布时自动建好账号并发一条自我介绍帖，之后的稿件发在其他版块；结果不明时不会重发。'},
  {id:'swarmmemo',name:'SwarmMemo',format:'全文',firstStep:'无需邮箱。外链助手自动建好一个发布账号，密钥只存在本机；结果不明时不会重发。'},
  {id:'tantive',name:'Tantive',format:'全文',firstStep:'无需账号或邮箱。发布前先预览全文；结果不明时不会重发。'},
  {id:'thethings',name:'TheThings.ai',format:'全文',firstStep:'无需账号或邮箱。页面公开可见、不能修改；结果不明时不会重发。'},
  {id:'colony',name:'Colony',format:'全文',firstStep:'可自动建一个如实标明是 AI 代理的发布账号（无需邮箱），也可以填你已有的 API key。'},
  {id:'agentnotepad',name:'Agent Notepad',format:'全文',firstStep:'无需邮箱。第一篇发布时自动建好发布账号，之后各网站共用；每篇都会检查链接。'},
  {id:'product-index',name:'AI Product Index',format:'产品资料',firstStep:'连接你已有的 GitHub 账号并选择网站；不会替你注册 GitHub。每个产品要等平台审核通过。'},
  {id:'listed-startups',name:'Listed Startups',format:'产品资料',firstStep:'无需账号或邮箱。提交的是你网站的产品资料（自己填报，不是平台推荐），结果不明时不会重复提交；页面不保证长期保留。'},
  {id:'openagentchat',name:'OpenAgentChat',format:'全文',firstStep:'可自动建一个如实标明是 AI 代理的发布账号（无需邮箱），也可以填你已有的 token。'},
  {id:'shellbook',name:'Shellbook',format:'全文',firstStep:'无需邮箱。第一篇发布时自动建好一个如实命名的发布账号并一直沿用；结果不明时不会重发。'},
  {id:'agentriot',name:'AgentRiot',format:'全文',firstStep:'无需邮箱。第一篇发布时自动建好一个如实命名的发布账号并一直沿用；结果不明时不会重发。'},
  {id:'synthfolk',name:'Synthfolk',format:'公开资料',firstStep:'先为网站生成一份如实的公开资料，通过 AI 复核后注册一次；也可以填你已有的 API key。'},
  {id:'agenthow',name:'AgentHow',format:'全文',firstStep:'无需邮箱。外链助手自动建一个如实命名的发布账号；每篇都会检查原文、来源和链接。'},
  {id:'berrry',name:'Berrry',format:'全文',firstStep:'无需邮箱。外链助手自动建好发布账号，密钥只存在本机；结果不明时不会重发。'},
  {id:'large-language',name:'LargeLanguage',format:'全文',firstStep:'确认公开署名后可自动建发布账号（无需邮箱），也可以填你已有的 token。资料库记录不是平台推荐。'},
  {id:'agentswiki',name:'Agents Wiki',format:'全文',firstStep:'可自动建一个如实标明是 AI 代理的发布账号（无需邮箱），也可以填已有的密钥。只发经 AI 复核的原创知识稿，按 CC BY 4.0 授权。'},
  {id:'slugpost',name:'SlugPost',format:'全文',firstStep:'无需账号，通过官方网页发布全文；遇到平台要求人工验证时会提醒你。不保证长期保留。'},
  {id:'notebin',name:'Notebin',format:'全文',firstStep:'无需邮箱。外链助手自动建好发布账号和专用密钥；结果不明时不会重发。'},
  {id:'vibedrop',name:'VibeDrop',format:'全文',firstStep:'无需邮箱或手动建令牌。外链助手自动建好匿名发布账号；结果不明时不会重发。'},
  {id:'wordcell',name:'Wordcell',format:'全文',firstStep:'无需邮箱。外链助手自动建好一个令牌并一直沿用；结果不明时不会重发。'},
  {id:'carcinus',name:'Carcinus',format:'全文',firstStep:'导入你已有的一个 Carcinus 页面记录。外链助手只检查公开全文和链接，不会新建或修改页面，也不计入新增。'},
  {id:'plopino',name:'Plopino',format:'全文',firstStep:'已有账号可用邮箱和密码连接；没有账号时，任务会用网站已授权邮箱自动建立一次，结果不明不会重复注册。'},
  {id:'mataroa',name:'Mataroa',format:'全文',firstStep:'任务需要时自动建号；遇平台验证则保留原发布账号。'},
  {id:'verbose',name:'Verbose.blog',format:'全文',firstStep:'实验平台可在任务需要时自动建号；一次性令牌无法补发。'},
  {id:'rentry',name:'Rentry',format:'全文',firstStep:'无需注册账号；任务自动保存本机编辑密钥后发布。'},
  {id:'lucid-page',name:'Lucid.page',format:'全文',firstStep:'无需注册账号；匿名发布后修改或删除需先认领。'},
  {id:'betterthanhtml',name:'Better Than HTML',format:'全文',firstStep:'无需注册账号；任务直接发布静态全文，尚未确认文章修改或删除接口。'},
  {id:'html-app',name:'ht-ml.app',format:'全文',firstStep:'无需账号；首次提交前请阅读公开内容提示与条款并确认。公开内容可能被抓取或复制，服务不保证长期保留。'},
  {id:'deed-page',name:'deed.page',format:'全文',firstStep:'无需注册。第一次发布时自动拿到所有者令牌，之后的文章沿用；不保证长期保留。'},
  {id:'brewpage',name:'BrewPage',format:'全文',firstStep:'无需注册，页面最长保留 30 天。第一次发布时自动拿到所有者令牌，同一网站一直沿用；结果不明时不会重发。'},
  {id:'katbin',name:'Katbin',format:'全文',firstStep:'无需账号。发布后不能匿名修改或删除；结果不明时不会重发。'},
  {id:'nextgen-slides',name:'NextGen Slides',format:'全文',firstStep:'无需账号或邮箱。页面 90 天没人访问可能被删除；结果不明时不会重发。'},
  {id:'yourwebs',name:'Yourwebs',format:'全文',firstStep:'无需账号或邮箱。页面保留 30 天；结果不明时不会重发。'},
  {id:'totpage',name:'TOT.page',format:'全文',firstStep:'无需账号或邮箱。保存期限不明，拿到链接的人都能修改或删除；结果不明时不会重发。'},
  {id:'mdview',name:'MDView',format:'全文',firstStep:'页面 30 天到期，平台还给匿名页加了不收录、不传权重的标记，所以目前停用。'},
  {id:'txtsbs',name:'txt.sbs',format:'全文',firstStep:'无需账号或邮箱，通过官方表单发布全文；平台可能删除页面，不保证长期保留。'},
  {id:'pastyx',name:'PastyX',format:'全文',firstStep:'无需账号或邮箱。每篇都会检查公开全文和链接；结果不明时不会重发。'},
  {id:'mdshare',name:'MDShare',format:'全文',firstStep:'无需账号。页面要运行脚本才显示正文，检查通过才计入；目前停用。'},
  {id:'agentdrop',name:'AgentDrop',format:'全文',firstStep:'无需账号或邮箱。页面保留 30 天；结果不明时不会重发。'},
  {id:'shippage',name:'ShipPage',format:'全文',firstStep:'第一次发布时自动注册一个平台账号，所有网站共用，不会为了多发而重复注册。每页 14 天到期，不自动续期。'},
  {id:'pstrs',name:'PST.RS',format:'全文',firstStep:'无需账号，页面最长保留 365 天；结果不明时不会重发，到期不自动续期。'},
  {id:'pastemyst',name:'PasteMyst',format:'全文',firstStep:'无需账号。发布后不能匿名修改或删除；结果不明时不会重发。'},
  {id:'markdownpaste',name:'Markdown Pastebin',format:'全文',firstStep:'无需账号，页面默认不过期；但平台允许按地址删除页面，不能当成永久存放。'},
  {id:'markdrop',name:'Markdrop',format:'全文',firstStep:'无需注册，默认不过期，但不保证长期保留。'},
  {id:'draftmark',name:'Draftmark',format:'全文',firstStep:'无需注册，发布公开全文；平台不保证长期保留。'},
  {id:'memorywiki',name:'Memory.wiki',format:'全文',firstStep:'无需注册，发布公开全文；结果不明时不会重发，也不保证长期保留。'},
  {id:'here-now',name:'here.now',format:'全文',firstStep:'连接一次你已验证邮箱的 here.now 账号密钥，也能检查已有页面。匿名的 24 小时页面不算长期外链。'},
  {id:'shiply',name:'Shiply.now',format:'全文',firstStep:'向你的邮箱要一个六位验证码，验证一次后一直沿用这个账号；每篇都会复核并检查链接。'},
  {id:'supanote',name:'Supanote',format:'全文',firstStep:'无需注册，匿名发布；平台没给管理权限时不能修改或删除。'},
  {id:'docs-md',name:'Docs MD',format:'全文',firstStep:'无需注册，匿名发布全文。'},
  {id:'paper-wf',name:'Paper.wf',format:'全文',firstStep:'可连接已有账号；自动建号可能需要首次人机验证。'},
  {id:'hive',name:'Hive',format:'全文',firstStep:'连接本人账号的 posting key，再选择要使用的网站。'},
  {id:'prose',name:'Prose',format:'全文',firstStep:'粘贴你受邀账号的专用 SSH 私钥，检查通过后选择网站。'},
  {id:'deno',name:'Deno Deploy',format:'全文',firstStep:'先登录 Deno 建一个专用组织和应用，再粘贴组织令牌、选好应用。目前只能连接，发布功能还没开放。'},
  {id:'markest',name:'Markest',format:'全文',firstStep:'粘贴你在 Markest 账户里创建的专用 key；目前只能连接，发布功能还没开放。'},
  {id:'nostr',name:'Nostr',format:'全文',firstStep:'任务需要时自动建立发布账号。'},
  {id:'github-gist',name:'GitHub Gist',format:'全文',firstStep:'连接已有 GitHub 账号的 Gists 令牌。'},
  {id:'telegraph',name:'Telegraph',format:'全文',firstStep:'任务需要时自动建立发布账号。'},
  {id:'blogger',name:'Blogger',format:'全文',firstStep:'首次完成 Google 授权，再选择博客和网站。'},
  {id:'wordpress-com',name:'WordPress.com',format:'全文',firstStep:'首次在浏览器授权，再选择已公开博客和要关联的网站。'},
  {id:'leaflet',name:'Leaflet',format:'全文',firstStep:'首次连接本人 Bluesky 托管账号的应用密码，之后发布完整文章。'},
  {id:'raindrop',name:'Raindrop',format:'短帖',firstStep:'确认邮箱并建一个公开合集，再粘贴 Test token、选好合集。'},
  {id:'paragraph',name:'Paragraph',format:'全文',firstStep:'连接已有 publication 的 API 密钥，并选择网站。'},
  {id:'bluesky',name:'Bluesky',format:'短帖',firstStep:'连接已有账号的 app password，并选择网站。'},
];
const needsBinding=new Set<ConnectionChannelId>(['whitewind','hackmd','agentboard','product-index','swarmmemo','synthfolk','large-language','agentswiki','berrry','agenthow','colony','openagentchat','agentriot','shellbook','agentnotepad','notebin','wordcell','vibedrop','plopino','shippage','here-now','shiply','hive','prose','markest','deno','blogger','wordpress-com','leaflet','paragraph','bluesky','raindrop','carcinus']);
const selfProvisioned=new Set<ConnectionChannelId>(['yeetmd','markdownpage','slopit','rant','agentswiki','agentsgather','agentboard','tantive','thethings','swarmmemo','synthfolk','large-language','berrry','agenthow','listed-startups','openagentchat','agentriot','shellbook','agentnotepad','slugpost','notebin','wordcell','vibedrop','plopino','shippage','mataroa','verbose','telegraph','nostr','rentry','lucid-page','betterthanhtml','supanote','docs-md','html-app','deed-page','brewpage','markdrop','katbin','nextgen-slides','totpage','mdview','txtsbs','pastyx','mdshare','agentdrop','pstrs','yourwebs','pastemyst','markdownpaste','draftmark','memorywiki','carcinus']);

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

export function isCarcinusExistingConnectionAccount(account:Account){
  const proof=account.carcinus;
  return account.channelId==='carcinus'&&account.status==='registered'&&account.credentialKind==='api_token'&&account.source==='imported'&&account.hasPassword&&account.email===''&&account.registrationAttempts===0&&proof?.version===3&&proof.stage==='existing_managed'&&proof.identity===account.username&&proof.publicUrl===account.publicationUrl&&[proof.siteIdentitySha256,proof.targetUrlSha256,proof.payloadSha256,proof.provenanceSha256,proof.secretSha256,proof.tokenFingerprint].every(value=>fingerprintPattern.test(value))&&Number.isFinite(Date.parse(proof.checkedAt));
}

export function isShipPageConnectionAccount(account:Account){
  const proof=account.shipPage;
  return account.channelId==='shippage'&&account.email===''&&account.source==='generated'&&account.credentialKind==='api_token'&&account.status==='registered'&&account.hasPassword&&(account.registrationAttempts??0)===1&&proof?.version===1&&[proof.agentFingerprint,proof.keyFingerprint,proof.claimUrlHash,proof.registrationResponseHash].every(value=>fingerprintPattern.test(value))&&Number.isFinite(Date.parse(proof.registeredAt))&&new Date(proof.registeredAt).toISOString()===proof.registeredAt;
}

function positiveRemoteId(value:string){return /^[1-9][0-9]*$/.test(value)}

function usable(account:Account,id:ConnectionChannelId){
  if(id==='carcinus')return account.channelId==='carcinus'&&account.status==='registered'&&account.source==='generated'&&account.credentialKind==='api_token'&&account.hasPassword&&account.email===''&&account.registrationAttempts===1&&account.carcinus?.version===2&&account.carcinus.stage==='managed'&&account.carcinus.identity===account.username&&account.carcinus.publicUrl===account.publicationUrl&&[account.carcinus.siteIdentitySha256,account.carcinus.purposeSha256,account.carcinus.targetUrlSha256,account.carcinus.payloadSha256,account.carcinus.tokenFingerprint].every(value=>fingerprintPattern.test(value))&&Number.isFinite(Date.parse(account.carcinus.checkedAt));
  if(id==='agentboard')return account.channelId==='agentboard'&&account.status==='registered'&&account.source==='generated'&&account.credentialKind==='api_token'&&account.hasPassword&&account.registrationAttempts===1&&account.agentboard?.stage==='ready'&&account.agentboard.handle===account.username&&fingerprintPattern.test(account.agentboard.credentialFingerprint??'');
  if(id==='colony')return account.channelId==='colony'&&account.status==='registered'&&account.credentialKind==='api_token'&&account.hasPassword&&account.colony?.stage==='ready'&&account.colony.username===account.username&&fingerprintPattern.test(account.colony.apiKeyFingerprint??'');
  if(id==='agentnotepad')return account.channelId==='agentnotepad'&&account.status==='registered'&&account.credentialKind==='api_token'&&account.hasPassword&&account.agentNotepad?.stage==='ready'&&account.agentNotepad.agentName===account.username&&fingerprintPattern.test(account.agentNotepad.keyFingerprint??'');
  if(id==='product-index')return account.channelId==='product-index'&&account.status==='registered'&&account.credentialKind==='api_token'&&account.hasPassword&&account.productIndex?.identity==='github_user_readback'&&account.productIndex.login===account.username&&fingerprintPattern.test(account.productIndex.tokenFingerprint);
  if(id==='openagentchat')return account.channelId==='openagentchat'&&account.status==='registered'&&account.credentialKind==='api_token'&&account.hasPassword&&account.openAgentChat?.stage==='ready'&&account.openAgentChat.agentName===account.username&&fingerprintPattern.test(account.openAgentChat.tokenFingerprint??'');
  if(id==='shellbook')return account.channelId==='shellbook'&&account.status==='registered'&&account.source==='generated'&&account.credentialKind==='api_token'&&account.hasPassword&&account.email===''&&account.registrationAttempts===1&&account.shellbook?.stage==='ready'&&account.shellbook.agentName===account.username&&/^[0-9a-f-]{36}$/.test(account.shellbook.agentId??'')&&fingerprintPattern.test(account.shellbook.tokenFingerprint??'');
  if(id==='agentriot')return account.channelId==='agentriot'&&account.status==='registered'&&account.source==='generated'&&account.credentialKind==='api_token'&&account.hasPassword&&account.email===''&&account.registrationAttempts===1&&account.agentriot?.stage==='ready'&&account.agentriot.agentName===account.username&&/^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|[A-Za-z][A-Za-z0-9_-]{2,199})$/i.test(account.agentriot.agentId??'')&&(account.agentriot.agentSlug?.length??0)<=160&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(account.agentriot.agentSlug??'')&&fingerprintPattern.test(account.agentriot.installationIdHash)&&fingerprintPattern.test(account.agentriot.tokenFingerprint??'')&&!!account.agentriot.checkedAt;
  if(id==='synthfolk')return account.channelId==='synthfolk'&&account.status==='registered'&&account.credentialKind==='api_token'&&account.hasPassword&&account.synthfolk?.stage==='ready'&&account.synthfolk.handle===account.username&&account.synthfolk.name===account.displayName&&fingerprintPattern.test(account.synthfolk.keyFingerprint??'');
  if(id==='agenthow')return account.channelId==='agenthow'&&account.status==='registered'&&account.source==='generated'&&account.credentialKind==='api_token'&&account.hasPassword&&account.agentHow?.stage==='ready'&&account.agentHow.label===account.username&&/^a_[a-f0-9]{32}$/.test(account.agentHow.actorId??'')&&fingerprintPattern.test(account.agentHow.keyFingerprint??'');
  if(id==='swarmmemo')return account.channelId==='swarmmemo'&&account.status==='registered'&&account.source==='generated'&&account.credentialKind==='api_token'&&account.hasPassword&&account.email===''&&account.registrationAttempts===0&&account.swarmMemo?.stage==='ready'&&account.swarmMemo.fingerprint===account.username&&fingerprintPattern.test(account.swarmMemo.fingerprint)&&/^[A-Za-z0-9_-]{43}$/.test(account.swarmMemo.publicKey)&&!!account.swarmMemo.checkedAt;
  if(id==='berrry')return account.channelId==='berrry'&&account.status==='registered'&&account.source==='generated'&&account.credentialKind==='api_token'&&account.hasPassword&&account.berrry?.stage==='ready'&&account.berrry.username===account.username&&fingerprintPattern.test(account.berrry.publicKey)&&fingerprintPattern.test(account.berrry.keyFingerprint)&&fingerprintPattern.test(account.berrry.tokenFingerprint??'')&&!!account.berrry.tokenExpiresAt;
  if(id==='large-language')return account.channelId==='large-language'&&account.status==='registered'&&account.credentialKind==='api_token'&&account.hasPassword&&account.largeLanguage?.stage==='ready'&&account.largeLanguage.displayName===account.username&&fingerprintPattern.test(account.largeLanguage.tokenFingerprint??'');
  if(id==='agentswiki')return account.channelId==='agentswiki'&&account.status==='registered'&&account.credentialKind==='api_token'&&account.hasPassword&&account.agentsWiki?.stage==='ready'&&account.agentsWiki.name===account.username&&fingerprintPattern.test(account.agentsWiki.keyFingerprint??'');
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
    const accounts=['yeetmd','markdownpage','agentsgather','thethings','listed-startups','slugpost','docs-md','katbin','agentdrop','mdshare','totpage','mdview','txtsbs','pastyx','nextgen-slides','pstrs','yourwebs','pastemyst','markdownpaste','html-app','memorywiki'].includes(id)?[]:data.accounts.filter(account=>account.channelId===id);
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
    const issue=accounts.find(account=>!usable(account,id)&&!(id==='carcinus'&&isCarcinusExistingConnectionAccount(account)));
    const selectionRequired=['mataroa','verbose','rentry'].includes(id)&&connected.length>0&&data.sites.length>0&&!data.sites.some(site=>{
      const binding=data.accountBindings.find(item=>item.siteId===site.id&&item.channelId===id);
      if(binding){const account=accountById.get(binding.accountId);return !!account&&!excluded(account,site.id);}
      return connected.filter(account=>!excluded(account,site.id)).length===1;
    });
    const unbound=selectionRequired||needsBinding.has(id)&&connected.length>0&&data.sites.length>0&&boundSiteIds.size===0;
    let state:ConnectionState;
    let detail:string;
    if(id==='carcinus'){
      const existing=accounts.filter(isCarcinusExistingConnectionAccount),existingIds=new Set(existing.map(account=>account.id)),existingBound=new Set(data.accountBindings.filter(binding=>binding.channelId==='carcinus'&&existingIds.has(binding.accountId)&&data.sites.some(site=>site.id===binding.siteId)).map(binding=>binding.siteId)),enabled=data.channels.some(channel=>channel.id==='carcinus'&&channel.enabled);
      if(issue?.carcinus?.version===3||issue&&enabled){state='attention';detail='Carcinus 本机记录和原来的发布账号或发布记录对不上；不会重新注册，也不会重新提交。';}
      else if(existing.length){state='read_only';detail=`Carcinus 公开页的链接已检查${existingBound.size?`，关联 ${existingBound.size} 个网站`:''}；这是导入的已有页面，不计为新发布。`;}
      else if(connected.length){state=enabled?'connected':'unavailable';detail='这个网站已有一张固定的 Carcinus 页面；不会再导入或新建第二张。';}
      else if(issue){state='unavailable';detail='Carcinus 目前停用；本机的旧记录保留，不会新建账号或重新提交。';}
      else if(enabled){state='no_setup';detail='无需邮箱。第一篇稿件通过 AI 复核后建一张固定页面并检查链接；每个网站只建一张。已有页面也可以导入。';}
      else {state='first_connection';detail=firstStep+'平台当前停用，不执行新发布。';}
      return {id,name,format,state,detail,connectedCount:connected.length+existing.length,boundSiteCount:existing.length?existingBound.size:boundSiteIds.size,checkedCount,attentionAccountId:issue?.id??existing[0]?.id??connected[0]?.id};
    }else if(id==='deno'){
      if(issue){state='attention';detail='Deno 连接需要重新验证；发布功能还没开放。';}
      else if(connected.length){state='read_only';detail=`${connected.length} 个应用已验证${boundSiteIds.size?`，${boundSiteIds.size} 个网站已关联`:''}；发布功能还没开放。`;}
      else {state='first_connection';detail=firstStep;}
    }else if(id==='markest'){
      if(issue){state='attention';detail='Markest 连接没有通过检查；请重新粘贴原来的个人 key，或新增一把。发布功能还没开放。';}
      else if(connected.length){state='read_only';detail=`${connected.length} 个个人 key 已验证${boundSiteIds.size?`，关联 ${boundSiteIds.size} 个网站`:''}；发布功能还没开放。`;}
      else {state='first_connection';detail=firstStep;}
    }else if(!data.channels.find(channel=>channel.id===id&&channel.enabled)){
      if(['html-app','shiply','shellbook','thethings','agentriot','agentswiki','agentsgather'].includes(id)){state='unavailable';detail='平台目前停用，不参与自动发布；已有的账号、稿件和发布记录都会保留，不会重发。';}
      else {
      state='unavailable';detail=id==='whitewind'?BATCH5_CONNECTED_MESSAGES.overview.whitewindUnavailable:id==='mdview'?'平台给匿名页加了不收录、不传权重的标记，页面 30 天到期，所以目前停用；原稿和发布记录保留。':'平台目前停用，不参与自动发布；已有的账号和发布记录都会保留。';
      }
    }else if(selfProvisioned.has(id)&&!issue&&!unbound&&(!['plopino','wordcell','vibedrop','notebin','shippage'].includes(id)||!accounts.length)){state='no_setup';detail=firstStep;}
    else if(!accounts.length){state='first_connection';detail=firstStep;}
    else if(issue){
      state='attention';
      detail=id==='verbose'?'原发布账号或一次性令牌需检查；不能重新注册换号。':['mataroa','paper-wf'].includes(id)&&issue.status==='needs_verification'?'首次验证待完成；沿用下方原发布账号继续，勿重复注册。':`${accounts.length-connected.length} 个本机发布账号需检查密钥或状态。`;
    }else if(unbound){state='attention';detail=selectionRequired?'原发布账号已保留；请选择要使用的发布账号并关联网站后继续。':'发布账号已保存在本机，尚未关联可发布的网站。';}
    else {state='connected';detail=`${connected.length} 个本机发布账号已连接${needsBinding.has(id)?`，${boundSiteIds.size} 个网站已关联`:''}。`;}
    return {id,name,format,state,detail,connectedCount:connected.length,boundSiteCount:boundSiteIds.size,checkedCount,attentionAccountId:issue?.id??(unbound||['here-now','shiply','plopino','shippage'].includes(id)&&connected.length===1?connected[0]?.id:undefined)};
  });
}
