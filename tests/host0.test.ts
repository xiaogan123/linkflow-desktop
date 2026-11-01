import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {articleReviewBindingHash,articleReviewTargetUrl} from '../src/main/article-review';
import {defaultSettings} from '../src/main/store';
import {HOST0_API,host0Document,host0ReservedSlug,probeHost0FreeAccount,runHost0Task,resumeHost0CreatedApp,verifyHost0Publication,type Host0Dependencies,type Host0Intent,type Host0JournalSnapshot,type Host0Step} from '../src/integrations/host0';
import type {ConnectedResponse} from '../src/integrations/batch5-connected';
import type {Account,Channel,Site,Task} from '../src/shared/types';

const at='2026-10-30T09:00:00.000Z',target='https://software.example.org/guide',key=`h0_${'a'.repeat(40)}`;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fixture(){
  const site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Software Example',description:'Maintained software guide',email:'owner@example.org',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:at};
  const channel:Channel={id:'host0',name:'host0',domain:'host0.app',url:'https://host0.ai/',submitUrl:'https://host0.ai/api/v1/apps',categories:['software'],languages:['*'],kind:'article',free:'conditional',freeNote:'Free only',quality:'C',qualityReason:'',rulesUrl:'https://host0.ai/terms',notes:'',emailRequired:false,accountRequired:true,articleRequired:true,automation:'api',enabled:true,allowedHosts:['host0.ai','host0.app'],singleSiteOnly:true,checkedAt:at,
    termsCache:{version:1,channelId:'host0',checkedAt:at,sourceHash:'a'.repeat(64),finance:'allowed',promotion:'allowed',disclosurePlacement:'required',summary:'Original software documentation permitted.',conclusionHash:'b'.repeat(64),sources:[{url:'https://host0.ai/terms',kind:'content_policy',text:'Original software documentation permitted.',appliesTo:'host0',applicability:'verified'}],reviewVersion:2}};
  const account:Account={id:randomUUID(),channelId:'host0',email:'owner@example.org',username:'owner@example.org',ownerSiteId:site.id,createdAt:at,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token'};
  const task:Task={id:randomUUID(),siteId:site.id,channelId:'host0',accountId:account.id,sourceDomain:'host0.app',status:'running',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'',topicUrl:target,draftRevision:1,
    draft:{title:'Reproducing a software release',description:'An original diagnostic guide.',body:`Written by an AI assistant for Software Example. Reproduce the configuration, compare release notes, and document failures. See the [maintained project guide](${target}). We maintain the linked project.`}};
  const settings={...defaultSettings(),articleReviewMode:'ai' as const};
  task.articleReview={status:'passed',reason:'Independent technical guide',reasonCode:'passed',reviewContractVersion:5,bindingVersion:2,targetUrl:articleReviewTargetUrl(task,site),termsHash:channel.termsCache!.conclusionHash,contextHash:articleReviewBindingHash(task,site,channel),draftRevision:1,contentHash:'c'.repeat(64),evidenceUrls:[site.url],reviewedAt:at};
  const publicationContext={scope:'visible_workspace_only' as const,sameChannelTasks:1,sameAccountTasks:1,distinctSites:1,publicationIntent:'single_original_article' as const,workflowPurpose:'expand_backlink_channels' as const,knownContentPattern:'unknown' as const};
  const slug=host0ReservedSlug(task.id),url=`https://${slug}.host0.app/`,appId='app_123456789',deployment='deployment_123456789';
  const doc=host0Document(site,task);let snapshot:Host0JournalSnapshot|undefined,visibility:'private'|'public'='private',created=false,
    publicHtml=doc.html.replace('</body>','<div id="host0-badge">Hosted on host0</div><script src="/analytics.js"></script></body>'),robots='User-agent: *\nAllow: /\n';
  const writes:string[]=[],calls:string[]=[];
  const journal={load:async()=>snapshot,reserve:async(intent:Host0Intent)=>{assert.equal(snapshot,undefined);snapshot={intent,steps:{}}},arm:async(intent:Host0Intent,step:Host0Step)=>{assert.deepEqual(snapshot?.intent,intent);assert.equal(snapshot?.steps[step],undefined);snapshot!.steps[step]={stage:'sending'}},
    saveResponse:async(intent:Host0Intent,step:Host0Step,response:ConnectedResponse)=>{assert.deepEqual(snapshot?.intent,intent);assert.equal(snapshot?.steps[step]?.stage,'sending');snapshot!.steps[step]={stage:'response',response}}};
  let free=true,available=true,publicSlots=3,overLimit=false;
  const fetch=async (path:string,init:RequestInit):Promise<Response>=>{
    calls.push(`${init.method} ${path}`);if(init.method!=='GET')writes.push(`${init.method} ${path}`);
    if(path===`${HOST0_API}/account`)return json({email:account.email,plan:{id:free?'free':'pro'},limits:{account:{max_apps:100,max_public_apps:3},upload:{max_files:1000,max_file_bytes:3_145_728,max_total_bytes:104_857_600}},usage:{public_apps:3-publicSlots,max_public_apps:3,stored_bytes:0,storage_quota_bytes:524_288_000,over_visit_limit:overLimit}});
    if(path===`${HOST0_API}/apps`&&init.method==='GET')return json([]);
    if(path===`${HOST0_API}/slugs/${slug}`)return json({slug,available});
    if(path===`${HOST0_API}/apps/${slug}`&&init.method==='GET')return created?json({id:appId,slug,name:task.draft!.title,owner_email:account.email,visibility,url:url.slice(0,-1)}):json({error:'not_found'},404);
    if(path===`${HOST0_API}/apps`&&init.method==='POST'){created=true;return json({id:appId,slug},201)}
    if(path===`${HOST0_API}/apps/${appId}`&&init.method==='GET')return json({id:appId,slug,name:task.draft!.title,owner_email:account.email,visibility,url:url.slice(0,-1)});
    if(path===`${HOST0_API}/apps/${appId}/files/index.html`&&init.method==='GET')return new Response(doc.html,{headers:{'content-type':'application/octet-stream'}});
    if(path===`${HOST0_API}/apps/${appId}/deployments`&&init.method==='POST'){const body=JSON.parse(String(init.body));assert.deepEqual(body.files.map((file:{path:string})=>file.path),['index.html','robots.txt']);return json({deployment_id:deployment},201)}
    if(path===`${HOST0_API}/deployments/${deployment}/files/index.html`&&init.method==='PUT'){assert.equal(Buffer.from(init.body as Uint8Array).toString(),doc.html);return new Response(null,{status:204})}
    if(path===`${HOST0_API}/deployments/${deployment}/files/robots.txt`&&init.method==='PUT'){assert.equal(Buffer.from(init.body as Uint8Array).toString(),robots);return new Response(null,{status:204})}
    if(path===`${HOST0_API}/deployments/${deployment}/finalize`&&init.method==='POST')return json({status:'live',url:url.slice(0,-1),deployment_id:deployment,version:1,previous_version:null});
    if(path===`${HOST0_API}/apps/${appId}`&&init.method==='PATCH'){assert.deepEqual(JSON.parse(String(init.body)),{visibility:'public'});visibility='public';return json({visibility:'public'})}
    if(path===url)return new Response(publicHtml,{headers:{'content-type':'text/html'}});
    if(path===`${url}robots.txt`)return new Response(robots,{headers:{'content-type':'text/plain'}});
    throw Error(`unexpected ${init.method} ${path}`);
  };
  const deps:Host0Dependencies={site,channel,task,account,settings,publicationContext,apiKey:key,signal:new AbortController().signal,fetch,journal,assertAuthorized:()=>{},now:()=>new Date(at)};
  return {deps,writes,calls,url,slug,doc,setFree:(value:boolean)=>{free=value},setAvailable:(value:boolean)=>{available=value},setPublicSlots:(value:number)=>{publicSlots=value},setOverLimit:(value:boolean)=>{overLimit=value},setPublicHtml:(value:string)=>{publicHtml=value},setRobots:(value:string)=>{robots=value},snapshot:()=>snapshot};
}

test('host0 publishes one private app, exact two-file deployment and public document',async()=>{
  const f=fixture();const result=await runHost0Task(f.deps);
  assert.equal(result.publicUrl,f.url,JSON.stringify(result));assert.equal(f.writes.length,6);
  assert.deepEqual(f.writes.map(value=>value.split(' ')[0]),['POST','POST','PUT','PUT','POST','PATCH']);
  assert.equal((await verifyHost0Publication(f.deps)).found,true);
  assert.equal((await runHost0Task(f.deps)).status,'review');assert.equal(f.writes.length,6);
  f.setPublicHtml(f.doc.html.replace('<head>','<head><meta name="robots" content="noindex">'));
  assert.equal((await verifyHost0Publication(f.deps)).found,false);
});

test('unknown app creation response leaves a durable sending guard and restarts GET-only',async()=>{
  const f=fixture();let posts=0;const original=f.deps.fetch;
  f.deps.fetch=async(url,init)=>{if(url===`${HOST0_API}/apps`&&init.method==='POST'){posts++;throw Error('response lost')}return original(url,init)};
  assert.equal((await runHost0Task(f.deps)).reasonCode,'submission_unknown');
  assert.equal(f.snapshot()?.steps.create_app?.stage,'sending');
  assert.equal((await runHost0Task(f.deps)).reasonCode,'submission_unknown');assert.equal(posts,1);
  assert.ok(f.calls.every(value=>!value.startsWith('PATCH')));
});

test('host0 does not accept crawler-specific or generic meta none as indexable',async()=>{
  const f=fixture();assert.equal((await runHost0Task(f.deps)).publicUrl,f.url);
  for(const name of ['robots','Googlebot','bingbot']){
    f.setPublicHtml(f.doc.html.replace('<head>',`<head><meta name="${name}" content="none">`));
    assert.equal((await verifyHost0Publication(f.deps)).found,false,name);
  }
  f.setPublicHtml(f.doc.html.replace('<head>','<head><meta name="robots" content="all">'));
  assert.equal((await verifyHost0Publication(f.deps)).found,true);
  assert.equal(f.writes.length,6);
});

test('every host0 mutation rechecks authorization after its intent is armed',async()=>{
  for(const denied of ['create_app','create_deployment','upload_index','upload_robots','finalize','publicize'] as Host0Step[]){
    const f=fixture();let checked=false;
    f.deps.assertAuthorized=(_intent,step)=>{if(step===denied){checked=true;throw Error('permission revoked')}};
    const result=await runHost0Task(f.deps);
    assert.equal(result.reasonCode,'submission_unknown',denied);assert.equal(checked,true,denied);
    assert.equal(f.snapshot()?.steps[denied]?.stage,'sending',denied);
    const expected=['create_app','create_deployment','upload_index','upload_robots','finalize','publicize'].indexOf(denied);
    assert.equal(f.writes.length,expected,denied);
  }
});

test('host0 stops before any write for Free cap, slug collision, changed draft or identity',async()=>{
  const f=fixture();f.setFree(false);assert.equal((await runHost0Task(f.deps)).status,'needs_input');assert.equal(f.writes.length,0);
  const g=fixture();g.setPublicSlots(0);assert.equal((await runHost0Task(g.deps)).status,'needs_input');assert.equal(g.writes.length,0);
  const h=fixture();h.setAvailable(false);assert.equal((await runHost0Task(h.deps)).status,'needs_input');assert.equal(h.writes.length,0);
  const i=fixture();i.deps.task.draft!.body+=' changed';assert.equal((await runHost0Task(i.deps)).status,'needs_input');assert.equal(i.writes.length,0);
  const j=fixture();j.deps.account.username='other@example.org';assert.equal((await runHost0Task(j.deps)).status,'needs_input');assert.equal(j.writes.length,0);
});

test('host0 rejects a noindex public response and account limit without claiming acceptance',async()=>{
  const f=fixture();assert.equal((await runHost0Task(f.deps)).status,'review');f.setRobots('User-agent: *\nDisallow: /\n');
  assert.equal((await verifyHost0Publication(f.deps)).found,false);
  const g=fixture();g.setOverLimit(true);await assert.rejects(probeHost0FreeAccount(g.deps,g.deps.account.email),/capacity/);
});

 test('host0 accepts an explicit Chinese AI assistant disclosure in original software text',()=>{
  const f=fixture();f.deps.task.draft!.body='本文由 AI 辅助代理撰写。先复现软件配置，再核对版本行为。See the [maintained project guide]('+target+').';
  assert.ok(host0Document(f.deps.site,f.deps.task).html.includes('AI 辅助代理'));
});

test('proved app_id receipt can continue only untouched original private app without replaying create',async()=>{
 for(const bad of ['none','owner','deployed','armed','changed'] as const){
  const f=fixture(),base=f.deps.fetch;let stop=true;
  f.deps.fetch=async(url,init)=>{
   const r=await base(url,init);
   if(url===`${HOST0_API}/apps`&&init.method==='POST'){const v=await r.json() as {id:string;slug:string};return json({app_id:v.id,slug:v.slug},201)}
   if(url.includes('/apps/')&&init.method==='GET'&&!url.includes('/files/')&&!url.endsWith(f.slug)){
    if(stop)throw Error('temporary readback unavailable');const v=await r.json() as Record<string,unknown>;return json({...v,owner_email:bad==='owner'?'wrong@example.org':v.owner_email,live_deployment_id:bad==='deployed'?'deployment_other':null});
   }return r;
  };
  assert.equal((await runHost0Task(f.deps)).reasonCode,'submission_unknown');assert.equal(f.writes.length,1);stop=false;
  if(bad==='armed')f.snapshot()!.steps.create_deployment={stage:'sending'};
  if(bad==='changed')f.snapshot()!.intent.requestHash='0'.repeat(64);
  const result=await resumeHost0CreatedApp(f.deps);assert.equal(f.writes.length,bad==='none'?6:1,bad);
  assert.equal(result.publicUrl,bad==='none'?f.url:undefined,bad);
  await resumeHost0CreatedApp(f.deps);assert.equal(f.writes.length,bad==='none'?6:1);
 }
});


test('host0 accepts its empty Disallow robots response without treating robots-file noindex as page noindex',async()=>{
 const f=fixture();await runHost0Task(f.deps);const original=f.deps.fetch;let policy='User-agent: *\nDisallow:\n';
 f.deps.fetch=async(url,init)=>url===f.url+'robots.txt'?new Response(policy,{headers:{'content-type':'text/plain','x-robots-tag':'noindex, nofollow, noarchive'}}):original(url,init);
 assert.equal((await verifyHost0Publication(f.deps)).found,true);
 for(const bad of ['User-agent: *\nDisallow: /\n','User-agent: Googlebot\nDisallow: /\nUser-agent: *\nAllow: /\n','<html>not robots</html>']){policy=bad;assert.equal((await verifyHost0Publication(f.deps)).found,false)}
 policy='User-agent: *\nDisallow:\n';f.setPublicHtml(f.doc.html.replace('<head>','<head><meta name="robots" content="noindex">'));
 assert.equal((await verifyHost0Publication(f.deps)).found,false);assert.equal(f.writes.length,6);
});


test('host0 permits only the observed immutable Cloudflare analytics module with its exact SRI',async()=>{
 const f=fixture();await runHost0Task(f.deps);
 const tag='<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092" integrity="sha512-UKNk8GbxkABxKcXYuLkO16EleLGUkcvJWtpSNmExE0Too3ZaFAxTscNWEc1OdAv5/BikHawapSCaiD2XCmp+Bw==" crossorigin="anonymous"></script>';
 f.setPublicHtml(f.doc.html.replace('</body>',tag+'</body>'));assert.equal((await verifyHost0Publication(f.deps)).found,true);
 for(const bad of [tag.replace('static.cloudflareinsights.com','other.example'),tag.replace('sha512-UK','sha512-ZZ'),tag.replace('type="module"','type="text/javascript"'),tag.replace('></script>','>alert(1)</script>'),tag.replace('1792088814092','1792088814093')]){f.setPublicHtml(f.doc.html.replace('</body>',bad+'</body>'));assert.equal((await verifyHost0Publication(f.deps)).found,false)}
 assert.equal(f.writes.length,6);
});
