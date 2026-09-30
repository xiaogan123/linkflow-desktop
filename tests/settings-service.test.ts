import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {saveSettingsAtomic} from '../src/main/settings-service';

const encrypt=(secrets:Record<string,string>)=>Object.fromEntries(Object.entries(secrets).map(([key,value])=>[key,'cipher:'+value]));

test('settings transaction rollback preserves the previous destination and secret',()=>{
  const store=new Store(':memory:');
  try{
    store.update(state=>{state.settings.provider='api';state.settings.apiBase='https://old.example/v1';state.settings.hasApiKey=true});
    store.setCipher('apiKey','cipher:old-key');
    (store as unknown as {db:{exec(sql:string):void}}).db.exec("CREATE TRIGGER reject_state_write BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT,'synthetic state commit failure'); END;");
    assert.throws(()=>saveSettingsAtomic(store,{encryptSecrets:encrypt},{apiBase:'https://new.example/v1',apiKey:'new-key'}),/synthetic state commit failure/);
    assert.equal(store.read().settings.apiBase,'https://old.example/v1');
    assert.equal(store.read().settings.hasApiKey,true);
    assert.equal(store.getCipher('apiKey'),'cipher:old-key');
  }finally{store.close()}
});

test('a later secret encryption failure leaves settings and every secret unchanged',()=>{
  const store=new Store(':memory:');
  try{
    store.update(state=>{state.settings.provider='api';state.settings.apiBase='https://old.example/v1';state.settings.hasApiKey=true;state.settings.mail={host:'imap.old.example',port:993,user:'old@example.com',secure:true,hasPassword:true}});
    store.setCipher('apiKey','cipher:old-key');store.setCipher('mailPassword','cipher:old-password');
    const before=store.read(),beforeCiphers=store.allCiphers();
    const failOnSecond=(secrets:Record<string,string>)=>{let count=0;return Object.fromEntries(Object.entries(secrets).map(([key,value])=>{if(++count===2)throw Error('synthetic second encryption failure');return [key,'cipher:'+value]}))};
    assert.throws(()=>saveSettingsAtomic(store,{encryptSecrets:failOnSecond},{apiBase:'https://new.example/v1',apiKey:'new-key',mail:{host:'imap.new.example',port:993,user:'new@example.com',secure:true},mailPassword:'new-password'}),/second encryption failure/);
    assert.deepEqual(store.read(),before);assert.deepEqual(store.allCiphers(),beforeCiphers);
  }finally{store.close()}
});

test('a changed-destination secret deletion failure rolls back earlier deletes and settings',()=>{
  const store=new Store(':memory:');
  try{
    store.update(state=>{state.settings.provider='api';state.settings.apiBase='https://old.example/v1';state.settings.hasApiKey=true;state.settings.mail={host:'imap.old.example',port:993,user:'old@example.com',secure:true,hasPassword:true}});
    store.setCipher('apiKey','cipher:old-key');store.setCipher('mailPassword','cipher:old-password');
    const before=store.read(),beforeCiphers=store.allCiphers();
    (store as unknown as {db:{exec(sql:string):void}}).db.exec("CREATE TRIGGER reject_mail_secret_delete BEFORE DELETE ON secrets WHEN OLD.key='mailPassword' BEGIN SELECT RAISE(ABORT,'synthetic secret delete failure'); END;");
    assert.throws(()=>saveSettingsAtomic(store,{encryptSecrets:encrypt},{apiBase:'https://new.example/v1',mail:{host:'imap.new.example',port:993,user:'new@example.com',secure:true}}),/secret delete failure/);
    assert.deepEqual(store.read(),before);
    assert.deepEqual(store.allCiphers(),beforeCiphers);
  }finally{store.close()}
});

test('changing a destination without a replacement removes its secret in the same transaction',()=>{
  const store=new Store(':memory:');
  try{
    store.update(state=>{state.settings.provider='api';state.settings.apiBase='https://old.example/v1';state.settings.hasApiKey=true});
    store.setCipher('apiKey','cipher:old-key');
    saveSettingsAtomic(store,{encryptSecrets:encrypt},{apiBase:'https://new.example/v1'});
    assert.equal(store.read().settings.apiBase,'https://new.example/v1');
    assert.equal(store.read().settings.hasApiKey,false);
    assert.equal(store.getCipher('apiKey'),undefined);
  }finally{store.close()}
});
