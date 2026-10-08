import { load } from 'cheerio';
import { marked } from 'marked';
import { applyDeclaredArticleVisibility, styleConcealsArticle,publicPagePolicy,withPageNofollow } from './article-visibility';

interface HtmlNode {
  type?: string;
  name?: string;
  tagName?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: HtmlNode[];
  parent?: HtmlNode | null;
}

const BLOCKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure',
  'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
const NON_RENDERED = new Set(['head', 'script', 'style', 'template', 'noscript']);
const LITERAL = new Set(['code', 'pre', 'kbd', 'samp']);

function name(node: HtmlNode): string { return (node.name ?? node.tagName ?? '').toLowerCase(); }
function hidden(node: HtmlNode): boolean {
  const tag = name(node);
  const attrs = node.attribs ?? {};
  if (NON_RENDERED.has(tag) || tag === 'input' && attrs.type?.toLowerCase() === 'hidden'
    || Object.hasOwn(attrs, 'hidden') || attrs['aria-hidden']?.toLowerCase() === 'true'
    || tag === 'dialog' && !Object.hasOwn(attrs, 'open')) return true;
  // The content of a closed disclosure is unavailable to a reader. Rejecting
  // its summary too is conservative when an article is nested in one.
  if (tag === 'details' && !Object.hasOwn(attrs, 'open')) return true;
  const classes = new Set((attrs.class ?? '').split(/\s+/).filter(Boolean));
  if (['hidden', 'invisible', 'collapse', 'sr-only'].some(token => classes.has(token))) return true;
  return styleConcealsArticle(attrs.style ?? '');
}
function hiddenByAncestor(node: HtmlNode): boolean {
  for (let current: HtmlNode | null | undefined = node; current; current = current.parent) {
    if (hidden(current)) return true;
  }
  return false;
}

function boundary(char: string | undefined): boolean {
  // Saturday's wordBoundary uses a zero byte, ASCII whitespace or ispunct.
  return !char || /[\t\n\v\f\r !"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(char);
}

function quoteOpen(previous: string | undefined, next: string | undefined, priorOpen: boolean): boolean {
  const space = (char: string | undefined) => !!char && /\s/.test(char);
  const punct = (char: string | undefined) => !!char && boundary(char) && !space(char);
  // Direct translation of Saturday smartQuoteHelper's sixteen context cases.
  if (!previous && !next) return !priorOpen;
  if (!next) return space(previous);
  if (space(next)) return space(previous) ? !priorOpen : false;
  if (punct(next)) return space(previous) ? true : punct(previous) ? !priorOpen : false;
  return !previous || space(previous) || punct(previous);
}

function smartText(input: string, state: { quoteOpen: boolean }): string {
  let result = '';
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    const previous = input[index - 1];
    const next = input[index + 1];
    if (char === '"') {
      state.quoteOpen = quoteOpen(previous, next, state.quoteOpen);
      result += state.quoteOpen ? '“' : '”';
    } else if (char === '(' && /^\((?:c|r|tm)\)/i.test(input.slice(index))) {
      const symbol = /^\((c|r|tm)\)/i.exec(input.slice(index))!;
      result += symbol[1].toLowerCase() === 'c' ? '©' : symbol[1].toLowerCase() === 'r' ? '®' : '™';
      index += symbol[0].length - 1;
    } else if (char === '-' && next === '-') {
      // Paper enables DASHES, not LATEX_DASHES: two hyphens make an em dash.
      result += '—';
      index++;
    } else if (char === '-' && next !== undefined && boundary(previous) && boundary(next)) {
      result += '–';
    } else if ((char === '1' || char === '3') && boundary(previous) && previous !== '/') {
      const fraction = input.slice(index, index + 3);
      const following = input[index + 3];
      const ordinaryEnd = boundary(following) && following !== '/';
      const ordinal = fraction === '1/4' && /^th/i.test(input.slice(index + 3))
        || fraction === '3/4' && /^ths/i.test(input.slice(index + 3));
      if ((fraction === '1/2' || fraction === '1/4' || fraction === '3/4') && (ordinaryEnd || ordinal)) {
        result += fraction === '1/2' ? '½' : fraction === '1/4' ? '¼' : '¾';
        index += 2;
      } else result += char;
    } else result += char;
  }
  return result;
}

function visibleText(node: HtmlNode, expected: boolean, state: { quoteOpen: boolean }, literal = false): string {
  if (node.type === 'text') return expected && !literal ? smartText(node.data ?? '', state) : node.data ?? '';
  if (hidden(node)) return '';
  const tag = name(node);
  const content = (node.children ?? []).map(child => visibleText(child, expected, state, literal || LITERAL.has(tag))).join('');
  return BLOCKS.has(tag) ? ` ${content} ` : content;
}

function normalized(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ')
    .replace(/(?<=[\p{L}\p{M}]) +(?=[.!?,;:](?: |$))/gu, '').trim();
}

function paperMarkdown(markdown: string): string {
  // Blackfriday keeps "- item" inside an existing paragraph as prose and
  // Smartypants prints its leading hyphen as an en dash. CommonMark starts a
  // list there. Preserve this measured Paper behavior before Marked parses it.
  let mode: 'blank' | 'paragraph' | 'list' | 'other' = 'blank';
  let proseDashes = false;
  let fence: string | undefined;
  return markdown.split('\n').map(line => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (delimiter?.[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
      return line;
    }
    if (delimiter) { fence = delimiter; mode = 'other'; proseDashes = false; return line; }
    if (!line.trim()) { mode = 'blank'; proseDashes = false; return line; }
    if (/^-\s+\S/.test(line)) {
      if (proseDashes || mode === 'paragraph') {
        mode = 'paragraph';
        proseDashes = true;
        return line.replace(/^-/, '\\-');
      }
      mode = 'list';
      return line;
    }
    proseDashes = false;
    mode = /^(?:#{1,6}\s|>|```|~~~|\s{4}|\|)/.test(line) ? 'other' : 'paragraph';
    return line;
  }).join('\n');
}

function bodyMatches(node: HtmlNode, markdown: string): boolean {
  try {
    const expectedHtml = marked.parse(paperMarkdown(markdown), { async: false, gfm: true });
    if (typeof expectedHtml !== 'string') return false;
    const expected=load(expectedHtml,undefined,false);
    const root = expected.root().get(0) as HtmlNode | undefined;
    const actual=load('');
    const links=(doc:ReturnType<typeof load>,scope:unknown)=>doc(scope as Parameters<typeof doc>[0]).find('a[href]').toArray()
      .filter(element=>!hiddenByAncestor(element as HtmlNode)).map(element=>doc(element).attr('href')??'');
    return !!root && JSON.stringify(links(expected,root))===JSON.stringify(links(actual,node))
      && normalized(visibleText(root, true, { quoteOpen: false }))
      === normalized(visibleText(node, false, { quoteOpen: false }));
  } catch { return false; }
}

export function paperVisibleBodyMatches(markdown: string, bodyHtml: string): boolean {
  const $ = load(bodyHtml, undefined, false);
  applyDeclaredArticleVisibility($);
  const root = $.root().get(0) as HtmlNode | undefined;
  return !!root && bodyMatches(root, markdown);
}

function canonicalHttps(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname
    || url.port && url.port !== '443') throw Error('invalid target');
  url.hash = '';
  return url.toString();
}

export function inspectPaperRenderedArticle(
  html: string, markdown: string, targetUrl: string,options:{pageUrl?:string;robotsHeader?:string}={},
): { found: true; rel: string } | { found: false } {
  try {
    const target = canonicalHttps(targetUrl);
    const $ = load(html);
    applyDeclaredArticleVisibility($);
    const policy=publicPagePolicy($,options.pageUrl,options.robotsHeader);
    if(!policy.valid)return {found:false};
    const bodies = $('article#post-body > .e-content').toArray();
    if (bodies.length !== 1 || hiddenByAncestor(bodies[0] as HtmlNode)
      || !bodyMatches(bodies[0] as HtmlNode, markdown)) return { found: false };
    const anchors = $(bodies[0]).find('a[href]').toArray();
    const linked = anchors.find(anchor => {
      if (hiddenByAncestor(anchor as HtmlNode)
        || !normalized(visibleText(anchor as HtmlNode, false, { quoteOpen: false }))) return false;
      try { return canonicalHttps($(anchor).attr('href') ?? '') === target; }
      catch { return false; }
    });
    return linked ? { found: true, rel: withPageNofollow($(linked).attr('rel')??'',policy.nofollow) } : { found: false };
  } catch { return { found: false }; }
}
