import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller,isUnsentAccountlessHandoff} from '../src/main/controller';
import {Store} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import type {Site,Task} from '../src/shared/types';

// Publishing only happens 09:00-23:00 local time; run in a zone where the real clock is near midday.
function middayTimeZone(){const offset=12-new Date().getUTCHours();return offset===0?'Etc/GMT':offset>0?`Etc/GMT-${offset}`:`Etc/GMT+${-offset}`}
const at=new Date().toISOString(),siteId='11111111-1111-4111-8111-111111111111',otherSiteId='22222222-2222-4222-8222-222222222222',taskId='33333333-3333-4333-8333-333333333333';
const site=(id:string,domain:string):Site=>({id,domain,url:`https://${domain}/`,email:`owner@${domain}`,name:domain,description:'Guides',category:'content',language:'en',monthlyTarget:2,articleReviewMode:'ai',status:'ready',createdAt:at,analyzedAt:at,topicsCheckedAt:at,topics:[]});
const task=(extra:Partial<Task>={}):Task=>({id:taskId,siteId,channelId:'katbin',sourceDomain:'katb.in',status:'running',createdAt:at,scheduledAt:at,updatedAt:at,attempts:1,message:'fixture',checkpoint:'article_review',draft:{title:'T',description:'D',body:'B'},draftRevision:1,cost:{aiCalls:2,amount:0},articleReview:{status:'passed',reason:'stale',reasonCode:'passed',reviewedAt:at,evidenceUrls:[],draftRevision:0,contentHash:'0'.repeat(64),contextHash:'0'.repeat(64)},...extra});
const vault={ready:true,available:()=>true,get:async()=>undefined,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})} as unknown as Vault;
function fixture(value:Task,others:Task[]=[]){
  const store=new Store(':memory:');
  store.update(state=>{state.settings.timezone=middayTimeZone();state.settings.autoRun=true;state.settings.channelOverrides={};state.sites=[site(siteId,'example.test'),site(otherSiteId,'other.test')];state.tasks=[value,...others]});
  const controller=new Controller(store,vault,'fixture');
  return {store,release:(message:string)=>(controller as unknown as {releaseUnsentPublication(task:Task,message:string):void}).releaseUnsentPublication(value,message),read:()=>store.read().tasks.find(item=>item.id===taskId)!};
}

test('a publishing-gap wait goes back to the queue instead of asking a person to review',()=>{
  const other:Task={...task(),id:'44444444-4444-4444-8444-444444444444',siteId:otherSiteId,channelId:'pastemyst',sourceDomain:'paste.myst.rs',status:'live',submittedAt:at,firstLiveAt:at,draft:undefined,articleReview:undefined};
  const f=fixture(task(),[other]);
  try{
    f.release('Katbin 提交信息未安全保存或发布授权已改变，未发送');
    const saved=f.read();
    assert.equal(saved.status,'queued');assert.equal(saved.humanAction,undefined);assert.notEqual(saved.reasonCode,'manual_review');
    assert.ok(Date.parse(saved.scheduledAt)>Date.now());assert.equal(saved.articleReview?.status,'passed');
  }finally{f.store.close()}
});

test('a stale review with AI budget left re-reviews by itself and never reaches the to-do list',()=>{
  const f=fixture(task());
  try{
    f.release('Katbin 提交信息未安全保存或发布授权已改变，未发送');
    const saved=f.read();
    assert.equal(saved.status,'queued');assert.equal(saved.humanAction,undefined);assert.equal(saved.articleReview,undefined);assert.equal(saved.draft?.title,'T');
  }finally{f.store.close()}
});

test('a stale review with no AI budget left stops as a budget failure, not as a person\'s review',()=>{
  const f=fixture(task({cost:{aiCalls:3,amount:0}}));
  try{assert.throws(()=>f.release('x'),(error:{reasonCode?:string})=>error.reasonCode==='ai_task_limit');assert.equal(f.read().humanAction,undefined)}finally{f.store.close()}
});

test('a queued task keeps moving on its own even if an old review reason is still attached',async()=>{
  const {taskDisplayState,taskHumanActionGroup}=await import('../src/ui/presentation');
  const leftover=task({status:'queued',reasonCode:'manual_review',cost:undefined});
  assert.notEqual(taskDisplayState(leftover,Date.now()).state,'action_required');assert.equal(taskHumanActionGroup(leftover,Date.now()),undefined);
  assert.equal(taskHumanActionGroup(task({status:'needs_input',reasonCode:'manual_review'}),Date.now()),'review');
});

test('only account-less platforms skip the person: an account platform\'s refusal stays a to-do',()=>{
  const refusal={status:'needs_input',message:'WordPress.com 授权已失效'},waiting=task({status:'needs_input'});
  assert.equal(isUnsentAccountlessHandoff(refusal,waiting,{accountRequired:false},'ai'),true);
  assert.equal(isUnsentAccountlessHandoff(refusal,waiting,{accountRequired:true},'ai'),false);
  assert.equal(isUnsentAccountlessHandoff(refusal,waiting,{accountRequired:false},'manual'),false);
  assert.equal(isUnsentAccountlessHandoff({...refusal,reasonCode:'account_handoff'},waiting,{accountRequired:false},'ai'),false);
  assert.equal(isUnsentAccountlessHandoff(refusal,task({status:'needs_input',submittedAt:at,katbin:{operationId:'x',sourceHash:'a',requestHash:'b',createdAt:at,stage:'submitting'}} as Partial<Task>),{accountRequired:false},'ai'),false);
});
