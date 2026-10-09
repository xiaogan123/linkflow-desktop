import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptBackup, encryptBackup } from '../src/main/backup';
import { validateBackup } from '../src/main/backup-validation';
import { emptyState, type State } from '../src/main/store';
import { supanoteTaskContentHash } from '../src/main/supanote-publication';
import type { Site, Task } from '../src/shared/types';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-10-09T10:00:00.000Z';
const PUBLIC_ID = 'fixture_note_43';
const PUBLIC_URL = `https://supanote.app/n/${PUBLIC_ID}`;

function fixtureSite(): Site {
  return {
    id: SITE_ID,
    domain: 'example.com',
    url: 'https://example.com/',
    email: 'owner@example.com',
    name: 'Example',
    description: 'Fixture publication',
    category: 'content',
    language: 'en',
    monthlyTarget: 2,
    status: 'ready',
    createdAt: NOW,
  };
}

function fixtureTask(stage: 'submitting' | 'api_receipt' | 'published'): Task {
  const task: Task = {
    id: TASK_ID,
    siteId: SITE_ID,
    channelId: 'supanote',
    sourceDomain: 'supanote.app',
    status: 'review',
    health: 'pending',
    createdAt: NOW,
    scheduledAt: NOW,
    updatedAt: NOW,
    submittedAt: NOW,
    attempts: 1,
    message: 'Supanote API receipt is pending rendering verification',
    draft: {
      title: 'Reviewed Supanote article',
      description: 'Fixture',
      body: 'Original Markdown with a [source](https://example.com/research).',
    },
  };
  const contentHash = supanoteTaskContentHash(task)!;
  task.supanote = {
    operationId: 'backup_operation_43',
    contentHash,
    createdAt: NOW,
    stage,
    ...(stage !== 'submitting' ? { publicId: PUBLIC_ID } : {}),
  };
  task.checkpoint = stage === 'published' ? 'supanote_published' : stage === 'api_receipt' ? 'supanote_api_receipt' : 'supanote_publish_submitting';
  if (stage !== 'submitting') task.publicUrl = PUBLIC_URL;
  if (stage === 'published') Object.assign(task, {status:'live',health:'healthy',verifiedAt:NOW,firstLiveAt:NOW,lastCheckedAt:NOW,nextCheckAt:'2026-10-16T10:00:00.000Z',linkCheck:'found',linkRel:'ugc nofollow noopener noreferrer',consecutiveMissing:0});
  return task;
}

function state(stage: 'submitting' | 'api_receipt' | 'published'): State {
  const value = emptyState();
  value.sites = [fixtureSite()];
  value.tasks = [fixtureTask(stage)];
  return value;
}

function serializedSecret(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    taskId: TASK_ID,
    publicId: PUBLIC_ID,
    publicUrl: PUBLIC_URL,
    token: 'fixture_manage_token_43',
    ...overrides,
  });
}

test('a durable Supanote intent survives strict backup validation without becoming active', () => {
  const backup = { state: state('submitting'), secrets: {} };
  const restored = validateBackup(backup);
  const task = restored.state.tasks[0];
  assert.equal(task.supanote?.stage, 'submitting');
  assert.equal(task.submittedAt, NOW);
  assert.equal(task.checkpoint, 'supanote_publish_submitting');
  assert.equal(task.status, 'review');
  assert.equal(task.health, 'pending');
  assert.equal(task.publicUrl, undefined);
});

test('a local Supanote draft under article review does not require a remote receipt',()=>{
  const value=emptyState(),pending=fixtureTask('submitting');delete pending.supanote;delete pending.submittedAt;pending.status='needs_input';pending.health='pending';pending.checkpoint='article_review';value.sites=[fixtureSite()];value.tasks=[pending];
  const restored=validateBackup({state:value,secrets:{}}).state.tasks[0];assert.equal(restored.checkpoint,'article_review');assert.equal(restored.supanote,undefined);
});

test('a bound API receipt and management secret survive encrypted backup roundtrip', () => {
  const backup = {
    state: state('api_receipt'),
    secrets: { [`publication:${TASK_ID}`]: serializedSecret() },
  };
  const encrypted = encryptBackup(backup, 'supanote-roundtrip-passphrase-43');
  assert.equal(encrypted.toString().includes('fixture_manage_token_43'), false);
  const restored = validateBackup(decryptBackup(encrypted, 'supanote-roundtrip-passphrase-43'));
  assert.deepEqual(restored, validateBackup(backup));
  assert.equal(restored.state.tasks[0].status, 'review');
  assert.equal(restored.state.tasks[0].verifiedAt, undefined);
  assert.equal(restored.state.tasks[0].firstLiveAt, undefined);
});

test('an API receipt remains restorable after the three bounded read-only checks stop',()=>{
  const value=state('api_receipt');Object.assign(value.tasks[0],{status:'needs_input',reconcileAttempts:3,reconcileAfter:undefined,lastCheckedAt:NOW,nextCheckAt:'2026-10-10T10:00:00.000Z'});
  const restored=validateBackup({state:value,secrets:{}}).state.tasks[0];assert.equal(restored.status,'needs_input');assert.equal(restored.reconcileAttempts,3);assert.equal(restored.supanote?.stage,'api_receipt');assert.equal(restored.firstLiveAt,undefined);
  value.tasks[0].reconcileAttempts=2;assert.throws(()=>validateBackup({state:value,secrets:{}}));
});

test('a no-ID intent remains restorable after bounded reconciliation stops without a repost',()=>{
  const value=state('submitting');Object.assign(value.tasks[0],{status:'needs_input',reconcileAttempts:3,reconcileAfter:undefined});
  const restored=validateBackup({state:value,secrets:{}}).state.tasks[0];assert.equal(restored.supanote?.stage,'submitting');assert.equal(restored.supanote?.publicId,undefined);assert.equal(restored.publicUrl,undefined);assert.equal(restored.reconcileAttempts,3);
});

test('skipping preserves pending Supanote intent or receipt evidence without making it live',()=>{
  for(const stage of ['submitting','api_receipt'] as const){const value=state(stage);value.tasks[0].status='skipped';const restored=validateBackup({state:value,secrets:{}}).state.tasks[0];assert.equal(restored.status,'skipped');assert.equal(restored.supanote?.stage,stage);assert.equal(restored.firstLiveAt,undefined);assert.equal(restored.linkCheck,undefined)}
});

test('a fully rendered publication and its optional management secret survive backup roundtrip',()=>{
  const backup={state:state('published'),secrets:{[`publication:${TASK_ID}`]:serializedSecret()}},restored=validateBackup(structuredClone(backup)),saved=restored.state.tasks[0];
  assert.equal(saved.supanote?.stage,'published');assert.equal(saved.status,'live');assert.equal(saved.health,'healthy');assert.equal(saved.linkCheck,'found');assert.equal(saved.publicUrl,PUBLIC_URL);assert.equal(restored.secrets[`publication:${TASK_ID}`],serializedSecret());
  assert.deepEqual(validateBackup(decryptBackup(encryptBackup(backup,'supanote-published-passphrase-44'),'supanote-published-passphrase-44')),restored);
});

test('a verified Supanote receipt keeps safe historical evidence after a later miss or read failure',()=>{
  const missing=state('published'),missingTask=missing.tasks[0];Object.assign(missingTask,{status:'needs_input',health:'missing',linkCheck:'absent',reviewKind:'lost_link',lostAt:'2026-10-10T10:00:00.000Z',lastCheckedAt:'2026-10-10T10:00:00.000Z',nextCheckAt:'2026-10-17T10:00:00.000Z',consecutiveMissing:1});
  assert.equal(validateBackup({state:missing,secrets:{}}).state.tasks[0].reviewKind,'lost_link');
  const unavailable=state('published'),unavailableTask=unavailable.tasks[0];Object.assign(unavailableTask,{health:'unknown',linkCheck:'unreachable',lastCheckedAt:'2026-10-10T10:00:00.000Z',nextCheckAt:'2026-10-11T10:00:00.000Z'});
  assert.equal(validateBackup({state:unavailable,secrets:{}}).state.tasks[0].health,'unknown');
});

test('skipping a previously verified Supanote task retains strict historical proof',()=>{
  for(const mutate of [(task:Task)=>{task.status='skipped'},(task:Task)=>Object.assign(task,{status:'skipped',health:'missing',linkCheck:'absent',reviewKind:'lost_link',lostAt:'2026-10-10T10:00:00.000Z',lastCheckedAt:'2026-10-10T10:00:00.000Z',nextCheckAt:'2026-10-17T10:00:00.000Z',consecutiveMissing:1})]){const value=state('published');mutate(value.tasks[0]);const restored=validateBackup({state:value,secrets:{}}).state.tasks[0];assert.equal(restored.status,'skipped');assert.equal(restored.supanote?.stage,'published');assert.ok(restored.firstLiveAt)}
});

test('Supanote backups reject fabricated live evidence and malformed receipt stages', () => {
  for (const mutate of [
    (value: State) => { value.tasks[0].status = 'live'; },
    (value: State) => { value.tasks[0].health = 'healthy'; },
    (value: State) => { value.tasks[0].verifiedAt = NOW; },
    (value: State) => { value.tasks[0].firstLiveAt = NOW; },
    (value: State) => { value.tasks[0].linkCheck = 'found'; },
    (value: State) => { value.tasks[0].publicUrl = 'https://supanote.app/n/different_note'; },
    (value: State) => { value.tasks[0].submittedAt = '2026-10-09T11:00:00.000Z'; },
    (value: State) => { value.tasks[0].draft!.body = 'Changed after receipt'; },
  ]) {
    const value = state('api_receipt');
    mutate(value);
    assert.throws(() => validateBackup({ state: value, secrets: {} }));
  }
  const unknown = state('api_receipt') as unknown as { tasks: Array<{ supanote: Record<string, unknown> }> };
  unknown.tasks[0].supanote.stage = 'published';
  assert.throws(() => validateBackup({ state: unknown, secrets: {} }));
});

test('published backups reject missing or fabricated public verification evidence',()=>{
  const mutations:Array<(task:Task)=>void>=[
    task=>{task.status='review'},task=>{task.health='pending'},task=>{task.linkCheck=undefined},task=>{task.linkRel='follow'},task=>{task.verifiedAt=undefined},task=>{task.firstLiveAt=undefined},task=>{task.lastCheckedAt=undefined},task=>{task.nextCheckAt=NOW},task=>{task.checkpoint='supanote_api_receipt'},task=>{task.supanote!.stage='api_receipt'},task=>{task.draft!.body+=' changed'},
  ];
  for(const mutate of mutations){const value=state('published');mutate(value.tasks[0]);assert.throws(()=>validateBackup({state:value,secrets:{}}))}
});

test('Supanote backups cannot omit the receipt while retaining any external state', () => {
  const mutations: Array<(task: Task) => void> = [
    task => { task.submittedAt = NOW; },
    task => { task.publicUrl = PUBLIC_URL; },
    task => { task.verifiedAt = NOW; },
    task => { task.firstLiveAt = NOW; },
    task => { task.linkCheck = 'found'; },
    task => { task.status = 'live'; task.health = 'healthy'; },
    task => { task.checkpoint = 'unknown_external_publish'; },
  ];
  for (const mutate of mutations) {
    const value = emptyState();
    const restored = fixtureTask('submitting');
    delete restored.supanote;
    delete restored.submittedAt;
    delete restored.checkpoint;
    restored.status = 'running';
    mutate(restored);
    value.sites = [fixtureSite()];
    value.tasks = [restored];
    assert.throws(() => validateBackup({ state: value, secrets: {} }), /Supanote/);
  }
});

test('Supanote backup secrets reject orphans and every wrong identity binding', () => {
  const cases: Array<{ state: State; secret: string }> = [
    { state: emptyState(), secret: serializedSecret() },
    { state: state('submitting'), secret: serializedSecret() },
    { state: state('api_receipt'), secret: serializedSecret({ taskId: '33333333-3333-4333-8333-333333333333' }) },
    { state: state('api_receipt'), secret: serializedSecret({ publicId: 'different_note' }) },
    { state: state('api_receipt'), secret: serializedSecret({ publicUrl: 'https://supanote.app/n/different_note' }) },
    { state: state('api_receipt'), secret: serializedSecret({ token: 'bad token' }) },
  ];
  for (const item of cases) assert.throws(() => validateBackup({
    state: item.state,
    secrets: { [`publication:${TASK_ID}`]: item.secret },
  }));
});

test('Supanote tasks cannot import accounts, bindings, or a receipt under another channel', () => {
  const withAccount = state('api_receipt');
  withAccount.accounts.push({
    id: '33333333-3333-4333-8333-333333333333',
    channelId: 'supanote',
    email: 'owner@example.com',
    username: 'owner',
    createdAt: NOW,
    status: 'registered',
    hasPassword: false,
  });
  assert.throws(() => validateBackup({ state: withAccount, secrets: {} }), /Supanote 账号/);

  const wrongChannel = state('api_receipt');
  wrongChannel.tasks[0].channelId = 'other';
  assert.throws(() => validateBackup({ state: wrongChannel, secrets: {} }), /Supanote 回执/);
});
