import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRenderedArticle } from '../src/integrations/article-rendering';
import { findDirectLink, verifyLink } from '../src/integrations/web';
import { mataroaTesting } from '../src/integrations/mataroa';

const TARGET = 'https://example.com/research';
const SOURCE = 'https://publisher.example/post';
const REFERENCE = 'https://reference.example/source?edition=2#evidence';
const markdown = `A complete [reference](${REFERENCE}) supports the [research](${TARGET}).`;
const body = `<p>A complete <a href="${REFERENCE}">reference</a> supports the <a href="${TARGET}">research</a>.</p>`;

test('publication verification rejects modified reference links even when target and text remain intact', () => {
  const changed = body.replace(REFERENCE, 'https://elsewhere.example/');
  assert.equal(inspectRenderedArticle(`<article>${changed}</article>`, markdown, TARGET, 'article').found, false);
  assert.equal(mataroaTesting.renderedArticle(`<article><div class="posts-item-body" itemprop="articleBody">${changed}</div></article>`, markdown, TARGET), undefined);
});

test('publication verification distinguishes noindex from a qualified visible source', () => {
  for (const directive of ['noindex', 'none']) {
    const html = `<head><meta name="robots" content="${directive}"></head><article>${body}</article>`;
    assert.equal(inspectRenderedArticle(html, markdown, TARGET, 'article').found, false);
    assert.equal(findDirectLink(html, SOURCE, TARGET).found, false);
  }
});

test('generic backlink verification does not count hidden or empty anchors', () => {
  for (const html of [
    `<div hidden>${body}</div>`,
    `<style>article{display:none}</style><article>${body}</article>`,
    `<details><article>${body}</article></details>`,
    `<a href="${TARGET}"></a>`,
  ]) assert.equal(findDirectLink(html, SOURCE, TARGET).found, false);
});

test('generic backlink verification retains page-wide nofollow and rejects HTTP noindex', async () => {
  const html = `<meta name="robots" content="nofollow">${body}`;
  assert.match(findDirectLink(html, SOURCE, TARGET).rel, /\bnofollow\b/);
  const result = await verifyLink(SOURCE, TARGET, undefined, undefined, {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => ({ status: 200, headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' }, body: Buffer.from(body) }),
  });
  assert.equal(result.found, false);
  assert.equal(result.outcome, 'invalid');
});

test('robots values, canonical targets and page-wide nofollow are interpreted without inventing search discovery', () => {
  assert.equal(findDirectLink(`<meta name="robots" content="max-image-preview:none">${body}`, SOURCE, TARGET).found, true);
  assert.equal(findDirectLink(body, SOURCE, TARGET, 'googlebot:noindex').outcome, 'invalid');
  assert.equal(findDirectLink(`<link rel="canonical" href="https://publisher.example/different">${body}`, SOURCE, TARGET).found, false);
  assert.equal(findDirectLink(`<meta http-equiv="refresh" content="0;url=https://elsewhere.example/">${body}`, SOURCE, TARGET).found, false);
  const result=inspectRenderedArticle(`<meta name="robots" content="nofollow"><article>${body}</article>`,markdown,TARGET,'article');
  assert.ok(result.found);assert.equal(result.rel,'nofollow');
  for(const href of ['https://reference.example/source?edition=3#evidence','https://reference.example/source?edition=2#other']){
    assert.equal(inspectRenderedArticle(`<article>${body.replace(REFERENCE,href)}</article>`,markdown,TARGET,'article').found,false);
  }
});
