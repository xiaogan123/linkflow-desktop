import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {BEACON_PUBLISH_URL,BEACON_SEND_OTP_URL,BEACON_SITES_URL,BEACON_VERIFY_OTP_URL,beaconPublicUrl,beaconSiteUrl,type BeaconApiKeyReceipt} from '../src/integrations/beacon';
import {runBeaconTask} from '../src/integrations/beacon-publisher';
import {withBeaconPersistence} from '../src/integrations/publishers';
import {ARTICLE_REVIEW_CONTRACT_VERSION,articleContentHash,articleReviewBindingHash} from '../src/main/article-review';
import {beaconTaskIdentity,beaconTaskSlug,saveVerifiedBeaconAccount} from '../src/main/beacon-publication';
import {requestBeaconCode} from '../src/main/beacon-email';
import {Controller} from '../src/main/controller';
import {emptyState,Store} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import type {Channel,ExecutionContext,Mailbox,Site,Task} from '../src/shared/types';

const at='2026-10-20T08:00:00.000Z',taskId='81111111-1111-4111-8111-111111111111',siteId='82222222-2222-4222-8222-222222222222',accountId='83333333-3333-4333-8333-333333333333';
// Publishing only happens 09:00-23:00 local time; run in a zone where the real clock is near midday.
function middayTimeZone(){const offset=12-new Date().getUTCHours();return offset===0?'Etc/GMT':offset>0?`Etc/GMT-${offset}`:`Etc/GMT+${-offset}`}
const email='controller-owner@example.com',apiKey=`chk_controller_${'a'.repeat(24)}`,target='https://controller.example.com/releases';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const channel={id:'beacon',name:'Beacon',domain:'beacon.host',url:'https://beacon.host',submitUrl:BEACON_PUBLISH_URL,categories:['software'],languages:['en'],kind:'article',emailRequired:true,accountRequired:true,articleRequired:true,free:'yes',freeNote:'fixture',automation:'api',quality:'B',qualityReason:'fixture',provenance:'built-in',evidenceStatus:'source_checked',rulesUrl:'https://beacon.host/terms',checkedAt:at,notes:'fixture',allowedHosts:['beacon.host'],enabled:true,requirements:['software','developer'],termsCache:{version:1,reviewVersion:2,channelId:'beacon',sourceHash:'1'.repeat(64),conclusionHash:'2'.repeat(64),checkedAt:at,summary:'fixture',finance:'allowed',promotion:'allowed',disclosurePlacement:'unknown',sources:[]}} as Channel;
const site={id:siteId,domain:'controller.example.com',url:'https://controller.example.com/',email:'editor@controller.example.com',name:'Controller Documentation',description:'Independent software documentation.',category:'software',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:at,topics:[{url:target,discoveredAt:at}],qualifications:{software:target,developer:target}} as Site;
const draft={title:'Keep one durable publication transaction',description:'A bounded recovery walkthrough.',body:`Persist one intent before the remote write, then use bounded reads for recovery.\n\nSee the [release notes](${target}) for the tested behavior.`};

function task():Task{return {id:taskId,siteId,channelId:'beacon',accountId,sourceDomain:'beacon.host',status:'queued',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'fixture',draft,topicUrl:target,draftRevision:1,articleApprovedAt:at}}
function receipt():BeaconApiKeyReceipt{const codeHash=sha('000000'),requestHash=sha(JSON.stringify({email,codeHash}));return {kind:'verify_otp',operationId:`beacon_${'b'.repeat(32)}`,email,codeHash,requestHash,createdAt:at,apiKeySha256:sha(apiKey),accountId:'controller-remote-owner',accountEmail:email}}
function response(url:string,value:unknown,status=200,type='application/json'){const reply=new Response(typeof value==='string'?value:JSON.stringify(value),{status,headers:{'content-type':type}});Object.defineProperty(reply,'url',{value:url});return reply}

function fixture(){
  const store=new Store(':memory:'),secrets=new Map<string,string>(),path=mkdtempSync(join(tmpdir(),'beacon-controller-'));
  let afterEncrypt:((keys:string[])=>void)|undefined;
  const vault={ready:true,available:()=>true,get:async(key:string)=>secrets.get(key),set:async(key:string,value:string)=>{secrets.set(key,value)},delete:async(key:string)=>{secrets.delete(key)},encryptSecrets:(values:Record<string,string>)=>{for(const [key,value] of Object.entries(values))secrets.set(key,value);afterEncrypt?.(Object.keys(values));return Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))}} as unknown as Vault;
  const state=emptyState(),value=task();state.sites=[site];state.tasks=[value];state.settings.autoRun=true;state.settings.timezone=middayTimeZone();state.settings.articleReviewMode='ai';state.settings.channelOverrides.beacon=true;state.channelTermsCache={beacon:channel.termsCache!};store.update(current=>Object.assign(current,state));
  const controller=new Controller(store,vault,path,{channelCatalog:[channel]});const activeChannel=controller.channels().find(value=>value.id==='beacon')!;
  store.update(current=>{const currentTask=current.tasks[0];currentTask.status='running';currentTask.articleReview={status:'passed',reason:'Fixture review passed.',reasonCode:'passed',reviewContractVersion:ARTICLE_REVIEW_CONTRACT_VERSION,bindingVersion:2,bindingHash:articleReviewBindingHash(currentTask,site,activeChannel),targetUrl:target,termsHash:activeChannel.termsCache!.conclusionHash,checks:{factualAccuracy:'pass',authorRelationship:'pass',affiliateDisclosure:'pass',independentValue:'pass',financialSafety:'pass',channelRules:'pass'},reviewedAt:at,evidenceUrls:[target],draftRevision:1,contentHash:articleContentHash(currentTask),contextHash:articleReviewBindingHash(currentTask,site,activeChannel)}});
  saveVerifiedBeaconAccount(store,vault,{accountId,receipt:receipt(),apiKey,siteIds:[siteId],channel:activeChannel,verifiedAt:at});
  return {store,vault,controller,path,setAfterEncrypt(value:typeof afterEncrypt){afterEncrypt=value},close(){controller.stop();store.close();rmSync(path,{recursive:true,force:true})}};
}

function context(f:ReturnType<typeof fixture>){const current=f.store.read().tasks[0],signal=new AbortController().signal;return withBeaconPersistence((f.controller as unknown as {context(task:Task,signal:AbortSignal):ExecutionContext}).context(current,signal))}
function reads(slug:string,html:string,calls:Array<{method:string;url:string}>){return async(url:string,init:RequestInit)=>{calls.push({method:String(init.method),url});assert.equal(init.method,'GET');if(url===beaconSiteUrl(slug))return response(url,{site:{slug,url:beaconPublicUrl(slug),currentVersionId:'version-controller',expiresAt:null},currentVersion:{id:'version-controller',status:'live'}});if(url===`${BEACON_SITES_URL}?limit=100&offset=0`)return response(url,{data:[{slug,url:beaconPublicUrl(slug),currentVersionId:'version-controller',expiresAt:null}],limit:100,offset:0,totalCount:1});if(url===beaconPublicUrl(slug))return response(url,html,200,'text/html; charset=utf-8');if(url===`${beaconPublicUrl(slug)}robots.txt`)return response(url,'User-agent: *\nAllow: /\n',200,'text/plain');throw Error(`unexpected ${url}`)}}

test('controller rechecks authorization after encrypted intent and before the only POST',async()=>{
  const f=fixture();let calls=0;
  try{
    f.setAfterEncrypt(keys=>{if(keys.includes(`publication:${taskId}`))f.store.update(state=>{state.settings.channelOverrides.beacon=false})});
    const result=await runBeaconTask(context(f),{allowExternalWrite:true,now:()=>new Date(at),fetch:async()=>{calls++;throw Error('POST must remain closed')}});
    const saved=f.store.read().tasks[0];
    assert.equal(result.status,'needs_input');assert.equal(calls,0);assert.equal(saved.beacon?.stage,'submitting');assert.equal(saved.status,'review');assert.equal(saved.submittedAt,saved.beacon?.createdAt);assert.ok(f.store.getCipher(`publication:${taskId}`));
  }finally{f.close()}
});

test('controller-created live verification context remains GET-only',async()=>{
  const f=fixture(),calls:Array<{method:string;url:string}>=[];
  try{
    const initial=f.store.read().tasks[0],slug=beaconTaskSlug(initial,site),article=beaconTaskIdentity(initial,site,slug)!.article,read=reads(slug,article.html,calls);
    const fetch=async(url:string,init:RequestInit)=>{if(init.method==='POST'){calls.push({method:'POST',url});return response(url,{slug,pageUrl:beaconPublicUrl(slug),anonymous:false,expiresAt:null,versionId:'version-controller'},201)}return read(url,init)};
    const published=await runBeaconTask(context(f),{allowExternalWrite:true,now:()=>new Date(at),fetch});
    assert.equal(published.status,'live',JSON.stringify({published,calls}));assert.equal(calls.filter(call=>call.method==='POST').length,1);assert.equal(f.store.read().tasks[0].status,'live');
    calls.length=0;
    const verifying=new Controller(f.store,f.vault,f.path,{channelCatalog:[channel],beaconDependencies:{now:()=>new Date(at),fetch}});
    try{await verifying.verify(taskId);assert.ok(calls.length>=3,JSON.stringify(calls));assert.equal(calls.every(call=>call.method==='GET'),true);assert.equal(f.store.read().tasks[0].health,'healthy')}
    finally{verifying.stop()}
  }finally{f.close()}
});

function mailFixture(host='imap.gmail.com'){
  const store=new Store(':memory:'),path=mkdtempSync(join(tmpdir(),'beacon-mail-controller-')),plain=new Map<string,string>(),mailboxId='84444444-4444-4444-8444-444444444444',secondSiteId='85555555-5555-4555-8555-555555555555',secondTaskId='86666666-6666-4666-8666-666666666666';
  const mailbox:Mailbox={id:mailboxId,label:'Fixture mailbox',host,port:993,user:email,secure:true,hasPassword:true,verifiedAt:at,aliases:[],createdAt:at,updatedAt:at};plain.set(`mailbox:${mailboxId}`,'fixture-mail-password');
  const vault={ready:true,available:()=>true,get:async(key:string)=>plain.get(key),set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>{plain.set(key,value);return [key,`enc:${Buffer.from(value).toString('base64url')}`]}))} as unknown as Vault;
  const first={...site,mailboxId,email:'public-one@controller.example.com'},second:Site={...site,id:secondSiteId,domain:'second-controller.example.com',url:'https://second-controller.example.com/',email:'public-two@second-controller.example.com',mailboxId};
  const pending=(id:string,owner:string):Task=>({id,siteId:owner,channelId:'beacon',sourceDomain:'beacon.host',status:'needs_input',checkpoint:'account_handoff',reasonCode:'account_handoff',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'fixture'});
  const state=emptyState();state.settings.autoRun=true;state.settings.channelOverrides.beacon=true;state.mailboxes=[mailbox];state.settings.timezone=middayTimeZone();state.sites=[first,second];state.tasks=[pending(taskId,siteId),pending(secondTaskId,secondSiteId)];store.update(current=>Object.assign(current,state));
  const mailNow=new Date(),calls:Array<{url:string;method:string}>=[],fetch=async(url:string,init:RequestInit)=>{calls.push({url,method:String(init.method)});if(url===BEACON_SEND_OTP_URL)return response(url,{success:true});if(url===BEACON_VERIFY_OTP_URL)return response(url,{apiKey,account:{id:'controller-remote-owner',email}});throw Error(`unexpected ${url}`)};
  return {store,vault,path,mailboxId,mailNow,calls,fetch,close(controller:Controller){controller.stop();store.close();rmSync(path,{recursive:true,force:true})}};
}

test('controller requests and verifies one mailbox account for its site and never fans it out to another site',async()=>{
  const f=mailFixture(),controller=new Controller(f.store,f.vault,f.path,{channelCatalog:[channel],beaconDependencies:{now:()=>f.mailNow,fetch:f.fetch},scanMail:async()=>({kind:'code',code:'123456',snippet:'Beacon code',messageId:'beacon-controller-code'})});
  try{
    await controller.connectPendingEmailAccounts();let current=f.store.read();assert.equal(current.accounts.length,1);assert.equal(current.tasks.filter(value=>value.checkpoint==='waiting_email').length,1);assert.deepEqual(f.calls,[{url:BEACON_SEND_OTP_URL,method:'POST'}]);
    f.store.update(value=>{value.tasks.find(item=>item.checkpoint==='waiting_email')!.emailWait!.nextPollAt=new Date(0).toISOString()});await (controller as unknown as {emailWaits:{poll():Promise<void>}}).emailWaits.poll();current=f.store.read();assert.equal(current.accounts[0].status,'registered');assert.equal(current.accounts[0].beaconEmail?.stage,'ready');assert.equal(current.accountBindings.length,1);assert.equal(f.calls.filter(value=>value.url===BEACON_VERIFY_OTP_URL).length,1);
    await controller.connectPendingEmailAccounts();current=f.store.read();assert.equal(current.accounts.length,1);assert.equal(current.accountBindings.length,1);assert.equal(current.tasks.filter(value=>value.accountId===current.accounts[0].id).length,1);assert.equal(f.calls.length,2);
  }finally{f.close(controller)}
});

test('unsupported Beacon mailbox and a mailbox changed before send stay handoff-only with zero POST',async()=>{
  const unsupported=mailFixture('imap.fastmail.com'),first=new Controller(unsupported.store,unsupported.vault,unsupported.path,{channelCatalog:[channel],beaconDependencies:{now:()=>unsupported.mailNow,fetch:unsupported.fetch}});
  try{await first.connectPendingEmailAccounts();const state=unsupported.store.read();assert.equal(unsupported.calls.length,0);assert.equal(state.accounts.length,0);assert.equal(state.tasks.every(value=>value.checkpoint==='account_handoff'&&value.message.includes('Gmail')),true)}finally{unsupported.close(first)}
  const changed=mailFixture(),second=new Controller(changed.store,changed.vault,changed.path,{channelCatalog:[channel],beaconDependencies:{now:()=>changed.mailNow,fetch:changed.fetch},requestMailBeacon:async(store,vault,email,options)=>{changed.store.update(state=>{state.mailboxes[0].host='imap.fastmail.com'});return requestBeaconCode(store,vault,email,options)}});
  try{await second.connectPendingEmailAccounts();await second.connectPendingEmailAccounts();const state=changed.store.read();assert.equal(changed.calls.length,0);assert.equal(state.accounts.length,1);assert.equal(state.accounts[0].beaconEmail?.stage,'send_intent');assert.equal(state.tasks.every(value=>value.checkpoint==='account_handoff'&&!value.emailWait),true)}finally{changed.close(second)}
});
