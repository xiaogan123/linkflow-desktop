import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowSquareOut,CaretDown,CaretRight,ChartBar,LinkSimple,MagnifyingGlass,Plus} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {discoverChannels} from '../../integrations/channel-discovery';
import {Button} from '../components';
import {dateLabel} from '../presentation';
import {channelMetricView} from '../channel-metrics';
import {linkRows} from '../links-model';
import {ACCESS_GROUPS,platformName,platformRows,platformSummary,platformTerms,type AccessGroup,type PlatformRow} from '../platforms-model';
import {SortHeading,sortTableRows,toggleTableSort,unsorted,type TableSort} from '../table-sort';
import {PageHeading} from './WorkspacePages';
import {AccountsPage} from './AccountsPage';
import {AddChannelDrawer,ChannelTaskAction,Drawer,MetricsDrawer} from './platform-drawers';
import {CHANNEL_RISK_COPY} from '../channel-risk-copy';
import {authorityCopy} from '../authority-copy';
import {connectionOverview} from '../channel-connections';
import {connectionAction} from '../account-guidance';
import {HTML_APP_PUBLIC_NOTICE_ACKNOWLEDGEMENT,HTML_APP_TERMS_URL} from '../../shared/html-app-notice';

type Action=<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>;
type Tab='platforms'|'accounts';
type Props={data:Snapshot;tab:Tab;onTab:(tab:Tab)=>void;initialConnect?:{channelId:string;nonce:number};onInitialConnectHandled?:()=>void;disabled:boolean;onAction:Action;onTask:(siteId:string)=>void;
  onImport:(channelId?:string)=>void;onEditAccount:(account:Account)=>void;onDeleteAccount:(account:Account)=>void;onSetup:()=>void};

const ALL='all';

export function PlatformsPage({data,tab,onTab,initialConnect,onInitialConnectHandled,disabled,onAction,onTask,onImport,onEditAccount,onDeleteAccount,onSetup}:Props){
  const sites=data.sites.filter(site=>!site.archivedAt);
  const [siteId,setSiteId]=useState(sites[0]?.id??ALL);
  const site=sites.find(item=>item.id===siteId);
  const [query,setQuery]=useState('');
  const [collapsed,setCollapsed]=useState<ReadonlySet<AccessGroup>>(new Set(['unqualified']));
  const [sort,setSort]=useState<TableSort>(unsorted);
  const [detail,setDetail]=useState('');
  const [toolDrawer,setToolDrawer]=useState<''|'add'|'metrics'>('');
  const [connectRequest,setConnectRequest]=useState<{channelId:string;nonce:number}|undefined>(initialConnect);
  // A request is used once: the accounts tab may consume it before this effect runs, so remember which one was handled.
  const handledNonce=useRef<number|undefined>(undefined);
  useEffect(()=>{if(initialConnect&&initialConnect.nonce!==handledNonce.current)setConnectRequest(initialConnect)},[initialConnect?.nonce]);
  useEffect(()=>{if(siteId!==ALL&&!site)setSiteId(sites[0]?.id??ALL)},[siteId,site,sites]);

  const links=useMemo(()=>linkRows(data),[data]);
  const rows=useMemo(()=>platformRows(data,site,links),[data,site,links]);
  const summary=platformSummary(rows);
  const term=query.trim().toLowerCase();
  const visible=rows.filter(row=>!term||`${row.channel.name} ${row.channel.domain}`.toLowerCase().includes(term));
  const value=(row:PlatformRow,key:string)=>key==='name'?platformName(row.channel):key==='summary'?(row.reason??row.oneLiner)
    :key==='dr'?channelMetricView(row.channel).dr:key==='results'?row.published*1000+row.active:row.action.kind;
  const connect=(channelId:string)=>{onTab('accounts');setConnectRequest({channelId,nonce:Date.now()})};
  // A connection request is used once; coming back to the accounts tab later must not reopen it.
  const switchTab=(next:Tab)=>{if(next==='platforms')setConnectRequest(undefined);onTab(next)};
  const toggle=(group:AccessGroup)=>setCollapsed(current=>{const next=new Set(current);if(next.has(group))next.delete(group);else next.add(group);return next});
  const detailRow=rows.find(row=>row.channel.id===detail);

  const heading=<PageHeading title="平台与账号" summary={`${site?`适合 ${site.domain}`:'全部网站'}：全自动 ${summary.automatic} 个 · 连一次后自动 ${summary.connected} 个 · 你来发 ${summary.manual} 个`}>
    <label className="filter-select inline-label"><span>看哪个网站：</span><select aria-label="看哪个网站" value={siteId} onChange={event=>setSiteId(event.target.value)}>
      {sites.map(item=><option key={item.id} value={item.id}>{item.domain}</option>)}<option value={ALL}>全部网站</option></select></label>
  </PageHeading>;

  return <div className="page platforms-page">{heading}
    <div className="filter-tabs workspace-tabs" role="group" aria-label="平台与账号">{([['platforms','平台'],['accounts','我的账号']] as const).map(([id,label])=>
      <button key={id} aria-pressed={tab===id} className={tab===id?'active':''} onClick={()=>switchTab(id)}>{label}</button>)}</div>

    {tab==='accounts'?<AccountsPage data={data} disabled={disabled} onImport={onImport} onEdit={onEditAccount} onDelete={onDeleteAccount} onAction={onAction} onSetup={onSetup} connectRequest={connectRequest} onConnectHandled={()=>{handledNonce.current=connectRequest?.nonce;setConnectRequest(undefined);onInitialConnectHandled?.()}}/>:<>
      <div className="tab-toolbar"><div className="search"><MagnifyingGlass size={17}/><input aria-label="搜索平台" placeholder="搜索平台名或域名" value={query} onChange={event=>setQuery(event.target.value)}/></div>
        <div className="toolbar-actions"><Button disabled={disabled} onClick={()=>setToolDrawer('metrics')}><ChartBar size={16}/>导入平台权重</Button><Button disabled={disabled} onClick={()=>setToolDrawer('add')}><Plus size={16}/>添加平台</Button></div></div>
      {ACCESS_GROUPS.map(group=>{
        const members=visible.filter(row=>row.group===group.id);
        if(!members.length||!site&&group.id==='unqualified')return null;
        const open=!collapsed.has(group.id);
        return <section key={group.id} className="panel platform-group">
          <button type="button" className="group-head" aria-expanded={open} onClick={()=>toggle(group.id)}>{open?<CaretDown size={15}/>:<CaretRight size={15}/>}<strong>{group.title}</strong><span className="group-count">{members.length} 个</span></button>
          {open&&group.note&&<p className="group-note">{group.note}</p>}
          {open&&<div className="table-scroll"><table className="work-table platform-table"><thead><tr>
            {[['name','平台'],['summary',group.id==='unqualified'?'为什么不适合':'怎么用'],['dr','权重'],['results','实绩'],['action','操作']].map(([key,label])=>
              <SortHeading key={key} column={key} sort={sort} onSort={column=>setSort(current=>toggleTableSort(current,column))}>{label}</SortHeading>)}</tr></thead>
            <tbody>{sortTableRows(members,sort,value).map(row=>{const metric=channelMetricView(row.channel);return <tr key={row.channel.id}>
              <td><Button variant="text" onClick={()=>setDetail(row.channel.id)}>{platformName(row.channel)}</Button><small className="cell-note">{row.channel.domain}</small></td>
              <td>{row.reason??row.oneLiner}</td>
              <td><div className="metric-cell"><strong>{metric.dr}</strong><small>{metric.subtitle}</small></div></td>
              <td>已发 {row.published} · 有效 {row.active}</td>
              <td><RowAction row={row} disabled={disabled} onConnect={connect} onDetail={()=>setDetail(row.channel.id)}/></td></tr>})}</tbody></table></div>}
        </section>;
      })}
      {!visible.length&&<p className="table-empty">没有符合条件的平台。</p>}
      <footer className="table-footnote"><span><LinkSimple size={14}/>{authorityCopy.attribution}<a href={authorityCopy.ahrefsUrl} onClick={event=>{event.preventDefault();if(!disabled)void onAction('external:open',{url:authorityCopy.ahrefsUrl})}}>{authorityCopy.ahrefsLink}</a></span></footer>
    </>}

    {detailRow&&<PlatformDetail row={detailRow} data={data} site={site} links={links} disabled={disabled} onAction={onAction} onTask={onTask} onConnect={id=>{setDetail('');connect(id)}} onClose={()=>setDetail('')}/>}
    {toolDrawer==='add'&&<AddChannelDrawer disabled={disabled} onClose={()=>setToolDrawer('')} onAction={onAction}/>}
    {toolDrawer==='metrics'&&<MetricsDrawer channels={data.channels} initialChannel={detail} disabled={disabled} onClose={()=>setToolDrawer('')} onAction={onAction}/>}
  </div>;
}

function RowAction({row,disabled,onConnect,onDetail}:{row:PlatformRow;disabled:boolean;onConnect:(channelId:string)=>void;onDetail:()=>void}){
  if(row.action.kind==='in_use')return <span className="badge green">在用</span>;
  if(row.action.kind==='manual')return <span className="badge blue">{row.group==='wallet'?'每篇你确认':'你来发'}</span>;
  if(row.action.kind==='confirm')return <Button disabled={disabled} onClick={onDetail}>去确认</Button>;
  if(row.action.kind==='unavailable')return <span className="badge muted" title={row.action.reason}>暂不可用</span>;
  if(row.action.kind==='disabled')return <span className="badge muted">已停用</span>;
  if(row.action.kind==='connect')return <Button disabled={disabled} onClick={()=>onConnect(row.channel.id)}>连接</Button>;
  if(row.action.kind==='verify')return <Button disabled={disabled} onClick={()=>onConnect(row.channel.id)}>去验证</Button>;
  return <span className="muted">—</span>;
}

const READ_ONLY_NOTES:Record<string,string>={
  markest:'只读验证不代表远端发布账号、个人或工作区归属、免费计划或公开写入权限。',
  deno:'应用读取不证明组织归属或发布权限；当前不会自动发布。',
  default:'此连接只证明读取能力，不能据此自动发布。',
};

export function PlatformDetail({row,data,site,links,disabled,onAction,onTask,onConnect,onClose}:{row:PlatformRow;data:Snapshot;site?:Snapshot['sites'][number];links:ReturnType<typeof linkRows>;disabled:boolean;onAction:Action;onTask:(siteId:string)=>void;onConnect:(channelId:string)=>void;onClose:()=>void}){
  const {channel}=row,terms=platformTerms(channel),metric=channelMetricView(channel),risk=CHANNEL_RISK_COPY[channel.id];
  const connection=connectionOverview(data).find(item=>item.id===channel.id);
  const readOnly=connection&&(connection.state==='read_only'||channel.id==='deno'||channel.id==='markest');
  // A disabled platform can still keep a read-only connection; it never publishes.
  const readOnlyConnect=!!connection&&row.action.kind==='disabled'&&!['no_setup','unavailable'].includes(connection.state);
  const recent=links.filter(link=>link.task.channelId===channel.id&&(!site||link.site.id===site.id)).slice(0,5);
  const discovery=site?discoverChannels(site,[channel])[0]:undefined;
  const open=(url:string)=>void onAction('external:open',{url});
  return <Drawer title={platformName(channel)} onClose={onClose}><div className="drawer-body platform-detail">
    <p className="drawer-intro">{!channel.enabled?'发布未启用：这个平台目前不会自动发布。':row.reason&&site?`不适合这个网站：${row.reason}。`:row.oneLiner}</p>
    <dl className="detail-list channel-evidence">
      <dt>能发金融内容</dt><dd>{terms.finance}</dd>
      <dt>能带推广链接</dt><dd>{terms.promotion}</dd>
      <dt>披露要求</dt><dd>{terms.disclosure}</dd>
      <dt>权重</dt><dd>{metric.dr}<small className="cell-note">{metric.subtitle}</small></dd>
      {metric.drAvailable&&<><dt>权重来源</dt><dd>{metric.authorityDetail}</dd></>}
      {channel.traffic&&<><dt>访问指标</dt><dd>{metric.trafficDetail}</dd></>}
      {risk&&<><dt>{risk.label}</dt><dd>{risk.detail}</dd></>}
      {connection&&<><dt>连接</dt><dd>{connection.detail}{readOnly&&<small className="cell-note">{READ_ONLY_NOTES[channel.id]??READ_ONLY_NOTES.default}</small>}</dd></>}
    </dl>
    {terms.sources.length>0&&<p className="cell-note">条款来源：{terms.sources.map(url=><Button key={url} variant="text" disabled={disabled} onClick={()=>open(url)}>{new URL(url).hostname}<ArrowSquareOut size={12}/></Button>)}{terms.checkedAt&&` · ${dateLabel(terms.checkedAt)} 核对`}</p>}
    <h3>最近的外链</h3>
    {recent.length?<ul className="recent-links">{recent.map(link=><li key={link.task.id}><Button variant="text" disabled={disabled} onClick={()=>open(link.url)}>{link.title}</Button><small className="cell-note">{link.site.domain} · {link.link}</small></li>)}</ul>
      :<p className="muted">这个平台还没有外链。</p>}
    {(row.action.kind==='connect'||row.action.kind==='verify')&&<Button variant="primary" disabled={disabled} onClick={()=>onConnect(channel.id)}>{row.action.kind==='verify'?'去验证':'连接'}</Button>}
    {row.action.kind==='unavailable'&&<p className="muted">暂不可用：{row.action.reason}。</p>}
    {row.action.kind==='confirm'&&<div className="banner warning"><span>发布后全文将完全公开，可能被抓取、复制或用于数据收集；免费服务不保证可用性或长期保留。确认一次后，外链助手才会用这个平台。</span>
      <Button variant="text" disabled={disabled} onClick={()=>open(HTML_APP_TERMS_URL)}>查看条款</Button>
      <Button variant="primary" disabled={disabled} onClick={()=>void onAction('channel:accept-html-app-public-notice',HTML_APP_PUBLIC_NOTICE_ACKNOWLEDGEMENT,'已记录确认。')}>我已阅读条款并了解</Button></div>}
    {readOnlyConnect&&connection&&<Button disabled={disabled} onClick={()=>onConnect(channel.id)}>{connectionAction(connection).label||'只读连接'}</Button>}
    {site&&row.group!=='unqualified'&&<ChannelTaskAction data={data} channel={channel} site={site} tasks={data.tasks} discovery={discovery} disabled={disabled} onAction={onAction} onTask={onTask}/>}
  </div></Drawer>;
}
