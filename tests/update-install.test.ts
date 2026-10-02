import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod,lstat,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {prepareInstallJob,type UpdateHelperJob} from '../src/main/update-install';
import {runUpdateHelper} from '../src/main/update-helper';
import {hashUpdateTree} from '../src/main/update-tree';

const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
function jobFields(directory:string,platform:'darwin-arm64'|'win32-x64',artifact:Buffer):{jobPath:string;job:UpdateHelperJob}{
 const updates=join(directory,'updates'),applicationPath=platform==='darwin-arm64'?join(directory,'外链助手.app'):join(directory,'installed'),executablePath=platform==='darwin-arm64'?join(applicationPath,'Contents','MacOS','外链助手'):join(applicationPath,'外链助手.exe'),jobPath=join(updates,'install-test.json'),token='00000000-0000-4000-8000-000000000001';
 return {jobPath,job:{schemaVersion:1 as const,token,platform,oldPid:123,targetVersion:'1.2.0',updatesDirectory:updates,artifactPath:join(updates,platform==='darwin-arm64'?'update.zip':'update.exe'),artifactSize:artifact.length,artifactSha256:sha(artifact),applicationPath,executablePath,backupPath:platform==='darwin-arm64'?join(directory,'.外链助手.app.linkflow-backup-test'):join(directory,'.linkflow-backup-test'),helperRuntimePath:join(updates,'helper-runtime-test'),readyPath:jobPath+'.ready',armPath:jobPath+'.armed',startupRequestPath:join(updates,'startup-request.json'),startupAckPath:join(updates,'startup-ack'),stagedApplicationPath:platform==='darwin-arm64'?join(directory,'.linkflow-update-1.2.0','外链助手.app'):undefined,receiptPath:join(updates,'installed.json'),errorPath:join(updates,'install-error.json')}};
}

test('mac preparation expands beside the app and verifies signing, quarantine, identity, version and arm64',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-install-')),app=join(directory,'外链助手.app'),exe=join(app,'Contents','MacOS','外链助手'),helper=join(app,'Contents','Resources','app.asar','dist-electron','update-helper.cjs'),updates=join(directory,'user-data','updates'),artifact=join(updates,'update.zip'),archive=Buffer.from('archive');try{
  await mkdir(join(app,'Contents','MacOS'),{recursive:true});await mkdir(join(app,'Contents','Resources'),{recursive:true});await mkdir(updates,{recursive:true});await writeFile(exe,'old');await writeFile(join(app,'Contents','Resources','app.asar'),'opaque real asar file');await writeFile(artifact,archive);
  let quarantined=false;const helperBytes=Buffer.from('trusted bundled helper'),calls:string[]=[],ports={files:{readBundledFile:(async(path:string)=>{assert.equal(path,helper);return helperBytes}) as typeof readFile},uuid:(()=>{let i=0;return()=>`00000000-0000-4000-8000-${String(++i).padStart(12,'0')}`})(),execute:async(file:string,args:string[])=>{calls.push(`${file} ${args.join(' ')}`);if(file==='/usr/bin/ditto'){const stage=args.at(-1)!;await mkdir(join(stage,basename(app),'Contents','MacOS'),{recursive:true});await writeFile(join(stage,basename(app),'Contents','MacOS','外链助手'),'new');await chmod(join(stage,basename(app),'Contents','MacOS','外链助手'),0o755)}if(file==='/usr/bin/plutil')return args[1]==='CFBundleIdentifier'?'com.linkflow.personal\n':'1.2.0\n';if(file==='/usr/bin/lipo')return 'arm64\n';if(file==='/usr/bin/xattr'&&args[0]==='-p'){if(!quarantined)throw Error('attribute absent');return '0081;test;Linkflow;\n'}if(file==='/usr/bin/xattr'&&args[0]==='-w')quarantined=true;return ''}},input={platform:'darwin-arm64' as const,oldPid:123,targetVersion:'1.2.0',updatesDirectory:updates,artifactPath:artifact,artifactSize:archive.length,artifactSha256:sha(archive),applicationPath:app,executablePath:exe,helperPath:helper};const result=await prepareInstallJob(input,ports);await prepareInstallJob(input,ports);
  assert(result.job.stagedApplicationPath?.startsWith(directory));assert(!result.job.stagedApplicationPath?.startsWith(updates));assert.match(result.job.stagedTreeSha256!,/^[a-f0-9]{64}$/);assert(result.launchExecutablePath.includes('helper-runtime-'));assert.equal(await readFile(result.launchHelperPath,'utf8'),helperBytes.toString());assert.equal((await lstat(join(result.job.helperRuntimePath,basename(app),'Contents','Resources','app.asar'))).isFile(),true);assert(calls.some(call=>call.startsWith('/usr/bin/codesign --verify --deep --strict')));assert.equal(calls.filter(call=>call.startsWith('/usr/bin/ditto ')).length,2);assert.equal(calls.filter(call=>call.startsWith('/usr/bin/xattr -w com.apple.quarantine')).length,1);
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('mac helper preserves both replacement and rollback copy when launch identity is unknown',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-helper-')),artifact=Buffer.from('archive'),{jobPath,job}=jobFields(directory,'darwin-arm64',artifact);try{
  await mkdir(join(job.applicationPath,'Contents','MacOS'),{recursive:true});await mkdir(join(job.stagedApplicationPath!,'Contents','MacOS'),{recursive:true});await mkdir(job.updatesDirectory,{recursive:true});await writeFile(join(job.applicationPath,'old.txt'),'old');await writeFile(join(job.stagedApplicationPath!,'new.txt'),'new');await writeFile(job.executablePath.replace(job.applicationPath,job.stagedApplicationPath!),'new executable',{mode:0o755});job.stagedTreeSha256=await hashUpdateTree(job.stagedApplicationPath!);await writeFile(job.artifactPath,artifact);await writeFile(jobPath,JSON.stringify(job));await writeFile(job.armPath,job.token);let opens=0;
  let terminated=0;await assert.rejects(runUpdateHelper(jobPath,{isAlive:pid=>pid===7001,verifyMac:async()=>{},verifyMacStartup:async()=>{},openMac:async()=>{opens++;throw Error('synthetic open failure')},listMacProcesses:async()=>[{pid:7001,command:job.executablePath}],terminate:()=>{terminated++},startupTimeoutMs:0}));assert.equal(await readFile(join(job.applicationPath,'new.txt'),'utf8'),'new');assert.equal(await readFile(join(job.backupPath,'old.txt'),'utf8'),'old');const failure=JSON.parse(await readFile(job.errorPath,'utf8'));assert.equal(failure.recoveryJobPath,jobPath);assert(!failure.message.includes(directory));assert.equal(opens,1);assert.equal(terminated,0);assert.equal((await lstat(jobPath)).isFile(),true);assert.equal((await lstat(job.startupRequestPath)).isFile(),true);
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('mac helper accepts a GUI-ready ACK from the authenticated translocated process',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-helper-')),artifact=Buffer.from('archive'),{jobPath,job}=jobFields(directory,'darwin-arm64',artifact),translocated=join(directory,'AppTranslocation','id','d','外链助手.app');try{
  await mkdir(join(job.applicationPath,'Contents','MacOS'),{recursive:true});await mkdir(join(job.stagedApplicationPath!,'Contents','MacOS'),{recursive:true});await mkdir(join(translocated,'Contents','MacOS'),{recursive:true});await mkdir(job.updatesDirectory,{recursive:true});await writeFile(join(job.applicationPath,'old.txt'),'old');const stagedExecutable=job.executablePath.replace(job.applicationPath,job.stagedApplicationPath!),translocatedExecutable=join(translocated,'Contents','MacOS','外链助手');await writeFile(stagedExecutable,'new executable',{mode:0o755});await writeFile(translocatedExecutable,'new executable',{mode:0o755});job.stagedTreeSha256=await hashUpdateTree(job.stagedApplicationPath!);await writeFile(job.artifactPath,artifact);await writeFile(jobPath,JSON.stringify(job));await writeFile(job.armPath,job.token);
  const pid=456;await runUpdateHelper(jobPath,{isAlive:value=>value===pid,verifyMac:async()=>{},verifyMacStartup:async(app,exe,version,digest)=>{assert.equal(app,translocated);assert.equal(exe,translocatedExecutable);assert.equal(version,job.targetVersion);assert.equal(digest,job.stagedTreeSha256)},listMacProcesses:async()=>[{pid,command:translocatedExecutable}],openMac:async()=>{await writeFile(job.startupAckPath,JSON.stringify({schemaVersion:2,targetVersion:job.targetVersion,token:job.token,pid,applicationPath:translocated,executablePath:translocatedExecutable}))}});const receipt=JSON.parse(await readFile(job.receiptPath,'utf8'));assert.equal(receipt.targetVersion,'1.2.0');await assert.rejects(lstat(job.backupPath));
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('canonical application tree binds content and rejects external links on each platform',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-tree-')),app=join(directory,'candidate.app'),outside=join(directory,'outside');try{
  await mkdir(join(app,'Contents','MacOS'),{recursive:true});await mkdir(outside);const executable=join(app,'Contents','MacOS','candidate');await writeFile(executable,'candidate');const first=await hashUpdateTree(app);await writeFile(executable,'different');assert.notEqual(await hashUpdateTree(app),first);
  await symlink(outside,join(app,'external-link'),process.platform==='win32'?'junction':'dir');await assert.rejects(hashUpdateTree(app),/越界符号链接/);
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('Mac bundle tree binds exact POSIX executable permissions',{skip:process.platform==='win32'?'Windows does not implement POSIX execute bits; covered on native Mac':false},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-tree-mode-'));try{
  const executable=join(directory,'candidate');await writeFile(executable,'candidate',{mode:0o755});const first=await hashUpdateTree(directory);await chmod(executable,0o744);assert.notEqual(await hashUpdateTree(directory),first);
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('mac helper rejects a staged tree changed after the trusted extraction',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-helper-')),artifact=Buffer.from('archive'),{jobPath,job}=jobFields(directory,'darwin-arm64',artifact);try{
  await mkdir(join(job.applicationPath,'Contents','MacOS'),{recursive:true});await mkdir(join(job.stagedApplicationPath!,'Contents','MacOS'),{recursive:true});await mkdir(job.updatesDirectory,{recursive:true});await writeFile(join(job.applicationPath,'old.txt'),'old');const stagedExecutable=job.executablePath.replace(job.applicationPath,job.stagedApplicationPath!);await writeFile(stagedExecutable,'trusted',{mode:0o755});job.stagedTreeSha256=await hashUpdateTree(job.stagedApplicationPath!);await writeFile(stagedExecutable,'changed',{mode:0o755});await writeFile(job.artifactPath,artifact);await writeFile(jobPath,JSON.stringify(job));await writeFile(job.armPath,job.token);let verified=false;
  await assert.rejects(runUpdateHelper(jobPath,{isAlive:()=>false,verifyMac:async()=>{verified=true}}),/应用树/);assert.equal(verified,false);assert.equal(await readFile(join(job.applicationPath,'old.txt'),'utf8'),'old');await assert.rejects(lstat(job.backupPath));
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('helper requires a real target-version startup acknowledgement before deleting rollback',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-helper-')),artifact=Buffer.from('installer'),{jobPath,job}=jobFields(directory,'win32-x64',artifact);try{
  await mkdir(job.applicationPath,{recursive:true});await mkdir(job.backupPath,{recursive:true});await mkdir(job.updatesDirectory,{recursive:true});await writeFile(job.executablePath,'old');await writeFile(join(job.backupPath,basename(job.executablePath)),'old');await writeFile(job.artifactPath,artifact);await writeFile(jobPath,JSON.stringify(job));await writeFile(job.armPath,job.token);
  let installerArgs:string[]|undefined;await runUpdateHelper(jobPath,{isAlive:()=>false,executeInstaller:async(_file,args)=>{installerArgs=args;await writeFile(job.executablePath,'new');await chmod(job.executablePath,0o755)},launch:async()=>{const request=JSON.parse(await readFile(job.startupRequestPath,'utf8'));await writeFile(job.startupAckPath,request.token);return {pid:456}}});assert.deepEqual(installerArgs,['--updated','/S',`/D=${job.applicationPath}`]);const receipt=JSON.parse(await readFile(job.receiptPath,'utf8'));assert.equal(receipt.targetVersion,'1.2.0');await assert.rejects(readFile(join(job.backupPath,basename(job.executablePath))));
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('helper refuses artifacts outside the controlled update directory before replacing anything',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-helper-')),artifact=Buffer.from('installer'),{jobPath,job}=jobFields(directory,'win32-x64',artifact);job.artifactPath=join(directory,'outside.exe');try{
  await mkdir(job.applicationPath,{recursive:true});await mkdir(job.backupPath,{recursive:true});await mkdir(job.updatesDirectory,{recursive:true});await writeFile(job.executablePath,'old');await writeFile(join(job.backupPath,basename(job.executablePath)),'old');await writeFile(job.artifactPath,artifact);await writeFile(jobPath,JSON.stringify(job));await assert.rejects(runUpdateHelper(jobPath,{isAlive:()=>false}),/受控目录/);assert.equal(await readFile(job.executablePath,'utf8'),'old');
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('runtime cleanup failure never masks the original bundled-helper read error',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-install-')),applicationPath=join(directory,'installed'),executablePath=join(applicationPath,'外链助手.exe'),helperPath=join(applicationPath,'resources','app.asar','dist-electron','update-helper.cjs'),updatesDirectory=join(directory,'updates'),artifactPath=join(updatesDirectory,'update.exe'),artifact=Buffer.from('installer');try{
  await mkdir(applicationPath,{recursive:true});await mkdir(updatesDirectory,{recursive:true});await writeFile(executablePath,'old');await writeFile(artifactPath,artifact);const failingRm=(async()=>{throw Error('synthetic cleanup failure')}) as typeof rm;
  await assert.rejects(prepareInstallJob({platform:'win32-x64',oldPid:123,targetVersion:'1.2.0',updatesDirectory,artifactPath,artifactSize:artifact.length,artifactSha256:sha(artifact),applicationPath,executablePath,helperPath},{files:{readBundledFile:(async()=>{throw Error('original bundled helper read failure')}) as typeof readFile,rm:failingRm}}),/original bundled helper read failure/);
 }finally{await rm(directory,{recursive:true,force:true})}
});
