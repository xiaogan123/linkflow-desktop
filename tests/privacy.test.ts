import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync,mkdirSync,symlinkSync } from 'node:fs';
import {createPackage} from '@electron/asar';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync,execFileSync } from 'node:child_process';
const scanner=resolve('scripts/privacy-scan.mjs');
function fixture(){const dir=mkdtempSync(join(tmpdir(),'linkflow-privacy-'));execFileSync('git',['init','-q'],{cwd:dir});return dir;}
function stage(dir:string,body:string){writeFileSync(join(dir,'source.txt'),body);execFileSync('git',['add','source.txt'],{cwd:dir});}
test('publication scan rejects a private path from the staged content even when working tree is clean',()=>{
 const dir=fixture();try{
  stage(dir,['','Users','synthetic-account','private'].join('/'));
  writeFileSync(join(dir,'source.txt'),'clean working copy');
  const run=spawnSync(process.execPath,[scanner,'source'],{cwd:dir,encoding:'utf8',env:{...process.env,LINKFLOW_PRIVACY_POLICY:''}});
  assert.equal(run.status,1);assert.match(run.stderr,/personal-mac-path/);assert(!run.stderr.includes('synthetic-account'));
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('publication scan accepts public example addresses and emits only a summary',()=>{
 const dir=fixture();try{
  stage(dir,'https://example.com hello@example.com');
  const run=spawnSync(process.execPath,[scanner,'source'],{cwd:dir,encoding:'utf8',env:{...process.env,LINKFLOW_PRIVACY_POLICY:''}});
  assert.equal(run.status,0);assert.equal(JSON.parse(run.stdout).passed,true);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('UTF16 private terms are rejected without printing the private value',()=>{
 const dir=fixture();try{
  const term='synthetic-private-example';
  const policy=join(dir,'policy.json');writeFileSync(policy,JSON.stringify({terms:[term]}));
  writeFileSync(join(dir,'source.txt'),Buffer.from(term,'utf16le'));execFileSync('git',['add','source.txt'],{cwd:dir});
  const run=spawnSync(process.execPath,[scanner,'source'],{cwd:dir,encoding:'utf8',env:{...process.env,LINKFLOW_PRIVACY_POLICY:policy}});
  assert.equal(run.status,1);assert.match(run.stderr,/private-policy-term/);assert(!run.stderr.includes(term));
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('removed sensitive historical content remains a release blocker',()=>{
 const dir=fixture();try{
  stage(dir,['','Users','historical-synthetic-person','private'].join('/'));
  execFileSync('git',['-c','user.name=Example','-c','user.email=author@example.com','commit','-qm','Synthetic initial'],{cwd:dir});
  stage(dir,'Clean now');
  execFileSync('git',['-c','user.name=Example','-c','user.email=author@example.com','commit','-qm','Synthetic cleaned'],{cwd:dir});
  const run=spawnSync(process.execPath,[scanner,'source'],{cwd:dir,encoding:'utf8',env:{...process.env,LINKFLOW_PRIVACY_POLICY:''}});
  assert.equal(run.status,1);assert.match(run.stderr,/personal-mac-path/);assert(!run.stderr.includes('historical-synthetic-person'));
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('the local release policy requirement fails closed when absent',()=>{
 const dir=fixture();try{
  stage(dir,'clean');
  const run=spawnSync(process.execPath,[scanner,'source'],{cwd:dir,encoding:'utf8',env:{...process.env,LINKFLOW_PRIVACY_POLICY:'',LINKFLOW_REQUIRE_PRIVATE_POLICY:'1'}});
  assert.notEqual(run.status,0);assert.match(run.stderr,/nonempty private policy/);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('distribution scan catches data outside the allowlisted application archive',async()=>{
 const dir=fixture();try{
  for(const path of ['dist','dist-electron','release/resources','staging'])mkdirSync(join(dir,path),{recursive:true});
  writeFileSync(join(dir,'staging/package.json'),JSON.stringify({name:'synthetic'}));
  await createPackage(join(dir,'staging'),join(dir,'release/resources/app.asar'));
  writeFileSync(join(dir,'release/unexpected.bin'),Buffer.concat([Buffer.from('SQLite format 3\0'),Buffer.alloc(100)]));
  const run=spawnSync(process.execPath,[scanner,'dist'],{cwd:dir,encoding:'utf8',env:{...process.env,LINKFLOW_PRIVACY_POLICY:'',LINKFLOW_APP_RESOURCES:''}});
  assert.equal(run.status,1);assert.match(run.stderr,/database-magic/);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('distribution scan inspects nested ASAR paths using native separators',async()=>{
 const dir=fixture();try{
  for(const path of ['dist','dist-electron','release/resources','staging/dist/assets'])mkdirSync(join(dir,path),{recursive:true});
  const nested=join(dir,'staging/dist/assets/application.js');
  writeFileSync(nested,'public application');
  await createPackage(join(dir,'staging'),join(dir,'release/resources/app.asar'));
  const run=()=>spawnSync(process.execPath,[scanner,'dist'],{cwd:dir,encoding:'utf8',env:{...process.env,LINKFLOW_PRIVACY_POLICY:'',LINKFLOW_REQUIRE_PRIVATE_POLICY:'',LINKFLOW_APP_RESOURCES:''}});
  const clean=run();assert.equal(clean.status,0,clean.stderr);assert.equal(JSON.parse(clean.stdout).archives,1);
  writeFileSync(nested,['','Users','nested-synthetic-person','private'].join('/'));
  await createPackage(join(dir,'staging'),join(dir,'release/resources/app.asar'));
  const blocked=run();assert.equal(blocked.status,1);assert.match(blocked.stderr,/personal-mac-path/);assert(!blocked.stderr.includes('nested-synthetic-person'));
 }finally{rmSync(dir,{recursive:true,force:true})}
});


test('private filenames and deleted historical paths cannot bypass content deduplication',()=>{
 const dir=fixture();try{
  const term='synthetic-private-path';
  const policy=join(dir,'.git/policy.json');writeFileSync(policy,JSON.stringify({terms:[term]}));
  writeFileSync(join(dir,term+'.txt'),'clean');execFileSync('git',['add',term+'.txt'],{cwd:dir});
  const run=spawnSync(process.execPath,[scanner,'source'],{cwd:dir,encoding:'utf8',env:{...process.env,LINKFLOW_PRIVACY_POLICY:policy}});
  assert.equal(run.status,1);assert.match(run.stderr,/private-policy-term/);assert(!run.stderr.includes(term));
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('malformed private policies never echo private input',()=>{
 const dir=fixture();try{
  stage(dir,'clean');const term='synthetic-secret-malformed';
  const policy=join(dir,'.git/policy.json');writeFileSync(policy,'{"terms": ["'+term+'",]}');
  for(const script of [scanner,resolve('scripts/privacy-release.mjs')]){
   const run=spawnSync(process.execPath,[script,'source'],{cwd:dir,encoding:'utf8',env:{...process.env,LINKFLOW_PRIVACY_POLICY:policy}});
   assert.notEqual(run.status,0);assert(!run.stderr.includes(term));assert(!run.stdout.includes(term));
  }
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('both UTF16 byte orders at either byte alignment are scanned',()=>{
 const dir=fixture();try{
  const term='synthetic-unaligned-private';const policy=join(dir,'.git/policy.json');writeFileSync(policy,JSON.stringify({terms:[term]}));
  for(const be of [false,true])for(const prefix of [0,1]){
   const value=Buffer.from(term,'utf16le');if(be)value.swap16();
   writeFileSync(join(dir,'source.txt'),Buffer.concat([Buffer.alloc(prefix),value]));execFileSync('git',['add','source.txt'],{cwd:dir});
   const run=spawnSync(process.execPath,[scanner,'source'],{cwd:dir,encoding:'utf8',env:{...process.env,LINKFLOW_PRIVACY_POLICY:policy}});
   assert.equal(run.status,1);assert.match(run.stderr,/private-policy-term/);assert(!run.stderr.includes(term));
  }
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('broken publication symlinks fail closed',()=>{
 const dir=fixture();try{
  if(process.platform==='win32')return;
  symlinkSync('nonexistent-target',join(dir,'broken'));execFileSync('git',['add','broken'],{cwd:dir});
  const run=spawnSync(process.execPath,[scanner,'source'],{cwd:dir,encoding:'utf8',env:{...process.env,LINKFLOW_PRIVACY_POLICY:''}});
  assert.equal(run.status,1);assert.match(run.stderr,/external-or-broken-symlink/);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
