import assert from 'node:assert/strict';
import test from 'node:test';
import {bindReadOnly,probeShipStaticAccount,
  readShipStaticDeployment,runShipStaticTask,shipStaticDocument,verifyShipStaticPublic,type ShipStaticRequest} from '../src/integrations/shipstatic';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {defaultSettings} from '../src/main/store';
import type {Batch5DomainStage,Batch5Intent,Batch5OpaqueResponse,Batch5Persistence,Batch5Receipt} from '../src/integrations/batch5-contract';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const key=`ship-${'a'.repeat(32)}`;
const remote='calm-bird-abc1234.shipstatic.com';
const domain='reviewed-software-guide.shipstatic.com';
const target='https://example.com/software-guide';
const html=`<!doctype html><html><head><title>Guide</title></head><body><main><p>A real software guide.</p><a href="${target}">Original project guide</a></main></body></html>`;
const document=shipStaticDocument(html,target);
const input:ShipStaticRequest={key,domain,document,operationId:'8bf1278e-6e67-46b7-90e4-bc829ee8924e'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const remoteValue={deployment:remote,url:`https://${remote}`,status:'success',password:false,files:2,size:html.length,created:'2026-10-30T00:00:00Z'};
const domainValue={domain,url:`https://${domain}`,deployment:remote,status:'live',verification:'verified',paused:null};

test('ShipStatic uses Free account readback and refuses ambiguous capacity',async()=>{
  const account={email:'owner@example.com',plan:'free',usage:{platformDomains:0,deployments:1},caps:{platformDomains:1,deployments:100}};
  const fetcher=async(url:string)=>{assert.equal(url,'https://api.shipstatic.com/account');return json(account)};
  assert.deepEqual(await probeShipStaticAccount(key,{fetch:fetcher}),{email:'owner@example.com',remainingDomains:1,remainingDeployments:99});
  await assert.rejects(probeShipStaticAccount(key,{fetch:async()=>json({...account,plan:'pro'})}),/free_account_unproven/);
  await assert.rejects(probeShipStaticAccount(key,{fetch:async()=>json({...account,caps:{platformDomains:1}})}),/free_account_unproven/);
});

test('ShipStatic exact remote readback rejects anonymous expiring deployment',async()=>{
  const result=await readShipStaticDeployment(key,remote,{fetch:async(url,init)=>{
    assert.equal(url,`https://api.shipstatic.com/deployments/${remote}`);assert.equal(init.method,'GET');return json(remoteValue);
  }});
  assert.equal(result.deployment,remote);
  await assert.rejects(readShipStaticDeployment(key,remote,{fetch:async()=>json({...remoteValue,claim:'secret'})}),/deployment_invalid/);
});

test('ShipStatic public acceptance uses named domain and native source link, not preview URL',async()=>{
  const calls:string[]=[];
  const deps={fetch:async(url:string)=>{
    calls.push(url);
    if(url===`https://api.shipstatic.com/domains/${domain}`)return json(domainValue);
    if(url===`https://${domain}/`)return new Response(html,{status:200,headers:{'content-type':'text/html'}});
    if(url===`https://${domain}/robots.txt`)return new Response('User-agent: *\nAllow: /\n',{status:200});
    throw Error(`unexpected ${url}`);
  }};
  assert.equal((await bindReadOnly(key,domain,remote,deps))?.status,'live');
  assert.equal(await verifyShipStaticPublic(input,remote,deps),true);
  assert.ok(!calls.some(value=>value.includes(remote)&&value.startsWith('https://')));
  assert.equal(await verifyShipStaticPublic(input,remote,{fetch:async(url)=>{
    if(url===`https://api.shipstatic.com/domains/${domain}`)return json(domainValue);
    if(url===`https://${domain}/`)return new Response(html,{status:200,headers:{'content-type':'text/html','x-robots-tag':'googlebot: none'}});
    throw Error('robots must not be checked');
  }}),false);
});

test('ShipStatic document requires a single exact native target link',()=>{
  assert.throws(()=>shipStaticDocument(html.replace('</main>',`<a href="${target}">again</a></main>`),target),/target_count/);
  assert.throws(()=>shipStaticDocument(html.replace('<head>','<head><meta name="robots" content="noindex">'),target),/noindex_document/);
});

function runFixture(){
  const at='2026-10-30T10:00:00.000Z';
  const site:Site={id:'22222222-2222-4222-8222-222222222222',domain:'example.com',url:'https://example.com/',email:'',name:'Example',description:'Software guide',language:'en',category:'software',monthlyTarget:1,status:'ready',createdAt:at};
  const channel:Channel={id:'shipstatic',name:'ShipStatic',domain:'shipstatic.com',url:'https://shipstatic.com/',submitUrl:'https://api.shipstatic.com/deployments',categories:['software'],languages:['*'],kind:'article',emailRequired:false,accountRequired:true,articleRequired:true,free:'yes',freeNote:'',automation:'api',quality:'C',qualityReason:'',rulesUrl:'https://www.shipstatic.com/terms',checkedAt:at,notes:'',allowedHosts:['shipstatic.com'],enabled:true};
  const account:Account={id:'account-1',channelId:'shipstatic',username:'writer@example.com',email:'writer@example.com',publicationUrl:`https://${domain}/`,ownerSiteId:site.id,status:'registered',hasPassword:true,credentialKind:'api_token',createdAt:at};
  const settings={...defaultSettings(),articleReviewMode:'ai' as const};
  const task:Task={id:'task-1',siteId:site.id,channelId:'shipstatic',accountId:account.id,sourceDomain:'shipstatic.com',status:'running',createdAt:at,updatedAt:at,scheduledAt:at,attempts:1,message:'',topicUrl:target,draftRevision:1,
    draft:{title:'Software release guide',description:'How to verify a software release.',body:`This guide explains how to reproduce the configuration and compare release notes. Read the [original guide](${target}) for maintained instructions.\n\nIt also covers practical limitations and troubleshooting steps.`}};
  task.articleReview={status:'passed',reason:'passed',draftRevision:1,contentHash:articleContentHash(task),contextHash:articleContextHash(site,channel,settings,account,4),evidenceUrls:[],reviewContractVersion:4};
  class Journal implements Batch5Persistence{
    intent?:Batch5Intent;opaque?:Batch5OpaqueResponse;receipt?:Batch5Receipt;domainStage?:Batch5DomainStage;domainOpaque?:Batch5OpaqueResponse;domainReceipt?:Batch5Receipt;blockAt?:'post'|'put';
    async saveIntent(v:Batch5Intent){this.intent=v}async reserveIntent(v:Batch5Intent){this.intent=v}async markSending(){if(this.blockAt==='post')throw Error('revoked')}
    async loadIntent(){return this.intent}async assertReadyToSubmit(){if(this.blockAt==='post')throw Error('revoked')}
    async saveReceipt(v:Batch5Receipt){this.receipt=v}async loadReceipt(){return this.receipt}async saveOpaqueResponse(v:Batch5OpaqueResponse){this.opaque=v}async loadOpaqueResponse(){return this.opaque}
    async markDomainSending(v:Batch5DomainStage){this.domainStage=v}async assertReadyToBind(){if(this.blockAt==='put')throw Error('revoked')}
    async saveDomainOpaqueResponse(v:Batch5OpaqueResponse){this.domainOpaque=v}async loadDomainOpaqueResponse(){return this.domainOpaque}
    async saveDomainReceipt(v:Batch5Receipt){this.domainReceipt=v}async loadDomainReceipt(){return this.domainReceipt}async loadDomainStage(){return this.domainStage}
    currentTaskState(){return task.batch5}
  }
  const journal=new Journal(),secrets=new Map([[`account:${account.id}`,JSON.stringify({version:1,apiKey:key,email:account.email,domain})]]);
  const context:ExecutionContext={site,channel,task,settings,signal:new AbortController().signal,ai:{json:async<T>()=>({} as T)},
    secrets:{get:async k=>secrets.get(k),set:async()=>undefined,delete:async()=>undefined},getAccount:()=>account,saveAccount:async()=>undefined,
    checkpoint:partial=>{Object.assign(task,partial)},log:()=>undefined,batch5Persistence:journal};
  return {context,journal};
}
test('ShipStatic permission changes before either write result in zero writes',async()=>{
  for(const phase of ['post','put'] as const){const f=runFixture();f.journal.blockAt=phase;let posts=0,puts=0;
    f.context.batch5Dependencies={fetch:async(url,init)=>{
      if(url.endsWith('/account'))return json({email:'writer@example.com',plan:'free',usage:{platformDomains:0,deployments:0},caps:{platformDomains:1,deployments:100}});
      if(url.endsWith(`/domains/${domain}`)&&init.method==='GET')return json({error:'not_found'},404);
      if(url.endsWith('/deployments')&&init.method==='POST'){posts++;return json(remoteValue,201)}
      if(url.endsWith(`/deployments/${remote}`))return json(remoteValue);
      if(init.method==='PUT')puts++;
      throw Error(`unexpected ${url}`);
    }};
    const result=await runShipStaticTask(f.context);assert.equal(result.reasonCode,'submission_unknown');
    assert.equal(posts,phase==='post'?0:1);assert.equal(puts,0);
    assert.equal((await runShipStaticTask(f.context)).reasonCode,'submission_unknown');assert.equal(puts,0);
  }
});
test('ShipStatic completes one deployment and one domain binding with exact public HTML',async()=>{
  const f=runFixture();let posts=0,puts=0,bound=false,publicHtml='';
  f.context.batch5Dependencies={fetch:async(url,init)=>{
    if(url.endsWith('/account'))return json({email:'writer@example.com',plan:'free',usage:{platformDomains:bound?1:0,deployments:posts},caps:{platformDomains:1,deployments:100}});
    if(url.endsWith(`/domains/${domain}`)&&init.method==='GET')return bound?json(domainValue):json({error:'not_found'},404);
    if(url.endsWith('/deployments')&&init.method==='POST'){posts++;assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${key}`);
      assert.equal(new Headers(init.headers).get('idempotency-key'),f.journal.intent?.operationId);
      const files=(init.body as FormData).getAll('files[]') as File[];assert.deepEqual(files.map(file=>file.name),['index.html','robots.txt']);
      publicHtml=await files[0].text();assert.equal(await files[1].text(),'User-agent: *\nAllow: /\n');return json(remoteValue,201)}
    if(url.endsWith(`/deployments/${remote}`))return json(remoteValue);
    if(url.endsWith(`/domains/${domain}`)&&init.method==='PUT'){puts++;bound=true;return json(domainValue,201)}
    if(url===`https://${domain}/`)return new Response(publicHtml,{headers:{'content-type':'text/html'}});
    if(url===`https://${domain}/robots.txt`)return new Response('User-agent: *\nAllow: /\n');
    throw Error(`unexpected ${url}`);
  }};
  const result=await runShipStaticTask(f.context);assert.equal(result.status,'review');assert.equal(result.publicUrl,`https://${domain}/`);
  assert.equal(posts,1);assert.equal(puts,1);assert.ok(f.journal.opaque?.bodyBase64);assert.ok(f.journal.domainOpaque?.bodyBase64);
  assert.equal((publicHtml.match(/href="https:\/\/example.com\/software-guide"/g)??[]).length,1);
  assert.equal((await runShipStaticTask(f.context)).status,'review');assert.equal(posts,1);assert.equal(puts,1);
});
test('ShipStatic lost POST or PUT outcome is GET only on restart',async()=>{
  for(const lost of ['post','put'] as const){const f=runFixture();let posts=0,puts=0;
    f.context.batch5Dependencies={fetch:async(url,init)=>{
      if(url.endsWith('/account'))return json({email:'writer@example.com',plan:'free',usage:{platformDomains:0,deployments:0},caps:{platformDomains:1,deployments:100}});
      if(url.endsWith(`/domains/${domain}`)&&init.method==='GET')return json({error:'not_found'},404);
      if(url.endsWith('/deployments')&&init.method==='POST'){posts++;if(lost==='post')throw Error('response lost');return json(remoteValue,201)}
      if(url.endsWith(`/deployments/${remote}`))return json(remoteValue);
      if(url.endsWith(`/domains/${domain}`)&&init.method==='PUT'){puts++;throw Error('response lost')}
      throw Error(`unexpected ${url}`);
    }};
    assert.equal((await runShipStaticTask(f.context)).reasonCode,'submission_unknown');
    assert.equal((await runShipStaticTask(f.context)).reasonCode,'submission_unknown');
    assert.equal(posts,1);assert.equal(puts,lost==='put'?1:0);
  }
});
