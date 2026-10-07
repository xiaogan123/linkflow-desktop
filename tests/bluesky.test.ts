import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blueskyTesting,
  reconcileBlueskyTask,
  runBlueskyTask,
  verifyBlueskyPublication,
  type BlueskyDependencies,
  type BlueskyTaskState,
  type BlueskyTransport,
} from '../src/integrations/bluesky';
import { defaultSettings } from '../src/main/store';
import type { Account, Channel, ExecutionContext, Site, Task } from '../src/shared/types';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const OTHER_DID = 'did:plc:zyxwvutsrqponmlkjihgfedc';
const HANDLE = 'publisher.bsky.social';
const APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
const ACCESS = 'synthetic.access.token.for-tests-only';
const REFRESH = 'synthetic.refresh.token.for-tests-only';
const CID = 'bafyreicidsynthetic123456789';
const NOW = '2026-10-06T04:05:06.789Z';
const TARGET = 'https://example.com/guides/risk-checklist';
const BODY = `风险管理的一个实用方法，是先记录假设、数据时间和失效条件，再比较结果。这份清单提供可复核步骤： ${TARGET}\n\n商业关系披露：该站点可能从合作链接中获得收益，不影响文中风险说明。`;

function json(value: unknown, status = 200, responseUrl?: string): Response {
  const response = new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  if (responseUrl) Object.defineProperty(response, 'url', { configurable: true, value: responseUrl });
  return response;
}

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { accessJwt: ACCESS, refreshJwt: REFRESH, handle: HANDLE, did: DID, active: true, ...overrides };
}

function channel(): Channel {
  return {
    id: 'bluesky', name: 'Bluesky', domain: 'bsky.app', url: 'https://bsky.app/', submitUrl: 'https://bsky.social/',
    categories: ['content'], languages: ['*'], kind: 'community', contentFormat: 'social', emailRequired: false,
    accountRequired: true, articleRequired: true, free: 'yes', freeNote: 'Existing owned account.', automation: 'api',
    quality: 'B', qualityReason: 'Public short-form distribution.', rulesUrl: 'https://bsky.social/about/support/community-guidelines',
    checkedAt: '2026-10-06', notes: 'Dedicated app password.', allowedHosts: ['bsky.social', 'bsky.app', 'public.api.bsky.app'], enabled: true,
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'bluesky-account', channelId: 'bluesky', credentialKind: 'api_token', email: '', username: DID,
    displayName: `@${HANDLE}`, createdAt: NOW, updatedAt: NOW, status: 'registered', hasPassword: true, source: 'imported',
    ...overrides,
  };
}

function review() {
  return {
    status: 'passed' as const,
    reason: 'Independent review passed',
    reasonCode: 'passed' as const,
    checks: {
      factualAccuracy: 'pass' as const,
      authorRelationship: 'pass' as const,
      affiliateDisclosure: 'pass' as const,
      independentValue: 'pass' as const,
      financialSafety: 'pass' as const,
      channelRules: 'pass' as const,
    },
    reviewedAt: NOW,
    evidenceUrls: ['https://bsky.social/about/support/community-guidelines'],
    draftRevision: 1,
    contentHash: 'a'.repeat(64),
    contextHash: 'b'.repeat(64),
  };
}

function storedCredential(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, appPassword: APP_PASSWORD, ...session(), ...overrides });
}

function fixture(options: { controller?: AbortController; existing?: Account | null; mutateCheckpoint?: boolean } = {}) {
  const site: Site = {
    id: 'site', domain: 'example.com', url: 'https://example.com/', email: 'owner@example.com', name: 'Example Lab',
    description: 'Educational research notes.', category: 'finance', language: 'zh-CN', monthlyTarget: 2,
    status: 'ready', createdAt: NOW,
  };
  const task: Task = {
    id: 'task', siteId: site.id, channelId: 'bluesky', accountId: 'bluesky-account', sourceDomain: 'bsky.app', status: 'running',
    createdAt: NOW, scheduledAt: NOW, updatedAt: NOW, attempts: 1, message: '', topicUrl: TARGET,
    draft: { title: 'Metadata title is not published', description: 'Metadata description is not published', body: BODY },
    draftRevision: 1, articleApprovedAt: NOW, articleReview: review(),
  };
  const accounts = options.existing === null ? [] : [structuredClone(options.existing ?? account())];
  const secrets = new Map<string, string>();
  if (accounts[0]?.hasPassword) secrets.set(`account:${accounts[0].id}`, storedCredential());
  const checkpoints: Partial<Task>[] = [];
  const controller = options.controller ?? new AbortController();
  const context: ExecutionContext = {
    site, channel: channel(), task, settings: defaultSettings(), signal: controller.signal,
    secrets: {
      get: async key => secrets.get(key),
      set: async (key, value) => { secrets.set(key, value); },
      delete: async key => { secrets.delete(key); },
    },
    ai: { json: async <T>() => ({} as T) },
    getAccount: () => accounts[0],
    saveAccount: async updated => { accounts[0] = structuredClone(updated); },
    checkpoint: partial => {
      checkpoints.push(structuredClone(partial));
      if (options.mutateCheckpoint !== false) Object.assign(task, structuredClone(partial));
    },
    log: () => undefined,
  };
  return { context, site, task, accounts, secrets, checkpoints, controller };
}

function path(input: string): string {
  return new URL(input).pathname;
}

function expectedRecord(task: Task, createdAt = NOW): Record<string, unknown> {
  return blueskyTesting.approvedPost(task, 'https://example.com/', createdAt, false).record;
}

function stateFor(task: Task, overrides: Partial<BlueskyTaskState> = {}): BlueskyTaskState {
  const record = expectedRecord(task);
  return {
    did: DID,
    rkey: '3aaaaaaaaaaaa',
    recordHash: blueskyTesting.approvedPost(task, 'https://example.com/', NOW, false).recordHash,
    recordCreatedAt: NOW,
    stage: 'creating',
    ...overrides,
  };
}

test('publishes the reviewed body verbatim once, checkpoints immutable intent first, and validates UTF-8 facet bytes', async () => {
  // Controller checkpoints persist to the store but do not mutate the
  // ExecutionContext task snapshot, so this fixture mirrors that behavior.
  const { context, task, checkpoints } = fixture({ mutateCheckpoint: false });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let postedRecord: Record<string, unknown> | undefined;
  let postedRkey = '';
  const fetch: BlueskyTransport = async (url, init) => {
    calls.push({ url, init });
    const endpoint = path(url);
    if (endpoint.endsWith('.refreshSession')) return json(session());
    if (endpoint.endsWith('.createRecord')) {
      assert.equal(checkpoints.at(-1)?.bluesky?.stage, 'creating', 'durable intent must exist before the public write');
      const payload = JSON.parse(String(init.body));
      postedRecord = payload.record;
      postedRkey = payload.rkey;
      return json({ uri: `at://${DID}/app.bsky.feed.post/${postedRkey}`, cid: CID });
    }
    if (endpoint.endsWith('.getRecord')) {
      return json({ uri: `at://${DID}/app.bsky.feed.post/${postedRkey}`, cid: CID, value: postedRecord });
    }
    throw new Error(`unexpected ${endpoint}`);
  };
  const result = await runBlueskyTask(context, {
    fetch, now: () => NOW, randomBytes: () => Uint8Array.from([1, 2]),
  });
  assert.equal(result.status, 'review');
  assert.equal(result.publicUrl, `https://bsky.app/profile/${DID}/post/${postedRkey}`);
  assert.deepEqual(checkpoints.map(item => item.checkpoint), [
    'bluesky_create_submitting', 'bluesky_create_accepted', 'bluesky_published',
  ]);
  assert.equal(checkpoints.at(-1)?.bluesky?.stage, 'published');
  assert.match(postedRkey, /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/);
  assert.equal(postedRecord?.text, BODY);
  assert.equal(JSON.stringify(postedRecord).includes(task.draft!.title), false);
  assert.equal(JSON.stringify(postedRecord).includes(task.draft!.description), false);
  const facets = postedRecord?.facets as Array<{ index: { byteStart: number; byteEnd: number }; features: Array<{ uri: string }> }>;
  const start = Buffer.byteLength(BODY.slice(0, BODY.indexOf(TARGET)), 'utf8');
  assert.deepEqual(facets, [{
    index: { byteStart: start, byteEnd: start + Buffer.byteLength(TARGET, 'utf8') },
    features: [{ $type: 'app.bsky.richtext.facet#link', uri: TARGET }],
  }]);
  const create = calls.find(call => path(call.url).endsWith('.createRecord'))!;
  const createBody = JSON.parse(String(create.init.body));
  assert.equal(createBody.repo, DID);
  assert.equal(createBody.collection, 'app.bsky.feed.post');
  assert.equal(createBody.validate, true);
  assert.ok(calls.every(call => call.url.startsWith('https://bsky.social/xrpc/')));
  assert.ok(calls.every(call => call.init.redirect === 'error' && !call.url.includes(APP_PASSWORD) && !call.url.includes(ACCESS)));
});

test('refresh with a different DID marks the owned account invalid and never writes a record', async () => {
  const { context, accounts } = fixture();
  let creates = 0;
  const result = await runBlueskyTask(context, {
    now: () => NOW,
    fetch: async (url, init) => {
      if (path(url).endsWith('.refreshSession')) return json(session({ did: OTHER_DID }));
      if (path(url).endsWith('.createRecord')) creates++;
      throw new Error(`unexpected ${init.method} ${url}`);
    },
  });
  assert.equal(result.status, 'needs_input');
  assert.equal(accounts[0].status, 'credentials_invalid');
  assert.equal(accounts[0].diagnostic?.code, 'bad_password');
  assert.equal(creates, 0);
});

test('restricted session status is distinguished from transient network failure', async () => {
  const restricted = fixture();
  const restrictedResult = await runBlueskyTask(restricted.context, {
    now: () => NOW,
    fetch: async () => json({ error: 'AccountTakedown', message: `remote ${APP_PASSWORD}` }, 403),
  });
  assert.equal(restrictedResult.status, 'needs_input');
  assert.equal(restricted.accounts[0].status, 'restricted');
  assert.equal(restrictedResult.message.includes(APP_PASSWORD), false);

  const transient = fixture();
  const transientResult = await runBlueskyTask(transient.context, {
    now: () => NOW,
    fetch: async () => { throw new Error(`offline ${ACCESS} ${APP_PASSWORD}`); },
  });
  assert.equal(transientResult.status, 'failed');
  assert.equal(transient.accounts[0].status, 'registered');
  assert.equal(transientResult.message.includes(ACCESS), false);
  assert.equal(transientResult.message.includes(APP_PASSWORD), false);
});

test('expired refresh falls back once to the dedicated app password and requires the same DID', async () => {
  const { context, secrets } = fixture();
  let refreshes = 0;
  let logins = 0;
  let creates = 0;
  const result = await runBlueskyTask(context, {
    now: () => NOW,
    randomBytes: () => Uint8Array.from([2, 3]),
    fetch: async (url, init) => {
      if (path(url).endsWith('.refreshSession')) { refreshes++; return json({ error: 'ExpiredToken' }, 400); }
      if (path(url).endsWith('.createSession')) {
        logins++;
        assert.deepEqual(JSON.parse(String(init.body)), { identifier: HANDLE, password: APP_PASSWORD });
        return json(session({ accessJwt: `${ACCESS}.new`, refreshJwt: `${REFRESH}.new` }));
      }
      if (path(url).endsWith('.createRecord')) {
        creates++;
        const payload = JSON.parse(String(init.body));
        return json({ uri: `at://${DID}/app.bsky.feed.post/${payload.rkey}`, cid: CID });
      }
      if (path(url).endsWith('.getRecord')) {
        const query = new URL(url).searchParams;
        return json({ uri: `at://${DID}/app.bsky.feed.post/${query.get('rkey')}`, cid: CID, value: expectedRecord(context.task) });
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.equal(result.status, 'review');
  assert.equal(refreshes, 1);
  assert.equal(logins, 1);
  assert.equal(creates, 1);
  const saved = secrets.get('account:bluesky-account')!;
  assert.equal(JSON.parse(saved).accessJwt, `${ACCESS}.new`);
  assert.equal(JSON.stringify(result).includes(APP_PASSWORD), false);
});

test('timeout after createRecord begins leaves one immutable rkey and a second run only reconciles', async () => {
  const { context, task } = fixture();
  let posts = 0;
  let reads = 0;
  const fetch: BlueskyTransport = async (url, init) => {
    if (path(url).endsWith('.refreshSession')) return json(session());
    if (path(url).endsWith('.createRecord')) {
      posts++;
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error(`socket timeout ${APP_PASSWORD}`)), { once: true });
      });
    }
    if (path(url).endsWith('.getRecord')) { reads++; return json({ error: 'RecordNotFound' }, 404); }
    throw new Error(`unexpected ${url}`);
  };
  const dependencies: BlueskyDependencies = { fetch, now: () => NOW, timeoutMs: 10, randomBytes: () => Uint8Array.from([3, 4]) };
  const first = await runBlueskyTask(context, dependencies);
  const firstRkey = task.bluesky?.rkey;
  const second = await runBlueskyTask(context, dependencies);
  assert.equal(first.status, 'needs_input');
  assert.equal(first.checkpoint, 'bluesky_create_submitting');
  assert.equal(second.status, 'needs_input');
  assert.equal(task.bluesky?.rkey, firstRkey);
  assert.equal(posts, 1);
  assert.equal(reads, 1);
  assert.equal(JSON.stringify(first).includes(APP_PASSWORD), false);
});

test('pause after a successful response retains URI/CID receipt and never attempts a duplicate POST', async () => {
  const controller = new AbortController();
  const { context, task, checkpoints } = fixture({ controller });
  let posts = 0;
  const result = await runBlueskyTask(context, {
    now: () => NOW,
    randomBytes: () => Uint8Array.from([4, 5]),
    fetch: async (url, init) => {
      if (path(url).endsWith('.refreshSession')) return json(session());
      if (path(url).endsWith('.createRecord')) {
        posts++;
        const payload = JSON.parse(String(init.body));
        controller.abort();
        return json({ uri: `at://${DID}/app.bsky.feed.post/${payload.rkey}`, cid: CID });
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.equal(result.status, 'review');
  assert.equal(result.checkpoint, 'bluesky_create_accepted');
  assert.equal(task.bluesky?.stage, 'creating');
  assert.equal(task.bluesky?.uri, `at://${DID}/app.bsky.feed.post/${task.bluesky.rkey}`);
  assert.equal(task.bluesky?.cid, CID);
  assert.equal(task.publicUrl, undefined, 'accepted checkpoint stores the remote receipt; controller applies the returned URL');
  assert.equal(result.publicUrl, `https://bsky.app/profile/${DID}/post/${task.bluesky?.rkey}`);
  assert.equal(checkpoints[1].publicUrl, undefined);
  assert.deepEqual(checkpoints.map(item => item.checkpoint), ['bluesky_create_submitting', 'bluesky_create_accepted']);
  assert.equal(posts, 1);
});

test('reconciliation rejects wrong full records, treats 404 as unknown, and never posts again', async () => {
  for (const variant of ['wrong-record', 'not-found'] as const) {
    const { context, task } = fixture();
    task.bluesky = stateFor(task);
    task.submittedAt = NOW;
    task.checkpoint = 'bluesky_create_submitting';
    let gets = 0;
    let posts = 0;
    const fetch: BlueskyTransport = async (url, init) => {
      if (path(url).endsWith('.createRecord')) posts++;
      if (!path(url).endsWith('.getRecord')) throw new Error(`unexpected ${init.method} ${url}`);
      gets++;
      if (variant === 'not-found') return json({ error: 'RecordNotFound' }, 404);
      return json({
        uri: `at://${DID}/app.bsky.feed.post/${task.bluesky!.rkey}`,
        cid: CID,
        value: { ...expectedRecord(task), text: 'tampered remote record' },
      });
    };
    assert.deepEqual(await reconcileBlueskyTask(context, { fetch }), { status: 'unknown' });
    const result = await runBlueskyTask(context, { fetch });
    assert.equal(result.status, 'needs_input');
    assert.equal(posts, 0);
    assert.equal(gets, 2);
  }
});

test('record hash mismatch blocks reconciliation before any network request', async () => {
  const { context, task } = fixture();
  task.bluesky = stateFor(task, { recordHash: 'f'.repeat(64) });
  let calls = 0;
  assert.deepEqual(await reconcileBlueskyTask(context, { fetch: async () => { calls++; return json({}); } }), { status: 'unknown' });
  assert.equal(calls, 0);
});

test('draft validation enforces grapheme/byte limits, one exact topic URL, disclosure, and current review revision', () => {
  const { task } = fixture();
  const approved = blueskyTesting.approvedPost(task, 'https://example.com/', NOW, true);
  assert.equal(approved.text, BODY);
  assert.equal(blueskyTesting.graphemeLength('e\u0301'), 1);

  task.articleReview = undefined;
  assert.equal(blueskyTesting.approvedPost(task, 'https://example.com/', NOW, true).text, BODY);
  task.articleApprovedAt = undefined;
  assert.throws(() => blueskyTesting.approvedPost(task, 'https://example.com/', NOW, true), /人工审批/);
  task.articleApprovedAt = NOW;
  task.articleReview = review();

  task.draft!.body = `${'a'.repeat(301)} ${TARGET}\n商业关系披露：可能获得收益`;
  assert.throws(() => blueskyTesting.approvedPost(task, 'https://example.com/', NOW, true), /300/);
  task.draft!.body = `${'\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66'.repeat(300)} ${TARGET}\n商业关系披露：可能获得收益`;
  assert.throws(() => blueskyTesting.approvedPost(task, 'https://example.com/', NOW, true), /3000/);
  task.draft!.body = BODY.replace('商业关系披露：', '说明：');
  assert.throws(() => blueskyTesting.approvedPost(task, 'https://example.com/', NOW, true), /商业关系披露/);
  task.draft!.body = `${BODY} https://example.com/other`;
  assert.throws(() => blueskyTesting.approvedPost(task, 'https://example.com/', NOW, true), /一个相关|且只能/);
  task.draft!.body = BODY.replace(TARGET, 'https://other.example/guide');
  task.topicUrl = 'https://other.example/guide';
  assert.throws(() => blueskyTesting.approvedPost(task, 'https://example.com/', NOW, true), /当前网站/);
  task.draft!.body = BODY;
  task.topicUrl = TARGET;
  task.draftRevision = 2;
  assert.throws(() => blueskyTesting.approvedPost(task, 'https://example.com/', NOW, true), /重新核对/);
});

test('manual approval still rejects extra HTTP links, Markdown links, and HTML before publication', () => {
  for (const invalidBody of [
    `${BODY}\nhttp://other.example.com/redirect`,
    BODY.replace(TARGET, `[source](${TARGET})`),
    BODY.replace('风险管理', '<strong>风险管理</strong>'),
  ]) {
    const { task } = fixture();
    task.articleReview = undefined;
    task.articleApprovedAt = NOW;
    task.draft!.body = invalidBody;
    assert.throws(
      () => blueskyTesting.approvedPost(task, 'https://example.com/', NOW, true),
      /Bluesky 短文格式无效/,
    );
  }
});

test('public verification requires exact PDS record and matching anonymous AppView hydration', async () => {
  const { task } = fixture();
  const state = stateFor(task, {
    stage: 'published',
    uri: `at://${DID}/app.bsky.feed.post/3aaaaaaaaaaaa`,
    cid: CID,
  });
  task.bluesky = state;
  task.publicUrl = `https://bsky.app/profile/${DID}/post/${state.rkey}`;
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const result = await verifyBlueskyPublication(task, 'https://example.com/', undefined, {
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      if (url.startsWith('https://bsky.social/')) {
        return json({ uri: state.uri, cid: CID, value: expectedRecord(task) });
      }
      if (url.startsWith('https://public.api.bsky.app/')) {
        return json({ posts: [{ uri: state.uri, cid: CID, author: { did: DID, handle: HANDLE }, record: expectedRecord(task), indexedAt: NOW }] });
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.equal(result.found, true);
  assert.equal(result.outcome, 'found');
  assert.equal(result.rel, 'unknown');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => !('authorization' in call.headers)));

  const notVisible = await verifyBlueskyPublication(task, 'https://example.com/', undefined, {
    fetch: async url => url.startsWith('https://bsky.social/')
      ? json({ uri: state.uri, cid: CID, value: expectedRecord(task) })
      : json({ posts: [] }),
  });
  assert.equal(notVisible.found, false);
  assert.equal(notVisible.outcome, 'unreachable');

  task.publicUrl = `https://bsky.app/profile/${OTHER_DID}/post/${state.rkey}`;
  let wrongUrlCalls = 0;
  const wrongUrl = await verifyBlueskyPublication(task, 'https://example.com/', undefined, {
    fetch: async () => { wrongUrlCalls++; return json({}); },
  });
  assert.equal(wrongUrl.found, false);
  assert.equal(wrongUrl.outcome, 'invalid');
  assert.equal(wrongUrlCalls, 0);
});

test('remote error bodies and transport exceptions never leak session or app-password secrets', async () => {
  for (const fetch of [
    async () => json({ error: 'InvalidToken', message: `${ACCESS} ${REFRESH} ${APP_PASSWORD}` }, 401),
    async () => { throw new Error(`${ACCESS} ${REFRESH} ${APP_PASSWORD}`); },
  ] satisfies BlueskyTransport[]) {
    const { context, accounts } = fixture();
    const result = await runBlueskyTask(context, { fetch, now: () => NOW });
    const output = JSON.stringify({ result, account: accounts[0] });
    assert.equal(output.includes(ACCESS), false);
    assert.equal(output.includes(REFRESH), false);
    assert.equal(output.includes(APP_PASSWORD), false);
  }
});
