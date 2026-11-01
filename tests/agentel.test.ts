import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AGENTEL_API,AGENTEL_ORIGIN,runAgentelPublication,runAgentelRegistration,validateAgentelArticle,verifyAgentelPublic,
  type AgentelEncryptedJournal,type AgentelIdentity,type AgentelJournal} from '../src/integrations/agentel';

const identity:AgentelIdentity={name:'Linkflow Research Agent',slug:'linkflow-research-agent',description:'AI agent documenting software integration research with explicit project affiliation.',category:'coding',installationId:'linkflow-research-01'};
const siteId='source-site-1';

test('public acceptance rejects crawler-specific none and noindex directives',async()=>{
  const article={title:'A software note',content:'See https://example.com/post',targetUrl:'https://example.com/post',siteUrl:'https://example.com/'};
  for(const [header,meta,expected] of [
    ['googlebot: none','',false],['googlebot:none','',false],['bingbot: noindex, follow','',false],
    ['', '<meta name="Googlebot" content="none">',false],
    ['', '<meta name="robots" content="none">',false],['all','',true],
  ] as const){
    const page=`<html><head>${meta}</head><body><article class="detail-main"><h1>${article.title}</h1><div class="feed-content-thread">See <a href="${article.targetUrl}">${article.targetUrl}</a></div></article></body></html>`;
    const fetcher=async(url:string)=>url.endsWith('/robots.txt')?new Response('User-agent: *\nAllow: /thread/\n')
      :new Response(page,{headers:{'content-type':'text/html','x-robots-tag':header}});
    assert.equal(await verifyAgentelPublic(`${AGENTEL_ORIGIN}/thread/update_test-1`,article,{fetch:fetcher}),expected);
  }
});
test('public acceptance rejects hidden body, title, link and declared hiding but accepts the visible page',async()=>{
  const article={title:'A software note',content:'See https://example.com/post',targetUrl:'https://example.com/post',siteUrl:'https://example.com/'};
  const link=`<a href="${article.targetUrl}">${article.targetUrl}</a>`,page=({style='',wrapper='',title='',body='',anchor=''}:{style?:string;wrapper?:string;title?:string;body?:string;anchor?:string})=>`<html><head>${style}</head><body><div ${wrapper}><article class="detail-main"><h1 ${title}>${article.title}</h1><div class="feed-content-thread" ${body}>See ${link.replace('<a ',`<a ${anchor} `)}</div></article></div></body></html>`;
  const accepted=async(html:string)=>verifyAgentelPublic(`${AGENTEL_ORIGIN}/thread/update_test-1`,article,{fetch:async(url:string)=>url.endsWith('/robots.txt')?new Response('User-agent: *\nAllow: /thread/\n'):new Response(html,{headers:{'content-type':'text/html'}})});
  assert.equal(await accepted(page({})),true);
  for(const hidden of [{body:'hidden'},{body:'style="display:none"'},{body:'style="opacity:0"'},{body:'aria-hidden="true"'},{title:'style="visibility:hidden"'},{anchor:'hidden'},{anchor:'style="display:none"'},{anchor:'class="sr-only"'},{wrapper:'style="display:none"'},{wrapper:'hidden'},{style:'<style>.feed-content-thread{display:none}</style>'},{style:'<style>.detail-main a{visibility:hidden}</style>'}])
    assert.equal(await accepted(page(hidden)),false,JSON.stringify(hidden));
});

const account=()=>({agent:{id:'agent_test-1',slug:identity.slug},credential:{id:'cred_1',key:'agentel_live_test_secret'}});
const json=(value:unknown,status=200,url='')=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function memory(){let value:AgentelJournal|undefined;const writes:AgentelJournal[]=[];
  const journal:AgentelEncryptedJournal={load:async()=>value,save:async(next,previous)=>{
    assert.deepEqual(value,previous);value=structuredClone(next);writes.push(structuredClone(next));}};
  return {journal,writes,get:()=>value};
}
function options(store:ReturnType<typeof memory>,fetcher:(url:string,init:RequestInit)=>Promise<Response>,authorize:()=>Promise<void>|void=()=>{},taskId?:string){
  return {journal:store.journal,siteId,...(taskId?{taskId}:{}),authorize,signal:new AbortController().signal,dependencies:{fetch:fetcher},now:()=>new Date('2026-10-30T01:00:00Z')};
}

test('registration reserves and encryptable-journals raw response before parse, then verifies exact identity',async()=>{
  const store=memory(),calls:string[]=[];
  const fetcher=async(url:string,init:RequestInit)=>{calls.push(`${init.method} ${url}`);
    if(url===`${AGENTEL_API}/agents/register`){assert.equal(new Headers(init.headers).get('Idempotency-Key'),store.get()?.intent.operationId);
      assert.equal(store.get()?.stage,'sending');return json(account(),201)}
    assert.equal(url,`${AGENTEL_API}/me`);assert.ok(['opaque','verified'].includes(store.get()?.stage??''));return json({agent:{id:'agent_test-1',slug:identity.slug}})};
  const result=await runAgentelRegistration(identity,options(store,fetcher));
  assert.equal(result.status,'verified');assert.deepEqual(store.writes.map(x=>x.stage),['reserved','sending','opaque','verified']);
  assert.equal(store.get()?.opaque?.bodyBase64,Buffer.from(JSON.stringify(account())).toString('base64'));
  assert.deepEqual(calls,[`POST ${AGENTEL_API}/agents/register`,`GET ${AGENTEL_API}/me`]);
  const again=await runAgentelRegistration(identity,options(store,fetcher));assert.equal(again.status,'verified');assert.equal(calls.filter(x=>x.startsWith('POST')).length,1);
});

test('late revoked authorization leaves armed registration unknown and never sends POST',async()=>{
  const store=memory();let checks=0,posts=0;
  const fetcher=async()=>{posts++;return json(account(),201)};
  const first=await runAgentelRegistration(identity,options(store,fetcher,()=>{checks++;if(checks>=3)throw Error('revoked')}));
  assert.equal(first.status,'unknown');assert.equal(store.get()?.stage,'sending');assert.equal(posts,0);
  const again=await runAgentelRegistration(identity,options(store,fetcher));assert.equal(again.status,'unknown');assert.equal(posts,0);
});

test('unknown registration transport never retries or creates another identity',async()=>{
  const store=memory();let posts=0;
  const fetcher=async()=>{posts++;throw Error('timeout')};
  assert.equal((await runAgentelRegistration(identity,options(store,fetcher))).status,'unknown');
  assert.equal((await runAgentelRegistration(identity,options(store,fetcher))).status,'unknown');
  assert.equal(posts,1);assert.equal(store.get()?.stage,'sending');
});

test('publication keeps exact text and accepts only full SSR body with native target anchor and permissive robots',async()=>{
  const store=memory(),target='https://example.com/software',content=`What we built and verified. Source: ${target}`;
  const article={title:'A software integration note',content,targetUrl:target,siteUrl:'https://example.com/'};
  const credential={agentId:'agent_test-1',slug:identity.slug,apiKey:'agentel_live_test_secret'};
  const page=`<!doctype html><html><head><title>${article.title}</title></head><body><article class="detail-main"><h1>${article.title}</h1><div class="feed-content-thread"><p>What we built and verified. Source: <a href="${target}" rel="noreferrer noopener">${target}</a></p></div></article></body></html>`;
  let posts=0;
  const fetcher=async(url:string,init:RequestInit)=>{
    if(url===`${AGENTEL_API}/me`)return json({agent:{id:credential.agentId,slug:credential.slug}});
    if(url===`${AGENTEL_API}/agents/${credential.agentId}/updates`){posts++;assert.equal(store.get()?.stage,'sending');assert.deepEqual(JSON.parse(String(init.body)),{type:'RESEARCH_NOTE',title:article.title,content,tags:['software']});return json({update:{id:'update_abc-123'},created:true},201)}
    if(url===`${AGENTEL_ORIGIN}/thread/update_abc-123`)return new Response(page,{status:200,headers:{'content-type':'text/html'}});
    if(url===`${AGENTEL_ORIGIN}/robots.txt`)return new Response('User-Agent: *\nAllow: /\nAllow: /thread/\n',{status:200});
    throw Error(`unexpected ${url}`);
  };
  const result=await runAgentelPublication(article,credential,options(store,fetcher,()=>{},'task-1'));
  assert.deepEqual(result,{status:'verified',publicUrl:`${AGENTEL_ORIGIN}/thread/update_abc-123`});assert.equal(posts,1);
  assert.deepEqual(store.writes.map(x=>x.stage),['reserved','sending','opaque','verified']);
  assert.equal((await runAgentelPublication(article,credential,options(store,fetcher,()=>{},'task-1'))).status,'verified');assert.equal(posts,1);
});

test('publication rejects over-limit text without truncating or touching network',async()=>{
  const article={title:'Valid',content:`${'x'.repeat(5000)} https://example.com/post`,targetUrl:'https://example.com/post',siteUrl:'https://example.com/'};
  assert.throws(()=>validateAgentelArticle(article),/agentel_article_limit/);
});

test('publication late permission loss leaves sending state with zero POST',async()=>{
  const store=memory(),credential={agentId:'agent_test-1',slug:identity.slug,apiKey:'agentel_live_test_secret'};
  const article={title:'A software note',content:'Evidence at https://example.com/post',targetUrl:'https://example.com/post',siteUrl:'https://example.com/'};
  let checks=0,posts=0;
  const fetcher=async(url:string)=>{if(url===`${AGENTEL_API}/me`)return json({agent:{id:credential.agentId,slug:credential.slug}});posts++;return json({update:{id:'update_abc-123'}},201)};
  const result=await runAgentelPublication(article,credential,options(store,fetcher,()=>{checks++;if(checks>=3)throw Error('revoked')},'task-1'));
  assert.equal(result.status,'unknown');assert.equal(store.get()?.stage,'sending');assert.equal(posts,0);
});

test('unknown publication checks the original account history only and never resubmits',async()=>{
  const store=memory(),credential={agentId:'agent_test-1',slug:identity.slug,apiKey:'agentel_live_test_secret'};
  const article={title:'A software note',content:'Evidence at https://example.com/post',targetUrl:'https://example.com/post',siteUrl:'https://example.com/'};
  let posts=0,historyReads=0;
  const fetcher=async(url:string)=>{
    if(url===`${AGENTEL_API}/me`)return json({agent:{id:credential.agentId,slug:credential.slug}});
    if(url===`${AGENTEL_API}/agents/${credential.agentId}/updates`){posts++;throw Error('timeout_after_send')}
    if(url===`${AGENTEL_API}/agents/${credential.agentId}/updates?limit=20`){historyReads++;return json({agent:{id:credential.agentId},updates:[]})}
    throw Error(`unexpected ${url}`);
  };
  assert.equal((await runAgentelPublication(article,credential,options(store,fetcher,()=>{},'task-1'))).status,'unknown');
  assert.equal((await runAgentelPublication(article,credential,options(store,fetcher,()=>{},'task-1'))).status,'unknown');
  assert.equal(posts,1);assert.equal(historyReads,1);assert.equal(store.get()?.stage,'sending');
});

test('SSR Markdown headings and paragraph boundaries retain the complete reviewed text',async()=>{
 const article={title:'Read before retry',content:'First paragraph.\n\n## Check receipts\n\nRead the original record.\n\nhttps://example.com/guide\n',targetUrl:'https://example.com/guide',siteUrl:'https://example.com/'};
 const body='<p>First paragraph.</p><h3>Check receipts</h3><p>Read the original record.</p><p><a href="https://example.com/guide">https://example.com/guide</a></p>';
 for(const [html,expected] of [[body,true],[body.replace('<p>Read the original record.</p>',''),false],[body.replace('original record','other record'),false],[body.replace('href="https://example.com/guide"','href="https://example.com/other"'),false]] as const){
  const page=`<article class="detail-main"><h1>${article.title}</h1><div class="feed-content-thread">${html}</div></article>`;
  assert.equal(await verifyAgentelPublic(`${AGENTEL_ORIGIN}/thread/update_test-1`,article,{fetch:async url=>url.endsWith('/robots.txt')?new Response('User-agent: *\nAllow: /thread/\n'):new Response(page,{headers:{'content-type':'text/html'}})}),expected);
 }
});
