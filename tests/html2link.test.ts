import assert from 'node:assert/strict';
import test from 'node:test';
import {runHtml2LinkAcceptance} from '../src/integrations/html2link-acceptance';
import {renderHtml2LinkArticle} from '../src/integrations/html2link-article';
import {createHtml2LinkPublication,drainHtml2LinkPendingOperations,HTML2LINK_CREATE_URL,HTML2LINK_ROBOTS_URL,html2LinkHash,html2LinkRobotsUrl,parseHtml2LinkPublicUrl,parseStoredHtml2LinkCreateResponse,type Html2LinkIntent,type Html2LinkOpaqueResponse,type Html2LinkPersistence,type Html2LinkReceipt} from '../src/integrations/html2link';
import {verifyHtml2LinkPublication,type Html2LinkPublicEvidence,type Html2LinkPublicEvidencePersistence} from '../src/integrations/html2link-verifier';

const stamp='2026-10-22T08:00:00.000Z';
const operationId=`html2link_${'a'.repeat(32)}`;
const slug='a1B2c3D4';
const publicUrl=`https://html2link.dev/x/${slug}`;
const subdomainSlug='a1b2c3d4';
const subdomainPublicUrl=`https://${subdomainSlug}.html2link.dev/`;
const updateToken='private-update-token-123456';
const targetUrl='https://example.com/guides/export';
const draft={title:'Export a portable diagnostic bundle',description:'A practical software troubleshooting tutorial.',body:'Start with the application closed and keep the original files unchanged.\n\n## Create the bundle\n\nUse the built-in export command, then compare the archive with the [complete export guide](https://example.com/guides/export).\n\n## Verify the result\n\nOpen the copy from a clean directory and confirm every referenced file is present.'};
const article=renderHtml2LinkArticle({draft,targetUrl,language:'en'});
const intent:Html2LinkIntent={operationId,sourceHash:article.sourceHash,requestHash:article.requestHash,createdAt:stamp};
const payload={url:publicUrl,slug,updateToken,kind:'html',size:article.byteLength,updated:stamp};

function opaque(value=JSON.stringify(payload),changes:Partial<Html2LinkOpaqueResponse>={}):Html2LinkOpaqueResponse{const bytes=Buffer.from(value);return {...intent,version:1,kind:'html2link_opaque_response',status:201,contentType:'application/json',responseUrl:HTML2LINK_CREATE_URL,redirected:false,responseType:'basic',bodyBase64:bytes.toString('base64'),bodySha256:html2LinkHash(bytes),...changes}}
function memory(){let reserved=false,saved:Html2LinkOpaqueResponse|undefined,receipt:Html2LinkReceipt|undefined,secret:string|undefined,evidence:Html2LinkPublicEvidence|undefined;const events:string[]=[];const persistence:Html2LinkPersistence&Html2LinkPublicEvidencePersistence={secretStorage:'encrypted',async persistIntent(){if(reserved)throw Error('already reserved');reserved=true;events.push('intent')},assertReadyToSubmit(){events.push('approval');return true},async persistOpaqueResponse(value){saved=value;events.push('opaque')},async loadOpaqueResponse(){return saved},async promoteReceipt(value){receipt=value.receipt;secret=value.updateToken;events.push('receipt')},async persistPublicEvidence(value){evidence=value;events.push('public-evidence')}};return {persistence,events,get saved(){return saved},get receipt(){return receipt},get secret(){return secret},get evidence(){return evidence}}}

test('safe renderer preserves the reviewed tutorial and one real target anchor',()=>{
  assert.ok(article.html.startsWith('<!doctype html>\n'));
  assert.ok(article.byteLength<1_000_000);
  assert.match(article.html,/Export a portable diagnostic bundle/);
  assert.match(article.html,/href="https:\/\/example\.com\/guides\/export"/);
  assert.equal((article.html.match(/href="https:\/\/example\.com\/guides\/export"/g)??[]).length,1);
  assert.equal(/<script|<iframe|<img|onload=|url\(/i.test(article.html),false);
  for(const bad of ['<script>alert(1)</script>','![tracking](https://example.com/a.png)','[local](http://localhost/)'])assert.throws(()=>renderHtml2LinkArticle({draft:{...draft,body:`${draft.body}\n${bad}`},targetUrl,language:'en'}));
});

test('response parsing keeps undocumented extras opaque and never exposes the management token in the receipt',()=>{
  const parsed=parseStoredHtml2LinkCreateResponse(opaque(),intent,article);assert.ok('receipt' in parsed);assert.equal(parsed.receipt.publicUrl,publicUrl);assert.equal(parsed.receipt.slug,slug);assert.equal(JSON.stringify(parsed.receipt).includes(updateToken),false);assert.equal(parsed.updateToken,updateToken);
  const derived=parseStoredHtml2LinkCreateResponse(opaque(JSON.stringify({url:publicUrl,updateToken})),intent,article);assert.ok('receipt' in derived);assert.equal(derived.receipt.slug,slug);
  for(const bad of [{url:'https://example.com/x/a1B2c3D4'},{url:`${publicUrl}?secret=x`},{url:publicUrl,slug:'foreign'},{url:publicUrl,updateToken:'short'}])assert.ok('diagnostic' in parseStoredHtml2LinkCreateResponse(opaque(JSON.stringify({...payload,...bad})),intent,article));
  assert.deepEqual(parseStoredHtml2LinkCreateResponse(opaque(JSON.stringify(payload).replace('{','{"url":"https://html2link.dev/x/other",')),intent,article),{diagnostic:'duplicate_field'});
});

test('response parsing accepts the exact slug subdomain homepage and rejects authority confusion',()=>{
  const success=parseStoredHtml2LinkCreateResponse(opaque(JSON.stringify({...payload,url:subdomainPublicUrl,slug:subdomainSlug,size:String(article.byteLength),updated:false,indexed:true,kind:'html'}),{status:200}),intent,article);assert.ok('receipt' in success);assert.equal(success.receipt.publicUrl,subdomainPublicUrl);assert.equal(success.receipt.slug,subdomainSlug);assert.equal(JSON.stringify(success.receipt).includes(updateToken),false);
  assert.deepEqual(parseHtml2LinkPublicUrl(publicUrl),{slug,publicUrl});assert.deepEqual(parseHtml2LinkPublicUrl(subdomainPublicUrl),{slug:subdomainSlug,publicUrl:subdomainPublicUrl});assert.equal(html2LinkRobotsUrl(subdomainPublicUrl),`https://${subdomainSlug}.html2link.dev/robots.txt`);
  for(const bad of [
    `http://${subdomainSlug}.html2link.dev/`,
    `https://user:pass@${subdomainSlug}.html2link.dev/`,
    `https://${subdomainSlug}.html2link.dev:8443/`,
    `https://${subdomainSlug}.html2link.dev/path`,
    `https://${subdomainSlug}.html2link.dev/?q=1`,
    `https://${subdomainSlug}.html2link.dev/#x`,
    `https://nested.${subdomainSlug}.html2link.dev/`,
    `https://${subdomainSlug}.html2link.dev.evil.example/`,
    'https://bad_slug.html2link.dev/',
    'https://-bad.html2link.dev/',
    'https://bad-.html2link.dev/',
  ])assert.equal(parseHtml2LinkPublicUrl(bad),undefined,bad);
  assert.ok('diagnostic' in parseStoredHtml2LinkCreateResponse(opaque(JSON.stringify({...payload,url:subdomainPublicUrl,slug:'different'}),{status:200}),intent,article));
});

test('external POST is disabled by default and does not reserve an intent',async()=>{
  const m=memory();let calls=0;const result=await createHtml2LinkPublication({operationId,reviewed:true,article},m.persistence,{fetch:async()=>{calls++;throw Error('must not run')}});assert.deepEqual(result,{status:'not_started',reason:'external_write_disabled'});assert.equal(calls,0);assert.deepEqual(m.events,[]);
});

test('one multipart POST saves intent and complete response before promoting a public receipt',async()=>{
  const m=memory();let calls=0;const result=await createHtml2LinkPublication({operationId,reviewed:true,article},m.persistence,{allowExternalWrite:true,now:()=>new Date(stamp),fetch:async(url,init)=>{calls++;m.events.push('post');assert.equal(url,HTML2LINK_CREATE_URL);assert.equal(init.method,'POST');assert.equal(init.redirect,'manual');assert.equal(new Headers(init.headers).get('content-type'),null);assert.ok(init.body instanceof FormData);const file=init.body.get('file');assert.ok(file instanceof Blob);assert.equal((file as Blob&{name:string}).name,'article.html');assert.equal(file.type,'','match the official client multipart file type');assert.equal(await file.text(),article.html);return new Response(JSON.stringify(payload),{status:201,headers:{'content-type':'application/json'}})}});assert.equal(result.status,'created');assert.equal(calls,1);assert.deepEqual(m.events,['intent','approval','post','opaque','receipt']);assert.equal(m.secret,updateToken);assert.equal(JSON.stringify(m.receipt).includes(updateToken),false);assert.equal(Buffer.from(m.saved!.bodyBase64,'base64').toString(),JSON.stringify(payload));
});

test('unknown first response is retained and a second call cannot re-POST',async()=>{
  const m=memory();let calls=0;const deps={allowExternalWrite:true,now:()=>new Date(stamp),fetch:async()=>{calls++;return new Response('{"unexpected":true}',{status:201,headers:{'content-type':'application/json'}})}};const first=await createHtml2LinkPublication({operationId,reviewed:true,article},m.persistence,deps);assert.equal(first.status,'unknown');assert.ok(m.saved);const second=await createHtml2LinkPublication({operationId,reviewed:true,article},m.persistence,deps);assert.equal(second.status,'not_started');assert.equal(calls,1);
});

test('late first response is captured as encrypted opaque input without a retry',async()=>{
  const m=memory();const result=await createHtml2LinkPublication({operationId,reviewed:true,article},m.persistence,{allowExternalWrite:true,now:()=>new Date(stamp),timeoutMs:50,fetch:async()=>{await new Promise(resolve=>setTimeout(resolve,100));return new Response(JSON.stringify(payload),{status:201,headers:{'content-type':'application/json'}})}});assert.equal(result.status,'unknown');await drainHtml2LinkPendingOperations();assert.ok(m.saved);assert.equal(m.receipt,undefined);
});

function publicFetch(pageHtml=article.html,robots:BodyInit='User-agent: *\nAllow: /\n',pageHeaders:Record<string,string>={},expectedPublicUrl=publicUrl,options:{pageStatus?:number;robotsStatus?:number;robotsContentType?:string;robotsResponseUrl?:string}={}):((url:string,init:RequestInit)=>Promise<Response>){const expectedRobots=html2LinkRobotsUrl(expectedPublicUrl);return async(url,init)=>{assert.equal(init.method,'GET');if(url===expectedPublicUrl)return new Response(pageHtml,{status:options.pageStatus??200,headers:{'content-type':'text/html; charset=utf-8',...pageHeaders}});if(url===expectedRobots){const response=new Response(robots,{status:options.robotsStatus??200,headers:{'content-type':options.robotsContentType??'text/plain'}});if(options.robotsResponseUrl)Object.defineProperty(response,'url',{value:options.robotsResponseUrl});return response}throw Error('unexpected URL')}}

test('public verification saves full GET evidence and requires exact content, target anchor, indexing and robots',async()=>{
  const m=memory(),receipt={...intent,slug,publicUrl};const found=await verifyHtml2LinkPublication(receipt,article,{fetch:publicFetch(),now:()=>new Date(stamp),evidence:m.persistence});assert.equal(found.status,'usable');if(found.status==='usable'){assert.equal(found.evidence.canonical,null);assert.equal(found.evidence.xRobotsTag,'');assert.equal(found.evidence.robotsAllowed,true);assert.match(found.rel,/nofollow/)}assert.ok(m.evidence);assert.equal(Buffer.from(m.evidence!.pageBodyBase64,'base64').toString(),article.html);assert.equal(Buffer.from(m.evidence!.robotsBodyBase64,'base64').toString(),'User-agent: *\nAllow: /\n');
  const noindex=article.html.replace('<meta name="viewport"','<meta name="robots" content="noindex"><meta name="viewport"');assert.equal((await verifyHtml2LinkPublication(receipt,article,{fetch:publicFetch(noindex)})).status,'invalid');
  const absent=article.html.replace(targetUrl,'https://example.com/other');assert.equal((await verifyHtml2LinkPublication(receipt,article,{fetch:publicFetch(absent)})).status,'invalid');
  assert.equal((await verifyHtml2LinkPublication(receipt,article,{fetch:publicFetch(article.html,'User-agent: *\nDisallow: /x/\n')})).status,'invalid');
  const foreignCanonical=article.html.replace('</head>','<link rel="canonical" href="https://example.com/foreign"></head>');assert.equal((await verifyHtml2LinkPublication(receipt,article,{fetch:publicFetch(foreignCanonical)})).status,'invalid');
});

test('subdomain verification fetches only its exact page and same-origin robots',async()=>{
  const receipt={...intent,slug:subdomainSlug,publicUrl:subdomainPublicUrl},seen:string[]=[];const fetcher=publicFetch(article.html,'User-agent: *\nAllow: /\n',{},subdomainPublicUrl);const result=await verifyHtml2LinkPublication(receipt,article,{fetch:async(url,init)=>{assert.equal(init.method,'GET');seen.push(url);return fetcher(url,init)}});assert.equal(result.status,'usable');assert.deepEqual(seen.sort(),[subdomainPublicUrl,`https://${subdomainSlug}.html2link.dev/robots.txt`].sort());
  const wrongRobots=await verifyHtml2LinkPublication(receipt,article,{fetch:async(url,init)=>{assert.notEqual(url,HTML2LINK_ROBOTS_URL);return fetcher(url,init)}});assert.equal(wrongRobots.status,'usable');
});

test('missing robots is recorded as not declared without weakening page verification',async()=>{
  const receipt={...intent,slug:subdomainSlug,publicUrl:subdomainPublicUrl};
  for(const robotsStatus of [404,410]){
    const m=memory(),result=await verifyHtml2LinkPublication(receipt,article,{fetch:publicFetch(article.html,new Uint8Array([0xff]),{},subdomainPublicUrl,{robotsStatus,robotsContentType:'application/octet-stream'}),now:()=>new Date(stamp),evidence:m.persistence});
    assert.equal(result.status,'usable');
    if(result.status==='usable'){assert.equal(result.evidence.robotsStatus,robotsStatus);assert.equal(result.evidence.robotsDisposition,'not_declared');assert.equal(result.evidence.robotsAllowed,true)}
    assert.equal(m.evidence?.robotsStatus,robotsStatus);assert.equal(Buffer.from(m.evidence!.robotsBodyBase64,'base64').equals(Buffer.from([0xff])),true);
  }
  const missingPage=await verifyHtml2LinkPublication(receipt,article,{fetch:publicFetch(article.html,undefined,{},subdomainPublicUrl,{pageStatus:404,robotsStatus:404})});
  assert.equal(missingPage.status,'invalid');
});

test('robots failures, redirects, foreign responses, blocking rules and abnormal successful media remain rejected',async()=>{
  const receipt={...intent,slug:subdomainSlug,publicUrl:subdomainPublicUrl};
  for(const robotsStatus of [429,500]){
    const result=await verifyHtml2LinkPublication(receipt,article,{fetch:publicFetch(article.html,undefined,{},subdomainPublicUrl,{robotsStatus})});
    assert.equal(result.status,'unavailable');
  }
  for(const options of [
    {robotsStatus:302},
    {robotsContentType:'application/json'},
    {robotsResponseUrl:'https://foreign.example/robots.txt'},
  ]){
    const result=await verifyHtml2LinkPublication(receipt,article,{fetch:publicFetch(article.html,undefined,{},subdomainPublicUrl,options)});
    assert.equal(result.status,'invalid');
  }
  const blocked=await verifyHtml2LinkPublication(receipt,article,{fetch:publicFetch(article.html,'User-agent: *\nDisallow: /\n',{},subdomainPublicUrl)});
  assert.equal(blocked.status,'invalid');assert.equal(blocked.reason,'robots');
});

test('one-shot acceptance entry also defaults to zero external writes',async()=>{
  const m=memory();let calls=0;const result=await runHtml2LinkAcceptance({operationId,reviewed:true,draft,targetUrl,language:'en'},m.persistence,{fetch:async()=>{calls++;throw Error('must not run')}});assert.equal(result.status,'not_published');assert.equal(result.create.status,'not_started');assert.equal(calls,0);assert.deepEqual(m.events,[]);
});

test('approved one-shot entry performs one POST then the two bounded public GETs',async()=>{
  const m=memory();let posts=0,gets=0;const fetcher=async(url:string,init:RequestInit)=>{if(init.method==='POST'){posts++;return new Response(JSON.stringify(payload),{status:201,headers:{'content-type':'application/json'}})}gets++;return publicFetch()(url,init)};const result=await runHtml2LinkAcceptance({operationId,reviewed:true,draft,targetUrl,language:'en'},m.persistence,{allowExternalWrite:true,now:()=>new Date(stamp),fetch:fetcher});assert.equal(result.status,'accepted');assert.equal(posts,1);assert.equal(gets,2);assert.ok(m.saved);assert.ok(m.evidence);assert.deepEqual(m.events,['intent','approval','opaque','receipt','public-evidence']);
});


test('HTTP canonical and active rendering cannot falsely pass passive-page verification',async()=>{
  const receipt={...intent,slug,publicUrl};
  for(const link of ['<https://example.com/foreign>; rel=canonical','<https://example.com/foreign>; rel="alternate canonical"']){
    const result=await verifyHtml2LinkPublication(receipt,article,{fetch:publicFetch(article.html,undefined,{link})});
    assert.equal(result.status,'invalid');assert.equal(result.reason,'canonical');
  }
  const same=await verifyHtml2LinkPublication(receipt,article,{fetch:publicFetch(article.html,undefined,{link:`<${publicUrl}>; rel="canonical"`})});assert.equal(same.status,'usable');
  for(const injected of ['<script>document.querySelector("main").remove()</script>','<link rel="stylesheet" href="https://example.com/hide.css">','<style>main{display:none}</style>','<iframe srcdoc="hidden"></iframe>']){
    assert.equal((await verifyHtml2LinkPublication(receipt,article,{fetch:publicFetch(article.html.replace('</head>',injected+'</head>'))})).status,'invalid');
  }
  assert.equal((await verifyHtml2LinkPublication(receipt,article,{fetch:publicFetch(article.html.replace('<body>',`<body onload="document.querySelector('main').remove()">`))})).status,'invalid');
});
