import { randomUUID } from 'node:crypto';
import {load} from 'cheerio';
import {fetchPublicText,type PublicFetchDependencies} from './web';
import {inspectRenderedArticle} from './article-rendering';
import {applyDeclaredArticleVisibility,elementConcealed} from './article-visibility';
import type { Account, AccountDiagnostic, ExecutionContext, ExecutionResult, Task,LinkResult } from '../shared/types';

const API_ORIGIN = 'https://api.telegra.ph';
const PUBLIC_ORIGIN = 'https://telegra.ph';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CONTENT_BYTES = 64 * 1024;
const MIN_ARTICLE_CHARACTERS = 500;
const MIN_ARTICLE_BLOCKS = 3;
const RECONCILE_LIST_PAGE_SIZE = 50;
const RECONCILE_MAX_LIST_PAGES = 2;
const RECONCILE_MAX_PAGES = RECONCILE_LIST_PAGE_SIZE * RECONCILE_MAX_LIST_PAGES;
const RECONCILE_MAX_TITLE_CANDIDATES = 8;

type TelegraphTag = 'a' | 'blockquote' | 'h3' | 'h4' | 'hr' | 'li' | 'ol' | 'p' | 'pre' | 'ul';
export type TelegraphNode = string | { tag: TelegraphTag; attrs?: { href: string }; children?: TelegraphNode[] };
export type TelegraphTransport = (input: string, init: RequestInit) => Promise<Response>;
export type TelegraphReconcileResult = { status: 'found'; publicUrl: string } | { status: 'unknown' };
export interface TelegraphReconcileDependencies { transport?: TelegraphTransport }
export interface TelegraphVerificationDependencies extends TelegraphReconcileDependencies {publicFetch?:PublicFetchDependencies}

type ApiSuccess = Record<string, unknown>;
type ApiResponse = { ok: boolean; result?: unknown; error?: unknown };
type AccountWithCredential = Account & { credentialKind: 'api_token' };

class TelegraphApiRejection extends Error {
  constructor(readonly code: string) { super(`Telegraph API rejected the request: ${code}`); }
}

class TelegraphUncertainError extends Error {
  constructor(readonly phase: 'account' | 'publish' | 'read') { super(`Telegraph ${phase} result is uncertain`); }
}

function now(): string { return new Date().toISOString(); }
function diagnostic(code: AccountDiagnostic['code'], message: string): AccountDiagnostic {
  return { code, message, at: now(), retryable: false };
}

function safeApiCode(value: unknown): string {
  if (typeof value !== 'string') return 'UNKNOWN_API_ERROR';
  const code = value.trim().toUpperCase().replace(/[^A-Z0-9_ -]/g, '').slice(0, 80);
  return code || 'UNKNOWN_API_ERROR';
}

function mustContinue(context: ExecutionContext): void {
  if (context.signal.aborted) throw new TelegraphUncertainError('read');
}

async function readBoundedJson(response: Response): Promise<ApiResponse> {
  const length = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('response_too_large');
  if (!response.body) throw new Error('empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error('response_too_large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as ApiResponse).ok !== 'boolean') throw new Error('invalid_response');
  return parsed as ApiResponse;
}

async function apiCall(
  method: 'createAccount' | 'getAccountInfo' | 'createPage' | 'getPage' | 'getPageList',
  fields: Record<string, string>,
  context: ExecutionContext,
  transport: TelegraphTransport,
  path?: string,
): Promise<ApiSuccess> {
  mustContinue(context);
  const controller = new AbortController();
  const abort = () => controller.abort(context.signal.reason);
  context.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('request_timeout')), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  const suffix = path ? `/${encodeURIComponent(path)}` : '';
  const url = `${API_ORIGIN}/${method}${suffix}`;
  let response: Response | undefined;
  try {
    response = await transport(url, {
      method: 'POST',
      body: new URLSearchParams(fields),
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (response.redirected || response.url && !response.url.startsWith(`${API_ORIGIN}/`)) throw new Error('redirected_response');
    if (!response.ok) throw new Error('http_error');
    const body = await readBoundedJson(response);
    if (!body.ok) throw new TelegraphApiRejection(safeApiCode(body.error));
    if (!body.result || typeof body.result !== 'object' || Array.isArray(body.result)) throw new Error('invalid_result');
    return body.result as ApiSuccess;
  } catch (error) {
    // Keep uncertain-write handling while releasing rejected response bodies.
    controller.abort();
    void response?.body?.cancel().catch(() => undefined);
    if (error instanceof TelegraphApiRejection) throw error;
    throw new TelegraphUncertainError(method === 'createAccount' ? 'account' : method === 'createPage' ? 'publish' : 'read');
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener('abort', abort);
  }
}

function canonicalTelegraphContent(value: unknown): string | undefined {
  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') return node.normalize('NFC');
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('invalid_node');
    const raw = node as Record<string, unknown>;
    if (Object.keys(raw).some(key => !['tag', 'attrs', 'children'].includes(key))) throw new Error('invalid_node');
    if (typeof raw.tag !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(raw.tag)) throw new Error('invalid_node');
    const normalized: { tag: string; attrs?: Record<string, string>; children?: unknown[] } = { tag: raw.tag };
    if (raw.attrs !== undefined) {
      if (!raw.attrs || typeof raw.attrs !== 'object' || Array.isArray(raw.attrs)) throw new Error('invalid_node');
      const attrs = raw.attrs as Record<string, unknown>;
      const keys = Object.keys(attrs).sort();
      if (keys.some(key => !['href', 'src'].includes(key))) throw new Error('invalid_node');
      const clean: Record<string, string> = {};
      for (const key of keys) {
        if (typeof attrs[key] !== 'string') throw new Error('invalid_node');
        clean[key] = attrs[key].normalize('NFC');
      }
      if (keys.length) normalized.attrs = clean;
    }
    if (raw.children !== undefined) {
      if (!Array.isArray(raw.children)) throw new Error('invalid_node');
      const children = raw.children.map(visit);
      if (children.length) normalized.children = children;
    }
    return normalized;
  };
  try {
    if (!Array.isArray(value)) return undefined;
    return JSON.stringify(value.map(visit));
  } catch { return undefined; }
}

function sourceUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('网站来源地址必须是不含凭据的 HTTPS 网址');
  url.hash = '';
  return url.toString();
}

function plainInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/gi, '')
    .replace(/https?:\/\/[^\s)\]}]+/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)[*_~`]([^*_~`]+)[*_~`]($|\s)/g, '$1$2$3')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function promotionalAuthorName(language: string): string {
  return language.toLowerCase().startsWith('zh') ? '推广内容发布者' : 'Promotional content publisher';
}

function articleBlocks(body: string): Array<{ tag: 'p' | 'h3' | 'h4' | 'blockquote' | 'pre'; text: string }> {
  const normalized = body.replace(/\r\n?/g, '\n');
  const blocks: Array<{ tag: 'p' | 'h3' | 'h4' | 'blockquote' | 'pre'; text: string }> = [];
  const prose: string[] = [];
  const flushProse = () => {
    if (!prose.length) return;
    const raw = prose.join('\n');
    prose.length = 0;
    blocks.push(...raw.split(/\n\s*\n+/).map(part => {
      const collapsed = part.split('\n').map(line => line.trim()).filter(Boolean).join(' ');
      if (/^#{1,2}\s+/.test(collapsed)) return { tag: 'h3' as const, text: collapsed.replace(/^#{1,2}\s+/, '').trim() };
      if (/^#{3,6}\s+/.test(collapsed)) return { tag: 'h4' as const, text: collapsed.replace(/^#{3,6}\s+/, '').trim() };
      if (/^>\s+/.test(collapsed)) return { tag: 'blockquote' as const, text: collapsed.replace(/^>\s+/, '').trim() };
      return { tag: 'p' as const, text: collapsed.replace(/^(?:[-*+] |\d+[.)] )/gm, '').trim() };
    }).filter(block => block.text.length > 0));
  };
  const lines = normalized.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const opening = lines[index].match(/^\s*(`{3,}|~{3,})(?:[A-Za-z0-9_+.-]+)?\s*$/);
    if (!opening) { prose.push(lines[index]); continue; }
    flushProse();
    const marker = opening[1][0];
    const width = opening[1].length;
    const code: string[] = [];
    index++;
    for (; index < lines.length; index++) {
      if (new RegExp(`^\\s*${marker}{${width},}\\s*$`).test(lines[index])) break;
      code.push(lines[index]);
    }
    const text = code.join('\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/^\n+|\n+$/g, '');
    if (text) blocks.push({ tag: 'pre', text });
  }
  flushProse();
  return blocks;
}

function safeCitationUrl(value: string): string | undefined {
  const raw = value.trim();
  if (!raw || raw.length > 2_048 || /[\u0000-\u0020\u007f]/.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || (url.port && url.port !== '443')) return undefined;
    url.hash = '';
    return url.toString();
  } catch { return undefined; }
}

function sameTargetSite(value: string, target: string): boolean {
  try {
    const host = (url: string) => new URL(url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return host(value) === host(target);
  } catch { return false; }
}

function cleanInlineText(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)[*_~`]([^*_~`]+)[*_~`]($|\s)/g, '$1$2$3')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ');
}

function pushText(nodes: TelegraphNode[], value: string): void {
  if (!value) return;
  const previous = nodes.at(-1);
  if (typeof previous === 'string') nodes[nodes.length - 1] = previous + value;
  else nodes.push(value);
}

function appendRawHttps(nodes: TelegraphNode[], value: string, target: string): void {
  const pattern = /https:\/\/[^\s<>()\[\]{}"']+/gi;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    pushText(nodes, value.slice(cursor, start));
    let raw = match[0];
    let punctuation = '';
    while (/[.,;:!?]$/.test(raw)) { punctuation = raw.slice(-1) + punctuation; raw = raw.slice(0, -1); }
    const safe = safeCitationUrl(raw);
    if (!safe) pushText(nodes, raw);
    else if (!sameTargetSite(safe, target)) nodes.push({ tag: 'a', attrs: { href: safe }, children: [raw] });
    pushText(nodes, punctuation);
    cursor = start + match[0].length;
  }
  pushText(nodes, value.slice(cursor));
}

function inlineNodes(value: string, target: string): TelegraphNode[] {
  const clean = cleanInlineText(value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'));
  const nodes: TelegraphNode[] = [];
  const markdownLink = /\[([^\]\n]{1,500})\]\(([^)\n]{1,2048})\)/g;
  let cursor = 0;
  for (const match of clean.matchAll(markdownLink)) {
    const start = match.index ?? 0;
    appendRawHttps(nodes, clean.slice(cursor, start), target);
    const label = cleanInlineText(match[1]).trim();
    const rawHref = match[2].trim();
    const safe = safeCitationUrl(rawHref);
    if (safe && !sameTargetSite(safe, target)) nodes.push({ tag: 'a', attrs: { href: safe }, children: [label || safe] });
    else if (safe) pushText(nodes, label);
    else pushText(nodes, `${label}${label ? ' ' : ''}(${rawHref})`);
    cursor = start + match[0].length;
  }
  appendRawHttps(nodes, clean.slice(cursor), target);
  return nodes.filter(node => typeof node !== 'string' || node.length > 0);
}

export function articleToTelegraphNodes(body: string, siteName: string, siteUrl: string, language = 'en'): TelegraphNode[] {
  const blocks = articleBlocks(body);
  const characters = blocks.reduce((sum, block) => sum + block.text.replace(/\s/g, '').length, 0);
  if (characters < MIN_ARTICLE_CHARACTERS || blocks.length < MIN_ARTICLE_BLOCKS) {
    throw new Error(`文章需要至少 ${MIN_ARTICLE_CHARACTERS} 个非空白字符和 ${MIN_ARTICLE_BLOCKS} 个正文段落`);
  }
  const name = plainInline(siteName).slice(0, 120);
  if (!name) throw new Error('网站名称不可为空');
  const href = sourceUrl(siteUrl);
  const source: TelegraphNode = language.toLowerCase().startsWith('zh')
    ? { tag: 'p', children: ['文中所述网站：', { tag: 'a', attrs: { href }, children: [name] }, '。'] }
    : { tag: 'p', children: ['Website discussed: ', { tag: 'a', attrs: { href }, children: [name] }, '.'] };
  const nodes: TelegraphNode[] = blocks.map(block => block.tag === 'pre'
    ? { tag: 'pre', children: [block.text] }
    : { tag: block.tag, children: inlineNodes(block.text, href) });
  nodes.push({ tag: 'hr' }, source);
  if (Buffer.byteLength(JSON.stringify(nodes), 'utf8') > MAX_CONTENT_BYTES) throw new Error('文章超出 Telegraph 64 KB 内容上限');
  return nodes;
}

// Read-only fingerprint for pages submitted before the author-label correction.
// Never use this content or label in createAccount/createPage requests.
function priorTelegraphFingerprint(body: string, siteName: string, siteUrl: string, language: string): { author: string; content: string } | undefined {
  const nodes = articleToTelegraphNodes(body, siteName, siteUrl, language);
  const name = plainInline(siteName).slice(0, 120);
  const href = sourceUrl(siteUrl);
  nodes[nodes.length - 1] = language.toLowerCase().startsWith('zh')
    ? { tag: 'p', children: ['作者披露：本文由该网站的所有者或运营方发布，文中主体为 ', name, '。官方来源：', { tag: 'a', attrs: { href }, children: [name] }, '。'] }
    : { tag: 'p', children: ['Author disclosure: Published by the owner or operator of ', name, '. Official source: ', { tag: 'a', attrs: { href }, children: [name] }, '.'] };
  const content = canonicalTelegraphContent(nodes);
  return content ? { author: `${plainInline(siteName).slice(0, 108)} site owner`.slice(0, 128).normalize('NFC'), content } : undefined;
}

function countTargetLinks(nodes: unknown, target: string): number {
  if (Array.isArray(nodes)) return nodes.reduce((sum, node) => sum + countTargetLinks(node, target), 0);
  if (!nodes || typeof nodes !== 'object') return 0;
  const node = nodes as { tag?: unknown; attrs?: unknown; children?: unknown };
  let count = 0;
  if (node.tag === 'a' && node.attrs && typeof node.attrs === 'object' && (node.attrs as { href?: unknown }).href === target) count++;
  return count + countTargetLinks(node.children, target);
}

function pageIdentity(result: ApiSuccess): { path: string; url: string } | undefined {
  if (typeof result.path !== 'string' || typeof result.url !== 'string') return undefined;
  if (!result.path || result.path.length > 512 || /[\u0000-\u001f\u007f/\\?#]/.test(result.path) || result.path === '.' || result.path === '..') return undefined;
  try {
    const url = new URL(result.url);
    if (url.origin !== PUBLIC_ORIGIN || url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/') || url.pathname.slice(1).includes('/')) return undefined;
    if (decodeURIComponent(url.pathname.slice(1)) !== result.path) return undefined;
    return { path: result.path, url: url.toString() };
  } catch { return undefined; }
}

function accountBlock(account: Account | undefined, task: Task): ExecutionResult | undefined {
  if (task.publicUrl || task.submittedAt || ['telegraph_publish_submitting', 'telegraph_publish_uncertain', 'telegraph_published'].includes(task.checkpoint ?? '')) {
    return { status: 'review', message: '此任务已发起发布，只核验原结果，不会重复发文', publicUrl: task.publicUrl, checkpoint: task.checkpoint, submittedAt: task.submittedAt };
  }
  if (['telegraph_account_create_pending', 'account_registration_submitted'].includes(task.checkpoint ?? '')) {
    if (account?.status === 'registered' && account.hasPassword && account.credentialKind === 'api_token') return undefined;
    return { status: 'needs_input', message: 'Telegraph 账号创建结果待确认，不会自动创建新令牌', checkpoint: 'account_registration_submitted' };
  }
  if (!account) return undefined;
  if (account.status === 'restricted') return { status: 'needs_input', message: 'Telegraph 账号或访问已受限，已停止自动操作' };
  if (account.status === 'credentials_invalid') return { status: 'needs_input', message: 'Telegraph 访问令牌不可用，请人工更新账号凭据' };
  if (account.status === 'unknown') return { status: 'needs_input', message: 'Telegraph 账号状态无法确认，不会自动创建替代账号' };
  if (account.status === 'needs_verification') return { status: 'needs_input', message: 'Telegraph 账号需要人工确认后才能继续' };
  return undefined;
}

function accountFailure(code: string): { status: 'credentials_invalid' | 'restricted' | 'unknown'; diagnostic: AccountDiagnostic; message: string } {
  if (/ACCESS_TOKEN_INVALID|ACCESS_TOKEN_REQUIRED|AUTH_KEY_INVALID/.test(code)) {
    return { status: 'credentials_invalid', diagnostic: diagnostic('bad_password', 'Telegraph 拒绝了已保存的访问令牌。'), message: 'Telegraph 访问令牌不可用，请人工更新凭据' };
  }
  if (/FLOOD|BLOCK|BANNED|DENIED|RESTRICT/.test(code)) {
    return { status: 'restricted', diagnostic: diagnostic('restricted', 'Telegraph 报告账号或访问受到限制。'), message: 'Telegraph 报告账号或访问受限，已停止自动操作' };
  }
  return { status: 'unknown', diagnostic: diagnostic('registration_failed', 'Telegraph API 拒绝了请求，账号状态未安全确认。'), message: 'Telegraph 账号状态待确认，已停止自动操作' };
}

async function markAccountFailure(context: ExecutionContext, account: Account, code: string): Promise<ExecutionResult> {
  const failure = accountFailure(code);
  await context.saveAccount({ ...account, status: failure.status, diagnostic: failure.diagnostic });
  return { status: 'needs_input', message: failure.message, checkpoint: context.task.checkpoint };
}

async function createAccount(context: ExecutionContext, transport: TelegraphTransport, draft?: AccountWithCredential): Promise<{ account: AccountWithCredential; token: string } | ExecutionResult> {
  const createdAt = now();
  const shortName = plainInline(context.site.name || context.site.domain).slice(0, 32) || 'Linkflow site';
  const account: AccountWithCredential = draft ?? {
    id: randomUUID(), channelId: context.channel.id, email: context.site.publicEmail||context.site.email,mailboxId:context.mailbox?.id, username: shortName,
    createdAt, updatedAt: createdAt, status: 'draft', source: 'generated', registrationAttempts: 0,
    hasPassword: false, credentialKind: 'api_token',
  };
  const pending: AccountWithCredential = {
    ...account,
    status: 'unknown',
    registrationAttempts: 1,
    updatedAt: createdAt,
    diagnostic: diagnostic('registration_unknown', 'Telegraph 账号创建即将提交；在返回令牌前不会创建替代账号。'),
  };
  await context.saveAccount(pending);
  context.checkpoint({ checkpoint: 'telegraph_account_create_pending' });
  try {
    const result = await apiCall('createAccount', { short_name: shortName, author_name: promotionalAuthorName(context.site.language) }, context, transport);
    if (typeof result.access_token !== 'string' || result.access_token.length < 20 || result.access_token.length > 256) throw new TelegraphUncertainError('account');
    const registeredAt = now();
    const registered: AccountWithCredential = { ...pending, status: 'registered', hasPassword: true, registeredAt, lastUsedAt: registeredAt, updatedAt: registeredAt, diagnostic: undefined };
    await context.saveAccount(registered, result.access_token);
    try { context.checkpoint({ checkpoint: 'telegraph_account_registered' }); }
    catch {
      return { status: 'queued', message: 'Telegraph 访问令牌已安全保存，恢复后将核验并复用该账号', checkpoint: 'telegraph_account_create_pending' };
    }
    return { account: registered, token: result.access_token };
  } catch (error) {
    const restricted = error instanceof TelegraphApiRejection && /FLOOD|BLOCK|BANNED|DENIED|RESTRICT/.test(error.code);
    const status = restricted ? 'restricted' as const : 'unknown' as const;
    const message = restricted ? 'Telegraph 报告账号创建受限，不会重试或生成新令牌' : 'Telegraph 账号创建结果无法确认，不会重试或生成新令牌';
    await context.saveAccount({ ...pending, status, diagnostic: diagnostic(restricted ? 'restricted' : 'registration_unknown', message) });
    context.checkpoint({ checkpoint: 'account_registration_submitted' });
    return { status: 'needs_input', message, checkpoint: 'account_registration_submitted' };
  }
}

async function existingAccount(context: ExecutionContext, account: Account, transport: TelegraphTransport): Promise<{ account: Account; token: string } | ExecutionResult> {
  const token = await context.secrets.get(`account:${account.id}`);
  if (!token) {
    await context.saveAccount({ ...account, status: 'credentials_invalid', hasPassword: false, diagnostic: diagnostic('password_missing', '本机保险箱中没有 Telegraph 访问令牌。') });
    return { status: 'needs_input', message: '本机保险箱中没有 Telegraph 访问令牌' };
  }
  try {
    const result = await apiCall('getAccountInfo', { access_token: token, fields: JSON.stringify(['short_name', 'page_count']) }, context, transport);
    if (typeof result.short_name !== 'string') throw new TelegraphUncertainError('read');
    const usedAt = now();
    const verified = { ...account, status: 'registered' as const, lastUsedAt: usedAt, updatedAt: usedAt, diagnostic: undefined };
    await context.saveAccount(verified);
    return { account: verified, token };
  } catch (error) {
    if (error instanceof TelegraphApiRejection) return markAccountFailure(context, account, error.code);
    return { status: 'failed', message: 'Telegraph 账号验证暂时失败，尚未发布文章' };
  }
}

async function verifyPage(context: ExecutionContext, path: string, expectedUrl: string, target: string, transport: TelegraphTransport): Promise<boolean> {
  try {
    const result = await apiCall('getPage', { return_content: 'true' }, context, transport, path);
    const identity = pageIdentity(result);
    return !!identity && identity.url === expectedUrl && Array.isArray(result.content) && countTargetLinks(result.content, target) === 1;
  } catch { return false; }
}

function nodesHtml(nodes:TelegraphNode[]):string{
  const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
  return nodes.map(node=>typeof node==='string'?escape(node):`<${node.tag}${node.attrs?` href="${escape(node.attrs.href)}"`:''}>${nodesHtml(node.children??[])}</${node.tag}>`).join('');
}

/** Rechecks the exact originally emitted article, including supported historical attribution. */
export async function verifyTelegraphPublication(context:ExecutionContext,dependencies:TelegraphVerificationDependencies={}):Promise<LinkResult>{
  const fallback=context.task.publicUrl??PUBLIC_ORIGIN;
  const fail=(outcome:LinkResult['outcome'],reason:string):LinkResult=>({found:false,outcome,url:fallback,rel:'unknown',reason});
  let identity:{path:string;url:string},title:string,target:string,fingerprints:Array<{author:string;content:string}>;
  try{
    const url=new URL(fallback),parsed=pageIdentity({path:decodeURIComponent(url.pathname.slice(1)),url:fallback});
    if(context.task.channelId!=='telegraph'||context.task.sourceDomain!=='telegra.ph'||!context.task.draft||!parsed)throw Error();
    identity=parsed;target=sourceUrl(context.site.url);title=plainInline(context.task.draft.title).slice(0,256).normalize('NFC');
    const content=canonicalTelegraphContent(articleToTelegraphNodes(context.task.draft.body,context.site.name,target,context.site.language));
    const prior=priorTelegraphFingerprint(context.task.draft.body,context.site.name,target,context.site.language);
    if(!content||!prior||title.length<4)throw Error();
    fingerprints=[{author:promotionalAuthorName(context.site.language).normalize('NFC'),content},prior];
  }catch{return fail('invalid','Telegraph 原稿或公开地址无效，保留原记录且不会重发');}
  try{
    const remote=await apiCall('getPage',{return_content:'true'},context,dependencies.transport??fetch,identity.path);
    const remoteIdentity=pageIdentity(remote),content=canonicalTelegraphContent(remote.content);
    const matched=fingerprints.find(value=>value.content===content&&value.author===remote.author_name);
    if(!remoteIdentity||remoteIdentity.url!==identity.url||remote.title!==title||!matched)return fail('invalid','Telegraph API 的完整正文、作者标记或标题与原稿不一致');
    const page=await fetchPublicText(identity.url,context.signal,dependencies.publicFetch,{allowRedirect:(_from,to)=>to.href===identity.url});
    const $=load(page.text);applyDeclaredArticleVisibility($);
    const article=$('article.tl_article_content'),heading=article.children('h1').first(),byline=article.children('address');
    if(page.url!==identity.url||article.length!==1||heading.length!==1||heading.text().normalize('NFC').trim()!==title||byline.length!==1
      ||heading.add(heading.parents()).add(byline).toArray().some(node=>elementConcealed($,node)))return fail('invalid','Telegraph 公开页标题或全文容器不一致或不可见');
    heading.remove();byline.remove();
    const rendered=inspectRenderedArticle($.html(),nodesHtml(JSON.parse(matched.content) as TelegraphNode[]),target,'article.tl_article_content',{pageUrl:page.url,robotsHeader:page.robotsHeader});
    if(!rendered.found)return fail('invalid','Telegraph 可见全文、全部链接或索引规则不一致；原投稿仍保留');
    return {found:true,outcome:'found',url:page.url,rel:rendered.rel,reason:'Telegraph API 与原稿及公开可见全文、全部链接一致；不代表搜索收录'};
  }catch{return fail('unreachable','Telegraph 原公开文章暂时无法完整核验；不会重发');}
}

/**
 * Positively identifies a page after an uncertain createPage response. An
 * unknown result is intentionally inconclusive and must never authorize a
 * second publication attempt.
 */
export async function reconcileTelegraphTask(
  context: ExecutionContext,
  dependencies: TelegraphReconcileDependencies = {},
): Promise<TelegraphReconcileResult> {
  const unknown: TelegraphReconcileResult = { status: 'unknown' };
  const task = context.task;
  if (context.signal.aborted || context.channel.id !== 'telegraph' || context.channel.automation !== 'api'
    || task.channelId !== 'telegraph' || task.publicUrl || !task.draft || !task.accountId
    || !task.submittedAt || !Number.isFinite(Date.parse(task.submittedAt))
    || !['telegraph_publish_submitting', 'telegraph_publish_uncertain'].includes(task.checkpoint ?? '')) return unknown;

  const account = context.getAccount();
  if (!account || account.id !== task.accountId || account.channelId !== 'telegraph'
    || account.status !== 'registered' || !account.hasPassword || account.credentialKind !== 'api_token') return unknown;

  let token: string | undefined;
  try { token = await context.secrets.get(`account:${account.id}`); }
  catch { return unknown; }
  if (!token || token.length < 20 || token.length > 256) return unknown;

  let expectedFingerprints: Array<{ author: string; content: string }>;
  let expectedTitle: string;
  try {
    const target = sourceUrl(context.site.url);
    const currentContent = canonicalTelegraphContent(articleToTelegraphNodes(task.draft.body, context.site.name, target, context.site.language));
    const prior = priorTelegraphFingerprint(task.draft.body, context.site.name, target, context.site.language);
    if (!currentContent || !prior) return unknown;
    expectedFingerprints = [{ author: promotionalAuthorName(context.site.language).normalize('NFC'), content: currentContent }, prior];
    expectedTitle = plainInline(task.draft.title).slice(0, 256).normalize('NFC');
  } catch { return unknown; }
  if (expectedTitle.length < 4) return unknown;

  const transport = dependencies.transport ?? ((input: string, init: RequestInit) => fetch(input, init));
  const listed: Array<{ path: string; url: string; title: string }> = [];
  let totalCount: number | undefined;
  try {
    for (let pageIndex = 0; pageIndex < RECONCILE_MAX_LIST_PAGES; pageIndex++) {
      const offset = pageIndex * RECONCILE_LIST_PAGE_SIZE;
      const result = await apiCall('getPageList', {
        access_token: token,
        offset: String(offset),
        limit: String(RECONCILE_LIST_PAGE_SIZE),
      }, context, transport);
      if (!Number.isSafeInteger(result.total_count) || (result.total_count as number) < 0 || !Array.isArray(result.pages)) return unknown;
      const currentTotal = result.total_count as number;
      if (totalCount === undefined) {
        totalCount = currentTotal;
        if (totalCount > RECONCILE_MAX_PAGES) return unknown;
      } else if (currentTotal !== totalCount) return unknown;
      const expectedPageCount = Math.min(RECONCILE_LIST_PAGE_SIZE, Math.max(0, totalCount - offset));
      if (result.pages.length !== expectedPageCount) return unknown;
      for (const raw of result.pages) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unknown;
        const page = raw as ApiSuccess;
        const identity = pageIdentity(page);
        if (!identity || typeof page.title !== 'string' || page.title.length < 1 || page.title.length > 256) return unknown;
        listed.push({ ...identity, title: page.title.normalize('NFC') });
      }
      if (listed.length === totalCount) break;
    }
  } catch { return unknown; }
  if (totalCount === undefined || listed.length !== totalCount || new Set(listed.map(page => page.path)).size !== listed.length) return unknown;

  const candidates = listed.filter(page => page.title === expectedTitle);
  if (!candidates.length || candidates.length > RECONCILE_MAX_TITLE_CANDIDATES) return unknown;
  const matches: string[] = [];
  try {
    for (const candidate of candidates) {
      const result = await apiCall('getPage', {
        access_token: token,
        return_content: 'true',
      }, context, transport, candidate.path);
      const identity = pageIdentity(result);
      if (!identity || identity.path !== candidate.path || identity.url !== candidate.url
        || result.can_edit !== true || typeof result.title !== 'string'
        || result.title.normalize('NFC') !== candidate.title) return unknown;
      const content = canonicalTelegraphContent(result.content);
      if (!content) return unknown;
      const author = typeof result.author_name === 'string' ? result.author_name.normalize('NFC') : '';
      if (result.title.normalize('NFC') === expectedTitle && expectedFingerprints.some(fingerprint => author === fingerprint.author && content === fingerprint.content)) {
        matches.push(identity.url);
        if (matches.length > 1) return unknown;
      }
    }
  } catch { return unknown; }
  return matches.length === 1 ? { status: 'found', publicUrl: matches[0] } : unknown;
}

async function runWithTransport(context: ExecutionContext, transport: TelegraphTransport): Promise<ExecutionResult> {
  if (context.channel.id !== 'telegraph' || context.channel.automation !== 'api') return { status: 'needs_input', message: '该渠道没有启用 Telegraph API 自动化' };
  const blocked = accountBlock(context.getAccount(), context.task);
  if (blocked) return blocked;
  if (!context.task.draft) return { status: 'needs_input', message: '请先生成并检查原创文章草稿' };
  let content: TelegraphNode[];
  let target: string;
  try {
    target = sourceUrl(context.site.url);
    content = articleToTelegraphNodes(context.task.draft.body, context.site.name, target, context.site.language);
  } catch (error) {
    return { status: 'needs_input', message: error instanceof Error ? error.message : '文章内容不符合 Telegraph 发布要求' };
  }
  const title = plainInline(context.task.draft.title).slice(0, 256);
  if (title.length < 4) return { status: 'needs_input', message: '文章标题过短，请先完善草稿' };
  mustContinue(context);

  const found = context.getAccount();
  let ready: { account: Account; token: string } | ExecutionResult;
  if (!found) ready = await createAccount(context, transport);
  else if (found.status === 'draft' && found.source === 'generated' && found.credentialKind === 'api_token' && context.task.checkpoint !== 'telegraph_account_create_pending') ready = await createAccount(context, transport, found as AccountWithCredential);
  else if (found.status === 'registered') ready = await existingAccount(context, found, transport);
  else return accountBlock(found, context.task) ?? { status: 'needs_input', message: 'Telegraph 账号尚未可用' };
  if ('status' in ready) return ready;

  const submittedAt = now();
  context.checkpoint({ draft: context.task.draft, checkpoint: 'telegraph_publish_submitting', submittedAt });
  let created: ApiSuccess;
  try {
    created = await apiCall('createPage', {
      access_token: ready.token,
      title,
      author_name: promotionalAuthorName(context.site.language),
      content: JSON.stringify(content),
      return_content: 'false',
    }, context, transport);
  } catch (error) {
    if (error instanceof TelegraphApiRejection) {
      const failure = accountFailure(error.code);
      if (failure.status !== 'unknown') await context.saveAccount({ ...ready.account, status: failure.status, diagnostic: failure.diagnostic });
      context.checkpoint({ checkpoint: failure.status === 'unknown' ? 'telegraph_publish_rejected' : 'telegraph_publish_blocked', submittedAt: undefined });
      return { status: 'needs_input', message: failure.status === 'unknown' ? 'Telegraph 明确拒绝了发布请求，未重试' : failure.message, checkpoint: failure.status === 'unknown' ? 'telegraph_publish_rejected' : 'telegraph_publish_blocked' };
    }
    context.checkpoint({ checkpoint: 'telegraph_publish_uncertain', submittedAt });
    return { status: 'needs_input', message: 'Telegraph 发布结果无法确认，不会自动重复发文', checkpoint: 'telegraph_publish_uncertain', submittedAt };
  }
  const identity = pageIdentity(created);
  if (!identity) {
    context.checkpoint({ checkpoint: 'telegraph_publish_uncertain', submittedAt });
    return { status: 'needs_input', message: 'Telegraph 已接收发布，但未返回可信的公开网址；不会重复发文', checkpoint: 'telegraph_publish_uncertain', submittedAt };
  }
  context.checkpoint({ checkpoint: 'telegraph_published', submittedAt, publicUrl: identity.url });
  if(context.signal.aborted)return {status:'review',message:'Telegraph 公开文章已发布；已保留返回网址，暂停后不会继续回读或重复发文',publicUrl:identity.url,checkpoint:'telegraph_published',submittedAt};
  const verified = await verifyPage(context, identity.path, identity.url, target, transport);
  return {
    status: 'review',
    message: verified ? 'Telegraph 公开文章已发布并通过 API 回读，等待外链核验' : 'Telegraph 文章已发布，公开回读待核验；不会重复发文',
    publicUrl: identity.url,
    checkpoint: 'telegraph_published',
    submittedAt,
  };
}

export async function runTelegraphTask(context: ExecutionContext): Promise<ExecutionResult> {
  return runWithTransport(context, (input, init) => fetch(input, init));
}

export const telegraphTesting = { runWithTransport, countTargetLinks, pageIdentity };
