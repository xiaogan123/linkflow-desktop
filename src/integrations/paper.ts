import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { inspectPaperRenderedArticle } from './paper-rendering';
import type {
  Account, AccountDiagnostic, ExecutionContext, ExecutionResult, LinkResult, PaperReceipt, SecretStore, Site, Task,
} from '../shared/types';

const ORIGIN = 'https://paper.wf';
const TIMEOUT_MS = 15_000;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_ARTICLE_BYTES = 256 * 1024;
const USERNAME = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const POST_ID = /^[a-zA-Z0-9]{10,64}$/;
const HASH = /^[a-f0-9]{64}$/;

type JsonObject = Record<string, unknown>;
export type PaperTransport = (input: string, init: RequestInit) => Promise<Response>;
export interface PaperDependencies {
  fetch?: PaperTransport;
  now?: () => Date | string;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface PaperExecutionResult extends ExecutionResult { paper?: PaperReceipt }
export type PaperReconcileResult = { status: 'found'; publicUrl: string; paper: PaperReceipt } | { status: 'unknown' };
export type PaperErrorCode = 'auth' | 'forbidden' | 'verification_required' | 'conflict' | 'rate_limited' | 'not_found' | 'timeout' | 'cancelled' | 'network' | 'rejected' | 'invalid_response';
export class PaperError extends Error {
  constructor(readonly code: PaperErrorCode) {
    super(code === 'verification_required'
      ? 'Paper.wf 要求先在浏览器完成验证，再连接同一用户名的账号。'
      : `Paper.wf request failed (${code})`);
    this.name = 'PaperError';
  }
}

interface PaperCredential { version: 1; username: string; password: string; token?: string }
interface ApprovedArticle { title: string; description: string; markdown: string; target: string; slug: string; contentHash: string }
interface PaperPost { id: string; slug: string; title: string; body: string; collectionAlias?: string }

function object(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value); }
function stamp(dependencies?: PaperDependencies): string {
  const raw = dependencies?.now?.() ?? new Date();
  const date = raw instanceof Date ? raw : new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}
function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function home(username: string): string {
  if (!USERNAME.test(username)) throw new PaperError('invalid_response');
  return `${ORIGIN}/${username}/`;
}
function postUrl(username: string, slug: string): string {
  if (!USERNAME.test(username) || !SLUG.test(slug) || slug.length > 100) throw new PaperError('invalid_response');
  return `${ORIGIN}/${username}/${slug}`;
}
function apiUrl(path: string): URL {
  if (!/^\/api\/(?:auth\/(?:login|signup)|me(?:\/collections)?|collections\/[a-z0-9][a-z0-9-]{2,63}\/posts(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?)$/.test(path)) {
    throw new PaperError('invalid_response');
  }
  return new URL(path, ORIGIN);
}
function canonicalTarget(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || (url.port && url.port !== '443')) throw Error('invalid');
    url.hash = '';
    return url.toString();
  } catch { throw new Error('Paper.wf 全文目标必须是不含凭据的 HTTPS 网址'); }
}
function validPassword(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= 1 && Buffer.byteLength(value, 'utf8') <= 72
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 512 && !/[\s\u0000-\u001f\u007f]/.test(value);
}
function credentialFrom(raw: string | undefined, username: string): PaperCredential {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!object(value) || value.version !== 1 || value.username !== username || !validPassword(value.password)
      || (value.token !== undefined && !validToken(value.token))) throw Error('invalid');
    return value as unknown as PaperCredential;
  } catch { throw new PaperError('auth'); }
}
function approvedArticle(task: Task, site: Pick<Site, 'url'>): ApprovedArticle {
  const draft = task.draft;
  if (!draft || !task.articleApprovedAt || !Number.isFinite(Date.parse(task.articleApprovedAt))) {
    throw new Error('Paper.wf 原创全文必须先通过当前稿件核对');
  }
  if (typeof draft.title !== 'string' || draft.title.length < 1 || draft.title.length > 200
    || draft.title !== draft.title.trim() || /[\u0000-\u001f\u007f]/.test(draft.title)) {
    throw new Error('Paper.wf 标题必须为 1–200 个无控制字符文字');
  }
  const description = draft.description ?? '';
  if (typeof description !== 'string' || description.length > 300 || /[\u0000-\u001f\u007f]/.test(description)) {
    throw new Error('Paper.wf 摘要不符合已核对全文规格');
  }
  if (typeof draft.body !== 'string' || draft.body !== draft.body.trim()
    || /\r|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draft.body)
    || Buffer.byteLength(draft.body, 'utf8') > MAX_ARTICLE_BYTES) {
    throw new Error('Paper.wf 正文必须是未截断的完整 Markdown');
  }
  const paragraphs = draft.body.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean);
  const visible = draft.body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https:\/\/\S+/g, ' ')
    .replace(/[#>*_`~|\-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (paragraphs.length < 2 || visible.replace(/\s/g, '').length < 200) {
    throw new Error('Paper.wf 需要至少两个段落及有实质信息的原创全文');
  }
  const target = canonicalTarget(task.topicUrl ?? site.url);
  if (!draft.body.includes(target)) throw new Error('Paper.wf 全文缺少已核对目标页的 HTTPS 链接');
  const contentHash = hash(JSON.stringify({ title: draft.title, description, markdown: draft.body, target }));
  const stem = draft.title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 45).replace(/-+$/g, '');
  const slug = `${stem || 'linkflow-article'}-${hash(task.id).slice(0, 8)}-${contentHash.slice(0, 16)}`;
  return { title: draft.title, description, markdown: draft.body, target, slug, contentHash };
}
function validReceipt(value: unknown): value is PaperReceipt {
  return object(value) && typeof value.username === 'string' && USERNAME.test(value.username)
    && typeof value.slug === 'string' && SLUG.test(value.slug) && value.slug.length <= 100
    && typeof value.contentHash === 'string' && HASH.test(value.contentHash)
    && (value.stage === 'submitting' || value.stage === 'published')
    && (value.postId === undefined || typeof value.postId === 'string' && POST_ID.test(value.postId));
}
function receipt(article: ApprovedArticle, username: string, stage: PaperReceipt['stage'], postId?: string): PaperReceipt {
  return { username, slug: article.slug, contentHash: article.contentHash, stage, ...(postId ? { postId } : {}) };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new PaperError('cancelled'));
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(new PaperError('cancelled')); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); }, error => {
      signal.removeEventListener('abort', onAbort); reject(error);
    });
  });
}
async function boundedText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const advertised = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(advertised) && advertised > maxBytes) throw new PaperError('invalid_response');
  if (!response.body) throw new PaperError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new PaperError('invalid_response');
      chunks.push(next.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new PaperError('invalid_response'); }
}
async function fixedRequest(url: URL, init: RequestInit, dependencies: PaperDependencies, maxBytes: number): Promise<{text:string;robotsHeader:string}> {
  if (url.origin !== ORIGIN || url.username || url.password || url.hash) throw new PaperError('invalid_response');
  const external = dependencies.signal;
  if (external?.aborted) throw new PaperError('cancelled');
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  external?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const duration = Math.min(Math.max(dependencies.timeoutMs ?? TIMEOUT_MS, 100), 60_000);
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, duration);
  timer.unref?.();
  try {
    const response = await abortable((dependencies.fetch ?? fetch)(url.toString(), {
      ...init, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
    }), controller.signal);
    if (response.redirected || response.url && response.url !== url.toString()) throw new PaperError('invalid_response');
    if (response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge') throw new PaperError('verification_required');
    if (response.status === 401) throw new PaperError('auth');
    if (response.status === 403) throw new PaperError('forbidden');
    if (response.status === 404) throw new PaperError('not_found');
    if (response.status === 409 || response.status === 412) throw new PaperError('conflict');
    if (response.status === 429) throw new PaperError('rate_limited');
    if (response.status === 408 || response.status >= 500) throw new PaperError('network');
    if (!response.ok) throw new PaperError('rejected');
    return {text:await boundedText(response,maxBytes,controller.signal),robotsHeader:response.headers.get('x-robots-tag')??''};
  } catch (error) {
    if (timedOut) throw new PaperError('timeout');
    if (external?.aborted) throw new PaperError('cancelled');
    if (error instanceof PaperError) throw error.code === 'cancelled' ? new PaperError('network') : error;
    throw new PaperError('network');
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onAbort);
  }
}
async function api(path: string, options: { method?: 'GET' | 'POST'; token?: string; body?: JsonObject } = {}, dependencies: PaperDependencies = {}): Promise<unknown> {
  if (options.token !== undefined && !validToken(options.token)) throw new PaperError('auth');
  const value = await fixedRequest(apiUrl(path), {
    method: options.method ?? 'GET',
    headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { authorization: `Token ${options.token}` } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  }, dependencies, MAX_JSON_BYTES);
  try {
    const parsed: unknown = JSON.parse(value.text);
    if (!object(parsed) || !Number.isInteger(parsed.code) || Number(parsed.code) < 200 || Number(parsed.code) >= 300
      || !('data' in parsed)) throw Error('invalid');
    return parsed.data;
  } catch { throw new PaperError('invalid_response'); }
}
function loginData(value: unknown, username: string): string {
  if (!object(value) || !validToken(value.access_token)
    || object(value.user) && value.user.username !== username) throw new PaperError('invalid_response');
  return value.access_token as string;
}
async function login(username: string, password: string, dependencies: PaperDependencies): Promise<string> {
  return loginData(await api('/api/auth/login', { method: 'POST', body: { alias: username, pass: password } }, dependencies), username);
}
async function verifyOwnership(username: string, token: string, dependencies: PaperDependencies): Promise<void> {
  const me = await api('/api/me', { token }, dependencies);
  if (!object(me) || me.username !== username) throw new PaperError('invalid_response');
  const collections = await api('/api/me/collections', { token }, dependencies);
  if (!Array.isArray(collections)) throw new PaperError('invalid_response');
  const owned = collections.find(value => object(value) && value.alias === username);
  if (!object(owned) || owned.url !== home(username) || owned.public !== true) throw new PaperError('forbidden');
}
export async function connectPaperAccount(
  vault: SecretStore, accountId: string, username: string, password: string, dependencies: PaperDependencies = {},
): Promise<{ username: string; url: string }> {
  if (!accountId || accountId.length > 128 || !USERNAME.test(username) || !validPassword(password)) throw new PaperError('auth');
  const token = await login(username, password, dependencies);
  await verifyOwnership(username, token, dependencies);
  await vault.set(`account:${accountId}`, JSON.stringify({ version: 1, username, password, token } satisfies PaperCredential));
  return { username, url: home(username) };
}

function postFrom(value: unknown): PaperPost {
  if (!object(value) || typeof value.id !== 'string' || !POST_ID.test(value.id)
    || typeof value.slug !== 'string' || !SLUG.test(value.slug) || value.slug.length > 100
    || typeof value.title !== 'string' || typeof value.body !== 'string'
    || Buffer.byteLength(value.body, 'utf8') > MAX_ARTICLE_BYTES) throw new PaperError('invalid_response');
  let collectionAlias: string | undefined;
  if (value.collection !== undefined) {
    if (!object(value.collection) || typeof value.collection.alias !== 'string' || !USERNAME.test(value.collection.alias)) {
      throw new PaperError('invalid_response');
    }
    collectionAlias = value.collection.alias;
  }
  return { id: value.id, slug: value.slug, title: value.title, body: value.body, collectionAlias };
}
function exactPost(post: PaperPost, article: ApprovedArticle, username: string, postId?: string): boolean {
  return post.slug === article.slug && post.title === article.title && post.body === article.markdown
    && (!postId || post.id === postId) && (!post.collectionAlias || post.collectionAlias === username);
}
async function publicPost(article: ApprovedArticle, username: string, postId: string | undefined, dependencies: PaperDependencies): Promise<{ post: PaperPost; url: string; rel: string }> {
  const value = await api(`/api/collections/${username}/posts/${article.slug}`, {}, dependencies);
  const post = postFrom(value);
  if (!exactPost(post, article, username, postId)) throw new PaperError('invalid_response');
  const url = postUrl(username, article.slug);
  const html = await fixedRequest(new URL(url), { method: 'GET', headers: { accept: 'text/html' } }, dependencies, MAX_HTML_BYTES);
  const rendered = inspectPaperRenderedArticle(html.text, article.markdown, article.target,{pageUrl:url,robotsHeader:html.robotsHeader});
  if (!rendered.found) throw new PaperError('invalid_response');
  return { post, url, rel: rendered.rel };
}
function unavailable(url: string, reason: string, outcome: LinkResult['outcome'] = 'unreachable'): LinkResult {
  return { found: false, outcome, url, rel: 'unknown', reason };
}
export async function verifyPaperPublication(
  task: Task, targetSiteUrl: string, signal?: AbortSignal, dependencies: PaperDependencies = {},
): Promise<LinkResult> {
  const saved = task.paper;
  const fallback = task.publicUrl ?? `${ORIGIN}/`;
  if (!saved || !validReceipt(saved)) return unavailable(fallback, 'Paper.wf 任务缺少有效发布回执', 'invalid');
  let article: ApprovedArticle;
  try {
    article = approvedArticle(task, { url: targetSiteUrl });
    if (saved.slug !== article.slug || saved.contentHash !== article.contentHash
      || task.sourceDomain !== 'paper.wf' || task.channelId !== 'paper-wf') throw Error('mismatch');
    const expectedUrl = postUrl(saved.username, saved.slug);
    if (task.publicUrl && task.publicUrl !== expectedUrl) throw Error('url');
  } catch { return unavailable(fallback, 'Paper.wf 回执、原文哈希或公开网址与当前任务不一致', 'invalid'); }
  const url = postUrl(saved.username, saved.slug);
  try {
    const found = await publicPost(article, saved.username, saved.postId, { ...dependencies, signal });
    return { found: true, outcome: 'found', url: found.url, rel: found.rel, reason: 'Paper.wf 匿名 API 原文及公开页完整可见正文、目标 href 一致。' };
  } catch (error) {
    if (error instanceof PaperError && error.code === 'not_found') return unavailable(url, 'Paper.wf 原发布 slug 尚未公开', 'absent');
    if (error instanceof PaperError && error.code === 'invalid_response') return unavailable(url, 'Paper.wf 公开 API 或页面与原文、归属、可见链接不一致', 'invalid');
    return unavailable(url, 'Paper.wf 匿名 API 或公开页面暂时无法核验');
  }
}
export async function reconcilePaperTask(context: ExecutionContext, dependencies: PaperDependencies = {}): Promise<PaperReconcileResult> {
  const saved = context.task.paper;
  const account = context.getAccount();
  if (!saved || !validReceipt(saved) || context.task.channelId !== 'paper-wf' || context.task.sourceDomain !== 'paper.wf'
    || !account || account.id !== context.task.accountId || account.channelId !== 'paper-wf' || account.username !== saved.username) {
    return { status: 'unknown' };
  }
  try {
    const article = approvedArticle(context.task, context.site);
    if (article.slug !== saved.slug || article.contentHash !== saved.contentHash) return { status: 'unknown' };
    const found = await publicPost(article, saved.username, saved.postId, { ...dependencies, signal: context.signal });
    return { status: 'found', publicUrl: found.url, paper: receipt(article, saved.username, 'published', found.post.id) };
  } catch { return { status: 'unknown' }; }
}

function diagnostic(code: AccountDiagnostic['code'], message: string, dependencies: PaperDependencies): AccountDiagnostic {
  return { code, message, at: stamp(dependencies), retryable: false };
}
function accountMessage(error: unknown): string {
  if (!(error instanceof PaperError)) return 'Paper.wf 身份状态无法确认，已停止自动创建账号';
  if (error.code === 'conflict') return 'Paper.wf 用户名已被占用，已停止创建账号';
  if (error.code === 'auth') return 'Paper.wf 拒绝了原账号凭据，请重新连接同一身份';
  if (error.code === 'verification_required') return 'Paper.wf 首次需在浏览器完成平台验证，再于账号页连接同一用户名；本任务暂停，其他任务可继续。';
  if (error.code === 'forbidden') return 'Paper.wf 原账号或出版物不可用于公开发表';
  return 'Paper.wf 账号状态待确认，只会核验已保存的身份';
}
function generatedUsername(site: Site): string {
  const stem = site.domain.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28).replace(/-+$/g, '') || 'site';
  return `${stem}-${randomBytes(6).toString('hex')}`;
}
async function readyAccount(context: ExecutionContext, dependencies: PaperDependencies): Promise<{ account: Account; credential: PaperCredential } | PaperExecutionResult> {
  let account = context.getAccount();
  if (!account) {
    if (context.task.accountId || context.task.paper || context.task.submittedAt || context.task.publicUrl || context.signal.aborted) {
      return { status: 'needs_input', message: 'Paper.wf 原账号或发布意图需要核对，不会创建替代身份' };
    }
    const username = generatedUsername(context.site);
    const credential: PaperCredential = { version: 1, username, password: randomBytes(32).toString('base64url') };
    const at = stamp(dependencies);
    account = { id: randomUUID(), channelId: 'paper-wf', email: '', username, publicationUrl: home(username),
      credentialKind: 'api_token', status: 'draft', hasPassword: true, source: 'generated', registrationAttempts: 0,
      createdAt: at, updatedAt: at };
    try { await context.saveAccount(account, JSON.stringify(credential)); }
    catch { return { status: 'queued', message: 'Paper.wf 账号凭据未能持久保存，尚未提交注册' }; }
  }
  if (account.channelId !== 'paper-wf' || account.id !== context.task.accountId && !!context.task.accountId
    || account.credentialKind !== 'api_token' || !USERNAME.test(account.username) || !account.hasPassword
    || account.status === 'restricted' || account.status === 'credentials_invalid') {
    return { status: 'needs_input', message: 'Paper.wf 原账号未正确绑定或需人工确认' };
  }
  if (account.status === 'needs_verification') {
    return { status: 'needs_input', message: accountMessage(new PaperError('verification_required')) };
  }
  let credential: PaperCredential;
  try { credential = credentialFrom(await context.secrets.get(`account:${account.id}`), account.username); }
  catch { return { status: 'needs_input', message: 'Paper.wf 本机保险箱缺少原账号凭据' }; }

  if (account.source === 'generated' && account.status === 'draft' && account.registrationAttempts === 0) {
    const at = stamp(dependencies);
    const pending: Account = { ...account, status: 'unknown', registrationAttempts: 1, updatedAt: at,
      diagnostic: diagnostic('registration_unknown', 'Paper.wf 注册即将提交；以后只认证此身份，不自动创建替代账号。', dependencies) };
    try {
      await context.saveAccount(pending);
      context.checkpoint({ checkpoint: 'paper_account_create_pending' });
    } catch { return { status: 'queued', message: 'Paper.wf 注册意图未能安全持久化，未提交注册' }; }
    account = pending;
    try {
      const signedUp = await api('/api/auth/signup', {
        method: 'POST', body: { alias: account.username, pass: credential.password },
      }, { ...dependencies, signal: context.signal });
      if (!object(signedUp) || object(signedUp.user) && signedUp.user.username !== account.username) throw new PaperError('invalid_response');
      credential = { ...credential, token: validToken(signedUp.access_token) ? signedUp.access_token : undefined };
      if (!credential.token) credential.token = await login(account.username, credential.password, { ...dependencies, signal: context.signal });
    } catch (error) {
      const conflict = error instanceof PaperError && error.code === 'conflict';
      const restricted = error instanceof PaperError && error.code === 'forbidden';
      const verification = error instanceof PaperError && error.code === 'verification_required';
      const changed: Account = { ...account, status: verification ? 'needs_verification' : restricted ? 'restricted' : 'unknown',
        updatedAt: stamp(dependencies), diagnostic: diagnostic(verification ? 'verification_required'
          : conflict ? 'username_taken' : restricted ? 'restricted' : 'registration_unknown', accountMessage(error), dependencies) };
      try { await context.saveAccount(changed); } catch { /* original pending account remains durable */ }
      return { status: 'needs_input', message: accountMessage(error), checkpoint: 'paper_account_create_pending' };
    }
  } else if (account.source === 'generated' && account.status === 'draft') {
    return { status: 'needs_input', message: 'Paper.wf 原账号注册状态缺少可确认的尝试记录，未再次提交' };
  }

  try {
    if (!credential.token) credential.token = await login(account.username, credential.password, { ...dependencies, signal: context.signal });
    try { await verifyOwnership(account.username, credential.token, { ...dependencies, signal: context.signal }); }
    catch (error) {
      if (!(error instanceof PaperError) || error.code !== 'auth') throw error;
      credential.token = await login(account.username, credential.password, { ...dependencies, signal: context.signal });
      await verifyOwnership(account.username, credential.token, { ...dependencies, signal: context.signal });
    }
    const at = stamp(dependencies);
    const registered: Account = { ...account, status: 'registered', hasPassword: true, publicationUrl: home(account.username),
      registeredAt: account.registeredAt ?? at, verifiedAt: at, updatedAt: at, diagnostic: undefined };
    if (account.status !== 'registered' || account.publicationUrl !== home(account.username)
      || credential.token !== credentialFrom(await context.secrets.get(`account:${account.id}`), account.username).token) {
      await context.saveAccount(registered, JSON.stringify(credential));
    }
    return { account: registered, credential };
  } catch (error) {
    const restricted = error instanceof PaperError && error.code === 'forbidden';
    const verification = error instanceof PaperError && error.code === 'verification_required';
    const status = verification ? 'needs_verification' : restricted ? 'restricted'
      : account.status === 'registered' && error instanceof PaperError && error.code === 'auth' ? 'credentials_invalid' : 'unknown';
    const changed: Account = { ...account, status, updatedAt: stamp(dependencies), diagnostic: diagnostic(verification ? 'verification_required'
      : restricted ? 'restricted' : status === 'credentials_invalid' ? 'bad_password' : 'registration_unknown', accountMessage(error), dependencies) };
    try { await context.saveAccount(changed); } catch { /* preserve prior durable state */ }
    return { status: 'needs_input', message: accountMessage(error) };
  }
}

/** Establish and verify the author identity before article review or paid generation. */
export async function preparePaperIdentity(
  context: ExecutionContext, dependencies: PaperDependencies = {},
): Promise<ExecutionResult | undefined> {
  if (context.channel.id !== 'paper-wf' || context.task.channelId !== 'paper-wf' || context.task.sourceDomain !== 'paper.wf') {
    return { status: 'needs_input', message: '当前任务不属于 Paper.wf 出版渠道' };
  }
  if (!context.getAccount() && (context.task.paper || context.task.submittedAt || context.task.publicUrl)) {
    return { status: 'needs_input', message: 'Paper.wf 原发布账号缺失，未创建替代身份' };
  }
  const result = await readyAccount(context, { ...dependencies, signal: context.signal });
  if ('status' in result) return result;
  const account = result.account;
  if (account.status !== 'registered' || !account.hasPassword || account.credentialKind !== 'api_token'
    || account.publicationUrl !== home(account.username)) {
    return { status: 'needs_input', message: 'Paper.wf 作者身份尚未验证' };
  }
  return undefined;
}

export async function runPaperTask(context: ExecutionContext, dependencies: PaperDependencies = {}): Promise<PaperExecutionResult> {
  if (context.channel.id !== 'paper-wf' || context.task.channelId !== 'paper-wf' || context.task.sourceDomain !== 'paper.wf'
    || context.channel.domain !== 'paper.wf' || context.channel.automation !== 'api' || context.channel.kind !== 'article'
    || !context.channel.articleRequired || !context.channel.accountRequired || context.channel.contentFormat === 'social') {
    return { status: 'needs_input', message: '当前渠道规格不支持 Paper.wf 原创全文 API 发布' };
  }
  let article: ApprovedArticle;
  try { article = approvedArticle(context.task, context.site); }
  catch (error) { return { status: 'needs_input', message: error instanceof Error ? error.message : 'Paper.wf 原创全文草稿无效' }; }
  const prior = context.task.paper;
  const remoteCheckpoint = ['paper_publish_submitting', 'paper_published'].includes(context.task.checkpoint ?? '');
  if (prior && (!validReceipt(prior) || prior.slug !== article.slug || prior.contentHash !== article.contentHash
    || context.getAccount()?.username !== prior.username || context.getAccount()?.id !== context.task.accountId)) {
    return { status: 'needs_input', message: 'Paper.wf 原发布回执与账号、slug 或已核对全文不一致，已停止写入' };
  }
  if (!prior && (context.task.submittedAt || context.task.publicUrl || context.task.firstLiveAt || remoteCheckpoint)) {
    return { status: 'needs_input', message: 'Paper.wf 已有发布痕迹但缺少原回执，已停止创建替代文章' };
  }
  if (prior) {
    const reconciled = await reconcilePaperTask(context, dependencies);
    if (reconciled.status === 'unknown') return { status: 'review', message: 'Paper.wf 原发布结果未能唯一核实；只读对账，不会再次 POST', paper: prior };
    try { context.checkpoint({ paper: reconciled.paper, checkpoint: 'paper_published', publicUrl: reconciled.publicUrl,
      submittedAt: context.task.submittedAt }); }
    catch { /* keep the previously durable submitting intent */ }
    return { status: 'review', message: 'Paper.wf 原文章通过匿名 API 与完整页面核验', publicUrl: reconciled.publicUrl,
      paper: reconciled.paper, checkpoint: 'paper_published', submittedAt: context.task.submittedAt };
  }
  if (context.signal.aborted) return { status: 'queued', message: '任务已暂停，尚未向 Paper.wf 提交' };
  const accountAtStart = context.getAccount();
  const access = await readyAccount(context, { ...dependencies, signal: context.signal });
  if ('status' in access) return access;
  if (!accountAtStart || accountAtStart.status !== 'registered' || accountAtStart.publicationUrl !== home(access.account.username)) {
    return { status: 'queued', message: 'Paper.wf 作者身份已建立，请以该出版物身份重新核对全文后继续' };
  }
  if (context.signal.aborted) return { status: 'queued', message: '任务已暂停，尚未向 Paper.wf 发布文章' };
  const username = access.account.username;
  try {
    await api(`/api/collections/${username}/posts/${article.slug}`, {}, { ...dependencies, signal: context.signal });
    return { status: 'needs_input', message: 'Paper.wf 确定性 slug 已存在，已停止创建以免覆盖或重复' };
  } catch (error) {
    if (!(error instanceof PaperError) || error.code !== 'not_found') {
      return { status: 'needs_input', message: 'Paper.wf 原 slug 可用性尚未确认，未执行发文 POST' };
    }
  }
  const pending = receipt(article, username, 'submitting');
  const submittedAt = stamp(dependencies);
  try { context.checkpoint({ paper: pending, checkpoint: 'paper_publish_submitting', submittedAt, draft: context.task.draft }); }
  catch { return { status: 'queued', message: 'Paper.wf 发布意图未能持久化，未执行发文 POST' }; }
  let created: PaperPost;
  try {
    const value = await api(`/api/collections/${username}/posts`, {
      method: 'POST', token: access.credential.token,
      body: { title: article.title, body: article.markdown, slug: article.slug },
    }, { ...dependencies, signal: context.signal });
    created = postFrom(value);
    if (!exactPost(created, article, username)) throw new PaperError('invalid_response');
  } catch {
    return { status: 'review', message: 'Paper.wf 发文结果不确定；已保存原账号、slug 和哈希，只读对账且不会重发',
      paper: pending, checkpoint: 'paper_publish_submitting', submittedAt };
  }
  const identified = receipt(article, username, 'submitting', created.id);
  try { context.checkpoint({ paper: identified, checkpoint: 'paper_publish_submitting', submittedAt }); }
  catch { /* original intent still permits read-only recovery by slug */ }
  try {
    const found = await publicPost(article, username, created.id, { ...dependencies, signal: context.signal });
    const published = receipt(article, username, 'published', found.post.id);
    try { context.checkpoint({ paper: published, checkpoint: 'paper_published', publicUrl: found.url, submittedAt }); }
    catch { /* original intent remains durable */ }
    return { status: 'review', message: 'Paper.wf 原文、归属和公开页目标 href 已核验', publicUrl: found.url,
      paper: published, checkpoint: 'paper_published', submittedAt };
  } catch {
    return { status: 'review', message: 'Paper.wf 已返回原 postId，匿名全文或页面尚待核验；不会重发',
      paper: identified, checkpoint: 'paper_publish_submitting', submittedAt };
  }
}

export const paperTesting = { approvedArticle, exactPost, postFrom, credentialFrom, validReceipt, postUrl };
