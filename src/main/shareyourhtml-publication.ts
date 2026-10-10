import { createHash } from 'node:crypto';
import type {
  ShareYourHtmlIntent,
  ShareYourHtmlPersistence,
  ShareYourHtmlReceipt,
} from '../integrations/shareyourhtml';
import type { Site, Task } from '../shared/types';
import type { State, Store } from './store';
import type { Vault } from './vault';

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const HASH = /^[a-f0-9]{64}$/;
const EDIT_KEY = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_HTML_BYTES = 120_000;
const MAX_REQUEST_BYTES = 200_000;
const SECRET_VERSION = 1;

type StateStore = Pick<Store, 'read' | 'update' | 'updateWithCiphers' | 'getCipher'>;
type EncryptingVault = Pick<Vault, 'encryptSecrets'>;
type ReviewedDraft = NonNullable<Task['draft']>;

export interface ShareYourHtmlAuthorizationSnapshot {
  state: State;
  task: Task;
  site: Site;
  reviewedHtml: string;
  sourceHash: string;
  requestHash: string;
  reviewedDraft: ReviewedDraft;
  reviewedDraftRevision: number;
  siteIdentityHash: string;
}

export interface ShareYourHtmlPublicationOptions {
  taskId: string;
  siteId: string;
  /** Exact immutable HTML bytes already reviewed by a future trusted publisher. */
  reviewedHtml: string;
  /** Exact draft snapshot from which the trusted publisher produced reviewedHtml. */
  reviewedDraft: ReviewedDraft;
  reviewedDraftRevision: number;
  /** Existing durable claim used only to attach an already-returned response. */
  expectedIntent?: ShareYourHtmlIntent;
  /** Called before the claim and again immediately before transport; must stay synchronous. */
  assertSubmissionAuthorized(snapshot: ShareYourHtmlAuthorizationSnapshot): true;
  now?: () => Date;
}

export interface SerializedShareYourHtmlSecret {
  version: 1;
  taskId: string;
  operationId: string;
  slug: string;
  publicUrl: string;
  sourceHash: string;
  requestHash: string;
  reviewedDraftHash: string;
  reviewedDraftRevision: number;
  siteId: string;
  siteIdentityHash: string;
  editKey: string;
}

interface ShareYourHtmlSiteBinding {
  siteId: string;
  siteIdentityHash: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const expectedPublicUrl = (slug: string) => `https://${slug}.shareyourhtml.com`;

function exactTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function sameDraft(left: ReviewedDraft | undefined, right: ReviewedDraft): boolean {
  return !!left && left.title === right.title && left.description === right.description
    && left.body === right.body;
}

export function shareYourHtmlDraftHash(draft: ReviewedDraft): string {
  return sha256(JSON.stringify({ title: draft.title, description: draft.description, body: draft.body }));
}

export function shareYourHtmlSiteIdentityHash(site: Pick<Site, 'id' | 'domain' | 'url'>): string {
  return sha256(JSON.stringify({ id: site.id, domain: site.domain, url: site.url }));
}

function exactIdentity(html: string, slug: string): { sourceHash: string; requestHash: string } {
  if (!SLUG.test(slug) || typeof html !== 'string' || !html.trim()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(html)
    || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES
    || Buffer.from(html, 'utf8').toString('utf8') !== html) {
    throw Error('ShareYourHTML 已审核 HTML 无效');
  }
  const request = JSON.stringify({ slug, html, expiry: 'never' });
  if (Buffer.byteLength(request, 'utf8') > MAX_REQUEST_BYTES) {
    throw Error('ShareYourHTML 请求超出本地限制');
  }
  return { sourceHash: sha256(html), requestHash: sha256(request) };
}

function validIntent(intent: ShareYourHtmlIntent): boolean {
  return OPERATION_ID.test(intent.operationId) && SLUG.test(intent.slug)
    && HASH.test(intent.sourceHash) && HASH.test(intent.requestHash)
    && exactTimestamp(intent.createdAt);
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
  return !!(task.shareYourHtml || task.submittedAt || task.publicUrl
    || hasForbiddenPendingLifecycleState(task) || task.status === 'live'
    || task.health && task.health !== 'pending'
    || /(?:shareyourhtml|submitt|publish|receipt|uncertain)/i.test(task.checkpoint ?? ''));
}

function assertBackupCompatibleDraft(task: Task): void {
  const draft = task.draft;
  if (!draft || typeof draft.title !== 'string' || typeof draft.description !== 'string'
    || typeof draft.body !== 'string' || draft.title.length > 30_000
    || draft.description.length > 30_000 || draft.body.length > 30_000) {
    throw Error('ShareYourHTML 原稿超出可备份范围');
  }
}

function assertUniqueClaim(state: State, taskId: string, intent: ShareYourHtmlIntent): void {
  for (const task of state.tasks) {
    const claim = task.shareYourHtml;
    if (!claim) continue;
    if (task.id === taskId || claim.operationId === intent.operationId || claim.slug === intent.slug) {
      throw Error('ShareYourHTML 任务、操作或 slug 已有永久提交记录');
    }
  }
}

function currentBinding(
  state: State,
  taskId: string,
  siteId: string,
  intent: ShareYourHtmlIntent,
  reviewedHtml: string,
  reviewedDraft: ReviewedDraft,
  reviewedDraftRevision: number,
  expectedSite?: ShareYourHtmlSiteBinding,
): { task: Task; site: Site; sourceHash: string; requestHash: string; reviewedDraftHash: string; siteIdentityHash: string } {
  const task = state.tasks.find(item => item.id === taskId);
  const site = state.sites.find(item => item.id === siteId);
  const identity = exactIdentity(reviewedHtml, intent.slug);
  if (!task || !site || task.siteId !== site.id || task.channelId !== 'shareyourhtml'
    || task.sourceDomain !== 'shareyourhtml.com' || task.accountId
    || state.accounts.some(account => account.channelId === 'shareyourhtml')
    || state.accountBindings.some(binding => binding.channelId === 'shareyourhtml')) {
    throw Error('ShareYourHTML 任务绑定已改变');
  }
  if (!sameDraft(task.draft, reviewedDraft) || (task.draftRevision ?? 0) !== reviewedDraftRevision) {
    throw Error('ShareYourHTML 原稿或修订号已改变');
  }
  const siteIdentityHash = shareYourHtmlSiteIdentityHash(site);
  if (expectedSite && (expectedSite.siteId !== site.id
    || expectedSite.siteIdentityHash !== siteIdentityHash)) {
    throw Error('ShareYourHTML 来源站点身份已改变');
  }
  if (identity.sourceHash !== intent.sourceHash || identity.requestHash !== intent.requestHash) {
    throw Error('ShareYourHTML 已审核 HTML 或请求快照已改变');
  }
  return { task, site, ...identity, reviewedDraftHash: shareYourHtmlDraftHash(reviewedDraft),
    siteIdentityHash };
}

function assertStoredIntent(
  task: Task,
  expected: ShareYourHtmlIntent,
  reviewedDraftHash: string,
  reviewedDraftRevision: number,
  expectedSite: ShareYourHtmlSiteBinding,
): NonNullable<Task['shareYourHtml']> {
  const saved = task.shareYourHtml;
  if (!saved || saved.operationId !== expected.operationId || saved.slug !== expected.slug
    || saved.sourceHash !== expected.sourceHash || saved.requestHash !== expected.requestHash
    || saved.createdAt !== expected.createdAt || !validIntent(saved)
    || saved.reviewedDraftHash !== reviewedDraftHash
    || saved.reviewedDraftRevision !== reviewedDraftRevision
    || saved.siteId !== expectedSite.siteId
    || saved.siteIdentityHash !== expectedSite.siteIdentityHash
    || saved.requestedExpiry !== 'never' || saved.publicVerification !== 'pending'
    || !['submitting', 'api_receipt'].includes(saved.stage)
    || task.submittedAt !== saved.createdAt || task.status !== 'review' || task.health !== 'pending') {
    throw Error('ShareYourHTML 提交意图与原任务不一致');
  }
  if (saved.stage === 'submitting') {
    if (task.publicUrl || task.checkpoint !== 'shareyourhtml_create_submitting') {
      throw Error('ShareYourHTML 提交意图阶段无效');
    }
  } else if (task.publicUrl !== expectedPublicUrl(saved.slug)
    || task.checkpoint !== 'shareyourhtml_api_receipt') {
    throw Error('ShareYourHTML API 回执阶段无效');
  }
  if (hasForbiddenPendingLifecycleState(task)) {
    throw Error('ShareYourHTML API 回执不能标记为公开验收通过');
  }
  return saved;
}

export function parseShareYourHtmlPublicationSecret(
  value: string,
): SerializedShareYourHtmlSecret | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const secret = parsed as Record<string, unknown>;
    if (Object.keys(secret).sort().join(',')
      !== 'editKey,operationId,publicUrl,requestHash,reviewedDraftHash,reviewedDraftRevision,siteId,siteIdentityHash,slug,sourceHash,taskId,version'
      || secret.version !== SECRET_VERSION
      || typeof secret.taskId !== 'string' || !TASK_ID.test(secret.taskId)
      || typeof secret.operationId !== 'string' || !OPERATION_ID.test(secret.operationId)
      || typeof secret.slug !== 'string' || !SLUG.test(secret.slug)
      || secret.publicUrl !== expectedPublicUrl(secret.slug)
      || typeof secret.sourceHash !== 'string' || !HASH.test(secret.sourceHash)
      || typeof secret.requestHash !== 'string' || !HASH.test(secret.requestHash)
      || typeof secret.reviewedDraftHash !== 'string' || !HASH.test(secret.reviewedDraftHash)
      || typeof secret.reviewedDraftRevision !== 'number'
      || !Number.isSafeInteger(secret.reviewedDraftRevision) || secret.reviewedDraftRevision < 0
      || typeof secret.siteId !== 'string' || !TASK_ID.test(secret.siteId)
      || typeof secret.siteIdentityHash !== 'string' || !HASH.test(secret.siteIdentityHash)
      || typeof secret.editKey !== 'string' || !EDIT_KEY.test(secret.editKey)) return;
    return secret as unknown as SerializedShareYourHtmlSecret;
  } catch {
    return;
  }
}

/**
 * This persistence boundary intentionally accepts reviewed HTML rather than
 * rendering Markdown. A future trusted controller must render and review those
 * exact bytes before constructing it. The CAS guarantee is limited to the
 * application's single synchronous Store instance; it is not cross-process CAS.
 */
export function createShareYourHtmlPublicationPersistence(
  store: StateStore,
  vault: EncryptingVault,
  options: ShareYourHtmlPublicationOptions,
): ShareYourHtmlPersistence {
  if (!TASK_ID.test(options.taskId) || !TASK_ID.test(options.siteId)
    || !Number.isSafeInteger(options.reviewedDraftRevision)
    || options.reviewedDraftRevision < 0) {
    throw Error('ShareYourHTML 任务参数无效');
  }
  const taskId = options.taskId;
  const siteId = options.siteId;
  const reviewedHtml = options.reviewedHtml;
  const reviewedDraft = structuredClone(options.reviewedDraft);
  const reviewedDraftRevision = options.reviewedDraftRevision;
  const reviewedDraftHash = shareYourHtmlDraftHash(reviewedDraft);
  const authorize = options.assertSubmissionAuthorized;
  const now = options.now;
  let claimedIntent = options.expectedIntent ? { ...options.expectedIntent } : undefined;
  let claimedSiteBinding: ShareYourHtmlSiteBinding | undefined;
  if (claimedIntent && !validIntent(claimedIntent)) {
    throw Error('ShareYourHTML 恢复意图无效');
  }
  const updatedAt = () => (now?.() ?? new Date()).toISOString();

  return {
    async persistIntent(intent) {
      if (claimedIntent) throw Error('ShareYourHTML 恢复上下文禁止创建新提交意图');
      const proposed = { ...intent };
      if (!validIntent(proposed)) throw Error('ShareYourHTML 提交意图无效');
      store.update(state => {
        assertUniqueClaim(state, taskId, proposed);
        const binding = currentBinding(state, taskId, siteId, proposed, reviewedHtml,
          reviewedDraft, reviewedDraftRevision);
        assertBackupCompatibleDraft(binding.task);
        if (hasExternalState(binding.task)) {
          throw Error('ShareYourHTML 任务已有提交记录，禁止重复提交');
        }
        if (!state.settings.autoRun || binding.task.status !== 'running'
          || binding.site.status !== 'ready') {
          throw Error('ShareYourHTML 任务已暂停或不再允许提交');
        }
        const guard = authorize(structuredClone({
          state,
          task: binding.task,
          site: binding.site,
          reviewedHtml,
          sourceHash: binding.sourceHash,
          requestHash: binding.requestHash,
          reviewedDraft,
          reviewedDraftRevision,
          siteIdentityHash: binding.siteIdentityHash,
        }));
        if (guard && typeof (guard as unknown as { then?: unknown }).then === 'function') {
          void Promise.resolve(guard).catch(() => undefined);
          throw Error('ShareYourHTML 同步授权检查未通过');
        }
        if (guard !== true) throw Error('ShareYourHTML 同步授权检查未通过');
        // A trusted callback is expected to be side-effect free. Detect a
        // re-entrant Store write so this outer update cannot overwrite it from
        // the older draft snapshot.
        if (JSON.stringify(store.read()) !== JSON.stringify(state)) {
          throw Error('ShareYourHTML 授权期间任务状态已改变');
        }
        binding.task.shareYourHtml = {
          ...proposed,
          stage: 'submitting',
          requestedExpiry: 'never',
          publicVerification: 'pending',
          reviewedDraftRevision,
          reviewedDraftHash,
          siteId: binding.site.id,
          siteIdentityHash: binding.siteIdentityHash,
        };
        binding.task.submittedAt = proposed.createdAt;
        binding.task.checkpoint = 'shareyourhtml_create_submitting';
        binding.task.status = 'review';
        binding.task.health = 'pending';
        binding.task.updatedAt = updatedAt();
        binding.task.message = 'ShareYourHTML 提交意图已保存；结果未核清前不会重发。';
      });
      claimedIntent = proposed;
      claimedSiteBinding = { siteId, siteIdentityHash: shareYourHtmlSiteIdentityHash(
        store.read().sites.find(site => site.id === siteId)!,
      ) };
    },

    assertReadyToSubmit(intent) {
      const expected = claimedIntent && { ...claimedIntent };
      if (!expected || !validIntent(intent) || intent.operationId !== expected.operationId
        || intent.slug !== expected.slug || intent.sourceHash !== expected.sourceHash
        || intent.requestHash !== expected.requestHash || intent.createdAt !== expected.createdAt) {
        throw Error('ShareYourHTML 最终提交闸缺少原提交意图');
      }
      const state = store.read();
      const savedTask = state.tasks.find(task => task.id === taskId);
      const saved = savedTask?.shareYourHtml;
      const expectedSite = claimedSiteBinding ?? (saved ? {
        siteId: saved.siteId,
        siteIdentityHash: saved.siteIdentityHash,
      } : undefined);
      if (!expectedSite) throw Error('ShareYourHTML 最终提交闸缺少来源站点身份');
      const binding = currentBinding(state, taskId, siteId, expected, reviewedHtml,
        reviewedDraft, reviewedDraftRevision, expectedSite);
      const stored = assertStoredIntent(binding.task, expected, reviewedDraftHash,
        reviewedDraftRevision, expectedSite);
      if (stored.stage !== 'submitting' || !state.settings.autoRun || binding.site.status !== 'ready') {
        throw Error('ShareYourHTML 最终提交授权已撤销');
      }
      const guard = authorize(structuredClone({ state, task: binding.task, site: binding.site,
        reviewedHtml, sourceHash: binding.sourceHash, requestHash: binding.requestHash,
        reviewedDraft, reviewedDraftRevision, siteIdentityHash: binding.siteIdentityHash }));
      if (guard && typeof (guard as unknown as { then?: unknown }).then === 'function') {
        void Promise.resolve(guard).catch(() => undefined);
        throw Error('ShareYourHTML 最终同步授权检查未通过');
      }
      if (guard !== true || JSON.stringify(store.read()) !== JSON.stringify(state)) {
        throw Error('ShareYourHTML 最终同步授权检查未通过');
      }
      claimedSiteBinding = expectedSite;
      return true;
    },

    async persistCreatedAtomically(value) {
      const returned: { receipt: ShareYourHtmlReceipt; editKey: string } = {
        receipt: { ...value.receipt },
        editKey: value.editKey,
      };
      const receipt = returned.receipt;
      if (!validIntent(receipt) || receipt.publicUrl !== expectedPublicUrl(receipt.slug)
        || receipt.requestedExpiry !== 'never' || receipt.publicVerification !== 'pending'
        || !EDIT_KEY.test(returned.editKey)) {
        throw Error('ShareYourHTML API 回执或编辑凭据无效');
      }
      const expected = claimedIntent && { ...claimedIntent };
      if (!expected || receipt.operationId !== expected.operationId
        || receipt.slug !== expected.slug || receipt.sourceHash !== expected.sourceHash
        || receipt.requestHash !== expected.requestHash || receipt.createdAt !== expected.createdAt) {
        throw Error('ShareYourHTML API 回执缺少原提交意图');
      }
      const key = `publication:${taskId}`;
      if (store.getCipher(key)) throw Error('ShareYourHTML 编辑凭据已经保存，禁止替换');

      const savedTask = store.read().tasks.find(task => task.id === taskId);
      const savedClaim = savedTask?.shareYourHtml;
      const expectedSite = claimedSiteBinding ?? (savedClaim ? {
        siteId: savedClaim.siteId,
        siteIdentityHash: savedClaim.siteIdentityHash,
      } : undefined);
      if (!expectedSite) throw Error('ShareYourHTML API 回执缺少来源站点身份');

      const assertCurrentSubmitting = (state: State): Task => {
        const binding = currentBinding(state, taskId, siteId, expected, reviewedHtml,
          reviewedDraft, reviewedDraftRevision, expectedSite);
        const saved = assertStoredIntent(binding.task, expected, reviewedDraftHash,
          reviewedDraftRevision, expectedSite);
        if (saved.stage !== 'submitting') {
          throw Error('ShareYourHTML API 回执不能替换已有结果');
        }
        for (const task of state.tasks) {
          if (task.id === taskId || !task.shareYourHtml) continue;
          if (task.shareYourHtml.operationId === expected.operationId
            || task.shareYourHtml.slug === expected.slug) {
            throw Error('ShareYourHTML 操作或 slug 已被其他任务占用');
          }
        }
        return binding.task;
      };

      assertCurrentSubmitting(store.read());
      const serialized = JSON.stringify({
        version: SECRET_VERSION,
        taskId,
        operationId: expected.operationId,
        slug: expected.slug,
        publicUrl: receipt.publicUrl,
        sourceHash: expected.sourceHash,
        requestHash: expected.requestHash,
        reviewedDraftHash,
        reviewedDraftRevision,
        siteId: expectedSite.siteId,
        siteIdentityHash: expectedSite.siteIdentityHash,
        editKey: returned.editKey,
      } satisfies SerializedShareYourHtmlSecret);
      if (serialized.length > 16_384) throw Error('ShareYourHTML 编辑凭据超出可备份范围');
      let ciphers: Record<string, string>;
      try {
        ciphers = vault.encryptSecrets({ [key]: serialized });
      } catch {
        throw Error('ShareYourHTML 编辑凭据未能加密');
      }
      if (typeof ciphers[key] !== 'string' || !ciphers[key] || ciphers[key] === serialized) {
        throw Error('ShareYourHTML 编辑凭据未能加密');
      }

      if (store.getCipher(key)) throw Error('ShareYourHTML 编辑凭据已经保存，禁止替换');
      assertCurrentSubmitting(store.read());
      store.updateWithCiphers(state => {
        // updateWithCiphers serializes this callback and the state+cipher commit
        // in the app's single Store. It does not claim cross-process isolation.
        if (store.getCipher(key)) throw Error('ShareYourHTML 编辑凭据已经保存，禁止替换');
        const task = assertCurrentSubmitting(state);
        task.shareYourHtml = { ...task.shareYourHtml!, stage: 'api_receipt' };
        task.publicUrl = receipt.publicUrl;
        task.checkpoint = 'shareyourhtml_api_receipt';
        task.status = 'review';
        task.health = 'pending';
        task.updatedAt = updatedAt();
        task.message = 'ShareYourHTML API 回执与加密编辑凭据已保存；公开页面尚未验收。';
      }, { [key]: ciphers[key] });
    },
  };
}
