import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import type {
  Account,
  AccountDiagnostic,
  ExecutionContext,
  ExecutionResult,
  LinkResult,
  SecretStore,
  Task,
} from '../shared/types';
import { socialDraftError } from '../shared/social-content';

const PDS_ORIGIN = 'https://bsky.social';
const APPVIEW_ORIGIN = 'https://public.api.bsky.app';
const POST_COLLECTION = 'app.bsky.feed.post';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_POST_BYTES = 3_000;
const MAX_POST_GRAPHEMES = 300;

export type BlueskyTransport = (input: string, init: RequestInit) => Promise<Response>;

export interface BlueskyDependencies {
  fetch?: BlueskyTransport;
  now?: () => Date | string;
  randomBytes?: (size: number) => Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type BlueskyStage = 'creating' | 'published';

export interface BlueskyTaskState {
  did: string;
  rkey: string;
  recordHash: string;
  recordCreatedAt: string;
  stage: BlueskyStage;
  uri?: string;
  cid?: string;
}

type BlueskyTask = Task & { bluesky?: BlueskyTaskState };
type JsonObject = Record<string, unknown>;

interface BlueskySession {
  accessJwt: string;
  refreshJwt: string;
  handle: string;
  did: string;
}

interface BlueskyStoredCredential extends BlueskySession {
  version: 1;
  appPassword: string;
}

interface ApprovedPost {
  text: string;
  target: string;
  record: JsonObject;
  recordHash: string;
}

interface RecordReceipt {
  uri: string;
  cid: string;
  publicUrl: string;
}

export type BlueskyErrorCode =
  | 'auth'
  | 'restricted'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'cancelled'
  | 'rejected'
  | 'not_found'
  | 'invalid_response';

export class BlueskyError extends Error {
  readonly code: BlueskyErrorCode;

  constructor(code: BlueskyErrorCode) {
    super(`Bluesky request failed (${code})`);
    this.name = 'BlueskyError';
    this.code = code;
  }
}

const sessionLocks = new Map<string, Promise<void>>();

function object(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function timestamp(dependencies?: BlueskyDependencies): string {
  const supplied = dependencies?.now?.();
  const value = supplied instanceof Date ? supplied : typeof supplied === 'string' ? new Date(supplied) : new Date();
  return (Number.isFinite(value.getTime()) ? value : new Date()).toISOString();
}

function transport(dependencies?: BlueskyDependencies): BlueskyTransport {
  return dependencies?.fetch ?? ((input, init) => fetch(input, init));
}

function validHandle(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 253 || value !== value.toLowerCase()) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  return labels.every((label, index) => label.length >= 1 && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    && (index !== labels.length - 1 || /[a-z]/.test(label)));
}

export function normalizeBlueskyHandle(value: string): string {
  const handle = value.trim().replace(/^@/, '').toLowerCase();
  if (!validHandle(handle)) throw new Error('Bluesky handle 格式无效');
  return handle;
}

function validDid(value: unknown): value is string {
  return typeof value === 'string' && /^did:(?:plc|web):[A-Za-z0-9:._%-]{1,240}$/.test(value);
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && Buffer.byteLength(value, 'utf8') <= MAX_TOKEN_BYTES
    && !/[\s\u0000-\u001f\u007f]/.test(value);
}

export function validBlueskyAppPassword(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]{4}(?:-[a-z0-9]{4}){3}$/i.test(value);
}

function validTid(value: unknown): value is string {
  return typeof value === 'string' && /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(value);
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validCid(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9]{8,200}$/.test(value);
}

function canonicalHttps(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname || (url.port && url.port !== '443')) {
      throw new Error('invalid');
    }
    return url.toString();
  } catch {
    throw new Error('发布目标必须是不含凭据和片段的 HTTPS 网址');
  }
}

function graphemeLength(value: string): number {
  const Segmenter = Intl.Segmenter;
  if (typeof Segmenter === 'function') return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length;
  return Array.from(value).length;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!object(value)) return value;
  const result: JsonObject = {};
  for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
  return result;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function rawHttpsLinks(text: string): Array<{ value: string; index: number }> {
  const links: Array<{ value: string; index: number }> = [];
  for (const match of text.matchAll(/https:\/\/[^\s<>"']+/giu)) {
    const raw = match[0];
    const value = raw.replace(/[),.;!?\]}\u3001\u3002，；：！？）》】]+$/u, '');
    if (value) links.push({ value, index: match.index ?? 0 });
  }
  return links;
}

function linkFacet(text: string, target: string): JsonObject {
  const links = rawHttpsLinks(text);
  if (links.length !== 1 || links[0].value !== target) {
    throw new Error(`Bluesky 短文必须且只能包含一个原始 HTTPS 链接，且必须是已核对的站内选题链接`);
  }
  if (text.indexOf(target, links[0].index + target.length) !== -1) {
    throw new Error('Bluesky 短文不能重复目标链接');
  }
  const byteStart = Buffer.byteLength(text.slice(0, links[0].index), 'utf8');
  const byteEnd = byteStart + Buffer.byteLength(target, 'utf8');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.subarray(byteStart, byteEnd).toString('utf8') !== target) throw new Error('Bluesky 链接切片无效');
  return {
    index: { byteStart, byteEnd },
    features: [{ $type: 'app.bsky.richtext.facet#link', uri: target }],
  };
}

function approvedPost(
  task: Task,
  siteUrl: string,
  createdAt: string,
  requireReview: boolean,
): ApprovedPost {
  const draft = task.draft;
  if (!draft || typeof draft.body !== 'string') throw new Error('请先生成并核对 Bluesky 短文');
  const formatError = socialDraftError(task, { url: siteUrl }, { contentFormat: 'social' });
  if (formatError) throw new Error(`Bluesky 短文格式无效：${formatError}`);
  const aiPassed = task.articleReview?.status === 'passed';
  const manuallyApproved = typeof task.articleApprovedAt === 'string'
    && Number.isFinite(Date.parse(task.articleApprovedAt));
  if (requireReview && !aiPassed && !manuallyApproved) {
    throw new Error('Bluesky 短文尚未通过独立 AI 核对或明确人工审批');
  }
  if (requireReview && aiPassed && typeof task.draftRevision === 'number'
    && task.articleReview?.draftRevision !== task.draftRevision) {
    throw new Error('Bluesky 短文在核对后已变更，需要重新核对');
  }
  if (/\r|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draft.body) || !draft.body.trim()) {
    throw new Error('Bluesky 短文包含不支持的控制字符或为空');
  }
  if (Buffer.byteLength(draft.body, 'utf8') > MAX_POST_BYTES || graphemeLength(draft.body) > MAX_POST_GRAPHEMES) {
    throw new Error('Bluesky 短文超过 300 个字素或 3000 个 UTF-8 字节');
  }
  if (graphemeLength(draft.body) < 30) throw new Error('Bluesky 短文需要包含有实际信息的教育性摘要');
  if (!/(?:商业关系披露\s*[：:]|commercial relationship disclosure\s*:)/iu.test(draft.body)) {
    throw new Error('Bluesky 短文必须明确写出“商业关系披露：”');
  }
  const base = new URL(canonicalHttps(siteUrl));
  if (!task.topicUrl) throw new Error('Bluesky 短文缺少已核对的站内选题链接');
  const target = canonicalHttps(task.topicUrl);
  const targetUrl = new URL(target);
  if (targetUrl.hostname !== base.hostname) throw new Error('Bluesky 短文只能链接当前网站的已核对选题');
  const parsedCreatedAt = new Date(createdAt);
  if (!Number.isFinite(parsedCreatedAt.getTime()) || parsedCreatedAt.toISOString() !== createdAt) {
    throw new Error('Bluesky 记录时间无效');
  }
  const record: JsonObject = {
    $type: POST_COLLECTION,
    text: draft.body,
    facets: [linkFacet(draft.body, target)],
    createdAt,
  };
  return { text: draft.body, target, record, recordHash: sha256(canonicalJson(record)) };
}

function expectedUri(did: string, rkey: string): string {
  return `at://${did}/${POST_COLLECTION}/${rkey}`;
}

function publicPostUrl(did: string, rkey: string): string {
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

function validState(value: BlueskyTaskState): boolean {
  if (!validDid(value.did) || !validTid(value.rkey) || !validHash(value.recordHash)
    || !['creating', 'published'].includes(value.stage)
    || !Number.isFinite(Date.parse(value.recordCreatedAt))
    || new Date(value.recordCreatedAt).toISOString() !== value.recordCreatedAt) return false;
  if ((value.uri === undefined) !== (value.cid === undefined)) return false;
  if (value.uri !== undefined && (value.uri !== expectedUri(value.did, value.rkey) || !validCid(value.cid))) return false;
  return value.stage !== 'published' || (value.uri !== undefined && value.cid !== undefined);
}

function taskState(task: Task): BlueskyTaskState | undefined {
  return (task as BlueskyTask).bluesky;
}

function taskCheckpoint(context: ExecutionContext, partial: Record<string, unknown>): void {
  context.checkpoint(partial as Partial<Task>);
}

function createTid(dependencies?: BlueskyDependencies): string {
  const instant = new Date(timestamp(dependencies));
  const random = dependencies?.randomBytes?.(2) ?? cryptoRandomBytes(2);
  if (!(random instanceof Uint8Array) || random.byteLength !== 2) throw new Error('Bluesky rkey 随机源无效');
  const clockId = ((random[0] << 8) | random[1]) & 0x3ff;
  let value = (BigInt(instant.getTime()) * 1_000n << 10n) | BigInt(clockId);
  const alphabet = '234567abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let index = 0; index < 13; index++) {
    result = alphabet[Number(value & 31n)] + result;
    value >>= 5n;
  }
  if (!validTid(result)) throw new Error('Bluesky rkey 生成失败');
  return result;
}

async function readBoundedJson(response: Response): Promise<JsonObject> {
  const advertised = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) throw new BlueskyError('invalid_response');
  if (!response.body) throw new BlueskyError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new BlueskyError('invalid_response');
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
    if (error instanceof BlueskyError) throw error;
    throw new BlueskyError('invalid_response');
  }
}

function endpointAllowed(origin: string, nsid: string, method: string): boolean {
  if (origin === PDS_ORIGIN) return (
    method === 'POST' && ['com.atproto.server.createSession', 'com.atproto.server.refreshSession', 'com.atproto.repo.createRecord'].includes(nsid)
  ) || (method === 'GET' && nsid === 'com.atproto.repo.getRecord');
  return origin === APPVIEW_ORIGIN && method === 'GET' && nsid === 'app.bsky.feed.getPosts';
}

async function xrpcRequest(
  origin: typeof PDS_ORIGIN | typeof APPVIEW_ORIGIN,
  nsid: string,
  options: {
    method: 'GET' | 'POST';
    token?: string;
    body?: JsonObject;
    query?: Array<[string, string]>;
    signal?: AbortSignal;
  },
  dependencies?: BlueskyDependencies,
): Promise<JsonObject> {
  if (!endpointAllowed(origin, nsid, options.method)) throw new BlueskyError('invalid_response');
  if (options.token !== undefined && !validToken(options.token)) throw new BlueskyError('auth');
  const url = new URL(`/xrpc/${nsid}`, origin);
  for (const [key, value] of options.query ?? []) url.searchParams.append(key, value);
  const externalSignal = options.signal ?? dependencies?.signal;
  if (externalSignal?.aborted) throw new BlueskyError('cancelled');
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener('abort', abort, { once: true });
  const timeoutMs = Math.min(Math.max(dependencies?.timeoutMs ?? REQUEST_TIMEOUT_MS, 10), 30_000);
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  timer.unref?.();
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'Linkflow-Desktop' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body) headers['content-type'] = 'application/json';
  try {
    let response: Response;
    try {
      response = await transport(dependencies)(url.toString(), {
        method: options.method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
    } catch {
      if (externalSignal?.aborted) throw new BlueskyError('cancelled');
      if (timedOut) throw new BlueskyError('timeout');
      throw new BlueskyError('network');
    }
    if (response.redirected) throw new BlueskyError('invalid_response');
    if (response.url) {
      try {
        if (new URL(response.url).toString() !== url.toString()) throw new Error('mismatch');
      } catch { throw new BlueskyError('invalid_response'); }
    }
    let value: JsonObject | undefined;
    try { value = await readBoundedJson(response); }
    catch (error) {
      if (response.ok) throw error;
    }
    const remoteCode = typeof value?.error === 'string' ? value.error : '';
    if (response.ok) return value!;
    if (remoteCode === 'AccountTakedown' || response.status === 403) throw new BlueskyError('restricted');
    if (response.status === 401 || remoteCode === 'InvalidToken' || remoteCode === 'ExpiredToken'
      || (nsid === 'com.atproto.server.createSession' && response.status === 400)) throw new BlueskyError('auth');
    if (response.status === 404 || remoteCode === 'RecordNotFound') throw new BlueskyError('not_found');
    if (response.status === 429) throw new BlueskyError('rate_limited');
    if (response.status === 408 || response.status >= 500) throw new BlueskyError('network');
    if (response.status === 400 || response.status === 409 || response.status === 422) throw new BlueskyError('rejected');
    throw new BlueskyError('invalid_response');
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abort);
  }
}

function sessionFrom(value: JsonObject): BlueskySession {
  if (!validToken(value.accessJwt) || !validToken(value.refreshJwt) || !validHandle(value.handle) || !validDid(value.did)) {
    throw new BlueskyError('invalid_response');
  }
  if (value.active === false || ['takendown', 'suspended', 'deactivated'].includes(String(value.status ?? '').toLowerCase())) {
    throw new BlueskyError('restricted');
  }
  return { accessJwt: value.accessJwt, refreshJwt: value.refreshJwt, handle: value.handle, did: value.did };
}

function credentialFrom(value: unknown): BlueskyStoredCredential {
  let parsed = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_BYTES) throw new BlueskyError('auth');
    try { parsed = JSON.parse(value); }
    catch { throw new BlueskyError('auth'); }
  }
  if (!object(parsed) || parsed.version !== 1 || !validBlueskyAppPassword(parsed.appPassword)) throw new BlueskyError('auth');
  const session = sessionFrom(parsed);
  return { version: 1, appPassword: parsed.appPassword, ...session };
}

function serializeCredential(credential: BlueskyStoredCredential): string {
  const serialized = JSON.stringify(credential);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CREDENTIAL_BYTES) throw new BlueskyError('invalid_response');
  return serialized;
}

async function withSessionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const ready = (sessionLocks.get(key) ?? Promise.resolve()).catch(() => undefined);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const tail = ready.then(() => held);
  sessionLocks.set(key, tail);
  await ready;
  try { return await operation(); }
  finally {
    release();
    if (sessionLocks.get(key) === tail) sessionLocks.delete(key);
  }
}

async function createSession(handle: string, appPassword: string, dependencies?: BlueskyDependencies): Promise<BlueskySession> {
  const value = await xrpcRequest(PDS_ORIGIN, 'com.atproto.server.createSession', {
    method: 'POST', body: { identifier: handle, password: appPassword }, signal: dependencies?.signal,
  }, dependencies);
  const session = sessionFrom(value);
  if (session.handle !== handle) throw new BlueskyError('auth');
  return session;
}

async function refreshSession(refreshJwt: string, dependencies?: BlueskyDependencies): Promise<BlueskySession> {
  return sessionFrom(await xrpcRequest(PDS_ORIGIN, 'com.atproto.server.refreshSession', {
    method: 'POST', token: refreshJwt, signal: dependencies?.signal,
  }, dependencies));
}

/** Connects only with the dedicated app-password format; primary passwords are rejected locally. */
export async function createBlueskyCredential(
  handleInput: string,
  appPassword: string,
  dependencies: BlueskyDependencies = {},
  lockKey?: string,
  commit?: (authenticated: { did: string; handle: string; secret: string }) => Promise<void>,
): Promise<{ did: string; handle: string; secret: string }> {
  const handle = normalizeBlueskyHandle(handleInput);
  if (!validBlueskyAppPassword(appPassword)) {
    throw new Error('请使用 Bluesky 设置中创建的应用专用密码；不接受主密码');
  }
  return await withSessionLock(lockKey ? `account:${lockKey}` : `connect:${handle}`, async () => {
    const session = await createSession(handle, appPassword, dependencies);
    const credential: BlueskyStoredCredential = { version: 1, appPassword, ...session };
    const authenticated = { did: session.did, handle: session.handle, secret: serializeCredential(credential) };
    await commit?.(authenticated);
    return authenticated;
  });
}

async function refreshedCredential(
  secrets: SecretStore,
  accountId: string,
  expectedDid: string,
  dependencies: BlueskyDependencies,
): Promise<BlueskyStoredCredential> {
  return await withSessionLock(`account:${accountId}`, async () => {
    const raw = await secrets.get(`account:${accountId}`);
    if (!raw) throw new BlueskyError('auth');
    const stored = credentialFrom(raw);
    if (stored.did !== expectedDid) throw new BlueskyError('auth');
    let session: BlueskySession;
    try {
      session = await refreshSession(stored.refreshJwt, dependencies);
    } catch (error) {
      if (!(error instanceof BlueskyError) || error.code !== 'auth') throw error;
      session = await createSession(stored.handle, stored.appPassword, dependencies);
    }
    if (session.did !== expectedDid) throw new BlueskyError('auth');
    const updated: BlueskyStoredCredential = { version: 1, appPassword: stored.appPassword, ...session };
    await secrets.set(`account:${accountId}`, serializeCredential(updated));
    return updated;
  });
}

function diagnostic(code: AccountDiagnostic['code'], message: string, dependencies?: BlueskyDependencies): AccountDiagnostic {
  return { code, message, at: timestamp(dependencies), retryable: false };
}

async function markAccountFailure(
  context: ExecutionContext,
  account: Account,
  error: unknown,
  dependencies?: BlueskyDependencies,
): Promise<void> {
  if (!(error instanceof BlueskyError) || !['auth', 'restricted'].includes(error.code)) return;
  const restricted = error.code === 'restricted';
  await context.saveAccount({
    ...account,
    status: restricted ? 'restricted' : 'credentials_invalid',
    diagnostic: diagnostic(restricted ? 'restricted' : 'bad_password', restricted
      ? 'Bluesky 账号或发布权限已受限。'
      : 'Bluesky 应用专用密码或会话已失效，请重新连接原 DID。', dependencies),
    updatedAt: timestamp(dependencies),
  });
}

function failureMessage(error: unknown, submitted: boolean): string {
  if (!(error instanceof BlueskyError)) return submitted ? 'Bluesky 提交结果无法确认，不会重复发布' : '暂时无法连接 Bluesky';
  if (error.code === 'auth') return 'Bluesky 应用专用密码或会话已失效，请重新连接原 DID';
  if (error.code === 'restricted') return 'Bluesky 账号或发布权限已受限';
  if (error.code === 'rate_limited') return submitted ? 'Bluesky 提交后遇到速率限制，只会对账而不会重发' : 'Bluesky 已触发速率限制，尚未发布';
  if (error.code === 'cancelled') return submitted ? '任务在 Bluesky 提交期间暂停，已保留对账记录' : '任务已暂停，尚未提交 Bluesky';
  if (error.code === 'rejected') return submitted ? 'Bluesky 明确拒绝了请求；保留原 rkey 且不会重发' : 'Bluesky 明确拒绝了请求';
  if (error.code === 'not_found') return 'Bluesky 暂未读到已记录的 rkey；这不代表可以重新发布';
  if (error.code === 'invalid_response') return submitted ? 'Bluesky 返回的发布回执无法安全确认，不会重发' : 'Bluesky 返回了无法安全确认的数据';
  return submitted ? 'Bluesky 提交结果不明，只会对账而不会重发' : '暂时无法连接 Bluesky，尚未发布';
}

function receiptFrom(value: JsonObject, did: string, rkey: string): RecordReceipt {
  const uri = expectedUri(did, rkey);
  if (value.uri !== uri || !validCid(value.cid)) throw new BlueskyError('invalid_response');
  return { uri, cid: value.cid, publicUrl: publicPostUrl(did, rkey) };
}

async function getExactRecord(
  state: BlueskyTaskState,
  expectedRecord: JsonObject,
  dependencies?: BlueskyDependencies,
  signal?: AbortSignal,
): Promise<RecordReceipt> {
  const value = await xrpcRequest(PDS_ORIGIN, 'com.atproto.repo.getRecord', {
    method: 'GET',
    query: [['repo', state.did], ['collection', POST_COLLECTION], ['rkey', state.rkey]],
    signal,
  }, dependencies);
  const receipt = receiptFrom(value, state.did, state.rkey);
  if (state.uri && receipt.uri !== state.uri) throw new BlueskyError('invalid_response');
  if (state.cid && receipt.cid !== state.cid) throw new BlueskyError('invalid_response');
  if (!object(value.value) || canonicalJson(value.value) !== canonicalJson(expectedRecord)) throw new BlueskyError('invalid_response');
  return receipt;
}

export async function reconcileBlueskyTask(
  context: ExecutionContext,
  dependencies: BlueskyDependencies = {},
): Promise<{ status: 'found'; uri: string; cid: string; publicUrl: string } | { status: 'unknown' }> {
  const unknown = { status: 'unknown' as const };
  const state = taskState(context.task);
  const account = context.getAccount();
  if (context.channel.id !== 'bluesky' || context.task.channelId !== 'bluesky' || !state || !validState(state)
    || !account || account.id !== context.task.accountId || account.channelId !== 'bluesky' || account.username !== state.did) return unknown;
  let approved: ApprovedPost;
  try { approved = approvedPost(context.task, context.site.url, state.recordCreatedAt, false); }
  catch { return unknown; }
  if (approved.recordHash !== state.recordHash) return unknown;
  // Exactly one safe GET per invocation. The controller persists and caps the
  // scheduled recovery count at three across restarts.
  if (context.signal.aborted) return unknown;
  try {
    const receipt = await getExactRecord(state, approved.record, dependencies, context.signal);
    return { status: 'found', ...receipt };
  } catch {
    return unknown;
  }
}

export async function runBlueskyTask(
  context: ExecutionContext,
  dependencies: BlueskyDependencies = {},
): Promise<ExecutionResult> {
  if (context.channel.id !== 'bluesky' || context.channel.automation !== 'api' || context.task.channelId !== 'bluesky') {
    return { status: 'needs_input', message: '该渠道没有启用 Bluesky API 自动化' };
  }
  const account = context.getAccount();
  if (!account || account.channelId !== 'bluesky' || context.task.accountId !== account.id) {
    return { status: 'needs_input', message: '请先连接已有 Bluesky 账号，并使用现有账号绑定网站' };
  }
  if (account.credentialKind !== 'api_token' || account.status !== 'registered' || !account.hasPassword || !validDid(account.username)) {
    return { status: 'needs_input', message: 'Bluesky 原 DID 身份或应用专用密码不可用，请重新连接' };
  }

  const prior = taskState(context.task);
  const remoteCheckpoint = ['bluesky_create_submitting', 'bluesky_create_accepted', 'bluesky_published'].includes(context.task.checkpoint ?? '');
  const remoteIntent = !!prior || !!context.task.submittedAt || !!context.task.publicUrl || !!context.task.firstLiveAt || remoteCheckpoint;
  if (!prior && (context.task.submittedAt || context.task.publicUrl || context.task.firstLiveAt || remoteCheckpoint)) {
    return {
      status: 'needs_input',
      message: '已有 Bluesky 提交或公开网址但缺少幂等记录，不会创建新帖子',
      checkpoint: context.task.checkpoint,
      submittedAt: context.task.submittedAt,
      publicUrl: context.task.publicUrl,
    };
  }
  if (prior && (!validState(prior) || prior.did !== account.username)) {
    return {
      status: 'needs_input', message: '保存的 Bluesky DID、rkey 或记录回执无效；不会重新发布',
      checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt, publicUrl: context.task.publicUrl,
    };
  }
  if (prior && context.task.publicUrl && context.task.publicUrl !== publicPostUrl(prior.did, prior.rkey)) {
    return {
      status: 'needs_input', message: '已保存的 Bluesky 公开网址与原 DID/rkey 不一致；保留原记录并停止操作',
      checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt, publicUrl: context.task.publicUrl,
    };
  }

  if (prior) {
    let approved: ApprovedPost;
    try { approved = approvedPost(context.task, context.site.url, prior.recordCreatedAt, false); }
    catch (error) {
      return { status: 'needs_input', message: error instanceof Error ? error.message : 'Bluesky 短文无法与原记录对账', checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt, publicUrl: context.task.publicUrl };
    }
    if (approved.recordHash !== prior.recordHash) {
      return { status: 'needs_input', message: 'Bluesky 短文或链接已与原提交记录不同；保留原 rkey 且不会重发', checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt, publicUrl: context.task.publicUrl };
    }
    const reconciled = await reconcileBlueskyTask(context, dependencies);
    if (reconciled.status !== 'found') {
      return { status: 'needs_input', message: 'Bluesky 已有提交记录，但暂未回读到完全相同的记录；不会重发', checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt, publicUrl: context.task.publicUrl ?? (prior.uri ? publicPostUrl(prior.did, prior.rkey) : undefined) };
    }
    const published: BlueskyTaskState = { ...prior, stage: 'published', uri: reconciled.uri, cid: reconciled.cid };
    taskCheckpoint(context, { bluesky: published, checkpoint: 'bluesky_published', publicUrl: reconciled.publicUrl, submittedAt: context.task.submittedAt });
    return { status: 'review', message: '已回读并确认 Bluesky 完整记录，等待 AppView 公开可见性核验', publicUrl: reconciled.publicUrl, checkpoint: 'bluesky_published', submittedAt: context.task.submittedAt };
  }

  let approved: ApprovedPost;
  try { approved = approvedPost(context.task, context.site.url, timestamp(dependencies), true); }
  catch (error) { return { status: 'needs_input', message: error instanceof Error ? error.message : 'Bluesky 短文不符合发布要求' }; }
  if (context.signal.aborted) return { status: 'queued', message: '任务已暂停，尚未向 Bluesky 提交' };

  let credential: BlueskyStoredCredential;
  try {
    credential = await refreshedCredential(context.secrets, account.id, account.username, { ...dependencies, signal: context.signal });
    await context.saveAccount({
      ...account,
      displayName: `@${credential.handle}`,
      status: 'registered',
      verifiedAt: timestamp(dependencies),
      lastUsedAt: timestamp(dependencies),
      updatedAt: timestamp(dependencies),
      diagnostic: undefined,
    });
  } catch (error) {
    await markAccountFailure(context, account, error, dependencies);
    if (error instanceof BlueskyError && error.code === 'cancelled') return { status: 'queued', message: failureMessage(error, false) };
    return {
      status: error instanceof BlueskyError && ['network', 'timeout', 'rate_limited'].includes(error.code) ? 'failed' : 'needs_input',
      message: failureMessage(error, false),
      ...(error instanceof BlueskyError && error.code === 'auth' && !remoteIntent ? { checkpoint: 'account_handoff' } : {}),
    };
  }

  const recordCreatedAt = timestamp(dependencies);
  try { approved = approvedPost(context.task, context.site.url, recordCreatedAt, true); }
  catch (error) { return { status: 'needs_input', message: error instanceof Error ? error.message : 'Bluesky 短文不符合发布要求' }; }
  const rkey = createTid(dependencies);
  let state: BlueskyTaskState = {
    did: credential.did,
    rkey,
    recordHash: approved.recordHash,
    recordCreatedAt,
    stage: 'creating',
  };
  const submittedAt = recordCreatedAt;
  taskCheckpoint(context, {
    bluesky: state,
    checkpoint: 'bluesky_create_submitting',
    submittedAt,
    draft: context.task.draft,
  });

  let receipt: RecordReceipt;
  try {
    const value = await xrpcRequest(PDS_ORIGIN, 'com.atproto.repo.createRecord', {
      method: 'POST', token: credential.accessJwt, signal: context.signal,
      body: { repo: credential.did, collection: POST_COLLECTION, rkey, validate: true, record: approved.record },
    }, dependencies);
    receipt = receiptFrom(value, credential.did, rkey);
  } catch (error) {
    await markAccountFailure(context, account, error, dependencies);
    return { status: 'needs_input', message: failureMessage(error, true), checkpoint: 'bluesky_create_submitting', submittedAt };
  }

  state = { ...state, uri: receipt.uri, cid: receipt.cid };
  try {
    taskCheckpoint(context, {
      bluesky: state,
      checkpoint: 'bluesky_create_accepted',
      submittedAt,
    });
  } catch {
    return { status: 'review', message: 'Bluesky 已返回 DID/rkey/CID 回执；保留原提交且不会重发', checkpoint: 'bluesky_create_submitting', submittedAt, publicUrl: receipt.publicUrl };
  }
  if (context.signal.aborted) {
    return { status: 'review', message: 'Bluesky 已返回发布回执；暂停后只会对账原 DID/rkey', checkpoint: 'bluesky_create_accepted', submittedAt, publicUrl: receipt.publicUrl };
  }
  let reconciled: RecordReceipt | undefined;
  try { reconciled = await getExactRecord(state, approved.record, dependencies, context.signal); }
  catch { /* The accepted receipt remains durable; a later read may reconcile it. */ }
  if (!reconciled) {
    return { status: 'review', message: 'Bluesky 已返回发布回执，完整记录回读待确认；不会重发', checkpoint: 'bluesky_create_accepted', submittedAt, publicUrl: receipt.publicUrl };
  }
  state = { ...state, stage: 'published', uri: reconciled.uri, cid: reconciled.cid };
  taskCheckpoint(context, {
    bluesky: state,
    checkpoint: 'bluesky_published',
    submittedAt,
    publicUrl: reconciled.publicUrl,
  });
  return { status: 'review', message: '已回读并确认 Bluesky 完整记录，等待 AppView 公开可见性核验', publicUrl: reconciled.publicUrl, checkpoint: 'bluesky_published', submittedAt };
}

function unavailableResult(url: string, reason: string, outcome: LinkResult['outcome'] = 'unreachable'): LinkResult {
  return { found: false, outcome, url, rel: 'unknown', reason };
}

/**
 * Anonymous public verification requires both the authoritative hosted-PDS
 * record and the hydrated AppView record. A PDS 404 is deliberately unknown:
 * it never authorizes another createRecord call.
 */
export async function verifyBlueskyPublication(
  task: Task,
  targetSiteUrl: string,
  signal?: AbortSignal,
  dependencies: BlueskyDependencies = {},
): Promise<LinkResult> {
  const state = taskState(task);
  const fallbackUrl = task.publicUrl ?? (state && validDid(state.did) && validTid(state.rkey) ? publicPostUrl(state.did, state.rkey) : 'https://bsky.app/');
  if (!state || !validState(state)) return unavailableResult(fallbackUrl, 'Bluesky 任务缺少有效 DID/rkey 回执', 'invalid');
  if (task.publicUrl && task.publicUrl !== publicPostUrl(state.did, state.rkey)) {
    return unavailableResult(task.publicUrl, 'Bluesky 公开网址与原 DID/rkey 不一致', 'invalid');
  }
  let approved: ApprovedPost;
  try { approved = approvedPost(task, targetSiteUrl, state.recordCreatedAt, false); }
  catch { return unavailableResult(fallbackUrl, 'Bluesky 任务内容无法与原记录匹配', 'invalid'); }
  if (approved.recordHash !== state.recordHash) return unavailableResult(fallbackUrl, 'Bluesky 任务内容哈希与原提交不同', 'invalid');
  let pds: RecordReceipt;
  try { pds = await getExactRecord(state, approved.record, dependencies, signal); }
  catch (error) {
    if (error instanceof BlueskyError && error.code === 'invalid_response') return unavailableResult(fallbackUrl, 'Bluesky PDS 记录与原文、DID、rkey 或 CID 不一致', 'invalid');
    return unavailableResult(fallbackUrl, 'Bluesky PDS 记录暂无法确认；未视为不存在');
  }
  try {
    const value = await xrpcRequest(APPVIEW_ORIGIN, 'app.bsky.feed.getPosts', {
      method: 'GET', query: [['uris', pds.uri]], signal,
    }, dependencies);
    if (!Array.isArray(value.posts) || value.posts.length !== 1 || !object(value.posts[0])) {
      return unavailableResult(pds.publicUrl, 'Bluesky AppView 尚未公开显示该记录');
    }
    const post = value.posts[0] as JsonObject;
    const author = post.author;
    if (post.uri !== pds.uri || post.cid !== pds.cid || !object(author) || author.did !== state.did
      || !object(post.record) || canonicalJson(post.record) !== canonicalJson(approved.record)) {
      return unavailableResult(pds.publicUrl, 'Bluesky AppView 记录归属、CID 或完整内容与 PDS 不一致', 'invalid');
    }
    return {
      found: true,
      outcome: 'found',
      url: pds.publicUrl,
      rel: 'unknown',
      reason: 'Bluesky PDS 完整记录与 AppView 公开可见记录一致，UTF-8 链接 facet 指向已核对选题页。',
    };
  } catch {
    return unavailableResult(pds.publicUrl, 'Bluesky AppView 暂时无法确认公开可见性');
  }
}

export const blueskyTesting = {
  approvedPost,
  canonicalJson,
  createTid,
  credentialFrom,
  graphemeLength,
  publicPostUrl,
  rawHttpsLinks,
  validState,
};
