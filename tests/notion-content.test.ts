import test from 'node:test';
import assert from 'node:assert/strict';
import {
  notionContentLimits,
  parseNotionCreatePage503,
  prepareNotionPage,
  type NotionBlock,
  type NotionRichText,
} from '../src/integrations/notion-content';

const PARENT = '01234567-89AB-CDEF-0123-456789ABCDEF';

function blockRichText(block: NotionBlock): NotionRichText[] {
  if (block.type === 'paragraph') return block.paragraph.rich_text;
  if (block.type === 'heading_1') return block.heading_1.rich_text;
  if (block.type === 'heading_2') return block.heading_2.rich_text;
  if (block.type === 'heading_3') return block.heading_3.rich_text;
  if (block.type === 'bulleted_list_item') return block.bulleted_list_item.rich_text;
  if (block.type === 'numbered_list_item') return block.numbered_list_item.rich_text;
  return block.code.rich_text;
}

const text = (richText: NotionRichText[]) => richText.map(item => item.text.content).join('');

test('builds one complete create-page body while preserving Unicode, entities, emphasis, links, lists, code and disclosure', () => {
  const markdown = [
    '# 说明 😀',
    '',
    'AT&amp;T &copy; 的 **粗体与 *嵌套强调***、`x &amp; y`，以及 [公开资料](https://docs.example.com/a?x=1&amp;y=2)。',
    '',
    '- 第一项',
    '- 第二项含 **重点**',
    '',
    '1. one',
    '2. two',
    '',
    '```text',
    '{"emoji":"😀","literal":"&amp;"}',
    '```',
    '',
    '披露：本文含有推广关系说明，佣金不会改变读者支付价格。',
  ].join('\n');
  const prepared = prepareNotionPage(PARENT, '完整标题 😀', markdown);
  assert.equal(prepared.method, 'POST');
  assert.equal(prepared.path, '/v1/pages');
  assert.equal(prepared.body.parent.page_id, '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(text(prepared.body.properties.title.title), '完整标题 😀');
  assert.deepEqual(prepared.body.children.map(block => block.type), [
    'heading_1', 'paragraph', 'bulleted_list_item', 'bulleted_list_item',
    'numbered_list_item', 'numbered_list_item', 'code', 'paragraph',
  ]);
  assert.equal(text(blockRichText(prepared.body.children[0])), '说明 😀');
  assert.equal(text(blockRichText(prepared.body.children[1])), 'AT&T © 的 粗体与 嵌套强调、x &amp; y，以及 公开资料。');
  const nested = blockRichText(prepared.body.children[1]).find(item => item.text.content === '嵌套强调');
  assert.deepEqual({ bold: nested?.annotations.bold, italic: nested?.annotations.italic }, { bold: true, italic: true });
  assert.equal(blockRichText(prepared.body.children[1]).find(item => item.text.content === 'x &amp; y')?.annotations.code, true);
  assert.deepEqual(prepared.links, [{ text: '公开资料', url: 'https://docs.example.com/a?x=1&y=2' }]);
  const link = blockRichText(prepared.body.children[1]).find(item => item.text.link);
  assert.equal(link?.text.link?.url, prepared.links[0].url);
  const code = prepared.body.children[6];
  assert.equal(code.type, 'code');
  if (code.type !== 'code') assert.fail('expected code block');
  assert.equal(code.code.language, 'plain text');
  assert.equal(text(code.code.rich_text), '{"emoji":"😀","literal":"&amp;"}');
  assert.match(text(blockRichText(prepared.body.children.at(-1)!)), /推广关系说明/);
  assert.match(prepared.preparedContentHash, /^[0-9a-f]{64}$/);
  assert.match(prepared.requestHash, /^[0-9a-f]{64}$/);
  const changedParent = prepareNotionPage('11234567-89ab-cdef-0123-456789abcdef', '完整标题 😀', markdown);
  assert.equal(changedParent.preparedContentHash, prepared.preparedContentHash);
  assert.notEqual(changedParent.requestHash, prepared.requestHash);
  assert.deepEqual(prepareNotionPage(PARENT, '完整标题 😀', markdown), prepared);
  const serialized = JSON.stringify(prepared.body);
  assert.equal(serialized.includes('plain_text'), false);
  assert.equal(serialized.includes('"href"'), false);
  assert.equal(serialized.includes('Authorization'), false);
});

test('chunks long Unicode content without splitting surrogate pairs and accepts exactly 100 rich_text items', () => {
  const segment = 'a'.repeat(2_000);
  const markdown = Array.from({ length: 100 }, (_, index) => `[${segment}](https://docs.example.com/${index})`).join('');
  const prepared = prepareNotionPage(PARENT, '边界', markdown);
  const rich = blockRichText(prepared.body.children[0]);
  assert.equal(rich.length, 100);
  assert.ok(rich.every(item => item.text.content.length === 2_000));
  assert.equal(text(rich), segment.repeat(100));
  assert.equal(prepared.links.length, 100);
  assert.throws(
    () => prepareNotionPage(PARENT, '越界', `${markdown}[x](https://docs.example.com/overflow)`),
    /rich_text 数组/,
  );
});

test('uses a conservative 2000 UTF-16-unit chunk boundary without splitting emoji pairs', () => {
  const exact = prepareNotionPage(PARENT, 'text boundary', '😀'.repeat(1_000));
  assert.deepEqual(blockRichText(exact.body.children[0]).map(item => item.text.content.length), [2_000]);
  const over = prepareNotionPage(PARENT, 'text boundary', '😀'.repeat(1_001));
  assert.deepEqual(blockRichText(over.body.children[0]).map(item => item.text.content.length), [2_000, 2]);
  assert.equal(text(blockRichText(over.body.children[0])), '😀'.repeat(1_001));
});

test('enforces the single-request children boundary and never returns an append plan', () => {
  const exactly = Array.from({ length: 100 }, (_, index) => `paragraph ${index}`).join('\n\n');
  const prepared = prepareNotionPage(PARENT, '100 blocks', exactly);
  assert.equal(prepared.body.children.length, 100);
  assert.equal('append' in prepared, false);
  assert.throws(() => prepareNotionPage(PARENT, '101 blocks', `${exactly}\n\noverflow`), /不会拆分 append/);
});

test('rejects unsupported Markdown instead of dropping visible content', () => {
  const cases = [
    ['HTML', 'before <span>inside</span> after'],
    ['图片', '![alt](https://cdn.example.com/a.png)'],
    ['表格', '| a |\n|---|\n| b |'],
    ['引用', '> quoted'],
    ['嵌套', '- parent\n  - child'],
    ['任务', '- [x] done'],
    ['多段', '- first\n\n  second'],
    ['四级标题', '#### hidden level'],
    ['硬换行', 'first  \nsecond'],
    ['链接标题', '[label](https://docs.example.com "lost title")'],
    ['代码语言', '```json\n{"a":1}\n```'],
  ];
  for (const [name, markdown] of cases) {
    assert.throws(() => prepareNotionPage(PARENT, name, markdown), name);
  }
});

test('rejects invalid, local, private, credential-bearing and non-HTTP links', () => {
  const urls = [
    'javascript:alert(1)',
    'https://user:password@docs.example.com/a',
    'http://localhost/a',
    'http://service.local/a',
    'http://127.0.0.1/a',
    'http://10.0.0.1/a',
    'http://172.16.0.1/a',
    'http://192.168.0.1/a',
    'http://[::1]/a',
    'http://[fc00::1]/a',
    'https://docs.example.com/a?access_token=secret',
    'https://docs.example.com/a?client_secret=secret',
    'https://docs.example.com/a?X-Amz-Signature=secret',
    'http://www.example.org/public',
  ];
  for (const url of urls) {
    assert.throws(() => prepareNotionPage(PARENT, 'unsafe', `[unsafe](${url})`), url);
  }
  const safe = prepareNotionPage(PARENT, 'safe', '[HTTPS link](https://www.example.org/path#part)');
  assert.deepEqual(safe.links, [{ text: 'HTTPS link', url: 'https://www.example.org/path#part' }]);
});

test('enforces title, text, URL and payload limits using Unicode characters and UTF-8 bytes', () => {
  assert.equal(notionContentLimits.richTextContentCharacters, 2_000);
  assert.equal(notionContentLimits.richTextItems, 100);
  assert.equal(notionContentLimits.children, 100);
  assert.equal(notionContentLimits.blocks, 1_000);
  assert.equal(notionContentLimits.requestBytes, 500_000);
  assert.doesNotThrow(() => prepareNotionPage(PARENT, `${'😀'.repeat(999)}ab`, 'body'));
  assert.throws(() => prepareNotionPage(PARENT, `${'😀'.repeat(999)}abc`, 'body'), /标题超过保守的 2000/);
  assert.throws(() => prepareNotionPage(PARENT, 'title', `[long](https://docs.example.com/${'a'.repeat(2_000)})`), /超过 2000/);
  const exactPayload = prepareNotionPage(PARENT, 'boundary', '文'.repeat(162_035));
  assert.equal(Buffer.byteLength(JSON.stringify(exactPayload.body), 'utf8'), 500_000);
  const oneByteOver = structuredClone(exactPayload.body);
  const final = oneByteOver.children[0];
  assert.equal(final.type, 'paragraph');
  if (final.type !== 'paragraph') assert.fail('expected paragraph');
  final.paragraph.rich_text.at(-1)!.text.content += 'a';
  assert.equal(Buffer.byteLength(JSON.stringify(oneByteOver), 'utf8'), 500_001);
  assert.throws(() => prepareNotionPage(PARENT, 'boundary', `${'文'.repeat(162_035)}a`), /500 KB/);
});

test('rejects invalid IDs, controls and empty content', () => {
  assert.throws(() => prepareNotionPage('not-a-uuid', 'title', 'body'), /UUID/);
  assert.throws(() => prepareNotionPage(PARENT, ' title ', 'body'), /首尾空白/);
  assert.throws(() => prepareNotionPage(PARENT, 'bad\u0000title', 'body'), /控制字符/);
  assert.throws(() => prepareNotionPage(PARENT, 'title', '   '), /正文不能为空|有效/);
});

test('503 committed_resource_id only yields a conservative readback requirement for create-page results', () => {
  const id = '89abcdef0123456789abcdef01234567';
  assert.deepEqual(parseNotionCreatePage503('create_page', 503, { object: 'error', additional_data: { committed_resource_id: id } }), {
    status: 'committed_hint_needs_readback', pageId: '89abcdef-0123-4567-89ab-cdef01234567',
  });
  for (const [operation, status, body] of [
    ['append_children', 503, { object: 'error', additional_data: { committed_resource_id: id } }],
    ['create_database', 503, { object: 'error', additional_data: { committed_resource_id: id } }],
    ['create_page', 200, { object: 'error', additional_data: { committed_resource_id: id } }],
    ['create_page', 429, { object: 'error', additional_data: { committed_resource_id: id } }],
    ['create_page', 503, { additional_data: { committed_resource_id: id } }],
    ['create_page', 503, { object: 'error', committed_resource_id: id }],
    ['create_page', 503, {}],
    ['create_page', 503, { object: 'error', additional_data: {} }],
    ['create_page', 503, { object: 'error', additional_data: { committed_resource_id: 'bad' } }],
    ['create_page', 503, { object: 'error', additional_data: { committed_resource_id: id, published: true } }],
  ] as const) {
    const result = parseNotionCreatePage503(operation, status, body);
    if (operation === 'create_page' && status === 503 && objectWithExtraPublished(body)) {
      assert.equal(result.status, 'committed_hint_needs_readback');
      assert.equal('published' in result, false);
    } else {
      assert.deepEqual(result, { status: 'unknown_needs_reconciliation' });
    }
    assert.equal('retry' in result, false);
  }
});

function objectWithExtraPublished(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'additional_data' in value
    && !!value.additional_data && typeof value.additional_data === 'object'
    && 'published' in value.additional_data;
}
