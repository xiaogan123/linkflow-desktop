import {useMemo,useState} from 'react';
import {ArrowClockwise,ArrowSquareOut,CheckCircle,Clock,FileText,Funnel,LinkSimple,MagnifyingGlass,PencilSimple,Play,WarningCircle} from '@phosphor-icons/react';
import type {Channel,Site,Snapshot,Task,TaskStatus} from '../../shared/types';
import {Button,Empty} from '../components';
import {dateLabel} from '../presentation';

const statusText:Record<TaskStatus,string>={queued:'等待执行',running:'执行中',needs_input:'需要处理',review:'等待确认',live:'当前有效',failed:'执行失败',skipped:'已跳过',expired:'审核超时'};
const statusTone:Record<TaskStatus,string>={queued:'muted',running:'blue',needs_input:'amber',review:'blue',live:'green',failed:'red',skipped:'muted',expired:'amber'};
const actionStates=new Set<TaskStatus>(['needs_input','failed','expired']);

type Props={data:Snapshot|null;disabled:boolean;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>;onEditDraft:(task:Task)=>void;onSetUrl:(task:Task)=>void;onSite:(id:string)=>void};

export function TaskCenter({data,disabled,onAction,onEditDraft,onSetUrl,onSite}:Props){
  const [query,setQuery]=useState(''),[status,setStatus]=useState('active'),[siteId,setSiteId]=useState('all'),[expanded,setExpanded]=useState('');
  const rows=useMemo(()=>{
    const sites=new Map((data?.sites??[]).map(site=>[site.id,site]));
    const channels=new Map((data?.channels??[]).map(channel=>[channel.id,channel]));
    return (data?.tasks??[]).filter(task=>{
      const haystack=`${sites.get(task.siteId)?.domain??''} ${channels.get(task.channelId)?.name??''} ${task.sourceDomain} ${task.message}`.toLowerCase();
      const statusMatch=status==='all'||status==='active'&&['queued','running','review'].includes(task.status)||status==='attention'&&actionStates.has(task.status)||status==='results'&&!!task.publicUrl;
      return haystack.includes(query.toLowerCase())&&(siteId==='all'||task.siteId===siteId)&&statusMatch;
    }).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  },[data,query,status,siteId]);
  const channelFor=(task:Task):Channel|undefined=>data?.channels.find(channel=>channel.id===task.channelId);
  const siteFor=(task:Task):Site|undefined=>data?.sites.find(site=>site.id===task.siteId);
  return <div className="page task-center-page">
    <div className="page-heading compact-heading"><div><div className="eyebrow">WORK QUEUE / 任务中心</div><h1>从待办到公开成果。</h1><p>跨网站查看执行、审核、恢复和已核验结果。</p></div><div className="heading-seal"><Clock size={17}/>{data?.runtime.busy?'正在执行任务':'当前队列已同步'}</div></div>
    <div className="task-kpis">
      <Metric label="正在推进" value={(data?.tasks??[]).filter(t=>['queued','running','review'].includes(t.status)).length} tone="blue"/>
      <Metric label="需要处理" value={(data?.tasks??[]).filter(t=>actionStates.has(t.status)).length} tone="amber"/>
      <Metric label="当前有效" value={(data?.tasks??[]).filter(t=>t.status==='live'&&t.health==='healthy'&&t.linkCheck==='found').length} tone="green"/>
      <Metric label="公开成果" value={(data?.tasks??[]).filter(t=>!!t.publicUrl).length}/>
    </div>
    <section className="panel directory-panel task-directory">
      <div className="directory-toolbar"><div className="search"><MagnifyingGlass size={17}/><input aria-label="搜索任务" placeholder="搜索网站、渠道或任务说明" value={query} onChange={e=>setQuery(e.target.value)}/></div><div className="filter-select"><Funnel size={15}/><select aria-label="筛选网站" value={siteId} onChange={e=>setSiteId(e.target.value)}><option value="all">全部网站</option>{data?.sites.map(site=><option key={site.id} value={site.id}>{site.domain}</option>)}</select></div><div className="filter-tabs task-filter-tabs" role="group" aria-label="筛选任务状态">{[['active','推进中'],['attention','需处理'],['results','有成果'],['all','全部']].map(([key,label])=><button key={key} className={status===key?'active':''} aria-pressed={status===key} onClick={()=>setStatus(key)}>{label}</button>)}</div></div>
      {rows.length?<div className="task-table-wrap"><table className="work-table"><thead><tr><th>网站 / 渠道</th><th>状态</th><th>公开结果</th><th>最新进展</th><th>操作</th></tr></thead><tbody>{rows.map(task=>{
        const site=siteFor(task),channel=channelFor(task),open=expanded===task.id;
        return <tr key={task.id} className={open?'row-expanded':''}><td><button className="work-identity" onClick={()=>setExpanded(open?'':task.id)} aria-expanded={open}><span className={`timeline-dot ${statusTone[task.status]}`}/><span><strong>{site?.domain??'未知网站'}</strong><small>{channel?.name??task.sourceDomain} · {channel?.automation==='api'?'API':channel?.automation==='browser'?'资料页流程':'人工渠道'}</small></span></button>{open&&<TaskDetails task={task} channel={channel}/>}</td><td><span className={`badge ${statusTone[task.status]}`}>{task.status==='live'&&task.health==='unknown'?'待重新确认':statusText[task.status]}</span>{task.linkCheck&&<small className="cell-note">网页核验：{task.linkCheck==='found'?'存在':task.linkCheck==='absent'?'未发现':task.linkCheck==='unreachable'?'暂不可达':'地址不合规'}</small>}</td><td>{task.publicUrl?<button className="result-link" disabled={disabled} onClick={()=>void onAction('task:open-result',{id:task.id})}><LinkSimple size={14}/><span>{task.sourceDomain}</span><ArrowSquareOut size={13}/></button>:<span className="unknown-value">尚无公开地址</span>}<small className="cell-note">{task.publicationMethod==='external'?'外部发布后接回':task.publicUrl?'客户端任务产出':'等待发布'}</small></td><td><span className="message-cell">{task.message||'暂无进展说明'}</span><small className="cell-note">{dateLabel(task.updatedAt)}</small></td><td><div className="row-actions">{task.publicUrl&&<button className="icon-button" title="查看公开结果" aria-label="查看公开结果" disabled={disabled} onClick={()=>void onAction('task:open-result',{id:task.id})}><ArrowSquareOut size={17}/></button>}<button className="icon-button" title="继续任务" aria-label="继续任务" disabled={disabled} onClick={()=>void onAction('task:open',{id:task.id})}><Play size={17}/></button><button className="icon-button" title="编辑稿件" aria-label="编辑稿件" disabled={disabled} onClick={()=>onEditDraft(task)}><PencilSimple size={17}/></button><button className="icon-button" title="核验公开链接" aria-label="核验公开链接" disabled={disabled||!task.publicUrl} onClick={()=>void onAction('task:verify',{id:task.id},'已完成链接核验。')}><CheckCircle size={17}/></button></div>{open&&<div className="expanded-actions"><Button variant="text" onClick={()=>onSite(task.siteId)}>网站详情</Button><Button variant="text" onClick={()=>onSetUrl(task)}>填写公开地址</Button>{actionStates.has(task.status)&&<Button variant="text" onClick={()=>void onAction('task:retry',{id:task.id},'已安排任务继续处理。')}><ArrowClockwise size={14}/>受控重试</Button>}</div>}</td></tr>;
      })}</tbody></table></div>:<Empty icon={FileText} title="没有匹配的任务" body="调整网站、状态或搜索词。"/>}
    </section>
  </div>;
}

function Metric({label,value,tone='muted'}:{label:string;value:number;tone?:string}){return <div className="task-kpi"><span className={`kpi-dot ${tone}`}/><strong>{value}</strong><small>{label}</small></div>}
function TaskDetails({task,channel}:{task:Task;channel?:Channel}){return <div className="inline-task-detail"><p>{task.reason||channel?.qualityReason||'按渠道规则推进。'}</p><dl><dt>任务来源</dt><dd>{task.publicationMethod==='external'?'外部接回':'客户端创建'}</dd><dt>身份归属</dt><dd>{task.accountId?'已绑定账号':'尚未绑定账号'}</dd><dt>链接健康</dt><dd>{task.health==='healthy'?'当前健康':task.health==='missing'?'本次未发现':task.health==='pending'?'等待核验':'未知'}</dd><dt>下一次检查</dt><dd>{dateLabel(task.nextCheckAt)}</dd><dt>AI 调用</dt><dd>{task.cost?`${task.cost.aiCalls} 次${task.cost.durationMs?` · ${Math.round(task.cost.durationMs/1000)} 秒`:''}${task.cost.amount!==undefined?` · ${task.cost.currency??''} ${task.cost.amount}`:' · 金额未知'}`:'尚未记录'}</dd></dl>{task.history?.length?<div className="task-history"><strong>最近事件</strong>{task.history.slice(-3).reverse().map((item,index)=><span key={`${item.at}-${index}`}>{dateLabel(item.at)} · {item.message}</span>)}</div>:null}{task.draft&&<p className="draft-preview"><FileText size={14}/>{task.draft.title||'未命名稿件'} · {task.articleApprovedAt?'已确认':'待确认'}</p>}</div>}
