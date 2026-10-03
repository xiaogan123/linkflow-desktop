import {constants as fsConstants,type BigIntStats} from 'node:fs';
import {access,cp,lstat,mkdir,open,readFile,readdir,rename,rm,stat,unlink,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {basename,dirname,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {UpdatePlatform} from '../shared/update-types';
import {executeWithUpdateDescriptor,updateRawFs} from './update-files';
import {verifyVerifiedMacStageQuarantineFree} from './update-mac-quarantine';
import {hashUpdateTree} from './update-tree';

export interface UpdateHelperJob {
  schemaVersion:1;
  token:string;
  platform:UpdatePlatform;
  oldPid:number;
  targetVersion:string;
  updatesDirectory:string;
  artifactPath:string;
  artifactSize:number;
  artifactSha256:string;
  applicationPath:string;
  executablePath:string;
  backupPath:string;
  helperRuntimePath:string;
  readyPath:string;
  armPath:string;
  startupRequestPath:string;
  startupAckPath:string;
  stagedApplicationPath?:string;
  stagedTreeSha256?:string;
  receiptPath:string;
  errorPath:string;
}

export interface InstallFilePorts {access:typeof access;cp:typeof cp;lstat:typeof lstat;mkdir:typeof mkdir;open:typeof open;readFile:typeof readFile;readBundledFile:typeof readFile;readdir:typeof readdir;rename:typeof rename;rm:typeof rm;stat:typeof stat;unlink:typeof unlink;writeFile:typeof writeFile}
export interface InstallPorts {files?:Partial<InstallFilePorts>;execute?:(file:string,args:string[])=>Promise<string>;extractMacArchive?:(descriptor:number,destination:string)=>Promise<void>;uuid?:()=>string}
const rawPromises=updateRawFs().promises;
const realFiles:InstallFilePorts={access:rawPromises.access as typeof access,cp:rawPromises.cp as typeof cp,lstat:rawPromises.lstat as typeof lstat,mkdir:rawPromises.mkdir as typeof mkdir,open:rawPromises.open as typeof open,readFile:rawPromises.readFile as typeof readFile,readBundledFile:readFile,readdir:rawPromises.readdir as typeof readdir,rename:rawPromises.rename as typeof rename,rm:rawPromises.rm as typeof rm,stat:rawPromises.stat as typeof stat,unlink:rawPromises.unlink as typeof unlink,writeFile:rawPromises.writeFile as typeof writeFile};
const versionPattern=/^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

function inside(parent:string,child:string):boolean{const path=relative(resolve(parent),resolve(child));return !!path&&path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path)}
function basenameSafe(path:string){const parts=path.split(/[\\/]/);return parts.at(-1)??''}
export function validateUpdateHelperJob(value:unknown,jobPath:string):UpdateHelperJob{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('更新任务无效');const job=value as Partial<UpdateHelperJob>;
  if(job.schemaVersion!==1||(job.platform!=='darwin-arm64'&&job.platform!=='win32-x64')||typeof job.token!=='string'||!/^[a-f0-9-]{16,64}$/i.test(job.token)||!Number.isSafeInteger(job.oldPid)||(job.oldPid??0)<1||typeof job.targetVersion!=='string'||!versionPattern.test(job.targetVersion))throw Error('更新任务无效');
  if(!Number.isSafeInteger(job.artifactSize)||(job.artifactSize??0)<1||typeof job.artifactSha256!=='string'||!/^[a-f0-9]{64}$/.test(job.artifactSha256))throw Error('更新安装包校验信息无效');
  for(const key of ['updatesDirectory','artifactPath','applicationPath','executablePath','backupPath','helperRuntimePath','readyPath','armPath','startupRequestPath','startupAckPath','receiptPath','errorPath'] as const)if(typeof job[key]!=='string'||!isAbsolute(job[key]!))throw Error('更新任务路径无效');
  const jobName=basenameSafe(jobPath),idMatch=/^install-([a-zA-Z0-9-]{1,80})\.json$/.exec(jobName),jobId=idMatch?.[1];if(!jobId)throw Error('更新任务文件名无效');
  if(resolve(dirname(jobPath))!==resolve(job.updatesDirectory!)||!inside(job.updatesDirectory!,jobPath)||!inside(job.updatesDirectory!,job.artifactPath!)||!inside(job.updatesDirectory!,job.helperRuntimePath!)||basenameSafe(job.helperRuntimePath!)!==`helper-runtime-${jobId}`||resolve(job.readyPath!)!==resolve(jobPath+'.ready')||resolve(job.armPath!)!==resolve(jobPath+'.armed')||resolve(job.startupRequestPath!)!==resolve(job.updatesDirectory!,'startup-request.json')||resolve(job.startupAckPath!)!==resolve(job.updatesDirectory!,'startup-ack')||resolve(job.receiptPath!)!==resolve(job.updatesDirectory!,'installed.json')||resolve(job.errorPath!)!==resolve(job.updatesDirectory!,'install-error.json'))throw Error('更新任务超出受控目录');
  if(job.platform==='darwin-arm64'){
    if(typeof job.stagedApplicationPath!=='string'||typeof job.stagedTreeSha256!=='string'||!/^[a-f0-9]{64}$/.test(job.stagedTreeSha256)||!isAbsolute(job.stagedApplicationPath)||resolve(job.applicationPath!)===resolve(job.backupPath!)||basenameSafe(job.backupPath!)!=='.'+basenameSafe(job.applicationPath!)+`.linkflow-backup-${jobId}`||resolve(dirname(job.applicationPath!))!==resolve(dirname(job.backupPath!))||resolve(dirname(dirname(job.stagedApplicationPath)))!==resolve(dirname(job.applicationPath!))||basenameSafe(dirname(job.stagedApplicationPath))!==`.linkflow-update-${job.targetVersion}`||basenameSafe(job.stagedApplicationPath)!==basenameSafe(job.applicationPath!))throw Error('macOS 更新任务路径无效');
  }else if(resolve(job.applicationPath!)===resolve(job.backupPath!)||resolve(job.applicationPath!)!==resolve(dirname(job.executablePath!))||resolve(dirname(job.applicationPath!))!==resolve(dirname(job.backupPath!))||basenameSafe(job.backupPath!)!==`.linkflow-backup-${jobId}`)throw Error('Windows 更新任务路径无效');
  return job as UpdateHelperJob;
}
function execute(file:string,args:string[]):Promise<string>{return new Promise((done,reject)=>execFile(file,args,{timeout:120_000,maxBuffer:1024*1024,encoding:'utf8'},(error,stdout)=>error?reject(error):done(stdout)))}
async function extractMacArchive(descriptor:number,destination:string):Promise<void>{await executeWithUpdateDescriptor('/usr/bin/ditto',['-x','-k','--noqtn',destination],descriptor,{descriptorIndex:3,timeoutMs:120_000,maxBuffer:1024*1024})}
interface ArchiveIdentity {dev:bigint;ino:bigint;nlink:bigint;mode:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint}
function archiveIdentity(info:BigIntStats):ArchiveIdentity{return {dev:info.dev,ino:info.ino,nlink:info.nlink,mode:info.mode,size:info.size,mtimeNs:info.mtimeNs,ctimeNs:info.ctimeNs}}
function sameArchiveIdentity(left:ArchiveIdentity,right:ArchiveIdentity):boolean{return left.dev===right.dev&&left.ino===right.ino&&left.nlink===right.nlink&&left.mode===right.mode&&left.size===right.size&&left.mtimeNs===right.mtimeNs&&left.ctimeNs===right.ctimeNs}
async function hashDescriptor(handle:Awaited<ReturnType<typeof open>>,size:number):Promise<string>{const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let position=0;while(position<size){const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,size-position),position);if(bytesRead<1)throw Error('macOS 更新安装包读取中断');hash.update(buffer.subarray(0,bytesRead));position+=bytesRead}return hash.digest('hex')}
async function copyDescriptor(source:Awaited<ReturnType<typeof open>>,destination:Awaited<ReturnType<typeof open>>,size:number):Promise<string>{const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let position=0;while(position<size){const {bytesRead}=await source.read(buffer,0,Math.min(buffer.length,size-position),position);if(bytesRead<1)throw Error('macOS 更新安装包复制中断');hash.update(buffer.subarray(0,bytesRead));let written=0;while(written<bytesRead){const result=await destination.write(buffer,written,bytesRead-written,position+written);if(result.bytesWritten<1)throw Error('macOS 更新安装包复制中断');written+=result.bytesWritten}position+=bytesRead}return hash.digest('hex')}
function assertBaseJob(input:{platform:UpdatePlatform;oldPid:number;targetVersion:string;updatesDirectory:string;artifactPath:string;applicationPath:string;executablePath:string}){
  if(!Number.isSafeInteger(input.oldPid)||input.oldPid<1||!versionPattern.test(input.targetVersion))throw Error('无法创建安全的更新任务');
  for(const path of [input.updatesDirectory,input.artifactPath,input.applicationPath,input.executablePath])if(!isAbsolute(path))throw Error('更新路径无效');
  if(!inside(input.updatesDirectory,input.artifactPath))throw Error('安装包不在受控更新目录中');
}
export function macApplicationPath(executablePath:string):string|undefined{
  const marker=`.app${sep}Contents${sep}MacOS${sep}`,index=executablePath.lastIndexOf(marker);return index<0?undefined:executablePath.slice(0,index+4);
}
export async function prepareInstallJob(input:{platform:UpdatePlatform;oldPid:number;targetVersion:string;updatesDirectory:string;artifactPath:string;artifactSize:number;artifactSha256:string;applicationPath:string;executablePath:string;helperPath:string},ports:InstallPorts={}):Promise<{job:UpdateHelperJob;jobPath:string;launchExecutablePath:string;launchHelperPath:string}>{
  assertBaseJob(input);const files={...realFiles,...ports.files},run=ports.execute??execute,extractArchive=ports.extractMacArchive??extractMacArchive,id=(ports.uuid??randomUUID)(),parent=dirname(input.applicationPath);
  if(!Number.isSafeInteger(input.artifactSize)||input.artifactSize<1||!/^[a-f0-9]{64}$/.test(input.artifactSha256)||!isAbsolute(input.helperPath)||!inside(input.applicationPath,input.helperPath))throw Error('更新助手或安装包信息无效');
  await files.access(input.artifactPath,fsConstants.R_OK);await files.mkdir(input.updatesDirectory,{recursive:true,mode:0o700});
  const token=(ports.uuid??randomUUID)(),jobPath=join(input.updatesDirectory,`install-${id}.json`),common={schemaVersion:1 as const,token,platform:input.platform,oldPid:input.oldPid,targetVersion:input.targetVersion,updatesDirectory:input.updatesDirectory,artifactPath:input.artifactPath,artifactSize:input.artifactSize,artifactSha256:input.artifactSha256,applicationPath:input.applicationPath,executablePath:input.executablePath,helperRuntimePath:join(input.updatesDirectory,`helper-runtime-${id}`),readyPath:jobPath+'.ready',armPath:jobPath+'.armed',startupRequestPath:join(input.updatesDirectory,'startup-request.json'),startupAckPath:join(input.updatesDirectory,'startup-ack'),receiptPath:join(input.updatesDirectory,'installed.json'),errorPath:join(input.updatesDirectory,'install-error.json')};
  let job:UpdateHelperJob;
  if(input.platform==='darwin-arm64'){
    if(extname(input.applicationPath)!=='.app'||macApplicationPath(input.executablePath)!==input.applicationPath||!inside(input.applicationPath,input.executablePath))throw Error('当前应用不是可原地更新的 macOS 应用');
    await files.access(parent,fsConstants.W_OK);const stageRoot=join(parent,`.linkflow-update-${input.targetVersion}`),freshRoot=join(parent,`.linkflow-update-${input.targetVersion}-fresh-${id}`),snapshotPath=join(freshRoot,'.verified-update.zip'),stagedApplicationPath=join(stageRoot,basename(input.applicationPath)),freshApplicationPath=join(freshRoot,basename(input.applicationPath)),backupPath=join(parent,`.${basename(input.applicationPath)}.linkflow-backup-${id}`);
    try{
      await files.rm(freshRoot,{recursive:true,force:true});await files.mkdir(freshRoot,{recursive:false,mode:0o700});const archivePathInfo=await files.lstat(input.artifactPath,{bigint:true}),expectedArchive=archiveIdentity(archivePathInfo);if(!archivePathInfo.isFile()||archivePathInfo.isSymbolicLink()||archivePathInfo.nlink!==1n||archivePathInfo.size!==BigInt(input.artifactSize))throw Error('macOS 更新安装包路径或大小无效');const archiveHandle=await files.open(input.artifactPath,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);
      try{
        const openedArchive=archiveIdentity(await archiveHandle.stat({bigint:true}));if(!sameArchiveIdentity(expectedArchive,openedArchive)||await hashDescriptor(archiveHandle,input.artifactSize)!==input.artifactSha256||!sameArchiveIdentity(openedArchive,archiveIdentity(await archiveHandle.stat({bigint:true}))))throw Error('macOS 更新安装包完整性复验失败');
        const snapshotHandle=await files.open(snapshotPath,fsConstants.O_RDWR|fsConstants.O_CREAT|fsConstants.O_EXCL|fsConstants.O_NOFOLLOW,0o600);let snapshotUnlinked=false;
        try{
          await files.unlink(snapshotPath);snapshotUnlinked=true;if((await snapshotHandle.stat({bigint:true})).nlink!==0n)throw Error('macOS 更新安装包快照无法锁定');if(await copyDescriptor(archiveHandle,snapshotHandle,input.artifactSize)!==input.artifactSha256)throw Error('macOS 更新安装包完整性复验失败');await snapshotHandle.sync();const verifiedSnapshot=archiveIdentity(await snapshotHandle.stat({bigint:true}));if(verifiedSnapshot.nlink!==0n||verifiedSnapshot.size!==BigInt(input.artifactSize)||await hashDescriptor(snapshotHandle,input.artifactSize)!==input.artifactSha256)throw Error('macOS 更新安装包完整性复验失败');
          const sourceAfterCopy=archiveIdentity(await archiveHandle.stat({bigint:true}));if(!sameArchiveIdentity(openedArchive,sourceAfterCopy)||await hashDescriptor(archiveHandle,input.artifactSize)!==input.artifactSha256)throw Error('macOS 更新安装包在复制期间发生变化');await extractArchive(snapshotHandle.fd,freshRoot);if(!sameArchiveIdentity(verifiedSnapshot,archiveIdentity(await snapshotHandle.stat({bigint:true})))||await hashDescriptor(snapshotHandle,input.artifactSize)!==input.artifactSha256)throw Error('macOS 更新安装包快照在解包期间发生变化');
        }finally{await snapshotHandle.close();if(!snapshotUnlinked)await files.rm(snapshotPath,{force:true})}
        const afterExtraction=archiveIdentity(await archiveHandle.stat({bigint:true})),afterPath=await files.lstat(input.artifactPath,{bigint:true});if(!sameArchiveIdentity(openedArchive,afterExtraction)||!sameArchiveIdentity(openedArchive,archiveIdentity(afterPath))||!afterPath.isFile()||afterPath.isSymbolicLink()||afterPath.nlink!==1n||await hashDescriptor(archiveHandle,input.artifactSize)!==input.artifactSha256)throw Error('macOS 更新安装包在解包期间发生变化');
      }finally{await archiveHandle.close()}
      const topLevel=await files.readdir(freshRoot,{withFileTypes:true});if(topLevel.length!==1||topLevel[0].name!==basename(input.applicationPath)||!topLevel[0].isDirectory()||topLevel[0].isSymbolicLink())throw Error('macOS 更新压缩包顶层结构无效');const freshTreeSha256=await hashUpdateTree(freshApplicationPath);
      await files.rm(stageRoot,{recursive:true,force:true});await files.rename(freshRoot,stageRoot);
      if((await files.stat(stageRoot)).dev!==(await files.stat(parent)).dev)throw Error('更新暂存目录与应用不在同一磁盘');
      const info=await files.lstat(stagedApplicationPath);if(!info.isDirectory()||info.isSymbolicLink())throw Error('更新压缩包不含预期的应用');
      const executableRelative=relative(input.applicationPath,input.executablePath),stagedExecutable=join(stagedApplicationPath,executableRelative),executableInfo=await files.lstat(stagedExecutable);if(!executableInfo.isFile()||executableInfo.isSymbolicLink())throw Error('更新应用缺少可执行文件');
      await verifyVerifiedMacStageQuarantineFree({updatesDirectory:input.updatesDirectory,artifactPath:input.artifactPath,artifactSize:input.artifactSize,artifactSha256:input.artifactSha256,applicationPath:input.applicationPath,executablePath:input.executablePath,stagedApplicationPath,targetVersion:input.targetVersion,treeSha256:freshTreeSha256},{execute:run});
      job={...common,backupPath,stagedApplicationPath,stagedTreeSha256:freshTreeSha256};
    }catch(error){await Promise.allSettled([files.rm(freshRoot,{recursive:true,force:true}),files.rm(stageRoot,{recursive:true,force:true})]);throw error}
  }else{
    const installDirectory=dirname(input.executablePath);if(input.applicationPath!==installDirectory||extname(input.executablePath).toLowerCase()!=='.exe'||!inside(installDirectory,input.executablePath))throw Error('当前应用不是可原地更新的 Windows 安装');
    await files.access(parent,fsConstants.W_OK);const backupPath=join(parent,`.linkflow-backup-${id}`);await files.cp(installDirectory,backupPath,{recursive:true,errorOnExist:true,force:false,verbatimSymlinks:true});job={...common,backupPath};
  }
  try{
    const runtimeApplicationPath=join(job.helperRuntimePath,basename(input.applicationPath));await files.mkdir(job.helperRuntimePath,{recursive:false,mode:0o700});const helperBytes=await files.readBundledFile(input.helperPath);if(helperBytes.length<1||helperBytes.length>8*1024*1024)throw Error('已打包的更新助手无效');await files.cp(input.applicationPath,runtimeApplicationPath,{recursive:true,errorOnExist:true,force:false,verbatimSymlinks:true});
    const executableRelative=relative(input.applicationPath,input.executablePath);let launchExecutablePath=join(runtimeApplicationPath,executableRelative);const launchHelperPath=join(job.helperRuntimePath,'update-helper.cjs');const executableInfo=await files.lstat(launchExecutablePath);if(!executableInfo.isFile()||executableInfo.isSymbolicLink())throw Error('私有更新助手副本不完整');await files.writeFile(launchHelperPath,helperBytes,{mode:0o600,flag:'wx'});
    if(input.platform==='win32-x64'){const distinctExecutable=join(dirname(launchExecutablePath),'linkflow-update-helper-runtime.exe');await files.rename(launchExecutablePath,distinctExecutable);launchExecutablePath=distinctExecutable}
    const temporary=jobPath+'.tmp';await files.writeFile(temporary,JSON.stringify(job),{mode:0o600,flag:'wx'});await files.rename(temporary,jobPath);return {job,jobPath,launchExecutablePath,launchHelperPath};
  }catch(error){const cleanup=[files.rm(job.helperRuntimePath,{recursive:true,force:true})];if(input.platform==='win32-x64')cleanup.push(files.rm(job.backupPath,{recursive:true,force:true}));await Promise.allSettled(cleanup);throw error}
}
