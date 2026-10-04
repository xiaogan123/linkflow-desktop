import { randomUUID } from 'node:crypto';
import type { Account, AccountDiagnostic, SecretStore } from '../shared/types';
import type { Store } from './store';
import {
  authorizeBlogger,
  BloggerError,
  getBloggerAccessToken,
  getBloggerBlogs,
  getBloggerIdentity,
  parseBloggerDesktopClient,
  revokeBloggerCredential,
  saveAuthorizedBloggerCredential,
  verifyBloggerBlog,
  type BloggerBlog,
  type BloggerDependencies,
  type BloggerLoopbackFactory,
} from '../integrations/blogger';

type StateStore = Pick<Store, 'read' | 'update'>;

export interface BloggerManagementDependencies extends BloggerDependencies {
  openExternal?: (url: string) => Promise<unknown>;
  createLoopback?: BloggerLoopbackFactory;
  oauthTimeoutMs?: number;
  existingAccountId?: string;
}

function timestamp(dependencies?: BloggerDependencies): string {
  const value = dependencies?.now?.() ?? new Date();
  return (Number.isFinite(value.getTime()) ? value : new Date()).toISOString();
}

function diagnostic(code: AccountDiagnostic['code'], message: string, dependencies?: BloggerDependencies): AccountDiagnostic {
  return { code, message, at: timestamp(dependencies), retryable: false };
}

function accountDisplayName(value: string): string {
  return value.slice(0, 300);
}

function requireAccount(store: StateStore, accountId: string): Account {
  const account = store.read().accounts.find(item => item.id === accountId && item.channelId === 'blogger');
  if (!account) throw new Error('Blogger 账号不存在');
  if (account.credentialKind !== 'oauth') throw new Error('Blogger 账号不是 OAuth 身份');
  return account;
}

function message(error: unknown): string {
  if (!(error instanceof BloggerError)) return error instanceof Error ? error.message : 'Blogger 操作失败';
  if (error.code === 'cancelled') return 'Blogger OAuth 已取消';
  if (error.code === 'timeout') return 'Blogger OAuth 或 API 请求超时';
  if (error.code === 'auth') return 'Blogger OAuth 授权已失效，请重新连接原 Google 身份';
  if (error.code === 'forbidden') return 'Google 拒绝 Blogger 权限，请确认该身份拥有博客管理权限且已启用 Blogger API';
  if (error.code === 'rate_limited') return 'Blogger API 已触发速率限制，请稍后重试';
  if (error.code === 'network') return '暂时无法连接 Google Blogger 服务';
  if (error.code === 'rejected') return 'Google 明确拒绝了 Blogger 请求';
  return 'Google 返回了无法安全确认的 Blogger 数据';
}

function markConnectionFailure(store: StateStore, account: Account, error: unknown, dependencies?: BloggerDependencies): void {
  if (!(error instanceof BloggerError) || !['auth', 'forbidden'].includes(error.code)) return;
  const restricted = error.code === 'forbidden';
  store.update(state => {
    const current = state.accounts.find(item => item.id === account.id && item.channelId === 'blogger');
    if (!current) return;
    current.status = restricted ? 'restricted' : 'credentials_invalid';
    current.updatedAt = timestamp(dependencies);
    current.diagnostic = diagnostic(restricted ? 'restricted' : 'bad_password', restricted
      ? 'Google 拒绝了 Blogger 权限或该身份不再具有博客管理权限。'
      : 'Blogger OAuth 授权已失效或不属于原连接身份。', dependencies);
  });
}

async function authorizedAccount(
  store: StateStore,
  vault: SecretStore,
  accountId: string,
  dependencies: BloggerDependencies = {},
): Promise<{ account: Account; accessToken: string }> {
  const account = requireAccount(store, accountId);
  if (!account.hasPassword) throw new Error('本机保险箱中没有 Blogger OAuth 凭据');
  try {
    const access = await getBloggerAccessToken(vault, account.id, dependencies);
    if (access.credential.userId !== account.username) throw new BloggerError('auth');
    const identity = await getBloggerIdentity(access.accessToken, dependencies);
    if (identity.id !== account.username) throw new BloggerError('auth');
    store.update(state => {
      const current = state.accounts.find(item => item.id === account.id && item.channelId === 'blogger');
      if (!current || current.username !== identity.id) throw new Error('Blogger 身份在验证期间发生变化');
      current.status = 'registered';
      current.hasPassword = true;
      current.email = '';
      current.displayName = accountDisplayName(identity.displayName);
      current.verifiedAt = timestamp(dependencies);
      current.updatedAt = timestamp(dependencies);
      current.diagnostic = undefined;
    });
    return { account: { ...account, email: '', displayName: accountDisplayName(identity.displayName), status: 'registered', diagnostic: undefined }, accessToken: access.accessToken };
  } catch (error) {
    markConnectionFailure(store, account, error, dependencies);
    throw new Error(message(error));
  }
}

/**
 * Complete an installed-app OAuth flow. The returned value contains display
 * metadata only; tokens and the imported client secret are written solely to
 * the encrypted account:<id> vault entry.
 */
export async function connectBlogger(
  store: StateStore,
  vault: SecretStore,
  desktopClientJson: string | unknown,
  dependencies: BloggerManagementDependencies,
): Promise<{ account: Account; blogs: BloggerBlog[] }> {
  if (!dependencies.openExternal) throw new Error('Blogger OAuth 需要由主进程打开系统浏览器');
  const client = parseBloggerDesktopClient(desktopClientJson);
  let authorized: Awaited<ReturnType<typeof authorizeBlogger>>;
  try {
    authorized = await authorizeBlogger(client, dependencies.openExternal, dependencies);
  } catch (error) { throw new Error(message(error)); }

  const before = store.read();
  const requested = dependencies.existingAccountId
    ? before.accounts.find(item => item.id === dependencies.existingAccountId && item.channelId === 'blogger')
    : undefined;
  if (dependencies.existingAccountId && !requested) throw new Error('要更新的 Blogger 账号不存在');
  if (requested && requested.username !== authorized.identity.id) {
    throw new Error('新授权属于不同 Google Blogger 身份，不会覆盖已有账号；请新增连接。');
  }
  const old = requested ?? before.accounts.find(item => item.channelId === 'blogger' && item.username === authorized.identity.id);
  const accountId = old?.id ?? randomUUID();
  const stamp = timestamp(dependencies);
  const account: Account = {
    ...old,
    id: accountId,
    channelId: 'blogger',
    credentialKind: 'oauth',
    email: '',
    displayName: accountDisplayName(authorized.identity.displayName),
    username: authorized.identity.id,
    createdAt: old?.createdAt ?? stamp,
    updatedAt: stamp,
    verifiedAt: stamp,
    status: 'registered',
    hasPassword: true,
    source: 'imported',
    diagnostic: undefined,
  };
  const previousSecret = old ? await vault.get(`account:${accountId}`) : undefined;
  await saveAuthorizedBloggerCredential(vault, accountId, authorized.credential);
  try {
    store.update(state => {
      const current = state.accounts.find(item => item.id === accountId);
      if (current && (current.channelId !== 'blogger' || current.username !== authorized.identity.id)) {
        throw new Error('Blogger 身份在连接期间发生变化，请重新连接');
      }
      state.accounts = state.accounts.filter(item => item.id !== accountId);
      state.accounts.push(account);
    });
  } catch (error) {
    if (previousSecret !== undefined) await vault.set(`account:${accountId}`, previousSecret);
    else await vault.delete(`account:${accountId}`);
    throw error;
  }
  return { account, blogs: authorized.blogs };
}

export async function listBloggerBlogs(
  store: StateStore,
  vault: SecretStore,
  accountId: string,
  dependencies: BloggerDependencies = {},
): Promise<BloggerBlog[]> {
  const { accessToken } = await authorizedAccount(store, vault, accountId, dependencies);
  try { return await getBloggerBlogs(accessToken, dependencies); }
  catch (error) {
    const account = requireAccount(store, accountId);
    markConnectionFailure(store, account, error, dependencies);
    throw new Error(message(error));
  }
}

function bindingChangeBlocked(
  state: ReturnType<StateStore['read']>,
  siteId: string,
  accountId: string,
  blogId: string,
): boolean {
  return state.tasks.some(task => {
    if (task.siteId !== siteId || task.channelId !== 'blogger' || task.publicUrl || task.firstLiveAt) return false;
    const remoteIntent = !!task.submittedAt || !!task.blogger
      || ['blogger_insert_submitting', 'blogger_draft_created', 'blogger_publish_submitting'].includes(task.checkpoint ?? '');
    if (!remoteIntent) return false;
    // Reconnecting the same Google subject to the exact recorded blog is
    // necessary to reconcile an interrupted operation. Any other destination
    // remains blocked because it could create a duplicate on a second blog.
    return task.accountId !== accountId || task.blogger?.blogId !== blogId;
  });
}

export async function bindBloggerBlog(
  store: StateStore,
  vault: SecretStore,
  siteId: string,
  accountId: string,
  blogId: string,
  dependencies: BloggerDependencies = {},
): Promise<BloggerBlog> {
  const before = store.read();
  const site = before.sites.find(item => item.id === siteId);
  if (!site) throw new Error('网站不存在');
  const existingBinding = before.accountBindings.find(item => item.siteId === siteId && item.channelId === 'blogger');
  const unchanged = existingBinding?.accountId === accountId && site.blogger?.blogId === blogId;
  if (!unchanged && bindingChangeBlocked(before, siteId, accountId, blogId)) {
    throw new Error('该网站仍有 Blogger 待处理或结果不明任务；请先暂停并核对原任务，再更换博客绑定。');
  }
  const { account, accessToken } = await authorizedAccount(store, vault, accountId, dependencies);
  let blogs: BloggerBlog[];
  let verified: BloggerBlog;
  try {
    blogs = await getBloggerBlogs(accessToken, dependencies);
    const listed = blogs.find(item => item.id === blogId);
    if (!listed) throw new BloggerError('forbidden');
    verified = await verifyBloggerBlog(accessToken, account.username, blogId, dependencies);
    if (listed.url !== verified.url) throw new BloggerError('invalid_response');
  } catch (error) {
    markConnectionFailure(store, account, error, dependencies);
    throw new Error(message(error));
  }
  const stamp = timestamp(dependencies);
  const sourceDomain = new URL(verified.url).hostname.toLowerCase();
  store.update(state => {
    const currentSite = state.sites.find(item => item.id === siteId);
    const currentAccount = state.accounts.find(item => item.id === accountId && item.channelId === 'blogger');
    if (!currentSite || !currentAccount || currentAccount.username !== account.username) throw new Error('网站或 Blogger 身份在绑定期间发生变化');
    const currentBinding = state.accountBindings.find(item => item.siteId === siteId && item.channelId === 'blogger');
    const same = currentBinding?.accountId === accountId && currentSite.blogger?.blogId === blogId;
    if (!same && bindingChangeBlocked(state, siteId, accountId, blogId)) throw new Error('Blogger 任务状态已变化，请重新核对后绑定');
    currentSite.blogger = { blogId: verified.id, url: verified.url };
    state.accountBindings = state.accountBindings.filter(item => !(item.siteId === siteId && item.channelId === 'blogger'));
    state.accountBindings.push({
      id: currentBinding?.id ?? randomUUID(),
      siteId,
      channelId: 'blogger',
      accountId,
      createdAt: currentBinding?.createdAt ?? stamp,
      updatedAt: stamp,
    });
    for (const task of state.tasks) {
      if (task.siteId !== siteId || task.channelId !== 'blogger'
        || task.submittedAt || task.publicUrl || task.firstLiveAt || task.blogger) continue;
      task.accountId = accountId;
      task.sourceDomain = sourceDomain;
      task.articleApprovedAt = undefined;
      task.articleReview = undefined;
      if (!['skipped', 'expired'].includes(task.status)) {
        task.status = 'queued';
        task.scheduledAt = stamp;
        task.updatedAt = stamp;
        task.checkpoint = task.draft ? 'article_review' : undefined;
        task.message = '已绑定 Blogger 博客，发布前将重新核对稿件。';
      }
    }
  });
  return verified;
}

/** Revoke remotely before removing the sole local encrypted OAuth record. */
export async function disconnectBlogger(
  store: StateStore,
  vault: SecretStore,
  accountId: string,
  dependencies: BloggerDependencies = {},
): Promise<void> {
  const account = requireAccount(store, accountId);
  let raw: string | undefined;
  try { raw = await vault.get(`account:${accountId}`); }
  catch { throw new Error('系统钥匙串不可用，未删除 Blogger OAuth 凭据'); }
  if (raw) {
    try {
      await revokeBloggerCredential(raw, dependencies);
    } catch (error) {
      // A malformed/expired local token cannot be revoked and is already
      // unusable. Network, timeout and rate-limit errors retain it for retry.
      if (!(error instanceof BloggerError) || error.code !== 'auth') throw new Error(message(error));
    }
  }
  await vault.delete(`account:${accountId}`);
  const stamp = timestamp(dependencies);
  store.update(state => {
    const current = state.accounts.find(item => item.id === accountId && item.channelId === 'blogger');
    if (!current) throw new Error('Blogger 账号在断开期间已被移除');
    current.status = 'credentials_invalid';
    current.hasPassword = false;
    current.updatedAt = stamp;
    current.diagnostic = diagnostic('password_missing', 'Blogger OAuth 已断开；历史任务与身份归属仍保留。', dependencies);
    const boundSiteIds = new Set(state.accountBindings.filter(item => item.channelId === 'blogger' && item.accountId === accountId).map(item => item.siteId));
    state.accountBindings = state.accountBindings.filter(item => !(item.channelId === 'blogger' && item.accountId === accountId));
    for (const site of state.sites) if (boundSiteIds.has(site.id)) delete site.blogger;
  });
}
