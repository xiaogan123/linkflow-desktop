import {copyFile,readFile,rename,writeFile} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {prepareInstallJob} from '../src/main/update-install';

const delay=(milliseconds:number)=>new Promise(done=>setTimeout(done,milliseconds));

async function main(){
 const config=JSON.parse(await readFile(process.argv[2],'utf8'));
 const {directory,application,artifact,version,sourceVersion,candidateAsarSha256,wrapper,updates}=config;
 const executable=process.platform==='darwin'?join(application,'Contents','MacOS','外链助手'):join(application,'外链助手.exe');
 const resources=process.platform==='darwin'?join(application,'Contents','Resources'):join(application,'resources');
 const helper=join(resources,'app.asar','dist-electron','update-helper.cjs'),artifactBytes=await readFile(artifact);
 const sourcePackage=JSON.parse(await readFile(join(resources,'app.asar','package.json'),'utf8')),sourceHelperSha256=createHash('sha256').update(await readFile(helper)).digest('hex');
 if(sourcePackage.version!==sourceVersion)throw Error('Installed source version changed before updater preparation');
 let worker:ReturnType<typeof spawn>|undefined;
 try{
  const prepared=await prepareInstallJob({platform:process.platform==='darwin'?'darwin-arm64':'win32-x64',oldPid:process.pid,targetVersion:version,updatesDirectory:updates,artifactPath:artifact,artifactSize:artifactBytes.length,artifactSha256:createHash('sha256').update(artifactBytes).digest('hex'),applicationPath:application,executablePath:executable,helperPath:helper});
  if(createHash('sha256').update(await readFile(prepared.launchHelperPath)).digest('hex')!==sourceHelperSha256)throw Error('Copied helper does not match the installed source helper');
  const wrapperCopy=join(updates,'native-wrapper.cjs');await copyFile(wrapper,wrapperCopy);
  const runtimeApplication=join(prepared.job.helperRuntimePath,basename(application)),runtimePackagePath=process.platform==='darwin'?join(runtimeApplication,'Contents','Resources','app.asar','package.json'):join(runtimeApplication,'resources','app.asar','package.json');
  const wrapperConfig=join(updates,'probe.json');await writeFile(wrapperConfig,JSON.stringify({jobPath:prepared.jobPath,helperPath:prepared.launchHelperPath,sourceHelperSha256,runtimePackagePath,sourceVersion,candidateAsarSha256,reportPath:join(directory,'result.json'),version,directory}),{mode:0o600});
  worker=spawn(prepared.launchExecutablePath,[wrapperCopy,wrapperConfig],{cwd:dirname(prepared.launchExecutablePath),detached:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',LINKFLOW_UPDATE_HELPER:undefined},stdio:'ignore',shell:false});
  await new Promise<void>((done,reject)=>{worker!.once('spawn',done);worker!.once('error',reject)});worker.unref();
  const deadline=Date.now()+10_000;while(Date.now()<deadline){try{if(await readFile(prepared.job.readyPath,'utf8')===prepared.job.token)break}catch{}await delay(50)}
  if(await readFile(prepared.job.readyPath,'utf8')!==prepared.job.token)throw Error('Native helper readiness handshake failed');
  const handoffPath=join(directory,'handoff.json'),temporary=handoffPath+'.tmp';await writeFile(temporary,JSON.stringify({schemaVersion:1,oldPid:process.pid,workerPid:worker.pid,armPath:prepared.job.armPath,token:prepared.job.token}),{mode:0o600,flag:'wx'});await rename(temporary,handoffPath);
 }catch(error){worker?.kill();throw error}
}

main().catch(async(error)=>{await writeFile(process.argv[2]+'.error.json',JSON.stringify({message:error.message,stack:error.stack}),{mode:0o600}).catch(()=>{});console.error('Native updater preparation failed; isolated artifacts retained for diagnosis');process.exitCode=1});
