import { createHash } from 'node:crypto';

const ORIGIN = 'https://supanote.app';
const CREATE_PATH = '/notes';
const MAX_CONTENT_BYTES = 499_999;
const MAX_RESPONSE_BYTES = 64_000;
const MAX_READ_RESPONSE_BYTES = 1_100_000;
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

type Json = Record<string, unknown>;
export type SupanoteTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface SupanoteIntent {
  operationId: string;
  contentHash: string;
  createdAt: string;
}

export interface SupanoteReceipt {
  publicId: string;
  publicUrl: string;
  contentHash: string;
}

export interface SupanotePublishInput {
  operationId: string;
  /** The caller, not this transport, must complete the article review before setting this flag. */
  reviewed: true;
  title: string;
  markdown: string;
  priorIntent?: SupanoteIntent;
}

export interface SupanotePersistence {
  /** Must atomically write once (or CAS) and resolve only after durable storage. */
  persistIntent(intent: SupanoteIntent): Promise<void>;
  persistReceipt(receipt: SupanoteReceipt): Promise<void>;
  persistManageToken(secret: { publicId: string; token: string }): Promise<void>;
}

export interface SupanoteDependencies {
  fetch?: SupanoteTransport;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => Date;
}

export type SupanotePublishResult =
  | { status: 'not_started'; reason: 'intent_not_persisted' }
  | { status: 'blocked'; reason: 'prior_intent'; intent: SupanoteIntent }
  | { status: 'uncertain'; reason: 'request_unknown' | 'invalid_response'; intent: SupanoteIntent }
  | { status: 'published_receipt_pending'; receipt: SupanoteReceipt; management: 'not_attempted' }
  | { status: 'published'; receipt: SupanoteReceipt; management: 'saved' | 'not_returned' }
  | { status: 'published_manage_pending'; receipt: SupanoteReceipt; management: 'recovery_required' };

// Every result containing an intent is write-once state. The caller must pass that
// durable intent back on later attempts so this module blocks a blind second POST.

export interface SupanoteVerificationResult {
  verified: boolean;
  reason: 'matched' | 'unavailable' | 'mismatch';
}

class RequestFailure extends Error {
  constructor(readonly code: 'network' | 'timeout' | 'cancelled' | 'invalid') {
    super(`Supanote request failed (${code})`);
    this.name = 'RequestFailure';
  }
}

const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (title: string, markdown: string) => createHash('sha256')
  .update(JSON.stringify({ title, content: markdown, contentType: 'markdown', visibility: 'public', expiration: 'never' }))
  .digest('hex');

function validateInput(input: SupanotePublishInput): void {
  if (input.reviewed !== true) throw new TypeError('Supanote input must be reviewed');
  if (!OPERATION_ID.test(input.operationId)) throw new TypeError('Invalid Supanote operation ID');
  if (typeof input.title !== 'string' || input.title !== input.title.trim() || !input.title
    || input.title.length > 200 || /[\u0000-\u001f\u007f]/.test(input.title))
    throw new TypeError('Invalid Supanote title');
  if (typeof input.markdown !== 'string' || input.markdown !== input.markdown.trim() || !input.markdown
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.markdown)
    || Buffer.byteLength(input.markdown, 'utf8') > MAX_CONTENT_BYTES)
    throw new TypeError('Invalid Supanote Markdown');
}

function validIntent(value: SupanoteIntent): boolean {
  return OPERATION_ID.test(value.operationId) && /^[a-f0-9]{64}$/.test(value.contentHash)
    && Number.isFinite(Date.parse(value.createdAt));
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal, disposeLate?: (value: T) => void): Promise<T> {
  if (signal.aborted) {
    void promise.then(value => disposeLate?.(value), () => undefined);
    return Promise.reject(new RequestFailure('cancelled'));
  }
  return new Promise((resolve, reject) => {
    let finished = false;
    const abort = () => {
      finished = true;
      signal.removeEventListener('abort', abort);
      reject(new RequestFailure('cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      if (finished) {
        disposeLate?.(value);
        return;
      }
      finished = true;
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      if (finished) return;
      finished = true;
      reject(error);
    });
  });
}

async function request(
  path: string,
  method: 'GET' | 'POST',
  deps: SupanoteDependencies,
  payload?: Json,
): Promise<{ response: Response; text: string }> {
  const create = method === 'POST' && path === CREATE_PATH && !!payload;
  const read = method === 'GET' && /^\/api\/v1\/notes\/[A-Za-z0-9_-]{1,200}$/.test(path) && !payload;
  if (!create && !read) throw new RequestFailure('invalid');
  if (deps.signal?.aborted) throw new RequestFailure('cancelled');

  const controller = new AbortController();
  const externalAbort = () => controller.abort();
  deps.signal?.addEventListener('abort', externalAbort, { once: true });
  if (deps.signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.min(60_000, Math.max(50, deps.timeoutMs ?? 15_000)));
  timer.unref?.();
  let response: Response | undefined;
  try {
    const url = `${ORIGIN}${path}`;
    response = await abortable((deps.fetch ?? fetch)(url, {
      method,
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(create ? { 'content-type': 'application/json' } : {}),
      },
      ...(create ? { body: JSON.stringify(payload) } : {}),
    }), controller.signal, late => { void late.body?.cancel().catch(() => undefined); });
    if (response.redirected || response.url && response.url !== url
      || response.status >= 300 && response.status < 400) throw new RequestFailure('invalid');
    const maximum = create ? MAX_RESPONSE_BYTES : MAX_READ_RESPONSE_BYTES;
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximum) throw new RequestFailure('invalid');

    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const next = await abortable(reader.read(), controller.signal);
          if (next.done) break;
          size += next.value.byteLength;
          if (size > maximum) throw new RequestFailure('invalid');
          chunks.push(next.value);
        }
      } catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true })
        .decode(Buffer.concat(chunks.map(value => Buffer.from(value))));
    } catch {
      throw new RequestFailure('invalid');
    }
    return { response, text };
  } catch (error) {
    controller.abort();
    void response?.body?.cancel().catch(() => undefined);
    if (deps.signal?.aborted) throw new RequestFailure('cancelled');
    if (timedOut) throw new RequestFailure('timeout');
    throw error instanceof RequestFailure ? error : new RequestFailure('network');
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', externalAbort);
  }
}

function parseJson(text: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return object(value) ? value : undefined;
  } catch {
    return;
  }
}

function identity(value: Json, contentHash: string): { receipt: SupanoteReceipt; token?: string } | undefined {
  const responseId = value.publicId;
  if (responseId !== undefined && !validId(responseId)) return;
  let urlId: string | undefined;
  let token: string | undefined;
  if (value.url !== undefined) {
    if (typeof value.url !== 'string' || !value.url || value.url.includes('\\')) return;
    let url: URL;
    try { url = new URL(value.url, ORIGIN); } catch { return; }
    if (url.origin !== ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return;
    const match = /^\/n\/([A-Za-z0-9_-]{1,200})$/.exec(url.pathname);
    if (!match) return;
    urlId = match[1];
    const tokens = url.searchParams.getAll('token');
    const created = url.searchParams.getAll('created');
    if ([...url.searchParams.keys()].some(key => key !== 'token' && key !== 'created')
      || tokens.length > 1 || created.length > 1 || created.some(item => item !== '1')) return;
    if (tokens.length) {
      const candidate = tokens[0];
      if (!candidate || Buffer.byteLength(candidate, 'utf8') > 8192
        || /[\s\u0000-\u001f\u007f]/.test(candidate)) return;
      token = candidate;
    }
  }
  if (!urlId && !validId(responseId)) return;
  if (urlId && responseId !== undefined && responseId !== urlId) return;
  const publicId = urlId ?? responseId as string;
  return { receipt: { publicId, publicUrl: `${ORIGIN}/n/${publicId}`, contentHash }, token };
}

export async function publishSupanote(
  input: SupanotePublishInput,
  persistence: SupanotePersistence,
  deps: SupanoteDependencies = {},
): Promise<SupanotePublishResult> {
  const snapshot: SupanotePublishInput = {
    operationId: input.operationId,
    reviewed: input.reviewed,
    title: input.title,
    markdown: input.markdown,
    ...(input.priorIntent ? { priorIntent: { ...input.priorIntent } } : {}),
  };
  validateInput(snapshot);
  if (snapshot.priorIntent) {
    if (!validIntent(snapshot.priorIntent)) throw new TypeError('Invalid prior Supanote intent');
    return { status: 'blocked', reason: 'prior_intent', intent: { ...snapshot.priorIntent } };
  }
  const intent: SupanoteIntent = {
    operationId: snapshot.operationId,
    contentHash: hash(snapshot.title, snapshot.markdown),
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  try {
    await persistence.persistIntent({ ...intent });
  } catch {
    return { status: 'not_started', reason: 'intent_not_persisted' };
  }

  let result: Awaited<ReturnType<typeof request>>;
  try {
    result = await request(CREATE_PATH, 'POST', deps, {
      title: snapshot.title,
      content: snapshot.markdown,
      contentType: 'markdown',
      visibility: 'public',
      expiration: 'never',
    });
  } catch {
    return { status: 'uncertain', reason: 'request_unknown', intent };
  }
  if (!result.response.ok || !result.response.headers.get('content-type')?.toLowerCase().includes('application/json'))
    return { status: 'uncertain', reason: 'invalid_response', intent };
  const parsed = parseJson(result.text);
  const known = parsed && identity(parsed, intent.contentHash);
  if (!known) return { status: 'uncertain', reason: 'invalid_response', intent };
  try {
    await persistence.persistReceipt({ ...known.receipt });
  } catch {
    return { status: 'published_receipt_pending', receipt: known.receipt, management: 'not_attempted' };
  }
  if (!known.token) return { status: 'published', receipt: known.receipt, management: 'not_returned' };
  try {
    await persistence.persistManageToken({ publicId: known.receipt.publicId, token: known.token });
    return { status: 'published', receipt: known.receipt, management: 'saved' };
  } catch {
    return { status: 'published_manage_pending', receipt: known.receipt, management: 'recovery_required' };
  }
}

/** Checks the documented API fields only; it does not prove public HTML rendering, indexing, or listing. */
export async function verifySupanote(
  receipt: SupanoteReceipt,
  expected: Pick<SupanotePublishInput, 'title' | 'markdown'>,
  deps: SupanoteDependencies = {},
): Promise<SupanoteVerificationResult> {
  const saved = { ...receipt };
  const article = { title: expected.title, markdown: expected.markdown };
  if (!validId(saved.publicId) || saved.publicUrl !== `${ORIGIN}/n/${saved.publicId}`
    || saved.contentHash !== hash(article.title, article.markdown)) return { verified: false, reason: 'mismatch' };
  try {
    const { response, text } = await request(`/api/v1/notes/${saved.publicId}`, 'GET', deps);
    if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().includes('application/json'))
      return { verified: false, reason: 'unavailable' };
    const outer = parseJson(text);
    const data = outer?.success === true && object(outer.data) ? outer.data : undefined;
    if (!data || data.publicId !== saved.publicId || data.title !== article.title || data.content !== article.markdown
      || data.contentType !== 'markdown' || data.visibility !== 'public' || data.expiresAt !== null)
      return { verified: false, reason: 'mismatch' };
    return { verified: true, reason: 'matched' };
  } catch {
    return { verified: false, reason: 'unavailable' };
  }
}

export const supanoteTesting = { hash, identity, MAX_CONTENT_BYTES, MAX_RESPONSE_BYTES, MAX_READ_RESPONSE_BYTES };
