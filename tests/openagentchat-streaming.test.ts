import {createServer} from 'node:http';
import {gzipSync,deflateSync,brotliCompressSync} from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import {openAgentChatStreamingMutation,isOpenAgentChatOpaqueProgress,drainOpenAgentChatPendingOperations,openAgentChatPendingOperationCount,parseOpenAgentChatOpaque,OPENAGENTCHAT_MAX_RESPONSE_BYTES,type OpenAgentChatOpaqueResponse} from '../src/integrations/openagentchat';
const url='https://service.example/api/publish';
const init={method:'POST',headers:{'content-type':'application/json'},body:'{"body":"Synthetic fixture"}'};
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function response(body:BodyInit|null,headers:Record<string,string>={}){const r=new Response(body,{status:201,headers:{'content-type':'application/json',...headers}});Object.defineProperty(r,'url',{value:url});return r}
function journal(){const saves:OpenAgentChatOpaqueResponse[]=[];return {saves,persist:async(v:OpenAgentChatOpaqueResponse)=>{if(saves.length)assert.ok(isOpenAgentChatOpaqueProgress(saves.at(-1)!,v));saves.push(structuredClone(v))}}}
function bytes(v:OpenAgentChatOpaqueResponse){return Buffer.from(v.bodyBase64,'base64').toString()}

test('headers and each received prefix are saved before final parse',async()=>{
 const j=journal();let reads=0;
 const stream=new ReadableStream<Uint8Array>({pull(c){if(reads===0){assert.equal(j.saves.length,1);assert.equal(j.saves[0].status,201);c.enqueue(Buffer.from('{"key":'));reads++}else if(reads===1){assert.equal(bytes(j.saves.at(-1)!),'{"key":');c.enqueue(Buffer.from('"fixture"}'));reads++}else c.close()}},{highWaterMark:0});
 const result=await openAgentChatStreamingMutation(url,init,j.persist,()=>true,{fetch:async()=>response(stream)});
 assert.ok(result?.bodyComplete);assert.equal(j.saves.length,4);assert.deepEqual(parseOpenAgentChatOpaque(result!,url,201),{key:'fixture'});assert.ok(j.saves.every(v=>v.capturedAt===j.saves[0].capturedAt));
});

test('stalled stream retains encrypted-journal prefix before timeout and cancels without waiting',async()=>{
 const j=journal();let pulls=0,cancelled=false;
 const stream=new ReadableStream<Uint8Array>({pull(c){if(pulls++===0)c.enqueue(Buffer.from('{"claim_url":"fixture'));return new Promise(()=>{})},cancel(){cancelled=true;return new Promise(()=>{})}});
 const started=Date.now(),running=openAgentChatStreamingMutation(url,init,j.persist,()=>true,{timeoutMs:100,fetch:async()=>response(stream)});
 await delay(40);assert.ok(j.saves.length>=2);assert.equal(bytes(j.saves.at(-1)!),'{"claim_url":"fixture');assert.equal(j.saves.at(-1)!.bodyComplete,false);assert.ok(openAgentChatPendingOperationCount()>0);
 assert.equal(await running,undefined);assert.ok(Date.now()-started<700);assert.equal(await drainOpenAgentChatPendingOperations(200),true);assert.equal(cancelled,true);
});

test('read error retains latest prefix, never marks complete or calls transport twice',async()=>{
 const j=journal();let n=0,calls=0;
 const stream=new ReadableStream<Uint8Array>({pull(c){if(n++===0)c.enqueue(Buffer.from('{"id":'));else c.error(Error('disconnect'))}},{highWaterMark:0});
 const result=await openAgentChatStreamingMutation(url,init,j.persist,()=>true,{fetch:async()=>{calls++;return response(stream)}});
 assert.equal(result,undefined);assert.equal(calls,1);assert.equal(bytes(j.saves.at(-1)!),'{"id":');assert.equal(j.saves.at(-1)!.bodyComplete,false);
});

test('oversized single chunk preserves bounded prefix and cancels',async()=>{
 const j=journal();let cancelled=false;
 const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.alloc(OPENAGENTCHAT_MAX_RESPONSE_BYTES+20,65))},cancel(){cancelled=true}});
 const result=await openAgentChatStreamingMutation(url,init,j.persist,()=>true,{fetch:async()=>response(stream)});
 assert.equal(Buffer.from(result!.bodyBase64,'base64').length,OPENAGENTCHAT_MAX_RESPONSE_BYTES);assert.equal(result!.bodyComplete,false);assert.equal(cancelled,true);assert.equal(j.saves.length,2);
});

test('declared inconsistent size cannot turn a complete-looking JSON into a receipt',async()=>{
 for(const declared of ['9999999','100','nonsense']){
  const j=journal(),r=await openAgentChatStreamingMutation(url,init,j.persist,()=>true,{fetch:async()=>response('{}',{'content-length':declared})});
  assert.equal(r?.bodyComplete,false);assert.equal(parseOpenAgentChatOpaque(r!,url,201),undefined);assert.equal(j.saves[0].bodyBase64,'');
 }
});

test('pre-aborted operation or revoked authority never sends a mutation',async()=>{
 let calls=0;const c=new AbortController();c.abort();
 for(const deps of [{signal:c.signal},{}])await openAgentChatStreamingMutation(url,init,async()=>{},()=>{throw Error('revoked')},{...deps,fetch:async()=>{calls++;return response('{}')}});
 assert.equal(calls,0);
});

test('late ignored-abort reply is captured once after caller timeout',async()=>{
 const j=journal();let resolve!:(r:Response)=>void,calls=0;
 const p=openAgentChatStreamingMutation(url,init,j.persist,()=>true,{timeoutMs:100,fetch:async()=>{calls++;return await new Promise<Response>(r=>{resolve=r})}});
 assert.equal(await p,undefined);assert.equal(await drainOpenAgentChatPendingOperations(10),false);assert.ok(openAgentChatPendingOperationCount()>0);
 resolve(response('{"key":"late-fixture"}'));
 assert.equal(await drainOpenAgentChatPendingOperations(300),true);assert.equal(calls,1);assert.equal(j.saves.at(-1)!.bodyComplete,true);assert.deepEqual(parseOpenAgentChatOpaque(j.saves.at(-1)!,url,201),{key:'late-fixture'});
});

test('late stalled body remains bounded and never loses received prefix',async()=>{
 const j=journal();let resolve!:(r:Response)=>void;
 const p=openAgentChatStreamingMutation(url,init,j.persist,()=>true,{timeoutMs:100,fetch:async()=>await new Promise<Response>(r=>{resolve=r})});
 await p;resolve(response(new ReadableStream({start(c){c.enqueue(Buffer.from('{"key":'))},pull(){return new Promise(()=>{})}})));
 assert.equal(await drainOpenAgentChatPendingOperations(350),true);assert.equal(bytes(j.saves.at(-1)!),'{"key":');assert.equal(j.saves.at(-1)!.bodyComplete,false);
});

test('failed persistence never returns a usable receipt or keeps reading',async()=>{
 let writes=0,reads=0,cancelled=false;
 const stream=new ReadableStream<Uint8Array>({pull(c){reads++;c.enqueue(Buffer.from('{}'))},cancel(){cancelled=true}},{highWaterMark:0});
 const r=await openAgentChatStreamingMutation(url,init,async()=>{writes++;throw Error('disk unavailable')},()=>true,{fetch:async()=>response(stream)});
 assert.equal(r,undefined);assert.equal(writes,1);assert.equal(reads,0);assert.equal(cancelled,true);
});

test('hanging persistence remains tracked while caller and bounded drain stop',async()=>{
 let release!:()=>void;
 const p=openAgentChatStreamingMutation(url,init,async()=>await new Promise<void>(r=>{release=r}),()=>true,{timeoutMs:100,fetch:async()=>response('{}')});
 assert.equal(await p,undefined);assert.equal(await drainOpenAgentChatPendingOperations(10),false);release();assert.equal(await drainOpenAgentChatPendingOperations(300),true);
});

test('progress validator pins identity and headers, allows only prefix growth, and seals completed receipt',async()=>{
 const j=journal();await openAgentChatStreamingMutation(url,init,j.persist,()=>true,{fetch:async()=>response('{"ok":true}')});
 const first=j.saves[0],end=j.saves.at(-1)!;
 assert.equal(isOpenAgentChatOpaqueProgress(first,end),true);assert.equal(isOpenAgentChatOpaqueProgress(end,end),true);assert.equal(isOpenAgentChatOpaqueProgress(end,first),false);
 for(const next of [{...end,status:200},{...end,requestUrl:url+'/other'},{...end,headers:[['content-type','text/plain']] as Array<[string,string]>},{...end,capturedAt:'2026-01-01T00:00:00Z'},{...end,bodySha256:'0'.repeat(64)},{...end,bodyComplete:false}])assert.equal(isOpenAgentChatOpaqueProgress(end,next),false);
 const different=journal();await openAgentChatStreamingMutation(url,init,different.persist,()=>true,{now:()=>new Date(first.capturedAt),fetch:async()=>response('{"no":true}')});
 assert.equal(isOpenAgentChatOpaqueProgress(j.saves[1],different.saves[1]),false);
});


test('null response body seals only an absent or zero declared length',async()=>{
 for(const [declared,complete] of [[undefined,true],['0',true],['8',false]] as const){
  const j=journal(),r=await openAgentChatStreamingMutation(url,init,j.persist,()=>true,{fetch:async()=>response(null,declared===undefined?{}:{'content-length':declared})});
  assert.equal(r?.bodyComplete,complete);assert.equal(r?.bodyBase64,'');
 }
});


test('decoded encoded replies do not compare decoded bytes with wire Content-Length',async()=>{
 for(const encoding of ['gzip','deflate','br','gzip, br']){
  const j=journal(),r=await openAgentChatStreamingMutation(url,init,j.persist,()=>true,{fetch:async()=>response('{"key":"decoded-fixture"}',{'content-encoding':encoding,'content-length':'9'})});
  assert.equal(r?.bodyComplete,true);assert.deepEqual(parseOpenAgentChatOpaque(r!,url,201),{key:'decoded-fixture'});
 }
});
test('unsupported encodings, excessive wire length and identity mismatch stay unsealed',async()=>{
 for(const headers of [{'content-encoding':'unknown','content-length':'9'},{'content-encoding':'gzip','content-length':String(OPENAGENTCHAT_MAX_RESPONSE_BYTES+1)},{'content-encoding':'identity','content-length':'9'},{'content-encoding':'','content-length':'9'}]){
  const j=journal(),r=await openAgentChatStreamingMutation(url,init,j.persist,()=>true,{fetch:async()=>response('{"key":"decoded-fixture"}',headers)});
  assert.equal(r?.bodyComplete,false);assert.equal(parseOpenAgentChatOpaque(r!,url,201),undefined);
 }
});


test('real Fetch decodes gzip deflate and brotli while preserving wire length header',{timeout:5000},async()=>{
 const body=Buffer.from(JSON.stringify({key:'fixture-'+ 'x'.repeat(256)}));
 const encoded={gzip:gzipSync(body),deflate:deflateSync(body),br:brotliCompressSync(body)};
 let calls=0;const server=createServer((req,res)=>{calls++;const name=req.url!.slice(1) as keyof typeof encoded,value=encoded[name];if(!value){res.writeHead(404).end();return}res.writeHead(201,{'content-type':'application/json','content-encoding':name,'content-length':value.length});res.end(value)});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const address=server.address();assert.ok(address&&typeof address!=='string');
  for(const name of Object.keys(encoded) as Array<keyof typeof encoded>){
   const local:string=`http://127.0.0.1:${address.port}/${name}`,j=journal();
   const r=await openAgentChatStreamingMutation(local,{method:'GET'},j.persist,()=>true,{timeoutMs:1000});
   assert.ok(r?.bodyComplete);assert.equal(Number(r.headers.find(([key])=>key==='content-length')?.[1]),encoded[name].length);assert.equal(Buffer.from(r.bodyBase64,'base64').length,body.length);assert.deepEqual(parseOpenAgentChatOpaque(r,local,201),JSON.parse(body.toString()));
  }assert.equal(calls,3);
 }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))}
});
