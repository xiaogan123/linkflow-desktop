import { createHash } from 'node:crypto';
import type {
  DocsMdIntent,
  DocsMdPersistence,
  DocsMdReceipt,
} from '../integrations/docs-md';
import type { Site, Task } from '../shared/types';
import type { State, Store } from './store';
import type { Vault } from './vault';

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const PUBLIC_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EDIT_TOKEN = /^[A-Za-z0-9_-]{32}$/;
const ORIGIN = 'https://docs-md.com';
const FILENAME = 'publication.md';
const EXPIRY = 'never';
const MAX_CONTENT_CHARS = 120_000;
const MAX_REQUEST_BYTES = 200_000;
const SECRET_VERSION = 1;

type StateStore = Pick<Store, 'read' | 'update' | 'updateWithCiphers' | 'getCipher'>;
type EncryptingVault = Pick<Vault, 'encryptSecrets'>;

export interface DocsMdAuthorizationSnapshot {
  state: State;
  task: Task;
  site: Site;
}

export interface DocsMdPublicationOptions {
  taskId: string;
  siteId: string;
  /** Exact durable intent identity used only to attach a response after submission began. */
  expectedIntent?: DocsMdIntent;
  /** Synchronously rechecks controller-owned authorization immediately before the CAS. */
  assertSubmissionAuthorized(snapshot: DocsMdAuthorizationSnapshot): true;
  now?: () => Date;
}

export interface DocsMdTaskIdentity {
  source: string;
  sourceHash: string;
  requestHash: string;
}

export interface SerializedDocsMdSecret {
  version: 1;
  taskId: string;
  operationId: string;
  id: string;
  publicUrl: string;
  sourceHash: string;
  requestHash: string;
  editToken: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function exactTimestamp(value: string): boolean {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function validPublicId(value: string): boolean {
  return value.length <= 128 && PUBLIC_ID.test(value);
}

function validEditToken(value: string): boolean {
  if (!EDIT_TOKEN.test(value)) return false;
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === 24 && bytes.toString('base64url') === value;
  } catch {
    return false;
  }
}

function expectedPublicUrl(id: string): string {
  if (!validPublicId(id)) throw Error('Docs MD 公开文章身份无效');
  return `${ORIGIN}/${id}`;
}

function expectedRawUrl(id: string): string {
  if (!validPublicId(id)) throw Error('Docs MD 原文身份无效');
  return `${ORIGIN}/raw/${id}`;
}

function markdownHeading(title: string): string {
  // Escaping ASCII punctuation keeps the visible title literal without
  // interpreting reviewed title text as Markdown formatting or a link.
  return '# ' + title.replace(/([!#&*<>@[\\\]_`])/g, '\\$1');
}

/**
 * Docs MD has no separate title field. Preserve an already-reviewed, exact
 * same-title leading ATX H1 once; otherwise prepend one literal escaped H1.
 * A different or setext-style leading H1 is ambiguous and is rejected.
 */
export function docsMdTaskSource(task: Pick<Task, 'draft'>): string | undefined {
  const draft = task.draft;
  if (!draft || typeof draft.title !== 'string' || typeof draft.body !== 'string') return;
  const title = draft.title.trim();
  const body = draft.body.trim();
  if (!title || !body || /[\r\n\u0000-\u001f\u007f]/u.test(title)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body)) return;
  const heading = markdownHeading(title);
  const firstLineEnd = body.indexOf('\n');
  const firstLine = firstLineEnd < 0 ? body : body.slice(0, firstLineEnd).replace(/\r$/, '');
  const secondLine = firstLineEnd < 0 ? '' : body.slice(firstLineEnd + 1).split(/\r?\n/, 1)[0];
  if (/^#(?:\s|$)/.test(firstLine) && firstLine !== heading) return;
  if (/^=+\s*$/.test(secondLine)) return;
  const source = firstLine === heading ? body : `${heading}\n\n${body}`;
  if (source.length > MAX_CONTENT_CHARS
    || Buffer.from(source, 'utf8').toString('utf8') !== source) return;
  const request = JSON.stringify({ content: source, filename: FILENAME, expiry: EXPIRY });
  if (Buffer.byteLength(request, 'utf8') > MAX_REQUEST_BYTES) return;
  return source;
}

export function docsMdTaskIdentity(task: Pick<Task, 'draft'>): DocsMdTaskIdentity | undefined {
  const source = docsMdTaskSource(task);
  if (!source) return;
  const request = JSON.stringify({ content: source, filename: FILENAME, expiry: EXPIRY });
  return { source, sourceHash: sha256(source), requestHash: sha256(request) };
}

function validIntent(intent: DocsMdIntent): boolean {
  return OPERATION_ID.test(intent.operationId) && HASH.test(intent.sourceHash)
    && HASH.test(intent.requestHash) && exactTimestamp(intent.createdAt);
}

function currentBinding(
  state: State,
  taskId: string,
  siteId: string,
  intent: Pick<DocsMdIntent, 'sourceHash' | 'requestHash'>,
): { task: Task; site: Site; identity: DocsMdTaskIdentity } {
  const task = state.tasks.find(item => item.id === taskId);
  const site = state.sites.find(item => item.id === siteId);
  if (!task || !site || task.siteId !== site.id || task.channelId !== 'docs-md'
    || task.sourceDomain !== 'docs-md.com' || task.accountId
    || state.accounts.some(account => account.channelId === 'docs-md')
    || state.accountBindings.some(binding => binding.channelId === 'docs-md')) {
    throw Error('Docs MD 任务绑定已改变');
  }
  const identity = docsMdTaskIdentity(task);
  if (!identity || identity.sourceHash !== intent.sourceHash
    || identity.requestHash !== intent.requestHash) {
    throw Error('Docs MD 原稿已改变');
  }
  return { task, site, identity };
}

function hasForbiddenPendingLifecycleState(task: Task): boolean {
  return task.verifiedAt !== undefined || task.firstLiveAt !== undefined
    || task.linkCheck !== undefined || task.linkRel !== undefined
    || task.publicationMethod !== undefined || task.lastCheckedAt !== undefined
    || task.nextCheckAt !== undefined || task.lostAt !== undefined
    || task.reviewUntil !== undefined || task.reviewKind !== undefined
    || task.consecutiveMissing !== undefined || task.reconcileAttempts !== undefined
    || task.reconcileAfter !== undefined;
}

function hasExternalState(task: Task): boolean {
  return !!(task.docsMd || task.submittedAt || task.publicUrl
    || hasForbiddenPendingLifecycleState(task) || task.status === 'live'
    || task.health && task.health !== 'pending'
    || /(?:docs_md|submitt|publish|receipt|uncertain)/i.test(task.checkpoint ?? ''));
}

function assertBackupCompatibleDraft(task: Task): void {
  const draft = task.draft;
  if (!draft || typeof draft.title !== 'string' || typeof draft.description !== 'string'
    || typeof draft.body !== 'string' || draft.title.length > 30_000
    || draft.description.length > 30_000 || draft.body.length > 30_000) {
    throw Error('Docs MD 原稿超出可备份范围');
  }
}

function assertStoredIntent(task: Task, expected: DocsMdIntent): NonNullable<Task['docsMd']> {
  const saved = task.docsMd;
  if (!saved || saved.operationId !== expected.operationId
    || saved.sourceHash !== expected.sourceHash || saved.requestHash !== expected.requestHash
    || saved.createdAt !== expected.createdAt || !validIntent(saved)
    || !['submitting', 'api_receipt'].includes(saved.stage)
    || task.submittedAt !== saved.createdAt || task.status !== 'review' || task.health !== 'pending') {
    throw Error('Docs MD 提交意图与原任务不一致');
  }
  if (saved.stage === 'submitting') {
    if (saved.id || task.publicUrl || task.checkpoint !== 'docs_md_share_submitting') {
      throw Error('Docs MD 提交意图阶段无效');
    }
  } else if (!saved.id || task.publicUrl !== expectedPublicUrl(saved.id)
    || task.checkpoint !== 'docs_md_api_receipt') {
    throw Error('Docs MD API 回执阶段无效');
  }
  if (hasForbiddenPendingLifecycleState(task)) {
    throw Error('Docs MD API 回执不能标记为公开验收通过');
  }
  return saved;
}

export function parseDocsMdPublicationSecret(value: string): SerializedDocsMdSecret | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const secret = parsed as Record<string, unknown>;
    if (Object.keys(secret).sort().join(',')
      !== 'editToken,id,operationId,publicUrl,requestHash,sourceHash,taskId,version'
      || secret.version !== SECRET_VERSION
      || typeof secret.taskId !== 'string' || !TASK_ID.test(secret.taskId)
      || typeof secret.operationId !== 'string' || !OPERATION_ID.test(secret.operationId)
      || typeof secret.id !== 'string' || !validPublicId(secret.id)
      || secret.publicUrl !== expectedPublicUrl(secret.id)
      || typeof secret.sourceHash !== 'string' || !HASH.test(secret.sourceHash)
      || typeof secret.requestHash !== 'string' || !HASH.test(secret.requestHash)
      || typeof secret.editToken !== 'string' || !validEditToken(secret.editToken)) return;
    return secret as unknown as SerializedDocsMdSecret;
  } catch {
    return;
  }
}

/**
 * The CAS guarantee is scoped to the application's single synchronous Store
 * instance. No cross-process publication claim is made.
 */
export function createDocsMdPublicationPersistence(
  store: StateStore,
  vault: EncryptingVault,
  options: DocsMdPublicationOptions,
): DocsMdPersistence {
  if (!TASK_ID.test(options.taskId) || !TASK_ID.test(options.siteId)) {
    throw Error('Docs MD 任务参数无效');
  }
  const taskId = options.taskId;
  const siteId = options.siteId;
  const authorize = options.assertSubmissionAuthorized;
  const now = options.now;
  let claimedIntent = options.expectedIntent ? { ...options.expectedIntent } : undefined;
  if (claimedIntent && !validIntent(claimedIntent)) throw Error('Docs MD 恢复意图无效');
  const updatedAt = () => (now?.() ?? new Date()).toISOString();

  return {
    async persistIntent(intent) {
      if (claimedIntent) throw Error('Docs MD 恢复上下文禁止创建新提交意图');
      const proposed = { ...intent };
      if (!validIntent(proposed)) throw Error('Docs MD 提交意图无效');
      store.update(state => {
        const { task, site } = currentBinding(state, taskId, siteId, proposed);
        assertBackupCompatibleDraft(task);
        if (hasExternalState(task)) throw Error('Docs MD 任务已有提交记录，禁止重复提交');
        if (!state.settings.autoRun || task.status !== 'running' || site.status !== 'ready') {
          throw Error('Docs MD 任务已暂停或不再允许提交');
        }
        const guard = authorize(structuredClone({ state, task, site }));
        if (guard && typeof (guard as unknown as { then?: unknown }).then === 'function') {
          void Promise.resolve(guard).catch(() => undefined);
          throw Error('Docs MD 同步授权检查未通过');
        }
        if (guard !== true) throw Error('Docs MD 同步授权检查未通过');
        task.docsMd = { ...proposed, stage: 'submitting' };
        task.submittedAt = proposed.createdAt;
        task.checkpoint = 'docs_md_share_submitting';
        task.status = 'review';
        task.health = 'pending';
        task.updatedAt = updatedAt();
        task.message = 'Docs MD 提交意图已保存；结果未核清前不会重发。';
      });
      claimedIntent = proposed;
    },

    async persistReceipt(receipt) {
      const returned = { ...receipt };
      if (!OPERATION_ID.test(returned.operationId) || !validPublicId(returned.id)
        || returned.publicUrl !== expectedPublicUrl(returned.id)
        || returned.rawUrl !== expectedRawUrl(returned.id) || returned.expiresAt !== 0
        || !HASH.test(returned.sourceHash) || !HASH.test(returned.requestHash)) {
        throw Error('Docs MD API 回执无效');
      }
      const expected = claimedIntent && { ...claimedIntent };
      if (!expected || returned.operationId !== expected.operationId
        || returned.sourceHash !== expected.sourceHash
        || returned.requestHash !== expected.requestHash) {
        throw Error('Docs MD API 回执缺少原提交意图');
      }
      store.update(state => {
        const { task } = currentBinding(state, taskId, siteId, expected);
        const saved = assertStoredIntent(task, expected);
        if (saved.stage === 'api_receipt') {
          if (saved.id !== returned.id || task.publicUrl !== returned.publicUrl) {
            throw Error('Docs MD API 回执不能更换文章身份');
          }
          return;
        }
        task.docsMd = { ...saved, stage: 'api_receipt', id: returned.id };
        task.publicUrl = returned.publicUrl;
        task.checkpoint = 'docs_md_api_receipt';
        task.status = 'review';
        task.health = 'pending';
        task.updatedAt = updatedAt();
        task.message = 'Docs MD API 回执已保存；公开 HTML 尚未验收，不计为有效来源。';
      });
    },

    async persistEditTokenAtomically(secret) {
      const returned = { ...secret };
      if (!OPERATION_ID.test(returned.operationId) || !validPublicId(returned.id)
        || !validEditToken(returned.editToken)) {
        throw Error('Docs MD 编辑凭据无效');
      }
      const expected = claimedIntent && { ...claimedIntent };
      if (!expected || returned.operationId !== expected.operationId) {
        throw Error('Docs MD 编辑凭据缺少原提交意图');
      }
      const key = `publication:${taskId}`;
      if (store.getCipher(key)) throw Error('Docs MD 编辑凭据已经保存，禁止替换');
      const before = store.read();
      const { task } = currentBinding(before, taskId, siteId, expected);
      const receipt = assertStoredIntent(task, expected);
      if (receipt.stage !== 'api_receipt' || receipt.id !== returned.id) {
        throw Error('Docs MD 编辑凭据缺少匹配的 API 回执');
      }
      const publicUrl = expectedPublicUrl(returned.id);
      const serialized = JSON.stringify({
        version: SECRET_VERSION,
        taskId,
        operationId: expected.operationId,
        id: returned.id,
        publicUrl,
        sourceHash: expected.sourceHash,
        requestHash: expected.requestHash,
        editToken: returned.editToken,
      } satisfies SerializedDocsMdSecret);
      if (serialized.length > 16_384) throw Error('Docs MD 编辑凭据超出可备份范围');
      let ciphers: Record<string, string>;
      try {
        ciphers = vault.encryptSecrets({ [key]: serialized });
      } catch {
        throw Error('Docs MD 编辑凭据未能加密');
      }
      if (typeof ciphers[key] !== 'string' || !ciphers[key] || ciphers[key] === serialized) {
        throw Error('Docs MD 编辑凭据未能加密');
      }
      store.updateWithCiphers(state => {
        // updateWithCiphers is synchronous. Recheck immediately before its
        // state+cipher transaction so a late same-process value cannot be replaced.
        if (store.getCipher(key)) throw Error('Docs MD 编辑凭据已经保存，禁止替换');
        const { task: current } = currentBinding(state, taskId, siteId, expected);
        const stored = assertStoredIntent(current, expected);
        if (stored.stage !== 'api_receipt' || stored.id !== returned.id
          || current.publicUrl !== publicUrl) {
          throw Error('Docs MD 编辑凭据与 API 回执不一致');
        }
      }, { [key]: ciphers[key] });
    },
  };
}
