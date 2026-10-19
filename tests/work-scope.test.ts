import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {WORK_SCOPE_MESSAGES} from '../src/shared/work-scope-messages';
import type {Site, Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const at = '2026-10-19T00:00:00.000Z';
const siteA = '11111111-1111-4111-8111-111111111111', siteB = '22222222-2222-4222-8222-222222222222';
const taskA = '33333333-3333-4333-8333-333333333333', accountA = '44444444-4444-4444-8444-444444444444';
const site = (id: string, domain: string) => ({id, domain, url: `https://${domain}/`, email: `owner@${domain}`, name: domain, description: 'Fixture', category: 'content', language: 'en', status: 'ready', monthlyTarget: 1, createdAt: at}) as Site;

function fixture() {
  const store = new Store(':memory:');
  store.update(state => {
    state.sites = [site(siteA, 'a.example.com'), site(siteB, 'b.example.com')];
    state.tasks = [{id: taskA, siteId: siteA, channelId: 'telegraph', sourceDomain: 'telegra.ph', accountId: accountA, status: 'running', createdAt: at, scheduledAt: at, updatedAt: at, attempts: 1, message: 'fixture'} as Task];
  });
  const controller = new Controller(store, {ready: true, available: () => true} as unknown as Vault, 'fixture');
  controller.stop();
  return {store, controller};
}

test('an edit waits only for work on its own site, post or account', async () => {
  const {store, controller} = fixture();
  try {
    controller.runtime.busy = true; controller.runtime.activeTaskId = taskA;
    assert.equal(controller.busyFor({siteIds: [siteA]}), true);
    assert.equal(controller.busyFor({taskIds: [taskA]}), true);
    assert.equal(controller.busyFor({accountIds: [accountA]}), true);
    // Another site is never blocked by this task, and nothing waits at all.
    assert.equal(controller.busyFor({siteIds: [siteB]}), false);
    await controller.waitForIdle({siteIds: [siteB]}, 50);
    await assert.rejects(controller.waitForIdle({siteIds: [siteA]}, 300), new RegExp(WORK_SCOPE_MESSAGES.busy));
    // When the task finishes during the wait, the edit goes ahead.
    setTimeout(() => {controller.runtime.activeTaskId = undefined; controller.runtime.busy = false}, 100);
    await controller.waitForIdle({siteIds: [siteA]}, 2_000);
  } finally {store.close()}
});

test('an unchanged update writes nothing and does not refresh the renderer', () => {
  const store = new Store(':memory:');
  try {
    let refreshes = 0; store.onChange = () => {refreshes++};
    store.update(state => {state.settings.notify = false});
    const revision = store.revision;
    assert.equal(refreshes, 1);
    store.update(state => {state.settings.notify = false});
    store.update(() => {});
    assert.equal(store.revision, revision);
    assert.equal(refreshes, 1);
    store.update(state => {state.settings.notify = true});
    assert.equal(refreshes, 2);
  } finally {store.close()}
});
