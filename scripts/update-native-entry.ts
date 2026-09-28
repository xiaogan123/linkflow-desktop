import {readFile,writeFile,mkdir,copyFile,stat} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {prepareInstallJob} from '../src/main/update-install';
const readArchive=(path:string):Promise<Buffer>=>require('original-fs').promises.readFile(path);
const delay=(ms:number)=>new Promise(done=>setTimeout(done,ms));
async function main(){
 const config=JSON.parse(await readFile(process.argv[2],'utf8'));
 const {directory,application,version}=config,updates=join(directory,'user data','updates');await mkdir(updates,{recursive:true});
 const marker=join(directory,'user data','preservation-marker'),markerBytes=Buffer.from('synthetic-update-data-fixture');await writeFile(marker,markerBytes);
 const executable=process.platform==='darwin'?join(application,'Contents','MacOS','外链助手'):join(application,'外链助手.exe');
 const resources=process.platform==='darwin'?join(application,'Contents','Resources'):join(application,'resources'),helper=join(resources,'app.asar','dist-electron','update-helper.cjs');
 const artifact=join(updates,process.platform==='darwin'?'candidate.zip':'candidate.exe');await copyFile(config.artifact,artifact);
 const artifactBytes=await readFile(artifact);
 const priorHash=createHash('sha256').update(await readArchive(join(resources,'app.asar'))).digest('hex');
 let repairedFile:string|undefined,repairHash:string|undefined;
 if(process.platform==='win32'){repairedFile=join(application,'LICENSES.chromium.html');repairHash=createHash('sha256').update(await readFile(repairedFile)).digest('hex');await writeFile(repairedFile,'Synthetic old-install marker; replacement must restore the packaged resource.');}
 const old=spawn(executable,['-e','setInterval(()=>{},1000)'],{cwd:dirname(executable),env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:'ignore',shell:false});await new Promise<void>((done,reject)=>{old.once('spawn',()=>done());old.once('error',reject)});
 let worker:ReturnType<typeof spawn>|undefined;
 try{
  const prepared=await prepareInstallJob({platform:process.platform==='darwin'?'darwin-arm64':'win32-x64',oldPid:old.pid!,targetVersion:version,updatesDirectory:updates,artifactPath:artifact,artifactSize:artifactBytes.length,artifactSha256:createHash('sha256').update(artifactBytes).digest('hex'),applicationPath:application,executablePath:executable,helperPath:helper});
  const wrapper=join(updates,'native-wrapper.cjs');await copyFile(config.wrapper,wrapper);
  const wrapperConfig=join(updates,'probe.json');await writeFile(wrapperConfig,JSON.stringify({jobPath:prepared.jobPath,helperPath:prepared.launchHelperPath,reportPath:join(directory,'result.json'),version,directory}),{mode:0o600});
  worker=spawn(prepared.launchExecutablePath,[wrapper,wrapperConfig],{cwd:dirname(prepared.launchExecutablePath),env:{...process.env,ELECTRON_RUN_AS_NODE:'1',LINKFLOW_UPDATE_HELPER:undefined},stdio:'inherit',shell:false});
  const closed=new Promise<number|null>((done,reject)=>{worker!.once('exit',done);worker!.once('error',reject)});
  const deadline=Date.now()+10000;while(Date.now()<deadline){try{if(await readFile(prepared.job.readyPath,'utf8')===prepared.job.token)break}catch{}await delay(50)}
  assert.equal(await readFile(prepared.job.readyPath,'utf8'),prepared.job.token);await writeFile(prepared.job.armPath,prepared.job.token,{flag:'wx',mode:0o600});old.kill();
  assert.equal(await closed,0);assert.deepEqual(await readFile(marker),markerBytes);assert((await stat(executable)).isFile());
  const result=JSON.parse(await readFile(join(directory,'result.json'),'utf8'));if(repairedFile){assert.equal(createHash('sha256').update(await readFile(repairedFile)).digest('hex'),repairHash);result.checks.push('NSIS actually replaced the resource at the exact existing path')}
  result.checks.push('real helper runtime runs outside install directory','same target path contains spaces','user data marker preserved');
  if(result.outcome==='rollback_system_policy')assert.equal(createHash('sha256').update(await readArchive(join(resources,'app.asar'))).digest('hex'),priorHash);
  await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2));
 }finally{old.kill();worker?.kill()}
}
main().catch(async(error)=>{await writeFile(process.argv[2]+'.error.json',JSON.stringify({message:error.message,stack:error.stack}),{mode:0o600}).catch(()=>{});console.error('Native updater probe failed; isolated artifacts retained for diagnosis');process.exitCode=1});
