import test from 'node:test';
import assert from 'node:assert/strict';
import type {Task} from '../src/shared/types';
import {validateBackup} from '../src/main/backup-validation';
import {emptyState} from '../src/main/store';

const siteId = '22222222-2222-4222-8222-222222222222';
const taskId = '11111111-1111-4111-8111-111111111111';
const stamp = '2026-10-18T00:00:00.000Z';

function backupTask(overrides: Partial<Task> = {}): Task {
  return {
    id: taskId,
    siteId,
    channelId: 'fixture-channel',
    sourceDomain: 'outside.example.com',
    status: 'failed',
    createdAt: stamp,
    scheduledAt: stamp,
    updatedAt: stamp,
    attempts: 1,
    message: 'fixture',
    ...overrides,
  };
}

function backupWith(task: Task) {
  const state = emptyState();
  state.sites.push({
    id: siteId,
    domain: 'example.com',
    url: 'https://example.com/',
    email: 'owner@example.com',
    name: 'Example',
    description: 'Fixture site',
    category: 'content',
    language: 'en',
    monthlyTarget: 1,
    status: 'ready',
    createdAt: stamp,
  });
  state.tasks.push(task);
  return {state, secrets: {}};
}

test('strict backup validation preserves all structured task reason fields', () => {
  const input = backupWith(backupTask({
    reason: 'legacy suitability',
    suitabilityReason: 'legacy suitability',
    reasonCode: 'format_invalid',
    cooldownUntil: '2026-12-02T00:00:00.000Z',
    waitingDeadlineAt: '2026-10-20T00:00:00.000Z',
    waitingReminderAt: '2026-10-19T00:00:00.000Z',
  }));
  const restored = validateBackup(input).state.tasks[0];
  assert.equal(restored.reasonCode, 'format_invalid');
  assert.equal(restored.cooldownUntil, '2026-12-02T00:00:00.000Z');
  assert.equal(restored.waitingDeadlineAt, '2026-10-20T00:00:00.000Z');
  assert.equal(restored.waitingReminderAt, '2026-10-19T00:00:00.000Z');
  assert.equal(restored.suitabilityReason, 'legacy suitability');
});

test('old backup without structured reason fields still restores and migrates', () => {
  const restored = validateBackup(backupWith(backupTask({message: '选题不是可用的本站正文页面。'}))).state.tasks[0];
  assert.equal(restored.reasonCode, 'invalid_topic');
  assert.equal(restored.cooldownUntil, undefined, 'draft-side failures never lock the platform');
  const rejected = validateBackup(backupWith(backupTask({checkpoint: 'telegraph_publish_rejected', message: '平台拒绝了本次提交'}))).state.tasks[0];
  assert.equal(rejected.reasonCode, 'platform_rejected');
  assert.equal(rejected.cooldownUntil, '2026-11-17T00:00:00.000Z');
});

test('backup rejects unknown reason codes and malformed reason dates', () => {
  const badCode = backupWith(backupTask()) as unknown as {state: {tasks: Array<Record<string, unknown>>}; secrets: {}};
  badCode.state.tasks[0].reasonCode = 'future_untrusted_code';
  assert.throws(() => validateBackup(badCode));

  const badDate = backupWith(backupTask({reasonCode: 'format_invalid'})) as unknown as {state: {tasks: Array<Record<string, unknown>>}; secrets: {}};
  badDate.state.tasks[0].cooldownUntil = 'tomorrow';
  assert.throws(() => validateBackup(badDate));
});

test('new structured review failure codes survive backup validation including archived attempts',()=>{
  for(const reasonCode of ['ai_daily_limit','ai_task_limit','evidence_truncated'] as const){
    const review={status:'failed' as const,reason:'[placeholder]',reasonCode,evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)};
    const restored=validateBackup(backupWith(backupTask({articleReview:review,articleAttempts:[{topicUrl:'https://example.com/guide',recordedAt:stamp,reason:'[placeholder]',articleReview:review}]}))).state.tasks[0];
    assert.equal(restored.articleReview?.reasonCode,reasonCode);assert.equal(restored.articleAttempts?.[0].articleReview?.reasonCode,reasonCode);
  }
});
