import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPackage} from '@electron/asar';

const script=fileURLToPath(new URL('../scripts/update-native-smoke.mjs',import.meta.url));
const wrapper=fileURLToPath(new URL('../scripts/update-native-wrapper.cjs',import.meta.url));
const plan=(platform:string,arch:string,version:string)=>JSON.parse(execFileSync(process.execPath,[script,'--describe-plan',platform,arch,version],{encoding:'utf8'}));

test('Windows native probe is frozen to the published v1.2.3 installer and candidate v1.2.4',()=>{
 const value=plan('win32','x64','1.2.4');
 assert.deepEqual(value,{sourceVersion:'1.2.3',candidateVersion:'1.2.4',url:'https://github.com/xiaogan123/linkflow-desktop/releases/download/v1.2.3/Linkflow-1.2.3-windows-x64-setup.exe',sha256:'69fc43070324794c4c9f000be8131b9fdf58057cddd3ff5db70f3bf58171615f',platform:'win32',arch:'x64',sourceArtifact:'published-release',evidenceDirectory:'.evidence/release-1.2.4/native-probe'});
 const rejected=spawnSync(process.execPath,[script,'--describe-plan','win32','x64','1.2.3'],{encoding:'utf8'});assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/frozen for candidate 1\.2\.4/);
});

test('Mac native probe retains its candidate replacement path without a Windows download',()=>{
 const value=plan('darwin','arm64','1.2.2');
 assert.deepEqual(value,{platform:'darwin',arch:'arm64',sourceVersion:'1.2.2',candidateVersion:'1.2.2',sourceArtifact:'candidate',evidenceDirectory:'.evidence/release-1.2.2/native-probe'});
 assert.equal('url' in value,false);
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
