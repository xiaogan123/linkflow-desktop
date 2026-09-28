import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UpdateManager} from '../src/main/update-manager';
import {UPDATE_MANIFEST_URL,UPDATE_SIGNATURE_URL} from '../src/main/update-network';

function fixture(version:string,asset:Buffer){
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),assetUrl=`https://github.com/xiaogan123/linkflow-desktop/releases/download/v${version}/Linkflow-${version}-windows-x64-setup.exe`,manifest={schemaVersion:1 as const,version,publishedAt:'2026-09-28T00:00:00.000Z',releaseNotes:'修复已知问题',assets:{'win32-x64':{url:assetUrl,size:asset.length,sha256:createHash('sha256').update(asset).digest('hex'),format:'nsis' as const}}},bytes=Buffer.from(JSON.stringify(manifest)),signature=Buffer.from(sign(null,bytes,privateKey).toString('base64')+'\n');
 const request=(async(input:RequestInfo|URL)=>{const url=String(input);if(url===UPDATE_MANIFEST_URL)return new Response(Uint8Array.from(bytes));if(url===UPDATE_SIGNATURE_URL)return new Response(Uint8Array.from(signature));if(url===assetUrl)return new Response(Uint8Array.from(asset),{headers:{'content-length':String(asset.length)}});return new Response(null,{status:404})}) as typeof fetch;
 return {publicKey,request,manifest};
}
function options(directory:string,data:ReturnType<typeof fixture>){const applicationPath=join(directory,'installed');return {currentVersion:'1.1.0',platform:'win32' as const,arch:'x64',packaged:true,updatesDirectory:join(directory,'updates'),applicationPath,executablePath:join(applicationPath,'外链助手.exe'),helperPath:join(applicationPath,'resources','app.asar','dist-electron','update-helper.cjs'),publicKey:data.publicKey,request:data.request,pid:999999}}

test('manager checks, streams, verifies, persists, and restores a prepared update',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-update-')),asset=Buffer.alloc(128*1024,7),data=fixture('1.2.0',asset);try{
  const manager=new UpdateManager(options(directory,data));assert.equal((await manager.initialize()).phase,'idle');const available=await manager.check();assert.equal(available.phase,'available');assert.equal(available.releaseNotes,'修复已知问题');
  const promise=manager.download();assert.equal(manager.status().phase,'downloading');const prepared=await promise;assert.equal(prepared.phase,'prepared');assert.equal(prepared.progress?.percent,100);
  const restored=new UpdateManager(options(directory,data));assert.equal((await restored.initialize()).phase,'prepared');
  const stored=JSON.parse(await readFile(join(directory,'updates','prepared.json'),'utf8'));assert.equal(stored.manifest,Buffer.from(JSON.stringify(data.manifest)).toString('base64'));
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('hash mismatch never reaches prepared and exposes no source URL or local path',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-update-')),signed=Buffer.from('signed payload'),served=Buffer.from('tampered data');
 try{
  // Use a valid signed manifest request, then swap only the asset response.
  const valid=fixture('1.2.0',signed),request=(async(input:RequestInfo|URL,init?:RequestInit)=>String(input)===valid.manifest.assets['win32-x64'].url?new Response(Uint8Array.from(served),{headers:{'content-length':String(served.length)}}):valid.request(input,init)) as typeof fetch,manager=new UpdateManager({...options(directory,valid),request});
  assert.equal((await manager.check()).phase,'available');const failed=await manager.download();assert.equal(failed.phase,'failed');assert.equal(failed.retryable,true);assert(!failed.error?.includes(directory));assert(!failed.error?.includes('github.com'));
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('temporary-file cleanup failures cannot leave download state stuck',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-update-')),signed=Buffer.from('signed payload'),served=Buffer.from('tampered data'),data=fixture('1.2.0',signed),base=data.request;let blockCleanup=false;try{
  const request=(async(input:RequestInfo|URL,init?:RequestInit)=>String(input)===data.manifest.assets['win32-x64'].url?new Response(Uint8Array.from(served),{headers:{'content-length':String(served.length)}}):base(input,init)) as typeof fetch,guardedRm=(async(path:Parameters<typeof rm>[0],options?:Parameters<typeof rm>[1])=>{if(blockCleanup&&String(path).endsWith('.part'))throw Error('synthetic antivirus lock');return rm(path,options)}) as typeof rm,manager=new UpdateManager({...options(directory,data),request,files:{rm:guardedRm}});await manager.initialize();await manager.check();blockCleanup=true;const failed=await manager.download();assert.equal(failed.phase,'failed');assert.equal(failed.retryable,true);assert.notEqual(manager.status().phase,'downloading');
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('cancel aborts an active stream and returns to a retryable available state',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-update-')),asset=Buffer.alloc(100,1),data=fixture('1.2.0',asset),base=data.request;let assetStarted=()=>{};const started=new Promise<void>(done=>{assetStarted=done});
 const request=(async(input:RequestInfo|URL,init?:RequestInit)=>{if(String(input)!==data.manifest.assets['win32-x64'].url)return base(input,init);return new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(asset.subarray(0,1));assetStarted();init?.signal?.addEventListener('abort',()=>controller.error(Error('aborted')),{once:true})}}))}) as typeof fetch;
 try{const manager=new UpdateManager({...options(directory,data),request});await manager.check();const completion=manager.download();await started;assert.equal(manager.cancel().phase,'downloading');const state=await completion;assert.equal(state.phase,'available');assert.equal(state.error,'下载已取消');assert.equal(state.retryable,true)}finally{await rm(directory,{recursive:true,force:true})}
});

test('install returns only after helper readiness handshake and keeps userdata outside replacement',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-update-')),asset=Buffer.from('installer'),data=fixture('1.2.0',asset);try{
  const config=options(directory,data);await mkdir(join(config.applicationPath,'resources','app.asar','dist-electron'),{recursive:true});await writeFile(config.executablePath,'old app');await writeFile(config.helperPath,'helper');const manager=new UpdateManager({...config,launchHelper:(_exe,args)=>{void (async()=>{const job=JSON.parse(await readFile(args[1],'utf8'));await writeFile(job.readyPath,job.token)})();return {pid:321,once:()=>{},unref:()=>{}}}});
  await manager.initialize();await manager.check();await manager.download();const handoff=await manager.install();assert.equal(handoff.accepted,true);assert.equal(manager.status().phase,'installing');assert.equal(await readFile(config.executablePath,'utf8'),'old app');
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('install re-hashes the prepared artifact immediately before helper handoff',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-update-')),asset=Buffer.from('installer'),data=fixture('1.2.0',asset);try{
  const config=options(directory,data),manager=new UpdateManager(config);await manager.initialize();await manager.check();await manager.download();await writeFile(join(config.updatesDirectory,'Linkflow-1.2.0-win32-x64.exe'),Buffer.from('tampered!'));await assert.rejects(manager.install(),/完整性/);assert.equal(manager.status().phase,'failed');
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('helper is never armed when readiness cleanup fails',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-update-')),asset=Buffer.from('installer'),data=fixture('1.2.0',asset);try{
  const config=options(directory,data);await mkdir(join(config.applicationPath,'resources','app.asar','dist-electron'),{recursive:true});await writeFile(config.executablePath,'old app');await writeFile(config.helperPath,'helper');const guardedRm=(async(path:Parameters<typeof rm>[0],options?:Parameters<typeof rm>[1])=>{if(String(path).endsWith('.ready')){const error=Error('synthetic lock') as NodeJS.ErrnoException;error.code='EPERM';throw error}return rm(path,options)}) as typeof rm,manager=new UpdateManager({...config,files:{rm:guardedRm},launchHelper:(_exe,args)=>{void (async()=>{const job=JSON.parse(await readFile(args[1],'utf8'));await writeFile(job.readyPath,job.token)})();return {pid:321,once:()=>{},unref:()=>{}}}});await manager.initialize();await manager.check();await manager.download();await assert.rejects(manager.install());assert.equal(manager.status().phase,'prepared');assert.equal((await readdir(config.updatesDirectory)).some(name=>name.endsWith('.armed')),false);
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('helper arm commit is atomic when the final rename fails',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-update-')),asset=Buffer.from('installer'),data=fixture('1.2.0',asset);try{
  const config=options(directory,data);await mkdir(join(config.applicationPath,'resources','app.asar','dist-electron'),{recursive:true});await writeFile(config.executablePath,'old app');await writeFile(config.helperPath,'helper');const guardedRename=(async(from:Parameters<typeof rename>[0],to:Parameters<typeof rename>[1])=>{if(String(to).endsWith('.armed')){const error=Error('synthetic rename failure') as NodeJS.ErrnoException;error.code='EPERM';throw error}return rename(from,to)}) as typeof rename,manager=new UpdateManager({...config,files:{rename:guardedRename},launchHelper:(_exe,args)=>{void (async()=>{const job=JSON.parse(await readFile(args[1],'utf8'));await writeFile(job.readyPath,job.token)})();return {pid:321,once:()=>{},unref:()=>{}}}});await manager.initialize();await manager.check();await manager.download();await assert.rejects(manager.install());assert.equal(manager.status().phase,'prepared');const names=await readdir(config.updatesDirectory);assert.equal(names.some(name=>name.endsWith('.armed')),false);assert.equal(names.some(name=>name.endsWith('.armed.tmp')),false);
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('only the running target version can acknowledge a GUI startup request',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-update-')),data=fixture('1.3.0',Buffer.from('installer')),config={...options(directory,data),currentVersion:'1.2.0'},token='00000000-0000-4000-8000-000000000001';try{
  await mkdir(config.updatesDirectory,{recursive:true});await writeFile(join(config.updatesDirectory,'startup-request.json'),JSON.stringify({schemaVersion:1,targetVersion:'1.2.0',token}));const manager=new UpdateManager(config);assert.equal(await manager.acknowledgeStartup(),true);assert.equal(await readFile(join(config.updatesDirectory,'startup-ack'),'utf8'),token);assert.equal(manager.status().phase,'installed');
  await writeFile(join(config.updatesDirectory,'startup-request.json'),JSON.stringify({schemaVersion:1,targetVersion:'9.9.9',token}));assert.equal(await manager.acknowledgeStartup(),false);
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('a late startup cannot claim an uncertain preserved Mac transaction was installed',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-update-')),data=fixture('1.3.0',Buffer.from('installer')),config={...options(directory,data),currentVersion:'1.2.0',platform:'darwin' as const,arch:'arm64'},token='00000000-0000-4000-8000-000000000001';try{
  await mkdir(config.updatesDirectory,{recursive:true});await writeFile(join(config.updatesDirectory,'startup-request.json'),JSON.stringify({schemaVersion:1,targetVersion:'1.2.0',token}));await writeFile(join(config.updatesDirectory,'install-error.json'),JSON.stringify({schemaVersion:1,targetVersion:'1.2.0',failedAt:new Date().toISOString(),message:'preserved',recoveryJobPath:join(config.updatesDirectory,'install-job.json')}));const manager=new UpdateManager(config);assert.equal(await manager.acknowledgeStartup(),false);await assert.rejects(readFile(join(config.updatesDirectory,'startup-ack')));
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('an unresolved recovery transaction stays visible and blocks the normal update flow',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-update-')),data=fixture('1.2.0',Buffer.from('installer')),config={...options(directory,data),platform:'darwin' as const,arch:'arm64'},recoveryJobPath=join(directory,'updates','install-recovery.json');try{
  await mkdir(config.updatesDirectory,{recursive:true});await writeFile(recoveryJobPath,'{}');await writeFile(join(config.updatesDirectory,'install-error.json'),JSON.stringify({schemaVersion:1,targetVersion:'1.2.0',failedAt:new Date().toISOString(),message:'preserved',recoveryJobPath}));const manager=new UpdateManager(config),state=await manager.initialize();assert.equal(state.phase,'failed');assert.equal(state.retryable,false);assert.match(state.error!,/恢复副本/);assert.deepEqual(await manager.check(),state);await assert.rejects(manager.download(),/恢复副本/);await assert.rejects(manager.install(),/恢复副本/);assert.deepEqual(manager.status(),state);
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('Mac startup acknowledgement carries the live runtime identity',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-update-')),data=fixture('1.3.0',Buffer.from('installer')),runtimeApplicationPath=join(directory,'AppTranslocation','id','d','外链助手.app'),runtimeExecutablePath=join(runtimeApplicationPath,'Contents','MacOS','外链助手'),config={...options(directory,data),currentVersion:'1.2.0',platform:'darwin' as const,arch:'arm64',runtimeApplicationPath,runtimeExecutablePath,pid:456},token='00000000-0000-4000-8000-000000000001';try{
  await mkdir(config.updatesDirectory,{recursive:true});await writeFile(join(config.updatesDirectory,'startup-request.json'),JSON.stringify({schemaVersion:1,targetVersion:'1.2.0',token}));const manager=new UpdateManager(config);assert.equal(await manager.acknowledgeStartup(),true);assert.deepEqual(JSON.parse(await readFile(join(config.updatesDirectory,'startup-ack'),'utf8')),{schemaVersion:2,targetVersion:'1.2.0',token,pid:456,applicationPath:runtimeApplicationPath,executablePath:runtimeExecutablePath});
 }finally{await rm(directory,{recursive:true,force:true})}
});

test('a signed release without this platform is unsupported instead of becoming downloadable',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-update-')),data=fixture('1.2.0',Buffer.from('installer'));try{const manager=new UpdateManager({...options(directory,data),platform:'darwin',arch:'arm64'});assert.equal((await manager.check()).phase,'unsupported');assert.equal(manager.status().targetVersion,'1.2.0');await assert.rejects(manager.download())}finally{await rm(directory,{recursive:true,force:true})}
});
