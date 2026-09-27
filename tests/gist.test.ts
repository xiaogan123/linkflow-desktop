import test from 'node:test';
import assert from 'node:assert/strict';
import { gistTesting, readPublicGist, runGistTask, validateGistToken, type GistTransport } from '../src/integrations/gist';
import { defaultSettings } from '../src/main/store';
import type { Account, Channel, ExecutionContext, Site, Task } from '../src/shared/types';

const TOKEN = 'github_pat_synthetic_secret_1234567890';
const GIST_ID = 'a1b2c3d4e5f67890';
const BODY = [
  'This note explains how to evaluate a product page using verifiable scope, concrete examples, and explicit limitations. It focuses on repeatable checks that a reader can perform before deciding whether the product fits a real workflow.',
  'A useful review separates durable behavior from details that may change. Readers should compare the stated inputs, outputs, and failure modes, then consult the [official product page](https://example.com/) for the current source information.',
  'The final check records assumptions and unresolved constraints. This makes the note useful to future readers because they can reproduce the reasoning instead of relying on promotional claims or anonymous endorsements.',
].join('\n\n');

function channel(): Channel {
  return {
    id: 'github-gist', name: 'GitHub Gist', domain: 'gist.github.com', url: 'https://gist.github.com', submitUrl: 'https://api.github.com/gists',
    categories: ['content'], languages: ['*'], kind: 'article', emailRequired: false, accountRequired: true, articleRequired: true,
    free: 'yes', freeNote: 'Public Gists are free.', automation: 'api', quality: 'B', qualityReason: 'Useful public technical note.',
    rulesUrl: 'https://docs.github.com/en/rest/gists/gists', checkedAt: '2026-09-28', notes: 'Existing GitHub identity and approved draft only.',
    allowedHosts: ['api.github.com', 'gist.github.com'], enabled: true,
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'github-account', channelId: 'github-gist', email: 'octocat@users.noreply.github.com', username: 'octocat',
    createdAt: '2026-09-28T00:00:00.000Z', status: 'registered', hasPassword: true, credentialKind: 'api_token', source: 'imported',
    ...overrides,
  };
}

function fixture(existing: Account | null = account()): {
  context: ExecutionContext;
  accounts: Account[];
  secrets: Map<string, string>;
  checkpoints: Partial<Task>[];
} {
  const site: Site = {
    id: 'site', domain: 'example.com', url: 'https://example.com/', email: 'owner@example.com', name: 'Example Product',
    description: 'A useful product.', category: 'content', language: 'en', monthlyTarget: 2, status: 'ready', createdAt: '2026-09-28T00:00:00.000Z',
  };
  const task: Task = {
    id: 'task', siteId: site.id, channelId: 'github-gist', sourceDomain: 'gist.github.com', status: 'running',
    createdAt: '2026-09-28T00:00:00.000Z', scheduledAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z', attempts: 1, message: '',
    articleApprovedAt: '2026-09-28T00:30:00.000Z',
    draft: { title: 'A reproducible product-page review', description: 'Practical checks for evaluating product information.', body: BODY },
  };
  const accounts = existing ? [structuredClone(existing)] : [];
  const secrets = new Map<string, string>();
  if (existing?.hasPassword) secrets.set(`account:${existing.id}`, TOKEN);
  const checkpoints: Partial<Task>[] = [];
  const context: ExecutionContext = {
    site, channel: channel(), task, settings: defaultSettings(), signal: new AbortController().signal,
    secrets: { get: async key => secrets.get(key), set: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); } },
    ai: { json: async <T>() => ({} as T) },
    getAccount: () => accounts[0],
    saveAccount: async updated => { accounts[0] = structuredClone(updated); },
    checkpoint: partial => { checkpoints.push(structuredClone(partial)); Object.assign(task, partial); },
    log: () => undefined,
  };
  return { context, accounts, secrets, checkpoints };
}

function json(value: unknown, status = 200, responseUrl?: string): Response {
  const response = new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  if (responseUrl) Object.defineProperty(response, 'url', { configurable: true, value: responseUrl });
  return response;
}

function expectedReadme(context: ExecutionContext): string {
  const draft = context.task.draft!;
  return `# ${draft.title}\n\n${draft.description}\n\n${draft.body}`;
}

function gist(context: ExecutionContext, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const login = String(overrides.login ?? 'octocat');
  const id = String(overrides.id ?? GIST_ID);
  const content = String(overrides.content ?? expectedReadme(context));
  return {
    id, public: true, html_url: `https://gist.github.com/${login}/${id}`,
    owner: { login },
    files: { 'README.md': { filename: 'README.md', truncated: false, content } },
    created_at: '2026-09-28T01:02:03Z',
    ...overrides,
  };
}

test('validateGistToken returns the authenticated login with fixed, non-redirecting API request', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: GistTransport = async (url, init) => {
    calls.push({ url, init });
    return json({ login: 'octocat' });
  };
  assert.equal(await validateGistToken(TOKEN, undefined, { fetch }), 'octocat');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/user');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].url.includes(TOKEN), false);
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
});

test('successful creation posts the exact approved draft once, checkpoints first, and returns review', async () => {
  const { context, checkpoints } = fixture();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: GistTransport = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/user')) return json({ login: 'octocat' });
    if (url.endsWith('/gists') && init.method === 'POST') return json(gist(context), 201);
    if (url.endsWith(`/gists/${GIST_ID}`)) return json(gist(context));
    throw new Error('unexpected endpoint');
  };
  const result = await runGistTask(context, { fetch, now: () => '2026-09-28T01:00:00Z' });
  assert.equal(result.status, 'review');
  assert.equal(result.publicUrl, `https://gist.github.com/octocat/${GIST_ID}`);
  assert.deepEqual(checkpoints.map(item => item.checkpoint), ['submitting', 'gist_published']);
  const post = calls.find(call => call.url.endsWith('/gists') && call.init.method === 'POST');
  assert.ok(post);
  const payload = JSON.parse(String(post.init.body));
  assert.equal(payload.public, true);
  assert.equal(payload.description, context.task.draft!.description);
  assert.equal(payload.files['README.md'].content, expectedReadme(context));
  assert.equal(payload.files['README.md'].content.endsWith(context.task.draft!.body), true);
  assert.ok(calls.every(call => call.url.startsWith('https://api.github.com/')));
  assert.ok(calls.every(call => call.init.redirect === 'error' && !call.url.includes(TOKEN)));
});

test('missing accounts and missing vault tokens need input without creating identities or Gists', async () => {
  let calls = 0;
  const none = fixture(null);
  assert.equal((await runGistTask(none.context, { fetch: async () => { calls++; return json({}); } })).status, 'needs_input');
  const missing = fixture();
  missing.secrets.clear();
  const result = await runGistTask(missing.context, { fetch: async () => { calls++; return json({}); } });
  assert.equal(result.status, 'needs_input');
  assert.equal(missing.accounts[0].status, 'credentials_invalid');
  assert.equal(calls, 0);
});

test('invalid authentication is diagnosed without leaking the token or remote error body', async () => {
  const { context, accounts } = fixture();
  const remote = `bad credentials ${TOKEN}`;
  const result = await runGistTask(context, { fetch: async () => json({ message: remote }, 401) });
  assert.equal(result.status, 'needs_input');
  assert.equal(accounts[0].status, 'credentials_invalid');
  assert.equal(accounts[0].diagnostic?.code, 'bad_password');
  assert.equal(result.message.includes(TOKEN), false);
  assert.equal(accounts[0].diagnostic?.message.includes(TOKEN), false);
  await assert.rejects(validateGistToken(TOKEN, undefined, { fetch: async () => json({ message: remote }, 401) }), error => {
    assert.equal(String(error).includes(TOKEN), false);
    assert.equal(String(error).includes(remote), false);
    return true;
  });
});

test('redirected and host-tampered responses are rejected before their data is trusted', async () => {
  const redirected = json({ login: 'octocat' });
  Object.defineProperty(redirected, 'redirected', { configurable: true, value: true });
  await assert.rejects(validateGistToken(TOKEN, undefined, { fetch: async () => redirected }), /request failed/);
  await assert.rejects(validateGistToken(TOKEN, undefined, {
    fetch: async () => json({ login: 'octocat' }, 200, 'https://evil.example/user'),
  }), /request failed/);
});

test('private, wrong-owner, or content-tampered saved results are never treated as submitted', async () => {
  for (const bad of [
    { public: false },
    { login: 'mallory', owner: { login: 'mallory' }, html_url: `https://gist.github.com/mallory/${GIST_ID}` },
    { content: 'different content', files: { 'README.md': { filename: 'README.md', truncated: false, content: 'different content' } } },
  ]) {
    const { context } = fixture();
    context.task.publicUrl = `https://gist.github.com/octocat/${GIST_ID}`;
    const fetch: GistTransport = async url => url.endsWith('/user') ? json({ login: 'octocat' }) : json(gist(context, bad));
    const result = await runGistTask(context, { fetch });
    assert.equal(result.status, 'needs_input');
    assert.equal(result.publicUrl, context.task.publicUrl);
  }
});

test('uncertain POST remains submitting and a retry never creates a duplicate', async () => {
  const { context, checkpoints } = fixture();
  let postCalls = 0;
  const fetch: GistTransport = async (url, init) => {
    if (url.endsWith('/user')) return json({ login: 'octocat' });
    if (init.method === 'POST') { postCalls++; throw new Error(`socket closed ${TOKEN}`); }
    throw new Error('unexpected endpoint');
  };
  const first = await runGistTask(context, { fetch, now: () => '2026-09-28T01:00:00Z' });
  const second = await runGistTask(context, { fetch });
  assert.equal(first.status, 'needs_input');
  assert.equal(first.checkpoint, 'submitting');
  assert.equal(second.checkpoint, 'submitting');
  assert.equal(postCalls, 1);
  assert.equal(checkpoints[0].checkpoint, 'submitting');
  assert.equal(checkpoints[0].submittedAt, '2026-09-28T01:00:00.000Z');
  assert.equal(first.message.includes(TOKEN), false);
});

test('POST 500 remains submitting and the next run cannot create a duplicate', async () => {
  const { context } = fixture();
  let postCalls = 0;
  const fetch: GistTransport = async (url, init) => {
    if (url.endsWith('/user')) return json({ login: 'octocat' });
    if (init.method === 'POST') {
      postCalls++;
      return json({ message: `internal failure ${TOKEN}` }, 500);
    }
    throw new Error('unexpected endpoint');
  };
  const first = await runGistTask(context, { fetch, now: () => '2026-09-28T01:00:00Z' });
  const second = await runGistTask(context, { fetch });
  assert.equal(first.status, 'needs_input');
  assert.equal(first.checkpoint, 'submitting');
  assert.equal(first.submittedAt, '2026-09-28T01:00:00.000Z');
  assert.equal(first.message.includes(TOKEN), false);
  assert.equal(second.checkpoint, 'submitting');
  assert.equal(postCalls, 1);
});

test('concurrent runs share the durable submitting guard and issue only one POST', async () => {
  const { context } = fixture();
  let postCalls = 0;
  let releasePost!: () => void;
  const postGate = new Promise<void>(resolve => { releasePost = resolve; });
  const fetch: GistTransport = async (url, init) => {
    if (url.endsWith('/user')) return json({ login: 'octocat' });
    if (url.endsWith('/gists') && init.method === 'POST') {
      postCalls++;
      await postGate;
      return json(gist(context), 201);
    }
    if (url.endsWith(`/gists/${GIST_ID}`)) return json(gist(context));
    throw new Error('unexpected endpoint');
  };
  const first = runGistTask(context, { fetch });
  await new Promise(resolve => setImmediate(resolve));
  const second = await runGistTask(context, { fetch });
  releasePost();
  const completed = await first;
  assert.equal(postCalls, 1);
  assert.equal(second.status, 'needs_input');
  assert.equal(second.checkpoint, 'submitting');
  assert.equal(completed.status, 'review');
});

test('draft validation requires one exact target Markdown link and useful non-ad content without rewriting', () => {
  const { context } = fixture();
  context.task.checkpoint = 'article_review';
  const approved = gistTesting.approvedReadme(context);
  assert.equal(approved.content, expectedReadme(context));
  context.task.articleApprovedAt = undefined;
  assert.throws(() => gistTesting.approvedReadme(context), /批准/);
  context.task.articleApprovedAt = '2026-09-28T00:30:00.000Z';
  context.task.draft!.body = BODY.replace('[official product page](https://example.com/)', 'https://example.com/');
  assert.throws(() => gistTesting.approvedReadme(context), /Markdown/);
  context.task.draft!.body = `${BODY}\n\n[duplicate](https://example.com/)`;
  assert.throws(() => gistTesting.approvedReadme(context), /Markdown/);
  context.task.draft!.body = BODY;
  context.task.draft!.description += ' [duplicate](https://example.com/)';
  assert.throws(() => gistTesting.approvedReadme(context), /Markdown/);
  context.task.draft!.description = 'Practical checks for evaluating product information.';
  context.task.draft!.body = '[Buy now](https://example.com/)\n\nLimited time offer. Click here and sign up now.';
  assert.throws(() => gistTesting.approvedReadme(context), /实际信息/);
});

test('readPublicGist performs anonymous fixed-host adoption and enforces canonical owner URL', async () => {
  const { context } = fixture();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await readPublicGist(`https://gist.github.com/octocat/${GIST_ID}`, {
    fetch: async (url, init) => { calls.push({ url, init }); return json(gist(context)); },
  });
  assert.deepEqual(result, { url: `https://gist.github.com/octocat/${GIST_ID}`, login: 'octocat', createdAt: '2026-09-28T01:02:03.000Z' });
  assert.equal(calls[0].url, `https://api.github.com/gists/${GIST_ID}`);
  assert.equal('authorization' in (calls[0].init.headers as Record<string, string>), false);
  const ownerlessApiShape = gist(context, { html_url: `https://gist.github.com/${GIST_ID}` });
  assert.equal((await readPublicGist(`https://gist.github.com/octocat/${GIST_ID}`, { fetch: async () => json(ownerlessApiShape) })).url, `https://gist.github.com/octocat/${GIST_ID}`);
  await assert.rejects(readPublicGist(`https://github.com/octocat/${GIST_ID}`, { fetch: async () => assert.fail('must not fetch') }), /request failed/);
  await assert.rejects(readPublicGist(`https://gist.github.com/octocat/${GIST_ID}`, {
    fetch: async () => json(gist(context, { login: 'mallory', owner: { login: 'mallory' }, html_url: `https://gist.github.com/mallory/${GIST_ID}` })),
  }), /request failed/);
});
