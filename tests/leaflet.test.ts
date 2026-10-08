import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import {
  connectLeafletAccount, leafletRecordHash, leafletTesting, reconcileLeafletTask, runLeafletTask, verifyLeafletPublication,
  type LeafletDependencies, type LeafletReceipt, type LeafletTransport,
} from '../src/integrations/leaflet';
import { articleContentHash, articleContextHash } from '../src/main/article-review';
import { defaultSettings } from '../src/main/store';
import type { Account, Channel, ExecutionContext, Site, Task } from '../src/shared/types';

const NOW = '2026-10-08T12:00:00.000Z';
const HANDLE = 'writer.example.com';
const DID = 'did:plc:leafletwriter1234567890';
const OTHER_DID = 'did:plc:differentwriter12345678';
const ACCESS = 'leaflet-access-token-current';
const REFRESH = 'leaflet-refresh-token-current';
const NEXT_ACCESS = 'leaflet-access-token-refreshed';
const NEXT_REFRESH = 'leaflet-refresh-token-refreshed';
const PASSWORD = 'abcd-efgh-ijkl-mnop';
const CID = 'bafyLeafletRecordCid123456789';
const TARGET = 'https://example.com/research/source-checking';
const SECOND_LINK = 'https://www.iana.org/help/example-domains';
const TITLE = 'A reproducible source-checking workflow';
const DESCRIPTION = 'How to preserve claims, dates, sources, and unresolved questions.';
const BODY = [
  '## Evidence boundaries',
  '',
  `A useful source check begins by recording the exact claim and the evidence that may change. The [maintained research notes](${TARGET}) explain the operating context and its limits.`,
  '',
  `The process separates observation from interpretation and points readers to [IANA's example-domain guidance](${SECOND_LINK}). This AI-assisted article promotes the operator's own site and discloses that the operator may receive referral commissions. No search, financial, or factual result is guaranteed.`,
].join('\n');

type TestTask = Task & { leaflet?: LeafletReceipt };

function channel(): Channel {
  return {
    id: 'leaflet', name: 'Leaflet', domain: 'leaflet.pub', url: 'https://leaflet.pub/', submitUrl: 'https://leaflet.pub/new',
    categories: ['content'], languages: ['*'], kind: 'article', emailRequired: false, accountRequired: true,
    articleRequired: true, free: 'conditional', freeNote: 'Existing Bluesky account and app password', automation: 'api',
    quality: 'B', qualityReason: 'ATProto long-form publication', rulesUrl: 'https://leaflet.pub/legal', checkedAt: '2026-10-08',
    notes: '', allowedHosts: ['leaflet.pub', 'bsky.social'], enabled: true,
  };
}

function credential(overrides: Record<string, unknown> = {}) {
  return { version: 1, appPassword: PASSWORD, accessJwt: ACCESS, refreshJwt: REFRESH, handle: HANDLE, did: DID, ...overrides };
}

function fixture(overrides: {
  task?: Partial<TestTask>;
  account?: Partial<Account>;
  checkpoint?: (partial: Partial<Task>) => void;
} = {}) {
  const site: Site = {
    id: 'site-leaflet', domain: 'example.com', url: 'https://example.com/', email: 'owner@example.com',
    name: 'Example Research', description: 'Reproducible source research', category: 'education', language: 'en',
    monthlyTarget: 2, status: 'ready', createdAt: NOW,
  };
  const settings = { ...defaultSettings(), articleReviewMode: 'ai' as const };
  const task: TestTask = {
    id: 'task-leaflet-01', siteId: site.id, channelId: 'leaflet', accountId: 'leaflet-account', sourceDomain: 'leaflet.pub',
    status: 'running', createdAt: NOW, scheduledAt: NOW, updatedAt: NOW, attempts: 1, message: '', topicUrl: TARGET,
    draftRevision: 4, draft: { title: TITLE, description: DESCRIPTION, body: BODY },
    articleReview: { status: 'passed', reason: 'independent review passed', reasonCode: 'passed', evidenceUrls: [],
      draftRevision: 4, contentHash: 'a'.repeat(64), contextHash: 'b'.repeat(64) },
    ...overrides.task,
  };
  let account: Account = {
    id: 'leaflet-account', channelId: 'leaflet', email: '', username: HANDLE,
    publicationUrl: leafletTesting.profileUrl(DID), credentialKind: 'api_token', status: 'registered', hasPassword: true,
    source: 'imported', createdAt: NOW, ...overrides.account,
  };
  if (task.articleReview?.contentHash === 'a'.repeat(64)) {
    task.articleReview = { ...task.articleReview, reviewContractVersion: 4, contentHash: articleContentHash(task),
      contextHash: articleContextHash(site, channel(), settings, account) };
  }
  const secrets = new Map([[`account:${account.id}`, JSON.stringify(credential())]]);
  const checkpoints: Array<Partial<TestTask>> = [];
  const abort = new AbortController();
  const context: ExecutionContext = {
    site, task, channel: channel(), settings, signal: abort.signal,
    ai: { json: async <T>() => ({} as T) },
    secrets: { get: async key => secrets.get(key), set: async (key, value) => { secrets.set(key, value); },
      delete: async key => { secrets.delete(key); } },
    getAccount: () => account,
    saveAccount: async next => { account = next; },
    checkpoint: partial => {
      overrides.checkpoint?.(partial);
      const saved = structuredClone(partial) as Partial<TestTask>;
      checkpoints.push(saved);
      Object.assign(task, saved);
    },
    log: () => undefined,
  };
  return { site, task, context, account: () => account, secrets, checkpoints, abort };
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

function html(value: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(value, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}

function session(overrides: Record<string, unknown> = {}) {
  return { accessJwt: NEXT_ACCESS, refreshJwt: NEXT_REFRESH, handle: HANDLE, did: DID, active: true, ...overrides };
}

function publicHtml(receipt: LeafletReceipt, options: {
  body?: string; title?: string; canonical?: string; atCanonical?: string; head?: string;
  bodyAttributes?: string; titleAttributes?: string; authorUrl?: string; markdown?: string;
} = {}): string {
  const url = leafletTesting.publicUrl(receipt.did, receipt.rkey);
  const uri = leafletTesting.expectedUri(receipt.did, receipt.rkey);
  const rendered = marked.parse(options.markdown ?? BODY, { async: false, gfm: true });
  assert.equal(typeof rendered, 'string');
  return '<!doctype html><html><head>'
    + `<link rel="canonical" href="${options.canonical ?? url}">`
    + `<meta name="at:canonical" content="${options.atCanonical ?? uri}">`
    + `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'BlogPosting',
      headline: options.title ?? TITLE, url, mainEntityOfPage: url,
      author: [{ '@type': 'Person', name: HANDLE, url: options.authorUrl ?? leafletTesting.profileUrl(receipt.did) }] })}</script>`
    + `${options.head ?? ''}</head>`
    + '<body><div class="publicationScrollContainer">'
    + `<h1 class="postTitle"${options.titleAttributes ? ` ${options.titleAttributes}` : ''}>${options.title ?? TITLE}</h1>`
    + `<div class="postContent"${options.bodyAttributes ? ` ${options.bodyAttributes}` : ''}>${options.body ?? rendered}</div>`
    + '</div></body></html>';
}

interface ServerOptions {
  disconnectCreate?: boolean;
  abortAfterCreate?: AbortController;
  createResponse?: Response;
  getOverride?: (record: Record<string, unknown>) => unknown;
  getNotFoundOnce?: boolean;
}

function server(f: ReturnType<typeof fixture>, options: ServerOptions = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let record: Record<string, unknown> | undefined;
  let receipt: LeafletReceipt | undefined;
  let page = '';
  let pageStatus = 200;
  let pageHeaders: Record<string, string> = {};
  let recordReads = 0;
  const fetch: LeafletTransport = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://bsky.social/xrpc/com.atproto.server.refreshSession') {
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${REFRESH}`);
      return json(session());
    }
    if (url === 'https://bsky.social/xrpc/com.atproto.repo.createRecord') {
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${NEXT_ACCESS}`);
      const body = JSON.parse(String(init.body)) as {
        repo: string; collection: string; rkey: string; validate: boolean; record: Record<string, unknown>;
      };
      assert.equal(body.repo, DID);
      assert.equal(body.collection, 'site.standard.document');
      assert.equal(body.validate, false);
      assert.equal(f.task.leaflet?.stage, 'creating');
      assert.equal(f.task.leaflet?.rkey, body.rkey);
      assert.equal(f.task.checkpoint, 'leaflet_create_submitting');
      assert.equal(f.task.submittedAt, NOW);
      record = body.record;
      receipt = f.task.leaflet;
      page = publicHtml(receipt!, { markdown: f.task.draft!.body });
      options.abortAfterCreate?.abort();
      if (options.disconnectCreate) throw Error('socket reset after remote commit');
      if (options.createResponse) return options.createResponse;
      return json({ uri: leafletTesting.expectedUri(DID, body.rkey), cid: CID });
    }
    if (url.startsWith('https://bsky.social/xrpc/com.atproto.repo.getRecord?')) {
      assert.equal(init.method, 'GET');
      assert.equal((init.headers as Record<string, string>).authorization, undefined);
      const query = new URL(url).searchParams;
      assert.equal(query.get('repo'), DID);
      assert.equal(query.get('collection'), 'site.standard.document');
      assert.equal(query.get('rkey'), f.task.leaflet?.rkey);
      recordReads += 1;
      if (!record || !f.task.leaflet || options.getNotFoundOnce && recordReads === 1) {
        return json({ error: 'RecordNotFound' }, 404);
      }
      const value = options.getOverride ? options.getOverride(record) : record;
      return json({ uri: leafletTesting.expectedUri(DID, f.task.leaflet.rkey), cid: CID, value });
    }
    if (f.task.leaflet && url === leafletTesting.publicUrl(DID, f.task.leaflet.rkey)) {
      assert.equal(init.method, 'GET');
      assert.equal((init.headers as Record<string, string>).authorization, undefined);
      return html(page || publicHtml(f.task.leaflet), pageStatus, pageHeaders);
    }
    throw Error(`unexpected request ${init.method} ${url}`);
  };
  return {
    fetch, calls,
    get record() { return record; },
    setRecord(value: Record<string, unknown> | undefined) { record = value; },
    setPage(value: string, status = 200, headers: Record<string, string> = {}) { page = value; pageStatus = status; pageHeaders = headers; },
    receipt: () => receipt,
  };
}

function dependencies(fetch: LeafletTransport, overrides: Partial<LeafletDependencies> = {}): LeafletDependencies {
  return { fetch, now: () => new Date(NOW), randomBytes: () => Uint8Array.from([0x12, 0x34]), ...overrides };
}

function methodCalls(calls: Array<{ url: string; init: RequestInit }>) {
  return calls.map(call => `${call.init.method ?? 'GET'} ${call.url.split('?')[0]}`);
}

test('connection uses only bsky.social, stores a dedicated app-password session, and refuses identity replacement', async () => {
  const saved = new Map<string, string>();
  let returnedDid = DID;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: LeafletTransport = async (url, init) => {
    calls.push({ url, init });
    assert.equal(url, 'https://bsky.social/xrpc/com.atproto.server.createSession');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(JSON.parse(String(init.body)), { identifier: HANDLE, password: PASSWORD });
    return json(session({ did: returnedDid }));
  };
  const vault = { get: async (key: string) => saved.get(key), set: async (key: string, value: string) => { saved.set(key, value); },
    delete: async (key: string) => { saved.delete(key); } };
  const connected = await connectLeafletAccount(vault, 'account', `@${HANDLE.toUpperCase()}`, PASSWORD, { fetch });
  assert.deepEqual(connected, { username: HANDLE, did: DID, publicationUrl: leafletTesting.profileUrl(DID) });
  const stored = JSON.parse(saved.get('account:account')!);
  assert.deepEqual(stored, credential({ accessJwt: NEXT_ACCESS, refreshJwt: NEXT_REFRESH }));
  assert.equal(JSON.stringify(connected).includes(PASSWORD), false);
  assert.equal(JSON.stringify(connected).includes(NEXT_ACCESS), false);
  const before = saved.get('account:account');
  returnedDid = OTHER_DID;
  await assert.rejects(connectLeafletAccount(vault, 'account', HANDLE, PASSWORD, { fetch }), /原 DID\/handle 不一致/);
  assert.equal(saved.get('account:account'), before);
  await assert.rejects(connectLeafletAccount(vault, 'bad-password', HANDLE, 'primary-password', { fetch }), /应用专用密码/);
  assert.equal(calls.length, 2);
});

test('approved long-form article checkpoints stable identity, creates exactly once, and verifies PDS plus public HTML', async () => {
  const f = fixture();
  const remote = server(f);
  const result = await runLeafletTask(f.context, dependencies(remote.fetch));
  assert.equal(result.status, 'review');
  assert.equal(result.leaflet?.stage, 'published');
  assert.equal(result.leaflet?.did, DID);
  assert.equal(result.leaflet?.uri, leafletTesting.expectedUri(DID, result.leaflet!.rkey));
  assert.equal(result.leaflet?.cid, CID);
  assert.equal(result.publicUrl, leafletTesting.publicUrl(DID, result.leaflet!.rkey));
  assert.deepEqual(f.checkpoints.map(value => ({ checkpoint: value.checkpoint, stage: value.leaflet?.stage,
    uri: value.leaflet?.uri, cid: value.leaflet?.cid })), [
    { checkpoint: 'leaflet_create_submitting', stage: 'creating', uri: undefined, cid: undefined },
    { checkpoint: 'leaflet_create_accepted', stage: 'creating', uri: result.leaflet!.uri, cid: CID },
    { checkpoint: 'leaflet_published', stage: 'published', uri: result.leaflet!.uri, cid: CID },
  ]);
  assert.deepEqual(methodCalls(remote.calls), [
    'POST https://bsky.social/xrpc/com.atproto.server.refreshSession',
    'POST https://bsky.social/xrpc/com.atproto.repo.createRecord',
    'GET https://bsky.social/xrpc/com.atproto.repo.getRecord',
  ]);
  assert.ok(remote.record);
  assert.equal(remote.record!.$type, 'site.standard.document');
  assert.equal(remote.record!.site, leafletTesting.profileUrl(DID));
  assert.equal(remote.record!.path, `/${result.leaflet!.rkey}`);
  assert.equal(remote.record!.title, TITLE);
  assert.deepEqual(remote.record!.contributors, [{ did: DID, role: 'author' }]);
  const content = remote.record!.content as { $type: string; pages: Array<{ id: string; $type: string; blocks: unknown[] }> };
  assert.equal(content.$type, 'pub.leaflet.content');
  assert.equal(content.pages.length, 1);
  assert.equal(content.pages[0].$type, 'pub.leaflet.pages.linearDocument');
  assert.match(content.pages[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(content.pages[0].blocks.length, 3);
  assert.equal(JSON.stringify(remote.record).includes('<script'), false);
  assert.equal(JSON.stringify(result).includes(NEXT_ACCESS), false);
  const verified = await verifyLeafletPublication(f.task, f.site.url, dependencies(remote.fetch));
  assert.deepEqual({ found: verified.found, outcome: verified.outcome, url: verified.url },
    { found: true, outcome: 'found', url: result.publicUrl });
  assert.match(verified.reason, /完整正文、全部链接/);
  assert.deepEqual(methodCalls(remote.calls).slice(-2), [
    'GET https://bsky.social/xrpc/com.atproto.repo.getRecord',
    `GET ${result.publicUrl}`,
  ]);
});

test('UTF-8 link facets use byte offsets and preserve every reviewed paragraph and heading', () => {
  const f = fixture({ task: { draft: { title: TITLE, description: DESCRIPTION,
    body: `## 中文标题\n\n请阅读[完整研究说明](${TARGET})，再比较[官方说明](${SECOND_LINK})。` } } });
  const built = leafletTesting.buildArticle(f.task, f.site.url, DID, '3mabcdefghi2j', NOW);
  assert.equal(leafletRecordHash(f.task, f.site.url, DID, '3mabcdefghi2j', NOW), built.recordHash);
  const page = (built.record.content as { pages: Array<{ blocks: Array<{ block: {
    $type: string; plaintext: string; facets?: Array<{ index: { byteStart: number; byteEnd: number }; features: Array<{ uri: string }> }>;
  } }> }> }).pages[0];
  assert.deepEqual(page.blocks.map(value => [value.block.$type, value.block.plaintext]), [
    ['pub.leaflet.blocks.header', '中文标题'],
    ['pub.leaflet.blocks.text', '请阅读完整研究说明，再比较官方说明。'],
  ]);
  const paragraph = page.blocks[1].block;
  assert.equal(paragraph.facets?.length, 2);
  for (const facet of paragraph.facets ?? []) {
    const selected = Buffer.from(paragraph.plaintext, 'utf8')
      .subarray(facet.index.byteStart, facet.index.byteEnd).toString('utf8');
    assert.ok(['完整研究说明', '官方说明'].includes(selected));
  }
  assert.deepEqual(built.links, [TARGET, SECOND_LINK]);
});

test('common nested lists preserve text and links as official Leaflet blocks', async () => {
  const body = [
    '## Practical checks',
    '',
    `The [maintained research notes](${TARGET}) define the scope.`,
    '',
    '- Record the claim',
    `- Compare [IANA guidance](${SECOND_LINK})`,
    '  1. Check the publication date',
    '  2. Preserve unresolved questions',
  ].join('\n');
  const f = fixture({ task: { draft: { title: TITLE, description: DESCRIPTION, body } } });
  const remote = server(f);
  const result = await runLeafletTask(f.context, dependencies(remote.fetch));
  assert.equal(result.leaflet?.stage, 'published');
  const blocks = ((remote.record!.content as { pages: Array<{ blocks: Array<{ block: Record<string, unknown> }> }> })
    .pages[0].blocks.map(value => value.block));
  assert.deepEqual(blocks.map(block => block.$type), [
    'pub.leaflet.blocks.header',
    'pub.leaflet.blocks.text',
    'pub.leaflet.blocks.unorderedList',
  ]);
  const list = blocks[2] as { children: Array<{ content: { plaintext: string }; orderedListChildren?: {
    $type: string; children: Array<{ content: { plaintext: string } }>;
  } }> };
  assert.deepEqual(list.children.map(item => item.content.plaintext.trim()), ['Record the claim', 'Compare IANA guidance']);
  assert.equal(list.children[1].orderedListChildren?.$type, 'pub.leaflet.blocks.orderedList');
  assert.deepEqual(list.children[1].orderedListChildren?.children.map(item => item.content.plaintext.trim()),
    ['Check the publication date', 'Preserve unresolved questions']);
  const verified = await verifyLeafletPublication(f.task, f.site.url, dependencies(remote.fetch));
  assert.equal(verified.found, true);
});

test('Markdown tables are rejected instead of collapsing distinct cell boundaries into one record', async () => {
  const tables = [
    `${BODY}\n\n| Step | Input |\n| --- | --- |\n| Verify | Primary source |`,
    `${BODY}\n\n| Step | Input |\n| --- | --- |\n| Verify Primary | source |`,
  ];
  for (const body of tables) {
    const f = fixture({ task: { draft: { title: TITLE, description: DESCRIPTION, body } } });
    assert.throws(() => leafletTesting.buildArticle(f.task, f.site.url, DID, '3mabcdefghi2j', NOW),
      /官方记录没有表格块/);
    const remote = server(f);
    const result = await runLeafletTask(f.context, dependencies(remote.fetch));
    assert.equal(result.status, 'needs_input');
    assert.match(result.message, /官方记录没有表格块/);
    assert.equal(remote.calls.some(call => call.url.endsWith('/com.atproto.repo.createRecord')), false);
  }
});

test('GFM strikethrough is rejected before createRecord without rewriting the reviewed draft', async () => {
  const body = `${BODY}\n\nStatus: ~~approved~~ suspended.`;
  const f = fixture({ task: { draft: { title: TITLE, description: DESCRIPTION, body } } });
  const originalDraft = structuredClone(f.task.draft);
  assert.throws(() => leafletTesting.buildArticle(f.task, f.site.url, DID, '3mabcdefghi2j', NOW), /不保留删除线语义/);
  const remote = server(f);
  const result = await runLeafletTask(f.context, dependencies(remote.fetch));
  assert.equal(result.status, 'needs_input');
  assert.match(result.message, /不保留删除线语义/);
  assert.deepEqual(f.task.draft, originalDraft);
  assert.equal(remote.calls.some(call => call.url.endsWith('/com.atproto.repo.createRecord')), false);
});

test('blockquote, fenced code, and horizontal rule use official Leaflet blocks and remain publicly verifiable', async () => {
  const body = [
    `The [maintained research notes](${TARGET}) define the scope.`,
    '',
    `> Preserve the quoted [IANA guidance](${SECOND_LINK}).`,
    '>',
    '> Treat the quotation as evidence, not a conclusion.',
    '',
    '```html',
    '<div data-state="literal">This stays inert code.</div>',
    '```',
    '',
    '---',
    '',
    'The final paragraph records the unresolved question.',
  ].join('\n');
  const f = fixture({ task: { draft: { title: TITLE, description: DESCRIPTION, body } } });
  const remote = server(f);
  const result = await runLeafletTask(f.context, dependencies(remote.fetch));
  assert.equal(result.leaflet?.stage, 'published');
  const record = remote.record!;
  const blocks = ((record.content as { pages: Array<{ blocks: Array<{ block: Record<string, unknown> }> }> })
    .pages[0].blocks.map(value => value.block));
  assert.deepEqual(blocks.map(block => block.$type), [
    'pub.leaflet.blocks.text',
    'pub.leaflet.blocks.blockquote',
    'pub.leaflet.blocks.code',
    'pub.leaflet.blocks.horizontalRule',
    'pub.leaflet.blocks.text',
  ]);
  assert.equal(blocks[1].plaintext,
    'Preserve the quoted IANA guidance.\nTreat the quotation as evidence, not a conclusion.');
  assert.equal((blocks[1].facets as Array<{ features: Array<{ uri: string }> }>)[0].features[0].uri, SECOND_LINK);
  assert.equal(blocks[2].language, 'html');
  assert.equal(blocks[2].plaintext, '<div data-state="literal">This stays inert code.</div>\n');
  assert.equal(JSON.stringify(record).includes('<script'), false);
  assert.match(String(record.textContent), /This stays inert code/);
  const verified = await verifyLeafletPublication(f.task, f.site.url, dependencies(remote.fetch));
  assert.equal(verified.found, true);
});

test('independent AI review is a hard gate and rejected or stale drafts make no network call', async () => {
  for (const task of [
    { articleReview: { status: 'failed' as const, reason: 'bad evidence', reasonCode: 'content_rejected' as const,
      evidenceUrls: [], draftRevision: 4, contentHash: 'x', contextHash: 'y' } },
    { draftRevision: 5 },
  ]) {
    const f = fixture({ task });
    let calls = 0;
    const result = await runLeafletTask(f.context, { fetch: async () => { calls += 1; throw Error('must not call'); } });
    assert.equal(result.status, 'needs_input');
    assert.match(result.message, /独立 AI 核对/);
    assert.equal(calls, 0);
    assert.equal(f.checkpoints.length, 0);
  }
});

test('a draft change while refreshed account state is saved invalidates approval before createRecord', async () => {
  const f = fixture();
  const save = f.context.saveAccount;
  f.context.saveAccount = async account => {
    await save(account);
    f.task.draftRevision = (f.task.draftRevision ?? 0) + 1;
  };
  const remote = server(f);
  const result = await runLeafletTask(f.context, dependencies(remote.fetch));
  assert.equal(result.status, 'needs_input');
  assert.match(result.message, /身份核对期间发生变更/);
  assert.deepEqual(methodCalls(remote.calls), ['POST https://bsky.social/xrpc/com.atproto.server.refreshSession']);
  assert.equal(remote.calls.some(call => call.url.endsWith('/com.atproto.repo.createRecord')), false);
  assert.equal(f.checkpoints.length, 0);
});

test('intent checkpoint failure prevents createRecord and does not invent a remote identity', async () => {
  let checkpointCalls = 0;
  const f = fixture({ checkpoint: () => { checkpointCalls += 1; throw Error('disk full'); } });
  const remote = server(f);
  const result = await runLeafletTask(f.context, dependencies(remote.fetch));
  assert.equal(result.status, 'queued');
  assert.match(result.message, /未持久保存/);
  assert.equal(checkpointCalls, 1);
  assert.deepEqual(methodCalls(remote.calls), ['POST https://bsky.social/xrpc/com.atproto.server.refreshSession']);
  assert.equal(remote.record, undefined);
});

test('unknown create result is recovered by exact read and never causes a second createRecord', async () => {
  const f = fixture();
  const remote = server(f, { disconnectCreate: true });
  const first = await runLeafletTask(f.context, dependencies(remote.fetch));
  assert.equal(first.status, 'review');
  assert.equal(first.leaflet?.stage, 'creating');
  assert.equal(first.checkpoint, 'leaflet_create_submitting');
  assert.equal(first.publicUrl, undefined);
  assert.equal(first.leaflet?.url, leafletTesting.publicUrl(DID, first.leaflet.rkey));
  assert.match(first.message, /不会重发/);
  assert.ok(remote.record);
  const second = await runLeafletTask(f.context, dependencies(remote.fetch));
  assert.equal(second.leaflet?.stage, 'published');
  assert.equal(second.checkpoint, 'leaflet_published');
  assert.equal(remote.calls.filter(call => call.url.endsWith('/com.atproto.repo.createRecord')).length, 1);
  assert.equal(remote.calls.filter(call => call.url.includes('/com.atproto.repo.getRecord?')).length, 1);
  const reconciled = await reconcileLeafletTask(f.context, dependencies(remote.fetch));
  assert.equal(reconciled.status, 'found');
  if (reconciled.status === 'found') {
    assert.equal(reconciled.leaflet.stage, 'published');
    assert.equal(reconciled.publicUrl, first.leaflet?.url);
  }
  assert.equal(remote.calls.filter(call => call.url.endsWith('/com.atproto.repo.createRecord')).length, 1);
});

test('accepted CID remains durable through PDS read lag and later recovery does not create again', async () => {
  const f = fixture();
  const remote = server(f, { getNotFoundOnce: true });
  const first = await runLeafletTask(f.context, dependencies(remote.fetch));
  assert.equal(first.leaflet?.stage, 'creating');
  assert.equal(first.leaflet?.cid, CID);
  assert.equal(first.checkpoint, 'leaflet_create_accepted');
  assert.equal(first.publicUrl, undefined);
  assert.equal(f.task.publicUrl, first.leaflet?.url);
  const second = await runLeafletTask(f.context, dependencies(remote.fetch));
  assert.equal(second.leaflet?.stage, 'published');
  assert.equal(second.publicUrl, first.leaflet?.url);
  assert.equal(remote.calls.filter(call => call.url.endsWith('/com.atproto.repo.createRecord')).length, 1);
  assert.equal(remote.calls.filter(call => call.url.includes('/com.atproto.repo.getRecord?')).length, 2);
});

test('a changed draft or conflicting record keeps the original rkey and forbids replacement publication', async () => {
  const changed = fixture();
  const changedRemote = server(changed, { disconnectCreate: true });
  const first = await runLeafletTask(changed.context, dependencies(changedRemote.fetch));
  const originalRkey = first.leaflet!.rkey;
  changed.task.draft = { ...changed.task.draft!, body: `${BODY}\n\nA later unreviewed paragraph.` };
  changed.task.draftRevision = 5;
  const changedResult = await runLeafletTask(changed.context, dependencies(changedRemote.fetch));
  assert.equal(changedResult.status, 'needs_input');
  assert.match(changedResult.message, /不会重发/);
  assert.equal(changedResult.leaflet?.rkey, originalRkey);
  assert.equal(changedRemote.calls.filter(call => call.url.endsWith('/com.atproto.repo.createRecord')).length, 1);
  assert.equal(changedRemote.calls.filter(call => call.url.includes('/com.atproto.repo.getRecord?')).length, 0);

  const conflict = fixture();
  const conflictRemote = server(conflict, { disconnectCreate: true,
    getOverride: record => ({ ...record, title: 'A different remote document' }) });
  await runLeafletTask(conflict.context, dependencies(conflictRemote.fetch));
  const conflictResult = await runLeafletTask(conflict.context, dependencies(conflictRemote.fetch));
  assert.equal(conflictResult.status, 'review');
  assert.match(conflictResult.message, /只会继续只读核验/);
  assert.equal(conflictRemote.calls.filter(call => call.url.endsWith('/com.atproto.repo.createRecord')).length, 1);
});

test('accepted response survives pause and retains the positive DID/rkey/CID receipt', async () => {
  const f = fixture();
  const remote = server(f, { abortAfterCreate: f.abort });
  const result = await runLeafletTask(f.context, dependencies(remote.fetch));
  assert.equal(result.status, 'review');
  assert.equal(result.checkpoint, 'leaflet_create_accepted');
  assert.equal(result.leaflet?.stage, 'creating');
  assert.equal(result.leaflet?.cid, CID);
  assert.equal(result.leaflet?.uri, leafletTesting.expectedUri(DID, result.leaflet!.rkey));
  assert.equal(f.task.leaflet?.cid, CID);
  assert.equal(remote.calls.filter(call => call.url.includes('/com.atproto.repo.getRecord?')).length, 0);
  assert.equal(JSON.stringify(result).includes(NEXT_ACCESS), false);
  assert.equal(JSON.stringify(result).includes(PASSWORD), false);
});

test('cancel before authentication performs no request; cancel during unknown POST preserves intent without retry', async () => {
  const before = fixture();
  before.abort.abort();
  let calls = 0;
  const beforeResult = await runLeafletTask(before.context, { fetch: async () => { calls += 1; throw Error('unexpected'); } });
  assert.equal(beforeResult.status, 'queued');
  assert.equal(calls, 0);

  const during = fixture();
  let createCalls = 0;
  const remote = server(during);
  const fetch: LeafletTransport = async (url, init) => {
    if (url.endsWith('/com.atproto.repo.createRecord')) {
      createCalls += 1;
      during.abort.abort();
      throw Error('aborted after transport handoff');
    }
    return remote.fetch(url, init);
  };
  const duringResult = await runLeafletTask(during.context, dependencies(fetch));
  assert.equal(duringResult.status, 'review');
  assert.equal(duringResult.leaflet?.stage, 'creating');
  assert.equal(duringResult.checkpoint, 'leaflet_create_submitting');
  assert.equal(duringResult.publicUrl, undefined);
  assert.equal(createCalls, 1);
});

test('credential refresh binds the original DID and handle before any publication request', async () => {
  for (const changed of [{ did: OTHER_DID }, { handle: 'other.example.com' }]) {
    const f = fixture();
    const calls: string[] = [];
    const fetch: LeafletTransport = async (url, init) => {
      calls.push(url);
      assert.equal(url, 'https://bsky.social/xrpc/com.atproto.server.refreshSession');
      assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${REFRESH}`);
      return json(session(changed));
    };
    const result = await runLeafletTask(f.context, dependencies(fetch));
    assert.equal(result.status, 'needs_input');
    assert.match(result.message, /原 DID|应用专用密码/);
    assert.equal(calls.length, 1);
    assert.equal(f.account().status, 'credentials_invalid');
    assert.equal(f.checkpoints.length, 0);
  }
});

test('public verification rejects noindex, wrong canonical, hidden or incomplete content, missing links, and PDS mutations', async () => {
  const f = fixture();
  const remote = server(f);
  const published = await runLeafletTask(f.context, dependencies(remote.fetch));
  assert.equal(published.leaflet?.stage, 'published');
  const receipt = published.leaflet!;
  const originalRecord = structuredClone(remote.record!);
  const rendered = marked.parse(BODY, { async: false, gfm: true });
  assert.equal(typeof rendered, 'string');
  const cases: Array<{ name: string; page: string; headers?: Record<string, string> }> = [
    { name: 'noindex meta', page: publicHtml(receipt, { head: '<meta name="robots" content="noindex,follow">' }) },
    { name: 'noindex header', page: publicHtml(receipt), headers: { 'x-robots-tag': 'noindex' } },
    { name: 'none robots directive', page: publicHtml(receipt, { head: '<meta name="robots" content="none">' }) },
    { name: 'none googlebot directive', page: publicHtml(receipt, { head: '<meta name="googlebot" content="NONE">' }) },
    { name: 'none header directive', page: publicHtml(receipt), headers: { 'x-robots-tag': 'none' } },
    { name: 'wrong canonical', page: publicHtml(receipt, { canonical: 'https://leaflet.pub/p/did:plc:wrong/3mwrongwrong2' }) },
    { name: 'wrong AT canonical', page: publicHtml(receipt, { atCanonical: 'at://did:plc:wrong/site.standard.document/3mwrongwrong2' }) },
    { name: 'wrong structured author', page: publicHtml(receipt, { authorUrl: leafletTesting.profileUrl(OTHER_DID) }) },
    { name: 'hidden body', page: publicHtml(receipt, { bodyAttributes: 'hidden' }) },
    { name: 'hidden title', page: publicHtml(receipt, { titleAttributes: 'aria-hidden="true"' }) },
    { name: 'incomplete body', page: publicHtml(receipt, { body: '<h2>Evidence boundaries</h2><p>Only the first sentence.</p>' }) },
    { name: 'missing secondary href', page: publicHtml(receipt, { body: String(rendered).replace(`href="${SECOND_LINK}"`, '') }) },
  ];
  for (const item of cases) {
    remote.setRecord(originalRecord);
    remote.setPage(item.page, 200, item.headers);
    const result = await verifyLeafletPublication(f.task, f.site.url, dependencies(remote.fetch));
    assert.equal(result.found, false, item.name);
    assert.equal(result.outcome, 'invalid', item.name);
  }
  remote.setRecord(originalRecord);
  remote.setPage(publicHtml(receipt), 200, { 'x-robots-tag': 'max-image-preview:none' });
  const imagePreview = await verifyLeafletPublication(f.task, f.site.url, dependencies(remote.fetch));
  assert.equal(imagePreview.found, true, 'max-image-preview:none must not be treated as robots none');
  remote.setRecord({ ...originalRecord, contributors: [{ did: OTHER_DID, role: 'author' }] });
  remote.setPage(publicHtml(receipt));
  const mutated = await verifyLeafletPublication(f.task, f.site.url, dependencies(remote.fetch));
  assert.equal(mutated.found, false);
  assert.equal(mutated.outcome, 'invalid');
  assert.match(mutated.reason, /PDS 原记录/);
});

test('Leaflet cached 404 is unreachable, never absent, and verification never issues another POST', async () => {
  const f = fixture();
  const remote = server(f);
  const published = await runLeafletTask(f.context, dependencies(remote.fetch));
  assert.equal(published.leaflet?.stage, 'published');
  const creates = remote.calls.filter(call => call.url.endsWith('/com.atproto.repo.createRecord')).length;
  remote.setPage('cached not found', 404);
  const result = await verifyLeafletPublication(f.task, f.site.url, dependencies(remote.fetch));
  assert.equal(result.found, false);
  assert.equal(result.outcome, 'unreachable');
  assert.match(result.reason, /缓存|不会重发/);
  assert.equal(remote.calls.filter(call => call.url.endsWith('/com.atproto.repo.createRecord')).length, creates);
});

test('malformed Markdown and unsafe HTML are rejected before createRecord', async () => {
  const drafts = [
    `${BODY}\n\n<script>alert(1)</script>`,
    `${BODY}\n\nA raw <strong>HTML fragment</strong> is not accepted.`,
    `${BODY}\n\n![remote image](https://images.example/image.png)`,
    `${BODY}\n\n| Step | Input |\n| --- | --- |\n| Verify | Primary source |`,
    BODY.replace(`[maintained research notes](${TARGET})`, 'maintained research notes'),
  ];
  for (const body of drafts) {
    const f = fixture({ task: { draft: { title: TITLE, description: DESCRIPTION, body } } });
    // Keep the review valid for this exact synthetic draft so this test reaches
    // the deterministic Markdown-to-record boundary rather than the AI gate.
    f.task.articleReview = { ...f.task.articleReview!, contentHash: articleContentHash(f.task) };
    const remote = server(f);
    const result = await runLeafletTask(f.context, dependencies(remote.fetch));
    assert.equal(result.status, 'needs_input');
    assert.equal(remote.calls.filter(call => call.url.endsWith('/com.atproto.repo.createRecord')).length, 0);
  }
});

test('oversized or malformed remote responses fail closed without leaking credentials', async () => {
  const f = fixture();
  const fetch: LeafletTransport = async (url, init) => {
    if (url.endsWith('/com.atproto.server.refreshSession')) return json(session());
    if (url.endsWith('/com.atproto.repo.createRecord')) {
      assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${NEXT_ACCESS}`);
      return json({ uri: 'bad', cid: CID });
    }
    throw Error('unexpected');
  };
  const result = await runLeafletTask(f.context, dependencies(fetch));
  assert.equal(result.status, 'review');
  assert.equal(result.leaflet?.stage, 'creating');
  assert.match(result.message, /不会重发/);
  assert.equal(JSON.stringify(result).includes(NEXT_ACCESS), false);
  assert.equal(JSON.stringify(result).includes(PASSWORD), false);

  const connected = new Map<string, string>();
  const vault = { get: async (key: string) => connected.get(key), set: async (key: string, value: string) => { connected.set(key, value); },
    delete: async (key: string) => { connected.delete(key); } };
  await assert.rejects(connectLeafletAccount(vault, 'oversized', HANDLE, PASSWORD, {
    fetch: async () => json(session(), 200, { 'content-length': String(600 * 1024) }),
  }));
  assert.equal(connected.has('account:oversized'), false);
});
