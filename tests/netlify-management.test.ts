import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/main/store';
import { NetlifyConnections } from '../src/main/netlify-management';
import type { Account, Task } from '../src/shared/types';

const ACCESS_TOKEN = 'synthetic-netlify-management-token';
const USER_ID = 'fixture-user';
const SITE_ID = 'fixture-site';
const TEAM_ID = 'fixture-team';
const SITE_URL = 'https://fixture-site.netlify.app/';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: SITE_ID,
    name: 'fixture-site',
    account_id: TEAM_ID,
    ssl_url: SITE_URL,
    prevent_non_git_prod_deploys: false,
    password: 'private-project-password',
    notification_email: 'private@example.test',
    ...overrides,
  };
}

function fixture(options: { configured?: boolean; now?: () => number; signal?: AbortSignal } = {}) {
  const store = new Store(':memory:');
  let currentUser = USER_ID;
  let currentProject = project();
  let requestCount = 0;
  let ticketCount = 0;
  let encryptFailure = false;
  let encryptions = 0;
  let uuid = 0;
  const vault = {
    async get(key: string) {
      const cipher = store.getCipher(key);
      return cipher?.startsWith('cipher:') ? Buffer.from(cipher.slice(7), 'base64').toString('utf8') : undefined;
    },
    encryptSecrets(values: Record<string, string>) {
      encryptions++;
      if (encryptFailure) throw new Error(`private encrypt failure ${ACCESS_TOKEN}`);
      return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, `cipher:${Buffer.from(value).toString('base64')}`]));
    },
  };
  const configured = options.configured ?? true;
  const manager = new NetlifyConnections(store, vault, {
    clientId: configured ? 'fixture-public-client' : undefined,
    openExternal: configured ? async () => undefined : undefined,
    authorizeTicket: async () => { ticketCount++; return { accessToken: ACCESS_TOKEN, userId: currentUser }; },
    request: async (input, init) => {
      requestCount++;
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${ACCESS_TOKEN}`);
      const url = new URL(input);
      if (url.pathname === '/api/v1/user') return json({ id: currentUser, email: 'private@example.test' });
      if (url.pathname === '/api/v1/sites') return json([currentProject]);
      if (url.pathname === `/api/v1/sites/${SITE_ID}`) return json(currentProject);
      throw new Error('unexpected synthetic request');
    },
    now: options.now,
    signal: options.signal,
    uuid: () => `fixture-uuid-${++uuid}`,
    sessionTimeoutMs: 100,
  });
  const close = () => { manager.cancel(); store.close(); };
  const credential = (accountId: string) => {
    const cipher = store.getCipher(`account:${accountId}`);
    return cipher ? JSON.parse(Buffer.from(cipher.slice(7), 'base64').toString('utf8')) : undefined;
  };
  return {
    store, vault, manager, close, credential,
    requests: () => requestCount,
    tickets: () => ticketCount,
    encryptions: () => encryptions,
    setUser: (value: string) => { currentUser = value; },
    setProject: (value: Record<string, unknown>) => { currentProject = project(value); },
    failEncryption: () => { encryptFailure = true; },
  };
}

async function authorizeAndConnect(f: ReturnType<typeof fixture>, accountId?: string) {
  const session = await f.manager.authorize();
  return f.manager.connect({
    sessionId: session.sessionId,
    siteId: SITE_ID,
    dedicatedPublicationConfirmed: true,
    accountId,
  });
}

test('main-process session crops credentials and atomically saves one needs-verification project account', async () => {
  const f = fixture();
  try {
    const session = await f.manager.authorize();
    assert.equal(JSON.stringify(session).includes(ACCESS_TOKEN), false);
    assert.equal(JSON.stringify(session).includes(USER_ID), false);
    assert.equal(JSON.stringify(session).includes(TEAM_ID), false);
    assert.deepEqual(session.projects, [{
      id: SITE_ID,
      name: 'fixture-site',
      publicUrl: SITE_URL,
      readAccess: 'confirmed',
      deployPermission: 'unknown',
      publicVisibility: 'unverified',
      nonGitProductionBlocked: false,
    }]);
    assert.equal(f.store.read().accounts.length, 0);
    assert.equal(f.store.allCiphers()['account:fixture-uuid-2'], undefined);

    const account = await f.manager.connect({
      sessionId: session.sessionId,
      siteId: SITE_ID,
      dedicatedPublicationConfirmed: true,
    });
    assert.equal(account.channelId, 'netlify');
    assert.equal(account.username, SITE_ID);
    assert.equal(account.publicationUrl, SITE_URL);
    assert.equal(account.status, 'needs_verification');
    assert.equal(account.credentialKind, 'oauth');
    assert.equal(account.hasPassword, true);
    assert.equal(account.verifiedAt, undefined);
    assert.equal(f.store.read().sites.length, 0);
    assert.equal(f.store.read().accountBindings.length, 0);
    assert.deepEqual(f.credential(account.id), {
      version: 1,
      accessToken: ACCESS_TOKEN,
      userId: USER_ID,
      teamId: TEAM_ID,
      siteId: SITE_ID,
      siteUrl: SITE_URL,
    });
    await assert.rejects(f.manager.connect({
      sessionId: session.sessionId,
      siteId: SITE_ID,
      dedicatedPublicationConfirmed: true,
    }), /过期/);

    const reconnected = await authorizeAndConnect(f, account.id);
    assert.equal(reconnected.id, account.id);
    assert.equal(f.store.read().accounts.length, 1);
    assert.equal(f.requests(), 8);
  } finally { f.close(); }
});

test('missing client configuration fails locally before ticket or API work', async () => {
  const f = fixture({ configured: false });
  try {
    await assert.rejects(f.manager.authorize(), /尚未配置/);
    assert.equal(f.tickets(), 0);
    assert.equal(f.requests(), 0);
  } finally { f.close(); }
});

test('expired, cancelled, unconfirmed, and restricted project sessions cannot save', async () => {
  let clock = 0;
  const expired = fixture({ now: () => clock });
  try {
    const session = await expired.manager.authorize();
    clock = 101;
    await assert.rejects(expired.manager.connect({ sessionId: session.sessionId, siteId: SITE_ID, dedicatedPublicationConfirmed: true }), /过期/);
    assert.equal(expired.store.read().accounts.length, 0);
  } finally { expired.close(); }

  const cancelled = fixture();
  try {
    const session = await cancelled.manager.authorize();
    cancelled.manager.cancel();
    await assert.rejects(cancelled.manager.connect({ sessionId: session.sessionId, siteId: SITE_ID, dedicatedPublicationConfirmed: true }), /过期/);
  } finally { cancelled.close(); }

  const unconfirmed = fixture();
  try {
    let session = await unconfirmed.manager.authorize();
    await assert.rejects(unconfirmed.manager.connect({ sessionId: session.sessionId, siteId: SITE_ID, dedicatedPublicationConfirmed: false }), /专用管理/);
    session = await unconfirmed.manager.authorize();
    unconfirmed.setProject({ prevent_non_git_prod_deploys: true });
    await assert.rejects(unconfirmed.manager.connect({ sessionId: session.sessionId, siteId: SITE_ID, dedicatedPublicationConfirmed: true }), /禁止/);
    assert.equal(unconfirmed.store.read().accounts.length, 0);
  } finally { unconfirmed.close(); }
});

test('recheck rejects changed user, team, site URL, or original saved identity without mutating state', async () => {
  for (const change of ['user', 'team', 'url'] as const) {
    const f = fixture();
    try {
      const session = await f.manager.authorize();
      const before = f.store.read();
      if (change === 'user') f.setUser('different-user');
      if (change === 'team') f.setProject({ account_id: 'different-team' });
      if (change === 'url') f.setProject({ ssl_url: 'https://different-site.netlify.app/' });
      await assert.rejects(f.manager.connect({ sessionId: session.sessionId, siteId: SITE_ID, dedicatedPublicationConfirmed: true }));
      assert.deepEqual(f.store.read(), before);
      assert.deepEqual(f.store.allCiphers(), {});
    } finally { f.close(); }
  }

  const existing = fixture();
  try {
    const account = await authorizeAndConnect(existing);
    const before = existing.store.read();
    const ciphers = existing.store.allCiphers();
    existing.setUser('other-authorized-user');
    const session = await existing.manager.authorize();
    await assert.rejects(existing.manager.connect({
      sessionId: session.sessionId,
      siteId: SITE_ID,
      dedicatedPublicationConfirmed: true,
      accountId: account.id,
    }), /原用户|历史连接/);
    assert.deepEqual(existing.store.read(), before);
    assert.deepEqual(existing.store.allCiphers(), ciphers);
  } finally { existing.close(); }
});

test('same site reuses one account while reconnect preserves existing tasks and bindings', async () => {
  const f = fixture();
  try {
    const first = await authorizeAndConnect(f);
    const stamp = new Date().toISOString();
    const task: Task = {
      id: '11111111-1111-4111-8111-111111111111', siteId: 'local-site', channelId: 'netlify', accountId: first.id,
      sourceDomain: 'fixture-site.netlify.app', status: 'needs_input', createdAt: stamp, updatedAt: stamp,
      scheduledAt: stamp, attempts: 1, message: 'Preserve',
    };
    f.store.update(state => {
      state.tasks.push(task);
      state.accountBindings.push({
        id: '22222222-2222-4222-8222-222222222222', siteId: 'local-site', channelId: 'netlify',
        accountId: first.id, createdAt: stamp, updatedAt: stamp,
      });
    });
    const tasks = f.store.read().tasks;
    const bindings = f.store.read().accountBindings;
    const second = await authorizeAndConnect(f);
    assert.equal(second.id, first.id);
    assert.equal(f.store.read().accounts.length, 1);
    assert.deepEqual(f.store.read().tasks, tasks);
    assert.deepEqual(f.store.read().accountBindings, bindings);
  } finally { f.close(); }
});

test('cancellation and concurrent account deletion cannot revive stale state', async () => {
  const f = fixture();
  try {
    const account = await authorizeAndConnect(f);
    const oldCipher = f.store.getCipher(`account:${account.id}`);
    const session = await f.manager.authorize();
    let resolveDetail: ((response: Response) => void) | undefined;
    const original = (f.manager as unknown as { dependencies: { request: typeof fetch } }).dependencies.request;
    (f.manager as unknown as { dependencies: { request: typeof fetch } }).dependencies.request = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === `/api/v1/sites/${SITE_ID}`) return new Promise(resolve => { resolveDetail = resolve; });
      return original(input, init);
    };
    const operation = f.manager.connect({ sessionId: session.sessionId, siteId: SITE_ID, dedicatedPublicationConfirmed: true, accountId: account.id });
    await new Promise(resolve => setImmediate(resolve));
    f.store.update(state => { state.accounts = state.accounts.filter(item => item.id !== account.id); });
    resolveDetail?.(json(project()));
    await assert.rejects(operation, /删除或变化/);
    assert.equal(f.store.read().accounts.length, 0);
    assert.equal(f.store.getCipher(`account:${account.id}`), oldCipher);
  } finally { f.close(); }

  const cancelled = fixture();
  try {
    const session = await cancelled.manager.authorize();
    let resolveDetail: ((response: Response) => void) | undefined;
    const original = (cancelled.manager as unknown as { dependencies: { request: typeof fetch } }).dependencies.request;
    (cancelled.manager as unknown as { dependencies: { request: typeof fetch } }).dependencies.request = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === `/api/v1/sites/${SITE_ID}`) return new Promise(resolve => { resolveDetail = resolve; });
      return original(input, init);
    };
    const operation = cancelled.manager.connect({ sessionId: session.sessionId, siteId: SITE_ID, dedicatedPublicationConfirmed: true });
    await new Promise(resolve => setImmediate(resolve));
    cancelled.manager.cancel();
    resolveDetail?.(json(project()));
    await assert.rejects(operation, /取消/);
    assert.equal(cancelled.store.read().accounts.length, 0);
    assert.deepEqual(cancelled.store.allCiphers(), {});
  } finally { cancelled.close(); }
});

test('cancel or external abort during vault read blocks API, cipher writes, and parallel connection work', async () => {
  for (const mode of ['cancel', 'external'] as const) {
    const external = new AbortController();
    const f = fixture({ signal: external.signal });
    try {
      const account = await authorizeAndConnect(f);
      const session = await f.manager.authorize();
      const beforeRequests = f.requests();
      const beforeEncryptions = f.encryptions();
      const beforeCipher = f.store.getCipher(`account:${account.id}`);
      const originalGet = f.vault.get.bind(f.vault);
      let release: ((value: string | undefined) => void) | undefined;
      f.vault.get = async key => new Promise(resolve => { release = resolve; });
      const operation = f.manager.connect({
        sessionId: session.sessionId,
        siteId: SITE_ID,
        dedicatedPublicationConfirmed: true,
        accountId: account.id,
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(release);
      await assert.rejects(f.manager.authorize(), /正在进行/);
      await assert.rejects(f.manager.connect({
        sessionId: 'parallel-session', siteId: SITE_ID, dedicatedPublicationConfirmed: true,
      }), /正在进行/);
      if (mode === 'cancel') f.manager.cancel();
      else external.abort();
      release(await originalGet(`account:${account.id}`));
      await assert.rejects(operation, /取消/);
      assert.equal(f.requests(), beforeRequests);
      assert.equal(f.encryptions(), beforeEncryptions);
      assert.equal(f.store.getCipher(`account:${account.id}`), beforeCipher);
      assert.equal(f.store.read().accounts.length, 1);
    } finally { f.close(); }
  }
});

test('vault encryption and SQLite cipher failure leave account state and credentials atomic', async () => {
  const encryption = fixture();
  try {
    const session = await encryption.manager.authorize();
    encryption.failEncryption();
    await assert.rejects(encryption.manager.connect({ sessionId: session.sessionId, siteId: SITE_ID, dedicatedPublicationConfirmed: true }), /状态未更改/);
    assert.equal(encryption.store.read().accounts.length, 0);
    assert.deepEqual(encryption.store.allCiphers(), {});
  } finally { encryption.close(); }

  const persistence = fixture();
  try {
    const session = await persistence.manager.authorize();
    const originalSetCipher = persistence.store.setCipher.bind(persistence.store);
    persistence.store.setCipher = () => { throw new Error(`private sqlite failure ${ACCESS_TOKEN}`); };
    await assert.rejects(persistence.manager.connect({ sessionId: session.sessionId, siteId: SITE_ID, dedicatedPublicationConfirmed: true }), /状态未更改/);
    persistence.store.setCipher = originalSetCipher;
    assert.equal(persistence.store.read().accounts.length, 0);
    assert.deepEqual(persistence.store.allCiphers(), {});
  } finally { persistence.close(); }
});
