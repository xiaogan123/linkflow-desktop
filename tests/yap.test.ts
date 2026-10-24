import assert from 'node:assert/strict';
import test from 'node:test';
import {marked} from 'marked';
import {
  YAP_PAGES_URL,YAP_PUBLISH_URL,YAP_REGISTER_URL,YAP_STATS_URL,
  YapSecretStorePersistence,ensureYapIdentity,ensureYapPage,prepareYapArticle,publishYapOnce,reconcileYapPublication,runYapAcceptance,verifyYapPublication,yapPageOrigin,
  type YapIdentity,type YapIntent,type YapOpaqueResponse,type YapPage,type YapPersistence,type YapReceipt,
} from '../src/integrations/yap';
import type {SecretStore} from '../src/shared/types';

const now='2026-10-22T08:00:00.000Z';
const seed='0123456789abcdef0123456789abcdef';
const targetUrl='https://github.com/xiaogan123/linkflow-desktop';
const page:YapPage={handle:'linkflow-project',title:'LinkFlow Project',type:'creator'};
const article=prepareYapArticle({
  title:'Publish Once: a durable TypeScript pattern for ambiguous POST results',
  targetUrl,
  body:`By the LinkFlow Project maintainer.\n\n## The failure that matters\n\nA client can lose the response after a server accepts a POST. Retrying blindly can create a duplicate. This guide shows a small durable journal that records the exact request before dispatch and closes a permanent latch.\n\n## Keep identity separate from content\n\nEncrypt the API key, bind the title to a body digest, and use read-only reconciliation after an uncertain result. The implementation is part of the [LinkFlow desktop project](${targetUrl}); the link is included once because it identifies the software discussed here.\n\n## Recovery\n\nSearch the public page list for the exact title, then require the complete server-rendered article to match the locally rendered Markdown. If either check is missing, leave the operation unknown and ask a maintainer to inspect it. Never turn uncertainty into another POST.`,
});
const identity:YapIdentity={name:'LinkFlow Project',apiKey:`yap_${'k'.repeat(48)}`};
const publicUrl=`${yapPageOrigin(page.handle)}/retry-safe-publishers`;

function memory(initial:{identity?:YapIdentity;page?:YapPage;intents?:Partial<Record<'register'|'page'|'publish',YapIntent>>}={}){
  let storedIdentity=initial.identity,storedPage=initial.page,receipt:YapReceipt|undefined;
  const intents=new Map(Object.entries(initial.intents??{}) as [YapIntent['stage'],YapIntent][]),opaque=new Map<YapIntent['stage'],YapOpaqueResponse>(),events:string[]=[];
  const persistence:YapPersistence={
    secretStorage:'encrypted',
    async loadIdentity(){return storedIdentity&&structuredClone(storedIdentity)},
    async loadPage(){return storedPage&&structuredClone(storedPage)},
    async loadIntent(stage){return intents.get(stage)&&structuredClone(intents.get(stage)!)},
    async loadOpaqueResponse(stage){return opaque.get(stage)&&structuredClone(opaque.get(stage)!)},
    async persistIntent(value){if(intents.has(value.stage))throw Error('latched');intents.set(value.stage,structuredClone(value));events.push(`intent:${value.stage}`)},
    assertReadyToSubmit(value){assert.deepEqual(value,intents.get(value.stage));events.push(`authorized:${value.stage}`);return true},
    async persistOpaqueResponse(value){opaque.set(value.stage,structuredClone(value));events.push(`opaque:${value.stage}`)},
    async promoteIdentity(value){assert.ok(opaque.has('register'),'raw registration response must be durable first');storedIdentity=structuredClone(value);events.push('identity')},
    async promotePage(value){assert.ok(opaque.has('page'));storedPage=structuredClone(value);events.push('page')},
    async promoteReceipt(value){assert.ok(opaque.has('publish'));receipt=structuredClone(value);events.push('receipt')},
  };
  return {persistence,events,intents,opaque,clearIdentity(){storedIdentity=undefined},clearPage(){storedPage=undefined},get identity(){return storedIdentity},get page(){return storedPage},get receipt(){return receipt}};
}

function jsonResponse(value:unknown,status=201){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})}
function pageHtml(options:{noindex?:boolean;pageNofollow?:boolean;rel?:string;canonical?:string;changedBody?:boolean}={}){let rendered=String(marked.parse(article.body,{async:false,gfm:true}));if(options.rel)rendered=rendered.replace(`href="${targetUrl}"`,`href="${targetUrl}" rel="${options.rel}"`);if(options.changedBody)rendered=rendered.replace('Never turn uncertainty into another POST.','Never turn uncertainty into two more POSTs.');const robots=options.noindex?'noindex, nofollow':options.pageNofollow?'index, nofollow':'index, follow';return `<!doctype html><html><head><meta name="robots" content="${robots}"><link rel="canonical" href="${options.canonical??publicUrl}"></head><body><article><h1>${article.title}</h1><div class="art-body">${rendered}</div></article></body></html>`}
function getResponse(url:string,options:Parameters<typeof pageHtml>[0]={},robots='User-agent: *\nAllow: /\nSitemap: https://linkflow-project.letyap.com/sitemap.xml\n'){if(url===publicUrl)return new Response(pageHtml(options),{status:200,headers:{'content-type':'text/html'}});if(url===`${yapPageOrigin(page.handle)}/robots.txt`)return new Response(robots,{status:200,headers:{'content-type':'text/plain'}});throw Error(`unexpected GET ${url}`)}

test('article preparation binds the exact source body without adding a public marker',()=>{
  assert.match(article.bodySha256,/^[a-f0-9]{64}$/);
  assert.ok(!article.body.includes('LF-SOURCE-SHA256:'));
  assert.equal(article.byteLength,Buffer.byteLength(article.body));
  assert.equal(article.body.match(new RegExp(targetUrl.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))?.length,1);
});

test('default runner disables every external write',async()=>{
  const state=memory(),calls:string[]=[];
  const result=await runYapAcceptance({operationSeed:seed,name:identity.name,page,article},state.persistence,{now:()=>new Date(now),fetch:async url=>{calls.push(url);throw Error('must not run')}});
  assert.deepEqual(calls,[]);
  assert.deepEqual(result.identity,{status:'not_started',reason:'external_write_disabled'});
  assert.equal(state.intents.size,0);
});

test('registration persists the opaque key-bearing response before parsing or promotion',async()=>{
  const state=memory();
  const result=await ensureYapIdentity({operationSeed:seed,name:identity.name},state.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{
    assert.equal(url,YAP_REGISTER_URL);assert.equal(init.method,'POST');assert.equal((init.headers as Record<string,string>).authorization,undefined);
    return jsonResponse({api_key:identity.apiKey});
  }});
  assert.deepEqual(result,{status:'created',value:identity});
  assert.deepEqual(state.events,['intent:register','authorized:register','opaque:register','identity']);
  assert.ok(state.opaque.get('register')?.bodyBase64);
});

test('a saved registration response can restore the once-only key without another POST',async()=>{
  const state=memory();let calls=0;
  await ensureYapIdentity({operationSeed:seed,name:identity.name},state.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>{calls++;return jsonResponse({api_key:identity.apiKey})}});
  state.clearIdentity();
  const recovered=await ensureYapIdentity({operationSeed:seed,name:identity.name},state.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>{calls++;throw Error('must not register twice')}});
  assert.deepEqual(recovered,{status:'created',value:identity});assert.equal(calls,1);
});

test('two persistence objects sharing one SecretStore synchronously claim registration before either awaits',async()=>{
  const values=new Map<string,string>();
  const store:SecretStore={async get(key){await new Promise(resolve=>setTimeout(resolve,5));return values.get(key)},async set(key,value){await new Promise(resolve=>setTimeout(resolve,5));values.set(key,value)},async delete(key){values.delete(key)}};
  const first=new YapSecretStorePersistence(store,'race'),second=new YapSecretStorePersistence(store,'race');let posts=0;
  const run=(persistence:YapSecretStorePersistence)=>ensureYapIdentity({operationSeed:seed,name:identity.name},persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>{posts++;return jsonResponse({api_key:identity.apiKey})}});
  const results=await Promise.all([run(first),run(second)]);
  assert.equal(posts,1);assert.equal(results.filter(result=>result.status==='created').length,1);assert.equal(results.filter(result=>result.status!=='created').length,1);
});

test('existing encrypted identity and page are reused without registration or page creation',async()=>{
  const state=memory({identity,page}),calls:string[]=[];
  const first=await ensureYapIdentity({operationSeed:seed,name:identity.name},state.persistence,{allowExternalWrite:true,fetch:async url=>{calls.push(url);throw Error('no')}});
  const second=await ensureYapPage({operationSeed:seed,identity,page},state.persistence,{allowExternalWrite:true,fetch:async url=>{calls.push(url);throw Error('no')}});
  assert.equal(first.status,'created');assert.equal(second.status,'created');assert.deepEqual(calls,[]);
});

test('full acceptance performs three authorized POSTs, then validates SSR, canonical, anchor and robots',async()=>{
  const state=memory(),calls:string[]=[];
  const result=await runYapAcceptance({operationSeed:seed,name:identity.name,page,article},state.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{
    calls.push(`${init.method}:${url}`);
    if(url===YAP_REGISTER_URL)return jsonResponse({api_key:identity.apiKey});
    if(url===YAP_PAGES_URL){assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${identity.apiKey}`);return jsonResponse({page:{handle:page.handle,url:yapPageOrigin(page.handle)}})}
    if(url===YAP_PUBLISH_URL){const body=JSON.parse(String(init.body));assert.equal(body.visibility,'public');assert.equal(body.format,'guide');assert.equal(body.body,article.body);assert.ok(!body.body.includes('LF-SOURCE-SHA256:'));return jsonResponse({url:publicUrl})}
    return getResponse(url);
  }});
  assert.equal(result.publish?.status,'created');assert.equal(result.verification?.status,'usable');
  assert.deepEqual(calls.slice(0,3),[`POST:${YAP_REGISTER_URL}`,`POST:${YAP_PAGES_URL}`,`POST:${YAP_PUBLISH_URL}`]);
  assert.deepEqual(state.events.filter(value=>value.startsWith('opaque')||['identity','page','receipt'].includes(value)),['opaque:register','identity','opaque:page','page','opaque:publish','receipt']);
});

test('ambiguous publish closes the permanent latch and a second call never sends',async()=>{
  const state=memory({identity,page});let calls=0;
  const first=await publishYapOnce({operationSeed:seed,identity,page,article},state.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>{calls++;throw Error('socket closed')}});
  const second=await publishYapOnce({operationSeed:seed,identity,page,article},state.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>{calls++;throw Error('must not run')}});
  assert.equal(first.status,'unknown');assert.equal(second.status,'blocked');assert.equal(calls,1);assert.ok(state.intents.has('publish'));
});

test('unknown publish reconciliation only GETs and requires exact title plus the complete rendered body',async()=>{
  const state=memory({identity,page});await publishYapOnce({operationSeed:seed,identity,page,article},state.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>{throw Error('timeout')}});const prior=state.intents.get('publish')!;const methods:string[]=[];
  const result=await reconcileYapPublication(prior,article,identity,{fetch:async(url,init)=>{
    methods.push(String(init.method));
    if(url===`${yapPageOrigin(page.handle)}/`)return new Response(`<a href="${publicUrl}">${article.title}</a>`,{status:200,headers:{'content-type':'text/html'}});
    if(url===YAP_STATS_URL)return jsonResponse({posts:[{title:article.title,url:publicUrl}]},200);
    return getResponse(url);
  }});
  assert.equal(result.status,'found');assert.ok(methods.length>=4);assert.ok(methods.every(method=>method==='GET'));
});

test('public verification rejects noindex, wrong canonical and changed body text',async()=>{
  const receipt:YapReceipt={...({operationId:`yap_${seed}_publish`,stage:'publish',requestUrl:YAP_PUBLISH_URL,requestHash:'a'.repeat(64),createdAt:now,handle:page.handle,title:article.title,bodySha256:article.bodySha256} satisfies YapIntent),publicUrl};
  for(const [reason,options] of [['indexing',{noindex:true}],['canonical',{canonical:`${yapPageOrigin(page.handle)}/other`}],['content',{changedBody:true}]] as const){
    const result=await verifyYapPublication(receipt,article,{fetch:async url=>getResponse(url,options)});assert.deepEqual(result,{status:'invalid',reason});
  }
});

test('nofollow, ugc and sponsored are recorded without rejecting an otherwise usable article',async()=>{
  const receipt:YapReceipt={...({operationId:`yap_${seed}_publish`,stage:'publish',requestUrl:YAP_PUBLISH_URL,requestHash:'a'.repeat(64),createdAt:now,handle:page.handle,title:article.title,bodySha256:article.bodySha256} satisfies YapIntent),publicUrl};
  const link=await verifyYapPublication(receipt,article,{fetch:async url=>getResponse(url,{rel:'nofollow ugc sponsored'})});assert.equal(link.status,'usable');if(link.status==='usable')assert.equal(link.rel,'nofollow ugc sponsored');
  const pageDirective=await verifyYapPublication(receipt,article,{fetch:async url=>getResponse(url,{rel:'ugc',pageNofollow:true})});assert.equal(pageDirective.status,'usable');if(pageDirective.status==='usable')assert.equal(pageDirective.rel,'ugc nofollow');
});

test('robots wildcards, end anchors and specific crawler groups block acceptance',async()=>{
  const receipt:YapReceipt={...({operationId:`yap_${seed}_publish`,stage:'publish',requestUrl:YAP_PUBLISH_URL,requestHash:'a'.repeat(64),createdAt:now,handle:page.handle,title:article.title,bodySha256:article.bodySha256} satisfies YapIntent),publicUrl};
  const blocked=[
    'User-agent: *\nDisallow: /retry-*\n',
    'User-agent: *\nDisallow: /retry-safe-publishers$\n',
    'User-agent: *\nAllow: /\nUser-agent: Googlebot\nDisallow: /retry-safe-publishers\n',
  ];
  for(const robots of blocked){const result=await verifyYapPublication(receipt,article,{fetch:async url=>getResponse(url,{},robots)});assert.deepEqual(result,{status:'invalid',reason:'robots'})}
});

