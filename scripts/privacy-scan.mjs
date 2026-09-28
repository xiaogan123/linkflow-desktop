import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,readdir,realpath,readlink,writeFile,lstat} from 'node:fs/promises';
import {resolve,relative,join,extname} from 'node:path';
import {listPackage,extractFile,statFile} from '@electron/asar';

async function main(){
const mode=process.argv[2];
const manifest=createHash('sha256');
if(!['source','dist'].includes(mode))throw Error('Usage: privacy-scan.mjs source|dist');
const findings=[];let inspected=0,historyBlobs=0,archives=0;
const forbiddenPath=/(?:^|\/)(?:\.evidence|\.test-data|\.git|memory|界面设计稿|node_modules|user[- ]?data|session[- ]?logs|automatic-backups)(?:\/|$)|(?:^|\/)(?:AGENTS|MEMORY|auth)\.(?:md|json)$|\.(?:sqlite(?:-(?:wal|shm))?|db|lfb|lfa|pem|p12|pfx|log)$/i;
const rules=[
 ['personal-mac-path',/\/Users\/(?!runner\/)[a-z0-9._-]+\//i],
 ['personal-windows-path',/[A-Z]:\\(?:\\)?Users\\(?:\\)?(?!runneradmin\\)[a-z0-9._-]+\\/i],
 ['private-key',new RegExp('-----BEGIN '+'(?:RSA |EC |OPENSSH )?PRIVATE KEY-----')],
 ['github-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
 ['service-token',/\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b/],
 ['cloud-access-key',/\bAKIA[0-9A-Z]{16}\b/],
];
let privateTerms=[];
if(process.env.LINKFLOW_PRIVACY_POLICY){
 let p;try{p=JSON.parse(await readFile(process.env.LINKFLOW_PRIVACY_POLICY,'utf8'))}catch{throw Error('Invalid private privacy policy')}
 if(!Array.isArray(p.terms)||p.terms.some(x=>typeof x!=='string'||x.trim().length<5))throw Error('Invalid private privacy policy');
 privateTerms=[...new Set(p.terms.map(x=>x.toLowerCase()))];
}
if(process.env.LINKFLOW_REQUIRE_PRIVATE_POLICY==='1'&&!privateTerms.length)throw Error('A nonempty private policy is required for the local release gate');
function fail(file,rule){findings.push({file,rule})}
function scanText(name,text){
 for(const [rule,pattern]of rules)if(pattern.test(text))fail(name,rule);
 const lower=text.toLowerCase();
 if(privateTerms.some(term=>lower.includes(term)))fail(name,'private-policy-term');
}
function inspect(name,input){
 inspected++;name=name.replaceAll('\\','/');
 if(forbiddenPath.test(name))fail(name,'forbidden-file');
 scanText(name,name);
 const data=Buffer.from(input);
 manifest.update(JSON.stringify([name,data.length,createHash('sha256').update(data).digest('hex')]));
 if(data.subarray(0,16).equals(Buffer.from('SQLite format 3\0')))fail(name,'database-magic');
 if(data.subarray(0,23).toString().startsWith('LINKFLOW-LOCAL-BACKUP-1'))fail(name,'private-backup-magic');
 scanText(name,data.toString('utf8'));
 // UTF-16 strings occur in Windows executables and encoded text files.
 for(const offset of [0,1]){
  const length=data.length-offset;if(length<2)continue;
  const slice=data.subarray(offset,offset+length-length%2);
  scanText(name,slice.toString('utf16le'));
  const swapped=Buffer.from(slice);swapped.swap16();scanText(name,swapped.toString('utf16le'));
 }
}
async function walk(root){
 const output=[],base=await realpath(root);
 async function visit(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
  const path=join(dir,entry.name);
  if(entry.isDirectory())await visit(path);
  else if(entry.isFile())output.push(path);
  else if(entry.isSymbolicLink()){
   const target=await realpath(path).catch(()=>null);
   if(!target||relative(base,target).startsWith('..')||relative(base,target).startsWith('/'))fail(relative(process.cwd(),path),'external-or-broken-symlink');
   inspect(relative(process.cwd(),path),await readlink(path));
  }
 }}
 await visit(root);return output;
}
const git=(args)=>execFileSync('git',args,{stdio:['ignore','pipe','pipe'],encoding:'utf8',maxBuffer:80*1024*1024});
if(mode==='source'){
 const tracked=git(['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean);
 if(!tracked.length)throw Error('No publication files');
 const indexed=new Set(git(['ls-files','--cached','-z']).split('\0').filter(Boolean));
 for(const path of tracked){
  if(indexed.has(path))inspect('index/'+path,execFileSync('git',['show',':'+path],{stdio:['ignore','pipe','pipe'],maxBuffer:80*1024*1024}));
  try{
   const info=await lstat(path);
   if(info.isSymbolicLink()){
    const target=await realpath(path).catch(()=>null),base=await realpath('.');
    if(!target||relative(base,target).startsWith('..')||relative(base,target).startsWith('/'))fail('worktree/'+path,'external-or-broken-symlink');
    inspect('worktree/'+path,await readlink(path));
   }else inspect('worktree/'+path,await readFile(path));
  }catch(e){if(e.code!=='ENOENT')throw e}

 }
 const seen=new Set();
 for(const sha of git(['rev-list','--all']).trim().split('\n').filter(Boolean)){
  inspect('commit/'+sha,git(['cat-file','commit',sha]));
  for(const entry of git(['ls-tree','-r','-z',sha]).split('\0').filter(Boolean)){
   const split=entry.indexOf('\t'),meta=entry.slice(0,split).split(' '),path=entry.slice(split+1);
   if(meta[1]!=='blob')continue;
   scanText('history/'+sha+'/'+path,path);
   if(forbiddenPath.test(path))fail('history/'+sha+'/'+path,'forbidden-file');
   if(seen.has(meta[2]))continue;seen.add(meta[2]);historyBlobs++;
   inspect('history/'+sha+'/'+path,execFileSync('git',['cat-file','blob',meta[2]],{stdio:['ignore','pipe','pipe'],maxBuffer:80*1024*1024}));
  }
 }
}else{
 for(const dir of ['dist','dist-electron'])for(const path of await walk(dir))inspect(relative(process.cwd(),path),await readFile(path));
 const root=process.env.LINKFLOW_APP_RESOURCES||'release';
 const paths=await walk(root);const asars=paths.filter(path=>extname(path)==='.asar');
 if(!asars.length)throw Error('No packaged app.asar to inspect');
 // Scan outer resources too; scanning an ASAR alone misses accidentally shipped databases.
 for(const path of paths){if(extname(path)==='.asar')continue;inspect(relative(resolve(root),path),await readFile(path))}
 for(const path of asars){
  const entries=listPackage(path);let files=0;archives++;
  for(const entry of entries){
   // ASAR's lookup uses native path separators, including nested directories.
   const internalPath=entry.replace(/^[/\\]/,'');
   const name=internalPath.replaceAll('\\','/');let data;
   const info=statFile(path,internalPath,false);
   if('files' in info)continue;
   if('link' in info){fail(name,'unexpected-asar-link');continue}
   try{data=extractFile(path,internalPath)}catch{fail(name,'unreadable-asar-file');continue}files++;
   if(!/^(?:dist\/|dist-electron\/|assets\/|package\.json$|THIRD_PARTY_NOTICES\.txt$)/.test(name))fail(name,'outside-package-allowlist');
   inspect(name,data);
  }
  if(!files)throw Error('Packaged application is empty');
 }
}
const unique=[...new Map(findings.map(f=>[f.file+'\0'+f.rule,f])).values()];
const result={passed:!unique.length,mode,inspected,historyBlobs,archives,contentManifestSha256:manifest.digest('hex'),privatePolicy:privateTerms.length>0,failures:unique.map(f=>({fileId:createHash('sha256').update(f.file).digest('hex').slice(0,16),rule:f.rule}))};
// Detailed filenames only go to a caller-selected private file, never to public CI logs.
if(process.env.LINKFLOW_PRIVACY_REPORT)await writeFile(process.env.LINKFLOW_PRIVACY_REPORT,JSON.stringify({...result,details:unique},null,2),{mode:0o600});
if(unique.length){console.error(JSON.stringify(result,null,2));process.exitCode=1}else console.log(JSON.stringify(result));

}
main().catch(()=>{console.error('Privacy scan incomplete: input, private policy, or packaged files could not be validated. A nonempty private policy is required for the local release gate.');process.exitCode=1});
