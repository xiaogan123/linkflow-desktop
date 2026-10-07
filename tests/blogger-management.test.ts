import test from 'node:test';
import assert from 'node:assert/strict';
import { bindBloggerBlog, bindBloggerBlogs, connectBlogger, disconnectBlogger, listBloggerBlogs, reconnectBlogger } from '../src/main/blogger-management';
import { BLOGGER_SCOPE, type BloggerLoopback, type BloggerTransport } from '../src/integrations/blogger';
import { Store } from '../src/main/store';
import type { Account, SecretStore, Task } from '../src/shared/types';

const USER_ID = '9876543210987654321';
const OTHER_USER_ID = '1111111111111111111';
const BLOG_ID = '1234567890123456789';
const BLOG_URL = 'https://example-owner.blogspot.com/';
const ACCESS_TOKEN = 'synthetic-access-token-that-is-not-real';
const REFRESH_TOKEN = 'synthetic-refresh-token-that-is-not-real';
const NOW = new Date('2026-10-04T12:00:00.000Z');
const SITE_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_SITE_ID = '12121212-1212-4212-8212-121212121212';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function fixture() {
  const store = new Store(':memory:');
  store.update(state => state.sites.push({
    id: SITE_ID, domain: 'example.com', url: 'https://example.com/', email: 'owner@example.com', name: 'Example Brand',
    description: 'Example description', category: 'content', language: 'en', monthlyTarget: 2, status: 'ready', createdAt: NOW.toISOString(),
  }));
  const secrets = new Map<string, string>();
  const vault: SecretStore = {
    get: async key => secrets.get(key),
    set: async (key, value) => { secrets.set(key, value); },
    delete: async key => { secrets.delete(key); },
  };
  return { store, secrets, vault };
}

function installedClient() {
  return JSON.stringify({ installed: {
    client_id: 'client.apps.googleusercontent.com', client_secret: 'synthetic-client-secret',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token', redirect_uris: ['http://localhost'],
  } });
}

function oauthRequest(userId = USER_ID): { request: BloggerTransport; opened: string[]; closes: { count: number } } {
  const opened: string[] = [];
  const closes = { count: 0 };
  const loopback: BloggerLoopback = {
    redirectUri: 'http://127.0.0.1:45678',
    wait: async () => {
      const auth = new URL(opened[opened.length - 1]);
      return new URL(`http://127.0.0.1:45678/?code=synthetic-code&state=${encodeURIComponent(auth.searchParams.get('state')!)}`);
    },
    close: async () => { closes.count++; },
  };
  const request: BloggerTransport = async (input, init) => {
    const url = new URL(input);
    if (url.toString() === 'https://oauth2.googleapis.com/token') {
      return json({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600, token_type: 'Bearer', scope: BLOGGER_SCOPE });
    }
    if (url.pathname === '/blogger/v3/users/self') return json({ kind: 'blogger#user', id: userId, displayName: userId === USER_ID ? 'Example Publisher' : 'Other Publisher' });
    if (url.pathname === '/blogger/v3/users/self/blogs') return json({ kind: 'blogger#blogList', items: [
      { kind: 'blogger#blog', id: BLOG_ID, name: 'Example Owner Blog', url: BLOG_URL },
    ] });
    throw new Error(`unexpected ${init.method} ${url}`);
  };
  Object.assign(request, { loopback });
  return { request, opened, closes };
}

function connectDeps(flow = oauthRequest()) {
  const loopback = (flow.request as BloggerTransport & { loopback?: BloggerLoopback }).loopback!;
  return {
    request: flow.request,
    now: () => NOW,
    openExternal: async (url: string) => { flow.opened.push(url); },
    createLoopback: async () => loopback,
  };
}

function savedCredential(userId = USER_ID) {
  return JSON.stringify({
    version: 1, clientId: 'client.apps.googleusercontent.com', clientSecret: 'synthetic-client-secret',
    refreshToken: REFRESH_TOKEN, accessToken: ACCESS_TOKEN, expiresAt: '2026-10-04T13:00:00.000Z', scope: BLOGGER_SCOPE, userId,
  });
}

function savedAccount(id: string, userId = USER_ID): Account {
  return {
    id, channelId: 'blogger', credentialKind: 'oauth', email: '', displayName: 'Example Publisher', username: userId,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), status: 'registered', hasPassword: true, source: 'imported',
  };
}

function secondSite(status: 'ready' | 'paused' = 'ready') {
  return {
    id: SECOND_SITE_ID, domain: 'second.example', url: 'https://second.example/', email: 'owner@second.example', name: 'Second Brand',
    description: 'Second description', category: 'content' as const, language: 'en', monthlyTarget: 2, status, createdAt: NOW.toISOString(),
  };
}

function managementRequest(options: { admin?: boolean } = {}): BloggerTransport {
  return async (input, init) => {
    const url = new URL(input);
    assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${ACCESS_TOKEN}`);
    if (url.pathname === '/blogger/v3/users/self') return json({ kind: 'blogger#user', id: USER_ID, displayName: 'Example Publisher' });
    if (url.pathname === '/blogger/v3/users/self/blogs') return json({ kind: 'blogger#blogList', items: [
      { kind: 'blogger#blog', id: BLOG_ID, name: 'Example Owner Blog', url: BLOG_URL },
    ] });
    if (url.pathname === `/blogger/v3/users/self/blogs/${BLOG_ID}`) return json({
      kind: 'blogger#blogUserInfo',
      blog: { kind: 'blogger#blog', id: BLOG_ID, name: 'Example Owner Blog', url: BLOG_URL },
      blog_user_info: { kind: 'blogger#blogPerUserInfo', userId: USER_ID, blogId: BLOG_ID, hasAdminAccess: options.admin ?? true },
    });
    throw new Error(`unexpected ${init.method} ${url}`);
  };
}

test('connect saves one encrypted account secret, returns metadata only, and reuses the same Blogger identity', async () => {
  const { store, secrets, vault } = fixture();
  try {
    const firstFlow = oauthRequest();
    const first = await connectBlogger(store, vault, installedClient(), connectDeps(firstFlow));
    assert.equal(first.account.username, USER_ID);
    assert.equal(first.account.email, '');
    assert.equal(first.account.displayName, 'Example Publisher');
    assert.equal(first.account.credentialKind, 'oauth');
    assert.deepEqual(first.blogs, [{ id: BLOG_ID, name: 'Example Owner Blog', url: BLOG_URL }]);
    assert.equal(store.read().accounts.length, 1);
    assert.equal(JSON.stringify(store.read()).includes(ACCESS_TOKEN), false);
    assert.equal(JSON.stringify(first).includes(ACCESS_TOKEN), false);
    assert.equal(secrets.size, 1);
    assert.equal(firstFlow.closes.count, 1);

    const secondFlow = oauthRequest();
    const second = await connectBlogger(store, vault, installedClient(), connectDeps(secondFlow));
    assert.equal(second.account.id, first.account.id);
    assert.equal(store.read().accounts.length, 1);
    assert.equal(secrets.has(`account:${first.account.id}`), true);
  } finally { store.close(); }
});

test('reconnect cannot replace an existing account with a different Google Blogger subject', async () => {
  const { store, secrets, vault } = fixture();
  try {
    const first = await connectBlogger(store, vault, installedClient(), connectDeps(oauthRequest()));
    const other = oauthRequest(OTHER_USER_ID);
    await assert.rejects(connectBlogger(store, vault, installedClient(), { ...connectDeps(other), existingAccountId: first.account.id }), /不同 Google Blogger 身份/);
    assert.equal(store.read().accounts.length, 1);
    assert.equal(store.read().accounts[0].username, USER_ID);
    assert.equal(JSON.parse(secrets.get(`account:${first.account.id}`)!).userId, USER_ID);
  } finally { store.close(); }
});

test('reconnect reuses only the encrypted desktop client for the same Blogger subject and returns no OAuth material', async () => {
  const { store, secrets, vault } = fixture();
  const accountId = '20202020-2020-4020-8020-202020202020';
  store.update(state => state.accounts.push(savedAccount(accountId)));
  secrets.set(`account:${accountId}`, savedCredential());
  const flow = oauthRequest();
  try {
    const result = await reconnectBlogger(store, vault, accountId, connectDeps(flow));
    assert.equal(result.account.id, accountId);
    assert.equal(result.account.username, USER_ID);
    assert.equal(new URL(flow.opened[0]).searchParams.get('client_id'), 'client.apps.googleusercontent.com');
    assert.equal(JSON.stringify(result).includes(ACCESS_TOKEN), false);
    assert.equal(JSON.stringify(result).includes(REFRESH_TOKEN), false);
    assert.equal(JSON.stringify(result).includes('synthetic-client-secret'), false);
    assert.equal(JSON.parse(secrets.get(`account:${accountId}`)!).userId, USER_ID);
    assert.equal(flow.closes.count, 1);
  } finally { store.close(); }
});

test('reconnect fails clearly before opening a browser when the encrypted desktop client is missing or invalid', async () => {
  const { store, secrets, vault } = fixture();
  const accountId = '21212121-2121-4121-8121-212121212121';
  store.update(state => state.accounts.push(savedAccount(accountId)));
  const missing = oauthRequest();
  try {
    await assert.rejects(reconnectBlogger(store, vault, accountId, connectDeps(missing)), /重新导入桌面客户端 JSON/);
    assert.equal(missing.opened.length, 0);
    secrets.set(`account:${accountId}`, '{"version":1,"clientId":"broken"}');
    const invalid = oauthRequest();
    await assert.rejects(reconnectBlogger(store, vault, accountId, connectDeps(invalid)), /重新导入桌面客户端 JSON/);
    assert.equal(invalid.opened.length, 0);
  } finally { store.close(); }
});

test('list validates the stored subject and returns no OAuth material', async () => {
  const { store, secrets, vault } = fixture();
  const accountId = '22222222-2222-4222-8222-222222222222';
  store.update(state => state.accounts.push(savedAccount(accountId)));
  secrets.set(`account:${accountId}`, savedCredential());
  try {
    const blogs = await listBloggerBlogs(store, vault, accountId, { request: managementRequest(), now: () => NOW });
    assert.deepEqual(blogs, [{ id: BLOG_ID, name: 'Example Owner Blog', url: BLOG_URL }]);
    assert.equal(JSON.stringify(blogs).includes(ACCESS_TOKEN), false);
    assert.equal(store.read().accounts[0].status, 'registered');
  } finally { store.close(); }
});

test('bind rechecks list, exact blog identity and admin write access before saving blog and account binding', async () => {
  const { store, secrets, vault } = fixture();
  const accountId = '33333333-3333-4333-8333-333333333333';
  store.update(state => state.accounts.push(savedAccount(accountId)));
  secrets.set(`account:${accountId}`, savedCredential());
  try {
    const blog = await bindBloggerBlog(store, vault, SITE_ID, accountId, BLOG_ID, { request: managementRequest(), now: () => NOW });
    assert.equal(blog.id, BLOG_ID);
    const state = store.read();
    assert.deepEqual(state.sites[0].blogger, { blogId: BLOG_ID, url: BLOG_URL });
    assert.equal(state.accountBindings.length, 1);
    assert.equal(state.accountBindings[0].accountId, accountId);

    const deniedStore = fixture();
    try {
      deniedStore.store.update(state => state.accounts.push(savedAccount(accountId)));
      deniedStore.secrets.set(`account:${accountId}`, savedCredential());
      await assert.rejects(bindBloggerBlog(deniedStore.store, deniedStore.vault, SITE_ID, accountId, BLOG_ID, { request: managementRequest({ admin: false }), now: () => NOW }), /管理权限/);
      assert.equal(deniedStore.store.read().sites[0].blogger, undefined);
      assert.equal(deniedStore.store.read().accountBindings.length, 0);
    } finally { deniedStore.store.close(); }
  } finally { store.close(); }
});

test('batch binding verifies the remote blog once and commits every selected site together', async () => {
  const { store, secrets, vault } = fixture();
  const accountId = '31313131-3131-4131-8131-313131313131';
  store.update(state => { state.sites.push(secondSite()); state.accounts.push(savedAccount(accountId)); });
  secrets.set(`account:${accountId}`, savedCredential());
  let remoteVerifications = 0;
  const request: BloggerTransport = async (...args) => {
    if (new URL(args[0]).pathname === `/blogger/v3/users/self/blogs/${BLOG_ID}`) remoteVerifications++;
    return managementRequest()(...args);
  };
  try {
    const result = await bindBloggerBlogs(store, vault, [SITE_ID, SECOND_SITE_ID], accountId, BLOG_ID, { request, now: () => NOW });
    assert.equal(result.id, BLOG_ID);
    assert.equal(remoteVerifications, 1);
    const state = store.read();
    assert.deepEqual(state.sites.map(site => site.blogger), [
      { blogId: BLOG_ID, url: BLOG_URL },
      { blogId: BLOG_ID, url: BLOG_URL },
    ]);
    assert.deepEqual(state.accountBindings.map(binding => binding.siteId).sort(), [SECOND_SITE_ID, SITE_ID].sort());
    assert.equal(state.accountBindings.every(binding => binding.accountId === accountId), true);
  } finally { store.close(); }
});

test('batch binding validates every remote-intent guard before network access or any binding write', async () => {
  const { store, secrets, vault } = fixture();
  const accountId = '32323232-3232-4232-8232-323232323232';
  const blocked: Task = {
    id: 'blocked-second', siteId: SECOND_SITE_ID, channelId: 'blogger', accountId, sourceDomain: 'old.blogspot.com', status: 'needs_input',
    createdAt: NOW.toISOString(), scheduledAt: NOW.toISOString(), updatedAt: NOW.toISOString(), attempts: 1, message: 'Unknown result',
    submittedAt: NOW.toISOString(), checkpoint: 'blogger_insert_submitting',
    blogger: { blogId: '9999999999999999999', operationId: '33333333-3333-4333-8333-333333333333', contentHash: 'd'.repeat(64), stage: 'inserting' },
  };
  store.update(state => { state.sites.push(secondSite()); state.accounts.push(savedAccount(accountId)); state.tasks.push(blocked); });
  secrets.set(`account:${accountId}`, savedCredential());
  let requests = 0;
  try {
    await assert.rejects(bindBloggerBlogs(store, vault, [SITE_ID, SECOND_SITE_ID], accountId, BLOG_ID, {
      request: async (...args) => { requests++; return managementRequest()(...args); }, now: () => NOW,
    }), /second\.example.*待处理/);
    assert.equal(requests, 0);
    assert.equal(store.read().sites.every(site => site.blogger === undefined), true);
    assert.equal(store.read().accountBindings.length, 0);
  } finally { store.close(); }
});

test('batch binding rolls back all selected binding writes when one site changes during remote verification', async () => {
  const { store, secrets, vault } = fixture();
  const accountId = '34343434-3434-4434-8434-343434343434';
  store.update(state => { state.sites.push(secondSite()); state.accounts.push(savedAccount(accountId)); });
  secrets.set(`account:${accountId}`, savedCredential());
  let removed = false;
  const request: BloggerTransport = async (...args) => {
    if (!removed && new URL(args[0]).pathname === `/blogger/v3/users/self/blogs/${BLOG_ID}`) {
      removed = true;
      store.update(state => { state.sites = state.sites.filter(site => site.id !== SECOND_SITE_ID); });
    }
    return managementRequest()(...args);
  };
  try {
    await assert.rejects(bindBloggerBlogs(store, vault, [SITE_ID, SECOND_SITE_ID], accountId, BLOG_ID, { request, now: () => NOW }), /绑定期间发生变化/);
    const state = store.read();
    assert.equal(state.sites.find(site => site.id === SITE_ID)?.blogger, undefined);
    assert.equal(state.accountBindings.length, 0);
  } finally { store.close(); }
});

test('batch binding preserves the site pause and terminal work while retaining drafts, history and cumulative cost', async () => {
  const { store, secrets, vault } = fixture();
  const accountId = '35353535-3535-4535-8535-353535353535';
  const draft = { title: 'Preserved', description: 'Preserved description', body: 'Preserved body with enough useful detail.' };
  const paused: Task = {
    id: 'paused-work', siteId: SECOND_SITE_ID, channelId: 'blogger', sourceDomain: 'blogspot.com', status: 'needs_input', checkpoint: 'account_handoff',
    createdAt: NOW.toISOString(), scheduledAt: '2026-10-09T12:00:00.000Z', updatedAt: NOW.toISOString(), attempts: 2, message: 'Waiting', draft,
    history: [{ at: NOW.toISOString(), status: 'needs_input', message: 'Waiting' }], cost: { aiCalls: 4, inputTokens: 70 },
  };
  const budget: Task = {
    ...structuredClone(paused), id: 'budget-stop', siteId: SITE_ID, status: 'failed', checkpoint: 'topic_recovery_budget', message: 'Budget stopped', recoveryEligible: false,
  };
  const skipped: Task = { ...structuredClone(paused), id: 'skipped-stop', siteId: SITE_ID, status: 'skipped', message: 'Skipped explicitly' };
  const expired: Task = { ...structuredClone(paused), id: 'expired-stop', siteId: SITE_ID, status: 'expired', message: 'Expired explicitly' };
  store.update(state => { state.sites.push(secondSite('paused')); state.accounts.push(savedAccount(accountId)); state.tasks.push(paused, budget, skipped, expired); });
  secrets.set(`account:${accountId}`, savedCredential());
  try {
    await bindBloggerBlogs(store, vault, [SITE_ID, SECOND_SITE_ID], accountId, BLOG_ID, { request: managementRequest(), now: () => NOW });
    const state = store.read();
    assert.equal(state.sites.find(site => site.id === SECOND_SITE_ID)?.status, 'paused');
    for (const id of ['paused-work', 'budget-stop', 'skipped-stop', 'expired-stop']) {
      const task = state.tasks.find(item => item.id === id)!;
      assert.deepEqual(task.draft, draft);
      assert.deepEqual(task.cost, { aiCalls: 4, inputTokens: 70 });
      assert.deepEqual(task.history, [{ at: NOW.toISOString(), status: 'needs_input', message: 'Waiting' }]);
      assert.equal(task.accountId, accountId);
      assert.equal(task.sourceDomain, 'example-owner.blogspot.com');
    }
    assert.equal(state.tasks.find(task => task.id === 'paused-work')?.status, 'queued');
    assert.equal(state.tasks.find(task => task.id === 'paused-work')?.checkpoint, 'article_review');
    assert.equal(state.tasks.find(task => task.id === 'budget-stop')?.status, 'failed');
    assert.equal(state.tasks.find(task => task.id === 'budget-stop')?.checkpoint, 'topic_recovery_budget');
    assert.equal(state.tasks.find(task => task.id === 'skipped-stop')?.status, 'skipped');
    assert.equal(state.tasks.find(task => task.id === 'expired-stop')?.status, 'expired');
  } finally { store.close(); }
});

test('binding changes are blocked while a Blogger task has unresolved remote intent', async () => {
  const { store, secrets, vault } = fixture();
  const accountId = '44444444-4444-4444-8444-444444444444';
  const task: Task = {
    id: 'task', siteId: SITE_ID, channelId: 'blogger', accountId, sourceDomain: 'example-owner.blogspot.com', status: 'needs_input',
    createdAt: NOW.toISOString(), scheduledAt: NOW.toISOString(), updatedAt: NOW.toISOString(), attempts: 0, message: '',
    submittedAt: NOW.toISOString(), checkpoint: 'blogger_insert_submitting',
    blogger: { blogId: '9999999999999999999', operationId: '99999999-9999-4999-8999-999999999999', contentHash: 'a'.repeat(64), stage: 'inserting' },
  };
  store.update(state => { state.accounts.push(savedAccount(accountId)); state.tasks.push(task); });
  secrets.set(`account:${accountId}`, savedCredential());
  try {
    let requests = 0;
    await assert.rejects(bindBloggerBlog(store, vault, SITE_ID, accountId, BLOG_ID, { request: async (...args) => { requests++; return managementRequest()(...args); }, now: () => NOW }), /待处理/);
    assert.equal(requests, 0);
    assert.equal(store.read().sites[0].blogger, undefined);
  } finally { store.close(); }
});

test('first binding adopts safe legacy handoff tasks, preserves work, and never revives skipped tasks', async () => {
  const { store, secrets, vault } = fixture();
  const accountId = '49494949-4949-4494-8494-494949494949';
  const draft = { title: 'Existing useful guide', description: 'Existing description', body: 'Existing body retained across the binding transition.' };
  const review = {
    status: 'passed' as const, reason: 'Old destination review', reviewedAt: NOW.toISOString(), evidenceUrls: [], draftRevision: 2,
    contentHash: 'a'.repeat(64), contextHash: 'b'.repeat(64),
  };
  const legacy: Task = {
    id: 'legacy', siteId: SITE_ID, channelId: 'blogger', sourceDomain: 'blogspot.com', status: 'needs_input', checkpoint: 'account_handoff',
    createdAt: NOW.toISOString(), scheduledAt: '2026-10-05T12:00:00.000Z', updatedAt: NOW.toISOString(), attempts: 1, message: 'Connect an account',
    draft, draftRevision: 2, articleApprovedAt: NOW.toISOString(), articleReview: review, cost: { aiCalls: 3, inputTokens: 50 },
  };
  const skipped: Task = { ...structuredClone(legacy), id: 'skipped', status: 'skipped', message: 'Explicitly skipped' };
  store.update(state => { state.accounts.push(savedAccount(accountId)); state.tasks.push(legacy, skipped); });
  secrets.set(`account:${accountId}`, savedCredential());
  try {
    await bindBloggerBlog(store, vault, SITE_ID, accountId, BLOG_ID, { request: managementRequest(), now: () => NOW });
    const state = store.read();
    assert.equal(state.tasks.length, 2);
    const adopted = state.tasks.find(task => task.id === 'legacy')!;
    assert.equal(adopted.accountId, accountId);
    assert.equal(adopted.sourceDomain, 'example-owner.blogspot.com');
    assert.equal(adopted.status, 'queued');
    assert.equal(adopted.checkpoint, 'article_review');
    assert.equal(adopted.scheduledAt, NOW.toISOString());
    assert.equal(adopted.articleApprovedAt, undefined);
    assert.equal(adopted.articleReview, undefined);
    assert.deepEqual(adopted.draft, draft);
    assert.deepEqual(adopted.cost, { aiCalls: 3, inputTokens: 50 });
    const retained = state.tasks.find(task => task.id === 'skipped')!;
    assert.equal(retained.status, 'skipped');
    assert.equal(retained.accountId, accountId);
    assert.equal(retained.sourceDomain, 'example-owner.blogspot.com');
    assert.equal(retained.articleApprovedAt, NOW.toISOString());
    assert.deepEqual(retained.articleReview, review);
  } finally { store.close(); }
});

test('reconnecting the same identity to the recorded blog restores reconciliation without rewriting remote intent', async () => {
  const { store, secrets, vault } = fixture();
  const accountId = '48484848-4848-4484-8484-484848484848';
  const remoteIntent: Task = {
    id: 'uncertain', siteId: SITE_ID, channelId: 'blogger', accountId, sourceDomain: 'example-owner.blogspot.com', status: 'needs_input',
    createdAt: NOW.toISOString(), scheduledAt: NOW.toISOString(), updatedAt: NOW.toISOString(), attempts: 1, message: 'Unknown insert result',
    submittedAt: NOW.toISOString(), checkpoint: 'blogger_insert_submitting',
    blogger: { blogId: BLOG_ID, operationId: '47474747-4747-4474-8474-474747474747', contentHash: 'c'.repeat(64), stage: 'inserting' },
  };
  store.update(state => { state.accounts.push(savedAccount(accountId)); state.tasks.push(remoteIntent); });
  secrets.set(`account:${accountId}`, savedCredential());
  try {
    await bindBloggerBlog(store, vault, SITE_ID, accountId, BLOG_ID, { request: managementRequest(), now: () => NOW });
    const state = store.read();
    assert.deepEqual(state.sites[0].blogger, { blogId: BLOG_ID, url: BLOG_URL });
    assert.equal(state.accountBindings[0].accountId, accountId);
    assert.deepEqual(state.tasks[0], remoteIntent);
  } finally { store.close(); }
});

test('disconnect revokes with a body, deletes only the encrypted secret, and preserves account and historical task ownership', async () => {
  const { store, secrets, vault } = fixture();
  const accountId = '55555555-5555-4555-8555-555555555555';
  const task: Task = {
    id: 'task', siteId: SITE_ID, channelId: 'blogger', accountId, sourceDomain: 'example-owner.blogspot.com', status: 'needs_input',
    createdAt: NOW.toISOString(), scheduledAt: NOW.toISOString(), updatedAt: NOW.toISOString(), attempts: 1, message: '',
    submittedAt: NOW.toISOString(),
    blogger: { blogId: BLOG_ID, operationId: '66666666-6666-4666-8666-666666666666', contentHash: 'a'.repeat(64), stage: 'inserting' },
  };
  store.update(state => {
    state.accounts.push(savedAccount(accountId));
    state.sites[0].blogger = { blogId: BLOG_ID, url: BLOG_URL };
    state.accountBindings.push({ id: '77777777-7777-4777-8777-777777777777', siteId: SITE_ID, channelId: 'blogger', accountId, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    state.tasks.push(task);
  });
  secrets.set(`account:${accountId}`, savedCredential());
  let revokeUrl = '';
  let revokeBody = '';
  try {
    await disconnectBlogger(store, vault, accountId, {
      now: () => NOW,
      request: async (input, init) => {
        revokeUrl = input; revokeBody = String(init.body);
        return new Response('', { status: 200 });
      },
    });
    assert.equal(revokeUrl, 'https://oauth2.googleapis.com/revoke');
    assert.equal(revokeUrl.includes(REFRESH_TOKEN), false);
    assert.equal(new URLSearchParams(revokeBody).get('token'), REFRESH_TOKEN);
    assert.equal(secrets.has(`account:${accountId}`), false);
    const state = store.read();
    assert.equal(state.accounts.length, 1);
    assert.equal(state.accounts[0].id, accountId);
    assert.equal(state.accounts[0].hasPassword, false);
    assert.equal(state.accounts[0].status, 'credentials_invalid');
    assert.equal(state.tasks[0].accountId, accountId);
    assert.equal(state.tasks[0].blogger?.blogId, BLOG_ID);
    assert.equal(state.accountBindings.length, 0);
    assert.equal(state.sites[0].blogger, undefined);
  } finally { store.close(); }
});

test('disconnect keeps local credential and state when revocation has an uncertain network failure', async () => {
  const { store, secrets, vault } = fixture();
  const accountId = '88888888-8888-4888-8888-888888888888';
  store.update(state => state.accounts.push(savedAccount(accountId)));
  secrets.set(`account:${accountId}`, savedCredential());
  try {
    await assert.rejects(disconnectBlogger(store, vault, accountId, { request: async () => { throw new Error('offline'); }, now: () => NOW }), /无法连接/);
    assert.equal(secrets.has(`account:${accountId}`), true);
    assert.equal(store.read().accounts[0].status, 'registered');
  } finally { store.close(); }
});
