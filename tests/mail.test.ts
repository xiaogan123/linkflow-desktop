import test from 'node:test';
import assert from 'node:assert/strict';
import { isMatchingVerificationEnvelope, verificationUrls } from '../src/integrations/mail';

test('verification URL extraction enforces HTTPS host allowlist', () => {
  const text = 'Confirm https://login.example.com/verify?token=abc&amp;next=1 and ignore http://example.com/verify and https://example.com.evil.test/verify';
  assert.deepEqual(verificationUrls(text, ['example.com']), ['https://login.example.com/verify?token=abc&next=1']);
});

test('verification extraction rejects account reset and unrelated actions', () => {
  const text = 'https://example.com/reset-password?token=x https://example.com/delete-account?confirm=x https://example.com/news https://example.com/confirm-email?token=ok';
  assert.deepEqual(verificationUrls(text, ['example.com']), ['https://example.com/confirm-email?token=ok']);
});

test('mail matching rejects another recipient and mail older than registration', () => {
  const since = new Date('2026-09-26T10:00:00Z');
  const message = { from: [{ address: 'noreply@example.com' }], to: [{ address: 'site@owner.test' }], date: new Date('2026-09-26T10:05:00Z') };
  assert.equal(isMatchingVerificationEnvelope(message, 'site@owner.test', 'example.com', since), true);
  assert.equal(isMatchingVerificationEnvelope(message, 'other@owner.test', 'example.com', since), false);
  assert.equal(isMatchingVerificationEnvelope({ ...message, date: new Date('2026-09-26T09:59:00Z') }, 'site@owner.test', 'example.com', since), false);
  assert.equal(isMatchingVerificationEnvelope({ ...message, from: [{ address: 'noreply@evil.test' }] }, 'site@owner.test', 'example.com', since), false);
});
