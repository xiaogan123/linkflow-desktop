import {beforeEach,type TestContext} from 'node:test';
beforeEach(t=>{if(["normal Controller reuses the encrypted identity, writes once, read-only accepts, and restores the bound backup"].includes(t.name))(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-15T10:17:00.000Z')});});
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {marked} from 'marked';
import {CHANNELS} from '../src/integrations/catalog';
import {acceptWordcellPublication,createWordcellIdentity,publishWordcellArticle,WORDCELL_OPERATION_CONTRACT,WORDCELL_TOKEN_URL,type WordcellIdentityPersistence,type WordcellIntent,type WordcellOpaqueResponse,type WordcellPublicationPersistence,type WordcellPublicationReceipt} from '../src/integrations/wordcell';
import {parseWordcellCredential} from '../src/integrations/wordcell-publisher';
import {publicIdentitySlug} from '../src/integrations/public-identity';
import {encryptBackup,decryptBackup} from '../src/main/backup';
import {validateBackup} from '../src/main/backup-validation';
import {Controller} from '../src/main/controller';
import {emptyState,Store} from '../src/main/store';
import type {Vault} from '../src/main/vault';

const accountId='11111111-1111-4111-8111-111111111111';
const operationId='22222222-2222-4222-8222-222222222222';
const createdAt='2026-10-15T01:02:03.000Z';
const token='wc_pub_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const key8='deadbeef';
const slug='linkflow-1111111111111111';
const targetUrl='https://github.com/xiaogan123/linkflow-desktop';
const title='Synthetic publisher fixture';
const markdown=`# ${title}\n\n这是一份完全虚构的测试文档，描述模拟操作从等待状态到保存状态的转换。所有身份和操作编号都是测试值，不对应真实用户或真实发布。\n\n固定的 [软件参考链接](${targetUrl}) 用于检查公开页面是否保留原始目标。文档标题和段落在本地模拟接口与页面之间保持一致。\n\n测试重新打开同一条模拟记录，核对正文、链接和版本，再检查结果能否正确写回本地状态。`;
const renderedMarkdown=String(marked.parse(markdown));
function wordcellTemplate(body=renderedMarkdown,head='',navigation='<nav>站点导航，不属于文章正文。</nav>'){return `<!doctype html><html><head><meta name="robots" content="index,follow">${head}</head><body><main id="wordcell-main"><div class="note-body index-body">${body}</div>${navigation}</main></body></html>`}
function json(value:unknown,status=200,url=''){const response=new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});if(url)Object.defineProperty(response,'url',{value});return response}
function notFound(){return json({ok:false,contract:WORDCELL_OPERATION_CONTRACT,revision:0,deleted:false,error:{code:'NOT_FOUND',message:'no live site at this slug',retryable:false}},404)}
function committed(intent:WordcellIntent){return {ok:true,contract:WORDCELL_OPERATION_CONTRACT,operation:{contract:WORDCELL_OPERATION_CONTRACT,id:intent.operationId,expectedRevision:0,kind:'publish',requestDigest:'a'.repeat(64),revision:1,status:'committed'},idempotent:false,site:{slug,key8,url:`https://wordcell.io/p/${key8}/${slug}/`,digest:'b'.repeat(64),sourceDigest:`sha256:${'c'.repeat(64)}`,revision:1,notes:[],files:['index.md'],bytes:markdown.length,skippedAssets:[],createdAt,updatedAt:createdAt,title}}}
function publicationPersistence(){let intent:WordcellIntent|undefined,receipt:WordcellPublicationReceipt|undefined;const persistence:WordcellPublicationPersistence={async persistIntent(value){assert.equal(intent,undefined);intent=value},assertAuthorized(value){assert.deepEqual(value,intent);return true},async preserveReceipt(value){receipt=value},async promotePublished(){throw Error('not used')}};return {persistence,get intent(){return intent},get receipt(){return receipt}}}
function registeredSecret(){const label='Linkflow hosted publication',tokenIntent:WordcellIntent={version:1,operation:'token',operationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',accountId,createdAt,requestHash:createHash('sha256').update(`wordcell\0token\0${label}`).digest('hex')},raw=JSON.stringify({ok:true,key8,note:'The token is shown once.',sites:'/api/v1/sites',token,urlBase:`https://wordcell.io/p/${key8}/`}),identityOpaque:WordcellOpaqueResponse={version:1,kind:'wordcell_opaque_response',operation:'token',operationId:tokenIntent.operationId,accountId,createdAt,requestHash:tokenIntent.requestHash,status:200,contentType:'application/json',responseUrl:'',redirected:false,responseType:'default',bodyBase64:Buffer.from(raw).toString('base64'),bodySha256:createHash('sha256').update(raw).digest('hex')};return JSON.stringify({version:1,token,key8,urlBase:`https://wordcell.io/p/${key8}/`,tokenFingerprint:createHash('sha256').update(token).digest('hex'),identityIntent:tokenIntent,identityOpaque})}

test('Wordcell token mint stores the one-time response before promoting the exact token',async()=>{
  let savedIntent:WordcellIntent|undefined,savedOpaque:WordcellOpaqueResponse|undefined,promoted=false,calls=0;
  const persistence:WordcellIdentityPersistence={async persistIntent(value){savedIntent=value},assertAuthorized(value){assert.deepEqual(value,savedIntent);return true},async persistOpaqueResponse(value){savedOpaque=value},async promoteToken(intent,value){assert.deepEqual(intent,savedIntent);assert.equal(value.token,token);assert.equal(savedOpaque?.bodySha256.length,64);promoted=true},async loadOpaqueResponse(){return savedOpaque}};
  const result=await createWordcellIdentity({accountId,operationId,createdAt,label:'Linkflow hosted publication'},persistence,{fetch:async(input,init)=>{calls++;assert.equal(input,WORDCELL_TOKEN_URL);assert.equal(init?.method,'POST');assert.equal(String(init?.body),JSON.stringify({label:'Linkflow hosted publication'}));return json({ok:true,key8,note:'The token is shown once. Store it outside model-visible state.',sites:'/api/v1/sites',token,urlBase:`https://wordcell.io/p/${key8}/`})}});
  assert.equal(result.status,'ready');assert.equal(calls,1);assert.equal(promoted,true);
  const encoded=JSON.stringify({version:1,token,key8,urlBase:`https://wordcell.io/p/${key8}/`,tokenFingerprint:'x'.repeat(64),identityIntent:savedIntent,identityOpaque:savedOpaque});
  assert.throws(()=>parseWordcellCredential(encoded,accountId),/无效/,'credential parser binds the token fingerprint and opaque receipt');
});

test('timeout or abort after token intent never performs an internal retry',async()=>{
  let calls=0,intents=0;
  const controller=new AbortController();
  const persistence:WordcellIdentityPersistence={async persistIntent(){intents++},assertAuthorized(){return true},async persistOpaqueResponse(){throw Error('unreachable')},async promoteToken(){throw Error('unreachable')}};
  const resultPromise=createWordcellIdentity({accountId,operationId,createdAt,label:'Linkflow hosted publication'},persistence,{signal:controller.signal,timeoutMs:100,fetch:async()=>{calls++;controller.abort();throw Error('aborted')}});
  const result=await resultPromise;assert.equal(result.status,'unknown');assert.equal(calls,1);assert.equal(intents,1);
});

test('a token response arriving after the foreground timeout is still encrypted once and is never reminted',async()=>{
  let calls=0,release!:(response:Response)=>void,saved:WordcellOpaqueResponse|undefined,finishSave!:(value:void)=>void;
  const savedLate=new Promise<void>(resolve=>{finishSave=resolve});
  const persistence:WordcellIdentityPersistence={async persistIntent(){},assertAuthorized(){return true},async persistOpaqueResponse(value){saved=value;finishSave()},async promoteToken(){throw Error('not reached before recovery')},async loadOpaqueResponse(){return saved}};
  const pending=createWordcellIdentity({accountId,operationId,createdAt,label:'Linkflow hosted publication'},persistence,{timeoutMs:100,fetch:async()=>{calls++;return await new Promise<Response>(resolve=>{release=resolve})}});
  const first=await pending;assert.equal(first.status,'unknown');assert.equal(calls,1);assert.equal(saved,undefined);
  release(json({ok:true,key8,note:'The token is shown once.',sites:'/api/v1/sites',token,urlBase:`https://wordcell.io/p/${key8}/`}));
  await savedLate;assert.ok(saved);
  let promoted=false;
  const recovered=await createWordcellIdentity({accountId,operationId,createdAt,label:'Linkflow hosted publication'},{...persistence,async promoteToken(){promoted=true}}, {fetch:async()=>{calls++;throw Error('must not mint again')}});
  assert.equal(recovered.status,'ready');assert.equal(promoted,true);assert.equal(calls,1);
});

test('new slug requires exact revision-0 404 and sends one fixed operation PUT',async()=>{
  const state=publicationPersistence();let calls:string[]=[];
  const result=await publishWordcellArticle({accountId,token,key8,operationId,createdAt,slug,title,markdown,targetUrl},state.persistence,{fetch:async(input,init)=>{calls.push(`${init?.method} ${input}`);if(init?.method==='GET')return notFound();const body=JSON.parse(String(init?.body));assert.deepEqual(body.operation,{contract:WORDCELL_OPERATION_CONTRACT,id:operationId,expectedRevision:0});assert.equal(body.noindex,false);assert.equal(body.files['index.md'],markdown);return json(committed(state.intent!))}});
  assert.equal(result.status,'pending');assert.deepEqual(calls,[`GET https://wordcell.io/api/v1/sites/${slug}`,`PUT https://wordcell.io/api/v1/sites/${slug}`]);assert.equal(state.receipt?.publicUrl,`https://wordcell.io/p/${key8}/${slug}/`);
});

test('unknown publish recovery performs only GET for the same operation and never repeats PUT or changes slug',async()=>{
  const first=publicationPersistence();let putCount=0;
  const uncertain=await publishWordcellArticle({accountId,token,key8,operationId,createdAt,slug,title,markdown,targetUrl},first.persistence,{fetch:async(_input,init)=>{if(init?.method==='GET')return notFound();putCount++;return json({ok:false,error:{code:'UPSTREAM_TIMEOUT'}},502)}});
  assert.equal(uncertain.status,'pending');assert.equal(putCount,1);assert.ok(first.intent);
  const second=publicationPersistence();let recoveryCalls=0;
  const recovered=await publishWordcellArticle({accountId,token,key8,operationId,createdAt,slug,title,markdown,targetUrl,recoverOnly:true},second.persistence,{fetch:async(input,init)=>{recoveryCalls++;assert.equal(init?.method,'GET');assert.equal(input,`https://wordcell.io/api/v1/sites/${slug}?operation=${operationId}`);return json(committed(first.intent!))}});
  assert.equal(recovered.status,'pending');assert.ok(recovered.status==='pending'&&recovered.receipt);assert.equal(recoveryCalls,1);assert.equal(putCount,1);
});

test('a committed PUT response arriving after timeout is preserved without a second write',async()=>{
  let intent:WordcellIntent|undefined,puts=0,release!:(response:Response)=>void,finishSave!:(value:void)=>void;const preserved:WordcellPublicationReceipt[]=[];
  const savedLate=new Promise<void>(resolve=>{finishSave=resolve});
  const persistence:WordcellPublicationPersistence={async persistIntent(value){intent=value},assertAuthorized(value){assert.deepEqual(value,intent);return true},async preserveReceipt(value){preserved.push(value);finishSave()},async promotePublished(){throw Error('not used')}};
  const pending=publishWordcellArticle({accountId,token,key8,operationId,createdAt,slug,title,markdown,targetUrl},persistence,{timeoutMs:100,fetch:async(_input,init)=>{if(init?.method==='GET')return notFound();puts++;return await new Promise<Response>(resolve=>{release=resolve})}});
  const first=await pending;assert.equal(first.status,'pending');assert.equal(puts,1);assert.equal(preserved.length,0);assert.ok(intent);
  release(json(committed(intent!)));
  await savedLate;assert.equal(preserved[0]?.operationId,operationId);assert.equal(puts,1);
});

test('acceptance binds management receipt, canonical header, complete reviewed text, links and robots policy',async()=>{
  const state=publicationPersistence();
  const published=await publishWordcellArticle({accountId,token,key8,operationId,createdAt,slug,title,markdown,targetUrl},state.persistence,{fetch:async(_input,init)=>init?.method==='GET'?notFound():json(committed(state.intent!))});
  assert.ok(published.status==='pending'&&published.receipt);
  const receipt=published.receipt,publicHtml=wordcellTemplate(),calls:string[]=[];
  const evidence=await acceptWordcellPublication({token,receipt,title,markdown,targetUrl},{now:()=>new Date('2026-10-15T03:00:00.000Z'),fetch:async(input,init)=>{calls.push(`${init?.method} ${input}`);if(String(input).includes('/api/v1/sites/'))return json({ok:true,contract:WORDCELL_OPERATION_CONTRACT,site:{slug,key8,url:receipt.publicUrl,revision:receipt.revision,digest:receipt.digest,sourceDigest:receipt.sourceDigest}});if(String(input).endsWith('/robots.txt'))return new Response('User-agent: *\nAllow: /\n',{status:200,headers:{'content-type':'text/plain'}});return new Response(publicHtml,{status:200,headers:{'content-type':'text/html; charset=utf-8',link:`<${receipt.publicUrl}>; rel="canonical"`}})}});
  assert.deepEqual(evidence,{managementMatched:true,rendered:true,targetHref:targetUrl,targetRel:'follow',robotsAllowed:true,pageIndexable:true,checkedAt:'2026-10-15T03:00:00.000Z'});
  assert.deepEqual(calls,[`GET https://wordcell.io/api/v1/sites/${slug}`,`GET ${receipt.publicUrl}`,'GET https://wordcell.io/robots.txt']);
});

test('acceptance rejects crawler-specific denial, hidden authored content, and conflicting canonical declarations',async()=>{
  const state=publicationPersistence(),published=await publishWordcellArticle({accountId,token,key8,operationId,createdAt,slug,title,markdown,targetUrl},state.persistence,{fetch:async(_input,init)=>init?.method==='GET'?notFound():json(committed(state.intent!))});
  assert.ok(published.status==='pending'&&published.receipt);const receipt=published.receipt,body=String(marked.parse(markdown));
  const fixtures=[
    {name:'specific path denial',html:wordcellTemplate(body),robots:'User-agent: *\nAllow: /\nDisallow: /p/\n'},
    {name:'specific crawler denial',html:wordcellTemplate(body),robots:'User-agent: *\nAllow: /\n\nUser-agent: Googlebot\nDisallow: /\n'},
    {name:'hidden article',html:wordcellTemplate(`<div hidden style="display:none">${body}</div><p>Nothing reviewed is visible.</p>`),robots:'User-agent: *\nAllow: /\n'},
    {name:'inert article',html:wordcellTemplate(`<div inert>${body}</div>`),robots:'User-agent: *\nAllow: /\n'},
    {name:'template article',html:wordcellTemplate(`<template>${body}</template>`),robots:'User-agent: *\nAllow: /\n'},
    ...['position:fixed;top:1500px;left:0;width:1000px','color:transparent!important','color:rgba(1,2,3,0)','-webkit-text-fill-color:transparent','position:absolute;left:-99999px;top:0','clip-path:polygon(0 0,0 0,0 0)','width:0;overflow:hidden','height:0;overflow:hidden','transform:scale(0)','opacity:0.0'].map(style=>({name:`invisible article ${style}`,html:wordcellTemplate(body,`<style>.note-body.index-body,.note-body.index-body *{${style}}</style>`),robots:'User-agent: *\nAllow: /\n'})),
    {name:'conflicting canonical',html:wordcellTemplate(body,'<link rel="canonical" href="https://example.com/other">'),robots:'User-agent: *\nAllow: /\n'},
    {name:'reviewed content only in navigation',html:wordcellTemplate('<p>Unrelated visible body.</p>','',`<nav>${body}</nav>`),robots:'User-agent: *\nAllow: /\n'},
    {name:'legacy whole-main shape',html:`<html><body><main>${body}</main></body></html>`,robots:'User-agent: *\nAllow: /\n'},
    {name:'duplicate article roots',html:`<html><body><main id="wordcell-main"><div class="note-body index-body">${body}</div><div class="note-body index-body">${body}</div></main></body></html>`,robots:'User-agent: *\nAllow: /\n'},
  ];
  for(const fixture of fixtures)await assert.rejects(()=>acceptWordcellPublication({token,receipt,title,markdown,targetUrl},{fetch:async(input)=>{const url=String(input);if(url.includes('/api/v1/sites/'))return json({ok:true,contract:WORDCELL_OPERATION_CONTRACT,site:{slug,key8,url:receipt.publicUrl,revision:receipt.revision,digest:receipt.digest,sourceDigest:receipt.sourceDigest}});if(url.endsWith('/robots.txt'))return new Response(fixture.robots,{status:200,headers:{'content-type':'text/plain'}});return new Response(fixture.html,{status:200,headers:{'content-type':'text/html; charset=utf-8',link:`<${receipt.publicUrl}>; rel="canonical"`}})}}),fixture.name);
});

test('normal Controller reuses the encrypted identity, writes once, read-only accepts, and restores the bound backup',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wordcell-controller-')),store=new Store(join(directory,'state.sqlite')),siteId='44444444-4444-4444-8444-444444444444',taskId='55555555-5555-4555-8555-555555555555',bindingId='66666666-6666-4666-8666-666666666666',taskSlug=publicIdentitySlug({name:'Example software',url:'https://github.com/xiaogan123/linkflow-desktop/'},taskId,40),taskPublicUrl=`https://wordcell.io/p/${key8}/${taskSlug}/`,catalog=CHANNELS.map(value=>value.id==='wordcell'?{...value,enabled:true}:value),state=emptyState(),secret=registeredSecret(),plain=new Map<string,string>([[`account:${accountId}`,secret]]);
  state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='manual';state.settings.timezone='UTC';state.settings.channelOverrides=Object.fromEntries(catalog.map(value=>[value.id,value.id==='wordcell']));
  state.sites=[{id:siteId,domain:'github.com',url:'https://github.com/xiaogan123/linkflow-desktop/',email:'owner@example.test',name:'Example software',description:'Developer software',category:'software',language:'zh',monthlyTarget:1,articleReviewMode:'manual',qualifications:{software:targetUrl,developer:targetUrl},status:'ready',createdAt,analyzedAt:createdAt,topicsCheckedAt:new Date().toISOString(),topics:[{url:targetUrl,discoveredAt:createdAt}]}];
  state.tasks=[{id:taskId,siteId,channelId:'wordcell',accountId,sourceDomain:'wordcell.io',status:'queued',createdAt,scheduledAt:new Date(Date.now()-1000).toISOString(),updatedAt:createdAt,attempts:0,message:'fixture',topicUrl:targetUrl,draft:{title,description:'',body:markdown},draftRevision:1,articleApprovedAt:createdAt}];
  state.accounts=[{id:accountId,channelId:'wordcell',email:'',username:'hosted-token',createdAt,status:'registered',hasPassword:true,source:'generated',credentialKind:'api_token',registrationAttempts:1,registeredAt:createdAt,verifiedAt:createdAt}];state.accountBindings=[{id:bindingId,siteId,channelId:'wordcell',accountId,createdAt,updatedAt:createdAt}];store.update(current=>Object.assign(current,state));
  const vault={ready:true,available:()=>true,get:async(name:string)=>plain.get(name),set:async(name:string,value:string)=>{plain.set(name,value)},delete:async(name:string)=>{plain.delete(name)},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([name,value])=>{plain.set(name,value);return [name,`enc:${Buffer.from(value).toString('base64url')}`]}))} as unknown as Vault;
  let committedRemote=false,puts=0,tokenPosts=0;const calls:string[]=[],publicHtml=wordcellTemplate(),originalFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{const url=String(input),method=init?.method??'GET';calls.push(`${method} ${url}`);if(url===WORDCELL_TOKEN_URL){tokenPosts++;throw Error('existing identity must be reused')}if(url===`https://wordcell.io/api/v1/sites/${taskSlug}`&&method==='GET')return committedRemote?json({ok:true,contract:WORDCELL_OPERATION_CONTRACT,site:{slug:taskSlug,key8,url:taskPublicUrl,revision:1,digest:'b'.repeat(64),sourceDigest:`sha256:${'c'.repeat(64)}`}}):notFound();if(url===`https://wordcell.io/api/v1/sites/${taskSlug}`&&method==='PUT'){puts++;committedRemote=true;const body=JSON.parse(String(init?.body));return json({ok:true,contract:WORDCELL_OPERATION_CONTRACT,operation:{...body.operation,kind:'publish',requestDigest:'a'.repeat(64),revision:1,status:'committed'},idempotent:false,site:{slug:taskSlug,key8,url:taskPublicUrl,digest:'b'.repeat(64),sourceDigest:`sha256:${'c'.repeat(64)}`,revision:1,notes:1,files:1,bytes:markdown.length,skippedAssets:0,createdAt,updatedAt:createdAt,title}})}if(url===taskPublicUrl)return new Response(publicHtml,{status:200,headers:{'content-type':'text/html; charset=utf-8',link:`<${taskPublicUrl}>; rel="canonical"`}});if(url==='https://wordcell.io/robots.txt')return new Response('User-agent: *\nAllow: /\n',{status:200,headers:{'content-type':'text/plain'}});throw Error(`unexpected ${method} ${url}`)};
  const controller=new Controller(store,vault,'isolated',{channelCatalog:catalog});controller.runtime.aiReady=true;
  try{await controller.tick();await controller.tick();const saved=store.read().tasks[0];assert.equal(tokenPosts,0);assert.equal(puts,1,JSON.stringify({calls,saved},null,2));assert.equal(saved.status,'live',JSON.stringify(saved));assert.equal(saved.wordcell?.stage,'published');assert.equal(saved.publicUrl,taskPublicUrl);assert.ok(calls.filter(value=>value.startsWith('GET ')).length>=4);assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets:{[`account:${accountId}`]:secret}}));await controller.tick();assert.equal(puts,1)}finally{globalThis.fetch=originalFetch;controller.stop();store.close();rmSync(directory,{recursive:true,force:true})}
});

test('cross-host redirects and occupied slugs are rejected before any write',async()=>{
  let promoted=false;
  const persistence:WordcellIdentityPersistence={async persistIntent(){},assertAuthorized(){return true},async persistOpaqueResponse(){},async promoteToken(){promoted=true}};
  const tokenResult=await createWordcellIdentity({accountId,operationId,createdAt,label:'Linkflow hosted publication'},persistence,{fetch:async()=>json({ok:true,key8,note:'once',sites:'/api/v1/sites',token,urlBase:`https://wordcell.io/p/${key8}/`},200,'https://attacker.example/token')});
  assert.equal(tokenResult.status,'unknown');assert.equal(promoted,false);
  const state=publicationPersistence();let puts=0;
  const result=await publishWordcellArticle({accountId,token,key8,operationId,createdAt,slug,title,markdown,targetUrl},state.persistence,{fetch:async(_input,init)=>{if(init?.method==='PUT')puts++;return json({ok:true,contract:WORDCELL_OPERATION_CONTRACT,site:{slug}},200)}});
  assert.equal(result.status,'not_submitted');assert.equal(puts,0);assert.equal(state.intent,undefined);
});

test('the fixed Wordcell token survives only inside the authenticated encrypted backup',async()=>{
  let intent:WordcellIntent|undefined,opaque:WordcellOpaqueResponse|undefined;
  const persistence:WordcellIdentityPersistence={async persistIntent(value){intent=value},assertAuthorized(){return true},async persistOpaqueResponse(value){opaque=value},async promoteToken(){},async loadOpaqueResponse(){return opaque}};
  await createWordcellIdentity({accountId,operationId,createdAt,label:'Linkflow hosted publication'},persistence,{fetch:async()=>json({ok:true,key8,note:'The token is shown once.',sites:'/api/v1/sites',token,urlBase:`https://wordcell.io/p/${key8}/`})});
  const secret=JSON.stringify({version:1,token,key8,urlBase:`https://wordcell.io/p/${key8}/`,tokenFingerprint:createHash('sha256').update(token).digest('hex'),identityIntent:intent,identityOpaque:opaque});
  assert.equal(parseWordcellCredential(secret,accountId).token,token);
  const state=emptyState();state.accounts.push({id:accountId,channelId:'wordcell',email:'',username:'hosted-token',createdAt,updatedAt:createdAt,registeredAt:createdAt,verifiedAt:createdAt,status:'registered',hasPassword:true,source:'generated',credentialKind:'api_token',registrationAttempts:1});
  const backup={state,secrets:{[`account:${accountId}`]:secret}},encrypted=encryptBackup(backup,'wordcell-roundtrip-passphrase-2026');
  assert.equal(encrypted.toString().includes(token),false);assert.deepEqual(validateBackup(decryptBackup(encrypted,'wordcell-roundtrip-passphrase-2026')),backup);
});
