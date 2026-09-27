import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptBackup,decryptBackup } from '../src/main/backup';
import { validateBackup } from '../src/main/backup-validation';
import { emptyState } from '../src/main/store';
import { AddSite, SettingsPatch, normalizeDomain, safeMessage } from '../src/main/validation';
test('authenticated backup roundtrips all state without exposing passwords',()=>{const data={state:emptyState(),secrets:{apiKey:'test-private-secret'}};const encrypted=encryptBackup(data,'correct horse battery staple');assert(!encrypted.toString().includes('test-private-secret'));assert.deepEqual(validateBackup(decryptBackup(encrypted,'correct horse battery staple')),data)});
test('wrong password and tampered backup fail closed',()=>{const b=encryptBackup({state:emptyState(),secrets:{}},'long-passphrase-123');assert.throws(()=>decryptBackup(b,'wrong-passphrase'));const payload=JSON.parse(b.toString());payload.tag=Buffer.alloc(16).toString('base64');assert.throws(()=>decryptBackup(Buffer.from(JSON.stringify(payload)),'long-passphrase-123'))});
test('short backup passphrase and untrusted data structure are rejected',()=>{assert.throws(()=>encryptBackup({},'short'));assert.throws(()=>validateBackup({state:{},secrets:{}}));assert.throws(()=>validateBackup({state:emptyState(),secrets:{'../other':'bad'}}))});
test('site input validates actual public domain and reasonable monthly workload',()=>{assert.deepEqual(normalizeDomain('www.Example.com'),{domain:'example.com',url:'https://example.com'});for(const input of ['localhost','127.0.0.1','https://user:password@example.com','example.com/path','https://example.com:22','https://[::1]'])assert.throws(()=>normalizeDomain(input));assert.throws(()=>AddSite.parse({domain:'example.com',email:'invalid',monthlyTarget:2}));assert.throws(()=>AddSite.parse({domain:'example.com',email:'hi@example.com',monthlyTarget:999}))});
test('invalid timezones and insecure mail settings rejected',()=>{assert.throws(()=>SettingsPatch.parse({timezone:'Bad/Zone'}));assert.throws(()=>SettingsPatch.parse({mail:{host:'x.com',port:143,user:'a',secure:false}}))});
test('error redaction removes likely credentials and URL query tokens',()=>{const msg=safeMessage(new Error('password=hunter2 token=private sk-secret12 https://x.com/verify?token=private'));assert(!msg.includes('hunter2'));assert(!msg.includes('private'));assert(!msg.includes('sk-secret12'))});
test('restored settings reject plaintext secrets',()=>{const state=emptyState();Object.assign(state.settings,{apiKey:'must-not-persist'});assert.throws(()=>validateBackup({state,secrets:{}}))});

test('legacy saved accounts restore conservatively without exposing their password',()=>{
  const state=emptyState();
  const id='11111111-1111-4111-8111-111111111111',createdAt='2026-09-01T00:00:00.000Z';
  state.accounts.push({id,channelId:'channel',email:'owner@example.org',username:'owner',createdAt,status:'unknown',hasPassword:true});
  const legacy=structuredClone(state) as unknown as {accounts:Array<Record<string,unknown>>};legacy.accounts[0].status='saved';
  const restored=validateBackup({state:legacy,secrets:{[`account:${id}`]:'encrypted-at-export-layer'}});
  assert.equal(restored.state.accounts[0].status,'unknown');
  assert.equal(restored.state.accounts[0].source,'imported');
  assert.equal(restored.state.accounts[0].diagnostic?.code,'legacy_saved');
  assert.equal('password' in restored.state.accounts[0],false);
  assert.equal(JSON.stringify(restored.state).includes('encrypted-at-export-layer'),false);
});
