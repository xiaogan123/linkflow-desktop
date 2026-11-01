import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {marked} from 'marked';
import {articleReviewBindingHash,articleReviewTargetUrl} from '../src/main/article-review';
import {defaultSettings} from '../src/main/store';
import {PUBLISHMARKDOWN_API,PUBLISHMARKDOWN_ORIGIN,publishMarkdownKeyIdentity,publishMarkdownDocument,parsePublishMarkdownCredential,probePublishMarkdownConnection,runPublishMarkdownTask,reconcilePublishMarkdownTask,verifyPublishMarkdownPublication,publishMarkdownRobotsAllows,type PublishMarkdownCredential} from '../src/integrations/publishmarkdown';
import type {Batch5Intent,Batch5Receipt,Batch5OpaqueResponse,Batch5Persistence} from '../src/integrations/batch5-contract';
import type {Account,Channel,Site,Task,ExecutionContext} from '../src/shared/types';
const at='2026-10-30T09:00:00.000Z',target='https://software.example.org/guide',key=`pm_${'a'.repeat(40)}`;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fixture(){
  const site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Software Example',description:'Maintained software guide',email:'owner@example.org',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:at};
  const channel:Channel={id:'publishmarkdown',name:'publishmarkdown',domain:'publishmarkdown.com',url:'https://publishmarkdown.com/',submitUrl:'https://publishmarkdown.com/api/v1/apps',categories:['software'],languages:['*'],kind:'article',free:'conditional',freeNote:'Free only',quality:'C',qualityReason:'',rulesUrl:'https://publishmarkdown.com/terms',notes:'',emailRequired:false,accountRequired:true,articleRequired:true,automation:'api',enabled:true,allowedHosts:['publishmarkdown.com','publishmarkdown.com'],singleSiteOnly:true,checkedAt:at,
    termsCache:{version:1,channelId:'publishmarkdown',checkedAt:at,sourceHash:'a'.repeat(64),finance:'allowed',promotion:'allowed',disclosurePlacement:'required',summary:'Original software documentation permitted.',conclusionHash:'b'.repeat(64),sources:[{url:'https://publishmarkdown.com/terms',kind:'content_policy',text:'Original software documentation permitted.',appliesTo:'publishmarkdown',applicability:'verified'}],reviewVersion:2}};
  const account:Account={id:randomUUID(),channelId:'publishmarkdown',email:'owner@example.org',username:'owner@example.org',ownerSiteId:site.id,createdAt:at,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token'};
  const task:Task={id:randomUUID(),siteId:site.id,channelId:'publishmarkdown',accountId:account.id,sourceDomain:'publishmarkdown.com',status:'running',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'',topicUrl:target,draftRevision:1,
    draft:{title:'Reproducing a software release',description:'An original diagnostic guide.',body:`Written by an AI assistant for Software Example. Reproduce the configuration, compare release notes, and document failures. See the [maintained project guide](${target}). We maintain the linked project.`}};
  const settings={...defaultSettings(),articleReviewMode:'ai' as const};
  task.articleReview={status:'passed',reason:'Independent technical guide',reasonCode:'passed',reviewContractVersion:5,bindingVersion:2,targetUrl:articleReviewTargetUrl(task,site),termsHash:channel.termsCache!.conclusionHash,contextHash:articleReviewBindingHash(task,site,channel),draftRevision:1,contentHash:'c'.repeat(64),evidenceUrls:[site.url],reviewedAt:at};
  const publicationContext={scope:'visible_workspace_only' as const,sameChannelTasks:1,sameAccountTasks:1,distinctSites:1,publicationIntent:'single_original_article' as const,workflowPurpose:'expand_backlink_channels' as const,knownContentPattern:'unknown' as const};


  const secret:PublishMarkdownCredential={version:1,apiKey:key};account.email='';account.username=publishMarkdownKeyIdentity(key);
  const identifier='guide-123456',url=PUBLISHMARKDOWN_ORIGIN+'/'+identifier;
  let intent:Batch5Intent|undefined,receipt:Batch5Receipt|undefined,opaque:Batch5OpaqueResponse|undefined,sending=false,blocked=false;
  const journal:Batch5Persistence={saveIntent:async()=>{throw Error('use reserve')},reserveIntent:async value=>{assert.equal(intent,undefined);intent=value},loadIntent:async()=>intent,
    assertReadyToSubmit:async value=>{assert.equal(value,intent);if(blocked)throw Error('revoked')},markSending:async()=>{assert.equal(sending,false);if(blocked)throw Error('revoked');sending=true},saveReceipt:async value=>{receipt=value},loadReceipt:async()=>receipt,
    saveOpaqueResponse:async value=>{opaque=value},loadOpaqueResponse:async()=>opaque,currentTaskState:()=>task.batch5};
  const secrets=new Map([[`account:${account.id}`,JSON.stringify(secret)]]);
  const context:ExecutionContext={site,task,channel,settings,signal:new AbortController().signal,ai:{json:async<T>()=>({} as T)},getAccount:()=>account,
    getArticlePublicationContext:()=>publicationContext,secrets:{get:async k=>secrets.get(k),set:async(k,v)=>{secrets.set(k,v)},delete:async k=>{secrets.delete(k)}},saveAccount:async()=>{},checkpoint:partial=>{Object.assign(task,partial)},log:()=>{},batch5Persistence:journal};
  const doc=publishMarkdownDocument(context),created={status:'success',message:'markdown created successfully',data:{identifier,url}};
  const metadata:any={status:'success',data:{identifier,content:doc.content,createdAt:at,updatedAt:at,expiredAt:null,is_password_protected:false}};
  const html=`<!doctype html><html><head><title>${task.draft!.title}</title></head><body><article>${marked.parse(doc.content,{async:false})}</article></body></html>`;
  let publicHtml=html,robots='User-agent: *\nAllow: /\nDisallow: /api/\n',total=0,pageHeaders:Record<string,string>={},native={found:true,indexable:true,rel:''};
  const calls:{url:string;init:RequestInit}[]=[];let creates=0,renders=0;
  const fetch=async(path:string,init:RequestInit)=>{
    calls.push({url:path,init});assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
    if(path.startsWith(PUBLISHMARKDOWN_API)){assert.equal(new Headers(init.headers).get('api-key'),key);assert.equal(new Headers(init.headers).get('content-type'),'application/json')}else assert.equal(new Headers(init.headers).has('api-key'),false);
    if(path===PUBLISHMARKDOWN_API+'/markdown?limit=50&offset=0'){assert.equal(init.method,'GET');return json({status:'success',data:{items:[],totalData:total,limit:50,offset:0}})}
    if(path===PUBLISHMARKDOWN_API+'/markdown'&&init.method==='POST'){creates++;assert.equal(sending,true);assert.deepEqual(JSON.parse(String(init.body)),{content:doc.content});return json(created)}
    if(path===PUBLISHMARKDOWN_API+'/markdown/'+identifier){assert.equal(init.method,'GET');return json(metadata)}
    if(path===url){assert.equal(init.method,'GET');return new Response(publicHtml,{headers:{'content-type':'text/html',...pageHeaders}})}
    if(path===PUBLISHMARKDOWN_ORIGIN+'/robots.txt'){assert.equal(init.method,'GET');return new Response(robots,{headers:{'content-type':'text/plain'}})}
    throw Error('unexpected '+path);
  };
  context.batch5Dependencies={fetch,now:()=>new Date(at),renderPage:async(u,t,title,markdown)=>{renders++;assert.equal(u,url);assert.equal(t,target);assert.equal(title,task.draft!.title);assert.equal(markdown,task.draft!.body);return native}};
  return {context,secret,journal,secrets,metadata,created,doc,calls,url,html,creates:()=>creates,renders:()=>renders,intent:()=>intent,receipt:()=>receipt,opaque:()=>opaque,
    block:()=>{blocked=true},setHtml:(v:string)=>{publicHtml=v},setRobots:(v:string)=>{robots=v},setTotal:(v:number)=>{total=v},setHeaders:(v:Record<string,string>)=>{pageHeaders=v},setNative:(v:typeof native)=>{native=v}};
}

test('one guarded account-key POST and exact source/null expiry/native public acceptance; restart is GET-only',async()=>{
 const f=fixture();const result=await runPublishMarkdownTask(f.context);assert.equal(result.publicUrl,f.url);assert.equal(f.creates(),1);assert.equal(f.opaque()!.status,200);
 assert.equal((await verifyPublishMarkdownPublication(f.context)).found,true);assert.equal(f.renders(),1);
 f.context.task.articleReview=undefined;assert.equal((await runPublishMarkdownTask(f.context)).publicUrl,f.url);assert.equal(f.creates(),1);
});
test('probe is read-only, reports local fingerprint and rejects malformed list or credential',async()=>{
 const f=fixture(),r=await probePublishMarkdownConnection(f.secret,f.context.batch5Dependencies);assert.equal(r.authenticated,true);assert.equal(r.identitySource,'local_key_fingerprint');assert.equal(r.totalDocuments,0);assert.equal(f.creates(),0);
 assert.equal(parsePublishMarkdownCredential(JSON.stringify({...f.secret,apiKey:'bad\nheader'})),undefined);
 await assert.rejects(probePublishMarkdownConnection({...f.secret,apiKey:''},f.context.batch5Dependencies),/credential_invalid/);
 for(const data of [{items:[],offset:0,limit:50,totalData:-1},{items:[],offset:1,limit:50,totalData:0},{items:[{identifier:'../../account'}],offset:0,limit:50,totalData:1}]){
  await assert.rejects(probePublishMarkdownConnection(f.secret,{fetch:async()=>json({status:'success',data})}),/unproven/);
 }
});
test('review, key fingerprint, local email and free page capacity block before intent reservation',async()=>{
 for(const mode of ['review','key','email','capacity'] as const){const f=fixture();if(mode==='review')f.context.task.articleReview=undefined;if(mode==='key')f.context.getAccount()!.username=publishMarkdownKeyIdentity('other_key_123456789');if(mode==='email')f.context.getAccount()!.email='other@example.org';if(mode==='capacity')f.setTotal(100);
  assert.equal((await runPublishMarkdownTask(f.context)).status,'needs_input',mode);assert.equal(f.creates(),0);assert.equal(f.intent(),undefined);
 }
});
test('late authorization, task, draft and secret changes cannot dispatch or replay',async()=>{
 for(const mode of ['permission','task','draft','secret'] as const){const f=fixture(),mark=f.journal.markSending!;f.journal.markSending=async intent=>{await mark(intent);if(mode==='permission')f.block();if(mode==='task')f.context.task.id=randomUUID();if(mode==='draft')f.context.task.draft!.body+=' changed';if(mode==='secret')f.secrets.set(`account:${f.context.task.accountId}`,JSON.stringify({...f.secret,apiKey:'other_key_123456789'}))};
  assert.equal((await runPublishMarkdownTask(f.context)).reasonCode,'submission_unknown',mode);assert.equal(f.creates(),0);await runPublishMarkdownTask(f.context);assert.equal(f.creates(),0);
 }
});
test('lost response and rate/rejection outcomes never repeat POST',async()=>{
 for(const status of [0,400,408,429,500]){const f=fixture(),base=f.context.batch5Dependencies!.fetch!;let attempts=0;f.context.batch5Dependencies!.fetch=async(url,init)=>{if(init.method==='POST'){attempts++;if(!status)throw Error('lost');return json({status:'error'},status)}return base(url,init)};
  const result=await runPublishMarkdownTask(f.context);assert.ok(['failed','review'].includes(result.status));assert.ok(f.intent());await runPublishMarkdownTask(f.context);assert.equal(attempts,1,String(status));
 }
});
test('original opaque response recovers after receipt write failure without recreate',async()=>{
 const f=fixture(),save=f.journal.saveReceipt;f.journal.saveReceipt=async()=>{throw Error('disk')};assert.equal((await runPublishMarkdownTask(f.context)).reasonCode,'submission_unknown');assert.ok(f.opaque());f.journal.saveReceipt=save;
 assert.equal((await reconcilePublishMarkdownTask(f.context)).status,'found');assert.equal(f.creates(),1);
});
test('malformed create URLs or identifiers retain opaque evidence and never become accepted',async()=>{
 for(const mode of ['origin','path','identifier','status'] as const){const f=fixture();if(mode==='origin')f.created.data.url='https://publishmarkdown.com.evil.example/doc';if(mode==='path')f.created.data.url=f.url+'?token=secret';if(mode==='identifier')f.created.data.identifier='../account';if(mode==='status')f.created.status='error';
  assert.equal((await runPublishMarkdownTask(f.context)).reasonCode,'submission_unknown',mode);assert.equal(f.receipt(),undefined);assert.ok(f.opaque());await runPublishMarkdownTask(f.context);assert.equal(f.creates(),1);
 }
});
test('GET source must prove exact content, identifier, explicit null expiredAt and unprotected page',async()=>{
 for(const mode of ['content','identifier','expiry','missing-expiry','wrong-alias','password','created','updated'] as const){const f=fixture();await runPublishMarkdownTask(f.context);
  if(mode==='content')f.metadata.data.content+=' changed';if(mode==='identifier')f.metadata.data.identifier='different';if(mode==='expiry')f.metadata.data.expiredAt='2027-01-01T00:00:00Z';if(mode==='missing-expiry')delete f.metadata.data.expiredAt;
  if(mode==='wrong-alias'){delete f.metadata.data.expiredAt;f.metadata.data.expiresAt=null}if(mode==='password')f.metadata.data.is_password_protected=true;if(mode==='created')f.metadata.data.createdAt='2020-01-01T00:00:00Z';if(mode==='updated')f.metadata.data.updatedAt='invalid';
  assert.equal((await verifyPublishMarkdownPublication(f.context)).found,false,mode);assert.equal(f.renders(),0);assert.equal(f.creates(),1);
 }
});
test('public wrapper, hidden/duplicate target, iframe, noindex, canonical and changed text fail',async()=>{
 for(const mode of ['login','duplicate','iframe','hidden','meta','header','canonical','body'] as const){const f=fixture();await runPublishMarkdownTask(f.context);
  if(mode==='login')f.setHtml('<h1>Login</h1>');if(mode==='duplicate')f.setHtml(f.html.replace('</body>',`<a href="${target}">duplicate</a></body>`));if(mode==='iframe')f.setHtml(f.html.replace('</body>','<iframe src="/frame"></iframe></body>'));if(mode==='hidden')f.setHtml(f.html.replace('<article>','<article aria-hidden="true">'));
  if(mode==='meta')f.setHtml(f.html.replace('</head>','<meta name="Googlebot" content="none"></head>'));if(mode==='header')f.setHeaders({'x-robots-tag':'bingbot:noindex'});if(mode==='canonical')f.setHtml(f.html.replace('</head>','<link rel="canonical" href="https://publishmarkdown.com/other"></head>'));if(mode==='body')f.setHtml(f.html.replace('Reproduce','Missing'));
  assert.equal((await verifyPublishMarkdownPublication(f.context)).found,false,mode);assert.equal(f.creates(),1);
 }
});
test('native renderer and robots must agree; a training-bot block is distinct from search',async()=>{
 const f=fixture();await runPublishMarkdownTask(f.context);const renderer=f.context.batch5Dependencies!.renderPage;delete f.context.batch5Dependencies!.renderPage;assert.equal((await verifyPublishMarkdownPublication(f.context)).found,false);f.context.batch5Dependencies!.renderPage=renderer;
 for(const proof of [{found:false,indexable:true,rel:''},{found:true,indexable:false,rel:''},{found:true,indexable:true,rel:'nofollow'}]){f.setNative(proof);assert.equal((await verifyPublishMarkdownPublication(f.context)).found,false)}f.setNative({found:true,indexable:true,rel:''});
 f.setRobots('User-agent: *\nDisallow: /\n');assert.equal((await verifyPublishMarkdownPublication(f.context)).found,false);
 f.setRobots('User-agent: *\nAllow: /\nUser-agent: GPTBot\nDisallow: /\n');assert.equal((await verifyPublishMarkdownPublication(f.context)).found,true);
 assert.equal(publishMarkdownRobotsAllows('User-agent: *\nAllow: /\nUser-agent: Googlebot\nDisallow: /','/guide','googlebot'),false);
});
test('source validation rejects raw HTML, multiple destinations and invalid title before any API request',()=>{
 for(const mode of ['html','extra','title'] as const){const f=fixture();if(mode==='html')f.context.task.draft!.body+='<iframe src="https://evil.example.org"></iframe>';if(mode==='extra')f.context.task.draft!.body+=' [extra](https://software.example.org/other)';if(mode==='title')f.context.task.draft!.title='bad\n# heading';assert.throws(()=>publishMarkdownDocument(f.context),Error,mode);assert.equal(f.calls.length,0)}
});
test('GFM bare example domains are extra links; inline code preserves a non-link example',()=>{
 const f=fixture();f.context.task.draft!.body+=' Example: www.example.com';assert.throws(()=>publishMarkdownDocument(f.context),/HTTPS|single_target/);
 f.context.task.draft!.body=f.context.task.draft!.body.replace('www.example.com','`www.example.com`');assert.ok(publishMarkdownDocument(f.context).content.includes('`www.example.com`'));
});

