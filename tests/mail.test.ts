import test from 'node:test';
import assert from 'node:assert/strict';
import { isMatchingVerificationEnvelope, mailboxClientOptions, verificationUrls } from '../src/integrations/mail';

test('IMAP options omit branded client identification for every mailbox host',()=>{
  for(const host of ['imap.163.com','imap.126.com','imap.gmail.com']){
    const options=mailboxClientOptions({host,port:993,user:'owner@example.com',secure:true},'secret');
    assert.equal(Object.hasOwn(options,'clientInfo'),false);
    assert.doesNotMatch(JSON.stringify(options),/linkflow/i);
  }
});

test('verification URL extraction enforces HTTPS host allowlist', () => {
  const text = 'Confirm https://login.example.com/verify?token=abc&amp;next=1 and ignore http://example.com/verify?token=abc and https://example.com.evil.test/verify?token=abc';
  assert.deepEqual(verificationUrls(text, ['example.com']), ['https://login.example.com/verify?token=abc&next=1']);
});

test('verification extraction rejects account reset and unrelated actions', () => {
  const text = 'https://example.com/reset-password?token=abc https://example.com/delete-account?confirm=abc https://example.com/news https://example.com/confirm-email?token=okay';
  assert.deepEqual(verificationUrls(text, ['example.com']), ['https://example.com/confirm-email?token=okay']);
});

test('verification URLs require a token route and reject denial or user-content subdomains',()=>{
  const text=[
    'https://example.com/signup?ref=friend',
    'https://example.com/register?token=abc123',
    'https://example.com/signup/decline?token=abc123',
    'https://example.com/register/not-me?token=abc123',
    'https://example.com/confirm/deny?token=abc123',
    'https://example.com/confirm?token=abc123',
  ].join(' ');
  assert.deepEqual(verificationUrls(text,['example.com']),['https://example.com/confirm?token=abc123']);
  assert.deepEqual(verificationUrls('https://attacker.carrd.co/verify?token=abc123 https://carrd.co/verify?token=abc123',['carrd.co']),['https://carrd.co/verify?token=abc123']);
});
test('verification route uses component boundaries and excludes deactivation and login actions',()=>{
  const paths=['/account/deactivate','/account/inactivate','/account/disable','/account/unverify','/account/mute','/account/pause','/account/stop','/account/leave','/account/close','/account/login','/account/magic','/停用','/注销','/deactivate/verify'];
  const text=[...paths.map(path=>`https://example.com${path}?token=abc123`),
    'https://example.com/account/activate?token=abc123',
    'https://example.com/account/confirm-email?token=abc123',
    'https://example.com/account/verify?token=abc123'].join(' ');
  assert.deepEqual(verificationUrls(text,['example.com']),[
    'https://example.com/account/activate?token=abc123',
    'https://example.com/account/confirm-email?token=abc123',
    'https://example.com/account/verify?token=abc123',
  ]);
  assert.deepEqual(verificationUrls('https://example.com/verify?token=abc123&action=disable',['example.com']),[]);
  assert.deepEqual(verificationUrls('https://example.com/verify/de%2561ctivate?token=abc123',['example.com']),[]);
});
test('verification URLs recognize common joined routes and signed framework tokens',()=>{
  const urls=[
    'https://example.com/verifyEmail?token=abc123',
    'https://example.com/confirmemail?token=abc123',
    'https://example.com/emailverification?token=abc123',
    'https://example.com/activateAccount?token=abc123',
    'https://example.com/users/confirmation?confirmation_token=abc123',
    'https://example.com/email/verify/123/abc?expires=1792320000&signature=abcdef123456',
  ];
  assert.deepEqual(verificationUrls(urls.join(' '),['example.com']),urls);
  assert.deepEqual(verificationUrls('https://example.com/email/verify/123/abc?expires=1792320000',['example.com']),[]);
});
test('unsafe URL matching uses words and inspects only dangerous redirect paths',()=>{
  const safe=[
    'https://example.com/blockchain/disclosure/verifyEmail?token=abc123',
    'https://example.com/verify?token=abc123&next=/login',
    'https://example.com/verify?token=abc123&redirect=https://block.example.com/login?token=delete',
    'https://example.com/verify?token=abc123&blockchain=disclosure',
  ];
  assert.deepEqual(verificationUrls(safe.join(' '),['example.com']),safe);
  for(const suffix of ['/resetPassword','/delete-account','/not-me','/deactivateAccount','/de%2561ctivate']){
    assert.deepEqual(verificationUrls(`https://example.com/verify?token=abc123&next=${suffix}`,['example.com']),[],suffix);
  }
  for(const path of ['/deactivateAccount/verify','/resetPassword/verify','/verify/disavow','/verify/signIn']){
    assert.deepEqual(verificationUrls(`https://example.com${path}?token=abc123`,['example.com']),[],path);
  }
});
test('authentication actions are rejected while login return destinations remain allowed',()=>{
  for(const action of ['login','signin','magic','/login','signIn','%6cogin']){
    assert.deepEqual(verificationUrls(`https://example.com/verify?token=abc123&action=${action}`,['example.com']),[],action);
  }
  for(const name of ['next','redirect','return','continue','url','target']){
    const url=`https://example.com/verify?token=abc123&${name}=/login`;
    assert.deepEqual(verificationUrls(url,['example.com']),[url],name);
  }
});

test('mail matching rejects another recipient and mail older than registration', () => {
  const since = new Date('2026-09-26T10:00:00Z');
  const message = { from: [{ address: 'noreply@example.com' }], to: [{ address: 'site@owner.test' }], date: new Date('2026-09-26T10:05:00Z') };
  assert.equal(isMatchingVerificationEnvelope(message, 'site@owner.test', 'example.com', since), true);
  assert.equal(isMatchingVerificationEnvelope(message, 'other@owner.test', 'example.com', since), false);
  assert.equal(isMatchingVerificationEnvelope({ ...message, date: new Date('2026-09-26T09:59:00Z') }, 'site@owner.test', 'example.com', since), false);
  assert.equal(isMatchingVerificationEnvelope({ ...message, from: [{ address: 'noreply@evil.test' }] }, 'site@owner.test', 'example.com', since), false);
});
