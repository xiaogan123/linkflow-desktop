import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { inspectPaperRenderedArticle, paperVisibleBodyMatches } from '../src/integrations/paper-rendering';
import {
  connectPaperAccount, PaperError, paperTesting, preparePaperIdentity, reconcilePaperTask, runPaperTask,
  verifyPaperPublication, type PaperTransport,
} from '../src/integrations/paper';
import { defaultSettings } from '../src/main/store';
import type { Account, Channel, ExecutionContext, Site, Task } from '../src/shared/types';

const NOW = '2026-10-07T03:04:05.678Z';
const TARGET = 'https://example.com/guides/operational-risk';
const USERNAME = 'example-desk';
const TOKEN = 'synthetic-writefreely-token-only-for-tests';
const PASSWORD = 'synthetic-generated-password';
const POST_ID = 'abcdefghij1234';
const BODY = [
  `A reproducible review records the exact inputs, source dates, and failure conditions. The maintained checklist at [the operator's site](${TARGET}) shows how to repeat each check and distinguish observations from assumptions. This publication is operated by Example Lab, which discloses its commercial relationship here.`,
  'Readers should compare current eligibility terms, failure behavior, and operational constraints before making a decision. Example Lab may receive a commission from a relevant referral, but that relationship does not change the listed limitations or the steps used to reproduce each observation.',
].join('\n\n');

function json(data: unknown, status = 200, responseUrl?: string): Response {
  const response = new Response(JSON.stringify(status >= 200 && status < 300 ? { code: status, data } : { code: status, error_msg: 'synthetic error' }),
    { status, headers: { 'content-type': 'application/json' } });
  if (responseUrl) Object.defineProperty(response, 'url', { value: responseUrl });
  return response;
}
function html(body: string, responseUrl?: string): Response {
  const response = new Response(`<html><body><article id="post-body" class="norm h-entry"><h2 id="title">A reproducible operational review</h2><div class="e-content">${body}</div></article></body></html>`,
    { status: 200, headers: { 'content-type': 'text/html' } });
  if (responseUrl) Object.defineProperty(response, 'url', { value: responseUrl });
  return response;
}
function challenge(status = 403): Response {
  return new Response('<!doctype html><title>Just a moment...</title>', {
    status, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' },
  });
}
function renderedBody(): string { return marked.parse(BODY, { async: false }) as string; }
function channel(): Channel {
  return {
    id: 'paper-wf', name: 'Paper.wf', domain: 'paper.wf', url: 'https://paper.wf/', submitUrl: 'https://paper.wf/',
    categories: ['content'], languages: ['*'], kind: 'article', emailRequired: false, accountRequired: true,
    articleRequired: true, free: 'yes', freeNote: 'Open author account', automation: 'api', quality: 'C',
    qualityReason: 'Original articles', rulesUrl: 'https://paper.wf/about', checkedAt: NOW,
    notes: 'Original publication only', allowedHosts: ['paper.wf'], enabled: true,
  };
}
function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'paper-account', channelId: 'paper-wf', credentialKind: 'api_token', email: '', username: USERNAME,
    publicationUrl: `https://paper.wf/${USERNAME}/`, createdAt: NOW, status: 'registered', hasPassword: true,
    source: 'imported', ...overrides,
  };
}
function fixture(options: { registered?: boolean; task?: Partial<Task>; account?: Partial<Account> } = {}) {
  const site: Site = { id: 'site', domain: 'example.com', url: 'https://example.com/', email: 'owner@example.com',
    name: 'Example Lab', description: 'Source-backed operational research.', category: 'business', language: 'en',
    monthlyTarget: 2, status: 'ready', createdAt: NOW };
  const task: Task = { id: 'task', siteId: 'site', channelId: 'paper-wf', sourceDomain: 'paper.wf', status: 'running',
    accountId: options.registered === false ? undefined : 'paper-account', createdAt: NOW, scheduledAt: NOW, updatedAt: NOW,
    attempts: 1, message: '', topicUrl: TARGET, draft: { title: 'A reproducible operational review', description: 'Documented checks.', body: BODY },
    draftRevision: 1, articleApprovedAt: NOW, ...options.task };
  const accounts: Account[] = options.registered === false ? [] : [account(options.account)];
  const secrets = new Map<string, string>(accounts.map(value => [`account:${value.id}`, JSON.stringify({ version: 1,
    username: value.username, password: PASSWORD, token: TOKEN })]));
  const checkpoints: Partial<Task>[] = [];
  let failCheckpoint: string | undefined;
  const context: ExecutionContext = {
    site, channel: channel(), task, settings: defaultSettings(), signal: new AbortController().signal,
    secrets: { get: async key => secrets.get(key), set: async (key, value) => { secrets.set(key, value); },
      delete: async key => { secrets.delete(key); } },
    ai: { json: async <T>() => ({} as T) },
    getAccount: () => accounts.find(value => value.id === task.accountId),
    saveAccount: async (value, secret) => {
      if (secret) secrets.set(`account:${value.id}`, secret);
      const i = accounts.findIndex(item => item.id === value.id);
      if (i >= 0) accounts[i] = structuredClone(value); else accounts.push(structuredClone(value));
      task.accountId = value.id;
    },
    checkpoint: partial => {
      if (partial.paper && !partial.submittedAt) throw Error('publisher receipt requires submittedAt');
      if (failCheckpoint && partial.checkpoint === failCheckpoint) throw Error('synthetic durable write failure');
      checkpoints.push(structuredClone(partial)); Object.assign(task, structuredClone(partial));
    }, log: () => undefined,
  };
  return { context, site, task, accounts, secrets, checkpoints, setFailedCheckpoint: (value: string) => { failCheckpoint = value; } };
}
function remotePost(task: Task, site: Site, overrides: Record<string, unknown> = {}) {
  const article = paperTesting.approvedArticle(task, site);
  return { id: POST_ID, slug: article.slug, title: article.title, body: article.markdown,
    collection: { alias: USERNAME, url: `https://paper.wf/${USERNAME}/` }, ...overrides };
}
function ownerFetch(username = USERNAME): PaperTransport {
  return async (input, init) => {
    const path = new URL(input).pathname;
    if (path === '/api/me') return json({ username });
    if (path === '/api/me/collections') return json([{ alias: username, url: `https://paper.wf/${username}/`, public: true }]);
    throw Error(`unexpected ${init.method} ${input}`);
  };
}

test('connect validates token owner and public collection, saves password and token only in vault', async () => {
  const writes = new Map<string, string>();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const vault = { get: async (key: string) => writes.get(key), set: async (key: string, value: string) => { writes.set(key, value); },
    delete: async (key: string) => { writes.delete(key); } };
  const result = await connectPaperAccount(vault, 'existing', USERNAME, PASSWORD, { fetch: async (input, init) => {
    calls.push({ url: input, init });
    if (input.endsWith('/api/auth/login')) {
      assert.deepEqual(JSON.parse(String(init.body)), { alias: USERNAME, pass: PASSWORD });
      return json({ access_token: TOKEN, user: { username: USERNAME } });
    }
    return ownerFetch()(input, init);
  } });
  assert.deepEqual(result, { username: USERNAME, url: `https://paper.wf/${USERNAME}/` });
  assert.equal(JSON.stringify(result).includes(PASSWORD), false);
  assert.equal(calls.every(call => call.url.startsWith('https://paper.wf/') && !call.url.includes(PASSWORD) && !call.url.includes(TOKEN)), true);
  assert.deepEqual(JSON.parse(writes.get('account:existing')!), { version: 1, username: USERNAME, password: PASSWORD, token: TOKEN });
  assert.equal((calls.at(-1)!.init.headers as Record<string, string>).authorization, `Token ${TOKEN}`);
  await assert.rejects(connectPaperAccount(vault, 'bad', USERNAME, PASSWORD, { fetch: async (input, init) => {
    if (input.endsWith('/api/auth/login')) return json({ access_token: TOKEN, user: { username: USERNAME } });
    if (input.endsWith('/api/me')) return json({ username: 'someone-else' });
    return ownerFetch()(input, init);
  } }));
  assert.equal(writes.has('account:bad'), false);
});

test('prepare saves generated credentials and one signup intent before signup, then owns its public collection', async () => {
  const { context, accounts, task, secrets, checkpoints } = fixture({ registered: false });
  let signups = 0;
  const fetch: PaperTransport = async (input, init) => {
    const path = new URL(input).pathname;
    const username = accounts[0]?.username;
    if (path === '/api/auth/signup') {
      signups++;
      assert.equal(accounts[0]?.status, 'unknown');
      assert.equal(accounts[0]?.registrationAttempts, 1);
      assert.equal(checkpoints.at(-1)?.checkpoint, 'paper_account_create_pending');
      const saved = JSON.parse(secrets.get(`account:${accounts[0].id}`)!);
      assert.equal(saved.username, username);
      assert.equal(saved.password.length >= 32, true);
      assert.deepEqual(JSON.parse(String(init.body)), { alias: username, pass: saved.password });
      assert.equal((init.headers as Record<string, string>).authorization, undefined);
      return json({ access_token: TOKEN, user: { username } }, 201);
    }
    if (path === '/api/me') return json({ username });
    if (path === '/api/me/collections') return json([{ alias: username, url: `https://paper.wf/${username}/`, public: true }]);
    throw Error(`unexpected ${init.method} ${input}`);
  };
  assert.equal(await preparePaperIdentity(context, { fetch, now: () => NOW }), undefined);
  assert.equal(signups, 1);
  assert.equal(task.accountId, accounts[0].id);
  assert.equal(accounts[0].status, 'registered');
  assert.equal(accounts[0].credentialKind, 'api_token');
  assert.equal(accounts[0].publicationUrl, `https://paper.wf/${accounts[0].username}/`);
  assert.equal(JSON.parse(secrets.get(`account:${accounts[0].id}`)!).token, TOKEN);
  assert.equal(await preparePaperIdentity(context, { fetch, now: () => NOW }), undefined);
  assert.equal(signups, 1);
});

test('unknown signup is never retried or replaced; later prepare only authenticates saved identity', async () => {
  const { context, accounts } = fixture({ registered: false });
  let signups = 0;
  const first = await preparePaperIdentity(context, { fetch: async input => {
    if (input.endsWith('/api/auth/signup')) { signups++; throw Error('connection lost after request'); }
    throw Error(`unexpected ${input}`);
  } });
  assert.equal(first?.status, 'needs_input');
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].registrationAttempts, 1);
  const methods: string[] = [];
  const second = await preparePaperIdentity(context, { fetch: async (input, init) => {
    methods.push(`${init.method} ${new URL(input).pathname}`);
    if (input.endsWith('/api/auth/login')) return json({}, 404);
    throw Error(`unexpected ${input}`);
  } });
  assert.equal(second?.status, 'needs_input');
  assert.equal(signups, 1);
  assert.deepEqual(methods, ['POST /api/auth/login']);
  assert.equal(accounts.length, 1);
});

test('Cloudflare signup challenge preserves one durable intent and requires the same browser-verified identity', async () => {
  const { context, accounts, task, secrets, checkpoints } = fixture({ registered: false });
  let signups = 0;
  const first = await preparePaperIdentity(context, { now: () => NOW, fetch: async (input, init) => {
    assert.equal(new URL(input).pathname, '/api/auth/signup');
    assert.equal(init.method, 'POST');
    signups++;
    assert.equal(accounts[0].status, 'unknown');
    assert.equal(accounts[0].registrationAttempts, 1);
    assert.equal(checkpoints.at(-1)?.checkpoint, 'paper_account_create_pending');
    return challenge();
  } });
  assert.equal(first?.status, 'needs_input');
  assert.equal(first?.checkpoint, 'paper_account_create_pending');
  assert.match(first?.message ?? '', /浏览器.*同一用户名/);
  assert.match(first?.message ?? '', /其他任务可继续/);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].status, 'needs_verification');
  assert.equal(accounts[0].diagnostic?.code, 'verification_required');
  assert.equal(accounts[0].diagnostic?.retryable, false);
  assert.equal(accounts[0].registrationAttempts, 1);
  const sameAccountId = accounts[0].id;
  const savedCredential = secrets.get(`account:${sameAccountId}`);
  const second = await preparePaperIdentity(context, { fetch: async () => { throw Error('no automatic retry'); } });
  assert.equal(second?.status, 'needs_input');
  assert.match(second?.message ?? '', /浏览器.*同一用户名/);
  assert.equal((await runPaperTask(context, { fetch: async () => { throw Error('no publication before verification'); } })).status, 'needs_input');
  assert.equal(signups, 1);
  assert.equal(accounts.length, 1);
  assert.equal(task.accountId, sameAccountId);
  assert.equal(secrets.get(`account:${sameAccountId}`), savedCredential);
  assert.equal(checkpoints.filter(value => value.checkpoint === 'paper_account_create_pending').length, 1);
});

test('login and ownership challenges are verification requests, never bad credentials or restrictions', async () => {
  for (const challengedPath of ['/api/auth/login', '/api/me'] as const) {
    const { context, accounts, secrets } = fixture();
    if (challengedPath === '/api/auth/login') {
      secrets.set('account:paper-account', JSON.stringify({ version: 1, username: USERNAME, password: PASSWORD }));
    }
    const calls: string[] = [];
    const result = await preparePaperIdentity(context, { fetch: async (input, init) => {
      const path = new URL(input).pathname;
      calls.push(`${init.method} ${path}`);
      assert.equal(path, challengedPath);
      return challenge();
    } });
    assert.equal(result?.status, 'needs_input');
    assert.equal(accounts[0].status, 'needs_verification');
    assert.equal(accounts[0].diagnostic?.code, 'verification_required');
    assert.equal(accounts[0].id, 'paper-account');
    assert.deepEqual(calls, [challengedPath === '/api/auth/login' ? 'POST /api/auth/login' : 'GET /api/me']);
  }
});

test('connect detects challenge header before status or HTML parsing and does not save a secret', async () => {
  const writes: string[] = [];
  const vault = { get: async () => undefined, set: async (_key: string, value: string) => { writes.push(value); }, delete: async () => {} };
  for (const response of [challenge(), challenge(200)]) {
    await assert.rejects(connectPaperAccount(vault, 'paper-account', USERNAME, PASSWORD,
      { fetch: async () => response }), (error: unknown) => error instanceof PaperError && error.code === 'verification_required');
  }
  await assert.rejects(connectPaperAccount(vault, 'paper-account', USERNAME, PASSWORD,
    { fetch: async () => new Response('forbidden', { status: 403 }) }),
  (error: unknown) => error instanceof PaperError && error.code === 'forbidden');
  assert.equal(writes.length, 0);
});

test('failed account-intent checkpoint stops before the first signup request', async () => {
  const { context, accounts, secrets, setFailedCheckpoint } = fixture({ registered: false });
  setFailedCheckpoint('paper_account_create_pending');
  let calls = 0;
  const result = await preparePaperIdentity(context, { fetch: async () => { calls++; throw Error('unexpected network'); } });
  assert.equal(result?.status, 'queued');
  assert.equal(calls, 0);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].registrationAttempts, 1);
  assert.equal(JSON.parse(secrets.get(`account:${accounts[0].id}`)!).username, accounts[0].username);
});

test('publisher persists intent, POSTs exact approved article once, and verifies anonymous API and visible full page', async () => {
  const { context, task, site, checkpoints } = fixture();
  const calls: Array<{ path: string; method: string }> = [];
  const article = paperTesting.approvedArticle(task, site);
  const fetch: PaperTransport = async (input, init) => {
    const path = new URL(input).pathname;
    calls.push({ path, method: String(init.method) });
    if (path === '/api/me' || path === '/api/me/collections') return ownerFetch()(input, init);
    if (path === `/api/collections/${USERNAME}/posts/${article.slug}` && checkpoints.length === 0) return json({}, 404);
    if (path === `/api/collections/${USERNAME}/posts/${article.slug}`) {
      assert.equal((init.headers as Record<string, string>).authorization, undefined);
      return json(remotePost(task, site));
    }
    if (path === `/api/collections/${USERNAME}/posts` && init.method === 'POST') {
      assert.equal(checkpoints.at(-1)?.checkpoint, 'paper_publish_submitting');
      assert.equal(checkpoints.at(-1)?.paper?.postId, undefined);
      assert.deepEqual(JSON.parse(String(init.body)), { title: article.title, body: BODY, slug: article.slug });
      assert.equal((init.headers as Record<string, string>).authorization, `Token ${TOKEN}`);
      return json(remotePost(task, site), 201);
    }
    if (path === `/${USERNAME}/${article.slug}`) return html(renderedBody());
    throw Error(`unexpected ${init.method} ${input}`);
  };
  const result = await runPaperTask(context, { fetch, now: () => NOW });
  assert.equal(result.status, 'review');
  assert.equal(result.publicUrl, `https://paper.wf/${USERNAME}/${article.slug}`);
  assert.equal(result.paper?.stage, 'published');
  assert.equal(result.paper?.postId, POST_ID);
  assert.equal(checkpoints[0].checkpoint, 'paper_publish_submitting');
  assert.equal(checkpoints[0].paper?.slug, article.slug);
  assert.equal(checkpoints[0].paper?.contentHash, article.contentHash);
  assert.equal(checkpoints.at(-1)?.checkpoint, 'paper_published');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  const verified = await verifyPaperPublication(task, site.url, undefined, { fetch });
  assert.equal(verified.outcome, 'found');
  assert.equal(verified.found, true);
});

test('unknown post result only reads original slug on rerun and reconciliation', async () => {
  const { context, task, site } = fixture();
  const article = paperTesting.approvedArticle(task, site);
  let posts = 0;
  const first = await runPaperTask(context, { fetch: async (input, init) => {
    const path = new URL(input).pathname;
    if (path === '/api/me' || path === '/api/me/collections') return ownerFetch()(input, init);
    if (path === `/api/collections/${USERNAME}/posts/${article.slug}`) return json({}, 404);
    if (path === `/api/collections/${USERNAME}/posts` && init.method === 'POST') { posts++; throw Error('connection lost'); }
    throw Error(`unexpected ${init.method} ${input}`);
  } });
  assert.equal(first.status, 'review');
  assert.equal(task.paper?.stage, 'submitting');
  const methods: string[] = [];
  const second = await runPaperTask(context, { fetch: async (input, init) => {
    methods.push(String(init.method));
    const path = new URL(input).pathname;
    if (path === `/api/collections/${USERNAME}/posts/${article.slug}`) return json(remotePost(task, site));
    if (path === `/${USERNAME}/${article.slug}`) return html(renderedBody());
    throw Error(`unexpected ${init.method} ${input}`);
  } });
  assert.equal(second.status, 'review');
  assert.equal(second.paper?.stage, 'published');
  assert.equal(posts, 1);
  assert.deepEqual(methods, ['GET', 'GET']);
  assert.equal((await reconcilePaperTask(context, { fetch: async (input, init) => {
    const path = new URL(input).pathname;
    if (path === `/api/collections/${USERNAME}/posts/${article.slug}`) return json(remotePost(task, site));
    if (path === `/${USERNAME}/${article.slug}`) return html(renderedBody());
    throw Error(`unexpected ${init.method} ${input}`);
  } })).status, 'found');
});

test('public verification rejects API body or owner mismatch and hidden or partial HTML', async () => {
  const { task, site } = fixture();
  const article = paperTesting.approvedArticle(task, site);
  task.paper = { username: USERNAME, slug: article.slug, contentHash: article.contentHash, stage: 'published', postId: POST_ID };
  task.publicUrl = `https://paper.wf/${USERNAME}/${article.slug}`;
  for (const override of [{ body: 'A truncated summary.' }, { collection: { alias: 'another-owner' } }]) {
    const result = await verifyPaperPublication(task, site.url, undefined, { fetch: async input => {
      if (new URL(input).pathname.startsWith('/api/')) return json(remotePost(task, site, override));
      throw Error('HTML should not be requested');
    } });
    assert.equal(result.found, false);
    assert.equal(result.outcome, 'invalid');
  }
  for (const visible of [`<div hidden>${renderedBody()}</div>`, '<p>A truncated summary with a target link.</p>']) {
    const result = await verifyPaperPublication(task, site.url, undefined, { fetch: async input => {
      if (new URL(input).pathname.startsWith('/api/')) return json(remotePost(task, site));
      return html(visible);
    } });
    assert.equal(result.found, false);
    assert.equal(result.outcome, 'invalid');
  }
});

test('abort and failed publish checkpoint stop before POST', async () => {
  const paused = fixture();
  paused.context.signal = AbortSignal.abort();
  assert.equal((await runPaperTask(paused.context, { fetch: async () => { throw Error('unexpected network'); } })).status, 'queued');
  const failed = fixture();
  failed.setFailedCheckpoint('paper_publish_submitting');
  let posts = 0;
  const result = await runPaperTask(failed.context, { fetch: async (input, init) => {
    const path = new URL(input).pathname;
    if (path === '/api/me' || path === '/api/me/collections') return ownerFetch()(input, init);
    if (path.includes('/posts/') && init.method === 'GET') return json({}, 404);
    if (init.method === 'POST') posts++;
    throw Error(`unexpected ${init.method} ${input}`);
  } });
  assert.equal(result.status, 'queued');
  assert.equal(posts, 0);
});

test('Paper Smartypants and no-blank-line prose dashes preserve the entire reviewed body', async t => {
  const markdown = [
    `A careful "review" compares each claim with its source. The [source](${TARGET}) records the method, limits, dates, and observed results so a reader can independently repeat the comparison.`,
    'Who repeats it\n- First account said "about 10 times" in 2025.\n- Second account said it was 0.3 Wh.',
    'The measured change was -5%, the budget was $-5, the ratio was 1/2, and the inequality was 1 < 2. A final paragraph closes the evidence without changing any of these figures.',
  ].join('\n\n');
  const body = `<p>A careful “review” compares each claim with its source. The <a href="${TARGET}" rel="nofollow ugc">source</a> records the method, limits, dates, and observed results so a reader can independently repeat the comparison.</p>
    <p>Who repeats it\n– First account said “about 10 times” in 2025.\n– Second account said it was 0.3 Wh.</p>
    <p>The measured change was -5%, the budget was $-5, the ratio was ½, and the inequality was 1 &lt; 2. A final paragraph closes the evidence without changing any of these figures.</p>`;
  const page = (content: string) => `<article id="post-body"><div class="e-content">${content}</div></article>`;
  assert.equal(paperVisibleBodyMatches(markdown, body), true);
  assert.deepEqual(inspectPaperRenderedArticle(page(body), markdown, TARGET), { found: true, rel: 'nofollow ugc' });

  for (const [label, changed] of [
    ['truncated paragraph', body.replace(/<p>The measured change[\s\S]*?<\/p>/, '')],
    ['changed figure', body.replace('-5%', '+5%')],
    ['changed currency sign', body.replace('$-5', '$5')],
    ['changed ratio', body.replace('½', '1:2')],
    ['changed inequality', body.replace('1 &lt; 2', '1 &gt; 2')],
    ['changed prose dash text', body.replace('Second account', 'Another account')],
    ['hidden body', `<div hidden>${body}</div>`],
    ['wrong target href', body.replace(`href="${TARGET}"`, 'href="https://other.example/source"')],
    ['hidden target href', body.replace('<a href=', '<a hidden href=')],
    ['empty target anchor', body.replace(`<a href="${TARGET}" rel="nofollow ugc">source</a>`,
      `source<a href="${TARGET}" rel="nofollow ugc"></a>`)],
    ['closed disclosure', `<details><summary>Read</summary>${body}</details>`],
  ] as const) {
    await t.test(label, () => assert.equal(inspectPaperRenderedArticle(page(changed), markdown, TARGET).found, false));
  }
  assert.equal(inspectPaperRenderedArticle(`<details>${page(body)}</details>`, markdown, TARGET).found, false);
  assert.equal(inspectPaperRenderedArticle(page(body).replace('class="e-content"',
    'class="e-content" style="height:1px;overflow:hidden"'), markdown, TARGET).found, false);
  assert.equal(inspectPaperRenderedArticle(`<style>.e-content{max-height:1px;overflow-y:hidden}</style>${page(body)}`,
    markdown, TARGET).found, false);
});

test('Paper expected text follows the pinned Saturday Smartypants callbacks', async t => {
  const examples = [
    ['double hyphen', 'The first account -- independently measured -- agrees.',
      '<p>The first account — independently measured — agrees.</p>',
      '<p>The first account – independently measured – agrees.</p>'],
    ['boundary single hyphen', 'The first account - independently measured - agrees.',
      '<p>The first account – independently measured – agrees.</p>',
      '<p>The first account - independently measured - agrees.</p>'],
    ['common fractions', 'The ratio is 1/2 and the remainder is 1/4 or 3/4.',
      '<p>The ratio is ½ and the remainder is ¼ or ¾.</p>',
      '<p>The ratio is 1/2 and the remainder is 1/4 or 3/4.</p>'],
    ['parenthesized marks', 'The archive uses (c), (r) and (tm) text.',
      '<p>The archive uses ©, ® and ™ text.</p>',
      '<p>The archive uses (c), (r) and (tm) text.</p>'],
  ] as const;
  for (const [label, markdown, officialHtml, alteredHtml] of examples) {
    await t.test(label, () => {
      assert.equal(paperVisibleBodyMatches(markdown, officialHtml), true);
      assert.equal(paperVisibleBodyMatches(markdown, alteredHtml), false);
    });
  }
  assert.equal(paperVisibleBodyMatches('The return was -5%, the budget $-5 and the date 1/2/2025.',
    '<p>The return was -5%, the budget $-5 and the date 1/2/2025.</p>'), true);
  assert.equal(paperVisibleBodyMatches('The return was -5%, the budget $-5 and the date 1/2/2025.',
    '<p>The return was –5%, the budget $-5 and the date 1/2/2025.</p>'), false);
  assert.equal(paperVisibleBodyMatches('The value is 1/23, 11/2 and 1/2/3.',
    '<p>The value is 1/23, 11/2 and 1/2/3.</p>'), true);
  assert.equal(paperVisibleBodyMatches('A literal apostrophe stays in the operator\'s note.',
    '<p>A literal apostrophe stays in the operator’s note.</p>'), false);
  assert.equal(paperVisibleBodyMatches('An omission... stays as three periods.',
    '<p>An omission… stays as three periods.</p>'), false);
});

test('Paper typography never changes inline code or a single numeric minus', () => {
  const markdown = 'A quoted "claim" has a $-5 loss and `"code--token"`. Another independent sentence documents the exact expression.';
  const valid = '<p>A quoted “claim” has a $-5 loss and <code>"code--token"</code>. Another independent sentence documents the exact expression.</p>';
  assert.equal(paperVisibleBodyMatches(markdown, valid), true);
  assert.equal(paperVisibleBodyMatches(markdown, valid.replace('<code>"code--token"</code>', '<code>“code–token”</code>')), false);
  assert.equal(paperVisibleBodyMatches(markdown, valid.replace('$-5', '$–5')), false);
  const fenced = 'A paragraph starts here.\n\n```text\n- code--line\n```\n\nA second paragraph ends here.';
  assert.equal(paperVisibleBodyMatches(fenced,
    '<p>A paragraph starts here.</p><pre><code>- code--line\n</code></pre><p>A second paragraph ends here.</p>'), true);
});

test('anonymous Paper verification accepts Paper-rendered typography after exact API body check', async () => {
  const { task, site } = fixture();
  const body = [
    `A careful "review" compares each source date and reproducible observation. The [source](${TARGET}) records both methods and limits, so readers can test each step independently.`,
    'Observed accounts\n- The first account reports a bounded result.\n- The second account reports a -5% change.',
    'A final paragraph explains why the two accounts differ and what would invalidate the conclusion. It includes the numeric value 1/2 and makes the commercial relationship clear.',
  ].join('\n\n');
  task.draft = { ...task.draft!, body };
  const article = paperTesting.approvedArticle(task, site);
  task.paper = { username: USERNAME, slug: article.slug, contentHash: article.contentHash, stage: 'published', postId: POST_ID };
  task.publicUrl = `https://paper.wf/${USERNAME}/${article.slug}`;
  const rendered = `<p>A careful “review” compares each source date and reproducible observation. The <a href="${TARGET}">source</a> records both methods and limits, so readers can test each step independently.</p>
    <p>Observed accounts\n– The first account reports a bounded result.\n– The second account reports a -5% change.</p>
    <p>A final paragraph explains why the two accounts differ and what would invalidate the conclusion. It includes the numeric value ½ and makes the commercial relationship clear.</p>`;
  const fetch: PaperTransport = async input => new URL(input).pathname.startsWith('/api/')
    ? json(remotePost(task, site)) : html(rendered);
  const result = await verifyPaperPublication(task, site.url, undefined, { fetch });
  assert.equal(result.found, true);
  assert.equal(result.outcome, 'found');
  const changedApi: PaperTransport = async input => new URL(input).pathname.startsWith('/api/')
    ? json(remotePost(task, site, { body: body.replace('-5%', '+5%') })) : html(rendered);
  assert.equal((await verifyPaperPublication(task, site.url, undefined, { fetch: changedApi })).found, false);
});

 test("Paper preserves an isolated final hyphen per the fixed renderer",()=>{assert.equal(paperVisibleBodyMatches("The final symbol is -","<p>The final symbol is -</p>"),true);assert.equal(paperVisibleBodyMatches("The final symbol is -","<p>The final symbol is –</p>"),false)});

test('Paper carries HTTP robots policy and rejects changed non-target references', async () => {
  const {task,site}=fixture(),article=paperTesting.approvedArticle(task,site);
  task.paper={username:USERNAME,slug:article.slug,contentHash:article.contentHash,stage:'published',postId:POST_ID};
  task.publicUrl=`https://paper.wf/${USERNAME}/${article.slug}`;
  for(const directive of ['noindex','nofollow','max-image-preview:none']){
    const result=await verifyPaperPublication(task,site.url,undefined,{fetch:async input=>{
      if(new URL(input).pathname.startsWith('/api/'))return json(remotePost(task,site));
      const page=html(renderedBody());page.headers.set('x-robots-tag',directive);return page;
    }});
    assert.equal(result.found,directive!=='noindex');if(directive==='nofollow')assert.equal(result.rel,'nofollow');
  }
  const text=`A [source](https://reference.example/first) and [target](${TARGET}).`;
  assert.equal(paperVisibleBodyMatches(text,`<p>A <a href="https://reference.example/other">source</a> and <a href="${TARGET}">target</a>.</p>`),false);
});
