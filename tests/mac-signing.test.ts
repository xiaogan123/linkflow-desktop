import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdtemp,mkdir,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {basename,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
// @ts-expect-error Release scripts intentionally remain standalone JavaScript modules.
import {finishMacArtifact,macSignOptions,resolveMacBuildConfig,runPrivateMacStage,validateDeveloperIdIdentity,validateMacReleaseArchive} from '../scripts/lib/mac-signing.mjs';

const developerHash='A'.repeat(40);
const developerName='Developer ID Application: Example Publisher (ABCDE12345)';

test('formal macOS packaging fails closed without both release inputs',()=>{
  assert.throws(()=>resolveMacBuildConfig([],{}),/requires LINKFLOW_MAC_SIGNING_IDENTITY and LINKFLOW_MAC_NOTARY_PROFILE/);
  assert.throws(()=>resolveMacBuildConfig([],{LINKFLOW_MAC_SIGNING_IDENTITY:developerName}),/requires LINKFLOW_MAC_SIGNING_IDENTITY and LINKFLOW_MAC_NOTARY_PROFILE/);
});

test('explicit local mode is isolated, ad-hoc, and cannot use a formal artifact name',()=>{
  const config=resolveMacBuildConfig(['--local'],{}),options=macSignOptions(config);
  assert.equal(config.mode,'local');
  assert.equal(config.artifactSuffix,'mac-arm64-local-adhoc');
  assert.equal(options.identity,'-');
  assert.equal(options.identityValidation,false);
  assert.equal(options.continueOnError,false);
  assert.deepEqual(options.optionsForFile('fixture'),{hardenedRuntime:false,timestamp:'none'});
});

test('unnotarized publication requires an explicit mode; default requirements remain unchanged',()=>{
  const config=resolveMacBuildConfig(['--unnotarized-release'],{});
  assert.deepEqual(config,{mode:'unnotarized',artifactSuffix:'mac-arm64'});
  assert.equal(macSignOptions(config).identity,'-');
  assert.throws(()=>resolveMacBuildConfig(['--local','--unnotarized-release'],{}));
  assert.throws(()=>resolveMacBuildConfig([],{}));
});

test('formal signing requires an exact Developer ID Application identity and uses its hash',async()=>{
  const output=`  1) ${developerHash} "${developerName}"\n  2) ${'B'.repeat(40)} "Apple Development: Example Publisher (ABCDE12345)"\n`;
  const execute=async()=>({stdout:output,stderr:'',code:0});
  const hash=await validateDeveloperIdIdentity(developerName,{execute,diagnosticsDir:join(tmpdir(),'unused-linkflow-diagnostics')});
  const options=macSignOptions({...resolveMacBuildConfig([],{LINKFLOW_MAC_SIGNING_IDENTITY:developerName,LINKFLOW_MAC_NOTARY_PROFILE:'linkflow-notary'}),signingIdentityHash:hash,mainAppName:'外链助手.app',mainEntitlementsPath:'/public/project/scripts/entitlements.mac.plist'});
  assert.equal(hash,developerHash);
  assert.equal(options.identity,developerHash);
  assert.equal(options.continueOnError,false);
  assert.deepEqual(options.optionsForFile('/tmp/外链助手.app'),{hardenedRuntime:true,timestamp:undefined,entitlements:'/public/project/scripts/entitlements.mac.plist'});
  assert.deepEqual(options.optionsForFile('/tmp/外链助手.app/Contents/Frameworks/外链助手 Helper (Renderer).app'),{hardenedRuntime:true,timestamp:undefined});
  const privateDiagnostics=await mkdtemp(join(tmpdir(),'linkflow-non-developer-id-'));
  try{
    await assert.rejects(validateDeveloperIdIdentity('Apple Development: Example Publisher (ABCDE12345)',{execute,diagnosticsDir:privateDiagnostics}),/developer-id-identity-check/);
  }finally{await rm(privateDiagnostics,{recursive:true,force:true})}
});

test('installed osx-sign emits runtime plus secure timestamp for release and disables timestamp only for local ad-hoc',{
  skip:process.platform!=='darwin'?'@electron/osx-sign native argument behavior is macOS-only':false
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'linkflow-osx-sign-')),bin=join(root,'bin'),app=join(root,'Fixture.app'),contents=join(app,'Contents'),macos=join(contents,'MacOS'),log=join(root,'codesign.args');
  await mkdir(bin);await mkdir(macos,{recursive:true});
  await writeFile(join(contents,'Info.plist'),'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleIdentifier</key><string>com.example.fixture</string><key>CFBundleName</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>1.0.0</string><key>CFBundleVersion</key><string>1</string></dict></plist>\n');
  await writeFile(join(macos,'Fixture'),'#!/bin/sh\nexit 0\n');await chmod(join(macos,'Fixture'),0o755);
  await writeFile(join(bin,'codesign'),'#!/bin/sh\nprintf "CALL\\n" >> "$SIGN_ARGS_FILE"\nfor arg in "$@"; do printf "%s\\n" "$arg" >> "$SIGN_ARGS_FILE"; done\n');await chmod(join(bin,'codesign'),0o755);
  const moduleUrl=pathToFileURL(resolve('scripts/lib/mac-signing.mjs')).href,entitlements=resolve('scripts/entitlements.mac.plist');
  const runner=`import {sign} from '@electron/osx-sign';import {macSignOptions} from ${JSON.stringify(moduleUrl)};const mode=process.env.SIGN_MODE;const options=macSignOptions(mode==='local'?{mode:'local'}:{mode:'release',signingIdentityHash:'-',mainAppName:'Fixture.app',mainEntitlementsPath:process.env.ENTITLEMENTS});options.identityValidation=false;await sign({app:process.env.SIGN_APP,platform:'darwin',...options});`;
  const run=(mode:string)=>spawnSync(process.execPath,['--input-type=module','-e',runner],{cwd:resolve('.'),encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,SIGN_ARGS_FILE:log,SIGN_MODE:mode,SIGN_APP:app,ENTITLEMENTS:entitlements}});
  try{
    const release=run('release');assert.equal(release.status,0,release.stderr);const releaseArgs=await readFile(log,'utf8');
    assert.match(releaseArgs,/^--timestamp$/m);assert.match(releaseArgs,/^runtime$/m);assert(!releaseArgs.includes('--timestamp=none'));
    await writeFile(log,'');
    const local=run('local');assert.equal(local.status,0,local.stderr);const localArgs=await readFile(log,'utf8');
    assert.match(localArgs,/^--timestamp=none$/m);assert(!/^runtime$/m.test(localArgs));
  }finally{await rm(root,{recursive:true,force:true})}
});

test('packager signing failures remain nonzero while raw certificate and path details stay private',async()=>{
  const diagnosticsDir=await mkdtemp(join(tmpdir(),'linkflow-packager-private-'));
  try{
    const privateMarker='Developer ID Application: Private Person (/private/account/path)';
    let caught:unknown;
    try{await runPrivateMacStage('electron-packager-signing',async()=>{throw new Error(privateMarker)},{diagnosticsDir})}catch(error){caught=error}
    assert(caught instanceof Error);
    assert.match(caught.message,/electron-packager-signing/);
    assert(!String(caught.stack).includes(privateMarker));
    const diagnostics=await readdir(diagnosticsDir),body=await readFile(join(diagnosticsDir,diagnostics[0]),'utf8');
    assert.match(body,/Private Person/);
    if(process.platform!=='win32')assert.equal((await stat(join(diagnosticsDir,diagnostics[0]))).mode&0o777,0o600);
  }finally{await rm(diagnosticsDir,{recursive:true,force:true})}
});

type CommandResult={stdout:string;stderr:string;code:number};
type CommandExecutor=(file:string,args:string[],options?:{timeoutMs?:number})=>Promise<CommandResult>;

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'linkflow-mac-signing-'));
  const appPath=join(root,'外链助手.app'),diagnosticsDir=join(root,'private'),temporaryZipPath=join(root,'notary.zip'),finalZipTempPath=join(root,'.final.tmp'),finalZipPath=join(root,'final.zip'),checksumPath=join(root,'SHA256SUMS.txt');
  await mkdir(appPath);
  return {root,appPath,diagnosticsDir,temporaryZipPath,finalZipTempPath,finalZipPath,checksumPath};
}

function executorFor(paths:Awaited<ReturnType<typeof fixture>>,failStage?:'staple'|'spctl'|'quarantine'|'postarchive-codesign',notaryStatus='Accepted'){
  const calls:string[][]=[];
  const execute:CommandExecutor=async(file,args)=>{
    calls.push([file,...args]);
    if(file==='/usr/bin/ditto'&&args[0]==='-c')await writeFile(args.at(-1)!,args.at(-1)===paths.temporaryZipPath?'before-staple':'after-staple');
    if(file==='/usr/bin/ditto'&&args[0]==='-x')await mkdir(join(args.at(-1)!,'外链助手.app'));
    if(failStage==='postarchive-codesign'&&file==='/usr/bin/codesign'&&args[0]==='--verify'&&args.at(-1)!==paths.appPath)throw new Error('private extracted bundle verification detail');
    if(file==='/usr/bin/codesign'&&args[0]==='--display')return {stdout:'',stderr:`Authority=${developerName}\n`,code:0};
    if(file==='/usr/bin/xattr')return {stdout:failStage==='quarantine'?`${args.at(-1)}: com.apple.quarantine: 0081;fixture\n`:'',stderr:'',code:0};
    if(file==='/usr/bin/xcrun'&&args[0]==='notarytool'&&args[1]==='submit')return {stdout:JSON.stringify({status:notaryStatus,id:'00000000-0000-4000-8000-000000000001'}),stderr:'',code:0};
    if(file==='/usr/bin/xcrun'&&args[0]==='notarytool'&&args[1]==='log')return {stdout:'{"issues":[]}',stderr:'',code:0};
    if(failStage==='staple'&&file==='/usr/bin/xcrun'&&args[0]==='stapler'&&args[1]==='staple'){
      const error=Object.assign(new Error('stub'),{commandResult:{stdout:'',stderr:'secret-apple-account@example.invalid',code:65,signal:null}});throw error;
    }
    if(failStage==='spctl'&&file==='/usr/sbin/spctl'){
      const error=Object.assign(new Error('stub'),{commandResult:{stdout:'',stderr:'secret-gatekeeper-detail',code:3,signal:null}});throw error;
    }
    return {stdout:'',stderr:'',code:0};
  };
  return {calls,execute};
}

async function finish(paths:Awaited<ReturnType<typeof fixture>>,execute:CommandExecutor){
  return finishMacArtifact({...paths,mode:'release',notaryProfile:'linkflow-notary',execute,sha256Line:async(path:string)=>`digest  ${basename(path)}\n`});
}

test('formal ZIP and checksum are created only after Accepted, staple validation, and Gatekeeper acceptance',async()=>{
  const paths=await fixture(),{calls,execute}=executorFor(paths);
  try{
    await finish(paths,execute);
    assert.equal(await readFile(paths.finalZipPath,'utf8'),'after-staple');
    assert.match(await readFile(paths.checksumPath,'utf8'),/^digest  final\.zip/);
    const finalArchive=calls.findIndex(call=>call[0]==='/usr/bin/ditto'&&call.at(-1)===paths.finalZipTempPath);
    const staple=calls.findIndex(call=>call[0]==='/usr/bin/xcrun'&&call[1]==='stapler'&&call[2]==='staple');
    const validate=calls.findIndex(call=>call[0]==='/usr/bin/xcrun'&&call[1]==='stapler'&&call[2]==='validate');
    const gatekeeper=calls.findIndex(call=>call[0]==='/usr/sbin/spctl');
    const postExtract=calls.findIndex(call=>call[0]==='/usr/bin/ditto'&&call[1]==='-x'&&call[3]===paths.finalZipTempPath);
    const postVerify=calls.findIndex((call,index)=>index>postExtract&&call[0]==='/usr/bin/codesign'&&call[1]==='--verify');
    const quarantineCheck=calls.findIndex((call,index)=>index>postVerify&&call[0]==='/usr/bin/xattr');
    assert(staple>=0&&validate>staple&&gatekeeper>validate&&finalArchive>gatekeeper&&postExtract>finalArchive&&postVerify>postExtract&&quarantineCheck>postVerify);
    await assert.rejects(stat(paths.temporaryZipPath));
  }finally{await rm(paths.root,{recursive:true,force:true})}
});

test('a non-Accepted notarization never produces the formal ZIP',async()=>{
  const paths=await fixture(),{execute}=executorFor(paths,undefined,'Invalid');
  try{
    await assert.rejects(finish(paths,execute),/did not return Accepted/);
    await assert.rejects(stat(paths.finalZipPath));
    const diagnostics=await readdir(paths.diagnosticsDir);assert.equal(diagnostics.length,1);
    assert.match(await readFile(join(paths.diagnosticsDir,diagnostics[0]),'utf8'),/notary-accepted-check/);
  }finally{await rm(paths.root,{recursive:true,force:true})}
});

for(const blocked of ['staple','spctl'] as const)test(`${blocked} failure blocks publication and does not expose raw stderr`,async()=>{
  const paths=await fixture(),{execute}=executorFor(paths,blocked);
  try{
    let message='';try{await finish(paths,execute)}catch(error){message=String(error)}
    assert.match(message,blocked==='staple'?/staple/:/gatekeeper-assessment/);
    assert(!message.includes('secret-'));
    await assert.rejects(stat(paths.finalZipPath));
    const diagnostics=await readdir(paths.diagnosticsDir),body=await readFile(join(paths.diagnosticsDir,diagnostics[0]),'utf8');
    assert.match(body,/secret-/);
  }finally{await rm(paths.root,{recursive:true,force:true})}
});

test('local mode never calls notarytool, stapler, or Gatekeeper',async()=>{
  const paths=await fixture(),{calls,execute}=executorFor(paths);
  try{
    await finishMacArtifact({...paths,mode:'local',execute,sha256Line:async()=>`digest  final.zip\n`});
    assert.equal(calls.some(call=>call[0]==='/usr/bin/xcrun'||call[0]==='/usr/sbin/spctl'),false);
    const finalSign=calls.findIndex(call=>call[0]==='/usr/bin/codesign'&&call.slice(1,5).join(' ')==='--force --deep --sign -'&&call[5]===paths.appPath);
    const strictVerify=calls.findIndex((call,index)=>index>finalSign&&call[0]==='/usr/bin/codesign'&&call[1]==='--verify');
    const finalArchive=calls.findIndex((call,index)=>index>strictVerify&&call[0]==='/usr/bin/ditto'&&call[1]==='-c');
    assert(finalSign>=0&&strictVerify>finalSign&&finalArchive>strictVerify);
    assert.equal(await readFile(paths.finalZipPath,'utf8'),'after-staple');
  }finally{await rm(paths.root,{recursive:true,force:true})}
});

test('post-archive strict verification or quarantine blocks artifact publication',async()=>{
  for(const [failure,stage] of [['postarchive-codesign','post-archive-codesign-verification'],['quarantine','post-archive-quarantine-check']] as const){
    const paths=await fixture(),{execute}=executorFor(paths,failure);
    try{
      await assert.rejects(finishMacArtifact({...paths,mode:'unnotarized',execute,sha256Line:async()=>`digest  final.zip\n`}),new RegExp(stage));
      await assert.rejects(stat(paths.finalZipPath));
      await assert.rejects(stat(paths.checksumPath));
    }finally{await rm(paths.root,{recursive:true,force:true})}
  }
});

test('update signing preflight revalidates the exact archived app and binds its hash',async()=>{
  const root=await mkdtemp(join(tmpdir(),'linkflow-mac-archive-')),archivePath=join(root,'release.zip'),diagnosticsDir=join(root,'private'),calls:string[][]=[];
  await writeFile(archivePath,'exact formal archive');
  const execute:CommandExecutor=async(file,args)=>{
    calls.push([file,...args]);
    if(file==='/usr/bin/ditto')await mkdir(join(args.at(-1)!,'外链助手.app'));
    if(file==='/usr/bin/codesign'&&args[0]==='--display')return {stdout:'',stderr:`CodeDirectory v=20500 flags=0x10000(runtime) hashes=1+7 location=embedded\nAuthority=${developerName}\n`,code:0};
    return {stdout:'',stderr:'',code:0};
  };
  try{
    const hash=await validateMacReleaseArchive({archivePath,expectedAppName:'外链助手.app',platform:'darwin',diagnosticsDir,execute});
    assert.match(hash,/^[a-f0-9]{64}$/);
    assert.deepEqual(calls.find(call=>call[0]==='/usr/bin/ditto')?.slice(0,4),['/usr/bin/ditto','-x','-k',archivePath]);
    assert(calls.some(call=>call[0]==='/usr/bin/xcrun'&&call[1]==='stapler'&&call[2]==='validate'));
    assert(calls.some(call=>call[0]==='/usr/sbin/spctl'));
  }finally{await rm(root,{recursive:true,force:true})}
});

test('update signing preflight rejects an ad-hoc or non-hardened archive without leaking identity output',async()=>{
  const root=await mkdtemp(join(tmpdir(),'linkflow-mac-archive-')),archivePath=join(root,'release.zip'),diagnosticsDir=join(root,'private');
  await writeFile(archivePath,'ad-hoc archive');
  const execute:CommandExecutor=async(file,args)=>{
    if(file==='/usr/bin/ditto')await mkdir(join(args.at(-1)!,'外链助手.app'));
    if(file==='/usr/bin/codesign'&&args[0]==='--display')return {stdout:'',stderr:'CodeDirectory flags=0x2(adhoc)\nAuthority=Private Person Name\n',code:0};
    return {stdout:'',stderr:'',code:0};
  };
  try{
    let message='';try{await validateMacReleaseArchive({archivePath,expectedAppName:'外链助手.app',platform:'darwin',diagnosticsDir,execute})}catch(error){message=String(error)}
    assert.match(message,/release-developer-id-runtime-check/);
    assert(!message.includes('Private Person Name'));
  }finally{await rm(root,{recursive:true,force:true})}
});

test('explicit unnotarized archive validation binds ad-hoc integrity, exact bundle properties and stable bytes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'linkflow-unnotarized-')),archivePath=join(root,'release.zip'),diagnosticsDir=join(root,'private');
  const calls:string[][]=[];
  let fault='';
  const execute:CommandExecutor=async(file,args)=>{
    calls.push([file,...args]);
    if(file==='/usr/bin/ditto')await mkdir(join(args.at(-1)!,'外链助手.app'));
    if(file==='/usr/bin/codesign'&&args[0]==='--verify'&&fault==='corrupt')throw new Error('Invalid code signature');
    if(file==='/usr/bin/codesign'&&args[0]==='--display')return {stdout:'',stderr:fault==='identity'?'Signature=adhoc\nAuthority=Unexpected Publisher\n':fault==='unsigned'?'Signature=not signed\n':'Signature=adhoc\nTeamIdentifier=not set\n',code:0};
    if(file==='/usr/bin/plutil'){
      const key=args[1],values:Record<string,string>={CFBundleIdentifier:'com.linkflow.personal',CFBundleShortVersionString:'1.2.2',LSMinimumSystemVersion:'14.0'};
      return {stdout:key===fault?'wrong':values[key],stderr:'',code:0};
    }
    if(file==='/usr/bin/lipo'){
      if(fault==='mutation')await writeFile(archivePath,'changed bytes');
      return {stdout:fault==='arch'?'x86_64':'arm64',stderr:'',code:0};
    }
    return {stdout:'',stderr:'',code:0};
  };
  try{
    await writeFile(archivePath,'exact unnotarized archive');
    const input={archivePath,expectedAppName:'外链助手.app',platform:'darwin',diagnosticsDir,execute,allowUnnotarized:true,expectedVersion:'1.2.2'};
    assert.match(await validateMacReleaseArchive(input),/^[a-f0-9]{64}$/);
    assert(calls.some(call=>call[0]==='/usr/bin/codesign'&&call[1]==='--verify'));
    assert.equal(calls.some(call=>call[0]==='/usr/bin/xcrun'||call[0]==='/usr/sbin/spctl'||call[0]==='/usr/bin/xattr'),false);
    await assert.rejects(validateMacReleaseArchive({...input,expectedVersion:undefined}),/expected version/);
    for(fault of ['corrupt','identity','unsigned','CFBundleIdentifier','CFBundleShortVersionString','LSMinimumSystemVersion','arch','mutation']){
      await writeFile(archivePath,'exact unnotarized archive');
      await assert.rejects(validateMacReleaseArchive(input),/release-/);
    }
  }finally{await rm(root,{recursive:true,force:true})}
});

test('unknown artifact modes cannot silently omit notarization checks',async()=>{
  const paths=await fixture(),{execute}=executorFor(paths);
  try{await assert.rejects(finishMacArtifact({...paths,mode:'typo',execute,sha256Line:async()=>''}),/Unknown macOS artifact mode/);await assert.rejects(stat(paths.finalZipPath))}
  finally{await rm(paths.root,{recursive:true,force:true})}
});
