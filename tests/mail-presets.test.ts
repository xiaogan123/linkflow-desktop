import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAIL_PRESET_ID, MAIL_PRESETS, getMailPreset, inferMailPreset } from '../src/shared/mail-presets';
import {mailboxAutomationReadiness,mailboxAutomationReady} from '../src/shared/mail-automation';

test('Gmail is the default password-based TLS preset', () => {
  const gmail = getMailPreset(DEFAULT_MAIL_PRESET_ID);
  assert.equal(gmail.id, 'gmail');
  assert.deepEqual({ host: gmail.host, port: gmail.port, secure: gmail.secure, support: gmail.support }, {
    host: 'imap.gmail.com', port: 993, secure: true, support: 'password',
  });
});

test('recognizes supported provider addresses and server hosts', () => {
  assert.equal(inferMailPreset({ email: 'person@gmail.com' })?.id, 'gmail');
  assert.equal(inferMailPreset({ email: 'person@foxmail.com' })?.id, 'qq');
  assert.equal(inferMailPreset({ email: 'person@163.com' })?.id, 'netease-163');
  assert.equal(inferMailPreset({ email: 'person@icloud.com' })?.id, 'icloud');
  assert.equal(inferMailPreset({ host: 'IMAP.MAIL.YAHOO.COM.' })?.id, 'yahoo');
});

test('does not infer a provider for custom addresses or custom servers', () => {
  assert.equal(inferMailPreset({ email: 'admin@example.com' }), undefined);
  assert.equal(inferMailPreset({ email: 'person@yeah.net' }), undefined);
  assert.equal(inferMailPreset({ email: 'person@yahoo.co.jp' }), undefined);
  assert.equal(inferMailPreset({ host: 'imap.example.com' }), undefined);
  assert.equal(inferMailPreset({ email: 'person@gmail.com', host: 'imap.example.com' }), undefined);
});

test('marks Outlook.com as unavailable to the current password-only client', () => {
  const outlook = inferMailPreset({ email: 'person@outlook.com' });
  assert.equal(outlook?.support, 'oauth-required');
  assert.match(outlook?.hint ?? '', /需要浏览器登录授权/);
});

test('preset readiness distinguishes automatic Gmail from per-message confirmation',()=>{
  for(const preset of MAIL_PRESETS){
    const ready={host:preset.host,hasPassword:true,verifiedAt:'2026-10-18T00:00:00.000Z'};
    const level=preset.id==='gmail'?'automatic':preset.id==='outlook'?'unavailable':'confirmation_required';
    assert.equal(preset.automationLevel,level);
    assert.deepEqual(mailboxAutomationReadiness(ready),{ready:preset.id!=='outlook',level});
    assert.equal(mailboxAutomationReady(ready),preset.id!=='outlook');
  }
  const custom={host:'imap.example.com',hasPassword:true,verifiedAt:'2026-10-18T00:00:00.000Z'};
  assert.deepEqual(mailboxAutomationReadiness(custom),{ready:true,level:'confirmation_required'});
  for(const value of [undefined,{...custom,hasPassword:false},{...custom,verifiedAt:undefined},{...custom,lastError:'fixture connection error'}]){
    assert.deepEqual(mailboxAutomationReadiness(value),{ready:false,level:'unavailable'});
    assert.equal(mailboxAutomationReady(value),false);
  }
});
