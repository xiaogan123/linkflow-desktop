import assert from 'node:assert/strict';
import test from 'node:test';
import {CHANNELS} from '../src/integrations/catalog';
import {Controller} from '../src/main/controller';
import {Store} from '../src/main/store';
import {buildArticleEvidenceSnapshot,validateFactManifest} from '../src/main/article-evidence';
import type {Vault} from '../src/main/vault';
import type {Site,Task} from '../src/shared/types';

const now='2026-10-18T12:17:00.000Z';
const old='2026-09-01T12:17:00.000Z';
const site:Site={id:'11111111-1111-4111-8111-111111111111',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Educational documentation',language:'en',category:'content',status:'ready',createdAt:old,monthlyTarget:1,topicsCheckedAt:now,topics:[{url:'https://example.com/guide',title:'Source guide',discoveredAt:old}]};
const task:Task={id:'22222222-2222-4222-8222-222222222222',siteId:site.id,channelId:'',sourceDomain:'',status:'queued',createdAt:now,updatedAt:now,scheduledAt:now,attempts:0,message:'',scheduling:{version:1,month:'2026-10',slot:0,target:1,effectiveTarget:1,reschedules:0}};
const vault={ready:true,available:()=>true,get:async()=>undefined} as unknown as Vault;

for(const limit of ['none','accounts','ai'] as const)test(`deferred platform selection preserves the ${limit} gate before paid work`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(now)});
  const store=new Store(':memory:');let calls=0;
  store.update(state=>{
    state.settings.autoRun=true;state.settings.notify=false;state.settings.monitorSearch=false;state.settings.timezone='UTC';
    // An unsafe public author exercises the guard after deferred platform selection.
    state.sites=[{...structuredClone(site),name:'Referral code TEST1234'}];state.tasks=[structuredClone(task)];
    if(limit==='accounts')state.accounts=Array.from({length:2},(_,index)=>({id:`33333333-3333-4333-8333-33333333333${index}`,channelId:'telegraph',email:'',username:`example-author-${index}`,status:'registered',source:'generated',hasPassword:true,createdAt:now,retiredAt:now}));
    if(limit==='ai')state.usage['2026-10-18']=state.settings.dailyAiLimit;
  });
  const controller=new Controller(store,vault,'fixture',{
    channelCatalog:[{...CHANNELS.find(channel=>channel.id==='telegraph')!,enabled:true}],
    aiFactory:()=>({json:async<T>()=>{calls++;throw Error('Unexpected paid call') as T}}),
    prepareTask:async()=>{calls++;throw Error('Unexpected account preparation')},
    executeTask:async()=>{calls++;throw Error('Unexpected publication')},
  });controller.runtime.aiReady=true;
  try{
    await controller.tick();const saved=store.read().tasks.find(value=>value.id===task.id)!;
    assert.equal(controller.runtime.error,undefined);assert.equal(calls,0);assert.equal(saved.submittedAt,undefined);
    if(limit==='none'){
      assert.equal(saved.channelId,'telegraph');assert.equal(saved.status,'failed');
      assert.equal(saved.reasonCode,'referral_blocked');assert.equal(saved.reason,undefined);assert.equal(saved.cooldownUntil,undefined);
    }else{
      assert.equal(saved.status,'queued');assert.ok(Date.parse(saved.scheduledAt)>Date.parse(now));
      assert.notEqual(saved.checkpoint,'referral_guard');
      if(limit==='ai'){assert.equal(saved.reasonCode,'ai_daily_limit');assert.equal(saved.channelId,'')}
      else assert.equal(saved.channelId,'telegraph');
    }
  }finally{controller.stop();store.close()}
});

for(const blocked of [false,true])test(`referral cleanup ${blocked?'preserves blocked facts':'removes only deleted claims before re-review'}`,()=>{
  const topicUrl='https://example.com/guide',retained='The guide explains the source material.',removed='The waiting period is 30 days with referral code TEST1234.';
  const snapshot=buildArticleEvidenceSnapshot(site,{url:topicUrl,text:retained+' '+removed},[],new Date(now));
  const draft={title:blocked?'Referral code TEST1234':'Source guide',description:'Educational guide',body:`${retained}\n\nRead [the guide](${topicUrl}).\n\n${removed}`};
  const facts=[retained,removed].map(claim=>({claim,url:topicUrl,quote:claim}));
  const store=new Store(':memory:');
  store.update(state=>{state.sites=[structuredClone(site)];state.tasks=[{...structuredClone(task),channelId:'telegraph',sourceDomain:'telegra.ph',topicUrl,draft,evidenceSnapshot:snapshot,factManifest:facts,articleApprovedAt:now}]});
  const controller=new Controller(store,vault,'fixture');
  try{
    const guard=controller as unknown as {prepareReferralGuard(id:string,final:boolean):boolean};
    assert.equal(guard.prepareReferralGuard(task.id,true),false);
    const saved=store.read().tasks[0];assert.deepEqual(saved.evidenceSnapshot,snapshot);assert.equal(saved.articleApprovedAt,undefined);
    if(blocked){assert.deepEqual(saved.draft,draft);assert.deepEqual(saved.factManifest,facts);assert.equal(saved.reasonCode,'referral_blocked')}
    else{assert.deepEqual(saved.factManifest,[facts[0]]);assert.equal(validateFactManifest(saved.draft!,saved.factManifest,snapshot),undefined);assert.equal(saved.status,'queued');assert.equal(saved.checkpoint,'article_review')}
  }finally{controller.stop();store.close()}
});
