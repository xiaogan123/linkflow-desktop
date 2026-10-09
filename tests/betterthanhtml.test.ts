import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings } from '../src/main/store';
import {
  betterThanHtmlTesting,
  reconcileBetterThanHtmlTask,
  runBetterThanHtmlTask,
  verifyBetterThanHtml,
  type BetterThanHtmlTransport,
} from '../src/integrations/betterthanhtml';
import type { Channel, ExecutionContext, Site, Task } from '../src/shared/types';

const NOW = '2026-10-08T14:00:00.000Z';
const TARGET = 'https://example.com/research/source-record';
const SECOND_LINK = 'https://docs.example.org/checklist';
const TITLE = 'A careful source record';
const DESCRIPTION = 'A practical method for preserving claims, dates, units, and unresolved questions.';
const BODY = `A useful source record starts with the exact claim, the date it was read, and the unit attached to every number. The [research source](${TARGET}) is the related page for this worked method, rather than independent proof of every statement in the article.

Before drawing a conclusion, compare the quotation with the original passage and list unresolved assumptions. A separate [review checklist](${SECOND_LINK}) can help preserve that distinction. This is AI-assisted promotional writing for the linked site, which may receive referral commissions; that relationship does not guarantee accuracy, returns, search visibility, or any other outcome.`;
const ID = 'abc123xy';
const PAGE = `https://betterthanhtml.com/workshop/${ID}`;
const LIST = 'https://betterthanhtml.com/api/workshop/list';

function channel(): Channel {
  return {
    id: 'betterthanhtml', name: 'Better Than HTML', domain: 'betterthanhtml.com',
    url: 'https://betterthanhtml.com', submitUrl: 'https://betterthanhtml.com/api/workshop/submit',
    categories: ['content'], languages: ['*'], kind: 'article', emailRequired: false,
    accountRequired: false, articleRequired: true, free: 'yes', freeNote: 'No account required.',
    automation: 'api', quality: 'C', qualityReason: 'Anonymous workshop publishing.',
    provenance: 'built-in', rulesUrl: 'https://betterthanhtml.com/ai', checkedAt: '2026-10-08',
    notes: 'Publish-only workshop API.', allowedHosts: ['betterthanhtml.com'], enabled: true,
  };
}

function fixture() {
  const site: Site = {
    id: 'site', domain: 'example.com', url: 'https://example.com/', email: 'author@example.com',
    name: 'Example Research', description: 'Independent source notes', category: 'education', language: 'en',
    monthlyTarget: 2, status: 'ready', createdAt: NOW,
  };
  const task: Task = {
    id: 'task-betterthanhtml', siteId: site.id, channelId: 'betterthanhtml',
    sourceDomain: 'betterthanhtml.com', status: 'running', createdAt: NOW, updatedAt: NOW,
    scheduledAt: NOW, attempts: 1, message: '', topicUrl: TARGET,
    draft: { title: TITLE, description: DESCRIPTION, body: BODY },
    draftUpdatedAt: '2026-10-08T13:00:00.000Z', articleApprovedAt: NOW,
  };
  const checkpoints: Partial<Task>[] = [];
  const abort = new AbortController();
  let accountCalls = 0;
  let failingCheckpoint = '';
  const context: ExecutionContext = {
    site, task, channel: channel(), settings: defaultSettings(), signal: abort.signal,
    ai: { json: async <T>() => ({} as T) },
    secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    getAccount: () => { accountCalls++; return undefined; },
    saveAccount: async () => { accountCalls++; throw Error('Better Than HTML must not create an account'); },
    checkpoint: partial => {
      if (partial.checkpoint === failingCheckpoint) throw Error('save failed');
      checkpoints.push(structuredClone(partial));
      Object.assign(task, partial);
    },
    log: () => {},
  };
  return { site, task, context, checkpoints, abort, accountCalls: () => accountCalls,
    failCheckpoint: (value: string) => { failingCheckpoint = value; } };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function page(f: ReturnType<typeof fixture>, transform: (html: string) => string = value => value): string {
  const expected = betterThanHtmlTesting.article(f.task, f.site.url, false);
  const withPlatformControl = expected.html.replace('<body>', '<body><nav aria-label="Workshop"><a href="/workshop">Workshop</a></nav>');
  const withLinkPolicy = withPlatformControl.replace(
    `<a href="${TARGET}">`, `<a href="${TARGET}" rel="nofollow ugc" target="_blank">`,
  );
  return transform(withLinkPolicy);
}

function workshopItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, title: TITLE, description: DESCRIPTION, author: 'Anonymous', category: 'leaflet',
    created_at: Date.parse(NOW) + 1_500, expires_at: 9_999_999_999_999, status: 'active',
    ...overrides,
  };
}

function pendingIntent(f: ReturnType<typeof fixture>, submittedAt = NOW) {
  const expected = betterThanHtmlTesting.article(f.task, f.site.url, false);
  f.task.betterthanhtml = { contentHash: expected.contentHash, stage: 'submitting' };
  f.task.checkpoint = 'betterthanhtml_publish_submitting';
  f.task.submittedAt = submittedAt;
  delete f.task.publicUrl;
  return expected;
}

function server(f: ReturnType<typeof fixture>, options: {
  post?: Response;
  postError?: boolean;
  list?: unknown;
  listResponse?: () => Response;
  html?: string;
  pageHeaders?: Record<string, string>;
  pages?: Record<string, { html?: string; headers?: Record<string, string>; status?: number; error?: boolean }>;
} = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: BetterThanHtmlTransport = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://betterthanhtml.com/api/workshop/submit') {
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'manual');
      assert.equal(f.task.checkpoint, 'betterthanhtml_publish_submitting');
      assert.equal(f.task.betterthanhtml?.stage, 'submitting');
      assert.ok(f.task.submittedAt);
      if (options.postError) throw Error('response lost');
      return options.post ?? json({ ok: true, id: ID, url: PAGE });
    }
    if (url === LIST) {
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.equal(new Headers(init.headers).get('accept'), 'application/json');
      return options.listResponse?.() ?? json(options.list ?? { ok: true, active: [], promoted: [] });
    }
    const pageId = /^https:\/\/betterthanhtml\.com\/workshop\/([A-Za-z0-9_-]+)$/.exec(url)?.[1];
    const configured = pageId ? options.pages?.[pageId] : undefined;
    if (url === PAGE || configured) {
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      if (configured?.error) throw Error('candidate read failed');
      return new Response(configured?.html ?? options.html ?? page(f), { status: configured?.status ?? 200,
        headers: { 'content-type': 'text/html; charset=utf-8', ...(options.pageHeaders ?? {}),
          ...(configured?.headers ?? {}) } });
    }
    throw Error(`unexpected request: ${url}`);
  };
  return { fetch, calls, posts: () => calls.filter(call => call.init.method === 'POST') };
}

test('publishes one fixed static HTML document and verifies the complete public article', async () => {
  const f = fixture();
  const s = server(f);
  const result = await runBetterThanHtmlTask(f.context, { fetch: s.fetch, now: () => new Date(NOW) });
  assert.equal(result.status, 'review');
  assert.equal(result.checkpoint, 'betterthanhtml_published');
  assert.deepEqual(result.betterthanhtml, {
    contentHash: betterThanHtmlTesting.article(f.task, f.site.url, false).contentHash,
    id: ID, stage: 'published',
  });
  assert.equal(result.publicUrl, PAGE);
  assert.deepEqual(f.checkpoints.map(value => ({ checkpoint: value.checkpoint, id: value.betterthanhtml?.id,
    stage: value.betterthanhtml?.stage, publicUrl: value.publicUrl })), [
    { checkpoint: 'betterthanhtml_publish_submitting', id: undefined, stage: 'submitting', publicUrl: undefined },
    { checkpoint: 'betterthanhtml_publish_submitting', id: ID, stage: 'submitting', publicUrl: PAGE },
    { checkpoint: 'betterthanhtml_published', id: ID, stage: 'published', publicUrl: PAGE },
  ]);
  assert.deepEqual(s.calls.map(call => `${call.init.method} ${call.url}`), [
    'POST https://betterthanhtml.com/api/workshop/submit', `GET ${PAGE}`,
  ]);
  const payload = JSON.parse(String(s.calls[0].init.body)) as Record<string, unknown>;
  assert.equal(payload.title, TITLE);
  assert.equal(payload.description, DESCRIPTION);
  assert.equal(payload.category, 'leaflet');
  assert.equal(payload.author, undefined);
  assert.equal(payload.source_url, undefined);
  assert.equal(payload.lab, undefined);
  assert.equal(typeof payload.html, 'string');
  assert.ok(Buffer.byteLength(String(payload.html), 'utf8') < 2_000_000);
  assert.match(String(payload.html), /<main id="linkflow-article"><article><h1>A careful source record<\/h1>/);
  assert.match(String(payload.html), new RegExp(`href="${TARGET}"`));
  assert.doesNotMatch(String(payload.html), /<(?:script|iframe|img|video|audio|object|embed|form|link)\b/i);
  assert.doesNotMatch(String(payload.html), /\b(?:src|srcset)\s*=/i);
  assert.equal(f.accountCalls(), 0);

  const verified = await verifyBetterThanHtml(f.task, f.site.url, { fetch: s.fetch });
  assert.equal(verified.found, true);
  assert.equal(verified.outcome, 'found');
  assert.equal(verified.rel, 'nofollow ugc');
  assert.match(verified.reason, /不保证搜索收录或排名/);
});

test('value none in a robots preview directive does not mean noindex', async () => {
  const f = fixture();
  const expected = betterThanHtmlTesting.article(f.task, f.site.url, false);
  f.task.betterthanhtml = { contentHash: expected.contentHash, id: ID, stage: 'published' };
  f.task.publicUrl = PAGE;
  const s = server(f, { pageHeaders: {
    'x-robots-tag': 'index, follow, max-image-preview:none',
  } });
  const result = await verifyBetterThanHtml(f.task, f.site.url, { fetch: s.fetch });
  assert.equal(result.found, true);
  assert.equal(result.outcome, 'found');
});

test('authored whitespace survives inline formatting and remains part of exact verification', async () => {
  const f = fixture();
  f.task.draft!.body += '\n\nThe approach is **not** *recommended* without corroborating evidence.'
    + '\n\n```text\nalpha  beta\n  gamma\n```';
  const expected = betterThanHtmlTesting.article(f.task, f.site.url, false);
  assert.match(expected.bodyHtml, /<strong>not<\/strong> <em>recommended<\/em>/);
  assert.match(expected.bodyHtml, /<pre><code class="language-text">alpha  beta\n  gamma\n<\/code><\/pre>/);
  f.task.betterthanhtml = { contentHash: expected.contentHash, id: ID, stage: 'published' };
  f.task.publicUrl = PAGE;

  const intact = server(f);
  assert.equal((await verifyBetterThanHtml(f.task, f.site.url, { fetch: intact.fetch })).found, true);

  const damaged = server(f, { html: page(f, html => html.replace(
    '<strong>not</strong> <em>recommended</em>',
    '<strong>not</strong><em>recommended</em>',
  )) });
  const result = await verifyBetterThanHtml(f.task, f.site.url, { fetch: damaged.fetch });
  assert.equal(result.found, false);
  assert.equal(result.outcome, 'invalid');
});

test('accepts the first-party relative Workshop response without weakening origin checks', async () => {
  const f = fixture();
  const s = server(f, { post: json({ ok: true, id: ID, url: `/workshop/${ID}` }) });
  const result = await runBetterThanHtmlTask(f.context, { fetch: s.fetch });
  assert.equal(result.betterthanhtml?.id, ID);
  assert.equal(result.betterthanhtml?.stage, 'published');
  assert.equal(result.publicUrl, PAGE);
  assert.deepEqual(s.calls.map(call => `${call.init.method} ${call.url}`), [
    'POST https://betterthanhtml.com/api/workshop/submit', `GET ${PAGE}`,
  ]);
});

test('an ambiguous create performs exactly one POST and a slugless intent can never be resent', async () => {
  const f = fixture();
  const s = server(f, { postError: true });
  const first = await runBetterThanHtmlTask(f.context, { fetch: s.fetch });
  const second = await runBetterThanHtmlTask(f.context, { fetch: s.fetch });
  assert.equal(first.betterthanhtml?.stage, 'submitting');
  assert.equal(first.betterthanhtml?.id, undefined);
  assert.equal(second.status, 'review');
  assert.equal(second.publicUrl, undefined);
  assert.equal(s.posts().length, 1);
  assert.deepEqual(s.calls.map(call => `${call.init.method} ${call.url}`), [
    'POST https://betterthanhtml.com/api/workshop/submit', `GET ${LIST}`,
  ]);
  assert.match(second.message, /不会重发/);
});

test('pre-cancellation and an unpersisted intent prevent every network write', async () => {
  const cancelled = fixture();
  cancelled.abort.abort();
  let calls = 0;
  const result = await runBetterThanHtmlTask(cancelled.context, { fetch: async () => { calls++; return json({}); } });
  assert.equal(result.status, 'queued');
  assert.equal(calls, 0);
  assert.equal(cancelled.checkpoints.length, 0);

  const unsaved = fixture();
  unsaved.failCheckpoint('betterthanhtml_publish_submitting');
  const blocked = await runBetterThanHtmlTask(unsaved.context, { fetch: async () => { calls++; return json({}); } });
  assert.equal(blocked.status, 'queued');
  assert.equal(calls, 0);
});

test('a stored ID is reconciled with GET only and a matching public URL is checkpointed', async () => {
  const f = fixture();
  const expected = betterThanHtmlTesting.article(f.task, f.site.url, false);
  f.task.betterthanhtml = { contentHash: expected.contentHash, id: ID, stage: 'submitting' };
  f.task.publicUrl = PAGE;
  f.task.submittedAt = NOW;
  const s = server(f);
  const reconciled = await reconcileBetterThanHtmlTask(f.context, { fetch: s.fetch });
  assert.deepEqual(reconciled, { status: 'found', publicUrl: PAGE,
    betterthanhtml: { contentHash: expected.contentHash, id: ID, stage: 'published' } });
  const result = await runBetterThanHtmlTask(f.context, { fetch: s.fetch });
  assert.equal(result.betterthanhtml?.stage, 'published');
  assert.equal(s.posts().length, 0);
  assert.ok(s.calls.every(call => call.init.method === 'GET'));
});

test('a no-ID intent is recovered only after one exact list candidate passes complete GET verification', async () => {
  const f = fixture();
  const expected = pendingIntent(f);
  const recoveredId = 'fixture0007';
  const recoveredUrl = `https://betterthanhtml.com/workshop/${recoveredId}`;
  const s = server(f, {
    list: { ok: true, active: [workshopItem(recoveredId)], promoted: [] },
    pages: { [recoveredId]: {} },
  });
  const result = await reconcileBetterThanHtmlTask(f.context, { fetch: s.fetch });
  assert.deepEqual(result, { status: 'found', publicUrl: recoveredUrl,
    betterthanhtml: { contentHash: expected.contentHash, id: recoveredId, stage: 'published' } });
  assert.deepEqual(f.checkpoints, [{
    betterthanhtml: { contentHash: expected.contentHash, id: recoveredId, stage: 'submitting' },
    checkpoint: 'betterthanhtml_publish_submitting', publicUrl: recoveredUrl, submittedAt: NOW,
  }]);
  assert.deepEqual(s.calls.map(call => `${call.init.method} ${call.url}`), [
    `GET ${LIST}`, `GET ${recoveredUrl}`,
  ]);
  assert.equal(s.posts().length, 0);
});

test('normal execution can adopt the checkpointed recovery result without making another POST', async () => {
  const f = fixture();
  const expected = pendingIntent(f);
  const recoveredId = 'recover001';
  const recoveredUrl = `https://betterthanhtml.com/workshop/${recoveredId}`;
  const s = server(f, {
    list: { ok: true, active: [workshopItem(recoveredId)], promoted: [] },
    pages: { [recoveredId]: {} },
  });
  const result = await runBetterThanHtmlTask(f.context, { fetch: s.fetch });
  assert.equal(result.status, 'review');
  assert.equal(result.publicUrl, recoveredUrl);
  assert.deepEqual(result.betterthanhtml, { contentHash: expected.contentHash, id: recoveredId, stage: 'published' });
  assert.deepEqual(f.checkpoints.map(value => ({ checkpoint: value.checkpoint,
    id: value.betterthanhtml?.id, stage: value.betterthanhtml?.stage })), [
    { checkpoint: 'betterthanhtml_publish_submitting', id: recoveredId, stage: 'submitting' },
    { checkpoint: 'betterthanhtml_published', id: recoveredId, stage: 'published' },
  ]);
  assert.equal(s.posts().length, 0);
  assert.ok(s.calls.every(call => call.init.method === 'GET'));
});

test('list recovery requires exact metadata, a narrow epoch window, and no more than five candidates', async t => {
  const rejected: Array<{ name: string; item: Record<string, unknown>; submittedAt?: string }> = [
    { name: 'title', item: workshopItem('wrongtitle', { title: `${TITLE}!` }) },
    { name: 'description', item: workshopItem('wrongdesc', { description: `${DESCRIPTION}!` }) },
    { name: 'author', item: workshopItem('wrongauthor', { author: 'anonymous' }) },
    { name: 'category', item: workshopItem('wrongcategory', { category: 'article' }) },
    { name: 'status', item: workshopItem('wrongstatus', { status: 'promoted' }) },
    { name: 'unsafe id', item: workshopItem('../escape') },
    { name: 'too early', item: workshopItem('tooearly', { created_at: Date.parse(NOW) - 60_001 }) },
    { name: 'too late', item: workshopItem('toolate', { created_at: Date.parse(NOW) + 120_001 }) },
  ];
  for (const item of rejected) await t.test(item.name, async () => {
    const f = fixture();
    pendingIntent(f, item.submittedAt ?? NOW);
    const s = server(f, { list: { ok: true, active: [item.item], promoted: [] } });
    assert.deepEqual(await reconcileBetterThanHtmlTask(f.context, { fetch: s.fetch }), { status: 'unknown' });
    assert.deepEqual(s.calls.map(call => call.url), [LIST]);
    assert.equal(f.checkpoints.length, 0);
  });

  await t.test('noncanonical submittedAt is rejected before reading the list', async () => {
    const f = fixture();
    pendingIntent(f, '2026-10-08T14:00:00+00:00');
    let calls = 0;
    assert.deepEqual(await reconcileBetterThanHtmlTask(f.context, { fetch: async () => { calls++; return json({}); } }),
      { status: 'unknown' });
    assert.equal(calls, 0);
  });

  await t.test('six candidates stop after the one bounded list read', async () => {
    const f = fixture();
    pendingIntent(f);
    const active = Array.from({ length: 6 }, (_, index) => workshopItem(`candidate${index}`));
    const s = server(f, { list: { ok: true, active, promoted: [] } });
    assert.deepEqual(await reconcileBetterThanHtmlTask(f.context, { fetch: s.fetch }), { status: 'unknown' });
    assert.deepEqual(s.calls.map(call => call.url), [LIST]);
    assert.equal(f.checkpoints.length, 0);
  });
});

test('recovery checks every bounded candidate and requires exactly one complete public match', async t => {
  await t.test('two complete matches are ambiguous', async () => {
    const f = fixture();
    pendingIntent(f);
    const ids = ['duplicate01', 'duplicate02'];
    const s = server(f, { list: { ok: true, active: ids.map(id => workshopItem(id)), promoted: [] },
      pages: { [ids[0]]: {}, [ids[1]]: {} } });
    assert.deepEqual(await reconcileBetterThanHtmlTask(f.context, { fetch: s.fetch }), { status: 'unknown' });
    assert.deepEqual(s.calls.map(call => call.url), [LIST, ...ids.map(id => `https://betterthanhtml.com/workshop/${id}`)]);
    assert.equal(f.checkpoints.length, 0);
  });

  await t.test('one exact match plus one deterministic mismatch is uniquely recoverable', async () => {
    const f = fixture();
    pendingIntent(f);
    const exact = 'exactmatch1';
    const mismatch = 'mismatch01';
    const s = server(f, { list: { ok: true, active: [workshopItem(exact), workshopItem(mismatch)], promoted: [] },
      pages: { [exact]: {}, [mismatch]: { html: page(f, html => html.replace(
        'Before drawing a conclusion', 'This candidate contains different text',
      )) } } });
    const result = await reconcileBetterThanHtmlTask(f.context, { fetch: s.fetch });
    assert.equal(result.status, 'found');
    assert.equal(result.status === 'found' ? result.betterthanhtml.id : undefined, exact);
    assert.deepEqual(s.calls.map(call => call.url), [LIST,
      `https://betterthanhtml.com/workshop/${exact}`,
      `https://betterthanhtml.com/workshop/${mismatch}`]);
  });

  await t.test('indexability cannot choose between two pages with the same complete identity', async () => {
    const f = fixture();
    pendingIntent(f);
    const ids = ['indexable01', 'noindex001'];
    const s = server(f, { list: { ok: true, active: ids.map(id => workshopItem(id)), promoted: [] },
      pages: { [ids[0]]: {}, [ids[1]]: { html: page(f, value => value.replace(
        'content="index,follow"', 'content="noindex,follow"',
      )) } } });
    assert.deepEqual(await reconcileBetterThanHtmlTask(f.context, { fetch: s.fetch }), { status: 'unknown' });
    assert.equal(f.checkpoints.length, 0);
  });

  for (const [name, html] of [
    ['noindex', page(fixture(), value => value.replace('content="index,follow"', 'content="noindex,follow"'))],
    ['incomplete body', page(fixture(), value => value.replace('Before drawing a conclusion', 'Truncated'))],
  ] as const) await t.test(name, async () => {
    const f = fixture();
    pendingIntent(f);
    const id = `invalid${name === 'noindex' ? 'robots' : 'body'}`;
    const s = server(f, { list: { ok: true, active: [workshopItem(id)], promoted: [] }, pages: { [id]: { html } } });
    assert.deepEqual(await reconcileBetterThanHtmlTask(f.context, { fetch: s.fetch }), { status: 'unknown' });
    assert.equal(f.checkpoints.length, 0);
  });

  await t.test('an uncertain read of any candidate prevents a claim', async () => {
    const f = fixture();
    pendingIntent(f);
    const ids = ['readable01', 'unreachable1'];
    const s = server(f, { list: { ok: true, active: ids.map(id => workshopItem(id)), promoted: [] },
      pages: { [ids[0]]: {}, [ids[1]]: { error: true } } });
    assert.deepEqual(await reconcileBetterThanHtmlTask(f.context, { fetch: s.fetch }), { status: 'unknown' });
    assert.equal(f.checkpoints.length, 0);
  });

  await t.test('an invalid HTTP response for any candidate also prevents a claim', async () => {
    const f = fixture();
    pendingIntent(f);
    const ids = ['readable02', 'redirected1'];
    const s = server(f, { list: { ok: true, active: ids.map(id => workshopItem(id)), promoted: [] },
      pages: { [ids[0]]: {}, [ids[1]]: { status: 302 } } });
    assert.deepEqual(await reconcileBetterThanHtmlTask(f.context, { fetch: s.fetch }), { status: 'unknown' });
    assert.equal(f.checkpoints.length, 0);
  });
});

test('malformed, redirected, oversized, or conflicting lists cannot yield a recovered identity', async t => {
  const cases: Array<{ name: string; response: () => Response }> = [
    { name: 'invalid JSON', response: () => new Response('{', { status: 200,
      headers: { 'content-type': 'application/json' } }) },
    { name: 'wrong media type', response: () => new Response(JSON.stringify({ ok: true, active: [], promoted: [] }),
      { status: 200, headers: { 'content-type': 'text/html' } }) },
    { name: 'redirect', response: () => new Response('', { status: 302, headers: { location: `${LIST}?page=2` } }) },
    { name: 'declared oversized', response: () => new Response('', { status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '128001' } }) },
    { name: 'incomplete unrelated row', response: () => json({ ok: true,
      active: [workshopItem('candidate1'), { id: 'brokenrow' }], promoted: [] }) },
    { name: 'pagination marker', response: () => json({ ok: true,
      active: [workshopItem('candidate1')], promoted: [], next_cursor: 'page-2' }) },
    { name: 'conflicting duplicate id', response: () => json({ ok: true, active: [
      workshopItem('sameid001'), workshopItem('sameid001', { created_at: Date.parse(NOW) + 2_000 }),
    ], promoted: [] }) },
    { name: 'cross-origin response URL', response: () => {
      const response = json({ ok: true, active: [], promoted: [] });
      Object.defineProperty(response, 'url', { value: 'https://evil.example/api/workshop/list' });
      return response;
    } },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const f = fixture();
    pendingIntent(f);
    const calls: string[] = [];
    const fetch: BetterThanHtmlTransport = async (url, init) => {
      calls.push(`${init.method} ${url}`);
      assert.equal(url, LIST);
      return item.response();
    };
    assert.deepEqual(await reconcileBetterThanHtmlTask(f.context, { fetch }), { status: 'unknown' });
    assert.deepEqual(calls, [`GET ${LIST}`]);
    assert.equal(f.checkpoints.length, 0);
  });
});

test('cancelled or unpersistable recovery stays unknown after GET only', async () => {
  const cancelled = fixture();
  pendingIntent(cancelled);
  cancelled.abort.abort();
  let calls = 0;
  assert.deepEqual(await reconcileBetterThanHtmlTask(cancelled.context, {
    fetch: async () => { calls++; return json({}); },
  }), { status: 'unknown' });
  assert.equal(calls, 0);

  const unsaved = fixture();
  pendingIntent(unsaved);
  unsaved.failCheckpoint('betterthanhtml_publish_submitting');
  const id = 'unsaved001';
  const s = server(unsaved, { list: { ok: true, active: [workshopItem(id)], promoted: [] }, pages: { [id]: {} } });
  assert.deepEqual(await reconcileBetterThanHtmlTask(unsaved.context, { fetch: s.fetch }), { status: 'unknown' });
  assert.equal(s.posts().length, 0);
  assert.equal(unsaved.checkpoints.length, 0);

  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.task.publicUrl = ''; },
    (f: ReturnType<typeof fixture>) => { f.task.accountId = 'unexpected-account'; },
  ]) {
    const invalid = fixture();
    pendingIntent(invalid);
    mutate(invalid);
    let invalidCalls = 0;
    assert.deepEqual(await reconcileBetterThanHtmlTask(invalid.context, {
      fetch: async () => { invalidCalls++; return json({}); },
    }), { status: 'unknown' });
    assert.equal(invalidCalls, 0);
  }
});

test('invalid response identities only allow the fixed read-only recovery list and never a replacement POST', async () => {
  for (const response of [
    { ok: true, id: '../escape', url: 'https://betterthanhtml.com/workshop/../escape' },
    { ok: true, id: ID, url: 'https://betterthanhtml.com/workshop/different' },
    { ok: true, id: ID, url: `https://evil.example/workshop/${ID}` },
    { ok: true, id: ID, url: `//evil.example/workshop/${ID}` },
    { ok: true, id: ID, url: `/workshop/${ID}?next=https://evil.example` },
    { ok: true, id: ID, url: `/workshop/${ID}/` },
    { ok: true, id: ID, url: `workshop/${ID}` },
    { ok: false, id: ID, url: PAGE },
  ]) {
    const f = fixture();
    const s = server(f, { post: json(response) });
    const first = await runBetterThanHtmlTask(f.context, { fetch: s.fetch });
    const second = await runBetterThanHtmlTask(f.context, { fetch: s.fetch });
    assert.equal(first.betterthanhtml?.id, undefined);
    assert.equal(second.publicUrl, undefined);
    assert.equal(s.posts().length, 1);
    assert.deepEqual(s.calls.map(call => `${call.init.method} ${call.url}`), [
      'POST https://betterthanhtml.com/api/workshop/submit', `GET ${LIST}`,
    ]);
  }

  const conflict = fixture();
  const expected = betterThanHtmlTesting.article(conflict.task, conflict.site.url, false);
  conflict.task.betterthanhtml = { contentHash: expected.contentHash, id: ID, stage: 'submitting' };
  conflict.task.publicUrl = 'https://betterthanhtml.com/workshop/other123';
  let calls = 0;
  const result = await runBetterThanHtmlTask(conflict.context, { fetch: async () => { calls++; return json({}); } });
  assert.equal(result.status, 'needs_input');
  assert.equal(calls, 0);
});

test('unreviewed, stale, changed, wrong-site, and malicious drafts stop before submission', async () => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { delete f.task.articleApprovedAt; },
    f => { f.task.draftUpdatedAt = '2026-10-08T15:00:00.000Z'; },
    f => { f.task.articleReview = { status: 'passed', reason: 'old review', evidenceUrls: [], draftRevision: 0,
      contentHash: '0'.repeat(64), contextHash: '1'.repeat(64) }; },
    f => { f.task.topicUrl = 'https://other.example/article'; f.task.draft!.body = BODY.replace(TARGET, 'https://other.example/article'); },
    f => { f.task.draft!.body += '\n\n<script>fetch("https://tracker.example")</script>'; },
    f => { f.task.draft!.body += '\n\n![tracking pixel](https://tracker.example/pixel.png)'; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    let calls = 0;
    const result = await runBetterThanHtmlTask(f.context, { fetch: async () => { calls++; return json({}); } });
    assert.equal(result.status, 'needs_input');
    assert.equal(calls, 0);
    assert.equal(f.checkpoints.length, 0);
  }

  const wrongChannel = fixture();
  wrongChannel.context.channel.domain = 'other.example';
  let calls = 0;
  assert.equal((await runBetterThanHtmlTask(wrongChannel.context, { fetch: async () => { calls++; return json({}); } })).status, 'needs_input');
  assert.equal(calls, 0);
});

test('changed content or an invalid receipt hash can only preserve the prior intent', async () => {
  const f = fixture();
  const original = betterThanHtmlTesting.article(f.task, f.site.url, false);
  f.task.betterthanhtml = { contentHash: original.contentHash, id: ID, stage: 'submitting' };
  f.task.publicUrl = PAGE;
  f.task.submittedAt = NOW;
  f.task.draft!.body += '\n\nA later unreviewed paragraph changes the publication bytes.';
  let calls = 0;
  const result = await runBetterThanHtmlTask(f.context, { fetch: async () => { calls++; return new Response(); } });
  assert.equal(result.status, 'review');
  assert.equal(result.betterthanhtml?.contentHash, original.contentHash);
  assert.equal(calls, 0);

  const invalid = fixture();
  invalid.task.betterthanhtml = { contentHash: 'not-a-hash', id: ID, stage: 'submitting' };
  invalid.task.publicUrl = PAGE;
  invalid.task.submittedAt = NOW;
  const invalidResult = await verifyBetterThanHtml(invalid.task, invalid.site.url, { fetch: async () => { calls++; return new Response(); } });
  assert.equal(invalidResult.found, false);
  assert.equal(invalidResult.outcome, 'invalid');
  assert.equal(calls, 0);
});

test('verification rejects noindex, hidden or active content, wrong titles, incomplete bodies, and changed links', async t => {
  const cases: Array<{ name: string; transform?: (html: string) => string; headers?: Record<string, string> }> = [
    { name: 'robots meta noindex', transform: html => html.replace('content="index,follow"', 'content="noindex,follow"') },
    { name: 'x-robots-tag none', headers: { 'x-robots-tag': 'none' } },
    { name: 'hidden article', transform: html => html.replace('<main id="linkflow-article">', '<main id="linkflow-article" hidden>') },
    { name: 'active script in body', transform: html => html.replace('</div></article>', '<script>document.body.textContent="changed"</script></div></article>') },
    { name: 'wrong title', transform: html => html.replace(`<h1>${TITLE}</h1>`, '<h1>Different title</h1>') },
    { name: 'incomplete body', transform: html => html.replace('Before drawing a conclusion', 'A shortened ending') },
    { name: 'changed secondary link', transform: html => html.replace(SECOND_LINK, 'https://docs.example.org/other') },
    { name: 'extra authored link', transform: html => html.replace('</div></article>', '<p><a href="https://extra.example/page">Extra claim</a></p></div></article>') },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const f = fixture();
    const expected = betterThanHtmlTesting.article(f.task, f.site.url, false);
    f.task.betterthanhtml = { contentHash: expected.contentHash, id: ID, stage: 'published' };
    f.task.publicUrl = PAGE;
    const s = server(f, { html: page(f, item.transform), pageHeaders: item.headers });
    const result = await verifyBetterThanHtml(f.task, f.site.url, { fetch: s.fetch });
    assert.equal(result.found, false);
    assert.equal(result.outcome, 'invalid');
    assert.ok(s.calls.every(call => call.init.method === 'GET'));
  });
});

test('overlong title and full HTML are rejected explicitly instead of being truncated', async () => {
  const title = fixture();
  title.task.draft!.title = '💡'.repeat(81);
  let calls = 0;
  const badTitle = await runBetterThanHtmlTask(title.context, { fetch: async () => { calls++; return json({}); } });
  assert.equal(badTitle.status, 'needs_input');
  assert.match(badTitle.message, /1–80/);

  const body = fixture();
  body.task.draft!.body = `${BODY}\n\n${'x'.repeat(2_000_000)}`;
  const tooLarge = await runBetterThanHtmlTask(body.context, { fetch: async () => { calls++; return json({}); } });
  assert.equal(tooLarge.status, 'needs_input');
  assert.match(tooLarge.message, /2 MB|超过/);
  assert.equal(calls, 0);
});

test('header rejection stops the response body without waiting for cancellation', { timeout: 2_000 }, async t => {
  for (const kind of ['declared oversize', 'redirect', 'foreign URL', 'hanging cancellation'] as const) {
    await t.test(kind, async () => {
      const f = fixture();
      let cancels = 0;
      let pulls = 0;
      let posts = 0;
      let requestSignal: AbortSignal | undefined;
      const rejected = new Response(new ReadableStream<Uint8Array>({
        pull() { pulls++; },
        cancel() {
          cancels++;
          if (kind === 'hanging cancellation') return new Promise<void>(() => {});
        },
      }, { highWaterMark: 0 }), {
        status: kind === 'redirect' ? 302 : 200,
        headers: { 'content-type': 'application/json',
          ...(kind === 'declared oversize' || kind === 'hanging cancellation'
            ? { 'content-length': '128001' } : {}) },
      });
      if (kind === 'foreign URL') Object.defineProperty(rejected, 'url', { value: 'https://example.org/unexpected' });
      const result = await runBetterThanHtmlTask(f.context, { fetch: async (_url, init) => {
        assert.equal(init.method, 'POST');
        posts++;
        requestSignal = init.signal as AbortSignal;
        return rejected;
      } });
      assert.equal(posts, 1);
      assert.equal(cancels, 1);
      assert.equal(pulls, 0);
      assert.equal(requestSignal?.aborted, true);
      assert.equal(rejected.body?.locked, false);
      assert.equal(result.status, 'review');
      assert.equal(result.betterthanhtml?.stage, 'submitting');
      assert.ok(f.task.submittedAt);
      assert.equal(result.publicUrl, undefined);
    });
  }
});
