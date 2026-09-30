import { spawn } from 'node:child_process';
import { mkdir,readFile,mkdtemp,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
await mkdir('.evidence',{recursive:true});
const executable=process.env.LINKFLOW_EXECUTABLE||resolve(process.platform==='win32'?'release/外链助手-win32-x64/外链助手.exe':'release/外链助手-darwin-arm64/外链助手.app/Contents/MacOS/外链助手');
const version=JSON.parse(await readFile('package.json','utf8')).version;
const directory=await mkdtemp(join(tmpdir(),'linkflow-packaged-report-'));
const report=join(directory,'result.json');
const nonce=randomBytes(16).toString('hex');
const required=['executable is packaged','packaged window and bridge render','renderer Node integration remains disabled','isolated profile contains no websites or accounts','diagnostics never start the scheduler','first render does not access keychain','reported version matches package','packaged IPC persists settings','private domains rejected by packaged IPC','foreign protocols rejected','packaged catalog contains 58 documented candidates','isolated account and mailbox migrations are empty','automatic backups are opt-in without secret access','packaged update status remains passive during diagnostics'];
if(process.platform==='win32')required.push('Windows OS encryption is available','Windows encrypted secret roundtrip','Windows encrypted secret absent from state');
const child=spawn(executable,['--linkflow-self-test'],{env:{...process.env,LINKFLOW_SELF_TEST_REPORT:report,LINKFLOW_SELF_TEST_NONCE:nonce},stdio:'inherit',shell:false});
let timedOut=false;
const timer=setTimeout(()=>{timedOut=true;child.kill();process.exitCode=1},65000);
child.on('error',()=>{clearTimeout(timer);console.error('Unable to launch packaged test executable');process.exitCode=1});
child.on('exit',async code=>{
  clearTimeout(timer);
  try{
    if(code!==0||timedOut)throw Error('packaged executable test failed');
    const data=JSON.parse(await readFile(report,'utf8'));
    if(!data.passed||data.nonce!==nonce||data.platform!==process.platform||data.arch!==process.arch||data.version!==version||!Array.isArray(data.checks)||!required.every(c=>data.checks.includes(c)))throw Error('native platform evidence missing');
    await writeFile('.evidence/packaged-self-test.json',JSON.stringify(data,null,2));
    console.log('Native packaged checks: '+data.checks.length+'; '+data.platform+'/'+data.arch+'; '+data.version);process.exitCode=0;
  }catch{console.error('Native packaged self-test failed');process.exitCode=1}
});
