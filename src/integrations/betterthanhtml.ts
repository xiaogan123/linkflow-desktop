import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { marked } from 'marked';
import { applyDeclaredArticleVisibility, styleConcealsArticle } from './article-visibility';
import { normalizePublicUrl } from './web';
import type {
  BetterThanHtmlReceipt,
  ExecutionContext,
  ExecutionResult,
  LinkResult,
  Task,
} from '../shared/types';

const ORIGIN = 'https://betterthanhtml.com';
const SUBMIT_URL = `${ORIGIN}/api/workshop/submit`;
const LIST_URL = `${ORIGIN}/api/workshop/list`;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_DOCUMENT_BYTES = 2_000_000;
const MAX_API_BYTES = 128_000;
const MAX_PUBLIC_HTML_BYTES = 3_000_000;
const MAX_RECOVERY_CANDIDATES = 5;
const RECOVERY_BEFORE_MS = 60_000;
const RECOVERY_AFTER_MS = 120_000;
const SAFE_ELEMENTS = new Set([
  'p', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'strong', 'em', 'del', 'a', 'br', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);
type Json = Record<string, unknown>;

export type BetterThanHtmlTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface BetterThanHtmlDependencies {
  fetch?: BetterThanHtmlTransport;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => Date;
}
export interface BetterThanHtmlExecutionResult extends ExecutionResult {
  betterthanhtml?: BetterThanHtmlReceipt;
}
export type BetterThanHtmlReconcileResult =
  | { status: 'found'; publicUrl: string; betterthanhtml: BetterThanHtmlReceipt }
  | { status: 'unknown' };

class BetterThanHtmlError extends Error {
  constructor(readonly code: 'network' | 'timeout' | 'cancelled' | 'challenge' | 'rate' | 'absent' | 'invalid' | 'mismatch') {
    super(`Better Than HTML request failed (${code})`);
    this.name = 'BetterThanHtmlError';
  }
}

const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const stamp = (deps: BetterThanHtmlDependencies) => (deps.now?.() ?? new Date()).toISOString();
const codePoints = (value: string) => Array.from(value).length;
const normalizedText = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
const mediaType = (response: Response) => (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}
function reviewedContentHash(task: Task): string {
  return sha256(JSON.stringify(canonicalValue({ draft: task.draft ?? null,
    topicUrl: task.topicUrl, topicContentHash: task.topicContentHash })));
}

function publicUrl(id: string): string {
  if (!ID.test(id)) throw new BetterThanHtmlError('invalid');
  return `${ORIGIN}/workshop/${id}`;
}

function publicHttps(value: string): string {
  try {
    if (!/^https:\/\//i.test(value.trim())) throw Error('HTTPS required');
    const parsedInput = new URL(value.trim());
    if (parsedInput.hash) throw Error('Fragments are not accepted');
    const url = normalizePublicUrl(value);
    if (url.protocol !== 'https:') throw Error('HTTPS required');
    return url.toString();
  } catch {
    throw new BetterThanHtmlError('invalid');
  }
}

function sameSite(left: string, right: string): boolean {
  const host = (value: string) => new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  return host(left) === host(right);
}

function receipt(value: unknown): value is BetterThanHtmlReceipt {
  return object(value)
    && typeof value.contentHash === 'string' && HASH.test(value.contentHash)
    && (value.stage === 'submitting' || value.stage === 'published')
    && (value.id === undefined || typeof value.id === 'string' && ID.test(value.id))
    && (value.stage !== 'published' || typeof value.id === 'string');
}

function currentlyApproved(task: Task): boolean {
  if (task.articleReview) {
    return task.articleReview.status === 'passed'
      && task.articleReview.draftRevision === (task.draftRevision ?? 0)
      && task.articleReview.contentHash === reviewedContentHash(task);
  }
  const approvedAt = Date.parse(task.articleApprovedAt ?? '');
  if (!Number.isFinite(approvedAt)) return false;
  if (task.draftUpdatedAt) {
    const updatedAt = Date.parse(task.draftUpdatedAt);
    if (!Number.isFinite(updatedAt) || approvedAt < updatedAt) return false;
  }
  return true;
}

function safeAttributes(tag: string, attributes: Record<string, string>, actual: boolean): Record<string, string> {
  const result: Record<string, string> = {};
  if (tag === 'a') {
    if (typeof attributes.href !== 'string') throw new BetterThanHtmlError('invalid');
    result.href = publicHttps(attributes.href);
    if (attributes.title !== undefined) {
      if (!attributes.title.trim() || codePoints(attributes.title) > 300 || /[\u0000-\u001f\u007f]/.test(attributes.title)) {
        throw new BetterThanHtmlError('invalid');
      }
      result.title = attributes.title;
    }
    if (actual && attributes.rel !== undefined) {
      if (attributes.rel.length > 256 || /[\u0000-\u001f\u007f]/.test(attributes.rel)) throw new BetterThanHtmlError('invalid');
    }
    if (actual && attributes.target !== undefined && !['_blank', '_self'].includes(attributes.target)) {
      throw new BetterThanHtmlError('invalid');
    }
    const allowed = new Set(['href', 'title', ...(actual ? ['rel', 'target'] : [])]);
    if (Object.keys(attributes).some(name => !allowed.has(name.toLowerCase()))) throw new BetterThanHtmlError('invalid');
  } else if (tag === 'code' && attributes.class !== undefined) {
    if (!/^language-[a-z0-9_+-]{1,32}$/i.test(attributes.class) || Object.keys(attributes).some(name => name !== 'class')) {
      throw new BetterThanHtmlError('invalid');
    }
    result.class = attributes.class;
  } else if (tag === 'ol' && attributes.start !== undefined) {
    if (!/^-?\d{1,9}$/.test(attributes.start) || Object.keys(attributes).some(name => name !== 'start')) {
      throw new BetterThanHtmlError('invalid');
    }
    result.start = String(Number.parseInt(attributes.start, 10));
  } else if ((tag === 'th' || tag === 'td') && attributes.align !== undefined) {
    if (!['left', 'center', 'right'].includes(attributes.align.toLowerCase())
      || Object.keys(attributes).some(name => name !== 'align')) throw new BetterThanHtmlError('invalid');
    result.align = attributes.align.toLowerCase();
  } else if (Object.keys(attributes).length) {
    throw new BetterThanHtmlError('invalid');
  }
  return result;
}

function canonicalBody(html: string, actual = false): { html: string; links: Array<{ href: string; text: string; rel: string }> } {
  const $ = load(html, undefined, false);
  const links: Array<{ href: string; text: string; rel: string }> = [];
  for (const node of $.root().find('*').toArray()) {
    const element = $(node);
    const tag = node.type === 'tag' ? node.tagName.toLowerCase() : '';
    if (!SAFE_ELEMENTS.has(tag)) throw new BetterThanHtmlError('invalid');
    const attributes = safeAttributes(tag, element.attr() ?? {}, actual);
    if (tag === 'a') {
      const text = normalizedText(element.text());
      if (!text) throw new BetterThanHtmlError('invalid');
      links.push({ href: attributes.href, text, rel: (element.attr('rel') ?? '').trim().toLowerCase() });
    }
    for (const name of Object.keys(element.attr() ?? {})) element.removeAttr(name);
    for (const [name, value] of Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right))) {
      element.attr(name, value);
    }
  }
  // Inter-element whitespace can be visible between inline nodes and whitespace
  // inside preformatted content is authored text. Keep it byte-for-byte after
  // Cheerio's safe element/attribute serialization instead of collapsing it.
  const serialized = ($.root().html() ?? '').trim();
  if (!serialized) throw new BetterThanHtmlError('invalid');
  return { html: serialized, links };
}

const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (value: string) => escapeText(value).replace(/"/g, '&quot;');

function article(task: Task, target: string, requireApproval = true) {
  const draft = task.draft;
  if (!draft || requireApproval && !currentlyApproved(task)) {
    throw Error('Better Than HTML 全文须先通过当前稿件的独立核对');
  }
  if (typeof draft.title !== 'string' || draft.title !== draft.title.trim() || codePoints(draft.title) < 1
    || codePoints(draft.title) > 80 || /[\u0000-\u001f\u007f<>]/.test(draft.title)) {
    throw Error('Better Than HTML 标题须为 1–80 个字符的单行文字');
  }
  const description = typeof draft.description === 'string' && draft.description.length ? draft.description : undefined;
  if (description !== undefined && (description !== description.trim() || codePoints(description) > 220
    || /[\u0000-\u001f\u007f<>]/.test(description))) {
    throw Error('Better Than HTML 摘要须为不超过 220 个字符的单行文字');
  }
  if (typeof draft.body !== 'string' || draft.body !== draft.body.trim()
    || /\r|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|<[^>]*>/.test(draft.body)) {
    throw Error('Better Than HTML 需要不含 HTML 或控制字符的完整 Markdown 全文');
  }
  let rendered: string;
  try {
    const value = marked.parse(draft.body, { async: false, gfm: true });
    if (typeof value !== 'string') throw Error('invalid');
    rendered = value;
  } catch {
    throw Error('Better Than HTML 全文 Markdown 无法安全编译');
  }
  let body: ReturnType<typeof canonicalBody>;
  try { body = canonicalBody(rendered); }
  catch { throw Error('Better Than HTML 只支持无脚本、无图片与无主动资源的安全 Markdown'); }
  if (load(body.html, undefined, false)('h1').length) {
    throw Error('Better Than HTML 正文不应重复一级标题');
  }
  const site = publicHttps(target);
  const selected = publicHttps(task.topicUrl ?? site);
  if (!sameSite(site, selected)) throw Error('Better Than HTML 选题链接必须属于当前网站');
  if (!body.links.some(link => link.href === selected)) {
    throw Error('Better Than HTML 全文必须包含已核对的公开 HTTPS 正文链接');
  }
  const parsedBody = load(body.html, undefined, false);
  const paragraphs = parsedBody('p,li').toArray().filter(node => normalizedText(parsedBody(node).text()));
  if (paragraphs.length < 2 || normalizedText(parsedBody.root().text()).replace(/\s/g, '').length < 200) {
    throw Error('Better Than HTML 只发布至少两个有意义段落的完整独立文章');
  }
  const summary = description ? `\n<meta name="description" content="${escapeAttribute(description)}">` : '';
  const document = '<!doctype html>\n<html lang="und">\n<head>\n<meta charset="utf-8">'
    + '\n<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '\n<meta name="robots" content="index,follow">'
    + `\n<title>${escapeText(draft.title)}</title>${summary}`
    + '\n<style>body{margin:0;background:#f7f5ef;color:#20201d;font:18px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}'
    + 'main{max-width:760px;margin:0 auto;padding:48px 24px 72px}h1,h2,h3,h4,h5,h6{line-height:1.2;color:#181815}'
    + 'h1{font-size:clamp(2rem,6vw,3.4rem);margin:0 0 2rem}a{color:#075f55;text-underline-offset:.18em}'
    + 'pre{overflow:auto;padding:1rem;background:#ece9df;border-radius:.5rem}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}'
    + 'blockquote{margin-left:0;padding-left:1rem;border-left:4px solid #b7aa87}table{border-collapse:collapse;width:100%}'
    + 'th,td{padding:.5rem;border:1px solid #c9c2b0;text-align:left}</style>\n</head>\n<body>\n'
    + `<main id="linkflow-article"><article><h1>${escapeText(draft.title)}</h1><div id="linkflow-article-body">${body.html}</div></article></main>`
    + '\n</body>\n</html>';
  if (Buffer.byteLength(document, 'utf8') >= MAX_DOCUMENT_BYTES) {
    throw Error('Better Than HTML 完整 HTML 超过平台 2 MB 上限，不会截断发布');
  }
  // Bind the reviewed semantic payload, not presentational CSS, so a later
  // app update can still verify an existing immutable receipt read-only.
  const contentHash = sha256(JSON.stringify({ version: 1, title: draft.title,
    description: description ?? null, markdown: draft.body, target: selected }));
  return { title: draft.title, ...(description ? { description } : {}), body: draft.body, html: document,
    bodyHtml: body.html, links: body.links, target: selected, contentHash };
}
type Article = ReturnType<typeof article>;

function contextMatches(context: ExecutionContext): boolean {
  return context.channel.id === 'betterthanhtml' && context.channel.domain === 'betterthanhtml.com'
    && context.channel.kind === 'article' && context.channel.automation === 'api'
    && context.channel.articleRequired && !context.channel.accountRequired
    && context.task.channelId === 'betterthanhtml' && context.task.sourceDomain === 'betterthanhtml.com';
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(new BetterThanHtmlError('cancelled'));
  }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new BetterThanHtmlError('cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

async function request(
  url: string,
  method: 'GET' | 'POST',
  deps: BetterThanHtmlDependencies,
  payload?: Json,
): Promise<{ response: Response; text: string }> {
  const submit = method === 'POST' && url === SUBMIT_URL && !!payload;
  const list = method === 'GET' && url === LIST_URL && !payload;
  let read = false;
  if (method === 'GET' && !payload) {
    try {
      const parsed = new URL(url);
      const match = /^\/workshop\/([^/]+)$/.exec(parsed.pathname);
      read = parsed.origin === ORIGIN && !parsed.username && !parsed.password && !parsed.port
        && !parsed.search && !parsed.hash && !!match && ID.test(match[1]) && url === publicUrl(match[1]);
    } catch { read = false; }
  }
  if (!submit && !list && !read) throw new BetterThanHtmlError('invalid');
  if (deps.signal?.aborted) throw new BetterThanHtmlError('cancelled');
  const controller = new AbortController();
  const abort = () => controller.abort();
  deps.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(60_000, Math.max(100, deps.timeoutMs ?? 15_000)));
  timer.unref?.();
  let response: Response | undefined;
  try {
    response = await abortable((deps.fetch ?? fetch)(url, {
      method,
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
      headers: {
        accept: submit || list ? 'application/json' : 'text/html',
        'user-agent': 'Linkflow (reviewed static-article publisher)',
        ...(submit ? { 'content-type': 'application/json' } : {}),
      },
      ...(submit ? { body: JSON.stringify(payload) } : {}),
    }), controller.signal);
    if (response.redirected || response.url && response.url !== url
      || response.status >= 300 && response.status < 400) throw new BetterThanHtmlError('invalid');
    const maximum = submit || list ? MAX_API_BYTES : MAX_PUBLIC_HTML_BYTES;
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximum) throw new BetterThanHtmlError('invalid');
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const next = await abortable(reader.read(), controller.signal);
          if (next.done) break;
          size += next.value.byteLength;
          if (size > maximum) throw new BetterThanHtmlError('invalid');
          chunks.push(next.value);
        }
      } catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(value => Buffer.from(value))));
    } catch { throw new BetterThanHtmlError('invalid'); }
    if (response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge'
      || /cf-chl-|g-recaptcha|h-captcha|cf-turnstile|verify (?:that )?you are human|just a moment/i.test(text)) {
      throw new BetterThanHtmlError('challenge');
    }
    if (response.status === 404 || response.status === 410 || response.status === 451) throw new BetterThanHtmlError('absent');
    if (response.status === 429) throw new BetterThanHtmlError('rate');
    if (response.status === 401 || response.status === 403) throw new BetterThanHtmlError('challenge');
    if (response.status === 408 || response.status >= 500) throw new BetterThanHtmlError('network');
    if (response.status < 200 || response.status >= 300) throw new BetterThanHtmlError('invalid');
    return { response, text };
  } catch (error) {
    // Header validation can reject before a reader is acquired. Stop that body too.
    controller.abort();
    void response?.body?.cancel().catch(() => undefined);
    if (deps.signal?.aborted) throw new BetterThanHtmlError('cancelled');
    if (timedOut) throw new BetterThanHtmlError('timeout');
    throw error instanceof BetterThanHtmlError ? error : new BetterThanHtmlError('network');
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', abort);
  }
}

async function submit(expected: Article, deps: BetterThanHtmlDependencies): Promise<Json> {
  const payload: Json = { title: expected.title, html: expected.html, category: 'leaflet' };
  if (expected.description) payload.description = expected.description;
  const { response, text } = await request(SUBMIT_URL, 'POST', deps, payload);
  if (response.status !== 200 || mediaType(response) !== 'application/json') {
    throw new BetterThanHtmlError('invalid');
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!object(value)) throw Error('invalid');
    return value;
  } catch { throw new BetterThanHtmlError('invalid'); }
}

function responseIdentity(value: Json): { id: string; url: string } | undefined {
  if (value.ok !== true || typeof value.id !== 'string' || !ID.test(value.id) || typeof value.url !== 'string') return;
  const expected = publicUrl(value.id);
  // Current first-party Workshop forms prepend the origin to a relative
  // response path, while the public API guide shows an absolute URL. Accept
  // only those two exact same-origin representations and store one canonical
  // absolute URL; never resolve arbitrary relative or protocol-relative input.
  if (value.url !== expected && value.url !== `/workshop/${value.id}`) return;
  return { id: value.id, url: expected };
}

function concealed($: ReturnType<typeof load>, element: Parameters<ReturnType<typeof load>['contains']>[0]): boolean {
  const node = $(element);
  const classes = new Set((node.attr('class') ?? '').split(/\s+/).filter(Boolean));
  return node.is('[hidden],[inert],[aria-hidden="true"],dialog:not([open]),details:not([open]),script,style,template,noscript')
    || ['hidden', 'invisible', 'collapse', 'sr-only'].some(value => classes.has(value))
    || styleConcealsArticle(node.attr('style') ?? '');
}

const ROBOTS_VALUE_DIRECTIVES = new Set([
  'max-image-preview', 'max-snippet', 'max-video-preview', 'unavailable_after',
]);
function robotsDirectives(value: string): Set<string> {
  const result = new Set<string>();
  for (const raw of value.toLowerCase().split(',')) {
    let clause = raw.trim();
    if (!clause) continue;
    const valued = /^([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i.exec(clause);
    if (valued) {
      // Value-bearing directives may legitimately use `none` as their value,
      // for example max-image-preview:none. Other prefixes are user-agent
      // scopes in X-Robots-Tag (for example googlebot: noindex).
      if (ROBOTS_VALUE_DIRECTIVES.has(valued[1])) continue;
      clause = valued[2].trim();
    }
    for (const directive of clause.split(/\s+/)) {
      if (['noindex', 'nofollow', 'none'].includes(directive)) result.add(directive);
    }
  }
  return result;
}

function rendered(html: string, expected: Article, url: string, headers: Headers): string | undefined {
  try {
    const $ = load(html);
    applyDeclaredArticleVisibility($);
    const robots = [headers.get('x-robots-tag') ?? '',
      ...$('meta[name]').filter((_, node) => ['robots', 'googlebot', 'bingbot']
        .includes(($(node).attr('name') ?? '').toLowerCase()))
        .map((_, node) => $(node).attr('content') ?? '').get()].join(',');
    const directives = robotsDirectives(robots);
    if ((directives.has('noindex') || directives.has('none'))
      || $('meta[http-equiv]').filter((_, node) => ($(node).attr('http-equiv') ?? '').trim().toLowerCase() === 'refresh').length) return;
    const canonicals = $('link[rel]').filter((_, node) => ($(node).attr('rel') ?? '').toLowerCase().split(/\s+/).includes('canonical'));
    if (canonicals.length && (canonicals.length !== 1 || new URL(canonicals.attr('href') ?? '', url).toString() !== url)) return;
    const main = $('main#linkflow-article');
    const articleNode = main.children('article');
    const heading = articleNode.children('h1');
    const body = articleNode.children('div#linkflow-article-body');
    if (main.length !== 1 || articleNode.length !== 1 || heading.length !== 1 || body.length !== 1
      || articleNode.children().length !== 2 || main.children().length !== 1
      || heading.children().length || normalizedText(heading.text()) !== normalizedText(expected.title)
      || main.add(main.parents()).add(articleNode).add(heading).add(body).toArray().some(node => concealed($, node))) return;
    if (body.find('*').toArray().some(node => concealed($, node))) return;
    const actual = canonicalBody(body.html() ?? '', true);
    if (actual.html !== expected.bodyHtml || actual.links.length !== expected.links.length) return;
    for (let index = 0; index < actual.links.length; index++) {
      if (actual.links[index].href !== expected.links[index].href || actual.links[index].text !== expected.links[index].text) return;
    }
    const linked = actual.links.find(link => link.href === expected.target);
    if (!linked) return;
    const rel = new Set(linked.rel.split(/\s+/).filter(Boolean));
    if (directives.has('nofollow') || directives.has('none')) rel.add('nofollow');
    return [...rel].join(' ') || 'follow';
  } catch { return; }
}

function contentIdentity(html: string, expected: Article): 'match' | 'mismatch' | 'unknown' {
  try {
    const $ = load(html);
    const main = $('main#linkflow-article');
    const articleNode = main.children('article');
    const heading = articleNode.children('h1');
    const body = articleNode.children('div#linkflow-article-body');
    if (main.length !== 1 || articleNode.length !== 1 || heading.length !== 1 || body.length !== 1) return 'unknown';
    if (normalizedText(heading.text()) !== normalizedText(expected.title)) return 'mismatch';
    let actual: ReturnType<typeof canonicalBody>;
    try { actual = canonicalBody(body.html() ?? '', true); }
    catch { return 'unknown'; }
    if (actual.html !== expected.bodyHtml || actual.links.length !== expected.links.length) return 'mismatch';
    for (let index = 0; index < actual.links.length; index++) {
      if (actual.links[index].href !== expected.links[index].href
        || actual.links[index].text !== expected.links[index].text) return 'mismatch';
    }
    return 'match';
  } catch { return 'unknown'; }
}

async function found(saved: BetterThanHtmlReceipt, expected: Article, deps: BetterThanHtmlDependencies): Promise<{ url: string; rel: string }> {
  if (!saved.id) throw new BetterThanHtmlError('invalid');
  const url = publicUrl(saved.id);
  const page = await request(url, 'GET', deps);
  if (page.response.status !== 200 || mediaType(page.response) !== 'text/html') {
    throw new BetterThanHtmlError('invalid');
  }
  const rel = rendered(page.text, expected, url, page.response.headers);
  if (rel === undefined) throw new BetterThanHtmlError('mismatch');
  return { url, rel };
}

interface WorkshopListItem {
  id: string;
  title: string;
  description: string;
  author: string;
  category: string;
  createdAt: number;
  expiresAt: number;
  status: 'active' | 'promoted';
}

function workshopListItem(value: unknown, status: WorkshopListItem['status']): WorkshopListItem {
  if (!object(value) || typeof value.id !== 'string' || !ID.test(value.id)
    || typeof value.title !== 'string' || typeof value.description !== 'string'
    || typeof value.author !== 'string' || typeof value.category !== 'string'
    || typeof value.created_at !== 'number' || !Number.isSafeInteger(value.created_at)
    || typeof value.expires_at !== 'number' || !Number.isSafeInteger(value.expires_at)
    || value.status !== status) throw new BetterThanHtmlError('invalid');
  return { id: value.id, title: value.title, description: value.description,
    author: value.author, category: value.category, createdAt: value.created_at,
    expiresAt: value.expires_at, status };
}

function workshopListCandidates(value: unknown, expected: Article, submittedAt: string): string[] {
  const submitted = Date.parse(submittedAt);
  if (!Number.isFinite(submitted) || new Date(submitted).toISOString() !== submittedAt
    || !object(value) || value.ok !== true || !Array.isArray(value.active) || !Array.isArray(value.promoted)) {
    throw new BetterThanHtmlError('invalid');
  }
  if (Object.keys(value).sort().join(',') !== 'active,ok,promoted') throw new BetterThanHtmlError('invalid');
  const seen = new Map<string, string>();
  const candidates: string[] = [];
  const expectedDescription = expected.description ?? '';
  for (const [status, rows] of [['active', value.active], ['promoted', value.promoted]] as const) {
    for (const raw of rows) {
      const item = workshopListItem(raw, status);
      const fingerprint = JSON.stringify([item.title, item.description, item.author, item.category,
        item.createdAt, item.expiresAt, item.status]);
      const duplicate = seen.get(item.id);
      if (duplicate !== undefined) {
        if (duplicate !== fingerprint) throw new BetterThanHtmlError('invalid');
        continue;
      }
      seen.set(item.id, fingerprint);
      if (item.title === expected.title && item.description === expectedDescription
        && item.author === 'Anonymous' && item.category === 'leaflet'
        && item.createdAt >= submitted - RECOVERY_BEFORE_MS
        && item.createdAt <= submitted + RECOVERY_AFTER_MS) candidates.push(item.id);
    }
  }
  if (!candidates.length || candidates.length > MAX_RECOVERY_CANDIDATES) {
    throw new BetterThanHtmlError('invalid');
  }
  return candidates;
}

async function recoverFromList(expected: Article, submittedAt: string, deps: BetterThanHtmlDependencies): Promise<string> {
  const list = await request(LIST_URL, 'GET', deps);
  if (list.response.status !== 200 || mediaType(list.response) !== 'application/json') {
    throw new BetterThanHtmlError('invalid');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(list.text); }
  catch { throw new BetterThanHtmlError('invalid'); }
  const candidates = workshopListCandidates(parsed, expected, submittedAt);
  const matches: string[] = [];
  for (const id of candidates) {
    const url = publicUrl(id);
    const page = await request(url, 'GET', deps);
    if (page.response.status !== 200 || mediaType(page.response) !== 'text/html') {
      throw new BetterThanHtmlError('invalid');
    }
    const identity = contentIdentity(page.text, expected);
    if (identity === 'mismatch') continue;
    // Indexing, canonical, visibility, active-content, or parsing failures do
    // not disprove identity. An exact body that is not currently acceptable
    // therefore makes the whole recovery unknown instead of selecting a peer.
    if (identity !== 'match' || rendered(page.text, expected, url, page.response.headers) === undefined) {
      throw new BetterThanHtmlError('invalid');
    }
    matches.push(id);
  }
  if (matches.length !== 1) throw new BetterThanHtmlError('invalid');
  return matches[0];
}

export async function reconcileBetterThanHtmlTask(
  context: ExecutionContext,
  deps: BetterThanHtmlDependencies = {},
): Promise<BetterThanHtmlReconcileResult> {
  const saved = context.task.betterthanhtml;
  if (!contextMatches(context) || !receipt(saved)) return { status: 'unknown' };
  try {
    const expected = article(context.task, context.site.url, false);
    if (saved.contentHash !== expected.contentHash) return { status: 'unknown' };
    const requestDependencies = { ...deps, signal: context.signal };
    if (saved.id) {
      if (context.task.publicUrl !== undefined && context.task.publicUrl !== publicUrl(saved.id)) return { status: 'unknown' };
      await found(saved, expected, requestDependencies);
      return { status: 'found', publicUrl: publicUrl(saved.id),
        betterthanhtml: { ...saved, stage: 'published' } };
    }
    if (saved.stage !== 'submitting' || context.task.accountId || context.task.publicUrl !== undefined
      || context.task.checkpoint !== 'betterthanhtml_publish_submitting'
      || !context.task.submittedAt) return { status: 'unknown' };
    const submittedAt = context.task.submittedAt;
    const submitted = Date.parse(submittedAt);
    if (!Number.isFinite(submitted) || new Date(submitted).toISOString() !== submittedAt) return { status: 'unknown' };
    const id = await recoverFromList(expected, submittedAt, requestDependencies);
    if (context.signal.aborted) return { status: 'unknown' };
    const identified: BetterThanHtmlReceipt = { ...saved, id, stage: 'submitting' };
    const url = publicUrl(id);
    try {
      // Persist the positively matched remote identity before returning it.
      // The controller revalidates this no-ID -> ID transition against the
      // original hash and submittedAt, then alone may mark it published.
      context.checkpoint({ betterthanhtml: identified, checkpoint: 'betterthanhtml_publish_submitting',
        publicUrl: url, submittedAt });
    } catch { return { status: 'unknown' }; }
    return { status: 'found', publicUrl: url,
      betterthanhtml: { ...identified, stage: 'published' } };
  } catch { return { status: 'unknown' }; }
}

export async function verifyBetterThanHtml(
  task: Task,
  target: string,
  deps: BetterThanHtmlDependencies = {},
): Promise<LinkResult> {
  const failed = (outcome: LinkResult['outcome'], reason: string): LinkResult => ({
    found: false,
    outcome,
    reason,
    url: task.publicUrl ?? ORIGIN,
    rel: 'unknown',
  });
  try {
    const saved = task.betterthanhtml;
    if (task.channelId !== 'betterthanhtml' || task.sourceDomain !== 'betterthanhtml.com'
      || !receipt(saved) || saved.stage !== 'published' || !saved.id || task.publicUrl !== publicUrl(saved.id)) {
      return failed('invalid', 'Better Than HTML 缺少一致的已发布回执');
    }
    const expected = article(task, target, false);
    if (saved.contentHash !== expected.contentHash) {
      return failed('invalid', 'Better Than HTML 原文摘要与回执不符');
    }
    const result = await found(saved, expected, deps);
    return { found: true, outcome: 'found', url: result.url, rel: result.rel,
      reason: 'Better Than HTML 公开页的标题、完整正文及全部链接与已核对稿件一致；这不保证搜索收录或排名' };
  } catch (error) {
    return failed(error instanceof BetterThanHtmlError && error.code === 'absent' ? 'absent'
      : error instanceof BetterThanHtmlError && ['network', 'timeout', 'cancelled', 'challenge', 'rate'].includes(error.code)
        ? 'unreachable' : 'invalid', 'Better Than HTML 原公开全文暂未核验通过');
  }
}

export async function runBetterThanHtmlTask(
  context: ExecutionContext,
  deps: BetterThanHtmlDependencies = {},
): Promise<BetterThanHtmlExecutionResult> {
  if (!contextMatches(context)) return { status: 'needs_input', message: '当前渠道不支持 Better Than HTML 全文 API' };
  const prior = context.task.betterthanhtml;
  let expected: Article;
  try { expected = article(context.task, context.site.url, !prior); }
  catch (error) {
    return { status: 'needs_input', message: error instanceof Error ? error.message : 'Better Than HTML 原稿无效' };
  }
  if (prior) {
    const priorUrl = receipt(prior) && prior.id ? publicUrl(prior.id) : undefined;
    const checkpoint = receipt(prior) && prior.stage === 'published'
      ? 'betterthanhtml_published' : 'betterthanhtml_publish_submitting';
    if (priorUrl && context.task.publicUrl && context.task.publicUrl !== priorUrl) {
      return { status: 'needs_input', message: 'Better Than HTML 原回执与公开地址不一致，禁止重发',
        betterthanhtml: prior, checkpoint, submittedAt: context.task.submittedAt };
    }
    const result = await reconcileBetterThanHtmlTask(context, deps);
    if (result.status === 'found') {
      try {
        context.checkpoint({ betterthanhtml: result.betterthanhtml, checkpoint: 'betterthanhtml_published',
          publicUrl: result.publicUrl, submittedAt: context.task.submittedAt });
      } catch { /* A stored ID remains sufficient for later GET-only recovery. */ }
      return { status: 'review', message: 'Better Than HTML 原投稿已找到，未再次发送；搜索收录不保证',
        publicUrl: result.publicUrl, betterthanhtml: result.betterthanhtml,
        checkpoint: 'betterthanhtml_published', submittedAt: context.task.submittedAt };
    }
    return { status: 'review', message: 'Better Than HTML 原投稿结果不明，只读核验且不会重发',
      betterthanhtml: prior, checkpoint, submittedAt: context.task.submittedAt,
      ...(priorUrl ? { publicUrl: priorUrl } : {}) };
  }
  if (context.task.submittedAt || context.task.publicUrl
    || ['betterthanhtml_publish_submitting', 'betterthanhtml_published'].includes(context.task.checkpoint ?? '')) {
    return { status: 'needs_input', message: 'Better Than HTML 投稿痕迹缺少匹配回执，禁止重发' };
  }
  if (context.signal.aborted) return { status: 'queued', message: '任务已暂停，尚未投稿' };
  const pending: BetterThanHtmlReceipt = { contentHash: expected.contentHash, stage: 'submitting' };
  const submittedAt = stamp(deps);
  try {
    context.checkpoint({ betterthanhtml: pending, checkpoint: 'betterthanhtml_publish_submitting', submittedAt });
  } catch {
    return { status: 'queued', message: 'Better Than HTML 投稿意图未保存，未提交' };
  }
  let response: Json;
  try { response = await submit(expected, { ...deps, signal: context.signal }); }
  catch (error) {
    const stopped = error instanceof BetterThanHtmlError
      && ['challenge', 'rate', 'cancelled', 'timeout'].includes(error.code);
    return { status: 'review', message: stopped
      ? 'Better Than HTML 要求验证、限流或请求中断，已停止且不会重发'
      : 'Better Than HTML 投稿结果不明；平台无匿名幂等找回接口，不会重发',
      betterthanhtml: pending, checkpoint: 'betterthanhtml_publish_submitting', submittedAt };
  }
  const identity = responseIdentity(response);
  if (!identity) {
    return { status: 'review', message: 'Better Than HTML 返回结果无法安全确认，保留单次投稿意图且不会重发',
      betterthanhtml: pending, checkpoint: 'betterthanhtml_publish_submitting', submittedAt };
  }
  const identified: BetterThanHtmlReceipt = { ...pending, id: identity.id };
  let saved = false;
  try {
    context.checkpoint({ betterthanhtml: identified, checkpoint: 'betterthanhtml_publish_submitting',
      submittedAt, publicUrl: identity.url });
    saved = true;
  } catch { /* Return the validated ID and URL so the caller can persist them without another POST. */ }
  if (!saved) {
    return { status: 'review', message: 'Better Than HTML 已返回公开地址；待本机保存匹配回执后只读核验，不会重发',
      publicUrl: identity.url, betterthanhtml: identified,
      checkpoint: 'betterthanhtml_publish_submitting', submittedAt };
  }
  try {
    const result = await found(identified, expected, { ...deps, signal: context.signal });
    const published: BetterThanHtmlReceipt = { ...identified, stage: 'published' };
    try {
      context.checkpoint({ betterthanhtml: published, checkpoint: 'betterthanhtml_published',
        publicUrl: result.url, submittedAt });
    } catch { /* The identified receipt remains recoverable through GET only. */ }
    return { status: 'review', message: 'Better Than HTML 匿名公开全文已核验；平台未提供修改或删除契约，搜索收录不保证',
      publicUrl: result.url, betterthanhtml: published,
      checkpoint: 'betterthanhtml_published', submittedAt };
  } catch {
    return { status: 'review', message: 'Better Than HTML 已返回公开地址，完整全文仍待只读核验；不会重发',
      publicUrl: identity.url, betterthanhtml: identified,
      checkpoint: 'betterthanhtml_publish_submitting', submittedAt };
  }
}

export const betterThanHtmlTesting = { article, publicUrl, receipt, rendered, canonicalBody };
