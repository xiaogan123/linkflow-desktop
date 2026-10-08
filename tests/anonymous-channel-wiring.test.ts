import test from 'node:test';
import assert from 'node:assert/strict';
import {Store,emptyState} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {bindAccount,channelExecutionReadiness,unbindAccount} from '../src/main/account-bindings';
import {validateBackup} from '../src/main/backup-validation';
import {makePlan,nextTask,socialPublicationAt} from '../src/main/planner';
import {maintainWaitingTasks} from '../src/main/task-recovery';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {rentryPostSlug} from '../src/shared/publication';
import {CHANNELS} from '../src/integrations/catalog';
import type {Account,ArticleReview,Channel,Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const fixed='2026-10-08T00:00:00.000Z';
const siteOne='11111111-1111-4111-8111-111111111111';
const siteTwo='22222222-2222-4222-8222-222222222222';
const accountId='33333333-3333-4333-8333-333333333333';
const taskOne='44444444-4444-4444-8444-444444444444';
const taskTwo='55555555-5555-4555-8555-555555555555';
const taskThree='66666666-6666-4666-8666-666666666666';
const bindingId='77777777-7777-4777-8777-777777777777';
const rentryHash='a'.repeat(64),lucidHash='b'.repeat(64);

function channel(id:'rentry'|'lucid-page'):Channel{
  const found=CHANNELS.find(item=>item.id===id);assert.ok(found);return found;
}
function enabledChannel(id:'rentry'|'lucid-page'):Channel{return {...channel(id),enabled:true}}
async function enabled<T>(ids:('rentry'|'lucid-page')[],run:()=>Promise<T>):Promise<T>{
  const entries=ids.map(channel),before=entries.map(item=>item.enabled);for(const item of entries)item.enabled=true;
  try{return await run()}finally{entries.forEach((item,index)=>item.enabled=before[index])}
}
function site(id=siteOne,domain='example.test'):Site{
  const url=`https://${domain}/`,topic=`${url}guide`;
  return {id,domain,url,email:`owner@${domain}`,name:`Guides ${domain}`,description:'Independent educational guides',category:'content',language:'en',monthlyTarget:2,articleReviewMode:'ai',status:'ready',createdAt:fixed,analyzedAt:fixed,topicsCheckedAt:new Date().toISOString(),topics:[{url:topic,discoveredAt:fixed}]};
}
function localAccount(extra:Partial<Account>={}):Account{
  return {id:accountId,channelId:'rentry',email:'',username:'anonymous',displayName:'Local anonymous publisher',credentialKind:'api_token',status:'registered',hasPassword:true,source:'generated',createdAt:fixed,...extra};
}
function task(id:string,siteValue:Site,channelId:'rentry'|'lucid-page',extra:Partial<Task>={}):Task{
  return {id,siteId:siteValue.id,channelId,sourceDomain:channelId==='rentry'?'rentry.co':'lucid.page',status:'queued',createdAt:fixed,scheduledAt:fixed,updatedAt:fixed,attempts:0,message:'fixture',topicUrl:siteValue.topics?.[0].url,...extra};
}
function binding(siteId=siteOne){return {id:bindingId,siteId,channelId:'rentry',accountId,createdAt:fixed,updatedAt:fixed}}
function vault(initial:Record<string,string>={},available=true):Vault{
  const secrets=new Map(Object.entries(initial));
  return {ready:available,available:()=>available,get:async(key:string)=>secrets.get(key),set:async(key:string,value:string)=>{secrets.set(key,value)},delete:async(key:string)=>{secrets.delete(key)},encryptSecrets:(values:Record<string,string>)=>values} as unknown as Vault;
}
function persistedVault(store:Store,available=true):Vault{
  return {ready:available,available:()=>available,get:async(key:string)=>store.getCipher(key),set:async(key:string,value:string)=>{store.setCipher(key,value)},delete:async(key:string)=>{store.deleteCipher(key)},encryptSecrets:(values:Record<string,string>)=>values} as unknown as Vault;
}
function configure(state:ReturnType<typeof emptyState>,channelId:'rentry'|'lucid-page'){
  state.settings.autoRun=true;state.settings.notify=false;state.settings.timezone='UTC';state.settings.articleReviewMode='ai';
  state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id===channelId]));
}
function passedReview(value:Task,siteValue:Site,channelValue:Channel,settings:ReturnType<typeof emptyState>['settings'],account?:Account):ArticleReview{
  return {status:'passed',reason:'independent fixture review',reasonCode:'passed',reviewContractVersion:4,reviewedAt:new Date().toISOString(),evidenceUrls:[siteValue.url,channelValue.rulesUrl],draftRevision:value.draftRevision??0,contentHash:articleContentHash(value),contextHash:articleContextHash(siteValue,channelValue,settings,account)};
}

test('only accepted anonymous channels are enabled, rank ready work first and share one daily workspace across sites',()=>{
  assert.equal(channel('rentry').enabled,false);assert.equal(channel('lucid-page').enabled,true);
  const first=site(),state=emptyState();state.sites=[first];state.settings.timezone='UTC';
  const selected=makePlan(state,first,[{channel:enabledChannel('rentry'),score:100,reason:'fixture'},{channel:enabledChannel('lucid-page'),score:1,reason:'fixture'}],new Date(fixed));
  assert.equal(selected.length,1);assert.equal(selected[0].channelId,'lucid-page');assert.equal(selected[0].sourceDomain,'lucid.page');

  for(const id of ['rentry','lucid-page'] as const){
    const one=site(siteOne,'one.test'),two=site(siteTwo,'two.test'),shared=emptyState(),ready=enabledChannel(id);shared.sites=[one,two];shared.settings.timezone='UTC';one.monthlyTarget=1;two.monthlyTarget=1;
    const firstPlan=makePlan(shared,one,[{channel:ready,score:1,reason:'fixture'}],new Date(fixed));
    const secondPlan=makePlan(shared,two,[{channel:ready,score:1,reason:'fixture'}],new Date(fixed));
    assert.equal(firstPlan.length,1,id);assert.equal(secondPlan.length,1,id);
    assert.equal(secondPlan[0].scheduledAt,new Date(Date.parse(firstPlan[0].scheduledAt)+86400000).toISOString(),id);
  }
});

test('Rentry reuses one local identity, preserves explicit unbind, and both anonymous destinations keep a 24-hour cross-site cadence',()=>{
  const one=site(),two=site(siteTwo,'other.test'),state=emptyState(),rentry=enabledChannel('rentry');state.sites=[one,two];state.accounts=[localAccount()];
  assert.equal(channelExecutionReadiness(state,one.id,rentry).account?.id,accountId);
  assert.equal(channelExecutionReadiness(state,two.id,rentry).account?.id,accountId);
  bindAccount(state,accountId,one.id,rentry);unbindAccount(state,accountId,one.id,'rentry');
  assert.deepEqual(state.accounts[0].rentryExcludedSiteIds,[one.id]);
  assert.equal(channelExecutionReadiness(state,one.id,rentry).kind,'handoff_required');
  assert.equal(channelExecutionReadiness(state,two.id,rentry).kind,'ready');

  state.tasks=[task(taskOne,one,'rentry',{status:'needs_input',accountId,submittedAt:fixed,checkpoint:'rentry_publish_submitting',rentry:{slug:rentryPostSlug(taskOne,rentryHash),contentHash:rentryHash,stage:'submitting'}})];
  assert.equal(socialPublicationAt(state,two.id,'rentry',new Date(Date.parse(fixed)+3600000)).toISOString(),new Date(Date.parse(fixed)+86400000).toISOString());
  state.tasks=[task(taskTwo,one,'lucid-page',{status:'needs_input',submittedAt:fixed,checkpoint:'lucid_publish_submitting',lucid:{contentHash:lucidHash,stage:'submitting'}})];
  assert.equal(socialPublicationAt(state,two.id,'lucid-page',new Date(Date.parse(fixed)+3600000)).toISOString(),new Date(Date.parse(fixed)+86400000).toISOString());
});

test('backup binds Rentry keys and Lucid claim secrets to their exact receipts without weakening restored review state',()=>{
  const one=site(),two=site(siteTwo,'other.test'),state=emptyState();state.sites=[one,two];state.accounts=[localAccount()];state.accountBindings=[binding()];
  const rentryTask=task(taskOne,one,'rentry',{status:'needs_input',accountId,submittedAt:fixed,checkpoint:'rentry_publish_submitting',rentry:{slug:rentryPostSlug(taskOne,rentryHash),contentHash:rentryHash,stage:'submitting'},draft:{title:'Rentry guide',description:'Evidence',body:'Original Rentry guide body'},draftRevision:1,articleApprovedAt:fixed});
  rentryTask.articleReview=passedReview(rentryTask,one,enabledChannel('rentry'),state.settings,state.accounts[0]);
  const slug='lucid-fixture',lucidTask=task(taskTwo,two,'lucid-page',{status:'review',submittedAt:fixed,checkpoint:'lucid_publish_submitting',publicUrl:`https://lucid.page/${slug}`,lucid:{contentHash:lucidHash,slug,stage:'submitting'},draft:{title:'Lucid guide',description:'Evidence',body:'Original Lucid guide body'},draftRevision:1,articleApprovedAt:fixed});
  lucidTask.articleReview=passedReview(lucidTask,two,enabledChannel('lucid-page'),state.settings);
  const pending=task(taskThree,two,'lucid-page',{status:'needs_input',submittedAt:fixed,checkpoint:'lucid_publish_submitting',lucid:{contentHash:'c'.repeat(64),stage:'submitting'},draft:{title:'Pending Lucid guide',description:'Evidence',body:'Pending original body'},draftRevision:1,articleApprovedAt:fixed});
  pending.articleReview=passedReview(pending,two,enabledChannel('lucid-page'),state.settings);
  state.tasks=[rentryTask,lucidTask,pending];
  const rentryKey=JSON.stringify({version:1,key:Buffer.alloc(32,7).toString('base64url')});
  const input={state,secrets:{['account:'+accountId]:rentryKey,['publication:'+taskTwo]:'lpc_fixture-claim'}};
  const restored=validateBackup(structuredClone(input));
  assert.deepEqual(restored.state.tasks[0].rentry,rentryTask.rentry);assert.deepEqual(restored.state.tasks[1].lucid,lucidTask.lucid);
  assert.equal(Object.hasOwn(restored.secrets,'publication:'+taskTwo),true);
  assert.equal(restored.state.tasks[0].articleApprovedAt,undefined);assert.equal(restored.state.tasks[0].articleReview?.status,'failed');
  assert.equal(restored.state.tasks[2].articleApprovedAt,undefined);assert.equal(restored.state.tasks[2].articleReview?.status,'failed');

  const orphan=structuredClone(input);orphan.secrets['publication:88888888-8888-4888-8888-888888888888']='lpc_orphan';assert.throws(()=>validateBackup(orphan),/孤立凭据/);
  const wrongKey=structuredClone(input);wrongKey.secrets['account:'+accountId]='not-a-rentry-key';assert.throws(()=>validateBackup(wrongKey),/Rentry 本机密钥/);
  const wrongClaim=structuredClone(input);wrongClaim.secrets['publication:'+taskTwo]='secret-without-prefix';assert.throws(()=>validateBackup(wrongClaim),/孤立凭据/);
  const wrongTask=structuredClone(input);wrongTask.state.tasks[1].channelId='rentry';assert.throws(()=>validateBackup(wrongTask));
  const forbiddenAccount=structuredClone(input);forbiddenAccount.state.accounts.push({id:'99999999-9999-4999-8999-999999999999',channelId:'lucid-page',email:'owner@other.test',username:'unused',status:'registered',hasPassword:false,createdAt:fixed});assert.throws(()=>validateBackup(forbiddenAccount),/Lucid 账号/);
});

test('both anonymous publishers pass through an independent AI review and never publish a rejected draft',async t=>{
  for(const id of ['rentry','lucid-page'] as const)await t.test(id,async()=>enabled([id],async()=>{
    for(const verdict of ['passed','failed'] as const){
      const store=new Store(':memory:'),value=site();store.update(state=>{configure(state,id);state.sites=[value];if(id==='rentry'){state.accounts=[localAccount()];state.accountBindings=[binding()]};state.tasks=[task(taskOne,value,id,{accountId:id==='rentry'?accountId:undefined,draft:{title:'Original guide',description:'Evidence',body:'A complete original educational guide with a clear commercial relationship disclosure and a related source link.'},draftRevision:1})]});
      let reviews=0,publishes=0;
      const controller=new Controller(store,vault(),'fixture',{reviewArticle:async(current,currentSite,currentChannel,settings,_ai,_signal,deps)=>{reviews++;if(id==='rentry')assert.equal(deps?.account?.id,accountId);else assert.equal(deps?.account,undefined);return verdict==='passed'?passedReview(current,currentSite,currentChannel,settings,deps?.account as Account|undefined):{status:'failed' as const,reason:'policy evidence is incomplete',reasonCode:'policy_unknown' as const,reviewContractVersion:4,reviewedAt:new Date().toISOString(),evidenceUrls:[currentChannel.rulesUrl],draftRevision:current.draftRevision??0,contentHash:articleContentHash(current),contextHash:articleContextHash(currentSite,currentChannel,settings,deps?.account)}} ,executeTask:async context=>{publishes++;assert.ok(context.task.articleApprovedAt);return {status:'review',message:'synthetic publication result'}}});
      controller.runtime.aiReady=true;
      try{await controller.tick();const saved=store.read().tasks[0];assert.equal(reviews,1);assert.equal(publishes,verdict==='passed'?1:0);assert.equal(saved.articleReview?.status,verdict);if(verdict==='failed')assert.equal(saved.submittedAt,undefined)}finally{store.close()}
    }
  }));
});

test('hash-bound checkpoints reject altered identities and retain a positive receipt when execution is paused',async t=>{
  await t.test('Rentry published receipt',async()=>enabled(['rentry'],async()=>{
    const store=new Store(':memory:'),value=site();store.update(state=>{configure(state,'rentry');state.settings.articleReviewMode='manual';value.articleReviewMode='manual';state.sites=[value];state.accounts=[localAccount()];state.accountBindings=[binding()];state.tasks=[task(taskOne,value,'rentry',{accountId,draft:{title:'Original',description:'Evidence',body:'Original body approved for a synthetic checkpoint test.'},draftRevision:1,articleApprovedAt:fixed})]});
    const slug=rentryPostSlug(taskOne,rentryHash),url=`https://rentry.co/${slug}`;let controller:Controller;
    controller=new Controller(store,vault(),'fixture',{executeTask:async context=>{const submittedAt=new Date().toISOString();context.checkpoint({rentry:{slug,contentHash:rentryHash,stage:'submitting'},checkpoint:'rentry_publish_submitting',submittedAt});assert.throws(()=>context.checkpoint({rentry:{slug,contentHash:'f'.repeat(64),stage:'published'},checkpoint:'rentry_published',submittedAt,publicUrl:url}),/回执/);controller.pause();context.checkpoint({rentry:{slug,contentHash:rentryHash,stage:'published'},checkpoint:'rentry_published',submittedAt,publicUrl:url});return {status:'review',message:'positive receipt',publicUrl:url,rentry:{slug,contentHash:rentryHash,stage:'published'}}}});controller.runtime.aiReady=true;
    try{await controller.tick();const saved=store.read().tasks[0];assert.equal(saved.status,'needs_input');assert.equal(saved.rentry?.stage,'published');assert.equal(saved.publicUrl,url);assert.equal(store.read().settings.autoRun,false)}finally{store.close()}
  }));
  await t.test('Lucid identified receipt',async()=>enabled(['lucid-page'],async()=>{
    const store=new Store(':memory:'),value=site();store.update(state=>{configure(state,'lucid-page');state.settings.articleReviewMode='manual';value.articleReviewMode='manual';state.sites=[value];state.tasks=[task(taskOne,value,'lucid-page',{draft:{title:'Original',description:'Evidence',body:'Original body approved for a synthetic checkpoint test.'},draftRevision:1,articleApprovedAt:fixed})]});
    const slug='lucid-positive',url=`https://lucid.page/${slug}`;let controller:Controller;
    controller=new Controller(store,persistedVault(store),'fixture',{executeTask:async context=>{const submittedAt=new Date().toISOString();context.checkpoint({lucid:{contentHash:lucidHash,stage:'submitting'},checkpoint:'lucid_publish_submitting',submittedAt});assert.throws(()=>context.checkpoint({lucid:{contentHash:lucidHash,slug,stage:'submitting'},checkpoint:'lucid_publish_submitting',submittedAt,publicUrl:url+'?wrong=1'}),/回执/);controller.pause();context.checkpoint({lucid:{contentHash:lucidHash,slug,stage:'submitting'},checkpoint:'lucid_publish_submitting',submittedAt,publicUrl:url});await assert.rejects(context.secrets.set('publication:'+taskTwo,'lpc_other-task'),/原任务/);await context.secrets.set('publication:'+taskOne,'lpc_paused-positive');return {status:'review',message:'positive receipt',publicUrl:url,lucid:{contentHash:lucidHash,slug,stage:'submitting'}}}});controller.runtime.aiReady=true;
    try{await controller.tick();const saved=store.read().tasks[0];assert.equal(saved.status,'needs_input');assert.equal(saved.lucid?.slug,slug);assert.equal(saved.lucid?.stage,'submitting');assert.equal(saved.publicUrl,url);assert.equal(store.getCipher('publication:'+taskOne),'lpc_paused-positive');assert.equal(store.getCipher('publication:'+taskTwo),undefined)}finally{store.close()}
  }));
});

test('a Lucid success response survives a failed second checkpoint as a submitting receipt and URL',async()=>enabled(['lucid-page'],async()=>{
  const store=new Store(':memory:'),value=site(),slug='returned-slug',url=`https://lucid.page/${slug}`;store.update(state=>{configure(state,'lucid-page');state.settings.articleReviewMode='manual';value.articleReviewMode='manual';state.sites=[value];state.tasks=[task(taskOne,value,'lucid-page',{draft:{title:'Original',description:'Evidence',body:'Original body approved for a synthetic checkpoint test.'},draftRevision:1,articleApprovedAt:fixed})]});
  let verified=0;
  const controller=new Controller(store,vault(),'fixture',{executeTask:async context=>{const submittedAt=new Date().toISOString();context.checkpoint({lucid:{contentHash:lucidHash,stage:'submitting'},checkpoint:'lucid_publish_submitting',submittedAt});return {status:'review',message:'matched response awaiting read-only verification',publicUrl:url,lucid:{contentHash:lucidHash,slug,stage:'submitting'},checkpoint:'lucid_publish_submitting',submittedAt}},verifyLucid:async()=>{verified++;return {found:false,outcome:'invalid',url,rel:'unknown',reason:'not yet verified'}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(verified,1);assert.equal(saved.status,'review');assert.equal(saved.lucid?.slug,slug);assert.equal(saved.lucid?.stage,'submitting');assert.equal(saved.publicUrl,url);assert.equal(saved.checkpoint,'lucid_publish_submitting')}finally{store.close()}
}));

test('a normal Lucid three-checkpoint publish accepts the durable published result and verifies it in the same tick',async()=>enabled(['lucid-page'],async()=>{
  const store=new Store(':memory:'),value=site(),slug='published-slug',url=`https://lucid.page/${slug}`;store.update(state=>{configure(state,'lucid-page');state.settings.articleReviewMode='manual';value.articleReviewMode='manual';state.sites=[value];state.tasks=[task(taskOne,value,'lucid-page',{draft:{title:'Original',description:'Evidence',body:'Original body approved for a synthetic checkpoint test.'},draftRevision:1,articleApprovedAt:fixed})]});
  let verified=0;
  const controller=new Controller(store,persistedVault(store),'fixture',{executeTask:async context=>{const submittedAt=new Date().toISOString();context.checkpoint({lucid:{contentHash:lucidHash,stage:'submitting'},checkpoint:'lucid_publish_submitting',submittedAt});context.checkpoint({lucid:{contentHash:lucidHash,slug,stage:'submitting'},checkpoint:'lucid_publish_submitting',submittedAt,publicUrl:url});await context.secrets.set('publication:'+taskOne,'lpc_published-token');context.checkpoint({lucid:{contentHash:lucidHash,slug,stage:'published'},checkpoint:'lucid_published',submittedAt,publicUrl:url});return {status:'review',message:'published response',publicUrl:url,lucid:{contentHash:lucidHash,slug,stage:'published'},checkpoint:'lucid_published',submittedAt}},verifyLucid:async()=>{verified++;return {found:true,outcome:'found',url,rel:'nofollow ugc',reason:'matched'}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(verified,1);assert.equal(saved.status,'live');assert.equal(saved.lucid?.stage,'published');assert.equal(saved.lucid?.slug,slug);assert.equal(saved.checkpoint,'lucid_published');assert.equal(saved.publicUrl,url);assert.equal(store.getCipher('publication:'+taskOne),'lpc_published-token')}finally{store.close()}
}));

test('deleting a site atomically removes its publication secrets and blocks a late Lucid claim token from reviving an orphan',async t=>{
  await t.test('existing secrets',()=>{
    const store=new Store(':memory:'),one=site(),two=site(siteTwo,'other.test');store.update(state=>{state.sites=[one,two];state.tasks=[task(taskOne,one,'lucid-page',{status:'review',submittedAt:fixed,checkpoint:'lucid_publish_submitting',publicUrl:'https://lucid.page/deleted',lucid:{contentHash:lucidHash,slug:'deleted',stage:'submitting'}}),task(taskTwo,two,'lucid-page',{status:'review',submittedAt:fixed,checkpoint:'lucid_publish_submitting',publicUrl:'https://lucid.page/retained',lucid:{contentHash:'c'.repeat(64),slug:'retained',stage:'submitting'}})]});store.setCipher('publication:'+taskOne,'deleted-cipher');store.setCipher('publication:'+taskTwo,'retained-cipher');store.setCipher('account:'+accountId,'account-cipher');store.setCipher('mailbox:88888888-8888-4888-8888-888888888888','mailbox-cipher');
    const controller=new Controller(store,persistedVault(store),'fixture');
    try{controller.deleteSite(one.id);assert.equal(store.read().sites.some(item=>item.id===one.id),false);assert.equal(store.read().tasks.some(item=>item.id===taskOne),false);assert.equal(store.getCipher('publication:'+taskOne),undefined);assert.equal(store.getCipher('publication:'+taskTwo),'retained-cipher');assert.equal(store.getCipher('account:'+accountId),'account-cipher');assert.equal(store.getCipher('mailbox:88888888-8888-4888-8888-888888888888'),'mailbox-cipher')}finally{store.close()}
  });
  await t.test('late token',async()=>enabled(['lucid-page'],async()=>{
    const store=new Store(':memory:'),one=site(),two=site(siteTwo,'other.test');store.update(state=>{configure(state,'lucid-page');state.settings.articleReviewMode='manual';one.articleReviewMode='manual';state.sites=[one,two];state.tasks=[task(taskOne,one,'lucid-page',{draft:{title:'Original',description:'Evidence',body:'Original body approved for a synthetic checkpoint test.'},draftRevision:1,articleApprovedAt:fixed}),task(taskTwo,two,'lucid-page',{status:'skipped'})]});store.setCipher('publication:'+taskTwo,'retained-cipher');
    let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),began=new Promise<void>(resolve=>{started=resolve});let lateRejected=false;
    const controller=new Controller(store,persistedVault(store),'fixture',{executeTask:async context=>{const submittedAt=new Date().toISOString();context.checkpoint({lucid:{contentHash:lucidHash,stage:'submitting'},checkpoint:'lucid_publish_submitting',submittedAt});started();await gate;try{context.checkpoint({lucid:{contentHash:lucidHash,slug:'late-slug',stage:'submitting'},checkpoint:'lucid_publish_submitting',submittedAt,publicUrl:'https://lucid.page/late-slug'})}catch{/* Site deletion invalidates the receipt. */}try{await context.secrets.set('publication:'+taskOne,'lpc_late-token')}catch{lateRejected=true}return {status:'review',message:'late response',publicUrl:'https://lucid.page/late-slug',lucid:{contentHash:lucidHash,slug:'late-slug',stage:'submitting'}}}});controller.runtime.aiReady=true;
    try{const running=controller.tick();await began;controller.deleteSite(one.id);release();await running;assert.equal(lateRejected,true);assert.equal(store.getCipher('publication:'+taskOne),undefined);assert.equal(store.getCipher('publication:'+taskTwo),'retained-cipher');assert.equal(store.read().tasks.some(item=>item.id===taskOne),false)}finally{store.close()}
  }));
});

test('unknown anonymous submissions use three read-only reconciliation attempts and cannot create a replacement write',async t=>{
  for(const id of ['rentry','lucid-page'] as const)await t.test(id,async()=>enabled([id],async()=>{
    const store=new Store(':memory:'),value=site(),receipt=id==='rentry'?{rentry:{slug:rentryPostSlug(taskOne,rentryHash),contentHash:rentryHash,stage:'submitting' as const}}:{lucid:{contentHash:lucidHash,stage:'submitting' as const}};
    store.update(state=>{configure(state,id);state.sites=[value];if(id==='rentry'){state.accounts=[localAccount()];state.accountBindings=[binding()]};state.tasks=[task(taskOne,value,id,{status:'needs_input',accountId:id==='rentry'?accountId:undefined,submittedAt:fixed,checkpoint:id==='rentry'?'rentry_publish_submitting':'lucid_publish_submitting',...receipt})]});
    let reads=0,writes=0;const services=id==='rentry'?{reconcileRentry:async()=>{reads++;return {status:'unknown' as const}},executeTask:async()=>{writes++;return {status:'failed' as const,message:'unexpected write'}}}:{reconcileLucid:async()=>{reads++;return {status:'unknown' as const}},executeTask:async()=>{writes++;return {status:'failed' as const,message:'unexpected write'}}};
    const controller=new Controller(store,vault({},false),'fixture',services);controller.runtime.aiReady=true;
    try{for(let attempt=0;attempt<3;attempt++){if(attempt)store.update(state=>{state.tasks[0].reconcileAfter=fixed});await controller.tick()}const saved=store.read().tasks[0];assert.equal(reads,3);assert.equal(writes,0);assert.equal(saved.reconcileAttempts,3);assert.equal(saved.status,'needs_input');assert.match(saved.message,/不能重发|停止自动请求/);assert.equal(store.read().tasks.length,1);assert.equal(nextTask(store.read(),new Date(),[enabledChannel(id)]),undefined)}finally{store.close()}
  }));
});

test('Lucid with a known slug reconciles by its original URL and promotes the exact receipt',async()=>enabled(['lucid-page'],async()=>{
  const store=new Store(':memory:'),value=site(),slug='known-slug',url=`https://lucid.page/${slug}`;store.update(state=>{configure(state,'lucid-page');state.sites=[value];state.tasks=[task(taskOne,value,'lucid-page',{status:'review',submittedAt:fixed,checkpoint:'lucid_publish_submitting',publicUrl:url,lucid:{contentHash:lucidHash,slug,stage:'submitting'}})]});
  let reads=0,writes=0,verifies=0;
  const controller=new Controller(store,vault(),'fixture',{reconcileLucid:async()=>{reads++;return {status:'found',publicUrl:url,lucid:{contentHash:lucidHash,slug,stage:'published'}}},verifyLucid:async()=>{verifies++;return {found:true,outcome:'found',url,rel:'follow',reason:'matched'}},executeTask:async()=>{writes++;return {status:'failed',message:'unexpected write'}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(reads,1);assert.equal(writes,0);assert.equal(verifies,1);assert.equal(saved.lucid?.stage,'published');assert.equal(saved.checkpoint,'lucid_published');assert.equal(saved.publicUrl,url);assert.equal(saved.status,'live')}finally{store.close()}
}));

test('Lucid read-only reconciliation cannot invent a published identity for a slugless receipt',async()=>enabled(['lucid-page'],async()=>{
  const store=new Store(':memory:'),value=site(),url='https://lucid.page/invented-slug';store.update(state=>{configure(state,'lucid-page');state.sites=[value];state.tasks=[task(taskOne,value,'lucid-page',{status:'needs_input',submittedAt:fixed,checkpoint:'lucid_publish_submitting',lucid:{contentHash:lucidHash,stage:'submitting'}})]});
  let reads=0,verifies=0;
  const controller=new Controller(store,vault({},false),'fixture',{reconcileLucid:async()=>{reads++;return {status:'found',publicUrl:url,lucid:{contentHash:lucidHash,slug:'invented-slug',stage:'published'}}},verifyLucid:async()=>{verifies++;return {found:true,outcome:'found',url,rel:'follow',reason:'must not run'}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(reads,1);assert.equal(verifies,0);assert.equal(saved.lucid?.slug,undefined);assert.equal(saved.lucid?.stage,'submitting');assert.equal(saved.publicUrl,undefined);assert.equal(saved.checkpoint,'lucid_publish_submitting')}finally{store.close()}
}));

test('a 48-hour Rentry handoff releases the original slot so another automatic channel can continue',()=>{
  const value=site(),state=emptyState(),rentry=enabledChannel('rentry'),lucid=enabledChannel('lucid-page'),after=new Date(Date.parse(fixed)+49*3600000);state.settings.autoRun=true;state.settings.timezone='UTC';state.sites=[value];
  const waiting=task(taskOne,value,'rentry',{status:'needs_input',checkpoint:'account_handoff',waitingSince:fixed});
  const ready=task(taskTwo,value,'lucid-page',{scheduledAt:after.toISOString()});state.tasks=[waiting,ready];
  maintainWaitingTasks(state.tasks,state.sites,[rentry,lucid],state.settings,after);
  assert.equal(waiting.status,'skipped');assert.ok(waiting.deferredAt);assert.equal(nextTask(state,after,[rentry,lucid])?.id,ready.id);
});

test('shared anonymous destinations reject a duplicate public body from another site before review or publication',async t=>{
  for(const id of ['rentry','lucid-page'] as const)await t.test(id,async()=>enabled([id],async()=>{
    const one=site(siteOne,'one.test'),two=site(siteTwo,'two.test'),store=new Store(':memory:'),sameBody='The same public educational body with enough distinctive words to trigger exact duplicate detection across sites.';
    store.update(state=>{configure(state,id);state.sites=[one,two];if(id==='rentry'){state.accounts=[localAccount()];state.accountBindings=[binding(one.id),{...binding(two.id),id:'88888888-8888-4888-8888-888888888888'}]};state.tasks=[task(taskOne,one,id,{status:'live',accountId:id==='rentry'?accountId:undefined,firstLiveAt:new Date(Date.now()-2*86400000).toISOString(),lastCheckedAt:new Date().toISOString(),nextCheckAt:new Date(Date.now()+86400000).toISOString(),draft:{title:'Earlier',description:'Earlier',body:sameBody},draftRevision:1}),task(taskTwo,two,id,{accountId:id==='rentry'?accountId:undefined})]});
    let aiCalls=0,publishes=0,reviews=0;
    const controller=new Controller(store,vault(),'fixture',{aiFactory:(()=>({json:async()=>{aiCalls++;return {title:'Duplicate',description:'Duplicate',body:sameBody}}})) as never,readTopicEvidence:async(_site,url)=>({url,title:'Guide',text:'Evidence text for the selected guide.',contentHash:'d'.repeat(64)}),collectArticleEvidence:async(currentSite,currentChannel)=>[{url:currentSite.url,kind:'site',text:'Public site evidence text for this fixture.',excerpt:'Public site evidence text for this fixture.'},{url:currentChannel.rulesUrl,kind:'content_policy',text:'Public policy evidence text for this fixture.',excerpt:'Public policy evidence text for this fixture.',appliesTo:currentChannel.id,applicability:'verified'}],reviewArticle:async()=>{reviews++;throw Error('duplicate should stop before review')},executeTask:async()=>{publishes++;return {status:'failed',message:'duplicate should stop before publication'}}});controller.runtime.aiReady=true;
    try{await controller.tick();const saved=store.read().tasks.find(item=>item.id===taskTwo)!;assert.equal(aiCalls,1);assert.equal(reviews,0);assert.equal(publishes,0);assert.equal(saved.status,'failed');assert.equal(saved.checkpoint,'channel_wait');assert.match(saved.message,/重复/)}finally{store.close()}
  }));
});
