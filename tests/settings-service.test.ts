import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {enableStoppedChannelTrial,saveSettingsAtomic} from '../src/main/settings-service';
import {CHANNELS} from '../src/integrations/catalog';
import {IPC_COMMANDS} from '../src/shared/types';
import {SettingsPatch} from '../src/main/validation';

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

test('Ahrefs replacement is encrypted atomically and never stored in public settings',()=>{
  const store=new Store(':memory:');
  try{
    saveSettingsAtomic(store,{encryptSecrets:encrypt},{ahrefsApiKey:'synthetic-ahrefs-key'});
    assert.equal(store.getCipher('ahrefsApiKey'),'cipher:synthetic-ahrefs-key');
    assert.equal(store.read().settings.hasAhrefsKey,true);
    assert.equal(JSON.stringify(store.read()).includes('synthetic-ahrefs-key'),false);
    store.update(state=>{state.settings.ahrefsStatus='connected';state.settings.ahrefsLastUpdatedAt='2026-10-18T00:00:00.000Z';state.settings.ahrefsLastRefreshMonth='2026-10'});
    saveSettingsAtomic(store,{encryptSecrets:encrypt},{ahrefsApiKey:'synthetic-replacement'});
    assert.equal(store.read().settings.ahrefsStatus,undefined);
    assert.equal(store.read().settings.ahrefsLastUpdatedAt,undefined);
    assert.equal(store.read().settings.ahrefsLastRefreshMonth,undefined);
  }finally{store.close()}
});

test('Ahrefs encryption failure retains the previous key, status and refresh marker',()=>{
  const store=new Store(':memory:');
  try{
    store.setCipher('ahrefsApiKey','cipher:previous');
    store.update(state=>{state.settings.hasAhrefsKey=true;state.settings.ahrefsStatus='connected';state.settings.ahrefsLastRefreshMonth='2026-10'});
    const before=store.read();
    assert.throws(()=>saveSettingsAtomic(store,{encryptSecrets:()=>{throw Error('synthetic vault failure')}},{ahrefsApiKey:'synthetic-replacement'}),/vault failure/);
    assert.deepEqual(store.read(),before);
    assert.equal(store.getCipher('ahrefsApiKey'),'cipher:previous');
  }finally{store.close()}
});

test('generic settings writes cannot forge Ahrefs connection status or erase an existing key',()=>{
  const store=new Store(':memory:');
  try{
    saveSettingsAtomic(store,{encryptSecrets:encrypt},{hasAhrefsKey:true,ahrefsStatus:'connected',ahrefsLastUpdatedAt:'2026-10-18T00:00:00.000Z',ahrefsLastRefreshMonth:'2026-10'});
    assert.ok(!store.read().settings.hasAhrefsKey);
    assert.equal(store.read().settings.ahrefsStatus,undefined);
    assert.equal(store.read().settings.ahrefsLastRefreshMonth,undefined);
    saveSettingsAtomic(store,{encryptSecrets:encrypt},{ahrefsApiKey:'synthetic-ahrefs-key'});
    saveSettingsAtomic(store,{encryptSecrets:encrypt},{ahrefsApiKey:'',hasAhrefsKey:false});
    assert.equal(store.read().settings.hasAhrefsKey,true);
    assert.equal(store.getCipher('ahrefsApiKey'),'cipher:synthetic-ahrefs-key');
  }finally{store.close()}
});

test('stale settings snapshot cannot undo an automatic platform stop; explicit enable clears the stop',()=>{
  const store=new Store(':memory:');
  try{
    store.update(state=>{state.settings.channelOverrides={rant:true,yeetmd:false}});
    const oldSnapshot=structuredClone(store.read().settings);
    store.update(state=>{
      state.settings.channelOverrides.rant=false;
      state.settings.channelTrials={rant:{trial:true,failures:2,evaluatedTaskIds:[],disabledAt:'2026-10-18T00:00:00.000Z',reason:'two definite failures',autoDisabledOverride:true}};
    });
    saveSettingsAtomic(store,{encryptSecrets:encrypt},SettingsPatch.parse({...oldSnapshot,channelOverrides:{...oldSnapshot.channelOverrides,yeetmd:true}}));
    assert.deepEqual(store.read().settings.channelOverrides,{rant:false,yeetmd:false});
    assert.equal(store.read().settings.channelTrials?.rant?.disabledAt,'2026-10-18T00:00:00.000Z');
    assert.ok(IPC_COMMANDS.includes('channel:enable-trial'));
    enableStoppedChannelTrial(store,'rant',CHANNELS);
    const restored=store.read();
    assert.equal(restored.settings.channelOverrides.rant,true);
    assert.equal(restored.settings.channelTrials?.rant?.disabledAt,undefined);
    assert.equal(restored.settings.channelTrials?.rant?.failures,0);
    assert.equal(restored.settings.channelTrials?.rant?.reason,undefined);
    assert.equal(restored.settings.channelOverrides.yeetmd,false);
    assert.throws(()=>enableStoppedChannelTrial(store,'rant',CHANNELS),/没有待恢复/);
    assert.throws(()=>enableStoppedChannelTrial(store,'missing-platform',CHANNELS),/不存在/);
  }finally{store.close()}
});
