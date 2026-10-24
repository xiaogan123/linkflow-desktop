import test from 'node:test';
import assert from 'node:assert/strict';
import {Store,emptyState,migrateState} from '../src/main/store';
import {addSitesBatch,SITE_IMPORT_BATCH_SIZE} from '../src/main/site-batch';
import {AddSitesBatch,EditSite,SettingsPatch,SiteContentUpdate} from '../src/main/validation';
import {validateBackup} from '../src/main/backup-validation';
import {mergeDiscoveredSiteTopics,rerollSiteWritingProfile,updateSiteContent} from '../src/main/site-service';
import {saveSettingsAtomic} from '../src/main/settings-service';
import {Controller} from '../src/main/controller';
import {createWritingProfile} from '../src/shared/writing-profile';
import {importSpreadDays} from '../src/shared/scheduling';
import {articleDraftPreflight} from '../src/main/article-evidence';
import {articleContextHash,reviewArticleDraft} from '../src/main/article-review';
import {decorateManagedDraft} from '../src/main/draft-contract';
import {CHANNELS} from '../src/integrations/catalog';
import {analyzeWebsiteHtml} from '../src/integrations/web';
import type {AddSitesBatchInput,Mailbox,Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const stamp='2026-10-01T00:00:00.000Z';
const siteId='11111111-1111-4111-8111-111111111111';
const taskId='22222222-2222-4222-8222-222222222222';
const now=new Date(stamp);
const base:Omit<AddSitesBatchInput,'domains'>={monthlyTarget:2,articleReviewMode:'ai',siteType:'finance-zh',contactEmail:''};
const vault={available:()=>true,encryptSecrets:()=>({})} as unknown as Vault;
function site():Site{return {id:siteId,domain:'example.com',url:'https://example.com',email:'',name:'Example',description:'Educational guides',category:'finance',language:'zh-CN',monthlyTarget:2,status:'ready',createdAt:stamp,analyzedAt:stamp}}
function task():Task{return {id:taskId,siteId,channelId:'telegraph',sourceDomain:'telegra.ph',status:'queued',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',topicUrl:'https://example.com/guides/reading',draft:{title:'Reading the documentation',description:'An educational guide',body:'Read the original documentation before choosing a workflow.'},articleApprovedAt:stamp,history:[{at:stamp,status:'queued',message:'fixture history'}]}}
const mailboxId='44444444-4444-4444-8444-444444444444';
function mailbox():Mailbox{return {id:mailboxId,label:'收码',host:'imap.gmail.com',port:993,user:'codes@gmail.com',secure:true,hasPassword:true,aliases:[],createdAt:stamp,updatedAt:stamp,verifiedAt:stamp}}

test('batch input accepts an empty public email and enforces the import contract',()=>{
  assert.equal(AddSitesBatch.parse({...base,domains:['example.com']}).contactEmail,'');
  assert.throws(()=>AddSitesBatch.parse({...base,domains:[]}));
  assert.throws(()=>AddSitesBatch.parse({...base,domains:['example.com'],siteType:'unknown'}));
  assert.throws(()=>AddSitesBatch.parse({...base,domains:['example.com'],contactEmail:'invalid'}));
  assert.throws(()=>AddSitesBatch.parse({...base,domains:['example.com'],monthlyTarget:0}));
  assert.equal(AddSitesBatch.parse({...base,domains:['example.com'],mailboxId}).mailboxId,mailboxId);
  assert.throws(()=>AddSitesBatch.parse({...base,domains:['example.com'],mailboxId:'unknown'}));
  assert.equal(EditSite.parse({id:siteId,email:'',publicEmail:''}).email,'');
});

test('batch binds only new websites to a currently usable selected mailbox',async()=>{
  const store=new Store(':memory:');
  try{
    store.update(state=>{state.settings.autoRun=false;state.mailboxes=[mailbox()];state.sites=[site()]});
    const result=await addSitesBatch(store,{...base,domains:['example.com','new.example.com'],mailboxId},{now});
    assert.equal(result.added,1);assert.equal(result.duplicates,1);
    assert.equal(store.read().sites[0].mailboxId,undefined);
    assert.equal(store.read().sites[1].mailboxId,mailboxId);
    assert.equal(store.read().sites[1].publicEmail,'');
  }finally{store.close()}
});

test('batch rejects deleted, untested and failed mailboxes before saving any website',async()=>{
  const store=new Store(':memory:');
  try{
    for(const current of [undefined,{...mailbox(),verifiedAt:undefined},{...mailbox(),lastError:'test failed'}]){
      store.update(state=>{state.mailboxes=current?[current]:[]});
      await assert.rejects(addSitesBatch(store,{...base,domains:['new.example.com'],mailboxId},{now}),/收信邮箱不存在或尚未测试可用/);
      assert.equal(store.read().sites.length,0);
    }
    store.update(state=>{state.mailboxes=[mailbox()]});
    const result=await addSitesBatch(store,{...base,domains:['new.example.com'],mailboxId},{now,yieldToUi:async()=>{store.update(state=>{state.mailboxes=[]})}});
    assert.equal(result.added,0);assert.deepEqual(result.errors.map(error=>[error.index,error.code]),[[0,'save_failed']]);
    assert.match(result.errors[0].message,/收信邮箱不存在或尚未测试可用/);
    assert.equal(store.read().sites.length,0);
  }finally{store.close()}
});

test('mailbox failure after a yield returns partial results and analyzes every committed site exactly once',async()=>{
  const store=new Store(':memory:');
  try{
    store.update(state=>{state.settings.autoRun=false;state.mailboxes=[mailbox()]});
    const domains=Array.from({length:12},(_,index)=>`new-${index}.example.com`),analyses:string[]=[];
    let yields=0;
    const result=await addSitesBatch(store,{...base,siteType:'auto',domains,mailboxId},{now,
      yieldToUi:async()=>{if(++yields===2)store.update(state=>{state.mailboxes[0].lastError='lost connection'})},
      analyze:id=>analyses.push(id)});
    assert.equal(result.added,10);assert.equal(result.duplicates,0);
    assert.deepEqual(result.errors.map(error=>[error.index,error.code]),[[10,'save_failed'],[11,'save_failed']]);
    assert.ok(result.errors.every(error=>error.message.includes('收信邮箱不存在或尚未测试可用')));
    assert.equal(store.read().sites.length,10);
    assert.deepEqual(analyses,result.siteIds);
    assert.equal(new Set(analyses).size,10);
    assert.ok(store.read().sites.every(value=>value.mailboxId===mailboxId));
    store.update(state=>{state.mailboxes[0].lastError=undefined});
    const retry=await addSitesBatch(store,{...base,siteType:'auto',domains,mailboxId},{now,analyze:id=>analyses.push(id)});
    assert.equal(retry.added,2);assert.equal(retry.duplicates,10);assert.deepEqual(retry.errors,[]);
    assert.equal(new Set(analyses).size,12);assert.equal(analyses.length,12);
    assert.deepEqual(analyses.slice(10),retry.siteIds);
  }finally{store.close()}
});

test('batch normalizes addresses, reports bad rows, and deduplicates both saved and incoming sites',async()=>{
  const store=new Store(':memory:');
  try{
    store.update(state=>{state.settings.autoRun=false;state.sites=[site()]});
    const analyses:string[]=[];
    const result=await addSitesBatch(store,{...base,domains:['https://WWW.Example.com/','second.example.com','https://second.example.com/','https://third.example.com/article','http://fourth.example.com','fifth.example.com']},{now,analyze:id=>analyses.push(id)});
    assert.equal(result.added,2);assert.equal(result.duplicates,2);assert.deepEqual(result.errors.map(error=>[error.index,error.code]),[[3,'invalid_domain'],[4,'invalid_domain']]);
    assert.deepEqual(store.read().sites.map(value=>value.domain),['example.com','second.example.com','fifth.example.com']);
    assert.equal(result.rolloutDays,importSpreadDays(3));assert.deepEqual(analyses,[]);
    for(const value of store.read().sites.slice(1)){
      assert.equal(value.category,'finance');assert.equal(value.language,'zh-CN');assert.equal(value.status,'ready');
      assert.equal(value.email,'');assert.equal(value.publicEmail,'');assert.equal(value.analyzedAt,stamp);assert.equal(value.articleReviewMode,'ai');assert.ok(value.writingProfile);
    }
    const restored=validateBackup({state:store.read(),secrets:{}}).state;
    assert.equal(restored.sites[1].email,'');assert.deepEqual(restored.sites[1].writingProfile,store.read().sites[1].writingProfile);
  }finally{store.close()}
});

test('more than one hundred rows commit independently, yield to the event loop, and queue only new auto analyses',async()=>{
  const store=new Store(':memory:');
  try{
    store.update(state=>{state.settings.autoRun=false;state.settings.timezone='UTC'});
    const count=SITE_IMPORT_BATCH_SIZE+1,domains=Array.from({length:count},(_,index)=>`site-${index}.example.com`),analyses:string[]=[];
    let commits=0,heartbeat=false;
    store.onChange=()=>{commits++};setImmediate(()=>{heartbeat=true});
    const result=await addSitesBatch(store,{...base,siteType:'auto',articleReviewMode:'manual',contactEmail:'contact@example.com',domains},{now,analyze:id=>{assert.equal(store.read().sites.length,count);analyses.push(id)}});
    assert.equal(result.added,count);assert.equal(commits,count);assert.ok(heartbeat);assert.deepEqual(analyses,result.siteIds);
    assert.equal(result.rolloutDays,importSpreadDays(count));
    assert.ok(store.read().sites.every(value=>value.status==='analyzing'&&value.articleReviewMode==='manual'&&value.email==='contact@example.com'));
  }finally{store.close()}
});

test('an individual database failure is reported and does not roll back earlier rows or prevent later rows',async()=>{
  const store=new Store(':memory:');
  try{
    (store as unknown as {db:{exec(sql:string):void}}).db.exec(`CREATE TRIGGER reject_one_import BEFORE UPDATE ON state WHEN instr(NEW.body, '"domain":"blocked.example.com"')>0 BEGIN SELECT RAISE(ABORT,'synthetic import failure'); END;`);
    const result=await addSitesBatch(store,{...base,domains:['first.example.com','blocked.example.com','last.example.com']},{now});
    assert.equal(result.added,2);assert.deepEqual(result.errors.map(error=>[error.index,error.code]),[[1,'save_failed']]);
    assert.deepEqual(store.read().sites.map(value=>value.domain),['first.example.com','last.example.com']);
  }finally{store.close()}
});

test('a concurrent importer cannot add the same normalized domain twice',async()=>{
  const store=new Store(':memory:');
  try{
    let yields=0;
    const result=await addSitesBatch(store,{...base,domains:['example.com']},{now,yieldToUi:async()=>{if(yields++===0)store.update(state=>state.sites.push(site()))}});
    assert.equal(result.added,0);assert.equal(result.duplicates,1);assert.equal(result.rolloutDays,0);assert.equal(store.read().sites.length,1);
  }finally{store.close()}
});

test('rollout estimate includes ready sites from the same import day and uses the scheduler cap',async()=>{
  const store=new Store(':memory:');
  try{
    store.update(state=>{state.settings.timezone='UTC';state.settings.autoRun=false;state.sites=Array.from({length:145},(_,index)=>({...site(),id:crypto.randomUUID(),domain:`existing-${index}.example.com`,url:`https://existing-${index}.example.com`}))});
    const result=await addSitesBatch(store,{...base,domains:['new.example.com']},{now});
    assert.equal(result.rolloutDays,importSpreadDays(146));assert.equal(result.rolloutDays,21);
  }finally{store.close()}
});

test('appearance persists through settings and backup while legacy and corrupt values migrate to system',()=>{
  const store=new Store(':memory:');
  try{
    for(const appearance of ['system','light','dark'] as const){
      saveSettingsAtomic(store,vault,SettingsPatch.parse({appearance}));
      assert.equal(store.read().settings.appearance,appearance);
      assert.equal(validateBackup({state:store.read(),secrets:{}}).state.settings.appearance,appearance);
    }
    const legacy=emptyState();delete legacy.settings.appearance;assert.equal(migrateState(legacy).settings.appearance,'system');
    const oldBackup=emptyState();delete oldBackup.settings.appearance;assert.equal(migrateState(validateBackup({state:oldBackup,secrets:{}}).state).settings.appearance,'system');
    const invalid=emptyState();(invalid.settings as unknown as {appearance:string}).appearance='neon';
    assert.throws(()=>validateBackup({state:invalid,secrets:{}}));assert.equal(migrateState(invalid).settings.appearance,'system');
    assert.throws(()=>SettingsPatch.parse({appearance:'neon'}));
  }finally{store.close()}
});

test('reroll changes only the selected future writing profile and preserves every draft and history',()=>{
  const state=emptyState(),selected=site(),other={...site(),id:'33333333-3333-4333-8333-333333333333',domain:'other.example.com'};
  selected.writingProfile=createWritingProfile(selected);other.writingProfile=createWritingProfile(other);state.sites=[selected,other];state.tasks=[task()];
  const before=structuredClone(state),profile=rerollSiteWritingProfile(state,siteId);
  assert.notEqual(profile.fingerprint,before.sites[0].writingProfile?.fingerprint);assert.notEqual(profile.fingerprint,other.writingProfile.fingerprint);
  assert.deepEqual(state.tasks,before.tasks);assert.deepEqual(state.sites[1],before.sites[1]);
  assert.deepEqual({...state.sites[0],writingProfile:undefined},{...before.sites[0],writingProfile:undefined});
});

test('archive pauses the site and preserves tasks, receipts, events, and account bindings; resume removes the archive marker',()=>{
  const store=new Store(':memory:');
  try{
    store.update(state=>{state.settings.autoRun=false;state.sites=[site()];state.tasks=[{...task(),status:'live',firstLiveAt:stamp,submittedAt:stamp,publicUrl:'https://publisher.example/article'}];state.events=[{id:'33333333-3333-4333-8333-333333333333',at:stamp,siteId,level:'info',message:'fixture'}];state.accounts=[{id:'44444444-4444-4444-8444-444444444444',channelId:'github-gist',email:'owner@example.com',username:'example-owner',status:'unknown',source:'imported',hasPassword:false,createdAt:stamp}];state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId,accountId:state.accounts[0].id,channelId:'github-gist',createdAt:stamp,updatedAt:stamp}]});
    const controller=new Controller(store,vault,'isolated-archive-fixture'),before=store.read();
    controller.archiveSite(siteId);const after=store.read();
    assert.equal(after.sites.length,1);assert.equal(after.sites[0].status,'paused');assert.ok(after.sites[0].archivedAt);
    assert.deepEqual(after.tasks,before.tasks);assert.deepEqual(after.events,before.events);assert.deepEqual(after.accountBindings,before.accountBindings);
    assert.equal(validateBackup({state:after,secrets:{}}).state.sites[0].archivedAt,after.sites[0].archivedAt);
    const archivedBackup=structuredClone(after);archivedBackup.sites[0].status='ready';assert.equal(migrateState(archivedBackup).sites[0].status,'paused');
    controller.sitePause(siteId,false);assert.equal(store.read().sites[0].archivedAt,undefined);assert.equal(store.read().sites[0].status,'ready');
  }finally{store.close()}
});

test('archiving during analysis aborts the late result and keeps the site archived',async()=>{
  const store=new Store(':memory:');
  let release!:()=>void,start!:()=>void;
  const started=new Promise<void>(resolve=>{start=resolve}),gate=new Promise<void>(resolve=>{release=resolve});
  try{
    store.update(state=>{state.settings.autoRun=false;state.sites=[site()]});
    const controller=new Controller(store,vault,'isolated-archive-analysis-fixture',{
      analyzeWebsite:async()=>{start();await gate;return analyzeWebsiteHtml('<html lang="en"><title>Changed title</title></html>','https://example.com/')},
      discoverTopics:async()=>({topics:[],checkedAt:stamp}),discoverTechnicalMaterial:async()=>undefined,
    });
    const pending=controller.analyze(siteId);await started;controller.archiveSite(siteId);release();await pending;
    const saved=store.read().sites[0];assert.equal(saved.status,'paused');assert.ok(saved.archivedAt);assert.equal(saved.name,'Example');assert.equal(controller.hasPendingWork(),false);
  }finally{release();store.close()}
});

test('content edits deduplicate site URLs, retain topic discovery dates, and reject external addresses atomically',()=>{
  const store=new Store(':memory:');
  try{
    store.update(state=>{state.settings.autoRun=false;state.sites=[{...site(),topics:[{url:'https://example.com/guides/reading',title:'Prior title',discoveredAt:stamp}]}];state.tasks=[task(),{...task(),id:'33333333-3333-4333-8333-333333333333',submittedAt:stamp,status:'review'}]});
    const before=store.read(),input=SiteContentUpdate.parse({id:siteId,topics:[{url:'https://example.com/guides/reading',title:'New title'},{url:'https://example.com/guides/reading#notes',title:'New title'}],linkTargets:['https://example.com/','https://example.com/#start'],forbiddenTerms:['avoid this','avoid this']});
    store.update(state=>updateSiteContent(state,input,new Date('2026-10-02T00:00:00.000Z')));
    const after=store.read(),saved=after.sites[0];
    assert.equal(saved.topics?.length,1);assert.equal(saved.topics?.[0].title,'New title');assert.equal(saved.topics?.[0].discoveredAt,stamp);
    assert.deepEqual(saved.linkTargets,['https://example.com/']);assert.deepEqual(saved.forbiddenTerms,['avoid this']);
    assert.deepEqual(after.tasks[0].draft,before.tasks[0].draft);assert.equal(after.tasks[0].articleApprovedAt,undefined);assert.deepEqual(after.tasks[1],before.tasks[1]);
    const roundtrip=validateBackup({state:after,secrets:{}}).state;assert.deepEqual(roundtrip.sites[0].linkTargets,saved.linkTargets);assert.deepEqual(roundtrip.sites[0].forbiddenTerms,saved.forbiddenTerms);
    assert.throws(()=>store.update(state=>updateSiteContent(state,{...input,linkTargets:['https://other.example.com/']})));
    assert.deepEqual(store.read(),after);
  }finally{store.close()}
});

test('later topic discovery retains manual additions, exclusions, and edited titles',()=>{
  const state=emptyState(),value=site();state.sites=[value];
  value.topics=[{url:'https://example.com/guides/removed',discoveredAt:stamp},{url:'https://example.com/guides/retained',title:'Discovered title',discoveredAt:stamp}];
  updateSiteContent(state,{id:siteId,topics:[{url:'https://example.com/guides/retained',title:'Edited title'},{url:'https://example.com/guides/manual',title:'Manual title'}],linkTargets:[],forbiddenTerms:[]},now);
  const discovered=['removed','retained','new'].map(name=>({url:`https://example.com/guides/${name}`,title:'Fresh discovery',discoveredAt:stamp}));
  const merged=mergeDiscoveredSiteTopics(value,discovered,new Set());
  assert.deepEqual(merged.map(topic=>topic.url),['https://example.com/guides/retained','https://example.com/guides/manual','https://example.com/guides/new']);
  assert.equal(merged[0].title,'Edited title');assert.equal(merged[1].title,'Manual title');
  const restored=validateBackup({state,secrets:{}}).state;assert.deepEqual(restored.sites[0].topicOverrides,value.topicOverrides);
});

test('forbidden terms and link targets fail the existing draft preflight before any AI evidence call',async()=>{
  const value=site(),draftTask=task(),channel=CHANNELS.find(value=>value.id==='telegraph')!,settings=emptyState().settings;
  value.forbiddenTerms=['DOCUMENTATION'];assert.equal(articleDraftPreflight(draftTask,value,channel),'site_forbidden_term');
  let called=false;
  const review=await reviewArticleDraft(draftTask,value,channel,settings,{json:async()=>{called=true;throw Error('unexpected AI call')}},undefined,{fetchHtml:async()=>{called=true;throw Error('unexpected network call')}});
  assert.equal(review.status,'failed');assert.equal(called,false);
  value.forbiddenTerms=[];value.linkTargets=['https://example.com/allowed'];assert.equal(articleDraftPreflight(draftTask,value,channel),'site_target_not_allowed');
  const before=articleContextHash({...value,linkTargets:undefined},channel,settings);assert.notEqual(articleContextHash(value,channel,settings),before);
});

test('flexible writers select an allowed home or topic target and fixed writers keep their original target guarantee',()=>{
  const value=site(),draftTask=task(),flexible=CHANNELS.find(value=>value.id==='telegraph')!,fixed=CHANNELS.find(value=>value.id==='supanote')!;
  value.writingProfile=createWritingProfile(value);value.linkTargets=['https://example.com/'];
  const home=decorateManagedDraft(draftTask.draft!,value,flexible,draftTask);assert.equal(home.envelope?.targetUrl,'https://example.com/');
  value.linkTargets=[draftTask.topicUrl!];const topic=decorateManagedDraft(draftTask.draft!,value,flexible,draftTask);assert.equal(topic.envelope?.targetUrl,draftTask.topicUrl);
  value.linkTargets=['https://example.com/unrelated'];assert.throws(()=>decorateManagedDraft(draftTask.draft!,value,fixed,draftTask));
  value.linkTargets=['https://example.com/'];assert.throws(()=>decorateManagedDraft(draftTask.draft!,value,fixed,draftTask));
});

test('refreshing topics keeps only open or unchecked work, so finished posts never crowd out new pages',async()=>{
  const {reservesTopic}=await import('../src/main/site-service');
  const at='2026-10-19T00:00:00.000Z',url='https://example.com/guide';
  assert.equal(reservesTopic({topicUrl:url,status:'queued'}),true);
  assert.equal(reservesTopic({topicUrl:url,status:'failed',submittedAt:at}),true);
  assert.equal(reservesTopic({topicUrl:url,status:'failed'}),false);
  assert.equal(reservesTopic({topicUrl:url,status:'skipped',draft:{title:'T',description:'D',body:'B'}}),true);
  assert.equal(reservesTopic({topicUrl:url,status:'running',firstLiveAt:at}),false);
  const old=Array.from({length:200},(_value,index)=>({url:`https://example.com/old-${index}`,title:'old',discoveredAt:at}));
  const site={topics:old} as unknown as import('../src/shared/types').Site;
  // Only one old topic is still in use: the rest make room for what the site publishes now.
  const merged=mergeDiscoveredSiteTopics(site,[{url:'https://example.com/old-0',title:'Renamed',discoveredAt:at},{url:'https://example.com/new',title:'New',discoveredAt:at}],new Set(['https://example.com/old-0']));
  assert.deepEqual(merged.map(topic=>topic.url),['https://example.com/old-0','https://example.com/new']);
  assert.equal(merged[0].title,'Renamed');
});
