import test from 'node:test';
import assert from 'node:assert/strict';
import {
  README_MAX_RESPONSE_BYTES,
  createReadMeAccount,
  createReadMeGuide,
  probeReadMeProject,
  reconcileReadMeGuide,
  type ReadMeGuideIntent,
  type ReadMeGuidePersistence,
  type ReadMeOnboardingIntent,
  type ReadMeOnboardingPersistence,
  type ReadMeOnboardingSecrets,
  type ReadMeOpaqueResponse,
} from '../src/integrations/readme';

const at = '2026-10-24T08:00:00.000Z';
const token = 'rdme_example_token_123';
const signInUrl = 'https://dash.readme.com/to/example-once';
const projectLink = 'https://example-project.readme.io';
const operationId = 'readme_operation_12345678';
const categoryUri = '/branches/stable/categories/documentation/getting-started';
const projectId = '0123456789abcdef01234567';
const ownerId = 'owner_12345678';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function onboardingMemory() {
  let intent: ReadMeOnboardingIntent | undefined;
  let raw: ReadMeOpaqueResponse | undefined;
  let secrets: ReadMeOnboardingSecrets | undefined;
  const events: string[] = [];
  const persistence: ReadMeOnboardingPersistence = {
    async loadEncryptedIntent() { return intent; },
    async persistEncryptedIntent(value) { if (intent) throw new Error('claimed'); intent = value; events.push('intent'); },
    assertReadyToSubmit() { events.push('guard'); return true; },
    async persistEncryptedRawResponse(value) { raw = value; events.push('raw'); },
    async persistEncryptedSecrets(_intent, value) { secrets = value; events.push('secrets'); },
  };
  return { persistence, events, get intent() { return intent; }, get raw() { return raw; }, get secrets() { return secrets; } };
}

function guideMemory() {
  let intent: ReadMeGuideIntent | undefined;
  let raw: ReadMeOpaqueResponse | undefined;
  const events: string[] = [];
  const persistence: ReadMeGuidePersistence = {
    async loadEncryptedIntent() { return intent; },
    async persistEncryptedIntent(value) { if (intent) throw new Error('claimed'); intent = value; events.push('intent'); },
    assertReadyToSubmit() { events.push('guard'); return true; },
    async persistEncryptedRawResponse(value) { raw = value; events.push('raw'); },
  };
  return { persistence, events, get intent() { return intent; }, get raw() { return raw; } };
}

const accountInput = () => ({ operationId, name: 'Example Owner', email: 'owner@example.invalid', projectName: 'Example Docs' });
const guideInput = () => ({ operationId: 'readme_guide_12345678', branch: 'stable', slug: 'getting-started',
  categoryUri, title: 'Getting started', content: '# Getting started\n\nUse the example safely.\n' });

function guideData() {
  const input = guideInput();
  return { slug: input.slug, title: input.title, category: { uri: input.categoryUri }, content: { body: input.content },
    privacy: { view: 'public' }, allow_crawlers: 'enabled', type: 'basic',
    uri: `/branches/stable/guides/${input.slug}` };
}

function projectData(overrides: Record<string, unknown> = {}) {
  return { id: projectId, owner: { id: ownerId }, subdomain: 'example-project', privacy: { view: 'public' },
    allow_crawlers: 'enabled', plan: { type: 'free', trial: { active: false, expired: false, end_date: at },
      grace_period: { enabled: false, end_date: null, plan: null } }, ...overrides };
}

test('onboarding saves intent and raw response before secrets and never exposes token or one-use URL', async () => {
  const memory = onboardingMemory();
  let requestBody: unknown;
  const result = await createReadMeAccount(accountInput(), memory.persistence, {
    now: () => new Date(at),
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.readme.com/v2/projects/ai_onboarding');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(new Headers(init.headers).has('authorization'), false);
      requestBody = JSON.parse(String(init.body));
      return json(201, { data: { subdomain: 'example-project', project_link: projectLink, sign_in_url: signInUrl, token } });
    },
  });
  assert.equal(result.status, 'created');
  assert.deepEqual(requestBody, { name: 'Example Owner', email: 'owner@example.invalid', project_name: 'Example Docs' });
  assert.deepEqual(memory.events, ['intent', 'guard', 'raw', 'secrets']);
  assert.deepEqual(memory.secrets, { token, signInUrl });
  assert.ok(memory.raw?.bodyBase64);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes(signInUrl), false);
  if (result.status === 'created') {
    assert.equal(result.receipt.account.emailVerification, 'unverified');
    assert.equal(result.receipt.account.planConfirmation, 'unconfirmed');
    assert.equal(result.receipt.account.projectPublication, 'unverified');
    assert.equal('token' in result.receipt.account, false);
    assert.equal('signInUrl' in result.receipt.account, false);
  }
});

test('onboarding classifies documented errors without inventing a replacement email', async () => {
  for (const [status, reason] of [[400, 'email_invalid_or_existing'], [429, 'rate_limited'], [503, 'service_unavailable']] as const) {
    const memory = onboardingMemory();
    let calls = 0;
    const result = await createReadMeAccount(accountInput(), memory.persistence, {
      now: () => new Date(at), fetch: async () => { calls++; return json(status, { status, detail: 'safe' }); },
    });
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason, reason);
    assert.equal(calls, 1);
    assert.deepEqual(memory.events, ['intent', 'guard', 'raw']);
  }
});

test('a durable prior onboarding intent prevents every later POST, including after an unknown outcome', async () => {
  const memory = onboardingMemory();
  let calls = 0;
  const first = await createReadMeAccount(accountInput(), memory.persistence, {
    now: () => new Date(at), fetch: async () => { calls++; throw new Error('unknown network result'); },
  });
  assert.equal(first.status, 'unknown');
  const second = await createReadMeAccount(accountInput(), memory.persistence, {
    now: () => new Date(at), fetch: async () => { calls++; throw new Error('must not replay'); },
  });
  assert.equal(second.status, 'blocked');
  assert.equal(calls, 1);
});

test('intent persistence failure or final guard rejection performs zero external writes', async () => {
  let calls = 0;
  const failed = onboardingMemory();
  failed.persistence.persistEncryptedIntent = async () => { throw new Error(`vault failure ${token}`); };
  const first = await createReadMeAccount(accountInput(), failed.persistence, {
    now: () => new Date(at), fetch: async () => { calls++; return json(201, {}); },
  });
  assert.deepEqual(first, { status: 'not_started', reason: 'intent_not_persisted' });
  const guarded = onboardingMemory();
  guarded.persistence.assertReadyToSubmit = () => { throw new Error(`paused ${token}`); };
  const second = await createReadMeAccount(accountInput(), guarded.persistence, {
    now: () => new Date(at), fetch: async () => { calls++; return json(201, {}); },
  });
  assert.deepEqual(second, { status: 'not_started', reason: 'authorization_changed' });
  assert.equal(calls, 0);
  assert.equal(JSON.stringify([first, second]).includes(token), false);
});

test('redirect responses fail closed and bearer token is never forwarded to another origin', async () => {
  const memory = guideMemory();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await createReadMeGuide(guideInput(), token, memory.persistence, {
    now: () => new Date(at),
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url === 'https://api.readme.com/v2/projects/me') return json(200, { data: projectData() });
      return new Response('', { status: 302, headers: { location: 'https://evil.invalid/steal' } });
    },
  });
  assert.equal(result.status, 'unknown');
  if (result.status === 'unknown') assert.equal(result.diagnostic, 'redirect');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.readme.com/v2/branches/stable/guides');
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal(new Headers(calls[1].init.headers).get('authorization'), `Bearer ${token}`);
  assert.equal(calls.some(call => call.url.startsWith('https://evil.invalid')), false);
});

test('declared and streamed oversized response bodies are bounded and never accepted', async t => {
  for (const kind of ['declared', 'streamed'] as const) await t.test(kind, async () => {
    const memory = onboardingMemory();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { if (kind === 'streamed') controller.enqueue(new Uint8Array(README_MAX_RESPONSE_BYTES + 1)); },
      cancel() { cancelled = true; },
    });
    const response = new Response(body, { status: 201, headers: { 'content-type': 'application/json',
      ...(kind === 'declared' ? { 'content-length': String(README_MAX_RESPONSE_BYTES + 1) } : {}) } });
    const result = await createReadMeAccount(accountInput(), memory.persistence, {
      now: () => new Date(at), fetch: async () => response,
    });
    assert.equal(result.status, 'unknown');
    if (result.status === 'unknown') {
      assert.equal(result.diagnostic, 'body_limit');
      assert.equal(result.rawResponseSaved, true);
    }
    await Promise.resolve();
    assert.equal(cancelled, true);
    assert.equal(memory.raw?.bodyComplete, false);
    assert.equal(memory.secrets, undefined);
  });
});

test('guide creation sends the exact public basic payload and strict slug conflicts never auto-rename', async () => {
  const successMemory = guideMemory();
  const success = await createReadMeGuide(guideInput(), token, successMemory.persistence, {
    now: () => new Date(at),
    fetch: async (url, init) => {
      if (url === 'https://api.readme.com/v2/projects/me') return json(200, { data: projectData() });
      assert.equal(url, 'https://api.readme.com/v2/branches/stable/guides');
      const headers = new Headers(init.headers);
      assert.equal(headers.get('prefer'), 'handling=strict');
      assert.equal(headers.get('authorization'), `Bearer ${token}`);
      assert.deepEqual(JSON.parse(String(init.body)), {
        category: { uri: categoryUri }, title: 'Getting started',
        content: { body: '# Getting started\n\nUse the example safely.\n' }, slug: 'getting-started',
        privacy: { view: 'public' }, allow_crawlers: 'enabled', type: 'basic',
      });
      return json(201, { data: guideData() });
    },
  });
  assert.equal(success.status, 'created');
  if (success.status === 'created') {
    assert.equal(success.receipt.publicVerification, 'pending');
    assert.equal(success.receipt.projectPublication, 'unconfirmed');
  }
  assert.equal(successMemory.intent?.projectBinding.projectId, projectId);
  assert.equal(successMemory.intent?.projectBinding.ownerId, ownerId);
  assert.equal(successMemory.intent?.projectBinding.subdomain, 'example-project');
  assert.match(successMemory.intent?.projectBinding.tokenFingerprint ?? '', /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(successMemory.intent).includes(token), false);

  const conflictMemory = guideMemory();
  const conflict = await createReadMeGuide(guideInput(), token, conflictMemory.persistence, {
    now: () => new Date(at),
    fetch: async (url, init) => {
      if (url === 'https://api.readme.com/v2/projects/me') return json(200, { data: projectData() });
      assert.equal(new Headers(init.headers).get('prefer'), 'handling=strict');
      assert.equal(JSON.parse(String(init.body)).slug, 'getting-started');
      return json(409, { status: 409, detail: 'conflict' });
    },
  });
  assert.equal(conflict.status, 'conflict');
  assert.deepEqual(conflictMemory.events, ['intent', 'guard', 'raw']);
});

test('guide creation uses one pre-await input snapshot when the caller mutates input during project GET', async () => {
  const memory = guideMemory();
  const input = guideInput();
  const original = { ...input };
  let postedBody: unknown;
  memory.persistence.assertReadyToSubmit = intent => {
    assert.equal(intent.branch, original.branch);
    assert.equal(intent.slug, original.slug);
    assert.equal(intent.categoryUri, original.categoryUri);
    assert.equal(intent.title, original.title);
    return true;
  };
  const result = await createReadMeGuide(input, token, memory.persistence, { now: () => new Date(at),
    fetch: async (url, init) => {
      if (url === 'https://api.readme.com/v2/projects/me') {
        input.branch = 'main-en';
        input.slug = 'changed-guide';
        input.categoryUri = '/branches/main-en/categories/documentation/changed';
        input.title = 'Changed title';
        input.content = 'Changed content after the request began.';
        return json(200, { data: projectData() });
      }
      assert.equal(url, 'https://api.readme.com/v2/branches/stable/guides');
      postedBody = JSON.parse(String(init.body));
      return json(201, { data: guideData() });
    } });
  assert.equal(result.status, 'created');
  assert.deepEqual(postedBody, { category: { uri: original.categoryUri }, title: original.title,
    content: { body: original.content }, slug: original.slug, privacy: { view: 'public' },
    allow_crawlers: 'enabled', type: 'basic' });
  assert.equal(memory.intent?.branch, original.branch);
  assert.equal(memory.intent?.slug, original.slug);
  assert.equal(memory.intent?.title, original.title);
});

test('reconciliation verifies the bound project then reads only the original slug and leaves public acceptance pending', async () => {
  const memory = guideMemory();
  const created = await createReadMeGuide(guideInput(), token, memory.persistence, {
    now: () => new Date(at), fetch: async url => url === 'https://api.readme.com/v2/projects/me'
      ? json(200, { data: projectData() }) : json(201, { data: guideData() }),
  });
  assert.equal(created.status, 'created');
  const calls: string[] = [];
  const result = await reconcileReadMeGuide(memory.intent!, token, {
    fetch: async (url, init) => {
      calls.push(url);
      assert.equal(init.method, 'GET');
      if (url === 'https://api.readme.com/v2/projects/me') return json(200, { data: projectData() });
      return json(200, { data: guideData() });
    },
  });
  assert.equal(result.status, 'matched');
  assert.deepEqual(calls, ['https://api.readme.com/v2/projects/me',
    'https://api.readme.com/v2/branches/stable/guides/getting-started']);
  if (result.status === 'matched') {
    assert.equal(result.receipt.apiReconciled, true);
    assert.equal(result.receipt.publicVerification, 'pending');
  }
});

test('project probe parses only fields in the official schema and does not invent email verification', async () => {
  const result = await probeReadMeProject(token, { fetch: async (url, init) => {
    assert.equal(url, 'https://api.readme.com/v2/projects/me');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
    return json(200, { data: projectData() });
  } });
  assert.equal(result.status, 'observed');
  if (result.status === 'observed') {
    assert.equal(result.probe.projectId, projectId);
    assert.equal(result.probe.ownerId, ownerId);
    assert.equal(result.probe.subdomain, 'example-project');
    assert.equal(result.probe.privacyView, 'public');
    assert.equal(result.probe.allowCrawlers, 'enabled');
    assert.deepEqual(result.probe.plan, { type: 'free',
      trial: { active: false, expired: false, endDate: at },
      gracePeriod: { enabled: false, endDate: null, plan: null } });
    assert.equal(result.probe.ownerBinding, 'owner_id_observed');
    assert.equal(result.probe.emailVerification, 'not_exposed_by_project_schema');
    assert.equal(result.probe.projectPublication, 'not_established_by_project_metadata');
    assert.equal(result.probe.schemaConfirmation, 'official_project_schema_observed');
  }
});

test('guide creation stops after a GET when the project schema cannot establish a binding', async () => {
  const memory = guideMemory();
  const calls: Array<{ url: string; method: string | undefined }> = [];
  const result = await createReadMeGuide(guideInput(), token, memory.persistence, { now: () => new Date(at),
    fetch: async (url, init) => {
      calls.push({ url, method: init.method });
      return json(200, { data: { ...projectData(), id: 'not-a-project-id' } });
    } });
  assert.deepEqual(result, { status: 'not_started', reason: 'project_unconfirmed' });
  assert.deepEqual(calls, [{ url: 'https://api.readme.com/v2/projects/me', method: 'GET' }]);
  assert.equal(memory.intent, undefined);
  assert.deepEqual(memory.events, []);
});

test('reconciliation rejects a changed token locally before any request', async () => {
  const memory = guideMemory();
  await createReadMeGuide(guideInput(), token, memory.persistence, { now: () => new Date(at),
    fetch: async url => url === 'https://api.readme.com/v2/projects/me'
      ? json(200, { data: projectData() }) : json(201, { data: guideData() }) });
  let calls = 0;
  const result = await reconcileReadMeGuide(memory.intent!, 'rdme_changed_token_456', {
    fetch: async () => { calls++; return json(200, { data: guideData() }); },
  });
  assert.deepEqual(result, { status: 'binding_mismatch' });
  assert.equal(calls, 0);
});

test('reconciliation rejects a changed authenticated project before reading the guide', async () => {
  const memory = guideMemory();
  await createReadMeGuide(guideInput(), token, memory.persistence, { now: () => new Date(at),
    fetch: async url => url === 'https://api.readme.com/v2/projects/me'
      ? json(200, { data: projectData() }) : json(201, { data: guideData() }) });
  const calls: string[] = [];
  const result = await reconcileReadMeGuide(memory.intent!, token, { fetch: async url => {
    calls.push(url);
    return json(200, { data: projectData({ id: 'fedcba9876543210fedcba98' }) });
  } });
  assert.deepEqual(result, { status: 'binding_mismatch' });
  assert.deepEqual(calls, ['https://api.readme.com/v2/projects/me']);
});
