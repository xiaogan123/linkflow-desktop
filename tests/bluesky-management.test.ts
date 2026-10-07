import test from 'node:test';
import assert from 'node:assert/strict';
import { connectBluesky } from '../src/main/bluesky-management';
import { Store } from '../src/main/store';
import type { SecretStore } from '../src/shared/types';
import type { BlueskyTransport } from '../src/integrations/bluesky';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const OTHER_DID = 'did:plc:zyxwvutsrqponmlkjihgfedc';
const HANDLE = 'publisher.bsky.social';
const APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
const SECOND_PASSWORD = 'qrst-uvwx-yz12-3456';
const ACCESS = 'synthetic.access.token.for-tests-only';
const REFRESH = 'synthetic.refresh.token.for-tests-only';
const NOW = new Date('2026-10-06T04:05:06.789Z');

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function fixture() {
  const store = new Store(':memory:');
  store.update(state => state.sites.push({
    id: 'site', domain: 'example.com', url: 'https://example.com/', email: 'owner@example.com', name: 'Example Lab',
    description: 'Educational notes.', category: 'content', language: 'zh-CN', monthlyTarget: 2, status: 'ready', createdAt: NOW.toISOString(),
  }));
  const secrets = new Map<string, string>();
  const vault: SecretStore = {
    get: async key => secrets.get(key),
    set: async (key, value) => { secrets.set(key, value); },
    delete: async key => { secrets.delete(key); },
  };
  return { store, secrets, vault };
}

function connectTransport(options: { did?: string; handle?: string; active?: boolean; status?: string } = {}): {
  fetch: BlueskyTransport;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return json({
        accessJwt: ACCESS,
        refreshJwt: REFRESH,
        handle: options.handle ?? HANDLE,
        did: options.did ?? DID,
        active: options.active ?? true,
        ...(options.status ? { status: options.status } : {}),
      });
    },
  };
}

test('connect stores app password and session only in the encrypted account vault and creates no implicit binding', async () => {
  const { store, secrets, vault } = fixture();
  const transport = connectTransport();
  try {
    const connected = await connectBluesky(store, vault, `@${HANDLE.toUpperCase()}`, APP_PASSWORD, {
      fetch: transport.fetch,
      now: () => NOW,
    });
    assert.equal(connected.channelId, 'bluesky');
    assert.equal(connected.username, DID);
    assert.equal(connected.displayName, `@${HANDLE}`);
    assert.equal(connected.email, '');
    assert.equal(connected.credentialKind, 'api_token');
    assert.equal(connected.status, 'registered');
    assert.equal(connected.hasPassword, true);
    const state = store.read();
    assert.equal(state.accounts.length, 1);
    assert.equal(state.accountBindings.length, 0);
    assert.equal(JSON.stringify(state).includes(APP_PASSWORD), false);
    assert.equal(JSON.stringify(connected).includes(ACCESS), false);
    assert.equal(secrets.size, 1);
    const secret = JSON.parse(secrets.get(`account:${connected.id}`)!);
    assert.deepEqual(secret, {
      version: 1,
      appPassword: APP_PASSWORD,
      accessJwt: ACCESS,
      refreshJwt: REFRESH,
      handle: HANDLE,
      did: DID,
    });
    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].url, 'https://bsky.social/xrpc/com.atproto.server.createSession');
    assert.deepEqual(JSON.parse(String(transport.calls[0].init.body)), { identifier: HANDLE, password: APP_PASSWORD });
    assert.equal(transport.calls[0].init.redirect, 'error');
    assert.equal(transport.calls[0].url.includes(APP_PASSWORD), false);
  } finally { store.close(); }
});

test('reconnect updates the same DID but never replaces it with a different DID', async () => {
  const { store, secrets, vault } = fixture();
  try {
    const first = await connectBluesky(store, vault, HANDLE, APP_PASSWORD, { fetch: connectTransport().fetch, now: () => NOW });
    const originalSecret = secrets.get(`account:${first.id}`)!;
    const reconnected = await connectBluesky(store, vault, HANDLE, SECOND_PASSWORD, {
      fetch: connectTransport().fetch,
      now: () => new Date('2026-10-06T05:05:06.789Z'),
    }, first.id);
    assert.equal(reconnected.id, first.id);
    assert.equal(store.read().accounts.length, 1);
    assert.equal(JSON.parse(secrets.get(`account:${first.id}`)!).appPassword, SECOND_PASSWORD);

    await assert.rejects(connectBluesky(store, vault, HANDLE, APP_PASSWORD, {
      fetch: connectTransport({ did: OTHER_DID }).fetch,
      now: () => NOW,
    }, first.id), /different DID|different|DID|不同 DID/);
    assert.equal(store.read().accounts.length, 1);
    assert.equal(store.read().accounts[0].username, DID);
    assert.equal(JSON.parse(secrets.get(`account:${first.id}`)!).appPassword, SECOND_PASSWORD);
    assert.notEqual(secrets.get(`account:${first.id}`), originalSecret);
  } finally { store.close(); }
});

test('main-password-shaped input is rejected before network access with dedicated app-password guidance', async () => {
  const { store, secrets, vault } = fixture();
  let calls = 0;
  try {
    await assert.rejects(connectBluesky(store, vault, HANDLE, 'ordinary-primary-password', {
      fetch: async () => { calls++; return json({}); },
      now: () => NOW,
    }), /应用专用密码/);
    assert.equal(calls, 0);
    assert.equal(store.read().accounts.length, 0);
    assert.equal(secrets.size, 0);
  } finally { store.close(); }
});

test('wrong response handle, unsupported DID method, and inactive status are rejected without saving credentials', async () => {
  for (const remote of [
    connectTransport({ handle: 'other.bsky.social' }),
    connectTransport({ did: 'did:key:z6Mksynthetic' }),
    connectTransport({ active: false, status: 'suspended' }),
  ]) {
    const { store, secrets, vault } = fixture();
    try {
      await assert.rejects(connectBluesky(store, vault, HANDLE, APP_PASSWORD, { fetch: remote.fetch, now: () => NOW }), /Bluesky/);
      assert.equal(store.read().accounts.length, 0);
      assert.equal(secrets.size, 0);
    } finally { store.close(); }
  }
});

test('did:web identities accepted by backup validation can be connected', async () => {
  const { store, vault } = fixture();
  const webDid = 'did:web:publisher.example.com';
  try {
    const connected = await connectBluesky(store, vault, HANDLE, APP_PASSWORD, {
      fetch: connectTransport({ did: webDid }).fetch,
      now: () => NOW,
    });
    assert.equal(connected.username, webDid);
    assert.equal(store.read().accounts[0].username, webDid);
  } finally { store.close(); }
});

test('rejects a session whose total serialized credential exceeds the 16 KiB vault limit', async () => {
  const { store, secrets, vault } = fixture();
  const oversizedAccess = 'a'.repeat(9_000);
  const oversizedRefresh = 'b'.repeat(9_000);
  try {
    await assert.rejects(connectBluesky(store, vault, HANDLE, APP_PASSWORD, {
      fetch: async () => json({
        accessJwt: oversizedAccess,
        refreshJwt: oversizedRefresh,
        handle: HANDLE,
        did: DID,
        active: true,
      }),
      now: () => NOW,
    }), error => {
      const message = String(error);
      assert.equal(message.includes(oversizedAccess), false);
      assert.equal(message.includes(oversizedRefresh), false);
      return /Bluesky/.test(message);
    });
    assert.equal(store.read().accounts.length, 0);
    assert.equal(secrets.size, 0);
  } finally { store.close(); }
});

test('auth and transport failures are sanitized and preserve an existing credential', async () => {
  for (const mode of ['auth', 'network'] as const) {
    const { store, secrets, vault } = fixture();
    try {
      const connected = await connectBluesky(store, vault, HANDLE, APP_PASSWORD, { fetch: connectTransport().fetch, now: () => NOW });
      const before = secrets.get(`account:${connected.id}`)!;
      const fetch: BlueskyTransport = mode === 'auth'
        ? async () => json({ error: 'InvalidRequest', message: `${APP_PASSWORD} ${ACCESS}` }, 400)
        : async () => { throw new Error(`${APP_PASSWORD} ${ACCESS}`); };
      await assert.rejects(connectBluesky(store, vault, HANDLE, SECOND_PASSWORD, { fetch, now: () => NOW }, connected.id), error => {
        const text = String(error);
        assert.equal(text.includes(APP_PASSWORD), false);
        assert.equal(text.includes(SECOND_PASSWORD), false);
        assert.equal(text.includes(ACCESS), false);
        return true;
      });
      assert.equal(secrets.get(`account:${connected.id}`), before);
      assert.equal(store.read().accounts[0].status, 'registered');
    } finally { store.close(); }
  }
});

test('concurrent reconnect calls for one account serialize createSession requests under the account lock', async () => {
  const { store, vault } = fixture();
  try {
    const connected = await connectBluesky(store, vault, HANDLE, APP_PASSWORD, { fetch: connectTransport().fetch, now: () => NOW });
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetch: BlueskyTransport = async () => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await gate;
      active--;
      return json({ accessJwt: `${ACCESS}.new`, refreshJwt: `${REFRESH}.new`, handle: HANDLE, did: DID, active: true });
    };
    const first = connectBluesky(store, vault, HANDLE, SECOND_PASSWORD, { fetch, now: () => NOW }, connected.id);
    const second = connectBluesky(store, vault, HANDLE, SECOND_PASSWORD, { fetch, now: () => NOW }, connected.id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.id, connected.id);
    assert.equal(two.id, connected.id);
    assert.equal(calls, 2);
    assert.equal(maxActive, 1);
    assert.equal(store.read().accounts.length, 1);
  } finally { store.close(); }
});
