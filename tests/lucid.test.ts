import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { marked } from 'marked';
import { defaultSettings } from '../src/main/store';
import { lucidTesting, reconcileLucidTask, runLucidTask, verifyLucidPublication, type LucidTransport } from '../src/integrations/lucid';
import type { Channel, ExecutionContext, Site, Task } from '../src/shared/types';

const NOW = '2026-10-08T05:30:00.000Z';
const TARGET = 'https://example.com/research';
const TITLE = 'A practical source-checking workflow';
const BODY = `A useful source check begins by recording what the page actually says, when it was read, and which details may change. Keep measurements beside their units and distinguish a direct observation from an interpretation. The [research notes](${TARGET}) provide a related reference for the workflow, rather than independent proof of every claim.

Before publishing a summary, compare it with the original passage and mark unresolved points plainly. This article is AI-assisted promotional writing, and the linked site may receive referral commissions. That relationship does not establish accuracy, remove risk, or guarantee any financial or search outcome.`;
const SLUG = 'careful-source-check-8f2k1';
const PAGE = `https://lucid.page/${SLUG}`;
const CLAIM = 'lpc_synthetic-claim-token-for-tests';

function channel(): Channel {
  return { id: 'lucid-page', name: 'Lucid.page', domain: 'lucid.page', url: 'https://lucid.page', submitUrl: 'https://lucid.page/publish',
    categories: ['content'], languages: ['*'], kind: 'article', emailRequired: false, accountRequired: false, articleRequired: true,
    free: 'yes', freeNote: 'Anonymous public publishing is free.', automation: 'api', quality: 'C', qualityReason: 'Pilot awaiting live audit.',
    provenance: 'built-in', rulesUrl: 'https://lucid.page/terms', checkedAt: '2026-10-08', notes: 'Anonymous page is immutable until claimed.',
    allowedHosts: ['lucid.page'], enabled: false };
}
function fixture() {
  const site: Site = { id: 'site', domain: 'example.com', url: 'https://example.com/', email: 'author@example.com', name: 'Example Research',
    description: 'Research notes', category: 'education', language: 'en', monthlyTarget: 2, status: 'ready', createdAt: NOW };
  const task: Task = { id: 'task-lucid', siteId: site.id, channelId: 'lucid-page', sourceDomain: 'lucid.page', status: 'running',
    createdAt: NOW, updatedAt: NOW, scheduledAt: NOW, attempts: 1, message: '', topicUrl: TARGET,
    draft: { title: TITLE, description: 'Source checking', body: BODY }, articleApprovedAt: NOW };
  const secrets = new Map<string, string>();
  const checkpoints: Partial<Task>[] = [];
  const logs: string[] = [];
  const abort = new AbortController();
  let secretFailure = false;
  let identityFailure = false;
  let accountCalls = 0;
  const context: ExecutionContext = { site, task, channel: channel(), settings: defaultSettings(), signal: abort.signal,
    ai: { json: async <T>() => ({} as T) },
    secrets: { get: async key => secrets.get(key), set: async (key, value) => {
      if (secretFailure) throw Error('vault unavailable'); secrets.set(key, value);
    }, delete: async key => { secrets.delete(key); } },
    getAccount: () => { accountCalls++; return undefined; },
    saveAccount: async () => { accountCalls++; throw Error('Lucid must not create an account'); },
    checkpoint: partial => {
      if (identityFailure && partial.lucid?.slug && partial.lucid.stage === 'submitting') throw Error('save unavailable');
      checkpoints.push(structuredClone(partial)); Object.assign(task, partial);
    },
    log: message => { logs.push(message); },
  };
  return { context, task, site, secrets, checkpoints, logs, abort,
    failSecret: () => { secretFailure = true; }, failIdentity: () => { identityFailure = true; }, accountCalls: () => accountCalls };
}
function response(body: string, contentType: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { 'content-type': contentType, ...headers } });
}
function publishResponse(overrides: Record<string, unknown> = {}) {
  return response(JSON.stringify({ slug: SLUG, url: PAGE, visibility: 'public', expires_at: null, claim_token: CLAIM, ...overrides }),
    'application/json', 201);
}
function publicHtml(options: { title?: string; body?: string; canonical?: string; head?: string; articleStyle?: string; targetRel?: string } = {}) {
  const title = options.title ?? TITLE;
  const body = options.body ?? BODY;
  let rendered = String(marked.parse(body, { async: false, gfm: true }));
  if (options.targetRel) rendered = rendered.replace('<a href="https://example.com/research"',
    `<a rel="${options.targetRel}" href="https://example.com/research"`);
  return `<!doctype html><html><head><link rel="canonical" href="${options.canonical ?? PAGE}">${options.head ?? ''}</head><body>`
    + `<main class="reader" id="top"><article class="document" id="doc-content-area"${options.articleStyle ? ` style="${options.articleStyle}"` : ''}>`
    + `<h1>${title}</h1>${rendered}</article></main></body></html>`;
}
function successfulServer(f: ReturnType<typeof fixture>, options: {
  lostPublish?: boolean; publish?: Response; raw?: string; html?: string; pageHeaders?: Record<string, string>;
} = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let published = false;
  const fetch: LucidTransport = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://lucid.page/publish') {
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      assert.equal((init.headers as Record<string, string>).authorization, undefined);
      assert.equal((init.headers as Record<string, string>)['idempotency-key'], undefined);
      assert.deepEqual(JSON.parse(String(init.body)), { markdown: `# ${TITLE}\n\n${BODY}`, title: TITLE, visibility: 'public' });
      assert.deepEqual(f.task.lucid && { ...f.task.lucid }, { contentHash: lucidTesting.article(f.task, f.site.url, false).contentHash, stage: 'submitting' });
      assert.equal(f.task.checkpoint, 'lucid_publish_submitting');
      assert.ok(f.task.submittedAt);
      published = true;
      if (options.lostPublish) throw Error('connection reset after request');
      return options.publish ?? publishResponse();
    }
    if (url === `https://lucid.page/raw/${SLUG}`) {
      assert.ok(published || f.task.lucid?.slug);
      assert.equal(init.method, 'GET');
      assert.equal((init.headers as Record<string, string>).accept, 'text/markdown');
      return response(options.raw ?? `# ${TITLE}\n\n${BODY}`, 'text/markdown;charset=utf-8');
    }
    if (url === PAGE) {
      assert.ok(published || f.task.lucid?.slug);
      assert.equal(init.method, 'GET');
      assert.equal((init.headers as Record<string, string>).accept, 'text/html');
      return response(options.html ?? publicHtml({ targetRel: 'nofollow ugc' }), 'text/html;charset=utf-8', 200, options.pageHeaders);
    }
    throw Error(`unexpected endpoint: ${url}`);
  };
  return { fetch, calls };
}

test('publishes exactly once, persists the returned identity before verification, and keeps the claim token only in Vault', async () => {
  const f = fixture();
  const server = successfulServer(f);
  const result = await runLucidTask(f.context, { fetch: server.fetch, now: () => new Date(NOW) });
  assert.equal(result.status, 'review');
  assert.equal(result.publicUrl, PAGE);
  assert.equal(result.lucid?.slug, SLUG);
  assert.equal(result.lucid?.stage, 'published');
  assert.equal(result.submittedAt, NOW);
  assert.equal(f.secrets.get(`publication:${f.task.id}`), CLAIM);
  assert.deepEqual(f.checkpoints.map(item => ({ checkpoint: item.checkpoint, slug: item.lucid?.slug, stage: item.lucid?.stage,
    publicUrl: item.publicUrl })), [
    { checkpoint: 'lucid_publish_submitting', slug: undefined, stage: 'submitting', publicUrl: undefined },
    { checkpoint: 'lucid_publish_submitting', slug: SLUG, stage: 'submitting', publicUrl: PAGE },
    { checkpoint: 'lucid_published', slug: SLUG, stage: 'published', publicUrl: PAGE },
  ]);
  assert.deepEqual(server.calls.map(call => `${call.init.method} ${call.url}`), [
    'POST https://lucid.page/publish', `GET https://lucid.page/raw/${SLUG}`, `GET ${PAGE}`,
  ]);
  const publicState = JSON.stringify({ result, checkpoints: f.checkpoints, logs: f.logs, urls: server.calls.map(call => call.url) });
  assert.equal(publicState.includes(CLAIM), false);
  assert.equal(f.accountCalls(), 0);
  assert.match(result.message, /收录不保证/);
});

test('a Vault failure never discards a verified public URL or leaks the one-time claim token', async () => {
  const f = fixture();
  f.failSecret();
  const server = successfulServer(f);
  const result = await runLucidTask(f.context, { fetch: server.fetch });
  assert.equal(result.publicUrl, PAGE);
  assert.equal(result.lucid?.stage, 'published');
  assert.equal(f.task.publicUrl, PAGE);
  assert.equal(f.task.lucid?.slug, SLUG);
  assert.equal(f.secrets.has(`publication:${f.task.id}`), false);
  assert.match(result.message, /认领凭据未保存/);
  assert.equal(JSON.stringify({ result, checkpoints: f.checkpoints }).includes(CLAIM), false);
});

test('a returned URL is not confirmed until its matching receipt can be checkpointed', async () => {
  const f = fixture();
  f.failIdentity();
  const server = successfulServer(f);
  const result = await runLucidTask(f.context, { fetch: server.fetch });
  assert.equal(result.publicUrl, PAGE);
  assert.deepEqual(result.lucid, { contentHash: lucidTesting.article(f.task, f.site.url, false).contentHash, slug: SLUG, stage: 'submitting' });
  assert.equal(result.checkpoint, 'lucid_publish_submitting');
  assert.deepEqual(server.calls.map(call => call.url), ['https://lucid.page/publish']);
  assert.equal(f.secrets.get(`publication:${f.task.id}`), CLAIM);
  assert.equal(f.task.publicUrl, undefined);
  assert.equal(f.task.lucid?.slug, undefined);
});

test('a lost create response leaves a slugless unknown receipt and can never cause a second POST', async () => {
  const f = fixture();
  const server = successfulServer(f, { lostPublish: true });
  const first = await runLucidTask(f.context, { fetch: server.fetch });
  const second = await runLucidTask(f.context, { fetch: server.fetch });
  assert.equal(first.status, 'review');
  assert.equal(first.lucid?.slug, undefined);
  assert.equal(second.status, 'review');
  assert.equal(second.publicUrl, undefined);
  assert.equal(server.calls.filter(call => call.url === 'https://lucid.page/publish').length, 1);
  assert.match(second.message, /不会重发/);
});

test('rate limits, challenges, timeouts, and cancellation stop the one-shot task without a retry', async t => {
  for (const scenario of [
    { name: 'rate', fetch: async () => response('{"error":"slow down"}', 'application/json', 429) },
    { name: 'challenge', fetch: async () => response('<html>cf-turnstile</html>', 'text/html', 403, { 'cf-mitigated': 'challenge' }) },
    { name: 'timeout', fetch: async () => new Promise<Response>(() => {}), timeoutMs: 100 },
  ]) await t.test(scenario.name, async () => {
    const f = fixture();
    let calls = 0;
    const fetch: LucidTransport = async () => { calls++; return scenario.fetch(); };
    const first = await runLucidTask(f.context, { fetch, timeoutMs: scenario.timeoutMs });
    const second = await runLucidTask(f.context, { fetch, timeoutMs: scenario.timeoutMs });
    assert.equal(first.status, 'review');
    assert.equal(second.status, 'review');
    assert.equal(calls, 1);
    assert.match(first.message, /已停止|结果不明/);
  });

  await t.test('cancelled before submission', async () => {
    const f = fixture();
    f.abort.abort();
    let calls = 0;
    const result = await runLucidTask(f.context, { fetch: async () => { calls++; return publishResponse(); } });
    assert.equal(result.status, 'queued');
    assert.equal(calls, 0);
    assert.equal(f.checkpoints.length, 0);
  });
});

test('response identity follows the official required fields and slug pattern without inferring a URL', async t => {
  for (const [name, overrides] of [
    ['bad slug', { slug: 'Bad/Slug' }],
    ['mismatched URL', { url: 'https://lucid.page/another-page' }],
    ['unlisted visibility', { visibility: 'unlisted' }],
    ['unexpected expiry', { expires_at: '2026-10-09T00:00:00.000Z' }],
  ] as const) await t.test(name, async () => {
    const f = fixture();
    const server = successfulServer(f, { publish: publishResponse(overrides) });
    const result = await runLucidTask(f.context, { fetch: server.fetch });
    assert.equal(result.publicUrl, undefined);
    assert.equal(result.lucid?.slug, undefined);
    assert.deepEqual(server.calls.map(call => call.url), ['https://lucid.page/publish']);
    const second = await runLucidTask(f.context, { fetch: server.fetch });
    assert.equal(second.publicUrl, undefined);
    assert.equal(server.calls.length, 1);
  });
});

test('read-only reconciliation requires a stored slug and checks raw Markdown plus visible public HTML', async () => {
  const f = fixture();
  const expected = lucidTesting.article(f.task, f.site.url, false);
  f.task.lucid = { contentHash: expected.contentHash, slug: SLUG, stage: 'submitting' };
  f.task.submittedAt = NOW;
  f.task.publicUrl = PAGE;
  const server = successfulServer(f);
  const reconciled = await reconcileLucidTask(f.context, { fetch: server.fetch });
  assert.deepEqual(reconciled, { status: 'found', publicUrl: PAGE,
    lucid: { contentHash: expected.contentHash, slug: SLUG, stage: 'published' } });
  assert.deepEqual(server.calls.map(call => call.url), [`https://lucid.page/raw/${SLUG}`, PAGE]);

  const unknown = fixture();
  unknown.task.lucid = { contentHash: lucidTesting.article(unknown.task, unknown.site.url, false).contentHash, stage: 'submitting' };
  let calls = 0;
  assert.deepEqual(await reconcileLucidTask(unknown.context, { fetch: async () => { calls++; return response('', 'text/plain'); } }), { status: 'unknown' });
  assert.equal(calls, 0);
});

test('invalid or mismatched prior receipts cannot throw, fetch, or replace a conflicting public URL', async () => {
  const invalid = fixture();
  invalid.task.lucid = { contentHash: lucidTesting.article(invalid.task, invalid.site.url, false).contentHash,
    slug: 'Bad/Slug', stage: 'submitting' };
  let calls = 0;
  const invalidResult = await runLucidTask(invalid.context, { fetch: async () => { calls++; return response('', 'text/plain'); } });
  assert.equal(invalidResult.status, 'review');
  assert.equal(invalidResult.publicUrl, undefined);
  assert.equal(calls, 0);

  const mismatch = fixture();
  mismatch.task.lucid = { contentHash: lucidTesting.article(mismatch.task, mismatch.site.url, false).contentHash,
    slug: SLUG, stage: 'submitting' };
  mismatch.task.publicUrl = 'https://lucid.page/different-page';
  const mismatchResult = await runLucidTask(mismatch.context, { fetch: async () => { calls++; return response('', 'text/plain'); } });
  assert.equal(mismatchResult.status, 'needs_input');
  assert.equal(mismatchResult.publicUrl, undefined);
  assert.equal(mismatch.task.publicUrl, 'https://lucid.page/different-page');
  assert.equal(calls, 0);

  const temporary = fixture();
  temporary.task.lucid = { contentHash: lucidTesting.article(temporary.task, temporary.site.url, false).contentHash,
    slug: SLUG, stage: 'published' };
  temporary.task.publicUrl = PAGE;
  const temporaryResult = await runLucidTask(temporary.context, { fetch: async () => { calls++; throw Error('offline'); } });
  assert.equal(temporaryResult.status, 'review');
  assert.equal(temporaryResult.lucid?.stage, 'published');
  assert.equal(temporaryResult.checkpoint, 'lucid_published');
  assert.equal(temporaryResult.publicUrl, PAGE);
  assert.equal(calls, 1);
});

test('verification rejects noindex, bad canonical, concealed content, wrong title, raw changes, and missing target links', async t => {
  const cases: Array<{ name: string; options: Parameters<typeof successfulServer>[1]; outcome?: 'unreachable' }> = [
    { name: 'robots meta noindex', options: { html: publicHtml({ head: '<meta name="robots" content="noindex,follow">' }) } },
    { name: 'x-robots-tag noindex', options: { pageHeaders: { 'x-robots-tag': 'noindex, follow' } } },
    { name: 'canonical mismatch', options: { html: publicHtml({ canonical: 'https://lucid.page/other-page' }) } },
    { name: 'concealed article', options: { html: publicHtml({ articleStyle: 'display:none' }) } },
    { name: 'wrong title', options: { html: publicHtml({ title: 'Different title' }) } },
    { name: 'changed raw Markdown', options: { raw: `${BODY}\n\nChanged.` } },
    { name: 'missing rendered target', options: { html: publicHtml({ body: BODY.replace(`[research notes](${TARGET})`, 'research notes') }) } },
    { name: 'readback challenge', options: { raw: '<html>h-captcha</html>' }, outcome: 'unreachable' },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const f = fixture();
    const expected = lucidTesting.article(f.task, f.site.url, false);
    f.task.lucid = { contentHash: expected.contentHash, slug: SLUG, stage: 'published' };
    f.task.publicUrl = PAGE;
    const server = successfulServer(f, item.options);
    const result = await verifyLucidPublication(f.task, f.site.url, { fetch: server.fetch });
    assert.equal(result.found, false);
    assert.equal(result.outcome, item.outcome ?? 'invalid');
  });
});

test('successful verification records link attributes without claiming indexing, editability, or deletion', async () => {
  const f = fixture();
  const expected = lucidTesting.article(f.task, f.site.url, false);
  f.task.lucid = { contentHash: expected.contentHash, slug: SLUG, stage: 'published' };
  f.task.publicUrl = PAGE;
  const server = successfulServer(f, { html: publicHtml({ targetRel: 'ugc' }), pageHeaders: { 'x-robots-tag': 'nofollow' } });
  const result = await verifyLucidPublication(f.task, f.site.url, { fetch: server.fetch });
  assert.equal(result.found, true);
  assert.equal(result.outcome, 'found');
  assert.equal(result.rel, 'ugc nofollow');
  assert.match(result.reason, /不保证搜索收录或排名/);
  assert.doesNotMatch(result.reason, /可修改|可删除|保证收录/);
});

test('unreviewed or non-matching work stops before any remote request', async () => {
  const f = fixture();
  f.task.articleApprovedAt = undefined;
  let calls = 0;
  const result = await runLucidTask(f.context, { fetch: async () => { calls++; return publishResponse(); } });
  assert.equal(result.status, 'needs_input');
  assert.equal(calls, 0);

  const wrong = fixture();
  wrong.context.channel.accountRequired = true;
  const mismatch = await runLucidTask(wrong.context, { fetch: async () => { calls++; return publishResponse(); } });
  assert.equal(mismatch.status, 'needs_input');
  assert.equal(calls, 0);
});

test('all draft links must name public HTTPS destinations and unsupported images stop before intent', async () => {
  for (const addition of [
    '[private notes](https://127.0.0.1/private)',
    '[internal notes](https://vault.internal/private)',
    '[credential link](https://user:password@example.com/private)',
    '[unsafe link](javascript:alert%281%29)',
    '![tracking pixel](https://example.com/pixel.png)',
  ]) {
    const f = fixture();
    f.task.draft!.body += `\n\n${addition}`;
    let calls = 0;
    const result = await runLucidTask(f.context, { fetch: async () => { calls++; return publishResponse(); } });
    assert.equal(result.status, 'needs_input', addition);
    assert.equal(calls, 0);
    assert.equal(f.checkpoints.length, 0);
  }
});

test('public proof rejects hidden intermediate ancestors, added media, and active article scripts', () => {
  const f = fixture();
  const expected = lucidTesting.article(f.task, f.site.url, false);
  const clean = publicHtml();
  assert.equal(lucidTesting.rendered(clean, expected, PAGE, new Headers()), 'follow');
  for (const html of [
    clean.replace('<article ', '<div hidden><article ').replace('</article>', '</article></div>'),
    clean.replace('<article ', '<div style="display:none"><article ').replace('</article>', '</article></div>'),
    clean.replace('</article>', '<img src="https://example.com/pixel.png"></article>'),
    clean.replace('</article>', '<script>document.querySelector("#doc-content-area").remove()</script></article>'),
  ]) assert.equal(lucidTesting.rendered(html, expected, PAGE, new Headers()), undefined);
});

test('public proof preserves the exact whitespace of visible code', () => {
  const f = fixture();
  f.task.draft!.body += '\n\n```python\nif ready:\n    publish()\n```';
  const expected = lucidTesting.article(f.task, f.site.url, false);
  const clean = publicHtml({ body: f.task.draft!.body });
  assert.equal(lucidTesting.rendered(clean, expected, PAGE, new Headers()), 'follow');
  assert.equal(lucidTesting.rendered(clean.replace('    publish()', 'publish()'), expected, PAGE, new Headers()), undefined);
});

test('transport-triggered cancellation consumes its rejected promise and never retries', async () => {
  const f = fixture();
  let calls = 0;
  const fetch: LucidTransport = async () => {
    calls++;
    f.abort.abort();
    throw Error('synthetic cancelled transport');
  };
  const result = await runLucidTask(f.context, { fetch });
  assert.equal(result.status, 'review');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await runLucidTask(f.context, { fetch })).status, 'review');
  assert.equal(calls, 1);
});

const PLATFORM_TAIL = '<div class="document-end">End</div><aside class="doc-cta" aria-label="Publish your own page">'
  + '<span class="doc-cta-kicker">Made with lucid.page</span><span class="doc-cta-heading">Write something this beautiful</span>'
  + '<span class="doc-cta-sub">Publish your own page in seconds. Free, no signup.</span>'
  + '<a class="doc-cta-button" href="/?ref=doc-cta">New page<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg></a></aside>';

test('visible title is serialized in Markdown without invalidating the original logical receipt hash', () => {
  const f = fixture();
  const expected = lucidTesting.article(f.task, f.site.url, false);
  assert.equal(expected.markdown, `# ${TITLE}\n\n${BODY}`);
  assert.equal(expected.contentHash, createHash('sha256').update(JSON.stringify({ title: TITLE, body: BODY, target: TARGET })).digest('hex'));
  f.task.draft!.title = 'A **bold** title';
  assert.throws(() => lucidTesting.article(f.task, f.site.url, false));
});

test('exact trailing Lucid chrome is excluded while title, body and arbitrary extra content remain mandatory', () => {
  const f = fixture(), expected = lucidTesting.article(f.task, f.site.url, false);
  const full = publicHtml().replace(`<h1>${TITLE}</h1>`, `<h1 id="source-title"><a class="header-anchor" href="#source-title">#</a> ${TITLE}</h1>`)
    .replace('</article>', `${PLATFORM_TAIL}</article>`);
  assert.equal(lucidTesting.rendered(full, expected, PAGE, new Headers()), 'follow');
  for (const bad of [
    full.replace(/<h1[^>]*>[\s\S]*?<\/h1>/, ''),
    full.replace('Made with lucid.page', 'Extra promotional claim'),
    full.replace('href="/?ref=doc-cta"', 'href="https://other.example.com/"'),
    full.replace('<div class="document-end">', '<div class="document-end" onclick="alert(1)">'),
    full.replace('</article>', '<p>Unreviewed additional claim.</p></article>'),
    full.replace('href="#source-title">#', 'href="#source-title">Unreviewed claim'),
  ]) assert.equal(lucidTesting.rendered(bad, expected, PAGE, new Headers()), undefined);
});

test('legacy title-less Markdown never becomes a verified receipt and can only reconcile with GET', async () => {
  const f = fixture(), expected = lucidTesting.article(f.task, f.site.url, false);
  f.task.lucid = { contentHash: expected.contentHash, slug: SLUG, stage: 'submitting' };
  f.task.publicUrl = PAGE;
  const server = successfulServer(f, { raw: BODY, html: publicHtml().replace(`<h1>${TITLE}</h1>`, '') });
  assert.deepEqual(await reconcileLucidTask(f.context, { fetch: server.fetch }), { status: 'unknown' });
  assert.equal((await runLucidTask(f.context, { fetch: server.fetch })).lucid?.stage, 'submitting');
  assert.equal(server.calls.length, 2);
  assert.ok(server.calls.every(call => call.init.method === 'GET'));
});

test('a 15-block page accepts only the renderer auto-link of a reviewed bare target hostname', () => {
  const f = fixture(), paragraphs = BODY.split('\n\n');
  const body = [paragraphs[0], ...Array.from({ length: 4 }, (_, index) => [
    `## Check ${index + 1}`, paragraphs[1], `Record the source, its date and unresolved assumptions for check ${index + 1}.`,
  ]).flat(), '## Relationship disclosure', 'This is AI-assisted promotional writing for example.com, not an independent recommendation.'].join('\n\n');
  f.task.draft!.body = body;
  const expected = lucidTesting.article(f.task, f.site.url, false);
  const plain = publicHtml({ body }).replace('</article>', `${PLATFORM_TAIL}</article>`);
  const linked = plain.replace('for example.com,', 'for <a href="http://example.com">example.com</a>,');
  assert.equal(lucidTesting.rendered(linked, expected, PAGE, new Headers()), 'follow');
  assert.equal(lucidTesting.rendered(linked.replace('href="http://example.com"', 'href="http://example.com/"'), expected, PAGE, new Headers()), 'follow');
  for (const href of ['http://other.example.com', 'http://example.com/path', 'http://example.com/?q=1',
    'http://example.com/#part', 'https://example.com/', 'http://user@example.com/']) {
    assert.equal(lucidTesting.rendered(linked.replace('href="http://example.com"', `href="${href}"`), expected, PAGE, new Headers()), undefined);
  }
  assert.equal(lucidTesting.rendered(linked.replace('>example.com</a>', '>other.example.com</a>'), expected, PAGE, new Headers()), undefined);
  assert.equal(lucidTesting.rendered(linked.replace(`href="${TARGET}"`, 'href="https://example.com/wrong"'), expected, PAGE, new Headers()), undefined);
  assert.equal(lucidTesting.rendered(linked.replace('</head>', '<meta name="robots" content="noindex"></head>'), expected, PAGE, new Headers()), undefined);
  assert.equal(lucidTesting.rendered(linked.replace('<article ', '<article hidden '), expected, PAGE, new Headers()), undefined);
});

test('bare-host compatibility never strips an explicit reviewed Markdown link', () => {
  const f = fixture();
  f.task.draft!.body += '\n\nThis article promotes [example.com](https://example.com/).';
  const expected = lucidTesting.article(f.task, f.site.url, false), html = publicHtml({ body: f.task.draft!.body });
  assert.equal(lucidTesting.rendered(html, expected, PAGE, new Headers()), 'follow');
  assert.equal(lucidTesting.rendered(html.replace('href="https://example.com/"', 'href="http://example.com"'), expected, PAGE, new Headers()), undefined);
});

test('bare-host recognition treats dots literally and excludes subdomains, paths, queries and fragments', () => {
  for (const literal of ['exampleXcom', 'foo.example.com', 'example.com/path', 'example.com?q=1', 'example.com#part']) {
    const f = fixture();
    f.task.draft!.body += `\n\nLiteral reference: ${literal} is left unresolved.`;
    const expected = lucidTesting.article(f.task, f.site.url, false), html = publicHtml({ body: f.task.draft!.body });
    assert.equal(lucidTesting.rendered(html, expected, PAGE, new Headers()), 'follow', literal);
    const tampered = html.replace(`Literal reference: ${literal}`, `Literal reference: <a href="http://example.com">${literal}</a>`);
    assert.equal(lucidTesting.rendered(tampered, expected, PAGE, new Headers()), undefined, literal);
  }
});


test('Lucid does not mistake image preview values for a noindex directive',()=>{
  const f=fixture(),expected=lucidTesting.article(f.task,f.site.url,false);
  assert.equal(lucidTesting.rendered(publicHtml({head:'<meta name="robots" content="max-image-preview:none">'}),expected,PAGE,new Headers()),'follow');
  assert.equal(lucidTesting.rendered(publicHtml(),expected,PAGE,new Headers({'x-robots-tag':'max-image-preview:none'})),'follow');
});
