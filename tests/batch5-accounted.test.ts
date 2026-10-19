import assert from 'node:assert/strict';
import test from 'node:test';
import {marked} from 'marked';
import {prepareBatch5Account,recoverBatch5Account,reconcileBatch5AccountedTask,runBatch5AccountedTask,slopitSignupEmail,verifyBatch5AccountedPublication} from '../src/integrations/batch5-accounted';
import {Batch5RegistrationLimitError} from '../src/integrations/batch5-contract';
import {BATCH5_MESSAGES} from '../src/shared/batch5-messages';
import type {Batch5AccountIntent,Batch5AccountOpaqueResponse,Batch5AccountPersistence,Batch5AccountReceipt,Batch5Dependencies,Batch5Intent,Batch5OpaqueResponse,Batch5Persistence,Batch5Receipt,Batch5TaskState,Batch5RegistrationState} from '../src/integrations/batch5-contract';
import type {Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const at='2026-10-18T00:00:00.000Z',site={id:'11111111-1111-4111-8111-111111111111',url:'https://example.com/',domain:'example.com',name:'Example Site',description:'Independent research',language:'zh-CN',category:'finance'} as Site;
const body=`这是一篇独立的金融基础知识说明。先解释风险、来源与适用范围，再讨论个人如何核对公开的服务规则。\n\n更多背景见[本站原始资料](https://example.com/)。阅读者应自行核查事实，谨慎区分历史信息与未来的不确定性。`;
type ChannelId='slopit'|'rant';
test('SlopIt email aliases use Gmail support and only explicitly provisioned aliases elsewhere',()=>{
  const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
  const gmailFirst=slopitSignupEmail('owner@gmail.com',first),gmailSecond=slopitSignupEmail('owner@gmail.com',second);
  assert.match(gmailFirst??'',/^owner\+site-[a-f0-9]{8}@gmail\.com$/);assert.notEqual(gmailFirst,gmailSecond);
  assert.match(slopitSignupEmail('owner@googlemail.com',first)??'',/^owner\+site-[a-f0-9]{8}@googlemail\.com$/);
  assert.equal(slopitSignupEmail('owner@example.com',first),'owner@example.com');
  const provisioned=slopitSignupEmail('owner@example.com',first,[`owner+site-${gmailFirst!.split('+site-')[1].split('@')[0]}@example.com`]);
  assert.notEqual(provisioned,'owner@example.com');
});
test('rant registration cap is classified by typed local error, not message text',async()=>{
  const db=stores(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport('rant',requests),now:()=>new Date(at)};
  db.accounts.saveAccountIntent=async()=>{throw new Batch5RegistrationLimitError('local cap')};
  const {context}=fixture('rant',db,deps),result=await runBatch5AccountedTask(context);
  assert.equal(result.status,'queued');assert.equal(result.message,BATCH5_MESSAGES.registrationLimit);assert.equal(requests.filter(value=>value.method==='POST').length,0);
  db.accounts.saveAccountIntent=async()=>{throw Error(BATCH5_MESSAGES.registrationLimit)};
  const unrelated=await runBatch5AccountedTask(context);
  assert.notEqual(unrelated.message,BATCH5_MESSAGES.registrationLimit);
});
function stores(){
  let accountIntent:Batch5AccountIntent|undefined,accountOpaque:Batch5AccountOpaqueResponse|undefined,accountReceipt:Batch5AccountReceipt|undefined;
  let accountStage:Batch5RegistrationState['stage']|undefined,rateLimitCount=0,lastRateLimitedAt:string|undefined;
  let intent:Batch5Intent|undefined,receipt:Batch5Receipt|undefined,opaque:Batch5OpaqueResponse|undefined,postStage:Batch5TaskState['stage']|undefined;
  const accounts:Batch5AccountPersistence={
    saveAccountIntent:async value=>{if(accountIntent)throw Error('duplicate');accountIntent=value;accountStage='reserved'},
    replaceUnsentAccountIntent:async(previous,next)=>{if(!accountIntent||JSON.stringify(accountIntent)!==JSON.stringify(previous)||accountStage!=='not_sent')throw Error('not proved unsent');accountIntent=next;accountStage='reserved';accountOpaque=undefined},
    loadAccountIntent:async()=>accountIntent,
    saveAccountOpaqueResponse:async value=>{accountOpaque=value;if(value.status===429){rateLimitCount++;lastRateLimitedAt=value.receivedAt;accountStage=rateLimitCount>=3?'rejected':'rate_limited'}else accountStage=value.status>=400&&value.status<500?'rejected':'request_unknown'},
    loadAccountOpaqueResponse:async()=>accountOpaque,
    saveAccountReceipt:async value=>{accountReceipt=value;accountStage='registered'},loadAccountReceipt:async()=>accountReceipt,
    loadAccountRegistration:async()=>accountIntent&&accountStage?{version:1,channelId:accountIntent.channelId as ChannelId,operationId:accountIntent.operationId,createdAt:accountIntent.createdAt,stage:accountStage,sendGuardVersion:1,...(rateLimitCount?{rateLimitCount,lastRateLimitedAt}:{})}:undefined,
    markAccountRegistration:async(value,stage)=>{if(!accountIntent||JSON.stringify(value)!==JSON.stringify(accountIntent))throw Error('intent mismatch');accountStage=stage;if(stage==='sending')accountOpaque=undefined},
  };
  const posts:Batch5Persistence={
    saveIntent:async value=>{if(intent)throw Error('duplicate');intent=value;postStage='submitting'},
    reserveIntent:async value=>{if(intent)throw Error('duplicate');intent=value;postStage='reserved'},
    markSending:async value=>{if(!intent||JSON.stringify(intent)!==JSON.stringify(value)||postStage!=='reserved')throw Error('not reserved');postStage='submitting'},
    loadIntent:async()=>intent,saveReceipt:async value=>{receipt=value;postStage='api_receipt'},loadReceipt:async()=>receipt,
    saveOpaqueResponse:async value=>{opaque=value;postStage='opaque_response'},loadOpaqueResponse:async()=>opaque,
  };
  return {accounts,posts,read:()=>({accountIntent,accountOpaque,accountReceipt,accountStage,rateLimitCount,lastRateLimitedAt,intent,receipt,opaque,postStage})};
}
function fixture(channelId:ChannelId,db:ReturnType<typeof stores>,deps:Batch5Dependencies){const task={id:'22222222-2222-4222-8222-222222222222',siteId:site.id,channelId,sourceDomain:channelId==='rant'?'rant.li':'slopit.io',status:'queued',createdAt:at,updatedAt:at,scheduledAt:at,attempts:0,message:'',articleApprovedAt:at,draft:{title:'金融信息核对方法',description:'独立说明',body}} as Task&{batch5?:Batch5TaskState};
  const channel={id:channelId,domain:task.sourceDomain,automation:'api',accountRequired:true,articleRequired:true,kind:'article'} as Channel;
  const context={site,task,channel,settings:{mail:{user:'owner@example.com'}},signal:new AbortController().signal,batch5Persistence:db.posts,batch5AccountPersistence:db.accounts,batch5Dependencies:deps,checkpoint:(partial:Partial<Task>)=>Object.assign(task,partial)} as unknown as ExecutionContext&{batch5Persistence:Batch5Persistence;batch5AccountPersistence:Batch5AccountPersistence;batch5Dependencies:Batch5Dependencies};
  return {context,task};
}
function transport(channelId:ChannelId,requests:Array<{method:string;url:string;body?:string}>,options:{registrationUnknown?:boolean;registrationStatus?:number;postUnknown?:boolean;postStatus?:number;publicStatus?:number;robotsStatus?:number;noindex?:boolean;badLink?:boolean}={}){
  let title='',postedBody='',slug='',username='';const blogUrl='https://example-site.slopit.io/',blogId='blog12345';
  return async(url:string,init:RequestInit):Promise<Response>=>{
    const method=init.method??'GET',requestBody=typeof init.body==='string'?init.body:undefined;requests.push({method,url,...(requestBody?{body:requestBody}:{})});
    if(method==='POST'&&url==='https://slopit.io/api/signup'){
      if(options.registrationUnknown)throw Error('synthetic signup loss');
      const input=JSON.parse(requestBody!);assert.equal(input.email,'owner@example.com');assert.equal(input.language,'zh-CN');
      return new Response(JSON.stringify({api_key:'api-key-long-opaque-123',blog_id:blogId,blog_url:blogUrl,email_sent:true}),{status:options.registrationStatus??200,headers:{'content-type':'application/json'}});
    }
    if(method==='POST'&&url==='https://rant.li/api/auth/signup'){
      if(options.registrationUnknown)throw Error('synthetic signup loss');
      const input=JSON.parse(requestBody!);username=input.alias;assert.ok(input.pass.length>=32);
      return new Response(JSON.stringify({code:201,data:{access_token:'token-long-opaque-123',user:{username}}}),{status:options.registrationStatus??201,headers:{'content-type':'application/json'}});
    }
    if(method==='POST'){
      const input=JSON.parse(requestBody!);title=input.title;postedBody=input.body;slug=input.slug;
      assert.equal(postedBody,body);assert.equal(input.status,channelId==='slopit'?'published':undefined);
      if(options.postUnknown)throw Error('synthetic post loss');
      if(options.postStatus!==undefined)return new Response(JSON.stringify({error:options.postStatus===429?'rate_limited':'rejected'}),{status:options.postStatus,headers:{'content-type':'application/json'}});
      const response=channelId==='slopit'?{post_url:`${blogUrl}${slug}/`}:{code:201,data:{id:'ABCDE12345',slug,title,body:postedBody}};
      return new Response(JSON.stringify(response),{status:201,headers:{'content-type':'application/json'}});
    }
    assert.equal(method,'GET');
    if(url.endsWith('/robots.txt'))return new Response('User-agent: *\nAllow: /\n',{status:options.robotsStatus??200,headers:{'content-type':'text/plain'}});
    if(channelId==='slopit'){
      if(url===`${blogUrl}${slug||'not-yet-posted'}.md`||url.startsWith(blogUrl)&&url.endsWith('.md')){
        if(!slug)return new Response('missing',{status:404,headers:{'content-type':'text/plain'}});
        return new Response(`---\ntitle: ${title}\nslug: ${slug}\n---\n${postedBody}\n`,{status:200,headers:{'content-type':'text/markdown'}});
      }
      assert.equal(url,`${blogUrl}${slug}/`);
      const content=options.badLink?postedBody.replace('https://example.com/','https://other.example.com/'):postedBody;
      return new Response(`<html><head>${options.noindex?'<meta name="robots" content="noindex">':''}<link rel="canonical" href="${url}"></head><body><article><h1>${title}</h1><div class="post-body">${marked.parse(content,{async:false,gfm:true})}</div></article></body></html>`,{status:options.publicStatus??200,headers:{'content-type':'text/html'}});
    }
    if(url.startsWith('https://rant.li/api/collections/')){
      if(!slug)return new Response('missing',{status:404,headers:{'content-type':'application/json'}});
      return new Response(JSON.stringify({code:200,data:{id:'ABCDE12345',slug,title,body:postedBody,collection:{alias:username}}}),{status:200,headers:{'content-type':'application/json'}});
    }
    assert.equal(url,`https://rant.li/${username}/${slug}`);
    const content=options.badLink?postedBody.replace('https://example.com/','https://other.example.com/'):postedBody;
    return new Response(`<html><head>${options.noindex?'<meta name="robots" content="noindex">':''}<link rel="canonical" href="${url}"></head><body><article id="post-body"><div class="e-content">${marked.parse(content,{async:false,gfm:true})}</div></article></body></html>`,{status:options.publicStatus??200,headers:{'content-type':'text/html'}});
  };
}

for(const channelId of ['slopit','rant'] as const){
  test(`${channelId}: registration authorization loss leaves intent and sends no POST`,async()=>{
    const db=stores(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(channelId,requests),now:()=>new Date(at)};
    db.accounts.assertReadyToRegister=async()=>{throw Error('authorization changed')};
    const {context}=fixture(channelId,db,deps),result=await runBatch5AccountedTask(context);
    assert.equal(result.status,'queued');assert.equal(result.failureKind,undefined);assert.equal(result.checkpoint,'batch5_account_not_sent');assert.equal(db.read().accountStage,'not_sent');assert.ok(db.read().accountIntent);assert.equal(requests.filter(value=>value.method==='POST').length,0);
    const firstOperationId=db.read().accountIntent?.operationId;
    db.accounts.assertReadyToRegister=undefined;
    const later=fixture(channelId,db,deps);later.task.id='33333333-3333-4333-8333-333333333333';
    const replay=await prepareBatch5Account(later.context);assert.equal(replay,undefined);assert.notEqual(db.read().accountIntent?.operationId,firstOperationId);assert.equal(db.read().accountStage,'registered');assert.equal(requests.filter(value=>value.method==='POST').length,1);
  });
  test(`${channelId}: publication authorization loss leaves intent and sends no post`,async()=>{
    const db=stores(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(channelId,requests),now:()=>new Date(at)};
    db.posts.assertReadyToSubmit=async()=>{throw Error('authorization changed')};
    const {context,task}=fixture(channelId,db,deps),result=await runBatch5AccountedTask(context);
    assert.equal(result.status,'queued');assert.equal(result.failureKind,undefined);assert.equal(result.submittedAt,undefined);assert.equal(task.submittedAt,undefined);assert.equal(db.read().postStage,'reserved');assert.equal(requests.filter(value=>value.method==='POST').length,1);
    db.posts.assertReadyToSubmit=undefined;
    const second=await runBatch5AccountedTask(context);assert.equal(second.status,'review');assert.equal(db.read().postStage,'api_receipt');assert.equal(requests.filter(value=>value.method==='POST').length,2);
  });
  test(`${channelId}: one account, one post, encrypted-only credentials and public verification`,async()=>{
    const db=stores(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(channelId,requests),now:()=>new Date(at)};
    const {context,task}=fixture(channelId,db,deps),result=await runBatch5AccountedTask(context);
    assert.equal(result.status,'review');assert.equal(result.batch5?.stage,'api_receipt');assert.ok(result.publicUrl);task.publicUrl=result.publicUrl;
    assert.equal(requests.filter(value=>value.method==='POST').length,2);
    assert.ok(db.read().accountReceipt?.secret);assert.ok(db.read().receipt?.rawResponse);
    assert.equal(JSON.stringify(task).includes('token-long-opaque'),false);assert.equal(JSON.stringify(task).includes('api-key-long'),false);
    assert.equal((await verifyBatch5AccountedPublication(context,site.url)).found,true);
  });
  test(`${channelId}: registration unknown blocks second signup`,async()=>{
    const db=stores(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(channelId,requests,{registrationUnknown:true}),now:()=>new Date(at)};
    const {context}=fixture(channelId,db,deps),first=await runBatch5AccountedTask(context),second=await runBatch5AccountedTask(context);
    assert.equal(first.failureKind,'unknown');assert.equal(second.failureKind,'unknown');assert.equal(db.read().accountStage,'request_unknown');assert.ok(db.read().accountIntent);assert.equal(requests.filter(value=>value.method==='POST').length,1);
  });
  test(`${channelId}: 429 reserves post intent and no second create occurs`,async()=>{
    const db=stores(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(channelId,requests,{postStatus:429}),now:()=>new Date(at)};
    const {context}=fixture(channelId,db,deps),first=await runBatch5AccountedTask(context),second=await runBatch5AccountedTask(context);
    assert.equal(first.failureKind,'rate_limited');assert.equal(second.status,'review');assert.ok(db.read().intent);assert.equal(requests.filter(value=>value.method==='POST').length,2);
  });
  test(`${channelId}: unknown post and restart only reconcile`,async()=>{
    const db=stores(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(channelId,requests,{postUnknown:true}),now:()=>new Date(at)};
    const first=fixture(channelId,db,deps),result=await runBatch5AccountedTask(first.context);assert.equal(result.failureKind,'unknown');
    const resumed=fixture(channelId,db,deps);resumed.task.batch5=result.batch5;resumed.task.submittedAt=result.submittedAt;
    const read=await reconcileBatch5AccountedTask(resumed.context),again=await runBatch5AccountedTask(resumed.context);
    assert.equal(read.status,'unknown');assert.equal(again.status,'review');assert.equal(requests.filter(value=>value.method==='POST').length,2);
  });
  test(`${channelId}: opaque post response promotes on restart with GET only`,async()=>{
    const db=stores(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(channelId,requests),now:()=>new Date(at)};
    const original=db.posts.saveReceipt;let fail=true;db.posts.saveReceipt=async value=>{if(fail){fail=false;throw Error('vault failure')}await original(value)};
    const first=fixture(channelId,db,deps),result=await runBatch5AccountedTask(first.context);assert.equal(result.batch5?.stage,'opaque_response');
    const resumed=fixture(channelId,db,deps);resumed.task.batch5=result.batch5;resumed.task.submittedAt=result.submittedAt;
    const found=await reconcileBatch5AccountedTask(resumed.context);assert.equal(found.status,'found');assert.equal(found.status==='found'&&found.batch5.stage,'api_receipt');assert.ok(db.read().receipt);assert.equal(requests.filter(value=>value.method==='POST').length,2);
    if(found.status==='found'){resumed.task.batch5={...found.batch5,stage:'published'};const accepted=await reconcileBatch5AccountedTask(resumed.context);assert.equal(accepted.status==='found'&&accepted.batch5.stage,'published');}
  });
  test(`${channelId}: noindex and altered href fail verification`,async()=>{
    for(const options of [{noindex:true},{badLink:true}]){
      const db=stores(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(channelId,requests,options),now:()=>new Date(at)};
      const {context,task}=fixture(channelId,db,deps),result=await runBatch5AccountedTask(context);task.publicUrl=result.publicUrl;
      assert.equal(result.failureKind,'verification_failed');assert.equal(result.batch5?.stage,'api_receipt');assert.equal((await verifyBatch5AccountedPublication(context,site.url)).found,false);
    }
  });
  test(`${channelId}: complete signup response is saved before parsing and recovers without a second POST`,async()=>{
    const db=stores(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(channelId,requests),now:()=>new Date(at)};
    const save=db.accounts.saveAccountReceipt;let interrupted=true;
    db.accounts.saveAccountReceipt=async value=>{if(interrupted){interrupted=false;throw Error('synthetic disk interruption')}await save(value)};
    const first=fixture(channelId,db,deps),failed=await prepareBatch5Account(first.context);
    assert.equal(failed?.failureKind,'unknown');assert.ok(db.read().accountOpaque?.bodyBase64);assert.equal(db.read().accountReceipt,undefined);
    const resumed=fixture(channelId,db,{fetch:async()=>{throw Error('recovery must not use network')},now:()=>new Date(at)}),result=await recoverBatch5Account(resumed.context);
    assert.deepEqual(result,{ready:true});assert.ok(db.read().accountReceipt?.secret);
    assert.equal(requests.filter(value=>value.method==='POST').length,1);
  });
  test(`${channelId}: explicit account recovery without an intent cannot register or reserve a new identity`,async()=>{
    const db=stores();db.accounts.saveAccountIntent=async()=>{throw Error('recovery must not reserve')};
    const {context}=fixture(channelId,db,{fetch:async()=>{throw Error('recovery must not use network')}});
    const result=await recoverBatch5Account(context);
    assert.equal(result.ready,false);assert.equal(db.read().accountIntent,undefined);
  });
  test(`${channelId}: signup response journal failure never interprets credentials`,async()=>{
    const db=stores(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(channelId,requests),now:()=>new Date(at)};
    db.accounts.saveAccountOpaqueResponse=async()=>{throw Error('synthetic encryption failure')};
    const result=await prepareBatch5Account(fixture(channelId,db,deps).context);
    assert.equal(result?.failureKind,'unknown');assert.equal(db.read().accountReceipt,undefined);
    assert.equal((await prepareBatch5Account(fixture(channelId,db,deps).context))?.failureKind,'unknown');
    assert.equal(requests.filter(value=>value.method==='POST').length,1);
  });
  test(`${channelId}: definite signup 4xx is classified and remains one-shot`,async()=>{
    for(const [status,kind] of [[400,'format_invalid'],[401,'provider_rejected'],[403,'provider_rejected'],[409,'account_handoff']] as const){
      const db=stores(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(channelId,requests,{registrationStatus:status}),now:()=>new Date(at)};
      const first=await prepareBatch5Account(fixture(channelId,db,deps).context),again=await prepareBatch5Account(fixture(channelId,db,deps).context);
      assert.equal(first?.failureKind,kind);assert.equal(again?.failureKind,kind);assert.ok(db.read().accountOpaque);
      assert.equal(first?.checkpoint,'batch5_account_rejected');assert.equal(db.read().accountStage,'rejected');
      assert.equal(first?.trialFailureOperationId,status===409?undefined:db.read().accountIntent?.operationId);
      assert.equal(again?.trialFailureOperationId,first?.trialFailureOperationId);
      assert.equal(requests.filter(value=>value.method==='POST').length,1);
    }
  });
  test(`${channelId}: 429 retries same intent only after 24 hours and stops after two retries`,async()=>{
    const db=stores(),requests:Array<{method:string;url:string;body?:string}>=[];let current=Date.parse(at);
    const deps={fetch:transport(channelId,requests,{registrationStatus:429}),now:()=>new Date(current)};
    const prepare=()=>prepareBatch5Account(fixture(channelId,db,deps).context);
    const first=await prepare(),operationId=db.read().accountIntent?.operationId;
    assert.equal(first?.status,'queued');assert.equal(first?.trialFailureOperationId,undefined);assert.equal(db.read().rateLimitCount,1);
    await prepare();current+=86_399_999;await prepare();assert.equal(requests.filter(value=>value.method==='POST').length,1);
    current+=1;assert.equal((await prepare())?.status,'queued');assert.equal(db.read().accountIntent?.operationId,operationId);assert.equal(db.read().rateLimitCount,2);
    current+=86_400_000;const exhausted=await prepare();assert.equal(exhausted?.status,'failed');assert.equal(exhausted?.failureKind,'account_handoff');assert.equal(exhausted?.trialFailureOperationId,undefined);
    assert.equal(db.read().rateLimitCount,3);assert.equal(db.read().accountStage,'rejected');assert.equal(requests.filter(value=>value.method==='POST').length,3);
    await prepare();assert.equal(requests.filter(value=>value.method==='POST').length,3);
  });
  test(`${channelId}: transient public and robots reads do not count as trial failures`,async()=>{
    for(const options of [{publicStatus:503},{robotsStatus:503}]){
      const db=stores(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(channelId,requests,options),now:()=>new Date(at)};
      const result=await runBatch5AccountedTask(fixture(channelId,db,deps).context);
      assert.equal(result.status,'review');assert.equal(result.batch5?.stage,'api_receipt');assert.equal(result.failureKind,undefined);
    }
  });
  test(`${channelId}: first public 404/410 stays pending without a platform failure`,async()=>{
    for(const publicStatus of [404,410]){
      const db=stores(),requests:Array<{method:string;url:string;body?:string}>=[];
      const deps={fetch:transport(channelId,requests,{publicStatus}),now:()=>new Date(at)};
      const result=await runBatch5AccountedTask(fixture(channelId,db,deps).context);
      assert.equal(result.status,'review');
      assert.equal(result.batch5?.stage,'api_receipt');
      assert.equal(result.failureKind,undefined);
    }
  });
  test(`${channelId}: local journal or credential read failures are unreachable`,async()=>{
    const db=stores();db.accounts.loadAccountReceipt=async()=>{throw Error('synthetic keychain failure')};
    const {context}=fixture(channelId,db,{fetch:async()=>{throw Error('network must not run')}});context.task.publicUrl='https://example.com/fixture';
    const result=await verifyBatch5AccountedPublication(context,site.url);assert.equal(result.found,false);assert.equal(result.outcome,'unreachable');
  });
  test(`${channelId}: definite post 4xx keeps rejection checkpoint`,async()=>{
    for(const [status,kind] of [[400,'format_invalid'],[401,'account_handoff'],[403,'account_handoff'],[409,'provider_rejected'],[429,'rate_limited']] as const){
      const db=stores(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(channelId,requests,{postStatus:status}),now:()=>new Date(at)};
      const result=await runBatch5AccountedTask(fixture(channelId,db,deps).context);
      assert.equal(result.status,'failed');assert.equal(result.failureKind,kind);assert.equal(result.checkpoint,'batch5_rejected');assert.ok(db.read().intent);
    }
  });
}

test('SlopIt signup uses the site-bound mailbox for both base address and alias policy',async()=>{
  const db=stores(),requests:string[]=[];
  const deps:Batch5Dependencies={now:()=>new Date(at),fetch:async(url,init)=>{
    assert.equal(url,'https://slopit.io/api/signup');const email=JSON.parse(String(init.body)).email as string;requests.push(email);
    return new Response(JSON.stringify({api_key:'api-key-long-opaque-123',blog_id:'blog12345',blog_url:'https://example-site.slopit.io/'}),{status:200,headers:{'content-type':'application/json'}});
  }};
  const {context}=fixture('slopit',db,deps);
  context.mailbox={id:'mailbox-1',label:'Bound',host:'mail.example.com',port:993,user:'bound@gmail.com',secure:true,hasPassword:true,aliases:[],createdAt:at,updatedAt:at};
  assert.equal(await prepareBatch5Account(context),undefined);
  assert.match(requests[0],/^bound\+site-[a-f0-9]{8}@gmail\.com$/);
  assert.equal(db.read().accountIntent?.email,requests[0]);
});

test('exact 401/403/409 signup headers classify rejection even if the response body breaks',async()=>{
  for(const status of [401,403,409]){
    const db=stores(),requests:string[]=[];
    const deps:Batch5Dependencies={now:()=>new Date(at),fetch:async(url,init)=>{
      requests.push(`${init.method} ${url}`);
      return new Response(new ReadableStream({pull(controller){controller.error(Error('body interrupted'))}}),{status,headers:{'content-type':'application/json'}});
    }};
    const first=await prepareBatch5Account(fixture('rant',db,deps).context);
    const second=await prepareBatch5Account(fixture('rant',db,deps).context);
    assert.equal(first?.status,'failed');assert.equal(first?.failureKind,status===409?'account_handoff':'provider_rejected');
    assert.equal(first?.trialFailureOperationId,status===409?undefined:db.read().accountIntent?.operationId);
    assert.equal(db.read().accountOpaque?.bodyComplete,false);assert.equal(db.read().accountStage,'rejected');
    assert.equal(second?.failureKind,first?.failureKind);assert.equal(requests.length,1);
    const recovered=await recoverBatch5Account(fixture('rant',db,{now:()=>new Date(at),fetch:async()=>{throw Error('read-only recovery must not send')}}).context);
    assert.equal(recovered.ready,false);
    if(!recovered.ready)assert.equal(recovered.result.failureKind,first?.failureKind);
    assert.equal(requests.length,1);
  }
});

test('an unguarded legacy reservation is treated as unknown and never sent again',async()=>{
  for(const channelId of ['rant','slopit'] as const){
    const db=stores(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(channelId,requests),now:()=>new Date(at)};
    const mark=db.accounts.markAccountRegistration;
    // Seed a reservation whose send guard never became durable.
    db.accounts.markAccountRegistration=async(value,stage,...rest)=>{if(stage==='sending')throw Error('crash before send guard');return mark(value,stage,...rest)};
    await runBatch5AccountedTask(fixture(channelId,db,deps).context);
    assert.equal(requests.filter(request=>request.method==='POST').length,0,channelId);
    db.accounts.markAccountRegistration=mark;
    // An older build kept no guard version, so a crash could have happened mid-POST.
    const load=db.accounts.loadAccountRegistration;
    db.accounts.loadAccountRegistration=async(...args)=>{const value=await load(...args);return value&&{...value,sendGuardVersion:undefined}};
    const result=await runBatch5AccountedTask(fixture(channelId,db,deps).context);
    assert.equal(requests.filter(request=>request.method==='POST').length,0,channelId);
    assert.equal(result.status,'needs_input',channelId);
    assert.equal(db.read().accountStage,'request_unknown',channelId);
  }
});
