import type { Channel, Site, Task } from '../shared/types';
import { eligibilityFor } from '../integrations/eligibility';
import {
  renderShareYourHtmlArticle,
  type RenderedShareYourHtmlArticle,
} from '../integrations/shareyourhtml-article';
import {
  createShareYourHtmlPage,
  type ShareYourHtmlDependencies,
  type ShareYourHtmlResult,
} from '../integrations/shareyourhtml';
import { publicationOpportunity } from '../shared/publication';
import { isArticleTopicUrl } from '../shared/topic-policy';
import {
  ARTICLE_REVIEW_CONTRACT_VERSION,
  articleReviewStillValid,
} from './article-review';
import { createShareYourHtmlPublicationPersistence } from './shareyourhtml-publication';
import type { State, Store } from './store';
import type { Vault } from './vault';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTENT_REVIEW_CHECKS = [
  'factualAccuracy', 'authorRelationship', 'affiliateDisclosure',
  'independentValue', 'financialSafety',
] as const;

type StateStore = Pick<Store, 'read' | 'update' | 'updateWithCiphers' | 'getCipher'>;
type EncryptingVault = Pick<Vault, 'encryptSecrets'>;

/**
 * Future Controller wiring must resolve the channel afresh from the supplied
 * Store snapshot (catalog + custom channels + metrics), never retain a Channel
 * object from a previous turn. ShareYourHTML is intentionally not enabled in
 * the production catalog by this unit.
 */
export type ShareYourHtmlChannelResolver = (
  state: Readonly<State>,
  channelId: 'shareyourhtml',
) => Channel | undefined;

export interface ShareYourHtmlReviewedPublicationOptions {
  taskId: string;
  resolveChannel: ShareYourHtmlChannelResolver;
  now?: () => Date;
}

interface TrustedSnapshot {
  state: State;
  task: Task;
  site: Site;
  channel: Channel;
  targetUrl: string;
  rendered: RenderedShareYourHtmlArticle;
}

function exactTimestamp(value: string | undefined): Date | undefined {
  if (!value) return;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? parsed : undefined;
}

function resolveCurrentChannel(
  resolver: ShareYourHtmlChannelResolver,
  state: State,
): Channel {
  let channel: Channel | undefined;
  try {
    channel = resolver(structuredClone(state), 'shareyourhtml');
  } catch {
    throw Error('ShareYourHTML 当前渠道解析失败');
  }
  if (!channel || channel.id !== 'shareyourhtml' || channel.domain !== 'shareyourhtml.com'
    || channel.kind !== 'article' || channel.automation !== 'api'
    || channel.articleRequired !== true || channel.accountRequired !== false
    || channel.emailRequired !== false || channel.free !== 'yes'
    || channel.provenance !== 'built-in' || channel.enabled !== true
    || state.settings.channelOverrides[channel.id] === false) {
    throw Error('ShareYourHTML 当前渠道不符合自动文章发布条件');
  }
  return structuredClone(channel);
}

function reviewedTarget(task: Task, site: Site): string {
  const target = task.topicUrl ?? site.url;
  if (task.topicUrl) {
    if (!isArticleTopicUrl(task.topicUrl, site)
      || !site.topics?.some(topic => topic.url === task.topicUrl)) {
      throw Error('ShareYourHTML 当前审核主题绑定无效');
    }
  }
  return target;
}

function assertReview(task: Task, site: Site, channel: Channel, state: State, now: Date): void {
  const review = task.articleReview;
  if (!articleReviewStillValid(task, site, channel, state.settings)
    || review?.reviewContractVersion !== ARTICLE_REVIEW_CONTRACT_VERSION
    || review.reasonCode !== 'passed' || !review.checks
    || !CONTENT_REVIEW_CHECKS.every(check => review.checks![check] === 'pass')
    // ShareYourHTML is not an existing official-guidance exception. Its current
    // proposal therefore requires a fully passed channel-rules check.
    || review.checks.channelRules !== 'pass') {
    throw Error('ShareYourHTML 当前稿件没有有效的 AI 审核');
  }
  const reviewedAt = exactTimestamp(review.reviewedAt);
  const draftUpdatedAt = task.draftUpdatedAt ? exactTimestamp(task.draftUpdatedAt) : undefined;
  if (!reviewedAt || reviewedAt.getTime() > now.getTime()
    || (task.draftUpdatedAt && !draftUpdatedAt)
    || (draftUpdatedAt && reviewedAt.getTime() < draftUpdatedAt.getTime())) {
    throw Error('ShareYourHTML 当前稿件审核时间无效');
  }
  if (!Array.isArray(review.evidenceUrls) || !review.evidenceUrls.length
    || review.evidenceUrls.some(value => typeof value !== 'string' || value.length > 2_048)) {
    throw Error('ShareYourHTML 当前稿件审核证据无效');
  }
}

function assertClaimPhase(task: Task, operationId: string, slug: string,
  rendered: RenderedShareYourHtmlArticle, phase: 'initial' | 'guard'): void {
  const claim = task.shareYourHtml;
  if (!claim) {
    if (task.status !== 'running' || task.submittedAt || task.publicUrl) {
      throw Error('ShareYourHTML 当前任务状态不允许首次提交');
    }
    return;
  }
  if (phase === 'initial') {
    throw Error('ShareYourHTML 当前任务已有永久提交记录');
  }
  if (claim.stage !== 'submitting' || task.status !== 'review'
    || claim.operationId !== operationId || claim.slug !== slug
    || claim.sourceHash !== rendered.sourceHash || claim.requestHash !== rendered.requestHash
    || task.checkpoint !== 'shareyourhtml_create_submitting' || task.publicUrl) {
    throw Error('ShareYourHTML 当前任务已有不同的永久提交记录');
  }
}

function trustedSnapshot(
  store: StateStore,
  taskId: string,
  resolver: ShareYourHtmlChannelResolver,
  now: Date,
  operationId: string,
  slug: string,
  phase: 'initial' | 'guard',
): TrustedSnapshot {
  const state = store.read();
  const task = state.tasks.find(item => item.id === taskId);
  if (!task || task.channelId !== 'shareyourhtml' || task.sourceDomain !== 'shareyourhtml.com'
    || task.accountId || !task.draft || !Number.isSafeInteger(task.draftRevision ?? 0)
    || (task.draftRevision ?? 0) < 0) {
    throw Error('ShareYourHTML 当前任务绑定无效');
  }
  const site = state.sites.find(item => item.id === task.siteId);
  if (!site || site.status !== 'ready' || !state.settings.autoRun) {
    throw Error('ShareYourHTML 当前站点或自动执行状态不允许提交');
  }
  const channel = resolveCurrentChannel(resolver, state);
  if (!eligibilityFor(site, channel).eligible) {
    throw Error('ShareYourHTML 当前站点不符合渠道资格');
  }
  const scheduledAt = exactTimestamp(task.scheduledAt);
  if (!scheduledAt || scheduledAt.getTime() > now.getTime()) {
    throw Error('ShareYourHTML 当前任务尚未到执行时间');
  }
  assertReview(task, site, channel, state, now);
  const opportunity = publicationOpportunity(site, channel,
    state.tasks.filter(item => item.id !== task.id), now, state.settings.timezone);
  if (!opportunity.allowed || !opportunity.scheduledAt
    || new Date(opportunity.scheduledAt).getTime() > now.getTime()) {
    throw Error('ShareYourHTML 当前发布节奏不允许提交');
  }
  const targetUrl = reviewedTarget(task, site);
  const rendered = renderShareYourHtmlArticle({
    draft: task.draft,
    targetUrl,
    language: site.language,
    slug,
  });
  assertClaimPhase(task, operationId, slug, rendered, phase);
  return { state, task, site, channel, targetUrl, rendered };
}

/**
 * Converts only the Store's currently reviewed draft into HTML and submits it
 * through the durable Cycle 67 boundary. This helper is not wired to Controller
 * or the channel catalog; that integration remains an explicit later step.
 */
export function submitReviewedShareYourHtmlPublication(
  store: StateStore,
  vault: EncryptingVault,
  options: ShareYourHtmlReviewedPublicationOptions,
  dependencies: ShareYourHtmlDependencies = {},
): Promise<ShareYourHtmlResult> {
  if (!UUID.test(options.taskId)) throw Error('ShareYourHTML 任务标识无效');
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw Error('ShareYourHTML 当前时间无效');
  const fixedNow = new Date(now.getTime());
  const compactId = options.taskId.toLowerCase().replaceAll('-', '');
  const operationId = `shareyourhtml_${compactId}`;
  const slug = `lf-${compactId}`;
  const initial = trustedSnapshot(store, options.taskId, options.resolveChannel,
    fixedNow, operationId, slug, 'initial');
  const persistence = createShareYourHtmlPublicationPersistence(store, vault, {
    taskId: initial.task.id,
    siteId: initial.site.id,
    reviewedHtml: initial.rendered.html,
    reviewedDraft: structuredClone(initial.task.draft!),
    reviewedDraftRevision: initial.task.draftRevision ?? 0,
    now: () => new Date(fixedNow),
    assertSubmissionAuthorized() {
      // Deliberately re-read and re-render. Cycle 67 calls this synchronously
      // before the claim and again immediately before transport.
      const current = trustedSnapshot(store, options.taskId, options.resolveChannel,
        fixedNow, operationId, slug, 'guard');
      if (current.site.id !== initial.site.id || current.targetUrl !== initial.targetUrl
        || current.rendered.html !== initial.rendered.html
        || current.rendered.sourceHash !== initial.rendered.sourceHash
        || current.rendered.requestHash !== initial.rendered.requestHash) {
        throw Error('ShareYourHTML 当前审核内容或目标已经改变');
      }
      return true;
    },
  });
  return createShareYourHtmlPage({ operationId, slug, html: initial.rendered.html, reviewed: true },
    persistence, { ...dependencies, now: () => new Date(fixedNow) });
}
