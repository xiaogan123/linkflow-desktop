import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/main/controller';
import { Store } from '../src/main/store';
import { analyzeWebsiteHtml } from '../src/integrations/web';
import type { Vault } from '../src/main/vault';
import type { Site } from '../src/shared/types';

const stamp = '2026-10-01T00:00:00.000Z';
const site: Site = {
  id: '11111111-1111-4111-8111-111111111111',
  url: 'https://example.com/', domain: 'example.com', email: 'owner@example.com',
  name: 'Example', description: 'Original guides', category: 'content', language: 'en',
  status: 'ready', monthlyTarget: 2, createdAt: stamp, analyzedAt: stamp,
  qualifications: { developer: 'https://example.com/project' },
};
const vault = { available: () => true } as unknown as Vault;

function fixture(fail: boolean) {
  const store = new Store(':memory:');
  store.update(state => { state.sites = [structuredClone(site)]; state.settings.autoRun = false; });
  let started!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let reads = 0;
  const controller = new Controller(store, vault, 'isolated-analysis-fixture', {
    analyzeWebsite: async () => {
      reads++;
      started();
      await gate;
      if (fail) throw new Error('temporary fixture read failure');
      return analyzeWebsiteHtml('<html lang="en"><title>Updated guides</title><p>Updated description</p></html>', site.url);
    },
    discoverTopics: async () => ({ topics: [], checkedAt: stamp }),
    discoverTechnicalMaterial: async () => undefined,
  });
  return { store, controller, ready, finish, reads: () => reads };
}

test('a failed in-flight site analysis preserves a later user pause and records the read error', async () => {
  const f = fixture(true);
  try {
    const pending = f.controller.analyze(site.id);
    await f.ready;
    f.controller.sitePause(site.id, true);
    f.finish();
    await pending;
    const saved = f.store.read().sites[0];
    assert.equal(saved.status, 'paused');
    assert.match(saved.error ?? '', /网站暂时无法读取/);
    assert.equal(saved.name, site.name);
    assert.equal(saved.analyzedAt, stamp);
    assert.equal(f.controller.hasPendingWork(), false);
    assert.equal(f.store.read().tasks.length, 0);
    f.controller.sitePause(site.id, false);
    assert.equal(f.store.read().sites[0].status, 'ready');
  } finally { f.finish(); f.store.close(); }
});

test('a successful in-flight analysis updates facts but preserves a later user pause', async () => {
  const f = fixture(false);
  try {
    const pending = f.controller.analyze(site.id);
    await f.ready;
    f.controller.sitePause(site.id, true);
    f.finish();
    await pending;
    assert.equal(f.store.read().sites[0].status, 'paused');
    assert.equal(f.store.read().sites[0].name, 'Updated guides');
    assert.equal(f.store.read().sites[0].error, undefined);
    assert.equal(f.controller.hasPendingWork(), false);
  } finally { f.finish(); f.store.close(); }
});

test('an unpaused failed analysis still requires attention and concurrent analyze calls share one read', async () => {
  const f = fixture(true);
  try {
    const pending = f.controller.analyze(site.id);
    await f.ready;
    await f.controller.analyze(site.id);
    f.finish();
    await pending;
    assert.equal(f.reads(), 1);
    assert.equal(f.store.read().sites[0].status, 'attention');
    assert.match(f.store.read().sites[0].error ?? '', /网站暂时无法读取/);
    assert.equal(f.controller.hasPendingWork(), false);
  } finally { f.finish(); f.store.close(); }
});

test('deleting a site while analysis fails does not recreate the site or emit a late failure event', async () => {
  const f = fixture(true);
  try {
    const pending = f.controller.analyze(site.id);
    await f.ready;
    f.controller.deleteSite(site.id);
    f.finish();
    await pending;
    assert.equal(f.store.read().sites.length, 0);
    assert.equal(f.store.read().events.length, 0);
    assert.equal(f.controller.hasPendingWork(), false);
  } finally { f.finish(); f.store.close(); }
});
