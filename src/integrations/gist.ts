import type { Account, AccountDiagnostic, ExecutionContext, ExecutionResult } from '../shared/types';

const API_ORIGIN = 'https://api.github.com';
const PUBLIC_ORIGIN = 'https://gist.github.com';
const API_VERSION = '2026-03-10';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_README_BYTES = 96 * 1024;
const MIN_USEFUL_CHARACTERS = 200;

export type GistTransport = (input: string, init: RequestInit) => Promise<Response>;
export interface GistDependencies {
  fetch?: GistTransport;
  now?: () => string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

type JsonObject = Record<string, unknown>;
type GistIdentity = { id: string; login: string; url: string };
type ApprovedReadme = { content: string; target: string };

class GitHubAuthError extends Error { constructor() { super('GitHub token is invalid'); } }
class GitHubAccessError extends Error { constructor() { super('GitHub access is currently restricted'); } }
class GitHubRejectedError extends Error { constructor() { super('GitHub rejected the request'); } }
class GitHubRequestError extends Error { constructor() { super('GitHub request failed'); } }

function timestamp(dependencies?: GistDependencies): string {
  const value = dependencies?.now?.() ?? new Date().toISOString();
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString();
}

function diagnostic(code: AccountDiagnostic['code'], message: string, dependencies?: GistDependencies): AccountDiagnostic {
  return { code, message, at: timestamp(dependencies), retryable: false };
}

function transport(dependencies?: GistDependencies): GistTransport {
  return dependencies?.fetch ?? ((input, init) => fetch(input, init));
}

function validToken(token: string): boolean {
  return typeof token === 'string' && token.length >= 8 && token.length <= 512 && !/[\s\u0000-\u001f\u007f]/.test(token);
}

function validLogin(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value);
}

function validGistId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{5,64}$/i.test(value);
}

function canonicalHttps(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || (url.port && url.port !== '443') || url.hash) {
    throw new Error('目标网址必须是不含凭据和片段的 HTTPS 网址');
  }
  return url.toString();
}

function parsePublicUrl(value: string): GistIdentity | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== PUBLIC_ORIGIN || url.username || url.password || url.search || url.hash) return undefined;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 2 || !validLogin(segments[0]) || !validGistId(segments[1])) return undefined;
    const id = segments[1].toLowerCase();
    const canonical = `${PUBLIC_ORIGIN}/${segments[0]}/${id}`;
    if (url.toString() !== canonical) return undefined;
    return { id, login: segments[0], url: canonical };
  } catch { return undefined; }
}

function validApiHtmlUrl(value: unknown, login: string, id: string): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.origin !== PUBLIC_ORIGIN || url.username || url.password || url.search || url.hash) return false;
    const canonicalIdOnly = `${PUBLIC_ORIGIN}/${id}`;
    const canonicalWithOwner = `${PUBLIC_ORIGIN}/${login}/${id}`;
    return url.toString() === canonicalIdOnly || url.toString() === canonicalWithOwner;
  } catch { return false; }
}

async function readBoundedJson(response: Response): Promise<JsonObject> {
  const advertised = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) throw new GitHubRequestError();
  if (!response.body) throw new GitHubRequestError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new GitHubRequestError();
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value as JsonObject;
  } catch { throw new GitHubRequestError(); }
}

async function githubRequest(
  path: string,
  options: { method?: 'GET' | 'POST'; token?: string; body?: JsonObject; signal?: AbortSignal },
  dependencies?: GistDependencies,
): Promise<JsonObject> {
  if (!/^\/(?:user|gists\/[a-f0-9]{5,64}|gists)$/i.test(path)) throw new GitHubRequestError();
  if (options.token !== undefined && !validToken(options.token)) throw new GitHubAuthError();
  if (options.signal?.aborted) throw new GitHubRequestError();
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = Math.min(Math.max(dependencies?.timeoutMs ?? REQUEST_TIMEOUT_MS, 100), 30_000);
  const timer = setTimeout(() => controller.abort(new Error('request_timeout')), timeout);
  timer.unref?.();
  const url = `${API_ORIGIN}${path}`;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    'user-agent': 'Linkflow-Desktop',
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body) headers['content-type'] = 'application/json';
  try {
    let response: Response;
    try {
      response = await transport(dependencies)(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
    } catch { throw new GitHubRequestError(); }
    if (response.redirected) throw new GitHubRequestError();
    if (response.url) {
      try {
        const actual = new URL(response.url);
        if (actual.origin !== API_ORIGIN || actual.pathname !== path || actual.search || actual.hash) throw new Error('mismatch');
      } catch { throw new GitHubRequestError(); }
    }
    if (response.status === 401) throw new GitHubAuthError();
    if (response.status === 403) throw new GitHubAccessError();
    if (response.status === 422) throw new GitHubRejectedError();
    // A timeout, rate-limit response, server failure, or undocumented status can
    // arrive after GitHub accepted the POST. Keep those outcomes uncertain so a
    // recovered task cannot create a duplicate Gist.
    if (!response.ok) throw new GitHubRequestError();
    return await readBoundedJson(response);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

function gistIdentity(value: JsonObject, expectedLogin: string, expectedId?: string): GistIdentity | undefined {
  if (!validGistId(value.id) || value.public !== true) return undefined;
  const id = value.id.toLowerCase();
  if (expectedId && id !== expectedId.toLowerCase()) return undefined;
  const owner = value.owner;
  if (!owner || typeof owner !== 'object' || !validLogin((owner as JsonObject).login)) return undefined;
  const login = (owner as JsonObject).login as string;
  if (login.toLowerCase() !== expectedLogin.toLowerCase()) return undefined;
  const url = `${PUBLIC_ORIGIN}/${login}/${id}`;
  if (!validApiHtmlUrl(value.html_url, login, id)) return undefined;
  return { id, login, url };
}

function readmeContent(value: JsonObject): string | undefined {
  const files = value.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) return undefined;
  const entries = Object.entries(files as JsonObject);
  if (entries.length !== 1 || entries[0][0] !== 'README.md') return undefined;
  const file = entries[0][1];
  if (!file || typeof file !== 'object' || Array.isArray(file)) return undefined;
  const readme = file as JsonObject;
  if (readme.filename !== 'README.md' || readme.truncated === true || typeof readme.content !== 'string') return undefined;
  return readme.content;
}

function markdownTargets(body: string, target: string): { count: number; extraRawTarget: boolean } {
  const pattern = /(!?)\[([^\]\n]{1,500})\]\(\s*(https:\/\/[^)\s]+)\s*\)/gi;
  let count = 0;
  const retained: string[] = [];
  let cursor = 0;
  for (const match of body.matchAll(pattern)) {
    const start = match.index ?? 0;
    retained.push(body.slice(cursor, start));
    let isTarget = false;
    try { isTarget = !match[1] && canonicalHttps(match[3]) === target; } catch { /* invalid URLs remain ordinary text */ }
    if (isTarget) count++;
    else retained.push(match[0]);
    cursor = start + match[0].length;
  }
  retained.push(body.slice(cursor));
  const raw = /https:\/\/[^\s<>()\[\]{}"']+/gi;
  const extraRawTarget = [...retained.join('').matchAll(raw)].some(match => {
    try {
      const candidate = match[0].replace(/[.,;:!?]+$/, '');
      return canonicalHttps(candidate) === target;
    } catch { return false; }
  });
  return { count, extraRawTarget };
}

function approvedReadme(context: ExecutionContext): ApprovedReadme {
  const draft = context.task.draft;
  if (!draft) throw new Error('请先生成并核对 Gist 草稿');
  if (!context.task.articleApprovedAt || !Number.isFinite(Date.parse(context.task.articleApprovedAt))) throw new Error('请先完成人工核对并批准文章草稿');
  if (!draft.title || draft.title.length > 256 || /[\u0000-\u001f\u007f]/.test(draft.title)) throw new Error('Gist 标题不符合发布要求');
  if (!draft.description || draft.description.length > 1_024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draft.description)) throw new Error('Gist 描述不符合发布要求');
  if (/\r/.test(draft.body) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draft.body)) throw new Error('Gist 正文含有不支持的控制字符');
  const target = canonicalHttps(context.site.url);
  const content = `# ${draft.title}\n\n${draft.description}\n\n${draft.body}`;
  const links = markdownTargets(content, target);
  if (links.count !== 1 || links.extraRawTarget) throw new Error('Gist 正文必须且只能包含一个指向目标网址的 HTTPS Markdown 链接');
  const paragraphs = draft.body.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean);
  const visible = draft.body
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https:\/\/\S+/g, ' ')
    .replace(/[#>*_`~|\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const usefulParagraphCharacters = paragraphs
    .filter(item => !/(?:buy now|sign up now|register now|limited time|best price|click here|立即购买|立即注册|限时优惠|返佣链接)/i.test(item))
    .reduce((sum, item) => sum + item.replace(/\s/g, '').length, 0);
  if (visible.replace(/\s/g, '').length < MIN_USEFUL_CHARACTERS || paragraphs.length < 2 || usefulParagraphCharacters < 120) {
    throw new Error('Gist 正文需要包含有实际信息的原创内容，不能只是广告或行动号召');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_README_BYTES) throw new Error('Gist README.md 内容过大');
  return { content, target };
}

function verifyGist(value: JsonObject, expectedLogin: string, expectedContent: string, expectedId?: string): GistIdentity | undefined {
  const identity = gistIdentity(value, expectedLogin, expectedId);
  if (!identity || readmeContent(value) !== expectedContent) return undefined;
  return identity;
}

async function markInvalidCredential(context: ExecutionContext, account: Account, dependencies?: GistDependencies): Promise<void> {
  await context.saveAccount({
    ...account,
    status: 'credentials_invalid',
    diagnostic: diagnostic('bad_password', 'GitHub 拒绝了已保存的访问令牌，或令牌不属于预期账号。', dependencies),
    updatedAt: timestamp(dependencies),
  });
}

export async function validateGistToken(token: string, signal?: AbortSignal, dependencies?: GistDependencies): Promise<string> {
  const value = await githubRequest('/user', { token, signal }, dependencies);
  if (!validLogin(value.login)) throw new GitHubAuthError();
  return value.login;
}

export async function readPublicGist(url: string, dependencies?: GistDependencies): Promise<{ url: string; login: string; createdAt?: string }> {
  const expected = parsePublicUrl(url);
  if (!expected) throw new GitHubRequestError();
  const value = await githubRequest(`/gists/${expected.id}`, { signal: dependencies?.signal }, dependencies);
  const identity = gistIdentity(value, expected.login, expected.id);
  if (!identity || identity.url !== expected.url) throw new GitHubRequestError();
  const createdAt = typeof value.created_at === 'string' && Number.isFinite(Date.parse(value.created_at))
    ? new Date(value.created_at).toISOString()
    : undefined;
  return { url: identity.url, login: identity.login, ...(createdAt ? { createdAt } : {}) };
}

export async function runGistTask(context: ExecutionContext, dependencies?: GistDependencies): Promise<ExecutionResult> {
  if (context.channel.id !== 'github-gist' || context.channel.automation !== 'api') {
    return { status: 'needs_input', message: '该渠道没有启用 GitHub Gist API 自动化', publicUrl: context.task.publicUrl };
  }
  if ((context.task.checkpoint === 'submitting' || context.task.submittedAt) && !context.task.publicUrl) {
    return { status: 'needs_input', message: '上次 Gist 提交结果无法确认，不会自动重复创建；请先检查 GitHub Gists', checkpoint: 'submitting', submittedAt: context.task.submittedAt };
  }

  let approved: ApprovedReadme;
  try { approved = approvedReadme(context); }
  catch (error) { return { status: 'needs_input', message: error instanceof Error ? error.message : 'Gist 草稿不符合发布要求', publicUrl: context.task.publicUrl }; }

  const account = context.getAccount();
  if (!account || account.channelId !== 'github-gist') {
    return { status: 'needs_input', message: '请先连接已有 GitHub 账号和 Gist 访问令牌', publicUrl: context.task.publicUrl };
  }
  if (account.status === 'restricted') return { status: 'needs_input', message: 'GitHub 账号或访问已受限，已停止自动操作', publicUrl: context.task.publicUrl };
  if (account.status === 'credentials_invalid') return { status: 'needs_input', message: 'GitHub 访问令牌不可用，请人工更新凭据', publicUrl: context.task.publicUrl };
  if (account.status !== 'registered' || account.credentialKind !== 'api_token' || !account.hasPassword) {
    return { status: 'needs_input', message: 'GitHub Gist 需要已连接的 API 令牌，不会自动创建 GitHub 身份', publicUrl: context.task.publicUrl };
  }
  const token = await context.secrets.get(`account:${account.id}`);
  if (!token || !validToken(token)) {
    await context.saveAccount({ ...account, status: 'credentials_invalid', hasPassword: false, diagnostic: diagnostic('password_missing', '本机保险箱中没有可用的 GitHub 访问令牌。', dependencies), updatedAt: timestamp(dependencies) });
    return { status: 'needs_input', message: '本机保险箱中没有可用的 GitHub 访问令牌', publicUrl: context.task.publicUrl };
  }

  let login: string;
  try {
    login = await validateGistToken(token, context.signal, dependencies);
    if (login.toLowerCase() !== account.username.toLowerCase()) throw new GitHubAuthError();
  } catch (error) {
    if (error instanceof GitHubAuthError) {
      await markInvalidCredential(context, account, dependencies);
      return { status: 'needs_input', message: 'GitHub 访问令牌无效或不属于已连接账号，请更新凭据', publicUrl: context.task.publicUrl };
    }
    if (error instanceof GitHubAccessError) return { status: 'needs_input', message: 'GitHub 当前拒绝访问或触发速率限制；不会创建替代账号', publicUrl: context.task.publicUrl };
    return { status: 'failed', message: '暂时无法验证 GitHub 账号，尚未创建 Gist', publicUrl: context.task.publicUrl };
  }
  await context.saveAccount({ ...account, username: login, status: 'registered', verifiedAt: timestamp(dependencies), lastUsedAt: timestamp(dependencies), updatedAt: timestamp(dependencies), diagnostic: undefined });

  if (context.task.publicUrl) {
    const expected = parsePublicUrl(context.task.publicUrl);
    if (!expected || expected.login.toLowerCase() !== login.toLowerCase()) {
      return { status: 'needs_input', message: '已保存的 Gist 网址不是预期账号的规范公开地址，请人工核对', publicUrl: context.task.publicUrl };
    }
    try {
      const value = await githubRequest(`/gists/${expected.id}`, { token, signal: context.signal }, dependencies);
      const identity = verifyGist(value, login, approved.content, expected.id);
      if (!identity || identity.url !== expected.url) return { status: 'needs_input', message: '已保存的 Gist 不是预期账号下含批准 README.md 的公开结果', publicUrl: context.task.publicUrl };
      return { status: 'review', message: '已回读并确认公开 Gist，等待匿名页面外链核验', publicUrl: identity.url, checkpoint: 'gist_published', submittedAt: context.task.submittedAt };
    } catch (error) {
      if (error instanceof GitHubAuthError) {
        await markInvalidCredential(context, account, dependencies);
        return { status: 'needs_input', message: 'GitHub 访问令牌已失效；已保留已知 Gist 网址', publicUrl: context.task.publicUrl };
      }
      if (error instanceof GitHubAccessError) return { status: 'needs_input', message: 'GitHub 当前拒绝回读或触发速率限制；已保留已知 Gist 网址', publicUrl: context.task.publicUrl };
      return { status: 'needs_input', message: '已保留 Gist 网址，但 API 回读无法确认其公开性、归属或内容；不会重复创建', publicUrl: context.task.publicUrl, checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt };
    }
  }

  if (context.signal.aborted) return { status: 'queued', message: '任务已暂停，尚未提交 Gist' };
  if (context.task.checkpoint === 'submitting' || context.task.submittedAt || context.task.publicUrl) {
    return { status: 'needs_input', message: '已有 Gist 提交正在处理或结果待确认，不会重复创建', publicUrl: context.task.publicUrl, checkpoint: context.task.checkpoint, submittedAt: context.task.submittedAt };
  }

  const submittedAt = timestamp(dependencies);
  context.checkpoint({ checkpoint: 'submitting', submittedAt, draft: context.task.draft });
  let created: JsonObject;
  try {
    created = await githubRequest('/gists', {
      method: 'POST', token, signal: context.signal,
      body: { description: context.task.draft!.description, public: true, files: { 'README.md': { content: approved.content } } },
    }, dependencies);
  } catch (error) {
    if (error instanceof GitHubAuthError) {
      await markInvalidCredential(context, account, dependencies);
      context.checkpoint({ checkpoint: 'gist_rejected', submittedAt: undefined });
      return { status: 'needs_input', message: 'GitHub 访问令牌无效，Gist 未创建；请更新凭据', checkpoint: 'gist_rejected' };
    }
    if (error instanceof GitHubAccessError || error instanceof GitHubRejectedError) {
      context.checkpoint({ checkpoint: 'gist_rejected', submittedAt: undefined });
      return { status: 'needs_input', message: error instanceof GitHubAccessError ? 'GitHub 拒绝创建或触发速率限制；不会创建替代账号' : 'GitHub 明确拒绝了 Gist 创建请求', checkpoint: 'gist_rejected' };
    }
    return { status: 'needs_input', message: 'Gist 提交结果无法确认，不会自动重复创建', checkpoint: 'submitting', submittedAt };
  }

  const identity = verifyGist(created, login, approved.content);
  if (!identity) return { status: 'needs_input', message: 'GitHub 已响应创建请求，但结果身份、公开性或 README.md 无法确认；不会重复创建', checkpoint: 'submitting', submittedAt };
  try { context.checkpoint({ checkpoint: 'gist_published', submittedAt, publicUrl: identity.url }); }
  catch { return { status: 'review', message: '公开 Gist 已创建，等待匿名页面外链核验', publicUrl: identity.url, checkpoint: 'gist_published', submittedAt }; }

  let confirmed = false;
  try {
    const value = await githubRequest(`/gists/${identity.id}`, { token, signal: context.signal }, dependencies);
    confirmed = !!verifyGist(value, login, approved.content, identity.id);
  } catch { /* the known result URL is retained; anonymous verification remains the controller's job */ }
  return {
    status: 'review',
    message: confirmed ? '公开 Gist 已创建并通过 API 回读，等待匿名页面外链核验' : '公开 Gist 已创建，API 回读待确认；等待匿名页面外链核验',
    publicUrl: identity.url,
    checkpoint: 'gist_published',
    submittedAt,
  };
}

export const gistTesting = { parsePublicUrl, markdownTargets, approvedReadme, verifyGist };
