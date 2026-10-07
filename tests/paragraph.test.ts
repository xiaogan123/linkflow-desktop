import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectParagraphPublication,
  paragraphTesting,
  reconcileParagraphTask,
  runParagraphTask,
  validateParagraphApiKey,
  verifyParagraphPublication,
  type ParagraphTaskState,
  type ParagraphTransport,
} from '../src/integrations/paragraph';
import { defaultSettings } from '../src/main/store';
import type { Account, Channel, ExecutionContext, Site, Task } from '../src/shared/types';

const PUBLICATION_ID = 'BMV6abfvCSUl51ErCVzd';
const OTHER_PUBLICATION_ID = 'OtherPublication000001';
const OWNER_ID = 'AeAOtR8TqKWyzG5apA1R';
const POST_ID = '3T2PQZlsdQtigUp4fhlb';
const API_KEY = 'synthetic-paragraph-api-key-for-tests-only';
const NOW = '2026-10-07T03:04:05.678Z';
const PUBLICATION_SLUG = 'owner-notes';
const PUBLICATION_URL = `https://paragraph.com/@${PUBLICATION_SLUG}/`;
const TARGET = 'https://example.com/guides/operational-risk';
const BODY = [
  `A reproducible review starts by recording the exact inputs, source dates, and failure conditions. The maintained checklist at [the operator's site](${TARGET}) shows how to repeat each check and distinguish observations from assumptions. The publication is operated by Example Lab and the commercial relationship is disclosed here.`,
  'Readers should compare current eligibility terms, failure behavior, and operational constraints before making a decision. Example Lab may receive a commission from a relevant referral, but that relationship does not change the listed limitations or the steps used to reproduce each observation.',
].join('\n\n');

function json(value: unknown, status = 200, responseUrl?: string): Response {
  const response = new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  if (responseUrl) Object.defineProperty(response, 'url', { configurable: true, value: responseUrl });
  return response;
}

function html(value: string, status = 200, responseUrl?: string): Response {
  const response = new Response(value, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  if (responseUrl) Object.defineProperty(response, 'url', { configurable: true, value: responseUrl });
  return response;
}

function publication(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: PUBLICATION_ID, name: 'Owner Notes', ownerUserId: OWNER_ID, slug: PUBLICATION_SLUG, ...overrides };
}

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'paragraph', name: 'Paragraph', domain: 'paragraph.com', url: 'https://paragraph.com/', submitUrl: 'https://app.paragraph.com/',
    categories: ['content'], languages: ['*'], kind: 'article', emailRequired: false, accountRequired: true, articleRequired: true,
    free: 'yes', freeNote: 'Owned publication API.', automation: 'api', quality: 'C', qualityReason: 'Owned original publication.',
    rulesUrl: 'https://paragraph.com/content-guidelines', checkedAt: '2026-10-06',
    notes: 'Only original editorial publications with disclosed incidental commercial links.',
    allowedHosts: ['paragraph.com', 'app.paragraph.com'], enabled: true, provenance: 'built-in',
    ...overrides,
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'paragraph-account', channelId: 'paragraph', credentialKind: 'api_token', email: '', username: PUBLICATION_ID,
    displayName: 'Owner Notes', publicationUrl: PUBLICATION_URL, createdAt: NOW, updatedAt: NOW,
    status: 'registered', hasPassword: true, source: 'imported',
    ...overrides,
  };
}

function storedCredential(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    apiKey: API_KEY,
    publicationId: PUBLICATION_ID,
    ownerUserId: OWNER_ID,
    publicationSlug: PUBLICATION_SLUG,
    ...overrides,
  });
}

function fixture(options: { task?: Partial<Task>; account?: Partial<Account>; channel?: Partial<Channel> } = {}) {
  const site: Site = {
    id: 'site', domain: 'example.com', url: 'https://example.com/', email: 'owner@example.com', name: 'Example Lab',
    description: 'Source-backed operational research.', category: 'business', language: 'en', monthlyTarget: 2,
    status: 'ready', createdAt: NOW, paragraph: { publicationId: PUBLICATION_ID, url: PUBLICATION_URL },
    qualifications: { publication: PUBLICATION_URL },
  };
  const task: Task = {
    id: 'task', siteId: site.id, channelId: 'paragraph', accountId: 'paragraph-account', sourceDomain: 'paragraph.com', status: 'running',
    createdAt: NOW, scheduledAt: NOW, updatedAt: NOW, attempts: 1, message: '', topicUrl: TARGET,
    draft: { title: 'A reproducible operational review', description: 'Documented checks, ownership, and limitations.', body: BODY },
    draftRevision: 1, articleApprovedAt: NOW,
    ...options.task,
  };
  const accounts = [account(options.account)];
  const secrets = new Map<string, string>([[`account:${accounts[0].id}`, storedCredential()]]);
  const checkpoints: Partial<Task>[] = [];
  const context: ExecutionContext = {
    site,
    channel: channel(options.channel),
    task,
    settings: defaultSettings(),
    signal: new AbortController().signal,
    secrets: {
      get: async key => secrets.get(key),
      set: async (key, value) => { secrets.set(key, value); },
      delete: async key => { secrets.delete(key); },
    },
    ai: { json: async <T>() => ({} as T) },
    getAccount: () => accounts[0],
    saveAccount: async updated => { accounts[0] = structuredClone(updated); },
    checkpoint: partial => { checkpoints.push(structuredClone(partial)); Object.assign(task, structuredClone(partial)); },
    log: () => undefined,
  };
  return { context, site, task, accounts, secrets, checkpoints };
}

function article(task: Task, site: Site) {
  return paragraphTesting.approvedArticle(task, site, false);
}

function remotePost(task: Task, site: Site, status: 'draft' | 'published', overrides: Record<string, unknown> = {}) {
  const approved = article(task, site);
  return {
    id: POST_ID,
    title: approved.title,
    subtitle: approved.subtitle,
    slug: approved.slug,
    markdown: approved.markdown,
    status,
    publishOnline: status === 'published',
    authorIds: [OWNER_ID],
    authors: [{ id: OWNER_ID, publicationId: PUBLICATION_ID, name: 'Owner' }],
    staticHtml: renderedFixtureBody(),
    ...overrides,
  };
}

function renderedFixtureBody():string{
  return BODY.split('\n\n').map(paragraph=>'<p>'+paragraph.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!)).replace(`[the operator's site](${TARGET})`,`<a href="${TARGET}" rel="nofollow ugc">the operator's site</a>`)+'</p>').join('');
}
function publicPage(): string {
  return `<html><body><article><div class="prose">${renderedFixtureBody()}</div></article></body></html>`;
}

test('connection validates /v1/me on the fixed API host and stores the key only in the vault', async () => {
  const writes = new Map<string, string>();
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const secrets = {
    get: async (key: string) => writes.get(key),
    set: async (key: string, value: string) => { writes.set(key, value); },
    delete: async (key: string) => { writes.delete(key); },
  };
  const result = await connectParagraphPublication(secrets, 'new-account', API_KEY, {
    fetch: async (url, init) => {
      urls.push(url);
      headers.push(init.headers as Record<string, string>);
      return json(publication());
    },
  });
  assert.deepEqual(result, { id: PUBLICATION_ID, name: 'Owner Notes', ownerUserId: OWNER_ID, slug: PUBLICATION_SLUG, url: PUBLICATION_URL });
  assert.deepEqual(urls, ['https://public.api.paragraph.com/api/v1/me']);
  assert.equal(headers[0].authorization, `Bearer ${API_KEY}`);
  assert.equal(urls.some(url => url.includes(API_KEY)), false);
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
  const saved = JSON.parse(writes.get('account:new-account')!);
  assert.equal(saved.apiKey, API_KEY);
  assert.equal(saved.publicationId, PUBLICATION_ID);

  await assert.rejects(validateParagraphApiKey(API_KEY, {
    fetch: async () => json(publication(), 200, 'https://attacker.example/api/v1/me'),
  }));
});

test('publisher persists intent, creates an explicit no-email draft, verifies it, publishes the same post, and verifies the anonymous page', async () => {
  const { context, task, site, checkpoints } = fixture();
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  let published = false;
  let slug = '';
  const fetch: ParagraphTransport = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname === '/api/v1/me') return json(publication());
    if (url.pathname === '/api/v1/posts' && init.method === 'POST') {
      assert.equal(checkpoints.at(-1)?.checkpoint, 'paragraph_insert_submitting');
      assert.equal(checkpoints.at(-1)?.paragraph?.postId, undefined);
      const body = JSON.parse(String(init.body));
      slug = body.slug;
      assert.deepEqual(body, {
        title: task.draft!.title,
        markdown: task.draft!.body,
        subtitle: task.draft!.description,
        slug,
        authorIds: [OWNER_ID],
        status: 'draft',
        sendNewsletter: false,
      });
      return json({ id: POST_ID, status: 'draft' });
    }
    if (url.pathname === `/api/v1/posts/${POST_ID}` && init.method === 'GET') {
      return json(remotePost(task, site, published ? 'published' : 'draft'));
    }
    if (url.pathname === `/api/v1/posts/${POST_ID}` && init.method === 'PUT') {
      assert.equal(checkpoints.at(-1)?.checkpoint, 'paragraph_publish_submitting');
      assert.deepEqual(JSON.parse(String(init.body)), { status: 'published', sendNewsletter: false, publishOnline: true });
      published = true;
      return json({ success: true });
    }
    if (url.pathname === `/api/v1/publications/${PUBLICATION_ID}/posts/slug/${slug}`) {
      assert.equal(init.headers && 'authorization' in (init.headers as Record<string, string>), false);
      assert.equal(url.searchParams.get('includeContent'), 'true');
      return json(remotePost(task, site, 'published'));
    }
    if (url.origin === 'https://paragraph.com' && url.pathname === `/@${PUBLICATION_SLUG}/${slug}`) return html(publicPage());
    throw new Error(`unexpected ${init.method} ${input}`);
  };
  const result = await runParagraphTask(context, { fetch, now: () => NOW });
  assert.equal(result.status, 'review');
  assert.equal(result.publicUrl, `https://paragraph.com/@${PUBLICATION_SLUG}/${slug}`);
  assert.deepEqual(checkpoints.map(item => item.checkpoint), [
    'paragraph_insert_submitting', 'paragraph_draft_created', 'paragraph_publish_submitting', 'paragraph_published',
  ]);
  assert.deepEqual(checkpoints.map(item => item.paragraph?.stage), ['inserting', 'draft', 'publishing', 'published']);
  assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{16}$/);
  assert.match(checkpoints[0].paragraph?.contentHash ?? '', /^[0-9a-f]{64}$/);
  assert.equal(checkpoints[0].paragraph?.slug, slug);
  assert.equal(checkpoints[0].paragraph?.publicationId, PUBLICATION_ID);
  assert.ok(calls.filter(call => call.init.method === 'POST').every(call => call.url.origin === 'https://public.api.paragraph.com'));
  assert.ok(calls.filter(call => call.init.method === 'PUT').every(call => call.url.origin === 'https://public.api.paragraph.com'));
  assert.ok(calls.every(call => !call.url.toString().includes(API_KEY)));
});

test('an unknown create is never POSTed again and reconciliation remains read-only', async () => {
  const { context, task, checkpoints } = fixture();
  let posts = 0;
  const first = await runParagraphTask(context, {
    now: () => NOW,
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === '/api/v1/me') return json(publication());
      if (url.pathname === '/api/v1/posts' && init.method === 'POST') { posts++; throw new Error('connection lost after request'); }
      throw new Error(`unexpected ${init.method} ${input}`);
    },
  });
  assert.equal(first.status, 'needs_input');
  assert.equal(task.paragraph?.stage, 'inserting');
  assert.equal(task.paragraph?.postId, undefined);
  assert.equal(checkpoints.at(-1)?.checkpoint, 'paragraph_insert_submitting');

  const methods: string[] = [];
  const second = await runParagraphTask(context, {
    fetch: async (input, init) => {
      const url = new URL(input);
      methods.push(String(init.method));
      if (url.pathname === '/api/v1/me') return json(publication());
      if (url.pathname === '/api/v1/posts' && init.method === 'GET') return json({ items: [], pagination: { hasMore: false } });
      if (init.method === 'POST') posts++;
      throw new Error(`unexpected ${init.method} ${input}`);
    },
  });
  assert.equal(second.status, 'needs_input');
  assert.match(second.message, /不会再次 POST/);
  assert.equal(posts, 1);
  assert.ok(methods.every(method => method === 'GET'));
});

test('read-only reconciliation claims one exact draft and returns its immutable postId', async () => {
  const { context, task, site, checkpoints } = fixture();
  const approved = article(task, site);
  task.submittedAt = NOW;
  task.checkpoint = 'paragraph_insert_submitting';
  task.paragraph = { publicationId: PUBLICATION_ID, slug: approved.slug, contentHash: approved.contentHash, stage: 'inserting' };
  const methods: string[] = [];
  const result = await reconcileParagraphTask(context, {
    fetch: async (input, init) => {
      const url = new URL(input);
      methods.push(String(init.method));
      if (url.pathname === '/api/v1/me') return json(publication());
      if (url.pathname === '/api/v1/posts') {
        const status = url.searchParams.get('status');
        return json({ items: status === 'draft' ? [
          { ...remotePost(task, site, 'draft'), id: 'unrelated-post', title: 'Unrelated post', slug: '另一篇文章', markdown: 'Different content.' },
          remotePost(task, site, 'draft'),
        ] : [], pagination: { hasMore: false } });
      }
      throw new Error(`unexpected ${init.method} ${input}`);
    },
  });
  assert.deepEqual(result, {
    status: 'draft',
    paragraph: { publicationId: PUBLICATION_ID, slug: approved.slug, contentHash: approved.contentHash, stage: 'draft', postId: POST_ID },
  });
  assert.deepEqual(checkpoints, []);
  assert.ok(methods.every(method => method === 'GET'));
});

test('read-only reconciliation returns the complete published receipt only after anonymous page verification', async () => {
  const { context, task, site, checkpoints } = fixture();
  const approved = article(task, site);
  task.submittedAt = NOW;
  task.checkpoint = 'paragraph_publish_submitting';
  task.paragraph = {
    publicationId: PUBLICATION_ID,
    slug: approved.slug,
    contentHash: approved.contentHash,
    stage: 'publishing',
    postId: POST_ID,
  };
  const methods: string[] = [];
  const result = await reconcileParagraphTask(context, {
    fetch: async (input, init) => {
      const url = new URL(input);
      methods.push(String(init.method));
      if (url.pathname === '/api/v1/me') return json(publication());
      if (url.pathname === `/api/v1/posts/${POST_ID}`) return json(remotePost(task, site, 'published'));
      if (url.pathname === `/api/v1/publications/${PUBLICATION_ID}/posts/slug/${approved.slug}`) return json(remotePost(task, site, 'published'));
      if (url.origin === 'https://paragraph.com') return html(publicPage());
      throw new Error(`unexpected ${init.method} ${input}`);
    },
  });
  assert.deepEqual(result, {
    status: 'found',
    publicUrl: `https://paragraph.com/@${PUBLICATION_SLUG}/${approved.slug}`,
    paragraph: { ...task.paragraph, stage: 'published' },
  });
  assert.deepEqual(checkpoints, []);
  assert.ok(methods.every(method => method === 'GET'));
});

test('an unknown publish is not PUT again even when the immediate read still says draft', async () => {
  const { context, task, site } = fixture();
  let posts = 0;
  let puts = 0;
  let draftReads = 0;
  const first = await runParagraphTask(context, {
    now: () => NOW,
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === '/api/v1/me') return json(publication());
      if (url.pathname === '/api/v1/posts' && init.method === 'POST') { posts++; return json({ id: POST_ID, status: 'draft' }); }
      if (url.pathname === `/api/v1/posts/${POST_ID}` && init.method === 'GET') { draftReads++; return json(remotePost(task, site, 'draft')); }
      if (url.pathname === `/api/v1/posts/${POST_ID}` && init.method === 'PUT') { puts++; throw new Error('lost response after update'); }
      throw new Error(`unexpected ${init.method} ${input}`);
    },
  });
  assert.equal(first.status, 'needs_input');
  assert.equal(task.paragraph?.stage, 'publishing');
  assert.equal(puts, 1);

  const second = await runParagraphTask(context, {
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === '/api/v1/me') return json(publication());
      if (url.pathname === `/api/v1/posts/${POST_ID}` && init.method === 'GET') { draftReads++; return json(remotePost(task, site, 'draft')); }
      if (init.method === 'PUT') puts++;
      throw new Error(`unexpected ${init.method} ${input}`);
    },
  });
  assert.equal(second.status, 'needs_input');
  assert.match(second.message, /不会再次 PUT/);
  assert.equal(posts, 1);
  assert.equal(puts, 1);
  assert.ok(draftReads >= 2);
});

test('wrong publication identity and changed content hash both fail before a write', async () => {
  const wrong = fixture();
  let wrongWrites = 0;
  const wrongResult = await runParagraphTask(wrong.context, {
    fetch: async (input, init) => {
      const url = new URL(input);
      if (init.method === 'POST' || init.method === 'PUT') wrongWrites++;
      if (url.pathname === '/api/v1/me') return json(publication({ id: OTHER_PUBLICATION_ID }));
      throw new Error(`unexpected ${input}`);
    },
  });
  assert.equal(wrongResult.status, 'needs_input');
  assert.equal(wrongWrites, 0);
  assert.equal(wrong.accounts[0].status, 'credentials_invalid');

  const changed = fixture();
  const approved = article(changed.task, changed.site);
  changed.task.paragraph = { publicationId: PUBLICATION_ID, slug: approved.slug, contentHash: approved.contentHash, stage: 'draft', postId: POST_ID };
  changed.task.draft!.body += '\n\nA later local edit changes the reviewed payload while preserving its target link and useful detail.';
  let calls = 0;
  const changedResult = await runParagraphTask(changed.context, { fetch: async () => { calls++; return json({}); } });
  assert.equal(changedResult.status, 'needs_input');
  assert.match(changedResult.message, /哈希不一致/);
  assert.equal(calls, 0);
});

test('public verification requires exact content, publication ownership, publishOnline, and target href on the anonymous page', async () => {
  for (const variant of ['valid', 'wrong-content', 'wrong-owner', 'missing-api-href', 'missing-page-href'] as const) {
    const { task, site } = fixture();
    const approved = article(task, site);
    const state: ParagraphTaskState = {
      publicationId: PUBLICATION_ID,
      slug: approved.slug,
      contentHash: approved.contentHash,
      stage: 'published',
      postId: POST_ID,
    };
    task.paragraph = state;
    task.publicUrl = `https://paragraph.com/@${PUBLICATION_SLUG}/${approved.slug}`;
    const result = await verifyParagraphPublication(task, site.url, undefined, {
      fetch: async (input, init) => {
        const url = new URL(input);
        assert.equal(init.method, 'GET');
        if (url.pathname === `/api/v1/publications/${PUBLICATION_ID}`) return json(publication());
        if (url.pathname === `/api/v1/publications/${PUBLICATION_ID}/posts/slug/${approved.slug}`) {
          return json(remotePost(task, site, 'published', {
            ...(variant === 'wrong-content' ? { markdown: `${BODY}\nchanged` } : {}),
            ...(variant === 'wrong-owner' ? { authorIds: ['OtherOwner00000000001'], authors: [{ id: 'OtherOwner00000000001', publicationId: OTHER_PUBLICATION_ID }] } : {}),
            ...(variant === 'missing-api-href' ? { staticHtml: '<p>No target link.</p>' } : {}),
          }));
        }
        if (url.origin === 'https://paragraph.com') return html(variant === 'missing-page-href' ? '<html><body>No target link.</body></html>' : publicPage());
        throw new Error(`unexpected ${input}`);
      },
    });
    assert.equal(result.found, variant === 'valid');
    assert.equal(result.outcome, variant === 'valid' ? 'found' : variant === 'missing-page-href' ? 'unreachable' : 'invalid');
    if (variant === 'valid') {
      assert.equal(result.url, task.publicUrl);
      assert.equal(result.rel, 'nofollow ugc');
    }
  }
});

test('unsupported channel shape and unapproved drafts return explicit needs-input results without network access', async () => {
  for (const item of [
    fixture({ channel: { automation: 'manual' } }),
    fixture({ channel: { contentFormat: 'social' } }),
    fixture({ task: { articleApprovedAt: undefined } }),
  ]) {
    let calls = 0;
    const result = await runParagraphTask(item.context, { fetch: async () => { calls++; return json({}); } });
    assert.equal(result.status, 'needs_input');
    assert.equal(calls, 0);
  }
});
