import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {articleReviewBindingHash,articleReviewTargetUrl} from '../src/main/article-review';
import {defaultSettings} from '../src/main/store';
import {DROPDEPLOY_API,dropDeployKeyIdentity,dropDeployDocument,parseDropDeployCredential,probeDropDeployFreeAccount,runDropDeployTask,reconcileDropDeployTask,verifyDropDeployPublication,type DropDeployCredential} from '../src/integrations/dropdeploy';
import type {Batch5Intent,Batch5Receipt,Batch5OpaqueResponse,Batch5Persistence} from '../src/integrations/batch5-contract';
import type {Account,Channel,Site,Task,ExecutionContext} from '../src/shared/types';
const at='2026-10-30T09:00:00.000Z',target='https://software.example.org/guide',key=`dd_${'a'.repeat(40)}`;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fixture(){
  const site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Software Example',description:'Maintained software guide',email:'owner@example.org',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:at};
  const channel:Channel={id:'dropdeploy',name:'dropdeploy',domain:'ddploy.com',url:'https://ddploy.com/',submitUrl:'https://ddploy.com/api/v1/apps',categories:['software'],languages:['*'],kind:'article',free:'conditional',freeNote:'Free only',quality:'C',qualityReason:'',rulesUrl:'https://ddploy.com/terms',notes:'',emailRequired:false,accountRequired:true,articleRequired:true,automation:'api',enabled:true,allowedHosts:['ddploy.com','ddploy.com'],singleSiteOnly:true,checkedAt:at,
    termsCache:{version:1,channelId:'dropdeploy',checkedAt:at,sourceHash:'a'.repeat(64),finance:'allowed',promotion:'allowed',disclosurePlacement:'required',summary:'Original software documentation permitted.',conclusionHash:'b'.repeat(64),sources:[{url:'https://ddploy.com/terms',kind:'content_policy',text:'Original software documentation permitted.',appliesTo:'dropdeploy',applicability:'verified'}],reviewVersion:2}};
  const account:Account={id:randomUUID(),channelId:'dropdeploy',email:'owner@example.org',username:'owner@example.org',ownerSiteId:site.id,createdAt:at,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token'};
  const task:Task={id:randomUUID(),siteId:site.id,channelId:'dropdeploy',accountId:account.id,sourceDomain:'ddploy.com',status:'running',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'',topicUrl:target,draftRevision:1,
    draft:{title:'Reproducing a software release',description:'An original diagnostic guide.',body:`Written by an AI assistant for Software Example. Reproduce the configuration, compare release notes, and document failures. See the [maintained project guide](${target}). We maintain the linked project.`}};
  const settings={...defaultSettings(),articleReviewMode:'ai' as const};
  task.articleReview={status:'passed',reason:'Independent technical guide',reasonCode:'passed',reviewContractVersion:5,bindingVersion:2,targetUrl:articleReviewTargetUrl(task,site),termsHash:channel.termsCache!.conclusionHash,contextHash:articleReviewBindingHash(task,site,channel),draftRevision:1,contentHash:'c'.repeat(64),evidenceUrls:[site.url],reviewedAt:at};
  const publicationContext={scope:'visible_workspace_only' as const,sameChannelTasks:1,sameAccountTasks:1,distinctSites:1,publicationIntent:'single_original_article' as const,workflowPurpose:'expand_backlink_channels' as const,knownContentPattern:'unknown' as const};


  const secret:DropDeployCredential={version:1,apiKey:key};account.email='';account.username=dropDeployKeyIdentity(key);
  const slug='guide-ab1234',url=`https://${slug}.ddploy.com/`;
  let intent:Batch5Intent|undefined,receipt:Batch5Receipt|undefined,opaque:Batch5OpaqueResponse|undefined,sending=false,blocked=false;
  const journal:Batch5Persistence={saveIntent:async()=>{throw Error('use reserve')},reserveIntent:async value=>{assert.equal(intent,undefined);intent=value},loadIntent:async()=>intent,
    assertReadyToSubmit:async value=>{assert.equal(value,intent);if(blocked)throw Error('revoked')},markSending:async()=>{assert.equal(sending,false);if(blocked)throw Error('revoked');sending=true},saveReceipt:async value=>{receipt=value},loadReceipt:async()=>receipt,
    saveOpaqueResponse:async value=>{opaque=value},loadOpaqueResponse:async()=>opaque,currentTaskState:()=>task.batch5};
  const secrets=new Map([[`account:${account.id}`,JSON.stringify(secret)]]);
  const context:ExecutionContext={site,task,channel,settings,signal:new AbortController().signal,ai:{json:async<T>()=>({} as T)},getAccount:()=>account,
    getArticlePublicationContext:()=>publicationContext,secrets:{get:async k=>secrets.get(k),set:async(k,v)=>{secrets.set(k,v)},delete:async k=>{secrets.delete(k)}},saveAccount:async()=>{},checkpoint:partial=>{Object.assign(task,partial)},log:()=>{},batch5Persistence:journal};
  const doc=dropDeployDocument(context),created:any={slug,url,file_count:2,size:doc.bytes,has_password:false};
  const metadata:any={...created,name:doc.title,active:true,deactivates_at:null,updated_at:at};
  const stats:any={tier:'free',active_sites:0,total_sites:0,total_size:0,limits:{sites:3,storage_per_site:10485760,total_storage:52428800}};
  let publicHtml=doc.html,robots='User-agent: *\nAllow: /\n',ownedSites:any[]|undefined,pageHeaders:Record<string,string>={},native={found:true,indexable:true,rel:doc.rel};
  const calls:{url:string;init:RequestInit}[]=[];let creates=0,renders=0;
  const fetch=async(path:string,init:RequestInit)=>{
    calls.push({url:path,init});assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
    if(path.startsWith(DROPDEPLOY_API)){assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${key}`)}else assert.equal(new Headers(init.headers).has('authorization'),false);
    if(path===DROPDEPLOY_API+'/stats'){assert.equal(init.method,'GET');return json(stats)}
    if(path===DROPDEPLOY_API+'/sites'&&init.method==='GET')return json({sites:ownedSites??(creates?[metadata]:[])});
    if(path===DROPDEPLOY_API+'/sites'&&init.method==='POST'){creates++;assert.equal(sending,true);assert.equal(init.body,doc.request);const f=await new Request(path,{method:'POST',headers:init.headers,body:init.body}).formData();assert.deepEqual([...f.keys()],['files','files','name']);assert.equal(f.get('name'),doc.title);const files=f.getAll('files') as File[];assert.deepEqual(files.map(x=>x.name),['index.html','robots.txt']);assert.equal(await files[0].text(),doc.html);assert.equal(await files[1].text(),robots);assert.equal(files[0].type,'application/octet-stream');return json(created,201)}
    if(path===url){assert.equal(init.method,'GET');return new Response(publicHtml,{headers:{'content-type':'text/html',...pageHeaders}})}
    if(path===url+'robots.txt'){assert.equal(init.method,'GET');return new Response(robots,{headers:{'content-type':'text/plain'}})}
    throw Error('unexpected '+path);
  };
  context.batch5Dependencies={fetch,now:()=>new Date(at),renderPage:async(u,t,title,markdown)=>{renders++;assert.equal(u,url);assert.equal(t,target);assert.equal(title,task.draft!.title);assert.equal(markdown,task.draft!.body);return native}};
  return {context,secret,journal,secrets,metadata,stats,created,doc,calls,url,creates:()=>creates,renders:()=>renders,intent:()=>intent,receipt:()=>receipt,opaque:()=>opaque,
    block:()=>{blocked=true},setHtml:(v:string)=>{publicHtml=v},setRobots:(v:string)=>{robots=v},setOwned:(v:any[])=>{ownedSites=v},setHeaders:(v:Record<string,string>)=>{pageHeaders=v},setNative:(v:typeof native)=>{native=v}};
}
test('one deterministic two-file multipart create without paid fields; owned/static/native readback; restart GET-only',async()=>{
 const f=fixture(),result=await runDropDeployTask(f.context);assert.equal(result.publicUrl,f.url);assert.equal(f.creates(),1);assert.equal(f.opaque()!.status,201);
 assert.equal((await verifyDropDeployPublication(f.context)).found,true);assert.equal(f.renders(),1);f.context.task.articleReview=undefined;
 assert.equal((await runDropDeployTask(f.context)).publicUrl,f.url);assert.equal(f.creates(),1);
});
test('real-shaped stats and list establish free capacity using local key identity only',async()=>{
 const f=fixture(),r=await probeDropDeployFreeAccount(f.secret,f.context.batch5Dependencies);assert.equal(r.authenticated,true);assert.equal(r.identitySource,'local_key_fingerprint');assert.equal(r.totalSites,0);assert.equal(r.remainingBytes,52428800);assert.equal(f.creates(),0);
 assert.equal(parseDropDeployCredential(JSON.stringify({...f.secret,apiKey:'bad\nheader'})),undefined);await assert.rejects(probeDropDeployFreeAccount({...f.secret,apiKey:''},f.context.batch5Dependencies));
});
test('paid tier, altered limits, full slots/storage and inconsistent owner counts fail before write',async()=>{
 for(const mode of ['tier','limits','sites','storage','inconsistent','negative'] as const){const f=fixture();if(mode==='tier')f.stats.tier='pro';if(mode==='limits')f.stats.limits.sites=5;if(mode==='sites')f.stats.total_sites=3;if(mode==='storage')f.stats.total_size=52428800;if(mode==='inconsistent')f.stats.total_sites=1;if(mode==='negative')f.stats.total_size=-1;
  assert.equal((await runDropDeployTask(f.context)).status,'needs_input',mode);assert.equal(f.creates(),0);assert.equal(f.intent(),undefined);
 }
});
test('review/account/key and late authorization/task/draft/secret changes cannot dispatch',async()=>{
 for(const mode of ['review','identity','email','permission','task','draft','secret'] as const){const f=fixture();if(mode==='review')f.context.task.articleReview=undefined;if(mode==='identity')f.context.getAccount()!.username=dropDeployKeyIdentity('other_key_123456789');if(mode==='email')f.context.getAccount()!.email='other@example.org';
  const mark=f.journal.markSending!;f.journal.markSending=async intent=>{await mark(intent);if(mode==='permission')f.block();if(mode==='task')f.context.task.id=randomUUID();if(mode==='draft')f.context.task.draft!.body+=' changed';if(mode==='secret')f.secrets.set(`account:${f.context.task.accountId}`,JSON.stringify({...f.secret,apiKey:'other_key_123456789'}))};
  await runDropDeployTask(f.context);assert.equal(f.creates(),0,mode);await runDropDeployTask(f.context);assert.equal(f.creates(),0,mode);
 }
});
test('lost response and rejection/rate/unknown responses preserve intent and never repeat create',async()=>{
 for(const status of [0,400,408,429,500]){const f=fixture(),base=f.context.batch5Dependencies!.fetch!;let attempts=0;f.context.batch5Dependencies!.fetch=async(url,init)=>{if(init.method==='POST'){attempts++;if(!status)throw Error('lost');return json({error:'failed'},status)}return base(url,init)};
  const result=await runDropDeployTask(f.context);assert.ok(['failed','review'].includes(result.status));assert.ok(f.intent());await runDropDeployTask(f.context);assert.equal(attempts,1,String(status));
 }
});
test('original opaque receipt survives save failure and recovers through only owner/public GET',async()=>{
 const f=fixture(),save=f.journal.saveReceipt;f.journal.saveReceipt=async()=>{throw Error('disk')};assert.equal((await runDropDeployTask(f.context)).reasonCode,'submission_unknown');assert.ok(f.opaque());f.journal.saveReceipt=save;
 assert.equal((await reconcileDropDeployTask(f.context)).status,'found');assert.equal(f.creates(),1);
});
test('create response cannot introduce anonymous expiry, password, wrong size/files or untrusted URL',async()=>{
 for(const mode of ['claim','expiry','password','size','files','url','slug'] as const){const f=fixture();if(mode==='claim')f.created.claim_token='not-permanent';if(mode==='expiry')f.created.expires_at='2027-01-01T00:00:00Z';if(mode==='password')f.created.has_password=true;if(mode==='size')f.created.size++;if(mode==='files')f.created.file_count=1;if(mode==='url')f.created.url='https://evil.example.org/';if(mode==='slug')f.created.slug='app';
  assert.equal((await runDropDeployTask(f.context)).reasonCode,'submission_unknown',mode);assert.equal(f.receipt(),undefined);assert.ok(f.opaque());await runDropDeployTask(f.context);assert.equal(f.creates(),1);
 }
});
test('readback requires one owned active no-expiry no-password site and exact upload metadata',async()=>{
 for(const mode of ['missing','duplicate','active','password','expiry','missing-expiry','name','size','files','date'] as const){const f=fixture();await runDropDeployTask(f.context);
  if(mode==='missing')f.setOwned([]);if(mode==='duplicate')f.setOwned([f.metadata,f.metadata]);if(mode==='active')f.metadata.active=false;if(mode==='password')f.metadata.has_password=true;if(mode==='expiry')f.metadata.deactivates_at='2027-01-01T00:00:00Z';if(mode==='missing-expiry')delete f.metadata.deactivates_at;if(mode==='name')f.metadata.name='changed';if(mode==='size')f.metadata.size++;if(mode==='files')f.metadata.file_count=1;if(mode==='date')f.metadata.updated_at='2020-01-01T00:00:00Z';
  assert.equal((await verifyDropDeployPublication(f.context)).found,false,mode);assert.equal(f.renders(),0);assert.equal(f.creates(),1);
 }
});
test('anonymous page must preserve exact original main, one target and crawlable native document',async()=>{
 for(const mode of ['login','duplicate','iframe','meta','header','canonical','body','robots','native'] as const){const f=fixture();await runDropDeployTask(f.context);
  if(mode==='login')f.setHtml('<h1>Login</h1>');if(mode==='duplicate')f.setHtml(f.doc.html.replace('</body>',`<a href="${target}">extra</a></body>`));if(mode==='iframe')f.setHtml(f.doc.html.replace('</body>','<iframe src="/frame"></iframe></body>'));if(mode==='meta')f.setHtml(f.doc.html.replace('</head>','<meta name="robots" content="none"></head>'));if(mode==='header')f.setHeaders({'x-robots-tag':'googlebot:noindex'});if(mode==='canonical')f.setHtml(f.doc.html.replace('</head>','<link rel="canonical" href="https://other.ddploy.com/"></head>'));if(mode==='body')f.setHtml(f.doc.html.replace('Reproduce','Changed'));if(mode==='robots')f.setRobots('User-agent: *\nDisallow: /\n');if(mode==='native')f.setNative({found:false,indexable:true,rel:f.doc.rel});
  assert.equal((await verifyDropDeployPublication(f.context)).found,false,mode);assert.equal(f.creates(),1);
 }
});
test('platform badge outside original main is allowed only with mandatory matching native proof',async()=>{
 const f=fixture();await runDropDeployTask(f.context);f.setHtml(f.doc.html.replace('</body>','<aside><a href="https://www.ddploy.com/">Hosted on DropDeploy</a></aside></body>'));
 assert.equal((await verifyDropDeployPublication(f.context)).found,true);delete f.context.batch5Dependencies!.renderPage;assert.equal((await verifyDropDeployPublication(f.context)).found,false);
});
test('multipart is deterministic, UTF-8 exact and document validation rejects extra GFM links or active HTML',async()=>{
 const f=fixture();f.context.task.draft!.title='软件文档说明';const a=dropDeployDocument(f.context),b=dropDeployDocument(f.context);assert.equal(a.request,b.request);assert.equal(a.requestHash,b.requestHash);
 const form=await new Request(DROPDEPLOY_API+'/sites',{method:'POST',headers:{'content-type':a.contentType},body:a.request}).formData();assert.equal(form.get('name'),'软件文档说明');assert.equal(await (form.get('files') as File).text(),a.html);
 f.context.task.draft!.body+=' www.example.com';assert.throws(()=>dropDeployDocument(f.context));f.context.task.draft!.body='<script>alert(1)</script>';assert.throws(()=>dropDeployDocument(f.context));assert.equal(f.calls.length,0);
});
