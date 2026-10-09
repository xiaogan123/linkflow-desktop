import type {Category,Channel} from '../shared/types';
import {channelMatchesAutomation,type ChannelAutomationFilter} from './channel-automation';

export type ChannelOnboardingKind='no_signup'|'ai_account'|'wallet'|'existing_account'|'unknown';
export type ChannelOnboardingFilter='all'|ChannelOnboardingKind;
export type ChannelDirectoryFilters={automation:ChannelAutomationFilter;onboarding:ChannelOnboardingFilter;freeOnly:boolean;category:'all'|Category;siteVisible:boolean};

type OnboardingDefinition={kind:ChannelOnboardingKind;setup:string;aliases?:readonly string[];verification?:{checkedAt:string;sourceUrl:string}};

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
  "docker-hub":{"kind":"existing_account","setup":"本人用邮箱、Google 或 GitHub 注册 Docker 并完成邮箱验证；仅维护真实容器镜像仓库，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://docs.docker.com/accounts/individual/create-account/"}},
  "firefox-addons":{"kind":"existing_account","setup":"本人用 Mozilla 账号登录 AMO 开发者中心，按提示完成安全验证；仅提交真实 Firefox 扩展并通过校验及平台审核，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://extensionworkshop.com/documentation/publish/submitting-an-add-on/"}},
  "vscode-marketplace":{"kind":"existing_account","setup":"本人用 Microsoft 账号登录 Marketplace 并创建发布者资料；仅提交已测试的真实 VS Code 扩展，发布授权按当前官方流程办理，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://code.visualstudio.com/api/working-with-extensions/publishing-extension"}},
  "jetbrains-marketplace":{"kind":"existing_account","setup":"本人登录 JetBrains Marketplace，创建或选择 Vendor 资料并接受开发者协议；仅提交真实插件并等待审核，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://plugins.jetbrains.com/docs/marketplace/uploading-a-new-plugin.html"}},
  "flathub":{"kind":"existing_account","setup":"本人用 GitHub 账号提交真实 Flatpak 应用并完成审核；获准维护时需启用 GitHub 双重验证，提交与沟通须本人完成，本工具保持停用","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://docs.flathub.org/docs/for-app-authors/submission"}},
  "fdroid":{"kind":"existing_account","setup":"本人用 GitLab 账号提交 F-Droid 收录合并请求；仅限源码公开、自由许可且可自由构建的真实 Android 应用，等待维护者审核，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://f-droid.org/docs/Submitting_to_F-Droid_Quick_Start_Guide/"}},
  "snap-store":{"kind":"existing_account","setup":"本人用 Ubuntu One 账号登录 Snap Store 开发者账户并按提示完成验证；仅为真实已测试的 snap 注册唯一名称，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://ubuntu.com/docs/snapcraft/9/how-to/publishing/register-a-snap/"}},
  "wordpress-plugins":{"kind":"existing_account","setup":"本人登录 WordPress.org 并按平台要求完成安全验证；仅上传完整可用、符合插件规范的真实插件，等待人工审核，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://wordpress.org/plugins/developers/add/"}},
  "drupal":{"kind":"existing_account","setup":"本人登录 Drupal.org，选择真实模块、主题或相关代码项目类型并设置维护权限；按项目规则人工创建与维护，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://www.drupal.org/docs/develop/managing-a-drupalorg-theme-module-or-distribution-project/creating-a-new-project/how-to-create-a-new-project"}},
  "rubygems":{"kind":"existing_account","setup":"本人用自有邮箱注册 RubyGems.org，按平台及软件包要求完成验证和多因素认证；仅发布有维护权限、名称唯一的真实 Ruby gem，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://guides.rubygems.org/publishing/"}},
  "uneed":{"kind":"existing_account","setup":"可先预览产品；保存需本人注册登录，再到控制台选择发布排期；当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://www.uneed.best/how-it-works"}},
  "betalist":{"kind":"existing_account","setup":"本人注册登录后提交真实初创产品；目前提交需付费并经编辑审核，本工具不代付","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://betalist.com/support"}},
  "wellfound":{"kind":"existing_account","setup":"本人建立个人登录，再创建真实雇主公司资料；已有公司需管理员授权或认领审核","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://help.wellfound.com/article/720-how-can-i-create-a-new-company-or-access-an-existing-one"}},
  "crates-io":{"kind":"existing_account","setup":"本人用 GitHub 登录 crates.io 并验证邮箱，按官方流程取得发布授权；仅维护真实 Rust crate，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://doc.rust-lang.org/cargo/reference/publishing.html"}},
  "packagist":{"kind":"existing_account","setup":"本人用邮箱注册 Packagist.org 或用 GitHub 登录，按提示完成账号验证；仅提交含 composer.json 的真实公开 Composer 项目仓库，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://packagist.org/about"}},
  "pub-dev":{"kind":"existing_account","setup":"本人用 Google 账号登录并授权发布；仅维护有 LICENSE 和分发权的真实 Dart/Flutter 包，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://dart.dev/tools/pub/publishing"}},
  "npm":{"kind":"existing_account","setup":"本人注册 npm 并验证邮箱，按平台要求完成双重验证或发布授权；仅维护真实 JavaScript 软件包，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://docs.npmjs.com/creating-a-new-npm-user-account/"}},
  "pypi":{"kind":"existing_account","setup":"本人注册 PyPI、验证邮箱并启用双重验证；仅维护有权分发的真实 Python 软件包，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://pypi.org/help/#twofa"}},
  "nuget":{"kind":"existing_account","setup":"本人用 Microsoft 账号登录 NuGet.org 并完成双重验证，建立个人发布身份；仅维护真实 .NET 软件包，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://learn.microsoft.com/en-us/nuget/nuget-org/individual-accounts"}},
  'sourceforge':{kind:'existing_account',setup:'本人注册 SourceForge 并确认邮箱；非现有项目管理员首次建项目需电话验证，仅用于真实开源软件，当前仅人工操作',verification:{checkedAt:'2026-10-09',sourceUrl:'https://sourceforge.net/p/forge/documentation/Create%20a%20New%20Project/'}},
  'itch-io':{kind:'existing_account',setup:'本人注册 itch.io 并按提示完成账号验证；仅发布有权分发的真实作品，内容就绪后设为公开，当前仅人工操作',verification:{checkedAt:'2026-10-09',sourceUrl:'https://itch.io/docs/creators/getting-started'}},
  'show-hn':{kind:'existing_account',setup:'本人注册或登录 Hacker News；仅分享自己制作且可体验的真实项目，由本人撰写并手动提交，禁止自动发帖及生成式投稿文本',verification:{checkedAt:'2026-10-09',sourceUrl:'https://news.ycombinator.com/submit'}},
  "codeberg":{"kind":"existing_account","setup":"本人注册 Codeberg 并确认邮箱；仅维护许可合规的真实自由软件或自由内容项目，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://docs.codeberg.org/getting-started/first-steps/"}},
  "huggingface":{"kind":"existing_account","setup":"本人注册 Hugging Face 并按提示完成验证；仅维护真实模型、数据集或演示，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://huggingface.co/terms-of-service"}},
  "indie-hackers":{"kind":"unknown","setup":"当前注册、验证与产品提交费用尚未核实；仅人工参与真实创业项目，不批量发帖","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://www.indiehackers.com/terms"}},
  prose:{kind:'existing_account',setup:'本人连接合法受邀 Pico 身份的专用 SSH 密钥；只读核验身份，发布资格与公开全文仍待验收',verification:{checkedAt:'2026-10-09',sourceUrl:'https://pico.sh/getting-started'}},
  'google-business':{kind:'existing_account',setup:'本人登录 Google 账号，认领真实到店或上门服务商家并完成平台指定验证；纯线上内容站不适用',verification:{checkedAt:'2026-10-09',sourceUrl:'https://support.google.com/business/answer/7039811'}},
  'apple-business':{kind:'existing_account',setup:'本人注册或登录 Apple Business 并验证真实组织；线上品牌可登记，地点页与公开链接需另行核验，当前仅人工操作',verification:{checkedAt:'2026-10-09',sourceUrl:'https://support.apple.com/guide/business/sign-up-and-verify-your-organization-axm402206497/web'}},
  'yelp-business':{kind:'existing_account',setup:'本人用邮箱建立商家账号，认领真实本地商家并按提示验证；纯线上内容站不适用，当前仅人工操作',verification:{checkedAt:'2026-10-09',sourceUrl:'https://business.yelp.com/resources/articles/creating-a-yelp-page-for-your-brand-new-business/'}},
  g2:{kind:'existing_account',setup:'本人登录 G2，申请或认领真实 B2B 软件资料并等待审核；当前仅人工提交',verification:{checkedAt:'2026-10-09',sourceUrl:'https://sell.g2.com/create-a-profile'}},
  capterra:{kind:'existing_account',setup:'本人从供应商入口申请真实软件资料；新增入口转至 G2，需本人完成验证与平台审核，当前仅人工提交',verification:{checkedAt:'2026-10-09',sourceUrl:'https://www.capterra.com/vendors/'}},
  clutch:{kind:'existing_account',setup:'本人用公司邮箱、Google 或 LinkedIn 登录，建立真实 B2B 服务商资料并等待审核；当前仅人工提交',verification:{checkedAt:'2026-10-09',sourceUrl:'https://help.clutch.co/en/knowledge/get-listed-on-clutch'}},
  "crunchbase-company":{"kind":"existing_account","setup":"本人登录并完成 Google 或 LinkedIn 社交认证；仅人工维护符合收录范围的真实公司资料","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://support.crunchbase.com/hc/en-us/articles/115010642588-Requirements-to-Create-a-Crunchbase-Profile-Page"}},
  "trustpilot-business":{"kind":"existing_account","setup":"本人用邮箱激活商家账号并按需验证域名；仅认领本人有权管理的真实业务网站","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://help.trustpilot.com/s/article/Claim-your-business-profile?language=en_US"}},
  "bing-places":{"kind":"existing_account","setup":"本人登录并认领真实本地商家，按提示完成地址、电话或邮箱验证；纯线上内容站不适用","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://www.bing.com/forbusiness/help/modernExperience"}},
  "pinterest":{"kind":"existing_account","setup":"本人登录并按提示完成邮箱验证；商业用途需商业账号，本工具保持停用","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://help.pinterest.com/en/business/article/get-a-business-account"}},
  "linkedin-company":{"kind":"existing_account","setup":"本人用真实个人账号登录；有权代表组织并取得主页超级管理员权限后维护资料","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://www.linkedin.com/help/linkedin/answer/a545752"}},
  "bluesky-domain":{"kind":"existing_account","setup":"本人登录已有 Bluesky 账号，并用自有域名完成 DNS 或 HTTPS 验证；仅身份参考，保持停用","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://bsky.social/about/blog/4-28-2023-domain-handle-tutorial"}},
  "linkedin-articles":{"kind":"existing_account","setup":"本人用真实身份登录并验证邮箱；个人或有权限的主页管理员人工发布专业文章","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://www.linkedin.com/help/linkedin/answer/a1340200/"}},
  "youtube-channel":{"kind":"existing_account","setup":"本人用 Google 账号登录并选择有管理权限的真实频道；按提示完成验证，资料链接由本人维护","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://support.google.com/youtube/answer/1646861?hl=en"}},
  "x-profile":{"kind":"existing_account","setup":"本人登录并按提示完成邮箱或手机验证；人工维护真实资料的网站字段，未接自动化","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://help.x.com/en/using-x/create-x-account"}},
  "tradingview-profile":{"kind":"existing_account","setup":"本人登录并完成账号验证；状态栏需付费方案，签名需 Premium 或更高方案，当前人工维护","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://www.tradingview.com/privacy-policy/"}},
  "vocus":{"kind":"existing_account","setup":"本人登录并完成邮箱及手机验证（海外可申请身份审核）；本工具保持停用","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://vocus.cc/help_center/ru-he-zhu-ce-vocus-zhang-hao-bing-wan-cheng-zhang-hao-yan-zheng"}},
  "publish0x":{"kind":"existing_account","setup":"本人登录并申请作者资格；平台禁止 AI 写稿及自动发布，本工具保持停用","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://www.publish0x.com/page/rules"}},
  "flipboard-publisher":{"kind":"existing_account","setup":"本人登录 Flipboard 并完善出版者资料；当前人工维护，RSS 接入另需审核","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://about.flipboard.com/forpublishers/"}},
  "gravatar":{"kind":"existing_account","setup":"本人通过 WordPress.com 登录并验证邮箱；仅人工维护真实资料和网站链接","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://support.gravatar.com/basic/account-signup/"}},
  "linktree":{"kind":"existing_account","setup":"本人登录 Linktree 并验证邮箱；当前人工维护，官方 AI 接入需 Premium 与本人授权","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://linktr.ee/help/en/articles/5434134-creating-your-linktree"}},
  "ghost-pro":{"kind":"existing_account","setup":"本人登录 Ghost(Pro) 并准备付费出版物；当前人工处理，发布 API 需支持集成的方案","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://ghost.org/integrations/custom-integrations/"}},
  "beehiiv":{"kind":"existing_account","setup":"本人登录 beehiiv 并完成账户验证；当前人工处理，API 另需本人身份核验","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://www.beehiiv.com/support/article/13091918395799-how-to-access-your-publication-id-or-api-keys"}},
  "kit-newsletter":{"kind":"existing_account","setup":"本人登录 Kit 并设置公开 Newsletter Site；本工具尚未接入发布 API","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://help.kit.com/en/articles/14005977-how-to-set-up-your-new-kit-account-a-complete-checklist"}},
  "product-hunt":{"kind":"existing_account","setup":"本人使用个人账号登录并完成引导与发布资格；真实产品由本人提交","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://help.producthunt.com/en/articles/479557-how-to-post-a-product"}},
  "alternativeto":{"kind":"existing_account","setup":"本人登录 AlternativeTo 并验证邮箱；提交真实应用后等待编辑审核","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://alternativeto.net/faq/"}},
  "saashub":{"kind":"unknown","setup":"公开入口可填写产品网址；账号及最终提交条件待核实，当前仅人工处理","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://www.saashub.com/site/product_verification"}},
  "hashnode":{"kind":"existing_account","setup":"本人登录 Hashnode 并创建或选择出版物；当前仅人工操作，API 写入另需 Pro","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://hashnode.com/onboard"}},
  "medium":{"kind":"existing_account","setup":"本人通过邮箱验证或社交账号登录 Medium；本渠道仍停用，未接自动发布","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://help.medium.com/hc/en-us/articles/115004915268-Sign-in-or-sign-up-to-Medium"}},
  "substack":{"kind":"existing_account","setup":"本人登录 Substack 并完善真实出版物；主页链接由本人维护，未接无人值守","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://support.substack.com/hc/en-us/articles/360037825111-How-do-I-create-a-publication-on-Substack"}},
  "dev":{"kind":"existing_account","setup":"本人登录 DEV 账号并人工准备技术文章；本渠道仍停用，未接自动发布","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://dev.to/new"}},
  "hackernoon":{"kind":"existing_account","setup":"本人登录 HackerNoon 并完善作者资料；人工投稿交编辑审核，品牌稿使用品牌身份","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://help.hackernoon.com/using-hacker-noon"}},
  "tumblr":{"kind":"existing_account","setup":"本人登录 Tumblr 并选择本人博客；邮箱注册需验证邮箱，当前仅人工操作","verification":{"checkedAt":"2026-10-09","sourceUrl":"https://help.tumblr.com/knowledge-base/getting-started-on-tumblr/"}},
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
    :'尚未确认首次接入方式；核实完成前不计入全自动渠道');
  return {kind,label:labelByKind[kind],setup,aliases:[...(definition?.aliases??[])],verification:definition?.verification};
}
