import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getNetlifyAccountIdentity,
  getNetlifyAccessibleProject,
  listNetlifyAccessibleProjects,
  NetlifyAccountError,
  type NetlifyAccountDependencies,
  type NetlifyAccountTransport,
} from '../src/integrations/netlify-account';

const TOKEN = 'synthetic-netlify-account-token';
const USER_ID = 'fixture-user';

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function site(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    account_id: 'fixture-team',
    ssl_url: `https://${id}.netlify.app/`,
    prevent_non_git_prod_deploys: false,
    password: 'must-not-leak',
    session_id: 'private-session',
    notification_email: 'private@example.test',
    default_hooks_data: { access_token: 'private-hook-token' },
    build_settings: { env: { SECRET: 'private-build-secret' } },
    ...overrides,
  };
}

async function rejectsCode(promise: Promise<unknown>, code: NetlifyAccountError['code']): Promise<void> {
  await assert.rejects(promise, error => error instanceof NetlifyAccountError && error.code === code);
}

test('identity and bounded pagination send Bearer only to fixed API URLs and project sensitive fields are cropped', async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const request: NetlifyAccountTransport = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname === '/api/v1/user') return json({ id: USER_ID, email: 'private@example.test', full_name: 'Private Person' });
    const page = Number(url.searchParams.get('page'));
    if (page === 1) return json([site('project-one'), site('project-two')], 200, {
      link: '<https://api.netlify.com/api/v1/sites?filter=all&page=2&per_page=2>; rel="next"',
    });
    if (page === 2) return json([site('project-three')]);
    throw new Error('unexpected request');
  };
  const options: NetlifyAccountDependencies = { request, pageSize: 2, maxPages: 3 };
  assert.deepEqual(await getNetlifyAccountIdentity(TOKEN, USER_ID, options), { id: USER_ID });
  const projects = await listNetlifyAccessibleProjects(TOKEN, options);
  assert.equal(projects.length, 3);
  assert.deepEqual(projects[0], {
    id: 'project-one', name: 'project-one', teamId: 'fixture-team', publicUrl: 'https://project-one.netlify.app/',
    readAccess: 'confirmed', deployPermission: 'unknown', publicVisibility: 'unverified', nonGitProductionBlocked: false,
  });
  assert.equal(JSON.stringify(projects).includes('private'), false);
  assert.deepEqual(calls.map(call => call.url.toString()), [
    'https://api.netlify.com/api/v1/user',
    'https://api.netlify.com/api/v1/sites?filter=all&page=1&per_page=2',
    'https://api.netlify.com/api/v1/sites?filter=all&page=2&per_page=2',
  ]);
  for (const call of calls) {
    assert.equal(new Headers(call.init.headers).get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.url.toString().includes(TOKEN), false);
  }
});

test('ticket user identity mismatch is rejected with a fixed error', async () => {
  const operation = getNetlifyAccountIdentity(TOKEN, USER_ID, {
    request: async () => json({ id: 'different-user', email: TOKEN }),
  });
  await rejectsCode(operation, 'identity_mismatch');
  await assert.rejects(operation, error => !String(error).includes(TOKEN));
});

test('project detail binds the selected site, team, and API-provided netlify.app HTTPS URL', async () => {
  const project = await getNetlifyAccessibleProject(TOKEN, 'project-one', {
    request: async input => {
      assert.equal(input, 'https://api.netlify.com/api/v1/sites/project-one');
      return json(site('project-one', { prevent_non_git_prod_deploys: true }));
    },
  });
  assert.equal(project.id, 'project-one');
  assert.equal(project.teamId, 'fixture-team');
  assert.equal(project.nonGitProductionBlocked, true);

  for (const body of [
    site('other-project'),
    site('project-one', { account_id: undefined }),
    site('project-one', { ssl_url: 'https://custom.example.test/' }),
    site('project-one', { ssl_url: 'http://project-one.netlify.app/' }),
  ]) {
    await rejectsCode(getNetlifyAccessibleProject(TOKEN, 'project-one', { request: async () => json(body) }), 'invalid_response');
  }
});

test('cross-origin pagination is rejected and Bearer is never sent off-origin', async () => {
  const hosts: string[] = [];
  await rejectsCode(listNetlifyAccessibleProjects(TOKEN, {
    pageSize: 1,
    request: async input => {
      const url = new URL(input);
      hosts.push(url.host);
      return json([site('project-one')], 200, {
        link: '<https://attacker.example/api/v1/sites?page=2&per_page=1>; rel="next"',
      });
    },
  }), 'invalid_response');
  assert.deepEqual(hosts, ['api.netlify.com']);
});

test('full or repeated pagination cannot be reported as a complete list after the cap', async () => {
  let calls = 0;
  await rejectsCode(listNetlifyAccessibleProjects(TOKEN, {
    pageSize: 1,
    maxPages: 2,
    request: async () => { calls++; return json([site(`project-${calls}`)]); },
  }), 'limit');
  assert.equal(calls, 2);

  calls = 0;
  await rejectsCode(listNetlifyAccessibleProjects(TOKEN, {
    pageSize: 1,
    maxPages: 4,
    request: async () => { calls++; return json([site('same-project')]); },
  }), 'limit');
  assert.equal(calls, 2);
});

test('HTTP rejection, cancellation, and late responses release unread bodies without exposing server text', async () => {
  let cancellations = 0;
  const rejected = new Response(new ReadableStream<Uint8Array>({ cancel() { cancellations++; } }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
  await rejectsCode(getNetlifyAccountIdentity(TOKEN, USER_ID, { request: async () => rejected }), 'auth');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellations, 1);

  const abort = new AbortController();
  let resolveLate: ((response: Response) => void) | undefined;
  const late = new Response(new ReadableStream<Uint8Array>({ cancel() { cancellations++; } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const operation = getNetlifyAccountIdentity(TOKEN, USER_ID, {
    signal: abort.signal,
    request: async () => new Promise(resolve => { resolveLate = resolve; }),
  });
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  await rejectsCode(operation, 'cancelled');
  resolveLate?.(late);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellations, 2);
});
