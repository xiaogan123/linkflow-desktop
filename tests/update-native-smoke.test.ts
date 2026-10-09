import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPackage} from '@electron/asar';

const script=fileURLToPath(new URL('../scripts/update-native-smoke.mjs',import.meta.url));
const wrapper=fileURLToPath(new URL('../scripts/update-native-wrapper.cjs',import.meta.url));
const plan=(platform:string,arch:string,version:string,sourceMode?:string)=>JSON.parse(execFileSync(process.execPath,[script,'--describe-plan',platform,arch,version,...(sourceMode?[sourceMode]:[])],{encoding:'utf8'}));

async function snapshot(root:string):Promise<string[][]>{
 const entries:string[][]=[];
 async function visit(directory:string,prefix=''){
  for(const entry of (await readdir(directory,{withFileTypes:true})).sort((left,right)=>left.name.localeCompare(right.name))){
   const relative=prefix?join(prefix,entry.name):entry.name,path=join(directory,entry.name);
   if(entry.isDirectory()){entries.push([relative,'directory']);await visit(path,relative)}
   else entries.push([relative,'file',(await readFile(path)).toString('base64')]);
  }
 }
 await visit(root);return entries;
}

async function cliFixture(){
 const root=await mkdtemp(join(tmpdir(),'linkflow-native-cli-')),cwd=join(root,'cwd'),temporary=join(root,'tmp');
 await mkdir(cwd);await mkdir(temporary);await writeFile(join(cwd,'package.json'),'{"nativeTripwire":');await writeFile(join(cwd,'marker.txt'),'unchanged');
 return {root,cwd,temporary};
}

function invokeCli(cwd:string,temporary:string,args:string[]){
 return spawnSync(process.execPath,[script,...args],{cwd,encoding:'utf8',timeout:5_000,env:{...process.env,TMPDIR:temporary,TMP:temporary,TEMP:temporary}});
}

test('Windows native probe is frozen to the published v1.2.15 installer and candidate v1.2.16',()=>{
 const value=plan('win32','x64','1.2.16');
 assert.deepEqual(value,{sourceVersion:'1.2.15',candidateVersion:'1.2.16',url:'https://github.com/xiaogan123/linkflow-desktop/releases/download/v1.2.15/Linkflow-1.2.15-windows-x64-setup.exe',sha256:'a727ea19699050ca2e7eb79720c6d6ec0b74c9e2c08028c1f82d2c3852a5bb52',platform:'win32',arch:'x64',sourceArtifact:'published-release',evidenceDirectory:'.evidence/release-1.2.16/native-probe'});
 const rejected=spawnSync(process.execPath,[script,'--describe-plan','win32','x64','1.2.15'],{encoding:'utf8'});assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/frozen for candidate 1\.2\.16/);
});

test('Mac native probe retains its candidate replacement path without a Windows download',()=>{
 const value=plan('darwin','arm64','1.2.2');
 assert.deepEqual(value,{platform:'darwin',arch:'arm64',sourceVersion:'1.2.2',candidateVersion:'1.2.2',sourceArtifact:'candidate',evidenceDirectory:'.evidence/release-1.2.2/native-probe'});
 assert.equal('url' in value,false);
});

test('Mac published-source probe is frozen to the official v1.2.15 archive and candidate v1.2.16',()=>{
 const value=plan('darwin','arm64','1.2.16','published-source');
 assert.deepEqual(value,{sourceVersion:'1.2.15',candidateVersion:'1.2.16',url:'https://github.com/xiaogan123/linkflow-desktop/releases/download/v1.2.15/Linkflow-1.2.15-mac-arm64.zip',sha256:'e82f72f06214c36c1f7cc00a279302483802b11bc6083d8d347f411a420b981e',platform:'darwin',arch:'arm64',sourceArtifact:'published-release',originalPublishedUpdater:true,evidenceDirectory:'.evidence/release-1.2.16/native-probe'});
 const rejected=spawnSync(process.execPath,[script,'--describe-plan','darwin','arm64','1.2.15','published-source'],{encoding:'utf8'});assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/frozen for candidate 1\.2\.16/);
});

test('ASAR version proof invalidates cached headers when the installer replaces the same path',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-native-asar-'));try{
  const oldRoot=join(directory,'old'),candidateRoot=join(directory,'candidate'),installed=join(directory,'installed.asar'),candidate=join(directory,'candidate.asar');await mkdir(oldRoot);await mkdir(candidateRoot);await writeFile(join(oldRoot,'package.json'),JSON.stringify({version:'1.2.1'}));await writeFile(join(candidateRoot,'000-prefix.txt'),'candidate layout changed before package.json\n'.repeat(128));await writeFile(join(candidateRoot,'package.json'),JSON.stringify({version:'1.2.2'}));await createPackage(oldRoot,installed);await createPackage(candidateRoot,candidate);
  const result=JSON.parse(execFileSync(process.execPath,[script,'--verify-asar-replacement',installed,candidate],{encoding:'utf8'}));assert.deepEqual(result,{before:'1.2.1',after:'1.2.2'});
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('native wrapper preserves the first candidate failure and emits only bounded diagnostics',()=>{
 const output=execFileSync(process.execPath,[wrapper,'--diagnostic-fixture'],{encoding:'utf8'}),value=JSON.parse(output);
 assert.equal(value.firstRole,'candidate');assert.equal(value.secondRole,'rollback');assert.equal(value.preserved,true);assert.equal(value.state.rollbackLaunches,1);
 assert.deepEqual(value.state.firstCandidateGui,{reportState:'rejected',schemaMatch:true,passed:false,nonceMatch:false,versionMatch:true,pidMatch:true,checksMatch:false,selfTestStatus:'failed',selfTestCheckCount:18,reportedVersion:'1.2.2',reportedCheckCount:1,exitCode:1});
 assert.equal(value.invalid.reportState,'invalid_json');assert.equal(value.schema.reportState,'schema_invalid');assert.doesNotMatch(output,/SECRET|Users|private-json|private C:/i);
});

test('native smoke help exits before package reads and leaves the filesystem untouched',async()=>{
 const fixture=await cliFixture();try{
  for(const args of [['--help'],['-h']]){
   const before=await snapshot(fixture.root),result=invokeCli(fixture.cwd,fixture.temporary,args),after=await snapshot(fixture.root);
   assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
   assert.match(result.stdout,/^Usage:\n/);assert.match(result.stdout,/--mac-published-source/);assert.match(result.stdout,/--mac-bridge/);assert.match(result.stdout,/--describe-plan/);assert.match(result.stdout,/--verify-asar-replacement/);assert.match(result.stdout,/without running a native update/);
   assert.doesNotMatch(result.stdout,/NATIVE_UPDATE_RESULT|nativeTripwire/);assert.deepEqual(after,before);
  }
 }finally{await rm(fixture.root,{recursive:true,force:true})}
});

test('unknown, malformed, extra, and mixed arguments fail before all side effects',async()=>{
 const fixture=await cliFixture();try{
  const cases=[
   ['--unknown-sensitive-operand'],
   ['unknown-sensitive-operand'],
   ['--help','unknown-sensitive-operand'],
   ['--describe-plan','win32','x64'],
   ['--describe-plan','win32','x64','   '],
   ['--describe-plan','win32','x64','1.2.15','candidate','unknown-sensitive-operand'],
   ['--describe-plan','win32','x64','1.2.15','--mac-bridge'],
   ['--verify-asar-replacement','','candidate.asar'],
   ['--verify-asar-replacement','   ','candidate.asar'],
   ['--verify-asar-replacement','   --mixed-sensitive-operand','candidate.asar'],
   ['--verify-asar-replacement','installed.asar','candidate.asar','unknown-sensitive-operand'],
   ['--mac-published-source',''],
   ['--mac-published-source','   '],
   ['--mac-published-source','archive.zip','unknown-sensitive-operand'],
   ['--mac-bridge','archive.zip','not-a-sha','1.2.14'],
   ['--mac-bridge','archive.zip','a'.repeat(64),'not-a-version'],
   ['--mac-bridge','   ','a'.repeat(64),'1.2.14'],
   ['--mac-bridge','archive.zip','a'.repeat(64),'1.2.14','unknown-sensitive-operand']
  ];
  for(const args of cases){
   const before=await snapshot(fixture.root),result=invokeCli(fixture.cwd,fixture.temporary,args),after=await snapshot(fixture.root);
   assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,2,`${args[0]}: ${result.stderr}`);assert.equal(result.stdout,'');
   assert.match(result.stderr,/^Invalid native update smoke arguments\.\nUsage:\n/);assert.doesNotMatch(result.stderr,/sensitive-operand|not-a-sha|not-a-version|nativeTripwire|package\.json|NATIVE_UPDATE_RESULT/);assert.deepEqual(after,before);
  }
 }finally{await rm(fixture.root,{recursive:true,force:true})}
});
