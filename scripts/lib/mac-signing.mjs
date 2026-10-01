import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,open,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

const execFileAsync=promisify(execFile);
const SAFE_VALUE=/^[^\0\r\n]{1,512}$/;
const identityLine=/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"\s*$/;

export const defaultMacDiagnosticsDir=join(homedir(),'.codex','private','linkflow-notarization-diagnostics');

export function resolveMacBuildConfig(args,env=process.env){
  if(args.length>1||(args.length===1&&!['--local','--unnotarized-release'].includes(args[0]))){
    throw new Error('Usage: node scripts/package.mjs mac-arm64 [--local|--unnotarized-release]');
  }
  if(args[0]==='--local')return {mode:'local',artifactSuffix:'mac-arm64-local-adhoc'};
  if(args[0]==='--unnotarized-release')return {mode:'unnotarized',artifactSuffix:'mac-arm64'};
  const identity=env.LINKFLOW_MAC_SIGNING_IDENTITY;
  const notaryProfile=env.LINKFLOW_MAC_NOTARY_PROFILE;
  if(!identity||!notaryProfile){
    throw new Error('Formal macOS packaging requires LINKFLOW_MAC_SIGNING_IDENTITY and LINKFLOW_MAC_NOTARY_PROFILE; use --local only for an isolated ad-hoc development build.');
  }
  if(!SAFE_VALUE.test(identity)||!SAFE_VALUE.test(notaryProfile)){
    throw new Error('The macOS signing identity or notarization profile name is malformed.');
  }
  return {mode:'release',artifactSuffix:'mac-arm64',identity,notaryProfile};
}

export function macSignOptions(config){
  if(config.mode==='local'||config.mode==='unnotarized'){
    return {
      identity:'-',
      identityValidation:false,
      preAutoEntitlements:false,
      preEmbedProvisioningProfile:false,
      continueOnError:false,
      optionsForFile:()=>({hardenedRuntime:false,timestamp:'none'})
    };
  }
  return {
    identity:config.signingIdentityHash??config.identity,
    identityValidation:true,
    preAutoEntitlements:false,
    preEmbedProvisioningProfile:false,
    continueOnError:false,
    strictVerify:true,
    // Keep @electron/osx-sign's current per-helper defaults, but avoid granting
    // unused camera, microphone, USB, Bluetooth, print, location, and photo
    // exceptions to this app's main executable. Modern Electron's V8 main
    // process only needs JIT here.
    optionsForFile:filePath=>({
      hardenedRuntime:true,
      // `undefined` is @electron/osx-sign's documented Apple timestamp-server
      // default and becomes the bare `codesign --timestamp` argument.
      timestamp:undefined,
      ...(filePath.endsWith(`/${config.mainAppName}`)?{entitlements:config.mainEntitlementsPath}:{})
    })
  };
}

export async function executeFile(file,args,options={}){
  try{
    const result=await execFileAsync(file,args,{
      cwd:options.cwd,
      env:options.env,
      encoding:'utf8',
      maxBuffer:16*1024*1024,
      timeout:options.timeoutMs??120_000
    });
    return {stdout:result.stdout??'',stderr:result.stderr??'',code:0};
  }catch(error){
    const wrapped=new Error('Native command failed.');
    wrapped.commandResult={
      stdout:typeof error.stdout==='string'?error.stdout:'',
      stderr:typeof error.stderr==='string'?error.stderr:'',
      code:Number.isInteger(error.code)?error.code:null,
      signal:typeof error.signal==='string'?error.signal:null
    };
    throw wrapped;
  }
}

function commandResult(error){
  return error&&typeof error==='object'&&error.commandResult&&typeof error.commandResult==='object'
    ? error.commandResult
    : {stdout:'',stderr:'',code:null,signal:null};
}

function privateErrorText(error){
  if(error instanceof Error)return error.stack||error.message;
  try{return JSON.stringify(error)}catch{return String(error)}
}

async function savePrivateDiagnostic(diagnosticsDir,details){
  await mkdir(diagnosticsDir,{recursive:true,mode:0o700});
  const path=join(diagnosticsDir,`mac-release-${new Date().toISOString().replaceAll(':','-')}-${randomUUID()}.json`);
  await writeFile(path,`${JSON.stringify(details,null,2)}\n`,{encoding:'utf8',mode:0o600,flag:'wx'});
}

async function failStage(stage,error,diagnosticsDir,extra={}){
  const result=commandResult(error);
  try{
    await savePrivateDiagnostic(diagnosticsDir,{
      stage,
      recordedAt:new Date().toISOString(),
      exitCode:result.code,
      signal:result.signal,
      stdout:result.stdout,
      stderr:result.stderr,
      error:privateErrorText(error),
      ...extra
    });
  }catch{
    // The public error remains free of command output even if private evidence cannot be written.
  }
  const publicError=new Error(`macOS release validation failed at ${stage}; raw command output was not printed.`);
  publicError.stack=publicError.message;
  throw publicError;
}

export async function runPrivateMacStage(stage,action,{diagnosticsDir=defaultMacDiagnosticsDir}={}){
  try{
    return await action();
  }catch(error){
    await failStage(stage,error,diagnosticsDir);
  }
}

export async function validateDeveloperIdIdentity(identity,{execute=executeFile,diagnosticsDir=defaultMacDiagnosticsDir}={}){
  let result;
  try{
    result=await execute('/usr/bin/security',['find-identity','-v','-p','codesigning']);
  }catch(error){
    await failStage('developer-id-identity-check',error,diagnosticsDir);
  }
  const matches=result.stdout.split(/\r?\n/).map(line=>line.match(identityLine)).filter(Boolean);
  const accepted=matches.find(([,hash,name])=>name.startsWith('Developer ID Application:')&&(identity===hash||identity===name));
  if(!accepted){
    await failStage('developer-id-identity-check',new Error('No matching Developer ID Application identity.'),diagnosticsDir);
  }
  return accepted[1];
}

async function runStage(stage,file,args,{execute,diagnosticsDir,timeoutMs}){
  try{
    return await execute(file,args,{timeoutMs});
  }catch(error){
    await failStage(stage,error,diagnosticsDir);
  }
}

function notarizationResponse(stdout){
  try{
    const parsed=JSON.parse(stdout);
    return {
      status:typeof parsed.status==='string'?parsed.status:'',
      id:typeof parsed.id==='string'&&/^[A-Za-z0-9-]{8,128}$/.test(parsed.id)?parsed.id:''
    };
  }catch{
    return {status:'',id:''};
  }
}

async function saveNotaryRejection({response,profile,execute,diagnosticsDir}){
  let log={stdout:'',stderr:'',code:null,signal:null};
  if(response.id){
    try{
      log=await execute('/usr/bin/xcrun',['notarytool','log',response.id,'--keychain-profile',profile,'--output-format','json'],{timeoutMs:120_000});
    }catch(error){
      log=commandResult(error);
    }
  }
  try{
    await savePrivateDiagnostic(diagnosticsDir,{
      stage:'notary-accepted-check',
      recordedAt:new Date().toISOString(),
      submissionId:response.id||null,
      status:response.status||null,
      notaryLogStdout:log.stdout,
      notaryLogStderr:log.stderr,
      notaryLogExitCode:log.code
    });
  }catch{
    // The caller still fails closed without exposing the service response.
  }
  throw new Error('macOS notarization did not return Accepted; raw service output was not printed.');
}

async function stableSha256(path){
  const file=await open(path,'r');
  try{
    const before=await file.stat();
    if(!before.isFile()||before.size<1)throw new Error('Invalid release archive.');
    const hash=createHash('sha256');
    for await(const chunk of file.createReadStream({autoClose:false}))hash.update(chunk);
    const after=await file.stat();
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('Release archive changed during validation.');
    return hash.digest('hex');
  }finally{
    await file.close();
  }
}

export async function validateMacReleaseArchive({
  archivePath,
  expectedAppName,
  platform=process.platform,
  allowUnnotarized=false,
  expectedVersion,
  diagnosticsDir=defaultMacDiagnosticsDir,
  execute=executeFile
}){
  if(platform!=='darwin')throw new Error('The macOS release archive must be validated and update-signed on macOS.');
  if(typeof allowUnnotarized!=='boolean'||allowUnnotarized&& !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(expectedVersion??''))throw new Error('Unnotarized release validation requires an explicit flag and expected version.');
  if(!/^[^/\\\0\r\n]{1,200}\.app$/.test(expectedAppName))throw new Error('The expected macOS application name is invalid.');
  const extractionRoot=await mkdtemp(join(tmpdir(),'linkflow-mac-release-validation-'));
  try{
    const beforeHash=await stableSha256(archivePath);
    await runStage('release-archive-extraction','/usr/bin/ditto',['-x','-k','--noextattr',archivePath,extractionRoot],{execute,diagnosticsDir});
    const entries=await readdir(extractionRoot,{withFileTypes:true});
    if(entries.length!==1||entries[0].name!==expectedAppName||!entries[0].isDirectory()||entries[0].isSymbolicLink()){
      await failStage('release-archive-shape',new Error('Unexpected archive shape.'),diagnosticsDir);
    }
    const appPath=join(extractionRoot,expectedAppName);
    await runStage('release-codesign-verification','/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',appPath],{execute,diagnosticsDir});
    const signature=await runStage('release-developer-id-runtime-check','/usr/bin/codesign',['--display','--verbose=4',appPath],{execute,diagnosticsDir});
    const signatureText=`${signature.stdout}\n${signature.stderr}`;
    if(allowUnnotarized){
      if(!signatureText.split(/\r?\n/).some(line=>line==='Signature=adhoc')||signatureText.split(/\r?\n/).some(line=>line.startsWith('Authority=')||line.startsWith('TeamIdentifier=')&&line!=='TeamIdentifier=not set')){
        await failStage('release-adhoc-signature-check',new Error('Expected an explicitly unnotarized ad-hoc signature.'),diagnosticsDir);
      }
      const plist=join(appPath,'Contents','Info.plist');
      const [identifier,version,minimumSystem,architectures]=await Promise.all([
        runStage('release-app-identifier','/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',plist],{execute,diagnosticsDir}),
        runStage('release-app-version','/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw','-o','-',plist],{execute,diagnosticsDir}),
        runStage('release-minimum-system','/usr/bin/plutil',['-extract','LSMinimumSystemVersion','raw','-o','-',plist],{execute,diagnosticsDir}),
        runStage('release-app-architecture','/usr/bin/lipo',['-archs',join(appPath,'Contents','MacOS','外链助手')],{execute,diagnosticsDir})
      ]);
      if(identifier.stdout.trim()!=='com.linkflow.personal'||version.stdout.trim()!==expectedVersion||minimumSystem.stdout.trim()!=='14.0'||architectures.stdout.trim()!=='arm64'){
        await failStage('release-adhoc-bundle-properties',new Error('Unexpected unnotarized bundle identity, version, system or architecture.'),diagnosticsDir);
      }
      const afterHash=await stableSha256(archivePath);
      if(beforeHash!==afterHash)await failStage('release-archive-stability',new Error('Archive changed during native validation.'),diagnosticsDir);
      return afterHash;
    }
    const developerId=signatureText.split(/\r?\n/).some(line=>line.startsWith('Authority=Developer ID Application:'));
    const hardenedRuntime=signatureText.split(/\r?\n/).some(line=>line.startsWith('CodeDirectory ')&&/flags=.*\bruntime\b/.test(line));
    if(!developerId||!hardenedRuntime){
      await failStage('release-developer-id-runtime-check',new Error('Required release signature properties are absent.'),diagnosticsDir);
    }
    await runStage('release-staple-validation','/usr/bin/xcrun',['stapler','validate','-v',appPath],{execute,diagnosticsDir});
    await runStage('release-gatekeeper-assessment','/usr/sbin/spctl',['--assess','--type','execute','--verbose=4',appPath],{execute,diagnosticsDir});
    const afterHash=await stableSha256(archivePath);
    if(beforeHash!==afterHash)await failStage('release-archive-stability',new Error('Archive changed during native validation.'),diagnosticsDir);
    return afterHash;
  }finally{
    await rm(extractionRoot,{recursive:true,force:true});
  }
}

export async function finishMacArtifact({
  appPath,
  mode,
  notaryProfile,
  temporaryZipPath,
  finalZipTempPath,
  finalZipPath,
  checksumPath,
  sha256Line,
  diagnosticsDir=defaultMacDiagnosticsDir,
  execute=executeFile
}){
  if(!['release','local','unnotarized'].includes(mode))throw new Error('Unknown macOS artifact mode.');
  await rm(temporaryZipPath,{force:true});
  await rm(finalZipTempPath,{force:true});
  let finalPublished=false;
  try{
    await runStage('codesign-verification','/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',appPath],{execute,diagnosticsDir});
    if(mode==='release'){
      const signature=await runStage('developer-id-signature-check','/usr/bin/codesign',['--display','--verbose=4',appPath],{execute,diagnosticsDir});
      if(!`${signature.stdout}\n${signature.stderr}`.split(/\r?\n/).some(line=>line.startsWith('Authority=Developer ID Application:'))){
        await failStage('developer-id-signature-check',new Error('Unexpected signing authority.'),diagnosticsDir);
      }
      await runStage('notary-archive','/usr/bin/ditto',['-c','-k','--norsrc','--noextattr','--keepParent',appPath,temporaryZipPath],{execute,diagnosticsDir});
      const notarized=await runStage('notary-submit','/usr/bin/xcrun',['notarytool','submit',temporaryZipPath,'--keychain-profile',notaryProfile,'--wait','--timeout','2h','--output-format','json'],{execute,diagnosticsDir,timeoutMs:7_500_000});
      const response=notarizationResponse(notarized.stdout);
      if(response.status!=='Accepted')await saveNotaryRejection({response,profile:notaryProfile,execute,diagnosticsDir});
      await runStage('staple','/usr/bin/xcrun',['stapler','staple','-v',appPath],{execute,diagnosticsDir});
      await runStage('staple-validation','/usr/bin/xcrun',['stapler','validate','-v',appPath],{execute,diagnosticsDir});
      await runStage('post-staple-codesign-verification','/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',appPath],{execute,diagnosticsDir});
      await runStage('gatekeeper-assessment','/usr/sbin/spctl',['--assess','--type','execute','--verbose=4',appPath],{execute,diagnosticsDir});
    }
    await runStage('final-archive','/usr/bin/ditto',['-c','-k','--norsrc','--noextattr','--keepParent',appPath,finalZipTempPath],{execute,diagnosticsDir});
    await rm(finalZipPath,{force:true});
    await rename(finalZipTempPath,finalZipPath);
    finalPublished=true;
    await writeFile(checksumPath,await sha256Line(finalZipPath),'utf8');
  }catch(error){
    if(finalPublished){
      await rm(finalZipPath,{force:true});
      await rm(checksumPath,{force:true});
    }
    throw error;
  }finally{
    await rm(temporaryZipPath,{force:true});
    await rm(finalZipTempPath,{force:true});
  }
}
