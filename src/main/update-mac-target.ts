import {constants as fsConstants} from 'node:fs';
import {access,lstat,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {hashUpdateTree} from './update-tree';

export interface MacUpdateTarget {
  applicationPath:string;
  executablePath:string;
  helperPath:string;
}

export interface MacTargetPorts {
  access:typeof access;
  lstat:typeof lstat;
  realpath:typeof realpath;
  execute:(file:string,args:string[])=>Promise<string>;
  hashTree:(root:string)=>Promise<string>;
}

const realPorts:MacTargetPorts={
  access,
  lstat,
  realpath,
  execute:(file,args)=>new Promise((done,reject)=>execFile(file,args,{encoding:'utf8',timeout:120_000,maxBuffer:4*1024*1024,shell:false},(error,stdout)=>error?reject(error):done(stdout))),
  hashTree:hashUpdateTree
};

function inside(parent:string,child:string):boolean{const path=relative(resolve(parent),resolve(child));return path!==''&&path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path)}

async function validRoot(root:string,ports:MacTargetPorts):Promise<string|undefined>{
  try{const info=await ports.lstat(root);if(!info.isDirectory()||info.isSymbolicLink())return;return await ports.realpath(root)}catch{return}
}

async function validateBundle(applicationPath:string,executablePath:string,version:string,ports:MacTargetPorts):Promise<boolean>{
  try{
    const appInfo=await ports.lstat(applicationPath),executableInfo=await ports.lstat(executablePath);
    if(!appInfo.isDirectory()||appInfo.isSymbolicLink()||!executableInfo.isFile()||executableInfo.isSymbolicLink())return false;
    await ports.execute('/usr/bin/codesign',['--verify','--deep','--strict',applicationPath]);
    const plist=join(applicationPath,'Contents','Info.plist');
    const [identifier,bundleVersion,architectures]=await Promise.all([
      ports.execute('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',plist]),
      ports.execute('/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw','-o','-',plist]),
      ports.execute('/usr/bin/lipo',['-archs',executablePath])
    ]);
    return identifier.trim()==='com.linkflow.personal'&&bundleVersion.trim()===version&&architectures.trim()==='arm64';
  }catch{return false}
}

function confirmedTranslocation(applicationPath:string,mountOutput:string):boolean{
  const resolved=resolve(applicationPath);
  if(!resolved.startsWith('/private/var/folders/')||!resolved.includes('/AppTranslocation/'))return false;
  for(const line of mountOutput.split('\n')){
    const marker=' on ',options=' (';
    const on=line.indexOf(marker),open=line.indexOf(options,on+marker.length);if(on<0||open<0)continue;
    const mountPoint=line.slice(on+marker.length,open),flags=line.slice(open+2,-1).split(',').map(value=>value.trim());
    if((resolved===mountPoint||resolved.startsWith(mountPoint+sep))&&flags.includes('nullfs')&&flags.includes('read-only')&&flags.includes('nobrowse'))return true;
  }
  return false;
}

/** Resolves a writable, durable bundle without guessing the pre-translocation path. */
export async function resolveMacUpdateTarget(input:{runningApplicationPath:string;runningExecutablePath:string;runningHelperPath:string;homeDirectory:string;currentVersion:string},overrides:Partial<MacTargetPorts>={}):Promise<MacUpdateTarget|undefined>{
  const ports={...realPorts,...overrides},applicationName=basename(input.runningApplicationPath),executableRelative=relative(input.runningApplicationPath,input.runningExecutablePath),helperRelative=relative(input.runningApplicationPath,input.runningHelperPath);
  if(!applicationName.endsWith('.app')||!inside(input.runningApplicationPath,input.runningExecutablePath)||!inside(input.runningApplicationPath,input.runningHelperPath))return;
  const roots=['/Applications',join(input.homeDirectory,'Applications')],rootRecords=(await Promise.all(roots.map(async root=>({root,real:await validRoot(root,ports)})))).filter((record):record is {root:string;real:string}=>!!record.real);
  const runningReal=await ports.realpath(input.runningApplicationPath).catch(()=>undefined);
  for(const root of rootRecords){
    const candidate=join(root.root,applicationName),candidateReal=await ports.realpath(candidate).catch(()=>undefined);
    if(runningReal&&candidateReal===runningReal&&dirname(candidateReal)===root.real&&await validateBundle(candidate,join(candidate,executableRelative),input.currentVersion,ports)){
      try{await ports.access(root.root,fsConstants.W_OK);return {applicationPath:candidate,executablePath:join(candidate,executableRelative),helperPath:join(candidate,helperRelative)}}catch{return}
    }
  }
  const mountOutput=await ports.execute('/sbin/mount',[]).catch(()=>''),translocated=confirmedTranslocation(input.runningApplicationPath,mountOutput);
  if(!translocated)return;
  if(!await validateBundle(input.runningApplicationPath,input.runningExecutablePath,input.currentVersion,ports))return;
  const runningDigest=await ports.hashTree(input.runningApplicationPath),matches:MacUpdateTarget[]=[];
  for(const root of rootRecords){
    const candidate=join(root.root,applicationName),candidateExecutable=join(candidate,executableRelative),candidateHelper=join(candidate,helperRelative);
    try{
      const candidateReal=await ports.realpath(candidate);if(dirname(candidateReal)!==root.real)continue;
      await ports.access(root.root,fsConstants.W_OK);
      if(!await validateBundle(candidate,candidateExecutable,input.currentVersion,ports))continue;
      if(await ports.hashTree(candidate)!==runningDigest)continue;
      matches.push({applicationPath:candidate,executablePath:candidateExecutable,helperPath:candidateHelper});
    }catch{}
  }
  return matches.length===1?matches[0]:undefined;
}
