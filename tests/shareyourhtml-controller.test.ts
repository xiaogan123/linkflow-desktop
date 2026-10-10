import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {CHANNELS} from '../src/integrations/catalog';
import {renderShareYourHtmlArticle} from '../src/integrations/shareyourhtml-article';
import {ARTICLE_REVIEW_CONTRACT_VERSION,articleContentHash,articleContextHash} from '../src/main/article-review';
import {Controller} from '../src/main/controller';
import {shareYourHtmlDraftHash,shareYourHtmlSiteIdentityHash} from '../src/main/shareyourhtml-publication';
import {Store} from '../src/main/store';
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
function site(id=siteId,domain='example.com'):Site{return {id,domain,url:`https://${domain}/`,email:`owner@${domain}`,name:'Example',description:'Reviewed fixture site.',category:'content',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:stamp,analyzedAt:stamp,topicsCheckedAt:new Date().toISOString(),topics:[{url:topic,title:'Reviewed topic',discoveredAt:stamp}]}}
function task(extra:Partial<Task>={}):Task{return {id:taskId,siteId,channelId:'shareyourhtml',sourceDomain:'shareyourhtml.com',status:'queued',health:'pending',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'Ready',topicUrl:topic,draftRevision:3,draftUpdatedAt:stamp,draft:{title:'Reviewed article title',description:'A useful reviewed description.',body:`## Practical detail\n\nThis exact draft links to the [reviewed topic](${topic}).\n\nUse **careful** comparison.`},...extra}}

async function withChannel<T>(run:(value:Channel)=>Promise<T>):Promise<T>{
  assert.equal(CHANNELS.some(value=>value.id==='shareyourhtml'),false,'production catalog must remain disabled');
  const value=channel();CHANNELS.push(value);
  try{return await run(value)}finally{const index=CHANNELS.indexOf(value);if(index>=0)CHANNELS.splice(index,1)}
}

function vault(store:Store,available=true):Vault{return {ready:available,available:()=>available,get:async(key:string)=>{const value=store.getCipher(key);return value?.startsWith('enc:')?Buffer.from(value.slice(4),'base64url').toString():value},set:async(key:string,value:string)=>store.setCipher(key,value),delete:async(key:string)=>store.deleteCipher(key),encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))} as unknown as Vault}

function fixture(value=task()){
  const directory=mkdtempSync(join(tmpdir(),'linkflow-shareyourhtml-controller-')),path=join(directory,'state.sqlite'),store=new Store(path);
  store.update(state=>{
    state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='ai';state.settings.model='review-model';state.settings.timezone='UTC';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='shareyourhtml']));
    const currentSite=site();state.sites=[currentSite];state.tasks=[value];
    value.articleReview={status:'passed',reason:'Synthetic independently reviewed fixture.',reasonCode:'passed',reviewContractVersion:ARTICLE_REVIEW_CONTRACT_VERSION,checks:{factualAccuracy:'pass',authorRelationship:'pass',affiliateDisclosure:'pass',independentValue:'pass',financialSafety:'pass',channelRules:'pass'},reviewedAt:stamp,evidenceUrls:['https://example.com/','https://shareyourhtml.com/terms'],draftRevision:value.draftRevision??0,contentHash:articleContentHash(value),contextHash:articleContextHash(currentSite,channel(),state.settings)};
  });
  return {directory,path,store,cleanup(){try{store.close()}catch{}rmSync(directory,{recursive:true,force:true})}};
}

function response(){return new Response(JSON.stringify({slug,url:publicUrl,edit_key:editKey}),{status:201,headers:{'content-type':'application/json'}})}

test('Controller submits the exact current reviewed draft once and keeps the API receipt pending',async()=>withChannel(async()=>{
  const f=fixture(),requests:Array<{url:string;body:string}>=[];let genericExecutions=0,genericVerifications=0;
  const controller=new Controller(f.store,vault(f.store),'fixture',{shareYourHtmlDependencies:{fetch:async(url,init)=>{requests.push({url,body:String(init.body)});return response()}},executeTask:async()=>{genericExecutions++;return {status:'failed',message:'must not run'}},verifyLink:async()=>{genericVerifications++;return {found:true,outcome:'found',url:publicUrl,rel:'follow',reason:'must not run'}},shareYourHtmlVerificationDependencies:{now:()=>new Date('2026-10-10T00:00:00.000Z'),fetch:async(url)=>{const body=url.endsWith('/robots.txt')?'User-agent: *\nAllow: /':renderShareYourHtmlArticle({draft:task().draft!,targetUrl:topic,language:'en',slug}).html;const reply=new Response(body,{headers:{'content-type':url.endsWith('/robots.txt')?'text/plain':'text/html'}});Object.defineProperty(reply,'url',{value:url});return reply}}});controller.runtime.aiReady=true;
  try{
    await controller.tick();
    assert.equal(requests.length,1);assert.equal(requests[0].url,'https://shareyourhtml.com/pages');
    const body=JSON.parse(requests[0].body) as {slug:string;html:string;expiry:string};
    const expected=renderShareYourHtmlArticle({draft:task().draft!,targetUrl:topic,language:'en',slug});
    assert.deepEqual(body,{slug,html:expected.html,expiry:'never'});
    const saved=f.store.read().tasks[0];assert.equal(saved.shareYourHtml?.stage,'api_receipt');assert.equal(saved.publicUrl,publicUrl);assert.equal(saved.status,'review');assert.equal(saved.health,'pending');assert.equal(saved.firstLiveAt,undefined);assert.equal(saved.verifiedAt,undefined);assert.equal(saved.nextCheckAt,undefined);assert.match(f.store.getCipher(`publication:${taskId}`)??'',/^enc:/);assert.equal(genericExecutions,0);assert.equal(genericVerifications,0);
    await controller.verify(taskId);assert.equal(genericVerifications,0);assert.equal(f.store.read().tasks[0].status,'live');assert.equal(f.store.read().tasks[0].shareYourHtmlReadback?.status,'visible_match');assert.equal(f.store.read().tasks[0].firstLiveAt,'2026-10-10T00:00:00.000Z');
    const beforeSecondTick=f.store.read().tasks[0];await controller.tick();assert.equal(requests.length,1);assert.equal(genericVerifications,0);assert.deepEqual(f.store.read().tasks[0],beforeSecondTick);
  }finally{f.cleanup()}
}));

test('missing catalog entry, disabled override, and unavailable Vault cannot dispatch',async()=>withChannel(async value=>{
  for(const mode of ['missing','override','vault','review'] as const){
    const f=fixture();let posts=0;let removed=-1;
    try{
      if(mode==='missing'){removed=CHANNELS.indexOf(value);CHANNELS.splice(removed,1)}
      if(mode==='override')f.store.update(state=>{state.settings.channelOverrides.shareyourhtml=false});
      if(mode==='review')f.store.update(state=>{state.tasks[0].articleReview!.checks!.channelRules='unknown'});
      const controller=new Controller(f.store,vault(f.store,mode!=='vault'),'fixture',{shareYourHtmlDependencies:{fetch:async()=>{posts++;return response()}}});controller.runtime.aiReady=true;
      await controller.tick();assert.equal(posts,0);assert.equal(f.store.read().tasks[0].shareYourHtml,undefined);
      if(mode==='vault'){assert.equal(f.store.read().tasks[0].checkpoint,'system_vault_unavailable')}
      if(mode==='review'){assert.equal(f.store.read().tasks[0].status,'needs_input');assert.match(f.store.read().tasks[0].message,/未发送网络请求/)}
    }finally{if(removed>=0)CHANNELS.splice(removed,0,value);f.cleanup()}
  }
}));

test('final Store review, site and authorization revocations after the claim block transport',async()=>withChannel(async()=>{
  const changes:Array<(store:Store)=>void>=[
    store=>store.update(state=>{state.tasks[0].articleReview!.checks!.channelRules='unknown'}),
    store=>store.update(state=>{state.sites[0].status='paused'}),
    store=>store.update(state=>{state.settings.autoRun=false}),
    store=>store.update(state=>{state.settings.channelOverrides.shareyourhtml=false}),
  ];
  for(const change of changes){
    const f=fixture();let posts=0;
    try{
      const controller=new Controller(f.store,vault(f.store),'fixture',{shareYourHtmlDependencies:{fetch:async()=>{posts++;return response()}}});controller.runtime.aiReady=true;
      const running=controller.tick();assert.equal(f.store.read().tasks[0].shareYourHtml?.stage,'submitting');change(f.store);await running;
      const saved=f.store.read().tasks[0];assert.equal(posts,0);assert.equal(saved.shareYourHtml?.stage,'submitting');assert.equal(saved.status,'review');assert.equal(saved.publicUrl,undefined);assert.equal(f.store.getCipher(`publication:${taskId}`),undefined);
    }finally{f.cleanup()}
  }
}));

test('unknown transport survives restart and cannot retry, regenerate, verify, or delete',async()=>withChannel(async()=>{
  const f=fixture();let posts=0,verifications=0;
  try{
    let controller=new Controller(f.store,vault(f.store),'fixture',{shareYourHtmlDependencies:{fetch:async()=>{posts++;throw Error(`raw-${editKey}`)}},verifyLink:async()=>{verifications++;return {found:true,outcome:'found',url:publicUrl,rel:'follow',reason:'must not run'}}});controller.runtime.aiReady=true;
    await controller.tick();assert.equal(posts,1);assert.equal(f.store.read().tasks[0].shareYourHtml?.stage,'submitting');assert.equal(JSON.stringify(f.store.read()).includes(editKey),false);
    await controller.tick();assert.equal(posts,1);await controller.verify(taskId);assert.equal(verifications,0);
    assert.throws(()=>controller.patch(taskId,{status:'queued'}),/ShareYourHTML/);await assert.rejects(controller.generateDraft(taskId),/已有远程发布记录/);assert.throws(()=>controller.deleteSite(siteId),/不能删除/);
    f.store.close();const reopened=new Store(f.path);
    try{controller=new Controller(reopened,vault(reopened),'fixture',{shareYourHtmlDependencies:{fetch:async()=>{posts++;return response()}}});controller.runtime.aiReady=true;await controller.tick();assert.equal(posts,1);assert.equal(reopened.read().tasks[0].shareYourHtml?.stage,'submitting')}finally{reopened.close()}
  }finally{rmSync(f.directory,{recursive:true,force:true})}
}));

test('shared ShareYourHTML cadence defers a second site without claiming or posting',async()=>withChannel(async()=>{
  const f=fixture(),otherSite=site('33333333-3333-4333-8333-333333333333','other.example.com'),priorDraft={title:'Prior',description:'Prior description',body:'Prior safe body.'},createdAt=new Date(Date.now()-3600000).toISOString();
  try{
    f.store.update(state=>{state.sites.push(otherSite);state.tasks.push({id:'44444444-4444-4444-8444-444444444444',siteId:otherSite.id,channelId:'shareyourhtml',sourceDomain:'shareyourhtml.com',status:'review',health:'pending',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'Permanent prior claim',draft:priorDraft,draftRevision:1,submittedAt:createdAt,checkpoint:'shareyourhtml_create_submitting',shareYourHtml:{operationId:'shareyourhtml_44444444444444448444444444444444',slug:'lf-44444444444444448444444444444444',sourceHash:'1'.repeat(64),requestHash:'2'.repeat(64),createdAt,stage:'submitting',requestedExpiry:'never',publicVerification:'pending',reviewedDraftRevision:1,reviewedDraftHash:shareYourHtmlDraftHash(priorDraft),siteId:otherSite.id,siteIdentityHash:shareYourHtmlSiteIdentityHash(otherSite)}})});
    let posts=0;const controller=new Controller(f.store,vault(f.store),'fixture',{shareYourHtmlDependencies:{fetch:async()=>{posts++;return response()}}});controller.runtime.aiReady=true;await controller.tick();
    const current=f.store.read().tasks.find(value=>value.id===taskId)!;assert.equal(posts,0);assert.equal(current.shareYourHtml,undefined);assert.equal(current.status,'queued');assert.ok(Date.parse(current.scheduledAt)>Date.now());assert.match(current.message,/发布间隔/);
  }finally{f.cleanup()}
}));

test('an unclaimed manual ShareYourHTML URL cannot use generic verification or become live',async()=>withChannel(async()=>{
  const f=fixture();let generic=0;
  try{
    const controller=new Controller(f.store,vault(f.store),'fixture',{verifyLink:async()=>{generic++;return {found:true,outcome:'found',url:publicUrl,rel:'follow',reason:'generic backlink only'}}});
    controller.patch(taskId,{publicUrl,status:'needs_input'});await controller.verify(taskId);const saved=f.store.read().tasks[0];assert.equal(generic,0);assert.equal(saved.shareYourHtml,undefined);assert.equal(saved.publicUrl,publicUrl);assert.equal(saved.status,'needs_input');assert.equal(saved.health,'pending');assert.equal(saved.firstLiveAt,undefined);assert.equal(saved.verifiedAt,undefined);assert.match(saved.message,/专用永久回执/);
    await controller.tick();assert.equal(generic,0);assert.equal(f.store.read().tasks[0].status,'needs_input');
  }finally{f.cleanup()}
}));
