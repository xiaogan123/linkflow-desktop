import {build} from 'esbuild';
import {mkdtemp,mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import electron from 'electron';
const run=(file,args,options={})=>new Promise((done,reject)=>execFile(file,args,{timeout:180000,maxBuffer:1024*1024,...options},error=>error?reject(error):done()));
if(!((process.platform==='darwin'&&process.arch==='arm64')||(process.platform==='win32'&&process.arch==='x64')))throw Error('Native supported platform required');
if(process.platform==='win32'){
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Windows installer probe requires a disposable hosted CI runner');
 const existing=await new Promise((done,reject)=>execFile('reg',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','/s','/f','外链助手','/d'],{encoding:'utf8'},(error)=>{if(!error)done(true);else if(error.code===1)done(false);else reject(Error('Unable to establish clean Windows registry'))}));
 if(existing)throw Error('A pre-existing Linkflow registration prevents the isolated installer probe');
}
const version=JSON.parse(await readFile('package.json','utf8')).version;
const directory=await mkdtemp(join(tmpdir(),'linkflow-update-native-')),installParent=join(directory,'Install Path With Spaces');await mkdir(installParent);
const application=join(installParent,process.platform==='darwin'?'外链助手.app':'Linkflow');
const artifact=resolve('release',`Linkflow-${version}-${process.platform==='darwin'?'mac-arm64.zip':'windows-x64-setup.exe'}`);
if(process.platform==='darwin')await run('/usr/bin/ditto',['-x','-k',artifact,installParent]);else await run(artifact,['/S',`/D=${application}`],{windowsVerbatimArguments:true});
const configuration={directory,application,artifact,version,wrapper:resolve('scripts/update-native-wrapper.cjs')};
await writeFile(join(directory,'config.json'),JSON.stringify(configuration),{mode:0o600});
await build({entryPoints:['scripts/update-native-entry.ts'],outfile:join(directory,'entry.cjs'),platform:'node',format:'cjs',bundle:true,target:'node24',external:['original-fs']});
const child=spawn(electron,[join(directory,'entry.cjs'),join(directory,'config.json')],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},shell:false});
const deadline=setTimeout(()=>child.kill(),240000);
const code=await new Promise(done=>child.once('exit',done));clearTimeout(deadline);
if(code!==0)throw Error('Native updater probe failed');
await mkdir('.evidence/release-1.2.0',{recursive:true});await copyFile(join(directory,'result.json'),`.evidence/release-1.2.0/native-update-${process.platform}.json`);
const report=JSON.parse(await readFile(join(directory,'result.json'),'utf8'));console.log('NATIVE_UPDATE_RESULT '+JSON.stringify(report));
if(process.platform==='win32')await run(join(application,'Uninstall 外链助手.exe'),['/S']);
