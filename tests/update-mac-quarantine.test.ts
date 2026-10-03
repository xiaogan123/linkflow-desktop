import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod,cp,link,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {verifyMacApplicationQuarantineFree,verifyVerifiedMacStageQuarantineFree,type MacQuarantinePorts,type VerifiedMacStage} from '../src/main/update-mac-quarantine';
import {hashUpdateTree} from '../src/main/update-tree';

const quarantine='com.apple.quarantine',otherAttribute='com.linkflow.keep';
function sha(value:Buffer|string){return createHash('sha256').update(value).digest('hex')}
function native(file:string,args:string[]):Promise<string>{return new Promise((done,reject)=>execFile(file,args,{encoding:'utf8',timeout:30_000,maxBuffer:1024*1024,shell:false},(error,stdout)=>error?reject(error):done(stdout)))}
async function writeAttribute(path:string,name:string,value:string,symlinkItself=false){await native('/usr/bin/xattr',['-w',...(symlinkItself?['-s']:[]),name,value,path])}
async function readAttribute(path:string,name:string,symlinkItself=false):Promise<string|undefined>{try{return (await native('/usr/bin/xattr',['-p',...(symlinkItself?['-s']:[]),name,path])).trimEnd()}catch{return}}

async function fixture(directory:string){
  const parent=join(directory,'Applications'),applicationPath=join(parent,'外链助手.app'),executablePath=join(applicationPath,'Contents','MacOS','外链助手'),stageRoot=join(parent,'.linkflow-update-1.2.6'),stagedApplicationPath=join(stageRoot,'外链助手.app'),stagedExecutablePath=join(stagedApplicationPath,'Contents','MacOS','外链助手'),nested=join(stagedApplicationPath,'Contents','Resources','nested.txt'),internalLink=join(stagedApplicationPath,'Contents','Resources','nested-link'),updatesDirectory=join(directory,'user-data','updates'),artifactPath=join(updatesDirectory,'Linkflow-1.2.6-darwin-arm64.zip'),archive=Buffer.from('signed archive');
  await mkdir(join(applicationPath,'Contents','MacOS'),{recursive:true});await writeFile(executablePath,'old',{mode:0o755});
  await mkdir(join(stagedApplicationPath,'Contents','MacOS'),{recursive:true});await mkdir(join(stagedApplicationPath,'Contents','Resources'),{recursive:true});await writeFile(join(stagedApplicationPath,'Contents','Info.plist'),'plist');await writeFile(stagedExecutablePath,'new executable',{mode:0o755});await chmod(stagedExecutablePath,0o755);await writeFile(nested,'nested');await symlink('nested.txt',internalLink);
  await mkdir(updatesDirectory,{recursive:true});await writeFile(artifactPath,archive);
  const request:VerifiedMacStage={updatesDirectory,artifactPath,artifactSize:archive.length,artifactSha256:sha(archive),applicationPath,executablePath,stagedApplicationPath,targetVersion:'1.2.6',treeSha256:await hashUpdateTree(stagedApplicationPath)};
  return {request,applicationPath,executablePath,stageRoot,stagedApplicationPath,stagedExecutablePath,nested,internalLink,artifactPath};
}

function ports(commands:Array<{file:string;args:string[]}>):MacQuarantinePorts{
  return {hashTree:hashUpdateTree,execute:async(file,args)=>{commands.push({file,args:[...args]});if(file==='/usr/bin/xattr')return native(file,args);if(file==='/usr/bin/codesign')return '';if(file==='/usr/bin/plutil')return args[1]==='CFBundleIdentifier'?'com.linkflow.personal\n':'1.2.6\n';if(file==='/usr/bin/lipo')return 'arm64\n';throw Error(`unexpected command ${file}`)}};
}

test('verified Mac stage rejects residual quarantine without changing any attribute',{skip:process.platform==='darwin'?false:'macOS xattr behavior'},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'linkflow-quarantine-'));try{
    const value=await fixture(directory),commands:Array<{file:string;args:string[]}>=[],run=ports(commands);await writeAttribute(value.stagedApplicationPath,quarantine,'0081;test;Linkflow;');await writeAttribute(value.nested,quarantine,'0081;test;Linkflow;');await writeAttribute(value.internalLink,quarantine,'0081;test;Linkflow;',true);await writeAttribute(value.nested,otherAttribute,'preserve-me');
    await assert.rejects(verifyVerifiedMacStageQuarantineFree(value.request,run),/仍带有隔离属性/);
    assert.equal(await readAttribute(value.stagedApplicationPath,quarantine),'0081;test;Linkflow;');assert.equal(await readAttribute(value.nested,quarantine),'0081;test;Linkflow;');assert.equal(await readAttribute(value.internalLink,quarantine,true),'0081;test;Linkflow;');assert.equal(await readAttribute(value.nested,otherAttribute),'preserve-me');assert.equal(commands.some(command=>command.file==='/usr/bin/xattr'),false);
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('verified Mac stage without quarantine is idempotent',{skip:process.platform==='darwin'?false:'macOS xattr behavior'},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'linkflow-quarantine-none-'));try{const value=await fixture(directory),commands:Array<{file:string;args:string[]}>=[],run=ports(commands);await writeAttribute(value.nested,otherAttribute,'keep');await verifyVerifiedMacStageQuarantineFree(value.request,run);assert.equal(commands.some(command=>command.file==='/usr/bin/xattr'),false);assert.equal(await readAttribute(value.nested,otherAttribute),'keep');await verifyMacApplicationQuarantineFree({applicationPath:value.stagedApplicationPath,executablePath:value.stagedExecutablePath,targetVersion:'1.2.6',treeSha256:value.request.treeSha256},run)}finally{await rm(directory,{recursive:true,force:true})}
});

test('archive hash mismatch fails before any quarantine inspection',{skip:process.platform==='darwin'?false:'macOS xattr behavior'},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'linkflow-quarantine-archive-'));try{const value=await fixture(directory),commands:Array<{file:string;args:string[]}>=[],run=ports(commands);await writeAttribute(value.stagedApplicationPath,quarantine,'0081;test;Linkflow;');await assert.rejects(verifyVerifiedMacStageQuarantineFree({...value.request,artifactSha256:'0'.repeat(64)},run),/完整性/);assert.equal(commands.some(command=>command.file==='/usr/bin/xattr'),false);assert.equal(await readAttribute(value.stagedApplicationPath,quarantine),'0081;test;Linkflow;')}finally{await rm(directory,{recursive:true,force:true})}
});

test('tree mutation during verification fails without changing attributes',{skip:process.platform==='darwin'?false:'macOS xattr behavior'},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'linkflow-quarantine-tree-'));try{
    const value=await fixture(directory),commands:Array<{file:string;args:string[]}>=[],base=ports(commands);await writeAttribute(value.nested,otherAttribute,'keep');let hashes=0;const run:MacQuarantinePorts={...base,hashTree:async root=>{hashes+=1;if(hashes===2)await writeFile(value.nested,'changed');return hashUpdateTree(root)}};
    await assert.rejects(verifyVerifiedMacStageQuarantineFree(value.request,run),/应用树|验证期间/);assert.equal(commands.some(command=>command.file==='/usr/bin/xattr'),false);assert.equal(await readAttribute(value.nested,otherAttribute),'keep');
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('hardlinked staged files fail closed without touching the external inode',{skip:process.platform==='darwin'?false:'macOS xattr behavior'},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'linkflow-quarantine-hardlink-'));try{const value=await fixture(directory),outside=join(directory,'outside.txt'),commands:Array<{file:string;args:string[]}>=[],run=ports(commands);await writeFile(outside,'nested');await rm(value.nested);await link(outside,value.nested);await writeAttribute(outside,quarantine,'0081;external;Linkflow;');value.request.treeSha256=await hashUpdateTree(value.stagedApplicationPath);await assert.rejects(verifyVerifiedMacStageQuarantineFree(value.request,run),/多重硬链接/);assert.equal(await readAttribute(outside,quarantine),'0081;external;Linkflow;');assert.equal(commands.some(command=>command.file==='/usr/bin/xattr'),false)}finally{await rm(directory,{recursive:true,force:true})}
});

test('arbitrary stage paths and external links cannot affect attributes outside the verified tree',{skip:process.platform==='darwin'?false:'macOS xattr behavior'},async t=>{
  await t.test('arbitrary stage path',async()=>{const directory=await mkdtemp(join(tmpdir(),'linkflow-quarantine-path-'));try{const value=await fixture(directory),other=join(dirname(value.stageRoot),'attacker','外链助手.app'),commands:Array<{file:string;args:string[]}>=[],run=ports(commands);await mkdir(dirname(other),{recursive:true});await cp(value.stagedApplicationPath,other,{recursive:true});await writeAttribute(other,quarantine,'0081;test;Linkflow;');await assert.rejects(verifyVerifiedMacStageQuarantineFree({...value.request,stagedApplicationPath:other},run),/暂存路径不受控/);assert.equal(await readAttribute(other,quarantine),'0081;test;Linkflow;');assert.equal(commands.some(command=>command.file==='/usr/bin/xattr'),false)}finally{await rm(directory,{recursive:true,force:true})}});
  await t.test('external symlink',async()=>{const directory=await mkdtemp(join(tmpdir(),'linkflow-quarantine-link-'));try{const value=await fixture(directory),outside=join(directory,'outside.txt'),externalLink=join(value.stagedApplicationPath,'Contents','Resources','outside-link'),commands:Array<{file:string;args:string[]}>=[],run=ports(commands);await writeFile(outside,'outside');await symlink(outside,externalLink);await writeAttribute(value.stagedApplicationPath,quarantine,'0081;test;Linkflow;');await writeAttribute(outside,quarantine,'0081;external;Linkflow;');await assert.rejects(verifyVerifiedMacStageQuarantineFree({...value.request,treeSha256:'a'.repeat(64)},run),/越界符号链接/);assert.equal(await readAttribute(value.stagedApplicationPath,quarantine),'0081;test;Linkflow;');assert.equal(await readAttribute(outside,quarantine),'0081;external;Linkflow;');assert.equal(commands.some(command=>command.file==='/usr/bin/xattr'),false)}finally{await rm(directory,{recursive:true,force:true})}});
});

test('quarantine-free verification rejects a nested marker before launch',{skip:process.platform==='darwin'?false:'macOS xattr behavior'},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'linkflow-quarantine-ready-'));try{const value=await fixture(directory),run=ports([]);await writeAttribute(value.nested,quarantine,'0081;test;Linkflow;');await assert.rejects(verifyMacApplicationQuarantineFree({applicationPath:value.stagedApplicationPath,executablePath:value.stagedExecutablePath,targetVersion:'1.2.6',treeSha256:value.request.treeSha256},run),/仍带有隔离属性/);assert.equal(await readAttribute(value.nested,quarantine),'0081;test;Linkflow;')}finally{await rm(directory,{recursive:true,force:true})}
});
