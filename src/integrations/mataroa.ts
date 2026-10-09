import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import { marked } from 'marked';
import { applyDeclaredArticleVisibility, styleConcealsArticle, publicPagePolicy, withPageNofollow } from './article-visibility';
import { inspectRenderedArticle } from './article-rendering';
import type {
  Account, AccountDiagnostic, ExecutionContext, ExecutionResult, LinkResult, MataroaReceipt, SecretStore, Site, Task,
} from '../shared/types';

const ORIGIN = 'https://mataroa.blog';
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SLUG = /^[a-zA-Z0-9-]{1,200}$/;
const HASH = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HTML = 2 * 1024 * 1024;
const MAX_JSON = 512 * 1024;
const MAX_ARTICLE = 256 * 1024;
const TIMEOUT_MS = 15_000;
type Json = Record<string, unknown>;

export type MataroaTransport = (input: string, init: RequestInit) => Promise<Response>;
export interface MataroaDependencies { fetch?: MataroaTransport; now?: () => Date | string; timeoutMs?: number; signal?: AbortSignal }
export interface MataroaExecutionResult extends ExecutionResult { mataroa?: MataroaReceipt }
export type MataroaReconcileResult = { status: 'found'; publicUrl: string; mataroa: MataroaReceipt } | { status: 'unknown' };
export type MataroaErrorCode = 'auth' | 'verification_required' | 'forbidden' | 'conflict' | 'rate_limited' | 'not_found' | 'timeout' | 'cancelled' | 'network' | 'rejected' | 'invalid_response';
export class MataroaError extends Error {
  constructor(readonly code: MataroaErrorCode) {
    super(code === 'verification_required' ? 'Mataroa 要求在浏览器完成人工验证；原身份已保留。' : `Mataroa request failed (${code})`);
    this.name = 'MataroaError';
  }
}

interface Credential { version: 1; username: string; password: string; token?: string; initialSetupPending?: true }
interface Article { title: string; body: string; target: string; contentHash: string }
interface Post { title: string; body: string; publishedDate: string; slug: string; url: string }
interface Page { status: number; location?: string; text: string }
type FormValues = Map<string, string[]>;

function object(value: unknown): value is Json { return !!value && typeof value === 'object' && !Array.isArray(value); }
function stamp(deps?: MataroaDependencies): string {
  const value = deps?.now?.() ?? new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new MataroaError('invalid_response');
  return date.toISOString();
}
function sha(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function home(username: string): string {
  if (!USERNAME.test(username)) throw new MataroaError('invalid_response');
  return `https://${username}.mataroa.blog/`;
}
function publicPostUrl(username: string, slug: string, value: string): string {
  if (!USERNAME.test(username) || !SLUG.test(slug)) throw new MataroaError('invalid_response');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== `${username}.mataroa.blog` || url.username || url.password
      || url.port || url.search || url.hash || ![`/blog/${slug}/`, `/p/${slug}/`].includes(url.pathname)) throw Error('invalid');
    return url.toString();
  } catch { throw new MataroaError('invalid_response'); }
}
function targetUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.port && url.port !== '443') throw Error('invalid');
    url.hash = '';
    return url.toString();
  } catch { throw new Error('Mataroa 全文目标必须是不含凭据的 HTTPS 网址'); }
}
function validPassword(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= 8 && Buffer.byteLength(value, 'utf8') <= 128
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function validToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{24,200}$/.test(value) && value !== 'your-api-key';
}
function credentialFrom(value: string | undefined, username: string): Credential {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    if (!object(parsed) || parsed.version !== 1 || parsed.username !== username || !validPassword(parsed.password)
      || parsed.token !== undefined && !validToken(parsed.token)
      || parsed.initialSetupPending !== undefined && parsed.initialSetupPending !== true) throw Error('invalid');
    return parsed as unknown as Credential;
  } catch { throw new MataroaError('auth'); }
}
function approvedArticle(task: Task, site: Pick<Site, 'url'>, requireApproval = true): Article {
  const draft = task.draft;
  if (!draft || requireApproval && (!task.articleApprovedAt || !Number.isFinite(Date.parse(task.articleApprovedAt)))) {
    throw Error('Mataroa 全文须先通过当前稿件核对');
  }
  if (typeof draft.title !== 'string' || draft.title !== draft.title.trim() || draft.title.length < 1 || draft.title.length > 300
    || /[\u0000-\u001f\u007f]/.test(draft.title)) throw Error('Mataroa 标题无效');
  if (typeof draft.body !== 'string' || draft.body !== draft.body.trim() || /\r|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draft.body)
    || Buffer.byteLength(draft.body, 'utf8') > MAX_ARTICLE) throw Error('Mataroa 全文必须是未截断的 Markdown');
  const paragraphs = draft.body.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
  const visible = draft.body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https:\/\/\S+/g, ' ')
    .replace(/[#>*_`~|\-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (paragraphs.length < 2 || visible.replace(/\s/g, '').length < 200) throw Error('Mataroa 需要至少两个段落及有实质信息的原创全文');
  const target = targetUrl(task.topicUrl ?? site.url);
  if (!draft.body.includes(target)) throw Error('Mataroa 全文缺少已核对目标页的 HTTPS 链接');
  return { title: draft.title, body: draft.body, target, contentHash: sha(JSON.stringify({ title: draft.title, body: draft.body, target })) };
}
function receipt(value: unknown): value is MataroaReceipt {
  return object(value) && typeof value.username === 'string' && USERNAME.test(value.username)
    && typeof value.contentHash === 'string' && HASH.test(value.contentHash)
    && typeof value.publishedDate === 'string' && validDate(value.publishedDate)
    && (value.stage === 'submitting' || value.stage === 'published')
    && (value.slug === undefined || typeof value.slug === 'string' && SLUG.test(value.slug))
    && (value.stage !== 'published' || !!value.slug);
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new MataroaError('cancelled'));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new MataroaError('cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
async function boundedText(response: Response, maximum: number, signal: AbortSignal): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maximum) throw new MataroaError('invalid_response');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new MataroaError('invalid_response');
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(value => Buffer.from(value)))); }
  catch { throw new MataroaError('invalid_response'); }
}
function safeMainPath(path: string): boolean {
  return /^\/(?:accounts\/(?:create|login|edit)\/|accounts\/welcome\/[0-9a-f-]{36}\/|dashboard\/|api\/(?:docs|posts)\/)$/.test(path);
}
async function request(url: URL, init: RequestInit, deps: MataroaDependencies, maxBytes: number): Promise<{ response: Response; text: string }> {
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
    || url.hostname !== 'mataroa.blog' && !/^[a-z0-9-]+\.mataroa\.blog$/.test(url.hostname)
    || url.hostname === 'mataroa.blog' && !safeMainPath(url.pathname)) throw new MataroaError('invalid_response');
  if (deps.signal?.aborted) throw new MataroaError('cancelled');
  const controller = new AbortController();
  const abort = () => controller.abort();
  deps.signal?.addEventListener('abort', abort, { once: true });
  let timeout = false;
  const duration = Math.min(Math.max(deps.timeoutMs ?? TIMEOUT_MS, 100), 60_000);
  const timer = setTimeout(() => { timeout = true; controller.abort(); }, duration);
  timer.unref?.();
  let response: Response | undefined;
  try {
    response = await abortable((deps.fetch ?? fetch)(url.toString(), {
      ...init, headers: { 'user-agent': 'Linkflow/1.2.12 (single-account publisher)', ...(init.headers as Record<string, string> | undefined) },
      redirect: 'manual', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
    }), controller.signal);
    if (response.redirected || response.url && response.url !== url.toString()) throw new MataroaError('invalid_response');
    const text = await boundedText(response, maxBytes, controller.signal);
    if (response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge'
      || /cf-chl-|g-recaptcha|h-captcha|cf-turnstile|verify (?:that )?you are human/i.test(text)) throw new MataroaError('verification_required');
    if (response.status === 401) throw new MataroaError('auth');
    if (response.status === 403) throw new MataroaError('forbidden');
    if (response.status === 404) throw new MataroaError('not_found');
    if (response.status === 409 || response.status === 412) throw new MataroaError('conflict');
    if (response.status === 429) throw new MataroaError('rate_limited');
    if (response.status === 408 || response.status >= 500) throw new MataroaError('network');
    return { response, text };
  } catch (error) {
    // Header rejection can precede reader acquisition; cleanup must not wait.
    controller.abort();
    void response?.body?.cancel().catch(() => undefined);
    if (timeout) throw new MataroaError('timeout');
    if (deps.signal?.aborted) throw new MataroaError('cancelled');
    if (error instanceof MataroaError) throw error;
    throw new MataroaError('network');
  } finally { clearTimeout(timer); deps.signal?.removeEventListener('abort', abort); }
}
class Session {
  private readonly cookies = new Map<string, string>();
  constructor(private readonly deps: MataroaDependencies) {}
  async get(path: string): Promise<Page> { return this.form(path, 'GET'); }
  async post(path: string, fields: URLSearchParams): Promise<Page> { return this.form(path, 'POST', fields); }
  private async form(path: string, method: 'GET' | 'POST', fields?: URLSearchParams): Promise<Page> {
    const headers: Record<string, string> = { accept: 'text/html' };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    if (fields) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers.origin = ORIGIN;
      headers.referer = `${ORIGIN}${path}`;
    }
    const { response, text } = await request(new URL(path, ORIGIN), { method, headers, ...(fields ? { body: fields.toString() } : {}) }, this.deps, MAX_HTML);
    for (const value of response.headers.getSetCookie()) {
      const match = /^(csrftoken|sessionid)=([^;]*)/.exec(value);
      if (match && /^[a-zA-Z0-9_-]{1,256}$/.test(match[2])) this.cookies.set(match[1], match[2]);
    }
    return { status: response.status, location: response.headers.get('location') ?? undefined, text };
  }
}
function mustPage(page: Page): string {
  if (page.status !== 200) throw new MataroaError('invalid_response');
  return page.text;
}
function csrf(html: string): string {
  const value = load(html)('input[name="csrfmiddlewaretoken"]').attr('value');
  if (!value || !/^[a-zA-Z0-9]{32,128}$/.test(value)) throw new MataroaError('invalid_response');
  return value;
}
function dashboard(page: Page, username: string): void {
  if (page.status !== 200 || !load(page.text)('title').text().includes(username)) throw new MataroaError('auth');
}
async function login(session: Session, credential: Credential): Promise<void> {
  const page = mustPage(await session.get('/accounts/login/'));
  const $ = load(page);
  const forms = $('form[method="post"],form[method="POST"]').filter((_, element) => $(element).find('input[name="username"]').length === 1
    && $(element).find('input[name="password"]').length === 1);
  if (forms.length !== 1) throw new MataroaError('invalid_response');
  const action = forms.attr('action');
  if (action && action !== '/accounts/login/') throw new MataroaError('invalid_response');
  const fields = new URLSearchParams({ csrfmiddlewaretoken: csrf(page), username: credential.username, password: credential.password });
  const result = await session.post('/accounts/login/', fields);
  // Django's LOGIN_REDIRECT_URL is "index"; signup has a separate dashboard redirect.
  if (result.status !== 302 || !['/', '/dashboard/'].includes(result.location ?? '')) throw new MataroaError('auth');
  dashboard(await session.get('/dashboard/'), credential.username);
}
function formValues(html: string, username: string): { values: FormValues; notificationsOn: boolean } {
  const $ = load(html);
  const forms = $('form').filter((_, element) => $(element).find('input[name="username"]').length === 1
    && $(element).find('input[name="notifications_on"]').length === 1);
  if (forms.length !== 1 || forms.attr('method')?.toLowerCase() !== 'post') throw new MataroaError('invalid_response');
  const action = forms.attr('action');
  if (action && action !== '/accounts/edit/') throw new MataroaError('invalid_response');
  const values: FormValues = new Map();
  const append = (name: string, value: string) => values.set(name, [...(values.get(name) ?? []), value]);
  forms.find('input,textarea,select').each((_, element) => {
    const item = $(element);
    const name = item.attr('name');
    if (!name || item.is(':disabled')) return;
    if (element.tagName === 'textarea') { append(name, item.val()?.toString() ?? ''); return; }
    if (element.tagName === 'select') {
      const selected = item.find('option:selected');
      selected.each((_, option) => { append(name, $(option).attr('value') ?? $(option).text()); });
      return;
    }
    const type = (item.attr('type') ?? 'text').toLowerCase();
    if (['submit', 'button', 'reset', 'file', 'image'].includes(type)) return;
    if (['checkbox', 'radio'].includes(type) && !item.is(':checked')) return;
    append(name, item.attr('value') ?? (type === 'checkbox' ? 'on' : ''));
  });
  if (values.get('username')?.length !== 1 || values.get('username')?.[0] !== username
    || values.get('csrfmiddlewaretoken')?.length !== 1 || !/^[a-zA-Z0-9]{32,128}$/.test(values.get('csrfmiddlewaretoken')![0])) {
    throw new MataroaError('auth');
  }
  const check = forms.find('input[name="notifications_on"]');
  if (check.attr('type') !== 'checkbox' || check.length !== 1) throw new MataroaError('invalid_response');
  return { values, notificationsOn: check.is(':checked') };
}
function settingsComparable(values: FormValues): string {
  return JSON.stringify([...values].filter(([key]) => key !== 'csrfmiddlewaretoken' && key !== 'notifications_on').sort(([a], [b]) => a.localeCompare(b)));
}
async function ensureNotificationsOff(session: Session, username: string, consumeInitialSetup?: () => Promise<void>): Promise<void> {
  const before = formValues(mustPage(await session.get('/accounts/edit/')), username);
  if (!before.notificationsOn) {
    if (consumeInitialSetup) await consumeInitialSetup();
    return;
  }
  if (!consumeInitialSetup) throw new MataroaError('forbidden');
  const data = new URLSearchParams();
  for (const [name, values] of before.values) if (name !== 'notifications_on') for (const value of values) data.append(name, value);
  await consumeInitialSetup();
  const result = await session.post('/accounts/edit/', data);
  if (result.status !== 302 || result.location !== '/dashboard/') throw new MataroaError('invalid_response');
  const after = formValues(mustPage(await session.get('/accounts/edit/')), username);
  if (after.notificationsOn || settingsComparable(before.values) !== settingsComparable(after.values)) throw new MataroaError('invalid_response');
}
async function tokenFromDocs(session: Session): Promise<string> {
  const page = mustPage(await session.get('/api/docs/'));
  const $ = load(page);
  const labels = $('dt').filter((_, element) => $(element).text().trim() === 'API Key');
  if (labels.length !== 1) throw new MataroaError('invalid_response');
  const value = labels.next('dd').find('code').text().trim();
  if (!validToken(value)) throw new MataroaError('invalid_response');
  return value;
}
async function api(method: 'GET' | 'POST', token: string, body: Json | undefined, deps: MataroaDependencies): Promise<Json> {
  if (!validToken(token)) throw new MataroaError('auth');
  const { response, text } = await request(new URL('/api/posts/', ORIGIN), {
    method, headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, deps, MAX_JSON);
  if (response.status !== 200) throw new MataroaError('rejected');
  try {
    const parsed: unknown = JSON.parse(text);
    if (!object(parsed) || parsed.ok !== true) throw Error('invalid');
    return parsed;
  } catch { throw new MataroaError('invalid_response'); }
}
function postFrom(value: unknown, username: string): Post {
  if (!object(value) || typeof value.title !== 'string' || typeof value.body !== 'string'
    || value.published_at !== null && (typeof value.published_at !== 'string' || !validDate(value.published_at))
    || typeof value.slug !== 'string' || !SLUG.test(value.slug) || typeof value.url !== 'string'
    || Buffer.byteLength(value.body, 'utf8') > MAX_ARTICLE) throw new MataroaError('invalid_response');
  return { title: value.title, body: value.body, publishedDate: value.published_at ?? '', slug: value.slug,
    url: publicPostUrl(username, value.slug, value.url) };
}
async function posts(token: string, username: string, deps: MataroaDependencies): Promise<Post[]> {
  const value = await api('GET', token, undefined, deps);
  if (!Array.isArray(value.post_list) || value.post_list.length > 5000) throw new MataroaError('invalid_response');
  return value.post_list.map(item => postFrom(item, username));
}
function match(post: Post, article: Article, saved: MataroaReceipt): boolean {
  return post.title === article.title && post.body === article.body && post.publishedDate === saved.publishedDate
    && (!saved.slug || post.slug === saved.slug);
}
async function findPublished(article: Article, saved: MataroaReceipt, token: string, deps: MataroaDependencies): Promise<Post | undefined> {
  const exact = (await posts(token, saved.username, deps)).filter(post => match(post, article, saved));
  if (exact.length !== 1) return undefined;
  await visiblePost(exact[0], article, deps);
  return exact[0];
}
function normalized(text: string): string { return text.normalize('NFC').replace(/\s+/gu, ' ').trim(); }
function concealed($: ReturnType<typeof load>, element: Parameters<ReturnType<typeof load>['contains']>[0]): boolean {
  const item = $(element);
  const classes = (item.attr('class') ?? '').split(/\s+/);
  return item.is('[hidden],[aria-hidden="true"],dialog:not([open]),details:not([open]),script,style,template,noscript')
    || classes.some(value => ['hidden', 'invisible', 'collapse', 'sr-only'].includes(value))
    || styleConcealsArticle(item.attr('style') ?? '');
}
function renderedArticle(html: string, body: string, target: string, publishedDate?: string,
  options:{title?:string;url?:string;headers?:Headers}={}): string | undefined {
  try {
    const $ = load(html);
    applyDeclaredArticleVisibility($);
    const policy=publicPagePolicy($,options.url,options.headers?.get('x-robots-tag')??'');
    if(!policy.valid)return;
    if(options.title){
      const title=$('article h1');
      if(title.length!==1||normalized(title.text())!==normalized(options.title)
        ||title.add(title.parents()).toArray().some(element=>concealed($,element)))return;
    }
    if (publishedDate) {
      const byline = $('article .posts-item-byline');
      const time = byline.find('time[itemprop="datePublished"]');
      if (byline.length !== 1 || !/^Published on\b/.test(normalized(byline.text())) || time.length !== 1
        || time.attr('datetime') !== publishedDate) return undefined;
      if (time.add(time.parents()).toArray().some(element => concealed($, element))) return undefined;
    }
    const nodes = $('article .posts-item-body[itemprop="articleBody"]');
    if (nodes.length !== 1) return undefined;
    const content = nodes.first();
    if (content.add(content.parents()).toArray().some(element => concealed($, element))) return undefined;
    const full=inspectRenderedArticle(html,body,target,'article .posts-item-body[itemprop="articleBody"]');
    if(!full.found)return;
    const visible = content.clone();
    visible.find('*').toArray().filter(element => concealed($, element)).forEach(element => $(element).remove());
    const matching = visible.find('a[href]').filter((_, element) => {
      const anchor = $(element);
      if (!normalized(anchor.text())) return false;
      try { return targetUrl(anchor.attr('href') ?? '') === target; } catch { return false; }
    });
    if (!matching.length) return undefined;
    return withPageNofollow(matching.first().attr('rel')??'',policy.nofollow);
  } catch { return undefined; }
}
async function visiblePost(post: Post, article: Article, deps: MataroaDependencies): Promise<string> {
  const url = new URL(post.url);
  const { response, text } = await request(url, { method: 'GET', headers: { accept: 'text/html' } }, deps, MAX_HTML);
  if (response.status !== 200) throw new MataroaError('invalid_response');
  const rel = renderedArticle(text, article.body, article.target, post.publishedDate,{title:article.title,url:post.url,headers:response.headers});
  if (rel === undefined) throw new MataroaError('invalid_response');
  return rel;
}
function diagnostic(code: AccountDiagnostic['code'], message: string, deps: MataroaDependencies): AccountDiagnostic {
  return { code, message, at: stamp(deps), retryable: false };
}
function accountMessage(error: unknown): string {
  if (!(error instanceof MataroaError)) return 'Mataroa 原账号状态未能确认，保留原身份并暂停';
  if (error.code === 'verification_required') return 'Mataroa 要求人工完成验证，请在平台处理后连接同一用户名；不会重复注册。';
  if (error.code === 'auth') return 'Mataroa 原账号凭据未通过，请连接同一用户名。';
  if (error.code === 'forbidden') return 'Mataroa 账号的 Newsletter 仍开启或账号不可用，请在平台关闭后连接原账号。';
  return 'Mataroa 原账号或通知设置尚未确认，已暂停且不会重复注册或投稿。';
}
function generatedUsername(site: Site): string {
  const stem = site.domain.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28).replace(/-+$/g, '') || 'site';
  return `${stem}-${randomBytes(6).toString('hex')}`;
}
async function signup(session: Session, credential: Credential): Promise<void> {
  const page = mustPage(await session.get('/accounts/create/'));
  const $ = load(page);
  if (!$('input[value="Continue"]').length) throw new MataroaError('invalid_response');
  const started = await session.post('/accounts/create/', new URLSearchParams({ csrfmiddlewaretoken: csrf(page) }));
  if (started.status !== 302 || !started.location || !/^\/accounts\/welcome\/[0-9a-f-]{36}\/$/.test(started.location)) {
    throw new MataroaError('invalid_response');
  }
  const welcome = mustPage(await session.get(started.location));
  const fields = load(welcome);
  for (const name of ['username', 'email', 'password1', 'password2']) {
    if (fields(`input[name="${name}"]`).length !== 1) throw new MataroaError('invalid_response');
  }
  const result = await session.post(started.location, new URLSearchParams({ csrfmiddlewaretoken: csrf(welcome),
    username: credential.username, email: '', password1: credential.password, password2: credential.password }));
  if (result.status !== 302 || result.location !== '/dashboard/') throw new MataroaError('invalid_response');
  dashboard(await session.get('/dashboard/'), credential.username);
}
async function readyAccount(context: ExecutionContext, deps: MataroaDependencies): Promise<{ account: Account; credential: Credential } | MataroaExecutionResult> {
  let account = context.getAccount();
  if (!account) {
    if (context.task.accountId || context.task.mataroa || context.task.submittedAt || context.task.publicUrl || context.signal.aborted) {
      return { status: 'needs_input', message: 'Mataroa 原账号或投稿意图需要核对，不会创建替代身份' };
    }
    const username = generatedUsername(context.site);
    const credential: Credential = { version: 1, username, password: randomBytes(32).toString('base64url'), initialSetupPending: true };
    const at = stamp(deps);
    account = { id: randomUUID(), channelId: 'mataroa', email: '', username, publicationUrl: home(username),
      credentialKind: 'api_token', status: 'draft', hasPassword: true, source: 'generated', registrationAttempts: 0,
      createdAt: at, updatedAt: at };
    try { await context.saveAccount(account, JSON.stringify(credential)); }
    catch { return { status: 'queued', message: 'Mataroa 凭据未能保存，未提交注册' }; }
  }
  if (account.channelId !== 'mataroa' || !!context.task.accountId && account.id !== context.task.accountId
    || account.credentialKind !== 'api_token' || !USERNAME.test(account.username) || !account.hasPassword
    || ['restricted', 'credentials_invalid'].includes(account.status)) {
    return { status: 'needs_input', message: 'Mataroa 原账号未正确绑定或需要人工确认' };
  }
  let credential: Credential;
  try { credential = credentialFrom(await context.secrets.get(`account:${account.id}`), account.username); }
  catch { return { status: 'needs_input', message: 'Mataroa 本机保险箱缺少原账号凭据' }; }
  const session = new Session(deps);
  if (account.source === 'generated' && account.status === 'draft' && account.registrationAttempts === 0) {
    const at = stamp(deps);
    const pending: Account = { ...account, status: 'unknown', registrationAttempts: 1, updatedAt: at,
      diagnostic: diagnostic('registration_unknown', 'Mataroa 注册意图已保存；以后仅登录原身份，不再次注册。', deps) };
    try { await context.saveAccount(pending); context.checkpoint({ checkpoint: 'mataroa_account_create_pending' }); }
    catch { return { status: 'queued', message: 'Mataroa 注册意图未能安全保存，未执行注册' }; }
    account = pending;
    try { await signup(session, credential); }
    catch (error) {
      const verify = error instanceof MataroaError && error.code === 'verification_required';
      const changed: Account = { ...account, status: verify ? 'needs_verification' : 'unknown', updatedAt: stamp(deps),
        diagnostic: diagnostic(verify ? 'verification_required' : 'registration_unknown', accountMessage(error), deps) };
      try { await context.saveAccount(changed); } catch { /* pending intent remains durable */ }
      return { status: 'needs_input', message: accountMessage(error), checkpoint: 'mataroa_account_create_pending' };
    }
  } else if (account.source === 'generated' && account.status === 'draft') {
    return { status: 'needs_input', message: 'Mataroa 原账号注册状态缺少尝试记录，不会再提交注册' };
  } else {
    try { await login(session, credential); }
    catch (error) {
      const verify = error instanceof MataroaError && error.code === 'verification_required';
      const changed: Account = { ...account, status: verify ? 'needs_verification' : account.status === 'registered' ? 'credentials_invalid' : 'unknown',
        updatedAt: stamp(deps), diagnostic: diagnostic(verify ? 'verification_required' : 'bad_password', accountMessage(error), deps) };
      try { await context.saveAccount(changed); } catch { /* original account remains */ }
      return { status: 'needs_input', message: accountMessage(error),
        checkpoint: account.source === 'generated' ? 'mataroa_account_create_pending' : 'account_handoff' };
    }
  }
  try {
    const setupAccount = account;
    const consumeInitialSetup = credential.initialSetupPending === true && account.source === 'generated' && account.registrationAttempts === 1
      ? async () => {
        const consumed = { ...credential };
        delete consumed.initialSetupPending;
        await context.saveAccount(setupAccount, JSON.stringify(consumed));
        credential = consumed;
      } : undefined;
    await ensureNotificationsOff(session, account.username, consumeInitialSetup);
    const token = await tokenFromDocs(session);
    await posts(token, account.username, deps);
    credential = { version: 1, username: credential.username, password: credential.password, token };
    const at = stamp(deps);
    const registered: Account = { ...account, status: 'registered', publicationUrl: home(account.username), hasPassword: true,
      registeredAt: account.registeredAt ?? at, verifiedAt: at, updatedAt: at, diagnostic: undefined };
    await context.saveAccount(registered, JSON.stringify(credential));
    return { account: registered, credential };
  } catch (error) {
    const manualSetting = error instanceof MataroaError && error.code === 'forbidden';
    const changed: Account = { ...account, status: manualSetting ? 'needs_verification' : account.status === 'registered' ? 'registered' : 'unknown',
      updatedAt: stamp(deps), diagnostic: diagnostic(manualSetting ? 'verification_required' : 'registration_unknown', accountMessage(error), deps) };
    try { await context.saveAccount(changed); } catch { /* original account remains */ }
    return { status: 'needs_input', message: accountMessage(error),
      checkpoint: account.source === 'generated' ? 'mataroa_account_create_pending' : 'account_handoff' };
  }
}
export async function connectMataroaAccount(vault: SecretStore, accountId: string, username: string, password: string,
  deps: MataroaDependencies = {}): Promise<{ username: string; url: string }> {
  if (!accountId || accountId.length > 128 || !USERNAME.test(username) || !validPassword(password)) throw new MataroaError('auth');
  const credential: Credential = { version: 1, username, password };
  const session = new Session(deps);
  await login(session, credential);
  await ensureNotificationsOff(session, username);
  credential.token = await tokenFromDocs(session);
  await posts(credential.token, username, deps);
  await vault.set(`account:${accountId}`, JSON.stringify(credential));
  return { username, url: home(username) };
}
export async function prepareMataroaIdentity(context: ExecutionContext, deps: MataroaDependencies = {}): Promise<ExecutionResult | undefined> {
  if (context.channel.id !== 'mataroa' || context.task.channelId !== 'mataroa' || context.task.sourceDomain !== 'mataroa.blog') {
    return { status: 'needs_input', message: '当前任务不属于 Mataroa 出版渠道' };
  }
  const result = await readyAccount(context, { ...deps, signal: context.signal });
  if ('status' in result) return result;
  if (result.account.status !== 'registered' || result.account.publicationUrl !== home(result.account.username)) {
    return { status: 'needs_input', message: 'Mataroa 作者身份或通知设置尚未验证' };
  }
  return undefined;
}
function unavailable(url: string, reason: string, outcome: LinkResult['outcome'] = 'unreachable'): LinkResult {
  return { found: false, outcome, url, rel: 'unknown', reason };
}
export async function verifyMataroaPublication(task: Task, target: string, deps: MataroaDependencies = {}): Promise<LinkResult> {
  const saved = task.mataroa;
  const fallback = task.publicUrl ?? `${ORIGIN}/`;
  if (!saved || !receipt(saved) || saved.stage !== 'published' || !saved.slug || !task.publicUrl) {
    return unavailable(fallback, 'Mataroa 任务缺少有效已发布回执', 'invalid');
  }
  try {
    const article = approvedArticle(task, { url: target }, false);
    if (task.channelId !== 'mataroa' || task.sourceDomain !== 'mataroa.blog' || article.contentHash !== saved.contentHash) throw Error('mismatch');
    const url = publicPostUrl(saved.username, saved.slug, task.publicUrl);
    const post: Post = { title: article.title, body: article.body, publishedDate: saved.publishedDate, slug: saved.slug, url };
    const rel = await visiblePost(post, article, deps);
    return { found: true, outcome: 'found', url, rel, reason: 'Mataroa 原文回执及匿名页面完整正文、目标 href 一致。' };
  } catch (error) {
    if (error instanceof MataroaError && error.code === 'not_found') return unavailable(fallback, 'Mataroa 原文章尚未公开', 'absent');
    if (error instanceof MataroaError && ['network', 'timeout', 'rate_limited', 'verification_required', 'cancelled'].includes(error.code)) {
      return unavailable(fallback, 'Mataroa 公开页面暂时无法核验');
    }
    return unavailable(fallback, 'Mataroa 回执或匿名页面与原文、公开链接不一致', 'invalid');
  }
}
export async function reconcileMataroaTask(context: ExecutionContext, deps: MataroaDependencies = {}): Promise<MataroaReconcileResult> {
  const saved = context.task.mataroa;
  const account = context.getAccount();
  if (!saved || !receipt(saved) || !account || account.id !== context.task.accountId || account.channelId !== 'mataroa'
    || account.username !== saved.username || context.task.channelId !== 'mataroa' || context.task.sourceDomain !== 'mataroa.blog') {
    return { status: 'unknown' };
  }
  try {
    const article = approvedArticle(context.task, context.site, false);
    if (article.contentHash !== saved.contentHash) return { status: 'unknown' };
    const credential = credentialFrom(await context.secrets.get(`account:${account.id}`), account.username);
    if (!credential.token) return { status: 'unknown' };
    const found = await findPublished(article, saved, credential.token, { ...deps, signal: context.signal });
    if (!found) return { status: 'unknown' };
    return { status: 'found', publicUrl: found.url, mataroa: { ...saved, slug: found.slug, stage: 'published' } };
  } catch { return { status: 'unknown' }; }
}
export async function runMataroaTask(context: ExecutionContext, deps: MataroaDependencies = {}): Promise<MataroaExecutionResult> {
  if (context.channel.id !== 'mataroa' || context.task.channelId !== 'mataroa' || context.task.sourceDomain !== 'mataroa.blog'
    || context.channel.domain !== 'mataroa.blog' || context.channel.automation !== 'api' || context.channel.kind !== 'article'
    || !context.channel.articleRequired || !context.channel.accountRequired || context.channel.contentFormat === 'social') {
    return { status: 'needs_input', message: '当前渠道规格不支持 Mataroa 原创全文 API 投稿' };
  }
  let article: Article;
  try { article = approvedArticle(context.task, context.site, !context.task.mataroa); }
  catch (error) { return { status: 'needs_input', message: error instanceof Error ? error.message : 'Mataroa 原创全文草稿无效' }; }
  const prior = context.task.mataroa;
  if (prior && (!receipt(prior) || prior.contentHash !== article.contentHash || context.getAccount()?.username !== prior.username)) {
    return { status: 'needs_input', message: 'Mataroa 原发布回执与当前全文或账号不一致，禁止再次投稿' };
  }
  if (!prior && (context.task.submittedAt || context.task.publicUrl || ['mataroa_publish_submitting', 'mataroa_published'].includes(context.task.checkpoint ?? ''))) {
    return { status: 'needs_input', message: 'Mataroa 已有投稿痕迹但缺少原回执，禁止创建替代文章' };
  }
  if (prior) {
    const found = await reconcileMataroaTask(context, deps);
    if (found.status === 'unknown') return { status: 'review', message: 'Mataroa 原投稿结果未能唯一确认；只读对账，不会再次 POST', mataroa: prior };
    try { context.checkpoint({ mataroa: found.mataroa, checkpoint: 'mataroa_published', publicUrl: found.publicUrl,
      submittedAt: context.task.submittedAt }); } catch { /* original intent remains durable */ }
    return { status: 'review', message: 'Mataroa 原全文和匿名页面已核验', publicUrl: found.publicUrl,
      mataroa: found.mataroa, checkpoint: 'mataroa_published', submittedAt: context.task.submittedAt };
  }
  if (context.signal.aborted) return { status: 'queued', message: '任务已暂停，尚未投稿' };
  const accountAtStart = context.getAccount();
  const access = await readyAccount(context, { ...deps, signal: context.signal });
  if ('status' in access) return access;
  if (!accountAtStart || accountAtStart.status !== 'registered' || accountAtStart.publicationUrl !== home(access.account.username)) {
    return { status: 'queued', message: 'Mataroa 作者身份已建立，请以该账号重新核对全文后继续' };
  }
  if (context.signal.aborted) return { status: 'queued', message: '任务已暂停，尚未投稿' };
  const date = stamp(deps).slice(0, 10);
  const pending: MataroaReceipt = { username: access.account.username, contentHash: article.contentHash,
    publishedDate: date, stage: 'submitting' };
  try {
    const priorMatches = (await posts(access.credential.token!, access.account.username, { ...deps, signal: context.signal }))
      .filter(post => post.title === article.title && post.body === article.body);
    if (priorMatches.length) return { status: 'needs_input', message: 'Mataroa 已存在同日相同全文，需人工核对后再继续' };
  } catch { return { status: 'needs_input', message: 'Mataroa 投稿前文章清单未能确认，未执行 POST' }; }
  const submittedAt = stamp(deps);
  try { context.checkpoint({ mataroa: pending, checkpoint: 'mataroa_publish_submitting', submittedAt, draft: context.task.draft }); }
  catch { return { status: 'queued', message: 'Mataroa 投稿意图未能持久保存，未执行 POST' }; }
  let slug: string | undefined;
  try {
    const result = await api('POST', access.credential.token!, { title: article.title, body: article.body, published_at: date },
      { ...deps, signal: context.signal });
    if (typeof result.slug !== 'string' || !SLUG.test(result.slug) || typeof result.url !== 'string') throw new MataroaError('invalid_response');
    publicPostUrl(access.account.username, result.slug, result.url);
    slug = result.slug;
  } catch {
    return { status: 'review', message: 'Mataroa 投稿结果不确定；只读对账且不会重发',
      mataroa: pending, checkpoint: 'mataroa_publish_submitting', submittedAt };
  }
  const identified: MataroaReceipt = { ...pending, slug };
  try { context.checkpoint({ mataroa: identified, checkpoint: 'mataroa_publish_submitting', submittedAt }); }
  catch { /* original pending intent remains durable */ }
  let found: Post | undefined;
  try { found = await findPublished(article, identified, access.credential.token!, { ...deps, signal: context.signal }); }
  catch { /* original intent remains durable */ }
  if (!found) return { status: 'review', message: 'Mataroa 已返回文章 slug，匿名全文仍待核验；不会重发',
    mataroa: identified, checkpoint: 'mataroa_publish_submitting', submittedAt };
  const published: MataroaReceipt = { ...identified, stage: 'published' };
  try { context.checkpoint({ mataroa: published, checkpoint: 'mataroa_published', publicUrl: found.url, submittedAt }); }
  catch { /* original intent remains durable */ }
  return { status: 'review', message: 'Mataroa 原文、账号和匿名页面目标 href 已核验', publicUrl: found.url,
    mataroa: published, checkpoint: 'mataroa_published', submittedAt };
}

export const mataroaTesting = { approvedArticle, receipt, publicPostUrl, renderedArticle, formValues };
