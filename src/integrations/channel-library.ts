import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Channel,ChannelMetric,Qualification} from '../shared/types';
import {qualificationLabels} from './eligibility';
import {channelMetrics,legacyAuthorityMetrics} from '../shared/channel-metrics';
import {channelMetricLinkScope} from './channel-authority-snapshots';
import {normalizeChannelLinkRel} from '../shared/channel-rel';
import {BATCH9B_MESSAGES} from '../shared/batch9b-messages';

export type ChannelMetrics={metrics?:ChannelMetric[];authority?:Channel['authority'];traffic?:Channel['traffic']};
const categories=z.enum(['software','ai','developer','design','business','content','education','finance','general']);
const host=z.string().trim().toLowerCase().max(253).refine(value=>{
 if(!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(value))return false;
 return !/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(value);
},'请填写公开平台的域名');
const httpsUrl=z.string().trim().max(2048).refine(value=>{
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&host.safeParse(u.hostname).success&&![...u.searchParams.keys()].some(key=>/^(?:token|api[_-]?key|password|secret|access_token)$/i.test(key))}catch{return false}
},'需要不含账号密码的公开 HTTPS 网址');
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{
 const d=new Date(value+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value&&value<=new Date().toISOString().slice(0,10);
},'请填写有效且不晚于今天的日期');
const qualification=z.enum(Object.keys(qualificationLabels) as [Qualification,...Qualification[]]);
export const CustomChannelInput=z.object({
 id:z.string().regex(/^custom-[0-9a-f-]{36}$/).optional(),name:z.string().trim().min(1).max(100),domain:host,
 submitUrl:httpsUrl,categories:z.array(categories).min(1).max(9),languages:z.array(z.string().regex(/^(?:\*|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/i)).min(1).max(30),
 kind:z.enum(['directory','profile','article','community']),free:z.enum(['yes','conditional','paid','unknown']),
 freeNote:z.string().trim().min(1).max(500),rulesUrl:httpsUrl,notes:z.string().trim().min(1).max(2000),
 requirements:z.array(qualification).max(30).optional(),enabled:z.boolean().optional(),
 linkRel:z.enum(['follow','nofollow','ugc','unknown']).optional(),indexable:z.enum(['yes','no','partial','unknown']).optional(),
 retentionDays:z.number().finite().positive().max(36500).optional(),audience:z.array(z.enum(['general','finance','software','ai_agent','local_business','design'])).max(6).optional(),
 promotionPolicy:z.enum(['allowed','disclosed','forbidden','unknown']).optional(),promotionPolicySource:httpsUrl.optional(),trial:z.boolean().optional(),singleSiteOnly:z.boolean().optional(),irreversible:z.boolean().optional(),
}).strict();
const Authority=z.object({name:z.string().trim().min(1).max(80).refine(value=>value!==BATCH9B_MESSAGES.builtInDr,BATCH9B_MESSAGES.reservedBuiltInDr),value:z.number().finite().min(0).max(100),source:httpsUrl,asOf:date.optional(),scope:z.enum(['domain','subdomain','page']).optional(),target:z.string().trim().min(1).max(2048).optional(),dataMonth:z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/).optional(),checkedAt:date.optional()}).strict().superRefine((value,ctx)=>{
 if(!value.asOf&&!value.dataMonth)ctx.addIssue({code:'custom',path:['asOf'],message:'需要数据日期或来源明确提供的数据月份'});
 if(value.dataMonth&&(!value.checkedAt||value.dataMonth>value.checkedAt.slice(0,7)))ctx.addIssue({code:'custom',path:['dataMonth'],message:'月度数据必须有核查日期，且数据月份不能晚于核查月份'});
 // Older imports did not record the measured target; preserve them without inferring one.
 if(value.target===undefined)return;
 if(!value.scope){ctx.addIssue({code:'custom',path:['scope'],message:'填写测量对象时必须选择域名、子域名或页面口径'});return}
 const valid=value.scope==='page'?httpsUrl.safeParse(value.target).success:host.safeParse(value.target).success;
 if(!valid)ctx.addIssue({code:'custom',path:['target'],message:value.scope==='page'?'页面指标需要不含账号密码的公开 HTTPS 测量地址':'域名指标的测量对象只能填写公开域名，不能包含网址路径'});
});
const Traffic=z.object({monthly:z.number().finite().int().min(0).max(1e13),source:httpsUrl,asOf:date,region:z.string().trim().max(80).optional(),period:z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/).optional(),metric:z.enum(['visits','organicVisits']).optional(),estimated:z.boolean().optional()}).strict().refine(value=>!value.period||value.period<=value.asOf.slice(0,7),'流量月份不能晚于核查日期所在月份');
const month=z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/).refine(value=>value<=new Date().toISOString().slice(0,7),'数据月份不能晚于本月');
export const ChannelMetricInput=z.object({
 provider:z.string().trim().min(1).max(100).refine(value=>value!=='built-in-dr'),value:z.number().finite().min(0).max(100),
 target:z.string().trim().max(2048).refine(value=>value===''||host.safeParse(value).success||httpsUrl.safeParse(value).success,'测量对象必须是公开主机或不含账号密码的 HTTPS 网址'),
 linkScope:z.enum(['same-host','platform-root']),asOf:z.union([z.literal(''),month]),version:z.enum(['','dr3','dr4']),source:httpsUrl,note:z.string().max(1000).optional(),
}).strict().superRefine((value,ctx)=>{
 if(!value.asOf&&!value.note?.includes('月份不明'))ctx.addIssue({code:'custom',path:['note'],message:'月份不明时必须保留说明'});
 if(!value.target&&!value.note?.includes('测量对象不明'))ctx.addIssue({code:'custom',path:['target'],message:'缺失测量对象时必须保留说明'});
 if(!value.target&&value.linkScope==='same-host')ctx.addIssue({code:'custom',path:['linkScope'],message:'测量对象不明时不能声明主机相同'});
});
export const MetricRows=z.array(z.object({channelId:z.string().min(1).max(100),metrics:z.array(ChannelMetricInput).max(100).nullable().optional(),authority:Authority.nullable().optional(),traffic:Traffic.nullable().optional()}).strict().refine(x=>x.metrics!==undefined||x.authority!==undefined||x.traffic!==undefined,'每行需要权重或流量数据')).min(1).max(1000);

export function composeChannels(builtins:Channel[],custom:Channel[]=[],metrics:Record<string,ChannelMetrics>={}):Channel[]{
 const ids=new Set(builtins.map(c=>c.id));
 const extras=custom.filter(c=>c.id.startsWith('custom-')&&!ids.has(c.id)&&c.automation==='manual').map(c=>({...c,automation:'manual' as const,accessClass:'manual' as const,provenance:'custom' as const,evidenceStatus:'user_added' as const}));
 return [...builtins,...extras].map(channel=>{
  const saved=metrics[channel.id];
  const metricValues=saved?.metrics??(saved?.authority?legacyAuthorityMetrics(saved.authority,{domain:channel.domain,linkScope:channelMetricLinkScope(channel.id)}):channelMetrics(channel));
  return {...channel,...saved,linkRel:normalizeChannelLinkRel(channel.linkRel),metrics:metricValues};
 });
}
export function saveCustomChannel(current:Channel[],input:unknown,builtins:Channel[]):Channel[]{
 const d=CustomChannelInput.parse(input);const id=d.id??'custom-'+randomUUID();
 if(builtins.some(c=>c.id===id))throw Error('内置平台不能在“添加平台”里修改');
 if(d.id&&!current.some(c=>c.id===id))throw Error('自己添加的平台不存在');
 if(!d.id&&current.length>=1000)throw Error('自己添加的平台已达 1000 个，请先整理现有平台');
 const submitHost=new URL(d.submitUrl).hostname;
 if(submitHost!==d.domain&&!submitHost.endsWith('.'+d.domain))throw Error('投稿入口必须属于填写的平台域名');
 if([...builtins,...current].some(c=>c.id!==id&&c.domain.replace(/^www\./,'')===d.domain.replace(/^www\./,'')))throw Error('该域名已有平台，请使用现有条目，避免重复');
 const channel:Channel={...d,id,url:'https://'+d.domain+'/',languages:[...new Set(d.languages.map(x=>x.toLowerCase()))],categories:[...new Set(d.categories)],requirements:[...new Set(d.requirements??[])],
  accountRequired:true,emailRequired:true,articleRequired:d.kind==='article',automation:'manual',accessClass:'manual',quality:'C',qualityReason:'你自己添加的平台，外链助手还没检查过它是否适合、规则是否允许。',checkedAt:'',allowedHosts:[...new Set([d.domain,submitHost])],enabled:d.enabled??true,provenance:'custom',evidenceStatus:'user_added'};
 return [...current.filter(c=>c.id!==id),channel];
}
export function deleteCustomChannel(current:Channel[],id:string,usedIds:string[]=[]):Channel[]{
 if(!current.some(c=>c.id===id))throw Error('自己添加的平台不存在');
 if(usedIds.includes(id))throw Error('该平台已有任务记录，请停用平台以保留历史记录');
 return current.filter(c=>c.id!==id);
}
export function importChannelMetrics(current:Record<string,ChannelMetrics>,input:unknown,channels:Channel[]):Record<string,ChannelMetrics>{
 const rows=MetricRows.parse(input);const allowed=new Set(channels.map(c=>c.id));const ids=new Set<string>();
 for(const row of rows){if(!allowed.has(row.channelId))throw Error('指标对应的平台不存在');if(ids.has(row.channelId))throw Error('导入包含重复平台，请先合并同一平台的指标');ids.add(row.channelId)}
 const result=structuredClone(current);
 for(const {channelId,metrics,authority,traffic}of rows){
  const next={...result[channelId]};
  if(metrics===null)next.metrics=[];
  else if(metrics!==undefined)next.metrics=metrics;
  if(authority===null){delete next.authority;if(metrics===undefined)next.metrics=[]}
  else if(authority!==undefined){
   next.authority=authority;
   if(metrics===undefined){const channel=channels.find(value=>value.id===channelId)!;next.metrics=legacyAuthorityMetrics(authority,{domain:channel.domain,linkScope:channelMetricLinkScope(channelId)})}
  }
  if(traffic===null)delete next.traffic;else if(traffic!==undefined)next.traffic={estimated:true,metric:'visits',region:'全球',...traffic};
  result[channelId]=next;
 }
 return result;
}
