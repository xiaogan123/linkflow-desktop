import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller, isConfirmedSupanoteResultUrl } from '../src/main/controller';
import { Store } from '../src/main/store';
import { supanoteTaskContentHash } from '../src/main/supanote-publication';
import type { LinkResult, Site, Task } from '../src/shared/types';
import type { Vault } from '../src/main/vault';

const stamp = '2026-10-01T00:00:00.000Z';
const site: Site = {
  id: '11111111-1111-4111-8111-111111111111', domain: 'example.com',
  url: 'https://example.com/', email: 'owner@example.com', name: 'Example guides',
  description: 'Original guides', category: 'content', language: 'en',
  monthlyTarget: 1, status: 'ready', createdAt: stamp,
};
const original: Task = {
  id: '22222222-2222-4222-8222-222222222222', siteId: site.id,
  channelId: 'telegraph', sourceDomain: 'telegra.ph',
  publicUrl: 'https://telegra.ph/Original-guide-10-01', publicationMethod: 'external',
  status: 'review', attempts: 0, createdAt: stamp, updatedAt: stamp,
  scheduledAt: stamp, nextCheckAt: stamp, message: 'Waiting for verification',
};

function fixture(fail: boolean, task: Task = original) {
  const store = new Store(':memory:');
  store.update(state => {
    state.settings.autoRun = false;
    state.sites = [structuredClone(site)];
    state.tasks = [structuredClone(task)];
  });
  let start!: () => void, finish!: () => void;
  const ready = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0, notices = 0;
  const read = async (): Promise<LinkResult> => {
    const checkedUrl = store.read().tasks[0]?.publicUrl ?? task.publicUrl!;
    calls++;
    start();
    await gate;
    if (fail && calls === 1) throw Error('Old verification temporarily failed');
    return { found: true, outcome: 'found', url: checkedUrl, rel: 'nofollow', reason: 'Verified fixture' };
  };
  const controller = new Controller(store, { available: () => true } as unknown as Vault, 'verification-fixture', {
    verifyLink: read, verifySupanote: read,
  });
  controller.onNotice = () => { notices++; };
  return { store, controller, ready, finish, calls: () => calls, notices: () => notices };
}

for (const fail of [true, false]) {
  test(`late ${fail ? 'failure' : 'success'} for an old URL preserves the replacement URL and immediate check`, async () => {
    const f = fixture(fail);
    try {
      const pending = f.controller.verify(original.id);
      await f.ready;
      // The task:set-url IPC applies these changes before requesting verification.
      f.controller.patch(original.id, {
        publicUrl: 'https://telegra.ph/Replacement-guide-10-02',
        verifiedAt: undefined, lastCheckedAt: undefined, linkRel: undefined,
        linkCheck: undefined, status: 'review', reviewKind: 'manual_url',
        reviewUntil: '2026-11-01T00:00:00.000Z', nextCheckAt: stamp, health: 'unknown',
      });
      await f.controller.verify(original.id);
      const replacement = f.store.read().tasks[0];
      f.finish();
      await pending;
      assert.deepEqual(f.store.read().tasks[0], replacement);
      assert.equal(f.notices(), 0);
      assert.equal(f.controller.hasPendingWork(), false);
      await f.controller.verify(original.id);
      assert.equal(f.calls(), 2);
      assert.equal(f.store.read().tasks[0].linkCheck, 'found');
    } finally { f.finish(); f.store.close(); }
  });
}

test('failure for the unchanged URL keeps bounded retry timing and allows a subsequent check', async () => {
  const f = fixture(true);
  try {
    const pending = f.controller.verify(original.id);
    await f.ready;
    f.finish();
    await pending;
    const saved = f.store.read().tasks[0];
    assert.equal(saved.health, 'unknown');
    assert.match(saved.message, /核验暂时失败/);
    assert.ok(saved.lastCheckedAt);
    assert.ok(Math.abs(Date.parse(saved.nextCheckAt!) - Date.parse(saved.lastCheckedAt!) - 7 * 86400000) < 1000);
    assert.equal(f.controller.hasPendingWork(), false);
    await f.controller.verify(original.id);
    assert.equal(f.store.read().tasks[0].linkCheck, 'found');
  } finally { f.finish(); f.store.close(); }
});

test('a late verification failure does not recreate a deleted site or task', async () => {
  const f = fixture(true);
  try {
    const pending = f.controller.verify(original.id);
    await f.ready;
    f.controller.deleteSite(site.id);
    f.finish();
    await pending;
    assert.equal(f.store.read().sites.length, 0);
    assert.equal(f.store.read().tasks.length, 0);
    assert.equal(f.store.read().events.length, 0);
    assert.equal(f.controller.hasPendingWork(), false);
  } finally { f.finish(); f.store.close(); }
});

for (const changeIntent of [true, false]) test(`Supanote failure ${changeIntent ? 'cannot alter a different intent at the same URL' : 'records a retry for the unchanged intent'}`, async () => {
  const task: Task = {
    ...original, channelId: 'supanote', sourceDomain: 'supanote.app',
    publicUrl: 'https://supanote.app/n/11111111-1111-4111-8111-111111111111',
    publicationMethod: 'client', submittedAt: stamp, checkpoint: 'supanote_api_receipt',
    draft: { title: 'A useful guide', description: 'Original guide', body: '# A useful guide\n\nAn original guide with a [source](https://example.com/guide).' },
    supanote: {
      operationId: 'supanote_11111111111141118111111111111111', contentHash: 'a'.repeat(64),
      createdAt: stamp, stage: 'api_receipt', publicId: '11111111-1111-4111-8111-111111111111',
    },
  };
  task.supanote!.contentHash = supanoteTaskContentHash(task)!;
  assert.equal(isConfirmedSupanoteResultUrl(task, task.publicUrl!), true);
  const f = fixture(true, task);
  try {
    const pending = f.controller.verify(original.id);
    await f.ready;
    if (changeIntent) f.store.update(state => { state.tasks[0].supanote!.operationId = 'supanote_33333333333343338333333333333333'; });
    const replacement = f.store.read().tasks[0];
    f.finish();
    await pending;
    if (changeIntent) assert.deepEqual(f.store.read().tasks[0], replacement);
    else {
      assert.match(f.store.read().tasks[0].message, /核验暂时失败/);
      assert.ok(f.store.read().tasks[0].nextCheckAt);
    }
    assert.equal(f.controller.hasPendingWork(), false);
  } finally { f.finish(); f.store.close(); }
});


for (const fail of [false, true]) {
  test(`a newer skip survives an earlier verification ${fail ? 'failure' : 'success'} and permits a fresh manual check`, async () => {
    const f = fixture(fail);
    try {
      const pending = f.controller.verify(original.id);
      await f.ready;
      assert.notEqual(f.controller.runtime.activeTaskId, original.id);
      // The task:skip IPC keeps this decision and replans while a read is pending.
      f.controller.patch(original.id, { status: 'skipped', message: '已跳过，保留记录避免重复提交' });
      f.controller.plan();
      const skipped = f.store.read().tasks[0];
      f.finish();
      await pending;
      assert.deepEqual(f.store.read().tasks[0], skipped);
      assert.equal(f.notices(), 0);
      assert.equal(f.controller.hasPendingWork(), false);
      // A later, explicit read is a new decision; it may establish the live result.
      await f.controller.verify(original.id);
      assert.equal(f.store.read().tasks[0].status, 'live');
      assert.equal(f.calls(), 2);
      assert.equal(f.notices(), 1);
    } finally { f.finish(); f.store.close(); }
  });
}
