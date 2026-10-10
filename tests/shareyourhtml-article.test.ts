import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { load } from 'cheerio';
import {
  SHAREYOURHTML_MAX_HTML_BYTES,
  SHAREYOURHTML_MAX_REQUEST_BYTES,
  renderShareYourHtmlArticle,
} from '../src/integrations/shareyourhtml-article';

const TARGET = 'https://example.com/guides/exact-topic';
const SLUG = 'lf-11111111111141118111111111111111';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const input = () => ({
  slug: SLUG,
  targetUrl: TARGET,
  language: 'en-SG',
  draft: {
    title: 'Exact <reviewed> title',
    description: 'Reviewed "description" & context.',
    body: [
      '## Useful details',
      '',
      'This keeps **strong**, *emphasis*, ~~deletion~~ and [the exact source](https://example.com/guides/exact-topic "Reviewed link title").',
      '',
      '- First item',
      '- Second item with `<script>alert(1)</script>` as code.',
      '',
      '```html',
      '<img src="https://tracker.example/pixel" onerror="alert(1)">',
      '```',
      '',
      '| Name | Value |',
      '| :---: | ---: |',
      '| alpha | beta |',
    ].join('\n'),
  },
});

test('renderer produces deterministic self-contained HTML from exact reviewed Markdown', () => {
  const first = renderShareYourHtmlArticle(input());
  const second = renderShareYourHtmlArticle(structuredClone(input()));
  assert.deepEqual(first, second);
  assert.equal(first.targetUrl, TARGET);
  assert.equal(first.sourceHash, sha256(first.html));
  const request = JSON.stringify({ slug: SLUG, html: first.html, expiry: 'never' });
  assert.equal(first.requestHash, sha256(request));
  assert.ok(Buffer.byteLength(first.html, 'utf8') <= SHAREYOURHTML_MAX_HTML_BYTES);
  assert.ok(Buffer.byteLength(request, 'utf8') <= SHAREYOURHTML_MAX_REQUEST_BYTES);

  const $ = load(first.html);
  assert.equal($('html').attr('lang'), 'en-sg');
  assert.equal($('title').text(), input().draft.title);
  assert.equal($('meta[name="description"]').attr('content'), input().draft.description);
  assert.equal($('main article header h1').text(), input().draft.title);
  assert.equal($('strong').text(), 'strong');
  assert.equal($('em').text(), 'emphasis');
  assert.equal($('del').text(), 'deletion');
  assert.equal($('table').length, 1);
  assert.match($('pre code').text(), /<img src=/);
  assert.equal($('pre code').attr('class'), 'language-html');
  assert.equal($('th').first().attr('align'), 'center');
  assert.equal($('th').last().attr('align'), 'right');
  assert.equal($('script,img,iframe,style,link,object,embed,svg').length, 0);
  assert.equal($('[style],[src],[srcset],[onload],[onerror],[onclick]').length, 0);
  assert.equal($('a').length, 1);
  assert.equal($('a').attr('href'), TARGET);
  assert.equal($('a').attr('title'), 'Reviewed link title');
  assert.equal($('a').attr('rel'), 'nofollow ugc noopener noreferrer');
  assert.equal(first.html.includes('<script>alert(1)</script>'), false);
  assert.equal(first.html.includes('<img src="https://tracker.example'), false);
});

test('renderer preserves a validated ordered-list start from reviewed Markdown', () => {
  const value = input();
  value.draft.body = `7. Seventh\n8. Eighth\n\n[Source](${TARGET})`;
  const $ = load(renderShareYourHtmlArticle(value).html);
  assert.equal($('ol').attr('start'), '7');
  assert.deepEqual($('ol > li').map((_index, element) => $(element).text()).get(),
    ['Seventh', 'Eighth']);
});

test('renderer rejects raw HTML, images, task controls and unsafe link schemes', () => {
  const bodies = [
    `<script>alert(1)</script>\n\n[Source](${TARGET})`,
    `![pixel](https://tracker.example/pixel.png)\n\n[Source](${TARGET})`,
    `- [x] published\n\n[Source](${TARGET})`,
    `[bad](http://example.com/plain)\n\n[Source](${TARGET})`,
    `[bad](javascript:alert(1))\n\n[Source](${TARGET})`,
    `[bad](https://localhost/private)\n\n[Source](${TARGET})`,
    `[bad](https://user:pass@example.com/)\n\n[Source](${TARGET})`,
    `[bad](https://example.com/?access_token=secret)\n\n[Source](${TARGET})`,
  ];
  for (const body of bodies) {
    const value = input();
    value.draft.body = body;
    assert.throws(() => renderShareYourHtmlArticle(value), /ShareYourHTML/);
  }
});

test('renderer requires the exact canonical reviewed target as an authored link', () => {
  const absent = input();
  absent.draft.body = 'Useful content with [another page](https://example.com/guides/other).';
  assert.throws(() => renderShareYourHtmlArticle(absent), /精确审核目标链接/);

  for (const targetUrl of [
    'http://example.com/guides/exact-topic',
    'https://EXAMPLE.com/guides/exact-topic',
    'https://example.com:444/guides/exact-topic',
    'https://example.com/guides/exact-topic#fragment',
  ]) {
    assert.throws(() => renderShareYourHtmlArticle({ ...input(), targetUrl }), /规范公开 HTTPS/);
  }
});

test('renderer preserves escaped code while rejecting malformed text and identifiers', () => {
  const safe = input();
  safe.draft.body = `Use \`<iframe src="https://evil.example/">\` safely.\n\n[Source](${TARGET})`;
  const rendered = renderShareYourHtmlArticle(safe);
  assert.equal(load(rendered.html)('iframe').length, 0);
  assert.match(load(rendered.html)('code').text(), /<iframe/);

  const malformed = input();
  malformed.draft.title = `bad\ud800text`;
  assert.throws(() => renderShareYourHtmlArticle(malformed), /无效文字/);
  assert.throws(() => renderShareYourHtmlArticle({ ...input(), language: 'en<script>' }), /语言标识/);
  assert.throws(() => renderShareYourHtmlArticle({ ...input(), slug: 'Bad_Slug' }), /slug/);
});

test('renderer fails closed at local HTML and request byte budgets without truncation', () => {
  const htmlLimit = input();
  htmlLimit.draft.body = `${'a'.repeat(SHAREYOURHTML_MAX_HTML_BYTES)}\n\n[Source](${TARGET})`;
  assert.throws(() => renderShareYourHtmlArticle(htmlLimit), /HTML 超出本地限制/);

  const requestLimit = input();
  requestLimit.draft.body = `${'"'.repeat(105_000)}\n\n[Source](${TARGET})`;
  assert.throws(() => renderShareYourHtmlArticle(requestLimit), /请求超出本地限制/);
});
