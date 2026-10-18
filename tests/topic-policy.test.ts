import assert from 'node:assert/strict';
import test from 'node:test';
import { isArticleTopicUrl } from '../src/shared/topic-policy.js';

const site = { url: 'https://www.example.com/', domain: 'example.com' };

test('rejects administrative routes with HTML and PHP route extensions', () => {
  for (const path of [
    '/en/privacy.html',
    '/about.htm',
    '/contact.php',
    '/affiliate-disclosure.HTML',
    '/disclaimer.htm',
    '/terms-of-service.php',
  ]) {
    assert.equal(isArticleTopicUrl(`https://example.com${path}`, site), false, path);
  }
});

test('decodes route segments before applying administrative checks', () => {
  assert.equal(isArticleTopicUrl('https://example.com/en/%70rivacy.html', site), false);
  assert.equal(isArticleTopicUrl('https://example.com/%64isclaimer%2Ephp', site), false);
  assert.equal(isArticleTopicUrl('https://example.com/en/%E0%A4%A', site), false, 'malformed encoding fails closed');
});

test('rejects locale-only landing paths without excluding localized articles', () => {
  for (const path of ['/en', '/en-US/', '/pt_BR', '/zh-Hans-CN']) {
    assert.equal(isArticleTopicUrl(`https://example.com${path}`, site), false, path);
  }
  assert.equal(isArticleTopicUrl('https://example.com/fr/guides/getting-started.html', site), true);
  assert.equal(isArticleTopicUrl('https://example.com/articles/en', site), true);
  assert.equal(isArticleTopicUrl('https://example.com/ai', site), true, 'a short article slug is not assumed to be a locale');
});

test('keeps article slugs that merely contain administrative words', () => {
  assert.equal(isArticleTopicUrl('https://example.com/articles/privacy-guide.html', site), true);
  assert.equal(isArticleTopicUrl('https://example.com/guides/about-our-method.htm', site), true);
  assert.equal(isArticleTopicUrl('https://example.com/en/articles/contact-research.php', site), true);
});

test('rejects external URLs and obvious non-content resources', () => {
  assert.equal(isArticleTopicUrl('https://outside.example/articles/privacy-guide.html', site), false);
  assert.equal(isArticleTopicUrl('https://example.com.evil.test/articles/privacy-guide.html', site), false);
  assert.equal(isArticleTopicUrl('https://example.com/report.pdf', site), false);
  assert.equal(isArticleTopicUrl('https://example.com/assets/app.js', site), false);
  assert.equal(isArticleTopicUrl('https://example.com/articles/page?page=2', site), false);
});

test('recognizes a GitHub release tag page without treating all tag routes as articles', () => {
  const github = {url:'https://github.com/',domain:'github.com'};
  assert.equal(isArticleTopicUrl('https://github.com/example-owner/example-project/releases/tag/v2.3.4',github),true);
  assert.equal(isArticleTopicUrl('https://github.com/example-owner/example-project/releases/tag/v2.3.4-rc.1',github),true);
  for(const url of [
    'https://github.com/example-owner/example-project/releases/tag',
    'https://github.com/example-owner/example-project/releases/tag/v2.3.4/edit',
    'https://github.com/example-owner/example-project/releases/tag/v2%2Fedit',
    'https://github.com/example-owner/example-project/tags/v2.3.4',
    'https://github.com/example-owner/example-project/releases/tag/v2.3.4?page=2',
    'https://github.com/example-owner/example-project/releases/tag/secret.pdf',
    'https://github.com@outside.example/example-owner/example-project/releases/tag/v2.3.4',
  ])assert.equal(isArticleTopicUrl(url,github),false,url);
  assert.equal(isArticleTopicUrl('https://example.com/owner/project/releases/tag/v2.3.4',site),false);
  assert.equal(isArticleTopicUrl('https://github.com.evil.test/owner/project/releases/tag/v2.3.4',github),false);
});
