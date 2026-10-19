import assert from 'node:assert/strict';
import test from 'node:test';
import {marked} from 'marked';
import {CHANNELS} from '../src/integrations/catalog';
import {publisherFor} from '../src/integrations/publishers';
import {docsMdDraftError,reconcileDocsMdTask,runDocsMdTask,verifyDocsMdPublication} from '../src/integrations/docs-md-publisher';
import type {DocsMdPersistence,DocsMdTransport} from '../src/integrations/docs-md';
import {docsMdTaskIdentity} from '../src/main/docs-md-publication';
import type {ExecutionContext,Site,Task} from '../src/shared/types';

const stamp='2026-10-09T00:00:00.000Z';
const taskId='11111111-1111-4111-8111-111111111111';
const siteId='22222222-2222-4222-8222-222222222222';
const publicId='docs-cycle-51';
const publicUrl=`https://docs-md.com/${publicId}`;
const rawUrl=`https://docs-md.com/raw/${publicId}`;
const editToken=Buffer.alloc(24,51).toString('base64url');
const draft={title:'A reviewed Docs MD guide',description:'Fixture',body:'A complete reviewed Markdown guide with the original [source](https://example.test/guide).'};

function channel(){const value=CHANNELS.find(item=>item.id==='docs-md');assert.ok(value);return value}
function site():Site{return {id:siteId,domain:'example.test',url:'https://example.test/',email:'owner@example.test',name:'Example',description:'Independent guides',category:'content',language:'en',monthlyTarget:1,articleReviewMode:'manual',status:'ready',createdAt:stamp,analyzedAt:stamp}}
function task(extra:Partial<Task>={}):Task{return {id:taskId,siteId,channelId:'docs-md',sourceDomain:'docs-md.com',status:'running',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'fixture',topicUrl:'https://example.test/guide',draft,articleApprovedAt:stamp,...extra}}
function context(taskValue:Task,persistence?:DocsMdPersistence):ExecutionContext{return {site:site(),channel:{...channel(),enabled:true},task:taskValue,settings:{provider:'codex',codexPath:'codex',model:'',articleReviewMode:'manual',preferredBrowser:'system',apiBase:'https://api.openai.com/v1',hasApiKey:false,autoRun:true,launchAtLogin:false,notify:false,timezone:'UTC',maxAttempts:3,maxSteps:18,dailyAiLimit:40,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},secrets:{get:async()=>undefined,set:async()=>{},delete:async()=>{}},ai:{json:async()=>{throw Error('unused')}},signal:new AbortController().signal,...(persistence?{docsMdPersistence:persistence}:{}),getAccount:()=>undefined,saveAccount:async()=>{},checkpoint:()=>{},log:()=>{}}}
function saved(stage:'api_receipt'|'published'='api_receipt'):Task{const value=task({status:'review',submittedAt:stamp,checkpoint:stage==='published'?'docs_md_published':'docs_md_api_receipt',health:'pending',publicUrl});const identity=docsMdTaskIdentity(value);assert.ok(identity);value.docsMd={operationId:'docs_md_11111111111141118111111111111111',sourceHash:identity.sourceHash,requestHash:identity.requestHash,createdAt:stamp,stage,id:publicId};return value}

type HtmlOptions={canonical?:string;canonicalCount?:number;metaRobots?:string;rel?:string;articleSource?:string;articleAttrs?:string;shellHidden?:boolean;permanent?:string;expiry?:string;rawHref?:string;rawLabel?:string;filename?:string;outerCount?:number};
function publicHtml(options:HtmlOptions={}):string{
  const identity=docsMdTaskIdentity(task());assert.ok(identity);
  let rendered=String(marked.parse(options.articleSource??identity.source,{async:false,gfm:true})).replaceAll('<a href=',`<a rel="${options.rel??'nofollow ugc noopener noreferrer'}" href=`);
  const canonical=Array.from({length:options.canonicalCount??1},()=>`<link rel="canonical" href="${options.canonical??publicUrl}">`).join('');
  const robots=options.metaRobots===undefined?'':`<meta name="robots" content="${options.metaRobots}">`;
  const outer=options.outerCount===0?'':`<div id="markdown-content"><div class="markdown-content"${options.articleAttrs??''}>${rendered}</div></div>`;
  return `<!doctype html><html><head>${canonical}${robots}</head><body><main${options.shellHidden?' hidden':''}><section class="share-header"><div>${options.permanent??'Permanent link'}</div></section><section class="article-row"><article class="card"><div class="file-bar"><h1>${options.filename??'publication.md'}</h1><a href="${options.rawHref??rawUrl}">${options.rawLabel??'Raw'}</a></div>${outer}${(options.outerCount??1)>1?outer:''}</article></section><section class="share-footer"><p>${options.expiry??'This link does not expire.'}</p></section></main></body></html>`;
}

interface TransportOptions{html?:string;robots?:string;raw?:string;rawStatus?:number;rawType?:string;robotsStatus?:number;robotsType?:string;pageStatus?:number;pageType?:string;pageHeaders?:Record<string,string>;pageUrl?:string}
function readTransport(requests:string[],options:TransportOptions={}):DocsMdTransport{return async(url,init)=>{requests.push(`${init.method}:${url}`);if(url===rawUrl)return new Response(options.raw??docsMdTaskIdentity(task())!.source,{status:options.rawStatus??200,headers:{'content-type':options.rawType??'text/markdown'}});if(url==='https://docs-md.com/robots.txt')return new Response(options.robots??'User-agent: *\nAllow: /',{status:options.robotsStatus??200,headers:{'content-type':options.robotsType??'text/plain'}});assert.equal(url,publicUrl);const response=new Response(options.html??publicHtml(),{status:options.pageStatus??200,headers:{'content-type':options.pageType??'text/html',...options.pageHeaders}});if(options.pageUrl)Object.defineProperty(response,'url',{value:options.pageUrl});return response}}

test('Docs MD enters trial with its bounded publisher registered',()=>{const value=channel();assert.equal(value.enabled,true);assert.equal(value.trial,true);assert.equal(value.accountRequired,false);assert.equal(value.automation,'api');assert.equal(value.evidenceStatus,'source_checked');assert.ok(publisherFor(value));assert.match(value.notes,/试运行/)});

test('draft preflight fixes a narrow Markdown contract before any POST',()=>{
  assert.equal(docsMdDraftError(draft),undefined);
  for(const changed of [
    {...draft,title:'bad\ntitle'},
    {...draft,body:'<div>raw</div>'},
    {...draft,body:'![remote](https://example.test/image.png)'},
    {...draft,body:'```mermaid\ngraph TD\n```'},
    {...draft,body:'Read [this](README.md).'},
  ])assert.ok(docsMdDraftError(changed));
});

test('a create result carries the exact durable identity while secrets never enter the result',async()=>{
  const intents:unknown[]=[],receipts:unknown[]=[],tokens:unknown[]=[],requests:Array<{url:string;body?:string}>=[];
  const persistence:DocsMdPersistence={persistIntent:async value=>{intents.push(structuredClone(value))},persistReceipt:async value=>{receipts.push(structuredClone(value))},persistEditTokenAtomically:async value=>{tokens.push(structuredClone(value))}};
  const result=await runDocsMdTask(context(task(),persistence),{now:()=>new Date(stamp),fetch:async(url,init)=>{requests.push({url,body:typeof init.body==='string'?init.body:undefined});return new Response(JSON.stringify({success:true,id:publicId,url:publicUrl,rawUrl,editToken,expiresAt:0,rateLimit:{remaining:19}}),{status:200,headers:{'content-type':'application/json'}})}});
  assert.equal(requests.length,1);assert.equal(requests[0].url,'https://docs-md.com/api/share');assert.deepEqual(JSON.parse(requests[0].body!),{content:docsMdTaskIdentity(task())!.source,filename:'publication.md',expiry:'never'});
  assert.equal(intents.length,1);assert.equal(receipts.length,1);assert.equal(tokens.length,1);assert.equal(result.docsMd?.stage,'api_receipt');assert.equal(result.docsMd?.id,publicId);assert.equal(result.submittedAt,stamp);assert.equal(JSON.stringify(result).includes(editToken),false);
});

test('unknown create diagnostics become fixed trusted messages without response disclosure',async t=>{
  const sensitive='private-response-token-and-key-53';
  const cases:Array<[string,DocsMdTransport,string]>=[
    ['transport',async()=>{throw Error(sensitive)},'传输或响应读取'],
    ['media',async()=>new Response(sensitive,{status:200,headers:{'content-type':`text/${sensitive}`}}),'响应媒体类型'],
    ['json',async()=>new Response(`{${sensitive}\u0000`,{status:200,headers:{'content-type':'application/json'}}),'JSON'],
    ['rateLimit',async()=>new Response(JSON.stringify({success:true,id:publicId,url:publicUrl,rawUrl,editToken,expiresAt:0,[sensitive]:editToken}),{status:200,headers:{'content-type':'application/json'}}),'rateLimit'],
  ];
  for(const [name,fetch,expected] of cases)await t.test(name,async()=>{
    const intents:unknown[]=[];
    const persistence:DocsMdPersistence={persistIntent:async value=>{intents.push(structuredClone(value))},persistReceipt:async()=>{throw Error('must not persist receipt')},persistEditTokenAtomically:async()=>{throw Error('must not persist token')}};
    const result=await runDocsMdTask(context(task(),persistence),{now:()=>new Date(stamp),fetch});
    assert.equal(intents.length,1);assert.equal(result.status,'review');assert.equal(result.checkpoint,'docs_md_share_submitting');assert.match(result.message,new RegExp(expected));
    assert.equal(JSON.stringify(result).includes(sensitive),false);assert.equal(JSON.stringify(result).includes(editToken),false);
  });
});

test('an existing no-ID intent is terminal and performs no network request',async()=>{
  const value=task({status:'review',submittedAt:stamp,checkpoint:'docs_md_share_submitting',health:'pending'}),identity=docsMdTaskIdentity(value);assert.ok(identity);value.docsMd={operationId:'docs_md_11111111111141118111111111111111',sourceHash:identity.sourceHash,requestHash:identity.requestHash,createdAt:stamp,stage:'submitting'};let requests=0;
  const result=await runDocsMdTask(context(value,{persistIntent:async()=>{throw Error('must not claim')},persistReceipt:async()=>{},persistEditTokenAtomically:async()=>{}}),{fetch:async()=>{requests++;throw Error('must not fetch')}});
  assert.equal(result.status,'review');assert.equal(requests,0);assert.match(result.message,/不会重发|停止自动请求/);
});

test('raw equality plus the exact visible permanent public page promotes only the same receipt',async()=>{
  const value=saved(),requests:string[]=[];const verified=await verifyDocsMdPublication(value,site().url,{fetch:readTransport(requests)});
  assert.equal(verified.found,true);assert.equal(verified.outcome,'found');assert.equal(verified.url,publicUrl);assert.match(verified.rel,/nofollow/);assert.match(verified.rel,/ugc/);assert.deepEqual(requests.map(item=>item.split(':').slice(1).join(':')),[rawUrl,'https://docs-md.com/robots.txt',publicUrl]);
  const recovered=await reconcileDocsMdTask(context(value),{fetch:readTransport(requests)});assert.equal(recovered.status,'found');if(recovered.status==='found')assert.equal(recovered.docsMd.stage,'published');
});

test('raw equality alone never counts as a public article',async()=>{const requests:string[]=[],value=saved();const result=await verifyDocsMdPublication(value,site().url,{fetch:readTransport(requests,{html:publicHtml({articleSource:'# A reviewed Docs MD guide\n\nTruncated.'})})});assert.equal(result.found,false);assert.equal(result.outcome,'invalid');assert.equal(requests.length,3)});

test('local receipt, hash, and draft inconsistencies stay unreachable without a read',async()=>{
  const cases=[saved(),saved(),saved(),saved()];
  delete cases[0].docsMd;
  cases[1].docsMd!.sourceHash='f'.repeat(64);
  cases[2].draft={...cases[2].draft!,body:`${cases[2].draft!.body}\nchanged`};
  cases[3].docsMd!.id='Invalid ID';
  for(const value of cases){let calls=0;const result=await verifyDocsMdPublication(value,site().url,{fetch:async()=>{calls++;throw Error('must not read')}});assert.equal(result.outcome,'unreachable');assert.equal(calls,0)}
});

test('known raw or public 404 and 410 are absent while service and robots failures remain unreachable',async t=>{
  for(const status of [404,410])await t.test(`raw ${status}`,async()=>{const result=await verifyDocsMdPublication(saved(),site().url,{fetch:readTransport([],{rawStatus:status})});assert.equal(result.outcome,'absent')});
  for(const status of [404,410])await t.test(`page ${status}`,async()=>{const result=await verifyDocsMdPublication(saved(),site().url,{fetch:readTransport([],{pageStatus:status})});assert.equal(result.outcome,'absent')});
  for(const status of [403,429,503])for(const point of ['raw','robots','page'] as const)await t.test(`${point} ${status}`,async()=>{
    const options:TransportOptions=point==='raw'?{rawStatus:status}:point==='robots'?{robotsStatus:status}:{pageStatus:status};
    const result=await verifyDocsMdPublication(saved(),site().url,{fetch:readTransport([],options)});assert.equal(result.outcome,'unreachable');
  });
  for(const status of [404,410])await t.test(`robots ${status}`,async()=>{const result=await verifyDocsMdPublication(saved(),site().url,{fetch:readTransport([],{robotsStatus:status})});assert.equal(result.outcome,'unreachable')});
});

test('Docs MD public HTML stream interruption is unreachable',async()=>{
  const result=await verifyDocsMdPublication(saved(),site().url,{fetch:async(url,init)=>{
    if(url!==publicUrl)return readTransport([])(url,init);
    let reads=0;
    const body=new ReadableStream<Uint8Array>({pull(controller){
      if(reads++===0)controller.enqueue(new TextEncoder().encode('<!doctype html><html><head>'));
      else controller.error(Error('connection closed'));
    }});
    return new Response(body,{headers:{'content-type':'text/html'}});
  }});
  assert.equal(result.found,false);
  assert.equal(result.outcome,'unreachable');
});

test('robots must allow the exact public path',async()=>{const requests:string[]=[],result=await verifyDocsMdPublication(saved(),site().url,{fetch:readTransport(requests,{robots:'User-agent: *\nDisallow: /docs-'})});assert.equal(result.found,false);assert.equal(result.outcome,'invalid');assert.deepEqual(requests.map(item=>item.split(':').slice(1).join(':')),[rawUrl,'https://docs-md.com/robots.txt'])});

test('public verification separates definite failures from unreadable shell and response changes',async t=>{
  const cases:Array<[string,TransportOptions,'invalid'|'unreachable']>=[
    ['raw mismatch',{raw:docsMdTaskIdentity(task())!.source+' changed'},'invalid'],
    ['wrong canonical',{html:publicHtml({canonical:'https://docs-md.com/other'})},'unreachable'],
    ['missing canonical',{html:publicHtml({canonicalCount:0})},'unreachable'],
    ['multiple canonical',{html:publicHtml({canonicalCount:2})},'unreachable'],
    ['noindex meta',{html:publicHtml({metaRobots:'noindex,follow'})},'invalid'],
    ['noindex header',{pageHeaders:{'x-robots-tag':'noindex'}},'invalid'],
    ['hidden shell',{html:publicHtml({shellHidden:true})},'unreachable'],
    ['hidden permanent child',{html:publicHtml({permanent:'<span hidden>Permanent link</span>'})},'unreachable'],
    ['hidden expiry child',{html:publicHtml({expiry:'<span style="display:none">This link does not expire.</span>'})},'unreachable'],
    ['hidden filename child',{html:publicHtml({filename:'<span hidden>publication.md</span>'})},'unreachable'],
    ['hidden raw label child',{html:publicHtml({rawLabel:'<span hidden>Raw</span>'})},'unreachable'],
    ['wrong permanent marker',{html:publicHtml({permanent:'Temporary link'})},'invalid'],
    ['wrong expiry marker',{html:publicHtml({expiry:'Expires tomorrow.'})},'invalid'],
    ['changed badge wording',{html:publicHtml({permanent:'Share link'})},'unreachable'],
    ['changed footer wording',{html:publicHtml({expiry:'Available to read'})},'unreachable'],
    ['wrong raw link',{html:publicHtml({rawHref:'https://docs-md.com/raw/other'})},'unreachable'],
    ['wrong filename',{html:publicHtml({filename:'other.md'})},'unreachable'],
    ['missing article root',{html:publicHtml({outerCount:0})},'unreachable'],
    ['duplicate article root',{html:publicHtml({outerCount:2})},'unreachable'],
    ['missing target link',{html:publicHtml({articleSource:'# A reviewed Docs MD guide\n\nA complete reviewed guide without its source.'})},'invalid'],
    ['missing ugc rel',{html:publicHtml({rel:'nofollow noopener noreferrer'})},'invalid'],
    ['redirect',{pageStatus:302,pageHeaders:{location:'https://docs-md.com/other'}},'unreachable'],
    ['offsite final URL',{pageUrl:'https://mirror.example/public'},'unreachable'],
    ['wrong content type',{pageType:'application/json'},'unreachable'],
    ['robots 401',{robotsStatus:401},'unreachable'],
    ['page 401',{pageStatus:401},'unreachable'],
  ];
  for(const [name,options,outcome] of cases)await t.test(name,async()=>{const result=await verifyDocsMdPublication(saved(),site().url,{fetch:readTransport([],options)});assert.equal(result.found,false,name);assert.equal(result.outcome,outcome,name)});
});
