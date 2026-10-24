import assert from 'node:assert/strict';
import test from 'node:test';
import {marked} from 'marked';
import {
  MDLIB_ACCOUNT_PROBE_URL,MDLIB_DOCUMENTS_URL,MDLIB_MAX_RESPONSE_BYTES,MDLIB_ROBOTS_URL,
  mdlibFallbackPublicUrl,mdlibRequestHash,mdlibStatusUrl,prepareMdlibDocument,probeMdlibAccount,
  publishMdlibDocument,recoverMdlibPublication,verifyMdlibPublication,
  type MdlibOpaqueResponse,type MdlibPersistence,type MdlibPublicationReceipt,type MdlibPublishIntent,
} from '../src/integrations/mdlib';

const now='2026-10-24T08:00:00.000Z';
const apiKey=`mdlib_${'a'.repeat(32)}`;
const editKey=`ek_${'b'.repeat(32)}`;
const slug='checked-import-guide';
const title='Check an import before using real data';
const targetUrl='https://example.com/product';
const markdown=`# ${title}\n\nTest five synthetic rows before using real data.\n\n## Verify the result\n\nCompare the output with the [product documentation](${targetUrl}), then remove the sample rows.`;
const document=prepareMdlibDocument({title,markdown,targetUrl,slug});
const operationId=`mdlib_${'c'.repeat(32)}`;

function responseJson(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})}
function publishPayload(changes:Record<string,unknown>={}){return {url:mdlibFallbackPublicUrl(slug),slug,edit_key:editKey,created_at:now,expires_at:null,...changes}}
function statusPayload(expiresAt:null|string=null){return {slug,title,word_count:25,created_at:now,updated_at:now,expires_at:expiresAt}}
function page(options:{noindex?:boolean;target?:string}={}){
  const source=options.target?markdown.replace(targetUrl,options.target):markdown;
  return `<!doctype html><html><head><title>${title}</title>${options.noindex?'<meta name="robots" content="noindex">':''}</head><body><main><article>${marked.parse(source)}</article></main></body></html>`;
}

function memory(options:{failIntent?:boolean;failOpaque?:boolean;failPromotion?:boolean}={}){
  const events:string[]=[],opaque=new Map<string,MdlibOpaqueResponse>();let intent:MdlibPublishIntent|undefined,secret:string|undefined,receipt:MdlibPublicationReceipt|undefined;
  const persistence:MdlibPersistence={
    secretStorage:'encrypted',
    async persistIntent(value){events.push('intent');if(options.failIntent)throw Error('disk');intent=structuredClone(value)},
    assertReadyToSubmit(value){events.push('authorize');assert.deepEqual(value,intent);return true},
    async persistOpaqueResponse(value){events.push('opaque');if(options.failOpaque)throw Error('disk');opaque.set(value.operationId,structuredClone(value))},
    async loadOpaqueResponse(id){return opaque.get(id)},
    async promotePublication(value){events.push('publication');if(options.failPromotion)throw Error('disk');secret=value.editKey;receipt=structuredClone(value.receipt)},
  };
  return {persistence,events,opaque,get intent(){return intent},get secret(){return secret},get receipt(){return receipt}};
}
function publishInput(priorIntent?:MdlibPublishIntent){return {operationId,apiKey,document,reviewed:true as const,accountApiReadConfirmed:true as const,accountNoExpiryConfirmed:true as const,...(priorIntent?{priorIntent}:{})}}

function verificationFetch(options:{noindex?:boolean;robots?:string;expiresAt?:null|string;target?:string}={}){
  const calls:string[]=[];
  const fetch=async(url:string,init:RequestInit)=>{
    calls.push(url);assert.equal(init.method,'GET');
    if(url===mdlibStatusUrl(slug))return responseJson(statusPayload(options.expiresAt??null));
    if(url===mdlibFallbackPublicUrl(slug))return new Response(page(options),{status:200,headers:{'content-type':'text/html; charset=utf-8'}});
    if(url===MDLIB_ROBOTS_URL)return new Response(options.robots??'User-agent: *\nAllow: /\n',{status:200,headers:{'content-type':'text/plain'}});
    throw Error(`unexpected ${url}`);
  };
  return {fetch,calls};
}

test('document preparation binds the reviewed Markdown, target and exact public create body',()=>{
  assert.equal(document.requestHash,mdlibRequestHash(document));
  assert.equal(document.targetUrl,targetUrl);
  assert.equal(document.markdown,markdown);
  assert.throws(()=>prepareMdlibDocument({title,slug,targetUrl,markdown:'# Missing reviewed link'}));
});

test('account probe is GET-only and leaves authentication unconfirmed without an official list schema',async()=>{
  let calls=0;
  const result=await probeMdlibAccount(apiKey,{fetch:async(url,init)=>{calls++;assert.equal(url,MDLIB_ACCOUNT_PROBE_URL);assert.equal(init.method,'GET');assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${apiKey}`);return responseJson({documents:[],page:1})}});
  assert.equal(calls,1);assert.equal(result.status,'unconfirmed');
  if(result.status==='unconfirmed'){assert.equal(result.authenticated,'not_established');assert.equal(result.reason,'official_list_response_schema_not_documented');assert.equal(result.plan,'not_exposed_by_public_api');assert.equal(result.accountExpiry,'not_exposed_by_public_api')}
  for(const value of [null,{error:'unauthenticated'}])assert.deepEqual(await probeMdlibAccount(apiKey,{fetch:async()=>responseJson(value)}),{status:'unknown',diagnostic:'schema'});
});

test('external writes are closed by default and intent persistence failure makes zero POSTs',async()=>{
  let posts=0;
  assert.deepEqual(await publishMdlibDocument(publishInput(),memory().persistence,{fetch:async()=>{posts++;throw Error('must not call')}}),{status:'not_started',reason:'external_write_disabled'});
  assert.deepEqual(await publishMdlibDocument(publishInput(),memory({failIntent:true}).persistence,{allowExternalWrite:true,fetch:async()=>{posts++;throw Error('must not call')}}),{status:'not_started',reason:'intent_not_persisted'});
  assert.equal(posts,0);
});

test('publish requires the independent account-page no-expiry confirmation',async()=>{
  let calls=0;
  const input={...publishInput(),accountNoExpiryConfirmed:false} as unknown as Parameters<typeof publishMdlibDocument>[0];
  assert.deepEqual(await publishMdlibDocument(input,memory().persistence,{allowExternalWrite:true,fetch:async()=>{calls++;throw Error('must not call')}}),{status:'not_started',reason:'account_check_required'});
  assert.equal(calls,0);
});

test('authenticated publish persists intent and opaque response before encrypting the edit key',async()=>{
  const saved=memory();let posts=0;
  const result=await publishMdlibDocument(publishInput(),saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{
    posts++;assert.equal(url,MDLIB_DOCUMENTS_URL);assert.equal(init.method,'POST');const headers=new Headers(init.headers);assert.equal(headers.get('authorization'),`Bearer ${apiKey}`);
    assert.deepEqual(JSON.parse(String(init.body)),{markdown,title,slug,is_public:true});return responseJson(publishPayload(),201);
  }});
  assert.equal(result.status,'created');assert.equal(posts,1);assert.deepEqual(saved.events,['intent','authorize','opaque','publication']);assert.equal(saved.secret,editKey);assert.equal(saved.receipt?.expiresAt,null);
  assert.equal(JSON.stringify(result).includes(apiKey),false);assert.equal(JSON.stringify(result).includes(editKey),false);assert.equal(saved.receipt?.management.editKey,'encrypted');
});

test('expiring or secret-less success responses are rejected and never promoted',async()=>{
  for(const changes of [{expires_at:'2026-10-31T08:00:00.000Z'},{edit_key:undefined}]){
    const saved=memory();const result=await publishMdlibDocument(publishInput(),saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>responseJson(publishPayload(changes),201)});
    assert.equal(result.status,'rejected');assert.equal(saved.secret,undefined);
  }
});

test('a transport-unknown intent cannot issue a second POST',async()=>{
  const saved=memory();let posts=0;
  const first=await publishMdlibDocument(publishInput(),saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>{posts++;throw Error('lost response')}});
  assert.equal(first.status,'unknown');assert.equal(posts,1);assert.ok(saved.intent);
  const second=await publishMdlibDocument(publishInput(saved.intent),saved.persistence,{allowExternalWrite:true,fetch:async()=>{posts++;throw Error('must not call')}});
  assert.equal(second.status,'blocked');assert.equal(posts,1);
});

test('verification requires no scheduled expiry, indexability, robots allowance and the exact native link',async()=>{
  const saved=memory();const created=await publishMdlibDocument(publishInput(),saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>responseJson(publishPayload(),201)});assert.equal(created.status,'created');if(created.status!=='created')return;
  const ok=verificationFetch(),verified=await verifyMdlibPublication(created.receipt,document,apiKey,{fetch:ok.fetch});assert.equal(verified.status,'usable');assert.deepEqual(ok.calls.sort(),[MDLIB_ROBOTS_URL,mdlibFallbackPublicUrl(slug),mdlibStatusUrl(slug)].sort());
  assert.deepEqual(await verifyMdlibPublication(created.receipt,document,apiKey,{fetch:verificationFetch({noindex:true}).fetch}),{status:'invalid',reason:'indexing'});
  assert.deepEqual(await verifyMdlibPublication(created.receipt,document,apiKey,{fetch:verificationFetch({robots:'User-agent: *\nDisallow: /\n'}).fetch}),{status:'invalid',reason:'robots'});
  assert.deepEqual(await verifyMdlibPublication(created.receipt,document,apiKey,{fetch:verificationFetch({expiresAt:'2026-10-31T08:00:00.000Z'}).fetch}),{status:'invalid',reason:'expiry'});
  assert.deepEqual(await verifyMdlibPublication(created.receipt,document,apiKey,{fetch:verificationFetch({target:'https://example.com/other'}).fetch}),{status:'invalid',reason:'content'});
  const malformed={...created.receipt,management:undefined} as unknown as MdlibPublicationReceipt;
  assert.deepEqual(await verifyMdlibPublication(malformed,document,apiKey,{fetch:async()=>{throw Error('must not fetch')}}),{status:'invalid',reason:'binding'});
});

test('saved opaque response recovery is GET-only and promotes the original edit key',async()=>{
  const saved=memory();let posts=0;
  const created=await publishMdlibDocument(publishInput(),saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>{posts++;return responseJson(publishPayload(),201)}});assert.equal(created.status,'created');assert.ok(saved.intent);
  saved.events.length=0;const reads=verificationFetch();const recovered=await recoverMdlibPublication(saved.intent!,document,apiKey,saved.persistence,{fetch:reads.fetch});
  assert.equal(recovered.status,'accepted');assert.equal(posts,1);assert.deepEqual(saved.events,['publication']);assert.equal(saved.secret,editKey);assert.ok(reads.calls.every(url=>url!==MDLIB_DOCUMENTS_URL));
});

test('opaque recovery cannot report accepted until receipt and edit key promotion succeeds',async()=>{
  const seeded=memory();await publishMdlibDocument(publishInput(),seeded.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>responseJson(publishPayload(),201)});assert.ok(seeded.intent);assert.ok(seeded.opaque.get(operationId));
  const failing=memory({failPromotion:true});failing.opaque.set(operationId,seeded.opaque.get(operationId)!);
  const result=await recoverMdlibPublication(seeded.intent!,document,apiKey,failing.persistence,{fetch:verificationFetch().fetch});
  assert.equal(result.status,'storage_pending');assert.equal(failing.receipt,undefined);assert.equal(failing.secret,undefined);
  if(result.status==='storage_pending'){assert.equal(result.reason,'publication_secret_not_confirmed');assert.equal(result.verification.status,'usable')}
});

test('public GET recovery without the opaque response reports the ownership/edit-key gap',async()=>{
  const seeded=memory();await publishMdlibDocument(publishInput(),seeded.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>{throw Error('lost')}});assert.ok(seeded.intent);
  const clean=memory(),reads=verificationFetch();const result=await recoverMdlibPublication(seeded.intent!,document,apiKey,clean.persistence,{fetch:reads.fetch});
  assert.deepEqual(result,{status:'found_unowned',reason:'public_get_cannot_prove_account_ownership_or_recover_edit_key',publicUrl:mdlibFallbackPublicUrl(slug),expiresAt:null});assert.deepEqual(reads.calls,[mdlibStatusUrl(slug),mdlibFallbackPublicUrl(slug)]);
});

test('oversized mutation response is bounded and cannot become success',async()=>{
  const chunk=new Uint8Array(MDLIB_MAX_RESPONSE_BYTES);let cancelled=0;
  const body=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(chunk)},cancel(){cancelled++}});
  const result=await publishMdlibDocument(publishInput(),memory().persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>new Response(body,{status:201,headers:{'content-type':'application/json'}})});
  assert.equal(result.status,'unknown');assert.ok(result.status==='unknown'&&result.diagnostic==='body_limit');assert.equal(cancelled,1);
});
