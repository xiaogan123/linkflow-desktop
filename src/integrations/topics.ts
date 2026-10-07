import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import type { Site, SiteTopic } from '../shared/types.js';
import { isArticleTopicUrl } from '../shared/topic-policy.js';
import { fetchPublicText, normalizePublicUrl } from './web.js';

const MAX_CHILD_SITEMAPS = 2;
const MAX_TOPIC_URLS = 200;
const MAX_HOME_TOPICS = 50;
const MAX_HOME_LINKS_SCANNED = 500;
const MAX_REQUESTS = 4;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 4_000_000;
const DISCOVERY_DEADLINE_MS = 25_000;
const EVIDENCE_DEADLINE_MS = 12_000;
const MAX_EVIDENCE_TEXT = 24_000;

export type TopicDiscoveryErrorCode =
  | 'aborted'
  | 'invalid_site'
  | 'invalid_topic'
  | 'unsafe_response'
  | 'temporary'
  | 'limit_exceeded'
  | 'not_found'
  | 'no_candidates';

const ERROR_MESSAGES: Record<TopicDiscoveryErrorCode, string> = {
  aborted: 'Topic discovery was cancelled.',
  invalid_site: 'The site address is not a valid public site.',
  invalid_topic: 'The requested page is not an approved topic candidate.',
  unsafe_response: 'The site returned an unsafe topic discovery response.',
  temporary: 'Topic discovery temporarily failed while reading the public site.',
  limit_exceeded: 'Topic discovery stopped at its safety limit.',
  not_found: 'The requested public resource was not found.',
  no_candidates: 'No eligible topic pages were found.',
};

export class TopicDiscoveryError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: TopicDiscoveryErrorCode, retryable = code === 'temporary' || code === 'aborted') {
    super(ERROR_MESSAGES[code]);
    this.name = 'TopicDiscoveryError';
    this.retryable = retryable;
  }
}

export type TopicResourceKind = 'sitemap' | 'html';

export interface TopicFetchResult {
  url: string;
  body: string;
  contentType?: string;
}

export interface TopicTransport {
  fetch(input: string, signal: AbortSignal, kind: TopicResourceKind): Promise<TopicFetchResult>;
}

export interface TopicDiscoveryResult {
  topics: SiteTopic[];
  checkedAt: string;
}

export interface TopicEvidence {
  url: string;
  title: string;
  text: string;
  contentHash: string;
}

export interface DraftFingerprintInput {
  title: string;
  body?: string;
  description?: string;
  topicUrl?: string;
}

export interface DuplicateDraftResult {
  duplicate: boolean;
  score: number;
  matchedIndex?: number;
  reason?: 'canonical_url' | 'normalized_title' | 'content_similarity';
}

interface SiteIdentity {
  baseUrl: URL;
  host: string;
}

interface FetchBudget {
  requests: number;
  bytes: number;
}

interface SitemapEntry {
  url: string;
  title?: string;
  lastModified?: string;
}

interface ParsedSitemap {
  kind: 'index' | 'urlset';
  entries: SitemapEntry[];
}

function normalizedHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

function identifySite(site: Pick<Site, 'url' | 'domain'>): SiteIdentity {
  try {
    const baseUrl = normalizePublicUrl(site.url);
    const domainUrl = normalizePublicUrl(site.domain);
    const host = normalizedHost(baseUrl);
    if (host !== normalizedHost(domainUrl)) throw new TopicDiscoveryError('invalid_site', false);
    return { baseUrl, host };
  } catch (error) {
    if (error instanceof TopicDiscoveryError) throw error;
    throw new TopicDiscoveryError('invalid_site', false);
  }
}

function isSameSite(input: string | URL, site: SiteIdentity): boolean {
  try {
    const parsed = input instanceof URL ? normalizePublicUrl(input.href) : normalizePublicUrl(input);
    return normalizedHost(parsed) === site.host;
  } catch {
    return false;
  }
}

function canonicalPageUrl(input: string): string {
  const parsed = normalizePublicUrl(input);
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(?:fbclid|gclid|dclid|msclkid)$/i.test(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.href;
}

function canonicalUrlKey(input: string): string | undefined {
  try {
    const parsed = new URL(canonicalPageUrl(input));
    const host = normalizedHost(parsed);
    const path = parsed.pathname.replace(/\/(?:index\.html?)$/i, '/').replace(/\/+$/, '') || '/';
    return `${host}${path}${parsed.search}`;
  } catch {
    return undefined;
  }
}

function asTopicError(error: unknown): TopicDiscoveryError {
  if (error instanceof TopicDiscoveryError) return error;
  const message = error instanceof Error ? error.message : '';
  if (/abort/i.test(message)) return new TopicDiscoveryError('aborted');
  if (/size limit|safety limit|too large/i.test(message)) return new TopicDiscoveryError('limit_exceeded', false);
  if (/private|reserved|public host|credentials|redirect target|cross-site/i.test(message)) {
    return new TopicDiscoveryError('unsafe_response', false);
  }
  return new TopicDiscoveryError('temporary');
}

function httpStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error && Number.isInteger((error as { status?: unknown }).status)) {
    return (error as { status: number }).status;
  }
  const match = error instanceof Error ? error.message.match(/\bHTTP\s+(\d{3})\b/i) : undefined;
  return match ? Number(match[1]) : undefined;
}

function runWithOverallDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  operation: (boundedSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TopicDiscoveryError('aborted'));
      return;
    }
    const controller = new AbortController();
    let settled = false;
    const finish = (handler: (value: T | TopicDiscoveryError) => void, value: T | TopicDiscoveryError) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      handler(value);
    };
    const abort = () => {
      controller.abort();
      finish(reject as (value: T | TopicDiscoveryError) => void, new TopicDiscoveryError('aborted'));
    };
    const deadline = setTimeout(() => {
      controller.abort();
      finish(reject as (value: T | TopicDiscoveryError) => void, new TopicDiscoveryError('temporary'));
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => finish(resolve as (value: T | TopicDiscoveryError) => void, value),
        (error) => finish(reject as (value: T | TopicDiscoveryError) => void, asTopicError(error)),
      );
  });
}

function defaultTransport(site: SiteIdentity): TopicTransport {
  return {
    async fetch(input, signal, kind) {
      const result = await fetchPublicText(input, signal, undefined, {
        allowXml: kind === 'sitemap',
        allowRedirect: (_from, to) => isSameSite(to, site),
      });
      return { url: result.url, body: result.text, contentType: result.contentType };
    },
  };
}

async function fetchBounded(
  input: string,
  kind: TopicResourceKind,
  site: SiteIdentity,
  signal: AbortSignal,
  transport: TopicTransport,
  budget: FetchBudget,
): Promise<TopicFetchResult> {
  if (!isSameSite(input, site)) throw new TopicDiscoveryError('unsafe_response', false);
  if (budget.requests >= MAX_REQUESTS) throw new TopicDiscoveryError('limit_exceeded', false);
  budget.requests++;
  let result: TopicFetchResult;
  try {
    result = await transport.fetch(input, signal, kind);
  } catch (error) {
    const status = httpStatus(error);
    const message = error instanceof Error ? error.message : '';
    if (status === 404 || status === 410 || /\b(?:404|410|not found)\b/i.test(message)) {
      throw new TopicDiscoveryError('not_found', false);
    }
    throw asTopicError(error);
  }
  if (!result || typeof result.url !== 'string' || typeof result.body !== 'string') {
    throw new TopicDiscoveryError('unsafe_response', false);
  }
  if (!isSameSite(result.url, site)) throw new TopicDiscoveryError('unsafe_response', false);
  const bytes = Buffer.byteLength(result.body, 'utf8');
  if (bytes > MAX_RESPONSE_BYTES || budget.bytes + bytes > MAX_TOTAL_BYTES) {
    throw new TopicDiscoveryError('limit_exceeded', false);
  }
  budget.bytes += bytes;
  return result;
}

function decodeXmlText(raw: string): string {
  const input = raw.trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1');
  const decoded = input.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, value: string) => {
    const lower = value.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const numeric = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0x10ffff || (numeric >= 0xd800 && numeric <= 0xdfff)) {
      throw new TopicDiscoveryError('unsafe_response', false);
    }
    return String.fromCodePoint(numeric);
  });
  if (/&(?:#?[\w.-]+);/.test(decoded)) throw new TopicDiscoveryError('unsafe_response', false);
  return decoded.trim();
}

function tagText(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}\\s*>`, 'i'));
  return match ? decodeXmlText(match[1]) : undefined;
}

function parseSitemap(xml: string, maxEntries: number): ParsedSitemap {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new TopicDiscoveryError('unsafe_response', false);
  const isIndex = /<(?:[\w.-]+:)?sitemapindex(?:\s|>)/i.test(xml);
  const isUrlset = /<(?:[\w.-]+:)?urlset(?:\s|>)/i.test(xml);
  if (isIndex === isUrlset) throw new TopicDiscoveryError('unsafe_response', false);
  const itemName = isIndex ? 'sitemap' : 'url';
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${itemName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${itemName}\\s*>`, 'gi');
  const entries: SitemapEntry[] = [];
  for (let match = pattern.exec(xml); match && entries.length < maxEntries; match = pattern.exec(xml)) {
    const url = tagText(match[1], 'loc');
    if (!url) continue;
    const rawTitle = tagText(match[1], 'title');
    const rawLastModified = tagText(match[1], 'lastmod');
    const title = rawTitle?.replace(/\s+/g, ' ').trim().slice(0, 160) || undefined;
    const lastModified = rawLastModified && Number.isFinite(Date.parse(rawLastModified)) && /^\d{4}-\d{2}-\d{2}(?:[T\s]|$)/.test(rawLastModified)
      ? rawLastModified.slice(0, 64)
      : undefined;
    entries.push({ url, title, lastModified });
  }
  return { kind: isIndex ? 'index' : 'urlset', entries };
}

function isEligibleTopicUrl(input: string, site: SiteIdentity): boolean {
  return isSameSite(input, site) && isArticleTopicUrl(input, {
    url: site.baseUrl.href,
    domain: site.host,
  });
}

function toTopic(entry: SitemapEntry, site: SiteIdentity, discoveredAt: string): SiteTopic | undefined {
  if (!isEligibleTopicUrl(entry.url, site)) return undefined;
  try {
    return {
      url: canonicalPageUrl(entry.url),
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.lastModified ? { lastModified: entry.lastModified } : {}),
      discoveredAt,
    };
  } catch {
    return undefined;
  }
}

function uniqueTopics(entries: SitemapEntry[], site: SiteIdentity, discoveredAt: string, limit: number): SiteTopic[] {
  const seen = new Set<string>();
  const topics: SiteTopic[] = [];
  for (const entry of entries) {
    const topic = toTopic(entry, site, discoveredAt);
    if (!topic) continue;
    const key = canonicalUrlKey(topic.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
    if (topics.length >= limit) break;
  }
  return topics;
}

function homepageTopics(html: string, pageUrl: string, site: SiteIdentity, discoveredAt: string): SiteTopic[] {
  const $ = load(html);
  let baseUrl = pageUrl;
  const declaredBase = $('base[href]').first().attr('href');
  if (declaredBase) {
    try {
      const candidate = new URL(declaredBase, pageUrl).href;
      if (isSameSite(candidate, site)) baseUrl = candidate;
    } catch { /* Ignore an invalid base and resolve links against the fetched page. */ }
  }
  const entries: SitemapEntry[] = [];
  const seen = new Set<string>();
  $('a[href]').slice(0, MAX_HOME_LINKS_SCANNED).each((_index, element) => {
    if (entries.length >= MAX_HOME_TOPICS) return;
    const href = $(element).attr('href');
    if (!href) return;
    try {
      const url = new URL(href, baseUrl).href;
      if (!isEligibleTopicUrl(url, site)) return;
      const key = canonicalUrlKey(url);
      if (!key || seen.has(key)) return;
      seen.add(key);
      const linkText = $(element).text().replace(/\s+/g, ' ').trim();
      const title = (linkText || $(element).attr('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      entries.push({ url, ...(title ? { title } : {}) });
    } catch { /* Unsupported and malformed links are not topic candidates. */ }
  });
  return uniqueTopics(entries, site, discoveredAt, MAX_HOME_TOPICS);
}

async function discoverFromHomepage(
  site: Pick<Site, 'url' | 'domain'>,
  identity: SiteIdentity,
  discoveredAt: string,
  signal: AbortSignal,
  transport: TopicTransport,
  budget: FetchBudget,
): Promise<SiteTopic[]> {
  const home = await fetchBounded(site.url, 'html', identity, signal, transport, budget);
  return homepageTopics(home.body, home.url, identity, discoveredAt);
}

export async function discoverTopics(
  site: Pick<Site, 'url' | 'domain'>,
  signal?: AbortSignal,
  transport?: TopicTransport,
): Promise<TopicDiscoveryResult> {
  return runWithOverallDeadline(signal, DISCOVERY_DEADLINE_MS, async (boundedSignal) => {
    const identity = identifySite(site);
    const activeTransport = transport ?? defaultTransport(identity);
    const budget: FetchBudget = { requests: 0, bytes: 0 };
    const checkedAt = new Date().toISOString();
    const sitemapUrl = new URL('/sitemap.xml', identity.baseUrl).href;
    let root: TopicFetchResult | undefined;
    try {
      root = await fetchBounded(sitemapUrl, 'sitemap', identity, boundedSignal, activeTransport, budget);
    } catch (error) {
      if (!(error instanceof TopicDiscoveryError) || error.code !== 'not_found') throw error;
    }

    let topics: SiteTopic[] = [];
    if (root) {
      if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(root.body)) throw new TopicDiscoveryError('unsafe_response', false);
      if (!/<(?:[\w.-]+:)?(?:sitemapindex|urlset)(?:\s|>)/i.test(root.body) && /<html(?:\s|>)/i.test(root.body)) {
        root = undefined;
      } else {
        const parsed = parseSitemap(root.body, parsedSitemapEntryLimit(root.body));
        if (parsed.kind === 'urlset') {
          topics = uniqueTopics(parsed.entries.slice(0, MAX_TOPIC_URLS), identity, checkedAt, MAX_TOPIC_URLS);
        } else {
          const childUrls: string[] = [];
          for (const entry of parsed.entries) {
            if (!isSameSite(entry.url, identity)) continue;
            childUrls.push(entry.url);
            if (childUrls.length >= MAX_CHILD_SITEMAPS) break;
          }
          const childEntries: SitemapEntry[] = [];
          for (const childUrl of childUrls) {
            let child: TopicFetchResult;
            try {
              child = await fetchBounded(childUrl, 'sitemap', identity, boundedSignal, activeTransport, budget);
            } catch (error) {
              if (error instanceof TopicDiscoveryError && error.code === 'not_found') continue;
              throw error;
            }
            const childMap = parseSitemap(child.body, MAX_TOPIC_URLS - childEntries.length);
            if (childMap.kind !== 'urlset') throw new TopicDiscoveryError('unsafe_response', false);
            childEntries.push(...childMap.entries);
            if (childEntries.length >= MAX_TOPIC_URLS) break;
          }
          topics = uniqueTopics(childEntries.slice(0, MAX_TOPIC_URLS), identity, checkedAt, MAX_TOPIC_URLS);
        }
      }
    }

    if (!topics.length) {
      topics = await discoverFromHomepage(site, identity, checkedAt, boundedSignal, activeTransport, budget);
    }
    if (!topics.length) throw new TopicDiscoveryError('no_candidates', false);
    return { topics, checkedAt };
  });
}

function parsedSitemapEntryLimit(xml: string): number {
  return /<(?:[\w.-]+:)?sitemapindex(?:\s|>)/i.test(xml) ? 20 : MAX_TOPIC_URLS;
}

function normalizedText(input: string): string {
  return input.normalize('NFKC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim();
}

function extractEvidence(html: string, url: string): TopicEvidence {
  const $ = load(html);
  $('script,style,noscript,template,svg,canvas,iframe,nav,header,footer,aside,form,[hidden],[aria-hidden="true"]').remove();
  const title = normalizedText(
    $('meta[property="og:title"]').first().attr('content') ||
    $('title').first().text() ||
    $('h1').first().text(),
  ).slice(0, 200);
  const selections = [$('article').first(), $('main').first(), $('[role="main"]').first(), $('body').first()];
  const fullText = selections.map((selection) => normalizedText(selection.text())).find((text) => text.length > 0) ?? '';
  if (!fullText) throw new TopicDiscoveryError('invalid_topic', false);
  const contentHash = createHash('sha256').update(`${title}\n${fullText}`, 'utf8').digest('hex');
  return { url: canonicalPageUrl(url), title, text: fullText.slice(0, MAX_EVIDENCE_TEXT), contentHash };
}

export async function readTopicEvidence(
  site: Pick<Site, 'url' | 'domain' | 'topics'>,
  topicUrl: string,
  signal?: AbortSignal,
  transport?: TopicTransport,
): Promise<TopicEvidence> {
  return runWithOverallDeadline(signal, EVIDENCE_DEADLINE_MS, async (boundedSignal) => {
    const identity = identifySite(site);
    const requestedKey = canonicalUrlKey(topicUrl);
    const policySite = { url: identity.baseUrl.href, domain: identity.host };
    if (!requestedKey || !isArticleTopicUrl(topicUrl, policySite)) throw new TopicDiscoveryError('invalid_topic', false);
    const approved = site.topics?.find((topic) => canonicalUrlKey(topic.url) === requestedKey);
    if (!approved || !isArticleTopicUrl(approved.url, policySite)) throw new TopicDiscoveryError('invalid_topic', false);
    const budget: FetchBudget = { requests: 0, bytes: 0 };
    const fetched = await fetchBounded(
      approved.url,
      'html',
      identity,
      boundedSignal,
      transport ?? defaultTransport(identity),
      budget,
    );
    if (!isArticleTopicUrl(fetched.url, site)) throw new TopicDiscoveryError('invalid_topic', false);
    return extractEvidence(fetched.body, fetched.url);
  });
}

function normalizeTitle(input: string): string {
  return input.normalize('NFKC').toLocaleLowerCase('und').replace(/[\p{P}\p{S}\s]+/gu, '');
}

const DISCLOSURE_TERMS = /(?:affiliate|affiliation|commission|compensation|sponsored|广告|推广|返佣|佣金|推荐链接|利益披露|免责声明|风险提示|投资有风险)/i;

function contentWithoutDisclosure(input: DraftFingerprintInput): string {
  const source = [input.description ?? '', input.body ?? ''].join('\n');
  return source
    .normalize('NFKC')
    .split(/\n{2,}|(?<=[。！？.!?])(?:\s+|(?=\S))/u)
    .filter((part) => !(part.length <= 500 && DISCLOSURE_TERMS.test(part)))
    .join(' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .toLocaleLowerCase('und');
}

/** Local labels never make an otherwise identical public post unique. */
export function duplicatePublicBody(body:string,history:ReadonlyArray<string>):boolean{
  const normalize=(value:string)=>contentWithoutDisclosure({title:'',body:value.replace(/https?:\/\/\S+/gi,' ')}).replace(/[\p{P}\p{S}\s]+/gu,'');
  const raw=(value:string)=>value.replace(/https?:\/\/\S+/gi,' ').normalize('NFKC').toLocaleLowerCase('und').replace(/[\p{P}\p{S}\s]+/gu,'');
  const exact=raw(body);if(exact.length>=12&&history.some(previous=>raw(previous)===exact))return true;
  const candidate=normalize(body);
  return candidate.length>=12&&history.some(previous=>normalize(previous)===candidate);
}

function contentNgrams(input: DraftFingerprintInput): Set<string> {
  const text = contentWithoutDisclosure(input);
  const grams = new Set<string>();
  for (const sequence of text.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    const chars = [...sequence];
    for (let index = 0; index < chars.length - 1; index++) grams.add(`zh:${chars[index]}${chars[index + 1]}`);
  }
  const words = text.match(/[\p{L}\p{N}]+/gu)?.filter((word) => !/^[\p{Script=Han}]+$/u.test(word)) ?? [];
  const width = words.length >= 3 ? 3 : 2;
  for (let index = 0; index <= words.length - width; index++) {
    grams.add(`w${width}:${words.slice(index, index + width).join(' ')}`);
  }
  return grams;
}

function diceSimilarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const gram of left) if (right.has(gram)) intersection++;
  return (2 * intersection) / (left.size + right.size);
}

function roundedScore(score: number): number {
  return Math.round(score * 10_000) / 10_000;
}

export function duplicateDraft(
  candidate: DraftFingerprintInput,
  history: ReadonlyArray<DraftFingerprintInput>,
): DuplicateDraftResult {
  const candidateUrl = candidate.topicUrl ? canonicalUrlKey(candidate.topicUrl) : undefined;
  const candidateTitle = normalizeTitle(candidate.title);
  const candidateGrams = contentNgrams(candidate);
  let bestScore = 0;
  let bestIndex: number | undefined;
  for (let index = 0; index < history.length; index++) {
    const previous = history[index];
    const previousUrl = previous.topicUrl ? canonicalUrlKey(previous.topicUrl) : undefined;
    if (candidateUrl && previousUrl && candidateUrl === previousUrl) {
      return { duplicate: true, score: 1, matchedIndex: index, reason: 'canonical_url' };
    }
    const previousTitle = normalizeTitle(previous.title);
    if (candidateTitle && candidateTitle === previousTitle) {
      return { duplicate: true, score: 1, matchedIndex: index, reason: 'normalized_title' };
    }
    if (candidateTitle.length >= 6 && previousTitle.length >= 6) {
      const titleScore = diceSimilarity(new Set([...candidateTitle].slice(0, -1).map((char, offset) => char + [...candidateTitle][offset + 1])), new Set([...previousTitle].slice(0, -1).map((char, offset) => char + [...previousTitle][offset + 1])));
      if (titleScore >= 0.9) {
        return { duplicate: true, score: roundedScore(titleScore), matchedIndex: index, reason: 'normalized_title' };
      }
    }
    const previousGrams = contentNgrams(previous);
    const contentScore = candidateGrams.size >= 12 && previousGrams.size >= 12
      ? diceSimilarity(candidateGrams, previousGrams)
      : 0;
    if (contentScore > bestScore) {
      bestScore = contentScore;
      bestIndex = index;
    }
    if (contentScore >= 0.84) {
      return { duplicate: true, score: roundedScore(contentScore), matchedIndex: index, reason: 'content_similarity' };
    }
  }
  return {
    duplicate: false,
    score: roundedScore(bestScore),
    ...(bestIndex === undefined ? {} : { matchedIndex: bestIndex }),
  };
}
