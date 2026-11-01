import {marked} from 'marked';
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {PUBLISHMARKDOWN_SINGLE_ARTICLE_DRAFT_RULE,currentArticlePublicationContext,publishMarkdownOriginalPurpose,publishMarkdownSingleArticleCandidate} from '../src/main/article-publication-context';
import {buildChannelTermsCache,reviewedChannelTermsCache} from '../src/main/article-evidence';
import {articleReviewStillValid,channelTermsBlockReason,reviewArticleDraft} from '../src/main/article-review';
import {validateBackup} from '../src/main/backup-validation';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {Controller} from '../src/main/controller';
import {emptyState,Store} from '../src/main/store';
import {schedulableTaskMatches,selectTaskPlatform} from '../src/main/planner';
import {CHANNELS} from '../src/integrations/catalog';
import {runPublishMarkdownTask,verifyPublishMarkdownPublication,publishMarkdownKeyIdentity,publishMarkdownDocument} from '../src/integrations/publishmarkdown';
import {connectPublisherToken} from '../src/main/publisher-token-management';
import {publisherFor} from '../src/integrations/publishers';
import type {Vault} from '../src/main/vault';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const at='2026-10-29T12:00:00.000Z',target='https://software.example.org/guide';
const policy='Publish original material. Do not create spam, bulk search manipulation, or affiliate link farms.';
const guidance='Create a deploy for your site from files you own. Static site content can include your own documentation.';
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fixture(){
  const site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Software Example',description:'Maintained software documentation',email:'owner@example.org',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:at,topics:[{url:target,discoveredAt:at}],qualifications:{software:'https://software.example.org/'}};
  const catalog=CHANNELS.find(item=>item.id==='publishmarkdown');assert.ok(catalog);
  const channel:Channel={...catalog,enabled:true};
  channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(channel,[{url:channel.rulesUrl,kind:'content_policy',text:policy,appliesTo:'publishmarkdown',applicability:'verified'},{url:'https://publishmarkdown.com/docs',kind:'product_guidance',text:guidance,appliesTo:'publishmarkdown',applicability:'verified'}]),{finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'});
  const account:Account={id:randomUUID(),channelId:'publishmarkdown',email:'',username:publishMarkdownKeyIdentity('sk_synthetic_key_123456'),publicationUrl:'https://publishmarkdown.com/',ownerSiteId:site.id,createdAt:at,status:'registered',hasPassword:true,credentialKind:'api_token',source:'imported'};
  const task:Task={id:randomUUID(),siteId:site.id,channelId:'publishmarkdown',accountId:account.id,sourceDomain:channel.domain,status:'queued',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'test',draftRevision:1,topicUrl:target,draft:{title:'How to verify a software release',description:'A practical technical guide.',body:`Check the release notes and reproduce the configuration. See the [original guide](${target}) for maintained steps. Disclosure: we maintain Software Example. This note explains limitations and troubleshooting steps.`}};
  const settings={...emptyState().settings,articleReviewMode:'ai' as const};
  return {site,channel,account,task,settings};
}
async function approved(f:ReturnType<typeof fixture>){
  f.task.publishMarkdownOriginalPurpose=publishMarkdownOriginalPurpose(f.task);
  const review=await reviewArticleDraft(f.task,f.site,f.channel,f.settings,{json:async()=>({verdict:'pass',reason:'The independent troubleshooting guide is useful.',citations:[{url:f.site.url,quote:f.site.description}],policyAssessment:{useKind:'original_editorial',verdict:'compatible',reason:'The one original document fits static hosting and does not use bulk promotion.',citations:[{url:'https://publishmarkdown.com/docs',quote:'Static site content can include your own documentation.',purpose:'hosting_purpose'},{url:f.channel.rulesUrl,quote:'Do not create spam, bulk search manipulation, or affiliate link farms.',purpose:'use_restriction'}]}} as never)},undefined,{account:f.account,publicationContext:currentArticlePublicationContext([f.task],f.task),fetchHtml:async url=>({url,html:`<main><p>${url===f.channel.rulesUrl?policy:url.includes('publishmarkdown.com/docs')?guidance:f.site.description}</p></main>`})});
  assert.equal(review.status,'passed',review.reason);f.task.articleReview=review;return review;
}

test('only one software document gains Publish Markdown original-purpose context and survives backup',()=>{
  const f=fixture();assert.match(PUBLISHMARKDOWN_SINGLE_ARTICLE_DRAFT_RULE,/原创静态技术文档/);
  assert.equal(publishMarkdownSingleArticleCandidate([f.task],f.task,f.site,f.channel),true);
  assert.equal(publishMarkdownSingleArticleCandidate([f.task],f.task,{...f.site,category:'finance'},f.channel),false);
  assert.equal(publishMarkdownSingleArticleCandidate([f.task],f.task,f.site,{...f.channel,singleSiteOnly:false}),false);
  assert.equal(publishMarkdownSingleArticleCandidate([f.task,{...f.task,id:randomUUID(),siteId:randomUUID()}],f.task,f.site,f.channel),false);
  assert.equal(currentArticlePublicationContext([f.task],f.task).publicationIntent,'unknown');f.task.publishMarkdownOriginalPurpose=publishMarkdownOriginalPurpose(f.task);
  assert.equal(currentArticlePublicationContext([f.task],f.task).publicationIntent,'single_original_article');
  for(const changed of [{...f.task,id:randomUUID()},{...f.task,siteId:randomUUID()},{...f.task,draftRevision:2},{...f.task,draft:{...f.task.draft!,body:f.task.draft!.body+' changed'}},{...f.task,channelId:'leafmill'}])assert.equal(currentArticlePublicationContext([changed],changed).publicationIntent,'unknown');
  const state=emptyState();state.sites=[f.site];state.tasks=[f.task];state.accounts=[f.account];state.accountBindings=[{id:randomUUID(),siteId:f.site.id,channelId:'publishmarkdown',accountId:f.account.id,createdAt:at,updatedAt:at}];
  const secrets={[`account:${f.account.id}`]:JSON.stringify({version:1,apiKey:'sk_synthetic_key_123456'})};
  assert.deepEqual(validateBackup({state,secrets}).state.tasks[0].publishMarkdownOriginalPurpose,f.task.publishMarkdownOriginalPurpose);
  const bad=structuredClone(state);bad.tasks[0].publishMarkdownOriginalPurpose={...f.task.publishMarkdownOriginalPurpose,contentHash:'bad'};assert.throws(()=>validateBackup({state:bad,secrets}));
});

test('planner offers only the one connected software task for Publish Markdown purpose review',()=>{
  const f=fixture(),state=emptyState();state.sites=[f.site];state.tasks=[{...f.task,channelId:'',sourceDomain:'',accountId:undefined}];state.accounts=[f.account];state.accountBindings=[{id:randomUUID(),siteId:f.site.id,channelId:'publishmarkdown',accountId:f.account.id,createdAt:at,updatedAt:at}];state.settings.channelOverrides.publishmarkdown=true;
  const match={channel:f.channel,score:100,reason:'software documentation'};
  assert.equal(channelExecutionReadiness(state,f.site.id,f.channel).kind,'ready');
  assert.equal(schedulableTaskMatches(state,state.tasks[0],[match],new Date(at)).length,1);
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(at))?.id,'publishmarkdown');
  state.tasks.push({...f.task,id:randomUUID(),siteId:randomUUID()});state.tasks[0].channelId='';state.tasks[0].sourceDomain='';
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(at)),undefined);
  state.tasks.pop();f.channel.termsCache={...f.channel.termsCache!,promotion:'forbidden'};
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(at)),undefined);
});

test('Publish Markdown independent review binds exact original purpose while policy stays unknown',async()=>{
  const f=fixture();const review=await approved(f);
  assert.equal(channelTermsBlockReason(f.site,f.channel,f.channel.termsCache),'policy_unknown');
  assert.equal(articleReviewStillValid(f.task,f.site,f.channel,f.settings,f.account,currentArticlePublicationContext([f.task],f.task)),true);
  assert.equal(articleReviewStillValid({...f.task,publishMarkdownOriginalPurpose:undefined},f.site,f.channel,f.settings,f.account,currentArticlePublicationContext([{...f.task,publishMarkdownOriginalPurpose:undefined}],{...f.task,publishMarkdownOriginalPurpose:undefined})),false);
  assert.equal(articleReviewStillValid({...f.task,draft:{...f.task.draft!,body:f.task.draft!.body+' changed'}},f.site,f.channel,f.settings,f.account,currentArticlePublicationContext([f.task],f.task)),false);
  assert.equal(review.policyAssessment?.citations[0].purpose,'hosting_purpose');
});

test('controller rechecks Publish Markdown review after the final guarded intent and prevents late POST',async()=>{
  const f=fixture();await approved(f);const store=new Store(':memory:');let controller:Controller|undefined;
  try{
    store.update(state=>{state.sites=[f.site];state.accounts=[f.account];state.tasks=[{...f.task,status:'running'}];state.accountBindings=[{id:randomUUID(),siteId:f.site.id,channelId:'publishmarkdown',accountId:f.account.id,createdAt:at,updatedAt:at}];state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides.publishmarkdown=true;state.channelTermsCache??={};state.channelTermsCache.publishmarkdown=f.channel.termsCache!});
    const credential=JSON.stringify({version:1,apiKey:'sk_synthetic_key_123456'});
    const vault={ready:true,available:()=>true,get:async(key:string)=>{const value=store.getCipher(key);return value?.startsWith('enc:')?Buffer.from(value.slice(4),'base64').toString():undefined},set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'enc:'+Buffer.from(value).toString('base64')]))} as unknown as Vault;
    store.updateWithCiphers(()=>{},vault.encryptSecrets({[`account:${f.account.id}`]:credential}));let posts=0;
    controller=new Controller(store,vault,'fixture',{channelCatalog:[f.channel],batch5Dependencies:{fetch:async(url,init)=>{if(init.method==='POST'){posts++;throw Error('must not POST')}if(url==='https://publishmarkdown.com/v1/api/markdown?limit=50&offset=0')return json({status:'success',data:{items:[],offset:0,limit:50,totalData:0}});throw Error(`unexpected ${url}`)}}});
    store.update(state=>{state.tasks[0].status='running'});
    const context=(controller as unknown as {context:(task:Task,signal:AbortSignal)=>ExecutionContext}).context(store.read().tasks[0],new AbortController().signal);
    const journal=context.batch5Persistence!;const original=journal.markSending!.bind(journal);
    journal.markSending=async intent=>{await original(intent);store.update(state=>{state.settings.channelOverrides.publishmarkdown=false})};
    const result=await runPublishMarkdownTask(context);assert.equal(result.reasonCode,'submission_unknown',JSON.stringify(result));assert.equal(posts,0);
  }finally{controller?.stop();store.close()}
});

test('Publish Markdown default-disabled connection uses only GET and binds encrypted key fingerprint to its original software site',async()=>{
 const f=fixture(),store=new Store(':memory:');
 try{
  store.update(s=>{s.sites=[f.site];s.settings.autoRun=false});
  const catalog=CHANNELS.find(c=>c.id==='publishmarkdown')!;assert.equal(catalog.enabled,false);assert.equal(catalog.accessClass,'connect_once');assert.ok(publisherFor(catalog));
  const vault={encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'cipher:'+value]))};
  const requests:string[]=[];const fetch=async(url:string,init:RequestInit)=>{requests.push(`${init.method} ${url}`);return json({status:'success',data:{items:[],offset:0,limit:50,totalData:0}})};
  const input={channelId:'publishmarkdown' as const,token:'sk_synthetic_key_123456',siteIds:[f.site.id]};
  const account=await connectPublisherToken(store,vault,input,{fetch});
  assert.equal(account.username,publishMarkdownKeyIdentity(input.token));assert.equal(account.email,'');assert.equal(account.ownerSiteId,f.site.id);
  assert.equal(JSON.stringify(account).includes(input.token),false);assert.deepEqual(requests,['GET https://publishmarkdown.com/v1/api/markdown?limit=50&offset=0']);
  const key=`account:${account.id}`,backup={state:store.read(),secrets:{[key]:store.getCipher(key)!.slice(7)}};
  assert.doesNotThrow(()=>validateBackup(backup));
  const forged=structuredClone(backup);forged.state.accounts[0].username=publishMarkdownKeyIdentity('sk_changed_key_123456');assert.throws(()=>validateBackup(forged),/Publish Markdown/);
  const before=JSON.stringify(store.read());await assert.rejects(connectPublisherToken(store,vault,{...input,accountId:account.id,token:'sk_changed_key_123456'},{fetch}),/其他账号/);assert.equal(JSON.stringify(store.read()),before);
 }finally{store.close()}
});

test('Publish Markdown production Store journal carries one reviewed create through read-only publication verification',async()=>{
 const f=fixture();await approved(f);const store=new Store(':memory:');let controller:Controller|undefined;
 try{
  store.update(state=>{state.sites=[f.site];state.accounts=[f.account];state.tasks=[{...f.task,status:'running'}];state.accountBindings=[{id:randomUUID(),siteId:f.site.id,channelId:'publishmarkdown',accountId:f.account.id,createdAt:at,updatedAt:at}];state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides.publishmarkdown=true;state.channelTermsCache??={};state.channelTermsCache.publishmarkdown=f.channel.termsCache!});
  const vault={ready:true,available:()=>true,get:async(key:string)=>{const value=store.getCipher(key);return value?.startsWith('enc:')?Buffer.from(value.slice(4),'base64').toString():undefined},set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'enc:'+Buffer.from(value).toString('base64')]))} as unknown as Vault;
  store.updateWithCiphers(()=>{},vault.encryptSecrets({[`account:${f.account.id}`]:JSON.stringify({version:1,apiKey:'sk_synthetic_key_123456'})}));
  let posts=0;const doc=publishMarkdownDocument({...f,getAccount:()=>f.account,secrets:vault,ai:{json:async()=>{throw Error("unexpected AI")}},signal:new AbortController().signal,saveAccount:async()=>{},checkpoint:()=>{},log:()=>{}} as ExecutionContext),remote={identifier:'reviewed_guide',url:'https://publishmarkdown.com/reviewed_guide'};
  controller=new Controller(store,vault,'fixture',{channelCatalog:[f.channel],batch5Dependencies:{now:()=>new Date(at),renderPage:async()=>({found:true,indexable:true,rel:''}),fetch:async(url,init)=>{
   if(url==='https://publishmarkdown.com/v1/api/markdown?limit=50&offset=0')return json({status:'success',data:{items:[],offset:0,limit:50,totalData:0}});
   if(url==='https://publishmarkdown.com/v1/api/markdown'){assert.equal(init.method,'POST');assert.equal(new Headers(init.headers).get('api-key'),'sk_synthetic_key_123456');assert.equal(init.body,doc.request);posts++;return json({status:'success',data:remote})}
   assert.equal(init.method,'GET');
   if(url==='https://publishmarkdown.com/v1/api/markdown/'+remote.identifier)return json({status:'success',data:{identifier:remote.identifier,content:doc.content,expiredAt:null,is_password_protected:false,createdAt:at,updatedAt:at}});
   assert.equal(new Headers(init.headers).has('api-key'),false);
   if(url===remote.url)return new Response('<article>'+marked.parse(doc.content,{async:false})+'</article>',{headers:{'content-type':'text/html'}});
   if(url==='https://publishmarkdown.com/robots.txt')return new Response('User-agent: *\nAllow: /\n',{headers:{'content-type':'text/plain'}});
   throw Error('unexpected request');
  }}});
  store.update(state=>{state.tasks[0].status='running'});
  const context=(controller as unknown as {context:(task:Task,signal:AbortSignal)=>ExecutionContext}).context(store.read().tasks[0],new AbortController().signal);
  assert.equal((await runPublishMarkdownTask(context)).publicUrl,remote.url);assert.equal(store.read().tasks[0].batch5?.stage,'api_receipt');
  assert.equal((await verifyPublishMarkdownPublication(context)).found,true);await runPublishMarkdownTask(context);assert.equal(posts,1);
  assert.equal(JSON.stringify(store.read()).includes('sk_synthetic_key_123456'),false);
  const secrets:Record<string,string>={};for(const key of Object.keys(store.allCiphers())){const value=await vault.get(key);if(value)secrets[key]=value}
  assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets}));
 }finally{controller?.stop();store.close()}
});

