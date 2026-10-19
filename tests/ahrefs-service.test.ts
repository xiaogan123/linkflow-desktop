import test from 'node:test';
import assert from 'node:assert/strict';
import type { Channel, Event, Task } from '../src/shared/types';
import { emptyState, type State, type Store } from '../src/main/store';
import { AHREFS_DR_ENDPOINT } from '../src/integrations/ahrefs-dr';
import {CHANNELS} from '../src/integrations/catalog';
import { AHREFS_SECRET_KEY, AhrefsService, taskNeedsAhrefsRefresh, type AhrefsServiceOptions } from '../src/main/ahrefs-service';

function channel(id: string, domain = `${id}.example.com`): Channel {
  return { id, domain, name: id, url: `https://${domain}`, submitUrl: `https://${domain}`, categories: [], languages: ['en'],
    kind: 'article', emailRequired: false, accountRequired: false, articleRequired: true, free: 'yes', freeNote: '',
    automation: 'api', quality: 'B', qualityReason: '', rulesUrl: '', checkedAt: '2026-10-18', notes: '', allowedHosts: [domain], enabled: true };
}

function task(id = 'task-one', publicUrl = 'https://profile.example.com/post'): Task {
  return { id, siteId: 'site-one', channelId: 'first', sourceDomain: 'first.example.com', status: 'live', publicUrl,
    createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z', scheduledAt: '2026-10-18T00:00:00.000Z', attempts: 1, message: 'done' };
}

function fixture(options: AhrefsServiceOptions = {}, initialChannels = [channel('first'), channel('second')]) {
  let time = Date.parse('2026-10-18T00:00:00.000Z');
  let state: State = emptyState();
  let key: string | undefined = 'test-key';
  let reads = 0;
  const calls: string[] = [], pauses: number[] = [], readKeys: string[] = [];
  const channels = initialChannels;
  const store: Pick<Store, 'read' | 'update' | 'log'> = {
    read: () => { reads++; return structuredClone(state); },
    update: fn => { const next = structuredClone(state); fn(next); state = next; },
    log: (message, metadata = {}) => {
      const entry: Event = { id: `event-${state.events.length}`, at: new Date(time).toISOString(), message, level: 'info', ...metadata };
      state.events.push(entry);
    },
  };
  const service = new AhrefsService(store, { get: async name => { readKeys.push(name); return key; } }, () => channels, {
    now: () => new Date(time),
    wait: async milliseconds => { pauses.push(milliseconds); time += milliseconds; },
    fetch: async input => { calls.push(new URL(String(input)).searchParams.get('target')!); return Response.json({ domain_rating: 43.27, license: 'attribution' }); },
    ...options,
  });
  return { service, store, channels, calls, pauses, readKeys, setKey: (value: string | undefined) => { key = value; },
    setTime: (value: string) => { time = Date.parse(value); }, reads: () => reads };
}

test('Ahrefs task predicate filters measured and invalid tasks from an existing state snapshot', () => {
  const measured = task();
  const metric = { provider: 'ahrefs-dr', value: 43.27, target: 'profile.example.com', linkScope: 'same-host' as const,
    asOf: '2026-09', version: 'dr3' as const, source: AHREFS_DR_ENDPOINT, apiProvenance: 'ahrefs_api' as const };
  assert.equal(taskNeedsAhrefsRefresh(measured), true);
  measured.metrics = [metric];
  assert.equal(taskNeedsAhrefsRefresh(measured), false);
  const legacy={...measured,metrics:[{...metric,apiProvenance:undefined}]};
  assert.equal(taskNeedsAhrefsRefresh(legacy),false);
  assert.equal(legacy.metrics[0].apiProvenance,undefined);
  for (const patch of [
    { target: 'other.example.com' }, { provider: 'other' }, { linkScope: 'platform-root' as const },
    { version: 'dr4' as const }, { source: 'https://example.com/metric' },
  ]) {
    assert.equal(taskNeedsAhrefsRefresh({ ...measured, metrics: [{ ...metric, ...patch }] }), true);
  }
  assert.equal(taskNeedsAhrefsRefresh({ ...measured, status: 'review' }), false);
  for (const publicUrl of [undefined, '', 'not a url', 'ftp://profile.example.com/post', 'https://user:password@example.com/post']) {
    assert.equal(taskNeedsAhrefsRefresh({ ...measured, metrics: [], publicUrl }), false);
  }
  assert.equal(taskNeedsAhrefsRefresh({ ...measured, publicUrl: 'https://PROFILE.example.com./new-post' }), false);
});

test('Ahrefs without a key performs no request and leaves snapshots and task state untouched', async () => {
  const f = fixture();
  f.setKey(undefined);
  f.store.update(state => state.tasks.push(task()));
  const before = f.store.read();
  await f.service.refreshMonthly();
  await f.service.refreshChannel(f.channels[0]);
  await f.service.refreshTask('task-one');
  assert.equal(await f.service.testConnection(), false);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.store.read(), before);
  assert.ok(f.readKeys.every(key => key === AHREFS_SECRET_KEY));
  f.service.dispose();
});

test('an imported metric shaped like an API response does not suppress the real query', async () => {
  const f = fixture();
  f.store.update(state => { state.channelMetrics = { first: { metrics: [{ provider: 'ahrefs-dr', value: 88,
    target: 'first.example.com', linkScope: 'same-host', asOf: '2026-10', version: 'dr3', source: AHREFS_DR_ENDPOINT }] } }; });
  await f.service.refreshChannel(f.channels[0]);
  assert.deepEqual(f.calls, ['first.example.com']);
  assert.equal(f.store.read().channelMetrics?.first.metrics?.[0].value, 43.27);
  assert.equal(f.store.read().channelMetrics?.first.metrics?.[0].apiProvenance, 'ahrefs_api');
  f.service.dispose();
});

test('Ahrefs monthly refresh is serial, spaced, once per month and persists floats and version', async () => {
  const f = fixture();
  await Promise.all([f.service.refreshMonthly(), f.service.refreshMonthly()]);
  assert.deepEqual(f.calls, ['first.example.com', 'second.example.com']);
  assert.deepEqual(f.pauses, [1_500]);
  assert.equal(f.store.read().settings.ahrefsLastRefreshMonth, '2026-10');
  const metric = f.store.read().channelMetrics?.first.metrics?.[0];
  assert.deepEqual(metric, { provider: 'ahrefs-dr', value: 43.27, target: 'first.example.com', linkScope: 'same-host',
    asOf: '2026-10', version: 'dr3', source: AHREFS_DR_ENDPOINT, apiProvenance: 'ahrefs_api' });
  await f.service.refreshMonthly();
  assert.equal(f.calls.length, 2);
  f.setTime('2026-11-01T00:00:00.000Z');
  await f.service.refreshMonthly();
  assert.equal(f.calls.length, 4);
  assert.equal(f.store.read().settings.ahrefsLastRefreshMonth, '2026-11');
  f.service.dispose();
});

test('Ahrefs saves platform reference scope and independently refreshes a newly added channel', async () => {
  const f = fixture({}, [channel('blogger', 'blogspot.com')]);
  await f.service.refreshMonthly();
  assert.equal(f.store.read().channelMetrics?.blogger.metrics?.[0].linkScope, 'platform-root');
  const added = channel('added');
  f.channels.push(added);
  await f.service.refreshChannel(added);
  assert.deepEqual(f.calls, ['blogspot.com', 'added.example.com']);
  f.service.dispose();
});

test('an API response replaces the built-in score while querying its actual measured host',async()=>{
  const channel=CHANNELS.find(value=>value.id==='pastyx')!;
  assert.equal(channel.metrics?.[0].provider,'built-in-dr');
  const f=fixture({},[channel]);
  await f.service.refreshChannel(channel);
  assert.deepEqual(f.calls,['pages.dev']);
  const metrics=f.store.read().channelMetrics?.pastyx.metrics;
  assert.equal(metrics?.length,1);
  assert.equal(metrics?.[0].provider,'ahrefs-dr');
  assert.equal(metrics?.[0].source,AHREFS_DR_ENDPOINT);
  f.service.dispose();
});

test('Ahrefs publication queries interleave with monthly channels without concurrent requests', async () => {
  let release: ((response: Response) => void) | undefined;
  let started: (() => void) | undefined;
  const ready = new Promise<void>(done => { started = done; });
  const targets: string[] = [];
  let active = 0, maximum = 0;
  const f = fixture({ fetch: async input => {
    active++;
    maximum = Math.max(maximum, active);
    const target = new URL(String(input)).searchParams.get('target')!;
    targets.push(target);
    if (targets.length === 1) {
      started?.();
      const response = await new Promise<Response>(done => { release = done; });
      active--;
      return response;
    }
    active--;
    return Response.json({ domain_rating: 32.6 });
  } });
  f.store.update(state => state.tasks.push(task()));
  const monthly = f.service.refreshMonthly();
  await ready;
  const publication = f.service.refreshTask('task-one');
  assert.deepEqual(targets, ['first.example.com']);
  release!(Response.json({ domain_rating: 32.6 }));
  await Promise.all([monthly, publication]);
  assert.equal(maximum, 1);
  assert.deepEqual(targets, ['first.example.com', 'profile.example.com', 'second.example.com']);
  f.service.dispose();
});

test('Ahrefs refresh preserves imported traffic and metrics from other providers', async () => {
  const f = fixture();
  const traffic = { monthly: 1234, source: 'https://example.com/report', asOf: '2026-09' };
  const other = { provider: 'example-metric', value: 12.4, target: 'first.example.com', linkScope: 'same-host' as const,
    asOf: '2026-09', version: '' as const, source: 'https://example.com/report' };
  f.store.update(state => { state.channelMetrics = { first: { traffic, metrics: [other] } }; });
  await f.service.refreshChannel(f.channels[0]);
  assert.deepEqual(f.store.read().channelMetrics?.first.traffic, traffic);
  assert.deepEqual(f.store.read().channelMetrics?.first.metrics?.[0], other);
  assert.equal(f.store.read().channelMetrics?.first.metrics?.length, 2);
  f.service.dispose();
});

test('Ahrefs queries the published URL actual host, stores on the task, and does not refresh historical tasks monthly', async () => {
  const f = fixture();
  f.store.update(state => state.tasks.push(task()));
  await Promise.all([f.service.refreshTask('task-one'), f.service.refreshTask('task-one')]);
  assert.deepEqual(f.calls, ['profile.example.com']);
  const after = f.store.read().tasks[0];
  assert.equal(after.metrics?.[0].target, 'profile.example.com');
  assert.equal(after.metrics?.[0].linkScope, 'same-host');
  assert.equal(after.status, 'live');
  assert.equal(after.message, 'done');
  f.setTime('2026-11-01T00:00:00.000Z');
  await f.service.refreshTask('task-one');
  assert.equal(f.calls.length, 1);
  f.store.update(state => { state.tasks[0].publicUrl = 'https://other.example.com/post'; });
  await f.service.refreshTask('task-one');
  assert.equal(f.calls[1], 'other.example.com');
  f.service.dispose();
});

test('Ahrefs publication hook ignores non-live tasks and late responses for changed URLs', async () => {
  let resolve: ((response: Response) => void) | undefined;
  let started: (() => void) | undefined;
  const ready = new Promise<void>(done => { started = done; });
  const f = fixture({ fetch: async () => { started?.(); return new Promise<Response>(done => { resolve = done; }); } });
  f.store.update(state => { const pending = task(); pending.status = 'review'; state.tasks.push(pending); });
  await f.service.refreshTask('task-one');
  f.store.update(state => { state.tasks[0].status = 'live'; });
  const refresh = f.service.refreshTask('task-one');
  await ready;
  f.store.update(state => { state.tasks[0].publicUrl = 'https://other.example.com/post'; });
  resolve!(Response.json({ domain_rating: 33.2 }));
  await refresh;
  assert.equal(f.store.read().tasks[0].metrics, undefined);
  assert.equal(f.store.read().tasks[0].status, 'live');
  f.service.dispose();
});

test('Ahrefs 401 stops all queries across operation kinds and restart until key reset', async () => {
  let calls = 0;
  const f = fixture({ fetch: async () => { calls++; return new Response('do not log', { status: 401 }); } });
  f.store.update(state => state.tasks.push(task()));
  await f.service.refreshMonthly();
  await f.service.refreshChannel(f.channels[1]);
  await f.service.refreshTask('task-one');
  assert.equal(await f.service.testConnection(), false);
  assert.equal(calls, 1);
  assert.equal(f.store.read().settings.ahrefsStatus, 'error');
  assert.equal(f.store.read().settings.ahrefsLastRefreshMonth, undefined);
  assert.equal(f.store.read().settings.ahrefsRetryAfter, undefined);
  assert.equal(f.store.read().events.length, 1);
  assert.ok(!JSON.stringify(f.store.read().events).includes('do not log'));
  f.service.dispose();
  const restarted = new AhrefsService(f.store, { get: async () => 'test-key' }, () => f.channels, { fetch: async () => { calls++; return Response.json({ domain_rating: 25 }); } });
  await restarted.refreshMonthly();
  assert.equal(calls, 1);
  restarted.resetAfterKeyChange();
  assert.equal(await restarted.testConnection(), true);
  assert.equal(calls, 2);
  assert.equal(f.store.read().settings.ahrefsStatus, 'connected');
  restarted.dispose();
});

test('Ahrefs 429 stops the batch, honors Retry-After, and resumes only unfinished channels', async () => {
  let calls = 0;
  const targets: string[] = [];
  const f = fixture({ fetch: async input => {
    targets.push(new URL(String(input)).searchParams.get('target')!);
    calls++;
    return calls === 2 ? new Response('', { status: 429, headers: { 'Retry-After': '7200' } }) : Response.json({ domain_rating: 32.6 });
  } });
  await f.service.refreshMonthly();
  assert.equal(calls, 2);
  assert.equal(f.store.read().settings.ahrefsLastRefreshMonth, undefined);
  assert.equal(f.store.read().settings.ahrefsRetryAfter, '2026-10-18T02:00:01.500Z');
  await f.service.refreshMonthly();
  await f.service.refreshChannel(f.channels[0]);
  assert.equal(calls, 2);
  f.setTime('2026-10-18T03:00:00.000Z');
  await f.service.refreshMonthly();
  assert.deepEqual(targets, ['first.example.com', 'second.example.com', 'second.example.com']);
  assert.equal(f.store.read().settings.ahrefsLastRefreshMonth, '2026-10');
  assert.equal(f.store.read().settings.ahrefsRetryAfter, undefined);
  f.service.dispose();
});

test('Ahrefs transient errors retry with exponential backoff; exhausted failures pause later ticks', async () => {
  let calls = 0;
  const f = fixture({ fetch: async () => { calls++; throw new Error('private token must not reach logs'); } });
  await f.service.refreshMonthly();
  assert.equal(calls, 3);
  assert.deepEqual(f.pauses, [1_000, 500, 2_000]);
  assert.equal(f.store.read().settings.ahrefsStatus, 'error');
  assert.ok(f.store.read().settings.ahrefsRetryAfter);
  assert.equal(f.store.read().settings.ahrefsLastRefreshMonth, undefined);
  await f.service.refreshMonthly();
  assert.equal(calls, 3);
  assert.ok(!JSON.stringify(f.store.read().events).includes('private token'));
  f.service.dispose();
});

test('Ahrefs timeout is bounded and preserves successful publication state', async () => {
  let calls = 0;
  const f = fixture({ timeoutMs: 5, maxRetries: 0, fetch: async () => { calls++; return new Promise<Response>(() => {}); } });
  f.store.update(state => state.tasks.push(task()));
  await f.service.refreshTask('task-one');
  assert.equal(calls, 1);
  assert.equal(f.store.read().tasks[0].status, 'live');
  assert.equal(f.store.read().tasks[0].metrics, undefined);
  assert.equal(f.store.read().settings.ahrefsStatus, 'error');
  f.service.dispose();
});

test('Ahrefs key replacement cancels an old response before it can mark connection or write metrics', async () => {
  let started: (() => void) | undefined;
  const ready = new Promise<void>(done => { started = done; });
  const f = fixture({ fetch: async () => { started?.(); return new Promise<Response>(() => {}); } });
  const pending = f.service.refreshChannel(f.channels[0]);
  await ready;
  f.service.resetAfterKeyChange();
  await pending;
  assert.equal(f.store.read().settings.ahrefsStatus, undefined);
  assert.equal(f.store.read().channelMetrics?.first, undefined);
  assert.equal(f.store.read().events.length, 0);
  f.service.dispose();
});

test('Ahrefs dispose then resume starts a new monthly batch and ignores old successes or failures', async () => {
  for (const outcome of ['success', 'failure']) {
    let settle: ((response: Response) => void) | undefined;
    let reject: ((reason: Error) => void) | undefined;
    let started: (() => void) | undefined;
    const ready = new Promise<void>(done => { started = done; });
    let calls = 0;
    const f = fixture({ fetch: async () => {
      calls++;
      if (calls === 1) {
        started?.();
        return new Promise<Response>((resolve, fail) => { settle = resolve; reject = fail; });
      }
      return Response.json({ domain_rating: 66.6 });
    } }, [channel('first')]);
    const oldMonthly = f.service.refreshMonthly();
    await ready;
    f.service.dispose();
    const stopped = f.store.read();
    f.service.resume();
    assert.deepEqual(f.store.read(), stopped);
    await f.service.refreshMonthly();
    assert.equal(calls, 2);
    assert.equal(f.store.read().channelMetrics?.first.metrics?.[0].value, 66.6);
    assert.equal(f.store.read().settings.ahrefsLastRefreshMonth, '2026-10');
    const fresh = f.store.read();
    if (outcome === 'success') settle!(Response.json({ domain_rating: 1.1 }));
    else reject!(new Error('old request failure'));
    await oldMonthly;
    await Promise.resolve();
    assert.deepEqual(f.store.read(), fresh);
    f.service.dispose();
  }
});

test('Ahrefs invalidation cancels old-key in-flight and queued work before a backup replaces state', async () => {
  let settle: ((response: Response) => void) | undefined;
  let started: (() => void) | undefined;
  const ready = new Promise<void>(done => { started = done; });
  const requested: Array<{ target: string; key: string | null }> = [];
  const f = fixture({ fetch: async (input, init) => {
    requested.push({ target: new URL(String(input)).searchParams.get('target')!, key: new Headers(init?.headers).get('Authorization') });
    if (requested.length === 1) {
      started?.();
      return new Promise<Response>(done => { settle = done; });
    }
    return Response.json({ domain_rating: 77.7 });
  } }, [channel('first')]);
  f.store.update(state => state.tasks.push(task()));
  const oldMonthly = f.service.refreshMonthly();
  await ready;
  const oldQueued = f.service.refreshTask('task-one');
  f.service.invalidatePending();
  f.store.update(state => {
    const restored = emptyState();
    restored.tasks.push(task('task-one', 'https://restored.example.com/post'));
    Object.assign(state, restored);
  });
  f.setKey('restored-key');
  await Promise.all([f.service.refreshMonthly(), f.service.refreshTask('task-one')]);
  assert.deepEqual(requested, [
    { target: 'first.example.com', key: 'Bearer test-key' },
    { target: 'restored.example.com', key: 'Bearer restored-key' },
    { target: 'first.example.com', key: 'Bearer restored-key' },
  ]);
  const restoredResult = f.store.read();
  assert.equal(restoredResult.tasks[0].metrics?.[0].value, 77.7);
  assert.equal(restoredResult.channelMetrics?.first.metrics?.[0].value, 77.7);
  settle!(Response.json({ domain_rating: 1.1 }));
  await Promise.all([oldMonthly, oldQueued]);
  assert.deepEqual(f.store.read(), restoredResult);
  f.service.dispose();
});

test('Ahrefs invalidate, dispose and resume do not alter persisted 401 or rate-limit state', async () => {
  for (const retryAfter of [undefined, '2026-10-18T12:00:00.000Z']) {
    const f = fixture();
    f.store.update(state => {
      state.settings.ahrefsStatus = 'error';
      state.settings.ahrefsRetryAfter = retryAfter;
      state.settings.ahrefsLastUpdatedAt = '2026-10-17T00:00:00.000Z';
    });
    const before = f.store.read();
    f.service.invalidatePending();
    f.service.dispose();
    f.service.resume();
    await f.service.refreshMonthly();
    assert.equal(await f.service.testConnection(), false);
    assert.deepEqual(f.store.read(), before);
    assert.deepEqual(f.calls, []);
    f.service.dispose();
  }
});

test('Ahrefs repeated queued and in-flight task refreshes share one promise without extra state reads', async () => {
  let releaseChannel: ((response: Response) => void) | undefined;
  let releaseTask: ((response: Response) => void) | undefined;
  let channelStarted: (() => void) | undefined;
  let taskStarted: (() => void) | undefined;
  const channelReady = new Promise<void>(done => { channelStarted = done; });
  const taskReady = new Promise<void>(done => { taskStarted = done; });
  const targets: string[] = [];
  const f = fixture({ fetch: async input => {
    const target = new URL(String(input)).searchParams.get('target')!;
    targets.push(target);
    if (target === 'first.example.com') {
      channelStarted?.();
      return new Promise<Response>(done => { releaseChannel = done; });
    }
    taskStarted?.();
    return new Promise<Response>(done => { releaseTask = done; });
  } });
  f.store.update(state => state.tasks.push(task()));
  const channelRefresh = f.service.refreshChannel(f.channels[0]);
  await channelReady;
  const refresh = f.service.refreshTask('task-one');
  const queuedReads = f.reads();
  for (let index = 0; index < 20; index++) assert.equal(f.service.refreshTask('task-one'), refresh);
  assert.equal(f.reads(), queuedReads);
  releaseChannel!(Response.json({ domain_rating: 33.3 }));
  await taskReady;
  const inflightReads = f.reads();
  for (let index = 0; index < 20; index++) assert.equal(f.service.refreshTask('task-one'), refresh);
  assert.equal(f.reads(), inflightReads);
  releaseTask!(Response.json({ domain_rating: 44.4 }));
  await Promise.all([channelRefresh, refresh]);
  assert.deepEqual(targets, ['first.example.com', 'profile.example.com']);
  assert.equal(taskNeedsAhrefsRefresh(f.store.read().tasks[0]), false);
  f.service.dispose();
});

test('Ahrefs task invalidation clears pending identity and old cleanup cannot erase a new generation', async () => {
  const releases: Array<(response: Response) => void> = [];
  const started: Array<() => void> = [];
  const ready = [0, 1].map(() => new Promise<void>(done => { started.push(done); }));
  const f = fixture({ fetch: async () => {
    const index = releases.length;
    started[index]();
    return new Promise<Response>(done => { releases.push(done); });
  } });
  f.store.update(state => state.tasks.push(task()));
  const old = f.service.refreshTask('task-one');
  await ready[0];
  f.service.invalidatePending();
  const fresh = f.service.refreshTask('task-one');
  assert.notEqual(fresh, old);
  await ready[1];
  await old;
  const reads = f.reads();
  assert.equal(f.service.refreshTask('task-one'), fresh);
  assert.equal(f.reads(), reads);
  releases[0](Response.json({ domain_rating: 1.1 }));
  releases[1](Response.json({ domain_rating: 88.8 }));
  await fresh;
  assert.equal(f.store.read().tasks[0].metrics?.[0].value, 88.8);
  f.service.dispose();
});
