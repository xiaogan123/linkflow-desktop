import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexEnvironment, resolveCodexLaunch } from '../src/integrations/codex-process';

function fixture(withNative: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'linkflow-codex-resolve-'));
  const bin = join(root, 'npm-bin');
  const packageRoot = join(bin, 'node_modules', '@openai', 'codex');
  const script = join(packageRoot, 'bin', 'codex.js');
  const shim = join(bin, 'codex.cmd');
  const node = join(bin, 'node.exe');
  const native = join(packageRoot, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  mkdirSync(join(packageRoot, 'bin'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }));
  writeFileSync(script, '#!/usr/bin/env node\n');
  writeFileSync(shim, '@echo off\r\n');
  writeFileSync(node, 'fixture');
  if (withNative) { mkdirSync(join(native, '..'), { recursive: true }); writeFileSync(native, 'fixture'); }
  return { root, bin, packageRoot, script, shim, node, native, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('Windows npm codex.cmd resolves to the matching native exe without a shell', () => {
  const f = fixture(true);
  try {
    const launch = resolveCodexLaunch('codex', { platform: 'win32', arch: 'x64', pathEnv: f.bin, execPath: '/app/Linkflow.exe' });
    assert.deepEqual(launch, { command: f.native, prefixArgs: [], envAdditions: {} });
    assert.notEqual(launch.command, f.shim);
  } finally { f.cleanup(); }
});

test('Windows npm shim falls back to Node plus verified package JS when native exe is absent', () => {
  const f = fixture(false);
  try {
    const launch = resolveCodexLaunch(f.shim, { platform: 'win32', arch: 'x64', pathEnv: f.bin, execPath: '/app/Linkflow.exe' });
    assert.deepEqual(launch, { command: f.node, prefixArgs: [f.script], envAdditions: {} });
  } finally { f.cleanup(); }
});

test('Windows JS fallback can use Electron run-as-node when Node is not on PATH', () => {
  const f = fixture(false);
  try {
    rmSync(f.node);
    const launch = resolveCodexLaunch(f.shim, { platform: 'win32', arch: 'x64', pathEnv: '', execPath: '/app/Linkflow.exe' });
    assert.deepEqual(launch, { command: '/app/Linkflow.exe', prefixArgs: [f.script], envAdditions: { ELECTRON_RUN_AS_NODE: '1' } });
  } finally { f.cleanup(); }
});

test('Windows native exe is launched directly and unverified command shims fail closed', () => {
  const f = fixture(false);
  try {
    const native = join(f.bin, 'codex.exe');
    writeFileSync(native, 'fixture');
    assert.deepEqual(resolveCodexLaunch(native, { platform: 'win32' }), { command: native, prefixArgs: [], envAdditions: {} });
    rmSync(join(f.packageRoot, 'package.json'));
    assert.throws(() => resolveCodexLaunch(f.shim, { platform: 'win32', pathEnv: f.bin }), /npm 包/);
  } finally { f.cleanup(); }
});

test('non-Windows launch keeps the configured CLI while auth environment omits unrelated secrets', () => {
  assert.deepEqual(resolveCodexLaunch('/usr/bin/codex', { platform: 'linux' }), { command: '/usr/bin/codex', prefixArgs: [], envAdditions: {} });
  const env = codexEnvironment({ PATH: '/usr/bin', USERPROFILE: 'profile', APPDATA: 'appdata', CODEX_HOME: 'codex-home', OPENAI_API_KEY: 'private', NODE_OPTIONS: '--require x' }, {}, 'win32');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.USERPROFILE, 'profile');
  assert.equal(env.APPDATA, 'appdata');
  assert.equal(env.CODEX_HOME, 'codex-home');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});
