import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {marked} from 'marked';
import {CHANNELS} from '../src/integrations/catalog';
import {Controller} from '../src/main/controller';
import {Store,emptyState} from '../src/main/store';
import {nextTask,publicationExecutionAt} from '../src/main/planner';
import {validateBackup} from '../src/main/backup-validation';
import {createBatch5AccountPersistence} from '../src/main/batch5-publication';
import {claimChannelTrial,trialTaskAvailable} from '../src/main/channel-trials';
import {batch5Publisher} from '../src/integrations/batch5-publishers';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import type {Vault} from '../src/main/vault';
import type {Channel,Site,Task} from '../src/shared/types';

const at='2026-10-18T10:01:00.000Z',siteId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222';
const target='https://example.com/guide';
const article={title:'金融基础知识与核对方法',description:'独立资料说明',body:`金融服务规则常变，读者应直接核对公开来源、适用范围和风险，不依赖未经证实的收益说法。\n\n这份[原始资料](${target})提供背景。本文只解释阅读规则的方法，不提供投资建议，也没有推荐码或邀请码。`};
const source=`# ${article.title}\n\n${article.description}\n\n${article.body}\n`;
test.beforeEach(t=>(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse(at)}));
function channel(id:'yeetmd'|'rant'):Channel{const result=CHANNELS.find(value=>value.id===id);assert.ok(result);return {...result,trial:true,enabled:true}}
function site():Site{return {id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example Site',description:'Independent educational finance site',category:'finance',language:'zh-CN',monthlyTarget:1,articleReviewMode:'manual',status:'ready',createdAt:at,analyzedAt:at,topicsCheckedAt:at,topics:[{url:target,discoveredAt:at}]}}
function task(id:'yeetmd'|'rant'):Task{return {id:taskId,siteId,channelId:id,sourceDomain:id==='rant'?'rant.li':'yeet.md',status:'queued',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'fixture',topicUrl:target,draft:article,draftRevision:1,articleApprovedAt:at,health:'pending'}}
function vault(store:Store):Vault{
  const decrypt=(cipher:string|undefined)=>cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():cipher;
  return {ready:true,available:()=>true,get:async(key:string)=>decrypt(store.getCipher(key)),set:async(key:string,value:string)=>store.setCipher(key,`enc:${Buffer.from(value).toString('base64url')}`),delete:async(key:string)=>store.deleteCipher(key),encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))} as unknown as Vault;
}
function fixture(id:'yeetmd'|'rant'){
  const directory=mkdtempSync(join(tmpdir(),'linkflow-batch5-controller-')),path=join(directory,'state.sqlite'),store=new Store(path),state=emptyState();
  state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='manual';state.settings.timezone='UTC';state.settings.mail.user='owner@example.com';
  state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(value=>[value.id,value.id===id]));state.sites=[site()];state.tasks=[task(id)];store.update(current=>Object.assign(current,state));
  return {directory,path,store,cleanup(){try{store.close()}catch{}rmSync(directory,{recursive:true,force:true})}};
}
function count(requests:Array<{method:string}> ,method:string){return requests.filter(value=>value.method===method).length}

test('the IPC controller path restores an automatic stop while retaining catalog policy disablement',()=>{
  const f=fixture('rant'),controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('rant')]});
  try{
    const disable=()=>f.store.update(state=>{
      state.settings.channelOverrides.rant=false;
      state.settings.channelTrials!.rant={trial:true,failures:2,evaluatedTaskIds:[],disabledAt:at,autoDisabledOverride:true};
    });
    disable();assert.equal(controller.channels()[0].enabled,false);
    controller.enableStoppedChannelTrial('rant');
    assert.equal(controller.channels()[0].enabled,true);
    assert.equal(f.store.read().settings.channelTrials?.rant.disabledAt,undefined);
    disable();const disabled=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[{...channel('rant'),enabled:false}]});
    try{assert.throws(()=>disabled.enableStoppedChannelTrial('rant'));assert.equal(f.store.read().settings.channelOverrides.rant,false)}finally{disabled.stop()}
  }finally{controller.stop();f.cleanup()}
});
function yeetTransport(requests:Array<{method:string;url:string}> ,unknown=false){const publicUrl='https://yeet.md/s/example123';return async(url:string,init:RequestInit):Promise<Response>=>{
  const method=init.method??'GET';requests.push({method,url});
  if(method==='POST'){assert.equal(url,'https://yeet.md/api/share');assert.equal((JSON.parse(String(init.body)) as {content:string}).content,source);if(unknown)throw Error('synthetic network loss');return new Response(JSON.stringify({id:'example123',url:publicUrl,deleteToken:'private-opaque-delete-token'}),{status:201,headers:{'content-type':'application/json'}})}
  if(url==='https://yeet.md/robots.txt')return new Response('User-agent: *\nAllow: /s/\nDisallow: /api/',{status:200,headers:{'content-type':'text/plain'}});
  assert.equal(url,publicUrl);return new Response(`<html><head><link rel="canonical" href="${publicUrl}"></head><body><article>${marked.parse(source,{async:false,gfm:true})}</article></body></html>`,{status:200,headers:{'content-type':'text/html'}});
}}
function rantTransport(requests:Array<{method:string;url:string}>){let username='',slug='',posted=false;
  return async(url:string,init:RequestInit):Promise<Response>=>{
    const method=init.method??'GET';requests.push({method,url});
    if(method==='POST'&&url==='https://rant.li/api/auth/signup'){
      const input=JSON.parse(String(init.body)) as {alias:string;pass:string};username=input.alias;assert.match(username,/^[a-z][a-z0-9-]+$/);assert.ok(input.pass.length>=32);
      return new Response(JSON.stringify({code:201,data:{access_token:'opaque-token-for-rant',user:{username}}}),{status:201,headers:{'content-type':'application/json'}});
    }
    if(method==='POST'){
      assert.equal(url,`https://rant.li/api/collections/${username}/posts`);assert.equal(new Headers(init.headers).get('authorization'),'Token opaque-token-for-rant');
      const input=JSON.parse(String(init.body)) as {title:string;body:string;slug:string};assert.equal(input.title,article.title);assert.equal(input.body,article.body);slug=input.slug;posted=true;
      return new Response(JSON.stringify({code:201,data:{id:'ABCDE12345',slug,title:article.title,body:article.body}}),{status:201,headers:{'content-type':'application/json'}});
    }
    assert.equal(method,'GET');
    if(url==='https://rant.li/robots.txt')return new Response('User-agent: *\nAllow: /\n',{status:200,headers:{'content-type':'text/plain'}});
    if(url.startsWith(`https://rant.li/api/collections/${username}/posts/`))return posted?new Response(JSON.stringify({code:200,data:{id:'ABCDE12345',slug,title:article.title,body:article.body}}),{status:200,headers:{'content-type':'application/json'}}):new Response('missing',{status:404,headers:{'content-type':'application/json'}});
    assert.equal(url,`https://rant.li/${username}/${slug}`);
    return new Response(`<html><head><link rel="canonical" href="${url}"></head><body><article id="post-body"><div class="e-content">${marked.parse(article.body,{async:false,gfm:true}).replaceAll('<a href=', '<a rel="nofollow" href=')}</div></article></body></html>`,{status:200,headers:{'content-type':'text/html'}});
  };
}
function plaintext(store:Store,key:string){const cipher=store.getCipher(key);if(typeof cipher!=='string')throw Error(`Missing cipher: ${key}`);assert.ok(cipher.startsWith('enc:'));return Buffer.from(cipher.slice(4),'base64url').toString()}

test('yeetmd Controller.tick binds one POST to encrypted SQLite journal and automatically promotes trial',async()=>{
  const f=fixture('yeetmd'),requests:Array<{method:string;url:string}>=[],controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('yeetmd')],batch5Dependencies:{fetch:yeetTransport(requests)}});controller.runtime.aiReady=true;
  try{assert.ok(nextTask(f.store.read(),new Date(at),controller.channels()),JSON.stringify({executionAt:publicationExecutionAt(f.store.read(),f.store.read().tasks[0],new Date(at)),channel:controller.channels()[0]}));await controller.tick();const saved=f.store.read().tasks[0];assert.equal(count(requests,'POST'),1,JSON.stringify({saved,requests,error:controller.runtime.error,events:f.store.read().events}));assert.equal(saved.batch5?.stage,'published');assert.equal(saved.status,'live');assert.equal(saved.linkCheck,'found');assert.equal(f.store.read().settings.channelTrials?.yeetmd?.trial,false);
    const journal=plaintext(f.store,`publication:${taskId}`);assert.match(journal,/private-opaque-delete-token/);assert.equal(JSON.stringify(saved).includes('private-opaque-delete-token'),false);
    assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[`publication:${taskId}`]:journal}}));
  }finally{controller.stop();f.cleanup()}
});

test('b9a3 a trial page absent through reconciliation appears at 24 hours and promotes without failure',async t=>{
  const f=fixture('yeetmd'),requests:Array<{method:string;url:string}>=[],normal=yeetTransport(requests);
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('yeetmd')],batch5Dependencies:{fetch:async(url,init)=>{
    if(init.method==='GET'&&url==='https://yeet.md/s/example123'&&Date.now()<Date.parse(at)+24*3600000){requests.push({method:'GET',url});return new Response('not replicated yet',{status:404,headers:{'content-type':'text/html'}})}
    return normal(url,init);
  }}});controller.runtime.aiReady=true;
  try{
    await controller.tick();assert.equal(f.store.read().tasks[0].linkCheck,'absent');
    await controller.tick();
    for(const hour of [1,2,3]){t.mock.timers.setTime(Date.parse(at)+hour*3600000);await controller.tick()}
    assert.equal(f.store.read().tasks[0].reconcileAttempts,3);assert.equal(f.store.read().tasks[0].firstLiveAt,undefined);
    for(const hour of [6,24]){t.mock.timers.setTime(Date.parse(at)+hour*3600000);await controller.tick()}
    const state=f.store.read(),saved=state.tasks.find(value=>value.id===taskId)!;
    assert.equal(saved.status,'live');assert.equal(saved.linkCheck,'found');assert.ok(saved.firstLiveAt);
    assert.equal(state.settings.channelTrials?.yeetmd.trial,false);assert.equal(state.settings.channelTrials?.yeetmd.failures,0);
    assert.notEqual(state.settings.channelOverrides.yeetmd,false);assert.equal(count(requests,'POST'),1);
  }finally{controller.stop();f.cleanup()}
});

for(const recovered of [false,true])test(`initial public absence waits for a later read without resubmitting (recovered=${recovered})`,async(t)=>{
  const f=fixture('yeetmd'),requests:Array<{method:string;url:string}>=[];
  const normal=yeetTransport(requests);let missing=true;
  const controller=new Controller(f.store,vault(f.store),'fixture',{
    channelCatalog:[channel('yeetmd')],batch5Dependencies:{fetch:async(url,init)=>{
      if(missing&&init.method==='GET'&&url==='https://yeet.md/s/example123'){
        requests.push({method:'GET',url});
        return new Response('not replicated yet',{status:404,headers:{'content-type':'text/html'}});
      }
      return normal(url,init);
    }},
  });
  controller.runtime.aiReady=true;
  try{
    await controller.tick();
    assert.equal(f.store.read().tasks[0].linkCheck,'absent');
    assert.equal(f.store.read().settings.channelTrials?.yeetmd.failures,0);
    assert.equal(f.store.read().settings.channelTrials?.yeetmd.activeTaskId,taskId);
    await controller.verify(taskId);
    assert.equal(f.store.read().settings.channelTrials?.yeetmd.failures,0,'same-tick reads do not count twice');
    (t as TestContext).mock.timers.setTime(Date.parse(at)+3600001);
    missing=!recovered;
    await controller.verify(taskId);
    const trial=f.store.read().settings.channelTrials?.yeetmd;
    assert.equal(trial?.failures,recovered?0:1);
    assert.equal(trial?.activeTaskId,undefined);
    assert.equal(trial?.trial,!recovered);
    await controller.verify(taskId);
    assert.equal(f.store.read().settings.channelTrials?.yeetmd.failures,recovered?0:1);
    assert.equal(count(requests,'POST'),1);
  }finally{controller.stop();f.cleanup();}
});

test('yeetmd unknown POST stays single-shot after SQLite restart',async()=>{
  const f=fixture('yeetmd'),first:Array<{method:string;url:string}>=[];let reopened:Store|undefined;
  try{const original=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('yeetmd')],batch5Dependencies:{fetch:yeetTransport(first,true)}});original.runtime.aiReady=true;await original.tick();assert.equal(count(first,'POST'),1);assert.equal(f.store.read().tasks[0].batch5?.stage,'submitting');f.store.close();
    reopened=new Store(f.path);const second:Array<{method:string;url:string}>=[],controller=new Controller(reopened,vault(reopened),'fixture',{channelCatalog:[channel('yeetmd')],batch5Dependencies:{fetch:yeetTransport(second,true)}});controller.runtime.aiReady=true;await controller.tick();assert.equal(count(second,'POST'),0);assert.equal(reopened.read().tasks[0].batch5?.stage,'submitting');
  }finally{try{reopened?.close()}catch{}rmSync(f.directory,{recursive:true,force:true})}
});

test('rant Controller registers once, publishes once, promotes trial, and survives encrypted SQLite reopening',async()=>{
  const f=fixture('rant'),requests:Array<{method:string;url:string}>=[];let reopened:Store|undefined;
  try{const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:rantTransport(requests)}});controller.runtime.aiReady=true;
    for(let turn=0;turn<4&&f.store.read().tasks[0].status!=='live';turn++)await controller.tick();
    const saved=f.store.read().tasks[0];assert.equal(count(requests,'POST'),2,JSON.stringify({saved,requests,error:controller.runtime.error,events:f.store.read().events}));assert.equal(saved.status,'live');assert.equal(saved.batch5?.stage,'published');assert.equal(f.store.read().settings.channelTrials?.rant?.trial,false);
    const identity=plaintext(f.store,`batch5:identity:rant:${siteId}`),publication=plaintext(f.store,`publication:${taskId}`),savedAccount=f.store.read().accounts[0],accountId=savedAccount?.id;assert.ok(accountId);assert.equal(savedAccount?.source,'generated',JSON.stringify(savedAccount));
    const secret=plaintext(f.store,`account:${accountId}`);assert.match(identity,/opaque-token-for-rant/);assert.match(secret,/opaque-token-for-rant/);assert.equal(JSON.stringify(saved).includes('opaque-token-for-rant'),false);
    assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[`batch5:identity:rant:${siteId}`]:identity,[`publication:${taskId}`]:publication,[`account:${accountId}`]:secret}}));
    f.store.close();reopened=new Store(f.path);const second:Array<{method:string;url:string}>=[],resumed=new Controller(reopened,vault(reopened),'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:rantTransport(second)}});resumed.runtime.aiReady=true;await resumed.tick();
    assert.equal(count(second,'POST'),0);assert.equal(reopened.read().tasks[0].status,'live');
  }finally{try{reopened?.close()}catch{}rmSync(f.directory,{recursive:true,force:true})}
});

test('SlopIt journal rejects a second site using the same unknown-provider email atomically',async()=>{
  const f=fixture('rant'),otherSiteId='33333333-3333-4333-8333-333333333333',otherTaskId='44444444-4444-4444-8444-444444444444';
  try{
    f.store.update(state=>{
      state.tasks[0].channelId='slopit';state.tasks[0].sourceDomain='slopit.io';
      state.sites.push({...site(),id:otherSiteId,domain:'other.example.com',url:'https://other.example.com/'});
      state.tasks.push({...task('rant'),id:otherTaskId,siteId:otherSiteId,channelId:'slopit',sourceDomain:'slopit.io'});
    });
    const first=createBatch5AccountPersistence(f.store,vault(f.store),taskId,()=>{}),second=createBatch5AccountPersistence(f.store,vault(f.store),otherTaskId,()=>{});
    const base={version:1 as const,channelId:'slopit',requestHash:'a'.repeat(64),createdAt:at};
    await first.saveAccountIntent({...base,siteId,operationId:'b5_account_first',username:'site-first',email:'owner@example.com'});
    const before=f.store.read();
    await assert.rejects(second.saveAccountIntent({...base,siteId:otherSiteId,operationId:'b5_account_second',username:'site-second',email:'owner@example.com'}),/归属其他网站/);
    assert.deepEqual(f.store.read(),before);assert.equal(f.store.getCipher(`batch5:identity:slopit:${otherSiteId}`),undefined);
    await second.saveAccountIntent({...base,siteId:otherSiteId,operationId:'b5_account_second',username:'site-second',email:'owner+site-2@example.com'});
    assert.equal(f.store.read().accounts.length,2);assert.equal(f.store.read().accountBindings.length,2);
  }finally{f.cleanup()}
});


for(const change of ['pause','skip','draft'] as const)test(`late first verification cannot accept a batch5 task after ${change}`,async()=>{
  const f=fixture('yeetmd'),requests:Array<{method:string;url:string}>=[],base=yeetTransport(requests);
  const initial=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('yeetmd')],batch5Dependencies:{fetch:async(url,init)=>{
    const response=await base(url,init);return url.includes('/s/')?new Response((await response.text()).replace('<head>','<head><meta name="robots" content="noindex">'),{status:200,headers:{'content-type':'text/html'}}):response;
  }}});initial.runtime.aiReady=true;
  let controller:Controller|undefined;
  try{
    await initial.tick();assert.equal(f.store.read().tasks[0].batch5?.stage,'api_receipt');assert.equal(f.store.read().tasks[0].firstLiveAt,undefined);
    let release!:()=>void,started!:()=>void;const released=new Promise<void>(resolve=>{release=resolve}),began=new Promise<void>(resolve=>{started=resolve});
    controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('yeetmd')],batch5Dependencies:{fetch:async(url,init)=>{if(url.includes('/s/')){started();await released;}return base(url,init);}}});
    const pending=controller.verify(taskId);await began;
    f.store.update(state=>{if(change==='pause')state.sites[0].status='paused';else if(change==='skip')state.tasks[0].status='skipped';else state.tasks[0].draft={...article,body:article.body+' Changed locally.'};});
    release();await pending;
    const saved=f.store.read().tasks[0];assert.equal(saved.firstLiveAt,undefined);assert.notEqual(saved.status,'live');assert.equal(saved.batch5?.stage,'api_receipt');
    assert.equal(f.store.read().settings.channelTrials?.yeetmd?.trial,true);assert.equal(count(requests,'POST'),1);
  }finally{controller?.stop();initial.stop();f.cleanup();}
});

for(const response of ['unknown',401,403,409,429] as const)test(`registration ${response} is classified before the trial lease is reconciled`,async()=>{
  const f=fixture('rant');let posts=0;
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:async(_url,init)=>{
    assert.equal(init.method,'POST');posts++;
    if(response==='unknown')throw Error('synthetic timeout');
    return new Response(JSON.stringify({error:'synthetic refusal'}),{status:response,headers:{'content-type':'application/json'}});
  }}});controller.runtime.aiReady=true;
  try{
    await controller.tick();const saved=f.store.read().tasks[0],trial=f.store.read().settings.channelTrials?.rant;
    assert.equal(posts,1);assert.ok(trial);
    assert.equal(saved.reasonCode,response==='unknown'?'submission_unknown':response===429?undefined:response===409?'account_handoff':'platform_rejected');
    assert.equal(trial.failures,response===401||response===403?1:0);
    assert.equal(trial.activeTaskId,response==='unknown'?taskId:undefined);
    await controller.tick();assert.equal(posts,1,'a retained registration intent cannot authorize another POST');
  }finally{controller.stop();f.cleanup()}
});

test('queued account preparation uses a future backoff instead of every tick',async()=>{
  const f=fixture('rant');let calls=0;
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('rant')],prepareTask:async()=>{calls++;return {status:'queued',checkpoint:'batch5_account_pending',message:'synthetic registration quota'};}});controller.runtime.aiReady=true;
  try{
    await controller.tick();const saved=f.store.read().tasks[0];assert.equal(saved.status,'queued');assert.ok(Date.parse(saved.scheduledAt)>=Date.parse(at)+3600000);
    await controller.tick();assert.equal(calls,1);
  }finally{controller.stop();f.cleanup()}
});

for(const fault of ['encryption','budget-race'] as const)test(`real registration preparation defers ${fault} before any POST`,async()=>{
  const f=fixture('rant'),secure=vault(f.store),encrypt=secure.encryptSecrets.bind(secure);let posts=0,encryptions=0;
  secure.encryptSecrets=values=>{
    encryptions++;
    if(fault==='encryption')throw Error('synthetic locked journal');
    const encrypted=encrypt(values);
    if(encryptions===1)f.store.update(state=>{
      for(const id of ['66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777']){
        state.accounts.push({id,channelId:'rant',username:`example-${id.slice(0,8)}`,email:'',status:'unknown',hasPassword:false,source:'generated',credentialKind:'password',registrationAttempts:1,createdAt:at});
      }
    });
    return encrypted;
  };
  const controller=new Controller(f.store,secure,'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:async()=>{posts++;throw Error('must not send')}}});controller.runtime.aiReady=true;
  try{
    await controller.tick();const saved=f.store.read().tasks[0];
    assert.equal(encryptions,1);assert.equal(posts,0);assert.equal(saved.status,'queued');
    assert.equal(saved.batch5Registration,undefined);assert.equal(saved.submittedAt,undefined);
    assert.equal(f.store.getCipher(`batch5:identity:rant:${siteId}`),undefined);
    assert.ok(Date.parse(saved.scheduledAt)>=Date.parse(at)+3600000);
    assert.equal(f.store.read().settings.channelTrials?.rant.failures,0);
    await controller.tick();assert.equal(encryptions,1);assert.equal(posts,0);
  }finally{controller.stop();f.cleanup();}
});

for(const action of ['retry','delete','repair-unsent-journal'] as const)test(`proven unsent registration releases capacity and supports ${action} through Controller`,async(t)=>{
  const f=fixture('rant'),requests:Array<{method:string;url:string}>=[],secure=vault(f.store),encrypt=secure.encryptSecrets.bind(secure);
  let suspended=false,failedMark=false;
  if(action==='repair-unsent-journal')secure.encryptSecrets=values=>{
    if(!failedMark&&Object.values(values).some(value=>{try{return JSON.parse(value).registration?.stage==='not_sent'}catch{return false}})){
      failedMark=true;throw Error('synthetic journal write interruption');
    }
    return encrypt(values);
  };
  f.store.onChange=()=>{
    if(suspended||f.store.read().tasks[0]?.batch5Registration?.stage!=='reserved')return;
    suspended=true;f.store.update(state=>{state.settings.autoRun=false});
  };
  const normal=rantTransport(requests);
  const controller=new Controller(f.store,secure,'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:(url,init)=>{
    if(init.method==='POST')assert.equal(f.store.read().settings.channelTrials?.rant.activeTaskId,taskId,'retry remains inside the trial lease');
    return normal(url,init);
  }}});controller.runtime.aiReady=true;
  try{
    await controller.tick();const saved=f.store.read().tasks[0],original=saved.batch5Registration!;
    assert.equal(count(requests,'POST'),0);assert.equal(saved.submittedAt,undefined);
    assert.equal(original.stage,action==='repair-unsent-journal'?'reserved':'not_sent');
    assert.equal(f.store.read().settings.channelTrials?.rant.failures,0);
    assert.equal(f.store.read().settings.channelTrials?.rant.activeTaskId,undefined);
    if(action==='delete'){
      controller.deleteSite(siteId);assert.equal(f.store.read().sites.length,0);
      assert.equal(f.store.getCipher(`batch5:identity:rant:${siteId}`),undefined);
      assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{}}));return;
    }
    f.store.onChange=undefined;f.store.update(state=>{state.settings.autoRun=true});
    for(let hour=1;hour<=4&&f.store.read().tasks[0].status!=='live';hour++){
      t.mock.timers.setTime(Date.parse(at)+hour*3600000);await controller.tick();
    }
    const current=f.store.read().tasks[0];
    assert.equal(current.status,'live',JSON.stringify({current,error:controller.runtime.error}));
    assert.notEqual(current.batch5Registration?.operationId,original.operationId);
    assert.equal(requests.filter(request=>request.method==='POST'&&request.url.includes('/signup')).length,1);
    assert.equal(count(requests,'POST'),2,'one registration and one article, with no duplicate of either');
    assert.equal(f.store.read().settings.channelTrials?.rant.failures,0);
    assert.equal(f.store.read().settings.channelTrials?.rant.trial,false,'accepted retry promotes the trial');
    if(action==='repair-unsent-journal')assert.equal(failedMark,true);
  }finally{controller.stop();f.cleanup();}
});

test('registration 429 waits 24 hours per retry and stops after three rejected sends of the same intent',async(t)=>{
  const f=fixture('rant');let posts=0;const operationIds:string[]=[];
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:async()=>{
    posts++;const registration=f.store.read().tasks[0].batch5Registration!;assert.equal(registration.stage,'sending');assert.equal(f.store.read().settings.channelTrials?.rant.activeTaskId,taskId);operationIds.push(registration.operationId);
    return new Response('{}',{status:429,headers:{'content-type':'application/json'}});
  }}});controller.runtime.aiReady=true;
  try{
    for(let attempt=0;attempt<3;attempt++){
      t.mock.timers.setTime(Date.parse(at)+attempt*86400000);await controller.tick();assert.equal(posts,attempt+1);
      assert.equal(f.store.read().settings.channelTrials?.rant.failures,0);
      assert.equal(f.store.read().settings.channelTrials?.rant.activeTaskId,undefined);
      t.mock.timers.setTime(Date.parse(at)+(attempt+1)*86400000-1);await controller.tick();assert.equal(posts,attempt+1);
    }
    assert.equal(new Set(operationIds).size,1);
    assert.equal(f.store.read().tasks[0].batch5Registration?.stage,'rejected');
    t.mock.timers.setTime(Date.parse(at)+7*86400000);await controller.tick();assert.equal(posts,3);
    controller.deleteSite(siteId);assert.equal(f.store.read().accounts.length,0);
  }finally{controller.stop();f.cleanup();}
});

test('a due 429 signup retry that receives 403 counts one platform failure inside its lease',async t=>{
  const f=fixture('rant');let posts=0;
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:async()=>{
    posts++;assert.equal(f.store.read().settings.channelTrials?.rant.activeTaskId,taskId);
    return new Response('{}',{status:posts===1?429:403,headers:{'content-type':'application/json'}});
  }}});controller.runtime.aiReady=true;
  try{
    await controller.tick();assert.equal(posts,1);assert.equal(f.store.read().settings.channelTrials?.rant.failures,0);
    t.mock.timers.setTime(Date.parse(at)+86400000);await controller.tick();
    assert.equal(posts,2);assert.equal(f.store.read().settings.channelTrials?.rant.failures,1);
    assert.equal(f.store.read().settings.channelTrials?.rant.activeTaskId,undefined);
    assert.equal(f.store.read().tasks[0].batch5Registration?.stage,'rejected');
  }finally{controller.stop();f.cleanup()}
});

test('registered Rant review outages retain the signup journal and retry the same platform',async t=>{
  const f=fixture('rant'),requests:Array<{method:string;url:string}>=[],transport=rantTransport(requests);let reviews=0;
  f.store.update(state=>{state.settings.articleReviewMode='ai';state.sites[0].articleReviewMode='ai';state.tasks[0].articleApprovedAt=undefined;state.tasks[0].cost={aiCalls:2}});
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:transport},reviewArticle:async(current,currentSite,currentChannel,settings)=>{
    reviews++;
    return {status:'failed' as const,reasonCode:'ai_unavailable' as const,reason:'synthetic reviewer outage',reviewedAt:new Date().toISOString(),evidenceUrls:[],draftRevision:current.draftRevision??0,contentHash:articleContentHash(current),contextHash:articleContextHash(currentSite,currentChannel,settings)};
  }});controller.runtime.aiReady=true;
  try{
    for(let index=0;index<3;index++){
      if(index>0){const pending=f.store.read().tasks.find(item=>item.id===taskId)!;t.mock.timers.setTime(Date.parse(pending.scheduledAt)+1000)}
      await controller.tick();
      assert.equal(reviews,index+1);
      assert.equal(requests.filter(item=>item.method==='POST'&&item.url.endsWith('/api/auth/signup')).length,1);
      assert.equal(requests.filter(item=>item.method==='POST'&&!item.url.endsWith('/api/auth/signup')).length,0);
      if(index<2){const pending=f.store.read().tasks.find(item=>item.id===taskId)!;assert.equal(pending.status,'queued');assert.equal(pending.batch5Registration?.stage,'registered');assert.equal(pending.temporaryBackoffCount,index+1);assert.equal(pending.temporaryRetryCount,undefined)}
    }
    const state=f.store.read(),original=state.tasks.find(item=>item.id===taskId)!,replacement=state.tasks.find(item=>item.replacesTaskId===taskId);
    assert.equal(original.status,'queued');assert.equal(original.checkpoint,'article_review');
    assert.equal(original.batch5Registration?.stage,'registered');assert.ok(f.store.getCipher(`account:${original.accountId}`));
    assert.equal(replacement,undefined);assert.equal(original.channelId,'rant');assert.equal(original.temporaryBackoffCount,3);
    assert.equal(original.failedPlatformIds,undefined);assert.equal(original.cost?.aiCalls,2);
    assert.equal(original.replacementTaskId,undefined);
  }finally{controller.stop();f.cleanup()}
});

test('abort during signup POST preserves unknown registration for read-only recovery and seven-day release',async t=>{
  const f=fixture('rant');let posts=0,started!:()=>void;
  const began=new Promise<void>(resolve=>{started=resolve});
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:async(_url,init)=>{
    posts++;started();return new Promise<Response>((_resolve,reject)=>init.signal?.addEventListener('abort',()=>reject(Error('synthetic abort')),{once:true}));
  }}});controller.runtime.aiReady=true;
  let resumed:Controller|undefined;
  try{
    const running=controller.tick();await began;controller.stop();await running;
    const saved=f.store.read().tasks[0];
    assert.equal(posts,1);assert.equal(saved.status,'needs_input');assert.equal(saved.reasonCode,'submission_unknown');assert.equal(saved.checkpoint,'batch5_account_pending');
    assert.ok(['sending','request_unknown'].includes(saved.batch5Registration?.stage??''));
    resumed=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:async()=>{posts++;throw Error('must not repeat signup')}}});resumed.runtime.aiReady=true;
    await resumed.tick();assert.equal(posts,1);
    t.mock.timers.setTime(Date.parse(at)+7*86400000);f.store.update(()=>{});
    assert.equal(f.store.read().settings.channelTrials?.rant.activeTaskId,undefined);
    assert.equal(f.store.read().settings.channelTrials?.rant.failures,0);
  }finally{resumed?.stop();controller.stop();f.cleanup()}
});

test('restart with signup left at sending keeps the original unknown intent read only',async t=>{
  const f=fixture('rant'),secure=vault(f.store);let reopened:Store|undefined,resumed:Controller|undefined,posts=0;
  try{
    const persistence=createBatch5AccountPersistence(f.store,secure,taskId,()=>{});
    const accountIntent={version:1 as const,channelId:'rant' as const,siteId,operationId:'crash-fixture',requestHash:'a'.repeat(64),createdAt:at,username:'example-site',password:'synthetic-password'};
    await persistence.saveAccountIntent(accountIntent);
    f.store.update(state=>{state.tasks[0].status='running';claimChannelTrial(state,channel('rant'),state.tasks[0]);});
    await persistence.markAccountRegistration(accountIntent,'sending',at);
    f.store.close();reopened=new Store(f.path);
    resumed=new Controller(reopened,vault(reopened),'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:async()=>{posts++;throw Error('must not repeat signup')}}});resumed.runtime.aiReady=true;
    const interrupted=reopened.read().tasks[0];
    assert.equal(interrupted.status,'needs_input');assert.equal(interrupted.reasonCode,'submission_unknown');assert.equal(interrupted.checkpoint,'batch5_account_pending');
    await resumed.tick();assert.equal(posts,0);
    t.mock.timers.setTime(Date.parse(at)+7*86400000);reopened.update(()=>{});
    assert.equal(reopened.read().settings.channelTrials?.rant.activeTaskId,undefined);
    assert.equal(reopened.read().settings.channelTrials?.rant.failures,0);
  }finally{resumed?.stop();reopened?.close();f.cleanup()}
});

test('Controller recovers a legacy terminal 429 without replaying before its new cooldown',async(t)=>{
  const f=fixture('rant'),key=`batch5:identity:rant:${siteId}`;let posts=0,restored:Store|undefined,resumed:Controller|undefined;
  const transport=async()=>{posts++;return new Response('{}',{status:429,headers:{'content-type':'application/json'}})};
  const original=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:transport}});original.runtime.aiReady=true;
  try{
    await original.tick();original.stop();assert.equal(posts,1);
    const old=f.store.read(),registration=old.tasks[0].batch5Registration!,operationId=registration.operationId;
    const legacy={version:1 as const,channelId:'rant' as const,operationId,createdAt:registration.createdAt,stage:'rejected' as const};
    Object.assign(old.tasks[0],{status:'failed',checkpoint:'batch5_account_rejected',reasonCode:'channel_disabled',batch5Registration:legacy,trialFailure:'legacy 429',trialFailureOperationId:operationId,nextCheckAt:undefined});
    old.settings.channelOverrides.rant=false;
    old.settings.channelTrials!.rant={trial:true,failures:2,evaluatedTaskIds:[taskId],evaluatedFailureOperationIds:['another-refusal',operationId],disabledAt:at,autoDisabledOverride:true};
    const journal=JSON.parse(plaintext(f.store,key));journal.registration=legacy;delete journal.opaque.receivedAt;
    const raw=JSON.stringify(journal);assert.doesNotThrow(()=>validateBackup({state:old,secrets:{[key]:raw}}));
    restored=new Store(join(f.directory,'legacy.sqlite'));
    restored.updateWithCiphers(state=>Object.assign(state,old),{[key]:`enc:${Buffer.from(raw).toString('base64url')}`});
    resumed=new Controller(restored,vault(restored),'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:transport}});resumed.runtime.aiReady=true;
    const now=Date.parse(at)+10*86400000;t.mock.timers.setTime(now);await resumed.tick();
    let current=restored.read().tasks[0];assert.equal(current.status,'queued');assert.equal(current.batch5Registration?.stage,'rate_limited');
    assert.equal(current.batch5Registration?.operationId,operationId);assert.equal(Date.parse(current.scheduledAt),now+86400000);
    assert.equal(posts,1);assert.equal(restored.read().settings.channelTrials?.rant.failures,1);
    assert.equal(restored.read().settings.channelTrials?.rant.disabledAt,undefined);
    t.mock.timers.setTime(now+86400000-1);await resumed.tick();assert.equal(posts,1);
    for(let day=1;day<=2;day++){t.mock.timers.setTime(now+day*86400000);await resumed.tick();assert.equal(posts,day+1)}
    current=restored.read().tasks[0];assert.equal(current.batch5Registration?.stage,'rejected');assert.equal(current.batch5Registration?.operationId,operationId);
    assert.equal(restored.read().settings.channelTrials?.rant.failures,1);
    assert.doesNotThrow(()=>validateBackup({state:restored!.read(),secrets:{[key]:plaintext(restored!,key)}}));
  }finally{resumed?.stop();restored?.close();original.stop();f.cleanup();}
});

test('publication authorization loss releases its lease and resumes the same intent with one article POST',async(t)=>{
  const f=fixture('rant'),requests:Array<{method:string;url:string}>=[];let paused=false;
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:rantTransport(requests)}});controller.runtime.aiReady=true;
  f.store.onChange=()=>{
    if(paused||f.store.read().tasks[0]?.batch5?.stage!=='reserved')return;
    paused=true;f.store.update(state=>{state.settings.autoRun=false});
  };
  try{
    await controller.tick();const saved=f.store.read().tasks[0],operationId=saved.batch5?.operationId;
    assert.equal(saved.batch5?.stage,'reserved');assert.equal(saved.status,'queued');assert.equal(saved.submittedAt,undefined);
    assert.equal(count(requests,'POST'),1,'only the preceding signup was sent');
    assert.equal(f.store.read().settings.channelTrials?.rant.activeTaskId,undefined);
    assert.equal(f.store.read().settings.channelTrials?.rant.failures,0);
    f.store.onChange=undefined;f.store.update(state=>{state.settings.autoRun=true});
    t.mock.timers.setTime(Date.parse(at)+3600000);await controller.tick();
    const current=f.store.read().tasks[0];assert.equal(current.status,'live',JSON.stringify(current));
    assert.equal(current.batch5?.operationId,operationId);assert.equal(count(requests,'POST'),2);
    await controller.tick();assert.equal(count(requests,'POST'),2);
  }finally{controller.stop();f.cleanup();}
});

for(const limit of [1,3])test(`queued account preparation stops at the configured bounded attempt limit ${limit} and releases its trial lease`,async(t)=>{
  const f=fixture('rant');let calls=0;
  f.store.update(state=>{state.settings.maxAttempts=limit;});
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('rant')],prepareTask:async()=>{calls++;return {status:'queued',checkpoint:'batch5_account_pending',message:'synthetic persistent storage failure'};}});controller.runtime.aiReady=true;
  try{
    for(let hour=0;hour<limit;hour++){
      (t as TestContext).mock.timers.setTime(Date.parse(at)+hour*3600000);
      await controller.tick();
    }
    const saved=f.store.read().tasks[0];
    assert.equal(calls,limit);assert.equal(saved.attempts,0);assert.equal(saved.prepareAttempts,limit);assert.equal(saved.status,'needs_input');
    assert.equal(saved.reasonCode,'account_handoff');assert.equal(f.store.read().settings.channelTrials?.rant.activeTaskId,undefined);
    assert.equal(f.store.read().settings.channelTrials?.rant.failures,0);
    (t as TestContext).mock.timers.setTime(Date.parse(at)+4*3600000);await controller.tick();assert.equal(calls,limit);
  }finally{controller.stop();f.cleanup()}
});

test('unsent article preflight failures release the lease and use preparation count without consuming execution attempts',async t=>{
  const f=fixture('rant'),requests:Array<{method:string;url:string}>=[],normal=rantTransport(requests);
  let preflights=0;
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:async(url,init)=>{
    if(init.method==='GET'&&url.includes('/api/collections/')&&url.includes('/posts/')){preflights++;throw Error('synthetic preflight outage')}
    return normal(url,init);
  }}});controller.runtime.aiReady=true;
  try{
    for(let hour=0;hour<3;hour++){
      t.mock.timers.setTime(Date.parse(at)+hour*3600000);
      await controller.tick();const saved=f.store.read().tasks[0];
      assert.equal(saved.attempts,0);assert.equal(saved.prepareAttempts,hour+1);
      assert.equal(saved.submittedAt,undefined);assert.equal(saved.batch5,undefined);
      assert.equal(f.store.read().settings.channelTrials?.rant.activeTaskId,undefined);
      assert.equal(trialTaskAvailable(f.store.read(),channel('rant'),'33333333-3333-4333-8333-333333333333'),true);
      assert.equal(f.store.read().settings.channelTrials?.rant.failures,0);
    }
    assert.equal(preflights,3);assert.equal(count(requests,'POST'),1,'only signup was sent');
    assert.equal(f.store.read().tasks[0].status,'needs_input');
    assert.equal(f.store.read().tasks[0].checkpoint,'batch5_prepare_exhausted');
  }finally{controller.stop();f.cleanup()}
});

for(const failure of ['keychain','journal','controller-throw'] as const)test(`batch5 first acceptance defers ${failure} failures while the tick continues other checks and work`,async(t)=>{
  const f=fixture('yeetmd'),requests:Array<{method:string;url:string}>=[],base=yeetTransport(requests);
  const initial=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('yeetmd')],batch5Dependencies:{fetch:async(url,init)=>url.includes('/s/')?new Response('unavailable',{status:503}):base(url,init)}});initial.runtime.aiReady=true;
  let controller:Controller|undefined,rechecks=0,prepared=0;
  const publisher=batch5Publisher('yeetmd')!,originalVerify=publisher.verify;
  try{
    await initial.tick();initial.stop();
    const secure=vault(f.store),get=secure.get.bind(secure);
    secure.get=async(key:string)=>{if(key===`publication:${taskId}`){if(failure==='keychain')throw Error('synthetic locked vault');if(failure==='journal')return 'synthetic invalid journal';}return get(key)};
    if(failure==='controller-throw')publisher.verify=async()=>{throw Error('synthetic verifier exception outside its adapter catch')};
    f.store.update(state=>{
      state.settings.channelOverrides.telegraph=true;state.settings.channelOverrides.rant=true;state.tasks[0].nextCheckAt=at;
      (state.settings.channelTrials??={}).rant={trial:false,failures:0,evaluatedTaskIds:[]};
      state.tasks.push({...task('yeetmd'),id:'33333333-3333-4333-8333-333333333333',channelId:'telegraph',sourceDomain:'telegra.ph',status:'live',submittedAt:at,firstLiveAt:at,publicUrl:'https://telegra.ph/example-page',linkCheck:'found',linkIndexable:true,nextCheckAt:at});
      const secondSiteId='55555555-5555-4555-8555-555555555555';
      state.sites.push({...site(),id:secondSiteId,domain:'other.example.com',url:'https://other.example.com/',topics:[{url:'https://other.example.com/guide',discoveredAt:at}]});
      state.tasks.push({...task('rant'),id:'44444444-4444-4444-8444-444444444444',siteId:secondSiteId,topicUrl:'https://other.example.com/guide',scheduledAt:new Date(Date.parse(at)+3*3600000).toISOString()});
    });
    controller=new Controller(f.store,secure,'fixture',{channelCatalog:[channel('yeetmd'),channel('rant'),CHANNELS.find(value=>value.id==='telegraph')!],
      recheckLink:async(url)=>{rechecks++;return {url,found:true,indexable:true,rel:'follow',outcome:'found',reasonCode:'link_found',reason:'synthetic healthy page'};},
      prepareTask:async()=>{prepared++;return {status:'needs_input',checkpoint:'account_handoff',message:'synthetic setup'};}});controller.runtime.aiReady=true;
    (t as TestContext).mock.timers.setTime(Date.parse(at)+3*3600000);
    await controller.tick();
    assert.ok(Date.parse(f.store.read().tasks[0].linkRecheckAt??f.store.read().tasks[0].nextCheckAt!)>Date.now());
    assert.equal(f.store.read().settings.channelTrials?.yeetmd.failures,0);assert.equal(rechecks,1);assert.equal(prepared,1);
    assert.equal(controller.runtime.error,undefined);assert.equal(count(requests,'POST'),1);
  }finally{publisher.verify=originalVerify;controller?.stop();initial.stop();f.cleanup()}
});

test('unconfirmed Leaflet receipt and disabled Telegraph first acceptance defer without starving the next link',async()=>{
  const f=fixture('yeetmd');let checks=0;
  const leaflet=CHANNELS.find(value=>value.id==='leaflet')!,telegraph=CHANNELS.find(value=>value.id==='telegraph')!;
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[leaflet,telegraph,channel('rant')],recheckLink:async(url)=>{checks++;return {url,found:true,indexable:true,rel:'follow',outcome:'found',reasonCode:'link_found',reason:'synthetic healthy page'};}});
  try{
    f.store.update(state=>{
      state.settings.channelOverrides.leaflet=true;state.settings.channelOverrides.telegraph=false;state.settings.channelOverrides.rant=true;
      state.tasks=[{...task('yeetmd'),channelId:'leaflet',sourceDomain:'leaflet.pub',status:'needs_input',submittedAt:at,publicUrl:'https://leaflet.pub/example',leaflet:{did:'did:plc:examplefixtureidentity01',rkey:'3lzzzzzzzzzzz',recordHash:'a'.repeat(64),recordCreatedAt:at,stage:'creating',url:'https://leaflet.pub/example'},reconcileAttempts:3,nextCheckAt:at},
        {...task('yeetmd'),id:'33333333-3333-4333-8333-333333333333',channelId:'telegraph',sourceDomain:'telegra.ph',status:'review',submittedAt:at,publicUrl:'https://telegra.ph/example-first',nextCheckAt:at},
        {...task('rant'),id:'44444444-4444-4444-8444-444444444444',status:'live',submittedAt:at,firstLiveAt:at,publicUrl:'https://rant.li/example/example-page',linkCheck:'found',linkIndexable:true,nextCheckAt:at}];
    });
    await controller.tick();assert.equal(controller.runtime.error,undefined);
    assert.equal(f.store.read().tasks[0].nextCheckAt,at,'an exhausted receipt remains stopped instead of being polled');assert.ok(f.store.read().tasks.slice(1).every(value=>Date.parse(value.linkRecheckAt??value.nextCheckAt!)>Date.parse(at)));assert.equal(checks,2,'the two other platforms receive read-only checks');
    assert.equal(f.store.read().tasks[0].status,'needs_input');assert.equal(f.store.read().tasks[1].status,'live','a disabled platform still permits read-only confirmation');
  }finally{controller.stop();f.cleanup()}
});

for(const status of [400,401,403,413,415,422,429])test(`explicit publication HTTP ${status} never becomes an unknown-result reconciliation`,async(t)=>{
  const f=fixture('yeetmd');let reads=0,posts=0;
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('yeetmd')],batch5Dependencies:{fetch:async(_url,init)=>{
    if(init.method==='POST'){posts++;return new Response('{}',{status,headers:{'content-type':'application/json'}})}
    reads++;throw Error('a rejected publication must not be read back');
  }}});controller.runtime.aiReady=true;
  try{
    await controller.tick();const initial=f.store.read().tasks[0];assert.equal(initial.status,'failed');assert.notEqual(initial.reasonCode,'submission_unknown');
    for(let hour=1;hour<=4;hour++){(t as TestContext).mock.timers.setTime(Date.parse(at)+hour*3600000);await controller.tick();}
    const saved=f.store.read().tasks[0];assert.equal(posts,1);assert.equal(reads,0);assert.equal(saved.reasonCode,initial.reasonCode);assert.equal(saved.reconcileAttempts,undefined);
    const expectedFailures=[403,429].includes(status)?1:0;
    assert.equal(f.store.read().settings.channelTrials?.yeetmd.failures,expectedFailures);
    assert.equal(f.store.read().settings.channelTrials?.yeetmd.activeTaskId,undefined);
    (t as TestContext).mock.timers.setTime(Date.parse(at)+8*86400000);f.store.update(()=>{});
    assert.equal(f.store.read().settings.channelTrials?.yeetmd.failures,expectedFailures,'a definite non-platform refusal never becomes an acceptance timeout');
    const reopened=new Store(f.path),resumed=new Controller(reopened,vault(reopened),'fixture',{channelCatalog:[channel('yeetmd')]});
    try{assert.equal(reopened.read().tasks[0].reasonCode,initial.reasonCode);assert.equal(reopened.read().tasks[0].status,'failed');assert.equal(reopened.read().tasks[0].checkpoint,'batch5_rejected');}
    finally{resumed.stop();reopened.close();}
  }finally{controller.stop();f.cleanup()}
});

test('a site with only an account intent cannot be deleted and recreated',async()=>{
  const f=fixture('rant'),v=vault(f.store),controller=new Controller(f.store,v,'fixture',{channelCatalog:[channel('rant')]});
  try{
    const persistence=createBatch5AccountPersistence(f.store,v,taskId,()=>{});
    await persistence.saveAccountIntent({version:1,channelId:'rant',siteId,operationId:'account-only',requestHash:'a'.repeat(64),createdAt:at,username:'example-site',password:'synthetic-password'});
    const before=f.store.read();assert.equal(before.tasks[0].batch5,undefined);assert.throws(()=>controller.deleteSite(siteId));assert.deepEqual(f.store.read(),before);
  }finally{controller.stop();f.cleanup()}
});

for(const status of [403,409,429])test(`explicit signup HTTP ${status} permits atomic site deletion and leaves no orphaned identity`,async()=>{
  const f=fixture('rant');let posts=0;
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:async()=>{posts++;return new Response('{}',{status,headers:{'content-type':'application/json'}})}}});controller.runtime.aiReady=true;
  try{
    await controller.tick();assert.equal(posts,1);assert.equal(f.store.read().tasks[0].batch5Registration?.stage,status===429?'rate_limited':'rejected');
    controller.deleteSite(siteId);const state=f.store.read();
    assert.equal(state.sites.length,0);assert.equal(state.tasks.length,0);assert.equal(state.accounts.length,0);assert.equal(state.accountBindings.length,0);
    assert.equal(f.store.getCipher(`batch5:identity:rant:${siteId}`),undefined);
    assert.doesNotThrow(()=>validateBackup({state,secrets:{}}));
  }finally{controller.stop();f.cleanup()}
});

test('an ambiguous registration expires once at seven days without another signup or losing its identity lock',async(t)=>{
  const f=fixture('rant');let posts=0;
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:async()=>{posts++;throw Error('synthetic registration timeout')}}});controller.runtime.aiReady=true;
  try{
    await controller.tick();const initial=f.store.read().tasks[0];
    assert.equal(initial.submittedAt,undefined);assert.equal(initial.batch5Registration?.createdAt,at);
    (t as TestContext).mock.timers.setTime(Date.parse(at)+7*86400000);f.store.update(()=>{});
    assert.equal(f.store.read().settings.channelTrials?.rant.failures,0);assert.equal(f.store.read().settings.channelTrials?.rant.activeTaskId,undefined);
    await controller.tick();await controller.tick();assert.equal(posts,1);assert.equal(f.store.read().settings.channelTrials?.rant.failures,0);
    assert.equal(f.store.read().tasks[0].reasonCode,'submission_unknown');assert.throws(()=>controller.deleteSite(siteId));
    assert.ok(f.store.getCipher(`batch5:identity:rant:${siteId}`));
  }finally{controller.stop();f.cleanup()}
});

test('disabled batch5 first acceptance remains read-only and advances its next check',async()=>{
  const f=fixture('yeetmd'),requests:Array<{method:string;url:string}>=[],base=yeetTransport(requests);let unavailable=true;
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('yeetmd')],batch5Dependencies:{fetch:async(url,init)=>{
    if(unavailable&&url.includes('/s/')){requests.push({method:init.method??'GET',url});return new Response('temporarily unavailable',{status:503})}
    return base(url,init);
  }}});controller.runtime.aiReady=true;
  try{
    await controller.tick();assert.equal(f.store.read().tasks[0].firstLiveAt,undefined);assert.equal(f.store.read().settings.channelTrials?.yeetmd.failures,0);
    f.store.update(state=>{state.settings.channelOverrides.yeetmd=false;state.tasks[0].nextCheckAt=at});
    await controller.verify(taskId);assert.ok(Date.parse(f.store.read().tasks[0].nextCheckAt!)>Date.parse(at));
    unavailable=false;await controller.verify(taskId);assert.equal(f.store.read().tasks[0].status,'live');assert.equal(f.store.read().settings.channelTrials?.yeetmd.trial,false);assert.equal(count(requests,'POST'),1);
  }finally{controller.stop();f.cleanup()}
});

test('paused first acceptance defers its due date without occupying the recheck head forever',async()=>{
  const f=fixture('yeetmd'),requests:Array<{method:string;url:string}>=[],base=yeetTransport(requests);
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('yeetmd')],batch5Dependencies:{fetch:async(url,init)=>url.includes('/s/')?new Response('unavailable',{status:503}):base(url,init)}});controller.runtime.aiReady=true;
  try{
    await controller.tick();f.store.update(state=>{state.sites[0].status='paused';state.tasks[0].nextCheckAt=at});
    await controller.verify(taskId);assert.ok(Date.parse(f.store.read().tasks[0].nextCheckAt!)>Date.parse(at));assert.equal(count(requests,'POST'),1);
  }finally{controller.stop();f.cleanup()}
});

test('three disabled batch5 pages cannot starve a fourth link recheck',async(t)=>{
  const f=fixture('yeetmd'),requests:Array<{method:string;url:string}>=[],base=yeetTransport(requests);let rechecks=0;
  const telegraph=CHANNELS.find(value=>value.id==='telegraph')!;
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('yeetmd'),telegraph],batch5Dependencies:{fetch:async(url,init)=>url.includes('/s/')?new Response('unavailable',{status:503}):base(url,init)},recheckLink:async(url)=>{rechecks++;return {url,found:true,indexable:true,rel:'follow',outcome:'found',reasonCode:'link_found',reason:'synthetic healthy link'};}});controller.runtime.aiReady=true;
  try{
    await controller.tick();const original=f.store.read().tasks[0],cipher=f.store.getCipher(`publication:${taskId}`)!;
    const copiedIds=['33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
    f.store.updateWithCiphers(state=>{
      state.settings.channelOverrides.yeetmd=false;state.settings.channelOverrides.telegraph=true;
      state.tasks[0].nextCheckAt=at;
      for(const id of copiedIds)state.tasks.push({...original,id,nextCheckAt:at});
      state.tasks.push({...task('yeetmd'),id:'55555555-5555-4555-8555-555555555555',channelId:'telegraph',sourceDomain:'telegra.ph',status:'live',submittedAt:at,firstLiveAt:at,publicUrl:'https://telegra.ph/example-page',linkCheck:'found',linkIndexable:true,nextCheckAt:at});
    },Object.fromEntries(copiedIds.map(id=>[`publication:${id}`,cipher])));
    await controller.tick();assert.equal(rechecks,1,'a distinct platform is checked in the same bounded round');
    assert.equal(f.store.read().tasks.slice(0,3).filter(value=>value.lastCheckedAt!==original.lastCheckedAt).length,0,'the recently checked disabled platform waits for its 15-minute slot');
    (t as TestContext).mock.timers.setTime(Date.parse(at)+15*60000+1);
    await controller.tick();assert.equal(f.store.read().tasks.slice(0,3).filter(value=>value.lastCheckedAt!==original.lastCheckedAt).length,1,'only one page from a platform is read in a round');
    await controller.tick();assert.equal(f.store.read().tasks.slice(0,3).filter(value=>value.lastCheckedAt!==original.lastCheckedAt).length,1,'a second tick inside 15 minutes cannot burst the same platform');
    assert.equal(rechecks,1);assert.equal(count(requests,'POST'),1);
  }finally{controller.stop();f.cleanup()}
});

test('Controller restart recovers an encrypted signup response after receipt storage failure without another signup',async()=>{
  const f=fixture('rant'),requests:Array<{method:string;url:string}>=[],transport=rantTransport(requests),secure=vault(f.store),encrypt=secure.encryptSecrets.bind(secure);let failed=false,reopened:Store|undefined;
  secure.encryptSecrets=(values:Record<string,string>)=>{if(!failed&&Object.keys(values).some(key=>key.startsWith('account:'))){failed=true;throw Error('synthetic receipt storage failure')}return encrypt(values)};
  const first=new Controller(f.store,secure,'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:transport}});first.runtime.aiReady=true;
  let resumed:Controller|undefined;
  try{
    await first.tick();assert.equal(f.store.read().tasks[0].reasonCode,'submission_unknown');assert.equal(f.store.read().accounts[0].status,'unknown');
    assert.ok(JSON.parse(plaintext(f.store,`batch5:identity:rant:${siteId}`)).opaque);assert.equal(count(requests,'POST'),1);
    first.stop();f.store.close();reopened=new Store(f.path);
    resumed=new Controller(reopened,vault(reopened),'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:transport}});resumed.runtime.aiReady=true;
    await resumed.tick();assert.equal(reopened.read().accounts[0].status,'registered');assert.notEqual(reopened.read().tasks[0].reasonCode,'submission_unknown');
    assert.equal(requests.filter(value=>value.method==='POST'&&value.url.includes('/signup')).length,1);
    assert.equal(reopened.read().tasks[0].status,'live');assert.equal(count(requests,'POST'),2,'one registration plus one distinct article publication');
    const identity=plaintext(reopened,`batch5:identity:rant:${siteId}`);assert.ok(JSON.parse(identity).receipt);
  }finally{first.stop();resumed?.stop();reopened?.close();f.cleanup()}
});

test('a refused site is not dispatched again and its operation is counted only once',async(t)=>{
  const f=fixture('rant');let posts=0;
  const controller=new Controller(f.store,vault(f.store),'fixture',{channelCatalog:[channel('rant')],batch5Dependencies:{fetch:async()=>{posts++;return new Response('{}',{status:403,headers:{'content-type':'application/json'}})}}});controller.runtime.aiReady=true;
  try{
    await controller.tick();assert.equal(posts,1);assert.equal(f.store.read().settings.channelTrials?.rant.failures,1);
    const later=new Date(Date.parse(at)+4*86400000).toISOString();(t as TestContext).mock.timers.setTime(Date.parse(later));
    f.store.update(state=>{state.sites[0].topicsCheckedAt=later;state.sites[0].topics!.push({url:'https://example.com/second-guide',discoveredAt:later});state.tasks.push({...task('rant'),id:'33333333-3333-4333-8333-333333333333',topicUrl:'https://example.com/second-guide',createdAt:later,scheduledAt:later,updatedAt:later});});
    await controller.tick();const state=f.store.read();assert.equal(state.tasks[1].status,'needs_input');assert.equal(state.tasks[1].submittedAt,undefined);
    assert.equal(posts,1);assert.equal(state.settings.channelTrials?.rant.failures,1);assert.equal(state.settings.channelTrials?.rant.activeTaskId,undefined);assert.notEqual(state.settings.channelOverrides.rant,false);
    assert.ok(state.tasks[0].trialFailureOperationId);assert.equal(state.tasks[1].trialFailureOperationId,undefined);
    assert.doesNotThrow(()=>validateBackup({state,secrets:{[`batch5:identity:rant:${siteId}`]:plaintext(f.store,`batch5:identity:rant:${siteId}`)}}));
  }finally{controller.stop();f.cleanup()}
});
