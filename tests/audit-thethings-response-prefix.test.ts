import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createTheThingsPage,theThingsRequest,type TheThingsPersistence} from '../src/integrations/thethings';
import {openAgentChatPendingOperationCount} from '../src/integrations/openagentchat';
const input={operationId:'thethings_'+ 'a'.repeat(32),reviewed:true as const,title:'Audited response capture',summary:'A bounded synthetic capture test of the anonymous publication response.',html:'<!doctype html>\n<html><head><title>Capture</title></head><body><p>Test</p></body></html>'};
test('headers and received prefix must be durable before further body reads finish',async()=>{
 let raw:string|undefined,writes=0,settled=false,stream!:ReadableStreamDefaultController<Uint8Array>;const captured:any[]=[];
 const persistence:TheThingsPersistence={loadPriorRaw:async()=>raw,persistIntent:async value=>{raw=JSON.stringify({intent:value})},assertAuthorized:()=>true,persistOpaque:async(_intent,value)=>{captured.push(value);raw=JSON.stringify(value)},persistCreated:async()=>{}};
 const prefix=Buffer.from('{"url":"https://thethings.ai/p/scratch/fixture-only","claim_url":"https://thethings.ai/claim/synthetic');
 const resultPromise=createTheThingsPage(input,persistence,{timeoutMs:100,fetch:async()=>{writes++;return new Response(new ReadableStream<Uint8Array>({start(c){stream=c;c.enqueue(prefix)}}),{status:201,headers:{'content-type':'application/json'}})}}).finally(()=>{settled=true});
 await new Promise(resolve=>setTimeout(resolve,160));const latestBeforeFailure=captured.at(-1),observation={writes,settledAfterTimeout:settled,opaqueWritesBeforeStreamFailure:captured.length,prefixReceivedBytes:prefix.length,preservedBytesBeforeStreamFailure:latestBeforeFailure?Buffer.from(latestBeforeFailure.bodyBase64,'base64').length:0,pendingCount:openAgentChatPendingOperationCount(),externalRequests:0};
 stream.error(Error('controlled stream interruption'));const result=await resultPromise;const latest=captured.at(-1);Object.assign(observation,{finalStatus:result.status,opaqueWritesAfterStreamFailure:captured.length,preservedBytesAfterStreamFailure:latest?Buffer.from(latest.bodyBase64,'base64').length:0,bodyComplete:latest?.bodyComplete});
 fs.writeFileSync('../../prefix-fault.json',JSON.stringify(observation,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(observation));assert.ok(observation.opaqueWritesBeforeStreamFailure>0,'Response headers were not persisted while the stream remained open');assert.equal(observation.preservedBytesBeforeStreamFailure,prefix.length,'Received one-time credential prefix was not durable before timeout');
});
