/** Non-sensitive summary stored on Task. Secrets and raw API responses stay in the vault journal. */
export interface Batch5TaskState {
  version: 1;
  channelId: string;
  operationId: string;
  sourceHash: string;
  requestHash: string;
  createdAt: string;
  stage: 'reserved' | 'submitting' | 'opaque_response' | 'api_receipt' | 'published';
  publicUrl?: string;
  remoteId?: string;
  accountId?: string;
}

export interface Batch5Intent {
  version: 1;
  channelId: string;
  operationId: string;
  siteId: string;
  sourceHash: string;
  requestHash: string;
  createdAt: string;
}

/** Encrypted as one value. May contain provider delete/edit tokens and exact raw response. */
export interface Batch5Receipt {
  version: 1;
  intent: Batch5Intent;
  publicUrl: string;
  remoteId?: string;
  rawResponse: string;
  secret?: string;
}

/** Encrypted as one value before interpreting a response whose outcome is not yet settled. */
export interface Batch5OpaqueResponse {
  version: 1;
  intent: Batch5Intent;
  status: number;
  contentType: string;
  responseUrl: string;
  bodyBase64: string;
  bodyComplete: boolean;
}

export interface Batch5Persistence {
  /** The implementation must durably save once and reject a different intent. */
  saveIntent(intent: Batch5Intent): Promise<void>;
  /** Durable proof that no POST has begun; safe to leave queued after authorization loss. */
  reserveIntent?(intent: Batch5Intent): Promise<void>;
  /** Atomically authorize and advance a reserved intent before POST. */
  markSending?(intent: Batch5Intent): Promise<void>;
  loadIntent(): Promise<Batch5Intent | undefined>;
  /** Encrypted vault storage; rawResponse and secret must never be copied to Task. */
  saveReceipt(receipt: Batch5Receipt): Promise<void>;
  loadReceipt(): Promise<Batch5Receipt | undefined>;
  /** Fresh task summary after a journal write; prevents receipt replay from lowering a published stage. */
  currentTaskState?(): Batch5TaskState | undefined;
  saveOpaqueResponse(response: Batch5OpaqueResponse): Promise<void>;
  loadOpaqueResponse(): Promise<Batch5OpaqueResponse | undefined>;
  /** Recheck current authorization immediately before the sole remote mutation. */
  assertReadyToSubmit?(intent: Batch5Intent): void | Promise<void>;
}

export interface Batch5AccountIntent {
  version: 1;
  channelId: string;
  siteId: string;
  operationId: string;
  requestHash: string;
  createdAt: string;
  /** Only in the encrypted journal. */
  username?: string;
  email?: string;
  password?: string;
}

/** Non-sensitive signup lifecycle persisted on the task beside the encrypted journal. */
export interface Batch5RegistrationState {
  version: 1;
  channelId: 'slopit' | 'rant';
  operationId: string;
  createdAt: string;
  /** Legacy `reserved` is unknown. Version 1 reserves are safe until `sending` is durably recorded. */
  stage: 'reserved' | 'sending' | 'rate_limited' | 'request_unknown' | 'rejected' | 'registered' | 'not_sent';
  sendGuardVersion?: 1;
  /** Durable start of the latest signup POST attempt. */
  sentAt?: string;
  rateLimitCount?: number;
  lastRateLimitedAt?: string;
}

export interface Batch5AccountReceipt {
  version: 1;
  intent: Batch5AccountIntent;
  accountId: string;
  publicUrl: string;
  /** Only in the encrypted journal. */
  secret: string;
  rawResponse: string;
}

/** Entire signup response is encrypted before its status or body is interpreted. */
export interface Batch5AccountOpaqueResponse {
  version: 1;
  intent: Batch5AccountIntent;
  status: number;
  contentType: string;
  responseUrl: string;
  bodyBase64: string;
  bodyComplete: boolean;
  receivedAt?: string;
  responseExact?: boolean;
}

export interface Batch5AccountPersistence {
  saveAccountIntent(intent: Batch5AccountIntent): Promise<void>;
  /** Replace only a proved-unsent intent, retaining its exact signup identity. */
  replaceUnsentAccountIntent?(previous: Batch5AccountIntent, next: Batch5AccountIntent): Promise<void>;
  /** Upgrade only a complete, exact legacy 429 rejection to the guarded retry protocol. */
  reviveLegacyRateLimit?(intent: Batch5AccountIntent, observedAt: string): Promise<void>;
  loadAccountIntent(channelId: string, siteId: string): Promise<Batch5AccountIntent | undefined>;
  saveAccountOpaqueResponse(response: Batch5AccountOpaqueResponse): Promise<void>;
  loadAccountOpaqueResponse(channelId: string, siteId: string): Promise<Batch5AccountOpaqueResponse | undefined>;
  saveAccountReceipt(receipt: Batch5AccountReceipt): Promise<void>;
  loadAccountReceipt(channelId: string, siteId: string): Promise<Batch5AccountReceipt | undefined>;
  /** Read journal-backed registration state, including one written by an earlier task. */
  loadAccountRegistration(channelId: string, siteId: string): Promise<Batch5RegistrationState | undefined>;
  /** Durably refine the task summary without changing or removing the one-shot encrypted intent. */
  markAccountRegistration(intent: Batch5AccountIntent, stage: Batch5RegistrationState['stage'], at?: string): Promise<void>;
  /** Recheck current authorization after journaling and before signup. The rolling 24-hour cap is checked atomically by saveAccountIntent. */
  assertReadyToRegister?(intent: Batch5AccountIntent): void | Promise<void>;
}

/** Typed local capacity refusal; never inferred from translated UI copy. */
export class Batch5RegistrationLimitError extends Error {
  readonly code = 'registration_limit' as const;
  constructor(message: string) { super(message); this.name = 'Batch5RegistrationLimitError'; }
}

export class Batch5IdentitySingleSiteError extends Error {
  readonly code = 'identity_single_site' as const;
  constructor(message: string) { super(message); this.name = 'Batch5IdentitySingleSiteError'; }
}

export interface Batch5Dependencies {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => Date;
  timeoutMs?: number;
  /** Optional native renderer for client-rendered public pages. */
  renderPage?: (url: string, targetUrl: string, title: string, markdown: string, signal: AbortSignal) => Promise<{found: boolean; indexable: boolean; rel: string}>;
}
