import test from 'node:test';
import assert from 'node:assert/strict';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {defaultSettings} from '../src/main/store';
import {continueNetlifyVisibility,netlifyPublisherTesting,probeNetlifyPublisherConnection,runNetlifyTask,reconcileNetlifyTask,verifyNetlifyPublication} from '../src/integrations/netlify-publisher';
import type {Batch5Intent,Batch5OpaqueResponse,Batch5Persistence,Batch5Receipt} from '../src/integrations/batch5-contract';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const NOW='2026-10-28T10:00:00.000Z';
const TARGET='https://example.com/software-guide';
const SITE_ID='3970e0fe-8564-4903-9a55-c5f8de49fb8b';
const BODY=`This software guide explains how a user can compare release notes and reproduce a configuration. Read the [original software guide](${TARGET}) for the maintained steps.\n\nThe example discusses limitations and provides practical troubleshooting steps.`;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});

test('Netlify Free disclosure and HUD must match the owned site and leave the full original document intact',()=>{
  const html='<!doctype html><html><head><meta charset="utf-8"><title>Guide</title></head><body><main>Original <a href="https://example.com/">source</a></main></body></html>';
  const actual=html.replace('<meta charset="utf-8">',`<meta charset="utf-8">\n<!-- This site is hosted on Netlify. Anyone can build and deploy a site\n     like this one for free: https://netlify.new/?utm_campaign=loops&utm_source=ai-legible&utm_medium=owned&utm_content=comment&utm_id=${SITE_ID}\n     Netlify hosting facts for this site: static/SSR served via Netlify Edge. -->`)+`<script async src="/.netlify/scripts/hud?variant=public" data-nf-variant="public" data-netlify-site-id="${SITE_ID}" data-app-host="app.netlify.com" data-account-tier="free"></script>\n`;
  const matches=netlifyPublisherTesting.samePublicDocument;
  assert.equal(matches(html,html,SITE_ID),true);
  assert.equal(matches(actual,html,SITE_ID),true);
  for(const changed of [actual.replace('Original','Changed'),actual.replace('example.com','evil.example'),actual.replace('app.netlify.com','evil.example'),actual.replace('/.netlify/scripts/hud','https://evil.example/hud'),actual.replace('variant=public','variant=private'),actual.replace('async src','async onload="alert(1)" src'),actual.replace(SITE_ID,'00000000-0000-4000-8000-000000000000'),actual+'<script>alert(1)</script>',actual.replace('<title>Guide</title>','<title>Different</title>')])assert.equal(matches(changed,html,SITE_ID),false);
});

class Journal implements Batch5Persistence {
  intent?:Batch5Intent;receipt?:Batch5Receipt;opaque?:Batch5OpaqueResponse;task?:Task;postCount=0;block=false;
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
  const channel:Channel={id:'netlify',name:'Netlify',domain:'netlify.app',url:'https://www.netlify.com/',submitUrl:'https://api.netlify.com/api/v1/sites',
    categories:['software'],languages:['*'],kind:'article',emailRequired:false,accountRequired:true,articleRequired:true,free:'yes',freeNote:'',
    automation:'api',quality:'C',qualityReason:'',rulesUrl:'https://www.netlify.com/legal/acceptable-use-policy/',checkedAt:NOW,notes:'',allowedHosts:['netlify.app'],enabled:true};
  const account:Account={id:'account-1',channelId:'netlify',username:'user-123',email:'',status:'registered',hasPassword:true,
    credentialKind:'api_token',createdAt:NOW};
  const settings={...defaultSettings(),articleReviewMode:'ai' as const};
  const task:Task={id:'task-1',siteId:site.id,channelId:'netlify',accountId:account.id,sourceDomain:channel.domain,status:'running',
    createdAt:NOW,scheduledAt:NOW,updatedAt:NOW,attempts:1,message:'',topicUrl:TARGET,draftRevision:1,
    draft:{title:'How to verify a software release',description:'A practical software documentation guide.',body:BODY}};
  task.articleReview={status:'passed',reason:'passed',draftRevision:1,contentHash:articleContentHash(task),
    contextHash:articleContextHash(site,channel,settings,account,4),evidenceUrls:[],reviewContractVersion:4};
  const journal=new Journal();journal.task=task;
  const secrets=new Map([[`account:${account.id}`,JSON.stringify({version:1,accessToken:'netlify-token-123456',userId:account.username})]]);
  const context:ExecutionContext={site,channel,task,settings,signal:new AbortController().signal,ai:{json:async<T>()=>({} as T)},
    secrets:{get:async key=>secrets.get(key),set:async(key,value)=>{secrets.set(key,value)},delete:async key=>{secrets.delete(key)}},
    getAccount:()=>account,saveAccount:async()=>undefined,checkpoint:partial=>{Object.assign(task,partial)},log:()=>undefined,batch5Persistence:journal};
  return {context,journal,task};
}

test('Netlify Free identity is checked before the single ZIP create and publication is read back',async()=>{
  const f=fixture();let postedZip:Buffer|undefined,publicHtml='',creates=0;
  f.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
    if(url.endsWith('/user'))return json({id:'user-123',full_name:'Example Owner'});
    if(url.endsWith('/accounts'))return json([{id:'team-123',type_name:'Free',has_stripe_payment_method:false,auto_topup_enabled:false,payment_method_id:null,owner_ids:['user-123']}]);
    if(url.endsWith('/sites')&&init.method==='POST'){
      creates++;assert.equal(f.task.batch5?.stage,'submitting');assert.ok(f.journal.intent);assert.equal(init.headers&&new Headers(init.headers).get('content-type'),'application/zip');
      postedZip=Buffer.from(init.body as Uint8Array);assert.equal(postedZip.readUInt32LE(0),0x04034b50);
      const nameLength=postedZip.readUInt16LE(26);assert.equal(postedZip.subarray(30,30+nameLength).toString(),'index.html');
      const fileSize=postedZip.readUInt32LE(18);publicHtml=postedZip.subarray(30+nameLength,30+nameLength+fileSize).toString();
      return json({id:SITE_ID,name:'reviewed-guide',account_id:'team-123',ssl_url:'https://reviewed-guide.netlify.app'},201);
    }
    if(url.endsWith(`/sites/${SITE_ID}`))return json({id:SITE_ID,name:'reviewed-guide',account_id:'team-123',ssl_url:'https://reviewed-guide.netlify.app'});
    if(url==='https://reviewed-guide.netlify.app/')return new Response(publicHtml,{status:200,headers:{'content-type':'text/html'}});
    if(url==='https://reviewed-guide.netlify.app/robots.txt')return new Response('User-agent: *\nAllow: /\n',{status:200});
    throw Error(`Unexpected ${url}`);
  }};
  const result=await runNetlifyTask(f.context);assert.equal(result.status,'review');assert.equal(creates,1);
  assert.ok(f.journal.opaque?.bodyBase64);assert.equal(f.journal.receipt?.remoteId,SITE_ID);
  assert.equal((publicHtml.match(/href="https:\/\/example.com\/software-guide"/g)??[]).length,1);
  assert.equal(publicHtml.includes(f.journal.intent!.operationId),false);
  assert.equal(publicHtml.includes(f.task.id),false);
  assert.equal(publicHtml.includes('linkflow-operation'),false);
  const verified=await verifyNetlifyPublication(f.context);assert.equal(verified.found,true);assert.equal(verified.indexable,true);
  const again=await runNetlifyTask(f.context);assert.equal(again.status,'review');assert.equal(creates,1);
  // Expired/revoked review blocks a new submission, not GET reconciliation of the frozen receipt.
  f.task.articleReview=undefined;
  assert.equal((await reconcileNetlifyTask(f.context)).status,'found');
  assert.equal((await runNetlifyTask(f.context)).status,'review');assert.equal(creates,1);
  f.task.draft!.body+='\nChanged after publication';
  assert.equal((await reconcileNetlifyTask(f.context)).status,'unknown');assert.equal(creates,1);
});

test('Netlify refuses a new submission without current independent review',async()=>{
  const f=fixture();f.task.articleReview=undefined;let posts=0;
  f.context.batch5Dependencies={fetch:async(url,init)=>{
    if(init.method==='POST'){posts++;throw Error('Unexpected publication')}
    if(url.endsWith('/user'))return json({id:'user-123'});
    if(url.endsWith('/accounts'))return json([{id:'team-123',type_name:'Free',has_stripe_payment_method:false,auto_topup_enabled:false,owner_ids:['user-123']}]);
    throw Error('Unexpected request');
  }};
  assert.equal((await runNetlifyTask(f.context)).reasonCode,'format_invalid');
  assert.equal(posts,0);assert.equal(f.journal.intent,undefined);
});

test('Netlify unknown create outcome never retries POST or claims a matching unrelated site',async()=>{
  const f=fixture();let creates=0;
  f.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
    if(url.endsWith('/user'))return json({id:'user-123'});
    if(url.endsWith('/accounts'))return json([{id:'team-123',type_name:'Free',has_stripe_payment_method:false,auto_topup_enabled:false,owner_ids:['user-123']}]);
    if(url.endsWith('/sites')&&init.method==='POST'){creates++;throw Error('lost response')}
    if(url.includes('/sites?page='))throw Error('site scan must not occur');
    throw Error(`Unexpected ${url}`);
  }};
  assert.equal((await runNetlifyTask(f.context)).reasonCode,'submission_unknown');
  assert.equal((await runNetlifyTask(f.context)).reasonCode,'submission_unknown');
  assert.equal(creates,1);
});

test('Netlify lost create response stays unknown even if an identical site exists',async()=>{
  const f=fixture();let creates=0,publicHtml='';
  f.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
    if(url.endsWith('/user'))return json({id:'user-123'});
    if(url.endsWith('/accounts'))return json([{id:'team-123',type_name:'Free',has_stripe_payment_method:false,auto_topup_enabled:false,owner_ids:['user-123']}]);
    if(url.endsWith('/sites')&&init.method==='POST'){
      creates++;const archive=Buffer.from(init.body as Uint8Array),start=30+archive.readUInt16LE(26),length=archive.readUInt32LE(18);
      publicHtml=archive.subarray(start,start+length).toString();throw Error('response lost after create');
    }
    if(url.includes('/sites?page='))throw Error('site scan must not occur');
    throw Error(`Unexpected ${url}`);
  }};
  assert.equal((await runNetlifyTask(f.context)).reasonCode,'submission_unknown');
  const recovered=await reconcileNetlifyTask(f.context);assert.equal(recovered.status,'unknown');
  assert.equal(f.journal.receipt,undefined);assert.equal(creates,1);assert.ok(publicHtml.includes('software guide'));
});

test('Netlify exact saved opaque 201 response can recover by GET without a second POST',async()=>{
  const f=fixture();let creates=0,publicHtml='';
  const saveReceipt=f.journal.saveReceipt.bind(f.journal);f.journal.saveReceipt=async()=>{throw Error('journal unavailable')};
  f.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
    if(url.endsWith('/user'))return json({id:'user-123'});
    if(url.endsWith('/accounts'))return json([{id:'team-123',type_name:'Free',has_stripe_payment_method:false,auto_topup_enabled:false,owner_ids:['user-123']}]);
    if(url.endsWith('/sites')&&init.method==='POST'){
      creates++;const archive=Buffer.from(init.body as Uint8Array),start=30+archive.readUInt16LE(26),length=archive.readUInt32LE(18);
      publicHtml=archive.subarray(start,start+length).toString();
      return json({id:SITE_ID,name:'reviewed-guide',account_id:'team-123',ssl_url:'https://reviewed-guide.netlify.app'},201);
    }
    if(url.endsWith(`/sites/${SITE_ID}`))return json({id:SITE_ID,name:'reviewed-guide',account_id:'team-123'});
    if(url==='https://reviewed-guide.netlify.app/')return new Response(publicHtml,{status:200,headers:{'content-type':'text/html'}});
    if(url==='https://reviewed-guide.netlify.app/robots.txt')return new Response('User-agent: *\nAllow: /\n',{status:200});
    if(url.includes('/sites?page='))throw Error('site scan must not occur');
    throw Error(`Unexpected ${url}`);
  }};
  assert.equal((await runNetlifyTask(f.context)).reasonCode,'submission_unknown');
  f.journal.saveReceipt=saveReceipt;
  assert.equal((await reconcileNetlifyTask(f.context)).status,'found');
  assert.equal(f.journal.receipt?.remoteId,SITE_ID);assert.equal(creates,1);
});

test('Netlify public readback rejects text/plain and scoped or unscoped robots blocks',async()=>{
  for(const variant of ['plain','none','googlebot:none','googlebot:noindex','bingbot:noindex'] as const){
    const f=fixture();let publicHtml='';
    f.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
      if(url.endsWith('/user'))return json({id:'user-123'});
      if(url.endsWith('/accounts'))return json([{id:'team-123',type_name:'Free',has_stripe_payment_method:false,auto_topup_enabled:false,owner_ids:['user-123']}]);
      if(url.endsWith('/sites')&&init.method==='POST'){
        const archive=Buffer.from(init.body as Uint8Array),start=30+archive.readUInt16LE(26),length=archive.readUInt32LE(18);
        publicHtml=archive.subarray(start,start+length).toString();
        return json({id:SITE_ID,name:'reviewed-guide',account_id:'team-123'},201);
      }
      if(url.endsWith(`/sites/${SITE_ID}`))return json({id:SITE_ID,name:'reviewed-guide',account_id:'team-123'});
      if(url==='https://reviewed-guide.netlify.app/')return new Response(publicHtml,{status:200,
        headers:{'content-type':variant==='plain'?'text/plain':'text/html',...(variant==='plain'?{}:{'x-robots-tag':variant})}});
      if(url==='https://reviewed-guide.netlify.app/robots.txt')return new Response('User-agent: *\nAllow: /\n',{status:200});
      throw Error(`Unexpected ${url}`);
    }};
    assert.equal((await runNetlifyTask(f.context)).status,'review');
    assert.equal((await verifyNetlifyPublication(f.context)).found,false);
  }
});

test('Netlify rejects paid or ambiguous teams before creating a site',async()=>{
  const f=fixture();let creates=0;
  f.context.batch5Dependencies={fetch:async(url,init)=>{
    if(url.endsWith('/user'))return json({id:'user-123'});
    if(url.endsWith('/accounts'))return json([{id:'team-123',type_name:'Personal',owner_ids:['user-123']}]);
    if(init.method==='POST')creates++;
    throw Error(`Unexpected ${url}`);
  }};
  await assert.rejects(probeNetlifyPublisherConnection('netlify-token-123456',f.context.batch5Dependencies,f.context.signal),/free_team_unproven/);
  const result=await runNetlifyTask(f.context);assert.equal(result.status,'needs_input');assert.equal(creates,0);assert.equal(f.journal.intent,undefined);
});

test('Netlify requires explicit no-card and no-auto-top-up evidence before publication',async()=>{
  for(const billing of [
    {},{has_stripe_payment_method:false},{auto_topup_enabled:false},
    {has_stripe_payment_method:true,auto_topup_enabled:false},
    {has_stripe_payment_method:false,auto_topup_enabled:true},
    {has_stripe_payment_method:'false',auto_topup_enabled:false},
    {has_stripe_payment_method:false,auto_topup_enabled:false,payment_method_id:'paid-method'},
  ]){
    const f=fixture();let posts=0;
    f.context.batch5Dependencies={fetch:async(url,init)=>{
      if(init.method==='POST'){posts++;throw Error('Unexpected publication')}
      if(url.endsWith('/user'))return json({id:'user-123'});
      if(url.endsWith('/accounts'))return json([{id:'team-123',type_name:'Free',owner_ids:['user-123'],...billing}]);
      throw Error('Unexpected request');
    }};
    assert.equal((await runNetlifyTask(f.context)).status,'needs_input');
    assert.equal(posts,0);assert.equal(f.journal.intent,undefined);
  }
});

test('ZIP deployment receipt is reconciled only against its exact owned published deployment',async()=>{
 for(const bad of ['none','team','deployment','pending','body'] as const){
  const f=fixture();let creates=0,html='',allowDetails=false;
  f.context.batch5Dependencies={fetch:async(url,init)=>{
   if(url.endsWith('/user'))return json({id:'user-123'});
   if(url.endsWith('/accounts'))return json([{id:'team-123',type_name:'Free',has_stripe_payment_method:false,auto_topup_enabled:false,owner_ids:['user-123']}]);
   if(url.endsWith('/sites')&&init.method==='POST'){creates++;const z=Buffer.from(init.body as Uint8Array),start=30+z.readUInt16LE(26);html=z.subarray(start,start+z.readUInt32LE(18)).toString();return json({id:SITE_ID,deploy_id:'deploy_123',subdomain:'reviewed-guide',url:'http://reviewed-guide.netlify.app',state:'uploaded'},201)}
   if(url.endsWith(`/sites/${SITE_ID}`)){if(!allowDetails)return json({},503);return json({id:SITE_ID,name:'reviewed-guide',account_id:bad==='team'?'other-team':'team-123',ssl_url:'https://reviewed-guide.netlify.app',published_deploy:{id:bad==='deployment'?'deploy_other':'deploy_123',state:bad==='pending'?'building':'ready'}})}
   if(url==='https://reviewed-guide.netlify.app/')return new Response(bad==='body'?html.replace('This software guide','An altered guide'):html,{headers:{'content-type':'text/html'}});
   if(url.endsWith('/robots.txt'))return new Response('User-agent: *\nAllow: /\n');
   throw Error('Unexpected request');
  }};
  assert.equal((await runNetlifyTask(f.context)).reasonCode,'submission_unknown');allowDetails=true;
  assert.equal((await reconcileNetlifyTask(f.context)).status,bad==='none'?'found':'unknown',bad);assert.equal(creates,1);
 }
});

function privateSiteFixture(){
 const f=fixture();const state={creates:0,patches:0,private:true,losePatch:false,details:true,team:'team-123',deployment:'deploy_123',html:'',beforeDetails:()=>{}};
 f.context.batch5Dependencies={fetch:async(url,init)=>{
  if(url.endsWith('/user'))return json({id:'user-123'});
  if(url.endsWith('/accounts'))return json([{id:'team-123',type_name:'Free',has_stripe_payment_method:false,auto_topup_enabled:false,owner_ids:['user-123']}]);
  if(url.endsWith('/sites')&&init.method==='POST'){
   state.creates++;const z=Buffer.from(init.body as Uint8Array),start=30+z.readUInt16LE(26);state.html=z.subarray(start,start+z.readUInt32LE(18)).toString();
   return json({id:SITE_ID,deploy_id:'deploy_123',subdomain:'reviewed-guide'},201);
  }
  if(url.endsWith(`/sites/${SITE_ID}`)){
   if(init.method==='PATCH'){
    state.patches++;assert.deepEqual(JSON.parse(String(init.body)),{sso_login:false});
    if(state.losePatch)throw Error('unknown PATCH outcome');state.private=false;
   }else{assert.equal(init.method,'GET');state.beforeDetails()}
   if(!state.details)return json({},503);
   return json({id:SITE_ID,name:'reviewed-guide',account_id:state.team,sso_login:state.private,sso_login_context:'all',published_deploy:{id:state.deployment,state:'ready'}});
  }
  if(url==='https://reviewed-guide.netlify.app/')return new Response(state.html,{status:state.private?401:200,headers:{'content-type':'text/html'}});
  if(url.endsWith('/robots.txt'))return new Response('User-agent: *\nAllow: /\n');
  throw Error('Unexpected request');
 }};
 return {...f,state};
}

test('fresh ZIP create automatically exposes only its exact owned deployment once',async()=>{
 const f=privateSiteFixture();assert.equal((await runNetlifyTask(f.context)).status,'review');
 assert.equal(f.state.patches,1);assert.equal(f.state.creates,1);
 assert.equal((await verifyNetlifyPublication(f.context)).found,true);
 await runNetlifyTask(f.context);assert.equal(f.state.patches,1);assert.equal(f.state.creates,1);
});

test('fresh visibility PATCH rejects owner, deployment, draft, review and identity changes',async()=>{
 for(const changed of ['team','deployment','draft','review','identity'] as const){
  const f=privateSiteFixture();f.state.beforeDetails=()=>{
   if(changed==='team')f.state.team='another-team';
   if(changed==='deployment')f.state.deployment='another-deploy';
   if(changed==='draft')f.task.draft!.body+=' changed';
   if(changed==='review')f.task.articleReview=undefined;
   if(changed==='identity')f.context.getAccount()!.username='other-user';
  };
  assert.equal((await runNetlifyTask(f.context)).reasonCode,'submission_unknown',changed);assert.equal(f.state.patches,0,changed);
 }
});

test('unknown automatic visibility PATCH never repeats on normal reconciliation',async()=>{
 const f=privateSiteFixture();f.state.losePatch=true;
 assert.equal((await runNetlifyTask(f.context)).reasonCode,'submission_unknown');
 await runNetlifyTask(f.context);await reconcileNetlifyTask(f.context);
 assert.equal(f.state.patches,1);assert.equal(f.state.creates,1);
});

test('explicit visibility continuation requires a distinct durable reservation and never creates again',async()=>{
 const f=privateSiteFixture();f.state.details=false;
 assert.equal((await runNetlifyTask(f.context)).reasonCode,'submission_unknown');f.state.details=true;
 let latched=false;
 const reserve=async(binding:any)=>{assert.equal(binding.siteId,SITE_ID);assert.equal(binding.deployId,'deploy_123');assert.equal(binding.intent,f.journal.intent);assert.equal(latched,false);latched=true};
 f.state.losePatch=true;
 assert.equal((await continueNetlifyVisibility(f.context,reserve)).status,'unknown');
 assert.equal(latched,true);assert.equal(f.state.patches,1);
 assert.equal((await continueNetlifyVisibility(f.context,reserve)).status,'unknown');
 assert.equal(f.state.patches,1);assert.equal(f.state.creates,1);
});

test('visibility continuation rechecks draft and review after durable reservation',async()=>{
 for(const changed of ['draft','review','identity','blocked'] as const){
  const f=privateSiteFixture();f.state.details=false;await runNetlifyTask(f.context);f.state.details=true;
  assert.equal((await continueNetlifyVisibility(f.context,async()=>{
   if(changed==='draft')f.task.draft!.body+=' changed';
   if(changed==='review')f.task.articleReview=undefined;
   if(changed==='identity')f.context.getAccount()!.username='other-user';
   if(changed==='blocked')throw Error('dispatch exists');
  })).status,'unknown');assert.equal(f.state.patches,0,changed);
 }
});
