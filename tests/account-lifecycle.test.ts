import test from 'node:test';
import assert from 'node:assert/strict';
import { accountIssueForSignal, accountStateBlock, canRetryGeneratedUsername } from '../src/integrations/browser';
import { IPC_COMMANDS, type Account } from '../src/shared/types';

test('account failures map to durable states instead of creating replacement accounts',()=>{
  assert.equal(accountIssueForSignal('bad_password')?.status,'credentials_invalid');
  assert.equal(accountIssueForSignal('restricted')?.status,'restricted');
  assert.equal(accountIssueForSignal('email_exists')?.status,'unknown');
  assert.equal(accountIssueForSignal('registration_failed')?.status,'unknown');
  assert.equal(accountIssueForSignal('verification_required')?.status,'needs_verification');
});

test('only a generated, demonstrably uncreated draft gets one username retry',()=>{
  assert.equal(canRetryGeneratedUsername({status:'draft',source:'generated',registrationAttempts:1}),true);
  assert.equal(canRetryGeneratedUsername({status:'draft',source:'generated',registrationAttempts:2}),false);
  assert.equal(canRetryGeneratedUsername({status:'unknown',source:'imported',registrationAttempts:0}),false);
  assert.equal(canRetryGeneratedUsername({status:'restricted',source:'generated',registrationAttempts:0}),false);
});

test('account recovery IPC is exposed while account snapshots contain metadata only',()=>{
  assert.equal(IPC_COMMANDS.includes('account:retry'),true);
  const account:Account={id:'11111111-1111-4111-8111-111111111111',channelId:'channel',email:'owner@example.org',username:'owner',createdAt:'2026-09-01T00:00:00.000Z',status:'credentials_invalid',source:'imported',hasPassword:true,diagnostic:{code:'bad_password',message:'平台拒绝了已保存的登录凭据。',at:'2026-09-01T00:01:00.000Z',retryable:false}};
  assert.equal('password' in account,false);
  assert.equal('secret' in account,false);
});

test('blocked account states stop before any browser credential operation',()=>{
  assert.match(accountStateBlock({status:'restricted',source:'imported'})?.message??'',/限制/);
  assert.match(accountStateBlock({status:'credentials_invalid',source:'imported'})?.message??'',/更新密码/);
  assert.equal(accountStateBlock({status:'unknown',source:'imported'}),undefined);
  assert.equal(accountStateBlock({status:'registered',source:'imported'}),undefined);
});
