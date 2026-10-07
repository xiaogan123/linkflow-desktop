import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/main/controller';
import { Store } from '../src/main/store';
import { CHANNELS } from '../src/integrations/catalog';
import { runParagraphTask, paragraphTesting } from '../src/integrations/paragraph';
import { runBlueskyTask } from '../src/integrations/bluesky';
import { articleContentHash, articleContextHash } from '../src/main/article-review';
import type { Vault } from '../src/main/vault';
import type { Account, ArticleReview, ExecutionContext, Site, Task } from '../src/shared/types';

const NOW = '2026-10-07T04:05:06.789Z';
const SITE_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const BINDING_ID = '44444444-4444-4444-8444-444444444444';
const PARAGRAPH_PUBLICATION_ID = 'BMV6abfvCSUl51ErCVzd';
const PARAGRAPH_OWNER_ID = 'AeAOtR8TqKWyzG5apA1R';
const PARAGRAPH_SLUG = 'fixture-notes';
const PARAGRAPH_URL = `https://paragraph.com/@${PARAGRAPH_SLUG}/`;
const PARAGRAPH_API_KEY = 'synthetic-paragraph-api-key';
const BLUESKY_DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const BLUESKY_HANDLE = 'fixture.bsky.social';
const BLUESKY_PASSWORD = 'abcd-efgh-ijkl-mnop';
const BLUESKY_ACCESS = 'synthetic.access.token.for-tests-only';
const BLUESKY_REFRESH = 'synthetic.refresh.token.for-tests-only';
const TARGET = 'https://example.com/guides/risk-checklist';
const ARTICLE_BODY = [
  `A reproducible review starts by recording the exact inputs, source dates, and failure conditions. The maintained checklist at [the operator's site](${TARGET}) shows how to repeat each check and distinguish observations from assumptions. The publication is operated by Example Lab and the commercial relationship is disclosed here.`,
  'Readers should compare current eligibility terms, failure behavior, and operational constraints before making a decision. Example Lab may receive a commission from a relevant referral, but that relationship does not change the listed limitations or the steps used to reproduce each observation.',
].join('\n\n');
const SOCIAL_BODY = `风险管理的一个实用方法，是先记录假设、数据时间和失效条件，再比较结果。这份清单提供可复核步骤： ${TARGET}\n\n商业关系披露：该站点可能从合作链接中获得收益，不影响文中风险说明。`;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function memoryVault(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const vault = {
    ready: true,
    available: () => true,
    get: async (key: string) => values.get(key),
    set: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); },
  } as unknown as Vault;
  return { values, vault };
}

function baseSite(overrides: Partial<Site> = {}): Site {
  return {
    id: SITE_ID,
    domain: 'example.com',
    url: 'https://example.com/',
    email: 'owner@example.com',
    name: 'Example Lab',
    description: 'Original educational guides with reproducible checks.',
    category: 'content',
    language: 'en',
    monthlyTarget: 1,
    status: 'ready',
    createdAt: NOW,
    topicsCheckedAt: NOW,
    ...overrides,
  };
}

function baseTask(channelId = 'telegraph', overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    siteId: SITE_ID,
    channelId,
    sourceDomain: CHANNELS.find(channel => channel.id === channelId)?.domain ?? 'example.invalid',
    status: 'queued',
    createdAt: NOW,
    scheduledAt: '2020-01-01T00:00:00.000Z',
    updatedAt: NOW,
    attempts: 0,
    message: 'Synthetic fixture',
    draft: {
      title: 'A reviewable checklist',
      description: 'Synthetic educational checklist',
      body: 'Use documented checks and record the source date. We operate this educational website.',
    },
    draftRevision: 1,
    ...overrides,
  };
}

function configureOnly(store: Store, channelId: string): void {
  store.update(state => {
    state.settings.autoRun = true;
    state.settings.articleReviewMode = 'ai';
    state.settings.channelOverrides = Object.fromEntries(CHANNELS.map(channel => [channel.id, channel.id === channelId]));
  });
}

function reviewFor(task: Task, site: Site, status: ArticleReview['status']): ArticleReview {
  const channel = CHANNELS.find(item => item.id === task.channelId)!;
  return {
    status,
    reason: status === 'passed' ? 'Independent fixture review passed.' : 'Remove the unsupported claim.',
    reasonCode: status === 'passed' ? 'passed' : 'content_rejected',
    reviewedAt: NOW,
    evidenceUrls: [site.url, channel.rulesUrl],
    draftRevision: task.draftRevision ?? 0,
    contentHash: articleContentHash(task),
    contextHash: articleContextHash(site, channel, storeSettingsForReview),
  };
}

// All controller fixtures use these exact settings before the review helper is called.
const reviewSettingsStore = new Store(':memory:');
configureOnly(reviewSettingsStore, 'telegraph');
const storeSettingsForReview = reviewSettingsStore.read().settings;
reviewSettingsStore.close();

function controllerStore(task: Task): Store {
  const store = new Store(':memory:');
  configureOnly(store, 'telegraph');
  store.update(state => {
    state.sites = [baseSite()];
    state.tasks = [task];
  });
  return store;
}

test('automatic repair is not scheduled when fewer than two task AI calls remain', async () => {
  const originalDraft = {
    title: 'A reviewable checklist',
    description: 'Synthetic educational checklist',
    body: 'Use documented checks and record the source date. We operate this educational website. guaranteed returns',
  };
  const task = baseTask('telegraph', { draft: originalDraft, cost: { aiCalls: 5 } });
  const store = controllerStore(task);
  const { vault } = memoryVault();
  let providerCalls = 0;
  let reviewCalls = 0;
  const rejected = reviewFor(task, baseSite(), 'failed');
  const controller = new Controller(store, vault, 'synthetic-memory-only', {
    aiFactory: (_settings, _vault, onCall) => ({
      json: async <T>() => { onCall?.(); providerCalls++; return originalDraft as T; },
    }),
    reviewArticle: async () => { reviewCalls++; return rejected; },
    executeTask: async () => ({ status: 'review', message: 'unexpected fixture publication' }),
  });
  controller.runtime.aiReady = true;
  try {
    await controller.tick();
    const saved = store.read().tasks[0];
    assert.equal(reviewCalls, 1);
    assert.equal(providerCalls, 0);
    assert.equal(saved.id, TASK_ID);
    assert.equal(saved.status, 'failed');
    assert.equal(saved.checkpoint, 'system_wait');
    assert.match(saved.message, /预算.*修稿.*复核|修稿.*复核.*预算/);
    assert.deepEqual(saved.draft, originalDraft);
    assert.deepEqual(saved.articleReview, rejected);
    assert.deepEqual(saved.cost, { aiCalls: 5 });
  } finally { store.close(); }
});

test('queued repair rechecks its two-call budget before any provider call and never resets a full budget', async () => {
  for (const aiCalls of [5, 6]) {
    const site = baseSite();
    const task = baseTask('telegraph', { checkpoint: 'article_repair', cost: { aiCalls } });
    task.articleReview = reviewFor(task, site, 'failed');
    const original = structuredClone(task);
    const store = controllerStore(task);
    const { vault } = memoryVault();
    let providerCalls = 0;
    const controller = new Controller(store, vault, 'synthetic-memory-only', {
      collectArticleEvidence: async () => [],
      aiFactory: (_settings, _vault, onCall) => ({
        json: async <T>() => { onCall?.(); providerCalls++; return original.draft as T; },
      }),
      reviewArticle: async () => { throw new Error('review must not run without a two-call budget'); },
      executeTask: async () => ({ status: 'review', message: 'unexpected fixture publication' }),
    });
    controller.runtime.aiReady = true;
    try {
      await controller.tick();
      const state = store.read();
      const saved = state.tasks[0];
      assert.equal(providerCalls, 0, `provider calls at task cost ${aiCalls}`);
      assert.equal(Object.values(state.usage).reduce((sum, value) => sum + value, 0), 0);
      assert.equal(saved.id, original.id);
      assert.equal(saved.status, 'failed');
      assert.equal(saved.checkpoint, 'system_wait');
      assert.match(saved.message, /预算.*修稿.*复核|修稿.*复核.*预算/);
      assert.deepEqual(saved.draft, original.draft);
      assert.deepEqual(saved.articleReview, original.articleReview);
      assert.deepEqual(saved.cost, { aiCalls });
      assert.equal(saved.articleRepairAttempts, original.articleRepairAttempts);
      assert.equal(saved.attempts, original.attempts);
    } finally { store.close(); }
  }
});

test('exactly two remaining calls allow one repair and one independent review', async () => {
  const site = baseSite();
  const task = baseTask('telegraph', { checkpoint: 'article_repair', cost: { aiCalls: 4 } });
  task.articleReview = reviewFor(task, site, 'failed');
  const store = controllerStore(task);
  const { vault } = memoryVault();
  let providerCalls = 0;
  let executions = 0;
  const repairedDraft = { ...task.draft!, body: `${task.draft!.body} Revised using verified evidence.` };
  const controller = new Controller(store, vault, 'synthetic-memory-only', {
    collectArticleEvidence: async () => [],
    aiFactory: (_settings, _vault, onCall) => ({
      json: async <T>() => { onCall?.(); providerCalls++; return repairedDraft as T; },
    }),
    reviewArticle: async (current, currentSite, currentChannel, settings, ai) => {
      await ai.json('synthetic independent review', {});
      return {
        status: 'passed', reason: 'Independent fixture review passed.', reasonCode: 'passed', reviewedAt: NOW,
        evidenceUrls: [currentSite.url, currentChannel.rulesUrl], draftRevision: current.draftRevision ?? 0,
        contentHash: articleContentHash(current), contextHash: articleContextHash(currentSite, currentChannel, settings),
      };
    },
    executeTask: async () => { executions++; return { status: 'needs_input', message: 'fixture execution complete' }; },
  });
  controller.runtime.aiReady = true;
  try {
    await controller.tick();
    const saved = store.read().tasks[0];
    assert.equal(providerCalls, 2);
    assert.equal(executions, 1);
    assert.equal(saved.cost?.aiCalls, 6);
    assert.equal(saved.articleRepairAttempts, 1);
    assert.equal(saved.articleReview?.status, 'passed');
    assert.equal(saved.draftRevision, 2);
  } finally { store.close(); }
});

function paragraphAccount(): Account {
  return {
    id: ACCOUNT_ID, channelId: 'paragraph', credentialKind: 'api_token', email: '', username: PARAGRAPH_PUBLICATION_ID,
    displayName: 'Fixture Notes', publicationUrl: PARAGRAPH_URL, createdAt: NOW, updatedAt: NOW,
    status: 'registered', hasPassword: true, source: 'imported',
  };
}

function blueskyAccount(): Account {
  return {
    id: ACCOUNT_ID, channelId: 'bluesky', credentialKind: 'api_token', email: '', username: BLUESKY_DID,
    displayName: `@${BLUESKY_HANDLE}`, createdAt: NOW, updatedAt: NOW,
    status: 'registered', hasPassword: true, source: 'imported',
  };
}

function accountStore(channelId: 'paragraph' | 'bluesky') {
  const store = new Store(':memory:');
  configureOnly(store, channelId);
  const site = baseSite(channelId === 'paragraph' ? {
    paragraph: { publicationId: PARAGRAPH_PUBLICATION_ID, url: PARAGRAPH_URL },
    qualifications: { publication: PARAGRAPH_URL },
  } : { category: 'finance', language: 'zh-CN' });
  const task = baseTask(channelId, {
    accountId: ACCOUNT_ID,
    status: 'running',
    attempts: 1,
    topicUrl: TARGET,
    draft: channelId === 'paragraph'
      ? { title: 'A reproducible operational review', description: 'Documented checks and limitations.', body: ARTICLE_BODY }
      : { title: 'Local label', description: 'Local description', body: SOCIAL_BODY },
    articleApprovedAt: NOW,
  });
  store.update(state => {
    state.sites = [site];
    state.tasks = [task];
    state.accounts = [channelId === 'paragraph' ? paragraphAccount() : blueskyAccount()];
    state.accountBindings = [{ id: BINDING_ID, siteId: SITE_ID, channelId, accountId: ACCOUNT_ID, createdAt: NOW, updatedAt: NOW }];
  });
  const secret = channelId === 'paragraph'
    ? JSON.stringify({ version: 1, apiKey: PARAGRAPH_API_KEY, publicationId: PARAGRAPH_PUBLICATION_ID, ownerUserId: PARAGRAPH_OWNER_ID, publicationSlug: PARAGRAPH_SLUG })
    : JSON.stringify({ version: 1, appPassword: BLUESKY_PASSWORD, accessJwt: BLUESKY_ACCESS, refreshJwt: BLUESKY_REFRESH, handle: BLUESKY_HANDLE, did: BLUESKY_DID });
  const memory = memoryVault({ [`account:${ACCOUNT_ID}`]: secret });
  return { store, ...memory };
}

function contextFor(store: Store, vault: Vault): ExecutionContext {
  const snapshot = store.read();
  const task = snapshot.tasks[0];
  const site = snapshot.sites[0];
  const channel = CHANNELS.find(item => item.id === task.channelId)!;
  return {
    site,
    channel,
    task,
    settings: snapshot.settings,
    signal: new AbortController().signal,
    secrets: vault,
    ai: { json: async <T>() => ({} as T) },
    getAccount: () => store.read().accounts.find(account => account.id === task.accountId),
    saveAccount: async updated => store.update(state => {
      const index = state.accounts.findIndex(account => account.id === updated.id);
      if (index >= 0) state.accounts[index] = structuredClone(updated);
    }),
    checkpoint: partial => {
      Object.assign(task, structuredClone(partial));
      store.update(state => Object.assign(state.tasks[0], structuredClone(partial)));
    },
    log: () => undefined,
  };
}

function applyExecutionResult(store: Store, result: Awaited<ReturnType<typeof runParagraphTask>>): void {
  store.update(state => Object.assign(state.tasks[0], structuredClone(result)));
}

test('Paragraph credential rejection before remote intent enters account handoff and reconnect resumes the same task', async () => {
  const { store, vault } = accountStore('paragraph');
  let writes = 0;
  try {
    const before = store.read().tasks[0];
    const result = await runParagraphTask(contextFor(store, vault), {
      fetch: async (_url, init) => {
        if (init.method === 'POST' || init.method === 'PUT') writes++;
        return json({ error: 'Unauthorized' }, 401);
      },
      now: () => NOW,
    });
    assert.equal(result.status, 'needs_input');
    assert.equal(result.checkpoint, 'account_handoff');
    assert.equal(writes, 0);
    assert.equal(store.read().accounts[0].status, 'credentials_invalid');
    applyExecutionResult(store, result);
    let saved = store.read().tasks[0];
    assert.equal(saved.id, before.id);
    assert.equal(saved.checkpoint, 'account_handoff');
    assert.equal(saved.submittedAt, undefined);
    assert.deepEqual(saved.draft, before.draft);

    store.update(state => {
      state.accounts[0].status = 'registered';
      state.accounts[0].diagnostic = undefined;
    });
    const controller = new Controller(store, vault, 'synthetic-memory-only');
    controller.plan();
    saved = store.read().tasks[0];
    assert.equal(saved.id, before.id);
    assert.equal(saved.status, 'queued');
    assert.equal(saved.checkpoint, undefined);
    assert.equal(saved.submittedAt, undefined);
    assert.deepEqual(saved.draft, before.draft);
  } finally { store.close(); }
});

test('Paragraph credential rejection after a saved draft intent preserves its checkpoint and receipt', async () => {
  const { store, vault } = accountStore('paragraph');
  try {
    const snapshot = store.read();
    const approved = paragraphTesting.approvedArticle(snapshot.tasks[0], snapshot.sites[0], false);
    const paragraph = {
      publicationId: PARAGRAPH_PUBLICATION_ID,
      slug: approved.slug,
      contentHash: approved.contentHash,
      stage: 'draft' as const,
      postId: '3T2PQZlsdQtigUp4fhlb',
    };
    store.update(state => Object.assign(state.tasks[0], { paragraph, checkpoint: 'paragraph_draft_created', submittedAt: NOW }));
    const before = store.read().tasks[0];
    const result = await runParagraphTask(contextFor(store, vault), { fetch: async () => json({ error: 'Unauthorized' }, 401), now: () => NOW });
    assert.equal(result.status, 'needs_input');
    assert.notEqual(result.checkpoint, 'account_handoff');
    assert.equal(store.read().accounts[0].status, 'credentials_invalid');
    applyExecutionResult(store, result);
    const saved = store.read().tasks[0];
    assert.equal(saved.checkpoint, before.checkpoint);
    assert.equal(saved.submittedAt, before.submittedAt);
    assert.deepEqual(saved.paragraph, before.paragraph);
    assert.deepEqual(saved.draft, before.draft);
  } finally { store.close(); }
});

test('Bluesky credential rejection before remote intent enters account handoff and reconnect resumes the same task', async () => {
  const { store, vault } = accountStore('bluesky');
  let creates = 0;
  try {
    const before = store.read().tasks[0];
    const result = await runBlueskyTask(contextFor(store, vault), {
      fetch: async (url, init) => {
        if (url.endsWith('com.atproto.repo.createRecord')) creates++;
        assert.equal(init.method, 'POST');
        return json({ error: 'AuthenticationRequired' }, 401);
      },
      now: () => NOW,
    });
    assert.equal(result.status, 'needs_input');
    assert.equal(result.checkpoint, 'account_handoff');
    assert.equal(creates, 0);
    assert.equal(store.read().accounts[0].status, 'credentials_invalid');
    store.update(state => Object.assign(state.tasks[0], structuredClone(result)));
    let saved = store.read().tasks[0];
    assert.equal(saved.id, before.id);
    assert.equal(saved.checkpoint, 'account_handoff');
    assert.equal(saved.submittedAt, undefined);
    assert.equal(saved.bluesky, undefined);

    store.update(state => {
      state.accounts[0].status = 'registered';
      state.accounts[0].diagnostic = undefined;
    });
    const controller = new Controller(store, vault, 'synthetic-memory-only');
    controller.plan();
    saved = store.read().tasks[0];
    assert.equal(saved.id, before.id);
    assert.equal(saved.status, 'queued');
    assert.equal(saved.checkpoint, undefined);
    assert.equal(saved.submittedAt, undefined);
    assert.equal(saved.bluesky, undefined);
  } finally { store.close(); }
});

test('Bluesky credential rejection after create intent preserves the uncertain write checkpoint and receipt', async () => {
  const { store, vault } = accountStore('bluesky');
  let creates = 0;
  try {
    const result = await runBlueskyTask(contextFor(store, vault), {
      fetch: async url => {
        if (url.endsWith('com.atproto.server.refreshSession')) {
          return json({ accessJwt: BLUESKY_ACCESS, refreshJwt: BLUESKY_REFRESH, handle: BLUESKY_HANDLE, did: BLUESKY_DID, active: true });
        }
        if (url.endsWith('com.atproto.repo.createRecord')) { creates++; return json({ error: 'AuthenticationRequired' }, 401); }
        throw new Error(`unexpected fixture request ${url}`);
      },
      now: () => NOW,
      randomBytes: () => Uint8Array.from([1, 2]),
    });
    assert.equal(creates, 1);
    assert.equal(result.status, 'needs_input');
    assert.equal(result.checkpoint, 'bluesky_create_submitting');
    assert.ok(result.submittedAt);
    assert.notEqual(result.checkpoint, 'account_handoff');
    assert.equal(store.read().accounts[0].status, 'credentials_invalid');
    store.update(state => Object.assign(state.tasks[0], structuredClone(result)));
    const saved = store.read().tasks[0];
    assert.equal(saved.checkpoint, 'bluesky_create_submitting');
    assert.equal(saved.submittedAt, result.submittedAt);
    assert.equal(saved.bluesky?.stage, 'creating');
    assert.equal(saved.bluesky?.did, BLUESKY_DID);
  } finally { store.close(); }
});
