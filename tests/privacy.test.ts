import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
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
