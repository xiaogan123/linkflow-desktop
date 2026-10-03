import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const nativeSkip=process.platform!=='darwin'||process.arch!=='arm64'
  ?'Mac installer tests require a native Apple Silicon Mac.'
  :false;
const installerTemplatePath=resolve('scripts/install-mac.sh');
const fixtureVersion='9.8.7';

function run(file:string,args:string[],options:{cwd?:string;env?:NodeJS.ProcessEnv}={}){
  return spawnSync(file,args,{
    cwd:options.cwd,
    env:{...process.env,...options.env},
    encoding:'utf8',
    maxBuffer:8*1024*1024
  });
}

function requireSuccess(result:ReturnType<typeof run>,label:string){
  assert.equal(result.status,0,`${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function shellLiteral(value:string){return `'${value.replaceAll("'","'\\''")}'`}

async function sha256(filePath:string){
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function createFixtureArchive(root:string,version=fixtureVersion){
  const payloadRoot=join(root,'payload');
  const appPath=join(payloadRoot,'外链助手.app');
  const contents=join(appPath,'Contents');
  const macos=join(contents,'MacOS');
  const executable=join(macos,'外链助手');
  const archive=join(root,`Linkflow-${version}-mac-arm64.zip`);
  await mkdir(macos,{recursive:true});
  await writeFile(join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>外链助手</string>
<key>CFBundleIdentifier</key><string>com.linkflow.personal</string>
<key>CFBundleName</key><string>外链助手</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
</dict></plist>
`,'utf8');
  await copyFile(await realpath(process.execPath),executable);
  await chmod(executable,0o755);
  const signed=run('/usr/bin/codesign',['--force','--deep','--sign','-',appPath]);
  requireSuccess(signed,'fixture codesign');
  const archived=run('/usr/bin/ditto',['-c','-k','--norsrc','--noextattr','--keepParent',appPath,archive]);
  requireSuccess(archived,'fixture archive');
  return {appPath,archive,hash:await sha256(archive)};
}

async function writeExecutable(path:string,body:string){
  await writeFile(path,body,'utf8');
  await chmod(path,0o755);
}

async function renderInstaller(root:string,expectedHash:string,overrides:Record<string,string>={}){
  let source=await readFile(installerTemplatePath,'utf8');
  assert.equal(source.split('__LINKFLOW_VERSION__').length-1,1);
  assert.equal(source.split('__LINKFLOW_MAC_ARM64_SHA256__').length-1,1);
  source=source
    .replace('__LINKFLOW_VERSION__',fixtureVersion)
    .replace('__LINKFLOW_MAC_ARM64_SHA256__',expectedHash);
  for(const [name,path] of Object.entries(overrides)){
    const declaration=new RegExp(`^${name}=.*$`,'m');
    assert.match(source,declaration);
    source=source.replace(declaration,`${name}=${shellLiteral(path)}`);
  }
  const installer=join(root,'install-mac.sh');
  await writeExecutable(installer,source);
  return installer;
}

async function createCurlStub(root:string){
  const stub=join(root,'curl-stub.sh');
  await writeExecutable(stub,`#!/bin/bash
set -euo pipefail
printf '%s\\n' "$@" > "$CURL_LOG"
output=''
while (($#));do
  if [[ "$1" == '--output' ]];then output="$2";shift 2;else shift;fi
done
[[ -n "$output" ]]
if [[ -n "\${CURL_OUTPUT_PATH_LOG:-}" ]];then printf '%s' "$output" > "$CURL_OUTPUT_PATH_LOG";fi
/bin/cp "$FIXTURE_ARCHIVE" "$output"
if [[ -n "\${CURL_HARDLINK_PATH:-}" ]];then /bin/ln "$output" "$CURL_HARDLINK_PATH";fi
if [[ -n "\${RUNNING_MARKER_AFTER_DOWNLOAD:-}" ]];then printf running > "$RUNNING_MARKER_AFTER_DOWNLOAD";fi
`);
  return stub;
}

async function createCallLogger(root:string,name:string,exitCode=0){
  const stub=join(root,`${name}-stub.sh`);
  await writeExecutable(stub,`#!/bin/bash
printf '%s\\n' "$@" >> "$CALL_LOG"
exit ${exitCode}
`);
  return stub;
}

async function testRoot(){
  const root=await mkdtemp(join(tmpdir(),'linkflow-installer-test-'));
  const destination=join(root,'Applications');
  await mkdir(destination);
  return {root,destination};
}

function runInstaller(installer:string,destination:string,env:NodeJS.ProcessEnv={}){
  return run('/bin/bash',[installer,'--destination',destination],{env});
}

test('installer template is pinned to one official release and exposes only the bounded test destination',async()=>{
  const source=await readFile(installerTemplatePath,'utf8');
  assert.equal(source.split('__LINKFLOW_VERSION__').length-1,1);
  assert.equal(source.split('__LINKFLOW_MAC_ARM64_SHA256__').length-1,1);
  assert.match(source,/REPOSITORY="xiaogan123\/linkflow-desktop"/);
  assert.match(source,/download_url="https:\/\/github\.com\/\$REPOSITORY\/releases\/download\/v\$VERSION\/Linkflow-\$VERSION-mac-arm64\.zip"/);
  assert.match(source,/--destination 仅允许位于系统临时目录中的隔离测试目录/);
  assert.doesNotMatch(source,/"\$XATTR_BIN"[^\n]*\s-[a-z]*[dwc][a-z]*\b/);
  assert.doesNotMatch(source,/\/usr\/bin\/(?:python3?|node)\b/);
  assert.match(source,/exec 3<> "\$archive_snapshot_path"/);
  assert.match(source,/"\$RM_BIN" -- "\$archive_snapshot_path"/);
  assert.match(source,/"\$CAT_BIN" "\$archive" >&3/);
  assert.match(source,/"\$DITTO_BIN" -x -k --noqtn \/dev\/fd\/7/);
  assert.match(source,/"\$SHASUM_BIN" -a 256 \/dev\/fd\/4/);
  assert.match(source,/"\$SHASUM_BIN" -a 256 \/dev\/fd\/9/);
  assert.equal(source.match(/ensure_app_is_not_running/g)?.length,3);
  assert.match(source,/外链助手\[\.\]app\/Contents\/MacOS\/外链助手/);
  assert.doesNotMatch(source,/--url|--archive|--app-path/);
});

test('installer validates the exact official URL and installs a strict ad-hoc arm64 app into an empty isolated destination',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const fixture=await createFixtureArchive(root);
    const curl=await createCurlStub(root);
    const curlLog=join(root,'curl.log');
    const userData=join(root,'user-data-do-not-touch');
    await writeFile(userData,'private fixture');
    const installer=await renderInstaller(root,fixture.hash,{CURL_BIN:curl});
    const result=runInstaller(installer,destination,{FIXTURE_ARCHIVE:fixture.archive,CURL_LOG:curlLog});
    requireSuccess(result,'installer');

    const installed=join(destination,'外链助手.app');
    assert.equal((await lstat(installed)).isDirectory(),true);
    requireSuccess(run('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',installed]),'installed codesign');
    const architectures=run('/usr/bin/lipo',['-archs',join(installed,'Contents','MacOS','外链助手')]);
    requireSuccess(architectures,'installed architecture');
    assert.equal(architectures.stdout.trim(),'arm64');
    const attributes=run('/usr/bin/xattr',['-lr',installed]);
    requireSuccess(attributes,'installed xattrs');
    assert.doesNotMatch(attributes.stdout,/com\.apple\.quarantine:/);
    assert.equal(await readFile(userData,'utf8'),'private fixture');
    assert.match(result.stdout,/用户数据未被读取或修改/);
    assert.equal((await readdir(destination)).some(name=>name.startsWith('.linkflow-install.')),false);

    const curlArguments=(await readFile(curlLog,'utf8')).trim().split('\n');
    assert(curlArguments.includes(`https://github.com/xiaogan123/linkflow-desktop/releases/download/v${fixtureVersion}/Linkflow-${fixtureVersion}-mac-arm64.zip`));
    assert(curlArguments.includes('--proto'));
    assert(curlArguments.includes('=https'));
  }finally{await rm(root,{recursive:true,force:true})}
});

test('a retained hardlink cannot replace the anonymous archive snapshot after its SHA is accepted',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const trustedRoot=join(root,'trusted');
    const replacementRoot=join(root,'replacement');
    await mkdir(trustedRoot);
    await mkdir(replacementRoot);
    const fixture=await createFixtureArchive(trustedRoot);
    const replacement=await createFixtureArchive(replacementRoot);
    const replacementMarker=join(replacement.appPath,'Contents','Resources','different-payload');
    await mkdir(join(replacement.appPath,'Contents','Resources'));
    await writeFile(replacementMarker,'UNTRUSTED_B');
    requireSuccess(run('/usr/bin/codesign',['--force','--deep','--sign','-',replacement.appPath]),'replacement fixture codesign');
    await rm(replacement.archive);
    requireSuccess(run('/usr/bin/ditto',['-c','-k','--norsrc','--noextattr','--keepParent',replacement.appPath,replacement.archive]),'replacement fixture archive');
    const curl=await createCurlStub(root);
    const shasum=join(root,'shasum-stub.sh');
    await writeExecutable(shasum,`#!/bin/bash
set -euo pipefail
result="$(/usr/bin/shasum "$@")"
if [[ ! -e "$ARCHIVE_SWAP_LOG" ]];then
  /bin/cat "$REPLACEMENT_ARCHIVE" > "$CURL_HARDLINK_PATH"
  printf 'replaced' > "$ARCHIVE_SWAP_LOG"
fi
printf '%s\n' "$result"
`);
    const installer=await renderInstaller(root,fixture.hash,{CURL_BIN:curl,SHASUM_BIN:shasum});
    const result=runInstaller(installer,destination,{
      FIXTURE_ARCHIVE:fixture.archive,
      CURL_LOG:join(root,'curl.log'),
      CURL_HARDLINK_PATH:join(root,'retained-download.zip'),
      REPLACEMENT_ARCHIVE:replacement.archive,
      ARCHIVE_SWAP_LOG:join(root,'archive-swap.log')
    });
    requireSuccess(result,'anonymous-snapshot archive installation');
    assert.equal(await readFile(join(root,'archive-swap.log'),'utf8'),'replaced');
    await assert.rejects(readFile(join(destination,'外链助手.app','Contents','Resources','different-payload')),{code:'ENOENT'});
    requireSuccess(run('/usr/bin/codesign',['--verify','--deep','--strict',join(destination,'外链助手.app')]),'anonymous-snapshot installed app');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('the staged app stays cwd-bound when its parent path is temporarily replaced by a symlink',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const fixture=await createFixtureArchive(root);
    const curl=await createCurlStub(root);
    const externalRoot=join(root,'outside-parent');
    const externalApp=join(externalRoot,'外链助手.app');
    const externalMarker=join(externalApp,'outside-marker');
    await mkdir(externalApp,{recursive:true});
    await writeFile(externalMarker,'must remain outside');
    requireSuccess(run('/usr/bin/xattr',['-w','com.apple.quarantine','0081;outside',externalMarker]),'outside quarantine fixture');
    const xattr=join(root,'xattr-parent-swap-stub.sh');
    await writeExecutable(xattr,`#!/bin/bash
set -euo pipefail
if [[ ! -e "$SWAP_STATE" ]];then
  parent="\${PWD%/*}"
  held="$parent.bound"
  /bin/mv "$parent" "$held"
  /bin/ln -s "$SWAP_EXTERNAL_ROOT" "$parent"
  set +e
  /usr/bin/xattr "$@"
  status=$?
  set -e
  /bin/rm "$parent"
  /bin/mv "$held" "$parent"
  printf 'swapped' > "$SWAP_STATE"
  exit "$status"
fi
exec /usr/bin/xattr "$@"
`);
    const installer=await renderInstaller(root,fixture.hash,{CURL_BIN:curl,XATTR_BIN:xattr});
    const result=runInstaller(installer,destination,{
      FIXTURE_ARCHIVE:fixture.archive,
      CURL_LOG:join(root,'curl.log'),
      SWAP_EXTERNAL_ROOT:externalRoot,
      SWAP_STATE:join(root,'parent-swap.log')
    });
    requireSuccess(result,'cwd-bound staged app installation');
    assert.equal(await readFile(join(root,'parent-swap.log'),'utf8'),'swapped');
    assert.equal(await readFile(externalMarker,'utf8'),'must remain outside');
    const quarantine=run('/usr/bin/xattr',['-p','com.apple.quarantine',externalMarker]);
    requireSuccess(quarantine,'outside quarantine remains');
    assert.match(quarantine.stdout,/0081;outside/);
    requireSuccess(run('/usr/bin/codesign',['--verify','--deep','--strict',join(destination,'外链助手.app')]),'cwd-bound installed app');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('replacing the destination ancestor with a symlink cannot redirect the transaction outside',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const fixture=await createFixtureArchive(root);
    const curl=await createCurlStub(root);
    const originalApp=join(destination,'外链助手.app');
    const heldDestination=`${destination}.held`;
    const outsideDestination=join(root,'outside-Applications');
    const outsideApp=join(outsideDestination,'外链助手.app');
    await mkdir(originalApp);
    await writeFile(join(originalApp,'old-marker'),'original old');
    await mkdir(outsideApp,{recursive:true});
    await writeFile(join(outsideApp,'old-marker'),'outside old');
    const xattr=join(root,'xattr-destination-swap-stub.sh');
    await writeExecutable(xattr,`#!/bin/bash
set -euo pipefail
if [[ ! -e "$SWAP_STATE" ]];then
  /bin/mv "$DESTINATION" "$HELD_DESTINATION"
  /bin/ln -s "$OUTSIDE_DESTINATION" "$DESTINATION"
  printf swapped > "$SWAP_STATE"
fi
exec /usr/bin/xattr "$@"
`);
    const installer=await renderInstaller(root,fixture.hash,{CURL_BIN:curl,XATTR_BIN:xattr});
    const result=runInstaller(installer,destination,{
      FIXTURE_ARCHIVE:fixture.archive,
      CURL_LOG:join(root,'curl.log'),
      DESTINATION:destination,
      HELD_DESTINATION:heldDestination,
      OUTSIDE_DESTINATION:outsideDestination,
      SWAP_STATE:join(root,'destination-swap.log')
    });
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/安装目录.*换名或替换/);
    assert.equal(await readFile(join(outsideApp,'old-marker'),'utf8'),'outside old');
    assert.equal(await readFile(join(heldDestination,'外链助手.app','old-marker'),'utf8'),'original old');
    assert.deepEqual((await readdir(outsideDestination)).sort(),['外链助手.app']);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('substituting the newly created transaction directory cannot redirect writes outside',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const fixture=await createFixtureArchive(root);
    const curl=await createCurlStub(root);
    const oldApp=join(destination,'外链助手.app');
    const outsideTransaction=join(root,'outside-transaction');
    await mkdir(oldApp);
    await writeFile(join(oldApp,'old-marker'),'original old');
    await mkdir(outsideTransaction);
    const mktemp=join(root,'mktemp-transaction-swap-stub.sh');
    await writeExecutable(mktemp,`#!/bin/bash
set -euo pipefail
created="$(/usr/bin/mktemp "$@")"
if [[ "$created" == ./.linkflow-install.* ]];then
  /bin/mv "$created" "$created.held"
  /bin/ln -s "$OUTSIDE_TRANSACTION" "$created"
  printf swapped > "$SWAP_STATE"
fi
printf '%s\n' "$created"
`);
    const installer=await renderInstaller(root,fixture.hash,{CURL_BIN:curl,MKTEMP_BIN:mktemp});
    const result=runInstaller(installer,destination,{
      FIXTURE_ARCHIVE:fixture.archive,
      CURL_LOG:join(root,'curl.log'),
      OUTSIDE_TRANSACTION:outsideTransaction,
      SWAP_STATE:join(root,'transaction-swap.log')
    });
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/事务目录.*被替换/);
    assert.equal(await readFile(join(root,'transaction-swap.log'),'utf8'),'swapped');
    assert.equal(await readFile(join(oldApp,'old-marker'),'utf8'),'original old');
    assert.deepEqual(await readdir(outsideTransaction),[]);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('renaming a bound transaction and replacing its path cannot redirect later writes',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const fixture=await createFixtureArchive(root);
    const curl=await createCurlStub(root);
    const oldApp=join(destination,'外链助手.app');
    const outsideTransaction=join(root,'outside-bound-transaction');
    await mkdir(oldApp);
    await writeFile(join(oldApp,'old-marker'),'original old');
    await mkdir(outsideTransaction);
    const xattr=join(root,'xattr-bound-transaction-swap-stub.sh');
    await writeExecutable(xattr,`#!/bin/bash
set -euo pipefail
count=0
if [[ -e "$XATTR_STATE" ]];then count="$(cat "$XATTR_STATE")";fi
count=$((count+1));printf '%s' "$count" > "$XATTR_STATE"
if ((count==4));then
  transaction="$PWD"
  /bin/mv "$transaction" "$transaction.held"
  /bin/ln -s "$OUTSIDE_TRANSACTION" "$transaction"
  printf swapped > "$SWAP_STATE"
fi
exec /usr/bin/xattr "$@"
`);
    const installer=await renderInstaller(root,fixture.hash,{CURL_BIN:curl,XATTR_BIN:xattr});
    const result=runInstaller(installer,destination,{
      FIXTURE_ARCHIVE:fixture.archive,
      CURL_LOG:join(root,'curl.log'),
      OUTSIDE_TRANSACTION:outsideTransaction,
      XATTR_STATE:join(root,'xattr-count'),
      SWAP_STATE:join(root,'bound-transaction-swap.log')
    });
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/安装后校验失败；旧应用已恢复/);
    assert.equal(await readFile(join(root,'bound-transaction-swap.log'),'utf8'),'swapped');
    assert.equal(await readFile(join(oldApp,'old-marker'),'utf8'),'original old');
    assert.deepEqual(await readdir(outsideTransaction),[]);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('rollback stops if the bound transaction is reparented outside the installation directory',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const fixture=await createFixtureArchive(root);
    const curl=await createCurlStub(root);
    const oldApp=join(destination,'外链助手.app');
    const outsideParent=join(root,'outside-parent');
    await mkdir(oldApp);
    await writeFile(join(oldApp,'old-marker'),'original old');
    await mkdir(outsideParent);
    const mv=join(root,'mv-reparent-transaction-stub.sh');
    await writeExecutable(mv,`#!/bin/bash
set -euo pipefail
/bin/mv "$@"
if [[ ! -e "$REPARENT_STATE" ]];then
  /bin/mv "$PWD" "$OUTSIDE_PARENT/held-transaction"
  printf reparented > "$REPARENT_STATE"
fi
`);
    const installer=await renderInstaller(root,fixture.hash,{CURL_BIN:curl,MV_BIN:mv});
    const result=runInstaller(installer,destination,{
      FIXTURE_ARCHIVE:fixture.archive,
      CURL_LOG:join(root,'curl.log'),
      OUTSIDE_PARENT:outsideParent,
      REPARENT_STATE:join(root,'reparent-state')
    });
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/事务的父目录已变化.*停止自动回滚/);
    assert.equal(await readFile(join(root,'reparent-state'),'utf8'),'reparented');
    await assert.rejects(lstat(join(outsideParent,'外链助手.app')),{code:'ENOENT'});
    assert.equal(await readFile(join(outsideParent,'held-transaction','previous-外链助手.app','old-marker'),'utf8'),'original old');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('installer preserves the previous bundle as rollback while leaving adjacent user data untouched',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const fixture=await createFixtureArchive(root);
    const curl=await createCurlStub(root);
    const oldApp=join(destination,'外链助手.app');
    const outsideUserData=join(root,'user.sqlite');
    await mkdir(oldApp);
    await writeFile(join(oldApp,'old-marker'),'original bundle');
    await writeFile(outsideUserData,'unchanged user data');
    const installer=await renderInstaller(root,fixture.hash,{CURL_BIN:curl});
    const result=runInstaller(installer,destination,{FIXTURE_ARCHIVE:fixture.archive,CURL_LOG:join(root,'curl.log')});
    requireSuccess(result,'installer replacement');

    const transactions=(await readdir(destination)).filter(name=>name.startsWith('.linkflow-install.'));
    assert.equal(transactions.length,1);
    const rollback=join(destination,transactions[0],'previous-外链助手.app');
    assert.equal(await readFile(join(rollback,'old-marker'),'utf8'),'original bundle');
    assert.equal(await readFile(outsideUserData,'utf8'),'unchanged user data');
    requireSuccess(run('/usr/bin/codesign',['--verify','--deep','--strict',join(destination,'外链助手.app')]),'replacement codesign');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('SHA-256 failure performs no extraction, attribute change, or destination mutation',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const fixture=await createFixtureArchive(root);
    const curl=await createCurlStub(root);
    const callLog=join(root,'mutating-tools.log');
    const logger=await createCallLogger(root,'mutation');
    const oldApp=join(destination,'外链助手.app');
    await mkdir(oldApp);
    await writeFile(join(oldApp,'old-marker'),'original bundle');
    const installer=await renderInstaller(root,'0'.repeat(64),{CURL_BIN:curl,DITTO_BIN:logger,XATTR_BIN:logger});
    const result=runInstaller(installer,destination,{FIXTURE_ARCHIVE:fixture.archive,CURL_LOG:join(root,'curl.log'),CALL_LOG:callLog});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/SHA-256/);
    assert.equal(await readFile(join(oldApp,'old-marker'),'utf8'),'original bundle');
    await assert.rejects(lstat(callLog),{code:'ENOENT'});
    assert.deepEqual(await readdir(destination),['外链助手.app']);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('archive traversal is rejected before extraction or attribute operations',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const archiveRoot=join(root,'malicious');
    const base=join(archiveRoot,'base');
    const outside=join(archiveRoot,'outside');
    const archive=join(root,`Linkflow-${fixtureVersion}-mac-arm64.zip`);
    await mkdir(base,{recursive:true});
    await writeFile(outside,'sentinel');
    requireSuccess(run('/usr/bin/zip',['-q',archive,'../outside'],{cwd:base}),'traversal archive');
    const curl=await createCurlStub(root);
    const callLog=join(root,'mutating-tools.log');
    const logger=await createCallLogger(root,'mutation');
    const installer=await renderInstaller(root,await sha256(archive),{CURL_BIN:curl,DITTO_BIN:logger,XATTR_BIN:logger});
    const result=runInstaller(installer,destination,{FIXTURE_ARCHIVE:archive,CURL_LOG:join(root,'curl.log'),CALL_LOG:callLog});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/越界路径|应用目录以外/);
    assert.equal(await readFile(outside,'utf8'),'sentinel');
    await assert.rejects(lstat(callLog),{code:'ENOENT'});
    assert.deepEqual(await readdir(destination),[]);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('an extra top-level executable is rejected before extraction and leaves the destination empty',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const fixture=await createFixtureArchive(root);
    const extra=join(root,'payload','unexpected-runner');
    await writeExecutable(extra,'#!/bin/sh\nexit 0\n');
    requireSuccess(run('/usr/bin/zip',['-q',fixture.archive,'unexpected-runner'],{cwd:join(root,'payload')}),'extra-entry archive');
    const curl=await createCurlStub(root);
    const callLog=join(root,'mutating-tools.log');
    const logger=await createCallLogger(root,'mutation');
    const installer=await renderInstaller(root,await sha256(fixture.archive),{CURL_BIN:curl,DITTO_BIN:logger,XATTR_BIN:logger});
    const result=runInstaller(installer,destination,{FIXTURE_ARCHIVE:fixture.archive,CURL_LOG:join(root,'curl.log'),CALL_LOG:callLog});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/应用目录以外/);
    await assert.rejects(lstat(callLog),{code:'ENOENT'});
    assert.deepEqual(await readdir(destination),[]);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('an app-internal entry with an escaping symlink is rejected before extraction',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const payload=join(root,'symlink-payload');
    const app=join(payload,'外链助手.app');
    const archive=join(root,`Linkflow-${fixtureVersion}-mac-arm64.zip`);
    await mkdir(app,{recursive:true});
    await symlink('../../outside',join(app,'escape'));
    requireSuccess(run('/usr/bin/zip',['-q','-r','-y',archive,'外链助手.app'],{cwd:payload}),'symlink archive');
    const curl=await createCurlStub(root);
    const callLog=join(root,'mutating-tools.log');
    const logger=await createCallLogger(root,'mutation');
    const installer=await renderInstaller(root,await sha256(archive),{CURL_BIN:curl,DITTO_BIN:logger,XATTR_BIN:logger});
    const result=runInstaller(installer,destination,{FIXTURE_ARCHIVE:archive,CURL_LOG:join(root,'curl.log'),CALL_LOG:callLog});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/越界符号链接|外部符号链接/);
    await assert.rejects(lstat(callLog),{code:'ENOENT'});
    assert.deepEqual(await readdir(destination),[]);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('a regular file hard-linked outside the extracted tree is rejected before any attribute read',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const fixture=await createFixtureArchive(root);
    const curl=await createCurlStub(root);
    const ditto=join(root,'ditto-hardlink-stub.sh');
    const outside=join(root,'outside-hardlink');
    await writeExecutable(ditto,`#!/bin/bash
set -euo pipefail
if [[ "$1" == '-x' ]];then
  /usr/bin/ditto "$@"
  destination="\${!#}"
  /bin/ln "$destination/外链助手.app/Contents/MacOS/外链助手" "$HARDLINK_OUTSIDE"
  /usr/bin/stat -f '%l' "$HARDLINK_OUTSIDE" > "$HARDLINK_LOG"
  exit 0
fi
exec /usr/bin/ditto "$@"
`);
    const xattrLog=join(root,'xattr.log');
    const xattr=await createCallLogger(root,'xattr',0);
    const installer=await renderInstaller(root,fixture.hash,{CURL_BIN:curl,DITTO_BIN:ditto,XATTR_BIN:xattr});
    const result=runInstaller(installer,destination,{
      FIXTURE_ARCHIVE:fixture.archive,
      CURL_LOG:join(root,'curl.log'),
      CALL_LOG:xattrLog,
      HARDLINK_OUTSIDE:outside,
      HARDLINK_LOG:join(root,'hardlink-count.log')
    });
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/硬链接/);
    assert.equal(await readFile(join(root,'hardlink-count.log'),'utf8'),'2\n');
    assert.equal((await lstat(outside)).isFile(),true);
    await assert.rejects(lstat(xattrLog),{code:'ENOENT'});
    assert.deepEqual(await readdir(destination),[]);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('a quarantined extracted tree fails closed without installing or deleting the attribute',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const fixture=await createFixtureArchive(root);
    const curl=await createCurlStub(root);
    const ditto=join(root,'ditto-quarantine-stub.sh');
    await writeExecutable(ditto,`#!/bin/bash
set -euo pipefail
if [[ "$1" == '-x' ]];then
  /usr/bin/ditto "$@"
  destination="\${!#}"
  executable="$destination/外链助手.app/Contents/MacOS/外链助手"
  /usr/bin/xattr -w com.apple.quarantine '0081;fixture' "$executable"
  /usr/bin/xattr -p com.apple.quarantine "$executable" > "$QUARANTINE_LOG"
  exit 0
fi
exec /usr/bin/ditto "$@"
`);
    const installer=await renderInstaller(root,fixture.hash,{CURL_BIN:curl,DITTO_BIN:ditto});
    const result=runInstaller(installer,destination,{
      FIXTURE_ARCHIVE:fixture.archive,
      CURL_LOG:join(root,'curl.log'),
      QUARANTINE_LOG:join(root,'quarantine.log')
    });
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/不会主动删除属性或继续安装/);
    assert.match(await readFile(join(root,'quarantine.log'),'utf8'),/0081;fixture/);
    assert.deepEqual(await readdir(destination),[]);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('a running installed app is left untouched and download never starts',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const target=join(destination,'外链助手.app');
    await mkdir(target);
    await writeFile(join(target,'old-marker'),'running original');
    const pgrep=await createCallLogger(root,'pgrep',0);
    const curl=await createCallLogger(root,'curl',0);
    const callLog=join(root,'calls.log');
    const installer=await renderInstaller(root,'0'.repeat(64),{PGREP_BIN:pgrep,CURL_BIN:curl});
    const result=runInstaller(installer,destination,{CALL_LOG:callLog});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/正常退出后重新执行/);
    assert.equal(await readFile(join(target,'old-marker'),'utf8'),'running original');
    const calls=await readFile(callLog,'utf8');
    assert.match(calls,/Contents\/MacOS\/外链助手/);
    assert.doesNotMatch(calls,/github\.com/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('an App Translocation process is detected even when the destination has no installed app',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const pgrep=join(root,'pgrep-translocation-stub.sh');
    await writeExecutable(pgrep,`#!/bin/bash
set -euo pipefail
pattern="\${!#}"
printf '%s\n' "$@" >> "$CALL_LOG"
if printf '%s\n' '/private/var/folders/example/AppTranslocation/ABC/d/外链助手.app/Contents/MacOS/外链助手 --started'|/usr/bin/grep -Eq "$pattern";then exit 0;fi
exit 1
`);
    const curl=await createCallLogger(root,'curl',0);
    const callLog=join(root,'calls.log');
    const installer=await renderInstaller(root,'0'.repeat(64),{PGREP_BIN:pgrep,CURL_BIN:curl});
    const result=runInstaller(installer,destination,{CALL_LOG:callLog});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/外链助手仍在运行/);
    const calls=await readFile(callLog,'utf8');
    assert.match(calls,/外链助手\[\.\]app\/Contents\/MacOS\/外链助手/);
    assert.doesNotMatch(calls,/github\.com/);
    assert.deepEqual(await readdir(destination),[]);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('an app started during the download is rejected at the final replacement gate',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const fixture=await createFixtureArchive(root);
    const curl=await createCurlStub(root);
    const oldApp=join(destination,'外链助手.app');
    await mkdir(oldApp);
    await writeFile(join(oldApp,'old-marker'),'original app');
    const pgrep=join(root,'pgrep-late-start-stub.sh');
    await writeExecutable(pgrep,`#!/bin/bash
set -euo pipefail
count=0
if [[ -e "$PGREP_COUNT" ]];then count="$(cat "$PGREP_COUNT")";fi
count=$((count+1));printf '%s' "$count" > "$PGREP_COUNT"
if [[ -e "$RUNNING_MARKER_AFTER_DOWNLOAD" ]];then exit 0;fi
exit 1
`);
    const installer=await renderInstaller(root,fixture.hash,{CURL_BIN:curl,PGREP_BIN:pgrep});
    const result=runInstaller(installer,destination,{
      FIXTURE_ARCHIVE:fixture.archive,
      CURL_LOG:join(root,'curl.log'),
      RUNNING_MARKER_AFTER_DOWNLOAD:join(root,'running-after-download'),
      PGREP_COUNT:join(root,'pgrep-count')
    });
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/外链助手仍在运行/);
    assert.equal(await readFile(join(oldApp,'old-marker'),'utf8'),'original app');
    assert.equal(await readFile(join(root,'pgrep-count'),'utf8'),'2');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('a process-query error fails closed before download or replacement',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const target=join(destination,'外链助手.app');
    await mkdir(target);
    await writeFile(join(target,'old-marker'),'original');
    const pgrep=await createCallLogger(root,'pgrep',2);
    const curl=await createCallLogger(root,'curl',0);
    const callLog=join(root,'calls.log');
    const installer=await renderInstaller(root,'0'.repeat(64),{PGREP_BIN:pgrep,CURL_BIN:curl});
    const result=runInstaller(installer,destination,{CALL_LOG:callLog});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/无法确认外链助手是否正在运行/);
    assert.equal(await readFile(join(target,'old-marker'),'utf8'),'original');
    const calls=await readFile(callLog,'utf8');
    assert.match(calls,/Contents\/MacOS\/外链助手/);
    assert.doesNotMatch(calls,/github\.com/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('a failed atomic swap restores the previous application bundle',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const fixture=await createFixtureArchive(root);
    const curl=await createCurlStub(root);
    const oldApp=join(destination,'外链助手.app');
    await mkdir(oldApp);
    await writeFile(join(oldApp,'old-marker'),'rollback source');
    const mv=join(root,'mv-stub.sh');
    await writeExecutable(mv,`#!/bin/bash
set -euo pipefail
count=0
if [[ -f "$MV_STATE" ]];then count="$(cat "$MV_STATE")";fi
count=$((count+1));printf '%s' "$count" > "$MV_STATE"
if ((count==2));then exit 1;fi
exec /bin/mv "$@"
`);
    const installer=await renderInstaller(root,fixture.hash,{CURL_BIN:curl,MV_BIN:mv});
    const result=runInstaller(installer,destination,{FIXTURE_ARCHIVE:fixture.archive,CURL_LOG:join(root,'curl.log'),MV_STATE:join(root,'mv-state')});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/旧应用已恢复/);
    assert.equal(await readFile(join(oldApp,'old-marker'),'utf8'),'rollback source');
    assert.equal(await readFile(join(root,'mv-state'),'utf8'),'3');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('a final attribute-read error rejects the new app and restores the previous bundle',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const fixture=await createFixtureArchive(root);
    const curl=await createCurlStub(root);
    const oldApp=join(destination,'外链助手.app');
    await mkdir(oldApp);
    await writeFile(join(oldApp,'old-marker'),'attribute rollback source');
    const xattr=join(root,'xattr-stub.sh');
    await writeExecutable(xattr,`#!/bin/bash
set -euo pipefail
count=0
if [[ -f "$XATTR_STATE" ]];then count="$(cat "$XATTR_STATE")";fi
count=$((count+1));printf '%s' "$count" > "$XATTR_STATE"
if ((count==4));then exit 2;fi
exec /usr/bin/xattr "$@"
`);
    const installer=await renderInstaller(root,fixture.hash,{CURL_BIN:curl,XATTR_BIN:xattr});
    const result=runInstaller(installer,destination,{FIXTURE_ARCHIVE:fixture.archive,CURL_LOG:join(root,'curl.log'),XATTR_STATE:join(root,'xattr-state')});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/安装后校验失败；旧应用已恢复/);
    assert.equal(await readFile(join(oldApp,'old-marker'),'utf8'),'attribute rollback source');
    assert.equal(await readFile(join(root,'xattr-state'),'utf8'),'4');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('custom destinations outside the bounded Applications test shape are refused before download',{skip:nativeSkip},async()=>{
  const root=await mkdtemp(join(tmpdir(),'linkflow-installer-destination-'));
  try{
    const destination=join(root,'ArbitraryTarget');
    await mkdir(destination);
    const curl=await createCallLogger(root,'curl',0);
    const callLog=join(root,'calls.log');
    const installer=await renderInstaller(root,'0'.repeat(64),{CURL_BIN:curl});
    const result=runInstaller(installer,destination,{CALL_LOG:callLog});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/Applications 命名/);
    await assert.rejects(lstat(callLog),{code:'ENOENT'});
    assert.deepEqual(await readdir(destination),[]);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('a missing system command is reported without downloading or installing dependencies',{skip:nativeSkip},async()=>{
  const {root,destination}=await testRoot();
  try{
    const curl=await createCallLogger(root,'curl',0);
    const callLog=join(root,'calls.log');
    const installer=await renderInstaller(root,'0'.repeat(64),{CURL_BIN:curl,STAT_BIN:join(root,'missing-stat')});
    const result=runInstaller(installer,destination,{CALL_LOG:callLog});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/安装器不会自动安装依赖/);
    await assert.rejects(lstat(callLog),{code:'ENOENT'});
    assert.deepEqual(await readdir(destination),[]);
  }finally{await rm(root,{recursive:true,force:true})}
});
