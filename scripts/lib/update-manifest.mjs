import {createHash,createPublicKey,sign,verify} from 'node:crypto';
import {open} from 'node:fs/promises';
import {basename} from 'node:path';

const repo='https://github.com/xiaogan123/linkflow-desktop/releases/download';
const platformSpecs=[
 ['darwin-arm64','mac-arm64.zip','zip'],
 ['win32-x64','windows-x64-setup.exe','nsis']
];
const cliPlatforms=new Map([['mac-arm64','darwin-arm64'],['windows-x64','win32-x64']]);

export function parseUpdateSigningArguments(args){
 let notesPath;const selected=[];
 for(let index=0;index<args.length;index++){
  const value=args[index];
  if(value==='--platform'){
   const name=args[++index],platform=cliPlatforms.get(name);
   if(!platform||selected.includes(platform))throw Error('Invalid or duplicate update platform selection');
   selected.push(platform);continue;
  }
  if(value.startsWith('-')||notesPath)throw Error('Usage: sign-update <release-notes> [--platform <windows-x64|mac-arm64>]');
  notesPath=value;
 }
 if(!notesPath)throw Error('Usage: sign-update <release-notes> [--platform <windows-x64|mac-arm64>]');
 return {notesPath,platforms:selected.length?selected:platformSpecs.map(([platform])=>platform)};
}

export async function signUpdateManifest({version,releaseNotes,publishedAt,assets,privateKey,publicKeyDer}){
 if(!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)||typeof releaseNotes!=='string'||releaseNotes.length>50000||!Number.isFinite(Date.parse(publishedAt)))throw Error('Invalid update metadata');
 if(!assets||typeof assets!=='object'||Array.isArray(assets))throw Error('Invalid update platform assets');
 const selected=Object.keys(assets);
 if(selected.length<1||selected.some(platform=>!platformSpecs.some(([known])=>known===platform)))throw Error('Invalid update platform assets');
 const publicKey=createPublicKey({key:publicKeyDer,format:'der',type:'spki'});
 if(publicKey.asymmetricKeyType!=='ed25519'||!createPublicKey(privateKey).export({format:'der',type:'spki'}).equals(publicKeyDer))throw Error('Signing key does not match the embedded update public key');
 const result={};
 for(const [platform,suffix,format] of platformSpecs.filter(([platform])=>selected.includes(platform))){
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
