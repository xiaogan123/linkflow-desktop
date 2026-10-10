import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import {
  connectMataroaAccount, mataroaTesting, prepareMataroaIdentity, reconcileMataroaTask, runMataroaTask,
  verifyMataroaPublication, type MataroaTransport,
} from '../src/integrations/mataroa';
import { defaultSettings } from '../src/main/store';
import type { Account, Channel, ExecutionContext, Site, Task } from '../src/shared/types';

const NOW = '2026-10-07T03:04:05.678Z';
const TARGET = 'https://example.com/guides/operational-risk';
const USERNAME = 'example-desk';
const TOKEN = 'synthetic-mataroa-key-0123456789abcdef';
const PASSWORD = 'synthetic-password-for-tests';
const SLUG = 'reproducible-operational-review';
const PUBLIC = `https://${USERNAME}.mataroa.blog/blog/${SLUG}/`;
const CSRF = 'a'.repeat(32);
const WELCOME = '/accounts/welcome/11111111-1111-4111-8111-111111111111/';
const TITLE = 'A reproducible operational review';
const BODY = [
  `A reproducible review records the exact inputs, source dates, and failure conditions. The maintained checklist at [the operator's site](${TARGET}) shows how to repeat each check and distinguish observations from assumptions. This publication is operated by Example Lab, which discloses its commercial relationship here.`,
  'Readers should compare current eligibility terms, failure behavior, and operational constraints before making a decision. Example Lab may receive a commission from a relevant referral, but that relationship does not change the listed limitations or the steps used to reproduce each observation.',
].join('\n\n');

function response(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}
function json(value: unknown): Response { return response(JSON.stringify(value), 200, { 'content-type': 'application/json' }); }
function redirect(location: string): Response { return response('', 302, { location }); }
function settings(username: string, on: boolean, extras: { theme?: boolean; comments?: boolean } = {}): string {
  return `<html><body><form method="post"><input type="hidden" name="csrfmiddlewaretoken" value="${CSRF}">
    <input name="username" value="${username}"><input name="email" value="">
    <input name="blog_title" value="Example Desk"><textarea name="blog_byline">Trusted notes</textarea>
    <textarea name="footer_note">About the author</textarea><input type="checkbox" name="theme_zialucia" ${extras.theme ? 'checked' : ''}>
    <input type="checkbox" name="theme_sansserif"><input type="checkbox" name="post_altpath_on">
    <input name="custom_domain" value=""><input type="checkbox" name="comments_on" ${extras.comments ? 'checked' : ''}>
    <input type="checkbox" name="notifications_on" ${on ? 'checked' : ''}>
    <input type="checkbox" name="mail_export_on"><button type="submit">Save</button></form></body></html>`;
}
function loginForm(): string {
  return `<form method="post"><input name="csrfmiddlewaretoken" value="${CSRF}"><input name="username"><input name="password"></form>`;
}
function welcomeForm(): string {
  return `<form method="post"><input name="csrfmiddlewaretoken" value="${CSRF}"><input name="username"><input name="email"><input name="password1"><input name="password2"></form>`;
}
function page(body = BODY, status: 'published' | 'scheduled' = 'published'): string {
  return `<html><body><article><h1>${TITLE}</h1><div class="posts-item-byline">${status === 'published' ? 'Published on' : 'SCHEDULED for'} <time itemprop="datePublished" datetime="2026-10-07">October 7, 2026</time></div><div class="posts-item-body" itemprop="articleBody">${marked.parse(body, { async: false })}</div></article></body></html>`;
}
function channel(): Channel {
  return { id: 'mataroa', name: 'Mataroa', domain: 'mataroa.blog', url: 'https://mataroa.blog/', submitUrl: 'https://mataroa.blog/',
    categories: ['content'], languages: ['*'], kind: 'article', emailRequired: false, accountRequired: true,
    articleRequired: true, free: 'yes', freeNote: 'Open author account', automation: 'api', quality: 'C',
    qualityReason: 'Original articles', rulesUrl: 'https://mataroa.blog/', checkedAt: NOW,
    notes: 'Original publication only', allowedHosts: ['mataroa.blog'], enabled: true };
}
function account(overrides: Partial<Account> = {}): Account {
  return { id: 'mataroa-account', channelId: 'mataroa', credentialKind: 'api_token', email: '', username: USERNAME,
    publicationUrl: `https://${USERNAME}.mataroa.blog/`, createdAt: NOW, status: 'registered', hasPassword: true,
    source: 'imported', ...overrides };
}
function fixture(options: { empty?: boolean; task?: Partial<Task>; account?: Partial<Account>; pendingSetup?: boolean } = {}) {
  const site: Site = { id: 'site', domain: 'example.com', url: 'https://example.com/', email: 'owner@example.com',
    name: 'Example Lab', description: 'Source-backed operational research.', category: 'business', language: 'en',
    monthlyTarget: 2, status: 'ready', createdAt: NOW };
  const task: Task = { id: 'task', siteId: 'site', channelId: 'mataroa', sourceDomain: 'mataroa.blog', status: 'running',
    accountId: options.empty ? undefined : 'mataroa-account', createdAt: NOW, scheduledAt: NOW, updatedAt: NOW,
    attempts: 1, message: '', topicUrl: TARGET, draft: { title: TITLE, description: 'Documented checks.', body: BODY },
    draftRevision: 1, articleApprovedAt: NOW, ...options.task };
  const accounts: Account[] = options.empty ? [] : [account(options.account)];
  const secrets = new Map<string, string>(accounts.map(value => [`account:${value.id}`, JSON.stringify({ version: 1,
    username: value.username, password: PASSWORD, token: TOKEN, ...(options.pendingSetup ? { initialSetupPending: true } : {}) })]));
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
      const index = accounts.findIndex(item => item.id === value.id);
      if (index >= 0) accounts[index] = structuredClone(value); else accounts.push(structuredClone(value));
      task.accountId = value.id;
    },
    checkpoint: partial => {
      if (partial.mataroa && !partial.submittedAt && !task.submittedAt) throw Error('receipt requires submittedAt');
      if (failCheckpoint && partial.checkpoint === failCheckpoint) throw Error('synthetic durable write failure');
      checkpoints.push(structuredClone(partial)); Object.assign(task, structuredClone(partial));
    }, log: () => undefined,
  };
  return { context, task, accounts, secrets, checkpoints, setFailedCheckpoint: (value: string) => { failCheckpoint = value; } };
}
function post(username = USERNAME, overrides: Record<string, unknown> = {}) {
  return { title: TITLE, body: BODY, published_at: '2026-10-07', slug: SLUG,
    url: `https://${username}.mataroa.blog/blog/${SLUG}/`, ...overrides };
}
function transport(options: { username?: string; password?: string; notificationsOn?: boolean; posts?: unknown[]; onPost?: (body: unknown) => Response | Promise<Response>;
  challenge?: string; settingsReadback?: boolean; wrongPage?: boolean } = {}) {
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  const username = options.username ?? USERNAME;
  let notificationsOn = options.notificationsOn ?? false;
  let settingsPosts = 0;
  let articlePosts = 0;
  const fetch: MataroaTransport = async (input, init) => {
    const url = new URL(input), path = url.pathname, method = init.method ?? 'GET';
    calls.push({ path, method, body: init.body?.toString() });
    if (options.challenge === path) return response('<title>Just a moment...</title>', 403, { 'cf-mitigated': 'challenge' });
    if (url.hostname === `${username}.mataroa.blog`) return response(options.wrongPage ? page(BODY.replace(TARGET, 'https://wrong.example/')) : page());
    if (path === '/accounts/login/' && method === 'GET') return response(loginForm());
    if (path === '/accounts/login/' && method === 'POST') {
      const fields = new URLSearchParams(init.body?.toString());
      assert.equal(fields.get('username'), username); assert.equal(fields.get('password'), options.password ?? PASSWORD);
      return redirect('/');
    }
    if (path === '/dashboard/') return response(`<title>Dashboard - ${username}</title>`);
    if (path === '/accounts/edit/' && method === 'GET') return response(settings(username, notificationsOn, { theme: true, comments: true }));
    if (path === '/accounts/edit/' && method === 'POST') {
      settingsPosts++;
      const fields = new URLSearchParams(init.body?.toString());
      assert.equal(fields.get('username'), username);
      assert.equal(fields.get('theme_zialucia'), 'on'); assert.equal(fields.get('comments_on'), 'on');
      assert.equal(fields.get('blog_byline'), 'Trusted notes'); assert.equal(fields.get('footer_note'), 'About the author');
      assert.equal(fields.has('notifications_on'), false);
      if (options.settingsReadback !== false) notificationsOn = false;
      return redirect('/dashboard/');
    }
    if (path === '/api/docs/') return response(`<dl><dt>API Key</dt><dd><code>${TOKEN}</code></dd></dl>`);
    if (path === '/api/posts/' && method === 'GET') return json({ ok: true, post_list: options.posts ?? [] });
    if (path === '/api/posts/' && method === 'POST') {
      articlePosts++;
      return options.onPost?.(JSON.parse(init.body?.toString() ?? 'null')) ?? json({ ok: true, slug: SLUG, url: PUBLIC });
    }
    throw Error(`unexpected ${method} ${input}`);
  };
  return { fetch, calls, get settingsPosts() { return settingsPosts; }, get articlePosts() { return articlePosts; } };
}

test('generated identity persists one registration intent before welcome/signup and closes newsletter before API readiness', async () => {
  const { context, accounts, task, secrets, checkpoints } = fixture({ empty: true });
  let signupPosts = 0, welcomePosts = 0, settingsPosts = 0, on = true;
  const fetch: MataroaTransport = async (input, init) => {
    const path = new URL(input).pathname, method = init.method ?? 'GET';
    if (path === '/accounts/create/' && method === 'GET') return response(`<form method="post"><input name="csrfmiddlewaretoken" value="${CSRF}"><input type="submit" value="Continue"></form>`);
    if (path === '/accounts/create/' && method === 'POST') {
      welcomePosts++;
      assert.equal(checkpoints.at(-1)?.checkpoint, 'mataroa_account_create_pending');
      assert.equal(accounts[0].registrationAttempts, 1);
      assert.equal(JSON.parse(secrets.get(`account:${accounts[0].id}`)!).initialSetupPending, true);
      return redirect(WELCOME);
    }
    if (path === WELCOME && method === 'GET') return response(welcomeForm());
    if (path === WELCOME && method === 'POST') {
      signupPosts++;
      const fields = new URLSearchParams(init.body?.toString());
      assert.equal(fields.get('username'), accounts[0].username);
      assert.equal(fields.get('password1'), fields.get('password2'));
      return redirect('/dashboard/');
    }
    if (path === '/dashboard/') return response(`<title>Dashboard - ${accounts[0].username}</title>`);
    if (path === '/accounts/edit/' && method === 'GET') return response(settings(accounts[0].username, on, { theme: true, comments: true }));
    if (path === '/accounts/edit/' && method === 'POST') {
      settingsPosts++;
      const values = new URLSearchParams(init.body?.toString());
      assert.equal(values.get('username'), accounts[0].username);
      assert.equal(values.get('theme_zialucia'), 'on'); assert.equal(values.get('comments_on'), 'on');
      assert.equal(values.has('notifications_on'), false);
      on = false; return redirect('/dashboard/');
    }
    if (path === '/api/docs/') return response(`<dt>API Key</dt><dd><code>${TOKEN}</code></dd>`);
    if (path === '/api/posts/') return json({ ok: true, post_list: [] });
    throw Error(`unexpected ${method} ${path}`);
  };
  assert.equal(await prepareMataroaIdentity(context, { fetch, now: () => NOW }), undefined);
  assert.equal(welcomePosts, 1); assert.equal(signupPosts, 1); assert.equal(settingsPosts, 1);
  assert.equal(task.accountId, accounts[0].id); assert.equal(accounts[0].status, 'registered');
  assert.equal(accounts[0].publicationUrl, `https://${accounts[0].username}.mataroa.blog/`);
  assert.equal(JSON.parse(secrets.get(`account:${accounts[0].id}`)!).initialSetupPending, undefined);
  assert.equal(JSON.parse(secrets.get(`account:${accounts[0].id}`)!).token, TOKEN);
});

test('signup challenge freezes original identity; second preparation only logs in and never repeats registration', async () => {
  const { context, accounts, secrets } = fixture({ empty: true });
  let welcomePosts = 0, signupPosts = 0;
  const first: MataroaTransport = async (input, init) => {
    const path = new URL(input).pathname, method = init.method ?? 'GET';
    if (path === '/accounts/create/' && method === 'GET') return response(`<input name="csrfmiddlewaretoken" value="${CSRF}"><input value="Continue">`);
    if (path === '/accounts/create/' && method === 'POST') { welcomePosts++; return redirect(WELCOME); }
    if (path === WELCOME && method === 'GET') return response(welcomeForm());
    if (path === WELCOME && method === 'POST') { signupPosts++; return response('verify you are human', 403, { 'cf-mitigated': 'challenge' }); }
    throw Error(`unexpected ${method} ${path}`);
  };
  const interrupted = await prepareMataroaIdentity(context, { fetch: first, now: () => NOW });
  assert.equal(interrupted?.status, 'needs_input'); assert.equal(accounts[0].registrationAttempts, 1);
  const original = accounts[0].username;
  const resumed = transport({ username: original, password: JSON.parse(secrets.get(`account:${accounts[0].id}`)!).password, notificationsOn: true });
  assert.equal(await prepareMataroaIdentity(context, { fetch: resumed.fetch, now: () => NOW }), undefined);
  assert.equal(welcomePosts, 1); assert.equal(signupPosts, 1);
  assert.equal(resumed.calls.some(call => call.path === '/accounts/create/' || call.path === WELCOME), false);
  assert.equal(resumed.settingsPosts, 1);
  assert.equal(JSON.parse(secrets.get(`account:${accounts[0].id}`)!).initialSetupPending, undefined);
});

test('imported identity with newsletter on is blocked without changing settings or storing credentials', async () => {
  const writes = new Map<string, string>();
  const vault = { get: async (key: string) => writes.get(key), set: async (key: string, value: string) => { writes.set(key, value); },
    delete: async (key: string) => { writes.delete(key); } };
  const remote = transport({ notificationsOn: true });
  await assert.rejects(connectMataroaAccount(vault, 'existing', USERNAME, PASSWORD, { fetch: remote.fetch }));
  assert.equal(remote.settingsPosts, 0); assert.equal(remote.articlePosts, 0); assert.equal(writes.size, 0);
  const off = transport();
  assert.deepEqual(await connectMataroaAccount(vault, 'existing', USERNAME, PASSWORD, { fetch: off.fetch }),
    { username: USERNAME, url: `https://${USERNAME}.mataroa.blog/` });
  assert.deepEqual(JSON.parse(writes.get('account:existing')!), { version: 1, username: USERNAME, password: PASSWORD, token: TOKEN });
});

test('explicit existing-account permission disables Newsletter once, preserves every other setting, and stores only verified credentials', async () => {
  const writes = new Map<string, string>();
  const vault = { get: async (key: string) => writes.get(key), set: async (key: string, value: string) => { writes.set(key, value); },
    delete: async (key: string) => { writes.delete(key); } };
  const remote = transport({ notificationsOn: true });
  assert.deepEqual(await connectMataroaAccount(vault, 'existing', USERNAME, PASSWORD, { fetch: remote.fetch, allowDisableNewsletter: true }),
    { username: USERNAME, url: `https://${USERNAME}.mataroa.blog/` });
  assert.equal(remote.settingsPosts, 1); assert.equal(remote.articlePosts, 0);
  const posted = new URLSearchParams(remote.calls.find(call => call.path === '/accounts/edit/' && call.method === 'POST')?.body);
  assert.deepEqual([...posted], [
    ['csrfmiddlewaretoken', CSRF], ['username', USERNAME], ['email', ''], ['blog_title', 'Example Desk'],
    ['blog_byline', 'Trusted notes'], ['footer_note', 'About the author'], ['theme_zialucia', 'on'],
    ['custom_domain', ''], ['comments_on', 'on'],
  ]);
  assert.deepEqual(JSON.parse(writes.get('account:existing')!), { version: 1, username: USERNAME, password: PASSWORD, token: TOKEN });
  const alreadyOff = transport();
  assert.deepEqual(await connectMataroaAccount(vault, 'existing', USERNAME, PASSWORD, { fetch: alreadyOff.fetch, allowDisableNewsletter: true }),
    { username: USERNAME, url: `https://${USERNAME}.mataroa.blog/` });
  assert.equal(alreadyOff.settingsPosts, 0);
});

test('failed or unknown explicit Newsletter change never succeeds, stores credentials, or retries the settings POST', async () => {
  for (const kind of ['readback', 'unknown'] as const) {
    const writes = new Map<string, string>(), baseline = transport({ notificationsOn: true, settingsReadback: kind !== 'readback' });
    let settingsPosts = 0;
    const fetch: MataroaTransport = async (input, init) => {
      if (new URL(input).pathname === '/accounts/edit/' && init.method === 'POST') {
        settingsPosts++;
        if (kind === 'unknown') throw Error('synthetic unknown settings outcome');
      }
      return baseline.fetch(input, init);
    };
    const vault = { get: async (key: string) => writes.get(key), set: async (key: string, value: string) => { writes.set(key, value); },
      delete: async (key: string) => { writes.delete(key); } };
    await assert.rejects(connectMataroaAccount(vault, 'existing', USERNAME, PASSWORD, { fetch, allowDisableNewsletter: true }));
    assert.equal(settingsPosts, 1, kind); assert.equal(writes.size, 0, kind); assert.equal(baseline.articlePosts, 0, kind);
  }
});

test('full article POST follows durable receipt and exact list and anonymous page checks; repeated run only GETs', async () => {
  const { context, task, checkpoints } = fixture();
  let published = false;
  const remote = transport({ onPost: value => {
    assert.deepEqual(value, { title: TITLE, body: BODY, published_at: '2026-10-07' });
    assert.equal(task.mataroa?.stage, 'submitting');
    assert.equal(task.submittedAt, NOW);
    assert.equal(checkpoints.at(-1)?.checkpoint, 'mataroa_publish_submitting');
    published = true; return json({ ok: true, slug: SLUG, url: PUBLIC });
  } });
  const fetch: MataroaTransport = async (input, init) => {
    if (new URL(input).pathname === '/api/posts/' && init.method === 'GET' && published) return json({ ok: true, post_list: [post()] });
    return remote.fetch(input, init);
  };
  const result = await runMataroaTask(context, { fetch, now: () => NOW });
  assert.equal(result.status, 'review'); assert.equal(result.publicUrl, PUBLIC);
  assert.equal(result.mataroa?.stage, 'published'); assert.equal(remote.articlePosts, 1);
  const second = await runMataroaTask(context, { fetch, now: () => NOW });
  assert.equal(second.publicUrl, PUBLIC); assert.equal(remote.articlePosts, 1);
  assert.equal((await verifyMataroaPublication(task, TARGET, { fetch, now: () => NOW })).outcome, 'found');
});

test('unknown POST, missing or ambiguous exact list, and restart never replay the write', async () => {
  const { context, task } = fixture();
  let postCalls = 0;
  const remote = transport({ onPost: () => { postCalls++; throw Error('synthetic connection loss'); } });
  const first = await runMataroaTask(context, { fetch: remote.fetch, now: () => NOW });
  assert.equal(first.status, 'review'); assert.equal(task.mataroa?.stage, 'submitting'); assert.equal(postCalls, 1);
  task.articleApprovedAt = undefined;
  const missing = await reconcileMataroaTask(context, { fetch: remote.fetch });
  assert.equal(missing.status, 'unknown');
  await runMataroaTask(context, { fetch: remote.fetch, now: () => NOW });
  assert.equal(postCalls, 1);
  const duplicate = transport({ posts: [post(), post()] });
  assert.equal((await reconcileMataroaTask(context, { fetch: duplicate.fetch })).status, 'unknown');
  const recovered = transport({ posts: [post()] });
  const found = await reconcileMataroaTask(context, { fetch: recovered.fetch });
  assert.equal(found.status, 'found');
  if (found.status === 'found') assert.equal(found.publicUrl, PUBLIC);
  assert.equal(postCalls, 1);
});

test('one-time initial setup marker cannot silently turn newsletter off after readiness', async () => {
  const { context, accounts, secrets } = fixture({ account: { source: 'generated', registrationAttempts: 1 } });
  const remote = transport({ notificationsOn: true });
  const result = await prepareMataroaIdentity(context, { fetch: remote.fetch, now: () => NOW });
  assert.equal(result?.status, 'needs_input');
  assert.equal(remote.settingsPosts, 0); assert.equal(remote.articlePosts, 0);
  assert.equal(accounts[0].status, 'needs_verification');
  assert.equal(JSON.parse(secrets.get('account:mataroa-account')!).initialSetupPending, undefined);
});

test('unknown initial settings write consumes permission before POST and never repeats it', async () => {
  const { context, accounts, secrets } = fixture({ account: { source: 'generated', status: 'unknown', registrationAttempts: 1 }, pendingSetup: true });
  const baseline = transport({ notificationsOn: true });
  let writes = 0;
  const unknown: MataroaTransport = async (input, init) => {
    if (new URL(input).pathname === '/accounts/edit/' && init.method === 'POST') {
      writes++;
      const saved = JSON.parse(secrets.get('account:mataroa-account')!);
      assert.equal(saved.initialSetupPending, undefined);
      assert.equal(saved.password, PASSWORD);
      assert.equal(saved.token, TOKEN);
      assert.equal(accounts[0].username, USERNAME);
      throw Error('synthetic unknown write outcome');
    }
    return baseline.fetch(input, init);
  };
  assert.equal((await prepareMataroaIdentity(context, { fetch: unknown, now: () => NOW }))?.status, 'needs_input');
  assert.equal(writes, 1);
  assert.equal((await prepareMataroaIdentity(context, { fetch: unknown, now: () => NOW }))?.status, 'needs_input');
  assert.equal(writes, 1);
  assert.equal(baseline.articlePosts, 0);
});

test('failed durable consumption prevents the initial settings POST', async () => {
  const { context, secrets } = fixture({ account: { source: 'generated', status: 'unknown', registrationAttempts: 1 }, pendingSetup: true });
  const save = context.saveAccount;
  context.saveAccount = async (value, secret) => {
    if (secret && JSON.parse(secret).initialSetupPending === undefined) throw Error('synthetic vault outage');
    await save(value, secret);
  };
  const remote = transport({ notificationsOn: true });
  assert.equal((await prepareMataroaIdentity(context, { fetch: remote.fetch, now: () => NOW }))?.status, 'needs_input');
  assert.equal(remote.settingsPosts, 0);
  assert.equal(remote.articlePosts, 0);
  assert.equal(JSON.parse(secrets.get('account:mataroa-account')!).initialSetupPending, true);
});

test('completed or already-off initial settings cannot override a later newsletter choice', async () => {
  for (const initiallyOn of [true, false]) {
    const { context, secrets } = fixture({ account: { source: 'generated', status: 'unknown', registrationAttempts: 1 }, pendingSetup: true });
    const first = transport({ notificationsOn: initiallyOn });
    const docsFailure: MataroaTransport = (input, init) => new URL(input).pathname === '/api/docs/'
      ? Promise.resolve(response('temporary error', 503)) : first.fetch(input, init);
    assert.equal((await prepareMataroaIdentity(context, { fetch: docsFailure, now: () => NOW }))?.status, 'needs_input');
    assert.equal(first.settingsPosts, initiallyOn ? 1 : 0);
    const saved = JSON.parse(secrets.get('account:mataroa-account')!);
    assert.equal(saved.initialSetupPending, undefined);
    assert.equal(saved.password, PASSWORD);
    assert.equal(saved.token, TOKEN);
    const later = transport({ notificationsOn: true });
    assert.equal((await prepareMataroaIdentity(context, { fetch: later.fetch, now: () => NOW }))?.status, 'needs_input');
    assert.equal(later.settingsPosts, 0);
    assert.equal(later.articlePosts, 0);
  }
});

test('challenge, failed notification readback, durable checkpoint failure, and hidden or wrong link block POST', async () => {
  const generated = fixture({ account: { source: 'generated', status: 'unknown', registrationAttempts: 1 }, pendingSetup: true });
  const challenge = transport({ challenge: '/accounts/edit/' });
  const blocked = await runMataroaTask(generated.context, { fetch: challenge.fetch, now: () => NOW });
  assert.equal(blocked.status, 'needs_input'); assert.equal(challenge.articlePosts, 0);
  const failedReadback = transport({ notificationsOn: true, settingsReadback: false });
  assert.equal((await runMataroaTask(generated.context, { fetch: failedReadback.fetch, now: () => NOW })).status, 'needs_input');
  assert.equal(failedReadback.articlePosts, 0);
  const ordinary = fixture(); ordinary.setFailedCheckpoint('mataroa_publish_submitting');
  const remote = transport();
  assert.equal((await runMataroaTask(ordinary.context, { fetch: remote.fetch, now: () => NOW })).status, 'queued');
  assert.equal(remote.articlePosts, 0);
  const unsafe = fixture();
  const article = mataroaTesting.approvedArticle(unsafe.task, unsafe.context.site);
  unsafe.task.mataroa = { username: USERNAME, contentHash: article.contentHash, publishedDate: '2026-10-07', stage: 'published', slug: SLUG };
  unsafe.task.publicUrl = PUBLIC;
  assert.equal((await verifyMataroaPublication(unsafe.task, TARGET, { fetch: transport({ wrongPage: true }).fetch })).outcome, 'invalid');
  assert.equal(mataroaTesting.renderedArticle(page().replace('class="posts-item-body"', 'class="posts-item-body" style="display:none"'), BODY, TARGET), undefined);
  assert.equal(mataroaTesting.renderedArticle(page(BODY, 'scheduled'), BODY, TARGET, '2026-10-07'), undefined);
});

test('hidden publication byline, date, or ancestor cannot verify a live post', () => {
  assert.equal(mataroaTesting.renderedArticle(page(), BODY, TARGET, '2026-10-07'), '');
  for (const html of [
    page().replace('class="posts-item-byline"', 'class="posts-item-byline" hidden'),
    page().replace('<time ', '<time style="display:none" '),
    page().replace('<article>', '<article aria-hidden="true">'),
    page().replace('<article>', '<article><section style="display:none">').replace('</div><div class="posts-item-body"', '</div></section><div class="posts-item-body"'),
    page().replace('</body>', '<style>.posts-item-byline { display: none }</style></body>'),
  ]) assert.equal(mataroaTesting.renderedArticle(html, BODY, TARGET, '2026-10-07'), undefined);
});

test('Mataroa public checks bind visible title, all references and indexing policy without rewriting receipts', async () => {
  const f=fixture(),article=mataroaTesting.approvedArticle(f.task,f.context.site);
  f.task.mataroa={username:USERNAME,contentHash:article.contentHash,publishedDate:'2026-10-07',stage:'published',slug:SLUG};
  f.task.publicUrl=PUBLIC;
  const original=structuredClone(f.task.mataroa);
  for(const [markup,header] of [[page().replace(TITLE,'Unreviewed title'),''],[page(),'noindex'],
    [page().replace('<html>','<html><head><meta name="robots" content="none"></head>'),''],
    [page().replace('<html>','<html><head><link rel="canonical" href="https://other.example/"></head>'),'']]){
    const result=await verifyMataroaPublication(f.task,TARGET,{fetch:async()=>response(markup,200,{'content-type':'text/html','x-robots-tag':header})});
    assert.equal(result.outcome,'invalid');assert.deepEqual(f.task.mataroa,original);
  }
  const result=await verifyMataroaPublication(f.task,TARGET,{fetch:async()=>response(page(),200,{'content-type':'text/html','x-robots-tag':'nofollow'})});
  assert.equal(result.found,true);assert.equal(result.rel,'nofollow');
});
