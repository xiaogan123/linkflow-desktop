import assert from 'node:assert/strict';
import test from 'node:test';
import {load} from 'cheerio';
import {renderShareYourHtmlArticle} from '../src/integrations/shareyourhtml-article';
import {
  SHAREYOURHTML_READBACK_MAX_HTML_BYTES,
  verifyShareYourHtmlReadback,
} from '../src/integrations/shareyourhtml-verifier';
import {shareYourHtmlDraftHash,shareYourHtmlSiteIdentityHash} from '../src/main/shareyourhtml-publication';
import type {Site,Task} from '../src/shared/types';

const taskId='11111111-1111-4111-8111-111111111111';
const siteId='22222222-2222-4222-8222-222222222222';
const slug='lf-11111111111141118111111111111111';
const publicUrl=`https://${slug}.shareyourhtml.com`;
const requestUrl=`${publicUrl}/`;
const robotsUrl=`${publicUrl}/robots.txt`;
const topic='https://example.com/guides/reviewed-topic';
const stamp='2026-10-09T00:00:00.000Z';

function site():Site{return {id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Fixture site',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp,topics:[{url:topic,title:'Reviewed topic',discoveredAt:stamp}]}}
const draft={title:'Reviewed article title',description:'Exact reviewed description.',body:[
  '## Structured content','',
  `This keeps the [reviewed destination](${topic}) and **useful detail**.`,'',
  '7. Seventh item','8. Eighth item','',
  '```ts','const exact = "code";','```','',
  '| Name | Value |','| :--- | ---: |','| alpha | beta |',
].join('\n')};
function task(extra:Partial<Task>={}):Task{
  const currentSite=site(),rendered=renderShareYourHtmlArticle({draft,targetUrl:topic,language:currentSite.language,slug});
  return {id:taskId,siteId,channelId:'shareyourhtml',sourceDomain:'shareyourhtml.com',status:'review',health:'pending',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'Pending readback',topicUrl:topic,draft:structuredClone(draft),draftRevision:4,submittedAt:stamp,publicUrl,checkpoint:'shareyourhtml_api_receipt',shareYourHtml:{operationId:'shareyourhtml_11111111111141118111111111111111',slug,sourceHash:rendered.sourceHash,requestHash:rendered.requestHash,createdAt:stamp,stage:'api_receipt',requestedExpiry:'never',publicVerification:'pending',reviewedDraftRevision:4,reviewedDraftHash:shareYourHtmlDraftHash(draft),siteId,siteIdentityHash:shareYourHtmlSiteIdentityHash(currentSite)},...extra};
}
function renderedHtml():string{return renderShareYourHtmlArticle({draft,targetUrl:topic,language:'en',slug}).html}
function response(url:string,body:string,contentType='text/html',status=200,headers:Record<string,string>={}):Response{
  const reply=new Response(body,{status,headers:{'content-type':contentType,...headers}});
  Object.defineProperty(reply,'url',{value:url});return reply;
}
function transport(page:string,robots='User-agent: *\nAllow: /',pageHeaders:Record<string,string>={}){
  const calls:Array<{url:string;init:RequestInit}>=[];
  const fetch=async(url:string,init:RequestInit)=>{calls.push({url,init});return url===requestUrl?response(url,page,'text/html',200,pageHeaders):response(url,robots,'text/plain')};
  return {calls,fetch};
}

test('exact complex authored article is visible and transport is two bounded credential-free GETs',async()=>{
  const mock=transport(renderedHtml());const result=await verifyShareYourHtmlReadback(task(),site(),{fetch:mock.fetch});
  assert.equal(result.status,'visible_match',JSON.stringify(result));assert.equal(result.content,'visible');assert.equal(result.publicUrl,publicUrl);
  assert.deepEqual(result.targetLinks,[{href:topic,rel:['nofollow','noopener','noreferrer','ugc']}]);
  assert.deepEqual(result.indexing,{page:'not_restricted',directives:[],robots:'allowed'});
  assert.deepEqual(mock.calls.map(value=>value.url),[requestUrl,robotsUrl]);
  for(const call of mock.calls){assert.equal(call.init.method,'GET');assert.equal(call.init.redirect,'error');assert.equal(call.init.credentials,'omit');assert.equal(call.init.body,undefined);assert.equal(new Headers(call.init.headers).has('authorization'),false);assert.equal(new Headers(call.init.headers).has('cookie'),false)}
});

test('inert platform helper outside authored article does not change the semantic match',async()=>{
  const helper='<div data-platform-helper="true">Helper</div><script type="application/json">{"mounted":true}</script>';
  const page=renderedHtml().replace('</body>',`${helper}</body>`),mock=transport(page);
  const result=await verifyShareYourHtmlReadback(task(),site(),{fetch:mock.fetch});
  assert.equal(result.status,'visible_match');assert.equal(result.content,'visible');
});

test('executable scripts and event handlers make static visibility unknown',async()=>{
  const pages=[
    renderedHtml().replace('</body>','<script>document.querySelector("article")?.remove()</script></body>'),
    renderedHtml().replace('<body>','<body onload="document.querySelector(\'article\')?.remove()">'),
    renderedHtml().replace('</body>','<script type="module">document.querySelector("article")?.remove()</script></body>'),
    renderedHtml().replace('</body>','<script type="text/jscript">document.querySelector("article")?.remove()</script></body>'),
    renderedHtml().replace('</body>','<script type="text/livescript">document.querySelector("article")?.remove()</script></body>'),
    renderedHtml().replace('</body>','<script type="application/x-helper">unknown()</script></body>'),
    renderedHtml().replace('</body>','<script type="application/json" src="https://cdn.example/data.json"></script></body>'),
  ];
  for(const page of pages){const result=await verifyShareYourHtmlReadback(task(),site(),{fetch:transport(page).fetch});assert.equal(result.status,'visibility_unknown');assert.equal(result.content,'unknown')}
});

test('hidden authored ancestors, descendants and declared hiding rules cannot pass',async()=>{
  const cases=[
    renderedHtml().replace('<main>','<main hidden>'),
    renderedHtml().replace('<h2>','<h2 aria-hidden="true">'),
    renderedHtml().replace('</head>','<style>article { display: none }</style></head>'),
  ];
  for(const page of cases){const mock=transport(page);const result=await verifyShareYourHtmlReadback(task(),site(),{fetch:mock.fetch});assert.equal(result.status,'content_hidden');assert.equal(mock.calls.length,1)}
});

test('external or otherwise unsupported styling produces unknown visibility, never a pass',async()=>{
  const pages=[
    renderedHtml().replace('</head>','<link rel="stylesheet" href="https://cdn.example/style.css"></head>'),
    renderedHtml().replace('<article>','<article style="color: red">'),
  ];
  for(const page of pages){const result=await verifyShareYourHtmlReadback(task(),site(),{fetch:transport(page).fetch});assert.equal(result.status,'visibility_unknown');assert.equal(result.content,'unknown')}
});

test('duplicate article and title-only or challenge pages do not satisfy authored content',async()=>{
  const original=renderedHtml(),$=load(original),article=$.html($('article'));
  const duplicate=original.replace('</main>',`${article}</main>`);
  for(const page of [duplicate,'<!doctype html><html><head><title>Reviewed article title</title><meta name="description" content="Exact reviewed description."></head><body><h1>Reviewed article title</h1></body></html>','<!doctype html><title>Verify you are human</title><p>Challenge</p>']){
    const result=await verifyShareYourHtmlReadback(task(),site(),{fetch:transport(page).fetch});assert.equal(result.status,'content_mismatch')
  }
});

test('visible login or challenge blockers outside an otherwise exact article cannot pass',async()=>{
  const pages=[
    renderedHtml().replace('</body>','<form><input type="password"></form></body>'),
    renderedHtml().replace('</body>','<div role="dialog" aria-modal="true">Verify you are human</div></body>'),
    renderedHtml().replace('</body>','<iframe src="https://challenge.example/"></iframe></body>'),
  ];
  for(const page of pages){const result=await verifyShareYourHtmlReadback(task(),site(),{fetch:transport(page).fetch});assert.equal(result.status,'content_mismatch')}
});

test('altered href, ordered-list start, code or table structure fails semantic comparison',async()=>{
  const pages=[
    renderedHtml().replace(topic,'https://example.com/guides/other'),
    renderedHtml().replace('<ol start="7">','<ol start="1">'),
    renderedHtml().replace('const exact = "code";','const changed = "code";'),
    renderedHtml().replace('<td align="right">beta</td>','<td align="left">beta</td>'),
    renderedHtml().replace(' and <strong>useful detail</strong>',' and<strong>useful detail</strong>'),
  ];
  for(const page of pages){const result=await verifyShareYourHtmlReadback(task(),site(),{fetch:transport(page).fetch});assert.equal(result.status,'content_mismatch')}
});

test('meaningful whitespace-only separators across nested inline elements remain authored semantics',async()=>{
  const variants=[
    `**one** **two**\n\n[Source](${topic})`,
    `*one* [two](https://example.com/other)\n\n[Source](${topic})`,
    `**one _nested_** **two**\n\n[Source](${topic})`,
    `**one** [two](https://example.com/other "two")\n\n[Source](${topic})`,
    `**one**\u00a0**two**\n\n[Source](${topic})`,
  ];
  for(const body of variants){
    const localDraft={...draft,body},rendered=renderShareYourHtmlArticle({draft:localDraft,targetUrl:topic,language:'en',slug});
    const current=task({draft:localDraft,shareYourHtml:{...task().shareYourHtml!,sourceHash:rendered.sourceHash,requestHash:rendered.requestHash,reviewedDraftHash:shareYourHtmlDraftHash(localDraft)}});
    const page=rendered.html.replace(/<\/strong>(?: |&nbsp;|\u00a0)<strong>|<\/em> <a|<\/strong> <a/u,value=>value.replace(/ |&nbsp;|\u00a0/u,''));
    const result=await verifyShareYourHtmlReadback(current,site(),{fetch:transport(page).fetch});
    assert.equal(result.status,'content_mismatch',body);
  }
});

test('anchor rel and page/index robots restrictions are recorded separately from visibility',async()=>{
  const page=renderedHtml().replace('rel="nofollow ugc noopener noreferrer"','rel="nofollow ugc sponsored"').replace('</head>','<meta name="robots" content="noindex, nofollow"></head>');
  const mock=transport(page,'User-agent: *\nDisallow: /',{'x-robots-tag':'max-snippet: 0'});
  const result=await verifyShareYourHtmlReadback(task(),site(),{fetch:mock.fetch});
  assert.equal(result.status,'visible_match');assert.deepEqual(result.targetLinks,[{href:topic,rel:['nofollow','sponsored','ugc']}]);
  assert.equal(result.indexing.page,'restricted');assert.ok(result.indexing.directives.includes('noindex'));assert.ok(result.indexing.directives.includes('nofollow'));assert.equal(result.indexing.robots,'disallowed');
});

test('missing, malformed or failed robots evidence remains unknown without hiding a valid page',async()=>{
  for(const robots of [response(robotsUrl,'missing','text/plain',404),response(robotsUrl,'invalid line','text/plain'),new Error('private raw failure')]){
    let calls=0;const fetch=async(url:string)=>{calls++;if(url===requestUrl)return response(url,renderedHtml());if(robots instanceof Error)throw robots;return robots};
    const result=await verifyShareYourHtmlReadback(task(),site(),{fetch});assert.equal(result.status,'visible_match');assert.equal(result.indexing.robots,'unknown');assert.equal(calls,2);assert.doesNotMatch(result.message,/private raw failure/)
  }
});

test('invalid receipt, submitting claim and manual URL variants make zero requests',async()=>{
  const variants=[
    task({shareYourHtml:{...task().shareYourHtml!,stage:'submitting'},publicUrl:undefined,checkpoint:'shareyourhtml_create_submitting'}),
    task({shareYourHtml:undefined}),
    task({publicUrl:'https://manual.example/page'}),
    task({draftRevision:5}),
    task({shareYourHtml:{...task().shareYourHtml!,sourceHash:'0'.repeat(64)}}),
  ];
  const changedSite=site();changedSite.url='https://example.com/changed';variants.push(task());
  for(const [index,value] of variants.entries()){
    let calls=0;const usedSite=index===variants.length-1?changedSite:site();const result=await verifyShareYourHtmlReadback(value,usedSite,{fetch:async()=>{calls++;throw Error('must not fetch')}});assert.equal(result.status,'invalid_binding');assert.equal(calls,0)
  }
});

test('wrong response identity, redirects, media type and meta refresh fail fixed response checks',async()=>{
  const variants=[
    async()=>response('https://other.shareyourhtml.com/',renderedHtml()),
    async()=>response(requestUrl,'', 'text/html',302,{location:'https://other.example/'}),
    async()=>response(requestUrl,renderedHtml(),'application/json'),
    async()=>response(requestUrl,renderedHtml().replace('</head>','<meta http-equiv="refresh" content="0;url=https://other.example/"></head>')),
  ];
  for(const fetch of variants){const result=await verifyShareYourHtmlReadback(task(),site(),{fetch});assert.equal(result.status,'invalid_response')}
});

test('local body cap, abort, deadline and network errors return fixed non-secret statuses',async()=>{
  const large='x'.repeat(SHAREYOURHTML_READBACK_MAX_HTML_BYTES+1),oversize=await verifyShareYourHtmlReadback(task(),site(),{fetch:async()=>response(requestUrl,large)});
  assert.equal(oversize.status,'invalid_response');
  const secret='01234567-89ab-cdef-0123-456789abcdef';
  const network=await verifyShareYourHtmlReadback(task(),site(),{fetch:async()=>{throw Error(secret)}});assert.equal(network.status,'unreachable');assert.equal(JSON.stringify(network).includes(secret),false);
  const controller=new AbortController();controller.abort();let calls=0;
  const aborted=await verifyShareYourHtmlReadback(task(),site(),{signal:controller.signal,fetch:async()=>{calls++;return response(requestUrl,renderedHtml())}});assert.equal(aborted.status,'unreachable');assert.equal(calls,0);
  const timed=await verifyShareYourHtmlReadback(task(),site(),{timeoutMs:50,fetch:()=>new Promise(()=>undefined)});assert.equal(timed.status,'unreachable');
});


test('default transport uses guarded DNS fallback and pinned raw requests without global fetch',async()=>{
  const original=globalThis.fetch;let globalCalls=0;const calls:string[]=[];
  globalThis.fetch=(async()=>{globalCalls++;throw Error('must not use global fetch')}) as typeof fetch;
  try{
    const result=await verifyShareYourHtmlReadback(task(),site(),{publicFetchDependencies:{
      resolve:async host=>{calls.push('system:'+host);return [{address:'198.18.0.1',family:4}]},
      resolvePublic:async host=>{calls.push('public:'+host);return [{address:'8.8.8.8',family:4}]},
      request:async(url,pinned)=>{
        calls.push(`request:${url.href}:${pinned.address}`);
        const body=Buffer.from(url.pathname==='/robots.txt'?'User-agent: *\nAllow: /':renderedHtml());
        return {status:200,headers:{'content-type':url.pathname==='/robots.txt'?'text/plain':'text/html','content-length':String(body.length)},body};
      },
    }});
    assert.equal(result.status,'visible_match');assert.equal(result.indexing.robots,'allowed');assert.equal(globalCalls,0);
    assert.deepEqual(calls,[
      `system:${slug}.shareyourhtml.com`,`public:${slug}.shareyourhtml.com`,`request:${requestUrl}:8.8.8.8`,
      `system:${slug}.shareyourhtml.com`,`public:${slug}.shareyourhtml.com`,`request:${robotsUrl}:8.8.8.8`,
    ]);
  }finally{globalThis.fetch=original}
});

test('guarded default rejects private DNS, redirects and invalid UTF-8 without follow-up requests',async()=>{
  let requests=0;
  const privateResult=await verifyShareYourHtmlReadback(task(),site(),{publicFetchDependencies:{resolve:async()=>[{address:'10.0.0.1',family:4}],request:async()=>{requests++;throw Error('must not request')}}});
  assert.equal(privateResult.status,'unreachable');assert.equal(requests,0);
  let resolves=0;
  const redirectResult=await verifyShareYourHtmlReadback(task(),site(),{publicFetchDependencies:{resolve:async()=>{resolves++;return [{address:'8.8.8.8',family:4}]},request:async()=>{requests++;return {status:302,headers:{location:requestUrl},body:Buffer.alloc(0)}}}});
  assert.equal(redirectResult.status,'invalid_response');assert.equal(resolves,1);assert.equal(requests,1);
  const utf8=await verifyShareYourHtmlReadback(task(),site(),{publicFetchDependencies:{resolve:async()=>[{address:'8.8.8.8',family:4}],request:async()=>({status:200,headers:{'content-type':'text/html','content-length':'2'},body:Buffer.from([0xc3,0x28])})}});
  assert.equal(utf8.status,'invalid_response');
});

test('one outer deadline bounds page plus robots guarded reads',async()=>{
  const started=Date.now();let requests=0;
  const result=await verifyShareYourHtmlReadback(task(),site(),{timeoutMs:50,publicFetchDependencies:{
    resolve:async()=>[{address:'8.8.8.8',family:4}],
    request:async url=>{requests++;if(url.pathname==='/robots.txt')return new Promise(()=>undefined);await new Promise(resolve=>setTimeout(resolve,30));const body=Buffer.from(renderedHtml());return {status:200,headers:{'content-type':'text/html','content-length':String(body.length)},body}},
  }});
  assert.equal(result.status,'visible_match');assert.equal(result.indexing.robots,'unknown');assert.equal(requests,2);assert.ok(Date.now()-started<90);
});
