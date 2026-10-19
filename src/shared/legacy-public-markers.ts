/** Read-only detection of identifiers left on pages by previous releases. */
// The two neutral author names were fixed bylines only on these platforms; elsewhere they are a
// registered account's own name, which a post edit cannot change.
const LEGACY_NEUTRAL_AUTHORS: Record<string, RegExp> = {txtsbs: /Site publishing assistant/i, pastyx: /Site content publisher/i};
export function scanLegacyPublicMarkers(input: {html?: string; text?: string; url?: string}, channelId?: string): string[] {
  const html = input.html ?? '';
  const visible = `${input.text ?? ''}\n${html}`;
  const markers: string[] = [];
  if (/\bdata-linkflow\b/i.test(html)) markers.push('blogger_data_linkflow');
  const neutral = channelId === undefined ? /Site publishing assistant|Site content publisher/i : LEGACY_NEUTRAL_AUTHORS[channelId];
  if (/AI assistant involved in Linkflow development|Linkflow promotional content publisher/i.test(visible) || neutral?.test(visible)) {
    markers.push('legacy_author');
  }
  const readable = `${input.text ?? ''}\n${html.replace(/<[^>]+>/g,' ')}`;
  if (/\bLinkFlow\b/i.test(readable)) markers.push('legacy_brand_token');
  if (/\bsoftwareName["']?\s*[:=]\s*["']LinkFlow["']/i.test(html)) markers.push('agentriot_software_name');
  if (/\blinkflow\/1\.0\b/i.test(visible)) markers.push('hive_legacy_app');
  if (/\blinkflow-article-[a-f0-9]{12,}\b/i.test(`${visible}\n${input.url ?? ''}`)) markers.push('hive_legacy_permalink');
  if (/\blinkflow-page(?:[.-]|$)/i.test(input.url ?? '')) markers.push('legacy_subdomain');
  // Early releases named pages "lf-<task>-<hash>"; match only at a path segment or subdomain start, never "golf-".
  try {
    const url = new URL(input.url ?? '');
    if (/(?:^|\/)lf-[a-z0-9]{1,40}(?:-[a-f0-9]{12})?(?:\.md)?(?:[/.?#]|$)/i.test(url.pathname) || /^lf-[a-z0-9-]{1,40}\./i.test(url.hostname)) markers.push('legacy_lf_slug');
  } catch { /* not a URL */ }
  return markers;
}
