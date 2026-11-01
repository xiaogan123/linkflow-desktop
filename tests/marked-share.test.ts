import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {articleReviewBindingHash,articleReviewTargetUrl} from '../src/main/article-review';
import {defaultSettings} from '../src/main/store';
import {marked} from 'marked';
import {MARKED_SHARE_API,markedShareAccountUsername,markedShareDocument,markedShareNativeUrl,parseMarkedShareCredential,probeMarkedShareConnection,runMarkedShareTask,reconcileMarkedShareTask,verifyMarkedSharePublication,markedShareRobotsAllows,type MarkedShareCredential} from '../src/integrations/marked-share';
import type {Batch5Intent,Batch5Receipt,Batch5OpaqueResponse,Batch5Persistence} from '../src/integrations/batch5-contract';
import type {Account,Channel,Site,Task,ExecutionContext} from '../src/shared/types';
const at='2026-10-30T09:00:00.000Z',target='https://software.example.org/guide',key=`ms_${'a'.repeat(40)}`;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fixture(){
  const site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Software Example',description:'Maintained software guide',email:'owner@example.org',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:at};
  const channel:Channel={id:'marked-share',name:'marked-share',domain:'marked-share.app',url:'https://marked-share.ai/',submitUrl:'https://marked-share.ai/api/v1/apps',categories:['software'],languages:['*'],kind:'article',free:'conditional',freeNote:'Free only',quality:'C',qualityReason:'',rulesUrl:'https://marked-share.ai/terms',notes:'',emailRequired:false,accountRequired:true,articleRequired:true,automation:'api',enabled:true,allowedHosts:['marked-share.ai','marked-share.app'],singleSiteOnly:true,checkedAt:at,
    termsCache:{version:1,channelId:'marked-share',checkedAt:at,sourceHash:'a'.repeat(64),finance:'allowed',promotion:'allowed',disclosurePlacement:'required',summary:'Original software documentation permitted.',conclusionHash:'b'.repeat(64),sources:[{url:'https://marked-share.ai/terms',kind:'content_policy',text:'Original software documentation permitted.',appliesTo:'marked-share',applicability:'verified'}],reviewVersion:2}};
  const account:Account={id:randomUUID(),channelId:'marked-share',email:'owner@example.org',username:'owner@example.org',ownerSiteId:site.id,createdAt:at,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token'};
  const task:Task={id:randomUUID(),siteId:site.id,channelId:'marked-share',accountId:account.id,sourceDomain:'marked-share.app',status:'running',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'',topicUrl:target,draftRevision:1,
    draft:{title:'Reproducing a software release',description:'An original diagnostic guide.',body:`Written by an AI assistant for Software Example. Reproduce the configuration, compare release notes, and document failures. See the [maintained project guide](${target}). We maintain the linked project.`}};
  const settings={...defaultSettings(),articleReviewMode:'ai' as const};
  task.articleReview={status:'passed',reason:'Independent technical guide',reasonCode:'passed',reviewContractVersion:5,bindingVersion:2,targetUrl:articleReviewTargetUrl(task,site),termsHash:channel.termsCache!.conclusionHash,contextHash:articleReviewBindingHash(task,site,channel),draftRevision:1,contentHash:'c'.repeat(64),evidenceUrls:[site.url],reviewedAt:at};
  const publicationContext={scope:'visible_workspace_only' as const,sameChannelTasks:1,sameAccountTasks:1,distinctSites:1,publicationIntent:'single_original_article' as const,workflowPurpose:'expand_backlink_channels' as const,knownContentPattern:'unknown' as const};


  const secret:MarkedShareCredential={version:1,apiToken:key,deviceKey:'device_key_fixture_123456789',email:account.email};account.username=markedShareAccountUsername(secret);
  const url='https://markedb.in/a1b2c3',id='doc_12345678',privateId='12345678-1234-4234-8234-123456789012',contentHash='d'.repeat(64);
  const metadata={id,private_id:privateId,url,content_hash:contentHash,visibility:'public',expires_at:null,link_password_enabled:false,allow_remix:false,created_at:at,updated_at:at,title:task.draft!.title,body_markdown:task.draft!.body,body_html:marked.parse(task.draft!.body,{async:false})};
  let intent:Batch5Intent|undefined,receipt:Batch5Receipt|undefined,opaque:Batch5OpaqueResponse|undefined,sending=false,blocked=false;
  const journal:Batch5Persistence={saveIntent:async()=>{throw Error('use reserve')},reserveIntent:async value=>{assert.equal(intent,undefined);intent=value},loadIntent:async()=>intent,
    assertReadyToSubmit:async value=>{assert.equal(value,intent);if(blocked)throw Error('revoked')},markSending:async()=>{assert.equal(sending,false);if(blocked)throw Error('revoked');sending=true},saveReceipt:async value=>{receipt=value},loadReceipt:async()=>receipt,
    saveOpaqueResponse:async value=>{opaque=value},loadOpaqueResponse:async()=>opaque,currentTaskState:()=>task.batch5};
  const secrets=new Map([[`account:${account.id}`,JSON.stringify(secret)]]);
  const context:ExecutionContext={site,task,channel,settings,signal:new AbortController().signal,ai:{json:async<T>()=>({} as T)},getAccount:()=>account,
    getArticlePublicationContext:()=>publicationContext,secrets:{get:async k=>secrets.get(k),set:async(k,v)=>{secrets.set(k,v)},delete:async k=>{secrets.delete(k)}},saveAccount:async()=>{},checkpoint:partial=>{Object.assign(task,partial)},log:()=>{},batch5Persistence:journal};
  const html=`<!doctype html><html><head><title>${task.draft!.title}</title></head><body><article><h1>${task.draft!.title}</h1>${metadata.body_html}</article></body></html>`;
  let publicHtml=html,robots='User-agent: *\nAllow: /\nUser-agent: GPTBot\nDisallow: /\n',list:unknown[]=[],pageHeaders:Record<string,string>={},native={found:true,indexable:true,rel:''};
  const calls:{url:string;init:RequestInit}[]=[];let creates=0,renders=0;
  const fetch=async(path:string,init:RequestInit)=>{
    calls.push({url:path,init});assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
    if(path.startsWith(MARKED_SHARE_API)){assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${key}`)}else{assert.equal(new Headers(init.headers).has('authorization'),false);assert.equal(new Headers(init.headers).has('X-Device-Key'),false)}
    if(path===MARKED_SHARE_API+'/documents?limit=25&page=1'){assert.equal(init.method,'GET');assert.equal(new Headers(init.headers).has('X-Device-Key'),false);return json(list)}
    if(path===MARKED_SHARE_API+'/documents'&&init.method==='POST'){creates++;assert.equal(sending,true);assert.equal(new Headers(init.headers).get('X-Device-Key'),secret.deviceKey);assert.deepEqual(JSON.parse(String(init.body)),{document:{title:task.draft!.title,body_markdown:task.draft!.body,visibility:'public',allow_remix:false}});return json(metadata,201)}
    if(path===MARKED_SHARE_API+'/documents/'+privateId){assert.equal(init.method,'GET');return json(metadata)}
    if(path===markedShareNativeUrl(url)){assert.equal(init.method,'GET');return new Response(publicHtml,{headers:{'content-type':'text/html',...pageHeaders}})}
    if(path==='https://markedb.in/robots.txt'||path==='https://share.markedapp.com/robots.txt'){assert.equal(init.method,'GET');return new Response(robots,{headers:{'content-type':'text/plain'}})}
    throw Error('unexpected '+path);
  };
  context.batch5Dependencies={fetch,now:()=>new Date(at),renderPage:async(u,t,title,markdown)=>{renders++;assert.equal(u,markedShareNativeUrl(url));assert.equal(t,target);assert.equal(title,task.draft!.title);assert.equal(markdown,task.draft!.body);return native}};
  return {context,secret,journal,secrets,metadata,calls,url,id,privateId,html,creates:()=>creates,renders:()=>renders,intent:()=>intent,receipt:()=>receipt,opaque:()=>opaque,
    block:()=>{blocked=true},setHtml:(v:string)=>{publicHtml=v},setRobots:(v:string)=>{robots=v},setList:(v:unknown[])=>{list=v},setHeaders:(v:Record<string,string>)=>{pageHeaders=v},setNative:(v:typeof native)=>{native=v}};
}

test('one guarded create keeps private ID encrypted and accepts only authenticated source plus anonymous native proof',async()=>{
 const f=fixture();const result=await runMarkedShareTask(f.context);assert.equal(result.publicUrl,f.url);assert.equal(f.creates(),1);assert.equal(f.receipt()!.remoteId,f.id);
 assert.equal(JSON.stringify(f.context.task).includes(f.privateId),false);assert.ok(f.receipt()!.rawResponse.includes(f.privateId));assert.equal(f.opaque()!.status,201);
 assert.equal((await verifyMarkedSharePublication(f.context)).found,true);assert.equal(f.renders(),1);
 f.context.task.articleReview=undefined;assert.equal((await runMarkedShareTask(f.context)).publicUrl,f.url);assert.equal(f.creates(),1);
});

test('read-only probe reports a local credential identity, not a remote email assertion',async()=>{
 const f=fixture(),r=await probeMarkedShareConnection(f.secret,f.context.batch5Dependencies);assert.equal(r.authenticated,true);assert.equal(r.identitySource,'local_credential');assert.equal(r.username,markedShareAccountUsername(f.secret));assert.equal(r.visibleDocuments,0);assert.equal(f.creates(),0);
 for(const s of [{...f.secret,apiToken:'bad\nheader'}, {...f.secret,deviceKey:''},{...f.secret,email:'invalid'}]){assert.equal(parseMarkedShareCredential(JSON.stringify(s)),undefined);await assert.rejects(probeMarkedShareConnection(s,f.context.batch5Dependencies),/credential_invalid/)}
});

test('review, local token fingerprint, credential email and free cap prevent mutation',async()=>{
 for(const mode of ['review','fingerprint','email','capacity'] as const){const f=fixture();
  if(mode==='review')f.context.task.articleReview=undefined;
  if(mode==='fingerprint')f.context.getAccount()!.username='not-the-token';
  if(mode==='email')f.secrets.set(`account:${f.context.task.accountId}`,JSON.stringify({...f.secret,email:'other@example.org'}));
  if(mode==='capacity')f.setList(Array.from({length:25},(_,i)=>({id:'doc'+i,content_hash:'a'.repeat(64)})));
  assert.equal((await runMarkedShareTask(f.context)).status,'needs_input',mode);assert.equal(f.creates(),0);assert.equal(f.intent(),undefined);
 }
});

test('authorization revoked after markSending blocks the sole POST and cannot replay',async()=>{
 const f=fixture(),base=f.journal.markSending!;f.journal.markSending=async intent=>{await base(intent);f.block()};
 assert.equal((await runMarkedShareTask(f.context)).reasonCode,'submission_unknown');assert.equal(f.creates(),0);await runMarkedShareTask(f.context);assert.equal(f.creates(),0);
});

test('late account/task binding and draft changes after arming stop the sole write',async()=>{
 for(const mode of ['task','draft','token'] as const){const f=fixture(),base=f.journal.markSending!;
  f.journal.markSending=async intent=>{await base(intent);if(mode==='task')f.context.task.id=randomUUID();if(mode==='draft')f.context.task.draft!.body+=' changed';if(mode==='token')f.secrets.set(`account:${f.context.task.accountId}`,JSON.stringify({...f.secret,apiToken:'different_token_123456789'}));};
  assert.equal((await runMarkedShareTask(f.context)).reasonCode,'submission_unknown',mode);assert.equal(f.creates(),0,mode);
 }
});

test('a lost create response keeps sending state and never sends again',async()=>{
 const f=fixture(),base=f.context.batch5Dependencies!.fetch!;let attempts=0;
 f.context.batch5Dependencies!.fetch=async(url,init)=>{if(init.method==='POST'){attempts++;throw Error('response lost')}return base(url,init)};
 assert.equal((await runMarkedShareTask(f.context)).reasonCode,'submission_unknown');assert.ok(f.context.task.submittedAt);await runMarkedShareTask(f.context);assert.equal(attempts,1);
});

test('opaque original 201 can recover after receipt storage failed without another create',async()=>{
 const f=fixture(),save=f.journal.saveReceipt;f.journal.saveReceipt=async()=>{throw Error('write failure')};
 assert.equal((await runMarkedShareTask(f.context)).reasonCode,'submission_unknown');assert.ok(f.opaque());assert.equal(f.creates(),1);f.journal.saveReceipt=save;
 assert.equal((await reconcileMarkedShareTask(f.context)).status,'found');assert.equal(f.creates(),1);
});

test('private, protected, expiring, remixable and malicious URL receipts remain opaque',async()=>{
 for(const field of ['visibility','link_password_enabled','expires_at','allow_remix','url','private_id','content_hash'] as const){const f=fixture();
  const v:any={visibility:'private',link_password_enabled:true,expires_at:'2027-01-01T00:00:00Z',allow_remix:true,url:'https://markedb.in.evil.example/a1b2c3',private_id:'../../account',content_hash:'bad'};
  (f.metadata as any)[field]=v[field];assert.equal((await runMarkedShareTask(f.context)).reasonCode,'submission_unknown',field);assert.equal(f.receipt(),undefined);assert.ok(f.opaque());await runMarkedShareTask(f.context);assert.equal(f.creates(),1);
 }
});

test('authenticated readback must match exact Markdown, title, immutable IDs, content hash and original creation date',async()=>{
 for(const field of ['body_markdown','title','private_id','id','content_hash','created_at'] as const){const f=fixture();await runMarkedShareTask(f.context);
  (f.metadata as any)[field]=field==='private_id'?randomUUID():field==='content_hash'?'f'.repeat(64):field==='created_at'?'2020-01-01T00:00:00Z':'changed';
  assert.equal((await verifyMarkedSharePublication(f.context)).found,false,field);assert.equal(f.renders(),0);assert.equal(f.creates(),1);
 }
});

test('anonymous page cannot be a login wrapper, duplicate target, iframe, hidden content or noindex',async()=>{
 for(const mode of ['login','duplicate','iframe','hidden','meta','header','canonical','body'] as const){const f=fixture();await runMarkedShareTask(f.context);
  if(mode==='login')f.setHtml('<h1>Sign in</h1>');
  if(mode==='duplicate')f.setHtml(f.html.replace('</body>',`<a href="${target}">extra</a></body>`));
  if(mode==='iframe')f.setHtml(f.html.replace('</body>','<iframe src="/elsewhere"></iframe></body>'));
  if(mode==='hidden')f.setHtml(f.html.replace('<article>','<article hidden>'));
  if(mode==='meta')f.setHtml(f.html.replace('</head>','<meta name="Bingbot" content="none"></head>'));
  if(mode==='header')f.setHeaders({'x-robots-tag':'googlebot:noindex'});
  if(mode==='canonical')f.setHtml(f.html.replace('</head>','<link rel="canonical" href="https://markedb.in/another"></head>'));
  if(mode==='body')f.setHtml(f.html.replace('Reproduce','Omitted'));
  assert.equal((await verifyMarkedSharePublication(f.context)).found,false,mode);assert.equal(f.creates(),1);
 }
});

test('native visibility is mandatory and must agree on target rel',async()=>{
 const f=fixture();await runMarkedShareTask(f.context);const native=f.context.batch5Dependencies!.renderPage;delete f.context.batch5Dependencies!.renderPage;assert.equal((await verifyMarkedSharePublication(f.context)).found,false);
 f.context.batch5Dependencies!.renderPage=native;f.setNative({found:false,indexable:true,rel:''});assert.equal((await verifyMarkedSharePublication(f.context)).found,false);
 f.setNative({found:true,indexable:false,rel:''});assert.equal((await verifyMarkedSharePublication(f.context)).found,false);
 f.setNative({found:true,indexable:true,rel:'nofollow'});assert.equal((await verifyMarkedSharePublication(f.context)).found,false);
 f.setHtml(f.html.replace('<a href=','<a rel="nofollow" href='));const result=await verifyMarkedSharePublication(f.context);assert.equal(result.found,true);assert.equal(result.rel,'nofollow');
});

test('robots groups allow search despite training bans and reject applicable path rules',async()=>{
 const text='User-agent: *\nAllow: /\nUser-agent: GPTBot\nDisallow: /\n';
 for(const agent of ['*','googlebot','bingbot'])assert.equal(markedShareRobotsAllows(text,'/a1b2c3',agent),true);
 assert.equal(markedShareRobotsAllows(text,'/a1b2c3','GPTBot'),false);
 const f=fixture();await runMarkedShareTask(f.context);
 for(const robots of ['User-agent: *\nDisallow: /\n','User-agent: Bingbot\nDisallow: /a*\nUser-agent: *\nAllow: /\n']){f.setRobots(robots);assert.equal((await verifyMarkedSharePublication(f.context)).found,false)}
 assert.equal(markedShareRobotsAllows('User-agent: *\nDisallow: /a\nAllow: /abc$\n','/abc','googlebot'),true);
 assert.equal(markedShareRobotsAllows('User-agent: *\nDisallow: /a\nAllow: /abc$\n','/abcd','googlebot'),false);
});


test('observed 201 omits allow_remix while request stays false and explicit conflicting values are rejected',async()=>{
 const f=fixture();delete (f.metadata as Record<string,unknown>).allow_remix;
 const create=await runMarkedShareTask(f.context);assert.equal(create.publicUrl,f.url);assert.equal(f.creates(),1);
 f.metadata.allow_remix=false;assert.equal((await reconcileMarkedShareTask(f.context)).status,'found');await runMarkedShareTask(f.context);assert.equal(f.creates(),1);
 for(const value of [true,null,'false',0]){const invalid=fixture();(invalid.metadata as Record<string,unknown>).allow_remix=value;assert.equal((await runMarkedShareTask(invalid.context)).reasonCode,'submission_unknown');await runMarkedShareTask(invalid.context);assert.equal(invalid.creates(),1)}
});


test('authenticated detail must explicitly confirm allow_remix false even when original 201 omitted it',async()=>{
 for(const value of [undefined,null,true,'false',0]){const f=fixture();delete (f.metadata as Record<string,unknown>).allow_remix;assert.equal((await runMarkedShareTask(f.context)).publicUrl,f.url);if(value===undefined)delete (f.metadata as Record<string,unknown>).allow_remix;else (f.metadata as Record<string,unknown>).allow_remix=value;assert.equal((await reconcileMarkedShareTask(f.context)).status,'unknown');assert.equal(f.renders(),0);assert.equal(f.creates(),1)}
});


test('native alias keeps original public code and rejects decorated or private routes',()=>{
 assert.equal(markedShareNativeUrl('https://markedb.in/a1b2c3'),'https://share.markedapp.com/a1b2c3');
 for(const value of ['https://markedb.in/a1b2c3?x=1','https://markedb.in/a1b2c3#x','https://markedb.in/session/bridge','https://markedb.in.evil.example/a1b2c3','https://share.markedapp.com/a1b2c3','http://markedb.in/a1b2c3'])assert.equal(markedShareNativeUrl(value),undefined);
});

test('native official alias requires its own robots policy in addition to the original short host',async()=>{
 for(const response of [new Response('User-agent: *\nDisallow: /\n',{headers:{'content-type':'text/plain'}}),new Response('User-agent: Bingbot\nDisallow: /a1b2c3\n',{headers:{'content-type':'text/plain'}}),new Response('',{status:302,headers:{location:'https://share.markedapp.com/session/bridge'}}),new Response('unavailable',{status:503})]){
  const f=fixture();await runMarkedShareTask(f.context);const fetch=f.context.batch5Dependencies!.fetch!;f.context.batch5Dependencies!.fetch=async(url,init)=>url==='https://share.markedapp.com/robots.txt'?response:fetch(url,init);
  assert.equal((await reconcileMarkedShareTask(f.context)).status,'unknown');assert.equal(f.renders(),0);assert.equal(f.creates(),1);
 }
});

test('static HTML and native proof use only the same-code official alias while receipt remains short',async()=>{
 const f=fixture();await runMarkedShareTask(f.context);assert.equal((await reconcileMarkedShareTask(f.context)).status,'found');
 const alias=markedShareNativeUrl(f.url)!,page=f.calls.filter(call=>call.url===alias);assert.equal(page.length,1);
 assert.equal(new Headers(page[0].init.headers).get('accept'),'text/html');assert.equal(page[0].init.redirect,'error');assert.equal(page[0].init.credentials,'omit');
 assert.equal(f.calls.some(call=>call.url===f.url||call.url.includes('/session/bridge')),false);assert.equal(f.receipt()!.publicUrl,f.url);assert.equal(f.context.task.publicUrl,f.url);
 const fetch=f.context.batch5Dependencies!.fetch!;f.context.batch5Dependencies!.fetch=async(url,init)=>url===alias?new Response('',{status:302,headers:{location:'https://share.markedapp.com/session/bridge?return_to=%2Fa1b2c3'}}):fetch(url,init);
 assert.equal((await reconcileMarkedShareTask(f.context)).status,'unknown');assert.equal(f.creates(),1);
});
