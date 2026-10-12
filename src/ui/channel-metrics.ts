import type {Channel} from '../shared/types';

type Authority=NonNullable<Channel['authority']>;
type Traffic=NonNullable<Channel['traffic']>;
export type AuthorityChoice='ahrefs_dr'|'other';
export type AuthorityScope='domain'|'subdomain'|'page';

const ahrefsDrNames=new Set(['dr','ahrefs dr','domain rating','ahrefs domain rating']);
const oldGooglePrNames=new Set(['pr','googlepr','google pr','pagerank','page rank','google pagerank','google page rank']);
const normalizeName=(name:string)=>name.trim().replace(/\s+/g,' ').toLowerCase();

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

export function channelMetricView(channel:Pick<Channel,'authority'|'traffic'>){
 const authority=channel.authority;
 const kind=authority?authorityNameKind(authority.name):undefined;
 const drAvailable=kind==='ahrefs_dr'&&authority?.scope!=='page';
 const scopeText=authority?.scope==='domain'?'域名':authority?.scope==='subdomain'?'子域名':authority?.scope==='page'?'页面':'口径待补';
 const targetText=authority?.target?.trim()||'测量对象待补';
 const legacyNotes=[!authority?.scope&&'口径待补',!authority?.target&&'测量对象待补'].filter(Boolean).join('、');
 const dr=drAvailable?`DR ${authority!.value}${legacyNotes?`（${legacyNotes}）`:''}`:'DR 未知';
 const pr=kind==='old_google_pr'&&authority
  ?`Google PR 无当前公开值 · 历史导入 ${authority.name} ${authority.value}`
  :'Google PR 无当前公开值';
 const other=kind==='other'&&authority?`${authority.name} ${authority.value}`:
  kind==='ahrefs_dr'&&authority?.scope==='page'?`页级历史导入 ${authority.name} ${authority.value}（不作 DR）`:undefined;
 const caveat=kind==='old_google_pr'?'历史导入，不能作为当前 Google PR':
  kind==='ahrefs_dr'&&authority?.scope==='page'?'页级历史导入，不能作为 Ahrefs DR':
  authority&&/^open\s?page\s?rank$/i.test(authority.name.trim())?'OpenPageRank 与 Google PR 不同':undefined;
 const dataDate=authority?.dataMonth?`数据月份：${authority.dataMonth} · 核查：${authority.checkedAt??'未知'}`:`数据日期：${authority?.asOf??'未知'}`;
 const origin=authority?.provenance==='official_snapshot'?'官方公开快照，非实时查询':'用户导入，未经系统核实';
 const measurement=authority?`${scopeText} · ${targetText} · ${authority.dataMonth??authority.asOf??'日期未知'}`:undefined;
 const authorityDetail=authority
  ?`${authority.name} ${authority.value} · ${origin} · 来源：${authority.source} · ${dataDate} · 口径：${scopeText} · 测量对象：${targetText}${authority.dataMonth?' · 具体测量日及算法版本未披露':''}${caveat?` · ${caveat}`:''}`
  :'未知（未导入）';
 const traffic=channel.traffic;
 const trafficSummary=traffic?`${traffic.monthly.toLocaleString()} / 月`:'流量未知';
 const trafficDetail=traffic
  ?`${traffic.monthly.toLocaleString()} ${traffic.metric==='organicVisits'?'自然访问':'访问'} / 月${traffic.estimated?' · 第三方估算':''} · 用户导入，未经系统核实 · 来源：${traffic.source} · ${traffic.period?`数据月份：${traffic.period} · 核查：${traffic.asOf}`:`数据日期：${traffic.asOf}`}`
  :'未知（不会以 0 代替）';
 return {dr,pr,other,authorityDetail,trafficSummary,trafficDetail,measurement,origin,drAvailable};
}

export interface MetricFormInput{
 channelId:string;authorityChoice:AuthorityChoice;otherName:string;authorityValue:string;scope:AuthorityScope;target:string;
 traffic:string;source:string;asOf:string;estimated:boolean;datePrecision?:'day'|'month';dataMonth?:string;checkedAt?:string;
}

export function buildChannelMetricRow(input:MetricFormInput):{channelId:string;authority?:Authority;traffic?:Traffic}{
 const authorityFilled=input.authorityValue.trim()!=='';
 const trafficFilled=input.traffic.trim()!=='';
 if(!authorityFilled&&!trafficFilled)throw Error('请填写 DR、其他权威指标或月访问量。');
 const monthlyEvidence=input.datePrecision==='month';
 if(monthlyEvidence?(!input.dataMonth||!input.checkedAt):!input.asOf)throw Error('请填写来源给出的数据日期；仅提供月份时选择月度数据并记录核查日期。');
 const row:{channelId:string;authority?:Authority;traffic?:Traffic}={channelId:input.channelId};
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
  row.authority={name,value,source:input.source.trim(),...(monthlyEvidence?{dataMonth:input.dataMonth,checkedAt:input.checkedAt}:{asOf:input.asOf}),scope:input.scope,target:input.target.trim()};
 }
 if(trafficFilled){
  const monthly=Number(input.traffic);
  if(!Number.isSafeInteger(monthly)||monthly<0||monthly>1e13)throw Error('月访问量需为非负整数。');
  row.traffic={monthly,source:input.source.trim(),asOf:monthlyEvidence?input.checkedAt!:input.asOf,...(monthlyEvidence?{period:input.dataMonth}:{}),metric:'visits',estimated:input.estimated};
 }
 return row;
}
