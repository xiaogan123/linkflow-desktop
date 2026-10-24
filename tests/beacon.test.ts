import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {
  BEACON_MAX_RESPONSE_BYTES,BEACON_ORIGIN,BEACON_PUBLISH_URL,BEACON_SEND_OTP_URL,BEACON_SITES_URL,BEACON_VERIFY_OTP_URL,
  beaconPublicUrl,beaconPublishRequestHash,beaconSiteUrl,publishBeaconArticle,recoverBeaconApiKey,recoverBeaconOtp,recoverBeaconPublication,
  renderBeaconArticle,sendBeaconOtp,verifyBeaconOtp,verifyBeaconPublication,
  type BeaconIntent,type BeaconOpaqueResponse,type BeaconPersistence,type BeaconPublicationReceipt,
} from '../src/integrations/beacon';

const now='2026-10-24T08:00:00.000Z';
const email='owner@example.invalid';
const apiKey=`chk_${'k'.repeat(32)}`;
const slug='example-beacon-guide';
const targetUrl='https://example.com/product';
const draft={title:'Check an import before using real data',description:'A small, repeatable import check.',body:'Test the importer with five synthetic rows before using real data.\n\n## Verify the result\n\nCompare the output with the [product documentation](https://example.com/product), then remove the sample rows.'};
const article=renderBeaconArticle({draft,targetUrl,language:'en',slug});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const op=(char:string)=>`beacon_${char.repeat(32)}`;

function memory(options:{failIntent?:boolean}={}){
  const intents:BeaconIntent[]=[],opaque=new Map<string,BeaconOpaqueResponse>(),events:string[]=[];let publication:BeaconPublicationReceipt|undefined,storedKey:string|undefined;
  const persistence:BeaconPersistence={
    secretStorage:'encrypted',
    async persistIntent(value){events.push('intent');if(options.failIntent)throw Error('disk unavailable');intents.push(structuredClone(value))},
    assertReadyToSubmit(value){events.push('authorize');assert.deepEqual(value,intents.at(-1));return true},
    async persistOpaqueResponse(value){events.push('opaque');opaque.set(`${value.stage}:${value.operationId}`,structuredClone(value))},
    async loadOpaqueResponse(stage,operationId){return opaque.get(`${stage}:${operationId}`)},
    async promoteOtpSent(){events.push('otp')},
    async promoteApiKey(value){events.push('key');storedKey=value.apiKey},
    async promotePublication(value){events.push('publication');publication=structuredClone(value)},
  };
  return {persistence,intents,opaque,events,get publication(){return publication},get apiKey(){return storedKey}};
}

function publishIntent(operationId=op('c')){
  return {kind:'publish' as const,operationId,slug,publicUrl:beaconPublicUrl(slug),sourceHash:article.sourceHash,markdownHash:hash(article.markdown),targetUrlHash:hash(article.targetUrl),requestHash:article.requestHash,apiKeyHash:hash(apiKey),createdAt:now};
}
function receipt():BeaconPublicationReceipt{return {...publishIntent(),versionId:'ver_1',anonymous:false,expiresAt:null}}
function publishBody(changes:Record<string,unknown>={}){return JSON.stringify({url:beaconPublicUrl(slug),pageUrl:beaconPublicUrl(slug),slug,updated:false,anonymous:false,expiresAt:null,versionId:'ver_1',fileCount:1,totalBytes:article.byteLength,...changes})}
function ownerDetail(expiresAt:null|string=null){return {site:{id:'site_1',slug,url:beaconPublicUrl(slug),currentVersionId:'ver_1',ownerId:'acct_1',title:draft.title,expiresAt},currentVersion:{id:'ver_1',status:'live',fileCount:1,totalSize:article.byteLength}}}
function responseJson(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})}

function verificationFetch(options:{page?:string;robots?:string;robotsStatus?:number;expiresAt?:null|string}={}){
  const seen:string[]=[];
  const fetch=async(url:string,init:RequestInit)=>{
    seen.push(url);assert.equal(init.method,'GET');
    if(url===beaconSiteUrl(slug)){assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${apiKey}`);return responseJson(ownerDetail(options.expiresAt??null))}
    if(url===beaconPublicUrl(slug))return new Response(options.page??article.html,{status:200,headers:{'content-type':'text/html; charset=utf-8'}});
    if(url===`${beaconPublicUrl(slug)}robots.txt`)return new Response(options.robots??'User-agent: *\nAllow: /\n',{status:options.robotsStatus??200,headers:{'content-type':'text/plain'}});
    throw Error(`unexpected ${url}`);
  };
  return {fetch,seen};
}

test('renderer reuses the reviewed static article contract and binds the exact publish body',()=>{
  assert.match(article.html,/^<!doctype html>/);
  assert.match(article.html,/href="https:\/\/example\.com\/product"/);
  assert.equal(/<script\b|<iframe\b|<img\b/i.test(article.html),false);
  assert.equal(article.requestHash,beaconPublishRequestHash(article));
  assert.equal('publicUrl' in article,false);
});

test('all writes are closed by default and an intent persistence failure makes zero POSTs',async()=>{
  let calls=0;const disabled=memory();
  assert.deepEqual(await sendBeaconOtp({operationId:op('a'),email},disabled.persistence,{fetch:async()=>{calls++;throw Error('must not call')}}),{status:'not_started',reason:'external_write_disabled'});
  const failed=memory({failIntent:true});const result=await publishBeaconArticle({operationId:op('c'),apiKey,article},failed.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>{calls++;throw Error('must not call')}});
  assert.deepEqual(result,{status:'not_started',reason:'intent_not_persisted'});assert.equal(calls,0);
});

test('OTP send persists the encrypted intent and opaque response before reporting the ten-minute code window',async()=>{
  const saved=memory();let posts=0;
  const result=await sendBeaconOtp({operationId:op('a'),email},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{posts++;assert.equal(url,BEACON_SEND_OTP_URL);assert.equal(init.method,'POST');assert.equal(init.redirect,'manual');assert.deepEqual(JSON.parse(String(init.body)),{email});return responseJson({success:true,next:'verify the emailed code'})}});
  assert.equal(result.status,'sent');assert.equal(posts,1);assert.deepEqual(saved.events,['intent','authorize','opaque','otp']);
  assert.ok(result.status==='sent'&&result.receipt.cooldownUntil==='2026-10-24T08:01:00.000Z');
  assert.ok(result.status==='sent'&&result.receipt.expiresAt==='2026-10-24T08:10:00.000Z');
  const recovered=await recoverBeaconOtp(saved.intents[0] as Extract<BeaconIntent,{kind:'send_otp'}>,saved.persistence);assert.equal(recovered.status,'recovered');
});

test('OTP verification saves the API key only through encrypted persistence and never returns it',async()=>{
  const saved=memory();const code='123456';let posts=0;
  const result=await verifyBeaconOtp({operationId:op('b'),email,code},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{posts++;assert.equal(url,BEACON_VERIFY_OTP_URL);assert.deepEqual(JSON.parse(String(init.body)),{email,code});return responseJson({apiKey,account:{id:'acct_1',email}})}});
  assert.equal(result.status,'verified');assert.equal(posts,1);assert.equal(saved.apiKey,apiKey);assert.deepEqual(saved.events,['intent','authorize','opaque','key']);
  assert.equal(JSON.stringify(result).includes(apiKey),false);assert.equal(JSON.stringify(result).includes(code),false);
  const recovered=await recoverBeaconApiKey(saved.intents[0] as Extract<BeaconIntent,{kind:'verify_otp'}>,saved.persistence);assert.equal(recovered.status,'recovered');assert.equal(JSON.stringify(recovered).includes(apiKey),false);assert.equal(posts,1);
});

test('authenticated publish sends one exact JSON request after the durable latch',async()=>{
  const saved=memory();let posts=0;
  const result=await publishBeaconArticle({operationId:op('c'),apiKey,article},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{posts++;assert.equal(url,BEACON_PUBLISH_URL);assert.equal(init.method,'POST');const headers=new Headers(init.headers);assert.equal(headers.get('authorization'),`Bearer ${apiKey}`);assert.equal(headers.get('content-type'),'application/json');assert.deepEqual(JSON.parse(String(init.body)),{files:[{path:'index.html',content:article.html,encoding:'utf8'}],slug,title:draft.title});return new Response(publishBody(),{status:201,headers:{'content-type':'application/json'}})}});
  assert.equal(result.status,'created');assert.equal(posts,1);assert.deepEqual(saved.events,['intent','authorize','opaque','publication']);assert.equal(saved.publication?.expiresAt,null);assert.equal(saved.publication?.anonymous,false);assert.equal(JSON.stringify(result).includes(apiKey),false);
});

test('unknown publish outcome is latched; retry makes zero POSTs and recovery is GET-only',async()=>{
  const saved=memory();let posts=0;
  const first=await publishBeaconArticle({operationId:op('c'),apiKey,article},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>{posts++;throw Error('connection ended')}});
  assert.equal(first.status,'unknown');assert.equal(posts,1);assert.ok(first.status==='unknown'&&first.diagnostic==='transport');
  const prior=saved.intents[0] as ReturnType<typeof publishIntent>;const blocked=await publishBeaconArticle({operationId:op('c'),apiKey,article,priorIntent:prior},saved.persistence,{allowExternalWrite:true,fetch:async()=>{posts++;throw Error('must not POST')}});assert.equal(blocked.status,'blocked');assert.equal(posts,1);
  let gets=0;const publicResponses=verificationFetch();const recovered=await recoverBeaconPublication(prior,article,apiKey,saved.persistence,{fetch:async(url,init)=>{assert.equal(init.method,'GET');gets++;if(url===`${BEACON_SITES_URL}?limit=100&offset=0`)return responseJson({data:[ownerDetail().site],totalCount:1,limit:100,offset:0});return publicResponses.fetch(url,init)}});
  assert.equal(recovered.status,'accepted');assert.equal(posts,1);assert.equal(gets,5);
});

test('lost-response recovery follows bounded owned-site pagination to the original slug',async()=>{
  const saved=memory(),intent=publishIntent();let gets=0;
  const publicResponses=verificationFetch(),others=Array.from({length:100},(_,index)=>({slug:`other-${index}`,url:`https://other-${index}.beacon.host/`,currentVersionId:`ver_${index}`,expiresAt:null}));
  const result=await recoverBeaconPublication(intent,article,apiKey,saved.persistence,{fetch:async(url,init)=>{assert.equal(init.method,'GET');gets++;if(url===`${BEACON_SITES_URL}?limit=100&offset=0`)return responseJson({data:others,totalCount:101,limit:100,offset:0});if(url===`${BEACON_SITES_URL}?limit=100&offset=100`)return responseJson({data:[ownerDetail().site],totalCount:101,limit:100,offset:100});return publicResponses.fetch(url,init)}});
  assert.equal(result.status,'accepted');assert.equal(gets,6);
});

test('malformed owned-site pagination fails closed without probing unbounded pages',async()=>{
  const saved=memory(),intent=publishIntent();let listGets=0;
  const result=await recoverBeaconPublication(intent,article,apiKey,saved.persistence,{fetch:async(url,init)=>{assert.equal(init.method,'GET');if(url===beaconSiteUrl(slug))return responseJson(ownerDetail());if(url.startsWith(BEACON_SITES_URL+'?')){listGets++;return responseJson({data:[],totalCount:101,limit:100,offset:0})}throw Error(`unexpected ${url}`)}});
  assert.equal(result.status,'unknown');assert.equal(listGets,1);
});

test('owned-site pagination validates totalCount before accepting a matching row',async()=>{
  const saved=memory(),intent=publishIntent();let listGets=0;
  const result=await recoverBeaconPublication(intent,article,apiKey,saved.persistence,{fetch:async(url,init)=>{assert.equal(init.method,'GET');if(url===beaconSiteUrl(slug))return responseJson(ownerDetail());if(url===`${BEACON_SITES_URL}?limit=100&offset=0`){listGets++;return responseJson({data:[ownerDetail().site],totalCount:0,limit:100,offset:0})}throw Error(`unexpected ${url}`)}});
  assert.equal(result.status,'unknown');assert.equal(listGets,1);
});

test('server error text cannot expose a token or OTP through the result',async()=>{
  const saved=memory(),secret='123456';
  const result=await verifyBeaconOtp({operationId:op('d'),email,code:secret},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>responseJson({error:`bad ${secret} ${apiKey}`},400)});
  assert.equal(result.status,'rejected');assert.equal(JSON.stringify(result).includes(secret),false);assert.equal(JSON.stringify(result).includes(apiKey),false);
});

test('anonymous and expiring publish receipts are rejected even when the status is successful',async()=>{
  for(const changes of [{anonymous:true},{expiresAt:'2026-10-25T08:00:00.000Z'}]){
    const saved=memory();const result=await publishBeaconArticle({operationId:op('e'),apiKey,article},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>new Response(publishBody(changes),{status:201,headers:{'content-type':'application/json'}})});assert.equal(result.status,'rejected');assert.ok(result.status==='rejected'&&result.diagnostic==='schema');
  }
});

test('verification checks the tenant page, tenant robots, owner permanence and the native target link',async()=>{
  const ok=verificationFetch(),verified=await verifyBeaconPublication(receipt(),article,apiKey,{fetch:ok.fetch});assert.equal(verified.status,'usable');assert.ok(ok.seen.includes(`${beaconPublicUrl(slug)}robots.txt`));assert.equal(ok.seen.includes(`${BEACON_ORIGIN}/robots.txt`),false);
  const noindex=article.html.replace('</head>','<meta name="robots" content="noindex"></head>');assert.deepEqual(await verifyBeaconPublication(receipt(),article,apiKey,{fetch:verificationFetch({page:noindex}).fetch}),{status:'invalid',reason:'indexing'});
  assert.deepEqual(await verifyBeaconPublication(receipt(),article,apiKey,{fetch:verificationFetch({robots:'User-agent: *\nDisallow: /\n'}).fetch}),{status:'invalid',reason:'robots'});
  assert.deepEqual(await verifyBeaconPublication(receipt(),article,apiKey,{fetch:verificationFetch({expiresAt:'2026-10-25T08:00:00.000Z'}).fetch}),{status:'invalid',reason:'owner'});
  const missingLink=article.html.replace('href="https://example.com/product"','href="https://example.com/other"');assert.deepEqual(await verifyBeaconPublication(receipt(),article,apiKey,{fetch:verificationFetch({page:missingLink}).fetch}),{status:'invalid',reason:'content'});
});

test('robots evaluation keeps crawler groups separate and supports wildcard rules',async()=>{
  for(const robots of [
    'User-agent: Googlebot\nDisallow: /\n\nUser-agent: Bingbot\nAllow: /\n',
    'User-agent: *\nDisallow: /*\n',
    'User-agent: Googlebot\nUser-agent: Otherbot\nDisallow: /\n',
    'User-agent: *\rDisallow: /\r',
  ])assert.deepEqual(await verifyBeaconPublication(receipt(),article,apiKey,{fetch:verificationFetch({robots}).fetch}),{status:'invalid',reason:'robots'});
  const longest='User-agent: *\nDisallow: /*\nAllow: /$\n';assert.equal((await verifyBeaconPublication(receipt(),article,apiKey,{fetch:verificationFetch({robots:longest}).fetch})).status,'usable');
});

test('verification and recovery recompute HTML, markdown, target and request bindings',async()=>{
  const edited=renderBeaconArticle({draft:{...draft,body:'A different article still links to the [product documentation](https://example.com/product).'},targetUrl,language:'en',slug}),stale={...edited,sourceHash:article.sourceHash,requestHash:article.requestHash};
  assert.deepEqual(await verifyBeaconPublication(receipt(),stale,apiKey,{fetch:verificationFetch({page:edited.html}).fetch}),{status:'invalid',reason:'binding'});
  assert.deepEqual(await recoverBeaconPublication(publishIntent(),stale,apiKey,memory().persistence,{fetch:async()=>{throw Error('must not fetch')}}),{status:'unknown'});
  const staleMarkdown={...article,markdown:'Changed Markdown with a [product link](https://example.com/product).'};assert.deepEqual(await verifyBeaconPublication(receipt(),staleMarkdown,apiKey,{fetch:async()=>{throw Error('must not fetch')}}),{status:'invalid',reason:'binding'});
  const staleTarget={...article,targetUrl:'https://example.com/other'};assert.deepEqual(await verifyBeaconPublication(receipt(),staleTarget,apiKey,{fetch:async()=>{throw Error('must not fetch')}}),{status:'invalid',reason:'binding'});
});

test('oversized response is bounded and cannot be mistaken for success',async()=>{
  const saved=memory(),chunk=new Uint8Array(64*1024);let cancelled=0;
  const body=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(chunk)},cancel(){cancelled++}});
  const result=await publishBeaconArticle({operationId:op('f'),apiKey,article},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>new Response(body,{status:201,headers:{'content-type':'application/json'}})});
  assert.equal(result.status,'unknown');assert.ok(result.status==='unknown'&&result.diagnostic==='body_limit');assert.equal(cancelled,1);assert.ok(BEACON_MAX_RESPONSE_BYTES>=chunk.byteLength);
});

