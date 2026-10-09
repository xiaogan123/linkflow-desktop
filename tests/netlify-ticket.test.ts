import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeNetlifyTicket,
  NetlifyTicketError,
  type NetlifyTicketDependencies,
  type NetlifyTicketTransport,
} from '../src/integrations/netlify-ticket';

const CLIENT_ID = 'linkflow-public-client_123';
const TICKET_ID = 'ticket_abc-123';
const CREATED_AT = '2026-10-09T02:00:00.000Z';
const ACCESS_TOKEN = 'synthetic-netlify-access-token-value';
const USER_ID = 'user_456';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ticket(authorized: boolean, overrides: Record<string, unknown> = {}) {
  return { id: TICKET_ID, client_id: CLIENT_ID, authorized, created_at: CREATED_AT, ...overrides };
}

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant_789', access_token: ACCESS_TOKEN, user_id: USER_ID,
    user_email: 'owner@example.test', created_at: '2026-10-09T02:01:00.000Z', ...overrides,
  };
}

function dependencies(request: NetlifyTicketTransport, overrides: Partial<NetlifyTicketDependencies> = {}): NetlifyTicketDependencies {
  return {
    clientId: CLIENT_ID,
    openExternal: async () => undefined,
    request,
    requestTimeoutMs: 100,
    totalTimeoutMs: 1_000,
    pollIntervalMs: 1,
    maxPolls: 3,
    ...overrides,
  };
}

async function rejectsCode(promise: Promise<unknown>, code: NetlifyTicketError['code']): Promise<void> {
  await assert.rejects(promise, error => error instanceof NetlifyTicketError && error.code === code);
}

test('ticket authorization uses fixed endpoints, pending polling, and one credential-free exchange', async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  let shows = 0;
  let opened = '';
  const result = await authorizeNetlifyTicket(dependencies(async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname === '/api/v1/oauth/tickets' && init.method === 'POST') return json(ticket(false), 201);
    if (url.pathname === `/api/v1/oauth/tickets/${TICKET_ID}` && init.method === 'GET') {
      shows++;
      return json(ticket(shows > 1));
    }
    if (url.pathname === `/api/v1/oauth/tickets/${TICKET_ID}/exchange` && init.method === 'POST') return json(grant(), 201);
    throw new Error('unexpected synthetic request');
  }, { openExternal: async url => { opened = url; } }));

  assert.deepEqual(result, { accessToken: ACCESS_TOKEN, userId: USER_ID });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(call => [call.init.method, call.url.pathname]), [
    ['POST', '/api/v1/oauth/tickets'],
    ['GET', `/api/v1/oauth/tickets/${TICKET_ID}`],
    ['GET', `/api/v1/oauth/tickets/${TICKET_ID}`],
    ['POST', `/api/v1/oauth/tickets/${TICKET_ID}/exchange`],
  ]);
  assert.equal(calls[0].url.origin, 'https://api.netlify.com');
  assert.equal(calls[0].url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(calls[3].url.search, '');
  for (const { init, url } of calls) {
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.body, undefined);
    assert.equal(new Headers(init.headers).has('authorization'), false);
    assert.equal(url.toString().includes(ACCESS_TOKEN), false);
  }
  const browser = new URL(opened);
  assert.equal(browser.toString(), `https://app.netlify.com/authorize?response_type=ticket&ticket=${TICKET_ID}`);
  assert.equal(opened.includes(ACCESS_TOKEN), false);
});

test('missing or malformed client ID fails before network or browser work', async () => {
  let requests = 0;
  let opens = 0;
  for (const clientId of [undefined, '', 'borrowed client', 'x'.repeat(257)]) {
    await rejectsCode(authorizeNetlifyTicket({
      clientId,
      openExternal: async () => { opens++; },
      request: async () => { requests++; return json({}); },
    }), 'invalid_configuration');
  }
  assert.equal(requests, 0);
  assert.equal(opens, 0);
});

test('pre-aborted operations do no external work', async () => {
  const abort = new AbortController();
  abort.abort();
  let touched = false;
  await rejectsCode(authorizeNetlifyTicket(dependencies(async () => {
    touched = true;
    return json(ticket(false), 201);
  }, { signal: abort.signal, openExternal: async () => { touched = true; } })), 'cancelled');
  assert.equal(touched, false);
});

test('cancellation during poll delay prevents another request and exchange', async () => {
  const abort = new AbortController();
  const calls: string[] = [];
  await rejectsCode(authorizeNetlifyTicket(dependencies(async input => {
    const path = new URL(input).pathname;
    calls.push(path);
    if (path === '/api/v1/oauth/tickets') return json(ticket(false), 201);
    return json(ticket(false));
  }, {
    signal: abort.signal,
    pollIntervalMs: 20,
    setTimer: (callback, milliseconds) => milliseconds === 20
      ? setTimeout(() => { abort.abort(); callback(); }, 0)
      : setTimeout(callback, milliseconds),
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  })), 'cancelled');
  assert.deepEqual(calls, ['/api/v1/oauth/tickets', `/api/v1/oauth/tickets/${TICKET_ID}`]);
});

test('cancellation interrupts a transport that ignores its signal', async () => {
  const abort = new AbortController();
  let observedSignal = false;
  const operation = authorizeNetlifyTicket(dependencies((_input, init) => {
    observedSignal = init.signal instanceof AbortSignal;
    queueMicrotask(() => abort.abort());
    return new Promise<Response>(() => undefined);
  }, { signal: abort.signal }));
  await rejectsCode(operation, 'cancelled');
  assert.equal(observedSignal, true);
});

test('cancellation aborts a never-ending response body', async () => {
  const abort = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() { queueMicrotask(() => abort.abort()); },
    cancel() { cancelled = true; },
  });
  const operation = authorizeNetlifyTicket(dependencies(async () => new Response(body, {
    status: 201, headers: { 'content-type': 'application/json' },
  }), { signal: abort.signal }));
  await rejectsCode(operation, 'cancelled');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('browser rejection and browser cancellation never start polling or exchange', async () => {
  for (const mode of ['reject', 'cancel'] as const) {
    const abort = new AbortController();
    let requests = 0;
    const operation = authorizeNetlifyTicket(dependencies(async () => {
      requests++;
      return json(ticket(false), 201);
    }, {
      signal: abort.signal,
      openExternal: mode === 'reject'
        ? async () => { throw new Error(`private browser failure ${ACCESS_TOKEN}`); }
        : async () => {
          queueMicrotask(() => abort.abort());
          return new Promise<void>(() => undefined);
        },
    }));
    await rejectsCode(operation, mode === 'reject' ? 'open_failed' : 'cancelled');
    assert.equal(requests, 1);
  }
});

test('a hanging browser open obeys the total deadline', async () => {
  let virtualNow = 0;
  await rejectsCode(authorizeNetlifyTicket(dependencies(async () => json(ticket(false), 201), {
    now: () => virtualNow,
    requestTimeoutMs: 5,
    totalTimeoutMs: 30,
    openExternal: async () => new Promise<void>(() => undefined),
    setTimer: (callback, milliseconds) => {
      const handle = { active: true };
      if (milliseconds === 30) queueMicrotask(() => {
        if (handle.active) { virtualNow += milliseconds; callback(); }
      });
      return handle;
    },
    clearTimer: handle => { (handle as { active: boolean }).active = false; },
  })), 'timeout');
});

test('finite poll exhaustion returns timeout without exchange', async () => {
  let shows = 0;
  let exchanges = 0;
  await rejectsCode(authorizeNetlifyTicket(dependencies(async (input, init) => {
    const path = new URL(input).pathname;
    if (path === '/api/v1/oauth/tickets') return json(ticket(false), 201);
    if (init.method === 'GET') { shows++; return json(ticket(false)); }
    exchanges++;
    return json(grant(), 201);
  }, { maxPolls: 2 })), 'timeout');
  assert.equal(shows, 2);
  assert.equal(exchanges, 0);
});

test('HTTP denial and failure statuses are sanitized and never retried', async () => {
  const cases: Array<[number, NetlifyTicketError['code']]> = [
    [401, 'auth'], [403, 'forbidden'], [422, 'rejected'], [429, 'rate_limited'], [503, 'network'],
  ];
  for (const [status, code] of cases) {
    let calls = 0;
    const operation = authorizeNetlifyTicket(dependencies(async () => {
      calls++;
      return json({ error: `private-${ACCESS_TOKEN}` }, status);
    }));
    await rejectsCode(operation, code);
    await assert.rejects(operation, error => !String(error).includes(ACCESS_TOKEN));
    assert.equal(calls, 1);
  }
});

test('early response rejection cancels every unread body', async () => {
  const cases = [
    { name: 'HTTP rejection', status: 401, contentType: 'application/json', url: '' },
    { name: 'wrong media type', status: 201, contentType: 'text/html', url: '' },
    { name: 'untrusted response URL', status: 201, contentType: 'application/json', url: 'https://attacker.example/ticket' },
  ];
  for (const scenario of cases) {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancellations++; } });
    const response = new Response(body, {
      status: scenario.status,
      headers: { 'content-type': scenario.contentType },
    });
    if (scenario.url) Object.defineProperty(response, 'url', { value: scenario.url });
    await assert.rejects(authorizeNetlifyTicket(dependencies(async () => response)), scenario.name);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancellations, 1, scenario.name);
  }
});

test('a response arriving after cancellation is discarded', async () => {
  const abort = new AbortController();
  let resolveResponse: ((response: Response) => void) | undefined;
  let cancellations = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancellations++; } }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
  const operation = authorizeNetlifyTicket(dependencies(() => new Promise(resolve => {
    resolveResponse = resolve;
  }), { signal: abort.signal }));
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  await rejectsCode(operation, 'cancelled');
  assert.ok(resolveResponse);
  resolveResponse(response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellations, 1);
});

test('each phase requires its documented success status and JSON media type', async () => {
  await rejectsCode(authorizeNetlifyTicket(dependencies(async () => json(ticket(false), 200))), 'invalid_response');

  await rejectsCode(authorizeNetlifyTicket(dependencies(async (input, init) => {
    const path = new URL(input).pathname;
    if (path === '/api/v1/oauth/tickets') return json(ticket(false), 201);
    if (init.method === 'GET') return json(ticket(true), 201);
    return json(grant(), 201);
  })), 'invalid_response');

  await rejectsCode(authorizeNetlifyTicket(dependencies(async () => new Response(JSON.stringify(ticket(false)), {
    status: 201, headers: { 'content-type': 'text/html' },
  }))), 'invalid_response');
});

test('a hanging request obeys the per-request timeout even if transport ignores abort', async () => {
  let virtualNow = 0;
  await rejectsCode(authorizeNetlifyTicket(dependencies(async () => new Promise<Response>(() => undefined), {
    now: () => virtualNow,
    requestTimeoutMs: 5,
    totalTimeoutMs: 100,
    setTimer: (callback, milliseconds) => {
      const handle = { active: true };
      if (milliseconds === 5) queueMicrotask(() => {
        if (handle.active) { virtualNow += milliseconds; callback(); }
      });
      return handle;
    },
    clearTimer: handle => { (handle as { active: boolean }).active = false; },
  })), 'timeout');
});

test('redirected and untrusted response URLs are rejected', async () => {
  for (const url of ['https://attacker.example/api/v1/oauth/tickets', 'https://api.netlify.com/other']) {
    const response = json(ticket(false), 201);
    Object.defineProperty(response, 'url', { value: url });
    await rejectsCode(authorizeNetlifyTicket(dependencies(async () => response)), 'invalid_response');
  }
});

test('malformed and cross-operation ticket fields never reach exchange', async () => {
  const cases = [
    { phase: 'create', value: ticket(false, { id: '../escape' }) },
    { phase: 'create', value: ticket(false, { id: '.' }) },
    { phase: 'create', value: ticket(false, { id: '..' }) },
    { phase: 'create', value: ticket(false, { authorized: true }) },
    { phase: 'create', value: ticket(false, { created_at: 'not-a-date' }) },
    { phase: 'show', value: ticket(true, { id: 'different_ticket' }) },
    { phase: 'show', value: ticket(true, { client_id: 'different_client' }) },
  ];
  for (const scenario of cases) {
    let exchanges = 0;
    await rejectsCode(authorizeNetlifyTicket(dependencies(async (input, init) => {
      const path = new URL(input).pathname;
      if (path === '/api/v1/oauth/tickets') return json(scenario.phase === 'create' ? scenario.value : ticket(false), 201);
      if (init.method === 'GET') return json(scenario.value);
      exchanges++;
      return json(grant(), 201);
    })), 'invalid_response');
    assert.equal(exchanges, 0);
  }
});

test('exchange requires only the used token and user ID and discards optional metadata', async () => {
  const result = await authorizeNetlifyTicket(dependencies(async (input, init) => {
    const path = new URL(input).pathname;
    if (path === '/api/v1/oauth/tickets') {
      return json(ticket(false, { created_at: '2026-10-09T10:00:00+08:00' }), 201);
    }
    if (init.method === 'GET') {
      return json(ticket(true, { created_at: '2026-10-09T10:00:00+08:00' }));
    }
    return json({ access_token: ACCESS_TOKEN, user_id: USER_ID }, 201);
  }));
  assert.deepEqual(result, { accessToken: ACCESS_TOKEN, userId: USER_ID });

  for (const malformed of [
    grant({ access_token: 'short' }),
    grant({ user_id: '../owner' }),
  ]) {
    const operation = authorizeNetlifyTicket(dependencies(async (input, init) => {
      const path = new URL(input).pathname;
      if (path === '/api/v1/oauth/tickets') return json(ticket(false), 201);
      if (init.method === 'GET') return json(ticket(true));
      return json(malformed, 201);
    }));
    await rejectsCode(operation, 'invalid_response');
  }
});

test('dot-segment tickets fail before browser open, polling, or exchange', async () => {
  for (const id of ['.', '..']) {
    let opens = 0;
    let calls = 0;
    await rejectsCode(authorizeNetlifyTicket(dependencies(async () => {
      calls++;
      return json(ticket(false, { id }), 201);
    }, { openExternal: async () => { opens++; } })), 'invalid_response');
    assert.equal(calls, 1);
    assert.equal(opens, 0);
  }
});

test('oversized and never-ending JSON bodies are bounded and cancelled', async () => {
  const oversized = new Response(JSON.stringify({ padding: 'x'.repeat(70 * 1024) }), {
    status: 201, headers: { 'content-type': 'application/json' },
  });
  await rejectsCode(authorizeNetlifyTicket(dependencies(async () => oversized)), 'invalid_response');

  let virtualNow = 0;
  let bodyCancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { bodyCancelled = true; } });
  await rejectsCode(authorizeNetlifyTicket(dependencies(async () => new Response(body, {
    status: 201, headers: { 'content-type': 'application/json' },
  }), {
    now: () => virtualNow,
    requestTimeoutMs: 5,
    totalTimeoutMs: 100,
    setTimer: (callback, milliseconds) => {
      const handle = { active: true };
      if (milliseconds === 5) queueMicrotask(() => {
        if (handle.active) { virtualNow += milliseconds; callback(); }
      });
      return handle;
    },
    clearTimer: handle => { (handle as { active: boolean }).active = false; },
  })), 'timeout');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bodyCancelled, true);
});

test('transport errors and response bodies cannot reflect secrets in errors', async () => {
  const transportError = authorizeNetlifyTicket(dependencies(async () => {
    throw new Error(`socket contained ${ACCESS_TOKEN}`);
  }));
  await rejectsCode(transportError, 'network');
  await assert.rejects(transportError, error => !String(error).includes(ACCESS_TOKEN));

  const bodyError = authorizeNetlifyTicket(dependencies(async () => json({
    error: `server reflected ${ACCESS_TOKEN}`,
  }, 400)));
  await rejectsCode(bodyError, 'rejected');
  await assert.rejects(bodyError, error => !String(error).includes(ACCESS_TOKEN));
});

test('create and exchange POST failures are never automatically retried', async () => {
  let creates = 0;
  await rejectsCode(authorizeNetlifyTicket(dependencies(async () => {
    creates++;
    throw new Error('unknown create result');
  })), 'network');
  assert.equal(creates, 1);

  let exchanges = 0;
  await rejectsCode(authorizeNetlifyTicket(dependencies(async (input, init) => {
    const path = new URL(input).pathname;
    if (path === '/api/v1/oauth/tickets') return json(ticket(false), 201);
    if (init.method === 'GET') return json(ticket(true));
    exchanges++;
    throw new Error('unknown exchange result');
  })), 'network');
  assert.equal(exchanges, 1);
});
