import type { Channel, ChannelMetric, SecretStore, Task } from '../shared/types';
import { channelMetricLinkScope, channelMetricSnapshot } from '../integrations/channel-authority-snapshots';
import { AHREFS_DR_ENDPOINT, AHREFS_DR_VERSION, AhrefsDrError, queryAhrefsDr } from '../integrations/ahrefs-dr';
import type { Store } from './store';

export const AHREFS_SECRET_KEY = 'ahrefsApiKey';
const AHREFS_MESSAGES = {
  unauthorized: 'Ahrefs 密钥校验失败，已停止查询',
  rate_limited: 'Ahrefs 查询受限，已暂停并等待重试',
  failed: 'Ahrefs 查询失败，稍后重试',
} as const;
const HOUR = 3_600_000;

export interface AhrefsServiceOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  failureCooldownMs?: number;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new AhrefsDrError('cancelled')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new AhrefsDrError('cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function host(value: string): string | undefined {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return undefined;
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch { return undefined; }
}

function replaceDr(metrics: ChannelMetric[] | undefined, metric: ChannelMetric): ChannelMetric[] {
  return [...(metrics ?? []).filter(value => value.provider !== 'ahrefs-dr' && value.provider !== 'built-in-dr'), metric];
}

function isCurrentApiMetric(metric: ChannelMetric, target: string, month: string): boolean {
  return metric.provider === 'ahrefs-dr' && metric.target === target && metric.asOf === month
    && metric.version === AHREFS_DR_VERSION && metric.source === AHREFS_DR_ENDPOINT && metric.apiProvenance === 'ahrefs_api';
}

/** Filter one already-read state snapshot before scheduling any per-task work. */
export function taskNeedsAhrefsRefresh(task: Pick<Task, 'status' | 'publicUrl' | 'metrics'>): boolean {
  if (task.status !== 'live' || !task.publicUrl) return false;
  const target = host(task.publicUrl);
  if (!target) return false;
  // Legacy task measurements predate provenance markers. Preserve their one-time
  // query history without promoting their displayed source or spending again.
  // Channel imports cannot write task metrics; channel refresh stays strict.
  return !task.metrics?.some(metric => metric.provider === 'ahrefs-dr' && metric.linkScope === 'same-host'
    && metric.target === target && metric.version === AHREFS_DR_VERSION && metric.source === AHREFS_DR_ENDPOINT);
}

/** One queue and one cooldown cover monthly, new-channel, connection-test and publication queries. */
export class AhrefsService {
  private readonly now: () => Date;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private monthly?: Promise<void>;
  private readonly pendingTasks = new Map<string, Promise<void>>();
  private generation = 0;
  private lastRequestAt?: number;
  private disposed = false;
  private abort = new AbortController();

  constructor(
    private readonly store: Pick<Store, 'read' | 'update' | 'log'>,
    private readonly vault: Pick<SecretStore, 'get'>,
    private readonly channels: () => Channel[],
    private readonly options: AhrefsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.wait = options.wait ?? wait;
  }

  private enqueue<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    const generation = this.generation;
    const next = this.queue.then(async () => {
      if (this.disposed || generation !== this.generation) return fallback;
      try { return await operation(); }
      catch (error) {
        if (generation === this.generation && !this.disposed) this.recordFailure(error);
        return fallback;
      }
    });
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private canQuery(): boolean {
    if (this.disposed) return false;
    const settings = this.store.read().settings;
    if (settings.ahrefsRetryAfter && Date.parse(settings.ahrefsRetryAfter) > this.now().getTime()) return false;
    // A 401 remains stopped across restarts until the saved key changes.
    return !(settings.ahrefsStatus === 'error' && !settings.ahrefsRetryAfter);
  }

  private recordFailure(error: unknown): void {
    if (error instanceof AhrefsDrError && error.code === 'cancelled') return;
    const code = error instanceof AhrefsDrError ? error.code : 'network';
    const delay = code === 'unauthorized' ? undefined : code === 'rate_limited'
      ? Math.max(HOUR, (error as AhrefsDrError).retryAfterMs ?? HOUR)
      : this.options.failureCooldownMs ?? 15 * 60_000;
    this.store.update(state => {
      state.settings.ahrefsStatus = 'error';
      state.settings.ahrefsRetryAfter = delay === undefined ? undefined : new Date(this.now().getTime() + delay).toISOString();
    });
    const message = code === 'unauthorized' ? AHREFS_MESSAGES.unauthorized
      : code === 'rate_limited' ? AHREFS_MESSAGES.rate_limited : AHREFS_MESSAGES.failed;
    this.store.log(message, { level: 'warning' });
  }

  private async query(target: string, linkScope: ChannelMetric['linkScope']): Promise<ChannelMetric | undefined> {
    if (!this.canQuery()) return undefined;
    const generation = this.generation;
    const signal = this.abort.signal;
    const key = await this.vault.get(AHREFS_SECRET_KEY);
    if (!key || generation !== this.generation || !this.canQuery()) return undefined;
    const attempts = Math.max(0, Math.min(2, this.options.maxRetries ?? 2));
    for (let attempt = 0; ; attempt++) {
      const gap = this.lastRequestAt === undefined ? 0
        : Math.max(0, (this.options.intervalMs ?? 1_500) - (this.now().getTime() - this.lastRequestAt));
      if (gap) await this.wait(gap, signal);
      if (generation !== this.generation || signal.aborted || this.disposed) return undefined;
      this.lastRequestAt = this.now().getTime();
      try {
        const result = await queryAhrefsDr(key, target, { ...this.options, now: this.now, signal });
        if (generation !== this.generation || signal.aborted || this.disposed) return undefined;
        const at = this.now().toISOString();
        this.store.update(state => {
          state.settings.ahrefsStatus = 'connected';
          state.settings.ahrefsLastUpdatedAt = at;
          state.settings.ahrefsRetryAfter = undefined;
        });
        return { provider: 'ahrefs-dr', value: result.domainRating, target, linkScope, asOf: at.slice(0, 7), version: AHREFS_DR_VERSION, source: AHREFS_DR_ENDPOINT, apiProvenance: 'ahrefs_api' };
      } catch (error) {
        const retryable = error instanceof AhrefsDrError
          && (error.code === 'network' || error.code === 'timeout' || error.code === 'http' && (error.status ?? 0) >= 500);
        if (!retryable || attempt >= attempts) throw error;
        await this.wait((this.options.retryBaseMs ?? 1_000) * 2 ** attempt, signal);
      }
    }
  }

  private channelTarget(channel: Channel): string | undefined {
    const snapshot = channelMetricSnapshot(channel.domain, channel.id)[0];
    return host(snapshot?.target ?? channel.domain);
  }

  private async updateChannel(channel: Channel): Promise<boolean> {
    const generation = this.generation;
    const target = this.channelTarget(channel);
    if (!target) return false;
    const current = this.store.read().channelMetrics?.[channel.id]?.metrics ?? channel.metrics;
    if (current?.some(metric => isCurrentApiMetric(metric, target, this.now().toISOString().slice(0, 7)))) return true;
    const metric = await this.query(target, channelMetricLinkScope(channel.id));
    if (!metric || generation !== this.generation || this.disposed) return false;
    // Deleted custom channels must not reappear through a late DR response.
    if (!this.channels().some(value => value.id === channel.id && value.domain === channel.domain)) return false;
    this.store.update(state => {
      state.channelMetrics ??= {};
      const saved = state.channelMetrics[channel.id] ?? {};
      state.channelMetrics[channel.id] = { ...saved, metrics: replaceDr(saved.metrics ?? channel.metrics, metric) };
    });
    return true;
  }

  refreshMonthly(): Promise<void> {
    if (this.monthly) return this.monthly;
    const generation = this.generation;
    const month = this.now().toISOString().slice(0, 7);
    if (!this.canQuery() || this.store.read().settings.ahrefsLastRefreshMonth === month) return Promise.resolve();
    const run = async () => {
      // Test the vault before scanning; installations without a key do no writes or requests.
      if (!await this.vault.get(AHREFS_SECRET_KEY)) return;
      for (const channel of this.channels()) {
        if (generation !== this.generation || !this.canQuery()) return;
        const complete = await this.enqueue(() => this.updateChannel(channel), false);
        if (!complete) return;
      }
      if (generation === this.generation && !this.disposed) {
        this.store.update(state => { state.settings.ahrefsLastRefreshMonth = month; });
      }
    };
    const pending = run().catch(error => { if (!this.disposed && generation === this.generation) this.recordFailure(error); });
    this.monthly = pending;
    void pending.finally(() => { if (this.monthly === pending) this.monthly = undefined; });
    return pending;
  }

  refreshChannel(channel: Channel): Promise<void> {
    return this.enqueue(async () => { await this.updateChannel(channel); }, undefined);
  }

  refreshTask(taskId: string): Promise<void> {
    const existing = this.pendingTasks.get(taskId);
    if (existing) return existing;
    const pending = this.enqueue(async () => {
      const generation = this.generation;
      const task = this.store.read().tasks.find(value => value.id === taskId);
      if (!task || !taskNeedsAhrefsRefresh(task)) return;
      const publicUrl = task.publicUrl!;
      const target = host(publicUrl);
      if (!target) return;
      const metric = await this.query(target, 'same-host');
      if (!metric || generation !== this.generation || this.disposed) return;
      this.store.update(state => {
        const current = state.tasks.find(value => value.id === taskId);
        if (current?.publicUrl === publicUrl) current.metrics = replaceDr(current.metrics, metric);
      });
    }, undefined);
    this.pendingTasks.set(taskId, pending);
    const cleanup = () => { if (this.pendingTasks.get(taskId) === pending) this.pendingTasks.delete(taskId); };
    void pending.then(cleanup, cleanup);
    return pending;
  }

  testConnection(): Promise<boolean> {
    return this.enqueue(async () => !!await this.query('ahrefs.com', 'same-host'), false);
  }

  resetAfterKeyChange(): void {
    this.invalidatePending();
    this.store.update(state => {
      state.settings.ahrefsStatus = undefined;
      state.settings.ahrefsRetryAfter = undefined;
      state.settings.ahrefsLastRefreshMonth = undefined;
    });
  }

  /** Cancel pre-restore work without changing restored credentials or persisted cooldowns. */
  invalidatePending(): void {
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    this.queue = Promise.resolve();
    this.monthly = undefined;
    this.pendingTasks.clear();
    this.lastRequestAt = undefined;
  }

  resume(): void {
    if (!this.disposed) return;
    this.abort = new AbortController();
    this.disposed = false;
  }

  dispose(): void {
    this.disposed = true;
    this.invalidatePending();
  }
}
