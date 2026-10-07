import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import {inspectRenderedArticle} from './article-rendering';
import type {
  Account,
  AccountDiagnostic,
  ExecutionContext,
  ExecutionResult,
  LinkResult,
  SecretStore,
  Site,
  Task,
} from '../shared/types';

const API_ORIGIN = 'https://public.api.paragraph.com';
const API_PREFIX = '/api';
const PUBLIC_ORIGIN = 'https://paragraph.com';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 512 * 1024;
const RECONCILE_PAGE_SIZE = 100;
const RECONCILE_MAX_PAGES_PER_STATUS = 2;
const RECONCILE_STATUSES = ['draft', 'published'] as const;

type JsonObject = Record<string, unknown>;
type ParagraphPostStatus = 'draft' | 'published' | 'scheduled' | 'archived';

export type ParagraphTransport = (input: string, init: RequestInit) => Promise<Response>;

export interface ParagraphDependencies {
  fetch?: ParagraphTransport;
  now?: () => Date | string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ParagraphPublication {
  id: string;
  name: string;
  ownerUserId: string;
  slug: string;
  url: string;
}

export type ParagraphStage = 'inserting' | 'draft' | 'publishing' | 'published';

export interface ParagraphTaskState {
  publicationId: string;
  slug: string;
  contentHash: string;
  stage: ParagraphStage;
  postId?: string;
}

export interface ParagraphExecutionResult extends ExecutionResult {
  paragraph?: ParagraphTaskState;
}

type ParagraphTask = Task & { paragraph?: ParagraphTaskState };
type ParagraphSite = Site & { paragraph?: { publicationId: string; url: string } };

interface ParagraphStoredCredential {
  version: 1;
  apiKey: string;
  publicationId: string;
  ownerUserId: string;
  publicationSlug: string;
}

interface ApprovedArticle {
  title: string;
  subtitle?: string;
  markdown: string;
  target: string;
  contentHash: string;
  slug: string;
}

interface ParagraphPost {
  id: string;
  title: string;
  slug: string;
  subtitle?: string;
  markdown?: string;
  staticHtml?: string;
  status?: ParagraphPostStatus;
  publishOnline?: boolean;
  authorIds?: string[];
  authors?: Array<{ id: string; publicationId: string }>;
}

export type ParagraphErrorCode =
  | 'auth'
  | 'binding'
  | 'forbidden'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'cancelled'
  | 'rejected'
  | 'not_found'
  | 'invalid_response';

export class ParagraphError extends Error {
  constructor(readonly code: ParagraphErrorCode) {
    super(`Paragraph request failed (${code})`);
    this.name = 'ParagraphError';
  }
}

function object(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max: number, min = 1): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validRemoteId(value: unknown): value is string {
  // The official schema promises an opaque string, not a UUID/base62 shape.
  // Keep it bounded locally and URL-encode it whenever it enters a path.
  return boundedString(value, 512);
}

function validPublicationSlug(value: unknown): value is string {
  return boundedString(value, 256) && !/[\s\/?#%@]/.test(value);
}

function validPostSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 256;
}

function validRemotePostSlug(value: unknown): value is string {
  return boundedString(value, 256);
}

function validApiKey(value: unknown): value is string {
  // Paragraph documents an opaque Bearer API key without a public length or
  // prefix contract. Authenticity is established by /v1/me.
  return typeof value === 'string' && value.length >= 1 && value.length <= 4096
    && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function timestamp(dependencies?: ParagraphDependencies): string {
  const supplied = dependencies?.now?.();
  const value = supplied instanceof Date ? supplied : typeof supplied === 'string' ? new Date(supplied) : new Date();
  return (Number.isFinite(value.getTime()) ? value : new Date()).toISOString();
}

function transport(dependencies?: ParagraphDependencies): ParagraphTransport {
  return dependencies?.fetch ?? ((input, init) => fetch(input, init));
}

function timeoutMs(dependencies?: ParagraphDependencies): number {
  return Math.min(Math.max(dependencies?.timeoutMs ?? REQUEST_TIMEOUT_MS, 100), 60_000);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalHttps(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || (url.port && url.port !== '443')) {
      throw new Error('invalid');
    }
    url.hash = '';
    return url.toString();
  } catch {
    throw new Error('文章目标必须是不含凭据的 HTTPS 网址');
  }
}

function publicationHomeUrl(slug: string): string {
  if (!validPublicationSlug(slug)) throw new ParagraphError('invalid_response');
  return `${PUBLIC_ORIGIN}/@${encodeURIComponent(slug)}/`;
}

function publicPostUrl(publicationSlug: string, postSlug: string): string {
  if (!validPublicationSlug(publicationSlug) || !validPostSlug(postSlug)) throw new ParagraphError('invalid_response');
  return `${PUBLIC_ORIGIN}/@${encodeURIComponent(publicationSlug)}/${encodeURIComponent(postSlug)}`;
}

async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const advertised = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(advertised) && advertised > maxBytes) throw new ParagraphError('invalid_response');
  if (!response.body) throw new ParagraphError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => { rejectAbort(new ParagraphError('cancelled')); void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, {once:true});
  if(signal.aborted)onAbort();
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new ParagraphError('invalid_response');
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener('abort',onAbort);
    void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ParagraphError('invalid_response'); }
}

function verifyResponseUrl(response: Response, expected: URL): void {
  if (!response.url) return;
  try {
    const actual = new URL(response.url);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname
      || actual.search !== expected.search || actual.hash) throw new Error('mismatch');
  } catch { throw new ParagraphError('invalid_response'); }
}

async function fixedRequest(
  url: URL,
  init: RequestInit,
  dependencies: ParagraphDependencies | undefined,
  maxBytes: number,
): Promise<string> {
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new ParagraphError('invalid_response');
  if (dependencies?.signal?.aborted) throw new ParagraphError('cancelled');
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(dependencies?.signal?.reason);
  dependencies?.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs(dependencies));
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
      if (dependencies?.signal?.aborted) throw new ParagraphError('cancelled');
      if (timedOut) throw new ParagraphError('timeout');
      throw new ParagraphError('network');
    }
    if (response.redirected) throw new ParagraphError('invalid_response');
    verifyResponseUrl(response, url);
    if (response.status === 401) throw new ParagraphError('auth');
    if (response.status === 403) throw new ParagraphError('forbidden');
    if (response.status === 404) throw new ParagraphError('not_found');
    if (response.status === 408) throw new ParagraphError('timeout');
    if (response.status === 429) throw new ParagraphError('rate_limited');
    if (response.status >= 500) throw new ParagraphError('network');
    if (!response.ok) throw new ParagraphError('rejected');
    try { return await readBounded(response,maxBytes,controller.signal); }
    catch(error){if(timedOut)throw new ParagraphError('timeout');if(dependencies?.signal?.aborted)throw new ParagraphError('cancelled');throw error;}
  } finally {
    clearTimeout(timer);
    dependencies?.signal?.removeEventListener('abort', abort);
  }
}

function apiUrl(path: string, query: Record<string, string> = {}): URL {
  const url = new URL(`${API_PREFIX}${path}`, API_ORIGIN);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

async function apiRequest(
  path: string,
  options: { token?: string; method?: 'GET' | 'POST' | 'PUT'; query?: Record<string, string>; body?: JsonObject },
  dependencies?: ParagraphDependencies,
): Promise<JsonObject> {
  if (options.token !== undefined && !validApiKey(options.token)) throw new ParagraphError('auth');
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'Linkflow-Desktop' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body) headers['content-type'] = 'application/json';
  const response = await fixedRequest(apiUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  }, dependencies, MAX_JSON_BYTES);
  try {
    const value = JSON.parse(response) as unknown;
    if (!object(value)) throw new Error('shape');
    return value;
  } catch (error) {
    if (error instanceof ParagraphError) throw error;
    throw new ParagraphError('invalid_response');
  }
}

async function publicHtml(url: string, dependencies?: ParagraphDependencies): Promise<string> {
  const expected = new URL(url);
  if (expected.origin !== PUBLIC_ORIGIN || !/^\/@[^/]+\/[^/]+$/.test(expected.pathname) || expected.search || expected.hash) {
    throw new ParagraphError('invalid_response');
  }
  const response = await fixedRequest(expected, {
    method: 'GET',
    headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'Linkflow-Desktop' },
  }, dependencies, MAX_HTML_BYTES);
  return response;
}

function publicationFrom(value: JsonObject): ParagraphPublication {
  if (!validRemoteId(value.id) || !boundedString(value.name, 200) || !validRemoteId(value.ownerUserId)
    || !validPublicationSlug(value.slug)) throw new ParagraphError('invalid_response');
  return {
    id: value.id,
    name: value.name,
    ownerUserId: value.ownerUserId,
    slug: value.slug,
    url: publicationHomeUrl(value.slug),
  };
}

async function getPublicPublication(
  publicationId: string,
  dependencies?: ParagraphDependencies,
): Promise<ParagraphPublication> {
  if (!validRemoteId(publicationId)) throw new ParagraphError('invalid_response');
  return publicationFrom(await apiRequest(`/v1/publications/${encodeURIComponent(publicationId)}`, {}, dependencies));
}

function credentialFrom(value: unknown): ParagraphStoredCredential {
  let parsed = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 16 * 1024) throw new ParagraphError('auth');
    try { parsed = JSON.parse(value) as unknown; }
    catch { throw new ParagraphError('auth'); }
  }
  if (!object(parsed) || parsed.version !== 1 || !validApiKey(parsed.apiKey)
    || !validRemoteId(parsed.publicationId) || !validRemoteId(parsed.ownerUserId)
    || !validPublicationSlug(parsed.publicationSlug)) throw new ParagraphError('auth');
  return {
    version: 1,
    apiKey: parsed.apiKey,
    publicationId: parsed.publicationId,
    ownerUserId: parsed.ownerUserId,
    publicationSlug: parsed.publicationSlug,
  };
}

export async function validateParagraphApiKey(
  apiKey: string,
  dependencies: ParagraphDependencies = {},
): Promise<ParagraphPublication> {
  if (!validApiKey(apiKey)) throw new ParagraphError('auth');
  return publicationFrom(await apiRequest('/v1/me', { token: apiKey }, dependencies));
}

/** Validate first, then place the API key only in the supplied vault. */
export async function connectParagraphPublication(
  secrets: SecretStore,
  accountId: string,
  apiKey: string,
  dependencies: ParagraphDependencies = {},
): Promise<ParagraphPublication> {
  if (!boundedString(accountId, 256)) throw new ParagraphError('auth');
  const publication = await validateParagraphApiKey(apiKey, dependencies);
  const credential: ParagraphStoredCredential = {
    version: 1,
    apiKey,
    publicationId: publication.id,
    ownerUserId: publication.ownerUserId,
    publicationSlug: publication.slug,
  };
  await secrets.set(`account:${accountId}`, JSON.stringify(credential));
  return publication;
}

async function storedCredential(secrets: SecretStore, accountId: string): Promise<ParagraphStoredCredential> {
  const raw = await secrets.get(`account:${accountId}`);
  if (!raw) throw new ParagraphError('auth');
  return credentialFrom(raw);
}

export async function verifyStoredParagraphPublication(
  secrets: SecretStore,
  accountId: string,
  dependencies: ParagraphDependencies = {},
): Promise<ParagraphPublication> {
  const credential = await storedCredential(secrets, accountId);
  const publication = await validateParagraphApiKey(credential.apiKey, dependencies);
  if (publication.id !== credential.publicationId || publication.ownerUserId !== credential.ownerUserId
    || publication.slug !== credential.publicationSlug) throw new ParagraphError('auth');
  return publication;
}

function approvedArticle(task: Task, site: Site, requireApproval: boolean): ApprovedArticle {
  const draft = task.draft;
  if (!draft) throw new Error('请先生成并核对 Paragraph 原创全文草稿');
  const approved = typeof task.articleApprovedAt === 'string' && Number.isFinite(Date.parse(task.articleApprovedAt));
  if (requireApproval && !approved) throw new Error('Paragraph 全文尚未通过当前稿件的明确核对');
  if (!boundedString(draft.title, 200)) throw new Error('Paragraph 标题必须为 1–200 个无控制字符文字');
  if (draft.description && (!boundedString(draft.description, 300) || /\r/.test(draft.description))) {
    throw new Error('Paragraph 副标题超出官方 300 字符规格，不会截断后发布');
  }
  if (typeof draft.body !== 'string' || draft.body !== draft.body.trim() || /\r|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draft.body)) {
    throw new Error('Paragraph 正文必须是已核对的完整 Markdown，不得含控制字符或隐式截断');
  }
  const paragraphs = draft.body.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean);
  const visible = draft.body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https:\/\/\S+/g, ' ')
    .replace(/[#>*_`~|\-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (paragraphs.length < 2 || visible.replace(/\s/g, '').length < 200) {
    throw new Error('Paragraph 只支持有实质信息的原创全文，至少需要两个段落且不能只是推广摘要');
  }
  if (Buffer.byteLength(draft.body, 'utf8') > MAX_MARKDOWN_BYTES) throw new Error('Paragraph 正文超出本机安全大小上限');
  const target = canonicalHttps(task.topicUrl ?? site.url);
  if (!draft.body.includes(target)) throw new Error('Paragraph 全文必须包含已核对正文页的完整 HTTPS 链接');
  const subtitle = draft.description || undefined;
  const contentHash = sha256(JSON.stringify({ title: draft.title, subtitle: subtitle ?? null, markdown: draft.body, target }));
  const titleStem = draft.title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '');
  const slug = `${titleStem || 'linkflow-post'}-${contentHash.slice(0, 16)}`;
  return { title: draft.title, ...(subtitle ? { subtitle } : {}), markdown: draft.body, target, contentHash, slug };
}

function paragraphTask(task: Task): ParagraphTask {
  return task as ParagraphTask;
}

function paragraphSite(site: Site): ParagraphSite {
  return site as ParagraphSite;
}

function taskCheckpoint(context: ExecutionContext, partial: Partial<ParagraphTask>): void {
  context.checkpoint(partial as Partial<Task>);
}

function stateFor(
  publicationId: string,
  slug: string,
  contentHash: string,
  stage: ParagraphStage,
  postId?: string,
): ParagraphTaskState {
  return { publicationId, slug, contentHash, stage, ...(postId ? { postId } : {}) };
}

function validState(value: unknown): value is ParagraphTaskState {
  return object(value) && validRemoteId(value.publicationId) && validPostSlug(value.slug)
    && typeof value.contentHash === 'string' && /^[0-9a-f]{64}$/.test(value.contentHash)
    && typeof value.stage === 'string' && ['inserting', 'draft', 'publishing', 'published'].includes(value.stage)
    && (value.postId === undefined || validRemoteId(value.postId));
}

function authorsFrom(value: unknown): Array<{ id: string; publicationId: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ParagraphError('invalid_response');
  return value.map(item => {
    if (!object(item) || !validRemoteId(item.id) || !validRemoteId(item.publicationId)) throw new ParagraphError('invalid_response');
    return { id: item.id, publicationId: item.publicationId };
  });
}

function idsFrom(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => !validRemoteId(item))) throw new ParagraphError('invalid_response');
  return [...value] as string[];
}

function postFrom(value: unknown): ParagraphPost {
  if (!object(value) || !validRemoteId(value.id) || !boundedString(value.title, 200) || !validRemotePostSlug(value.slug)) {
    throw new ParagraphError('invalid_response');
  }
  const status = value.status;
  if (status !== undefined && !['draft', 'published', 'scheduled', 'archived'].includes(String(status))) {
    throw new ParagraphError('invalid_response');
  }
  if (value.subtitle !== undefined && !boundedString(value.subtitle, 300, 0)) throw new ParagraphError('invalid_response');
  if (value.markdown !== undefined && (typeof value.markdown !== 'string' || Buffer.byteLength(value.markdown, 'utf8') > MAX_MARKDOWN_BYTES)) {
    throw new ParagraphError('invalid_response');
  }
  if (value.staticHtml !== undefined && (typeof value.staticHtml !== 'string' || Buffer.byteLength(value.staticHtml, 'utf8') > MAX_HTML_BYTES)) {
    throw new ParagraphError('invalid_response');
  }
  if (value.publishOnline !== undefined && typeof value.publishOnline !== 'boolean') throw new ParagraphError('invalid_response');
  return {
    id: value.id,
    title: value.title,
    slug: value.slug,
    ...(typeof value.subtitle === 'string' ? { subtitle: value.subtitle } : {}),
    ...(typeof value.markdown === 'string' ? { markdown: value.markdown } : {}),
    ...(typeof value.staticHtml === 'string' ? { staticHtml: value.staticHtml } : {}),
    ...(typeof status === 'string' ? { status: status as ParagraphPostStatus } : {}),
    ...(typeof value.publishOnline === 'boolean' ? { publishOnline: value.publishOnline } : {}),
    ...(value.authorIds !== undefined ? { authorIds: idsFrom(value.authorIds) } : {}),
    ...(value.authors !== undefined ? { authors: authorsFrom(value.authors) } : {}),
  };
}

function ownedPost(post: ParagraphPost, publication: ParagraphPublication): boolean {
  if (post.authorIds && (post.authorIds.length !== 1 || post.authorIds[0] !== publication.ownerUserId)) return false;
  if (post.authors && !post.authors.some(author => author.id === publication.ownerUserId
    && author.publicationId === publication.id)) return false;
  return !!post.authorIds?.length || !!post.authors?.length;
}

function exactPost(post: ParagraphPost, article: ApprovedArticle, publication: ParagraphPublication, expectedId?: string): boolean {
  return (!expectedId || post.id === expectedId) && post.title === article.title && post.slug === article.slug
    && post.markdown === article.markdown && (post.subtitle ?? undefined) === article.subtitle
    && ownedPost(post, publication);
}

async function getOwnPost(
  postId: string,
  token: string,
  dependencies?: ParagraphDependencies,
): Promise<ParagraphPost> {
  if (!validRemoteId(postId)) throw new ParagraphError('invalid_response');
  return postFrom(await apiRequest(`/v1/posts/${encodeURIComponent(postId)}`, {
    token,
    query: { includeContent: 'true' },
  }, dependencies));
}

async function findExactOwnPost(
  token: string,
  article: ApprovedArticle,
  publication: ParagraphPublication,
  dependencies?: ParagraphDependencies,
): Promise<ParagraphPost | undefined> {
  const matches = new Map<string, ParagraphPost>();
  for (const status of RECONCILE_STATUSES) {
    let cursor: string | undefined;
    for (let page = 0; page < RECONCILE_MAX_PAGES_PER_STATUS; page++) {
      const query: Record<string, string> = {
        status,
        includeContent: 'true',
        limit: String(RECONCILE_PAGE_SIZE),
      };
      if (cursor) query.cursor = cursor;
      const value = await apiRequest('/v1/posts', { token, query }, dependencies);
      if (!Array.isArray(value.items) || !object(value.pagination) || typeof value.pagination.hasMore !== 'boolean') {
        throw new ParagraphError('invalid_response');
      }
      for (const raw of value.items) {
        const post = postFrom(raw);
        if (post.status !== status) throw new ParagraphError('invalid_response');
        if (exactPost(post, article, publication)) matches.set(post.id, post);
      }
      if (!value.pagination.hasMore) { cursor = undefined; break; }
      if (!boundedString(value.pagination.cursor, 1024)) throw new ParagraphError('invalid_response');
      cursor = value.pagination.cursor;
    }
    if (cursor) return undefined;
  }
  return matches.size === 1 ? [...matches.values()][0] : undefined;
}

function canonicalBoundUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== PUBLIC_ORIGIN || url.username || url.password || url.search || url.hash) return undefined;
    return url.pathname.endsWith('/') ? url.toString() : `${url.toString()}/`;
  } catch { return undefined; }
}

function sameBinding(context: ExecutionContext, publication: ParagraphPublication): boolean {
  const bound = paragraphSite(context.site).paragraph;
  return !!bound && bound.publicationId === publication.id
    && canonicalBoundUrl(bound.url) === publication.url;
}

async function authenticatedPublication(
  context: ExecutionContext,
  account: Account,
  dependencies: ParagraphDependencies,
  updateAccount: boolean,
): Promise<{ credential: ParagraphStoredCredential; publication: ParagraphPublication }> {
  const credential = await storedCredential(context.secrets, account.id);
  if (credential.publicationId !== account.username) throw new ParagraphError('auth');
  const publication = await validateParagraphApiKey(credential.apiKey, { ...dependencies, signal: context.signal });
  if (publication.id !== credential.publicationId || publication.ownerUserId !== credential.ownerUserId
    || publication.slug !== credential.publicationSlug) throw new ParagraphError('auth');
  if (!sameBinding(context, publication)) throw new ParagraphError('binding');
  if (updateAccount) {
    await context.saveAccount({
      ...account,
      status: 'registered',
      verifiedAt: timestamp(dependencies),
      lastUsedAt: timestamp(dependencies),
      updatedAt: timestamp(dependencies),
      diagnostic: undefined,
    });
  }
  return { credential, publication };
}

function diagnostic(code: AccountDiagnostic['code'], message: string, dependencies?: ParagraphDependencies): AccountDiagnostic {
  return { code, message, at: timestamp(dependencies), retryable: false };
}

async function markAccountFailure(
  context: ExecutionContext,
  account: Account,
  error: unknown,
  dependencies?: ParagraphDependencies,
): Promise<void> {
  if (!(error instanceof ParagraphError) || !['auth', 'forbidden'].includes(error.code)) return;
  const restricted = error.code === 'forbidden';
  await context.saveAccount({
    ...account,
    status: restricted ? 'restricted' : 'credentials_invalid',
    diagnostic: diagnostic(restricted ? 'restricted' : 'bad_password', restricted
      ? 'Paragraph 拒绝了当前出版物权限。'
      : 'Paragraph API 密钥失效、已更换出版物，或不属于原连接身份。', dependencies),
    updatedAt: timestamp(dependencies),
  });
}

function failureMessage(error: unknown, writeStarted: boolean): string {
  if (!(error instanceof ParagraphError)) return 'Paragraph 请求失败，未输出远端详情';
  if (error.code === 'cancelled') return writeStarted ? 'Paragraph 写入期间任务已暂停，只会对账原操作' : 'Paragraph 操作已取消';
  if (error.code === 'auth') return 'Paragraph API 密钥或原出版物身份无法验证';
  if (error.code === 'binding') return '当前网站绑定的 Paragraph 出版物 ID 或网址与原连接身份不一致';
  if (error.code === 'forbidden') return 'Paragraph 拒绝了当前出版物的读写权限';
  if (error.code === 'rate_limited') return 'Paragraph API 已触发速率限制，后续只对账原操作';
  if (error.code === 'timeout') return writeStarted ? 'Paragraph 写入超时，不会重复提交' : 'Paragraph 读取超时';
  if (error.code === 'network') return writeStarted ? 'Paragraph 写入结果无法确认，不会重复提交' : 'Paragraph 网络或服务暂时不可用';
  if (error.code === 'not_found') return writeStarted ? 'Paragraph 原帖子暂时无法读回，不会新建替代帖子' : 'Paragraph 没有找到绑定资源';
  if (error.code === 'rejected') return 'Paragraph 明确拒绝了请求，原意图记录已保留';
  return 'Paragraph 返回了无法安全确认的结果';
}

function renderedArticle(html:string,article:ApprovedArticle,publicPage:boolean){
  const selector=publicPage?(load(html)('article .prose').length?'article .prose':'article'):'body';
  return inspectRenderedArticle(html,article.markdown,article.target,selector);
}

async function readPublicPost(
  state: ParagraphTaskState,
  article: ApprovedArticle,
  publication: ParagraphPublication,
  dependencies?: ParagraphDependencies,
): Promise<{ post: ParagraphPost; url: string; rel: string }> {
  if (!state.postId) throw new ParagraphError('invalid_response');
  const value = await apiRequest(
    `/v1/publications/${encodeURIComponent(publication.id)}/posts/slug/${encodeURIComponent(state.slug)}`,
    { query: { includeContent: 'true' } },
    dependencies,
  );
  const post = postFrom(value);
  if (!exactPost(post, article, publication, state.postId) || post.publishOnline !== true || !post.staticHtml) {
    throw new ParagraphError('invalid_response');
  }
  const rendered = renderedArticle(post.staticHtml, article, false);
  if (!rendered.found) throw new ParagraphError('invalid_response');
  const url = publicPostUrl(publication.slug, state.slug);
  const page = renderedArticle(await publicHtml(url, dependencies), article, true);
  if (!page.found) throw new ParagraphError('invalid_response');
  return { post, url, rel: page.rel === 'unknown' ? rendered.rel : page.rel };
}

function unavailable(url: string, reason: string, outcome: LinkResult['outcome'] = 'unreachable'): LinkResult {
  return { found: false, outcome, url, rel: 'unknown', reason };
}

export async function verifyParagraphPublication(
  task: Task,
  targetSiteUrl: string,
  signal?: AbortSignal,
  dependencies: ParagraphDependencies = {},
): Promise<LinkResult> {
  const state = paragraphTask(task).paragraph;
  const fallback = task.publicUrl ?? `${PUBLIC_ORIGIN}/`;
  if (!state || !validState(state) || !state.postId || !['publishing', 'published'].includes(state.stage)) {
    return unavailable(fallback, 'Paragraph 任务缺少有效出版物、slug 或 postId 回执', 'invalid');
  }
  let article: ApprovedArticle;
  try {
    article = approvedArticle(task, { url: targetSiteUrl } as Site, false);
    if (article.contentHash !== state.contentHash || article.slug !== state.slug) throw new Error('mismatch');
  } catch {
    return unavailable(fallback, 'Paragraph 任务草稿、内容哈希或 slug 与原提交不一致', 'invalid');
  }
  try {
    const publication = await getPublicPublication(state.publicationId, { ...dependencies, signal });
    const value = await apiRequest(
      `/v1/publications/${encodeURIComponent(state.publicationId)}/posts/slug/${encodeURIComponent(state.slug)}`,
      { query: { includeContent: 'true' } },
      { ...dependencies, signal },
    );
    const post = postFrom(value);
    const expectedUrl = publicPostUrl(publication.slug, state.slug);
    if (task.publicUrl && task.publicUrl !== expectedUrl) return unavailable(task.publicUrl, 'Paragraph 公开网址与原出版物或 slug 不一致', 'invalid');
    if (!exactPost(post, article, publication, state.postId) || post.publishOnline !== true || !post.staticHtml) {
      return unavailable(expectedUrl, 'Paragraph 公开 API 的正文、作者、出版物或可见性与原回执不一致', 'invalid');
    }
    const rendered = renderedArticle(post.staticHtml, article, false);
    if (!rendered.found) return unavailable(expectedUrl, 'Paragraph 公开 API 渲染正文或目标链接与审核原文不一致', 'invalid');
    const pageAnchor = renderedArticle(await publicHtml(expectedUrl, { ...dependencies, signal }), article, true);
    if (!pageAnchor.found) return unavailable(expectedUrl, 'Paragraph 公开页面尚未完整呈现审核正文及目标链接');
    return {
      found: true,
      outcome: 'found',
      url: expectedUrl,
      rel: pageAnchor.rel === 'unknown' ? rendered.rel : pageAnchor.rel,
      reason: 'Paragraph 匿名 API 与公开页面的原文、出版物作者和目标 href 已一致核验。',
    };
  } catch (error) {
    if (error instanceof ParagraphError && error.code === 'invalid_response') {
      return unavailable(fallback, 'Paragraph 公开内容返回了与原回执不一致的结果', 'invalid');
    }
    return unavailable(fallback, 'Paragraph 公开 API 或匿名页面暂时无法核验');
  }
}

export async function reconcileParagraphTask(
  context: ExecutionContext,
  dependencies: ParagraphDependencies = {},
): Promise<
  | { status: 'found'; publicUrl: string; paragraph: ParagraphTaskState }
  | { status: 'draft'; paragraph: ParagraphTaskState }
  | { status: 'unknown' }
> {
  const unknown = { status: 'unknown' as const };
  const task = paragraphTask(context.task);
  const state = task.paragraph;
  const account = context.getAccount();
  const bound = paragraphSite(context.site).paragraph;
  if (context.signal.aborted || context.channel.id !== 'paragraph' || context.task.channelId !== 'paragraph'
    || !state || !validState(state) || context.task.publicUrl || !context.task.accountId || !bound
    || !account || account.id !== context.task.accountId || account.channelId !== 'paragraph'
    || account.credentialKind !== 'api_token' || account.status !== 'registered' || !account.hasPassword
    || account.username !== state.publicationId || bound.publicationId !== state.publicationId) return unknown;
  let article: ApprovedArticle;
  try { article = approvedArticle(context.task, context.site, false); }
  catch { return unknown; }
  if (article.contentHash !== state.contentHash || article.slug !== state.slug) return unknown;
  try {
    const access = await authenticatedPublication(context, account, dependencies, false);
    let post = state.postId
      ? await getOwnPost(state.postId, access.credential.apiKey, { ...dependencies, signal: context.signal })
      : await findExactOwnPost(access.credential.apiKey, article, access.publication, { ...dependencies, signal: context.signal });
    if (!post || !exactPost(post, article, access.publication, state.postId)) return unknown;
    if (post.status === 'draft' && !['publishing', 'published'].includes(state.stage)) {
      return { status: 'draft', paragraph: stateFor(state.publicationId, state.slug, state.contentHash, 'draft', post.id) };
    }
    if (post.status !== 'published' || post.publishOnline !== true) return unknown;
    const publishedState = stateFor(state.publicationId, state.slug, state.contentHash, 'published', post.id);
    const publicPost = await readPublicPost(publishedState, article, access.publication, { ...dependencies, signal: context.signal });
    post = publicPost.post;
    if (post.id !== publishedState.postId) return unknown;
    return { status: 'found', publicUrl: publicPost.url, paragraph: publishedState };
  } catch { return unknown; }
}

export async function runParagraphTask(
  context: ExecutionContext,
  dependencies: ParagraphDependencies = {},
): Promise<ParagraphExecutionResult> {
  if (context.channel.id !== 'paragraph' || context.channel.automation !== 'api' || context.task.channelId !== 'paragraph'
    || context.channel.kind !== 'article' || !context.channel.articleRequired || !context.channel.accountRequired
    || context.channel.contentFormat === 'social') {
    return { status: 'needs_input', message: '当前渠道规格不支持 Paragraph 本人原创全文 API 发布' };
  }
  const account = context.getAccount();
  if (!account || context.task.accountId !== account.id || account.channelId !== 'paragraph') {
    return { status: 'needs_input', message: '请先连接并绑定本人管理的 Paragraph 出版物' };
  }
  if (account.credentialKind !== 'api_token' || account.status !== 'registered' || !account.hasPassword
    || !validRemoteId(account.username)) {
    return { status: 'needs_input', message: 'Paragraph API 身份不可用，请重新连接原出版物' };
  }
  const bound = paragraphSite(context.site).paragraph;
  if (!bound || !validRemoteId(bound.publicationId) || bound.publicationId !== account.username) {
    return { status: 'needs_input', message: '请先将当前网站绑定到经过 /v1/me 验证的 Paragraph 出版物' };
  }
  let article: ApprovedArticle;
  try { article = approvedArticle(context.task, context.site, true); }
  catch (error) {
    return { status: 'needs_input', message: error instanceof Error ? error.message : 'Paragraph 草稿不符合原创全文发布规格' };
  }
  const task = paragraphTask(context.task);
  const prior = task.paragraph;
  const remoteCheckpoint = ['paragraph_insert_submitting', 'paragraph_draft_created', 'paragraph_publish_submitting', 'paragraph_published']
    .includes(context.task.checkpoint ?? '');
  if (!prior && (context.task.submittedAt || context.task.publicUrl || context.task.firstLiveAt || remoteCheckpoint)) {
    return {
      status: 'needs_input',
      message: '已有 Paragraph 写入或公开网址但缺少确定性 slug/哈希回执，不会创建替代帖子',
      checkpoint: context.task.checkpoint,
      submittedAt: context.task.submittedAt,
      publicUrl: context.task.publicUrl,
    };
  }
  if (prior && (!validState(prior) || prior.publicationId !== bound.publicationId
    || prior.contentHash !== article.contentHash || prior.slug !== article.slug)) {
    return {
      status: 'needs_input',
      message: 'Paragraph 回执与当前出版物、确定性 slug 或已核对正文哈希不一致；保留原记录并停止写入',
      checkpoint: context.task.checkpoint,
      submittedAt: context.task.submittedAt,
      publicUrl: context.task.publicUrl,
    };
  }

  let access: { credential: ParagraphStoredCredential; publication: ParagraphPublication };
  try { access = await authenticatedPublication(context, account, { ...dependencies, signal: context.signal }, true); }
  catch (error) {
    await markAccountFailure(context, account, error, dependencies);
    return { status: error instanceof ParagraphError && ['network', 'timeout', 'rate_limited'].includes(error.code) ? 'failed' : 'needs_input', message: failureMessage(error, false) };
  }

  let state = prior;
  let submittedAt = context.task.submittedAt;
  let remote: ParagraphPost | undefined;

  if (state?.postId) {
    try { remote = await getOwnPost(state.postId, access.credential.apiKey, { ...dependencies, signal: context.signal }); }
    catch (error) { return { status: 'needs_input', message: failureMessage(error, true) }; }
    if (!exactPost(remote, article, access.publication, state.postId)) {
      return { status: 'needs_input', message: '已保存的 Paragraph postId 与已核对原文、作者或 slug 不一致，不会覆盖或新建' };
    }
    if (remote.status === 'published' && remote.publishOnline === true) {
      const publishedState = stateFor(state.publicationId, state.slug, state.contentHash, 'published', state.postId);
      try {
        const verified = await readPublicPost(publishedState, article, access.publication, { ...dependencies, signal: context.signal });
        taskCheckpoint(context, { paragraph: publishedState, checkpoint: 'paragraph_published', submittedAt, publicUrl: verified.url } as Partial<ParagraphTask>);
        return { status: 'review', message: 'Paragraph 原文、出版物作者和公开页目标 href 已核验', paragraph: publishedState, publicUrl: verified.url, checkpoint: 'paragraph_published', submittedAt };
      } catch {
        return { status: 'review', message: 'Paragraph 已读回为公开发布，匿名页面与目标 href 尚待核验' };
      }
    }
    if (['publishing', 'published'].includes(state.stage)) {
      return { status: 'needs_input', message: 'Paragraph 发布写入已发起，当前读回状态仍未公开；只会继续读取对账，不会再次 PUT' };
    }
    if (remote.status !== 'draft') {
      return { status: 'needs_input', message: 'Paragraph 原 postId 不是可发布的已核对草稿，已停止写入' };
    }
    state = stateFor(state.publicationId, state.slug, state.contentHash, 'draft', state.postId);
    taskCheckpoint(context, { paragraph: state, checkpoint: 'paragraph_draft_created', submittedAt } as Partial<ParagraphTask>);
  } else if (state?.stage === 'inserting') {
    try { remote = await findExactOwnPost(access.credential.apiKey, article, access.publication, { ...dependencies, signal: context.signal }); }
    catch (error) { return { status: 'needs_input', message: failureMessage(error, true) }; }
    if (!remote) {
      return { status: 'needs_input', message: '未能唯一找回上次 Paragraph 创建结果；即使列表暂未显示也不会再次 POST' };
    }
    if (remote.status === 'published' && remote.publishOnline === true) {
      const publishedState = stateFor(state.publicationId, state.slug, state.contentHash, 'published', remote.id);
      try {
        const verified = await readPublicPost(publishedState, article, access.publication, { ...dependencies, signal: context.signal });
        taskCheckpoint(context, { paragraph: publishedState, checkpoint: 'paragraph_published', submittedAt, publicUrl: verified.url } as Partial<ParagraphTask>);
        return { status: 'review', message: '已通过确定性 slug、完整原文与出版物归属找回公开文章', paragraph: publishedState, publicUrl: verified.url, checkpoint: 'paragraph_published', submittedAt };
      } catch { return { status: 'review', message: '已找回 Paragraph 公开文章，匿名页面与目标 href 尚待核验' }; }
    }
    if (remote.status !== 'draft') {
      return { status: 'needs_input', message: '找回的 Paragraph 帖子不是可继续的草稿，已保留并停止写入' };
    }
    state = stateFor(state.publicationId, state.slug, state.contentHash, 'draft', remote.id);
    taskCheckpoint(context, { paragraph: state, checkpoint: 'paragraph_draft_created', submittedAt } as Partial<ParagraphTask>);
  } else if (!state) {
    if (context.signal.aborted) return { status: 'queued', message: '任务已暂停，尚未向 Paragraph 提交' };
    submittedAt = timestamp(dependencies);
    state = stateFor(access.publication.id, article.slug, article.contentHash, 'inserting');
    try {
      taskCheckpoint(context, {
        paragraph: state,
        checkpoint: 'paragraph_insert_submitting',
        submittedAt,
        draft: context.task.draft,
      } as Partial<ParagraphTask>);
    } catch {
      return { status: 'queued', message: 'Paragraph 创建意图未能持久化，未执行 POST' };
    }
    let created: JsonObject;
    try {
      created = await apiRequest('/v1/posts', {
        token: access.credential.apiKey,
        method: 'POST',
        body: {
          title: article.title,
          markdown: article.markdown,
          ...(article.subtitle ? { subtitle: article.subtitle } : {}),
          slug: article.slug,
          authorIds: [access.publication.ownerUserId],
          status: 'draft',
          sendNewsletter: false,
        },
      }, { ...dependencies, signal: context.signal });
    } catch (error) {
      await markAccountFailure(context, account, error, dependencies);
      return { status: 'needs_input', message: failureMessage(error, true) };
    }
    if (!validRemoteId(created.id) || !['draft', 'published'].includes(String(created.status))) {
      return { status: 'needs_input', message: 'Paragraph 创建响应缺少有效 postId 或状态；保留创建意图且不会重发' };
    }
    state = stateFor(access.publication.id, article.slug, article.contentHash, created.status === 'draft' ? 'draft' : 'publishing', created.id);
    try {
      taskCheckpoint(context, {
        paragraph: state,
        checkpoint: created.status === 'draft' ? 'paragraph_draft_created' : 'paragraph_publish_submitting',
        submittedAt,
      } as Partial<ParagraphTask>);
    } catch {
      return {
        status: 'review',
        message: 'Paragraph 已返回原 postId；保留回执且不会重发',
        paragraph: state,
        checkpoint: created.status === 'draft' ? 'paragraph_draft_created' : 'paragraph_publish_submitting',
        submittedAt,
      };
    }
    if (created.status !== 'draft') {
      return { status: 'review', message: 'Paragraph 未按请求返回草稿；已保留 postId 并且只读对账', paragraph: state };
    }
  }

  if (!state?.postId || state.stage !== 'draft') {
    return { status: 'needs_input', message: 'Paragraph 写入状态无法安全确认，已保留原回执' };
  }
  try { remote = await getOwnPost(state.postId, access.credential.apiKey, { ...dependencies, signal: context.signal }); }
  catch (error) { return { status: 'needs_input', message: failureMessage(error, true) }; }
  if (!exactPost(remote, article, access.publication, state.postId) || remote.status !== 'draft') {
    return { status: 'needs_input', message: 'Paragraph 远端草稿未通过 postId、全文、作者、slug 和 draft 状态核验，未执行发布 PUT' };
  }
  if (context.signal.aborted) {
    return { status: 'queued', message: 'Paragraph 已核验草稿并保存 postId，恢复后只发布同一帖子', paragraph: state, checkpoint: 'paragraph_draft_created', submittedAt };
  }
  state = stateFor(state.publicationId, state.slug, state.contentHash, 'publishing', state.postId);
  taskCheckpoint(context, { paragraph: state, checkpoint: 'paragraph_publish_submitting', submittedAt } as Partial<ParagraphTask>);
  const publishingPostId = state.postId;
  if (!publishingPostId) return { status: 'needs_input', message: 'Paragraph 发布回执缺少 postId，未执行 PUT' };
  try {
    const updated = await apiRequest(`/v1/posts/${encodeURIComponent(publishingPostId)}`, {
      token: access.credential.apiKey,
      method: 'PUT',
      body: { status: 'published', sendNewsletter: false, publishOnline: true },
    }, { ...dependencies, signal: context.signal });
    if (updated.success !== true) throw new ParagraphError('invalid_response');
  } catch (error) {
    await markAccountFailure(context, account, error, dependencies);
    return { status: 'needs_input', message: failureMessage(error, true) };
  }
  try { remote = await getOwnPost(publishingPostId, access.credential.apiKey, { ...dependencies, signal: context.signal }); }
  catch {
    return { status: 'review', message: 'Paragraph 已接受发布 PUT，正文与公开页回读尚待确认；不会再次 PUT' };
  }
  if (!exactPost(remote, article, access.publication, state.postId) || remote.status !== 'published' || remote.publishOnline !== true) {
    return { status: 'review', message: 'Paragraph 已接受发布 PUT，但全文、作者或公开状态尚未完整读回；不会再次 PUT' };
  }
  const publishedState = stateFor(state.publicationId, state.slug, state.contentHash, 'published', state.postId);
  try {
    const verified = await readPublicPost(publishedState, article, access.publication, { ...dependencies, signal: context.signal });
    try {
      taskCheckpoint(context, {
        paragraph: publishedState,
        checkpoint: 'paragraph_published',
        submittedAt,
        publicUrl: verified.url,
      } as Partial<ParagraphTask>);
    } catch {
      return { status: 'review', message: 'Paragraph 已匿名核验公开原文与目标 href，保留发布回执', paragraph: publishedState, publicUrl: verified.url, checkpoint: 'paragraph_published', submittedAt };
    }
    return {
      status: 'review',
      message: 'Paragraph 已发布，并通过匿名 API 与公开页面核验原文、作者和目标 href',
      paragraph: publishedState,
      publicUrl: verified.url,
      checkpoint: 'paragraph_published',
      submittedAt,
    };
  } catch {
    return { status: 'review', message: 'Paragraph 已读回为公开发布，匿名页面或目标 href 尚待核验；不会重复写入' };
  }
}

export const paragraphTesting = {
  approvedArticle,
  credentialFrom,
  exactPost,
  postFrom,
  publicPostUrl,
  renderedArticle,
  validState,
};
