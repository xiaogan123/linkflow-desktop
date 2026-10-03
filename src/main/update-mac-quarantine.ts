import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {constants as fsConstants,type Stats} from 'node:fs';
import {macQuarantineProbeFilename,probeMacQuarantineDescriptor,readMacQuarantineProbeIdentity,updateRawFs,type MacQuarantineProbeIdentity} from './update-files';
import {hashUpdateTree} from './update-tree';

const rawFs=updateRawFs(),files=rawFs.promises;
const maximumEntries=100_000;

export interface VerifiedMacApplication {
  applicationPath:string;
  executablePath:string;
  targetVersion:string;
  treeSha256:string;
}

export interface VerifiedMacStage extends VerifiedMacApplication {
  updatesDirectory:string;
  artifactPath:string;
  artifactSize:number;
  artifactSha256:string;
  stagedApplicationPath:string;
}

export interface MacQuarantinePorts {
  execute:(file:string,args:string[])=>Promise<string>;
  hashTree:(root:string)=>Promise<string>;
  probeQuarantine:(descriptor:number,verifiedIdentity:MacQuarantineProbeIdentity)=>Promise<boolean>;
  verifyProbe:()=>Promise<MacQuarantineProbeIdentity>;
}

interface EntrySnapshot {
  path:string;
  relativePath:string;
  dev:number;
  ino:number;
  nlink:number;
  mode:number;
  size:number;
  mtimeMs:number;
  ctimeMs:number;
  kind:'directory'|'file'|'symlink';
}

interface ControlledStage {
  application:VerifiedMacApplication;
  archive:EntrySnapshot;
}

const executeNative=(file:string,args:string[])=>new Promise<string>((done,reject)=>execFile(file,args,{encoding:'utf8',timeout:120_000,maxBuffer:4*1024*1024,shell:false,env:{...process.env,LC_ALL:'C',LANG:'C'}},(error,stdout)=>error?reject(error):done(stdout)));
const realPorts:MacQuarantinePorts={
  execute:executeNative,
  hashTree:hashUpdateTree,
  probeQuarantine:(descriptor,verifiedIdentity)=>probeMacQuarantineDescriptor(macQuarantineProbePath(),descriptor,verifiedIdentity),
  verifyProbe:()=>verifyMacQuarantineProbeResource()
};

export function macQuarantineProbePath(resourcesPath=(process as NodeJS.Process&{resourcesPath?:string}).resourcesPath):string{
  if(typeof resourcesPath!=='string'||!isAbsolute(resourcesPath)||basename(resourcesPath)!=='Resources'||basename(dirname(resourcesPath))!=='Contents'||!dirname(dirname(resourcesPath)).endsWith('.app'))throw Error('macOS 隔离属性检查工具路径无效');
  return join(resourcesPath,macQuarantineProbeFilename);
}

function sameProbeIdentity(left:MacQuarantineProbeIdentity,right:MacQuarantineProbeIdentity):boolean{return left.path===right.path&&left.sha256===right.sha256&&left.dev===right.dev&&left.ino===right.ino&&left.nlink===right.nlink&&left.mode===right.mode&&left.size===right.size&&left.mtimeNs===right.mtimeNs&&left.ctimeNs===right.ctimeNs}
export async function verifyMacQuarantineProbeResource(resourcesPath=(process as NodeJS.Process&{resourcesPath?:string}).resourcesPath,execute=executeNative):Promise<MacQuarantineProbeIdentity>{
  const probePath=macQuarantineProbePath(resourcesPath),applicationPath=dirname(dirname(resourcesPath!)),applicationInfo=await files.lstat(applicationPath),before=await readMacQuarantineProbeIdentity(probePath);
  if(!applicationInfo.isDirectory()||applicationInfo.isSymbolicLink())throw Error('macOS 隔离属性检查工具无效');
  await execute('/usr/bin/codesign',['--verify','--strict',probePath]);await execute('/usr/bin/codesign',['--verify','--deep','--strict',applicationPath]);
  const after=await readMacQuarantineProbeIdentity(probePath);if(!sameProbeIdentity(before,after))throw Error('macOS 隔离属性检查工具发生变化');return before;
}

function inside(parent:string,child:string,allowSame=false):boolean{
  const path=relative(resolve(parent),resolve(child));
  return (allowSame&&path==='')||(path!==''&&path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path));
}

function kindOf(info:Stats):EntrySnapshot['kind']|undefined{
  if(info.isDirectory()&&!info.isSymbolicLink())return 'directory';
  if(info.isFile()&&!info.isSymbolicLink())return 'file';
  if(info.isSymbolicLink())return 'symlink';
  return;
}

function snapshot(path:string,relativePath:string,info:Stats):EntrySnapshot{
  const kind=kindOf(info);if(!kind)throw Error('更新应用含有不支持的文件类型');
  return {path,relativePath,dev:info.dev,ino:info.ino,nlink:info.nlink,mode:info.mode,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs,kind};
}

function sameEntry(left:EntrySnapshot,right:EntrySnapshot):boolean{
  return left.path===right.path&&left.relativePath===right.relativePath&&left.dev===right.dev&&left.ino===right.ino&&left.nlink===right.nlink&&left.mode===right.mode&&left.size===right.size&&left.mtimeMs===right.mtimeMs&&left.ctimeMs===right.ctimeMs&&left.kind===right.kind;
}

async function entryAt(path:string,relativePath=''):Promise<EntrySnapshot>{return snapshot(path,relativePath,await files.lstat(path))}

async function hashFile(path:string):Promise<string>{
  const hash=createHash('sha256');for await(const chunk of rawFs.createReadStream(path))hash.update(chunk as Buffer);return hash.digest('hex');
}

async function verifyArchive(input:VerifiedMacStage,expected:EntrySnapshot):Promise<void>{
  const before=await entryAt(input.artifactPath);if(!sameEntry(before,expected)||before.kind!=='file'||before.size!==input.artifactSize)throw Error('macOS 更新安装包路径或大小发生变化');
  const digest=await hashFile(input.artifactPath),after=await entryAt(input.artifactPath);if(!sameEntry(before,after)||digest!==input.artifactSha256)throw Error('macOS 更新安装包完整性复验失败');
}

async function verifyBundle(input:VerifiedMacApplication,ports:MacQuarantinePorts):Promise<void>{
  const appInfo=await files.lstat(input.applicationPath),executableInfo=await files.lstat(input.executablePath),plist=join(input.applicationPath,'Contents','Info.plist'),plistInfo=await files.lstat(plist);
  if(!appInfo.isDirectory()||appInfo.isSymbolicLink()||!executableInfo.isFile()||executableInfo.isSymbolicLink()||!plistInfo.isFile()||plistInfo.isSymbolicLink()||!inside(input.applicationPath,input.executablePath)||!inside(input.applicationPath,plist))throw Error('macOS 更新应用路径无效');
  await ports.execute('/usr/bin/codesign',['--verify','--deep','--strict',input.applicationPath]);
  const identifier=(await ports.execute('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',plist])).trim(),version=(await ports.execute('/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw','-o','-',plist])).trim(),architectures=(await ports.execute('/usr/bin/lipo',['-archs',input.executablePath])).trim().split(/\s+/);
  if(identifier!=='com.linkflow.personal'||version!==input.targetVersion||architectures.length!==1||architectures[0]!=='arm64')throw Error('macOS 更新应用身份不匹配');
  if(await ports.hashTree(input.applicationPath)!==input.treeSha256)throw Error('macOS 更新应用树与已验证安装包不匹配');
}

async function snapshotTree(root:string):Promise<EntrySnapshot[]>{
  const rootReal=await files.realpath(root),rootSnapshot=await entryAt(root);if(rootSnapshot.kind!=='directory')throw Error('macOS 更新应用树根目录无效');
  const entries=[rootSnapshot];
  async function walk(directory:string,prefix:string):Promise<void>{
    const children=(await files.readdir(directory,{withFileTypes:true})).map(value=>value.name).sort((a,b)=>Buffer.from(a).compare(Buffer.from(b)));
    for(const name of children){
      if(entries.length>=maximumEntries)throw Error('macOS 更新应用文件数过多');
      const path=join(directory,name),relativePath=prefix?`${prefix}/${name}`:name,entry=await entryAt(path,relativePath);entries.push(entry);
      if(entry.kind!=='directory'&&entry.nlink!==1)throw Error('macOS 更新应用含有多重硬链接');
      if(entry.kind==='symlink'){
        const targetReal=await files.realpath(path).catch(()=>undefined);if(!targetReal||!inside(rootReal,targetReal,true))throw Error('macOS 更新应用含有越界符号链接');
      }else if(entry.kind==='directory')await walk(path,relativePath);
    }
  }
  await walk(root,'');return entries;
}

async function assertSnapshotStable(entries:EntrySnapshot[]):Promise<void>{
  for(const entry of entries)if(!sameEntry(entry,await entryAt(entry.path,entry.relativePath)))throw Error('macOS 更新应用路径在验证期间发生变化');
}

async function withStableEntry<T>(entry:EntrySnapshot,action:(descriptor:number)=>Promise<T>):Promise<T>{
  const symbolicLinkFlag=(fsConstants as typeof fsConstants&{O_SYMLINK?:number}).O_SYMLINK;if(entry.kind==='symlink'&&!symbolicLinkFlag)throw Error('当前系统无法安全打开更新应用符号链接');
  const flags=entry.kind==='symlink'?symbolicLinkFlag!:fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW|(entry.kind==='directory'?fsConstants.O_DIRECTORY:0),handle=await files.open(entry.path,flags);
  try{const current=snapshot(entry.path,entry.relativePath,await handle.stat());if(!sameEntry(entry,current)||current.kind!=='directory'&&current.nlink!==1)throw Error('macOS 更新应用路径在处理期间发生变化');return await action(handle.fd)}finally{await handle.close()}
}

async function hasQuarantine(entry:EntrySnapshot,probe:(descriptor:number,verifiedIdentity:MacQuarantineProbeIdentity)=>Promise<boolean>,verifiedIdentity:MacQuarantineProbeIdentity):Promise<boolean>{return withStableEntry(entry,descriptor=>probe(descriptor,verifiedIdentity))}

async function assertNoQuarantine(entries:EntrySnapshot[],probe:(descriptor:number,verifiedIdentity:MacQuarantineProbeIdentity)=>Promise<boolean>,verifiedIdentity:MacQuarantineProbeIdentity):Promise<void>{
  for(const entry of entries)if(await hasQuarantine(entry,probe,verifiedIdentity))throw Error('macOS 更新应用仍带有隔离属性');
}

async function applicationPathShape(input:VerifiedMacApplication):Promise<void>{
  if(!isAbsolute(input.applicationPath)||!isAbsolute(input.executablePath)||!input.applicationPath.endsWith('.app')||!inside(input.applicationPath,input.executablePath)||!/^[a-f0-9]{64}$/.test(input.treeSha256)||!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(input.targetVersion))throw Error('macOS 更新应用参数无效');
  const parent=dirname(input.applicationPath),parentInfo=await entryAt(parent),appInfo=await entryAt(input.applicationPath),parentReal=await files.realpath(parent),appReal=await files.realpath(input.applicationPath);
  if(parentInfo.kind!=='directory'||appInfo.kind!=='directory'||appReal!==join(parentReal,basename(input.applicationPath)))throw Error('macOS 更新应用不在受控真实路径');
}

async function controlledStage(input:VerifiedMacStage):Promise<ControlledStage>{
  await applicationPathShape(input);const stageRootPath=join(dirname(input.applicationPath),`.linkflow-update-${input.targetVersion}`),expectedApplicationPath=join(stageRootPath,basename(input.applicationPath)),executableRelative=relative(input.applicationPath,input.executablePath),expectedExecutablePath=join(expectedApplicationPath,executableRelative);
  if(resolve(input.stagedApplicationPath)!==resolve(expectedApplicationPath))throw Error('macOS 更新暂存路径不受控');
  const stageRoot=await entryAt(stageRootPath),stageApplication=await entryAt(input.stagedApplicationPath),stageRootReal=await files.realpath(stageRootPath),parentReal=await files.realpath(dirname(input.applicationPath)),stageApplicationReal=await files.realpath(input.stagedApplicationPath);
  if(stageRoot.kind!=='directory'||stageApplication.kind!=='directory'||stageRootReal!==join(parentReal,basename(stageRootPath))||stageApplicationReal!==join(stageRootReal,basename(input.applicationPath)))throw Error('macOS 更新暂存路径不受控');
  if(!isAbsolute(input.updatesDirectory)||!isAbsolute(input.artifactPath)||!inside(input.updatesDirectory,input.artifactPath)||!Number.isSafeInteger(input.artifactSize)||input.artifactSize<1||!/^[a-f0-9]{64}$/.test(input.artifactSha256))throw Error('macOS 更新安装包参数无效');
  const updatesInfo=await entryAt(input.updatesDirectory),archive=await entryAt(input.artifactPath),updatesReal=await files.realpath(input.updatesDirectory),archiveReal=await files.realpath(input.artifactPath);
  if(updatesInfo.kind!=='directory'||archive.kind!=='file'||!inside(updatesReal,archiveReal))throw Error('macOS 更新安装包不在受控目录');
  return {application:{applicationPath:input.stagedApplicationPath,executablePath:expectedExecutablePath,targetVersion:input.targetVersion,treeSha256:input.treeSha256},archive};
}

/** Verifies the exact fixed-stage tree is quarantine-free without mutating any attribute. */
export async function verifyVerifiedMacStageQuarantineFree(input:VerifiedMacStage,overrides:Partial<MacQuarantinePorts>={}):Promise<void>{
  const ports={...realPorts,...overrides},controlled=await controlledStage(input);
  await verifyArchive(input,controlled.archive);await verifyBundle(controlled.application,ports);
  const entries=await snapshotTree(controlled.application.applicationPath);
  const firstProbeIdentity=await ports.verifyProbe();
  await assertNoQuarantine(entries,ports.probeQuarantine,firstProbeIdentity);
  await assertSnapshotStable(entries);await verifyArchive(input,controlled.archive);await verifyBundle(controlled.application,ports);await assertSnapshotStable(entries);
  const secondProbeIdentity=await ports.verifyProbe();
  await assertNoQuarantine(entries,ports.probeQuarantine,secondProbeIdentity);
}

/** Revalidates the installed application and proves quarantine is absent before launch. */
export async function verifyMacApplicationQuarantineFree(input:VerifiedMacApplication,overrides:Partial<MacQuarantinePorts>={}):Promise<void>{
  const ports={...realPorts,...overrides};await applicationPathShape(input);await verifyBundle(input,ports);const entries=await snapshotTree(input.applicationPath),verifiedProbeIdentity=await ports.verifyProbe();await assertNoQuarantine(entries,ports.probeQuarantine,verifiedProbeIdentity);await assertSnapshotStable(entries);await verifyBundle(input,ports);
}
