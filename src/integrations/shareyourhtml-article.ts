import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { marked } from 'marked';

export const SHAREYOURHTML_MAX_HTML_BYTES = 120_000;
export const SHAREYOURHTML_MAX_REQUEST_BYTES = 200_000;

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const SECRET_QUERY = /^(?:token|api[_-]?key|password|secret|access_token)$/i;
const PUBLIC_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i;
const ALLOWED_ELEMENTS = new Set([
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
]);

export interface ShareYourHtmlArticleDraft {
  title: string;
  description: string;
  body: string;
}

export interface ShareYourHtmlArticleInput {
  draft: ShareYourHtmlArticleDraft;
  /** Exact reviewed site or topic destination which must appear as a Markdown link. */
  targetUrl: string;
  language: string;
  slug: string;
}

export interface RenderedShareYourHtmlArticle {
  html: string;
  targetUrl: string;
  sourceHash: string;
  requestHash: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function validUnicodeText(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || !!value.trim()) && !CONTROL.test(value)
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/**
 * Canonicalize a public HTTPS link and reject local hosts, credentials, non-default
 * ports, fragments and credential-like query parameters. The caller must already
 * hold the canonical spelling so reviewed bytes and rendered bytes cannot drift.
 */
function exactPublicHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 2_048
    || CONTROL.test(value)) return;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !PUBLIC_HOST.test(host) || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/i.test(host)
      || url.hash || [...url.searchParams.keys()].some(key => SECRET_QUERY.test(key))) return;
    url.hostname = host;
    if (url.port === '443') url.port = '';
    const canonical = url.href;
    return canonical === value ? canonical : undefined;
  } catch {
    return;
  }
}

function assertSafeMarkdown(body: string, targetUrl: string): string {
  const tokens = marked.lexer(body, { gfm: true });
  marked.walkTokens(tokens, token => {
    if (token.type === 'html' || token.type === 'image') {
      throw Error('ShareYourHTML Markdown 包含不允许的 HTML 或图片');
    }
    if (token.type === 'list_item' && token.task) {
      throw Error('ShareYourHTML Markdown 任务控件不允许发布');
    }
    if (token.type === 'link' && !exactPublicHttpsUrl(token.href)) {
      throw Error('ShareYourHTML Markdown 链接必须是规范公开 HTTPS 地址');
    }
  });

  const rendered = marked.parser(tokens, { gfm: true });
  const $ = load(rendered, undefined, false);
  let targetFound = false;
  $('*').each((_index, element) => {
    if (!('tagName' in element)) throw Error('ShareYourHTML Markdown 生成了无效节点');
    const name = element.tagName.toLowerCase();
    if (!ALLOWED_ELEMENTS.has(name)) {
      throw Error('ShareYourHTML Markdown 生成了不允许的元素');
    }
    const node = $(element);
    const attributes = node.attr() ?? {};
    const attributeNames = Object.keys(attributes);
    const resetAttributes = () => {
      for (const attribute of attributeNames) node.removeAttr(attribute);
    };
    if (name === 'a') {
      const href = node.attr('href');
      const title = node.attr('title');
      if (attributeNames.some(attribute => !['href', 'title'].includes(attribute))
        || !href || !exactPublicHttpsUrl(href)
        || title !== undefined && (!validUnicodeText(title, true) || title.length > 512)) {
        throw Error('ShareYourHTML Markdown 链接必须是规范公开 HTTPS 地址');
      }
      resetAttributes();
      node.attr('href', href);
      if (title !== undefined) node.attr('title', title);
      node.attr('rel', 'nofollow ugc noopener noreferrer');
      if (href === targetUrl) targetFound = true;
      return;
    }
    if (name === 'ol' && attributeNames.length) {
      const start = node.attr('start');
      if (attributeNames.some(attribute => attribute !== 'start') || !start
        || !/^-?(?:0|[1-9]\d{0,8})$/u.test(start) || !Number.isSafeInteger(Number(start))) {
        throw Error('ShareYourHTML Markdown 有序列表起始值无效');
      }
      resetAttributes();
      node.attr('start', start);
      return;
    }
    if (name === 'code' && attributeNames.length) {
      const className = node.attr('class');
      if (attributeNames.some(attribute => attribute !== 'class') || !className
        || !/^language-[a-z0-9_+.#-]{1,64}$/iu.test(className)) {
        throw Error('ShareYourHTML Markdown 代码语言标识无效');
      }
      resetAttributes();
      node.attr('class', className);
      return;
    }
    if ((name === 'th' || name === 'td') && attributeNames.length) {
      const align = node.attr('align');
      if (attributeNames.some(attribute => attribute !== 'align')
        || !align || !['left', 'center', 'right'].includes(align)) {
        throw Error('ShareYourHTML Markdown 表格对齐值无效');
      }
      resetAttributes();
      node.attr('align', align);
      return;
    }
    if (attributeNames.length) {
      throw Error('ShareYourHTML Markdown 生成了不允许的属性');
    }
  });
  if (!targetFound) throw Error('ShareYourHTML 稿件缺少精确审核目标链接');
  return $.html();
}

/**
 * Deterministically renders the exact reviewed draft. It rejects active HTML and
 * remote resources rather than deleting or truncating material after review.
 */
export function renderShareYourHtmlArticle(
  input: ShareYourHtmlArticleInput,
): RenderedShareYourHtmlArticle {
  if (!SLUG.test(input.slug)) throw Error('ShareYourHTML slug 无效');
  if (!LANGUAGE.test(input.language)) throw Error('ShareYourHTML 语言标识无效');
  if (!validUnicodeText(input.draft.title) || !validUnicodeText(input.draft.description, true)
    || !validUnicodeText(input.draft.body)) {
    throw Error('ShareYourHTML 原稿包含无效文字');
  }
  const targetUrl = exactPublicHttpsUrl(input.targetUrl);
  if (!targetUrl) throw Error('ShareYourHTML 审核目标必须是规范公开 HTTPS 地址');

  const article = assertSafeMarkdown(input.draft.body, targetUrl);
  const language = input.language.toLowerCase();
  const html = '<!doctype html>\n'
    + `<html lang="${escapeAttribute(language)}"><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${escapeText(input.draft.title)}</title>`
    + `<meta name="description" content="${escapeAttribute(input.draft.description)}">`
    + '</head><body><main><article><header>'
    + `<h1>${escapeText(input.draft.title)}</h1>`
    + `<p>${escapeText(input.draft.description)}</p>`
    + `</header><section>${article}</section></article></main></body></html>`;
  if (Buffer.byteLength(html, 'utf8') > SHAREYOURHTML_MAX_HTML_BYTES) {
    throw Error('ShareYourHTML HTML 超出本地限制');
  }
  const request = JSON.stringify({ slug: input.slug, html, expiry: 'never' });
  if (Buffer.byteLength(request, 'utf8') > SHAREYOURHTML_MAX_REQUEST_BYTES) {
    throw Error('ShareYourHTML 请求超出本地限制');
  }
  return Object.freeze({ html, targetUrl, sourceHash: sha256(html), requestHash: sha256(request) });
}
