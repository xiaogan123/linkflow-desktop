import {createHash,createPublicKey,sign,verify} from 'node:crypto';
import {open} from 'node:fs/promises';
import {basename} from 'node:path';

const repo='https://github.com/xiaogan123/linkflow-desktop/releases/download';
export async function signUpdateManifest({version,releaseNotes,publishedAt,assets,privateKey,publicKeyDer}){
 if(!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)||typeof releaseNotes!=='string'||releaseNotes.length>50000||!Number.isFinite(Date.parse(publishedAt)))throw Error('Invalid update metadata');
 const publicKey=createPublicKey({key:publicKeyDer,format:'der',type:'spki'});
 if(publicKey.asymmetricKeyType!=='ed25519'||!createPublicKey(privateKey).export({format:'der',type:'spki'}).equals(publicKeyDer))throw Error('Signing key does not match the embedded update public key');
 const result={};
 for(const [platform,suffix,format] of [['darwin-arm64','mac-arm64.zip','zip'],['win32-x64','windows-x64-setup.exe','nsis']]){
  const path=assets[platform],name=`Linkflow-${version}-${suffix}`;
  if(typeof path!=='string'||basename(path)!==name)throw Error('Missing or unexpected platform artifact');
  const file=await open(path,'r');let size,sha256;
  try{const before=await file.stat();if(!before.isFile()||before.size<1||before.size>1024*1024*1024)throw Error('Invalid platform artifact size');
   const hash=createHash('sha256');for await(const chunk of file.createReadStream({autoClose:false}))hash.update(chunk);
   const after=await file.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('Artifact changed while signing');
   size=before.size;sha256=hash.digest('hex');
  }finally{await file.close()}
  result[platform]={url:`${repo}/v${version}/${name}`,size,sha256,format};
 }
 const manifest=Buffer.from(JSON.stringify({schemaVersion:1,version,publishedAt,releaseNotes,assets:result},null,2)+'\n');
 const signature=sign(null,manifest,privateKey);
 if(!verify(null,manifest,publicKey,signature))throw Error('Update signature verification failed');
 return {manifest,signature:Buffer.from(signature.toString('base64')+'\n')};
}
