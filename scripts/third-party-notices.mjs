import { readFile,readdir,writeFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
const parts=['THIRD-PARTY NOTICES\nGenerated from the locked runtime dependencies. Electron and Chromium licenses are distributed separately with the runtime.\n'];
for(const [path,info]of Object.entries(lock.packages).sort(([a],[b])=>a.localeCompare(b))){
 if(!path||info.dev||info.optional&&info.os&&!info.os.includes(process.platform))continue;
 let manifest,files;
 try{manifest=JSON.parse(await readFile(join(path,'package.json'),'utf8'));files=await readdir(path);}catch{continue;}
 parts.push('\n=== '+manifest.name+' '+manifest.version+' ===\nDeclared license: '+(typeof manifest.license==='string'?manifest.license:'See package license')+'\n');
 for(const name of files.filter(x=>/^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(x))){
  try{parts.push(await readFile(join(path,name),'utf8'));}catch{}
 }
}
await mkdir('assets',{recursive:true});await writeFile('assets/THIRD_PARTY_NOTICES.txt',parts.join('\n'));
console.log('Runtime dependency notices generated');
