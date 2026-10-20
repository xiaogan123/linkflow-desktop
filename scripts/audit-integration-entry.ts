import { app, session, BrowserWindow, safeStorage } from 'electron';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {Vault} from '../src/main/vault';
import {LocalBackups} from '../src/main/maintenance';
import {validateLocalBackup} from '../src/main/backup-validation';
import {join} from 'node:path';
import { Controller } from '../src/main/controller';
import { CHANNELS } from '../src/integrations/catalog';
import {buildChannelTermsCache,reviewedChannelTermsCache} from '../src/main/article-evidence';
import type {Channel} from '../src/shared/types';
import { runBrowserTask, closeTaskBrowser } from '../src/integrations/browser';
import type { ExecutionContext, Account } from '../src/shared/types';
app.setPath('userData', process.env.AUDIT_USER_DATA!);
const evidence:any[]=[];
let n=0;
type FixturePage=string|((request:Request,url:URL,body:URLSearchParams|undefined)=>string);
function containsString(value:unknown,needle:string):boolean{if(typeof value==='string')return value.includes(needle);if(Array.isArray(value))return value.some(item=>containsString(item,needle));if(value&&typeof value==='object')return Object.values(value).some(item=>containsString(item,needle));return false;}
async function scenario(name:string, pages:Record<string,FixturePage>, choose:(data:any,ctx:ExecutionContext)=>any, expected:(r:any,ctx:ExecutionContext,requests:any[],calls:any[])=>void, seed?:Account, seedPassword='fixture-only-password') {
 const id=`audit-${++n}`, controller=new AbortController(), requests:any[]=[], calls:any[]=[];
 let account=seed; const passwords=new Map<string,string>(),accountHistory:Account[]=[]; if(seed) passwords.set(`account:${seed.id}`,seedPassword);
 const ctx:any={ site:{id,domain:'target.example',url:'https://target.example/',email:'audit@owner.example',name:'Audit Product',description:'Fixture description',category:'software',language:'en'}, channel:{id:seed?.channelId??id,name:'Fixture',domain:'fixture.example',submitUrl:'https://fixture.example/start',allowedHosts:['fixture.example'],automation:'browser',kind:'profile',emailRequired:false,accountRequired:!['external-final-submit-blocked-without-submission','publish-anchor-tracks-checkpoint-before-write'].includes(name)}, task:{id,createdAt:new Date().toISOString()}, settings:{maxSteps:15}, signal:controller.signal, secrets:{get:async(k:string)=>passwords.get(k),set:async()=>{},delete:async()=>{}}, ai:{json:async(_i:any,data:any)=>{calls.push(data); return choose(data,ctx);}},getAccount:()=>account,saveAccount:async(a:Account,p?:string)=>{account=structuredClone(a);accountHistory.push(structuredClone(a));if(p)passwords.set(`account:${a.id}`,p);},checkpoint:(p:any)=>Object.assign(ctx.task,p),log:()=>{}, abort:()=>controller.abort(),accountHistory};
 const partition=`persist:linkflow-${createHash('sha256').update(`${ctx.channel.id}|${seed?.id??ctx.site.email}`).digest('hex').slice(0,20)}`;
 const fixtureSessions=new Set<Electron.Session>();
 const registerFixture=(s:Electron.Session)=>{if(fixtureSessions.has(s))return;fixtureSessions.add(s);s.protocol.handle('https',async request=>{const url=new URL(request.url);const body=request.method==='POST'?new URLSearchParams(await request.text()):undefined;requests.push({host:url.host,path:url.pathname,method:request.method,...(request.method==='POST'?{checkpointAtWrite:ctx.task.checkpoint,submittedAtWrite:!!ctx.task.submittedAt,savedAccountId:account?.id,passwordSavedAtWrite:!!(account&&passwords.get(`account:${account.id}`)),username:body?.get('username')}:{}),...(body?.has('email')?{emailMatched:body.get('email')===ctx.site.email,passwordNonempty:!!body.get('password')}:{}),...(body?.has('website')?{websiteMatched:body.get('website')===ctx.site.url,titleMatched:body.get('title')===ctx.site.name}:{})});const page=pages[url.pathname];return new Response(typeof page==='function'?page(request,url,body):page??'<p>Not found</p>',{headers:{'content-type':'text/html'}});});};
 app.on('session-created',registerFixture);registerFixture(session.fromPartition(partition));
 const result=await runBrowserTask(ctx);
 try {expected(result,ctx,requests,calls); for(const password of passwords.values())assert(!containsString(calls,password),'password leaked into AI data'); evidence.push({name,passed:true,result,requests,aiCalls:calls.length,accountStatus:account?.status});} catch(e){evidence.push({name,passed:false,result,requests,error:String(e),observedControls:calls.map(x=>x.page.controls.map((c:any)=>({label:c.label,filled:c.filled})))});process.exitCode=1;} finally {closeTaskBrowser(id);app.removeListener('session-created',registerFixture);for(const s of fixtureSessions)s.protocol.unhandle('https');}
}
const action=(kind:string,id=-1,ref='none',purpose='navigation')=>({kind,id,ref,purpose,option:0,reason:'deterministic fixture'});
const filling=(d:any)=> {const c=d.page.controls.find((c:any)=>!c.filled&&['input','textarea'].includes(c.tag)); if(c)return action('fill',c.id,c.type==='password'?'account.password':/email/i.test(c.label)?'account.email':/(?:user\s?name|handle)/i.test(c.label)?'account.username':/website/i.test(c.label)?'site.url':'site.title');return undefined;};
// Scheduling only publishes between 09:00 and 23:00 local time and never exactly on the hour, and a newly
// imported site's first post is reserved from the next local day of the same month. Pick a fixture timezone in
// which "now" is inside 09:05-22:54, at least 5 minutes from an hour boundary and not on the last day of a month, so the
// smoke does not depend on the wall clock of the machine running it.
const publishingTimeZone=()=>{
 const now=new Date(),zones=[...Array.from({length:27},(_,i)=>i-12).map(o=>o===0?'Etc/GMT':`Etc/GMT${o>0?'-':'+'}${Math.abs(o)}`),'Asia/Kolkata','Asia/Tehran','Australia/Darwin','Pacific/Marquesas','America/St_Johns','Asia/Kathmandu'];
 const local=(timeZone:string)=>Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
 const fits=(timeZone:string)=>{const t=local(timeZone);return t.hour>=9&&t.hour<=22&&t.minute>=5&&t.minute<=54&&t.day<new Date(Date.UTC(t.year,t.month,0)).getUTCDate()};
 const zone=zones.find(fits);
 assert(zone,'no timezone is inside publishing hours and before the last day of its month right now (about 11:00-19:05 UTC on a month end); rerun later');
 return zone;
};
const importedAccount=(status:Account['status']='unknown'):Account=>({id:'11111111-1111-4111-8111-111111111111',channelId:'seed-channel',email:'audit@owner.example',username:'audit-owner',createdAt:'2026-09-01T00:00:00.000Z',status,source:'imported',hasPassword:true});
app.whenReady().then(async()=>{
 try{
 // Exercise the real OS encryption layer on both macOS and Windows, inside this test profile.
 const backupStore=new Store(join(process.env.AUDIT_USER_DATA!,'large-local-backup.sqlite'));
 const backupVault=new Vault(backupStore),largeSecret='synthetic-local-backup-value-'.repeat(500);
 assert(backupVault.available());backupStore.update(state=>{state.settings.hasApiKey=true;state.settings.autoRun=false});await backupVault.set('apiKey',largeSecret);
 const localCiphers=backupStore.allCiphers();assert(localCiphers.apiKey.length>10_000);
 const localBackups=new LocalBackups(join(process.env.AUDIT_USER_DATA!,'large-local-backups'),{encrypt:clear=>safeStorage.encryptString(clear),decrypt:cipher=>safeStorage.decryptString(cipher),snapshot:()=>({state:backupStore.read(),ciphers:backupStore.allCiphers()})});
 const localStatus=await localBackups.run(true),localPayload=await localBackups.read(localStatus.backups[0].id);
 const localRestore=validateLocalBackup(localPayload,cipher=>safeStorage.decryptString(cipher));assert.equal(localRestore.secrets.apiKey,largeSecret);
 const restoredPath=join(process.env.AUDIT_USER_DATA!,'large-local-restored.sqlite'),restoredStore=new Store(restoredPath),restoredVault=new Vault(restoredStore);
 restoredStore.restore(localRestore.state,restoredVault.encryptSecrets(localRestore.secrets));assert.equal(await restoredVault.get('apiKey'),largeSecret);restoredStore.close();
 const reopenedStore=new Store(restoredPath);assert.equal(await new Vault(reopenedStore).get('apiKey'),largeSecret);assert.equal(reopenedStore.read().settings.autoRun,false);reopenedStore.close();backupStore.close();
 evidence.push({name:'local-backup-large-os-cipher-validates-restores-and-reopens',passed:true,platform:process.platform,cipherExceededLegacyLimit:true,automaticExecutionRemainedPaused:true});

 const blockedController=Object.create(Controller.prototype) as Controller;
 (blockedController as any).drafting=new Set();
 (blockedController as any).services={};
 // A real State always carries account/binding arrays; draft generation now checks account readiness before the disabled-channel guard.
 const policyState={settings:{channelOverrides:{flathub:true,dev:true,medium:true}},tasks:[{id:'policy-task',siteId:'fixture-site',channelId:'flathub'}],sites:[{id:'fixture-site'}],accounts:[],accountBindings:[]};
 Object.defineProperty(blockedController,'store',{value:{read:()=>policyState}});
 let draftAiCalls=0;(blockedController as any).ai=()=>{draftAiCalls++;throw Error('AI must not run for disabled channels');};
 for(const channelId of ['flathub','dev','medium']){
   policyState.tasks[0].channelId=channelId;
   assert.equal(blockedController.channels().find(c=>c.id===channelId)?.enabled,false);
   await assert.rejects(blockedController.generateDraft('policy-task'),{message:/渠道已停用/,reasonCode:'channel_disabled'});
 }
 assert.equal(draftAiCalls,0);evidence.push({name:'disabled-channel-draft-and-override-guard',passed:true,aiCalls:draftAiCalls});
 // These scenarios exercise a named publisher's review gate, not catalog rank.
 // Scope the fixture so newly enabled ready publishers cannot take its topic.
 const draftStore=new Store(':memory:');draftStore.update(s=>{s.settings.channelOverrides=Object.fromEntries(CHANNELS.map(channel=>[channel.id,channel.id==='telegraph']))});const stamp=new Date().toISOString();const siteId='22222222-2222-4222-8222-222222222222';
 const draftTopicUrl='https://example.com/guides/information-verification';
 draftStore.update(s=>s.sites.push({id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'AI information education',description:'Crypto information verification with affiliate disclosure',category:'ai',language:'zh',monthlyTarget:2,articleReviewMode:'manual',topics:[{url:draftTopicUrl,lastModified:stamp,discoveredAt:stamp}],topicsCheckedAt:stamp,topicsAttemptedAt:stamp,status:'ready',createdAt:stamp}));
 const fakeVaultFor=(store:Store)=>({ready:true,available:()=>true,get:async(k:string)=>{const cipher=store.getCipher(k);return cipher?Buffer.from(cipher,'base64').toString():undefined},set:async(k:string,v:string)=>store.setCipher(k,Buffer.from(v).toString('base64')),delete:async(k:string)=>store.deleteCipher(k),encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,Buffer.from(value).toString('base64')]))});const fakeVault=fakeVaultFor(draftStore);
 // Drafting now reads platform terms and collects public evidence before any draft AI call. Keep both offline:
 // a reviewed terms cache built by the product's own builders, and no extra public evidence beyond the topic page.
 let termsPreparations=0;const offlineDraftServices={prepareChannelTerms:async(channel:Channel)=>{termsPreparations++;return reviewedChannelTermsCache(buildChannelTermsCache(channel,[{url:channel.rulesUrl??`https://${channel.domain}/`,kind:'content_policy',text:'Educational content about verifying information is allowed. Promotional links are allowed with a disclosure at the end of the article.',appliesTo:channel.id,applicability:'verified'}]),{finance:'allowed',promotion:'allowed',disclosurePlacement:'end'})},collectArticleEvidence:async()=>[]};
 const draftController=new Controller(draftStore,fakeVault as any,'',{...offlineDraftServices,discoverTopics:async()=>{throw Error('fresh fixture topics must not trigger discovery')},readTopicEvidence:async(_site,url)=>({url,title:'Information verification guide',text:'Check the primary source, publication date, and unresolved claims before relying on the information.',contentHash:'a'.repeat(64)})});draftController.runtime.aiReady=true;
 // Drafts now follow the site's writing profile (prose length range) and carry a fact manifest whose quotes
 // must come from the captured evidence snapshot. The deterministic writer honours the requested length.
 const profileRepeats=(data:any,unit:string,fallback:number)=>{const range=data?.writingProfile?.length;return range?Math.max(1,Math.round((range.min+range.max)/2/[...unit.replace(/\s/g,'')].length)):fallback};
 const zhUnit='通过原文和日期核对信息，明确未知之处。';
 (draftController as any).ai=()=>({json:async(_instruction:string,data:any)=>{const repeats=profileRepeats(data,zhUnit,60),third=Math.ceil(repeats/3);return {title:'信息来源核验教程',description:'核对公开信息',body:[zhUnit.repeat(third),zhUnit.repeat(third),zhUnit.repeat(Math.max(1,repeats-2*third))].join('\n\n'),facts:[{claim:'通过原文和日期核对信息',url:draftTopicUrl,quote:'Check the primary source, publication date, and unresolved claims'}]}}});
 let draftAiRuns=0;const draftAi=(draftController as any).ai;(draftController as any).ai=(...args:any[])=>{draftAiRuns++;return draftAi(...args)};
 draftStore.update(s=>{s.settings.timezone=publishingTimeZone()});
 // Scheduling now reserves a publication date first and selects the platform only when that date arrives.
 await draftController.tick();const reserved=draftStore.read();assert.equal(reserved.tasks.length,1);assert.equal(reserved.tasks[0].channelId,'');assert.equal(reserved.tasks[0].status,'queued');assert(Date.parse(reserved.tasks[0].scheduledAt)>Date.now());assert.equal(reserved.tasks[0].draft,undefined);assert.equal(reserved.tasks[0].submittedAt,undefined);assert.equal(draftAiRuns,0);
 draftStore.update(s=>{s.tasks[0].scheduledAt=new Date(Date.now()-1000).toISOString()});
 // Batch 9b: a new profile defaults to automatic AI review; this site's explicit manual mode must still gate publication.
 await draftController.tick();const staged=draftStore.read();assert(draftAiRuns>0);assert.equal(termsPreparations,1);assert.equal(staged.channelTermsCache?.telegraph?.reviewVersion,2);assert.equal(staged.settings.articleReviewMode,'ai');assert.equal(staged.sites[0].articleReviewMode,'manual');assert.equal(staged.tasks.length,1);assert.equal(staged.tasks[0].channelId,'telegraph');assert.equal(staged.tasks[0].topicUrl,draftTopicUrl);assert.equal(staged.tasks[0].topicContentHash,'a'.repeat(64));assert.equal(staged.tasks[0].checkpoint,'article_review');assert.equal(staged.tasks[0].status,'needs_input');assert.equal(staged.tasks[0].submittedAt,undefined);assert.equal(staged.accounts.length,0);assert.equal(staged.tasks[0].attempts,0);/* A site's first month plans one page and it is booked, so there is no shortfall to report. */assert.equal(staged.sites[0].error,undefined);
 evidence.push({name:'real-controller-financial-draft-gate-and-eligibility',passed:true,accountCreated:false,published:false,reservedBeforePlatformSelection:true,termsPreparations,draftAiCalls:draftAiRuns});
 const abortAccount=new AbortController();const context=(draftController as any).context(staged.tasks[0],abortAccount.signal);abortAccount.abort();const author={id:'33333333-3333-4333-8333-333333333333',channelId:'telegraph',email:'owner@example.com',username:'owner',status:'registered',credentialKind:'api_token',hasPassword:true,createdAt:stamp};await context.saveAccount(author,'fixture-token-must-persist-after-response');assert.equal(await fakeVault.get('account:'+author.id),'fixture-token-must-persist-after-response');assert.equal(draftStore.read().accounts[0].status,'registered');await assert.rejects(context.saveAccount({...author,status:'unknown'}),/暂停/);
 evidence.push({name:'inflight-registration-response-retains-token-after-pause',passed:true});draftStore.close();

 const gistStore=new Store(':memory:');
 const gistTopicUrl='https://example.com/templates/evidence-record';
 gistStore.update(s=>{s.settings.channelOverrides=Object.fromEntries(CHANNELS.map(channel=>[channel.id,channel.id==='github-gist']));s.sites.push({id:siteId,domain:'example.com',url:'https://example.com/',email:'different@example.com',name:'Technical templates',description:'Reusable evidence templates',category:'finance',language:'en',monthlyTarget:1,articleReviewMode:'manual',topics:[{url:gistTopicUrl,lastModified:stamp,discoveredAt:stamp}],topicsCheckedAt:stamp,topicsAttemptedAt:stamp,status:'ready',createdAt:stamp,qualifications:{developer:'https://example.com/templates'}});s.accounts.push({id:'44444444-4444-4444-8444-444444444444',channelId:'github-gist',email:'octocat@users.noreply.github.com',username:'octocat',createdAt:stamp,status:'registered',credentialKind:'api_token',hasPassword:true})});
 const gistVault=fakeVaultFor(gistStore);await gistVault.set('account:44444444-4444-4444-8444-444444444444','synthetic-gist-token');
 const gistController=new Controller(gistStore,gistVault as any,'',{...offlineDraftServices,discoverTopics:async()=>{throw Error('fresh fixture topics must not trigger discovery')},readTopicEvidence:async(_site,url)=>({url,title:'Evidence record template',text:'Record each claim, its primary source, the observed date, and the evidence that could disprove it.',contentHash:'b'.repeat(64)})});gistController.runtime.aiReady=true;
 gistStore.update(s=>{s.settings.timezone=publishingTimeZone()});
 // The managed writing envelope now appends the single link to the site (home or topic page); the writer must not add its own.
 const enUnit='Write the observed claim and primary source. Check original dates, preserve uncertainty, and distinguish an observation from an interpretation. ';let gistAiRuns=0;
 (gistController as any).ai=()=>({json:async(_instruction:string,data:any)=>{gistAiRuns++;return {title:'Reusable evidence template',description:'Record sources and unresolved claims.',body:enUnit.repeat(Math.max(1,profileRepeats(data,enUnit,3)-1))+'\n\nUse a separate row for each fact and explain what would disprove the statement.',facts:[{claim:'Write the observed claim and primary source',url:gistTopicUrl,quote:'Record each claim, its primary source, the observed date'}]}}});
 const originalFetch=globalThis.fetch;let gistPosts=0,anonymousChecks=0,readme='';const gistUrl='https://gist.github.com/octocat/aabbccddeeff11223344556677889900';
 globalThis.fetch=async(input,init)=>{const endpoint=String(input);assert(endpoint.startsWith('https://api.github.com/'));if(endpoint.endsWith('/user'))return Response.json({login:'octocat'});if(init?.method==='POST'){gistPosts++;assert.equal(gistStore.read().tasks[0].checkpoint,'submitting');assert(gistStore.read().tasks[0].submittedAt);readme=JSON.parse(String(init.body)).files['README.md'].content;}return Response.json({id:'aabbccddeeff11223344556677889900',html_url:gistUrl,public:true,created_at:stamp,owner:{login:'octocat'},files:{'README.md':{filename:'README.md',content:readme}}},{status:init?.method==='POST'?201:200})};
 const originalVerify=gistController.verify.bind(gistController);gistController.verify=async()=>{anonymousChecks++};
 try{
 // Batch 5 policy: a finance site is a hard audience mismatch for GitHub Gist even with developer proof.
 // The planner must not reserve a task, call AI, read platform terms or reach the GitHub API for it.
 const termsBeforeGist=termsPreparations;await gistController.tick();const financeGate=gistStore.read();assert.equal(financeGate.tasks.length,0);assert.equal(gistAiRuns,0);assert.equal(gistPosts,0);assert.equal(termsPreparations,termsBeforeGist);assert.equal(financeGate.sites[0].planStatus?.effectiveTarget,0);assert.equal(financeGate.sites[0].error,'当前没有符合条件且可执行的页面机会。');
 // The same owner, account and developer proof on a technical (non-finance) site keeps the approved-draft dispatch path.
 gistStore.update(s=>{s.sites[0].category='developer'});
 await gistController.tick();const gistReserved=gistStore.read();assert.equal(gistReserved.tasks.length,1);assert.equal(gistReserved.tasks[0].channelId,'');assert(Date.parse(gistReserved.tasks[0].scheduledAt)>Date.now());assert.equal(gistAiRuns,0);
 gistStore.update(s=>{s.tasks[0].scheduledAt=new Date(Date.now()-1000).toISOString()});
 await gistController.tick();const manualDraft=gistStore.read();assert.equal(manualDraft.settings.articleReviewMode,'ai');assert.equal(manualDraft.sites[0].articleReviewMode,'manual');assert.equal(gistPosts,0);assert.equal(manualDraft.tasks[0].channelId,'github-gist');assert.equal(manualDraft.tasks[0].topicUrl,gistTopicUrl);assert.equal(manualDraft.tasks[0].topicContentHash,'b'.repeat(64));assert.equal(manualDraft.tasks[0].checkpoint,'article_review');assert.equal(manualDraft.tasks[0].status,'needs_input');assert.equal(manualDraft.tasks[0].submittedAt,undefined);gistStore.update(s=>{s.tasks[0].articleApprovedAt=stamp;s.tasks[0].status='queued'});assert(gistAiRuns>0);await gistController.tick();assert.equal(gistPosts,1);const gistEnvelope=gistStore.read().tasks[0].writingEnvelope!;assert.equal(new URL(gistEnvelope.targetUrl).hostname,'example.com');assert.deepEqual([...readme.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map(match=>match[1]),[gistEnvelope.targetUrl],'published Gist carries exactly one link, to the site');assert(readme.includes(gistEnvelope.disclosure),'published Gist keeps the managed disclosure');assert.equal(anonymousChecks,1);assert.equal(gistStore.read().tasks[0].status,'review');assert.equal(gistStore.read().tasks[0].firstLiveAt,undefined);assert.equal(gistStore.read().accounts.length,1);
 // A secret/unconfirmed Gist cannot become live through generic verification.
 globalThis.fetch=async()=>Response.json({public:false});await originalVerify(gistStore.read().tasks[0].id);assert.equal(gistStore.read().tasks[0].firstLiveAt,undefined);assert.equal(gistStore.read().tasks[0].status,'review');
 evidence.push({name:'gist-controller-approved-draft-global-account-dispatch-and-private-verification-guard',passed:true,posts:gistPosts,anonymousVerifierInvoked:anonymousChecks,financeAudienceGateBlockedGist:true,aiCalls:gistAiRuns});
 }finally{globalThis.fetch=originalFetch;gistStore.close()}

 await scenario('register-fill-publish-observed-public-url',{
 '/start':'<form method="post" action="/editor"><label>Email<input name="email" type="email"></label><label>Password<input name="password" type="password"></label><button type="submit">Create account</button></form>',
 '/editor':'<a href="/logout">Log out</a><form method="post" action="/listing/123"><label>Website<input name="website" type="url"></label><label>Title<input name="title"></label><button type="submit">Publish listing</button></form>',
 '/listing/123':'<h1>Published successfully</h1><a href="https://target.example/">Audit Product</a>'
 },d=>filling(d)??action('click',d.page.controls.find((c:any)=>c.tag==='button').id,'none',d.page.url.endsWith('/start')?'register':'final_submit'),(r,c,req,calls)=>{assert.equal(r.status,'review');assert.equal(r.publicUrl,'https://fixture.example/listing/123');assert.equal(c.getAccount().status,'registered');assert.equal(req.filter(x=>x.method==='POST').length,2);assert(req.some(x=>x.emailMatched&&x.passwordNonempty));assert(req.some(x=>x.websiteMatched&&x.titleMatched));const p=calls.map(x=>JSON.stringify(x)).join('');assert(!p.includes('fixture-only-password'));});
 await scenario('captcha-pauses-before-ai',{'/start':'<div class="g-recaptcha" style="width:100px;height:100px">Captcha</div>'},()=>{throw new Error('AI should not run')},(r,c,req,calls)=>{assert.equal(r.status,'needs_input');assert.match(r.message,/验证码/);assert.equal(calls.length,0);});
 await scenario('abort-closes-browser-before-action',{'/start':'<button>Proceed</button>'},(d,c)=>{(c as any).abort();return action('click',0)},r=>{assert.equal(r.status,'queued');});
 await scenario('external-password-form-guard',{'/start':'<form method="post" action="https://external.example/capture"><label>Password<input name="password" type="password"></label><button>Continue</button></form>'},d=>filling(d),(r,c,req)=>{assert.equal(r.status,'needs_input');assert.match(r.message,/表单目标被阻止/);assert(!req.some(x=>x.host==='external.example'));});
 await scenario('external-final-submit-blocked-without-submission',{'/start':'<form method="post" action="https://external.example/capture"><label>Title<input value="fixture"></label><button type="submit">Publish</button></form>'},d=>action('click',1,'none','final_submit'),(r,c,req)=>{assert.equal(r.status,'needs_input');assert.equal(r.checkpoint,undefined);assert.equal(r.submittedAt,undefined);assert.equal(c.task.checkpoint,undefined);assert.equal(c.task.submittedAt,undefined);assert.match(r.message,/未执行提交/);assert(!req.some(x=>x.method==='POST'));});
 await scenario('delete-action-pauses-without-request',{'/start':'<button type="button" onclick="fetch(\'/delete-account\',{method:\'POST\'})">Delete account</button>','/delete-account':'OK'},d=>d.step===0?action('click',0):action('needs_input'),(r,c,req)=>{assert.equal(r.status,'needs_input');assert(!req.some(x=>x.path==='/delete-account'));assert.equal(c.task.checkpoint,undefined);});
 await scenario('publish-anchor-tracks-checkpoint-before-write',{'/start':'<a href="/published" onclick="fetch(\'/write\',{method:\'POST\'})">Publish listing</a>','/published':'<a href="https://target.example/">View</a>','/write':'OK'},d=>d.step===0?action('click',0,'none','final_submit'):action('needs_input'),(r,c,req)=>{assert(req.some(x=>x.path==='/published'));assert(req.some(x=>x.path==='/write'&&x.method==='POST'&&x.checkpointAtWrite==='submitting'&&x.submittedAtWrite));assert.equal(c.task.checkpoint,'submitting');assert.equal(r.status,'review');assert(r.submittedAt);assert.equal(r.publicUrl,'https://fixture.example/published');});
 await scenario('existing-dashboard-link-skipped-without-submission',{'/start':'<a href="/dashboard">Continue</a>','/dashboard':'<nav><a href="https://target.example/">Existing target link</a></nav><p>No submission performed</p>'},d=>d.step===0?action('click',0):action('done'),(r,c,req)=>{assert.equal(r.publicUrl,'https://fixture.example/dashboard');assert.equal(r.status,'skipped');assert.equal(r.checkpoint,'existing_link');assert.equal(r.submittedAt,undefined);assert.equal(c.task.submittedAt,undefined);assert.equal(c.task.firstLiveAt,undefined);assert(!req.some(x=>x.method==='POST'));});
 await scenario('existing-imported-account-is-reused-for-login',{
 '/start':'<form method="post" action="/dashboard"><label>Email<input name="email" type="email"></label><label>Password<input name="password" type="password"></label><button type="submit">Log in</button></form>',
 '/dashboard':'<nav><a href="/logout">Log out</a></nav><p>Account dashboard</p>'
 },d=>filling(d)??(d.page.controls.some((c:any)=>c.tag==='button')?action('click',d.page.controls.find((c:any)=>c.tag==='button').id,'none','login'):action('done')),(r,c,req)=>{assert.equal(r.status,'needs_input');assert.equal(c.getAccount().id,'11111111-1111-4111-8111-111111111111');assert.equal(c.getAccount().status,'registered');assert(c.getAccount().lastUsedAt);assert.equal(new Set((c as any).accountHistory.map((a:Account)=>a.id)).size,1);const writes=req.filter(x=>x.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].savedAccountId,c.getAccount().id);assert.equal(writes[0].passwordSavedAtWrite,true);},importedAccount());
 await scenario('github-imported-account-cannot-submit-registration',{
 '/start':'<form method="post" action="/register"><label>Email<input name="email" type="email" value="audit@owner.example"></label><label>Password<input name="password" type="password"></label><button type="submit">Create account</button></form>',
 '/register':'<p>Must never register</p>'
 },d=>action('click',d.page.controls.find((c:any)=>c.tag==='button').id,'none','register'),(r,c,req)=>{assert.equal(r.status,'needs_input');assert.match(r.message,/本人创建/);assert.equal(req.filter(x=>x.method==='POST').length,0);assert.equal(c.task.checkpoint,undefined);},{...importedAccount(),channelId:'github'});
 for(const [name,label,href,handler,purpose] of [
  ['purpose','Continue','/registered',"fetch('/write',{method:'POST'})",'register'],
  ['label','Create account','/registered',"fetch('/write',{method:'POST'})",'navigation'],
  ['encoded-path','Continue','/%72egister',"fetch('/write',{method:'POST'})",'navigation'],
  ['handler','Continue','/registered',"fetch('/signup',{method:'POST'})",'navigation'],
 ])await scenario('github-registration-anchor-'+name,{'/start':`<a href="${href}" onclick="${handler}">${label}</a>`},d=>action('click',d.page.controls[0].id,'none',purpose),(r,c,req)=>{assert.equal(r.status,'needs_input');assert.match(r.message,/本人创建/);assert.equal(req.filter(x=>x.method==='POST').length,0);assert.equal(req.length,1);},{...importedAccount(),channelId:'github'});
 let registrationWrites=0;
 await scenario('generated-draft-retries-explicit-username-conflict-once',{
 '/start':'<form method="post" action="/register"><label>Email<input name="email" type="email"></label><label>Username<input name="username"></label><label>Password<input name="password" type="password"></label><button type="submit">Create account</button></form>',
 '/register':()=>++registrationWrites===1?'<p>That username is already taken.</p><form><label>Username<input name="username"></label><label>Password<input name="password" type="password"></label></form>':'<nav><a href="/logout">Log out</a></nav><p>Account created</p>'
 },d=>filling(d)??(d.page.controls.some((c:any)=>c.tag==='button')?action('click',d.page.controls.find((c:any)=>c.tag==='button').id,'none','register'):action('done')),(r,c,req)=>{assert.equal(r.status,'needs_input');assert.equal(c.getAccount().status,'registered');assert.equal(c.getAccount().source,'generated');assert.equal(c.getAccount().registrationAttempts,2);const writes=req.filter(x=>x.path==='/register'&&x.method==='POST');assert.equal(writes.length,2);assert(writes.every(x=>x.passwordSavedAtWrite&&x.savedAccountId===c.getAccount().id));assert(writes[0].username&&writes[1].username&&writes[0].username!==writes[1].username);assert.equal(new Set((c as any).accountHistory.map((a:Account)=>a.id)).size,1);});
 await scenario('existing-email-pauses-without-replacement-account',{
 '/start':'<form method="post" action="/register"><label>Email<input name="email" type="email"></label><label>Username<input name="username"></label><label>Password<input name="password" type="password"></label><button type="submit">Create account</button></form>',
 '/register':'<p>This email is already registered.</p>'
 },d=>filling(d)??action('click',d.page.controls.find((c:any)=>c.tag==='button').id,'none','register'),(r,c,req)=>{assert.equal(r.status,'needs_input');assert.match(r.message,/邮箱已存在/);assert.equal(c.getAccount().status,'unknown');assert.equal(c.getAccount().diagnostic.code,'email_exists');assert.equal(req.filter(x=>x.path==='/register'&&x.method==='POST').length,1);assert.equal(new Set((c as any).accountHistory.map((a:Account)=>a.id)).size,1);});
 await scenario('restricted-existing-account-stops-before-browser',{'/start':'<p>Must not load</p>'},()=>{throw new Error('AI should not run')},(r,c,req,calls)=>{assert.equal(r.status,'needs_input');assert.match(r.message,/限制/);assert.equal(c.getAccount().status,'restricted');assert.equal(req.length,0);assert.equal(calls.length,0);},importedAccount('restricted'));
 await scenario('invalid-credentials-stop-before-browser',{'/start':'<p>Must not load</p>'},()=>{throw new Error('AI should not run')},(r,c,req,calls)=>{assert.equal(r.status,'needs_input');assert.match(r.message,/更新密码/);assert.equal(c.getAccount().status,'credentials_invalid');assert.equal(req.length,0);assert.equal(calls.length,0);},importedAccount('credentials_invalid'));
 await scenario('restriction-signal-wins-over-logout-and-publish',{
 '/start':'<nav><a href="/logout">Log out</a></nav><p>Your account has been suspended.</p><form method="post" action="/publish"><label>Website<input name="website" value="https://target.example/"></label><button type="submit">Publish listing</button></form>',
 '/publish':'<p>Should never publish</p>'
 },()=>{throw new Error('AI should not run')},(r,c,req,calls)=>{assert.equal(r.status,'needs_input');assert.match(r.message,/受限/);assert.equal(c.getAccount().status,'restricted');assert.equal(req.filter(x=>x.method==='POST').length,0);assert.equal(calls.length,0);},importedAccount('registered'));
 const escapedPassword='quote" and slash\\ fixture';
 await scenario('json-sensitive-password-is-redacted-before-ai',{'/start':'<p>Server echoed quote&quot; and slash\\ fixture</p><button type="button">Proceed</button>'},()=>action('needs_input'),(r,c,req,calls)=>{assert.equal(r.status,'needs_input');assert.equal(calls.length,1);assert.equal(containsString(calls,escapedPassword),false);assert.match(calls[0].page.text,/\[redacted\]/);assert.equal(req.filter(x=>x.method==='POST').length,0);},importedAccount(),escapedPassword);
 }catch(e){process.exitCode=1;evidence.push({fatal:String(e)});}finally{writeFileSync('.evidence/integration-electron.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));app.exit(process.exitCode??0);}
});
