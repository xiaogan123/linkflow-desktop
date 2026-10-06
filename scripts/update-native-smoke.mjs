import {build} from 'esbuild';
import {extractFile,uncache} from '@electron/asar';
import {createWriteStream} from 'node:fs';
import {copyFile,mkdtemp,mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import assert from 'node:assert/strict';

const windowsUpgrade={sourceVersion:'1.2.10',candidateVersion:'1.2.11',url:'https://github.com/xiaogan123/linkflow-desktop/releases/download/v1.2.10/Linkflow-1.2.10-windows-x64-setup.exe',sha256:'1f4b5eb4d1b71891180786a418bb4d07d7762d5b2e0f4e134b976120ec750e1b'};
const macPublishedUpgrade={sourceVersion:'1.2.10',candidateVersion:'1.2.11',url:'https://github.com/xiaogan123/linkflow-desktop/releases/download/v1.2.10/Linkflow-1.2.10-mac-arm64.zip',sha256:'c8502fcf9acd7de5878e2acde149e6aa120419da7f1e413289a28a9d1afc0aeb'};
const run=(file,args,options={})=>new Promise((done,reject)=>execFile(file,args,{timeout:180000,maxBuffer:1024*1024,...options},error=>error?reject(error):done()));
const delay=milliseconds=>new Promise(done=>setTimeout(done,milliseconds));
const sha256=value=>createHash('sha256').update(value).digest('hex');
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
const asarVersion=path=>{uncache(path);const version=JSON.parse(extractFile(path,'package.json').toString('utf8')).version;if(typeof version!=='string')throw Error('Packaged ASAR version is invalid');return version};
const probePlan=(platform,arch,candidateVersion,sourceMode='candidate')=>{
 if(!((platform==='darwin'&&arch==='arm64')||(platform==='win32'&&arch==='x64')))throw Error('Native supported platform required');
 if(platform==='win32'){if(sourceMode!=='candidate')throw Error('Windows native probe does not accept a Mac source mode');if(candidateVersion!==windowsUpgrade.candidateVersion)throw Error(`Windows upgrade fixture is frozen for candidate ${windowsUpgrade.candidateVersion}`);return {...windowsUpgrade,platform,arch,sourceArtifact:'published-release',evidenceDirectory:`.evidence/release-${candidateVersion}/native-probe`}}
 if(sourceMode==='published-source'){if(candidateVersion!==macPublishedUpgrade.candidateVersion)throw Error(`Mac published upgrade fixture is frozen for candidate ${macPublishedUpgrade.candidateVersion}`);return {...macPublishedUpgrade,platform,arch,sourceArtifact:'published-release',originalPublishedUpdater:true,evidenceDirectory:`.evidence/release-${candidateVersion}/native-probe`}}
 if(sourceMode!=='candidate')throw Error('Unknown Mac source mode');
 return {platform,arch,sourceVersion:candidateVersion,candidateVersion,sourceArtifact:'candidate',evidenceDirectory:`.evidence/release-${candidateVersion}/native-probe`};
};
const download=async(url,path)=>{const response=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(300000),headers:{'user-agent':'linkflow-native-upgrade-probe'}});if(!response.ok||!response.body)throw Error(`Published installer download failed with HTTP ${response.status}`);await pipeline(Readable.fromWeb(response.body),createWriteStream(path,{flags:'wx',mode:0o600}))};

async function main(){
const packageMetadata=JSON.parse(await readFile('package.json','utf8')),version=packageMetadata.version,plan=probePlan(process.platform,process.arch,version);
const bridgeIndex=process.argv.indexOf('--mac-bridge');
const publishedSourceIndex=process.argv.indexOf('--mac-published-source');
if(bridgeIndex>=0&&publishedSourceIndex>=0)throw Error('Choose either --mac-published-source or --mac-bridge');
if(publishedSourceIndex>=0){
 if(process.platform!=='darwin'||(process.argv.length!==publishedSourceIndex+1&&process.argv.length!==publishedSourceIndex+2))throw Error('Usage: --mac-published-source [official-v1.2.10-zip]');
 Object.assign(plan,probePlan(process.platform,process.arch,version,'published-source'));
 const [path]=process.argv.slice(publishedSourceIndex+1);if(path)plan.sourcePath=resolve(path);
}
if(bridgeIndex>=0){
 if(process.platform!=='darwin'||process.argv.length!==bridgeIndex+4)throw Error('Usage: --mac-bridge <zip> <sha256> <source-version>');
 const [path,sha,sourceVersion]=process.argv.slice(bridgeIndex+1);
 if(!/^[a-f0-9]{64}$/.test(sha)||!/^\d+\.\d+\.\d+$/.test(sourceVersion)||sourceVersion===version)throw Error('Bridge must bind a distinct version and exact SHA-256');
 Object.assign(plan,{sourceVersion,sourceArtifact:'private-patched-updater-bridge',sourcePath:resolve(path),sha256:sha,originalPublishedUpdater:false});
}
if(process.platform==='win32'){
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Windows installer probe requires a disposable hosted CI runner');
 const existing=await new Promise((done,reject)=>execFile('reg',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','/s','/f','外链助手','/d'],{encoding:'utf8'},error=>{if(!error)done(true);else if(error.code===1)done(false);else reject(Error('Unable to establish clean Windows registry'))}));
 if(existing)throw Error('A pre-existing Linkflow registration prevents the isolated installer probe');
}

const directory=await mkdtemp(join(tmpdir(),'linkflow-update-native-')),installParent=join(directory,'Install Path With Spaces');await mkdir(installParent);
const application=join(installParent,process.platform==='darwin'?'外链助手.app':'Linkflow');
const executable=process.platform==='darwin'?join(application,'Contents','MacOS','外链助手'):join(application,'外链助手.exe');
const resources=process.platform==='darwin'?join(application,'Contents','Resources'):join(application,'resources');
const releaseArtifact=resolve('release',`Linkflow-${version}-${process.platform==='darwin'?'mac-arm64.zip':'windows-x64-setup.exe'}`);
let sourceArtifact=releaseArtifact,candidateAsarSha256;
if(process.platform==='darwin'){
 const candidateAsar=resolve('release',`${packageMetadata.productName}-darwin-arm64`,'外链助手.app','Contents','Resources','app.asar');
 assert.equal(asarVersion(candidateAsar),version);candidateAsarSha256=sha256(await readFile(candidateAsar));
 if(plan.sourceArtifact==='published-release'){
  sourceArtifact=plan.sourcePath??join(directory,`Linkflow-${plan.sourceVersion}-mac-arm64.zip`);if(!plan.sourcePath)await download(plan.url,sourceArtifact);
  assert.equal(sha256(await readFile(sourceArtifact)),plan.sha256,`Published Mac v${plan.sourceVersion} archive SHA-256 mismatch`);
 }else if(plan.sourcePath){sourceArtifact=plan.sourcePath;assert.equal(sha256(await readFile(sourceArtifact)),plan.sha256,'Bound Mac source archive SHA-256 mismatch')}
}
if(process.platform==='win32'){
 const candidateAsar=resolve('release',`${packageMetadata.productName}-win32-x64`,'resources','app.asar');
 assert.equal(asarVersion(candidateAsar),version);candidateAsarSha256=sha256(await readFile(candidateAsar));
 sourceArtifact=join(directory,`Linkflow-${plan.sourceVersion}-windows-x64-setup.exe`);await download(plan.url,sourceArtifact);
 assert.equal(sha256(await readFile(sourceArtifact)),plan.sha256,`Published Windows v${plan.sourceVersion} installer SHA-256 mismatch`);
}
if(process.platform==='darwin')await run('/usr/bin/ditto',['-x','-k',sourceArtifact,installParent]);else await run(sourceArtifact,['/S',`/D=${application}`],{windowsVerbatimArguments:true});

const updates=join(directory,'user data','updates');await mkdir(updates,{recursive:true});
const marker=join(directory,'user data','preservation-marker'),markerBytes=Buffer.from('synthetic-update-data-fixture');await writeFile(marker,markerBytes);
const artifact=join(updates,process.platform==='darwin'?'candidate.zip':'candidate.exe');await copyFile(releaseArtifact,artifact);
const installedAsar=join(resources,'app.asar'),sourceAsarSha256=sha256(await readFile(installedAsar)),sourceVersion=asarVersion(installedAsar);assert.equal(sourceVersion,plan.sourceVersion,'Installed source ASAR version mismatch');
let repairedFile,repairHash;
if(process.platform==='win32'){repairedFile=join(application,'LICENSES.chromium.html');repairHash=sha256(await readFile(resolve('release',`${packageMetadata.productName}-win32-x64`,'LICENSES.chromium.html')));await writeFile(repairedFile,'Synthetic old-install marker; replacement must restore the packaged resource.')}

const configuration={directory,application,artifact,updates,version,sourceVersion,candidateAsarSha256,sourceArtifactKind:plan.sourceArtifact,wrapper:resolve('scripts/update-native-wrapper.cjs')};
const configPath=join(directory,'config.json');await writeFile(configPath,JSON.stringify(configuration),{mode:0o600});
const entryPath=join(directory,'entry.cjs');await build({entryPoints:['scripts/update-native-entry.ts'],outfile:entryPath,platform:'node',format:'cjs',bundle:true,target:'node24',external:['original-fs']});
const preparerEnvironment={...process.env,ELECTRON_RUN_AS_NODE:'1'};
if(process.platform==='darwin')for(const key of Object.keys(preparerEnvironment))if(key==='LANG'||key.startsWith('LC_'))delete preparerEnvironment[key];
const preparer=spawn(executable,[entryPath,configPath],{cwd:process.platform==='darwin'?join(application,'Contents','MacOS'):application,stdio:'ignore',env:preparerEnvironment,shell:false});
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
report.checks.push('installed preparer exited before installer authorization','real helper runtime runs outside install directory','same target path contains spaces','synthetic sidecar marker outside the application preserved (not a SQLite migration proof)');
if(process.platform==='win32'){
 const installedAsarSha256=sha256(await readFile(installedAsar)),installedVersion=asarVersion(installedAsar);assert.equal(report.outcome,'installed');assert.equal(installedVersion,version);assert.equal(installedAsarSha256,candidateAsarSha256);assert.notEqual(installedAsarSha256,sourceAsarSha256);
 report.upgrade={sourceVersion,sourceAsarSha256,candidateVersion:version,candidateAsarSha256,installedVersion,installedAsarSha256};report.checks.push(`published Windows v${sourceVersion} ASAR upgraded to the exact candidate v${version} ASAR`);
}else{
 assert.equal(report.outcome,'installed','Mac probe requires a real authenticated GUI launch; a preserved unconfirmed transaction is not success');
 const installedVersion=asarVersion(installedAsar),installedAsarSha256=sha256(await readFile(installedAsar));
 assert.equal(installedVersion,version);assert.equal(installedAsarSha256,candidateAsarSha256);
 const attributes=await new Promise((done,reject)=>execFile('/usr/bin/xattr',['-lr',application],{encoding:'utf8',maxBuffer:4*1024*1024},(error,stdout)=>error?reject(error):done(stdout)));
 assert(!attributes.includes('com.apple.quarantine'),'Installed candidate must have zero quarantine attributes');
 await run('/usr/bin/codesign',['--verify','--deep','--strict',application]);
 report.upgrade={sourceVersion,sourceAsarSha256,candidateVersion:version,candidateAsarSha256,installedVersion,installedAsarSha256,sourceArtifactKind:plan.sourceArtifact,originalPublishedUpdater:plan.originalPublishedUpdater??false};
 if(plan.sourceArtifact==='published-release'){report.limitations=`Published Mac v${sourceVersion}-to-v${version} replacement exercises the original released updater and an isolated authenticated candidate GUI. Synthetic sidecar data does not prove production profile migration.`;report.checks.push(`published Mac v${sourceVersion} archive matched its fixed release SHA-256`)}
 report.checks.push('native installed Mac tree has zero quarantine attributes and valid strict signature');
}
await writeFile(resultPath,JSON.stringify(report,null,2));
await mkdir(plan.evidenceDirectory,{recursive:true});await copyFile(resultPath,join(plan.evidenceDirectory,`native-update-${process.platform}.json`));
console.log('NATIVE_UPDATE_RESULT '+JSON.stringify(report));
if(process.platform==='win32')await run(join(application,'Uninstall 外链助手.exe'),['/S']);
}

if(process.argv[2]==='--describe-plan')console.log(JSON.stringify(probePlan(process.argv[3],process.argv[4],process.argv[5],process.argv[6])));
else if(process.argv[2]==='--verify-asar-replacement'){const before=asarVersion(process.argv[3]);await copyFile(process.argv[4],process.argv[3]);console.log(JSON.stringify({before,after:asarVersion(process.argv[3])}))}
else await main();
