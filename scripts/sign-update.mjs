import {readFile,writeFile,rename,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {signUpdateManifest} from './lib/update-manifest.mjs';
import {validateMacReleaseArchive} from './lib/mac-signing.mjs';

async function main(){
 const keyPath=process.env.LINKFLOW_UPDATE_SIGNING_KEY,notesPath=process.argv[2];
 if(!keyPath||!notesPath)throw Error('Provide a private signing-key path in LINKFLOW_UPDATE_SIGNING_KEY and a release-notes file argument');
 const keyStat=await stat(keyPath);if(process.platform!=='win32'&&(keyStat.mode&0o077))throw Error('Signing key permissions must be private');
 const version=JSON.parse(await readFile('package.json','utf8')).version;
 const source=await readFile('src/shared/update-trust.ts','utf8'),match=source.match(/UPDATE_PUBLIC_KEY_SPKI_BASE64="([A-Za-z0-9+/=]+)"/);if(!match)throw Error('Embedded update verification key not found');
 const directory=resolve('release');
 const assets={'darwin-arm64':join(directory,`Linkflow-${version}-mac-arm64.zip`),'win32-x64':join(directory,`Linkflow-${version}-windows-x64-setup.exe`)};
 const validatedMacHash=await validateMacReleaseArchive({archivePath:assets['darwin-arm64'],expectedAppName:'外链助手.app'});
 const signed=await signUpdateManifest({version,releaseNotes:await readFile(notesPath,'utf8'),publishedAt:new Date().toISOString(),assets,privateKey:await readFile(keyPath),publicKeyDer:Buffer.from(match[1],'base64')});
 if(JSON.parse(signed.manifest).assets['darwin-arm64'].sha256!==validatedMacHash)throw Error('Mac release archive changed after native validation');
 for(const [name,data] of [['linkflow-update.json',signed.manifest],['linkflow-update.json.sig',signed.signature]]){const tmp=join(directory,name+'.tmp');await writeFile(tmp,data,{flag:'wx',mode:0o600});await rename(tmp,join(directory,name))}
 console.log('Signed update metadata created and independently verified for '+version+' (2 platform assets).');
}
main().catch(()=>{console.error('Update signing failed. Verify the private key, notes, and exact release artifacts locally; no input data is logged.');process.exitCode=1});
