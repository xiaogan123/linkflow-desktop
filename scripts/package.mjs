import { packager } from '@electron/packager';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  finishMacArtifact,
  macSignOptions,
  resolveMacBuildConfig,
  runPrivateMacStage,
  validateDeveloperIdIdentity
} from './lib/mac-signing.mjs';

async function main(){
const projectRoot=dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDir=join(projectRoot,'release');
const assetsDir=join(projectRoot,'assets');
process.chdir(projectRoot);
const rootPackage=JSON.parse(await readFile(join(projectRoot,'package.json'),'utf8'));
const target=process.argv[2]??(process.platform==='darwin'?'mac-arm64':process.platform==='win32'?'windows-x64':'');
const targetSettings={
  'mac-arm64':{host:'darwin',platform:'darwin',arch:'arm64'},
  'windows-x64':{host:'win32',platform:'win32',arch:'x64'}
}[target];

if(!targetSettings){
  throw new Error('Usage: node scripts/package.mjs <mac-arm64|windows-x64>');
}
if(process.platform!==targetSettings.host||process.arch!==targetSettings.arch){
  throw new Error(`${target} must be packaged natively on ${targetSettings.host}/${targetSettings.arch}; current host is ${process.platform}/${process.arch}`);
}

const macConfig=target==='mac-arm64'?resolveMacBuildConfig(process.argv.slice(3)):null;
if(macConfig?.mode==='release'){
  macConfig.signingIdentityHash=await validateDeveloperIdIdentity(macConfig.identity);
  macConfig.mainAppName=`${rootPackage.productName}.app`;
  macConfig.mainEntitlementsPath=join(projectRoot,'scripts','entitlements.mac.plist');
}

await import('./assets.mjs');
await import('./third-party-notices.mjs');
await mkdir(releaseDir,{recursive:true});

const stageRoot=await mkdtemp(join(tmpdir(),'linkflow-package-'));
const stageDir=join(stageRoot,'app');
await mkdir(join(stageDir,'assets'),{recursive:true});

async function sha256File(filePath){
  const digest=createHash('sha256').update(await readFile(filePath)).digest('hex');
  return `${digest}  ${basename(filePath)}\n`;
}

async function writePinnedMacInstaller({version,archivePath,outputPath}){
  if(!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version))throw new Error('Invalid installer version.');
  const archiveSha256=createHash('sha256').update(await readFile(archivePath)).digest('hex');
  const template=await readFile(join(projectRoot,'scripts','install-mac.sh'),'utf8');
  const versionToken='__LINKFLOW_VERSION__',hashToken='__LINKFLOW_MAC_ARM64_SHA256__';
  if(template.split(versionToken).length!==2||template.split(hashToken).length!==2)throw new Error('Mac installer template tokens are missing or duplicated.');
  const rendered=template.replace(versionToken,version).replace(hashToken,archiveSha256);
  if(rendered.includes('__LINKFLOW_'))throw new Error('Mac installer template contains unresolved release tokens.');
  const temporaryPath=`${outputPath}.${process.pid}.tmp`;
  await rm(temporaryPath,{force:true});
  try{
    await writeFile(temporaryPath,rendered,{encoding:'utf8',mode:0o755,flag:'wx'});
    await chmod(temporaryPath,0o755);
    await rename(temporaryPath,outputPath);
  }finally{await rm(temporaryPath,{force:true})}
  return archiveSha256;
}

try{
  // This is the complete application-source allowlist. No root documents, tests,
  // evidence, local data, source files, lockfile, or node_modules can enter app.asar.
  await cp(join(projectRoot,'dist'),join(stageDir,'dist'),{recursive:true});
  await cp(join(projectRoot,'dist-electron'),join(stageDir,'dist-electron'),{recursive:true});
  await copyFile(join(assetsDir,'tray.png'),join(stageDir,'assets','tray.png'));
  await copyFile(join(assetsDir,'icon.png'),join(stageDir,'assets','icon.png'));
  await copyFile(join(assetsDir,'THIRD_PARTY_NOTICES.txt'),join(stageDir,'assets','THIRD_PARTY_NOTICES.txt'));
  await writeFile(join(stageDir,'package.json'),`${JSON.stringify({
    name:rootPackage.name,
    productName:rootPackage.productName,
    version:rootPackage.version,
    description:rootPackage.description,
    private:true,
    type:rootPackage.type,
    main:rootPackage.main
  },null,2)}\n`,'utf8');

  let icon;
  let platformOptions={};
  if(target==='mac-arm64'){
    icon=join(assetsDir,'AppIcon.icns');
    execFileSync('/usr/bin/iconutil',['-c','icns',join(assetsDir,'AppIcon.iconset'),'-o',icon],{stdio:'inherit'});
    platformOptions={
      appBundleId:'com.linkflow.personal',
      osxSign:macSignOptions(macConfig),
      extendInfo:{LSMinimumSystemVersion:'14.0',NSHumanReadableCopyright:'个人使用 · Linkflow'}
    };
  }else{
    icon=join(assetsDir,'AppIcon.ico');
    platformOptions={
      win32metadata:{
        CompanyName:'Linkflow',
        FileDescription:rootPackage.description,
        InternalName:rootPackage.name,
        OriginalFilename:`${rootPackage.productName}.exe`,
        ProductName:rootPackage.productName
      }
    };
  }

  // Build and verify macOS bundles outside synced Desktop folders. File providers
  // can add Finder metadata while signing, invalidating an otherwise clean bundle.
  const outputRoot=target==='mac-arm64'?join(stageRoot,'native'):releaseDir;
  const publishedBundle=join(releaseDir,`${rootPackage.productName}-${targetSettings.platform}-${targetSettings.arch}${macConfig?.mode==='local'?'-local-adhoc':''}`);
  const expectedBundle=join(outputRoot,`${rootPackage.productName}-${targetSettings.platform}-${targetSettings.arch}`);
  await rm(expectedBundle,{recursive:true,force:true});
  const packageApplication=()=>packager({
    dir:stageDir,
    out:outputRoot,
    name:rootPackage.productName,
    appVersion:rootPackage.version,
    platform:targetSettings.platform,
    arch:targetSettings.arch,
    electronVersion:rootPackage.devDependencies.electron,
    icon,
    overwrite:true,
    quiet:true,
    asar:true,
    prune:false,
    ...platformOptions
  });
  const outputs=target==='mac-arm64'
    ? await runPrivateMacStage('electron-packager-signing',async()=>{
      const result=await packageApplication();
      if(result.length!==1||result[0]!==expectedBundle)throw new Error(`Unexpected packager output: ${result.join(', ')}`);
      return result;
    })
    : await packageApplication();
  if(target!=='mac-arm64'&&(outputs.length!==1||outputs[0]!==expectedBundle))throw new Error(`Unexpected packager output: ${outputs.join(', ')}`);

  if(target==='mac-arm64'){
    const appPath=join(expectedBundle,`${rootPackage.productName}.app`);
    const zipPath=join(releaseDir,`Linkflow-${rootPackage.version}-${macConfig.artifactSuffix}.zip`);
    const finalZipTempPath=join(releaseDir,`.${basename(zipPath)}.${process.pid}.tmp`);
    const temporaryZipPath=join(stageRoot,'notary-upload.zip');
    await rm(zipPath,{force:true});
    const checksumPath=join(releaseDir,`SHA256SUMS-${macConfig.artifactSuffix}.txt`);
    await rm(checksumPath,{force:true});
    await finishMacArtifact({
      appPath,
      mode:macConfig.mode,
      notaryProfile:macConfig.notaryProfile,
      temporaryZipPath,
      finalZipTempPath,
      finalZipPath:zipPath,
      checksumPath,
      sha256Line:sha256File
    });
    let installerPath;
    if(macConfig.mode==='unnotarized'){
      installerPath=join(releaseDir,'install-mac.sh');
      await writePinnedMacInstaller({version:rootPackage.version,archivePath:zipPath,outputPath:installerPath});
      await writeFile(checksumPath,`${await sha256File(zipPath)}${await sha256File(installerPath)}`,'utf8');
    }
    // Only publish the unpacked app after the corresponding archive is complete.
    await rm(publishedBundle,{recursive:true,force:true});
    await cp(expectedBundle,publishedBundle,{recursive:true,verbatimSymlinks:true});
    if(macConfig.mode==='unnotarized')console.log('Mac 未经过 Apple 公证；系统可能要求用户亲自确认来源。');
    console.log([`${basename(publishedBundle)}/${rootPackage.productName}.app`,basename(zipPath),...(installerPath?[basename(installerPath)]:[]),basename(checksumPath)].join('\n'));
  }else{
    const builderCli=join(projectRoot,'node_modules','electron-builder','out','cli','cli.js');
    execFileSync(process.execPath,[builderCli,'--config',join(projectRoot,'electron-builder.yml'),'--win','nsis','--x64','--prepackaged',expectedBundle],{
      cwd:projectRoot,
      env:{...process.env,CSC_IDENTITY_AUTO_DISCOVERY:'false'},
      stdio:'inherit'
    });
    const installerPath=join(releaseDir,`Linkflow-${rootPackage.version}-windows-x64-setup.exe`);
    const checksumPath=join(releaseDir,'SHA256SUMS-windows-x64.txt');
    await writeFile(checksumPath,await sha256File(installerPath),'utf8');
    console.log([`${basename(expectedBundle)}/${rootPackage.productName}.exe`,basename(installerPath),basename(checksumPath)].join('\n'));
  }
}finally{
  await rm(stageRoot,{recursive:true,force:true});
}
}

main().catch(()=>{
  const requestedTarget=process.argv[2]??'';
  const requestedFlags=process.argv.slice(3);
  const message=requestedTarget==='mac-arm64'&&requestedFlags.includes('--unnotarized-release')
    ?'Unnotarized macOS packaging failed. Verify native ad-hoc packaging and archive validation prerequisites; raw failure details are kept private.'
    :requestedTarget==='mac-arm64'&&requestedFlags.includes('--local')
      ?'Local macOS packaging failed. Verify native ad-hoc development packaging prerequisites; raw failure details are kept private.'
      :requestedTarget==='mac-arm64'
        ?'Formal macOS packaging failed. Verify LINKFLOW_MAC_SIGNING_IDENTITY, LINKFLOW_MAC_NOTARY_PROFILE, and native release prerequisites; raw failure details are kept private.'
        :requestedTarget==='windows-x64'
          ?'Windows packaging failed. Verify native Windows packaging prerequisites; raw failure details are kept private.'
          :'Packaging failed. Verify the target and native packaging prerequisites; raw failure details are kept private.';
  console.error(message);
  process.exitCode=1;
});
