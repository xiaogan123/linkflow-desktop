import assert from 'node:assert/strict';
import test from 'node:test';
import { Controller } from '../src/main/controller';
import { Store } from '../src/main/store';
import { nostrTesting } from '../src/integrations/nostr';
import type { Account, Channel, Site, Task } from '../src/shared/types';
import type { Vault } from '../src/main/vault';

const at = '2026-10-17T00:00:00.000Z';
const pubkey = '1'.repeat(64);
const receipt = { pubkey, eventId: '2'.repeat(64), identifier: 'linkflow-synthetic', contentHash: '3'.repeat(64), createdAt: 1_797_120_000, stage: 'submitting' as const };
const publicUrl = nostrTesting.publicUrlFor(receipt);
const site: Site = { id: 'site', domain: 'example.com', url: 'https://example.com/', email: 'owner@example.com', name: 'Example', description: 'Synthetic', category: 'software', language: 'en', monthlyTarget: 1, status: 'ready', createdAt: at };
const channel: Channel = { id: 'nostr', name: 'Nostr', domain: 'njump.me', url: 'https://njump.me', submitUrl: 'https://njump.me', categories: ['general'], languages: ['en'], kind: 'article', emailRequired: false, accountRequired: true, articleRequired: true, free: 'yes', freeNote: 'fixture', automation: 'api', quality: 'A', qualityReason: 'fixture', rulesUrl: 'https://njump.me', checkedAt: '2026-10-17', notes: '', allowedHosts: ['njump.me'], enabled: true };
const account: Account = { id: 'account', channelId: 'nostr', email: '', username: pubkey, createdAt: at, updatedAt: at, registeredAt: at, status: 'registered', source: 'generated', credentialKind: 'api_token', hasPassword: true };
const task = (): Task => ({ id: 'task', siteId: site.id, channelId: 'nostr', accountId: account.id, sourceDomain: 'njump.me', status: 'needs_input', createdAt: at, scheduledAt: at, updatedAt: at, attempts: 1, message: 'Original event result unknown', topicUrl: 'https://example.com/guide', draft: { title: 'Synthetic Nostr article', description: 'Synthetic', body: 'A complete synthetic article preserves its inputs and limits before drawing a conclusion. [Read the original guide](https://example.com/guide) for the underlying evidence.\n\nThe second paragraph keeps the fixture substantial and records that the result must be checked again when the source changes.' }, draftRevision: 1, submittedAt: at, checkpoint: 'nostr_publish_submitting', nostr: structuredClone(receipt), reconcileAttempts: 3, health: 'pending', cost: { aiCalls: 2 } });

function fixture() {
  const store = new Store(':memory:');
  store.update(state => { state.settings.autoRun = false; state.sites = [structuredClone(site)]; state.accounts = [structuredClone(account)]; state.accountBindings = [{ id: 'binding', siteId: site.id, channelId: 'nostr', accountId: account.id, createdAt: at, updatedAt: at }]; state.tasks = [task()]; });
  return store;
}

test('explicit exhausted Nostr recovery reads only the original receipt and preserves attempt history', async () => {
  const store = fixture(); let reads = 0, secrets = 0, ai = 0;
  const vault = { available: () => true, get: async () => { secrets++; return undefined; }, set: async () => { throw Error('no secret write'); } } as unknown as Vault;
  const controller = new Controller(store, vault, 'fixture', { channelCatalog: [channel], verifyNostr: async current => { reads++; assert.equal(current.nostr?.stage, 'published'); assert.equal(current.publicUrl, undefined); return { found: true, outcome: 'found', url: publicUrl, rel: 'follow', reason: 'Synthetic exact relay and reader match' }; }, aiFactory: (() => { ai++; throw Error('no AI'); }) as never });
  try {
    await controller.verify('task');
    assert.equal(reads, 0);
    await controller.verify('task', { manualRecovery: true });
    const saved = store.read().tasks[0];
    assert.equal(reads, 1); assert.equal(secrets, 0); assert.equal(ai, 0);
    assert.equal(saved.status, 'live'); assert.equal(saved.nostr?.stage, 'published');
    assert.equal(saved.checkpoint, 'nostr_published'); assert.equal(saved.publicUrl, publicUrl);
    assert.equal(saved.reconcileAttempts, 3); assert.deepEqual(saved.cost, { aiCalls: 2 });
  } finally { controller.stop(); store.close(); }
});

test('a concurrent Nostr identity or draft change cannot be promoted live', async () => {
  for (const change of ['draft', 'account', 'binding', 'site', 'channel'] as const) {
    const store = fixture(); let reads = 0;
    const vault = { available: () => true, get: async () => { throw Error('secret read forbidden'); }, set: async () => { throw Error('secret write forbidden'); } } as unknown as Vault;
    const controller = new Controller(store, vault, 'fixture', { channelCatalog: [channel], verifyNostr: async () => {
      reads++;
      store.update(state => {
        if (change === 'draft') state.tasks[0].draft!.body += ' Concurrent edit.';
        if (change === 'account') state.accounts[0].username = '4'.repeat(64);
        if (change === 'binding') state.accountBindings[0].accountId = 'other';
        if (change === 'site') state.sites[0].status = 'paused';
        if (change === 'channel') state.settings.channelOverrides.nostr = false;
      });
      return { found: true, outcome: 'found', url: publicUrl, rel: 'follow', reason: 'Synthetic exact relay and reader match' };
    } });
    try {
      await controller.verify('task', { manualRecovery: true });
      const saved = store.read().tasks[0];
      assert.equal(reads, 1, change); assert.notEqual(saved.status, 'live', change);
      assert.equal(saved.nostr?.stage, 'submitting', change); assert.equal(saved.reconcileAttempts, 3, change);
    } finally { controller.stop(); store.close(); }
  }
});

test('a failed explicit Nostr readback keeps the receipt and gives a truthful retry-free message', async () => {
  const store = fixture();
  const controller = new Controller(store, {} as Vault, 'fixture', { channelCatalog: [channel], verifyNostr: async () => ({ found: false, outcome: 'unreachable', url: publicUrl, rel: 'unknown', reason: 'Synthetic reader unavailable' }) });
  try {
    await controller.verify('task', { manualRecovery: true });
    const saved = store.read().tasks[0];
    assert.equal(saved.status, 'needs_input'); assert.equal(saved.nostr?.stage, 'submitting');
    assert.equal(saved.reconcileAttempts, 3); assert.equal(saved.publicUrl, undefined);
    assert.match(saved.message, /Synthetic reader unavailable/); assert.match(saved.message, /不会重发/);
    assert.equal(saved.firstLiveAt, undefined);
  } finally { controller.stop(); store.close(); }
});

test('paused, disabled, skipped, expired, or not-yet-exhausted Nostr tasks never start manual readback', async () => {
  for (const change of ['paused', 'disabled', 'skipped', 'expired', 'budget'] as const) {
    const store = fixture(); let reads = 0;
    store.update(state => {
      if (change === 'paused') state.sites[0].status = 'paused';
      if (change === 'disabled') state.settings.channelOverrides.nostr = false;
      if (change === 'skipped' || change === 'expired') state.tasks[0].status = change;
      if (change === 'budget') state.tasks[0].reconcileAttempts = 2;
    });
    const controller = new Controller(store, {} as Vault, 'fixture', { channelCatalog: [channel], verifyNostr: async () => { reads++; throw Error('must not read'); } });
    try { await controller.verify('task', { manualRecovery: true }); assert.equal(reads, 0, change); assert.notEqual(store.read().tasks[0].status, 'live', change); }
    finally { controller.stop(); store.close(); }
  }
});
