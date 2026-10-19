import assert from 'node:assert/strict';
import test,{beforeEach,type TestContext} from 'node:test';
import {Controller} from '../src/main/controller';
import {Store} from '../src/main/store';
import {CHANNELS} from '../src/integrations/catalog';
import {createHumanAction} from '../src/shared/human-action';
import type {Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

beforeEach(t=>(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-19T10:17:00.000Z')}));

test('snapshot keeps finance trial counts alongside human completion and mailbox readiness',()=>{
  const stamp=new Date().toISOString(),store=new Store(':memory:');
  const site:Site={id:'fixture-site',url:'https://example.com/',domain:'example.com',email:'owner@example.com',name:'Example',description:'Educational finance articles',category:'finance',language:'zh-CN',status:'ready',monthlyTarget:1,createdAt:stamp,mailboxId:'fixture-mailbox',topics:[{url:'https://example.com/guide',discoveredAt:stamp}]};
  const channel={...CHANNELS.find(value=>value.id==='rant')!,enabled:true,trial:true};
  const task:Task={id:'fixture-task',siteId:site.id,channelId:'telegraph',sourceDomain:'telegra.ph',status:'needs_input',checkpoint:'manual_submission',reasonCode:'human_required',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture'};
  task.humanAction=createHumanAction(task,{kind:'other'});
  store.update(state=>{
    state.sites=[site];state.tasks=[task];state.settings.notify=false;state.settings.channelOverrides[channel.id]=true;
    state.mailboxes=[{id:'fixture-mailbox',label:'Fixture',host:'imap.example.com',port:993,user:site.email,secure:true,aliases:[],hasPassword:true,createdAt:stamp,updatedAt:stamp}];
    state.accounts=[{id:'fixture-account',channelId:task.channelId,email:site.email,username:'fixture',mailboxId:'fixture-mailbox',status:'draft',hasPassword:false,createdAt:stamp}];
  });
  const vault={ready:true,available:()=>true} as unknown as Vault;
  const controller=new Controller(store,vault,'fixture',{channelCatalog:[channel]});
  controller.runtime.mailReady=true;
  try{
    const snapshot=controller.snapshot(),counts=snapshot.financePlatformCounts![site.id];
    assert.ok(counts.channelIds.includes(channel.id));
    assert.ok(counts.trialCount>0);
    assert.ok(counts.groupedChannelIds);
    assert.equal(Object.keys(counts.groupedChannelIds).length,8);
    assert.deepEqual(snapshot.humanActionCapabilities![task.id],{canDone:false,mode:'unsupported'});
    assert.deepEqual(snapshot.mailboxUsage!['fixture-mailbox'],{siteCount:1,platformCount:1,accountCount:1});
    assert.deepEqual(snapshot.mailboxReadiness!['fixture-mailbox'],{ready:false,level:'unavailable'});
    assert.equal(snapshot.runtime.mailReady,false);

    store.update(state=>{state.mailboxes[0].verifiedAt=stamp});
    const ready=controller.snapshot();
    assert.deepEqual(ready.mailboxReadiness!['fixture-mailbox'],{ready:true,level:'confirmation_required'});
    assert.equal(ready.runtime.mailReady,true);
    assert.deepEqual(ready.financePlatformCounts, snapshot.financePlatformCounts);
    assert.deepEqual(ready.humanActionCapabilities,snapshot.humanActionCapabilities);
  }finally{controller.stop();store.close()}
});
