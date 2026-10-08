import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey, verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import {
  nostrTesting,
  reconcileNostrTask,
  runNostrTask,
  verifyNostrPublication,
  type NostrDependencies,
  type NostrSocket,
} from '../src/integrations/nostr';
import { verifyRenderedArticle } from '../src/integrations/article-rendering';
import { defaultSettings } from '../src/main/store';
import type { Account, Channel, ExecutionContext, NostrReceipt, Site, Task } from '../src/shared/types';

const NOW = '2026-10-07T01:02:03.456Z';
const CREATED_AT = Math.floor(Date.parse(NOW) / 1_000);
const TARGET = 'https://example.com/guides/cost-audit?source=research';
const BODY = `A reliable cost audit starts with a reproducible question and records the data timestamp, assumptions, and failure conditions. The reviewed worksheet is available at ${TARGET}\n\nThe method separates execution charges from the difference between gross and net ending capital. It also records stale quotes, missing observations, and the point at which a result must be recomputed. This is independent educational material, and the operator may receive a commission from disclosed partner links without changing the calculation method.\n\nReaders should compare the stated inputs with their own records and treat every market example as historical evidence rather than a forecast.`;
const TEST_KEY = Uint8Array.from([...new Uint8Array(31), 1]);
const TEST_SECRET = Buffer.from(TEST_KEY).toString('hex');
const PUBKEY = getPublicKey(TEST_KEY);

function channel(): Channel {
  return {
    id: 'nostr', name: 'Nostr Long-form', domain: 'njump.me', url: 'https://njump.me/', submitUrl: 'https://njump.me/',
    categories: ['content'], languages: ['*'], kind: 'article', emailRequired: false, accountRequired: true,
    articleRequired: true, free: 'yes', freeNote: 'Fixed public relays.', automation: 'api', quality: 'B',
    qualityReason: 'Signed public long-form event.', provenance: 'built-in', rulesUrl: 'https://github.com/nostr-protocol/nips/blob/master/23.md',
    checkedAt: '2026-10-07', notes: 'NIP-23', allowedHosts: ['njump.me'], enabled: true,
  };
}

function site(): Site {
  return {
    id: 'site', domain: 'example.com', url: 'https://example.com/', email: 'owner@example.com', name: 'Example Research',
    description: 'Reproducible educational research.', category: 'finance', language: 'en', monthlyTarget: 2,
    status: 'ready', createdAt: NOW,
  };
}

function review() {
  return {
    status: 'passed' as const,
    reason: 'Independent review passed',
    reasonCode: 'passed' as const,
    checks: {
      factualAccuracy: 'pass' as const,
      authorRelationship: 'pass' as const,
      affiliateDisclosure: 'pass' as const,
      independentValue: 'pass' as const,
      financialSafety: 'pass' as const,
      channelRules: 'pass' as const,
    },
    reviewedAt: NOW,
    evidenceUrls: ['https://github.com/nostr-protocol/nips/blob/master/23.md'],
    draftRevision: 1,
    contentHash: 'a'.repeat(64),
    contextHash: 'b'.repeat(64),
  };
}

function task(): Task {
  return {
    id: 'task', siteId: 'site', channelId: 'nostr', sourceDomain: 'njump.me', status: 'running', createdAt: NOW,
    scheduledAt: NOW, updatedAt: NOW, attempts: 1, message: '', topicUrl: TARGET,
    draft: { title: 'A reproducible cost audit', description: 'How to separate fees from the gross-to-net result gap.', body: BODY },
    draftRevision: 1, articleApprovedAt: NOW, articleReview: review(),
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'nostr-account', channelId: 'nostr', email: 'owner@example.com', username: PUBKEY,
    displayName: 'Example Research', credentialKind: 'api_token', createdAt: NOW, updatedAt: NOW,
    registeredAt: NOW, status: 'registered', hasPassword: true, source: 'generated', ...overrides,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function renderedBody(content: string, href = TARGET): string {
  const displayedTarget = escapeHtml(TARGET);
  return content.split(/\n\s*\n/).map(paragraph => {
    const visible = escapeHtml(paragraph).replace(displayedTarget, `<a href="${escapeAttribute(href)}">${displayedTarget}</a>`);
    return `<p>${visible}</p>`;
  }).join('');
}

function readerPage(event: NostrEvent, articleMarkup: string, embedded: NostrEvent = event): string {
  return `<!doctype html><html><body>${articleMarkup}<div class="hidden"><div class="whitespace-pre-wrap">${escapeHtml(JSON.stringify(embedded))}</div></div></body></html>`;
}

function readerHtml(event: NostrEvent, href = TARGET, embedded: NostrEvent = event): string {
  return readerPage(event, `<article><div itemprop="articleBody">${renderedBody(event.content, href)}</div></article>`, embedded);
}

type RelayMode = 'accept-store' | 'uncertain-store' | 'uncertain-drop' | 'wrong-ok-drop' | 'reject';

class RelayHarness {
  readonly sends = new Map<string, number>();
  readonly reads = new Map<string, number>();
  readonly events = new Map<string, NostrEvent>();
  checkpointAtWrite?: () => void;
  queryTransform?: (event: NostrEvent, relay: string) => unknown;

  constructor(readonly mode: RelayMode = 'accept-store') {}

  factory = (url: string): NostrSocket => new FakeSocket(url, this);

  onSend(url: string, raw: string, socket: FakeSocket): void {
    const message = JSON.parse(raw) as unknown[];
    if (message[0] === 'EVENT') {
      this.sends.set(url, (this.sends.get(url) ?? 0) + 1);
      this.checkpointAtWrite?.();
      const event = structuredClone(message[1]) as NostrEvent;
      if (!['uncertain-drop', 'wrong-ok-drop', 'reject'].includes(this.mode)) this.events.set(event.id, event);
      if (this.mode === 'accept-store') queueMicrotask(() => socket.emit(['OK', event.id, true, 'saved']));
      if (this.mode === 'wrong-ok-drop') queueMicrotask(() => socket.emit(['OK', 'f'.repeat(64), true, 'wrong event']));
      if (this.mode === 'reject') queueMicrotask(() => socket.emit(['OK', event.id, false, 'blocked']));
      return;
    }
    if (message[0] === 'REQ') {
      this.reads.set(url, (this.reads.get(url) ?? 0) + 1);
      const subscription = String(message[1]);
      const filter = message[2] as { ids?: string[] };
      const found = filter.ids?.[0] ? this.events.get(filter.ids[0]) : undefined;
      queueMicrotask(() => {
        if (found) socket.emit(['EVENT', subscription, this.queryTransform ? this.queryTransform(structuredClone(found), url) : structuredClone(found)]);
        else socket.emit(['EOSE', subscription]);
      });
    }
  }
}

class FakeSocket implements NostrSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  private closed = false;

  constructor(readonly url: string, private readonly harness: RelayHarness) {
    queueMicrotask(() => { if (!this.closed) this.onopen?.(); });
  }

  send(data: string): void { if (!this.closed) this.harness.onSend(this.url, data, this); }
  close(): void { this.closed = true; }
  emit(message: unknown): void { if (!this.closed) this.onmessage?.({ data: JSON.stringify(message) }); }
}

function fixture(options: { existing?: Account | null; task?: Task; checkpoint?: (partial: Partial<Task>) => void } = {}) {
  const currentSite = site();
  const currentTask = options.task ?? task();
  const accounts: Account[] = options.existing === null ? [] : [structuredClone(options.existing ?? account())];
  const secrets = new Map<string, string>();
  if (accounts[0]) secrets.set(`account:${accounts[0].id}`, TEST_SECRET);
  const checkpoints: Partial<Task>[] = [];
  const logs: string[] = [];
  const controller = new AbortController();
  const context: ExecutionContext = {
    site: currentSite,
    channel: channel(),
    task: currentTask,
    settings: defaultSettings(),
    signal: controller.signal,
    secrets: {
      get: async key => secrets.get(key),
      set: async (key, value) => { secrets.set(key, value); },
      delete: async key => { secrets.delete(key); },
    },
    ai: { json: async <T>() => { throw new Error('Nostr adapter must not invoke AI'); } },
    getAccount: () => accounts[0],
    saveAccount: async (updated, secret) => {
      accounts[0] = structuredClone({ ...updated, hasPassword: secret ? true : updated.hasPassword });
      currentTask.accountId = updated.id;
      if (secret) secrets.set(`account:${updated.id}`, secret);
    },
    checkpoint: partial => {
      checkpoints.push(structuredClone(partial));
      if (options.checkpoint) options.checkpoint(partial);
      Object.assign(currentTask, structuredClone(partial));
    },
    log: message => { logs.push(message); },
  };
  return { context, task: currentTask, site: currentSite, accounts, secrets, checkpoints, logs, controller };
}

function dependencies(harness: RelayHarness, fetchHtml: NostrDependencies['fetchHtml']): NostrDependencies {
  return {
    webSocketFactory: harness.factory,
    fetchHtml,
    now: () => NOW,
    generateSecretKey: () => Uint8Array.from(TEST_KEY),
    randomUUID: () => 'nostr-account',
    timeoutMs: 10,
  };
}

function signedFixture(current: Task = task()): { task: Task; event: NostrEvent; receipt: NostrReceipt; url: string } {
  current.accountId = 'nostr-account';
  const identifier = nostrTesting.identifierFor(current.id);
  const article = nostrTesting.approvedArticle(current, site().url);
  const event = finalizeEvent(nostrTesting.eventTemplate(article, identifier, CREATED_AT), TEST_KEY);
  const receipt: NostrReceipt = {
    pubkey: event.pubkey, eventId: event.id, identifier, contentHash: article.contentHash, createdAt: CREATED_AT, stage: 'published',
  };
  current.nostr = receipt;
  current.submittedAt = NOW;
  current.checkpoint = 'nostr_published';
  current.publicUrl = nostrTesting.publicUrlFor(receipt);
  return { task: current, event, receipt, url: current.publicUrl };
}

test('stores the local author and immutable event identity before either fixed relay receives EVENT', async () => {
  const harness = new RelayHarness('accept-store');
  const data = fixture({ existing: null });
  let readerCalls = 0;
  harness.checkpointAtWrite = () => {
    assert.equal(data.task.checkpoint, 'nostr_publish_submitting');
    assert.equal(data.task.nostr?.stage, 'submitting');
    assert.equal(data.task.submittedAt, NOW);
    assert.equal(data.task.accountId, 'nostr-account');
    assert.equal(data.secrets.get('account:nostr-account'), TEST_SECRET);
  };
  const result = await runNostrTask(data.context, dependencies(harness, async url => {
    readerCalls++;
    const event = [...harness.events.values()][0];
    assert.ok(event);
    assert.equal(url, nostrTesting.publicUrlFor(data.task.nostr!));
    return { url, html: readerHtml(event) };
  }));

  assert.equal(result.status, 'review');
  assert.equal(result.checkpoint, 'nostr_published');
  assert.equal(readerCalls, 1);
  assert.deepEqual([...harness.sends.values()], [1, 1]);
  assert.ok([...harness.sends.keys()].every(url => nostrTesting.RELAYS.includes(url as typeof nostrTesting.RELAYS[number])));
  assert.deepEqual(data.checkpoints.map(item => item.checkpoint), ['nostr_publish_submitting', 'nostr_published']);
  const event = [...harness.events.values()][0];
  assert.equal(event.kind, 30023);
  assert.equal(event.content, BODY);
  assert.equal(event.pubkey, PUBKEY);
  assert.equal(event.tags.find(tag => tag[0] === 'title')?.[1], data.task.draft?.title);
  assert.equal(event.tags.find(tag => tag[0] === 'd')?.[1], nostrTesting.identifierFor(data.task.id));
  assert.equal(verifyEvent(event), true);
  const publicState = JSON.stringify({ task: data.task, checkpoints: data.checkpoints, result, accounts: data.accounts, logs: data.logs });
  assert.equal(publicState.includes(TEST_SECRET), false);
  assert.equal(data.logs.length, 0);
});

test('an uncertain first broadcast is never sent again and recovery remains read-only', async () => {
  const harness = new RelayHarness('uncertain-drop');
  const data = fixture({ existing: null });
  const deps = dependencies(harness, async () => { throw new Error('reader must not run without a relay event'); });
  const first = await runNostrTask(data.context, deps);
  assert.equal(first.status, 'needs_input');
  assert.equal(first.checkpoint, 'nostr_publish_submitting');
  assert.equal([...harness.sends.values()].reduce((sum, count) => sum + count, 0), 2);
  const receipt = structuredClone(data.task.nostr);

  const second = await runNostrTask(data.context, deps);
  assert.equal(second.status, 'needs_input');
  assert.deepEqual(data.task.nostr, receipt);
  assert.equal([...harness.sends.values()].reduce((sum, count) => sum + count, 0), 2, 'second run must issue no EVENT');
  assert.ok([...harness.reads.values()].reduce((sum, count) => sum + count, 0) >= 4);
});

test('an OK for a different event id never becomes a positive publication receipt', async () => {
  const harness = new RelayHarness('wrong-ok-drop');
  const data = fixture({ existing: null });
  const result = await runNostrTask(data.context, dependencies(harness, async () => {
    throw new Error('reader must not run for an unrelated OK');
  }));
  assert.equal(result.status, 'needs_input');
  assert.equal(result.publicUrl, undefined);
  assert.equal(data.task.checkpoint, 'nostr_publish_submitting');
  assert.equal(data.checkpoints.some(item => item.checkpoint === 'nostr_published'), false);
});

test('public verification rejects a bad signature, wrong event identity, content hash, or articleBody href', async t => {
  const base = signedFixture();

  await t.test('bad relay signature', async () => {
    const harness = new RelayHarness();
    harness.events.set(base.event.id, base.event);
    harness.queryTransform = event => ({ ...event, sig: '0'.repeat(128) });
    const result = await verifyNostrPublication(base.task, site().url, undefined, dependencies(harness, async () => {
      throw new Error('reader must not run');
    }));
    assert.equal(result.found, false);
    assert.equal(result.outcome, 'invalid');
  });

  await t.test('wrong relay event identity or body', async () => {
    const harness = new RelayHarness();
    harness.events.set(base.event.id, base.event);
    harness.queryTransform = event => ({ ...event, content: `${event.content}\nmutated` });
    const result = await verifyNostrPublication(base.task, site().url, undefined, dependencies(harness, async () => {
      throw new Error('reader must not run');
    }));
    assert.equal(result.found, false);
    assert.equal(result.outcome, 'invalid');
  });

  await t.test('wrong relay author identity', async () => {
    const harness = new RelayHarness();
    harness.events.set(base.event.id, base.event);
    harness.queryTransform = event => ({ ...event, pubkey: 'e'.repeat(64) });
    const result = await verifyNostrPublication(base.task, site().url, undefined, dependencies(harness, async () => {
      throw new Error('reader must not run');
    }));
    assert.equal(result.found, false);
    assert.equal(result.outcome, 'invalid');
  });

  await t.test('tampered durable content hash', async () => {
    const current = structuredClone(base.task);
    current.nostr!.contentHash = 'f'.repeat(64);
    const harness = new RelayHarness();
    harness.events.set(base.event.id, base.event);
    const result = await verifyNostrPublication(current, site().url, undefined, dependencies(harness, async () => {
      throw new Error('reader must not run');
    }));
    assert.equal(result.found, false);
    assert.equal(result.outcome, 'invalid');
    assert.equal([...harness.reads.values()].length, 0);
  });

  await t.test('reader href is outside the reviewed topic', async () => {
    const harness = new RelayHarness();
    harness.events.set(base.event.id, base.event);
    const result = await verifyNostrPublication(base.task, site().url, undefined, dependencies(harness, async url => ({
      url, html: readerHtml(base.event, 'https://example.com/unrelated'),
    })));
    assert.equal(result.found, false);
    assert.equal(result.outcome, 'invalid');
  });

  await t.test('reader source anchor without the full signed article is rejected', async () => {
    const harness = new RelayHarness();
    harness.events.set(base.event.id, base.event);
    const truncated = readerPage(base.event, `<article><div itemprop="articleBody"><a href="${TARGET}">source</a></div></article>`);
    const result = await verifyNostrPublication(base.task, site().url, undefined, dependencies(harness, async url => ({ url, html: truncated })));
    assert.equal(result.found, false);
    assert.equal(result.outcome, 'invalid');
  });

  await t.test('articleBody inside template is not treated as rendered', async () => {
    const harness = new RelayHarness();
    harness.events.set(base.event.id, base.event);
    const template = readerPage(base.event, `<template><div itemprop="articleBody">${renderedBody(base.event.content)}</div></template>`);
    const result = await verifyNostrPublication(base.task, site().url, undefined, dependencies(harness, async url => ({ url, html: template })));
    assert.equal(result.found, false);
    assert.equal(result.outcome, 'invalid');
  });

  await t.test('hidden article is not treated as publicly rendered', async () => {
    const harness = new RelayHarness();
    harness.events.set(base.event.id, base.event);
    const hidden = readerPage(base.event, `<article hidden><div itemprop="articleBody">${renderedBody(base.event.content)}</div></article>`);
    const result = await verifyNostrPublication(base.task, site().url, undefined, dependencies(harness, async url => ({ url, html: hidden })));
    assert.equal(result.found, false);
    assert.equal(result.outcome, 'invalid');
  });

  await t.test('reader embedded EVENT must equal the signed relay event', async () => {
    const harness = new RelayHarness();
    harness.events.set(base.event.id, base.event);
    const other = { ...base.event, sig: '0'.repeat(128) };
    const result = await verifyNostrPublication(base.task, site().url, undefined, dependencies(harness, async url => ({
      url, html: readerHtml(base.event, TARGET, other),
    })));
    assert.equal(result.found, false);
    assert.equal(result.outcome, 'invalid');
  });
});

test('visible full Markdown accepts natural njump rendering while binding all semantic tokens', async () => {
  const current = task();
  current.draft = {
    title: 'A reproducible cost audit',
    description: 'Formatted NIP-23 fixture.',
    body: `# A reproducible cost audit\n\n**Reproducible evidence** uses the [reviewed worksheet](${TARGET}) and \`gross_net\` fields.\n\n> Record assumptions before interpreting the result.\n\n- compare the same window\n- preserve losing rows\n\nThis explanatory paragraph makes the fixture a complete reviewed article rather than a link-only shell. It also documents uncertainty and avoids presenting a historical calculation as a forecast or recommendation.`,
  };
  const signed = signedFixture(current);
  const harness = new RelayHarness();
  harness.events.set(signed.event.id, signed.event);
  const rendered = `<article><h1 itemprop="headline">A reproducible cost audit</h1><div itemprop="articleBody"><p><strong>Reproducible evidence</strong> uses the <a href="${TARGET}">reviewed worksheet</a> and <code>gross_net</code> fields.</p><blockquote>Record assumptions before interpreting the result.</blockquote><ul><li>compare the same window</li><li>preserve losing rows</li></ul><p>This explanatory paragraph makes the fixture a complete reviewed article rather than a link-only shell. It also documents uncertainty and avoids presenting a historical calculation as a forecast or recommendation.</p></div></article>`;
  const result = await verifyNostrPublication(signed.task, site().url, undefined, dependencies(harness, async url => ({
    url, html: readerPage(signed.event, rendered),
  })));
  assert.equal(result.found, true);
  assert.equal(result.outcome, 'found');
});

test('public article semantics preserve signs, percentages, and comparison operators', async t => {
  const current = task();
  const introduction = 'The measured return was -5% while the recorded cost was $10.50, the validation inequality was 1 < 2, the expression was 2*3=6, and the ratio was 1/2. ';
  const explanation = 'Document limitations and independently verify every original input before interpreting these historical results. '.repeat(4);
  current.draft = {
    title: 'A numeric assessment',
    description: 'A signed numeric semantics fixture.',
    body: `${introduction}${explanation}[Full original research](${TARGET})`,
  };
  const signed = signedFixture(current);
  const visible = `${escapeHtml(introduction)}${escapeHtml(explanation)}<a href="${escapeAttribute(TARGET)}">Full original research</a>`;

  await t.test('unchanged numeric source remains a valid natural rendering', async () => {
    const harness = new RelayHarness();
    harness.events.set(signed.event.id, signed.event);
    const result = await verifyNostrPublication(signed.task, site().url, undefined, dependencies(harness, async url => ({
      url, html: readerPage(signed.event, `<article><div itemprop="articleBody">${visible}</div></article>`),
    })));
    assert.equal(result.found, true);
    assert.equal(result.outcome, 'found');
  });

  for (const [name, changed] of [
    ['return sign flipped', visible.replace('-5%', '+5%')],
    ['percentage marker removed', visible.replace('-5%', '-5')],
    ['comparison direction inverted', visible.replace('1 &lt; 2', '1 &gt; 2')],
    ['multiplication changed to division', visible.replace('2*3=6', '2/3=6')],
    ['fraction changed to ratio', visible.replace('1/2', '1:2')],
  ] as const) {
    await t.test(name, async () => {
      const harness = new RelayHarness();
      harness.events.set(signed.event.id, signed.event);
      const result = await verifyNostrPublication(signed.task, site().url, undefined, dependencies(harness, async url => ({
        url, html: readerPage(signed.event, `<article><div itemprop="articleBody">${changed}</div></article>`),
      })));
      assert.equal(result.found, false);
      assert.equal(result.outcome, 'invalid');
    });
  }
});

test('shared public rendering verifier scopes full text and target links to one visible article body', () => {
  const markdown = `A complete **reviewed explanation** preserves its evidence and limitations. [Full original research](${TARGET})`;
  const rendered = `<article><p>A complete <strong>reviewed explanation</strong> preserves its evidence and limitations. <a href="${escapeAttribute(TARGET)}" rel="ugc noopener">Full original research</a></p></article>`;
  assert.deepEqual(
    verifyRenderedArticle(rendered, markdown, TARGET, 'article'),
    { found: true, rel: 'ugc noopener' },
  );

  const footerOnly = `<article><p>A complete reviewed explanation.</p></article><footer><a href="${escapeAttribute(TARGET)}">Full original research</a></footer>`;
  assert.equal(verifyRenderedArticle(footerOnly, markdown, TARGET, 'article'), false);

  const hidden = `<article hidden><p>A complete reviewed explanation preserves its evidence and limitations. <a href="${escapeAttribute(TARGET)}">Full original research</a></p></article>`;
  assert.equal(verifyRenderedArticle(hidden, markdown, TARGET, 'article'), false);
});

test('malformed receipt returns invalid instead of throwing while deriving the reader URL', async () => {
  const signed = signedFixture();
  signed.task.nostr!.pubkey = 'not-hex';
  signed.task.publicUrl = undefined;
  const harness = new RelayHarness();
  const result = await verifyNostrPublication(signed.task, site().url, undefined, dependencies(harness, async () => {
    throw new Error('network must not run');
  }));
  assert.equal(result.found, false);
  assert.equal(result.outcome, 'invalid');
  assert.equal([...harness.reads.values()].length, 0);
});

test('relay visibility alone is not reported live when the fixed public reader is unavailable', async () => {
  const signed = signedFixture();
  const harness = new RelayHarness();
  harness.events.set(signed.event.id, signed.event);
  const result = await verifyNostrPublication(signed.task, site().url, undefined, dependencies(harness, async () => {
    throw new Error('synthetic reader outage');
  }));
  assert.equal(result.found, false);
  assert.equal(result.outcome, 'unreachable');
});

test('reconcile is read-only and returns the published receipt only after relay and njump agree', async () => {
  const signed = signedFixture();
  const harness = new RelayHarness();
  harness.events.set(signed.event.id, signed.event);
  const data = fixture({ existing: account(), task: signed.task });
  const result = await reconcileNostrTask(data.context, dependencies(harness, async url => ({ url, html: readerHtml(signed.event) })));
  assert.equal(result.status, 'found');
  if (result.status === 'found') {
    assert.equal(result.publicUrl, signed.url);
    assert.equal(result.nostr.stage, 'published');
  }
  assert.equal([...harness.sends.values()].length, 0);
  assert.ok([...harness.reads.values()].every(count => count === 1));
});

test('a submitted event remains read-only reconcilable after approval markers are cleared', async () => {
  const signed = signedFixture();
  signed.task.nostr!.stage = 'submitting';
  signed.task.checkpoint = 'nostr_publish_submitting';
  signed.task.articleApprovedAt = undefined;
  signed.task.articleReview = undefined;
  const harness = new RelayHarness();
  harness.events.set(signed.event.id, signed.event);
  const data = fixture({ existing: account(), task: signed.task });
  const deps = dependencies(harness, async url => ({ url, html: readerHtml(signed.event) }));

  const verified = await verifyNostrPublication(data.task, site().url, undefined, deps);
  assert.equal(verified.found, true);
  const reconciled = await reconcileNostrTask(data.context, deps);
  assert.equal(reconciled.status, 'found');
  const resumed = await runNostrTask(data.context, deps);
  assert.equal(resumed.status, 'review');
  assert.equal(resumed.checkpoint, 'nostr_published');
  assert.equal([...harness.sends.values()].reduce((sum, count) => sum + count, 0), 0);
  assert.ok([...harness.reads.values()].reduce((sum, count) => sum + count, 0) > 0);
});

test('a fresh task without current approval cannot create an identity or send EVENT', async () => {
  const current = task();
  current.articleApprovedAt = undefined;
  current.articleReview = undefined;
  const harness = new RelayHarness();
  const data = fixture({ existing: null, task: current });
  const result = await runNostrTask(data.context, dependencies(harness, async () => {
    throw new Error('reader must not run before approval');
  }));

  assert.equal(result.status, 'needs_input');
  assert.match(result.message, /审核/);
  assert.equal(data.accounts.length, 0);
  assert.equal(data.task.nostr, undefined);
  assert.equal(data.checkpoints.length, 0);
  assert.equal([...harness.sends.values()].reduce((sum, count) => sum + count, 0), 0);
});

test('a pause during the positive checkpoint retains the exact public receipt in the result', async () => {
  const harness = new RelayHarness('accept-store');
  let data!: ReturnType<typeof fixture>;
  data = fixture({
    existing: null,
    checkpoint: partial => {
      if (partial.checkpoint === 'nostr_published') {
        data.controller.abort();
        throw new Error('synthetic pause during positive checkpoint');
      }
    },
  });
  const result = await runNostrTask(data.context, dependencies(harness, async url => {
    const event = [...harness.events.values()][0];
    return { url, html: readerHtml(event) };
  }));
  assert.equal(result.status, 'review');
  assert.equal(result.checkpoint, 'nostr_published');
  assert.equal(result.publicUrl, nostrTesting.publicUrlFor(data.task.nostr!));
  assert.equal([...harness.sends.values()].reduce((sum, count) => sum + count, 0), 2);
});

test('Nostr public reader headers restrict qualification without changing the signed event', async () => {
  const base=signedFixture(),harness=new RelayHarness();harness.events.set(base.event.id,base.event);
  for(const directive of ['noindex','nofollow','max-image-preview:none']){
    const result=await verifyNostrPublication(base.task,site().url,undefined,dependencies(harness,async()=>({url:base.url,html:readerHtml(base.event),robotsHeader:directive})));
    assert.equal(result.found,directive!=='noindex');
    if(directive==='nofollow')assert.match(result.rel,/nofollow/);
  }
  assert.deepEqual(base.task.nostr,base.receipt);
});
