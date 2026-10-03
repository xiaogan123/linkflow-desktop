import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFile,chmod,copyFile,cp,link,mkdir,mkdtemp,open,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {macQuarantineProbeFilename,probeMacQuarantineDescriptor,readMacQuarantineProbeIdentity} from '../src/main/update-files';
import {macQuarantineProbePath,verifyMacApplicationQuarantineFree,verifyMacQuarantineProbeResource,verifyVerifiedMacStageQuarantineFree,type MacQuarantinePorts,type VerifiedMacStage} from '../src/main/update-mac-quarantine';
import {hashUpdateTree} from '../src/main/update-tree';

const quarantine='com.apple.quarantine',otherAttribute='com.linkflow.keep';
let probeDirectory='',probePath='';
function sha(value:Buffer|string){return createHash('sha256').update(value).digest('hex')}
function native(file:string,args:string[]):Promise<string>{return new Promise((done,reject)=>execFile(file,args,{encoding:'utf8',timeout:30_000,maxBuffer:1024*1024,shell:false},(error,stdout)=>error?reject(error):done(stdout)))}
async function writeAttribute(path:string,name:string,value:string,symlinkItself=false){await native('/usr/bin/xattr',['-w',...(symlinkItself?['-s']:[]),name,value,path])}
async function readAttribute(path:string,name:string,symlinkItself=false):Promise<string|undefined>{try{return (await native('/usr/bin/xattr',['-p',...(symlinkItself?['-s']:[]),name,path])).trimEnd()}catch{return}}

before(async()=>{
  if(process.platform!=='darwin')return;
  probeDirectory=await mkdtemp(join(tmpdir(),'linkflow-quarantine-probe-'));probePath=join(probeDirectory,macQuarantineProbeFilename);
  await native('/usr/bin/clang',['-Os','-Wall','-Wextra','-Werror','-arch','arm64','-mmacosx-version-min=14.0',resolve('src/native/update-quarantine-probe.c'),'-o',probePath]);await chmod(probePath,0o755);
});
after(async()=>{if(probeDirectory)await rm(probeDirectory,{recursive:true,force:true})});

async function fixture(directory:string){
  const parent=join(directory,'Applications'),applicationPath=join(parent,'外链助手.app'),executablePath=join(applicationPath,'Contents','MacOS','外链助手'),stageRoot=join(parent,'.linkflow-update-1.2.6'),stagedApplicationPath=join(stageRoot,'外链助手.app'),stagedExecutablePath=join(stagedApplicationPath,'Contents','MacOS','外链助手'),nested=join(stagedApplicationPath,'Contents','Resources','nested.txt'),internalLink=join(stagedApplicationPath,'Contents','Resources','nested-link'),updatesDirectory=join(directory,'user-data','updates'),artifactPath=join(updatesDirectory,'Linkflow-1.2.6-darwin-arm64.zip'),archive=Buffer.from('signed archive');
  await mkdir(join(applicationPath,'Contents','MacOS'),{recursive:true});await writeFile(executablePath,'old',{mode:0o755});
  await mkdir(join(stagedApplicationPath,'Contents','MacOS'),{recursive:true});await mkdir(join(stagedApplicationPath,'Contents','Resources'),{recursive:true});await writeFile(join(stagedApplicationPath,'Contents','Info.plist'),'plist');await writeFile(stagedExecutablePath,'new executable',{mode:0o755});await chmod(stagedExecutablePath,0o755);await writeFile(nested,'nested');await symlink('nested.txt',internalLink);
  await mkdir(updatesDirectory,{recursive:true});await writeFile(artifactPath,archive);
  const request:VerifiedMacStage={updatesDirectory,artifactPath,artifactSize:archive.length,artifactSha256:sha(archive),applicationPath,executablePath,stagedApplicationPath,targetVersion:'1.2.6',treeSha256:await hashUpdateTree(stagedApplicationPath)};
  return {request,applicationPath,executablePath,stageRoot,stagedApplicationPath,stagedExecutablePath,nested,internalLink,artifactPath};
}

function ports(commands:Array<{file:string;args:string[]}>):MacQuarantinePorts{
  return {hashTree:hashUpdateTree,probeQuarantine:(descriptor,verifiedIdentity)=>probeMacQuarantineDescriptor(probePath,descriptor,verifiedIdentity),verifyProbe:()=>readMacQuarantineProbeIdentity(probePath),execute:async(file,args)=>{commands.push({file,args:[...args]});if(file==='/usr/bin/xattr')return native(file,args);if(file==='/usr/bin/codesign')return '';if(file==='/usr/bin/plutil')return args[1]==='CFBundleIdentifier'?'com.linkflow.personal\n':'1.2.6\n';if(file==='/usr/bin/lipo')return 'arm64\n';throw Error(`unexpected command ${file}`)}};
}

test('Mac quarantine probe has a fixed Resources path and fails closed on misuse',{skip:process.platform==='darwin'?false:'macOS native helper behavior'},async()=>{
  assert.equal(macQuarantineProbePath('/Applications/外链助手.app/Contents/Resources'),'/Applications/外链助手.app/Contents/Resources/'+macQuarantineProbeFilename);
  assert.throws(()=>macQuarantineProbePath('relative/resources'),/路径无效/);
  await assert.rejects(native(probePath,['/tmp/arbitrary-path']));
  await assert.rejects(native(probePath,[]));
  const directory=await mkdtemp(join(tmpdir(),'linkflow-quarantine-invalid-output-')),file=join(directory,'entry'),invalid=join(directory,macQuarantineProbeFilename);try{
    await writeFile(file,'value');const handle=await open(file,'r');try{const trustedIdentity=await readMacQuarantineProbeIdentity(probePath);await assert.rejects(probeMacQuarantineDescriptor(invalid,handle.fd,trustedIdentity));await writeFile(invalid,'#!/bin/sh\nprintf "0\\n"\nprintf noise >&2\n',{mode:0o755});const noisyIdentity=await readMacQuarantineProbeIdentity(invalid);await assert.rejects(probeMacQuarantineDescriptor(invalid,handle.fd,noisyIdentity),/执行失败/);await writeFile(invalid,'#!/bin/sh\nprintf "2\\n"\n');const invalidIdentity=await readMacQuarantineProbeIdentity(invalid);await assert.rejects(probeMacQuarantineDescriptor(invalid,handle.fd,invalidIdentity),/输出无效/)}finally{await handle.close()}
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('Mac quarantine probe rejects a modified signed Resources helper',{skip:process.platform==='darwin'?false:'macOS code-signing behavior'},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'linkflow-quarantine-signature-')),application=join(directory,'Probe.app'),resources=join(application,'Contents','Resources'),main=join(application,'Contents','MacOS','Probe'),helper=join(resources,macQuarantineProbeFilename);try{
    await mkdir(dirname(main),{recursive:true});await mkdir(resources);await copyFile(probePath,main);await copyFile(probePath,helper);await chmod(main,0o755);await chmod(helper,0o755);await writeFile(join(application,'Contents','Info.plist'),'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.linkflow.probe-test</string><key>CFBundleExecutable</key><string>Probe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');await native('/usr/bin/codesign',['--force','--deep','--sign','-',application]);await verifyMacQuarantineProbeResource(resources,native);await appendFile(helper,'tampered');await assert.rejects(verifyMacQuarantineProbeResource(resources,native));
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('Mac quarantine scan binds every probe to the helper identity that passed signature verification',{skip:process.platform==='darwin'?false:'macOS code-signing behavior'},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'linkflow-quarantine-identity-')),application=join(directory,'Probe.app'),resources=join(application,'Contents','Resources'),main=join(application,'Contents','MacOS','Probe'),helper=join(resources,macQuarantineProbeFilename);try{
    await mkdir(dirname(main),{recursive:true});await mkdir(resources);await copyFile(probePath,main);await copyFile(probePath,helper);await chmod(main,0o755);await chmod(helper,0o755);await writeFile(join(application,'Contents','Info.plist'),'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.linkflow.probe-identity-test</string><key>CFBundleExecutable</key><string>Probe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');await native('/usr/bin/codesign',['--force','--deep','--sign','-',application]);const value=await fixture(join(directory,'target')),base=ports([]);await writeAttribute(value.stagedApplicationPath,quarantine,'0081;test;Linkflow;');let replaced=false;await assert.rejects(verifyVerifiedMacStageQuarantineFree(value.request,{...base,verifyProbe:()=>verifyMacQuarantineProbeResource(resources,native),probeQuarantine:async(descriptor,verifiedIdentity)=>{if(!replaced){replaced=true;await writeFile(helper,'#!/bin/sh\nprintf "0\\n"\n');await chmod(helper,0o755)}return probeMacQuarantineDescriptor(helper,descriptor,verifiedIdentity)}}),/发生变化/);assert.equal(replaced,true);assert.equal(await readAttribute(value.stagedApplicationPath,quarantine),'0081;test;Linkflow;');
  }finally{await rm(directory,{recursive:true,force:true})}
});

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

test('verified Mac stage reads quarantine from the bound internal symlink',{skip:process.platform==='darwin'?false:'macOS xattr behavior'},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'linkflow-quarantine-symlink-'));try{const value=await fixture(directory),run=ports([]);await writeAttribute(value.internalLink,quarantine,'0081;test;Linkflow;',true);await assert.rejects(verifyVerifiedMacStageQuarantineFree(value.request,run),/仍带有隔离属性/);assert.equal(await readAttribute(value.internalLink,quarantine,true),'0081;test;Linkflow;')}finally{await rm(directory,{recursive:true,force:true})}
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
