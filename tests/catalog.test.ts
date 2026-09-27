import assert from 'node:assert/strict';
import test from 'node:test';
import { CHANNELS, matchChannels } from '../src/integrations/catalog.js';
import type { Category, Site } from '../src/shared/types.js';

function site(category: Category, language = 'en'): Site {
  return { id:'s', domain:'example.com', url:'https://example.com/', email:'owner@example.com', name:'Example', description:'Example product', category, language, monthlyTarget:2, status:'ready', createdAt:'2026-09-26' };
}

test('catalog contains distinct curated channels with source evidence', () => {
  assert.ok(CHANNELS.length >= 20 && CHANNELS.length <= 25);
  assert.equal(new Set(CHANNELS.map(channel => channel.id)).size, CHANNELS.length);
  for (const channel of CHANNELS) {
    assert.ok(channel.rulesUrl.startsWith('https://'), channel.id);
    assert.ok(channel.submitUrl.startsWith('https://'), channel.id);
    assert.ok(channel.allowedHosts.length > 0, channel.id);
    assert.ok(channel.allowedHosts.includes(new URL(channel.submitUrl).hostname), `${channel.id} submit host`);
    assert.ok(['2026-09-26','unknown'].includes(channel.checkedAt), channel.id);
    assert.equal(channel.authority, undefined);
    assert.equal(channel.traffic, undefined);
    if (channel.kind === 'community') assert.equal(channel.automation, 'manual');
  }
});

test('matches a relevant audience and does not grant general links a high score', () => {
  const results = matchChannels(site('design'), CHANNELS);
  assert.ok(results.some(({channel}) => channel.id === 'behance'));
  assert.ok(results.some(({channel}) => channel.id === 'artstation'));
  assert.ok(results.slice(0, 8).some(({channel}) => channel.id === 'behance'));
  assert.ok(results.every(({score}) => score >= 35));
  assert.equal(matchChannels(site('finance'), CHANNELS).some(({channel}) => channel.id === 'github'), false);
  assert.ok(matchChannels(site('design','fr'), CHANNELS).some(({channel}) => channel.id === 'behance'));
  assert.equal(matchChannels(site('design','fr'), CHANNELS).some(({channel}) => channel.id === 'product-hunt'), false);
});
