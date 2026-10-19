import assert from 'node:assert/strict';
import test from 'node:test';
import {marked} from 'marked';
import {runBatch5DirectTask,reconcileBatch5DirectTask,verifyBatch5DirectPublication} from '../src/integrations/batch5-direct';
import type {Batch5Dependencies,Batch5Intent,Batch5OpaqueResponse,Batch5Persistence,Batch5Receipt,Batch5TaskState} from '../src/integrations/batch5-contract';
import type {Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const stamp='2026-10-18T00:00:00.000Z';
const site={id:'site-example',url:'https://example.com/',domain:'example.com',name:'Example Site',description:'Independent educational site',language:'zh-CN',category:'finance'} as Site;
const body=`这是一篇面向读者的独立金融知识说明。阅读原始资料和风险提示时，应区分公开规则与个人观点，并核对信息来源。\n\n更多背景可阅读[本站的原始资料](https://example.com/)，但本文本身包含完整概念解释和适用边界。`;
const specs=[{id:'yeetmd',domain:'yeet.md',origin:'https://yeet.md',path:'/api/share',idValue:'abc123',publicUrl:'https://yeet.md/s/abc123'},
  {id:'markdownpage',domain:'markdown.page',origin:'https://markdown.page',path:'/api/publish',idValue:'JCLcR63O',publicUrl:'https://markdown.page/JCLcR63O'}] as const;
type Spec=(typeof specs)[number];

function journal(){let intent:Batch5Intent|undefined,receipt:Batch5Receipt|undefined,opaque:Batch5OpaqueResponse|undefined;const persistence:Batch5Persistence={
  saveIntent:async value=>{if(intent&&JSON.stringify(value)!==JSON.stringify(intent))throw Error('different intent');intent=value},loadIntent:async()=>intent,
  saveReceipt:async value=>{receipt=value},loadReceipt:async()=>receipt,saveOpaqueResponse:async value=>{opaque=value},loadOpaqueResponse:async()=>opaque,
};return {persistence,read:()=>({intent,receipt,opaque})}}
function fixture(spec:Spec,persistence:Batch5Persistence,deps:Batch5Dependencies){
  const task={id:'task-example',siteId:site.id,channelId:spec.id,sourceDomain:spec.domain,status:'queued',createdAt:stamp,updatedAt:stamp,scheduledAt:stamp,attempts:0,message:'',articleApprovedAt:stamp,
    draft:{title:'独立金融知识说明',description:'核对资料与风险',body}} as Task&{batch5?:Batch5TaskState};
  const channel={id:spec.id,domain:spec.domain,automation:'api',accountRequired:false,articleRequired:true,kind:'article'} as Channel;
  const context={task,site,channel,signal:new AbortController().signal,batch5Persistence:persistence,batch5Dependencies:deps,
    checkpoint:(partial:Partial<Task>)=>Object.assign(task,partial)} as unknown as ExecutionContext&{batch5Persistence:Batch5Persistence;batch5Dependencies:Batch5Dependencies};
  return {context,task};
}
function markdown(){return `# 独立金融知识说明\n\n核对资料与风险\n\n${body}\n`}
function success(spec:Spec){return spec.id==='yeetmd'?{id:spec.idValue,url:spec.publicUrl,deleteToken:'opaque-delete-token-123'}:{slug:spec.idValue,url:spec.publicUrl,raw_url:`${spec.publicUrl}.md`}}
function transport(spec:Spec,requests:Array<{method:string;url:string;body?:string}>,options:{postStatus?:number;publicStatus?:number;rawStatus?:number;robotsStatus?:number;noindex?:boolean;badLink?:boolean;unknown?:boolean}={}){
  return async(url:string,init:RequestInit):Promise<Response>=>{
    const method=init.method??'GET',requestBody=typeof init.body==='string'?init.body:undefined;requests.push({method,url,...(requestBody?{body:requestBody}:{})});
    if(method==='POST'){
      assert.equal(url,`${spec.origin}${spec.path}`);
      assert.equal(requestBody,spec.id==='yeetmd'?JSON.stringify({content:markdown()}):markdown());
      assert.equal(new Headers(init.headers).get('content-type'),spec.id==='yeetmd'?'application/json':'text/markdown; charset=utf-8');
      if(options.unknown)throw Error('synthetic network loss');
      return new Response(JSON.stringify(options.postStatus===429?{error:'rate_limit'}:success(spec)),{status:options.postStatus??201,headers:{'content-type':'application/json'}});
    }
    assert.equal(method,'GET');
    if(url===`${spec.origin}/robots.txt`)return new Response('User-agent: *\nAllow: /\n',{status:options.robotsStatus??200,headers:{'content-type':'text/plain'}});
    if(url===`${spec.publicUrl}.md`)return new Response(markdown(),{status:options.rawStatus??200,headers:{'content-type':'text/markdown'}});
    assert.equal(url,spec.publicUrl);
    const source=options.badLink?markdown().replace('https://example.com/','https://other.example.com/'):markdown();
    const html=`<html><head><link rel="canonical" href="${spec.publicUrl}">${options.noindex?'<meta name="robots" content="noindex">':''}</head><body><article class="prose">${marked.parse(source,{async:false,gfm:true})}</article></body></html>`;
    return new Response(html,{status:options.publicStatus??200,headers:{'content-type':'text/html'}});
  };
}

for(const spec of specs){
  test(`${spec.id}: authorization loss after journaling prevents the remote create`,async()=>{
    const store=journal(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(spec,requests),now:()=>new Date(stamp)};
    store.persistence.assertReadyToSubmit=async()=>{throw Error('authorization changed')};
    const {context}=fixture(spec,store.persistence,deps),result=await runBatch5DirectTask(context);
    assert.equal(result.failureKind,'unknown');assert.ok(store.read().intent);assert.equal(requests.filter(value=>value.method==='POST').length,0);
  });
  test(`${spec.id}: success stores encrypted-only raw receipt and verifies exact public article`,async()=>{
    const store=journal(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(spec,requests),now:()=>new Date(stamp)};
    const {context,task}=fixture(spec,store.persistence,deps),result=await runBatch5DirectTask(context);
    assert.equal(result.status,'review');assert.equal(result.publicUrl,spec.publicUrl);assert.equal(result.batch5?.stage,'api_receipt');
    assert.equal(result.checkpoint,`batch5_${spec.id}_api_receipt`);
    assert.equal(requests.filter(value=>value.method==='POST').length,1);assert.ok(requests.filter(value=>value.method==='GET').length>=2);
    assert.equal(store.read().receipt?.rawResponse,JSON.stringify(success(spec)));
    assert.equal(JSON.stringify(task).includes('opaque-delete-token-123'),false);
    assert.equal((await verifyBatch5DirectPublication(task,site,site.url,store.persistence,deps)).found,true);
  });
  test(`${spec.id}: 429 is classified and its durable intent blocks repeat POST`,async()=>{
    const store=journal(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(spec,requests,{postStatus:429}),now:()=>new Date(stamp)};
    const {context}=fixture(spec,store.persistence,deps),first=await runBatch5DirectTask(context),second=await runBatch5DirectTask(context);
    assert.equal(first.failureKind,'rate_limited');assert.equal(first.status,'failed');assert.equal(second.status,'review');assert.equal(requests.filter(value=>value.method==='POST').length,1);assert.ok(store.read().intent);
  });
  test(`${spec.id}: unknown result and restart remain read-only`,async()=>{
    const store=journal(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(spec,requests,{unknown:true}),now:()=>new Date(stamp)};
    const first=fixture(spec,store.persistence,deps),result=await runBatch5DirectTask(first.context);assert.equal(result.failureKind,'unknown');
    const resumed=fixture(spec,store.persistence,deps);resumed.task.batch5=result.batch5;resumed.task.submittedAt=result.submittedAt;
    const recovered=await reconcileBatch5DirectTask(resumed.context),again=await runBatch5DirectTask(resumed.context);
    assert.equal(recovered.status,'unknown');assert.equal(again.status,'review');assert.equal(requests.filter(value=>value.method==='POST').length,1);
  });
  test(`${spec.id}: opaque success survives restart and promotes receipt with GET only`,async()=>{
    const store=journal(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(spec,requests),now:()=>new Date(stamp)};
    const first=fixture(spec,store.persistence,deps);let fail=true;const saveReceipt=store.persistence.saveReceipt;
    store.persistence.saveReceipt=async value=>{if(fail){fail=false;throw Error('synthetic vault interruption')}await saveReceipt(value)};
    const initial=await runBatch5DirectTask(first.context);assert.equal(initial.batch5?.stage,'opaque_response');
    const resumed=fixture(spec,store.persistence,deps);resumed.task.batch5=initial.batch5;resumed.task.submittedAt=initial.submittedAt;
    const recovered=await reconcileBatch5DirectTask(resumed.context);assert.equal(recovered.status,'found');assert.ok(store.read().receipt);
    if(recovered.status==='found')assert.equal(recovered.batch5.stage,'api_receipt');
    assert.equal(requests.filter(value=>value.method==='POST').length,1);
  });
  test(`${spec.id}: noindex or missing target fails public verification`,async()=>{
    for(const options of [{noindex:true},{badLink:true}]){
      const store=journal(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(spec,requests,options),now:()=>new Date(stamp)};
      const {context,task}=fixture(spec,store.persistence,deps),result=await runBatch5DirectTask(context);
      assert.equal(result.failureKind,'verification_failed');assert.equal(result.batch5?.stage,'api_receipt');
      assert.equal((await verifyBatch5DirectPublication(task,site,site.url,store.persistence,deps)).found,false);
    }
  });
  test(`${spec.id}: transient public or robots read does not count as trial verification failure`,async()=>{
    for(const options of [{publicStatus:503},{robotsStatus:503}]){
      const store=journal(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(spec,requests,options),now:()=>new Date(stamp)};
      const result=await runBatch5DirectTask(fixture(spec,store.persistence,deps).context);
      assert.equal(result.status,'review');assert.equal(result.batch5?.stage,'api_receipt');assert.equal(result.failureKind,undefined);
    }
  });
  test(`${spec.id}: first public 404/410 stays pending without a platform failure`,async()=>{
    for(const publicStatus of [404,410]){
      const store=journal(),requests:Array<{method:string;url:string;body?:string}>=[];
      const deps={fetch:transport(spec,requests,{publicStatus}),now:()=>new Date(stamp)};
      const {context,task}=fixture(spec,store.persistence,deps);
      const result=await runBatch5DirectTask(context);
      assert.equal(result.status,'review');
      assert.equal(result.batch5?.stage,'api_receipt');
      assert.equal(result.failureKind,undefined);
      const verification=await verifyBatch5DirectPublication(task,site,site.url,store.persistence,deps);
      assert.equal(verification.outcome,'absent');
    }
  });
  test(`${spec.id}: definite 4xx classes retain terminal checkpoint`,async()=>{
    for(const [status,kind] of [[400,'format_invalid'],[401,'account_handoff'],[403,'provider_rejected'],[429,'rate_limited']] as const){
      const store=journal(),requests:Array<{method:string;url:string;body?:string}>=[],deps={fetch:transport(spec,requests,{postStatus:status}),now:()=>new Date(stamp)};
      const result=await runBatch5DirectTask(fixture(spec,store.persistence,deps).context);
      assert.equal(result.status,'failed');assert.equal(result.failureKind,kind);assert.equal(result.checkpoint,'batch5_rejected');
      assert.ok(store.read().intent);
    }
  });
}

test('markdownpage raw 403 and 429 are temporary read failures',async()=>{
  const spec=specs[1];
  for(const rawStatus of [403,429]){
    const store=journal(),requests:Array<{method:string;url:string;body?:string}>=[];
    const deps={fetch:transport(spec,requests,{rawStatus}),now:()=>new Date(stamp)};
    const {context,task}=fixture(spec,store.persistence,deps);
    const result=await runBatch5DirectTask(context);
    assert.equal(result.status,'review');
    assert.equal(result.batch5?.stage,'api_receipt');
    assert.equal(result.failureKind,undefined);
    const verification=await verifyBatch5DirectPublication(task,site,site.url,store.persistence,deps);
    assert.equal(verification.found,false);
    assert.equal(verification.outcome,'unreachable');
  }
});

test('direct verifier treats missing or unreadable local journal as unreachable',async()=>{
  for(const spec of specs){
    const empty=journal(),requests:Array<{method:string;url:string;body?:string}>=[];
    const deps={fetch:transport(spec,requests),now:()=>new Date(stamp)};
    const first=fixture(spec,empty.persistence,deps);
    let result=await verifyBatch5DirectPublication(first.task,site,site.url,empty.persistence,deps);
    assert.equal(result.found,false);
    assert.equal(result.outcome,'unreachable');
    empty.persistence.loadIntent=async()=>{throw Error('local journal unavailable')};
    result=await verifyBatch5DirectPublication(first.task,site,site.url,empty.persistence,deps);
    assert.equal(result.found,false);
    assert.equal(result.outcome,'unreachable');
  }
});
