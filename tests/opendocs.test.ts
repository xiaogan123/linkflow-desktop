import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {marked} from 'marked';
import {articleReviewBindingHash,articleReviewTargetUrl} from '../src/main/article-review';
import {defaultSettings} from '../src/main/store';
import {OPENDOCS_API,OPENDOCS_ORIGIN,opendocsDocument,parseOpenDocsCredential,probeOpenDocsConnection,runOpenDocsTask,reconcileOpenDocsTask,verifyOpenDocsPublication,opendocsRobotsAllows,type OpenDocsCredential} from '../src/integrations/opendocs';
import type {Batch5Intent,Batch5Receipt,Batch5OpaqueResponse,Batch5Persistence} from '../src/integrations/batch5-contract';
import type {Account,Channel,Site,Task,ExecutionContext} from '../src/shared/types';
const at='2026-10-30T09:00:00.000Z',target='https://software.example.org/guide',key=`od_live_${'a'.repeat(40)}`;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fixture(){
  const site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Software Example',description:'Maintained software guide',email:'owner@example.org',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:at};
  const channel:Channel={id:'opendocs',name:'opendocs',domain:'opendocs.cc',url:'https://opendocs.cc/',submitUrl:'https://opendocs.cc/api/v1/apps',categories:['software'],languages:['*'],kind:'article',free:'conditional',freeNote:'Free only',quality:'C',qualityReason:'',rulesUrl:'https://opendocs.cc/terms',notes:'',emailRequired:false,accountRequired:true,articleRequired:true,automation:'api',enabled:true,allowedHosts:['opendocs.cc','opendocs.cc'],singleSiteOnly:true,checkedAt:at,
    termsCache:{version:1,channelId:'opendocs',checkedAt:at,sourceHash:'a'.repeat(64),finance:'allowed',promotion:'allowed',disclosurePlacement:'required',summary:'Original software documentation permitted.',conclusionHash:'b'.repeat(64),sources:[{url:'https://opendocs.cc/terms',kind:'content_policy',text:'Original software documentation permitted.',appliesTo:'opendocs',applicability:'verified'}],reviewVersion:2}};
  const account:Account={id:randomUUID(),channelId:'opendocs',email:'owner@example.org',username:'owner@example.org',ownerSiteId:site.id,createdAt:at,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token'};
  const task:Task={id:randomUUID(),siteId:site.id,channelId:'opendocs',accountId:account.id,sourceDomain:'opendocs.cc',status:'running',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'',topicUrl:target,draftRevision:1,
    draft:{title:'Reproducing a software release',description:'An original diagnostic guide.',body:`Written by an AI assistant for Software Example. Reproduce the configuration, compare release notes, and document failures. See the [maintained project guide](${target}). We maintain the linked project.`}};
  const settings={...defaultSettings(),articleReviewMode:'ai' as const};
  task.articleReview={status:'passed',reason:'Independent technical guide',reasonCode:'passed',reviewContractVersion:5,bindingVersion:2,targetUrl:articleReviewTargetUrl(task,site),termsHash:channel.termsCache!.conclusionHash,contextHash:articleReviewBindingHash(task,site,channel),draftRevision:1,contentHash:'c'.repeat(64),evidenceUrls:[site.url],reviewedAt:at};
  const publicationContext={scope:'visible_workspace_only' as const,sameChannelTasks:1,sameAccountTasks:1,distinctSites:1,publicationIntent:'single_original_article' as const,workflowPurpose:'expand_backlink_channels' as const,knownContentPattern:'unknown' as const};


  const secret:OpenDocsCredential={version:1,apiKey:key,userId:'synthetic-owner-id',username:'synthetic-owner',workspaceId:'ws_synthetic123',workspaceSlug:'synthetic-workspace'};account.opendocs={workspaceId:secret.workspaceId,workspaceSlug:secret.workspaceSlug,username:secret.username};account.email='';account.username=secret.userId;account.publicationUrl='https://opendocs.cc/'+secret.workspaceSlug;
  const identifier='guide123';let url='';
  let intent:Batch5Intent|undefined,receipt:Batch5Receipt|undefined,opaque:Batch5OpaqueResponse|undefined,sending=false,blocked=false;
  const journal:Batch5Persistence={saveIntent:async()=>{throw Error('use reserve')},reserveIntent:async value=>{assert.equal(intent,undefined);intent=value},loadIntent:async()=>intent,
    assertReadyToSubmit:async value=>{assert.equal(value,intent);if(blocked)throw Error('revoked')},markSending:async()=>{assert.equal(sending,false);if(blocked)throw Error('revoked');sending=true},saveReceipt:async value=>{receipt=value},loadReceipt:async()=>receipt,
    saveOpaqueResponse:async value=>{opaque=value},loadOpaqueResponse:async()=>opaque,currentTaskState:()=>task.batch5};
  const secrets=new Map([[`account:${account.id}`,JSON.stringify(secret)]]);
  const context:ExecutionContext={site,task,channel,settings,signal:new AbortController().signal,ai:{json:async<T>()=>({} as T)},getAccount:()=>account,
    getArticlePublicationContext:()=>publicationContext,secrets:{get:async k=>secrets.get(k),set:async(k,v)=>{secrets.set(k,v)},delete:async k=>{secrets.delete(k)}},saveAccount:async()=>{},checkpoint:partial=>{Object.assign(task,partial)},log:()=>{},batch5Persistence:journal};
  const doc=opendocsDocument(context);url='https://opendocs.cc/'+secret.workspaceSlug+'/'+doc.slug;const created={postId:identifier,publicUrl:url,url:'/'+secret.workspaceSlug+'/'+doc.slug,slug:doc.slug,title:doc.title};
  const metadata:any={id:identifier,slug:doc.slug,title:doc.title,visibility:'public',isPublished:true,tags:[],versionNumber:1,workspaceId:secret.workspaceId,workspaceSlug:secret.workspaceSlug,url:created.url,publicUrl:url};
  const owner:any={authenticated:true,userId:secret.userId,onboarding:{completed:true,username:secret.username,workspace:{id:secret.workspaceId,slug:secret.workspaceSlug,name:'Synthetic Workspace'}},quota:{documents:{plan:'free',limit:50,used:0,remaining:50}}};const raw:any={markdown:doc.content,title:doc.title,slug:doc.slug,versionNumber:1};
  const html=`<!doctype html><html><head><title>${task.draft!.title}</title></head><body><main><h1>${doc.title}</h1><article class="md-typeset">${marked.parse(doc.content,{async:false})}</article></main></body></html>`;
  let publicHtml=html,robots='User-agent: *\nAllow: /\nDisallow: /api/\n',total=0,pageHeaders:Record<string,string>={},native={found:true,indexable:true,rel:''};
  const calls:{url:string;init:RequestInit}[]=[];let creates=0,renders=0;
  const fetch=async(path:string,init:RequestInit)=>{
    calls.push({url:path,init});assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
    if(path.startsWith(OPENDOCS_API)){assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+key);assert.equal(new Headers(init.headers).get('content-type'),'application/json')}else assert.equal(new Headers(init.headers).has('authorization'),false);
    if(path===OPENDOCS_API+'/me'||path===OPENDOCS_API+'/me?workspaceId='+secret.workspaceId){assert.equal(init.method,'GET');owner.quota.documents.used=total;owner.quota.documents.remaining=Math.max(0,owner.quota.documents.limit-total);return json(owner)}
    if(path===OPENDOCS_API+'/workspaces')return json({workspaces:[{id:secret.workspaceId,slug:secret.workspaceSlug,name:'Synthetic Workspace',role:'owner'}]});
    if(path===OPENDOCS_API+'/posts/'+identifier+'?workspaceId='+secret.workspaceId)return json({post:metadata});
    if(path===OPENDOCS_API+'/posts/'+identifier+'/raw?workspaceId='+secret.workspaceId)return json(raw);
    if(path===OPENDOCS_API+'/publish'&&init.method==='POST'){creates++;assert.equal(sending,true);assert.deepEqual(JSON.parse(String(init.body)),{markdown:doc.body,title:doc.title,slug:doc.slug,workspaceId:secret.workspaceId,visibility:'public',confirmPublic:true});assert.equal(Object.hasOwn(JSON.parse(String(init.body)),'sourcePath'),false);return json(created,201)}
    if(path==='https://opendocs.cc/'+secret.workspaceSlug)return new Response('<html><head><link rel=canonical href="https://opendocs.cc/'+secret.workspaceSlug+'"></head><body><main>Public profile</main></body></html>',{headers:{'content-type':'text/html'}});
    if(path===url){assert.equal(init.method,'GET');return new Response(publicHtml,{headers:{'content-type':'text/html',...pageHeaders}})}
    if(path==='https://opendocs.cc/robots.txt'){assert.equal(init.method,'GET');return new Response(robots,{headers:{'content-type':'text/plain'}})}
    throw Error('unexpected '+path);
  };
  context.batch5Dependencies={fetch,now:()=>new Date(at),renderPage:async(u,t,title,markdown)=>{renders++;assert.equal(u,url);assert.equal(t,target);assert.equal(title,task.draft!.title);assert.equal(markdown,task.draft!.body);return native}};
  return {context,secret,journal,secrets,metadata,owner,raw,created,doc,calls,url,html,creates:()=>creates,renders:()=>renders,intent:()=>intent,receipt:()=>receipt,opaque:()=>opaque,
    block:()=>{blocked=true},setHtml:(v:string)=>{publicHtml=v},setRobots:(v:string)=>{robots=v},setTotal:(v:number)=>{total=v},setHeaders:(v:Record<string,string>)=>{pageHeaders=v},setNative:(v:typeof native)=>{native=v}};
}

test('one guarded authenticated POST with original owner/list/native public acceptance; restart is GET-only',async()=>{
 const f=fixture();const result=await runOpenDocsTask(f.context);assert.equal(result.publicUrl,f.url);assert.equal(f.creates(),1);assert.equal(f.opaque()!.status,201);
 assert.equal((await verifyOpenDocsPublication(f.context)).found,true);assert.equal(f.renders(),1);
 f.context.task.articleReview=undefined;assert.equal((await runOpenDocsTask(f.context)).publicUrl,f.url);assert.equal(f.creates(),1);
});
test('probe is GET-only and binds the actual remote owner and page count',async()=>{
 const f=fixture(),r=await probeOpenDocsConnection(key,f.context.batch5Dependencies);assert.equal(r.userId,f.secret.userId);assert.equal(r.username,f.secret.username);assert.equal(r.remaining,50);assert.equal(f.creates(),0);assert.ok(f.calls.every(x=>x.init.method==='GET'));
 assert.equal(parseOpenDocsCredential(JSON.stringify({...f.secret,apiKey:'bad\nheader'})),undefined);
 await assert.rejects(probeOpenDocsConnection('',f.context.batch5Dependencies));
 await assert.rejects(probeOpenDocsConnection(key,{fetch:async()=>json({id:'../bad',username:'bad'})}));
});
test('review, key fingerprint, local email and free page capacity block before intent reservation',async()=>{
 for(const mode of ['review','key','email','capacity'] as const){const f=fixture();if(mode==='review')f.context.task.articleReview=undefined;if(mode==='key')f.context.getAccount()!.username='foreign-owner-id';if(mode==='email')f.context.getAccount()!.email='other@example.org';if(mode==='capacity')f.setTotal(50);
  assert.equal((await runOpenDocsTask(f.context)).status,'needs_input',mode);assert.equal(f.creates(),0);assert.equal(f.intent(),undefined);
 }
});
test('late authorization, task, draft and secret changes cannot dispatch or replay',async()=>{
 for(const mode of ['permission','task','draft','secret'] as const){const f=fixture(),mark=f.journal.markSending!;f.journal.markSending=async intent=>{await mark(intent);if(mode==='permission')f.block();if(mode==='task')f.context.task.id=randomUUID();if(mode==='draft')f.context.task.draft!.body+=' changed';if(mode==='secret')f.secrets.set(`account:${f.context.task.accountId}`,JSON.stringify({...f.secret,apiKey:'other_key_123456789'}))};
  assert.equal((await runOpenDocsTask(f.context)).reasonCode,'submission_unknown',mode);assert.equal(f.creates(),0);await runOpenDocsTask(f.context);assert.equal(f.creates(),0);
 }
});
test('lost response and rate/rejection outcomes never repeat POST',async()=>{
 for(const status of [0,400,408,429,500]){const f=fixture(),base=f.context.batch5Dependencies!.fetch!;let attempts=0;f.context.batch5Dependencies!.fetch=async(url,init)=>{if(init.method==='POST'){attempts++;if(!status)throw Error('lost');return json({status:'error'},status)}return base(url,init)};
  const result=await runOpenDocsTask(f.context);assert.ok(['failed','review'].includes(result.status));assert.ok(f.intent());await runOpenDocsTask(f.context);assert.equal(attempts,1,String(status));
 }
});
test('original opaque response recovers after receipt write failure without recreate',async()=>{
 const f=fixture(),save=f.journal.saveReceipt;f.journal.saveReceipt=async()=>{throw Error('disk')};assert.equal((await runOpenDocsTask(f.context)).reasonCode,'submission_unknown');assert.ok(f.opaque());f.journal.saveReceipt=save;
 assert.equal((await reconcileOpenDocsTask(f.context)).status,'found');assert.equal(f.creates(),1);
});
test('create receipt rejects foreign URL, wrong path, slug and title without retry',async()=>{
 for(const mode of ['origin','path','slug','title']){const f=fixture();if(mode==='origin')f.created.publicUrl='https://foreign.example.org/'+f.doc.slug;if(mode==='path')f.created.url+='?x=1';if(mode==='slug')f.created.slug+='-2';if(mode==='title')f.created.title='Other';assert.equal((await runOpenDocsTask(f.context)).reasonCode,'submission_unknown');assert.ok(f.opaque());assert.equal(f.receipt(),undefined);await runOpenDocsTask(f.context);assert.equal(f.creates(),1);}
});
test('reconcile binds remote owner/workspace and exact raw version; optional metadata absent remains supported',async()=>{
 for(const mode of ['owner','username','workspace','identifier','slug','title','visibility','published','revision','body','rawversion']){const f=fixture();await runOpenDocsTask(f.context);if(mode==='owner')f.owner.userId='foreign-owner';if(mode==='username')f.owner.onboarding.username='foreign';if(mode==='workspace')f.metadata.workspaceId='ws_foreign';if(mode==='identifier')f.metadata.id='foreign-id';if(mode==='slug')f.metadata.slug='other';if(mode==='title')f.metadata.title='Other';if(mode==='visibility')f.metadata.visibility='private';if(mode==='published')f.metadata.isPublished=false;if(mode==='revision')f.metadata.versionNumber=2;if(mode==='body')f.raw.markdown+='changed';if(mode==='rawversion')f.raw.versionNumber=2;assert.equal((await verifyOpenDocsPublication(f.context)).found,false,mode);assert.equal(f.creates(),1);}
 const f=fixture();await runOpenDocsTask(f.context);for(const k of ['workspaceId','workspaceSlug','url','publicUrl','versionNumber'])delete f.metadata[k];assert.equal((await verifyOpenDocsPublication(f.context)).found,true);
});
test('free plan and quota consistency are automatically read and paid or malformed quotas never reserve',async()=>{
 for(const mode of ['paid','missing','null','limit','negative']){const f=fixture();if(mode==='paid')f.owner.quota.documents.plan='pro';if(mode==='missing')delete f.owner.quota.documents;if(mode==='null')f.owner.quota.documents=null;if(mode==='limit')f.owner.quota.documents.limit=null;if(mode==='negative')f.setTotal(-1);assert.equal((await runOpenDocsTask(f.context)).status,'needs_input');assert.equal(f.creates(),0);assert.equal(f.intent(),undefined);}
});
test('public wrapper, hidden/duplicate target, iframe, noindex, canonical and changed text fail',async()=>{
 for(const mode of ['login','duplicate','iframe','hidden','meta','header','canonical','body'] as const){const f=fixture();await runOpenDocsTask(f.context);
  if(mode==='login')f.setHtml('<h1>Login</h1>');if(mode==='duplicate')f.setHtml(f.html.replace('</article>',`<a href="${target}">duplicate</a></article>`));if(mode==='iframe')f.setHtml(f.html.replace('</body>','<iframe src="/frame"></iframe></body>'));if(mode==='hidden')f.setHtml(f.html.replace('<article class="md-typeset">','<article class="md-typeset" aria-hidden="true">'));
  if(mode==='meta')f.setHtml(f.html.replace('</head>','<meta name="Googlebot" content="none"></head>'));if(mode==='header')f.setHeaders({'x-robots-tag':'bingbot:noindex'});if(mode==='canonical')f.setHtml(f.html.replace('</head>','<link rel="canonical" href="https://opendocs.cc/other"></head>'));if(mode==='body')f.setHtml(f.html.replace('Reproduce','Missing'));
  assert.equal((await verifyOpenDocsPublication(f.context)).found,false,mode);assert.equal(f.creates(),1);
 }
});
test('native renderer and robots must agree; a training-bot block is distinct from search',async()=>{
 const f=fixture();await runOpenDocsTask(f.context);const renderer=f.context.batch5Dependencies!.renderPage;delete f.context.batch5Dependencies!.renderPage;assert.equal((await verifyOpenDocsPublication(f.context)).found,false);f.context.batch5Dependencies!.renderPage=renderer;
 for(const proof of [{found:false,indexable:true,rel:''},{found:true,indexable:false,rel:''},{found:true,indexable:true,rel:'nofollow'}]){f.setNative(proof);assert.equal((await verifyOpenDocsPublication(f.context)).found,false)}f.setNative({found:true,indexable:true,rel:''});
 f.setRobots('User-agent: *\nDisallow: /\n');assert.equal((await verifyOpenDocsPublication(f.context)).found,false);
 f.setRobots('User-agent: *\nAllow: /\nUser-agent: GPTBot\nDisallow: /\n');assert.equal((await verifyOpenDocsPublication(f.context)).found,true);
 assert.equal(opendocsRobotsAllows('User-agent: *\nAllow: /\nUser-agent: Googlebot\nDisallow: /','/guide','googlebot'),false);
});
test('source validation rejects raw HTML, multiple destinations and invalid title before any API request',()=>{
 for(const mode of ['html','extra','title'] as const){const f=fixture();if(mode==='html')f.context.task.draft!.body+='<iframe src="https://evil.example.org"></iframe>';if(mode==='extra')f.context.task.draft!.body+=' [extra](https://software.example.org/other)';if(mode==='title')f.context.task.draft!.title='bad\n# heading';assert.throws(()=>opendocsDocument(f.context),Error,mode);assert.equal(f.calls.length,0)}
});
test('GFM bare example domains are extra links; inline code preserves a non-link example',()=>{
 const f=fixture();f.context.task.draft!.body+=' Example: www.example.com';assert.throws(()=>opendocsDocument(f.context),/HTTPS|single_target/);
 f.context.task.draft!.body=f.context.task.draft!.body.replace('www.example.com','`www.example.com`');assert.ok(opendocsDocument(f.context).content.includes('`www.example.com`'));
});


test('anonymous profile capability failures cannot create an intent or expose the API key',async()=>{
 for(const mode of ['status','canonical','noindex']){const f=fixture(),base=f.context.batch5Dependencies!.fetch!;f.context.batch5Dependencies!.fetch=async(u,i)=>{if(u==='https://opendocs.cc/'+f.secret.workspaceSlug){assert.equal(new Headers(i.headers).has('authorization'),false);return new Response('<html><head><link rel=canonical href="'+(mode==='canonical'?'https://opendocs.cc/other':u)+'">'+(mode==='noindex'?'<meta name=robots content=noindex>':'')+'</head><body><main>Profile</main></body></html>',{status:mode==='status'?404:200,headers:{'content-type':'text/html'}})}return base(u,i)};assert.equal((await runOpenDocsTask(f.context)).status,'needs_input');assert.equal(f.intent(),undefined);assert.equal(f.creates(),0)}
});
