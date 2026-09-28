import {createHash} from 'node:crypto';
import type {KeyObject} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,mkdir,open,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {UpdateInstallHandoff,UpdateManifest,UpdatePlatform,UpdateState} from '../shared/update-types';
import {compareVersions,fetchVerifiedManifest,fetchWithPinnedRedirects,parseUpdateManifest,UpdateError,verifyManifestSignature} from './update-network';
import {prepareInstallJob,type InstallPorts} from './update-install';
import {updateRawFs} from './update-files';

interface PreparedRecord {schemaVersion:1;manifest:string;signature:string;artifactFile:string}
interface Receipt {schemaVersion:1;targetVersion:string;installedAt:string;cleanupPath?:string;backupCleanupPath?:string}
interface InstallError {schemaVersion:1;targetVersion:string;failedAt:string;message:string;cleanupPath?:string;recoveryJobPath?:string}
interface StartupRequest {schemaVersion:1;targetVersion:string;token:string}
interface StartupAck {schemaVersion:2;targetVersion:string;token:string;pid:number;applicationPath:string;executablePath:string}
export interface UpdateFilePorts {lstat:typeof lstat;mkdir:typeof mkdir;open:typeof open;readFile:typeof readFile;rename:typeof rename;rm:typeof rm;writeFile:typeof writeFile;createReadStream:typeof createReadStream}
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
  launchHelper?:(executable:string,args:string[],environment:NodeJS.ProcessEnv)=>{pid?:number;once?:(event:string,listener:(error?:Error)=>void)=>unknown;unref?:()=>void};
  now?:()=>Date;
  pid?:number;
}
const rawFs=updateRawFs(),rawPromises=rawFs.promises;
const realFiles:UpdateFilePorts={lstat:rawPromises.lstat as typeof lstat,mkdir:rawPromises.mkdir as typeof mkdir,open:rawPromises.open as typeof open,readFile:rawPromises.readFile as typeof readFile,rename:rawPromises.rename as typeof rename,rm:rawPromises.rm as typeof rm,writeFile:rawPromises.writeFile as typeof writeFile,createReadStream:rawFs.createReadStream as typeof createReadStream};
const controlledMessage=(error:unknown,fallback:string)=>error instanceof UpdateError&&error.message?error.message:fallback;
function inside(parent:string,child:string):boolean{const path=relative(resolve(parent),resolve(child));return !!path&&path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path)}
export function resolveUpdatePlatform(platform:NodeJS.Platform,arch:string):UpdatePlatform|undefined{return platform==='darwin'&&arch==='arm64'?'darwin-arm64':platform==='win32'&&arch==='x64'?'win32-x64':undefined}
function parseSmallJson<T>(data:Buffer|string,maximum:number):T{const text=typeof data==='string'?data:data.toString('utf8');if(Buffer.byteLength(text)>maximum)throw Error('更新状态文件过大');return JSON.parse(text) as T}
async function hashFile(path:string,streamFactory:typeof createReadStream):Promise<string>{const hash=createHash('sha256');for await(const chunk of streamFactory(path))hash.update(chunk as Buffer);return hash.digest('hex')}
function defaultLaunch(executable:string,args:string[],environment:NodeJS.ProcessEnv){const child=spawn(executable,args,{cwd:dirname(executable),detached:true,stdio:'ignore',shell:false,windowsHide:true,env:environment});child.unref();return child}

export class UpdateManager {
  private readonly files:UpdateFilePorts;
  private readonly platform?:UpdatePlatform;
  private current:UpdateState;
  private verified?:{manifest:UpdateManifest;manifestBytes:Buffer;signature:Buffer};
  private artifactPath?:string;
  private recoveryPending=false;
  private downloadAbort?:AbortController;
  private downloadPromise?:Promise<UpdateState>;
  constructor(private options:UpdateManagerOptions){
    this.files={...realFiles,...options.files};this.platform=resolveUpdatePlatform(options.platform,options.arch);this.current={phase:'idle',currentVersion:options.currentVersion};
  }
  status():UpdateState{return structuredClone(this.current)}
  private set(next:UpdateState):UpdateState{this.current=next;this.options.emit?.(this.status());return this.status()}
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
    let prepared=false;try{prepared=await this.restorePrepared()}catch{await this.clearPrepared()}
    const receipt=await this.readOptional<Receipt>('installed.json',16*1024),failure=await this.readOptional<InstallError>('install-error.json',32*1024);
    if(failure?.schemaVersion===1&&this.validRecoveryPath(failure.recoveryJobPath)){this.recoveryPending=true;return this.set({phase:'failed',currentVersion:this.options.currentVersion,targetVersion:failure.targetVersion,retryable:false,error:'新版本启动身份未能确认，已保留恢复副本；请重新打开应用，如仍提示失败请联系支持'})}
    if(failure?.schemaVersion===1&&!failure.recoveryJobPath)await this.cleanupRuntime(failure.cleanupPath);
    if(prepared){if(failure?.schemaVersion===1&&failure.targetVersion===this.verified?.manifest.version)this.set(this.targetState('prepared',{retryable:true,error:'上次安装未完成，已保留经过验证的安装包'}));return this.status()}
    if(receipt?.schemaVersion===1&&receipt.targetVersion===this.options.currentVersion&&!Number.isNaN(Date.parse(receipt.installedAt))){if(await this.cleanupRuntime(receipt.cleanupPath)&&await this.cleanupBackup(receipt.backupCleanupPath))await this.files.rm(join(this.options.updatesDirectory,'installed.json'),{force:true});return this.set({phase:'installed',currentVersion:this.options.currentVersion,targetVersion:receipt.targetVersion})}
    if(receipt?.schemaVersion===1&&/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(receipt.targetVersion)&&compareVersions(receipt.targetVersion,this.options.currentVersion)>0)return this.set({phase:'failed',currentVersion:this.options.currentVersion,targetVersion:receipt.targetVersion,retryable:true,error:'安装助手已运行，但当前应用版本没有更新'});
    if(failure?.schemaVersion===1&&typeof failure.targetVersion==='string'&&typeof failure.message==='string')return this.set({phase:'failed',currentVersion:this.options.currentVersion,targetVersion:failure.targetVersion,retryable:!failure.recoveryJobPath,error:failure.recoveryJobPath?'新版本启动身份未能确认，已保留恢复副本；请重新打开应用，如仍提示失败请联系支持':'安装未能完成，旧版本已保留'});
    return this.set({phase:'idle',currentVersion:this.options.currentVersion})}catch{return this.set({phase:'failed',currentVersion:this.options.currentVersion,retryable:true,error:'无法读取本机更新状态，其他功能可继续使用'})}
  }
  async acknowledgeStartup():Promise<boolean>{
    const request=await this.readOptional<StartupRequest>('startup-request.json',16*1024);if(!request||request.schemaVersion!==1||request.targetVersion!==this.options.currentVersion||typeof request.token!=='string'||!/^[a-f0-9-]{16,64}$/i.test(request.token))return false;
    const priorFailure=await this.readOptional<InstallError>('install-error.json',32*1024);if(this.validRecoveryPath(priorFailure?.recoveryJobPath)){this.recoveryPending=true;return false}
    const ack:StartupAck={schemaVersion:2,targetVersion:request.targetVersion,token:request.token,pid:this.options.pid??process.pid,applicationPath:this.options.runtimeApplicationPath??this.options.applicationPath,executablePath:this.options.runtimeExecutablePath??this.options.executablePath};
    const path=join(this.options.updatesDirectory,'startup-ack'),temporary=path+'.tmp',contents=this.platform==='darwin-arm64'?JSON.stringify(ack):request.token;await this.files.rm(temporary,{force:true});await this.files.writeFile(temporary,contents,{mode:0o600,flag:'wx'});await this.files.rename(temporary,path);this.set({phase:'installed',currentVersion:this.options.currentVersion,targetVersion:request.targetVersion});return true;
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
  private validRecoveryPath(path:string|undefined):boolean{return !!path&&inside(this.options.updatesDirectory,path)&&basename(path).startsWith('install-')&&basename(path).endsWith('.json')}
  private async cleanupBackup(path:string|undefined):Promise<boolean>{if(!path)return true;const parent=dirname(this.options.applicationPath),name=basename(path),expected=this.platform==='darwin-arm64'?'.'+basename(this.options.applicationPath)+'.linkflow-backup-':'.linkflow-backup-';if(dirname(path)!==parent||!name.startsWith(expected))return false;try{await this.files.rm(path,{recursive:true,force:true});return true}catch{return false}}
  private async clearPrepared(){this.verified=undefined;this.artifactPath=undefined;try{await this.files.rm(join(this.options.updatesDirectory,'prepared.json'),{force:true})}catch{}}
}
