import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { load } from 'cheerio';
import type { Category, LinkResult } from '../shared/types.js';

const MAX_HTML_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

export interface WebsiteAnalysis {
  url: string;
  domain: string;
  name: string;
  description: string;
  category: Category;
  language: string;
}

export interface PublicFetchDependencies {
  resolve: (host: string) => Promise<Array<{ address: string; family: number }>>;
  request: (url: URL, pinned: { address: string; family: number }, signal?: AbortSignal) => Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>;
}

export function nextHtmlByteCount(current: number, chunkBytes: number): number {
  const next = current + chunkBytes;
  if (!Number.isSafeInteger(next) || next > MAX_HTML_BYTES) throw new Error('HTML response exceeds size limit');
  return next;
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  if (lower.includes('.')) return false; // Includes IPv4-mapped and other IPv4 transition forms.
  const first = Number.parseInt(lower.split(':')[0] || '0', 16);
  // Only global unicast. Reject documentation, Teredo, 6to4, and NAT64 ranges.
  if (first < 0x2000 || first > 0x3fff || first === 0x2002) return false;
  if (/^2001:0?db8(?::|$)/.test(lower)) return false;
  if (/^2001:0{0,4}(?::|$)/.test(lower)) return false;
  if (lower.startsWith('64:ff9b:')) return false;
  return true;
}

export function normalizePublicUrl(input: string): URL {
  const raw = input.trim();
  const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) URLs are supported');
  if (parsed.username || parsed.password) throw new Error('URL credentials are not allowed');
  if (parsed.port && parsed.port !== (parsed.protocol === 'https:' ? '443' : '80')) {
    throw new Error('Non-standard ports are not allowed');
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') ||
      host.endsWith('.test') || host.endsWith('.invalid') ||
      (!isIP(host) && !host.includes('.'))) {
    throw new Error('URL does not name a public host');
  }
  if (isIP(host) && !isPublicIpAddress(host)) throw new Error('Private or reserved IP address');
  parsed.hash = '';
  return parsed;
}

// The injected transport is for deterministic tests. Production callers always use
// the pinned native request below; host and DNS checks run in both paths.
export async function fetchPublicHtml(input: string, signal?: AbortSignal, dependencies?: PublicFetchDependencies): Promise<{ url: string; html: string }> {
  let current = normalizePublicUrl(input);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    if (signal?.aborted) throw new Error('Request aborted');
    const host = current.hostname.replace(/^\[|\]$/g, '');
    let addresses: Array<{ address: string; family: number }>;
    if (isIP(host)) {
      addresses = [{ address: host, family: isIP(host) }];
    } else {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        addresses = await Promise.race([
          dependencies ? dependencies.resolve(host) : lookup(host, { all: true, verbatim: true }),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error('DNS lookup timed out')), REQUEST_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (deadline) clearTimeout(deadline);
      }
    }
    if (signal?.aborted) throw new Error('Request aborted');
    if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) {
      throw new Error('Host resolves to a private or reserved address');
    }
    // Pin the validated address in the socket lookup, so a later DNS change cannot
    // switch the connection to a private host between validation and the request.
    const pinned = addresses[0];
    const transport = current.protocol === 'https:' ? https : http;
    const response = dependencies ? await dependencies.request(current, pinned, signal) : await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const request = transport.request(current, {
        method: 'GET',
        lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
        headers: { 'accept': 'text/html,application/xhtml+xml', 'accept-encoding': 'identity', 'user-agent': 'Linkflow/1.0 (+public-link-verification)' },
      }, (reply) => {
        const status = reply.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          resolve({ status, headers: reply.headers, body: Buffer.alloc(0) });
          reply.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        reply.on('data', (chunk: Buffer) => {
          try { bytes = nextHtmlByteCount(bytes, chunk.length); }
          catch (error) { request.destroy(error as Error); return; }
          chunks.push(chunk);
        });
        reply.on('end', () => resolve({ status, headers: reply.headers, body: Buffer.concat(chunks) }));
        reply.on('error', reject);
      });
      const deadline = setTimeout(() => request.destroy(new Error('Request timed out')), REQUEST_TIMEOUT_MS);
      request.on('close', () => clearTimeout(deadline));
      request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('Request timed out')));
      request.on('error', reject);
      if (signal) signal.addEventListener('abort', () => request.destroy(new Error('Request aborted')), { once: true });
      request.end();
    });
    nextHtmlByteCount(0, response.body.length);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirect === MAX_REDIRECTS) throw new Error('Too many redirects');
      const location = response.headers.location;
      if (!location) throw new Error('Redirect has no location');
      current = normalizePublicUrl(new URL(location, current).href);
      continue;
    }
    if (response.status !== 200) throw new Error(`Public page returned HTTP ${response.status}`);
    const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
    if (!/^(text\/html|application\/xhtml\+xml)(;|\s|$)/.test(contentType)) {
      throw new Error('Public page is not HTML');
    }
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
      throw new Error('Compressed response is unsupported');
    }
    return { url: current.href, html: response.body.toString('utf8') };
  }
  throw new Error('Too many redirects');
}

function clean(value: string | undefined, max = 240): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const CATEGORY_TERMS: Record<Exclude<Category, 'general'>, RegExp> = {
  ai: /\b(artificial intelligence|machine learning|\bai\b|llm|generative)\b/i,
  developer: /\b(developer|programming|code|coding|api|open source|github)\b/i,
  design: /\b(design|designer|illustration|typography|ux|ui)\b/i,
  software: /\b(software|app|saas|platform|tool|productivity)\b/i,
  business: /\b(business|startup|marketing|commerce|crm|agency)\b/i,
  content: /\b(blog|writing|creator|content|publishing|newsletter)\b/i,
  education: /\b(education|learning|course|school|training|tutorial)\b/i,
  finance: /\b(finance|financial|bank|invest|trading|insurance)\b/i,
};

export function analyzeWebsiteHtml(html: string, pageUrl: string): WebsiteAnalysis {
  const $ = load(html);
  const meta = (key: string) => clean($(`meta[name="${key}"], meta[property="${key}"]`).first().attr('content'));
  const page = normalizePublicUrl(pageUrl);
  const title = clean(meta('og:site_name') || meta('application-name') || $('title').first().text(), 100);
  const name = title.replace(/\s+[|–—-]\s+.+$/, '') || page.hostname.replace(/^www\./, '');
  const description = clean(meta('description') || meta('og:description') || $('p').first().text());
  const language = clean($('html').attr('lang') || meta('og:locale'), 20).replace('_', '-').toLowerCase() || 'und';
  const keywords = [title, description, meta('keywords')].join(' ');
  const category = (Object.entries(CATEGORY_TERMS).find(([, pattern]) => pattern.test(keywords))?.[0] ?? 'general') as Category;
  return { url: page.href, domain: page.hostname.replace(/^www\./, ''), name, description, category, language };
}

export async function analyzeWebsite(domain: string, signal?: AbortSignal): Promise<WebsiteAnalysis> {
  const { url, html } = await fetchPublicHtml(domain, signal);
  return analyzeWebsiteHtml(html, url);
}

function normalizedHost(input: string): string {
  return normalizePublicUrl(input).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

function belongsToSource(actualUrl: string, expectedDomain: string): boolean {
  const actual = normalizedHost(actualUrl);
  const expected = normalizedHost(expectedDomain);
  if (actual === expected) return true;
  if (expected === 'substack.com' && actual.endsWith('.substack.com')) return true;
  if (expected === 'artstation.com' && actual.endsWith('.artstation.com')) return true;
  if (expected === 'hashnode.com' && actual.endsWith('.hashnode.dev')) return true;
  return false;
}

export function findDirectLink(html: string, pageUrl: string, targetUrl: string): LinkResult {
  const targetHost = normalizedHost(targetUrl);
  const $ = load(html);
  const baseHref = $('base[href]').first().attr('href');
  const base = baseHref ? new URL(baseHref, pageUrl).href : pageUrl;
  $('template, script, style, noscript, head').remove();
  let result: LinkResult | undefined;
  $('a[href]').each((_index, element) => {
    if (result) return;
    if ($(element).closest('template, head').length) return;
    try {
      const destination = new URL($(element).attr('href')!, base);
      if (!['https:', 'http:'].includes(destination.protocol)) return;
      if (normalizedHost(destination.href) !== targetHost) return;
      result = {
        found: true,
        url: pageUrl,
        rel: clean($(element).attr('rel')).toLowerCase(),
        reason: 'Public HTML contains a direct anchor to the target host; indexing is not verified',
      };
    } catch { /* Ignore malformed anchors. */ }
  });
  return result ?? { found: false, url: pageUrl, rel: '', reason: 'No direct anchor to the target host in public HTML' };
}

export async function verifyLink(publicUrl: string, targetUrl: string, expectedDomain?: string, signal?: AbortSignal): Promise<LinkResult> {
  let sourceUrl = publicUrl;
  try {
    sourceUrl = normalizePublicUrl(publicUrl).href;
    normalizedHost(targetUrl);
    if (expectedDomain && !belongsToSource(sourceUrl, expectedDomain)) {
      return { found: false, url: sourceUrl, rel: '', reason: 'Public page is outside the expected channel domain' };
    }
    const fetched = await fetchPublicHtml(sourceUrl, signal);
    if (expectedDomain && !belongsToSource(fetched.url, expectedDomain)) {
      return { found: false, url: fetched.url, rel: '', reason: 'Public page redirected outside the expected channel domain' };
    }
    return findDirectLink(fetched.html, fetched.url, targetUrl);
  } catch (error) {
    return { found: false, url: sourceUrl, rel: '', reason: error instanceof Error ? error.message : 'Verification failed' };
  }
}
