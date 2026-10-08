import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {CHANNELS} from '../src/integrations/catalog';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {nextTask} from '../src/main/planner';
import {maintainWaitingTasks} from '../src/main/task-recovery';
import {validateBackup} from '../src/main/backup-validation';
import {bloggerTesting,verifyBloggerPublication} from '../src/integrations/blogger';
import type {ExecutionContext,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';
const sid='11111111-1111-4111-8111-111111111111',tid='22222222-2222-4222-8222-222222222222',aid='33333333-3333-4333-8333-333333333333',stamp='2026-10-01T00:00:00.000Z';
const vault={ready:true,available:()=>true,get:async()=>undefined,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})} as unknown as Vault;
const blogger:NonNullable<Task['blogger']>={blogId:'100',postId:'200',operationId:'operation-fixture',contentHash:'a'.repeat(64),stage:'draft'};
function fixture(){const store=new Store(':memory:');store.update(s=>{
 s.settings.autoRun=true;s.settings.articleReviewMode='ai';s.settings.channelOverrides=Object.fromEntries(CHANNELS.map(c=>[c.id,c.id==='blogger']));
 s.sites=[{id:sid,url:'https://example.com/',domain:'example.com',email:'owner@example.com',name:'Example',description:'Original publishing guides',category:'content',language:'en',monthlyTarget:2,status:'ready',createdAt:stamp,analyzedAt:stamp,topicsCheckedAt:new Date().toISOString(),blogger:{blogId:'100',url:'https://example.blogspot.com/'}}];
 s.accounts=[{id:aid,channelId:'blogger',email:'owner@example.com',username:'99',credentialKind:'oauth',status:'registered',hasPassword:true,createdAt:stamp}];
 s.accountBindings=[{id:'44444444-4444-4444-8444-444444444444',siteId:sid,channelId:'blogger',accountId:aid,createdAt:stamp,updatedAt:stamp}];
 s.tasks=[{id:tid,siteId:sid,channelId:'blogger',accountId:aid,sourceDomain:'example.blogspot.com',status:'needs_input',createdAt:stamp,updatedAt:stamp,scheduledAt:stamp,submittedAt:stamp,checkpoint:'blogger_insert_submitting',blogger:{...blogger,stage:'inserting',postId:undefined},attempts:1,message:'Waiting for receipt',draft:{title:'Original guide',description:'Useful guide',body:'An original researched guide with practical steps and attributed evidence.'}}];
 });return store}
function approve(t:Task,s:ReturnType<Store['read']>['sites'][number],c:typeof CHANNELS[number],settings:ReturnType<Store['read']>['settings']){return {status:'passed' as const,reason:'Independent fixture review',reviewedAt:new Date().toISOString(),evidenceUrls:[s.url,c.rulesUrl],draftRevision:t.draftRevision??0,contentHash:articleContentHash(t),contextHash:articleContextHash(s,c,settings)}}
test('Blogger draft reconciliation resumes same post after independent review without resetting budget',async()=>{
 const store=fixture();let publishes=0,reviews=0;
 const c=new Controller(store,vault,'fixture',{reconcileBlogger:async()=>({status:'draft',blogger}),reviewArticle:async(t,s,ch,set)=>{reviews++;return approve(t,s,ch,set)},executeTask:async context=>{publishes++;assert.equal(context.task.blogger?.postId,'200');assert.equal(context.task.submittedAt,stamp);context.checkpoint({blogger:{...blogger,stage:'publishing'},checkpoint:'blogger_publish_submitting',submittedAt:stamp});return {status:'needs_input',checkpoint:'blogger_publish_submitting',submittedAt:stamp,message:'Uncertain fixture'}}});c.runtime.aiReady=true;
 try{await c.tick();assert.equal(reviews,1);assert.equal(publishes,1);assert.equal(store.read().tasks.length,1);assert.equal(store.read().tasks[0].reconcileAttempts,1);assert.equal(store.read().tasks[0].attempts,1)}finally{store.close()}
});
test('Blogger unknown result is bounded to three reads and never creates another article',async()=>{
 const store=fixture();let reads=0,writes=0;const c=new Controller(store,vault,'fixture',{reconcileBlogger:async()=>{reads++;return {status:'unknown'}},executeTask:async()=>{writes++;throw Error('unexpected')}});c.runtime.aiReady=true;
 try{for(let i=0;i<5;i++){store.update(s=>s.tasks[0].reconcileAfter=stamp);await c.tick()}assert.equal(reads,3);assert.equal(writes,0);assert.equal(store.read().tasks.length,1)}finally{store.close()}
});
test('only a claimed Blogger draft, never an uncertain insert, is executable with submittedAt',()=>{
 const store=fixture();try{store.update(s=>s.tasks[0].status='queued');assert.equal(nextTask(store.read(),new Date(),CHANNELS),undefined);store.update(s=>Object.assign(s.tasks[0],{blogger,checkpoint:'blogger_draft_created'}));assert.equal(nextTask(store.read(),new Date(),CHANNELS)?.id,tid);store.update(s=>s.accountBindings=[]);assert.equal(nextTask(store.read(),new Date(),CHANNELS),undefined)}finally{store.close()}
});
test('pause retains the exact Blogger draft receipt but cannot authorize publishing or a different post',()=>{
 const store=fixture(),abort=new AbortController(),c=new Controller(store,vault,'fixture');
 try{store.update(s=>s.tasks[0].status='running');const context=(c as unknown as {context(t:Task,s:AbortSignal):ExecutionContext}).context(store.read().tasks[0],abort.signal);abort.abort();context.checkpoint({blogger,checkpoint:'blogger_draft_created',submittedAt:stamp});assert.equal(store.read().tasks[0].blogger?.postId,'200');assert.throws(()=>context.checkpoint({blogger:{...blogger,stage:'publishing'},checkpoint:'blogger_publish_submitting',submittedAt:stamp}),/暂停/);assert.throws(()=>context.checkpoint({blogger:{...blogger,postId:'201'},checkpoint:'blogger_draft_created',submittedAt:stamp}),/暂停/)}finally{store.close()}
});
test('restored Blogger external draft retains post identity but loses publishing approval',()=>{
 const store=fixture();try{store.update(s=>{const t=s.tasks[0];t.blogger=blogger;t.checkpoint='blogger_draft_created';t.articleApprovedAt=stamp;t.articleReview=approve(t,s.sites[0],CHANNELS.find(c=>c.id==='blogger')!,s.settings)});const out=validateBackup({state:store.read(),secrets:{['account:'+aid]:'synthetic-credential'}});assert.equal(out.state.tasks[0].blogger?.postId,'200');assert.equal(out.state.tasks[0].articleApprovedAt,undefined);assert.equal(out.state.tasks[0].articleReview?.status,'failed')}finally{store.close()}
});
test('reconciliation never resumes a skipped draft even when exact post is recovered',async()=>{
 const store=fixture();store.update(s=>s.tasks[0].status='skipped');let writes=0;
 const c=new Controller(store,vault,'fixture',{reconcileBlogger:async()=>({status:'draft',blogger}),executeTask:async()=>{writes++;throw Error('unexpected')}});c.runtime.aiReady=true;
 try{await c.tick();assert.equal(writes,0);assert.equal(store.read().tasks[0].status,'skipped')}finally{store.close()}
});
test('a user skip while Blogger reconciliation is in flight is preserved',async()=>{
 const store=fixture();let writes=0,release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r);
 const c=new Controller(store,vault,'fixture',{reconcileBlogger:async()=>{started();await wait;return {status:'draft',blogger}},executeTask:async()=>{writes++;throw Error('unexpected')}});c.runtime.aiReady=true;
 try{const run=c.tick();await ready;c.patch(tid,{status:'skipped'});release();await run;assert.equal(writes,0);assert.equal(store.read().tasks[0].status,'skipped')}finally{store.close()}
});
test('claimed remote Blogger draft survives a temporary AI review failure and resumes the same task',async()=>{
 const store=fixture();let reads=0,reviews=0,writes=0;
 const c=new Controller(store,vault,'fixture',{reconcileBlogger:async()=>{reads++;return {status:'draft',blogger}},reviewArticle:async(t,s,ch,set)=>{reviews++;const result=approve(t,s,ch,set);return reviews===1?{...result,status:'failed',reasonCode:'ai_unavailable',reason:'temporary provider failure'}:result},executeTask:async ctx=>{writes++;assert.equal(ctx.task.blogger?.postId,'200');return {status:'needs_input',message:'fixture done'}}});c.runtime.aiReady=true;
 try{await c.tick();let t=store.read().tasks[0];assert.equal(t.status,'failed');assert.equal(t.checkpoint,'system_wait');assert.equal(reads,1);assert.equal(writes,0);store.update(s=>{maintainWaitingTasks(s.tasks,s.sites,CHANNELS,s.settings,new Date(Date.now()+25*3600000));s.tasks[0].scheduledAt=stamp});assert.equal(store.read().tasks[0].recoveryAttempts,1);assert.equal(store.read().tasks[0].blogger?.postId,'200');await c.tick();assert.equal(reviews,2);assert.equal(writes,1);assert.equal(store.read().tasks.length,1)}finally{store.close()}
});
test('claimed Blogger manual review remains visible and approval can continue the same remote draft',async()=>{
 const store=fixture();store.update(s=>s.settings.articleReviewMode='manual');let writes=0;const c=new Controller(store,vault,'fixture',{reconcileBlogger:async()=>({status:'draft',blogger}),executeTask:async ctx=>{writes++;assert.equal(ctx.task.blogger?.postId,'200');return {status:'needs_input',message:'fixture done'}}});c.runtime.aiReady=true;
 try{await c.tick();const t=store.read().tasks[0];assert.equal(t.checkpoint,'article_review');assert.equal(t.status,'needs_input');assert.equal(writes,0);const {taskHasArticleReview}=await import('../src/ui/presentation');assert.equal(taskHasArticleReview(t),true);c.patch(tid,{articleApprovedAt:new Date().toISOString(),status:'queued',scheduledAt:stamp});await c.tick();assert.equal(writes,1)}finally{store.close()}
});

test('found Blogger reconciliation persists the confirmed original post receipt before complete public verification',async()=>{
 for(const stage of ['inserting','publishing'] as const){
  const store=fixture();let publishes=0,publicReads=0,verifies=0;
  store.update(s=>{const t=s.tasks[0];t.articleApprovedAt=stamp;t.draft!.body=['The original article explains reproducible evidence checks and the limits of each observation. Readers record the source and compare the observations before reaching a conclusion.','Keep a separate record of each failure condition and inspect the original evidence before relying on any claim. Promotional statements remain separate from measured facts.','The final record preserves uncertainty and explains what evidence could disprove the result, so the guide remains useful independently of any commercial relationship.'].join('\n\n')});
  const operationId='55555555-5555-4555-8555-555555555555',url='https://example.blogspot.com/2026/10/original-guide.html';
  let original:NonNullable<Task['blogger']>,page='';
  const c=new Controller(store,vault,'fixture',{
    reconcileBlogger:async()=>({status:'found',publicUrl:url,blogger:{...original,stage:'published',postId:'200'}}),
    verifyBlogger:async context=>{verifies++;assert.equal(context.task.blogger?.stage,'published');assert.equal(context.task.blogger?.postId,'200');return verifyBloggerPublication(context,{request:async()=>{throw Error('No authenticated request during verification')},publicFetch:{resolve:async()=>[{address:'8.8.8.8',family:4}],request:async()=>{publicReads++;return {status:200,headers:{'content-type':'text/html'},body:Buffer.from(page)}}}})},
    executeTask:async()=>{publishes++;throw Error('must not create or publish again')},
  });
  const context=(c as unknown as {context(t:Task,s:AbortSignal):ExecutionContext}).context(store.read().tasks[0],new AbortController().signal),article=bloggerTesting.approvedArticle(context);
  original={blogId:'100',operationId,contentHash:article.contentHash,stage,...(stage==='publishing'?{postId:'200'}:{})};
  page=`<article><h3 class="post-title">${article.title}</h3><div class="post-body">${article.content(operationId)}</div></article>`;
  store.update(s=>Object.assign(s.tasks[0],{blogger:original,checkpoint:stage==='inserting'?'blogger_insert_submitting':'blogger_publish_submitting'}));
  try{await c.tick();const saved=store.read().tasks[0];assert.equal(saved.status,'live',stage);assert.equal(saved.linkCheck,'found');assert.ok(saved.firstLiveAt);assert.equal(saved.blogger?.stage,'published');assert.equal(saved.blogger?.postId,'200');assert.equal(saved.blogger?.operationId,operationId);assert.equal(saved.blogger?.contentHash,article.contentHash);assert.equal(saved.submittedAt,stamp);assert.equal(publishes,0);assert.equal(publicReads,1);assert.equal(verifies,1)}finally{store.close()}
 }
});

test('Blogger found reconciliation rejects a mismatched or incomplete published receipt without changing the original intent',async()=>{
 for(const mutation of ['blog','operation','hash','post','stage','missing','origin'] as const){
  const store=fixture(),original={...blogger,stage:'publishing' as const},receipt={...original,stage:'published' as const};let verifies=0,publishes=0;
  store.update(s=>Object.assign(s.tasks[0],{blogger:original,checkpoint:'blogger_publish_submitting'}));
  if(mutation==='blog')receipt.blogId='999';if(mutation==='operation')receipt.operationId='different';if(mutation==='hash')receipt.contentHash='b'.repeat(64);if(mutation==='post')receipt.postId='999';
  const c=new Controller(store,vault,'fixture',{
    reconcileBlogger:async()=>({status:'found',publicUrl:mutation==='origin'?'https://other.blogspot.com/2026/10/original.html':'https://example.blogspot.com/2026/10/original.html',blogger:mutation==='missing'?undefined as unknown as NonNullable<Task['blogger']>:mutation==='stage'?{...receipt,stage:'publishing'}:receipt}),
    verifyBlogger:async()=>{verifies++;throw Error('invalid identity reached public verification')},executeTask:async()=>{publishes++;throw Error('must not publish')},
  });
  try{await c.tick();const saved=store.read().tasks[0];assert.deepEqual(saved.blogger,original,mutation);assert.equal(saved.publicUrl,undefined,mutation);assert.equal(saved.submittedAt,stamp);assert.equal(saved.checkpoint,'blogger_publish_submitting');assert.equal(verifies,0);assert.equal(publishes,0)}finally{store.close()}
 }
});
