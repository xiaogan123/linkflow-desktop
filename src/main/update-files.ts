import * as nodeFs from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {basename,isAbsolute,join,resolve} from 'node:path';

export const macQuarantineProbeFilename='linkflow-update-quarantine-probe';

let cached:typeof nodeFs|undefined;

/** Bypass Electron's ASAR virtualization for real bundle replacement/copy/cleanup. */
export function updateRawFs():typeof nodeFs{
  if(cached)return cached;
  try{
    const runtimeRequire=createRequire(join(process.cwd(),'.linkflow-update-loader.cjs'));
    const original=runtimeRequire('original-fs') as typeof nodeFs;
    if(original?.promises&&typeof original.createReadStream==='function')return cached=original;
  }catch{}
  return cached=nodeFs;
}

interface DescriptorExecutionOptions {timeoutMs?:number;maxBuffer?:number;descriptorIndex?:number;rejectStderr?:boolean}
export interface MacQuarantineProbeIdentity {path:string;sha256:string;dev:bigint;ino:bigint;nlink:bigint;mode:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint}

function sameMacQuarantineProbeIdentity(left:MacQuarantineProbeIdentity,right:MacQuarantineProbeIdentity):boolean{return left.path===right.path&&left.sha256===right.sha256&&left.dev===right.dev&&left.ino===right.ino&&left.nlink===right.nlink&&left.mode===right.mode&&left.size===right.size&&left.mtimeNs===right.mtimeNs&&left.ctimeNs===right.ctimeNs}
function probeIdentity(path:string,sha256:string,info:nodeFs.BigIntStats):MacQuarantineProbeIdentity{return {path,sha256,dev:info.dev,ino:info.ino,nlink:info.nlink,mode:info.mode,size:info.size,mtimeNs:info.mtimeNs,ctimeNs:info.ctimeNs}}
function validProbeInfo(info:nodeFs.BigIntStats):boolean{return info.isFile()&&!info.isSymbolicLink()&&info.nlink===1n&&(info.mode&0o777n)===0o755n&&info.size>0n&&info.size<=1024n*1024n}

export async function readMacQuarantineProbeIdentity(file:string):Promise<MacQuarantineProbeIdentity>{
  if(!isAbsolute(file)||resolve(file)!==file||basename(file)!==macQuarantineProbeFilename)throw Error('macOS 隔离属性检查工具路径无效');
  const raw=updateRawFs(),pathBefore=await raw.promises.lstat(file,{bigint:true});if(!validProbeInfo(pathBefore))throw Error('macOS 隔离属性检查工具无效');
  const handle=await raw.promises.open(file,nodeFs.constants.O_RDONLY|nodeFs.constants.O_NOFOLLOW);
  try{
    const opened=await handle.stat({bigint:true}),pathIdentity=probeIdentity(file,'',pathBefore),openedIdentity=probeIdentity(file,'',opened);if(!validProbeInfo(opened)||!sameMacQuarantineProbeIdentity(pathIdentity,openedIdentity))throw Error('macOS 隔离属性检查工具发生变化');
    const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);let position=0,size=Number(opened.size);while(position<size){const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,size-position),position);if(bytesRead<1)throw Error('macOS 隔离属性检查工具读取中断');hash.update(buffer.subarray(0,bytesRead));position+=bytesRead}
    const after=await handle.stat({bigint:true}),pathAfter=await raw.promises.lstat(file,{bigint:true}),afterIdentity=probeIdentity(file,'',after),pathAfterIdentity=probeIdentity(file,'',pathAfter);if(!validProbeInfo(after)||!validProbeInfo(pathAfter)||!sameMacQuarantineProbeIdentity(openedIdentity,afterIdentity)||!sameMacQuarantineProbeIdentity(openedIdentity,pathAfterIdentity))throw Error('macOS 隔离属性检查工具发生变化');return probeIdentity(file,hash.digest('hex'),after);
  }finally{await handle.close()}
}

function executeDescriptorCommand(file:string,args:string[],descriptor:number,options:DescriptorExecutionOptions={},includeDescriptorPath=true):Promise<string>{
  return new Promise((done,reject)=>{
    const maximum=options.maxBuffer??4*1024*1024,commandArgs=[...args];if(!Number.isSafeInteger(descriptor)||descriptor<0){reject(Error('受控文件描述符无效'));return}if(includeDescriptorPath){const descriptorIndex=options.descriptorIndex??commandArgs.length;if(!Number.isSafeInteger(descriptorIndex)||descriptorIndex<0||descriptorIndex>commandArgs.length){reject(Error('受控文件描述符位置无效'));return}commandArgs.splice(descriptorIndex,0,'/dev/fd/3')}const child=spawn(file,commandArgs,{stdio:['ignore','pipe','pipe',descriptor],shell:false,env:{...process.env,LC_ALL:'C',LANG:'C'}});let stdout=Buffer.alloc(0),stderrBytes=0,settled=false,timer:NodeJS.Timeout|undefined;
    const finish=(error?:Error,value='')=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);error?reject(error):done(value)},failure=(message:string,details:Record<string,unknown>={})=>Object.assign(Error(message),details);
    child.stdout?.on('data',(chunk:Buffer)=>{if(stdout.length+chunk.length>maximum){child.kill('SIGKILL');finish(failure('受控文件工具输出超过上限',{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}));return}stdout=Buffer.concat([stdout,chunk])});
    child.stderr?.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>maximum){child.kill('SIGKILL');finish(failure('受控文件工具输出超过上限',{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}))}});
    child.once('error',()=>finish(failure('受控文件工具无法启动')));child.once('close',(code,signal)=>code===0&&(!options.rejectStderr||stderrBytes===0)?finish(undefined,stdout.toString('utf8')):finish(failure('受控文件工具执行失败',{code,signal})));
    timer=setTimeout(()=>{child.kill('SIGKILL');finish(failure('受控文件工具执行超时',{killed:true}))},options.timeoutMs??120_000);timer.unref();
  });
}

/** Runs a fixed native tool against an already-open object through a child-only descriptor. */
export function executeWithUpdateDescriptor(file:string,args:string[],descriptor:number,options:DescriptorExecutionOptions={}):Promise<string>{return executeDescriptorCommand(file,args,descriptor,options)}

/** Queries only the quarantine-presence bit from the signed, pathless macOS helper. */
export async function probeMacQuarantineDescriptor(file:string,descriptor:number,verifiedIdentity:MacQuarantineProbeIdentity):Promise<boolean>{
  const before=await readMacQuarantineProbeIdentity(file);if(!sameMacQuarantineProbeIdentity(verifiedIdentity,before))throw Error('macOS 隔离属性检查工具发生变化');
  const output=await executeDescriptorCommand(file,[],descriptor,{timeoutMs:30_000,maxBuffer:16,rejectStderr:true},false),after=await readMacQuarantineProbeIdentity(file);
  if(!sameMacQuarantineProbeIdentity(verifiedIdentity,after))throw Error('macOS 隔离属性检查工具发生变化');
  if(output==='1\n')return true;
  if(output==='0\n')return false;
  throw Error('macOS 隔离属性检查工具输出无效');
}
