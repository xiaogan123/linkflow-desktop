import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { marked } from 'marked';
import { inspectRenderedArticle } from './article-rendering';
import { applyDeclaredArticleVisibility, styleConcealsArticle } from './article-visibility';
import { normalizePublicUrl } from './web';
import { articleReviewStillValid } from '../main/article-review';
import type {
  Account, ExecutionContext, ExecutionResult, LinkResult, SecretStore, Task, WordPressReceipt,
} from '../shared/types';
export type { WordPressReceipt } from '../shared/types';

const API_ORIGIN = 'https://public-api.wordpress.com';
const CHANNEL_ID = 'wordpress-com';
const SOURCE_DOMAIN = 'wordpress.com';
const MAX_JSON_BYTES = 2_000_000;
const MAX_HTML_BYTES = 4_000_000;
const MAX_ARTICLE_BYTES = 1_000_000;
const MAX_TOKEN_BYTES = 8_192;
const DEFAULT_TIMEOUT_MS = 15_000;
const BLOG_ID = /^[1-9][0-9]{0,19}$/;
const POST_ID = /^[1-9][0-9]{0,19}$/;
const HASH = /^[a-f0-9]{64}$/;
const SLUG = /^lf-[a-z0-9]{1,32}-[a-f0-9]{12}$/;
const SAFE_ELEMENTS = new Set([
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p',
  'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
]);

type JsonObject = Record<string, unknown>;
type WordPressTask = Task & { wordpress?: WordPressReceipt };

export interface WordPressSite {
  id: string;
  url: string;
  name: string;
  ownerId: string;
}

export type WordPressTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface WordPressDependencies {
  fetch?: WordPressTransport;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => Date;
  /** Exact expiry calculated from the OAuth callback's expires_in. Used only while connecting. */
  expiresAt?: string;
}
export interface WordPressExecutionResult extends ExecutionResult { wordpress?: WordPressReceipt }
export type WordPressReconcileResult =
  | { status: 'found'; publicUrl: string; wordpress: WordPressReceipt }
  | { status: 'unknown' };
export type WordPressErrorCode =
  | 'auth' | 'forbidden' | 'rate_limited' | 'not_found' | 'timeout' | 'cancelled' | 'network' | 'rejected' | 'invalid_response';

export class WordPressError extends Error {
  constructor(readonly code: WordPressErrorCode) {
    super(`WordPress.com request failed (${code})`);
    this.name = 'WordPressError';
  }
}

interface ApprovedArticle {
  title: string;
  markdown: string;
  html: string;
  target: string;
  links: string[];
  contentHash: string;
  slug: string;
}

interface RemotePost {
  postId: string;
  blogId: string;
  authorId: string;
  slug: string;
  title: string;
  content: string;
  url: string;
  status: string;
}

interface WordPressCredential {
  version: 1;
  accessToken: string;
  expiresAt: string;
  blogId: string;
  ownerId: string;
}

const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const textId = (value: unknown, pattern: RegExp): string | undefined => {
  const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value)
    : typeof value === 'string' ? value : undefined;
  return result && pattern.test(result) ? result : undefined;
};
const stamp = (dependencies: WordPressDependencies) => {
  const date = dependencies.now?.() ?? new Date();
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
};

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_TOKEN_BYTES
    && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function validFutureExpiry(value: unknown, dependencies: WordPressDependencies): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const expires = Date.parse(value);
  const now = (dependencies.now?.() ?? new Date()).getTime();
  return Number.isFinite(expires) && Number.isFinite(now) && expires > now;
}

function credentialFrom(
  raw: string | undefined, account: Pick<Account, 'username'>, dependencies: WordPressDependencies,
): WordPressCredential {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!object(value) || value.version !== 1 || !validToken(value.accessToken)
      || !validFutureExpiry(value.expiresAt, dependencies) || value.blogId !== account.username
      || !textId(value.blogId, BLOG_ID) || !textId(value.ownerId, BLOG_ID)) throw Error('invalid');
    return value as unknown as WordPressCredential;
  } catch { throw new WordPressError('auth'); }
}

function hostedBlogUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_048) throw new WordPressError('invalid_response');
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || url.pathname !== '/' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.wordpress\.com$/.test(host)) {
      throw Error('invalid');
    }
    return `https://${host}/`;
  } catch (error) {
    if (error instanceof WordPressError) throw error;
    throw new WordPressError('invalid_response');
  }
}

function canonicalTarget(value: string): string {
  try {
    const url = normalizePublicUrl(value);
    if (url.protocol !== 'https:') throw Error('invalid');
    return url.toString();
  } catch { throw new Error('WordPress.com 全文目标必须是不含凭据的公开 HTTPS 网址'); }
}

function canonicalLink(value: string): string {
  try {
    const url = normalizePublicUrl(value);
    if (url.protocol !== 'https:') throw Error('invalid');
    return url.toString();
  } catch { throw new Error('WordPress.com 全文中的链接必须是公开 HTTPS 网址'); }
}

function safeArticleHtml(markdown: string): { html: string; links: string[] } {
  const rendered = marked.parse(markdown, { async: false, gfm: true });
  if (typeof rendered !== 'string') throw new Error('WordPress.com Markdown 无法稳定渲染');
  const $ = load(rendered, undefined, false);
  if ($('h1,img,iframe,object,embed,form,input,button,video,audio,svg,math,script,style,template').length) {
    throw new Error('WordPress.com 全文不得包含一级标题、图片、表单、脚本或嵌入内容');
  }
  const links: string[] = [];
  for (const element of $.root().find('*').toArray()) {
    const tag = element.tagName?.toLowerCase() ?? '';
    if (!SAFE_ELEMENTS.has(tag)) throw new Error('WordPress.com 全文含有不受支持的 Markdown 结构');
    const attributes = { ...element.attribs };
    if (tag === 'a') {
      const href = attributes.href;
      if (!href || !$(element).text().trim()) throw new Error('WordPress.com 全文链接必须有可见文字');
      const canonical = canonicalLink(href);
      links.push(canonical);
      $(element).attr('href', canonical);
      for (const name of Object.keys(attributes)) if (!['href', 'title'].includes(name)) $(element).removeAttr(name);
    } else {
      for (const name of Object.keys(attributes)) {
        if (!(tag === 'code' && name === 'class' && /^language-[a-z0-9_+-]{1,32}$/i.test(attributes[name]))) {
          $(element).removeAttr(name);
        }
      }
    }
  }
  return { html: $.html(), links };
}

export function wordpressPostSlug(taskId: string, contentHash: string): string {
  if (!HASH.test(contentHash)) throw new WordPressError('invalid_response');
  const normalized = taskId.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32)
    || sha(taskId).slice(0, 32);
  return `lf-${normalized}-${contentHash.slice(0, 12)}`;
}

function approvedArticle(task: Task, siteUrl: string, requireApproval = true): ApprovedArticle {
  const draft = task.draft;
  const approvedAt = Date.parse(task.articleApprovedAt ?? '');
  if (!draft || requireApproval && !Number.isFinite(approvedAt)) {
    throw new Error('WordPress.com 全文须先通过当前稿件的独立核对');
  }
  if (typeof draft.title !== 'string' || draft.title !== draft.title.trim() || draft.title.length < 1
    || draft.title.length > 200 || /[\u0000-\u001f\u007f<>]/.test(draft.title)) {
    throw new Error('WordPress.com 标题必须是 1–200 个字符的单行文字');
  }
  if (typeof draft.body !== 'string' || draft.body !== draft.body.trim()
    || /\r|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|<[^>]*>/.test(draft.body)
    || Buffer.byteLength(draft.body, 'utf8') > MAX_ARTICLE_BYTES) {
    throw new Error('WordPress.com 需要不含 HTML、未截断且不超过 1 MB 的 Markdown 全文');
  }
  const paragraphs = draft.body.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
  const target = canonicalTarget(task.topicUrl ?? siteUrl);
  const rendered = safeArticleHtml(draft.body);
  const visible = load(rendered.html, undefined, false).root().text().replace(/\s+/g, ' ').trim();
  if (paragraphs.length < 2 || visible.replace(/\s/g, '').length < 200 || !rendered.links.includes(target)) {
    throw new Error('WordPress.com 需要有独立信息价值的完整文章及已核对目标链接');
  }
  const contentHash = sha(JSON.stringify({ title: draft.title, markdown: draft.body, target }));
  return { title: draft.title, markdown: draft.body, html: rendered.html, target, links: rendered.links,
    contentHash, slug: wordpressPostSlug(task.id, contentHash) };
}

function validReceipt(value: unknown): value is WordPressReceipt {
  if (!object(value) || !textId(value.blogId, BLOG_ID) || !textId(value.authorId, BLOG_ID)
    || typeof value.slug !== 'string' || !SLUG.test(value.slug)
    || typeof value.contentHash !== 'string' || !HASH.test(value.contentHash)
    || !['submitting', 'published'].includes(String(value.stage))) return false;
  const postId = value.postId === undefined ? undefined : textId(value.postId, POST_ID);
  if (value.postId !== undefined && !postId) return false;
  if (value.url !== undefined && !validPostUrl(value.url, undefined, value.slug)) return false;
  if ((postId === undefined) !== (value.url === undefined)) return false;
  return value.stage !== 'published' || !!postId && typeof value.url === 'string';
}

function validPostUrl(value: unknown, blogRoot?: string, slug?: string): string | undefined {
  if (typeof value !== 'string' || value.length > 2_048) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || !url.pathname.endsWith('/') || !url.pathname.split('/').filter(Boolean).length) return;
    if (blogRoot && url.hostname !== new URL(hostedBlogUrl(blogRoot)).hostname) return;
    const last = url.pathname.split('/').filter(Boolean).at(-1);
    if (slug && last !== slug) return;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.wordpress\.com$/.test(url.hostname)) return;
    return url.toString();
  } catch { return; }
}

function apiUrl(path: string): URL {
  if (!/^\/rest\/v1\.1\/(?:me(?:\/sites)?|sites\/[1-9][0-9]{0,19}(?:\/posts\/slug:lf-[a-z0-9]{1,32}-[a-f0-9]{12})?)$/.test(path)
    && !/^\/wp\/v2\/sites\/[1-9][0-9]{0,19}\/posts$/.test(path)) throw new WordPressError('invalid_response');
  return new URL(path, API_ORIGIN);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(new WordPressError('cancelled'));
  }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new WordPressError('cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

async function boundedText(response: Response, maximum: number, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maximum) throw new WordPressError('invalid_response');
  if (!response.body) throw new WordPressError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new WordPressError('invalid_response');
      chunks.push(next.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(value => Buffer.from(value)))); }
  catch { throw new WordPressError('invalid_response'); }
}

async function request(
  url: URL, init: RequestInit, dependencies: WordPressDependencies, maximum: number,
): Promise<{ response: Response; text: string }> {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new WordPressError('invalid_response');
  const external = dependencies.signal;
  if (external?.aborted) throw new WordPressError('cancelled');
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  external?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timeout = Math.min(60_000, Math.max(100, dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  timer.unref?.();
  try {
    const response = await abortable((dependencies.fetch ?? fetch)(url.toString(), {
      ...init, redirect: 'manual', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
    }), controller.signal);
    if (response.redirected || response.url && response.url !== url.toString()
      || response.status >= 300 && response.status < 400) throw new WordPressError('invalid_response');
    if (response.status === 401) throw new WordPressError('auth');
    if (response.status === 403) throw new WordPressError('forbidden');
    if (response.status === 404 || response.status === 410) throw new WordPressError('not_found');
    if (response.status === 429) throw new WordPressError('rate_limited');
    if (response.status === 408 || response.status >= 500) throw new WordPressError('network');
    if (!response.ok) throw new WordPressError('rejected');
    return { response, text: await boundedText(response, maximum, controller.signal) };
  } catch (error) {
    if (external?.aborted) throw new WordPressError('cancelled');
    if (timedOut) throw new WordPressError('timeout');
    throw error instanceof WordPressError ? error : new WordPressError('network');
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onAbort);
  }
}

async function jsonRequest(
  path: string, dependencies: WordPressDependencies, options: { token?: string; method?: 'GET' | 'POST'; body?: JsonObject } = {},
): Promise<JsonObject> {
  if (options.token !== undefined && !validToken(options.token)) throw new WordPressError('auth');
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'Linkflow-Desktop' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body) headers['content-type'] = 'application/json';
  const { response, text } = await request(apiUrl(path), {
    method: options.method ?? 'GET', headers, ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  }, dependencies, MAX_JSON_BYTES);
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new WordPressError('invalid_response');
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!object(value)) throw Error('invalid');
    return value;
  } catch { throw new WordPressError('invalid_response'); }
}

function parseSite(value: unknown, ownerId: string): WordPressSite | undefined {
  if (!object(value)) return;
  const id = textId(value.ID, BLOG_ID);
  if (!id || value.jetpack !== false || value.is_private !== false || value.user_can_manage !== true
    || !object(value.capabilities) || value.capabilities.publish_posts !== true || value.capabilities.edit_posts !== true
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 300
    || /[\u0000-\u001f\u007f]/.test(value.name)) return;
  try { return { id, url: hostedBlogUrl(value.URL), name: value.name.trim(), ownerId }; }
  catch { return; }
}

function publicSiteMatches(value: JsonObject, site: WordPressSite): boolean {
  const launch = value.launch_status;
  return textId(value.ID, BLOG_ID) === site.id && value.jetpack === false && value.is_private === false
    && value.is_coming_soon === false && (launch === undefined || launch === 'launched')
    && (() => { try { return hostedBlogUrl(value.URL) === site.url; } catch { return false; } })();
}

export async function listWordPressSites(
  accessToken: string, dependencies: WordPressDependencies = {},
): Promise<WordPressSite[]> {
  if (!validToken(accessToken)) throw new WordPressError('auth');
  const me = await jsonRequest('/rest/v1.1/me', dependencies, { token: accessToken });
  const ownerId = textId(me.ID, BLOG_ID);
  if (!ownerId) throw new WordPressError('invalid_response');
  const listing = await jsonRequest('/rest/v1.1/me/sites', dependencies, { token: accessToken });
  if (!Array.isArray(listing.sites) || listing.sites.length > 100) throw new WordPressError('invalid_response');
  const sites = listing.sites.map(value => parseSite(value, ownerId)).filter((value): value is WordPressSite => !!value);
  const unique = new Map<string, WordPressSite>();
  for (const site of sites) {
    if (unique.has(site.id)) throw new WordPressError('invalid_response');
    const publicDetails = await jsonRequest(`/rest/v1.1/sites/${site.id}`, dependencies);
    if (publicSiteMatches(publicDetails, site)) unique.set(site.id, site);
  }
  return [...unique.values()];
}

export async function connectWordPressAccount(
  vault: SecretStore, accountId: string, siteId: string, accessToken: string, dependencies: WordPressDependencies = {},
): Promise<{ username: string; url: string; name: string; ownerId: string }> {
  if (!accountId || accountId.length > 128 || !BLOG_ID.test(siteId) || !validToken(accessToken)
    || !validFutureExpiry(dependencies.expiresAt, dependencies)) throw new WordPressError('auth');
  const sites = await listWordPressSites(accessToken, dependencies);
  const selected = sites.find(site => site.id === siteId);
  if (!selected) throw new WordPressError('forbidden');
  const credential: WordPressCredential = { version: 1, accessToken, expiresAt: dependencies.expiresAt,
    blogId: selected.id, ownerId: selected.ownerId };
  await vault.set(`account:${accountId}`, JSON.stringify(credential));
  return { username: selected.id, url: selected.url, name: selected.name, ownerId: selected.ownerId };
}

function contextMatches(context: ExecutionContext): boolean {
  return context.channel.id === CHANNEL_ID && context.channel.domain === SOURCE_DOMAIN
    && context.channel.kind === 'article' && context.channel.automation === 'api'
    && context.channel.articleRequired && context.channel.accountRequired
    && context.task.channelId === CHANNEL_ID && context.task.sourceDomain === SOURCE_DOMAIN;
}

function exactAccount(context: ExecutionContext, account: Account | undefined): account is Account {
  if (!account || !context.task.accountId || account.id !== context.task.accountId || account.channelId !== CHANNEL_ID
    || account.status !== 'registered' || account.credentialKind !== 'oauth' || !account.hasPassword
    || !BLOG_ID.test(account.username) || typeof account.publicationUrl !== 'string') return false;
  try { return hostedBlogUrl(account.publicationUrl) === account.publicationUrl; }
  catch { return false; }
}

function checkpoint(context: ExecutionContext, partial: Partial<Task> & { wordpress: WordPressReceipt }): void {
  context.checkpoint(partial as Partial<Task>);
}

function htmlPlainText(value: unknown): string | undefined {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 20_000) return;
  const $ = load(value, undefined, false);
  if ($.root().find('*').length) return;
  return $.root().text();
}

function linksFromHtml(html: string): string[] | undefined {
  try {
    const $ = load(html, undefined, false);
    return $('a[href]').toArray().map(element => canonicalLink($(element).attr('href') ?? ''));
  } catch { return; }
}

function exactContent(content: string, article: ApprovedArticle): { rel: string } | undefined {
  const inspected = inspectRenderedArticle(`<article>${content}</article>`, article.markdown, article.target, 'article');
  if (!inspected.found) return;
  const links = linksFromHtml(content);
  if (!links || JSON.stringify(links) !== JSON.stringify(article.links)) return;
  return { rel: inspected.rel };
}

function parseLegacyPost(value: JsonObject, expectedBlogId: string): RemotePost {
  const postId = textId(value.ID, POST_ID);
  const blogId = textId(value.site_ID, BLOG_ID);
  const authorId = object(value.author) ? textId(value.author.ID, BLOG_ID) : undefined;
  const slug = typeof value.slug === 'string' && SLUG.test(value.slug) ? value.slug : undefined;
  const url = validPostUrl(value.URL, undefined, slug);
  if (!postId || blogId !== expectedBlogId || !authorId || !slug || !url || typeof value.title !== 'string'
    || typeof value.content !== 'string' || typeof value.status !== 'string') throw new WordPressError('invalid_response');
  return { postId, blogId, authorId, slug, title: value.title, content: value.content, url, status: value.status };
}

function parseCreatedPost(value: JsonObject, expected: ApprovedArticle, site: WordPressSite): RemotePost {
  const postId = textId(value.id, POST_ID);
  const authorId = textId(value.author, BLOG_ID);
  const slug = typeof value.slug === 'string' && SLUG.test(value.slug) ? value.slug : undefined;
  const title = object(value.title) ? htmlPlainText(value.title.rendered) : undefined;
  const content = object(value.content) && typeof value.content.rendered === 'string' ? value.content.rendered : undefined;
  const url = validPostUrl(value.link, site.url, slug);
  if (!postId || !authorId || !slug || !title || content === undefined || !url || value.status !== 'publish'
    || slug !== expected.slug || title !== expected.title || !exactContent(content, expected)) {
    throw new WordPressError('invalid_response');
  }
  return { postId, blogId: site.id, authorId, slug, title, content, url, status: 'publish' };
}

function exactRemotePost(post: RemotePost, article: ApprovedArticle, receipt: WordPressReceipt, blogRoot: string): boolean {
  return post.blogId === receipt.blogId && post.authorId === receipt.authorId && post.slug === receipt.slug
    && post.title === article.title && post.status === 'publish' && !!exactContent(post.content, article)
    && (!receipt.postId || receipt.postId === post.postId) && (!receipt.url || receipt.url === post.url)
    && !!validPostUrl(post.url, blogRoot, receipt.slug);
}

function nodeHidden(value: unknown): boolean {
  let node = value as { name?: string; tagName?: string; attribs?: Record<string, string>; parent?: unknown } | undefined;
  while (node) {
    const name = (node.name ?? node.tagName ?? '').toLowerCase();
    const attributes = node.attribs ?? {};
    const classes = new Set((attributes.class ?? '').split(/\s+/).filter(Boolean));
    if (['script', 'style', 'template', 'noscript'].includes(name) || Object.hasOwn(attributes, 'hidden')
      || attributes['aria-hidden']?.toLowerCase() === 'true' || ['hidden', 'invisible', 'collapse', 'sr-only'].some(item => classes.has(item))
      || styleConcealsArticle(attributes.style ?? '')) return true;
    node = node.parent as typeof node;
  }
  return false;
}

function blocksIndexing(value: string): boolean {
  return /(?:^|[,;\s])(?:noindex|none)(?=$|[,;\s])/i.test(value);
}

function inspectPublicPage(html: string, headers: Headers, article: ApprovedArticle, url: string): { rel: string } | undefined {
  try {
    if (blocksIndexing(headers.get('x-robots-tag') ?? '')) return;
    const $ = load(html);
    applyDeclaredArticleVisibility($);
    const robots = $('meta[name]').toArray().some(element => {
      const name = ($(element).attr('name') ?? '').trim().toLowerCase();
      return ['robots', 'googlebot', 'bingbot'].includes(name)
        && blocksIndexing($(element).attr('content') ?? '');
    });
    if (robots) return;
    const canonicals = $('link[rel~="canonical"][href]').toArray();
    if (canonicals.length !== 1 || canonicals.some(element => $(element).attr('href') !== url)) return;
    const titles = $('article h1,.entry-title,.wp-block-post-title').toArray()
      .filter(element => !nodeHidden(element) && $(element).text().replace(/\s+/g, ' ').trim() === article.title);
    if (!titles.length) return;
    for (const selector of ['article .entry-content', 'article .wp-block-post-content', 'article .post-content', '.entry-content', '.wp-block-post-content']) {
      const result = inspectRenderedArticle(html, article.markdown, article.target, selector,{pageUrl:url,robotsHeader:headers.get('x-robots-tag')??''});
      if (result.found) {
        const scope = $(selector).toArray().filter(element => !nodeHidden(element));
        if (scope.length !== 1) continue;
        const links = linksFromHtml($.html(scope[0]));
        if (links && JSON.stringify(links) === JSON.stringify(article.links)) return { rel: result.rel };
      }
    }
    return;
  } catch { return; }
}

async function readPublicPost(
  receipt: WordPressReceipt, article: ApprovedArticle, blogRoot: string, dependencies: WordPressDependencies,
): Promise<{ post: RemotePost; rel: string }> {
  const raw = await jsonRequest(`/rest/v1.1/sites/${receipt.blogId}/posts/slug:${receipt.slug}`, dependencies);
  const post = parseLegacyPost(raw, receipt.blogId);
  if (!exactRemotePost(post, article, receipt, blogRoot)) throw new WordPressError('invalid_response');
  const publicUrl = new URL(post.url);
  const { response, text } = await request(publicUrl, { method: 'GET', headers: { accept: 'text/html', 'user-agent': 'Linkflow-Desktop' } },
    dependencies, MAX_HTML_BYTES);
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/html')) throw new WordPressError('invalid_response');
  const visible = inspectPublicPage(text, response.headers, article, post.url);
  if (!visible) throw new WordPressError('invalid_response');
  return { post, rel: visible.rel };
}

async function assertSlugAbsent(blogId: string, slug: string, dependencies: WordPressDependencies): Promise<void> {
  try {
    await jsonRequest(`/rest/v1.1/sites/${blogId}/posts/slug:${slug}`, dependencies);
    throw new WordPressError('rejected');
  } catch (error) {
    if (error instanceof WordPressError && error.code === 'not_found') return;
    throw error;
  }
}

function unavailable(url: string, outcome: LinkResult['outcome'], reason: string): LinkResult {
  return { found: false, outcome, url, rel: 'unknown', reason };
}

export async function verifyWordPressPublication(
  task: Task, targetSiteUrl: string, dependencies: WordPressDependencies = {},
): Promise<LinkResult> {
  const saved = (task as WordPressTask).wordpress;
  const fallback = task.publicUrl ?? API_ORIGIN;
  try {
    if (task.channelId !== CHANNEL_ID || task.sourceDomain !== SOURCE_DOMAIN || !validReceipt(saved)
      || saved.stage !== 'published' || !saved.url || task.publicUrl !== saved.url) {
      return unavailable(fallback, 'invalid', 'WordPress.com 任务缺少一致的已发布回执');
    }
    const article = approvedArticle(task, targetSiteUrl, false);
    if (article.slug !== saved.slug || article.contentHash !== saved.contentHash) {
      return unavailable(fallback, 'invalid', 'WordPress.com 原文、稳定地址与回执不一致');
    }
    const root = `https://${new URL(saved.url).hostname}/`;
    const found = await readPublicPost(saved, article, root, dependencies);
    return { found: true, outcome: 'found', url: found.post.url, rel: found.rel,
      reason: 'WordPress.com 匿名 API 与公开页的作者、标题、完整正文及全部链接一致；这不保证搜索收录或排名' };
  } catch (error) {
    if (error instanceof WordPressError && error.code === 'not_found') {
      return unavailable(fallback, 'absent', 'WordPress.com 原发布 slug 暂未公开');
    }
    if (error instanceof WordPressError && ['network', 'timeout', 'cancelled', 'rate_limited'].includes(error.code)) {
      return unavailable(fallback, 'unreachable', 'WordPress.com 匿名 API 或公开页暂时无法核验');
    }
    return unavailable(fallback, 'invalid', 'WordPress.com 公开内容、作者、网址或可见性与原回执不一致');
  }
}

export async function reconcileWordPressTask(
  context: ExecutionContext, dependencies: WordPressDependencies = {},
): Promise<WordPressReconcileResult> {
  const saved = (context.task as WordPressTask).wordpress;
  const account = context.getAccount();
  if (!contextMatches(context) || !validReceipt(saved) || !exactAccount(context, account)
    || saved.blogId !== account.username || !saved.url && !!context.task.publicUrl
    || saved.url && context.task.publicUrl && saved.url !== context.task.publicUrl) return { status: 'unknown' };
  try {
    const article = approvedArticle(context.task, context.site.url, false);
    if (article.slug !== saved.slug || article.contentHash !== saved.contentHash) return { status: 'unknown' };
    const result = await readPublicPost(saved, article, account.publicationUrl!, { ...dependencies, signal: context.signal });
    return { status: 'found', publicUrl: result.post.url, wordpress: {
      ...saved, stage: 'published', postId: result.post.postId, url: result.post.url,
    } };
  } catch { return { status: 'unknown' }; }
}

function firstRunFailure(error: unknown): WordPressExecutionResult {
  if (error instanceof WordPressError && ['auth', 'forbidden'].includes(error.code)) {
    return { status: 'needs_input', message: 'WordPress.com 授权、站点绑定或发布权限已失效，未投稿' };
  }
  if (error instanceof WordPressError && ['rate_limited', 'timeout', 'network', 'cancelled'].includes(error.code)) {
    return { status: 'queued', message: 'WordPress.com 身份或重复项检查暂时未完成，未投稿' };
  }
  return { status: 'needs_input', message: 'WordPress.com 站点身份或公开发布条件无法安全确认，未投稿' };
}

export async function runWordPressTask(
  context: ExecutionContext, dependencies: WordPressDependencies = {},
): Promise<WordPressExecutionResult> {
  if (!contextMatches(context)) return { status: 'needs_input', message: '当前渠道不支持 WordPress.com 全文 API' };
  const account = context.getAccount();
  if (!exactAccount(context, account)) return { status: 'needs_input', message: 'WordPress.com 任务缺少已验证的单站授权绑定' };
  const prior = (context.task as WordPressTask).wordpress;
  if (!prior && !articleReviewStillValid(context.task, context.site, context.channel, context.settings, account)) {
    return { status: 'needs_input', message: 'WordPress.com 全文的事实与渠道独立 AI 核对未通过或已失效' };
  }
  let article: ApprovedArticle;
  try { article = approvedArticle(context.task, context.site.url, !prior); }
  catch (error) { return { status: 'needs_input', message: error instanceof Error ? error.message : 'WordPress.com 原稿无效' }; }

  if (prior) {
    if (!validReceipt(prior) || prior.blogId !== account.username || prior.slug !== article.slug
      || prior.contentHash !== article.contentHash
      || (prior.url ?? '') !== (context.task.publicUrl ?? '') && (!!prior.url || !!context.task.publicUrl)) {
      return { status: 'needs_input', message: 'WordPress.com 回执、稿件或原站点身份已改变，禁止重发', wordpress: prior };
    }
    const result = await reconcileWordPressTask(context, dependencies);
    if (result.status === 'found') {
      try { checkpoint(context, { wordpress: result.wordpress, checkpoint: 'wordpress_published',
        submittedAt: context.task.submittedAt, publicUrl: result.publicUrl }); } catch { /* Read-only identity is still returned. */ }
      return { status: 'review', message: 'WordPress.com 原投稿已找回并通过匿名全文核验，未再次发送；搜索收录不保证',
        publicUrl: result.publicUrl, wordpress: result.wordpress, checkpoint: 'wordpress_published', submittedAt: context.task.submittedAt };
    }
    return { status: 'review', message: 'WordPress.com 原投稿结果待核清；只读查证且不会重发', wordpress: prior,
      checkpoint: prior.stage === 'published' ? 'wordpress_published' : 'wordpress_publish_submitting',
      submittedAt: context.task.submittedAt, ...(prior.url ? { publicUrl: prior.url } : {}) };
  }
  if (context.task.submittedAt || context.task.publicUrl
    || ['wordpress_publish_submitting', 'wordpress_published'].includes(context.task.checkpoint ?? '')) {
    return { status: 'needs_input', message: 'WordPress.com 投稿痕迹缺少匹配回执，禁止重发' };
  }
  if (context.signal.aborted) return { status: 'queued', message: '任务已暂停，尚未投稿' };

  let credential: WordPressCredential;
  let selected: WordPressSite;
  try {
    const secret = await context.secrets.get(`account:${account.id}`);
    credential = credentialFrom(secret, account, dependencies);
    const sites = await listWordPressSites(credential.accessToken, { ...dependencies, signal: context.signal });
    const match = sites.find(site => site.id === account.username && site.url === account.publicationUrl);
    if (!match || match.ownerId !== credential.ownerId) throw new WordPressError('forbidden');
    selected = match;
    await assertSlugAbsent(selected.id, article.slug, { ...dependencies, signal: context.signal });
  } catch (error) { return firstRunFailure(error); }

  const pending: WordPressReceipt = { blogId: selected.id, authorId: selected.ownerId, slug: article.slug,
    contentHash: article.contentHash, stage: 'submitting' };
  const submittedAt = stamp(dependencies);
  try { checkpoint(context, { wordpress: pending, checkpoint: 'wordpress_publish_submitting', submittedAt }); }
  catch { return { status: 'queued', message: 'WordPress.com 投稿意图未持久保存，未发送' }; }

  let created: RemotePost;
  try {
    const value = await jsonRequest(`/wp/v2/sites/${selected.id}/posts`, { ...dependencies, signal: context.signal }, {
      token: credential.accessToken, method: 'POST', body: { title: article.title, content: article.html, status: 'publish', slug: article.slug },
    });
    created = parseCreatedPost(value, article, selected);
    if (created.authorId !== selected.ownerId) throw new WordPressError('invalid_response');
  } catch {
    return { status: 'review', message: 'WordPress.com 投稿结果不明；已保留稳定 slug，后续只读查证且不会重发',
      wordpress: pending, checkpoint: 'wordpress_publish_submitting', submittedAt };
  }

  const identified: WordPressReceipt = { ...pending, postId: created.postId, url: created.url };
  let identitySaved = false;
  try {
    checkpoint(context, { wordpress: identified, checkpoint: 'wordpress_publish_submitting', submittedAt, publicUrl: created.url });
    identitySaved = true;
  } catch { /* Return exact response identity so the controller can durably retain it. */ }
  if (!identitySaved) return { status: 'review', message: 'WordPress.com 已返回公开地址；待本机保存匹配回执后只读核验，不会重发',
    publicUrl: created.url, wordpress: identified, checkpoint: 'wordpress_publish_submitting', submittedAt };

  try {
    const found = await readPublicPost(identified, article, selected.url, { ...dependencies, signal: context.signal });
    const published: WordPressReceipt = { ...identified, stage: 'published', postId: found.post.postId, url: found.post.url };
    try { checkpoint(context, { wordpress: published, checkpoint: 'wordpress_published', submittedAt, publicUrl: found.post.url }); }
    catch { /* The durable post identity remains sufficient for later read-only recovery. */ }
    return { status: 'review', message: 'WordPress.com 匿名 API 与公开页已核验完整原文和链接；搜索收录不保证',
      publicUrl: found.post.url, wordpress: published, checkpoint: 'wordpress_published', submittedAt };
  } catch {
    return { status: 'review', message: 'WordPress.com 已返回公开地址，完整全文仍待只读核验；不会重发',
      publicUrl: created.url, wordpress: identified, checkpoint: 'wordpress_publish_submitting', submittedAt };
  }
}

export const wordpressTesting = {
  approvedArticle, hostedBlogUrl, inspectPublicPage, validReceipt, validPostUrl,
};
