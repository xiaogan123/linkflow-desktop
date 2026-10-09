import assert from 'node:assert/strict';
import test from 'node:test';
import {marked} from 'marked';
import {CHANNELS} from '../src/integrations/catalog';
import {publisherFor} from '../src/integrations/publishers';
import {reconcileSupanoteTask,runSupanoteTask,supanoteDraftError,verifySupanotePublication} from '../src/integrations/supanote-publisher';
import {supanoteTesting,type SupanotePersistence,type SupanoteTransport} from '../src/integrations/supanote';
import type {ExecutionContext,Site,Task} from '../src/shared/types';

const stamp='2026-10-09T00:00:00.000Z';
const taskId='11111111-1111-4111-8111-111111111111';
const siteId='22222222-2222-4222-8222-222222222222';
const publicId='note_cycle_44';
const publicUrl=`https://supanote.app/n/${publicId}`;
const draft={title:'A reviewed Supanote guide',description:'Fixture',body:'# A reviewed Supanote guide\n\nA complete reviewed Markdown guide with a [source](https://example.test/guide).'};

function channel(){const value=CHANNELS.find(item=>item.id==='supanote');assert.ok(value);return value}
function site():Site{return {id:siteId,domain:'example.test',url:'https://example.test/',email:'owner@example.test',name:'Example',description:'Independent guides',category:'content',language:'en',monthlyTarget:1,articleReviewMode:'manual',status:'ready',createdAt:stamp,analyzedAt:stamp}}
function task(extra:Partial<Task>={}):Task{return {id:taskId,siteId,channelId:'supanote',sourceDomain:'supanote.app',status:'running',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'fixture',topicUrl:'https://example.test/guide',draft,articleApprovedAt:stamp,...extra}}
function context(taskValue:Task,persistence?:SupanotePersistence):ExecutionContext{return {site:site(),channel:{...channel(),enabled:true},task:taskValue,settings:{provider:'codex',codexPath:'codex',model:'',articleReviewMode:'manual',preferredBrowser:'system',apiBase:'https://api.openai.com/v1',hasApiKey:false,autoRun:true,launchAtLogin:false,notify:false,timezone:'UTC',maxAttempts:3,maxSteps:18,dailyAiLimit:40,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},secrets:{get:async()=>undefined,set:async()=>{},delete:async()=>{}},ai:{json:async()=>{throw Error('unused')}},signal:new AbortController().signal,...(persistence?{supanotePersistence:persistence}:{}),getAccount:()=>undefined,saveAccount:async()=>{},checkpoint:()=>{},log:()=>{}}}

function publicHtml(overrides:{title?:string;body?:string;canonical?:string;robots?:string;root?:string;rel?:string}={}):string{
  const body=overrides.body??draft.body;let rendered=String(marked.parse(body,{async:false,gfm:true})).replaceAll('<a href=',`<a rel="${overrides.rel??'ugc nofollow noopener noreferrer'}" href=`);
  if(overrides.title)rendered=rendered.replace(/^<h1>.*?<\/h1>/s,`<h1>${overrides.title}</h1>`);
  return `<!doctype html><html><head><link rel="canonical" href="${overrides.canonical??publicUrl}"><meta name="robots" content="${overrides.robots??'index,follow'}"></head><body><div id="note-view-container"><div data-tab-content="tab-rendered" class="prose-content"${overrides.root??''}>${rendered}</div><textarea id="raw-note-content" hidden>${draft.body}</textarea></div></body></html>`;
}
function apiTransport(requests:string[],html=publicHtml(),robots='User-agent: *\nAllow: /'):SupanoteTransport{return async(url,init)=>{requests.push(`${init.method}:${url}`);if(url===`https://supanote.app/api/v1/notes/${publicId}`)return new Response(JSON.stringify({success:true,data:{publicId,title:draft.title,content:draft.body,contentType:'markdown',visibility:'public',expiresAt:null}}),{status:200,headers:{'content-type':'application/json'}});if(url==='https://supanote.app/robots.txt')return new Response(robots,{status:200,headers:{'content-type':'text/plain'}});assert.equal(url,publicUrl);return new Response(html,{status:200,headers:{'content-type':'text/html'}})}}

test('Supanote is an enabled no-account publisher after independent controller acceptance',()=>{
  const value=channel();assert.equal(value.enabled,true);assert.equal(value.accountRequired,false);assert.equal(value.automation,'api');assert.equal(value.evidenceStatus,'source_checked');assert.ok(publisherFor(value));
});

test('the wrapper enforces the backup-compatible reviewed Markdown boundary',()=>{
  assert.equal(supanoteDraftError(draft),undefined);
  assert.match(supanoteDraftError({...draft,title:' changed '})??'',/1–200/);
  assert.match(supanoteDraftError({...draft,body:'x'.repeat(30_001)})??'',/30,000/);
});

test('an existing no-ID intent is terminal and performs no network request',async()=>{
  let requests=0;
  const saved=task({status:'review',submittedAt:stamp,checkpoint:'supanote_publish_submitting',health:'pending',supanote:{operationId:'supanote_11111111111141118111111111111111',contentHash:'a'.repeat(64),createdAt:stamp,stage:'submitting'}});
  const result=await runSupanoteTask(context(saved,{persistIntent:async()=>{throw Error('must not claim')},persistReceipt:async()=>{},persistManageToken:async()=>{}}),{fetch:async()=>{requests++;throw Error('must not fetch')}});
  assert.equal(result.status,'review');assert.equal(requests,0);assert.match(result.message,/不会重发|不会重发|停止自动请求/);
});

test('a matching API readback without matching public HTML never becomes public-page proof',async()=>{
  const contentHash=supanoteTesting.hash(draft.title,draft.body);
  const saved=task({status:'review',submittedAt:stamp,checkpoint:'supanote_api_receipt',health:'pending',publicUrl,supanote:{operationId:'supanote_11111111111141118111111111111111',contentHash,createdAt:stamp,stage:'api_receipt',publicId}});
  const requests:string[]=[];
  assert.deepEqual(await reconcileSupanoteTask(context(saved),{fetch:apiTransport(requests,publicHtml({body:'Truncated public body'}))}),{status:'unknown'});
  const verified=await verifySupanotePublication(saved,site().url,{fetch:apiTransport(requests,publicHtml({body:'Truncated public body'}))});
  assert.equal(verified.found,false);assert.equal(verified.outcome,'invalid');assert.match(verified.reason,/公开页/);assert.equal(requests.length,6);
});

test('the measured rendered container proves the exact title, full Markdown, links, rel, robots, and canonical',async()=>{
  const contentHash=supanoteTesting.hash(draft.title,draft.body),saved=task({status:'review',submittedAt:stamp,checkpoint:'supanote_api_receipt',health:'pending',publicUrl,supanote:{operationId:'supanote_11111111111141118111111111111111',contentHash,createdAt:stamp,stage:'api_receipt',publicId}}),requests:string[]=[];
  const verified=await verifySupanotePublication(saved,site().url,{fetch:apiTransport(requests)});
  assert.equal(verified.found,true);assert.equal(verified.outcome,'found');assert.equal(verified.url,publicUrl);assert.equal(verified.rel,'ugc nofollow noopener noreferrer');assert.equal(requests.length,3);
  const recovered=await reconcileSupanoteTask(context(saved),{fetch:apiTransport(requests)});assert.equal(recovered.status,'found');if(recovered.status==='found')assert.equal(recovered.supanote.stage,'published');
});

test('robots.txt must allow the exact public path before visible evidence counts',async()=>{
  const contentHash=supanoteTesting.hash(draft.title,draft.body),saved=task({status:'review',submittedAt:stamp,checkpoint:'supanote_api_receipt',health:'pending',publicUrl,supanote:{operationId:'supanote_11111111111141118111111111111111',contentHash,createdAt:stamp,stage:'api_receipt',publicId}}),requests:string[]=[];
  const result=await verifySupanotePublication(saved,site().url,{fetch:apiTransport(requests,publicHtml(),'User-agent: *\nDisallow: /n/')});
  assert.equal(result.found,false);assert.equal(result.outcome,'invalid');assert.deepEqual(requests.map(value=>value.split(':').slice(1).join(':')),[`https://supanote.app/api/v1/notes/${publicId}`,'https://supanote.app/robots.txt']);
});

test('public verification fails closed for every measured page invariant',async t=>{
  const contentHash=supanoteTesting.hash(draft.title,draft.body),saved=task({status:'review',submittedAt:stamp,checkpoint:'supanote_api_receipt',health:'pending',publicUrl,supanote:{operationId:'supanote_11111111111141118111111111111111',contentHash,createdAt:stamp,stage:'api_receipt',publicId}});
  const cases:[string,string][]=[['wrong title',publicHtml({title:'Other title'})],['truncated body',publicHtml({body:'Only one paragraph.'})],['missing link',publicHtml({body:draft.body.replace('[source](https://example.test/guide)','source')})],['wrong canonical',publicHtml({canonical:'https://supanote.app/n/other'})],['noindex',publicHtml({robots:'noindex,follow'})],['hidden rendered tab',publicHtml({root:' hidden'})],['missing rel',publicHtml({rel:'noopener noreferrer'})]];
  for(const [name,html] of cases)await t.test(name,async()=>{const result=await verifySupanotePublication(saved,site().url,{fetch:apiTransport([],html)});assert.equal(result.found,false);assert.equal(result.outcome,'invalid')});
});
