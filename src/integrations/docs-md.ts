import { createHash } from 'node:crypto';

const ORIGIN = 'https://docs-md.com';
const CREATE_URL = `${ORIGIN}/api/share`;
const FILENAME = 'publication.md';
const EXPIRY = 'never';
const MAX_CONTENT_CHARS = 120_000;
const MAX_REQUEST_BYTES = 200_000;
const MAX_CREATE_RESPONSE_BYTES = 64 * 1024;
const MAX_RAW_RESPONSE_BYTES = MAX_REQUEST_BYTES;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const EDIT_TOKEN = /^[A-Za-z0-9_-]{32}$/;

type JsonObject = Record<string, unknown>;

export type DocsMdTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface DocsMdIntent {
  operationId: string;
  sourceHash: string;
  requestHash: string;
  createdAt: string;
}

export interface DocsMdReceipt {
  operationId: string;
  id: string;
  publicUrl: string;
  rawUrl: string;
  sourceHash: string;
  requestHash: string;
  expiresAt: 0;
}

export interface DocsMdPublishInput {
  operationId: string;
  /** The caller must finish its independent article review before setting this flag. */
  reviewed: true;
  markdown: string;
  /** Any durable create intent blocks another POST, regardless of its outcome. */
  priorIntent?: DocsMdIntent;
}

export interface DocsMdPersistence {
  /** Must durably create this intent once (or use CAS) before resolving. */
  persistIntent(intent: DocsMdIntent): Promise<void>;
  /** Called before the edit-token store is attempted. */
  persistReceipt(receipt: DocsMdReceipt): Promise<void>;
  /** Must atomically place the token in caller-owned secure storage. */
  persistEditTokenAtomically(secret: { operationId: string; id: string; editToken: string }): Promise<void>;
}

export interface DocsMdDependencies {
  fetch?: DocsMdTransport;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => Date;
}

export type DocsMdUnknownDiagnostic =
  | 'transport_failure'
  | 'redirect_or_response_url'
  | 'http_status'
  | 'response_body_size_or_decode'
  | 'response_media_type'
  | 'response_json'
  | 'schema_success'
  | 'schema_id'
  | 'schema_expiry'
  | 'schema_edit_token'
  | 'schema_rate_limit'
  | 'schema_url';

export type DocsMdPublishResult =
  | { status: 'not_started'; reason: 'intent_not_persisted' }
  | { status: 'blocked'; reason: 'prior_intent'; intent: DocsMdIntent }
  | { status: 'unknown'; reason: 'request_or_response_unknown'; diagnostic: DocsMdUnknownDiagnostic; intent: DocsMdIntent }
  | {
    status: 'created';
    receipt: DocsMdReceipt;
    persistence: { receipt: 'saved'; secret: 'saved' };
  }
  | {
    status: 'created_persistence_unknown';
    receipt: DocsMdReceipt;
    persistence: { receipt: 'saved' | 'unknown'; secret: 'saved' | 'unknown' };
  };

export type DocsMdSourceResult =
  | { status: 'source_matched' }
  | { status: 'source_mismatch' }
  | { status: 'source_unavailable' };

class DocsMdRequestError extends Error {
  constructor(readonly diagnostic: Extract<DocsMdUnknownDiagnostic,
    'transport_failure' | 'redirect_or_response_url' | 'response_body_size_or_decode'> = 'transport_failure') {
    super('Docs MD request failed');
    this.name = 'DocsMdRequestError';
  }
}

const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function safeTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(50, Math.floor(value)));
}

function canonicalMarkdown(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Invalid Docs MD Markdown');
  const markdown = value.trim();
  if (!markdown || markdown.length > MAX_CONTENT_CHARS
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(markdown)
    || Buffer.from(markdown, 'utf8').toString('utf8') !== markdown) {
    throw new TypeError('Invalid Docs MD Markdown');
  }
  return markdown;
}

function canonicalRequest(markdown: string): string {
  const body = JSON.stringify({ content: markdown, filename: FILENAME, expiry: EXPIRY });
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
    throw new TypeError('Docs MD request body is too large');
  }
  return body;
}

function validIntent(value: DocsMdIntent): boolean {
  return OPERATION_ID.test(value.operationId)
    && HASH.test(value.sourceHash)
    && HASH.test(value.requestHash)
    && Number.isFinite(Date.parse(value.createdAt));
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && ID.test(value);
}

function validEditToken(value: unknown): value is string {
  if (typeof value !== 'string' || !EDIT_TOKEN.test(value)) return false;
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === 24 && bytes.toString('base64url') === value;
  } catch {
    return false;
  }
}

function publicUrl(id: string): string {
  return `${ORIGIN}/${id}`;
}

function rawUrl(id: string): string {
  return `${ORIGIN}/raw/${id}`;
}

function exactUrl(value: unknown, expected: string): value is string {
  if (typeof value !== 'string' || value !== expected || value.includes('\\')) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.origin === ORIGIN
      && !parsed.username && !parsed.password && !parsed.port
      && !parsed.search && !parsed.hash && parsed.toString() === expected;
  } catch {
    return false;
  }
}

function discard(response: Response): void {
  if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal, disposeLate?: (value: T) => void): Promise<T> {
  if (signal.aborted) {
    void promise.then(value => disposeLate?.(value), () => undefined);
    return Promise.reject(new DocsMdRequestError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const aborted = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      reject(new DocsMdRequestError());
    };
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', aborted);
      if (settled) {
        disposeLate?.(value);
        return;
      }
      settled = true;
      resolve(value);
    }, () => {
      signal.removeEventListener('abort', aborted);
      if (settled) return;
      settled = true;
      reject(new DocsMdRequestError());
    });
  });
}

async function readBounded(response: Response, maximum: number, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    discard(response);
    throw new DocsMdRequestError('response_body_size_or_decode');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) throw new DocsMdRequestError('response_body_size_or_decode');
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof DocsMdRequestError) throw error;
    throw new DocsMdRequestError();
  } finally {
    reader.releaseLock();
  }
  try {
    // Preserve a leading UTF-8 BOM as U+FEFF. Raw verification is byte-exact
    // with the normalized source, and JSON with an unexpected BOM must fail closed.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));
  } catch {
    throw new DocsMdRequestError('response_body_size_or_decode');
  }
}

async function fixedRequest(
  url: string,
  method: 'GET' | 'POST',
  maximum: number,
  dependencies: DocsMdDependencies,
  body?: string,
): Promise<{ response: Response; text: string }> {
  const create = url === CREATE_URL && method === 'POST' && typeof body === 'string';
  const read = method === 'GET' && body === undefined && (() => {
    try {
      const parsed = new URL(url);
      return parsed.origin === ORIGIN && /^\/raw\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parsed.pathname)
        && !parsed.search && !parsed.hash && !parsed.username && !parsed.password && !parsed.port;
    } catch {
      return false;
    }
  })();
  if (!create && !read) throw new DocsMdRequestError();
  if (dependencies.signal?.aborted) throw new DocsMdRequestError();

  const controller = new AbortController();
  const externallyAborted = () => controller.abort();
  dependencies.signal?.addEventListener('abort', externallyAborted, { once: true });
  if (dependencies.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), safeTimeout(dependencies.timeoutMs));
  timer.unref?.();
  let response: Response | undefined;
  let bodyHandled = false;
  try {
    const transport = dependencies.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
    let pending: Promise<Response>;
    try {
      pending = Promise.resolve(transport(url, {
        method,
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
        headers: {
          accept: create ? 'application/json' : 'text/markdown',
          ...(create ? { 'content-type': 'application/json' } : {}),
        },
        ...(create ? { body } : {}),
      }));
    } catch {
      throw new DocsMdRequestError();
    }
    response = await abortable(pending, controller.signal, discard);
    if (response.redirected || response.type === 'opaqueredirect'
      || response.status >= 300 && response.status < 400
      || response.url && response.url !== url) {
      throw new DocsMdRequestError('redirect_or_response_url');
    }
    bodyHandled = true;
    const text = await readBounded(response, maximum, controller.signal);
    return { response, text };
  } catch (error) {
    controller.abort();
    if (error instanceof DocsMdRequestError) throw error;
    throw new DocsMdRequestError();
  } finally {
    clearTimeout(timer);
    dependencies.signal?.removeEventListener('abort', externallyAborted);
    if (response && !bodyHandled) discard(response);
  }
}

function parsedObject(value: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return object(parsed) ? parsed : undefined;
  } catch {
    return;
  }
}

function receiptFromResponse(
  value: JsonObject,
  intent: DocsMdIntent,
): { receipt: DocsMdReceipt; editToken: string } | { diagnostic: Extract<DocsMdUnknownDiagnostic,
  'schema_success' | 'schema_id' | 'schema_expiry' | 'schema_edit_token' | 'schema_rate_limit' | 'schema_url'> } {
  if (value.success !== true) return { diagnostic: 'schema_success' };
  if (!validId(value.id)) return { diagnostic: 'schema_id' };
  if (value.expiresAt !== 0) return { diagnostic: 'schema_expiry' };
  if (!validEditToken(value.editToken)) return { diagnostic: 'schema_edit_token' };
  if (!object(value.rateLimit) || !Number.isInteger(value.rateLimit.remaining)
    || (value.rateLimit.remaining as number) < 0) return { diagnostic: 'schema_rate_limit' };
  const id = value.id;
  const expectedPublicUrl = publicUrl(id);
  const expectedRawUrl = rawUrl(id);
  if (!exactUrl(value.url, expectedPublicUrl) || !exactUrl(value.rawUrl, expectedRawUrl)) {
    return { diagnostic: 'schema_url' };
  }
  return {
    receipt: {
      operationId: intent.operationId,
      id,
      publicUrl: expectedPublicUrl,
      rawUrl: expectedRawUrl,
      sourceHash: intent.sourceHash,
      requestHash: intent.requestHash,
      expiresAt: 0,
    },
    editToken: value.editToken,
  };
}

export async function createDocsMdShare(
  input: DocsMdPublishInput,
  persistence: DocsMdPersistence,
  dependencies: DocsMdDependencies = {},
): Promise<DocsMdPublishResult> {
  if (input.reviewed !== true) throw new TypeError('Docs MD input must be reviewed');
  if (!OPERATION_ID.test(input.operationId)) throw new TypeError('Invalid Docs MD operation ID');
  const markdown = canonicalMarkdown(input.markdown);
  const requestBody = canonicalRequest(markdown);
  if (input.priorIntent) {
    const priorIntent = { ...input.priorIntent };
    if (!validIntent(priorIntent)) throw new TypeError('Invalid prior Docs MD intent');
    return { status: 'blocked', reason: 'prior_intent', intent: priorIntent };
  }

  const intent: DocsMdIntent = {
    operationId: input.operationId,
    sourceHash: sha256(markdown),
    requestHash: sha256(requestBody),
    createdAt: (dependencies.now?.() ?? new Date()).toISOString(),
  };
  try {
    await persistence.persistIntent({ ...intent });
  } catch {
    return { status: 'not_started', reason: 'intent_not_persisted' };
  }

  let response: Response;
  let text: string;
  try {
    ({ response, text } = await fixedRequest(
      CREATE_URL,
      'POST',
      MAX_CREATE_RESPONSE_BYTES,
      dependencies,
      requestBody,
    ));
  } catch (error) {
    return {
      status: 'unknown',
      reason: 'request_or_response_unknown',
      diagnostic: error instanceof DocsMdRequestError ? error.diagnostic : 'transport_failure',
      intent,
    };
  }
  let status: number;
  try {
    status = response.status;
  } catch {
    return { status: 'unknown', reason: 'request_or_response_unknown', diagnostic: 'transport_failure', intent };
  }
  if (status !== 200) {
    return { status: 'unknown', reason: 'request_or_response_unknown', diagnostic: 'http_status', intent };
  }
  let mediaType: string | undefined;
  try {
    mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  } catch {
    return { status: 'unknown', reason: 'request_or_response_unknown', diagnostic: 'response_media_type', intent };
  }
  if (mediaType !== 'application/json') {
    return { status: 'unknown', reason: 'request_or_response_unknown', diagnostic: 'response_media_type', intent };
  }
  const parsed = parsedObject(text);
  if (!parsed) return { status: 'unknown', reason: 'request_or_response_unknown', diagnostic: 'response_json', intent };
  const checked = receiptFromResponse(parsed, intent);
  if ('diagnostic' in checked) {
    return { status: 'unknown', reason: 'request_or_response_unknown', diagnostic: checked.diagnostic, intent };
  }
  const known = checked;

  let receiptPersistence: 'saved' | 'unknown' = 'unknown';
  try {
    await persistence.persistReceipt({ ...known.receipt });
    receiptPersistence = 'saved';
  } catch {
    // A store may have committed before throwing. Keep the remote receipt and do not re-POST.
  }
  let tokenPersistence: 'saved' | 'unknown' = 'unknown';
  try {
    await persistence.persistEditTokenAtomically({
      operationId: intent.operationId,
      id: known.receipt.id,
      editToken: known.editToken,
    });
    tokenPersistence = 'saved';
  } catch {
    // Never reflect secret-store errors because they may contain the token.
  }
  if (receiptPersistence === 'saved' && tokenPersistence === 'saved') {
    return {
      status: 'created',
      receipt: known.receipt,
      persistence: { receipt: 'saved', secret: 'saved' },
    };
  }
  return {
    status: 'created_persistence_unknown',
    receipt: known.receipt,
    persistence: { receipt: receiptPersistence, secret: tokenPersistence },
  };
}

/**
 * Compares only Docs MD's raw Markdown endpoint with the normalized reviewed source.
 * A match is not evidence that rendered HTML is public, indexable, or otherwise live.
 */
export async function compareDocsMdRawSource(
  receipt: DocsMdReceipt,
  expectedMarkdown: string,
  dependencies: DocsMdDependencies = {},
): Promise<DocsMdSourceResult> {
  let markdown: string;
  let requestBody: string;
  try {
    markdown = canonicalMarkdown(expectedMarkdown);
    requestBody = canonicalRequest(markdown);
  } catch {
    return { status: 'source_mismatch' };
  }
  if (!OPERATION_ID.test(receipt.operationId) || !validId(receipt.id)
    || receipt.publicUrl !== publicUrl(receipt.id) || receipt.rawUrl !== rawUrl(receipt.id)
    || receipt.expiresAt !== 0 || receipt.sourceHash !== sha256(markdown)
    || receipt.requestHash !== sha256(requestBody)) return { status: 'source_mismatch' };

  try {
    const { response, text } = await fixedRequest(
      receipt.rawUrl,
      'GET',
      MAX_RAW_RESPONSE_BYTES,
      dependencies,
    );
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (response.status !== 200 || mediaType !== 'text/markdown') return { status: 'source_unavailable' };
    return text === markdown ? { status: 'source_matched' } : { status: 'source_mismatch' };
  } catch {
    return { status: 'source_unavailable' };
  }
}

export const docsMdTesting = {
  canonicalMarkdown,
  canonicalRequest,
  receiptFromResponse,
  MAX_CONTENT_CHARS,
  MAX_REQUEST_BYTES,
  MAX_CREATE_RESPONSE_BYTES,
  MAX_RAW_RESPONSE_BYTES,
};
