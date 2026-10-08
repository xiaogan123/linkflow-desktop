import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { CHANNELS } from '../src/integrations/catalog';
import { defaultSettings } from '../src/main/store';
import { prepareVerboseIdentity, runVerboseTask, reconcileVerboseTask, verifyVerbosePublication, verboseTesting, type VerboseTransport } from '../src/integrations/verbose';
import type { Account, ExecutionContext, Task, Site } from '../src/shared/types';

const NOW = '2026-10-08T02:00:00.000Z';
const USER = 'example-notes';
const TOKEN = 'vb_live_' + 'synthetic0123456789'.repeat(3);
const TARGET = 'https://example.com/research';
const BODY = `A useful reading record separates an observation from an interpretation. Write down the page title, the exact source address and the date you consulted it. Keep the original units next to every number so that a later comparison does not silently change its meaning. The [research notes](${TARGET}) are a related reference, rather than independent validation of these steps.\n\nBefore drawing a conclusion, compare the source passage with the summary and mark anything still uncertain. This article is AI-assisted promotional writing, and the linked site may receive referral commissions. Those commercial links do not establish the accuracy of any financial claim or guarantee any outcome.`;
const TITLE = 'Keeping a useful source record';
function fixture(empty = false) {
  const site: Site = { id: 'site', domain: 'example.com', url: 'https://example.com/', email: 'author@example.com', name: 'Example Notes',
    description: 'Learning notes', category: 'education', language: 'en', monthlyTarget: 2, status: 'ready', createdAt: NOW };
  const task: Task = { id: 'task-verbose', siteId: site.id, channelId: 'verbose', sourceDomain: 'verbose.blog', status: 'running',
    createdAt: NOW, updatedAt: NOW, scheduledAt: NOW, attempts: 1, message: '', topicUrl: TARGET,
    draft: { title: TITLE, description: 'Source tracking', body: BODY }, articleApprovedAt: NOW,
    accountId: empty ? undefined : 'account' };
  let account: Account | undefined = empty ? undefined : { id: 'account', channelId: 'verbose', username: USER, email: '',
    publicationUrl: `https://verbose.blog/${USER}`, credentialKind: 'api_token', status: 'registered', hasPassword: true,
    source: 'generated', registrationAttempts: 1, createdAt: NOW };
  const secrets = new Map<string, string>();
  if (account) secrets.set('account:account', JSON.stringify({ version: 1, username: USER, token: TOKEN }));
  let failingCheckpoint = '', failingSecret = false;
  const checkpoints: Partial<Task>[] = [];
  const signal = new AbortController();
  const context: ExecutionContext = { site, task, channel: { ...CHANNELS.find(item => item.id === 'verbose')!, enabled: true },
    settings: defaultSettings(), signal: signal.signal, ai: { json: async <T>() => ({} as T) },
    secrets: { get: async key => secrets.get(key), set: async (key, value) => { if (failingSecret) throw Error('unavailable'); secrets.set(key, value); }, delete: async key => { secrets.delete(key); } },
    getAccount: () => account, saveAccount: async (value, secret) => { if (secret && failingSecret) throw Error('unavailable'); account = structuredClone(value); task.accountId = value.id; if (secret) secrets.set(`account:${value.id}`, secret); },
    checkpoint: partial => { if (partial.checkpoint === failingCheckpoint) throw Error('save failed'); checkpoints.push(structuredClone(partial)); Object.assign(task, partial); }, log: () => {},
  };
  return { context, task, site, secrets, checkpoints, signal, account: () => account,
    failCheckpoint: (name: string) => { failingCheckpoint = name; }, failSecret: () => { failingSecret = true; } };
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function html(body = BODY, title = TITLE, extra = '') {
  const rendered = String(marked.parse(body, { async: false })).replaceAll('<a ', '<a rel="nofollow ugc" ');
  return `<html><head>${extra}</head><body><p class="meta"><a href="/${USER}">${USER}</a> · 2026-10-08</p><h1>${title}</h1>${rendered}<p class="post-footer">Published on verbose.blog</p></body></html>`;
}
function server(f: ReturnType<typeof fixture>, options: { lostCreate?: boolean; lostPublish?: boolean; conflict?: boolean; badPage?: string; failRead?: boolean; signupOnly?: boolean } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  let published = false;
  const fetch: VerboseTransport = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://verbose.blog/v0/profiles' && init.method === 'POST') {
      assert.equal(f.account()?.registrationAttempts, 1); assert.equal(f.account()?.status, 'unknown');
      assert.equal(f.task.checkpoint, 'verbose_account_create_pending');
      if (options.lostCreate) throw Error('lost response');
      const username = JSON.parse(String(init.body)).username;
      return json({ username, token: TOKEN }, 201);
    }
    const user = f.account()!.username;
    if (url === `https://verbose.blog/v0/profiles/${user}`) {
      if (options.failRead) throw Error('network');
      return json({ username: user });
    }
    const expected = verboseTesting.article(f.task, f.site.url, false);
    const pageUrl = `https://verbose.blog/${user}/${expected.slug}`;
    if (url === `https://verbose.blog/v0/profiles/${user}/posts` && init.method === 'POST') {
      assert.equal(f.task.checkpoint, 'verbose_publish_submitting'); assert.ok(f.task.verbose); assert.ok(f.task.submittedAt);
      assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
      assert.equal(init.redirect, 'manual');
      assert.deepEqual(JSON.parse(String(init.body)), { title: TITLE, body: BODY, slug: expected.slug });
      published = true;
      if (options.lostPublish) throw Error('response lost');
      if (options.conflict) return json({ code: 'SLUG_TAKEN' }, 409);
      return json({ username: user, slug: expected.slug, title: TITLE, url: pageUrl }, 201);
    }
    assert.equal((init.headers as Record<string, string>).authorization, undefined);
    if (url === `https://verbose.blog/v0/profiles/${user}/posts/${expected.slug}`) {
      if (options.failRead || !published) return json({ error: 'not found' }, 404);
      return json({ username: user, slug: expected.slug, title: TITLE, body_markdown: BODY, created_at: '2026-10-08 02:00:00', url: pageUrl });
    }
    if (url === pageUrl) return new Response(options.badPage ?? html(), { headers: { 'content-type': 'text/html' } });
    throw Error('unexpected request');
  };
  return { fetch, calls, markPublished: () => { published = true; }, writes: () => calls.filter(call => call.init.method === 'POST') };
}
test('Verbose creates one encrypted identity before any writing and reuses it', async () => {
  const f = fixture(true), s = server(f);
  assert.equal(await prepareVerboseIdentity(f.context, { fetch: s.fetch }), undefined);
  assert.equal(f.account()?.status, 'registered'); assert.equal(f.account()?.registrationAttempts, 1);
  assert.match(f.secrets.get(`account:${f.account()!.id}`)!, /vb_live_/);
  await prepareVerboseIdentity(f.context, { fetch: s.fetch }); assert.equal(s.writes().length, 1);
});
test('lost signup response preserves identity and never retries with a replacement', async () => {
  const f = fixture(true), s = server(f, { lostCreate: true });
  assert.equal((await prepareVerboseIdentity(f.context, { fetch: s.fetch }))?.status, 'needs_input');
  const id = f.account()!.id;
  await prepareVerboseIdentity(f.context, { fetch: s.fetch });
  assert.equal(f.account()!.id, id); assert.equal(s.writes().length, 1); assert.equal(f.account()!.registrationAttempts, 1);
});
test('token persistence failure never reports ready or repeats signup', async () => {
  const f = fixture(true), s = server(f); f.failSecret();
  await prepareVerboseIdentity(f.context, { fetch: s.fetch });
  await prepareVerboseIdentity(f.context, { fetch: s.fetch });
  assert.equal(f.account()!.status, 'unknown'); assert.equal(s.writes().length, 1);
});
test('unpersisted signup intent prevents all registration writes', async () => {
  const f = fixture(true), s = server(f); f.failCheckpoint('verbose_account_create_pending');
  assert.equal((await prepareVerboseIdentity(f.context, { fetch: s.fetch }))?.status, 'queued'); assert.equal(s.writes().length, 0);
});
test('saved token and account presence flag remain consistent when profile read fails', async () => {
  const f=fixture(true),s=server(f,{failRead:true});
  assert.equal((await prepareVerboseIdentity(f.context,{fetch:s.fetch}))?.status,'queued');
  assert.equal(f.account()!.hasPassword,true);assert.ok(f.secrets.get(`account:${f.account()!.id}`));
  await prepareVerboseIdentity(f.context,{fetch:s.fetch});assert.equal(s.writes().length,1);
});
test('a reviewed Markdown heading remains part of the public article',()=>{
  const f=fixture();f.task.draft!.body='# Reading notes\n\n'+BODY;
  const expected=verboseTesting.article(f.task,TARGET);
  assert.equal(verboseTesting.rendered(html(f.task.draft!.body),expected,USER),'nofollow ugc');
});
test('Verbose publishes the reviewed text once and anonymously verifies the entire article', async () => {
  const f = fixture(), s = server(f);
  const result = await runVerboseTask(f.context, { fetch: s.fetch }); Object.assign(f.task, result);
  assert.equal(result.checkpoint, 'verbose_published'); assert.equal(result.verbose?.stage, 'published');
  const verification = await verifyVerbosePublication(f.task, TARGET, { fetch: s.fetch });
  assert.equal(verification.found, true); assert.equal(verification.rel, 'nofollow ugc');
  assert.equal((await runVerboseTask(f.context, { fetch: s.fetch })).checkpoint, 'verbose_published'); assert.equal(s.writes().length, 1);
});
test('lost publish response reconciles the fixed slug without a second POST', async () => {
  const f = fixture(), s = server(f, { lostPublish: true });
  const result = await runVerboseTask(f.context, { fetch: s.fetch }); assert.equal(result.verbose?.stage, 'published');
  Object.assign(f.task, result); await runVerboseTask(f.context, { fetch: s.fetch }); assert.equal(s.writes().length, 1);
});
test('409 resolves only the exact original article; never chooses another slug', async () => {
  const f = fixture(), s = server(f, { conflict: true });
  const result = await runVerboseTask(f.context, { fetch: s.fetch }); assert.equal(result.verbose?.stage, 'published'); assert.equal(s.writes().length, 1);
});
test('publication waits when complete anonymous HTML is missing', async () => {
  const f = fixture(), s = server(f, { badPage: html('Truncated content') });
  const result = await runVerboseTask(f.context, { fetch: s.fetch }); assert.equal(result.verbose?.stage, 'submitting'); assert.equal(result.publicUrl, undefined);
  Object.assign(f.task, result); await runVerboseTask(f.context, { fetch: s.fetch }); assert.equal(s.writes().length, 1);
});
test('hidden content, altered titles, altered links and footer-only matches fail verification', () => {
  const f = fixture(), expected = verboseTesting.article(f.task, TARGET);
  for (const bad of [html(BODY, 'Other title'), html(BODY.replace(TARGET, 'https://other.example/')),
    html().replace('<body>', '<body hidden>'), html(BODY, TITLE, '<style>body > p:not(.meta) {display:none}</style>'),
    html('Short content').replace('Published on verbose.blog', String(marked.parse(BODY)))]) {
    assert.equal(verboseTesting.rendered(bad, expected, USER), undefined);
  }
});
test('changed draft and wrong account cannot reconcile an old receipt', async () => {
  const f = fixture(), s = server(f);
  Object.assign(f.task, await runVerboseTask(f.context, { fetch: s.fetch }));
  f.task.draft!.title = 'Changed';
  assert.equal((await reconcileVerboseTask(f.context, { fetch: s.fetch })).status, 'unknown'); assert.equal(s.writes().length, 1);
});
test('missing approval, raw HTML, oversize body and missing link produce no requests', async () => {
  for (const mutate of [(task: Task) => { delete task.articleApprovedAt; }, (task: Task) => { task.draft!.body += '<b>hidden</b>'; },
    (task: Task) => { task.draft!.body += 'a'.repeat(50_000); }, (task: Task) => { task.draft!.body = BODY.replace(TARGET, 'https://elsewhere.example/'); }]) {
    const f = fixture(), s = server(f); mutate(f.task);
    assert.equal((await runVerboseTask(f.context, { fetch: s.fetch })).status, 'needs_input'); assert.equal(s.calls.length, 0);
  }
});
test('unpersisted publish intent and missing original identity never issue POST', async () => {
  const f = fixture(), s = server(f); f.failCheckpoint('verbose_publish_submitting');
  assert.equal((await runVerboseTask(f.context, { fetch: s.fetch })).status, 'queued'); assert.equal(s.writes().length, 0);
  const g = fixture(true), t = server(g); g.task.accountId = 'missing-original';
  assert.equal((await prepareVerboseIdentity(g.context, { fetch: t.fetch }))?.status, 'needs_input'); assert.equal(t.writes().length, 0);
});
test('manual redirects do not leak tokens to another host or mark an account ready', async () => {
  const f = fixture(true); let calls = 0;
  const result = await prepareVerboseIdentity(f.context, { fetch: async (_url, init) => {
    calls++; assert.equal(init.redirect, 'manual'); return new Response('', { status: 302, headers: { location: 'https://other.example/' } });
  } });
  assert.equal(result?.status, 'needs_input'); assert.equal(calls, 1); assert.equal(f.account()!.status, 'unknown');
});
test('pre-cancellation prevents all network writes and registers no alternative identity', async () => {
  const f = fixture(true), s = server(f); f.signal.abort();
  await prepareVerboseIdentity(f.context, { fetch: s.fetch }); assert.equal(s.calls.length, 0); assert.equal(f.account(), undefined);
});

test('Verbose respects HTTP and HTML indexing policy and keeps original receipt on read-only failure', async () => {
  const f=fixture(),s=server(f);Object.assign(f.task,await runVerboseTask(f.context,{fetch:s.fetch}));
  const original=structuredClone(f.task.verbose);
  for(const directive of ['noindex','none','googlebot:noindex']){
    const fetch:VerboseTransport=async(url,init)=>{
      const response=await s.fetch(url,init);
      if(url===f.task.publicUrl)response.headers.set('x-robots-tag',directive);
      return response;
    };
    assert.equal((await verifyVerbosePublication(f.task,TARGET,{fetch})).outcome,'invalid');
    assert.equal((await reconcileVerboseTask(f.context,{fetch})).status,'unknown');
    assert.deepEqual(f.task.verbose,original);assert.equal(s.writes().length,1);
  }
  const expected=verboseTesting.article(f.task,TARGET,false);
  assert.equal(verboseTesting.rendered(html(BODY,TITLE,'<meta name="robots" content="none">'),expected,USER),undefined);
  assert.equal(verboseTesting.rendered(html(BODY,TITLE,'<link rel="canonical" href="https://verbose.blog/other/post">'),expected,USER),undefined);
  assert.match(verboseTesting.rendered(html().replaceAll('rel="nofollow ugc"',''),expected,USER,new Headers({'x-robots-tag':'nofollow'}))!,/nofollow/);
});
