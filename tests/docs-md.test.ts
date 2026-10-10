import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  compareDocsMdRawSource,
  createDocsMdShare,
  docsMdTesting,
  type DocsMdIntent,
  type DocsMdPersistence,
  type DocsMdPublishInput,
  type DocsMdReceipt,
  type DocsMdTransport,
} from '../src/integrations/docs-md';

const NOW = '2026-10-09T10:00:00.000Z';
const OPERATION_ID = 'docs_md_operation_49';
const ID = 'misty-fox-a1b2c';
const PUBLIC_URL = `https://docs-md.com/${ID}`;
const RAW_URL = `https://docs-md.com/raw/${ID}`;
const TOKEN = 'A'.repeat(32);
const MARKDOWN = '# Reviewed source\n\nThis is an original [reference](https://example.com/research).';

function input(overrides: Partial<DocsMdPublishInput> = {}): DocsMdPublishInput {
  return { operationId: OPERATION_ID, reviewed: true, markdown: MARKDOWN, ...overrides };
}

function success(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    id: ID,
    url: PUBLIC_URL,
    rawUrl: RAW_URL,
    editToken: TOKEN,
    expiresAt: 0,
    rateLimit: { remaining: 19 },
    ...overrides,
  };
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function storage() {
  const order: string[] = [];
  const intents: DocsMdIntent[] = [];
  const receipts: DocsMdReceipt[] = [];
  const secrets: Array<{ operationId: string; id: string; editToken: string }> = [];
  const value: DocsMdPersistence = {
    async persistIntent(intent) { order.push('intent'); intents.push(intent); },
    async persistReceipt(receipt) { order.push('receipt'); receipts.push(receipt); },
    async persistEditTokenAtomically(secret) { order.push('secret'); secrets.push(secret); },
  };
  return { value, order, intents, receipts, secrets };
}

function expectedReceipt(markdown = MARKDOWN): DocsMdReceipt {
  const normalized = docsMdTesting.canonicalMarkdown(markdown);
  const body = docsMdTesting.canonicalRequest(normalized);
  return {
    operationId: OPERATION_ID,
    id: ID,
    publicUrl: PUBLIC_URL,
    rawUrl: RAW_URL,
    sourceHash: createHashForTest(normalized),
    requestHash: createHashForTest(body),
    expiresAt: 0,
  };
}

function createHashForTest(value: string): string {
  // Keep the expected receipt independent of non-exported implementation state.
  return createHash('sha256').update(value).digest('hex');
}

test('one reviewed create uses the fixed anonymous endpoint and exact canonical never-expiring body', async () => {
  const store = storage();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await createDocsMdShare(input({ markdown: ` \n${MARKDOWN}\n\t ` }), store.value, {
    now: () => new Date(NOW),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return json(success());
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://docs-md.com/api/share');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    content: MARKDOWN,
    filename: 'publication.md',
    expiry: 'never',
  });
  assert.deepEqual(store.order, ['intent', 'receipt', 'secret']);
  assert.equal(store.intents[0].createdAt, NOW);
  assert.equal(store.intents[0].sourceHash, createHashForTest(MARKDOWN));
  assert.equal(store.intents[0].requestHash, createHashForTest(String(calls[0].init.body)));
  assert.deepEqual(store.secrets, [{ operationId: OPERATION_ID, id: ID, editToken: TOKEN }]);
  assert.deepEqual(result, {
    status: 'created',
    receipt: store.receipts[0],
    persistence: { receipt: 'saved', secret: 'saved' },
  });
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  if (result.status !== 'created') throw new Error('unexpected result');
  assert.equal(result.receipt.publicUrl, PUBLIC_URL);
  assert.equal(result.receipt.rawUrl, RAW_URL);
  assert.equal(result.receipt.publicUrl.includes(TOKEN), false);
});

test('a durable prior intent blocks every create attempt before persistence or transport', async () => {
  const store = storage();
  const priorIntent: DocsMdIntent = {
    operationId: 'earlier_docs_md_operation',
    sourceHash: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    createdAt: NOW,
  };
  let requests = 0;
  const result = await createDocsMdShare(input({ priorIntent }), store.value, {
    fetch: async () => { requests++; return json(success()); },
  });
  assert.deepEqual(result, { status: 'blocked', reason: 'prior_intent', intent: priorIntent });
  assert.equal(requests, 0);
  assert.deepEqual(store.order, []);
});

test('intent persistence failure prevents the POST and does not reflect stored content', async () => {
  let requests = 0;
  const store: DocsMdPersistence = {
    async persistIntent() { throw new Error(`private failure: ${MARKDOWN}`); },
    async persistReceipt() { throw new Error('must not run'); },
    async persistEditTokenAtomically() { throw new Error('must not run'); },
  };
  const result = await createDocsMdShare(input(), store, {
    fetch: async () => { requests++; return json(success()); },
  });
  assert.deepEqual(result, { status: 'not_started', reason: 'intent_not_persisted' });
  assert.equal(requests, 0);
  assert.equal(JSON.stringify(result).includes(MARKDOWN), false);
});

test('caller CAS makes concurrent creates for the same operation issue exactly one POST', async () => {
  const durable = new Set<string>();
  let requests = 0;
  const persistence: DocsMdPersistence = {
    async persistIntent(intent) {
      if (durable.has(intent.operationId)) throw new Error('CAS conflict');
      durable.add(intent.operationId);
    },
    async persistReceipt() {},
    async persistEditTokenAtomically() {},
  };
  const fetch: DocsMdTransport = async () => {
    requests++;
    await new Promise(resolve => setImmediate(resolve));
    return json(success());
  };
  const results = await Promise.all([
    createDocsMdShare(input(), persistence, { fetch, now: () => new Date(NOW) }),
    createDocsMdShare(input(), persistence, { fetch, now: () => new Date(NOW) }),
  ]);
  assert.equal(requests, 1);
  assert.deepEqual(results.map(result => result.status).sort(), ['created', 'not_started']);
});

test('review, character, UTF-8, and whole-request limits fail before intent persistence', async () => {
  const cases: DocsMdPublishInput[] = [
    input({ reviewed: false as true }),
    input({ markdown: 'x'.repeat(docsMdTesting.MAX_CONTENT_CHARS + 1) }),
    input({ markdown: '\u0000private' }),
    input({ markdown: '\ud800' }),
    // 100,000 UTF-16 code units fit the service character limit, but the JSON exceeds 200,000 UTF-8 bytes.
    input({ markdown: '😀'.repeat(50_000) }),
  ];
  for (const item of cases) {
    const store = storage();
    await assert.rejects(createDocsMdShare(item, store.value, {
      fetch: async () => { throw new Error('must not run'); },
    }), /Docs MD/);
    assert.deepEqual(store.order, []);
  }

  const asciiBoundary = 'x'.repeat(docsMdTesting.MAX_CONTENT_CHARS);
  const store = storage();
  let sentBytes = 0;
  const result = await createDocsMdShare(input({ markdown: asciiBoundary }), store.value, {
    fetch: async (_url, init) => {
      sentBytes = Buffer.byteLength(String(init.body), 'utf8');
      return json(success());
    },
  });
  assert.equal(result.status, 'created');
  assert.ok(sentBytes <= docsMdTesting.MAX_REQUEST_BYTES);
});

test('HTTP errors, including 400, remain unknown and are never retried', async () => {
  for (const status of [400, 413, 429, 500]) {
    const store = storage();
    let requests = 0;
    const result = await createDocsMdShare(input(), store.value, {
      fetch: async () => {
        requests++;
        return json({ error: `reflected ${TOKEN}` }, status);
      },
    });
    assert.equal(requests, 1);
    assert.equal(result.status, 'unknown');
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    assert.deepEqual(store.order, ['intent']);
  }
});

test('unknown create failures return only fixed secret-safe diagnostics', async t => {
  const sensitive = 'secret-token-and-response-key-53';
  const unknown = async (
    diagnostic: string,
    fetch: DocsMdTransport,
  ) => {
    const store = storage();
    const result = await createDocsMdShare(input(), store.value, { fetch, timeoutMs: 50 });
    assert.equal(result.status, 'unknown');
    if (result.status !== 'unknown') throw new Error('unexpected result');
    assert.equal((result as unknown as { diagnostic?: string }).diagnostic, diagnostic);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(sensitive), false);
    assert.equal(serialized.includes(TOKEN), false);
    assert.deepEqual(store.order, ['intent']);
  };
  const cases: Array<[string, string, DocsMdTransport]> = [
    ['transport exception', 'transport_failure', async () => { throw new Error(sensitive); }],
    ['redirect', 'redirect_or_response_url', async () => new Response(null, { status: 302, headers: { location: `https://attacker.example/${sensitive}` } })],
    ['response URL', 'redirect_or_response_url', async () => {
      const response = json(success());
      Object.defineProperty(response, 'url', { value: `https://docs-md.com/api/${sensitive}` });
      return response;
    }],
    ['HTTP status', 'http_status', async () => json({ error: sensitive }, 500)],
    ['declared body size', 'response_body_size_or_decode', async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(docsMdTesting.MAX_CREATE_RESPONSE_BYTES + 1) },
    })],
    ['response stream failure', 'transport_failure', async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error(sensitive)); },
    }), { status: 200, headers: { 'content-type': 'application/json' } })],
    ['invalid UTF-8', 'response_body_size_or_decode', async () => new Response(Uint8Array.from([0xc3, 0x28]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })],
    ['media header getter failure', 'response_media_type', async () => {
      const response = json(success());
      let reads = 0;
      Object.defineProperty(response, 'headers', { value: {
        get() {
          if (reads++ === 0) return null;
          throw new Error(sensitive);
        },
      } });
      return response;
    }],
    ['media type', 'response_media_type', async () => new Response(sensitive, {
      status: 200,
      headers: { 'content-type': `text/${sensitive}` },
    })],
    ['invalid JSON', 'response_json', async () => new Response(`{${sensitive}\u0000`, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })],
    ['success field', 'schema_success', async () => json({ ...success(), success: sensitive, [sensitive]: TOKEN })],
    ['id field', 'schema_id', async () => json(success({ id: sensitive.toUpperCase(), [sensitive]: TOKEN }))],
    ['expiry field', 'schema_expiry', async () => json(success({ expiresAt: sensitive, [sensitive]: TOKEN }))],
    ['edit token field', 'schema_edit_token', async () => json(success({ editToken: `${sensitive}${TOKEN}`, [sensitive]: TOKEN }))],
    ['rate limit field', 'schema_rate_limit', async () => json(success({ rateLimit: { remaining: sensitive }, [sensitive]: TOKEN }))],
    ['URL fields', 'schema_url', async () => json(success({ url: `${PUBLIC_URL}?${sensitive}=${TOKEN}`, [sensitive]: TOKEN }))],
  ];
  for (const [name,diagnostic,fetch] of cases) await t.test(name, () => unknown(diagnostic, fetch));
});

test('the complete documented success schema is required before any receipt is accepted', async () => {
  const invalid = [
    success({ success: false }),
    success({ id: '../escape' }),
    success({ editToken: 'short' }),
    success({ expiresAt: null }),
    success({ rateLimit: undefined }),
    success({ rateLimit: { remaining: -1 } }),
    success({ rateLimit: { remaining: 1.5 } }),
  ];
  for (const value of invalid) {
    const store = storage();
    const result = await createDocsMdShare(input(), store.value, { fetch: async () => json(value) });
    assert.equal(result.status, 'unknown');
    assert.deepEqual(store.order, ['intent']);
  }

  for (const status of [201, 204]) {
    const store = storage();
    const result = await createDocsMdShare(input(), store.value, { fetch: async () => json(success(), status) });
    assert.equal(result.status, 'unknown');
    assert.deepEqual(store.order, ['intent']);
  }
});

test('public and raw response URLs must bind exactly to the same trusted ID', async () => {
  const invalid = [
    success({ url: `https://attacker.example/${ID}` }),
    success({ url: `${PUBLIC_URL}?editToken=${TOKEN}` }),
    success({ url: `${PUBLIC_URL}#fragment` }),
    success({ rawUrl: 'https://docs-md.com/raw/other-id' }),
    success({ rawUrl: `https://user:pass@docs-md.com/raw/${ID}` }),
    success({ id: 'other-id' }),
  ];
  for (const value of invalid) {
    const store = storage();
    const result = await createDocsMdShare(input(), store.value, { fetch: async () => json(value) });
    assert.equal(result.status, 'unknown');
    assert.deepEqual(store.order, ['intent']);
  }
});

test('redirects and a tampered final response URL remain unknown', async () => {
  const redirect = new Response(null, { status: 302, headers: { location: PUBLIC_URL } });
  const first = storage();
  assert.equal((await createDocsMdShare(input(), first.value, { fetch: async () => redirect })).status, 'unknown');

  const response = json(success());
  Object.defineProperty(response, 'url', { value: 'https://docs-md.com/api/other' });
  const second = storage();
  assert.equal((await createDocsMdShare(input(), second.value, { fetch: async () => response })).status, 'unknown');
  assert.deepEqual(first.order, ['intent']);
  assert.deepEqual(second.order, ['intent']);
});

test('create response bytes and UTF-8 decoding are bounded', async () => {
  const advertised = new Response('{}', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(docsMdTesting.MAX_CREATE_RESPONSE_BYTES + 1),
    },
  });
  assert.equal((await createDocsMdShare(input(), storage().value, { fetch: async () => advertised })).status, 'unknown');

  let cancelled = false;
  const largeBody = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(docsMdTesting.MAX_CREATE_RESPONSE_BYTES + 1)); },
    cancel() { cancelled = true; },
  });
  const dynamic = new Response(largeBody, { status: 200, headers: { 'content-type': 'application/json' } });
  assert.equal((await createDocsMdShare(input(), storage().value, { fetch: async () => dynamic })).status, 'unknown');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);

  const invalidUtf8 = new Response(Uint8Array.from([0xc3, 0x28]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  assert.equal((await createDocsMdShare(input(), storage().value, { fetch: async () => invalidUtf8 })).status, 'unknown');

  const bomJson = new Response(Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify(success()), 'utf8'),
  ]), { status: 200, headers: { 'content-type': 'application/json' } });
  assert.equal((await createDocsMdShare(input(), storage().value, { fetch: async () => bomJson })).status, 'unknown');
});

test('a hanging create obeys its bounded timeout and does not retry', async () => {
  let requests = 0;
  const result = await createDocsMdShare(input(), storage().value, {
    timeoutMs: 50,
    fetch: async () => {
      requests++;
      return new Promise<Response>(() => undefined);
    },
  });
  assert.equal(result.status, 'unknown');
  assert.equal(requests, 1);
});

test('external abort returns unknown and discards a response that arrives late', async () => {
  const abort = new AbortController();
  let resolveResponse: ((response: Response) => void) | undefined;
  let cancellations = 0;
  const operation = createDocsMdShare(input(), storage().value, {
    signal: abort.signal,
    fetch: () => new Promise(resolve => { resolveResponse = resolve; }),
  });
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  const result = await operation;
  assert.equal(result.status, 'unknown');
  assert.ok(resolveResponse);
  resolveResponse(new Response(new ReadableStream<Uint8Array>({ cancel() { cancellations++; } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellations, 1);
});

test('abort during response streaming cancels the body and keeps the intent unknown', async () => {
  const abort = new AbortController();
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    pull() { queueMicrotask(() => abort.abort()); },
    cancel() { cancellations++; },
  });
  const result = await createDocsMdShare(input(), storage().value, {
    signal: abort.signal,
    fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  assert.equal(result.status, 'unknown');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellations, 1);
});

test('receipt and atomic secret-store failures keep sanitized recovery state without leaking the token', async () => {
  for (const failure of ['receipt', 'secret', 'both'] as const) {
    const store = storage();
    if (failure === 'receipt' || failure === 'both') {
      store.value.persistReceipt = async () => {
        store.order.push('receipt');
        throw new Error(`private receipt error ${TOKEN}`);
      };
    }
    if (failure === 'secret' || failure === 'both') {
      store.value.persistEditTokenAtomically = async secret => {
        store.order.push('secret');
        assert.equal(secret.editToken, TOKEN);
        throw new Error(`private secret error ${TOKEN}`);
      };
    }
    const result = await createDocsMdShare(input(), store.value, { fetch: async () => json(success()) });
    assert.equal(result.status, 'created_persistence_unknown');
    if (result.status !== 'created_persistence_unknown') throw new Error('unexpected result');
    assert.equal(result.receipt.publicUrl, PUBLIC_URL);
    assert.equal(result.receipt.rawUrl, RAW_URL);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    assert.deepEqual(store.order, ['intent', 'receipt', 'secret']);
    if (failure === 'receipt') {
      assert.deepEqual(result.persistence, { receipt: 'unknown', secret: 'saved' });
      assert.equal(store.secrets.length, 1);
    }
  }
});

test('raw source comparison performs one fixed GET and matches the exact trimmed Markdown', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const receipt = expectedReceipt();
  const result = await compareDocsMdRawSource(receipt, ` \n${MARKDOWN}\n `, {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(MARKDOWN, {
        status: 200,
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'x-robots-tag': 'noindex',
        },
      });
    },
  });
  assert.deepEqual(result, { status: 'source_matched' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RAW_URL);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.credentials, 'omit');
});

test('raw comparison reports content mismatch without calling it live or verified', async () => {
  const result = await compareDocsMdRawSource(expectedReceipt(), `${MARKDOWN}\n`, {
    fetch: async () => new Response(`${MARKDOWN}\nchanged`, {
      status: 200,
      headers: { 'content-type': 'text/markdown' },
    }),
  });
  assert.deepEqual(result, { status: 'source_mismatch' });
  assert.equal(JSON.stringify(result).includes('live'), false);
  assert.equal(JSON.stringify(result).includes('verified'), false);
});

test('a raw UTF-8 BOM prefix is preserved and cannot be mistaken for the exact source', async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(MARKDOWN, 'utf8')]);
  const result = await compareDocsMdRawSource(expectedReceipt(), MARKDOWN, {
    fetch: async () => new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    }),
  });
  assert.deepEqual(result, { status: 'source_mismatch' });
});

test('receipt URL and source-hash tampering fail closed without any raw request', async () => {
  const original = expectedReceipt();
  const tampered = [
    { ...original, id: 'other-id' },
    { ...original, publicUrl: `${PUBLIC_URL}?x=1` },
    { ...original, rawUrl: 'https://attacker.example/raw/misty-fox-a1b2c' },
    { ...original, sourceHash: 'f'.repeat(64) },
    { ...original, requestHash: 'e'.repeat(64) },
  ];
  for (const receipt of tampered) {
    let requests = 0;
    const result = await compareDocsMdRawSource(receipt, MARKDOWN, {
      fetch: async () => { requests++; return new Response(MARKDOWN); },
    });
    assert.deepEqual(result, { status: 'source_mismatch' });
    assert.equal(requests, 0);
  }
});

test('raw HTTP, media-type, redirect, and response-size failures stay source_unavailable', async () => {
  const responses = [
    () => new Response('missing', { status: 404, headers: { 'content-type': 'text/markdown' } }),
    () => new Response(MARKDOWN, { status: 200, headers: { 'content-type': 'text/html' } }),
    () => new Response(null, { status: 302, headers: { location: RAW_URL } }),
    () => new Response(MARKDOWN, {
      status: 200,
      headers: {
        'content-type': 'text/markdown',
        'content-length': String(docsMdTesting.MAX_RAW_RESPONSE_BYTES + 1),
      },
    }),
  ];
  for (const response of responses) {
    const result = await compareDocsMdRawSource(expectedReceipt(), MARKDOWN, { fetch: async () => response() });
    assert.deepEqual(result, { status: 'source_unavailable' });
  }
});

test('raw source reads share the timeout and late-response disposal boundary', async () => {
  let requests = 0;
  const timeout = await compareDocsMdRawSource(expectedReceipt(), MARKDOWN, {
    timeoutMs: 50,
    fetch: async () => {
      requests++;
      return new Promise<Response>(() => undefined);
    },
  });
  assert.deepEqual(timeout, { status: 'source_unavailable' });
  assert.equal(requests, 1);

  const abort = new AbortController();
  let resolveResponse: ((response: Response) => void) | undefined;
  let cancellations = 0;
  const operation = compareDocsMdRawSource(expectedReceipt(), MARKDOWN, {
    signal: abort.signal,
    fetch: () => new Promise(resolve => { resolveResponse = resolve; }),
  });
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  assert.deepEqual(await operation, { status: 'source_unavailable' });
  assert.ok(resolveResponse);
  resolveResponse(new Response(new ReadableStream<Uint8Array>({ cancel() { cancellations++; } }), {
    status: 200,
    headers: { 'content-type': 'text/markdown' },
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellations, 1);
});
