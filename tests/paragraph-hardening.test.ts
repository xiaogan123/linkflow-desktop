import test from 'node:test';
import assert from 'node:assert/strict';
import {validateParagraphApiKey, verifyParagraphPublication, paragraphTesting, runParagraphTask} from '../src/integrations/paragraph';
import {Store} from '../src/main/store';
import {Controller} from '../src/main/controller';
import type {Vault} from '../src/main/vault';
import type {ExecutionContext,Site,Task} from '../src/shared/types';

const stamp='2026-10-07T00:00:00Z';
const publication={id:'PublicationFixture0001',name:'Fixture Publication',ownerUserId:'OwnerFixture000000001',slug:'fixture-publication'};
const target='https://example.com/guides/verification';
const publicationUrl='https://paragraph.com/@fixture-publication/';
const body=`This useful original editorial explains how to verify evidence using a repeatable process, recording source dates and observable limits. It contains careful instructions and the operator relationship disclosure. See the [source](${target}) for additional details.\n\nThe second half contains the material commercial relationship disclosure and important operational limitations. The author operates this website and receives referral commissions. The detailed process distinguishes facts from assumptions, reviews the full public sources, and preserves dated observations.`;
const site:Site={id:'11111111-1111-4111-8111-111111111111',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Original editorial notes',category:'content',language:'en',monthlyTarget:1,articleReviewMode:'manual',status:'ready',createdAt:stamp,paragraph:{publicationId:publication.id,url:publicationUrl}};
const task:Task={id:'22222222-2222-4222-8222-222222222222',siteId:site.id,channelId:'paragraph',accountId:'33333333-3333-4333-8333-333333333333',sourceDomain:'paragraph.com',status:'queued',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'',topicUrl:target,draft:{title:'Original editorial',description:'Complete verification guide',body},articleApprovedAt:stamp};
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})}

// Observation test: the current verifier returns found despite the public HTML
// having neither the reviewed article body nor any of its commercial disclosure.
test('regression: public HTML missing complete body and disclosure is accepted',async()=>{
 const approved=paragraphTesting.approvedArticle(task,site,false),input=structuredClone(task);
 input.paragraph={publicationId:publication.id,slug:approved.slug,contentHash:approved.contentHash,stage:'published',postId:'PostFixture00000001'};
 input.publicUrl=`${publicationUrl}${approved.slug}`;
 const result=await verifyParagraphPublication(input,site.url,undefined,{fetch:async(url,init)=>{
  assert.equal(init.method,'GET');
  if(url===`https://public.api.paragraph.com/api/v1/publications/${publication.id}`)return json(publication);
  if(url.startsWith('https://public.api.paragraph.com/api/v1/publications/'))return json({id:input.paragraph!.postId,title:approved.title,subtitle:approved.subtitle,slug:approved.slug,markdown:approved.markdown,publishOnline:true,authorIds:[publication.ownerUserId],authors:[{id:publication.ownerUserId,publicationId:publication.id}],staticHtml:`<a href="${target}">source</a>`});
  return new Response(`<html><body><h1>Subscribe to read</h1><footer><a href="${target}">source</a></footer></body></html>`,{headers:{'content-type':'text/html'}});
 }});
 assert.equal(result.found,false);
});

test('regression: headers end the timeout and detach cancellation while body is stalled',async()=>{
 const abort=new AbortController();let requestSignal:AbortSignal|undefined,stream:ReadableStreamDefaultController<Uint8Array>|undefined;
 const pending=validateParagraphApiKey('synthetic-fixture-key',{timeoutMs:100,signal:abort.signal,fetch:async(_url,init)=>{requestSignal=init.signal as AbortSignal;return new Response(new ReadableStream<Uint8Array>({start(controller){stream=controller;controller.enqueue(new TextEncoder().encode('{'));}}),{headers:{'content-type':'application/json'}})}});
 await new Promise(resolve=>setTimeout(resolve,20));abort.abort();
 const outcome=await Promise.race([pending.then(()=> 'resolved',()=> 'rejected'),new Promise<string>(resolve=>setTimeout(()=>resolve('still-pending-after-250ms'),250))]);
 const internalAborted=requestSignal?.aborted;
 try{stream!.error(new Error('synthetic cleanup'))}catch{};await pending.catch(()=>undefined);
 assert.equal(outcome,'rejected');assert.equal(internalAborted,true);
});

test('regression: auth failure cannot persist credentials_invalid through Controller context',async()=>{
 const store=new Store(':memory:');
 const credential=JSON.stringify({version:1,apiKey:'synthetic-fixture-key',publicationId:publication.id,ownerUserId:publication.ownerUserId,publicationSlug:publication.slug});
 const vault={ready:true,available:()=>true,get:async()=>credential,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})} as unknown as Vault;
 store.update(state=>{state.settings.autoRun=true;state.sites=[structuredClone(site)];state.tasks=[structuredClone(task)];state.accounts=[{id:task.accountId!,channelId:'paragraph',email:'',username:publication.id,displayName:publication.name,publicationUrl,credentialKind:'api_token',status:'registered',hasPassword:true,createdAt:stamp}];state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId:site.id,channelId:'paragraph',accountId:task.accountId!,createdAt:stamp,updatedAt:stamp}]});
 try{
  const controller=new Controller(store,vault,'synthetic-audit');store.update(state=>state.tasks[0].status='running');
  const context=(controller as unknown as {context(task:Task,signal:AbortSignal):ExecutionContext}).context(store.read().tasks[0],new AbortController().signal);
  let thrown='';try{await runParagraphTask(context,{fetch:async()=>json({},401)})}catch(error){thrown=String(error)}
  assert.equal(thrown,'');
  assert.equal(store.read().accounts[0].status,'credentials_invalid');assert.equal(store.read().accounts[0].diagnostic?.code,'bad_password');
 }finally{store.close()}
});

test('regression: remote draft manual approval survives material site changes and authorizes PUT',async()=>{
 const {applySiteUpdate}=await import('../src/main/site-service');
 const store=new Store(':memory:');
 const credential=JSON.stringify({version:1,apiKey:'synthetic-fixture-key',publicationId:publication.id,ownerUserId:publication.ownerUserId,publicationSlug:publication.slug});
 const vault={ready:true,available:()=>true,get:async()=>credential,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})} as unknown as Vault;
 const approved=paragraphTesting.approvedArticle(task,site,false),pending=structuredClone(task);
 pending.submittedAt=stamp;pending.checkpoint='article_review';pending.paragraph={publicationId:publication.id,slug:approved.slug,contentHash:approved.contentHash,stage:'draft',postId:'PostFixture00000001'};
 store.update(state=>{state.settings.autoRun=true;state.sites=[structuredClone(site)];state.tasks=[pending];state.accounts=[{id:task.accountId!,channelId:'paragraph',email:'',username:publication.id,displayName:publication.name,publicationUrl,credentialKind:'api_token',status:'registered',hasPassword:true,createdAt:stamp}];state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId:site.id,channelId:'paragraph',accountId:task.accountId!,createdAt:stamp,updatedAt:stamp}]});
 try{
  const controller=new Controller(store,vault,'synthetic-audit');
  store.update(state=>applySiteUpdate(state,{id:site.id,name:'Changed operator and publication context',description:'Our primary purpose is referral commissions from third-party affiliate offers',category:'finance'},new Date(stamp)));
  const retained=store.read().tasks[0].articleApprovedAt;
  store.update(state=>state.tasks[0].status='running');
  const context=(controller as unknown as {context(task:Task,signal:AbortSignal):ExecutionContext}).context(store.read().tasks[0],new AbortController().signal);
  let posts=0,puts=0;
  await runParagraphTask(context,{fetch:async(url,init)=>{
   if(url.endsWith('/v1/me'))return json(publication);
   if(init.method==='POST'){posts++;throw Error('unexpected POST')}
   if(init.method==='PUT'){puts++;return json({success:true})}
   return json({id:pending.paragraph!.postId,title:approved.title,subtitle:approved.subtitle,slug:approved.slug,markdown:approved.markdown,status:'draft',publishOnline:false,authorIds:[publication.ownerUserId],authors:[{id:publication.ownerUserId,publicationId:publication.id}]});
  }});
  assert.equal(retained,undefined);assert.equal(posts,0);assert.equal(puts,0);
 }finally{store.close()}
});
