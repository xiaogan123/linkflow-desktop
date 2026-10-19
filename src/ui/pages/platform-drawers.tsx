import {useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {X} from '@phosphor-icons/react';
import type {Category,Channel,Qualification,Site,Snapshot,Task} from '../../shared/types';
import {publicationOpportunity,sourceKey} from '../../shared/publication';
import type {ChannelDiscovery} from '../../integrations/channel-discovery';
import {Button,Field} from '../components';
import {categoryText,channelReadinessForDisplay,dateLabel,kindText} from '../presentation';
import {qualificationLabels} from '../../integrations/eligibility';
import {buildChannelMetricRow,metricImportLinkScope,otherAuthorityNameError,type AuthorityChoice,type AuthorityScope} from '../channel-metrics';

type ExtendedChannel=Omit<Channel,'evidenceStatus'>&{requirements?:Qualification[];provenance?:string;evidenceStatus?:string};
type Action=<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>;
type Props={onAction:Action;onTask:(siteId:string)=>void};
const freeText:Record<string,string>={yes:'免费',conditional:'有条件免费',paid:'付费',unknown:'待核实'};

export function Drawer({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}){
  const closeRef=useRef(onClose);closeRef.current=onClose;
  useEffect(()=>{const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.isComposing)closeRef.current()};document.addEventListener('keydown',onKey);return()=>document.removeEventListener('keydown',onKey)},[]);return <div className="side-drawer-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><aside className="side-drawer" role="dialog" aria-modal="true" aria-label={title}><header><div><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18}/></button></header>{children}</aside></div>}
export function AddChannelDrawer({disabled,onClose,onAction}:{disabled:boolean;onClose:()=>void;onAction:Props['onAction']}){const [name,setName]=useState(''),[domain,setDomain]=useState(''),[submitUrl,setSubmitUrl]=useState(''),[rulesUrl,setRulesUrl]=useState(''),[category,setCategory]=useState<Category>('general'),[language,setLanguage]=useState('zh'),[kind,setKind]=useState<Channel['kind']>('directory'),[free,setFree]=useState<Channel['free']>('unknown'),[freeNote,setFreeNote]=useState(''),[notes,setNotes]=useState(''),[requirements,setRequirements]=useState<Qualification[]>([]);return <Drawer title="添加人工平台" onClose={onClose}><form className="drawer-form" onSubmit={async e=>{e.preventDefault();const result=await onAction('channel:save',{channel:{name,domain,submitUrl,categories:[category],languages:[language],kind,free,freeNote,rulesUrl,notes,requirements,enabled:true}},'人工平台已保存。');if(result)onClose()}}><p className="drawer-intro">新增条目只进入人工平台库，不会自动获得执行能力。</p><Field label="平台名称"><input required value={name} onChange={e=>setName(e.target.value)}/></Field><Field label="平台域名"><input required value={domain} onChange={e=>setDomain(e.target.value)} placeholder="example.com"/></Field><Field label="提交入口"><input type="url" required value={submitUrl} onChange={e=>setSubmitUrl(e.target.value)} placeholder="https://…"/></Field><Field label="官方规则"><input type="url" required value={rulesUrl} onChange={e=>setRulesUrl(e.target.value)} placeholder="https://…"/></Field><div className="form-grid"><Field label="类型"><select value={kind} onChange={e=>setKind(e.target.value as Channel['kind'])}>{Object.entries(kindText).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></Field><Field label="费用"><select value={free} onChange={e=>setFree(e.target.value as Channel['free'])}>{Object.entries(freeText).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></Field><Field label="网站类别"><select value={category} onChange={e=>setCategory(e.target.value as Category)}>{Object.entries(categoryText).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></Field><Field label="语言"><input value={language} onChange={e=>setLanguage(e.target.value)} placeholder="zh / en / any"/></Field></div><Field label="费用条件"><input required value={freeNote} onChange={e=>setFreeNote(e.target.value)} placeholder="说明免费、条件或收费边界"/></Field><fieldset className="checkbox-grid"><legend>实际资格要求</legend>{Object.entries(qualificationLabels).map(([id,label])=><label key={id}><input type="checkbox" checked={requirements.includes(id as Qualification)} onChange={e=>setRequirements(e.target.checked?[...requirements,id as Qualification]:requirements.filter(x=>x!==id))}/>{label}</label>)}</fieldset><Field label="使用说明"><textarea required rows={4} value={notes} onChange={e=>setNotes(e.target.value)} placeholder="适用对象、限制与提交方式"/></Field><div className="drawer-actions"><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={disabled}>保存为人工平台</Button></div></form></Drawer>}
export function MetricsDrawer({channels,initialChannel,disabled,onClose,onAction}:{channels:Channel[];initialChannel:string;disabled:boolean;onClose:()=>void;onAction:Props['onAction']}){
 const [channelId,setChannelId]=useState(initialChannel||channels[0]?.id||''),[authorityChoice,setAuthorityChoice]=useState<AuthorityChoice>('ahrefs_dr'),[otherName,setOtherName]=useState(''),[authorityValue,setAuthorityValue]=useState(''),[scope,setScope]=useState<AuthorityScope>('domain'),[target,setTarget]=useState(''),[traffic,setTraffic]=useState(''),[source,setSource]=useState(''),[asOf,setAsOf]=useState(''),[datePrecision,setDatePrecision]=useState<'day'|'month'>('day'),[dataMonth,setDataMonth]=useState(''),[checkedAt,setCheckedAt]=useState(new Date().toISOString().slice(0,10)),[estimated,setEstimated]=useState(true),[error,setError]=useState('');
 const authorityFilled=authorityValue.trim()!=='';
 const nameError=authorityChoice==='other'&&authorityFilled?otherAuthorityNameError(otherName):undefined;
 return <Drawer title="导入平台权重" onClose={onClose}><form className="drawer-form" onSubmit={async e=>{
  e.preventDefault();setError('');
  try{
   const selectedChannel=channels.find(channel=>channel.id===channelId);
   const linkScope=metricImportLinkScope(selectedChannel,target);
   const row=buildChannelMetricRow({channelId,authorityChoice,otherName,authorityValue,scope,target,traffic,source,asOf,estimated,datePrecision,dataMonth,checkedAt,linkScope});
   const result=await onAction('channel:import-metrics',{rows:[row]},'平台指标已导入。');if(result)onClose();
  }catch(reason){setError(reason instanceof Error?reason.message:'指标格式有误，请核对。')}
 }}>
  <p className="drawer-intro">填写实际查询结果、来源和日期。手工数据标记为“用户导入”；留空不覆盖旧值，已测得的 0 可以填写。</p>
  <Field label="平台"><select required value={channelId} onChange={e=>setChannelId(e.target.value)}>{channels.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
  <Field label="权威指标"><select value={authorityChoice} onChange={e=>{const choice=e.target.value as AuthorityChoice;setAuthorityChoice(choice);if(choice==='ahrefs_dr'&&scope==='page')setScope('domain')}}><option value="ahrefs_dr">Ahrefs DR（0–100）</option><option value="other">其他第三方指标</option></select></Field>
  {authorityChoice==='other'&&<Field label="指标完整名称"><input value={otherName} onChange={e=>setOtherName(e.target.value)} placeholder="例如 OpenPageRank（不是 Google PR）" required={authorityFilled}/></Field>}
  <Field label={authorityChoice==='ahrefs_dr'?'DR 值':'权威值'}><input type="number" min="0" max="100" step="any" value={authorityValue} onChange={e=>setAuthorityValue(e.target.value)} placeholder="未知请留空"/></Field>
  <div className="form-grid"><Field label="测量范围"><select value={scope} onChange={e=>setScope(e.target.value as AuthorityScope)}><option value="domain">域名</option><option value="subdomain">子域名</option>{authorityChoice==='other'&&<option value="page">页面</option>}</select></Field><Field label="实际测量对象"><input required={authorityFilled} value={target} onChange={e=>setTarget(e.target.value)} placeholder={scope==='page'?'https://example.com/article':'实际查询的域名，非发布页'}/></Field></div>
  {nameError&&<p role="alert">{nameError}</p>}{error&&<p role="alert">{error}</p>}
  <Field label="月访问量"><input type="number" min="0" value={traffic} onChange={e=>setTraffic(e.target.value)} placeholder="未知请留空"/></Field>
  <label className="checkbox"><input type="checkbox" checked={estimated} onChange={e=>setEstimated(e.target.checked)}/>流量为第三方估算</label>
  <Field label="来源网址"><input type="url" required value={source} onChange={e=>setSource(e.target.value)} placeholder="https://数据来源"/></Field>
  <Field label="来源日期精度"><select value={datePrecision} onChange={e=>setDatePrecision(e.target.value as 'day'|'month')}><option value="day">来源提供具体日期</option><option value="month">来源仅提供月份</option></select></Field>
  {datePrecision==='month'?<div className="form-grid"><Field label="数据月份"><input type="month" required value={dataMonth} onChange={e=>setDataMonth(e.target.value)}/></Field><Field label="核查日期"><input type="date" required value={checkedAt} onChange={e=>setCheckedAt(e.target.value)}/></Field></div>:<Field label="数据日期"><input type="date" required value={asOf} onChange={e=>setAsOf(e.target.value)}/></Field>}
  <div className="drawer-actions"><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={disabled||!!nameError||(!authorityFilled&&!traffic.trim())}>导入指标</Button></div>
 </form></Drawer>;
}

export function ChannelTaskAction({data,channel,site,tasks,discovery,disabled,onAction,onTask}:{data:Snapshot|null;channel:ExtendedChannel;site?:Site;tasks:Task[];discovery?:ChannelDiscovery;disabled:boolean;onAction:Props['onAction'];onTask:Props['onTask']}){
  const readiness=site&&data?channelReadinessForDisplay(data,site,channel as Channel):undefined;
  const candidate=channel.automation==='manual'?({...channel,free:'yes'} as Channel):channel as Channel;
  const opportunity=site&&data?publicationOpportunity(site,candidate,tasks,new Date(),data.settings.timezone,{officialApiConnected:readiness==='ready'}):undefined;
  const related=site?tasks.filter(task=>task.siteId===site.id&&(task.channelId===channel.id||sourceKey(task.sourceDomain)===sourceKey(channel.domain))):[];
  const existing=opportunity&&!opportunity.allowed&&!opportunity.repeat?related[0]:undefined;
  const time=(value:string|undefined)=>{if(!value||!data)return;const date=new Date(value);if(Number.isNaN(date.getTime()))return;try{return new Intl.DateTimeFormat('zh-CN',{timeZone:data.settings.timezone,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(date)}catch{return dateLabel(value)}};
  const nextAt=time(opportunity?.nextAvailableAt),scheduledAt=time(opportunity?.scheduledAt);
  const blockedMessage=!site?'先在上方选择网站，再建立提交任务。':!discovery?.canQueue?discovery?.nextStep??'当前网站尚不能使用此平台。':site.status!=='ready'?'请先完成网站分析并恢复网站计划。':channel.automation!=='manual'&&(channel.free==='paid'||channel.free==='unknown')?'此平台费用不符合自动计划条件。':opportunity&&!opportunity.allowed?`${opportunity.reason}${nextAt?` 下次可排：${nextAt}。`:''}`:'';
  const availableMessage=opportunity?.allowed?(opportunity.repeat?`${opportunity.reason}${scheduledAt?` 将按 ${scheduledAt} 排期。`:''}`:channel.automation==='manual'?'外链助手写好稿件 → 你到平台发布 → 填回外链地址 → 外链助手检查链接。付费或特殊资格以平台说明为准。':'加入后按现在的设置排进计划，发出后会检查链接。'):'';
  return <div className="channel-task-action"><p>{blockedMessage||availableMessage}</p>{existing&&site?<Button disabled={disabled} onClick={()=>onTask(site.id)}>查看已有任务</Button>:<Button variant="primary" disabled={disabled||!!blockedMessage} onClick={async()=>{if(!site)return;const result=await onAction('site:queue-channel',{id:site.id,channelId:channel.id},channel.automation==='manual'?'已建立人工待办，可继续准备材料。':'平台已加入计划。');if(result)onTask(site.id)}}>{channel.automation==='manual'?'建立人工待办':'加入执行计划'}</Button>}</div>;
}
