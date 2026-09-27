import { execFileSync } from 'node:child_process';
import { readFile,readdir,stat } from 'node:fs/promises';
import { resolve,relative,join } from 'node:path';
import { listPackage,extractFile } from '@electron/asar';
const mode=process.argv[2];
if(!['source','dist'].includes(mode))throw Error('Usage: privacy-scan.mjs source|dist');
const failures=[];let inspected=0;
const forbiddenPath=/(?:^|\/)(?:\.evidence|\.test-data|\.git|memory|界面设计稿|node_modules)(?:\/|$)|(?:^|\/)(?:AGENTS|MEMORY)\.md$|\.(?:sqlite(?:-(?:wal|shm))?|lfb|pem|p12|pfx|log)$/i;
const rules=[
 ['personal-mac-path',/\/Users\/[a-z0-9._-]+\//i],
 ['personal-windows-path',/[A-Z]:\\(?:\\)?Users\\(?:\\)?[a-z0-9._-]+\\/i],
 ['private-key',new RegExp('-----BEGIN '+ '(?:RSA |EC |OPENSSH )?PRIVATE KEY-----')],
 ['github-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
 ['service-token',/\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b/],
 ['cloud-access-key',/\bAKIA[0-9A-Z]{16}\b/]
];
let privateTerms=[];
if(process.env.LINKFLOW_PRIVACY_POLICY){const p=JSON.parse(await readFile(process.env.LINKFLOW_PRIVACY_POLICY,'utf8'));privateTerms=p.terms||[];}
function inspect(name,data){
 inspected++;
 if(forbiddenPath.test(name))failures.push({file:name,rule:'forbidden-file'});
 const text=Buffer.from(data).toString('utf8');
 for(const [rule,pattern]of rules)if(pattern.test(text))failures.push({file:name,rule});
 for(const term of privateTerms)if(term.length>=5&&text.includes(term))failures.push({file:name,rule:'private-policy-term'});
}
async function walk(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else if(e.isFile())out.push(p);}return out;}
if(mode==='source'){
 const tracked=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
 if(!tracked.length)throw Error('No staged/tracked publication files');
 const indexed=new Set(execFileSync('git',['ls-files','--cached','-z'],{encoding:'utf8'}).split('\0').filter(Boolean));
 for(const p of tracked){
  if(indexed.has(p))inspect(p,execFileSync('git',['show',':'+p],{maxBuffer:20*1024*1024}));
  let data;try{data=await readFile(p)}catch(error){if(error.code==='ENOENT')continue;throw error;}
  inspect(p,data);
 }
}else{
 for(const dir of ['dist','dist-electron'])for(const p of await walk(dir))inspect(relative(process.cwd(),p).replaceAll('\\','/'),await readFile(p));
 const resources=process.env.LINKFLOW_APP_RESOURCES;
 const asars=resources?[join(resources,'app.asar')]:(await walk('release')).filter(p=>p.endsWith('/app.asar')||p.endsWith('\\app.asar'));
 if(!asars.length)throw Error('No packaged app.asar to inspect');
 for(const path of asars){
  const entries=listPackage(path);
  const files=entries.filter(p=>{try{return extractFile(path,p.replace(/^[/\\]/,'')).length>=0}catch{return false}});
  if(!files.length)throw Error('Packaged application is empty');
  for(const entry of files){
   const name=entry.replace(/^[/\\]/,'').replaceAll('\\','/');
   if(!/^(?:dist\/|dist-electron\/|assets\/|package\.json$|THIRD_PARTY_NOTICES\.txt$)/.test(name))failures.push({file:name,rule:'outside-package-allowlist'});
   inspect(name,extractFile(path,entry.replace(/^[/\\]/,'')));
  }
 }
}
if(failures.length){console.error(JSON.stringify({passed:false,inspected,failures},null,2));process.exitCode=1}else console.log(JSON.stringify({passed:true,mode,inspected}));
