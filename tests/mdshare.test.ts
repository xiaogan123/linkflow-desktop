import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {marked} from 'marked';
import {load} from 'cheerio';
import {CHANNELS} from '../src/integrations/catalog';
import {createMDShareSnippet,drainMDShareLateResponses,mdsharePublicUrl,mdshareRequest,parseStoredMDShareCreateResponse,MDSHARE_CREATE_URL,type MDShareIntent,type MDShareOpaqueResponse,type MDSharePersistence,type MDShareRenderedPage} from '../src/integrations/mdshare';
import {mdsharePublisherTesting,verifyMDSharePublication} from '../src/integrations/mdshare-publisher';
import {Controller,isConfirmedMDShareResultUrl} from '../src/main/controller';
import {validateBackup} from '../src/main/backup-validation';
import {mdshareTaskIdentity,parseMDShareOpaqueResponseSecret} from '../src/main/mdshare-publication';
import {Store,emptyState} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import type {Site,Task} from '../src/shared/types';

const at='2026-10-13T03:00:00.000Z',taskId='11111111-1111-4111-8111-111111111111',siteId='22222222-2222-4222-8222-222222222222',slug='Ab3dEf6hIj9K',url=mdsharePublicUrl(slug),target='https://example.test/guide';
const draft={title:'Safe settings recovery',description:'Practical developer guide',body:'Before changing shared settings, preserve the previous value and validate the replacement. The [project guide](https://example.test/guide) gives a complete rollback procedure.'};
function site():Site{return {id:siteId,domain:'example.test',url:'https://example.test/',email:'owner@example.test',name:'Example software',description:'Developer software',category:'software',language:'en',monthlyTarget:1,articleReviewMode:'manual',qualifications:{software:'https://example.test/product',developer:target},status:'ready',createdAt:at,analyzedAt:at,topicsCheckedAt:at,topics:[{url:target,discoveredAt:at}]}}
function task(extra:Partial<Task>={}):Task{return {id:taskId,siteId,channelId:'mdshare',sourceDomain:'mdshare.org',status:'queued',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'fixture',topicUrl:target,draft,draftRevision:1,articleApprovedAt:at,health:'pending',...extra}}
function identity(){const value=mdshareTaskIdentity(task(),site());assert.ok(value);return value}
function intent():MDShareIntent{const value=identity();return {operationId:'mdshare_11111111111141118111111111111111',sourceHash:value.sourceHash,requestHash:value.requestHash,createdAt:at}}
function responseValue(){const value=identity();return {snippet:{slug,title:value.title,language:'markdown',visibility:'public',require_login:true,workspace_id:null,source:'web',is_encrypted:false,size_bytes:Buffer.byteLength(value.content),view_count:1,max_views:null,burn_after_read:false,is_burned:false,expires_at:null,tags:[],created_at:at,updated_at:at},body:value.content,gates:[],settings:null,is_owner:false,author_handle:null,author_role:null,viewer_fork_slug:null,forked_from:null,workspace:null,workspaces:[],shared_with_count:null,star_count:0,viewer_has_starred:false,url,raw_url:`https://mdshare.org/raw/${slug}`}}
function success(){return new Response(JSON.stringify(responseValue()),{status:201,headers:{'content-type':'application/json'}})}
function memory(){let attempted=false,opaque:MDShareOpaqueResponse|undefined,receipt:unknown;const order:string[]=[];const persistence:MDSharePersistence={async persistIntent(){if(attempted)throw Error('repeated');attempted=true;order.push('intent')},assertReadyToSubmit(){return true},async persistOpaqueResponse(value){opaque=value;order.push('opaque')},async loadOpaqueResponse(){return opaque},async promoteReceipt(value){receipt=value;order.push('receipt')}};return {persistence,order,getOpaque:()=>opaque,getReceipt:()=>receipt}}
function fixture(){const dir=mkdtempSync(join(tmpdir(),'linkflow-mdshare-')),path=join(dir,'state.sqlite'),store=new Store(path),state=emptyState();state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='manual';state.settings.timezone='UTC';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(channel=>[channel.id,channel.id==='mdshare']));state.sites=[site()];state.tasks=[task()];store.update(current=>Object.assign(current,state));return {dir,path,store,cleanup(){try{store.close()}catch{}rmSync(dir,{recursive:true,force:true})}}}
function vault(store:Store):Vault{return {ready:true,available:()=>true,get:async(key:string)=>{const cipher=store.getCipher(key);return cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():undefined},set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))} as unknown as Vault}
function rendered():MDShareRenderedPage{const content=identity().content,articleHtml=`<div class="ms-preview ms-md">${String(marked.parse(content,{gfm:true,async:false}))}</div>`,articleText=load(articleHtml,undefined,false).root().text();return {url,title:`${identity().title} - MDShare`,bodyText:articleText,articleText,allArticleTextVisible:true,articleHtml,links:[{href:target,rel:[],text:'project guide',visible:true}],robots:[{name:'robots',content:'index, follow, max-snippet:-1'}],responseRobots:[],canonicals:[url],hasRefresh:false,hasPasswordGate:false,hasLoginGate:false,nativeRequests:[{url,method:'GET',resourceType:'mainFrame'}]}}
function dependencies(store:Store,calls:Array<{method:string;url:string}>,options:{unknown?:boolean;badRender?:boolean}={}){return {fetch:async(request:string,init:RequestInit)=>{const method=init.method??'GET';calls.push({method,url:request});if(method==='POST'){const saved=store.read().tasks[0];assert.equal(saved.mdshare?.stage,'submitting');assert.equal(saved.checkpoint,'mdshare_create_submitting');assert.deepEqual(JSON.parse(String(init.body)),mdshareRequest(identity().title,identity().content).value);return options.unknown?new Response('anonymous writes disabled',{status:403,headers:{'content-type':'application/json'}}):success()}if(request===`https://mdshare.org/api/v1/snippets/${slug}`)return new Response(JSON.stringify(responseValue()),{status:200,headers:{'content-type':'application/json'}});if(request==='https://mdshare.org/robots.txt')return new Response('User-agent: *\nDisallow: /api/\nDisallow: /raw/\nDisallow: /embed/\nAllow: /s/\n',{status:200,headers:{'content-type':'text/plain'}});assert.equal(request,url);return new Response(`<!doctype html><html><head><title>${identity().title} - MDShare</title><link rel="canonical" href="${url}"><meta name="robots" content="index, follow"></head><body><div id="root"></div></body></html>`,{status:200,headers:{'content-type':'text/html'}})},renderPage:async(request:string)=>{calls.push({method:'GET',url:request});return options.badRender?{...rendered(),articleHtml:'<div class="ms-preview ms-md"><p>changed</p></div>',articleText:'changed'}:rendered()}}}
const enabledCatalog=CHANNELS.map(channel=>channel.id==='mdshare'?{...channel,enabled:true}:channel);

test('accepted catalog channel and request preserve every public retention gate',()=>{const channel=CHANNELS.find(value=>value.id==='mdshare');assert.ok(channel);assert.equal(channel.enabled,true);assert.equal(channel.accountRequired,false);assert.equal(channel.emailRequired,false);assert.equal(channel.automation,'api');assert.deepEqual(mdshareRequest(identity().title,identity().content).value,{body:identity().content,title:identity().title,language:'markdown',visibility:'public',expires_in_seconds:0,max_views:null,burn_after_read:false});assert.equal(mdshareTaskIdentity(task({draft:{...draft,body:'No source link'}}),site()),undefined)});

test('single POST persists opaque bytes before strict receipt parsing',async()=>{const m=memory(),calls:Array<{url:string;init:RequestInit}>=[],result=await createMDShareSnippet({operationId:intent().operationId,title:identity().title,content:identity().content,reviewed:true},m.persistence,{now:()=>new Date(at),fetch:async(request,init)=>{calls.push({url:request,init});return success()}});assert.equal(result.status,'created');assert.deepEqual(m.order,['intent','opaque','receipt']);assert.equal(calls.length,1);assert.equal(calls[0].url,MDSHARE_CREATE_URL);assert.equal(calls[0].init.redirect,'manual');assert.equal(calls[0].init.credentials,'omit');assert.equal(m.getOpaque()?.bodySha256,createHash('sha256').update(Buffer.from(m.getOpaque()!.bodyBase64,'base64')).digest('hex'));assert.equal((m.getReceipt() as {slug:string}).slug,slug)});

test('a response arriving after the caller deadline is drained into opaque storage without replay',async()=>{const m=memory();let posts=0;const result=await createMDShareSnippet({operationId:intent().operationId,title:identity().title,content:identity().content,reviewed:true},m.persistence,{now:()=>new Date(at),timeoutMs:50,fetch:async()=>{posts++;await new Promise(resolve=>setTimeout(resolve,80));return success()}});assert.equal(result.status,'unknown');assert.equal(posts,1);assert.deepEqual(m.order,['intent']);assert.equal(await drainMDShareLateResponses(1000),true);assert.equal(posts,1);assert.deepEqual(m.order,['intent','opaque']);assert.equal(m.getReceipt(),undefined)});

test('duplicate JSON keys and schema additions remain opaque unknown',async t=>{const valid=JSON.stringify(responseValue()),changed={...responseValue(),body:'changed'};for(const body of [valid.replace(`"slug":"${slug}"`,`"slug":"${slug}","slug":"${slug}"`),valid.replace(/}$/,',"extra":1}'),JSON.stringify(changed)])await t.test(body.slice(0,28),async()=>{const m=memory(),result=await createMDShareSnippet({operationId:intent().operationId,title:identity().title,content:identity().content,reviewed:true},m.persistence,{fetch:async()=>new Response(body,{status:201,headers:{'content-type':'application/json'}})});assert.equal(result.status,'unknown');assert.deepEqual(m.order,['intent','opaque']);assert.equal(m.getReceipt(),undefined)})});

test('prototype-named and escaped duplicate JSON fields remain opaque unknown',async t=>{const valid=JSON.stringify(responseValue()),bodies=[
  valid.replace(/}$/,' ,"__proto__":{"unexpected":true}}').replace('} ,','},'),
  valid.replace(/}$/,String.raw` ,"\\u005f\\u005fproto__":{"unexpected":true}}`).replace('} ,','},'),
  valid.replace('"snippet":{','"snippet":{"__proto__":{"unexpected":true},'),
  valid.replace('"snippet":{',String.raw`"snippet":{"\\u005f\\u005fproto__":{"unexpected":true},`),
  valid.replace(/}$/,' ,"constructor":{"unexpected":true}}').replace('} ,','},'),
  valid.replace('"snippet":{',String.raw`"snippet":{"\\u0063onstructor":{"unexpected":true},`),
  valid.replace(`"slug":"${slug}"`,String.raw`"slug":"${slug}","\\u0073lug":"${slug}"`),
];for(const [index,body] of bodies.entries())await t.test(`case-${index+1}`,async()=>{const m=memory(),result=await createMDShareSnippet({operationId:intent().operationId,title:identity().title,content:identity().content,reviewed:true},m.persistence,{fetch:async()=>new Response(body,{status:201,headers:{'content-type':'application/json'}})});assert.equal(result.status,'unknown');assert.deepEqual(m.order,['intent','opaque']);assert.equal(m.getReceipt(),undefined)})});

test('static and native noindex, canonical, refresh, visibility and link evidence fail closed',async t=>{
  const base=task({status:'review',submittedAt:at,publicUrl:url,checkpoint:'mdshare_api_receipt',mdshare:{...intent(),stage:'api_receipt',slug}}),dummy={read:()=>({tasks:[base]})} as unknown as Store;
  const staticVariants=[
    {name:'meta-noindex',head:'<meta name="robots" content="noindex">'},
    {name:'googlebot-noindex',head:'<meta name="googlebot" content="noindex">'},
    {name:'duplicate-canonical',head:`<link rel="canonical" href="${url}"><link rel="canonical" href="https://example.test/wrong">`},
    {name:'header-noindex',head:'',header:'noindex'},
  ];
  for(const variant of staticVariants)await t.test(variant.name,async()=>{const deps=dependencies(dummy,[]),original=deps.fetch;deps.fetch=async(request,init)=>request===url?new Response(`<!doctype html><html><head>${variant.head||`<link rel="canonical" href="${url}">`}</head><body></body></html>`,{status:200,headers:{'content-type':'text/html',...(variant.header?{'x-robots-tag':variant.header}:{})}}):original(request,init);const result=await verifyMDSharePublication(base,site(),target,deps);assert.equal(result.found,false);assert.equal(result.outcome,'invalid')});
  const nativeVariants:MDShareRenderedPage[]=[
    {...rendered(),robots:[{name:'googlebot',content:'noindex'}]},
    {...rendered(),responseRobots:['bingbot: noindex']},
    {...rendered(),canonicals:[url,'https://example.test/wrong']},
    {...rendered(),hasRefresh:true},
    {...rendered(),allArticleTextVisible:false},
    {...rendered(),articleText:'changed'},
    {...rendered(),links:[{href:target,rel:[],text:'changed',visible:true}]},
  ];
  for(const [index,page] of nativeVariants.entries())await t.test(`native-${index+1}`,()=>assert.equal(mdsharePublisherTesting.exactRendered(page,url,identity().title,identity().content,target),undefined));
});

test('Controller first publish is one POST plus four bounded reads and backup is restorable',async()=>{const f=fixture(),calls:Array<{method:string;url:string}>=[],deps=dependencies(f.store,calls),controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:enabledCatalog,mdshareDependencies:deps});controller.runtime.aiReady=true;try{await controller.tick();const saved=f.store.read().tasks[0];assert.equal(calls.filter(value=>value.method==='POST').length,1,JSON.stringify(saved));assert.equal(calls.filter(value=>value.method==='GET').length,4,JSON.stringify(saved));assert.equal(saved.status,'live',JSON.stringify(saved));assert.equal(saved.mdshare?.stage,'published');assert.equal(saved.publicUrl,url);assert.equal(saved.linkCheck,'found');assert.equal(isConfirmedMDShareResultUrl(saved,url,site()),true);const raw=(await vault(f.store).get(`publication:${taskId}`))!;assert.ok(parseMDShareOpaqueResponseSecret(raw));assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[`publication:${taskId}`]:raw}}));assert.throws(()=>f.store.update(state=>{state.tasks[0].draft!.body='changed'}));assert.throws(()=>f.store.update(state=>{state.tasks=[]}));assert.throws(()=>f.store.updateWithCiphers(()=>{}, {},[`publication:${taskId}`]))}finally{controller.stop();f.cleanup()}});

test('403 or rendered mismatch never becomes live and cannot cause a second POST',async()=>{const f=fixture(),calls:Array<{method:string;url:string}>=[],controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:enabledCatalog,mdshareDependencies:dependencies(f.store,calls,{unknown:true})});controller.runtime.aiReady=true;try{await controller.tick();const saved=f.store.read().tasks[0];assert.equal(saved.mdshare?.stage,'opaque_response');assert.equal(saved.publicUrl,undefined);assert.equal(calls.filter(value=>value.method==='POST').length,1);await controller.tick();assert.equal(calls.filter(value=>value.method==='POST').length,1);const opaque=parseMDShareOpaqueResponseSecret((await vault(f.store).get(`publication:${taskId}`))!);assert.ok(opaque);assert.equal('diagnostic' in parseStoredMDShareCreateResponse(opaque!,intent(),identity().title,'changed'),true)}finally{controller.stop();f.cleanup()};const base=task({status:'review',submittedAt:at,publicUrl:url,checkpoint:'mdshare_api_receipt',mdshare:{...intent(),stage:'api_receipt',slug}}),dummy={read:()=>({tasks:[base]})} as unknown as Store,result=await verifyMDSharePublication(base,site(),target,dependencies(dummy,[],{badRender:true}));assert.equal(result.found,false);assert.equal(result.outcome,'invalid')});


test('observed compact HTTP201 creation envelope is receipt only; complete GET schema remains independently required',async()=>{
 const full=responseValue(),value={snippet:{...full.snippet,view_count:0},url:full.url,raw_url:full.raw_url},m=memory();
 const result=await createMDShareSnippet({operationId:intent().operationId,title:identity().title,content:identity().content,reviewed:true},m.persistence,{now:()=>new Date(at),fetch:async()=>new Response(JSON.stringify(value),{status:201,headers:{'content-type':'application/json'}})});
 assert.equal(result.status,'created');assert.deepEqual(m.order,['intent','opaque','receipt']);
 const base=m.getOpaque()!;
 for(const changed of [{...value,extra:1},{...value,url:'https://example.test/wrong'},{...value,snippet:{...value.snippet,view_count:1}},{...value,snippet:{...value.snippet,updated_at:'2026-10-13T03:00:01.000Z'}},{...value,snippet:{...value.snippet,size_bytes:1}},{...value,snippet:{...value.snippet,title:'wrong'}}]){
  const body=JSON.stringify(changed),o={...base,bodyBase64:Buffer.from(body).toString('base64'),bodySha256:createHash('sha256').update(body).digest('hex')};assert.ok('diagnostic' in parseStoredMDShareCreateResponse(o,intent(),identity().title,identity().content));
 }
 assert.ok('diagnostic' in parseStoredMDShareCreateResponse({...base,status:200},intent(),identity().title,identity().content));
 const dup=JSON.stringify(value).replace('"snippet":{','"snippet":{"slug":"OtherSlug123",'),o={...base,bodyBase64:Buffer.from(dup).toString('base64'),bodySha256:createHash('sha256').update(dup).digest('hex')};assert.deepEqual(parseStoredMDShareCreateResponse(o,intent(),identity().title,identity().content),{diagnostic:'duplicate_field'});
 const published=task({status:'review',submittedAt:at,publicUrl:url,checkpoint:'mdshare_api_receipt',mdshare:{...intent(),stage:'api_receipt',slug}}),dummy={read:()=>({tasks:[published]})} as unknown as Store,deps=dependencies(dummy,[]),orig=deps.fetch;
 deps.fetch=async(request,init)=>request===`https://mdshare.org/api/v1/snippets/${slug}`?new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}}):orig(request,init);
 assert.equal((await verifyMDSharePublication(published,site(),target,deps)).found,false);
});
