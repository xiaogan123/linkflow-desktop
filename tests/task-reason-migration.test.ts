import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Task} from '../src/shared/types';
import {emptyState, Store} from '../src/main/store';
import {inferLegacyTaskReasonCode, migrateTaskReason} from '../src/main/task-reason-migration';

const stamp = '2026-10-01T00:00:00.000Z';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    siteId: '22222222-2222-4222-8222-222222222222',
    channelId: 'fixture-channel',
    sourceDomain: 'outside.example.com',
    status: 'failed',
    createdAt: stamp,
    scheduledAt: stamp,
    updatedAt: stamp,
    attempts: 1,
    message: '内容未通过审核。',
    ...overrides,
  };
}

test('legacy failure migration separates suitability from outcome and is idempotent', () => {
  const value = task({reason: '该渠道适合内容站。'});
  const observedAt = new Date('2026-10-18T00:00:00.000Z');
  assert.equal(migrateTaskReason(value, observedAt), true);
  assert.equal(value.suitabilityReason, '该渠道适合内容站。');
  assert.equal(value.reason, '该渠道适合内容站。');
  assert.equal(value.reasonCode, 'content_rejected');
  assert.equal(value.cooldownUntil, '2026-11-15T00:00:00.000Z');
  const once = structuredClone(value);
  assert.equal(migrateTaskReason(value, new Date('2027-01-01T00:00:00.000Z')), false);
  assert.deepEqual(value, once);
});

test('legacy AI 429 messages are not migrated into publication platform rate limits', () => {
  for(const message of ['AI API 请求失败（HTTP 429）','AI 模型列表请求失败（HTTP 429）','LLM rate limit']){
    const value=task({message});migrateTaskReason(value);
    assert.equal(value.reasonCode,'ai_rate_limited');
  }
  assert.equal(inferLegacyTaskReasonCode(task({message:'平台请求失败（HTTP 429）'})),'platform_rate_limited');
});

test('old human waits start at migration observation time and never pre-fill a reminder', () => {
  const observedAt = new Date('2026-10-18T06:00:00.000Z');
  const value = task({status: 'needs_input', message: '需要人工完成验证码。'});
  migrateTaskReason(value, observedAt);
  assert.equal(value.reasonCode, 'captcha_required');
  assert.equal(value.waitingSince, observedAt.toISOString());
  assert.equal(value.waitingDeadlineAt, '2026-10-20T06:00:00.000Z');
  assert.equal(value.waitingReminderAt, undefined);
  assert.equal(value.cooldownUntil, undefined);

  const existing = task({
    status: 'needs_input',
    message: '等待人工审核。',
    waitingSince: '2026-10-17T10:00:00.000Z',
  });
  migrateTaskReason(existing, observedAt);
  assert.equal(existing.reasonCode, 'manual_review');
  assert.equal(existing.waitingDeadlineAt, '2026-10-19T10:00:00.000Z');
});

test('uncertain external submission is not converted into an expiring human wait', () => {
  const value = task({
    status: 'needs_input',
    submittedAt: stamp,
    message: '提交结果待确认，请先检查平台记录。',
  });
  migrateTaskReason(value, new Date('2026-10-18T00:00:00.000Z'));
  assert.equal(value.reasonCode, 'submission_unknown');
  assert.equal(value.waitingSince, undefined);
  assert.equal(value.waitingDeadlineAt, undefined);
  assert.equal(value.cooldownUntil, undefined);
});

test('structured review evidence wins before legacy message fallback', () => {
  const value = task({
    message: 'generic old failure',
    articleReview: {
      status: 'failed',
      reason: 'fixture',
      reasonCode: 'input_too_long',
      evidenceUrls: [],
      draftRevision: 0,
      contentHash: 'a'.repeat(64),
      contextHash: 'b'.repeat(64),
    },
  });
  assert.equal(inferLegacyTaskReasonCode(value), 'evidence_truncated');
});

test('specific legacy terminal reasons win over skipped fallback and suitability text is ignored', () => {
  assert.equal(inferLegacyTaskReasonCode(task({status: 'skipped', message: '渠道已停用。'})), 'channel_disabled');
  assert.equal(inferLegacyTaskReasonCode(task({status: 'skipped', message: '原账号注册等待本人处理已超过两天。'})), 'human_timeout');
  assert.equal(inferLegacyTaskReasonCode(task({message: 'generic failure', reason: '渠道停用前很适合本站。'})), 'unknown');
});

test('legacy article review codes follow the structured task reason contract', () => {
  const review = (reasonCode: NonNullable<Task['articleReview']>['reasonCode'], reason = 'fixture') => task({
    articleReview: {
      status: 'failed',
      reason,
      reasonCode,
      evidenceUrls: [],
      draftRevision: 0,
      contentHash: 'a'.repeat(64),
      contextHash: 'b'.repeat(64),
    },
  });
  assert.equal(inferLegacyTaskReasonCode(review('evidence_fetch_failed')), 'temporary_failure');
  assert.equal(inferLegacyTaskReasonCode(review('policy_unknown')), 'channel_ineligible');
  assert.equal(inferLegacyTaskReasonCode(review('policy_not_found')), 'channel_ineligible');
  assert.equal(inferLegacyTaskReasonCode(review('ai_unavailable', '今日 AI 调用已达上限')), 'ai_daily_limit');
  assert.equal(inferLegacyTaskReasonCode(review('ai_unavailable', 'provider unavailable')), 'temporary_failure');
});

test('migration only adds cooldowns to terminal tasks and never expires publication evidence as a human wait', () => {
  const queued = task({status: 'queued', reasonCode: 'content_rejected'});
  migrateTaskReason(queued, new Date('2026-10-18T00:00:00.000Z'));
  assert.equal(queued.cooldownUntil, undefined);

  const submitted = task({
    status: 'needs_input',
    message: '需要人工处理。',
    rentry: {slug: 'fixture-post', contentHash: 'a'.repeat(64), stage: 'submitting'},
  });
  migrateTaskReason(submitted, new Date('2026-10-18T00:00:00.000Z'));
  assert.equal(submitted.reasonCode, 'submission_unknown');
  assert.equal(submitted.waitingSince, undefined);
  assert.equal(submitted.waitingDeadlineAt, undefined);
});

test('Store load writes migrated legacy task fields back to SQLite exactly once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-reason-migration-'));
  const path = join(directory, 'state.sqlite');
  try {
    const state = emptyState();
    state.tasks = [task({status: 'needs_input', message: '需要人工接管账号。'})];
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    database.prepare('INSERT INTO state(id,body) VALUES(1,?)').run(JSON.stringify(state));
    database.close();

    const first = new Store(path);
    const migrated = first.read().tasks[0];
    assert.equal(migrated.reasonCode, 'account_handoff');
    assert.ok(migrated.waitingSince);
    assert.ok(migrated.waitingDeadlineAt);
    first.close();

    const persisted = new DatabaseSync(path);
    const row = persisted.prepare('SELECT body FROM state WHERE id=1').get() as {body: string};
    persisted.close();
    assert.deepEqual(JSON.parse(row.body).tasks[0], JSON.parse(JSON.stringify(migrated)));

    const second = new Store(path);
    assert.deepEqual(second.read().tasks[0], migrated);
    second.close();
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('legacy definite refusals enter the original-date cooldown while invalid credentials remain human waits',()=>{
  for(const checkpoint of ['gist_rejected','telegraph_publish_rejected']){
    const old=task({status:'needs_input',checkpoint,message:'[placeholder]',updatedAt:'2026-10-01T00:00:00.000Z'});
    migrateTaskReason(old,new Date('2026-10-18T00:00:00.000Z'));
    assert.equal(old.status,'failed');assert.equal(old.reasonCode,'platform_rejected');
    assert.equal(old.cooldownUntil,'2026-10-31T00:00:00.000Z');assert.equal(old.waitingDeadlineAt,undefined);
    const saved=structuredClone(old);migrateTaskReason(old,new Date('2026-10-19T00:00:00.000Z'));assert.deepEqual(old,saved);
  }
  const credential=task({status:'needs_input',checkpoint:'gist_rejected',message:'GitHub 访问令牌无效，Gist 未创建；请更新凭据'});
  migrateTaskReason(credential,new Date('2026-10-18T00:00:00.000Z'));
  assert.equal(credential.reasonCode,'account_handoff');assert.equal(credential.status,'needs_input');assert.ok(credential.waitingDeadlineAt);
});
