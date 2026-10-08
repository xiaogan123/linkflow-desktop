import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/main/controller';
import {Store,emptyState,type State} from '../src/main/store';
import {bindAccount,channelExecutionReadiness,unbindAccount} from '../src/main/account-bindings';
import {validateBackup} from '../src/main/backup-validation';
import {articleContentHash,articleContextHash,collectArticleEvidence} from '../src/main/article-review';
import {socialPublicationAt} from '../src/main/planner';
import {isRepeatableOfficialArticleChannel} from '../src/shared/publication';
import {CHANNELS} from '../src/integrations/catalog';
import type {Account,ArticleReview,ExecutionContext,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const stamp='2026-10-07T01:00:00.000Z';
const siteA='11111111-1111-4111-8111-111111111111',siteB='22222222-2222-4222-8222-222222222222';
const accountId='33333333-3333-4333-8333-333333333333',taskId='44444444-4444-4444-8444-444444444444';
const bindingId='55555555-5555-4555-8555-555555555555';
const topic='https://example.com/guides/verification';
const draft={title:'A reproducible verification guide',description:'Checks and limitations.',body:'This original guide explains the operator relationship, evidence checks, limitations, and repeatable verification steps for readers.'};
const channel=(id:'paper-wf'|'hive')=>CHANNELS.find(item=>item.id===id)!;
const account=(id:'paper-wf'|'hive',username=id==='paper-wf'?'paperwriter':'hivewriter'):Account=>({id:accountId,channelId:id,email:'',username,publicationUrl:id==='paper-wf'?`https://paper.wf/${username}/`:`https://hive.blog/@${username}`,credentialKind:'api_token',status:'registered',hasPassword:true,source:'imported',createdAt:stamp});
const site=(id:string)=>({id,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Original educational guides',category:'content' as const,language:'en',monthlyTarget:1,articleReviewMode:'ai' as const,status:'ready' as const,createdAt:stamp,analyzedAt:stamp,topicsCheckedAt:new Date().toISOString(),topics:[{url:topic,discoveredAt:stamp}]});
const vault=()=>({ready:true,available:()=>true,get:async()=>undefined,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})}) as unknown as Vault;
const task=(id:'paper-wf'|'hive',status:Task['status']='queued'):Task=>({id:taskId,siteId:siteA,channelId:id,sourceDomain:id==='paper-wf'?'paper.wf':'hive.blog',status,createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',topicUrl:topic,draft:structuredClone(draft),draftRevision:1});

test('Paper can prepare one workspace identity; Hive needs an explicit verified binding',()=>{
  const state=emptyState();state.sites=[site(siteA),site(siteB)];
  assert.equal(channelExecutionReadiness(state,siteA,channel('paper-wf')).kind,'autocreate');
  assert.equal(channelExecutionReadiness(state,siteA,channel('hive')).kind,'handoff_required');
  state.accounts=[account('paper-wf')];
  assert.equal(channelExecutionReadiness(state,siteA,channel('paper-wf')).kind,'ready');
  state.accounts.push({...account('paper-wf','otherwriter'),id:'66666666-6666-4666-8666-666666666666'});
  assert.equal(channelExecutionReadiness(state,siteA,channel('paper-wf')).kind,'handoff_required');
  bindAccount(state,accountId,siteA,channel('paper-wf'));
  assert.equal(channelExecutionReadiness(state,siteA,channel('paper-wf')).kind,'ready');
  state.accounts=[account('hive')];state.accountBindings=[];
  assert.equal(channelExecutionReadiness(state,siteA,channel('hive')).kind,'handoff_required');
  bindAccount(state,accountId,siteA,channel('hive'));
  assert.equal(channelExecutionReadiness(state,siteA,channel('hive')).kind,'ready');
  state.tasks=[{...task('hive','needs_input'),accountId,submittedAt:stamp,hive:{author:'hivewriter',permlink:'fixture-post',contentHash:'a'.repeat(64),stage:'submitting'}}];
  const replacement={...account('hive','otherwriter'),id:'66666666-6666-4666-8666-666666666666'};state.accounts.push(replacement);
  assert.throws(()=>bindAccount(state,replacement.id,siteA,channel('hive')),/待核验/);
});

test('both full-article channels share a destination cadence across sites',()=>{
  for(const id of ['paper-wf','hive'] as const){
    const state=emptyState();state.sites=[site(siteA),site(siteB)];state.accounts=[account(id)];
    state.accountBindings=[{id:bindingId,siteId:siteA,channelId:id,accountId,createdAt:stamp,updatedAt:stamp},{id:'66666666-6666-4666-8666-666666666666',siteId:siteB,channelId:id,accountId,createdAt:stamp,updatedAt:stamp}];
    const prior={...task(id,'needs_input'),accountId,submittedAt:stamp};state.tasks=[prior];
    assert.equal(isRepeatableOfficialArticleChannel(channel(id)),true);
    const requested=new Date(Date.parse(stamp)+3600000);
    assert.equal(socialPublicationAt(state,siteB,id,requested).toISOString(),new Date(Date.parse(stamp)+86400000).toISOString());
  }
});

test('an unbound queued Paper task uses the sole workspace author for the existing daily cadence',async()=>{
  const now=new Date(),priorAt=new Date(now.getTime()-3600000),dueAt=new Date(priorAt.getTime()+86400000);
  const prior={...task('paper-wf','live'),id:'66666666-6666-4666-8666-666666666666',accountId,siteId:siteA,
    submittedAt:priorAt.toISOString(),firstLiveAt:priorAt.toISOString(),publicUrl:'https://paper.wf/paperwriter/prior-post',
    paper:{username:'paperwriter',slug:'prior-post',contentHash:'a'.repeat(64),stage:'published' as const}};
  const candidate={...task('paper-wf'),siteId:siteB,scheduledAt:now.toISOString()};
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='paper-wf']));state.sites=[site(siteA),site(siteB)];state.accounts=[account('paper-wf')];state.accountBindings=[{id:bindingId,siteId:siteA,channelId:'paper-wf',accountId,createdAt:stamp,updatedAt:stamp}];state.tasks=[prior,candidate]});
  let submissions=0;const controller=new Controller(store,vault(),'fixture',{executeTask:async()=>{submissions++;return {status:'failed',message:'unexpected submission'}}});controller.runtime.aiReady=true;
  try{
    assert.equal(channelExecutionReadiness(store.read(),siteB,channel('paper-wf')).kind,'ready');
    assert.equal(socialPublicationAt(store.read(),siteB,'paper-wf',now,{excludeTaskId:taskId,includeReservations:false}).toISOString(),dueAt.toISOString());
    await controller.tick();
    const saved=store.read().tasks.find(item=>item.id===taskId)!;
    assert.equal(submissions,0);assert.equal(saved.status,'queued');assert.ok(Date.parse(saved.scheduledAt)>=dueAt.getTime());
  }finally{store.close()}
});

test('a pinned Paper author keeps the daily cadence without a site binding when other identities exist',async()=>{
  const now=new Date(),priorAt=new Date(now.getTime()-3600000),dueAt=new Date(priorAt.getTime()+86400000);
  const prior={...task('paper-wf','live'),id:'66666666-6666-4666-8666-666666666666',accountId,siteId:siteA,
    submittedAt:priorAt.toISOString(),firstLiveAt:priorAt.toISOString(),publicUrl:'https://paper.wf/paperwriter/prior-post',
    paper:{username:'paperwriter',slug:'prior-post',contentHash:'a'.repeat(64),stage:'published' as const}};
  const candidate={...task('paper-wf'),siteId:siteB,accountId,scheduledAt:now.toISOString()};
  const otherAccount={...account('paper-wf','otherwriter'),id:'77777777-7777-4777-8777-777777777777'};
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='paper-wf']));state.sites=[site(siteA),site(siteB)];state.accounts=[account('paper-wf'),otherAccount];state.tasks=[prior,candidate]});
  let reviews=0,submissions=0;const controller=new Controller(store,vault(),'fixture',{reviewArticle:async()=>{reviews++;throw Error('unexpected paid review')},executeTask:async()=>{submissions++;return {status:'failed',message:'unexpected submission'}}});controller.runtime.aiReady=true;
  try{
    assert.equal(channelExecutionReadiness(store.read(),siteB,channel('paper-wf'),accountId).kind,'ready');
    assert.equal(socialPublicationAt(store.read(),siteB,'paper-wf',now,{excludeTaskId:taskId,includeReservations:false}).toISOString(),dueAt.toISOString());
    await controller.tick();const saved=store.read().tasks.find(item=>item.id===taskId)!;
    assert.equal(reviews,0);assert.equal(submissions,0);assert.equal(saved.accountId,accountId);
    assert.equal(saved.status,'queued');assert.ok(Date.parse(saved.scheduledAt)>=dueAt.getTime());
  }finally{store.close()}
});

test('Paper author created during preparation rechecks cadence before paid drafting',async()=>{
  const now=new Date(),priorAt=new Date(now.getTime()-3600000),preparedAccount=account('paper-wf');
  const otherSite={...site(siteA),status:'paused' as const};
  const candidate={...task('paper-wf'),siteId:siteB,scheduledAt:now.toISOString(),draft:undefined,draftRevision:undefined};
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='paper-wf']));state.sites=[otherSite,site(siteB)];state.tasks=[candidate]});
  let paidCalls=0,reviews=0,submissions=0;
  const controller=new Controller(store,vault(),'fixture',{
    aiFactory:()=>({json:async()=>{paidCalls++;throw Error('unexpected paid drafting')}}),
    prepareTask:async context=>{
      await context.saveAccount(preparedAccount,'synthetic-encrypted-token');
      store.update(state=>state.tasks.push({...task('paper-wf','live'),id:'66666666-6666-4666-8666-666666666666',siteId:siteA,accountId,
        submittedAt:priorAt.toISOString(),firstLiveAt:priorAt.toISOString(),publicUrl:'https://paper.wf/paperwriter/prior-post',
        paper:{username:'paperwriter',slug:'prior-post',contentHash:'a'.repeat(64),stage:'published'}}));
      return undefined;
    },
    reviewArticle:async()=>{reviews++;throw Error('unexpected review')},
    executeTask:async()=>{submissions++;return {status:'failed',message:'unexpected submission'}},
  });controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks.find(item=>item.id===taskId)!;
    assert.equal(saved.accountId,accountId);assert.equal(saved.status,'queued');assert.ok(Date.parse(saved.scheduledAt)>=priorAt.getTime()+86400000);
    assert.equal(paidCalls,0);assert.equal(reviews,0);assert.equal(submissions,0);
  }finally{store.close()}
});

test('a new shared-author post before Hive intent defers the original reviewed task',async()=>{
  const now=new Date(),priorAt=new Date(now.getTime()-3600000),currentAccount=account('hive');
  const otherSite={...site(siteB),status:'paused' as const};
  const current={...task('hive'),accountId,scheduledAt:now.toISOString()};
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='hive']));state.sites=[site(siteA),otherSite];state.accounts=[currentAccount];state.accountBindings=[{id:bindingId,siteId:siteA,channelId:'hive',accountId,createdAt:stamp,updatedAt:stamp}];state.tasks=[current]});
  let intents=0,submitted=0;
  const controller=new Controller(store,vault(),'fixture',{
    reviewArticle:async(t,s,c,settings,_ai,_signal,deps)=>({status:'passed',reason:'Synthetic independent review',reviewedAt:now.toISOString(),evidenceUrls:[s.url,c.rulesUrl],draftRevision:t.draftRevision??0,contentHash:articleContentHash(t),contextHash:articleContextHash(s,c,settings,deps?.account)}),
    executeTask:async context=>{
      intents++;
      store.update(state=>state.tasks.push({...task('hive','live'),id:'66666666-6666-4666-8666-666666666666',siteId:siteB,accountId,
        submittedAt:priorAt.toISOString(),firstLiveAt:priorAt.toISOString(),publicUrl:'https://hive.blog/general/@hivewriter/prior-post',
        hive:{author:'hivewriter',permlink:'prior-post',contentHash:'a'.repeat(64),stage:'published'}}));
      context.checkpoint({hive:{author:'hivewriter',permlink:'new-post',contentHash:'b'.repeat(64),stage:'submitting'},checkpoint:'hive_publish_submitting',submittedAt:now.toISOString()});
      submitted++;return {status:'failed',message:'unexpected submission'};
    },
  });controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks.find(item=>item.id===taskId)!;
    assert.equal(intents,1);assert.equal(submitted,0);assert.equal(saved.status,'queued');assert.equal(saved.hive,undefined);
    assert.ok(Date.parse(saved.scheduledAt)>=priorAt.getTime()+86400000);
  }finally{store.close()}
});

test('removed Hive binding blocks pinned execution but preserves read-only receipt reconciliation',async()=>{
  const now=new Date(),current={...task('hive'),accountId,scheduledAt:now.toISOString()};
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='hive']));state.sites=[site(siteA)];state.accounts=[account('hive')];state.accountBindings=[{id:bindingId,siteId:siteA,channelId:'hive',accountId,createdAt:stamp,updatedAt:stamp}];state.tasks=[current];unbindAccount(state,accountId,siteA,'hive')});
  let reads=0,writes=0;
  const controller=new Controller(store,vault(),'fixture',{reconcileHive:async()=>{reads++;return {status:'unknown'}},executeTask:async()=>{writes++;return {status:'failed',message:'unexpected write'}}});controller.runtime.aiReady=true;
  try{
    assert.equal(channelExecutionReadiness(store.read(),siteA,channel('hive'),accountId).kind,'handoff_required');
    await controller.tick();assert.equal(writes,0);assert.equal(store.read().tasks[0].status,'needs_input');
    store.update(state=>{Object.assign(state.tasks[0],{submittedAt:now.toISOString(),checkpoint:'hive_publish_submitting',hive:{author:'hivewriter',permlink:'same-post',contentHash:'a'.repeat(64),stage:'submitting'}})});
    await controller.tick();assert.equal(reads,1);assert.equal(writes,0);assert.equal(store.read().accountBindings.length,0);
  }finally{store.close()}
});

test('review evidence includes the bound publication and its identity changes the review hash',async()=>{
  for(const id of ['paper-wf','hive'] as const){
    const currentSite=site(siteA),currentAccount=account(id),selected=channel(id),seen:string[]=[];
    const evidence=await collectArticleEvidence(currentSite,selected,undefined,{account:currentAccount,fetchHtml:async url=>{seen.push(url);return {url,html:'<main><p>Original educational publication with disclosed operator and commercial relationships.</p></main>'}}},topic);
    assert.ok(seen.includes(currentAccount.publicationUrl!),id);
    assert.ok(evidence.some(item=>item.kind==='qualification'&&item.url===currentAccount.publicationUrl),id);
    const settings=emptyState().settings;
    assert.notEqual(articleContextHash(currentSite,selected,settings,currentAccount),articleContextHash(currentSite,selected,settings,{...currentAccount,username:'changed'}),id);
  }
});

test('backup retains each receipt and rejects author or source-domain substitutions',()=>{
  for(const id of ['paper-wf','hive'] as const){
    const state=emptyState();state.sites=[site(siteA)];state.accounts=[account(id)];
    state.accountBindings=[{id:bindingId,siteId:siteA,channelId:id,accountId,createdAt:stamp,updatedAt:stamp}];
    const current={...task(id,'needs_input'),accountId,submittedAt:stamp,checkpoint:id==='paper-wf'?'paper_publish_submitting':'hive_publish_submitting'};
    state.tasks=[id==='paper-wf'?{...current,paper:{username:'paperwriter',slug:'fixture-post',contentHash:'a'.repeat(64),stage:'submitting'}}:{...current,hive:{author:'hivewriter',permlink:'fixture-post',contentHash:'b'.repeat(64),stage:'submitting'}}];
    const input={state,secrets:{[`account:${accountId}`]:'encrypted-synthetic-only'}};
    const restored=validateBackup(structuredClone(input));
    assert.deepEqual(restored.state.tasks[0][id==='paper-wf'?'paper':'hive'],state.tasks[0][id==='paper-wf'?'paper':'hive']);
    const wrongAuthor=structuredClone(input);
    if(id==='paper-wf')wrongAuthor.state.tasks[0].paper!.username='different';else wrongAuthor.state.tasks[0].hive!.author='different';
    assert.throws(()=>validateBackup(wrongAuthor));
    const wrongSource=structuredClone(input);wrongSource.state.tasks[0].sourceDomain='reader.example';
    assert.throws(()=>validateBackup(wrongSource));
  }
});

test('Paper identity preparation precedes review and submission, and the review binds the author',async()=>{
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='paper-wf']));state.sites=[site(siteA)];state.tasks=[task('paper-wf')]});
  let prepared=0,reviewed=0,submitted=0;const preparedAccount=account('paper-wf');
  const controller=new Controller(store,vault(),'fixture',{
    aiFactory:()=>({json:async()=>{throw Error('unexpected paid generation')}}),
    prepareTask:async context=>{prepared++;assert.equal(context.getAccount(),undefined);await context.saveAccount(preparedAccount,'synthetic-encrypted-token');return undefined},
    reviewArticle:async(current,currentSite,currentChannel,settings,_ai,_signal,deps)=>{reviewed++;assert.equal(deps?.account?.username,'paperwriter');const result:ArticleReview={status:'passed',reason:'Synthetic independent review',reviewedAt:stamp,evidenceUrls:[currentSite.url,currentChannel.rulesUrl,preparedAccount.publicationUrl!],draftRevision:current.draftRevision??0,contentHash:articleContentHash(current),contextHash:articleContextHash(currentSite,currentChannel,settings,deps?.account)};return result},
    executeTask:async(context:ExecutionContext)=>{submitted++;assert.equal(context.getAccount()?.id,accountId);context.checkpoint({paper:{username:'paperwriter',slug:'fixture-post',contentHash:'a'.repeat(64),stage:'submitting'},checkpoint:'paper_publish_submitting',submittedAt:new Date().toISOString()});return {status:'needs_input',message:'Synthetic stop after durable intent'}},
  });controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(prepared,1);assert.equal(reviewed,1);assert.equal(submitted,1);assert.equal(saved.accountId,accountId);assert.equal(saved.paper?.username,'paperwriter');assert.equal(saved.checkpoint,'paper_publish_submitting');assert.ok(saved.submittedAt)}finally{store.close()}
});

test('an uncertain Paper signup keeps its original identity instead of switching to another account',()=>{
  const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='paper-wf']));state.sites=[site(siteA)];state.accounts=[{...account('paper-wf'),status:'credentials_invalid',source:'generated',registrationAttempts:1},{...account('paper-wf','replacement'),id:'66666666-6666-4666-8666-666666666666'}];state.accountBindings=[{id:bindingId,siteId:siteA,channelId:'paper-wf',accountId:'66666666-6666-4666-8666-666666666666',createdAt:stamp,updatedAt:stamp}];state.tasks=[{...task('paper-wf'),accountId,checkpoint:'paper_account_create_pending'}]});
  try{new Controller(store,vault(),'fixture').plan();const current=store.read();assert.equal(current.tasks.length,1);assert.equal(current.tasks[0].accountId,accountId);assert.equal(current.tasks[0].checkpoint,'paper_account_create_pending');assert.equal(current.tasks[0].status,'needs_input')}finally{store.close()}
});

test('uncertain Paper and Hive writes receive bounded read reconciliation and no new publish',async()=>{
  for(const id of ['paper-wf','hive'] as const){
    const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id===id]));state.sites=[site(siteA)];state.accounts=[account(id)];state.accountBindings=[{id:bindingId,siteId:siteA,channelId:id,accountId,createdAt:stamp,updatedAt:stamp}];state.tasks=[{...task(id,'needs_input'),accountId,submittedAt:stamp,checkpoint:id==='paper-wf'?'paper_publish_submitting':'hive_publish_submitting',...(id==='paper-wf'?{paper:{username:'paperwriter',slug:'fixture-post',contentHash:'a'.repeat(64),stage:'submitting' as const}}:{hive:{author:'hivewriter',permlink:'fixture-post',contentHash:'b'.repeat(64),stage:'submitting' as const}})}]});
    let reads=0,writes=0;const unknown=async()=>{reads++;return {status:'unknown' as const}};
    const controller=new Controller(store,vault(),'fixture',{reconcilePaper:unknown,reconcileHive:unknown,executeTask:async()=>{writes++;return {status:'failed',message:'unexpected write'}}});controller.runtime.aiReady=true;
    try{for(let index=0;index<5;index++){store.update(state=>state.tasks[0].reconcileAfter=stamp);await controller.tick()}const saved=store.read().tasks[0];assert.equal(reads,3,id);assert.equal(writes,0,id);assert.equal(saved.reconcileAttempts,3,id);assert.equal(saved.publicUrl,undefined,id);assert.equal(store.read().tasks.length,1,id)}finally{store.close()}
  }
});

test('reconciliation accepts only the original author and slug before public verification',async()=>{
  for(const id of ['paper-wf','hive'] as const){
    const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id===id]));state.sites=[site(siteA)];state.accounts=[account(id)];state.accountBindings=[{id:bindingId,siteId:siteA,channelId:id,accountId,createdAt:stamp,updatedAt:stamp}];state.tasks=[{...task(id,'needs_input'),accountId,submittedAt:stamp,checkpoint:id==='paper-wf'?'paper_publish_submitting':'hive_publish_submitting',...(id==='paper-wf'?{paper:{username:'paperwriter',slug:'fixture-post',contentHash:'a'.repeat(64),stage:'submitting' as const}}:{hive:{author:'hivewriter',permlink:'fixture-post',contentHash:'b'.repeat(64),stage:'submitting' as const}})}]});
    let malformed=true,verified=0,writes=0;
    const paperResult=async()=>({status:'found' as const,publicUrl:`https://paper.wf/paperwriter/${malformed?'other-post':'fixture-post'}`,paper:{username:'paperwriter',slug:malformed?'other-post':'fixture-post',contentHash:'a'.repeat(64),stage:'published' as const}});
    const hiveResult=async()=>({status:'found' as const,publicUrl:`https://hive.blog/general/@hivewriter/${malformed?'other-post':'fixture-post'}`,hive:{author:'hivewriter',permlink:malformed?'other-post':'fixture-post',contentHash:'b'.repeat(64),stage:'published' as const}});
    const found=async(current:Task)=>{verified++;return {found:true,outcome:'found' as const,url:current.publicUrl!,rel:'nofollow',reason:''}};
    const controller=new Controller(store,vault(),'fixture',{reconcilePaper:paperResult,reconcileHive:hiveResult,verifyPaper:found,verifyHive:found,executeTask:async()=>{writes++;return {status:'failed',message:'unexpected write'}}});controller.runtime.aiReady=true;
    try{
      await controller.tick();assert.equal(store.read().tasks[0].publicUrl,undefined,id);assert.equal(verified,0,id);
      malformed=false;store.update(state=>state.tasks[0].reconcileAfter=stamp);await controller.tick();
      const saved=store.read().tasks[0];assert.equal(saved.status,'live',id);assert.equal(saved.sourceDomain,id==='paper-wf'?'paper.wf':'hive.blog');assert.equal(verified,1,id);assert.equal(writes,0,id);
    }finally{store.close()}
  }
});

test('pause retains a matching returned receipt without authorizing another write',async()=>{
  for(const id of ['paper-wf','hive'] as const){
    const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id===id]));state.sites=[site(siteA)];state.accounts=[account(id)];state.accountBindings=[{id:bindingId,siteId:siteA,channelId:id,accountId,createdAt:stamp,updatedAt:stamp}];const current={...task(id),accountId};current.articleReview={status:'passed',reason:'Synthetic independent review',reviewedAt:stamp,evidenceUrls:[state.sites[0].url,channel(id).rulesUrl],draftRevision:current.draftRevision??0,contentHash:articleContentHash(current),contextHash:articleContextHash(state.sites[0],channel(id),state.settings,state.accounts[0])};state.tasks=[current]});
    let writes=0;let controller:Controller;
    controller=new Controller(store,vault(),'fixture',{executeTask:async context=>{
      writes++;const submittedAt=new Date().toISOString();
      if(id==='paper-wf'){
        const receipt={username:'paperwriter',slug:'fixture-post',contentHash:'a'.repeat(64),stage:'submitting' as const};
        context.checkpoint({paper:receipt,checkpoint:'paper_publish_submitting',submittedAt});controller.pause();
        context.checkpoint({paper:{...receipt,stage:'published'},checkpoint:'paper_published',submittedAt,publicUrl:'https://paper.wf/paperwriter/fixture-post'});
      }else{
        const receipt={author:'hivewriter',permlink:'fixture-post',contentHash:'b'.repeat(64),stage:'submitting' as const};
        context.checkpoint({hive:receipt,checkpoint:'hive_publish_submitting',submittedAt});controller.pause();
        context.checkpoint({hive:{...receipt,stage:'published'},checkpoint:'hive_published',submittedAt,publicUrl:'https://hive.blog/general/@hivewriter/fixture-post'});
      }
      return {status:'review',message:'Synthetic result after pause'};
    }});controller.runtime.aiReady=true;
    try{await controller.tick();const saved=store.read().tasks[0];assert.equal(writes,1,id);assert.equal(saved.status,'needs_input',id);assert.equal(saved.checkpoint,id==='paper-wf'?'paper_published':'hive_published');assert.ok(saved.publicUrl,id);assert.equal(store.read().settings.autoRun,false,id)}finally{store.close()}
  }
});
