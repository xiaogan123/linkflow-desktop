import test from 'node:test';
import assert from 'node:assert/strict';
import {linkRows, linksCsv, linksSummary, passesWeight} from '../src/ui/links-model';
import type {Channel, Site, Task} from '../src/shared/types';

const at = '2026-10-01T00:00:00.000Z';
const site = {id: 's', domain: 'example.com', url: 'https://example.com/', name: 'Example', status: 'ready', createdAt: at} as Site;
const live = (id: string, extra: Partial<Task>) => ({id, siteId: 's', channelId: 'c', sourceDomain: 'p.example', status: 'live', createdAt: at, scheduledAt: at, updatedAt: at, attempts: 1, message: '', publicUrl: `https://p.example/${id}`, firstLiveAt: at, linkCheck: 'found', health: 'healthy', ...extra}) as Task;

test('only a checked follow link passes weight', () => {
  for (const rel of ['', 'follow', 'noopener noreferrer']) assert.equal(passesWeight({linkRel: rel}), true, rel);
  for (const rel of [undefined, 'unknown', 'nofollow', 'ugc nofollow', 'sponsored', 'ugc']) assert.equal(passesWeight({linkRel: rel}), false, String(rel));
});

test('link rows count temporary pages apart and export a quoted CSV', () => {
  const channel = {id: 'c', name: 'Paste · 临时页', retentionDays: 30} as Channel;
  const rows = linkRows({sites: [site], channels: [channel], tasks: [live('a', {linkRel: ''}), live('b', {linkRel: 'nofollow', draft: {title: 'Fees, explained', description: '', body: ''}})]});
  assert.deepEqual(linksSummary(rows), {total: 2, active: 2, weight: 1, temporary: 2});
  assert.equal(rows[0].platform, 'Paste');
  assert.match(linksCsv(rows), /"Fees, explained"/);
});
