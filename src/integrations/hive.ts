import { createHash } from 'node:crypto';
import { PrivateKey, Transaction, type TransactionType } from 'hive-tx';
import { load } from 'cheerio';
import { marked } from 'marked';
import { inspectRenderedArticle } from './article-rendering';
import type { Account, ExecutionContext, ExecutionResult, HiveReceipt, LinkResult, SecretStore, Task } from '../shared/types';

const RPC_NODES = ['https://api.hive.blog', 'https://api.openhive.network'] as const;
const PUBLIC_ORIGIN = 'https://hive.blog';
const ROOT_TAG = 'general';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RPC_BYTES = 1024 * 1024;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_ARTICLE_BYTES = 64 * 1024;
const MAX_TRANSACTION_BYTES = 65_536;
const ROOT_POST_INTERVAL_MS = 5 * 60 * 1000;
const RC_REGEN_SECONDS = 432_000;

type Json = Record<string, unknown>;
type RpcMethod = 'condenser_api.get_accounts' | 'condenser_api.get_content'
  | 'condenser_api.get_dynamic_global_properties' | 'rc_api.find_rc_accounts' | 'rc_api.get_rc_operation_stats';

export interface HiveComment {
  parent_author: '';
  parent_permlink: typeof ROOT_TAG;
  author: string;
  permlink: string;
  title: string;
  body: string;
  json_metadata: string;
}

export interface HiveDependencies {
  rpc?: (method: RpcMethod, params: unknown, signal?: AbortSignal, node?: string) => Promise<unknown>;
  broadcastComment?: (comment: HiveComment, postingKey: string) => Promise<{ id?: string }>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => Date | string;
  timeoutMs?: number;
}

export type HiveReconcileResult = { status: 'found'; publicUrl: string; hive: HiveReceipt } | { status: 'unknown' };

interface StoredCredential { version: 1; username: string; postingKey: string }
interface Article { comment: HiveComment; target: string; contentHash: string }
interface SignedComment { transaction: TransactionType; id: string }
interface ChainHead { number: number; id: string; time: number }

export class HiveError extends Error {
  constructor(readonly code: 'invalid_key' | 'account' | 'authority' | 'network' | 'invalid_response') {
    super(`Hive ${code}`);
    this.name = 'HiveError';
  }
}

function object(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stamp(deps?: HiveDependencies): string {
  const raw = deps?.now?.();
  const date = raw instanceof Date ? raw : typeof raw === 'string' ? new Date(raw) : new Date();
  if (!Number.isFinite(date.getTime())) throw new HiveError('invalid_response');
  return date.toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function username(input: string): string {
  const value = input.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z][a-z0-9.-]{2,15}$/.test(value) || /[.-]$|[.-]{2}/.test(value)) throw new HiveError('account');
  return value;
}

function isNormalizedUsername(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return username(value) === value; } catch { return false; }
}

function validPermlink(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function publicUrl(author: string, permlink: string): string {
  if (username(author) !== author || !validPermlink(permlink)) throw new HiveError('invalid_response');
  return `${PUBLIC_ORIGIN}/${ROOT_TAG}/@${author}/${permlink}`;
}

function canonicalHttps(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || (url.port && url.port !== '443')) throw new Error();
    url.hash = '';
    return url.toString();
  } catch { throw new Error('文章目标必须是不含凭据的 HTTPS 网址'); }
}

function privateKey(value: unknown): PrivateKey {
  // fromString accepts WIF only. Never derive a posting key from a master password.
  if (typeof value !== 'string' || value.trim() !== value || !/^[5KL][1-9A-HJ-NP-Za-km-z]{50,52}$/.test(value)) {
    throw new HiveError('invalid_key');
  }
  try { return PrivateKey.fromString(value); }
  catch { throw new HiveError('invalid_key'); }
}

function authorityKeys(value: unknown): { threshold: number; keys: Array<[string, number]> } | undefined {
  if (!object(value) || !Number.isSafeInteger(value.weight_threshold) || (value.weight_threshold as number) < 1
    || !Array.isArray(value.key_auths)) return undefined;
  const keys: Array<[string, number]> = [];
  for (const item of value.key_auths) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string'
      || !Number.isSafeInteger(item[1]) || item[1] < 1) return undefined;
    keys.push([item[0], item[1]]);
  }
  return { threshold: value.weight_threshold as number, keys };
}

function verifyPostingAuthority(raw: unknown, accountName: string, wif: string): Json {
  if (!Array.isArray(raw) || raw.length !== 1 || !object(raw[0]) || raw[0].name !== accountName) throw new HiveError('account');
  const account = raw[0];
  const key = privateKey(wif).createPublic().toString();
  const posting = authorityKeys(account.posting);
  const active = authorityKeys(account.active);
  const owner = authorityKeys(account.owner);
  if (!posting || !active || !owner || typeof account.memo_key !== 'string') throw new HiveError('invalid_response');
  if (active.keys.some(([pub]) => pub === key) || owner.keys.some(([pub]) => pub === key) || account.memo_key === key) {
    throw new HiveError('authority');
  }
  if (!posting.keys.some(([pub, weight]) => pub === key && weight >= posting.threshold)) throw new HiveError('authority');
  return account;
}

async function boundedText(response: Response, max: number): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > max) throw new HiveError('invalid_response');
  if (!response.body) throw new HiveError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) throw new HiveError('invalid_response');
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new HiveError('invalid_response'); }
}

async function fixedFetch(url: string, init: RequestInit, max: number, deps: HiveDependencies, signal?: AbortSignal): Promise<{text:string;robotsHeader:string}> {
  if (signal?.aborted) throw new HiveError('network');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.min(Math.max(deps.timeoutMs ?? REQUEST_TIMEOUT_MS, 100), 60_000));
  timer.unref?.();
  let response: Response | undefined;
  try {
    response = await (deps.fetch ?? fetch)(url, {
      ...init, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
    });
    if (response.redirected || response.url && new URL(response.url).href !== new URL(url).href || !response.ok) {
      throw new HiveError('network');
    }
    return {text:await boundedText(response, max),robotsHeader:response.headers.get('x-robots-tag')??''};
  } catch (error) {
    // Stop rejected responses after boundedText has released its reader.
    controller.abort();
    void response?.body?.cancel().catch(() => undefined);
    if (error instanceof HiveError) throw error;
    throw new HiveError('network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function rpc(method: RpcMethod, params: unknown, deps: HiveDependencies, signal?: AbortSignal): Promise<unknown> {
  if (deps.rpc) return deps.rpc(method, params, signal);
  for (const node of RPC_NODES) {
    try {
      const raw = await fixedFetch(node, {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }, MAX_RPC_BYTES, deps, signal);
      const parsed = JSON.parse(raw.text) as unknown;
      if (!object(parsed) || parsed.id !== 1 || !Object.prototype.hasOwnProperty.call(parsed, 'result') || parsed.error) {
        throw new HiveError('invalid_response');
      }
      return parsed.result;
    } catch { if (signal?.aborted) break; }
  }
  throw new HiveError('network');
}

async function accountFor(name: string, deps: HiveDependencies, signal?: AbortSignal): Promise<Json> {
  const value = await rpc('condenser_api.get_accounts', [[name]], deps, signal);
  if (!Array.isArray(value) || value.length !== 1 || !object(value[0]) || value[0].name !== name) throw new HiveError('account');
  return value[0];
}

async function readCredential(vault: SecretStore, accountId: string): Promise<StoredCredential> {
  const raw = await vault.get(`account:${accountId}`);
  try {
    const parsed = JSON.parse(raw ?? '') as unknown;
    if (!object(parsed) || parsed.version !== 1 || typeof parsed.username !== 'string'
      || username(parsed.username) !== parsed.username) throw new Error();
    privateKey(parsed.postingKey);
    return parsed as unknown as StoredCredential;
  } catch { throw new HiveError('invalid_key'); }
}

/** Connect only a pre-existing Hive account with a single sufficient posting key. */
export async function connectHiveAccount(
  vault: SecretStore, accountId: string, usernameInput: string, postingKey: string, deps: HiveDependencies = {},
): Promise<{ username: string; url: string }> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(accountId)) throw new HiveError('account');
  const name = username(usernameInput);
  privateKey(postingKey);
  const account = await accountFor(name, deps);
  verifyPostingAuthority([account], name, postingKey);
  await vault.set(`account:${accountId}`, JSON.stringify({ version: 1, username: name, postingKey } satisfies StoredCredential));
  return { username: name, url: `${PUBLIC_ORIGIN}/@${name}` };
}

function approvedArticle(task: Task, siteUrl: string, requireReview: boolean, author: string): Article {
  const draft = task.draft;
  if (!draft) throw new Error('请先生成并核对 Hive 原创全文草稿');
  if (!isNormalizedUsername(author)) throw new Error('Hive 作者账号无效');
  const approvedAt = typeof task.articleApprovedAt === 'string' ? Date.parse(task.articleApprovedAt) : NaN;
  const draftUpdatedAt = task.draftUpdatedAt ? Date.parse(task.draftUpdatedAt) : NaN;
  const approved = Number.isFinite(approvedAt) && (!task.draftUpdatedAt || Number.isFinite(draftUpdatedAt) && approvedAt >= draftUpdatedAt);
  const aiPassed = task.articleReview?.status === 'passed'
    && (typeof task.draftRevision !== 'number' || task.articleReview.draftRevision === task.draftRevision);
  if (requireReview && !approved && !aiPassed) throw new Error('Hive 全文尚未通过独立 AI 核对或明确人工审批');
  if (typeof draft.title !== 'string' || !draft.title.trim() || Buffer.byteLength(draft.title, 'utf8') > 255
    || /[\u0000-\u001f\u007f]/.test(draft.title)) throw new Error('Hive 标题无效');
  if (typeof draft.body !== 'string' || draft.body !== draft.body.trim()
    || /\r|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draft.body)
    || Buffer.byteLength(draft.body, 'utf8') > MAX_ARTICLE_BYTES) throw new Error('Hive 正文无效或超过 64 KB 上限');
  const prose = draft.body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https:\/\/\S+/g, ' ')
    .replace(/[#>*_`~|\-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (draft.body.split(/\n\s*\n/).filter(Boolean).length < 2 || prose.replace(/\s/g, '').length < 200) {
    throw new Error('Hive 仅发布有实质信息的原创全文，需至少两个段落和 200 个非空白字符');
  }
  const target = canonicalHttps(task.topicUrl ?? siteUrl);
  if (task.topicUrl && new URL(target).hostname !== new URL(canonicalHttps(siteUrl)).hostname) {
    throw new Error('Hive 选题链接必须属于当前网站');
  }
  const rendered = marked.parse(draft.body, { async: false, gfm: true });
  if (typeof rendered !== 'string' || !load(rendered)('a[href]').toArray().some(element => {
    try { return canonicalHttps(load(rendered)(element).attr('href') ?? '') === target; }
    catch { return false; }
  })) throw new Error('Hive 全文必须包含目标文章的显式 HTTPS 链接');
  if (draft.description && (draft.description.length > 300 || /[\u0000-\u001f\u007f]/.test(draft.description))) {
    throw new Error('Hive 摘要超过 300 字符或包含控制字符');
  }
  const metadata = JSON.stringify({ tags: [ROOT_TAG], app: 'linkflow/1.0', format: 'markdown',
    ...(draft.description ? { description: draft.description } : {}) });
  const material = JSON.stringify({ author, title: draft.title, body: draft.body, json_metadata: metadata, target });
  const contentHash = sha256(material);
  const stem = draft.title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70).replace(/-+$/g, '');
  const permlink = `${stem || 'linkflow-article'}-${contentHash.slice(0, 20)}`;
  const comment: HiveComment = {
    parent_author: '', parent_permlink: ROOT_TAG, author, permlink, title: draft.title, body: draft.body, json_metadata: metadata,
  };
  if (commentTransactionBytes(comment) > MAX_TRANSACTION_BYTES) {
    throw new Error('Hive 全文与元数据组成的交易超过链上 64 KB 上限，请缩短稿件并重新审核');
  }
  return { comment, target, contentHash };
}

function varuintBytes(value: number): number {
  let count = 1;
  while (value >= 128) { value = Math.floor(value / 128); count++; }
  return count;
}

function commentTransactionBytes(comment: HiveComment): number {
  // Hive binary transaction: 2-byte ref number, 4-byte prefix, 4-byte expiration,
  // one operation (count + comment variant), seven length-prefixed UTF-8 strings,
  // empty extensions, then one 65-byte compact signature and its count.
  const values = [comment.parent_author, comment.parent_permlink, comment.author, comment.permlink,
    comment.title, comment.body, comment.json_metadata];
  return 2 + 4 + 4 + 1 + 1 + 1 + 1 + 65
    + values.reduce((total, value) => {
      const bytes = Buffer.byteLength(value, 'utf8');
      return total + varuintBytes(bytes) + bytes;
    }, 0);
}

function validReceipt(value: unknown): value is HiveReceipt {
  return object(value) && isNormalizedUsername(value.author)
    && validPermlink(value.permlink) && typeof value.contentHash === 'string' && /^[0-9a-f]{64}$/.test(value.contentHash)
    && (value.stage === 'submitting' || value.stage === 'published')
    && (value.transactionId === undefined || typeof value.transactionId === 'string' && /^[0-9a-f]{40}$/.test(value.transactionId));
}

type ContentState = 'found' | 'absent' | 'mismatch' | 'unknown';

function exactContent(raw: unknown, article: Article): ContentState {
  if (!object(raw) || typeof raw.author !== 'string' || !raw.author
    || typeof raw.permlink !== 'string' || !raw.permlink) return 'unknown';
  const comment = article.comment;
  return raw.author === comment.author && raw.permlink === comment.permlink && raw.parent_author === ''
    && raw.parent_permlink === ROOT_TAG && raw.title === comment.title && raw.body === comment.body
    && raw.json_metadata === comment.json_metadata ? 'found' : 'mismatch';
}

function exactMissingPost(error: unknown, article: Article): boolean {
  if (!object(error) || error.code !== -32602 || !object(error.data)
    || error.data.name !== 'assert_exception' || error.data.message !== 'Assert Exception'
    || !object(error.data.extension)) return false;
  const missing = `Post ${article.comment.author}/${article.comment.permlink} does not exist`;
  return error.message === `Assert Exception:${missing}` && error.data.extension.assertion_expression === missing;
}

async function readContentOnNode(article: Article, node: string, deps: HiveDependencies, signal?: AbortSignal): Promise<ContentState> {
  const params = [article.comment.author, article.comment.permlink];
  if (deps.rpc) {
    try { return exactContent(await deps.rpc('condenser_api.get_content', params, signal, node), article); }
    catch (error) { return exactMissingPost(error, article) ? 'absent' : 'unknown'; }
  }
  try {
    const raw = await fixedFetch(node, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'condenser_api.get_content', params }),
    }, MAX_RPC_BYTES, deps, signal);
    const envelope: unknown = JSON.parse(raw.text);
    if (!object(envelope) || envelope.id !== 1) return 'unknown';
    if (envelope.error) return exactMissingPost(envelope.error, article) ? 'absent' : 'unknown';
    if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) return 'unknown';
    return exactContent(envelope.result, article);
  } catch { return 'unknown'; }
}

async function readContent(article: Article, deps: HiveDependencies, signal?: AbortSignal): Promise<ContentState> {
  const [first, second] = await Promise.all(RPC_NODES.map(node => readContentOnNode(article, node, deps, signal)));
  if (first === second) return first;
  if (first === 'mismatch' || second === 'mismatch') return 'mismatch';
  return 'unknown';
}

function validState(task: Task, article: Article): boolean {
  const value = task.hive;
  return validReceipt(value) && value.author === article.comment.author
    && value.permlink === article.comment.permlink && value.contentHash === article.contentHash;
}

function pending(state: HiveReceipt, submittedAt: string | undefined, message: string): ExecutionResult {
  return { status: 'review', message, checkpoint: 'hive_publish_submitting', submittedAt,
    publicUrl: publicUrl(state.author, state.permlink) };
}

/** A previous intent is reconciled by exact author, permlink, title, body and metadata; it is never rebroadcast. */
export async function reconcileHiveTask(context: ExecutionContext, deps: HiveDependencies = {}): Promise<HiveReconcileResult> {
  const state = context.task.hive;
  if (!validReceipt(state) || context.task.channelId !== 'hive') return { status: 'unknown' };
  try {
    const article = approvedArticle(context.task, context.site.url, false, state.author);
    if (!validState(context.task, article) || await readContent(article, deps, context.signal) !== 'found') return { status: 'unknown' };
    return { status: 'found', publicUrl: publicUrl(state.author, state.permlink), hive: { ...state, stage: 'published' } };
  } catch { return { status: 'unknown' }; }
}

function parseChainTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value.endsWith('Z') ? value : `${value}Z`);
  return Number.isFinite(time) ? time : undefined;
}

function positiveBigInt(value: unknown): bigint | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return undefined;
  const raw = String(value);
  if (!/^\d+$/.test(raw)) return undefined;
  try { return BigInt(raw); } catch { return undefined; }
}

async function readChainHead(deps: HiveDependencies, signal: AbortSignal): Promise<ChainHead> {
  const raw = await rpc('condenser_api.get_dynamic_global_properties', [], deps, signal);
  if (!object(raw) || !Number.isSafeInteger(raw.head_block_number) || (raw.head_block_number as number) < 1
    || typeof raw.head_block_id !== 'string' || !/^[0-9a-f]{40}$/i.test(raw.head_block_id)) {
    throw new HiveError('invalid_response');
  }
  const time = parseChainTime(raw.time);
  if (time === undefined) throw new HiveError('invalid_response');
  return { number: raw.head_block_number as number, id: raw.head_block_id, time };
}

async function preflight(context: ExecutionContext, account: Json, article: Article, head: ChainHead,
  deps: HiveDependencies): Promise<ExecutionResult | undefined> {
  const now = Date.parse(stamp(deps));
  const last = account.last_root_post;
  if (typeof last !== 'string') return { status: 'needs_input', message: '无法核实 Hive 上次根帖时间，暂不广播' };
  if (last !== undefined && last !== '1970-01-01T00:00:00') {
    const lastTime = parseChainTime(last);
    if (lastTime === undefined) return { status: 'needs_input', message: '无法核实 Hive 上次根帖时间，暂不广播' };
    if (head.time - lastTime < ROOT_POST_INTERVAL_MS) {
      const retryAt = new Date(Math.max(now + 30_000, lastTime + ROOT_POST_INTERVAL_MS + 10_000)).toISOString();
      context.checkpoint({ scheduledAt: retryAt });
      return { status: 'queued', message: `Hive 每账号根帖需间隔约 5 分钟；将于 ${retryAt} 后重试` };
    }
  }
  try {
    const [rcRaw, costRaw] = await Promise.all([
      rpc('rc_api.find_rc_accounts', { accounts: [article.comment.author] }, deps, context.signal),
      rpc('rc_api.get_rc_operation_stats', { operation: 'comment_operation' }, deps, context.signal),
    ]);
    if (!object(rcRaw) || !Array.isArray(rcRaw.rc_accounts) || rcRaw.rc_accounts.length !== 1
      || !object(rcRaw.rc_accounts[0]) || rcRaw.rc_accounts[0].account !== article.comment.author
      || !object(rcRaw.rc_accounts[0].rc_manabar) || !object(costRaw)) throw new Error();
    const available = positiveBigInt(rcRaw.rc_accounts[0].rc_manabar.current_mana);
    const max = positiveBigInt(rcRaw.rc_accounts[0].max_rc);
    const avg = positiveBigInt(costRaw.avg_cost_rc);
    const lastUpdate = rcRaw.rc_accounts[0].rc_manabar.last_update_time;
    const chainSeconds = Math.floor(head.time / 1000);
    if (available === undefined || max === undefined || !avg || max === 0n
      || typeof lastUpdate !== 'number' || !Number.isSafeInteger(lastUpdate)
      || lastUpdate < 0 || lastUpdate > chainSeconds) throw new Error();
    const elapsed = BigInt(chainSeconds - lastUpdate);
    const regenerated = available + max * elapsed / BigInt(RC_REGEN_SECONDS);
    const current = regenerated > max ? max : regenerated;
    // The official statistic is an average, not a promise for this article. Leave headroom for its body size.
    const articleKiB = BigInt(Math.ceil(Buffer.byteLength(article.comment.body, 'utf8') / 1024));
    const needed = avg * (4n + articleKiB);
    if (needed > max) return { status: 'needs_input', message: 'Hive 账号最大 RC 低于此篇全文的保守发文预算；需补充 RC 后再继续' };
    if (current < needed) {
      const seconds = Number((needed - current) * BigInt(RC_REGEN_SECONDS) / max);
      const delay = Math.min(24 * 60 * 60, Math.max(5 * 60, Number.isFinite(seconds) ? seconds + 60 : 24 * 60 * 60));
      const retryAt = new Date(now + delay * 1000).toISOString();
      context.checkpoint({ scheduledAt: retryAt });
      return { status: 'queued', message: `Hive RC 暂不足，预计在 ${retryAt} 后重新只读检查；不会消耗新的发布请求` };
    }
  } catch {
    context.checkpoint({ scheduledAt: new Date(now + ROOT_POST_INTERVAL_MS).toISOString() });
    return { status: 'queued', message: 'Hive RC 只读检查暂不可用，五分钟后重试；尚未广播' };
  }
  return undefined;
}

function prepareSignedComment(comment: HiveComment, postingKey: string, head: ChainHead): SignedComment {
  // Build and sign offline. The SDK's broadcast() retries internally, so never call it here.
  const expiration = new Date(head.time + 60_000).toISOString().slice(0, 19);
  const header = Buffer.from(head.id, 'hex');
  const transaction: TransactionType = {
    ref_block_num: head.number & 0xffff,
    ref_block_prefix: header.readUInt32LE(4),
    expiration, extensions: [], operations: [['comment', comment]], signatures: [],
  };
  const signer = new Transaction({ transaction });
  const signed = signer.sign(privateKey(postingKey));
  if (signed.signatures.length !== 1 || !/^[0-9a-f]{130}$/i.test(signed.signatures[0])
    || commentTransactionBytes(comment) > MAX_TRANSACTION_BYTES) throw new HiveError('invalid_response');
  return { transaction: signed, id: signer.digest().txId };
}

async function broadcast(comment: HiveComment, postingKey: string, deps: HiveDependencies, prepared?: SignedComment): Promise<{ id?: string }> {
  if (deps.broadcastComment) return deps.broadcastComment(comment, postingKey);
  if (!prepared) throw new HiveError('invalid_response');
  // One write, to one fixed official RPC endpoint, with no redirect, failover or retry.
  const url = RPC_NODES[0];
  const raw = await fixedFetch(url, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'condenser_api.broadcast_transaction', params: [prepared.transaction] }),
  }, MAX_RPC_BYTES, deps);
  let parsed: unknown;
  try { parsed = JSON.parse(raw.text); } catch { throw new HiveError('invalid_response'); }
  if (!object(parsed) || parsed.id !== 1 || parsed.error || !Object.prototype.hasOwnProperty.call(parsed, 'result')) {
    throw new HiveError('invalid_response');
  }
  return { id: prepared.id };
}

export async function runHiveTask(context: ExecutionContext, deps: HiveDependencies = {}): Promise<ExecutionResult> {
  if (context.channel.id !== 'hive' || context.channel.automation !== 'api' || context.task.channelId !== 'hive') {
    return { status: 'needs_input', message: 'Hive API 自动发布未启用' };
  }
  const account = context.getAccount();
  if (!account || account.id !== context.task.accountId || account.channelId !== 'hive'
    || account.credentialKind !== 'api_token' || account.status !== 'registered' || !account.hasPassword) {
    return { status: 'needs_input', message: '请先连接已有 Hive 账号的 Posting Key' };
  }
  let article: Article;
  try { article = approvedArticle(context.task, context.site.url, !context.task.hive, account.username); }
  catch (error) { return { status: 'needs_input', message: error instanceof Error ? error.message : 'Hive 稿件无效' }; }
  if (context.task.hive && !validState(context.task, article)) {
    return { status: 'needs_input', message: 'Hive 原发布意图与当前作者或全文不一致；保留记录并停止操作' };
  }
  if (!context.task.hive && (context.task.submittedAt || context.task.publicUrl || context.task.firstLiveAt
    || ['hive_publish_submitting', 'hive_published'].includes(context.task.checkpoint ?? ''))) {
    return { status: 'needs_input', message: 'Hive 任务已有提交痕迹却缺少幂等回执，不能创建新帖' };
  }
  if (context.task.hive) {
    const found = await reconcileHiveTask(context, deps);
    if (found.status === 'found') {
      context.checkpoint({ hive: found.hive, checkpoint: 'hive_published', publicUrl: found.publicUrl,
        submittedAt: context.task.submittedAt });
      return { status: 'review', message: 'Hive 链上原帖全文已精确回读；等待匿名公开页面核验',
        publicUrl: found.publicUrl, checkpoint: 'hive_published', submittedAt: context.task.submittedAt };
    }
    return pending(context.task.hive, context.task.submittedAt, 'Hive 原广播结果仍未确认；只会回读原作者和 permlink，不会再次广播');
  }
  if (context.signal.aborted) return { status: 'queued', message: '任务已暂停，尚未向 Hive 广播' };
  let credential: StoredCredential;
  let remoteAccount: Json;
  try {
    credential = await readCredential(context.secrets, account.id);
    if (credential.username !== account.username) throw new HiveError('authority');
    remoteAccount = await accountFor(account.username, deps, context.signal);
    verifyPostingAuthority([remoteAccount], account.username, credential.postingKey);
  } catch (error) {
    return { status: 'needs_input', message: error instanceof HiveError && error.code === 'network'
      ? 'Hive 账号权限暂时无法回读，请稍后重试' : 'Hive Posting Key 或账号权限不匹配，请重新连接原账号' };
  }
  let head: ChainHead;
  try { head = await readChainHead(deps, context.signal); }
  catch {
    context.checkpoint({ scheduledAt: new Date(Date.parse(stamp(deps)) + ROOT_POST_INTERVAL_MS).toISOString() });
    return { status: 'queued', message: 'Hive 链上区块时间暂不可用，五分钟后重试；尚未广播' };
  }
  const wait = await preflight(context, remoteAccount, article, head, deps);
  if (wait) return wait;
  try {
    const collision = await readContent(article, deps, context.signal);
    if (collision === 'found' || collision === 'mismatch') {
      return { status: 'needs_input', message: '作者名下已有相同 permlink 的帖子；不会覆盖或新建替代帖子' };
    }
    if (collision !== 'absent') {
      context.checkpoint({ scheduledAt: new Date(Date.parse(stamp(deps)) + ROOT_POST_INTERVAL_MS).toISOString() });
      return { status: 'queued', message: 'Hive 两个固定节点未能同时明确证实 permlink 尚不存在；稍后只读重查' };
    }
  } catch {
    context.checkpoint({ scheduledAt: new Date(Date.parse(stamp(deps)) + ROOT_POST_INTERVAL_MS).toISOString() });
    return { status: 'queued', message: 'Hive 原帖占用检查暂不可用，五分钟后重试；尚未广播' };
  }
  let prepared: SignedComment | undefined;
  if (!deps.broadcastComment) {
    try { prepared = prepareSignedComment(article.comment, credential.postingKey, head); }
    catch {
      context.checkpoint({ scheduledAt: new Date(Date.parse(stamp(deps)) + ROOT_POST_INTERVAL_MS).toISOString() });
      return { status: 'queued', message: 'Hive 链上交易参数暂不可用，五分钟后重试；尚未广播' };
    }
  }
  if (context.signal.aborted) return { status: 'queued', message: '任务已暂停，尚未向 Hive 广播' };
  const submittedAt = stamp(deps);
  const receipt: HiveReceipt = { author: account.username, permlink: article.comment.permlink,
    contentHash: article.contentHash, stage: 'submitting' };
  context.checkpoint({ hive: receipt, checkpoint: 'hive_publish_submitting', submittedAt, draft: context.task.draft });
  let recordedReceipt = receipt;
  try {
    const result = await broadcast(article.comment, credential.postingKey, deps, prepared);
    if (typeof result.id === 'string' && /^[0-9a-f]{40}$/.test(result.id)) {
      recordedReceipt = { ...receipt, transactionId: result.id };
      context.checkpoint({ hive: recordedReceipt, submittedAt });
    }
  } catch {
    return pending(recordedReceipt, submittedAt, 'Hive 广播结果不明；原意图已保留，后续只读对账，绝不盲目重发');
  }
  const found = await reconcileHiveTask({ ...context, task: { ...context.task, hive: recordedReceipt, submittedAt } }, deps);
  if (found.status === 'found') {
    context.checkpoint({ hive: found.hive, checkpoint: 'hive_published', publicUrl: found.publicUrl, submittedAt });
    return { status: 'review', message: 'Hive 链上原帖已按作者、permlink、全文和元数据回读，等待匿名页面核验',
      publicUrl: found.publicUrl, checkpoint: 'hive_published', submittedAt };
  }
  return pending(recordedReceipt, submittedAt, 'Hive 交易已提交，但完整链上内容尚未回读；后续只核对原帖');
}

function unavailable(url: string, reason: string, outcome: LinkResult['outcome'] = 'unreachable'): LinkResult {
  return { found: false, outcome, url, rel: 'unknown', reason };
}

export async function verifyHivePublication(
  task: Task, targetSiteUrl: string, signal?: AbortSignal, deps: HiveDependencies = {},
): Promise<LinkResult> {
  const state = task.hive;
  const fallback = task.publicUrl ?? `${PUBLIC_ORIGIN}/`;
  if (!validReceipt(state)) return unavailable(fallback, 'Hive 任务缺少有效作者、permlink 或全文回执', 'invalid');
  let article: Article;
  try {
    article = approvedArticle(task, targetSiteUrl, false, state.author);
    if (!validState(task, article)) throw new Error();
  } catch { return unavailable(fallback, 'Hive 任务全文或作者与原提交意图不一致', 'invalid'); }
  const url = publicUrl(state.author, state.permlink);
  if (task.publicUrl && task.publicUrl !== url) return unavailable(task.publicUrl, 'Hive 公开网址与原作者或 permlink 不一致', 'invalid');
  try {
    const content = await readContent(article, deps, signal);
    if (content === 'mismatch') return unavailable(url, 'Hive 链上原帖的作者、全文或元数据不一致', 'invalid');
    if (content !== 'found') return unavailable(url, 'Hive 原帖尚未在公开 RPC 回读到');
    const html = await fixedFetch(url, { method: 'GET', headers: { accept: 'text/html,application/xhtml+xml' } }, MAX_HTML_BYTES, deps, signal);
    const selectors = ['.PostFull__body .MarkdownViewer', '.PostFull__body', 'article .MarkdownViewer',
      'article .markdown', 'article .prose', '.MarkdownViewer'];
    for (const selector of selectors) {
      const match = inspectRenderedArticle(html.text, article.comment.body, article.target, selector, { title: article.comment.title,pageUrl:url,robotsHeader:html.robotsHeader });
      if (match.found) return { found: true, outcome: 'found', url, rel: match.rel,
        reason: 'Hive 链上原帖与匿名公开页面完整正文和可见目标 href 均已一致核验' };
      if(match.reason==='policy')return unavailable(url,'Hive 链上原帖已保留，但公开页有索引限制、跳转或 canonical 冲突，不能计为合格来源','invalid');
    }
    return unavailable(url, 'Hive 匿名页面尚未完整呈现原文及可见目标链接');
  } catch { return unavailable(url, 'Hive 公开 RPC 或匿名页面暂时无法核验'); }
}
