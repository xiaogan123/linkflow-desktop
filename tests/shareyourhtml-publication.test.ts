import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createShareYourHtmlPage, type ShareYourHtmlIntent } from '../src/integrations/shareyourhtml';
import {
  createShareYourHtmlPublicationPersistence,
  parseShareYourHtmlPublicationSecret,
} from '../src/main/shareyourhtml-publication';
import { Store } from '../src/main/store';
import type { Site, Task } from '../src/shared/types';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TASK_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-10-09T10:00:00.000Z';
const HTML = '<!doctype html><html><body><h1>Reviewed</h1><a href="https://example.com/">Source</a></body></html>';
const SLUG = 'reviewed-cycle-67';
const OPERATION = 'shareyourhtml_operation_67';
const EDIT_KEY = '01234567-89ab-cdef-0123-456789abcdef';
const DRAFT = { title: 'Reviewed', description: 'Fixture', body: 'Exact source draft.' };

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function site(): Site {
  return { id: SITE_ID, domain: 'example.com', url: 'https://example.com/',
    email: 'owner@example.com', name: 'Example', description: 'Fixture', category: 'content',
    language: 'en', monthlyTarget: 2, status: 'ready', createdAt: NOW };
}

function task(id = TASK_ID): Task {
  return { id, siteId: SITE_ID, channelId: 'shareyourhtml', sourceDomain: 'shareyourhtml.com',
    status: 'running', health: 'pending', createdAt: NOW, scheduledAt: NOW, updatedAt: NOW,
    attempts: 1, message: 'Ready', articleApprovedAt: NOW, draftRevision: 4,
    draft: structuredClone(DRAFT) };
}

function intent(slug = SLUG, operationId = OPERATION, html = HTML): ShareYourHtmlIntent {
  const body = JSON.stringify({ slug, html, expiry: 'never' });
  return { operationId, slug, sourceHash: sha256(html), requestHash: sha256(body), createdAt: NOW };
}

function fixture(twoTasks = false) {
  const directory = mkdtempSync(join(tmpdir(), 'linkflow-shareyourhtml-persistence-'));
  const path = join(directory, 'state.sqlite');
  const store = new Store(path);
  store.update(state => {
    state.settings.autoRun = true;
    state.sites = [site()];
    state.tasks = twoTasks ? [task(), task(OTHER_TASK_ID)] : [task()];
  });
  let authorized = true;
  let authorizeHook: (() => void) | undefined;
  let encryptHook: (() => void) | undefined;
  const vault = {
    encryptSecrets(values: Record<string, string>) {
      encryptHook?.();
      return Object.fromEntries(Object.entries(values).map(([key, value]) =>
        [key, `enc:${Buffer.from(value).toString('base64url')}`]));
    },
  };
  const bridge = (options: { taskId?: string; slug?: string; html?: string;
    expectedIntent?: ShareYourHtmlIntent } = {}) => {
    const selected = store.read().tasks.find(value => value.id === (options.taskId ?? TASK_ID))!;
    return createShareYourHtmlPublicationPersistence(store, vault, {
      taskId: options.taskId ?? TASK_ID,
      siteId: SITE_ID,
      reviewedHtml: options.html ?? HTML,
      reviewedDraft: structuredClone(selected.draft!),
      reviewedDraftRevision: selected.draftRevision ?? 0,
      ...(options.expectedIntent ? { expectedIntent: options.expectedIntent } : {}),
      now: () => new Date(NOW),
      assertSubmissionAuthorized(snapshot) {
        authorizeHook?.();
        assert.equal(snapshot.reviewedHtml, options.html ?? HTML);
        assert.equal(snapshot.sourceHash, sha256(options.html ?? HTML));
        if (!authorized || !snapshot.task.articleApprovedAt) throw Error('synthetic authorization denied');
        return true;
      },
    });
  };
  return { directory, path, store, bridge,
    setAuthorized(value: boolean) { authorized = value; },
    setAuthorizeHook(value: (() => void) | undefined) { authorizeHook = value; },
    setEncryptHook(value: (() => void) | undefined) { encryptHook = value; },
    cleanup() { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); } };
}

function createdReceipt(value = intent()) {
  return { ...value, publicUrl: `https://${value.slug}.shareyourhtml.com` as const,
    requestedExpiry: 'never' as const, publicVerification: 'pending' as const };
}

test('claim snapshots exact reviewed bytes and survives reopen as a permanent no-replay block', async () => {
  const f = fixture();
  try {
    await f.bridge().persistIntent(intent());
    let saved = f.store.read().tasks[0];
    assert.equal(saved.shareYourHtml?.stage, 'submitting');
    assert.equal(saved.publicUrl, undefined);
    assert.equal(saved.status, 'review');
    assert.equal(saved.health, 'pending');
    f.store.close();
    const reopened = new Store(f.path);
    try {
      const persistence = createShareYourHtmlPublicationPersistence(reopened, {
        encryptSecrets: values => values,
      }, { taskId: TASK_ID, siteId: SITE_ID, reviewedHtml: HTML, reviewedDraft: DRAFT,
        reviewedDraftRevision: 4, assertSubmissionAuthorized: () => true });
      await assert.rejects(persistence.persistIntent(intent('different-cycle-67', 'different_operation_67')),
        /已有永久提交记录/);
      saved = reopened.read().tasks[0];
      assert.equal(saved.shareYourHtml?.operationId, OPERATION);
      assert.equal(saved.shareYourHtml?.slug, SLUG);
      const resumed = createShareYourHtmlPublicationPersistence(reopened, {
        encryptSecrets: values => Object.fromEntries(Object.entries(values).map(([key, value]) =>
          [key, `enc:${Buffer.from(value).toString('base64url')}`])),
      }, { taskId: TASK_ID, siteId: SITE_ID, reviewedHtml: HTML, reviewedDraft: DRAFT,
        reviewedDraftRevision: 4, expectedIntent: intent(), assertSubmissionAuthorized: () => true });
      await resumed.persistCreatedAtomically({ receipt: createdReceipt(), editKey: EDIT_KEY });
      assert.equal(reopened.read().tasks[0].shareYourHtml?.stage, 'api_receipt');
      assert.ok(reopened.getCipher(`publication:${TASK_ID}`));
    } finally { reopened.close(); }
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('authorization, stale draft, stale revision, and changed reviewed HTML fail before claim', async () => {
  const f = fixture();
  try {
    f.setAuthorized(false);
    await assert.rejects(f.bridge().persistIntent(intent()), /authorization denied/);
    f.setAuthorized(true);
    const staleDraft = f.bridge();
    f.store.update(state => { state.tasks[0].draft!.body = 'changed'; });
    await assert.rejects(staleDraft.persistIntent(intent()), /原稿或修订号/);
    f.store.update(state => { state.tasks[0] = task(); state.tasks[0].draftRevision = 5; });
    await assert.rejects(createShareYourHtmlPublicationPersistence(f.store, { encryptSecrets: v => v }, {
      taskId: TASK_ID, siteId: SITE_ID, reviewedHtml: HTML, reviewedDraft: DRAFT,
      reviewedDraftRevision: 4, assertSubmissionAuthorized: () => true,
    }).persistIntent(intent()), /原稿或修订号/);
    f.store.update(state => { state.tasks[0] = task(); });
    const changedHtml = HTML + ' ';
    await assert.rejects(f.bridge({ html: changedHtml }).persistIntent(intent()), /HTML 或请求快照/);
    f.setAuthorizeHook(() => f.store.update(state => { state.settings.autoRun = false; }));
    await assert.rejects(f.bridge().persistIntent(intent()), /授权期间任务状态已改变/);
    assert.equal(f.store.read().tasks[0].shareYourHtml, undefined);
    assert.equal(f.store.read().settings.autoRun, false);
  } finally { f.cleanup(); }
});

test('one Store atomically rejects same operation or slug races across tasks', async () => {
  for (const variant of ['operation', 'slug'] as const) {
    const f = fixture(true);
    try {
      const first = variant === 'operation' ? intent('first-cycle-67', 'shared_operation_67')
        : intent('shared-cycle-67', 'first_operation_67');
      const second = variant === 'operation' ? intent('second-cycle-67', 'shared_operation_67')
        : intent('shared-cycle-67', 'second_operation_67');
      const results = await Promise.allSettled([
        f.bridge({ taskId: TASK_ID }).persistIntent(first),
        f.bridge({ taskId: OTHER_TASK_ID }).persistIntent(second),
      ]);
      assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
      assert.equal(results.filter(value => value.status === 'rejected').length, 1);
      assert.equal(f.store.read().tasks.filter(value => value.shareYourHtml).length, 1);
    } finally { f.cleanup(); }
  }
});

test('mocked protocol success commits pending receipt and encrypted edit key atomically', async () => {
  const f = fixture();
  try {
    const result = await createShareYourHtmlPage({ operationId: OPERATION, slug: SLUG, html: HTML,
      reviewed: true }, f.bridge(), { now: () => new Date(NOW), fetch: async () => new Response(JSON.stringify({
        slug: SLUG, url: `https://${SLUG}.shareyourhtml.com`, edit_key: EDIT_KEY,
      }), { status: 201, headers: { 'content-type': 'application/json' } }) });
    assert.equal(result.status, 'created');
    const saved = f.store.read().tasks[0];
    assert.equal(saved.shareYourHtml?.stage, 'api_receipt');
    assert.equal(saved.shareYourHtml?.publicVerification, 'pending');
    assert.equal(saved.status, 'review');
    assert.equal(saved.health, 'pending');
    assert.equal(saved.verifiedAt, undefined);
    assert.equal(saved.firstLiveAt, undefined);
    const cipher = f.store.getCipher(`publication:${TASK_ID}`);
    assert.equal(typeof cipher, 'string');
    assert.ok(cipher!.startsWith('enc:'));
    const secret = parseShareYourHtmlPublicationSecret(Buffer.from(cipher!.slice(4), 'base64url').toString());
    assert.equal(secret?.editKey, EDIT_KEY);
    assert.equal(secret?.siteId, SITE_ID);
    assert.equal(secret?.siteIdentityHash, saved.shareYourHtml?.siteIdentityHash);
    assert.equal(JSON.stringify(result).includes(EDIT_KEY), false);
  } finally { f.cleanup(); }
});

test('final synchronous guard blocks stale reviewed dispatch after draft or authorization changes', async () => {
  for (const mode of ['draft', 'authorization', 'reentrant'] as const) {
    const f = fixture();
    let requests = 0;
    try {
      if (mode === 'reentrant') {
        let calls = 0;
        f.setAuthorizeHook(() => {
          calls++;
          if (calls === 2) f.store.update(state => { state.sites[0].status = 'paused'; });
        });
      }
      const pending = createShareYourHtmlPage({ operationId: OPERATION, slug: SLUG, html: HTML,
        reviewed: true }, f.bridge(), { now: () => new Date(NOW), fetch: async () => {
        requests++;
        return new Response(JSON.stringify({ slug: SLUG,
          url: `https://${SLUG}.shareyourhtml.com`, edit_key: EDIT_KEY }),
        { status: 201, headers: { 'content-type': 'application/json' } });
      } });
      if (mode === 'draft') f.store.update(state => {
        state.tasks[0].draft!.body = 'Changed after durable claim';
        state.tasks[0].draftRevision = 5;
      });
      if (mode === 'authorization') f.store.update(state => { state.settings.autoRun = false; });
      const result = await pending;
      assert.deepEqual(result.status, 'not_submitted');
      if (result.status === 'not_submitted') assert.equal(result.reason, 'final_guard_rejected');
      assert.equal(requests, 0);
      assert.equal(f.store.read().tasks[0].shareYourHtml?.stage, 'submitting');
      assert.equal(f.store.read().tasks[0].publicUrl, undefined);
      assert.equal(f.store.getCipher(`publication:${TASK_ID}`), undefined);
    } finally { f.cleanup(); }
  }
});

test('source site identity changes preserve the claim but reject late receipt attachment', async () => {
  for (const field of ['domain', 'url'] as const) {
    const f = fixture();
    try {
      const persistence = f.bridge();
      const expected = intent();
      await persistence.persistIntent(expected);
      f.store.update(state => {
        if (field === 'domain') state.sites[0].domain = 'changed.example';
        else state.sites[0].url = 'https://changed.example/';
      });
      await assert.rejects(persistence.persistCreatedAtomically({ receipt: createdReceipt(expected),
        editKey: EDIT_KEY }), /来源站点身份/);
      assert.equal(f.store.read().tasks[0].shareYourHtml?.stage, 'submitting');
      assert.equal(f.store.getCipher(`publication:${TASK_ID}`), undefined);
    } finally { f.cleanup(); }
  }
});

test('encryption failure or a mutation during encryption preserves intent without receipt or secret', async () => {
  for (const mode of ['throw', 'draft', 'cipher'] as const) {
    const f = fixture();
    try {
      const persistence = f.bridge();
      const expected = intent();
      await persistence.persistIntent(expected);
      f.setEncryptHook(() => {
        if (mode === 'throw') throw Error('synthetic encrypt failure');
        if (mode === 'draft') f.store.update(state => { state.tasks[0].draft!.body = 'late mutation'; });
        if (mode === 'cipher') f.store.setCipher(`publication:${TASK_ID}`, 'occupied');
      });
      await assert.rejects(persistence.persistCreatedAtomically({ receipt: createdReceipt(expected),
        editKey: EDIT_KEY }));
      const saved = f.store.read().tasks[0];
      assert.equal(saved.shareYourHtml?.stage, 'submitting');
      assert.equal(saved.publicUrl, undefined);
      assert.equal(f.store.getCipher(`publication:${TASK_ID}`), mode === 'cipher' ? 'occupied' : undefined);
    } finally { f.cleanup(); }
  }
});

test('SQLite secret failure rolls back receipt state and leaves the durable intent', async () => {
  const f = fixture();
  try {
    const persistence = f.bridge();
    const expected = intent();
    await persistence.persistIntent(expected);
    const database = (f.store as unknown as { db: { exec(sql: string): void } }).db;
    database.exec("CREATE TRIGGER fail_share_secret BEFORE INSERT ON secrets BEGIN SELECT RAISE(ABORT, 'synthetic'); END;");
    await assert.rejects(persistence.persistCreatedAtomically({ receipt: createdReceipt(expected),
      editKey: EDIT_KEY }));
    database.exec('DROP TRIGGER fail_share_secret');
    assert.equal(f.store.read().tasks[0].shareYourHtml?.stage, 'submitting');
    assert.equal(f.store.read().tasks[0].publicUrl, undefined);
    assert.equal(f.store.getCipher(`publication:${TASK_ID}`), undefined);
  } finally { f.cleanup(); }
});

test('receipt identity and preexisting ciphertext cannot be replaced', async () => {
  const f = fixture();
  try {
    const persistence = f.bridge();
    const expected = intent();
    await persistence.persistIntent(expected);
    await assert.rejects(persistence.persistCreatedAtomically({ receipt: {
      ...createdReceipt(expected), publicUrl: 'https://wrong.shareyourhtml.com',
    }, editKey: EDIT_KEY }), /无效/);
    f.store.setCipher(`publication:${TASK_ID}`, 'occupied');
    await assert.rejects(persistence.persistCreatedAtomically({ receipt: createdReceipt(expected),
      editKey: EDIT_KEY }), /已经保存/);
    assert.equal(f.store.read().tasks[0].shareYourHtml?.stage, 'submitting');
  } finally { f.cleanup(); }
});
