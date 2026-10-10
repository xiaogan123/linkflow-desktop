import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectWordPressAccount, listWordPressSites, reconcileWordPressTask, runWordPressTask,
  verifyWordPressPublication, wordpressTesting, type WordPressDependencies, type WordPressReceipt, type WordPressTransport,
} from '../src/integrations/wordpress';
import { defaultSettings } from '../src/main/store';
import { articleContentHash, articleContextHash } from '../src/main/article-review';
import type { Account, Channel, ExecutionContext, Site, Task } from '../src/shared/types';

const NOW = '2026-10-08T12:00:00.000Z';
const EXPIRES_AT = '2026-10-09T12:00:00.000Z';
const TOKEN = 'synthetic-wordpress-oauth-token';
const BLOG_ID = '123456';
const AUTHOR_ID = '778899';
const BLOG = 'https://example-notes.wordpress.com/';
const TARGET = 'https://example.com/research/source-checking';
const SECOND_LINK = 'https://www.iana.org/help/example-domains';
const TITLE = 'A reproducible source-checking workflow';
const BODY = [
  `A useful source check begins by recording the exact claim, its publication date, and the evidence that can change. The [maintained research notes](${TARGET}) show the related operating context and the limits of that evidence. A reader should still compare the current primary source before relying on a conclusion.`,
  `The process separates observation from interpretation, preserves unresolved questions, and links to [IANA's explanation](${SECOND_LINK}) for an independent example-domain reference. This is AI-assisted promotional writing for the operator's own site, and the operator may receive referral commissions. That relationship does not prove accuracy or guarantee any financial or search result.`,
].join('\n\n');

type WordPressTask = Task & { wordpress?: WordPressReceipt };

// Fixture credentials and approvals share one clock; individual expiry tests can override it.
function runFixtureTask(context: ExecutionContext, dependencies: WordPressDependencies = {}) {
  return runWordPressTask(context, { now: () => new Date(NOW), ...dependencies });
}

function channel(): Channel {
  return {
    id: 'wordpress-com', name: 'WordPress.com', domain: 'wordpress.com', url: 'https://wordpress.com/',
    submitUrl: 'https://wordpress.com/', categories: ['content'], languages: ['*'], kind: 'article',
    emailRequired: false, accountRequired: true, articleRequired: true, free: 'conditional', freeNote: 'Hosted free site',
    automation: 'api', quality: 'B', qualityReason: 'Hosted original publication', rulesUrl: 'https://wordpress.com/support/user-guidelines/',
    checkedAt: '2026-10-08', notes: '', allowedHosts: ['wordpress.com'], enabled: true,
  };
}

function fixture(overrides: { task?: Partial<Task>; account?: Partial<Account> } = {}) {
  const site: Site = {
    id: 'site', domain: 'example.com', url: 'https://example.com/', email: 'owner@example.com', name: 'Example Lab',
    description: 'Source research', category: 'education', language: 'en', monthlyTarget: 2, status: 'ready', createdAt: NOW,
  };
  const settings = { ...defaultSettings(), articleReviewMode: 'ai' as const };
  const task: WordPressTask = {
    id: 'task-wordpress-01', siteId: site.id, channelId: 'wordpress-com', accountId: 'wordpress-account',
    sourceDomain: 'wordpress.com', status: 'running', createdAt: NOW, scheduledAt: NOW, updatedAt: NOW,
    attempts: 1, message: '', topicUrl: TARGET, draftRevision: 3,
    draft: { title: TITLE, description: 'A source-checking method', body: BODY }, articleApprovedAt: NOW,
    articleReview: { status: 'passed', reason: 'independent review passed', reasonCode: 'passed', evidenceUrls: [],
      draftRevision: 3, contentHash: 'a'.repeat(64), contextHash: 'b'.repeat(64) },
    ...overrides.task,
  };
  let account: Account = {
    id: 'wordpress-account', channelId: 'wordpress-com', email: '', username: BLOG_ID, publicationUrl: BLOG,
    credentialKind: 'oauth', status: 'registered', hasPassword: true, source: 'imported', createdAt: NOW,
    ...overrides.account,
  };
  if (task.articleReview && task.articleReview.contentHash === 'a'.repeat(64)) {
    task.articleReview = { ...task.articleReview, reviewContractVersion: 4, contentHash: articleContentHash(task),
      contextHash: articleContextHash(site, channel(), settings, account) };
  }
  const secrets = new Map([[`account:${account.id}`, JSON.stringify({ version: 1, accessToken: TOKEN,
    expiresAt: EXPIRES_AT, blogId: BLOG_ID, ownerId: AUTHOR_ID })]]);
  const checkpoints: Array<Partial<Task> & { wordpress?: WordPressReceipt }> = [];
  const abort = new AbortController();
  const context: ExecutionContext = {
    site, task, channel: channel(), settings, signal: abort.signal,
    ai: { json: async <T>() => ({} as T) },
    secrets: { get: async key => secrets.get(key), set: async (key, value) => { secrets.set(key, value); },
      delete: async key => { secrets.delete(key); } },
    getAccount: () => account,
    saveAccount: async next => { account = next; },
    checkpoint: partial => { const value = structuredClone(partial) as typeof checkpoints[number]; checkpoints.push(value); Object.assign(task, value); },
    log: () => undefined,
  };
  return { site, task, context, account: () => account, secrets, checkpoints, abort };
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

function html(value: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(value, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}

function identity() { return { ID: Number(AUTHOR_ID), username: 'example-owner' }; }
function writableSite(overrides: Record<string, unknown> = {}) {
  return { ID: Number(BLOG_ID), name: 'Example Notes', URL: BLOG, jetpack: false, is_private: false,
    is_coming_soon: false, launch_status: 'launched', user_can_manage: true,
    capabilities: { publish_posts: true, edit_posts: true }, ...overrides };
}

function article(f: ReturnType<typeof fixture>) {
  return wordpressTesting.approvedArticle(f.task, f.site.url, false);
}

function postUrl(f: ReturnType<typeof fixture>) {
  return `${BLOG}2026/10/08/${article(f).slug}/`;
}

function legacyPost(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const expected = article(f);
  return { ID: 987654, site_ID: Number(BLOG_ID), author: { ID: Number(AUTHOR_ID), login: 'example-owner' },
    title: TITLE, URL: postUrl(f), content: expected.html, slug: expected.slug, status: 'publish', ...overrides };
}

function createdPost(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const expected = article(f);
  return { id: 987654, author: Number(AUTHOR_ID), slug: expected.slug, status: 'publish', link: postUrl(f),
    title: { rendered: TITLE }, content: { rendered: expected.html }, ...overrides };
}

function publicPage(f: ReturnType<typeof fixture>, options: {
  body?: string; canonical?: string; head?: string; title?: string; bodyAttributes?: string;
} = {}) {
  const expected = article(f);
  return `<!doctype html><html><head><link rel="canonical" href="${options.canonical ?? postUrl(f)}">${options.head ?? ''}</head>`
    + `<body><article><h1 class="entry-title">${options.title ?? TITLE}</h1>`
    + `<div class="entry-content"${options.bodyAttributes ? ` ${options.bodyAttributes}` : ''}>${options.body ?? expected.html}</div>`
    + '</article></body></html>';
}

function successfulServer(f: ReturnType<typeof fixture>, options: {
  disconnectPost?: boolean; remoteCreatedOnDisconnect?: boolean; legacy?: Record<string, unknown>;
  created?: Record<string, unknown>; postResponse?: Response; page?: string; pageHeaders?: Record<string, string>;
} = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let published = false;
  const fetch: WordPressTransport = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://public-api.wordpress.com/rest/v1.1/me') {
      assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
      return json(identity());
    }
    if (url === 'https://public-api.wordpress.com/rest/v1.1/me/sites') {
      assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
      return json({ sites: [writableSite()] });
    }
    if (url === `https://public-api.wordpress.com/rest/v1.1/sites/${BLOG_ID}`) {
      assert.equal((init.headers as Record<string, string>).authorization, undefined);
      return json(writableSite());
    }
    if (url === `https://public-api.wordpress.com/rest/v1.1/sites/${BLOG_ID}/posts/slug:${article(f).slug}`) {
      assert.equal((init.headers as Record<string, string>).authorization, undefined);
      if (!published && !f.task.wordpress) return json({ error: 'unknown_post' }, 404);
      if (!published && f.task.wordpress) return json({ error: 'unknown_post' }, 404);
      return json(legacyPost(f, options.legacy));
    }
    if (url === `https://public-api.wordpress.com/wp/v2/sites/${BLOG_ID}/posts`) {
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
      const expected = article(f);
      assert.deepEqual(JSON.parse(String(init.body)), { title: TITLE, content: expected.html, status: 'publish', slug: expected.slug });
      assert.equal(f.task.wordpress?.stage, 'submitting');
      assert.equal(f.task.checkpoint, 'wordpress_publish_submitting');
      assert.ok(f.task.submittedAt);
      if (options.remoteCreatedOnDisconnect) published = true;
      if (options.disconnectPost) throw Error('socket reset after request');
      if (options.postResponse) return options.postResponse;
      published = true;
      return json(createdPost(f, options.created), 201);
    }
    if (url === postUrl(f)) {
      assert.equal((init.headers as Record<string, string>).authorization, undefined);
      return html(options.page ?? publicPage(f), 200, options.pageHeaders);
    }
    throw Error(`unexpected request ${init.method} ${url}`);
  };
  return { fetch, calls, markPublished: () => { published = true; } };
}

test('connection lists only public writable WordPress.com-hosted blogs and stores the token only after selection succeeds', async () => {
  const saved = new Map<string, string>();
  const requests: string[] = [];
  const fetch: WordPressTransport = async (url, init) => {
    requests.push(url);
    assert.equal((init.headers as Record<string, string>).authorization,
      url.endsWith('/me') || url.endsWith('/me/sites') ? `Bearer ${TOKEN}` : undefined);
    if (url.endsWith('/me')) return json(identity());
    if (url.endsWith('/me/sites')) return json({ sites: [
      writableSite(),
      writableSite({ ID: 2, URL: 'https://custom.example.com/' }),
      writableSite({ ID: 3, URL: 'https://jetpack.wordpress.com/', jetpack: true }),
      writableSite({ ID: 4, URL: 'https://private.wordpress.com/', is_private: true }),
      writableSite({ ID: 5, URL: 'https://readonly.wordpress.com/', capabilities: { publish_posts: false, edit_posts: true } }),
      writableSite({ ID: 6, URL: 'https://soon.wordpress.com/', is_coming_soon: true, launch_status: 'unlaunched' }),
    ] });
    if (url.endsWith(`/sites/${BLOG_ID}`)) return json(writableSite());
    if (url.endsWith('/sites/6')) return json(writableSite({ ID: 6, URL: 'https://soon.wordpress.com/',
      is_coming_soon: true, launch_status: 'unlaunched' }));
    throw Error(`unexpected request ${url}`);
  };
  const vault = { get: async (key: string) => saved.get(key), set: async (key: string, value: string) => { saved.set(key, value); },
    delete: async (key: string) => { saved.delete(key); } };
  assert.deepEqual(await listWordPressSites(TOKEN, { fetch }), [
    { id: BLOG_ID, url: BLOG, name: 'Example Notes', ownerId: AUTHOR_ID },
  ]);
  const result = await connectWordPressAccount(vault, 'new-account', BLOG_ID, TOKEN,
    { fetch, expiresAt: EXPIRES_AT, now: () => new Date(NOW) });
  assert.deepEqual(result, { username: BLOG_ID, url: BLOG, name: 'Example Notes', ownerId: AUTHOR_ID });
  assert.deepEqual(JSON.parse(saved.get('account:new-account')!), {
    version: 1, accessToken: TOKEN, expiresAt: EXPIRES_AT, blogId: BLOG_ID, ownerId: AUTHOR_ID,
  });
  assert.equal(JSON.stringify({ result, requests }).includes(TOKEN), false);
  await assert.rejects(connectWordPressAccount(vault, 'bad-account', '2', TOKEN,
    { fetch, expiresAt: EXPIRES_AT, now: () => new Date(NOW) }));
  assert.equal(saved.has('account:bad-account'), false);
});

test('approved article persists stable intent, sends one safe wp/v2 create, and verifies anonymous API plus public HTML', async () => {
  const f = fixture();
  const server = successfulServer(f);
  const result = await runFixtureTask(f.context, { fetch: server.fetch, now: () => new Date(NOW) });
  assert.equal(result.status, 'review');
  assert.equal(result.publicUrl, postUrl(f));
  assert.equal(result.wordpress?.stage, 'published');
  assert.equal(result.wordpress?.blogId, BLOG_ID);
  assert.equal(result.wordpress?.authorId, AUTHOR_ID);
  assert.equal(result.wordpress?.postId, '987654');
  assert.equal(result.submittedAt, NOW);
  assert.deepEqual(f.checkpoints.map(item => ({ checkpoint: item.checkpoint, stage: item.wordpress?.stage,
    postId: item.wordpress?.postId, url: item.wordpress?.url })), [
    { checkpoint: 'wordpress_publish_submitting', stage: 'submitting', postId: undefined, url: undefined },
    { checkpoint: 'wordpress_publish_submitting', stage: 'submitting', postId: '987654', url: postUrl(f) },
    { checkpoint: 'wordpress_published', stage: 'published', postId: '987654', url: postUrl(f) },
  ]);
  assert.deepEqual(server.calls.map(call => `${call.init.method ?? 'GET'} ${call.url}`), [
    'GET https://public-api.wordpress.com/rest/v1.1/me',
    'GET https://public-api.wordpress.com/rest/v1.1/me/sites',
    `GET https://public-api.wordpress.com/rest/v1.1/sites/${BLOG_ID}`,
    `GET https://public-api.wordpress.com/rest/v1.1/sites/${BLOG_ID}/posts/slug:${article(f).slug}`,
    `POST https://public-api.wordpress.com/wp/v2/sites/${BLOG_ID}/posts`,
    `GET https://public-api.wordpress.com/rest/v1.1/sites/${BLOG_ID}/posts/slug:${article(f).slug}`,
    `GET ${postUrl(f)}`,
  ]);
  assert.equal(JSON.stringify({ result, checkpoints: f.checkpoints, calls: server.calls.map(item => item.url) }).includes(TOKEN), false);
  assert.match(result.message, /收录不保证/);
});

test('failed or stale independent article review blocks all identity checks and publishing', async t => {
  for (const task of [
    { articleReview: { ...fixture().task.articleReview!, status: 'failed' as const } },
    { articleReview: { ...fixture().task.articleReview!, draftRevision: 2 } },
    { articleApprovedAt: undefined },
  ]) await t.test(JSON.stringify(task), async () => {
    const f = fixture({ task });
    let calls = 0;
    const result = await runFixtureTask(f.context, { fetch: async () => { calls++; return json({}); } });
    assert.equal(result.status, 'needs_input');
    assert.equal(calls, 0);
    assert.equal(f.checkpoints.length, 0);
  });
});

test('unsafe HTML, scripts, images, missing target, and non-HTTPS links never reach the API', async t => {
  for (const body of [
    BODY + '\n\n<script>alert(1)</script>',
    BODY + '\n\n![tracking](https://example.com/pixel.png)',
    BODY.replace(`[maintained research notes](${TARGET})`, 'maintained research notes'),
    BODY + '\n\n[local metadata](http://127.0.0.1/secret)',
  ]) await t.test(body.slice(-35), async () => {
    const f = fixture({ task: { draft: { title: TITLE, description: '', body } } });
    let calls = 0;
    const result = await runFixtureTask(f.context, { fetch: async () => { calls++; return json({}); } });
    assert.equal(result.status, 'needs_input');
    assert.equal(calls, 0);
  });
});

test('modified draft, conflicting public URL, or changed account identity cannot replace an existing intent', async t => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.task.draft!.body += '\n\nChanged after submission.'; },
    (f: ReturnType<typeof fixture>) => { f.task.publicUrl = `${BLOG}wrong/`; },
    (f: ReturnType<typeof fixture>) => { f.task.accountId = 'another-account'; },
  ]) await t.test(String(mutate), async () => {
    const f = fixture();
    const expected = article(f);
    f.task.wordpress = { blogId: BLOG_ID, authorId: AUTHOR_ID, slug: expected.slug,
      contentHash: expected.contentHash, stage: 'submitting' };
    f.task.submittedAt = NOW;
    mutate(f);
    let calls = 0;
    const result = await runFixtureTask(f.context, { fetch: async () => { calls++; return json({}); } });
    assert.equal(result.status, 'needs_input');
    assert.equal(calls, 0);
  });
});

test('wrong site binding and permission changes stop before intent or POST', async t => {
  await t.test('account root is another hosted blog', async () => {
    const f = fixture({ account: { publicationUrl: 'https://other.wordpress.com/' } });
    let calls = 0;
    const result = await runFixtureTask(f.context, { fetch: async url => {
      calls++;
      if (url.endsWith('/me')) return json(identity());
      if (url.endsWith('/me/sites')) return json({ sites: [writableSite()] });
      if (url.endsWith(`/sites/${BLOG_ID}`)) return json(writableSite());
      return json({ error: 'not found' }, 404);
    }, now: () => new Date(NOW) });
    assert.equal(result.status, 'needs_input');
    assert.equal(calls, 3);
    assert.equal(f.checkpoints.length, 0);
  });
  await t.test('publish permission was revoked', async () => {
    const f = fixture();
    let posts = 0;
    const reads: string[] = [];
    const fetch: WordPressTransport = async (url, init) => {
      reads.push(url);
      if (url.endsWith('/me')) return json(identity());
      if (url.endsWith('/me/sites')) return json({ sites: [writableSite({ capabilities: { publish_posts: false, edit_posts: true } })] });
      if (init.method === 'POST') posts++;
      return json({});
    };
    const result = await runFixtureTask(f.context, { fetch });
    assert.equal(result.status, 'needs_input');
    assert.equal(posts, 0);
    assert.deepEqual(reads.map(url => new URL(url).pathname), ['/rest/v1.1/me', '/rest/v1.1/me/sites']);
    assert.equal(f.checkpoints.length, 0);
  });
});

test('401 and 429 during preflight remain distinguishable and never create an intent or POST', async t => {
  for (const [status, expected] of [[401, 'needs_input'], [429, 'queued']] as const) await t.test(String(status), async () => {
    const f = fixture();
    let posts = 0;
    let calls = 0;
    const result = await runFixtureTask(f.context, { fetch: async (_url, init) => {
      calls++;
      if (init.method === 'POST') posts++;
      return json({ error: 'blocked' }, status);
    } });
    assert.equal(result.status, expected);
    assert.equal(calls, 1, 'the response must be reached, not masked by expired fixture credentials');
    assert.equal(posts, 0);
    assert.equal(f.checkpoints.length, 0);
  });
  await t.test('timeout', async () => {
    const f = fixture();
    const result = await runFixtureTask(f.context, {
      fetch: async () => new Promise<Response>(() => undefined), timeoutMs: 100, now: () => new Date(NOW),
    });
    assert.equal(result.status, 'queued');
    assert.equal(f.checkpoints.length, 0);
  });
});

test('401 and 429 returned to the one-shot POST preserve intent and never authorize another write', async t => {
  for (const status of [401, 429]) await t.test(String(status), async () => {
    const f = fixture();
    const server = successfulServer(f, { postResponse: json({ error: 'rejected' }, status) });
    const first = await runFixtureTask(f.context, { fetch: server.fetch, now: () => new Date(NOW) });
    const second = await runFixtureTask(f.context, { fetch: server.fetch, now: () => new Date(NOW) });
    assert.equal(first.status, 'review');
    assert.equal(first.wordpress?.stage, 'submitting');
    assert.equal(second.status, 'review');
    assert.equal(second.wordpress?.stage, 'submitting');
    assert.equal(server.calls.filter(call => call.init.method === 'POST').length, 1);
    assert.ok(server.calls.slice(-1).every(call => call.init.method !== 'POST'));
  });
});

test('expired, malformed, or cross-blog Vault credentials require reconnection before any remote request', async t => {
  for (const credential of [
    { version: 1, accessToken: TOKEN, expiresAt: NOW, blogId: BLOG_ID, ownerId: AUTHOR_ID },
    { version: 1, accessToken: TOKEN, expiresAt: EXPIRES_AT, blogId: '999', ownerId: AUTHOR_ID },
    TOKEN,
  ]) await t.test(JSON.stringify(credential), async () => {
    const f = fixture();
    f.secrets.set(`account:${f.account().id}`, typeof credential === 'string' ? credential : JSON.stringify(credential));
    let calls = 0;
    const result = await runFixtureTask(f.context, { fetch: async () => { calls++; return json({}); }, now: () => new Date(NOW) });
    assert.equal(result.status, 'needs_input');
    assert.equal(calls, 0);
    assert.equal(f.checkpoints.length, 0);
  });
});

test('credentials expire at the exact boundary even when the fixture clock is overridden', async t => {
  for (const offsetMs of [-1, 0, 1]) await t.test(String(offsetMs), async () => {
    const f = fixture();
    const server = successfulServer(f);
    const result = await runFixtureTask(f.context, {
      fetch: server.fetch,
      now: () => new Date(Date.parse(EXPIRES_AT) + offsetMs),
    });
    if (offsetMs < 0) {
      assert.equal(result.wordpress?.stage, 'published');
      assert.equal(server.calls.filter(call => call.init.method === 'POST').length, 1);
    } else {
      assert.equal(result.status, 'needs_input');
      assert.equal(server.calls.length, 0);
      assert.equal(f.checkpoints.length, 0);
    }
  });
});

test('a disconnected POST is never repeated and can only recover through its stable public slug', async () => {
  const f = fixture();
  const server = successfulServer(f, { disconnectPost: true, remoteCreatedOnDisconnect: true });
  const first = await runFixtureTask(f.context, { fetch: server.fetch, now: () => new Date(NOW) });
  assert.equal(first.status, 'review');
  assert.equal(first.wordpress?.stage, 'submitting');
  assert.equal(first.publicUrl, undefined);
  const second = await runFixtureTask(f.context, { fetch: server.fetch });
  assert.equal(second.wordpress?.stage, 'published');
  assert.equal(second.publicUrl, postUrl(f));
  assert.equal(server.calls.filter(call => call.init.method === 'POST').length, 1);
  assert.deepEqual(server.calls.slice(-2).map(call => call.init.method ?? 'GET'), ['GET', 'GET']);
});

test('an occupied deterministic slug blocks the first POST instead of adopting or overwriting remote content', async () => {
  const f = fixture();
  let posts = 0;
  const reads: string[] = [];
  const fetch: WordPressTransport = async (url, init) => {
    reads.push(url);
    if (url.endsWith('/me')) return json(identity());
    if (url.endsWith('/me/sites')) return json({ sites: [writableSite()] });
    if (url.endsWith(`/sites/${BLOG_ID}`)) return json(writableSite());
    if (init.method === 'POST') posts++;
    return json(legacyPost(f, { title: 'Someone else\'s post' }));
  };
  const result = await runFixtureTask(f.context, { fetch });
  assert.equal(result.status, 'needs_input');
  assert.equal(posts, 0);
  assert.equal(reads.length, 4);
  assert.equal(new URL(reads[3]).pathname, `/rest/v1.1/sites/${BLOG_ID}/posts/slug:${article(f).slug}`);
  assert.equal(f.checkpoints.length, 0);
});

test('read-only reconciliation binds slug, full content, all links, author, post ID, URL, and hash without using OAuth', async () => {
  const f = fixture();
  const expected = article(f);
  f.task.wordpress = { blogId: BLOG_ID, authorId: AUTHOR_ID, slug: expected.slug,
    contentHash: expected.contentHash, stage: 'submitting' };
  f.task.submittedAt = NOW;
  const server = successfulServer(f);
  server.markPublished();
  const result = await reconcileWordPressTask(f.context, { fetch: server.fetch });
  assert.deepEqual(result, { status: 'found', publicUrl: postUrl(f), wordpress: {
    ...f.task.wordpress, stage: 'published', postId: '987654', url: postUrl(f),
  } });
  assert.deepEqual(server.calls.map(call => call.init.method ?? 'GET'), ['GET', 'GET']);
  assert.ok(server.calls.every(call => (call.init.headers as Record<string, string>).authorization === undefined));
});

test('anonymous verification rejects blocked indexing, fake canonical, hidden or missing content, changed links, and wrong author', async t => {
  const cases: Array<{ name: string; page?: string; headers?: Record<string, string>; legacy?: Record<string, unknown> }> = [];
  {
    const f = fixture();
    cases.push(
      { name: 'robots noindex', page: publicPage(f, { head: '<meta name="robots" content="noindex,follow">' }) },
      { name: 'x-robots noindex', headers: { 'x-robots-tag': 'noindex' } },
      { name: 'robots none', page: publicPage(f, { head: '<meta name="robots" content="none">' }) },
      { name: 'googlebot none', page: publicPage(f, { head: '<meta name="googlebot" content="NONE">' }) },
      { name: 'x-robots none', headers: { 'x-robots-tag': 'none' } },
      { name: 'fake canonical', page: publicPage(f, { canonical: `${BLOG}different/` }) },
      { name: 'hidden body', page: publicPage(f, { bodyAttributes: 'style="display:none"' }) },
      { name: 'missing body', page: publicPage(f, { body: '<p>Only a summary remains.</p>' }) },
      { name: 'changed second link', page: publicPage(f, { body: article(f).html.replace(SECOND_LINK, 'https://www.iana.org/domains') }) },
      { name: 'wrong author', legacy: { author: { ID: 1 } } },
    );
  }
  for (const item of cases) await t.test(item.name, async () => {
    const f = fixture();
    const expected = article(f);
    f.task.wordpress = { blogId: BLOG_ID, authorId: AUTHOR_ID, slug: expected.slug, contentHash: expected.contentHash,
      stage: 'published', postId: '987654', url: postUrl(f) };
    f.task.publicUrl = postUrl(f);
    const server = successfulServer(f, { legacy: item.legacy, page: item.page, pageHeaders: item.headers });
    server.markPublished();
    const result = await verifyWordPressPublication(f.task, f.site.url, { fetch: server.fetch });
    assert.equal(result.found, false);
    assert.equal(result.outcome, 'invalid');
  });
});

test('verification reports absence separately and accepts an exact nofollow/ugc target without claiming indexing', async () => {
  const absent = fixture();
  const expected = article(absent);
  absent.task.wordpress = { blogId: BLOG_ID, authorId: AUTHOR_ID, slug: expected.slug, contentHash: expected.contentHash,
    stage: 'published', postId: '987654', url: postUrl(absent) };
  absent.task.publicUrl = postUrl(absent);
  let calls = 0;
  const missing = await verifyWordPressPublication(absent.task, absent.site.url, { fetch: async () => {
    calls++; return json({ error: 'not found' }, 404);
  } });
  assert.equal(missing.outcome, 'absent');
  assert.equal(calls, 1);

  const exact = fixture();
  const exactArticle = article(exact);
  exact.task.wordpress = { blogId: BLOG_ID, authorId: AUTHOR_ID, slug: exactArticle.slug, contentHash: exactArticle.contentHash,
    stage: 'published', postId: '987654', url: postUrl(exact) };
  exact.task.publicUrl = postUrl(exact);
  const page = publicPage(exact, { body: exactArticle.html.replace(`href="${TARGET}"`, `href="${TARGET}" rel="nofollow ugc"`) });
  const server = successfulServer(exact, { page });
  server.markPublished();
  const found = await verifyWordPressPublication(exact.task, exact.site.url, { fetch: server.fetch });
  assert.equal(found.found, true);
  assert.equal(found.rel, 'nofollow ugc');
  assert.match(found.reason, /不保证搜索收录或排名/);

  const preview = fixture();
  const previewArticle = article(preview);
  preview.task.wordpress = { blogId: BLOG_ID, authorId: AUTHOR_ID, slug: previewArticle.slug,
    contentHash: previewArticle.contentHash, stage: 'published', postId: '987654', url: postUrl(preview) };
  preview.task.publicUrl = postUrl(preview);
  const previewServer = successfulServer(preview, { pageHeaders: { 'x-robots-tag': 'max-image-preview:none' } });
  previewServer.markPublished();
  const previewFound = await verifyWordPressPublication(preview.task, preview.site.url, { fetch: previewServer.fetch });
  assert.equal(previewFound.found, true, 'max-image-preview:none must not be treated as robots none');
});

test('authenticated redirects, oversized responses, and malformed create identities never leak or trigger a second POST', async t => {
  await t.test('redirect', async () => {
    const f = fixture();
    let calls = 0;
    const result = await runFixtureTask(f.context, { fetch: async (_url, init) => {
      calls++;
      assert.equal(init.redirect, 'manual');
      return new Response('', { status: 302, headers: { location: 'https://evil.example/' } });
    } });
    assert.equal(result.status, 'needs_input');
    assert.equal(f.checkpoints.length, 0);
    assert.equal(calls, 1);
  });
  await t.test('oversized identity', async () => {
    const f = fixture();
    let calls = 0;
    const result = await runFixtureTask(f.context, { fetch: async () => {
      calls++;
      return json({}, 200, { 'content-length': '3000000' });
    } });
    assert.equal(result.status, 'needs_input');
    assert.equal(f.checkpoints.length, 0);
    assert.equal(calls, 1);
  });
  await t.test('changed slug in 201', async () => {
    const f = fixture();
    const server = successfulServer(f, { created: { slug: 'server-changed-slug', link: `${BLOG}server-changed-slug/` } });
    const first = await runFixtureTask(f.context, { fetch: server.fetch });
    const second = await runFixtureTask(f.context, { fetch: server.fetch });
    assert.equal(first.wordpress?.stage, 'submitting');
    assert.equal(first.publicUrl, undefined);
    assert.equal(second.wordpress?.stage, 'published');
    assert.equal(server.calls.filter(call => call.init.method === 'POST').length, 1);
  });
});
