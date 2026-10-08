import assert from 'node:assert/strict';
import test from 'node:test';
import {Store,emptyState} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {bindAccount,channelExecutionReadiness,unbindAccount} from '../src/main/account-bindings';
import {validateBackup} from '../src/main/backup-validation';
import {makePlan,nextTask,socialPublicationAt} from '../src/main/planner';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {channelReadinessForDisplay,taskNeedsTelegraphReconciliation} from '../src/ui/presentation';
import {CHANNELS} from '../src/integrations/catalog';
import {leafletTesting} from '../src/integrations/leaflet';
import type {Account,LeafletReceipt,Site,Snapshot,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const at='2026-10-08T00:00:00.000Z';
const siteId='11111111-1111-4111-8111-111111111111';
const otherSiteId='22222222-2222-4222-8222-222222222222';
const accountId='33333333-3333-4333-8333-333333333333';
const taskId='44444444-4444-4444-8444-444444444444';
const bindingId='55555555-5555-4555-8555-555555555555';
const did='did:plc:fixtureleaflet123',handle='writer.test',rkey='3abcdefghijkl',cid='bafyLeafletRecordCid123456789';
const profile=`https://leaflet.pub/p/${did}`,url=`${profile}/${rkey}`,uri=`at://${did}/site.standard.document/${rkey}`;
const channel=()=>{const found=CHANNELS.find(item=>item.id==='leaflet');assert.ok(found);return found};
const lucid=()=>{const found=CHANNELS.find(item=>item.id==='lucid-page');assert.ok(found);return found};
const site=(id=siteId):Site=>({id,domain:id===siteId?'example.test':'second.test',url:id===siteId?'https://example.test/':'https://second.test/',email:id===siteId?'owner@example.test':'owner@second.test',name:'Example research',description:'Original educational and financial research notes',category:'finance',language:'en',monthlyTarget:2,articleReviewMode:'ai',status:'ready',createdAt:at,analyzedAt:at,topicsCheckedAt:new Date().toISOString(),topics:[{url:id===siteId?'https://example.test/guide':'https://second.test/guide',discoveredAt:at}]});
const account=(extra:Partial<Account>={}):Account=>({id:accountId,channelId:'leaflet',email:'',username:handle,displayName:'@writer.test',publicationUrl:profile,credentialKind:'api_token',status:'registered',hasPassword:true,source:'imported',createdAt:at,updatedAt:at,verifiedAt:at,...extra});
const draft={title:'A reproducible research checklist',description:'Practical evidence review steps',body:'## Review the source\n\nUse the original evidence and record each check before reaching a conclusion. This keeps the article useful on its own and gives readers a repeatable method with enough detail to apply it carefully.\n\n## Verify the result\n\nCompare each claim against the cited page, keep the limits visible, and revisit changes over time. [Read the underlying guide](https://example.test/guide) before applying the checklist.'};
const task=(status:Task['status']='queued'):Task=>({id:taskId,siteId,channelId:'leaflet',accountId,sourceDomain:'leaflet.pub',status,createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'fixture',topicUrl:'https://example.test/guide',draft,draftRevision:1});
const recordHash=(source:Task=task(),ownerDid=did,key=rkey,createdAt=at)=>leafletTesting.buildArticle(source,site(source.siteId).url,ownerDid,key,createdAt).recordHash;
const receipt=(stage:LeafletReceipt['stage']='creating',accepted=false,source:Task=task()):LeafletReceipt=>({did,rkey,recordHash:recordHash(source),recordCreatedAt:at,stage,url,...(accepted?{uri,cid}:{})});
const binding=(boundAccountId=accountId,forSite=siteId)=>({id:bindingId,siteId:forSite,channelId:'leaflet',accountId:boundAccountId,createdAt:at,updatedAt:at});
const credential=(ownerDid=did,ownerHandle=handle)=>JSON.stringify({version:1,appPassword:'abcd-efgh-ijkl-mnop',accessJwt:'access-token-123456789',refreshJwt:'refresh-token-123456789',handle:ownerHandle,did:ownerDid});
const vault=()=>({ready:true,available:()=>true,get:async()=>credential(),set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})}) as unknown as Vault;
async function enabled<T>(run:()=>Promise<T>):Promise<T>{const entry=channel(),previous=entry.enabled;entry.enabled=true;try{return await run()}finally{entry.enabled=previous}}

test('Leaflet stays disabled by default and planning requires an explicit verified DID binding',()=>{
  assert.equal(channel().enabled,false);
  const state=emptyState(),first=site(),second=site(otherSiteId),automatic={...channel(),enabled:true};state.sites=[first,second];state.settings.timezone='UTC';state.accounts=[account()];
  assert.equal(channelExecutionReadiness(state,siteId,automatic).kind,'handoff_required');
  assert.equal(channelReadinessForDisplay(state as unknown as Snapshot,first,automatic),'handoff_required');
  const match=[{channel:automatic,score:100,reason:'fixture'}];assert.deepEqual(makePlan(state,first,match,new Date(at)),[]);
  bindAccount(state,accountId,siteId,automatic);bindAccount(state,accountId,otherSiteId,automatic);
  assert.equal(channelExecutionReadiness(state,siteId,automatic).kind,'ready');assert.equal(channelExecutionReadiness(state,otherSiteId,automatic).kind,'ready');
  assert.equal(channelReadinessForDisplay(state as unknown as Snapshot,first,automatic),'ready');assert.equal(makePlan(state,first,match,new Date(at)).length,1);assert.equal(makePlan(state,second,match,new Date(at)).length,1);
});

test('an unconnected Leaflet task does not block another ready automatic channel',()=>{
  const state=emptyState(),value=site();state.sites=[value];state.settings.timezone='UTC';state.tasks=[task(),{...task(),id:'66666666-6666-4666-8666-666666666666',channelId:'lucid-page',accountId:undefined,sourceDomain:'lucid.page'}];
  const picked=nextTask(state,new Date(at),[{...channel(),enabled:true},{...lucid(),enabled:true}]);assert.equal(picked?.channelId,'lucid-page');
});

test('one Leaflet DID enforces a 24-hour gap across bound sites',()=>{
  const state=emptyState();state.sites=[site(),site(otherSiteId)];state.accounts=[account()];state.accountBindings=[binding(),{...binding(accountId,otherSiteId),id:'77777777-7777-4777-8777-777777777777'}];state.tasks=[{...task('needs_input'),submittedAt:at,checkpoint:'leaflet_create_submitting',leaflet:receipt()}];
  assert.equal(taskNeedsTelegraphReconciliation(state.tasks[0]),true);
  const requested=new Date(Date.parse(at)+3600000);assert.equal(socialPublicationAt(state,otherSiteId,'leaflet',requested).toISOString(),new Date(Date.parse(at)+86400000).toISOString());
});

test('Leaflet backup preserves draft, receipt, cost, and secret while rejecting altered publication identity',()=>{
  const base=task('review'),published=receipt('published',true,base),state=emptyState();state.sites=[site()];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[{...base,submittedAt:at,checkpoint:'leaflet_published',leaflet:published,publicUrl:url,cost:{aiCalls:3,amount:1.25},articleApprovedAt:at,articleReview:{status:'passed',reason:'earlier independent review',reviewedAt:at,evidenceUrls:[profile],draftRevision:1,contentHash:'b'.repeat(64),contextHash:'c'.repeat(64)}}];
  const input={state,secrets:{['account:'+accountId]:credential()} as Record<string,string>};
  const restored=validateBackup(structuredClone(input));assert.deepEqual(restored.state.tasks[0].draft,draft);assert.deepEqual(restored.state.tasks[0].leaflet,published);assert.deepEqual(restored.state.tasks[0].cost,{aiCalls:3,amount:1.25});assert.equal(restored.secrets['account:'+accountId],credential());
  const otherId='88888888-8888-4888-8888-888888888888',otherDid='did:plc:replacementleaflet456';
  const mutations=[
    (copy:typeof input)=>{copy.state.accounts.push(account({id:otherId,username:'other.test',publicationUrl:`https://leaflet.pub/p/${otherDid}`}));copy.state.accountBindings[0].accountId=otherId;copy.secrets['account:'+otherId]=credential(otherDid,'other.test')},
    (copy:typeof input)=>{copy.state.tasks[0].leaflet!.did=otherDid},
    (copy:typeof input)=>{copy.state.tasks[0].leaflet!.rkey='3bcdefghijklm'},
    (copy:typeof input)=>{copy.state.tasks[0].leaflet!.recordHash='b'.repeat(64)},
    (copy:typeof input)=>{copy.state.tasks[0].leaflet!.recordCreatedAt='2026-10-08T00:00:01.000Z'},
    (copy:typeof input)=>{copy.state.tasks[0].leaflet!.uri=`at://${did}/site.standard.document/3bcdefghijklm`},
    (copy:typeof input)=>{copy.state.tasks[0].leaflet!.cid='short'},
    (copy:typeof input)=>{copy.state.tasks[0].leaflet!.url=`${profile}/3bcdefghijklm`;copy.state.tasks[0].publicUrl=copy.state.tasks[0].leaflet!.url},
  ];
  for(const mutate of mutations){const copy=structuredClone(input);mutate(copy);assert.throws(()=>validateBackup(copy))}
  const borrowed=structuredClone(input);borrowed.state.accounts[0].channelId='bluesky';assert.throws(()=>validateBackup(borrowed));
});

test('settled Leaflet history survives unbind or a future DID switch with its draft and secret intact',()=>{
  const base=task('live'),published=receipt('published',true,base),state=emptyState();state.sites=[site()];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[{...base,submittedAt:at,firstLiveAt:at,checkpoint:'leaflet_published',leaflet:published,publicUrl:url,linkCheck:'found',health:'healthy',cost:{aiCalls:3}}];
  const input={state,secrets:{['account:'+accountId]:credential()} as Record<string,string>};
  const unbound=structuredClone(input);unbindAccount(unbound.state,accountId,siteId,'leaflet');const restoredUnbound=validateBackup(unbound);assert.equal(restoredUnbound.state.accountBindings.length,0);assert.deepEqual(restoredUnbound.state.tasks[0].draft,draft);assert.deepEqual(restoredUnbound.state.tasks[0].leaflet,published);assert.equal(restoredUnbound.secrets['account:'+accountId],credential());
  const switched=structuredClone(input),replacementId='88888888-8888-4888-8888-888888888888',replacementDid='did:plc:replacementleaflet456';switched.state.accounts.push(account({id:replacementId,username:'other.test',publicationUrl:`https://leaflet.pub/p/${replacementDid}`}));switched.secrets['account:'+replacementId]=credential(replacementDid,'other.test');bindAccount(switched.state,replacementId,siteId,channel());
  const restoredSwitched=validateBackup(switched);assert.equal(restoredSwitched.state.accountBindings[0].accountId,replacementId);assert.equal(restoredSwitched.state.tasks[0].accountId,accountId);assert.deepEqual(restoredSwitched.state.tasks[0].draft,draft);assert.deepEqual(restoredSwitched.state.tasks[0].leaflet,published);assert.equal(restoredSwitched.secrets['account:'+accountId],credential());
});

test('an unresolved accepted Leaflet write pins its original binding during use and restore',()=>{
  const base=task('needs_input'),accepted=receipt('creating',true,base),state=emptyState();state.sites=[site()];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[{...base,submittedAt:at,checkpoint:'leaflet_create_accepted',leaflet:accepted,publicUrl:url}];
  assert.throws(()=>unbindAccount(state,accountId,siteId,'leaflet'),/待核验/);assert.equal(state.accountBindings[0].accountId,accountId);
  const replacementId='88888888-8888-4888-8888-888888888888',replacementDid='did:plc:replacementleaflet456',input={state,secrets:{['account:'+accountId]:credential()} as Record<string,string>};input.state.accounts.push(account({id:replacementId,username:'other.test',publicationUrl:`https://leaflet.pub/p/${replacementDid}`}));input.secrets['account:'+replacementId]=credential(replacementDid,'other.test');input.state.accountBindings[0].accountId=replacementId;
  assert.throws(()=>validateBackup(input),/回执与任务绑定不一致/);
});

test('an uncertain Leaflet create is reconciled and verified without another write',async()=>enabled(async()=>{
  const base=task('needs_input'),accepted=receipt('creating',true,base),published={...accepted,stage:'published' as const};
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='leaflet']));state.sites=[site()];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[{...base,submittedAt:at,checkpoint:'leaflet_create_accepted',leaflet:accepted,publicUrl:url}]});
  let reads=0,writes=0,verifies=0;const controller=new Controller(store,vault(),'fixture',{reconcileLeaflet:async()=>{reads++;return {status:'found',publicUrl:url,uri,cid,leaflet:published}},verifyLeaflet:async()=>{verifies++;return {found:true,outcome:'found',url,rel:'nofollow',reason:'matched'}},executeTask:async()=>{writes++;return {status:'failed',message:'unexpected write'}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(reads,1);assert.equal(writes,0);assert.equal(verifies,1);assert.equal(saved.leaflet?.stage,'published');assert.equal(saved.publicUrl,url);assert.equal(saved.checkpoint,'leaflet_published');assert.equal(saved.status,'live')}finally{store.close()}
}));

test('Leaflet cached-page delay receives the one-hour read-only backoff and bounded third stop',async()=>enabled(async()=>{
  const base=task('needs_input'),accepted=receipt('creating',true,base),store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='leaflet']));state.sites=[site()];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[{...base,submittedAt:at,checkpoint:'leaflet_create_accepted',leaflet:accepted,publicUrl:url,reconcileAttempts:1,reconcileAfter:at}]});
  let reads=0,writes=0;const controller=new Controller(store,vault(),'fixture',{reconcileLeaflet:async()=>{reads++;return {status:'unknown'}},executeTask:async()=>{writes++;return {status:'failed',message:'unexpected write'}}});controller.runtime.aiReady=true;
  try{const before=Date.now();await controller.tick();let saved=store.read().tasks[0];assert.equal(reads,1);assert.equal(writes,0);assert.equal(saved.reconcileAttempts,2);assert(saved.reconcileAfter);assert(Date.parse(saved.reconcileAfter!)>=before+55*60000&&Date.parse(saved.reconcileAfter!)<=Date.now()+65*60000);store.update(state=>{state.tasks[0].reconcileAfter=at});await controller.tick();saved=store.read().tasks[0];assert.equal(reads,2);assert.equal(writes,0);assert.equal(saved.reconcileAttempts,3);assert.equal(saved.reconcileAfter,undefined);assert.equal(saved.status,'needs_input');assert.match(saved.message,/不能重发/)}finally{store.close()}
}));

test('Leaflet checkpoints reject changed identity and preserve accepted and published receipts after pause',async()=>enabled(async()=>{
  const base=task(),initial=receipt('creating',false,base),accepted={...initial,uri,cid},published={...accepted,stage:'published' as const};
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='manual';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='leaflet']));state.sites=[{...site(),articleReviewMode:'manual'}];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[{...base,articleApprovedAt:at}]});
  let writes=0;let controller:Controller;controller=new Controller(store,vault(),'fixture',{executeTask:async context=>{writes++;context.checkpoint({leaflet:initial,checkpoint:'leaflet_create_submitting',submittedAt:at});for(const bad of [{...initial,did:'did:plc:otherleaflet123'},{...initial,rkey:'3bcdefghijklm'},{...initial,recordHash:'b'.repeat(64)},{...initial,recordCreatedAt:'2026-10-08T00:00:01.000Z'},{...initial,url:`${profile}/3bcdefghijklm`}])assert.throws(()=>context.checkpoint({leaflet:bad,checkpoint:'leaflet_create_submitting',submittedAt:at}),/回执/);controller.pause();context.checkpoint({leaflet:accepted,checkpoint:'leaflet_create_accepted',submittedAt:at,publicUrl:url});context.checkpoint({leaflet:published,checkpoint:'leaflet_published',submittedAt:at,publicUrl:url});return {status:'review',message:'synthetic',publicUrl:url,checkpoint:'leaflet_published',submittedAt:at,leaflet:published}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(writes,1);assert.equal(saved.status,'needs_input');assert.equal(saved.leaflet?.stage,'published');assert.equal(saved.publicUrl,url);assert.equal(store.read().settings.autoRun,false)}finally{store.close()}
}));

test('Leaflet direct creating results preserve unknown intent and normalize an accepted positive receipt',async()=>{
  for(const acceptedResult of [false,true])await enabled(async()=>{
    const base=task(),initial=receipt('creating',false,base),accepted={...initial,uri,cid};let verifies=0;
    const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='manual';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='leaflet']));state.sites=[{...site(),articleReviewMode:'manual'}];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[{...base,articleApprovedAt:at}]});
    const controller=new Controller(store,vault(),'fixture',{executeTask:async context=>{context.checkpoint({leaflet:initial,checkpoint:'leaflet_create_submitting',submittedAt:at});return acceptedResult?{status:'review',message:'accepted after durable checkpoint failure',publicUrl:url,checkpoint:'leaflet_create_submitting',submittedAt:at,leaflet:accepted}:{status:'review',message:'unknown POST result',checkpoint:'leaflet_create_submitting',submittedAt:at,leaflet:initial}},verifyLeaflet:async()=>{verifies++;return {found:false,outcome:'unreachable',url,rel:'',reason:'should not verify creating receipt'}}});controller.runtime.aiReady=true;
    try{await controller.tick();const saved=store.read().tasks[0];assert.equal(saved.leaflet?.stage,'creating');assert.equal(saved.leaflet?.cid,acceptedResult?cid:undefined);assert.equal(saved.checkpoint,acceptedResult?'leaflet_create_accepted':'leaflet_create_submitting');assert.equal(saved.publicUrl,acceptedResult?url:undefined);assert.equal(verifies,0)}finally{store.close()}
  });
});

test('Leaflet execution waits for independent review tied to the authorized handle and DID profile',async()=>enabled(async()=>{
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='leaflet']));state.sites=[site()];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[task()]});
  const order:string[]=[];const controller=new Controller(store,vault(),'fixture',{reviewArticle:async(t,s,c,settings,_ai,_signal,deps)=>{order.push('review');assert.equal(deps?.account?.username,handle);assert.equal(deps?.account?.publicationUrl,profile);return {status:'passed',reason:'synthetic independent review',reviewedAt:new Date().toISOString(),evidenceUrls:[s.url,c.rulesUrl],draftRevision:t.draftRevision??0,contentHash:articleContentHash(t),contextHash:articleContextHash(s,c,settings,deps?.account)}},executeTask:async context=>{order.push('publish');assert.equal(context.task.articleReview?.status,'passed');return {status:'needs_input',message:'synthetic stop'}}});controller.runtime.aiReady=true;
  try{await controller.tick();assert.deepEqual(order,['review','publish']);assert.equal(store.read().tasks[0].articleReview?.status,'passed')}finally{store.close()}
}));

test('Leaflet generation and repair prompts stay within the publishable Markdown subset',async()=>enabled(async()=>{
  const store=new Store(':memory:');store.update(state=>{state.settings.articleReviewMode='manual';state.sites=[{...site(),articleReviewMode:'manual'}];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[task()]});
  let instruction='',input:unknown;const controller=new Controller(store,vault(),'fixture',{readTopicEvidence:async(_site,topicUrl)=>({url:topicUrl,title:'Guide',text:'Public evidence for the selected guide.',contentHash:'d'.repeat(64)}),aiFactory:(()=>({json:async(prompt:string,data:unknown)=>{instruction=prompt;input=data;return draft}})) as never});controller.runtime.aiReady=true;
  try{await controller.generateDraft(taskId,undefined,{reason:'remove unsupported formatting',draft});assert.match(instruction,/只使用普通段落.*有序或无序列表/);for(const term of ['表格','代码块','引用块','分隔线','原始 HTML','图片','删除线'])assert.match(instruction,new RegExp(term));const repair=(input as {repair:{instruction:string}}).repair.instruction;assert.match(repair,/只使用普通段落/);assert.match(repair,/删除线/)}finally{store.close()}
}));

test('sites sharing one Leaflet DID cannot publish the same public body twice',async()=>enabled(async()=>{
  const sameBody='## Evidence checklist\n\nUse the same repeatable evidence steps and preserve the limits for readers before reaching any conclusion.\n\n## Source\n\nReview the [underlying guide](https://example.test/guide) and disclose the promotional publishing relationship clearly.';
  const first={...task('live'),firstLiveAt:new Date(Date.now()-2*86400000).toISOString(),draft:{title:'Earlier',description:'Earlier',body:sameBody}},second:Task={...task(),id:'99999999-9999-4999-8999-999999999999',siteId:otherSiteId,topicUrl:'https://second.test/guide',draft:undefined,draftRevision:undefined};
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='leaflet']));state.sites=[site(),site(otherSiteId)];state.accounts=[account()];state.accountBindings=[binding(),{...binding(accountId,otherSiteId),id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}];state.tasks=[first,second]});
  let generations=0,reviews=0,writes=0;const controller=new Controller(store,vault(),'fixture',{aiFactory:(()=>({json:async()=>{generations++;return {title:'Duplicate',description:'Duplicate',body:sameBody.replace('https://example.test/guide','https://second.test/guide')}}})) as never,readTopicEvidence:async(_site,topicUrl)=>({url:topicUrl,title:'Guide',text:'Public evidence for the selected guide.',contentHash:'d'.repeat(64)}),collectArticleEvidence:async(currentSite,currentChannel)=>[{url:currentSite.url,kind:'site',text:'Public site evidence text for this fixture.',excerpt:'Public site evidence text for this fixture.'},{url:currentChannel.rulesUrl,kind:'content_policy',text:'Public policy evidence text for this fixture.',excerpt:'Public policy evidence text for this fixture.',appliesTo:currentChannel.id,applicability:'verified'}],reviewArticle:async()=>{reviews++;throw Error('duplicate should stop before review')},executeTask:async()=>{writes++;return {status:'failed',message:'duplicate should stop before publication'}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks.find(item=>item.id===second.id)!;assert.equal(generations,1);assert.equal(reviews,0);assert.equal(writes,0);assert.equal(saved.status,'failed');assert.equal(saved.checkpoint,'channel_wait');assert.match(saved.message,/重复/)}finally{store.close()}
}));

test('disabled Leaflet work never reaches the publisher',async()=>{
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.channelOverrides.leaflet=true;state.sites=[site()];state.accounts=[account()];state.accountBindings=[binding()];state.tasks=[{...task(),articleApprovedAt:at}]});let writes=0;const controller=new Controller(store,vault(),'fixture',{executeTask:async()=>{writes++;return {status:'review',message:'unexpected write'}}});controller.runtime.aiReady=true;
  try{await controller.tick();assert.equal(writes,0);assert.equal(store.read().tasks[0].status,'skipped');assert.match(store.read().tasks[0].message,/停用/)}finally{store.close()}
});
