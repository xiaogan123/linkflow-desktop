import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Account, AccountDiagnostic, ExecutionContext, ExecutionResult, SecretStore, Task } from '../shared/types';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const API_ORIGIN = 'https://www.googleapis.com';
const API_PREFIX = '/blogger/v3';
export const BLOGGER_SCOPE = 'https://www.googleapis.com/auth/blogger';
const REQUEST_TIMEOUT_MS = 15_000;
const OAUTH_TIMEOUT_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_CLIENT_FILE_BYTES = 64 * 1024;
const MAX_ARTICLE_BYTES = 256 * 1024;
const RECONCILE_PAGE_SIZE = 50;
const RECONCILE_MAX_PAGES_PER_STATUS = 2;
const RECONCILE_STATUSES = ['draft', 'live', 'scheduled'] as const;

type JsonObject = Record<string, unknown>;
type BloggerStage = NonNullable<Task['blogger']>['stage'];
type PostStatus = 'draft' | 'live' | 'scheduled';

export type BloggerTransport = (input: string, init: RequestInit) => Promise<Response>;
export interface BloggerDependencies {
  request?: BloggerTransport;
  now?: () => Date;
  timeoutMs?: number;
  signal?: AbortSignal;
  uuid?: () => string;
}

export interface BloggerDesktopClient {
  clientId: string;
  clientSecret?: string;
}

export interface BloggerBlog {
  id: string;
  name: string;
  url: string;
}

export interface BloggerIdentity {
  id: string;
  displayName: string;
}

interface BloggerStoredCredential {
  version: 1;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: string;
  scope: typeof BLOGGER_SCOPE;
  userId: string;
}

interface BloggerPost {
  id: string;
  blogId: string;
  status: PostStatus;
  title: string;
  content: string;
  url?: string;
}

interface ArticlePayload {
  title: string;
  baseContent: string;
  contentHash: string;
  content: (operationId: string) => string;
}

export type BloggerErrorCode = 'auth' | 'forbidden' | 'rate_limited' | 'timeout' | 'cancelled' | 'network' | 'rejected' | 'invalid_response';
export class BloggerError extends Error {
  constructor(readonly code: BloggerErrorCode) {
    super(`Blogger request failed: ${code}`);
  }
}

export interface BloggerLoopback {
  redirectUri: string;
  wait(): Promise<URL>;
  close(): Promise<void>;
}

export type BloggerLoopbackFactory = (options: { signal?: AbortSignal; timeoutMs: number }) => Promise<BloggerLoopback>;

function now(dependencies?: BloggerDependencies): Date {
  const value = dependencies?.now?.() ?? new Date();
  return Number.isFinite(value.getTime()) ? value : new Date();
}

function stamp(dependencies?: BloggerDependencies): string {
  return now(dependencies).toISOString();
}

function diagnostic(code: AccountDiagnostic['code'], message: string, dependencies?: BloggerDependencies): AccountDiagnostic {
  return { code, message, at: stamp(dependencies), retryable: false };
}

function object(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max: number, min = 1): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function articleText(value: unknown, max: number, min: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
    && !/\r|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function numericId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{1,64}$/.test(value);
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function transport(dependencies?: BloggerDependencies): BloggerTransport {
  return dependencies?.request ?? ((input, init) => fetch(input, init));
}

function boundedTimeout(dependencies?: BloggerDependencies): number {
  return Math.min(Math.max(dependencies?.timeoutMs ?? REQUEST_TIMEOUT_MS, 100), 60_000);
}

async function readBoundedJson(response: Response): Promise<JsonObject> {
  const advertised = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) throw new BloggerError('invalid_response');
  if (!response.body) throw new BloggerError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new BloggerError('invalid_response');
      chunks.push(next.value);
    }
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
    if (error instanceof BloggerError) throw error;
    throw new BloggerError('invalid_response');
  }
}

function verifyResponseUrl(response: Response, expected: URL): void {
  if (!response.url) return;
  try {
    const actual = new URL(response.url);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.search !== expected.search || actual.hash) {
      throw new Error('mismatch');
    }
  } catch { throw new BloggerError('invalid_response'); }
}

async function fixedRequest(
  url: URL,
  init: RequestInit,
  dependencies?: BloggerDependencies,
  allowEmpty = false,
): Promise<JsonObject> {
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new BloggerError('invalid_response');
  if (dependencies?.signal?.aborted) throw new BloggerError('cancelled');
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(dependencies?.signal?.reason);
  dependencies?.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, boundedTimeout(dependencies));
  timer.unref?.();
  try {
    let response: Response;
    try {
      response = await transport(dependencies)(url.toString(), {
        ...init,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
    } catch {
      if (dependencies?.signal?.aborted) throw new BloggerError('cancelled');
      if (timedOut) throw new BloggerError('timeout');
      throw new BloggerError('network');
    }
    if (response.redirected) throw new BloggerError('invalid_response');
    verifyResponseUrl(response, url);
    if (response.status === 401) throw new BloggerError('auth');
    if (response.status === 403) throw new BloggerError('forbidden');
    if (response.status === 429) throw new BloggerError('rate_limited');
    if (response.status === 408 || response.status >= 500) throw new BloggerError('network');
    if (!response.ok) throw new BloggerError('rejected');
    if (allowEmpty) return {};
    try { return await readBoundedJson(response); }
    catch (error) {
      if (error instanceof BloggerError) throw error;
      if (dependencies?.signal?.aborted) throw new BloggerError('cancelled');
      if (timedOut) throw new BloggerError('timeout');
      throw new BloggerError('network');
    }
  } finally {
    clearTimeout(timer);
    dependencies?.signal?.removeEventListener('abort', abort);
  }
}

function apiUrl(path: string, parameters: Record<string, string> = {}): URL {
  if (!/^\/(?:users\/self(?:\/blogs(?:\/[0-9]{1,64})?)?|blogs\/[0-9]{1,64}\/posts(?:\/[0-9]{1,64}(?:\/publish)?)?)$/.test(path)) {
    throw new BloggerError('invalid_response');
  }
  const url = new URL(`${API_PREFIX}${path}`, API_ORIGIN);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url;
}

async function apiRequest(
  path: string,
  accessToken: string,
  options: { method?: 'GET' | 'POST'; query?: Record<string, string>; body?: JsonObject },
  dependencies?: BloggerDependencies,
): Promise<JsonObject> {
  if (!validToken(accessToken)) throw new BloggerError('auth');
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${accessToken}`,
    'user-agent': 'Linkflow-Desktop',
  };
  if (options.body) headers['content-type'] = 'application/json';
  return fixedRequest(apiUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  }, dependencies);
}

async function tokenRequest(parameters: URLSearchParams, dependencies?: BloggerDependencies): Promise<JsonObject> {
  try {
    return await fixedRequest(new URL(TOKEN_ENDPOINT), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Linkflow-Desktop' },
      body: parameters.toString(),
    }, dependencies);
  } catch (error) {
    if (error instanceof BloggerError && error.code === 'rejected') throw new BloggerError('auth');
    throw error;
  }
}

function canonicalPublicUrl(value: unknown, httpsOnly = false): string {
  if (typeof value !== 'string' || value.length > 2048) throw new BloggerError('invalid_response');
  try {
    const url = new URL(value);
    if ((httpsOnly ? url.protocol !== 'https:' : !['https:', 'http:'].includes(url.protocol)) || url.username || url.password || url.hash || !url.hostname) {
      throw new Error('invalid');
    }
    return url.toString();
  } catch { throw new BloggerError('invalid_response'); }
}

export function parseBloggerDesktopClient(input: string | unknown): BloggerDesktopClient {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_CLIENT_FILE_BYTES) throw new Error('Google OAuth 客户端文件过大');
    try { parsed = JSON.parse(input); }
    catch { throw new Error('Google OAuth 客户端 JSON 无法解析'); }
  }
  if (!object(parsed) || 'web' in parsed || !object(parsed.installed)) {
    throw new Error('请选择 Google Cloud 生成的 Desktop app OAuth 客户端 JSON；不接受 Web application 客户端');
  }
  const installed = parsed.installed as JsonObject;
  if (!boundedString(installed.client_id, 512) || !installed.client_id.endsWith('.apps.googleusercontent.com')) {
    throw new Error('Desktop OAuth 客户端 ID 无效');
  }
  if (installed.auth_uri !== undefined && installed.auth_uri !== AUTHORIZATION_ENDPOINT && installed.auth_uri !== 'https://accounts.google.com/o/oauth2/auth') {
    throw new Error('Desktop OAuth 文件包含非官方授权端点');
  }
  if (installed.token_uri !== undefined && installed.token_uri !== TOKEN_ENDPOINT) throw new Error('Desktop OAuth 文件包含非官方令牌端点');
  if (installed.redirect_uris !== undefined && (!Array.isArray(installed.redirect_uris)
    || !installed.redirect_uris.some(value => value === 'http://localhost' || value === 'http://127.0.0.1'))) {
    throw new Error('Desktop OAuth 文件不支持本机回环授权');
  }
  const clientSecret = installed.client_secret;
  if (clientSecret !== undefined && !boundedString(clientSecret, 512)) throw new Error('Desktop OAuth 客户端 secret 无效');
  return { clientId: installed.client_id, ...(typeof clientSecret === 'string' ? { clientSecret } : {}) };
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    if (!server.listening) { resolve(); return; }
    server.close(() => resolve());
  });
}

export async function createBloggerLoopback(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<BloggerLoopback> {
  if (options.signal?.aborted) throw new BloggerError('cancelled');
  let settle!: (url: URL) => void;
  let reject!: (error: Error) => void;
  let done = false;
  let expectedHost = '';
  const result = new Promise<URL>((resolve, fail) => { settle = resolve; reject = fail; });
  const server = createServer((request, response) => {
    if (done || request.method !== 'GET' || request.url === '/favicon.ico' || request.headers.host !== expectedHost) {
      response.writeHead(request.url === '/favicon.ico' ? 204 : 404, { 'cache-control': 'no-store' });
      response.end();
      return;
    }
    let callback: URL;
    try {
      if (!request.url || request.url.length > 8192 || !request.url.startsWith('/?')) throw new Error('invalid callback');
      callback = new URL(request.url, `http://${expectedHost}`);
    } catch {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('Invalid OAuth callback.');
      return;
    }
    done = true;
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
    });
    response.end('<!doctype html><meta charset="utf-8"><title>Linkflow</title><p>Authorization received. You can close this page and return to Linkflow.</p>');
    settle(callback);
  });
  server.on('error', error => {
    if (!done) { done = true; reject(error instanceof Error ? error : new Error('loopback failed')); }
  });
  await new Promise<void>((resolve, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', fail); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
    await closeServer(server);
    throw new Error('无法建立安全的本机 OAuth 回调');
  }
  expectedHost = `127.0.0.1:${address.port}`;
  const timeout = Math.min(Math.max(options.timeoutMs ?? OAUTH_TIMEOUT_MS, 1_000), 10 * 60_000);
  const cancel = () => {
    if (!done) { done = true; reject(new BloggerError('cancelled')); }
    void closeServer(server);
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    if (!done) { done = true; reject(new BloggerError('timeout')); }
    void closeServer(server);
  }, timeout);
  timer.unref?.();
  return {
    redirectUri: `http://${expectedHost}`,
    wait: () => result,
    close: async () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      await closeServer(server);
    },
  };
}

function identityFrom(value: JsonObject): BloggerIdentity {
  if (value.kind !== 'blogger#user' || !numericId(value.id) || !boundedString(value.displayName, 512, 0)) {
    throw new BloggerError('invalid_response');
  }
  return { id: value.id, displayName: value.displayName };
}

function blogFrom(value: JsonObject): BloggerBlog {
  if (value.kind !== 'blogger#blog' || !numericId(value.id) || !boundedString(value.name, 1024, 0)) throw new BloggerError('invalid_response');
  // The official v3 examples still show HTTP publication URLs. These are
  // resource data returned over the fixed HTTPS API endpoint, not endpoints
  // used for credentials, so retain either public HTTP(S) scheme.
  return { id: value.id, name: value.name, url: canonicalPublicUrl(value.url) };
}

function blogListFrom(value: JsonObject): BloggerBlog[] {
  if (value.kind !== 'blogger#blogList') throw new BloggerError('invalid_response');
  const raw: unknown[] = [];
  if (value.items !== undefined) {
    if (!Array.isArray(value.items)) throw new BloggerError('invalid_response');
    raw.push(...value.items);
  }
  if (value.blogUserInfos !== undefined) {
    if (!Array.isArray(value.blogUserInfos)) throw new BloggerError('invalid_response');
    for (const item of value.blogUserInfos) {
      if (!object(item) || !object(item.blog)) throw new BloggerError('invalid_response');
      raw.push(item.blog);
    }
  }
  const blogs = raw.map(item => {
    if (!object(item)) throw new BloggerError('invalid_response');
    return blogFrom(item);
  });
  const unique = new Map<string, BloggerBlog>();
  for (const blog of blogs) {
    const previous = unique.get(blog.id);
    if (previous && (previous.url !== blog.url || previous.name !== blog.name)) throw new BloggerError('invalid_response');
    unique.set(blog.id, blog);
  }
  return [...unique.values()];
}

export async function getBloggerIdentity(accessToken: string, dependencies?: BloggerDependencies): Promise<BloggerIdentity> {
  return identityFrom(await apiRequest('/users/self', accessToken, {}, dependencies));
}

export async function getBloggerBlogs(accessToken: string, dependencies?: BloggerDependencies): Promise<BloggerBlog[]> {
  const result = await apiRequest('/users/self/blogs', accessToken, {
    query: { fetchUserInfo: 'true', view: 'ADMIN' },
  }, dependencies);
  return blogListFrom(result);
}

export async function verifyBloggerBlog(
  accessToken: string,
  expectedUserId: string,
  expectedBlogId: string,
  dependencies?: BloggerDependencies,
): Promise<BloggerBlog> {
  if (!numericId(expectedUserId) || !numericId(expectedBlogId)) throw new BloggerError('invalid_response');
  const result = await apiRequest(`/users/self/blogs/${expectedBlogId}`, accessToken, {}, dependencies);
  if (result.kind !== 'blogger#blogUserInfo' || !object(result.blog) || !object(result.blog_user_info)) throw new BloggerError('invalid_response');
  const info = result.blog_user_info as JsonObject;
  if (info.kind !== 'blogger#blogPerUserInfo' || info.userId !== expectedUserId || info.blogId !== expectedBlogId || info.hasAdminAccess !== true) {
    throw new BloggerError('forbidden');
  }
  const blog = blogFrom(result.blog as JsonObject);
  if (blog.id !== expectedBlogId) throw new BloggerError('invalid_response');
  return blog;
}

function tokenScope(value: unknown): boolean {
  return typeof value === 'string' && value.split(/\s+/).includes(BLOGGER_SCOPE);
}

function credentialFrom(value: unknown): BloggerStoredCredential {
  if (typeof value === 'string') {
    if (value.length > 16_384) throw new BloggerError('auth');
    try { value = JSON.parse(value); }
    catch { throw new BloggerError('auth'); }
  }
  if (!object(value) || value.version !== 1 || !boundedString(value.clientId, 512)
    || (value.clientSecret !== undefined && !boundedString(value.clientSecret, 512))
    || !validToken(value.refreshToken) || !validToken(value.accessToken)
    || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))
    || value.scope !== BLOGGER_SCOPE || !numericId(value.userId)) throw new BloggerError('auth');
  return value as unknown as BloggerStoredCredential;
}

export async function readBloggerCredential(secrets: SecretStore, accountId: string): Promise<BloggerStoredCredential> {
  let raw: string | undefined;
  try { raw = await secrets.get(`account:${accountId}`); }
  catch { throw new BloggerError('auth'); }
  if (!raw || raw.length > 16_384) throw new BloggerError('auth');
  try { return credentialFrom(raw); }
  catch { throw new BloggerError('auth'); }
}

async function storeBloggerCredential(secrets: SecretStore, accountId: string, credential: BloggerStoredCredential): Promise<void> {
  await secrets.set(`account:${accountId}`, JSON.stringify(credential));
}

export async function currentBloggerAccessToken(
  secrets: SecretStore,
  accountId: string,
  dependencies?: BloggerDependencies,
): Promise<{ accessToken: string; credential: BloggerStoredCredential } | undefined> {
  const credential = await readBloggerCredential(secrets, accountId);
  if (Date.parse(credential.expiresAt) <= now(dependencies).getTime() + 5_000) return undefined;
  return { accessToken: credential.accessToken, credential };
}

export async function getBloggerAccessToken(
  secrets: SecretStore,
  accountId: string,
  dependencies?: BloggerDependencies,
): Promise<{ accessToken: string; credential: BloggerStoredCredential }> {
  const current = await currentBloggerAccessToken(secrets, accountId, dependencies);
  if (current && Date.parse(current.credential.expiresAt) > now(dependencies).getTime() + 60_000) return current;
  const credential = current?.credential ?? await readBloggerCredential(secrets, accountId);
  const parameters = new URLSearchParams({
    client_id: credential.clientId,
    refresh_token: credential.refreshToken,
    grant_type: 'refresh_token',
  });
  if (credential.clientSecret) parameters.set('client_secret', credential.clientSecret);
  const response = await tokenRequest(parameters, dependencies);
  if (!validToken(response.access_token) || response.token_type !== 'Bearer'
    || !Number.isSafeInteger(response.expires_in) || (response.expires_in as number) < 60 || (response.expires_in as number) > 86_400
    || (response.scope !== undefined && !tokenScope(response.scope))) throw new BloggerError('auth');
  const updated: BloggerStoredCredential = {
    ...credential,
    accessToken: response.access_token,
    expiresAt: new Date(now(dependencies).getTime() + (response.expires_in as number) * 1_000).toISOString(),
  };
  await storeBloggerCredential(secrets, accountId, updated);
  return { accessToken: updated.accessToken, credential: updated };
}

export async function authorizeBlogger(
  client: BloggerDesktopClient,
  openExternal: (url: string) => Promise<unknown>,
  options: BloggerDependencies & { createLoopback?: BloggerLoopbackFactory; oauthTimeoutMs?: number } = {},
): Promise<{ credential: BloggerStoredCredential; identity: BloggerIdentity; blogs: BloggerBlog[] }> {
  if (options.signal?.aborted) throw new BloggerError('cancelled');
  const state = base64Url(randomBytes(32));
  const verifier = base64Url(randomBytes(64));
  const challenge = base64Url(createHash('sha256').update(verifier, 'ascii').digest());
  const loopback = await (options.createLoopback ?? (async value => createBloggerLoopback(value)))({
    signal: options.signal,
    timeoutMs: Math.min(Math.max(options.oauthTimeoutMs ?? OAUTH_TIMEOUT_MS, 1_000), 10 * 60_000),
  });
  try {
    const redirect = new URL(loopback.redirectUri);
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || redirect.username || redirect.password || redirect.search || redirect.hash) {
      throw new Error('OAuth 回调必须使用 127.0.0.1 随机端口');
    }
    const authorization = new URL(AUTHORIZATION_ENDPOINT);
    authorization.searchParams.set('client_id', client.clientId);
    authorization.searchParams.set('redirect_uri', redirect.toString());
    authorization.searchParams.set('response_type', 'code');
    authorization.searchParams.set('scope', BLOGGER_SCOPE);
    authorization.searchParams.set('state', state);
    authorization.searchParams.set('code_challenge', challenge);
    authorization.searchParams.set('code_challenge_method', 'S256');
    authorization.searchParams.set('access_type', 'offline');
    authorization.searchParams.set('prompt', 'consent');
    await openExternal(authorization.toString());
    const callback = await loopback.wait();
    if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || callback.hash) throw new Error('OAuth 回调地址不匹配');
    if (callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== state) throw new Error('OAuth state 校验失败，请重新连接');
    if (callback.searchParams.has('error')) {
      const denied = callback.searchParams.get('error') === 'access_denied';
      throw new Error(denied ? '已取消 Blogger 授权' : 'Google 未完成 Blogger 授权');
    }
    const code = callback.searchParams.get('code');
    if (callback.searchParams.getAll('code').length !== 1 || !boundedString(code, 4096)) throw new Error('OAuth 回调没有有效授权码');
    const parameters = new URLSearchParams({
      client_id: client.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirect.toString(),
      grant_type: 'authorization_code',
    });
    if (client.clientSecret) parameters.set('client_secret', client.clientSecret);
    const response = await tokenRequest(parameters, options);
    if (!validToken(response.access_token) || !validToken(response.refresh_token) || response.token_type !== 'Bearer'
      || !Number.isSafeInteger(response.expires_in) || (response.expires_in as number) < 60 || (response.expires_in as number) > 86_400
      || !tokenScope(response.scope)) throw new BloggerError('auth');
    const identity = await getBloggerIdentity(response.access_token, options);
    const blogs = await getBloggerBlogs(response.access_token, options);
    return {
      credential: {
        version: 1,
        clientId: client.clientId,
        ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
        refreshToken: response.refresh_token,
        accessToken: response.access_token,
        expiresAt: new Date(now(options).getTime() + (response.expires_in as number) * 1_000).toISOString(),
        scope: BLOGGER_SCOPE,
        userId: identity.id,
      },
      identity,
      blogs,
    };
  } finally {
    await loopback.close();
  }
}

export async function saveAuthorizedBloggerCredential(secrets: SecretStore, accountId: string, credential: unknown): Promise<void> {
  await storeBloggerCredential(secrets, accountId, credentialFrom(credential));
}

export async function revokeBloggerCredential(credential: unknown, dependencies?: BloggerDependencies): Promise<void> {
  const parsed = credentialFrom(credential);
  const parameters = new URLSearchParams({ token: parsed.refreshToken });
  try {
    await fixedRequest(new URL(REVOKE_ENDPOINT), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Linkflow-Desktop' },
      body: parameters.toString(),
    }, dependencies, true);
  } catch (error) {
    if (error instanceof BloggerError && (error.code === 'auth' || error.code === 'rejected')) return;
    throw error;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function articlePayload(context: ExecutionContext, requireApproval: boolean): ArticlePayload {
  const draft = context.task.draft;
  if (!draft) throw new Error('请先生成并核对 Blogger 文章草稿');
  if (requireApproval && !context.task.articleApprovedAt && context.task.articleReview?.status !== 'passed') {
    throw new Error('文章尚未通过独立核对，不会发布到 Blogger');
  }
  if (!boundedString(draft.title, 256, 4) || !articleText(draft.description, 3_000, 1)
    || !articleText(draft.body, 100_000, 200) || !boundedString(context.site.name, 512, 1)) {
    throw new Error('Blogger 文章内容不符合发布长度或字符要求');
  }
  const homepage = canonicalPublicUrl(context.site.url, true);
  const paragraphs = draft.body.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
  if (paragraphs.length < 2) throw new Error('Blogger 文章需要至少两个有实际信息的段落');
  const description = `<p>${escapeHtml(draft.description)}</p>`;
  const body = paragraphs.map(paragraph => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('\n');
  const attribution = `<p><strong>Author:</strong> ${escapeHtml(context.site.name)}</p>`;
  const backlink = `<p><a href="${escapeHtml(homepage)}" rel="nofollow">${escapeHtml(context.site.name)}</a></p>`;
  const baseContent = [description, body, attribution, backlink].join('\n');
  const contentHash = sha256(`${draft.title}\u0000${baseContent}`);
  const content = (operationId: string) => `<div data-linkflow-operation="${escapeHtml(operationId)}" data-linkflow-content-sha256="${contentHash}">\n${baseContent}\n</div>`;
  if (Buffer.byteLength(content('00000000-0000-4000-8000-000000000000'), 'utf8') > MAX_ARTICLE_BYTES) throw new Error('Blogger 文章内容过大');
  return { title: draft.title, baseContent, contentHash, content };
}

function approvedArticle(context: ExecutionContext): ArticlePayload {
  return articlePayload(context, true);
}

function postFrom(value: JsonObject, expectedBlogId: string, fallbackStatus?: PostStatus): BloggerPost {
  if (value.kind !== 'blogger#post' || !numericId(value.id) || !object(value.blog) || (value.blog as JsonObject).id !== expectedBlogId
    || !boundedString(value.title, 256, 0) || typeof value.content !== 'string' || value.content.length > MAX_ARTICLE_BYTES) {
    throw new BloggerError('invalid_response');
  }
  const status = typeof value.status === 'string' ? value.status.toLowerCase() : fallbackStatus ?? '';
  if (!RECONCILE_STATUSES.includes(status as typeof RECONCILE_STATUSES[number])) throw new BloggerError('invalid_response');
  const url = value.url === undefined ? undefined : canonicalPublicUrl(value.url);
  return { id: value.id, blogId: expectedBlogId, status: status as PostStatus, title: value.title, content: value.content, ...(url ? { url } : {}) };
}

function exactPost(post: BloggerPost, title: string, content: string, operationId: string): boolean {
  const marker = `data-linkflow-operation="${operationId}"`;
  return post.title === title && post.content === content && post.content.includes(marker);
}

async function getPost(blogId: string, postId: string, token: string, dependencies?: BloggerDependencies): Promise<BloggerPost> {
  if (!numericId(postId)) throw new BloggerError('invalid_response');
  return postFrom(await apiRequest(`/blogs/${blogId}/posts/${postId}`, token, { query: { view: 'ADMIN' } }, dependencies), blogId);
}

async function findExactPost(
  blogId: string,
  token: string,
  title: string,
  content: string,
  operationId: string,
  dependencies?: BloggerDependencies,
): Promise<BloggerPost | undefined> {
  const matches: BloggerPost[] = [];
  for (const status of RECONCILE_STATUSES) {
    let pageToken: string | undefined;
    for (let page = 0; page < RECONCILE_MAX_PAGES_PER_STATUS; page++) {
      // The discovery document defines the repeated status enum with uppercase
      // wire values (DRAFT, LIVE and SCHEDULED). Keep the normalized internal
      // representation lowercase, but always send the documented wire value.
      const query: Record<string, string> = { status: status.toUpperCase(), view: 'ADMIN', fetchBodies: 'true', maxResults: String(RECONCILE_PAGE_SIZE) };
      if (pageToken) query.pageToken = pageToken;
      const response = await apiRequest(`/blogs/${blogId}/posts`, token, { query }, dependencies);
      if (response.kind !== 'blogger#postList' || (response.items !== undefined && !Array.isArray(response.items))) throw new BloggerError('invalid_response');
      for (const item of (response.items as unknown[] | undefined) ?? []) {
        if (!object(item)) throw new BloggerError('invalid_response');
        const post = postFrom(item, blogId);
        if (post.status !== status) throw new BloggerError('invalid_response');
        if (exactPost(post, title, content, operationId)) matches.push(post);
      }
      const next = response.nextPageToken;
      if (next === undefined) { pageToken = undefined; break; }
      if (!boundedString(next, 1024)) throw new BloggerError('invalid_response');
      pageToken = next;
    }
    if (pageToken) return undefined;
  }
  const unique = new Map(matches.map(post => [post.id, post]));
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

function failureMessage(error: unknown, phase: 'verify' | 'insert' | 'publish' | 'read'): string {
  if (!(error instanceof BloggerError)) return 'Blogger 请求失败，未输出远端错误详情';
  if (error.code === 'cancelled') return phase === 'insert' || phase === 'publish' ? 'Blogger 提交期间任务已暂停，结果需要对账' : 'Blogger 操作已取消';
  if (error.code === 'auth') return 'Blogger OAuth 授权已失效，请重新连接原 Google 身份';
  if (error.code === 'forbidden') return 'Google 拒绝 Blogger 写入权限，请确认 API 已启用且账号是该博客管理员';
  if (error.code === 'rate_limited') return 'Blogger API 已触发速率限制，请稍后只进行对账';
  if (error.code === 'timeout') return 'Blogger 请求超时，提交结果不会自动重做';
  if (error.code === 'network') return 'Blogger 网络或服务暂时不可用，提交结果不会自动重做';
  if (error.code === 'rejected') return 'Blogger 明确拒绝了请求，请检查博客状态与内容';
  return 'Blogger 返回了无法安全确认的结果';
}

async function markAccountError(context: ExecutionContext, account: Account, error: unknown, dependencies?: BloggerDependencies): Promise<void> {
  if (!(error instanceof BloggerError) || !['auth', 'forbidden'].includes(error.code)) return;
  const restricted = error.code === 'forbidden';
  await context.saveAccount({
    ...account,
    status: restricted ? 'restricted' : 'credentials_invalid',
    diagnostic: diagnostic(restricted ? 'restricted' : 'bad_password', restricted
      ? 'Google 拒绝了 Blogger 权限或该身份不再具有博客管理权限。'
      : 'Blogger OAuth 授权已失效或不属于原连接身份。', dependencies),
    updatedAt: stamp(dependencies),
  });
}

function resultForFailure(error: unknown, phase: 'verify' | 'insert' | 'publish' | 'read', task: Task): ExecutionResult {
  const submitted = !!task.submittedAt || phase === 'insert' || phase === 'publish';
  if (error instanceof BloggerError && error.code === 'cancelled' && !submitted) return { status: 'queued', message: '任务已暂停，尚未向 Blogger 提交' };
  return {
    status: submitted ? 'needs_input' : error instanceof BloggerError && ['rate_limited', 'timeout', 'network'].includes(error.code) ? 'failed' : 'needs_input',
    message: failureMessage(error, phase),
  };
}

async function verifiedPublisherAccess(
  context: ExecutionContext,
  account: Account,
  blogId: string,
  dependencies?: BloggerDependencies,
): Promise<{ token: string; blog: BloggerBlog }> {
  const access = await getBloggerAccessToken(context.secrets, account.id, { ...dependencies, signal: context.signal });
  if (access.credential.userId !== account.username) throw new BloggerError('auth');
  const identity = await getBloggerIdentity(access.accessToken, { ...dependencies, signal: context.signal });
  if (identity.id !== account.username) throw new BloggerError('auth');
  const blog = await verifyBloggerBlog(access.accessToken, identity.id, blogId, { ...dependencies, signal: context.signal });
  await context.saveAccount({ ...account, status: 'registered', verifiedAt: stamp(dependencies), lastUsedAt: stamp(dependencies), updatedAt: stamp(dependencies), diagnostic: undefined });
  return { token: access.accessToken, blog };
}

function sameBoundBlog(context: ExecutionContext, blog: BloggerBlog): boolean {
  try { return context.site.blogger?.blogId === blog.id && canonicalPublicUrl(context.site.blogger.url) === blog.url; }
  catch { return false; }
}

function bloggerState(blogId: string, operationId: string, contentHash: string, stage: BloggerStage, postId?: string): NonNullable<Task['blogger']> {
  return { blogId, operationId, contentHash, stage, ...(postId ? { postId } : {}) };
}

function validBloggerState(value: NonNullable<Task['blogger']>): boolean {
  return numericId(value.blogId)
    && (value.postId === undefined || numericId(value.postId))
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.operationId)
    && /^[0-9a-f]{64}$/i.test(value.contentHash)
    && ['inserting', 'draft', 'publishing', 'published'].includes(value.stage);
}

export async function reconcileBloggerTask(
  context: ExecutionContext,
  dependencies: BloggerDependencies = {},
): Promise<
  | { status: 'found'; publicUrl: string }
  | { status: 'draft'; blogger: NonNullable<Task['blogger']> }
  | { status: 'unknown' }
> {
  const unknown = { status: 'unknown' as const };
  const state = context.task.blogger;
  const account = context.getAccount();
  if (context.signal.aborted || context.channel.id !== 'blogger' || context.task.channelId !== 'blogger'
    || !state || !validBloggerState(state) || context.task.publicUrl || !context.task.accountId
    || !account || account.id !== context.task.accountId || account.channelId !== 'blogger' || account.credentialKind !== 'oauth'
    || account.status !== 'registered' || !account.hasPassword || !context.site.blogger || context.site.blogger.blogId !== state.blogId) return unknown;
  let article: ArticlePayload;
  // Reconciliation is a bounded, read-only ownership check. Restored or
  // paused tasks intentionally lose publication approval, so requiring a
  // current approval here would prevent recovery of the already submitted
  // operation. Publishing still calls approvedArticle below.
  try { article = articlePayload(context, false); }
  catch { return unknown; }
  if (article.contentHash !== state.contentHash) return unknown;
  try {
    const access = await currentBloggerAccessToken(context.secrets, account.id, { ...dependencies, signal: context.signal });
    if (!access || access.credential.userId !== account.username) return unknown;
    const blog = await verifyBloggerBlog(access.accessToken, account.username, state.blogId, { ...dependencies, signal: context.signal });
    if (!sameBoundBlog(context, blog)) return unknown;
    const found = state.postId
      ? await getPost(state.blogId, state.postId, access.accessToken, { ...dependencies, signal: context.signal })
      : await findExactPost(state.blogId, access.accessToken, article.title, article.content(state.operationId), state.operationId, { ...dependencies, signal: context.signal });
    if (found && !exactPost(found, article.title, article.content(state.operationId), state.operationId)) return unknown;
    if (found?.status === 'live' && found.url) return { status: 'found', publicUrl: found.url };
    if (found?.status === 'draft' && state.stage !== 'published') {
      return { status: 'draft', blogger: bloggerState(state.blogId, state.operationId, state.contentHash, 'draft', found.id) };
    }
    return unknown;
  } catch { return unknown; }
}

export async function runBloggerTask(context: ExecutionContext, dependencies: BloggerDependencies = {}): Promise<ExecutionResult> {
  if (context.channel.id !== 'blogger' || context.channel.automation !== 'api' || context.task.channelId !== 'blogger') {
    return { status: 'needs_input', message: '该渠道没有启用 Blogger API 自动化' };
  }
  const account = context.getAccount();
  if (!account || account.channelId !== 'blogger' || context.task.accountId !== account.id) {
    return { status: 'needs_input', message: '请先连接真实 Blogger 账号并为网站绑定博客' };
  }
  if (account.credentialKind !== 'oauth' || account.status !== 'registered' || !account.hasPassword) {
    return { status: 'needs_input', message: 'Blogger OAuth 身份不可用，请重新连接原 Google 身份' };
  }
  const bound = context.site.blogger;
  if (!bound || !numericId(bound.blogId)) return { status: 'needs_input', message: '请先为网站绑定一个可写的 Blogger 博客' };
  let article: ArticlePayload;
  try { article = approvedArticle(context); }
  catch (error) { return { status: 'needs_input', message: error instanceof Error ? error.message : 'Blogger 草稿不符合发布要求' }; }

  const prior = context.task.blogger;
  const remoteCheckpoint = ['blogger_insert_submitting', 'blogger_draft_created', 'blogger_publish_submitting', 'blogger_published'].includes(context.task.checkpoint ?? '');
  if (!prior && (context.task.submittedAt || context.task.publicUrl || context.task.firstLiveAt || remoteCheckpoint)) {
    return { status: 'needs_input', message: '已有 Blogger 提交或公开网址但缺少幂等记录，不会创建新文章', checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt, publicUrl: context.task.publicUrl };
  }
  if (prior && (prior.blogId !== bound.blogId || prior.contentHash !== article.contentHash)) {
    return { status: 'needs_input', message: 'Blogger 提交记录与当前博客或核准稿件不一致；保留原记录并停止发布', checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt, publicUrl: context.task.publicUrl };
  }
  if (prior && !validBloggerState(prior)) {
    return { status: 'needs_input', message: '保存的 Blogger 幂等记录无效；不会发布或新建文章', checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt, publicUrl: context.task.publicUrl };
  }
  let access: { token: string; blog: BloggerBlog };
  try {
    access = await verifiedPublisherAccess(context, account, bound.blogId, dependencies);
    if (!sameBoundBlog(context, access.blog)) throw new BloggerError('forbidden');
  } catch (error) {
    await markAccountError(context, account, error, dependencies);
    return resultForFailure(error, 'verify', context.task);
  }

  const operationId = prior?.operationId ?? (dependencies.uuid?.() ?? randomUUID());
  const expectedContent = article.content(operationId);
  let state = prior;
  let submittedAt = context.task.submittedAt;

  if (state?.postId) {
    let existing: BloggerPost;
    try { existing = await getPost(state.blogId, state.postId, access.token, { ...dependencies, signal: context.signal }); }
    catch (error) { return resultForFailure(error, 'read', context.task); }
    if (!exactPost(existing, article.title, expectedContent, operationId)) {
      return { status: 'needs_input', message: '已保存的 Blogger 帖子与核准稿件或操作标识不一致，不会覆盖或新建', checkpoint: context.task.checkpoint, submittedAt, publicUrl: context.task.publicUrl };
    }
    if (existing.status === 'live' && existing.url) {
      state = bloggerState(state.blogId, operationId, article.contentHash, 'published', existing.id);
      context.checkpoint({ blogger: state, checkpoint: 'blogger_published', submittedAt, publicUrl: existing.url });
      return { status: 'review', message: '已回读并确认 Blogger 文章，等待公开页面外链核验', publicUrl: existing.url, checkpoint: 'blogger_published', submittedAt };
    }
    if (existing.status === 'scheduled') {
      return { status: 'needs_input', message: 'Blogger 帖子处于定时发布状态，保留原帖子并等待人工核对', checkpoint: context.task.checkpoint, submittedAt };
    }
    if (state.stage === 'published') {
      return { status: 'needs_input', message: '原 Blogger 发布记录已不再是公开状态；不会自动重新发布', checkpoint: context.task.checkpoint, submittedAt, publicUrl: context.task.publicUrl };
    }
    state = bloggerState(state.blogId, operationId, article.contentHash, 'draft', existing.id);
    context.checkpoint({ blogger: state, checkpoint: 'blogger_draft_created', submittedAt });
  } else if (state?.stage === 'inserting') {
    let recovered: BloggerPost | undefined;
    try { recovered = await findExactPost(state.blogId, access.token, article.title, expectedContent, operationId, { ...dependencies, signal: context.signal }); }
    catch (error) { return resultForFailure(error, 'read', context.task); }
    if (!recovered) {
      return { status: 'needs_input', message: '未能唯一找回上次 Blogger 插入结果；即使列表暂未发现也不会再次插入，请在 Blogger 后台核对', checkpoint: 'blogger_insert_submitting', submittedAt };
    }
    if (recovered.status === 'live' && recovered.url) {
      state = bloggerState(state.blogId, operationId, article.contentHash, 'published', recovered.id);
      context.checkpoint({ blogger: state, checkpoint: 'blogger_published', submittedAt, publicUrl: recovered.url });
      return { status: 'review', message: '已通过博客归属、完整正文和操作标识找回已发布文章', publicUrl: recovered.url, checkpoint: 'blogger_published', submittedAt };
    }
    if (recovered.status !== 'draft') {
      return { status: 'needs_input', message: '找回的 Blogger 帖子不是可立即发布的草稿，已保留并停止操作', checkpoint: context.task.checkpoint, submittedAt };
    }
    state = bloggerState(state.blogId, operationId, article.contentHash, 'draft', recovered.id);
    context.checkpoint({ blogger: state, checkpoint: 'blogger_draft_created', submittedAt });
  } else if (!state) {
    if (context.signal.aborted) return { status: 'queued', message: '任务已暂停，尚未向 Blogger 提交' };
    submittedAt = stamp(dependencies);
    state = bloggerState(bound.blogId, operationId, article.contentHash, 'inserting');
    context.checkpoint({ blogger: state, checkpoint: 'blogger_insert_submitting', submittedAt, draft: context.task.draft });
    let inserted: BloggerPost;
    try {
      inserted = postFrom(await apiRequest(`/blogs/${bound.blogId}/posts`, access.token, {
        method: 'POST', query: { isDraft: 'true' }, body: { title: article.title, content: expectedContent },
      }, { ...dependencies, signal: context.signal }), bound.blogId, 'draft');
    } catch (error) {
      await markAccountError(context, account, error, dependencies);
      return resultForFailure(error, 'insert', context.task);
    }
    if (!exactPost(inserted, article.title, expectedContent, operationId)) {
      return { status: 'needs_input', message: 'Blogger 返回的草稿与核准正文不一致；已保留插入检查点且不会重复创建', checkpoint: 'blogger_insert_submitting', submittedAt };
    }
    if (inserted.status === 'live' && inserted.url) {
      state = bloggerState(bound.blogId, operationId, article.contentHash, 'published', inserted.id);
      context.checkpoint({ blogger: state, checkpoint: 'blogger_published', submittedAt, publicUrl: inserted.url });
      return { status: 'review', message: 'Blogger 已返回公开文章，等待公开页面外链核验', publicUrl: inserted.url, checkpoint: 'blogger_published', submittedAt };
    }
    if (inserted.status !== 'draft') {
      return { status: 'needs_input', message: 'Blogger 未返回可安全继续的草稿状态；不会再次插入', checkpoint: 'blogger_insert_submitting', submittedAt };
    }
    state = bloggerState(bound.blogId, operationId, article.contentHash, 'draft', inserted.id);
    context.checkpoint({ blogger: state, checkpoint: 'blogger_draft_created', submittedAt });
  }

  if (!state?.postId || state.stage !== 'draft') {
    return { status: 'needs_input', message: 'Blogger 发布状态无法安全确认，已保留原记录', checkpoint: context.task.checkpoint, submittedAt };
  }
  if (context.signal.aborted) return { status: 'queued', message: 'Blogger 草稿已创建并保存，恢复后只发布同一帖子', checkpoint: 'blogger_draft_created', submittedAt };
  state = bloggerState(state.blogId, operationId, article.contentHash, 'publishing', state.postId);
  context.checkpoint({ blogger: state, checkpoint: 'blogger_publish_submitting', submittedAt });
  let published: BloggerPost;
  try {
    published = postFrom(await apiRequest(`/blogs/${state.blogId}/posts/${state.postId}/publish`, access.token, { method: 'POST' }, { ...dependencies, signal: context.signal }), state.blogId, 'live');
  } catch (error) {
    await markAccountError(context, account, error, dependencies);
    return resultForFailure(error, 'publish', context.task);
  }
  if (!exactPost(published, article.title, expectedContent, operationId) || published.id !== state.postId || published.status !== 'live' || !published.url) {
    return { status: 'needs_input', message: 'Blogger 发布响应无法确认完整正文或公开网址；保留同一 postId，不会创建新文章', checkpoint: 'blogger_publish_submitting', submittedAt };
  }
  state = bloggerState(state.blogId, operationId, article.contentHash, 'published', state.postId);
  context.checkpoint({ blogger: state, checkpoint: 'blogger_published', submittedAt, publicUrl: published.url });
  return {
    status: 'review',
    message: context.signal.aborted ? 'Blogger 文章已发布并保留回执；暂停后只会核验该网址' : 'Blogger 文章已发布，等待公开页面外链核验',
    publicUrl: published.url,
    checkpoint: 'blogger_published',
    submittedAt,
  };
}

export const bloggerTesting = {
  approvedArticle,
  findExactPost,
  postFrom,
};
