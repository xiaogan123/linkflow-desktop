import test from 'node:test';
import assert from 'node:assert/strict';
import { createAi, parseAiJson } from '../src/integrations/ai';
import type { SecretStore, Settings } from '../src/shared/types';

test('AI accepts only bounded JSON objects', () => {
  assert.deepEqual(parseAiJson('{"ok":true}'), { ok: true });
  assert.throws(() => parseAiJson('```json\n{"ok":true}\n```'), /JSON/);
  assert.throws(() => parseAiJson('[1]'), /格式/);
  assert.throws(() => parseAiJson('x'.repeat(65_000)), /长度/);
});

test('aborted requests never spend an AI call', async () => {
  let calls = 0;
  const settings = { provider: 'api', apiBase: 'https://example.com/v1', model: 'test' } as Settings;
  const secrets = { get: async () => undefined, set: async () => {}, delete: async () => {} } as SecretStore;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createAi(settings, secrets, () => { calls++; }).json('test', {}, undefined, controller.signal), /取消/);
  assert.equal(calls, 0);
});

test('daily AI budget rejection stops before network', async () => {
  const settings = { provider: 'api', apiBase: 'https://example.com/v1', model: 'test' } as Settings;
  const secrets = { get: async () => undefined, set: async () => {}, delete: async () => {} } as SecretStore;
  await assert.rejects(createAi(settings, secrets, () => { throw new Error('budget'); }).json('test', {}), /budget/);
});

test('API requests refuse redirects while keeping the key out of the prompt', async () => {
  const original = globalThis.fetch;
  let seen = false;
  globalThis.fetch = async (_url, options) => {
    seen = true;
    assert.equal(options?.redirect, 'error');
    const body = JSON.parse(String(options?.body));
    assert.equal(JSON.stringify(body).includes('private-key'), false);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  };
  try {
    const settings = { provider: 'api', apiBase: 'https://example.com/v1', model: 'test' } as Settings;
    const secrets = { get: async () => 'private-key', set: async () => {}, delete: async () => {} } as SecretStore;
    assert.deepEqual(await createAi(settings, secrets).json('return ok', {}), { ok: true });
    assert.equal(seen, true);
  } finally { globalThis.fetch = original; }
});
