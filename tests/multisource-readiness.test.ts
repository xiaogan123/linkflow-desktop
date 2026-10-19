import {pinPublicationFixtures} from './helpers/publication-snapshot';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CHANNELS} from '../src/integrations/catalog';
import {accountForSiteChannel,bindAccount,channelExecutionReadiness,isLegacySharedGeneratedTaskAccount} from '../src/main/account-bindings';
import {Controller} from '../src/main/controller';
import {makePlan,selectTaskPlatform} from '../src/main/planner';
import {emptyState,Store} from '../src/main/store';
import {channelReadinessForDisplay} from '../src/ui/presentation';
import {hasLegacyPublicIdentityMarker} from '../src/shared/public-identity-policy';
import type {Vault} from '../src/main/vault';
import type {Account,AccountStatus,Site,Snapshot,Task} from '../src/shared/types';

const stamp='2026-10-07T00:00:00.000Z';
const now=new Date(stamp);
const nostr=CHANNELS.find(channel=>channel.id==='nostr')!;
const telegraph=CHANNELS.find(channel=>channel.id==='telegraph')!;
const verbose=CHANNELS.find(channel=>channel.id==='verbose')!;

function verboseAccount(source:'generated'|'imported'='generated'):Account{
  return {id:'verbose-account',channelId:'verbose',email:'',username:'siteauthor',
    displayName:'Site author',publicationUrl:'https://verbose.blog/siteauthor',
    createdAt:stamp,status:'registered',hasPassword:true,credentialKind:'api_token',source};
}

function displayReadiness(state:ReturnType<typeof emptyState>,site:Site,channel=verbose){
  const snapshot:Snapshot={...state,channels:[channel],runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:true,version:'test',platform:'test',dataPath:'',aiCallsToday:0}};
  return channelReadinessForDisplay(snapshot,site,channel);
}

function fixture(accountStatus:AccountStatus){
  const state=emptyState();
  const site:Site={id:'site-a',domain:'a.example.com',url:'https://a.example.com',email:'owner@example.com',name:'Example A',description:'Original educational guides',category:'content',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:stamp,topics:[{url:'https://a.example.com/guides/verification',discoveredAt:stamp}]};
  const other:Site={...site,id:'site-b',domain:'b.example.com',url:'https://b.example.com'};
  const account={id:'nostr-account',channelId:'nostr',email:site.email,username:'a'.repeat(64),createdAt:stamp,status:accountStatus,hasPassword:true,credentialKind:'api_token' as const,source:'generated' as const};
  state.settings.timezone='UTC';state.settings.autoRun=true;
  state.sites=[site,other];state.accounts=[account];
  state.accountBindings=[{id:'binding-b',siteId:other.id,channelId:'nostr',accountId:account.id,createdAt:stamp,updatedAt:stamp}];
  const snapshot:Snapshot={...state,channels:[nostr],runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:true,version:'test',platform:'test',dataPath:'',aiCallsToday:0}};
  return {state,site,account,snapshot};
}

test('legacy public identity marker checks generated public fields, not private labels or imported identities',()=>{
  const account=verboseAccount();
  assert.equal(hasLegacyPublicIdentityMarker(account),false);
  assert.equal(hasLegacyPublicIdentityMarker({...account,username:'LinkFlow_writer'}),true);
  assert.equal(hasLegacyPublicIdentityMarker({...account,displayName:'Linkflow local label'}),false);
  assert.equal(hasLegacyPublicIdentityMarker({...account,publicationUrl:'https://verbose.blog/linkflow-author'}),true);
  assert.equal(hasLegacyPublicIdentityMarker({...account,channelId:'notebin',displayName:'Linkflow Notebin Publisher',publicationUrl:undefined}),true);
  assert.equal(hasLegacyPublicIdentityMarker({...account,channelId:'shippage',displayName:'Linkflow local label',publicationUrl:undefined}),false);
  assert.equal(hasLegacyPublicIdentityMarker({...account,channelId:'berrry',displayName:'Linkflow Berrry publishing agent',publicationUrl:undefined}),false);
  assert.equal(hasLegacyPublicIdentityMarker({...account,channelId:'berrry',username:'Linkflow-publisher',publicationUrl:undefined}),true);
  assert.equal(hasLegacyPublicIdentityMarker({...account,diagnostic:{code:'legacy_saved',message:'Linkflow migration',at:stamp,retryable:false}}),false);
  const profile:Account={...account,channelId:'agenthow',agentHow:{version:1,stage:'ready',operationId:'operation',requestHash:'hash',label:'LinkFlow research agent'}};
  assert.equal(hasLegacyPublicIdentityMarker(profile),true);
  assert.equal(hasLegacyPublicIdentityMarker({...profile,source:'imported'}),false);
  for(const channelId of ['telegraph','nostr']){
    assert.equal(hasLegacyPublicIdentityMarker({...account,channelId,username:'Linkflow local label',displayName:'Linkflow local display',publicationUrl:undefined}),false);
  }
});

test('branded generated author is blocked in backend, display and planner while a neutral author remains usable',()=>{
  const {state,site}=fixture('registered');
  state.accounts=[verboseAccount()];state.accountBindings=[];
  const neutral=channelExecutionReadiness(state,site.id,verbose);
  assert.equal(neutral.kind,'ready');
  assert.equal(displayReadiness(state,site),'ready');
  assert.equal(makePlan(state,site,[{channel:verbose,score:100,reason:'qualified'}],now).length,1);
  state.tasks=[];
  state.accounts[0].username='linkflowauthor';
  state.accounts[0].publicationUrl='https://verbose.blog/linkflowauthor';
  bindAccount(state,state.accounts[0].id,site.id,verbose);
  assert.equal(channelExecutionReadiness(state,site.id,verbose).kind,'handoff_required');
  assert.equal(displayReadiness(state,site),'handoff_required');
  assert.deepEqual(makePlan(state,site,[{channel:verbose,score:100,reason:'qualified'}],now),[]);
  assert.equal(accountForSiteChannel(state,site.id,verbose.id,state.accounts[0].id)?.id,state.accounts[0].id);
});

test('unbound branded generated candidate cannot trigger a fresh registration or new task',()=>{
  const {state,site}=fixture('registered');
  state.accounts=[{...verboseAccount(),username:'linkflowauthor',publicationUrl:'https://verbose.blog/linkflowauthor'}];state.accountBindings=[];
  assert.equal(channelExecutionReadiness(state,site.id,verbose).kind,'handoff_required');
  assert.equal(displayReadiness(state,site),'handoff_required');
  assert.deepEqual(makePlan(state,site,[{channel:verbose,score:100,reason:'qualified'}],now),[]);
  state.accounts[0].source='imported';
  assert.equal(channelExecutionReadiness(state,site.id,verbose).kind,'ready');
  assert.equal(displayReadiness(state,site),'ready');
});

test('historical branded publication remains available for a read-only public URL recheck',async()=>{
  const {state,site}=fixture('registered'),account={...verboseAccount(),username:'linkflowauthor',publicationUrl:'https://verbose.blog/linkflowauthor'};
  state.accounts=[account];state.accountBindings=[];
  const task:Task={id:'old-publication',siteId:site.id,channelId:verbose.id,accountId:account.id,
    sourceDomain:verbose.domain,status:'live',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,
    message:'historical publication',publicUrl:'https://verbose.blog/linkflowauthor/old-article',firstLiveAt:stamp};
  state.tasks=[task];
  const store=new Store(':memory:');let checks=0;
  try{
    store.update(current=>Object.assign(current,state));
    assert.equal(channelExecutionReadiness(store.read(),site.id,verbose).kind,'handoff_required');
    assert.equal(accountForSiteChannel(store.read(),site.id,verbose.id,account.id)?.id,account.id);
    const controller=new Controller(pinPublicationFixtures(store),{ready:true,available:()=>true} as unknown as Vault,'isolated',{
      channelCatalog:[verbose],recheckLink:async url=>{checks++;assert.equal(url,task.publicUrl);return {found:true,outcome:'found',url,rel:'nofollow',reason:'current link found',reasonCode:'link_found',matchedOrigin:site.url,usesLegacyOrigin:false,indexable:true}},
    });
    try{await (pinPublicationFixtures(controller.store),controller.verify(task.id))}finally{controller.stop()}
    assert.equal(checks,1);
    assert.equal(store.read().tasks[0].status,'live');
    assert.equal(store.read().tasks[0].linkCheck,'found');
  }finally{store.close()}
});

test('branded generated identity does not block a submitted receipt readback',async()=>{
  const {state,site}=fixture('registered'),account={...verboseAccount(),username:'linkflowauthor',publicationUrl:'https://verbose.blog/linkflowauthor'};
  state.accounts=[account];
  state.accountBindings=[{id:'old-verbose-binding',siteId:site.id,channelId:verbose.id,accountId:account.id,createdAt:stamp,updatedAt:stamp}];
  const task:Task={id:'pending-verbose-receipt',siteId:site.id,channelId:verbose.id,accountId:account.id,
    sourceDomain:verbose.domain,status:'review',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,
    message:'receipt awaiting public check',submittedAt:stamp,checkpoint:'verbose_published',
    publicUrl:'https://verbose.blog/linkflowauthor/old-article',verbose:{username:account.username,slug:'old-article',contentHash:'a'.repeat(64),stage:'published'}};
  state.tasks=[task];
  const store=new Store(':memory:');let reads=0;
  try{
    store.update(current=>Object.assign(current,state));
    assert.equal(channelExecutionReadiness(store.read(),site.id,verbose,account.id).kind,'handoff_required');
    const controller=new Controller(pinPublicationFixtures(store),{ready:true,available:()=>true} as unknown as Vault,'isolated',{
      channelCatalog:[verbose],recheckLink:async url=>{reads++;assert.equal(url,task.publicUrl);return {found:true,outcome:'found',url:task.publicUrl!,rel:'nofollow',reason:'old receipt found',reasonCode:'link_found'}},
    });
    try{await (pinPublicationFixtures(controller.store),controller.verify(task.id))}finally{controller.stop()}
    assert.equal(reads,1);
    assert.equal(store.read().tasks[0].linkCheck,'found');
  }finally{store.close()}
});

test('Telegraph assigns each site one stable local token without adopting another site account',()=>{
  const {state,site}=fixture('registered');
  state.accounts=[];
  state.accountBindings=[];
  const other=state.sites[1];
  const first={id:'telegraph-a',channelId:'telegraph',email:site.email,username:site.name,createdAt:stamp,status:'registered' as const,source:'generated' as const,hasPassword:true,credentialKind:'api_token' as const};
  state.accounts.push(first);
  bindAccount(state,first.id,site.id,telegraph);
  assert.equal(channelExecutionReadiness(state,site.id,telegraph).account?.id,first.id);
  assert.equal(channelExecutionReadiness(state,site.id,telegraph).kind,'ready');
  assert.deepEqual(channelExecutionReadiness(state,other.id,telegraph),{kind:'autocreate'});
  assert.throws(()=>bindAccount(state,first.id,other.id,telegraph),/已归属其他网站/);
  const second={...first,id:'telegraph-b',username:other.name};
  state.accounts.push(second);
  bindAccount(state,second.id,other.id,telegraph);
  assert.equal(channelExecutionReadiness(state,other.id,telegraph).account?.id,second.id);
  assert.equal(channelExecutionReadiness(state,site.id,telegraph).account?.id,first.id);
});

test('Telegraph never picks an unbound imported token by matching site email',()=>{
  const {state,site,snapshot}=fixture('registered');
  state.accounts.splice(0,state.accounts.length,{id:'imported-telegraph',channelId:'telegraph',email:site.email,username:'Imported Writer',createdAt:stamp,status:'registered',source:'imported',hasPassword:true,credentialKind:'api_token'});
  state.accountBindings.splice(0);
  assert.equal(accountForSiteChannel(state,site.id,'telegraph'),undefined);
  assert.deepEqual(channelExecutionReadiness(state,site.id,telegraph),{kind:'autocreate'});
  assert.equal(channelReadinessForDisplay(snapshot,site,telegraph),'autocreate');
  bindAccount(state,'imported-telegraph',site.id,telegraph);
  assert.equal(channelExecutionReadiness(state,site.id,telegraph).kind,'ready');
  assert.deepEqual(channelExecutionReadiness(state,state.sites[1].id,telegraph),{kind:'autocreate'});
  assert.equal(channelReadinessForDisplay(snapshot,state.sites[1],telegraph),'autocreate');
  assert.throws(()=>bindAccount(state,'imported-telegraph',state.sites[1].id,telegraph),/已归属其他网站/);
});

test('another generated registration identity does not queue a second site automatically',()=>{
  const {state,site}=fixture('registered');
  state.accounts=[];
  state.accountBindings=[];
  const other=state.sites[1];
  const paper=CHANNELS.find(channel=>channel.id==='paper-wf')!;
  const account={id:'paper-a',channelId:'paper-wf',email:'',username:'exampleauthor',publicationUrl:'https://paper.wf/exampleauthor/',createdAt:stamp,status:'registered' as const,source:'generated' as const,hasPassword:true,credentialKind:'api_token' as const};
  state.accounts.push(account);
  bindAccount(state,account.id,site.id,paper);
  assert.equal(channelExecutionReadiness(state,other.id,paper).kind,'handoff_required');
  assert.throws(()=>bindAccount(state,account.id,other.id,paper),/已归属其他网站/);
});

for(const status of ['registered','restricted'] as const){
  test(`unbound Nostr site creates its own identity despite another same-email ${status} account`,()=>{
    const {state,site,snapshot}=fixture(status);
    assert.equal(channelExecutionReadiness(state,site.id,nostr).kind,'autocreate');
    assert.equal(channelReadinessForDisplay(snapshot,site,nostr),'autocreate');
    const [task]=makePlan(state,site,[{channel:nostr,score:100,reason:'qualified'}],now);
    assert.ok(task);
    assert.equal(task.accountId,undefined);
    assert.equal(task.channelId,'');assert.equal(selectTaskPlatform(state,task,[{channel:nostr,score:100,reason:'qualified'}],new Date(task.scheduledAt))?.id,'nostr');
  });

  test(`legacy cross-site Nostr binding permits a fresh identity for each site while ${status} history stays pinned`,()=>{
    const {state,site,account,snapshot}=fixture(status);
    state.accountBindings.push({id:'binding-a',siteId:site.id,channelId:'nostr',accountId:account.id,createdAt:stamp,updatedAt:stamp});
    const expected='autocreate';
    assert.equal(channelExecutionReadiness(state,site.id,nostr).kind,expected);
    assert.equal(channelReadinessForDisplay(snapshot,site,nostr),expected);
    const tasks=makePlan(state,site,[{channel:nostr,score:100,reason:'qualified'}],now);
    assert.equal(tasks.length,1);
    assert.equal(tasks[0].accountId,undefined);
    assert.equal(channelExecutionReadiness(state,site.id,nostr,account.id).kind,'handoff_required');
  });
}

for(const channel of [telegraph,nostr]){
  test(`unresolved legacy ${channel.id} result blocks a replacement identity until read-only reconciliation`,()=>{
    const {state,site,account}=fixture('registered');
    account.channelId=channel.id;
    state.accountBindings[0].channelId=channel.id;
    state.accountBindings.push({id:'binding-a',siteId:site.id,channelId:channel.id,accountId:account.id,createdAt:stamp,updatedAt:stamp});
    state.tasks.push({id:'pending',siteId:site.id,channelId:channel.id,accountId:account.id,sourceDomain:channel.domain,
      status:'needs_input',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'original result unknown',
      submittedAt:stamp,checkpoint:channel.id==='telegraph'?'telegraph_publish_uncertain':'nostr_publish_submitting'});
    assert.equal(channelExecutionReadiness(state,site.id,channel).kind,'handoff_required');
    const replacement={...account,id:'replacement'};
    state.accounts.push(replacement);
    assert.throws(()=>bindAccount(state,replacement.id,site.id,channel),/发布结果待检查/);
    if(channel.id==='telegraph'){
      state.tasks[0].submittedAt=undefined;
      state.tasks[0].checkpoint='telegraph_account_create_pending';
      assert.equal(channelExecutionReadiness(state,site.id,channel).kind,'handoff_required');
      assert.throws(()=>bindAccount(state,replacement.id,site.id,channel),/发布结果待检查/);
    }
  });

  for(const source of ['generated','imported'] as const)test(`Store migrates a shared legacy ${source} ${channel.id} binding to separate stable site identities`,()=>{
    const dir=mkdtempSync(join(tmpdir(),`linkflow-${channel.id}-legacy-`)),store=new Store(join(dir,'state.sqlite'));
    try{
      const state=emptyState(),past='2026-09-01T00:00:00.000Z';
      state.settings.timezone='UTC';
      const sites:Site[]=[
        {id:'11111111-1111-4111-8111-111111111111',domain:'alpha.example.test',url:'https://alpha.example.test/',email:'owner@alpha.example.test',name:'Alpha Docs',description:'Alpha technical guides',category:'software',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:past,topics:[{url:'https://alpha.example.test/guides/recovery',discoveredAt:past}]},
        {id:'22222222-2222-4222-8222-222222222222',domain:'beta.example.test',url:'https://beta.example.test/',email:'owner@beta.example.test',name:'Beta Docs',description:'Beta technical guides',category:'software',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:past,topics:[{url:'https://beta.example.test/guides/recovery',discoveredAt:past}]},
      ];
      const oldId='33333333-3333-4333-8333-333333333333';
      state.sites=sites;
      state.accounts=[{id:oldId,channelId:channel.id,email:sites[0].email,username:channel.id==='nostr'?'a'.repeat(64):'Legacy Writer',createdAt:past,status:'registered',hasPassword:true,credentialKind:'api_token',source}];
      state.accountBindings=sites.map((site,index)=>({id:index?'55555555-5555-4555-8555-555555555555':'44444444-4444-4444-8444-444444444444',siteId:site.id,channelId:channel.id,accountId:oldId,createdAt:past,updatedAt:past}));
      state.tasks=sites.map((site,index):Task=>({id:index?'77777777-7777-4777-8777-777777777777':'66666666-6666-4666-8666-666666666666',siteId:site.id,channelId:channel.id,accountId:oldId,sourceDomain:channel.domain,status:'live',createdAt:past,scheduledAt:past,updatedAt:past,attempts:1,message:'historical publication',publicUrl:channel.id==='nostr'?`https://njump.me/synthetic-${index}`:`https://telegra.ph/synthetic-${index}`,firstLiveAt:past}));
      store.update(current=>Object.assign(current,state));
      const original=store.read();
      for(const task of original.tasks){assert.equal(isLegacySharedGeneratedTaskAccount(original,task),true);assert.equal(accountForSiteChannel(original,task.siteId,channel.id,oldId)?.id,oldId)}
      store.update(current=>{
        for(const site of sites){
          assert.equal(channelExecutionReadiness(current,site.id,channel).kind,'autocreate');
          assert.equal(accountForSiteChannel(current,site.id,channel.id),undefined);
          const currentSite=current.sites.find(item=>item.id===site.id)!;
          const [fresh]=makePlan(current,currentSite,[{channel,score:100,reason:'qualified'}],now);
          assert.ok(fresh);
          assert.equal(fresh.accountId,undefined);
        }
      });
      const planned=store.read();
      assert.equal(planned.tasks.filter(task=>task.status==='queued').length,2);
      store.update(current=>{for(const task of current.tasks.filter(item=>item.status==='queued')){task.channelId=channel.id;task.sourceDomain=channel.domain;task.accountId=oldId}});
      const controller=new Controller(pinPublicationFixtures(store),{ready:true,available:()=>true} as unknown as Vault,'isolated',{channelCatalog:[channel]});
      try{controller.plan()}finally{controller.stop()}
      const released=store.read();
      assert.equal(released.tasks.filter(task=>task.status==='queued').length,2);
      assert.ok(released.tasks.filter(task=>task.status==='queued').every(task=>task.accountId===undefined));
      store.update(current=>{
        for(const [index,site] of sites.entries()){
          const id=index?'99999999-9999-4999-8999-999999999999':'88888888-8888-4888-8888-888888888888';
          current.accounts.push({id,channelId:channel.id,email:site.email,username:channel.id==='nostr'?(index?'b':'c').repeat(64):site.name,createdAt:stamp,status:'registered',hasPassword:true,credentialKind:'api_token',source:'generated'});
          bindAccount(current,id,site.id,channel);
          const fresh=current.tasks.find(task=>task.siteId===site.id&&task.status==='queued');assert.ok(fresh);fresh.accountId=id;
        }
      });
      const migrated=store.read();
      assert.equal(migrated.accountBindings.length,2);
      assert.notEqual(migrated.accountBindings[0].accountId,migrated.accountBindings[1].accountId);
      for(const [index,site] of sites.entries()){
        const historical=migrated.tasks.find(task=>task.siteId===site.id&&task.status==='live');assert.ok(historical);
        assert.equal(historical.accountId,oldId);
        assert.equal(accountForSiteChannel(migrated,site.id,channel.id,historical.accountId)?.id,oldId);
        const account=migrated.accounts.find(item=>item.id===migrated.accountBindings[index].accountId);assert.ok(account);
        assert.equal(channelExecutionReadiness(migrated,site.id,channel).account?.id,account.id);
        assert.equal(channelExecutionReadiness(migrated,site.id,channel).kind,'ready');
      }
    }finally{store.close();rmSync(dir,{recursive:true,force:true})}
  });
}
