import test from 'node:test';
import assert from 'node:assert/strict';
import {Store,emptyState} from '../src/main/store';
import {Controller,isConfirmedBetterThanHtmlResultUrl} from '../src/main/controller';
import {validateBackup} from '../src/main/backup-validation';
import {nextTask,recoverInterrupted,socialPublicationAt} from '../src/main/planner';
import {betterThanHtmlDraftError} from '../src/main/article-review';
import {publisherFor} from '../src/integrations/publishers';
import {betterThanHtmlTesting,reconcileBetterThanHtmlTask,verifyBetterThanHtml,type BetterThanHtmlTransport} from '../src/integrations/betterthanhtml';
import {CHANNELS} from '../src/integrations/catalog';
import type {Channel,ExecutionContext,Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const stamp='2026-10-08T00:00:00.000Z';
const firstSiteId='11111111-1111-4111-8111-111111111111';
const secondSiteId='22222222-2222-4222-8222-222222222222';
const taskId='33333333-3333-4333-8333-333333333333';
const remoteId='workshop_123';
const publicUrl=`https://betterthanhtml.com/workshop/${remoteId}`;
const contentHash='a'.repeat(64);
const body='A source record should preserve the original claim, its date, and every unit before drawing a conclusion.\n\nThe [worked source](https://example.com/guides/source-record) remains available for comparison, and unresolved assumptions should be recorded explicitly.';

function channel():Channel{const found=CHANNELS.find(item=>item.id==='betterthanhtml');assert.ok(found);return found}
async function enabled<T>(run:()=>Promise<T>):Promise<T>{const value=channel(),before=value.enabled;value.enabled=true;try{return await run()}finally{value.enabled=before}}
function site(id=firstSiteId,domain='example.com'):Site{return {id,domain,url:`https://${domain}/`,email:`owner@${domain}`,name:'Example Research',description:'Independent source notes',category:'content',language:'en',monthlyTarget:1,articleReviewMode:'manual',status:'ready',createdAt:stamp,analyzedAt:stamp,topicsCheckedAt:new Date().toISOString(),topics:[{url:`https://${domain}/guides/source-record`,discoveredAt:stamp}]}}
function task(siteValue=site(),extra:Partial<Task>={}):Task{return {id:taskId,siteId:siteValue.id,channelId:'betterthanhtml',sourceDomain:'betterthanhtml.com',status:'queued',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',topicUrl:siteValue.topics?.[0].url,draft:{title:'A careful source record',description:'A reproducible review method.',body:body.replace('https://example.com',siteValue.url.replace(/\/$/,''))},draftRevision:1,articleApprovedAt:stamp,...extra}}
function configure(state:ReturnType<typeof emptyState>,siteValue:Site,taskValue:Task){state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='manual';state.settings.timezone='UTC';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='betterthanhtml']));state.sites=[siteValue];state.tasks=[taskValue]}
function unavailableVault(){let calls=0;return {value:{ready:false,available:()=>false,get:async()=>{calls++;throw Error('vault must not be read')},set:async()=>{calls++;throw Error('vault must not be written')},delete:async()=>{calls++;throw Error('vault must not be changed')},encryptSecrets:()=>{calls++;throw Error('vault must not encrypt')}} as unknown as Vault,calls:()=>calls}}

test('Better Than HTML enables its verified no-account publisher after live acceptance',()=>{
  assert.equal(channel().enabled,true);assert.equal(channel().accountRequired,false);assert.ok(publisherFor(channel()));
});

test('manual result intake only accepts the exact URL already confirmed by the original published receipt',()=>{
  const confirmed=task(site(),{submittedAt:stamp,publicUrl,checkpoint:'betterthanhtml_published',betterthanhtml:{contentHash,id:remoteId,stage:'published'}});
  assert.equal(isConfirmedBetterThanHtmlResultUrl(confirmed,publicUrl),true);
  assert.equal(isConfirmedBetterThanHtmlResultUrl(confirmed,'https://betterthanhtml.com/workshop/other'),false);
  assert.equal(isConfirmedBetterThanHtmlResultUrl(confirmed,`${publicUrl}/`),false);
  assert.equal(isConfirmedBetterThanHtmlResultUrl({...confirmed,publicUrl:undefined},publicUrl),false);
  assert.equal(isConfirmedBetterThanHtmlResultUrl({...confirmed,submittedAt:undefined},publicUrl),false);
  assert.equal(isConfirmedBetterThanHtmlResultUrl({...confirmed,betterthanhtml:{contentHash,id:remoteId,stage:'submitting'}},publicUrl),false);
  assert.equal(isConfirmedBetterThanHtmlResultUrl({...confirmed,betterthanhtml:{contentHash,stage:'published'}},publicUrl),false);
  assert.equal(isConfirmedBetterThanHtmlResultUrl({...confirmed,betterthanhtml:{contentHash,id:'../other',stage:'published'},publicUrl:'https://betterthanhtml.com/other'},'https://betterthanhtml.com/other'),false);
});

test('Controller accepts the durable three-checkpoint sequence without Vault access and verifies the same page',async()=>enabled(async()=>{
  const store=new Store(':memory:'),siteValue=site(),taskValue=task(siteValue),vault=unavailableVault(),seen:Array<Pick<Task,'checkpoint'|'betterthanhtml'|'publicUrl'>>=[];
  store.update(state=>configure(state,siteValue,taskValue));let verified=0;
  const controller=new Controller(store,vault.value,'fixture',{executeTask:async context=>{
    assert.equal(context.getAccount(),undefined);const submittedAt=new Date().toISOString();
    context.checkpoint({betterthanhtml:{contentHash,stage:'submitting'},checkpoint:'betterthanhtml_publish_submitting',submittedAt});seen.push(store.read().tasks[0]);
    assert.throws(()=>context.checkpoint({betterthanhtml:{contentHash,id:'../bad',stage:'submitting'},checkpoint:'betterthanhtml_publish_submitting',submittedAt,publicUrl}),/回执/);
    context.checkpoint({betterthanhtml:{contentHash,id:remoteId,stage:'submitting'},checkpoint:'betterthanhtml_publish_submitting',submittedAt,publicUrl});seen.push(store.read().tasks[0]);
    context.checkpoint({betterthanhtml:{contentHash,id:remoteId,stage:'published'},checkpoint:'betterthanhtml_published',submittedAt,publicUrl});seen.push(store.read().tasks[0]);
    return {status:'review',message:'published fixture',checkpoint:'betterthanhtml_published',submittedAt,publicUrl,betterthanhtml:{contentHash,id:remoteId,stage:'published'}};
  },verifyBetterThanHtml:async()=>{verified++;return {found:true,outcome:'found',url:publicUrl,rel:'nofollow ugc',reason:'matched'}}});
  controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.deepEqual(seen.map(item=>[item.checkpoint,item.betterthanhtml?.id,item.betterthanhtml?.stage,item.publicUrl]),[
    ['betterthanhtml_publish_submitting',undefined,'submitting',undefined],
    ['betterthanhtml_publish_submitting',remoteId,'submitting',publicUrl],
    ['betterthanhtml_published',remoteId,'published',publicUrl],
  ]);assert.equal(verified,1);assert.equal(saved.status,'live');assert.equal(saved.betterthanhtml?.stage,'published');assert.equal(saved.publicUrl,publicUrl);assert.equal(saved.accountId,undefined);assert.equal(vault.calls(),0)}finally{store.close()}
}));

test('a positive late receipt survives pause, while changed hashes, IDs, and URLs are rejected',async()=>enabled(async()=>{
  const store=new Store(':memory:'),siteValue=site(),taskValue=task(siteValue),vault=unavailableVault();store.update(state=>configure(state,siteValue,taskValue));let controller:Controller;
  controller=new Controller(store,vault.value,'fixture',{executeTask:async context=>{const submittedAt=new Date().toISOString();context.checkpoint({betterthanhtml:{contentHash,stage:'submitting'},checkpoint:'betterthanhtml_publish_submitting',submittedAt});controller.pause();
    assert.throws(()=>context.checkpoint({betterthanhtml:{contentHash:'b'.repeat(64),id:remoteId,stage:'submitting'},checkpoint:'betterthanhtml_publish_submitting',submittedAt,publicUrl}),/回执/);
    context.checkpoint({betterthanhtml:{contentHash,id:remoteId,stage:'submitting'},checkpoint:'betterthanhtml_publish_submitting',submittedAt,publicUrl});
    assert.throws(()=>context.checkpoint({betterthanhtml:{contentHash,id:'other',stage:'published'},checkpoint:'betterthanhtml_published',submittedAt,publicUrl}),/回执/);
    context.checkpoint({betterthanhtml:{contentHash,id:remoteId,stage:'published'},checkpoint:'betterthanhtml_published',submittedAt,publicUrl});return {status:'review',message:'late receipt'};}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(saved.status,'needs_input');assert.equal(saved.betterthanhtml?.stage,'published');assert.equal(saved.publicUrl,publicUrl);assert.equal(store.read().settings.autoRun,false);assert.equal(vault.calls(),0)}finally{store.close()}
}));

test('an interrupted receipt is GET-only recovery work and can never return to the publishing queue',async()=>enabled(async()=>{
  const siteValue=site(),pending=task(siteValue,{status:'running',submittedAt:stamp,checkpoint:'betterthanhtml_publish_submitting',publicUrl,betterthanhtml:{contentHash,id:remoteId,stage:'submitting'}}),state=emptyState();configure(state,siteValue,pending);recoverInterrupted(state,new Date(Date.parse(stamp)+3600000));assert.equal(state.tasks[0].status,'needs_input');assert.equal(nextTask(state,new Date(Date.parse(stamp)+3600000),[{...channel(),enabled:true}]),undefined);
  const store=new Store(':memory:');store.update(current=>Object.assign(current,state));const vault=unavailableVault();let reads=0,writes=0,verified=0;
  const controller=new Controller(store,vault.value,'fixture',{reconcileBetterThanHtml:async()=>{reads++;return {status:'found',publicUrl,betterthanhtml:{contentHash,id:remoteId,stage:'published'}}},verifyBetterThanHtml:async()=>{verified++;return {found:true,outcome:'found',url:publicUrl,rel:'nofollow ugc',reason:'matched'}},executeTask:async()=>{writes++;return {status:'failed',message:'unexpected write'}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(reads,1);assert.equal(writes,0);assert.equal(verified,1);assert.equal(saved.status,'live');assert.equal(saved.betterthanhtml?.stage,'published');assert.equal(vault.calls(),0)}finally{store.close()}
}));

test('Controller recovers a no-ID Better Than HTML intent through the real GET-only reconciler and rejects non-unique pages',async t=>enabled(async()=>{
  const run=async(mode:'unique'|'invalid'|'ambiguous')=>{
    const store=new Store(':memory:'),siteValue=site(),vault=unavailableVault();
    const pending=task(siteValue,{status:'needs_input',submittedAt:stamp,checkpoint:'betterthanhtml_publish_submitting'});
    pending.draft!.body+='\n\nA durable comparison should also preserve the retrieval method, explain why each source was selected, and separate observations from later interpretation so another reader can reproduce the review.';
    const expected=betterThanHtmlTesting.article(pending,siteValue.url,false);
    pending.betterthanhtml={contentHash:expected.contentHash,stage:'submitting'};
    const ids=mode==='ambiguous'?[remoteId,'workshop_456']:[remoteId];
    const requests:Array<{url:string;method:string}>=[];
    const fetch:BetterThanHtmlTransport=async(url,init)=>{
      const method=init.method??'GET';requests.push({url,method});
      if(method!=='GET')throw Error('recovery must not write');
      if(url==='https://betterthanhtml.com/api/workshop/list')return new Response(JSON.stringify({ok:true,active:ids.map((id,index)=>({id,title:pending.draft!.title,description:pending.draft!.description,author:'Anonymous',category:'leaflet',created_at:Date.parse(stamp)+1_000+index,expires_at:Date.parse(stamp)+86_400_000,status:'active'})),promoted:[]}),{status:200,headers:{'content-type':'application/json; charset=utf-8'}});
      if(ids.some(id=>url===`https://betterthanhtml.com/workshop/${id}`))return new Response(mode==='invalid'?expected.html.replace(`<h1>${pending.draft!.title}</h1>`,'<h1>Different article</h1>'):expected.html,{status:200,headers:{'content-type':'text/html; charset=utf-8'}});
      throw Error(`unexpected request: ${url}`);
    };
    store.update(state=>configure(state,siteValue,pending));let identifiedBeforeFound=false,verified=0,writes=0;
    const controller=new Controller(store,vault.value,'fixture',{
      reconcileBetterThanHtml:async context=>{const result=await reconcileBetterThanHtmlTask(context,{fetch});if(result.status==='found'){const durable=store.read().tasks[0];assert.equal(durable.betterthanhtml?.id,remoteId);assert.equal(durable.betterthanhtml?.stage,'submitting');assert.equal(durable.publicUrl,publicUrl);assert.equal(durable.checkpoint,'betterthanhtml_publish_submitting');identifiedBeforeFound=true}return result},
      verifyBetterThanHtml:async(taskValue,target)=>{verified++;return verifyBetterThanHtml(taskValue,target,{fetch})},
      executeTask:async()=>{writes++;return {status:'failed',message:'unexpected write'}},
    });controller.runtime.aiReady=true;
    try{await controller.tick();return {saved:store.read().tasks[0],expectedHash:expected.contentHash,identifiedBeforeFound,verified,writes,requests,vaultCalls:vault.calls()}}finally{store.close()}
  };
  await t.test('one exact full-page match persists the ID before found and reaches live',async()=>{const result=await run('unique');assert.equal(result.identifiedBeforeFound,true);assert.equal(result.saved.status,'live');assert.deepEqual(result.saved.betterthanhtml,{contentHash:result.expectedHash,id:remoteId,stage:'published'});assert.equal(result.saved.publicUrl,publicUrl);assert.equal(result.verified,1);assert.equal(result.writes,0);assert.equal(result.vaultCalls,0);assert.deepEqual(result.requests,[{url:'https://betterthanhtml.com/api/workshop/list',method:'GET'},{url:publicUrl,method:'GET'},{url:publicUrl,method:'GET'}])});
  for(const mode of ['invalid','ambiguous'] as const)await t.test(`${mode} recovery stays unidentified`,async()=>{const result=await run(mode);assert.equal(result.identifiedBeforeFound,false);assert.equal(result.saved.status,'needs_input');assert.deepEqual(result.saved.betterthanhtml,{contentHash:result.expectedHash,stage:'submitting'});assert.equal(result.saved.publicUrl,undefined);assert.equal(result.verified,0);assert.equal(result.writes,0);assert.equal(result.vaultCalls,0);assert.ok(result.requests.length>=2);assert.ok(result.requests.every(request=>request.method==='GET'))});
}));

test('backup validation preserves a strict no-account receipt and rejects identity, secret, and shape changes',()=>{
  const siteValue=site(),state=emptyState(),pending=task(siteValue,{status:'needs_input',submittedAt:stamp,checkpoint:'betterthanhtml_publish_submitting',publicUrl,betterthanhtml:{contentHash,id:remoteId,stage:'submitting'}});configure(state,siteValue,pending);const input={state,secrets:{}};
  const restored=validateBackup(structuredClone(input));assert.deepEqual(restored.state.tasks[0].betterthanhtml,pending.betterthanhtml);assert.equal(restored.state.accounts.length,0);assert.deepEqual(restored.secrets,{});
  const changedId=structuredClone(input);changedId.state.tasks[0].betterthanhtml!.id='other';assert.throws(()=>validateBackup(changedId),/Better Than HTML 回执/);
  const missing=structuredClone(input);delete missing.state.tasks[0].betterthanhtml;assert.throws(()=>validateBackup(missing),/缺少回执/);
  const extra=structuredClone(input) as typeof input&{state:{tasks:Array<Task&{betterthanhtml?:Task['betterthanhtml']&{secret?:string}}>}};extra.state.tasks[0].betterthanhtml!.secret='forbidden';assert.throws(()=>validateBackup(extra));
  const secret=structuredClone(input) as {state:typeof state;secrets:Record<string,string>};secret.secrets['publication:'+taskId]='forbidden';assert.throws(()=>validateBackup(secret),/孤立凭据/);
  const account=structuredClone(input) as {state:typeof state;secrets:Record<string,string>};account.state.accounts.push({id:'44444444-4444-4444-8444-444444444444',channelId:'betterthanhtml',email:'owner@example.com',username:'unused',status:'registered',hasPassword:false,createdAt:stamp});assert.throws(()=>validateBackup(account),/Better Than HTML 账号/);
});

test('the anonymous workspace enforces a 24-hour cross-site gap and draft format gate',()=>{
  const first=site(),second=site(secondSiteId,'second.example'),state=emptyState();state.sites=[first,second];state.tasks=[task(first,{status:'needs_input',submittedAt:stamp,checkpoint:'betterthanhtml_publish_submitting',betterthanhtml:{contentHash,stage:'submitting'}})];
  assert.equal(socialPublicationAt(state,second.id,'betterthanhtml',new Date(Date.parse(stamp)+3600000)).toISOString(),new Date(Date.parse(stamp)+86400000).toISOString());
  assert.equal(betterThanHtmlDraftError({title:'Valid title',body}),undefined);
  assert.match(betterThanHtmlDraftError({title:'x'.repeat(81),body})??'',/1–80/);
  assert.match(betterThanHtmlDraftError({title:'Valid title',body:'![tracking](https://example.com/pixel.png)'})??'',/无图片/);
  assert.match(betterThanHtmlDraftError({title:'Valid title',body:'<script>alert(1)</script>'})??'',/原始 HTML/);
});

test('deleting a site rejects every late callback and removes any legacy publication secret',async()=>enabled(async()=>{
  const store=new Store(':memory:'),siteValue=site(),running=task(siteValue,{status:'running'});store.update(state=>configure(state,siteValue,running));store.setCipher('publication:'+taskId,'legacy-secret');const controller=new Controller(store,unavailableVault().value,'fixture');
  try{const current=store.read().tasks[0],abort=new AbortController(),context=(controller as unknown as {context(task:Task,signal:AbortSignal):ExecutionContext}).context(current,abort.signal);controller.deleteSite(siteValue.id);assert.throws(()=>context.checkpoint({betterthanhtml:{contentHash,stage:'submitting'},checkpoint:'betterthanhtml_publish_submitting',submittedAt:new Date().toISOString()}),/回执/);assert.equal(store.read().tasks.length,0);assert.equal(store.getCipher('publication:'+taskId),undefined)}finally{store.close()}
}));
