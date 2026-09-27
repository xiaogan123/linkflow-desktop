import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyControl, isAllowedTaskUrl, isDestructiveControl, selectPublicUrl } from '../src/integrations/browser';

const control = (label: string, type = 'button') => ({ id: 0, tag: 'button', type, label, name: '', href: '', signature: '' });

test('navigation is limited to HTTPS channel hosts', () => {
  const hosts = ['example.com'];
  assert.equal(isAllowedTaskUrl('https://example.com/submit', hosts), true);
  assert.equal(isAllowedTaskUrl('https://app.example.com/submit', hosts), true);
  assert.equal(isAllowedTaskUrl('https://example.com.evil.test/', hosts), false);
  assert.equal(isAllowedTaskUrl('http://example.com/', hosts), false);
  assert.equal(isAllowedTaskUrl('https://user:pass@example.com/', hosts), false);
});

test('paid paths and submissions are classified before clicking', () => {
  assert.equal(classifyControl(control('Upgrade to paid plan')), 'destructive');
  assert.equal(classifyControl(control('Publish listing')), 'submission');
  assert.equal(classifyControl({ ...control('Create account'), formHasInput: true }), 'registration');
  assert.equal(classifyControl(control('', 'submit')), 'uncertain');
  assert.equal(classifyControl({ ...control('Sign up'), tag: 'a', href: 'https://example.com/register' }), 'navigation');
  assert.equal(classifyControl({ ...control('Sign up'), formHasInput: true }), 'registration');
  assert.equal(classifyControl({ ...control('Publish listing'), tag: 'a', href: 'https://example.com/publish' }), 'submission');
  assert.equal(classifyControl(control('Continue')), 'uncertain');
});

test('destructive labels, paths and form targets require a human', () => {
  assert.equal(isDestructiveControl({ label: 'Delete account', name: '', href: '' }), true);
  assert.equal(isDestructiveControl({ label: 'Continue', name: '', href: 'https://example.com/reset-password' }), true);
  assert.equal(isDestructiveControl({ label: 'Continue', name: '', href: 'https://example.com/%64elete-account' }), true);
  assert.equal(isDestructiveControl({ label: 'Submit', name: '', href: '', formAction: 'https://example.com/billing' }), true);
  assert.equal(classifyControl({ ...control('Manage'), handlerHint: "fetch('/revoke-token',{method:'POST'})" }), 'destructive');
  assert.equal(isDestructiveControl({ label: 'Publish listing', name: '', href: 'https://example.com/publish' }), false);
});

test('public URL requires observed target link or a successful view-result link', () => {
  const submit = 'https://example.com/submit';
  assert.equal(selectPublicUrl({ current: 'https://example.com/listing/123', targetPresent: true, resultLinks: [], text: 'Example' }, submit, ['example.com']), 'https://example.com/listing/123');
  assert.equal(selectPublicUrl({ current: submit, targetPresent: false, resultLinks: ['https://example.com/listing/123'], text: 'Published successfully' }, submit, ['example.com']), 'https://example.com/listing/123');
  assert.equal(selectPublicUrl({ current: submit, targetPresent: false, resultLinks: ['https://evil.test/listing/123'], text: 'Published successfully' }, submit, ['example.com']), undefined);
  assert.equal(selectPublicUrl({ current: submit, targetPresent: false, resultLinks: ['https://example.com/listing/123'], text: 'Submission form' }, submit, ['example.com']), undefined);
});
