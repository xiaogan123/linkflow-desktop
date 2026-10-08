import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAi, parseAiJson } from '../src/integrations/ai';
import type { SecretStore, Settings } from '../src/shared/types';

const emptySecrets = { get: async () => undefined, set: async () => {}, delete: async () => {} } as SecretStore;

async function fakeCodex(t: { after: (fn: () => Promise<void>) => void }, body?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'linkflow-ai-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, 'pid');
  const executable = join(directory, 'fake-codex');
  await writeFile(executable, `#!${process.execPath}\n${body ?? `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));process.stderr.write('private-stderr-marker');process.stdin.resume();setInterval(()=>{},1000);setTimeout(()=>process.exit(99),15000);`}\n`);
  await chmod(executable, 0o700);
  return { executable, marker };
}

async function waitForPid(marker: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { return Number(await readFile(marker, 'utf8')); }
    catch { await new Promise<void>(resolve => setImmediate(resolve)); }
  }
  throw Error('fake Codex CLI did not start');
}

async function assertTerminated(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch { return; }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('fake Codex CLI remained alive after cancellation');
}

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
  const usage: unknown[] = [];
  globalThis.fetch = async (_url, options) => {
    seen = true;
    assert.equal(options?.redirect, 'error');
    const body = JSON.parse(String(options?.body));
    assert.equal(JSON.stringify(body).includes('private-key'), false);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 12, completion_tokens: 3, total_cost: 0.004, currency: 'USD' } }), { status: 200 });
  };
  try {
    const settings = { provider: 'api', apiBase: 'https://example.com/v1', model: 'test' } as Settings;
    const secrets = { get: async () => 'private-key', set: async () => {}, delete: async () => {} } as SecretStore;
    assert.deepEqual(await createAi(settings, secrets, undefined, value => usage.push(value)).json('return ok', {}), { ok: true });
    assert.equal(seen, true);
    assert.deepEqual(usage, [{ inputTokens: 12, outputTokens: 3, amount: 0.004, currency: 'USD' }]);
  } finally { globalThis.fetch = original; }
});

test('Codex timeout gives only ultra 600 seconds while preserving every lower budget', { skip: process.platform === 'win32' }, async t => {
  for (const [effort, limit] of [[undefined, 90_000], ['medium', 90_000], ['xhigh', 180_000], ['max', 180_000], ['ultra', 600_000]] as const) {
    await t.test(effort ?? 'unset', async childTest => {
      const { executable, marker } = await fakeCodex(childTest);
      const timer = childTest.mock.timers;
      timer.enable({ apis: ['setTimeout'] });
      let calls = 0, settled = false;
      const settings = { provider: 'codex', codexPath: executable, model: 'synthetic-model', reasoningEffort: effort } as Settings;
      const request = createAi(settings, emptySecrets, () => { calls++; }).json('return JSON', {});
      void request.then(() => { settled = true; }, () => { settled = true; });
      const pid = await waitForPid(marker);
      timer.tick(limit - 1);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(settled, false);
      timer.tick(1);
      await assert.rejects(request, /AI 请求已取消或超时/);
      assert.equal(calls, 1);
      await assertTerminated(pid);
      timer.reset();
    });
  }
});

test('explicit user cancellation still kills an ultra Codex child immediately without leaking stderr', { skip: process.platform === 'win32' }, async t => {
  const { executable, marker } = await fakeCodex(t);
  const controller = new AbortController();
  let calls = 0;
  const settings = { provider: 'codex', codexPath: executable, model: 'synthetic-model', reasoningEffort: 'ultra' } as Settings;
  const request = createAi(settings, emptySecrets, () => { calls++; }).json('return JSON', {}, undefined, controller.signal);
  const pid = await waitForPid(marker);
  controller.abort();
  await assert.rejects(request, error => {
    assert.match(String(error), /AI 请求已取消或超时/);
    assert.doesNotMatch(String(error), /private-stderr-marker/);
    return true;
  });
  assert.equal(calls, 1);
  await assertTerminated(pid);
});

test('Codex CLI failure never exposes child stderr', { skip: process.platform === 'win32' }, async t => {
  const { executable } = await fakeCodex(t, "process.stderr.write('private-stderr-marker');process.exit(17);");
  const settings = { provider: 'codex', codexPath: executable, model: 'synthetic-model', reasoningEffort: 'ultra' } as Settings;
  await assert.rejects(createAi(settings, emptySecrets).json('return JSON', {}), error => {
    assert.match(String(error), /Codex CLI 失败（退出码 17）/);
    assert.doesNotMatch(String(error), /private-stderr-marker/);
    return true;
  });
});

test('API provider retains the 90 second deadline', async t => {
  const original = globalThis.fetch;
  const timer = t.mock.timers;
  timer.enable({ apis: ['setTimeout'] });
  let calls = 0, settled = false;
  globalThis.fetch = (_url, options) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(Error('synthetic aborted')), { once: true });
  });
  try {
    const settings = { provider: 'api', apiBase: 'https://example.com/v1', model: 'synthetic-model', reasoningEffort: 'ultra' } as Settings;
    const secrets = { ...emptySecrets, get: async () => 'synthetic-key' } as SecretStore;
    const request = createAi(settings, secrets, () => { calls++; }).json('return JSON', {});
    void request.then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    timer.tick(89_999);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    timer.tick(1);
    await assert.rejects(request, /AI 请求已取消或超时/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; timer.reset(); }
});
