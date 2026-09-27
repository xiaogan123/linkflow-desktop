import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAccountPage, classifyControl, isAllowedTaskUrl, isDestructiveControl, redactStructuredSecrets, selectPublicUrl } from '../src/integrations/browser';

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

const accountPage=(text:string,password=true,labels:string[]=[])=>({text,controls:[...(password?[{label:'Password',type:'password',formHasPassword:true}]:[]),...labels.map(label=>({label,type:'button'}))]});

test('account page evidence distinguishes recoverable registration from credential and platform restrictions',()=>{
  assert.equal(classifyAccountPage(accountPage('That username is already taken.')),'username_taken');
  assert.equal(classifyAccountPage(accountPage('This email is already registered.')),'email_exists');
  assert.equal(classifyAccountPage(accountPage('Incorrect password. Try again.')),'bad_password');
  assert.equal(classifyAccountPage(accountPage('Your account has been suspended.')),'restricted');
  assert.equal(classifyAccountPage(accountPage('Check your inbox. A verification email was sent.')),'verification_required');
  assert.equal(classifyAccountPage(accountPage('We could not complete your request.')),'unknown');
});

test('authenticated and verified evidence wins only when explicit',()=>{
  assert.equal(classifyAccountPage(accountPage('Dashboard',false,['My account','Log out'])),'authenticated');
  assert.equal(classifyAccountPage(accountPage('Your account has been suspended.',false,['My account','Log out'])),'restricted');
  assert.equal(classifyAccountPage(accountPage('Email has been verified',false)),'verified');
  assert.equal(classifyAccountPage(accountPage('Verification failed',false)),'unknown');
});

test('structured secret redaction handles JSON-sensitive passwords before serialization',()=>{
  const password='quote" and slash\\ fixture';
  const redacted=redactStructuredSecrets({text:`Error echoed ${password}`,controls:[{label:password,nested:{value:password}}]},[password]);
  assert.equal(redacted.text,'Error echoed [redacted]');
  assert.equal(redacted.controls[0].label,'[redacted]');
  assert.equal(redacted.controls[0].nested.value,'[redacted]');
  assert.equal(JSON.stringify(redacted).includes(password),false);
});
