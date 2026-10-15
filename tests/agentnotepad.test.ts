import test from 'node:test';
import {createAgentNotepadPublicationPersistence} from '../src/main/agentnotepad-publication';
import {defaultSettings} from '../src/main/store';
import assert from 'node:assert/strict';
import {agentNotepadHash,parseAgentNotepadPublishReceipt,parseAgentNotepadReceiptBoundResource,parseAgentNotepadRegistration,AGENTNOTEPAD_AGENTS_URL,AGENTNOTEPAD_PUBLISH_URL,reviewedAgentNotepadCitations,agentNotepadMutation,agentNotepadPublishRequest,agentNotepadRegistrationRequest,parseAgentNotepadOpaque,validAgentNotepadPublicationIntent,validAgentNotepadRegistrationIntent,readAgentNotepadRobots,type AgentNotepadPublicationIntent,type AgentNotepadResource} from '../src/integrations/agentnotepad';
import {agentNotepadTaskIdentity,agentNotepadPublisherTesting,reconcileAgentNotepadTask,runAgentNotepadTask} from '../src/integrations/agentnotepad-publisher';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});

test('ordinary reviewed drafts derive their own citation list without a fixed acceptance article',()=>{
 const registration=agentNotepadRegistrationRequest();assert.deepEqual(registration.value,{capabilities:['research'],topics:['engineering']});
 const first='Source [first](https://example.com/a), repeated [first](https://example.com/a).';
 const second='Another [tool](https://example.org/b) and [reference](https://example.org/c).';
 assert.deepEqual(reviewedAgentNotepadCitations('First',first),[{url:'https://example.com/a',title:'first'}]);
 assert.deepEqual(reviewedAgentNotepadCitations('Second',second),[{url:'https://example.org/b',title:'tool'},{url:'https://example.org/c',title:'reference'}]);
 assert.deepEqual(reviewedAgentNotepadCitations('No source','No links'),[]);
 assert.deepEqual(reviewedAgentNotepadCitations('Code','`[fake](https://example.com/fake)`'),[]);
 assert.equal(reviewedAgentNotepadCitations('Unsafe','[bad](javascript:alert)'),undefined);
});

test('fresh authorization is checked before physical registration and publication transport',async()=>{let calls=0,persisted=0;for(const url of [AGENTNOTEPAD_AGENTS_URL,AGENTNOTEPAD_PUBLISH_URL]){const result=await agentNotepadMutation(url,{method:'POST',body:'{}'},async()=>{persisted++},()=>{throw Error('revoked')},{fetch:async()=>{calls++;return json({data:{}},201)}});assert.equal(result,undefined)}assert.equal(calls,0);assert.equal(persisted,0)});

test('late response after abort is durably captured once without replay',async()=>{let resolveResponse!:(value:Response)=>void,calls=0;const captures:any[]=[];const pending=agentNotepadMutation(AGENTNOTEPAD_PUBLISH_URL,{method:'POST',body:'{}'},async value=>{captures.push(value)},()=>true,{timeoutMs:100,fetch:async()=>{calls++;return new Promise<Response>(resolve=>{resolveResponse=resolve})}});await new Promise(resolve=>setTimeout(resolve,120));resolveResponse(json({data:{id:'note_12345678'}},201));assert.equal(await pending,undefined);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(calls,1);assert.equal(captures.length,1);assert.equal(parseAgentNotepadOpaque(captures[0],AGENTNOTEPAD_PUBLISH_URL,201)!==undefined,true)});

test('unknown registration and publication intents remain valid backup records',()=>{const createdAt='2026-10-15T00:00:00.000Z',registration=agentNotepadRegistrationRequest(),publication=agentNotepadPublishRequest('title','body',[{url:'https://example.com/source',title:'source'}],'agentnotepad_publish_0123456789abcdef0123456789abcdef');assert.equal(validAgentNotepadRegistrationIntent({version:1,kind:'agentnotepad_registration',operationId:'agentnotepad_register_0123456789abcdef0123456789abcdef',requestHash:registration.requestHash,createdAt,capabilities:['research'],topics:['engineering']}),true);assert.equal(validAgentNotepadPublicationIntent({version:1,kind:'agentnotepad_publication',operationId:'agentnotepad_publish_0123456789abcdef0123456789abcdef',idempotencyKey:'agentnotepad_publish_0123456789abcdef0123456789abcdef',accountId:'00000000-0000-4000-8000-000000000001',agentId:'agent_12345678',requestHash:publication.requestHash,sourceHash:publication.sourceHash,citationsHash:publication.citationsHash,createdAt}),true)});

test('acceptance executes exact GETs and requires visible native anchor, canonical and crawler access',async()=>{const title='A note',body='Useful [target](https://example.com/tool).',citation={url:'https://example.com/source',title:'source'},resource:AgentNotepadResource={id:'note_12345678',kind:'note',title,body,topic:'engineering',authorId:'agent_12345678',revisionId:'revision_12345678',canonicalUrl:'https://agentnotepad.com/notebooks/note-12345678',revisionUrl:'https://agentnotepad.com/notebooks/note-12345678?revision=revision_12345678',citations:[citation]},gets:string[]=[];await agentNotepadPublisherTesting.acceptResource(resource,{title,body,targetUrl:'https://example.com/tool',citations:[citation],agentId:resource.authorId},{fetch:async url=>{gets.push(url);if(url.endsWith('/history'))return json({data:{items:[{revisionId:resource.revisionId}]}});if(url.endsWith('/robots.txt'))return new Response('User-agent: *\nAllow: /notebooks/',{status:200});return json({data:{...resource,slug:'note-12345678'}})},renderPage:async url=>({url,documentTitle:title,heading:title,articleText:'Useful target.',articleHtml:'<article>Useful <a href="https://example.com/tool" rel="nofollow ugc">target</a>.</article>',allTextVisible:true,links:[{href:'https://example.com/tool',rel:['nofollow','ugc'],text:'target',visible:true}],robots:[],responseRobots:[],responseLinks:[],canonicals:[url],hasRefresh:false,hasPasswordGate:false,hasLoginGate:false,responseStatus:200,responseMediaType:'text/html',responseBodyBytes:100,responseEncodedBodyBytes:100,nativeRequests:[{url,method:'GET',resourceType:'mainFrame'}]})});assert.deepEqual(gets,[`https://agentnotepad.com/api/v1/resources/${resource.id}`,`https://agentnotepad.com/api/v1/resources/${resource.id}/history`,'https://agentnotepad.com/robots.txt'])});

test('robots parser applies named crawler rules and longest allow match',()=>{const robots='User-agent: *\nDisallow: /notebooks/\nAllow: /notebooks/note-good$\n\nUser-agent: Googlebot\nDisallow: /notebooks/';assert.equal(agentNotepadPublisherTesting.robotsAllows(robots,'/notebooks/note-good','*'),true);assert.equal(agentNotepadPublisherTesting.robotsAllows(robots,'/notebooks/note-good','googlebot'),false)});

test('ordinary approved drafts bind each target and reject links that only appear in code',()=>{
 for(const host of ['https://example.com/a','https://example.org/b']){const draft={title:'Ordinary engineering note',body:`See the [tool](${host}).`,summary:'Note'};assert.ok(agentNotepadTaskIdentity({draft: draft as any},{url:host}));assert.equal(agentNotepadTaskIdentity({draft:{...draft,body:`Fake \`[tool](${host})\`.`} as any},{url:host}),undefined);assert.equal(agentNotepadTaskIdentity({draft:{...draft,body:`[one](${host}) [two](${host})`} as any},{url:host}),undefined)}
});
test('robots stalled response stream is cancelled within its request timeout',async()=>{
 let cancelled=false;const response=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('User-agent: *\n'))},cancel(){cancelled=true}}),{status:200});
 const keepAlive=setInterval(()=>{},1000);try{await assert.rejects(()=>readAgentNotepadRobots({timeoutMs:100,fetch:async()=>response}));assert.equal(cancelled,true)}finally{clearInterval(keepAlive)}
});


test('newly connected account can persist its first intent while pending publication checkpoints cannot',async()=>{
 const taskId='00000000-0000-4000-8000-000000000001',siteId='00000000-0000-4000-8000-000000000002',accountId='00000000-0000-4000-8000-000000000003',createdAt='2026-10-15T00:00:00.000Z';
 const request=agentNotepadPublishRequest('title','body',[],'agentnotepad_publish_0123456789abcdef0123456789abcdef');
 const intent={version:1 as const,kind:'agentnotepad_publication' as const,operationId:'agentnotepad_publish_0123456789abcdef0123456789abcdef',idempotencyKey:'agentnotepad_publish_0123456789abcdef0123456789abcdef',accountId,agentId:'agent_12345678',requestHash:request.requestHash,sourceHash:request.sourceHash,citationsHash:request.citationsHash,createdAt};
 for(const checkpoint of ['agentnotepad_account_ready','agentnotepad_publish_submitting','agentnotepad_publish_api_receipt','uncertain']){
  const state:any={tasks:[{id:taskId,siteId,accountId,channelId:'agentnotepad',sourceDomain:'agentnotepad.com',checkpoint,status:'queued'}],sites:[{id:siteId}]};
  const ciphers:Record<string,string>={};let approvals=0;
  const store:any={read:()=>structuredClone(state),getCipher:(key:string)=>ciphers[key],updateWithCiphers:(update:(value:any)=>void,encrypted:Record<string,string>)=>{update(state);Object.assign(ciphers,encrypted)}};
  const vault:any={encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'enc:'+Buffer.from(value).toString('base64url')]))};
  const persistence=createAgentNotepadPublicationPersistence(store,vault,{taskId,siteId,assertSubmissionAuthorized:()=>{approvals++;return true},now:()=>new Date(createdAt)});
  if(checkpoint==='agentnotepad_account_ready'){
   await persistence.persistIntent(intent);assert.equal(state.tasks[0].checkpoint,'agentnotepad_publish_submitting');assert.equal(state.tasks[0].submittedAt,createdAt);assert.ok(ciphers['publication:'+taskId].startsWith('enc:'));assert.equal(persistence.assertReadyToSubmit(intent),true);assert.equal(approvals,2);await assert.rejects(()=>persistence.persistIntent(intent));
  }else{await assert.rejects(()=>persistence.persistIntent(intent));assert.equal(state.tasks[0].checkpoint,checkpoint);assert.deepEqual(ciphers,{});assert.equal(approvals,0)}
 }
});


test('registration accepts provider agentId without accepting conflicting identities',()=>{
 const fields={name:'Synthetic research agent',slug:'synthetic-research-agent',apiKey:'synthetic_key_0123456789abcdef'};
 for(const identity of [{agentId:'agent_synthetic123'},{id:'agent_synthetic123'},{agentId:'agent_synthetic123',id:'agent_synthetic123'}])assert.equal(parseAgentNotepadRegistration({data:{...fields,...identity}})?.agent.id,'agent_synthetic123');
 for(const identity of [{agentId:'agent_synthetic123',id:'agent_other123'},{agentId:''},{agentId:null},{agentId:9}])assert.equal(parseAgentNotepadRegistration({data:{...fields,...identity}}),undefined);
 assert.equal(parseAgentNotepadRegistration({data:{...fields,agentId:'agent_synthetic123',apiKey:'short'}}),undefined);
});

test('minimal publication receipts are exact and bind the same id revision and slug on GET',()=>{
 const receipt={data:{id:'resource_synthetic123',revisionId:'revision_synthetic123',slug:'synthetic-note',status:'published'}};
 const parsed=parseAgentNotepadPublishReceipt(receipt);assert.deepEqual(parsed,receipt.data);
 for(const changed of [{...receipt.data,status:'draft'},{...receipt.data,extra:true},{...receipt.data,id:9},{...receipt.data,revisionId:'short'},{...receipt.data,slug:'Bad Slug'}])assert.equal(parseAgentNotepadPublishReceipt({data:changed}),undefined);
 const resource={id:receipt.data.id,kind:'note',title:'A note',body:'Useful [target](https://example.com/tool).',topic:'engineering',authorId:'agent_12345678',revisionId:receipt.data.revisionId,canonicalUrl:'https://agentnotepad.com/notebooks/synthetic-note',revisionUrl:'https://agentnotepad.com/notebooks/synthetic-note?revision=revision_synthetic123',citations:[]};
 assert.deepEqual(parseAgentNotepadReceiptBoundResource({data:{...resource,slug:receipt.data.slug}},parsed!),resource);
 for(const changed of [{...resource,slug:'other-note'},{...resource,slug:receipt.data.slug,id:'resource_other123'},{...resource,slug:receipt.data.slug,revisionId:'revision_other123'}])assert.equal(parseAgentNotepadReceiptBoundResource({data:changed},parsed!),undefined);
});

test('real nested resource envelope binds both authors revision URLs and citation values',()=>{
 const receipt=parseAgentNotepadPublishReceipt({data:{id:'resource_synthetic123',revisionId:'revision_synthetic123',slug:'note-synthetic-owner',status:'published'}})!;
 const nested={id:receipt.id,kind:'note',title:'Synthetic ownership note',topic:'engineering',slug:receipt.slug,author:{id:'agent_synthetic123'},revisionId:receipt.revisionId,revision:{id:receipt.revisionId,author:{id:'agent_synthetic123'},body:'Synthetic exact body.',citations:[{title:'First',url:'https://example.com/one'},{title:'Second',url:'https://example.com/two'}],status:'published'},canonicalUrl:`https://agentnotepad.com/notebooks/${receipt.slug}`,revisionUrl:`https://agentnotepad.com/notebooks/${receipt.slug}?revision=${receipt.revisionId}`};
 const parsed=parseAgentNotepadReceiptBoundResource({data:nested},receipt);assert.ok(parsed);assert.deepEqual(parsed.citations,[{title:'First',url:'https://example.com/one'},{title:'Second',url:'https://example.com/two'}]);
 for(const change of [
  {author:{id:'agent_other123'}},
  {revision:{...nested.revision,id:'revision_other123'}},
  {revision:{...nested.revision,author:{id:'agent_other123'}}},
  {revision:{...nested.revision,status:'draft'}},
  {revisionUrl:`${nested.canonicalUrl}?revision=revision_other123`},
  {canonicalUrl:`${nested.canonicalUrl}/other`},
  {authorId:'agent_other123'},
  {body:'conflicting flat body'},
  {citations:[{url:'https://example.com/other',title:'First'}]},
 ])assert.equal(parseAgentNotepadReceiptBoundResource({data:{...nested,...change}},receipt),undefined);
});

function recoveryFixture(){
 const now='2026-10-16T00:00:00.000Z',targetUrl='https://example.com/tool',title='A note',body=`Useful [target](${targetUrl}).`,citations=[{url:'https://example.com/source',title:'source'}],accountId='00000000-0000-4000-8000-000000000003',agentId='agent_12345678',taskId='00000000-0000-4000-8000-000000000001',idempotencyKey='agentnotepad_publish_0123456789abcdef0123456789abcdef',request=agentNotepadPublishRequest(title,body,citations,idempotencyKey),intent:AgentNotepadPublicationIntent={version:1,kind:'agentnotepad_publication',operationId:idempotencyKey,idempotencyKey,accountId,agentId,requestHash:request.requestHash,sourceHash:request.sourceHash,citationsHash:request.citationsHash,createdAt:now},minimal={data:{id:'resource_synthetic123',revisionId:'revision_synthetic123',slug:'synthetic-note',status:'published'}},raw=Buffer.from(JSON.stringify(minimal)),opaque={version:1 as const,capturedAt:now,requestUrl:AGENTNOTEPAD_PUBLISH_URL,status:200,contentType:'application/json',responseUrl:AGENTNOTEPAD_PUBLISH_URL,redirected:false,responseType:'basic',headers:[['content-type','application/json']] as Array<[string,string]>,bodyBase64:raw.toString('base64'),bodySha256:agentNotepadHash(raw),bodyComplete:true},record={...intent,opaqueResponse:opaque},resource:AgentNotepadResource={id:minimal.data.id,kind:'note',title,body,topic:'engineering',authorId:agentId,revisionId:minimal.data.revisionId,canonicalUrl:'https://agentnotepad.com/notebooks/synthetic-note',revisionUrl:'https://agentnotepad.com/notebooks/synthetic-note?revision=revision_synthetic123',citations},site:Site={id:'site',domain:'example.com',url:targetUrl,email:'',name:'Example',description:'Example',category:'developer',language:'en',monthlyTarget:1,status:'ready',createdAt:now},channel:Channel={id:'agentnotepad',name:'Agent Notepad',domain:'agentnotepad.com',url:'https://agentnotepad.com',submitUrl:AGENTNOTEPAD_PUBLISH_URL,categories:['developer'],languages:['*'],kind:'article',emailRequired:false,accountRequired:true,articleRequired:true,free:'yes',freeNote:'',automation:'api',quality:'B',qualityReason:'',rulesUrl:'https://agentnotepad.com/for-agents',checkedAt:'2026-10-16',notes:'',allowedHosts:['agentnotepad.com'],enabled:true},task:Task={id:taskId,siteId:'site',channelId:'agentnotepad',accountId,sourceDomain:'agentnotepad.com',status:'review',createdAt:now,updatedAt:now,scheduledAt:now,attempts:1,message:'',topicUrl:targetUrl,draft:{title,description:'',body},articleApprovedAt:now,agentNotepad:{operationId:intent.operationId,accountId,agentId,idempotencyKey,sourceHash:intent.sourceHash,citationsHash:intent.citationsHash,requestHash:intent.requestHash,createdAt:now,stage:'opaque_response'}},account:Account={id:accountId,channelId:'agentnotepad',email:'',username:'agent',displayName:'Agent',createdAt:now,status:'registered',hasPassword:true,source:'generated',credentialKind:'api_token',registrationAttempts:1,agentNotepad:{version:1,stage:'ready',operationId:'agentnotepad_register_0123456789abcdef0123456789abcdef',requestHash:'a'.repeat(64),agentId,agentName:'Agent',agentSlug:'agent',keyFingerprint:agentNotepadHash('synthetic_api_key_0123456789')}};
 const calls:string[]=[],deps={citations,fetch:async(url:string,init:RequestInit)=>{calls.push(`${init.method} ${url}`);if(url.endsWith('/history'))return json({data:{items:[{revisionId:resource.revisionId}]}});if(url.endsWith('/robots.txt'))return new Response('User-agent: *\nAllow: /',{status:200});if(url.endsWith('/'+resource.id))return json({data:{id:resource.id,kind:resource.kind,title:resource.title,topic:resource.topic,slug:minimal.data.slug,author:{id:agentId},revisionId:resource.revisionId,revision:{id:resource.revisionId,author:{id:agentId},body:resource.body,citations:resource.citations.map(value=>({title:value.title,url:value.url})),status:'published'},canonicalUrl:resource.canonicalUrl,revisionUrl:resource.revisionUrl}});throw Error('unbound route')},renderPage:async(url:string)=>({url,documentTitle:title,heading:title,articleText:'Useful target.',articleHtml:'',allTextVisible:true,links:[{href:targetUrl,rel:['nofollow','ugc'],text:'target',visible:true}],robots:[],responseRobots:[],responseLinks:[],canonicals:[url],hasRefresh:false,hasPasswordGate:false,hasLoginGate:false,responseStatus:200,responseMediaType:'text/html',responseBodyBytes:100,responseEncodedBodyBytes:100,nativeRequests:[{url,method:'GET' as const,resourceType:'mainFrame' as const}]})};
 let promoted=0;const persistence={persistIntent:async()=>{throw Error('must not persist')},assertReadyToSubmit:()=>{throw Error('must not submit')},persistOpaqueResponse:async()=>{throw Error('must not submit')},loadIntent:async()=>record,promoteResource:async(value:AgentNotepadResource)=>{assert.deepEqual(value,resource);promoted++}};
 const registration={version:1,kind:'agentnotepad_registration',operationId:account.agentNotepad!.operationId,requestHash:account.agentNotepad!.requestHash,createdAt:now,capabilities:['research'],topics:['engineering'],apiKey:'synthetic_api_key_0123456789',agent:{id:agentId,name:'Agent',slug:'agent'}};
 const context:ExecutionContext={site,channel,task,settings:defaultSettings(),signal:new AbortController().signal,ai:{json:async<T>()=>({} as T)},secrets:{get:async key=>key===`account:${accountId}`?JSON.stringify(registration):undefined,set:async()=>{},delete:async()=>{}},getAccount:()=>account,saveAccount:async()=>{},checkpoint:()=>{},log:()=>{},agentNotepadPersistence:persistence as any};
 return {context,deps,calls,promoted:()=>promoted,record,resource,minimal};
}

test('normal and reconcile paths recover an exact minimal receipt by GET without another POST',async()=>{
 for(const mode of ['run','reconcile'] as const){const f=recoveryFixture(),result=mode==='run'?await runAgentNotepadTask(f.context,f.deps):await reconcileAgentNotepadTask(f.context,f.deps);assert.equal(result.status,mode==='run'?'live':'found');assert.equal(f.calls.some(value=>value.startsWith('POST ')),false);assert.equal(f.calls[0],`GET https://agentnotepad.com/api/v1/resources/${f.resource.id}`);assert.equal(f.calls.some(value=>value.includes('?kind=note')),false);if(mode==='run')assert.equal(f.promoted(),1)}
});

test('a conflicting minimal receipt readback fails closed without list fallback or POST',async()=>{
 for(const conflict of [{revisionId:'revision_other123'},{slug:'other-note'},{id:'resource_other123'}]){const f=recoveryFixture(),baseFetch=f.deps.fetch;f.deps.fetch=async(url:string,init:RequestInit)=>url.endsWith('/'+f.resource.id)?json({data:{...f.resource,slug:f.minimal.data.slug,...conflict}}):baseFetch(url,init);const result=await reconcileAgentNotepadTask(f.context,f.deps);assert.deepEqual(result,{status:'unknown'});assert.equal(f.calls.some(value=>value.includes('?kind=note')||value.startsWith('POST ')),false)}
});
