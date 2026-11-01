import test from 'node:test';
import assert from 'node:assert/strict';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {defaultSettings} from '../src/main/store';
import {inspectBatch5RenderedBody} from '../src/main/batch5-renderer';
import {requestLeafmillSignInCode,verifyLeafmillSignInCode,probeLeafmillConnection,probeLeafmillApiKey,
  runLeafmillTask,reconcileLeafmillTask,verifyLeafmillPublication} from '../src/integrations/leafmill';
import type {Batch5Intent,Batch5OpaqueResponse,Batch5Persistence,Batch5Receipt} from '../src/integrations/batch5-contract';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const NOW='2026-10-29T10:00:00.000Z';
const TARGET='https://example.com/releases';
const URL='https://leafmill.net/useful-guide-1234';
const BODY=`Compare the release notes with the installed version before changing settings. Read the [maintained release page](${TARGET}) to check what changed.\n\nIf the version differs, keep a backup and test the change locally.`;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const page=(body:string,headers:Record<string,string>={})=>new Response(body,{status:200,headers:{'content-type':'text/html',...headers}});
const html=(target=TARGET)=>`<!doctype html><html><head><title>How to check a software release</title></head><body><article><h1>How to check a software release</h1><p>Compare the release notes with the installed version before changing settings. Read the <a href="${target}">maintained release page</a> to check what changed.</p><p>If the version differs, keep a backup and test the change locally.</p></article></body></html>`;

class Journal implements Batch5Persistence {
  intent?:Batch5Intent;receipt?:Batch5Receipt;opaque?:Batch5OpaqueResponse;task?:Task;blocked=false;
  async saveIntent(value:Batch5Intent){this.intent=value}
  async reserveIntent(value:Batch5Intent){this.intent=value}
  async markSending(value:Batch5Intent){if(this.blocked||this.intent?.operationId!==value.operationId)throw Error('blocked')}
  async assertReadyToSubmit(value:Batch5Intent){if(this.blocked||this.intent?.operationId!==value.operationId)throw Error('blocked')}
  async loadIntent(){return this.intent}
  async saveReceipt(value:Batch5Receipt){this.receipt=value}
  async loadReceipt(){return this.receipt}
  async saveOpaqueResponse(value:Batch5OpaqueResponse){this.opaque=value}
  async loadOpaqueResponse(){return this.opaque}
  currentTaskState(){return this.task?.batch5}
}
function fixture(){
  const site:Site={id:'site-1',domain:'example.com',url:'https://example.com/',email:'',name:'Example software',description:'Software documentation',
    category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:NOW};
  const channel:Channel={id:'leafmill',name:'Leafmill',domain:'leafmill.net',url:'https://leafmill.net/',submitUrl:'https://leafmill.net/api/v1/publish',
    categories:['software'],languages:['*'],kind:'article',emailRequired:true,accountRequired:true,articleRequired:true,free:'yes',freeNote:'',
    automation:'api',quality:'C',qualityReason:'',rulesUrl:'https://leafmill.net/terms',checkedAt:NOW,notes:'',allowedHosts:['leafmill.net'],enabled:true};
  const account:Account={id:'account-1',channelId:'leafmill',username:'owner@example.com',email:'owner@example.com',status:'registered',
    hasPassword:true,credentialKind:'api_token',createdAt:NOW};
  const settings={...defaultSettings(),articleReviewMode:'ai' as const};
  const task:Task={id:'task-1',siteId:site.id,channelId:'leafmill',accountId:account.id,sourceDomain:channel.domain,status:'running',
    createdAt:NOW,scheduledAt:NOW,updatedAt:NOW,attempts:1,message:'',topicUrl:TARGET,draftRevision:1,
    draft:{title:'How to check a software release',description:'A practical check of software updates.',body:BODY}};
  task.articleReview={status:'passed',reason:'passed',draftRevision:1,contentHash:articleContentHash(task),
    contextHash:articleContextHash(site,channel,settings,account,4),evidenceUrls:[],reviewContractVersion:4};
  const journal=new Journal();journal.task=task;
  const secrets=new Map([[`account:${account.id}`,JSON.stringify({version:1,email:account.email,apiKey:'leafmill-key-123456'})]]);
  const context:ExecutionContext={site,channel,task,settings,signal:new AbortController().signal,ai:{json:async<T>()=>({} as T)},
    secrets:{get:async k=>secrets.get(k),set:async(k,v)=>{secrets.set(k,v)},delete:async k=>{secrets.delete(k)}},getAccount:()=>account,
    saveAccount:async()=>undefined,checkpoint:partial=>{Object.assign(task,partial)},log:()=>undefined,batch5Persistence:journal};
  return {context,journal,task,account,secrets};
}
function fetcher(options:{publish?:unknown;article?:unknown;html?:string;headers?:Record<string,string>;robots?:string;me?:unknown;postError?:boolean;big?:boolean}={}){
  let posts=0;
  const fetch=async(url:string,init:RequestInit)=>{
    if(url==='https://leafmill.net/api/v1/me')return json(options.me??{email:'owner@example.com'});
    if(url==='https://leafmill.net/api/v1/publish'&&init.method==='POST'){
      posts++;if(options.postError)throw Error('lost response');
      return json(options.publish??{slug:'useful-guide-1234',url:URL,title:'How to check a software release',expiresAt:null},201);
    }
    if(url==='https://leafmill.net/api/v1/articles/useful-guide-1234')return json(options.article??{slug:'useful-guide-1234',url:URL,title:'How to check a software release',expiresAt:null});
    if(url===URL)return page(options.big?'x'.repeat(257_000):options.html??html(),options.headers);
    if(url==='https://leafmill.net/robots.txt')return new Response(options.robots??'# no disallow rules\n',{status:200,headers:{'content-type':'text/plain'}});
    throw Error(`unexpected ${url}`);
  };
  return {fetch,get posts(){return posts}};
}

test('email code flow returns only a versioned secret after exact confirmation',async()=>{
  const calls:string[]=[];
  const fetch=async(url:string,init:RequestInit)=>{calls.push(url);
    assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
    if(url.endsWith('/request-code'))return json({success:true,requiresCodeEntry:true});
    if(url.endsWith('/verify-code'))return json({success:true,email:'owner@example.com',apiKey:'leafmill-key-123456'});
    throw Error('unexpected');
  };
  await requestLeafmillSignInCode('owner@example.com',{fetch});
  assert.deepEqual(await verifyLeafmillSignInCode('owner@example.com','ABCD-1234',{fetch}),{version:1,email:'owner@example.com',apiKey:'leafmill-key-123456'});
  assert.equal(calls.length,2);
  await assert.rejects(verifyLeafmillSignInCode('owner@example.com','bad',{fetch}),/code_invalid/);
  assert.equal(calls.length,2);
});

test('one reviewed article gets encrypted receipt and only passes anonymous HTML readback',async()=>{
  const f=fixture(),net=fetcher();f.context.batch5Dependencies={fetch:net.fetch,now:()=>new Date(NOW)};
  const result=await runLeafmillTask(f.context);
  assert.equal(result.status,'review');assert.equal(net.posts,1);assert.equal(f.journal.intent?.channelId,'leafmill');
  assert.equal(f.journal.opaque?.status,201);assert.equal(f.journal.receipt?.publicUrl,URL);
  assert.equal(f.task.batch5?.stage,'api_receipt');assert.equal((await verifyLeafmillPublication(f.context)).found,true);
  assert.equal((await runLeafmillTask(f.context)).status,'review');assert.equal(net.posts,1);
  f.task.articleReview=undefined;
  assert.equal((await reconcileLeafmillTask(f.context)).status,'found');
  f.task.draft!.body+=' Modified';assert.equal((await reconcileLeafmillTask(f.context)).status,'unknown');
});

test('unknown publish response is never repeated',async()=>{
  const f=fixture(),net=fetcher({postError:true});f.context.batch5Dependencies={fetch:net.fetch};
  assert.equal((await runLeafmillTask(f.context)).reasonCode,'submission_unknown');
  assert.equal((await runLeafmillTask(f.context)).reasonCode,'submission_unknown');
  assert.equal(net.posts,1);
});

test('wrong email and missing current review fail before POST',async()=>{
  for(const mode of ['remote-email','credential-email','review'] as const){
    const f=fixture(),net=fetcher({me:mode==='remote-email'?{email:'wrong@example.com'}:undefined});
    if(mode==='credential-email')f.secrets.set('account:account-1',JSON.stringify({version:1,email:'wrong@example.com',apiKey:'leafmill-key-123456'}));
    if(mode==='review')f.task.articleReview=undefined;
    f.context.batch5Dependencies={fetch:net.fetch};
    assert.equal((await runLeafmillTask(f.context)).status,'needs_input');assert.equal(net.posts,0);assert.equal(f.journal.intent,undefined);
  }
  await assert.rejects(probeLeafmillConnection({version:1,email:'owner@example.com',apiKey:'leafmill-key-123456'},{fetch:fetcher({me:{email:'wrong@example.com'}}).fetch}),/account_mismatch/);
  assert.deepEqual(await probeLeafmillApiKey('leafmill-key-123456',{fetch:fetcher().fetch}),{email:'owner@example.com'});
});

test('expiring, malicious URL, and oversized responses cannot become a receipt',async()=>{
  for(const publish of [
    {slug:'useful-guide-1234',url:URL,expiresAt:'2026-10-30T10:00:00Z'},
    {slug:'useful-guide-1234',url:'https://evil.example/useful-guide-1234',expiresAt:null},
    {slug:'useful-guide-1234',url:'https://leafmill.net.evil.example/useful-guide-1234',expiresAt:null},
  ]){
    const f=fixture(),net=fetcher({publish});f.context.batch5Dependencies={fetch:net.fetch};
    assert.equal((await runLeafmillTask(f.context)).reasonCode,'submission_unknown');assert.equal(f.journal.receipt,undefined);assert.equal(net.posts,1);
  }
  const f=fixture(),net=fetcher({big:true});f.context.batch5Dependencies={fetch:net.fetch};
  assert.equal((await runLeafmillTask(f.context)).status,'review');
  assert.equal((await verifyLeafmillPublication(f.context)).found,false);assert.equal(net.posts,1);
});

test('public proof rejects missing native target, noindex, expiry, and robots block',async()=>{
  for(const options of [
    {html:html('https://wrong.example/releases')},
    {html:html().replace('</head>','<meta name="robots" content="noindex"></head>')},
    {headers:{'x-robots-tag':'googlebot: noindex'}},
    {article:{slug:'useful-guide-1234',url:URL,title:'How to check a software release',expiresAt:'2026-10-30T10:00:00Z'}},
    {robots:'User-agent: *\nDisallow: /\n'},
  ]){
    const f=fixture(),net=fetcher(options);f.context.batch5Dependencies={fetch:net.fetch};
    assert.equal((await runLeafmillTask(f.context)).status,'review');
    assert.equal((await verifyLeafmillPublication(f.context)).found,false);assert.equal(net.posts,1);
  }
});

test('public proof reports the actual target rel',async()=>{
  const f=fixture(),net=fetcher({html:html().replace('<a href=', '<a rel="nofollow ugc" href=')});
  f.context.batch5Dependencies={fetch:net.fetch};
  assert.equal((await runLeafmillTask(f.context)).status,'review');
  const verified=await verifyLeafmillPublication(f.context);
  assert.equal(verified.found,true);assert.equal(verified.rel,'nofollow ugc');assert.equal(verified.indexable,true);
});

test('hidden article and active redirects are not accepted as visible publications',async()=>{
  for(const publicHtml of [
    html().replace('<article>','<article hidden style="display:none">'),
    html().replace('<article>','<article style="visibility:hidden">'),
    html().replace('</head>','<meta http-equiv="refresh" content="0;url=https://example.net/"></head>'),
    html().replace('</body>','<script>location.replace("https://example.net/")</script></body>'),
  ]){
    const f=fixture(),net=fetcher({html:publicHtml});f.context.batch5Dependencies={fetch:net.fetch};
    assert.equal((await runLeafmillTask(f.context)).status,'review');
    const verified=await verifyLeafmillPublication(f.context);
    assert.equal(verified.found,false);assert.notEqual(verified.indexable,true);assert.equal(net.posts,1);
  }
});

test('scoped X-Robots-Tag blocks without whitespace are rejected',async()=>{
  for(const header of ['googlebot:none','googlebot:noindex','bingbot:noindex','none']){
    const f=fixture(),net=fetcher({headers:{'x-robots-tag':header}});f.context.batch5Dependencies={fetch:net.fetch};
    assert.equal((await runLeafmillTask(f.context)).status,'review');
    const verified=await verifyLeafmillPublication(f.context);
    assert.equal(verified.found,false,header);assert.notEqual(verified.indexable,true,header);assert.equal(net.posts,1);
  }
});

test('CSS that could conceal reviewed content needs rendered visibility evidence',async()=>{
  for(const publicHtml of [
    html().replace('</head>','<style>article { display: none }</style></head>'),
    html().replace('</head>','<link rel="stylesheet" href="/article.css"></head>'),
    html().replace('<article>','<article style="color: inherit">'),
  ]){
    const f=fixture(),net=fetcher({html:publicHtml});f.context.batch5Dependencies={fetch:net.fetch};
    assert.equal((await runLeafmillTask(f.context)).status,'review');
    const verified=await verifyLeafmillPublication(f.context);
    assert.equal(verified.found,false);assert.notEqual(verified.indexable,true);assert.equal(net.posts,1);
  }
});

test('credential-free rendered proof can accept CSS pages only after exact visible article inspection',async()=>{
  const f=fixture(),net=fetcher({html:html().replace('</head>','<style>article { color: inherit }</style></head>')});
  let renders=0;
  f.context.batch5Dependencies={fetch:net.fetch,renderPage:async(url,target,title,markdown,signal)=>{
    renders++;assert.equal(url,URL);assert.equal(target,TARGET);assert.equal(title,f.task.draft!.title);assert.equal(markdown,BODY);assert.equal(signal.aborted,false);
    return inspectBatch5RenderedBody({url,headHtml:'',bodyHtml:`<article data-batch5-article><p>Compare the release notes with the installed version before changing settings. Read the <a rel="nofollow ugc" href="${TARGET}">maintained release page</a> to check what changed.</p><p>If the version differs, keep a backup and test the change locally.</p></article>`,robots:[],refresh:false},target,title,markdown);
  }};
  assert.equal((await runLeafmillTask(f.context)).status,'review');
  const verified=await verifyLeafmillPublication(f.context);
  assert.equal(verified.found,true);assert.equal(verified.rel,'nofollow ugc');assert.equal(renders,1);
  assert.equal(net.posts,1);
});

test('renderer cannot override noindex or robots denial from the anonymous GET',async()=>{
  for(const options of [{headers:{'x-robots-tag':'googlebot:noindex'}},{robots:'User-agent: *\nDisallow: /'}]){
    const f=fixture(),net=fetcher({...options,html:html().replace('</head>','<style>article { color: inherit }</style></head>')});
    let renders=0;f.context.batch5Dependencies={fetch:net.fetch,renderPage:async()=>{renders++;return {found:true,indexable:true,rel:''}}};
    assert.equal((await runLeafmillTask(f.context)).status,'review');
    assert.equal((await verifyLeafmillPublication(f.context)).found,false);assert.equal(renders,0);
  }
});
