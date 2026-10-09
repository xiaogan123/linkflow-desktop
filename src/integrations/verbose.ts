import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import { marked } from 'marked';
import { verbosePostSlug } from '../shared/publication';
import { applyDeclaredArticleVisibility, elementConcealed, publicPagePolicy, withPageNofollow } from './article-visibility';
import type { Account, ExecutionContext, ExecutionResult, LinkResult, Task, VerboseReceipt } from '../shared/types';

const ORIGIN = 'https://verbose.blog';
const USER = /^(?=.{3,32}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG = /^lf-[a-z0-9]{1,32}-[a-f0-9]{12}$/;
const TOKEN = /^vb_live_[a-zA-Z0-9]{20,128}$/;
type Json = Record<string, unknown>;
export type VerboseTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface VerboseDependencies { fetch?: VerboseTransport; signal?: AbortSignal; timeoutMs?: number; now?: () => Date }
export interface VerboseExecutionResult extends ExecutionResult { verbose?: VerboseReceipt }
export type VerboseReconcileResult = { status: 'found'; publicUrl: string; verbose: VerboseReceipt } | { status: 'unknown' };
class VerboseError extends Error {
  constructor(readonly code: 'network' | 'timeout' | 'cancelled' | 'auth' | 'challenge' | 'absent' | 'invalid' | 'rate' | 'conflict') {
    super(`Verbose request failed (${code})`); this.name = 'VerboseError';
  }
}
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const stamp = (deps: VerboseDependencies) => (deps.now?.() ?? new Date()).toISOString();
const home = (username: string) => `${ORIGIN}/${username}`;
function publicUrl(username: string, slug: string) {
  if (!USER.test(username) || !SLUG.test(slug)) throw new VerboseError('invalid');
  return `${home(username)}/${slug}`;
}
function targetUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new VerboseError('invalid');
  url.hash = ''; return url.toString();
}
function validReceipt(value: unknown): value is VerboseReceipt {
  return object(value) && typeof value.username === 'string' && USER.test(value.username)
    && typeof value.slug === 'string' && SLUG.test(value.slug)
    && typeof value.contentHash === 'string' && /^[a-f0-9]{64}$/.test(value.contentHash)
    && ['submitting', 'published'].includes(String(value.stage));
}
function article(task: Task, target: string, approval = true) {
  const draft = task.draft;
  if (!draft || approval && !Number.isFinite(Date.parse(task.articleApprovedAt ?? '')))
    throw Error('Verbose 全文须先通过当前稿件核对');
  if (!draft.title.trim() || draft.title !== draft.title.trim() || draft.title.length > 200
    || /[\u0000-\u001f\u007f]/.test(draft.title)) throw Error('Verbose 标题须为 1–200 个字符');
  const body = draft.body;
  if (body !== body.trim() || Buffer.byteLength(body, 'utf8') > 50_000
    || /[\u0000-\u0008\u000b-\u001f\u007f]|<[^>]*>/.test(body))
    throw Error('Verbose 需要不含 HTML 的完整 Markdown，正文最多 50 KB');
  const html = marked.parse(body, { async: false, gfm: true });
  const $ = load(html);
  const targetHref = targetUrl(task.topicUrl ?? target);
  if ($('p').length < 2 || $.root().text().replace(/\s/g, '').length < 200
    || !$('a[href]').toArray().some(el => {
      try { return !!$(el).text().trim() && targetUrl($(el).attr('href') ?? '') === targetHref; } catch { return false; }
    })) throw Error('Verbose 需要有独立信息价值的全文及相关目标链接');
  const contentHash = sha(JSON.stringify({ title: draft.title, body, target: targetHref }));
  const id = task.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
  if (!id) throw new VerboseError('invalid');
  return { title: draft.title, body, target: targetHref, contentHash, slug: verbosePostSlug(task.id, contentHash), html };
}
type Article = ReturnType<typeof article>;
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new VerboseError('cancelled'));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new VerboseError('cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}
async function request(path: string, deps: VerboseDependencies, payload?: Json, token?: string): Promise<{ response: Response; text: string }> {
  // Only this fixed provider ever receives the publishing credential. No redirects.
  if (!/^\/(?:v0\/profiles(?:\/[a-z0-9-]+(?:\/posts(?:\/[a-z0-9-]+)?)?)?|[a-z0-9-]+\/[a-z0-9-]+)$/.test(path))
    throw new VerboseError('invalid');
  if (deps.signal?.aborted) throw new VerboseError('cancelled');
  const controller = new AbortController();
  const abort = () => controller.abort();
  deps.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(60_000, Math.max(100, deps.timeoutMs ?? 15_000)));
  timer.unref?.();
  let response: Response | undefined;
  try {
    response = await bounded((deps.fetch ?? fetch)(`${ORIGIN}${path}`, {
      method: payload ? 'POST' : 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
      referrerPolicy: 'no-referrer', signal: controller.signal,
      headers: { accept: path.startsWith('/v0/') ? 'application/json' : 'text/html',
        'user-agent': 'Linkflow (original-article publisher)', ...(payload ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    }), controller.signal);
    if (response.redirected || response.url && response.url !== `${ORIGIN}${path}` || response.status >= 300 && response.status < 400)
      throw new VerboseError('invalid');
    const limit = path.startsWith('/v0/') ? 512_000 : 2_000_000;
    if (Number(response.headers.get('content-length')) > limit) throw new VerboseError('invalid');
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) {
      try {
        for (;;) {
          const next = await bounded(reader.read(), controller.signal); if (next.done) break;
          size += next.value.byteLength; if (size > limit) throw new VerboseError('invalid'); chunks.push(next.value);
        }
      } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
      finally { reader.releaseLock(); }
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    if (response.headers.get('cf-mitigated') === 'challenge' || /cf-chl-|g-recaptcha|h-captcha|cf-turnstile/.test(text)) throw new VerboseError('challenge');
    if (response.status === 401 || response.status === 403) throw new VerboseError('auth');
    if (response.status === 404) throw new VerboseError('absent');
    if (response.status === 409) throw new VerboseError('conflict');
    if (response.status === 429) throw new VerboseError('rate');
    if (response.status >= 500) throw new VerboseError('network');
    if (![200, 201].includes(response.status)) throw new VerboseError('invalid');
    return { response, text };
  } catch (error) {
    // Header rejection can happen before the reader owns the response body.
    controller.abort();
    void response?.body?.cancel().catch(() => undefined);
    if (deps.signal?.aborted) throw new VerboseError('cancelled');
    if (timedOut) throw new VerboseError('timeout');
    throw error instanceof VerboseError ? error : new VerboseError('network');
  } finally { clearTimeout(timer); deps.signal?.removeEventListener('abort', abort); }
}
async function json(path: string, deps: VerboseDependencies, payload?: Json, token?: string): Promise<Json> {
  const result = await request(path, deps, payload, token);
  if (!result.response.headers.get('content-type')?.includes('application/json')) throw new VerboseError('invalid');
  let data: unknown; try { data = JSON.parse(result.text); } catch { throw new VerboseError('invalid'); }
  if (!object(data)) throw new VerboseError('invalid'); return data;
}
function tokenFrom(value: string | undefined, username: string): string {
  try {
    const data: unknown = JSON.parse(value ?? 'null');
    if (!object(data) || data.version !== 1 || data.username !== username || typeof data.token !== 'string' || !TOKEN.test(data.token)) throw Error();
    return data.token;
  } catch { throw new VerboseError('auth'); }
}
function contextMatches(context: ExecutionContext) {
  return context.channel.id === 'verbose' && context.channel.domain === 'verbose.blog' && context.channel.automation === 'api'
    && context.channel.kind === 'article' && context.channel.articleRequired && context.channel.accountRequired
    && context.task.channelId === 'verbose' && context.task.sourceDomain === 'verbose.blog';
}
async function ready(context: ExecutionContext, deps: VerboseDependencies): Promise<ExecutionResult | { account: Account; token: string }> {
  let account = context.getAccount();
  if (!account) {
    if (context.task.accountId || context.task.verbose || context.task.submittedAt || context.task.publicUrl || context.signal.aborted)
      return { status: 'needs_input', message: 'Verbose 原身份或投稿状态待核对，不会另建账号' };
    const at = stamp(deps), username = `reading-notes-${randomBytes(6).toString('hex')}`;
    account = { id: randomUUID(), channelId: 'verbose', email: '', username, publicationUrl: home(username),
      credentialKind: 'api_token', status: 'draft', hasPassword: false, source: 'generated', registrationAttempts: 0, createdAt: at, updatedAt: at };
    try { await context.saveAccount(account); } catch { return { status: 'queued', message: 'Verbose 身份未保存，未提交注册' }; }
  }
  if (account.channelId !== 'verbose' || !!context.task.accountId && account.id !== context.task.accountId || !USER.test(account.username)
    || account.credentialKind !== 'api_token' || account.publicationUrl !== home(account.username)
    || ['restricted', 'credentials_invalid', 'needs_verification'].includes(account.status))
    return { status: 'needs_input', message: 'Verbose 原作者身份不可用，其他渠道可继续' };
  if (account.status === 'draft' && account.source === 'generated' && account.registrationAttempts === 0) {
    const pending: Account = { ...account, status: 'unknown', registrationAttempts: 1, updatedAt: stamp(deps),
      diagnostic: { code: 'registration_unknown', message: '注册意图已保存；一次性令牌返回不明时不会换号重试', at: stamp(deps), retryable: false } };
    try { await context.saveAccount(pending); context.checkpoint({ checkpoint: 'verbose_account_create_pending' }); }
    catch { return { status: 'queued', message: 'Verbose 注册意图未保存，未提交注册' }; }
    account = pending;
    try {
      const result = await json('/v0/profiles', deps, { username: account.username });
      if (result.username !== account.username || typeof result.token !== 'string' || !TOKEN.test(result.token)) throw new VerboseError('invalid');
      const token = result.token;
      // Persist the one-time token before claiming the account is ready.
      const withToken = { ...account, hasPassword: true };
      await context.saveAccount(withToken, JSON.stringify({ version: 1, username: account.username, token }));
      account = withToken;
    } catch (error) {
      if (error instanceof VerboseError && error.code === 'challenge') {
        try { await context.saveAccount({ ...account, status: 'needs_verification', diagnostic: {
          code: 'verification_required', message: '平台要求人工验证；保留原身份且不重试注册', at: stamp(deps), retryable: false } }); } catch { /* pending retained */ }
      }
      return { status: 'needs_input', checkpoint: 'verbose_account_create_pending', message: 'Verbose 一次性账号令牌未能确认，保留原身份；不会重建，其他平台继续' };
    }
  }
  let token: string;
  try { token = tokenFrom(await context.secrets.get(`account:${account.id}`), account.username); }
  catch { return { status: 'needs_input', checkpoint: 'verbose_account_create_pending', message: 'Verbose 缺少原始一次性令牌；无法找回时跳过本渠道，其他任务继续' }; }
  try {
    const data = await json(`/v0/profiles/${account.username}`, deps);
    if (data.username !== account.username) throw new VerboseError('invalid');
    const registered: Account = { ...account, status: 'registered', hasPassword: true, registeredAt: account.registeredAt ?? stamp(deps),
      verifiedAt: stamp(deps), updatedAt: stamp(deps), diagnostic: undefined };
    await context.saveAccount(registered);
    return { account: registered, token };
  } catch {
    return { status: 'queued', message: 'Verbose 账号读取暂未确认，保留原令牌后重试读取' };
  }
}
export async function prepareVerboseIdentity(context: ExecutionContext, deps: VerboseDependencies = {}): Promise<ExecutionResult | undefined> {
  if (!contextMatches(context)) return { status: 'needs_input', message: '当前任务不属于 Verbose 全文发布渠道' };
  const result = await ready(context, { ...deps, signal: context.signal });
  return 'status' in result ? result : undefined;
}
const normal = (value: string) => value.normalize('NFC').replace(/\s+/g, ' ').trim();
function rendered(html: string, expected: Article, username: string, headers=new Headers()): string | undefined {
  try {
    const $ = load(html); applyDeclaredArticleVisibility($);
    const policy=publicPagePolicy($,publicUrl(username,expected.slug),headers.get('x-robots-tag')??'');
    if(!policy.valid)return;
    const hidden = (el: Parameters<typeof $>[0]) => elementConcealed($,el);
    const meta = $('body > p.meta');
    const heading = meta.next('h1');
    if ($('body').length !== 1 || heading.length !== 1 || normal(heading.text()) !== normal(expected.title)
      || $('body').toArray().some(el => hidden(el)) || hidden(heading[0]) || $('body').parents().toArray().some(el => hidden(el))) return;
    if (meta.length !== 1 || meta.find('a').attr('href') !== `/${username}`
      || !/\d{4}-\d{2}-\d{2}/.test(meta.text()) || hidden(meta[0])) return;
    const content = $('body').clone();
    content.children('p.meta').next('h1').remove();
    content.children('p.meta,p.post-footer,script,style').remove();
    content.find('*').toArray().filter(el => hidden(el)).forEach(el => $(el).remove());
    const wanted = load(expected.html);
    if (normal(content.text()) !== normal(wanted.root().text())) return;
    // Match every visible link as well as all text; never accept a matching footer only.
    const links = (doc: ReturnType<typeof load>, root: ReturnType<ReturnType<typeof load>>) => root.find('a').toArray()
      .map(el => [doc(el).attr('href') ?? '', normal(doc(el).text())]);
    if (JSON.stringify(links($, content)) !== JSON.stringify(links(wanted, wanted.root()))) return;
    const link = content.find('a').filter((_, el) => { try { return targetUrl($(el).attr('href') ?? '') === expected.target; } catch { return false; } }).first();
    if (!link.length) return; return withPageNofollow(link.attr('rel')??'',policy.nofollow);
  } catch { return; }
}
async function found(saved: VerboseReceipt, expected: Article, deps: VerboseDependencies): Promise<{ url: string; rel: string }> {
  const url = publicUrl(saved.username, saved.slug);
  const data = await json(`/v0/profiles/${saved.username}/posts/${saved.slug}`, deps);
  if (data.username !== saved.username || data.slug !== saved.slug || data.url !== url || data.title !== expected.title
    || data.body_markdown !== expected.body || typeof data.created_at !== 'string' || !Number.isFinite(Date.parse(data.created_at))) throw new VerboseError('invalid');
  const { response, text } = await request(`/${saved.username}/${saved.slug}`, deps);
  if (!response.headers.get('content-type')?.includes('text/html')) throw new VerboseError('invalid');
  const rel = rendered(text, expected, saved.username,response.headers);
  if (rel === undefined) throw new VerboseError('invalid');
  return { url, rel };
}
export async function reconcileVerboseTask(context: ExecutionContext, deps: VerboseDependencies = {}): Promise<VerboseReconcileResult> {
  const saved = context.task.verbose, account = context.getAccount();
  if (!contextMatches(context) || !validReceipt(saved) || !account || account.id !== context.task.accountId
    || account.channelId !== 'verbose' || account.username !== saved.username) return { status: 'unknown' };
  try {
    const expected = article(context.task, context.site.url, false);
    if (saved.contentHash !== expected.contentHash || saved.slug !== expected.slug) return { status: 'unknown' };
    const result = await found(saved, expected, { ...deps, signal: context.signal });
    return { status: 'found', publicUrl: result.url, verbose: { ...saved, stage: 'published' } };
  } catch { return { status: 'unknown' }; }
}
export async function verifyVerbosePublication(task: Task, target: string, deps: VerboseDependencies = {}): Promise<LinkResult> {
  const failed = (outcome: LinkResult['outcome'], reason: string): LinkResult => ({ found: false, outcome, reason, url: task.publicUrl ?? ORIGIN, rel: 'unknown' });
  try {
    const saved = task.verbose;
    if (task.channelId !== 'verbose' || task.sourceDomain !== 'verbose.blog' || !validReceipt(saved) || saved.stage !== 'published'
      || task.publicUrl !== publicUrl(saved.username, saved.slug)) return failed('invalid', 'Verbose 缺少一致的已发布回执');
    const expected = article(task, target, false);
    if (saved.contentHash !== expected.contentHash || saved.slug !== expected.slug) return failed('invalid', 'Verbose 原文摘要与回执不符');
    const result = await found(saved, expected, deps);
    return { found: true, outcome: 'found', url: result.url, rel: result.rel, reason: 'Verbose 原文、匿名完整正文及所有链接一致；不代表搜索收录' };
  } catch (error) {
    return failed(error instanceof VerboseError && error.code === 'absent' ? 'absent'
      : error instanceof VerboseError && ['network', 'timeout', 'cancelled', 'challenge', 'rate'].includes(error.code) ? 'unreachable' : 'invalid', 'Verbose 原公开全文暂未核验通过');
  }
}
export async function runVerboseTask(context: ExecutionContext, deps: VerboseDependencies = {}): Promise<VerboseExecutionResult> {
  if (!contextMatches(context)) return { status: 'needs_input', message: '当前渠道不支持 Verbose 全文 API' };
  const prior = context.task.verbose;
  let expected: Article;
  try { expected = article(context.task, context.site.url, !prior); }
  catch (error) { return { status: 'needs_input', message: error instanceof Error ? error.message : 'Verbose 原稿无效' }; }
  if (prior) {
    const result = await reconcileVerboseTask(context, deps);
    if (result.status === 'found') {
      try { context.checkpoint({ verbose: result.verbose, checkpoint: 'verbose_published', publicUrl: result.publicUrl, submittedAt: context.task.submittedAt }); }
      catch { /* Persisted original intent still permits only read-only recovery. */ }
    }
    return result.status === 'found' ? { status: 'review', message: 'Verbose 原投稿已找到，未再次发送', publicUrl: result.publicUrl,
      verbose: result.verbose, checkpoint: 'verbose_published', submittedAt: context.task.submittedAt }
      : { status: 'review', message: 'Verbose 原投稿结果不明，只读核验且不会重发', checkpoint: 'verbose_publish_submitting' };
  }
  if (context.task.submittedAt || context.task.publicUrl || ['verbose_publish_submitting', 'verbose_published'].includes(context.task.checkpoint ?? ''))
    return { status: 'needs_input', message: 'Verbose 投稿痕迹缺少回执，禁止重发' };
  const original = context.getAccount();
  const access = await ready(context, { ...deps, signal: context.signal }); if ('status' in access) return access;
  if (original?.status !== 'registered' || original.id !== access.account.id)
    return { status: 'queued', message: 'Verbose 作者身份已就绪，请先以此身份独立核对稿件' };
  if (context.signal.aborted) return { status: 'queued', message: '任务已暂停，尚未投稿' };
  const saved: VerboseReceipt = { username: access.account.username, slug: expected.slug, contentHash: expected.contentHash, stage: 'submitting' };
  const submittedAt = stamp(deps);
  try { context.checkpoint({ verbose: saved, checkpoint: 'verbose_publish_submitting', submittedAt }); }
  catch { return { status: 'queued', message: 'Verbose 投稿意图未保存，未提交' }; }
  try {
    const result = await json(`/v0/profiles/${saved.username}/posts`, { ...deps, signal: context.signal },
      { title: expected.title, body: expected.body, slug: saved.slug }, access.token);
    if (result.username !== saved.username || result.slug !== saved.slug || result.title !== expected.title
      || result.url !== publicUrl(saved.username, saved.slug)) throw new VerboseError('invalid');
  } catch { /* Includes conflict: only read the same slug, never choose another. */ }
  try {
    const result = await found(saved, expected, { ...deps, signal: context.signal });
    const receipt: VerboseReceipt = { ...saved, stage: 'published' };
    try { context.checkpoint({ verbose: receipt, checkpoint: 'verbose_published', publicUrl: result.url, submittedAt }); }
    catch { /* Pending original receipt is durable; a later read may finish it. */ }
    return { status: 'review', message: 'Verbose 全文与匿名链接已核验', publicUrl: result.url, verbose: receipt, checkpoint: 'verbose_published', submittedAt };
  } catch {
    return { status: 'review', message: 'Verbose 投稿结果仍待只读核验，不会重发', verbose: saved, checkpoint: 'verbose_publish_submitting', submittedAt };
  }
}
export const verboseTesting = { article, rendered, validReceipt, publicUrl };
