import test from 'node:test';
import assert from 'node:assert/strict';
import { PrivateKey } from 'hive-tx';
import { marked } from 'marked';
import { connectHiveAccount, reconcileHiveTask, runHiveTask, verifyHivePublication,
  type HiveComment, type HiveDependencies } from '../src/integrations/hive';
import { defaultSettings } from '../src/main/store';
import type { Account, Channel, ExecutionContext, Site, Task } from '../src/shared/types';

const NOW = '2026-10-07T03:04:05.000Z';
const CHAIN_SECONDS = Date.parse(NOW) / 1000;
const TARGET = 'https://example.com/research/operations';
const AUTHOR = 'examplewriter';
const POSTING_KEY = PrivateKey.fromSeed('hive-test-posting-only').toString();
const POSTING_PUB = PrivateKey.fromString(POSTING_KEY).createPublic().toString();
const ACTIVE_PUB = PrivateKey.fromSeed('hive-test-active-only').createPublic().toString();
const OWNER_PUB = PrivateKey.fromSeed('hive-test-owner-only').createPublic().toString();
const MEMO_PUB = PrivateKey.fromSeed('hive-test-memo-only').createPublic().toString();
const BODY = [
  `A reproducible operational review records inputs, source dates, and failure conditions. The maintained evidence is available at [the operator's research page](${TARGET}). This article is published by the operator of Example Lab and the commercial relationship is disclosed. It documents what was verified and where evidence remains incomplete.`,
  'Readers should compare the current eligibility terms, technical limitations, and counterexamples before acting. Example Lab may receive a referral commission from some services, but that relationship does not change the method, source checks, or uncertainties listed here. The review explains how to repeat each step without relying on a promotional claim.',
].join('\n\n');

function chainAccount(overrides: Record<string, unknown> = {}) {
  return {
    name: AUTHOR,
    posting: { weight_threshold: 1, key_auths: [[POSTING_PUB, 1]], account_auths: [] },
    active: { weight_threshold: 1, key_auths: [[ACTIVE_PUB, 1]], account_auths: [] },
    owner: { weight_threshold: 1, key_auths: [[OWNER_PUB, 1]], account_auths: [] },
    memo_key: MEMO_PUB,
    last_root_post: '2026-10-06T22:00:00',
    ...overrides,
  };
}

function channel(): Channel {
  return {
    id: 'hive', name: 'Hive', domain: 'hive.blog', url: 'https://hive.blog/', submitUrl: 'https://hive.blog/',
    categories: ['content', 'finance'], languages: ['*'], kind: 'article', emailRequired: false,
    accountRequired: true, articleRequired: true, free: 'yes', freeNote: 'RC required', automation: 'api',
    quality: 'C', qualityReason: 'Owned original article', rulesUrl: 'https://hive.blog/tos.html',
    checkedAt: '2026-10-07', notes: '', allowedHosts: ['hive.blog'], enabled: true,
  };
}

function fixture(overrides: { task?: Partial<Task>; account?: Partial<Account>; site?: Partial<Site> } = {}) {
  const site: Site = {
    id: 'site', domain: 'example.com', url: 'https://example.com/', email: '', name: 'Example Lab',
    description: 'Operations research.', category: 'finance', language: 'en', monthlyTarget: 2,
    status: 'ready', createdAt: NOW, ...overrides.site,
  };
  const task: Task = {
    id: 'task', siteId: site.id, channelId: 'hive', accountId: 'hive-account', sourceDomain: 'hive.blog',
    status: 'running', createdAt: NOW, scheduledAt: NOW, updatedAt: NOW, attempts: 1, message: '',
    topicUrl: TARGET, draft: { title: 'A reproducible operational review', description: 'Source-backed review', body: BODY },
    draftRevision: 1, articleApprovedAt: NOW, ...overrides.task,
  };
  let account: Account = {
    id: 'hive-account', channelId: 'hive', credentialKind: 'api_token', email: '', username: AUTHOR,
    publicationUrl: `https://hive.blog/@${AUTHOR}`, createdAt: NOW, status: 'registered',
    hasPassword: true, source: 'imported', ...overrides.account,
  };
  const secrets = new Map<string, string>([[`account:${account.id}`, JSON.stringify({ version: 1, username: AUTHOR, postingKey: POSTING_KEY })]]);
  const checkpoints: Partial<Task>[] = [];
  const context: ExecutionContext = {
    site, task, channel: channel(), settings: defaultSettings(), signal: new AbortController().signal,
    secrets: {
      get: async key => secrets.get(key),
      set: async (key, value) => { secrets.set(key, value); },
      delete: async key => { secrets.delete(key); },
    },
    ai: { json: async <T>() => ({} as T) },
    getAccount: () => account,
    saveAccount: async next => { account = next; },
    checkpoint: partial => { checkpoints.push(structuredClone(partial)); Object.assign(task, structuredClone(partial)); },
    log: () => undefined,
  };
  return { context, task, site, secrets, checkpoints };
}

function rc(available = '1000000000000000', max = '1000000000000000', lastUpdate: unknown = CHAIN_SECONDS) {
  return { rc_accounts: [{ account: AUTHOR, rc_manabar: { current_mana: available, last_update_time: lastUpdate }, max_rc: max }] };
}

function stats() { return { count: 100, avg_cost_rc: 1_000_000_000 }; }

function renderedBody() {
  const rendered = marked.parse(BODY, { async: false });
  assert.equal(typeof rendered, 'string');
  return rendered.replace(`<a href="${TARGET}">`, `<a href="${TARGET}" rel="nofollow ugc">`);
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

function missingPost(author: string, permlink: string) {
  const missing = `Post ${author}/${permlink} does not exist`;
  return { code: -32602, message: `Assert Exception:${missing}`,
    data: { name: 'assert_exception', message: 'Assert Exception', extension: { assertion_expression: missing } } };
}

function rpcFor(getContent: () => unknown, account = chainAccount(), rcValue = rc()): NonNullable<HiveDependencies['rpc']> {
  return async (method, params, _signal, node) => {
    if (method === 'condenser_api.get_accounts') {
      assert.deepEqual(params, [[AUTHOR]]);
      return [account];
    }
    if (method === 'rc_api.find_rc_accounts') {
      assert.deepEqual(params, { accounts: [AUTHOR] });
      return rcValue;
    }
    if (method === 'rc_api.get_rc_operation_stats') {
      assert.deepEqual(params, { operation: 'comment_operation' });
      return stats();
    }
    if (method === 'condenser_api.get_dynamic_global_properties') {
      assert.deepEqual(params, []);
      return { head_block_number: 1234567, head_block_id: '0000000001020304050607080910111213141516', time: '2026-10-07T03:04:05' };
    }
    if (method === 'condenser_api.get_content') {
      assert.ok(node === 'https://api.hive.blog' || node === 'https://api.openhive.network');
      const content = getContent();
      if (content === null) throw missingPost((params as string[])[0], (params as string[])[1]);
      return content;
    }
    throw new Error(`unexpected RPC method: ${method}`);
  };
}

test('connection stores only a valid sufficient Posting Key in the vault and rejects higher-privilege or mismatched keys', async () => {
  const { secrets, context } = fixture();
  const saved: string[] = [];
  const vault = { ...context.secrets, set: async (key: string, value: string) => { saved.push(key); secrets.set(key, value); } };
  const result = await connectHiveAccount(vault, 'another-account', `@${AUTHOR}`, POSTING_KEY,
    { rpc: rpcFor(() => ({})) });
  assert.deepEqual(result, { username: AUTHOR, url: `https://hive.blog/@${AUTHOR}` });
  assert.deepEqual(saved, ['account:another-account']);
  assert.equal(JSON.stringify(result).includes(POSTING_KEY), false);
  assert.equal(JSON.parse(secrets.get('account:another-account')!).postingKey, POSTING_KEY);

  for (const wrong of [PrivateKey.fromSeed('hive-test-active-only').toString(),
    PrivateKey.fromSeed('hive-test-owner-only').toString(), PrivateKey.fromSeed('hive-test-memo-only').toString(),
    PrivateKey.fromSeed('unrelated-key').toString(), 'not-a-wif-master-password']) {
    await assert.rejects(connectHiveAccount(vault, 'rejected', AUTHOR, wrong, { rpc: rpcFor(() => ({})) }));
  }
  await assert.rejects(connectHiveAccount(vault, 'rejected', AUTHOR, POSTING_KEY, {
    rpc: rpcFor(() => ({}), chainAccount({ posting: { weight_threshold: 2, key_auths: [[POSTING_PUB, 1]], account_auths: [] } })),
  }));
  await assert.rejects(connectHiveAccount(vault, 'rejected', AUTHOR, POSTING_KEY, {
    rpc: rpcFor(() => ({}), chainAccount({ active: { weight_threshold: 1, key_auths: [[POSTING_PUB, 1]], account_auths: [] } })),
  }));
  assert.equal(saved.includes('account:rejected'), false);
});

test('approved full article persists intent before one root comment broadcast and waits for visible anonymous HTML', async () => {
  const { context, task, checkpoints } = fixture();
  let post: HiveComment | undefined;
  const methods: string[] = [];
  const deps: HiveDependencies = {
    now: () => NOW,
    rpc: async (method, params, signal, node) => { methods.push(method); return rpcFor(() => post ?? null)(method, params, signal, node); },
    broadcastComment: async (comment, key) => {
      assert.equal(key, POSTING_KEY);
      assert.equal(checkpoints.at(-1)?.checkpoint, 'hive_publish_submitting');
      assert.equal(checkpoints.at(-1)?.hive?.stage, 'submitting');
      assert.equal(checkpoints.at(-1)?.submittedAt, NOW);
      assert.equal(comment.parent_author, '');
      assert.equal(comment.parent_permlink, 'general');
      assert.deepEqual(Object.keys(comment).sort(), [
        'author', 'body', 'json_metadata', 'parent_author', 'parent_permlink', 'permlink', 'title',
      ]);
      assert.equal(comment.author, AUTHOR);
      assert.equal(comment.title, task.draft!.title);
      assert.equal(comment.body, BODY);
      assert.deepEqual(JSON.parse(comment.json_metadata).tags, ['general']);
      post = comment;
      return { id: 'a'.repeat(40) };
    },
    fetch: async (url, init) => {
      assert.equal(init.method, 'GET');
      assert.equal(url, `https://hive.blog/general/@${AUTHOR}/${post!.permlink}`);
      return htmlResponse(`<html><body><article><div class="MarkdownViewer">${renderedBody()}</div></article></body></html>`);
    },
  };
  const result = await runHiveTask(context, deps);
  assert.equal(result.status, 'review');
  assert.equal(result.checkpoint, 'hive_published');
  assert.equal(result.publicUrl, `https://hive.blog/general/@${AUTHOR}/${post!.permlink}`);
  assert.deepEqual(checkpoints.map(item => item.checkpoint).filter(Boolean), ['hive_publish_submitting', 'hive_published']);
  assert.equal(task.hive?.transactionId, 'a'.repeat(40));
  assert.equal(methods.filter(method => method === 'condenser_api.get_content').length, 4);
  const verified = await verifyHivePublication(task, context.site.url, undefined, deps);
  assert.equal(verified.found, true);
  assert.equal(verified.rel, 'nofollow ugc');
  assert.equal(verified.outcome, 'found');
});

test('production signer sends one signed comment transaction to the fixed RPC with no credential or retry', async () => {
  const { context, task, checkpoints } = fixture();
  let writes = 0;
  let posted: HiveComment | undefined;
  const deps: HiveDependencies = {
    now: () => NOW,
    rpc: rpcFor(() => posted ?? null),
    fetch: async (url, init) => {
      writes++;
      assert.equal(url, 'https://api.hive.blog');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      assert.equal(checkpoints[0]?.checkpoint, 'hive_publish_submitting');
      const body = String(init.body);
      assert.equal(body.includes(POSTING_KEY), false);
      const envelope = JSON.parse(body);
      assert.equal(envelope.method, 'condenser_api.broadcast_transaction');
      assert.equal(envelope.params.length, 1);
      const transaction = envelope.params[0];
      assert.equal(transaction.ref_block_num, 1234567 & 0xffff);
      assert.equal(transaction.ref_block_prefix, 0x04030201);
      assert.equal(transaction.expiration, '2026-10-07T03:05:05');
      assert.equal(transaction.operations.length, 1);
      assert.equal(transaction.operations[0][0], 'comment');
      assert.equal(transaction.signatures.length, 1);
      assert.match(transaction.signatures[0], /^[0-9a-f]{130}$/);
      posted = transaction.operations[0][1];
      assert.equal(posted?.parent_author, '');
      assert.equal(posted?.parent_permlink, 'general');
      assert.equal(posted?.author, AUTHOR);
      assert.equal(posted?.title, task.draft?.title);
      assert.equal(posted?.body, BODY);
      const response = new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), {
        headers: { 'content-type': 'application/json' },
      });
      Object.defineProperty(response, 'url', { value: 'https://api.hive.blog/' });
      return response;
    },
  };
  const result = await runHiveTask(context, deps);
  assert.equal(result.checkpoint, 'hive_published');
  assert.equal(task.hive?.stage, 'published');
  assert.match(task.hive?.transactionId ?? '', /^[0-9a-f]{40}$/);
  await runHiveTask(context, deps);
  assert.equal(writes, 1);
});

test('both official RPC missing-post error envelopes must match the queried author and permlink before first broadcast', async () => {
  const { context, task } = fixture();
  const calls: Array<{ node: string; method: string }> = [];
  let posted: HiveComment | undefined;
  const result = await runHiveTask(context, {
    now: () => NOW,
    fetch: async (node, init) => {
      const request = JSON.parse(String(init.body));
      calls.push({ node, method: request.method });
      assert.ok(node === 'https://api.hive.blog' || node === 'https://api.openhive.network');
      assert.equal(init.redirect, 'error');
      let response: Record<string, unknown> = { jsonrpc: '2.0', id: 1 };
      if (request.method === 'condenser_api.get_accounts') response.result = [chainAccount()];
      else if (request.method === 'condenser_api.get_dynamic_global_properties') {
        response.result = { head_block_number: 1234567, head_block_id: '0000000001020304050607080910111213141516', time: '2026-10-07T03:04:05' };
      } else if (request.method === 'rc_api.find_rc_accounts') response.result = rc();
      else if (request.method === 'rc_api.get_rc_operation_stats') response.result = stats();
      else if (request.method === 'condenser_api.get_content') {
        assert.deepEqual(request.params[0], AUTHOR);
        if (posted) response.result = posted;
        else response.error = missingPost(request.params[0], request.params[1]);
      } else if (request.method === 'condenser_api.broadcast_transaction') {
        assert.equal(node, 'https://api.hive.blog');
        assert.equal(request.params[0].operations.length, 1);
        assert.equal(request.params[0].operations[0][0], 'comment');
        posted = request.params[0].operations[0][1];
        response.result = null;
      } else assert.fail(`unexpected RPC ${request.method}`);
      return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(result.checkpoint, 'hive_published');
  assert.equal(task.hive?.stage, 'published');
  assert.equal(calls.filter(call => call.method === 'condenser_api.broadcast_transaction').length, 1);
  assert.deepEqual(calls.filter(call => call.method === 'condenser_api.get_content').map(call => call.node),
    ['https://api.hive.blog', 'https://api.openhive.network', 'https://api.hive.blog', 'https://api.openhive.network']);
});

test('malformed content and mismatched missing-post errors never authorize a first write', async () => {
  for (const malformed of [null, [], 42, {}, { author: AUTHOR, permlink: '' }]) {
    const { context, task } = fixture();
    let writes = 0;
    const base = rpcFor(() => null);
    const result = await runHiveTask(context, {
      now: () => NOW,
      rpc: async (method, params, signal, node) => method === 'condenser_api.get_content'
        ? malformed : base(method, params, signal, node),
      broadcastComment: async () => { writes++; return {}; },
    });
    assert.equal(result.status, 'queued');
    assert.equal(task.hive, undefined);
    assert.equal(writes, 0);
  }
  for (const wrong of [
    (author: string, permlink: string) => missingPost('otherauthor', permlink),
    (author: string, permlink: string) => missingPost(author, `${permlink}-other`),
    (author: string, permlink: string) => ({ ...missingPost(author, permlink), code: -32000 }),
    (author: string, permlink: string) => ({ ...missingPost(author, permlink), data: undefined }),
  ]) {
    const { context, task } = fixture();
    let writes = 0;
    const base = rpcFor(() => null);
    const result = await runHiveTask(context, {
      now: () => NOW,
      rpc: async (method, params, signal, node) => {
        if (method === 'condenser_api.get_content' && node === 'https://api.openhive.network') {
          throw wrong((params as string[])[0], (params as string[])[1]);
        }
        return base(method, params, signal, node);
      },
      broadcastComment: async () => { writes++; return {}; },
    });
    assert.equal(result.status, 'queued');
    assert.equal(task.hive, undefined);
    assert.equal(writes, 0);
  }
});

test('production transport timeout after its one POST remains an uncertain intent on restart', async () => {
  const { context, task } = fixture();
  let writes = 0;
  const deps: HiveDependencies = {
    now: () => NOW,
    rpc: rpcFor(() => null),
    fetch: async (url, init) => {
      writes++;
      assert.equal(url, 'https://api.hive.blog');
      assert.equal(init.method, 'POST');
      throw new Error('synthetic transport timeout after send');
    },
  };
  assert.equal((await runHiveTask(context, deps)).checkpoint, 'hive_publish_submitting');
  assert.equal(task.hive?.stage, 'submitting');
  assert.equal((await runHiveTask(context, deps)).checkpoint, 'hive_publish_submitting');
  assert.equal(writes, 1);
});

test('unavailable transaction header or cancellation before intent stays retryable without any POST', async () => {
  for (const cancelled of [false, true]) {
    const { context, task } = fixture();
    const controller = new AbortController();
    context.signal = controller.signal;
    let writes = 0;
    const baseRpc = rpcFor(() => null);
    const result = await runHiveTask(context, {
      now: () => NOW,
      rpc: async (method, params, signal) => {
        if (method === 'condenser_api.get_dynamic_global_properties') {
          if (cancelled) controller.abort();
          else throw new Error('synthetic read outage');
        }
        return baseRpc(method, params, signal);
      },
      fetch: async () => { writes++; throw new Error('must not broadcast'); },
    });
    assert.equal(result.status, 'queued');
    assert.equal(task.hive, undefined);
    assert.equal(writes, 0);
  }
});

test('unknown broadcast response and restart never trigger another write', async () => {
  const { context, task, checkpoints } = fixture();
  let broadcasts = 0;
  let visible = false;
  let post: HiveComment | undefined;
  const deps: HiveDependencies = {
    now: () => NOW,
    rpc: rpcFor(() => visible ? post : null),
    broadcastComment: async comment => { broadcasts++; post = comment; throw new Error('synthetic uncertain network result'); },
  };
  const first = await runHiveTask(context, deps);
  assert.equal(first.status, 'review');
  assert.equal(first.checkpoint, 'hive_publish_submitting');
  assert.equal(task.hive?.stage, 'submitting');
  assert.equal(checkpoints[0].checkpoint, 'hive_publish_submitting');
  const second = await runHiveTask(context, deps);
  assert.equal(second.status, 'review');
  assert.equal(broadcasts, 1);
  assert.deepEqual(await reconcileHiveTask(context, deps), { status: 'unknown' });
  visible = true;
  const recovered = await runHiveTask(context, deps);
  assert.equal(recovered.status, 'review');
  assert.equal(recovered.checkpoint, 'hive_published');
  assert.equal(task.hive?.stage, 'published');
  assert.equal(broadcasts, 1);
  visible = false;
  const checked = await verifyHivePublication(task, context.site.url, undefined, deps);
  assert.equal(checked.found, false);
  assert.equal(checked.outcome, 'unreachable');
});

test('chain mismatch, invisible href, and Hive.blog 403 never count as a live link', async () => {
  const { context, task } = fixture();
  let post: HiveComment | undefined;
  const publishDeps: HiveDependencies = {
    now: () => NOW,
    rpc: rpcFor(() => post ?? null),
    broadcastComment: async comment => { post = comment; return { id: 'b'.repeat(40) }; },
  };
  await runHiveTask(context, publishDeps);
  assert.equal(task.hive?.stage, 'published');
  const mismatches = [
    { ...post, author: 'otherauthor' },
    { ...post, permlink: 'other-permlink' },
    { ...post, body: BODY.slice(1) },
    { ...post, json_metadata: '{}' },
  ];
  for (const mismatch of mismatches) {
    const checked = await verifyHivePublication(task, context.site.url, undefined, {
      rpc: rpcFor(() => mismatch), fetch: async () => { throw new Error('must not fetch'); },
    });
    assert.equal(checked.found, false);
    assert.equal(checked.outcome, 'invalid');
  }
  const hidden = await verifyHivePublication(task, context.site.url, undefined, {
    rpc: rpcFor(() => post), fetch: async () => htmlResponse(`<article><div class="MarkdownViewer">${renderedBody().replace(
      `rel="nofollow ugc"`, `style="display:none" rel="nofollow ugc"`,
    )}</div></article>`),
  });
  assert.equal(hidden.found, false);
  const forbidden = await verifyHivePublication(task, context.site.url, undefined, {
    rpc: rpcFor(() => post), fetch: async () => htmlResponse('Forbidden', 403),
  });
  assert.equal(forbidden.found, false);
  assert.equal(forbidden.outcome, 'unreachable');
});

test('five-minute root-post cadence and low RC schedule bounded read-only retries without charging a new AI call', async () => {
  const recent = fixture();
  let writes = 0;
  const cadence = await runHiveTask(recent.context, {
    now: () => NOW,
    rpc: rpcFor(() => ({}), chainAccount({ last_root_post: '2026-10-07T03:02:00' })),
    broadcastComment: async () => { writes++; return {}; },
  });
  assert.equal(cadence.status, 'queued');
  assert.ok(recent.task.scheduledAt > NOW);
  assert.equal(recent.task.hive, undefined);

  const low = fixture();
  const beforeCost = structuredClone(low.task.cost);
  const result = await runHiveTask(low.context, {
    now: () => NOW,
    rpc: rpcFor(() => ({}), chainAccount(), rc('1', '1000000000000000')),
    broadcastComment: async () => { writes++; return {}; },
  });
  assert.equal(result.status, 'queued');
  assert.ok(low.task.scheduledAt > NOW);
  assert.deepEqual(low.task.cost, beforeCost);
  assert.equal(low.task.hive, undefined);
  assert.equal(writes, 0);
});

test('RC regenerates from its last update using chain time and rejects invalid or future meters', async () => {
  const recovered = fixture();
  let post: HiveComment | undefined;
  let writes = 0;
  const result = await runHiveTask(recovered.context, {
    now: () => NOW,
    rpc: rpcFor(() => post ?? null, chainAccount(), rc('0', '1000000000000000', CHAIN_SECONDS - 6 * 86400)),
    broadcastComment: async comment => { writes++; post = comment; return {}; },
  });
  assert.equal(result.checkpoint, 'hive_published');
  assert.equal(writes, 1);
  for (const bad of [
    rc('-1', '1000000000000000'),
    rc('0', '1000000000000000', CHAIN_SECONDS + 60),
    rc('0', '1000000000000000', 'not-a-timestamp'),
  ]) {
    const { context, task } = fixture();
    let attempts = 0;
    const checked = await runHiveTask(context, {
      now: () => NOW,
      rpc: rpcFor(() => null, chainAccount(), bad),
      broadcastComment: async () => { attempts++; return {}; },
    });
    assert.equal(checked.status, 'queued');
    assert.equal(task.hive, undefined);
    assert.equal(attempts, 0);
  }
});

test('remote posting authority changes and vault write failure cannot publish or replace an existing secret', async () => {
  const { context, task, secrets } = fixture();
  let writes = 0;
  const changed = await runHiveTask(context, {
    rpc: rpcFor(() => ({}), chainAccount({ posting: { weight_threshold: 1, key_auths: [[ACTIVE_PUB, 1]], account_auths: [] } })),
    broadcastComment: async () => { writes++; return {}; },
  });
  assert.equal(changed.status, 'needs_input');
  assert.equal(task.hive, undefined);
  assert.equal(writes, 0);
  const original = secrets.get('account:hive-account');
  await assert.rejects(connectHiveAccount({
    get: context.secrets.get,
    set: async () => { throw new Error('synthetic vault failure'); },
    delete: context.secrets.delete,
  }, 'hive-account', AUTHOR, POSTING_KEY, { rpc: rpcFor(() => ({})) }));
  assert.equal(secrets.get('account:hive-account'), original);
});

test('tampered local intent remains blocked and an aborted fresh task does not create intent', async () => {
  const { context, task } = fixture();
  let writes = 0;
  const aborted = new AbortController();
  aborted.abort();
  context.signal = aborted.signal;
  const noWrite = await runHiveTask(context, {
    rpc: rpcFor(() => ({})), broadcastComment: async () => { writes++; return {}; },
  });
  assert.equal(noWrite.status, 'queued');
  assert.equal(task.hive, undefined);
  assert.equal(writes, 0);
  context.signal = new AbortController().signal;
  task.hive = { author: AUTHOR, permlink: 'tampered-permlink', contentHash: 'a'.repeat(64), stage: 'submitting' };
  const blocked = await runHiveTask(context, {
    rpc: rpcFor(() => ({})), broadcastComment: async () => { writes++; return {}; },
  });
  assert.equal(blocked.status, 'needs_input');
  assert.equal(writes, 0);
});

test('partial body, metadata-only link, wrong response URL, and redirect cannot verify anonymous publication', async () => {
  const { context, task } = fixture();
  let post: HiveComment | undefined;
  await runHiveTask(context, {
    now: () => NOW, rpc: rpcFor(() => post ?? null),
    broadcastComment: async comment => { post = comment; return { id: 'c'.repeat(40) }; },
  });
  assert.equal(task.hive?.stage, 'published');
  const bodies = [
    `<article><div class="MarkdownViewer">${renderedBody().slice(0, 180)}</div></article>`,
    `<html><head><meta property="og:url" content="${TARGET}"><link href="${TARGET}"></head><body><article><div class="MarkdownViewer">${renderedBody().replace(`<a href="${TARGET}" rel="nofollow ugc">`, '<span>')}</div></article></body></html>`,
  ];
  for (const body of bodies) {
    const checked = await verifyHivePublication(task, context.site.url, undefined, {
      rpc: rpcFor(() => post), fetch: async () => htmlResponse(body),
    });
    assert.equal(checked.found, false);
  }
  const expected = `https://hive.blog/general/@${AUTHOR}/${post!.permlink}`;
  const redirected = htmlResponse(`<article><div class="MarkdownViewer">${renderedBody()}</div></article>`);
  Object.defineProperty(redirected, 'url', { value: 'https://other.example/post' });
  assert.equal((await verifyHivePublication(task, context.site.url, undefined, {
    rpc: rpcFor(() => post), fetch: async (url, init) => {
      assert.equal(url, expected);
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'error');
      return redirected;
    },
  })).found, false);
});

test('RC budget beyond account capacity requires input without broadcasting', async () => {
  const { context, task } = fixture();
  let writes = 0;
  const result = await runHiveTask(context, {
    now: () => NOW,
    rpc: rpcFor(() => ({}), chainAccount(), rc('1000000000', '1000000000')),
    broadcastComment: async () => { writes++; return {}; },
  });
  assert.equal(result.status, 'needs_input');
  assert.match(result.message, /RC/);
  assert.equal(task.hive, undefined);
  assert.equal(writes, 0);
});

test('UTF-8 title and signed transaction byte limits reject invalid drafts before durable intent', async () => {
  const multiByte = fixture({ task: { draft: { title: '汉'.repeat(100), description: 'Source-backed review', body: BODY } } });
  let writes = 0;
  const invalidTitle = await runHiveTask(multiByte.context, {
    now: () => NOW, rpc: rpcFor(() => null),
    broadcastComment: async () => { writes++; return {}; },
  });
  assert.equal(invalidTitle.status, 'needs_input');
  assert.equal(multiByte.task.hive, undefined);
  assert.equal(writes, 0);

  const nearBodyLimit = BODY + 'x'.repeat(65536 - Buffer.byteLength(BODY, 'utf8'));
  assert.equal(Buffer.byteLength(nearBodyLimit, 'utf8'), 65536);
  const tooLarge = fixture({ task: { draft: { title: 'A reproducible operational review', description: 'Source-backed review', body: nearBodyLimit } } });
  const invalidTransaction = await runHiveTask(tooLarge.context, {
    now: () => NOW, rpc: rpcFor(() => null),
    broadcastComment: async () => { writes++; return {}; },
  });
  assert.equal(invalidTransaction.status, 'needs_input');
  assert.match(invalidTransaction.message, /64 KB/);
  assert.equal(tooLarge.task.hive, undefined);
  assert.equal(writes, 0);
});

test('exact 65536-byte signed comment boundary succeeds while one extra byte never creates intent', async () => {
  const wireBytes = (transaction: { operations: Array<['comment', HiveComment]>; signatures: string[] }) => {
    const comment = transaction.operations[0][1];
    const varuint = (value: number) => { let count = 1; while (value >= 128) { value = Math.floor(value / 128); count++; } return count; };
    return 2 + 4 + 4 + 1 + 1 + 1 + 1 + transaction.signatures[0].length / 2
      + [comment.parent_author, comment.parent_permlink, comment.author, comment.permlink,
        comment.title, comment.body, comment.json_metadata].reduce((size, value) => {
        const bytes = Buffer.byteLength(value, 'utf8');
        return size + varuint(bytes) + bytes;
      }, 0);
  };
  async function signedFor(body: string) {
    const { context, task } = fixture({ task: { draft: {
      title: 'A reproducible operational review', description: 'Source-backed review', body,
    } } });
    let transaction: { operations: Array<['comment', HiveComment]>; signatures: string[] } | undefined;
    let post: HiveComment | undefined;
    const result = await runHiveTask(context, {
      now: () => NOW, rpc: rpcFor(() => post ?? null),
      fetch: async (_url, init) => {
        transaction = JSON.parse(String(init.body)).params[0];
        post = transaction!.operations[0][1];
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }));
      },
    });
    assert.equal(result.checkpoint, 'hive_published');
    assert.equal(task.hive?.stage, 'published');
    assert.ok(transaction);
    return transaction!;
  }
  const initialBytes = 65_000;
  const initialBody = BODY + 'x'.repeat(initialBytes - Buffer.byteLength(BODY, 'utf8'));
  const initial = await signedFor(initialBody);
  const maxBodyBytes = initialBytes + (65_536 - wireBytes(initial));
  const maxBody = BODY + 'x'.repeat(maxBodyBytes - Buffer.byteLength(BODY, 'utf8'));
  const boundary = await signedFor(maxBody);
  assert.equal(wireBytes(boundary), 65_536);
  const overflow = fixture({ task: { draft: {
    title: 'A reproducible operational review', description: 'Source-backed review', body: `${maxBody}x`,
  } } });
  let writes = 0;
  const rejected = await runHiveTask(overflow.context, {
    now: () => NOW, rpc: rpcFor(() => null),
    broadcastComment: async () => { writes++; return {}; },
  });
  assert.equal(rejected.status, 'needs_input');
  assert.equal(overflow.task.hive, undefined);
  assert.equal(writes, 0);
});

test('Hive page-wide HTTP robots policy never changes the persisted chain publication', async () => {
  const {context,task}=fixture();let post:HiveComment|undefined;
  await runHiveTask(context,{now:()=>NOW,rpc:rpcFor(()=>post??null),broadcastComment:async comment=>{post=comment;return {id:'b'.repeat(40)};}});
  const original=structuredClone(task.hive);
  for(const directive of ['noindex','nofollow','max-image-preview:none']){
    const result=await verifyHivePublication(task,context.site.url,undefined,{rpc:rpcFor(()=>post),fetch:async()=>{
      const response=htmlResponse(`<article><div class="MarkdownViewer">${renderedBody().replaceAll('rel="nofollow ugc"','')}</div></article>`);
      response.headers.set('x-robots-tag',directive);return response;
    }});
    assert.equal(result.found,directive!=='noindex');if(directive==='nofollow')assert.equal(result.rel,'nofollow');
    assert.deepEqual(task.hive,original);
  }
});
