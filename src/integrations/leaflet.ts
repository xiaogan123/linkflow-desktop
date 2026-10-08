import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import { marked } from 'marked';
import { articleReviewStillValid } from '../main/article-review';
import type {
  Account, AccountDiagnostic, ExecutionContext, ExecutionResult, LeafletReceipt, LinkResult, SecretStore, Task,
} from '../shared/types';
import { inspectRenderedArticle } from './article-rendering';
import { applyDeclaredArticleVisibility, styleConcealsArticle } from './article-visibility';
export type { LeafletReceipt } from '../shared/types';

const CHANNEL_ID = 'leaflet';
const SOURCE_DOMAIN = 'leaflet.pub';
const PDS_ORIGIN = 'https://bsky.social';
const PUBLIC_ORIGIN = 'https://leaflet.pub';
const COLLECTION = 'site.standard.document';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_RECORD_BYTES = 90 * 1024;
const MAX_BODY_BYTES = 72 * 1024;

export interface LeafletDependencies {
  fetch?: LeafletTransport;
  now?: () => Date | string;
  randomBytes?: (size: number) => Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type LeafletTransport = (input: string, init: RequestInit) => Promise<Response>;
export interface LeafletExecutionResult extends ExecutionResult { leaflet?: LeafletReceipt }
export type LeafletReconcileResult =
  | { status: 'found'; publicUrl: string; uri: string; cid: string; leaflet: LeafletReceipt }
  | { status: 'unknown' };

type JsonObject = Record<string, unknown>;
type LeafletTask = Task & { leaflet?: LeafletReceipt };

interface Session {
  accessJwt: string;
  refreshJwt: string;
  handle: string;
  did: string;
}

interface StoredCredential extends Session {
  version: 1;
  appPassword: string;
}

interface BuiltArticle {
  title: string;
  description: string;
  markdown: string;
  target: string;
  links: string[];
  record: JsonObject;
  recordHash: string;
}

interface RemoteReceipt { uri: string; cid: string; publicUrl: string }

export type LeafletErrorCode =
  | 'auth' | 'restricted' | 'rate_limited' | 'timeout' | 'network' | 'cancelled'
  | 'rejected' | 'not_found' | 'invalid_response';

export class LeafletError extends Error {
  readonly code: LeafletErrorCode;

  constructor(code: LeafletErrorCode) {
    super(`Leaflet request failed (${code})`);
    this.name = 'LeafletError';
    this.code = code;
  }
}

const credentialLocks = new Map<string, Promise<void>>();

function object(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stamp(dependencies?: LeafletDependencies): string {
  const supplied = dependencies?.now?.();
  const date = supplied instanceof Date ? supplied : typeof supplied === 'string' ? new Date(supplied) : new Date();
  return (Number.isFinite(date.getTime()) ? date : new Date()).toISOString();
}

function transport(dependencies?: LeafletDependencies): LeafletTransport {
  return dependencies?.fetch ?? ((input, init) => fetch(input, init));
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

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validDid(value: unknown): value is string {
  return typeof value === 'string' && /^did:(?:plc|web):[A-Za-z0-9:._%-]{1,240}$/.test(value);
}

function validTid(value: unknown): value is string {
  return typeof value === 'string' && /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(value);
}

function validCid(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9]{8,200}$/.test(value);
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && Buffer.byteLength(value, 'utf8') <= MAX_TOKEN_BYTES
    && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function validHandle(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 253 || value !== value.toLowerCase()) return false;
  const labels = value.split('.');
  return labels.length >= 2 && labels.every((label, index) => label.length >= 1 && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    && (index !== labels.length - 1 || /[a-z]/.test(label)));
}

function normalizeHandle(value: string): string {
  const handle = value.trim().replace(/^@/, '').toLowerCase();
  if (!validHandle(handle)) throw new Error('Bluesky handle 格式无效');
  return handle;
}

function validAppPassword(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]{4}(?:-[a-z0-9]{4}){3}$/i.test(value);
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function graphemeLength(value: string): number {
  return typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length
    : Array.from(value).length;
}

function canonicalHttps(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname
    || url.port && url.port !== '443') throw new Error('网址必须是无凭据、端口和片段的 HTTPS 地址');
  return url.toString();
}

function profileUrl(did: string): string {
  if (!validDid(did)) throw new Error('Leaflet DID 无效');
  return `${PUBLIC_ORIGIN}/p/${did}`;
}

function publicUrl(did: string, rkey: string): string {
  if (!validDid(did) || !validTid(rkey)) throw new Error('Leaflet DID 或 rkey 无效');
  return `${profileUrl(did)}/${rkey}`;
}

function expectedUri(did: string, rkey: string): string {
  return `at://${did}/${COLLECTION}/${rkey}`;
}

function createTid(dependencies?: LeafletDependencies): string {
  const instant = new Date(stamp(dependencies));
  const random = dependencies?.randomBytes?.(2) ?? cryptoRandomBytes(2);
  if (!(random instanceof Uint8Array) || random.byteLength !== 2) throw new Error('Leaflet rkey 随机源无效');
  const clockId = ((random[0] << 8) | random[1]) & 0x3ff;
  let value = (BigInt(instant.getTime()) * 1_000n << 10n) | BigInt(clockId);
  const alphabet = '234567abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let index = 0; index < 13; index++) {
    result = alphabet[Number(value & 31n)] + result;
    value >>= 5n;
  }
  if (!validTid(result)) throw new Error('Leaflet rkey 生成失败');
  return result;
}

function deterministicPageId(did: string, rkey: string, createdAt: string): string {
  const hex = sha256(`${did}\u0000${rkey}\u0000${createdAt}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function normalizeVisibleText(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function canonicalTarget(task: Task, siteUrl: string): string {
  if (!task.topicUrl) throw new Error('Leaflet 长文缺少已核对的站内选题链接');
  const site = new URL(canonicalHttps(siteUrl));
  const target = canonicalHttps(task.topicUrl);
  if (new URL(target).hostname !== site.hostname) throw new Error('Leaflet 长文只能链接当前网站的已核对选题');
  return target;
}

function inlinePlaintext($: CheerioAPI, root: Cheerio<any>): { plaintext: string; facets?: JsonObject[]; links: string[] } {
  let plaintext = '';
  const facets: JsonObject[] = [];
  const links: string[] = [];
  const visit = (node: unknown): void => {
    const value = node as { type?: string; data?: string; name?: string; tagName?: string; children?: unknown[]; attribs?: Record<string, string> };
    if (value.type === 'text') { plaintext += value.data ?? ''; return; }
    const name = (value.name ?? value.tagName ?? '').toLowerCase();
    if (name === 'br') { plaintext += '\n'; return; }
    if (name === 'img') throw new Error('Leaflet 自动全文暂不接受 Markdown 图片；请改为可核验的文字与链接');
    if (name === 'a') {
      const href = canonicalHttps(value.attribs?.href ?? '');
      const start = Buffer.byteLength(plaintext, 'utf8');
      for (const child of value.children ?? []) visit(child);
      const end = Buffer.byteLength(plaintext, 'utf8');
      if (end <= start) throw new Error('Leaflet 链接必须有可见文字');
      facets.push({
        index: { byteStart: start, byteEnd: end },
        features: [{ $type: 'pub.leaflet.richtext.facet#link', uri: href }],
      });
      links.push(href);
      return;
    }
    for (const child of value.children ?? []) visit(child);
  };
  for (const node of root.contents().toArray()) visit(node);
  if (!normalizeVisibleText(plaintext)) throw new Error('Leaflet 段落不能为空');
  return { plaintext, ...(facets.length ? { facets } : {}), links };
}

function textBlock(inline: { plaintext: string; facets?: JsonObject[] }): JsonObject {
  return { $type: 'pub.leaflet.blocks.text', plaintext: inline.plaintext,
    ...(inline.facets ? { facets: inline.facets } : {}) };
}

function listBlock(
  $: CheerioAPI,
  element: any,
  depth = 0,
): { block: JsonObject; links: string[]; text: string[] } {
  if (depth > 4) throw new Error('Leaflet Markdown 列表嵌套不能超过四层');
  const ordered = ((element.tagName ?? element.name ?? '') as string).toLowerCase() === 'ol';
  const namespace = ordered ? 'pub.leaflet.blocks.orderedList' : 'pub.leaflet.blocks.unorderedList';
  const items = $(element).children('li').toArray();
  if (!items.length) throw new Error('Leaflet Markdown 列表不能为空');
  const children: JsonObject[] = [];
  const links: string[] = [];
  const text: string[] = [];
  for (const item of items) {
    const nested = $(item).children('ul,ol').toArray();
    if (nested.length > 1) throw new Error('Leaflet 单个列表项只能包含一个嵌套列表');
    const content = $(item).clone();
    content.children('ul,ol').remove();
    const inputs = content.find('input').toArray();
    if (inputs.some(input => ($(input).attr('type') ?? '').toLowerCase() !== 'checkbox') || inputs.length > 1) {
      throw new Error('Leaflet 列表项包含不支持的表单控件');
    }
    const checked = inputs.length ? $(inputs[0]).attr('checked') !== undefined : undefined;
    content.find('input').remove();
    if (content.children('p').length > 1) throw new Error('Leaflet 列表项不能包含多个松散段落');
    const inline = inlinePlaintext($, content);
    links.push(...inline.links);
    text.push(inline.plaintext);
    const child: JsonObject = {
      $type: `${namespace}#listItem`,
      ...(checked === undefined ? {} : { checked }),
      content: textBlock(inline),
    };
    if (nested[0]) {
      const parsed = listBlock($, nested[0], depth + 1);
      links.push(...parsed.links);
      text.push(...parsed.text);
      const nestedOrdered = (((nested[0] as any).tagName ?? (nested[0] as any).name ?? '') as string).toLowerCase() === 'ol';
      if (ordered === nestedOrdered) {
        if (parsed.block.startIndex !== undefined) throw new Error('Leaflet 同类型嵌套有序列表只能从 1 开始');
        child.children = (parsed.block.children as JsonObject[]);
      }
      else child[ordered ? 'unorderedListChildren' : 'orderedListChildren'] = parsed.block;
    }
    children.push(child);
  }
  const start = ordered ? Number.parseInt($(element).attr('start') ?? '1', 10) : undefined;
  if (ordered && (!Number.isSafeInteger(start) || start! < 1)) throw new Error('Leaflet 有序列表起始编号无效');
  return { block: { $type: namespace, ...(ordered && start !== 1 ? { startIndex: start } : {}), children }, links, text };
}

function blockquoteBlock($: CheerioAPI, element: any): { block: JsonObject; links: string[]; text: string } {
  const children = $(element).children().toArray();
  if (!children.length || children.some(child => {
    const tag = ((child as { tagName?: string; name?: string }).tagName
      ?? (child as { name?: string }).name ?? '').toLowerCase();
    return tag !== 'p';
  })) throw new Error('Leaflet 引用只支持普通 Markdown 段落');
  const holder = $('<p></p>');
  children.forEach((child, index) => {
    if (index) holder.append('<br>');
    for (const content of $(child).contents().toArray()) holder.append($(content).clone());
  });
  const inline = inlinePlaintext($, holder);
  return { block: { $type: 'pub.leaflet.blocks.blockquote', plaintext: inline.plaintext,
    ...(inline.facets ? { facets: inline.facets } : {}) }, links: inline.links, text: inline.plaintext };
}

function codeBlock($: CheerioAPI, element: any): { block: JsonObject; text: string } {
  const children = $(element).children().toArray();
  if (children.length !== 1) throw new Error('Leaflet 代码块结构无效');
  const code = $(children[0]);
  const tag = (((children[0] as { tagName?: string; name?: string }).tagName
    ?? (children[0] as { name?: string }).name) ?? '').toLowerCase();
  if (tag !== 'code' || code.children().length) throw new Error('Leaflet 代码块结构无效');
  const plaintext = code.text();
  if (!normalizeVisibleText(plaintext)) throw new Error('Leaflet 代码块不能为空');
  const languageClass = (code.attr('class') ?? '').split(/\s+/)
    .find(value => value.startsWith('language-'));
  const language = languageClass?.slice('language-'.length);
  if (language !== undefined && !/^[A-Za-z0-9_+.#-]{1,64}$/.test(language)) {
    throw new Error('Leaflet 代码块语言标记无效');
  }
  return { block: { $type: 'pub.leaflet.blocks.code', plaintext, ...(language ? { language } : {}) }, text: plaintext };
}

function containsRawHtmlToken(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRawHtmlToken);
  if (!object(value)) return false;
  if (value.type === 'html') return true;
  return Object.values(value).some(containsRawHtmlToken);
}

function markdownBlocks(markdown: string): { blocks: JsonObject[]; links: string[]; textContent: string } {
  if (!markdown.trim() || Buffer.byteLength(markdown, 'utf8') > MAX_BODY_BYTES
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(markdown)) {
    throw new Error('Leaflet 长文为空、过大或包含不支持的控制字符');
  }
  if (containsRawHtmlToken(marked.lexer(markdown, { gfm: true }))) {
    throw new Error('Leaflet 自动全文不接受原始 HTML');
  }
  const rendered = marked.parse(markdown, { async: false, gfm: true });
  if (typeof rendered !== 'string') throw new Error('Leaflet Markdown 无法解析');
  const $ = load(rendered, undefined, false);
  if ($('script,style,template,iframe,object,embed,img').length) throw new Error('Leaflet Markdown 包含不支持的 HTML 或媒体');
  if ($('del,strike').length) throw new Error('Leaflet 官方文本块不保留删除线语义；请改写为明确的当前状态');
  const blocks: JsonObject[] = [];
  const links: string[] = [];
  const text: string[] = [];
  for (const element of $.root().children().toArray()) {
    const tag = (element as { tagName?: string; name?: string }).tagName ?? (element as { name?: string }).name ?? '';
    if (tag === 'ul' || tag === 'ol') {
      const parsed = listBlock($, element);
      links.push(...parsed.links);
      text.push(...parsed.text);
      blocks.push({ $type: 'pub.leaflet.pages.linearDocument#block', block: parsed.block });
      continue;
    }
    if (tag === 'table') {
      throw new Error('Leaflet 官方记录没有表格块；请把表格改写为段落或列表');
    }
    if (tag === 'blockquote') {
      const parsed = blockquoteBlock($, element);
      links.push(...parsed.links);
      text.push(parsed.text);
      blocks.push({ $type: 'pub.leaflet.pages.linearDocument#block', block: parsed.block });
      continue;
    }
    if (tag === 'pre') {
      const parsed = codeBlock($, element);
      text.push(parsed.text);
      blocks.push({ $type: 'pub.leaflet.pages.linearDocument#block', block: parsed.block });
      continue;
    }
    if (tag === 'hr') {
      blocks.push({ $type: 'pub.leaflet.pages.linearDocument#block',
        block: { $type: 'pub.leaflet.blocks.horizontalRule' } });
      continue;
    }
    if (!/^(?:p|h[1-6])$/.test(tag)) {
      throw new Error('Leaflet Markdown 包含尚未支持的块结构');
    }
    const inline = inlinePlaintext($, $(element));
    links.push(...inline.links);
    text.push(inline.plaintext);
    const block: JsonObject = /^h[1-6]$/.test(tag)
      ? { $type: 'pub.leaflet.blocks.header', level: Number(tag.slice(1)), plaintext: inline.plaintext,
        ...(inline.facets ? { facets: inline.facets } : {}) }
      : textBlock(inline);
    blocks.push({ $type: 'pub.leaflet.pages.linearDocument#block', block });
  }
  if (!blocks.length) throw new Error('Leaflet 长文没有可发布段落');
  return { blocks, links, textContent: text.join('\n\n') };
}

function buildArticle(task: Task, siteUrl: string, did: string, rkey: string, createdAt: string): BuiltArticle {
  const draft = task.draft;
  if (!draft || !draft.title.trim() || !draft.body.trim()) throw new Error('Leaflet 长文标题或正文为空');
  const title = normalizeVisibleText(draft.title);
  const description = normalizeVisibleText(draft.description ?? '');
  if (graphemeLength(title) > 500 || Buffer.byteLength(title, 'utf8') > 5_000) throw new Error('Leaflet 标题超过官方上限');
  if (graphemeLength(description) > 3_000 || Buffer.byteLength(description, 'utf8') > 30_000) {
    throw new Error('Leaflet 摘要超过官方上限');
  }
  if (!validDid(did) || !validTid(rkey) || !validIso(createdAt)) throw new Error('Leaflet 发布身份无效');
  const target = canonicalTarget(task, siteUrl);
  const parsed = markdownBlocks(draft.body);
  if (!parsed.links.includes(target)) throw new Error('Leaflet 长文必须包含已核对选题的可见链接');
  const page = {
    id: deterministicPageId(did, rkey, createdAt),
    $type: 'pub.leaflet.pages.linearDocument',
    blocks: parsed.blocks,
  };
  const record: JsonObject = {
    $type: COLLECTION,
    site: profileUrl(did),
    path: `/${rkey}`,
    title,
    ...(description ? { description } : {}),
    publishedAt: createdAt,
    updatedAt: createdAt,
    contributors: [{ did, role: 'author' }],
    textContent: `${title}\n\n${parsed.textContent}`,
    content: { $type: 'pub.leaflet.content', pages: [page] },
  };
  const serialized = canonicalJson(record);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) throw new Error('Leaflet ATProto 记录超过安全大小上限');
  return { title, description, markdown: draft.body, target, links: parsed.links, record, recordHash: sha256(serialized) };
}

export function leafletRecordHash(task: Task, siteUrl: string, did: string, rkey: string, recordCreatedAt: string): string {
  return buildArticle(task, siteUrl, did, rkey, recordCreatedAt).recordHash;
}

async function withCredentialLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const ready = (credentialLocks.get(key) ?? Promise.resolve()).catch(() => undefined);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const tail = ready.then(() => held);
  credentialLocks.set(key, tail);
  await ready;
  try { return await operation(); }
  finally {
    release();
    if (credentialLocks.get(key) === tail) credentialLocks.delete(key);
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const advertised = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(advertised) && advertised > maxBytes) throw new LeafletError('invalid_response');
  if (!response.body) throw new LeafletError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new LeafletError('invalid_response');
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function request(
  url: URL,
  init: RequestInit,
  dependencies: LeafletDependencies,
  maxBytes: number,
): Promise<{ response: Response; bytes: Uint8Array }> {
  const external = init.signal ?? dependencies.signal;
  if (external?.aborted) throw new LeafletError('cancelled');
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(external?.reason);
  external?.addEventListener('abort', abort, { once: true });
  const timeoutMs = Math.min(Math.max(dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS, 10), 30_000);
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
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
      if (external?.aborted) throw new LeafletError('cancelled');
      if (timedOut) throw new LeafletError('timeout');
      throw new LeafletError('network');
    }
    if (response.redirected) throw new LeafletError('invalid_response');
    if (response.url) {
      try { if (new URL(response.url).toString() !== url.toString()) throw new Error('mismatch'); }
      catch { throw new LeafletError('invalid_response'); }
    }
    return { response, bytes: await readBounded(response, maxBytes) };
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', abort);
  }
}

async function xrpc(
  nsid: 'com.atproto.server.createSession' | 'com.atproto.server.refreshSession'
    | 'com.atproto.repo.createRecord' | 'com.atproto.repo.getRecord',
  options: { method: 'GET' | 'POST'; token?: string; body?: JsonObject; query?: Array<[string, string]>; signal?: AbortSignal },
  dependencies: LeafletDependencies,
): Promise<JsonObject> {
  const allowed = options.method === 'POST'
    ? ['com.atproto.server.createSession', 'com.atproto.server.refreshSession', 'com.atproto.repo.createRecord'].includes(nsid)
    : nsid === 'com.atproto.repo.getRecord';
  if (!allowed || options.token !== undefined && !validToken(options.token)) throw new LeafletError('invalid_response');
  const url = new URL(`/xrpc/${nsid}`, PDS_ORIGIN);
  for (const [key, value] of options.query ?? []) url.searchParams.append(key, value);
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'Linkflow-Desktop' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body) headers['content-type'] = 'application/json';
  const { response, bytes } = await request(url, {
    method: options.method, headers, body: options.body ? JSON.stringify(options.body) : undefined, signal: options.signal,
  }, dependencies, MAX_JSON_BYTES);
  let value: JsonObject | undefined;
  try {
    if (response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      if (object(parsed)) value = parsed;
    }
  } catch { /* Status mapping below does not trust malformed error bodies. */ }
  if (response.ok && value) return value;
  if (response.ok) throw new LeafletError('invalid_response');
  const remoteCode = typeof value?.error === 'string' ? value.error : '';
  if (response.status === 401 || remoteCode === 'InvalidToken' || remoteCode === 'ExpiredToken'
    || nsid === 'com.atproto.server.createSession' && response.status === 400) throw new LeafletError('auth');
  if (response.status === 403 || remoteCode === 'AccountTakedown') throw new LeafletError('restricted');
  if (response.status === 404 || remoteCode === 'RecordNotFound') throw new LeafletError('not_found');
  if (response.status === 429) throw new LeafletError('rate_limited');
  if (response.status === 408 || response.status >= 500) throw new LeafletError('network');
  if ([400, 409, 422].includes(response.status)) throw new LeafletError('rejected');
  throw new LeafletError('invalid_response');
}

function sessionFrom(value: JsonObject): Session {
  if (!validToken(value.accessJwt) || !validToken(value.refreshJwt) || !validHandle(value.handle) || !validDid(value.did)) {
    throw new LeafletError('invalid_response');
  }
  if (value.active === false || ['takendown', 'suspended', 'deactivated'].includes(String(value.status ?? '').toLowerCase())) {
    throw new LeafletError('restricted');
  }
  return { accessJwt: value.accessJwt, refreshJwt: value.refreshJwt, handle: value.handle, did: value.did };
}

function credentialFrom(value: unknown): StoredCredential {
  let parsed = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_BYTES) throw new LeafletError('auth');
    try { parsed = JSON.parse(value); } catch { throw new LeafletError('auth'); }
  }
  if (!object(parsed) || parsed.version !== 1 || !validAppPassword(parsed.appPassword)) throw new LeafletError('auth');
  return { version: 1, appPassword: parsed.appPassword, ...sessionFrom(parsed) };
}

function serializeCredential(value: StoredCredential): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CREDENTIAL_BYTES) throw new LeafletError('invalid_response');
  return serialized;
}

async function createSession(handle: string, appPassword: string, dependencies: LeafletDependencies): Promise<Session> {
  const session = sessionFrom(await xrpc('com.atproto.server.createSession', {
    method: 'POST', body: { identifier: handle, password: appPassword }, signal: dependencies.signal,
  }, dependencies));
  if (session.handle !== handle) throw new LeafletError('auth');
  return session;
}

async function refreshSession(refreshJwt: string, dependencies: LeafletDependencies): Promise<Session> {
  return sessionFrom(await xrpc('com.atproto.server.refreshSession', {
    method: 'POST', token: refreshJwt, signal: dependencies.signal,
  }, dependencies));
}

export async function connectLeafletAccount(
  vault: SecretStore,
  accountId: string,
  handleInput: string,
  appPassword: string,
  dependencies: LeafletDependencies = {},
): Promise<{ username: string; did: string; publicationUrl: string }> {
  const handle = normalizeHandle(handleInput);
  if (!validAppPassword(appPassword)) throw new Error('请使用 Bluesky 设置中创建的应用专用密码；不接受主密码');
  return await withCredentialLock(`account:${accountId}`, async () => {
    const priorRaw = await vault.get(`account:${accountId}`);
    const prior = priorRaw ? credentialFrom(priorRaw) : undefined;
    const session = await createSession(handle, appPassword, dependencies);
    if (prior && (prior.did !== session.did || prior.handle !== session.handle)) {
      throw new Error('Leaflet 重连身份与原 DID/handle 不一致，未替换本机凭据');
    }
    const credential: StoredCredential = { version: 1, appPassword, ...session };
    await vault.set(`account:${accountId}`, serializeCredential(credential));
    return { username: handle, did: session.did, publicationUrl: profileUrl(session.did) };
  });
}

async function refreshedCredential(
  secrets: SecretStore,
  account: Account,
  expectedDid: string,
  dependencies: LeafletDependencies,
): Promise<StoredCredential> {
  return await withCredentialLock(`account:${account.id}`, async () => {
    const raw = await secrets.get(`account:${account.id}`);
    if (!raw) throw new LeafletError('auth');
    const stored = credentialFrom(raw);
    if (stored.did !== expectedDid || stored.handle !== account.username) throw new LeafletError('auth');
    let session: Session;
    try { session = await refreshSession(stored.refreshJwt, dependencies); }
    catch (error) {
      if (!(error instanceof LeafletError) || error.code !== 'auth') throw error;
      session = await createSession(stored.handle, stored.appPassword, dependencies);
    }
    if (session.did !== expectedDid || session.handle !== stored.handle) throw new LeafletError('auth');
    const updated: StoredCredential = { version: 1, appPassword: stored.appPassword, ...session };
    await secrets.set(`account:${account.id}`, serializeCredential(updated));
    return updated;
  });
}

function didFromProfile(value: string | undefined): string | undefined {
  if (!value) return;
  const match = /^https:\/\/leaflet\.pub\/p\/(did:(?:plc|web):[A-Za-z0-9:._%-]{1,240})$/.exec(value);
  return match && validDid(match[1]) ? match[1] : undefined;
}

function exactAccount(context: ExecutionContext, account: Account | undefined): account is Account {
  if (!account || account.id !== context.task.accountId || account.channelId !== CHANNEL_ID
    || account.credentialKind !== 'api_token' || account.status !== 'registered' || !account.hasPassword
    || !validHandle(account.username)) return false;
  return !!didFromProfile(account.publicationUrl);
}

function validReceipt(value: LeafletReceipt | undefined): value is LeafletReceipt {
  if (!value || !validDid(value.did) || !validTid(value.rkey) || !validHash(value.recordHash)
    || !validIso(value.recordCreatedAt) || !['creating', 'published'].includes(value.stage)) return false;
  if ((value.uri === undefined) !== (value.cid === undefined)) return false;
  if (value.uri !== undefined && (value.uri !== expectedUri(value.did, value.rkey) || !validCid(value.cid))) return false;
  if (value.url !== undefined && value.url !== publicUrl(value.did, value.rkey)) return false;
  return value.stage !== 'published' || !!value.uri && !!value.cid && value.url === publicUrl(value.did, value.rkey);
}

function remoteReceipt(value: JsonObject, did: string, rkey: string): RemoteReceipt {
  const uri = expectedUri(did, rkey);
  if (value.uri !== uri || !validCid(value.cid)) throw new LeafletError('invalid_response');
  return { uri, cid: value.cid, publicUrl: publicUrl(did, rkey) };
}

async function getExactRecord(
  receipt: LeafletReceipt,
  record: JsonObject,
  dependencies: LeafletDependencies,
  signal?: AbortSignal,
): Promise<RemoteReceipt> {
  const value = await xrpc('com.atproto.repo.getRecord', {
    method: 'GET', query: [['repo', receipt.did], ['collection', COLLECTION], ['rkey', receipt.rkey]], signal,
  }, dependencies);
  const remote = remoteReceipt(value, receipt.did, receipt.rkey);
  if (receipt.uri && receipt.uri !== remote.uri || receipt.cid && receipt.cid !== remote.cid
    || !object(value.value) || canonicalJson(value.value) !== canonicalJson(record)) {
    throw new LeafletError('invalid_response');
  }
  return remote;
}

function taskReceipt(task: Task): LeafletReceipt | undefined {
  return (task as LeafletTask).leaflet;
}

function checkpoint(context: ExecutionContext, partial: Record<string, unknown>): void {
  context.checkpoint(partial as Partial<Task>);
}

function diagnostic(code: AccountDiagnostic['code'], message: string, dependencies: LeafletDependencies): AccountDiagnostic {
  return { code, message, at: stamp(dependencies), retryable: false };
}

async function markAccountFailure(
  context: ExecutionContext,
  account: Account,
  error: unknown,
  dependencies: LeafletDependencies,
): Promise<void> {
  if (!(error instanceof LeafletError) || !['auth', 'restricted'].includes(error.code)) return;
  const restricted = error.code === 'restricted';
  await context.saveAccount({ ...account, status: restricted ? 'restricted' : 'credentials_invalid',
    diagnostic: diagnostic(restricted ? 'restricted' : 'bad_password', restricted
      ? 'Leaflet 使用的 Bluesky 账号或发布权限已受限。'
      : 'Leaflet 应用专用密码或会话已失效；请重连原 DID。', dependencies), updatedAt: stamp(dependencies) });
}

function unavailable(url: string, outcome: LinkResult['outcome'], reason: string): LinkResult {
  return { found: false, outcome, url, rel: 'unknown', reason };
}

function blocksIndexing(value: string): boolean {
  return /(?:^|[,;\s])(?:noindex|none)(?=$|[,;\s])/i.test(value);
}

export async function reconcileLeafletTask(
  context: ExecutionContext,
  dependencies: LeafletDependencies = {},
): Promise<LeafletReconcileResult> {
  const unknown = { status: 'unknown' as const };
  const receipt = taskReceipt(context.task);
  const account = context.getAccount();
  if (context.channel.id !== CHANNEL_ID || context.channel.automation !== 'api' || context.task.channelId !== CHANNEL_ID
    || context.task.sourceDomain !== SOURCE_DOMAIN || !validReceipt(receipt) || !exactAccount(context, account)
    || didFromProfile(account.publicationUrl) !== receipt.did
    || context.task.publicUrl && context.task.publicUrl !== publicUrl(receipt.did, receipt.rkey)) return unknown;
  let article: BuiltArticle;
  try { article = buildArticle(context.task, context.site.url, receipt.did, receipt.rkey, receipt.recordCreatedAt); }
  catch { return unknown; }
  if (article.recordHash !== receipt.recordHash || context.signal.aborted) return unknown;
  try {
    const remote = await getExactRecord(receipt, article.record, dependencies, context.signal);
    const published: LeafletReceipt = { ...receipt, stage: 'published', uri: remote.uri, cid: remote.cid, url: remote.publicUrl };
    return { status: 'found', ...remote, leaflet: published };
  } catch { return unknown; }
}

function firstRunFailure(error: unknown): LeafletExecutionResult {
  if (error instanceof LeafletError && error.code === 'cancelled') return { status: 'queued', message: 'Leaflet 任务已暂停，尚未提交记录' };
  if (error instanceof LeafletError && ['network', 'timeout', 'rate_limited'].includes(error.code)) {
    return { status: 'queued', message: 'Leaflet 身份刷新暂未完成，尚未提交记录' };
  }
  if (error instanceof LeafletError && error.code === 'restricted') {
    return { status: 'needs_input', message: 'Leaflet 使用的 Bluesky 账号或发布权限受限，未提交记录' };
  }
  return { status: 'needs_input', message: 'Leaflet 应用专用密码、原 DID 或本机绑定无效，未提交记录' };
}

export async function runLeafletTask(
  context: ExecutionContext,
  dependencies: LeafletDependencies = {},
): Promise<LeafletExecutionResult> {
  if (context.channel.id !== CHANNEL_ID || context.channel.automation !== 'api'
    || context.task.channelId !== CHANNEL_ID || context.task.sourceDomain !== SOURCE_DOMAIN) {
    return { status: 'needs_input', message: '当前任务没有启用 Leaflet ATProto 自动化' };
  }
  const account = context.getAccount();
  if (!exactAccount(context, account)) return { status: 'needs_input', message: '请先为 Leaflet 单独连接已有 Bluesky 账号并绑定网站' };
  const accountDid = didFromProfile(account.publicationUrl)!;
  const prior = taskReceipt(context.task);
  const remoteCheckpoint = ['leaflet_create_submitting', 'leaflet_create_accepted', 'leaflet_published'].includes(context.task.checkpoint ?? '');
  if (!prior && (context.task.submittedAt || context.task.publicUrl || context.task.firstLiveAt || remoteCheckpoint)) {
    return { status: 'needs_input', message: 'Leaflet 已有远端痕迹但缺少 DID/rkey 回执，禁止创建替代记录',
      checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt, publicUrl: context.task.publicUrl };
  }
  if (prior && (!validReceipt(prior) || prior.did !== accountDid)) {
    return { status: 'needs_input', message: 'Leaflet 保存的 DID、rkey 或回执无效；不会重新发布',
      leaflet: prior, checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt, publicUrl: context.task.publicUrl };
  }
  if (prior && context.task.publicUrl && context.task.publicUrl !== publicUrl(prior.did, prior.rkey)) {
    return { status: 'needs_input', message: 'Leaflet 公开地址与原 DID/rkey 不一致；保留原记录并停止操作',
      leaflet: prior, checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt, publicUrl: context.task.publicUrl };
  }

  if (prior) {
    let article: BuiltArticle;
    try { article = buildArticle(context.task, context.site.url, prior.did, prior.rkey, prior.recordCreatedAt); }
    catch (error) {
      return { status: 'needs_input', message: error instanceof Error ? error.message : 'Leaflet 原文无法安全对账',
        leaflet: prior, checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt,
        publicUrl: context.task.publicUrl };
    }
    if (article.recordHash !== prior.recordHash) {
      return { status: 'needs_input', message: 'Leaflet 原稿、作者或链接已与提交意图不同；保留原 rkey 且不会重发',
        leaflet: prior, checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt,
        publicUrl: context.task.publicUrl };
    }
    const reconciled = await reconcileLeafletTask(context, dependencies);
    if (reconciled.status !== 'found') {
      return { status: 'review', message: 'Leaflet 原 DID/rkey 暂未回读到完全相同记录；只会继续只读核验，不会重发',
        leaflet: prior, checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt,
        publicUrl: context.task.publicUrl };
    }
    checkpoint(context, { leaflet: reconciled.leaflet, checkpoint: 'leaflet_published', publicUrl: reconciled.publicUrl,
      submittedAt: context.task.submittedAt });
    return { status: 'review', message: 'Leaflet PDS 完整记录已确认，等待公开页缓存与可见性核验',
      leaflet: reconciled.leaflet, checkpoint: 'leaflet_published', publicUrl: reconciled.publicUrl,
      submittedAt: context.task.submittedAt };
  }

  if (!articleReviewStillValid(context.task, context.site, context.channel, context.settings, account)) {
    return { status: 'needs_input', message: 'Leaflet 长文的事实、链接与渠道独立 AI 核对未通过或已失效' };
  }
  if (context.signal.aborted) return { status: 'queued', message: 'Leaflet 任务已暂停，尚未提交记录' };

  let credential: StoredCredential;
  try {
    credential = await refreshedCredential(context.secrets, account, accountDid, { ...dependencies, signal: context.signal });
    await context.saveAccount({ ...account, displayName: `@${credential.handle}`, status: 'registered',
      verifiedAt: stamp(dependencies), lastUsedAt: stamp(dependencies), updatedAt: stamp(dependencies), diagnostic: undefined });
  } catch (error) {
    await markAccountFailure(context, account, error, dependencies);
    return firstRunFailure(error);
  }
  if (!articleReviewStillValid(context.task, context.site, context.channel, context.settings, account)) {
    return { status: 'needs_input', message: 'Leaflet 长文在身份核对期间发生变更，未提交记录' };
  }

  const recordCreatedAt = stamp(dependencies);
  const rkey = createTid(dependencies);
  let article: BuiltArticle;
  try { article = buildArticle(context.task, context.site.url, credential.did, rkey, recordCreatedAt); }
  catch (error) { return { status: 'needs_input', message: error instanceof Error ? error.message : 'Leaflet 长文无法转换为安全记录' }; }
  const submittedAt = recordCreatedAt;
  let receipt: LeafletReceipt = { did: credential.did, rkey, recordHash: article.recordHash, recordCreatedAt,
    stage: 'creating', url: publicUrl(credential.did, rkey) };
  try {
    checkpoint(context, { leaflet: receipt, checkpoint: 'leaflet_create_submitting', submittedAt, draft: context.task.draft });
  } catch {
    return { status: 'queued', message: 'Leaflet 提交意图未持久保存，未发送 createRecord' };
  }

  let accepted: RemoteReceipt;
  try {
    const value = await xrpc('com.atproto.repo.createRecord', {
      method: 'POST', token: credential.accessJwt, signal: context.signal,
      body: { repo: credential.did, collection: COLLECTION, rkey, validate: false, record: article.record },
    }, dependencies);
    accepted = remoteReceipt(value, credential.did, rkey);
  } catch (error) {
    await markAccountFailure(context, account, error, dependencies);
    return { status: 'review', message: 'Leaflet createRecord 结果无法确认；已锁定原 DID/rkey，后续只读核验且不会重发',
      leaflet: receipt, checkpoint: 'leaflet_create_submitting', submittedAt };
  }

  receipt = { ...receipt, uri: accepted.uri, cid: accepted.cid };
  try {
    checkpoint(context, { leaflet: receipt, checkpoint: 'leaflet_create_accepted', submittedAt, publicUrl: accepted.publicUrl });
  } catch {
    return { status: 'review', message: 'Leaflet 已返回 DID/rkey/CID；待保存匹配回执后只读核验，不会重发',
      leaflet: receipt, checkpoint: 'leaflet_create_submitting', submittedAt, publicUrl: accepted.publicUrl };
  }
  if (context.signal.aborted) {
    return { status: 'review', message: 'Leaflet 已返回发布回执；暂停后只会核验原 DID/rkey',
      leaflet: receipt, checkpoint: 'leaflet_create_accepted', submittedAt, publicUrl: accepted.publicUrl };
  }
  let found: RemoteReceipt | undefined;
  try { found = await getExactRecord(receipt, article.record, dependencies, context.signal); }
  catch { /* App/PDS read lag leaves the accepted identity durable for later recovery. */ }
  if (!found) {
    return { status: 'review', message: 'Leaflet 已返回发布回执，完整 PDS 记录仍待只读核验；不会重发',
      leaflet: receipt, checkpoint: 'leaflet_create_accepted', submittedAt };
  }
  const published: LeafletReceipt = { ...receipt, stage: 'published', uri: found.uri, cid: found.cid, url: found.publicUrl };
  checkpoint(context, { leaflet: published, checkpoint: 'leaflet_published', submittedAt, publicUrl: found.publicUrl });
  return { status: 'review', message: 'Leaflet PDS 完整记录已确认，等待公开页缓存与可见性核验',
    leaflet: published, checkpoint: 'leaflet_published', submittedAt, publicUrl: found.publicUrl };
}

function hiddenElement($: CheerioAPI, element: unknown): boolean {
  let node = element as { parent?: unknown; attribs?: Record<string, string>; name?: string; tagName?: string } | undefined;
  while (node) {
    const attributes = node.attribs ?? {};
    const name = (node.name ?? node.tagName ?? '').toLowerCase();
    const classes = new Set((attributes.class ?? '').split(/\s+/).filter(Boolean));
    if (['script', 'style', 'template', 'noscript'].includes(name)
      || Object.prototype.hasOwnProperty.call(attributes, 'hidden')
      || attributes['aria-hidden']?.toLowerCase() === 'true'
      || ['hidden', 'invisible', 'collapse', 'sr-only'].some(value => classes.has(value))
      || styleConcealsArticle(attributes.style ?? '')) return true;
    node = node.parent as typeof node;
  }
  return false;
}

function exactPublicPage(html: string, headers: Headers, article: BuiltArticle, receipt: LeafletReceipt): { rel: string } | undefined {
  if (blocksIndexing(headers.get('x-robots-tag') ?? '')) return;
  const url = publicUrl(receipt.did, receipt.rkey);
  const $ = load(html);
  applyDeclaredArticleVisibility($);
  const robots = $('meta[name]').toArray().some(element => ['robots', 'googlebot', 'bingbot']
    .includes(($(element).attr('name') ?? '').trim().toLowerCase())
    && blocksIndexing($(element).attr('content') ?? ''));
  if (robots) return;
  const canonicals = $('link[rel~="canonical"][href]').toArray();
  if (canonicals.length !== 1 || $(canonicals[0]).attr('href') !== url) return;
  const atCanonical = $('meta[name="at:canonical"][content]').toArray();
  if (atCanonical.length !== 1 || $(atCanonical[0]).attr('content') !== expectedUri(receipt.did, receipt.rkey)) return;
  const structuredAuthor = $('script[type="application/ld+json"]').toArray().some(element => {
    try {
      const value = JSON.parse($(element).text()) as unknown;
      if (!object(value) || value['@type'] !== 'BlogPosting' || value.headline !== article.title
        || value.url !== url || value.mainEntityOfPage !== url) return false;
      const authors = Array.isArray(value.author) ? value.author : [value.author];
      return authors.some(author => object(author) && author.url === profileUrl(receipt.did));
    } catch { return false; }
  });
  if (!structuredAuthor) return;
  const titles = $('.postTitle').toArray().filter(element => !hiddenElement($, element));
  if (titles.length !== 1 || normalizeVisibleText($(titles[0]).text()) !== article.title) return;
  const rendered = inspectRenderedArticle(html, article.markdown, article.target, '.postContent',{pageUrl:url,robotsHeader:headers.get('x-robots-tag')??''});
  if (!rendered.found) return;
  const bodies = $('.postContent').toArray().filter(element => !hiddenElement($, element));
  if (bodies.length !== 1) return;
  const actualLinks: string[] = [];
  for (const anchor of $(bodies[0]).find('a[href]').toArray()) {
    if (hiddenElement($, anchor) || !normalizeVisibleText($(anchor).text())) return;
    try { actualLinks.push(canonicalHttps($(anchor).attr('href') ?? '')); }
    catch { return; }
  }
  if (canonicalJson(actualLinks) !== canonicalJson(article.links)) return;
  return { rel: rendered.rel };
}

async function publicPage(
  receipt: LeafletReceipt,
  article: BuiltArticle,
  dependencies: LeafletDependencies,
): Promise<{ rel: string }> {
  const url = new URL(publicUrl(receipt.did, receipt.rkey));
  const { response, bytes } = await request(url, {
    method: 'GET', headers: { accept: 'text/html', 'user-agent': 'Linkflow-Desktop' }, signal: dependencies.signal,
  }, dependencies, MAX_HTML_BYTES);
  if (response.status === 404) throw new LeafletError('not_found');
  if (response.status === 429) throw new LeafletError('rate_limited');
  if (response.status >= 500) throw new LeafletError('network');
  if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
    throw new LeafletError('invalid_response');
  }
  let html: string;
  try { html = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new LeafletError('invalid_response'); }
  const result = exactPublicPage(html, response.headers, article, receipt);
  if (!result) throw new LeafletError('invalid_response');
  return result;
}

export async function verifyLeafletPublication(
  task: Task,
  targetSiteUrl: string,
  dependencies: LeafletDependencies = {},
): Promise<LinkResult> {
  const receipt = taskReceipt(task);
  const fallback = task.publicUrl ?? (receipt && validDid(receipt.did) && validTid(receipt.rkey)
    ? publicUrl(receipt.did, receipt.rkey) : `${PUBLIC_ORIGIN}/`);
  if (task.channelId !== CHANNEL_ID || task.sourceDomain !== SOURCE_DOMAIN || !validReceipt(receipt)
    || receipt.stage !== 'published' || task.publicUrl !== publicUrl(receipt.did, receipt.rkey)) {
    return unavailable(fallback, 'invalid', 'Leaflet 任务缺少一致的已发布 DID/rkey/CID 回执');
  }
  let article: BuiltArticle;
  try { article = buildArticle(task, targetSiteUrl, receipt.did, receipt.rkey, receipt.recordCreatedAt); }
  catch { return unavailable(fallback, 'invalid', 'Leaflet 原文、作者或链接无法与回执匹配'); }
  if (article.recordHash !== receipt.recordHash) return unavailable(fallback, 'invalid', 'Leaflet 原文记录哈希与回执不一致');
  try {
    await getExactRecord(receipt, article.record, dependencies, dependencies.signal);
  } catch (error) {
    if (error instanceof LeafletError && error.code === 'invalid_response') {
      return unavailable(fallback, 'invalid', 'Leaflet PDS 原记录的作者、全文、链接或 CID 与回执不一致');
    }
    return unavailable(fallback, 'unreachable', 'Leaflet PDS 原记录暂无法确认；未视为不存在');
  }
  try {
    const page = await publicPage(receipt, article, dependencies);
    return { found: true, outcome: 'found', url: fallback, rel: page.rel,
      reason: 'Leaflet PDS 原记录与公开页的作者、标题、完整正文、全部链接及 canonical 一致；这不保证搜索收录或排名' };
  } catch (error) {
    if (error instanceof LeafletError && error.code === 'invalid_response') {
      return unavailable(fallback, 'invalid', 'Leaflet 公开页的 canonical、可见标题、完整正文、全部链接或索引状态无效');
    }
    // Externally-created records are not actively revalidated by Leaflet and
    // can remain behind a cached 404 for up to one hour. Never report absent.
    return unavailable(fallback, 'unreachable', 'Leaflet 公开页暂未可见或仍在缓存；只会重查原 DID/rkey，不会重发');
  }
}

export const leafletTesting = {
  buildArticle,
  canonicalJson,
  createTid,
  credentialFrom,
  exactPublicPage,
  expectedUri,
  profileUrl,
  publicUrl,
  validReceipt,
};
