import test from 'node:test';
import assert from 'node:assert/strict';
import type {Stats} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {MacTargetPorts} from '../src/main/update-mac-target';
import {resolveMacUpdateTarget} from '../src/main/update-mac-target';

const directory=()=>({isDirectory:()=>true,isFile:()=>false,isSymbolicLink:()=>false}) as Stats;
const file=()=>({isDirectory:()=>false,isFile:()=>true,isSymbolicLink:()=>false}) as Stats;
const syntheticHome=join(tmpdir(),'linkflow-synthetic-home'),userApplications=join(syntheticHome,'Applications');

function ports(options:{matches?:string[];writable?:string[];candidateDigest?:string}={}):Partial<MacTargetPorts>{
 const matches=options.matches??['/Applications'],writable=options.writable??['/Applications'],running='/private/var/folders/x/T/AppTranslocation/ABC/d/外链助手.app';
 return {
  lstat:(async(path:string)=>path.endsWith('/Contents/MacOS/外链助手')?file():directory()) as MacTargetPorts['lstat'],
  realpath:(async(path:string)=>path) as MacTargetPorts['realpath'],
  access:(async(path:string)=>{if(!writable.includes(path as never))throw Object.assign(Error('readonly'),{code:'EACCES'})}) as MacTargetPorts['access'],
  execute:async(filePath,args)=>{if(filePath==='/sbin/mount')return `/Applications/外链助手.app on /private/var/folders/x/T/AppTranslocation/ABC (nullfs, local, nodev, nosuid, read-only, nobrowse, mounted by test)\n`;if(filePath==='/usr/bin/plutil')return args[1]==='CFBundleIdentifier'?'com.linkflow.personal\n':'1.2.0\n';if(filePath==='/usr/bin/lipo')return 'arm64\n';return ''},
  hashTree:async(path:string)=>path===running?'same':matches.some(root=>path===root+'/外链助手.app')?(options.candidateDigest??'same'):'different'
 };
}

const input={runningApplicationPath:'/private/var/folders/x/T/AppTranslocation/ABC/d/外链助手.app',runningExecutablePath:'/private/var/folders/x/T/AppTranslocation/ABC/d/外链助手.app/Contents/MacOS/外链助手',runningHelperPath:'/private/var/folders/x/T/AppTranslocation/ABC/d/外链助手.app/Contents/Resources/app.asar/dist-electron/update-helper.cjs',homeDirectory:syntheticHome,currentVersion:'1.2.0'};

test('translocated Mac bundle resolves only the unique identical writable Applications copy',async()=>{
 const target=await resolveMacUpdateTarget(input,ports());assert.deepEqual(target,{applicationPath:'/Applications/外链助手.app',executablePath:'/Applications/外链助手.app/Contents/MacOS/外链助手',helperPath:'/Applications/外链助手.app/Contents/Resources/app.asar/dist-electron/update-helper.cjs'});
});

test('translocated Mac bundle rejects duplicate, changed, and read-only install targets',async()=>{
 assert.equal(await resolveMacUpdateTarget(input,ports({matches:['/Applications',userApplications],writable:['/Applications',userApplications]})),undefined);
 assert.equal(await resolveMacUpdateTarget(input,ports({candidateDigest:'changed'})),undefined);
 assert.equal(await resolveMacUpdateTarget(input,ports({writable:[]})),undefined);
});
