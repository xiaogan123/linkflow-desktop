import { randomUUID } from 'node:crypto';
import type { Account, SecretStore } from '../shared/types';
import type { Store } from './store';
import {bindAccount} from './account-bindings';
import {CHANNELS} from '../integrations/catalog';
import {
  BlueskyError,
  createBlueskyCredential,
  normalizeBlueskyHandle,
  type BlueskyDependencies,
} from '../integrations/bluesky';

type StateStore = Pick<Store, 'read' | 'update'>;

export interface BlueskyManagementDependencies extends BlueskyDependencies {}
export interface BlueskyBindingSelection {siteIds:string[];mailboxId?:string|null}

function stamp(dependencies?: BlueskyDependencies): string {
  const supplied = dependencies?.now?.();
  const value = supplied instanceof Date ? supplied : typeof supplied === 'string' ? new Date(supplied) : new Date();
  return (Number.isFinite(value.getTime()) ? value : new Date()).toISOString();
}

function connectionMessage(error: unknown): string {
  if (error instanceof BlueskyError) {
    if (error.code === 'auth') return 'Bluesky 拒绝了 handle 或应用专用密码；请勿输入主密码';
    if (error.code === 'restricted') return 'Bluesky 账号已停用、受限或不允许当前连接';
    if (error.code === 'rate_limited') return 'Bluesky 已触发速率限制，请稍后重试';
    if (error.code === 'timeout' || error.code === 'network') return '暂时无法连接 Bluesky，原凭据与账号记录未改变';
    if (error.code === 'cancelled') return 'Bluesky 连接已取消';
    return 'Bluesky 返回了无法安全确认的身份数据';
  }
  const local = error instanceof Error ? error.message : '';
  if (local === 'Bluesky handle 格式无效'
    || local === '请使用 Bluesky 设置中创建的应用专用密码；不接受主密码'
    || local.startsWith('新的 Bluesky 应用专用密码属于不同 DID')
    || local === 'Bluesky 账号身份在连接期间发生变化') return local;
  return 'Bluesky 连接失败，未更改原账号凭据';
}

/**
 * Connect an existing, user-owned Bluesky identity on the fixed hosted PDS.
 * Only the returned display metadata reaches callers; the app password and
 * rotating session tokens are stored together in the encrypted account vault.
 * Explicitly selected bindings commit together with the verified identity.
 */
export async function connectBluesky(
  store: StateStore,
  vault: SecretStore,
  handleInput: string,
  appPassword: string,
  dependencies: BlueskyManagementDependencies = {},
  existingAccountId?: string,
  selection?: BlueskyBindingSelection,
): Promise<Account> {
  const handle = normalizeBlueskyHandle(handleInput);
  const before = store.read();
  const requested = existingAccountId
    ? before.accounts.find(account => account.id === existingAccountId && account.channelId === 'bluesky')
    : undefined;
  if (existingAccountId && !requested) throw new Error('要更新的 Bluesky 账号不存在');
  const selected=new Set(selection?.siteIds??[]);
  const validateSelection=(state:ReturnType<StateStore['read']>)=>{
    if([...selected].some(id=>!state.sites.some(site=>site.id===id)))throw Error('所选网站已不存在');
    if(selection?.mailboxId&&!state.mailboxes.some(mailbox=>mailbox.id===selection.mailboxId))throw Error('收件箱不存在');
  };
  validateSelection(before);

  let savedAccount: Account | undefined;
  try {
    await createBlueskyCredential(handle, appPassword, dependencies, requested?.id, async authenticated => {
      if (requested && requested.username !== authenticated.did) {
        throw new Error('新的 Bluesky 应用专用密码属于不同 DID，不会覆盖已有账号；请新增连接。');
      }

      const currentState = store.read();
      const old = requested ?? currentState.accounts.find(account => account.channelId === 'bluesky' && account.username === authenticated.did);
      const accountId = old?.id ?? randomUUID();
      const now = stamp(dependencies);
      const account: Account = {
        ...old,
        id: accountId,
        channelId: 'bluesky',
        credentialKind: 'api_token',
        email: '',
        username: authenticated.did,
        displayName: `@${authenticated.handle}`,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        verifiedAt: now,
        status: 'registered',
        hasPassword: true,
        source: 'imported',
        diagnostic: undefined,
        ...(selection?.mailboxId!==undefined?{mailboxId:selection.mailboxId??undefined}:{}),
      };

      let previousSecret: string | undefined;
      if (old) previousSecret = await vault.get(`account:${accountId}`);
      await vault.set(`account:${accountId}`, authenticated.secret);
      try {
        store.update(state => {
          validateSelection(state);
          const current = state.accounts.find(item => item.id === accountId);
          if (current && (current.channelId !== 'bluesky' || current.username !== authenticated.did)) {
            throw new Error('Bluesky 账号身份在连接期间发生变化');
          }
          state.accounts = state.accounts.filter(item => item.id !== accountId);
          state.accounts.push(account);
          if(selection){
            const channel=CHANNELS.find(item=>item.id==='bluesky')!;
            for(const siteId of selected)bindAccount(state,accountId,siteId,channel);
            // A new connection can discover an existing DID. Add the chosen sites
            // without silently disconnecting bindings absent from the new drawer.
            if(requested)state.accountBindings=state.accountBindings.filter(binding=>binding.accountId!==accountId||binding.channelId!=='bluesky'||selected.has(binding.siteId));
          }
        });
      } catch (error) {
        if (previousSecret !== undefined) await vault.set(`account:${accountId}`, previousSecret);
        else await vault.delete(`account:${accountId}`);
        throw error;
      }
      savedAccount = account;
    });
  } catch (error) {
    throw new Error(connectionMessage(error));
  }
  if (!savedAccount) throw new Error('Bluesky 连接未能保存已验证身份');
  return savedAccount;
}
