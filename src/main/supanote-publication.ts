import { createHash } from 'node:crypto';
import type { SupanoteIntent, SupanotePersistence, SupanoteReceipt } from '../integrations/supanote';
import type { Site, Task } from '../shared/types';
import type { State, Store } from './store';
import type { Vault } from './vault';

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const CONTENT_HASH = /^[a-f0-9]{64}$/;
const PUBLIC_ID = /^[A-Za-z0-9_-]{1,200}$/;
const ORIGIN = 'https://supanote.app';
const SECRET_VERSION = 1;

type StateStore = Pick<Store, 'read' | 'update' | 'updateWithCiphers' | 'getCipher'>;
type EncryptingVault = Pick<Vault, 'encryptSecrets'>;

export interface SupanoteAuthorizationSnapshot {
  state: State;
  task: Task;
  site: Site;
}

export interface SupanotePublicationOptions {
  taskId: string;
  siteId: string;
  /** Exact durable intent identity required when recovering an already-started request. */
  expectedIntent?: SupanoteIntent;
  /**
   * Synchronously rechecks controller-owned publication authorization immediately
   * before the intent write. This is not a user approval flag or an external switch.
   */
  assertSubmissionAuthorized(snapshot: SupanoteAuthorizationSnapshot): true;
  now?: () => Date;
}

interface SerializedSupanoteSecret {
  version: 1;
  taskId: string;
  publicId: string;
  publicUrl: string;
  token: string;
}

export function supanoteTaskContentHash(task: Pick<Task, 'draft'>): string | undefined {
  const title = task.draft?.title, markdown = task.draft?.body;
  if (typeof title !== 'string' || typeof markdown !== 'string') return;
  return createHash('sha256').update(JSON.stringify({
    title,
    content: markdown,
    contentType: 'markdown',
    visibility: 'public',
    expiration: 'never',
  })).digest('hex');
}

function expectedPublicUrl(publicId: string): string {
  if (!PUBLIC_ID.test(publicId)) throw Error('Supanote 公开文章身份无效');
  return `${ORIGIN}/n/${publicId}`;
}

function currentBinding(state: State, taskId: string, siteId: string, contentHash: string): { task: Task; site: Site } {
  const task = state.tasks.find(item => item.id === taskId);
  const site = state.sites.find(item => item.id === siteId);
  if (!task || !site || task.siteId !== site.id || task.channelId !== 'supanote'
    || task.sourceDomain !== 'supanote.app' || task.accountId)
    throw Error('Supanote 任务绑定已改变');
  if (supanoteTaskContentHash(task) !== contentHash) throw Error('Supanote 原稿已改变');
  return { task, site };
}

function validIntent(intent: SupanoteIntent): boolean {
  const timestamp = new Date(intent.createdAt);
  return OPERATION_ID.test(intent.operationId) && CONTENT_HASH.test(intent.contentHash)
    && Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === intent.createdAt;
}

function hasExternalState(task: Task): boolean {
  return !!(task.supanote || task.submittedAt || task.publicUrl || task.verifiedAt || task.firstLiveAt
    || task.linkCheck || task.publicationMethod || /(?:submitt|publish|receipt|uncertain)/i.test(task.checkpoint ?? ''));
}

function assertStoredIntent(task: Task, expected: SupanoteIntent): NonNullable<Task['supanote']> {
  const saved = task.supanote;
  if (!saved || saved.operationId !== expected.operationId || saved.contentHash !== expected.contentHash
    || saved.createdAt !== expected.createdAt || !validIntent(saved)
    || task.submittedAt !== saved.createdAt || task.status !== 'review' || task.health !== 'pending')
    throw Error('Supanote 提交意图与原任务不一致');
  if (saved.stage === 'submitting') {
    if (saved.publicId || task.publicUrl || task.checkpoint !== 'supanote_publish_submitting')
      throw Error('Supanote 提交意图阶段无效');
  } else if (!saved.publicId || task.publicUrl !== expectedPublicUrl(saved.publicId)
    || task.checkpoint !== 'supanote_api_receipt') throw Error('Supanote 公开回执阶段无效');
  if (task.verifiedAt || task.firstLiveAt || task.linkCheck || task.linkRel)
    throw Error('Supanote API 回执不能标记为公开验收通过');
  return saved;
}

function assertBackupCompatibleDraft(task: Task): void {
  const draft = task.draft;
  if (!draft || typeof draft.title !== 'string' || typeof draft.description !== 'string'
    || typeof draft.body !== 'string' || draft.title.length > 30_000
    || draft.description.length > 30_000 || draft.body.length > 30_000)
    throw Error('Supanote 原稿超出可备份范围');
}

function validToken(token: string): boolean {
  return !!token && Buffer.byteLength(token, 'utf8') <= 8192 && !/[\s\u0000-\u001f\u007f]/.test(token);
}

export function parseSupanotePublicationSecret(value: string): SerializedSupanoteSecret | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const secret = parsed as Record<string, unknown>;
    if (Object.keys(secret).sort().join(',') !== 'publicId,publicUrl,taskId,token,version'
      || secret.version !== SECRET_VERSION || typeof secret.taskId !== 'string' || !TASK_ID.test(secret.taskId)
      || typeof secret.publicId !== 'string' || !PUBLIC_ID.test(secret.publicId)
      || secret.publicUrl !== expectedPublicUrl(secret.publicId)
      || typeof secret.token !== 'string' || !validToken(secret.token)) return;
    return secret as unknown as SerializedSupanoteSecret;
  } catch { return; }
}

/**
 * This claim bridge relies on the application's single Store instance and process.
 * It does not claim cross-process CAS semantics for multiple independently cached Stores.
 */
export function createSupanotePublicationPersistence(
  store: StateStore,
  vault: EncryptingVault,
  options: SupanotePublicationOptions,
): SupanotePersistence {
  if (!TASK_ID.test(options.taskId) || !TASK_ID.test(options.siteId)) throw Error('Supanote 任务参数无效');
  const taskId = options.taskId, siteId = options.siteId;
  const authorize = options.assertSubmissionAuthorized, now = options.now;
  let claimedIntent = options.expectedIntent ? { ...options.expectedIntent } : undefined;
  if (claimedIntent && !validIntent(claimedIntent)) throw Error('Supanote 恢复意图无效');
  const updatedAt = () => (now?.() ?? new Date()).toISOString();
  return {
    async persistIntent(intent) {
      if (claimedIntent) throw Error('Supanote 恢复上下文禁止创建新提交意图');
      const proposed = { ...intent };
      if (!validIntent(proposed)) throw Error('Supanote 提交意图无效');
      store.update(state => {
        const { task, site } = currentBinding(state, taskId, siteId, proposed.contentHash);
        assertBackupCompatibleDraft(task);
        if (hasExternalState(task)) throw Error('Supanote 任务已有提交记录，禁止重复提交');
        if (!state.settings.autoRun || task.status !== 'running' || site.status !== 'ready')
          throw Error('Supanote 任务已暂停或不再允许提交');
        const guard = authorize(structuredClone({ state, task, site }));
        if (guard && typeof (guard as unknown as { then?: unknown }).then === 'function') {
          void Promise.resolve(guard).catch(() => undefined);
          throw Error('Supanote 同步授权检查未通过');
        }
        if (guard !== true) throw Error('Supanote 同步授权检查未通过');
        task.supanote = { ...proposed, stage: 'submitting' };
        task.submittedAt = proposed.createdAt;
        task.checkpoint = 'supanote_publish_submitting';
        task.status = 'review';
        task.health = 'pending';
        task.updatedAt = updatedAt();
        task.message = 'Supanote 提交意图已保存；结果未核清前不会重发。';
      });
      claimedIntent = proposed;
    },
    async persistReceipt(receipt: SupanoteReceipt) {
      const returned = { ...receipt };
      if (!CONTENT_HASH.test(returned.contentHash) || !PUBLIC_ID.test(returned.publicId)
        || returned.publicUrl !== expectedPublicUrl(returned.publicId)) throw Error('Supanote 公开回执无效');
      const expected = claimedIntent && { ...claimedIntent };
      if (!expected || returned.contentHash !== expected.contentHash) throw Error('Supanote 公开回执缺少原提交意图');
      store.update(state => {
        const { task } = currentBinding(state, taskId, siteId, expected.contentHash);
        const saved = assertStoredIntent(task, expected);
        if (saved.stage === 'api_receipt') {
          if (saved.publicId !== returned.publicId || task.publicUrl !== returned.publicUrl)
            throw Error('Supanote 公开回执不能更换文章身份');
          return;
        }
        task.supanote = { ...saved, stage: 'api_receipt', publicId: returned.publicId };
        task.publicUrl = returned.publicUrl;
        task.checkpoint = 'supanote_api_receipt';
        task.status = 'review';
        task.health = 'pending';
        task.updatedAt = updatedAt();
        task.message = 'Supanote API 回执已保存；等待公开页面渲染核验，不计为有效来源。';
      });
    },
    async persistManageToken(secret) {
      const returned = { ...secret };
      if (!PUBLIC_ID.test(returned.publicId) || !validToken(returned.token)) throw Error('Supanote 管理凭据无效');
      const expected = claimedIntent && { ...claimedIntent };
      if (!expected) throw Error('Supanote 管理凭据缺少原提交意图');
      const key = `publication:${taskId}`;
      if (store.getCipher(key)) throw Error('Supanote 管理凭据已经保存，禁止替换');
      const before = store.read(), { task } = currentBinding(before, taskId, siteId, expected.contentHash);
      const receipt = assertStoredIntent(task, expected);
      if (receipt.stage !== 'api_receipt' || receipt.publicId !== returned.publicId)
        throw Error('Supanote 管理凭据缺少匹配的公开回执');
      const serialized = JSON.stringify({
        version: SECRET_VERSION,
        taskId: task.id,
        publicId: receipt.publicId,
        publicUrl: expectedPublicUrl(receipt.publicId),
        token: returned.token,
      } satisfies SerializedSupanoteSecret);
      if (serialized.length > 16_384) throw Error('Supanote 管理凭据超出可备份范围');
      const publicUrl = task.publicUrl;
      const ciphers = vault.encryptSecrets({ [key]: serialized });
      if (typeof ciphers[key] !== 'string' || !ciphers[key]) throw Error('Supanote 管理凭据未能加密');
      store.updateWithCiphers(state => {
        const { task: current } = currentBinding(state, taskId, siteId, expected.contentHash);
        const stored = assertStoredIntent(current, expected);
        if (stored.stage !== 'api_receipt' || stored.publicId !== receipt.publicId || current.publicUrl !== publicUrl)
          throw Error('Supanote 管理凭据与公开回执不一致');
      }, { [key]: ciphers[key] });
    },
  };
}
