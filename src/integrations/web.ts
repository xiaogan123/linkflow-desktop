import {copyButtonCode,strictSiteCodes} from '../shared/referral-policy';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { load } from 'cheerio';
import {applyDeclaredArticleVisibility,articleTextStyleVisibility,elementConcealed,pageRobotsDirectives,publicPagePolicy,withPageNofollow} from './article-visibility';
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
  referralCodes?:string[];
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
  request: (url: URL, pinned: ResolvedAddress, signal?: AbortSignal) => Promise<{ status: number; headers: http.IncomingHttpHeaders; rawHeaders?: string[]; body: Buffer }>;
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

export type PublicFetchErrorCode =
  | 'aborted'
  | 'timeout'
  | 'invalid_request'
  | 'unsafe_address'
  | 'redirect_invalid'
  | 'size_limit'
  | 'media_type'
  | 'malformed_response'
  | 'http_status'
  | 'network';

/** Machine-readable public-fetch failure; message remains display/diagnostic text only. */
export class PublicFetchError extends Error {
  constructor(readonly code:PublicFetchErrorCode,message:string,readonly status?:number,options?:ErrorOptions){
    super(message,options);this.name='PublicFetchError';
  }
}

export function nextHtmlByteCount(current: number, chunkBytes: number): number {
  const next = current + chunkBytes;
  if (!Number.isSafeInteger(next) || next > MAX_HTML_BYTES) throw new PublicFetchError('size_limit','HTML response exceeds size limit');
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
      reject(new PublicFetchError('aborted','Request aborted'));
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
      fail(new PublicFetchError('aborted','Request aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    deadline = setTimeout(() => fail(new PublicFetchError('timeout',timeoutMessage)), timeoutMs);
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
    throw new PublicFetchError('malformed_response','Encrypted public DNS returned invalid JSON');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new PublicFetchError('malformed_response','Encrypted public DNS returned a malformed response');
  }
  const payload = decoded as DnsJsonResponse;
  if (!Number.isInteger(payload.Status) || payload.Status !== 0) {
    throw new PublicFetchError('malformed_response',`Encrypted public DNS returned status ${String(payload.Status)}`);
  }
  if (payload.TC === true) throw new PublicFetchError('malformed_response','Encrypted public DNS response was truncated');
  if (payload.Answer !== undefined && !Array.isArray(payload.Answer)) {
    throw new PublicFetchError('malformed_response','Encrypted public DNS returned malformed answers');
  }

  const addresses: ResolvedAddress[] = [];
  for (const raw of (payload.Answer ?? []) as DnsJsonAnswer[]) {
    if (!raw || typeof raw !== 'object') throw new PublicFetchError('malformed_response','Encrypted public DNS returned a malformed answer');
    if (raw.type !== 1 && raw.type !== 28) continue; // CNAME and other non-address answers are expected.
    if (typeof raw.data !== 'string') throw new PublicFetchError('malformed_response','Encrypted public DNS returned a malformed address');
    const family = isIP(raw.data);
    if (family !== (raw.type === 1 ? 4 : 6) || !isPublicIpAddress(raw.data)) {
      throw new PublicFetchError('unsafe_address','Encrypted public DNS returned a private, reserved, or malformed address');
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
        'user-agent': 'Mozilla/5.0',
      },
    }, (reply) => {
      if (reply.statusCode !== 200) {
        reply.resume();
        reject(new PublicFetchError('network',`Encrypted public DNS returned HTTP ${reply.statusCode ?? 0}`,reply.statusCode ?? 0));
        return;
      }
      const contentType = String(reply.headers['content-type'] ?? '').toLowerCase();
      if (!/^application\/dns-json(?:;|\s|$)/.test(contentType)) {
        reply.resume();
        reject(new PublicFetchError('media_type','Encrypted public DNS returned an unexpected content type'));
        return;
      }
      if (reply.headers['content-encoding'] && reply.headers['content-encoding'] !== 'identity') {
        reply.resume();
        reject(new PublicFetchError('malformed_response','Compressed encrypted DNS response is unsupported'));
        return;
      }
      const declaredHeader = reply.headers['content-length'];
      const declaredLength = Number(declaredHeader ?? 0);
      if (declaredHeader !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_DOH_BYTES)) {
        reply.destroy(new PublicFetchError('size_limit','Encrypted public DNS response exceeds size limit'));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      reply.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (!Number.isSafeInteger(bytes) || bytes > MAX_DOH_BYTES) {
          request.destroy(new PublicFetchError('size_limit','Encrypted public DNS response exceeds size limit'));
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
    const deadline = setTimeout(() => request.destroy(new PublicFetchError('timeout','Encrypted public DNS timed out')), REQUEST_TIMEOUT_MS);
    const abort = () => request.destroy(new PublicFetchError('aborted','Request aborted'));
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
  if (!unique.size) throw new PublicFetchError('network','Encrypted public DNS returned no public addresses');
  return [...unique.values()];
}

export function normalizePublicUrl(input: string): URL {
  const raw = input.trim();
  const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new PublicFetchError('invalid_request','Only HTTP(S) URLs are supported');
  if (parsed.username || parsed.password) throw new PublicFetchError('invalid_request','URL credentials are not allowed');
  if (parsed.port && parsed.port !== (parsed.protocol === 'https:' ? '443' : '80')) {
    throw new PublicFetchError('invalid_request','Non-standard ports are not allowed');
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') ||
      host.endsWith('.test') || host.endsWith('.invalid') ||
      (!isIP(host) && !host.includes('.'))) {
    throw new PublicFetchError('unsafe_address','URL does not name a public host');
  }
  if (isIP(host) && !isPublicIpAddress(host)) throw new PublicFetchError('unsafe_address','Private or reserved IP address');
  parsed.hash = '';
  return parsed;
}

function normalizedResponseHeaders(headers:http.IncomingHttpHeaders,rawHeaders?:readonly string[]):Record<string,string>{
  const result:Record<string,string>={};
  for(const [name,value] of Object.entries(headers)){
    if(value===undefined)continue;
    result[name.toLowerCase()]=Array.isArray(value)?value.join(name.toLowerCase()==='x-robots-tag'?'\n':','):String(value);
  }
  if(rawHeaders){
    const robots:string[]=[];
    for(let index=0;index<rawHeaders.length;index+=2)if(rawHeaders[index].toLowerCase()==='x-robots-tag')robots.push(rawHeaders[index+1]);
    if(robots.length)result['x-robots-tag']=robots.join('\n');
  }
  return result;
}

function declaredResourceLength(headers:Readonly<Record<string,string>>,maximum:number):number|undefined{
  const raw=headers['content-length'];if(raw===undefined)return;
  if(!/^[0-9]+$/.test(raw))throw new PublicFetchError('malformed_response','Public resource has invalid declared size');
  const value=Number(raw);
  if(!Number.isSafeInteger(value)||value>maximum)throw new PublicFetchError('size_limit','Public resource exceeds size limit');
  return value;
}

function boundedResourceMaximum(value:number):number{
  if(!Number.isSafeInteger(value)||value<1||value>MAX_HTML_BYTES)throw new PublicFetchError('invalid_request','Public resource size limit is invalid');
  return value;
}

function nativePublicRequest(url:URL,pinned:ResolvedAddress,signal:AbortSignal,maximum:number,accept:string):Promise<{status:number;headers:http.IncomingHttpHeaders;rawHeaders?:string[];body:Buffer}>{
  const transport=url.protocol==='https:'?https:http;
  return new Promise((resolve,reject)=>{
    const request=transport.request(url,{method:'GET',lookup:createPinnedLookup(pinned),headers:{accept,'accept-encoding':'identity','user-agent':'Mozilla/5.0'}},reply=>{
      const status=reply.statusCode??0;
      if([301,302,303,307,308].includes(status)){resolve({status,headers:reply.headers,rawHeaders:reply.rawHeaders,body:Buffer.alloc(0)});reply.destroy();return}
      const normalized=normalizedResponseHeaders(reply.headers);
      try{declaredResourceLength(normalized,maximum)}catch(error){request.destroy(error as Error);return}
      const chunks:Buffer[]=[];let bytes=0;
      reply.on('data',(chunk:Buffer)=>{
        bytes+=chunk.length;
        if(!Number.isSafeInteger(bytes)||bytes>maximum){request.destroy(new PublicFetchError('size_limit','Public resource exceeds size limit'));return}
        chunks.push(chunk);
      });
      reply.on('end',()=>resolve({status,headers:reply.headers,rawHeaders:reply.rawHeaders,body:Buffer.concat(chunks)}));
      reply.on('error',reject);
    });
    const deadline=setTimeout(()=>request.destroy(new PublicFetchError('timeout','Request timed out')),REQUEST_TIMEOUT_MS);
    request.on('close',()=>clearTimeout(deadline));
    request.setTimeout(REQUEST_TIMEOUT_MS,()=>request.destroy(new PublicFetchError('timeout','Request timed out')));
    request.on('error',reject);
    const abort=()=>request.destroy(new PublicFetchError('aborted','Request aborted'));
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
    ||!options.mediaTypes.length||options.mediaTypes.some(value=>value!==value.toLowerCase()||!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value)))throw new PublicFetchError('invalid_request','Public resource media policy is invalid');
  for(let redirect=0;redirect<=MAX_REDIRECTS;redirect++){
    if(signal?.aborted)throw new PublicFetchError('aborted','Request aborted');
    const host=current.hostname.replace(/^\[|\]$/g,'');let addresses:ResolvedAddress[];
    if(isIP(host))addresses=[{address:host,family:isIP(host)}];
    else{
      addresses=await runWithDeadline(()=>dependencies?dependencies.resolve(host):lookup(host,{all:true,verbatim:true}),signal,timeoutMs,'DNS lookup timed out');
      if(addresses.length>0&&addresses.every(({address})=>isProxyFakeDnsAddress(address))){
        addresses=await runWithDeadline(boundedSignal=>dependencies?.resolvePublic?dependencies.resolvePublic(host,boundedSignal):resolveWithEncryptedPublicDns(host,boundedSignal),signal,timeoutMs,'Encrypted public DNS timed out');
      }
    }
    if(signal?.aborted)throw new PublicFetchError('aborted','Request aborted');
    if(!addresses.length||addresses.some(({address})=>!isPublicIpAddress(address)))throw new PublicFetchError('unsafe_address','Host resolves to a private or reserved address');
    const pinned=addresses[0];
    const response=await runWithDeadline(boundedSignal=>dependencies?dependencies.request(current,pinned,boundedSignal):nativePublicRequest(current,pinned,boundedSignal,maximum,options.accept),signal,timeoutMs,'Request timed out');
    if(!Number.isInteger(response.status)||response.status<100||response.status>599||!Buffer.isBuffer(response.body))throw new PublicFetchError('malformed_response','Public resource response is malformed');
    const headers=normalizedResponseHeaders(response.headers,response.rawHeaders),isRedirect=[301,302,303,307,308].includes(response.status);
    if(isRedirect){
      if(options.redirect==='error')throw new PublicFetchError('redirect_invalid','Redirect target is not allowed');
      if(redirect===MAX_REDIRECTS)throw new PublicFetchError('redirect_invalid','Too many redirects');
      const location=headers.location;if(!location)throw new PublicFetchError('redirect_invalid','Redirect has no location');
      const next=normalizePublicUrl(new URL(location,current).href);
      if(options.allowRedirect&&!options.allowRedirect(current,next))throw new PublicFetchError('redirect_invalid','Redirect target is not allowed');
      current=next;continue;
    }
    declaredResourceLength(headers,maximum);
    if(response.body.length>maximum)throw new PublicFetchError('size_limit','Public resource exceeds size limit');
    if(headers['content-encoding']&&headers['content-encoding'].toLowerCase()!=='identity')throw new PublicFetchError('malformed_response','Compressed response is unsupported');
    const mediaType=(headers['content-type']??'').split(';',1)[0].trim().toLowerCase();
    if(response.status===200&&!options.mediaTypes.includes(mediaType))throw new PublicFetchError('media_type','Public resource media type is not accepted');
    return {url:current.href,status:response.status,headers,mediaType,body:Buffer.from(response.body)};
  }
  throw new PublicFetchError('redirect_invalid','Too many redirects');
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
    if(error instanceof PublicFetchError&&error.code==='media_type')throw new PublicFetchError('media_type',options.allowXml?'Public resource is not HTML or XML':'Public page is not HTML',undefined,{cause:error});
    throw error;
  }
  if(resource.status!==200)throw new PublicFetchError('http_status',`Public page returned HTTP ${resource.status}`,resource.status);
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
  $('script,style,noscript').remove();
  // Separate adjacent elements so "<code>XQ7731</code><button>Copy</button>" never reads as one word.
  $('body *').each((_index,node)=>{$(node).before(' ').append(' ')});
  // Copy buttons often hold the code only in an attribute ("<button data-copy=XQ7731>复制</button>").
  const copied=$('[data-copy],[data-clipboard-text]').map((_index,node)=>copyButtonCode($(node).attr('data-copy')??$(node).attr('data-clipboard-text'))).get().filter(Boolean) as string[];
  const referralCodes=[...new Set([...strictSiteCodes($('body').text().replace(/\s+/g,' ')),...copied])];
  return { referralCodes,url: page.href, domain: page.hostname.replace(/^www\./, ''), name, description, category, language };
}

/**
 * The part of a published page that holds our article: the platform's own header, footer, navigation,
 * sidebar and comments carry its own tracking links and other people's codes, which are not ours to fix.
 */
export function publishedArticleRegion(html:string,pageUrl:string,siteUrl:string):{articleHtml:string;articleText:string}{
  const $=load(html);
  $('script,style,noscript,template,header,footer,nav,aside,form,[role=navigation],[role=banner],[role=contentinfo],[class*=comment],[id*=comment]').remove();
  let pageHost='',siteHost='';
  try{pageHost=new URL(pageUrl).hostname}catch{/* checked by the caller */}
  try{siteHost=new URL(siteUrl).hostname.replace(/^www\./,'')}catch{/* checked by the caller */}
  // The platform's own links (same host as the page) are its navigation and tracking, not article content.
  $('a[href]').each((_index,node)=>{try{if(new URL($(node).attr('href')??'',pageUrl).hostname===pageHost)$(node).removeAttr('href')}catch{/* relative junk */}});
  const containers='article,main,[role=main],.post,.entry,.entry-content,.post-content,.article,.markdown-body,#content';
  const ourLink=$('a[href]').filter((_index,node)=>{try{const host=new URL($(node).attr('href')??'',pageUrl).hostname.replace(/^www\./,'');return !!siteHost&&(host===siteHost||host.endsWith(`.${siteHost}`))}catch{return false}}).first();
  const region=ourLink.length?ourLink.closest(containers):$(containers).first();
  const chosen=region.length?region.first():$('body');
  return {articleHtml:chosen.html()??'',articleText:chosen.text()};
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
  const hostedSources = new Set(['substack.com','artstation.com','beehiiv.com','kit.com','wordpress.com','ghost.io','tumblr.com','blogspot.com','carrd.co','raindrop.page']);
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

// Periodic checks only measure the published page and its live site-domain link.
// Keep these explanations local so first-publication failure reasons stay intact.
export const RECHECK_REASON_TEXT = {
  link_found: '公开页存在可见的本站域名链接。',
  legacy_origin: '公开页仍链接到迁移前的本站域名。',
  link_absent: '公开页未找到本站域名链接。',
  link_hidden: '公开页中的本站域名链接不可见。',
  page_noindex: '公开页声明了 noindex。',
  visibility_unknown: '公开页的隐藏样式无法可靠判断。',
  page_http_error: '公开页未返回成功状态。',
  page_not_html: '公开页未返回 HTML。',
  page_unreachable: '公开页暂时无法读取。',
  source_mismatch: '公开地址不属于预期平台。',
  source_redirect_mismatch: '公开页跳转到了预期平台之外。',
  invalid_input: '复查地址无效。',
} as const;

export type RecheckReasonCode = keyof typeof RECHECK_REASON_TEXT;

/** Channels whose public page renders the article body with script, so static HTML cannot prove a link is gone. */
export const CLIENT_RENDERED_CHANNELS: ReadonlySet<string> = new Set(['mdshare', 'bluesky', 'whitewind', 'hackmd']);

export interface RecheckedLinkResult extends LinkResult {
  httpStatus?:number;
  reasonCode: RecheckReasonCode;
  matchedOrigin?: string;
  usesLegacyOrigin?: boolean;
  /** No explicit noindex was found; this does not assert search indexing. */
  indexable?: boolean;
}

function recheckFailure(
  outcome: 'absent'|'invalid'|'unreachable',
  url: string,
  reasonCode: RecheckReasonCode,
  indexable?: boolean,
): RecheckedLinkResult {
  return {found: false, outcome, url, rel: '', reasonCode, reason: RECHECK_REASON_TEXT[reasonCode], indexable};
}

function recheckTargets(siteUrl: string, legacySiteUrls: readonly string[]): Array<{host: string; legacy: boolean}> {
  const hosts = new Map<string, {host: string; legacy: boolean}>();
  for (const [index, input] of [siteUrl, ...legacySiteUrls].entries()) {
    const host = normalizedHost(input);
    if (!hosts.has(host)) hosts.set(host, {host, legacy: index > 0});
  }
  return [...hosts.values()];
}

type RecheckVisibility = 'visible'|'hidden'|'unknown';
type RecheckCssRule = {selector: string; declarations: string; conditional: boolean};
type RecheckCss = {rules: RecheckCssRule[]; unknown: boolean};

function cssClose(css: string, open: number): number {
  let depth = 1, quote = '';
  for (let index = open + 1; index < css.length; index++) {
    const character = css[index];
    if (character === '\\') {index++; continue;}
    if (quote) {if (character === quote) quote = ''; continue;}
    if (character === '"' || character === "'") {quote = character; continue;}
    if (character === '{') depth++;
    if (character === '}' && --depth === 0) return index;
  }
  return -1;
}

function cssSelectorBranches(selector: string): string[] {
  const branches: string[] = [];
  let start = 0, quote = '', square = 0, round = 0;
  for (let index = 0; index < selector.length; index++) {
    const character = selector[index];
    if (character === '\\') {index++; continue;}
    if (quote) {if (character === quote) quote = ''; continue;}
    if (character === '"' || character === "'") {quote = character; continue;}
    if (character === '[') square++;
    if (character === ']') square--;
    if (character === '(') round++;
    if (character === ')') round--;
    if (character === ',' && !square && !round) {branches.push(selector.slice(start, index).trim()); start = index + 1;}
  }
  branches.push(selector.slice(start).trim());
  return branches.filter(Boolean);
}

function generatedPseudo(selector: string): 'none'|'top'|'nested' {
  let quote = '', square = 0, round = 0, nested = false;
  for (let index = 0; index < selector.length; index++) {
    const character = selector[index];
    if (character === '\\') {index++; continue;}
    if (quote) {if (character === quote) quote = ''; continue;}
    if (character === '"' || character === "'") {quote = character; continue;}
    if (character === '[') square++;
    if (character === ']') square--;
    if (!square && character === ':' && /^::(?:before|after|first-line|first-letter|marker|selection)\b|^:(?:before|after|first-line|first-letter)\b/i.test(selector.slice(index))) {
      if (!round) return 'top';
      nested = true;
    }
    if (character === '(') round++;
    if (character === ')') round--;
  }
  return nested ? 'nested' : 'none';
}

function recheckCss($: ReturnType<typeof load>): RecheckCss {
  const result: RecheckCss = {rules: [], unknown: false};
  const parse = (source: string, conditional = false) => {
    const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
    let cursor = 0;
    while (cursor < css.length) {
      const open = css.indexOf('{', cursor);
      if (open < 0) break;
      const close = cssClose(css, open);
      if (close < 0) {result.unknown = true; break;}
      const prelude = css.slice(cursor, open).trim().split(';').pop()?.trim() ?? '';
      const body = css.slice(open + 1, close);
      if (/^@media\b/i.test(prelude)) {
        const media = prelude.replace(/^@media\s*/i, '').toLowerCase();
        if (media !== 'print') parse(body, conditional || media !== 'screen' && media !== 'all');
      } else if (/^@(?:supports|container|scope)\b/i.test(prelude)) {
        parse(body, true);
      } else if (/^@layer\b/i.test(prelude)) {
        parse(body, conditional);
      } else if (!prelude.startsWith('@')) {
        for (const selector of cssSelectorBranches(prelude)) {
          const pseudo = generatedPseudo(selector);
          if (pseudo === 'top') continue;
          if (pseudo === 'nested') {
            if (recheckStyleVisibility(body) !== 'visible') result.unknown = true;
            continue;
          }
          result.rules.push({selector, declarations: body, conditional});
        }
      }
      cursor = close + 1;
    }
  };
  $('style').each((_index, element) => {
    const media = ($(element).attr('media') ?? '').trim().toLowerCase();
    if (media === 'print' || /^print\s+and\b/.test(media)) return;
    parse($(element).text(), !!media && media !== 'screen' && media !== 'all');
  });
  return result;
}

function visibilityRelevant(style: string): boolean {
  return /(?:^|;)\s*(?:display|visibility|content-visibility|opacity|(?:max-)?(?:width|height)|overflow(?:-[xy])?|clip(?:-path)?|transform|translate|position|top|right|bottom|left|font-size|text-indent|color|-webkit-text-fill-color)\s*:/i.test(style);
}

function recheckStyleVisibility(style: string): RecheckVisibility {
  const values = new Map<string, Set<string>>();
  for (const declaration of style.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim().toLowerCase().replace(/\s*!important\s*$/, '');
    if (!property || !value) continue;
    const set = values.get(property) ?? new Set<string>();
    set.add(value); values.set(property, set);
  }
  let unknown = false;
  const concealed = (property: string, predicate: (value: string) => boolean): boolean => {
    const entries = [...(values.get(property) ?? [])];
    if (!entries.some(predicate)) return false;
    if (entries.every(predicate)) return true;
    unknown = true; return false;
  };
  if (concealed('display', value => value === 'none') ||
      concealed('visibility', value => value === 'hidden' || value === 'collapse') ||
      concealed('content-visibility', value => value === 'hidden') ||
      ['opacity','font-size','color','-webkit-text-fill-color'].some(property =>
        concealed(property, value => articleTextStyleVisibility(property,value)==='hidden')) ||
      concealed('transform', value => /(?:^|\s)scale(?:x|y|3d)?\(\s*0(?:\.0+)?(?:\s*[,)]|\s*$)/.test(value)) ||
      concealed('clip', value => /^rect\(\s*0(?:px)?(?:\s*,\s*|\s+)0(?:px)?(?:\s*,\s*|\s+)0(?:px)?(?:\s*,\s*|\s+)0(?:px)?\s*\)$/.test(value)) ||
      concealed('clip-path', value => /^(?:inset\(\s*(?:50|100)%\s*\)|circle\(\s*0(?:px|%)?\s*\))$/.test(value))) return 'hidden';
  const overflow = [...values.get('overflow') ?? [], ...values.get('overflow-x') ?? [], ...values.get('overflow-y') ?? []];
  const dimensions = [...values.get('width') ?? [], ...values.get('height') ?? [], ...values.get('max-width') ?? [], ...values.get('max-height') ?? []];
  if (overflow.some(value => value === 'hidden' || value === 'clip')) {
    if (dimensions.some(value => /^0(?:\.0+)?(?:px|em|rem|%)?$/.test(value))) {
      if (dimensions.every(value => /^0(?:\.0+)?(?:px|em|rem|%)?$/.test(value))) return 'hidden';
      unknown = true;
    } else if (dimensions.some(value => /^0?\.\d+(?:px|em|rem)?$|^1(?:px)?$/.test(value))) unknown = true;
  } else if (dimensions.some(value => /^0(?:\.0+)?(?:px|em|rem|%)?$/.test(value))) unknown = true;
  const position = [...values.get('position') ?? []];
  if (position.some(value => value === 'fixed' || value === 'absolute') &&
      ['top', 'right', 'bottom', 'left'].some(property => [...values.get(property) ?? []].some(value => /^-\d{4,}(?:px|em|rem|vw|vh)$/.test(value)))) unknown = true;
  // CSS variables are ordinary in themes (body{color:var(--text)}); only treat them as unknown on properties
  // that can hide text by themselves, and on sizes only when overflow is clipped.
  const concealable = new Set(['display', 'visibility', 'content-visibility', 'opacity', 'color', '-webkit-text-fill-color', 'font-size', 'clip', 'clip-path', 'transform']);
  const clipped = overflow.some(value => value === 'hidden' || value === 'clip');
  if ([...values.entries()].some(([property, entries]) =>
    (concealable.has(property) || clipped && /^(?:max-)?(?:width|height)$/.test(property)) &&
    [...entries].some(value => /\bvar\(|\bcalc\(/.test(value)) &&
    !(property === 'color' || property === '-webkit-text-fill-color' || property === 'font-size') )) unknown = true;
  if ([...values.entries()].some(([property, entries]) =>
    [...entries].some(value => articleTextStyleVisibility(property,value)==='unknown'))) unknown = true;
  if (['clip', 'clip-path'].some(property =>
    [...values.get(property) ?? []].some(value => value !== 'auto' && value !== 'none'))) unknown = true;
  return unknown ? 'unknown' : 'visible';
}

const INHERITED_VISIBILITY_PROPERTIES=new Set(['visibility','font-size','color','-webkit-text-fill-color']);
type InheritedVisibility=Map<string,string>;
const UNRESOLVED_INHERITED_STYLE='__unresolved_inherited_style__';
function inheritedVisibility(styles:InheritedVisibility):RecheckVisibility {
  if([...styles.values()].some(value=>value.includes(UNRESOLVED_INHERITED_STYLE)))return 'unknown';
  return recheckStyleVisibility([...styles].map(([name,value])=>`${name}:${name==='-webkit-text-fill-color'&&value.toLowerCase()==='currentcolor'?(styles.get('color')??'initial'):value}`).join(';'));
}

function recheckNodeVisibility($: ReturnType<typeof load>, element: Parameters<ReturnType<typeof load>>[0], css: RecheckCss, inherited:InheritedVisibility): RecheckVisibility {
  const node = $(element);
  if (node.is('head,script,style,template,noscript,[hidden],input[type="hidden"],dialog:not([open])') ||
      node.attr('aria-hidden')?.trim().toLowerCase() === 'true') return 'hidden';
  let uncertain = css.unknown || (node.attr('class') ?? '').split(/\s+/).some(value => ['hidden', 'invisible', 'collapse', 'sr-only'].includes(value));
  const styles = [node.attr('style') ?? ''];
  for (const rule of css.rules) {
    if (!visibilityRelevant(rule.declarations)) continue;
    const potentiallyConcealing = recheckStyleVisibility(rule.declarations) !== 'visible';
    const dynamic = /:(?:hover|focus|active|visited|target|checked|disabled|enabled|has)\b/i.test(rule.selector);
    // Theme rules inside @media/@supports or behind :hover only matter when they can actually hide something.
    if ((dynamic || rule.conditional) && !potentiallyConcealing) continue;
    const selector = dynamic ? rule.selector.replace(/:(?:hover|focus|active|visited|target|checked|disabled|enabled|has)\b(?:\([^()]*\))?/gi, '') : rule.selector;
    let matches = false;
    try {matches = !!selector.trim() && node.is(selector);} catch {if (potentiallyConcealing) uncertain = true;}
    if (matches) {
      if (rule.conditional || dynamic) uncertain = true;
      else styles.push(rule.declarations);
    }
  }
  // Inherited text properties may be restored by a descendant. Evaluate them
  // only at readable content, while display/opacity/clipping still hide a subtree.
  const local:string[]=[],declared=new Map<string,string[]>();
  for(const declaration of styles.join(';').split(';')){
    const separator=declaration.indexOf(':');
    const property=declaration.slice(0,separator).trim().toLowerCase();
    if(separator<0||!INHERITED_VISIBILITY_PROPERTIES.has(property)){local.push(declaration);continue}
    const value=declaration.slice(separator+1).trim().replace(/\s*!important\s*$/i,'');
    const values=declared.get(property)??[];values.push(value);declared.set(property,values);
  }
  for(const [property,values] of declared){
    const effective=values.filter(value=>!['inherit','unset'].includes(value.toLowerCase()));
    if(!effective.length)continue;
    if(effective.every(value=>value.toLowerCase()==='initial')){inherited.delete(property);continue}
    const parentValue=inherited.get(property);
    // Only a value inherited from a concealing ancestor needs resolving; under a visible
    // ancestor a relative size or a revert keeps the text as readable as its parent.
    const parentHidden=!!parentValue&&inheritedVisibility(new Map([[property,parentValue]]))!=='visible';
    const resolved=effective.map(value=>{
      const lower=value.toLowerCase();
      if(/^revert(?:-layer)?$/.test(lower))return parentHidden?UNRESOLVED_INHERITED_STYLE:parentValue??'initial';
      if(property==='color'&&lower==='currentcolor')return parentValue??'initial';
      // Unresolved theme variables without a concealed inherited value retain
      // the existing fallback behavior; they cannot restore known hidden text.
      if(property==='font-size'&&/\bvar\(/.test(lower))return parentHidden?UNRESOLVED_INHERITED_STYLE:value;
      // Relative font units and calculations need the computed ancestor/root
      // size. They cannot prove that an inherited zero size has been restored.
      if(property==='font-size'&&parentHidden&&articleTextStyleVisibility(property,lower)!=='hidden'
        &&(/(?:[0-9.](?:r?em|ex|ch|cap|ic|lh|rlh|%)\b|%$)/.test(lower)||/\b(?:var|calc|min|max|clamp)\(|^(?:smaller|larger)$/.test(lower)))return UNRESOLVED_INHERITED_STYLE;
      if((property==='color'||property==='-webkit-text-fill-color')&&parentHidden&&/\bvar\(/.test(lower))return UNRESOLVED_INHERITED_STYLE;
      return value;
    });
    inherited.set(property,resolved.join(`;${property}:`));
  }
  const state = recheckStyleVisibility(local.join(';'));
  return uncertain ? 'unknown' : state;
}

function visibleAnchor($: ReturnType<typeof load>, element: Parameters<ReturnType<typeof load>>[0], css: RecheckCss): RecheckVisibility {
  for (const details of $(element).parents('details:not([open])').toArray()) {
    const summary = $(details).children('summary').first();
    if (!summary.length || !$(element).parents().toArray().includes(summary[0]!)) return 'hidden';
  }
  let uncertain = false;
  const inherited:InheritedVisibility=new Map();
  for (const node of [...$(element).parents().toArray().reverse(),...$(element).toArray()]) {
    const state = recheckNodeVisibility($, node, css, inherited);
    if (state === 'hidden') return 'hidden';
    if (state === 'unknown') uncertain = true;
  }
  let readable = false;
  const stack = $(element).contents().toArray().map(node => ({node, uncertain, inherited}));
  while (stack.length) {
    const current = stack.pop()!;
    if (current.node.type === 'text') {
      if ((current.node.data ?? '').trim()) {
        const textVisibility=inheritedVisibility(current.inherited);
        if (textVisibility==='hidden')continue;
        if (current.uncertain||textVisibility==='unknown') uncertain = true;
        else readable = true;
      }
      continue;
    }
    const childInherited=new Map(current.inherited);
    const state = recheckNodeVisibility($, current.node, css, childInherited);
    if (state === 'hidden') continue;
    const childUncertain = current.uncertain || state === 'unknown';
    if ($(current.node).is('img[alt]') && ($(current.node).attr('alt') ?? '').trim()) {
      if (childUncertain||inheritedVisibility(childInherited)==='unknown') uncertain = true;
      else if(inheritedVisibility(childInherited)==='visible')readable = true;
    }
    stack.push(...$(current.node).contents().toArray().map(node => ({node, uncertain: childUncertain, inherited:childInherited})));
  }
  return readable ? 'visible' : uncertain ? 'unknown' : 'hidden';
}

/** Static periodic check. It intentionally does not compare the original article or canonical. */
export function inspectRecheckedLinkHtml(
  html: string,
  pageUrl: string,
  siteUrl: string,
  legacySiteUrls: readonly string[] = [],
  robotsHeader = '',
): RecheckedLinkResult {
  let targets: ReturnType<typeof recheckTargets>;
  try {
    normalizePublicUrl(pageUrl);
    targets = recheckTargets(siteUrl, legacySiteUrls);
  } catch {
    return recheckFailure('invalid', pageUrl, 'invalid_input');
  }
  const $ = load(html);
  const directives = pageRobotsDirectives($, robotsHeader);
  const pageNoindex = directives.has('noindex') || directives.has('none');
  const css = recheckCss($);
  const pageNofollow = directives.has('nofollow') || directives.has('none');
  const declaredBase = $('base[href]').first().attr('href');
  let base = pageUrl;
  if (declaredBase) {
    try {
      const resolved = new URL(declaredBase, pageUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') base = resolved.href;
    } catch { /* Browsers ignore malformed base URLs. */ }
  }
  $('template, script, style, noscript, head').remove();
  type Candidate = {origin: string; rel: string; legacy: boolean};
  let visible: Candidate | undefined;
  let hidden: Candidate | undefined;
  let uncertain: Candidate | undefined;
  // Count only links in the article body. Author bylines (Telegraph renders author_url in the header),
  // navigation, footers and comment areas must not make a removed body link look alive.
  const articleRoot = $('article.tl_article_content').first();
  const anchors = articleRoot.length ? articleRoot.find('a[href]') : $('a[href]');
  anchors.each((_index, element) => {
    const anchor = $(element);
    if (/(^|\s)author(\s|$)/i.test(anchor.attr('rel') ?? '')) return;
    if (anchor.closest('header, nav, footer, address, aside, .tl_article_header, [class*="comment"], [id*="comment"]').length) return;
    let destination: URL;
    try { destination = new URL($(element).attr('href')!, base); }
    catch { return; }
    if (destination.protocol !== 'http:' && destination.protocol !== 'https:') return;
    let host: string;
    try { host = normalizedHost(destination.href); }
    catch { return; }
    const target = targets.find(item => item.host === host);
    if (!target) return;
    const candidate = {
      origin: destination.origin,
      rel: withPageNofollow(clean($(element).attr('rel')), pageNofollow) || 'follow',
      legacy: target.legacy,
    };
    const visibility = visibleAnchor($, element, css);
    if (visibility === 'visible') {
      if (!visible || visible.legacy && !candidate.legacy) visible = candidate;
    } else if (visibility === 'unknown') {
      if (!uncertain || uncertain.legacy && !candidate.legacy) uncertain = candidate;
    } else if (!hidden || hidden.legacy && !candidate.legacy) hidden = candidate;
  });
  if (visible) {
    if (pageNoindex) return {...recheckFailure('invalid', pageUrl, 'page_noindex', false),
      rel: visible.rel, matchedOrigin: visible.origin, usesLegacyOrigin: visible.legacy};
    const reasonCode = visible.legacy ? 'legacy_origin' : 'link_found';
    return {found: true, outcome: 'found', url: pageUrl, rel: visible.rel,
      reasonCode, reason: RECHECK_REASON_TEXT[reasonCode], matchedOrigin: visible.origin,
      usesLegacyOrigin: visible.legacy, indexable: true};
  }
  if (uncertain) {
    return {...recheckFailure('invalid', pageUrl, pageNoindex ? 'page_noindex' : 'visibility_unknown', !pageNoindex),
      rel: uncertain.rel, matchedOrigin: uncertain.origin, usesLegacyOrigin: uncertain.legacy};
  }
  if (hidden) {
    return {...recheckFailure('invalid', pageUrl, pageNoindex ? 'page_noindex' : 'link_hidden', !pageNoindex),
      rel: hidden.rel, matchedOrigin: hidden.origin, usesLegacyOrigin: hidden.legacy};
  }
  if (pageNoindex) return recheckFailure('invalid', pageUrl, 'page_noindex', false);
  return recheckFailure('absent', pageUrl, 'link_absent', true);
}

/** Guarded network entry point for checks after a publication was accepted. */
export async function recheckLink(
  publicUrl: string,
  siteUrl: string,
  legacySiteUrls: readonly string[] = [],
  expectedDomain?: string,
  signal?: AbortSignal,
  dependencies?: PublicFetchDependencies,
): Promise<RecheckedLinkResult> {
  let sourceUrl = publicUrl;
  try {
    sourceUrl = normalizePublicUrl(publicUrl).href;
    recheckTargets(siteUrl, legacySiteUrls);
    if (expectedDomain && !belongsToSource(sourceUrl, expectedDomain)) {
      return recheckFailure('invalid', sourceUrl, 'source_mismatch');
    }
  } catch {
    return recheckFailure('invalid', sourceUrl, 'invalid_input');
  }
  let redirectMismatch:string|undefined;
  try {
    const fetched = await fetchPublicText(sourceUrl, signal, dependencies, {allowRedirect:(from,to)=>{
      // A different article can contain the same site link; only URL normalization is safe to adopt.
      const samePath=from.pathname.replace(/\/$/,'')===to.pathname.replace(/\/$/,'');
      const sameProtocol=from.protocol===to.protocol||from.protocol==='http:'&&to.protocol==='https:';
      const sameHost=from.hostname.replace(/^www\./,'')===to.hostname.replace(/^www\./,'')&&from.port===to.port;
      const allowed=sameHost&&samePath&&from.search===to.search&&sameProtocol;
      if(!allowed)redirectMismatch=to.href;
      return allowed;
    }});
    if (expectedDomain && !belongsToSource(fetched.url, expectedDomain)) {
      return recheckFailure('invalid', fetched.url, 'source_redirect_mismatch');
    }
    const $=load(fetched.text);$('script,style,noscript').remove();
    const article=publishedArticleRegion(fetched.text,fetched.url,siteUrl);
    return {...inspectRecheckedLinkHtml(fetched.text, fetched.url, siteUrl, legacySiteUrls, fetched.robotsHeader),publicContent:{html:fetched.text,text:$('body').text(),...article}};
  } catch (error) {
    if(redirectMismatch)return recheckFailure('invalid',redirectMismatch,'source_redirect_mismatch');
    if(error instanceof PublicFetchError&&error.code==='http_status'&&(error.status===404||error.status===410))return {...recheckFailure('absent',sourceUrl,'link_absent'),httpStatus:error.status};
    const code = error instanceof PublicFetchError ? error.code : undefined;
    const reasonCode: RecheckReasonCode = code === 'http_status' ? 'page_http_error'
      : code === 'media_type' ? 'page_not_html' : 'page_unreachable';
    return recheckFailure('unreachable', sourceUrl, reasonCode);
  }
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
    const absent=error instanceof PublicFetchError&&error.code==='http_status'&&(error.status===404||error.status===410);
    return { found: false, outcome: absent?'absent':'unreachable', url: sourceUrl, rel: '', reason: error instanceof Error ? error.message : 'Verification failed' };
  }
}
