const API_ORIGIN = 'https://api.netlify.com';
const API_PREFIX = '/api/v1/oauth/tickets';
const AUTHORIZE_ENDPOINT = 'https://app.netlify.com/authorize';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLLS = 120;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TOTAL_TIMEOUT_MS = 10 * 60_000;
const MAX_POLL_INTERVAL_MS = 10_000;
const MAX_POLLS = 300;
const MAX_RESPONSE_BYTES = 64 * 1024;

type JsonObject = Record<string, unknown>;
type TimerHandle = ReturnType<typeof setTimeout> | unknown;

export type NetlifyTicketTransport = (input: string, init: RequestInit) => Promise<Response>;
export type NetlifyTicketOpenExternal = (url: string, signal: AbortSignal) => Promise<void>;

export interface NetlifyTicketDependencies {
  clientId?: string;
  openExternal: NetlifyTicketOpenExternal;
  request?: NetlifyTicketTransport;
  signal?: AbortSignal;
  now?: () => number;
  setTimer?: (callback: () => void, milliseconds: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
  pollIntervalMs?: number;
  maxPolls?: number;
}

export interface NetlifyTicketGrant {
  accessToken: string;
  userId: string;
}

export type NetlifyTicketErrorCode =
  | 'invalid_configuration'
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'open_failed'
  | 'auth'
  | 'forbidden'
  | 'rate_limited'
  | 'rejected'
  | 'invalid_response';

export class NetlifyTicketError extends Error {
  constructor(readonly code: NetlifyTicketErrorCode) {
    super(`Netlify ticket authorization failed: ${code}`);
  }
}

interface Ticket {
  id: string;
  clientId: string;
  authorized: boolean;
}

interface Runtime {
  dependencies: NetlifyTicketDependencies;
  clientId: string;
  deadline: number;
  now: () => number;
  setTimer: (callback: () => void, milliseconds: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  requestTimeoutMs: number;
  pollIntervalMs: number;
  maxPolls: number;
}

function object(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeIdentifier(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum
    && value !== '.' && value !== '..' && /^[A-Za-z0-9._~-]+$/.test(value);
}

function safeTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= 64
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function safeToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 8_192
    && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function integer(value: number | undefined, fallback: number, maximum: number, minimum = 1): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.floor(value), minimum), maximum)
    : fallback;
}

function makeRuntime(dependencies: NetlifyTicketDependencies): Runtime {
  if (!safeIdentifier(dependencies.clientId)) throw new NetlifyTicketError('invalid_configuration');
  if (typeof dependencies.openExternal !== 'function') throw new NetlifyTicketError('invalid_configuration');
  if (dependencies.signal?.aborted) throw new NetlifyTicketError('cancelled');
  const suppliedNow = dependencies.now ?? Date.now;
  const initialNow = suppliedNow();
  if (!Number.isFinite(initialNow)) throw new NetlifyTicketError('invalid_configuration');
  const totalTimeoutMs = integer(dependencies.totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS, MAX_TOTAL_TIMEOUT_MS);
  return {
    dependencies,
    clientId: dependencies.clientId,
    deadline: initialNow + totalTimeoutMs,
    now: suppliedNow,
    setTimer: dependencies.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds)),
    clearTimer: dependencies.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    requestTimeoutMs: integer(dependencies.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS),
    pollIntervalMs: integer(dependencies.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS),
    maxPolls: integer(dependencies.maxPolls, DEFAULT_MAX_POLLS, MAX_POLLS),
  };
}

function remaining(runtime: Runtime): number {
  const value = runtime.deadline - runtime.now();
  if (!Number.isFinite(value) || value <= 0) throw new NetlifyTicketError('timeout');
  return value;
}

function throwIfStopped(runtime: Runtime): void {
  if (runtime.dependencies.signal?.aborted) throw new NetlifyTicketError('cancelled');
  remaining(runtime);
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      void promise.catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', aborted); resolve(value); },
      error => { signal.removeEventListener('abort', aborted); reject(error); },
    );
  });
}

async function withBoundary<T>(
  runtime: Runtime,
  action: (signal: AbortSignal) => Promise<T>,
  limitMs: number,
  failure: NetlifyTicketErrorCode,
): Promise<T> {
  throwIfStopped(runtime);
  const controller = new AbortController();
  let expired = false;
  const externalAbort = () => controller.abort(new NetlifyTicketError('cancelled'));
  runtime.dependencies.signal?.addEventListener('abort', externalAbort, { once: true });
  const duration = Math.min(limitMs, remaining(runtime));
  const stageDeadline = runtime.now() + duration;
  let actionPromise: Promise<T>;
  try {
    actionPromise = Promise.resolve(action(controller.signal));
  } catch (error) {
    actionPromise = Promise.reject(error);
  }
  const timer = runtime.setTimer(() => {
    expired = true;
    controller.abort(new NetlifyTicketError('timeout'));
  }, duration);
  try {
    const value = await awaitWithSignal(actionPromise, controller.signal);
    if (runtime.now() >= stageDeadline) throw new NetlifyTicketError('timeout');
    throwIfStopped(runtime);
    return value;
  } catch (error) {
    if (runtime.dependencies.signal?.aborted) throw new NetlifyTicketError('cancelled');
    if (expired || runtime.now() >= stageDeadline || runtime.now() >= runtime.deadline) {
      throw new NetlifyTicketError('timeout');
    }
    if (error instanceof NetlifyTicketError) throw error;
    throw new NetlifyTicketError(failure);
  } finally {
    runtime.clearTimer(timer);
    runtime.dependencies.signal?.removeEventListener('abort', externalAbort);
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<JsonObject> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (!response.body) throw new NetlifyTicketError('invalid_response');
  if (contentType !== 'application/json') {
    void response.body.cancel().catch(() => undefined);
    throw new NetlifyTicketError('invalid_response');
  }
  const advertised = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) {
    void response.body.cancel().catch(() => undefined);
    throw new NetlifyTicketError('invalid_response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await awaitWithSignal(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new NetlifyTicketError('invalid_response');
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    if (!object(parsed)) throw new Error('shape');
    return parsed;
  } catch (error) {
    if (error instanceof NetlifyTicketError) throw error;
    throw new NetlifyTicketError('invalid_response');
  }
}

function verifyResponseUrl(response: Response, expected: URL): void {
  if (!response.url) return;
  try {
    const actual = new URL(response.url);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname
      || actual.search !== expected.search || actual.hash) throw new Error('mismatch');
  } catch { throw new NetlifyTicketError('invalid_response'); }
}

function discardResponse(response: Response): void {
  if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
}

async function fixedRequest(
  runtime: Runtime,
  url: URL,
  method: 'GET' | 'POST',
  expectedStatus: 200 | 201,
): Promise<JsonObject> {
  if (url.origin !== API_ORIGIN || !url.pathname.startsWith(API_PREFIX) || url.username || url.password || url.hash) {
    throw new NetlifyTicketError('invalid_response');
  }
  return withBoundary(runtime, async signal => {
    let response: Response | undefined;
    let bodyHandled = false;
    try {
      const request = runtime.dependencies.request ?? ((input: string, init: RequestInit) => fetch(input, init));
      const responsePromise = request(url.toString(), {
        method,
        headers: { accept: 'application/json', 'user-agent': 'Linkflow-Desktop' },
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal,
      });
      try {
        response = await awaitWithSignal(responsePromise, signal);
      } catch {
        void responsePromise.then(discardResponse, () => undefined);
        throw new NetlifyTicketError('network');
      }
      if (response.redirected || response.type === 'opaqueredirect') throw new NetlifyTicketError('invalid_response');
      verifyResponseUrl(response, url);
      if (response.status === 401) throw new NetlifyTicketError('auth');
      if (response.status === 403) throw new NetlifyTicketError('forbidden');
      if (response.status === 429) throw new NetlifyTicketError('rate_limited');
      if (response.status === 408 || response.status >= 500) throw new NetlifyTicketError('network');
      if (!response.ok) throw new NetlifyTicketError('rejected');
      if (response.status !== expectedStatus) throw new NetlifyTicketError('invalid_response');
      bodyHandled = true;
      return await readBoundedJson(response, signal);
    } finally {
      if (response && !bodyHandled) discardResponse(response);
    }
  }, runtime.requestTimeoutMs, 'network');
}

function ticketFrom(value: JsonObject): Ticket {
  if (!safeIdentifier(value.id) || !safeIdentifier(value.client_id)
    || typeof value.authorized !== 'boolean'
    || value.created_at !== undefined && !safeTimestamp(value.created_at)) {
    throw new NetlifyTicketError('invalid_response');
  }
  return { id: value.id, clientId: value.client_id, authorized: value.authorized };
}

function assertSameTicket(ticket: Ticket, original: Ticket, clientId: string): void {
  if (ticket.id !== original.id || ticket.clientId !== clientId || ticket.clientId !== original.clientId) {
    throw new NetlifyTicketError('invalid_response');
  }
}

function createUrl(clientId: string): URL {
  const url = new URL(API_PREFIX, API_ORIGIN);
  url.searchParams.set('client_id', clientId);
  return url;
}

function ticketUrl(ticketId: string, exchange = false): URL {
  if (!safeIdentifier(ticketId)) throw new NetlifyTicketError('invalid_response');
  const suffix = exchange ? '/exchange' : '';
  return new URL(`${API_PREFIX}/${encodeURIComponent(ticketId)}${suffix}`, API_ORIGIN);
}

function authorizationUrl(ticketId: string): URL {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set('response_type', 'ticket');
  url.searchParams.set('ticket', ticketId);
  return url;
}

async function wait(runtime: Runtime): Promise<void> {
  throwIfStopped(runtime);
  const duration = Math.min(runtime.pollIntervalMs, remaining(runtime));
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const aborted = () => {
      if (settled) return;
      settled = true;
      runtime.clearTimer(handle);
      reject(new NetlifyTicketError('cancelled'));
    };
    const handle = runtime.setTimer(() => {
      if (settled) return;
      settled = true;
      runtime.dependencies.signal?.removeEventListener('abort', aborted);
      resolve();
    }, duration);
    runtime.dependencies.signal?.addEventListener('abort', aborted, { once: true });
    if (runtime.dependencies.signal?.aborted) aborted();
  });
  throwIfStopped(runtime);
}

/**
 * Completes Netlify's public-client OAuth ticket flow. The caller must supply
 * its own registered client ID and keep the returned token in main-process
 * secure storage; this function never logs or persists it.
 */
export async function authorizeNetlifyTicket(dependencies: NetlifyTicketDependencies): Promise<NetlifyTicketGrant> {
  const runtime = makeRuntime(dependencies);
  const created = ticketFrom(await fixedRequest(runtime, createUrl(runtime.clientId), 'POST', 201));
  if (created.clientId !== runtime.clientId || created.authorized) throw new NetlifyTicketError('invalid_response');

  await withBoundary(runtime, signal => dependencies.openExternal(authorizationUrl(created.id).toString(), signal),
    remaining(runtime), 'open_failed');
  throwIfStopped(runtime);

  let authorized: Ticket | undefined;
  for (let attempt = 0; attempt < runtime.maxPolls; attempt++) {
    const shown = ticketFrom(await fixedRequest(runtime, ticketUrl(created.id), 'GET', 200));
    assertSameTicket(shown, created, runtime.clientId);
    if (shown.authorized) { authorized = shown; break; }
    if (attempt + 1 < runtime.maxPolls) await wait(runtime);
  }
  if (!authorized) throw new NetlifyTicketError('timeout');
  throwIfStopped(runtime);

  const grant = await fixedRequest(runtime, ticketUrl(created.id, true), 'POST', 201);
  if (!safeToken(grant.access_token) || !safeIdentifier(grant.user_id)) {
    throw new NetlifyTicketError('invalid_response');
  }
  throwIfStopped(runtime);
  return { accessToken: grant.access_token, userId: grant.user_id };
}
