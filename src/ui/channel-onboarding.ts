import type {Category,Channel} from '../shared/types';
import {channelMatchesAutomation,type ChannelAutomationFilter} from './channel-automation';

export type ChannelOnboardingKind='no_signup'|'ai_account'|'wallet'|'existing_account'|'unknown';
export type ChannelOnboardingFilter='all'|ChannelOnboardingKind;
export type ChannelDirectoryFilters={automation:ChannelAutomationFilter;onboarding:ChannelOnboardingFilter;freeOnly:boolean;category:'all'|Category;siteVisible:boolean};

type OnboardingDefinition={kind:Exclude<ChannelOnboardingKind,'unknown'>;setup:string;aliases?:readonly string[]};

export const channelOnboardingOptions:ReadonlyArray<{value:ChannelOnboardingFilter;label:string}>=[
  {value:'all',label:'全部'},
  {value:'no_signup',label:'免注册'},
  {value:'ai_account',label:'自动建号 / 身份'},
  {value:'wallet',label:'钱包连接'},
  {value:'existing_account',label:'已有账号'},
  {value:'unknown',label:'待核实'},
];

const labelByKind:Record<ChannelOnboardingKind,string>={
  no_signup:'免注册',
  ai_account:'自动建号 / 身份',
  wallet:'钱包连接',
  existing_account:'已有账号',
  unknown:'待核实',
};

// These entries describe the first identity/setup step only. They do not grant
// an automatic publisher capability, enable a disabled channel, or prove that
// a candidate can be used for a particular site.
const onboardingById:Record<string,OnboardingDefinition>={
  'lucid-page':{kind:'no_signup',setup:'无需账号；直接创建公开页面，后续修改或删除需本人认领'},
  rentry:{kind:'no_signup',setup:'无需账号；发布时生成编辑凭据并加密保存在本机'},
  betterthanhtml:{kind:'no_signup',setup:'无需账号即可发布公开全文；不承诺编辑或删除'},
  telegraph:{kind:'ai_account',setup:'软件调用 API 自动创建作者身份并加密保存令牌'},
  nostr:{kind:'ai_account',setup:'软件在本机创建作者密钥；这不是钱包连接'},
  mataroa:{kind:'ai_account',setup:'首次任务自动建立作者账号；平台要求验证时等待本人处理'},
  verbose:{kind:'ai_account',setup:'通过 API 自动建立作者身份；一次性令牌仅在本机加密保存'},
  'paper-wf':{kind:'ai_account',setup:'尝试自动建号；平台可能要求本人完成首次人机验证'},
  paragraph:{kind:'wallet',setup:'平台账号支持钱包或邮箱；本软件当前连接本人出版物的 API key',aliases:['Mirror']},
  sigle:{kind:'wallet',setup:'连接本人 Leather / Stacks 钱包；当前需逐篇签名，未接无人值守'},
  nuance:{kind:'wallet',setup:'连接本人 NFID、Plug 或 Internet Identity；委托有期限，未接无人值守'},
  'github-gist':{kind:'existing_account',setup:'连接本人已有 GitHub 账号的 Gists 读写令牌'},
  blogger:{kind:'existing_account',setup:'本人完成 Google 授权并绑定已有博客'},
  'wordpress-com':{kind:'existing_account',setup:'本人完成 WordPress.com 授权，再选择已有的公开博客'},
  leaflet:{kind:'existing_account',setup:'连接本人已有 Bluesky 托管账号的应用专用密码'},
  hive:{kind:'wallet',setup:'平台支持 Hive 钱包签名；本软件当前连接已有账号的 posting key，未接钱包签名流程',aliases:['PeakD','Ecency']},
  bluesky:{kind:'existing_account',setup:'连接本人已有 Bluesky 账号的应用专用密码'},
  github:{kind:'existing_account',setup:'导入本人已有 GitHub 账号；只维护真实资料与项目'},
  gitlab:{kind:'existing_account',setup:'导入本人已有 GitLab 账号；只维护真实资料与项目'},
  behance:{kind:'existing_account',setup:'导入本人已有 Behance 账号；只维护真实作品资料'},
  artstation:{kind:'existing_account',setup:'导入本人已有 ArtStation 账号；只维护真实作品资料'},
};

function onboardingDefinition(channel:Channel){
  if(channel.provenance!=='built-in')return undefined;
  return onboardingById[channel.id];
}

export function channelOnboardingKind(channel:Channel):ChannelOnboardingKind{
  return onboardingDefinition(channel)?.kind??'unknown';
}

export function channelMatchesOnboarding(channel:Channel,filter:ChannelOnboardingFilter){
  return filter==='all'||channelOnboardingKind(channel)===filter;
}

export function channelMatchesDirectoryFilters(channel:Channel,filters:ChannelDirectoryFilters){
  return filters.siteVisible
    &&channelMatchesAutomation(channel,filters.automation,filters.freeOnly,filters.category)
    &&channelMatchesOnboarding(channel,filters.onboarding);
}

export function channelOnboardingView(channel:Channel){
  const definition=onboardingDefinition(channel);
  const kind=definition?.kind??'unknown';
  const setup=definition?.setup??(channel.provenance==='custom'
    ?'用户添加的渠道；首次接入方式待核实'
    :'尚未确认可复用的首次接入方式；请按渠道详情人工准备');
  return {kind,label:labelByKind[kind],setup,aliases:[...(definition?.aliases??[])]};
}
