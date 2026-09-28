const {readFile,writeFile}=require('node:fs/promises');
const {basename,dirname,join}=require('node:path');
const {execFile,spawn}=require('node:child_process');
const {randomBytes}=require('node:crypto');

const allowedErrorCodes=new Set(['EACCES','EBUSY','EEXIST','EINVAL','EIO','ENOENT','EPERM','ETIMEDOUT']);
function safeFailure(error,stage,startedAt){
 const code=typeof error?.code==='string'&&allowedErrorCodes.has(error.code)?error.code:typeof error?.code==='number'?error.code:undefined;
 const signal=typeof error?.signal==='string'&&/^[A-Z0-9]{1,12}$/.test(error.signal)?error.signal:undefined;
 return {stage,elapsedMs:Date.now()-startedAt,code,killed:error?.killed===true,signal};
}

(async()=>{
 const config=JSON.parse(await readFile(process.argv[2],'utf8')),job=JSON.parse(await readFile(config.jobPath,'utf8')),helper=require(config.helperPath),checks=[];
 const environment={...process.env};delete environment.ELECTRON_RUN_AS_NODE;delete environment.LINKFLOW_UPDATE_HELPER;
 let blocked=false,reportPid,probeError,diagnostic,stage='helper_start',stageStarted=Date.now();
 const mark=value=>{stage=value;stageStarted=Date.now()};
 const run=(file,args,env=environment)=>new Promise((done,reject)=>execFile(file,args,{env,shell:false,timeout:65000,maxBuffer:1024*1024},error=>error?reject(error):done()));
 const countImage=image=>new Promise(done=>execFile('tasklist',['/FI',`IMAGENAME eq ${image}`,'/FO','CSV','/NH'],{encoding:'utf8',timeout:5000,windowsHide:true,shell:false},(error,stdout)=>{if(error){done(undefined);return}done(stdout.split(/\r?\n/).filter(line=>line.trim().startsWith('"')).length)}));
 const executeInstaller=(file,args)=>new Promise((done,reject)=>{mark('windows_installer');execFile(file,args,{timeout:180000,maxBuffer:1024*1024,windowsVerbatimArguments:true,shell:false},error=>{if(!error){done();return}void (async()=>{diagnostic=safeFailure(error,stage,stageStarted);diagnostic.processPresence={application:await countImage(basename(job.executablePath)),installer:await countImage(basename(file)),helper:await countImage(basename(process.execPath))};reject(error)})()})});
 async function receiveReport(path,nonce){mark('gui_report');const report=JSON.parse(await readFile(path,'utf8'));if(!report.passed||report.nonce!==nonce||report.version!==config.version||!report.checks.includes('packaged window and bridge render'))throw Error('Native GUI version proof failed');reportPid=report.pid;await writeFile(job.startupAckPath,job.token,{mode:0o600});checks.push('actual candidate GUI self-test and version passed')}
 async function launch(file){mark('gui_launch');const reportPath=join(config.directory,'gui-'+randomBytes(6).toString('hex')+'.json'),nonce=randomBytes(16).toString('hex');const child=spawn(file,['--linkflow-self-test'],{cwd:dirname(file),env:{...environment,LINKFLOW_SELF_TEST_REPORT:reportPath,LINKFLOW_SELF_TEST_NONCE:nonce},stdio:'ignore',shell:false});await new Promise((done,reject)=>{child.once('spawn',done);child.once('error',reject)});child.once('exit',code=>{if(code!==0){probeError='GUI diagnostics exited unsuccessfully';return}receiveReport(reportPath,nonce).catch(()=>probeError='GUI report invalid')});return {pid:child.pid}}
 async function openMac(path){mark('mac_system_assessment');if(blocked)return;try{await run('/usr/sbin/spctl',['--assess','--type','execute',path])}catch(error){if(error.code!==3||error.killed||error.signal)throw Error('System assessment did not return an expected policy rejection');blocked=true;checks.push('quarantined candidate rejected by system assessment; no bypass attempted');throw Error('System security rejects candidate')}
  mark('mac_gui_launch');const reportPath=join(config.directory,'gui-mac.json'),nonce=randomBytes(16).toString('hex');await run('/usr/bin/open',['-n','-W','--env','LINKFLOW_SELF_TEST_REPORT='+reportPath,'--env','LINKFLOW_SELF_TEST_NONCE='+nonce,path,'--args','--linkflow-self-test']);await receiveReport(reportPath,nonce)
 }
 let failure=false;try{const ports={launch,openMac,findMacPid:async()=>reportPid};if(process.platform==='win32')ports.executeInstaller=executeInstaller;await helper.runUpdateHelper(config.jobPath,ports)}catch(error){failure=true;diagnostic??=safeFailure(error,stage,stageStarted)}
 if(probeError||failure&&!blocked){await writeFile(config.reportPath,JSON.stringify({passed:false,platform:process.platform,arch:process.arch,version:config.version,diagnostic:{...diagnostic,probeError:probeError?true:undefined}},null,2));throw Error('Native helper or GUI probe failed')}
 if(blocked){if(!failure)throw Error('Rejected candidate incorrectly marked installed');checks.push('helper restores previous application bytes after system rejection; old GUI relaunch is not exercised')}
 else {const receipt=JSON.parse(await readFile(job.receiptPath,'utf8'));if(receipt.targetVersion!==config.version)throw Error('Installation receipt mismatch');checks.push('real NSIS or Mac replacement completes with launch proof')}
 await writeFile(config.reportPath,JSON.stringify({passed:true,platform:process.platform,arch:process.arch,version:config.version,outcome:blocked?'rollback_system_policy':'installed',checks,limitations:'Same-version replacement/reinstall exercises native installer/helper and a path with spaces; this does not prove prior-version migration. Diagnostic launch hook uses real packaged GUI self-test and test-side acknowledgement, not production ACK. On Mac system rejection, the previous app bytes are restored but old GUI relaunch is not exercised. No production profile or live service is used.'},null,2));
})().then(()=>process.exit(0),()=>{console.error('Native helper validation failed');process.exit(1)});
