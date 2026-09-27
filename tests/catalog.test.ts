import assert from 'node:assert/strict';
import test from 'node:test';
import { CHANNELS, matchChannels } from '../src/integrations/catalog.js';
import type { Category, Site } from '../src/shared/types.js';

function site(category: Category, language = 'en'): Site {
  return { id:'s', domain:'example.com', url:'https://example.com/', email:'owner@example.com', name:'Example', description:'Example product', category, language, monthlyTarget:2, status:'ready', createdAt:'2026-09-26' };
}

test('catalog contains distinct curated channels with source evidence', () => {
  assert.ok(CHANNELS.length >= 30 && CHANNELS.length <= 40);
  assert.equal(new Set(CHANNELS.map(channel => channel.id)).size, CHANNELS.length);
  assert.equal(CHANNELS.filter(channel => channel.automation === 'browser').length, 5);
  for (const channel of CHANNELS) {
    assert.ok(channel.rulesUrl.startsWith('https://'), channel.id);
    assert.ok(channel.submitUrl.startsWith('https://'), channel.id);
    assert.ok(channel.allowedHosts.length > 0, channel.id);
    assert.ok(channel.allowedHosts.includes(new URL(channel.submitUrl).hostname), `${channel.id} submit host`);
    assert.equal(channel.checkedAt, '2026-09-27', channel.id);
    assert.equal(channel.authority, undefined);
    assert.equal(channel.traffic, undefined);
    assert.match(channel.freeNote, /[\u3400-\u9fff]/, `${channel.id} freeNote`);
    assert.match(channel.qualityReason, /[\u3400-\u9fff]/, `${channel.id} qualityReason`);
    assert.match(channel.notes, /[\u3400-\u9fff]/, `${channel.id} notes`);
    if (channel.kind === 'community') assert.equal(channel.automation, 'manual');
  }
});

test('new candidates remain manual and unknown prices cannot imply browser support', () => {
  const added = ['capterra','codeberg','nuget','crates-io','docker-hub','firefox-addons','vscode-marketplace','jetbrains-marketplace','flathub','fdroid','snap-store','itch-io','gravatar','google-business','bing-places','apple-business','yelp-business'];
  for (const id of added) assert.equal(CHANNELS.find(channel => channel.id === id)?.automation, 'manual', id);
  assert.ok(CHANNELS.filter(channel => channel.free === 'unknown').every(channel => channel.automation === 'manual'));
});

test('Show HN account creation does not require an email address', () => {
  assert.equal(CHANNELS.find(channel => channel.id === 'show-hn')?.emailRequired, false);
});

test('Flathub stays disabled because its submission policy prohibits AI assistance', () => {
  const flathub = CHANNELS.find(channel => channel.id === 'flathub');
  assert.equal(flathub?.enabled, false);
  assert.equal(flathub?.automation, 'manual');
  assert.equal(flathub?.rulesUrl, 'https://docs.flathub.org/docs/for-app-authors/requirements#generative-ai-policy');
  assert.match(flathub?.notes ?? '', /本人纯人工/);
  assert.match(flathub?.notes ?? '', /不得创建或自动化提交 PR/);
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
