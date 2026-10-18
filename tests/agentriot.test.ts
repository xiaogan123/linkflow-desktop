import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CHANNELS} from '../src/integrations/catalog';
import {
  AGENTRIOT_AGENT_DESCRIPTION,AGENTRIOT_AGENT_TAGLINE,agentriotDraftError,agentriotPublisherTesting,
  agentriotTaskIdentity,createAgentRiotReviewedInput,prepareAgentRiotIdentity,reconcileAgentRiotTask,runAgentRiotTask,
} from '../src/integrations/agentriot-publisher';
import {
  AGENTRIOT_PROTOCOL,AGENTRIOT_REGISTER,AGENTRIOT_ROBOTS,AGENTRIOT_SIGNAL_TYPES,
  agentriotHash,agentriotInstallationId,agentriotProfileUrl,agentriotPublicUrl,agentriotRegistrationRequest,
  agentriotUpdateRequest,agentriotUpdatesUrl,parseAgentRiotAgentSummary,parseAgentRiotOpaque,parseAgentRiotProfile,
  parseAgentRiotProtocol,parseAgentRiotRegistration,parseAgentRiotUpdate,parseAgentRiotUpdateReceipt,
  validAgentRiotAccountSecret,validAgentRiotPageSecret,type AgentRiotDependencies,type AgentRiotOpaqueResponse,
  type AgentRiotPersistence,type AgentRiotProfile,type AgentRiotPublicationIntent,type AgentRiotRenderedPage,
  type AgentRiotUpdatePayload,
} from '../src/integrations/agentriot';
import {validateBackup} from '../src/main/backup-validation';
import {Controller} from '../src/main/controller';
import {createAgentRiotPersistence} from '../src/main/agentriot-persistence';
import {ARTICLE_REVIEW_CONTRACT_VERSION,articleContentHash,articleContextHash} from '../src/main/article-review';
import {emptyState,Store} from '../src/main/store';
import {saveTaskDraft} from '../src/main/task-draft';
import type {Vault} from '../src/main/vault';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const at='2026-10-18T00:00:00.000Z';
const taskId='11111111-1111-4111-8111-111111111111';
const siteId='22222222-2222-4222-8222-222222222222';
const accountId='33333333-3333-4333-8333-333333333333';
const agentId='44444444-4444-4444-8444-444444444444';
const updateId='55555555-5555-4555-8555-555555555555';
const agentName='linkflow-3333333333334333';
const updateSlug='bounded-local-recovery-note';
const apiKey='agrt_synthetic_token_1234567890';
const target='https://project.example.test/docs/release';
const rootUrl='https://project.example.test/';
const title='Bounded recovery for a local queue';
const summary='A human-operated assistant prepared this public engineering update from the linked project notes.';
const whatChanged='The local queue now records each intent before dispatch and reconciles an uncertain response without sending the same update twice.';
const publicUrl=agentriotPublicUrl(agentName,updateSlug);
const installationId=agentriotInstallationId(accountId);
const installationIdHash=agentriotHash(installationId);

function channel(enabled=true):Channel{return {...CHANNELS.find(value=>value.id==='agentriot')!,enabled}}
function site():Site{return {id:siteId,domain:'project.example.test',url:rootUrl,email:'owner@project.example.test',name:'Synthetic Queue',description:'Synthetic public developer documentation used only for deterministic tests.',category:'software',language:'en',monthlyTarget:1,articleReviewMode:'manual',qualifications:{software:rootUrl,developer:rootUrl},status:'ready',createdAt:at,analyzedAt:at,topics:[{url:target,title,discoveredAt:at}],topicsCheckedAt:at}}
function baseTask(extra:Partial<Task>={}):Task{
  const current:Task={id:taskId,siteId,channelId:'agentriot',accountId,sourceDomain:'agentriot.com',status:'running',createdAt:at,scheduledAt:at,updatedAt:at,attempts:1,message:'synthetic fixture',topicUrl:target,draft:{title,description:summary,body:whatChanged},draftRevision:1,articleApprovedAt:at,...extra};
  if(current.draft&&!current.agentriotInput){const input=createAgentRiotReviewedInput(current,site(),{method:'manual',approvedAt:at});if(input)current.agentriotInput=input}
  return current;
}
function protocol(){return {protocolVersion:'2026.05.16',openApiUrl:'/api/openapi',contract:{version:'2026.05.16',minimumSupportedVersion:'2026.05.16',contentRulesVersion:'2026.05.12.deterministic-v1',limits:{update:{title:80,summary:240,whatChanged:500,skillsTools:5,publicLink:2048}},signalTypes:[...AGENTRIOT_SIGNAL_TYPES]}}}
function registrationBody(){return {registrationStatus:'created',agent:{id:agentId,slug:agentName,name:agentName},apiKey}}
function opaque(requestUrl:string,value:unknown,status=201,complete=true):AgentRiotOpaqueResponse{const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value));return {version:1,capturedAt:at,requestUrl,status,contentType:'application/json',responseUrl:requestUrl,redirected:false,responseType:'basic',headers:[['content-type','application/json']],bodyBase64:bytes.toString('base64'),bodySha256:agentriotHash(bytes),bodyComplete:complete}}
function registrationSecret(){const request=agentriotRegistrationRequest(installationId,agentName,AGENTRIOT_AGENT_TAGLINE,AGENTRIOT_AGENT_DESCRIPTION),value={version:1 as const,kind:'agentriot_account' as const,operationId:`agentriot_register_${accountId.replaceAll('-','')}`,requestHash:request.requestHash,installationId,name:agentName,tagline:AGENTRIOT_AGENT_TAGLINE,description:AGENTRIOT_AGENT_DESCRIPTION,createdAt:at,opaqueResponse:opaque(AGENTRIOT_REGISTER,registrationBody()),apiKey};assert.ok(validAgentRiotAccountSecret(value));return value}
function readyAccount():Account{const request=agentriotRegistrationRequest(installationId,agentName,AGENTRIOT_AGENT_TAGLINE,AGENTRIOT_AGENT_DESCRIPTION);return {id:accountId,channelId:'agentriot',email:'',username:agentName,displayName:'LinkFlow human-operated assistant',createdAt:at,updatedAt:at,status:'registered',hasPassword:true,source:'generated',credentialKind:'api_token',registrationAttempts:1,agentriot:{version:1,stage:'ready',operationId:`agentriot_register_${accountId.replaceAll('-','')}`,requestHash:request.requestHash,agentId,agentSlug:agentName,agentName,tagline:AGENTRIOT_AGENT_TAGLINE,description:AGENTRIOT_AGENT_DESCRIPTION,installationIdHash,tokenFingerprint:agentriotHash(apiKey),checkedAt:at}}}
function payload(overrides:Partial<AgentRiotUpdatePayload>={}):AgentRiotUpdatePayload{return {title,summary,whatChanged,signalType:'status',publicLink:target,...overrides}}
function rawUpdate(overrides:Record<string,unknown>={}){return {id:updateId,slug:updateSlug,title,summary,whatChanged,signalType:'status',publicLink:target,skillsTools:[],createdAt:at,updatedAt:at,isFeedVisible:true,visibility:'visible',moderationStatus:'approved',...overrides}}
function rawProfile(updates:unknown[]=[rawUpdate()],overrides:Record<string,unknown>={}){return {profile:{id:agentId,slug:agentName,name:agentName,tagline:AGENTRIOT_AGENT_TAGLINE,description:AGENTRIOT_AGENT_DESCRIPTION,installationIdHash,status:'active',postingStatus:'enabled',lastPostedAt:updates.length?at:null,updates,...overrides}}}
function updateReceipt(){return {update:{id:updateId,slug:updateSlug,title,signalType:'status',createdAt:at}}}
function escapeHtml(value:string){return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')}
function html(overrides:{target?:string;rel?:string;metaRobots?:string;extraHead?:string;changed?:string;outsideTarget?:boolean;duplicateTarget?:boolean}={}){const pageTarget=overrides.target??target,inside=overrides.outsideTarget?'':`<a href="${pageTarget}" rel="${overrides.rel??'nofollow ugc'}">View public link</a>`,outside=overrides.outsideTarget?`<a href="${pageTarget}" rel="${overrides.rel??'nofollow ugc'}">View public link</a>`:'',duplicate=overrides.duplicateTarget?`<a href="${pageTarget}">duplicate</a>`:'';return `<!doctype html><html><head><title>${escapeHtml(title)} — ${agentName} | AgentRiot</title><link rel="canonical" href="${publicUrl}"><meta name="robots" content="${overrides.metaRobots??'index, follow'}">${overrides.extraHead??''}</head><body><main id="main-content"><div class="max-w-4xl"><a href="/agents/${agentName}">Back</a><h1>${escapeHtml(title)}</h1><p>${escapeHtml(summary)}</p><p>Published by ${agentName}</p></div><section><div><h2>What changed</h2><p>${escapeHtml(overrides.changed??whatChanged)}</p><div>${inside}</div></div><div><h2>Skills &amp; Tools</h2><p>Local queue</p></div></section>${outside}${duplicate}</main></body></html>`}
function response(url:string,status:number,value:unknown,type='application/json',headers:Record<string,string>={}){const body=typeof value==='string'?value:JSON.stringify(value),result=new Response(body,{status,headers:{'content-type':type,'content-length':String(Buffer.byteLength(body)),...headers}});Object.defineProperties(result,{url:{value:url},redirected:{value:false},type:{value:'basic'}});return result}
function rendered(overrides:Partial<AgentRiotRenderedPage>={}):AgentRiotRenderedPage{const page=html();return {url:publicUrl,documentTitle:`${title} — ${agentName} | AgentRiot`,title,summary,whatChanged,titleReadableRects:1,summaryReadableRects:1,whatChangedReadableRects:1,publicLinks:[{href:target,rel:['nofollow','ugc'],text:'View public link',readableRects:1}],robots:[{name:'robots',content:'index, follow'}],canonicals:[publicUrl],hasRefresh:false,hasPasswordGate:false,hasLoginGate:false,responseRobots:[],responseLinks:[],responseStatus:200,responseMediaType:'text/html',responseBodyBytes:Buffer.byteLength(page),responseEncodedBodyBytes:Buffer.byteLength(page),nativeRequests:[{url:publicUrl,method:'GET',resourceType:'mainFrame'}],...overrides}}
function parsedProfile(updates:unknown[]=[rawUpdate()]):AgentRiotProfile{const value=parseAgentRiotProfile(rawProfile(updates));assert.ok(value);return value}
function fakeVault(store:Store):Vault{return {ready:true,available:()=>true,get:async(name:string)=>{const cipher=store.getCipher(name);return cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():undefined},set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([name,value])=>[name,`enc:${Buffer.from(value).toString('base64url')}`]))} as unknown as Vault}
function readFetch(page=html(),pageHeaders:Record<string,string>={}){return async(url:string,init:RequestInit={})=>{assert.equal((init.method??'GET').toUpperCase(),'GET');if(url===agentriotProfileUrl(agentName))return response(url,200,rawProfile());if(url===publicUrl)return response(url,200,page,'text/html',pageHeaders);if(url===AGENTRIOT_ROBOTS)return response(url,200,'User-agent: *\nAllow: /\nDisallow: /api/\n','text/plain');throw Error(`unexpected GET ${url}`)}}

function memoryContext(fetcher:(url:string,init:RequestInit)=>Promise<Response>){
  const current=baseTask(),account=readyAccount(),secrets=new Map<string,string>([[`account:${accountId}`,JSON.stringify(registrationSecret())]]),events:string[]=[];
  const persistence:AgentRiotPersistence={
    async persistAccountOpaque(){throw Error('ready identity must be reused')},
    async persistPublicationIntent(secret,receipt){assert.equal(secrets.has(`publication:${taskId}`),false);secrets.set(`publication:${taskId}`,JSON.stringify(secret));Object.assign(current,{agentriot:{...receipt},submittedAt:receipt.createdAt,checkpoint:'agentriot_update_submitting'});events.push('intent')},
    async persistPublicationOpaque(secret){secrets.set(`publication:${taskId}`,JSON.stringify(secret));if(current.agentriot)current.agentriot.stage='opaque_response';current.checkpoint='agentriot_update_opaque_response';events.push(secret.opaqueResponse?.bodyComplete?'opaque-complete':'opaque-prefix')},
    async persistRecoveryEvidence(secret){secrets.set(`publication:${taskId}`,JSON.stringify(secret));current.checkpoint='agentriot_get_recovery_evidence_pending';events.push('recovery')},
  };
  const context:ExecutionContext={site:site(),channel:channel(),task:current,settings:emptyState().settings,signal:new AbortController().signal,secrets:{get:async key=>secrets.get(key),set:async(key,value)=>{secrets.set(key,value)},delete:async key=>{secrets.delete(key)}},ai:{} as never,getAccount:()=>account,saveAccount:async()=>{throw Error('ready identity must be reused')},checkpoint:partial=>{Object.assign(current,partial);events.push(String(partial.checkpoint??'checkpoint'))},log:()=>{},authorizeAgentRiotMutation:()=>true,agentriotPersistence:persistence,agentriotDependencies:{fetch:fetcher,now:()=>new Date(at),renderPage:async()=>rendered()}};
  return {context,current,account,secrets,events};
}

function fixtureStore(){const dir=mkdtempSync(join(tmpdir(),'agentriot-')),db=join(dir,'state.sqlite'),store=new Store(db),state=emptyState();state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='manual';state.settings.timezone='UTC';state.settings.channelOverrides={agentriot:true};state.sites=[site()];state.tasks=[baseTask()];state.accounts=[readyAccount()];state.accountBindings=[{id:'77777777-7777-4777-8777-777777777777',siteId,channelId:'agentriot',accountId,createdAt:at,updatedAt:at}];const plain=JSON.stringify(registrationSecret());store.updateWithCiphers(current=>Object.assign(current,state),{[`account:${accountId}`]:`enc:${Buffer.from(plain).toString('base64url')}`});return {dir,db,store,vault:fakeVault(store),cleanup(){try{store.close()}catch{}rmSync(dir,{recursive:true,force:true})}}}

// Contract fixtures are deliberately synthetic. Exact reviewed live content stays
// outside src/tests in the isolated, disabled acceptance package.
test('official .com contract parsers bind strict registration, profile and update envelopes',()=>{
  assert.ok(parseAgentRiotProtocol(protocol()));assert.equal(parseAgentRiotProtocol({...protocol(),openApiUrl:'/wrong'}),undefined);
  assert.deepEqual(parseAgentRiotAgentSummary({agent:{id:agentId,slug:agentName,name:agentName}}),{id:agentId,slug:agentName,name:agentName});
  assert.equal(parseAgentRiotAgentSummary({id:agentId,slug:'x'.repeat(161),name:agentName}),undefined);
  assert.deepEqual(parseAgentRiotRegistration(registrationBody())?.agent,{id:agentId,slug:agentName,name:agentName});
  assert.equal(parseAgentRiotRegistration({...registrationBody(),registrationStatus:'existing'}),undefined);
  assert.ok(parseAgentRiotUpdate(rawUpdate(),agentName));assert.equal(parseAgentRiotUpdate({...rawUpdate(),slug:'x'.repeat(161)},agentName),undefined);
  assert.ok(parseAgentRiotProfile(rawProfile()));assert.ok(parseAgentRiotUpdateReceipt(updateReceipt(),agentName));
  const captured=opaque(agentriotUpdatesUrl(agentName),updateReceipt());assert.deepEqual(parseAgentRiotOpaque(captured,agentriotUpdatesUrl(agentName),201),updateReceipt());
  for(const change of [{bodyComplete:false},{redirected:true},{status:200},{responseUrl:'https://other.example.test/'},{bodySha256:'0'.repeat(64)}])assert.equal(parseAgentRiotOpaque({...captured,...change},agentriotUpdatesUrl(agentName),201),undefined);
});

test('ordinary reviewed input binds the current original draft and is revoked after an edit',()=>{
  const current=baseTask({status:'needs_input',checkpoint:'article_review',agentriotInput:undefined}),input=createAgentRiotReviewedInput(current,site(),{method:'manual',approvedAt:at});assert.ok(input);current.agentriotInput=input;assert.ok(agentriotTaskIdentity(current,site()));assert.equal(agentriotDraftError(current,site()),undefined);
  const state=emptyState();state.sites=[site()];state.tasks=[current];saveTaskDraft(state,current.id,{...current.draft!,body:`${whatChanged} A separately reviewed clarification.`},new Date(at));assert.equal(state.tasks[0].agentriotInput,undefined);assert.equal(state.tasks[0].articleApprovedAt,undefined);assert.equal(agentriotTaskIdentity(state.tasks[0],site()),undefined);
});

test('registration is attempted once and an ambiguous result preserves the same identity without retry',async()=>{
  let account:Account|undefined,secret:string|undefined,posts=0;const current=baseTask({accountId:undefined,agentriotInput:undefined}),persistence:AgentRiotPersistence={persistAccountOpaque:async()=>{},persistPublicationIntent:async()=>{},persistPublicationOpaque:async()=>{},persistRecoveryEvidence:async()=>{}};
  const context:ExecutionContext={site:site(),channel:channel(),task:current,settings:emptyState().settings,signal:new AbortController().signal,secrets:{get:async()=>secret,set:async()=>{},delete:async()=>{}},ai:{} as never,getAccount:()=>account,saveAccount:async(value,password)=>{account=value;current.accountId=value.id;secret=password},checkpoint:()=>{},log:()=>{},authorizeAgentRiotMutation:()=>true,agentriotPersistence:persistence};
  const deps:AgentRiotDependencies={fixedAccountId:accountId,timeoutMs:100,now:()=>new Date(at),fetch:async(url,init)=>{const method=(init.method??'GET').toUpperCase();if(method==='GET'&&url===AGENTRIOT_PROTOCOL)return response(url,200,protocol());if(method==='GET'&&url===agentriotProfileUrl(agentName))return response(url,404,'','application/json');if(method==='POST'&&url===AGENTRIOT_REGISTER){posts++;throw Error('synthetic transport uncertainty')}throw Error(`${method} ${url}`)}};
  const first=await prepareAgentRiotIdentity(context,deps);assert.equal(first?.status,'needs_input');assert.equal(posts,1);assert.equal(account?.id,accountId);assert.ok(secret&&validAgentRiotAccountSecret(JSON.parse(secret)));
  const second=await prepareAgentRiotIdentity(context,{...deps,fetch:async()=>{posts++;throw Error('duplicate registration')}});assert.equal(second?.status,'needs_input');assert.equal(posts,1);assert.equal(account?.id,accountId);
});

test('an unknown update writes one POST, survives restart semantics and reconciles by GET without another POST',async()=>{
  let posts=0;const first=memoryContext(async(url,init)=>{const method=(init.method??'GET').toUpperCase();if(method==='GET'&&url===AGENTRIOT_PROTOCOL)return response(url,200,protocol());if(method==='GET'&&url===agentriotProfileUrl(agentName))return response(url,200,rawProfile([]));if(method==='POST'&&url===agentriotUpdatesUrl(agentName)){posts++;throw Error('synthetic transport uncertainty')}throw Error(`${method} ${url}`)});
  const one=await runAgentRiotTask(first.context);assert.equal(one.status,'review');assert.equal(posts,1);assert.equal(first.current.agentriot?.stage,'submitting');assert.ok(first.secrets.get(`publication:${taskId}`));
  const two=await runAgentRiotTask(first.context);assert.equal(two.status,'review');assert.equal(posts,1);
  first.context.agentriotDependencies={fetch:async(url,init)=>{assert.notEqual((init.method??'GET').toUpperCase(),'POST');return readFetch()(url,init)},now:()=>new Date(at),renderPage:async()=>rendered()};
  const recovered=await reconcileAgentRiotTask(first.context);assert.equal(recovered.status,'found',JSON.stringify(recovered));assert.equal(posts,1);assert.ok(first.events.includes('recovery'));const saved=JSON.parse(first.secrets.get(`publication:${taskId}`)!);assert.ok(saved.recoveryEvidence);assert.equal(saved.recoveryEvidence.candidateCount,1);
});

test('public acceptance keeps rel truthful and rejects structural, indexing and native mismatches',async t=>{
  const update=parseAgentRiotUpdate(rawUpdate(),agentName)!,identity=agentriotTaskIdentity(baseTask(),site())!,account=readyAccount(),profile=parsedProfile();
  const accepted=await agentriotPublisherTesting.acceptUpdate(update,identity,account,at,{fetch:readFetch(),renderPage:async()=>rendered()},profile);assert.equal(accepted,'nofollow ugc');
  const staticCases:Array<{name:string;page:string;headers:Record<string,string>}>=[
    {name:'x-robots none',page:html(),headers:{'x-robots-tag':'NoNe'}},
    {name:'meta noindex',page:html({metaRobots:'noindex, follow'}),headers:{}},
    {name:'target outside changed card',page:html({outsideTarget:true}),headers:{}},
    {name:'duplicate target',page:html({duplicateTarget:true}),headers:{}},
    {name:'changed text mismatch',page:html({changed:'Different text'}),headers:{}},
    {name:'conflicting canonical',page:html({extraHead:'<link rel="canonical" href="https://other.example.test/">'}),headers:{}},
  ];
  for(const item of staticCases)await t.test(item.name,()=>assert.rejects(()=>agentriotPublisherTesting.acceptUpdate(update,identity,account,at,{fetch:readFetch(item.page,item.headers),renderPage:async()=>rendered()},profile)));
  const nativeCases=[rendered({documentTitle:'Wrong title'}),rendered({summaryReadableRects:0}),rendered({publicLinks:[{href:'https://other.example.test/',rel:['ugc'],text:'wrong',readableRects:1}]}),rendered({responseRobots:['none']}),rendered({nativeRequests:[{url:publicUrl,method:'GET',resourceType:'mainFrame'},{url:publicUrl,method:'GET',resourceType:'mainFrame'}]})];
  for(const [index,page] of nativeCases.entries())await t.test(`native mismatch ${index+1}`,()=>assert.rejects(()=>agentriotPublisherTesting.acceptUpdate(update,identity,account,at,{fetch:readFetch(),renderPage:async()=>page},profile)));
});

test('actual Store persistence uses cipher CAS so a stale prefix cannot overwrite a complete receipt',async()=>{
  const f=fixtureStore();try{
    const request=agentriotUpdateRequest(agentName,payload()),intentSecret={version:1 as const,kind:'agentriot_update' as const,operationId:`agentriot_update_${taskId.replaceAll('-','')}`,requestHash:request.requestHash,sourceHash:request.sourceHash,agentSlug:agentName,payload:request.payload,createdAt:at},receipt:AgentRiotPublicationIntent={operationId:intentSecret.operationId,accountId,agentId,agentSlug:agentName,agentName,targetUrl:target,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:at,stage:'submitting'};
    const normal=createAgentRiotPersistence(f.store,f.vault,{taskId,siteId,assertPublicationIntent:()=>true,now:()=>new Date(at)});await normal.persistPublicationIntent(intentSecret,receipt);
    const partial={...intentSecret,opaqueResponse:opaque(agentriotUpdatesUrl(agentName),'prefix',201,false)},complete={...intentSecret,opaqueResponse:opaque(agentriotUpdatesUrl(agentName),updateReceipt())};assert.ok(validAgentRiotPageSecret(partial));assert.ok(validAgentRiotPageSecret(complete));
    let calls=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),racedVault={...f.vault,get:async(key:string)=>{const cipher=f.store.getCipher(key),plain=cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():undefined;calls++;const order=calls;await gate;if(order===1)await new Promise<void>(resolve=>setImmediate(resolve));return plain}} as unknown as Vault,raced=createAgentRiotPersistence(f.store,racedVault,{taskId,siteId,assertPublicationIntent:()=>true,now:()=>new Date(at)}),stale=raced.persistPublicationOpaque(partial),winner=raced.persistPublicationOpaque(complete);while(calls<2)await new Promise<void>(resolve=>setImmediate(resolve));release();const results=await Promise.allSettled([stale,winner]);assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');
    const saved=await f.vault.get(`publication:${taskId}`);assert.ok(saved);const parsed=JSON.parse(saved!);assert.equal(parsed.opaqueResponse.bodyComplete,true);assert.deepEqual(parseAgentRiotOpaque(parsed.opaqueResponse,agentriotUpdatesUrl(agentName),201),updateReceipt());assert.equal(f.store.read().tasks[0].agentriot?.stage,'opaque_response');
    assert.doesNotThrow(()=>validateBackup({state:f.store.read(),secrets:{[`account:${accountId}`]:JSON.stringify(registrationSecret()),[`publication:${taskId}`]:saved!}}));
    f.store.close();const reopened=new Store(f.db);try{assert.equal(reopened.getCipher(`publication:${taskId}`),`enc:${Buffer.from(saved!).toString('base64url')}`);assert.throws(()=>reopened.update(state=>{state.tasks[0].draft!.body+=' changed'}));assert.throws(()=>reopened.updateWithCiphers(()=>{}, {},[`publication:${taskId}`]))}finally{reopened.close()}
  }finally{f.cleanup()}
});

test('ordinary Controller generates and independently reviews a generic project update before one registration and one publish',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'agentriot-ordinary-')),store=new Store(join(dir,'state.sqlite')),state=emptyState();state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='ai';state.settings.timezone='UTC';state.settings.channelOverrides={agentriot:true};const ordinarySite={...site(),articleReviewMode:'ai' as const};state.sites=[ordinarySite];state.tasks=[{id:taskId,siteId,channelId:'agentriot',sourceDomain:'agentriot.com',status:'queued',createdAt:at,scheduledAt:'2026-10-17T00:00:00.000Z',updatedAt:at,attempts:0,message:'ordinary user task',topicUrl:target}];store.update(current=>Object.assign(current,state));const vault=fakeVault(store),remote:{registered:boolean;updates:unknown[]}={registered:false,updates:[]};let registrations=0,publications=0,generated=0,reviews=0;
  const deps:AgentRiotDependencies={fixedAccountId:accountId,now:()=>new Date(at),fetch:async(url,init={})=>{const method=(init.method??'GET').toUpperCase();if(method==='GET'&&url===AGENTRIOT_PROTOCOL)return response(url,200,protocol());if(method==='GET'&&url===agentriotProfileUrl(agentName)){if(!remote.registered)return response(url,404,'','application/json');return response(url,200,rawProfile(remote.updates))}if(method==='POST'&&url===AGENTRIOT_REGISTER){registrations++;assert.deepEqual(JSON.parse(String(init.body)),{installationId,name:agentName,tagline:AGENTRIOT_AGENT_TAGLINE,description:AGENTRIOT_AGENT_DESCRIPTION,softwareName:'LinkFlow'});remote.registered=true;return response(url,201,registrationBody())}if(method==='POST'&&url===agentriotUpdatesUrl(agentName)){publications++;const posted=JSON.parse(String(init.body));assert.deepEqual(posted,payload());remote.updates=[rawUpdate()];return response(url,201,updateReceipt())}if(method==='GET'&&url===publicUrl)return response(url,200,html(),'text/html');if(method==='GET'&&url===AGENTRIOT_ROBOTS)return response(url,200,'User-agent: *\nAllow: /\nDisallow: /api/\n','text/plain');throw Error(`unexpected ${method} ${url}`)},renderPage:async()=>rendered()};
  const controller=new Controller(store,vault,'isolated',{channelCatalog:[channel(true)],agentriotDependencies:deps,
    aiFactory:(()=>({json:async(instruction:string,data:unknown)=>{generated++;assert.match(instruction,/AgentRiot 使用结构化 work update/);assert.equal((data as {topicEvidence:{url:string}}).topicEvidence.url,target);return {title,description:summary,body:whatChanged}}})) as never,
    readTopicEvidence:async(_site,url)=>({url,title:'Synthetic release notes',text:'Public synthetic documentation describing a bounded local queue.',contentHash:agentriotHash(url)}),
    collectArticleEvidence:async(currentSite,currentChannel)=>[{url:currentSite.url,kind:'site',text:'Synthetic public project evidence.',excerpt:'Synthetic public project evidence.'},{url:currentChannel.rulesUrl,kind:'content_policy',text:'Synthetic AgentRiot rules fixture.',excerpt:'Synthetic AgentRiot rules fixture.',appliesTo:currentChannel.id,applicability:'verified'}],
    reviewArticle:async(current,currentSite,currentChannel,settings,_ai,_signal,options)=>{reviews++;assert.ok(options?.account);return {status:'passed',reason:'Independent synthetic review passed the exact final structured update.',reasonCode:'passed',reviewContractVersion:ARTICLE_REVIEW_CONTRACT_VERSION,checks:{factualAccuracy:'pass',authorRelationship:'pass',affiliateDisclosure:'pass',independentValue:'pass',financialSafety:'pass',channelRules:'pass'},reviewedAt:at,evidenceUrls:[current.topicUrl!,currentChannel.rulesUrl],draftRevision:current.draftRevision??0,contentHash:articleContentHash(current),contextHash:articleContextHash(currentSite,currentChannel,settings,options.account)}}
  });controller.runtime.aiReady=true;
  try{await controller.tick();await controller.tick();const saved=store.read(),current=saved.tasks[0],account=saved.accounts[0];assert.equal(generated,1,`generated ${JSON.stringify(saved)}`);assert.equal(reviews,1,`reviews ${JSON.stringify(saved)}`);assert.equal(registrations,1,`registrations ${JSON.stringify(saved)}`);assert.equal(publications,1,`publications ${JSON.stringify(saved)}`);assert.equal(saved.accounts.length,1);assert.equal(saved.accountBindings.length,1);assert.equal(saved.accountBindings[0].accountId,account.id);assert.equal(current.status,'live',JSON.stringify(current));assert.equal(current.draft?.title,title);assert.equal(current.draft?.description,summary);assert.equal(current.draft?.body,whatChanged);assert.equal(current.agentriotInput?.version,2);assert.equal(current.agentriot?.stage,'published');assert.equal(current.publicUrl,publicUrl);assert.equal(JSON.stringify(saved).includes(apiKey),false);assert.ok(agentriotTaskIdentity(current,ordinarySite));const accountPlain=await vault.get(`account:${account.id}`),publicationPlain=await vault.get(`publication:${taskId}`);assert.ok(accountPlain&&publicationPlain);assert.doesNotThrow(()=>validateBackup({state:saved,secrets:{[`account:${account.id}`]:accountPlain!,[`publication:${taskId}`]:publicationPlain!}}))}finally{controller.stop();store.close();rmSync(dir,{recursive:true,force:true})}
});

test('generic registration describes the operator rather than claiming the product maintainer',()=>{
  assert.doesNotMatch(AGENTRIOT_AGENT_TAGLINE,/for (?:the )?LinkFlow/i);
  assert.doesNotMatch(AGENTRIOT_AGENT_DESCRIPTION,/LinkFlow maintainer/i);
  assert.match(AGENTRIOT_AGENT_DESCRIPTION,/configured by its operator/);
});

test('recovering an existing registration preserves its original profile claims',async()=>{
  const tagline='Existing human-operated publishing assistant.';
  const description='An existing operator profile whose identity must not be rewritten on recovery.';
  const request=agentriotRegistrationRequest(installationId,agentName,tagline,description);
  let account:Account={...readyAccount(),status:'unknown',agentriot:{...readyAccount().agentriot!,stage:'opaque_response',requestHash:request.requestHash,tagline,description,agentId:undefined,agentSlug:undefined,tokenFingerprint:undefined}};
  let secret=JSON.stringify({...registrationSecret(),requestHash:request.requestHash,tagline,description,apiKey:undefined});
  let requests=0;
  const context:ExecutionContext={site:site(),channel:channel(),task:baseTask(),settings:emptyState().settings,signal:new AbortController().signal,ai:{} as never,secrets:{get:async()=>secret,set:async()=>{},delete:async()=>{}},getAccount:()=>account,saveAccount:async(value,password)=>{account=value;secret=password!},checkpoint:()=>{},log:()=>{}};
  const result=await prepareAgentRiotIdentity(context,{now:()=>new Date(at),fetch:async(url,init={})=>{
    requests++;assert.equal(init.method??'GET','GET');assert.equal(url,agentriotProfileUrl(agentName));
    return response(url,200,rawProfile([],{tagline,description}));
  }});
  assert.equal(result?.status,'queued');assert.equal(requests,1);
  assert.equal(account.agentriot?.tagline,tagline);assert.equal(account.agentriot?.description,description);
  assert.equal(JSON.parse(secret).tagline,tagline);assert.equal(JSON.parse(secret).apiKey,apiKey);
});

test('durable GET recovery can be backed up before receipt promotion without weakening identity matching',async()=>{
  const m=memoryContext(async(url,init={})=>{
    if((init.method??'GET')==='POST')throw Error('synthetic uncertain submission');
    if(url===AGENTRIOT_PROTOCOL)return response(url,200,protocol());
    if(url===agentriotProfileUrl(agentName))return response(url,200,rawProfile([]));
    throw Error('unexpected transport');
  });
  await runAgentRiotTask(m.context);
  const beforeSecret=m.secrets.get(`publication:${taskId}`)!;
  m.context.agentriotDependencies={fetch:readFetch(),renderPage:async()=>rendered(),now:()=>new Date(at)};
  assert.equal((await reconcileAgentRiotTask(m.context)).status,'found');
  const recovered=JSON.parse(m.secrets.get(`publication:${taskId}`)!);
  const f=fixtureStore();
  try{
    f.store.updateWithCiphers(state=>{state.tasks=[structuredClone(m.current)]},f.vault.encryptSecrets({[`publication:${taskId}`]:beforeSecret}));
    const persistence=createAgentRiotPersistence(f.store,f.vault,{taskId,siteId,assertPublicationIntent:()=>true,now:()=>new Date(at)});
    await persistence.persistRecoveryEvidence(recovered);
    const state=f.store.read();assert.equal(state.tasks[0].agentriot?.stage,'submitting');assert.equal(state.tasks[0].publicUrl,undefined);
    const secrets={[`account:${accountId}`]:(await f.vault.get(`account:${accountId}`))!,[`publication:${taskId}`]:(await f.vault.get(`publication:${taskId}`))!};
    assert.doesNotThrow(()=>validateBackup({state,secrets}));
    for(const field of ['accountId','requestHash','sourceHash'] as const){
      const wrong=structuredClone(recovered);wrong.recoveryEvidence[field]=field==='accountId'?'99999999-9999-4999-8999-999999999999':'0'.repeat(64);
      assert.throws(()=>validateBackup({state,secrets:{...secrets,[`publication:${taskId}`]:JSON.stringify(wrong)}}));
    }
    const mismatch=structuredClone(state);mismatch.tasks[0].agentriot!.updateSlug='another-update';
    assert.throws(()=>validateBackup({state:mismatch,secrets}));
    const premature=structuredClone(state);premature.tasks[0].agentriot!.stage='published';
    assert.throws(()=>validateBackup({state:premature,secrets}));
  }finally{f.cleanup()}
});

test('the final update send rejects a removed account binding',async()=>{
  const f=fixtureStore();let controller:Controller|undefined;
  try{
    const request=agentriotUpdateRequest(agentName,payload());
    const secret={version:1 as const,kind:'agentriot_update' as const,operationId:`agentriot_update_${taskId.replaceAll('-','')}`,requestHash:request.requestHash,sourceHash:request.sourceHash,agentSlug:agentName,payload:request.payload,createdAt:at};
    const receipt:AgentRiotPublicationIntent={operationId:secret.operationId,accountId,agentId,agentSlug:agentName,agentName,targetUrl:target,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:at,stage:'submitting'};
    await createAgentRiotPersistence(f.store,f.vault,{taskId,siteId,assertPublicationIntent:()=>true,now:()=>new Date(at)}).persistPublicationIntent(secret,receipt);
    controller=new Controller(f.store,f.vault,'isolated',{channelCatalog:[channel(true)]});
    f.store.update(state=>{state.tasks[0].status='running'});
    const context=(controller as unknown as {context(task:Task,signal:AbortSignal):ExecutionContext}).context(f.store.read().tasks[0],new AbortController().signal);
    const identity={kind:'publication' as const,operationId:receipt.operationId,requestHash:receipt.requestHash,sourceHash:receipt.sourceHash,accountId};
    assert.equal(context.authorizeAgentRiotMutation!(identity),true);
    f.store.update(state=>{state.accountBindings=[]});
    assert.throws(()=>context.authorizeAgentRiotMutation!(identity));
  }finally{controller?.stop();f.cleanup()}
});

import {agentriotNativeAssetUrl} from '../src/integrations/agentriot';
test('native assets accept only bounded static CSS/font paths and official deployment query',()=>{
 for(const [url,type] of [['https://agentriot.com/_next/static/css/base.css','stylesheet'],['https://agentriot.com/_next/static/chunks/base.css?dpl='+('a'.repeat(40)),'stylesheet'],['https://agentriot.com/_next/static/media/a-s.p.woff2','font']] as const)assert.equal(agentriotNativeAssetUrl(url,type),true);
 for(const url of ['https://agentriot.com/api/agents/me','https://agentriot.com/_next/static/css/base.css?token=secret','https://agentriot.com/_next/static/css/base.css?dpl=bad','https://agentriot.com/_next/static/css/base.css#x','https://x.example.test/_next/static/css/base.css','https://user@agentriot.com/_next/static/css/base.css','https://agentriot.com/_next/static/css/a..css'])assert.equal(agentriotNativeAssetUrl(url,'stylesheet'),false);
 assert.equal(agentriotNativeAssetUrl('https://agentriot.com/_next/static/media/a.woff2?dpl='+('a'.repeat(40))+'&x=1','font'),false);
});
