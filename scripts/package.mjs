import { packager } from '@electron/packager';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
      osxSign:{
        identity:'-',
        identityValidation:false,
        preAutoEntitlements:false,
        preEmbedProvisioningProfile:false,
        optionsForFile:()=>({hardenedRuntime:false})
      },
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

  const expectedBundle=join(releaseDir,`${rootPackage.productName}-${targetSettings.platform}-${targetSettings.arch}`);
  await rm(expectedBundle,{recursive:true,force:true});
  const outputs=await packager({
    dir:stageDir,
    out:releaseDir,
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
  if(outputs.length!==1||outputs[0]!==expectedBundle){
    throw new Error(`Unexpected packager output: ${outputs.join(', ')}`);
  }

  if(target==='mac-arm64'){
    const appPath=join(expectedBundle,`${rootPackage.productName}.app`);
    // Finder may attach signing-disallowed cosmetic metadata on desktop volumes.
    const attrs=execFileSync('/usr/bin/xattr',[appPath],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
    for(const attr of ['com.apple.FinderInfo','com.apple.ResourceFork']){
      if(attrs.includes(attr))execFileSync('/usr/bin/xattr',['-d',attr,appPath]);
    }
    execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',appPath],{stdio:'inherit'});
    const zipPath=join(releaseDir,`${rootPackage.productName}-${rootPackage.version}-mac-arm64.zip`);
    await rm(zipPath,{force:true});
    execFileSync('/usr/bin/ditto',['-c','-k','--norsrc','--noextattr','--keepParent',appPath,zipPath],{stdio:'inherit'});
    const checksumPath=join(releaseDir,'SHA256SUMS-mac-arm64.txt');
    await writeFile(checksumPath,await sha256File(zipPath),'utf8');
    console.log([appPath,zipPath,checksumPath].join('\n'));
  }else{
    const builderCli=join(projectRoot,'node_modules','electron-builder','out','cli','cli.js');
    execFileSync(process.execPath,[builderCli,'--config',join(projectRoot,'electron-builder.yml'),'--win','nsis','--x64','--prepackaged',expectedBundle],{
      cwd:projectRoot,
      env:{...process.env,CSC_IDENTITY_AUTO_DISCOVERY:'false'},
      stdio:'inherit'
    });
    const installerPath=join(releaseDir,`${rootPackage.productName}-${rootPackage.version}-windows-x64-setup.exe`);
    const checksumPath=join(releaseDir,'SHA256SUMS-windows-x64.txt');
    await writeFile(checksumPath,await sha256File(installerPath),'utf8');
    console.log([join(expectedBundle,`${rootPackage.productName}.exe`),installerPath,checksumPath].join('\n'));
  }
}finally{
  await rm(stageRoot,{recursive:true,force:true});
}
