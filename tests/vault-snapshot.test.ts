import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {Store} from '../src/main/store';
import type {Vault as VaultType} from '../src/main/vault';

// Exercise the production Vault in Node without unlocking or reading a real OS keychain.
const compiled=await build({entryPoints:['src/main/vault.ts'],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{
  name:'isolated-keychain',setup(builder){
    builder.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'test-keychain'}));
    builder.onLoad({filter:/.*/,namespace:'test-keychain'},()=>({contents:`export const safeStorage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=>"test-keychain",decryptString:bytes=>bytes.toString("utf8"),encryptString:value=>Buffer.from(value,"utf8")};`,loader:'js'}));
  },
}]});
const module={exports:{} as {Vault:new(store:Store)=>VaultType}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const {Vault}=module.exports;

test('portable backup secret snapshot cannot mix credentials from later database changes',async()=>{
  const store=new Store(':memory:');
  try{
    store.setCipher('first',Buffer.from('original-first').toString('base64'));
    store.setCipher('second',Buffer.from('original-second').toString('base64'));
    const vault=new Vault(store),pending=vault.exportSecrets();
    store.setCipher('second',Buffer.from('changed-second').toString('base64'));
    store.deleteCipher('first');
    assert.deepEqual(await pending,{first:'original-first',second:'original-second'});
    assert.deepEqual(await vault.exportSecrets(),{second:'changed-second'});
  }finally{store.close()}
});
