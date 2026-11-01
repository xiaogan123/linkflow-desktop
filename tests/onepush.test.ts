import test from 'node:test';
import assert from 'node:assert/strict';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {defaultSettings} from '../src/main/store';
import {onePushKeyIdentity,probeOnePushConnection,runOnePushTask,reconcileOnePushTask,verifyOnePushPublication,onePushTesting} from '../src/integrations/onepush';
import type {Batch5Intent,Batch5OpaqueResponse,Batch5Persistence,Batch5Receipt} from '../src/integrations/batch5-contract';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const NOW='2026-10-31T09:00:00.000Z',KEY='sk_synthetic_key_123456',TARGET='https://example.com/software-guide';
const URL='https://reviewed-guide.onepu.sh/',SLUG='reviewed-guide',UPDATE='tok_synthetic_update_123456';
const SITE_ID='11111111-1111-4111-8111-111111111111',USER_ID='22222222-2222-4222-8222-222222222222';
const storage=`https://bujjdijsowgzgaegrvau.supabase.co/storage/v1/object/public/sites/${SLUG}/v1/robots.txt`;
const owned=()=>({id:SITE_ID,slug:SLUG,url:URL,current_version:1,access_level:'public',expires_at:null,site_versions:[{version:1,pushed_by:USER_ID}]});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
class Journal implements Batch5Persistence {
 intent?:Batch5Intent;receipt?:Batch5Receipt;opaque?:Batch5OpaqueResponse;task?:Task;
 async saveIntent(value:Batch5Intent){this.intent=value}
 async reserveIntent(value:Batch5Intent){assert.equal(this.intent,undefined);this.intent=value}
 async markSending(value:Batch5Intent){assert.equal(this.intent?.operationId,value.operationId)}
 async assertReadyToSubmit(value:Batch5Intent){assert.equal(this.intent?.operationId,value.operationId)}
 async loadIntent(){return this.intent}
 async saveReceipt(value:Batch5Receipt){this.receipt=value}
 async loadReceipt(){return this.receipt}
 async saveOpaqueResponse(value:Batch5OpaqueResponse){this.opaque=value}
 async loadOpaqueResponse(){return this.opaque}
 currentTaskState(){return this.task?.batch5}
}
function fixture(){
 const site:Site={id:'site-1',domain:'example.com',url:'https://example.com/',email:'',name:'Example software',description:'Software documentation',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:NOW};
 const channel:Channel={id:'onepush',name:'OnePush',domain:'onepu.sh',url:'https://www.onepu.sh/',submitUrl:'https://www.onepu.sh/api/v1/push',categories:['software'],languages:['*'],kind:'article',emailRequired:false,accountRequired:true,articleRequired:true,free:'yes',freeNote:'',automation:'api',quality:'C',qualityReason:'',rulesUrl:'https://www.onepu.sh/terms',checkedAt:NOW,notes:'',allowedHosts:['onepu.sh'],enabled:true};
 const account:Account={id:'account-1',channelId:'onepush',username:onePushKeyIdentity(KEY),email:'',status:'registered',hasPassword:true,credentialKind:'api_token',createdAt:NOW};
 const settings={...defaultSettings(),articleReviewMode:'ai' as const};
 const task:Task={id:'task-1',siteId:site.id,channelId:'onepush',accountId:account.id,sourceDomain:channel.domain,status:'running',createdAt:NOW,scheduledAt:NOW,updatedAt:NOW,attempts:1,message:'',topicUrl:TARGET,draftRevision:1,
  draft:{title:'How to verify a software release',description:'A practical software guide.',body:`Compare release notes and reproduce the configuration. Read the [original software guide](${TARGET}) for the maintained steps.\n\nThe example explains limitations and practical troubleshooting steps.`}};
 task.articleReview={status:'passed',reason:'passed',draftRevision:1,contentHash:articleContentHash(task),contextHash:articleContextHash(site,channel,settings,account,4),evidenceUrls:[],reviewContractVersion:4};
 const journal=new Journal();journal.task=task;
 const secrets=new Map([[`account:${account.id}`,JSON.stringify({version:1,apiKey:KEY})]]);
 const context:ExecutionContext={site,channel,task,settings,signal:new AbortController().signal,ai:{json:async<T>()=>({} as T)},secrets:{get:async key=>secrets.get(key),set:async(key,value)=>{secrets.set(key,value)},delete:async key=>{secrets.delete(key)}},getAccount:()=>account,saveAccount:async()=>undefined,checkpoint:partial=>{Object.assign(task,partial)},log:()=>undefined,batch5Persistence:journal};
 const state={posts:0,gets:0,html:'',request:undefined as Record<string,unknown>|undefined,created:false,status:201,loss:false,list:undefined as unknown,
  receipt:{url:URL.slice(0,-1),slug:SLUG,updateToken:UPDATE} as Record<string,unknown>,detail:{...owned(),url:`https://onepu.sh/s/${SLUG}`,user_id:USER_ID,team_id:null,password_hash:null} as Record<string,unknown>,
  robotsRedirect:'' as string,storageRedirect:false,pageStatus:200,contentType:'text/html',robotsHeader:'',robotsResourceHeader:'',robots:'User-agent: *\nAllow: /\n',pageTransform:(body:string)=>body};
 context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
  assert.equal(init.redirect,url===URL+'robots.txt'?'manual':'error');assert.equal(init.credentials,'omit');
  if(url==='https://www.onepu.sh/api/v1/publish'){
   state.gets++;assert.equal(init.method,'GET');assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${KEY}`);
   return json(state.list??{sites:state.created?[owned()]:[]});
  }
  if(url==='https://www.onepu.sh/api/v1/push'){
   state.posts++;assert.equal(init.method,'POST');assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${KEY}`);
   assert.equal(task.batch5?.stage,'submitting');assert.ok(journal.intent);
   state.request=JSON.parse(String(init.body));state.html=(state.request!.files as Record<string,string>)['index.html'];state.created=true;
   if(state.loss)throw Error('response lost');return json(state.receipt,state.status);
  }
  state.gets++;assert.equal(init.method,'GET');assert.equal(new Headers(init.headers).has('authorization'),false);
  if(url===`https://www.onepu.sh/api/v1/publish/${SLUG}`)return json(state.detail);
  if(url===URL)return new Response(state.pageTransform(state.html),{status:state.pageStatus,headers:{'content-type':state.contentType,'x-robots-tag':state.robotsHeader}});
  if(url===URL+'robots.txt')return state.robotsRedirect?new Response('',{status:302,headers:{location:state.robotsRedirect,'x-robots-tag':state.robotsResourceHeader}}):new Response(state.robots,{headers:{'content-type':'text/plain','x-robots-tag':state.robotsResourceHeader}});
  if(url===storage)return state.storageRedirect?new Response('',{status:302,headers:{location:'https://other.example/robots.txt'}}):new Response(state.robots,{headers:{'content-type':'text/plain','x-robots-tag':state.robotsResourceHeader}});
  throw Error(`Unexpected ${url}`);
 }};
 return {context,journal,task,account,secrets,state};
}

test('OnePush key probe proves only accepted credential fingerprint and site count',async()=>{
 const f=fixture(),probe=await probeOnePushConnection(KEY,f.context.batch5Dependencies);
 assert.deepEqual(probe,{username:onePushKeyIdentity(KEY),siteCount:0});assert.equal('email'in probe,false);assert.equal(f.state.posts,0);
 for(const malformed of [{},[],{sites:null},{sites:[{}]},{sites:Array.from({length:11},(_,i)=>({slug:`site-${i}`}))}]){
  f.state.list=malformed;await assert.rejects(probeOnePushConnection(KEY,f.context.batch5Dependencies));
 }
});

test('OnePush creates one authenticated fresh site, keeps its update token in the private journal, and verifies exact anonymous files',async()=>{
 for(const status of [200,201]){
  const f=fixture();f.state.status=status;
  const result=await runOnePushTask(f.context);assert.equal(result.publicUrl,URL);assert.equal(f.state.posts,1);
  assert.deepEqual(Object.keys(f.state.request!),['files','name']);assert.deepEqual(Object.keys(f.state.request!.files as object),['index.html','robots.txt']);
  assert.equal(f.journal.receipt?.secret,UPDATE);assert.ok(f.journal.opaque?.bodyBase64);
  assert.equal(JSON.stringify(f.task).includes(UPDATE),false);assert.equal(JSON.stringify(f.task).includes(KEY),false);
  assert.equal(f.state.html.includes(f.account.username),false);assert.equal(f.state.html.includes(f.journal.intent!.operationId),false);
  assert.equal((f.state.html.match(/href="https:\/\/example.com\/software-guide"/g)??[]).length,1);
  const verified=await verifyOnePushPublication(f.context);assert.equal(verified.found,true);assert.equal(verified.indexable,true);
  f.task.articleReview=undefined;assert.equal((await reconcileOnePushTask(f.context)).status,'found');
  await runOnePushTask(f.context);assert.equal(f.state.posts,1);
 }
});

test('OnePush refuses missing review, key mismatch, capacity and final authorization changes before POST',async()=>{
 for(const changed of ['review','key','capacity','draft-after-reserve','review-after-sending','key-after-sending','identity-after-sending'] as const){
  const f=fixture();
  if(changed==='review')f.task.articleReview=undefined;
  if(changed==='key')f.secrets.set(`account:${f.account.id}`,JSON.stringify({version:1,apiKey:'sk_another_key_123456'}));
  if(changed==='capacity')f.state.list={sites:Array.from({length:10},(_,i)=>({slug:`site-${i}`}))};
  if(changed==='draft-after-reserve'){const reserve=f.journal.reserveIntent.bind(f.journal);f.journal.reserveIntent=async intent=>{await reserve(intent);f.task.draft!.body+=' changed'}}
  if(changed.endsWith('after-sending'))f.journal.markSending=async()=>{
   if(changed==='review-after-sending')f.task.articleReview=undefined;
   if(changed==='key-after-sending')f.secrets.set(`account:${f.account.id}`,JSON.stringify({version:1,apiKey:'sk_another_key_123456'}));
   if(changed==='identity-after-sending')f.account.username=onePushKeyIdentity('sk_another_key_123456');
  };
  const result=await runOnePushTask(f.context);assert.ok(result.status==='needs_input'||result.reasonCode==='submission_unknown',changed);assert.equal(f.state.posts,0,changed);
 }
});

test('OnePush lost response cannot be recovered from an identical owner-list site and never retries',async()=>{
 const f=fixture();f.state.loss=true;
 assert.equal((await runOnePushTask(f.context)).reasonCode,'submission_unknown');
 assert.equal(f.state.created,true);assert.equal((await reconcileOnePushTask(f.context)).status,'unknown');
 await runOnePushTask(f.context);assert.equal(f.state.posts,1);assert.equal(f.journal.receipt,undefined);
});

test('OnePush exact opaque response recovers a failed receipt save without another publication',async()=>{
 const f=fixture(),save=f.journal.saveReceipt.bind(f.journal);f.journal.saveReceipt=async()=>{throw Error('disk failed')};
 assert.equal((await runOnePushTask(f.context)).reasonCode,'submission_unknown');
 f.journal.saveReceipt=save;assert.equal((await reconcileOnePushTask(f.context)).status,'found');assert.equal(f.state.posts,1);
 assert.equal(f.journal.receipt?.secret,UPDATE);
});

test('OnePush anonymous, updated, foreign or incomplete receipts stay unknown without retries',async()=>{
 for(const altered of [{claimUrl:'https://www.onepu.sh/claim/private'},{claimUrl:null},{expiresIn:'24 hours'},{expires_at:NOW},
  {updated:true},{updated:'true'},{version:2},{url:'https://evil.example/'},{url:'https://reviewed-guide.onepu.sh/path'},
  {url:'https://other-slug.onepu.sh/'},{url:'https://user:password@reviewed-guide.onepu.sh/'},{updateToken:''}]){
  const f=fixture();Object.assign(f.state.receipt,altered);
  assert.equal((await runOnePushTask(f.context)).reasonCode,'submission_unknown',JSON.stringify(altered));
  assert.equal((await reconcileOnePushTask(f.context)).status,'unknown');await runOnePushTask(f.context);assert.equal(f.state.posts,1);
 }
});

test('OnePush requires exact owner membership, details, public document and robots',async()=>{
 for(const changed of ['not-owned','duplicate-owner','details-slug','details-wrapper','expired','private','version','body','native-link','plain','401','noindex','scoped-none','robots'] as const){
  const f=fixture();await runOnePushTask(f.context);
  if(changed==='not-owned')f.state.list={sites:[]};
  if(changed==='duplicate-owner')f.state.list={sites:[{slug:SLUG},{slug:SLUG}]};
  if(changed==='details-slug')f.state.detail.slug='other-site';
  if(changed==='details-wrapper')f.state.detail={site:f.state.detail};
  if(changed==='expired')f.state.detail.expires_at=NOW;
  if(changed==='private')f.state.detail.access_level='password';
  if(changed==='version')f.state.detail.version=2;
  if(changed==='body')f.state.pageTransform=body=>body.replace('Compare release notes','Changed release notes');
  if(changed==='native-link')f.state.pageTransform=body=>body.replace(`href="${TARGET}"`,`data-href="${TARGET}"`);
  if(changed==='plain')f.state.contentType='text/plain';
  if(changed==='401')f.state.pageStatus=401;
  if(changed==='noindex')f.state.robotsHeader='noindex';
  if(changed==='scoped-none')f.state.robotsHeader='googlebot: none';
  if(changed==='robots')f.state.robots='User-agent: *\nDisallow: /\n';
  assert.equal((await verifyOnePushPublication(f.context)).found,false,changed);assert.equal(f.state.posts,1);
 }
});

test('OnePush binds frozen intent to both approved document and original key identity',async()=>{
 for(const changed of ['draft','identity','opaque-intent','receipt-url','receipt-secret'] as const){
  const f=fixture();await runOnePushTask(f.context);
  if(changed==='draft')f.task.draft!.body+=' changed';
  if(changed==='identity'){const next='sk_another_key_123456';f.account.username=onePushKeyIdentity(next);f.secrets.set(`account:${f.account.id}`,JSON.stringify({version:1,apiKey:next}))}
  if(changed==='opaque-intent'){f.journal.receipt=undefined;f.journal.opaque!.intent={...f.journal.intent!,operationId:'other'}}
  if(changed==='receipt-url')f.journal.receipt!.publicUrl='https://other-site.onepu.sh/';
  if(changed==='receipt-secret')f.journal.receipt!.secret='other-secret';
  assert.equal((await reconcileOnePushTask(f.context)).status,'unknown',changed);assert.equal(f.state.posts,1);
 }
});

test('OnePush never retries rejected, throttled or server-error responses',async()=>{
 for(const status of [400,401,403,408,409,429,500,503]){
  const f=fixture();f.state.status=status;await runOnePushTask(f.context);await runOnePushTask(f.context);
  assert.equal(f.state.posts,1,String(status));assert.equal(f.journal.receipt,undefined);
 }
});

test('OnePush document rejects extra links and non-software targets',()=>{
 const f=fixture();f.task.draft!.body+=' [other](https://other.example.com/)';assert.throws(()=>onePushTesting.document(f.context));
 const second=fixture();second.context.site.category='finance';assert.throws(()=>onePushTesting.document(second.context));
});


test('OnePush real details route requires original owner ID, publisher and immutable first version',async()=>{
 const cases:Record<string,unknown>[]=[{url:URL},{url:`https://www.onepu.sh/s/${SLUG}`},{url:`https://onepu.sh/s/${SLUG}?x=1`},{url:`https://onepu.sh/s/${SLUG}/`},{url:'https://evil.example/s/'+SLUG},{current_version:2},{current_version:undefined},{id:USER_ID},{user_id:SITE_ID},{team_id:SITE_ID},{password_hash:'private'},{site_versions:[{version:1,pushed_by:SITE_ID}]},{site_versions:[{version:2,pushed_by:USER_ID}]}];
 for(const change of cases){const f=fixture();await runOnePushTask(f.context);Object.assign(f.state.detail,change);assert.equal((await reconcileOnePushTask(f.context)).status,'unknown',JSON.stringify(change));await runOnePushTask(f.context);assert.equal(f.state.posts,1)}
 for(const change of [{current_version:2},{id:USER_ID},{site_versions:[{version:1,pushed_by:SITE_ID}]}]){const f=fixture();await runOnePushTask(f.context);f.state.list={sites:[{...owned(),...change}]};assert.equal((await reconcileOnePushTask(f.context)).status,'unknown');assert.equal(f.state.posts,1)}
});

test('OnePush accepts only exact observed head/footer injection and a single bound anonymous robots redirect',async()=>{
 const f=fixture();await runOnePushTask(f.context);f.state.pageTransform=body=>onePushTesting.hostedHtml(body,SLUG);f.state.robotsRedirect=storage;
 assert.equal((await reconcileOnePushTask(f.context)).status,'found');assert.equal(f.state.posts,1);
 for(const transform of [
  (body:string)=>onePushTesting.hostedHtml(body,SLUG).replace('Compare release notes','Different release notes'),
  (body:string)=>onePushTesting.hostedHtml(body,SLUG).replace(`href="${TARGET}"`,`data-href="${TARGET}"`),
  (body:string)=>onePushTesting.hostedHtml(body,SLUG).replace('https://onepu.sh/api/v1/analytics/event','https://evil.example/event'),
  (body:string)=>onePushTesting.hostedHtml(body,'foreign-slug'),
  (body:string)=>onePushTesting.hostedHtml(body,SLUG).replace('</head>','<meta name="robots" content="noindex"></head>'),
  (body:string)=>onePushTesting.hostedHtml(body,SLUG).replace('</body>','<script>changed()</script></body>'),
 ]){f.state.pageTransform=transform;assert.equal((await reconcileOnePushTask(f.context)).status,'unknown')}
 f.state.pageTransform=body=>onePushTesting.hostedHtml(body,SLUG);
 for(const redirect of [storage.replace('/v1/','/v2/'),storage.replace(SLUG,'foreign-slug'),storage+'?x=1',storage.replace('bujjdijsowgzgaegrvau','foreign'),URL+'robots.txt']){f.state.robotsRedirect=redirect;assert.equal((await reconcileOnePushTask(f.context)).status,'unknown')}
 f.state.robotsRedirect=storage;f.state.storageRedirect=true;assert.equal((await reconcileOnePushTask(f.context)).status,'unknown');assert.equal(f.state.posts,1);
});


test('OnePush robots resource indexing header does not override article indexing or crawl rules',async()=>{
 for(const redirected of [false,true])for(const resourceHeader of ['none','noindex']){
  const f=fixture();await runOnePushTask(f.context);f.state.robotsRedirect=redirected?storage:'';f.state.robotsResourceHeader=resourceHeader;
  assert.equal((await reconcileOnePushTask(f.context)).status,'found');
  for(const articleHeader of ['none','noindex','googlebot: none','googlebot: noindex']){f.state.robotsHeader=articleHeader;assert.equal((await reconcileOnePushTask(f.context)).status,'unknown',articleHeader)}
  f.state.robotsHeader='';f.state.robots='User-agent: *\nDisallow: /\n';assert.equal((await reconcileOnePushTask(f.context)).status,'unknown');assert.equal(f.state.posts,1);
 }
});
