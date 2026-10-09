import { randomUUID } from 'node:crypto';
import {
  getNetlifyAccountIdentity,
  getNetlifyAccessibleProject,
  listNetlifyAccessibleProjects,
  NetlifyAccountError,
  type NetlifyAccessibleProject,
  type NetlifyAccountDependencies,
} from '../integrations/netlify-account';
import {
  authorizeNetlifyTicket,
  NetlifyTicketError,
  type NetlifyTicketOpenExternal,
} from '../integrations/netlify-ticket';
import type { Account } from '../shared/types';
import type { Store } from './store';
import type { Vault } from './vault';

type StateStore = Pick<Store, 'read' | 'updateWithCiphers'>;
type SecretVault = Pick<Vault, 'get' | 'encryptSecrets'>;
type TimerHandle = ReturnType<typeof setTimeout> | unknown;

interface StoredNetlifyCredential {
  version: 1;
  accessToken: string;
  userId: string;
  teamId: string;
  siteId: string;
  siteUrl: string;
}

interface PendingSession {
  accessToken: string;
  userId: string;
  projects: NetlifyAccessibleProject[];
  until: number;
  timer: TimerHandle;
}

export interface NetlifyManagementDependencies extends NetlifyAccountDependencies {
  clientId?: string;
  openExternal?: NetlifyTicketOpenExternal;
  authorizeTicket?: typeof authorizeNetlifyTicket;
  sessionTimeoutMs?: number;
  uuid?: () => string;
}

export interface NetlifyConnectionSelection {
  sessionId: string;
  siteId: string;
  dedicatedPublicationConfirmed: boolean;
  accountId?: string;
}

export interface NetlifyProjectChoice {
  id: string;
  name?: string;
  publicUrl: string;
  readAccess: 'confirmed';
  deployPermission: 'unknown';
  publicVisibility: 'unverified';
  nonGitProductionBlocked: boolean;
}

const MAX_SESSION_MS = 5 * 60_000;

class NetlifyManagementError extends Error {}

function now(dependencies: NetlifyManagementDependencies): number {
  const value = dependencies.now?.() ?? Date.now();
  return Number.isFinite(value) ? value : Date.now();
}

function sessionDuration(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.floor(value), 1), MAX_SESSION_MS)
    : MAX_SESSION_MS;
}

function parseCredential(serialized: string | undefined): StoredNetlifyCredential {
  try {
    const value = JSON.parse(serialized ?? '') as Partial<StoredNetlifyCredential>;
    if (value.version !== 1 || typeof value.accessToken !== 'string' || value.accessToken.length < 8
      || typeof value.userId !== 'string' || !value.userId
      || typeof value.teamId !== 'string' || !value.teamId
      || typeof value.siteId !== 'string' || !value.siteId
      || typeof value.siteUrl !== 'string' || !value.siteUrl) throw new Error();
    return value as StoredNetlifyCredential;
  } catch { throw new NetlifyManagementError('本机保险箱中的 Netlify 连接无法安全核对，请保留原账号并重新检查。'); }
}

function errorMessage(error: unknown): string {
  if (error instanceof NetlifyManagementError) return error.message;
  if (error instanceof NetlifyTicketError) {
    if (error.code === 'cancelled') return 'Netlify 授权已取消';
    if (error.code === 'timeout') return 'Netlify 授权会话已超时';
    if (error.code === 'open_failed') return '无法打开 Netlify 系统浏览器授权页';
    if (error.code === 'auth' || error.code === 'forbidden') return 'Netlify 拒绝了当前 OAuth 应用或授权';
    return '无法安全完成 Netlify 票据授权';
  }
  if (error instanceof NetlifyAccountError) {
    if (error.code === 'cancelled') return 'Netlify 连接已取消';
    if (error.code === 'timeout') return 'Netlify 只读核对已超时';
    if (error.code === 'identity_mismatch') return 'Netlify 票据身份与当前授权用户不一致';
    if (error.code === 'auth' || error.code === 'forbidden') return 'Netlify 授权已失效或无权读取该项目';
    if (error.code === 'limit') return 'Netlify 可访问项目过多或分页不稳定，未返回不完整列表';
    return 'Netlify 返回了无法安全核对的数据';
  }
  return 'Netlify 连接失败，本机状态未更改';
}

function sameAccount(current: Account | undefined, snapshot: Account): boolean {
  return !!current && JSON.stringify(current) === JSON.stringify(snapshot);
}

/** Main-process-only connection staging. It does not enable a channel or bind a local site. */
export class NetlifyConnections {
  private pending = new Map<string, PendingSession>();
  private authorizationAbort?: AbortController;
  private connectAbort?: AbortController;
  private connecting = false;
  private generation = 0;

  constructor(
    private store: StateStore,
    private vault: SecretVault,
    private dependencies: NetlifyManagementDependencies,
  ) {}

  private clearTimer(handle: TimerHandle): void {
    (this.dependencies.clearTimer ?? (value => clearTimeout(value as ReturnType<typeof setTimeout>)))(handle);
  }

  private clearPending(): void {
    for (const session of this.pending.values()) this.clearTimer(session.timer);
    this.pending.clear();
  }

  cancel(): void {
    this.generation++;
    this.authorizationAbort?.abort();
    this.connectAbort?.abort();
    this.clearPending();
  }

  async authorize(): Promise<{ sessionId: string; projects: NetlifyProjectChoice[] }> {
    if (!this.dependencies.clientId || !this.dependencies.openExternal) {
      throw new NetlifyManagementError('Netlify OAuth 应用 client ID 或系统浏览器入口尚未配置');
    }
    if (this.dependencies.signal?.aborted) throw new NetlifyManagementError('Netlify 连接已取消');
    if (this.authorizationAbort || this.connecting) throw new NetlifyManagementError('Netlify 连接正在进行');
    this.clearPending();
    const abort = new AbortController();
    const externalAbort = () => abort.abort();
    this.dependencies.signal?.addEventListener('abort', externalAbort, { once: true });
    this.authorizationAbort = abort;
    try {
      const authorize = this.dependencies.authorizeTicket ?? authorizeNetlifyTicket;
      const grant = await authorize({
        clientId: this.dependencies.clientId,
        openExternal: this.dependencies.openExternal,
        request: this.dependencies.request,
        signal: abort.signal,
        now: this.dependencies.now,
        setTimer: this.dependencies.setTimer,
        clearTimer: this.dependencies.clearTimer,
        requestTimeoutMs: this.dependencies.requestTimeoutMs,
        totalTimeoutMs: this.dependencies.totalTimeoutMs,
      });
      await getNetlifyAccountIdentity(grant.accessToken, grant.userId, { ...this.dependencies, signal: abort.signal });
      const projects = await listNetlifyAccessibleProjects(grant.accessToken, { ...this.dependencies, signal: abort.signal });
      if (abort.signal.aborted) throw new NetlifyAccountError('cancelled');
      if (!projects.length) throw new NetlifyManagementError('当前 Netlify 身份没有可供安全选择的 netlify.app HTTPS 项目');
      const sessionId = this.dependencies.uuid?.() ?? randomUUID();
      const until = now(this.dependencies) + sessionDuration(this.dependencies.sessionTimeoutMs);
      const setTimer = this.dependencies.setTimer ?? ((callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds));
      const timer = setTimer(() => this.pending.delete(sessionId), until - now(this.dependencies));
      (timer as ReturnType<typeof setTimeout>).unref?.();
      this.pending.set(sessionId, { accessToken: grant.accessToken, userId: grant.userId, projects, until, timer });
      return {
        sessionId,
        projects: projects.map(({ teamId: _teamId, ...project }) => project),
      };
    } catch (error) {
      throw new Error(errorMessage(error));
    } finally {
      this.dependencies.signal?.removeEventListener('abort', externalAbort);
      if (this.authorizationAbort === abort) this.authorizationAbort = undefined;
    }
  }

  async connect(input: NetlifyConnectionSelection): Promise<Account> {
    if (this.connecting || this.authorizationAbort) throw new NetlifyManagementError('Netlify 连接正在进行');
    if (this.dependencies.signal?.aborted) throw new NetlifyManagementError('Netlify 连接已取消');
    const session = this.pending.get(input.sessionId);
    this.pending.delete(input.sessionId);
    if (session) this.clearTimer(session.timer);
    if (!session || session.until <= now(this.dependencies)) throw new NetlifyManagementError('Netlify 连接会话已过期，请重新授权');
    if (!input.dedicatedPublicationConfirmed) throw new NetlifyManagementError('请先确认这是由本工具专用管理的出版项目');
    const selected = session.projects.find(project => project.id === input.siteId);
    if (!selected) throw new NetlifyManagementError('请选择本次授权列出的 Netlify 项目');
    if (selected.nonGitProductionBlocked) throw new NetlifyManagementError('该项目明确禁止普通非 Git 生产部署，不能保存为出版项目');

    const before = this.store.read();
    const requested = input.accountId
      ? before.accounts.find(account => account.id === input.accountId && account.channelId === 'netlify')
      : undefined;
    if (input.accountId && !requested) throw new NetlifyManagementError('要更新的 Netlify 连接不存在');
    if (requested && requested.username !== selected.id) {
      throw new NetlifyManagementError('这是另一个 Netlify 项目，不会覆盖原连接');
    }
    const previous = requested ?? before.accounts.find(account => account.channelId === 'netlify' && account.username === selected.id);
    const generation = this.generation;
    const abort = new AbortController();
    const externalAbort = () => abort.abort();
    this.dependencies.signal?.addEventListener('abort', externalAbort, { once: true });
    this.connecting = true;
    this.connectAbort = abort;
    try {
      let oldCredential: StoredNetlifyCredential | undefined;
      if (previous) {
        oldCredential = parseCredential(await this.vault.get(`account:${previous.id}`));
        if (generation !== this.generation || abort.signal.aborted) throw new NetlifyAccountError('cancelled');
        if (oldCredential.siteId !== previous.username || oldCredential.siteUrl !== previous.publicationUrl
          || oldCredential.siteId !== selected.id || oldCredential.siteUrl !== selected.publicUrl) {
          throw new NetlifyManagementError('Netlify 原项目身份或公开网址不一致，不会覆盖历史连接');
        }
      }
      const identity = await getNetlifyAccountIdentity(session.accessToken, session.userId, { ...this.dependencies, signal: abort.signal });
      const verified = await getNetlifyAccessibleProject(session.accessToken, selected.id, { ...this.dependencies, signal: abort.signal });
      if (generation !== this.generation || abort.signal.aborted) throw new NetlifyAccountError('cancelled');
      if (identity.id !== session.userId || verified.id !== selected.id || verified.teamId !== selected.teamId
        || verified.publicUrl !== selected.publicUrl) throw new NetlifyManagementError('Netlify 授权期间项目身份发生变化');
      if (verified.nonGitProductionBlocked) throw new NetlifyManagementError('该项目已禁止普通非 Git 生产部署，不能保存为出版项目');
      if (oldCredential && (oldCredential.userId !== identity.id || oldCredential.teamId !== verified.teamId
        || oldCredential.siteId !== verified.id || oldCredential.siteUrl !== verified.publicUrl)) {
        throw new NetlifyManagementError('新的 Netlify 授权不属于原用户、团队或项目，不会覆盖历史连接');
      }

      const id = previous?.id ?? (this.dependencies.uuid?.() ?? randomUUID());
      const timestamp = new Date(now(this.dependencies)).toISOString();
      const credential: StoredNetlifyCredential = {
        version: 1,
        accessToken: session.accessToken,
        userId: identity.id,
        teamId: verified.teamId,
        siteId: verified.id,
        siteUrl: verified.publicUrl,
      };
      const serialized = JSON.stringify(credential);
      const key = `account:${id}`;
      if (generation !== this.generation) throw new NetlifyAccountError('cancelled');
      const ciphers = this.vault.encryptSecrets({ [key]: serialized });
      if (typeof ciphers[key] !== 'string' || !ciphers[key]) throw new NetlifyManagementError('Netlify 凭据未能加密');
      const account: Account = {
        ...previous,
        id,
        channelId: 'netlify',
        username: verified.id,
        publicationUrl: verified.publicUrl,
        displayName: verified.name ?? verified.id,
        credentialKind: 'oauth',
        email: '',
        hasPassword: true,
        status: 'needs_verification',
        source: 'imported',
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
        verifiedAt: undefined,
        diagnostic: {
          code: 'verification_required',
          message: 'Netlify 只读身份已连接；部署权限、匿名公开访问与真实发布仍待验证。',
          at: timestamp,
          retryable: false,
        },
      };
      this.store.updateWithCiphers(state => {
        if (generation !== this.generation) throw new NetlifyManagementError('Netlify 连接已取消');
        const current = state.accounts.find(item => item.id === id);
        if (previous) {
          if (!sameAccount(current, previous)) throw new NetlifyManagementError('Netlify 账号在连接期间已删除或变化');
        } else if (current || state.accounts.some(item => item.channelId === 'netlify' && item.username === verified.id)) {
          throw new NetlifyManagementError('Netlify 项目在连接期间已被其他连接保存');
        }
        state.accounts = state.accounts.filter(item => item.id !== id);
        state.accounts.push(account);
      }, ciphers);
      return account;
    } catch (error) {
      throw new Error(errorMessage(error));
    } finally {
      this.dependencies.signal?.removeEventListener('abort', externalAbort);
      this.connecting = false;
      this.connectAbort = undefined;
    }
  }
}
