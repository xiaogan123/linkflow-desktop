import { load } from 'cheerio';
import { marked } from 'marked';

interface HtmlNodeLike {
  type?: string;
  name?: string;
  tagName?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: HtmlNodeLike[];
  parent?: HtmlNodeLike | null;
}

export interface RenderedArticleMatch {
  found: true;
  rel: string;
}

export type RenderedArticleFailure = 'body' | 'semantics' | 'target' | 'html';

export type RenderedArticleInspection = RenderedArticleMatch | {
  found: false;
  reason: RenderedArticleFailure;
};

export interface RenderedArticleOptions {
  title?: string;
}

function canonicalHttps(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname
    || (url.port && url.port !== '443')) throw new Error('target must be a public HTTPS URL');
  url.hash = '';
  return url.toString();
}

const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
const NON_RENDERED_ELEMENTS = new Set(['head', 'script', 'style', 'template', 'noscript']);

function nodeName(node: HtmlNodeLike): string {
  return (node.name ?? node.tagName ?? '').toLowerCase();
}

function nodeIsHidden(node: HtmlNodeLike): boolean {
  const name = nodeName(node);
  if (NON_RENDERED_ELEMENTS.has(name) || name === 'input' && (node.attribs?.type ?? '').toLowerCase() === 'hidden') return true;
  const attributes = node.attribs ?? {};
  if (Object.prototype.hasOwnProperty.call(attributes, 'hidden') || attributes['aria-hidden']?.toLowerCase() === 'true') return true;
  if (name === 'dialog' && !Object.prototype.hasOwnProperty.call(attributes, 'open')) return true;
  const classes = new Set((attributes.class ?? '').split(/\s+/).filter(Boolean));
  if (['hidden', 'invisible', 'collapse', 'sr-only'].some(token => classes.has(token))) return true;
  const style = (attributes.style ?? '').toLowerCase().replace(/\s+/g, '');
  return /(?:^|;)display:none(?:!important)?(?:;|$)/.test(style)
    || /(?:^|;)visibility:(?:hidden|collapse)(?:!important)?(?:;|$)/.test(style)
    || /(?:^|;)content-visibility:hidden(?:!important)?(?:;|$)/.test(style)
    || /(?:^|;)opacity:0(?:!important)?(?:;|$)/.test(style);
}

function nodeOrAncestorIsHidden(value: unknown): boolean {
  let node = value as HtmlNodeLike | null | undefined;
  while (node) {
    if (nodeIsHidden(node)) return true;
    node = node.parent;
  }
  return false;
}

function renderedVisibleText(value: unknown): string {
  const visit = (node: HtmlNodeLike): string => {
    if (node.type === 'text') return node.data ?? '';
    if (nodeIsHidden(node)) return '';
    const text = (node.children ?? []).map(visit).join('');
    return BLOCK_ELEMENTS.has(nodeName(node)) ? ` ${text} ` : text;
  };
  return visit(value as HtmlNodeLike);
}

function normalizedVisibleText(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').replace(/(?<=[\p{L}\p{M}]) +(?=[.!?,;:](?: |$))/gu, '').trim();
}

function expectedArticleTextVariants(article: { content: string; title?: string }): string[] {
  try {
    // Marked only produces an HTML string here. Cheerio parses it without a
    // browser, so raw HTML in Markdown is never executed.
    const rendered = marked.parse(article.content, { async: false, gfm: true });
    if (typeof rendered !== 'string') return [];
    const $ = load(rendered, undefined, false);
    const root = $.root().get(0);
    if (!root) return [];
    const variants = [normalizedVisibleText(renderedVisibleText(root))];
    if (article.title) {
      const firstVisible = $.root().children().toArray()
        .find(node => normalizedVisibleText(renderedVisibleText(node)).length > 0);
      if (firstVisible && nodeName(firstVisible) === 'h1'
        && normalizedVisibleText(renderedVisibleText(firstVisible)) === normalizedVisibleText(article.title)) {
        $(firstVisible).remove();
        variants.push(normalizedVisibleText(renderedVisibleText(root)));
      }
    }
    return [...new Set(variants)];
  } catch {
    return [];
  }
}

export function articleSemanticsMatch(
  value: unknown,
  article: { content: string; title?: string },
): boolean {
  const rendered = normalizedVisibleText(renderedVisibleText(value));
  return expectedArticleTextVariants(article).includes(rendered);
}

/**
 * Verifies that exactly one visible body in the caller-provided article scope
 * renders the complete Markdown semantics and contains the reviewed HTTPS link.
 * Use `body` only for a static document whose entire body is the publication;
 * public pages should pass their measured `article` or `main` content selector.
 */
export function inspectRenderedArticle(
  html: string,
  markdown: string,
  targetUrl: string,
  bodySelector: string,
  options: RenderedArticleOptions = {},
): RenderedArticleInspection {
  try {
    if (!bodySelector.trim()) return { found: false, reason: 'body' };
    const target = canonicalHttps(targetUrl);
    const $ = load(html);
    const bodies = $(bodySelector).toArray().filter(element => !nodeOrAncestorIsHidden(element));
    if (bodies.length !== 1) return { found: false, reason: 'body' };
    if (!articleSemanticsMatch(bodies[0], { content: markdown, title: options.title })) {
      return { found: false, reason: 'semantics' };
    }
    const targetAnchors = $(bodies[0]).find('a[href]').toArray()
      .filter(element => !nodeOrAncestorIsHidden(element))
      .filter(element => {
        const href = $(element).attr('href');
        if (!href) return false;
        try { return canonicalHttps(href) === target; }
        catch { return false; }
      });
    if (!targetAnchors.length) return { found: false, reason: 'target' };
    return { found: true, rel: ($(targetAnchors[0]).attr('rel') ?? '').trim().toLowerCase() };
  } catch {
    return { found: false, reason: 'html' };
  }
}

export function verifyRenderedArticle(
  html: string,
  markdown: string,
  targetUrl: string,
  bodySelector: string,
  options: RenderedArticleOptions = {},
): RenderedArticleMatch | false {
  const result = inspectRenderedArticle(html, markdown, targetUrl, bodySelector, options);
  return result.found ? result : false;
}
