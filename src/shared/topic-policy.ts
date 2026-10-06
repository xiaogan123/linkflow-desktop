const ADMINISTRATIVE_SEGMENT = /^(?:index|about(?:-us)?|contact(?:-us)?|privacy(?:-policy)?|terms(?:-of-(?:use|service)|-and-conditions)?|legal|disclosures?|affiliate-disclosure|advertising-disclosure|disclaimers?|cookies?(?:-policy)?|login|log-in|signin|sign-in|signup|sign-up|register|account|profile|authors?|tags?|categories?|archives?|search|feed|rss|sitemap|wp-json|cart|checkout|page)$/i;
const NON_CONTENT_EXTENSION = /\.(?:xml|json|txt|pdf|jpe?g|png|gif|webp|svg|ico|css|js|mjs|map|zip|gz|tar|mp[34]|m4[av]|avi|mov|webm|wav|ogg|woff2?|ttf|eot)$/i;
const ROUTE_EXTENSION = /\.(?:html?|php)$/i;
const LOCALE_ONLY_SEGMENT = /^[a-z]{2,3}(?:[-_](?:[a-z]{2}|[a-z]{4}|\d{3}))?(?:[-_](?:[a-z]{2}|\d{3}))?$/i;
const LOCALE_LANGUAGES = new Set('aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'.split(' '));

function parseHttpUrl(input: string): URL | undefined {
  try {
    const raw = input.trim();
    if (!raw) return;
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) return;
    return url;
  } catch {
    return;
  }
}

function normalizedHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

function siteHost(site: { url: string; domain: string }): string | undefined {
  const siteUrl = parseHttpUrl(site.url);
  const domainUrl = parseHttpUrl(site.domain);
  if (!siteUrl || !domainUrl) return;
  const urlHost = normalizedHost(siteUrl);
  const domainHost = normalizedHost(domainUrl);
  return urlHost && urlHost === domainHost ? urlHost : undefined;
}

function isLocaleOnlySegment(segment: string): boolean {
  if (!LOCALE_ONLY_SEGMENT.test(segment)) return false;
  return LOCALE_LANGUAGES.has(segment.split(/[-_]/, 1)[0].toLowerCase());
}

/**
 * Fail-closed topic URL policy shared by discovery and cached-topic consumers.
 * It intentionally treats language-prefixed article paths like /fr/guides/x as
 * content; only a path whose sole segment is a locale is a landing page.
 */
export function isArticleTopicUrl(input: string, site: { url: string; domain: string }): boolean {
  const expectedHost = siteHost(site);
  const candidate = parseHttpUrl(input);
  if (!expectedHost || !candidate || normalizedHost(candidate) !== expectedHost) return false;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(candidate.pathname).normalize('NFKC');
  } catch {
    return false;
  }
  if (NON_CONTENT_EXTENSION.test(decodedPath)) return false;

  const segments = decodedPath.split('/').filter(Boolean);
  if (!segments.length || (segments.length === 1 && isLocaleOnlySegment(segments[0]))) return false;
  if (segments.some((segment) => ADMINISTRATIVE_SEGMENT.test(segment.replace(ROUTE_EXTENSION, '')))) return false;
  for (const key of candidate.searchParams.keys()) {
    if (/^(?:page|paged)$/i.test(key)) return false;
  }
  return true;
}
