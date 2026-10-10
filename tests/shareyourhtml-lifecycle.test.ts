import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {renderShareYourHtmlArticle} from '../src/integrations/shareyourhtml-article';
import {ARTICLE_REVIEW_CONTRACT_VERSION,articleContentHash,articleContextHash} from '../src/main/article-review';
import {Controller} from '../src/main/controller';
import {submitReviewedShareYourHtmlPublication} from '../src/main/shareyourhtml-reviewed-publication';
import {createShareYourHtmlPublicationPersistence,shareYourHtmlSiteIdentityHash} from '../src/main/shareyourhtml-publication';
import {Store} from '../src/main/store';
import {hasExternalAttempt,recoverWithAlternativeTopic,resumeDeferredTask} from '../src/main/task-recovery';
import type {Vault} from '../src/main/vault';
import type {Channel,Site,Task} from '../src/shared/types';

const taskId='11111111-1111-4111-8111-111111111111';
const siteId='22222222-2222-4222-8222-222222222222';
const stamp='2026-10-08T00:00:00.000Z';
const topic='https://example.com/guides/reviewed-topic';
const slug='lf-11111111111141118111111111111111';
const publicUrl=`https://${slug}.shareyourhtml.com`;
const editKey='01234567-89ab-cdef-0123-456789abcdef';

function channel():Channel{return {id:'shareyourhtml',name:'ShareYourHTML',domain:'shareyourhtml.com',url:'https://shareyourhtml.com/',submitUrl:'https://shareyourhtml.com/pages',categories:['content'],languages:['*'],kind:'article',emailRequired:false,accountRequired:false,articleRequired:true,free:'yes',freeNote:'Free API.',automation:'api',quality:'B',qualityReason:'Synthetic future catalog fixture.',provenance:'built-in',requirements:[],evidenceStatus:'rules_checked',rulesUrl:'https://shareyourhtml.com/terms',evidenceSources:[{url:'https://shareyourhtml.com/terms',kind:'content_policy',appliesTo:'shareyourhtml',applicability:'verified'}],checkedAt:'2026-10-08',notes:'Static HTML article pages.',allowedHosts:['shareyourhtml.com'],enabled:true}}
function site():Site{return {id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Reviewed fixture site.',category:'content',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:stamp,analyzedAt:stamp,topicsCheckedAt:new Date().toISOString(),topics:[{url:topic,title:'Reviewed topic',discoveredAt:stamp},{url:'https://example.com/guides/alternative',title:'Alternative',discoveredAt:stamp}]}}
function task():Task{return {id:taskId,siteId,channelId:'shareyourhtml',sourceDomain:'shareyourhtml.com',status:'running',health:'pending',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'Ready',topicUrl:topic,draftRevision:3,draftUpdatedAt:stamp,draft:{title:'Reviewed article title',description:'A useful reviewed description.',body:`## Practical detail\n\nThis exact draft links to the [reviewed topic](${topic}).`}}}
function vault(store:Store):Vault{return {ready:true,available:()=>true,get:async(key:string)=>store.getCipher(key),set:async(key:string,value:string)=>store.setCipher(key,value),delete:async(key:string)=>store.deleteCipher(key),encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))} as unknown as Vault}

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'linkflow-shareyourhtml-lifecycle-')),path=join(directory,'state.sqlite'),store=new Store(path),currentChannel=channel(),currentSite=site(),currentTask=task();
  store.update(state=>{state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.model='review-model';state.settings.timezone='UTC';state.settings.channelOverrides.shareyourhtml=true;state.customChannels=[currentChannel];state.sites=[currentSite];state.tasks=[currentTask];currentTask.articleReview={status:'passed',reason:'Synthetic independently reviewed fixture.',reasonCode:'passed',reviewContractVersion:ARTICLE_REVIEW_CONTRACT_VERSION,checks:{factualAccuracy:'pass',authorRelationship:'pass',affiliateDisclosure:'pass',independentValue:'pass',financialSafety:'pass',channelRules:'pass'},reviewedAt:stamp,evidenceUrls:['https://example.com/','https://shareyourhtml.com/terms'],draftRevision:currentTask.draftRevision??0,contentHash:articleContentHash(currentTask),contextHash:articleContextHash(currentSite,currentChannel,state.settings)}});
  const submit=(fetch:(url:string,init:RequestInit)=>Promise<Response>)=>submitReviewedShareYourHtmlPublication(store,vault(store),{taskId,resolveChannel:state=>state.customChannels?.find(value=>value.id==='shareyourhtml')},{fetch});
  return {directory,path,store,currentChannel,submit,cleanup(){try{store.close()}catch{}rmSync(directory,{recursive:true,force:true})}};
}
function response(){return new Response(JSON.stringify({slug,url:publicUrl,edit_key:editKey}),{status:201,headers:{'content-type':'application/json'}})}
function assertSameState(actual:ReturnType<Store['read']>,expected:ReturnType<Store['read']>){assert.equal(JSON.stringify(actual),JSON.stringify(expected))}

test('a submitting claim permanently blocks task and claim mutation while retaining binding evidence across local edits',async()=>{
  const f=fixture();try{
    const result=await f.submit(async()=>{throw Error('synthetic timeout')});assert.equal(result.status,'unknown');
    const before=f.store.read(),mutations:Array<(state:ReturnType<Store['read']>)=>void>=[
      state=>{state.tasks=[]},
      state=>{state.sites=[]},
      state=>{state.tasks[0].shareYourHtml=undefined},
      state=>{state.tasks[0].status='skipped'},
      state=>{state.tasks[0].channelId='telegraph'},
      state=>{state.tasks[0].sourceDomain='changed.example'},
      state=>{state.tasks[0].shareYourHtml!.operationId='shareyourhtml_changed_operation'},
    ];
    for(const mutate of mutations){assert.throws(()=>f.store.update(mutate),/ShareYourHTML/);assert.deepEqual(f.store.read(),before)}
    f.store.update(state=>{state.tasks[0].draft!.body+=' replacement';state.tasks[0].draftRevision=4;state.sites[0].domain='changed.example';state.sites[0].url='https://changed.example/';state.sites[0].status='paused';state.settings.notify=false;state.events.push({id:'event-1',at:new Date().toISOString(),level:'info',message:'unrelated retained event'})});
    const paused=f.store.read();assert.equal(paused.sites[0].status,'paused');assert.deepEqual(paused.tasks[0].shareYourHtml,before.tasks[0].shareYourHtml);assert.equal(paused.tasks[0].shareYourHtml?.reviewedDraftRevision,3);assert.equal(paused.tasks[0].shareYourHtml?.siteIdentityHash,shareYourHtmlSiteIdentityHash(before.sites[0]));assert.equal(paused.events.at(-1)?.message,'unrelated retained event');
  }finally{f.cleanup()}
});

test('receipt and edit-key transition is atomic, immutable, and survives reopen',async()=>{
  const f=fixture();try{
    assert.equal((await f.submit(async()=>response())).status,'created');const key=`publication:${taskId}`,before=f.store.read(),cipher=f.store.getCipher(key);assert.match(cipher??'',/^enc:/);
    assert.throws(()=>f.store.updateWithCiphers(state=>{state.events.push({id:'bad',at:stamp,level:'info',message:'must roll back'})},{},[key]),/ShareYourHTML/);assert.deepEqual(f.store.read(),before);assert.equal(f.store.getCipher(key),cipher);
    assert.throws(()=>f.store.updateWithCiphers(()=>{}, {[key]:'replacement-cipher'}),/ShareYourHTML/);assert.deepEqual(f.store.read(),before);assert.equal(f.store.getCipher(key),cipher);
    assert.throws(()=>f.store.update(state=>{state.tasks[0].shareYourHtml!.stage='submitting';state.tasks[0].publicUrl=undefined;state.tasks[0].checkpoint='shareyourhtml_create_submitting'}),/ShareYourHTML/);assert.deepEqual(f.store.read(),before);
    f.store.close();const reopened=new Store(f.path);try{assertSameState(reopened.read(),before);assert.equal(reopened.getCipher(key),cipher)}finally{reopened.close()}
  }finally{rmSync(f.directory,{recursive:true,force:true})}
});

test('restore rejects claim removal, retargeting and cipher loss without changing the current database',async()=>{
  const f=fixture();try{
    await f.submit(async()=>response());const state=f.store.read(),ciphers=f.store.allCiphers(),key=`publication:${taskId}`;
    const attempts:Array<{state:ReturnType<Store['read']>;ciphers:Record<string,string>}>=[];
    const withoutTask=structuredClone(state);withoutTask.tasks=[];attempts.push({state:withoutTask,ciphers});
    const retarget=structuredClone(state),replacement:Site={...site(),id:'33333333-3333-4333-8333-333333333333',domain:'other.example.com',url:'https://other.example.com/'};retarget.sites.push(replacement);retarget.tasks[0].siteId=replacement.id;retarget.tasks[0].shareYourHtml!.siteId=replacement.id;retarget.tasks[0].shareYourHtml!.siteIdentityHash=shareYourHtmlSiteIdentityHash(replacement);attempts.push({state:retarget,ciphers});
    const missingCipher={...ciphers};delete missingCipher[key];attempts.push({state,ciphers:missingCipher});attempts.push({state,ciphers:{...ciphers,[key]:'different'}});
    for(const attempt of attempts){assert.throws(()=>f.store.restore(attempt.state,attempt.ciphers),/ShareYourHTML/);assertSameState(f.store.read(),state);assert.deepEqual(f.store.allCiphers(),ciphers)}
    assert.doesNotThrow(()=>f.store.restore(structuredClone(state),ciphers));assertSameState(f.store.read(),state);assert.deepEqual(f.store.allCiphers(),ciphers);
  }finally{f.cleanup()}
});

test('recovery helpers, Controller deletion and draft reset respect the permanent external attempt',async()=>{
  const f=fixture();try{
    await f.submit(async()=>response());const saved=f.store.read().tasks[0];assert.equal(hasExternalAttempt(saved),true);
    const recoveryTask=structuredClone(saved),recovery=recoverWithAlternativeTopic(recoveryTask,f.store.read().sites[0],f.currentChannel,[recoveryTask],f.store.read().settings,new Date(),true);assert.equal(recovery.kind,'ineligible');assert.equal(recoveryTask.topicUrl,saved.topicUrl);assert.deepEqual(recoveryTask.shareYourHtml,saved.shareYourHtml);
    const deferred=structuredClone(saved);deferred.status='skipped';deferred.deferredAt=new Date().toISOString();assert.throws(()=>resumeDeferredTask([deferred],deferred.id,f.store.read().settings),/已有外部提交记录/);
    const controller=new Controller(f.store,vault(f.store),'fixture');assert.throws(()=>controller.deleteSite(siteId),/可先暂停网站/);await assert.rejects(controller.generateDraft(taskId),/已有远程发布记录/);assert.equal(f.store.getCipher(`publication:${taskId}`)?.startsWith('enc:'),true);assert.equal(f.store.read().sites.length,1);assert.equal(f.store.read().tasks.length,1);
  }finally{f.cleanup()}
});

test('a nested receipt commit wins over the stale outer Store update',async()=>{
  const f=fixture();try{
    await f.submit(async()=>{throw Error('synthetic unknown')});const saved=f.store.read().tasks[0],claim=saved.shareYourHtml!;
    const html=renderShareYourHtmlArticle({draft:saved.draft!,targetUrl:topic,language:'en',slug}).html,hash=(value:string)=>createHash('sha256').update(value).digest('hex');
    assert.equal(claim.sourceHash,hash(html));assert.equal(claim.requestHash,hash(JSON.stringify({slug,html,expiry:'never'})));
    const persistence=createShareYourHtmlPublicationPersistence(f.store,vault(f.store),{taskId,siteId,reviewedHtml:html,reviewedDraft:saved.draft!,reviewedDraftRevision:saved.draftRevision!,expectedIntent:claim,assertSubmissionAuthorized:()=>true});
    let nested:Promise<void>|undefined;
    assert.throws(()=>f.store.update(state=>{nested=persistence.persistCreatedAtomically({receipt:{...claim,publicUrl,requestedExpiry:'never',publicVerification:'pending'},editKey});state.settings.notify=false}),/更晚的持久化结果/);
    await nested;const current=f.store.read();assert.equal(current.tasks[0].shareYourHtml?.stage,'api_receipt');assert.equal(current.settings.notify,true);assert.match(f.store.getCipher(`publication:${taskId}`)??'',/^enc:/);
    f.store.close();const reopened=new Store(f.path);try{assert.equal(reopened.read().tasks[0].shareYourHtml?.stage,'api_receipt');assert.match(reopened.getCipher(`publication:${taskId}`)??'',/^enc:/)}finally{reopened.close()}
  }finally{rmSync(f.directory,{recursive:true,force:true})}
});

test('one cipher key cannot be written and deleted in the same Store transaction',async()=>{
  const f=fixture();try{
    await f.submit(async()=>{throw Error('synthetic unknown')});const key=`publication:${taskId}`,before=f.store.read();let called=false;
    assert.throws(()=>f.store.updateWithCiphers(()=>{called=true},{[key]:'unexpected-cipher'},[key]),/同时写入和删除/);assert.equal(called,false);assertSameState(f.store.read(),before);assert.equal(f.store.getCipher(key),undefined);
  }finally{f.cleanup()}
});
