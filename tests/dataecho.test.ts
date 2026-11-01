import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {articleReviewBindingHash,articleReviewTargetUrl} from '../src/main/article-review';
import {defaultSettings,Store} from '../src/main/store';
import {DATAECHO_API,dataEchoDocument,dataEchoUploadUrl,dataEchoPublicHtmlMatches,dataEchoRobotsAllows,parseDataEchoCreate,runDataEchoTask,reconcileDataEchoTask,resumeDataEchoCreatedPublication,type DataEchoDependencies,type DataEchoIntent,type DataEchoJournalSnapshot,type DataEchoStep} from '../src/integrations/dataecho';
import {createDataEchoPublicationJournal,parseDataEchoPublicationJournal,dataEchoBackupMatches} from '../src/main/dataecho-publication';
import type {ConnectedResponse} from '../src/integrations/batch5-connected';
import type {Account,Channel,Site,Task} from '../src/shared/types';
const at='2026-10-30T09:00:00.000Z',target='https://software.example.org/guide',key=`de_${'a'.repeat(40)}`;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fixture(){
  const site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Software Example',description:'Maintained software guide',email:'owner@example.org',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:at};
  const channel:Channel={id:'dataecho',name:'dataecho',domain:'dataecho.app',url:'https://dataecho.ai/',submitUrl:'https://dataecho.ai/api/v1/apps',categories:['software'],languages:['*'],kind:'article',free:'conditional',freeNote:'Free only',quality:'C',qualityReason:'',rulesUrl:'https://dataecho.ai/terms',notes:'',emailRequired:false,accountRequired:true,articleRequired:true,automation:'api',enabled:true,allowedHosts:['dataecho.ai','dataecho.app'],singleSiteOnly:true,checkedAt:at,
    termsCache:{version:1,channelId:'dataecho',checkedAt:at,sourceHash:'a'.repeat(64),finance:'allowed',promotion:'allowed',disclosurePlacement:'required',summary:'Original software documentation permitted.',conclusionHash:'b'.repeat(64),sources:[{url:'https://dataecho.ai/terms',kind:'content_policy',text:'Original software documentation permitted.',appliesTo:'dataecho',applicability:'verified'}],reviewVersion:2}};
  const account:Account={id:randomUUID(),channelId:'dataecho',email:'owner@example.org',username:'test_owner',ownerSiteId:site.id,createdAt:at,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token'};
  const task:Task={id:randomUUID(),siteId:site.id,channelId:'dataecho',accountId:account.id,sourceDomain:'dataecho.app',status:'running',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'',topicUrl:target,draftRevision:1,
    draft:{title:'Reproducing a software release',description:'An original diagnostic guide.',body:`Written by an AI assistant for Software Example. Reproduce the configuration, compare release notes, and document failures. See the [maintained project guide](${target}). We maintain the linked project.`}};
  const settings={...defaultSettings(),articleReviewMode:'ai' as const};
  task.articleReview={status:'passed',reason:'Independent technical guide',reasonCode:'passed',reviewContractVersion:5,bindingVersion:2,targetUrl:articleReviewTargetUrl(task,site),termsHash:channel.termsCache!.conclusionHash,contextHash:articleReviewBindingHash(task,site,channel),draftRevision:1,contentHash:'c'.repeat(64),evidenceUrls:[site.url],reviewedAt:at};
  const publicationContext={scope:'visible_workspace_only' as const,sameChannelTasks:1,sameAccountTasks:1,distinctSites:1,publicationIntent:'single_original_article' as const,workflowPurpose:'expand_backlink_channels' as const,knownContentPattern:'unknown' as const};

  const slug='technical-guide-ab12',url=`https://${slug}.dataecho.ai/`,versionId='version_123456789',doc=dataEchoDocument(site,task);
  const uploads=doc.files.map(file=>({path:file.path,method:'PUT',url:`https://${'a'.repeat(32)}.r2.cloudflarestorage.com/bucket/${versionId}/${file.path}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=${'b'.repeat(64)}`,headers:{'Content-Type':file.contentType}}));
  const create={slug,siteUrl:url,upload:{versionId,uploads,skipped:[],finalizeUrl:`${DATAECHO_API}/publish/${slug}/finalize`,expiresInSeconds:3600}};
  const metadata={slug,siteUrl:url,currentVersionId:versionId,pendingVersionId:null,anonymous:false,passwordProtected:false,payGated:false,spaMode:false,kind:'static',expiresAt:null,files:doc.files.map(({path,size,hash,contentType})=>({path,size,hash,contentType}))};
  let snapshot:DataEchoJournalSnapshot|undefined,publicHtml=doc.html;
  const writes:{url:string;init:RequestInit}[]=[];
  const journal={load:async()=>snapshot,reserve:async(intent:DataEchoIntent)=>{assert.equal(snapshot,undefined);snapshot={intent,steps:{}}},arm:async(intent:DataEchoIntent,step:DataEchoStep)=>{assert.deepEqual(snapshot?.intent,intent);assert.equal(snapshot?.steps[step],undefined);snapshot!.steps[step]={stage:'sending'}},saveResponse:async(intent:DataEchoIntent,step:DataEchoStep,response:ConnectedResponse)=>{assert.deepEqual(snapshot?.intent,intent);assert.equal(snapshot?.steps[step]?.stage,'sending');snapshot!.steps[step]={stage:'response',response}}};
  const fetch=async(path:string,init:RequestInit):Promise<Response>=>{
    if(init.method!=='GET')writes.push({url:path,init});
    if(path===`${DATAECHO_API}/profile`&&init.method==='GET')return json({username:'test_owner',profileUrl:'/@test_owner'});
    if(path===`${DATAECHO_API}/publish`&&init.method==='POST'){assert.equal(init.body,doc.request);return json(create,201)}
    const upload=uploads.find(row=>row.url===path);
    if(upload&&init.method==='PUT'){assert.equal(new Headers(init.headers).has('authorization'),false);assert.equal(Buffer.from(init.body as Uint8Array).toString(),doc.files.find(file=>file.path===upload.path)!.bytes.toString());return new Response(null,{status:204})}
    if(path===create.upload.finalizeUrl&&init.method==='POST'){assert.deepEqual(JSON.parse(String(init.body)),{versionId});return json({ok:true})}
    if(path===`${DATAECHO_API}/publish/${slug}`&&init.method==='GET')return json(metadata);
    if(path===url&&init.method==='GET'){assert.equal(new Headers(init.headers).has('authorization'),false);return new Response(publicHtml,{headers:{'content-type':'text/html'}})}
    if(path===url+'robots.txt'&&init.method==='GET')return new Response('User-agent: *\nAllow: /\n');
    throw Error(`unexpected ${init.method} ${path}`);
  };
  const deps:DataEchoDependencies={site,channel,task,account,settings,publicationContext,apiKey:key,signal:new AbortController().signal,fetch,journal,executionEnabled:true,assertAuthorized:()=>{},now:()=>new Date(at)};
  return {deps,writes,url,doc,create,metadata,snapshot:()=>snapshot,setPublicHtml:(value:string)=>{publicHtml=value}};
}

test('DataEcho exact two-file authenticated handshake; no bearer on upload/public reads; restart GET-only',async()=>{
 const f=fixture(),result=await runDataEchoTask(f.deps);
 assert.equal(result.publicUrl,f.url,JSON.stringify(result));assert.deepEqual(f.writes.map(v=>v.init.method),['POST','PUT','PUT','POST']);
 assert.ok(f.writes.every(v=>v.init.redirect==='error'&&v.init.credentials==='omit'));
 assert.equal((await runDataEchoTask(f.deps)).publicUrl,f.url);assert.equal(f.writes.length,4);
 assert.equal((await reconcileDataEchoTask(f.deps)).status,'found');
});

test('DataEcho default execution gate and changed review stop all writes',async()=>{
 for(const change of ['disabled','review','identity','category'] as const){const f=fixture();
  if(change==='disabled')delete f.deps.executionEnabled;
  if(change==='review')f.deps.task.draft!.body+=' changed';
  if(change==='identity')f.deps.account.username='other@example.org';
  if(change==='category')f.deps.site.category='finance';
  assert.equal((await runDataEchoTask(f.deps)).status,'needs_input',change);assert.equal(f.writes.length,0);
 }
});

test('DataEcho each mutation checks live authorization after durable arm',async()=>{
 const steps:DataEchoStep[]=['create','upload_index','upload_robots','finalize'];
 for(const [index,denied] of steps.entries()){const f=fixture();f.deps.assertAuthorized=(_intent,step)=>{if(step===denied)throw Error('revoked')};
  assert.equal((await runDataEchoTask(f.deps)).reasonCode,'submission_unknown');assert.equal(f.writes.length,index);assert.equal(f.snapshot()!.steps[denied]?.stage,'sending');
  await runDataEchoTask(f.deps);assert.equal(f.writes.length,index);
 }
});

test('lost create response is not replayed and its durable intent remains',async()=>{
 const f=fixture();let calls=0;const base=f.deps.fetch;f.deps.fetch=async(url,init)=>{if(init.method==='GET')return base(url,init);calls++;throw Error('lost response')};
 assert.equal((await runDataEchoTask(f.deps)).reasonCode,'submission_unknown');assert.equal(f.snapshot()!.steps.create?.stage,'sending');
 await runDataEchoTask(f.deps);assert.equal(calls,1);
});

test('untrusted upload origins, anonymous receipts, skips, duplicate paths and forwarded bearer are rejected before upload',async()=>{
 for(const mode of ['origin','anonymous','ttl','skipped','duplicate','headers','finalize','version'] as const){const f=fixture(),receipt=f.create as any;
  if(mode==='origin')receipt.upload.uploads[0].url='https://127.0.0.1/private';
  if(mode==='anonymous')receipt.claimToken='private-claim-token';
  if(mode==='ttl')receipt.expiresAt='2026-11-01T00:00:00Z';
  if(mode==='skipped')receipt.upload.skipped=['index.html'];
  if(mode==='duplicate')receipt.upload.uploads[1]=receipt.upload.uploads[0];
  if(mode==='headers')receipt.upload.uploads[0].headers.Authorization='Bearer must-not-forward';
  if(mode==='finalize')receipt.upload.finalizeUrl='https://other.example.org/finalize';
  if(mode==='version')receipt.upload.versionId='../other';
  assert.equal((await runDataEchoTask(f.deps)).reasonCode,'submission_unknown',mode);assert.equal(f.writes.length,1,mode);
  await runDataEchoTask(f.deps);assert.equal(f.writes.length,1,mode);
 }
});

test('readback rejects manifest mismatch, temporary sites, altered public body and noindex',async()=>{
 for(const mode of ['manifest','ttl','version','body','noindex'] as const){const f=fixture();
  if(mode==='manifest')f.metadata.files[0].hash='f'.repeat(64);
  if(mode==='ttl')(f.metadata as any).expiresAt='2026-11-01T00:00:00Z';
  if(mode==='version')f.metadata.currentVersionId='wrong_version';
  if(mode==='body')f.setPublicHtml(f.doc.html.replace('Reproduce','Changed'));
  if(mode==='noindex'){const base=f.deps.fetch;f.deps.fetch=async(url,init)=>url===f.url?new Response(f.doc.html,{headers:{'content-type':'text/html','x-robots-tag':'googlebot: noindex'}}):base(url,init)}
  assert.equal((await runDataEchoTask(f.deps)).reasonCode,'submission_unknown',mode);assert.equal((await reconcileDataEchoTask(f.deps)).status,'unknown',mode);assert.equal(f.writes.length,4);
 }
});

test('presigned storage URL rejects credentials, fragments, ports, lookalikes, unsigned and oversized expiry',()=>{
 const f=fixture(),good=f.create.upload.uploads[0].url;assert.equal(dataEchoUploadUrl(good),true);
 for(const bad of [good.replace('https://','http://'),good.replace('https://','https://user:secret@'),good+'#fragment',good.replace('.com/','.com:8443/'),good.replace('.com/','.com.evil.example/'),good.replace('Expires=3600','Expires=3601'),good.replace('X-Amz-Signature','Bad-Signature')])assert.equal(dataEchoUploadUrl(bad),false);
});

test('isolated CAS storage persists journal response, rejects duplicate arm and matches backup',async()=>{
 const f=fixture(),seed=new Store(':memory:');let state=seed.read();seed.close();
 state.sites=[f.deps.site];state.tasks=[f.deps.task];state.accounts=[f.deps.account];state.accountBindings=[{id:randomUUID(),siteId:f.deps.site.id,channelId:'dataecho',accountId:f.deps.account.id,createdAt:at,updatedAt:at}];
 const ciphers:Record<string,string>={};
 const store:Parameters<typeof createDataEchoPublicationJournal>[0]={read:()=>structuredClone(state),getCipher:key=>ciphers[key],updateWithCiphers:(mutate,values={},remove=[],expected={})=>{
  for(const [key,value] of Object.entries(expected))assert.equal(ciphers[key],value);
  const next=structuredClone(state);mutate(next);state=next;Object.assign(ciphers,values);for(const key of remove)delete ciphers[key];
 }};
  const vault={get:async(key:string)=>{const value=store.getCipher(key);return value?Buffer.from(value.slice(4),'base64').toString():undefined},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'enc:'+Buffer.from(value).toString('base64')]))};
  f.deps.journal=createDataEchoPublicationJournal(store,vault,f.deps.task.id,()=>{});
  assert.equal((await runDataEchoTask(f.deps)).publicUrl,f.url);const snapshot=await f.deps.journal.load();assert.ok(snapshot);
  await assert.rejects(f.deps.journal.arm(snapshot.intent,'create'),/already_started/);
  const key=`publication:${f.deps.task.id}`,raw=await vault.get(key);assert.ok(raw);assert.ok(parseDataEchoPublicationJournal(raw));assert.equal(store.getCipher(key)===raw,false);
  assert.equal(dataEchoBackupMatches(store.read().tasks[0],raw),true);
  const broken=structuredClone(snapshot);delete broken.steps.upload_index;assert.equal(parseDataEchoPublicationJournal(JSON.stringify(broken)),undefined);
});

test('production Store persists each DataEcho stage and supports original encrypted recovery',async()=>{
 const f=fixture(),store=new Store(':memory:');try{
  store.update(s=>{s.sites=[f.deps.site];s.tasks=[f.deps.task];s.accounts=[f.deps.account];s.accountBindings=[{id:randomUUID(),siteId:f.deps.site.id,channelId:'dataecho',accountId:f.deps.account.id,createdAt:at,updatedAt:at}]});
  const vault={get:async(key:string)=>{const value=store.getCipher(key);return value?Buffer.from(value.slice(4),'base64').toString():undefined},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'enc:'+Buffer.from(value).toString('base64')]))};
  f.deps.journal=createDataEchoPublicationJournal(store,vault,f.deps.task.id,()=>{});
  assert.equal((await runDataEchoTask(f.deps)).publicUrl,f.url);assert.equal(f.writes.length,4);assert.equal(store.read().tasks[0].batch5?.stage,'api_receipt');assert.equal(dataEchoBackupMatches(store.read().tasks[0],await vault.get(`publication:${f.deps.task.id}`)),true);
 }finally{store.close()}
});

async function originalPendingCreate(f:ReturnType<typeof fixture>){
 const d=f.deps,intent:DataEchoIntent={version:1,taskId:d.task.id,siteId:d.site.id,accountId:d.account.id,email:d.account.email,username:d.account.username,name:d.task.draft!.title.slice(0,100),sourceHash:f.doc.sourceHash,requestHash:f.doc.requestHash,createdAt:at};
 f.create.upload.uploads.forEach((u,i)=>{u.url=`https://dataecho.ai/upload/${String(i).repeat(31)}`});
 await d.journal.reserve(intent);await d.journal.arm(intent,'create');await d.journal.saveResponse(intent,'create',{status:201,url:DATAECHO_API+'/publish',contentType:'application/json',robotsHeader:'',body:JSON.stringify(f.create)});
 const pending={slug:f.create.slug,siteUrl:f.url,status:'pending',currentVersionId:null,pendingVersionId:f.create.upload.versionId,expiresAt:null,anonymous:false,passwordProtected:false,payGated:false,spaMode:false,kind:'static',files:[],filesCount:0,viewer:{title:d.task.draft!.title,description:d.task.draft!.description}};
 const fetch=d.fetch;d.fetch=async(url,init)=>url===DATAECHO_API+'/publish/'+f.create.slug&&!f.writes.some(x=>x.url===f.create.upload.finalizeUrl)?json(pending):fetch(url,init);
 return pending;
}
test('observed same-origin upload tokens are strict and never authorize decorated endpoints',()=>{
 const good='https://dataecho.ai/upload/'+'a'.repeat(31);assert.equal(dataEchoUploadUrl(good),true);
 for(const bad of [good+'?x=1',good+'#fragment',good+'/',good.replace('dataecho.ai','dataecho.ai.evil.example'),good.replace('https://','https://user:pass@'),good.replace('/upload/','/api/upload/'),good.slice(0,-1)])assert.equal(dataEchoUploadUrl(bad),false);
});
test('proved untouched original create resumes only two original PUTs and finalize without another create',async()=>{
 const f=fixture();await originalPendingCreate(f);const original=JSON.stringify(f.snapshot()!.steps.create);
 const result=await resumeDataEchoCreatedPublication(f.deps);assert.equal(result.publicUrl,f.url,JSON.stringify(result));assert.deepEqual(f.writes.map(x=>x.init.method),['PUT','PUT','POST']);assert(f.writes.every(x=>x.url!==DATAECHO_API+'/publish'));assert.equal(JSON.stringify(f.snapshot()!.steps.create),original);
 assert.equal((await resumeDataEchoCreatedPublication(f.deps)).reasonCode,'submission_unknown');assert.equal(f.writes.length,3);
});
test('original continuation fails closed on disabled gate, expiry, remote conflicts, armed upload and changed draft',async()=>{
 for(const mode of ['disabled','expired','current','pending','protected','files','armed','draft'] as const){const f=fixture(),pending=await originalPendingCreate(f);
  if(mode==='disabled')f.deps.executionEnabled=false;
  if(mode==='expired')f.deps.now=()=>new Date(Date.parse(at)+3600_000);
  if(mode==='current')(pending as any).currentVersionId='other_version';
  if(mode==='pending')pending.pendingVersionId='other_version';
  if(mode==='protected')pending.passwordProtected=true;
  if(mode==='files')pending.filesCount=1;
  if(mode==='armed')await f.deps.journal.arm(f.snapshot()!.intent,'upload_index');
  if(mode==='draft')f.deps.task.draft!.body+=' changed';
  const result=await resumeDataEchoCreatedPublication(f.deps);assert.equal(result.publicUrl,undefined,mode);assert.equal(f.writes.length,0,mode);
 }
});

const cfModule=`<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092" integrity="sha512-UKNk8GbxkABxKcXYuLkO16EleLGUkcvJWtpSNmExE0Too3ZaFAxTscNWEc1OdAv5/BikHawapSCaiD2XCmp+Bw==" data-cf-beacon='{"version":"2024.11.0","token":"${'a'.repeat(32)}","r":1,"spa":2}' crossorigin="anonymous"></script>`;
const cfRobots='# Managed platform search policy\nUser-agent: *\nContent-Signal: search=yes,ai-train=no,use=reference\nAllow: /\nUser-agent: GPTBot\nDisallow: /\nUser-agent: ClaudeBot\nDisallow: /\nUser-agent: Google-Extended\nDisallow: /\nUser-agent: *\nAllow: /\n';
test('observed immutable Cloudflare module and training-only robots block preserve original public document',async()=>{
 const f=fixture(),html=f.doc.html.replace('</body>',cfModule+'\n</body>');assert.equal(dataEchoPublicHtmlMatches(html,f.doc.html),true);assert.equal(dataEchoRobotsAllows(cfRobots,'/'),true);
 f.setPublicHtml(html);const fetch=f.deps.fetch;f.deps.fetch=async(url,init)=>url===f.url+'robots.txt'?new Response('#'+'p'.repeat(2000)+'\n'+cfRobots,{headers:{'content-type':'text/plain'}}):fetch(url,init);
 assert.equal((await runDataEchoTask(f.deps)).publicUrl,f.url);assert.equal(f.writes.length,4);
});
test('Cloudflare allowance still rejects changed prose, links, markup, unknown scripts and altered module attributes',()=>{
 const f=fixture(),html=f.doc.html.replace('</body>',cfModule+'\n</body>');
 for(const bad of [html.replace('Reproduce','Changed'),html.replace(f.doc.target,'https://other.example.org/'),html.replace('<main>','<main hidden>'),html.replace('beacon.min.js/','evil.min.js/'),html.replace('sha512-UKNk','sha512-XXXX'),html.replace('type="module"','type="text/javascript"'),html.replace('crossorigin="anonymous"','crossorigin="use-credentials"'),html.replace('</script>','alert(1)</script>'),html.replace('data-cf-beacon=', 'onload="alert(1)" data-cf-beacon='),html.replace('</body>','<script src="https://unknown.example.org/a.js"></script></body>'),html.replace('"spa":2','"spa":3')])assert.equal(dataEchoPublicHtmlMatches(bad,f.doc.html),false);
});
test('search robots groups and explicit Content-Signal search=no remain blocked',()=>{
 for(const bot of ['*','Googlebot','Bingbot']){const robots=bot==='*'?'User-agent: *\nDisallow: /\n':cfRobots+`User-agent: ${bot}\nDisallow: /\n`;assert.equal(dataEchoRobotsAllows(robots,'/'),false,bot)}
 for(const value of ['search=no','ai-train=no, search = no','SEARCH=NO;ai-train=no'])assert.equal(dataEchoRobotsAllows('User-agent: *\nContent-Signal: '+value+'\nAllow: /\n','/'),false,value);
 assert.equal(dataEchoRobotsAllows('','/'),false);assert.equal(dataEchoRobotsAllows(cfRobots+'# Content-Signal: search=no\n','/'),true);
});
test('actual readback still rejects search noindex headers and robots search denials after harmless module insertion',async()=>{
 for(const mode of ['header','robots','signal'] as const){const f=fixture();f.setPublicHtml(f.doc.html.replace('</body>',cfModule+'\n</body>'));const fetch=f.deps.fetch;
 f.deps.fetch=async(url,init)=>mode==='header'&&url===f.url?new Response(f.doc.html,{headers:{'content-type':'text/html','x-robots-tag':'bingbot: noindex'}}):url===f.url+'robots.txt'?new Response(mode==='signal'?'User-agent: *\nContent-Signal: search=no\nAllow: /\n':cfRobots+'User-agent: Bingbot\nDisallow: /\n',{headers:{'content-type':'text/plain'}}):fetch(url,init);
 assert.equal((await runDataEchoTask(f.deps)).reasonCode,'submission_unknown',mode);assert.equal(f.writes.length,4);
 }
});
