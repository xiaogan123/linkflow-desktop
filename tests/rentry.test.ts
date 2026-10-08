import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {marked} from 'marked';
import {prepareRentryIdentity,reconcileRentryTask,runRentryTask,verifyRentryPublication,rentryTesting,type RentryTransport} from '../src/integrations/rentry';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const NOW='2026-10-08T07:00:00.000Z';
const TARGET='https://example.com/research';
const TITLE='Keeping a useful source record';
const BODY=`A useful reading record separates an observation from an interpretation. Write down the page title, the exact source address and the date you consulted it. Keep the original units next to every number so a later comparison does not silently change its meaning. The [research notes](${TARGET}) are a related reference rather than independent validation of these steps.

Before drawing a conclusion, compare the source passage with the summary and mark anything still uncertain. This article is AI-assisted promotional writing for the linked site, not an independent third-party recommendation. The site participates in a referral program and may receive commissions; that relationship does not prove any financial claim or guarantee an outcome.`;
const KEY=Buffer.alloc(32,0x52);
const SITE:Site={id:'site',domain:'example.com',url:'https://example.com/',email:'writer@example.com',
  name:'Example Notes',description:'Learning notes',category:'education',language:'en',monthlyTarget:2,
  status:'ready',createdAt:NOW};
const CHANNEL:Channel={id:'rentry',name:'Rentry',domain:'rentry.co',url:'https://rentry.co/',
  submitUrl:'https://rentry.co/api/new',categories:['education'],languages:['*'],kind:'article',
  emailRequired:false,accountRequired:true,articleRequired:true,free:'yes',freeNote:'Free',
  automation:'api',quality:'C',qualityReason:'fixture',rulesUrl:'https://rentry.co/what',
  checkedAt:'2026-10-08',notes:'Fixture',allowedHosts:['rentry.co'],enabled:true};

function fixture(empty=false){
  const task:Task={id:'task-rentry-1234',siteId:SITE.id,channelId:'rentry',sourceDomain:'rentry.co',
    status:'running',createdAt:NOW,updatedAt:NOW,scheduledAt:NOW,attempts:1,message:'',
    topicUrl:TARGET,draft:{title:TITLE,description:'Source-tracking methods',body:BODY},
    articleApprovedAt:NOW,accountId:empty?undefined:'account'};
  let account:Account|undefined=empty?undefined:{id:'account',channelId:'rentry',email:'',
    username:'anonymous',displayName:'本机匿名发布身份',credentialKind:'api_token',
    status:'registered',hasPassword:true,source:'generated',createdAt:NOW};
  const secrets=new Map<string,string>();
  if(account)secrets.set('account:account',JSON.stringify({version:1,key:KEY.toString('base64url')}));
  const signal=new AbortController(),checkpoints:Partial<Task>[]=[];
  let rejectAccount=false,rejectCheckpoint=false;
  const context:ExecutionContext={site:SITE,task,channel:CHANNEL,settings:{
    provider:'codex',codexPath:'codex',model:'fixture',articleReviewMode:'ai',apiBase:'',
    hasApiKey:false,autoRun:true,launchAtLogin:false,notify:false,timezone:'UTC',
    maxAttempts:3,maxSteps:3,dailyAiLimit:20,channelOverrides:{},mail:{host:'',port:0,user:'',secure:false,hasPassword:false}
  },signal:signal.signal,ai:{json:async<T>()=>({} as T)},
  secrets:{get:async key=>secrets.get(key),set:async(key,value)=>{secrets.set(key,value)},
    delete:async key=>{secrets.delete(key)}},
  getAccount:()=>account,
  saveAccount:async(value,secret)=>{
    if(rejectAccount)throw Error('vault unavailable');
    account=structuredClone(value);task.accountId=value.id;
    if(secret)secrets.set(`account:${value.id}`,secret);
  },
  checkpoint:partial=>{
    if(rejectCheckpoint)throw Error('store unavailable');
    checkpoints.push(structuredClone(partial));Object.assign(task,partial);
  },log:()=>{}};
  return {context,task,signal,secrets,checkpoints,account:()=>account,
    rejectAccount:()=>{rejectAccount=true},rejectCheckpoint:()=>{rejectCheckpoint=true}};
}
function publicHtml(source:string,url:string,head='',rewrite?:(rendered:string)=>string){
  let body=String(marked.parse(source,{async:false,gfm:true}))
    .replace(/<h([1-6])>([^<]*)<\/h\1>/g,(_all,level,text)=>
      `<h${level}>${text}<a class="headerlink" href="#heading" title="Permanent link"> </a></h${level}>`)
    .replaceAll('<a href=','<a rel="nofollow ugc" href=');
  if(rewrite)body=rewrite(body);
  return `<!doctype html><html><head><link rel="canonical" href="${url}">${head}</head>
    <body><div class="entry-text"><article><div>${body}</div></article></div>
    <footer><p>Rentry footer: ${source}</p></footer></body></html>`;
}
function server(f:ReturnType<typeof fixture>,options:{
  lostResponse?:boolean;absentOnce?:boolean;badPage?:string;apiStatus?:string;
  noindex?:boolean;redirect?:boolean;challenge?:boolean
}={}){
  const calls:{url:string;init:RequestInit}[]=[];
  let published=false,readCount=0;
  const fetch:RentryTransport=async(url,init)=>{
    calls.push({url,init});
    const expected=rentryTesting.article(f.task,TARGET,false),page=rentryTesting.pageUrl(expected.slug);
    assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');
    if(url==='https://rentry.co/api/new'){
      assert.equal(init.method,'POST');
      assert.equal(f.task.checkpoint,'rentry_publish_submitting');
      assert.equal(f.task.rentry?.stage,'submitting');
      assert.ok(f.task.submittedAt);
      const form=new URLSearchParams(String(init.body));
      assert.equal(form.get('url'),expected.slug);
      assert.equal(form.get('text'),expected.text);
      assert.equal(form.get('edit_code'),createHmac('sha256',KEY)
        .update(`rentry-edit-v1:\0${f.task.id}\0${expected.contentHash}`).digest('base64url'));
      assert.equal((init.headers as Record<string,string>).authorization,undefined);
      if(options.redirect)return new Response('',{status:302,headers:{location:'https://evil.example/steal'}});
      if(options.challenge)return new Response('cf-turnstile challenge',{status:403,headers:{'cf-mitigated':'challenge'}});
      if(options.apiStatus)return new Response(JSON.stringify({status:options.apiStatus,content:'request rejected'}),
        {status:200,headers:{'content-type':'application/json'}});
      published=true;
      if(options.lostResponse)throw Error('response lost');
      return new Response(JSON.stringify({status:'200',content:'OK',url:page,url_short:expected.slug,
        edit_code:form.get('edit_code')}),{status:200,headers:{'content-type':'application/json'}});
    }
    assert.equal(url,page);
    assert.equal(init.method,'GET');
    assert.equal(String(init.body??''),'');
    readCount++;
    if(!published||options.absentOnce&&readCount===1)
      return new Response('missing',{status:404,headers:{'content-type':'text/html'}});
    return new Response(options.badPage??publicHtml(expected.text,page,options.noindex?'<meta name="robots" content="noindex">':''),
      {status:200,headers:{'content-type':'text/html'}});
  };
  return {fetch,calls,writes:()=>calls.filter(call=>call.init.method==='POST'),reads:()=>calls.filter(call=>call.init.method==='GET')};
}

test('Rentry creates one encrypted local identity without remote registration or a fabricated profile',async()=>{
  const f=fixture(true),calls:string[]=[];
  assert.equal(await prepareRentryIdentity(f.context,{fetch:async url=>{calls.push(url);throw Error('unexpected')}}),undefined);
  assert.equal(f.account()?.username,'anonymous');
  assert.equal(f.account()?.status,'registered');
  assert.equal(f.account()?.publicationUrl,undefined);
  assert.equal(f.account()?.registrationAttempts,undefined);
  const secret=f.secrets.get(`account:${f.account()!.id}`)!;
  assert.equal(rentryTesting.masterKey(secret).length,32);
  await prepareRentryIdentity(f.context,{fetch:async url=>{calls.push(url);throw Error('unexpected')}});
  assert.deepEqual(calls,[]);
  assert.equal(f.secrets.size,1);
});
test('failed local key persistence, missing key and mismatched account never write',async()=>{
  const empty=fixture(true);empty.rejectAccount();
  assert.equal((await prepareRentryIdentity(empty.context))?.status,'queued');
  assert.equal(empty.account(),undefined);
  for(const mutate of [(f:ReturnType<typeof fixture>)=>f.secrets.delete('account:account'),
    (f:ReturnType<typeof fixture>)=>{f.task.accountId='other-account'}]){
    const f=fixture(),s=server(f);mutate(f);
    assert.equal((await runRentryTask(f.context,{fetch:s.fetch}))?.status,'needs_input');
    assert.equal(s.calls.length,0);
  }
});
test('an identity created during run waits for the reviewed original account on the next turn',async()=>{
  const f=fixture(true),s=server(f);
  const result=await runRentryTask(f.context,{fetch:s.fetch});
  assert.equal(result.status,'queued');assert.ok(f.account());assert.equal(s.calls.length,0);
});
test('one POST follows a durable intent and public GET verifies exact rendered blocks and target link',async()=>{
  const f=fixture(),s=server(f);
  const result=await runRentryTask(f.context,{fetch:s.fetch});
  assert.equal(result.checkpoint,'rentry_published');
  assert.equal(result.rentry?.stage,'published');
  assert.equal(result.publicUrl,rentryTesting.pageUrl(result.rentry!.slug));
  assert.deepEqual(f.checkpoints.map(item=>item.checkpoint),['rentry_publish_submitting','rentry_published']);
  Object.assign(f.task,result);
  const verified=await verifyRentryPublication(f.task,TARGET,{fetch:s.fetch});
  assert.equal(verified.found,true);assert.equal(verified.rel,'nofollow ugc');
  assert.equal((await runRentryTask(f.context,{fetch:s.fetch})).checkpoint,'rentry_published');
  assert.equal(s.writes().length,1);
});
test('lost POST response can find the fixed page by GET without repeating POST',async()=>{
  const f=fixture(),s=server(f,{lostResponse:true});
  const result=await runRentryTask(f.context,{fetch:s.fetch});
  assert.equal(result.rentry?.stage,'published');assert.equal(s.writes().length,1);
  Object.assign(f.task,result);
  assert.equal((await reconcileRentryTask(f.context,{fetch:s.fetch})).status,'found');
  assert.equal(s.writes().length,1);
});
test('unknown publication remains bound to the same slug and later runs only GET',async()=>{
  const f=fixture(),s=server(f,{absentOnce:true});
  const result=await runRentryTask(f.context,{fetch:s.fetch});
  assert.equal(result.rentry?.stage,'submitting');
  assert.equal(result.publicUrl,undefined);
  Object.assign(f.task,result);
  assert.equal((await runRentryTask(f.context,{fetch:s.fetch})).rentry?.stage,'published');
  assert.equal(s.writes().length,1);
  assert.equal(s.reads().length,2);
});
test('editing the reviewed draft after a pending intent cannot create a replacement URL',async()=>{
  const f=fixture(),s=server(f,{absentOnce:true});
  Object.assign(f.task,await runRentryTask(f.context,{fetch:s.fetch}));
  const original=f.task.rentry!.slug;
  f.task.draft!.title='A different source record';
  assert.equal((await runRentryTask(f.context,{fetch:s.fetch})).rentry?.slug,original);
  assert.equal(s.writes().length,1);
});
test('API status 429, challenge and redirect stop after the one persisted POST intent',async()=>{
  for(const option of [{apiStatus:'429'},{challenge:true},{redirect:true}]){
    const f=fixture(),s=server(f,option);
    const result=await runRentryTask(f.context,{fetch:s.fetch});
    assert.equal(result.rentry?.stage,'submitting');
    assert.equal(s.writes().length,1);
    if(option.apiStatus||option.challenge)assert.equal(s.reads().length,0);
    assert.equal(s.calls.some(call=>call.url.includes('evil.example')),false);
    Object.assign(f.task,result);
    await runRentryTask(f.context,{fetch:s.fetch});
    assert.equal(s.writes().length,1);
  }
});
test('API errors in an HTTP 200 JSON body never authorize a second creation',async()=>{
  for(const apiStatus of ['400','503']){
    const f=fixture(),s=server(f,{apiStatus});
    Object.assign(f.task,await runRentryTask(f.context,{fetch:s.fetch}));
    assert.equal(f.task.rentry?.stage,'submitting');
    await runRentryTask(f.context,{fetch:s.fetch});
    assert.equal(s.writes().length,1);
  }
});
test('a saved pending receipt reconciles without approval or a live Vault secret',async()=>{
  const f=fixture(),s=server(f,{absentOnce:true});
  Object.assign(f.task,await runRentryTask(f.context,{fetch:s.fetch}));
  delete f.task.articleApprovedAt;f.secrets.delete('account:account');
  assert.equal((await reconcileRentryTask(f.context,{fetch:s.fetch})).status,'found');
  assert.equal(s.writes().length,1);
});
test('missing approval, private target, missing link and unpersisted intent perform no request',async()=>{
  for(const mutate of [
    (f:ReturnType<typeof fixture>)=>{delete f.task.articleApprovedAt},
    (f:ReturnType<typeof fixture>)=>{f.task.topicUrl='https://127.0.0.1/private'},
    (f:ReturnType<typeof fixture>)=>{f.task.draft!.body=BODY.replace(TARGET,'https://other.example.com/')},
    (f:ReturnType<typeof fixture>)=>{f.task.draft!.body+='\n\n[Internal note](https://127.0.0.1/private)'},
    (f:ReturnType<typeof fixture>)=>{f.rejectCheckpoint()},
  ]){
    const f=fixture(),s=server(f);mutate(f);
    const result=await runRentryTask(f.context,{fetch:s.fetch});
    assert.ok(['needs_input','queued'].includes(result.status));
    assert.equal(s.calls.length,0);
  }
});
test('rendered verification rejects altered or hidden body, target, heading and footer-only matches',()=>{
  const f=fixture(),expected=rentryTesting.article(f.task,TARGET);
  const url=rentryTesting.pageUrl(expected.slug),good=publicHtml(expected.text,url);
  assert.ok(rentryTesting.rendered(good,expected,url,new Headers()));
  for(const bad of [
    good.replace(TITLE,'Changed title'),
    good.replace(TARGET,'https://other.example.com/'),
    good.replace('<article>','<article hidden>'),
    good.replace('<article>','<article style="display:none">'),
    good.replace('<article>','<details><article>').replace('</article>','</article></details>'),
    good.replace('</head>','<style>.entry-text article {display:none}</style></head>'),
    good.replace('<div class="entry-text">','<div class="entry-text" aria-hidden="true">'),
    good.replace('</article>','<script src="https://evil.example/mutate.js"></script></article>'),
    publicHtml('# Short body\n\nNot the reviewed article.',url,'',source=>source)+
      `<footer>${expected.text}</footer>`,
    good.replace(`href="${url}"`,'href="https://evil.example/"'),
  ])assert.equal(rentryTesting.rendered(bad,expected,url,new Headers()),undefined);
});
test('a cancelled or timed-out request leaves the original pending receipt without another POST',async()=>{
  const cancelled=fixture();let cancelledCalls=0;
  const result=await runRentryTask(cancelled.context,{fetch:async(_url,_init)=>{
    cancelledCalls++;cancelled.signal.abort();throw Error('cancelled');
  }});
  assert.equal(result.rentry?.stage,'submitting');assert.equal(cancelledCalls,1);
  const timed=fixture();let writes=0,reads=0;
  const watchdog=setTimeout(()=>{throw Error('Rentry bounded timeout failed')},1500);
  try{
    const pending=await runRentryTask(timed.context,{timeoutMs:100,fetch:async(_url,init)=>{
      if(init.method==='POST')writes++;else reads++;
      return new Promise<Response>((_resolve,reject)=>{
        init.signal?.addEventListener('abort',()=>reject(Error('aborted')),{once:true});
      });
    }});
    assert.equal(pending.rentry?.stage,'submitting');assert.equal(writes,1);assert.equal(reads,1);
  }finally{clearTimeout(watchdog)}
});
test('noindex stops SEO source credit while actual nofollow attributes remain visible',async()=>{
  const f=fixture(),s=server(f,{noindex:true});
  Object.assign(f.task,await runRentryTask(f.context,{fetch:s.fetch}));
  const verified=await verifyRentryPublication(f.task,TARGET,{fetch:s.fetch});
  assert.equal(verified.found,false);
  assert.equal(verified.outcome,'invalid');
  assert.match(verified.reason,/noindex/);
  assert.equal(verified.rel,'nofollow ugc');
  const expected=rentryTesting.article(f.task,TARGET,false),url=rentryTesting.pageUrl(expected.slug);
  assert.equal(rentryTesting.rendered(publicHtml(expected.text,url),expected,url,
    new Headers({'x-robots-tag':'noindex, nofollow'}))?.noindex,true);
});
test('an already cancelled task performs no network write or substitute identity creation',async()=>{
  const f=fixture(true),s=server(f);f.signal.abort();
  assert.equal((await prepareRentryIdentity(f.context,{fetch:s.fetch}))?.status,'needs_input');
  assert.equal(f.account(),undefined);assert.equal(s.calls.length,0);
});


test('official flat create response is accepted only for the original URL and edit code',async()=>{
  const f=fixture(),expected=rentryTesting.article(f.task,TARGET),code=rentryTesting.editCode(KEY,f.task.id,expected.contentHash);
  const fetchResponse=(payload:unknown):RentryTransport=>async()=>new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});
  const good={status:'200',content:'OK',url:rentryTesting.pageUrl(expected.slug),edit_code:code};
  await rentryTesting.createPage(expected,code,{fetch:fetchResponse(good)});
  for(const bad of [{...good,url:'https://evil.example/'},{...good,edit_code:'incorrect'},{...good,url_short:'different'}, {...good,status:'400'}])
    await assert.rejects(rentryTesting.createPage(expected,code,{fetch:fetchResponse(bad)}));
});
test('a title that Markdown would change is rejected before any publication intent or request',async()=>{
  const f=fixture(),s=server(f);f.task.draft!.title='Keeping **useful** source records';
  assert.equal((await runRentryTask(f.context,{fetch:s.fetch})).status,'needs_input');
  assert.equal(s.calls.length,0);assert.equal(f.task.rentry,undefined);
});
test('verification keeps code whitespace and rejects extra visual content and mixed-case noindex',()=>{
  const f=fixture();f.task.draft!.body+='\n\n```python\nif ready:\n    publish()\n```';
  const expected=rentryTesting.article(f.task,TARGET),url=rentryTesting.pageUrl(expected.slug),good=publicHtml(expected.text,url);
  assert.ok(rentryTesting.rendered(good,expected,url,new Headers()));
  assert.equal(rentryTesting.rendered(good.replace('    publish()','publish()'),expected,url,new Headers()),undefined);
  assert.equal(rentryTesting.rendered(good.replace('</h1>','</h1><img src="https://evil.example/overlay.png">'),expected,url,new Headers()),undefined);
  assert.equal(rentryTesting.rendered(good.replace('</head>','<meta name="RoBoTs" content="NOINDEX"></head>'),expected,url,new Headers())?.noindex,true);
});
test('prior publication retains its checkpoint on read failure and never replaces a conflicting URL',async()=>{
  const f=fixture(),expected=rentryTesting.article(f.task,TARGET),url=rentryTesting.pageUrl(expected.slug);
  f.task.rentry={slug:expected.slug,contentHash:expected.contentHash,stage:'published'};
  f.task.publicUrl=url;f.task.submittedAt=NOW;f.task.checkpoint='rentry_published';
  let calls=0;
  const fetch:RentryTransport=async()=>{calls++;throw Error('offline')};
  const offline=await runRentryTask(f.context,{fetch});
  assert.equal(offline.checkpoint,'rentry_published');
  assert.equal(offline.publicUrl,url);assert.equal(offline.rentry?.stage,'published');
  assert.equal(calls,1);
  f.task.publicUrl='https://rentry.co/conflicting-original';
  assert.equal((await reconcileRentryTask(f.context,{fetch})).status,'unknown');
  assert.equal((await runRentryTask(f.context,{fetch})).status,'needs_input');
  assert.equal(calls,1);assert.equal(f.task.publicUrl,'https://rentry.co/conflicting-original');
});


test('Rentry keeps preview value none distinct from an indexing restriction',()=>{
  const f=fixture(),expected=rentryTesting.article(f.task,TARGET,false),url=rentryTesting.pageUrl(expected.slug);
  assert.equal(rentryTesting.rendered(publicHtml(expected.text,url),expected,url,new Headers({'x-robots-tag':'max-image-preview:none'}))?.noindex,false);
});
