import test,{beforeEach,type TestContext} from 'node:test';
beforeEach(t=>(t as TestContext).mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-19T10:17:00.000Z')}));
import assert from 'node:assert/strict';
import {Controller} from '../src/main/controller';
import {Store} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import type {Channel,Site,Task} from '../src/shared/types';

const stamp='2026-10-18T00:00:00.000Z';
const site:Site={id:'11111111-1111-4111-8111-111111111111',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Example guide',category:'general',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp};
const channel:Channel={id:'example-channel',name:'Example channel',domain:'example-site.com',url:'https://example-site.com/',submitUrl:'https://example-site.com/submit',categories:['general'],languages:['*'],kind:'profile',emailRequired:false,accountRequired:false,articleRequired:false,free:'yes',freeNote:'fixture',automation:'manual',quality:'C',qualityReason:'fixture',rulesUrl:'https://example-site.com/rules',checkedAt:'2026-10-18',notes:'fixture',allowedHosts:['example-site.com'],enabled:true};
const task:Task={id:'22222222-2222-4222-8222-222222222222',siteId:site.id,channelId:channel.id,sourceDomain:channel.domain,status:'review',createdAt:stamp,updatedAt:stamp,scheduledAt:stamp,submittedAt:stamp,attempts:1,message:'fixture',publicUrl:'https://article.example-site.com/post',publicationMethod:'external'};
function setup(key=true, response=()=>Response.json({domain_rating:42.75,license:'fixture'})){
  const store=new Store(':memory:');
  store.update(state=>{state.settings.autoRun=false;state.settings.hasAhrefsKey=key;state.sites=[site];state.tasks=[task]});
  if(key)store.setCipher('ahrefsApiKey','cipher:synthetic-key');
  const vault={ready:true,available:()=>true,get:async(name:string)=>store.getCipher(name)?.replace(/^cipher:/,''),encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([k,v])=>[k,'cipher:'+v]))} as unknown as Vault;
  const queries:string[]=[];
  const controller=new Controller(store,vault,'fixture',{channelCatalog:[channel],verifyLink:async url=>({found:true,outcome:'found',url,rel:'nofollow',reason:'fixture'}),recheckLink:async url=>({found:true,outcome:'found',url,rel:'nofollow',reason:'fixture',reasonCode:'link_found'}),ahrefsOptions:{fetch:async(input)=>{queries.push(new URL(String(input)).searchParams.get('target')!);return response()},now:()=>new Date(stamp),intervalMs:0,maxRetries:0}});
  return {store,controller,queries,close:()=>{controller.stop();store.close()}};
}

test('successful public verification automatically queries the actual backlink host once',async()=>{
  const f=setup();
  try{
    await f.controller.verify(task.id);
    // The public hook is deliberately fire-and-forget; enqueue a barrier after it.
    await f.controller.ahrefs.refreshTask(task.id);
    assert.deepEqual(f.queries,['article.example-site.com']);
    const saved=f.store.read().tasks[0];
    assert.equal(saved.status,'live');assert.equal(saved.attempts,1);assert.equal(saved.submittedAt,stamp);
    assert.equal(saved.metrics?.[0].value,42.75);assert.equal(saved.metrics?.[0].linkScope,'same-host');
    await f.controller.verify(task.id);await f.controller.ahrefs.refreshTask(task.id);
    assert.equal(f.queries.length,1);
  }finally{f.close()}
});

test('DR failure does not change confirmed publication or its duplicate-submission evidence',async()=>{
  const f=setup(true,()=>new Response('',{status:401}));
  try{
    await f.controller.verify(task.id);await f.controller.ahrefs.refreshTask(task.id);
    const saved=f.store.read().tasks[0];
    assert.equal(saved.status,'live');assert.equal(saved.submittedAt,stamp);assert.equal(saved.attempts,1);
    assert.equal(saved.metrics,undefined);assert.equal(f.store.read().settings.ahrefsStatus,'error');
    assert.equal(f.queries.length,1);
  }finally{f.close()}
});

test('tick refreshes channels even when publication scheduling is paused, and only once a month',async()=>{
  const f=setup();
  try{
    await f.controller.tick();await f.controller.ahrefs.refreshMonthly();
    assert.deepEqual(f.queries,[channel.domain]);
    assert.equal(f.store.read().settings.ahrefsLastRefreshMonth,'2026-10');
    await f.controller.tick();await f.controller.ahrefs.refreshMonthly();
    assert.equal(f.queries.length,1);
  }finally{f.close()}
});

test('adding a custom channel triggers its DR query without waiting for next month',async()=>{
  const f=setup();
  try{
    f.store.update(state=>state.settings.ahrefsLastRefreshMonth='2026-10');
    f.controller.saveCustomChannel({name:'Custom example',domain:'new.example.com',submitUrl:'https://new.example.com/submit',categories:['general'],languages:['en'],kind:'profile',free:'yes',freeNote:'fixture',rulesUrl:'https://new.example.com/rules',notes:'fixture'});
    const added=f.controller.channels().find(value=>value.provenance==='custom')!;
    await f.controller.ahrefs.refreshChannel(added);
    assert.deepEqual(f.queries,['new.example.com']);
    assert.equal(f.store.read().channelMetrics?.[added.id].metrics?.[0].target,'new.example.com');
  }finally{f.close()}
});

test('saving and testing encrypts the key and launches a monthly refresh using only the mock',async()=>{
  const f=setup(false);
  try{
    assert.deepEqual(await f.controller.saveAhrefsAndTest('synthetic-new-key'),{ok:true});
    await f.controller.ahrefs.refreshMonthly();
    assert.deepEqual(f.queries,['ahrefs.com',channel.domain]);
    assert.equal(f.store.getCipher('ahrefsApiKey'),'cipher:synthetic-new-key');
    assert.equal(f.store.read().settings.ahrefsStatus,'connected');
    assert.equal(JSON.stringify(f.controller.snapshot()).includes('synthetic-new-key'),false);
  }finally{f.close()}
});

test('no key means verification, new channels and monthly tick never call Ahrefs',async()=>{
  const f=setup(false);
  try{
    await f.controller.verify(task.id);await f.controller.tick();
    assert.deepEqual(await f.controller.saveAhrefsAndTest(''),{ok:false});
    assert.deepEqual(f.queries,[]);
    assert.equal(f.store.read().settings.ahrefsStatus,undefined);
    assert.equal(f.store.read().tasks[0].status,'live');
  }finally{f.close()}
});

test('controller stop and restart resumes DR refresh after an interrupted application update',async()=>{
  const f=setup();
  try{
    f.controller.stop();
    f.controller.start();
    await f.controller.ahrefs.refreshMonthly();
    assert.deepEqual(f.queries,[channel.domain]);
    assert.equal(f.store.read().settings.ahrefsLastRefreshMonth,'2026-10');
  }finally{f.close()}
});

test('monthly tick never requeues already measured publication history',async()=>{
  const f=setup();let queued=0;
  try{
    f.store.update(state=>{
      state.settings.ahrefsLastRefreshMonth='2026-10';
      state.tasks=Array.from({length:100},(_,index)=>({...task,id:`33333333-3333-4333-8333-${String(index).padStart(12,'0')}`,status:'live',firstLiveAt:stamp,metrics:[{provider:'ahrefs-dr',value:42.75,target:'article.example-site.com',linkScope:'same-host',asOf:'2026-09',version:'dr3',source:'https://api.ahrefs.com/v3/public/domain-rating-free'}]}));
    });
    f.controller.ahrefs.refreshTask=async()=>{queued++};
    await f.controller.tick();
    assert.equal(queued,0);assert.deepEqual(f.queries,[]);
    assert.equal(f.store.read().tasks.length,100);
  }finally{f.close()}
});

test('401 stop and 429 cooldown do not requeue unmeasured publication history',async()=>{
  for(const retryAfter of [undefined,new Date(Date.now()+3_600_000).toISOString()]){
    const f=setup();let queued=0,monthly=0;
    try{
      f.store.update(state=>{
        state.settings.ahrefsStatus='error';state.settings.ahrefsRetryAfter=retryAfter;
        state.tasks=Array.from({length:100},(_,index)=>({...task,id:`44444444-4444-4444-8444-${String(index).padStart(12,'0')}`,status:'live',firstLiveAt:stamp}));
      });
      f.controller.ahrefs.refreshTask=async()=>{queued++};
      f.controller.ahrefs.refreshMonthly=async()=>{monthly++};
      await f.controller.tick();
      assert.equal(queued,0);assert.equal(monthly,0);assert.deepEqual(f.queries,[]);
    }finally{f.close()}
  }
});
