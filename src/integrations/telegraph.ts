import { randomUUID } from 'node:crypto';
import type { Account, AccountDiagnostic, ExecutionContext, ExecutionResult, Task } from '../shared/types';

const API_ORIGIN = 'https://api.telegra.ph';
const PUBLIC_ORIGIN = 'https://telegra.ph';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CONTENT_BYTES = 64 * 1024;
const MIN_ARTICLE_CHARACTERS = 500;
const MIN_ARTICLE_BLOCKS = 3;

type TelegraphTag = 'a' | 'blockquote' | 'h3' | 'h4' | 'hr' | 'li' | 'ol' | 'p' | 'pre' | 'ul';
export type TelegraphNode = string | { tag: TelegraphTag; attrs?: { href: string }; children?: TelegraphNode[] };
export type TelegraphTransport = (input: string, init: RequestInit) => Promise<Response>;

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
  method: 'createAccount' | 'getAccountInfo' | 'createPage' | 'getPage',
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
  try {
    const response = await transport(url, {
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
    if (error instanceof TelegraphApiRejection) throw error;
    throw new TelegraphUncertainError(method === 'createAccount' ? 'account' : method === 'createPage' ? 'publish' : 'read');
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener('abort', abort);
  }
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
  const disclosure: TelegraphNode = language.toLowerCase().startsWith('zh')
    ? { tag: 'p', children: ['作者披露：本文由该网站的所有者或运营方发布，文中主体为 ', name, '。官方来源：', { tag: 'a', attrs: { href }, children: [name] }, '。'] }
    : { tag: 'p', children: ['Author disclosure: Published by the owner or operator of ', name, '. Official source: ', { tag: 'a', attrs: { href }, children: [name] }, '.'] };
  const nodes: TelegraphNode[] = blocks.map(block => block.tag === 'pre'
    ? { tag: 'pre', children: [block.text] }
    : { tag: block.tag, children: inlineNodes(block.text, href) });
  nodes.push({ tag: 'hr' }, disclosure);
  if (Buffer.byteLength(JSON.stringify(nodes), 'utf8') > MAX_CONTENT_BYTES) throw new Error('文章超出 Telegraph 64 KB 内容上限');
  return nodes;
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
    const result = await apiCall('createAccount', { short_name: shortName, author_name: `${shortName} site owner`.slice(0, 128) }, context, transport);
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
      author_name: `${plainInline(context.site.name).slice(0, 108)} site owner`.slice(0, 128),
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
