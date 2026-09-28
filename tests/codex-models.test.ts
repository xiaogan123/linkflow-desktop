import test from 'node:test';
import assert from 'node:assert/strict';
import {queryCodexModels,parseCodexModels} from '../src/integrations/codex-models';
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
