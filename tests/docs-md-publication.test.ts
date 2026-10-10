import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createDocsMdShare,
  type DocsMdIntent,
  type DocsMdPersistence,
  type DocsMdReceipt,
} from '../src/integrations/docs-md';
import {
  createDocsMdPublicationPersistence,
  docsMdTaskIdentity,
  docsMdTaskSource,
  parseDocsMdPublicationSecret,
} from '../src/main/docs-md-publication';
import { validateBackup } from '../src/main/backup-validation';
import { Store } from '../src/main/store';
import type { Site, Task } from '../src/shared/types';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-10-09T10:00:00.000Z';
const TITLE = 'Reviewed Docs MD guide';
const BODY = 'Original reviewed Markdown with a [source](https://example.com/research).';
const SOURCE = `# ${TITLE}\n\n${BODY}`;
const PUBLIC_ID = 'cycle-50-doc';
const PUBLIC_URL = `https://docs-md.com/${PUBLIC_ID}`;
const RAW_URL = `https://docs-md.com/raw/${PUBLIC_ID}`;
const EDIT_TOKEN = Buffer.from(Array.from({ length: 24 }, (_, index) => index + 1)).toString('base64url');

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

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    siteId: SITE_ID,
    channelId: 'docs-md',
    sourceDomain: 'docs-md.com',
    status: 'running',
    health: 'pending',
    createdAt: NOW,
    scheduledAt: NOW,
    updatedAt: NOW,
    attempts: 1,
    message: 'Ready',
    articleApprovedAt: NOW,
    draft: { title: TITLE, description: 'Fixture', body: BODY },
    ...overrides,
  };
}

function intent(operationId = 'docs_md_operation_50', value: Task = task()): DocsMdIntent {
  const identity = docsMdTaskIdentity(value);
  assert.ok(identity);
  return {
    operationId,
    sourceHash: identity.sourceHash,
    requestHash: identity.requestHash,
    createdAt: NOW,
  };
}

function receipt(value: DocsMdIntent = intent(), id = PUBLIC_ID): DocsMdReceipt {
  return {
    operationId: value.operationId,
    id,
    publicUrl: `https://docs-md.com/${id}`,
    rawUrl: `https://docs-md.com/raw/${id}`,
    sourceHash: value.sourceHash,
    requestHash: value.requestHash,
    expiresAt: 0,
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'linkflow-docs-md-persistence-'));
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
  const bridge = (expectedIntent?: DocsMdIntent) => createDocsMdPublicationPersistence(store, vault, {
    taskId: TASK_ID,
    siteId: SITE_ID,
    ...(expectedIntent ? { expectedIntent } : {}),
    now: () => new Date(NOW),
    assertSubmissionAuthorized(snapshot) {
      if (!authorized || !snapshot.state.settings.autoRun || snapshot.task.status !== 'running'
        || snapshot.site.status !== 'ready' || !snapshot.task.articleApprovedAt) {
        throw Error('synthetic authorization denied');
      }
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
    cleanup() {
      try { store.close(); } catch {}
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function successResponse() {
  return new Response(JSON.stringify({
    success: true,
    id: PUBLIC_ID,
    url: PUBLIC_URL,
    rawUrl: RAW_URL,
    editToken: EDIT_TOKEN,
    expiresAt: 0,
    rateLimit: { remaining: 19 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('the frozen task source has one literal title and hashes the exact protocol bytes', () => {
  assert.equal(docsMdTaskSource(task()), SOURCE);
  assert.equal(docsMdTaskSource(task({ draft: {
    title: TITLE,
    description: 'Fixture',
    body: SOURCE,
  } })), SOURCE);
  assert.equal(docsMdTaskSource(task({ draft: {
    title: TITLE,
    description: 'Fixture',
    body: `# Different title\n\n${BODY}`,
  } })), undefined);
  assert.equal(docsMdTaskSource(task({ draft: {
    title: TITLE,
    description: 'Fixture',
    body: `${TITLE}\n===\n\n${BODY}`,
  } })), undefined);
  const punctuation = task({ draft: {
    title: 'Fees: [facts] & risks',
    description: 'Fixture',
    body: BODY,
  } });
  const escaped = '# Fees: \\[facts\\] \\& risks\n\n' + BODY;
  assert.equal(docsMdTaskSource(punctuation), escaped);
  const identity = docsMdTaskIdentity(punctuation);
  assert.ok(identity);
  const body = JSON.stringify({ content: escaped, filename: 'publication.md', expiry: 'never' });
  assert.equal(identity.sourceHash, createHash('sha256').update(escaped).digest('hex'));
  assert.equal(identity.requestHash, createHash('sha256').update(body).digest('hex'));
});

test('authorization and existing task state fail before a durable intent', async () => {
  const f = fixture();
  try {
    f.setAuthorized(false);
    await assert.rejects(f.bridge().persistIntent(intent()), /authorization denied/);
    assert.equal(f.store.read().tasks[0].docsMd, undefined);
    f.setAuthorized(true);
    f.store.update(state => { state.settings.autoRun = false; });
    await assert.rejects(f.bridge().persistIntent(intent()), /已暂停/);
    assert.equal(f.store.read().tasks[0].submittedAt, undefined);
  } finally {
    f.cleanup();
  }
});

test('a draft that cannot survive the strict backup schema is rejected before the CAS', async () => {
  const f = fixture();
  try {
    f.store.update(state => {
      state.tasks[0].draft!.description = 'x'.repeat(30_001);
    });
    await assert.rejects(f.bridge().persistIntent(intent()), /超出可备份范围/);
    assert.equal(f.store.read().tasks[0].docsMd, undefined);
    assert.equal(f.store.read().tasks[0].submittedAt, undefined);
  } finally {
    f.cleanup();
  }
});

test('anonymous binding and pre-existing verification traces reject the intent CAS', async () => {
  for (const mutate of [
    (value: ReturnType<Store['read']>) => {
      value.accounts.push({
        id: '33333333-3333-4333-8333-333333333333',
        channelId: 'docs-md',
        email: 'owner@example.com',
        username: 'anonymous',
        createdAt: NOW,
        status: 'registered',
        hasPassword: false,
      });
    },
    (value: ReturnType<Store['read']>) => { value.tasks[0].health = 'unknown'; },
    (value: ReturnType<Store['read']>) => { value.tasks[0].lastCheckedAt = NOW; },
  ]) {
    const f = fixture();
    try {
      f.store.update(mutate);
      await assert.rejects(f.bridge().persistIntent(intent()));
      assert.equal(f.store.read().tasks[0].docsMd, undefined);
    } finally {
      f.cleanup();
    }
  }
});

test('strict backup and intent CAS both reject local drafts carrying remote lifecycle leftovers', async () => {
  const mutations: Array<(value: Task) => void> = [
    value => { value.reconcileAttempts = 0; },
    value => { value.reconcileAfter = NOW; },
    value => { value.reviewUntil = NOW; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    try {
      f.store.update(state => { mutate(state.tasks[0]); });
      const before = f.store.read();
      assert.throws(() => validateBackup({ state: before, secrets: {} }), /Docs MD/);
      await assert.rejects(f.bridge().persistIntent(intent()));
      const saved = f.store.read().tasks[0];
      assert.equal(saved.docsMd, undefined);
      assert.equal(saved.submittedAt, undefined);
    } finally {
      f.cleanup();
    }
  }
});

test('receipt and token persistence reject every forbidden pending lifecycle field', async () => {
  const mutations: Array<(value: Task) => void> = [
    value => { value.publicationMethod = 'external'; },
    value => { value.reviewUntil = NOW; },
    value => { value.lastCheckedAt = NOW; },
    value => { value.nextCheckAt = NOW; },
    value => { value.reconcileAttempts = 0; },
    value => { value.reconcileAfter = NOW; },
  ];
  for (const mutate of mutations) {
    const receiptFixture = fixture();
    try {
      const persistence = receiptFixture.bridge();
      const expected = intent();
      await persistence.persistIntent(expected);
      receiptFixture.store.update(state => { mutate(state.tasks[0]); });
      await assert.rejects(persistence.persistReceipt(receipt(expected)), /公开验收通过/);
      assert.equal(receiptFixture.store.read().tasks[0].docsMd?.stage, 'submitting');
      assert.equal(receiptFixture.store.read().tasks[0].publicUrl, undefined);
    } finally {
      receiptFixture.cleanup();
    }

    const tokenFixture = fixture();
    try {
      const persistence = tokenFixture.bridge();
      const expected = intent();
      await persistence.persistIntent(expected);
      await persistence.persistReceipt(receipt(expected));
      tokenFixture.store.update(state => { mutate(state.tasks[0]); });
      await assert.rejects(persistence.persistEditTokenAtomically({
        operationId: expected.operationId,
        id: PUBLIC_ID,
        editToken: EDIT_TOKEN,
      }), /公开验收通过/);
      assert.equal(tokenFixture.store.getCipher(`publication:${TASK_ID}`), undefined);
    } finally {
      tokenFixture.cleanup();
    }
  }
});

test('two callers sharing the real SQLite Store issue at most one canonical POST', async () => {
  const f = fixture();
  try {
    let posts = 0;
    const bodies: string[] = [];
    const fetch = async (_url: string, init: RequestInit) => {
      posts++;
      assert.equal(f.store.read().tasks[0].docsMd?.stage, 'submitting');
      assert.equal(f.store.read().tasks[0].checkpoint, 'docs_md_share_submitting');
      bodies.push(String(init.body));
      return successResponse();
    };
    const outcomes = await Promise.all([
      createDocsMdShare({
        operationId: 'docs_md_concurrent_a',
        reviewed: true,
        markdown: SOURCE,
      }, f.bridge(), { fetch, now: () => new Date(NOW) }),
      createDocsMdShare({
        operationId: 'docs_md_concurrent_b',
        reviewed: true,
        markdown: SOURCE,
      }, f.bridge(), { fetch, now: () => new Date(NOW) }),
    ]);
    assert.equal(posts, 1);
    assert.deepEqual(JSON.parse(bodies[0]), {
      content: SOURCE,
      filename: 'publication.md',
      expiry: 'never',
    });
    assert.equal(outcomes.filter(result => result.status === 'created').length, 1);
    assert.equal(outcomes.filter(result => result.status === 'not_started').length, 1);
    const saved = f.store.read().tasks[0];
    assert.equal(saved.docsMd?.stage, 'api_receipt');
    assert.equal(saved.docsMd?.id, PUBLIC_ID);
    assert.equal(saved.publicUrl, PUBLIC_URL);
    assert.equal(saved.status, 'review');
    assert.equal(saved.health, 'pending');
    assert.equal(saved.firstLiveAt, undefined);
    assert.equal(saved.verifiedAt, undefined);
    const cipher = f.store.getCipher(`publication:${TASK_ID}`);
    assert.ok(cipher?.startsWith('enc:'));
    assert.equal(JSON.stringify(saved).includes(EDIT_TOKEN), false);
    assert.equal(f.store.read().events.some(event => event.message.includes(EDIT_TOKEN)), false);
  } finally {
    f.cleanup();
  }
});

test('a SQLite reopen preserves the intent and a prior intent blocks every replacement POST', async () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    await f.bridge().persistIntent(intent());
    f.store.close();
    reopened = new Store(f.path);
    const saved = reopened.read().tasks[0].docsMd;
    assert.ok(saved);
    let posts = 0;
    const result = await createDocsMdShare({
      operationId: 'docs_md_replacement_50',
      reviewed: true,
      markdown: SOURCE,
      priorIntent: {
        operationId: saved.operationId,
        sourceHash: saved.sourceHash,
        requestHash: saved.requestHash,
        createdAt: saved.createdAt,
      },
    }, createDocsMdPublicationPersistence(reopened, { encryptSecrets: values => values }, {
      taskId: TASK_ID,
      siteId: SITE_ID,
      expectedIntent: saved,
      assertSubmissionAuthorized: () => true,
    }), { fetch: async () => { posts++; return successResponse(); } });
    assert.equal(result.status, 'blocked');
    assert.equal(posts, 0);
    assert.equal(reopened.read().tasks[0].docsMd?.operationId, 'docs_md_operation_50');
  } finally {
    try { reopened?.close(); } catch {}
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('a paused site accepts only the original late receipt and encrypted edit token', async () => {
  const f = fixture();
  try {
    const persistence = f.bridge();
    const expected = intent();
    await persistence.persistIntent(expected);
    assert.equal(validateBackup({ state: f.store.read(), secrets: {} })
      .state.tasks[0].docsMd?.stage, 'submitting');
    f.store.update(state => {
      state.settings.autoRun = false;
      state.sites[0].status = 'paused';
    });
    await persistence.persistReceipt(receipt(expected));
    assert.equal(validateBackup({ state: f.store.read(), secrets: {} })
      .state.tasks[0].docsMd?.stage, 'api_receipt');
    await persistence.persistEditTokenAtomically({
      operationId: expected.operationId,
      id: PUBLIC_ID,
      editToken: EDIT_TOKEN,
    });
    const saved = f.store.read().tasks[0];
    assert.deepEqual(saved.docsMd, { ...expected, stage: 'api_receipt', id: PUBLIC_ID });
    assert.equal(saved.publicUrl, PUBLIC_URL);
    assert.equal(saved.checkpoint, 'docs_md_api_receipt');
    assert.equal(saved.status, 'review');
    assert.equal(saved.health, 'pending');
    const cipher = f.store.getCipher(`publication:${TASK_ID}`)!;
    const serialized = Buffer.from(cipher.slice(4), 'base64url').toString();
    const restored = validateBackup({
      state: f.store.read(),
      secrets: { [`publication:${TASK_ID}`]: serialized },
    });
    assert.equal(restored.state.tasks[0].docsMd?.stage, 'api_receipt');
    assert.deepEqual(parseDocsMdPublicationSecret(serialized), {
      version: 1,
      taskId: TASK_ID,
      operationId: expected.operationId,
      id: PUBLIC_ID,
      publicUrl: PUBLIC_URL,
      sourceHash: expected.sourceHash,
      requestHash: expected.requestHash,
      editToken: EDIT_TOKEN,
    });
  } finally {
    f.cleanup();
  }
});

test('receipt and token callbacks require the exact operation, URLs, hashes, and remote id', async () => {
  const f = fixture();
  try {
    const persistence = f.bridge();
    const expected = intent();
    await persistence.persistIntent(expected);
    await assert.rejects(persistence.persistReceipt({
      ...receipt(expected),
      rawUrl: 'https://docs-md.com/raw/different-doc',
    }), /回执无效/);
    assert.equal(f.store.read().tasks[0].docsMd?.stage, 'submitting');
    await persistence.persistReceipt(receipt(expected));
    for (const secret of [
      { operationId: 'docs_md_other_operation_50', id: PUBLIC_ID, editToken: EDIT_TOKEN },
      { operationId: expected.operationId, id: 'different-doc', editToken: EDIT_TOKEN },
      { operationId: expected.operationId, id: PUBLIC_ID, editToken: 'bad-token' },
    ]) {
      await assert.rejects(persistence.persistEditTokenAtomically(secret));
      assert.equal(f.store.getCipher(`publication:${TASK_ID}`), undefined);
    }
  } finally {
    f.cleanup();
  }
});

test('deletion, draft replacement, intent replacement, and receipt replacement fail closed', async t => {
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
  await t.test('changed intent', async () => {
    const f = fixture();
    try {
      const persistence = f.bridge();
      await persistence.persistIntent(intent());
      f.store.update(state => { state.tasks[0].docsMd!.operationId = 'docs_md_replaced_50'; });
      await assert.rejects(persistence.persistReceipt(receipt()), /原任务不一致/);
    } finally { f.cleanup(); }
  });
  await t.test('changed receipt identity', async () => {
    const f = fixture();
    try {
      const persistence = f.bridge();
      await persistence.persistIntent(intent());
      await persistence.persistReceipt(receipt());
      await assert.rejects(
        persistence.persistReceipt(receipt(intent(), 'different-doc')),
        /不能更换文章身份/,
      );
      assert.equal(f.store.read().tasks[0].publicUrl, PUBLIC_URL);
    } finally { f.cleanup(); }
  });
});

test('secret failures and late races never create or replace a publication cipher', async t => {
  await t.test('encryption failure', async () => {
    const f = fixture();
    try {
      const persistence = f.bridge();
      await persistence.persistIntent(intent());
      await persistence.persistReceipt(receipt());
      f.setEncryptHook(() => { throw Error('synthetic keychain failure'); });
      await assert.rejects(persistence.persistEditTokenAtomically({
        operationId: intent().operationId,
        id: PUBLIC_ID,
        editToken: EDIT_TOKEN,
      }), /未能加密/);
      assert.equal(f.store.getCipher(`publication:${TASK_ID}`), undefined);
    } finally { f.cleanup(); }
  });
  await t.test('state replacement after encryption', async () => {
    const f = fixture();
    try {
      const persistence = f.bridge();
      await persistence.persistIntent(intent());
      await persistence.persistReceipt(receipt());
      f.setEncryptHook(() => { f.store.update(state => { state.tasks[0].draft!.body += ' changed'; }); });
      await assert.rejects(persistence.persistEditTokenAtomically({
        operationId: intent().operationId,
        id: PUBLIC_ID,
        editToken: EDIT_TOKEN,
      }), /原稿已改变/);
      assert.equal(f.store.getCipher(`publication:${TASK_ID}`), undefined);
    } finally { f.cleanup(); }
  });
  await t.test('late existing cipher is not overwritten', async () => {
    const f = fixture();
    try {
      const persistence = f.bridge();
      await persistence.persistIntent(intent());
      await persistence.persistReceipt(receipt());
      const key = `publication:${TASK_ID}`;
      f.setEncryptHook(() => { f.store.setCipher(key, 'preexisting-cipher'); });
      await assert.rejects(persistence.persistEditTokenAtomically({
        operationId: intent().operationId,
        id: PUBLIC_ID,
        editToken: EDIT_TOKEN,
      }), /已经保存/);
      assert.equal(f.store.getCipher(key), 'preexisting-cipher');
    } finally { f.cleanup(); }
  });
  await t.test('SQLite cipher failure rolls back without an orphan', async () => {
    const f = fixture();
    try {
      const persistence = f.bridge();
      await persistence.persistIntent(intent());
      await persistence.persistReceipt(receipt());
      const database = (f.store as unknown as { db: { exec(sql: string): void } }).db;
      database.exec(`CREATE TRIGGER reject_docs_md_cipher BEFORE INSERT ON secrets
        WHEN NEW.key = 'publication:${TASK_ID}'
        BEGIN SELECT RAISE(ABORT, 'synthetic cipher failure'); END;`);
      await assert.rejects(persistence.persistEditTokenAtomically({
        operationId: intent().operationId,
        id: PUBLIC_ID,
        editToken: EDIT_TOKEN,
      }), /synthetic cipher failure/);
      assert.equal(f.store.getCipher(`publication:${TASK_ID}`), undefined);
      assert.equal(f.store.read().tasks[0].docsMd?.stage, 'api_receipt');
    } finally { f.cleanup(); }
  });
});

test('receipt or token persistence failures retain sanitized recovery state without a token orphan', async t => {
  await t.test('receipt persistence fails before token storage', async () => {
    const f = fixture();
    try {
      const base = f.bridge();
      const persistence: DocsMdPersistence = {
        ...base,
        async persistReceipt() { throw Error('synthetic receipt failure'); },
      };
      const result = await createDocsMdShare({
        operationId: 'docs_md_receipt_failure',
        reviewed: true,
        markdown: SOURCE,
      }, persistence, {
        fetch: async () => successResponse(),
        now: () => new Date(NOW),
      });
      assert.equal(result.status, 'created_persistence_unknown');
      if (result.status !== 'created_persistence_unknown') return;
      assert.deepEqual(result.persistence, { receipt: 'unknown', secret: 'unknown' });
      assert.equal(f.store.read().tasks[0].docsMd?.stage, 'submitting');
      assert.equal(f.store.getCipher(`publication:${TASK_ID}`), undefined);
      assert.equal(JSON.stringify(result).includes(EDIT_TOKEN), false);
    } finally { f.cleanup(); }
  });
  await t.test('token encryption fails after the receipt commit', async () => {
    const f = fixture();
    try {
      f.setEncryptHook(() => { throw Error('synthetic keychain failure'); });
      const result = await createDocsMdShare({
        operationId: 'docs_md_token_failure',
        reviewed: true,
        markdown: SOURCE,
      }, f.bridge(), {
        fetch: async () => successResponse(),
        now: () => new Date(NOW),
      });
      assert.equal(result.status, 'created_persistence_unknown');
      if (result.status !== 'created_persistence_unknown') return;
      assert.deepEqual(result.persistence, { receipt: 'saved', secret: 'unknown' });
      assert.equal(f.store.read().tasks[0].docsMd?.stage, 'api_receipt');
      assert.equal(f.store.read().tasks[0].publicUrl, PUBLIC_URL);
      assert.equal(f.store.getCipher(`publication:${TASK_ID}`), undefined);
      assert.equal(JSON.stringify(result).includes(EDIT_TOKEN), false);
    } finally { f.cleanup(); }
  });
});

test('secret parsing requires exact keys, exact identity, and a 24-byte base64url token', () => {
  const expected = intent();
  const value = JSON.stringify({
    version: 1,
    taskId: TASK_ID,
    operationId: expected.operationId,
    id: PUBLIC_ID,
    publicUrl: PUBLIC_URL,
    sourceHash: expected.sourceHash,
    requestHash: expected.requestHash,
    editToken: EDIT_TOKEN,
  });
  assert.ok(parseDocsMdPublicationSecret(value));
  assert.equal(parseDocsMdPublicationSecret(JSON.stringify({
    ...JSON.parse(value),
    extra: true,
  })), undefined);
  assert.equal(parseDocsMdPublicationSecret(JSON.stringify({
    ...JSON.parse(value),
    editToken: 'not-a-token',
  })), undefined);
  assert.equal(parseDocsMdPublicationSecret(JSON.stringify({
    ...JSON.parse(value),
    publicUrl: `${PUBLIC_URL}/`,
  })), undefined);
});
