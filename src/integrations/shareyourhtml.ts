import { createHash } from 'node:crypto';

const CREATE_URL = 'https://shareyourhtml.com/pages';
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const EDIT_KEY = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
// Local resource budgets, not claims about the platform's undocumented limits.
const MAX_HTML_BYTES = 120_000;
const MAX_REQUEST_BYTES = 200_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface ShareYourHtmlIntent {
  operationId: string;
  slug: string;
  sourceHash: string;
  requestHash: string;
  createdAt: string;
}

export interface ShareYourHtmlReceipt extends ShareYourHtmlIntent {
  publicUrl: string;
  /** The API does not echo expiry; this records the request, not independent verification. */
  requestedExpiry: 'never';
  publicVerification: 'pending';
}

export interface ShareYourHtmlInput {
  operationId: string;
  slug: string;
  html: string;
  /** Caller must bind an independent review to this exact HTML before calling. */
  reviewed: true;
  priorIntent?: ShareYourHtmlIntent;
}

export interface ShareYourHtmlPersistence {
  /**
   * Durably claim once, atomically rejecting an existing operation OR slug before
   * resolving. Preserve the claim after every outcome, including unknown results.
   * This boundary needs real persistent storage before enabling the adapter.
   */
  persistIntent(intent: ShareYourHtmlIntent): Promise<void>;
  /**
   * Required synchronous guard immediately before transport. It must recheck
   * the durable claim, content/site binding and current authorization. No
   * promise is accepted because transport follows in the same JavaScript turn.
   */
  assertReadyToSubmit(intent: ShareYourHtmlIntent): true;
  /** Atomically encrypt the edit key and save its receipt before resolving. */
  persistCreatedAtomically(value: { receipt: ShareYourHtmlReceipt; editKey: string }): Promise<void>;
}

export interface ShareYourHtmlDependencies {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => Date;
}

type Diagnostic = 'transport' | 'redirect' | 'http_status' | 'media_type' | 'body' | 'json' | 'receipt';
export type ShareYourHtmlResult =
  | { status: 'not_started'; reason: 'cancelled' | 'intent_not_persisted' }
  | { status: 'blocked'; reason: 'prior_intent'; intent: ShareYourHtmlIntent }
  | { status: 'not_submitted'; reason: 'cancelled_after_intent' | 'final_guard_rejected'; intent: ShareYourHtmlIntent }
  | { status: 'unknown'; diagnostic: Diagnostic; intent: ShareYourHtmlIntent }
  | { status: 'created' | 'created_persistence_unknown'; receipt: ShareYourHtmlReceipt };

class RequestFailure extends Error {
  constructor(readonly diagnostic: Diagnostic) { super('ShareYourHTML request could not be confirmed'); }
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const publicUrl = (slug: string) => `https://${slug}.shareyourhtml.com`;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const valid = (v: unknown, rule: RegExp): v is string => typeof v === 'string' && rule.test(v);

function cleanIntent(v: ShareYourHtmlIntent): ShareYourHtmlIntent {
  if (!object(v) || !valid(v.operationId, OPERATION) || !valid(v.slug, SLUG)
    || !valid(v.sourceHash, HASH) || !valid(v.requestHash, HASH)
    || typeof v.createdAt !== 'string' || !Number.isFinite(Date.parse(v.createdAt))) {
    throw new TypeError('Invalid prior ShareYourHTML intent');
  }
  return { operationId: v.operationId, slug: v.slug, sourceHash: v.sourceHash,
    requestHash: v.requestHash, createdAt: v.createdAt };
}

function discard(response: Response): void {
  if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const abort = () => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', abort);
      reject(new RequestFailure('transport'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    pending.then(value => {
      signal.removeEventListener('abort', abort);
      if (done) { late?.(value); return; }
      done = true;
      resolve(value);
    }, () => {
      signal.removeEventListener('abort', abort);
      if (done) return;
      done = true;
      reject(new RequestFailure('transport'));
    });
  });
}

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    discard(response);
    throw new RequestFailure('body');
  }
  if (!response.body) throw new RequestFailure('body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new RequestFailure('body');
      chunks.push(next.value);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
    } catch { throw new RequestFailure('body'); }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}

async function createRequest(body: string, deps: ShareYourHtmlDependencies): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  deps.signal?.addEventListener('abort', abort, { once: true });
  if (deps.signal?.aborted) controller.abort();
  const timeout = typeof deps.timeoutMs === 'number' && Number.isFinite(deps.timeoutMs)
    ? Math.min(60_000, Math.max(50, Math.floor(deps.timeoutMs))) : 15_000;
  const timer = setTimeout(abort, timeout);
  let response: Response | undefined;
  try {
    if (controller.signal.aborted) throw new RequestFailure('transport');
    const transport = deps.fetch ?? fetch;
    response = await abortable(Promise.resolve(transport(CREATE_URL, {
      method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store',
      referrerPolicy: 'no-referrer', signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' }, body,
    })), controller.signal, discard);
    if (response.redirected || response.type === 'opaqueredirect'
      || response.status >= 300 && response.status < 400 || response.url && response.url !== CREATE_URL) {
      throw new RequestFailure('redirect');
    }
    if (response.status !== 201) throw new RequestFailure('http_status');
    if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      throw new RequestFailure('media_type');
    }
    const text = await readBody(response, controller.signal);
    try { return JSON.parse(text); } catch { throw new RequestFailure('json'); }
  } catch (error) {
    controller.abort();
    if (error instanceof RequestFailure) throw error;
    throw new RequestFailure('transport');
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', abort);
    if (response) discard(response);
  }
}

/** Creates at most once. Creation is never counted as public/backlink verification. */
export async function createShareYourHtmlPage(
  input: ShareYourHtmlInput,
  persistence: ShareYourHtmlPersistence,
  deps: ShareYourHtmlDependencies = {},
): Promise<ShareYourHtmlResult> {
  if (input.reviewed !== true || !valid(input.operationId, OPERATION) || !valid(input.slug, SLUG)) {
    throw new TypeError('ShareYourHTML requires reviewed HTML and valid publication identifiers');
  }
  if (input.priorIntent !== undefined) {
    return { status: 'blocked', reason: 'prior_intent', intent: cleanIntent(input.priorIntent) };
  }
  if (typeof input.html !== 'string' || !input.html.trim()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.html)
    || Buffer.byteLength(input.html, 'utf8') > MAX_HTML_BYTES
    || Buffer.from(input.html, 'utf8').toString('utf8') !== input.html) {
    throw new TypeError('Invalid ShareYourHTML content or local size budget exceeded');
  }
  // Keep reviewed bytes exactly: whitespace changes can alter authored HTML.
  const body = JSON.stringify({ slug: input.slug, html: input.html, expiry: 'never' });
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) throw new TypeError('ShareYourHTML local request budget exceeded');
  if (deps.signal?.aborted) return { status: 'not_started', reason: 'cancelled' };
  const intent: ShareYourHtmlIntent = {
    operationId: input.operationId, slug: input.slug, sourceHash: hash(input.html),
    requestHash: hash(body), createdAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  try { await persistence.persistIntent({ ...intent }); }
  catch { return { status: 'not_started', reason: 'intent_not_persisted' }; }
  if (deps.signal?.aborted) return { status: 'not_submitted', reason: 'cancelled_after_intent', intent };
  try {
    const guard: unknown = persistence.assertReadyToSubmit({ ...intent });
    if (guard && typeof (guard as { then?: unknown }).then === 'function') {
      void Promise.resolve(guard).catch(() => undefined);
      throw Error('guard must be synchronous');
    }
    if (guard !== true) throw Error('guard rejected');
  } catch {
    return { status: 'not_submitted', reason: 'final_guard_rejected', intent };
  }
  // Deliberately no await or queued work between the synchronous final guard
  // and createRequest, whose transport call begins synchronously.
  let response: unknown;
  try { response = await createRequest(body, deps); }
  catch (error) {
    return { status: 'unknown', diagnostic: error instanceof RequestFailure ? error.diagnostic : 'transport', intent };
  }
  if (!object(response) || response.slug !== intent.slug || response.url !== publicUrl(intent.slug)
    || !valid(response.edit_key, EDIT_KEY)) {
    return { status: 'unknown', diagnostic: 'receipt', intent };
  }
  const receipt: ShareYourHtmlReceipt = { ...intent, publicUrl: publicUrl(intent.slug),
    requestedExpiry: 'never', publicVerification: 'pending' };
  try {
    await persistence.persistCreatedAtomically({ receipt: { ...receipt }, editKey: response.edit_key });
  } catch { return { status: 'created_persistence_unknown', receipt }; }
  return { status: 'created', receipt };
}
