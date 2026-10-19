import type {Channel,ChannelMetric,FinancePlatformCount} from '../shared/types';
import {channelMetrics} from '../shared/channel-metrics';
import {channelMetricLinkScope} from '../integrations/channel-authority-snapshots';
import {authorityCopy} from './authority-copy';

type Traffic=NonNullable<Channel['traffic']>;
export type AuthorityChoice='ahrefs_dr'|'other';
export type AuthorityScope='domain'|'subdomain'|'page';

const ahrefsDrNames=new Set(['dr','ahrefs dr','domain rating','ahrefs domain rating']);
const oldGooglePrNames=new Set(['pr','googlepr','google pr','pagerank','page rank','google pagerank','google page rank']);
const normalizeName=(name:string)=>name.trim().replace(/\s+/g,' ').toLowerCase();

const financePlatformCopy={
 runtime:(value:FinancePlatformCount)=>`免人工全自动平台 ${value.count} 个（已转正 ${value.acceptedCount}，试运行 ${value.trialCount}，待首篇验收 ${value.pendingAcceptanceCount??0}）；要你确认一次 ${value.confirmationRequiredIds?.length??0} 个，要你过一次验证 ${value.verificationRequiredIds?.length??0} 个。会随账号、试运行名额和选题变化。`,
} as const;

export function financePlatformRuntimeSummary(value:FinancePlatformCount):string{return financePlatformCopy.runtime(value)}

export function authorityNameKind(name:string):'ahrefs_dr'|'old_google_pr'|'other'{
 const normalized=normalizeName(name);
 if(ahrefsDrNames.has(normalized))return 'ahrefs_dr';
 if(oldGooglePrNames.has(normalized))return 'old_google_pr';
 return 'other';
}

export function otherAuthorityNameError(name:string):string|undefined{
 if(!name.trim())return '请填写第三方指标的完整名称。';
 const kind=authorityNameKind(name);
 if(kind==='old_google_pr')return 'Google PR 无当前公开值；不能将 PR / GooglePR 录作当前指标。';
 if(kind==='ahrefs_dr')return '请使用预设的 Ahrefs DR，并填写域名或子域名口径。';
 return undefined;
}

export function channelMetricView(channel:Pick<Channel,'metrics'|'authority'|'traffic'>&Partial<Pick<Channel,'domain'>>){
 const metrics=channelMetrics(channel);
 // A live or imported Ahrefs DR wins; otherwise the built-in public snapshot shipped with the app, labelled as such.
 const pick=(provider:string)=>{const found=metrics.filter(metric=>metric.provider===provider);return found.find(metric=>metric.linkScope==='same-host')??found[0]};
 const live=pick('ahrefs-dr'),selected=live??pick('built-in-dr');
 const dr=selected?authorityCopy.dr(selected.value):authorityCopy.unknown;
 const subtitle=selected?(selected.linkScope==='platform-root'?authorityCopy.platform:live?authorityCopy.dated(selected.asOf):authorityCopy.builtIn(selected.asOf)):authorityCopy.pending;
 const visibleMetrics=metrics.filter(metric=>!metric.provider.startsWith('legacy:')||authorityNameKind(metric.provider.slice(7))!=='old_google_pr');
 const authorityDetail=visibleMetrics.length?visibleMetrics.map(metric=>{
  const name=metric.provider==='ahrefs-dr'?'Ahrefs DR':metric.provider==='built-in-dr'?authorityCopy.builtInName:metric.provider.replace(/^legacy:/,'');
  return `${name} ${metric.value} · 来源：${metric.source} · 数据月份：${metric.asOf||authorityCopy.unknownMonth} · 测量对象：${metric.target}${metric.note?` · ${metric.note}`:''}`;
 }).join('；'):authorityCopy.pending;
 const traffic=channel.traffic;
 const trafficDetail=traffic
  ?`${traffic.monthly.toLocaleString()} ${traffic.metric==='organicVisits'?'自然访问':'访问'} / 月${traffic.estimated?' · 第三方估算':''} · 用户导入，未经外链助手核实 · 来源：${traffic.source} · ${traffic.period?`数据月份：${traffic.period} · 核查：${traffic.asOf}`:`数据日期：${traffic.asOf}`}`
  :undefined;
 return {dr,subtitle,authorityDetail,trafficDetail,drAvailable:!!selected};
}

export function metricImportLinkScope(channel:(Pick<Channel,'id'|'domain'|'metrics'|'authority'>)|undefined,target:string):ChannelMetric['linkScope']{
 if(!channel)return 'platform-root';
 const measuredTarget=target.trim().toLowerCase();
 const knownScope=channelMetrics(channel).find(metric=>metric.provider==='ahrefs-dr'&&metric.target.toLowerCase()===measuredTarget)?.linkScope;
 if(knownScope)return knownScope;
 if(channel.domain.toLowerCase()!==measuredTarget)return 'platform-root';
 return channelMetricLinkScope(channel.id);
}

export interface MetricFormInput{
 channelId:string;authorityChoice:AuthorityChoice;otherName:string;authorityValue:string;scope:AuthorityScope;target:string;
 traffic:string;source:string;asOf:string;estimated:boolean;datePrecision?:'day'|'month';dataMonth?:string;checkedAt?:string;linkScope?:ChannelMetric['linkScope'];
}

export function buildChannelMetricRow(input:MetricFormInput):{channelId:string;metrics?:ChannelMetric[];traffic?:Traffic}{
 const authorityFilled=input.authorityValue.trim()!=='';
 const trafficFilled=input.traffic.trim()!=='';
 if(!authorityFilled&&!trafficFilled)throw Error('请填写 DR、其他权威指标或月访问量。');
 const monthlyEvidence=input.datePrecision==='month';
 if(monthlyEvidence?(!input.dataMonth||!input.checkedAt):!input.asOf)throw Error('请填写来源给出的数据日期；仅提供月份时选择月度数据并记录核查日期。');
 const row:{channelId:string;metrics?:ChannelMetric[];traffic?:Traffic}={channelId:input.channelId};
 if(authorityFilled){
  const name=input.authorityChoice==='ahrefs_dr'?'Ahrefs DR':input.otherName.trim();
  if(input.authorityChoice==='other'){
   const error=otherAuthorityNameError(name);
   if(error)throw Error(error);
  }
  if(input.authorityChoice==='ahrefs_dr'&&input.scope==='page')throw Error('Ahrefs DR 只适用于域名或子域名。');
  if(!input.target.trim())throw Error('请填写权威指标的实际测量对象。');
  const value=Number(input.authorityValue);
  if(!Number.isFinite(value)||value<0||value>100)throw Error('权威值需在 0 到 100 之间。');
  if(/^open\s?page\s?rank$/i.test(name)&&value>10)throw Error('OpenPageRank 需在 0 到 10 之间。');
  row.metrics=[{
   provider:input.authorityChoice==='ahrefs_dr'?'ahrefs-dr':`legacy:${name}`,
   value,source:input.source.trim(),asOf:(monthlyEvidence?input.dataMonth!:input.asOf).slice(0,7),
   target:input.target.trim(),linkScope:input.linkScope??'platform-root',version:'',
   note:`用户导入，未经外链助手核实${monthlyEvidence?` · 核查：${input.checkedAt}`:''}`,
  }];
 }
 if(trafficFilled){
  const monthly=Number(input.traffic);
  if(!Number.isSafeInteger(monthly)||monthly<0||monthly>1e13)throw Error('月访问量需为非负整数。');
  row.traffic={monthly,source:input.source.trim(),asOf:monthlyEvidence?input.checkedAt!:input.asOf,...(monthlyEvidence?{period:input.dataMonth}:{}),metric:'visits',estimated:input.estimated};
 }
 return row;
}
