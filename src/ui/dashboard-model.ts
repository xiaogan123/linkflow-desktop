import type { Site, Snapshot, Task } from '../shared/types';
import {displayParts} from './display-time';
import { canonicalPublicPageUrl, publicationCounts } from '../shared/publication';
import { taskDisplayState, compareHumanActionTasks } from './presentation';
import { buildTrackingRows } from './search-tracking';
export const uiCopy = {
  noNext: '等待排期',
  noMatches: '没有匹配的网站',
  changeSearch: '换个网址再搜一次。',
  allSites: '全部网站',
  selectSites: '选择网站',
  selected: (n: number) => `已选 ${n} 个网站`,
  saved: '设置已保存。',
  archived: '网站已归档，历史外链仍保留。',
  batchDone: (n: number) => `已更新 ${n} 个网站。`,
  batchPartial: (n: number) => `已更新 ${n} 个网站，其余网站未更新，请重试。`,
  batchAddPartial: (n: number, d: number) => `跳过 ${d} 个重复网址，${n} 个网址未添加。`,
  invalidCsv: '没有读到网址，请检查文件内容。',
  importFailed: '文件没读成功，请重新选择。',
  emptySchedule: '未来 30 天还没有排期。',
  contentSaved: '推广内容已保存。',
  styleChanged: '写作风格已更换。',
  missingProfile: '写作风格会在第一次写稿前自动生成。',
  noLinks: '还没有外链',
  noLinksBody: '发布后会在这里显示外链。',
  noTopics: '还没有可写稿的文章页。',
  topicUrl: '文章网址',
  topicTitle: '文章标题',
  addTopic: '添加文章',
  removeTopic: '移除文章',
  saveContent: '保存推广内容',
  linkTargets: '可链接的页面',
  forbiddenTerms: '不许出现的词',
  onePerLine: '每行一个。',
  confirmArticle: '确认稿件',
  approved: '稿件已确认，外链助手会继续发布。',
  viewDraft: '查看稿件',
  technical: '技术详情',
  noTechnical: '没有技术详情。',
  skipDone: '已跳过这篇，外链助手会继续安排。',
  sort: (name: string) => `按${name}排序`,
  tone: {
    plain: '平实讲解',
    measured: '审慎分析',
    concise: '简洁说明',
    patient: '耐心讲解',
    technical: '专业讲解',
    conversational: '口语答疑'
  }
} as const;
export function nextTask(tasks: Task[], now: Date, siteId?: string): Task | undefined {
  return tasks.filter(t => (!siteId || t.siteId === siteId) && !t.firstLiveAt && ['scheduled', 'in_progress'].includes(taskDisplayState(t, now).state)).sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0];
}
export function dateTime(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return uiCopy.noNext;
  const d = displayParts(new Date(value));
  return `${d.month}月${d.day}日 ${String(d.hour).padStart(2, '0')}:${String(d.minute).padStart(2, '0')}`;
}
export function taskWithPlatform(task: Task, data: Snapshot): Task & {
  platformName: string;
} {
  return {
    ...task,
    platformName: data.channels.find(c => c.id === task.channelId)?.name ?? task.sourceDomain
  };
}
export function activeSites(data: Snapshot): Site[] {
  return data.sites.filter(site => !site.archivedAt);
}
export function todoTasks(data: Snapshot, now: Date): Task[] {
  return data.tasks.filter(t => !data.sites.find(s => s.id === t.siteId)?.archivedAt && taskDisplayState(t, now).state === 'action_required').sort((a, b) => compareHumanActionTasks(a, b, now));
}
export function siteState(site: Site, data: Snapshot, now: Date): string {
  if (site.status === 'paused') return '已暂停';
  // An analysis that could not read the site stops its plan until the owner looks.
  if (site.status === 'attention') return '要你处理';
  if (site.status === 'analyzing') return '分析中';
  if (data.tasks.some(t => t.siteId === site.id && taskDisplayState(t, now).state === 'action_required')) return '要你处理';
  if (platformShortage(site, data, now)) return '平台不够';
  return '正常';
}
/** The platforms the scheduler can use cannot cover this month's target, whatever else the site is waiting for. */
export function platformShortage(site: Site, data: Snapshot, now: Date): boolean {
  // A paused, analyzing or unreadable site has its own state and notice; its capacity is not known yet.
  if (site.status !== 'ready') return false;
  const capacity = data.capacity?.find(c => c.siteId === site.id);
  return site.planStatus?.reasonCode === 'platform_capacity' || !!capacity && capacity.automaticPages !== undefined && capacity.automaticPages < Math.max(0, site.monthlyTarget - publicationCounts(site.id, data.tasks, now, data.settings.timezone).monthlyPages);
}
export function uniquePublications(tasks: Task[]): Task[] {
  const result = new Map<string, Task>();
  for (const task of tasks) {
    const url = canonicalPublicPageUrl(task.publicUrl);
    if (!url || !task.firstLiveAt) continue;
    const existing = result.get(url);
    if (!existing || task.updatedAt > existing.updatedAt) result.set(url, task);
  }
  return [...result.values()];
}
// One definition for the overview and the links page.
import {linkRows,linksSummary,passesWeight} from './links-model';
export {passesWeight};
export function overviewNumbers(data: Snapshot, now: Date) {
  const sites = activeSites(data),
    counts = sites.map(s => publicationCounts(s.id, data.tasks, now, data.settings.timezone));
  // One definition with the Links page, so the two never show different numbers.
  const links = linksSummary(linkRows(data));
  return {
    monthly: counts.reduce((a, c) => a + c.monthlyPages, 0),
    target: sites.reduce((a, s) => a + s.monthlyTarget, 0),
    current: links.active,
    weight: links.weight,
    google: buildTrackingRows(data.sites, data.tasks).reduce((n, r) => n + r.gscMatches, 0)
  };
}
/** CSV cells, including quoted commas/newlines; known header cells are omitted. */
export function parseSiteInput(text: string): string[] {
  const rows: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      if (quoted && source[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\t')) {
      row.push(value.trim());
      value = '';
    } else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && source[i + 1] === '\n') i++;
      row.push(value.trim());
      rows.push(row);
      row = [];
      value = '';
    } else value += c;
  }
  row.push(value.trim());
  rows.push(row);
  const nonempty = rows.filter(r => r.some(Boolean));
  if (!nonempty.length) return [];
  const header = nonempty[0].findIndex(v => /^(url|domain|website|网址|域名|网站)$/i.test(v));
  return (header >= 0 ? nonempty.slice(1) : nonempty).map(r => r[header >= 0 ? header : 0] ?? '').filter(Boolean);
}
