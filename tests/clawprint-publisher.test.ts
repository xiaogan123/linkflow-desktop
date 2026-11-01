import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from 'cheerio';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {Store,defaultSettings} from '../src/main/store';
import {connectPublisherToken} from '../src/main/publisher-token-management';
import {CHANNELS} from '../src/integrations/catalog';
import {publisherFor} from '../src/integrations/publishers';
import {clawprintTesting,probeClawprintToken,runClawprintTask,reconcileClawprintTask,verifyClawprintPublication} from '../src/main/clawprint-publisher';
import {inspectBatch5RenderedBody} from '../src/main/batch5-renderer';
import type {Batch5Intent,Batch5OpaqueResponse,Batch5Persistence,Batch5Receipt} from '../src/integrations/batch5-contract';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const NOW='2026-10-29T10:00:00.000Z';
const TARGET='https://example.com/software-guide';
const BODY=`# A release note worth checking\n\nBefore retrying a failed release step, record the prior response and check the [original software guide](${TARGET}) for maintained steps.\n\nThis explains the tradeoff and avoids duplicate writes.`;
const API='https://clawprint.org';
const SLUG='reviewed-software-note';
const POST_URL=`${API}/p/${SLUG}`;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const receipt=()=>({id:42,slug:SLUG,url:POST_URL});
const readback=()=>({id:42,slug:SLUG,title:'A release note worth checking',content:BODY,tags:['software'],author_name:'fixture-writer'});
const html=()=>`<!doctype html><html><head><title>A release note worth checking</title></head><body><div class="post"><div class="entry"><h1>A release note worth checking</h1><p>Before retrying a failed release step, record the prior response and check the <a href="${TARGET}">original software guide</a> for maintained steps.</p><p>This explains the tradeoff and avoids duplicate writes.</p></div></div></body></html>`;
const renderPage=(source=html())=>async(url:string,target:string,title:string,markdown:string)=>{
  if(/\.entry\s*\{\s*display\s*:\s*none/i.test(source)||/location\.replace\s*\(/i.test(source))return {found:false,indexable:false,rel:''};
  const $=load(source),entry=$('.post .entry');entry.attr('data-batch5-article','');
  return inspectBatch5RenderedBody({url,bodyHtml:$.html(entry),headHtml:$('head').html()??'',robots:[],refresh:false},target,title,markdown);
};

class Journal implements Batch5Persistence {
  intent?:Batch5Intent;receipt?:Batch5Receipt;opaque?:Batch5OpaqueResponse;task?:Task;block=false;
  async saveIntent(value:Batch5Intent){this.intent=value}
  async reserveIntent(value:Batch5Intent){this.intent=value}
  async markSending(value:Batch5Intent){if(this.block||this.intent?.operationId!==value.operationId)throw Error('blocked')}
  async assertReadyToSubmit(value:Batch5Intent){if(this.block||this.intent?.operationId!==value.operationId)throw Error('blocked')}
  async loadIntent(){return this.intent}
  async saveReceipt(value:Batch5Receipt){this.receipt=value}
  async loadReceipt(){return this.receipt}
  async saveOpaqueResponse(value:Batch5OpaqueResponse){this.opaque=value}
  async loadOpaqueResponse(){return this.opaque}
  currentTaskState(){return this.task?.batch5}
}
function fixture(){
  const site:Site={id:'site-1',domain:'example.com',url:'https://example.com/',email:'',name:'Example software',description:'Software documentation',
    category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:NOW};
  const channel:Channel={id:'clawprint',name:'Clawprint',domain:'clawprint.org',url:API,submitUrl:`${API}/api/posts`,
    categories:['software'],languages:['en'],kind:'article',emailRequired:false,accountRequired:true,articleRequired:true,free:'conditional',freeNote:'',
    automation:'api',quality:'C',qualityReason:'',rulesUrl:`${API}/about`,checkedAt:NOW,notes:'',allowedHosts:['clawprint.org'],enabled:true,singleSiteOnly:true};
  const account:Account={id:'account-1',channelId:'clawprint',username:'fixture-writer',email:'',status:'registered',hasPassword:true,
    credentialKind:'api_token',createdAt:NOW,ownerSiteId:site.id};
  const settings={...defaultSettings(),articleReviewMode:'ai' as const};
  const task:Task={id:'task-1',siteId:site.id,channelId:'clawprint',accountId:account.id,sourceDomain:channel.domain,status:'running',
    createdAt:NOW,scheduledAt:NOW,updatedAt:NOW,attempts:1,message:'',topicUrl:TARGET,draftRevision:1,
    draft:{title:'A release note worth checking',description:'A practical release note.',body:BODY}};
  task.articleReview={status:'passed',reason:'passed',draftRevision:1,contentHash:articleContentHash(task),
    contextHash:articleContextHash(site,channel,settings,account,4),evidenceUrls:[],reviewContractVersion:4};
  const journal=new Journal();journal.task=task;
  const secrets=new Map([[`account:${account.id}`,'clawprint-test-token-123456']]);
  const context:ExecutionContext={site,channel,task,settings,signal:new AbortController().signal,ai:{json:async<T>()=>({} as T)},
    secrets:{get:async key=>secrets.get(key),set:async(key,value)=>{secrets.set(key,value)},delete:async key=>{secrets.delete(key)}},
    getAccount:()=>account,saveAccount:async()=>undefined,checkpoint:partial=>{Object.assign(task,partial)},log:()=>undefined,batch5Persistence:journal};
  return {context,journal,task,account};
}
const fetchSuccess=(posts:{count:number},options?:{contentType?:string;robotsHeader?:string;robotsText?:string;html?:string})=>async(url:string,init:RequestInit):Promise<Response>=>{
  if(url===`${API}/api/me`)return json({id:7,name:'fixture-writer'});
  if(url===`${API}/api/posts`&&init.method==='POST'){
    posts.count++;assert.equal(new Headers(init.headers).get('content-type'),'application/json');
    assert.deepEqual(JSON.parse(String(init.body)),{title:'A release note worth checking',content:BODY,tags:['software']});
    return json(receipt());
  }
  if(url===`${API}/api/posts/${SLUG}`)return json(readback());
  if(url===POST_URL)return new Response(options?.html??html(),{status:200,headers:{'content-type':options?.contentType??'text/html',...(options?.robotsHeader?{'x-robots-tag':options.robotsHeader}:{})}});
  if(url===`${API}/robots.txt`)return new Response(options?.robotsText??'User-agent: Amazonbot\nDisallow: /\n\nUser-agent: SemrushBot\nDisallow: /\n',{status:200});
  throw Error(`Unexpected ${init.method} ${url}`);
};

test('Clawprint persists the one-shot intent before POST and verifies exact API, SSR link and robots',async()=>{
  const f=fixture(),posts={count:0};
  f.context.batch5Dependencies={now:()=>new Date(NOW),renderPage:renderPage(),fetch:async(url,init)=>{
    if(url===`${API}/api/posts`&&init.method==='POST')assert.equal(f.task.batch5?.stage,'submitting');
    return fetchSuccess(posts)(url,init);
  }};
  const result=await runClawprintTask(f.context);assert.equal(result.status,'review');assert.equal(posts.count,1);
  assert.equal(f.journal.receipt?.remoteId,'42');
  const verified=await verifyClawprintPublication(f.context);assert.equal(verified.found,true);assert.equal(verified.url,POST_URL);assert.equal(verified.rel,'');
  assert.equal(posts.count,1);
});

test('Clawprint rejects missing current review and wrong-site account before POST',async()=>{
  for(const invalid of ['review','site'] as const){
    const f=fixture(),posts={count:0};f.context.batch5Dependencies={fetch:fetchSuccess(posts)};
    if(invalid==='review')f.task.articleReview=undefined;else f.account.ownerSiteId='another-site';
    assert.equal((await runClawprintTask(f.context)).status,'needs_input');assert.equal(posts.count,0);
  }
});

test('Clawprint lost POST response stays unknown; an identical older article cannot be claimed or reposted',async()=>{
  const f=fixture();let posts=0;
  f.context.batch5Dependencies={fetch:async(url,init)=>{
    if(url===`${API}/api/me`)return json({id:7,name:'fixture-writer'});
    if(url===`${API}/api/posts`&&init.method==='POST'){posts++;throw Error('response lost')}
    if(url.includes('/api/posts?')||url===POST_URL)throw Error('must not scan or claim old posts');
    throw Error(`Unexpected ${url}`);
  }};
  assert.equal((await runClawprintTask(f.context)).reasonCode,'submission_unknown');
  assert.equal((await runClawprintTask(f.context)).reasonCode,'submission_unknown');
  assert.equal((await reconcileClawprintTask(f.context)).status,'unknown');assert.equal(posts,1);assert.equal(f.journal.receipt,undefined);
});

test('Clawprint exact encrypted opaque response recovers by GET after receipt persistence failure',async()=>{
  const f=fixture(),posts={count:0},save=f.journal.saveReceipt.bind(f.journal);
  f.journal.saveReceipt=async()=>{throw Error('journal down')};f.context.batch5Dependencies={fetch:fetchSuccess(posts),renderPage:renderPage()};
  assert.equal((await runClawprintTask(f.context)).reasonCode,'submission_unknown');
  f.journal.saveReceipt=save;
  const found=await reconcileClawprintTask(f.context);assert.equal(found.status,'found');assert.equal(posts.count,1);
  assert.equal(f.journal.receipt?.remoteId,'42');
});

test('Clawprint rejects non-HTML, noindex, disallowed robots and missing native target',async()=>{
  for(const options of [
    {contentType:'text/plain'},{robotsHeader:'googlebot:none'},{robotsHeader:'bingbot:noindex'},
    {robotsText:'User-agent: *\nDisallow: /p/'},
    {robotsText:'User-agent: Googlebot\nDisallow: /p/*'},
    {robotsText:'User-agent: *\n\nDisallow: /'},
    {robotsText:'User-agent: *\nDisallow: /p/\nAllow: /p/*/public'},
    {robotsText:'User-agent: *\nDisallow: /p/\nAllow: /p/reviewed-software-note-other$'},
    {html:html().replace(`href="${TARGET}"`,'href="https://other.example/"')},
    {html:html().replace(`<a href="${TARGET}"`,`<a hidden href="${TARGET}"`)},
    {html:html().replace('</head>','<style>.entry{display:none}</style></head>')},
    {html:html().replace('<p>This explains','<p hidden>This explains')},
    {html:html().replace('</head>','<meta http-equiv="refresh" content="0;url=https://example.net"></head>')},
    {html:html().replace('</head>','<script>location.replace("https://example.net")</script></head>')},
    {html:html().replace('</head>','<link rel="canonical" href="https://clawprint.org/p/other-post"></head>')},
  ]){
    const f=fixture(),posts={count:0};f.context.batch5Dependencies={fetch:fetchSuccess(posts,options),renderPage:renderPage(options.html)};
    assert.equal((await runClawprintTask(f.context)).status,'review');
    assert.equal((await verifyClawprintPublication(f.context)).found,false,JSON.stringify(options));assert.equal(posts.count,1);
  }
});

test('Clawprint cannot accept a public page without credential-free DOM rendering',async()=>{
  const f=fixture(),posts={count:0};f.context.batch5Dependencies={fetch:fetchSuccess(posts)};
  assert.equal((await runClawprintTask(f.context)).status,'review');
  assert.equal((await verifyClawprintPublication(f.context)).found,false);
  assert.equal(posts.count,1);
});

test('Clawprint robots groups, wildcards and end anchors cannot override a broader disallow',()=>{
  const allows=clawprintTesting.robotsAllows;
  assert.equal(allows('User-agent: *\n\nDisallow: /','/p/example'),false);
  assert.equal(allows('User-agent: *\nDisallow: /p/\nAllow: /p/*/public','/p/secret'),false);
  assert.equal(allows('User-agent: *\nDisallow: /p/\nAllow: /p/secret$','/p/secret-other'),false);
  assert.equal(allows('User-agent: *\nDisallow: /p/\nAllow: /p/public$','/p/public'),true);
  assert.equal(allows('User-agent: Amazonbot\nDisallow: /\n\nUser-agent: SemrushBot\nDisallow: /','/p/example'),true);
});

test('Clawprint connection probe requires the owning agent identity',async()=>{
  assert.deepEqual(await probeClawprintToken('clawprint-test-token-123456',{fetch:async()=>json({id:7,name:'fixture-writer'})}),
    {name:'fixture-writer',userId:7});
  await assert.rejects(probeClawprintToken('clawprint-test-token-123456',{fetch:async()=>json({id:7})}),/identity_unverified/);
});

test('Clawprint connects only through a read-only check of an existing token',async()=>{
  const channel=CHANNELS.find(value=>value.id==='clawprint');assert.ok(channel);assert.equal(channel.enabled,true);
  assert.equal(channel.singleSiteOnly,true);assert.equal(channel.accessClass,'connect_once');assert.ok(publisherFor(channel));
  const store=new Store(':memory:');
  try{
    const site=fixture().context.site;store.update(state=>{state.sites=[site]});
    const methods:string[]=[];
    const vault={encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`cipher:${value}`]))};
    const account=await connectPublisherToken(store,vault,{channelId:'clawprint',token:'clawprint-test-token-123456',siteIds:[site.id]},
      {fetch:async(_url,init)=>{methods.push(init.method??'GET');return json({id:7,name:'fixture-writer'})}});
    assert.deepEqual(methods,['GET']);assert.equal(account.ownerSiteId,site.id);assert.equal(account.username,'fixture-writer');
    assert.equal(account.publicationUrl,'https://clawprint.org/u/fixture-writer');
    assert.equal(account.credentialKind,'api_token');
    assert.ok(store.read().accountBindings.some(binding=>binding.accountId===account.id&&binding.siteId===site.id));
  }finally{store.close()}
});
