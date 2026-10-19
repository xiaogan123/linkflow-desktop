import {useMemo, useState} from 'react';
import {displayParts} from '../display-time';
import {DownloadSimple, LinkSimple, MagnifyingGlass, UploadSimple} from '@phosphor-icons/react';
import type {Snapshot} from '../../shared/types';
import {Button, Empty} from '../components';
import {SortHeading, sortTableRows, toggleTableSort, unsorted, type TableSort} from '../table-sort';
import {googleReportStale, linkRows, linksCsv, linksSummary, platformStats, type LinkRow} from '../links-model';
import {buildTrackingRows} from '../search-tracking';
import {PageHeading} from './WorkspacePages';

type Tab = 'all' | 'platforms' | 'google';
type Action = <T>(command: string, payload?: unknown, success?: string) => Promise<T | undefined>;

const monthDay = (value?: string) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = displayParts(date);
  return `${parts.month}月${parts.day}日`;
};
const percent = (value: number) => `${Math.round(value * 100)}%`;

function useSort() {
  const [sort, setSort] = useState<TableSort>(unsorted);
  return {sort, onSort: (column: string) => setSort(current => toggleTableSort(current, column))};
}

export function LinksPage({data, now, disabled, initialSiteId = 'all', onAction, onSite}: {data: Snapshot; now: Date; disabled: boolean; initialSiteId?: string; onAction: Action; onSite: (id: string) => void}) {
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [siteId, setSiteId] = useState(initialSiteId);
  const [showMarkers, setShowMarkers] = useState(false);
  const [message, setMessage] = useState('');
  const rows = useMemo(() => linkRows(data), [data]);
  const summary = linksSummary(rows);
  const markers = (data.remoteContentTodos ?? []).filter(item => item.kind === 'legacy_marker');
  const allSort = useSort(), platformSort = useSort(), googleSort = useSort();

  const visible = rows.filter(row => (siteId === 'all' || row.site.id === siteId) &&
    (!query.trim() || `${row.site.domain} ${row.platform} ${row.title} ${row.url}`.toLowerCase().includes(query.trim().toLowerCase())));
  const allValue = (row: LinkRow, key: string) => key === 'site' ? row.site.domain : key === 'platform' ? row.platform : key === 'title' ? row.title
    : key === 'date' ? row.publishedAt ?? '' : key === 'link' ? row.link : key === 'rel' ? Number(row.passesWeight)
      : key === 'google' ? Number(row.inGoogle) : row.lastCheckedAt ?? '';
  const stats = platformStats(data, rows);
  const google = buildTrackingRows(data.sites.filter(site => !site.archivedAt), data.tasks);

  const exportCsv = () => {
    const blob = new Blob(['﻿' + linksCsv(visible)], {type: 'text/csv;charset=utf-8'});
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `外链-${now.toISOString().slice(0, 10)}.csv`;
    link.click();
    // Revoke after the download has been handed off, not in the same tick.
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  };
  const importReports = async () => {
    setMessage('');
    const result = await onAction<{imported: Array<{domain: string}>; unassigned: string[]; cancelled?: boolean}>('search:import-gsc-batch');
    if (!result || result.cancelled) return;
    const parts = [result.imported.length ? `已导入 ${result.imported.length} 个网站的 Google 报告。` : '没有导入任何报告。'];
    if (result.unassigned.length) parts.push(`这些文件里没有本软件发出的外链，没法分到网站：${result.unassigned.join('、')}`);
    setMessage(parts.join(''));
  };

  const heading = <PageHeading title="外链" summary={`共 ${summary.total} 条 · 现在有效 ${summary.active} 条 · 可传权重 ${summary.weight} 条${summary.temporary ? ` · 临时页 ${summary.temporary} 条（不计入每月目标）` : ''}`}>
    {tab === 'all' && rows.length > 0 && <Button onClick={exportCsv}><DownloadSimple size={16} />导出 CSV</Button>}
  </PageHeading>;

  if (!rows.length && tab !== 'google') return <div className="page links-page">{heading}
    <Empty icon={LinkSimple} title="还没有外链" body="外链助手发出第一篇后，这里会列出所有外链和它们现在的状态。" /></div>;

  return <div className="page links-page">{heading}
    <p className="page-note">Google 报告里没出现不代表外链失效，新外链通常要几周才会出现。</p>
    {markers.length > 0 && <div className="banner warning"><span>有 {markers.length} 篇早期外链的页面里带有旧的工具标记，建议到平台修改。</span>
      <Button variant="text" onClick={() => setShowMarkers(value => !value)}>{showMarkers ? '收起' : '查看'}</Button></div>}
    {showMarkers && <section className="panel marker-list"><ul>{markers.map(item => <li key={item.taskId}>
      <Button variant="text" disabled={disabled} onClick={() => void onAction('external:open', {url: item.publicUrl})}>{item.publicUrl}</Button></li>)}</ul></section>}
    <div className="filter-tabs workspace-tabs" role="group" aria-label="外链视图">{([['all', '全部外链'], ['platforms', '按平台看'], ['google', 'Google 报告']] as const).map(([id, label]) =>
      <button key={id} aria-pressed={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>

    {tab === 'all' && <section className="panel">
      <div className="directory-toolbar"><div className="search"><MagnifyingGlass size={17} />
        <input placeholder="搜索网站、平台或文章" aria-label="搜索外链" value={query} onChange={event => setQuery(event.target.value)} /></div>
        <label className="filter-select"><select aria-label="按网站筛选" value={siteId} onChange={event => setSiteId(event.target.value)}><option value="all">全部网站</option>
          {data.sites.map(site => <option key={site.id} value={site.id}>{site.domain}</option>)}</select></label></div>
      <div className="table-scroll"><table className="work-table"><thead><tr>
        {[['site', '网站'], ['platform', '平台'], ['title', '文章'], ['date', '发布日期'], ['link', '链接'], ['rel', '属性'], ['google', 'Google 报告'], ['checked', '上次检查']].map(([key, label]) =>
          <SortHeading key={key} column={key} sort={allSort.sort} onSort={allSort.onSort}>{label}</SortHeading>)}</tr></thead>
        <tbody>{sortTableRows(visible, allSort.sort, allValue).map(row => <tr key={row.task.id}>
          <td><Button variant="text" onClick={() => onSite(row.site.id)}>{row.site.domain}</Button></td>
          <td>{row.platform}</td>
          <td><Button variant="text" disabled={disabled} onClick={() => void onAction('external:open', {url: row.url})}>{row.title}</Button></td>
          <td>{monthDay(row.publishedAt)}</td>
          <td>{row.link}{row.expiresAt && <small className="cell-note">{monthDay(row.expiresAt)}到期</small>}</td>
          <td>{row.task.linkRel === undefined ? '权重未确认' : row.passesWeight ? '可传权重' : '不传权重'}</td>
          <td>{row.inGoogle ? '已出现' : '—'}</td>
          <td>{monthDay(row.lastCheckedAt)}</td></tr>)}</tbody></table>
        {!visible.length && <p className="table-empty">没有符合条件的外链。</p>}</div></section>}

    {tab === 'platforms' && <section className="panel"><div className="table-scroll"><table className="work-table"><thead><tr>
      {[['platform', '平台'], ['published', '发了几条'], ['active', '现在有效'], ['weight', '可传权重'], ['rate', '成功率'], ['ai', '平均每条 AI 次数']].map(([key, label]) =>
        <SortHeading key={key} column={key} sort={platformSort.sort} onSort={platformSort.onSort}>{label}</SortHeading>)}</tr></thead>
      <tbody>{sortTableRows(stats, platformSort.sort, (row, key) => key === 'platform' ? row.platform : key === 'published' ? row.published : key === 'active' ? row.active
        : key === 'weight' ? row.weight : key === 'rate' ? row.successRate : row.averageAiCalls ?? 0).map(row => <tr key={row.channelId}>
        <td>{row.platform}</td><td>{row.published}</td><td>{row.active}</td><td>{row.weight}</td><td>{percent(row.successRate)}</td>
        <td>{row.averageAiCalls === undefined ? '—' : row.averageAiCalls.toFixed(1)}</td></tr>)}</tbody></table></div></section>}

    {tab === 'google' && <section className="panel">
      <div className="directory-toolbar"><p className="toolbar-note">可以一次选多个 CSV，来自不同 Google 账号也行；外链助手按报告里出现的本软件外链，把每个文件分到对应网站。</p>
        <Button variant="primary" disabled={disabled} onClick={() => void importReports()}><UploadSimple size={16} />导入报告</Button></div>
      {message && <p role="status" className="inline-status">{message}</p>}
      <div className="table-scroll"><table className="work-table"><thead><tr>
        {[['site', '网站'], ['imported', '上次导入'], ['found', '报告里出现的本软件外链']].map(([key, label]) =>
          <SortHeading key={key} column={key} sort={googleSort.sort} onSort={googleSort.onSort}>{label}</SortHeading>)}</tr></thead>
        <tbody>{sortTableRows(google, googleSort.sort, (row, key) => key === 'site' ? row.site.domain : key === 'imported' ? row.gsc.report?.checkedAt ?? '' : row.gscMatches).map(row => <tr key={row.site.id}>
          <td>{row.site.domain}</td>
          <td>{row.gsc.report ? monthDay(row.gsc.report.checkedAt) : '还没导入'}{googleReportStale(row.site, now) && row.gsc.report && <small className="cell-note warn">该更新了</small>}</td>
          <td>{row.gscMatches}</td></tr>)}</tbody></table></div></section>}
  </div>;
}
