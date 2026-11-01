import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {OPENDOCS_SINGLE_ARTICLE_DRAFT_RULE,currentArticlePublicationContext,opendocsOriginalPurpose,opendocsSingleArticleCandidate} from '../src/main/article-publication-context';
import {buildChannelTermsCache,reviewedChannelTermsCache} from '../src/main/article-evidence';
import {articleReviewStillValid,channelTermsBlockReason,reviewArticleDraft} from '../src/main/article-review';
import {validateBackup} from '../src/main/backup-validation';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {Controller} from '../src/main/controller';
import {emptyState,Store} from '../src/main/store';
import {schedulableTaskMatches,selectTaskPlatform} from '../src/main/planner';
import {CHANNELS} from '../src/integrations/catalog';
import {runOpenDocsTask,verifyOpenDocsPublication,opendocsDocument} from '../src/integrations/opendocs';
import {connectPublisherToken} from '../src/main/publisher-token-management';
import {publisherFor} from '../src/integrations/publishers';
import type {Vault} from '../src/main/vault';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const owner={id:'synthetic-owner-id',username:'synthetic-owner'};const credentialValue={version:1,apiKey:'od_live_synthetic_key_1234567890',userId:owner.id,username:owner.username,workspaceId:'ws_synthetic123',workspaceSlug:'synthetic-workspace'};
const at='2026-10-29T12:00:00.000Z',target='https://software.example.org/guide';
const policy='Publish original material. Do not create spam, bulk search manipulation, or affiliate link farms.';
const guidance='Create a deploy for your site from files you own. Static site content can include your own documentation.';
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fixture(){
  const site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Software Example',description:'Maintained software documentation',email:'owner@example.org',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:at,topics:[{url:target,discoveredAt:at}],qualifications:{software:'https://software.example.org/'}};
  const catalog=CHANNELS.find(item=>item.id==='opendocs');assert.ok(catalog);
  const channel:Channel={...catalog,enabled:true};
  channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(channel,channel.evidenceSources!.map(s=>({...s,text:s.kind==='content_policy'?policy:guidance,appliesTo:'opendocs',applicability:'verified' as const}))),{finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'});
  const account:Account={id:randomUUID(),channelId:'opendocs',email:'',username:owner.id,publicationUrl:'https://opendocs.cc/synthetic-workspace',opendocs:{workspaceId:credentialValue.workspaceId,workspaceSlug:credentialValue.workspaceSlug,username:owner.username},ownerSiteId:site.id,createdAt:at,status:'registered',hasPassword:true,credentialKind:'api_token',source:'imported'};
  const task:Task={id:randomUUID(),siteId:site.id,channelId:'opendocs',accountId:account.id,sourceDomain:channel.domain,status:'queued',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'test',draftRevision:1,topicUrl:target,draft:{title:'How to verify a software release',description:'A practical technical guide.',body:`Check the release notes and reproduce the configuration. See the [original guide](${target}) for maintained steps. Disclosure: we maintain Software Example. This note explains limitations and troubleshooting steps.`}};
  const settings={...emptyState().settings,articleReviewMode:'ai' as const};
  return {site,channel,account,task,settings};
}
async function approved(f:ReturnType<typeof fixture>){
  f.task.opendocsOriginalPurpose=opendocsOriginalPurpose(f.task);
  const review=await reviewArticleDraft(f.task,f.site,f.channel,f.settings,{json:async()=>({verdict:'pass',reason:'The independent troubleshooting guide is useful.',citations:[{url:f.site.url,quote:f.site.description}],policyAssessment:{useKind:'original_editorial',verdict:'compatible',reason:'The one original document fits static hosting and does not use bulk promotion.',citations:[{url:'https://docs.opendocs.cc/api-reference/publish',quote:'Static site content can include your own documentation.',purpose:'hosting_purpose'},{url:f.channel.rulesUrl,quote:'Do not create spam, bulk search manipulation, or affiliate link farms.',purpose:'use_restriction'}]}} as never)},undefined,{account:f.account,publicationContext:currentArticlePublicationContext([f.task],f.task),fetchHtml:async url=>({url,html:`<main><p>${f.channel.termsCache!.sources.find(s=>s.url===url)?.text??f.site.description}</p></main>`})});
  assert.equal(review.status,'passed',review.reason);f.task.articleReview=review;return review;
}

test('only one software document gains OpenDocs original-purpose context and survives backup',()=>{
  const f=fixture();assert.match(OPENDOCS_SINGLE_ARTICLE_DRAFT_RULE,/原创静态技术文档/);
  assert.equal(opendocsSingleArticleCandidate([f.task],f.task,f.site,f.channel),true);
  assert.equal(opendocsSingleArticleCandidate([f.task],f.task,{...f.site,category:'finance'},f.channel),false);
  assert.equal(opendocsSingleArticleCandidate([f.task],f.task,f.site,{...f.channel,singleSiteOnly:false}),false);
  assert.equal(opendocsSingleArticleCandidate([f.task,{...f.task,id:randomUUID(),siteId:randomUUID()}],f.task,f.site,f.channel),false);
  assert.equal(currentArticlePublicationContext([f.task],f.task).publicationIntent,'unknown');f.task.opendocsOriginalPurpose=opendocsOriginalPurpose(f.task);
  assert.equal(currentArticlePublicationContext([f.task],f.task).publicationIntent,'single_original_article');
  for(const changed of [{...f.task,id:randomUUID()},{...f.task,siteId:randomUUID()},{...f.task,draftRevision:2},{...f.task,draft:{...f.task.draft!,body:f.task.draft!.body+' changed'}},{...f.task,channelId:'leafmill'}])assert.equal(currentArticlePublicationContext([changed],changed).publicationIntent,'unknown');
  const state=emptyState();state.sites=[f.site];state.tasks=[f.task];state.accounts=[f.account];state.accountBindings=[{id:randomUUID(),siteId:f.site.id,channelId:'opendocs',accountId:f.account.id,createdAt:at,updatedAt:at}];
  const secrets={[`account:${f.account.id}`]:JSON.stringify(credentialValue)};
  assert.deepEqual(validateBackup({state,secrets}).state.tasks[0].opendocsOriginalPurpose,f.task.opendocsOriginalPurpose);
  const bad=structuredClone(state);bad.tasks[0].opendocsOriginalPurpose={...f.task.opendocsOriginalPurpose,contentHash:'bad'};assert.throws(()=>validateBackup({state:bad,secrets}));
});

test('planner offers only the one connected software task for OpenDocs purpose review',()=>{
  const f=fixture(),state=emptyState();state.sites=[f.site];state.tasks=[{...f.task,channelId:'',sourceDomain:'',accountId:undefined}];state.accounts=[f.account];state.accountBindings=[{id:randomUUID(),siteId:f.site.id,channelId:'opendocs',accountId:f.account.id,createdAt:at,updatedAt:at}];state.settings.channelOverrides.opendocs=true;
  const match={channel:f.channel,score:100,reason:'software documentation'};
  assert.equal(channelExecutionReadiness(state,f.site.id,f.channel).kind,'ready');
  assert.equal(schedulableTaskMatches(state,state.tasks[0],[match],new Date(at)).length,1);
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(at))?.id,'opendocs');
  state.tasks.push({...f.task,id:randomUUID(),siteId:randomUUID()});state.tasks[0].channelId='';state.tasks[0].sourceDomain='';
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(at)),undefined);
  state.tasks.pop();f.channel.termsCache={...f.channel.termsCache!,promotion:'forbidden'};
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(at)),undefined);
});

test('OpenDocs independent review binds exact original purpose while policy stays unknown',async()=>{
  const f=fixture();const review=await approved(f);
  assert.equal(channelTermsBlockReason(f.site,f.channel,f.channel.termsCache),'policy_unknown');
  assert.equal(articleReviewStillValid(f.task,f.site,f.channel,f.settings,f.account,currentArticlePublicationContext([f.task],f.task)),true);
  assert.equal(articleReviewStillValid({...f.task,opendocsOriginalPurpose:undefined},f.site,f.channel,f.settings,f.account,currentArticlePublicationContext([{...f.task,opendocsOriginalPurpose:undefined}],{...f.task,opendocsOriginalPurpose:undefined})),false);
  assert.equal(articleReviewStillValid({...f.task,draft:{...f.task.draft!,body:f.task.draft!.body+' changed'}},f.site,f.channel,f.settings,f.account,currentArticlePublicationContext([f.task],f.task)),false);
  assert.equal(review.policyAssessment?.citations[0].purpose,'hosting_purpose');
});


const me=()=>({authenticated:true,userId:owner.id,onboarding:{completed:true,username:owner.username,workspace:{id:credentialValue.workspaceId,slug:credentialValue.workspaceSlug,name:'Synthetic Workspace'}},quota:{documents:{plan:'free',limit:50,used:0,remaining:50}}});
const workspaces=()=>({workspaces:[{id:credentialValue.workspaceId,slug:credentialValue.workspaceSlug,name:'Synthetic Workspace',role:'owner'}]});
test('ordinary production connection, planner, V5 and Controller publish need no private budget or hand-filled task input',async()=>{
 for(const revoke of [false,true]){const f=fixture(),store=new Store(':memory:');let controller:Controller|undefined;try{
  store.update(s=>{s.sites=[f.site];s.settings.autoRun=false});
  const vault={ready:true,available:()=>true,get:async(k:string)=>store.getCipher(k)?.slice(4),set:async()=>{},delete:async()=>{},encryptSecrets:(vs:Record<string,string>)=>Object.fromEntries(Object.entries(vs).map(([k,v])=>[k,'enc:'+v]))} as unknown as Vault;
  let posts=0;const gets:string[]=[];const fetch=async(url:string,init:RequestInit)=>{if(init.method==='POST'){posts++;const d=JSON.parse(String(init.body));return json({postId:'post_synthetic123',slug:d.slug,title:d.title,url:'/synthetic-workspace/'+d.slug,publicUrl:'https://opendocs.cc/synthetic-workspace/'+d.slug},201)}gets.push(url);if(url.startsWith('https://api.opendocs.cc/api/v1/me'))return json(me());if(url==='https://api.opendocs.cc/api/v1/workspaces')return json(workspaces());if(url==='https://opendocs.cc/synthetic-workspace')return new Response('<html><head><link rel=canonical href="https://opendocs.cc/synthetic-workspace"></head><body><main>Public profile</main></body></html>',{headers:{'content-type':'text/html'}});throw Error('unexpected')};
  f.account=await connectPublisherToken(store,vault,{channelId:'opendocs',token:credentialValue.apiKey,siteIds:[f.site.id]},{fetch});f.task.accountId=f.account.id;await approved(f);assert.deepEqual(f.account.opendocs,{workspaceId:credentialValue.workspaceId,workspaceSlug:credentialValue.workspaceSlug,username:owner.username});
  const backup={state:store.read(),secrets:{[`account:${f.account.id}`]:store.getCipher(`account:${f.account.id}`)!.slice(4)}};assert.doesNotThrow(()=>validateBackup(backup));
  store.update(s=>{s.tasks=[{...f.task,status:'running'}];s.settings.autoRun=true;s.settings.articleReviewMode='ai';s.settings.channelOverrides.opendocs=true;s.channelTermsCache??={};s.channelTermsCache.opendocs=f.channel.termsCache!});controller=new Controller(store,vault,'fixture',{channelCatalog:[f.channel],batch5Dependencies:{fetch}});store.update(s=>{s.tasks[0].status='running'});
  const context=(controller as unknown as {context:(t:Task,s:AbortSignal)=>ExecutionContext}).context(store.read().tasks[0],new AbortController().signal);if(revoke){const p=context.batch5Persistence!,mark=p.markSending!.bind(p);p.markSending=async i=>{await mark(i);store.update(s=>{s.settings.channelOverrides.opendocs=false})}}
  const result=await runOpenDocsTask(context);assert.equal(posts,revoke?0:1);if(revoke)assert.equal(result.reasonCode,'submission_unknown');else assert.match(result.publicUrl??'',/^https:\/\/opendocs.cc\/synthetic-workspace\/task-/);assert.ok(gets.includes('https://api.opendocs.cc/api/v1/me?workspaceId='+credentialValue.workspaceId));assert.equal('renderCapacity' in context.task,false);
 }finally{controller?.stop();store.close()}}
});
test('OpenDocs default closed and native reader accepts only original fixed document paths',async()=>{const c=CHANNELS.find(c=>c.id==='opendocs')!;assert.equal(c.enabled,false);assert.equal(c.accessClass,'connect_once');assert.ok(publisherFor(c));const {batch5PublicChannel,batch5RenderedBodySelectors}=await import('../src/main/batch5-renderer');assert.equal(batch5PublicChannel('https://opendocs.cc/synthetic-workspace/task-'+'a'.repeat(24)),'opendocs');for(const url of ['https://opendocs.cc/dashboard','https://opendocs.cc/workspace/task-'+'a'.repeat(24)+'?token=private','https://evil.example.org/workspace/task-'+'a'.repeat(24)])assert.equal(batch5PublicChannel(url),undefined);assert.deepEqual(batch5RenderedBodySelectors('opendocs'),['main article.md-typeset']);});
