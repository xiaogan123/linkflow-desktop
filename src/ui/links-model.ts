import type {Channel, Site, Snapshot, Task} from '../shared/types';
import {canonicalPublicPageUrl} from '../shared/publication';
import {normalizeChannelLinkRel} from '../shared/channel-rel';
import {buildTrackingRows, pageLinkLabel, trackingUrl} from './search-tracking';

/** Only a checked follow link passes weight (no rel, "follow" or only noopener/noreferrer); unknown never counts. */
export function passesWeight(task: Pick<Task, 'linkRel'>): boolean {
  return task.linkRel !== undefined && normalizeChannelLinkRel(task.linkRel) === 'follow';
}

export interface LinkRow {
  task: Task;
  site: Site;
  platform: string;
  title: string;
  url: string;
  publishedAt?: string;
  link: string;
  active: boolean;
  passesWeight: boolean;
  inGoogle: boolean;
  lastCheckedAt?: string;
  /** Platforms that delete pages after a fixed time; these never count toward the monthly target. */
  expiresAt?: string;
}

const day = 86_400_000;

function expiry(task: Task, channel: Channel | undefined): string | undefined {
  if (!task.temporaryPage && channel?.retentionDays === undefined) return undefined;
  const start = Date.parse(task.firstLiveAt ?? task.submittedAt ?? '');
  const days = channel?.retentionDays;
  return Number.isFinite(start) && days !== undefined ? new Date(start + days * day).toISOString() : undefined;
}

/** One row per published page (the newest task wins when a URL repeats). */
export function linkRows(data: Pick<Snapshot, 'sites' | 'tasks' | 'channels'>): LinkRow[] {
  const sites = new Map(data.sites.map(site => [site.id, site]));
  const channels = new Map(data.channels.map(channel => [channel.id, channel]));
  const google = new Map(buildTrackingRows(data.sites, data.tasks).map(row => [row.site.id, row.gsc]));
  const latest = new Map<string, Task>();
  for (const task of data.tasks) {
    const url = canonicalPublicPageUrl(task.publicUrl);
    if (!url || !task.firstLiveAt) continue;
    const previous = latest.get(url);
    if (!previous || task.updatedAt > previous.updatedAt) latest.set(url, task);
  }
  const rows: LinkRow[] = [];
  for (const task of latest.values()) {
    const site = sites.get(task.siteId);
    if (!site) continue;
    const channel = channels.get(task.channelId);
    const link = pageLinkLabel(task);
    const index = google.get(site.id);
    const url = trackingUrl(task.publicUrl) ?? task.publicUrl!;
    rows.push({
      task, site, url, link,
      platform: channel?.name.split(' · ')[0] ?? task.sourceDomain,
      title: task.draft?.title ?? task.publicationSnapshot?.draft.title ?? url,
      publishedAt: task.firstLiveAt,
      active: link === '有效',
      passesWeight: link === '有效' && passesWeight(task),
      inGoogle: !!index && (index.current.has(url) || index.history.has(url)),
      lastCheckedAt: task.lastCheckedAt,
      expiresAt: expiry(task, channel),
    });
  }
  return rows.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
}

export function linksSummary(rows: readonly LinkRow[]) {
  return {
    total: rows.length,
    active: rows.filter(row => row.active).length,
    weight: rows.filter(row => row.passesWeight).length,
    temporary: rows.filter(row => row.expiresAt).length,
  };
}

export interface PlatformStat {platform: string; channelId: string; published: number; active: number; weight: number; successRate: number; averageAiCalls?: number}

/** Success is a page that went live, out of every attempt that reached the platform (submitted or live). */
export function platformStats(data: Pick<Snapshot, 'sites' | 'tasks' | 'channels'> & Partial<Pick<Snapshot, 'actualTaskCosts'>>, rows: readonly LinkRow[]): PlatformStat[] {
  const byChannel = new Map<string, LinkRow[]>();
  for (const row of rows) byChannel.set(row.task.channelId, [...(byChannel.get(row.task.channelId) ?? []), row]);
  // A platform that received posts but has none live yet still belongs in the table.
  for (const task of data.tasks) if ((task.submittedAt || task.firstLiveAt) && task.channelId && !byChannel.has(task.channelId)) byChannel.set(task.channelId, []);
  const channels = new Map(data.channels.map(channel => [channel.id, channel]));
  return [...byChannel.entries()].map(([channelId, list]) => {
    const attempts = data.tasks.filter(task => task.channelId === channelId && (task.submittedAt || task.firstLiveAt)).length;
    // Each post's own AI calls; a replacement task does not carry the original's cost twice.
    const calls = list.map(row => data.actualTaskCosts?.[row.task.id]?.aiCalls ?? row.task.cost?.aiCalls).filter((value): value is number => typeof value === 'number');
    return {
      channelId, platform: list[0]?.platform ?? channels.get(channelId)?.name.split(' · ')[0] ?? channelId, published: list.length,
      active: list.filter(row => row.active).length, weight: list.filter(row => row.passesWeight).length,
      successRate: attempts ? Math.min(1, list.length / attempts) : 1,
      averageAiCalls: calls.length ? calls.reduce((sum, value) => sum + value, 0) / calls.length : undefined,
    };
  }).sort((a, b) => b.published - a.published);
}

// A leading = + - @ (or tab/CR) would run as a formula in a spreadsheet; such cells get a quote mark first.
const csvCell = (raw: string) => {
  const value = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
};

export function linksCsv(rows: readonly LinkRow[]): string {
  const header = ['网站', '平台', '文章', '外链地址', '发布日期', '链接', '属性', 'Google 报告', '上次检查'];
  const body = rows.map(row => [row.site.domain, row.platform, row.title, row.url, row.publishedAt?.slice(0, 10) ?? '',
    row.link, row.task.linkRel === undefined ? '权重未确认' : row.passesWeight ? '可传权重' : '不传权重', row.inGoogle ? '已出现' : '', row.lastCheckedAt?.slice(0, 10) ?? '']);
  return [header, ...body].map(line => line.map(csvCell).join(',')).join('\n');
}

/** A site's Google report is stale after 30 days. */
export function googleReportStale(site: Site, now: Date): boolean {
  const at = Date.parse(site.searchReports?.gsc?.checkedAt ?? '');
  return !Number.isFinite(at) || now.getTime() - at > 30 * day;
}
