import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from 'cheerio';
import {createTheThingsPage,parseTheThingsCreated,theThingsHash,theThingsPublicUrl,theThingsRequest,THETHINGS_CREATE,type TheThingsIntent,type TheThingsPersistence} from '../src/integrations/thethings';
import {OPENAGENTCHAT_MAX_RESPONSE_BYTES,type OpenAgentChatOpaqueResponse,type OpenAgentChatRenderedPage} from '../src/integrations/openagentchat';
import {verifyTheThingsPublication} from '../src/integrations/thethings-publisher';
import {TheThingsVerificationError} from '../src/integrations/thethings-public';
import {theThingsTaskIdentity} from '../src/main/thethings-publication';
import {theThingsMainResponseOutcome} from '../src/main/thethings-renderer-policy';
import type {Site,Task} from '../src/shared/types';

const input={operationId:'thethings_'+'a'.repeat(32),reviewed:true as const,title:'An import preview',summary:'Explain which records will change.',html:'<!doctype html>\n<html><body><article>Approved content</article></body></html>'};
const request=theThingsRequest(input.title,input.summary,input.html);
const intent:TheThingsIntent={version:1,operationId:input.operationId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:'2026-10-17T00:00:00.000Z'};
const value={url:theThingsPublicUrl('example123'),claim_url:'https://thethings.ai/claim/fixture-secret',notice:'Anonymous pages cannot be edited. Claim requires sign in.'};
function opaque(value:unknown,status=201):OpenAgentChatOpaqueResponse {const bytes=JSON.stringify(value);return {version:1,capturedAt:intent.createdAt,requestUrl:THETHINGS_CREATE,status,contentType:'application/json',responseUrl:THETHINGS_CREATE,redirected:false,responseType:'basic',headers:[],bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:theThingsHash(bytes),bodyComplete:true}}
function fixture(prior?:string){const events:string[]=[],saved:unknown[]=[];let raw=prior;const persistence:TheThingsPersistence={loadPriorRaw:async()=>raw,persistIntent:async v=>{events.push('intent');raw=JSON.stringify(v);saved.push(v)},assertAuthorized:()=>{events.push('authorize');return true},persistOpaque:async(_i,v)=>{events.push('opaque');saved.push(v)},persistCreated:async v=>{events.push('created');saved.push(v)}};return {events,saved,persistence}}
test('anonymous payload has only supported fields; no misleading private mode or chosen slug',()=>{assert.deepEqual(Object.keys(JSON.parse(request.body)),['content','content_type','title','summary']);assert.equal(parseTheThingsCreated(opaque({...value,extra:'official optional field'}),intent)?.receipt.publicUrl,value.url);assert.ok(parseTheThingsCreated(opaque(value,200),intent));assert.throws(()=>theThingsRequest(input.title,'\n',input.html));assert.throws(()=>theThingsRequest(input.title,input.summary,'x'));});
test('public URL and one-time claim remain bound to exact origin without credentials or fragments',()=>{for(const url of ['https://evil.example/p/scratch/example123','https://thethings.ai/p/owner/example123',value.url+'?x=1',value.url+'#x',value.url+'/'])assert.equal(parseTheThingsCreated(opaque({...value,url}),intent),undefined);for(const claim_url of ['https://evil.example/claim/x','http://thethings.ai/claim/x','https://a@thethings.ai/claim/x','https://thethings.ai/claim/x#x'])assert.equal(parseTheThingsCreated(opaque({...value,claim_url}),intent),undefined)});
test('malformed, incomplete, modified, non-JSON and foreign response envelopes cannot promote',()=>{for(const patch of [{status:503},{bodyComplete:false},{bodySha256:'b'.repeat(64)},{requestUrl:THETHINGS_CREATE+'/elsewhere'},{responseUrl:'https://evil.example'},{redirected:true},{contentType:'text/html'}])assert.equal(parseTheThingsCreated({...opaque(value),...patch},intent),undefined);assert.equal(parseTheThingsCreated(opaque({...value,claim_url:undefined}),intent),undefined);});
test('one POST journals headers, body prefix and completion before parsing; claim link never leaves public result',async()=>{const f=fixture();let writes=0;const result=await createTheThingsPage(input,f.persistence,{now:()=>new Date(intent.createdAt),fetch:async(url,init)=>{writes++;assert.equal(url,THETHINGS_CREATE);assert.equal(init.method,'POST');assert.equal(init.redirect,'manual');assert.equal(new Headers(init.headers).get('authorization'),null);assert.equal(init.body,request.body);assert.deepEqual(f.events,['intent','authorize']);return new Response(JSON.stringify(value),{status:201,headers:{'content-type':'application/json'}})}});assert.equal(writes,1);assert.equal(result.status,'created');assert.deepEqual(f.events,['intent','authorize','opaque','opaque','opaque','created']);const snapshots=f.saved.slice(1,-1) as OpenAgentChatOpaqueResponse[];assert.deepEqual(snapshots.map(item=>[Buffer.from(item.bodyBase64,'base64').length,item.bodyComplete]),[[0,false],[Buffer.byteLength(JSON.stringify(value)),false],[Buffer.byteLength(JSON.stringify(value)),true]]);assert.equal(JSON.stringify(result).includes('fixture-secret'),false);assert.equal((await createTheThingsPage(input,f.persistence,{fetch:async()=>{throw Error('must not retry')}})).status,'prior_intent');});
test('decoded compressed response seals without comparing decoded bytes to wire length',async()=>{const f=fixture();let writes=0;const result=await createTheThingsPage(input,f.persistence,{now:()=>new Date(intent.createdAt),fetch:async()=>{writes++;return new Response(JSON.stringify(value),{status:201,headers:{'content-type':'application/json','content-encoding':'gzip','content-length':'1'}})}});assert.equal(result.status,'created');assert.equal(writes,1);const complete=(f.saved as OpenAgentChatOpaqueResponse[]).find(item=>item?.bodyComplete===true);assert.ok(complete);assert.equal(Buffer.from(complete.bodyBase64,'base64').toString(),JSON.stringify(value));assert.deepEqual(complete.headers.filter(([name])=>['content-encoding','content-length'].includes(name)),[['content-encoding','gzip'],['content-length','1']]);assert.equal((await createTheThingsPage(input,f.persistence,{fetch:async()=>{writes++;throw Error('must not retry')}})).status,'prior_intent');assert.equal(writes,1)});
test('unsupported encoding and excessive wire length stay incomplete and prohibit retry',async t=>{for(const [name,headers] of [['encoding',{'content-encoding':'compress','content-length':'1'}],['length',{'content-encoding':'gzip','content-length':String(OPENAGENTCHAT_MAX_RESPONSE_BYTES+1)}]] as const)await t.test(name,async()=>{const f=fixture();let writes=0;const result=await createTheThingsPage(input,f.persistence,{now:()=>new Date(intent.createdAt),fetch:async()=>{writes++;return new Response(JSON.stringify(value),{status:201,headers:{'content-type':'application/json',...headers}})}});assert.equal(result.status,'unknown');assert.deepEqual(f.events,['intent','authorize','opaque']);const saved=f.saved[1] as OpenAgentChatOpaqueResponse;assert.equal(saved.bodyBase64,'');assert.equal(saved.bodyComplete,false);assert.equal((await createTheThingsPage(input,f.persistence,{fetch:async()=>{writes++;throw Error('must not retry')}})).status,'prior_intent');assert.equal(writes,1)})});
test('all prior journals including empty and corrupt prohibit another registration-free write',async()=>{for(const raw of ['', '{', '{}']){const f=fixture(raw);let requests=0;const result=await createTheThingsPage(input,f.persistence,{fetch:async()=>{requests++;throw Error('unexpected')}});assert.equal(result.status,'prior_intent');assert.equal(requests,0);assert.deepEqual(f.events,[])}});
test('pre-abort or intent persistence failure performs no external request',async()=>{for(const mode of ['abort','persistence']){const f=fixture();const ac=new AbortController();if(mode==='abort')ac.abort();else f.persistence.persistIntent=async()=>{throw Error('disk unavailable')};let requests=0;assert.equal((await createTheThingsPage(input,f.persistence,{signal:ac.signal,fetch:async()=>{requests++;throw Error('unexpected')}})).status,'not_started');assert.equal(requests,0)}});
test('unparseable or error HTTP response is retained as unknown, not repeated',async()=>{for(const status of [201,503]){const f=fixture();let writes=0;const deps={fetch:async()=>{writes++;return new Response('not-json',{status,headers:{'content-type':'application/json'}})}};assert.equal((await createTheThingsPage(input,f.persistence,deps)).status,'unknown');assert.deepEqual(f.events,['intent','authorize','opaque','opaque','opaque']);assert.equal((await createTheThingsPage(input,f.persistence,deps)).status,'prior_intent');assert.equal(writes,1)}});
test('failed receipt promotion keeps original evidence without returning claim secret',async()=>{const f=fixture();f.persistence.persistCreated=async()=>{throw Error('save unavailable')};const result=await createTheThingsPage(input,f.persistence,{fetch:async()=>new Response(JSON.stringify(value),{status:201,headers:{'content-type':'application/json'}})});assert.equal(result.status,'persistence_unknown');assert.deepEqual(f.events,['intent','authorize','opaque','opaque','opaque']);assert.equal(JSON.stringify(result).includes('fixture-secret'),false)});

const verificationAt='2026-10-18T00:00:00.000Z';
const verificationSlug='example-guide-123';
const verificationUrl=theThingsPublicUrl(verificationSlug);
const verificationTarget='https://example.com/guide';
function verificationFixture(){
 const site:Site={
  id:'22222222-2222-4222-8222-222222222222',domain:'example.com',url:'https://example.com/',
  email:'owner@example.com',name:'Example',description:'Independent example guide',category:'software',
  language:'en',monthlyTarget:1,status:'ready',createdAt:verificationAt,
 };
 const task:Task={
  id:'11111111-1111-4111-8111-111111111111',siteId:site.id,channelId:'thethings',sourceDomain:'thethings.ai',
  status:'review',createdAt:verificationAt,scheduledAt:verificationAt,updatedAt:verificationAt,attempts:1,
  message:'',topicUrl:verificationTarget,submittedAt:verificationAt,publicUrl:verificationUrl,
  draft:{
   title:'Checking an example source',description:'A focused example for deterministic verification.',
   body:`## Check the source\n\nRead the [example guide](${verificationTarget}) before publishing.\n\n## Preserve the result\n\nKeep the reviewed text and public receipt together.`,
  },
 };
 const identity=theThingsTaskIdentity(task,site);assert.ok(identity);
 task.theThings={
  version:1,operationId:'thethings_'+task.id.replaceAll('-',''),sourceHash:identity.sourceHash,
  requestHash:identity.requestHash,createdAt:verificationAt,stage:'api_receipt',slug:verificationSlug,
 };
 return {site,task,identity};
}
function verificationPage(change:Partial<OpenAgentChatRenderedPage&{occlusionClear:boolean}>={}):OpenAgentChatRenderedPage&{occlusionClear:boolean}{
 const {identity}=verificationFixture(),$=load(identity.html),section=$('article > section').first();
 const anchor=section.find(`a[href="${verificationTarget}"]`).first(),bytes=Buffer.byteLength(identity.html);
 return {
  url:verificationUrl,documentTitle:identity.title,headings:[{text:identity.title,visible:true}],
  candidates:[{
   selector:'article > section',html:identity.html,text:section.text(),allTextVisible:true,
   links:[{
    href:verificationTarget,rel:(anchor.attr('rel')??'').split(/\s+/).filter(Boolean),
    text:anchor.text(),visible:true,
   }],
  }],
  robots:[],canonicals:[verificationUrl],occlusionClear:true,hasRefresh:false,hasPasswordGate:false,
  hasLoginGate:false,responseRobots:[],responseLinks:[],responseStatus:200,responseMediaType:'text/html',
  responseBodyBytes:bytes,responseEncodedBodyBytes:bytes,
  nativeRequests:[{url:verificationUrl,method:'GET',resourceType:'mainFrame'}],...change,
 };
}
const robotsMissing=async()=>new Response('',{status:404});

test('TheThings distinguishes absent pages, invalid public content, and temporary reads',async()=>{
 for(const status of [404,410]){
  const {task,site}=verificationFixture();
  const result=await verifyTheThingsPublication(task,site,{
   fetch:robotsMissing,renderPage:async()=>verificationPage({responseStatus:status}),
  });
  assert.equal(result.outcome,'absent');
 }
 const invalidPages=[
  verificationPage({robots:[{name:'robots',content:'noindex'}]}),
  verificationPage({candidates:[{...verificationPage().candidates[0],links:[]}]}),
 ];
 for(const page of invalidPages){
  const {task,site}=verificationFixture();
  const result=await verifyTheThingsPublication(task,site,{fetch:robotsMissing,renderPage:async()=>page});
  assert.equal(result.outcome,'invalid');
 }
 const unavailableDependencies=[
  {fetch:async()=>{throw Error('dns unavailable')},renderPage:async()=>verificationPage()},
  {fetch:robotsMissing,renderPage:async()=>{throw Error('transport unavailable')}},
  {fetch:robotsMissing,renderPage:async()=>verificationPage({responseStatus:429})},
 ];
 for(const deps of unavailableDependencies){
  const {task,site}=verificationFixture(),result=await verifyTheThingsPublication(task,site,deps);
  assert.equal(result.outcome,'unreachable');
 }
});

test('TheThings native renderer preserves deterministic main-response outcomes',async()=>{
 assert.equal(theThingsMainResponseOutcome(404,'text/html',true),'absent');
 assert.equal(theThingsMainResponseOutcome(410,'text/html',true),'absent');
 assert.equal(theThingsMainResponseOutcome(429,'text/html',true),'unreachable');
 assert.equal(theThingsMainResponseOutcome(503,'text/html',true),'unreachable');
 assert.equal(theThingsMainResponseOutcome(200,'text/plain',true),'invalid');
 assert.equal(theThingsMainResponseOutcome(200,'text/html',false),'invalid');
 assert.equal(theThingsMainResponseOutcome(200,'text/html',true),undefined);
 for(const outcome of ['absent','invalid'] as const){
  const {task,site}=verificationFixture();
  const result=await verifyTheThingsPublication(task,site,{
   fetch:robotsMissing,
   renderPage:async()=>{throw new TheThingsVerificationError(outcome,'synthetic renderer decision')},
  });
  assert.equal(result.outcome,outcome);
 }
});

test('TheThings local receipt and identity inconsistencies are unreachable',async()=>{
 const first=verificationFixture();delete first.task.theThings;
 let result=await verifyTheThingsPublication(first.task,first.site,{
  fetch:robotsMissing,renderPage:async()=>verificationPage(),
 });
 assert.equal(result.outcome,'unreachable');
 const second=verificationFixture();second.task.theThings!.sourceHash='f'.repeat(64);
 result=await verifyTheThingsPublication(second.task,second.site,{
  fetch:robotsMissing,renderPage:async()=>verificationPage(),
 });
 assert.equal(result.outcome,'unreachable');
});
