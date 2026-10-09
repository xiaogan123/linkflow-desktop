const API_ORIGIN = 'https://api.netlify.com';
const API_PREFIX = '/api/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TOTAL_TIMEOUT_MS = 2 * 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 5;

type TimerHandle = ReturnType<typeof setTimeout> | unknown;
type JsonObject = Record<string, unknown>;

export type NetlifyAccountTransport = (input: string, init: RequestInit) => Promise<Response>;

export interface NetlifyAccountDependencies {
  request?: NetlifyAccountTransport;
  signal?: AbortSignal;
  now?: () => number;
  setTimer?: (callback: () => void, milliseconds: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
  pageSize?: number;
  maxPages?: number;
}

export interface NetlifyAccountIdentity {
  id: string;
}

export interface NetlifyAccessibleProject {
  id: string;
  name?: string;
  teamId: string;
  publicUrl: string;
  readAccess: 'confirmed';
  deployPermission: 'unknown';
  publicVisibility: 'unverified';
  nonGitProductionBlocked: boolean;
}

export type NetlifyAccountErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'forbidden'
  | 'rate_limited'
  | 'rejected'
  | 'identity_mismatch'
  | 'limit'
  | 'invalid_response';

export class NetlifyAccountError extends Error {
  constructor(readonly code: NetlifyAccountErrorCode) {
    super(`Netlify account request failed: ${code}`);
  }
}

interface Runtime {
  dependencies: NetlifyAccountDependencies;
  deadline: number;
  now: () => number;
  setTimer: (callback: () => void, milliseconds: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  requestTimeoutMs: number;
  pageSize: number;
  maxPages: number;
}

function object(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value !== '.' && value !== '..' && /^[A-Za-z0-9._~-]+$/.test(value);
}

function token(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 8_192
    && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function name(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function integer(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.floor(value), 1), maximum)
    : fallback;
}

function runtime(dependencies: NetlifyAccountDependencies): Runtime {
  if (dependencies.signal?.aborted) throw new NetlifyAccountError('cancelled');
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  if (!Number.isFinite(startedAt)) throw new NetlifyAccountError('invalid_response');
  return {
    dependencies,
    deadline: startedAt + integer(dependencies.totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS, MAX_TOTAL_TIMEOUT_MS),
    now,
    setTimer: dependencies.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds)),
    clearTimer: dependencies.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    requestTimeoutMs: integer(dependencies.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS),
    pageSize: integer(dependencies.pageSize, DEFAULT_PAGE_SIZE, 100),
    maxPages: integer(dependencies.maxPages, DEFAULT_MAX_PAGES, 10),
  };
}

function remaining(value: Runtime): number {
  if (value.dependencies.signal?.aborted) throw new NetlifyAccountError('cancelled');
  const milliseconds = value.deadline - value.now();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new NetlifyAccountError('timeout');
  return milliseconds;
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { void promise.catch(() => undefined); reject(signal.reason); };
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      result => { signal.removeEventListener('abort', aborted); resolve(result); },
      error => { signal.removeEventListener('abort', aborted); reject(error); },
    );
  });
}

function discard(response: Response): void {
  if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new NetlifyAccountError('invalid_response');
  if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    discard(response);
    throw new NetlifyAccountError('invalid_response');
  }
  const advertised = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) {
    discard(response);
    throw new NetlifyAccountError('invalid_response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await waitFor(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new NetlifyAccountError('invalid_response');
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
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new NetlifyAccountError('invalid_response'); }
}

function verifyResponseUrl(response: Response, expected: URL): void {
  if (!response.url) return;
  try {
    const actual = new URL(response.url);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname
      || actual.search !== expected.search || actual.hash) throw new Error();
  } catch { throw new NetlifyAccountError('invalid_response'); }
}

function allowedApiUrl(url: URL): boolean {
  if (url.origin !== API_ORIGIN || url.username || url.password || url.port || url.hash) return false;
  if (url.pathname === `${API_PREFIX}/user`) return !url.search;
  if (url.pathname === `${API_PREFIX}/sites`) return true;
  return new RegExp(`^${API_PREFIX}/sites/[A-Za-z0-9._~-]{1,256}$`).test(url.pathname)
    && !url.pathname.endsWith('/.') && !url.pathname.endsWith('/..') && !url.search;
}

async function get(runtimeValue: Runtime, url: URL, accessToken: string): Promise<{ value: unknown; headers: Headers }> {
  if (!allowedApiUrl(url) || !token(accessToken)) throw new NetlifyAccountError('invalid_response');
  const controller = new AbortController();
  let expired = false;
  const externalAbort = () => controller.abort(new NetlifyAccountError('cancelled'));
  runtimeValue.dependencies.signal?.addEventListener('abort', externalAbort, { once: true });
  const duration = Math.min(runtimeValue.requestTimeoutMs, remaining(runtimeValue));
  const stageDeadline = runtimeValue.now() + duration;
  const timer = runtimeValue.setTimer(() => {
    expired = true;
    controller.abort(new NetlifyAccountError('timeout'));
  }, duration);
  let response: Response | undefined;
  let bodyHandled = false;
  try {
    const request = runtimeValue.dependencies.request ?? ((input: string, init: RequestInit) => fetch(input, init));
    const responsePromise = request(url.toString(), {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`, 'user-agent': 'Linkflow-Desktop' },
      redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
    });
    try { response = await waitFor(responsePromise, controller.signal); }
    catch {
      void responsePromise.then(discard, () => undefined);
      if (runtimeValue.dependencies.signal?.aborted) throw new NetlifyAccountError('cancelled');
      if (expired || runtimeValue.now() >= stageDeadline || runtimeValue.now() >= runtimeValue.deadline) {
        throw new NetlifyAccountError('timeout');
      }
      throw new NetlifyAccountError('network');
    }
    if (response.redirected || response.type === 'opaqueredirect') throw new NetlifyAccountError('invalid_response');
    verifyResponseUrl(response, url);
    if (response.status === 401) throw new NetlifyAccountError('auth');
    if (response.status === 403) throw new NetlifyAccountError('forbidden');
    if (response.status === 429) throw new NetlifyAccountError('rate_limited');
    if (response.status === 408 || response.status >= 500) throw new NetlifyAccountError('network');
    if (!response.ok) throw new NetlifyAccountError('rejected');
    if (response.status !== 200) throw new NetlifyAccountError('invalid_response');
    bodyHandled = true;
    const value = await boundedJson(response, controller.signal);
    if (runtimeValue.dependencies.signal?.aborted) throw new NetlifyAccountError('cancelled');
    if (expired || runtimeValue.now() >= stageDeadline || runtimeValue.now() >= runtimeValue.deadline) {
      throw new NetlifyAccountError('timeout');
    }
    return { value, headers: response.headers };
  } catch (error) {
    if (error instanceof NetlifyAccountError) throw error;
    throw new NetlifyAccountError('network');
  } finally {
    if (response && !bodyHandled) discard(response);
    runtimeValue.clearTimer(timer);
    runtimeValue.dependencies.signal?.removeEventListener('abort', externalAbort);
  }
}

function userUrl(): URL { return new URL(`${API_PREFIX}/user`, API_ORIGIN); }

function sitesUrl(page: number, pageSize: number): URL {
  const url = new URL(`${API_PREFIX}/sites`, API_ORIGIN);
  url.searchParams.set('filter', 'all');
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(pageSize));
  return url;
}

function siteUrl(siteId: string): URL {
  if (!identifier(siteId)) throw new NetlifyAccountError('invalid_response');
  return new URL(`${API_PREFIX}/sites/${encodeURIComponent(siteId)}`, API_ORIGIN);
}

function publicNetlifyUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_048) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || url.pathname !== '/' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.netlify\.app$/.test(url.hostname)) return;
    return url.toString();
  } catch { return; }
}

function project(value: unknown): NetlifyAccessibleProject | undefined {
  if (!object(value) || !identifier(value.id) || !identifier(value.account_id)) return;
  const publicUrl = publicNetlifyUrl(value.ssl_url);
  if (!publicUrl) return;
  if (value.name !== undefined && !name(value.name)) return;
  if (value.prevent_non_git_prod_deploys !== undefined && typeof value.prevent_non_git_prod_deploys !== 'boolean') return;
  return {
    id: value.id,
    ...(value.name === undefined ? {} : { name: value.name }),
    teamId: value.account_id,
    publicUrl,
    readAccess: 'confirmed',
    deployPermission: 'unknown',
    publicVisibility: 'unverified',
    nonGitProductionBlocked: value.prevent_non_git_prod_deploys === true,
  };
}

function hasNext(headers: Headers, currentPage: number, pageSize: number, fullPage: boolean): boolean {
  const link = headers.get('link');
  if (!link) return fullPage;
  const part = link.split(',').find(item => /;\s*rel="?next"?(?:\s*;|\s*$)/i.test(item));
  if (!part) return false;
  const match = part.match(/^\s*<([^>]+)>/);
  if (!match) throw new NetlifyAccountError('invalid_response');
  try {
    const url = new URL(match[1]);
    const keys = [...url.searchParams.keys()];
    if (url.origin !== API_ORIGIN || url.pathname !== `${API_PREFIX}/sites` || url.username || url.password || url.port || url.hash
      || keys.some(key => !['filter', 'page', 'per_page'].includes(key))
      || !['', 'all'].includes(url.searchParams.get('filter') ?? '')
      || url.searchParams.get('page') !== String(currentPage + 1)
      || url.searchParams.get('per_page') !== String(pageSize)) throw new Error();
  } catch { throw new NetlifyAccountError('invalid_response'); }
  return true;
}

export async function getNetlifyAccountIdentity(
  accessToken: string,
  expectedUserId: string,
  dependencies: NetlifyAccountDependencies = {},
): Promise<NetlifyAccountIdentity> {
  if (!identifier(expectedUserId)) throw new NetlifyAccountError('identity_mismatch');
  const response = await get(runtime(dependencies), userUrl(), accessToken);
  if (!object(response.value) || !identifier(response.value.id)) throw new NetlifyAccountError('invalid_response');
  if (response.value.id !== expectedUserId) throw new NetlifyAccountError('identity_mismatch');
  return { id: response.value.id };
}

export async function listNetlifyAccessibleProjects(
  accessToken: string,
  dependencies: NetlifyAccountDependencies = {},
): Promise<NetlifyAccessibleProject[]> {
  const value = runtime(dependencies);
  const projects = new Map<string, NetlifyAccessibleProject>();
  const pageSignatures = new Set<string>();
  for (let page = 1; page <= value.maxPages; page++) {
    const response = await get(value, sitesUrl(page, value.pageSize), accessToken);
    if (!Array.isArray(response.value)) throw new NetlifyAccountError('invalid_response');
    const signature = response.value.map(item => object(item) && typeof item.id === 'string' ? item.id : '?').join('\u0000');
    if (response.value.length === value.pageSize && pageSignatures.has(signature)) throw new NetlifyAccountError('limit');
    pageSignatures.add(signature);
    for (const item of response.value) {
      const parsed = project(item);
      if (!parsed) continue;
      const old = projects.get(parsed.id);
      if (old && JSON.stringify(old) !== JSON.stringify(parsed)) throw new NetlifyAccountError('invalid_response');
      projects.set(parsed.id, parsed);
    }
    const next = hasNext(response.headers, page, value.pageSize, response.value.length === value.pageSize);
    if (!next) return [...projects.values()];
    if (page === value.maxPages) throw new NetlifyAccountError('limit');
  }
  throw new NetlifyAccountError('limit');
}

export async function getNetlifyAccessibleProject(
  accessToken: string,
  siteId: string,
  dependencies: NetlifyAccountDependencies = {},
): Promise<NetlifyAccessibleProject> {
  const response = await get(runtime(dependencies), siteUrl(siteId), accessToken);
  const parsed = project(response.value);
  if (!parsed || parsed.id !== siteId) throw new NetlifyAccountError('invalid_response');
  return parsed;
}
