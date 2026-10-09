import assert from 'node:assert/strict';
import test from 'node:test';
import {
  publishSupanote,
  supanoteTesting,
  verifySupanote,
  type SupanoteIntent,
  type SupanotePersistence,
  type SupanotePublishInput,
  type SupanoteReceipt,
  type SupanoteTransport,
} from '../src/integrations/supanote';

const NOW = '2026-10-09T08:00:00.000Z';
const TITLE = 'A reviewed publication title';
const MARKDOWN = 'This is the reviewed original Markdown.\n\nIt includes a [public citation](https://example.com/research).';
const TOKEN = 'manage_secret_that_must_not_escape';
const PUBLIC_ID = 'note_id-42';
const PUBLIC_URL = `https://supanote.app/n/${PUBLIC_ID}`;

function input(overrides: Partial<SupanotePublishInput> = {}): SupanotePublishInput {
  return {
    operationId: 'operation_cycle_42',
    reviewed: true,
    title: TITLE,
    markdown: MARKDOWN,
    ...overrides,
  };
}

function persistence() {
  const intents: SupanoteIntent[] = [];
  const receipts: SupanoteReceipt[] = [];
  const secrets: Array<{ publicId: string; token: string }> = [];
  const value: SupanotePersistence = {
    async persistIntent(intent) { intents.push(intent); },
    async persistReceipt(receipt) { receipts.push(receipt); },
    async persistManageToken(secret) { secrets.push(secret); },
  };
  return { value, intents, receipts, secrets };
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

test('intent persistence failure prevents the only POST', async () => {
  let calls = 0;
  const store: SupanotePersistence = {
    async persistIntent() { throw Error(`storage failed: ${MARKDOWN}`); },
    async persistReceipt() { throw Error('must not run'); },
    async persistManageToken() { throw Error('must not run'); },
  };
  const result = await publishSupanote(input(), store, {
    fetch: async () => { calls++; return json({ publicId: PUBLIC_ID }); },
    now: () => new Date(NOW),
  });
  assert.deepEqual(result, { status: 'not_started', reason: 'intent_not_persisted' });
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(result).includes(MARKDOWN), false);
});

test('any valid prior intent blocks another POST', async () => {
  const p = persistence();
  const prior: SupanoteIntent = {
    operationId: 'prior_operation_42',
    contentHash: 'a'.repeat(64),
    createdAt: NOW,
  };
  let calls = 0;
  const result = await publishSupanote(input({ priorIntent: prior }), p.value, {
    fetch: async () => { calls++; return json({ publicId: PUBLIC_ID }); },
  });
  assert.deepEqual(result, { status: 'blocked', reason: 'prior_intent', intent: prior });
  assert.equal(calls, 0);
  assert.equal(p.intents.length, 0);
});

test('create uses the fixed anonymous host and exact reviewed public/never JSON', async () => {
  const p = persistence();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: SupanoteTransport = async (url, init) => {
    calls.push({ url, init });
    return json({ url: `/n/${PUBLIC_ID}?token=${TOKEN}&created=1`, publicId: PUBLIC_ID });
  };
  const result = await publishSupanote(input(), p.value, { fetch, now: () => new Date(NOW) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://supanote.app/notes');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    title: TITLE,
    content: MARKDOWN,
    contentType: 'markdown',
    visibility: 'public',
    expiration: 'never',
  });
  assert.equal(p.intents.length, 1);
  assert.equal(p.intents[0].createdAt, NOW);
  assert.equal(p.intents[0].contentHash, supanoteTesting.hash(TITLE, MARKDOWN));
  assert.deepEqual(p.secrets, [{ publicId: PUBLIC_ID, token: TOKEN }]);
  assert.deepEqual(result, {
    status: 'published',
    receipt: { publicId: PUBLIC_ID, publicUrl: PUBLIC_URL, contentHash: p.intents[0].contentHash },
    management: 'saved',
  });
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.deepEqual(p.receipts, [result.status === 'published' ? result.receipt : undefined]);
});

test('a secret-store failure preserves the sanitized public receipt and reports management recovery', async () => {
  const p = persistence();
  p.value.persistManageToken = async secret => {
    assert.deepEqual(secret, { publicId: PUBLIC_ID, token: TOKEN });
    throw Error(`vault refused ${TOKEN}`);
  };
  const result = await publishSupanote(input(), p.value, {
    fetch: async () => json({ url: `${PUBLIC_URL}?token=${TOKEN}` }),
    now: () => new Date(NOW),
  });
  assert.equal(result.status, 'published_manage_pending');
  if (result.status !== 'published_manage_pending') throw Error('unexpected result');
  assert.equal(result.receipt.publicUrl, PUBLIC_URL);
  assert.equal(result.management, 'recovery_required');
  assert.deepEqual(p.receipts, [result.receipt]);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('a public-receipt store failure returns the known sanitized URL before exposing any token', async () => {
  const p = persistence();
  p.value.persistReceipt = async saved => {
    assert.equal(saved.publicUrl, PUBLIC_URL);
    throw Error(`receipt store refused ${PUBLIC_URL}?token=${TOKEN}`);
  };
  let secretCalls = 0;
  p.value.persistManageToken = async () => { secretCalls++; };
  const result = await publishSupanote(input(), p.value, {
    fetch: async () => json({ url: `${PUBLIC_URL}?token=${TOKEN}`, publicId: PUBLIC_ID }),
  });
  assert.equal(result.status, 'published_receipt_pending');
  if (result.status !== 'published_receipt_pending') throw Error('unexpected result');
  assert.equal(result.receipt.publicUrl, PUBLIC_URL);
  assert.equal(result.management, 'not_attempted');
  assert.equal(secretCalls, 0);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('a flat publicId-only response records the public note without inventing management control', async () => {
  const p = persistence();
  const result = await publishSupanote(input(), p.value, {
    fetch: async () => json({ publicId: PUBLIC_ID }),
    now: () => new Date(NOW),
  });
  assert.equal(result.status, 'published');
  if (result.status !== 'published') throw Error('unexpected result');
  assert.equal(result.receipt.publicUrl, PUBLIC_URL);
  assert.equal(result.management, 'not_returned');
  assert.equal(p.secrets.length, 0);
});

test('off-origin, unsafe, ambiguous, aliased, and nested response identities stay uncertain', async t => {
  const cases: Array<[string, unknown]> = [
    ['off-origin', { url: `https://evil.example/n/${PUBLIC_ID}?token=${TOKEN}` }],
    ['userinfo', { url: `https://user:pass@supanote.app/n/${PUBLIC_ID}?token=${TOKEN}` }],
    ['port', { url: `https://supanote.app:444/n/${PUBLIC_ID}?token=${TOKEN}` }],
    ['wrong path', { url: `https://supanote.app/api/v1/notes/${PUBLIC_ID}?token=${TOKEN}` }],
    ['escaped separator', { url: 'https://supanote.app/n/note%2Fescape?token=secret' }],
    ['dot segment', { url: 'https://supanote.app/n/..%2Fadmin?token=secret' }],
    ['duplicate token', { url: `${PUBLIC_URL}?token=one&token=two` }],
    ['unknown query', { url: `${PUBLIC_URL}?token=${TOKEN}&redirect=https://evil.example` }],
    ['alias mismatch', { url: `${PUBLIC_URL}?token=${TOKEN}`, publicId: 'canonical_different' }],
    ['nested API envelope', { success: true, data: { url: PUBLIC_URL, publicId: PUBLIC_ID } }],
  ];
  for (const [name, body] of cases) await t.test(name, async () => {
    const p = persistence();
    let calls = 0;
    const result = await publishSupanote(input(), p.value, {
      fetch: async () => { calls++; return json(body); },
      now: () => new Date(NOW),
    });
    assert.equal(result.status, 'uncertain');
    assert.equal(p.secrets.length, 0);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    const again = await publishSupanote(input({ priorIntent: p.intents[0] }), p.value, {
      fetch: async () => { calls++; return json(body); },
    });
    assert.equal(again.status, 'blocked');
    assert.equal(calls, 1);
  });
});

test('response body timeout, oversize, abort, and transport failures are bounded and sanitized', async t => {
  await t.test('body timeout', async () => {
    const p = persistence();
    const response = new Response(new ReadableStream<Uint8Array>({ start() {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const started = Date.now();
    const result = await publishSupanote(input(), p.value, { fetch: async () => response, timeoutMs: 50 });
    assert.equal(result.status, 'uncertain');
    assert.ok(Date.now() - started < 1_000);
  });

  await t.test('declared oversize', async () => {
    const p = persistence();
    const result = await publishSupanote(input(), p.value, {
      fetch: async () => json({ publicId: PUBLIC_ID }, 200, { 'content-length': '64001' }),
    });
    assert.equal(result.status, 'uncertain');
  });

  await t.test('streamed oversize', async () => {
    const p = persistence();
    const result = await publishSupanote(input(), p.value, {
      fetch: async () => new Response(new Uint8Array(supanoteTesting.MAX_RESPONSE_BYTES + 1), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    assert.equal(result.status, 'uncertain');
  });

  await t.test('transport-triggered abort', async () => {
    const p = persistence();
    const abort = new AbortController();
    const result = await publishSupanote(input(), p.value, {
      signal: abort.signal,
      fetch: async () => {
        abort.abort();
        throw Error(`${MARKDOWN} ${PUBLIC_URL}?token=${TOKEN}`);
      },
    });
    assert.equal(result.status, 'uncertain');
    assert.equal(JSON.stringify(result).includes(MARKDOWN), false);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
  });

  await t.test('server echo in malformed JSON', async () => {
    const p = persistence();
    const result = await publishSupanote(input(), p.value, {
      fetch: async () => new Response(`{"echo":"${TOKEN} ${MARKDOWN}`, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    assert.equal(result.status, 'uncertain');
    assert.equal(JSON.stringify(result).includes(MARKDOWN), false);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
  });
});

test('an undocumented HTTP error remains uncertain and still cannot be reposted', async () => {
  const p = persistence();
  let calls = 0;
  const fetch: SupanoteTransport = async () => {
    calls++;
    return json({ message: `${MARKDOWN} ${TOKEN}` }, 422);
  };
  const first = await publishSupanote(input(), p.value, { fetch, now: () => new Date(NOW) });
  assert.equal(first.status, 'uncertain');
  assert.equal(JSON.stringify(first).includes(MARKDOWN), false);
  assert.equal(JSON.stringify(first).includes(TOKEN), false);
  const second = await publishSupanote(input({ priorIntent: p.intents[0] }), p.value, { fetch });
  assert.equal(second.status, 'blocked');
  assert.equal(calls, 1);
});

test('input and persisted values are isolated from mutation across asynchronous callbacks', async () => {
  const value = input();
  const p = persistence();
  let posted: Record<string, unknown> | undefined;
  p.value.persistIntent = async intent => {
    p.intents.push(intent);
    intent.contentHash = 'b'.repeat(64);
    await Promise.resolve();
    value.title = 'Changed after review';
    value.markdown = 'Changed after review';
  };
  p.value.persistReceipt = async saved => {
    p.receipts.push(saved);
    saved.publicId = 'mutated_by_storage';
    saved.publicUrl = 'https://supanote.app/n/mutated_by_storage';
  };
  const result = await publishSupanote(value, p.value, {
    fetch: async (_url, init) => {
      posted = JSON.parse(String(init.body));
      return json({ publicId: PUBLIC_ID });
    },
    now: () => new Date(NOW),
  });
  assert.deepEqual(posted, {
    title: TITLE,
    content: MARKDOWN,
    contentType: 'markdown',
    visibility: 'public',
    expiration: 'never',
  });
  assert.equal(result.status, 'published');
  if (result.status !== 'published') throw Error('unexpected result');
  assert.equal(result.receipt.publicId, PUBLIC_ID);
  assert.equal(result.receipt.contentHash, supanoteTesting.hash(TITLE, MARKDOWN));
});

test('verification snapshots expected content and receipt before awaiting the GET', async () => {
  const expected = { title: TITLE, markdown: MARKDOWN };
  const saved = receipt();
  let resolve!: (response: Response) => void;
  const pending = verifySupanote(saved, expected, {
    fetch: () => new Promise<Response>(done => { resolve = done; }),
  });
  expected.title = 'Changed title';
  expected.markdown = 'Changed body';
  saved.publicId = 'changed_id';
  saved.publicUrl = 'https://supanote.app/n/changed_id';
  resolve(json({ success: true, data: {
    publicId: PUBLIC_ID,
    title: TITLE,
    content: MARKDOWN,
    contentType: 'markdown',
    visibility: 'public',
    expiresAt: null,
  } }));
  assert.deepEqual(await pending, { verified: true, reason: 'matched' });
});

test('bounded GET readback accommodates a large legal Markdown response', async () => {
  const large = 'a'.repeat(100_000);
  const value = input({ markdown: large });
  const p = persistence();
  const published = await publishSupanote(value, p.value, { fetch: async () => json({ publicId: PUBLIC_ID }) });
  assert.equal(published.status, 'published');
  if (published.status !== 'published') throw Error('unexpected result');
  const verified = await verifySupanote(published.receipt, { title: TITLE, markdown: large }, {
    fetch: async () => json({ success: true, data: {
      publicId: PUBLIC_ID,
      title: TITLE,
      content: large,
      contentType: 'markdown',
      visibility: 'public',
      expiresAt: null,
    } }),
  });
  assert.deepEqual(verified, { verified: true, reason: 'matched' });
});

test('a Response acquired after cancellation has its unread body disposed', async () => {
  const p = persistence();
  const abort = new AbortController();
  let resolve!: (response: Response) => void;
  let cancels = 0;
  const pending = publishSupanote(input(), p.value, {
    signal: abort.signal,
    fetch: () => new Promise<Response>(done => { resolve = done; }),
  });
  await new Promise<void>(done => setImmediate(done));
  abort.abort();
  assert.equal((await pending).status, 'uncertain');
  resolve(new Response(new ReadableStream({ start() {}, cancel() { cancels++; } }), {
    headers: { 'content-type': 'application/json' },
  }));
  await new Promise<void>(done => setImmediate(done));
  assert.equal(cancels, 1);
});

function receipt(): SupanoteReceipt {
  return { publicId: PUBLIC_ID, publicUrl: PUBLIC_URL, contentHash: supanoteTesting.hash(TITLE, MARKDOWN) };
}

test('readback uses only the fixed documented GET and matches full content, title, public visibility, and no expiry', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await verifySupanote(receipt(), { title: TITLE, markdown: MARKDOWN }, {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return json({ success: true, data: {
        publicId: PUBLIC_ID,
        title: TITLE,
        content: MARKDOWN,
        contentType: 'markdown',
        visibility: 'public',
        expiresAt: null,
      } });
    },
  });
  assert.deepEqual(result, { verified: true, reason: 'matched' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://supanote.app/api/v1/notes/${PUBLIC_ID}`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.credentials, 'omit');
});

test('readback rejects any full-text, title, visibility, expiry, type, or identity mismatch', async t => {
  const base = {
    publicId: PUBLIC_ID,
    title: TITLE,
    content: MARKDOWN,
    contentType: 'markdown',
    visibility: 'public',
    expiresAt: null,
  };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['content', { content: `${MARKDOWN}\nchanged` }],
    ['title', { title: 'Changed' }],
    ['visibility', { visibility: 'unlisted' }],
    ['expiry', { expiresAt: '2026-10-10T00:00:00.000Z' }],
    ['type', { contentType: 'text' }],
    ['identity', { publicId: 'another_note' }],
  ];
  for (const [name, changed] of cases) await t.test(name, async () => {
    const result = await verifySupanote(receipt(), { title: TITLE, markdown: MARKDOWN }, {
      fetch: async () => json({ success: true, data: { ...base, ...changed } }),
    });
    assert.deepEqual(result, { verified: false, reason: 'mismatch' });
  });
});

test('invalid input fails before intent persistence or network access', async () => {
  const p = persistence();
  let calls = 0;
  await assert.rejects(() => publishSupanote(input({ title: ' bad ' }), p.value, {
    fetch: async () => { calls++; return json({ publicId: PUBLIC_ID }); },
  }), /Invalid Supanote title/);
  assert.equal(p.intents.length, 0);
  assert.equal(calls, 0);
});
