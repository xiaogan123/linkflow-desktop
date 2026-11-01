import test from 'node:test';
import assert from 'node:assert/strict';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {defaultSettings} from '../src/main/store';
import {probeCloudflarePagesConnection,runCloudflarePagesTask,reconcileCloudflarePagesTask,verifyCloudflarePagesPublication} from '../src/integrations/cloudflare-pages';
import type {Batch5Intent,Batch5OpaqueResponse,Batch5Persistence,Batch5Receipt} from '../src/integrations/batch5-contract';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const NOW='2026-10-29T10:00:00.000Z';
const ACCOUNT='a'.repeat(32),TOKEN_ID='b'.repeat(32),PROJECT_ID='12345678-1234-1234-1234-123456789abc';
const DEPLOY_ID='87654321-4321-4321-4321-cba987654321',NAME='software-guide-pages';
const TARGET='https://example.com/software-guide',URL=`https://${NAME}.pages.dev/`;
const API='https://api.cloudflare.com/client/v4';
const PROJECT_PATH=`${API}/accounts/${ACCOUNT}/pages/projects/${NAME}`;
const BODY=`This software guide explains how to compare release notes and reproduce a configuration. Read the [original software guide](${TARGET}) for the maintained steps.\n\nThe example discusses limitations and provides practical troubleshooting steps.`;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const ok=(result:unknown)=>json({success:true,result,errors:[],messages:[]});

class Journal implements Batch5Persistence{
  intent?:Batch5Intent;receipt?:Batch5Receipt;opaque?:Batch5OpaqueResponse;task?:Task;block=false;
  async saveIntent(value:Batch5Intent){this.intent=value}
  async reserveIntent(value:Batch5Intent){this.intent=value}
  async markSending(value:Batch5Intent){if(this.block||value.operationId!==this.intent?.operationId)throw Error('blocked')}
  async assertReadyToSubmit(value:Batch5Intent){if(this.block||value.operationId!==this.intent?.operationId)throw Error('blocked')}
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
  const channel:Channel={id:'cloudflare-pages',name:'Cloudflare Pages',domain:'pages.dev',url:'https://pages.cloudflare.com/',submitUrl:PROJECT_PATH,
    categories:['software'],languages:['*'],kind:'article',emailRequired:false,accountRequired:true,articleRequired:true,free:'yes',freeNote:'',
    automation:'api',quality:'C',qualityReason:'',rulesUrl:'https://www.cloudflare.com/terms/',checkedAt:NOW,notes:'',allowedHosts:['pages.dev'],enabled:true};
  const account:Account={id:'account-1',channelId:channel.id,username:ACCOUNT,email:'',status:'registered',hasPassword:true,
    credentialKind:'api_token',createdAt:NOW,ownerSiteId:site.id,publicationUrl:URL};
  const settings={...defaultSettings(),articleReviewMode:'ai' as const};
  const task:Task={id:'task-1',siteId:site.id,channelId:channel.id,accountId:account.id,sourceDomain:channel.domain,status:'running',
    createdAt:NOW,scheduledAt:NOW,updatedAt:NOW,attempts:1,message:'',topicUrl:TARGET,draftRevision:1,
    draft:{title:'How to verify a software release',description:'A practical software documentation guide.',body:BODY}};
  task.articleReview={status:'passed',reason:'passed',draftRevision:1,contentHash:articleContentHash(task),
    contextHash:articleContextHash(site,channel,settings,account,4),evidenceUrls:[],reviewContractVersion:4};
  const journal=new Journal();journal.task=task;
  const secrets=new Map([[`account:${account.id}`,JSON.stringify({version:1,apiToken:'cloudflare-token-123456',accountId:ACCOUNT,
    projectName:NAME,projectId:PROJECT_ID,tokenId:TOKEN_ID,productionBranch:'main'})]]);
  const context:ExecutionContext={site,channel,task,settings,signal:new AbortController().signal,ai:{json:async<T>()=>({} as T)},
    secrets:{get:async key=>secrets.get(key),set:async(key,value)=>{secrets.set(key,value)},delete:async key=>{secrets.delete(key)}},
    getAccount:()=>account,saveAccount:async()=>undefined,checkpoint:partial=>{Object.assign(task,partial)},log:()=>undefined,batch5Persistence:journal};
  return {context,journal,task,account};
}
function project(id=PROJECT_ID,empty=true){return {id,name:NAME,subdomain:`${NAME}.pages.dev`,production_branch:'main',source:null,
  canonical_deployment:empty?null:{id:DEPLOY_ID},latest_deployment:empty?null:{id:DEPLOY_ID}}}
function deployment(){return {id:DEPLOY_ID,project_id:PROJECT_ID,project_name:NAME,environment:'production',latest_stage:{name:'deploy',status:'success'},is_skipped:false}}
function server(opts:{occupied?:boolean;lostAt?:'upload'|'deployment';htmlType?:string;robotsHeader?:string;wrongProject?:boolean;
  secondBranch?:string;onSecondProbe?:()=>void;stageName?:string}={}){
  let uploads=0,deploys=0,publicHtml='',robots='';
  const fetch=async(url:string,init:RequestInit):Promise<Response>=>{
    if(url===`${API}/user/tokens/verify`)return ok({id:TOKEN_ID,status:'active'});
    if(url===PROJECT_PATH&&init.method==='GET')return ok({...project(opts.wrongProject?'00000000-0000-0000-0000-000000000000':PROJECT_ID,!(opts.occupied||deploys)),
      ...(uploads&&opts.secondBranch?{production_branch:opts.secondBranch}:{})});
    if(url===`${PROJECT_PATH}/deployments?per_page=1&page=1`){if(uploads&&!deploys)opts.onSecondProbe?.();return ok(opts.occupied||deploys?[deployment()]:[])}
    if(url===`${PROJECT_PATH}/upload-token`)return ok({jwt:'short-lived-jwt-123456'});
    if(url===`${API}/pages/assets/upload`&&init.method==='POST'){
      uploads++;assert.ok((init.headers as Record<string,string>).authorization?.startsWith('Bearer short-lived-jwt'));
      const assets=JSON.parse(String(init.body)) as Array<{key:string;value:string;metadata:{contentType:string}}>;
      assert.equal(assets.length,2);assert.match(assets[0].key,/^[a-f0-9]{32}$/);assert.equal(assets[0].metadata.contentType,'text/html');
      publicHtml=Buffer.from(assets[0].value,'base64').toString('utf8');robots=Buffer.from(assets[1].value,'base64').toString('utf8');
      if(opts.lostAt==='upload')throw Error('lost upload response');return json({success:true});
    }
    if(url===`${PROJECT_PATH}/deployments`&&init.method==='POST'){
      deploys++;assert.ok(init.body instanceof FormData);const form=init.body as FormData;
      const manifest=JSON.parse(String(form.get('manifest'))) as Record<string,string>;
      assert.deepEqual(Object.keys(manifest),['/index.html','/robots.txt']);assert.equal(form.get('branch'),'main');
      if(opts.lostAt==='deployment')throw Error('lost deployment response');return ok(deployment());
    }
    if(url===`${PROJECT_PATH}/deployments/${DEPLOY_ID}`)return ok({...deployment(),latest_stage:{name:opts.stageName??'deploy',status:'success'}});
    if(url===URL)return new Response(publicHtml,{status:200,headers:{'content-type':opts.htmlType??'text/html; charset=utf-8',
      ...(opts.robotsHeader?{'x-robots-tag':opts.robotsHeader}:{})}});
    if(url===`${URL}robots.txt`)return new Response(robots,{status:200,headers:{'content-type':'text/plain'}});
    throw Error(`Unexpected ${init.method} ${url}`);
  };
  return {fetch,counts:()=>({uploads,deploys}),html:()=>publicHtml};
}

test('Cloudflare fixed empty project deploys manifest once and accepts exact public HTML',async()=>{
  const f=fixture(),s=server();f.context.batch5Dependencies={fetch:s.fetch,now:()=>new Date(NOW)};
  const probe=await probeCloudflarePagesConnection('cloudflare-token-123456',ACCOUNT,NAME,f.context.batch5Dependencies);
  assert.equal(probe.empty,true);assert.equal(probe.projectId,PROJECT_ID);
  const sent=await runCloudflarePagesTask(f.context);assert.equal(sent.status,'review');assert.equal(s.counts().uploads,1);assert.equal(s.counts().deploys,1);
  assert.equal(f.journal.receipt?.remoteId,DEPLOY_ID);assert.equal(f.journal.opaque?.responseUrl,`${PROJECT_PATH}/deployments`);
  assert.equal((s.html().match(/href="https:\/\/example.com\/software-guide"/g)??[]).length,1);
  assert.equal(s.html().includes(f.journal.intent!.operationId),false);assert.equal(s.html().includes(f.task.id),false);
  assert.equal((await verifyCloudflarePagesPublication(f.context)).found,true);
  assert.equal((await runCloudflarePagesTask(f.context)).status,'review');assert.equal(s.counts().deploys,1);
});

test('Cloudflare refuses an occupied or differently bound project before either POST',async()=>{
  for(const opts of [{occupied:true},{wrongProject:true}]){
    const f=fixture(),s=server(opts);f.context.batch5Dependencies={fetch:s.fetch};
    assert.equal((await runCloudflarePagesTask(f.context)).status,'needs_input');assert.deepEqual(s.counts(),{uploads:0,deploys:0});
  }
});

test('Cloudflare lost upload or deployment outcome remains unknown and never retries POST',async()=>{
  for(const lostAt of ['upload','deployment'] as const){
    const f=fixture(),s=server({lostAt});f.context.batch5Dependencies={fetch:s.fetch};
    assert.equal((await runCloudflarePagesTask(f.context)).reasonCode,'submission_unknown');
    assert.equal((await reconcileCloudflarePagesTask(f.context)).status,'unknown');
    assert.equal((await runCloudflarePagesTask(f.context)).reasonCode,'submission_unknown');
    assert.equal(s.counts().uploads,1);assert.equal(s.counts().deploys,lostAt==='deployment'?1:0);
  }
});

test('Cloudflare rechecks authorization and production branch after the second GET probe, before deployment POST',async()=>{
  for(const mode of ['authorization','branch'] as const){
    const f=fixture(),s=server(mode==='authorization'?{onSecondProbe:()=>{f.journal.block=true}}:{secondBranch:'staging'});
    f.context.batch5Dependencies={fetch:s.fetch};
    assert.equal((await runCloudflarePagesTask(f.context)).reasonCode,'submission_unknown');
    assert.equal(s.counts().uploads,1);assert.equal(s.counts().deploys,0);
    assert.equal((await runCloudflarePagesTask(f.context)).reasonCode,'submission_unknown');
  }
});

test('Cloudflare only accepts a successful deploy stage, not another successful stage',async()=>{
  const f=fixture(),s=server({stageName:'build'});f.context.batch5Dependencies={fetch:s.fetch};
  assert.equal((await runCloudflarePagesTask(f.context)).status,'review');
  assert.equal((await verifyCloudflarePagesPublication(f.context)).found,false);
});

test('Cloudflare old exact receipt remains GET-reconcilable after review permission expires',async()=>{
  const f=fixture(),s=server();f.context.batch5Dependencies={fetch:s.fetch};
  assert.equal((await runCloudflarePagesTask(f.context)).status,'review');
  f.task.articleReview=undefined;
  assert.equal((await reconcileCloudflarePagesTask(f.context)).status,'found');
  assert.equal(s.counts().deploys,1);
});

test('Cloudflare rejects public text/plain and scoped robots none',async()=>{
  for(const opts of [{htmlType:'text/plain'},{robotsHeader:'googlebot:none'},{robotsHeader:'googlebot:noindex'}]){
    const f=fixture(),s=server(opts);f.context.batch5Dependencies={fetch:s.fetch};
    assert.equal((await runCloudflarePagesTask(f.context)).status,'review');
    assert.equal((await verifyCloudflarePagesPublication(f.context)).found,false);
  }
});

test('Cloudflare only recovers exact saved deployment response, never merely matching project content',async()=>{
  const f=fixture(),s=server();f.context.batch5Dependencies={fetch:s.fetch};
  const saveReceipt=f.journal.saveReceipt.bind(f.journal);f.journal.saveReceipt=async()=>{throw Error('vault unavailable')};
  assert.equal((await runCloudflarePagesTask(f.context)).reasonCode,'submission_unknown');
  f.journal.saveReceipt=saveReceipt;
  assert.equal((await reconcileCloudflarePagesTask(f.context)).status,'found');
  assert.equal(f.journal.receipt?.remoteId,DEPLOY_ID);assert.equal(s.counts().deploys,1);
  const other=fixture();const otherServer=server({occupied:true});other.context.batch5Dependencies={fetch:otherServer.fetch};
  other.journal.intent=f.journal.intent;
  assert.equal((await reconcileCloudflarePagesTask(other.context)).status,'unknown');
});
