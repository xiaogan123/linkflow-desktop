import * as nodeFs from 'node:fs';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {join} from 'node:path';

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

/** Runs a fixed native tool against an already-open object through a child-only descriptor. */
export function executeWithUpdateDescriptor(file:string,args:string[],descriptor:number,options:{timeoutMs?:number;maxBuffer?:number;descriptorIndex?:number}={}):Promise<string>{
  return new Promise((done,reject)=>{
    const maximum=options.maxBuffer??4*1024*1024,commandArgs=[...args],descriptorIndex=options.descriptorIndex??commandArgs.length;if(!Number.isSafeInteger(descriptorIndex)||descriptorIndex<0||descriptorIndex>commandArgs.length){reject(Error('受控文件描述符位置无效'));return}commandArgs.splice(descriptorIndex,0,'/dev/fd/3');const child=spawn(file,commandArgs,{stdio:['ignore','pipe','pipe',descriptor],shell:false,env:{...process.env,LC_ALL:'C',LANG:'C'}});let stdout=Buffer.alloc(0),stderrBytes=0,settled=false,timer:NodeJS.Timeout|undefined;
    const finish=(error?:Error,value='')=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);error?reject(error):done(value)},failure=(message:string,details:Record<string,unknown>={})=>Object.assign(Error(message),details);
    child.stdout?.on('data',(chunk:Buffer)=>{if(stdout.length+chunk.length>maximum){child.kill('SIGKILL');finish(failure('受控文件工具输出超过上限',{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}));return}stdout=Buffer.concat([stdout,chunk])});
    child.stderr?.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>maximum){child.kill('SIGKILL');finish(failure('受控文件工具输出超过上限',{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}))}});
    child.once('error',()=>finish(failure('受控文件工具无法启动')));child.once('close',(code,signal)=>code===0?finish(undefined,stdout.toString('utf8')):finish(failure('受控文件工具执行失败',{code,signal})));
    timer=setTimeout(()=>{child.kill('SIGKILL');finish(failure('受控文件工具执行超时',{killed:true}))},options.timeoutMs??120_000);timer.unref();
  });
}
