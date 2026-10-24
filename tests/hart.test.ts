import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import test from 'node:test';
import {
  HART_MAX_RESPONSE_BYTES,HART_PUBLISH_URL,HART_ROBOTS_URL,createHartPublication,hartPublicUrl,hartRawUrl,hartRequestHash,hartVersionsUrl,
  parseHartOpaqueResponse,recoverHartPublication,renderHartArticle,runHartAcceptance,verifyHartPublication,
  type HartIntent,type HartOpaqueResponse,type HartPersistence,type HartReceipt,
} from '../src/integrations/hart';

const now='2026-10-22T09:00:00.000Z';
const owner='fixture-owner';
const artifactId='csv-import-check';
const operationId=`hart_${'a'.repeat(32)}`;
const ownerKey=()=>randomBytes(24).toString('base64url');
const targetUrl='https://github.com/xiaogan123/linkflow-desktop/releases';
const draft={title:'Validate a CSV import with five sample rows',description:'A practical import check using synthetic data.',body:'A file extension alone does not prove the rows will import correctly.\n\n## Start with a sample\n\nUse five synthetic rows to test commas, quotes, embedded newlines, blank values, and leading zeros. Keep the original file unchanged.\n\n## Check the exact version\n\nBefore moving real data, compare the behavior with the [project release record](https://github.com/xiaogan123/linkflow-desktop/releases). This example contains no customer data or credentials.'};
const article=renderHartArticle({draft,targetUrl,language:'en'});

function intent():HartIntent{return {operationId,owner,artifact:artifactId,publicUrl:hartPublicUrl(owner,artifactId),sourceHash:article.sourceHash,requestHash:hartRequestHash(owner,artifactId,draft.title,article.fragment),createdAt:now}}
function receipt(version=1):HartReceipt{return {...intent(),version,latestUrl:`${intent().publicUrl}/latest`,pinnedUrl:`${intent().publicUrl}/v${version}`,visibility:'public',format:'html',cspMode:'strict'}}
function createBody(version=1){const r=receipt(version);return JSON.stringify({ok:true,id:`${owner}/${artifactId}`,owner,artifact:artifactId,version,format:'html',visibility:'public',csp_mode:'strict',url:r.publicUrl,latest_url:r.latestUrl,pinned_url:r.pinnedUrl,lint:[]})}
function opaque(body=createBody(),changes:Partial<HartOpaqueResponse>={}):HartOpaqueResponse{const bytes=Buffer.from(body);return {...intent(),version:1,kind:'hart_opaque_response',status:200,contentType:'application/json',responseUrl:'',redirected:false,responseType:'default',bodyBase64:bytes.toString('base64'),bodySha256:createHash('sha256').update(bytes).digest('hex'),...changes}}
function memory(){let storedIntent:{intent:HartIntent;ownerKey:string}|undefined,storedOpaque:HartOpaqueResponse|undefined,storedReceipt:HartReceipt|undefined;const events:string[]=[];const persistence:HartPersistence={secretStorage:'encrypted',async persistIntent(value){if(storedIntent)throw Error('latched');storedIntent=structuredClone(value);events.push('intent')},assertReadyToSubmit(value){assert.deepEqual(value,storedIntent?.intent);events.push('authorize');return true},async persistOpaqueResponse(value){storedOpaque=structuredClone(value);events.push('opaque')},async loadOpaqueResponse(){return storedOpaque},async promoteReceipt(value){storedReceipt=structuredClone(value);events.push('receipt')}};return {persistence,events,get intent(){return storedIntent},get opaque(){return storedOpaque},get receipt(){return storedReceipt}}}

function publicFetch(options:{raw?:string;page?:string;robots?:string;robotsStatus?:number;pageHeaders?:Record<string,string>}={}){const r=receipt(),page=options.page??`<!doctype html><html lang="en"><head><title>${draft.title}</title></head><body>${article.fragment}</body></html>`,raw=options.raw??article.fragment,robots=options.robots??'User-agent: *\nAllow: /\n',robotsStatus=options.robotsStatus??200;return async(url:string,init:RequestInit)=>{assert.equal(init.method,'GET');if(url===r.publicUrl)return new Response(page,{status:200,headers:{'content-type':'text/html; charset=utf-8',...options.pageHeaders}});if(url===hartRawUrl(owner,artifactId))return new Response(JSON.stringify({ok:true,id:`${owner}/${artifactId}`,version:1,title:draft.title,format:'html',html:raw}),{status:200,headers:{'content-type':'application/json'}});if(url===hartVersionsUrl(owner,artifactId))return new Response(JSON.stringify({ok:true,id:`${owner}/${artifactId}`,owner,name:artifactId,title:draft.title,versions:[{version:1,format:'html'}]}),{status:200,headers:{'content-type':'application/json'}});if(url===HART_ROBOTS_URL)return new Response(robots,{status:robotsStatus,headers:{'content-type':'text/plain'}});throw Error(`unexpected ${url}`)}}

test('renderer extracts only the reviewed safe body fragment',()=>{
  assert.match(article.fragment,/^<main><article><header>/);
  assert.match(article.fragment,new RegExp(`href="${targetUrl.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"`));
  assert.equal(/<!doctype|<html\b|<head\b|<body\b|<script\b|<img\b|<iframe\b/i.test(article.fragment),false);
  assert.equal(Buffer.byteLength(article.fragment),article.byteLength);
  assert.throws(()=>renderHartArticle({draft:{...draft,body:`${draft.body}\n\n<script>alert(1)</script>`},targetUrl,language:'en'}));
});

test('external write is closed by default before key or intent persistence',async()=>{
  const m=memory();let calls=0;const result=await createHartPublication({operationId,owner,artifact:artifactId,ownerKey:ownerKey(),article},m.persistence,{fetch:async()=>{calls++;throw Error('must not call')}});assert.deepEqual(result,{status:'not_started',reason:'external_write_disabled'});assert.equal(calls,0);assert.equal(m.intent,undefined);
});

test('the sole POST follows a durable encrypted-key latch and captures the full response first',async()=>{
  const m=memory(),key=ownerKey();let posts=0;const result=await createHartPublication({operationId,owner,artifact:artifactId,ownerKey:key,article},m.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{posts++;assert.ok(url.startsWith(`${HART_PUBLISH_URL}?`));const parsed=new URL(url);assert.equal(parsed.searchParams.get('visibility'),'public');assert.equal(parsed.searchParams.get('no_chrome'),'1');assert.equal(init.method,'POST');assert.equal(new Headers(init.headers).get('content-type'),'text/html');assert.equal(new Headers(init.headers).get('x-hart-owner-key'),key);assert.equal(init.body,article.fragment);return new Response(createBody(),{status:200,headers:{'content-type':'application/json'}})}});assert.equal(result.status,'created');assert.equal(posts,1);assert.deepEqual(m.events,['intent','authorize','opaque','receipt']);assert.equal(m.intent?.ownerKey,key);assert.equal(Buffer.from(m.opaque!.bodyBase64,'base64').toString(),createBody());assert.equal(JSON.stringify(m.receipt).includes(key),false);
});

test('a streamed response is cancelled as soon as it crosses the response cap',async()=>{
  const m=memory(),chunk=new Uint8Array(64*1024);let cancels=0,pulls=0;
  const body=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(chunk)},cancel(){cancels++}});
  const result=await createHartPublication({operationId,owner,artifact:artifactId,ownerKey:ownerKey(),article},m.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>new Response(body,{status:200,headers:{'content-type':'application/json'}})});
  assert.equal(result.status,'unknown');
  assert.ok(result.status==='unknown'&&result.diagnostic==='body_limit');
  assert.equal(cancels,1);
  assert.ok(pulls>=Math.floor(HART_MAX_RESPONSE_BYTES/chunk.byteLength)+1&&pulls<=Math.floor(HART_MAX_RESPONSE_BYTES/chunk.byteLength)+2);
  assert.equal(m.opaque,undefined);
});

test('an unknown first response is a permanent latch and recovery performs GET only',async()=>{
  const m=memory(),key=ownerKey();let posts=0;const first=await createHartPublication({operationId,owner,artifact:artifactId,ownerKey:key,article},m.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>{posts++;return new Response('{"ok":false,"error":"busy"}',{status:503,headers:{'content-type':'application/json'}})}});assert.equal(first.status,'unknown');assert.equal(posts,1);assert.ok(m.opaque);let gets=0;const recovered=await recoverHartPublication(intent(),article,m.persistence,{fetch:async(url,init)=>{assert.equal(init.method,'GET');gets++;return publicFetch()(url,init)}});assert.equal(recovered.status,'present_unknown');assert.equal(posts,1);assert.equal(gets,3);
  const blocked=await createHartPublication({operationId,owner,artifact:artifactId,ownerKey:key,article,priorIntent:intent()},m.persistence,{allowExternalWrite:true,fetch:async()=>{posts++;throw Error('must not POST')}});assert.equal(blocked.status,'blocked');assert.equal(posts,1);
});

test('stored success response promotes locally and recovery accepts using bounded reads',async()=>{
  const m=memory();await m.persistence.persistIntent({intent:intent(),ownerKey:ownerKey()});await m.persistence.persistOpaqueResponse(opaque());let posts=0,gets=0;const result=await recoverHartPublication(intent(),article,m.persistence,{fetch:async(url,init)=>{if(init.method==='POST')posts++;else gets++;return publicFetch()(url,init)}});assert.equal(result.status,'accepted');assert.equal(posts,0);assert.equal(gets,4);assert.equal(m.receipt?.publicUrl,intent().publicUrl);
});

test('acceptance requires exact raw body, native visible target, index policy, canonical and robots',async()=>{
  assert.equal((await verifyHartPublication(receipt(),article,{fetch:publicFetch()})).status,'usable');
  assert.deepEqual(await verifyHartPublication(receipt(),article,{fetch:publicFetch({raw:article.fragment+' '})}),{status:'invalid',reason:'raw'});
  const noindex=`<!doctype html><html><head><meta name="robots" content="noindex"></head><body>${article.fragment}</body></html>`;assert.deepEqual(await verifyHartPublication(receipt(),article,{fetch:publicFetch({page:noindex})}),{status:'invalid',reason:'indexing'});
  const foreign=`<!doctype html><html><head><link rel="canonical" href="https://example.com/other"></head><body>${article.fragment}</body></html>`;assert.deepEqual(await verifyHartPublication(receipt(),article,{fetch:publicFetch({page:foreign})}),{status:'invalid',reason:'indexing'});
  assert.deepEqual(await verifyHartPublication(receipt(),article,{fetch:publicFetch({pageHeaders:{link:'<https://example.com/other>; rel="canonical"'}})}),{status:'invalid',reason:'canonical'});
  assert.equal((await verifyHartPublication(receipt(),article,{fetch:publicFetch({pageHeaders:{link:`<${intent().publicUrl}>; rel="canonical"`}})})).status,'usable');
  assert.deepEqual(await verifyHartPublication(receipt(),article,{fetch:publicFetch({robots:'User-agent: *\nDisallow: /a/\n'})}),{status:'invalid',reason:'robots'});
  const hidden=`<!doctype html><html><head></head><body><div hidden>${article.fragment}</div></body></html>`;assert.deepEqual(await verifyHartPublication(receipt(),article,{fetch:publicFetch({page:hidden})}),{status:'invalid',reason:'content'});
});

test('one-shot runner needs the same explicit write bit and never exposes the key',async()=>{const m=memory(),key=ownerKey();let calls=0;const result=await runHartAcceptance({operationId,owner,artifact:artifactId,ownerKey:key,draft,targetUrl,language:'en'},m.persistence,{fetch:async()=>{calls++;throw Error('must not call')}});assert.equal(result.create?.status,'not_started');assert.equal(calls,0);assert.equal(JSON.stringify(result).includes(key),false)});

test('opaque parser rejects foreign ids, URLs, visibility and versions',()=>{assert.equal('diagnostic'in parseHartOpaqueResponse(opaque(),intent()),false);for(const body of [createBody().replace(`"id":"${owner}/${artifactId}"`,'"id":"foreign/item"'),createBody().replace('"visibility":"public"','"visibility":"unlisted"'),createBody().replace('"version":1','"version":0'),createBody().replace(intent().publicUrl,'https://example.com/')])assert.ok('diagnostic'in parseHartOpaqueResponse(opaque(body),intent()))});

test('opaque response URLs preserve literal percent and percent-looking title text',()=>{
  for(const title of ['100% safe CSV','encoded%20title']){
    const titledArticle=renderHartArticle({draft:{...draft,title},targetUrl,language:'en'});
    const titledIntent:HartIntent={...intent(),sourceHash:titledArticle.sourceHash,requestHash:hartRequestHash(owner,artifactId,title,titledArticle.fragment)};
    const titledReceipt={...receipt(),...titledIntent};
    const body=JSON.stringify({ok:true,id:`${owner}/${artifactId}`,owner,artifact:artifactId,version:1,format:'html',visibility:'public',csp_mode:'strict',url:titledReceipt.publicUrl,latest_url:titledReceipt.latestUrl,pinned_url:titledReceipt.pinnedUrl,lint:[]});
    const bytes=Buffer.from(body),responseUrl=`${HART_PUBLISH_URL}?${new URLSearchParams({owner,artifact:artifactId,visibility:'public',title,no_chrome:'1'})}`;
    const parsed=parseHartOpaqueResponse({...titledIntent,version:1,kind:'hart_opaque_response',status:200,contentType:'application/json',responseUrl,redirected:false,responseType:'default',bodyBase64:bytes.toString('base64'),bodySha256:createHash('sha256').update(bytes).digest('hex')},titledIntent);
    assert.equal('diagnostic'in parsed,false,title);
  }
});
