import { useState, type ReactNode } from 'react';
import {displayParts} from '../display-time';
import { platformName as channelDisplayName } from '../platforms-model';
import { Plus, FileText, MagnifyingGlass } from '@phosphor-icons/react';
import type { Site, Snapshot, Task } from '../../shared/types';
import { getArticleReviewMode } from '../../shared/article-review-mode';
import { publicationCounts } from '../../shared/publication';
import { Button, Empty, Field } from '../components';
import { taskDisplayState } from '../presentation';
import { activeSites, dateTime, nextTask, overviewNumbers, passesWeight, siteState, taskWithPlatform, todoTasks, uiCopy, uniquePublications, platformShortage } from '../dashboard-model';
import { buildTrackingRows, pageLinkLabel } from '../search-tracking';
type Action = <T = unknown>(command: string, payload?: unknown, success?: string) => Promise<T | undefined>;
type Shared = {
  data: Snapshot;
  now: Date;
  disabled: boolean;
  onAction: Action;
  onSite: (id: string) => void;
};
export function useTableSort(initial: string) {
  const [sort, setSort] = useState({
    key: initial,
    ascending: true
  });
  const change = (key: string) => setSort(old => ({
    key,
    ascending: old.key === key ? !old.ascending : true
  }));
  function rows<T>(items: T[], value: (item: T, key: string) => string | number) {
    return [...items].sort((a, b) => {
      const av = value(a, sort.key),
        bv = value(b, sort.key);
      return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'zh-CN', {
        numeric: true
      })) * (sort.ascending ? 1 : -1);
    });
  }
  const heading = (key: string, label: string) => <th key={key} aria-sort={sort.key === key ? sort.ascending ? 'ascending' : 'descending' : 'none'}><button className="sort-heading" onClick={() => change(key)} aria-label={uiCopy.sort(label)}>{label}
{sort.key === key ? sort.ascending ? ' ↑' : ' ↓' : ''}</button></th>;
  return {
    rows,
    heading
  };
}
export function PageHeading({
  title,
  summary,
  children
}: {
  title: string;
  summary: string;
  children?: ReactNode;
}) {
  return <div className="page-heading compact-heading"><div><h1>{title}</h1>
<p>{summary}</p></div>
<div className="heading-actions">{children}</div></div>;
}
function SiteEmpty({
  onAdd
}: {
  onAdd: () => void;
}) {
  return <Empty icon={Plus} title="还没有网站" body="粘贴网址，外链助手会自动分析每个站，并把外链分散排进每个月。" action={<Button variant="primary" onClick={onAdd}>添加网站</Button>} />;
}
export function OverviewPage({
  data,
  now,
  disabled,
  onAction,
  onSite,
  onAdd,
  onTodos,
  onSettings,
  onPlatforms,
  onTask
}: Shared & {
  onAdd: () => void;
  onTodos: () => void;
  onSettings: () => void;
  onPlatforms: () => void;
  onTask: (task: Task) => void;
}) {
  const sites = activeSites(data),
    numbers = overviewNumbers(data, now),
    todos = todoTasks(data, now),
    table = useTableSort('site');
  // Platform-wide notices sit above per-post work: a paused platform and a code found in a published post.
  const [seen, setSeen] = useState<string[]>(() => {try {return JSON.parse(localStorage.getItem('linkflow.seenPlatformPauses') ?? '[]') as string[]} catch {return []}});
  const platformName = (id: string) => { const channel = data.channels.find(value => value.id === id); return channel ? channelDisplayName(channel) : id; };
  const pauses = (data.platformSurvivalTodos ?? []).filter(item => !seen.includes(`${item.channelId}:${item.pausedAt}`));
  const referrals = (data.remoteContentTodos ?? []).filter(item => item.kind === 'referral');
  const acknowledge = (key: string) => {const next = [...seen, key]; setSeen(next); try {localStorage.setItem('linkflow.seenPlatformPauses', JSON.stringify(next.slice(-50)))} catch {/* per-device convenience only */}};
  // A code found in a live post stops publishing and is listed nowhere else, so it is always shown.
  // Then real to-dos (a code about to expire must stay visible) and at most two platform-pause notices beside them.
  const shownReferrals = referrals;
  const shownTodos = todos.slice(0, Math.max(1, 3 - Math.min(2, pauses.length)));
  const shownPauses = pauses.slice(0, Math.max(0, 3 - shownTodos.length));
  // A site whose analysis could not read it waits for the owner; it is listed here, not only on its own page.
  const failedSites = sites.filter(site => site.status === 'attention');
  const notices = pauses.length + referrals.length + failedSites.length;
  const shortage = sites.filter(s => platformShortage(s, data, now));
  const available = sites.reduce((n, s) => n + (s.planStatus?.effectiveTarget ?? data.capacity?.find(c => c.siteId === s.id)?.automaticPages ?? s.monthlyTarget), 0);
  const banners: {
    text: string;
    button?: string;
    action?: () => void;
  }[] = [];
  if (!data.runtime.aiReady) banners.push({
    text: 'AI 还没连接，外链助手现在不会写稿',
    button: '去连接',
    action: onSettings
  });
  if (data.runtime.aiCallsToday >= data.settings.dailyAiLimit) banners.push({
    text: `今天的 AI 次数用完了（${data.runtime.aiCallsToday}/${data.settings.dailyAiLimit}），明天继续`,
    button: '调整次数',
    action: onSettings
  });
  if (shortage.length) banners.push({
    text: `平台不够用：本月每站约 ${Math.floor(available / Math.max(1, sites.length))} 条（目标 ${Math.round(numbers.target / Math.max(1, sites.length))} 条）`,
    button: '看原因',
    action: onPlatforms
  });
  const runtime = data.runtime as Snapshot['runtime'] & {
    onlineHoursLast7Days?: number;
    missedPublicationsLast7Days?: number;
  };
  if (runtime.onlineHoursLast7Days !== undefined && runtime.missedPublicationsLast7Days) banners.push({
    text: `最近 7 天电脑在线 ${runtime.onlineHoursLast7Days} 小时，错过 ${runtime.missedPublicationsLast7Days} 次发布，已自动改期`
  });
  return <div className="page overview"><PageHeading title="总览" summary={`${displayParts(now).month} 月已拿到 ${numbers.monthly} / ${numbers.target} 条 · ${todos.length + notices ? `${todos.length + notices} 件事要你处理` : '不用你处理'}`}><Button variant="primary" onClick={onAdd}><Plus size={18} />添加网站</Button></PageHeading>
    {banners.slice(0, 2).map(b => <div className="banner warning" key={b.text}><span>{b.text}</span>
{b.button && <Button onClick={b.action}>{b.button}</Button>}</div>)}
    {!sites.length ? <SiteEmpty onAdd={onAdd} /> : <><div className="dashboard-stats">{[['本月新增外链', `${numbers.monthly}/${numbers.target}`], ['现在有效', `${numbers.current} 条`], ['可传权重', `${numbers.weight} 条`], ['Google 报告里出现', `${numbers.google} 条`]].map(([label, value], i) => <section className="stat panel" key={label}><span>{label}</span>
<strong>{value}</strong>
{i === 0 && <progress aria-label={label} value={numbers.monthly} max={Math.max(numbers.target, numbers.monthly, 1)} />}</section>)}</div>
    <div className="dashboard-columns"><section className="panel table-scroll"><table className="work-table"><thead><tr>{[['site', '网站'], ['month', '本月'], ['next', '下一条'], ['status', '状态']].map(([key, label]) => table.heading(key, label))}</tr></thead>
<tbody>{table.rows(sites, (s, key) => key === 'site' ? s.domain : key === 'month' ? publicationCounts(s.id, data.tasks, now, data.settings.timezone).monthlyPages : key === 'next' ? nextTask(data.tasks, now, s.id)?.scheduledAt ?? '' : siteState(s, data, now)).map(s => <tr key={s.id} onClick={() => onSite(s.id)}><td><button className="inline-link" onClick={() => onSite(s.id)}>{s.domain}</button></td>
<td>{publicationCounts(s.id, data.tasks, now, data.settings.timezone).monthlyPages}/{s.monthlyTarget} 条</td>
<td>{dateTime(nextTask(data.tasks, now, s.id)?.scheduledAt)}</td>
<td>{siteState(s, data, now)}</td></tr>)}</tbody></table></section>
    <section className="panel attention-panel"><div className="panel-head"><h2>要你处理</h2></div>
{failedSites.map(site => <div className="attention-item" key={`analysis:${site.id}`}><strong>{site.domain}</strong>
<p>{site.error ?? '网站分析没有完成。'}</p>
<Button disabled={disabled} onClick={() => void onAction('site:analyze', {id: site.id}, '已开始重新分析。')}>重新分析</Button></div>)}
{shownReferrals.map(item => {const task = data.tasks.find(value => value.id === item.taskId);return <div className="attention-item" key={`referral:${item.taskId}`}><strong>{data.sites.find(site => site.id === item.siteId)?.domain}</strong>
<p>{task ? `${platformName(task.channelId)} 上的这篇外链里发现了邀请码，软件不会继续发布，请到平台上删除或修改。` : item.message}</p>
<Button disabled={disabled} onClick={() => void onAction('external:open', {url: item.publicUrl})}>打开页面</Button></div>})}
{shownTodos.map(task => {
            const state = taskDisplayState(taskWithPlatform(task, data), now);
            return <div className="attention-item" key={task.id}><strong>{data.sites.find(s => s.id === task.siteId)?.domain}</strong>
<p>{state.detail}</p>
<Button onClick={() => onTask(task)}>{state.action ?? '去处理'}</Button></div>;
          })}
{shownPauses.map(item => <div className="attention-item" key={`${item.channelId}:${item.pausedAt}`}><strong>平台已暂停</strong>
<p>{item.message}</p>
<div className="attention-actions"><Button onClick={() => acknowledge(`${item.channelId}:${item.pausedAt}`)}>知道了</Button><Button variant="text" disabled={disabled} onClick={() => void onAction('channel:enable-trial', {id: item.channelId}, `已恢复使用 ${platformName(item.channelId)}。`)}>恢复使用</Button></div></div>)}

{!todos.length && !notices && <p>没有要你处理的事。外链助手会按计划自动发布。</p>}
{todos.length > 0 && <Button variant="text" onClick={onTodos}>全部 {todos.length} 件待办</Button>}</section></div></>}
  </div>;
}
export function WebsitesPage({
  data,
  now,
  disabled,
  onAction,
  onSite,
  onAdd,
  onDelete
}: Shared & {
  onAdd: () => void;
  onDelete?: (siteId: string) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const archived = data.sites.filter(site => site.archivedAt);
  // A site that has published keeps its history: it can only be archived, never deleted.
  const published = (siteId: string) => data.tasks.some(task => task.siteId === siteId && (task.submittedAt || task.publicUrl || task.firstLiveAt));
  const [search, setSearch] = useState(''),
    [selected, setSelected] = useState<string[]>([]),
    [operation, setOperation] = useState(''),
    [target, setTarget] = useState(2),
    [mode, setMode] = useState<'ai' | 'manual'>('ai');
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const table = useTableSort('site'),
    sites = activeSites(data),
    rows = sites.filter(s => `${s.domain} ${s.name}`.toLowerCase().includes(search.toLowerCase()));
  const apply = async (kind: string) => {
    setBusy(true);
    let done = 0;
    for (const id of selected) {
      const command = kind === 'archive' ? 'site:archive' : kind === 'pause' || kind === 'resume' ? 'site:pause' : 'site:update';
      const payload = kind === 'pause' || kind === 'resume' ? {
        id,
        paused: kind === 'pause'
      } : kind === 'target' ? {
        id,
        monthlyTarget: target
      } : kind === 'mode' ? {
        id,
        articleReviewMode: mode
      } : {
        id
      };
      const result = await onAction(command, payload);
      if (result !== undefined) done++;
    }
    setNotice(done === selected.length ? uiCopy.batchDone(done) : uiCopy.batchPartial(done));
    setBusy(false);
    setOperation('');
  };
  return <div className="page sites-page"><PageHeading title="网站" summary={`${sites.length} 个网站 · ${sites.filter(s => s.status === 'ready' && data.settings.autoRun).length} 个自动发布中 · ${sites.filter(s => s.status === 'paused').length} 个已暂停`} />
<section className="panel"><div className="directory-toolbar"><div className="search"><MagnifyingGlass size={17} />
<input placeholder="搜索网站" aria-label="搜索网站" value={search} onChange={e => setSearch(e.target.value)} /></div>
<Button variant="primary" onClick={onAdd}>添加网站</Button></div>
  {selected.length > 0 && <div className="batch-toolbar"><span>{uiCopy.selected(selected.length)}</span>
<Button disabled={disabled || busy} onClick={() => void apply('pause')}>暂停</Button>
<Button disabled={disabled || busy} onClick={() => void apply('resume')}>继续</Button>
<Button disabled={disabled || busy} onClick={() => setOperation('target')}>改每月条数</Button>
<Button disabled={disabled || busy} onClick={() => setOperation('mode')}>改发布方式</Button>
<Button disabled={disabled || busy} onClick={() => void apply('archive')}>归档</Button>
{operation === 'target' && <Field label="每月几条"><input type="number" min={1} max={20} value={target} onChange={e => setTarget(Number(e.target.value))} /></Field>}
{operation === 'mode' && <Field label="发布方式"><select value={mode} onChange={e => setMode(e.target.value as 'ai' | 'manual')}><option value="ai">全自动</option>
<option value="manual">每篇我先看</option></select></Field>}
{operation && <Button disabled={disabled || busy || operation === 'target' && (!Number.isInteger(target) || target < 1 || target > 20)} onClick={() => void apply(operation)}>保存设置</Button>}</div>}
  {notice && <p role="status" className="inline-result">{notice}</p>}
  {!sites.length ? <SiteEmpty onAdd={onAdd} /> : !rows.length ? <Empty icon={MagnifyingGlass} title={uiCopy.noMatches} body={uiCopy.changeSearch} /> : <div className="table-scroll"><table className="work-table"><thead><tr><th><input type="checkbox" aria-label={uiCopy.selectSites} checked={rows.length > 0 && rows.every(s => selected.includes(s.id))} onChange={e => setSelected(e.target.checked ? [...new Set([...selected, ...rows.map(s => s.id)])] : selected.filter(id => !rows.some(s => s.id === id)))} /></th>
{[['site', '网站'], ['mode', '发布方式'], ['target', '每月'], ['month', '本月'], ['total', '外链总数'], ['next', '下一条'], ['status', '状态']].map(([key, label]) => table.heading(key, label))}</tr></thead>
<tbody>{table.rows(rows, (s, key) => {
              const counts = publicationCounts(s.id, data.tasks, now, data.settings.timezone);
              return key === 'site' ? s.domain : key === 'mode' ? getArticleReviewMode(s, data.settings) : key === 'target' ? s.monthlyTarget : key === 'month' ? counts.monthlyPages : key === 'total' ? uniquePublications(data.tasks.filter(t => t.siteId === s.id)).length : key === 'next' ? nextTask(data.tasks, now, s.id)?.scheduledAt ?? '' : siteState(s, data, now);
            }).map(s => <tr key={s.id}><td><input type="checkbox" aria-label={`选择 ${s.domain}`} checked={selected.includes(s.id)} onChange={e => setSelected(e.target.checked ? [...selected, s.id] : selected.filter(id => id !== s.id))} /></td>
<td><button className="inline-link" onClick={() => onSite(s.id)}>{s.domain}</button></td>
<td>{getArticleReviewMode(s, data.settings) === 'ai' ? '全自动' : '每篇我先看'}</td>
<td>{s.monthlyTarget} 条</td>
<td>{publicationCounts(s.id, data.tasks, now, data.settings.timezone).monthlyPages}/{s.monthlyTarget} 条</td>
<td>{uniquePublications(data.tasks.filter(t => t.siteId === s.id)).length} 条</td>
<td>{dateTime(nextTask(data.tasks, now, s.id)?.scheduledAt)}</td>
<td>{siteState(s, data, now)}</td></tr>)}</tbody></table></div>}
  </section>
  {archived.length > 0 && <section className="panel archived-sites"><button type="button" className="group-head" aria-expanded={showArchived} onClick={() => setShowArchived(value => !value)}>已归档 {archived.length} 个</button>
    {showArchived && <><p className="page-note">归档网站不再发新外链，历史外链仍会定期检查。</p><ul>{archived.map(site => <li key={site.id}><span>{site.domain}</span><span className="toolbar-actions">
      <Button disabled={disabled} onClick={() => void onAction('site:restore', {id: site.id}, `已恢复 ${site.domain}，它目前处于暂停状态，需要时点「继续」。`)}>恢复</Button>
      {!published(site.id) && onDelete && <Button variant="text" disabled={disabled} onClick={() => onDelete(site.id)}>删除</Button>}</span></li>)}</ul></>}
  </section>}</div>;
}
export function SiteDetailPage({
  site,
  data,
  initialTab,
  now,
  disabled,
  onAction,
  onEdit,
  onMigrate,
  onBack,
  renderTask,
  tools
}: {
  site: Site;
  data: Snapshot;
  initialTab?: string;
  now: Date;
  disabled: boolean;
  onAction: Action;
  onEdit: () => void;
  onMigrate: () => void;
  onBack: () => void;
  renderTask: (task: Task) => ReactNode;
  tools: ReactNode;
}) {
  const [tab, setTab] = useState(initialTab ?? 'links'),
    table = useTableSort('date'),
    schedule = useTableSort('date');
  const tasks = data.tasks.filter(t => t.siteId === site.id),
    counts = publicationCounts(site.id, data.tasks, now, data.settings.timezone),
    links = uniquePublications(tasks),
    tracking = buildTrackingRows([site], tasks)[0];
  const future = tasks.filter(t => Date.parse(t.scheduledAt) >= now.getTime() && Date.parse(t.scheduledAt) <= now.getTime() + 30 * 86400000 && !t.firstLiveAt && !['failed', 'skipped', 'expired'].includes(t.status));
  const profile = site.writingProfile;
  return <div className="page"><Button variant="text" onClick={onBack}>返回网站</Button>
<PageHeading title={site.domain} summary={`本月 ${counts.monthlyPages}/${site.monthlyTarget} 条 · 下一条 ${dateTime(nextTask(tasks, now)?.scheduledAt)}`} />
{site.status === 'attention' && <div className="banner warning" role="status"><span>{site.error ?? '网站分析没有完成。'}</span><Button disabled={disabled} onClick={() => void onAction('site:analyze', {id: site.id}, '已开始重新分析。')}>重新分析</Button></div>}
<div className="filter-tabs workspace-tabs" role="group" aria-label="网站详情">{[['links', '外链'], ['schedule', '排期'], ['style', '写作风格'], ['content', '推广内容'], ['settings', '设置']].map(([id, label]) => <button key={id} aria-pressed={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
 {tab === 'links' && <section className="panel table-scroll">{links.length ? <table className="work-table"><thead><tr>{[['platform', '平台'], ['title', '文章'], ['date', '发布日期'], ['link', '链接'], ['rel', '属性'], ['google', 'Google 报告'], ['checked', '上次检查']].map(([key, label]) => table.heading(key, label))}</tr></thead>
<tbody>{table.rows(links, (t, key) => key === 'platform' ? t.sourceDomain : key === 'title' ? t.draft?.title ?? '' : key === 'date' ? t.firstLiveAt ?? '' : key === 'link' ? taskDisplayState(t, now).label : key === 'rel' ? Number(passesWeight(t)) : key === 'google' ? Number(tracking.gsc.current.has(t.publicUrl ?? '') || tracking.gsc.history.has(t.publicUrl ?? '')) : t.lastCheckedAt ?? '').map(t => <tr key={t.id}><td>{data.channels.find(c => c.id === t.channelId)?.name ?? t.sourceDomain}</td>
<td><Button variant="text" disabled={disabled} onClick={() => void onAction('task:open-result', {
                id: t.id
              })}>{t.draft?.title ?? t.sourceDomain}</Button></td>
<td>{dateTime(t.firstLiveAt)}</td>
<td><span className={`badge state-${taskDisplayState(t, now).state}`}>{pageLinkLabel(t)}</span></td>
<td>{t.linkRel === undefined ? '待查' : passesWeight(t) ? '可传权重' : '不传权重'}</td>
<td>{tracking.gsc.current.has(t.publicUrl ?? '') || tracking.gsc.history.has(t.publicUrl ?? '') ? '已出现' : '—'}</td>
<td>{dateTime(t.lastCheckedAt)}</td></tr>)}</tbody></table> : <Empty icon={FileText} title={uiCopy.noLinks} body={uiCopy.noLinksBody} />}</section>}
 {tab === 'schedule' && <><section className="panel table-scroll"><table className="work-table"><thead><tr>{schedule.heading('date', '发布时间')}
{schedule.heading('platform', '平台')}
{schedule.heading('state', '状态')}</tr></thead>
<tbody>{schedule.rows(future, (t, key) => key === 'date' ? t.scheduledAt : key === 'platform' ? t.sourceDomain : taskDisplayState(t, now).label).map(t => <tr key={t.id}><td>{dateTime(t.scheduledAt)}</td>
<td>{!t.channelId || t.channelId === 'pending' || !!t.scheduling && Date.parse(t.scheduling.selectionAt ?? t.scheduledAt) > now.getTime() ? '发布前确定' : data.channels.find(c => c.id === t.channelId)?.name ?? '发布前确定'}</td>
<td><span className={`badge state-${taskDisplayState(t, now).state}`}>{taskDisplayState(t, now).label}</span></td></tr>)}</tbody></table>
{!future.length && <p>{uiCopy.emptySchedule}</p>}</section>
<section className="panel content-panel"><h2>其他任务</h2>{tasks.map(renderTask)}</section></>}
 {tab === 'style' && <section className="panel content-panel"><p>{profile ? `${uiCopy.tone[profile.tone]} · ${profile.length.min}–${profile.length.max} 字 · 署名：${site.name || site.domain}` : uiCopy.missingProfile}</p>
{profile && <Button disabled={disabled} onClick={() => void onAction('site:reroll-writing-profile', {
        id: site.id
      }, uiCopy.styleChanged)}>换一种</Button>}</section>}
 {tab === 'content' && <PromotionEditor key={`${site.id}:${site.topicsCheckedAt ?? ''}`} site={site} disabled={disabled} onAction={onAction} />}
 {tab === 'settings' && <><section className="panel content-panel"><p>每月几条：{site.monthlyTarget} 条</p>
<p>发布方式：{getArticleReviewMode(site, data.settings) === 'ai' ? '全自动' : '每篇我先看'}</p>
<div className="heading-actions"><Button onClick={onEdit}>编辑网站</Button>
<Button disabled={disabled} onClick={() => void onAction('site:pause', {
            id: site.id,
            paused: site.status !== 'paused'
          }, uiCopy.saved)}>{site.status === 'paused' ? '继续' : '暂停自动发布'}</Button>
{(data.siteOriginMigrations ?? []).some(record => record.siteId === site.id) ? <span className="muted">已更换过一次域名</span> : <Button disabled={disabled || site.status !== 'paused'} onClick={onMigrate}>更换域名</Button>}
<Button disabled={disabled} onClick={() => void onAction('site:archive', {
            id: site.id
          }, uiCopy.archived)}>归档网站</Button></div></section>
{tools}</>}
 </div>;
}
function PromotionEditor({
  site,
  disabled,
  onAction
}: {
  site: Site;
  disabled: boolean;
  onAction: Action;
}) {
  const [topics, setTopics] = useState(site.topics ?? []),
    [topicUrl, setTopicUrl] = useState(''),
    [topicTitle, setTopicTitle] = useState('');
  const [links, setLinks] = useState((site.linkTargets ?? []).join('\n')),
    [words, setWords] = useState((site.forbiddenTerms ?? []).join('\n'));
  return <section className="panel content-panel"><h2>可写稿的文章页</h2>
{topics.map((topic, i) => <div className="promotion-row" key={`${topic.url}-${i}`}><span>{topic.title || topic.url}</span>
<Button disabled={disabled} onClick={() => setTopics(topics.filter((_, index) => index !== i))}>{uiCopy.removeTopic}</Button></div>)}
{!topics.length && <p>{uiCopy.noTopics}</p>}
<div className="form-grid"><Field label={uiCopy.topicUrl}><input type="url" value={topicUrl} onChange={e => setTopicUrl(e.target.value)} /></Field>
<Field label={uiCopy.topicTitle}><input value={topicTitle} onChange={e => setTopicTitle(e.target.value)} /></Field></div>
<Button disabled={disabled || !/^https?:\/\//.test(topicUrl)} onClick={() => {
      setTopics([...topics, {
        url: topicUrl.trim(),
        title: topicTitle.trim(),
        discoveredAt: new Date().toISOString()
      }]);
      setTopicUrl('');
      setTopicTitle('');
    }}>{uiCopy.addTopic}</Button>
<Field label={uiCopy.linkTargets} hint={uiCopy.onePerLine}><textarea rows={4} value={links} onChange={e => setLinks(e.target.value)} /></Field>
<Field label={uiCopy.forbiddenTerms} hint={uiCopy.onePerLine}><textarea rows={4} value={words} onChange={e => setWords(e.target.value)} /></Field>
<Button variant="primary" disabled={disabled} onClick={() => void onAction('site:content-update', {
      id: site.id,
      topics: topics.map(({
        url,
        title
      }) => ({
        url,
        title
      })),
      linkTargets: links.split('\n').map(x => x.trim()).filter(Boolean),
      forbiddenTerms: words.split('\n').map(x => x.trim()).filter(Boolean)
    }, uiCopy.contentSaved)}>{uiCopy.saveContent}</Button></section>;
}
