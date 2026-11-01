import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {articleReviewBindingHash,articleReviewTargetUrl} from '../src/main/article-review';
import {defaultSettings} from '../src/main/store';
import {RENDER_API,renderDocument,parseRenderCredential,probeRenderConnection,runRenderTask,reconcileRenderTask,verifyRenderPublication,type RenderCredential} from '../src/integrations/render-publisher';
import type {Batch5Intent,Batch5Receipt,Batch5OpaqueResponse,Batch5Persistence} from '../src/integrations/batch5-contract';
import type {Account,Channel,Site,Task,ExecutionContext} from '../src/shared/types';
const at='2026-10-30T09:00:00.000Z',target='https://software.example.org/guide',key=`rnd_${'a'.repeat(40)}`;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fixture(){
  const site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Software Example',description:'Maintained software guide',email:'owner@example.org',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:at};
  const channel:Channel={id:'render',name:'render',domain:'render.com',url:'https://render.com/',submitUrl:'https://dashboard.render.com/',categories:['software'],languages:['*'],kind:'article',free:'conditional',freeNote:'Free only',quality:'C',qualityReason:'',rulesUrl:'https://render.com/terms',notes:'',emailRequired:false,accountRequired:true,articleRequired:true,automation:'api',enabled:true,allowedHosts:['render.com','dashboard.render.com'],singleSiteOnly:true,checkedAt:at,
    termsCache:{version:1,channelId:'render',checkedAt:at,sourceHash:'a'.repeat(64),finance:'allowed',promotion:'allowed',disclosurePlacement:'required',summary:'Original software documentation permitted.',conclusionHash:'b'.repeat(64),sources:[{url:'https://render.com/terms',kind:'content_policy',text:'Original software documentation permitted.',appliesTo:'render',applicability:'verified'}],reviewVersion:2}};
  const account:Account={id:randomUUID(),channelId:'render',email:'owner@example.org',username:'owner@example.org',ownerSiteId:site.id,createdAt:at,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token'};
  const task:Task={id:randomUUID(),siteId:site.id,channelId:'render',accountId:account.id,sourceDomain:'render.com',status:'running',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'',topicUrl:target,draftRevision:1,
    draft:{title:'Reproducing a software release',description:'An original diagnostic guide.',body:`Written by an AI assistant for Software Example. Reproduce the configuration, compare release notes, and document failures. See the [maintained project guide](${target}). We maintain the linked project.`}};
  const settings={...defaultSettings(),articleReviewMode:'ai' as const};
  task.articleReview={status:'passed',reason:'Independent technical guide',reasonCode:'passed',reviewContractVersion:5,bindingVersion:2,targetUrl:articleReviewTargetUrl(task,site),termsHash:channel.termsCache!.conclusionHash,contextHash:articleReviewBindingHash(task,site,channel),draftRevision:1,contentHash:'c'.repeat(64),evidenceUrls:[site.url],reviewedAt:at};
  const publicationContext={scope:'visible_workspace_only' as const,sameChannelTasks:1,sameAccountTasks:1,distinctSites:1,publicationIntent:'single_original_article' as const,workflowPurpose:'expand_backlink_channels' as const,knownContentPattern:'unknown' as const};


  const source={version:1 as const,repository:'https://github.com/synthetic-owner/software-docs',repositoryId:123,githubLogin:'synthetic-owner',githubUserId:456,baseBranch:'main'};const secret:RenderCredential={version:1,apiKey:key,ownerId:'tea-1234567890abcdefghij',email:'owner@example.org',githubToken:'ghp_'+'b'.repeat(40),source};account.username=secret.ownerId;account.renderSource=source;task.renderCapacity={version:1,source:'dashboard_observation',ownerId:secret.ownerId,observedAt:at,plan:'hobby',paymentMethod:'none',pendingCharges:0,servicesUsed:0,bandwidthBytesUsed:0,pipelineMinutesUsed:0,activeBuilds:0,queuedBuilds:0,evidenceHash:'e'.repeat(64)};
  const slug='guide-ab1234',url=`https://${slug}.onrender.com/`,commit='c'.repeat(40),serviceId='srv-1234567890abcdefghij',deployId='dep-1234567890abcdefghij';let writes:any[]=[];
  let intent:Batch5Intent|undefined,receipt:Batch5Receipt|undefined,opaque:Batch5OpaqueResponse|undefined,sending=false,blocked=false;
  const journal:Batch5Persistence={loadRenderWrites:async()=>writes,reserveRenderWrite:async w=>{assert.equal(writes.some(x=>x.stage===w.stage),false);writes.push(w)},saveRenderWriteResponse:async(stage,value)=>{const w=writes.find(x=>x.stage===stage);assert(w);assert(!w.opaque);w.opaque=value},saveIntent:async()=>{throw Error('use reserve')},reserveIntent:async value=>{assert.equal(intent,undefined);intent=value},loadIntent:async()=>intent,
    assertReadyToSubmit:async value=>{assert.equal(value,intent);if(blocked)throw Error('revoked')},markSending:async()=>{assert.equal(sending,false);if(blocked)throw Error('revoked');sending=true},saveReceipt:async value=>{receipt=value},loadReceipt:async()=>receipt,
    saveOpaqueResponse:async value=>{opaque=value},loadOpaqueResponse:async()=>opaque,currentTaskState:()=>task.batch5};
  const secrets=new Map([[`account:${account.id}`,JSON.stringify(secret)]]);
  const context:ExecutionContext={site,task,channel,settings,signal:new AbortController().signal,ai:{json:async<T>()=>({} as T)},getAccount:()=>account,
    getArticlePublicationContext:()=>publicationContext,secrets:{get:async k=>secrets.get(k),set:async(k,v)=>{secrets.set(k,v)},delete:async k=>{secrets.delete(k)}},saveAccount:async()=>{},checkpoint:partial=>{Object.assign(task,partial)},log:()=>{},batch5Persistence:journal};
  const doc=renderDocument(context),request=JSON.parse(doc.request),created:any={service:{...request,id:serviceId,suspended:'not_suspended',serviceDetails:{...request.serviceDetails,url,buildPlan:'starter'}},deployId};
  const metadata:any=created.service,stats:any={};let deployment:any={id:deployId,status:'live',commit:{id:commit}};
  let publicHtml=doc.html,robots='User-agent: *\nAllow: /\n',ownedSites:any[]|undefined,pageHeaders:Record<string,string>={},native={found:true,indexable:true,rel:doc.rel};
  const calls:{url:string;init:RequestInit}[]=[];let creates=0,renders=0;
  const fetch=async(path:string,init:RequestInit)=>{
    calls.push({url:path,init});assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
    if(path.startsWith(RENDER_API)){assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${key}`)}else if(!path.startsWith('https://api.github.com/'))assert.equal(new Headers(init.headers).has('authorization'),false);
    if(path===RENDER_API+'/owners/'+secret.ownerId)return json({id:secret.ownerId,email:secret.email,name:'Synthetic Workspace',type:'team'});
    if(path===RENDER_API+'/services'&&init.method==='POST'){creates++;assert.equal(sending,true);assert.equal(init.body,doc.request);return json(created,201)}
    if(path===RENDER_API+'/services/'+serviceId)return json(metadata);
    if(path===RENDER_API+'/services/'+serviceId+'/deploys/'+deployId)return json(deployment);
    const base='https://api.github.com/repos/synthetic-owner/software-docs';
    if(path.startsWith('https://api.github.com/')){
      assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${secret.githubToken}`);
      if(path==='https://api.github.com/user')return json({login:source.githubLogin,id:source.githubUserId});
      if(path===base)return json({id:source.repositoryId,owner:{login:source.githubLogin},private:false,archived:false,disabled:false,permissions:{admin:true,push:true},default_branch:'main'});
      if(path===base+'/actions/permissions')return json({enabled:false});
      if(path===base+'/git/ref/heads/main')return json({ref:'refs/heads/main',object:{type:'commit',sha:'a'.repeat(40)}});
      if(path===base+'/git/trees/'+'a'.repeat(40)+'?recursive=1')return json({truncated:false,tree:[{path:'README.md',type:'blob',mode:'100644'}]});
      if(path===base+'/git/ref/heads/'+doc.branch)return writes.some(w=>w.stage==='source_ref'&&w.opaque)?json({ref:'refs/heads/'+doc.branch,object:{type:'commit',sha:commit}}):json({message:'Not Found'},404);
      if(path.includes('/contents/')&&init.method==='PUT'){const body=JSON.parse(String(init.body));assert.equal(Object.hasOwn(body,'sha'),false);assert.equal(body.author.email,'456+synthetic-owner@users.noreply.github.com');assert.deepEqual(body.author,body.committer);return json({content:{path:path.split('/contents/')[1]},commit:{sha:commit,author:body.author,committer:body.committer}},201)}
      if(path===base+'/git/refs'&&init.method==='POST'){assert.deepEqual(JSON.parse(String(init.body)),{ref:'refs/heads/'+doc.branch,sha:commit});return json({ref:'refs/heads/'+doc.branch,object:{type:'commit',sha:commit}},201)}
    }
    if(path.startsWith('https://raw.githubusercontent.com/'))return new Response(path.endsWith('/robots.txt')?robots:doc.html,{headers:{'content-type':'text/plain'}});
    if(path===url){assert.equal(init.method,'GET');return new Response(publicHtml,{headers:{'content-type':'text/html',...pageHeaders}})}
    if(path===url+'robots.txt'){assert.equal(init.method,'GET');return new Response(robots,{headers:{'content-type':'text/plain'}})}
    throw Error('unexpected '+path);
  };
  context.batch5Dependencies={fetch,now:()=>new Date(at),renderPage:async(u,t,title,markdown)=>{renders++;assert.equal(u,url);assert.equal(t,target);assert.equal(title,task.draft!.title);assert.equal(markdown,task.draft!.body);return native}};
  return {context,secret,journal,secrets,metadata,stats,created,doc,calls,url,creates:()=>creates,renders:()=>renders,intent:()=>intent,receipt:()=>receipt,opaque:()=>opaque,
    block:()=>{blocked=true},setHtml:(v:string)=>{publicHtml=v},setRobots:(v:string)=>{robots=v},setOwned:(v:any[])=>{ownedSites=v},setHeaders:(v:Record<string,string>)=>{pageHeaders=v},setNative:(v:typeof native)=>{native=v},deployment,writes:()=>writes};
}

test('automatic original source: two Contents PUTs, one unique ref POST, one service POST; GET-only restart',async()=>{
 const f=fixture(),r=await runRenderTask(f.context);assert.equal(r.publicUrl,f.url);assert.equal(f.creates(),1);assert.equal(f.writes().length,4);
 assert.equal((await verifyRenderPublication(f.context)).found,true);const before=f.calls.filter(x=>x.init.method!=='GET').length;await runRenderTask(f.context);assert.equal(f.calls.filter(x=>x.init.method!=='GET').length,before);
});
test('free dashboard evidence absent, stale, future, paid, full, busy or wrong owner prevents all writes',async()=>{
 for(const mode of ['missing','stale','future','paid','full','busy','owner'] as const){const f=fixture();if(mode==='missing')delete f.context.task.renderCapacity;else{const q=f.context.task.renderCapacity!;if(mode==='stale')q.observedAt='2020-01-01T00:00:00Z';if(mode==='future')q.observedAt='2030-01-01T00:00:00Z';if(mode==='paid')(q as any).paymentMethod='card';if(mode==='full')q.pipelineMinutesUsed=499;if(mode==='busy')(q as any).queuedBuilds=1;if(mode==='owner')q.ownerId='tea-other1234567890';}
 assert.equal((await runRenderTask(f.context)).status,'needs_input',mode);assert.equal(f.calls.filter(x=>x.init.method!=='GET').length,0);}
});
test('unknown outcomes at each of four writes never repeat any write on restart',async()=>{
 for(let index=0;index<4;index++){const f=fixture(),base=f.context.batch5Dependencies!.fetch!;let writes=0;f.context.batch5Dependencies!.fetch=async(u,i)=>{if(i.method!=='GET'&&writes++===index)throw Error('lost');return base(u,i)};assert.equal((await runRenderTask(f.context)).reasonCode,'submission_unknown');const prior=writes;await runRenderTask(f.context);assert.equal(writes,prior);}
});
test('review, late draft, credential and dashboard revocations stop before subsequent mutation',async()=>{
 for(const mode of ['review','draft','secret','capacity'] as const){const f=fixture(),base=f.context.batch5Dependencies!.fetch!;let writes=0;f.context.batch5Dependencies!.fetch=async(u,i)=>{const r=await base(u,i);if(i.method!=='GET'&&++writes===1){if(mode==='review')f.context.task.articleReview=undefined;if(mode==='draft')f.context.task.draft!.body+='changed';if(mode==='secret')f.secrets.clear();if(mode==='capacity')delete f.context.task.renderCapacity;}return r};await runRenderTask(f.context);assert.equal(writes,1,mode);}
});
test('opaque service response recovers without another Git or Render write after receipt disk failure',async()=>{
 const f=fixture(),save=f.journal.saveReceipt;f.journal.saveReceipt=async()=>{throw Error('disk')};assert.equal((await runRenderTask(f.context)).reasonCode,'submission_unknown');f.journal.saveReceipt=save;assert.equal((await reconcileRenderTask(f.context)).status,'found');assert.equal(f.creates(),1);
});
test('owned deployment needs exact original commit, source, static/free configuration and live status',async()=>{
 for(const mode of ['commit','pending','owner','repo','branch','autodeploy','build','root','url'] as const){const f=fixture();await runRenderTask(f.context);if(mode==='commit')f.deployment.commit.id='f'.repeat(40);if(mode==='pending')f.deployment.status='build_in_progress';if(mode==='owner')f.metadata.ownerId='tea-other1234567890';if(mode==='repo')f.metadata.repo='https://github.com/foreign/repo';if(mode==='branch')f.metadata.branch='main';if(mode==='autodeploy')f.metadata.autoDeployTrigger='commit';if(mode==='build')f.metadata.serviceDetails.buildPlan='performance';if(mode==='root')f.metadata.rootDir='public';if(mode==='url')f.metadata.serviceDetails.url='https://foreign.onrender.com/';assert.equal((await verifyRenderPublication(f.context)).found,false,mode);}
});
test('HTML noindex, changed original, canonical mismatch, robots denial and absent native proof stay unaccepted',async()=>{
 for(const mode of ['meta','header','canonical','body','robots','native'] as const){const f=fixture();await runRenderTask(f.context);if(mode==='meta')f.setHtml(f.doc.html.replace('</head>','<meta name="robots" content="none"></head>'));if(mode==='header')f.setHeaders({'x-robots-tag':'none'});if(mode==='canonical')f.setHtml(f.doc.html.replace('</head>','<link rel="canonical" href="https://render.com/"></head>'));if(mode==='body')f.setHtml('<main>Changed</main>');if(mode==='robots')f.setRobots('User-agent: *\nDisallow: /\n');if(mode==='native')delete f.context.batch5Dependencies!.renderPage;assert.equal((await verifyRenderPublication(f.context)).found,false,mode);}
});
test('connection and Git preflight reject wrong owner, active Actions, foreign repo and existing branch',async()=>{
 for(const mode of ['owner','actions','repo','branch'] as const){const f=fixture(),base=f.context.batch5Dependencies!.fetch!;f.context.batch5Dependencies!.fetch=async(u,i)=>{if(mode==='owner'&&u.includes('/owners/'))return json({id:'tea-foreign12345678',email:'owner@example.org',name:'Other',type:'team'});if(mode==='actions'&&u.endsWith('/actions/permissions'))return json({enabled:true});if(mode==='repo'&&u.endsWith('/software-docs'))return json({private:true});if(mode==='branch'&&u.endsWith('/heads/'+f.doc.branch))return json({ref:'exists'});return base(u,i)};assert.equal((await runRenderTask(f.context)).status,'needs_input',mode);assert.equal(f.writes().length,0);}
});

test('original service stage opaque recovers a failed aggregate opaque save; corrupted service intent stays unknown',async()=>{
 const f=fixture();f.journal.saveOpaqueResponse=async()=>{throw Error('disk after stage receipt')};assert.equal((await runRenderTask(f.context)).reasonCode,'submission_unknown');assert.equal((await reconcileRenderTask(f.context)).status,'found');assert.equal(f.creates(),1);
 const g=fixture();await runRenderTask(g.context);g.writes()[3].requestBody='{}';assert.equal((await reconcileRenderTask(g.context)).status,'unknown');assert.equal(g.creates(),1);
});
