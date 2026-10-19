import test from 'node:test';
import assert from 'node:assert/strict';
import { AHREFS_API_BASE, AHREFS_DR_ENDPOINT, AHREFS_DR_PATH, AHREFS_DR_VERSION, AhrefsDrError, queryAhrefsDr } from '../src/integrations/ahrefs-dr';

test('Ahrefs uses the free endpoint, bearer auth, fixed dr3 and preserves floats and license', async () => {
  let calls = 0;
  const result = await queryAhrefsDr('test-key', 'profile.example.com', {
    fetch: async (input, init) => {
      calls++;
      const url = new URL(String(input));
      assert.equal(url.origin, AHREFS_API_BASE);
      assert.equal(url.pathname, AHREFS_DR_PATH);
      assert.equal(url.searchParams.get('target'), 'profile.example.com');
      assert.equal(url.searchParams.get('version'), AHREFS_DR_VERSION);
      assert.equal(url.searchParams.get('output'), 'json');
      assert.equal(init?.method, 'GET');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-key');
      assert.equal(init?.redirect, 'error');
      return Response.json({ domain_rating: 94.37, license: 'Domain Rating by Ahrefs' });
    },
  });
  assert.equal(AHREFS_DR_ENDPOINT, 'https://api.ahrefs.com/v3/public/domain-rating-free');
  assert.deepEqual(result, { domainRating: 94.37, license: 'Domain Rating by Ahrefs' });
  assert.equal(calls, 1);
});

test('Ahrefs empty key does not request', async () => {
  let called = false;
  await assert.rejects(queryAhrefsDr(' ', 'example.com', { fetch: async () => { called = true; return Response.json({}); } }),
    (error: unknown) => error instanceof AhrefsDrError && error.code === 'unauthorized');
  assert.equal(called, false);
});

test('Ahrefs classifies 401 without including private response bodies', async () => {
  await assert.rejects(queryAhrefsDr('test-key', 'example.com', { fetch: async () => new Response('private account response', { status: 401 }) }),
    (error: unknown) => error instanceof AhrefsDrError && error.code === 'unauthorized' && error.status === 401 && !error.message.includes('private'));
});

test('Ahrefs classifies 429 and Retry-After seconds or dates', async () => {
  const now = () => new Date('2026-10-18T00:00:00.000Z');
  for (const value of ['120', 'Sun, 18 Oct 2026 00:02:00 GMT']) {
    await assert.rejects(queryAhrefsDr('test-key', 'example.com', { now,
      fetch: async () => new Response('', { status: 429, headers: { 'Retry-After': value } }),
    }), (error: unknown) => error instanceof AhrefsDrError && error.code === 'rate_limited' && error.retryAfterMs === 120_000);
  }
});

test('Ahrefs timeout aborts the request even if injected fetch never resolves', async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(queryAhrefsDr('test-key', 'example.com', {
    timeoutMs: 5,
    fetch: async (_input, init) => { signal = init?.signal ?? undefined; return new Promise<Response>(() => {}); },
  }), (error: unknown) => error instanceof AhrefsDrError && error.code === 'timeout');
  assert.equal(signal?.aborted, true);
});

test('Ahrefs malformed and impossible DR values are rejected; zero is a valid DR', async () => {
  for (const body of [{ domain_rating: '94' }, { domain_rating: 101 }, { domain_rating: -1 }, { rank: 94 }, null]) {
    await assert.rejects(queryAhrefsDr('test-key', 'example.com', { fetch: async () => Response.json(body) }),
      (error: unknown) => error instanceof AhrefsDrError && error.code === 'invalid_response');
  }
  assert.equal((await queryAhrefsDr('test-key', 'example.com', { fetch: async () => Response.json({ domain_rating: 0, license: null }) })).domainRating, 0);
});

test('Ahrefs cancellation aborts in-flight requests', async () => {
  const abort = new AbortController();
  let signal: AbortSignal | undefined;
  const pending = queryAhrefsDr('test-key', 'example.com', { signal: abort.signal, fetch: async (_input, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  } });
  abort.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof AhrefsDrError && error.code === 'cancelled');
  assert.equal(signal?.aborted, true);
});
