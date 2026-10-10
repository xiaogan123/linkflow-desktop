import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { decryptBackup, encryptBackup } from '../src/main/backup';
import { validateBackup } from '../src/main/backup-validation';
import { shareYourHtmlDraftHash, shareYourHtmlSiteIdentityHash } from '../src/main/shareyourhtml-publication';
import { emptyState, type State } from '../src/main/store';
import type { Site, Task } from '../src/shared/types';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TASK_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-10-09T10:00:00.000Z';
const HTML = '<!doctype html><p>Reviewed</p>';
const SLUG = 'backup-cycle-67';
const OPERATION = 'shareyourhtml_backup_operation_67';
const EDIT_KEY = '01234567-89ab-cdef-0123-456789abcdef';
const DRAFT = { title: 'Reviewed', description: 'Fixture', body: 'Exact source draft.' };
const sourceHash = createHash('sha256').update(HTML).digest('hex');
const requestHash = createHash('sha256').update(JSON.stringify({ slug: SLUG, html: HTML,
  expiry: 'never' })).digest('hex');

function site(): Site {
  return { id: SITE_ID, domain: 'example.com', url: 'https://example.com/',
    email: 'owner@example.com', name: 'Example', description: 'Fixture', category: 'content',
    language: 'en', monthlyTarget: 2, status: 'ready', createdAt: NOW };
}

function task(stage: 'submitting' | 'api_receipt', id = TASK_ID): Task {
  const sourceSite = site();
  return { id, siteId: SITE_ID, channelId: 'shareyourhtml', sourceDomain: 'shareyourhtml.com',
    status: 'review', health: 'pending', createdAt: NOW, scheduledAt: NOW, updatedAt: NOW,
    submittedAt: NOW, attempts: 1, message: 'Pending', draftRevision: 4,
    draft: structuredClone(DRAFT), checkpoint: stage === 'submitting'
      ? 'shareyourhtml_create_submitting' : 'shareyourhtml_api_receipt',
    ...(stage === 'api_receipt' ? { publicUrl: `https://${SLUG}.shareyourhtml.com` } : {}),
    shareYourHtml: { operationId: OPERATION, slug: SLUG, sourceHash, requestHash,
      createdAt: NOW, stage, requestedExpiry: 'never', publicVerification: 'pending',
      reviewedDraftRevision: 4, reviewedDraftHash: shareYourHtmlDraftHash(DRAFT),
      siteId: SITE_ID, siteIdentityHash: shareYourHtmlSiteIdentityHash(sourceSite) } };
}

function state(stage: 'submitting' | 'api_receipt'): State {
  const value = emptyState(); value.sites = [site()]; value.tasks = [task(stage)]; return value;
}

function secret(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, taskId: TASK_ID, operationId: OPERATION, slug: SLUG,
    publicUrl: `https://${SLUG}.shareyourhtml.com`, sourceHash, requestHash,
    reviewedDraftHash: shareYourHtmlDraftHash(DRAFT), reviewedDraftRevision: 4,
    siteId: SITE_ID, siteIdentityHash: shareYourHtmlSiteIdentityHash(site()),
    editKey: EDIT_KEY, ...overrides });
}

test('unknown submitting claim survives strict backup without a secret and cannot be silently dropped', () => {
  const restored = validateBackup({ state: state('submitting'), secrets: {} });
  assert.equal(restored.state.tasks[0].shareYourHtml?.stage, 'submitting');
  assert.equal(restored.state.tasks[0].shareYourHtml?.slug, SLUG);
  assert.equal(restored.state.tasks[0].articleApprovedAt, undefined);
  assert.equal(restored.state.tasks[0].publicUrl, undefined);
});

test('pending receipt and exactly bound edit key survive encrypted backup roundtrip', () => {
  const backup = { state: state('api_receipt'),
    secrets: { [`publication:${TASK_ID}`]: secret() } };
  const encrypted = encryptBackup(backup, 'shareyourhtml-roundtrip-cycle-67');
  assert.equal(encrypted.toString().includes(EDIT_KEY), false);
  const restored = validateBackup(decryptBackup(encrypted, 'shareyourhtml-roundtrip-cycle-67'));
  assert.deepEqual(restored, validateBackup(backup));
  const saved = restored.state.tasks[0];
  assert.equal(saved.shareYourHtml?.stage, 'api_receipt');
  assert.equal(saved.shareYourHtml?.publicVerification, 'pending');
  assert.equal(saved.verifiedAt, undefined);
  assert.equal(saved.firstLiveAt, undefined);
});

test('receipt stage, task binding, draft binding, and secret binding are strict', () => {
  const cases: Array<{ value: State; secrets: Record<string, string> }> = [];
  const missingSecret = state('api_receipt'); cases.push({ value: missingSecret, secrets: {} });
  const secretOnIntent = state('submitting'); cases.push({ value: secretOnIntent,
    secrets: { [`publication:${TASK_ID}`]: secret() } });
  const wrongChannel = state('api_receipt'); wrongChannel.tasks[0].channelId = 'docs-md';
  cases.push({ value: wrongChannel, secrets: { [`publication:${TASK_ID}`]: secret() } });
  const changedDraft = state('api_receipt'); changedDraft.tasks[0].draft!.body = 'changed';
  cases.push({ value: changedDraft, secrets: { [`publication:${TASK_ID}`]: secret() } });
  const live = state('api_receipt'); Object.assign(live.tasks[0], { status: 'live', health: 'healthy',
    verifiedAt: NOW, firstLiveAt: NOW, linkCheck: 'found' });
  cases.push({ value: live, secrets: { [`publication:${TASK_ID}`]: secret() } });
  for (const item of cases) assert.throws(() => validateBackup({ state: item.value,
    secrets: item.secrets }), /ShareYourHTML|Docs MD|孤立/);

  for (const overrides of [{ taskId: OTHER_TASK_ID }, { slug: 'wrong-cycle-67' },
    { operationId: 'wrong_operation_67' }, { requestHash: 'f'.repeat(64) },
    { siteId: OTHER_TASK_ID }, { siteIdentityHash: 'e'.repeat(64) },
    { editKey: 'not-a-uuid' }]) {
    assert.throws(() => validateBackup({ state: state('api_receipt'),
      secrets: { [`publication:${TASK_ID}`]: secret(overrides) } }), /孤立/);
  }
});

test('site domain, URL, or task reparenting cannot retarget a durable claim or receipt', () => {
  for (const mutate of [
    (value: State) => { value.sites[0].domain = 'changed.example'; },
    (value: State) => { value.sites[0].url = 'https://changed.example/'; },
    (value: State) => {
      value.sites.push({ ...site(), id: OTHER_TASK_ID, domain: 'other.example',
        url: 'https://other.example/', email: 'owner@other.example' });
      value.tasks[0].siteId = OTHER_TASK_ID;
    },
  ]) {
    for (const stage of ['submitting', 'api_receipt'] as const) {
      const value = state(stage);
      mutate(value);
      const secrets = stage === 'api_receipt' ? { [`publication:${TASK_ID}`]: secret() } : {};
      assert.throws(() => validateBackup({ state: value, secrets }), /ShareYourHTML/);
    }
  }
});

test('duplicate operation or slug claims and wrong-channel publication ciphers are rejected', () => {
  for (const duplicate of ['operation', 'slug'] as const) {
    const value = state('submitting');
    const other = task('submitting', OTHER_TASK_ID);
    other.shareYourHtml = { ...other.shareYourHtml!,
      operationId: duplicate === 'operation' ? OPERATION : 'other_operation_67',
      slug: duplicate === 'slug' ? SLUG : 'other-cycle-67' };
    value.tasks.push(other);
    assert.throws(() => validateBackup({ state: value, secrets: {} }), /重复/);
  }
  const value = emptyState(); value.sites = [site()];
  value.tasks = [{ ...task('submitting'), channelId: 'docs-md', shareYourHtml: undefined }];
  assert.throws(() => validateBackup({ state: value,
    secrets: { [`publication:${TASK_ID}`]: secret() } }), /Docs MD|孤立/);
});


test('verified, lost, and recovered ShareYourHTML readback evidence roundtrips without changing the permanent claim or key', () => {
  const visible = state('api_receipt'), originalFirst = NOW;
  Object.assign(visible.tasks[0], {
    status: 'live', health: 'healthy', publicationMethod: 'client', verifiedAt: NOW,
    firstLiveAt: originalFirst, linkCheck: 'found', linkRel: 'nofollow ugc',
    lastCheckedAt: NOW, nextCheckAt: '2026-10-11T10:00:00.000Z', consecutiveMissing: 0,
    shareYourHtmlReadback: { checkedAt: NOW, status: 'visible_match', content: 'visible',
      targetLinks: [{ href: visible.sites[0].url, rel: ['nofollow', 'ugc'] }],
      indexing: { page: 'restricted', directives: ['noindex'], robots: 'unknown' } },
  });
  const first = validateBackup({state:visible,secrets:{[`publication:${TASK_ID}`]:secret()}});
  assert.equal(first.state.tasks[0].firstLiveAt,originalFirst);
  assert.equal(first.state.tasks[0].shareYourHtml?.publicVerification,'pending');
  const lost=structuredClone(first.state);Object.assign(lost.tasks[0],{
    status:'needs_input',health:'missing',linkCheck:'absent',lostAt:'2026-10-12T10:00:00.000Z',
    reviewKind:'lost_link',consecutiveMissing:1,lastCheckedAt:'2026-10-12T10:00:00.000Z',
    nextCheckAt:'2026-10-14T10:00:00.000Z',
    shareYourHtmlReadback:{checkedAt:'2026-10-12T10:00:00.000Z',status:'content_mismatch',content:'mismatch',targetLinks:[],indexing:{page:'unknown',directives:[],robots:'unknown'}},
  });
  const lostRoundtrip=validateBackup({state:lost,secrets:{[`publication:${TASK_ID}`]:secret()}});
  assert.equal(lostRoundtrip.state.tasks[0].firstLiveAt,originalFirst);
  const recovered=structuredClone(lostRoundtrip.state);Object.assign(recovered.tasks[0],{
    status:'live',health:'healthy',linkCheck:'found',linkRel:'ugc',verifiedAt:'2026-10-14T10:00:00.000Z',
    lastCheckedAt:'2026-10-14T10:00:00.000Z',nextCheckAt:'2026-10-16T10:00:00.000Z',
    lostAt:undefined,reviewKind:undefined,consecutiveMissing:0,
    shareYourHtmlReadback:{checkedAt:'2026-10-14T10:00:00.000Z',status:'visible_match',content:'visible',targetLinks:[{href:recovered.sites[0].url,rel:['ugc']}],indexing:{page:'not_restricted',directives:[],robots:'allowed'}},
  });
  const final=validateBackup({state:recovered,secrets:{[`publication:${TASK_ID}`]:secret()}});
  assert.equal(final.state.tasks[0].firstLiveAt,originalFirst);assert.equal(final.state.tasks[0].verifiedAt,'2026-10-14T10:00:00.000Z');
});

test('backup rejects forged live status, mismatched evidence, removed history, and unbound readback', () => {
  const cases:State[]=[];
  const noEvidence=state('api_receipt');Object.assign(noEvidence.tasks[0],{status:'live',health:'healthy',firstLiveAt:NOW,verifiedAt:NOW,linkCheck:'found',publicationMethod:'client'});cases.push(noEvidence);
  const mismatch=state('api_receipt');Object.assign(mismatch.tasks[0],{status:'live',health:'healthy',firstLiveAt:NOW,verifiedAt:NOW,linkCheck:'found',publicationMethod:'client',lastCheckedAt:NOW,nextCheckAt:'2026-10-11T10:00:00.000Z',consecutiveMissing:0,shareYourHtmlReadback:{checkedAt:NOW,status:'visible_match',content:'visible',targetLinks:[{href:'https://wrong.example/',rel:[]}],indexing:{page:'not_restricted',directives:[],robots:'unknown'}}});cases.push(mismatch);
  const unbound=state('api_receipt');unbound.tasks[0].shareYourHtml=undefined;unbound.tasks[0].shareYourHtmlReadback={checkedAt:NOW,status:'unreachable',content:'unknown',targetLinks:[],indexing:{page:'unknown',directives:[],robots:'unknown'}};cases.push(unbound);
  for(const value of cases)assert.throws(()=>validateBackup({state:value,secrets:{[`publication:${TASK_ID}`]:secret()}}),/ShareYourHTML|孤立/);
});
