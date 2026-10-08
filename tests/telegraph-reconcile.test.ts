import test from 'node:test';
import assert from 'node:assert/strict';
import {
  articleToTelegraphNodes,
  reconcileTelegraphTask,
  verifyTelegraphPublication,
  type TelegraphNode,
  type TelegraphTransport,
} from '../src/integrations/telegraph';
import { defaultSettings } from '../src/main/store';
import type { Account, Channel, ExecutionContext, Site, Task } from '../src/shared/types';

const articleBody = [
  'A useful product page should answer the reader\'s real question with clear scope, concrete examples, and visible limitations. '.repeat(3),
  'Durable guidance separates stable principles from details that may change, so readers can verify current facts at the disclosed official source. '.repeat(3),
  'The article also explains tradeoffs and practical checks without invented numbers, anonymous endorsements, or repetitive promotional claims. '.repeat(3),
].join('\n\n');

const title = 'Practical guidance for a clear product page';
const author = 'Promotional content publisher';
const token = 'secret-telegraph-token-1234567890';

function channel(): Channel {
  return {
    id: 'telegraph', name: 'Telegraph', domain: 'telegra.ph', url: 'https://telegra.ph', submitUrl: 'https://api.telegra.ph/createPage',
    categories: ['content'], languages: ['*'], kind: 'article', emailRequired: false, accountRequired: true, articleRequired: true,
    free: 'yes', freeNote: 'API publication is free.', automation: 'api', quality: 'B', qualityReason: 'Relevant original article.',
    rulesUrl: 'https://telegra.ph/api', checkedAt: '2026-09-27', notes: 'Original owner-authored article only.',
    allowedHosts: ['api.telegra.ph', 'telegra.ph'], enabled: true,
  };
}

type Fixture = {
  context: ExecutionContext;
  mutations: { checkpoints: number; accountWrites: number; secretWrites: number };
};

function fixture(overrides: { task?: Partial<Task>; account?: Partial<Account>; token?: string | undefined } = {}): Fixture {
  const site: Site = {
    id: 'site', domain: 'example.com', url: 'https://example.com/', email: 'owner@example.com', name: 'Example Product',
    description: 'A useful product.', category: 'content', language: 'en', monthlyTarget: 2, status: 'ready', createdAt: '2026-09-27T00:00:00.000Z',
  };
  const task: Task = {
    id: 'task', siteId: site.id, channelId: 'telegraph', accountId: 'account', sourceDomain: 'telegra.ph', status: 'needs_input',
    createdAt: '2026-10-04T00:00:00.000Z', scheduledAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z',
    attempts: 1, message: '', draft: { title, description: 'Useful guidance', body: articleBody },
    submittedAt: '2026-10-04T01:00:00.000Z', checkpoint: 'telegraph_publish_uncertain', ...overrides.task,
  };
  const account: Account = {
    id: 'account', channelId: 'telegraph', email: 'owner@example.com', username: 'Example Product', createdAt: '2026-09-27T00:00:00.000Z',
    status: 'registered', source: 'generated', hasPassword: true, credentialKind: 'api_token', ...overrides.account,
  };
  const secrets = new Map<string, string>();
  if (overrides.token !== undefined || !Object.hasOwn(overrides, 'token')) secrets.set('account:account', overrides.token ?? token);
  const mutations = { checkpoints: 0, accountWrites: 0, secretWrites: 0 };
  const abort = new AbortController();
  const context: ExecutionContext = {
    site, channel: channel(), task, settings: defaultSettings(), signal: abort.signal,
    secrets: {
      get: async key => secrets.get(key),
      set: async () => { mutations.secretWrites++; },
      delete: async () => { mutations.secretWrites++; },
    },
    ai: { json: async <T>() => ({} as T) },
    getAccount: () => account,
    saveAccount: async () => { mutations.accountWrites++; },
    checkpoint: () => { mutations.checkpoints++; },
    log: () => undefined,
  };
  return { context, mutations };
}

function apiJson(result: unknown, ok = true): Response {
  return new Response(JSON.stringify(ok ? { ok: true, result } : { ok: false, error: result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function summary(path: string, pageTitle = title) {
  return { path, url: `https://telegra.ph/${path}`, title: pageTitle, description: 'Summary', views: 0 };
}

function detail(path: string, content: TelegraphNode[], options: { pageTitle?: string; authorName?: string } = {}) {
  return {
    ...summary(path, options.pageTitle),
    author_name: options.authorName ?? author,
    content,
    can_edit: true,
  };
}

function expectedContent(): TelegraphNode[] {
  return articleToTelegraphNodes(articleBody, 'Example Product', 'https://example.com/', 'en');
}

function priorContent(): TelegraphNode[] {
  const nodes = expectedContent();
  nodes[nodes.length - 1] = { tag: 'p', children: ['Author disclosure: Published by the owner or operator of ', 'Example Product', '. Official source: ', { tag: 'a', attrs: { href: 'https://example.com/' }, children: ['Example Product'] }, '.'] };
  return nodes;
}

test('reconciliation returns the sole full account-owned fingerprint match', async () => {
  const { context, mutations } = fixture();
  const calls: Array<{ url: string; fields: URLSearchParams }> = [];
  const transport: TelegraphTransport = async (url, init) => {
    const fields = new URLSearchParams(String(init.body));
    calls.push({ url, fields });
    if (url.endsWith('/getPageList')) return apiJson({ total_count: 2, pages: [summary('Other-10-04', 'Another title'), summary('Expected-10-04')] });
    if (url.endsWith('/getPage/Expected-10-04')) return apiJson(detail('Expected-10-04', expectedContent()));
    throw new Error(`unexpected endpoint ${url}`);
  };

  assert.deepEqual(await reconcileTelegraphTask(context, { transport }), {
    status: 'found', publicUrl: 'https://telegra.ph/Expected-10-04',
  });
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/getPageList', '/getPage/Expected-10-04']);
  assert.ok(calls.every(call => !call.url.includes(token) && call.fields.get('access_token') === token));
  assert.equal(calls[0].fields.get('offset'), '0');
  assert.equal(calls[0].fields.get('limit'), '50');
  assert.equal(calls[1].fields.get('return_content'), 'true');
  assert.deepEqual(mutations, { checkpoints: 0, accountWrites: 0, secretWrites: 0 });
});

test('reconciliation recovers a page submitted with the previous byline without writing or reposting', async () => {
  const { context, mutations } = fixture();
  const paths: string[] = [];
  const transport: TelegraphTransport = async url => {
    paths.push(new URL(url).pathname);
    if (url.endsWith('/getPageList')) return apiJson({ total_count: 1, pages: [summary('Earlier-10-04')] });
    return apiJson(detail('Earlier-10-04', priorContent(), { authorName: 'Example Product site owner' }));
  };
  assert.deepEqual(await reconcileTelegraphTask(context, { transport }), { status: 'found', publicUrl: 'https://telegra.ph/Earlier-10-04' });
  assert.deepEqual(paths, ['/getPageList', '/getPage/Earlier-10-04']);
  assert.deepEqual(mutations, { checkpoints: 0, accountWrites: 0, secretWrites: 0 });
});

test('reconciliation never mixes a previous byline with newly formatted content', async () => {
  const { context } = fixture();
  const transport: TelegraphTransport = async url => url.endsWith('/getPageList')
    ? apiJson({ total_count: 1, pages: [summary('Mixed-10-04')] })
    : apiJson(detail('Mixed-10-04', expectedContent(), { authorName: 'Example Product site owner' }));
  assert.deepEqual(await reconcileTelegraphTask(context, { transport }), { status: 'unknown' });
});

test('same title with different full content remains unknown', async () => {
  const { context } = fixture();
  const different = structuredClone(expectedContent());
  different[0] = { tag: 'p', children: ['Different article body'] };
  const transport: TelegraphTransport = async url => url.endsWith('/getPageList')
    ? apiJson({ total_count: 1, pages: [summary('Different-10-04')] })
    : apiJson(detail('Different-10-04', different));
  assert.deepEqual(await reconcileTelegraphTask(context, { transport }), { status: 'unknown' });
});

test('multiple complete fingerprint matches remain unknown', async () => {
  const { context } = fixture();
  const pages = [summary('Duplicate-A-10-04'), summary('Duplicate-B-10-04')];
  let detailCalls = 0;
  const transport: TelegraphTransport = async url => {
    if (url.endsWith('/getPageList')) return apiJson({ total_count: pages.length, pages });
    detailCalls++;
    const path = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '');
    return apiJson(detail(path, expectedContent()));
  };
  assert.deepEqual(await reconcileTelegraphTask(context, { transport }), { status: 'unknown' });
  assert.equal(detailCalls, 2);
});

test('wrong account binding and unsubmitted tasks make no request', async () => {
  for (const item of [
    fixture({ account: { id: 'different-account' } }),
    fixture({ task: { submittedAt: undefined, checkpoint: undefined } }),
    fixture({ task: { checkpoint: 'telegraph_publish_uncertain' }, token: undefined }),
  ]) {
    let calls = 0;
    const result = await reconcileTelegraphTask(item.context, { transport: async () => { calls++; return apiJson({}); } });
    assert.deepEqual(result, { status: 'unknown' });
    assert.equal(calls, 0);
    assert.deepEqual(item.mutations, { checkpoints: 0, accountWrites: 0, secretWrites: 0 });
  }
});

test('list failures and no match stay unknown without any write request or local mutation', async () => {
  for (const transport of [
    (async () => { throw new Error('network unavailable'); }) as TelegraphTransport,
    (async () => apiJson({ total_count: 1, pages: [summary('Unrelated-10-04', 'Unrelated title')] })) as TelegraphTransport,
  ]) {
    const { context, mutations } = fixture();
    const calls: string[] = [];
    const recording: TelegraphTransport = async (url, init) => { calls.push(new URL(url).pathname); return transport(url, init); };
    assert.deepEqual(await reconcileTelegraphTask(context, { transport: recording }), { status: 'unknown' });
    assert.deepEqual(calls, ['/getPageList']);
    assert.ok(calls.every(path => path.startsWith('/getPage')));
    assert.deepEqual(mutations, { checkpoints: 0, accountWrites: 0, secretWrites: 0 });
  }
});

test('page listing and detail work stay bounded and require a complete account list', async () => {
  const overLimit = fixture();
  let overLimitCalls = 0;
  const manyPages = Array.from({ length: 50 }, (_, index) => summary(`Other-${index}-10-04`, `Other ${index}`));
  assert.deepEqual(await reconcileTelegraphTask(overLimit.context, { transport: async () => {
    overLimitCalls++;
    return apiJson({ total_count: 101, pages: manyPages });
  } }), { status: 'unknown' });
  assert.equal(overLimitCalls, 1);

  const incomplete = fixture();
  const firstPage = [summary('Expected-10-04'), ...Array.from({ length: 49 }, (_, index) => summary(`First-${index}-10-04`, `First ${index}`))];
  let listCalls = 0;
  let detailCalls = 0;
  assert.deepEqual(await reconcileTelegraphTask(incomplete.context, { transport: async url => {
    if (url.endsWith('/getPageList')) {
      listCalls++;
      return listCalls === 1
        ? apiJson({ total_count: 60, pages: firstPage })
        : apiJson({ total_count: 60, pages: Array.from({ length: 9 }, (_, index) => summary(`Second-${index}-10-04`, `Second ${index}`)) });
    }
    detailCalls++;
    return apiJson(detail('Expected-10-04', expectedContent()));
  } }), { status: 'unknown' });
  assert.equal(listCalls, 2);
  assert.equal(detailCalls, 0);

  const tooManyCandidates = fixture();
  let candidateCalls = 0;
  const candidates = Array.from({ length: 9 }, (_, index) => summary(`Candidate-${index}-10-04`));
  assert.deepEqual(await reconcileTelegraphTask(tooManyCandidates.context, { transport: async () => {
    candidateCalls++;
    return apiJson({ total_count: candidates.length, pages: candidates });
  } }), { status: 'unknown' });
  assert.equal(candidateCalls, 1);
});


test('managed Telegraph verification accepts exact current and historical pairs and rejects altered visible or API content',async()=>{
  const {context,mutations}=fixture();context.task.publicUrl='https://telegra.ph/original-article-09-27';context.task.checkpoint='telegraph_published';
  const escape=(text:string)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const html=(nodes:TelegraphNode[]):string=>nodes.map(node=>typeof node==='string'?escape(node):`<${node.tag}${node.attrs?` href="${escape(node.attrs.href)}"`:''}>${html(node.children??[])}</${node.tag}>`).join('');
  for(const historical of [false,true])for(const variant of ['valid','changed-api','changed-page','mixed-author','footer-only','noindex']){
    const nodes=historical?priorContent():expectedContent(),label=historical?'Example Product site owner':author;
    const content=html(nodes),page=`<article class="tl_article_content"><h1>${title}</h1><address>${label}<time>date</time></address>${variant==='changed-page'?content.replace('Durable guidance','Altered guidance'):variant==='footer-only'?'Missing article':content}</article>${variant==='footer-only'?`<footer>${content}</footer>`:''}`;
    const result=await verifyTelegraphPublication(context,{transport:async(url,init)=>{
      assert.equal(url,'https://api.telegra.ph/getPage/original-article-09-27');assert.equal(new URLSearchParams(String(init.body)).has('access_token'),false);
      return apiJson(detail('original-article-09-27',variant==='changed-api'?[...nodes,{tag:'p',children:['changed']}]:nodes,{authorName:variant==='mixed-author'?(historical?author:'Example Product site owner'):label}));
    },publicFetch:{resolve:async()=>[{address:'8.8.8.8',family:4}],request:async()=>({status:200,headers:{'content-type':'text/html','x-robots-tag':variant==='noindex'?'noindex':''},body:Buffer.from(page)})}});
    assert.equal(result.found,variant==='valid',`${historical}/${variant}: ${result.reason}`);if(variant!=='valid')assert.equal(result.outcome,'invalid');
  }
  assert.deepEqual(mutations,{checkpoints:0,accountWrites:0,secretWrites:0});
});
