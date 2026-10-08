import { createHash, randomUUID as cryptoRandomUUID } from 'node:crypto';
import { load } from 'cheerio';
import {
  finalizeEvent,
  generateSecretKey as nostrGenerateSecretKey,
  getEventHash,
  getPublicKey,
  nip19,
  verifyEvent,
  type Event as NostrEvent,
  type EventTemplate,
} from 'nostr-tools';
import type { Account, ExecutionContext, ExecutionResult, LinkResult, NostrReceipt, Task } from '../shared/types';
import { articleSemanticsMatch, inspectRenderedArticle } from './article-rendering';
import { fetchPublicText } from './web';

const KIND = 30_023;
const RELAYS = [
  'wss://nostr-01.yakihonne.com',
  'wss://nostr-02.yakihonne.com',
] as const;
const READER_ORIGIN = 'https://njump.me';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RELAY_MESSAGE_BYTES = 512 * 1024;
const MAX_READER_HTML_BYTES = 1_000_000;
const MAX_CONTENT_BYTES = 96 * 1024;
const MAX_TITLE_BYTES = 1_024;
const MAX_SUMMARY_BYTES = 4 * 1024;
const HEX_32 = /^[a-f0-9]{64}$/;

interface NostrSocketMessage { data: unknown }
interface NostrSocketClose { code?: number }

export interface NostrSocket {
  onopen: (() => void) | null;
  onmessage: ((event: NostrSocketMessage) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: NostrSocketClose) => void) | null;
  send(data: string): void;
  close(): void;
}

export type NostrWebSocketFactory = (url: string) => NostrSocket;
export type NostrHtmlFetcher = (url: string, signal?: AbortSignal) => Promise<{ url: string; html: string; robotsHeader?:string }>;

export interface NostrDependencies {
  webSocketFactory?: NostrWebSocketFactory;
  fetchHtml?: NostrHtmlFetcher;
  now?: () => Date | string | number;
  generateSecretKey?: () => Uint8Array;
  randomUUID?: () => string;
  timeoutMs?: number;
}

type RelayReadResult =
  | { status: 'found'; event: NostrEvent }
  | { status: 'invalid' }
  | { status: 'unknown' };

type RelayWriteResult = 'accepted' | 'rejected' | 'unknown';

export type NostrReconcileResult =
  | { status: 'found'; publicUrl: string; nostr: NostrReceipt }
  | { status: 'unknown' };

interface ApprovedArticle {
  title: string;
  summary: string;
  content: string;
  target: string;
  contentHash: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeInstant(dependencies: NostrDependencies): { date: Date; seconds: number; iso: string } {
  const supplied = dependencies.now?.();
  const date = supplied instanceof Date ? new Date(supplied.getTime())
    : supplied === undefined ? new Date()
      : new Date(supplied);
  if (!Number.isFinite(date.getTime())) throw new Error('Nostr 发布时间无效');
  const seconds = Math.floor(date.getTime() / 1_000);
  if (!Number.isSafeInteger(seconds) || seconds < 1_500_000_000) throw new Error('Nostr 发布时间无效');
  return { date, seconds, iso: date.toISOString() };
}

function canonicalHttps(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname
    || (url.port && url.port !== '443')) throw new Error('选题地址必须是公开 HTTPS 网址');
  url.hash = '';
  return url.toString();
}

function normalizedHost(input: string): string {
  return new URL(canonicalHttps(input)).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

function urlsInMarkdown(value: string): string[] {
  const matches = value.match(/https:\/\/[^\s<>{}"']+/gi) ?? [];
  return matches.map(raw => {
    let candidate = raw;
    while (/[),.;:!?\]}]$/.test(candidate)) candidate = candidate.slice(0, -1);
    try { return canonicalHttps(candidate); }
    catch { return ''; }
  }).filter(Boolean);
}

function taskArticle(task: Task, siteUrl: string): ApprovedArticle {
  if (!task.draft) throw new Error('全文草稿不完整');
  if (!task.topicUrl) throw new Error('全文草稿缺少已核对的本站选题地址');
  const target = canonicalHttps(task.topicUrl);
  if (normalizedHost(target) !== normalizedHost(siteUrl)) throw new Error('全文中的选题地址不属于当前网站');
  const title = task.draft.title.normalize('NFC').trim();
  const summary = task.draft.description.normalize('NFC').trim();
  const content = task.draft.body;
  if (title.length < 4 || Buffer.byteLength(title, 'utf8') > MAX_TITLE_BYTES
    || /[\u0000-\u001f\u007f]/.test(title)) throw new Error('全文标题不符合 Nostr 发布要求');
  if (Buffer.byteLength(summary, 'utf8') > MAX_SUMMARY_BYTES
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(summary)) throw new Error('全文摘要不符合 Nostr 发布要求');
  if (Buffer.byteLength(content, 'utf8') < 200 || Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES
    || /\u0000/.test(content)) throw new Error('全文正文不符合 Nostr 发布要求');
  if (!urlsInMarkdown(content).includes(target)) throw new Error('全文正文必须包含已核对选题页的真实 HTTPS 地址');
  return { title, summary, content, target, contentHash: sha256(content) };
}

function approvedArticle(task: Task, siteUrl: string): ApprovedArticle {
  if (!task.draft || (!task.articleApprovedAt && task.articleReview?.status !== 'passed')) {
    throw new Error('请先完成全文草稿审核');
  }
  return taskArticle(task, siteUrl);
}

function identifierFor(taskId: string): string {
  return `linkflow-${sha256(taskId).slice(0, 32)}`;
}

function eventTemplate(article: ApprovedArticle, identifier: string, createdAt: number): EventTemplate {
  const tags = [
    ['d', identifier],
    ['title', article.title],
    ...(article.summary ? [['summary', article.summary]] : []),
    ['published_at', String(createdAt)],
  ];
  return { kind: KIND, created_at: createdAt, tags, content: article.content };
}

function eventFieldsEqual(actual: NostrEvent, expected: NostrEvent): boolean {
  return actual.id === expected.id
    && actual.pubkey === expected.pubkey
    && actual.created_at === expected.created_at
    && actual.kind === expected.kind
    && actual.content === expected.content
    && actual.sig === expected.sig
    && JSON.stringify(actual.tags) === JSON.stringify(expected.tags);
}

function eventMatchesReceipt(actual: unknown, expected: Omit<NostrEvent, 'sig'> & { sig?: string }): actual is NostrEvent {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const value = actual as NostrEvent;
  try {
    return HEX_32.test(value.id) && HEX_32.test(value.pubkey) && /^[a-f0-9]{128}$/.test(value.sig)
      && verifyEvent(value)
      && value.id === expected.id
      && value.pubkey === expected.pubkey
      && value.created_at === expected.created_at
      && value.kind === expected.kind
      && value.content === expected.content
      && JSON.stringify(value.tags) === JSON.stringify(expected.tags);
  } catch { return false; }
}

function validReceipt(value: NostrReceipt | undefined, task: Task, article: ApprovedArticle): value is NostrReceipt {
  if (!value || !HEX_32.test(value.pubkey) || !HEX_32.test(value.eventId)
    || value.identifier !== identifierFor(task.id) || value.contentHash !== article.contentHash
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 1_500_000_000
    || !['submitting', 'published'].includes(value.stage)) return false;
  const template = eventTemplate(article, value.identifier, value.createdAt);
  try { return getEventHash({ ...template, pubkey: value.pubkey }) === value.eventId; }
  catch { return false; }
}

function expectedUnsignedEvent(task: Task, article: ApprovedArticle): Omit<NostrEvent, 'sig'> & { sig?: string } {
  if (!validReceipt(task.nostr, task, article)) throw new Error('Nostr 回执与原稿不一致');
  return {
    ...eventTemplate(article, task.nostr.identifier, task.nostr.createdAt),
    pubkey: task.nostr.pubkey,
    id: task.nostr.eventId,
  };
}

function naddrFor(receipt: NostrReceipt): string {
  return nip19.naddrEncode({
    kind: KIND,
    pubkey: receipt.pubkey,
    identifier: receipt.identifier,
    relays: [...RELAYS],
  });
}

function publicUrlFor(receipt: NostrReceipt): string {
  return `${READER_ORIGIN}/${naddrFor(receipt)}`;
}

function publicUrlMatches(value: string, receipt: NostrReceipt): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== READER_ORIGIN || url.username || url.password || url.search || url.hash) return false;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 1) return false;
    const decoded = nip19.decode(segments[0]);
    return decoded.type === 'naddr'
      && decoded.data.kind === KIND
      && decoded.data.pubkey === receipt.pubkey
      && decoded.data.identifier === receipt.identifier;
  } catch { return false; }
}

function socketFactory(dependencies: NostrDependencies): NostrWebSocketFactory {
  if (dependencies.webSocketFactory) return dependencies.webSocketFactory;
  const Constructor = globalThis.WebSocket;
  if (typeof Constructor !== 'function') throw new Error('当前运行环境不支持 Nostr WebSocket');
  return url => new Constructor(url) as unknown as NostrSocket;
}

function timeoutMs(dependencies: NostrDependencies): number {
  return Math.min(Math.max(dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS, 10), 30_000);
}

async function messageText(data: unknown): Promise<string | undefined> {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8') <= MAX_RELAY_MESSAGE_BYTES ? data : undefined;
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > MAX_RELAY_MESSAGE_BYTES) return undefined;
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    if (data.byteLength > MAX_RELAY_MESSAGE_BYTES) return undefined;
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    if (data.size > MAX_RELAY_MESSAGE_BYTES) return undefined;
    return await data.text();
  }
  return undefined;
}

function publishToRelay(relayUrl: typeof RELAYS[number], event: NostrEvent, signal: AbortSignal, dependencies: NostrDependencies): Promise<RelayWriteResult> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve('unknown'); return; }
    let socket: NostrSocket;
    let settled = false;
    let sent = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: RelayWriteResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      try { socket.close(); } catch { /* already closed */ }
      resolve(result);
    };
    const abort = () => finish('unknown');
    try { socket = socketFactory(dependencies)(relayUrl); }
    catch { resolve('unknown'); return; }
    timer = setTimeout(() => finish('unknown'), timeoutMs(dependencies));
    timer.unref?.();
    signal.addEventListener('abort', abort, { once: true });
    socket.onopen = () => {
      if (settled || sent || signal.aborted) return;
      sent = true;
      try { socket.send(JSON.stringify(['EVENT', event])); }
      catch { finish('unknown'); }
    };
    socket.onmessage = incoming => {
      void messageText(incoming.data).then(text => {
        if (settled || text === undefined) { finish('unknown'); return; }
        let message: unknown;
        try { message = JSON.parse(text); }
        catch { finish('unknown'); return; }
        if (!Array.isArray(message) || message[0] !== 'OK') return;
        if (message.length < 3 || message[1] !== event.id || typeof message[2] !== 'boolean') { finish('unknown'); return; }
        finish(message[2] ? 'accepted' : 'rejected');
      }, () => finish('unknown'));
    };
    socket.onerror = () => finish('unknown');
    socket.onclose = () => finish('unknown');
  });
}

function readRelayEvent(
  relayUrl: typeof RELAYS[number],
  expected: Omit<NostrEvent, 'sig'> & { sig?: string },
  signal: AbortSignal | undefined,
  dependencies: NostrDependencies,
): Promise<RelayReadResult> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve({ status: 'unknown' }); return; }
    let socket: NostrSocket;
    let settled = false;
    let sent = false;
    let timer: ReturnType<typeof setTimeout>;
    const subscription = `lf-${expected.id.slice(0, 24)}`;
    const finish = (result: RelayReadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (sent) {
        try { socket.send(JSON.stringify(['CLOSE', subscription])); } catch { /* connection already gone */ }
      }
      try { socket.close(); } catch { /* already closed */ }
      resolve(result);
    };
    const abort = () => finish({ status: 'unknown' });
    try { socket = socketFactory(dependencies)(relayUrl); }
    catch { resolve({ status: 'unknown' }); return; }
    timer = setTimeout(() => finish({ status: 'unknown' }), timeoutMs(dependencies));
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    socket.onopen = () => {
      if (settled || sent || signal?.aborted) return;
      sent = true;
      try {
        socket.send(JSON.stringify(['REQ', subscription, {
          ids: [expected.id], authors: [expected.pubkey], kinds: [KIND], '#d': [expected.tags[0][1]], limit: 1,
        }]));
      } catch { finish({ status: 'unknown' }); }
    };
    socket.onmessage = incoming => {
      void messageText(incoming.data).then(text => {
        if (settled || text === undefined) { finish({ status: 'invalid' }); return; }
        let message: unknown;
        try { message = JSON.parse(text); }
        catch { finish({ status: 'invalid' }); return; }
        if (!Array.isArray(message) || typeof message[0] !== 'string') { finish({ status: 'invalid' }); return; }
        if (message[0] === 'EOSE' && message[1] === subscription) { finish({ status: 'unknown' }); return; }
        if (message[0] === 'CLOSED' && message[1] === subscription) { finish({ status: 'unknown' }); return; }
        if (message[0] !== 'EVENT') return;
        if (message[1] !== subscription || !eventMatchesReceipt(message[2], expected)) {
          finish({ status: 'invalid' });
          return;
        }
        finish({ status: 'found', event: message[2] });
      }, () => finish({ status: 'invalid' }));
    };
    socket.onerror = () => finish({ status: 'unknown' });
    socket.onclose = () => finish({ status: 'unknown' });
  });
}

async function readExactEvent(
  expected: Omit<NostrEvent, 'sig'> & { sig?: string },
  signal: AbortSignal | undefined,
  dependencies: NostrDependencies,
): Promise<RelayReadResult> {
  const results = await Promise.all(RELAYS.map(relay => readRelayEvent(relay, expected, signal, dependencies)));
  const found = results.find((result): result is Extract<RelayReadResult, { status: 'found' }> => result.status === 'found');
  if (found) return found;
  return results.some(result => result.status === 'invalid') ? { status: 'invalid' } : { status: 'unknown' };
}

async function defaultFetchHtml(url: string, signal?: AbortSignal): Promise<{ url: string; html: string; robotsHeader?:string }> {
  const result = await fetchPublicText(url, signal, undefined, {
    allowRedirect: (_from, to) => to.origin === READER_ORIGIN,
  });
  return { url: result.url, html: result.text,robotsHeader:result.robotsHeader };
}

function unavailable(url: string, reason: string, outcome: LinkResult['outcome'] = 'unreachable'): LinkResult {
  return { found: false, outcome, url, rel: 'unknown', reason };
}

/**
 * Public verification binds one signed relay event to the fixed njump reader,
 * its embedded full EVENT JSON, and a real articleBody anchor to the reviewed
 * topic. Relay visibility alone is deliberately insufficient.
 */
export async function verifyNostrPublication(
  task: Task,
  siteUrl: string,
  signal?: AbortSignal,
  dependencies: NostrDependencies = {},
): Promise<LinkResult> {
  const fallback = task.publicUrl ?? `${READER_ORIGIN}/`;
  let receipt: NostrReceipt;
  let publicUrl: string;
  let expected: Omit<NostrEvent, 'sig'> & { sig?: string };
  let article: ApprovedArticle;
  try {
    article = taskArticle(task, siteUrl);
    expected = expectedUnsignedEvent(task, article);
    receipt = task.nostr!;
    publicUrl = publicUrlFor(receipt);
  } catch {
    return unavailable(task.publicUrl ?? fallback, 'Nostr 任务回执、原稿或选题地址无效', 'invalid');
  }
  if (task.publicUrl && !publicUrlMatches(task.publicUrl, receipt)) {
    return unavailable(task.publicUrl, 'Nostr 公开网址与原作者及文章标识不一致', 'invalid');
  }

  const relay = await readExactEvent(expected, signal, dependencies);
  if (relay.status === 'invalid') return unavailable(publicUrl, 'Nostr relay 返回的签名、事件身份或全文与原回执不一致', 'invalid');
  if (relay.status !== 'found') return unavailable(publicUrl, '固定 Nostr relay 暂未回读到原事件；不会据此重发');

  let fetched: { url: string; html: string;robotsHeader?:string };
  try { fetched = await (dependencies.fetchHtml ?? defaultFetchHtml)(publicUrl, signal); }
  catch { return unavailable(publicUrl, 'njump 暂时无法确认文章的公开静态页面'); }
  if (Buffer.byteLength(fetched.html, 'utf8') > MAX_READER_HTML_BYTES || !publicUrlMatches(fetched.url, receipt)) {
    return unavailable(fetched.url || publicUrl, 'njump 响应地址或大小不符合固定 reader 约束', 'invalid');
  }

  try {
    const rendering = inspectRenderedArticle(
      fetched.html,
      article.content,
      article.target,
      '[itemprop="articleBody"]',
      { title: article.title,pageUrl:fetched.url,robotsHeader:fetched.robotsHeader },
    );
    if (!rendering.found) {
      const reason = rendering.reason === 'body' ? 'njump 页面缺少唯一可呈现的 articleBody'
        : rendering.reason === 'semantics' ? 'njump 可呈现正文与已签名 Markdown 全文语义不一致'
          : rendering.reason === 'target' ? 'njump 公开正文未呈现指向原选题页的真实链接'
            : 'njump 静态正文无法安全解析';
      return unavailable(fetched.url, reason, 'invalid');
    }
    const $ = load(fetched.html);
    let embedded: NostrEvent | undefined;
    const candidates = $('div.whitespace-pre-wrap').toArray().slice(0, 32);
    for (const element of candidates) {
      const value = $(element).text().trim();
      if (!value || Buffer.byteLength(value, 'utf8') > MAX_RELAY_MESSAGE_BYTES) continue;
      try {
        const parsed = JSON.parse(value) as unknown;
        if (eventMatchesReceipt(parsed, expected)) { embedded = parsed; break; }
      } catch { /* unrelated reader detail block */ }
    }
    if (!embedded || !eventFieldsEqual(embedded, relay.event)) {
      return unavailable(fetched.url, 'njump 嵌入 EVENT 与固定 relay 的签名全文不一致', 'invalid');
    }
    return {
      found: true,
      outcome: 'found',
      url: fetched.url,
      rel: rendering.rel,
      reason: '固定 relay 的签名全文、njump 嵌入 EVENT 与公开 articleBody 目标链接完全一致。',
    };
  } catch {
    return unavailable(fetched.url, 'njump 静态正文无法安全解析', 'invalid');
  }
}

export async function reconcileNostrTask(
  context: ExecutionContext,
  dependencies: NostrDependencies = {},
): Promise<NostrReconcileResult> {
  const unknown = { status: 'unknown' as const };
  if (context.channel.id !== 'nostr' || context.task.channelId !== 'nostr' || !context.task.nostr
    || !context.task.submittedAt || !Number.isFinite(Date.parse(context.task.submittedAt))) return unknown;
  const account = context.getAccount();
  if (!account || account.id !== context.task.accountId || account.channelId !== 'nostr'
    || account.username !== context.task.nostr.pubkey || account.source !== 'generated') return unknown;
  const result = await verifyNostrPublication(context.task, context.site.url, context.signal, dependencies);
  if (!result.found) return unknown;
  return { status: 'found', publicUrl: result.url, nostr: { ...context.task.nostr, stage: 'published' } };
}

async function generatedIdentity(context: ExecutionContext, dependencies: NostrDependencies): Promise<Account> {
  const instant = safeInstant(dependencies);
  const secretKey = (dependencies.generateSecretKey ?? nostrGenerateSecretKey)();
  if (!(secretKey instanceof Uint8Array) || secretKey.byteLength !== 32) throw new Error('Nostr 私钥生成器返回无效数据');
  let secret = '';
  try {
    const pubkey = getPublicKey(secretKey);
    if (!HEX_32.test(pubkey)) throw new Error('Nostr 公钥生成失败');
    secret = Buffer.from(secretKey).toString('hex');
    const account: Account = {
      id: (dependencies.randomUUID ?? cryptoRandomUUID)(),
      channelId: 'nostr',
      email: context.site.publicEmail || context.site.email,
      username: pubkey,
      displayName: context.site.name || context.site.domain,
      mailboxId: context.mailbox?.id,
      createdAt: instant.iso,
      updatedAt: instant.iso,
      registeredAt: instant.iso,
      status: 'registered',
      source: 'generated',
      credentialKind: 'api_token',
      hasPassword: true,
    };
    await context.saveAccount(account, secret);
    return account;
  } finally {
    secretKey.fill(0);
    secret = '';
  }
}

async function signingKey(context: ExecutionContext, account: Account): Promise<Uint8Array | undefined> {
  let encoded: string | undefined;
  try { encoded = await context.secrets.get(`account:${account.id}`); }
  catch { return undefined; }
  if (!encoded || !HEX_32.test(encoded)) return undefined;
  const key = Uint8Array.from(Buffer.from(encoded, 'hex'));
  try {
    if (getPublicKey(key) !== account.username) { key.fill(0); return undefined; }
    return key;
  } catch { key.fill(0); return undefined; }
}

function usableAccount(account: Account | undefined, task: Task): account is Account {
  return !!account && account.channelId === 'nostr' && account.credentialKind === 'api_token'
    && account.status === 'registered' && account.hasPassword && account.source === 'generated'
    && HEX_32.test(account.username) && (!task.accountId || task.accountId === account.id);
}

export async function runNostrTask(
  context: ExecutionContext,
  dependencies: NostrDependencies = {},
): Promise<ExecutionResult> {
  if (context.channel.id !== 'nostr' || context.channel.automation !== 'api' || context.task.channelId !== 'nostr') {
    return { status: 'needs_input', message: '该渠道没有启用 Nostr NIP-23 自动发布' };
  }
  const prior = context.task.nostr;
  const remoteCheckpoint = ['nostr_publish_submitting', 'nostr_published'].includes(context.task.checkpoint ?? '');
  if (!prior && (context.task.submittedAt || context.task.publicUrl || context.task.firstLiveAt || remoteCheckpoint)) {
    return {
      status: 'needs_input', message: '已有 Nostr 提交记录但缺少完整事件身份；不会创建替代事件',
      checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt, publicUrl: context.task.publicUrl,
    };
  }
  let article: ApprovedArticle;
  try { article = prior ? taskArticle(context.task, context.site.url) : approvedArticle(context.task, context.site.url); }
  catch (error) { return { status: 'needs_input', message: error instanceof Error ? error.message : 'Nostr 全文草稿无效' }; }
  if (prior) {
    if (!validReceipt(prior, context.task, article)) {
      return { status: 'needs_input', message: '保存的 Nostr 作者、事件或全文哈希无效；不会重新广播', checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt, publicUrl: context.task.publicUrl };
    }
    const account = context.getAccount();
    if (!usableAccount(account, context.task) || account.username !== prior.pubkey) {
      return { status: 'needs_input', message: '原 Nostr 作者身份与当前网站连接不一致；不会换号重发', checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt, publicUrl: context.task.publicUrl };
    }
    const reconciled = await reconcileNostrTask(context, dependencies);
    if (reconciled.status !== 'found') {
      return { status: 'needs_input', message: 'Nostr 已有提交意图，但固定 relay 与公开 reader 尚未共同确认原事件；只会继续只读对账', checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt, publicUrl: context.task.publicUrl };
    }
    try {
      context.checkpoint({ nostr: reconciled.nostr, checkpoint: 'nostr_published', submittedAt: context.task.submittedAt, publicUrl: reconciled.publicUrl });
    } catch {
      return { status: 'review', message: 'Nostr 原事件已由 relay 与公开 reader 确认；已保留正向回执', checkpoint: 'nostr_published', submittedAt: context.task.submittedAt, publicUrl: reconciled.publicUrl };
    }
    return { status: 'review', message: 'Nostr 原事件已由固定 relay 与公开 reader 完整确认，等待外链核验', checkpoint: 'nostr_published', submittedAt: context.task.submittedAt, publicUrl: reconciled.publicUrl };
  }

  if (context.signal.aborted) return { status: 'queued', message: '任务已暂停，尚未创建 Nostr 身份或事件' };
  let account = context.getAccount();
  if (!account) {
    if (context.task.accountId) return { status: 'needs_input', message: '任务绑定的 Nostr 身份已不存在；不会生成替代作者' };
    try { account = await generatedIdentity(context, dependencies); }
    catch { return { status: 'failed', message: '无法在本机保险箱中创建 Nostr 作者身份，尚未广播事件' }; }
  }
  if (!usableAccount(account, context.task)) {
    return { status: 'needs_input', message: '当前 Nostr 作者身份不可用；不会自动换号发布' };
  }
  const key = await signingKey(context, account);
  if (!key) return { status: 'needs_input', message: '本机保险箱中的 Nostr 作者私钥缺失或与原公钥不一致；不会生成替代身份' };

  const instant = safeInstant(dependencies);
  const identifier = identifierFor(context.task.id);
  let event: NostrEvent;
  try {
    event = finalizeEvent(eventTemplate(article, identifier, instant.seconds), key);
  } finally {
    key.fill(0);
  }
  if (!verifyEvent(event) || event.pubkey !== account.username) {
    return { status: 'failed', message: '本机未能生成可验证的 Nostr 签名事件，尚未广播' };
  }
  const receipt: NostrReceipt = {
    pubkey: event.pubkey,
    eventId: event.id,
    identifier,
    contentHash: article.contentHash,
    createdAt: event.created_at,
    stage: 'submitting',
  };
  try {
    context.checkpoint({
      accountId: account.id,
      draft: context.task.draft,
      nostr: receipt,
      checkpoint: 'nostr_publish_submitting',
      submittedAt: instant.iso,
    });
  } catch {
    return { status: 'queued', message: 'Nostr 事件尚未广播；任务状态已改变' };
  }
  if (context.signal.aborted) {
    return { status: 'needs_input', message: 'Nostr 写前意图已保存；暂停后只会只读核对，不会广播替代事件', checkpoint: 'nostr_publish_submitting', submittedAt: instant.iso };
  }

  await Promise.all(RELAYS.map(relay => publishToRelay(relay, event, context.signal, dependencies)));
  const publicUrl = publicUrlFor(receipt);
  const verificationTask: Task = {
    ...context.task,
    accountId: account.id,
    nostr: receipt,
    submittedAt: instant.iso,
    checkpoint: 'nostr_publish_submitting',
  };
  const verified = await verifyNostrPublication(verificationTask, context.site.url, context.signal, dependencies);
  if (!verified.found) {
    return {
      status: 'needs_input',
      message: 'Nostr 广播结果尚未同时通过固定 relay 与公开 reader 核验；只会继续只读对账，不会再次发送 EVENT',
      checkpoint: 'nostr_publish_submitting', submittedAt: instant.iso,
    };
  }

  const published: NostrReceipt = { ...receipt, stage: 'published' };
  try {
    context.checkpoint({ nostr: published, checkpoint: 'nostr_published', submittedAt: instant.iso, publicUrl });
  } catch {
    return { status: 'review', message: 'Nostr 事件已由 relay 与公开 reader 确认；暂停后保留同一事件回执', checkpoint: 'nostr_published', submittedAt: instant.iso, publicUrl };
  }
  return {
    status: 'review',
    message: 'Nostr NIP-23 全文已由固定 relay 与公开 reader 完整确认，等待外链核验',
    checkpoint: 'nostr_published', submittedAt: instant.iso, publicUrl,
  };
}

export const nostrTesting = {
  RELAYS,
  READER_ORIGIN,
  approvedArticle,
  articleSemanticsMatch,
  eventTemplate,
  identifierFor,
  naddrFor,
  publicUrlFor,
  publicUrlMatches,
};
