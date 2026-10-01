import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {chmod,mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
// The release publisher is a standalone Node module, deliberately outside the runtime bundle.
// @ts-expect-error JavaScript publisher has no declaration file.
import {parseUpdateSigningArguments,signUpdateManifest} from '../scripts/lib/update-manifest.mjs';
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

test('publisher signs a Windows-only release that the real updater parser accepts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'linkflow-sign-windows-test-'));
 try{
  const pair=generateKeyPairSync('ed25519'),publicKeyDer=pair.publicKey.export({format:'der',type:'spki'}),path=join(dir,'Linkflow-1.2.1-windows-x64-setup.exe');
  await writeFile(path,Buffer.alloc(23,7));
  const {manifest,signature}=await signUpdateManifest({version:'1.2.1',releaseNotes:'Windows 1.2.1',publishedAt:'2026-09-30T00:00:00.000Z',assets:{'win32-x64':path},privateKey:pair.privateKey,publicKeyDer});
  verifyManifestSignature(manifest,signature,publicKeyDer);
  const parsed=parseUpdateManifest(manifest);
  assert.equal(parsed.assets['win32-x64']?.size,23);
  assert.equal(parsed.assets['win32-x64']?.format,'nsis');
  assert.equal(parsed.assets['darwin-arm64'],undefined);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('platform selection defaults to both and accepts only explicit public platform names',()=>{
 assert.deepEqual(parseUpdateSigningArguments(['notes.md']),{notesPath:'notes.md',platforms:['darwin-arm64','win32-x64']});
 assert.deepEqual(parseUpdateSigningArguments(['notes.md','--platform','windows-x64']),{notesPath:'notes.md',platforms:['win32-x64']});
 assert.deepEqual(parseUpdateSigningArguments(['--platform','mac-arm64','notes.md']),{notesPath:'notes.md',platforms:['darwin-arm64']});
 assert.throws(()=>parseUpdateSigningArguments(['notes.md','--platform','win32-x64']),/Invalid/);
 assert.throws(()=>parseUpdateSigningArguments(['notes.md','--platform','windows-x64','--platform','windows-x64']),/duplicate/);
 assert.throws(()=>parseUpdateSigningArguments([]),/Usage/);
});

test('unnotarized signing selection is explicit, unique and requires a Mac asset',()=>{
 assert.deepEqual(parseUpdateSigningArguments(['notes.md','--allow-unnotarized-mac']),{notesPath:'notes.md',platforms:['darwin-arm64','win32-x64'],allowUnnotarizedMac:true});
 assert.throws(()=>parseUpdateSigningArguments(['notes.md','--allow-unnotarized-mac','--allow-unnotarized-mac']),/Duplicate/);
 assert.throws(()=>parseUpdateSigningArguments(['notes.md','--allow-unnotarized-mac','--platform','windows-x64']),/requires a Mac artifact/);
 assert.throws(()=>parseUpdateSigningArguments(['notes.md','--allow-unnotarized-mac=false']));
});

test('low-level signer rejects empty, unknown, missing, and misnamed platform artifacts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'linkflow-sign-invalid-test-'));
 try{
  const pair=generateKeyPairSync('ed25519'),publicKeyDer=pair.publicKey.export({format:'der',type:'spki'}),wrong=join(dir,'wrong.exe');
  await writeFile(wrong,'installer');
  const input={version:'1.2.1',releaseNotes:'release',publishedAt:'2026-09-30T00:00:00.000Z',privateKey:pair.privateKey,publicKeyDer};
  await assert.rejects(signUpdateManifest({...input,assets:{}}),/platform assets/);
  await assert.rejects(signUpdateManifest({...input,assets:{'linux-x64':wrong}}),/platform assets/);
  await assert.rejects(signUpdateManifest({...input,assets:{'win32-x64':undefined}}),/Missing or unexpected/);
  await assert.rejects(signUpdateManifest({...input,assets:{'win32-x64':wrong}}),/Missing or unexpected/);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('CLI Windows-only mode never reads a Mac artifact while default mode still fails closed without one',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'linkflow-sign-cli-test-'));
 try{
  const pair=generateKeyPairSync('ed25519'),publicKeyDer=pair.publicKey.export({format:'der',type:'spki'}),key=join(dir,'update-private.pem'),notes=join(dir,'notes.md'),release=join(dir,'release');
  await mkdir(join(dir,'src','shared'),{recursive:true});await mkdir(release);
  await writeFile(join(dir,'package.json'),JSON.stringify({version:'1.2.1'}));
  await writeFile(join(dir,'src','shared','update-trust.ts'),`export const UPDATE_PUBLIC_KEY_SPKI_BASE64="${publicKeyDer.toString('base64')}";\n`);
  await writeFile(key,pair.privateKey.export({format:'pem',type:'pkcs8'}));await chmod(key,0o600);
  await writeFile(notes,'Windows-only release');
  await writeFile(join(release,'Linkflow-1.2.1-windows-x64-setup.exe'),'reviewed installer');
  const script=resolve('scripts/sign-update.mjs'),env={...process.env,LINKFLOW_UPDATE_SIGNING_KEY:key};
  const windows=spawnSync(process.execPath,[script,notes,'--platform','windows-x64'],{cwd:dir,env,encoding:'utf8'});
  assert.equal(windows.status,0,windows.stderr);
  const manifest=await readFile(join(release,'linkflow-update.json')),signature=await readFile(join(release,'linkflow-update.json.sig'));
  verifyManifestSignature(manifest,signature,publicKeyDer);
  const parsed=parseUpdateManifest(manifest);assert(parsed.assets['win32-x64']);assert.equal(parsed.assets['darwin-arm64'],undefined);

  const second=await mkdtemp(join(tmpdir(),'linkflow-sign-cli-default-'));
  try{
   await mkdir(join(second,'src','shared'),{recursive:true});await mkdir(join(second,'release'));
   await writeFile(join(second,'package.json'),JSON.stringify({version:'1.2.1'}));
   await writeFile(join(second,'src','shared','update-trust.ts'),`export const UPDATE_PUBLIC_KEY_SPKI_BASE64="${publicKeyDer.toString('base64')}";\n`);
   await writeFile(join(second,'notes.md'),'Default release');
   await writeFile(join(second,'release','Linkflow-1.2.1-windows-x64-setup.exe'),'reviewed installer');
   const blocked=spawnSync(process.execPath,[script,join(second,'notes.md')],{cwd:second,env,encoding:'utf8'});
   assert.equal(blocked.status,1);assert.match(blocked.stderr,/Update signing failed/);assert(!blocked.stderr.includes(second));
  }finally{await rm(second,{recursive:true,force:true})}
 }finally{await rm(dir,{recursive:true,force:true})}
});
