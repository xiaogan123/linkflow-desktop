import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {NETLIFY_SINGLE_ARTICLE_DRAFT_RULE,SHIPSTATIC_SINGLE_ARTICLE_DRAFT_RULE,currentArticlePublicationContext,netlifyOriginalPurpose,netlifySingleArticleCandidate,shipstaticOriginalPurpose,shipstaticSingleArticleCandidate} from '../src/main/article-publication-context';
import {buildChannelTermsCache,reviewedChannelTermsCache} from '../src/main/article-evidence';
import {articleReviewStillValid,channelTermsBlockReason,reviewArticleDraft} from '../src/main/article-review';
import {validateBackup} from '../src/main/backup-validation';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {Controller} from '../src/main/controller';
import {emptyState,Store} from '../src/main/store';
import {schedulableTaskMatches,selectTaskPlatform} from '../src/main/planner';
import {CHANNELS} from '../src/integrations/catalog';
import {runNetlifyTask} from '../src/integrations/netlify-publisher';
import {runShipStaticTask} from '../src/integrations/shipstatic';
import type {Vault} from '../src/main/vault';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const at='2026-10-29T12:00:00.000Z',target='https://software.example.org/guide';
const policy='Publish original material. Do not create spam, bulk search manipulation, or affiliate link farms.';
const guidance='Create a deploy for your site from files you own. Static site content can include your own documentation.';
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fixture(){
  const site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Software Example',description:'Maintained software documentation',email:'owner@example.org',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:at,topics:[{url:target,discoveredAt:at}],qualifications:{software:'https://software.example.org/'}};
  const catalog=CHANNELS.find(item=>item.id==='netlify');assert.ok(catalog);
  const channel:Channel={...catalog,enabled:true};
  channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(channel,[{url:channel.rulesUrl,kind:'content_policy',text:policy,appliesTo:'netlify',applicability:'verified'},{url:'https://docs.netlify.com/deploy/create-deploys/',kind:'product_guidance',text:guidance,appliesTo:'netlify',applicability:'verified'}]),{finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'});
  const account:Account={id:randomUUID(),channelId:'netlify',email:'',username:'user-123',publicationUrl:'https://app.netlify.com/',createdAt:at,status:'registered',hasPassword:true,credentialKind:'api_token',source:'imported'};
  const task:Task={id:randomUUID(),siteId:site.id,channelId:'netlify',accountId:account.id,sourceDomain:channel.domain,status:'queued',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'test',draftRevision:1,topicUrl:target,draft:{title:'How to verify a software release',description:'A practical technical guide.',body:`Check the release notes and reproduce the configuration. See the [original guide](${target}) for maintained steps. Disclosure: we maintain Software Example. This note explains limitations and troubleshooting steps.`}};
  const settings={...emptyState().settings,articleReviewMode:'ai' as const};
  return {site,channel,account,task,settings};
}
async function approved(f:ReturnType<typeof fixture>){
  f.task.netlifyOriginalPurpose=netlifyOriginalPurpose(f.task);
  const review=await reviewArticleDraft(f.task,f.site,f.channel,f.settings,{json:async()=>({verdict:'pass',reason:'The independent troubleshooting guide is useful.',citations:[{url:f.site.url,quote:f.site.description}],policyAssessment:{useKind:'original_editorial',verdict:'compatible',reason:'The one original document fits static hosting and does not use bulk promotion.',citations:[{url:'https://docs.netlify.com/deploy/create-deploys/',quote:'Static site content can include your own documentation.',purpose:'hosting_purpose'},{url:f.channel.rulesUrl,quote:'Do not create spam, bulk search manipulation, or affiliate link farms.',purpose:'use_restriction'}]}} as never)},undefined,{account:f.account,publicationContext:currentArticlePublicationContext([f.task],f.task),fetchHtml:async url=>({url,html:`<main><p>${url===f.channel.rulesUrl?policy:url.includes('docs.netlify.com')?guidance:f.site.description}</p></main>`})});
  assert.equal(review.status,'passed',review.reason);f.task.articleReview=review;return review;
}

test('only one software document gains Netlify original-purpose context and survives backup',()=>{
  const f=fixture();assert.match(NETLIFY_SINGLE_ARTICLE_DRAFT_RULE,/原创静态技术文档/);
  assert.equal(netlifySingleArticleCandidate([f.task],f.task,f.site,f.channel),true);
  assert.equal(netlifySingleArticleCandidate([f.task],f.task,{...f.site,category:'finance'},f.channel),false);
  assert.equal(netlifySingleArticleCandidate([f.task],f.task,f.site,{...f.channel,singleSiteOnly:false}),false);
  assert.equal(netlifySingleArticleCandidate([f.task,{...f.task,id:randomUUID(),siteId:randomUUID()}],f.task,f.site,f.channel),false);
  assert.equal(currentArticlePublicationContext([f.task],f.task).publicationIntent,'unknown');f.task.netlifyOriginalPurpose=netlifyOriginalPurpose(f.task);
  assert.equal(currentArticlePublicationContext([f.task],f.task).publicationIntent,'single_original_article');
  for(const changed of [{...f.task,id:randomUUID()},{...f.task,siteId:randomUUID()},{...f.task,draftRevision:2},{...f.task,draft:{...f.task.draft!,body:f.task.draft!.body+' changed'}},{...f.task,channelId:'leafmill'}])assert.equal(currentArticlePublicationContext([changed],changed).publicationIntent,'unknown');
  const state=emptyState();state.sites=[f.site];state.tasks=[f.task];state.accounts=[f.account];
  const secrets={[`account:${f.account.id}`]:JSON.stringify({version:1,accessToken:'netlify-token-123456',userId:f.account.username})};
  assert.deepEqual(validateBackup({state,secrets}).state.tasks[0].netlifyOriginalPurpose,f.task.netlifyOriginalPurpose);
  const bad=structuredClone(state);bad.tasks[0].netlifyOriginalPurpose={...f.task.netlifyOriginalPurpose,contentHash:'bad'};assert.throws(()=>validateBackup({state:bad,secrets}));
});

test('planner offers only the one connected software task for Netlify purpose review',()=>{
  const f=fixture(),state=emptyState();state.sites=[f.site];state.tasks=[{...f.task,channelId:'',sourceDomain:'',accountId:undefined}];state.accounts=[f.account];state.accountBindings=[{id:randomUUID(),siteId:f.site.id,channelId:'netlify',accountId:f.account.id,createdAt:at,updatedAt:at}];state.settings.channelOverrides.netlify=true;
  const match={channel:f.channel,score:100,reason:'software documentation'};
  assert.equal(channelExecutionReadiness(state,f.site.id,f.channel).kind,'ready');
  assert.equal(schedulableTaskMatches(state,state.tasks[0],[match],new Date(at)).length,1);
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(at))?.id,'netlify');
  state.tasks.push({...f.task,id:randomUUID(),siteId:randomUUID()});state.tasks[0].channelId='';state.tasks[0].sourceDomain='';
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(at)),undefined);
  state.tasks.pop();f.channel.termsCache={...f.channel.termsCache!,promotion:'forbidden'};
  assert.equal(selectTaskPlatform(state,state.tasks[0],[match],new Date(at)),undefined);
});

test('Netlify independent review binds exact original purpose while policy stays unknown',async()=>{
  const f=fixture();const review=await approved(f);
  assert.equal(channelTermsBlockReason(f.site,f.channel,f.channel.termsCache),'policy_unknown');
  assert.equal(articleReviewStillValid(f.task,f.site,f.channel,f.settings,f.account,currentArticlePublicationContext([f.task],f.task)),true);
  assert.equal(articleReviewStillValid({...f.task,netlifyOriginalPurpose:undefined},f.site,f.channel,f.settings,f.account,currentArticlePublicationContext([{...f.task,netlifyOriginalPurpose:undefined}],{...f.task,netlifyOriginalPurpose:undefined})),false);
  assert.equal(articleReviewStillValid({...f.task,draft:{...f.task.draft!,body:f.task.draft!.body+' changed'}},f.site,f.channel,f.settings,f.account,currentArticlePublicationContext([f.task],f.task)),false);
  assert.equal(review.policyAssessment?.citations[0].purpose,'hosting_purpose');
});

test('controller rechecks Netlify review after the final guarded intent and prevents late POST',async()=>{
  const f=fixture();await approved(f);const store=new Store(':memory:');let controller:Controller|undefined;
  try{
    store.update(state=>{state.sites=[f.site];state.accounts=[f.account];state.tasks=[{...f.task,status:'running'}];state.accountBindings=[{id:randomUUID(),siteId:f.site.id,channelId:'netlify',accountId:f.account.id,createdAt:at,updatedAt:at}];state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides.netlify=true;state.channelTermsCache??={};state.channelTermsCache.netlify=f.channel.termsCache!});
    const credential=JSON.stringify({version:1,accessToken:'netlify-token-123456',userId:f.account.username});
    const vault={ready:true,available:()=>true,get:async(key:string)=>{const value=store.getCipher(key);return value?.startsWith('enc:')?Buffer.from(value.slice(4),'base64').toString():undefined},set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'enc:'+Buffer.from(value).toString('base64')]))} as unknown as Vault;
    store.updateWithCiphers(()=>{},vault.encryptSecrets({[`account:${f.account.id}`]:credential}));let posts=0;
    controller=new Controller(store,vault,'fixture',{channelCatalog:[f.channel],batch5Dependencies:{fetch:async(url,init)=>{if(init.method==='POST'){posts++;throw Error('must not POST')}if(url.endsWith('/user'))return json({id:f.account.username});if(url.endsWith('/accounts'))return json([{id:'team-123',type_name:'Free',has_stripe_payment_method:false,auto_topup_enabled:false,payment_method_id:null,owner_ids:[f.account.username]}]);throw Error(`unexpected ${url}`)}}});
    store.update(state=>{state.tasks[0].status='running'});
    const context=(controller as unknown as {context:(task:Task,signal:AbortSignal)=>ExecutionContext}).context(store.read().tasks[0],new AbortController().signal);
    const journal=context.batch5Persistence!;const original=journal.markSending!.bind(journal);
    journal.markSending=async intent=>{await original(intent);store.update(state=>{state.settings.channelOverrides.netlify=false})};
    const result=await runNetlifyTask(context);assert.equal(result.reasonCode,'submission_unknown',JSON.stringify(result));assert.equal(posts,0);
  }finally{controller?.stop();store.close()}
});

test('controller guards the Netlify visibility PATCH after owned-site GET and never retries unknown writes',async()=>{
 for(const changed of ['none','disabled','review','draft','identity','unknown'] as const){
  const f=fixture();await approved(f);const store=new Store(':memory:');let controller:Controller|undefined;
  try{
   store.update(state=>{state.sites=[f.site];state.accounts=[f.account];state.tasks=[{...f.task,status:'running'}];state.accountBindings=[{id:randomUUID(),siteId:f.site.id,channelId:'netlify',accountId:f.account.id,createdAt:at,updatedAt:at}];state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides.netlify=true;state.channelTermsCache??={};state.channelTermsCache.netlify=f.channel.termsCache!});
   const vault={ready:true,available:()=>true,get:async(key:string)=>{const value=store.getCipher(key);return value?.startsWith('enc:')?Buffer.from(value.slice(4),'base64').toString():undefined},set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'enc:'+Buffer.from(value).toString('base64')]))} as unknown as Vault;
   store.updateWithCiphers(()=>{},vault.encryptSecrets({[`account:${f.account.id}`]:JSON.stringify({version:1,accessToken:'netlify-token-123456',userId:f.account.username})}));
   const remoteId=randomUUID();let posts=0,patches=0,privateSite=true,html='';
   controller=new Controller(store,vault,'fixture',{channelCatalog:[f.channel],batch5Dependencies:{fetch:async(url,init)=>{
    if(url.endsWith('/user'))return json({id:f.account.username});
    if(url.endsWith('/accounts'))return json([{id:'team-123',type_name:'Free',has_stripe_payment_method:false,auto_topup_enabled:false,owner_ids:[f.account.username]}]);
    if(url.endsWith('/sites')&&init.method==='POST'){
     posts++;const z=Buffer.from(init.body as Uint8Array),start=30+z.readUInt16LE(26);html=z.subarray(start,start+z.readUInt32LE(18)).toString();
     return json({id:remoteId,deploy_id:'deploy_123',subdomain:'reviewed-guide'},201);
    }
    if(url.endsWith(`/sites/${remoteId}`)){
     if(init.method==='PATCH'){patches++;assert.equal(init.body,JSON.stringify({sso_login:false}));if(changed==='unknown')throw Error('lost PATCH response');privateSite=false}
     else store.update(state=>{if(changed==='disabled')state.settings.channelOverrides.netlify=false;if(changed==='review')state.tasks[0].articleReview=undefined;if(changed==='draft')state.tasks[0].draft!.body+=' changed';if(changed==='identity')state.accounts[0].username='other-user'});
     return json({id:remoteId,name:'reviewed-guide',account_id:'team-123',sso_login:privateSite,sso_login_context:'all',published_deploy:{id:'deploy_123',state:'ready'}});
    }
    if(url==='https://reviewed-guide.netlify.app/')return new Response(html,{status:privateSite?401:200,headers:{'content-type':'text/html'}});
    if(url.endsWith('/robots.txt'))return new Response('User-agent: *\nAllow: /\n');
    throw Error(`unexpected ${url}`);
   }}});
   store.update(state=>{state.tasks[0].status='running'});
   const context=(controller as unknown as {context:(task:Task,signal:AbortSignal)=>ExecutionContext}).context(store.read().tasks[0],new AbortController().signal);
   // This channel-specific boundary refuses unrelated project settings and endpoints.
   assert.throws(()=>context.batch5Dependencies!.fetch!(`https://api.netlify.com/api/v1/sites/${remoteId}`,{method:'PATCH',body:JSON.stringify({name:'other'})}));
   assert.throws(()=>context.batch5Dependencies!.fetch!('https://api.netlify.com/api/v1/accounts/team-123',{method:'PATCH',body:JSON.stringify({sso_login:false})}));
   const result=await runNetlifyTask(context);
   if(changed==='none'){assert.equal(result.status,'review');assert.equal(result.publicUrl,'https://reviewed-guide.netlify.app/');assert.equal(result.batch5?.stage,'api_receipt')}
   else assert.equal(result.reasonCode,'submission_unknown',changed);
   assert.equal(posts,1);assert.equal(patches,changed==='none'||changed==='unknown'?1:0,changed);
   await runNetlifyTask(context);assert.equal(posts,1);assert.equal(patches,changed==='none'||changed==='unknown'?1:0,changed);
  }finally{controller?.stop();store.close()}
 }
});

test('ShipStatic purpose is restricted to one unchanged software document and stays disabled without live acceptance',()=>{
  const f=fixture(),source=CHANNELS.find(item=>item.id==='shipstatic');assert.ok(source);assert.equal(source.enabled,false);
  const task:Task={...f.task,channelId:'shipstatic',sourceDomain:source.domain};
  assert.match(SHIPSTATIC_SINGLE_ARTICLE_DRAFT_RULE,/原创静态技术文档/);
  assert.equal(shipstaticSingleArticleCandidate([task],task,f.site,source),true);
  assert.equal(shipstaticSingleArticleCandidate([task],task,{...f.site,category:'finance'},source),false);
  assert.equal(shipstaticSingleArticleCandidate([task,{...task,id:randomUUID(),siteId:randomUUID()}],task,f.site,source),false);
  task.shipstaticOriginalPurpose=shipstaticOriginalPurpose(task);
  assert.equal(currentArticlePublicationContext([task],task).publicationIntent,'single_original_article');
  for(const changed of [{...task,draftRevision:2},{...task,draft:{...task.draft!,body:task.draft!.body+' changed'}},{...task,channelId:'netlify'}])
    assert.equal(currentArticlePublicationContext([changed],changed).publicationIntent,'unknown');
  const state=emptyState();state.sites=[f.site];state.tasks=[{...task,accountId:undefined}];state.settings.channelOverrides.shipstatic=true;
  assert.deepEqual(validateBackup({state,secrets:{}}).state.tasks[0].shipstaticOriginalPurpose,task.shipstaticOriginalPurpose);
  assert.equal(schedulableTaskMatches(state,task,[{channel:source,score:100,reason:'software'}],new Date(at)).length,0);
});

test('controller checks ShipStatic deployment POST and domain PUT at the final request boundary',async()=>{
  const f=fixture(),source=CHANNELS.find(item=>item.id==='shipstatic');assert.ok(source);
  const channel:Channel={...source,enabled:true};const account:Account={...f.account,channelId:'shipstatic',email:'owner@example.org',username:'owner@example.org',ownerSiteId:f.site.id,publicationUrl:'https://reviewed-software-guide.shipstatic.com/'};
  const task:Task={...f.task,channelId:'shipstatic',sourceDomain:source.domain,accountId:account.id};
  const store=new Store(':memory:');let controller:Controller|undefined;
  try{
    store.update(state=>{state.sites=[f.site];state.accounts=[account];state.tasks=[task];state.accountBindings=[{id:randomUUID(),siteId:f.site.id,channelId:'shipstatic',accountId:account.id,createdAt:at,updatedAt:at}];state.settings.autoRun=true;state.settings.channelOverrides.shipstatic=true});
    const vault={ready:true,available:()=>true,get:async()=>undefined,set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'enc:'+Buffer.from(value).toString('base64')]))} as unknown as Vault;
    let writes=0;controller=new Controller(store,vault,'fixture',{channelCatalog:[channel],batch5Dependencies:{fetch:async()=>{writes++;throw Error('must not write')}}});
    store.update(state=>{state.tasks[0].status='running'});
    const context=(controller as unknown as {context:(task:Task,signal:AbortSignal)=>ExecutionContext}).context(store.read().tasks[0],new AbortController().signal);
    store.update(state=>{state.settings.channelOverrides.shipstatic=false});
    for(const [url,method] of [['https://api.shipstatic.com/deployments','POST'],['https://api.shipstatic.com/domains/reviewed-software-guide.shipstatic.com','PUT']] as const)
      assert.throws(()=>context.batch5Dependencies!.fetch!(url,{method}),/发布条件已改变/);
    assert.equal(writes,0);
  }finally{controller?.stop();store.close()}
});

test('controller carries one reviewed ShipStatic task through deployment receipt to domain binding',async()=>{
  const f=fixture(),source=CHANNELS.find(item=>item.id==='shipstatic');assert.ok(source);
  const channel:Channel={...source,enabled:true};const restriction='Publish original material. Do not create spam, bulk search manipulation, or affiliate link farms.';
  const hosting='Create a deploy for a static site from files you own. Your own documentation can be hosted as site content.';
  channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(channel,[{url:channel.rulesUrl,kind:'content_policy',text:restriction,appliesTo:'shipstatic',applicability:'verified'},{url:'https://www.shipstatic.com/rules',kind:'content_policy',text:restriction,appliesTo:'shipstatic',applicability:'verified'},{url:'https://docs.shipstatic.com/domains',kind:'product_guidance',text:hosting,appliesTo:'shipstatic',applicability:'verified'}]),{finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'});
  const domain='reviewed-software-guide.shipstatic.com',remote='calm-bird-abc1234.shipstatic.com',key=`ship-${'a'.repeat(32)}`;
  const account:Account={...f.account,channelId:'shipstatic',email:'owner@example.org',username:'owner@example.org',ownerSiteId:f.site.id,publicationUrl:`https://${domain}/`};
  const task:Task={...f.task,channelId:'shipstatic',sourceDomain:source.domain,accountId:account.id};task.shipstaticOriginalPurpose=shipstaticOriginalPurpose(task);
  const review=await reviewArticleDraft(task,f.site,channel,f.settings,{json:async()=>({verdict:'pass',reason:'The technical guide is independently useful.',citations:[{url:f.site.url,quote:f.site.description}],policyAssessment:{useKind:'original_editorial',verdict:'compatible',reason:'One original document fits static hosting.',citations:[{url:'https://docs.shipstatic.com/domains',quote:'Your own documentation can be hosted as site content.',purpose:'hosting_purpose'},{url:channel.rulesUrl,quote:'Do not create spam, bulk search manipulation, or affiliate link farms.',purpose:'use_restriction'}]}} as never)},undefined,{account,publicationContext:currentArticlePublicationContext([task],task),fetchHtml:async url=>({url,html:`<main><p>${url.includes('docs.shipstatic.com')?hosting:url===f.site.url?f.site.description:restriction}</p></main>`})});
  assert.equal(review.status,'passed',review.reason);task.articleReview=review;
  const store=new Store(':memory:');let controller:Controller|undefined;
  try{
    store.update(state=>{state.sites=[f.site];state.accounts=[account];state.tasks=[task];state.accountBindings=[{id:randomUUID(),siteId:f.site.id,channelId:'shipstatic',accountId:account.id,createdAt:at,updatedAt:at}];state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides.shipstatic=true;state.channelTermsCache??={};state.channelTermsCache.shipstatic=channel.termsCache!});
    const vault={ready:true,available:()=>true,get:async(k:string)=>{const v=store.getCipher(k);return v?.startsWith('enc:')?Buffer.from(v.slice(4),'base64').toString():undefined},set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([k,v])=>[k,'enc:'+Buffer.from(v).toString('base64')]))} as unknown as Vault;
    store.updateWithCiphers(()=>{},vault.encryptSecrets({[`account:${account.id}`]:JSON.stringify({version:1,apiKey:key,email:account.email,domain})}));
    let posts=0,puts=0,bound=false,html='';
    controller=new Controller(store,vault,'fixture',{channelCatalog:[channel],batch5Dependencies:{fetch:async(url,init)=>{
      if(url==='https://api.shipstatic.com/account')return json({email:account.email,plan:'free',usage:{platformDomains:bound?1:0,deployments:posts},caps:{platformDomains:1,deployments:100}});
      if(url===`https://api.shipstatic.com/domains/${domain}`&&init.method==='GET')return bound?json({domain,url:`https://${domain}`,deployment:remote,status:'live',verification:'verified',paused:null}):json({error:'not_found'},404);
      if(url==='https://api.shipstatic.com/deployments'&&init.method==='POST'){posts++;html=await ((init.body as FormData).getAll('files[]')[0] as File).text();return json({deployment:remote,url:`https://${remote}`,status:'success',password:false},201)}
      if(url===`https://api.shipstatic.com/deployments/${remote}`)return json({deployment:remote,url:`https://${remote}`,status:'success',password:false});
      if(url===`https://api.shipstatic.com/domains/${domain}`&&init.method==='PUT'){puts++;bound=true;return json({domain,url:`https://${domain}`,deployment:remote,status:'live',verification:'verified',paused:null},201)}
      if(url===`https://${domain}/`)return new Response(html,{headers:{'content-type':'text/html'}});
      if(url===`https://${domain}/robots.txt`)return new Response('User-agent: *\nAllow: /');
      throw Error(`unexpected ${url}`);
    }}});
    store.update(state=>{state.tasks[0].status='running'});
    const context=(controller as unknown as {context:(task:Task,signal:AbortSignal)=>ExecutionContext}).context(store.read().tasks[0],new AbortController().signal);
    const result=await runShipStaticTask(context);assert.equal(result.status,'review',JSON.stringify(result));assert.equal(posts,1);assert.equal(puts,1);
    assert.equal(store.read().tasks[0].publicUrl,`https://${domain}/`);
  }finally{controller?.stop();store.close()}
});
