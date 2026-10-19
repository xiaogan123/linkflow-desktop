import {beforeEach,type TestContext} from 'node:test';
beforeEach(t=>{if(["normal Controller performs the single authenticated create and exact public verification"].includes(t.name))(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse(now)+60000});});
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CHANNELS} from '../src/integrations/catalog';
import {inspectHereNowIdentity} from '../src/integrations/here-now-account';
import {hereNowPublisherTesting,reconcileHereNowTask,runHereNowTask} from '../src/integrations/here-now-publisher';
import {createHereNowSite,fetchHereNowBounded,finalizeHereNowSite,hereNowRequest,hereNowSha256,parseHereNowCreateResponse,uploadHereNowSite,HERE_NOW_CREATE_URL,HERE_NOW_ORIGIN,type HereNowIntent,type HereNowOpaqueResponse,type HereNowPersistence} from '../src/integrations/here-now';
import {Controller} from '../src/main/controller';
import {validateBackup} from '../src/main/backup-validation';
import {hereNowStoredReceipt,hereNowTaskIdentity} from '../src/main/here-now-publication';
import {connectHereNow} from '../src/main/here-now-management';
import {Store,emptyState} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import type {Account,ExecutionContext,Site,Task} from '../src/shared/types';
import {periodicFixtureCheck} from './helpers/periodic-link-check';

const now='2026-10-11T12:00:00.000Z';
const accountId='11111111-2222-4333-8444-555555555555';
const apiKey=`hnk_${'A'.repeat(32)}`;
const slug='owned-guide';
const siteUrl=`https://${slug}.here.now/`;
const uploadUrl='https://bucket.r2.cloudflarestorage.com/object?signature=test';
const html='<!doctype html><html><head><meta name="robots" content="index, follow"></head><body><article><h1>Recovery guide</h1><section><p>Check the original receipt before retrying.</p></section></article></body></html>';

function response(url:string,body:string,status=200,contentType='application/json'){
  const value=new Response(body,{status,headers:{'content-type':contentType}});
  Object.defineProperty(value,'url',{value:url});
  Object.defineProperty(value,'redirected',{value:false});
  return value;
}
function createBody(overrides:Record<string,unknown>={}){
  return {slug,siteUrl,isLive:false,requiresFinalize:true,publishStatus:{requestAuth:'api_key',ownership:'personal',accountId,persistence:'permanent',expiresAt:null,state:'pending'},upload:{versionId:'version-1',uploads:[{path:'index.html',method:'PUT',url:uploadUrl,headers:{'content-type':'text/html; charset=utf-8'}}],skipped:[],finalizeUrl:`${HERE_NOW_ORIGIN}/api/v1/publish/${slug}/finalize`,expiresInSeconds:900},...overrides};
}
function memory(){
  let intent:HereNowIntent|undefined,opaque:HereNowOpaqueResponse|undefined;
  const stages:string[]=[];
  const value:HereNowPersistence={
    async persistIntent(next){if(intent)throw Error('duplicate intent');intent=next},
    assertWriteAuthorized(next){assert.ok(intent);assert.deepEqual({operationId:next.operationId,accountId:next.accountId,remoteAccountId:next.remoteAccountId,sourceHash:next.sourceHash,requestHash:next.requestHash,createdAt:next.createdAt},intent);return true},
    async persistOpaque(next){opaque=next},
    async loadOpaque(){return opaque},
    async markStage(_receipt,stage){stages.push(stage)},
    async markCreateUnknown(){stages.push('create_unknown')},
  };
  return {value,stages,intent:()=>intent,opaque:()=>opaque};
}

test('request binds exact full HTML and explicitly requests permanent authenticated storage',()=>{
  const request=hereNowRequest(html,'Recovery guide','A bounded publication recovery guide');
  const body=JSON.parse(request.body);
  assert.equal(body.ttlSeconds,null);
  assert.deepEqual(body.files,[{path:'index.html',size:Buffer.byteLength(html),contentType:'text/html; charset=utf-8',hash:request.sourceHash}]);
  assert.equal(request.requestHash.length,64);
});

test('one create, signed upload and finalize retain one version and exact authorization boundaries',async()=>{
  const store=memory(),calls:Array<{url:string;method:string;authorization?:string;body?:string}>=[];
  const fetch=async(url:string,init:RequestInit)=>{
    const headers=init.headers as Record<string,string>;
    calls.push({url,method:String(init.method),authorization:headers.authorization,body:typeof init.body==='string'?init.body:undefined});
    if(url===HERE_NOW_CREATE_URL)return response(url,JSON.stringify(createBody()));
    if(url===uploadUrl)return response(url,'ok',200,'text/plain');
    const receipt=(await store.value.loadOpaque())!;
    assert.ok(receipt);
    return response(url,JSON.stringify({success:true,slug,siteUrl,currentVersionId:'version-1',publishStatus:{requestAuth:'api_key',ownership:'personal',accountId,persistence:'permanent',expiresAt:null,state:'live'},warnings:[]}));
  };
  const created=await createHereNowSite({operationId:'here_now_11111111111141118111111111111111',accountId,remoteAccountId:accountId,apiKey,html,title:'Recovery guide',description:'A bounded publication recovery guide'},store.value,{now:()=>new Date(now),fetch});
  assert.equal(created.status,'created',JSON.stringify(created));if(created.status!=='created')return;
  assert.equal(await uploadHereNowSite(created.receipt,html,store.value,{now:()=>new Date(now),fetch}),'uploaded');
  assert.equal(await finalizeHereNowSite(created.receipt,apiKey,store.value,{now:()=>new Date(now),fetch}),'finalized');
  assert.deepEqual(store.stages,['staged','uploaded','api_receipt']);
  assert.deepEqual(calls.map(item=>[item.method,item.url]),[['POST',HERE_NOW_CREATE_URL],['PUT',uploadUrl],['POST',`${HERE_NOW_ORIGIN}/api/v1/publish/${slug}/finalize`]]);
  assert.equal(calls[0].authorization,`Bearer ${apiKey}`);
  assert.equal(calls[1].authorization,undefined);
  assert.equal(JSON.parse(calls[2].body!).versionId,'version-1');
});

test('strict create receipt rejects anonymous/temporary ownership and unsafe signed upload metadata',async t=>{
  const request=hereNowRequest(html,'Recovery guide','Description'),intent:HereNowIntent={operationId:'here_now_11111111111141118111111111111111',accountId,remoteAccountId:accountId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:now};
  const parse=(value:unknown)=>{const bytes=Buffer.from(JSON.stringify(value));return parseHereNowCreateResponse({...intent,kind:'here_now_create_response',version:1,status:200,contentType:'application/json',responseUrl:HERE_NOW_CREATE_URL,redirected:false,bodyBase64:bytes.toString('base64'),bodySha256:hereNowSha256(bytes)},intent,new Date(now))};
  const cases:Array<[string,unknown]>=[
    ['anonymous',{...createBody(),anonymous:true}],
    ['temporary',{...createBody(),expiresAt:'2026-10-12T12:00:00.000Z'}],
    ['workspace',{...createBody(),publishStatus:{...(createBody().publishStatus as object),ownership:'workspace'}}],
    ['foreign upload',{...createBody(),upload:{...(createBody().upload as object),uploads:[{path:'index.html',method:'PUT',url:'https://evil.example/upload?signature=x',headers:{}}]}}],
    ['credential header',{...createBody(),upload:{...(createBody().upload as object),uploads:[{path:'index.html',method:'PUT',url:uploadUrl,headers:{authorization:'secret'}}]}}],
    ['long deadline',{...createBody(),upload:{...(createBody().upload as object),expiresInSeconds:7200}}],
    ['claim fields',{...createBody(),claimToken:'anonymous-only'}],
  ];
  for(const [name,value] of cases)await t.test(name,()=>assert.deepEqual(parse(value),{diagnostic:'schema'}));
});

test('opaque response hash mismatch is rejected before JSON interpretation',()=>{
  const request=hereNowRequest(html,'Recovery guide','Description'),intent:HereNowIntent={operationId:'here_now_11111111111141118111111111111111',accountId,remoteAccountId:accountId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:now},bytes=Buffer.from(JSON.stringify(createBody()));
  assert.deepEqual(parseHereNowCreateResponse({...intent,kind:'here_now_create_response',version:1,status:200,contentType:'application/json',responseUrl:HERE_NOW_CREATE_URL,redirected:false,bodyBase64:bytes.toString('base64'),bodySha256:'a'.repeat(64)},intent,new Date(now)),{diagnostic:'decode'});
});

test('deadline bounds a response whose headers arrive but body stream never completes',async()=>{
  const store=memory(),started=Date.now(),hanging=new ReadableStream<Uint8Array>({pull(){return new Promise(()=>undefined)}}),value=new Response(hanging,{status:200,headers:{'content-type':'application/json'}});Object.defineProperty(value,'url',{value:HERE_NOW_CREATE_URL});Object.defineProperty(value,'redirected',{value:false});
  const result=await createHereNowSite({operationId:'here_now_11111111111141118111111111111111',accountId,remoteAccountId:accountId,apiKey,html,title:'Recovery guide',description:'Description'},store.value,{now:()=>new Date(now),timeoutMs:100,fetch:async()=>value});
  assert.equal(result.status,'unknown');assert.ok(Date.now()-started<1000);assert.deepEqual(store.stages,['create_unknown']);
});

test('robots parser applies only the wildcard group and rejects wildcard root exclusion',()=>{
  assert.equal(hereNowPublisherTesting.robotsAllows('User-agent: crawler\nDisallow: /\nUser-agent: *\nDisallow:'),true);
  assert.equal(hereNowPublisherTesting.robotsAllows('User-agent: crawler\nDisallow:\nUser-agent: *\nDisallow: / # whole site'),false);
  assert.equal(hereNowPublisherTesting.robotsAllows('User-agent: *\nDisallow: /$'),false);
  assert.equal(hereNowPublisherTesting.robotsAllows('User-agent: *\nDisallow: /*$'),false);
});

test('authenticated create accepts omitted anonymous-only fields while rejecting contradictions',()=>{
  const request=hereNowRequest(html,'Recovery guide','Description'),intent:HereNowIntent={operationId:'here_now_11111111111141118111111111111111',accountId,remoteAccountId:accountId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:now},bytes=Buffer.from(JSON.stringify(createBody())),opaque:HereNowOpaqueResponse={...intent,kind:'here_now_create_response',version:1,status:200,contentType:'application/json',responseUrl:HERE_NOW_CREATE_URL,redirected:false,bodyBase64:bytes.toString('base64'),bodySha256:hereNowSha256(bytes)};
  assert.ok(!('diagnostic' in parseHereNowCreateResponse(opaque,intent,new Date(now))));
});

test('authenticated create accepts an omitted upload skipped field but rejects every present non-empty or non-array value',()=>{
  const request=hereNowRequest(html,'Recovery guide','Description'),intent:HereNowIntent={operationId:'here_now_11111111111141118111111111111111',accountId,remoteAccountId:accountId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:now};
  const parse=(skipped:'omit'|unknown)=>{const body=createBody(),upload=body.upload as Record<string,unknown>;if(skipped==='omit')delete upload.skipped;else upload.skipped=skipped;const bytes=Buffer.from(JSON.stringify(body)),opaque:HereNowOpaqueResponse={...intent,kind:'here_now_create_response',version:1,status:200,contentType:'application/json',responseUrl:HERE_NOW_CREATE_URL,redirected:false,bodyBase64:bytes.toString('base64'),bodySha256:hereNowSha256(bytes)};return parseHereNowCreateResponse(opaque,intent,new Date(now))};
  const omitted=parse('omit'),empty=parse([]);assert.ok(!('diagnostic' in omitted));assert.ok(!('diagnostic' in empty));
  for(const invalid of [null,false,'',{},['index.html']])assert.deepEqual(parse(invalid),{diagnostic:'schema'});
});

test('durable receipt remains parseable after upload TTL while fresh write authorization expires',async()=>{
  const request=hereNowRequest(html,'Recovery guide','Description'),intent:HereNowIntent={operationId:'here_now_11111111111141118111111111111111',accountId,remoteAccountId:accountId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:now},bytes=Buffer.from(JSON.stringify(createBody())),opaque:HereNowOpaqueResponse={...intent,kind:'here_now_create_response',version:1,status:200,contentType:'application/json',responseUrl:HERE_NOW_CREATE_URL,redirected:false,bodyBase64:bytes.toString('base64'),bodySha256:hereNowSha256(bytes)},future=new Date(Date.parse(now)+7200_000),task={hereNow:{...intent,slug,versionId:'version-1',stage:'api_receipt'}} as Task,persistence={loadOpaque:async()=>opaque} as HereNowPersistence;
  assert.ok(await hereNowStoredReceipt(task,persistence,future));
  assert.deepEqual(parseHereNowCreateResponse(opaque,intent,future,true),{diagnostic:'expired'});
});

test('bounded transport cancels declared and streamed oversized bodies',async()=>{
  for(const declared of [true,false]){let cancelled=false;const stream=new ReadableStream<Uint8Array>({start(controller){if(!declared)controller.enqueue(new Uint8Array(9))},cancel(){cancelled=true}}),value=new Response(stream,{headers:declared?{'content-length':'9'}:{}});await assert.rejects(()=>fetchHereNowBounded(HERE_NOW_CREATE_URL,{method:'GET'},{fetch:async()=>value},8));await new Promise(resolve=>setTimeout(resolve,0));assert.equal(cancelled,true)}
});

test('public verification permits only known here.now social head metadata and keeps body exact',()=>{
  const expected='<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Recovery guide</title><meta name="description" content="Description"></head><body><article><section><p>Exact body</p></section></article></body></html>',social=`<meta property="og:title" content="Recovery guide"><meta property="og:description" content="Description"><meta property="og:url" content="${siteUrl}"><meta property="og:type" content="website"><meta property="og:image" content="https://here.now/og/${slug}.jpg"><meta property="og:image:width" content="1280"><meta property="og:image:height" content="720"><meta name="twitter:image" content="https://here.now/og/${slug}.jpg"><meta name="twitter:card" content="summary_large_image">`,actual=expected.replace('</head>',`${social}</head>`);
  assert.equal(hereNowPublisherTesting.exactPublicHtmlWithHereNowHead(actual,expected,siteUrl),true);
  assert.equal(hereNowPublisherTesting.exactPublicHtmlWithHereNowHead(expected.replace('</head>',`${social.replaceAll('><','>\n<')}\n</head>`),expected,siteUrl),true);
  assert.equal(hereNowPublisherTesting.exactPublicHtmlWithHereNowHead(actual.replace('Exact body','Changed body'),expected,siteUrl),false);
  assert.equal(hereNowPublisherTesting.exactPublicHtmlWithHereNowHead(expected.replace('</head>','<meta property="og:locale" content="en"></head>'),expected,siteUrl),false);
  assert.equal(hereNowPublisherTesting.exactPublicHtmlWithHereNowHead(`${actual}<script>location.href="https://different.example/"</script>`,expected,siteUrl),false);
  const longTitle='T'.repeat(100),longDescription='D'.repeat(300),longExpected=`<!doctype html><html><head><title>${longTitle}</title><meta name="description" content="${longDescription}"></head><body><p>Exact</p></body></html>`,longActual=longExpected.replace('</head>',`<meta property="og:title" content="${longTitle.slice(0,80)}">\n<meta property="og:description" content="${longDescription.slice(0,280)}">\n</head>`);
  assert.equal(hereNowPublisherTesting.exactPublicHtmlWithHereNowHead(longActual,longExpected,siteUrl),true);
  const punctuatedExpected=expected.replaceAll('Recovery guide','Recovery，guide'),ownerTitle='Recovery guide',ownerSocial=social.replaceAll('Recovery guide',ownerTitle),ownerActual=punctuatedExpected.replace('</head>',`${ownerSocial}</head>`);
  assert.equal(hereNowPublisherTesting.exactPublicHtmlWithHereNowHead(ownerActual,punctuatedExpected,siteUrl),false);
  assert.equal(hereNowPublisherTesting.exactPublicHtmlWithHereNowHead(ownerActual,punctuatedExpected,siteUrl,ownerTitle),true);
  assert.equal(hereNowPublisherTesting.exactPublicHtmlWithHereNowHead(ownerActual,punctuatedExpected,siteUrl,'Different owner title'),false);
  assert.equal(hereNowPublisherTesting.exactPublicHtmlWithHereNowHead(ownerActual.replace('Exact body','Changed body'),punctuatedExpected,siteUrl,ownerTitle),false);
  assert.equal(hereNowPublisherTesting.exactPublicHtmlWithHereNowHead(ownerActual.replace('<title>Recovery，guide</title>','<title>Recovery guide</title>'),punctuatedExpected,siteUrl,ownerTitle),false);
});

test('ordinary continuation writes only after the exact pending owner version',async t=>{
  const site={id:'22222222-2222-4222-8222-222222222222',url:'https://example.com/',language:'en',status:'ready'} as Site,channel=CHANNELS.find(value=>value.id==='here-now')!,account={id:accountId,channelId:'here-now',email:'owner@example.test',username:accountId,credentialKind:'api_token',status:'registered',hasPassword:true,source:'imported',createdAt:now,hereNow:{version:1,checkedAt:now,accountId,keyFingerprint:hereNowSha256(apiKey),identity:'verified_personal'}} as Account;
  for(const ownerCase of ['wrong-version','wrong-status','unavailable','pending'] as const)await t.test(ownerCase,async()=>{
    const task={id:'11111111-1111-4111-8111-111111111111',siteId:site.id,channelId:'here-now',sourceDomain:'here.now',accountId,status:'review',health:'pending',createdAt:now,updatedAt:now,attempts:0,draft:{title:'Recovery guide',description:'A guide',body:'# Guide\n\nCheck the [release](https://example.com/releases).'},topicUrl:'https://example.com/releases'} as Task,identity=hereNowTaskIdentity(task,site)!;
    const intent:HereNowIntent={operationId:'here_now_11111111111141118111111111111111',accountId,remoteAccountId:accountId,sourceHash:identity.sourceHash,requestHash:identity.requestHash,createdAt:now},body=createBody(),bytes=Buffer.from(JSON.stringify(body)),opaque:HereNowOpaqueResponse={...intent,kind:'here_now_create_response',version:1,status:200,contentType:'application/json',responseUrl:HERE_NOW_CREATE_URL,redirected:false,bodyBase64:bytes.toString('base64'),bodySha256:hereNowSha256(bytes)},stages:string[]=[];
    task.hereNow={...intent,slug,versionId:'version-1',stage:'opaque_response'};task.submittedAt=now;task.checkpoint='here_now_opaque_response';
    const persistence={loadOpaque:async()=>opaque,assertWriteAuthorized:()=>true,markStage:async(_receipt:unknown,stage:string)=>{stages.push(stage)}} as unknown as HereNowPersistence,methods:string[]=[];
    const fetch=async(url:string,init:RequestInit)=>{const method=String(init.method??'GET');methods.push(method);if(url===`${HERE_NOW_ORIGIN}/api/v1/publish/${slug}`){if(ownerCase==='unavailable')return response(url,'{}',503);const pendingVersionId=ownerCase==='wrong-version'?'wrong-version':'version-1',status=ownerCase==='wrong-status'?'disabled':'pending';return response(url,JSON.stringify({slug,siteUrl,status,expiresAt:null,currentVersionId:null,pendingVersionId,manifest:[]}))}if(url===uploadUrl)return response(url,'',200,'text/plain');if(url===`${HERE_NOW_ORIGIN}/api/v1/publish/${slug}/finalize`)return response(url,JSON.stringify({success:true,slug,siteUrl,currentVersionId:'version-1',publishStatus:{requestAuth:'api_key',ownership:'personal',accountId,persistence:'permanent',expiresAt:null,state:'live'},warnings:[]}));throw Error(`unexpected ${method} ${url}`)};
    const context={site,channel,task,settings:{},secrets:{get:async()=>apiKey},ai:{},signal:new AbortController().signal,hereNowPersistence:persistence,getAccount:()=>account,saveAccount:async()=>{},checkpoint:()=>{},log:()=>{}} as unknown as ExecutionContext,result=await runHereNowTask(context,{now:()=>new Date(now),fetch});
    const writes=methods.filter(method=>method==='PUT'||method==='POST');
    if(ownerCase==='pending'){assert.deepEqual(methods,['GET','PUT','POST']);assert.equal(result.checkpoint,'here_now_api_receipt');assert.deepEqual(stages,['uploaded','api_receipt'])}
    else{assert.deepEqual(methods,['GET']);assert.deepEqual(writes,[]);assert.equal(result.hereNow?.stage,'opaque_response');assert.deepEqual(stages,[])}
  })
});

test('public acceptance binds a provider social title exception to authenticated owner metadata',async()=>{
  const target='https://example.com/releases',site={url:'https://example.com/',language:'zh-CN'} as Site,task={id:'11111111-1111-4111-8111-111111111111',accountId,channelId:'here-now',sourceDomain:'here.now',topicUrl:target,publicUrl:siteUrl,draft:{title:'Recovery，guide',description:'A guide',body:`# Guide\n\nCheck the [release](${target}).`}} as Task,identity=hereNowTaskIdentity(task,site)!;
  task.hereNow={operationId:'here_now_11111111111141118111111111111111',accountId,remoteAccountId:accountId,sourceHash:identity.sourceHash,requestHash:identity.requestHash,createdAt:now,slug,versionId:'version-1',stage:'api_receipt'};
  const ownerTitle='Recovery guide',social=`<meta property="og:title" content="${ownerTitle}"><meta property="og:description" content="A guide"><meta property="og:url" content="${siteUrl}"><meta property="og:type" content="website"><meta property="og:image" content="https://here.now/og/${slug}.jpg"><meta property="og:image:width" content="1280"><meta property="og:image:height" content="720"><meta name="twitter:image" content="https://here.now/og/${slug}.jpg"><meta name="twitter:card" content="summary_large_image">`,publicHtml=identity.html.replace('</head>',`${social}</head>`);
  const run=(displayName:string)=>hereNowPublisherTesting.accepted(task,{site},target,apiKey,{fetch:async url=>{if(url===`${HERE_NOW_ORIGIN}/api/v1/publish/${slug}`)return response(url,JSON.stringify({slug,siteUrl,status:'active',expiresAt:null,currentVersionId:'version-1',pendingVersionId:null,displayName,manifest:[{path:'index.html',hash:identity.sourceHash}]}));if(url===`${siteUrl}robots.txt`)return response(url,'',404,'text/plain');if(url===siteUrl)return response(url,publicHtml,200,'text/html; charset=utf-8');throw Error(`unexpected ${url}`)}});
  assert.equal((await run(ownerTitle)).status,'found');
  assert.equal((await run('Different owner title')).status,'invalid');
});

test('Controller reconciliation is GET-only when a staged receipt is not live',async()=>{
  const site={url:'https://example.com/',language:'en'} as Site,task={id:'11111111-1111-4111-8111-111111111111',accountId,channelId:'here-now',sourceDomain:'here.now',topicUrl:'https://example.com/releases',draft:{title:'Safe publication recovery',description:'A guide',body:'# Guide\n\nCheck the [release](https://example.com/releases).'}} as Task,identity=hereNowTaskIdentity(task,site)!;const intent:HereNowIntent={operationId:'here_now_11111111111141118111111111111111',accountId,remoteAccountId:accountId,sourceHash:identity.sourceHash,requestHash:identity.requestHash,createdAt:now},bytes=Buffer.from(JSON.stringify(createBody())),opaque:HereNowOpaqueResponse={...intent,kind:'here_now_create_response',version:1,status:200,contentType:'application/json',responseUrl:HERE_NOW_CREATE_URL,redirected:false,bodyBase64:bytes.toString('base64'),bodySha256:hereNowSha256(bytes)};task.hereNow={...intent,slug,versionId:'version-1',stage:'staged'};task.submittedAt=now;const methods:string[]=[],account={id:accountId,channelId:'here-now',username:accountId,email:'owner@example.test',credentialKind:'api_token',status:'registered',hasPassword:true,source:'imported',createdAt:now,hereNow:{version:1,checkedAt:now,accountId,keyFingerprint:hereNowSha256(apiKey),identity:'verified_personal'}} as Account,context={task,site,channel:CHANNELS.find(value=>value.id==='here-now'),getAccount:()=>account,secrets:{get:async()=>apiKey},hereNowPersistence:{loadOpaque:async()=>opaque,markStage:async()=>{throw Error('must not promote')}} as unknown as HereNowPersistence,signal:new AbortController().signal} as any;
  const result=await reconcileHereNowTask(context,{now:()=>new Date(now),fetch:async(url,init)=>{methods.push(String(init.method));return response(url,'{}')}});assert.deepEqual(result,{status:'unknown'});assert.deepEqual(methods,['GET']);
});

test('transport-unknown create is durably marked and the same persistence refuses a second POST',async()=>{
  const store=memory();let posts=0;
  const input={operationId:'here_now_11111111111141118111111111111111',accountId,remoteAccountId:accountId,apiKey,html,title:'Recovery guide',description:'Description'};
  const first=await createHereNowSite(input,store.value,{now:()=>new Date(now),fetch:async()=>{posts++;throw Error('timeout')}});
  assert.equal(first.status,'unknown');assert.equal(posts,1);assert.deepEqual(store.stages,['create_unknown']);
  await assert.rejects(()=>createHereNowSite(input,store.value,{now:()=>new Date(now),fetch:async()=>{posts++;throw Error('must not run')}}),/duplicate intent/);
  assert.equal(posts,1);
});

test('identity adoption uses GET only and binds stable verified personal account plus exact owned permanent page',async()=>{
  const methods:string[]=[],existing=`https://${slug}.here.now/`;
  const identity=await inspectHereNowIdentity(apiKey,existing,{fetch:async(url,init)=>{
    methods.push(String(init.method));
    if(url.endsWith('/me/email-change'))return response(url,JSON.stringify({email:'Owner@Example.test',pending:null}));
    if(url.endsWith('/accounts'))return response(url,JSON.stringify({accounts:[{accountId,type:'personal',status:'active',provisioningStatus:'active',role:'admin',displayName:'Owner'}]}));
    return response(url,JSON.stringify({slug,siteUrl:existing,status:'active',expiresAt:null,currentVersionId:'version-live',pendingVersionId:null,manifest:[{path:'index.html',hash:'a'.repeat(64)}]}));
  }});
  assert.deepEqual(methods,['GET','GET','GET']);
  assert.equal(identity.email,'owner@example.test');
  assert.equal(identity.accountId,accountId);
  assert.equal(identity.existingSiteUrl,existing);
  assert.equal(identity.keyFingerprint.length,64);
});

test('identity adoption refuses pending email and workspace-only accounts',async t=>{
  const run=(email:unknown,accounts:unknown)=>inspectHereNowIdentity(apiKey,undefined,{fetch:async url=>url.endsWith('/me/email-change')?response(url,JSON.stringify(email)):response(url,JSON.stringify(accounts))});
  await t.test('pending email',()=>assert.rejects(()=>run({email:'owner@example.test',pending:'new@example.test'},{accounts:[{accountId,type:'personal',status:'active',provisioningStatus:'active',role:'admin'}]}),/stable|verified|stable|here\.now/i));
  await t.test('workspace only',()=>assert.rejects(()=>run({email:'owner@example.test',pending:null},{accounts:[{accountId,type:'workspace',status:'active',provisioningStatus:'active',role:'admin'}]}),/personal|here\.now/i));
});

test('existing account management reuses the OS-vault key and preserves its identity and bindings',async()=>{
  const store=new Store(':memory:'),localAccountId='33333333-3333-4333-8333-333333333333',siteId='22222222-2222-4222-8222-222222222222';let encryptions=0,reads=0;
  const existing:Account={id:localAccountId,channelId:'here-now',email:'owner@example.test',username:accountId,displayName:'Owner',credentialKind:'api_token',status:'registered',hasPassword:true,source:'imported',createdAt:now,updatedAt:now,registeredAt:now,verifiedAt:now,hereNow:{version:1,checkedAt:now,accountId,keyFingerprint:hereNowSha256(apiKey),identity:'verified_personal'}};
  store.update(state=>{state.sites=[{id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.test',name:'Example',description:'Example software',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:now}];state.accounts=[existing];state.accountBindings=[{id:'44444444-4444-4444-8444-444444444444',siteId,channelId:'here-now',accountId:localAccountId,createdAt:now,updatedAt:now}]});
  const vault={get:async(key:string)=>{assert.equal(key,`account:${localAccountId}`);return apiKey},encryptSecrets:()=>{encryptions++;return {}}} as Pick<Vault,'get'|'encryptSecrets'>;
  try{
    const saved=await connectHereNow(store,vault,{accountId:localAccountId,siteIds:[siteId]},{fetch:async url=>{reads++;return url.endsWith('/me/email-change')?response(url,JSON.stringify({email:'owner@example.test',pending:null})):response(url,JSON.stringify({accounts:[{accountId,type:'personal',status:'active',provisioningStatus:'active',role:'admin',displayName:'Owner'}]}))}});
    assert.equal(reads,2);assert.equal(encryptions,0);assert.equal(saved.id,localAccountId);assert.equal(saved.hereNow?.keyFingerprint,existing.hereNow?.keyFingerprint);assert.deepEqual(store.read().accountBindings.map(binding=>binding.siteId),[siteId]);
    store.update(state=>state.tasks.push({id:'11111111-1111-4111-8111-111111111111',siteId,channelId:'here-now',accountId:localAccountId,sourceDomain:'here.now',status:'review',submittedAt:now,createdAt:now,scheduledAt:now,updatedAt:now,attempts:1,message:'pending'} as Task));
    const replacement=`hnk_${'B'.repeat(32)}`,before=JSON.stringify(store.read());await assert.rejects(()=>connectHereNow(store,vault,{apiKey:replacement,siteIds:[siteId]},{fetch:async url=>{reads++;return url.endsWith('/me/email-change')?response(url,JSON.stringify({email:'owner@example.test',pending:null})):response(url,JSON.stringify({accounts:[{accountId,type:'personal',status:'active',provisioningStatus:'active',role:'admin',displayName:'Owner'}]}))}}),/待核对/);assert.equal(encryptions,0);assert.equal(JSON.stringify(store.read()),before);assert.equal(reads,4);
  }finally{store.close()}
});

test('normal Controller performs the single authenticated create and exact public verification',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'here-now-controller-')),store=new Store(join(dir,'state.sqlite'));
  const siteId='22222222-2222-4222-8222-222222222222',taskId='11111111-1111-4111-8111-111111111111',localAccountId='33333333-3333-4333-8333-333333333333';
  const site:Site={id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.test',name:'Example software',description:'Developer software',category:'software',language:'en',monthlyTarget:1,articleReviewMode:'manual',qualifications:{software:'https://example.com/product',developer:'https://example.com/releases'},status:'ready',createdAt:now,analyzedAt:now,topicsCheckedAt:now,topics:[{url:'https://example.com/releases',discoveredAt:now}]};
  const draft={title:'Safe publication recovery',description:'A practical guide to uncertain publication results',body:'# Safe publication recovery\n\nCheck the [original release record](https://example.com/releases) before retrying a delayed publication.'};
  const task:Task={id:taskId,siteId,channelId:'here-now',sourceDomain:'here.now',accountId:localAccountId,status:'queued',createdAt:now,scheduledAt:'2026-10-11T11:59:00.000Z',updatedAt:now,attempts:0,message:'fixture',topicUrl:'https://example.com/releases',draft,draftRevision:1,articleApprovedAt:now,health:'pending'};
  const account:Account={id:localAccountId,channelId:'here-now',email:'owner@example.test',username:accountId,displayName:'Owner',credentialKind:'api_token',status:'registered',hasPassword:true,source:'imported',createdAt:now,updatedAt:now,registeredAt:now,verifiedAt:now,hereNow:{version:1,checkedAt:now,accountId,keyFingerprint:hereNowSha256(apiKey),identity:'verified_personal'}};
  const catalog=CHANNELS.map(channel=>({...channel,enabled:channel.id==='here-now'})),plaintext=new Map([[`account:${localAccountId}`,apiKey]]);
  const vault={ready:true,available:()=>true,get:async(key:string)=>plaintext.get(key),set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>{plaintext.set(key,value);return [key,`enc:${Buffer.from(value).toString('base64url')}`]}))} as unknown as Vault;
  const state=emptyState();state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='manual';state.settings.timezone='UTC';state.settings.channelOverrides=Object.fromEntries(catalog.map(channel=>[channel.id,channel.id==='here-now']));state.sites=[site];state.accounts=[account];state.accountBindings=[{id:'44444444-4444-4444-8444-444444444444',siteId,channelId:'here-now',accountId:localAccountId,createdAt:now,updatedAt:now}];state.tasks=[task];
  store.updateWithCiphers(current=>Object.assign(current,state),{[`account:${localAccountId}`]:'enc:key'});
  const identity=hereNowTaskIdentity(task,site);assert.ok(identity);let creates=0,uploads=0,finalizes=0,ownerReads=0,publicReads=0,publicMode:'normal'|'noindex'|'unavailable'='normal',holdOwner:Promise<void>|undefined,ownerEntered:(()=>void)|undefined;
  const hereNowFetch=async(url:string,init:RequestInit)=>{
    if(url===HERE_NOW_CREATE_URL&&init.method==='POST'){creates++;return response(url,JSON.stringify(createBody()))}
    if(url===uploadUrl&&init.method==='PUT'){uploads++;assert.equal(init.body,identity.html);return response(url,'ok',200,'text/plain')}
    if(url===`${HERE_NOW_ORIGIN}/api/v1/publish/${slug}/finalize`&&init.method==='POST'){finalizes++;return response(url,JSON.stringify({success:true,slug,siteUrl,currentVersionId:'version-1',publishStatus:{requestAuth:'api_key',ownership:'personal',accountId,persistence:'permanent',expiresAt:null,state:'live'},warnings:[]}))}
    if(url===`${HERE_NOW_ORIGIN}/api/v1/publish/${slug}`){ownerReads++;ownerEntered?.();if(holdOwner)await holdOwner;return response(url,JSON.stringify({slug,siteUrl,status:ownerReads===1?'pending':'active',expiresAt:null,currentVersionId:ownerReads===1?null:'version-1',pendingVersionId:ownerReads===1?'version-1':null,manifest:ownerReads===1?[]:[{path:'index.html',hash:identity.sourceHash}]}))}
    if(url===`${siteUrl}robots.txt`)return response(url,'',404,'text/html');
    if(url===siteUrl){publicReads++;if(publicMode==='unavailable')return response(url,'temporary',503,'text/html');return response(url,publicMode==='noindex'?identity.html.replace('</head>','<meta name="robots" content="noindex"></head>'):identity.html,200,'text/html; charset=utf-8')}
    throw Error(`unexpected ${init.method} ${url}`);
  };
  const controller=new Controller(store,vault,'isolated',{channelCatalog:catalog,hereNowDependencies:{now:()=>new Date(now),fetch:hereNowFetch},recheckLink:periodicFixtureCheck(hereNowFetch)});
  controller.runtime.aiReady=true;
  try{
    await controller.tick();const saved=store.read().tasks[0],diagnostic=JSON.stringify(saved);
    assert.equal(creates,1,diagnostic);assert.equal(uploads,1,diagnostic);assert.equal(finalizes,1,diagnostic);assert.equal(ownerReads,2,diagnostic);assert.equal(publicReads,1,diagnostic);
    assert.equal(saved.status,'live',diagnostic);assert.equal(saved.hereNow?.stage,'published');assert.equal(saved.checkpoint,'here_now_published');assert.equal(saved.publicUrl,siteUrl);
    assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets:Object.fromEntries(plaintext)}));
    const originalVaultGet=vault.get.bind(vault);let keychainReads=0;vault.get=async()=>{keychainReads++;throw Error('synthetic keychain temporarily locked')};await controller.verify(taskId);vault.get=originalVaultGet;const outerCaught=store.read().tasks[0];assert.equal(outerCaught.status,'live');assert.equal(outerCaught.health,'healthy');assert.equal(outerCaught.linkCheck,'found');assert.equal(keychainReads,0);assert.equal(ownerReads,2);assert.equal(publicReads,2);assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets:Object.fromEntries(plaintext)}));
    publicMode='noindex';await controller.verify(taskId);publicMode='normal';const unknown=store.read().tasks[0],unknownBackup={state:store.read(),secrets:Object.fromEntries(plaintext)};
    assert.equal(unknown.status,'live');assert.equal(unknown.hereNow?.stage,'published');assert.equal(unknown.health,'unknown');assert.equal(unknown.linkCheck,'invalid');assert.doesNotThrow(()=>validateBackup(structuredClone(unknownBackup)));
    controller.patch(taskId,{status:'skipped',message:'已跳过，保留记录避免重复提交'});const skippedUnknown=store.read().tasks[0];assert.equal(skippedUnknown.status,'skipped');assert.equal(skippedUnknown.health,'unknown');assert.equal(skippedUnknown.linkCheck,'invalid');assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets:Object.fromEntries(plaintext)}));controller.patch(taskId,{status:'live'});
    const rejectUnknown=(mutate:(value:any)=>void)=>{const value=structuredClone(unknownBackup);mutate(value);assert.throws(()=>validateBackup(value))};
    rejectUnknown(value=>{value.state.tasks[0].hereNow.sourceHash='a'.repeat(64)});rejectUnknown(value=>{value.state.tasks[0].hereNow.remoteAccountId='99999999-9999-4999-8999-999999999999'});rejectUnknown(value=>{value.state.tasks[0].nextCheckAt=value.state.tasks[0].lastCheckedAt});rejectUnknown(value=>{value.state.tasks[0].consecutiveMissing=1});rejectUnknown(value=>{value.state.tasks[0].linkCheck='absent'});rejectUnknown(value=>{value.state.tasks[0].status='needs_input'});
    publicMode='unavailable';await controller.verify(taskId);publicMode='normal';const unreachable=store.read().tasks[0];assert.equal(unreachable.status,'live');assert.equal(unreachable.health,'unknown');assert.equal(unreachable.linkCheck,'unreachable');assert.equal(ownerReads,2);assert.equal(publicReads,4);assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets:Object.fromEntries(plaintext)}));
    const lost=structuredClone(unknownBackup),lostTask=lost.state.tasks[0];delete lostTask.linkObservation;Object.assign(lostTask,{status:'needs_input',health:'missing',linkCheck:'absent',lostAt:lostTask.lastCheckedAt,reviewKind:'lost_link',consecutiveMissing:1});assert.doesNotThrow(()=>validateBackup(lost));
    for(const linkCheck of ['unreachable','invalid']){const lostUnknown=structuredClone(unknownBackup),lostUnknownTask=lostUnknown.state.tasks[0];delete lostUnknownTask.linkObservation;Object.assign(lostUnknownTask,{status:'needs_input',health:'unknown',linkCheck,lostAt:lostUnknownTask.lastCheckedAt,reviewKind:'lost_link',consecutiveMissing:1});assert.doesNotThrow(()=>validateBackup(lostUnknown))}
    const skipped=structuredClone(unknownBackup),skippedTask=skipped.state.tasks[0];delete skippedTask.linkObservation;Object.assign(skippedTask,{status:'skipped',health:'healthy',linkCheck:'found',lostAt:undefined,reviewKind:undefined,consecutiveMissing:0});assert.doesNotThrow(()=>validateBackup(skipped));
    let releaseOwner!:()=>void,notifyOwner!:()=>void;holdOwner=new Promise<void>(resolve=>releaseOwner=resolve);const ownerStarted=new Promise<void>(resolve=>notifyOwner=resolve);ownerEntered=notifyOwner;
    store.update(state=>Object.assign(state.tasks[0],{status:'review',hereNow:{...saved.hereNow!,stage:'api_receipt'},checkpoint:'here_now_api_receipt',publicUrl:undefined,firstLiveAt:undefined,linkCheck:undefined,reconcileAfter:undefined,reconcileAttempts:0}));
    const readsBeforeStop=publicReads,pendingRecovery=controller.tick();await ownerStarted;store.update(state=>{state.tasks[0].status='skipped'});releaseOwner();await pendingRecovery;
    const stopped=store.read().tasks[0];assert.equal(stopped.status,'skipped');assert.equal(stopped.hereNow?.stage,'api_receipt');assert.equal(publicReads,readsBeforeStop);
    const ownerReadsAfterStop=ownerReads;holdOwner=undefined;ownerEntered=undefined;await controller.tick();assert.equal(ownerReads,ownerReadsAfterStop);assert.equal(store.read().tasks[0].status,'skipped');
  }finally{controller.stop();store.close();rmSync(dir,{recursive:true,force:true})}
});
