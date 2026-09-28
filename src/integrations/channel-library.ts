import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Channel,Qualification} from '../shared/types';
import {qualificationLabels} from './eligibility';

export type ChannelMetrics={authority?:Channel['authority'];traffic?:Channel['traffic']};
const categories=z.enum(['software','ai','developer','design','business','content','education','finance','general']);
const host=z.string().trim().toLowerCase().max(253).refine(value=>{
 if(!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(value))return false;
 return !/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(value);
},'请填写公开渠道的域名');
const httpsUrl=z.string().trim().max(2048).refine(value=>{
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&host.safeParse(u.hostname).success&&![...u.searchParams.keys()].some(key=>/^(?:token|api[_-]?key|password|secret|access_token)$/i.test(key))}catch{return false}
},'需要不含凭据的公开 HTTPS 网址');
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
}).strict();
const Authority=z.object({name:z.string().trim().min(1).max(80),value:z.number().finite().min(0).max(100),source:httpsUrl,asOf:date,scope:z.enum(['domain','subdomain','page']).optional()}).strict();
const Traffic=z.object({monthly:z.number().finite().int().min(0).max(1e13),source:httpsUrl,asOf:date,region:z.string().trim().max(80).optional(),period:z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/).optional(),metric:z.enum(['visits','organicVisits']).optional(),estimated:z.boolean().optional()}).strict().refine(value=>!value.period||value.period<=value.asOf.slice(0,7),'流量月份不能晚于核查日期所在月份');
export const MetricRows=z.array(z.object({channelId:z.string().min(1).max(100),authority:Authority.nullable().optional(),traffic:Traffic.nullable().optional()}).strict().refine(x=>x.authority!==undefined||x.traffic!==undefined,'每行需要权重或流量数据')).min(1).max(1000);

export function composeChannels(builtins:Channel[],custom:Channel[]=[],metrics:Record<string,ChannelMetrics>={}):Channel[]{
 const ids=new Set(builtins.map(c=>c.id));
 const extras=custom.filter(c=>c.id.startsWith('custom-')&&!ids.has(c.id)&&c.automation==='manual').map(c=>({...c,automation:'manual' as const,provenance:'custom' as const,evidenceStatus:'user_added' as const}));
 return [...builtins,...extras].map(c=>({...c,...(metrics[c.id]??{})}));
}
export function saveCustomChannel(current:Channel[],input:unknown,builtins:Channel[]):Channel[]{
 const d=CustomChannelInput.parse(input);const id=d.id??'custom-'+randomUUID();
 if(builtins.some(c=>c.id===id))throw Error('内置渠道不可通过自定义渠道入口修改');
 if(d.id&&!current.some(c=>c.id===id))throw Error('自定义渠道不存在');
 if(!d.id&&current.length>=1000)throw Error('自定义渠道已达 1000 条，请先整理现有渠道');
 const submitHost=new URL(d.submitUrl).hostname;
 if(submitHost!==d.domain&&!submitHost.endsWith('.'+d.domain))throw Error('投稿入口必须属于填写的渠道域名');
 if([...builtins,...current].some(c=>c.id!==id&&c.domain.replace(/^www\./,'')===d.domain.replace(/^www\./,'')))throw Error('该域名已有渠道，请使用现有条目避免重复来源');
 const channel:Channel={...d,id,url:'https://'+d.domain+'/',languages:[...new Set(d.languages.map(x=>x.toLowerCase()))],categories:[...new Set(d.categories)],requirements:[...new Set(d.requirements??[])],
  accountRequired:true,emailRequired:true,articleRequired:d.kind==='article',automation:'manual',quality:'C',qualityReason:'用户自行添加，适配性及平台规则尚未由内置目录核查。',checkedAt:'',allowedHosts:[...new Set([d.domain,submitHost])],enabled:d.enabled??true,provenance:'custom',evidenceStatus:'user_added'};
 return [...current.filter(c=>c.id!==id),channel];
}
export function deleteCustomChannel(current:Channel[],id:string,usedIds:string[]=[]):Channel[]{
 if(!current.some(c=>c.id===id))throw Error('自定义渠道不存在');
 if(usedIds.includes(id))throw Error('该渠道已有任务记录，请停用渠道以保留历史关联');
 return current.filter(c=>c.id!==id);
}
export function importChannelMetrics(current:Record<string,ChannelMetrics>,input:unknown,channels:Channel[]):Record<string,ChannelMetrics>{
 const rows=MetricRows.parse(input);const allowed=new Set(channels.map(c=>c.id));const ids=new Set<string>();
 for(const row of rows){if(!allowed.has(row.channelId))throw Error('指标对应的渠道不存在');if(ids.has(row.channelId))throw Error('导入包含重复渠道，请先合并同一渠道的指标');ids.add(row.channelId)}
 const result=structuredClone(current);
 for(const {channelId,authority,traffic}of rows){
  const next={...result[channelId]};
  if(authority===null)delete next.authority;else if(authority!==undefined)next.authority=authority;
  if(traffic===null)delete next.traffic;else if(traffic!==undefined)next.traffic={estimated:true,metric:'visits',region:'全球',...traffic};
  result[channelId]=next;
 }
 return result;
}
