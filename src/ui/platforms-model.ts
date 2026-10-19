import type {Channel,Qualification,Site,Snapshot} from '../shared/types';
import {isRepeatableOfficialArticleChannel} from '../shared/publication';
import {normalizeChannelLinkRel} from '../shared/channel-rel';
import {channelAudience,channelLanguageMatches,eligibilityFor,requirementsFor} from '../integrations/eligibility';
import {builtInAccessClass} from '../integrations/channel-access-class';
import {channelReadinessForDisplay,languageLabel} from './presentation';
import {htmlAppPublicNoticeAccepted} from '../shared/html-app-notice';
import type {LinkRow} from './links-model';

export type AccessGroup=NonNullable<Channel['accessClass']>;

/** The eight groups in the order a site owner meets them, from no effort to not usable. */
export const ACCESS_GROUPS:ReadonlyArray<{id:AccessGroup;title:string;note?:string}>=[
  {id:'direct_submit',title:'免注册直接发'},
  {id:'auto_account',title:'软件自动建号'},
  {id:'email_auto',title:'给邮箱就自动'},
  {id:'human_verify_once',title:'要你过一次验证'},
  {id:'connect_once',title:'连一次后自动'},
  {id:'wallet',title:'钱包登录',note:'连钱包只是登录，每篇都要你确认；软件不会要你的助记词。'},
  {id:'manual',title:'软件写好、你来发'},
  {id:'unqualified',title:'不适合这个网站'},
];

const HOW:Record<Exclude<AccessGroup,'unqualified'>,string>={
  direct_submit:'免注册',auto_account:'自动建号',email_auto:'给邮箱',human_verify_once:'验证一次',connect_once:'连一次',wallet:'钱包登录',manual:'你来发',
};

export function platformWeight(channel:Pick<Channel,'linkRel'>):string{
  if(!channel.linkRel||channel.linkRel==='unknown')return '权重未确认';
  return normalizeChannelLinkRel(channel.linkRel)==='follow'?'可传权重':'不传权重';
}

/** "{怎么接} · {保留多久} · {可传权重/不传权重}" */
export function platformOneLiner(channel:Channel,group:AccessGroup=channel.accessClass??'manual'):string{
  const how=HOW[group==='unqualified'?(channel.accessClass&&channel.accessClass!=='unqualified'?channel.accessClass:builtInAccessClass(channel)):group];
  const keep=channel.retentionDays!==undefined?`保留 ${channel.retentionDays} 天`:'长期保留';
  return `${how} · ${keep} · ${platformWeight(channel)}`;
}

const QUALIFICATION_SHORT:Partial<Record<Qualification,string>>={
  software:'只收软件项目',developer:'只收开发项目',openSource:'只收开源项目',portfolio:'只收作品集',publication:'只收自己的出版物',
  business:'只收真实公司',localBusiness:'只收本地商家',techContent:'只收技术文章',
};

/** A short reason, at most a few words, for the "不适合这个网站" group. */
export function unsuitableReason(site:Site,channel:Channel):string{
  if(!channel.enabled)return '平台已停用';
  if(channel.promotionPolicy==='forbidden'||channel.termsCache?.promotion==='forbidden')return '禁止推广内容';
  if(site.category==='finance'&&(!channelAudience(channel).some(value=>value==='general'||value==='finance')||channel.termsCache?.finance==='forbidden'))return '不收金融内容';
  if(!channelLanguageMatches(site,channel)){
    const languages=channel.languages.filter(value=>value!=='*').map(value=>languageLabel(value));
    return languages.length?`只收${languages.slice(0,2).join('、')}${languages.length>2?'等':''}`:'语言不符';
  }
  const result=eligibilityFor(site,channel);
  if(result.requirement)return QUALIFICATION_SHORT[result.requirement]??'需要先补资料';
  const missing=requirementsFor(channel)[0];
  return missing?QUALIFICATION_SHORT[missing]??'需要先补资料':'暂不适合';
}

export type PlatformAction={kind:'in_use'}|{kind:'manual'}|{kind:'connect'}|{kind:'verify'}|{kind:'confirm'}|{kind:'unavailable';reason:string}|{kind:'disabled'}|{kind:'none'};

/** Why the scheduler skips an otherwise suitable platform, in a few words, from what is actually known. */
function unavailableReason(data:Snapshot,site:Site|undefined,channel:Channel):string{
  if(channel.retentionDays!==undefined)return '临时页，不排进每月计划';
  if(channel.free==='paid'||channel.free==='unknown')return '可能收费，不自动用';
  if(!site&&!data.sites.some(item=>item.status==='ready'&&!item.archivedAt))return '还没有能发布的网站';
  if(site&&site.status!=='ready')return '网站还没准备好';
  if(site?.category==='finance'&&!isRepeatableOfficialArticleChannel(channel))return '金融站只用官方文章平台';
  if(channel.singleSiteOnly&&site&&data.accountBindings.some(binding=>binding.channelId===channel.id&&binding.siteId!==site.id))return '只能给一个网站用';
  if(site&&!site.topics?.length)return '还没有可用的选题页';
  return '现在排不上';
}

/**
 * What the row offers. A site's「在用」is the scheduler's own answer (snapshot.schedulablePlatformIds), so the page
 * never promises a platform the scheduler would skip; anything else says what is missing. Only platforms that have a
 * connection or verification step ever offer one.
 */
export function platformAction(data:Snapshot,site:Site|undefined,channel:Channel,group:AccessGroup):PlatformAction{
  if(!channel.enabled)return {kind:'disabled'};
  if(group==='unqualified')return {kind:'none'};
  const schedulable=(id:string|undefined)=>!!id&&!!data.schedulablePlatformIds?.[id]?.includes(channel.id);
  if(site?schedulable(site.id):data.sites.some(item=>schedulable(item.id)))return {kind:'in_use'};
  // The software prepares these; the owner posts them (wallet: confirms each post). Nothing to connect.
  if(channel.automation==='manual'||group==='wallet')return {kind:'manual'};
  if(channel.id==='html-app'&&!htmlAppPublicNoticeAccepted(data.settings.htmlAppPublicNotice))return {kind:'confirm'};
  const readiness=site?channelReadinessForDisplay(data,site,channel):undefined;
  const registered=data.accounts.some(account=>account.channelId===channel.id&&!account.retiredAt&&account.status==='registered');
  const handoff=site?readiness==='handoff_required':!registered;
  // The one-time verification is still owed until an account exists; a verified account the scheduler skips today is not.
  if(group==='human_verify_once'&&(handoff||!registered))return {kind:'verify'};
  // A temporary or possibly paid page is never scheduled, whatever its account state: say that first.
  const neverScheduled=channel.retentionDays!==undefined||channel.free==='paid'||channel.free==='unknown';
  if(neverScheduled&&group!=='connect_once'&&group!=='manual')return {kind:'unavailable',reason:unavailableReason(data,site,channel)};
  // Any platform that needs this site's own account connected says so (an automatic one included, when it cannot make one here).
  if((group==='connect_once'||group==='manual')&&handoff||site&&readiness==='handoff_required')return {kind:'connect'};
  // A paused or analyzing site has no scheduler answer yet: show what it would be ready for.
  if(site&&!data.schedulablePlatformIds?.[site.id]&&(readiness==='ready'||readiness==='autocreate')&&channel.retentionDays===undefined&&channel.free!=='paid'&&channel.free!=='unknown')return {kind:'in_use'};
  return {kind:'unavailable',reason:unavailableReason(data,site,channel)};
}

export interface PlatformRow {channel:Channel;group:AccessGroup;oneLiner:string;reason?:string;action:PlatformAction;published:number;active:number}

export function platformRows(data:Snapshot,site:Site|undefined,links:readonly LinkRow[]):PlatformRow[]{
  const scoped=site?links.filter(row=>row.site.id===site.id):links;
  return data.channels.map(channel=>{
    // Same classification as the main process; custom and older channels fall back to their setup fields.
    const builtIn=channel.accessClass&&channel.accessClass!=='unqualified'?channel.accessClass:builtInAccessClass(channel);
    const group:AccessGroup=!channel.enabled||site&&!eligibilityFor(site,channel).eligible?'unqualified':builtIn;
    const own=scoped.filter(row=>row.task.channelId===channel.id);
    return {channel,group,oneLiner:platformOneLiner(channel,group),...(group==='unqualified'?{reason:site?unsuitableReason(site,channel):'平台已停用'}:{}),
      action:platformAction(data,site,channel,group),published:own.length,active:own.filter(row=>row.active).length};
  });
}

/** "全自动 {a} 个 · 连一次后自动 {b} 个 · 你来发 {c} 个": what this site would actually use. */
export function platformSummary(rows:readonly PlatformRow[]){
  const using=rows.filter(row=>row.action.kind==='in_use');
  return {
    automatic:using.filter(row=>['direct_submit','auto_account','email_auto'].includes(row.group)).length,
    connected:using.filter(row=>['human_verify_once','connect_once'].includes(row.group)).length,
    manual:rows.filter(row=>row.action.kind==='manual').length,
  };
}

const TERM_TEXT={allowed:'能',forbidden:'不能',unknown:'条款没写明'} as const;
const PLACEMENT_TEXT:Record<string,string>={start:'放在开头',end:'放在结尾',unknown:'条款没写明位置'};

/** The terms a platform states, in plain words, with where and when they were read. */
export function platformTerms(channel:Channel){
  const cache=channel.termsCache;
  if(!cache||cache.reviewVersion!==2)return {finance:'还没核对',promotion:'还没核对',disclosure:'还没核对',sources:channel.rulesUrl?[channel.rulesUrl]:[],checkedAt:undefined as string|undefined};
  return {
    finance:TERM_TEXT[cache.finance],promotion:TERM_TEXT[cache.promotion],disclosure:PLACEMENT_TEXT[cache.disclosurePlacement]??PLACEMENT_TEXT.unknown,
    sources:[...new Set(cache.sources.map(source=>source.url))],checkedAt:cache.checkedAt,
  };
}

/** Accounts on three or more sites are easy for a platform to link together. */
export const SHARED_ACCOUNT_SITES=3;

/** The platform's own name, without the catalog's status notes ("Docs MD · 匿名全文（待托管验收）" → "Docs MD"). */
export function platformName(channel:Pick<Channel,'name'>):string{
  return channel.name.split(' · ')[0].replace(/[（(][^）)]*[）)]\s*$/,'').trim()||channel.name;
}
