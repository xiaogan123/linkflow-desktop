import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {queryCodexModels,parseCodexModels} from '../src/integrations/codex-models';
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForExit(pid:number,timeoutMs=2500){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){try{process.kill(pid,0)}catch{return}await pause(25)}throw Error('synthetic descendant remained alive')}
test('Codex models use advertised ids and efforts, never an invented availability list',()=>{
 const models=parseCodexModels([{model:'sample-model',displayName:'Sample',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'xhigh'}]},{model:'hidden-model',hidden:true},{model:'bad id'}]);
 assert.deepEqual(models,[{id:'sample-model',label:'Sample',source:'codex',isDefault:true,supportsReasoning:['high','xhigh']}]);
});
test('Codex stdio discovery initializes, pages model/list, and never starts a thread',async()=>{
 const script=`const r=require('node:readline').createInterface({input:process.stdin});let initialized=false;r.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));else if(m.method==='initialized')initialized=true;else if(m.method==='model/list'&&initialized){console.log(JSON.stringify({id:m.id,result:{data:[{model:m.params.cursor?'second':'first',supportedReasoningEfforts:[]}],nextCursor:m.params.cursor?null:'page2'}}))}else process.exit(4)});`;
 const models=await queryCodexModels(process.execPath,['-e',script],process.env,3000);assert.deepEqual(models.map(m=>m.id),['first','second']);
});
test('Codex discovery rejects stalled or malformed protocols without returning raw private errors',async()=>{
 await assert.rejects(queryCodexModels(process.execPath,['-e','setInterval(()=>{},1000)'],process.env,100),/超时/);
 await assert.rejects(queryCodexModels(process.execPath,['-e',`console.log('private-synthetic-garbage');setInterval(()=>{},1000)`],process.env,1000),error=>error instanceof Error&&!error.message.includes('private-synthetic-garbage'));
});
test('Codex discovery waits for the child to close before removing its working directory',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-model-close-test-')),marker=join(directory,'child.json');
 try{
  const script=`require('node:fs').writeFileSync(process.env.LINKFLOW_TEST_MARKER,JSON.stringify({pid:process.pid,cwd:process.cwd()}));const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{data:[{model:'sample'}]}}))});setInterval(()=>{},1000);`;
  assert.equal((await queryCodexModels(process.execPath,['-e',script],{...process.env,LINKFLOW_TEST_MARKER:marker},3000))[0].id,'sample');
  const child=JSON.parse(await readFile(marker,'utf8'));
  assert.throws(()=>process.kill(child.pid,0));
  await assert.rejects(access(child.cwd));
 }finally{await rm(directory,{recursive:true,force:true})}
});
test('Codex discovery terminates a shim descendant that inherits stdio after a successful response',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-model-shim-test-')),marker=join(directory,'descendant.json');let descendant=0;
 try{
  const script=`const{spawn}=require('node:child_process'),fs=require('node:fs'),readline=require('node:readline');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});fs.writeFileSync(process.env.LINKFLOW_TEST_MARKER,JSON.stringify({pid:child.pid,cwd:process.cwd()}));const r=readline.createInterface({input:process.stdin});let ready=false;r.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));else if(m.method==='initialized')ready=true;else if(m.method==='model/list'&&ready)console.log(JSON.stringify({id:m.id,result:{data:[{model:'shim-model'}]}}))});process.stdin.on('end',()=>process.exit(0));`;
  const models=await queryCodexModels(process.execPath,['-e',script],{...process.env,LINKFLOW_TEST_MARKER:marker},1000);assert.deepEqual(models.map(model=>model.id),['shim-model']);const child=JSON.parse(await readFile(marker,'utf8'));descendant=child.pid;await waitForExit(descendant);await assert.rejects(access(child.cwd));
 }finally{if(!descendant)try{descendant=JSON.parse(await readFile(marker,'utf8')).pid}catch{}if(descendant)try{process.kill(descendant,'SIGKILL')}catch{}await rm(directory,{recursive:true,force:true})}
});
test('Codex discovery timeout remains bounded and terminates an inherited-stdio descendant',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-model-timeout-test-')),marker=join(directory,'descendant.json');let descendant=0;
 try{
  const script=`const{spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});fs.writeFileSync(process.env.LINKFLOW_TEST_MARKER,JSON.stringify({pid:child.pid,cwd:process.cwd()}));process.stdin.resume();setInterval(()=>{},1000);`;
  const started=Date.now();await assert.rejects(queryCodexModels(process.execPath,['-e',script],{...process.env,LINKFLOW_TEST_MARKER:marker},100),/超时/);assert.ok(Date.now()-started<3000);const child=JSON.parse(await readFile(marker,'utf8'));descendant=child.pid;await waitForExit(descendant);await assert.rejects(access(child.cwd));
 }finally{if(!descendant)try{descendant=JSON.parse(await readFile(marker,'utf8')).pid}catch{}if(descendant)try{process.kill(descendant,'SIGKILL')}catch{}await rm(directory,{recursive:true,force:true})}
});
test('Codex discovery spawn failure is bounded and returns a static error',async()=>{
 const missing=join(tmpdir(),'linkflow-missing-command-'+process.pid),started=Date.now();await assert.rejects(queryCodexModels(missing,[],process.env,100),error=>error instanceof Error&&/无法启动/.test(error.message)&&!error.message.includes(missing));assert.ok(Date.now()-started<3000);
});
