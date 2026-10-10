import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { renderShareYourHtmlArticle } from '../src/integrations/shareyourhtml-article';
import {
  submitReviewedShareYourHtmlPublication,
  type ShareYourHtmlChannelResolver,
} from '../src/main/shareyourhtml-reviewed-publication';
import {
  ARTICLE_REVIEW_CONTRACT_VERSION,
  articleContentHash,
  articleContextHash,
} from '../src/main/article-review';
import { Store } from '../src/main/store';
import type { Channel, Site, Task } from '../src/shared/types';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-10-09T10:00:00.000Z';
const TOPIC = 'https://example.com/guides/reviewed-topic';
const OPERATION = 'shareyourhtml_11111111111141118111111111111111';
const SLUG = 'lf-11111111111141118111111111111111';
const EDIT_KEY = '01234567-89ab-cdef-0123-456789abcdef';
const SECRET_MARKER = 'must-not-escape-in-diagnostics';

function channel(): Channel {
  return {
    id: 'shareyourhtml', name: 'ShareYourHTML', domain: 'shareyourhtml.com',
    url: 'https://shareyourhtml.com/', submitUrl: 'https://shareyourhtml.com/pages',
    categories: ['content'], languages: ['*'], kind: 'article', emailRequired: false,
    accountRequired: false, articleRequired: true, free: 'yes', freeNote: 'Free API.',
    automation: 'api', quality: 'B', qualityReason: 'Synthetic future catalog fixture.',
    provenance: 'built-in', requirements: [], evidenceStatus: 'rules_checked',
    rulesUrl: 'https://shareyourhtml.com/terms',
    evidenceSources: [{ url: 'https://shareyourhtml.com/terms', kind: 'content_policy',
      appliesTo: 'shareyourhtml', applicability: 'verified' }],
    checkedAt: '2026-10-08', notes: 'Static HTML article pages.',
    allowedHosts: ['shareyourhtml.com'], enabled: true,
  };
}

function site(): Site {
  return {
    id: SITE_ID, domain: 'example.com', url: 'https://example.com/',
    email: 'owner@example.com', publicEmail: 'public@example.com', name: 'Example',
    description: 'Reviewed fixture site.', category: 'content', language: 'en', monthlyTarget: 2,
    articleReviewMode: 'ai', status: 'ready', createdAt: '2026-09-01T00:00:00.000Z',
    topics: [{ url: TOPIC, title: 'Reviewed topic', discoveredAt: '2026-10-08T00:00:00.000Z' }],
  };
}

function task(): Task {
  return {
    id: TASK_ID, siteId: SITE_ID, channelId: 'shareyourhtml',
    sourceDomain: 'shareyourhtml.com', status: 'running', health: 'pending',
    createdAt: '2026-10-09T08:00:00.000Z', scheduledAt: '2026-10-09T09:00:00.000Z',
    updatedAt: '2026-10-09T09:30:00.000Z', attempts: 1, message: 'Ready',
    topicUrl: TOPIC, draftRevision: 3, draftUpdatedAt: '2026-10-09T09:15:00.000Z',
    draft: {
      title: 'Reviewed article title',
      description: 'A useful reviewed description.',
      body: `## Practical detail\n\nThis exact draft links to the [reviewed topic](${TOPIC}).\n\nUse **careful** comparison.`,
    },
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'linkflow-shareyourhtml-reviewed-'));
  const path = join(directory, 'state.sqlite');
  const store = new Store(path);
  store.update(state => {
    state.settings.autoRun = true;
    state.settings.articleReviewMode = 'ai';
    state.settings.model = 'review-model';
    state.settings.timezone = 'UTC';
    const currentSite = site();
    const currentTask = task();
    const currentChannel = channel();
    state.sites = [currentSite];
    state.tasks = [currentTask];
    // No production catalog entry is created. The future Controller resolver
    // is exercised with a synthetic Store-backed channel fixture.
    state.customChannels = [currentChannel];
    currentTask.articleReview = {
      status: 'passed', reason: 'Synthetic independently reviewed fixture.',
      reasonCode: 'passed', reviewContractVersion: ARTICLE_REVIEW_CONTRACT_VERSION,
      checks: { factualAccuracy: 'pass', authorRelationship: 'pass',
        affiliateDisclosure: 'pass', independentValue: 'pass', financialSafety: 'pass',
        channelRules: 'pass' },
      reviewedAt: '2026-10-09T09:45:00.000Z',
      evidenceUrls: ['https://example.com/', 'https://shareyourhtml.com/terms'],
      draftRevision: currentTask.draftRevision ?? 0,
      contentHash: articleContentHash(currentTask),
      contextHash: articleContextHash(currentSite, currentChannel, state.settings),
    };
  });
  const resolveChannel: ShareYourHtmlChannelResolver = state =>
    state.customChannels?.find(value => value.id === 'shareyourhtml');
  const vault = {
    encryptSecrets(values: Record<string, string>) {
      return Object.fromEntries(Object.entries(values).map(([key, value]) =>
        [key, `cipher:${Buffer.from(value).toString('base64url')}`]));
    },
  };
  const submit = (fetch: NonNullable<Parameters<typeof submitReviewedShareYourHtmlPublication>[3]>['fetch']) =>
    submitReviewedShareYourHtmlPublication(store, vault, {
      taskId: TASK_ID, resolveChannel, now: () => new Date(NOW),
    }, { fetch });
  return { directory, path, store, resolveChannel, vault, submit,
    cleanup() { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); } };
}

function successResponse() {
  return new Response(JSON.stringify({ slug: SLUG, url: `https://${SLUG}.shareyourhtml.com`,
    edit_key: EDIT_KEY }), { status: 201, headers: { 'content-type': 'application/json' } });
}

test('trusted helper renders the current reviewed Store draft and persists only a pending receipt', async () => {
  const f = fixture();
  let requests = 0;
  let requestBody = '';
  try {
    const result = await f.submit(async (url, init) => {
      requests++;
      assert.equal(url, 'https://shareyourhtml.com/pages');
      requestBody = String(init.body);
      return successResponse();
    });
    assert.equal(requests, 1);
    assert.equal(result.status, 'created');
    const submitted = JSON.parse(requestBody) as { slug: string; html: string; expiry: string };
    const state = f.store.read();
    const expected = renderShareYourHtmlArticle({ draft: task().draft!, targetUrl: TOPIC,
      language: 'en', slug: SLUG });
    assert.deepEqual(submitted, { slug: SLUG, html: expected.html, expiry: 'never' });
    assert.equal(state.tasks[0].shareYourHtml?.operationId, OPERATION);
    assert.equal(state.tasks[0].shareYourHtml?.slug, SLUG);
    assert.equal(state.tasks[0].shareYourHtml?.stage, 'api_receipt');
    assert.equal(state.tasks[0].shareYourHtml?.publicVerification, 'pending');
    assert.equal(state.tasks[0].status, 'review');
    assert.equal(state.tasks[0].health, 'pending');
    assert.equal(state.tasks[0].verifiedAt, undefined);
    assert.equal(state.tasks[0].firstLiveAt, undefined);
    assert.match(f.store.getCipher(`publication:${TASK_ID}`) ?? '', /^cipher:/);
    assert.equal(JSON.stringify(result).includes(EDIT_KEY), false);
  } finally { f.cleanup(); }
});

test('stale review, draft, site, channel, settings and disabled override fail before claim or dispatch', () => {
  const mutations: Array<(store: Store) => void> = [
    store => store.update(state => { state.tasks[0].articleReview!.status = 'failed'; }),
    store => store.update(state => { state.tasks[0].articleReview!.checks!.channelRules = 'unknown'; }),
    store => store.update(state => { state.tasks[0].draft!.body += '\nChanged after review.'; }),
    store => store.update(state => { state.sites[0].description = 'Changed context.'; }),
    store => store.update(state => { state.customChannels![0].notes = 'Changed rules context.'; }),
    store => store.update(state => { state.settings.model = 'different-review-model'; }),
    store => store.update(state => { state.settings.channelOverrides.shareyourhtml = false; }),
  ];
  for (const mutate of mutations) {
    const f = fixture();
    let requests = 0;
    try {
      mutate(f.store);
      assert.throws(() => f.submit(async () => { requests++; return successResponse(); }), /ShareYourHTML/);
      assert.equal(requests, 0);
      assert.equal(f.store.read().tasks[0].shareYourHtml, undefined);
    } finally { f.cleanup(); }
  }
});

test('final synchronous guard blocks draft, review, site, channel and settings changes after claim', async () => {
  const mutations: Array<(store: Store) => void> = [
    store => store.update(state => { state.tasks[0].draft!.body += '\nChanged after claim.';
      state.tasks[0].draftRevision = 4; }),
    store => store.update(state => { state.tasks[0].articleReview!.reasonCode = 'content_rejected'; }),
    store => store.update(state => { state.tasks[0].articleReview!.checks!.channelRules = 'unknown'; }),
    store => store.update(state => { state.sites[0].url = 'https://changed.example/';
      state.sites[0].domain = 'changed.example'; }),
    store => store.update(state => { state.customChannels![0].notes = 'Revoked context.'; }),
    store => store.update(state => { state.settings.model = 'revoked-model'; }),
  ];
  for (const mutate of mutations) {
    const f = fixture();
    let requests = 0;
    try {
      const pending = f.submit(async () => { requests++; return successResponse(); });
      mutate(f.store);
      const result = await pending;
      assert.deepEqual(result.status, 'not_submitted');
      if (result.status === 'not_submitted') assert.equal(result.reason, 'final_guard_rejected');
      assert.equal(requests, 0);
      const saved = f.store.read().tasks[0];
      assert.equal(saved.shareYourHtml?.stage, 'submitting');
      assert.equal(saved.publicUrl, undefined);
      assert.equal(f.store.getCipher(`publication:${TASK_ID}`), undefined);
    } finally { f.cleanup(); }
  }
});

test('exact topic binding and scheduling are required before a durable claim', () => {
  for (const mutation of [
    (state: ReturnType<Store['read']>) => { state.sites[0].topics = []; },
    (state: ReturnType<Store['read']>) => { state.tasks[0].topicUrl = 'http://example.com/guides/reviewed-topic'; },
    (state: ReturnType<Store['read']>) => { state.tasks[0].scheduledAt = '2026-10-09T11:00:00.000Z'; },
  ]) {
    const f = fixture();
    try {
      f.store.update(mutation);
      assert.throws(() => f.submit(async () => successResponse()), /ShareYourHTML/);
      assert.equal(f.store.read().tasks[0].shareYourHtml, undefined);
    } finally { f.cleanup(); }
  }
});

test('unknown transport preserves one durable operation and slug and blocks replay after reopen', async () => {
  const f = fixture();
  let requests = 0;
  try {
    const result = await f.submit(async () => {
      requests++;
      throw Error(`${SECRET_MARKER}:${EDIT_KEY}`);
    });
    assert.equal(result.status, 'unknown');
    assert.equal(JSON.stringify(result).includes(SECRET_MARKER), false);
    assert.equal(JSON.stringify(result).includes(EDIT_KEY), false);
    assert.equal(requests, 1);
    assert.equal(f.store.read().tasks[0].shareYourHtml?.operationId, OPERATION);
    f.store.close();
    const reopened = new Store(f.path);
    try {
      assert.throws(() => submitReviewedShareYourHtmlPublication(reopened, f.vault, {
        taskId: TASK_ID, resolveChannel: f.resolveChannel, now: () => new Date(NOW),
      }, { fetch: async () => { requests++; return successResponse(); } }), /永久提交记录/);
      assert.equal(requests, 1);
      assert.equal(reopened.read().tasks[0].shareYourHtml?.slug, SLUG);
    } finally { reopened.close(); }
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('resolver must reflect current Store channel rather than a caller publication object', () => {
  const f = fixture();
  try {
    const stale = channel();
    f.store.update(state => { state.customChannels![0].enabled = false; });
    assert.throws(() => submitReviewedShareYourHtmlPublication(f.store, f.vault, {
      taskId: TASK_ID,
      resolveChannel: state => state.customChannels?.find(value => value.id === stale.id),
      now: () => new Date(NOW),
    }, { fetch: async () => successResponse() }), /自动文章发布条件/);
    assert.equal(f.store.read().tasks[0].shareYourHtml, undefined);
  } finally { f.cleanup(); }
});
