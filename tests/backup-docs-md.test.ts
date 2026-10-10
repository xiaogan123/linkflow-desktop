import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptBackup, encryptBackup } from '../src/main/backup';
import { validateBackup } from '../src/main/backup-validation';
import { docsMdTaskIdentity } from '../src/main/docs-md-publication';
import { emptyState, type State } from '../src/main/store';
import type { Site, Task } from '../src/shared/types';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const BINDING_ID = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-10-09T10:00:00.000Z';
const NEXT = '2026-10-10T10:00:00.000Z';
const OPERATION_ID = 'docs_md_backup_operation_50';
const PUBLIC_ID = 'backup-cycle-50';
const PUBLIC_URL = `https://docs-md.com/${PUBLIC_ID}`;
const EDIT_TOKEN = Buffer.from(Array.from({ length: 24 }, (_, index) => 24 - index)).toString('base64url');

function fixtureSite(): Site {
  return {
    id: SITE_ID,
    domain: 'example.com',
    url: 'https://example.com/',
    email: 'owner@example.com',
    name: 'Example',
    description: 'Fixture publication',
    category: 'content',
    language: 'en',
    monthlyTarget: 2,
    status: 'ready',
    createdAt: NOW,
  };
}

function localDraft(): Task {
  return {
    id: TASK_ID,
    siteId: SITE_ID,
    channelId: 'docs-md',
    sourceDomain: 'docs-md.com',
    status: 'needs_input',
    health: 'pending',
    createdAt: NOW,
    scheduledAt: NOW,
    updatedAt: NOW,
    attempts: 0,
    message: 'Waiting for review',
    checkpoint: 'article_review',
    draft: {
      title: 'Reviewed Docs MD article',
      description: 'Fixture',
      body: 'Original Markdown with a [source](https://example.com/research).',
    },
  };
}

function fixtureTask(stage: 'submitting' | 'api_receipt' | 'published', status: 'review' | 'needs_input' | 'skipped' = 'review'): Task {
  const task = localDraft();
  const identity = docsMdTaskIdentity(task);
  assert.ok(identity);
  Object.assign(task, {
    status,
    attempts: 1,
    submittedAt: NOW,
    checkpoint: stage === 'submitting' ? 'docs_md_share_submitting' : stage === 'api_receipt' ? 'docs_md_api_receipt' : 'docs_md_published',
    message: 'Docs MD API evidence remains pending',
    docsMd: {
      operationId: OPERATION_ID,
      sourceHash: identity.sourceHash,
      requestHash: identity.requestHash,
      createdAt: NOW,
      stage,
      ...(stage !== 'submitting' ? { id: PUBLIC_ID } : {}),
    },
    ...(stage !== 'submitting' ? { publicUrl: PUBLIC_URL } : {}),
  });
  return task;
}

function state(stage: 'submitting' | 'api_receipt' | 'published', status: 'review' | 'needs_input' | 'skipped' = 'review'): State {
  const value = emptyState();
  value.sites = [fixtureSite()];
  value.tasks = [fixtureTask(stage, status)];
  return value;
}

function publishedTask(kind: 'active' | 'missing' | 'unreachable'): Task {
  const task = fixtureTask('published');
  Object.assign(task, {
    verifiedAt: NOW,
    firstLiveAt: NOW,
    lastCheckedAt: NOW,
    nextCheckAt: NEXT,
    linkRel: 'nofollow ugc noopener noreferrer',
    consecutiveMissing: kind === 'missing' ? 1 : 0,
  });
  if (kind === 'active') Object.assign(task, { status: 'live', health: 'healthy', linkCheck: 'found' });
  if (kind === 'missing') Object.assign(task, { status: 'needs_input', health: 'missing', linkCheck: 'absent', lostAt: NOW, reviewKind: 'lost_link' });
  if (kind === 'unreachable') Object.assign(task, { status: 'live', health: 'unknown', linkCheck: 'unreachable' });
  return task;
}

function publishedState(kind: 'active' | 'missing' | 'unreachable'): State {
  const value = emptyState();
  value.sites = [fixtureSite()];
  value.tasks = [publishedTask(kind)];
  return value;
}

function serializedSecret(overrides: Record<string, unknown> = {}): string {
  const receipt = fixtureTask('api_receipt').docsMd!;
  return JSON.stringify({
    version: 1,
    taskId: TASK_ID,
    operationId: receipt.operationId,
    id: PUBLIC_ID,
    publicUrl: PUBLIC_URL,
    sourceHash: receipt.sourceHash,
    requestHash: receipt.requestHash,
    editToken: EDIT_TOKEN,
    ...overrides,
  });
}

test('a local Docs MD draft under review requires no remote receipt or secret', () => {
  const value = emptyState();
  value.sites = [fixtureSite()];
  value.tasks = [localDraft()];
  const restored = validateBackup({ state: value, secrets: {} }).state.tasks[0];
  assert.equal(restored.channelId, 'docs-md');
  assert.equal(restored.checkpoint, 'article_review');
  assert.equal(restored.docsMd, undefined);
  assert.equal(restored.submittedAt, undefined);
});

test('local scheduler states restore without becoming remote publication evidence', () => {
  const review = {
    status: 'failed' as const,
    reason: 'Synthetic temporary provider failure',
    reviewedAt: NOW,
    evidenceUrls: ['https://example.com/'],
    draftRevision: 0,
    contentHash: '1'.repeat(64),
    contextHash: '2'.repeat(64),
    reasonCode: 'ai_unavailable' as const,
    reviewContractVersion: 4,
  };
  const queued = localDraft();
  Object.assign(queued, { status: 'queued', scheduledAt: NEXT, nextCheckAt: NEXT, articleReview: review } satisfies Partial<Task>);
  const systemWait = localDraft();
  Object.assign(systemWait, { status: 'failed', checkpoint: 'system_wait', attempts: 2, nextCheckAt: NEXT, recoveryEligible: true, articleReview: review } satisfies Partial<Task>);
  const skipped = localDraft();
  Object.assign(skipped, { status: 'skipped', deferredAt: NOW, nextCheckAt: NEXT, articleReview: review } satisfies Partial<Task>);
  for (const task of [queued, systemWait, skipped]) {
    const value = emptyState();
    value.sites = [fixtureSite()];
    value.tasks = [task];
    const restored = validateBackup({ state: value, secrets: {} }).state.tasks[0];
    assert.equal(restored.nextCheckAt, NEXT);
    assert.equal(restored.docsMd, undefined);
    assert.equal(restored.submittedAt, undefined);
  }

  for (const mutate of [
    (task: Task) => { task.lastCheckedAt = NOW; },
    (task: Task) => { task.reconcileAttempts = 0; },
    (task: Task) => { task.linkCheck = 'unreachable'; },
  ]) {
    const value = emptyState();
    value.sites = [fixtureSite()];
    value.tasks = [structuredClone(queued)];
    mutate(value.tasks[0]);
    assert.throws(() => validateBackup({ state: value, secrets: {} }), /Docs MD/);
  }
});

test('pending Docs MD intent and receipt states restore without fabricated live evidence', () => {
  for (const stage of ['submitting', 'api_receipt'] as const) {
    for (const status of ['review', 'needs_input', 'skipped'] as const) {
      const restored = validateBackup({ state: state(stage, status), secrets: {} }).state.tasks[0];
      assert.equal(restored.docsMd?.stage, stage);
      assert.equal(restored.status, status);
      assert.equal(restored.health, 'pending');
      assert.equal(restored.firstLiveAt, undefined);
      assert.equal(restored.verifiedAt, undefined);
      assert.equal(restored.linkCheck, undefined);
      assert.equal(restored.linkRel, undefined);
      assert.equal(restored.publicUrl, stage === 'api_receipt' ? PUBLIC_URL : undefined);
    }
  }
});

test('an API receipt and exactly bound edit token survive encrypted backup roundtrip', () => {
  const backup = {
    state: state('api_receipt'),
    secrets: { [`publication:${TASK_ID}`]: serializedSecret() },
  };
  const encrypted = encryptBackup(backup, 'docs-md-roundtrip-passphrase-50');
  assert.equal(encrypted.toString().includes(EDIT_TOKEN), false);
  const restored = validateBackup(decryptBackup(encrypted, 'docs-md-roundtrip-passphrase-50'));
  assert.deepEqual(restored, validateBackup(backup));
  const task = restored.state.tasks[0];
  assert.equal(task.docsMd?.stage, 'api_receipt');
  assert.equal(task.publicUrl, PUBLIC_URL);
  assert.equal(task.status, 'review');
  assert.equal(task.health, 'pending');
  assert.equal(task.firstLiveAt, undefined);
});

test('a receipt remains valid when token persistence was unknown', () => {
  const restored = validateBackup({ state: state('api_receipt'), secrets: {} });
  assert.equal(restored.state.tasks[0].docsMd?.id, PUBLIC_ID);
  assert.deepEqual(restored.secrets, {});
});

test('pending Docs MD recovery fields preserve finite read-only reconciliation states', () => {
  for (const attempt of [1, 2] as const) {
    const value = state('api_receipt');
    value.tasks[0].reconcileAttempts = attempt;
    value.tasks[0].reconcileAfter = NEXT;
    assert.equal(validateBackup({ state: value, secrets: {} }).state.tasks[0].reconcileAttempts, attempt);
  }

  const exhausted = state('api_receipt', 'needs_input');
  exhausted.tasks[0].reconcileAttempts = 3;
  assert.equal(validateBackup({ state: exhausted, secrets: {} }).state.tasks[0].status, 'needs_input');

  const readPending = state('api_receipt');
  readPending.tasks[0].lastCheckedAt = NOW;
  readPending.tasks[0].nextCheckAt = NEXT;
  assert.equal(validateBackup({ state: readPending, secrets: {} }).state.tasks[0].lastCheckedAt, NOW);

  const invalid: State[] = [];
  const zero = state('api_receipt'); zero.tasks[0].reconcileAttempts = 0; invalid.push(zero);
  const missingAfter = state('api_receipt'); missingAfter.tasks[0].reconcileAttempts = 1; invalid.push(missingAfter);
  const exhaustedWithAfter = state('api_receipt'); exhaustedWithAfter.tasks[0].reconcileAttempts = 3; exhaustedWithAfter.tasks[0].reconcileAfter = NEXT; invalid.push(exhaustedWithAfter);
  const submittingRead = state('submitting'); submittingRead.tasks[0].lastCheckedAt = NOW; submittingRead.tasks[0].nextCheckAt = NEXT; invalid.push(submittingRead);
  for (const value of invalid) assert.throws(() => validateBackup({ state: value, secrets: {} }), /Docs MD/);
});

test('published Docs MD active, missing, unreachable, and pending verification states restore exactly', () => {
  for (const kind of ['active', 'missing', 'unreachable'] as const) {
    const value = publishedState(kind);
    value.tasks[0].reconcileAttempts = 1;
    const restored = validateBackup({ state: value, secrets: {} }).state.tasks[0];
    assert.equal(restored.docsMd?.stage, 'published');
    assert.equal(restored.checkpoint, 'docs_md_published');
    assert.equal(restored.publicUrl, PUBLIC_URL);
    assert.equal(restored.linkRel, 'nofollow ugc noopener noreferrer');
    assert.equal(restored.reconcileAttempts, 1);
  }

  const pending = state('published');
  pending.tasks[0].lastCheckedAt = NOW;
  pending.tasks[0].nextCheckAt = NEXT;
  const restored = validateBackup({ state: pending, secrets: {} }).state.tasks[0];
  assert.equal(restored.docsMd?.stage, 'published');
  assert.equal(restored.status, 'review');
  assert.equal(restored.health, 'pending');
  assert.equal(restored.firstLiveAt, undefined);

  const lostThenUnreachable = publishedState('missing');
  lostThenUnreachable.tasks[0].health = 'unknown';
  lostThenUnreachable.tasks[0].linkCheck = 'unreachable';
  const historical = validateBackup({ state: lostThenUnreachable, secrets: {} }).state.tasks[0];
  assert.equal(historical.status, 'needs_input');
  assert.equal(historical.health, 'unknown');
  assert.equal(historical.lostAt, NOW);
  assert.equal(historical.reviewKind, 'lost_link');
  assert.equal(historical.consecutiveMissing, 1);
});

test('a published receipt and exactly bound edit token survive encrypted backup roundtrip', () => {
  const backup = {
    state: publishedState('active'),
    secrets: { [`publication:${TASK_ID}`]: serializedSecret() },
  };
  const encrypted = encryptBackup(backup, 'docs-md-published-roundtrip-passphrase-51');
  assert.equal(encrypted.toString().includes(EDIT_TOKEN), false);
  const restored = validateBackup(decryptBackup(encrypted, 'docs-md-published-roundtrip-passphrase-51'));
  assert.deepEqual(restored, validateBackup(backup));
  assert.equal(restored.state.tasks[0].docsMd?.stage, 'published');
  assert.equal(restored.state.tasks[0].status, 'live');
});

test('published Docs MD backups reject fabricated acceptance and inconsistent lifecycle fields', () => {
  const mutations: Array<(task: Task) => void> = [
    task => { delete task.verifiedAt; },
    task => { delete task.firstLiveAt; },
    task => { delete task.lastCheckedAt; },
    task => { delete task.nextCheckAt; },
    task => { task.nextCheckAt = NOW; },
    task => { task.linkRel = 'nofollow ugc noopener'; },
    task => { task.linkCheck = 'absent'; },
    task => { task.health = 'pending'; },
    task => { task.status = 'review'; },
    task => { task.reconcileAttempts = 0; },
    task => { task.reconcileAttempts = 1; task.reconcileAfter = NEXT; },
    task => { task.docsMd!.stage = 'api_receipt'; },
    task => { task.checkpoint = 'docs_md_api_receipt'; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const value = publishedState('active');
    mutate(value.tasks[0]);
    assert.throws(() => validateBackup({ state: value, secrets: {} }), `published mutation ${index}`);
  }

  const missing = publishedState('missing');
  delete missing.tasks[0].lostAt;
  assert.throws(() => validateBackup({ state: missing, secrets: {} }), /Docs MD/);

  const unreachable = publishedState('unreachable');
  unreachable.tasks[0].consecutiveMissing = 1;
  assert.throws(() => validateBackup({ state: unreachable, secrets: {} }), /Docs MD/);

  const fabricatedLostUnreachable = publishedState('unreachable');
  Object.assign(fabricatedLostUnreachable.tasks[0], { status: 'needs_input', lostAt: NOW, reviewKind: 'lost_link' });
  assert.throws(() => validateBackup({ state: fabricatedLostUnreachable, secrets: {} }), /Docs MD/);
});

test('Docs MD backups reject fabricated live or read-verification fields and tampered identity', () => {
  const mutations: Array<(task: Task) => void> = [
    task => { task.status = 'live'; },
    task => { task.health = 'healthy'; },
    task => { task.health = 'unknown'; },
    task => { task.verifiedAt = NOW; },
    task => { task.firstLiveAt = NOW; },
    task => { task.linkCheck = 'found'; },
    task => { task.linkRel = 'nofollow'; },
    task => { task.lastCheckedAt = NOW; },
    task => { task.nextCheckAt = '2026-10-10T10:00:00.000Z'; },
    task => { task.lostAt = NOW; },
    task => { task.reviewKind = 'publication'; },
    task => { task.consecutiveMissing = 0; },
    task => { task.reconcileAttempts = 1; },
    task => { task.reconcileAfter = NOW; },
    task => { task.publicationMethod = 'client'; },
    task => { task.reviewUntil = NOW; },
    task => { task.publicUrl = 'https://docs-md.com/different-doc'; },
    task => { task.submittedAt = '2026-10-09T11:00:00.000Z'; },
    task => { task.checkpoint = 'docs_md_published'; },
    task => { task.draft!.title = 'Changed title'; },
    task => { task.draft!.body = 'Changed body'; },
    task => { task.docsMd!.createdAt = '2026-10-09T11:00:00.000Z'; },
    task => { task.docsMd!.sourceHash = '0'.repeat(64); },
    task => { task.docsMd!.requestHash = '1'.repeat(64); },
    task => { task.docsMd!.id = 'different-doc'; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const value = state('api_receipt');
    mutate(value.tasks[0]);
    assert.throws(() => validateBackup({ state: value, secrets: {} }), `mutation ${index}`);
  }
  const unknown = state('api_receipt') as unknown as {
    tasks: Array<{ docsMd: { stage: string } }>;
  };
  unknown.tasks[0].docsMd.stage = 'source_matched';
  assert.throws(() => validateBackup({ state: unknown, secrets: {} }));
});

test('submitting and receipt stages require the exact optional remote identity shape', () => {
  const submittingWithId = state('submitting');
  submittingWithId.tasks[0].docsMd!.id = PUBLIC_ID;
  assert.throws(() => validateBackup({ state: submittingWithId, secrets: {} }));

  const receiptWithoutId = state('api_receipt');
  delete receiptWithoutId.tasks[0].docsMd!.id;
  assert.throws(() => validateBackup({ state: receiptWithoutId, secrets: {} }));

  const receiptWithoutUrl = state('api_receipt');
  delete receiptWithoutUrl.tasks[0].publicUrl;
  assert.throws(() => validateBackup({ state: receiptWithoutUrl, secrets: {} }));

  const intentWithUrl = state('submitting');
  intentWithUrl.tasks[0].publicUrl = PUBLIC_URL;
  assert.throws(() => validateBackup({ state: intentWithUrl, secrets: {} }));
});

test('Docs MD backups cannot omit the receipt while retaining external state', () => {
  const mutations: Array<(task: Task) => void> = [
    task => { task.submittedAt = NOW; },
    task => { task.publicUrl = PUBLIC_URL; },
    task => { task.verifiedAt = NOW; },
    task => { task.firstLiveAt = NOW; },
    task => { task.linkCheck = 'found'; },
    task => { task.linkRel = 'nofollow'; },
    task => { task.status = 'live'; task.health = 'healthy'; },
    task => { task.health = 'unknown'; },
    task => { task.checkpoint = 'docs_md_api_receipt'; },
    task => { task.checkpoint = 'submission_uncertain'; },
  ];
  for (const mutate of mutations) {
    const value = emptyState();
    const task = localDraft();
    task.status = 'running';
    delete task.checkpoint;
    mutate(task);
    value.sites = [fixtureSite()];
    value.tasks = [task];
    assert.throws(() => validateBackup({ state: value, secrets: {} }), /Docs MD/);
  }
});

test('Docs MD publication secrets reject orphans and every wrong receipt binding', () => {
  const cases: Array<{ state: State; secret: string }> = [
    { state: emptyState(), secret: serializedSecret() },
    { state: state('submitting'), secret: serializedSecret() },
    { state: state('api_receipt'), secret: serializedSecret({ taskId: ACCOUNT_ID }) },
    { state: state('api_receipt'), secret: serializedSecret({ operationId: 'docs_md_other_operation_50' }) },
    { state: state('api_receipt'), secret: serializedSecret({ id: 'different-doc' }) },
    { state: state('api_receipt'), secret: serializedSecret({ publicUrl: 'https://docs-md.com/different-doc' }) },
    { state: state('api_receipt'), secret: serializedSecret({ sourceHash: '0'.repeat(64) }) },
    { state: state('api_receipt'), secret: serializedSecret({ requestHash: '1'.repeat(64) }) },
    { state: state('api_receipt'), secret: serializedSecret({ editToken: 'bad-token' }) },
    { state: state('api_receipt'), secret: serializedSecret({ version: 2 }) },
    { state: state('api_receipt'), secret: serializedSecret({ extra: true }) },
  ];
  for (const item of cases) {
    assert.throws(() => validateBackup({
      state: item.state,
      secrets: { [`publication:${TASK_ID}`]: item.secret },
    }));
  }
});

test('Docs MD tasks reject accounts, bindings, and receipts under another channel', () => {
  const withAccount = state('api_receipt');
  withAccount.accounts.push({
    id: ACCOUNT_ID,
    channelId: 'docs-md',
    email: 'owner@example.com',
    username: 'anonymous',
    createdAt: NOW,
    status: 'registered',
    hasPassword: false,
  });
  assert.throws(() => validateBackup({ state: withAccount, secrets: {} }), /Docs MD 账号/);

  const withBinding = state('api_receipt');
  withBinding.accounts.push({
    id: ACCOUNT_ID,
    channelId: 'other',
    email: 'owner@example.com',
    username: 'owner',
    createdAt: NOW,
    status: 'registered',
    hasPassword: false,
  });
  withBinding.accountBindings.push({
    id: BINDING_ID,
    siteId: SITE_ID,
    channelId: 'docs-md',
    accountId: ACCOUNT_ID,
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.throws(() => validateBackup({ state: withBinding, secrets: {} }));

  const wrongChannel = state('api_receipt');
  wrongChannel.tasks[0].channelId = 'other';
  assert.throws(() => validateBackup({ state: wrongChannel, secrets: {} }), /Docs MD 回执/);

  const wrongDomain = state('api_receipt');
  wrongDomain.tasks[0].sourceDomain = 'other.example';
  assert.throws(() => validateBackup({ state: wrongDomain, secrets: {} }), /Docs MD 回执/);
});
