import {createHash,randomUUID} from 'node:crypto';
import type {KeyObject} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,mkdir,open,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {UpdateAsset,UpdateInstallHandoff,UpdateManifest,UpdatePlatform,UpdateState} from '../shared/update-types';
import {compareVersions,fetchVerifiedManifest,fetchWithPinnedRedirects,parseUpdateManifest,UpdateError,verifyManifestSignature} from './update-network';
import {prepareInstallJob,validateUpdateHelperJob,type InstallPorts,type UpdateHelperJob} from './update-install';
import {updateRawFs} from './update-files';
import {hashUpdateTree} from './update-tree';

interface PreparedRecord {schemaVersion:1;manifest:string;signature:string;artifactFile:string}
interface Receipt {schemaVersion:1;targetVersion:string;installedAt:string;cleanupPath?:string;backupCleanupPath?:string;recoveryJobCleanupPath?:string}
interface InstallError {schemaVersion:1;targetVersion:string;failedAt:string;message:string;cleanupPath?:string;recoveryJobPath?:string}
interface StartupRequest {schemaVersion:1;targetVersion:string;token:string}
interface StartupAck {schemaVersion:2;targetVersion:string;token:string;pid:number;applicationPath:string;executablePath:string}
interface SupersededRecoveryRecord {
  schemaVersion:1;
  status:'superseded';
  supersededAt:string;
  oldTargetVersion:string;
  currentVersion:string;
  currentPublishedAt:string;
  frozenJobSha256:string;
  frozenErrorSha256:string;
  frozenRequestSha256:string;
  frozenArtifactSha256:string;
  signedManifestSha256:string;
  signedArtifactSha256:string;
  signedArtifactSize:number;
  currentTreeSha256:string;
  runtimeTranslocated:boolean;
}
export interface UpdateFilePorts {lstat:typeof lstat;mkdir:typeof mkdir;open:typeof open;readFile:typeof readFile;realpath:typeof realpath;rename:typeof rename;rm:typeof rm;writeFile:typeof writeFile;createReadStream:typeof createReadStream}
export interface MacRecoveryPorts {execute:(file:string,args:string[])=>Promise<string>;hashTree:(root:string)=>Promise<string>;isAlive:(pid:number)=>boolean}
export interface UpdateManagerOptions {
  currentVersion:string;
  platform:NodeJS.Platform;
  arch:string;
  packaged:boolean;
  unsupportedReason?:string;
  updatesDirectory:string;
  applicationPath:string;
  executablePath:string;
  runtimeApplicationPath?:string;
  runtimeExecutablePath?:string;
  helperPath:string;
  publicKey:string|Buffer|KeyObject;
  request?:typeof fetch;
  emit?:(state:UpdateState)=>void;
  files?:Partial<UpdateFilePorts>;
  installPorts?:InstallPorts;
  recoveryPorts?:Partial<MacRecoveryPorts>;
  launchHelper?:(executable:string,args:string[],environment:NodeJS.ProcessEnv)=>{pid?:number;once?:(event:string,listener:(error?:Error)=>void)=>unknown;unref?:()=>void};
  now?:()=>Date;
  pid?:number;
}
const rawFs=updateRawFs(),rawPromises=rawFs.promises;
const realFiles:UpdateFilePorts={lstat:rawPromises.lstat as typeof lstat,mkdir:rawPromises.mkdir as typeof mkdir,open:rawPromises.open as typeof open,readFile:rawPromises.readFile as typeof readFile,realpath:rawPromises.realpath as typeof realpath,rename:rawPromises.rename as typeof rename,rm:rawPromises.rm as typeof rm,writeFile:rawPromises.writeFile as typeof writeFile,createReadStream:rawFs.createReadStream as typeof createReadStream};
const realRecoveryPorts:MacRecoveryPorts={execute:(file,args)=>new Promise((done,reject)=>execFile(file,args,{timeout:60_000,maxBuffer:8*1024*1024,encoding:'utf8',shell:false},(error,stdout)=>error?reject(error):done(stdout))),hashTree:hashUpdateTree,isAlive:pid=>{try{process.kill(pid,0);return true}catch(error){return (error as NodeJS.ErrnoException).code==='EPERM'}}};
const controlledMessage=(error:unknown,fallback:string)=>error instanceof UpdateError&&error.message?error.message:fallback;
function inside(parent:string,child:string):boolean{const path=relative(resolve(parent),resolve(child));return !!path&&path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path)}
function commandMatches(command:string,executablePath:string):boolean{return command.trim()===executablePath||command.trim().startsWith(executablePath+' ')}
function macShape(applicationPath:string,executablePath:string,expectedApplicationPath:string,expectedExecutablePath:string):boolean{return basename(applicationPath)===basename(expectedApplicationPath)&&relative(applicationPath,executablePath)===relative(expectedApplicationPath,expectedExecutablePath)}
function confirmedTranslocation(applicationPath:string,mountOutput:string):boolean{const resolved=resolve(applicationPath);if(!resolved.startsWith('/private/var/folders/')||!resolved.includes('/AppTranslocation/'))return false;for(const line of mountOutput.split('\n')){const marker=' on ',options=' (',on=line.indexOf(marker),open=line.indexOf(options,on+marker.length);if(on<0||open<0)continue;const mountPoint=line.slice(on+marker.length,open),flags=line.slice(open+2,-1).split(',').map(value=>value.trim());if((resolved===mountPoint||resolved.startsWith(mountPoint+sep))&&flags.includes('nullfs')&&flags.includes('read-only')&&flags.includes('nobrowse'))return true}return false}
export function resolveUpdatePlatform(platform:NodeJS.Platform,arch:string):UpdatePlatform|undefined{return platform==='darwin'&&arch==='arm64'?'darwin-arm64':platform==='win32'&&arch==='x64'?'win32-x64':undefined}
function parseSmallJson<T>(data:Buffer|string,maximum:number):T{const text=typeof data==='string'?data:data.toString('utf8');if(Buffer.byteLength(text)>maximum)throw Error('更新状态文件过大');return JSON.parse(text) as T}
async function hashFile(path:string,streamFactory:typeof createReadStream):Promise<string>{const hash=createHash('sha256');for await(const chunk of streamFactory(path))hash.update(chunk as Buffer);return hash.digest('hex')}
function defaultLaunch(executable:string,args:string[],environment:NodeJS.ProcessEnv){const child=spawn(executable,args,{cwd:dirname(executable),detached:true,stdio:'ignore',shell:false,windowsHide:true,env:environment});child.unref();return child}

export class UpdateManager {
  private readonly files:UpdateFilePorts;
  private readonly recoveryPorts:MacRecoveryPorts;
  private readonly platform?:UpdatePlatform;
  private current:UpdateState;
  private verified?:{manifest:UpdateManifest;manifestBytes:Buffer;signature:Buffer};
  private artifactPath?:string;
  private recoveryPending=false;
  private recoverySupersedePromise?:Promise<UpdateState>;
  private downloadAbort?:AbortController;
  private downloadPromise?:Promise<UpdateState>;
  constructor(private options:UpdateManagerOptions){
    this.files={...realFiles,...options.files};this.recoveryPorts={...realRecoveryPorts,...options.recoveryPorts};this.platform=resolveUpdatePlatform(options.platform,options.arch);this.current={phase:'idle',currentVersion:options.currentVersion};
  }
  status():UpdateState{return structuredClone(this.current)}
  private set(next:UpdateState):UpdateState{this.current=next;try{this.options.emit?.(this.status())}catch{/* Notification failures must not roll back committed update state. */}return this.status()}
  private targetState(phase:UpdateState['phase'],extra:Partial<UpdateState>={}):UpdateState{
    const manifest=this.verified?.manifest;return {phase,currentVersion:this.options.currentVersion,targetVersion:manifest?.version,releaseNotes:manifest?.releaseNotes,publishedAt:manifest?.publishedAt,...extra};
  }
  private supported():boolean{
    if(!this.options.packaged){this.set({phase:'unsupported',currentVersion:this.options.currentVersion,error:'更新安装仅在已安装的正式客户端中可用'});return false}
    if(this.options.unsupportedReason){this.set({phase:'unsupported',currentVersion:this.options.currentVersion,error:this.options.unsupportedReason});return false}
    if(!this.platform){this.set({phase:'unsupported',currentVersion:this.options.currentVersion,error:`当前系统架构 ${this.options.platform}/${this.options.arch} 暂不支持应用内更新`});return false}return true;
  }
  async initialize():Promise<UpdateState>{
    if(!this.supported())return this.status();try{await this.files.mkdir(this.options.updatesDirectory,{recursive:true,mode:0o700});
    const failurePresent=await this.stateFilePresent('install-error.json'),failure=await this.readOptional<InstallError>('install-error.json',32*1024);
    if(failurePresent&&!this.validInstallError(failure)){this.recoveryPending=true;return this.lockRecovery()}
    if(failure?.schemaVersion===1&&failure.recoveryJobPath){this.recoveryPending=true;return this.lockRecovery(failure.targetVersion)}
    let prepared=false;try{prepared=await this.restorePrepared()}catch{await this.clearPrepared()}
    const receipt=await this.readOptional<Receipt>('installed.json',16*1024);
    if(failure?.schemaVersion===1&&!failure.recoveryJobPath)await this.cleanupRuntime(failure.cleanupPath);
    if(prepared){if(failure?.schemaVersion===1&&failure.targetVersion===this.verified?.manifest.version)this.set(this.targetState('prepared',{retryable:true,error:'上次安装未完成，已保留经过验证的安装包'}));return this.status()}
    if(receipt?.schemaVersion===1&&receipt.targetVersion===this.options.currentVersion&&!Number.isNaN(Date.parse(receipt.installedAt))){const recoveryPathValid=!receipt.recoveryJobCleanupPath||this.validRecoveryPath(receipt.recoveryJobCleanupPath);if(recoveryPathValid&&await this.cleanupRuntime(receipt.cleanupPath)&&await this.cleanupBackup(receipt.backupCleanupPath)&&await this.cleanupRecoveryJob(receipt.recoveryJobCleanupPath)){await Promise.allSettled([this.files.rm(join(this.options.updatesDirectory,'startup-request.json'),{force:true}),this.files.rm(join(this.options.updatesDirectory,'startup-ack'),{force:true})]);await this.files.rm(join(this.options.updatesDirectory,'installed.json'),{force:true})}return this.set({phase:'installed',currentVersion:this.options.currentVersion,targetVersion:receipt.targetVersion})}
    if(receipt?.schemaVersion===1&&/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(receipt.targetVersion)&&compareVersions(receipt.targetVersion,this.options.currentVersion)>0)return this.set({phase:'failed',currentVersion:this.options.currentVersion,targetVersion:receipt.targetVersion,retryable:true,error:'安装助手已运行，但当前应用版本没有更新'});
    if(failure?.schemaVersion===1&&typeof failure.targetVersion==='string'&&typeof failure.message==='string')return this.set({phase:'failed',currentVersion:this.options.currentVersion,targetVersion:failure.targetVersion,retryable:!failure.recoveryJobPath,error:failure.recoveryJobPath?'新版本启动身份未能确认，已保留恢复副本；请重新打开应用，如仍提示失败请联系支持':'安装未能完成，旧版本已保留'});
    return this.set({phase:'idle',currentVersion:this.options.currentVersion})}catch{return this.set({phase:'failed',currentVersion:this.options.currentVersion,retryable:true,error:'无法读取本机更新状态，其他功能可继续使用'})}
  }
  async acknowledgeStartup():Promise<boolean>{
    if(this.recoverySupersedePromise)return false;
    const failurePresent=await this.stateFilePresent('install-error.json'),priorFailure=await this.readOptional<InstallError>('install-error.json',32*1024),request=await this.readOptional<StartupRequest>('startup-request.json',16*1024);
    if(failurePresent&&!this.validInstallError(priorFailure)){this.recoveryPending=true;this.lockRecovery();return false}
    if(priorFailure?.recoveryJobPath){this.recoveryPending=true;if(!this.validStartupRequest(request)){this.lockRecovery(priorFailure.targetVersion);return false}if(await this.recoverLateMacStartup(priorFailure,request!))return true;this.lockRecovery(priorFailure.targetVersion);return false}
    if(!this.validStartupRequest(request))return false;
    const ack:StartupAck={schemaVersion:2,targetVersion:request.targetVersion,token:request.token,pid:this.options.pid??process.pid,applicationPath:this.options.runtimeApplicationPath??this.options.applicationPath,executablePath:this.options.runtimeExecutablePath??this.options.executablePath};
    const path=join(this.options.updatesDirectory,'startup-ack'),temporary=path+'.tmp',contents=this.platform==='darwin-arm64'?JSON.stringify(ack):request.token;await this.files.rm(temporary,{force:true});await this.files.writeFile(temporary,contents,{mode:0o600,flag:'wx'});await this.files.rename(temporary,path);this.set({phase:'installed',currentVersion:this.options.currentVersion,targetVersion:request.targetVersion});return true;
  }
  supersedeRecovery():Promise<UpdateState>{
    if(this.recoverySupersedePromise)return this.recoverySupersedePromise;
    if(this.downloadPromise||['checking','downloading','installing'].includes(this.current.phase))return Promise.reject(Error('更新操作正在进行'));
    if(!this.recoveryPending)return Promise.reject(Error('当前没有待归档的 macOS 恢复事务'));
    if(!this.options.packaged||this.options.unsupportedReason||this.platform!=='darwin-arm64')return Promise.reject(Error('只能在已安装的 Apple Silicon macOS 正式客户端中恢复'));
    const operation=this.performSupersedeRecovery().catch(()=>{this.recoveryPending=true;this.lockRecovery(this.current.targetVersion);throw Error('无法验证当前正式版本；旧更新事务仍保持锁定')});
    this.recoverySupersedePromise=operation;const clear=()=>{if(this.recoverySupersedePromise===operation)this.recoverySupersedePromise=undefined};void operation.then(clear,clear);return operation;
  }
  private async performSupersedeRecovery():Promise<UpdateState>{
    await this.files.mkdir(this.options.updatesDirectory,{recursive:true,mode:0o700});
    const errorPath=join(this.options.updatesDirectory,'install-error.json'),errorRaw=await this.readBoundedFile(errorPath,32*1024),failure=parseSmallJson<InstallError>(errorRaw,32*1024);
    if(!this.validInstallError(failure)||!this.validRecoveryPath(failure.recoveryJobPath))throw Error('invalid recovery error');
    const jobPath=failure.recoveryJobPath!,jobRaw=await this.readBoundedFile(jobPath,64*1024),job=validateUpdateHelperJob(parseSmallJson<unknown>(jobRaw,64*1024),jobPath),requestRaw=await this.readBoundedFile(job.startupRequestPath,16*1024),request=parseSmallJson<StartupRequest>(requestRaw,16*1024);
    if(!this.frozenRecoveryMatches(jobPath,job,failure,request)||compareVersions(job.targetVersion,this.options.currentVersion)>=0)throw Error('recovery transaction is not an older frozen job');
    if(!await this.frozenRecoveryMaterialsValid(job,jobPath))throw Error('recovery transaction is incomplete');

    const verified=await fetchVerifiedManifest(this.options.publicKey,{request:this.options.request,timeoutMs:30_000}),asset=verified.manifest.assets['darwin-arm64'];
    if(verified.manifest.version!==this.options.currentVersion||!asset)throw Error('current version has no signed published artifact');

    const id=randomUUID(),jobId=basename(jobPath).slice('install-'.length,-'.json'.length),archiveName=`superseded-${jobId}-by-${this.options.currentVersion}-${id}`,archiveTemporary=join(this.options.updatesDirectory,'.'+archiveName+'.tmp'),archivePath=join(this.options.updatesDirectory,archiveName),verificationRoot=join(this.options.updatesDirectory,`.supersede-verify-${id}`),officialArtifactPath=join(archiveTemporary,`Linkflow-${this.options.currentVersion}-darwin-arm64.zip`);
    let archiveCommitted=false;
    try{
      await this.files.mkdir(archiveTemporary,{recursive:false,mode:0o700});await this.files.mkdir(verificationRoot,{recursive:false,mode:0o700});
      await Promise.all([
        this.writeExclusive(join(archiveTemporary,'install-error.snapshot.json'),errorRaw),
        this.writeExclusive(join(archiveTemporary,'install-job.snapshot.json'),jobRaw),
        this.writeExclusive(join(archiveTemporary,'startup-request.snapshot.json'),requestRaw),
        this.writeExclusive(join(archiveTemporary,'signed-manifest.json'),verified.manifestBytes),
        this.writeExclusive(join(archiveTemporary,'signed-manifest.sig'),verified.signature)
      ]);
      await this.downloadRecoveryArtifact(asset,officialArtifactPath);
      await this.recoveryPorts.execute('/usr/bin/ditto',['-x','-k','--norsrc',officialArtifactPath,verificationRoot]);
      const officialApplicationPath=join(verificationRoot,basename(this.options.applicationPath)),executableRelative=relative(this.options.applicationPath,this.options.executablePath);
      if(!inside(this.options.applicationPath,this.options.executablePath))throw Error('current executable path is invalid');
      const identity=await this.verifySupersedingIdentity(job,officialApplicationPath,join(officialApplicationPath,executableRelative));
      if(!identity)throw Error('current application identity does not match the official artifact');
      const officialArtifactInfo=await this.files.lstat(officialArtifactPath);if(!officialArtifactInfo.isFile()||officialArtifactInfo.isSymbolicLink()||officialArtifactInfo.size!==asset.size||await hashFile(officialArtifactPath,this.files.createReadStream)!==asset.sha256)throw Error('official artifact changed during verification');
      if(!await this.frozenRecoveryMaterialsValid(job,jobPath)||!this.recoveryPorts.isAlive(this.options.pid??process.pid))throw Error('recovery transaction changed during verification');
      const currentErrorRaw=await this.readBoundedFile(errorPath,32*1024),currentJobRaw=await this.readBoundedFile(jobPath,64*1024),currentRequestRaw=await this.readBoundedFile(job.startupRequestPath,16*1024);
      if(this.digest(currentErrorRaw)!==this.digest(errorRaw)||this.digest(currentJobRaw)!==this.digest(jobRaw)||this.digest(currentRequestRaw)!==this.digest(requestRaw))throw Error('recovery transaction changed during verification');
      const record:SupersededRecoveryRecord={schemaVersion:1,status:'superseded',supersededAt:(this.options.now?.()??new Date()).toISOString(),oldTargetVersion:job.targetVersion,currentVersion:this.options.currentVersion,currentPublishedAt:verified.manifest.publishedAt,frozenJobSha256:this.digest(jobRaw),frozenErrorSha256:this.digest(errorRaw),frozenRequestSha256:this.digest(requestRaw),frozenArtifactSha256:job.artifactSha256,signedManifestSha256:this.digest(verified.manifestBytes),signedArtifactSha256:asset.sha256,signedArtifactSize:asset.size,currentTreeSha256:identity.treeSha256,runtimeTranslocated:identity.runtimeTranslocated};
      await this.writeExclusive(join(archiveTemporary,'superseded.json'),Buffer.from(JSON.stringify(record)));
      await this.files.rm(verificationRoot,{recursive:true,force:true});
      await this.files.rename(archiveTemporary,archivePath);archiveCommitted=true;
      if(this.digest(await this.readBoundedFile(errorPath,32*1024))!==record.frozenErrorSha256||this.digest(await this.readBoundedFile(jobPath,64*1024))!==record.frozenJobSha256||this.digest(await this.readBoundedFile(job.startupRequestPath,16*1024))!==record.frozenRequestSha256||!this.recoveryPorts.isAlive(this.options.pid??process.pid))throw Error('recovery transaction changed before archive commit');
      await this.files.rename(errorPath,join(archivePath,'install-error.original.json'));
      this.verified=verified;this.artifactPath=undefined;this.recoveryPending=false;
      return this.set({phase:'up-to-date',currentVersion:this.options.currentVersion,targetVersion:this.options.currentVersion,releaseNotes:verified.manifest.releaseNotes,publishedAt:verified.manifest.publishedAt,checkedAt:(this.options.now?.()??new Date()).toISOString(),recoveryPending:false});
    }finally{
      await this.files.rm(verificationRoot,{recursive:true,force:true}).catch(()=>{});if(!archiveCommitted)await this.files.rm(archiveTemporary,{recursive:true,force:true}).catch(()=>{});
    }
  }
  private frozenRecoveryMatches(jobPath:string,job:UpdateHelperJob,failure:InstallError,request:StartupRequest):boolean{
    return job.platform==='darwin-arm64'&&failure.targetVersion===job.targetVersion&&resolve(failure.recoveryJobPath!)===resolve(jobPath)&&request.schemaVersion===1&&request.targetVersion===job.targetVersion&&request.token===job.token&&resolve(job.updatesDirectory)===resolve(this.options.updatesDirectory)&&resolve(job.applicationPath)===resolve(this.options.applicationPath)&&resolve(job.executablePath)===resolve(this.options.executablePath)&&resolve(job.errorPath)===resolve(this.options.updatesDirectory,'install-error.json')&&resolve(job.receiptPath)===resolve(this.options.updatesDirectory,'installed.json')&&typeof failure.cleanupPath==='string'&&resolve(failure.cleanupPath)===resolve(job.helperRuntimePath);
  }
  private async frozenRecoveryMaterialsValid(job:UpdateHelperJob,jobPath:string):Promise<boolean>{
    try{
      if(await this.pathPresent(job.readyPath)||await this.pathPresent(job.armPath)||await this.pathPresent(job.startupAckPath)||await this.pathPresent(job.receiptPath)||this.recoveryPorts.isAlive(job.oldPid)||await this.recoveryHelperActive(job,jobPath))return false;
      const artifactInfo=await this.files.lstat(job.artifactPath),backupInfo=await this.files.lstat(job.backupPath),runtimeInfo=await this.files.lstat(job.helperRuntimePath),backupExecutable=resolve(job.backupPath,relative(job.applicationPath,job.executablePath)),backupExecutableInfo=await this.files.lstat(backupExecutable);
      return artifactInfo.isFile()&&!artifactInfo.isSymbolicLink()&&artifactInfo.size===job.artifactSize&&await hashFile(job.artifactPath,this.files.createReadStream)===job.artifactSha256&&backupInfo.isDirectory()&&!backupInfo.isSymbolicLink()&&backupExecutableInfo.isFile()&&!backupExecutableInfo.isSymbolicLink()&&runtimeInfo.isDirectory()&&!runtimeInfo.isSymbolicLink();
    }catch{return false}
  }
  private async recoveryHelperActive(job:UpdateHelperJob,jobPath:string):Promise<boolean>{
    const processes=await this.recoveryPorts.execute('/bin/ps',['-axo','pid=,command=']),currentPid=this.options.pid??process.pid;
    for(const line of processes.split('\n')){const match=/^\s*(\d+)\s+(.+)$/.exec(line);if(!match||Number(match[1])===currentPid)continue;const command=match[2];if(command.includes(job.helperRuntimePath+sep)||command.includes(jobPath))return true}return false;
  }
  private async verifySupersedingIdentity(job:UpdateHelperJob,officialApplicationPath:string,officialExecutablePath:string):Promise<{treeSha256:string;runtimeTranslocated:boolean}|undefined>{
    try{
      const pid=this.options.pid??process.pid,runtimeApplicationPath=this.options.runtimeApplicationPath??this.options.applicationPath,runtimeExecutablePath=this.options.runtimeExecutablePath??this.options.executablePath;
      if(pid===job.oldPid||!this.recoveryPorts.isAlive(pid)||!macShape(runtimeApplicationPath,runtimeExecutablePath,this.options.applicationPath,this.options.executablePath))return;
      const command=await this.recoveryPorts.execute('/bin/ps',['-p',String(pid),'-o','command=']);if(!commandMatches(command,runtimeExecutablePath))return;
      const applicationReal=await this.files.realpath(this.options.applicationPath),runtimeReal=await this.files.realpath(runtimeApplicationPath),runtimeTranslocated=applicationReal!==runtimeReal;
      if(runtimeTranslocated&&!confirmedTranslocation(runtimeApplicationPath,await this.recoveryPorts.execute('/sbin/mount',[])))return;
      const treeSha256=await this.recoveryPorts.hashTree(officialApplicationPath);if(!/^[a-f0-9]{64}$/.test(treeSha256))return;
      if(!await this.verifyRecoveryBundle(officialApplicationPath,officialExecutablePath,this.options.currentVersion,treeSha256,false)||!await this.verifyRecoveryBundle(this.options.applicationPath,this.options.executablePath,this.options.currentVersion,treeSha256,true)||!await this.verifyRecoveryBundle(runtimeApplicationPath,runtimeExecutablePath,this.options.currentVersion,treeSha256,false)||!this.recoveryPorts.isAlive(pid))return;
      const finalCommand=await this.recoveryPorts.execute('/bin/ps',['-p',String(pid),'-o','command=']);if(!commandMatches(finalCommand,runtimeExecutablePath)||!this.recoveryPorts.isAlive(pid))return;
      return {treeSha256,runtimeTranslocated};
    }catch{return}
  }
  private async downloadRecoveryArtifact(asset:UpdateAsset,destination:string):Promise<void>{
    const partial=destination+'.part';let handle:Awaited<ReturnType<typeof open>>|undefined;
    try{
      const response=await fetchWithPinnedRedirects(asset.url,{request:this.options.request,timeoutMs:10*60_000});if(!response.ok||!response.body)throw Error('official artifact download failed');const declared=Number(response.headers.get('content-length')??'0');if(declared&&declared!==asset.size)throw Error('official artifact size mismatch');
      handle=await this.files.open(partial,'wx',0o600);const reader=response.body.getReader(),hash=createHash('sha256');let received=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;received+=value.byteLength;if(received>asset.size)throw Error('official artifact is too large');const chunk=Buffer.from(value);hash.update(chunk);for(let offset=0;offset<chunk.length;){const {bytesWritten}=await handle.write(chunk,offset,chunk.length-offset);if(bytesWritten<1)throw Error('official artifact write stopped');offset+=bytesWritten}}}finally{reader.releaseLock()}
      await handle.sync();await handle.close();handle=undefined;if(received!==asset.size||hash.digest('hex')!==asset.sha256)throw Error('official artifact hash mismatch');await this.files.rename(partial,destination);
    }catch(error){try{await handle?.close()}catch{}await this.files.rm(partial,{force:true}).catch(()=>{});throw error}
  }
  private async readBoundedFile(path:string,maximum:number):Promise<Buffer>{const info=await this.files.lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>maximum)throw Error('invalid recovery state file');return this.files.readFile(path) as Promise<Buffer>}
  private writeExclusive(path:string,data:Buffer):Promise<void>{return this.files.writeFile(path,data,{mode:0o600,flag:'wx'})}
  private digest(data:Buffer):string{return createHash('sha256').update(data).digest('hex')}
  private validStartupRequest(value:StartupRequest|undefined):value is StartupRequest{return !!value&&value.schemaVersion===1&&value.targetVersion===this.options.currentVersion&&typeof value.token==='string'&&/^[a-f0-9-]{16,64}$/i.test(value.token)}
  private validInstallError(value:InstallError|undefined):value is InstallError{return !!value&&value.schemaVersion===1&&typeof value.targetVersion==='string'&&/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value.targetVersion)&&typeof value.failedAt==='string'&&!Number.isNaN(Date.parse(value.failedAt))&&typeof value.message==='string'&&(!value.cleanupPath||typeof value.cleanupPath==='string')&&(!value.recoveryJobPath||typeof value.recoveryJobPath==='string')}
  private lockRecovery(targetVersion?:string):UpdateState{return this.set({phase:'failed',currentVersion:this.options.currentVersion,targetVersion,retryable:false,recoveryPending:true,error:'新版本启动身份未能确认，已保留恢复副本；请重新打开应用，如仍提示失败请联系支持'})}
  private async stateFilePresent(name:string):Promise<boolean>{try{await this.files.lstat(join(this.options.updatesDirectory,name));return true}catch(error){return (error as NodeJS.ErrnoException).code!=='ENOENT'}}
  private async pathPresent(path:string):Promise<boolean>{try{await this.files.lstat(path);return true}catch(error){return (error as NodeJS.ErrnoException).code!=='ENOENT'}}
  private async verifyRecoveryBundle(applicationPath:string,executablePath:string,targetVersion:string,treeSha256:string,requireQuarantine:boolean):Promise<boolean>{
    try{
      const appInfo=await this.files.lstat(applicationPath),executableInfo=await this.files.lstat(executablePath);if(!appInfo.isDirectory()||appInfo.isSymbolicLink()||!executableInfo.isFile()||executableInfo.isSymbolicLink()||!inside(applicationPath,executablePath))return false;
      await this.recoveryPorts.execute('/usr/bin/codesign',['--verify','--deep','--strict',applicationPath]);const plist=join(applicationPath,'Contents','Info.plist'),identifier=(await this.recoveryPorts.execute('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',plist])).trim(),version=(await this.recoveryPorts.execute('/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw','-o','-',plist])).trim(),architectures=(await this.recoveryPorts.execute('/usr/bin/lipo',['-archs',executablePath])).trim().split(/\s+/);
      if(identifier!=='com.linkflow.personal'||version!==targetVersion||architectures.length!==1||architectures[0]!=='arm64')return false;
      if(requireQuarantine){const quarantine=(await this.recoveryPorts.execute('/usr/bin/xattr',['-p','com.apple.quarantine',applicationPath])).trim();if(!/^[0-9a-fA-F]{4};/.test(quarantine)||(Number.parseInt(quarantine.slice(0,4),16)&0x81)!==0x81)return false}
      return await this.recoveryPorts.hashTree(applicationPath)===treeSha256;
    }catch{return false}
  }
  private async recoverLateMacStartup(failure:InstallError,request:StartupRequest):Promise<boolean>{
    if(this.platform!=='darwin-arm64'||!this.validRecoveryPath(failure.recoveryJobPath)||failure.targetVersion!==this.options.currentVersion)return false;const jobPath=failure.recoveryJobPath!;
    try{
      const jobInfo=await this.files.lstat(jobPath);if(!jobInfo.isFile()||jobInfo.isSymbolicLink()||jobInfo.size>64*1024)return false;const job=validateUpdateHelperJob(parseSmallJson<unknown>(await this.files.readFile(jobPath),64*1024),jobPath);
      if(!this.recoveryJobMatches(job,failure,request)||await this.pathPresent(job.readyPath)||await this.pathPresent(job.armPath))return false;
      const artifactInfo=await this.files.lstat(job.artifactPath),backupInfo=await this.files.lstat(job.backupPath),runtimeInfo=await this.files.lstat(job.helperRuntimePath),backupExecutable=resolve(job.backupPath,relative(job.applicationPath,job.executablePath)),backupExecutableInfo=await this.files.lstat(backupExecutable);
      if(!artifactInfo.isFile()||artifactInfo.isSymbolicLink()||artifactInfo.size!==job.artifactSize||await hashFile(job.artifactPath,this.files.createReadStream)!==job.artifactSha256||!backupInfo.isDirectory()||backupInfo.isSymbolicLink()||!backupExecutableInfo.isFile()||backupExecutableInfo.isSymbolicLink()||!runtimeInfo.isDirectory()||runtimeInfo.isSymbolicLink())return false;
      const pid=this.options.pid??process.pid,runtimeApplicationPath=this.options.runtimeApplicationPath??this.options.applicationPath,runtimeExecutablePath=this.options.runtimeExecutablePath??this.options.executablePath;if(pid===job.oldPid||!this.recoveryPorts.isAlive(pid)||!macShape(runtimeApplicationPath,runtimeExecutablePath,job.applicationPath,job.executablePath))return false;
      const command=await this.recoveryPorts.execute('/bin/ps',['-p',String(pid),'-o','command=']);if(!commandMatches(command,runtimeExecutablePath))return false;
      const applicationReal=await this.files.realpath(job.applicationPath),runtimeReal=await this.files.realpath(runtimeApplicationPath),sameApplication=applicationReal===runtimeReal;
      if(!sameApplication){const mounts=await this.recoveryPorts.execute('/sbin/mount',[]);if(!confirmedTranslocation(runtimeApplicationPath,mounts))return false}
      if(!await this.verifyRecoveryBundle(job.applicationPath,job.executablePath,job.targetVersion,job.stagedTreeSha256!,true))return false;
      if(!sameApplication&&!await this.verifyRecoveryBundle(runtimeApplicationPath,runtimeExecutablePath,job.targetVersion,job.stagedTreeSha256!,false))return false;if(!this.recoveryPorts.isAlive(pid))return false;
      const ack:StartupAck={schemaVersion:2,targetVersion:job.targetVersion,token:job.token,pid,applicationPath:runtimeApplicationPath,executablePath:runtimeExecutablePath},receipt:Receipt={schemaVersion:1,targetVersion:job.targetVersion,installedAt:(this.options.now?.()??new Date()).toISOString(),cleanupPath:job.helperRuntimePath,backupCleanupPath:job.backupPath,recoveryJobCleanupPath:jobPath};await this.writeAtomic('startup-ack',ack);await this.writeAtomic('installed.json',receipt);
      try{await this.files.rm(join(this.options.updatesDirectory,'install-error.json'),{force:true})}catch{return false}
      this.recoveryPending=false;this.set({phase:'installed',currentVersion:this.options.currentVersion,targetVersion:job.targetVersion});return true;
    }catch{return false}
  }
  private recoveryJobMatches(job:UpdateHelperJob,failure:InstallError,request:StartupRequest):boolean{
    return job.platform==='darwin-arm64'&&job.targetVersion===this.options.currentVersion&&failure.targetVersion===job.targetVersion&&request.targetVersion===job.targetVersion&&request.token===job.token&&resolve(job.updatesDirectory)===resolve(this.options.updatesDirectory)&&resolve(job.applicationPath)===resolve(this.options.applicationPath)&&resolve(job.executablePath)===resolve(this.options.executablePath)&&resolve(job.errorPath)===resolve(this.options.updatesDirectory,'install-error.json')&&resolve(job.receiptPath)===resolve(this.options.updatesDirectory,'installed.json');
  }
  private async readOptional<T>(name:string,maximum:number):Promise<T|undefined>{try{const path=join(this.options.updatesDirectory,name),info=await this.files.lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>maximum)throw Error();return parseSmallJson<T>(await this.files.readFile(path),maximum)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;return}}
  private async restorePrepared():Promise<boolean>{
    const record=await this.readOptional<PreparedRecord>('prepared.json',2*1024*1024);if(!record||record.schemaVersion!==1||typeof record.manifest!=='string'||typeof record.signature!=='string'||typeof record.artifactFile!=='string'||basename(record.artifactFile)!==record.artifactFile)return false;
    const manifestBytes=Buffer.from(record.manifest,'base64'),signature=Buffer.from(record.signature,'ascii');verifyManifestSignature(manifestBytes,signature,this.options.publicKey);const manifest=parseUpdateManifest(manifestBytes),asset=this.platform&&manifest.assets[this.platform];
    if(!asset||compareVersions(manifest.version,this.options.currentVersion)<=0)return false;const artifactPath=join(this.options.updatesDirectory,record.artifactFile);if(!inside(this.options.updatesDirectory,artifactPath))return false;const info=await this.files.lstat(artifactPath);if(!info.isFile()||info.isSymbolicLink()||info.size!==asset.size||await hashFile(artifactPath,this.files.createReadStream)!==asset.sha256)return false;
    this.verified={manifest,manifestBytes,signature};this.artifactPath=artifactPath;this.set(this.targetState('prepared',{progress:{receivedBytes:asset.size,totalBytes:asset.size,percent:100}}));return true;
  }
  async check():Promise<UpdateState>{
    if(this.recoveryPending)return this.status();if(!this.supported())return this.status();if(['checking','downloading','installing'].includes(this.current.phase))throw Error('更新操作正在进行');this.set({phase:'checking',currentVersion:this.options.currentVersion});
    try{
      const verified=await fetchVerifiedManifest(this.options.publicKey,{request:this.options.request,timeoutMs:30_000});const comparison=compareVersions(verified.manifest.version,this.options.currentVersion),checkedAt=(this.options.now?.()??new Date()).toISOString();
      this.verified=verified;this.artifactPath=undefined;if(comparison<=0)return this.set(this.targetState('up-to-date',{checkedAt}));if(!this.platform||!verified.manifest.assets[this.platform])return this.set(this.targetState('unsupported',{checkedAt,error:'官方更新尚未提供当前平台的安装包'}));
      return this.set(this.targetState('available',{checkedAt}));
    }catch(error){return this.set({phase:'failed',currentVersion:this.options.currentVersion,retryable:true,error:controlledMessage(error,'暂时无法检查更新，请稍后重试')})}
  }
  download():Promise<UpdateState>{
    if(this.recoveryPending)return Promise.reject(Error('上次 macOS 更新仍保留恢复副本'));if(this.downloadPromise)return this.downloadPromise;const retrying=this.current.phase==='failed'&&this.current.targetVersion===this.verified?.manifest.version;if(!this.verified||!this.platform||(this.current.phase!=='available'&&!retrying))return Promise.reject(Error('请先检查并确认有可用更新'));
    const abort=new AbortController();this.downloadAbort=abort;this.set(this.targetState('downloading',{progress:{receivedBytes:0,totalBytes:this.verified.manifest.assets[this.platform]!.size,percent:0}}));this.downloadPromise=this.performDownload(abort).finally(()=>{this.downloadAbort=undefined;this.downloadPromise=undefined});return this.downloadPromise;
  }
  private async performDownload(abort:AbortController):Promise<UpdateState>{
    const verified=this.verified!,platform=this.platform!,asset=verified.manifest.assets[platform]!,extension=asset.format==='zip'?'.zip':'.exe',base=`Linkflow-${verified.manifest.version}-${platform}${extension}`,partial=join(this.options.updatesDirectory,base+'.part'),destination=join(this.options.updatesDirectory,base);let handle:Awaited<ReturnType<typeof open>>|undefined;
    try{
      await this.files.mkdir(this.options.updatesDirectory,{recursive:true,mode:0o700});await this.files.rm(partial,{force:true});const response=await fetchWithPinnedRedirects(asset.url,{request:this.options.request,signal:abort.signal,timeoutMs:10*60_000});if(!response.ok||!response.body)throw Error(`下载更新失败（${response.status}）`);
      const declared=Number(response.headers.get('content-length')??'0');if(declared&&declared!==asset.size)throw Error('安装包大小与签名清单不一致');handle=await this.files.open(partial,'wx',0o600);const reader=response.body.getReader(),hash=createHash('sha256');let received=0,lastEmit=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;received+=value.byteLength;if(received>asset.size)throw Error('安装包超过签名清单声明的大小');const chunk=Buffer.from(value);hash.update(chunk);for(let offset=0;offset<chunk.length;){const {bytesWritten}=await handle.write(chunk,offset,chunk.length-offset);if(bytesWritten<1)throw Error('安装包写入中断');offset+=bytesWritten}const now=Date.now();if(now-lastEmit>=100||received===asset.size){lastEmit=now;this.set(this.targetState('downloading',{progress:{receivedBytes:received,totalBytes:asset.size,percent:Math.floor(received*10000/asset.size)/100}}))}}}finally{reader.releaseLock()}
      await handle.sync();await handle.close();handle=undefined;if(received!==asset.size||hash.digest('hex')!==asset.sha256)throw Error('安装包完整性验证失败');await this.files.rm(destination,{force:true});await this.files.rename(partial,destination);this.artifactPath=destination;
      const record:PreparedRecord={schemaVersion:1,manifest:verified.manifestBytes.toString('base64'),signature:verified.signature.toString('ascii'),artifactFile:base};await this.writeAtomic('prepared.json',record);return this.set(this.targetState('prepared',{progress:{receivedBytes:asset.size,totalBytes:asset.size,percent:100}}));
    }catch(error){try{await handle?.close()}catch{}try{await this.files.rm(partial,{force:true})}catch{}if(abort.signal.aborted)return this.set(this.targetState('available',{retryable:true,error:'下载已取消'}));return this.set(this.targetState('failed',{retryable:true,error:error instanceof UpdateError?error.message:'下载或验证更新失败，请重试'}))}
  }
  cancel():UpdateState{if(this.current.phase!=='downloading'||!this.downloadAbort)throw Error('当前没有可取消的下载');this.downloadAbort.abort(Error('用户取消下载'));return this.status()}
  dispose():void{this.downloadAbort?.abort(Error('应用正在退出'))}
  async install():Promise<UpdateInstallHandoff>{
    if(this.recoveryPending)throw Error('上次 macOS 更新仍保留恢复副本');if(this.current.phase!=='prepared'||!this.verified||!this.platform||!this.artifactPath)throw Error('请先完成下载和验证');if(!isAbsolute(this.options.helperPath))throw Error('更新助手路径无效');const asset=this.verified.manifest.assets[this.platform];if(!asset)throw Error('当前平台没有可安装的更新');const artifactInfo=await this.files.lstat(this.artifactPath);if(!artifactInfo.isFile()||artifactInfo.isSymbolicLink()||artifactInfo.size!==asset.size||await hashFile(this.artifactPath,this.files.createReadStream)!==asset.sha256){await this.clearPrepared();this.set(this.targetState('failed',{retryable:true,error:'安装包在准备安装前发生变化，请重新下载'}));throw Error('安装包完整性验证失败')}this.set(this.targetState('installing'));
    try{
      const previousFailure=await this.readOptional<InstallError>('install-error.json',32*1024);if(previousFailure?.recoveryJobPath)throw Error('上次 macOS 更新仍保留恢复副本');if(previousFailure?.cleanupPath&&!(await this.cleanupRuntime(previousFailure.cleanupPath)))throw Error('上次更新助手尚未退出');await Promise.all(['install-error.json','installed.json','startup-request.json','startup-ack'].map(name=>this.files.rm(join(this.options.updatesDirectory,name),{force:true})));const {job,jobPath,launchExecutablePath,launchHelperPath}=await prepareInstallJob({platform:this.platform,oldPid:this.options.pid??process.pid,targetVersion:this.verified.manifest.version,updatesDirectory:this.options.updatesDirectory,artifactPath:this.artifactPath,artifactSize:asset.size,artifactSha256:asset.sha256,applicationPath:this.options.applicationPath,executablePath:this.options.executablePath,helperPath:this.options.helperPath},this.options.installPorts);
      let launchError:Error|undefined;const child=(this.options.launchHelper??defaultLaunch)(launchExecutablePath,[launchHelperPath,jobPath],{...process.env,ELECTRON_RUN_AS_NODE:'1',LINKFLOW_UPDATE_HELPER:'1'});if(!child.pid)throw Error('无法启动更新助手');child.once?.('error',error=>{launchError=error});const deadline=Date.now()+5000;
      for(;;){if(launchError)throw launchError;try{if((await this.files.readFile(job.readyPath,'utf8'))===job.token)break}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}if(Date.now()>=deadline)throw Error('更新助手未能安全接手');await new Promise(done=>setTimeout(done,50))}await this.files.rm(job.readyPath,{force:true});const armTemporary=job.armPath+'.tmp';try{await this.files.rm(armTemporary,{force:true});await this.files.writeFile(armTemporary,job.token,{mode:0o600,flag:'wx'});await this.files.rename(armTemporary,job.armPath)}catch(error){await this.files.rm(armTemporary,{force:true}).catch(()=>{});throw error}return {accepted:true,targetVersion:job.targetVersion};
    }catch{const message='无法安全启动更新安装，请检查应用所在位置的写入权限';this.set(this.targetState('prepared',{retryable:true,error:message}));throw Error(message)}
  }
  private async writeAtomic(name:string,value:unknown){const path=join(this.options.updatesDirectory,name),temporary=path+'.tmp';await this.files.rm(temporary,{force:true});await this.files.writeFile(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});await this.files.rename(temporary,path)}
  private async cleanupRuntime(path:string|undefined):Promise<boolean>{if(!path)return true;if(!inside(this.options.updatesDirectory,path)||!basename(path).startsWith('helper-runtime-'))return false;try{await this.files.rm(path,{recursive:true,force:true});return true}catch{return false}}
  private validRecoveryPath(path:string|undefined):boolean{return !!path&&inside(this.options.updatesDirectory,path)&&/^install-[a-zA-Z0-9-]{1,80}\.json$/.test(basename(path))}
  private async cleanupRecoveryJob(path:string|undefined):Promise<boolean>{if(!path)return true;if(!this.validRecoveryPath(path))return false;try{await this.files.rm(path,{force:true});return true}catch{return false}}
  private async cleanupBackup(path:string|undefined):Promise<boolean>{if(!path)return true;const parent=dirname(this.options.applicationPath),name=basename(path),expected=this.platform==='darwin-arm64'?'.'+basename(this.options.applicationPath)+'.linkflow-backup-':'.linkflow-backup-';if(dirname(path)!==parent||!name.startsWith(expected))return false;try{await this.files.rm(path,{recursive:true,force:true});return true}catch{return false}}
  private async clearPrepared(){this.verified=undefined;this.artifactPath=undefined;try{await this.files.rm(join(this.options.updatesDirectory,'prepared.json'),{force:true})}catch{}}
}
