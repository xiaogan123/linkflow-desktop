import {pinPublicationFixtures} from './helpers/publication-snapshot';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Controller } from '../src/main/controller';
import { Store } from '../src/main/store';
import { lucidTesting } from '../src/integrations/lucid';
import type { Site, Task } from '../src/shared/types';
import type { Vault } from '../src/main/vault';

const at = '2026-10-16T00:00:00.000Z';
const slug = 'synthetic-source-check';
const publicUrl = `https://lucid.page/${slug}`;
const target = 'https://example.com/guide';
const draft = { title: 'Synthetic source check', description: 'Synthetic summary', body: `Check the underlying page and record its date, inputs, and limits before drawing a conclusion. [Read the guide](${target}) for the source material.\n\nRecheck the claim when the source changes. Keep the reference visible and separate observation from interpretation so readers can repeat the method rather than rely on an unsupported promise.` };
const site = (): Site => ({ id: 'site', domain: 'example.com', url: 'https://example.com/', email: 'owner@example.com', name: 'Example', description: 'Synthetic guidance', category: 'software', language: 'en', monthlyTarget: 1, status: 'ready', createdAt: at });
function fixture() {
  const store = new Store(':memory:');
  const value: Task = { id: 'task', siteId: 'site', channelId: 'lucid-page', sourceDomain: 'lucid.page', status: 'needs_input', createdAt: at, scheduledAt: at, updatedAt: at, attempts: 1, message: 'Original submission uncertain', topicUrl: target, draft: structuredClone(draft), draftRevision: 1, articleApprovedAt: at, submittedAt: at, checkpoint: 'lucid_publish_submitting', publicUrl, reconcileAttempts: 3, cost: { aiCalls: 2 } };
  value.lucid = { contentHash: lucidTesting.article(value, site().url, false).contentHash, slug, stage: 'submitting' };
  store.update(state => { state.settings.autoRun = false; state.sites = [site()]; state.tasks = [value]; });
  return store;
}
const vault = { available: () => true, get: async () => undefined, set: async () => { throw Error('no secret write'); } } as unknown as Vault;

test('stopped original Lucid receipt needs explicit manual verification and settles only on exact readback', async () => {
  const store = fixture(); let reads = 0, ai = 0;
  const controller = new Controller(pinPublicationFixtures(store), vault, 'fixture', { verifyLucid: async current => { reads++; assert.equal(current.lucid?.stage, 'published'); return { found: true, outcome: 'found', url: publicUrl, rel: 'follow', reason: 'Synthetic exact readback' }; }, aiFactory: (() => { ai++; throw Error('no AI'); }) as never });
  try {
    const before = store.read().tasks[0];
    await controller.verify('task');
    assert.equal(reads, 0); assert.deepEqual(store.read().tasks[0], before);
    await controller.verify('task', { manualRecovery: true });
    const saved = store.read().tasks[0];
    assert.equal(reads, 1); assert.equal(ai, 0); assert.equal(saved.status, 'live');
    assert.equal(saved.lucid?.stage, 'published'); assert.equal(saved.checkpoint, 'lucid_published');
    assert.equal(saved.linkCheck, 'found'); assert.equal(saved.health, 'healthy');
    assert.equal(saved.reconcileAttempts, 3); assert.deepEqual(saved.cost, before.cost);
    assert.deepEqual(saved.draft, before.draft); assert.equal(saved.publicUrl, publicUrl);
  } finally { controller.stop(); store.close(); }
});

test('failed, missing-identity, and stale manual reads preserve the original uncertain receipt', async () => {
  for (const change of ['read-fails', 'wrong-url', 'missing-slug', 'prebound-account', 'stale-draft'] as const) {
    const store = fixture(); let reads = 0;
    if (change === 'wrong-url') store.update(state => { state.tasks[0].publicUrl = 'https://lucid.page/other'; });
    if (change === 'missing-slug') store.update(state => { state.tasks[0].lucid!.slug = undefined; });
    if (change === 'prebound-account') store.update(state => { state.tasks[0].accountId = 'other-account'; });
    const controller = new Controller(pinPublicationFixtures(store), vault, 'fixture', { verifyLucid: async () => {
      reads++;
      if (change === 'stale-draft') store.update(state => { state.tasks[0].draft!.body += ' Concurrent edit.'; });
      return change === 'read-fails' ? { found: false, outcome: 'invalid', url: publicUrl, rel: 'unknown', reason: 'Synthetic mismatch' }
        : { found: true, outcome: 'found', url: publicUrl, rel: 'follow', reason: 'Synthetic exact readback' };
    } });
    try {
      const before = store.read().tasks[0];
      await controller.verify('task', { manualRecovery: true });
      const saved = store.read().tasks[0];
      assert.equal(reads, ['wrong-url', 'missing-slug', 'prebound-account'].includes(change) ? 0 : 1);
      assert.equal(saved.lucid?.stage, 'submitting'); assert.equal(saved.checkpoint, 'lucid_publish_submitting');
      assert.equal(saved.firstLiveAt, undefined); assert.equal(saved.reconcileAttempts, 3);
      if (change !== 'stale-draft') assert.deepEqual(saved, before);
    } finally { controller.stop(); store.close(); }
  }
});

test('manual readback cannot promote a task whose site, channel, or account changed during verification', async () => {
  for (const change of ['site', 'channel', 'account'] as const) {
    const store = fixture(); let reads = 0;
    const controller = new Controller(pinPublicationFixtures(store), vault, 'fixture', { verifyLucid: async () => {
      reads++;
      store.update(state => {
        const current = state.tasks[0];
        if (change === 'site') current.siteId = 'other-site';
        if (change === 'channel') current.channelId = 'nostr';
        if (change === 'account') current.accountId = 'other-account';
      });
      return { found: true, outcome: 'found', url: publicUrl, rel: 'follow', reason: 'Synthetic exact readback' };
    } });
    try {
      await controller.verify('task', { manualRecovery: true });
      const saved = store.read().tasks[0];
      assert.equal(reads, 1);
      assert.equal(saved.lucid?.stage, 'submitting'); assert.equal(saved.checkpoint, 'lucid_publish_submitting');
      assert.equal(saved.firstLiveAt, undefined); assert.equal(saved.reconcileAttempts, 3);
      assert.equal(saved.siteId, change === 'site' ? 'other-site' : 'site');
      assert.equal(saved.channelId, change === 'channel' ? 'nostr' : 'lucid-page');
      assert.equal(saved.accountId, change === 'account' ? 'other-account' : undefined);
    } finally { controller.stop(); store.close(); }
  }
});
