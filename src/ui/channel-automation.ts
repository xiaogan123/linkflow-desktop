import type {Category,Channel} from '../shared/types';
import type {ChannelDiscovery} from '../integrations/channel-discovery';
import type {ChannelReadiness} from './presentation';

export type ChannelAutomationKind='ai_auto'|'connected_auto'|'registration_pending'|'profile'|'manual'|'disabled';
export type ChannelAutomationFilter='all'|Exclude<ChannelAutomationKind,'disabled'>;

const automaticIdentity=new Set(['telegraph','nostr','mataroa','verbose','rentry','lucid-page','betterthanhtml','supanote','docs-md']);
const connectedIdentity=new Set(['github-gist','blogger','wordpress-com','leaflet','paragraph','hive','bluesky']);

export function channelAutomationKind(channel:Channel):ChannelAutomationKind{
  if(!channel.enabled)return 'disabled';
  if(channel.automation==='browser')return 'profile';
  if(channel.automation!=='api'||channel.provenance==='custom')return 'manual';
  if(channel.id==='paper-wf'&&channel.contentFormat!=='social')return 'registration_pending';
  if(automaticIdentity.has(channel.id)&&channel.contentFormat!=='social')return 'ai_auto';
  if(connectedIdentity.has(channel.id)&&(channel.id==='bluesky')===(channel.contentFormat==='social'))return 'connected_auto';
  return 'manual';
}

export function channelMatchesAutomation(channel:Channel,filter:ChannelAutomationFilter,freeOnly=false,category:'all'|Category='all'){
  const kind=channelAutomationKind(channel);
  const categoryMatches=category==='all'||channel.categories.includes(category)||category!=='finance'&&channel.categories.includes('general');
  return (filter==='all'||kind===filter)&&(!freeOnly||channel.free==='yes')&&categoryMatches;
}

const setupById:Record<string,string>={
  telegraph:'自动创建作者身份，无需首次连接',
  nostr:'在本机建立作者身份，无需首次连接',
  mataroa:'自动建立作者账号；若平台要求验证则等待处理',
  verbose:'自动建立作者身份，无需首次连接；实验平台，一次性令牌不可补发',
  rentry:'免账号发布；编辑凭据自动加密保存在本机',
  'lucid-page':'免账号发布公开全文；匿名发布后修改或删除需先认领',
  betterthanhtml:'免账号发布静态全文；尚未确认文章修改或删除接口',
  supanote:'免账号匿名发布 Markdown；管理令牌仅在平台返回时加密保存，不承诺可编辑或删除',
  'docs-md':'免账号匿名分享经核对的 Markdown；编辑令牌只加密保存在本机，真实托管验收前保持停用',
  'github-gist':'首次连接本人 GitHub 账号的 Gists 令牌',
  blogger:'首次由本人完成 Google 授权并绑定博客',
  'wordpress-com':'首次由本人完成 WordPress.com 浏览器授权，再选择已公开博客',
  leaflet:'首次连接本人 Bluesky 托管账号的应用专用密码；完整文章',
  paragraph:'首次连接本人出版物的 API key',
  hive:'首次连接本人账号的 posting key',
  bluesky:'首次连接本人账号的应用专用密码；仅短帖',
  'paper-wf':'尝试自动建号；首次人机验证可能需要本人完成',
};

export function channelSourceLabels(id:string){
  if(['betterthanhtml','supanote','docs-md','sigle','nuance'].includes(id))return {checked:'资料核查',open:'官方说明'};
  const guidance=['telegraph','paper-wf','verbose'].includes(id);
  return {checked:guidance?'接口与公开资料核查':'规则核查',open:id==='telegraph'?'官方 API 文档':guidance?'官方公开说明':'官方规则'};
}

export function channelAutomationView(channel:Channel,readinessLabel?:string){
  const kind=channelAutomationKind(channel);
  const label:Record<ChannelAutomationKind,string>={ai_auto:'AI全自动 · 免首连',connected_auto:'连接后自动',registration_pending:'注册待验证',profile:'资料页流程',manual:channel.automation==='api'?'未接自动发布':'人工提交',disabled:'当前停用'};
  const setup=kind==='disabled'?'停用渠道不参与自动执行'
    :kind==='profile'?'需本人已有账号；仅维护资料页'
    :kind==='manual'?(channel.automation==='api'?'API 字段不代表软件已接入发布器':'由软件准备材料，需在平台人工提交')
    :setupById[channel.id];
  const method=['ai_auto','connected_auto','registration_pending'].includes(kind)?`官方 API · ${channel.contentFormat==='social'?'短帖':'全文'}`:kind==='profile'?'浏览器资料页流程':undefined;
  return {kind,label:label[kind],setup,method,siteReadiness:readinessLabel&&kind!=='manual'&&kind!=='disabled'?`本网站：${readinessLabel}`:undefined};
}

export function channelDiscoveryCopy(discovery:Pick<ChannelDiscovery,'status'|'reason'|'nextStep'>|undefined,kind:ChannelAutomationKind,readiness?:ChannelReadiness){
  if(!discovery)return '查看渠道条件与官方规则';
  if(readiness==='handoff_required'&&['recommended','worth_trying'].includes(discovery.status)&&kind!=='manual'&&kind!=='disabled'){
    const action=kind==='profile'?'资料页操作仍须满足平台规则':'之后仍按稿件审核与排期条件执行';
    return `${discovery.reason} 本网站需先连接或恢复可用账号；${action}。`;
  }
  return `${discovery.reason} ${discovery.nextStep}`;
}
