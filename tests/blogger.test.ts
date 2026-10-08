import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOGGER_SCOPE,
  authorizeBlogger,
  bloggerTesting,
  createBloggerLoopback,
  getBloggerBlogs,
  parseBloggerDesktopClient,
  reconcileBloggerTask,
  runBloggerTask,
  verifyBloggerPublication,
  type BloggerLoopback,
  type BloggerTransport,
} from '../src/integrations/blogger';
import { defaultSettings } from '../src/main/store';
import type { Account, Channel, ExecutionContext, Site, Task } from '../src/shared/types';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const BLOG_ID = '1234567890123456789';
const USER_ID = '9876543210987654321';
const POST_ID = '2222222222222222222';
const ACCESS_TOKEN = 'synthetic-access-token-that-is-not-real';
const REFRESH_TOKEN = 'synthetic-refresh-token-that-is-not-real';
const NOW = new Date('2026-10-04T12:00:00.000Z');
const BLOG_URL = 'https://example-owner.blogspot.com/';
const POST_URL = `${BLOG_URL}2026/10/useful-review.html`;
const BODY = [
  'This independent article explains how to assess a product using reproducible checks, explicit limitations, and source-backed observations. The publisher is Example Brand, which has a commercial relationship with the linked site.',
  'Readers should compare documented inputs, failure behavior, and operational constraints before deciding whether the product fits their workflow. Promotional claims are separated from verifiable facts so the method remains useful.',
  'The final section records what could not be verified and tells readers to consult the current official material. This disclosure and the named brand author must remain visible in the published article.',
].join('\n\n');

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function channel(): Channel {
  return {
    id: 'blogger', name: 'Blogger', domain: 'blogspot.com', url: 'https://www.blogger.com/', submitUrl: 'https://www.blogger.com/',
    categories: ['content'], languages: ['*'], kind: 'article', emailRequired: false, accountRequired: true, articleRequired: true,
    free: 'yes', freeNote: 'Existing Blogger account.', automation: 'api', quality: 'C', qualityReason: 'Owned publication.',
    rulesUrl: 'https://www.blogger.com/content-policy', checkedAt: '2026-10-04', notes: 'Approved original article.',
    allowedHosts: ['blogger.com', 'blogspot.com'], enabled: true, provenance: 'built-in',
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: ACCOUNT_ID, channelId: 'blogger', email: '', displayName: 'Example Publisher', username: USER_ID,
    createdAt: NOW.toISOString(), status: 'registered', hasPassword: true, credentialKind: 'oauth', source: 'imported',
    ...overrides,
  };
}

function credential(accessToken = ACCESS_TOKEN, expiresAt = '2026-10-04T13:00:00.000Z') {
  return JSON.stringify({
    version: 1, clientId: 'synthetic.apps.googleusercontent.com', clientSecret: 'synthetic-client-secret',
    refreshToken: REFRESH_TOKEN, accessToken, expiresAt, scope: BLOGGER_SCOPE, userId: USER_ID,
  });
}

function fixture(taskOverrides: Partial<Task> = {}, accountOverrides: Partial<Account> = {}) {
  const site: Site = {
    id: 'site', domain: 'example.com', url: 'https://example.com/', email: 'owner@example.com', name: 'Example Brand',
    description: 'A useful product.', category: 'content', language: 'en', monthlyTarget: 2, status: 'ready', createdAt: NOW.toISOString(),
    blogger: { blogId: BLOG_ID, url: BLOG_URL },
  };
  const task: Task = {
    id: 'task', siteId: site.id, channelId: 'blogger', accountId: ACCOUNT_ID, sourceDomain: 'example-owner.blogspot.com', status: 'running',
    createdAt: NOW.toISOString(), scheduledAt: NOW.toISOString(), updatedAt: NOW.toISOString(), attempts: 1, message: '',
    articleApprovedAt: NOW.toISOString(), draft: { title: 'A reproducible product review', description: 'Practical checks and clear limitations.', body: BODY },
    ...taskOverrides,
  };
  const accounts = [account(accountOverrides)];
  const secrets = new Map([[`account:${ACCOUNT_ID}`, credential()]]);
  const checkpoints: Partial<Task>[] = [];
  const taskSnapshot = structuredClone(task);
  const context: ExecutionContext = {
    site, channel: channel(), task: taskSnapshot, settings: defaultSettings(), signal: new AbortController().signal,
    secrets: {
      get: async key => secrets.get(key),
      set: async (key, value) => { secrets.set(key, value); },
      delete: async key => { secrets.delete(key); },
    },
    ai: { json: async <T>() => ({} as T) },
    getAccount: () => accounts[0],
    saveAccount: async updated => { accounts[0] = structuredClone(updated); },
    // Controller passes a task snapshot into ExecutionContext; checkpoints
    // update the persisted task, not that snapshot.
    checkpoint: partial => { checkpoints.push(structuredClone(partial)); Object.assign(task, structuredClone(partial)); },
    log: () => undefined,
  };
  const syncContext = () => { context.task = structuredClone(task); };
  const setTask = (partial: Partial<Task>) => { Object.assign(task, structuredClone(partial)); syncContext(); };
  return { context, task, site, accounts, secrets, checkpoints, syncContext, setTask };
}

function user() {
  return { kind: 'blogger#user', id: USER_ID, displayName: 'Example Publisher' };
}

function blogUserInfo() {
  return {
    kind: 'blogger#blogUserInfo',
    blog: { kind: 'blogger#blog', id: BLOG_ID, name: 'Example Owner Blog', url: BLOG_URL },
    blog_user_info: { kind: 'blogger#blogPerUserInfo', userId: USER_ID, blogId: BLOG_ID, hasAdminAccess: true },
  };
}

function post(content: string, status: 'DRAFT' | 'LIVE' | 'SCHEDULED', id = POST_ID) {
  return {
    kind: 'blogger#post', id, blog: { id: BLOG_ID }, status,
    title: 'A reproducible product review', content,
    ...(status === 'LIVE' ? { url: POST_URL } : {}),
  };
}

function baseApi(handler: (url: URL, init: RequestInit) => Promise<Response>): BloggerTransport {
  return async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/blogger/v3/users/self') return json(user());
    if (url.pathname === `/blogger/v3/users/self/blogs/${BLOG_ID}`) return json(blogUserInfo());
    return handler(url, init);
  };
}

test('desktop client parser accepts installed clients and rejects web or substituted endpoints', () => {
  const client = parseBloggerDesktopClient(JSON.stringify({ installed: {
    client_id: 'client.apps.googleusercontent.com', client_secret: 'secret',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token',
    redirect_uris: ['http://localhost'],
  } }));
  assert.deepEqual(client, { clientId: 'client.apps.googleusercontent.com', clientSecret: 'secret' });
  assert.throws(() => parseBloggerDesktopClient({ web: { client_id: 'client.apps.googleusercontent.com' } }), /Desktop app/);
  assert.throws(() => parseBloggerDesktopClient({ installed: {
    client_id: 'client.apps.googleusercontent.com', token_uri: 'https://attacker.example/token', redirect_uris: ['http://localhost'],
  } }), /非官方/);
});

test('blog metadata accepts the HTTP publication URL format documented by the official v3 examples', async () => {
  const blogs = await getBloggerBlogs(ACCESS_TOKEN, { request: async input => {
    const url = new URL(input);
    assert.equal(url.pathname, '/blogger/v3/users/self/blogs');
    return json({ kind: 'blogger#blogList', items: [
      { kind: 'blogger#blog', id: BLOG_ID, name: 'Legacy URL Blog', url: 'http://example-owner.blogspot.com/' },
    ] });
  } });
  assert.deepEqual(blogs, [{ id: BLOG_ID, name: 'Legacy URL Blog', url: 'http://example-owner.blogspot.com/' }]);
});

test('installed OAuth uses fixed HTTPS endpoints, PKCE/state, loopback and never places tokens in URLs', async () => {
  let opened = '';
  let closed = 0;
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const loopback: BloggerLoopback = {
    redirectUri: 'http://127.0.0.1:43123',
    wait: async () => {
      const authorization = new URL(opened);
      return new URL(`http://127.0.0.1:43123/?code=synthetic-code&state=${encodeURIComponent(authorization.searchParams.get('state')!)}`);
    },
    close: async () => { closed++; },
  };
  const result = await authorizeBlogger(
    parseBloggerDesktopClient({ installed: { client_id: 'client.apps.googleusercontent.com', client_secret: 'secret', redirect_uris: ['http://localhost'] } }),
    async url => { opened = url; },
    {
      now: () => NOW,
      createLoopback: async () => loopback,
      request: async (input, init) => {
        const url = new URL(input); calls.push({ url, init });
        if (url.toString() === 'https://oauth2.googleapis.com/token') {
          const form = new URLSearchParams(String(init.body));
          assert.equal(form.get('grant_type'), 'authorization_code');
          assert.ok((form.get('code_verifier')?.length ?? 0) >= 43);
          return json({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600, token_type: 'Bearer', scope: BLOGGER_SCOPE });
        }
        if (url.pathname === '/blogger/v3/users/self') return json(user());
        if (url.pathname === '/blogger/v3/users/self/blogs') return json({ kind: 'blogger#blogList', items: [{ kind: 'blogger#blog', id: BLOG_ID, name: 'Example Owner Blog', url: BLOG_URL }] });
        throw new Error('unexpected request');
      },
    },
  );
  const authorization = new URL(opened);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.pathname, '/o/oauth2/v2/auth');
  assert.equal(authorization.searchParams.get('redirect_uri'), 'http://127.0.0.1:43123/');
  assert.equal(authorization.searchParams.get('scope'), BLOGGER_SCOPE);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorization.searchParams.get('state'));
  assert.equal(opened.includes(ACCESS_TOKEN), false);
  assert.equal(calls.some(call => call.url.toString().includes(ACCESS_TOKEN) || call.url.toString().includes(REFRESH_TOKEN)), false);
  assert.equal(result.identity.id, USER_ID);
  assert.equal(result.blogs[0].id, BLOG_ID);
  assert.equal(closed, 1);
});

test('real loopback binds an ephemeral 127.0.0.1 port and closes on cancellation', async () => {
  const abort = new AbortController();
  const loopback = await createBloggerLoopback({ signal: abort.signal, timeoutMs: 5_000 });
  const redirect = new URL(loopback.redirectUri);
  assert.equal(redirect.hostname, '127.0.0.1');
  assert.ok(Number(redirect.port) > 0);
  abort.abort();
  await assert.rejects(loopback.wait(), /cancelled/);
  await loopback.close();
});

test('publisher checkpoints before each POST, inserts a draft once, publishes the same post, and emits escaped nofollow HTML', async () => {
  const { context, checkpoints } = fixture();
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  let insertedContent = '';
  const request = baseApi(async (url, init) => {
    calls.push({ url, init });
    if (url.pathname === `/blogger/v3/blogs/${BLOG_ID}/posts` && init.method === 'POST') {
      const payload = JSON.parse(String(init.body));
      insertedContent = payload.content;
      return json(post(insertedContent, 'DRAFT'), 200);
    }
    if (url.pathname === `/blogger/v3/blogs/${BLOG_ID}/posts/${POST_ID}/publish` && init.method === 'POST') {
      assert.equal(init.body, undefined);
      return json(post(insertedContent, 'LIVE'));
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  });
  const result = await runBloggerTask(context, { request, now: () => NOW, uuid: () => '33333333-3333-4333-8333-333333333333' });
  assert.equal(result.status, 'review');
  assert.equal(result.publicUrl, POST_URL);
  assert.deepEqual(checkpoints.map(item => item.blogger?.stage).filter(Boolean), ['inserting', 'draft', 'publishing', 'published']);
  assert.deepEqual(checkpoints.map(item => item.checkpoint), ['blogger_insert_submitting', 'blogger_draft_created', 'blogger_publish_submitting', 'blogger_published']);
  assert.match(insertedContent, /data-linkflow-operation="33333333-3333-4333-8333-333333333333"/);
  assert.match(insertedContent, /<strong>Author:<\/strong> Example Brand/);
  assert.match(insertedContent, /<a href="https:\/\/example\.com\/" rel="nofollow">Example Brand<\/a>/);
  assert.equal(insertedContent.includes('<script>'), false);
  assert.equal((calls.find(call => call.init.method === 'POST')?.init.headers as Record<string, string>).authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.ok(calls.every(call => !call.url.toString().includes(ACCESS_TOKEN)));
});

test('lost publish response preserves the same-post publishing checkpoint under the Controller snapshot contract', async () => {
  const { context, task } = fixture();
  let insertedContent = '';
  const request = baseApi(async (url, init) => {
    if (url.pathname === `/blogger/v3/blogs/${BLOG_ID}/posts` && init.method === 'POST') {
      insertedContent = JSON.parse(String(init.body)).content;
      return json(post(insertedContent, 'DRAFT'));
    }
    if (url.pathname === `/blogger/v3/blogs/${BLOG_ID}/posts/${POST_ID}/publish` && init.method === 'POST') {
      throw new Error('connection lost after publish');
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  });
  const result = await runBloggerTask(context, { request, now: () => NOW, uuid: () => '34343434-3434-4343-8343-343434343434' });
  Object.assign(task, result); // Match Controller.patch({...result}) after checkpoints persisted separately.
  assert.equal(result.status, 'needs_input');
  assert.equal(Object.hasOwn(result, 'checkpoint'), false);
  assert.equal(Object.hasOwn(result, 'submittedAt'), false);
  assert.equal(task.checkpoint, 'blogger_publish_submitting');
  assert.equal(task.submittedAt, NOW.toISOString());
  assert.deepEqual(task.blogger, {
    blogId: BLOG_ID, postId: POST_ID, operationId: '34343434-3434-4343-8343-343434343434',
    contentHash: bloggerTesting.approvedArticle(context).contentHash, stage: 'publishing',
  });
});

test('HTML conversion escapes draft markup while keeping disclosure and brand attribution visible', () => {
  const { context } = fixture();
  context.task.draft!.body = `${BODY}\n\n<script>alert('x')</script> & commercial disclosure remains visible.`;
  const article = bloggerTesting.approvedArticle(context);
  const content = article.content('44444444-4444-4444-8444-444444444444');
  assert.equal(content.includes('<script>'), false);
  assert.match(content, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt; &amp; commercial disclosure/);
  assert.match(content, /Example Brand/);
});

test('a remote Blogger checkpoint without idempotency state never authorizes a new insert', async () => {
  const { context } = fixture({ checkpoint: 'blogger_insert_submitting' });
  let requests = 0;
  const result = await runBloggerTask(context, { request: async () => { requests++; throw new Error('must not request'); }, now: () => NOW });
  assert.equal(result.status, 'needs_input');
  assert.match(result.message, /缺少幂等记录/);
  assert.equal(requests, 0);
});

test('lost insert response preserves the pre-POST checkpoint and is never followed by a second insert', async () => {
  const { context, task, syncContext } = fixture();
  let insertCalls = 0;
  const first = baseApi(async (url, init) => {
    if (url.pathname === `/blogger/v3/blogs/${BLOG_ID}/posts` && init.method === 'POST') {
      insertCalls++;
      throw new Error('connection lost after upload');
    }
    throw new Error('unexpected');
  });
  const initial = await runBloggerTask(context, { request: first, now: () => NOW, uuid: () => '55555555-5555-4555-8555-555555555555' });
  Object.assign(task, initial); // The Controller merges ExecutionResult after the persisted checkpoint.
  assert.equal(initial.status, 'needs_input');
  assert.equal(Object.hasOwn(initial, 'checkpoint'), false);
  assert.equal(Object.hasOwn(initial, 'submittedAt'), false);
  assert.equal(task.checkpoint, 'blogger_insert_submitting');
  assert.equal(task.submittedAt, NOW.toISOString());
  assert.equal(task.blogger?.stage, 'inserting');
  assert.equal(task.blogger?.postId, undefined);

  const second = baseApi(async (url, init) => {
    if (url.pathname === `/blogger/v3/blogs/${BLOG_ID}/posts` && init.method === 'GET') return json({ kind: 'blogger#postList', items: [] });
    if (init.method === 'POST') insertCalls++;
    throw new Error(`unexpected ${init.method} ${url}`);
  });
  syncContext();
  const recovered = await runBloggerTask(context, { request: second, now: () => NOW });
  assert.equal(recovered.status, 'needs_input');
  assert.match(recovered.message, /不会再次插入/);
  assert.equal(insertCalls, 1);
});

test('lost insert response recovers only one exact full-body marker match and publishes that postId', async () => {
  const { context, task, syncContext } = fixture();
  let expectedContent = '';
  const first = baseApi(async (url, init) => {
    if (url.pathname === `/blogger/v3/blogs/${BLOG_ID}/posts` && init.method === 'POST') {
      expectedContent = JSON.parse(String(init.body)).content;
      throw new Error('connection lost');
    }
    throw new Error('unexpected');
  });
  await runBloggerTask(context, { request: first, now: () => NOW, uuid: () => '66666666-6666-4666-8666-666666666666' });
  assert.equal(task.blogger?.stage, 'inserting');
  syncContext();
  let publishCalls = 0;
  const recovery = baseApi(async (url, init) => {
    if (url.pathname === `/blogger/v3/blogs/${BLOG_ID}/posts` && init.method === 'GET') {
      const status = url.searchParams.get('status');
      return json({ kind: 'blogger#postList', items: status === 'DRAFT' ? [post(expectedContent, 'DRAFT')] : [] });
    }
    if (url.pathname === `/blogger/v3/blogs/${BLOG_ID}/posts/${POST_ID}/publish`) {
      publishCalls++;
      return json(post(expectedContent, 'LIVE'));
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  });
  const result = await runBloggerTask(context, { request: recovery, now: () => NOW });
  assert.equal(result.publicUrl, POST_URL);
  assert.equal(task.blogger?.postId, POST_ID);
  assert.equal(task.blogger?.stage, 'published');
  assert.equal(publishCalls, 1);
});

test('same title or multiple exact matches never authorize recovery or another POST', async () => {
  const { context, setTask } = fixture();
  const article = bloggerTesting.approvedArticle(context);
  const operationId = '77777777-7777-4777-8777-777777777777';
  setTask({ submittedAt: NOW.toISOString(), blogger: { blogId: BLOG_ID, operationId, contentHash: article.contentHash, stage: 'inserting' } });
  let posts = 0;
  const request = baseApi(async (url, init) => {
    if (url.pathname === `/blogger/v3/blogs/${BLOG_ID}/posts` && init.method === 'GET') {
      if (url.searchParams.get('status') === 'DRAFT') return json({ kind: 'blogger#postList', items: [
        post(article.content(operationId), 'DRAFT', POST_ID),
        post(article.content(operationId), 'DRAFT', '3333333333333333333'),
        { ...post('different body', 'DRAFT', '4444444444444444444'), title: context.task.draft!.title },
      ] });
      return json({ kind: 'blogger#postList', items: [] });
    }
    if (init.method === 'POST') posts++;
    throw new Error('unexpected');
  });
  const result = await runBloggerTask(context, { request, now: () => NOW });
  assert.equal(result.status, 'needs_input');
  assert.equal(posts, 0);
});

test('read-only reconciliation performs bounded GETs and can recover a live exact match', async () => {
  const { context, setTask } = fixture();
  const article = bloggerTesting.approvedArticle(context);
  const operationId = '88888888-8888-4888-8888-888888888888';
  setTask({ submittedAt: NOW.toISOString(), blogger: { blogId: BLOG_ID, operationId, contentHash: article.contentHash, stage: 'inserting' } });
  const calls: Array<{ url: URL; method: string }> = [];
  const request = baseApi(async (url, init) => {
    calls.push({ url, method: String(init.method) });
    assert.equal(init.method, 'GET');
    if (url.pathname === `/blogger/v3/blogs/${BLOG_ID}/posts`) {
      return json({ kind: 'blogger#postList', items: url.searchParams.get('status') === 'LIVE' ? [post(article.content(operationId), 'LIVE')] : [] });
    }
    throw new Error('unexpected');
  });
  const result = await reconcileBloggerTask(context, { request, now: () => NOW });
  assert.deepEqual(result, { status: 'found', publicUrl: POST_URL,
    blogger:{blogId:BLOG_ID,postId:POST_ID,operationId,contentHash:article.contentHash,stage:'published'} });
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/posts')).length, 3);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('Blogger live reconciliation returns the confirmed original post ID and rejects a substituted ID',async()=>{
  const f=fixture(),article=bloggerTesting.approvedArticle(f.context),operationId='11111111-1111-4111-8111-111111111111';
  f.setTask({submittedAt:NOW.toISOString(),articleApprovedAt:undefined,blogger:{blogId:BLOG_ID,postId:POST_ID,operationId,contentHash:article.contentHash,stage:'publishing'}});
  for(const id of [POST_ID,'9999999999']){
    const result=await reconcileBloggerTask(f.context,{now:()=>NOW,request:baseApi(async(url,init)=>{
      assert.equal(init.method,'GET');assert.equal(url.pathname,`/blogger/v3/blogs/${BLOG_ID}/posts/${POST_ID}`);
      return json(post(article.content(operationId),'LIVE',id));
    })});
    assert.deepEqual(result,id===POST_ID?{status:'found',publicUrl:POST_URL,blogger:{...f.task.blogger,stage:'published'}}:{status:'unknown'});
  }
  assert.equal(f.checkpoints.length,0);assert.equal(f.task.blogger?.stage,'publishing');
});

test('read-only reconciliation returns the original operation as a claimed draft without checkpointing or publishing', async () => {
  const { context, checkpoints, setTask } = fixture();
  const article = bloggerTesting.approvedArticle(context);
  const operationId = '89898989-8989-4898-8989-898989898989';
  setTask({ submittedAt: NOW.toISOString(), articleApprovedAt: undefined, articleReview: undefined,
    blogger: { blogId: BLOG_ID, postId: POST_ID, operationId, contentHash: article.contentHash, stage: 'draft' } });
  const methods: string[] = [];
  const request = baseApi(async (url, init) => {
    methods.push(String(init.method));
    assert.equal(init.method, 'GET');
    if (url.pathname === `/blogger/v3/blogs/${BLOG_ID}/posts/${POST_ID}`) return json(post(article.content(operationId), 'DRAFT'));
    throw new Error(`unexpected ${init.method} ${url}`);
  });
  const result = await reconcileBloggerTask(context, { request, now: () => NOW });
  assert.deepEqual(result, {
    status: 'draft',
    blogger: { blogId: BLOG_ID, postId: POST_ID, operationId, contentHash: article.contentHash, stage: 'draft' },
  });
  assert.deepEqual(checkpoints, []);
  assert.ok(methods.every(method => method === 'GET'));
});

test('draft reconciliation fails closed when full content no longer matches', async () => {
  const { context, setTask } = fixture();
  const article = bloggerTesting.approvedArticle(context);
  const operationId = '90909090-9090-4090-8090-909090909090';
  setTask({ submittedAt: NOW.toISOString(), blogger: { blogId: BLOG_ID, postId: POST_ID, operationId, contentHash: article.contentHash, stage: 'draft' } });
  const request = baseApi(async (url, init) => {
    assert.equal(init.method, 'GET');
    if (url.pathname === `/blogger/v3/blogs/${BLOG_ID}/posts/${POST_ID}`) return json(post(`${article.content(operationId)} changed`, 'DRAFT'));
    throw new Error(`unexpected ${init.method} ${url}`);
  });
  assert.deepEqual(await reconcileBloggerTask(context, { request, now: () => NOW }), { status: 'unknown' });
});

test('expired access token refreshes through the fixed token endpoint and never leaks the refresh token in a URL', async () => {
  const { context, secrets } = fixture();
  secrets.set(`account:${ACCOUNT_ID}`, credential('expired-access-token', '2026-10-04T11:00:00.000Z'));
  const urls: string[] = [];
  let content = '';
  const request: BloggerTransport = async (input, init) => {
    urls.push(input);
    const url = new URL(input);
    if (url.toString() === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get('refresh_token'), REFRESH_TOKEN);
      return json({ access_token: ACCESS_TOKEN, expires_in: 3600, token_type: 'Bearer', scope: BLOGGER_SCOPE });
    }
    if ((init.headers as Record<string, string>).authorization !== `Bearer ${ACCESS_TOKEN}`) throw new Error('wrong access token');
    if (url.pathname === '/blogger/v3/users/self') return json(user());
    if (url.pathname === `/blogger/v3/users/self/blogs/${BLOG_ID}`) return json(blogUserInfo());
    if (url.pathname.endsWith('/posts') && init.method === 'POST') { content = JSON.parse(String(init.body)).content; return json(post(content, 'DRAFT')); }
    if (url.pathname.endsWith('/publish')) return json(post(content, 'LIVE'));
    throw new Error('unexpected');
  };
  const result = await runBloggerTask(context, { request, now: () => NOW, uuid: () => '99999999-9999-4999-8999-999999999999' });
  assert.equal(result.status, 'review');
  assert.ok(urls.every(url => !url.includes(REFRESH_TOKEN) && !url.includes(ACCESS_TOKEN)));
  const saved = JSON.parse(secrets.get(`account:${ACCOUNT_ID}`)!);
  assert.equal(saved.accessToken, ACCESS_TOKEN);
  assert.equal(saved.refreshToken, REFRESH_TOKEN);
});

test('403 and 429 are classified without exposing remote bodies or credentials', async () => {
  const forbidden = fixture();
  const denied = await runBloggerTask(forbidden.context, { request: async () => json({ error: `leak ${REFRESH_TOKEN}` }, 403), now: () => NOW });
  assert.equal(denied.status, 'needs_input');
  assert.equal(forbidden.accounts[0].status, 'restricted');
  assert.equal(denied.message.includes(REFRESH_TOKEN), false);

  const limited = fixture();
  const throttled = await runBloggerTask(limited.context, { request: async () => json({ error: `leak ${ACCESS_TOKEN}` }, 429), now: () => NOW });
  assert.equal(throttled.status, 'failed');
  assert.match(throttled.message, /速率限制/);
  assert.equal(throttled.message.includes(ACCESS_TOKEN), false);
});


test('Blogger public verification binds the persisted operation and exact emitted body without an OAuth write',async()=>{
  const f=fixture(),article=bloggerTesting.approvedArticle(f.context),operationId='11111111-1111-4111-8111-111111111111';
  f.setTask({publicUrl:POST_URL,submittedAt:NOW.toISOString(),articleApprovedAt:undefined,blogger:{blogId:BLOG_ID,postId:POST_ID,operationId,contentHash:article.contentHash,stage:'published'}});
  const content=article.content(operationId),page=`<article><h3 class="post-title">${article.title}</h3><div class="post-body">${content}</div></article>`;
  const original=structuredClone(f.task);
  for(const variant of ['valid','changed-text','wrong-marker','footer-only','noindex','wrong-title','wrong-link']){
    const result=await verifyBloggerPublication(f.context,{request:async()=>{throw Error('verification must not use credentials or token refresh');},publicFetch:{resolve:async()=>[{address:'8.8.8.8',family:4}],request:async()=>({status:200,headers:{'content-type':'text/html','x-robots-tag':variant==='noindex'?'noindex':''},body:Buffer.from(
      variant==='changed-text'?page.replace('Practical checks','Mutated checks'):variant==='wrong-marker'?page.replace(operationId,'22222222-2222-4222-8222-222222222222'):variant==='footer-only'?`<h3 class="post-title">${article.title}</h3><footer><a href="https://example.com/">brand</a></footer>`:variant==='wrong-title'?page.replace(`<h3 class="post-title">${article.title}</h3>`,'<h3 class="post-title">Different title</h3>'):variant==='wrong-link'?page.replace('href="https://example.com/"','href="https://example.com/other"'):page
    )})}});
    assert.equal(result.found,variant==='valid',variant);if(variant!=='valid')assert.equal(result.outcome,'invalid');
  }
  assert.deepEqual(f.task,original);assert.equal(f.checkpoints.length,0);
});

test('Blogger title must belong uniquely to the publication containing the original operation',async()=>{
  const f=fixture(),article=bloggerTesting.approvedArticle(f.context),operationId='11111111-1111-4111-8111-111111111111';
  f.setTask({publicUrl:POST_URL,submittedAt:NOW.toISOString(),articleApprovedAt:undefined,blogger:{blogId:BLOG_ID,postId:POST_ID,operationId,contentHash:article.contentHash,stage:'published'}});
  const heading=`<h3 class="post-title">${article.title}</h3>`,content=`<div class="post-body">${article.content(operationId)}</div>`;
  const changed='<h3 class="post-title">Changed article title</h3>';
  const cases:[string,string,boolean][]=[
    ['article title',`<article>${heading}${content}</article>`,true],
    ['classic post container',`<div class="post hentry"><header>${heading}</header>${content}</div>`,true],
    ['detached sidebar title',`<aside>${heading}</aside><article>${changed}${content}</article>`,false],
    ['sidebar inside same article',`<article><aside>${heading}</aside>${changed}${content}</article>`,false],
    ['other publication title',`<article>${heading}</article><article>${changed}${content}</article>`,false],
    ['nested other publication title',`<article><section class="post">${heading}</section>${changed}${content}</article>`,false],
    ['body title substitute',`<article><div class="post-body">${heading}</div>${changed}${content}</article>`,false],
    ['ambiguous publication headings',`<article>${heading}${changed}${content}</article>`,false],
  ];
  const before=structuredClone(f.task);
  for(const [name,html,found] of cases){
    const result=await verifyBloggerPublication(f.context,{publicFetch:{resolve:async()=>[{address:'8.8.8.8',family:4}],request:async()=>({status:200,headers:{'content-type':'text/html'},body:Buffer.from(html)})}});
    assert.equal(result.found,found,name);if(!found)assert.equal(result.outcome,'invalid');
  }
  assert.deepEqual(f.task,before);assert.equal(f.checkpoints.length,0);
});
