import type { Account, Channel, Site, Task } from './types';

import {REFERRAL_MESSAGES} from './referral-messages';
export {REFERRAL_MESSAGES,REFERRAL_BLOCK_REASON} from './referral-messages';

/*
 * Detection runs on a normalized copy (entities, percent-encoding, NFKC, invisible characters).
 * Removal never rewrites text from that copy: it deletes exact ranges of the original string,
 * so every byte outside an offending sentence stays as written.
 */

const REFERRAL_PARAM = /^(?:ref|refs|referral|referral[_-]?(?:code|id)|ref[_-]?(?:code|id)|refcode|referrer|referrer[_-]?id|invite|invite[_-]?code|invitation[_-]?code|invitecode|inviter|inviter[_-]?code|aff|aff[_-]?id|affiliate|affiliate[_-]?id|rcode|clac[_-]?code|channelcode|promo[_-]?code|promocode)$/i;

const EXCHANGE_HOSTS = /(?:^|\.)(?:binance\.(?:com|info|me|us)|bnbchain\.org|okx\.com|okex\.com|bybit\.com|gate\.(?:io|com)|bitget\.com|kucoin\.com|mexc\.com|htx\.com|huobi\.com|bingx\.com|coinbase\.com|kraken\.com|bitmart\.com|lbank\.com|crypto\.com|coinex\.com|phemex\.com|weex\.com|bitunix\.com|blofin\.com|toobit\.com|xt\.com|ascendex\.com|bitfinex\.com|poloniex\.com|whitebit\.com|bitstamp\.net|upbit\.com|bithumb\.com|pionex\.com|bitrue\.com|deepcoin\.com|zoomex\.com|bitmex\.com|bitvavo\.com|gemini\.com|bitpanda\.com|coinw\.com|btcc\.com|tapbit\.com|hotcoin\.com|hyperliquid\.xyz)$/i;

// Paths that carry a code in the path itself, e.g. /join/ABCD1234 or /invite/XYZ987.
const REFERRAL_PATH = /\/(?:join|invite|invitation|referral|referrals|ref|r|signup|sign-up|register|activity\/referral[^/]*|b)\/[A-Za-z0-9_-]{4,}(?:\/|$)/i;

const SHORTENER_HOSTS = /(?:^|\.)(?:bit\.ly|tinyurl\.com|is\.gd|cutt\.ly|rebrand\.ly|t\.ly|s\.id|shorturl\.at|ow\.ly|buff\.ly|rb\.gy|tiny\.cc|v\.gd|t\.cn|dwz\.cn|url\.cn|suo\.im)$/i;

// The site's own outbound redirect paths are affiliate redirects by convention and cannot be cleaned.
const SITE_REDIRECT_PATH = /^\/(?:r|go|out|link|links|ref|visit|jump|to|aff)(?:\/|$)/i;

const LABEL = String.raw`(?:推介码|推介碼|推荐代码|推薦代碼|邀请代码|邀請代碼|推广码|推廣碼|推荐号|推薦號|邀请号|邀請號|邀请人\s*ID|邀請人\s*ID|邀请\s*ID|邀請\s*ID|优惠码|優惠碼|注册码|註冊碼|注册碼|promo[\s_-]*code|affiliate[\s_-]*code|邀请码|邀請碼|推荐码|推薦碼|返佣码|返傭碼|返现码|返現碼|推荐人\s*ID|推薦人\s*ID|推荐\s*ID|推薦\s*ID|invite[\s_-]*code|invitation[\s_-]*code|referral[\s_-]*(?:codes?|id)|ref[\s_-]*code|c[oó]digo\s+de\s+(?:invitaci[oó]n|referido|referencia|indica[cç][aã]o|convite|refer[eê]ncia)|code\s+de\s+parrainage|kode\s+(?:referral|referensi|undangan)|m[aã]\s+gi[oớ]i\s+thi[eệ]u|m[aã]\s+m[oờ]i|referans\s+kodu|davet\s+kodu|реферальный\s+код|код\s+приглашения|招待コード|紹介コード|추천인\s*코드|초대\s*코드|(?:كود|رمز)\s+(?:الإحالة|الدعوة))`;
const LABEL_PATTERN = new RegExp(LABEL, 'giu');
const SENTENCE_END = /[。！？.!?\n]/u;
const TOKEN_PATTERN = /[A-Za-z0-9][A-Za-z0-9_-]{3,31}/g;

const NAMED_ENTITIES: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', zwj: '', zwnj: '', shy: '', lrm: '', rlm: ''};

function normalized(value: string): string {
  let text = value;
  for (let round = 0; round < 4; round++) {
    const next = text
      .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (raw, body: string) => {
        if (body[0] === '#') {
          const point = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
          return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : raw;
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? raw;
      })
      .replace(/(?:%[\da-f]{2})+/gi, encoded => { try { return decodeURIComponent(encoded); } catch { return encoded; } })
      .normalize('NFKC')
      .replace(/\p{Default_Ignorable_Code_Point}/gu, '');
    if (next === text) break;
    text = next;
  }
  return text;
}

// Exchange brand names that are never a site's code (the host list above names the same exchanges by domain).
const EXCHANGE_NAMES = ['binance', 'okx', 'okex', 'bybit', 'bitget', 'gate', 'gateio', 'kucoin', 'mexc', 'htx', 'huobi', 'bingx', 'coinbase', 'kraken', 'bitmart', 'lbank', 'crypto', 'coinex', 'phemex', 'weex', 'bitunix', 'blofin', 'toobit', 'xt', 'ascendex', 'bitfinex', 'poloniex', 'whitebit', 'bitstamp', 'upbit', 'bithumb', 'pionex', 'bitrue', 'deepcoin', 'zoomex', 'bitmex', 'bitvavo', 'gemini', 'bitpanda', 'coinw', 'btcc', 'tapbit', 'hotcoin', 'hyperliquid', 'bnbchain'];
// Chain names, levels, currencies, years, dates and form words that follow a label in ordinary prose.
// Levels stay one or two digits (VIP0, LV12), so a chosen code such as VIP888 is still a code.
const EXCHANGE_NAME_TOKEN = new RegExp(String.raw`^(?:${EXCHANGE_NAMES.join('|')})$`, 'i');
const NON_CODE = new RegExp(String.raw`^(?:${EXCHANGE_NAMES.join('|')}|(?:TRC|ERC|BEP|SPL|BRC|SRC|ARC|DRC)[-_]?(?:20|404|721|1155)|USDT|USDC|BUSD|FDUSD|BTC|ETH|BNB|SOL|XRP|TRX|USD|CNY|HKD|EUR|KYC|API|APP|web3|layer[-_]?[12]|VIP(?:[-_]?\d{1,2})?|LV[-_]?\d{1,2}|LEVEL[-_]?\d{0,2}|HTTPS?|WWW|(?:19|20)\d\d|\d{1,4}(?:[-_/.]\d{1,4})+|(?:ios|android|iphone|ipad|win|windows|macos|chrome|top|x)\d+|(?:kyc|step|tier|q)\d{1,2}|\d{4}q[1-4]|[A-Z]{2,6}(?:USDT|USDC|BUSD|USD)|optional|required|none|null|copy|copied|enter|paste|referral|referrals|invite|invitation|code|codes|here|below|above|link|links|leave|skip|blank|empty|save|get|bonus|welcome|reward|rewards)$`, 'i');
const CODE_TOKEN = String.raw`[A-Za-z0-9][A-Za-z0-9_-]{3,31}`;
const SEPARATED_CODE = new RegExp(String.raw`^\s*[:：=]\s*["'“「『(（]?\s*(${CODE_TOKEN})(?![A-Za-z0-9])`, 'u');
// "referral code for Binance users is XQ7731", "referral code when you sign up: XQ7731"
const ENGLISH_FILLER_CODE = new RegExp(String.raw`^\s+(?:[A-Za-z][A-Za-z']*\s+){0,6}?(?:(?:is|are)\s*[:：]?|[A-Za-z']+\s*[:：])\s*(${CODE_TOKEN})(?![A-Za-z0-9])`, 'u');

/** A value looks like a referral code, not an ordinary word, number or year. */
function codeLike(token: string): boolean {
  const core = token.replace(/[_-]/g, '');
  if (core.length < 4) return false;
  if (/^\d+$/.test(core)) return core.length >= 5;
  if (/^[A-Za-z]+$/.test(core)) return core.length >= 5 && core === core.toUpperCase();
  return /\d/.test(core) && /[A-Za-z]/.test(core);
}

export function referralCodesInText(value: string): string[] {
  const text = normalized(value);
  const codes: string[] = [];
  for (const label of text.matchAll(LABEL_PATTERN)) {
    // Look only at the rest of the same sentence, ignoring inline tags, and at most its first two tokens.
    const rest = text.slice(label.index! + label[0].length, label.index! + label[0].length + 120);
    // "邀请码：okxvip" names a code explicitly, whatever its shape.
    const separated = rest.match(SEPARATED_CODE)?.[1];
    if (separated && !NON_CODE.test(separated)) { codes.push(separated); continue; }
    const stop = rest.search(SENTENCE_END);
    const tail = (stop < 0 ? rest : rest.slice(0, stop)).replace(/<[^>]*>/g, '');
    const code = [...tail.matchAll(TOKEN_PATTERN)].slice(0, 2).map(match => match[0]).find(token => codeLike(token) && !NON_CODE.test(token));
    if (code) codes.push(code);
  }
  return codes;
}

/**
 * Codes a site publishes about itself, read from its own pages. Stricter than draft detection: the code
 * must directly follow the label, so "邀请码注册后充值 USDT（TRC20）" never turns TRC20 into a site code.
 */
/** A copy button's own value ("data-copy", "data-clipboard-text") when it is shaped like a code. */
export function copyButtonCode(value: string | undefined): string | undefined {
  const token = normalized(value ?? '').trim();
  return new RegExp(String.raw`^${CODE_TOKEN}$`, 'u').test(token) && codeLike(token) && !NON_CODE.test(token) && !UNIT_VALUE.test(token) ? token : undefined;
}

export function strictSiteCodes(value: string): string[] {
  const text = normalized(value).replace(/\s+/g, ' ');
  const codes: string[] = [];
  const singleCode = (token: string | undefined) => token !== undefined && new RegExp(String.raw`^${CODE_TOKEN}$`, 'u').test(token) && codeLike(token) && !NON_CODE.test(token) && !UNIT_VALUE.test(token);
  for (const label of text.matchAll(LABEL_PATTERN)) {
    const raw = text.slice(label.index! + label[0].length, label.index! + label[0].length + 80);
    // A bracket right after the label either holds the code itself ("邀请码（XQ7731）即可") or is a note that belongs to the
    // label ("邀请码（OKX）：30589422", "邀请码(选填) 30589422", "邀请码（币安 XQ7731）"): a note is set aside and read last.
    const bracket = raw.match(/^\s*[（(]([^）)]{1,20})[）)]/u), inner = bracket?.[1].trim();
    const rest = bracket && !singleCode(inner) ? raw.slice(bracket[0].length) : raw;
    // "推荐码为 X" / "邀请码是 X" introduce a code just like a colon does.
    const separatorMatch = rest.match(SEPARATED_CODE) ?? rest.match(new RegExp(String.raw`^\s*(?:为|是|為)\s*["'“「『]?\s*(${CODE_TOKEN})(?![A-Za-z0-9])`, 'u'));
    const separated = separatorMatch?.[1];
    const adjacentMatch = rest.match(new RegExp(String.raw`^\s*["'“「『(（]?\s*(${CODE_TOKEN})(?![A-Za-z0-9])`, 'u'));
    const adjacent = adjacentMatch?.[1];
    const english = rest.match(ENGLISH_FILLER_CODE)?.[1];
    const named = separated && !NON_CODE.test(separated) && (!/^\d+$/.test(separated) || separated.length >= 4) ? separated : undefined;
    // A word-shaped value ("邀请码：okxvip") counts only when no other word follows it (punctuation, a copy button, Chinese text
    // or the end) and no code-shaped value follows in the sentence: "Referral code (if any): leave blank…" and
    // "Referral code: Bonus, use XQ7731" must not harvest the word.
    const afterNamed = separatorMatch ? rest.slice(separatorMatch.index! + separatorMatch[0].length) : '';
    const namedEnds = !!named && /^\s*["'”」』)）]?\s*(?:[。！？.!?\n,，;；:：]|复制|拷贝|Copy|Copied|copy|[^\x00-\x7F]|$)/u.test(afterNamed);
    const code = named && (codeLike(named) || namedEnds && !clauseCodes(rest).length) ? named
      : adjacent && codeLike(adjacent) && !NON_CODE.test(adjacent) && !INCIDENTAL_TOKEN.test(adjacent) ? adjacent : english && codeLike(english) && !NON_CODE.test(english) ? english : undefined;
    if (code) {
      codes.push(code);
      // A row of codes after one label ("邀请码 8888AB 6008OK", "邀请码 币安 XQ7731 OKX ZK4402") continues only through
      // further code-shaped values and exchange names separated by spaces; anything else ends the row.
      if (code === adjacent) {
        for (const token of rest.slice(adjacentMatch!.index! + adjacentMatch![0].length).split(' ').filter(Boolean)) {
          if (EXCHANGE_NAME_TOKEN.test(token)) continue;
          if (!/^[A-Za-z0-9_-]+$/.test(token) || !singleCode(token) || INCIDENTAL_TOKEN.test(token)) break;
          codes.push(token);
        }
      }
    }
    // Tables and lists put an exchange name or a few words between the label and its codes:
    // "邀请码 币安 XQ7731 OKX ZK4402", "OKX 邀请码 注册时填写… ZK9015 复制".
    else {
      const found = [...clauseCodes(rest), ...exchangeNumericCodes(rest)];
      codes.push(...(found.length || !inner ? found : clauseCodes(inner)));
    }
  }
  return [...new Set(codes.map(code => code.replace(GLUED_BUTTON, '')))];
}

// Page text read without element breaks glues a code to the copy button next to it: "XQ7731Copy".
const GLUED_BUTTON = /(?<=\d)(?:Copy|Copied|Click|Paste|Share|Tap)$/;

/** Numeric codes named right after an exchange in a list ("邀请码 币安 KXQDM12 OKX 30589422"). */
function exchangeNumericCodes(rest: string): string[] {
  const stop = rest.search(SENTENCE_END);
  const clause = (stop < 0 ? rest : rest.slice(0, stop)).slice(0, 60).split(' ').filter(Boolean);
  return clause.flatMap((token, index) => index > 0 && EXCHANGE_NAME_TOKEN.test(clause[index - 1]) && /^\d{5,}$/.test(token) ? [token] : []);
}

/** Code-shaped values (letters with digits) later in the label's own sentence, within about 60 characters. */
function clauseCodes(rest: string, untilComma = false): string[] {
  const stop = rest.search(untilComma ? /[。！？.!?\n,，;；]/u : SENTENCE_END);
  const clause = (stop < 0 ? rest : rest.slice(0, stop)).slice(0, 60);
  return [...clause.matchAll(new RegExp(String.raw`(?<![A-Za-z0-9])${CODE_TOKEN}(?![A-Za-z0-9])`, 'gu'))].map(match => match[0])
    .filter(token => /\d/.test(token) && /[A-Za-z]/.test(token) && codeLike(token) && !NON_CODE.test(token) && !UNIT_VALUE.test(token) && !INCIDENTAL_TOKEN.test(token));
}
// "100x", "500U", "24h", "10k", "100USDT" are amounts and durations, not codes; "8888AB" (two capitals) is a code.
const UNIT_VALUE = {test: (token: string) => /^\d+(?:[a-z]{1,2}|[A-Z])$/.test(token) || /^\d+(?:USDT|USDC|BUSD|USD|BTC|ETH|BNB|SOL|TRX|OP|ARB|TON|SUI|APT|DOGE|XRP|ADA|AM|PM|KB|MB|GB|TB|TH|GH|MH|PH|EH|HZ|KW|MW|FPS)$/i.test(token)};
// Ticker, version and label shapes that follow a label only by chance ("邀请码 … 1000PEPE 合约", "Season2 活动", "SHA256", "7x24").
const INCIDENTAL_TOKEN = /^(?:\d+(?:PEPE|SHIB|SATS|BONK|FLOKI|LUNC|BTT|XEC|RATS|CAT|INCH)|(?:season|round|phase|step|stage|level|lv|bep|erc|trc|spl|sha|md|aes|rsa|eth|btc|sol|bnb|ver|v)\d+|[A-Za-z]\d{2,3}|Q[1-4](?:19|20)\d\d|\d+x\d+)$/i;

const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]+/g;

function trimUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?]+$/, '');
  // Drop unbalanced closing brackets that belong to the surrounding text, e.g. "(see https://x)".
  while (/[)\]]$/.test(url)) {
    const close = url.endsWith(')') ? ')' : ']', open = close === ')' ? '(' : '[';
    if (url.split(open).length >= url.split(close).length) break;
    url = url.slice(0, -1);
  }
  return url;
}

function hostOf(url: URL): string { return url.hostname.toLowerCase().replace(/^www\./, ''); }

type UrlVerdict = {kind: 'clean'} | {kind: 'strip-params'; cleaned: string} | {kind: 'remove-sentence'};

function judgeUrl(raw: string, siteHost?: string, depth = 0): UrlVerdict {
  let url: URL;
  try { url = new URL(normalized(raw).replace(/&amp;/gi, '&')); } catch { return {kind: 'clean'}; }
  const host = hostOf(url);
  if (SHORTENER_HOSTS.test(host)) return {kind: 'remove-sentence'};
  if (siteHost && (host === siteHost || host.endsWith(`.${siteHost}`)) && SITE_REDIRECT_PATH.test(url.pathname)) return {kind: 'remove-sentence'};
  if (EXCHANGE_HOSTS.test(host) && REFERRAL_PATH.test(url.pathname)) return {kind: 'remove-sentence'};
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, '').replace(/^[^?]*\?/, ''));
  // A redirect wrapper that carries a referral URL inside a parameter value cannot be cleaned safely.
  for (const value of [...url.searchParams.values(), ...hashParams.values()]) {
    const nested = value.match(/https?:\/\/\S+/i)?.[0];
    if (nested && depth < 3 && judgeUrl(nested, siteHost, depth + 1).kind !== 'clean') return {kind: 'remove-sentence'};
  }
  // Exchanges also carry invite codes in a plain "code" parameter, e.g. okx.com/join?code=12345.
  const referralKey = (key: string) => REFERRAL_PARAM.test(key) || EXCHANGE_HOSTS.test(host) && /^code$/i.test(key);
  const queryHit = [...url.searchParams.keys()].some(referralKey);
  const hashHit = [...hashParams.keys()].some(referralKey);
  if (!queryHit && !hashHit) return {kind: 'clean'};
  // Nested redirect targets in a parameter value cannot be cleaned safely.
  if ([...url.searchParams.values()].some(value => /https?:\/\//i.test(value))) return {kind: 'remove-sentence'};
  for (const key of [...url.searchParams.keys()]) if (referralKey(key)) url.searchParams.delete(key);
  if (hashHit) url.hash = '';
  return {kind: 'strip-params', cleaned: url.href};
}

export function hasReferralParameters(value: string, siteHost?: string): boolean {
  const text = normalized(value);
  for (const match of text.matchAll(URL_PATTERN)) if (judgeUrl(trimUrl(match[0]), siteHost).kind !== 'clean') return true;
  // Relative or bare query fragments such as "?ref=ABCD" in attributes.
  return /(?:^|[?&#])(?:ref|referral|referral[_-]?code|ref[_-]?code|invite[_-]?code|invitation[_-]?code|invitecode|inviter|aff|affiliate|rcode|clac[_-]?code)\s*=/i.test(text.replace(URL_PATTERN, ''));
}

function knownCodeHit(text: string, knownCodes: readonly string[]): boolean {
  return knownCodes.some(code => {
    // Codes are known explicitly here, so any shape counts except ordinary chain, level and currency words.
    const value = normalized(code).trim();
    if (value.length < 4 || NON_CODE.test(value)) return false;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A letters-only code reads like a word, so only its exact spelling counts; codes with digits match any case.
    return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, /\d/.test(value) ? 'i' : '').test(text);
  });
}

export function containsReferralInformation(value: string, knownCodes: readonly string[] = [], siteHostInput?: string): boolean {
  const text = normalized(value);
  const siteHost = siteHostInput?.toLowerCase().replace(/^www\./, '');
  return referralCodesInText(text).length > 0 || hasReferralParameters(text, siteHost) || knownCodeHit(text, knownCodes);
}

/** Codes the site itself publishes: only code-shaped tokens, never ordinary words in a description. */
export function siteReferralCodes(site: Pick<Site, 'description' | 'url'> & Partial<Pick<Site,'referralCodes'|'name'|'domain'>>, snapshot?:{sources:readonly {text:string}[]}): string[] {
  const codes = [...strictSiteCodes(site.description ?? ''),...(site.referralCodes??[]),...(snapshot?.sources.flatMap(source=>strictSiteCodes(source.text))??[])];
  try {
    for (const [key, value] of new URL(site.url).searchParams) if (REFERRAL_PARAM.test(key) && codeLike(value)) codes.push(value);
  } catch { /* checked by site validation */ }
  // A word-shaped "code" that is also the site's own brand ("Bitunix 邀请码：Bitunix 新用户…") is the brand:
  // treating it as a code would strip every title and sentence that names the site's subject.
  let host = site.domain ?? '';
  try { host ||= new URL(site.url).hostname; } catch { /* checked by site validation */ }
  const brandWords = new Set(`${site.name ?? ''} ${host}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  // Stored codes are bounded like every other site field, so backups stay restorable.
  return [...new Set(codes)].filter(code => code.length >= 4 && code.length <= 32 && !NON_CODE.test(code) && (codeLike(code) || !brandWords.has(code.toLowerCase())));
}

const SITE_NAME_PUBLICATION_CHANNELS = new Set([
  'telegraph', 'blogger', 'nostr', 'tantive', 'synthfolk', 'agentboard', 'agentswiki',
  // These publishers derive each new page's public slug or filename from the site name.
  'berrry', 'wordcell', 'shareyourhtml', 'prose', 'wordpress-com', 'verbose', 'rentry',
]);
const SITE_NAME_IDENTITY_CHANNELS = new Set(['agenthow', 'agentriot', 'shellbook', 'colony', 'openagentchat']);

/** Public structured fields added by publishers, outside the editable draft. Never inspect secrets or receipts. */
export function publicationReferralFields(task: Task, site: Pick<Site, 'name' | 'domain' | 'description' | 'url'>, account?: Account, channel?: Pick<Channel, 'automation'>): string[] {
  const snapshot = task.publicationSnapshot;
  const fields = [snapshot?.targetUrl ?? task.topicUrl ?? site.url];
  const sendsSiteName = channel?.automation === 'browser' || SITE_NAME_PUBLICATION_CHANNELS.has(task.channelId)
    || (!account && SITE_NAME_IDENTITY_CHANNELS.has(task.channelId));
  if (sendsSiteName) fields.push(snapshot?.siteName ?? (site.name || site.domain));
  if (channel?.automation === 'browser') fields.push(site.description);
  if (account) fields.push(account.displayName ?? '', account.username);
  if (task.channelId === 'agentriot') fields.push(...(task.agentriotInput?.skillsTools ?? []));
  if (task.channelId === 'agenthow' && task.agentHowInput) {
    for (const source of task.agentHowInput.sources) fields.push(source.title, source.url);
  }
  if (task.channelId === 'agentswiki' && task.agentsWikiInput) {
    const input = task.agentsWikiInput;
    fields.push(JSON.stringify(input.draft), input.identity.name, input.identity.publicDisclosure);
  }
  if (task.channelId === 'carcinus' && task.carcinusInput) {
    const input = task.carcinusInput;
    fields.push(input.identity, input.purpose, input.htmlTemplate, input.targetUrl);
  }
  if (task.channelId === 'synthfolk' && task.synthfolkInput) {
    const profile = task.synthfolkInput.profile;
    fields.push(profile.handle, profile.name, profile.headline, profile.about, profile.operator, profile.website, ...profile.skills);
  }
  if (task.channelId === 'agentboard') {
    const agent = (task.agentboardInput ?? task.agentboardSubject)?.agent;
    if (agent) fields.push(agent.name, agent.description, agent.homepage, agent.operatorName);
    else if (!account) fields.push(site.description, site.url);
  }
  if (task.channelId === 'large-language' && account?.largeLanguage) {
    fields.push(account.largeLanguage.displayName, account.largeLanguage.responsibleHuman, account.largeLanguage.producerName);
  }
  return fields;
}

export function containsPublicationReferralInformation(task: Task, site: Pick<Site, 'name' | 'domain' | 'description' | 'url'>, account?: Account, channel?: Pick<Channel, 'automation'>): boolean {
  let siteHost: string | undefined;
  try { siteHost = hostOf(new URL(site.url)); } catch { /* site validation reports malformed URLs */ }
  const codes = siteReferralCodes(site,task.evidenceSnapshot);
  return publicationReferralFields(task, site, account, channel).some(value => containsReferralInformation(value, codes, siteHost));
}

type Range = {start: number; end: number};

/** Sentence or line units of the original text, with exact offsets. */
function units(text: string): Range[] {
  const result: Range[] = [];
  let lineStart = 0;
  for (const line of text.split('\n')) {
    const lineEnd = lineStart + line.length;
    // Headings, table rows, list items and HTML block lines are handled as whole lines.
    if (/^\s*(?:#{1,6}\s|\||[-*+]\s|\d+[.)]\s|<(?:h[1-6]|li|tr|td|th)\b)/i.test(line)) {
      result.push({start: lineStart, end: lineEnd});
    } else {
      let start = lineStart;
      const pattern = /[。！？]+|[.!?]+(?=\s+[A-Z"'“(（]|\s*$)/gu;
      for (const match of line.matchAll(pattern)) {
        const end = lineStart + match.index! + match[0].length;
        // "3.5" or "1." inside a sentence are not sentence ends.
        if (match[0][0] === '.' && /\d$/.test(line.slice(0, match.index!)) && /^\d/.test(line.slice(match.index! + 1))) continue;
        result.push({start, end});
        start = end;
        // The next sentence starts after the separating spaces, which stay with the text before it.
        while (start < lineEnd && /[^\S\n]/.test(text[start])) start++;
      }
      if (start < lineEnd) result.push({start, end: lineEnd});
    }
    lineStart = lineEnd + 1;
  }
  return result;
}

function isHeadingLine(text: string, range: Range): boolean {
  const lineStart = text.lastIndexOf('\n', range.start - 1) + 1;
  const lineEnd = text.indexOf('\n', range.start);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  return /^\s*(?:#{1,6}\s|<h[1-6]\b)/i.test(line);
}

export interface ReferralStripResult {text: string; blocked: boolean; reason?: string}

export function stripReferralDetailed(value: string, knownCodes: readonly string[] = [], siteHostInput?: string): ReferralStripResult {
  const siteHost = siteHostInput?.toLowerCase().replace(/^www\./, '');
  if (!containsReferralInformation(value, knownCodes, siteHost)) return {text: value, blocked: false};
  // 1. Clean query parameters in place; remember URLs that force the sentence out.
  let text = '';
  let cursor = 0;
  const forced: Range[] = [];
  for (const match of value.matchAll(URL_PATTERN)) {
    const raw = trimUrl(match[0]);
    const start = match.index!, end = start + raw.length;
    const verdict = judgeUrl(raw, siteHost);
    text += value.slice(cursor, start);
    if (verdict.kind === 'strip-params') text += verdict.cleaned;
    else {
      if (verdict.kind === 'remove-sentence') forced.push({start: text.length, end: text.length + raw.length});
      text += raw;
    }
    cursor = end;
  }
  text += value.slice(cursor);
  // 2. Drop each sentence / line that still carries referral information.
  const doomed = units(text).filter(unit => forced.some(range => range.start < unit.end && range.end > unit.start)
    || containsReferralInformation(text.slice(unit.start, unit.end), knownCodes, siteHost));
  if (doomed.some(unit => isHeadingLine(text, unit))) return {text: value, blocked: true, reason: REFERRAL_MESSAGES.heading};
  for (const unit of [...doomed].reverse()) {
    let {start, end} = unit;
    while (end < text.length && /[^\S\n]/.test(text[end])) end++;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const nextBreak = text.indexOf('\n', end);
    const lineEnd = nextBreak < 0 ? text.length : nextBreak;
    const rest = text.slice(lineStart, start) + text.slice(end, lineEnd);
    if (!rest.trim()) {
      // The whole line goes; remove its line break too, without merging neighbouring paragraphs.
      start = lineStart;
      end = nextBreak < 0 ? lineEnd : lineEnd + 1;
      if (nextBreak < 0 && start > 0) start--;
    }
    text = text.slice(0, start) + text.slice(end);
  }
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  const blocked = containsReferralInformation(text, knownCodes, siteHost);
  return {text, blocked, reason: blocked ? REFERRAL_MESSAGES.blocked : undefined};
}

export function stripReferralInformation(value: string, knownCodes: readonly string[] = [], siteHost?: string): string {
  return stripReferralDetailed(value, knownCodes, siteHost).text;
}

// For target-link protection only: paths may be percent-encoded or written in Chinese, so accept non-ASCII
// characters but stop at whitespace, quotes and CJK punctuation.
const TARGET_LINK_PATTERN = /https?:\/\/[^\s<>"'`，。；！？、）】」』《》]+/g;

function decodedPath(url: URL): string {
  try { return decodeURIComponent(url.pathname).replace(/\/+$/, ''); } catch { return url.pathname.replace(/\/+$/, ''); }
}

function linksTo(text: string, targetUrl: string): boolean {
  try {
    const target = new URL(targetUrl), host = hostOf(target), path = decodedPath(target);
    for (const match of text.matchAll(TARGET_LINK_PATTERN)) {
      try {
        const url = new URL(trimUrl(match[0]));
        if (hostOf(url) === host && (path === '' || decodedPath(url) === path)) return true;
      } catch { /* ignore malformed */ }
    }
  } catch { /* no target to protect */ }
  return false;
}

export function prepareReferralFreeDraft(draft: NonNullable<Task['draft']>, site: Pick<Site, 'description' | 'url'> & Partial<Pick<Site,'referralCodes'>>, targetUrl?: string) {
  const codes = siteReferralCodes(site);
  let siteHost: string | undefined;
  try { siteHost = hostOf(new URL(site.url)); } catch { siteHost = undefined; }
  const title = stripReferralDetailed(draft.title, codes, siteHost);
  const description = stripReferralDetailed(draft.description, codes, siteHost);
  const body = stripReferralDetailed(draft.body, codes, siteHost);
  const cleaned = {title: title.text, description: description.text, body: body.text};
  const changed = cleaned.title !== draft.title || cleaned.description !== draft.description || cleaned.body !== draft.body;
  let reason = title.reason ?? description.reason ?? body.reason;
  let blocked = title.blocked || description.blocked || body.blocked || !cleaned.title.trim() || (!!draft.body.trim() && !cleaned.body.trim());
  if (!blocked && targetUrl && changed && linksTo(draft.body, targetUrl) && !linksTo(cleaned.body, targetUrl)) {
    blocked = true;
    reason = REFERRAL_MESSAGES.targetLost;
  }
  return {draft: cleaned, changed, blocked, reason: blocked ? reason ?? REFERRAL_MESSAGES.blocked : undefined};
}
