import test from 'node:test';
import assert from 'node:assert/strict';
import {AGENTSGATHER_CREATE,agentsGatherRequest,agentsGatherPublicUrl,agentsGatherThreadApi,agentsGatherPostApi,createAgentsGatherDiscussion,parseAgentsGatherReceipt,parseAgentsGatherAnonymousPost,readAgentsGatherDiscussion,type AgentsGatherPersistence,type AgentsGatherIntent,type AgentsGatherReceipt} from '../src/integrations/agentsgather';
import {drainOpenAgentChatPendingOperations,isOpenAgentChatOpaqueProgress,type OpenAgentChatOpaqueResponse} from '../src/integrations/openagentchat';
const taskId='00000000-0000-4000-8000-000000000001',requestId='00000000-0000-4000-8000-000000000002';
const draft={title:'Synthetic cancellation discussion',body:'A synthetic discussion of a paused request and its saved response. [Reference](https://example.org/guide)'};
const intent:AgentsGatherIntent={version:1,taskId,requestId,...(({sourceHash,requestHash})=>({sourceHash,requestHash}))(agentsGatherRequest(draft,requestId)),createdAt:'2026-01-01T00:00:00.000Z'};
const raw={ok:true,id:42,thread_id:42,url:agentsGatherPublicUrl(42),read_url:agentsGatherThreadApi(42),post_read_url:agentsGatherPostApi(42),anonymous:true,request_id:requestId};
function response(value:unknown,status=200,url=AGENTSGATHER_CREATE){const r=new Response(typeof value==='string'?value:JSON.stringify(value),{status,headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r}
function persistence(initial?:string){let saved=initial;const opaque:OpenAgentChatOpaqueResponse[]=[];let receipt:AgentsGatherReceipt|undefined;const p:AgentsGatherPersistence={loadPriorRaw:async()=>saved,persistIntent:async v=>{assert.equal(saved,undefined);saved=JSON.stringify(v)},assertAuthorized:()=>true,persistOpaque:async(_,v)=>{if(opaque.length)assert.ok(isOpenAgentChatOpaqueProgress(opaque.at(-1)!,v));opaque.push(structuredClone(v))},persistReceipt:async(_,r)=>{assert.equal(opaque.at(-1)?.bodyComplete,true);receipt=r}};return {p,opaque,get receipt(){return receipt}}}
test('UTF-8 title bytes and Unicode code points enforce different documented bounds',()=>{
 assert.doesNotThrow(()=>agentsGatherRequest({title:'界'.repeat(66),body:'😀'.repeat(4900)},requestId));
 assert.throws(()=>agentsGatherRequest({title:'界'.repeat(67),body:'a'},requestId));
 assert.throws(()=>agentsGatherRequest({title:'a',body:'😀'.repeat(5000)},requestId));
 for(const body of ['', ' ', '\ud800', '\udfff','x\0y'])assert.throws(()=>agentsGatherRequest({title:'Valid',body},requestId));
 assert.throws(()=>agentsGatherRequest({...draft,title:'two\nlines'},requestId));
});
test('request hash binds stable request ID and exact title and body',()=>{
 const a=agentsGatherRequest(draft,requestId),b=agentsGatherRequest({...draft,body:draft.body+' '},requestId),c=agentsGatherRequest(draft,taskId);
 assert.notEqual(a.requestHash,b.requestHash);assert.notEqual(a.sourceHash,b.sourceHash);assert.notEqual(a.requestHash,c.requestHash);assert.equal(a.sourceHash,c.sourceHash);
});
test('receipt binds anonymous top-level identity and constructs only fixed-origin read URLs',()=>{
 assert.ok(parseAgentsGatherReceipt(raw,intent));
 for(const patch of [{anonymous:false},{request_id:taskId},{thread_id:41},{id:42.5},{url:'https://evil.example/42'},{read_url:agentsGatherThreadApi(41)},{post_read_url:'https://agentsgather.org/api/v1/post?id=42&write=true'}])assert.equal(parseAgentsGatherReceipt({...raw,...patch},intent),undefined);
});
test('receipt accepts exact root-relative platform links without URL normalization',()=>{
 const relative={...raw,url:'/threads/42',read_url:'/api/v1/thread?id=42',post_read_url:'/api/v1/post?id=42'};
 assert.deepEqual(parseAgentsGatherReceipt(relative,intent),parseAgentsGatherReceipt(raw,intent));
 for(const field of ['url','read_url','post_read_url'] as const){
  for(const value of ['//agentsgather.org'+relative[field],'https://evil.example'+relative[field],relative[field]+'#fragment',relative[field]+'&action=create',relative[field].replace('42','%34%32'),relative[field].replace('42','41'),' '+relative[field]])assert.equal(parseAgentsGatherReceipt({...relative,[field]:value},intent),undefined);
 }
});
test('one POST follows durable intent and progressive raw capture before receipt promotion',async()=>{
 const j=persistence();let posts=0;
 const r=await createAgentsGatherDiscussion({taskId,requestId,draft},j.p,{fetch:async(u,i)=>{posts++;assert.equal(u,AGENTSGATHER_CREATE);assert.equal(i.method,'POST');assert.equal(i.redirect,'manual');assert.equal(i.credentials,'omit');assert.equal(await j.p.loadPriorRaw()!==undefined,true);assert.equal((JSON.parse(i.body as string)).request_id,requestId);return response(raw)}});
 assert.equal(r.status,'created');assert.equal(posts,1);assert.ok(j.opaque.length>=2);assert.equal(j.opaque[0].bodyComplete,false);assert.equal(j.receipt?.postId,42);
 assert.equal((await createAgentsGatherDiscussion({taskId,requestId,draft},j.p,{fetch:async()=>{posts++;throw Error('must not retry')}})).status,'prior_intent');assert.equal(posts,1);
});
test('any prior bytes, including corrupt evidence, prevent another mutation',async()=>{
 for(const prior of ['', '{broken']){let calls=0;assert.equal((await createAgentsGatherDiscussion({taskId,requestId,draft},persistence(prior).p,{fetch:async()=>{calls++;throw Error('unexpected')}})).status,'prior_intent');assert.equal(calls,0)}
});
test('revoked authority and failed durable intent send nothing',async()=>{
 for(const stage of ['intent','authority']){const j=persistence();if(stage==='intent')j.p.persistIntent=async()=>{throw Error('disk')};else j.p.assertAuthorized=()=>{throw Error('paused')};let calls=0;const r=await createAgentsGatherDiscussion({taskId,requestId,draft},j.p,{fetch:async()=>{calls++;return response(raw)}});assert.equal(calls,0);assert.equal(r.status,stage==='intent'?'not_started':'unknown')}
});
test('non-200 and malformed success responses stay unknown without a retry',async()=>{
 for(const [body,status] of [[raw,201],[raw,429],['{"ok":true,"ok":false}',200],['not json',200]] as const){const j=persistence();let calls=0;const r=await createAgentsGatherDiscussion({taskId,requestId,draft},j.p,{fetch:async()=>{calls++;return response(body,status)}});assert.equal(r.status,'unknown');assert.equal(calls,1);assert.equal(j.receipt,undefined);assert.ok(j.opaque.length)}
});
test('late response survives caller cancellation while result remains unknown',async()=>{
 const j=persistence();let deliver!:(v:Response)=>void,calls=0;const c=new AbortController();const running=createAgentsGatherDiscussion({taskId,requestId,draft},j.p,{signal:c.signal,timeoutMs:100,fetch:async()=>{calls++;return new Promise<Response>(resolve=>{deliver=resolve})}});
 while(!deliver)await new Promise(resolve=>setTimeout(resolve,1));c.abort();assert.equal((await running).status,'unknown');deliver(response(raw));assert.equal(await drainOpenAgentChatPendingOperations(400),true);assert.equal(calls,1);assert.equal(j.opaque.at(-1)?.bodyComplete,true);assert.equal(j.receipt,undefined);
});
test('public API readback requires exact anonymous main discussion, not a different author or reply',async()=>{
 const receipt=parseAgentsGatherReceipt(raw,intent)!;const post={id:42,author_id:0,anonymous:true,author:'Anonymous',kind:'discussion',title:draft.title,body:draft.body,url:'/threads/42',created:1767225600,updated:1767225600,activity:1767225600,score:0,locked:false,tags:'',replies:0};
 assert.ok(parseAgentsGatherAnonymousPost({ok:true,post},receipt,draft));
 for(const patch of [{id:41},{thread_id:42},{author_id:5},{anonymous:false},{kind:'reply'},{title:'Different'},{body:draft.body+' extra'},{created:Number.MAX_SAFE_INTEGER},{activity:undefined},{score:0.5},{locked:'false'},{tags:'bad\0tag'},{replies:-1}])assert.equal(parseAgentsGatherAnonymousPost({ok:true,post:{...post,...patch}},receipt,draft),undefined);
 let gets=0;assert.ok(await readAgentsGatherDiscussion(receipt,draft,{fetch:async(u,i)=>{gets++;assert.equal(i.method,'GET');assert.equal(u,agentsGatherPostApi(42));return response({ok:true,post},200,u)}}));assert.equal(gets,1);
 await assert.rejects(()=>readAgentsGatherDiscussion({...receipt,postReadUrl:'https://evil.example'},draft));
});
