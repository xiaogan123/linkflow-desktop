import { createHash } from 'node:crypto';

export const README_API_ORIGIN = 'https://api.readme.com';
export const README_API_PREFIX = '/v2';
export const README_MAX_RESPONSE_BYTES = 64 * 1024;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_REQUEST_BYTES = 512 * 1024;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/;
const BRANCH = /^(?:stable|main(?:-[a-z]{2})?|v?\d+(?:\.\d+){0,2}(?:-[A-Za-z0-9._-]+)?)(?:_[A-Za-z0-9._-]+)?$/;
const HASH = /^[a-f0-9]{64}$/;
const PROJECT_ID = /^[a-f\d]{24}$/;
const PROJECT_SUBDOMAIN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const TOKEN = /^rdme_\w+$/;
const PROJECT_VIEWS = new Set(['public', 'admin', 'password', 'custom_login']);
const PROJECT_PLANS = new Set(['business', 'business2018', 'business-annual-2024', 'enterprise', 'free',
  'freelaunch', 'freelaunch2026', 'opensource', 'pro2026', 'pro2026-annual', 'startup', 'startup2018',
  'startup-annual-2024']);

type JsonObject = Record<string, unknown>;
type MutationKind = 'onboarding' | 'guide';

export type ReadMeDiagnostic =
  | 'cancelled'
  | 'timeout'
  | 'transport'
  | 'redirect'
  | 'body_limit'
  | 'media_type'
  | 'json'
  | 'schema'
  | 'http_status'
  | 'raw_persistence'
  | 'secret_persistence';

export interface ReadMeDependencies {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => Date;
}

export interface ReadMeOpaqueResponse {
  version: 1;
  kind: MutationKind;
  operationId: string;
  requestHash: string;
  capturedAt: string;
  requestUrl: string;
  status: number;
  contentType: string | null;
  responseUrl: string;
  redirected: boolean;
  bodyBase64: string;
  bodyHash: string;
  bodyComplete: boolean;
}

export interface ReadMeOnboardingIntent {
  version: 1;
  kind: 'readme_onboarding';
  operationId: string;
  name: string;
  email: string;
  projectName: string;
  requestHash: string;
  createdAt: string;
}

export interface ReadMeOnboardingSecrets {
  token: string;
  signInUrl: string;
}

export interface ReadMeAccount {
  provider: 'readme';
  ownerEmail: string;
  subdomain: string;
  projectLink: string;
  ownerBinding: 'api_unverified';
  emailVerification: 'unverified';
  planConfirmation: 'unconfirmed';
  projectPublication: 'unverified';
}

export interface ReadMeOnboardingReceipt {
  operationId: string;
  requestHash: string;
  responseHash: string;
  apiStatus: 201;
  account: ReadMeAccount;
}

export interface ReadMeOnboardingPersistence {
  /** This callback must use durable encrypted storage because the intent contains owner PII. */
  loadEncryptedIntent(): Promise<ReadMeOnboardingIntent | undefined>;
  /** Atomically rejects any prior onboarding intent before resolving. */
  persistEncryptedIntent(intent: ReadMeOnboardingIntent): Promise<void>;
  /** Synchronous last-moment authorization check. */
  assertReadyToSubmit(intent: ReadMeOnboardingIntent): true;
  /** This callback must encrypt the raw response; it contains the returned key and sign-in URL. */
  persistEncryptedRawResponse(response: ReadMeOpaqueResponse): Promise<void>;
  /** The token and one-use URL are delivered only across this secret-storage boundary. */
  persistEncryptedSecrets(intent: ReadMeOnboardingIntent, secrets: ReadMeOnboardingSecrets): Promise<void>;
}

export interface ReadMeOnboardingInput {
  operationId: string;
  name: string;
  email: string;
  projectName: string;
  priorIntent?: ReadMeOnboardingIntent;
}

export type ReadMeOnboardingResult =
  | { status: 'not_started'; reason: 'invalid_input' | 'intent_not_persisted' | 'authorization_changed' }
  | { status: 'blocked'; reason: 'prior_intent'; intent: ReadMeOnboardingIntent }
  | { status: 'rejected'; reason: 'email_invalid_or_existing' | 'rate_limited' | 'service_unavailable'; intent: ReadMeOnboardingIntent }
  | { status: 'unknown'; diagnostic: ReadMeDiagnostic; intent: ReadMeOnboardingIntent; rawResponseSaved: boolean }
  | { status: 'created'; receipt: ReadMeOnboardingReceipt };

export interface ReadMeGuideIntent {
  version: 1;
  kind: 'readme_guide_create';
  operationId: string;
  branch: string;
  slug: string;
  categoryUri: string;
  title: string;
  contentHash: string;
  requestHash: string;
  createdAt: string;
  projectBinding: ReadMeProjectBinding;
}

export interface ReadMeProjectBinding {
  projectId: string;
  ownerId: string | null;
  subdomain: string;
  tokenFingerprint: string;
}

export interface ReadMeGuideReceipt extends ReadMeGuideIntent {
  apiStatus: 201 | 200;
  responseHash: string;
  apiReconciled: boolean;
  publicVerification: 'pending';
  projectPublication: 'unconfirmed';
  emailVerification: 'unconfirmed';
  planConfirmation: 'unconfirmed';
}

export interface ReadMeGuidePersistence {
  /** This callback must use durable encrypted storage. */
  loadEncryptedIntent(): Promise<ReadMeGuideIntent | undefined>;
  /** Atomically rejects any prior operation or slug claim before resolving. */
  persistEncryptedIntent(intent: ReadMeGuideIntent): Promise<void>;
  assertReadyToSubmit(intent: ReadMeGuideIntent): true;
  /** Saves the raw mutation response before it is interpreted. */
  persistEncryptedRawResponse(response: ReadMeOpaqueResponse): Promise<void>;
}

export interface ReadMeGuideInput {
  operationId: string;
  branch: string;
  slug: string;
  categoryUri: string;
  title: string;
  content: string;
  priorIntent?: ReadMeGuideIntent;
}

export type ReadMeGuideResult =
  | { status: 'not_started'; reason: 'invalid_input' | 'intent_not_persisted' | 'authorization_changed' | 'project_unconfirmed' }
  | { status: 'blocked'; reason: 'prior_intent'; intent: ReadMeGuideIntent }
  | { status: 'conflict'; reason: 'slug_conflict'; intent: ReadMeGuideIntent }
  | { status: 'unknown'; diagnostic: ReadMeDiagnostic; intent: ReadMeGuideIntent; rawResponseSaved: boolean }
  | { status: 'created'; receipt: ReadMeGuideReceipt };

export type ReadMeGuideReconciliation =
  | { status: 'matched'; receipt: ReadMeGuideReceipt }
  | { status: 'absent' }
  | { status: 'mismatch' }
  | { status: 'binding_mismatch' }
  | { status: 'unknown'; diagnostic: ReadMeDiagnostic };

export interface ReadMeProjectProbe {
  apiReachable: true;
  responseHash: string;
  projectId: string;
  ownerId: string | null;
  subdomain: string;
  privacyView: 'public' | 'admin' | 'password' | 'custom_login' | null;
  allowCrawlers: 'enabled' | 'disabled';
  plan: {
    type: string | null;
    trial: { active: boolean | null; expired: boolean | null; endDate: string };
    gracePeriod: { enabled: boolean | null; endDate: string | null; plan: string | null };
  };
  ownerBinding: 'owner_id_observed' | 'owner_id_null_observed';
  emailVerification: 'not_exposed_by_project_schema';
  projectPublication: 'not_established_by_project_metadata';
  schemaConfirmation: 'official_project_schema_observed';
}

export type ReadMeProjectProbeResult =
  | { status: 'observed'; probe: ReadMeProjectProbe }
  | { status: 'unknown'; diagnostic: ReadMeDiagnostic };

class ReadMeFailure extends Error {
  constructor(readonly diagnostic: ReadMeDiagnostic) {
    super(`ReadMe request failed: ${diagnostic}`);
  }
}

class BodyFailure extends ReadMeFailure {
  constructor(diagnostic: ReadMeDiagnostic, readonly bytes: Uint8Array) {
    super(diagnostic);
  }
}

class CapturedResponseFailure extends ReadMeFailure {
  constructor(diagnostic: ReadMeDiagnostic, readonly response: Response, readonly bytes: Uint8Array) {
    super(diagnostic);
  }
}

const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const safeLine = (value: unknown, maximum: number): value is string => typeof value === 'string'
  && value.length >= 1 && value.length <= maximum && value === value.trim()
  && !/[\u0000-\u001f\u007f]/.test(value);
const safeEmail = (value: unknown): value is string => safeLine(value, 255)
  && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

function timeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.floor(value), 1), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}

function safeHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

function validCategoryUri(value: unknown): value is string {
  return safeLine(value, 512)
    && /^\/(?:versions|branches)\/[A-Za-z0-9._-]+\/categories\/[a-z0-9][a-z0-9_-]{0,29}\/.+$/.test(value)
    && !/[?#]/.test(value);
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 6 && value.length <= 8_192
    && TOKEN.test(value) && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function validProjectBinding(value: unknown): value is ReadMeProjectBinding {
  return object(value) && typeof value.projectId === 'string' && PROJECT_ID.test(value.projectId)
    && (value.ownerId === null || safeLine(value.ownerId, 255))
    && typeof value.subdomain === 'string' && value.subdomain.length <= 30 && PROJECT_SUBDOMAIN.test(value.subdomain)
    && typeof value.tokenFingerprint === 'string' && HASH.test(value.tokenFingerprint);
}

function cleanDate(now: () => Date): string | undefined {
  try {
    const value = now();
    return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  } catch { return undefined; }
}

function cleanOnboardingIntent(value: ReadMeOnboardingIntent): ReadMeOnboardingIntent | undefined {
  if (!object(value) || value.version !== 1 || value.kind !== 'readme_onboarding'
    || !safeLine(value.operationId, 128) || !OPERATION.test(value.operationId)
    || !safeLine(value.name, 255) || !safeEmail(value.email) || !safeLine(value.projectName, 255)
    || typeof value.requestHash !== 'string' || !HASH.test(value.requestHash)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return undefined;
  return { version: 1, kind: 'readme_onboarding', operationId: value.operationId, name: value.name,
    email: value.email, projectName: value.projectName, requestHash: value.requestHash, createdAt: value.createdAt };
}

function cleanGuideIntent(value: ReadMeGuideIntent): ReadMeGuideIntent | undefined {
  if (!object(value) || value.version !== 1 || value.kind !== 'readme_guide_create'
    || !safeLine(value.operationId, 128) || !OPERATION.test(value.operationId)
    || typeof value.branch !== 'string' || !BRANCH.test(value.branch)
    || typeof value.slug !== 'string' || !SLUG.test(value.slug)
    || !validCategoryUri(value.categoryUri) || !safeLine(value.title, 255)
    || typeof value.contentHash !== 'string' || !HASH.test(value.contentHash)
    || typeof value.requestHash !== 'string' || !HASH.test(value.requestHash)
    || !validProjectBinding(value.projectBinding)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return undefined;
  return { version: 1, kind: 'readme_guide_create', operationId: value.operationId, branch: value.branch,
    slug: value.slug, categoryUri: value.categoryUri, title: value.title, contentHash: value.contentHash,
    requestHash: value.requestHash, createdAt: value.createdAt, projectBinding: { ...value.projectBinding } };
}

function fixedUrl(path: string): string {
  const url = new URL(path, README_API_ORIGIN);
  if (url.protocol !== 'https:' || url.origin !== README_API_ORIGIN || !url.pathname.startsWith(`${README_API_PREFIX}/`)
    || url.username || url.password || url.search || url.hash) throw new ReadMeFailure('schema');
  return url.toString();
}

function discard(response: Response): void {
  if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
}

async function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    throw signal.reason;
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      void promise.then(value => { if (value instanceof Response) discard(value); }, () => undefined);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

async function boundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) throw new BodyFailure('transport', new Uint8Array());
  const advertised = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(advertised) && advertised > README_MAX_RESPONSE_BYTES) {
    discard(response);
    throw new BodyFailure('body_limit', new Uint8Array());
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await waitWithAbort(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > README_MAX_RESPONSE_BYTES) throw new BodyFailure('body_limit', join(chunks));
      chunks.push(next.value);
    }
    return join(chunks);
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof BodyFailure) throw error;
    if (error instanceof ReadMeFailure) throw new BodyFailure(error.diagnostic, join(chunks));
    throw new BodyFailure('transport', join(chunks));
  } finally { reader.releaseLock(); }
}

function join(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, value) => sum + value.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function responseUrl(response: Response, requested: string): string {
  return response.url || requested;
}

function verifyResponse(response: Response, requested: string): void {
  if (response.redirected || response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) {
    throw new ReadMeFailure('redirect');
  }
  if (response.url && response.url !== requested) throw new ReadMeFailure('redirect');
}

async function request(url: string, init: RequestInit, dependencies: ReadMeDependencies): Promise<{ response: Response; bytes: Uint8Array }> {
  const controller = new AbortController();
  let timedOut = false;
  const externalAbort = () => controller.abort(new ReadMeFailure('cancelled'));
  dependencies.signal?.addEventListener('abort', externalAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(new ReadMeFailure('timeout')); }, timeout(dependencies.timeoutMs));
  timer.unref?.();
  try {
    if (dependencies.signal?.aborted) throw new ReadMeFailure('cancelled');
    const transport = dependencies.fetch ?? ((input: string, options: RequestInit) => fetch(input, options));
    let response: Response;
    try {
      response = await waitWithAbort(Promise.resolve(transport(url, { ...init, signal: controller.signal })), controller.signal);
    } catch (error) {
      if (dependencies.signal?.aborted) throw new ReadMeFailure('cancelled');
      if (timedOut) throw new ReadMeFailure('timeout');
      if (error instanceof ReadMeFailure) throw error;
      throw new ReadMeFailure('transport');
    }
    try { verifyResponse(response, url); }
    catch (error) { discard(response); throw error; }
    try {
      const bytes = await boundedBody(response, controller.signal);
      return { response, bytes };
    } catch (error) {
      if (error instanceof BodyFailure) throw new CapturedResponseFailure(error.diagnostic, response, error.bytes);
      throw error;
    }
  } finally {
    clearTimeout(timer);
    dependencies.signal?.removeEventListener('abort', externalAbort);
  }
}

function opaque(kind: MutationKind, intent: { operationId: string; requestHash: string }, url: string,
  response: Response, bytes: Uint8Array, capturedAt: string, bodyComplete: boolean): ReadMeOpaqueResponse {
  return { version: 1, kind, operationId: intent.operationId, requestHash: intent.requestHash, capturedAt,
    requestUrl: url, status: response.status, contentType: response.headers.get('content-type'),
    responseUrl: responseUrl(response, url), redirected: response.redirected, bodyBase64: Buffer.from(bytes).toString('base64'),
    bodyHash: hash(bytes), bodyComplete };
}

function parseJson(response: Response, bytes: Uint8Array): JsonObject {
  if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new ReadMeFailure('media_type');
  }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown;
    if (!object(value)) throw new Error('shape');
    return value;
  } catch { throw new ReadMeFailure('json'); }
}

interface ReadMeProjectMetadata {
  projectId: string;
  ownerId: string | null;
  subdomain: string;
  privacyView: ReadMeProjectProbe['privacyView'];
  allowCrawlers: ReadMeProjectProbe['allowCrawlers'];
  plan: ReadMeProjectProbe['plan'];
}

function optionalBoolean(value: unknown): boolean | null | undefined {
  return value === undefined ? null : typeof value === 'boolean' ? value : undefined;
}

function optionalDate(value: unknown, nullable: boolean): string | null | undefined {
  if (value === undefined) return nullable ? null : undefined;
  if (nullable && value === null) return null;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function projectMetadata(value: unknown): ReadMeProjectMetadata | undefined {
  if (!object(value) || typeof value.id !== 'string' || !PROJECT_ID.test(value.id)
    || !object(value.owner) || !(value.owner.id === null || safeLine(value.owner.id, 255))
    || typeof value.subdomain !== 'string' || value.subdomain.length > 30 || !PROJECT_SUBDOMAIN.test(value.subdomain)
    || !object(value.privacy)
    || !(value.privacy.view === undefined || typeof value.privacy.view === 'string' && PROJECT_VIEWS.has(value.privacy.view))
    || !(value.allow_crawlers === 'enabled' || value.allow_crawlers === 'disabled')
    || !object(value.plan) || !object(value.plan.trial) || !object(value.plan.grace_period)
    || !(value.plan.type === undefined || typeof value.plan.type === 'string' && PROJECT_PLANS.has(value.plan.type))
    || !(value.plan.grace_period.plan === null
      || typeof value.plan.grace_period.plan === 'string' && PROJECT_PLANS.has(value.plan.grace_period.plan))) return undefined;
  const trialActive = optionalBoolean(value.plan.trial.active);
  const trialExpired = optionalBoolean(value.plan.trial.expired);
  const trialEndDate = optionalDate(value.plan.trial.end_date, false);
  const graceEnabled = optionalBoolean(value.plan.grace_period.enabled);
  const graceEndDate = optionalDate(value.plan.grace_period.end_date, true);
  if (trialActive === undefined || trialExpired === undefined || typeof trialEndDate !== 'string'
    || graceEnabled === undefined || graceEndDate === undefined) return undefined;
  return { projectId: value.id, ownerId: value.owner.id, subdomain: value.subdomain,
    privacyView: (value.privacy.view ?? null) as ReadMeProjectProbe['privacyView'], allowCrawlers: value.allow_crawlers,
    plan: { type: value.plan.type ?? null,
      trial: { active: trialActive, expired: trialExpired, endDate: trialEndDate },
      gracePeriod: { enabled: graceEnabled, endDate: graceEndDate, plan: value.plan.grace_period.plan } } };
}

async function readProject(apiToken: string, dependencies: ReadMeDependencies): Promise<{
  metadata: ReadMeProjectMetadata;
  bytes: Uint8Array;
}> {
  const url = fixedUrl('/v2/projects/me');
  const { response, bytes } = await request(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
    referrerPolicy: 'no-referrer', headers: { accept: 'application/json', authorization: `Bearer ${apiToken}` } }, dependencies);
  if (response.status !== 200) throw new ReadMeFailure('http_status');
  const value = parseJson(response, bytes);
  const metadata = projectMetadata(value.data);
  if (!metadata) throw new ReadMeFailure('schema');
  return { metadata, bytes };
}

function projectBinding(metadata: ReadMeProjectMetadata, apiToken: string): ReadMeProjectBinding {
  return { projectId: metadata.projectId, ownerId: metadata.ownerId, subdomain: metadata.subdomain,
    tokenFingerprint: hash(apiToken) };
}

function sameProjectBinding(left: ReadMeProjectBinding, right: ReadMeProjectBinding): boolean {
  return left.projectId === right.projectId && left.ownerId === right.ownerId && left.subdomain === right.subdomain
    && left.tokenFingerprint === right.tokenFingerprint;
}

function diagnostic(error: unknown): ReadMeDiagnostic {
  return error instanceof ReadMeFailure ? error.diagnostic : 'transport';
}

function onboardingRequest(input: ReadMeOnboardingInput, createdAt: string): { intent: ReadMeOnboardingIntent; body: string } | undefined {
  if (!safeLine(input.operationId, 128) || !OPERATION.test(input.operationId) || !safeLine(input.name, 255)
    || !safeEmail(input.email) || !safeLine(input.projectName, 255)) return undefined;
  const body = JSON.stringify({ name: input.name, email: input.email, project_name: input.projectName });
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) return undefined;
  return { body, intent: { version: 1, kind: 'readme_onboarding', operationId: input.operationId,
    name: input.name, email: input.email, projectName: input.projectName, requestHash: hash(body), createdAt } };
}

export async function createReadMeAccount(input: ReadMeOnboardingInput, persistence: ReadMeOnboardingPersistence,
  dependencies: ReadMeDependencies = {}): Promise<ReadMeOnboardingResult> {
  const createdAt = cleanDate(dependencies.now ?? (() => new Date()));
  if (!createdAt) return { status: 'not_started', reason: 'invalid_input' };
  const prepared = onboardingRequest(input, createdAt);
  if (!prepared) return { status: 'not_started', reason: 'invalid_input' };
  const suppliedPrior = input.priorIntent && cleanOnboardingIntent(input.priorIntent);
  if (input.priorIntent && !suppliedPrior) return { status: 'not_started', reason: 'invalid_input' };
  let loadedPrior: ReadMeOnboardingIntent | undefined;
  try { loadedPrior = await persistence.loadEncryptedIntent(); }
  catch { return { status: 'not_started', reason: 'intent_not_persisted' }; }
  const cleanPrior = loadedPrior && cleanOnboardingIntent(loadedPrior);
  if (loadedPrior && !cleanPrior) return { status: 'not_started', reason: 'intent_not_persisted' };
  const prior = suppliedPrior ?? cleanPrior;
  if (prior) return { status: 'blocked', reason: 'prior_intent', intent: prior };
  const intent = Object.freeze({ ...prepared.intent });
  try { await persistence.persistEncryptedIntent({ ...intent }); }
  catch { return { status: 'not_started', reason: 'intent_not_persisted' }; }
  try { if (persistence.assertReadyToSubmit({ ...intent }) !== true) throw new Error('rejected'); }
  catch { return { status: 'not_started', reason: 'authorization_changed' }; }

  const url = fixedUrl('/v2/projects/ai_onboarding');
  let response: Response;
  let bytes: Uint8Array;
  try {
    ({ response, bytes } = await request(url, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
      referrerPolicy: 'no-referrer', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: prepared.body }, dependencies));
  } catch (error) {
    if (error instanceof CapturedResponseFailure) {
      const capturedAt = cleanDate(dependencies.now ?? (() => new Date())) ?? createdAt;
      try {
        await persistence.persistEncryptedRawResponse(opaque('onboarding', intent, url, error.response,
          error.bytes, capturedAt, false));
        return { status: 'unknown', diagnostic: error.diagnostic, intent, rawResponseSaved: true };
      } catch { return { status: 'unknown', diagnostic: 'raw_persistence', intent, rawResponseSaved: false }; }
    }
    return { status: 'unknown', diagnostic: diagnostic(error), intent, rawResponseSaved: false };
  }
  const capturedAt = cleanDate(dependencies.now ?? (() => new Date())) ?? createdAt;
  try { await persistence.persistEncryptedRawResponse(opaque('onboarding', intent, url, response, bytes, capturedAt, true)); }
  catch { discard(response); return { status: 'unknown', diagnostic: 'raw_persistence', intent, rawResponseSaved: false }; }
  if (response.status === 400) return { status: 'rejected', reason: 'email_invalid_or_existing', intent };
  if (response.status === 429) return { status: 'rejected', reason: 'rate_limited', intent };
  if (response.status === 500 || response.status === 503) return { status: 'rejected', reason: 'service_unavailable', intent };
  if (response.status !== 201) return { status: 'unknown', diagnostic: 'http_status', intent, rawResponseSaved: true };
  let value: JsonObject;
  try { value = parseJson(response, bytes); }
  catch (error) { return { status: 'unknown', diagnostic: diagnostic(error), intent, rawResponseSaved: true }; }
  const data = value.data;
  if (!object(data) || typeof data.subdomain !== 'string' || !SUBDOMAIN.test(data.subdomain)
    || !safeHttpsUrl(data.project_link) || !safeHttpsUrl(data.sign_in_url) || !validToken(data.token)) {
    return { status: 'unknown', diagnostic: 'schema', intent, rawResponseSaved: true };
  }
  try { await persistence.persistEncryptedSecrets({ ...intent }, { token: data.token, signInUrl: data.sign_in_url }); }
  catch { return { status: 'unknown', diagnostic: 'secret_persistence', intent, rawResponseSaved: true }; }
  return { status: 'created', receipt: { operationId: intent.operationId, requestHash: intent.requestHash,
    responseHash: hash(bytes), apiStatus: 201, account: { provider: 'readme', ownerEmail: intent.email,
      subdomain: data.subdomain, projectLink: data.project_link, ownerBinding: 'api_unverified',
      emailVerification: 'unverified', planConfirmation: 'unconfirmed', projectPublication: 'unverified' } } };
}

interface ReadMeGuideInputSnapshot {
  operationId: string;
  branch: string;
  slug: string;
  categoryUri: string;
  title: string;
  content: string;
  priorIntent: ReadMeGuideIntent | undefined;
}

function guideInputSnapshot(input: ReadMeGuideInput): { input: Readonly<ReadMeGuideInputSnapshot>; body: string } | undefined {
  const snapshot = { operationId: input.operationId, branch: input.branch, slug: input.slug,
    categoryUri: input.categoryUri, title: input.title, content: input.content, priorIntent: input.priorIntent };
  if (!safeLine(snapshot.operationId, 128) || !OPERATION.test(snapshot.operationId)
    || !BRANCH.test(snapshot.branch) || !SLUG.test(snapshot.slug) || !validCategoryUri(snapshot.categoryUri)
    || !safeLine(snapshot.title, 255) || typeof snapshot.content !== 'string' || !snapshot.content.length) return undefined;
  const body = JSON.stringify({ category: { uri: snapshot.categoryUri }, title: snapshot.title,
    content: { body: snapshot.content }, slug: snapshot.slug, privacy: { view: 'public' },
    allow_crawlers: 'enabled', type: 'basic' });
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) return undefined;
  return { input: Object.freeze(snapshot), body };
}

function guideRequest(input: Readonly<ReadMeGuideInputSnapshot>, createdAt: string, binding: ReadMeProjectBinding,
  body: string): { intent: ReadMeGuideIntent; body: string } {
  return { body, intent: { version: 1, kind: 'readme_guide_create', operationId: input.operationId,
    branch: input.branch, slug: input.slug, categoryUri: input.categoryUri, title: input.title,
    contentHash: hash(input.content), requestHash: hash(body), createdAt, projectBinding: { ...binding } } };
}

function guideReceipt(intent: ReadMeGuideIntent, bytes: Uint8Array, apiStatus: 201 | 200, apiReconciled: boolean): ReadMeGuideReceipt {
  return { ...intent, apiStatus, responseHash: hash(bytes), apiReconciled, publicVerification: 'pending',
    projectPublication: 'unconfirmed', emailVerification: 'unconfirmed', planConfirmation: 'unconfirmed' };
}

function exactGuide(data: unknown, intent: ReadMeGuideIntent): boolean {
  return object(data) && data.slug === intent.slug && data.title === intent.title
    && object(data.category) && data.category.uri === intent.categoryUri
    && object(data.content) && typeof data.content.body === 'string' && hash(data.content.body) === intent.contentHash
    && object(data.privacy) && data.privacy.view === 'public'
    && data.allow_crawlers === 'enabled';
}

export async function createReadMeGuide(input: ReadMeGuideInput, apiToken: string, persistence: ReadMeGuidePersistence,
  dependencies: ReadMeDependencies = {}): Promise<ReadMeGuideResult> {
  const createdAt = cleanDate(dependencies.now ?? (() => new Date()));
  if (!createdAt || !validToken(apiToken)) return { status: 'not_started', reason: 'invalid_input' };
  const snapshot = guideInputSnapshot(input);
  if (!snapshot) return { status: 'not_started', reason: 'invalid_input' };
  const suppliedPrior = snapshot.input.priorIntent && cleanGuideIntent(snapshot.input.priorIntent);
  if (snapshot.input.priorIntent && !suppliedPrior) return { status: 'not_started', reason: 'invalid_input' };
  let loadedPrior: ReadMeGuideIntent | undefined;
  try { loadedPrior = await persistence.loadEncryptedIntent(); }
  catch { return { status: 'not_started', reason: 'intent_not_persisted' }; }
  const cleanPrior = loadedPrior && cleanGuideIntent(loadedPrior);
  if (loadedPrior && !cleanPrior) return { status: 'not_started', reason: 'intent_not_persisted' };
  const prior = suppliedPrior ?? cleanPrior;
  if (prior) return { status: 'blocked', reason: 'prior_intent', intent: prior };
  let metadata: ReadMeProjectMetadata;
  try { ({ metadata } = await readProject(apiToken, dependencies)); }
  catch { return { status: 'not_started', reason: 'project_unconfirmed' }; }
  const prepared = guideRequest(snapshot.input, createdAt, projectBinding(metadata, apiToken), snapshot.body);
  const intent = Object.freeze({ ...prepared.intent,
    projectBinding: Object.freeze({ ...prepared.intent.projectBinding }) });
  try { await persistence.persistEncryptedIntent({ ...intent }); }
  catch { return { status: 'not_started', reason: 'intent_not_persisted' }; }
  try { if (persistence.assertReadyToSubmit({ ...intent }) !== true) throw new Error('rejected'); }
  catch { return { status: 'not_started', reason: 'authorization_changed' }; }

  const url = fixedUrl(`/v2/branches/${encodeURIComponent(intent.branch)}/guides`);
  let response: Response;
  let bytes: Uint8Array;
  try {
    ({ response, bytes } = await request(url, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
      referrerPolicy: 'no-referrer', headers: { accept: 'application/json', authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json', prefer: 'handling=strict' }, body: prepared.body }, dependencies));
  } catch (error) {
    if (error instanceof CapturedResponseFailure) {
      const capturedAt = cleanDate(dependencies.now ?? (() => new Date())) ?? createdAt;
      try {
        await persistence.persistEncryptedRawResponse(opaque('guide', intent, url, error.response,
          error.bytes, capturedAt, false));
        return { status: 'unknown', diagnostic: error.diagnostic, intent, rawResponseSaved: true };
      } catch { return { status: 'unknown', diagnostic: 'raw_persistence', intent, rawResponseSaved: false }; }
    }
    return { status: 'unknown', diagnostic: diagnostic(error), intent, rawResponseSaved: false };
  }
  const capturedAt = cleanDate(dependencies.now ?? (() => new Date())) ?? createdAt;
  try { await persistence.persistEncryptedRawResponse(opaque('guide', intent, url, response, bytes, capturedAt, true)); }
  catch { discard(response); return { status: 'unknown', diagnostic: 'raw_persistence', intent, rawResponseSaved: false }; }
  if (response.status === 409) return { status: 'conflict', reason: 'slug_conflict', intent };
  if (response.status !== 201) return { status: 'unknown', diagnostic: 'http_status', intent, rawResponseSaved: true };
  let value: JsonObject;
  try { value = parseJson(response, bytes); }
  catch (error) { return { status: 'unknown', diagnostic: diagnostic(error), intent, rawResponseSaved: true }; }
  if (!exactGuide(value.data, intent)) return { status: 'unknown', diagnostic: 'schema', intent, rawResponseSaved: true };
  return { status: 'created', receipt: guideReceipt(intent, bytes, 201, false) };
}

export async function reconcileReadMeGuide(intentValue: ReadMeGuideIntent, apiToken: string,
  dependencies: ReadMeDependencies = {}): Promise<ReadMeGuideReconciliation> {
  const intent = cleanGuideIntent(intentValue);
  if (!intent || !validToken(apiToken)) return { status: 'unknown', diagnostic: 'schema' };
  if (intent.projectBinding.tokenFingerprint !== hash(apiToken)) return { status: 'binding_mismatch' };
  let metadata: ReadMeProjectMetadata;
  try { ({ metadata } = await readProject(apiToken, dependencies)); }
  catch (error) { return { status: 'unknown', diagnostic: diagnostic(error) }; }
  if (!sameProjectBinding(intent.projectBinding, projectBinding(metadata, apiToken))) return { status: 'binding_mismatch' };
  const url = fixedUrl(`/v2/branches/${encodeURIComponent(intent.branch)}/guides/${encodeURIComponent(intent.slug)}`);
  let response: Response;
  let bytes: Uint8Array;
  try {
    ({ response, bytes } = await request(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
      referrerPolicy: 'no-referrer', headers: { accept: 'application/json', authorization: `Bearer ${apiToken}` } }, dependencies));
  } catch (error) { return { status: 'unknown', diagnostic: diagnostic(error) }; }
  if (response.status === 404) return { status: 'absent' };
  if (response.status !== 200) return { status: 'unknown', diagnostic: 'http_status' };
  let value: JsonObject;
  try { value = parseJson(response, bytes); }
  catch (error) { return { status: 'unknown', diagnostic: diagnostic(error) }; }
  if (!exactGuide(value.data, intent)) return { status: 'mismatch' };
  return { status: 'matched', receipt: guideReceipt(intent, bytes, 200, true) };
}

export async function probeReadMeProject(apiToken: string,
  dependencies: ReadMeDependencies = {}): Promise<ReadMeProjectProbeResult> {
  if (!validToken(apiToken)) return { status: 'unknown', diagnostic: 'schema' };
  let metadata: ReadMeProjectMetadata;
  let bytes: Uint8Array;
  try {
    ({ metadata, bytes } = await readProject(apiToken, dependencies));
  } catch (error) { return { status: 'unknown', diagnostic: diagnostic(error) }; }
  return { status: 'observed', probe: { apiReachable: true, responseHash: hash(bytes), ...metadata,
    ownerBinding: metadata.ownerId === null ? 'owner_id_null_observed' : 'owner_id_observed',
    emailVerification: 'not_exposed_by_project_schema',
    projectPublication: 'not_established_by_project_metadata', schemaConfirmation: 'official_project_schema_observed' } };
}

export const readMeTesting = { validCategoryUri, validToken, cleanOnboardingIntent, cleanGuideIntent, exactGuide };
