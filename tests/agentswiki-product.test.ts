import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {load} from 'cheerio';
import {marked} from 'marked';
import {CHANNELS} from '../src/integrations/catalog';
import {
  AGENTSWIKI_ARTICLES,AGENTSWIKI_ME,AGENTSWIKI_META,AGENTSWIKI_REGISTER,AGENTSWIKI_RULE_VERSION,
  AGENTSWIKI_VALIDATE,agentsWikiArticleApi,agentsWikiHash,drainAgentsWikiPendingOperations,registerAgentsWiki,
  type AgentsWikiAccount,type AgentsWikiDependencies,type AgentsWikiDraft,type AgentsWikiIntent,type AgentsWikiPublicationSecret,type AgentsWikiRegistration,
} from '../src/integrations/agentswiki';
import {AGENTSWIKI_BODY_SELECTOR} from '../src/integrations/agentswiki-public';
import {
  AGENTSWIKI_REGISTRATION,agentsWikiDraftError,agentsWikiStructuredDraft,agentsWikiTaskIdentity,
  createAgentsWikiReviewedInput,validAgentsWikiAccount,
} from '../src/integrations/agentswiki-publisher';
import {connectAgentsWiki} from '../src/main/agentswiki-account';
import {createAgentsWikiPublicationPersistence,createAgentsWikiRegistrationPersistence} from '../src/main/agentswiki-publication';
import {ARTICLE_REVIEW_CONTRACT_VERSION,articleContentHash,articleContextHash} from '../src/main/article-review';
import {validateBackup} from '../src/main/backup-validation';
import {Controller} from '../src/main/controller';
import {Store,emptyState} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import type {Account,ArticleReview,Channel,Site,Task} from '../src/shared/types';

const at='2026-10-17T00:00:00.000Z';
const offsetCreatedAt='2026-10-17T08:00:00.123456+08:00';
const siteIds=['22222222-2222-4222-8222-222222222222','22222222-2222-4222-8222-222222222223'];
const taskIds=['11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111112'];
const accountId='33333333-3333-4333-8333-333333333333';
const remoteAccountId='44444444-4444-4444-8444-444444444444';
const articleId='55555555-5555-4555-8555-555555555555';
const bindingId='77777777-7777-4777-8777-777777777777';
const publicUrl='https://agents-wiki.com/wiki/bounded-recovery-notes';
const apiKey='aw_fixture_0123456789012345678901234567890123456789';
const keyPrefix='aw_fixture_';
const targets=['https://alpha.example.org/docs/recovery','https://beta.example.net/guides/cache'];

function channel(enabled=true):Channel{return {...CHANNELS.find(value=>value.id==='agentswiki')!,enabled}}
function site(index=0):Site{
  const target=targets[index],origin=new URL(target).origin,domain=new URL(target).hostname,label=index?'Beta Cache':'Alpha Recovery';
  return {id:siteIds[index],domain,url:origin,email:'owner'+index+'@example.test',name:label,description:'Public software documentation for '+label,category:'software',language:'en',monthlyTarget:1,articleReviewMode:'ai',qualifications:{software:target,developer:target},status:'ready',createdAt:at,analyzedAt:at,topicsCheckedAt:at,topics:[{url:target,title:label+' guide',discoveredAt:at}]};
}
function queuedTask(index=0,extra:Partial<Task>={}):Task{
  return {id:taskIds[index],siteId:siteIds[index],channelId:'agentswiki',sourceDomain:'agents-wiki.com',status:'queued',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'ordinary Agents Wiki task',topicUrl:targets[index],...extra};
}
function draftFor(target:string,label:string){
  return {
    title:label+' Recovery Boundary Guide',
    description:'A neutral, evidence-bound method for recovering state without repeating an uncertain remote write.',
    body:'## Establish the boundary\n\nRecord the durable local intent before any write. Treat an interrupted response as evidence to preserve, not permission to repeat the request.\n\n## Recover safely\n\nCompare the saved identity, request hash, and current public state. The ['+label+' public guide]('+target+') is the cited source for this workflow.\n\n## Stop conditions\n\nStop when ownership, content, or revision cannot be matched exactly. Escalate for review instead of guessing a new identifier or sending another write.',
  };
}
function profile(name=AGENTSWIKI_REGISTRATION.name,createdAt=offsetCreatedAt,id=remoteAccountId,publicDisclosure=AGENTSWIKI_REGISTRATION.public_disclosure):AgentsWikiAccount{
  return {id,name,publicDisclosure,role:'agent',createdAt,keyPrefix};
}
function profileWire(value=profile()){return {id:value.id,name:value.name,public_disclosure:value.publicDisclosure,role:value.role,created_at:value.createdAt,key_prefix:value.keyPrefix}}
function meta(){return {name:'Agents Wiki',license:'CC-BY-4.0',rule_version:AGENTSWIKI_RULE_VERSION,writes_enabled:true,registration_enabled:true,registration:{url:AGENTSWIKI_REGISTER,method:'POST',key_shown_once:true}}}
function response(url:string,status:number,value:unknown,type='application/json'){
  const body=typeof value==='string'?value:JSON.stringify(value),result=new Response(body,{status,headers:{'content-type':type}});
  Object.defineProperties(result,{url:{value:url},redirected:{value:false},type:{value:'basic'}});
  return result;
}
function cipher(value:string){return 'enc:'+Buffer.from(value).toString('base64url')}
function decipher(value:string|undefined){return value?.startsWith('enc:')?Buffer.from(value.slice(4),'base64url').toString():undefined}
function vault(store:Store):Vault{
  return {ready:true,available:()=>true,get:async(name:string)=>decipher(store.getCipher(name)),set:async(name:string,value:string)=>store.setCipher(name,cipher(value)),delete:async(name:string)=>store.deleteCipher(name),encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([name,value])=>[name,cipher(value)]))} as unknown as Vault;
}
function baseState(sites:Site[],tasks:Task[]){
  const value=emptyState();value.settings.autoRun=true;value.settings.notify=false;value.settings.articleReviewMode='ai';value.settings.timezone='UTC';value.settings.channelOverrides={agentswiki:true};value.sites=sites;value.tasks=tasks;return value;
}
function fixture(sites=[site()],tasks=[queuedTask()]){
  const directory=mkdtempSync(join(tmpdir(),'agentswiki-product-')),path=join(directory,'state.sqlite'),store=new Store(path);
  store.update(current=>Object.assign(current,baseState(sites,tasks)));
  return {directory,path,store,vault:vault(store),cleanup(){try{store.close()}catch{}rmSync(directory,{recursive:true,force:true})}};
}
function passedReview(current:Task,currentSite:Site,currentChannel:Channel,settings:ReturnType<Store['read']>['settings'],account?:Parameters<typeof articleContextHash>[3]):ArticleReview{
  return {status:'passed',reason:'Independent task-specific review passed the current draft, target, channel rules, and disclosed agent identity.',reasonCode:'passed',reviewContractVersion:ARTICLE_REVIEW_CONTRACT_VERSION,checks:{factualAccuracy:'pass',authorRelationship:'pass',affiliateDisclosure:'pass',independentValue:'pass',financialSafety:'pass',channelRules:'pass'},reviewedAt:at,evidenceUrls:[current.topicUrl!,currentChannel.rulesUrl],draftRevision:current.draftRevision??0,contentHash:articleContentHash(current),contextHash:articleContextHash(currentSite,currentChannel,settings,account)};
}
function readyAccount(name=AGENTSWIKI_REGISTRATION.name,remoteCreatedAt=offsetCreatedAt,publicDisclosure=AGENTSWIKI_REGISTRATION.public_disclosure):Account{
  const requestHash=agentsWikiHash('GET\n'+AGENTSWIKI_ME+'\nauthorization:bearer\n');
  return {id:accountId,channelId:'agentswiki',email:'',username:name,displayName:name,createdAt:at,updatedAt:at,registeredAt:at,verifiedAt:at,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token',registrationAttempts:0,agentsWiki:{version:1,stage:'ready',operationId:'agentswiki_import_'+accountId.replaceAll('-',''),requestHash,ruleVersion:AGENTSWIKI_RULE_VERSION,publicationRights:true,remoteAccountId,remoteCreatedAt,name,publicDisclosure,role:'agent',keyPrefix,keyFingerprint:agentsWikiHash(apiKey),checkedAt:at}};
}
function importedAccountSecret(account=readyAccount()){
  return JSON.stringify({version:1,kind:'agentswiki_account',mode:'imported',operationId:account.agentsWiki!.operationId,requestHash:account.agentsWiki!.requestHash,account:profile(account.username,account.agentsWiki!.remoteCreatedAt,account.agentsWiki!.remoteAccountId,account.agentsWiki!.publicDisclosure),apiKey});
}
function opaque(url:string,status:number,value:unknown){const bytes=Buffer.from(JSON.stringify(value));return {version:1 as const,capturedAt:at,requestUrl:url,status,contentType:'application/json',responseUrl:url,redirected:false,responseType:'basic',headers:[['content-type','application/json']] as Array<[string,string]>,bodyBase64:bytes.toString('base64'),bodySha256:createHash('sha256').update(bytes).digest('hex'),bodyComplete:true}}
function seedReadyPublication(store:Store){
  const next=store.read(),currentSite=next.sites[0],task=next.tasks[0],account=readyAccount();
  task.accountId=account.id;task.status='running';task.attempts=1;task.draft=draftFor(task.topicUrl!,currentSite.name);task.draftRevision=1;task.draftUpdatedAt=at;task.topicContentHash='d'.repeat(64);
  next.accounts=[account];next.accountBindings=[{id:bindingId,siteId:currentSite.id,channelId:'agentswiki',accountId:account.id,createdAt:at,updatedAt:at}];
  const review=passedReview(task,currentSite,channel(true),next.settings,account);task.articleReview=review;
  const input=createAgentsWikiReviewedInput(task,currentSite,account,{method:'ai',reviewedAt:review.reviewedAt!,contentHash:review.contentHash,contextHash:review.contextHash});
  assert.ok(input);task.agentsWikiInput=input;
  store.updateWithCiphers(current=>Object.assign(current,next),{['account:'+account.id]:cipher(importedAccountSecret(account))});
  return {account:store.read().accounts[0],task:store.read().tasks[0],site:store.read().sites[0]};
}

function nativePage(draft:AgentsWikiDraft){
  const parsed=load(String(marked.parse(draft.body,{async:false,gfm:true}))),bodyHtml=String(marked.parse(draft.body,{async:false,gfm:true})).replaceAll('<a href=', '<a rel="ugc nofollow" href=');
  const html='<!doctype html><html><head><title>'+draft.title+'</title><link rel="canonical" href="'+publicUrl+'"><meta name="robots" content="index, follow"></head><body><main id="site.content"><article lang="'+draft.language+'"><h1>'+draft.title+'</h1><p class="summary">'+draft.summary+'</p><div class="prose">'+bodyHtml+'</div></article></main></body></html>';
  const links=parsed('a[href]').toArray().map(node=>({href:parsed(node).attr('href')!,rel:['ugc','nofollow'],text:parsed(node).text(),visible:true}));
  return {url:publicUrl,documentTitle:draft.title,headings:[{text:draft.title,visible:true}],candidates:[{selector:AGENTSWIKI_BODY_SELECTOR,html,text:parsed('body').text(),allTextVisible:true,links}],robots:[{name:'robots',content:'index, follow'}],canonicals:[publicUrl],hasRefresh:false,hasPasswordGate:false,hasLoginGate:false,responseRobots:[],responseLinks:[],responseStatus:200,responseMediaType:'text/html',responseBodyBytes:Buffer.byteLength(html),responseEncodedBodyBytes:Buffer.byteLength(html),nativeRequests:[{url:publicUrl,method:'GET' as const,resourceType:'mainFrame' as const}],occlusionClear:true as const};
}

interface TransportOptions {
  etag?:string;
  account?:AgentsWikiAccount;
  articlePayload?:unknown;
  articleResponder?:()=>Promise<Response>;
  onValidate?:()=>void;
}
function transport(options:TransportOptions={}){
  const calls:Record<string,number>={},remote=options.account??profile(),etag=options.etag??'"'+articleId+':1"';let draft:AgentsWikiDraft|undefined;
  const fetch:NonNullable<AgentsWikiDependencies['fetch']>=async(url,init)=>{
    const method=init.method??'GET',key=method+' '+url;calls[key]=(calls[key]??0)+1;
    if(method==='GET'&&url===AGENTSWIKI_META)return response(url,200,meta());
    if(method==='GET'&&url==='https://agents-wiki.com/robots.txt')return response(url,200,'User-agent: *\nAllow: /\nDisallow: /api/\n','text/plain');
    if(method==='POST'&&url===AGENTSWIKI_REGISTER){assert.deepEqual(JSON.parse(String(init.body)),AGENTSWIKI_REGISTRATION);return response(url,201,{...profileWire(remote),api_key:apiKey,rule_version:AGENTSWIKI_RULE_VERSION})}
    if(method==='GET'&&url===AGENTSWIKI_ME){assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+apiKey);return response(url,200,profileWire(remote))}
    if(method==='POST'&&url===AGENTSWIKI_VALIDATE){draft=JSON.parse(String(init.body)) as AgentsWikiDraft;options.onValidate?.();return response(url,200,{valid:true,problems:[],missing:[],write_gate:null,allowed_actions:['create own articles'],similar:draft.related.map(id=>({id}))})}
    if(method==='POST'&&url===AGENTSWIKI_ARTICLES){
      const posted=JSON.parse(String(init.body)) as AgentsWikiDraft;assert.deepEqual(posted,draft);assert.equal(new Headers(init.headers).get('idempotency-key'),'agentswiki_article_'+taskIds[0].replaceAll('-',''));
      if(options.articleResponder)return options.articleResponder();
      return response(url,201,options.articlePayload??{id:articleId,etag,revision:1,canonical_url:publicUrl});
    }
    if(method==='GET'&&url===agentsWikiArticleApi(articleId)){
      if(!draft)throw Error('missing isolated draft');
      return response(url,200,{...structuredClone(draft),id:articleId,etag,revision:1,canonical_url:publicUrl,license:'CC-BY-4.0',status:'unreviewed',symptoms:[],slug:'bounded-recovery-notes',created_by:remote.id,updated_by:remote.id,visibility:'public',content_url:agentsWikiArticleApi(articleId)+'/content',markdown_url:agentsWikiArticleApi(articleId)+'/content?format=markdown',created_at:at,updated_at:at});
    }
    if(method==='GET'&&url===agentsWikiArticleApi(articleId)+'/content'){
      if(!draft)throw Error('missing isolated draft');
      return response(url,200,{...structuredClone(draft),id:articleId,etag,revision:1,canonical_url:publicUrl,license:'CC-BY-4.0',status:'unreviewed',symptoms:[],untrusted_content:true,translated_from:null});
    }
    throw Error('unexpected isolated request '+method+' '+url);
  };
  return {calls,fetch,draft:()=>draft};
}
function makeController(store:Store,secureVault:Vault,deps:AgentsWikiDependencies,writerInputs:unknown[]=[]){
  const value=new Controller(store,secureVault,'isolated',{
    channelCatalog:[channel(true)],
    readTopicEvidence:async(_site,url)=>({url,title:'Public recovery documentation',text:'Public technical evidence for a bounded recovery workflow.',contentHash:agentsWikiHash(url)}),
    collectArticleEvidence:async(currentSite,currentChannel)=>[{url:currentSite.url,kind:'site',text:'Public project evidence.',excerpt:'Public project evidence.'},{url:currentChannel.rulesUrl,kind:'content_policy',text:'Official contribution rules.',excerpt:'Official contribution rules.',appliesTo:'agentswiki',applicability:'verified'}],
    aiFactory:(_settings,_vault,onCall)=>({json:async<T>(_instruction:string,data:unknown)=>{onCall?.();writerInputs.push(data);const value=data as {topicEvidence:{url:string};site:{name:string}};return draftFor(value.topicEvidence.url,value.site.name) as T}}),
    reviewArticle:async(current,currentSite,currentChannel,settings,_ai,_signal,options)=>passedReview(current,currentSite,currentChannel,settings,options?.account),
    agentsWikiDependencies:deps,
  });
  value.runtime.aiReady=true;return value;
}
async function connect(store:Store,secureVault:Vault,fetch:NonNullable<AgentsWikiDependencies['fetch']>,siteIdsToBind=siteIds.slice(0,1),key=apiKey){
  return connectAgentsWiki(store,secureVault,{apiKey:key,siteIds:siteIdsToBind},{fetch,now:()=>new Date(at)});
}

test('ordinary drafting creates distinct reviewed inputs for unrelated sites and topics',async()=>{
  const f=fixture([site(0),site(1)],[queuedTask(0),queuedTask(1)]),wire=transport(),inputs:unknown[]=[];
  try{
    const account=await connect(f.store,f.vault,wire.fetch,siteIds);
    f.store.update(state=>{for(const task of state.tasks)task.accountId=account.id});
    const runner=makeController(f.store,f.vault,{now:()=>new Date(at),fetch:wire.fetch},inputs);
    await runner.generateDraft(taskIds[0]);await runner.generateDraft(taskIds[1]);
    f.store.update(state=>{
      for(const task of state.tasks){
        const currentSite=state.sites.find(value=>value.id===task.siteId)!,currentAccount=state.accounts.find(value=>value.id===task.accountId)!;
        const review=passedReview(task,currentSite,channel(true),state.settings,currentAccount);task.articleReview=review;
        task.agentsWikiInput=createAgentsWikiReviewedInput(task,currentSite,currentAccount,{method:'ai',reviewedAt:review.reviewedAt!,contentHash:review.contentHash,contextHash:review.contextHash});
      }
    });
    const saved=f.store.read();
    assert.equal(inputs.length,2);assert.notEqual(saved.tasks[0].draft?.body,saved.tasks[1].draft?.body);
    for(let index=0;index<2;index++){
      const task=saved.tasks[index],currentSite=saved.sites[index],currentAccount=saved.accounts[0],identity=agentsWikiTaskIdentity(task,currentSite,currentAccount);
      assert.equal(agentsWikiDraftError(task,currentSite),undefined);assert.ok(identity);assert.equal(identity.input.version,2);assert.equal(identity.input.targetUrl,targets[index]);assert.equal(identity.input.identity.remoteAccountId,remoteAccountId);assert.equal(identity.input.identity.publicDisclosure,AGENTSWIKI_REGISTRATION.public_disclosure);assert.equal(identity.input.identity.publicationRights,true);assert.equal(identity.input.identity.ruleVersion,AGENTSWIKI_RULE_VERSION);assert.ok(identity.input.draft.body.includes(targets[index]));
    }
    assert.notDeepEqual(saved.tasks[0].agentsWikiInput?.draft,saved.tasks[1].agentsWikiInput?.draft);runner.stop();
  }finally{f.cleanup()}
});

test('ordinary generated identity describes the actual operator without claiming LinkFlow ownership or maintenance',()=>{
  const disclosure=AGENTSWIKI_REGISTRATION.public_disclosure,draft=agentsWikiStructuredDraft({...queuedTask(),draft:draftFor(targets[0],site().name),draftUpdatedAt:at},site());
  assert.match(disclosure,/person using Linkflow Assistant/i);
  assert.doesNotMatch(disclosure,/\b(?:owner|maintainer)\b/i);
  assert.equal(draft.attribution.length,1);
  assert.ok(draft.attribution[0].includes(disclosure));
  assert.doesNotMatch(draft.attribution[0],/human maintainer of LinkFlow/i);
});

test('an imported account preserves its exact official nonempty disclosure through review, publish, backup, and restore',async()=>{
  const disclosure='AI-assisted contributor operated by the Alpha Recovery documentation publisher; no affiliation with Linkflow.',remote=profile('Alpha Recovery Publisher',offsetCreatedAt,remoteAccountId,disclosure),wire=transport({account:remote}),f=fixture(),deps:AgentsWikiDependencies={now:()=>new Date(at),fetch:wire.fetch,renderPage:async()=>{const draft=wire.draft();if(!draft)throw Error('missing draft');return nativePage(draft)}};
  try{
    const account=await connect(f.store,f.vault,wire.fetch,[siteIds[0]]);f.store.update(state=>{state.tasks[0].accountId=account.id});
    const runner=makeController(f.store,f.vault,deps);try{await runner.tick()}finally{runner.stop()}
    const saved=f.store.read(),stored=saved.accounts[0],task=saved.tasks[0],plain=await f.vault.get('account:'+stored.id),publication=await f.vault.get('publication:'+task.id);
    assert.equal(stored.displayName,remote.name);assert.equal(stored.agentsWiki?.publicDisclosure,disclosure);assert.ok(validAgentsWikiAccount(stored));
    assert.equal(task.agentsWikiInput?.identity.publicDisclosure,disclosure);assert.ok(task.agentsWikiInput?.draft.attribution[0].includes(disclosure));assert.equal(task.agentsWiki?.stage,'published');
    assert.equal(wire.calls['POST '+AGENTSWIKI_REGISTER]??0,0);assert.equal(wire.calls['POST '+AGENTSWIKI_ARTICLES],1);
    assert.ok(plain&&publication);assert.equal((JSON.parse(plain!) as {account:{publicDisclosure:string}}).account.publicDisclosure,disclosure);
    assert.doesNotThrow(()=>validateBackup({state:saved,secrets:{['account:'+stored.id]:plain!,['publication:'+task.id]:publication!}}));
    const changed=structuredClone(stored);changed.agentsWiki!.publicDisclosure='Different operator disclosure';assert.equal(agentsWikiTaskIdentity(task,saved.sites[0],changed),undefined);
  }finally{f.cleanup()}
});

test('an imported account with an empty or absent official disclosure is rejected without creating local identity state',async()=>{
  for(const publicDisclosure of ['',null]){
    const f=fixture(),wire=transport({account:{...profile(),publicDisclosure}});
    try{await assert.rejects(()=>connect(f.store,f.vault,wire.fetch),/非空如实身份披露/);assert.equal(f.store.read().accounts.length,0);assert.equal(Object.keys(f.store.allCiphers()).length,0)}finally{f.cleanup()}
  }
});

for(const etagSuffix of ['',':0123456789abcdef'])test('ordinary Controller registers once, writes once, verifies, and restores '+(etagSuffix?'content-bound ETag':'legacy ETag'),async()=>{
  const f=fixture(),wire=transport({etag:'"'+articleId+':1'+etagSuffix+'"'}),deps:AgentsWikiDependencies={now:()=>new Date(at),fetch:wire.fetch,renderPage:async()=>{const draft=wire.draft();if(!draft)throw Error('missing draft');return nativePage(draft)}},runner=makeController(f.store,f.vault,deps);
  try{
    await runner.tick();const saved=f.store.read(),task=saved.tasks[0],account=saved.accounts[0],posted=wire.draft();
    assert.equal(wire.calls['POST '+AGENTSWIKI_REGISTER],1);assert.equal(wire.calls['POST '+AGENTSWIKI_VALIDATE],1);assert.equal(wire.calls['POST '+AGENTSWIKI_ARTICLES],1);
    assert.ok(posted);assert.deepEqual(posted,agentsWikiStructuredDraft(task,saved.sites[0],account,task.articleReview?.reviewedAt));
    assert.ok(validAgentsWikiAccount(account));assert.equal(account.agentsWiki?.remoteCreatedAt,offsetCreatedAt);assert.equal(saved.accountBindings[0]?.accountId,account.id);
    assert.equal(task.articleReview?.status,'passed');assert.equal(task.agentsWikiInput?.version,2);assert.ok(agentsWikiTaskIdentity(task,saved.sites[0],account));
    assert.equal(task.agentsWiki?.stage,'published');assert.equal(task.status,'live');assert.equal(task.publicUrl,publicUrl);assert.equal(task.linkCheck,'found');assert.equal(task.firstLiveAt,task.verifiedAt);assert.equal(JSON.stringify(saved).includes(apiKey),false);
    const accountPlain=await f.vault.get('account:'+account.id),publicationPlain=await f.vault.get('publication:'+task.id);assert.ok(accountPlain&&publicationPlain);
    const restored=validateBackup({state:saved,secrets:{['account:'+account.id]:accountPlain!,['publication:'+task.id]:publicationPlain!}});
    const directory=mkdtempSync(join(tmpdir(),'agentswiki-restore-')),restoredStore=new Store(join(directory,'state.sqlite'));
    try{restoredStore.restore(restored.state,Object.fromEntries(Object.entries(restored.secrets).map(([name,value])=>[name,cipher(value)])));assert.equal(restoredStore.read().tasks[0].agentsWiki?.stage,'published');assert.equal(restoredStore.read().accounts[0].agentsWiki?.remoteCreatedAt,offsetCreatedAt)}finally{restoredStore.close();rmSync(directory,{recursive:true,force:true})}
  }finally{runner.stop();f.cleanup()}
});

test('generated registration accepts Z, offset, and microsecond remote timestamps and reuses the saved intent after restart',async()=>{
  for(const remoteCreatedAt of ['2026-10-17T00:00:00Z','2026-10-17T08:00:00+08:00','2026-10-17T00:00:00.123456+00:00']){
    const f=fixture([site()],[queuedTask(0,{status:'running',attempts:1})]),remote=profile(AGENTSWIKI_REGISTRATION.name,remoteCreatedAt),wire=transport({account:remote});
    try{
      const persistence=createAgentsWikiRegistrationPersistence(f.store,f.vault,{taskId:taskIds[0],siteId:siteIds[0],accountId,assertAuthorized:()=>true,now:()=>new Date(at)});
      const first=await registerAgentsWiki({accountId,taskId:taskIds[0],draft:AGENTSWIKI_REGISTRATION},persistence,{fetch:wire.fetch,now:()=>new Date(at)});
      assert.equal(first.status,'receipt');const saved=f.store.read(),account=saved.accounts[0];assert.ok(validAgentsWikiAccount(account));assert.equal(account.agentsWiki?.remoteCreatedAt,remoteCreatedAt);
      const plain=await f.vault.get('account:'+account.id);assert.ok(plain);assert.doesNotThrow(()=>validateBackup({state:saved,secrets:{['account:'+account.id]:plain!}}));
      const resumed=createAgentsWikiRegistrationPersistence(f.store,f.vault,{taskId:taskIds[0],siteId:siteIds[0],accountId,assertAuthorized:()=>true,now:()=>new Date(at)});
      const second=await registerAgentsWiki({accountId,taskId:taskIds[0],draft:AGENTSWIKI_REGISTRATION},resumed,{fetch:wire.fetch,now:()=>new Date(at)});
      assert.equal(second.status,'prior_intent');assert.equal(wire.calls['POST '+AGENTSWIKI_REGISTER],1);
    }finally{f.cleanup()}
  }
});

test('restart recovers an older generated registration from its encrypted exact disclosure without another registration POST',async()=>{
  const prior:AgentsWikiRegistration={name:'Historic Documentation Publisher',public_disclosure:'AI-assisted contributor operated by the original documentation publisher.',rule_version:AGENTSWIKI_RULE_VERSION,publication_rights:true};
  const remote=profile(prior.name,offsetCreatedAt,remoteAccountId,prior.public_disclosure),wire=transport({account:remote}),f=fixture([site()],[queuedTask(0,{status:'running',attempts:1})]);
  try{
    const body=JSON.stringify(prior),intent:AgentsWikiIntent={version:1,kind:'registration',accountId,taskId:taskIds[0],createdAt:at,requestHash:agentsWikiHash(`POST\n${AGENTSWIKI_REGISTER}\nidempotency-key:\ncontent-type:application/json\n\n${body}`),sourceHash:agentsWikiHash(body)};
    const first=createAgentsWikiRegistrationPersistence(f.store,f.vault,{taskId:taskIds[0],siteId:siteIds[0],accountId,registration:prior,assertAuthorized:()=>true,now:()=>new Date(at)});
    await first.persistIntent(intent);await first.persistOpaque(intent,opaque(AGENTSWIKI_REGISTER,201,{...profileWire(remote),api_key:apiKey,rule_version:AGENTSWIKI_RULE_VERSION}));
    assert.equal(f.store.read().accounts[0].agentsWiki?.stage,'opaque_response');
    const runner=makeController(f.store,f.vault,{now:()=>new Date(at),fetch:wire.fetch,renderPage:async()=>{const current=wire.draft();if(!current)throw Error('missing draft');return nativePage(current)}});
    try{await runner.tick()}finally{runner.stop()}
    const saved=f.store.read(),account=saved.accounts[0],task=saved.tasks[0],plain=await f.vault.get('account:'+account.id),publication=await f.vault.get('publication:'+task.id);
    assert.equal(wire.calls['POST '+AGENTSWIKI_REGISTER]??0,0);assert.equal(wire.calls['POST '+AGENTSWIKI_ARTICLES],1);assert.equal(account.source,'generated');assert.equal(account.username,prior.name);assert.equal(account.agentsWiki?.publicDisclosure,prior.public_disclosure);assert.equal(task.agentsWikiInput?.identity.publicDisclosure,prior.public_disclosure);assert.equal(task.agentsWiki?.stage,'published');
    assert.ok(plain&&publication);assert.deepEqual((JSON.parse(plain!) as {registration:AgentsWikiRegistration}).registration,prior);assert.doesNotThrow(()=>validateBackup({state:saved,secrets:{['account:'+account.id]:plain!,['publication:'+task.id]:publication!}}));
  }finally{f.cleanup()}
});

test('official 81 and 100 character agent names survive encrypted backup and restore',async()=>{
  for(const length of [81,100]){
    const name='N'.repeat(length),remote=profile(name,'2026-10-17T00:00:00.123456+00:00'),wire=transport({account:remote}),f=fixture();
    try{
      const account=await connect(f.store,f.vault,wire.fetch,[siteIds[0]]);assert.equal(account.username.length,length);assert.ok(validAgentsWikiAccount(account));
      const plain=await f.vault.get('account:'+account.id);assert.ok(plain);const restored=validateBackup({state:f.store.read(),secrets:{['account:'+account.id]:plain!}});
      const directory=mkdtempSync(join(tmpdir(),'agentswiki-name-')),restoredStore=new Store(join(directory,'state.sqlite'));
      try{restoredStore.restore(restored.state,{['account:'+account.id]:cipher(plain!)});assert.equal(restoredStore.read().accounts[0].username,name);assert.equal(restoredStore.read().accounts[0].agentsWiki?.remoteCreatedAt,remote.createdAt)}finally{restoredStore.close();rmSync(directory,{recursive:true,force:true})}
    }finally{f.cleanup()}
  }
});

async function lateResponseScenario(mode:'pause'|'skip'){
  let deliver!:()=>void,posted!:()=>void;
  const articleStarted=new Promise<void>(resolve=>{posted=resolve}),articleResponse=new Promise<Response>(resolve=>{deliver=()=>resolve(response(AGENTSWIKI_ARTICLES,201,{id:articleId,etag:'"'+articleId+':1"',revision:1,canonical_url:publicUrl}))});
  const wire=transport({articleResponder:async()=>{posted();return articleResponse}}),f=fixture();
  const account=await connect(f.store,f.vault,wire.fetch,[siteIds[0]]);f.store.update(state=>{state.tasks[0].accountId=account.id});
  const runner=makeController(f.store,f.vault,{now:()=>new Date(at),fetch:wire.fetch,renderPage:async()=>{throw Error('late response must not enter native verification')}});
  try{
    const running=runner.tick();await articleStarted;assert.equal(f.store.read().tasks[0].agentsWiki?.stage,'submitting');
    runner.pause();if(mode==='skip')runner.patch(taskIds[0],{status:'skipped',message:'explicitly skipped after pause'});
    deliver();await running;assert.equal(await drainAgentsWikiPendingOperations(5000),true);
    const saved=f.store.read(),task=saved.tasks[0],publication=await f.vault.get('publication:'+task.id),accountPlain=await f.vault.get('account:'+account.id),secret=JSON.parse(publication!) as AgentsWikiPublicationSecret;
    assert.equal(wire.calls['POST '+AGENTSWIKI_ARTICLES],1);assert.equal(task.status,mode==='skip'?'skipped':'review');assert.equal(task.agentsWiki?.stage,'submitting');assert.equal(task.publicUrl,undefined);assert.equal(task.firstLiveAt,undefined);assert.equal(secret.opaqueResponse?.bodyComplete,true);assert.equal(secret.receipt,undefined);
    assert.equal(wire.calls['GET '+agentsWikiArticleApi(articleId)]??0,0);assert.equal(saved.events.some(event=>event.message.includes('外链已生效')),false);
    assert.doesNotThrow(()=>validateBackup({state:saved,secrets:{['account:'+account.id]:accountPlain!,['publication:'+task.id]:publication!}}));
    runner.stop();f.store.close();
    const restartedStore=new Store(f.path),restarted=makeController(restartedStore,vault(restartedStore),{now:()=>new Date(at),fetch:wire.fetch});
    try{restarted.runtime.aiReady=true;await restarted.tick();assert.equal(wire.calls['POST '+AGENTSWIKI_ARTICLES],1);assert.equal(restartedStore.read().tasks[0].status,mode==='skip'?'skipped':'review')}finally{restarted.stop();restartedStore.close()}
  }finally{runner.stop();f.cleanup()}
}

test('pause then skip preserves a late complete response without promotion, notice, restart, or another POST',async()=>lateResponseScenario('skip'));
test('pause cancellation preserves late evidence while keeping the task at the durable submitting stage',async()=>lateResponseScenario('pause'));

test('exact old-cipher CAS prevents a stale prefix from replacing a concurrently saved complete response',async()=>{
  const f=fixture();
  try{
    const seeded=seedReadyPublication(f.store),publicationKey='publication:'+seeded.task.id;let inject=false,completeOpaque:AgentsWikiPublicationSecret['opaqueResponse'];
    const secureVault={ready:true,available:()=>true,get:async(name:string)=>decipher(f.store.getCipher(name)),set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>{
      if(inject&&completeOpaque&&values[publicationKey]){
        inject=false;const oldCipher=f.store.getCipher(publicationKey)!,prior=JSON.parse(decipher(oldCipher)!) as AgentsWikiPublicationSecret,completeCipher=cipher(JSON.stringify({...prior,opaqueResponse:completeOpaque}));
        f.store.updateWithCiphers(state=>{const receipt=state.tasks[0].agentsWiki!;state.tasks[0].agentsWiki={...receipt,stage:'opaque_response'};state.tasks[0].checkpoint='agentswiki_article_opaque_response'},{[publicationKey]:completeCipher},[],{[publicationKey]:oldCipher});
      }
      return Object.fromEntries(Object.entries(values).map(([name,value])=>[name,cipher(value)]));
    }} as unknown as Vault;
    const identity=agentsWikiTaskIdentity(seeded.task,seeded.site,seeded.account)!;
    const intent:AgentsWikiIntent={version:1,kind:'publication',accountId:seeded.account.id,taskId:seeded.task.id,createdAt:at,requestHash:identity.requestHash,sourceHash:identity.sourceHash,idempotencyKey:identity.idempotencyKey};
    const persistence=createAgentsWikiPublicationPersistence(f.store,secureVault,{taskId:seeded.task.id,siteId:seeded.site.id,accountId:seeded.account.id,assertAuthorized:()=>true,now:()=>new Date(at)});
    await persistence.persistIntent(intent);
    const envelope=(body:string,bodyComplete:boolean)=>{const bytes=Buffer.from(body);return {version:1 as const,capturedAt:at,requestUrl:AGENTSWIKI_ARTICLES,status:201,contentType:'application/json',responseUrl:AGENTSWIKI_ARTICLES,redirected:false,responseType:'basic',headers:[['content-type','application/json']] as Array<[string,string]>,bodyBase64:bytes.toString('base64'),bodySha256:createHash('sha256').update(bytes).digest('hex'),bodyComplete}};
    const completeBody=JSON.stringify({id:articleId,etag:'"'+articleId+':1"',revision:1,canonical_url:publicUrl}),prefix=envelope('{"id":"',false);completeOpaque=envelope(completeBody,true);inject=true;
    await assert.rejects(persistence.persistOpaque(intent,prefix));
    const secret=JSON.parse((await secureVault.get(publicationKey))!) as AgentsWikiPublicationSecret;
    assert.equal(secret.opaqueResponse?.bodyComplete,true);assert.equal(Buffer.from(secret.opaqueResponse!.bodyBase64,'base64').toString(),completeBody);assert.equal(f.store.read().tasks[0].agentsWiki?.stage,'opaque_response');
  }finally{f.cleanup()}
});

test('article review context and reviewed input bind every publication identity field',()=>{
  const f=fixture();
  try{
    const seeded=seedReadyPublication(f.store),settings=f.store.read().settings,base=articleContextHash(seeded.site,channel(true),settings,seeded.account),mutations:Array<(account:Account)=>void>=[
      account=>{account.id='33333333-3333-4333-8333-333333333334'},
      account=>{account.agentsWiki!.remoteAccountId='44444444-4444-4444-8444-444444444445'},
      account=>{account.agentsWiki!.remoteCreatedAt='2026-10-17T01:00:00+00:00'},
      account=>{account.username='Different Agent';account.agentsWiki!.name='Different Agent'},
      account=>{account.agentsWiki!.publicDisclosure='Different disclosure'},
      account=>{account.agentsWiki!.role='editor'},
      account=>{(account.agentsWiki as {ruleVersion:string}).ruleVersion='2026-10-14'},
      account=>{(account.agentsWiki as {publicationRights:boolean}).publicationRights=false},
      account=>{account.agentsWiki!.keyFingerprint='f'.repeat(64)},
    ];
    assert.equal(seeded.task.agentsWikiInput?.identity.license,'CC-BY-4.0');
    for(const mutate of mutations){const changed=structuredClone(seeded.account);mutate(changed);assert.notEqual(articleContextHash(seeded.site,channel(true),settings,changed),base);assert.equal(agentsWikiTaskIdentity(seeded.task,seeded.site,changed),undefined)}
  }finally{f.cleanup()}
});

test('a send-moment account binding change stops before the article POST',async()=>{
  const f=fixture();let unbound=false;
  const wire=transport({onValidate:()=>{if(unbound)return;unbound=true;f.store.update(state=>{state.accountBindings=state.accountBindings.filter(value=>value.channelId!=='agentswiki')})}});
  try{
    const account=await connect(f.store,f.vault,wire.fetch,[siteIds[0]]);f.store.update(state=>{state.tasks[0].accountId=account.id});
    const runner=makeController(f.store,f.vault,{now:()=>new Date(at),fetch:wire.fetch});
    try{await runner.tick();const saved=f.store.read().tasks[0];assert.equal(wire.calls['POST '+AGENTSWIKI_VALIDATE],1);assert.equal(wire.calls['POST '+AGENTSWIKI_ARTICLES]??0,0);assert.equal(saved.agentsWiki,undefined);assert.equal(f.store.getCipher('publication:'+saved.id),undefined);assert.ok(saved.agentsWikiInput)}finally{runner.stop()}
  }finally{f.cleanup()}
});

test('an unfamiliar complete response is encrypted and bounded recovery never repeats the article POST',async()=>{
  const f=fixture(),wire=transport({articlePayload:{changed:true}});
  try{
    const account=await connect(f.store,f.vault,wire.fetch,[siteIds[0]]);f.store.update(state=>{state.tasks[0].accountId=account.id});
    const runner=makeController(f.store,f.vault,{now:()=>new Date(at),fetch:wire.fetch,renderPage:async()=>{throw Error('unknown response has no accepted article')}});
    try{
      await runner.tick();for(let attempt=0;attempt<3;attempt++){f.store.update(state=>{state.tasks[0].reconcileAfter=undefined});await runner.tick()}
      const saved=f.store.read(),task=saved.tasks[0],publication=await f.vault.get('publication:'+task.id),accountPlain=await f.vault.get('account:'+account.id),secret=JSON.parse(publication!) as AgentsWikiPublicationSecret;
      assert.equal(wire.calls['POST '+AGENTSWIKI_ARTICLES],1);assert.equal(task.agentsWiki?.stage,'opaque_response');assert.equal(task.reconcileAttempts,3);assert.equal(task.status,'needs_input');assert.match(task.message,/不会重发/);assert.equal(secret.opaqueResponse?.bodyComplete,true);
      assert.doesNotThrow(()=>validateBackup({state:saved,secrets:{['account:'+account.id]:accountPlain!,['publication:'+task.id]:publication!}}));
    }finally{runner.stop()}
  }finally{f.cleanup()}
});
