import {mkdir,readFile,writeFile,rename,readdir,unlink,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export interface LocalBackupStatus {enabled:boolean;keep:number;lastBackupAt?:string;error?:string;backups:{id:string;createdAt:string}[]}
interface BackupPorts {encrypt:(clear:string)=>Buffer;decrypt:(cipher:Buffer)=>string;snapshot:()=>unknown;now?:()=>Date}
const header=Buffer.from('LINKFLOW-LOCAL-BACKUP-1\n');
const namePattern=/^snapshot-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-[a-f0-9-]{36}\.lfa$/;
const maximum=32*1024*1024;
/** OS-encrypted local recovery copies; portable backups remain a separate passphrase flow. */
export class LocalBackups {
 private chain:Promise<unknown>=Promise.resolve();private error?:string;
 constructor(private directory:string,private ports:BackupPorts){}
 private serial<T>(work:()=>Promise<T>):Promise<T>{const pending=this.chain.then(work,work);this.chain=pending.catch(()=>{});return pending}
 private async configuration(){
  try{const value=JSON.parse(await readFile(join(this.directory,'settings.json'),'utf8'));if(typeof value.enabled!=='boolean'||!Number.isInteger(value.keep)||value.keep<3||value.keep>30)throw Error();return {enabled:value.enabled as boolean,keep:value.keep as number}}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {enabled:false,keep:7};throw Error('自动备份配置损坏，请重新配置')}
 }
 private async list(){
  let entries;try{entries=await readdir(this.directory,{withFileTypes:true})}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw Error('无法读取本机备份')}
  return entries.filter(entry=>entry.isFile()&&namePattern.test(entry.name)).map(entry=>{const stamp=namePattern.exec(entry.name)![1];return {id:entry.name,createdAt:stamp.slice(0,13)+':'+stamp.slice(14,16)+':'+stamp.slice(17,19)+'.'+stamp.slice(20)}}).sort((a,b)=>b.id.localeCompare(a.id));
 }
 async status():Promise<LocalBackupStatus>{const config=await this.configuration(),backups=await this.list();return {...config,backups,lastBackupAt:backups[0]?.createdAt,error:this.error}}
 async configure(enabled:boolean,keep=7){
  return this.serial(async()=>{if(typeof enabled!=='boolean'||!Number.isInteger(keep)||keep<3||keep>30)throw Error('备份保留数量需为 3–30 份');await mkdir(this.directory,{recursive:true,mode:0o700});const temporary=join(this.directory,'settings-'+randomUUID()+'.tmp');await writeFile(temporary,JSON.stringify({enabled,keep}),{mode:0o600,flag:'wx'});await rename(temporary,join(this.directory,'settings.json'));return this.status()});
 }
 async run(force=false){
  return this.serial(async()=>{
   const before=await this.status(),now=this.ports.now?.()??new Date();
   if(!force&&(!before.enabled||(before.lastBackupAt&&now.getTime()-Date.parse(before.lastBackupAt)<86400000)))return before;
   try{
    const plain=JSON.stringify({version:1,payload:this.ports.snapshot()});if(Buffer.byteLength(plain)>maximum)throw Error();
    const encrypted=this.ports.encrypt(plain);if(!Buffer.isBuffer(encrypted)||!encrypted.length||encrypted.length>maximum)throw Error();
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const id='snapshot-'+now.toISOString().replaceAll(':','-').replace('.','-')+'-'+randomUUID()+'.lfa',temporary=join(this.directory,id+'.tmp');
    await writeFile(temporary,Buffer.concat([header,encrypted]),{mode:0o600,flag:'wx'});await rename(temporary,join(this.directory,id));
    // A complete new snapshot exists before old snapshots are pruned.
    const backups=await this.list();for(const obsolete of backups.slice(before.keep))await unlink(join(this.directory,obsolete.id));
    this.error=undefined;return this.status();
   }catch{this.error='本机自动备份未完成，请解锁系统钥匙串并检查磁盘空间后重试';throw Error(this.error)}
  });
 }
 async read(id:string):Promise<unknown>{
  if(!namePattern.test(id))throw Error('备份记录无效');
  try{const path=join(this.directory,id),info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>maximum+header.length)throw Error();const data=await readFile(path);if(!data.subarray(0,header.length).equals(header))throw Error();const decoded=JSON.parse(this.ports.decrypt(data.subarray(header.length)));if(decoded.version!==1||!decoded.payload||typeof decoded.payload!=='object')throw Error();return decoded.payload}
  catch{throw Error('无法解密此本机备份。需要原电脑和原系统账号，或改用口令备份恢复')}
 }
}

export async function checkForUpdate(currentVersion:string,request:typeof fetch=fetch){
 const response=await request('https://api.github.com/repos/xiaogan123/linkflow-desktop/releases/latest',{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(10000),redirect:'error'});
 if(!response.ok)throw Error('暂时无法检查更新，请稍后重试');
 const text=await response.text();if(text.length>1024*1024)throw Error('更新响应无效');
 let release;try{release=JSON.parse(text)}catch{throw Error('更新响应无效')}
 if(release.draft||release.prerelease||typeof release.tag_name!=='string'||!/^v\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(release.tag_name))throw Error('未找到有效的稳定版本');
 const version=release.tag_name.slice(1),url='https://github.com/xiaogan123/linkflow-desktop/releases/tag/'+release.tag_name;
 if(release.html_url!==url||!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(currentVersion))throw Error('更新来源或版本无效');
 const remote=version.split('.').map(Number),local=currentVersion.split('.').map(Number);let available=false;
 for(let index=0;index<3;index++){if(remote[index]!==local[index]){available=remote[index]>local[index];break}}
 return {available,version,url,checkedAt:new Date().toISOString()};
}
