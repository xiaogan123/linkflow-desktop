import test,{beforeEach,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,emptyState} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {validateBackup} from '../src/main/backup-validation';
import {connectArticleAccount} from '../src/main/article-connections';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {makePlan,nextTask,reflowQueuedSchedules,selectTaskPlatform,publicationExecutionAt} from '../src/main/planner';
import {maintainWaitingTasks,resumeDeferredTask} from '../src/main/task-recovery';
import {publicationOpportunity,reservesMonthlySlot} from '../src/shared/publication';
import {CHANNELS} from '../src/integrations/catalog';
import type {Account,SecretStore,Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const stamp='2026-10-07T00:00:00.000Z';
beforeEach(t=>(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-19T10:17:00.000Z')}));
const siteId='11111111-1111-4111-8111-111111111111';
const hiveId='22222222-2222-4222-8222-222222222222';
const nostrId='33333333-3333-4333-8333-333333333333';
const paperId='44444444-4444-4444-8444-444444444444';
const paperTaskId='55555555-5555-4555-8555-555555555555';
const channel=(id:string)=>CHANNELS.find(item=>item.id===id)!;

function site():Site{return {id:siteId,url:'https://example.com',domain:'example.com',name:'Synthetic guides',email:'owner@example.com',description:'Independent educational articles',category:'content',language:'en',status:'ready',monthlyTarget:2,articleReviewMode:'ai',createdAt:'2026-09-01T00:00:00.000Z',topicsCheckedAt:stamp,topics:[1,2,3,4].map(index=>({url:`https://example.com/guides/topic-${index}`,discoveredAt:stamp}))};}
function account(id:string,channelId:string,username:string):Account{return {id,channelId,email:'',username,publicationUrl:channelId==='hive'?`https://hive.blog/@${username}`:`https://paper.wf/${username}/`,status:'registered',credentialKind:'api_token',hasPassword:true,source:'imported',createdAt:stamp};}
function planningState(){
  const state=emptyState(),value=site();state.settings.autoRun=true;state.settings.timezone='UTC';state.sites=[value];
  state.accounts=[account(hiveId,'hive','fixture'),account(nostrId,'nostr','a'.repeat(64))];
  state.accountBindings=state.accounts.map((item,index)=>({id:`binding-${index}`,siteId,channelId:item.channelId,accountId:item.id,createdAt:stamp,updatedAt:stamp}));
  const matches=[{channel:channel('hive'),score:100,reason:'synthetic'},{channel:channel('nostr'),score:10,reason:'synthetic'}];
  return {state,value,matches};
}
function vault(){const secrets=new Map<string,string>();return {ready:true,available:()=>true,get:async(key:string)=>secrets.get(key),set:async(key:string,value:string)=>{secrets.set(key,value)},delete:async(key:string)=>{secrets.delete(key)},encryptSecrets:()=>({})} as unknown as Vault;}

test('a 48-hour handoff releases its slot after restart without pulling future day reservations forward',()=>{
  const directory=mkdtempSync(join(tmpdir(),'linkflow-reclaim-'));try{const store=new Store(join(directory,'state.sqlite'));store.update(state=>{const f=planningState();Object.assign(state,f.state);makePlan(state,f.value,f.matches,new Date(stamp));const first=state.tasks[0];Object.assign(first,{channelId:'hive',sourceDomain:'hive.blog',accountId:hiveId,status:'needs_input',checkpoint:'account_handoff',waitingSince:stamp});state.accounts[0].status='credentials_invalid';});const before=store.read(),second=before.tasks[1];assert.ok(second);store.close();const reopened=new Store(join(directory,'state.sqlite'));try{const at=new Date(Date.parse(stamp)+49*3600000);reopened.update(state=>{maintainWaitingTasks(state.tasks,state.sites,[channel('hive'),channel('nostr')],state.settings,at);reflowQueuedSchedules(state,[channel('hive'),channel('nostr')],at)});const after=reopened.read(),saved=after.tasks.find(item=>item.id===second.id)!;assert.equal(after.tasks[0].status,'skipped');assert.equal(saved.scheduledAt,second.scheduledAt);assert.equal(saved.channelId,'');assert.equal(after.tasks.length,2);assert.ok(Date.parse(saved.scheduledAt)>at.getTime());}finally{reopened.close();}}finally{rmSync(directory,{recursive:true,force:true});}
});

test('released reservations do not pull legacy, edited, disabled, paused, or expired plans',()=>{
  const at=new Date('2026-10-09T10:11:00Z');for(const mode of ['legacy','edited','disabled','paused'] as const){const {state,value,matches}=planningState(),[first,second]=makePlan(state,value,matches,new Date(stamp));first.status='skipped';second.scheduledAt='2026-10-20T10:11:00Z';if(mode==='legacy')delete second.scheduling;if(mode==='edited')second.scheduledAt='2026-10-21T10:11:00Z';if(mode==='disabled')state.settings.channelOverrides.nostr=false;if(mode==='paused')value.status='paused';const before=structuredClone(second);assert.deepEqual(reflowQueuedSchedules(state,matches.map(item=>item.channel),at),[]);assert.deepEqual(second,before,mode);}
});

test('a real submission remains a cadence anchor and blocks an earlier claim',()=>{
  const {state,value,matches}=planningState(),[first,second]=makePlan(state,value,matches,new Date(stamp));Object.assign(first,{channelId:'hive',sourceDomain:'hive.blog',status:'skipped',submittedAt:stamp,checkpoint:'hive_publish_submitting'});Object.assign(second,{channelId:'nostr',sourceDomain:'njump.me',scheduledAt:'2026-10-09T10:11:00Z'});const at=new Date(second.scheduledAt);assert.ok(publicationExecutionAt(state,second,at).getTime()>=Date.parse(stamp)+3*86400000);assert.equal(nextTask(state,at,matches.map(item=>item.channel)),undefined);assert.equal(state.tasks.length,2);
});

test('future work still waits thirty full days after a real same-platform publication',()=>{
  const {state,value,matches}=planningState(),[first,second]=makePlan(state,value,matches,new Date(stamp));Object.assign(first,{channelId:'telegraph',sourceDomain:'telegra.ph',status:'live',firstLiveAt:'2026-10-08T10:11:00Z',publicUrl:'https://telegra.ph/example'});Object.assign(second,{channelId:'telegraph',sourceDomain:'telegra.ph',scheduledAt:'2026-10-24T10:11:00Z'});const original=second.scheduledAt;assert.deepEqual(reflowQueuedSchedules(state,[channel('telegraph')],new Date('2026-10-09T10:11:00Z')),[]);assert.equal(second.scheduledAt,original);assert.ok(publicationExecutionAt(state,second,new Date(original)).getTime()>=Date.parse(first.firstLiveAt!)+30*86400000);
});

test('a public identity already owned by one site cannot be moved to another site after waiting',()=>{
  const {state,value,matches}=planningState(),other={...site(),id:'66666666-6666-4666-8666-666666666666',domain:'other.example',url:'https://other.example'};state.sites.push(other);const [first,second]=makePlan(state,value,matches,new Date(stamp));Object.assign(first,{channelId:'nostr',accountId:nostrId,sourceDomain:'njump.me',status:'live',firstLiveAt:'2026-10-08T10:11:00Z',publicUrl:'https://njump.me/example'});Object.assign(second,{siteId:other.id,channelId:'nostr',accountId:nostrId,sourceDomain:'njump.me',scheduledAt:'2026-10-14T10:11:00Z'});const at=new Date(second.scheduledAt);assert.ok(publicationExecutionAt(state,second,at).getTime()>at.getTime()+300*86400000);assert.equal(second.accountId,nostrId);assert.equal(state.tasks.length,2);
});

test('released October provenance cannot pull an overdue plan back across the month boundary',()=>{
  const {state,value,matches}=planningState(),[first,second]=makePlan(state,value,matches,new Date(stamp)),id=second.id;first.status='skipped';const at=new Date('2026-11-01T10:11:00Z');reflowQueuedSchedules(state,matches.map(item=>item.channel),at);assert.equal(second.id,id);assert.ok(Date.parse(second.scheduledAt)>at.getTime());assert.equal(second.scheduling?.reschedules,1);assert.equal(state.tasks.length,2);
});

test('validated backups preserve fresh reservation provenance',()=>{
  const state=emptyState();state.sites=[site()];state.tasks=[{id:paperTaskId,siteId,channelId:'nostr',sourceDomain:'njump.me',status:'queued',createdAt:stamp,scheduledAt:'2026-10-14T00:00:00.000Z',updatedAt:stamp,attempts:0,message:'fixture',
    autoSchedule:{kind:'planner',channelId:'nostr',sourceDomain:'njump.me',baseAt:stamp,plannedAt:'2026-10-14T00:00:00.000Z',reservationTaskIds:[hiveId],appliedReleaseIds:[]}}];
  assert.deepEqual(validateBackup({state,secrets:{}}).state.tasks[0].autoSchedule,state.tasks[0].autoSchedule);
});

function paperState(){
  const state=emptyState(),value=site();value.monthlyTarget=1;state.settings.autoRun=true;
  state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='paper-wf']));
  state.sites=[value];state.accounts=[{...account(paperId,'paper-wf','fixture'),status:'needs_verification',source:'generated',registrationAttempts:1,verifiedAt:undefined}];
  const task:Task={id:paperTaskId,siteId,channelId:'paper-wf',sourceDomain:'paper.wf',accountId:paperId,status:'needs_input',checkpoint:'paper_account_create_pending',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'Original registration is awaiting verification',topicUrl:'https://example.com/guides/topic-1',draft:{title:'Kept',description:'Kept',body:'Original draft'},draftRevision:1,cost:{aiCalls:2,amount:1.5},articleApprovedAt:stamp,articleReview:{status:'passed',reason:'Previous context',evidenceUrls:[],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)}};
  state.tasks=[task];return state;
}

test('a registration-only 48-hour wait releases the monthly slot without creating a second identity or task',()=>{
  for(const id of ['paper-wf','mataroa','verbose'] as const){
    const state=paperState(),value=state.sites[0],pending=state.tasks[0],entry=channel(id),now=new Date(Date.parse(stamp)+49*3600000);
    Object.assign(pending,{channelId:id,sourceDomain:entry.domain,checkpoint:`${id==='paper-wf'?'paper':id}_account_create_pending`,reasonCode:'account_handoff',waitingSince:stamp});
    Object.assign(state.accounts[0],{channelId:id,publicationUrl:id==='paper-wf'?'https://paper.wf/fixture/':id==='mataroa'?'https://fixture.mataroa.blog/':'https://verbose.blog/fixture'});
    const preserved=structuredClone(pending);
    maintainWaitingTasks(state.tasks,state.sites,[entry],state.settings,now);
    assert.equal(pending.status,'skipped',id);assert.equal(pending.reasonCode,'human_timeout',id);assert.equal(pending.cooldownUntil,new Date(now.getTime()+14*86400000).toISOString(),id);assert.equal(pending.deferredAt,undefined,id);
    assert.equal(reservesMonthlySlot(pending,now,state.settings.timezone),false,id);
    for(const field of ['id','accountId','checkpoint','draft','draftRevision','cost'] as const)assert.deepEqual(pending[field],preserved[field],`${id}:${field}`);
    const restored=validateBackup({state:structuredClone(state),secrets:{['account:'+paperId]:'synthetic-only-token'}}).state.tasks[0];
    assert.equal(restored.status,'skipped',id);assert.equal(restored.reasonCode,'human_timeout',id);assert.equal(restored.cooldownUntil,pending.cooldownUntil,id);assert.equal(restored.deferredAt,undefined,id);assert.equal(restored.accountId,paperId,id);
    assert.equal(restored.checkpoint,preserved.checkpoint,id);assert.deepEqual(restored.draft,preserved.draft,id);assert.deepEqual(restored.cost,preserved.cost,id);
    assert.equal(publicationOpportunity(value,entry,state.tasks,now,state.settings.timezone).allowed,false,id);
    state.settings.channelOverrides={'betterthanhtml':true};
    const planned=makePlan(state,value,[{channel:channel('betterthanhtml'),score:1,reason:'fixture'}],now);
    assert.equal(planned.length,1,id);assert.equal(planned[0].channelId,'',id);assert.equal(selectTaskPlatform(state,planned[0],[{channel:channel('betterthanhtml'),score:1,reason:'fixture'}],new Date(planned[0].scheduledAt))?.id,'betterthanhtml',id);
    assert.equal(state.accounts.length,1,id);assert.equal(state.accounts[0].registrationAttempts,1,id);
  }
});

test('registration deferral never discards publication uncertainty or bypasses a pause',()=>{
  const now=new Date(Date.parse(stamp)+49*3600000);
  for(const kind of ['submitted','public','receipt','paused','disabled','young'] as const){
    const state=paperState(),pending=state.tasks[0];pending.waitingSince=stamp;
    const entry={...channel('paper-wf')};
    if(kind==='submitted')pending.submittedAt=stamp;
    if(kind==='public')pending.publicUrl='https://paper.wf/fixture/pending';
    if(kind==='receipt')pending.paper={username:'fixture',slug:'pending',contentHash:'a'.repeat(64),stage:'submitting'};
    if(kind==='paused')state.sites[0].status='paused';
    if(kind==='disabled')entry.enabled=false;
    if(kind==='young')pending.waitingSince=new Date(now.getTime()-3600000).toISOString();
    maintainWaitingTasks(state.tasks,state.sites,[entry],state.settings,now);
    assert.equal(pending.status,'needs_input',kind);assert.equal(pending.deferredAt,undefined,kind);
  }
});

test('resuming a deferred registration keeps the original pending operation until its identity is verified',()=>{
  const state=paperState(),pending=state.tasks[0],now=new Date(Date.parse(stamp)+49*3600000);
  Object.assign(pending,{status:'skipped',deferredAt:now.toISOString(),waitingSince:stamp});
  resumeDeferredTask(state.tasks,pending.id,state.settings,now);
  assert.equal(pending.status,'needs_input');assert.equal(pending.checkpoint,'paper_account_create_pending');
  assert.equal(pending.accountId,paperId);assert.equal(pending.deferredAt,undefined);assert.deepEqual(pending.cost,{aiCalls:2,amount:1.5});
});

test('a deferred registration resumes only after its original identity is verified and its topic remains free',()=>{
  for(const mode of ['verified','unverified','competing-topic','published','expired'] as const){
    const store=new Store(':memory:');store.update(state=>{
      Object.assign(state,paperState());const pending=state.tasks[0];
      Object.assign(pending,{status:'skipped',deferredAt:new Date().toISOString(),waitingSince:new Date(Date.now()-(mode==='expired'?49:1)*3600_000).toISOString()});
      if(mode!=='unverified'){
        Object.assign(state.accounts[0],{status:'registered',verifiedAt:stamp});
        state.accountBindings=[{id:'66666666-6666-4666-8666-666666666666',siteId,channelId:'paper-wf',accountId:paperId,createdAt:stamp,updatedAt:stamp}];
      }
      if(mode==='competing-topic')state.tasks.push({...pending,id:'77777777-7777-4777-8777-777777777777',channelId:'betterthanhtml',sourceDomain:'betterthanhtml.com',accountId:undefined,status:'queued',checkpoint:undefined,deferredAt:undefined,waitingSince:undefined});
      if(mode==='published')pending.submittedAt=stamp;
    });
    try{
      const controller=new Controller(store,vault(),'synthetic');controller.runtime.aiReady=true;controller.plan();const saved=store.read().tasks[0];
      const resumes=mode==='verified'||mode==='expired';
      assert.equal(saved.status,resumes?'queued':'skipped',mode);
      assert.equal(saved.accountId,paperId,mode);assert.deepEqual(saved.cost,{aiCalls:2,amount:1.5},mode);
      assert.equal(saved.checkpoint,resumes?'article_review':'paper_account_create_pending',mode);
      assert.equal(saved.deferredAt===undefined,resumes,mode);
      assert.equal(store.read().accounts[0].registrationAttempts,1,mode);
      if(resumes)assert.equal(saved.articleReview,undefined);
      // A verified identity resumes even after the original wait expired; it is not a human stop any more.
      if(mode==='expired')assert.equal(saved.waitingDeadlineAt,undefined);
    }finally{store.close()}
  }
});

test('same verified Paper identity resumes its original task and invalidates stale review',async()=>{
  const store=new Store(':memory:'),secret=vault();store.update(state=>Object.assign(state,paperState()));
  const controller=new Controller(store,secret,'synthetic');controller.runtime.aiReady=true;
  try{
    controller.plan();assert.equal(store.read().tasks[0].status,'needs_input');
    await connectArticleAccount(store,secret,{channelId:'paper-wf',username:'fixture',credential:'synthetic-only',siteIds:[siteId],accountId:paperId},
      async(vault:SecretStore,id:string,username:string,credential:string)=>{await vault.set('account:'+id,credential);return {username,url:`https://paper.wf/${username}/`};});
    controller.plan();const state=store.read(),task=state.tasks[0];
    assert.equal(channelExecutionReadiness(state,siteId,channel('paper-wf'),paperId).kind,'ready');
    assert.equal(state.tasks.length,1);assert.equal(task.id,paperTaskId);assert.equal(task.accountId,paperId);
    assert.equal(task.status,'queued');assert.equal(task.checkpoint,'article_review');
    assert.equal(task.attempts,1);assert.deepEqual(task.cost,{aiCalls:2,amount:1.5});assert.equal(task.draft?.title,'Kept');
    assert.equal(task.articleReview,undefined);assert.equal(task.articleApprovedAt,undefined);
    assert.equal(state.accounts[0].registrationAttempts,1);
    controller.plan();assert.equal(store.read().tasks.length,1);assert.equal(store.read().tasks[0].attempts,1);
  }finally{store.close();}
});

test('Paper registration wait never resumes on unverified, rebound, submitted, or exhausted state',()=>{
  for(const mode of ['unverified','unbound','rebound','submitted','receipt','budget','attempts','paused'] as const){
    const store=new Store(':memory:');store.update(state=>{
      Object.assign(state,paperState());const current=state.accounts[0];
      Object.assign(current,{status:'registered',verifiedAt:stamp});
      state.accountBindings=[{id:'binding',siteId,channelId:'paper-wf',accountId:paperId,createdAt:stamp,updatedAt:stamp}];
      if(mode==='unverified')delete current.verifiedAt;
      if(mode==='unbound')state.accountBindings=[];
      if(mode==='rebound')state.accountBindings[0].accountId='66666666-6666-4666-8666-666666666666';
      if(mode==='submitted')state.tasks[0].submittedAt=stamp;
      if(mode==='receipt')state.tasks[0].paper={username:'fixture',slug:'kept',contentHash:'a'.repeat(64),stage:'submitting'};
      if(mode==='budget')state.tasks[0].cost={aiCalls:6};
      if(mode==='attempts')state.tasks[0].attempts=state.settings.maxAttempts;
      if(mode==='paused')state.sites[0].status='paused';
    });
    try{new Controller(store,vault(),'synthetic').plan();const state=store.read();assert.equal(state.tasks.length,1,mode);assert.equal(state.tasks[0].status,'needs_input',mode);assert.equal(state.tasks[0].checkpoint,'paper_account_create_pending',mode);assert.equal(state.accounts[0].registrationAttempts,1,mode);}
    finally{store.close();}
  }
});

test('a Paper signup attempt remains pinned to its original identity after a later credential failure',()=>{
  const store=new Store(':memory:');store.update(state=>{
    Object.assign(state,paperState());
    state.accounts[0].status='credentials_invalid';
    state.accounts.push({...account('66666666-6666-4666-8666-666666666666','paper-wf','another'),verifiedAt:stamp});
    state.accountBindings=[{id:'replacement-binding',siteId,channelId:'paper-wf',accountId:state.accounts[1].id,createdAt:stamp,updatedAt:stamp}];
    Object.assign(state.tasks[0],{checkpoint:'account_handoff',message:'Original account needs reconnection'});
  });
  try{new Controller(store,vault(),'synthetic').plan();const state=store.read();assert.equal(state.tasks.length,1);assert.equal(state.tasks[0].status,'needs_input');assert.equal(state.tasks[0].accountId,paperId);assert.equal(state.accounts[0].registrationAttempts,1);}
  finally{store.close();}
});
