import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS} from '../src/integrations/catalog';
import {emptyState} from '../src/main/store';
import {platformOneLiner,platformRows,platformSummary,platformTerms,unsuitableReason} from '../src/ui/platforms-model';
import type {Channel,Site,Snapshot} from '../src/shared/types';
import {channelReadinessForDisplay} from '../src/ui/presentation';

const at = '2026-10-19T00:00:00.000Z';
const site = {id: 's1', domain: 'example.com', url: 'https://example.com/', email: 'o@example.com', name: 'Example', description: 'Guides', category: 'finance', language: 'zh-CN', monthlyTarget: 4, status: 'ready', createdAt: at} as Site;
const snapshot = (channels: Channel[]) => ({...emptyState(), sites: [site], channels, accounts: [], accountBindings: [], tasks: []}) as unknown as Snapshot;

test('platform rows group each platform the way the scheduler treats it, with a short reason when it cannot be used', () => {
  const data = snapshot(CHANNELS.map(channel => ({...channel})));
  const rows = platformRows(data, site, []);
  assert.equal(rows.length, CHANNELS.length);
  for (const row of rows.filter(item => item.group === 'unqualified' && item.channel.enabled)) assert.ok(row.reason && row.reason.length <= 12, `${row.channel.id}: ${row.reason}`);
  assert.ok(rows.some(row => row.group === 'connect_once' && row.action.kind === 'connect'));
  assert.ok(rows.filter(row => !row.channel.enabled).every(row => row.group === 'unqualified' && row.action.kind === 'disabled'));
  assert.ok(rows.filter(row => row.group === 'manual' && row.channel.enabled).every(row => row.action.kind === 'manual'));
});

test('「在用」is the scheduler\'s own answer; a platform it would skip says why instead', () => {
  const channels = CHANNELS.map(channel => ({...channel}));
  const used = channels.find(channel => channel.id === 'txtsbs')!, skipped = channels.find(channel => channel.id === 'pastyx')!;
  const data = {...snapshot(channels), schedulablePlatformIds: {[site.id]: [used.id]}} as Snapshot;
  const rows = platformRows(data, site, []);
  assert.equal(rows.find(row => row.channel.id === used.id)!.action.kind, 'in_use');
  assert.equal(rows.find(row => row.channel.id === skipped.id)!.action.kind, 'unavailable');
  // A notice the owner has not confirmed and a one-time verification are named as such, never shown as in use.
  assert.equal(rows.find(row => row.channel.id === 'html-app')?.action.kind ?? 'confirm', 'confirm');
  assert.equal(rows.find(row => row.channel.id === 'paper-wf')!.action.kind, 'verify');
  const summary = platformSummary(rows);
  assert.equal(summary.automatic, 1);
  // All-sites view: in use when any site would use it.
  assert.equal(platformRows(data, undefined, []).find(row => row.channel.id === used.id)!.action.kind, 'in_use');
});

test('one-liners do not infer retention guarantees or ranking credit from missing expiry and rel attributes', () => {
  const base = {...CHANNELS.find(channel => channel.id === 'txtsbs')!};
  assert.equal(platformOneLiner({...base, retentionDays: undefined, linkRel: 'nofollow'}, 'direct_submit'), '免注册 · 未注明到期 · 链接标记 nofollow');
  assert.equal(platformOneLiner({...base, retentionDays: 30, linkRel: 'follow'}, 'direct_submit'), '免注册 · 保留 30 天 · 普通链接');
  assert.equal(unsuitableReason(site, {...base, languages: ['en']}), '只收英语');
  assert.equal(unsuitableReason(site, {...base, promotionPolicy: 'forbidden'}), '禁止推广内容');
  assert.equal(unsuitableReason({...site, language: 'en'}, {...CHANNELS.find(channel => channel.id === 'product-hunt')!, languages: ['*'], audience: ['general']}), '只收软件项目');
  assert.equal(platformTerms({...base, termsCache: undefined}).finance, '还没核对');
});

test('rows never offer a connection a platform does not have, and follow the scheduler for browser-automated platforms', () => {
  const channels = CHANNELS.map(channel => ({...channel, enabled: true}));
  const topics = [{url: 'https://example.com/guide', discoveredAt: at}];
  const dev = {...site, category: 'software', topics, qualifications: {developer: 'https://example.com/project'}} as Site;
  const github = channels.find(channel => channel.id === 'github')!;
  const data = {...snapshot(channels), sites: [dev], schedulablePlatformIds: {[dev.id]: [github.id]}} as Snapshot;
  const rows = platformRows(data, dev, []);
  // An automatic platform offers a connection only when this site really needs its own account connected.
  for (const row of rows.filter(item => ['direct_submit', 'auto_account', 'email_auto'].includes(item.group))) if (row.action.kind === 'connect') assert.equal(channelReadinessForDisplay(data, dev, row.channel), 'handoff_required', row.channel.id);
  const brewpage = rows.find(row => row.channel.id === 'brewpage');
  assert.deepEqual(brewpage?.action, {kind: 'unavailable', reason: '临时页，不排进每月计划'});
  assert.equal(rows.find(row => row.channel.id === 'github')!.action.kind, 'in_use');
});
