import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { load } from 'cheerio';
import { marked, type Token, type Tokens } from 'marked';

const MAX_RICH_TEXT_CONTENT_CHARACTERS = 2_000;
const MAX_RICH_TEXT_ITEMS = 100;
const MAX_CHILDREN = 100;
const MAX_BLOCKS = 1_000;
const MAX_REQUEST_BYTES = 500_000;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const SENSITIVE_QUERY_KEY = /^(?:access[_-]?key|access[_-]?token|api[_-]?key|auth|authorization|bearer|client[_-]?secret|credential|key|password|refresh[_-]?token|secret|signature|token|x[_-]amz[_-]signature)$/iu;
const PUBLIC_DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/iu;

export interface NotionTextAnnotations {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
  color: 'default';
}

export interface NotionRichText {
  type: 'text';
  text: { content: string; link: { url: string } | null };
  annotations: NotionTextAnnotations;
}

export type NotionBlock =
  | { object: 'block'; type: 'paragraph'; paragraph: { rich_text: NotionRichText[] } }
  | { object: 'block'; type: 'heading_1'; heading_1: { rich_text: NotionRichText[] } }
  | { object: 'block'; type: 'heading_2'; heading_2: { rich_text: NotionRichText[] } }
  | { object: 'block'; type: 'heading_3'; heading_3: { rich_text: NotionRichText[] } }
  | { object: 'block'; type: 'bulleted_list_item'; bulleted_list_item: { rich_text: NotionRichText[] } }
  | { object: 'block'; type: 'numbered_list_item'; numbered_list_item: { rich_text: NotionRichText[] } }
  | { object: 'block'; type: 'code'; code: { rich_text: NotionRichText[]; language: string; caption: [] } };

export interface NotionCreatePageBody {
  parent: { type: 'page_id'; page_id: string };
  properties: {
    title: { title: NotionRichText[] };
  };
  children: NotionBlock[];
}

export interface PreparedNotionPage {
  method: 'POST';
  path: '/v1/pages';
  body: NotionCreatePageBody;
  /** Hash of the prepared title and children; never evidence of remote publication. */
  preparedContentHash: string;
  requestHash: string;
  links: Array<{ text: string; url: string }>;
}

export type NotionCreatePage503Result =
  | { status: 'committed_hint_needs_readback'; pageId: string }
  | { status: 'unknown_needs_reconciliation' };

export type NotionWriteOperation = 'create_page' | 'append_children' | 'create_database';

interface InlineStyle {
  bold: boolean;
  italic: boolean;
  code: boolean;
  link: string | null;
}

const PLAIN_STYLE: InlineStyle = { bold: false, italic: false, code: false, link: null };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!object(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
  return result;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function assertUnicodeText(value: unknown, label: string, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || CONTROL.test(value)
    || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new Error(`${label}必须是有效且不含控制字符的 Unicode 文本`);
  }
}

function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || value !== value.trim() || !UUID.test(value)) {
    throw new Error(`${label}必须是 UUID`);
  }
  const compact = value.replaceAll('-', '').toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

const decodedEntityCache = new Map<string, string>();

function decodeMarkdownEntities(value: string): string {
  return value.replace(/&(?:#[0-9]{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/giu, entity => {
    const cached = decodedEntityCache.get(entity);
    if (cached !== undefined) return cached;
    const decoded = load(entity, null, false).text();
    decodedEntityCache.set(entity, decoded);
    return decoded;
  });
}

function privateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || a === 100 && b >= 64 && b <= 127
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 0 && (c === 0 || c === 2)
    || a === 192 && b === 88 && c === 99
    || a === 192 && b === 168
    || a === 198 && (b === 18 || b === 19)
    || a === 198 && b === 51 && c === 100
    || a === 203 && b === 0 && c === 113;
}

function publicHttpsUrl(value: string): string {
  const decoded = decodeMarkdownEntities(value);
  if (!decoded || decoded.length > MAX_RICH_TEXT_CONTENT_CHARACTERS || CONTROL.test(decoded)
    || /[\u0009\u000a\u000d ]/u.test(decoded)) {
    throw new Error('Notion Markdown 链接超过 2000 字符或包含空白/控制字符');
  }
  let url: URL;
  try { url = new URL(decoded); } catch { throw new Error('Notion Markdown 链接不是有效的绝对 URL'); }
  const host = url.hostname.toLowerCase().replace(/\.$/u, '');
  const ip = isIP(host.replace(/^\[|\]$/gu, ''));
  if (url.protocol !== 'https:' || url.username || url.password || !host
    || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || host.endsWith('.invalid') || host.endsWith('.test') || host.endsWith('.example')
    || ip === 4 && privateIpv4(host) || ip === 6
    || !ip && !PUBLIC_DNS_NAME.test(host)
    || [...url.searchParams.keys()].some(key => SENSITIVE_QUERY_KEY.test(key))) {
    throw new Error('Notion Markdown 链接必须是无凭据的公开 HTTPS 地址');
  }
  url.hostname = host;
  const canonical = url.href;
  if (canonical.length > MAX_RICH_TEXT_CONTENT_CHARACTERS) {
    throw new Error('Notion Markdown 链接超过 2000 字符');
  }
  return canonical;
}

function annotations(style: InlineStyle): NotionTextAnnotations {
  return {
    bold: style.bold,
    italic: style.italic,
    strikethrough: false,
    underline: false,
    code: style.code,
    color: 'default',
  };
}

function sameStyle(left: NotionRichText, right: NotionRichText): boolean {
  return left.text.link?.url === right.text.link?.url
    && left.annotations.bold === right.annotations.bold
    && left.annotations.italic === right.annotations.italic
    && left.annotations.code === right.annotations.code;
}

function appendRichText(target: NotionRichText[], content: string, style: InlineStyle): void {
  assertUnicodeText(content, 'Notion 正文片段', true);
  if (!content) return;
  const candidate: NotionRichText = {
    type: 'text',
    text: { content, link: style.link ? { url: style.link } : null },
    annotations: annotations(style),
  };
  const previous = target.at(-1);
  if (previous && sameStyle(previous, candidate)
    && previous.text.content.length + content.length <= MAX_RICH_TEXT_CONTENT_CHARACTERS) {
    previous.text.content += content;
    return;
  }
  let chunk = '';
  const flush = () => {
    if (!chunk) return;
    target.push({
      ...candidate,
      text: { ...candidate.text, content: chunk },
      annotations: { ...candidate.annotations },
    });
    chunk = '';
  };
  for (const character of content) {
    if (chunk.length + character.length > MAX_RICH_TEXT_CONTENT_CHARACTERS) flush();
    chunk += character;
  }
  flush();
}

function richText(tokens: Token[], links: Array<{ text: string; url: string }>, style: InlineStyle = PLAIN_STYLE): NotionRichText[] {
  const result: NotionRichText[] = [];
  const visit = (token: Token, current: InlineStyle): void => {
    switch (token.type) {
      case 'text': {
        const value = token as Tokens.Text;
        if (value.tokens?.length) value.tokens.forEach(child => visit(child, current));
        else appendRichText(result, decodeMarkdownEntities(value.text), current);
        return;
      }
      case 'escape':
        appendRichText(result, decodeMarkdownEntities((token as Tokens.Escape).text), current);
        return;
      case 'strong':
        (token as Tokens.Strong).tokens.forEach(child => visit(child, { ...current, bold: true }));
        return;
      case 'em':
        (token as Tokens.Em).tokens.forEach(child => visit(child, { ...current, italic: true }));
        return;
      case 'codespan':
        appendRichText(result, (token as Tokens.Codespan).text, { ...current, code: true });
        return;
      case 'link': {
        if (current.link) throw new Error('Notion Markdown 不允许嵌套链接');
        const link = token as Tokens.Link;
        if (link.title) throw new Error('Notion Markdown 链接标题无法无损转换');
        const url = publicHttpsUrl(link.href);
        const before = result.map(item => item.text.content).join('').length;
        link.tokens.forEach(child => visit(child, { ...current, link: url }));
        const visible = result.map(item => item.text.content).join('').slice(before);
        if (!visible) throw new Error('Notion Markdown 链接必须有可见文字');
        links.push({ text: visible, url });
        return;
      }
      case 'image':
        throw new Error('Notion 离线转换不支持 Markdown 图片');
      case 'html':
        throw new Error('Notion 离线转换不支持 HTML');
      case 'br':
        throw new Error('Notion 离线转换不支持硬换行；请拆成普通段落');
      default:
        throw new Error(`Notion 离线转换不支持行内 Markdown：${token.type}`);
    }
  };
  tokens.forEach(token => visit(token, style));
  if (!result.length || result.length > MAX_RICH_TEXT_ITEMS) {
    throw new Error(`Notion rich_text 数组必须包含 1–${MAX_RICH_TEXT_ITEMS} 项`);
  }
  return result;
}

const PLAIN_CODE_LANGUAGES = new Set(['', 'text', 'plaintext', 'plain', 'plain text']);

function codeRichText(value: string): NotionRichText[] {
  assertUnicodeText(value, 'Notion 代码', true);
  if (!value) throw new Error('Notion 代码块不能为空');
  const result: NotionRichText[] = [];
  appendRichText(result, value, PLAIN_STYLE);
  if (result.length > MAX_RICH_TEXT_ITEMS) throw new Error('Notion 代码块超过单个 rich_text 数组上限');
  return result;
}

function blocksFromMarkdown(markdown: string, links: Array<{ text: string; url: string }>): NotionBlock[] {
  const tokens = marked.lexer(markdown, { gfm: true });
  const blocks: NotionBlock[] = [];
  for (const token of tokens) {
    if (token.type === 'space' || token.type === 'def') continue;
    if (token.type === 'paragraph') {
      blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: richText(token.tokens!, links) } });
      continue;
    }
    if (token.type === 'heading') {
      if (token.depth < 1 || token.depth > 3) throw new Error('Notion 离线转换只支持一至三级标题');
      const type = `heading_${token.depth}` as 'heading_1' | 'heading_2' | 'heading_3';
      blocks.push({ object: 'block', type, [type]: { rich_text: richText(token.tokens!, links) } } as NotionBlock);
      continue;
    }
    if (token.type === 'list') {
      if (token.loose || token.ordered && token.start !== 1) {
        throw new Error('Notion 离线转换只支持从 1 开始的紧凑简单列表');
      }
      const type = token.ordered ? 'numbered_list_item' : 'bulleted_list_item';
      for (const item of token.items) {
        if (item.task || item.loose || item.tokens.length !== 1 || item.tokens[0].type !== 'text'
          || !(item.tokens[0] as Tokens.Text).tokens?.length) {
          throw new Error('Notion 离线转换不支持任务、嵌套或多段列表项');
        }
        const itemText = item.tokens[0] as Tokens.Text;
        blocks.push({ object: 'block', type, [type]: { rich_text: richText(itemText.tokens!, links) } } as NotionBlock);
      }
      continue;
    }
    if (token.type === 'code') {
      const rawLanguage = (token.lang ?? '').trim().toLowerCase();
      if (!PLAIN_CODE_LANGUAGES.has(rawLanguage)) {
        throw new Error('Notion 离线转换仅接受无语言或纯文本代码块');
      }
      blocks.push({ object: 'block', type: 'code', code: {
        rich_text: codeRichText(token.text), language: 'plain text', caption: [],
      } });
      continue;
    }
    if (token.type === 'html') throw new Error('Notion 离线转换不支持 HTML');
    if (token.type === 'table') throw new Error('Notion 离线转换不支持 Markdown 表格');
    if (token.type === 'blockquote') throw new Error('Notion 离线转换不支持引用块');
    if (token.type === 'hr') throw new Error('Notion 离线转换不支持分隔线');
    throw new Error(`Notion 离线转换不支持块级 Markdown：${token.type}`);
  }
  if (!blocks.length) throw new Error('Notion 正文不能为空');
  if (blocks.length > MAX_BLOCKS || blocks.length > MAX_CHILDREN) {
    throw new Error(`Notion 创建请求只能一次提交不超过 ${MAX_CHILDREN} 个顶层 children；不会拆分 append`);
  }
  return blocks;
}

export function prepareNotionPage(parentPageId: string, title: string, markdown: string): PreparedNotionPage {
  const parent = canonicalUuid(parentPageId, 'Notion 父页 ID');
  assertUnicodeText(title, 'Notion 标题');
  assertUnicodeText(markdown, 'Notion Markdown');
  if (title !== title.trim()) throw new Error('Notion 标题不能包含首尾空白');
  if (title.length > MAX_RICH_TEXT_CONTENT_CHARACTERS) throw new Error('Notion 标题超过保守的 2000 UTF-16 code units 上限');
  const titleRichText: NotionRichText[] = [];
  appendRichText(titleRichText, title, PLAIN_STYLE);
  const foundLinks: Array<{ text: string; url: string }> = [];
  const children = blocksFromMarkdown(markdown, foundLinks);
  const body: NotionCreatePageBody = {
    parent: { type: 'page_id', page_id: parent },
    properties: { title: { title: titleRichText } },
    children,
  };
  const request = canonicalJson(body);
  if (Buffer.byteLength(request, 'utf8') > MAX_REQUEST_BYTES) {
    throw new Error('Notion 创建请求超过 500 KB；不会拆分 append');
  }
  return {
    method: 'POST', path: '/v1/pages', body,
    preparedContentHash: sha256(canonicalJson({ title: titleRichText, children })),
    requestHash: sha256(request),
    links: foundLinks,
  };
}

/**
 * This parser is deliberately limited to an HTTP result from Create a page.
 * A committed id means the response needs readback; it does not prove publication.
 */
export function parseNotionCreatePage503(
  operation: NotionWriteOperation,
  status: number,
  body: unknown,
): NotionCreatePage503Result {
  if (operation !== 'create_page' || status !== 503 || !object(body) || body.object !== 'error'
    || !object(body.additional_data)) return { status: 'unknown_needs_reconciliation' };
  try {
    return {
      status: 'committed_hint_needs_readback',
      pageId: canonicalUuid(body.additional_data.committed_resource_id, 'Notion 已提交资源 ID'),
    };
  } catch {
    return { status: 'unknown_needs_reconciliation' };
  }
}

export const notionContentLimits = Object.freeze({
  richTextContentCharacters: MAX_RICH_TEXT_CONTENT_CHARACTERS,
  richTextItems: MAX_RICH_TEXT_ITEMS,
  children: MAX_CHILDREN,
  blocks: MAX_BLOCKS,
  requestBytes: MAX_REQUEST_BYTES,
});
