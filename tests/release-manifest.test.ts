import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
// The release publisher is a standalone Node module, deliberately outside the runtime bundle.
// @ts-expect-error JavaScript publisher has no declaration file.
import {signUpdateManifest} from '../scripts/lib/update-manifest.mjs';
import {parseUpdateManifest,verifyManifestSignature} from '../src/main/update-network';

test('publisher signs the exact two native artifacts and updater accepts the raw signed bytes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'linkflow-sign-test-'));
 try{
  const pair=generateKeyPairSync('ed25519'),publicKeyDer=pair.publicKey.export({format:'der',type:'spki'});
  const assets={'darwin-arm64':join(dir,'Linkflow-1.2.0-mac-arm64.zip'),'win32-x64':join(dir,'Linkflow-1.2.0-windows-x64-setup.exe')};
  await Promise.all(Object.values(assets).map((p,i)=>writeFile(p,Buffer.alloc(i+10,42))));
  const input={version:'1.2.0',releaseNotes:'更新中心\n保留用户资料',publishedAt:'2026-09-28T00:00:00.000Z',assets,privateKey:pair.privateKey,publicKeyDer};
  const {manifest,signature}=await signUpdateManifest(input);verifyManifestSignature(manifest,signature,publicKeyDer);
  const parsed=parseUpdateManifest(manifest);assert.equal(parsed.version,'1.2.0');assert.equal(parsed.assets['darwin-arm64']?.size,10);assert.equal(parsed.assets['win32-x64']?.size,11);
  assert.equal(verify(null,Buffer.concat([manifest,Buffer.from(' ')]),pair.publicKey,Buffer.from(signature.toString().trim(),'base64')),false);
  await assert.rejects(signUpdateManifest({...input,privateKey:generateKeyPairSync('ed25519').privateKey}),/does not match/);
  await assert.rejects(signUpdateManifest({...input,assets:{...assets,'win32-x64':assets['darwin-arm64']}}),/unexpected/);
  await assert.rejects(signUpdateManifest({...input,version:'1.2.0-beta'}),/metadata/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
