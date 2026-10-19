import {pinPublicationFixtures} from './helpers/publication-snapshot';
import assert from 'node:assert/strict';
import test from 'node:test';
import {Controller} from '../src/main/controller';
import {Store} from '../src/main/store';
import {makeTantiveIntent} from '../src/integrations/tantive';
import type {LinkResult,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const stamp='2026-10-01T00:00:00.000Z',siteId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222',publicUrl='https://tantive.space/t/73';
const vault={available:()=>true,ready:true,get:async()=>undefined,set:async()=>{},delete:async()=>{}} as unknown as Vault;
function fixture(){
 const store=new Store(':memory:');
 const draft={title:'How should a restored publisher verify old pages?',description:'Original software guide',body:'A restored publisher should check its original page before attempting any additional publication. https://example.test/tool'};
 const intent=makeTantiveIntent({name:'Example assistant',title:draft.title,room:'questions',body:draft.body},{randomUUID:()=> '33333333-3333-4333-8333-333333333333',now:()=>new Date(stamp)}).intent;
 const task:Task={id:taskId,siteId,channelId:'tantive',sourceDomain:'tantive.space',status:'review',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,submittedAt:stamp,attempts:1,message:'Receipt retained',publicationMethod:'client',publicUrl,draft,checkpoint:'tantive_api_receipt',tantive:{...intent,stage:'api_receipt',messageId:73,rootId:73},reconcileAfter:'2026-10-02T00:00:00.000Z',reconcileAttempts:2};
 store.updateWithCiphers(state=>{state.settings.autoRun=false;state.sites=[{id:siteId,domain:'example.test',url:'https://example.test/tool',email:'owner@example.test',name:'Example',description:'Original software guides',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp}];state.tasks=[task]},{[`publication:${taskId}`]:'fixture-encrypted-journal'});
 return {store,task};
}
for(const outcome of ['invalid','unreachable','absent'] as const)test(`Tantive repeated verification replaces stale healthy state with ${outcome}`,async context=>{
 context.mock.timers.enable({apis:['Date'],now:new Date('2026-10-03T00:00:00.000Z')});
 const {store,task}=fixture();let reads=0;
 try{
  const controller=new Controller(pinPublicationFixtures(store),vault,'fixture',{recheckLink:async()=>({found:false,outcome,url:publicUrl,rel:'unknown',reason:'Current public link state',reasonCode:'link_absent'}),verifyTantive:async()=>({found:++reads===1,outcome:reads===1?'found':outcome,url:publicUrl,rel:'unknown',reason:'Current page no longer matches'} satisfies LinkResult)});
  await controller.verify(taskId);const first=store.read().tasks[0];assert.equal(first.health,'healthy');assert.equal(first.linkCheck,'found');assert.equal(first.tantive?.stage,'published');assert.ok(first.firstLiveAt);
  context.mock.timers.tick(1000);await controller.verify(taskId);const second=store.read().tasks[0];
  assert.equal(reads,1);assert.equal(second.linkCheck,outcome);assert.equal(second.health,outcome==='absent'?'missing':'unknown');assert.equal(second.status,'live');assert.equal(second.lastCheckedAt,'2026-10-03T00:00:01.000Z');assert.equal(second.updatedAt,second.lastCheckedAt);assert.equal(second.firstLiveAt,first.firstLiveAt);assert.equal(second.verifiedAt,first.verifiedAt);assert.equal(second.tantive?.stage,'published');assert.equal(second.tantive?.requestHash,task.tantive?.requestHash);assert.equal(second.attempts,1);assert.equal(second.reconcileAttempts,2);assert.equal(second.publicUrl,publicUrl);assert.equal(store.read().tasks.length,1);
 }finally{store.close()}
});
test('Tantive receipt never verified remains pending and retains reconciliation on failed read',async()=>{
 const {store,task}=fixture();try{
  await new Controller(pinPublicationFixtures(store),vault,'fixture',{verifyTantive:async()=>({found:false,outcome:'invalid',url:publicUrl,rel:'unknown',reason:'Incomplete page'})}).verify(taskId);
  const saved=store.read().tasks[0];assert.equal(saved.status,'review');assert.equal(saved.health,'pending');assert.equal(saved.firstLiveAt,undefined);assert.equal(saved.linkCheck,undefined);assert.equal(saved.tantive?.stage,'api_receipt');assert.equal(saved.reconcileAfter,task.reconcileAfter);assert.equal(saved.reconcileAttempts,2);assert.equal(saved.attempts,1);
 }finally{store.close()}
});
