import {build} from 'esbuild';
import {copyFile,mkdtemp,mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const run=(file,args,options={})=>new Promise((done,reject)=>execFile(file,args,{timeout:180000,maxBuffer:1024*1024,...options},error=>error?reject(error):done()));
const delay=milliseconds=>new Promise(done=>setTimeout(done,milliseconds));
const sha256=value=>createHash('sha256').update(value).digest('hex');
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};

if(!((process.platform==='darwin'&&process.arch==='arm64')||(process.platform==='win32'&&process.arch==='x64')))throw Error('Native supported platform required');
if(process.platform==='win32'){
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Windows installer probe requires a disposable hosted CI runner');
 const existing=await new Promise((done,reject)=>execFile('reg',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','/s','/f','外链助手','/d'],{encoding:'utf8'},error=>{if(!error)done(true);else if(error.code===1)done(false);else reject(Error('Unable to establish clean Windows registry'))}));
 if(existing)throw Error('A pre-existing Linkflow registration prevents the isolated installer probe');
}

const version=JSON.parse(await readFile('package.json','utf8')).version;
const directory=await mkdtemp(join(tmpdir(),'linkflow-update-native-')),installParent=join(directory,'Install Path With Spaces');await mkdir(installParent);
const application=join(installParent,process.platform==='darwin'?'外链助手.app':'Linkflow');
const executable=process.platform==='darwin'?join(application,'Contents','MacOS','外链助手'):join(application,'外链助手.exe');
const resources=process.platform==='darwin'?join(application,'Contents','Resources'):join(application,'resources');
const releaseArtifact=resolve('release',`Linkflow-${version}-${process.platform==='darwin'?'mac-arm64.zip':'windows-x64-setup.exe'}`);
if(process.platform==='darwin')await run('/usr/bin/ditto',['-x','-k',releaseArtifact,installParent]);else await run(releaseArtifact,['/S',`/D=${application}`],{windowsVerbatimArguments:true});

const updates=join(directory,'user data','updates');await mkdir(updates,{recursive:true});
const marker=join(directory,'user data','preservation-marker'),markerBytes=Buffer.from('synthetic-update-data-fixture');await writeFile(marker,markerBytes);
const artifact=join(updates,process.platform==='darwin'?'candidate.zip':'candidate.exe');await copyFile(releaseArtifact,artifact);
const priorHash=sha256(await readFile(join(resources,'app.asar')));
let repairedFile,repairHash;
if(process.platform==='win32'){repairedFile=join(application,'LICENSES.chromium.html');repairHash=sha256(await readFile(repairedFile));await writeFile(repairedFile,'Synthetic old-install marker; replacement must restore the packaged resource.')}

const configuration={directory,application,artifact,updates,version,wrapper:resolve('scripts/update-native-wrapper.cjs')};
const configPath=join(directory,'config.json');await writeFile(configPath,JSON.stringify(configuration),{mode:0o600});
const entryPath=join(directory,'entry.cjs');await build({entryPoints:['scripts/update-native-entry.ts'],outfile:entryPath,platform:'node',format:'cjs',bundle:true,target:'node24',external:['original-fs']});
const preparer=spawn(executable,[entryPath,configPath],{cwd:process.platform==='darwin'?join(application,'Contents','MacOS'):application,stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},shell:false});
const preparationDeadline=setTimeout(()=>preparer.kill(),120000),preparationCode=await new Promise((done,reject)=>{preparer.once('exit',done);preparer.once('error',reject)});clearTimeout(preparationDeadline);
if(preparationCode!==0)throw Error('Native updater preparation failed');
const handoff=JSON.parse(await readFile(join(directory,'handoff.json'),'utf8'));
if(handoff.schemaVersion!==1||handoff.oldPid!==preparer.pid||!Number.isSafeInteger(handoff.workerPid)||typeof handoff.armPath!=='string'||typeof handoff.token!=='string')throw Error('Native updater handoff was invalid');
if(alive(handoff.oldPid))throw Error('Updater preparer retained target application handles');
await writeFile(handoff.armPath,handoff.token,{flag:'wx',mode:0o600});

let report;const resultPath=join(directory,'result.json'),resultDeadline=Date.now()+210000;
while(Date.now()<resultDeadline){try{report=JSON.parse(await readFile(resultPath,'utf8'));break}catch{}await delay(100)}
if(!report){if(alive(handoff.workerPid))process.kill(handoff.workerPid);throw Error('Native updater result timed out')}
const workerExitDeadline=Date.now()+10_000;while(alive(handoff.workerPid)&&Date.now()<workerExitDeadline)await delay(50);if(alive(handoff.workerPid)){process.kill(handoff.workerPid);throw Error('Native updater worker did not exit after reporting')}
if(!report.passed){if(report.diagnostic)console.error('NATIVE_UPDATE_DIAGNOSTIC '+JSON.stringify(report.diagnostic));throw Error('Native updater probe failed')}
assert.deepEqual(await readFile(marker),markerBytes);assert((await stat(executable)).isFile());
if(repairedFile){assert.equal(sha256(await readFile(repairedFile)),repairHash);report.checks.push('NSIS actually replaced the resource at the exact existing path')}
report.checks.push('installed preparer exited before installer authorization','real helper runtime runs outside install directory','same target path contains spaces','user data marker preserved');
if(report.outcome==='rollback_system_policy')assert.equal(sha256(await readFile(join(resources,'app.asar'))),priorHash);
await writeFile(resultPath,JSON.stringify(report,null,2));
await mkdir('.evidence/release-1.2.0',{recursive:true});await copyFile(resultPath,`.evidence/release-1.2.0/native-update-${process.platform}.json`);
console.log('NATIVE_UPDATE_RESULT '+JSON.stringify(report));
if(process.platform==='win32')await run(join(application,'Uninstall 外链助手.exe'),['/S']);
