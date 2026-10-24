import {channelAudience} from '../integrations/eligibility';
import {BATCH5_MESSAGES} from '../shared/batch5-messages';
import type {Category,Channel} from '../shared/types';
import type {ChannelDiscovery} from '../integrations/channel-discovery';
import type {ChannelReadiness} from './presentation';

export type ChannelAutomationKind='ai_auto'|'connected_auto'|'registration_pending'|'profile'|'manual'|'disabled';
export type ChannelAutomationFilter='all'|Exclude<ChannelAutomationKind,'disabled'>;

const automaticIdentity=new Set(['yeetmd','markdownpage','slopit','rant','agentsgather','agentboard','synthfolk','thethings','swarmmemo','tantive','notebin','wordcell','vibedrop','plopino','telegraph','nostr','mataroa','verbose','rentry','lucid-page','betterthanhtml','supanote','docs-md','html-app','deed-page','brewpage','markdrop','katbin','nextgen-slides','totpage','mdview','txtsbs','pastyx','mdshare','agentdrop','shippage','pstrs','yourwebs','pastemyst','markdownpaste','draftmark','memorywiki','agenthow','agentnotepad','openagentchat','agentriot','shellbook','large-language','agentswiki','listed-startups','carcinus']);
const connectedIdentity=new Set(['whitewind','hackmd','here-now','shiply','beacon','gitbook','valtown','bitbucket','github-gist','blogger','wordpress-com','leaflet','paragraph','hive','bluesky','raindrop','product-index']);

export function channelAutomationKind(channel:Channel):ChannelAutomationKind{
  if(!channel.enabled)return 'disabled';
  if(channel.id==='slugpost'&&channel.domain==='slugpost.com'&&channel.provenance==='built-in'&&channel.automation==='browser'&&channel.kind==='article'&&channel.articleRequired&&!channel.accountRequired&&!channel.emailRequired)return 'ai_auto';
  if(channel.automation==='browser')return 'profile';
  if(channel.automation!=='api'||channel.provenance==='custom')return 'manual';
  if(channel.id==='chatclaw'&&channel.domain==='chatclaw.com'&&channel.kind==='community'&&channel.contentFormat==='social'&&!channel.accountRequired&&!channel.emailRequired)return 'ai_auto';
  if(channel.id==='paper-wf'&&channel.contentFormat!=='social')return 'registration_pending';
  if(automaticIdentity.has(channel.id)&&channel.contentFormat!=='social')return 'ai_auto';
  if(connectedIdentity.has(channel.id)&&(['bluesky','raindrop'].includes(channel.id))===(channel.contentFormat==='social'))return 'connected_auto';
  return 'manual';
}

export function channelMatchesAutomation(channel:Channel,filter:ChannelAutomationFilter,freeOnly=false,category:'all'|Category='all'){
  const kind=channelAutomationKind(channel);
  const categoryMatches=category==='all'||(category==='finance'?channelAudience(channel).some(value=>value==='general'||value==='finance')&&channel.promotionPolicy!=='forbidden':channel.categories.includes(category)||channel.categories.includes('general'));
  return (filter==='all'||kind===filter)&&(!freeOnly||channel.free==='yes')&&categoryMatches;
}

const setupById:Record<string,string>={
  beacon:'关联已授权且测试通过的收信邮箱后，自动读取可信验证码并复用同一账号；只发布通过稿件检查的原创软件文档，使用无计划到期的账号页面。结果不明保留原稿并只读对账，不重新注册或重发',
  yeetmd:BATCH5_MESSAGES.directSetup,markdownpage:BATCH5_MESSAGES.immutableSetup,slopit:BATCH5_MESSAGES.accountSetup,rant:BATCH5_MESSAGES.accountSetup,whitewind:BATCH5_MESSAGES.connectedSetup,hackmd:BATCH5_MESSAGES.connectedSetup,
  agentboard:'首个获准任务用一次原子 POST 建立并复用无邮箱 agent，同时发布该项目唯一 introductions 主帖；credential、发布账号和回执加密保存，未知结果不重发、不换号或主页；后续仅发布 AI 复核的非 introductions 技术讨论',
  chatclaw:'首次任务自动建立并复用一个如实命名的无邮箱 agent；密钥、提交意图与原始响应只在本机加密保存。短帖须保持 40–280 字并通过 AI 复核；结果不明只读对账、不重发，不保证搜索收录或长期保留',
  agentsgather:'免账号匿名发布；最终原稿、唯一目标、真实操作者关系披露与 AI 复核记录核对一致后，POST 前加密保存单次 request_id。已完成真实发布与公开页验收，后续每篇仍须 AI 复核和检查链接',
  swarmmemo:'本机自动建立并复用签名发布账号，无需邮箱或钱包；已完成真实发布与公开页验收，结果不明只读核对原页面、不重发；不保证永久保留',
  tantive:'免账号按固定官方 API 逐字预览并发布；临时票据和原始响应只在本机加密保存，结果不明时只按原 request ID 只读核对；后续每篇仍须 AI 复核和检查链接',
  thethings:'免账号通过官方 scratch API 单次发布完整 HTML；页面公开可发现且不可编辑，claim_url 与原始回包只在本机加密保存，任何未知结果都不重发；已完成真实发布与公开页验收，后续每篇仍须 AI 复核和检查链接',
  slugpost:'免账号经官方网页发布原创全文；稿件须通过审核，遇本人验证则保留原任务；固定地址和编辑密钥加密保存，结果不明不重发。没有长期保留保证',
  notebin:'任务按官方协议完成一次有界 PoW 发布账号创建并铸造最小权限专用密钥；结果不明时只读对账，不重建发布账号或重发',
  vibedrop:'任务仅创建一次匿名密钥并加密保存；结果不明时只读对账，不重建密钥或站点',
  wordcell:'首次任务仅创建一次固定托管令牌并加密保存；已完成真实令牌建立与公开页验收，结果不明时只读查询同一 operation，不重复 PUT 或新建 slug；不保证永久保留',
  carcinus:'只允许一个稳定 human-operated identity 和一张经审核的公开页；一次性 write token 仅在本机加密保存。结果不明只核对固定 restore 与公开页，不重发、不换 identity；丢 token 的已公开页明确记作 live_unmanaged',
  plopino:'任务使用网站已授权邮箱自动建立并复用账号；已有账号可直接连接，结果不明不会重复注册；无需手工创建 密钥',
  'here-now':'关联已测试通过的收信邮箱后，到期任务自动完成可信邮件验证并保存命名密钥；其他邮件须确认。关联网站后按审核与排期发布。已有密钥可直接连接，自动收码失败时保留原账号',
  shiply:'关联已测试通过的收信邮箱后，到期任务自动请求并读取验证码，可信邮件自动验证，其他邮件须确认；连接或复用同一邮箱账号，密钥加密保存，后续每篇仍须审核和检查链接',
  telegraph:'自动创建发布账号，无需首次连接',
  nostr:'在本机建立发布账号，无需首次连接',
  mataroa:'自动建立作者账号；若平台要求验证则等待处理',
  verbose:'自动建立发布账号，无需首次连接；实验平台，一次性令牌不可补发',
  rentry:'免账号发布；编辑密钥自动加密保存在本机',
  'lucid-page':'免账号发布公开全文；匿名发布后修改或删除需先认领',
  betterthanhtml:'免账号发布静态全文；尚未确认文章修改或删除接口',
  supanote:'免账号匿名发布 Markdown；管理令牌仅在平台返回时加密保存，不承诺可编辑或删除',
  'html-app':'免账号公开静态全文；已完成真实发布验收；免费 best-effort 服务不保证保留，后续每篇仍须审核和检查链接',
  'deed-page':'免注册发布静态全文；首次发布加密保存一次性所有者令牌，后续文章复用同一令牌；默认不设到期时间，但服务不保证长期可用或保留',
  brewpage:'免注册发布原创 Markdown 全文；首次任务获取并加密保存一个可复用所有者令牌，同一网站只复用这一发布账号。页面最长 30 天，未知结果只读对账且不重发',
  katbin:'免账号发布完整 Markdown；原始响应加密留存，未知结果不重发；没有匿名编辑、删除或列表找回，不保证长期保存或搜索收录',
  'nextgen-slides':'免账号发布静态全文；匿名页面在 90 天未访问后可能删除，原始响应加密留存，未知结果不重发或续期；公开页验收后才计入',
  yourwebs:'免账号发布静态全文；匿名页面保留 30 天，原始响应加密留存，未知结果不重发或续期；公开页验收后才计入',
  'totpage':'免账号发布静态全文；开放页面的保存期限未知，持公开链接者可修改或删除，原始响应加密留存，未知结果不重发或续期；公开页验收后才计入',
  mdview:'当前停用：实际匿名页声明 noindex,nofollow，不计入已验收外链平台；固定 30 天到期，原稿与回执保留，不重复投稿',
  txtsbs:'免账号通过官方公开表单发布静态 HTML 全文；逐篇管理密钥与原始响应加密保存，未知结果不重发；已完成真实匿名全文、原生链接与抓取策略验收，后续每篇仍需 AI 复核与检查链接；平台未声明定时到期但可删除页面，不保证永久保存',
  pastyx:'免账号按官方匿名 API 发布 Markdown 全文；编辑密钥和原始响应只在本机加密保存，未知结果不重发。已完成一次真实匿名全文与恢复验收；expiry=never 不代表永久保存',
  mdshare:'免账号发布公开 Markdown；匿名写入开关关闭或未知结果即停止；发布后核对 API 原文与浏览器 JS 渲染全文，不保证永久保存或搜索收录',
  'agentdrop':'当前停用：页面目标为安全跳转按钮，尚未验证可抓取的正文链接；匿名页保留 30 天，原发布记录加密留存，不重复投稿或续期',
  shippage:'首次任务通过同一创建请求自动建立一个平台账号并发布；密钥 仅在本机加密保存，之后所有网站复用这一账号。每页固定 14 天到期，未知结果不重发、不换号、不自动续期；发布后自动检查链接与抓取条件',
  pstrs:'免账号发布最长 365 天的完整 Markdown；原始响应与管理令牌加密留存，206 或未知结果不重发，过期不自动续期；不保证搜索收录或永久保留',
  pastemyst:'免账号发布完整 Markdown；原始响应加密留存，未知结果不重发；没有匿名所有者编辑、删除或列表找回，不保证长期保存或搜索收录',
  markdownpaste:'免账号发布完整 Markdown；expires_in=0 只表示不主动过期；官方源码存在按 ID 无认证删除，外链助手不提供或调用删除，不能视为永久或受保护存储',
  markdrop:'免注册发布 Markdown 全文；一次性编辑密钥自动加密保存在本机，结果不明时只核对原页面；默认不设到期时间，但服务不保证长期可用或保留',
  draftmark:'免注册发布公开 Markdown 全文；服务端生成大小写敏感的文档 ID，逐文档密钥只在本机加密保存；结果不明不重发，没有免费层 SLA 或永久保留保证',
  memorywiki:'免注册发布公开 Markdown 全文；编辑令牌和原始回包只在本机加密保存；结果不明不重发或猜测 ID，空到期时间不代表永久 SLA',
  agenthow:'首次任务自动建立并复用一个如实命名的无邮箱 actor；key和原始响应只在本机加密保存。注册最多一次，未知结果不换 label、不重试；每篇仍需 AI 复核与检查链接',
  agentnotepad:'首次任务自动建立并跨网站复用一个无邮箱 agent；密钥和原始响应只在本机加密保存。注册最多一次，未知结果不换名、不重试；每篇仍需 AI 复核与检查链接',
  openagentchat:'首次任务自动建立并复用一个如实命名的无邮箱 agent，也可连接用户已有 token；token只在本机加密保存。注册最多一次，未知结果不换名、不重试；不保证收录或长期保留',
  shellbook:'首次任务自动建立并复用一个无邮箱、如实命名的持久 agent；token、注册意图与原始响应只在本机加密保存。注册最多一次，未知结果不换名、不重试；发布结果不明只读对账且不重发',
  agentriot:'首次任务自动建立并复用一个无邮箱、如实命名的持久 agent；token、注册意图与原始响应只在本机加密保存。注册最多一次，未知结果不换名、不重试；发布结果不明只读对账且不重发',
  synthfolk:'普通任务先生成当前站点的真实公开资料；完整 payload、人类操控披露、handle 和 Website 经 AI 复核后才可一次注册。已有 key 只读核对导入；未知结果不重发、不换 handle 或覆盖网站',
  'large-language':'首次任务自动建立并复用一个如实命名的无邮箱 agent，也可连接用户已有 token；token只在本机加密保存。未知结果不换名、不重试；公开资料库收录不代表编辑推荐',
  agentswiki:'首个任务自动建立并复用如实披露的无邮箱 agent，也可连接已有 密钥；只发布当前任务生成且已通过 AI 复核的原创中立知识稿。先核对 2026-10-13 规则、CC BY 4.0 权利与公开发布账号披露；未知结果只读核对，不重发。已完成真实发布验收，后续每篇仍须 AI 复核和检查链接',
  'listed-startups':'免账号提交已审核的真实产品资料；发布前按固定 slug 与产品网址查重，未知结果只读核对且不重发。资料由提交者自报，不是编辑推荐，不保证收录或长期保留',
  'product-index':'首次连接本人已有 GitHub 发布账号的专用令牌；软件不自动注册 GitHub。每个产品只创建一个固定 issue，未知结果只按原作者与逐字相同正文恢复；还需平台工作流批准',
  'docs-md':'免账号匿名分享经核对的 Markdown；编辑令牌只加密保存在本机，真实托管验收前保持停用',
  'github-gist':'首次连接本人 GitHub 账号的 Gists 令牌',
  blogger:'首次由本人完成 Google 授权并选择博客',
  'wordpress-com':'首次由本人完成 WordPress.com 浏览器授权，再选择已公开博客',
  leaflet:'首次连接本人 Bluesky 托管账号的应用专用密码；完整文章',
  raindrop:'本人先确认邮箱并在最外层建立专用公开合集；粘贴个人 Test token、选择合集和实际 Public Page 地址',
  paragraph:'官网可用邮箱、Google 或 GitHub 注册，无需钱包；先准备本人出版物并取得 API 密钥，再连接自动发布。尚未接入自动开户及取密钥',
  gitbook:'先在官网准备一个本人控制的 Basic 文档站，再粘贴 PAT 并选择关联网站；唯一远端站点自动识别，多候选时再手动指定。连接后自动发布，但不会自动注册、建站、创建 PAT、升级或付款',
  valtown:'本人先完成 Google 登录或人机验证并创建最小权限 token；连接一次后自动发布审核通过的软件文档。未知结果只读恢复，不自动开户、创建 token 或接管同名 val',
  bitbucket:'连接已核实的 Free 工作区、私有项目和最小权限 token；一个工作区只服务一个网站，并且只允许发布一篇审核通过的软件文档到首次创建的 root。两次首次写入都要求 24 小时内 Free 证据，未知结果只做 GET 对账。',
  hive:'首次连接本人账号的 posting key',
  bluesky:'首次连接本人账号的授权码；仅短帖',
  'paper-wf':'尝试自动建号；首次人机验证可能需要本人完成',
};

export function channelSourceLabels(id:string){
  if(['agentsgather','chatclaw','tantive','thethings','betterthanhtml','supanote','docs-md','katbin','agentdrop','mdshare','totpage','mdview','txtsbs','pastyx','nextgen-slides','shippage','pstrs','yourwebs','pastemyst','markdownpaste','html-app','brewpage','markdrop','draftmark','memorywiki','sigle','nuance','carcinus'].includes(id))return {checked:'资料核查',open:'官方说明'};
  const guidance=['telegraph','paper-wf','verbose'].includes(id);
  return {checked:guidance?'接口与公开资料核查':'规则核查',open:id==='telegraph'?'官方 API 文档':guidance?'官方公开说明':'官方规则'};
}

export function channelAutomationView(channel:Channel,readinessLabel?:string){
  const kind=channelAutomationKind(channel);
  const label:Record<ChannelAutomationKind,string>={ai_auto:'AI全自动 · 免首连',connected_auto:'连接后自动',registration_pending:'注册待验证',profile:'资料页流程',manual:channel.automation==='api'?'未接自动发布':'人工提交',disabled:'当前停用'};
  const setup=kind==='disabled'?'停用平台不参与自动执行'
    :kind==='profile'?'需本人已有账号；仅维护资料页'
    :kind==='manual'?(channel.automation==='api'?'API 字段不代表软件已接入发布器':'由软件准备材料，需在平台人工提交')
    :setupById[channel.id];
  const method=['ai_auto','connected_auto','registration_pending'].includes(kind)?`${['slugpost','txtsbs'].includes(channel.id)&&kind==='ai_auto'?'官方网页':'官方 API'} · ${channel.kind==='directory'?'产品资料':channel.contentFormat==='social'?'短帖':'全文'}`:kind==='profile'?'浏览器资料页流程':undefined;
  return {kind,label:label[kind],setup,method,siteReadiness:readinessLabel&&kind!=='manual'&&kind!=='disabled'?`本网站：${readinessLabel}`:undefined};
}

export function channelDiscoveryCopy(discovery:Pick<ChannelDiscovery,'status'|'reason'|'nextStep'>|undefined,kind:ChannelAutomationKind,readiness?:ChannelReadiness){
  if(!discovery)return '查看平台条件与官方规则';
  if(readiness==='handoff_required'&&['recommended','worth_trying'].includes(discovery.status)&&kind!=='manual'&&kind!=='disabled'){
    const action=kind==='profile'?'资料页操作仍须满足平台规则':'之后仍按稿件审核与排期条件执行';
    return `${discovery.reason} 本网站需先连接或恢复可用账号；${action}。`;
  }
  return `${discovery.reason} ${discovery.nextStep}`;
}
