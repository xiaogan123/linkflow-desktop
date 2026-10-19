import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as ed25519Sign,
  verify as ed25519Verify,
} from 'node:crypto';

export const SWARMMEMO_ORIGIN = 'https://swarmmemo.com';
export const SWARMMEMO_SERVICE = 'swarmmemo.com';
export const SWARMMEMO_COMMAND_URL = `${SWARMMEMO_ORIGIN}/v1/command`;
export const SWARMMEMO_ROBOTS_URL = `${SWARMMEMO_ORIGIN}/robots.txt`;
export const SWARMMEMO_RECOVERY_URL = `${SWARMMEMO_ORIGIN}/api/messages?room=lobby&page=main&limit=200&sort=new&scope=all`;
export const SWARMMEMO_ROOM = 'lobby';
export const SWARMMEMO_PAGE = 'main';
export const SWARMMEMO_DATA = '{"schema":1,"format":"markdown"}';
export const SWARMMEMO_MAX_TEXT_BYTES = 16 * 1024;
export const SWARMMEMO_MAX_RESPONSE_BYTES = 512 * 1024;
export const SWARMMEMO_DISCLOSURE = 'Publisher disclosure: This article was prepared and published by an automated assistant acting for the site owner. Its claims are based on the cited public material, not personal use.';
/** Only for validating articles that already have a saved publication receipt. */
export const SWARMMEMO_LEGACY_DISCLOSURE = 'Publisher disclosure: This article was prepared and published by Linkflow Assistant, an automated agent acting for the site owner. Its claims are based on the cited public material, not personal use.';

const HEX_32 = /^[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_64 = /^[A-Za-z0-9_-]{86}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const pending = new Set<Promise<unknown>>();

export interface SwarmMemoCommand {
  operation: 'post';
  room: typeof SWARMMEMO_ROOM;
  page: typeof SWARMMEMO_PAGE;
  text: string;
  kind: 'note';
  request_id: string;
  public_key: string;
  timestamp: number;
  nonce: string;
  data: typeof SWARMMEMO_DATA;
  signature: string;
}

export interface SwarmMemoIdentitySecret {
  version: 1;
  kind: 'swarmmemo_identity';
  accountId: string;
  privateKeyPkcs8: string;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
}

export interface SwarmMemoPublicationIntent {
  version: 1;
  kind: 'swarmmemo_publication';
  operationId: string;
  accountId: string;
  fingerprint: string;
  requestId: string;
  targetUrl: string;
  sourceHash: string;
  bodySha256: string;
  canonicalSha256: string;
  requestHash: string;
  createdAt: string;
  command: SwarmMemoCommand;
  dispatchBudget: 1;
}

export interface SwarmMemoOpaqueResponse {
  version: 1;
  capturedAt: string;
  requestUrl: typeof SWARMMEMO_COMMAND_URL;
  status: number;
  contentType: string;
  responseUrl: string;
  redirected: boolean;
  responseType: string;
  headers: Array<[string, string]>;
  bodyBase64: string;
  bodySha256: string;
  bodyComplete: boolean;
}

export interface SwarmMemoPublicationSecret {
  version: 1;
  kind: 'swarmmemo_publication_secret';
  intent: SwarmMemoPublicationIntent;
  dispatchedAt?: string;
  opaqueResponse?: SwarmMemoOpaqueResponse;
}

export interface SwarmMemoReceipt {
  id: string;
  sha256: string;
  cursor: string;
  duplicate?: boolean;
  acceptedAt: number;
  requestId: string;
  readBack: string;
  visibility: 'public' | 'unknown';
  canonicalSha256: string;
}

export interface SwarmMemoMessage {
  type: 'message';
  visibility: 'public';
  archiveEligible: boolean;
  id: string;
  room: typeof SWARMMEMO_ROOM;
  page: typeof SWARMMEMO_PAGE;
  text: string;
  kind: 'note';
  author: string;
  publicKey: string;
  signature: string;
  signedPayload: string;
  createdAt: number;
  sha256: string;
  hidden: false;
  format: 'markdown';
  displayFormat: 'markdown';
  via: 'command';
}

export interface SwarmMemoNativeRequest { url: string; method: 'GET'; resourceType: 'mainFrame' | 'stylesheet' }
export interface SwarmMemoRenderedPage {
  url: string;
  documentTitle: string;
  headings: Array<{text: string; visible: boolean}>;
  candidates: Array<{selector: string; html: string; text: string; allTextVisible: boolean; links: Array<{href: string; rel: string[]; text: string; visible: boolean}>}>;
  robots: Array<{name: string; content: string}>;
  canonicals: string[];
  hasRefresh: boolean;
  hasPasswordGate: boolean;
  hasLoginGate: boolean;
  responseRobots: string[];
  responseLinks: string[];
  responseStatus: number;
  responseMediaType: string;
  responseBodyBytes: number;
  responseEncodedBodyBytes: number;
  nativeRequests: SwarmMemoNativeRequest[];
}
export interface SwarmMemoRenderHooks {
  onBeforeRequest?: (request: SwarmMemoNativeRequest) => void;
  onResponseHeaders?: (headers: Record<string, string[]>) => void | Promise<void>;
  onScreenshot?: (png: Uint8Array) => void | Promise<void>;
}
export interface SwarmMemoDependencies {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  renderPage?: (url: string, signal: AbortSignal, hooks?: SwarmMemoRenderHooks) => Promise<SwarmMemoRenderedPage>;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => Date;
}
export interface SwarmMemoMutationIdentity {kind: 'publication'; operationId: string; requestHash: string; accountId: string; sourceHash: string; requestId: string}
export interface SwarmMemoAcceptanceEvidence {apiMatched: true; rendered: true; nativeTarget: true; robotsAllowed: true; pageIndexable: true; checkedAt: string}
export interface SwarmMemoPublicationPersistence {
  loadSecret(): Promise<SwarmMemoPublicationSecret | undefined>;
  persistIntent(intent: SwarmMemoPublicationIntent): Promise<void>;
  armDispatch(intent: SwarmMemoPublicationIntent): Promise<void>;
  assertAuthorized(intent: SwarmMemoPublicationIntent): true;
  persistOpaqueResponse(intent: SwarmMemoPublicationIntent, response: SwarmMemoOpaqueResponse): Promise<void>;
  preserveReceipt(intent: SwarmMemoPublicationIntent, receipt: SwarmMemoReceipt, publicUrl?: string): Promise<void>;
  promotePublished(intent: SwarmMemoPublicationIntent, receipt: SwarmMemoReceipt, publicUrl: string, evidence: SwarmMemoAcceptanceEvidence): Promise<void>;
}

export const swarmMemoHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const swarmMemoEntryJsonUrl = (id: string) => { if (!HEX_32.test(id)) throw Error('SwarmMemo message id 无效'); return `${SWARMMEMO_ORIGIN}/e/${id}?format=json`; };
export const swarmMemoEntryBaseUrl = (id: string) => { if (!HEX_32.test(id)) throw Error('SwarmMemo message id 无效'); return `${SWARMMEMO_ORIGIN}/e/${id}`; };

function exactDate(value: unknown): value is string { if (typeof value !== 'string') return false; const time = Date.parse(value); return Number.isFinite(time) && new Date(time).toISOString() === value; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exactObject(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> { if (!record(value)) return false; const keys = Object.keys(value); return required.every(key => keys.includes(key)) && keys.every(key => required.includes(key) || optional.includes(key)); }
function canonicalHttps(value: unknown): string | undefined { if (typeof value !== 'string' || value.length > 2048) return; try { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.port) return; return url.href; } catch { return; } }

export function generateSwarmMemoIdentity(accountId: string, createdAt: string): SwarmMemoIdentitySecret {
  if (!UUID.test(accountId) || !exactDate(createdAt)) throw Error('SwarmMemo 账号信息无效');
  const pair = generateKeyPairSync('ed25519');
  const privateKeyPkcs8 = Buffer.from(pair.privateKey.export({format: 'der', type: 'pkcs8'})).toString('base64');
  const spki = Buffer.from(pair.publicKey.export({format: 'der', type: 'spki'}));
  if (spki.length !== SPKI_PREFIX.length + 32 || !spki.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)) throw Error('SwarmMemo Ed25519 公钥格式无效');
  const raw = spki.subarray(SPKI_PREFIX.length);
  return {version: 1, kind: 'swarmmemo_identity', accountId, privateKeyPkcs8, publicKey: raw.toString('base64url'), fingerprint: swarmMemoHash(raw), createdAt};
}

export function validSwarmMemoIdentitySecret(value: unknown): value is SwarmMemoIdentitySecret {
  if (!exactObject(value, ['version', 'kind', 'accountId', 'privateKeyPkcs8', 'publicKey', 'fingerprint', 'createdAt']) || value.version !== 1 || value.kind !== 'swarmmemo_identity' || typeof value.accountId !== 'string' || !UUID.test(value.accountId) || typeof value.privateKeyPkcs8 !== 'string' || typeof value.publicKey !== 'string' || !BASE64URL_32.test(value.publicKey) || typeof value.fingerprint !== 'string' || !SHA.test(value.fingerprint) || !exactDate(value.createdAt)) return false;
  try {
    const privateKey = createPrivateKey({key: Buffer.from(value.privateKeyPkcs8, 'base64'), format: 'der', type: 'pkcs8'});
    const spki = Buffer.from(createPublicKey(privateKey).export({format: 'der', type: 'spki'}));
    const raw = spki.subarray(-32);
    return spki.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX) && raw.toString('base64url') === value.publicKey && swarmMemoHash(raw) === value.fingerprint;
  } catch { return false; }
}

const canonicalFieldOrder = ['operation', 'room', 'page', 'text', 'kind', 'reply_to', 'to', 'request_id', 'public_key', 'timestamp', 'nonce', 'handle', 'visibility', 'members', 'target', 'amount', 'ttl', 'message_id', 'cursor', 'older', 'limit', 'query', 'before', 'reason', 'data', 'filename', 'media_type', 'attachments', 'delegation', 'private_read'] as const;
function safeJson(value: unknown) { return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
export function swarmMemoCommandBody(command: SwarmMemoCommand) { return safeJson(command); }
export function swarmMemoCanonical(command: Omit<SwarmMemoCommand, 'signature'>): string {
  const ordered: Record<string, unknown> = {};
  for (const field of canonicalFieldOrder) {
    const value = (command as unknown as Record<string, unknown>)[field];
    if (value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0) continue;
    ordered[field] = value;
  }
  return safeJson({version: 1, service: SWARMMEMO_SERVICE, command: ordered});
}

export function createSwarmMemoCommand(input: {text: string; requestId: string; timestamp: number; nonce: string; identity: SwarmMemoIdentitySecret}): {command: SwarmMemoCommand; canonical: string; canonicalSha256: string; body: string; sourceHash: string; requestHash: string} {
  if (!validSwarmMemoIdentitySecret(input.identity) || !HEX_32.test(input.requestId) || !HEX_32.test(input.nonce) || !Number.isSafeInteger(input.timestamp) || input.timestamp < 1_500_000_000 || !input.text || Buffer.byteLength(input.text, 'utf8') > SWARMMEMO_MAX_TEXT_BYTES || Buffer.from(input.text, 'utf8').toString('utf8') !== input.text) throw Error('SwarmMemo 发布命令无效');
  const unsigned: Omit<SwarmMemoCommand, 'signature'> = {operation: 'post', room: SWARMMEMO_ROOM, page: SWARMMEMO_PAGE, text: input.text, kind: 'note', request_id: input.requestId, public_key: input.identity.publicKey, timestamp: input.timestamp, nonce: input.nonce, data: SWARMMEMO_DATA};
  const canonical = swarmMemoCanonical(unsigned);
  const privateKey = createPrivateKey({key: Buffer.from(input.identity.privateKeyPkcs8, 'base64'), format: 'der', type: 'pkcs8'});
  const signature = ed25519Sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64url');
  const command: SwarmMemoCommand = {...unsigned, signature};
  const body = safeJson(command);
  return {command, canonical, canonicalSha256: swarmMemoHash(canonical), body, sourceHash: swarmMemoHash(input.text), requestHash: swarmMemoHash(`POST\n${SWARMMEMO_COMMAND_URL}\ncontent-type:application/json\n\n${body}`)};
}

export function verifySwarmMemoCommand(command: SwarmMemoCommand, expectedFingerprint?: string): boolean {
  try {
    if (!validSwarmMemoCommand(command) || expectedFingerprint && swarmMemoHash(Buffer.from(command.public_key, 'base64url')) !== expectedFingerprint) return false;
    const {signature, ...unsigned} = command;
    return ed25519Verify(null, Buffer.from(swarmMemoCanonical(unsigned), 'utf8'), createPublicKey({key: Buffer.concat([SPKI_PREFIX, Buffer.from(command.public_key, 'base64url')]), format: 'der', type: 'spki'}), Buffer.from(signature, 'base64url'));
  } catch { return false; }
}

export function validSwarmMemoCommand(value: unknown): value is SwarmMemoCommand {
  if (!exactObject(value, ['operation', 'room', 'page', 'text', 'kind', 'request_id', 'public_key', 'timestamp', 'nonce', 'data', 'signature']) || value.operation !== 'post' || value.room !== SWARMMEMO_ROOM || value.page !== SWARMMEMO_PAGE || value.kind !== 'note' || value.data !== SWARMMEMO_DATA || typeof value.text !== 'string' || !value.text || Buffer.byteLength(value.text, 'utf8') > SWARMMEMO_MAX_TEXT_BYTES || typeof value.request_id !== 'string' || !HEX_32.test(value.request_id) || typeof value.public_key !== 'string' || !BASE64URL_32.test(value.public_key) || !Number.isSafeInteger(value.timestamp) || Number(value.timestamp) < 1_500_000_000 || typeof value.nonce !== 'string' || !HEX_32.test(value.nonce) || typeof value.signature !== 'string' || !BASE64URL_64.test(value.signature)) return false;
  return true;
}

export function validSwarmMemoPublicationIntent(value: unknown): value is SwarmMemoPublicationIntent {
  if (!exactObject(value, ['version', 'kind', 'operationId', 'accountId', 'fingerprint', 'requestId', 'targetUrl', 'sourceHash', 'bodySha256', 'canonicalSha256', 'requestHash', 'createdAt', 'command', 'dispatchBudget']) || value.version !== 1 || value.kind !== 'swarmmemo_publication' || typeof value.operationId !== 'string' || !/^swarmmemo_post_[a-f0-9]{32}$/.test(value.operationId) || typeof value.accountId !== 'string' || !UUID.test(value.accountId) || typeof value.fingerprint !== 'string' || !SHA.test(value.fingerprint) || typeof value.requestId !== 'string' || !HEX_32.test(value.requestId) || !canonicalHttps(value.targetUrl) || typeof value.sourceHash !== 'string' || !SHA.test(value.sourceHash) || typeof value.bodySha256 !== 'string' || !SHA.test(value.bodySha256) || typeof value.canonicalSha256 !== 'string' || !SHA.test(value.canonicalSha256) || typeof value.requestHash !== 'string' || !SHA.test(value.requestHash) || !exactDate(value.createdAt) || value.dispatchBudget !== 1 || !validSwarmMemoCommand(value.command)) return false;
  const {signature, ...unsigned} = value.command;
  const body = safeJson(value.command);
  return value.command.request_id === value.requestId && value.command.timestamp === Math.floor(Date.parse(value.createdAt) / 1000) && swarmMemoHash(value.command.text) === value.sourceHash && value.sourceHash === value.bodySha256 && swarmMemoHash(Buffer.from(value.command.public_key, 'base64url')) === value.fingerprint && swarmMemoHash(swarmMemoCanonical(unsigned)) === value.canonicalSha256 && swarmMemoHash(`POST\n${SWARMMEMO_COMMAND_URL}\ncontent-type:application/json\n\n${body}`) === value.requestHash && verifySwarmMemoCommand(value.command, value.fingerprint);
}

export function validSwarmMemoOpaque(value: unknown): value is SwarmMemoOpaqueResponse {
  if (!exactObject(value, ['version', 'capturedAt', 'requestUrl', 'status', 'contentType', 'responseUrl', 'redirected', 'responseType', 'headers', 'bodyBase64', 'bodySha256', 'bodyComplete']) || value.version !== 1 || !exactDate(value.capturedAt) || value.requestUrl !== SWARMMEMO_COMMAND_URL || !Number.isSafeInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599 || typeof value.contentType !== 'string' || value.contentType.length > 512 || typeof value.responseUrl !== 'string' || value.responseUrl.length > 2048 || typeof value.redirected !== 'boolean' || typeof value.responseType !== 'string' || value.responseType.length > 64 || !Array.isArray(value.headers) || value.headers.length > 128 || value.headers.some(header => !Array.isArray(header) || header.length !== 2 || typeof header[0] !== 'string' || typeof header[1] !== 'string' || header[0].length > 256 || header[1].length > 8192) || typeof value.bodyBase64 !== 'string' || typeof value.bodySha256 !== 'string' || !SHA.test(value.bodySha256) || typeof value.bodyComplete !== 'boolean') return false;
  try { const bytes = Buffer.from(value.bodyBase64, 'base64'); return bytes.length <= SWARMMEMO_MAX_RESPONSE_BYTES && bytes.toString('base64') === value.bodyBase64 && swarmMemoHash(bytes) === value.bodySha256; } catch { return false; }
}

export function validSwarmMemoPublicationSecret(value: unknown): value is SwarmMemoPublicationSecret {
  return exactObject(value, ['version', 'kind', 'intent'], ['dispatchedAt', 'opaqueResponse']) && value.version === 1 && value.kind === 'swarmmemo_publication_secret' && validSwarmMemoPublicationIntent(value.intent) && (value.dispatchedAt === undefined || exactDate(value.dispatchedAt)) && (value.opaqueResponse === undefined || validSwarmMemoOpaque(value.opaqueResponse));
}

function strictJson(text: string): unknown | undefined {
  let index = 0, duplicate = false;
  const whitespace = () => { while (/\s/u.test(text[index] ?? '')) index++; };
  const stringValue = () => { if (text[index++] !== '"') throw 0; const start = index - 1; for (;;) { const char = text[index++]; if (char === undefined || /[\u0000-\u001f]/.test(char)) throw 0; if (char === '"') break; if (char === '\\') { const escaped = text[index++]; if (!escaped || !/^["\\/bfnrtu]$/.test(escaped)) throw 0; if (escaped === 'u') { const hex = text.slice(index, index + 4); if (!/^[a-f0-9]{4}$/i.test(hex)) throw 0; index += 4; } } } return JSON.parse(text.slice(start, index)) as string; };
  const value = (): void => { whitespace(); const char = text[index]; if (char === '"') { stringValue(); return; } if (char === '{') { index++; whitespace(); const keys = new Set<string>(); if (text[index] === '}') { index++; return; } for (;;) { whitespace(); const key = stringValue(); if (keys.has(key)) duplicate = true; keys.add(key); whitespace(); if (text[index++] !== ':') throw 0; value(); whitespace(); if (text[index] === ',') { index++; continue; } if (text[index++] !== '}') throw 0; return; } } if (char === '[') { index++; whitespace(); if (text[index] === ']') { index++; return; } for (;;) { value(); whitespace(); if (text[index] === ',') { index++; continue; } if (text[index++] !== ']') throw 0; return; } } const match = text.slice(index).match(/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/); if (!match) throw 0; index += match[0].length; };
  try { value(); whitespace(); if (index !== text.length || duplicate) return; return JSON.parse(text) as unknown; } catch { return; }
}

export function parseSwarmMemoOpaque(value: SwarmMemoOpaqueResponse): unknown | undefined {
  if (!validSwarmMemoOpaque(value) || value.status !== 200 || !value.bodyComplete || value.redirected || value.responseType === 'opaqueredirect' || value.responseUrl && value.responseUrl !== SWARMMEMO_COMMAND_URL || value.contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return;
  try { return strictJson(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.from(value.bodyBase64, 'base64'))); } catch { return; }
}

export function parseSwarmMemoReceipt(value: unknown, intent: SwarmMemoPublicationIntent): SwarmMemoReceipt | undefined {
  if (!record(value) || value.ok !== true || !record(value.receipt) || !record(value.shared_receipt)) return;
  const receipt = value.receipt, shared = value.shared_receipt;
  if (!exactObject(receipt, ['id', 'sha256', 'cursor', 'duplicate', 'accepted_at'], ['request_id']) || typeof receipt.id !== 'string' || !HEX_32.test(receipt.id) || receipt.sha256 !== intent.bodySha256 || typeof receipt.cursor !== 'string' || !receipt.cursor || receipt.cursor.length > 512 || typeof receipt.duplicate !== 'boolean' || !Number.isSafeInteger(receipt.accepted_at) || Number(receipt.accepted_at) < 1_500_000_000 || receipt.request_id !== undefined && receipt.request_id !== intent.requestId) return;
  if (!exactObject(shared, ['schema', 'service', 'agreement', 'acceptance', 'publication']) || shared.schema !== 'shared-receipt/1' || shared.service !== SWARMMEMO_SERVICE || !record(shared.agreement) || !record(shared.acceptance) || !record(shared.publication)) return;
  const agreement = shared.agreement, acceptance = shared.acceptance, publication = shared.publication;
  if (!exactObject(agreement, ['body_sha256', 'signature', 'spec', 'canonical_sha256', 'vector']) || agreement.body_sha256 !== intent.bodySha256 || agreement.signature !== 'verified' || agreement.spec !== 'swarmmemo-canonical/1' || agreement.canonical_sha256 !== intent.canonicalSha256 || canonicalHttps(agreement.vector) === undefined) return;
  if (!exactObject(acceptance, ['id', 'accepted_at', 'duplicate', 'request_id']) || acceptance.id !== receipt.id || acceptance.accepted_at !== receipt.accepted_at || acceptance.duplicate !== receipt.duplicate || acceptance.request_id !== intent.requestId) return;
  if (!exactObject(publication, ['read_back', 'visibility', 'state']) || publication.read_back !== swarmMemoEntryJsonUrl(receipt.id) || !['public', 'unknown'].includes(String(publication.visibility)) || publication.state !== 'unknown') return;
  return {id: receipt.id, sha256: receipt.sha256 as string, cursor: receipt.cursor, duplicate: receipt.duplicate, acceptedAt: Number(receipt.accepted_at), requestId: intent.requestId, readBack: publication.read_back, visibility: publication.visibility as 'public' | 'unknown', canonicalSha256: intent.canonicalSha256};
}

export function parseSwarmMemoMessage(value: unknown): SwarmMemoMessage | undefined {
  const message = record(value) && record(value.message) ? value.message : value;
  if (!record(message) || message.type !== 'message' || message.visibility !== 'public' || message.archive_eligible !== true || typeof message.id !== 'string' || !HEX_32.test(message.id) || message.room !== SWARMMEMO_ROOM || message.page !== SWARMMEMO_PAGE || typeof message.text !== 'string' || !message.text || Buffer.byteLength(message.text, 'utf8') > SWARMMEMO_MAX_TEXT_BYTES || message.kind !== 'note' || typeof message.author !== 'string' || !SHA.test(message.author) || typeof message.public_key !== 'string' || !BASE64URL_32.test(message.public_key) || typeof message.signature !== 'string' || !BASE64URL_64.test(message.signature) || typeof message.signed_payload !== 'string' || message.signed_payload.length > 256 * 1024 || !Number.isSafeInteger(message.created_at) || Number(message.created_at) < 1_500_000_000 || typeof message.sha256 !== 'string' || !SHA.test(message.sha256) || message.hidden !== false || message.format !== 'markdown' || message.display_format !== 'markdown' || message.via !== 'command') return;
  return {type: 'message', visibility: 'public', archiveEligible: true, id: message.id, room: SWARMMEMO_ROOM, page: SWARMMEMO_PAGE, text: message.text, kind: 'note', author: message.author, publicKey: message.public_key, signature: message.signature, signedPayload: message.signed_payload, createdAt: Number(message.created_at), sha256: message.sha256, hidden: false, format: 'markdown', displayFormat: 'markdown', via: 'command'};
}

/** The public entry endpoint wraps its one immutable message in a list envelope. */
export function parseSwarmMemoEntry(value: unknown): SwarmMemoMessage | undefined {
  if (record(value) && 'messages' in value) {
    if ('message' in value || value.ok !== true || typeof value.generation !== 'string' || !value.generation || typeof value.next_cursor !== 'string' || !Array.isArray(value.messages) || value.messages.length !== 1 || !record(value.data) || value.data.has_more !== false) return;
    return parseSwarmMemoMessage(value.messages[0]);
  }
  return parseSwarmMemoMessage(value);
}

export function matchesSwarmMemoMessage(message: SwarmMemoMessage, intent: SwarmMemoPublicationIntent): boolean {
  const expectedCanonical = (() => { const {signature: _signature, ...unsigned} = intent.command; return swarmMemoCanonical(unsigned); })();
  return message.id.length === 32 && message.text === intent.command.text && message.sha256 === intent.bodySha256 && message.author === intent.fingerprint && message.publicKey === intent.command.public_key && message.signature === intent.command.signature && message.signedPayload === expectedCanonical && verifySwarmMemoCommand(intent.command, intent.fingerprint);
}

class PartialBody extends Error { constructor(readonly bytes: Uint8Array) { super('partial_body'); } }
function aborted():Error { const error=new Error('SwarmMemo 请求已取消或超时');error.name='AbortError';return error }
function abortable<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted)return Promise.reject(aborted());
  return new Promise<T>((resolve,reject)=>{let settled=false;const onAbort=()=>{if(settled)return;settled=true;signal.removeEventListener('abort',onAbort);reject(aborted())};signal.addEventListener('abort',onAbort,{once:true});operation.then(value=>{if(settled)return;settled=true;signal.removeEventListener('abort',onAbort);resolve(value)},error=>{if(settled)return;settled=true;signal.removeEventListener('abort',onAbort);reject(error)})});
}
async function bounded(response: Response, signal: AbortSignal) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > SWARMMEMO_MAX_RESPONSE_BYTES)) throw new PartialBody(new Uint8Array());
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), parts: Buffer[] = []; let size = 0;
  try { for (;;) { const next = await abortable(reader.read(),signal); if (signal.aborted) throw new PartialBody(Buffer.concat(parts)); if (next.done) break; const chunk = Buffer.from(next.value); if (size + chunk.length > SWARMMEMO_MAX_RESPONSE_BYTES) throw new PartialBody(Buffer.concat(parts)); parts.push(chunk); size += chunk.length; } return Buffer.concat(parts); }
  catch (error) { void reader.cancel().catch(()=>{});if (error instanceof PartialBody) throw error; throw new PartialBody(Buffer.concat(parts)); }
  finally { try { reader.releaseLock(); } catch {} }
}
function opaque(response: Response, bytes: Uint8Array, now: () => Date, complete: boolean): SwarmMemoOpaqueResponse { return {version: 1, capturedAt: now().toISOString(), requestUrl: SWARMMEMO_COMMAND_URL, status: response.status, contentType: (response.headers.get('content-type') ?? '').slice(0, 512), responseUrl: response.url, redirected: response.redirected, responseType: response.type, headers: [...response.headers.entries()].map(([key, item]) => [key.toLowerCase(), item] as [string, string]).sort(), bodyBase64: Buffer.from(bytes).toString('base64'), bodySha256: swarmMemoHash(bytes), bodyComplete: complete}; }

export async function swarmMemoMutation(init: RequestInit, persist: (value: SwarmMemoOpaqueResponse) => Promise<void>, authorize: () => true, deps: SwarmMemoDependencies = {}): Promise<'captured' | 'unknown' | 'not_authorized'> {
  if (init.method !== 'POST') throw Error('SwarmMemo 写路由无效');
  // This is deliberately synchronous and immediately adjacent to transport.
  // Yielding here would let a revoked/replaced encrypted intent pass a stale check.
  try { if (authorize() !== true) return 'not_authorized'; } catch { return 'not_authorized'; }
  const now = deps.now ?? (() => new Date()), controller = new AbortController(), timeout = Math.min(60_000, Math.max(100, deps.timeoutMs ?? 25_000));
  const abort = () => controller.abort(); deps.signal?.addEventListener('abort', abort, {once: true}); if (deps.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.();
  let response: Response | undefined;
  try {
    const operation = (deps.fetch ?? ((url: string, request: RequestInit) => fetch(url, request)))(SWARMMEMO_COMMAND_URL, {...init, signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'});
    const tracked = Promise.resolve(operation).then(async value => { response = value; try { const bytes = await bounded(value, controller.signal); await persist(opaque(value, bytes, now, true)); } catch (error) { if (error instanceof PartialBody) await persist(opaque(value, error.bytes, now, false)); throw error; } });
    let held: Promise<unknown>; held = tracked.finally(() => pending.delete(held)); pending.add(held); await held; return 'captured';
  } catch { return 'unknown'; }
  finally { clearTimeout(timer); deps.signal?.removeEventListener('abort', abort); if (response?.body && controller.signal.aborted) try { await response.body.cancel(); } catch {} }
}

export async function readSwarmMemoText(url: string, accept: 'application/json' | 'text/html' | 'text/plain', deps: SwarmMemoDependencies = {}) {
  const initial=new URL(url),entry=accept==='text/html'?initial.pathname.match(/^\/e\/([a-f0-9]{32})$/):undefined;
  const exactInitial=initial.origin===SWARMMEMO_ORIGIN&&!initial.username&&!initial.password&&!initial.port&&!initial.hash&&(
    accept==='text/html'?!!entry&&!initial.search:
    accept==='text/plain'?initial.href===SWARMMEMO_ROBOTS_URL:
    initial.href===SWARMMEMO_RECOVERY_URL||/^https:\/\/swarmmemo\.com\/e\/[a-f0-9]{32}\?format=json$/.test(initial.href)
  );
  if(!exactInitial)throw Error('SwarmMemo 只读地址无效');
  const controller=new AbortController(),timeout=Math.min(60_000,Math.max(100,deps.timeoutMs??25_000)),parentAbort=()=>controller.abort();
  deps.signal?.addEventListener('abort',parentAbort,{once:true});if(deps.signal?.aborted)controller.abort();const timer=setTimeout(()=>controller.abort(),timeout);
  const request=deps.fetch??((target:string,init:RequestInit)=>fetch(target,init));let current=initial.href,redirects=0;const seen=new Set([current]);
  try{
    for(;;){
      if(controller.signal.aborted)throw aborted();
      const operation=Promise.resolve(request(current,{method:'GET',headers:{accept},signal:controller.signal,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'}));
      let response:Response;try{response=await abortable(operation,controller.signal)}catch(error){void operation.then(value=>value.body?.cancel()).catch(()=>{});throw error}
      if(response.redirected||response.url&&response.url!==current){void response.body?.cancel();throw Error('SwarmMemo 只读响应越过了逐跳校验')}
      if([301,302,303,307,308].includes(response.status)){
        const location=response.headers.get('location');void response.body?.cancel();if(accept!=='text/html'||!entry||!location||redirects>=2)throw Error('SwarmMemo 只读重定向无效');
        let next:URL;try{next=new URL(location,current)}catch{throw Error('SwarmMemo 只读重定向无效')}
        if(next.origin!==SWARMMEMO_ORIGIN||next.username||next.password||next.port||next.search||next.hash||!new RegExp(`^/e/${entry[1]}/[a-z0-9][a-z0-9-]{0,127}$`).test(next.pathname)||seen.has(next.href))throw Error('SwarmMemo 只读重定向越界');
        current=next.href;seen.add(current);redirects++;continue;
      }
      if(response.status!==200||accept==='text/html'&&(!entry||current!==initial.href&&!new RegExp(`^${SWARMMEMO_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/e/${entry[1]}/[a-z0-9][a-z0-9-]{0,127}$`).test(current))||accept!=='text/html'&&current!==initial.href){void response.body?.cancel();throw Error(`SwarmMemo 只读响应无效：HTTP ${response.status}`)}
      const bytes=await bounded(response,controller.signal),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);return {text,headers:response.headers,url:current};
    }
  }finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',parentAbort)}
}
export async function readSwarmMemoJson(url: string, deps: SwarmMemoDependencies = {}) { const response = await readSwarmMemoText(url, 'application/json', deps); if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw Error('SwarmMemo JSON 类型无效'); const parsed = strictJson(response.text); if (parsed === undefined) throw Error('SwarmMemo JSON 无效'); return parsed; }

export async function recoverSwarmMemoReceipt(intent:SwarmMemoPublicationIntent,deps:SwarmMemoDependencies={}):Promise<SwarmMemoReceipt|undefined>{
  if(!validSwarmMemoPublicationIntent(intent))return;
  const value=await readSwarmMemoJson(SWARMMEMO_RECOVERY_URL,deps),messages=record(value)&&Array.isArray(value.messages)&&value.messages.length<=200?value.messages:undefined;
  if(!messages)return;
  const exact=messages.map(parseSwarmMemoMessage).filter((message):message is SwarmMemoMessage=>!!message&&matchesSwarmMemoMessage(message,intent));
  if(exact.length!==1)return;
  const message=exact[0];
  return {id:message.id,sha256:message.sha256,cursor:'get-only-recovery',acceptedAt:message.createdAt,requestId:intent.requestId,readBack:swarmMemoEntryJsonUrl(message.id),visibility:'public',canonicalSha256:intent.canonicalSha256};
}

export async function drainSwarmMemoPendingOperations(timeoutMs = 5_000) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (pending.size && Date.now() < deadline) await Promise.race([Promise.allSettled([...pending]), new Promise<void>(resolve => { const timer = setTimeout(resolve, deadline - Date.now()); timer.unref?.(); })]);
  return pending.size === 0;
}
export function swarmMemoPendingOperationCount() { return pending.size; }

export const swarmMemoTesting = {canonicalFieldOrder, strictJson};
