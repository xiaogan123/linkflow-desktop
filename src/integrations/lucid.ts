import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { marked } from 'marked';
import { applyDeclaredArticleVisibility, styleConcealsArticle,publicPagePolicy } from './article-visibility';
import { normalizePublicUrl } from './web';
import type { ExecutionContext, ExecutionResult, LinkResult, LucidReceipt, Task } from '../shared/types';

const ORIGIN = 'https://lucid.page';
const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_MARKDOWN = 1_000_000;
const MAX_JSON = 128_000;
const MAX_RAW = 1_100_000;
const MAX_HTML = 3_000_000;
type Json = Record<string, unknown>;

export type LucidTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface LucidDependencies { fetch?: LucidTransport; signal?: AbortSignal; timeoutMs?: number; now?: () => Date }
export interface LucidExecutionResult extends ExecutionResult { lucid?: LucidReceipt }
export type LucidReconcileResult = { status: 'found'; publicUrl: string; lucid: LucidReceipt } | { status: 'unknown' };

class LucidError extends Error {
  constructor(readonly code: 'network' | 'timeout' | 'cancelled' | 'challenge' | 'rate' | 'absent' | 'invalid') {
    super(`Lucid request failed (${code})`); this.name = 'LucidError';
  }
}

const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const stamp = (deps: LucidDependencies) => (deps.now?.() ?? new Date()).toISOString();
function pageUrl(slug: string): string {
  if (!SLUG.test(slug)) throw new LucidError('invalid');
  return `${ORIGIN}/${slug}`;
}
function targetUrl(value: string): string {
  try {
    if (!/^https:\/\//i.test(value.trim())) throw Error('invalid');
    const url = normalizePublicUrl(value);
    if (url.protocol !== 'https:') throw Error('invalid');
    return url.toString();
  } catch { throw new LucidError('invalid'); }
}
function receipt(value: unknown): value is LucidReceipt {
  return object(value) && typeof value.contentHash === 'string' && HASH.test(value.contentHash)
    && (value.stage === 'submitting' || value.stage === 'published')
    && (value.slug === undefined || typeof value.slug === 'string' && SLUG.test(value.slug))
    && (value.stage !== 'published' || typeof value.slug === 'string');
}
function article(task: Task, target: string, requireApproval = true) {
  const draft = task.draft;
  if (!draft || requireApproval && !Number.isFinite(Date.parse(task.articleApprovedAt ?? '')))
    throw Error('Lucid 全文须先通过当前稿件核对');
  if (typeof draft.title !== 'string' || !draft.title.trim() || draft.title !== draft.title.trim()
    || draft.title.length > 200 || /[\u0000-\u001f\u007f<>\[\]`]/.test(draft.title))
    throw Error('Lucid 标题须为 1–200 个字符的单行文字');
  if (typeof draft.body !== 'string' || draft.body !== draft.body.trim()
    || /[\u0000-\u0008\u000b-\u001f\u007f]|<[^>]*>/.test(draft.body)
    || Buffer.byteLength(draft.body, 'utf8') > MAX_MARKDOWN)
    throw Error('Lucid 需要不含 HTML、未截断且不超过 1 MB 的 Markdown 全文');
  const parsed = load(String(marked.parse(draft.body, { async: false, gfm: true })));
  if (parsed('h1').length) throw Error('Lucid 正文不应重复一级标题');
  // Lucid renders Markdown, not the optional JSON title, as the visible title.
  const markdown = `# ${draft.title}\n\n${draft.body}`;
  const document = load(String(marked.parse(markdown, { async: false, gfm: true })));
  if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN || document('h1').length !== 1
    || document('h1').text() !== draft.title) throw Error('Lucid 标题不能被 Markdown 改写，且完整文档须不超过 1 MB');
  const targetHref = targetUrl(task.topicUrl ?? target);
  const links = parsed('a[href]').toArray().map(element => ({
    label: parsed(element).text().trim(), href: targetUrl(parsed(element).attr('href') ?? ''),
  }));
  const paragraphs = draft.body.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
  if (paragraphs.length < 2 || parsed.root().text().replace(/\s/g, '').length < 200
    || parsed('img').length || links.some(link => !link.label) || !links.some(link => link.href === targetHref))
    throw Error('Lucid 需要无图片、有独立信息价值的全文及公开 HTTPS 相关链接');
  return { title: draft.title, body: draft.body, markdown, target: targetHref,
    contentHash: sha(JSON.stringify({ title: draft.title, body: draft.body, target: targetHref })) };
}
type Article = ReturnType<typeof article>;

function contextMatches(context: ExecutionContext): boolean {
  return context.channel.id === 'lucid-page' && context.channel.domain === 'lucid.page'
    && context.channel.kind === 'article' && context.channel.automation === 'api'
    && context.channel.articleRequired && !context.channel.accountRequired
    && context.task.channelId === 'lucid-page' && context.task.sourceDomain === 'lucid.page';
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // A transport may synchronously abort while returning a rejected promise.
    void promise.catch(() => undefined);
    return Promise.reject(new LucidError('cancelled'));
  }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new LucidError('cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}
async function request(path: string, method: 'GET' | 'POST', deps: LucidDependencies, payload?: Json): Promise<{ response: Response; text: string }> {
  const publish = path === '/publish' && method === 'POST' && !!payload;
  const read = method === 'GET' && !payload && (/^\/[a-z0-9][a-z0-9-]{0,80}$/.test(path)
    || /^\/raw\/[a-z0-9][a-z0-9-]{0,80}$/.test(path));
  if (!publish && !read) throw new LucidError('invalid');
  if (deps.signal?.aborted) throw new LucidError('cancelled');
  const controller = new AbortController();
  const abort = () => controller.abort();
  deps.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(60_000, Math.max(100, deps.timeoutMs ?? 15_000)));
  timer.unref?.();
  try {
    const url = `${ORIGIN}${path}`;
    const accept = publish ? 'application/json' : path.startsWith('/raw/') ? 'text/markdown' : 'text/html';
    const response = await abortable((deps.fetch ?? fetch)(url, {
      method, redirect: 'manual', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
      headers: { accept, 'user-agent': 'Linkflow (reviewed original-article publisher)',
        ...(publish ? { 'content-type': 'application/json' } : {}) },
      ...(publish ? { body: JSON.stringify(payload) } : {}),
    }), controller.signal);
    if (response.redirected || response.url && response.url !== url || response.status >= 300 && response.status < 400)
      throw new LucidError('invalid');
    const maximum = publish ? MAX_JSON : path.startsWith('/raw/') ? MAX_RAW : MAX_HTML;
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximum) throw new LucidError('invalid');
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const next = await abortable(reader.read(), controller.signal);
          if (next.done) break;
          size += next.value.byteLength;
          if (size > maximum) throw new LucidError('invalid');
          chunks.push(next.value);
        }
      } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
      finally { reader.releaseLock(); }
    }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(value => Buffer.from(value)))); }
    catch { throw new LucidError('invalid'); }
    if (response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge'
      || /cf-chl-|g-recaptcha|h-captcha|cf-turnstile|verify (?:that )?you are human|just a moment/i.test(text))
      throw new LucidError('challenge');
    if (response.status === 404 || response.status === 410 || response.status === 451) throw new LucidError('absent');
    if (response.status === 429) throw new LucidError('rate');
    if (response.status === 401 || response.status === 403) throw new LucidError('challenge');
    if (response.status === 408 || response.status >= 500) throw new LucidError('network');
    if (response.status < 200 || response.status >= 300) throw new LucidError('invalid');
    return { response, text };
  } catch (error) {
    if (deps.signal?.aborted) throw new LucidError('cancelled');
    if (timedOut) throw new LucidError('timeout');
    throw error instanceof LucidError ? error : new LucidError('network');
  } finally { clearTimeout(timer); deps.signal?.removeEventListener('abort', abort); }
}
async function publish(expected: Article, deps: LucidDependencies): Promise<Json> {
  const { response, text } = await request('/publish', 'POST', deps,
    { markdown: expected.markdown, title: expected.title, visibility: 'public' });
  if (response.status !== 201 || !response.headers.get('content-type')?.includes('application/json'))
    throw new LucidError('invalid');
  try {
    const parsed: unknown = JSON.parse(text);
    if (!object(parsed)) throw Error('invalid');
    return parsed;
  } catch { throw new LucidError('invalid'); }
}
function responseIdentity(value: Json): { slug: string; url: string } | undefined {
  if (typeof value.slug !== 'string' || !SLUG.test(value.slug) || typeof value.url !== 'string'
    || value.url !== pageUrl(value.slug) || value.visibility !== 'public' || value.expires_at !== null) return;
  return { slug: value.slug, url: value.url };
}
function claimToken(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('lpc_') || value.length <= 4
    || Buffer.byteLength(value, 'utf8') > 8192 || /[\s\u0000-\u001f\u007f]/.test(value)) return;
  return value;
}

const normal = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
function concealed($: ReturnType<typeof load>, element: Parameters<ReturnType<typeof load>['contains']>[0]): boolean {
  const node = $(element);
  const classes = (node.attr('class') ?? '').split(/\s+/);
  return node.is('[hidden],[inert],[aria-hidden="true"],dialog:not([open]),details:not([open]),script,style,template,noscript')
    || classes.some(value => ['hidden', 'invisible', 'collapse', 'sr-only'].includes(value))
    || styleConcealsArticle(node.attr('style') ?? '');
}
interface Block { tag: string; text: string; links: Array<{ href: string; text: string }>; code: string[] }
function blocks($: ReturnType<typeof load>, root: ReturnType<ReturnType<typeof load>>, base: string): Block[] | undefined {
  if (root.contents().toArray().some(node => node.type === 'text' && normal($(node).text()))) return;
  const result: Block[] = [];
  for (const node of root.children().toArray()) {
    const element = $(node);
    const tag = node.type === 'tag' ? node.tagName.toLowerCase() : '';
    if (!/^(?:h[2-6]|p|ul|ol|blockquote|pre|table|hr)$/.test(tag)) {
      if (normal(element.text()) || element.find('a[href]').length) return;
      continue;
    }
    const links: Block['links'] = [];
    for (const link of element.find('a[href]').addBack('a[href]').toArray()) {
      const href = $(link).attr('href') ?? '';
      try { links.push({ href: new URL(href, base).toString(), text: normal($(link).text()) }); }
      catch { return; }
    }
    const code = element.find('code').toArray().map(node => $(node).text().normalize('NFC').replace(/\r\n?/g, '\n'));
    result.push({ tag, text: normal(element.text()), links, code });
  }
  return result;
}
function removePlatformChrome($: ReturnType<typeof load>, root: ReturnType<ReturnType<typeof load>>): boolean {
  const end = root.find('.document-end'), cta = root.find('.doc-cta');
  if (end.length || cta.length) {
    const children = root.children().toArray();
    const markup = '<span class="doc-cta-kicker">Made with lucid.page</span>'
      + '<span class="doc-cta-heading">Write something this beautiful</span>'
      + '<span class="doc-cta-sub">Publish your own page in seconds. Free, no signup.</span>'
      + '<a class="doc-cta-button" href="/?ref=doc-cta">New page<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg></a>';
    if (end.length !== 1 || cta.length !== 1 || children.at(-2) !== end[0] || children.at(-1) !== cta[0]
      || !end.is('div') || end.attr('class') !== 'document-end' || Object.keys(end.attr() ?? {}).length !== 1
      || end.children().length || end.text().trim() !== 'End'
      || !cta.is('aside') || cta.attr('class') !== 'doc-cta' || cta.attr('aria-label') !== 'Publish your own page'
      || Object.keys(cta.attr() ?? {}).length !== 2 || (cta.html() ?? '').trim().replace(/>\s+</g, '><') !== markup) return false;
    end.remove(); cta.remove();
  }
  for (const node of root.find('.header-anchor').toArray()) {
    const anchor = $(node), parent = anchor.parent();
    if (!anchor.is('a') || !parent.is('h1,h2,h3,h4,h5,h6') || anchor.children().length
      || anchor.text() !== '#' || anchor.attr('href') !== `#${parent.attr('id') ?? ''}`) return false;
    anchor.remove();
  }
  return true;
}
function expectedSiteAutolinks($: ReturnType<typeof load>, root: ReturnType<ReturnType<typeof load>>, target: string): void {
  // Observed Lucid linkify turns a bare site hostname into http://hostname.
  // Derive this only from reviewed plain text; explicit Markdown links stay exact.
  const host = new URL(target).hostname;
  const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^A-Za-z0-9_./:@-])(${escapedHost})(?=$|[^A-Za-z0-9_.:/?#@%-])`, 'g');
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  for (const node of root.find('*').addBack().contents().toArray()) {
    if (node.type !== 'text' || $(node).parent().closest('a,code,pre').length) continue;
    const text = $(node).text();
    let html = '', cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index! + match[1].length;
      html += escape(text.slice(cursor, start)) + `<a href="http://${escape(host)}">${escape(host)}</a>`;
      cursor = start + host.length;
    }
    if (cursor) $(node).replaceWith(html + escape(text.slice(cursor)));
  }
}
function rendered(html: string, expected: Article, url: string, headers: Headers): string | undefined {
  try {
    const $ = load(html);
    applyDeclaredArticleVisibility($);
    const canonical = $('link[rel]').filter((_, node) => ($(node).attr('rel') ?? '').toLowerCase().split(/\s+/).includes('canonical'));
    if (canonical.length !== 1 || new URL(canonical.attr('href') ?? '', url).toString() !== url
      || $('meta[http-equiv]').filter((_, node) => ($(node).attr('http-equiv') ?? '').toLowerCase() === 'refresh').length) return;
    const policy=publicPagePolicy($,url,headers.get('x-robots-tag')??'');
    if(!policy.valid)return;
    const articleNode = $('article.document#doc-content-area');
    if (articleNode.length !== 1 || $('article.document').length !== 1 || articleNode.closest('main.reader#top').length !== 1
      || articleNode.add(articleNode.parents()).toArray().some(node => concealed($, node))) return;
    if (!removePlatformChrome($, articleNode)) return;
    if (articleNode.find('script,style,template,noscript,iframe,object,embed,form,input,img,svg,canvas,video,audio,link').length) return;
    const heading = articleNode.find('h1');
    if (heading.length !== 1 || normal(heading.text()) !== normal(expected.title)
      || heading.add(heading.parentsUntil(articleNode)).toArray().some(node => concealed($, node))) return;
    const actualHtml = articleNode.html();
    if (actualHtml === null) return;
    const actual = load(`<body>${actualHtml}</body>`);
    applyDeclaredArticleVisibility(actual);
    const root = actual('body');
    root.find('details.mobile-toc,button,[data-copy-code]').remove();
    const actualHeading = root.find('h1');
    if (actualHeading.length !== 1 || normal(actualHeading.text()) !== normal(expected.title)) return;
    actualHeading.remove();
    if (root.find('*').toArray().some(node => concealed(actual, node))) return;
    const expectedHtml = String(marked.parse(expected.body, { async: false, gfm: true }));
    const wanted = load(`<body>${expectedHtml}</body>`);
    expectedSiteAutolinks(wanted, wanted('body'), expected.target);
    const actualBlocks = blocks(actual, root, url);
    const expectedBlocks = blocks(wanted, wanted('body'), url);
    if (!actualBlocks || !expectedBlocks || expectedBlocks.length < 2
      || JSON.stringify(actualBlocks) !== JSON.stringify(expectedBlocks)) return;
    const target = root.find('a[href]').filter((_, node) => {
      const item = actual(node);
      if (!normal(item.text()) || item.add(item.parentsUntil(root)).toArray().some(element => concealed(actual, element))) return false;
      try { return targetUrl(new URL(item.attr('href') ?? '', url).toString()) === expected.target; }
      catch { return false; }
    }).first();
    if (!target.length) return;
    const rel = new Set((target.attr('rel') ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean));
    if (policy.nofollow) rel.add('nofollow');
    return [...rel].join(' ') || 'follow';
  } catch { return; }
}
async function found(saved: LucidReceipt, expected: Article, deps: LucidDependencies): Promise<{ url: string; rel: string }> {
  if (!saved.slug) throw new LucidError('invalid');
  const url = pageUrl(saved.slug);
  const raw = await request(`/raw/${saved.slug}`, 'GET', deps);
  if (raw.response.status !== 200 || !raw.response.headers.get('content-type')?.includes('text/markdown')
    || raw.text !== expected.markdown) throw new LucidError('invalid');
  const page = await request(`/${saved.slug}`, 'GET', deps);
  if (page.response.status !== 200 || !page.response.headers.get('content-type')?.includes('text/html'))
    throw new LucidError('invalid');
  const rel = rendered(page.text, expected, url, page.response.headers);
  if (rel === undefined) throw new LucidError('invalid');
  return { url, rel };
}

export async function reconcileLucidTask(context: ExecutionContext, deps: LucidDependencies = {}): Promise<LucidReconcileResult> {
  const saved = context.task.lucid;
  if (!contextMatches(context) || !receipt(saved) || !saved.slug
    || context.task.publicUrl && context.task.publicUrl !== pageUrl(saved.slug)) return { status: 'unknown' };
  try {
    const expected = article(context.task, context.site.url, false);
    if (saved.contentHash !== expected.contentHash) return { status: 'unknown' };
    await found(saved, expected, { ...deps, signal: context.signal });
    return { status: 'found', publicUrl: pageUrl(saved.slug), lucid: { ...saved, stage: 'published' } };
  } catch { return { status: 'unknown' }; }
}

export async function verifyLucidPublication(task: Task, target: string, deps: LucidDependencies = {}): Promise<LinkResult> {
  const failed = (outcome: LinkResult['outcome'], reason: string): LinkResult => ({
    found: false, outcome, reason, url: task.publicUrl ?? ORIGIN, rel: 'unknown',
  });
  try {
    const saved = task.lucid;
    if (task.channelId !== 'lucid-page' || task.sourceDomain !== 'lucid.page' || !receipt(saved)
      || saved.stage !== 'published' || !saved.slug || task.publicUrl !== pageUrl(saved.slug))
      return failed('invalid', 'Lucid 缺少一致的已发布回执');
    const expected = article(task, target, false);
    if (saved.contentHash !== expected.contentHash) return failed('invalid', 'Lucid 原文摘要与回执不符');
    const result = await found(saved, expected, deps);
    return { found: true, outcome: 'found', url: result.url, rel: result.rel,
      reason: 'Lucid 公开页的标题、完整 Markdown、可见正文及目标链接一致；这不保证搜索收录或排名' };
  } catch (error) {
    return failed(error instanceof LucidError && error.code === 'absent' ? 'absent'
      : error instanceof LucidError && ['network', 'timeout', 'cancelled', 'challenge', 'rate'].includes(error.code)
        ? 'unreachable' : 'invalid', 'Lucid 原公开全文暂未核验通过');
  }
}

export async function runLucidTask(context: ExecutionContext, deps: LucidDependencies = {}): Promise<LucidExecutionResult> {
  if (!contextMatches(context)) return { status: 'needs_input', message: '当前渠道不支持 Lucid 全文 API' };
  const prior = context.task.lucid;
  let expected: Article;
  try { expected = article(context.task, context.site.url, !prior); }
  catch (error) { return { status: 'needs_input', message: error instanceof Error ? error.message : 'Lucid 原稿无效' }; }
  if (prior) {
    const priorUrl = receipt(prior) && prior.slug ? pageUrl(prior.slug) : undefined;
    const priorCheckpoint = receipt(prior) && prior.stage === 'published' ? 'lucid_published' : 'lucid_publish_submitting';
    if (priorUrl && context.task.publicUrl && context.task.publicUrl !== priorUrl)
      return { status: 'needs_input', message: 'Lucid 原回执与公开地址不一致，禁止重发', lucid: prior,
        checkpoint: priorCheckpoint, submittedAt: context.task.submittedAt };
    const result = await reconcileLucidTask(context, deps);
    if (result.status === 'found') {
      try { context.checkpoint({ lucid: result.lucid, checkpoint: 'lucid_published', publicUrl: result.publicUrl,
        submittedAt: context.task.submittedAt }); } catch { /* The slug remains sufficient for read-only recovery. */ }
    }
    return result.status === 'found'
      ? { status: 'review', message: 'Lucid 原投稿已找到，未再次发送；搜索收录不保证', publicUrl: result.publicUrl,
        lucid: result.lucid, checkpoint: 'lucid_published', submittedAt: context.task.submittedAt }
      : { status: 'review', message: 'Lucid 原投稿结果不明，只读核验且不会重发', lucid: prior,
        checkpoint: priorCheckpoint, submittedAt: context.task.submittedAt,
        ...(priorUrl ? { publicUrl: priorUrl } : {}) };
  }
  if (context.task.submittedAt || context.task.publicUrl
    || ['lucid_publish_submitting', 'lucid_published'].includes(context.task.checkpoint ?? ''))
    return { status: 'needs_input', message: 'Lucid 投稿痕迹缺少匹配回执，禁止重发' };
  if (context.signal.aborted) return { status: 'queued', message: '任务已暂停，尚未投稿' };
  const pending: LucidReceipt = { contentHash: expected.contentHash, stage: 'submitting' };
  const submittedAt = stamp(deps);
  try { context.checkpoint({ lucid: pending, checkpoint: 'lucid_publish_submitting', submittedAt }); }
  catch { return { status: 'queued', message: 'Lucid 投稿意图未保存，未提交' }; }
  let data: Json;
  try { data = await publish(expected, { ...deps, signal: context.signal }); }
  catch (error) {
    const stopped = error instanceof LucidError && ['challenge', 'rate', 'cancelled', 'timeout'].includes(error.code);
    return { status: 'review', message: stopped
      ? 'Lucid 要求验证、限流或请求中断，已停止且不会重发'
      : 'Lucid 投稿结果不明；平台无匿名幂等找回接口，不会重发',
      lucid: pending, checkpoint: 'lucid_publish_submitting', submittedAt };
  }
  const identity = responseIdentity(data);
  if (!identity) return { status: 'review', message: 'Lucid 返回结果无法安全确认，保留单次投稿意图且不会重发',
    lucid: pending, checkpoint: 'lucid_publish_submitting', submittedAt };
  const identified: LucidReceipt = { ...pending, slug: identity.slug };
  let identitySaved = false;
  try {
    context.checkpoint({ lucid: identified, checkpoint: 'lucid_publish_submitting', submittedAt, publicUrl: identity.url });
    identitySaved = true;
  } catch { /* Return the matched receipt and URL so the caller can persist them without another POST. */ }
  const token = claimToken(data.claim_token);
  let tokenSaved = false;
  if (token) {
    try { await context.secrets.set(`publication:${context.task.id}`, token); tokenSaved = true; }
    catch { /* The already published URL must remain recoverable even when Vault is unavailable. */ }
  }
  if (!identitySaved) return { status: 'review', message: 'Lucid 已返回公开地址；待本机保存匹配回执后只读核验，不会重发',
    publicUrl: identity.url, lucid: identified, checkpoint: 'lucid_publish_submitting', submittedAt };
  try {
    const result = await found(identified, expected, { ...deps, signal: context.signal });
    const publishedReceipt: LucidReceipt = { ...identified, stage: 'published' };
    try { context.checkpoint({ lucid: publishedReceipt, checkpoint: 'lucid_published', publicUrl: result.url, submittedAt }); }
    catch { /* The matched slug is already durable and can be reconciled read-only. */ }
    return { status: 'review', message: tokenSaved
      ? 'Lucid 匿名公开全文已核验；人工认领前软件无法修改或删除，搜索收录不保证'
      : 'Lucid 匿名公开全文已核验；一次性认领凭据未保存，软件无法修改或删除，搜索收录不保证',
      publicUrl: result.url, lucid: publishedReceipt, checkpoint: 'lucid_published', submittedAt };
  } catch {
    return { status: 'review', message: tokenSaved
      ? 'Lucid 已返回公开地址，完整全文仍待只读核验；不会重发'
      : 'Lucid 已返回公开地址，但一次性认领凭据未保存；地址已保留且不会重发',
      publicUrl: identity.url, lucid: identified, checkpoint: 'lucid_publish_submitting', submittedAt };
  }
}

export const lucidTesting = { article, pageUrl, receipt, rendered };
