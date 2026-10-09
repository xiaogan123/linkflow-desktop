import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishSupanote, type SupanoteIntent, type SupanoteReceipt } from '../src/integrations/supanote';
import {
  createSupanotePublicationPersistence,
  parseSupanotePublicationSecret,
  supanoteTaskContentHash,
} from '../src/main/supanote-publication';
import { Store } from '../src/main/store';
import type { Site, Task } from '../src/shared/types';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-10-09T10:00:00.000Z';
const TITLE = 'Reviewed Supanote article';
const MARKDOWN = 'Original reviewed Markdown with a [source](https://example.com/research).';
const PUBLIC_ID = 'fixture_note_43';
const PUBLIC_URL = `https://supanote.app/n/${PUBLIC_ID}`;
const TOKEN = 'fixture_manage_token_43';

function site(): Site {
  return {
    id: SITE_ID,
    domain: 'example.com',
    url: 'https://example.com/',
    email: 'owner@example.com',
    name: 'Example',
    description: 'Educational publication',
    category: 'content',
    language: 'en',
    monthlyTarget: 2,
    status: 'ready',
    createdAt: NOW,
  };
}

function task(): Task {
  return {
    id: TASK_ID,
    siteId: SITE_ID,
    channelId: 'supanote',
    sourceDomain: 'supanote.app',
    status: 'running',
    createdAt: NOW,
    scheduledAt: NOW,
    updatedAt: NOW,
    attempts: 1,
    message: 'Ready',
    health: 'pending',
    articleApprovedAt: NOW,
    draft: { title: TITLE, description: 'Fixture', body: MARKDOWN },
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'linkflow-supanote-persistence-'));
  const path = join(directory, 'state.sqlite');
  const store = new Store(path);
  store.update(state => {
    state.settings.autoRun = true;
    state.sites = [site()];
    state.tasks = [task()];
  });
  let authorized = true;
  let encryptHook: (() => void) | undefined;
  const vault = {
    encryptSecrets(values: Record<string, string>) {
      encryptHook?.();
      return Object.fromEntries(Object.entries(values).map(([key, value]) => [
        key,
        `enc:${Buffer.from(value).toString('base64url')}`,
      ]));
    },
  };
  const bridge = () => createSupanotePublicationPersistence(store, vault, {
    taskId: TASK_ID,
    siteId: SITE_ID,
    now: () => new Date(NOW),
    assertSubmissionAuthorized(snapshot) {
      if (!authorized || !snapshot.state.settings.autoRun || snapshot.task.status !== 'running'
        || snapshot.site.status !== 'ready' || !snapshot.task.articleApprovedAt)
        throw Error('synthetic authorization denied');
      return true;
    },
  });
  return {
    directory,
    path,
    store,
    bridge,
    setAuthorized(value: boolean) { authorized = value; },
    setEncryptHook(value: (() => void) | undefined) { encryptHook = value; },
    cleanup() { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); },
  };
}

function intent(operationId = 'supanote_operation_43'): SupanoteIntent {
  const value = task();
  return { operationId, contentHash: supanoteTaskContentHash(value)!, createdAt: NOW };
}

function receipt(contentHash = intent().contentHash): SupanoteReceipt {
  return { publicId: PUBLIC_ID, publicUrl: PUBLIC_URL, contentHash };
}

test('the synchronous authorization guard rejects before any durable intent', async () => {
  const f = fixture();
  try {
    f.setAuthorized(false);
    await assert.rejects(f.bridge().persistIntent(intent()), /authorization denied/);
    const saved = f.store.read().tasks[0];
    assert.equal(saved.supanote, undefined);
    assert.equal(saved.submittedAt, undefined);
    assert.equal(saved.checkpoint, undefined);
  } finally { f.cleanup(); }
});

test('paused state rejects a new intent even if a faulty guard returns true', async () => {
  const f = fixture();
  try {
    f.store.update(state => {
      state.settings.autoRun = false;
      state.sites[0].status = 'paused';
    });
    await assert.rejects(f.bridge().persistIntent(intent()), /已暂停/);
    assert.equal(f.store.read().tasks[0].supanote, undefined);
  } finally { f.cleanup(); }
});

test('two concurrent intent callbacks claim the single Store task only once', async () => {
  const f = fixture();
  try {
    const persistence = f.bridge();
    const claims = await Promise.allSettled([
      persistence.persistIntent(intent('concurrent_operation_a')),
      persistence.persistIntent(intent('concurrent_operation_b')),
    ]);
    assert.equal(claims.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(claims.filter(item => item.status === 'rejected').length, 1);
    const saved = f.store.read().tasks[0];
    assert.equal(saved.submittedAt, NOW);
    assert.equal(saved.checkpoint, 'supanote_publish_submitting');
    assert.equal(saved.status, 'review');
    assert.equal(saved.health, 'pending');
    assert.equal(saved.supanote?.stage, 'submitting');
  } finally { f.cleanup(); }
});

test('constructor options are snapshotted and cannot redirect a returned receipt', async () => {
  const f = fixture();
  try {
    const options = {
      taskId: TASK_ID,
      siteId: SITE_ID,
      now: () => new Date(NOW),
      assertSubmissionAuthorized: () => true as const,
    };
    const persistence = createSupanotePublicationPersistence(f.store, { encryptSecrets: values => values }, options);
    await persistence.persistIntent(intent());
    f.store.update(state => {
      state.tasks.push({
        ...structuredClone(state.tasks[0]),
        id: '33333333-3333-4333-8333-333333333333',
        supanote: { ...intent('other_operation_43'), stage: 'submitting' },
      });
    });
    options.taskId = '33333333-3333-4333-8333-333333333333';
    await persistence.persistReceipt(receipt());
    const saved = f.store.read().tasks;
    assert.equal(saved.find(item => item.id === TASK_ID)?.publicUrl, PUBLIC_URL);
    assert.equal(saved.find(item => item.id === options.taskId)?.publicUrl, undefined);
  } finally { f.cleanup(); }
});

test('receipt and secret callbacks remain bound to the exact claimed operation', async t => {
  await t.test('replacement before receipt', async () => {
    const f = fixture();
    try {
      const persistence = f.bridge();
      await persistence.persistIntent(intent());
      f.store.update(state => { state.tasks[0].supanote!.operationId = 'replacement_operation_43'; });
      await assert.rejects(persistence.persistReceipt(receipt()), /原任务不一致/);
      assert.equal(f.store.read().tasks[0].publicUrl, undefined);
    } finally { f.cleanup(); }
  });
  await t.test('replacement before secret', async () => {
    const f = fixture();
    try {
      const persistence = f.bridge();
      await persistence.persistIntent(intent());
      await persistence.persistReceipt(receipt());
      f.store.update(state => { state.tasks[0].supanote!.operationId = 'replacement_operation_43'; });
      await assert.rejects(persistence.persistManageToken({ publicId: PUBLIC_ID, token: TOKEN }), /原任务不一致/);
      assert.equal(f.store.getCipher(`publication:${TASK_ID}`), undefined);
    } finally { f.cleanup(); }
  });
});

test('an asynchronous authorization guard fails closed without an unhandled rejection', async () => {
  const f = fixture();
  try {
    const persistence = createSupanotePublicationPersistence(f.store, { encryptSecrets: values => values }, {
      taskId: TASK_ID,
      siteId: SITE_ID,
      assertSubmissionAuthorized: (async () => { throw Error('synthetic async denial'); }) as unknown as () => true,
    });
    await assert.rejects(persistence.persistIntent(intent()), /同步授权检查未通过/);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.store.read().tasks[0].supanote, undefined);
  } finally { f.cleanup(); }
});

test('intent claim rejects a draft that cannot survive the existing backup schema', async () => {
  const f = fixture();
  try {
    f.store.update(state => { state.tasks[0].draft!.body = 'a'.repeat(30_001); });
    const oversized = { ...intent(), contentHash: supanoteTaskContentHash(f.store.read().tasks[0])! };
    await assert.rejects(f.bridge().persistIntent(oversized), /超出可备份范围/);
    assert.equal(f.store.read().tasks[0].supanote, undefined);
  } finally { f.cleanup(); }
});

test('a durable intent survives SQLite reopen and prevents a second protocol POST', async () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    await f.bridge().persistIntent(intent());
    f.store.close();
    reopened = new Store(f.path);
    let posts = 0;
    const result = await publishSupanote({
      operationId: 'second_operation_43',
      reviewed: true,
      title: TITLE,
      markdown: MARKDOWN,
    }, createSupanotePublicationPersistence(reopened, { encryptSecrets: values => values }, {
      taskId: TASK_ID,
      siteId: SITE_ID,
      assertSubmissionAuthorized: () => true,
    }), { fetch: async () => { posts++; return new Response('{}'); } });
    assert.equal(result.status, 'not_started');
    assert.equal(posts, 0);
    assert.equal(reopened.read().tasks[0].supanote?.operationId, 'supanote_operation_43');
  } finally {
    try { reopened?.close(); } catch {}
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('a reopened store requires the exact original intent to attach a late receipt', async () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    await f.bridge().persistIntent(intent());
    f.store.close();
    reopened = new Store(f.path);
    const wrongRecovery = createSupanotePublicationPersistence(reopened, { encryptSecrets: values => values }, {
      taskId: TASK_ID,
      siteId: SITE_ID,
      expectedIntent: intent('replacement_operation_43'),
      assertSubmissionAuthorized: () => true,
    });
    await assert.rejects(wrongRecovery.persistReceipt(receipt()), /原任务不一致/);
    const recovery = createSupanotePublicationPersistence(reopened, { encryptSecrets: values => values }, {
      taskId: TASK_ID,
      siteId: SITE_ID,
      expectedIntent: intent(),
      assertSubmissionAuthorized: () => true,
    });
    await recovery.persistReceipt(receipt());
    assert.equal(reopened.read().tasks[0].publicUrl, PUBLIC_URL);
  } finally {
    try { reopened?.close(); } catch {}
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('a recovery bridge cannot turn its expected intent into a new claim', async () => {
  const f = fixture();
  try {
    const recovery = createSupanotePublicationPersistence(f.store, { encryptSecrets: values => values }, {
      taskId: TASK_ID,
      siteId: SITE_ID,
      expectedIntent: intent('old_recovery_operation_43'),
      assertSubmissionAuthorized: () => true,
    });
    await assert.rejects(recovery.persistIntent(intent('replacement_operation_43')), /恢复上下文/);
    const saved = f.store.read().tasks[0];
    assert.equal(saved.supanote, undefined);
    assert.equal(saved.submittedAt, undefined);
  } finally { f.cleanup(); }
});

test('a paused task accepts its already-returned receipt and secret without becoming live', async () => {
  const f = fixture();
  try {
    const persistence = f.bridge();
    await persistence.persistIntent(intent());
    f.store.update(state => {
      state.settings.autoRun = false;
      state.sites[0].status = 'paused';
    });
    await persistence.persistReceipt(receipt());
    await persistence.persistManageToken({ publicId: PUBLIC_ID, token: TOKEN });
    const saved = f.store.read().tasks[0];
    assert.deepEqual(saved.supanote, { ...intent(), stage: 'api_receipt', publicId: PUBLIC_ID });
    assert.equal(saved.publicUrl, PUBLIC_URL);
    assert.equal(saved.checkpoint, 'supanote_api_receipt');
    assert.equal(saved.status, 'review');
    assert.equal(saved.health, 'pending');
    assert.equal(saved.verifiedAt, undefined);
    assert.equal(saved.firstLiveAt, undefined);
    assert.equal(saved.linkCheck, undefined);
    const cipher = f.store.getCipher(`publication:${TASK_ID}`)!;
    const serialized = Buffer.from(cipher.slice(4), 'base64url').toString();
    assert.deepEqual(parseSupanotePublicationSecret(serialized), {
      version: 1,
      taskId: TASK_ID,
      publicId: PUBLIC_ID,
      publicUrl: PUBLIC_URL,
      token: TOKEN,
    });
  } finally { f.cleanup(); }
});

test('task deletion, draft replacement, and public identity replacement fail closed', async t => {
  await t.test('deleted task', async () => {
    const f = fixture();
    try {
      const persistence = f.bridge();
      await persistence.persistIntent(intent());
      f.store.update(state => { state.tasks = []; });
      await assert.rejects(persistence.persistReceipt(receipt()), /绑定已改变/);
    } finally { f.cleanup(); }
  });
  await t.test('changed draft', async () => {
    const f = fixture();
    try {
      const persistence = f.bridge();
      await persistence.persistIntent(intent());
      f.store.update(state => { state.tasks[0].draft!.body = 'Changed after submission'; });
      await assert.rejects(persistence.persistReceipt(receipt()), /原稿已改变/);
      assert.equal(f.store.read().tasks[0].publicUrl, undefined);
    } finally { f.cleanup(); }
  });
  await t.test('changed public identity', async () => {
    const f = fixture();
    try {
      const persistence = f.bridge();
      await persistence.persistIntent(intent());
      await persistence.persistReceipt(receipt());
      await assert.rejects(persistence.persistReceipt({
        ...receipt(),
        publicId: 'different_note',
        publicUrl: 'https://supanote.app/n/different_note',
      }), /不能更换文章身份/);
      assert.equal(f.store.read().tasks[0].publicUrl, PUBLIC_URL);
    } finally { f.cleanup(); }
  });
});

test('secret encryption or transactional revalidation failure leaves no orphan cipher', async t => {
  await t.test('encryption failure', async () => {
    const f = fixture();
    try {
      const persistence = f.bridge();
      await persistence.persistIntent(intent());
      await persistence.persistReceipt(receipt());
      f.setEncryptHook(() => { throw Error('synthetic keychain failure'); });
      await assert.rejects(persistence.persistManageToken({ publicId: PUBLIC_ID, token: TOKEN }), /keychain/);
      assert.equal(f.store.getCipher(`publication:${TASK_ID}`), undefined);
    } finally { f.cleanup(); }
  });
  await t.test('task removed after encryption', async () => {
    const f = fixture();
    try {
      const persistence = f.bridge();
      await persistence.persistIntent(intent());
      await persistence.persistReceipt(receipt());
      f.setEncryptHook(() => f.store.update(state => { state.tasks = []; }));
      await assert.rejects(persistence.persistManageToken({ publicId: PUBLIC_ID, token: TOKEN }), /绑定已改变/);
      assert.equal(f.store.getCipher(`publication:${TASK_ID}`), undefined);
    } finally { f.cleanup(); }
  });
  await t.test('JSON escaping beyond the backup secret limit', async () => {
    const f = fixture();
    try {
      const persistence = f.bridge();
      await persistence.persistIntent(intent());
      await persistence.persistReceipt(receipt());
      await assert.rejects(
        persistence.persistManageToken({ publicId: PUBLIC_ID, token: '\\'.repeat(8192) }),
        /超出可备份范围/,
      );
      assert.equal(f.store.getCipher(`publication:${TASK_ID}`), undefined);
      assert.equal(f.store.read().tasks[0].publicUrl, PUBLIC_URL);
    } finally { f.cleanup(); }
  });
});

test('the full protocol writes one safe API receipt and never a live verification', async () => {
  const f = fixture();
  try {
    let posts = 0;
    const result = await publishSupanote({
      operationId: 'protocol_operation_43',
      reviewed: true,
      title: TITLE,
      markdown: MARKDOWN,
    }, f.bridge(), {
      now: () => new Date(NOW),
      fetch: async () => {
        posts++;
        return new Response(JSON.stringify({
          url: `/n/${PUBLIC_ID}?token=${TOKEN}&created=1`,
          publicId: PUBLIC_ID,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    assert.equal(result.status, 'published');
    assert.equal(posts, 1);
    const saved = f.store.read().tasks[0];
    assert.equal(saved.supanote?.stage, 'api_receipt');
    assert.equal(saved.status, 'review');
    assert.equal(saved.health, 'pending');
    assert.equal(saved.firstLiveAt, undefined);
    assert.equal(saved.verifiedAt, undefined);
  } finally { f.cleanup(); }
});
