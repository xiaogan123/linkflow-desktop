import {useEffect,useMemo,useRef,useState} from 'react';
import {MagnifyingGlass,Plus,ShieldCheck,X} from '@phosphor-icons/react';
import type {ConnectionChannelId,ConnectionOverviewRow} from '../channel-connections';
import {activateGuideSelection,connectionAction,groupConnections,type ConnectionGroup} from '../account-guidance';
import {Button,Empty} from '../components';

const states={no_setup:'任务自动准备',first_connection:'需要首次连接',attention:'需要处理',connected:'已连接',read_only:'仅只读验证',unavailable:'当前未启用'};
const headings:Record<Exclude<ConnectionGroup,'secondary'>,{title:string;description:string}>={
  attention:{title:'需要处理',description:'沿用原身份继续，避免重复注册或覆盖历史任务。'},
  connectable:{title:'需要本人首次连接',description:'只连接当前准备使用的平台，不必先注册全部渠道。'},
  connected:{title:'已有连接',description:'已验证身份仍需按下方状态确认网站关联或平台资格。'},
  automatic:{title:'任务会自动准备',description:'这些渠道无需提前导入账号；任务实际需要时才会准备身份或本机凭据。'},
};

type ActionProps={row:ConnectionOverviewRow;disabled:boolean;onConnect:(id:ConnectionChannelId,accountId?:string)=>void;onLocate:(row:ConnectionOverviewRow)=>void};
function RowAction({row,disabled,onConnect,onLocate}:ActionProps){
  const action=connectionAction(row);
  if(action.kind==='none')return <span className="connection-auto">{row.state==='no_setup'?'无需预先注册':row.state==='unavailable'?'不会自动发布':'暂无操作'}</span>;
  return <Button disabled={disabled} variant={action.kind==='locate'?'text':'secondary'} onClick={()=>action.kind==='locate'?onLocate(row):onConnect(row.id,row.attentionAccountId)}>{action.label}</Button>;
}

function ConnectionRow({row,...actions}:ActionProps){
  const readOnlyNote=row.id==='markest'?'只读验证不代表远端身份、个人或工作区归属、免费计划或公开写入权限。':row.id==='deno'?'应用读取不证明组织归属或发布权限；当前不会自动发布。':'此连接只证明读取能力，不能据此自动发布。';
  return <div className={`connection-overview-row state-${row.state}`} data-channel={row.id}><div className="connection-overview-name"><strong>{row.name}</strong><small>{row.format}</small></div><div className="connection-overview-description"><span className={`connection-state ${row.state}`}>{states[row.state]}</span><span>{row.detail}</span>{(row.state==='read_only'||row.id==='deno'||row.id==='markest')&&<small>{readOnlyNote}</small>}</div><div className="connection-overview-actions"><RowAction row={row} {...actions}/></div></div>;
}

export function AccountConnectionSummary({connections,disabled,accountCount,onStart,onConnect,onLocate}:{connections:ConnectionOverviewRow[];disabled:boolean;accountCount:number;onStart:()=>void;onConnect:ActionProps['onConnect'];onLocate:ActionProps['onLocate']}){
  const groups=groupConnections(connections),actions={disabled,onConnect,onLocate};
  const primary=(['attention','connectable','connected'] as const).filter(group=>groups[group].length>0);
  return <section className="panel connection-overview guided-connections" aria-labelledby="connection-overview-title"><div className="connection-start"><div><span className="eyebrow">ACCOUNT SETUP · 账号接入</span><h2 id="connection-overview-title">先选平台，再按一步完成连接</h2><p>软件会打开对应平台的专用连接表单。API、OAuth、SSH 和只读渠道不会落入普通密码导入。</p></div><Button variant="primary" onClick={onStart} disabled={disabled}><Plus size={15}/>添加 / 连接账号</Button></div>{accountCount===0&&<div className="account-empty-guide"><ShieldCheck size={18}/><div><strong>现在不用注册所有平台</strong><p>{groups.automatic.length} 个渠道会在任务需要时自动准备；{groups.connectable.length} 个渠道必须由本人首次连接。先添加网站也可以，系统会在真正需要账号时提示。</p></div></div>}
    {primary.map(group=><div className={`connection-section connection-section-${group}`} key={group}><div className="connection-section-heading"><div><h3>{headings[group].title}</h3><p>{headings[group].description}</p></div><span>{groups[group].length}</span></div><div className="connection-overview-list">{groups[group].map(row=><ConnectionRow key={row.id} row={row} {...actions}/>)}</div></div>)}
    {groups.automatic.length>0&&<details className="connection-collapsible" open={accountCount===0}><summary><span><strong>{headings.automatic.title}</strong><small>{headings.automatic.description}</small></span><b>{groups.automatic.length}</b></summary><div className="connection-overview-list">{groups.automatic.map(row=><ConnectionRow key={row.id} row={row} {...actions}/>)}</div></details>}
    {groups.secondary.length>0&&<details className="connection-collapsible secondary-connections"><summary><span><strong>只读验证或当前未启用</strong><small>集中保留状态与历史；这里的连接不代表可发布。</small></span><b>{groups.secondary.length}</b></summary><div className="connection-overview-list">{groups.secondary.map(row=><ConnectionRow key={row.id} row={row} {...actions}/>)}</div></details>}
    <p className="connection-overview-footnote">“已连接”只表示本机身份验证状态；公开发布结果仍会单独核验。</p></section>;
}

export function AccountConnectionGuide({connections,disabled,hasSites,onClose,onConnect,onLocate,onImport,onAddSite}:{connections:ConnectionOverviewRow[];disabled:boolean;hasSites:boolean;onClose:()=>void;onConnect:ActionProps['onConnect'];onLocate:ActionProps['onLocate'];onImport:(channelId?:string)=>void;onAddSite:()=>void}){
  const [query,setQuery]=useState(''),[selectedId,setSelectedId]=useState<ConnectionChannelId|''>('');
  const input=useRef<HTMLInputElement>(null),close=useRef(onClose),filtered=useMemo(()=>connections.filter(row=>`${row.name} ${row.id} ${row.detail}`.toLowerCase().includes(query.trim().toLowerCase())),[connections,query]);
  close.current=onClose;
  const selected=connections.find(row=>row.id===selectedId),action=selected?connectionAction(selected):undefined;
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;input.current?.focus();const key=(event:KeyboardEvent)=>{if(event.key==='Escape')close.current()};document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);previous?.focus()}},[]);
  const groups=groupConnections(filtered);
  const ordered=[...groups.attention,...groups.connectable,...groups.connected,...groups.automatic,...groups.secondary];
  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><aside className="side-drawer account-guide-drawer" role="dialog" aria-modal="true" aria-label="添加或连接账号"><header><div><span className="eyebrow">ADD ACCOUNT / 添加账号</span><h2>选择准备使用的平台</h2></div><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={18}/></button></header><div className="drawer-form"><p className="drawer-intro">选择一个平台后，只显示该平台的连接方式。无需为了备用一次注册所有平台。</p><div className="account-guide-search"><MagnifyingGlass size={16}/><input ref={input} aria-label="搜索连接平台" placeholder="搜索平台名称" value={query} onChange={event=>{setQuery(event.target.value);setSelectedId('')}}/></div>{ordered.length?<div className="platform-picker" role="listbox" aria-label="发布平台">{ordered.map(row=><button type="button" role="option" aria-selected={selectedId===row.id} className={selectedId===row.id?'selected':''} key={row.id} onClick={()=>setSelectedId(row.id)}><span><strong>{row.name}</strong><small>{row.format} · {states[row.state]}</small></span><i className={`state-dot ${row.state}`}/></button>)}</div>:<Empty title="没有匹配的平台" body="试试平台名称，或使用下方普通账号导入。"/>}{selected&&<section className="platform-selection" aria-live="polite"><span className={`connection-state ${selected.state}`}>{states[selected.state]}</span><h3>{selected.name}</h3><p>{selected.detail}</p>{(selected.state==='read_only'||selected.id==='deno'||selected.id==='markest')&&<p className="platform-warning">只读验证不代表可发布；当前不会自动发文。</p>}{action&&action.kind!=='none'&&<Button variant="primary" disabled={disabled} onClick={()=>activateGuideSelection(selected,{close:onClose,connect:onConnect,locate:onLocate})}>{action.label}</Button>}{action?.kind==='none'&&selected.state==='no_setup'&&<p className="platform-ready">无需导入账号。添加网站后，任务真正需要时会自动准备。</p>}{!hasSites&&selected.state!=='unavailable'&&<Button disabled={disabled} onClick={()=>{onClose();onAddSite()}}>先添加网站</Button>}</section>}<div className="generic-import"><div><strong>普通登录账号</strong><small>仅用于没有专用 API、OAuth 或 SSH 连接的渠道；保存后仍需确认平台状态。</small></div><Button disabled={disabled} onClick={()=>{onClose();onImport()}}>导入普通账号</Button></div></div></aside></div>;
}
