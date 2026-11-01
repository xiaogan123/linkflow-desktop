import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {RENDER_SINGLE_ARTICLE_DRAFT_RULE,currentArticlePublicationContext,renderOriginalPurpose,renderSingleArticleCandidate} from '../src/main/article-publication-context';
import {buildChannelTermsCache,reviewedChannelTermsCache} from '../src/main/article-evidence';
import {articleReviewStillValid,channelTermsBlockReason,reviewArticleDraft} from '../src/main/article-review';
import {validateBackup} from '../src/main/backup-validation';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {Controller} from '../src/main/controller';
import {emptyState,Store} from '../src/main/store';
import {schedulableTaskMatches,selectTaskPlatform} from '../src/main/planner';
import {CHANNELS} from '../src/integrations/catalog';
import {runRenderTask,verifyRenderPublication,renderDocument} from '../src/integrations/render-publisher';
import {connectPublisherToken} from '../src/main/publisher-token-management';
import {publisherFor} from '../src/integrations/publishers';
import type {Vault} from '../src/main/vault';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const owner={id:'tea-synthetic1234567890',username:'synthetic-owner'};const source={version:1 as const,repository:'https://github.com/synthetic-owner/docs',repositoryId:123,githubLogin:'synthetic-owner',githubUserId:456,baseBranch:'main'};const credentialValue={version:1,apiKey:'rnd_synthetic_key_1234567890',ownerId:owner.id,email:'owner@example.org',githubToken:'ghp_synthetic_key_1234567890',source};
const at='2026-10-29T12:00:00.000Z',target='https://software.example.org/guide';
const policy='Publish original material. Do not create spam, bulk search manipulation, or affiliate link farms.';
const guidance='Create a deploy for your site from files you own. Static site content can include your own documentation.';
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fixture(){
  const site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Software Example',description:'Maintained software documentation',email:'owner@example.org',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:at,topics:[{url:target,discoveredAt:at}],qualifications:{software:'https://software.example.org/'}};
  const catalog=CHANNELS.find(item=>item.id==='render');assert.ok(catalog);
  const channel:Channel={...catalog,enabled:true};
  channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(channel,channel.evidenceSources!.map(s=>({...s,text:s.kind==='product_guidance'?guidance:policy,appliesTo:'render',applicability:'verified' as const}))),{finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'});
  const account:Account={id:randomUUID(),channelId:'render',email:'owner@example.org',username:owner.id,publicationUrl:'https://dashboard.render.com/',renderSource:source,ownerSiteId:site.id,createdAt:at,status:'registered',hasPassword:true,credentialKind:'api_token',source:'imported'};
  const task:Task={id:randomUUID(),siteId:site.id,channelId:'render',accountId:account.id,sourceDomain:channel.domain,status:'queued',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'test',draftRevision:1,topicUrl:target,draft:{title:'How to verify a software release',description:'A practical technical guide.',body:`Check the release notes and reproduce the configuration. See the [original guide](${target}) for maintained steps. Disclosure: we maintain Software Example. This note explains limitations and troubleshooting steps.`}};
  const settings={...emptyState().settings,articleReviewMode:'ai' as const};
  return {site,channel,account,task,settings};
}
async function approved(f:ReturnType<typeof fixture>){
  f.task.renderOriginalPurpose=renderOriginalPurpose(f.task);
  const review=await reviewArticleDraft(f.task,f.site,f.channel,f.settings,{json:async()=>({verdict:'pass',reason:'The independent troubleshooting guide is useful.',citations:[{url:f.site.url,quote:f.site.description}],policyAssessment:{useKind:'original_editorial',verdict:'compatible',reason:'The one original document fits static hosting and does not use bulk promotion.',citations:[{url:'https://render.com/docs/static-sites',quote:'Static site content can include your own documentation.',purpose:'hosting_purpose'},{url:f.channel.rulesUrl,quote:'Do not create spam, bulk search manipulation, or affiliate link farms.',purpose:'use_restriction'}]}} as never)},undefined,{account:f.account,publicationContext:currentArticlePublicationContext([f.task],f.task),fetchHtml:async url=>({url,html:`<main><p>${url===f.channel.rulesUrl||url==='https://render.com/acceptable-use'?policy:url.startsWith('https://render.com')?guidance:f.site.description}</p></main>`})});
  assert.equal(review.status,'passed',review.reason);f.task.articleReview=review;return review;
}

test('only one software document gains Render original-purpose context and survives backup',()=>{
  const f=fixture();assert.match(RENDER_SINGLE_ARTICLE_DRAFT_RULE,/原创静态技术文档/);
  assert.equal(renderSingleArticleCandidate([f.task],f.task,f.site,f.channel),true);
  assert.equal(renderSingleArticleCandidate([f.task],f.task,{...f.site,category:'finance'},f.channel),false);
  assert.equal(renderSingleArticleCandidate([f.task],f.task,f.site,{...f.channel,singleSiteOnly:false}),false);
  assert.equal(renderSingleArticleCandidate([f.task,{...f.task,id:randomUUID(),siteId:randomUUID()}],f.task,f.site,f.channel),false);
  assert.equal(currentArticlePublicationContext([f.task],f.task).publicationIntent,'unknown');f.task.renderOriginalPurpose=renderOriginalPurpose(f.task);
  assert.equal(currentArticlePublicationContext([f.task],f.task).publicationIntent,'single_original_article');
  for(const changed of [{...f.task,id:randomUUID()},{...f.task,siteId:randomUUID()},{...f.task,draftRevision:2},{...f.task,draft:{...f.task.draft!,body:f.task.draft!.body+' changed'}},{...f.task,channelId:'leafmill'}])assert.equal(currentArticlePublicationContext([changed],changed).publicationIntent,'unknown');
  const state=emptyState();state.sites=[f.site];state.tasks=[f.task];state.accounts=[f.account];state.accountBindings=[{id:randomUUID(),siteId:f.site.id,channelId:'render',accountId:f.account.id,createdAt:at,updatedAt:at}];
  const secrets={[`account:${f.account.id}`]:JSON.stringify(credentialValue)};
  assert.deepEqual(validateBackup({state,secrets}).state.tasks[0].renderOriginalPurpose,f.task.renderOriginalPurpose);
  const bad=structuredClone(state);bad.tasks[0].renderOriginalPurpose={...f.task.renderOriginalPurpose,contentHash:'bad'};assert.throws(()=>validateBackup({state:bad,secrets}));
});

test('planner offers only the one connected software task for Render purpose review',()=>{
  const f=fixture(),state=emptyState();state.sites=[f.site];state.tasks=[{...f.task,channelId:'',sourceDomain:'',accountId:undefined}];state.accounts=[f.account];state.accountBindings=[{id:randomUUID(),siteId:f.site.id,channelId:'render',accountId:f.account.id,createdAt:at,updatedAt:at}];state.settings.channelOverrides.render=true;
  const match={channel:f.channel,score:100,reason:'software documentation'};
  assert.equal(channelExecutionReadiness(state,f.site.id,f.channel).kind,'ready');
  assert.equal(schedulableTaskMatches(state,state.tasks[0],[match],new Date(at)).length,1);
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(at))?.id,'render');
  state.tasks.push({...f.task,id:randomUUID(),siteId:randomUUID()});state.tasks[0].channelId='';state.tasks[0].sourceDomain='';
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(at)),undefined);
  state.tasks.pop();f.channel.termsCache={...f.channel.termsCache!,promotion:'forbidden'};
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(at)),undefined);
});

test('Render independent review binds exact original purpose while policy stays unknown',async()=>{
  const f=fixture();const review=await approved(f);
  assert.equal(channelTermsBlockReason(f.site,f.channel,f.channel.termsCache),'policy_unknown');
  assert.equal(articleReviewStillValid(f.task,f.site,f.channel,f.settings,f.account,currentArticlePublicationContext([f.task],f.task)),true);
  assert.equal(articleReviewStillValid({...f.task,renderOriginalPurpose:undefined},f.site,f.channel,f.settings,f.account,currentArticlePublicationContext([{...f.task,renderOriginalPurpose:undefined}],{...f.task,renderOriginalPurpose:undefined})),false);
  assert.equal(articleReviewStillValid({...f.task,draft:{...f.task.draft!,body:f.task.draft!.body+' changed'}},f.site,f.channel,f.settings,f.account,currentArticlePublicationContext([f.task],f.task)),false);
  assert.equal(review.policyAssessment?.citations[0].purpose,'hosting_purpose');
});


test('Render default closed, registry and native exact host rules are wired',async()=>{const c=CHANNELS.find(c=>c.id==='render')!;assert.equal(c.enabled,false);assert.equal(c.accessClass,'connect_once');assert.ok(publisherFor(c));const {batch5PublicChannel,batch5RenderedBodySelectors}=await import('../src/main/batch5-renderer');assert.equal(batch5PublicChannel('https://synthetic-example.onrender.com/'),'render');for(const u of ['http://synthetic-example.onrender.com/','https://synthetic-example.onrender.com/?q=1','https://synthetic-example.onrender.com/session','https://onrender.com/'])assert.equal(batch5PublicChannel(u),undefined);assert.deepEqual(batch5RenderedBodySelectors('render'),['main > article > section']);});

test('controller final Render source boundary rejects late disable, review, capacity, repository and credential changes',async()=>{
 for(const mode of ['disable','review','capacity','repository','credential']){
  const f=fixture();await approved(f);f.task.renderCapacity={version:1,source:'dashboard_observation',ownerId:owner.id,observedAt:new Date().toISOString(),plan:'hobby',paymentMethod:'none',pendingCharges:0,servicesUsed:0,bandwidthBytesUsed:0,pipelineMinutesUsed:0,activeBuilds:0,queuedBuilds:0,evidenceHash:'e'.repeat(64)};
  const store=new Store(':memory:');let controller:Controller|undefined;
  try{
   store.update(s=>{s.sites=[f.site];s.accounts=[f.account];s.tasks=[{...f.task,status:'running'}];s.accountBindings=[{id:randomUUID(),siteId:f.site.id,channelId:'render',accountId:f.account.id,createdAt:at,updatedAt:at}];s.settings.autoRun=true;s.settings.articleReviewMode='ai';s.settings.channelOverrides.render=true;s.channelTermsCache??={};s.channelTermsCache.render=f.channel.termsCache!});
   const vault={ready:true,available:()=>true,get:async(k:string)=>store.getCipher(k)?.slice(4),set:async()=>{},delete:async()=>{},encryptSecrets:(vs:Record<string,string>)=>Object.fromEntries(Object.entries(vs).map(([k,v])=>[k,'enc:'+v]))} as unknown as Vault;
   store.updateWithCiphers(()=>{},vault.encryptSecrets({[`account:${f.account.id}`]:JSON.stringify(credentialValue)}));let writes=0;
   controller=new Controller(store,vault,'fixture',{channelCatalog:[f.channel],batch5Dependencies:{fetch:async()=>{writes++;return json({})}}});store.update(s=>{s.tasks[0].status='running'});
   const context=(controller as unknown as {context:(task:Task,signal:AbortSignal)=>ExecutionContext}).context(store.read().tasks[0],new AbortController().signal),doc=renderDocument(context),url='https://api.github.com/repos/synthetic-owner/docs/contents/'+doc.rootDir+'/public/index.html';
   await context.batch5Dependencies!.fetch!(url,{method:'PUT',body:'synthetic'});assert.equal(writes,1);
   if(mode==='credential')store.updateWithCiphers(()=>{},vault.encryptSecrets({[`account:${f.account.id}`]:'changed'}));else store.update(s=>{if(mode==='disable')s.settings.channelOverrides.render=false;if(mode==='review')s.tasks[0].articleReview=undefined;if(mode==='capacity')s.tasks[0].renderCapacity=undefined;if(mode==='repository')s.accounts[0].renderSource!.repository='https://github.com/synthetic-owner/other';});
   await assert.rejects(async()=>context.batch5Dependencies!.fetch!(url,{method:'PUT',body:'synthetic'}));assert.equal(writes,1,mode);
  }finally{controller?.stop();store.close()}
 }
});
