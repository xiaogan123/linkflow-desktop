import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { load } from 'cheerio';
import {applyDeclaredArticleVisibility,elementConcealed,publicPagePolicy,withPageNofollow} from './article-visibility';
import type { Category, LinkResult } from '../shared/types.js';

const MAX_HTML_BYTES = 1_000_000;
const MAX_DOH_BYTES = 65_536;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const DOH_HOST = 'cloudflare-dns.com';
const DOH_ADDRESS = '1.1.1.1';

interface ResolvedAddress {
  address: string;
  family: number;
}

export interface WebsiteAnalysis {
  url: string;
  domain: string;
  name: string;
  description: string;
  category: Category;
  language: string;
}

export interface PublicFetchDependencies {
  resolve: (host: string) => Promise<ResolvedAddress[]>;
  resolvePublic?: (host: string, signal?: AbortSignal) => Promise<ResolvedAddress[]>;
  request: (url: URL, pinned: ResolvedAddress, signal?: AbortSignal) => Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>;
  /** Tests may shorten deadlines without changing production network policy. */
  timeoutMs?: number;
}

export interface PublicTextFetchOptions {
  /** Sitemaps may be served as application/xml or text/xml. HTML remains accepted. */
  allowXml?: boolean;
  /** Runs before a redirect target is resolved or requested. */
  allowRedirect?: (from: URL, to: URL) => boolean;
}

export interface PublicTextFetchResult {
  url: string;
  text: string;
  contentType: string;
  bytes: number;
  robotsHeader?: string;
}

export interface PublicResourceFetchOptions {
  maxBytes: number;
  accept: string;
  mediaTypes: readonly string[];
  redirect: 'error' | 'follow';
  /** Runs before a followed redirect target is resolved or requested. */
  allowRedirect?: (from: URL, to: URL) => boolean;
}

export interface PublicResourceFetchResult {
  url: string;
  status: number;
  headers: Readonly<Record<string,string>>;
  mediaType: string;
  body: Buffer;
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

export function isProxyFakeDnsAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 198 && (b === 18 || b === 19);
}

export function createPinnedLookup(pinned: ResolvedAddress): LookupFunction {
  return (_host, options, callback) => {
    if (options.all) {
      callback(null, [pinned]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

function runWithDeadline<T>(
  operation: (boundedSignal: AbortSignal) => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Request aborted'));
      return;
    }
    const controller = new AbortController();
    let settled = false;
    let deadline: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
    };
    const succeed = (value: T) => {
      if (settled) return;
      cleanup();
      resolve(value);
      controller.abort();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      cleanup();
      reject(error);
      controller.abort();
    };
    const abort = () => {
      fail(new Error('Request aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    deadline = setTimeout(() => fail(new Error(timeoutMessage)), timeoutMs);
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(succeed, fail);
  });
}

interface DnsJsonAnswer {
  type?: unknown;
  data?: unknown;
}

interface DnsJsonResponse {
  Status?: unknown;
  TC?: unknown;
  Answer?: unknown;
}

export function parsePublicDnsResponse(body: Buffer): ResolvedAddress[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('Encrypted public DNS returned invalid JSON');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Encrypted public DNS returned a malformed response');
  }
  const payload = decoded as DnsJsonResponse;
  if (!Number.isInteger(payload.Status) || payload.Status !== 0) {
    throw new Error(`Encrypted public DNS returned status ${String(payload.Status)}`);
  }
  if (payload.TC === true) throw new Error('Encrypted public DNS response was truncated');
  if (payload.Answer !== undefined && !Array.isArray(payload.Answer)) {
    throw new Error('Encrypted public DNS returned malformed answers');
  }

  const addresses: ResolvedAddress[] = [];
  for (const raw of (payload.Answer ?? []) as DnsJsonAnswer[]) {
    if (!raw || typeof raw !== 'object') throw new Error('Encrypted public DNS returned a malformed answer');
    if (raw.type !== 1 && raw.type !== 28) continue; // CNAME and other non-address answers are expected.
    if (typeof raw.data !== 'string') throw new Error('Encrypted public DNS returned a malformed address');
    const family = isIP(raw.data);
    if (family !== (raw.type === 1 ? 4 : 6) || !isPublicIpAddress(raw.data)) {
      throw new Error('Encrypted public DNS returned a private, reserved, or malformed address');
    }
    addresses.push({ address: raw.data, family });
  }
  return addresses;
}

function queryPublicDns(host: string, type: 'A' | 'AAAA', signal: AbortSignal): Promise<ResolvedAddress[]> {
  const url = new URL(`https://${DOH_HOST}/dns-query`);
  url.searchParams.set('name', host);
  url.searchParams.set('type', type);
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET',
      minVersion: 'TLSv1.2',
      servername: DOH_HOST,
      lookup: createPinnedLookup({ address: DOH_ADDRESS, family: 4 }),
      headers: {
        accept: 'application/dns-json',
        'accept-encoding': 'identity',
        'user-agent': 'Linkflow/1.0 (+public-link-verification)',
      },
    }, (reply) => {
      if (reply.statusCode !== 200) {
        reply.resume();
        reject(new Error(`Encrypted public DNS returned HTTP ${reply.statusCode ?? 0}`));
        return;
      }
      const contentType = String(reply.headers['content-type'] ?? '').toLowerCase();
      if (!/^application\/dns-json(?:;|\s|$)/.test(contentType)) {
        reply.resume();
        reject(new Error('Encrypted public DNS returned an unexpected content type'));
        return;
      }
      if (reply.headers['content-encoding'] && reply.headers['content-encoding'] !== 'identity') {
        reply.resume();
        reject(new Error('Compressed encrypted DNS response is unsupported'));
        return;
      }
      const declaredHeader = reply.headers['content-length'];
      const declaredLength = Number(declaredHeader ?? 0);
      if (declaredHeader !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_DOH_BYTES)) {
        reply.destroy(new Error('Encrypted public DNS response exceeds size limit'));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      reply.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (!Number.isSafeInteger(bytes) || bytes > MAX_DOH_BYTES) {
          request.destroy(new Error('Encrypted public DNS response exceeds size limit'));
          return;
        }
        chunks.push(chunk);
      });
      reply.on('end', () => {
        try { resolve(parsePublicDnsResponse(Buffer.concat(chunks))); }
        catch (error) { reject(error); }
      });
      reply.on('error', reject);
    });
    const deadline = setTimeout(() => request.destroy(new Error('Encrypted public DNS timed out')), REQUEST_TIMEOUT_MS);
    const abort = () => request.destroy(new Error('Request aborted'));
    signal.addEventListener('abort', abort, { once: true });
    request.on('close', () => {
      clearTimeout(deadline);
      signal.removeEventListener('abort', abort);
    });
    request.on('error', reject);
    request.end();
  });
}

async function resolveWithEncryptedPublicDns(host: string, signal: AbortSignal): Promise<ResolvedAddress[]> {
  const [ipv4, ipv6] = await Promise.all([
    queryPublicDns(host, 'A', signal),
    queryPublicDns(host, 'AAAA', signal),
  ]);
  const unique = new Map<string, ResolvedAddress>();
  for (const item of [...ipv4, ...ipv6]) unique.set(item.address, item);
  if (!unique.size) throw new Error('Encrypted public DNS returned no public addresses');
  return [...unique.values()];
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

function normalizedResponseHeaders(headers:http.IncomingHttpHeaders):Record<string,string>{
  const result:Record<string,string>={};
  for(const [name,value] of Object.entries(headers)){
    if(value===undefined)continue;
    result[name.toLowerCase()]=Array.isArray(value)?value.join(','):String(value);
  }
  return result;
}

function declaredResourceLength(headers:Readonly<Record<string,string>>,maximum:number):number|undefined{
  const raw=headers['content-length'];if(raw===undefined)return;
  if(!/^[0-9]+$/.test(raw))throw Error('Public resource has invalid declared size');
  const value=Number(raw);
  if(!Number.isSafeInteger(value)||value>maximum)throw Error('Public resource exceeds size limit');
  return value;
}

function boundedResourceMaximum(value:number):number{
  if(!Number.isSafeInteger(value)||value<1||value>MAX_HTML_BYTES)throw Error('Public resource size limit is invalid');
  return value;
}

function nativePublicRequest(url:URL,pinned:ResolvedAddress,signal:AbortSignal,maximum:number,accept:string):Promise<{status:number;headers:http.IncomingHttpHeaders;body:Buffer}>{
  const transport=url.protocol==='https:'?https:http;
  return new Promise((resolve,reject)=>{
    const request=transport.request(url,{method:'GET',lookup:createPinnedLookup(pinned),headers:{accept,'accept-encoding':'identity','user-agent':'Linkflow/1.0 (+public-link-verification)'}},reply=>{
      const status=reply.statusCode??0;
      if([301,302,303,307,308].includes(status)){resolve({status,headers:reply.headers,body:Buffer.alloc(0)});reply.destroy();return}
      const normalized=normalizedResponseHeaders(reply.headers);
      try{declaredResourceLength(normalized,maximum)}catch(error){request.destroy(error as Error);return}
      const chunks:Buffer[]=[];let bytes=0;
      reply.on('data',(chunk:Buffer)=>{
        bytes+=chunk.length;
        if(!Number.isSafeInteger(bytes)||bytes>maximum){request.destroy(new Error('Public resource exceeds size limit'));return}
        chunks.push(chunk);
      });
      reply.on('end',()=>resolve({status,headers:reply.headers,body:Buffer.concat(chunks)}));
      reply.on('error',reject);
    });
    const deadline=setTimeout(()=>request.destroy(new Error('Request timed out')),REQUEST_TIMEOUT_MS);
    request.on('close',()=>clearTimeout(deadline));
    request.setTimeout(REQUEST_TIMEOUT_MS,()=>request.destroy(new Error('Request timed out')));
    request.on('error',reject);
    const abort=()=>request.destroy(new Error('Request aborted'));
    signal.addEventListener('abort',abort,{once:true});
    request.on('close',()=>signal.removeEventListener('abort',abort));
    request.end();
  });
}

/**
 * Guarded public resource reader. DNS validation and socket pinning are shared
 * with fetchPublicText; callers receive bounded raw bytes and cannot add request
 * credentials or arbitrary headers.
 */
export async function fetchPublicResourceBytes(input:string,signal:AbortSignal|undefined,dependencies:PublicFetchDependencies|undefined,options:PublicResourceFetchOptions):Promise<PublicResourceFetchResult>{
  let current=normalizePublicUrl(input);
  const maximum=boundedResourceMaximum(options.maxBytes),timeoutMs=dependencies?.timeoutMs??REQUEST_TIMEOUT_MS;
  if(!/^[\x20-\x7e]{1,512}$/.test(options.accept)||/[\r\n]/.test(options.accept)
    ||!options.mediaTypes.length||options.mediaTypes.some(value=>value!==value.toLowerCase()||!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value)))throw Error('Public resource media policy is invalid');
  for(let redirect=0;redirect<=MAX_REDIRECTS;redirect++){
    if(signal?.aborted)throw Error('Request aborted');
    const host=current.hostname.replace(/^\[|\]$/g,'');let addresses:ResolvedAddress[];
    if(isIP(host))addresses=[{address:host,family:isIP(host)}];
    else{
      addresses=await runWithDeadline(()=>dependencies?dependencies.resolve(host):lookup(host,{all:true,verbatim:true}),signal,timeoutMs,'DNS lookup timed out');
      if(addresses.length>0&&addresses.every(({address})=>isProxyFakeDnsAddress(address))){
        addresses=await runWithDeadline(boundedSignal=>dependencies?.resolvePublic?dependencies.resolvePublic(host,boundedSignal):resolveWithEncryptedPublicDns(host,boundedSignal),signal,timeoutMs,'Encrypted public DNS timed out');
      }
    }
    if(signal?.aborted)throw Error('Request aborted');
    if(!addresses.length||addresses.some(({address})=>!isPublicIpAddress(address)))throw Error('Host resolves to a private or reserved address');
    const pinned=addresses[0];
    const response=await runWithDeadline(boundedSignal=>dependencies?dependencies.request(current,pinned,boundedSignal):nativePublicRequest(current,pinned,boundedSignal,maximum,options.accept),signal,timeoutMs,'Request timed out');
    if(!Number.isInteger(response.status)||response.status<100||response.status>599||!Buffer.isBuffer(response.body))throw Error('Public resource response is malformed');
    const headers=normalizedResponseHeaders(response.headers),isRedirect=[301,302,303,307,308].includes(response.status);
    if(isRedirect){
      if(options.redirect==='error')throw Error('Redirect target is not allowed');
      if(redirect===MAX_REDIRECTS)throw Error('Too many redirects');
      const location=headers.location;if(!location)throw Error('Redirect has no location');
      const next=normalizePublicUrl(new URL(location,current).href);
      if(options.allowRedirect&&!options.allowRedirect(current,next))throw Error('Redirect target is not allowed');
      current=next;continue;
    }
    declaredResourceLength(headers,maximum);
    if(response.body.length>maximum)throw Error('Public resource exceeds size limit');
    if(headers['content-encoding']&&headers['content-encoding'].toLowerCase()!=='identity')throw Error('Compressed response is unsupported');
    const mediaType=(headers['content-type']??'').split(';',1)[0].trim().toLowerCase();
    if(response.status===200&&!options.mediaTypes.includes(mediaType))throw Error('Public resource media type is not accepted');
    return {url:current.href,status:response.status,headers,mediaType,body:Buffer.from(response.body)};
  }
  throw Error('Too many redirects');
}

export async function fetchPublicText(
  input:string,
  signal?:AbortSignal,
  dependencies?:PublicFetchDependencies,
  options:PublicTextFetchOptions={},
):Promise<PublicTextFetchResult>{
  let resource:PublicResourceFetchResult;
  try{
    resource=await fetchPublicResourceBytes(input,signal,dependencies,{
      maxBytes:MAX_HTML_BYTES,accept:options.allowXml?'text/html,application/xhtml+xml,application/xml,text/xml':'text/html,application/xhtml+xml',
      mediaTypes:options.allowXml?['text/html','application/xhtml+xml','application/xml','text/xml']:['text/html','application/xhtml+xml'],
      redirect:'follow',allowRedirect:options.allowRedirect,
    });
  }catch(error){
    if(error instanceof Error&&error.message==='Public resource media type is not accepted')throw Error(options.allowXml?'Public resource is not HTML or XML':'Public page is not HTML');
    throw error;
  }
  if(resource.status!==200)throw Error(`Public page returned HTTP ${resource.status}`);
  return {url:resource.url,text:resource.body.toString('utf8'),contentType:(resource.headers['content-type']??'').toLowerCase(),bytes:resource.body.length,robotsHeader:resource.headers['x-robots-tag']??''};
}

export async function fetchPublicHtml(input: string, signal?: AbortSignal, dependencies?: PublicFetchDependencies): Promise<{ url: string; html: string }> {
  const result = await fetchPublicText(input, signal, dependencies);
  return { url: result.url, html: result.text };
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

export function belongsToSource(actualUrl: string, expectedDomain: string): boolean {
  const actual = normalizedHost(actualUrl);
  const expected = normalizedHost(expectedDomain);
  if (actual === expected) return true;
  // Only vetted hosted-publishing services accept publication subdomains.
  // Other channel domains retain exact-host matching, including after redirects.
  const hostedSources = new Set(['substack.com','artstation.com','beehiiv.com','kit.com','wordpress.com','ghost.io','tumblr.com','blogspot.com']);
  if (hostedSources.has(expected) && actual.endsWith('.'+expected)) return true;
  if (expected === 'hashnode.com' && actual.endsWith('.hashnode.dev')) return true;
  return false;
}

export function findDirectLink(html: string, pageUrl: string, targetUrl: string, robotsHeader=''): LinkResult {
  const targetHost = normalizedHost(targetUrl);
  const $ = load(html);
  applyDeclaredArticleVisibility($);
  const policy=publicPagePolicy($,pageUrl,robotsHeader);
  if(!policy.valid)return {found:false,outcome:'invalid',url:pageUrl,rel:'unknown',reason:'Public page has an indexing restriction, redirect or conflicting canonical; publication is retained but not counted as a qualified source'};
  const baseHref = $('base[href]').first().attr('href');
  const base = baseHref ? new URL(baseHref, pageUrl).href : pageUrl;
  $('template, script, style, noscript, head').remove();
  let result: LinkResult | undefined;
  $('a[href]').each((_index, element) => {
    if (result) return;
    if ($(element).add($(element).parents()).toArray().some(node=>elementConcealed($,node))) return;
    const visible=$(element).clone();
    visible.find('*').toArray().filter(node=>elementConcealed($,node)).forEach(node=>$(node).remove());
    if(!visible.text().trim()&&!visible.find('img[alt]').toArray().some(node=>!!$(node).attr('alt')?.trim()))return;
    try {
      const destination = new URL($(element).attr('href')!, base);
      if (!['https:', 'http:'].includes(destination.protocol)) return;
      if (normalizedHost(destination.href) !== targetHost) return;
      result = {
        found: true,
        outcome: 'found',
        url: pageUrl,
        rel: withPageNofollow(clean($(element).attr('rel')),policy.nofollow),
        reason: 'Public HTML contains a direct anchor to the target host; indexing is not verified',
      };
    } catch { /* Ignore malformed anchors. */ }
  });
  return result ?? { found: false, outcome: 'absent', url: pageUrl, rel: '', reason: 'No direct anchor to the target host in public HTML' };
}

export async function verifyLink(publicUrl: string, targetUrl: string, expectedDomain?: string, signal?: AbortSignal, dependencies?: PublicFetchDependencies): Promise<LinkResult> {
  let sourceUrl = publicUrl;
  try {
    sourceUrl = normalizePublicUrl(publicUrl).href;
    normalizedHost(targetUrl);
    if (expectedDomain && !belongsToSource(sourceUrl, expectedDomain)) {
      return { found: false, outcome: 'invalid', url: sourceUrl, rel: '', reason: 'Public page is outside the expected channel domain' };
    }
  } catch (error) {
    return { found: false, outcome: 'invalid', url: sourceUrl, rel: '', reason: error instanceof Error ? error.message : 'Invalid verification input' };
  }
  try {
    const fetched = await fetchPublicText(sourceUrl, signal, dependencies);
    if (expectedDomain && !belongsToSource(fetched.url, expectedDomain)) {
      return { found: false, outcome: 'invalid', url: fetched.url, rel: '', reason: 'Public page redirected outside the expected channel domain' };
    }
    return findDirectLink(fetched.text, fetched.url, targetUrl,fetched.robotsHeader);
  } catch (error) {
    return { found: false, outcome: 'unreachable', url: sourceUrl, rel: '', reason: error instanceof Error ? error.message : 'Verification failed' };
  }
}
