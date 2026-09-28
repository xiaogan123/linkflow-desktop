import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {compareVersions,fetchWithPinnedRedirects,parseUpdateManifest,verifyManifestSignature} from '../src/main/update-network';

function manifest(version='1.2.0'){
 return {schemaVersion:1,version,publishedAt:'2026-09-28T00:00:00.000Z',releaseNotes:'可验证的更新说明',assets:{'darwin-arm64':{url:`https://github.com/xiaogan123/linkflow-desktop/releases/download/v${version}/Linkflow-${version}-mac-arm64.zip`,size:123,sha256:'a'.repeat(64),format:'zip'},'win32-x64':{url:`https://github.com/xiaogan123/linkflow-desktop/releases/download/v${version}/Linkflow-${version}-windows-x64-setup.exe`,size:456,sha256:'b'.repeat(64),format:'nsis'}}};
}

test('signed manifest accepts only the pinned schema and exact raw bytes',()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),bytes=Buffer.from(JSON.stringify(manifest())),signature=Buffer.from(sign(null,bytes,privateKey).toString('base64')+'\n');
 verifyManifestSignature(bytes,signature,publicKey);assert.equal(parseUpdateManifest(bytes).assets['win32-x64']?.format,'nsis');
 assert.throws(()=>verifyManifestSignature(Buffer.concat([bytes,Buffer.from(' ')]),signature,publicKey),/签名验证失败/);
 assert.throws(()=>parseUpdateManifest(Buffer.from(JSON.stringify({...manifest(),unexpected:true}))),/格式无效/);
 assert.throws(()=>parseUpdateManifest(Buffer.from(JSON.stringify({...manifest(),assets:{'darwin-arm64':{...manifest().assets['darwin-arm64'],url:'https://example.com/app.zip'}}}))),/不可信|不属于/);
});

test('manifest verification accepts the committed DER-SPKI public-key representation',()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),bytes=Buffer.from(JSON.stringify(manifest())),signature=Buffer.from(sign(null,bytes,privateKey).toString('base64')+'\n'),der=publicKey.export({format:'der',type:'spki'});
 verifyManifestSignature(bytes,signature,der);
});

test('redirects stay on HTTPS allowlisted release hosts and are bounded',async()=>{
 let calls=0;const ok=(async()=>{calls++;return calls===1?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/download'}}):new Response('ok')}) as typeof fetch;
 assert.equal(await (await fetchWithPinnedRedirects('https://github.com/xiaogan123/linkflow-desktop/releases/latest/download/a', {request:ok})).text(),'ok');
 const bad=(async()=>new Response(null,{status:302,headers:{location:'https://attacker.invalid/a'}})) as typeof fetch;
 await assert.rejects(fetchWithPinnedRedirects('https://github.com/xiaogan123/linkflow-desktop/releases/latest/download/a',{request:bad}),/不可信/);
});

test('semantic versions compare numerically and reject non-final versions',()=>{
 assert.equal(compareVersions('1.10.0','1.9.9'),1);assert.equal(compareVersions('1.0.0','1.0.0'),0);assert.equal(compareVersions('1.0.0','2.0.0'),-1);assert.throws(()=>compareVersions('1.0.0-beta','1.0.0'));
});
