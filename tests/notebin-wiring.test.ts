import {pinPublicationFixtures} from './helpers/publication-snapshot';
import {fixtureTerms,primeWritingFixtureStore,profileWriterResult} from './writing-fixture';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {marked} from 'marked';
import {CHANNELS} from '../src/integrations/catalog';
import {
  NOTEBIN_CHALLENGE_URL,
  NOTEBIN_IMPLEMENTATION_CONTRACT_SHA256,
  NOTEBIN_KEYS_URL,
  NOTEBIN_NOTES_URL,
  NOTEBIN_ORIGIN,
  NOTEBIN_OWNED_ITEMS_URL,
  NOTEBIN_SIGNUP_URL,
  notebinNoteRequest,
  notebinTokenFingerprint,
  type NotebinRuntimeGate,
} from '../src/integrations/notebin';
import type {NotebinReadContract} from '../src/integrations/notebin-publisher';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {validateBackup} from '../src/main/backup-validation';
import {ARTICLE_REVIEW_CONTRACT_VERSION,articleContentHash,articleContextHash} from '../src/main/article-review';
import {Controller,type ControllerServices} from '../src/main/controller';
import {Store,emptyState} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import type {Account,Site,Task} from '../src/shared/types';
import {hasLegacyPublicIdentityMarker} from '../src/shared/public-identity-policy';
import {connectionOverview} from '../src/ui/channel-connections';

test.beforeEach(context=>(context as import('node:test').TestContext).mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-18T12:17:00.000Z')}));

const createdAt='2026-10-12T06:00:00.000Z';
const siteId='11111111-1111-4111-8111-111111111111';
const taskId='22222222-2222-4222-8222-222222222222';
const bindingId='33333333-3333-4333-8333-333333333333';
const accountId='44444444-4444-4444-8444-444444444444';
const rootAccountId='acct_12345678';
const rootKey='pbca_live_root_key_1234567890';
const noteKey='pbca_live_note_key_0987654321';
const keyId='key_12345678';
const targetUrl='https://example.test/guides/evidence-first-recovery';
const title='Evidence-first recovery for desktop publishing';
const description='A practical way to bind local intent, remote identity, and readback before recording a publication.';
const markdown=`# ${title}\n\nA durable workflow records intent before a write, keeps the opaque response, and treats a public read as separate evidence.\n\nSee the [related desktop software guide](${targetUrl}) for the project-maintainer context and disclosure.`;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const harnessHash='d'.repeat(64);
const gate:NotebinRuntimeGate={version:1,service:'notebin.ca',contractSha256:NOTEBIN_IMPLEMENTATION_CONTRACT_SHA256,sourceHarnessSha256:harnessHash,approvedAt:createdAt,approvedOperations:['signup','mint','publish']};
const readContract:NotebinReadContract={version:1,contractSha256:NOTEBIN_IMPLEMENTATION_CONTRACT_SHA256,sourceHarnessSha256:harnessHash,observedAt:createdAt,publicBodySelector:'main article',scanStateRequired:true,acceptedScanStates:['clean'],maxOwnedPages:2,ownedPageLimit:20,recoveryWindowMs:5*60_000};

function response(value:unknown,status=200,type='application/json'){return new Response(type==='application/json'?JSON.stringify(value):String(value),{status,headers:{'content-type':type}})}

class MemoryVault {
  ready=true;
  values=new Map<string,string>();
  available(){return true}
  async get(key:string){return this.values.get(key)}
  async set(key:string,value:string){this.values.set(key,value)}
  async delete(key:string){this.values.delete(key)}
  encryptSecrets(values:Record<string,string>){return Object.fromEntries(Object.entries(values).map(([key,value])=>{this.values.set(key,value);return [key,`enc:${Buffer.from(value).toString('base64url')}`]}))}
}

function catalog(){return CHANNELS.map(channel=>channel.id==='notebin'?{...channel,enabled:true}:channel)}
function site(id=siteId,url='https://example.test/'):Site{return {id,domain:new URL(url).hostname,url,email:'owner@example.test',name:'Example software',description:'Developer software',category:'software',language:'en',monthlyTarget:1,articleReviewMode:'manual',qualifications:{software:`${url}product`,developer:targetUrl},status:'ready',createdAt,analyzedAt:createdAt,topicsCheckedAt:createdAt,topics:[{url:targetUrl,discoveredAt:createdAt}]}}
function task(id=taskId,ownerSiteId=siteId):Task{return {id,siteId:ownerSiteId,channelId:'notebin',sourceDomain:'notebin.ca',status:'queued',createdAt,scheduledAt:new Date(Date.now()-60_000).toISOString(),updatedAt:createdAt,attempts:0,message:'fixture',topicUrl:targetUrl,draft:{title,description,body:markdown},draftRevision:1,articleApprovedAt:createdAt,health:'pending'}}
function initialState(){const state=emptyState(),channels=catalog();state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='manual';state.settings.timezone='UTC';state.settings.channelOverrides=Object.fromEntries(channels.map(channel=>[channel.id,channel.id==='notebin']));state.sites=[site()];state.tasks=[task()];return state}
function openFixture(prefix:string){const directory=mkdtempSync(join(tmpdir(),prefix)),store=new Store(join(directory,'state.sqlite')),vault=new MemoryVault();store.update(state=>Object.assign(state,initialState()));return {directory,store,vault,vaultType:vault as unknown as Vault}}

interface SavedItem {id:string;title:string;description:string;markdown:string;createdAt:number}
function notebinNetwork(options:{mintExact?:boolean}={}){
  const calls:string[]=[],items=new Map<string,SavedItem>();let signupPosts=0,mintPosts=0,notePosts=0,sequence=0;
  const item=(saved:SavedItem,full=false)=>({id:saved.id,kind:'note',title:saved.title,description:saved.description,visibility:'public',content_type:'text/markdown',size_bytes:Buffer.byteLength(saved.markdown),created_at:saved.createdAt,expires_at:null,views:0,url:`${NOTEBIN_ORIGIN}/api/v1/items/${saved.id}`,view_url:`${NOTEBIN_ORIGIN}/n/${saved.id}`,raw_url:`${NOTEBIN_ORIGIN}/raw/${saved.id}`,...(full?{markdown:saved.markdown,scan_state:'clean'}:{})});
  const fetch:NonNullable<ControllerServices['notebinDependencies']>['fetch']=async(url,init)=>{
    const method=init.method??'GET';calls.push(`${method} ${url}`);
    if(url===NOTEBIN_CHALLENGE_URL){assert.equal(method,'GET');return response({challenge_id:'challenge_12345678',prefix:'controller-test-',difficulty_bits:1,expires_at:Date.now()+60_000,hint:'sha256(prefix + decimal nonce)'})}
    if(url===NOTEBIN_SIGNUP_URL){assert.equal(method,'POST');signupPosts++;const body=JSON.parse(String(init.body));assert.deepEqual(Object.keys(body).sort(),['challenge_id','display_name','nonce']);return response({account_id:rootAccountId,api_key:rootKey})}
    if(url===NOTEBIN_KEYS_URL){assert.equal(method,'POST');mintPosts++;assert.equal((init.headers as Record<string,string>).authorization,`Bearer ${rootKey}`);assert.deepEqual(JSON.parse(String(init.body)),{audience:NOTEBIN_ORIGIN,scopes:['note:read','note:create']});return response({id:keyId,prefix:'pbca_live_note',created_at:Date.now(),token:noteKey,...(options.mintExact===false?{}:{scopes:['note:read','note:create'],audience:NOTEBIN_ORIGIN})})}
    if(url===NOTEBIN_NOTES_URL){assert.equal(method,'POST');notePosts++;assert.equal((init.headers as Record<string,string>).authorization,`Bearer ${noteKey}`);const body=JSON.parse(String(init.body));assert.equal(body.visibility,'public');assert.equal(typeof body.title,'string');assert.equal(typeof body.description,'string');assert.equal(typeof body.markdown,'string');assert.deepEqual(Object.keys(body).sort(),['description','markdown','title','visibility']);const saved={id:`note12345${++sequence}`,title:body.title,description:body.description,markdown:body.markdown,createdAt:Date.now()};items.set(saved.id,saved);return response(item(saved))}
    if(url.startsWith(`${NOTEBIN_ORIGIN}/api/v1/items/`)){assert.equal(method,'GET');assert.equal((init.headers as Record<string,string>).authorization,`Bearer ${noteKey}`);const saved=items.get(url.slice(url.lastIndexOf('/')+1));if(!saved)return response({error:'missing'},404);return response(item(saved,true))}
    if(url.startsWith(NOTEBIN_OWNED_ITEMS_URL)){assert.equal(method,'GET');assert.equal((init.headers as Record<string,string>).authorization,`Bearer ${noteKey}`);const query=new URL(url).searchParams.get('q'),matches=[...items.values()].filter(value=>value.title===query).map(value=>item(value));return response({items:matches,next_cursor:null})}
    if(url.startsWith(`${NOTEBIN_ORIGIN}/n/`)){assert.equal(method,'GET');assert.equal((init.headers as Record<string,string>).authorization,undefined);const saved=items.get(url.slice(url.lastIndexOf('/')+1));if(!saved)return response('missing',404,'text/plain');const article=marked.parse(saved.markdown,{async:false,gfm:true});return response(`<!doctype html><html><head><meta name="robots" content="index,follow"><link rel="canonical" href="${url}"></head><body><main><article>${article}</article></main></body></html>`,200,'text/html')}
    if(url===`${NOTEBIN_ORIGIN}/robots.txt`){assert.equal(method,'GET');assert.equal((init.headers as Record<string,string>).authorization,undefined);return response('User-agent: *\nAllow: /\nDisallow: /api/',200,'text/plain')}
    throw Error(`unexpected ${method} ${url}`);
  };
  return {fetch,calls,items,get signupPosts(){return signupPosts},get mintPosts(){return mintPosts},get notePosts(){return notePosts}};
}

function services(network:ReturnType<typeof notebinNetwork>):ControllerServices{return {
  channelCatalog:catalog(),
  notebinDependencies:{fetch:network.fetch,gate,readContract,pow:{maxDifficultyBits:4,maxAttempts:10_000,maxMs:1_000,yieldEvery:64},timeoutMs:2_000},
  notebinRootReadback:async input=>({localAccountId:input.localAccountId,rootAccountId:input.rootAccountId,rootKeyFingerprint:notebinTokenFingerprint(input.rootApiKey),whoamiResponseHash:'a'.repeat(64),verifiedAt:new Date().toISOString(),binding:'exact_readback'}),
  notebinNoteReadback:async input=>({localAccountId:input.localAccountId,rootAccountId:input.rootAccountId,tokenFingerprint:notebinTokenFingerprint(input.noteApiKey),keyId,audience:NOTEBIN_ORIGIN,scopes:['note:read','note:create'],keyListResponseHash:'b'.repeat(64),noteReadResponseHash:'c'.repeat(64),verifiedAt:new Date().toISOString(),binding:'exact_readback'}),
}}

function backupSecrets(vault:MemoryVault,account:string,publicationTasks:string|readonly string[]=taskId){const tasks=Array.isArray(publicationTasks)?publicationTasks:[publicationTasks];return Object.fromEntries([
  `notebin:identity:${account}:signup`,
  `notebin:identity:${account}:mint`,
  `notebin:identity:${account}:mint:readback`,
  ...tasks.map(value=>`publication:${value}`),
].flatMap(key=>vault.values.has(key)?[[key,vault.values.get(key)!]]:[]))}

test('catalog stays disabled and a missing native gate is zero-transport in the normal Controller',async()=>{
  assert.equal(CHANNELS.find(channel=>channel.id==='notebin')?.enabled,false);
  const {directory,store,vaultType}=openFixture('notebin-gate-');let calls=0;const controller=new Controller(pinPublicationFixtures(store),vaultType,'isolated',{channelCatalog:catalog(),notebinDependencies:{fetch:async()=>{calls++;throw Error('network forbidden')}}});controller.runtime.aiReady=true;
  try{await controller.tick();const saved=store.read().tasks[0];assert.equal(calls,0);assert.equal(saved.status,'needs_input');assert.equal(saved.checkpoint,'notebin_runtime_gate');assert.equal(store.read().accounts.length,0);assert.equal(saved.notebin,undefined);assert.equal(saved.notebinJournal,undefined)}finally{controller.stop();store.close();rmSync(directory,{recursive:true,force:true})}
});

test('Notebin signup uses the sanitized persisted identity when a site name contains the old tool marker',async()=>{
  const {directory,store,vaultType}=openFixture('notebin-neutral-name-'),network=notebinNetwork();
  store.update(state=>{state.sites[0].name='Linkflow Research Guides'});
  const config=services(network),fetch=config.notebinDependencies!.fetch!;
  let submittedDisplayName:string|undefined;
  config.notebinDependencies!.fetch=async(url,init)=>{
    if(url===NOTEBIN_SIGNUP_URL)submittedDisplayName=(JSON.parse(String(init.body)) as {display_name:string}).display_name;
    return fetch(url,init);
  };
  const controller=new Controller(pinPublicationFixtures(store),vaultType,'isolated',config);controller.runtime.aiReady=true;
  try{
    await controller.tick();
    const saved=store.read(),account=saved.accounts[0];
    assert.ok(account);
    assert.equal(network.signupPosts,1);
    assert.equal(submittedDisplayName,account.displayName);
    assert.equal(account.ownerSiteId,siteId);
    assert.doesNotMatch(account.displayName!,/linkflow/i);
    assert.equal(hasLegacyPublicIdentityMarker(account),false);
  }finally{controller.stop();store.close();rmSync(directory,{recursive:true,force:true})}
});

test('draft generation states the Notebin Markdown boundary and rejects raw HTML before review or transport',async()=>{
  const {directory,store,vaultType}=openFixture('notebin-draft-');store.update(state=>{state.tasks[0].draft=undefined;state.tasks[0].draftRevision=0;state.tasks[0].articleApprovedAt=undefined});let prompt='',aiCalls=0,publicReads=0;
  primeWritingFixtureStore(store);
  const controller=new Controller(pinPublicationFixtures(store),vaultType,'isolated',{channelCatalog:catalog(),prepareChannelTerms:async channel=>fixtureTerms(channel),collectArticleEvidence:async()=>[],readTopicEvidence:async(_site,url)=>{publicReads++;return {url,title:'Recovery guide',text:'Public evidence for a bounded recovery workflow.',contentHash:'e'.repeat(64)}},aiFactory:(()=>({json:async(value:string)=>{aiCalls++;prompt=value;return {title,description,facts:[],body:`# ${title}\n\n<script>alert(1)</script>\n\nSee the [related guide](${targetUrl}).`}}})) as never});controller.runtime.aiReady=true;
  try{await assert.rejects(controller.generateDraft(taskId),{code:'format_repair_exhausted'});assert.equal(aiCalls,2);assert.equal(publicReads,1);assert.match(prompt,/title与description为纯文字/);assert.match(prompt,/正文不得添加任何网址或链接/);assert.match(prompt,/facts/);assert.equal(store.read().tasks[0].draft,undefined);assert.equal(store.read().tasks[0].formatRepairFailures,2)}finally{controller.stop();store.close();rmSync(directory,{recursive:true,force:true})}
});

test('normal Controller creates one identity and note, restores without replay, and prevents cross-site identity reuse',async()=>{
  const {directory,store,vault,vaultType}=openFixture('notebin-controller-'),network=notebinNetwork(),controller=new Controller(pinPublicationFixtures(store),vaultType,'isolated',services(network));controller.runtime.aiReady=true;
  try{
    await controller.tick();const state=store.read(),saved=state.tasks[0],account=state.accounts[0],binding=state.accountBindings.find(value=>value.channelId==='notebin');
    assert.deepEqual({signup:network.signupPosts,mint:network.mintPosts,note:network.notePosts},{signup:1,mint:1,note:1});
    assert.equal(account.status,'registered');assert.equal(account.registrationAttempts,1);assert.equal(account.notebin?.audience,NOTEBIN_ORIGIN);assert.deepEqual(account.notebin?.scopes,['note:read','note:create']);assert.equal(binding?.accountId,account.id);assert.equal(saved.accountId,account.id);
    const connection=connectionOverview(controller.snapshot()).find(value=>value.id==='notebin');assert.equal(connection?.state,'connected');assert.equal(connection?.connectedCount,1);assert.equal(connection?.boundSiteCount,1);
    assert.equal(saved.status,'live',JSON.stringify(saved));assert.equal(saved.health,'healthy');assert.equal(saved.linkCheck,'found');assert.equal(saved.notebin?.stage,'owned');assert.equal(saved.notebin?.ownership,'owned_list_match');assert.equal(saved.notebin?.expiresAt,null);assert.ok(saved.firstLiveAt);assert.ok(vault.values.get(`publication:${saved.id}`));
    assert.equal(JSON.stringify(state).includes(rootKey),false);assert.equal(JSON.stringify(state).includes(noteKey),false);assert.doesNotThrow(()=>validateBackup({state,secrets:backupSecrets(vault,account.id)}));
    assert.ok(Number.isSafeInteger(account.notebinJournal?.signup?.challenge?.expiresAt));
    for(const invalidExpiry of [-1,1.5,Number.MAX_SAFE_INTEGER+1,'soon',null]){const invalid=structuredClone(state);(invalid.accounts[0].notebinJournal!.signup!.challenge as unknown as Record<string,unknown>).expiresAt=invalidExpiry;assert.throws(()=>validateBackup({state:invalid,secrets:backupSecrets(vault,account.id)}));}
    const settledUnbound=structuredClone(state);settledUnbound.accountBindings=[];assert.doesNotThrow(()=>validateBackup({state:settledUnbound,secrets:backupSecrets(vault,account.id)}));const degraded=structuredClone(settledUnbound);Object.assign(degraded.tasks[0],{status:'live',health:'unknown',linkCheck:'unreachable'});assert.doesNotThrow(()=>validateBackup({state:degraded,secrets:backupSecrets(vault,account.id)}));const lost=structuredClone(settledUnbound);Object.assign(lost.tasks[0],{status:'needs_input',health:'missing',linkCheck:'absent',lostAt:lost.tasks[0].lastCheckedAt,consecutiveMissing:1});assert.doesNotThrow(()=>validateBackup({state:lost,secrets:backupSecrets(vault,account.id)}));for(const terminal of ['skipped','expired'] as const){const terminalState=structuredClone(lost);terminalState.tasks[0].status=terminal;assert.doesNotThrow(()=>validateBackup({state:terminalState,secrets:backupSecrets(vault,account.id)}))}
    const predated=structuredClone(settledUnbound);Object.assign(predated.tasks[0],{firstLiveAt:'2000-01-01T00:00:00.000Z',verifiedAt:'2000-01-01T00:01:00.000Z',lastCheckedAt:'2000-01-01T00:02:00.000Z',nextCheckAt:'2000-01-01T00:03:00.000Z'});assert.throws(()=>validateBackup({state:predated,secrets:backupSecrets(vault,account.id)}),/Notebin/);const reversed=structuredClone(settledUnbound);reversed.tasks[0].lastCheckedAt=reversed.tasks[0].firstLiveAt;reversed.tasks[0].verifiedAt=reversed.tasks[0].nextCheckAt;assert.throws(()=>validateBackup({state:reversed,secrets:backupSecrets(vault,account.id)}),/Notebin/);
    const crossed=structuredClone(state);crossed.tasks[0].notebinJournal!.rootAccountId='acct_crossed1';assert.throws(()=>validateBackup({state:crossed,secrets:backupSecrets(vault,account.id)}),/Notebin/);
    const before=network.calls.length;controller.stop();const restarted=new Controller(pinPublicationFixtures(store),vaultType,'isolated',services(network));restarted.runtime.aiReady=true;await restarted.tick();restarted.stop();assert.equal(network.signupPosts,1);assert.equal(network.mintPosts,1);assert.equal(network.notePosts,1);assert.equal(network.calls.length,before);
    assert.equal(channelExecutionReadiness(store.read(),siteId,catalog().find(value=>value.id==='notebin')!,account.id).kind,'ready');

    const firstTaskBefore=structuredClone(store.read().tasks.find(value=>value.id===taskId)!),accountBefore=structuredClone(store.read().accounts.find(value=>value.id===account.id)!);
    const secondSiteId='55555555-5555-4555-8555-555555555555',secondTaskId='66666666-6666-4666-8666-666666666666',secondTarget='https://second.example.test/guides/local-recovery',secondTitle='Local recovery without replaying remote writes',secondMarkdown=`# ${secondTitle}\n\nKeep the original response and use bounded reads before deciding whether a write needs attention.\n\nSee the [maintainer recovery guide](${secondTarget}) for the related project context.`;
    store.update(current=>{current.sites.push({...site(secondSiteId,'https://second.example.test/'),qualifications:{software:'https://second.example.test/product',developer:secondTarget},topics:[{url:secondTarget,discoveredAt:createdAt}]});current.tasks.push({...task(secondTaskId,secondSiteId),topicUrl:secondTarget,draft:{title:secondTitle,description,body:secondMarkdown}})});
    await controller.tick();const isolated=store.read(),second=isolated.tasks.find(value=>value.id===secondTaskId)!;assert.equal(network.signupPosts,1);assert.equal(network.mintPosts,1);assert.equal(network.notePosts,1);assert.equal(second.accountId,undefined);assert.equal(isolated.accountBindings.find(value=>value.siteId===secondSiteId&&value.channelId==='notebin'),undefined);assert.equal(second.status,'needs_input');assert.equal(second.checkpoint,'account_handoff');assert.equal(second.notebin,undefined);assert.deepEqual(isolated.tasks.find(value=>value.id===taskId),firstTaskBefore);assert.deepEqual(isolated.accounts.find(value=>value.id===account.id),accountBefore);assert.doesNotThrow(()=>validateBackup({state:isolated,secrets:backupSecrets(vault,account.id,[taskId])}));
  }finally{controller.stop();store.close();rmSync(directory,{recursive:true,force:true})}
});

for(const priorApproval of [undefined,createdAt])test(`normal AI-mode Controller persists current independent review before Notebin publication (prior approval: ${priorApproval?'present':'absent'})`,async()=>{
  const {directory,store,vault,vaultType}=openFixture('notebin-ai-review-'),network=notebinNetwork();let reviews=0;
  store.update(state=>{state.settings.articleReviewMode='ai';state.sites[0].articleReviewMode='ai';state.tasks[0].articleApprovedAt=priorApproval});
  const controller=new Controller(pinPublicationFixtures(store),vaultType,'isolated',{...services(network),reviewArticle:async(current,currentSite,channel,settings,_ai,_signal,options)=>{
    reviews++;assert.equal(current.articleApprovedAt,priorApproval);assert.equal(network.notePosts,0);assert.equal(store.read().accounts[0].status,'registered');
    return {status:'passed',reasonCode:'passed',reason:'Independent exact fixture review',reviewContractVersion:ARTICLE_REVIEW_CONTRACT_VERSION,reviewedAt:new Date().toISOString(),draftRevision:current.draftRevision??0,contentHash:articleContentHash(current),contextHash:articleContextHash(currentSite,channel,settings,options?.account),evidenceUrls:[targetUrl,'https://notebin.ca/terms'],checks:{factualAccuracy:'pass',authorRelationship:'pass',affiliateDisclosure:'pass',independentValue:'pass',financialSafety:'pass',channelRules:'pass'}};
  }});controller.runtime.aiReady=true;
  try{
    await controller.tick();const state=store.read(),saved=state.tasks[0];assert.equal(reviews,1);assert.equal(network.signupPosts,1);assert.equal(network.mintPosts,1);assert.equal(network.notePosts,1,saved.message);assert.equal(saved.status,'live');assert.equal(saved.notebinJournal?.stage,'owned');assert.equal(saved.articleApprovedAt,saved.articleReview?.reviewedAt);assert.equal(saved.articleReview?.status,'passed');assert.equal(saved.notebinJournal?.approval.approvedAt,saved.articleReview?.reviewedAt);assert.equal(saved.notebinJournal?.approval.reviewer,'ai-review');assert.doesNotThrow(()=>validateBackup({state,secrets:backupSecrets(vault,state.accounts[0].id)}));
  }finally{controller.stop();store.close();rmSync(directory,{recursive:true,force:true})}
});

test('restart finishes a saved key readback after the account-proof checkpoint fails without another identity POST',async()=>{
  const {directory,store,vault,vaultType}=openFixture('notebin-key-projection-'),network=notebinNetwork({mintExact:false}),controller=new Controller(pinPublicationFixtures(store),vaultType,'isolated',services(network));controller.runtime.aiReady=true;const originalUpdate=store.update.bind(store);let rejected=false;
  store.update=mutator=>{if(!rejected){const before=store.read(),preview=structuredClone(before);mutator(preview);if(!before.accounts.some(value=>value.notebin)&&preview.accounts.some(value=>value.notebin)){rejected=true;throw Error('synthetic account-proof checkpoint failure')}}originalUpdate(mutator)};
  try{
    await controller.tick();const pending=store.read(),account=pending.accounts[0];assert.equal(rejected,true);assert.equal(account.notebin,undefined);assert.equal(account.notebinJournal?.mint?.stage,'ready');assert.equal(account.notebinJournal?.mint?.receipt?.binding,'exact_readback');assert.deepEqual({signup:network.signupPosts,mint:network.mintPosts,note:network.notePosts},{signup:1,mint:1,note:0});
    controller.stop();store.update=originalUpdate;const restarted=new Controller(pinPublicationFixtures(store),vaultType,'isolated',services(network));restarted.runtime.aiReady=true;restarted.patch(taskId,{status:'queued',attempts:0,scheduledAt:new Date(Date.now()-1000).toISOString(),message:'resume original identity'});await restarted.tick();restarted.stop();const recovered=store.read(),saved=recovered.tasks[0],verified=recovered.accounts[0];assert.deepEqual({signup:network.signupPosts,mint:network.mintPosts,note:network.notePosts},{signup:1,mint:1,note:1});assert.equal(saved.status,'live');assert.equal(verified.notebin?.keyBinding,'exact_readback');assert.equal(verified.notebin?.keyListResponseHash,verified.notebinJournal?.mint?.receipt?.readbackResponseHash);assert.doesNotThrow(()=>validateBackup({state:recovered,secrets:backupSecrets(vault,verified.id)}));
  }finally{controller.stop();store.update=originalUpdate;store.close();rmSync(directory,{recursive:true,force:true})}
});

test('normal Controller preserves paused and terminal pre-first-live histories and resumes with GET only',async()=>{
  const {directory,store,vault,vaultType}=openFixture('notebin-paused-'),network=notebinNetwork(),controller=new Controller(pinPublicationFixtures(store),vaultType,'isolated',services(network));controller.runtime.aiReady=true;
  try{
    let paused=false;const update=store.update.bind(store);store.update=(mutator)=>{update(mutator);const current=store.read().tasks[0];if(!paused&&current.notebinJournal?.stage==='owned'&&!current.firstLiveAt){paused=true;controller.pause()}};
    await controller.tick();const pausedState=store.read(),pausedTask=pausedState.tasks[0],account=pausedState.accounts[0],secrets=backupSecrets(vault,account.id);
    assert.equal(paused,true);assert.equal(network.notePosts,1);assert.equal(pausedState.settings.autoRun,false);assert.equal(pausedTask.status,'needs_input');assert.equal(pausedTask.health,'pending');assert.equal(pausedTask.notebin?.stage,'owned');assert.equal(pausedTask.firstLiveAt,undefined);assert.equal(pausedTask.linkCheck,undefined);assert.doesNotThrow(()=>validateBackup({state:pausedState,secrets}));assert.throws(()=>controller.deleteSite(siteId),/永久提交信息|核对返回记录/);
    for(const status of ['skipped','expired'] as const){store.update(current=>Object.assign(current,structuredClone(pausedState)));store.update(current=>{current.settings.autoRun=true;const row=current.tasks[0];row.status=status;row.message=`terminal ${status}`});const before=network.calls.length;assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets}));await controller.verify(taskId);assert.equal(network.calls.length,before);assert.equal(store.read().tasks[0].status,status);assert.equal(store.read().tasks[0].message,`terminal ${status}`)}
    store.update(current=>Object.assign(current,structuredClone(pausedState)));store.update(current=>{current.settings.autoRun=true});const calls=network.calls.length,posts=network.notePosts;await controller.verify(taskId);const resumed=store.read().tasks[0];assert.equal(network.notePosts,posts);assert.equal(network.calls.length-calls,4);assert.equal(resumed.status,'live');assert.equal(resumed.health,'healthy');assert.equal(resumed.linkCheck,'found');assert.ok(resumed.firstLiveAt);assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets}));
    const unbound=structuredClone(pausedState);unbound.settings.autoRun=true;unbound.accountBindings=[];assert.throws(()=>validateBackup({state:unbound,secrets}),/Notebin/);store.update(current=>Object.assign(current,unbound));const beforeUnbound=network.calls.length;await controller.verify(taskId);assert.equal(network.calls.length,beforeUnbound);assert.equal(store.read().tasks[0].firstLiveAt,undefined);
  }finally{controller.stop();store.close();rmSync(directory,{recursive:true,force:true})}
});

test('opaque signup response is durable and the normal Controller never creates a replacement identity',async()=>{
  const {directory,store,vault,vaultType}=openFixture('notebin-signup-unknown-'),network=notebinNetwork(),base=network.fetch;let signupPosts=0;network.fetch=async(url,init)=>{if(url===NOTEBIN_SIGNUP_URL){signupPosts++;return response({unexpected:'shape'})}return base(url,init)};const controller=new Controller(pinPublicationFixtures(store),vaultType,'isolated',services(network));controller.runtime.aiReady=true;
  try{await controller.tick();await controller.tick();const state=store.read(),saved=state.tasks[0],account=state.accounts[0];assert.equal(signupPosts,1);assert.equal(network.mintPosts,0);assert.equal(network.notePosts,0);assert.equal(state.accounts.length,1);assert.equal(account.status,'unknown');assert.equal(account.registrationAttempts,1);assert.equal(account.notebinJournal?.signup?.stage,'opaque_response');assert.equal(saved.checkpoint,'notebin_account_create_pending');assert.equal(saved.submittedAt,undefined);assert.equal(saved.notebin,undefined);const secrets=backupSecrets(vault,account.id);assert.ok(secrets[`notebin:identity:${account.id}:signup`]);assert.doesNotThrow(()=>validateBackup({state,secrets}));assert.equal(JSON.stringify(state).includes(rootKey),false)}finally{controller.stop();store.close();rmSync(directory,{recursive:true,force:true})}
});

test('API receipt survives failed acceptance and the next Controller pass is GET-only',async()=>{
  const {directory,store,vault,vaultType}=openFixture('notebin-reconcile-'),network=notebinNetwork(),base=network.fetch;let rejectOwner=true;network.fetch=async(url,init)=>{if(rejectOwner&&init.method==='GET'&&url.startsWith(`${NOTEBIN_ORIGIN}/api/v1/items/`)){rejectOwner=false;return response({error:'temporary'},503)}return base(url,init)};const controller=new Controller(pinPublicationFixtures(store),vaultType,'isolated',services(network));controller.runtime.aiReady=true;
  try{
    await controller.tick();const pending=store.read(),saved=pending.tasks[0],account=pending.accounts[0],secrets=backupSecrets(vault,account.id);assert.equal(network.notePosts,1);assert.equal(saved.status,'review');assert.equal(saved.health,'pending');assert.equal(saved.notebin?.stage,'api_receipt');assert.equal(saved.notebinJournal?.stage,'api_receipt');assert.equal(saved.firstLiveAt,undefined);assert.doesNotThrow(()=>validateBackup({state:pending,secrets}));
    store.update(current=>{current.tasks[0].articleApprovedAt='2026-10-12T06:00:01.000Z'});const driftCalls=network.calls.length;await controller.tick();assert.equal(network.calls.length,driftCalls);assert.equal(network.notePosts,1);store.update(current=>Object.assign(current,structuredClone(pending)));
    store.update(current=>{current.settings.autoRun=false});const pausedCalls=network.calls.length;await controller.tick();assert.equal(network.calls.length,pausedCalls);store.update(current=>Object.assign(current,structuredClone(pending)));
    for(const terminal of ['skipped','expired'] as const){store.update(current=>Object.assign(current,structuredClone(pending)));store.update(current=>{current.tasks[0].status=terminal});const before=network.calls.length;await controller.tick();assert.equal(network.calls.length,before);assert.equal(store.read().tasks[0].status,terminal);assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets}))}
    store.update(current=>Object.assign(current,structuredClone(pending)));const before=network.calls.length;await controller.tick();const resumed=store.read().tasks[0],resumeCalls=network.calls.slice(before);assert.ok(resumeCalls.length>=8);assert.ok(resumeCalls.every(value=>value.startsWith('GET ')));assert.equal(network.notePosts,1);assert.equal(resumed.status,'live');assert.equal(resumed.notebin?.stage,'owned');assert.ok(resumed.firstLiveAt);assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets}));
  }finally{controller.stop();store.close();rmSync(directory,{recursive:true,force:true})}
});

test('unknown create response keeps the original opaque body and records independently verifiable GET recovery evidence',async()=>{
  const {directory,store,vault,vaultType}=openFixture('notebin-unknown-response-'),network=notebinNetwork(),base=network.fetch;network.fetch=async(url,init)=>{const result=await base(url,init);return url===NOTEBIN_NOTES_URL?response({accepted:true}):result};const controller=new Controller(pinPublicationFixtures(store),vaultType,'isolated',services(network));controller.runtime.aiReady=true;
  try{
    await controller.tick();const pending=store.read(),pendingTask=pending.tasks[0],account=pending.accounts[0],opaque=vault.values.get(`publication:${taskId}`);assert.equal(network.notePosts,1);assert.equal(pendingTask.notebinJournal?.stage,'opaque_response');assert.equal(pendingTask.notebinJournal?.recovery,undefined);assert.ok(opaque);const captured=JSON.parse(opaque!) as {value:{bodyBase64:string}};assert.equal(Buffer.from(captured.value.bodyBase64,'base64').toString(),JSON.stringify({accepted:true}));
    const before=network.calls.length;await controller.tick();const recovered=store.read(),saved=recovered.tasks[0],proof=saved.notebinJournal?.recovery,calls=network.calls.slice(before);assert.ok(calls.length>=8);assert.ok(calls.every(value=>value.startsWith('GET ')));assert.equal(network.notePosts,1);assert.equal(saved.status,'live');assert.equal(saved.notebinJournal?.stage,'owned');assert.equal(proof?.originalStage,'opaque_response');assert.equal(proof?.provenance,'bounded_owned_list_and_detail');assert.equal(proof?.operationId,saved.notebin?.operationId);assert.equal(proof?.detail.id,saved.notebin?.itemId);assert.equal(vault.values.get(`publication:${taskId}`),opaque);const secrets=backupSecrets(vault,account.id);assert.doesNotThrow(()=>validateBackup({state:recovered,secrets}));
    const tamperedDetail=structuredClone(recovered);tamperedDetail.tasks[0].notebinJournal!.recovery!.detail.markdown+='\nforged';assert.throws(()=>validateBackup({state:tamperedDetail,secrets}),/Notebin/);
    const tamperedMembership=structuredClone(recovered);tamperedMembership.tasks[0].notebinJournal!.recovery!.pages[0].items[0].id='forged123';assert.throws(()=>validateBackup({state:tamperedMembership,secrets}),/Notebin/);
    const tamperedTime=structuredClone(recovered);tamperedTime.tasks[0].notebinJournal!.recovery!.recoveredAt='2000-01-01T00:00:00.000Z';assert.throws(()=>validateBackup({state:tamperedTime,secrets}),/Notebin/);
  }finally{controller.stop();store.close();rmSync(directory,{recursive:true,force:true})}
});

test('transport-unknown create with no body recovers by GET without inventing a publication response',async()=>{
  const {directory,store,vault,vaultType}=openFixture('notebin-transport-unknown-'),network=notebinNetwork(),base=network.fetch;network.fetch=async(url,init)=>{const result=await base(url,init);if(url===NOTEBIN_NOTES_URL)throw Error('connection reset after remote commit');return result};const controller=new Controller(pinPublicationFixtures(store),vaultType,'isolated',services(network));controller.runtime.aiReady=true;
  try{
    await controller.tick();const pending=store.read(),account=pending.accounts[0];assert.equal(network.notePosts,1);assert.equal(pending.tasks[0].notebinJournal?.stage,'intent');assert.equal(vault.values.has(`publication:${taskId}`),false);const before=network.calls.length;await controller.tick();const recovered=store.read(),saved=recovered.tasks[0],proof=saved.notebinJournal?.recovery,calls=network.calls.slice(before);assert.ok(calls.length>=8);assert.ok(calls.every(value=>value.startsWith('GET ')));assert.equal(network.notePosts,1);assert.equal(saved.status,'live');assert.equal(saved.notebinJournal?.stage,'owned');assert.equal(proof?.originalStage,'intent');assert.equal(vault.values.has(`publication:${taskId}`),false);const secrets=backupSecrets(vault,account.id);assert.equal(Object.hasOwn(secrets,`publication:${taskId}`),false);assert.doesNotThrow(()=>validateBackup({state:recovered,secrets}));
    const invented=structuredClone(recovered);invented.tasks[0].notebinJournal!.recovery!.originalStage='opaque_response';assert.throws(()=>validateBackup({state:invented,secrets}),/Notebin/);
  }finally{controller.stop();store.close();rmSync(directory,{recursive:true,force:true})}
});

test('a response arriving after GET recovery is still captured without resetting the live task',async()=>{
  const {directory,store,vault,vaultType}=openFixture('notebin-late-create-'),network=notebinNetwork(),base=network.fetch;let releaseLate:(()=>void)|undefined;network.fetch=async(url,init)=>{if(url!==NOTEBIN_NOTES_URL)return base(url,init);const committed=await base(url,init);return new Promise<Response>(resolve=>{releaseLate=()=>resolve(committed)})};const configured=services(network);configured.notebinDependencies={...configured.notebinDependencies!,timeoutMs:25};const controller=new Controller(pinPublicationFixtures(store),vaultType,'isolated',configured);controller.runtime.aiReady=true;
  try{
    await controller.tick();assert.equal(network.notePosts,1);assert.equal(store.read().tasks[0].notebinJournal?.stage,'intent');await controller.tick();const beforeLate=store.read(),beforeTask=structuredClone(beforeLate.tasks[0]);assert.equal(beforeTask.status,'live');assert.equal(beforeTask.health,'healthy');assert.equal(beforeTask.notebinJournal?.recovery?.originalStage,'intent');releaseLate!();for(let index=0;index<100&&store.read().tasks[0].notebinJournal?.recovery?.originalStage!=='opaque_response';index++)await new Promise(resolve=>setTimeout(resolve,10));const afterLate=store.read(),saved=afterLate.tasks[0],account=afterLate.accounts[0];assert.equal(network.notePosts,1);assert.equal(saved.notebinJournal?.recovery?.originalStage,'opaque_response');assert.ok(vault.values.has(`publication:${taskId}`));assert.equal(saved.status,beforeTask.status);assert.equal(saved.health,beforeTask.health);assert.equal(saved.firstLiveAt,beforeTask.firstLiveAt);assert.equal(saved.verifiedAt,beforeTask.verifiedAt);assert.equal(saved.lastCheckedAt,beforeTask.lastCheckedAt);assert.equal(saved.nextCheckAt,beforeTask.nextCheckAt);assert.doesNotThrow(()=>validateBackup({state:afterLate,secrets:backupSecrets(vault,account.id)}));
  }finally{controller.stop();store.close();rmSync(directory,{recursive:true,force:true})}
});
