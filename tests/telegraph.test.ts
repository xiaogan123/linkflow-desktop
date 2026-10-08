import test from 'node:test';
import assert from 'node:assert/strict';
import { articleToTelegraphNodes, telegraphTesting, type TelegraphTransport } from '../src/integrations/telegraph';
import { defaultSettings } from '../src/main/store';
import type { Account, Channel, ExecutionContext, Site, Task } from '../src/shared/types';

const body = [
  'A useful product page should answer the reader\'s actual question before it asks for attention. Clear scope, concrete examples, and visible limitations help a reader decide whether a tool fits their work. '.repeat(2),
  'This section originally mentioned [an unrelated source](https://other.example/path) and <script>alert(1)</script>. The publisher should preserve the useful wording while removing executable markup and promotional link clutter. '.repeat(2),
  'A maintainable article also separates durable guidance from details that can change. Readers can then verify current product facts at the disclosed official source instead of relying on invented numbers or anonymous endorsements. '.repeat(2),
].join('\n\n');

function channel(): Channel {
  return {
    id: 'telegraph', name: 'Telegraph', domain: 'telegra.ph', url: 'https://telegra.ph', submitUrl: 'https://api.telegra.ph/createPage',
    categories: ['content'], languages: ['*'], kind: 'article', emailRequired: false, accountRequired: true, articleRequired: true,
    free: 'yes', freeNote: 'API publication is free.', automation: 'api', quality: 'B', qualityReason: 'Relevant original article.',
    rulesUrl: 'https://telegra.ph/api', checkedAt: '2026-09-27', notes: 'Original owner-authored article only.',
    allowedHosts: ['api.telegra.ph', 'telegra.ph'], enabled: true,
  };
}

function fixture(existing?: Account): { context: ExecutionContext; accounts: Account[]; secrets: Map<string, string>; checkpoints: Partial<Task>[]; abort: AbortController } {
  const site: Site = { id: 'site', domain: 'example.com', url: 'https://example.com/', email: 'owner@example.com', name: 'Example Product', description: 'A useful product.', category: 'content', language: 'en', monthlyTarget: 2, status: 'ready', createdAt: '2026-09-27T00:00:00.000Z' };
  const task: Task = { id: 'task', siteId: site.id, channelId: 'telegraph', sourceDomain: 'telegra.ph', status: 'running', createdAt: '2026-09-27T00:00:00.000Z', scheduledAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z', attempts: 1, message: '', draft: { title: 'Practical guidance for a clear product page', description: 'Useful guidance', body } };
  const accounts = existing ? [structuredClone(existing)] : [];
  const secrets = new Map<string, string>();
  if (existing?.hasPassword) secrets.set(`account:${existing.id}`, 'secret-telegraph-token-1234567890');
  const checkpoints: Partial<Task>[] = [];
  const abort = new AbortController();
  const context: ExecutionContext = {
    site, channel: channel(), task, settings: defaultSettings(), signal: abort.signal,
    secrets: { get: async key => secrets.get(key), set: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); } },
    ai: { json: async <T>() => ({} as T) },
    getAccount: () => accounts[0],
    saveAccount: async (account, credential) => {
      const saved = { ...account, hasPassword: !!credential || account.hasPassword || accounts[0]?.hasPassword || false };
      accounts[0] = saved;
      if (credential) secrets.set(`account:${account.id}`, credential);
    },
    checkpoint: partial => { checkpoints.push(structuredClone(partial)); Object.assign(task, partial); },
    log: () => undefined,
  };
  return { context, accounts, secrets, checkpoints, abort };
}

function json(result: unknown, ok = true): Response {
  return new Response(JSON.stringify(ok ? { ok: true, result } : { ok: false, error: result }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('article conversion preserves safe citations and JSON code while keeping one target source link', () => {
  const technicalBody = [
    body,
    '```json\n{\n  "enabled": true,\n  "limits": [1, 2, 3]\n}\n```',
    'The implementation follows [the external specification](https://standards.example/spec) and a raw reference https://research.example/paper. The duplicate [official link](https://example.com/docs) and https://example.com/other must not become extra target anchors. '.repeat(2),
    'A malformed [unsafe reference](javascript:alert(1)) and <img src=x onerror=alert(2)> remain non-executable text. These examples explain the security boundary without adding active content. '.repeat(2),
  ].join('\n\n');
  const nodes = articleToTelegraphNodes(technicalBody, 'Example Product', 'https://example.com/', 'en');
  const serialized = JSON.stringify(nodes);
  const pre = nodes.find(node => typeof node !== 'string' && node.tag === 'pre');
  if (!pre || typeof pre === 'string' || typeof pre.children?.[0] !== 'string') assert.fail('expected preserved fenced code');
  assert.deepEqual(JSON.parse(pre.children[0]), { enabled: true, limits: [1, 2, 3] });
  assert.equal(telegraphTesting.countTargetLinks(nodes, 'https://example.com/'), 1);
  assert.match(serialized, /https:\/\/standards\.example\/spec/);
  assert.match(serialized, /https:\/\/research\.example\/paper/);
  assert.match(serialized, /javascript:alert/);
  assert.equal(serialized.includes('"href":"javascript:'), false);
  assert.equal(serialized.includes('"href":"https://example.com/docs'), false);
  assert.equal(serialized.includes('"href":"https://example.com/other'), false);
  assert.equal(serialized.includes('<script>'), false);
  assert.equal(serialized.includes('<img'), false);
  assert.match(serialized, /Website discussed/);
  assert.doesNotMatch(serialized, /site owner|owner or operator/i);
  assert.doesNotMatch(JSON.stringify(nodes.at(-1)), /owner|operator|official source/i);
  const chinese = JSON.stringify(articleToTelegraphNodes(technicalBody, '示例产品', 'https://example.com/', 'zh'));
  assert.match(chinese, /文中所述网站/);
  assert.doesNotMatch(chinese, /所有者|运营方|官方来源/);
});

test('conversion retains the reviewed commercial disclosure while adding only a neutral site link',()=>{
  const reviewedBody=[body,'Commercial relationship disclosure: This article is promotional content for the linked website, not an independent third-party recommendation. The website participates in a referral plan that pays commissions.'].join('\n\n');
  const nodes=articleToTelegraphNodes(reviewedBody,'Example Product','https://example.com/','en');
  const serialized=JSON.stringify(nodes);
  assert.match(serialized,/The website participates in a referral plan that pays commissions/);
  assert.match(serialized,/not an independent third-party recommendation/);
  assert.equal(telegraphTesting.countTargetLinks(nodes,'https://example.com/'),1);
  assert.deepEqual(nodes.at(-1),{tag:'p',children:['Website discussed: ',{tag:'a',attrs:{href:'https://example.com/'},children:['Example Product']},'.']});
});

test('real-shaped Unicode Telegraph path is accepted as one canonical segment', () => {
  const path = '技术文章示例-09-27';
  const identity = telegraphTesting.pageIdentity({ path, url: `https://telegra.ph/${path}` });
  assert.deepEqual(identity, { path, url: new URL(`https://telegra.ph/${path}`).toString() });
  assert.equal(telegraphTesting.pageIdentity({ path: '错误/路径-09-27', url: 'https://telegra.ph/%E9%94%99%E8%AF%AF%2F%E8%B7%AF%E5%BE%84-09-27' }), undefined);
  assert.equal(telegraphTesting.pageIdentity({ path, url: `https://telegra.ph/${path}?preview=1` }), undefined);
});

test('new account token is persisted as a vault secret and never placed in a URL', async () => {
  const { context, accounts, secrets, checkpoints } = fixture();
  const token = 'new-secret-telegraph-token-1234567890';
  const calls: Array<{ url: string; params: URLSearchParams; redirect?: RequestRedirect }> = [];
  let publishedContent: unknown;
  const transport: TelegraphTransport = async (url, init) => {
    const params = new URLSearchParams(String(init.body));
    calls.push({ url, params, redirect: init.redirect });
    if (url.endsWith('/createAccount')) return json({ short_name: 'Example Product', access_token: token });
    if (url.endsWith('/createPage')) {
      publishedContent = JSON.parse(params.get('content') ?? 'null');
      return json({ path: 'Practical-guidance-09-27', url: 'https://telegra.ph/Practical-guidance-09-27', title: params.get('title') });
    }
    if (url.endsWith('/getPage/Practical-guidance-09-27')) return json({ path: 'Practical-guidance-09-27', url: 'https://telegra.ph/Practical-guidance-09-27', title: 'Practical guidance for a clear product page', content: publishedContent });
    throw new Error(`Unexpected endpoint: ${url}`);
  };

  const result = await telegraphTesting.runWithTransport(context, transport);
  assert.equal(result.status, 'review');
  assert.equal(result.publicUrl, 'https://telegra.ph/Practical-guidance-09-27');
  assert.equal(accounts[0].status, 'registered');
  assert.equal(accounts[0].credentialKind, 'api_token');
  assert.equal(secrets.get(`account:${accounts[0].id}`), token);
  assert.deepEqual(checkpoints.map(item => item.checkpoint), ['telegraph_account_create_pending', 'telegraph_account_registered', 'telegraph_publish_submitting', 'telegraph_published']);
  assert.ok(calls.every(call => call.url.startsWith('https://api.telegra.ph/')));
  assert.ok(calls.every(call => !call.url.includes(token) && call.redirect === 'error'));
  assert.equal(calls.find(call => call.url.endsWith('/createPage'))?.params.get('access_token'), token);
  assert.equal(calls.find(call => call.url.endsWith('/createAccount'))?.params.has('access_token'), false);
  assert.equal(calls.find(call => call.url.endsWith('/createAccount'))?.params.get('author_name'), 'Promotional content publisher');
  assert.equal(calls.find(call => call.url.endsWith('/createPage'))?.params.get('author_name'), 'Promotional content publisher');
  assert.doesNotMatch(JSON.stringify(publishedContent), /site owner|owner or operator|所有者|运营方/i);
  assert.equal(telegraphTesting.countTargetLinks(publishedContent, 'https://example.com/'), 1);
});

test('registered account is verified and reused without creating a replacement token', async () => {
  const account: Account = { id: 'account', channelId: 'telegraph', email: 'owner@example.com', username: 'Example', createdAt: '2026-09-27T00:00:00.000Z', status: 'registered', source: 'generated', hasPassword: true, credentialKind: 'api_token' };
  const { context } = fixture(account);
  const endpoints: string[] = [];
  let content: unknown;
  const transport: TelegraphTransport = async (url, init) => {
    endpoints.push(url);
    const params = new URLSearchParams(String(init.body));
    if (url.endsWith('/getAccountInfo')) return json({ short_name: 'Example', page_count: 2 });
    if (url.endsWith('/createPage')) { content = JSON.parse(params.get('content') ?? 'null'); return json({ path: 'Reused-account-09-27', url: 'https://telegra.ph/Reused-account-09-27' }); }
    if (url.endsWith('/getPage/Reused-account-09-27')) return json({ path: 'Reused-account-09-27', url: 'https://telegra.ph/Reused-account-09-27', content });
    throw new Error('unexpected endpoint');
  };
  const result = await telegraphTesting.runWithTransport(context, transport);
  assert.equal(result.status, 'review');
  assert.deepEqual(endpoints.map(url => new URL(url).pathname), ['/getAccountInfo', '/createPage', '/getPage/Reused-account-09-27']);
  assert.equal(endpoints.some(url => url.endsWith('/createAccount')), false);
});

test('crash after encrypted token save recovers the registered account without creating another token', async () => {
  const account: Account = { id: 'account', channelId: 'telegraph', email: 'owner@example.com', username: 'Example', createdAt: '2026-09-27T00:00:00.000Z', status: 'registered', source: 'generated', hasPassword: true, credentialKind: 'api_token' };
  const { context } = fixture(account);
  context.task.checkpoint = 'telegraph_account_create_pending';
  const endpoints: string[] = [];
  let content: unknown;
  const transport: TelegraphTransport = async (url, init) => {
    endpoints.push(url);
    const params = new URLSearchParams(String(init.body));
    if (url.endsWith('/getAccountInfo')) return json({ short_name: 'Example', page_count: 0 });
    if (url.endsWith('/createPage')) { content = JSON.parse(params.get('content') ?? 'null'); return json({ path: 'Recovered-account-09-27', url: 'https://telegra.ph/Recovered-account-09-27' }); }
    if (url.endsWith('/getPage/Recovered-account-09-27')) return json({ path: 'Recovered-account-09-27', url: 'https://telegra.ph/Recovered-account-09-27', content });
    throw new Error('unexpected endpoint');
  };
  assert.equal((await telegraphTesting.runWithTransport(context, transport)).status, 'review');
  assert.equal(endpoints.some(url => url.endsWith('/createAccount')), false);
});

test('uncertain account registration is durably blocked and does not request a second token', async () => {
  const { context, accounts } = fixture();
  let calls = 0;
  const transport: TelegraphTransport = async () => { calls++; throw new Error('connection reset after send'); };
  const first = await telegraphTesting.runWithTransport(context, transport);
  const second = await telegraphTesting.runWithTransport(context, transport);
  assert.equal(first.status, 'needs_input');
  assert.equal(first.checkpoint, 'account_registration_submitted');
  assert.equal(second.status, 'needs_input');
  assert.equal(calls, 1);
  assert.equal(accounts[0].status, 'unknown');
  assert.equal(accounts[0].hasPassword, false);
  assert.match(second.message, /不会自动创建新令牌/);
});

test('account-level pending state blocks a different task after interruption before registration call', async () => {
  const { context, accounts } = fixture();
  let calls = 0;
  const transport: TelegraphTransport = async () => { calls++; return json({}); };
  context.checkpoint = partial => {
    if (partial.checkpoint === 'telegraph_account_create_pending') throw new Error('paused before remote call');
  };
  await assert.rejects(telegraphTesting.runWithTransport(context, transport), /paused before remote call/);
  assert.equal(calls, 0);
  assert.equal(accounts[0].status, 'unknown');
  assert.equal(accounts[0].registrationAttempts, 1);
  assert.equal(accounts[0].diagnostic?.code, 'registration_unknown');

  context.task = { ...context.task, id: 'second-task', checkpoint: undefined };
  context.checkpoint = partial => Object.assign(context.task, partial);
  const second = await telegraphTesting.runWithTransport(context, transport);
  assert.equal(second.status, 'needs_input');
  assert.equal(calls, 0);
  assert.match(second.message, /不会自动创建替代账号/);
});

test('aborted checkpoint after token persistence keeps the confirmed registered account', async () => {
  const { context, accounts, secrets, abort } = fixture();
  const token = 'confirmed-secret-telegraph-token-123456';
  const checkpoints: string[] = [];
  context.checkpoint = partial => {
    if (partial.checkpoint === 'telegraph_account_registered') {
      abort.abort();
      throw new Error('paused after token persistence');
    }
    checkpoints.push(partial.checkpoint ?? '');
    Object.assign(context.task, partial);
  };
  const result = await telegraphTesting.runWithTransport(context, async url => {
    assert.equal(url.endsWith('/createAccount'), true);
    return json({ short_name: 'Example Product', access_token: token });
  });
  assert.equal(result.status, 'queued');
  assert.deepEqual(checkpoints, ['telegraph_account_create_pending']);
  assert.equal(accounts[0].status, 'registered');
  assert.equal(accounts[0].diagnostic, undefined);
  assert.equal(secrets.get(`account:${accounts[0].id}`), token);
});

test('uncertain publication is checkpointed before the call and never duplicated', async () => {
  const account: Account = { id: 'account', channelId: 'telegraph', email: 'owner@example.com', username: 'Example', createdAt: '2026-09-27T00:00:00.000Z', status: 'registered', source: 'generated', hasPassword: true, credentialKind: 'api_token' };
  const { context, checkpoints } = fixture(account);
  let createCalls = 0;
  const transport: TelegraphTransport = async url => {
    if (url.endsWith('/getAccountInfo')) return json({ short_name: 'Example', page_count: 0 });
    if (url.endsWith('/createPage')) { createCalls++; throw new Error('timeout after send'); }
    throw new Error('unexpected endpoint');
  };
  const first = await telegraphTesting.runWithTransport(context, transport);
  const second = await telegraphTesting.runWithTransport(context, transport);
  assert.equal(first.checkpoint, 'telegraph_publish_uncertain');
  assert.equal(second.status, 'review');
  assert.equal(createCalls, 1);
  assert.ok(checkpoints.some(item => item.checkpoint === 'telegraph_publish_submitting' && typeof item.submittedAt === 'string'));
  assert.match(second.message, /不会重复发文/);
});

test('invalid stored token changes account state and cannot cause automatic replacement registration', async () => {
  const account: Account = { id: 'account', channelId: 'telegraph', email: 'owner@example.com', username: 'Example', createdAt: '2026-09-27T00:00:00.000Z', status: 'registered', source: 'generated', hasPassword: true, credentialKind: 'api_token' };
  const { context, accounts } = fixture(account);
  const endpoints: string[] = [];
  const transport: TelegraphTransport = async url => { endpoints.push(url); return json('ACCESS_TOKEN_INVALID', false); };
  const first = await telegraphTesting.runWithTransport(context, transport);
  const second = await telegraphTesting.runWithTransport(context, transport);
  assert.equal(first.status, 'needs_input');
  assert.equal(second.status, 'needs_input');
  assert.equal(accounts[0].status, 'credentials_invalid');
  assert.deepEqual(endpoints.map(url => new URL(url).pathname), ['/getAccountInfo']);
});

test('short article and existing public result stop before any remote call', async () => {
  const short = fixture();
  short.context.task.draft!.body = 'Too short.';
  let calls = 0;
  const transport: TelegraphTransport = async () => { calls++; return json({}); };
  assert.equal((await telegraphTesting.runWithTransport(short.context, transport)).status, 'needs_input');
  const existing = fixture();
  existing.context.task.publicUrl = 'https://telegra.ph/Existing-09-27';
  assert.equal((await telegraphTesting.runWithTransport(existing.context, transport)).status, 'review');
  assert.equal(calls, 0);
});
