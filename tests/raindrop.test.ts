import test from 'node:test';
import assert from 'node:assert/strict';
import {Store,defaultSettings,emptyState} from '../src/main/store';
import {validateBackup} from '../src/main/backup-validation';
import {connectRaindrop,discoverRaindropCollections} from '../src/main/raindrop-management';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {listRaindropCollections,raindropTesting,raindropTokenFingerprint,reconcileRaindropTask,runRaindropTask,verifyRaindropPublicCollection,verifyRaindropTask,type RaindropTransport} from '../src/integrations/raindrop';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const NOW='2026-10-10T12:00:00.000Z',TOKEN='synthetic-raindrop-token-12345',OWNER='32',COLLECTION='66';
const SITE_ID='11111111-1111-4111-8111-111111111111',ACCOUNT_ID='22222222-2222-4222-8222-222222222222',TASK_ID='33333333-3333-4333-8333-333333333333';
const PUBLIC='https://writer.raindrop.page/resources',TARGET='https://example.com/research/source-checking',TITLE='A reproducible source-checking workflow';
const EXCERPT='Commercial relationship disclosure: this resource review promotes the linked site and explains one reproducible source-checking step without promising results.';

function channel():Channel{return {id:'raindrop',name:'Raindrop',domain:'raindrop.page',url:'https://raindrop.io/',submitUrl:'https://app.raindrop.io/',categories:['content'],languages:['*'],kind:'community',emailRequired:true,accountRequired:true,articleRequired:true,contentFormat:'social',free:'yes',freeNote:'',automation:'api',quality:'C',qualityReason:'resource curation',rulesUrl:'https://help.raindrop.io/terms',checkedAt:'2026-10-10',notes:'',allowedHosts:['raindrop.io','raindrop.page'],enabled:true};}
function site():Site{return {id:SITE_ID,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example Research',description:'Source research',category:'content',language:'en',monthlyTarget:2,status:'ready',createdAt:NOW};}
function remoteItem(id='900',overrides:Record<string,unknown>={}){return {_id:Number(id),user:{$id:Number(OWNER)},collection:{$id:Number(COLLECTION)},link:TARGET,title:TITLE,excerpt:EXCERPT,created:NOW,...overrides};}
function publicHtml(items:Record<string,unknown>[]=[],options:{parent?:unknown;hide?:string[];optionHide?:string;anchorTarget?:string;visibleExcerpt?:string}={}){
  const page={pageId:'/src/pages/collection/view/index',routeParams:{id:COLLECTION,user_name:'writer'},data:{collection:{_id:Number(COLLECTION),title:'Research resources',public:true,parent:options.parent===undefined?null:options.parent,view:'list',user:{$id:Number(OWNER)}},user:{_id:Number(OWNER),config:{raindrops_hide:options.hide??[]}},options:{hide:options.optionHide??''},raindrops:{items}}};
  return `<!doctype html><html><head><link rel="canonical" href="${PUBLIC}"></head><body><script id="vike_pageContext" type="application/json">${JSON.stringify(page)}</script>${items.map(item=>`<article><h2>${String(item.title)}</h2><p>${options.visibleExcerpt??String(item.excerpt)}</p><a href="${options.anchorTarget??String(item.link)}" rel="nofollow noopener noreferrer">Open resource</a></article>`).join('')}</body></html>`;
}
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})}
function html(value:string,status=200){return new Response(value,{status,headers:{'content-type':'text/html'}})}
function collectionItem(overrides:Record<string,unknown>={}){return {_id:Number(COLLECTION),title:'Research resources',public:true,parent:null,user:{$id:Number(OWNER)},access:{level:4},...overrides}}

function fixture(){
  const s=site(),c=channel(),settings={...defaultSettings(),articleReviewMode:'ai' as const};
  const account:Account={id:ACCOUNT_ID,channelId:'raindrop',email:'',username:OWNER,displayName:'Research resources',publicationUrl:PUBLIC,credentialKind:'api_token',hasPassword:true,status:'registered',source:'imported',createdAt:NOW,updatedAt:NOW,verifiedAt:NOW,raindrop:{version:1,ownerId:OWNER,collectionId:COLLECTION,publicUrl:PUBLIC,tokenFingerprint:'a'.repeat(64),tokenVersion:1,connectedAt:NOW}};
  const task:Task={id:TASK_ID,siteId:SITE_ID,channelId:'raindrop',accountId:ACCOUNT_ID,sourceDomain:'raindrop.page',status:'running',createdAt:NOW,scheduledAt:NOW,updatedAt:NOW,attempts:1,message:'',topicUrl:TARGET,draftRevision:1,draft:{title:TITLE,description:'local only',body:EXCERPT}};
  task.articleReview={status:'passed',reason:'review passed',reasonCode:'passed',reviewContractVersion:4,evidenceUrls:[],draftRevision:1,contentHash:articleContentHash(task),contextHash:articleContextHash(s,c,settings,account),reviewedAt:NOW};
  const checkpoints:Partial<Task>[]=[],secrets=new Map([[`account:${ACCOUNT_ID}`,TOKEN]]);
  const abort=new AbortController();
  const context:ExecutionContext={site:s,task,channel:c,settings,signal:abort.signal,ai:{json:async<T>()=>({} as T)},secrets:{get:async key=>secrets.get(key),set:async(key,value)=>{secrets.set(key,value)},delete:async key=>{secrets.delete(key)}},getAccount:()=>account,saveAccount:async()=>undefined,checkpoint:partial=>{checkpoints.push(structuredClone(partial));Object.assign(task,partial)},log:()=>undefined};
  return {task,account,context,checkpoints,abort};
}

test('collection discovery returns string owners and never promotes a child to a selectable root',async()=>{
  const fetch:RaindropTransport=async url=>url.endsWith('/collections')?json({result:true,items:[collectionItem()]}):json({result:true,items:[collectionItem({_id:77,parent:null})]});
  const result=await listRaindropCollections(TOKEN,{fetch});
  assert.equal(result.ownerId,OWNER);assert.equal(result.collections[0].ownerId,OWNER);assert.equal(result.collections[1].parentId,'unknown');
});

test('public binding rejects nested collections and hidden excerpts but accepts one strict visible root page',async()=>{
  await assert.rejects(verifyRaindropPublicCollection(PUBLIC,COLLECTION,OWNER,{fetch:async()=>html(publicHtml([],{parent:{$id:1}}))}),/mismatch|failed/);
  await assert.rejects(verifyRaindropPublicCollection(PUBLIC,COLLECTION,OWNER,{fetch:async()=>html(publicHtml([],{hide:['list_excerpt']}))}),/隐藏了标题或摘要/);
  assert.deepEqual(await verifyRaindropPublicCollection(PUBLIC,COLLECTION,OWNER,{fetch:async()=>html(publicHtml())}),{title:'Research resources',view:'list'});
});

test('connection atomically stores the token and exact owner/collection/site binding without returning the secret',async()=>{
  const store=new Store(':memory:');try{
    store.update(state=>state.sites=[site()]);
    const vault={encryptSecrets:(values:Record<string,string>)=>values};
    const fetch:RaindropTransport=async url=>url.endsWith('/collections')?json({result:true,items:[collectionItem()]}):url.endsWith('/collections/childrens')?json({result:true,items:[]}):url.endsWith(`/collection/${COLLECTION}`)?json({result:true,item:collectionItem()}):html(publicHtml());
    const discovered=await discoverRaindropCollections(TOKEN,{fetch});assert.equal(discovered.ownerId,OWNER);
    const account=await connectRaindrop(store,vault,{token:TOKEN,collectionId:COLLECTION,publicUrl:PUBLIC,siteIds:[SITE_ID]},{fetch});
    assert.equal(account.raindrop?.ownerId,OWNER);assert.equal(JSON.stringify(account).includes(TOKEN),false);assert.equal(store.getCipher(`account:${account.id}`),TOKEN);assert.equal(store.read().accountBindings[0].accountId,account.id);
  }finally{store.close()}
});

test('a stale connection request cannot overwrite a newer public URL with pending history',async()=>{
  const store=new Store(':memory:'),newPublic='https://writer.raindrop.page/resources-new';try{
    const existing=fixture().account;existing.raindrop!.tokenFingerprint=raindropTokenFingerprint(TOKEN);store.update(state=>{state.sites=[site()];state.accounts=[existing];state.accountBindings=[{id:'44444444-4444-4444-8444-444444444444',siteId:SITE_ID,channelId:'raindrop',accountId:ACCOUNT_ID,createdAt:NOW,updatedAt:NOW}]});
    let injected=false;const fetch:RaindropTransport=async url=>{if(url.endsWith('/collections'))return json({result:true,items:[collectionItem()]});if(url.endsWith('/collections/childrens'))return json({result:true,items:[]});if(url.endsWith(`/collection/${COLLECTION}`))return json({result:true,item:collectionItem()});if(url===PUBLIC&&!injected){injected=true;store.update(state=>{const account=state.accounts[0];account.publicationUrl=newPublic;account.raindrop!.publicUrl=newPublic;account.updatedAt='2026-10-10T12:01:00.000Z';state.tasks=[{...fixture().task,status:'review',submittedAt:NOW,publicUrl:newPublic}]});return html(publicHtml())}throw Error(`unexpected ${url}`)};
    await assert.rejects(connectRaindrop(store,{encryptSecrets:values=>values},{token:TOKEN,collectionId:COLLECTION,publicUrl:PUBLIC,siteIds:[SITE_ID],accountId:ACCOUNT_ID},{fetch}),/连接期间发生变化/);
    assert.equal(store.read().accounts[0].raindrop?.publicUrl,newPublic);assert.equal(store.read().tasks[0].publicUrl,newPublic);
  }finally{store.close()}
});

test('publisher persists baseline and intent before one POST, sends reviewed body exactly, then requires API and public DOM agreement',async()=>{
  const f=fixture(),calls:string[]=[];let created=false;
  const fetch:RaindropTransport=async(url,init)=>{calls.push(`${init.method} ${url}`);const path=new URL(url).pathname;
    if(path===`/rest/v1/raindrops/${COLLECTION}`)return json({result:true,items:created?[remoteItem()]:[]});
    if(path===`/rest/v1/collection/${COLLECTION}`)return json({result:true,item:collectionItem()});
    if(path==='/rest/v1/raindrop'&&init.method==='POST'){assert.equal(f.task.checkpoint,'raindrop_submitting');const body=JSON.parse(String(init.body));assert.deepEqual(body,{link:TARGET,title:TITLE,excerpt:EXCERPT,collection:{$id:Number(COLLECTION)},type:'link'});created=true;return json({result:true,item:remoteItem()})}
    if(path==='/rest/v1/raindrop/900')return json({result:true,item:remoteItem()});
    if(url===PUBLIC)return html(publicHtml());if(url.startsWith(`${PUBLIC}/view/`))return html(publicHtml([remoteItem()]));throw Error(`unexpected ${url}`);
  };
  const result=await runRaindropTask(f.context,{fetch,now:()=>NOW});
  assert.equal(result.raindrop?.stage,'published');assert.equal(result.checkpoint,'raindrop_published');assert.deepEqual(f.checkpoints.map(value=>value.checkpoint),['raindrop_prepared','raindrop_submitting','raindrop_api_receipt']);assert.equal(calls.filter(value=>value.includes('POST')).length,1);
  Object.assign(f.task,result);const verified=await verifyRaindropTask(f.context,{fetch});assert.equal(verified.found,true);assert.match(verified.rel,/nofollow/);
});

test('first POST accepts current manual approval but rejects missing manual approval and stale AI review before network',async()=>{
  const manual=fixture();manual.context.site.articleReviewMode='manual';manual.task.articleReview=undefined;manual.task.articleApprovedAt=NOW;let manualPosts=0;
  const fetch:RaindropTransport=async(url,init)=>{const path=new URL(url).pathname;if(path===`/rest/v1/raindrops/${COLLECTION}`)return json({result:true,items:[]});if(path===`/rest/v1/collection/${COLLECTION}`)return json({result:true,item:collectionItem()});if(url===PUBLIC)return html(publicHtml());if(path==='/rest/v1/raindrop'&&init.method==='POST'){manualPosts++;throw Error('synthetic unknown outcome')}throw Error(`unexpected ${url}`)};
  const result=await runRaindropTask(manual.context,{fetch,now:()=>NOW});assert.equal(manualPosts,1);assert.equal(result.raindrop?.stage,'submitting');

  const unapproved=fixture();unapproved.context.site.articleReviewMode='manual';unapproved.task.articleReview=undefined;let unapprovedRequests=0;
  await assert.rejects(runRaindropTask(unapproved.context,{fetch:async()=>{unapprovedRequests++;return json({result:true})}}),/人工批准/);assert.equal(unapprovedRequests,0);

  const staleAi=fixture();staleAi.task.articleReview!.contentHash='0'.repeat(64);let staleRequests=0;
  await assert.rejects(runRaindropTask(staleAi.context,{fetch:async()=>{staleRequests++;return json({result:true})}}),/独立审核/);assert.equal(staleRequests,0);
});

test('unknown POST outcome is reconciled by bounded reads and a rerun never POSTs again',async()=>{
  const f=fixture();let posts=0,committed=false;
  const fetch:RaindropTransport=async(url,init)=>{const path=new URL(url).pathname;
    if(path===`/rest/v1/raindrops/${COLLECTION}`)return json({result:true,items:committed?[remoteItem()]:[]});
    if(path===`/rest/v1/collection/${COLLECTION}`)return json({result:true,item:collectionItem()});
    if(path==='/rest/v1/raindrop'&&init.method==='POST'){posts++;committed=true;throw Error('socket reset')}
    if(path==='/rest/v1/raindrop/900')return json({result:true,item:remoteItem()});
    if(url===PUBLIC)return html(publicHtml());if(url.startsWith(`${PUBLIC}/view/`))return html(publicHtml([remoteItem()]));throw Error(`unexpected ${url}`);
  };
  const unknown=await runRaindropTask(f.context,{fetch,now:()=>NOW});assert.equal(unknown.raindrop?.stage,'submitting');assert.equal(posts,1);Object.assign(f.task,unknown);f.task.articleReview=undefined;f.task.articleApprovedAt=undefined;
  const postsBeforeRecovery=posts,recovered=await reconcileRaindropTask(f.context,{fetch,now:()=>NOW});assert.equal(recovered.status,'found');assert.equal(posts,postsBeforeRecovery);
  const rerun=await runRaindropTask(f.context,{fetch,now:()=>NOW});assert.equal(rerun.status,'review');assert.equal(posts,1);
});

test('a pre-existing target blocks creation and does not count as a new publish',async()=>{
  const f=fixture();let posts=0;const fetch:RaindropTransport=async(url,init)=>{if(init.method==='POST')posts++;return json({result:true,items:[remoteItem('800')]})};
  const result=await runRaindropTask(f.context,{fetch});assert.equal(result.status,'needs_input');assert.match(result.message,/已有相同目标/);assert.equal(posts,0);assert.equal(f.task.raindrop,undefined);
});

test('strict backup preserves every durable Raindrop intent stage and rejects receipt or token tampering',()=>{
  const make=(stage:'prepared'|'submitting'|'api_receipt'|'published')=>{const state=emptyState(),account=fixture().account,task=fixture().task;account.raindrop!.tokenFingerprint=raindropTokenFingerprint(TOKEN);state.sites=[site()];state.accounts=[account];state.accountBindings=[{id:'44444444-4444-4444-8444-444444444444',siteId:SITE_ID,channelId:'raindrop',accountId:ACCOUNT_ID,createdAt:NOW,updatedAt:NOW}];task.status='review';task.health='pending';task.submittedAt=NOW;task.raindrop={operationId:`raindrop_${TASK_ID.replaceAll('-','')}`,ownerId:OWNER,collectionId:COLLECTION,tokenVersion:1,target:TARGET,title:TITLE,excerpt:EXCERPT,payloadHash:raindropTesting.payloadHash(TARGET,TITLE,EXCERPT,COLLECTION),createdAt:NOW,baselineItemIds:['800'],baselineComplete:stage!=='prepared',stage,...(['api_receipt','published'].includes(stage)?{itemId:'900',remoteCreatedAt:NOW}:{})};task.checkpoint=`raindrop_${stage}`;if(['api_receipt','published'].includes(stage))task.publicUrl=PUBLIC;state.tasks=[task];return {state,secrets:{[`account:${ACCOUNT_ID}`]:TOKEN}}};
  for(const stage of ['prepared','submitting','api_receipt','published'] as const){const backup=make(stage),restored=validateBackup(structuredClone(backup));assert.equal(restored.state.tasks[0].raindrop?.stage,stage);assert.equal(restored.secrets[`account:${ACCOUNT_ID}`],TOKEN)}
  const rotatedToken='synthetic-raindrop-token-rotated';const rotated=make('published');rotated.state.tasks[0].status='live';rotated.state.tasks[0].health='healthy';rotated.state.tasks[0].linkCheck='found';rotated.state.tasks[0].firstLiveAt=NOW;rotated.state.tasks[0].verifiedAt=NOW;rotated.state.accounts[0].raindrop!.tokenVersion=2;rotated.state.accounts[0].raindrop!.tokenFingerprint=raindropTokenFingerprint(rotatedToken);rotated.secrets[`account:${ACCOUNT_ID}`]=rotatedToken;assert.equal(validateBackup(rotated).state.tasks[0].raindrop?.tokenVersion,1);
  const unresolvedOldVersion=make('submitting');unresolvedOldVersion.state.accounts[0].raindrop!.tokenVersion=2;unresolvedOldVersion.state.accounts[0].raindrop!.tokenFingerprint=raindropTokenFingerprint(rotatedToken);unresolvedOldVersion.secrets[`account:${ACCOUNT_ID}`]=rotatedToken;assert.throws(()=>validateBackup(unresolvedOldVersion),/Raindrop/);
  const altered=make('submitting');altered.state.tasks[0].raindrop!.excerpt+=' changed';assert.throws(()=>validateBackup(altered),/Raindrop/);
  const wrongToken=make('submitting');wrongToken.secrets[`account:${ACCOUNT_ID}`]='synthetic-raindrop-token-other';assert.throws(()=>validateBackup(wrongToken),/Raindrop Test token/);
});

test('public visibility rejects a hidden article ancestor and a hidden direct-link ancestor',()=>{
  const receipt={operationId:'raindrop_fixture',ownerId:OWNER,collectionId:COLLECTION,tokenVersion:1,target:TARGET,title:TITLE,excerpt:EXCERPT,payloadHash:'a'.repeat(64),createdAt:NOW,baselineItemIds:[],baselineComplete:true,stage:'published' as const,itemId:'900',remoteCreatedAt:NOW};
  const base=publicHtml([remoteItem()]);
  const hiddenArticle=base.replace('<body>','<body><main hidden>').replace('</body>','</main></body>');
  const hiddenAnchor=base.replace(`<a href="${TARGET}"`,`<span hidden><a href="${TARGET}"`).replace('</a></article>','</a></span></article>');
  for(const page of [hiddenArticle,hiddenAnchor]){
    const context=raindropTesting.parsePublicContext(page,new Headers(),PUBLIC);
    assert.equal(raindropTesting.visibleMatch(context,receipt),undefined);
  }
});

test('public visibility rejects a page that immediately redirects with meta refresh',()=>{
  const receipt={operationId:'raindrop_fixture',ownerId:OWNER,collectionId:COLLECTION,tokenVersion:1,target:TARGET,title:TITLE,excerpt:EXCERPT,payloadHash:'a'.repeat(64),createdAt:NOW,baselineItemIds:[],baselineComplete:true,stage:'published' as const,itemId:'900',remoteCreatedAt:NOW};
  const page=publicHtml([remoteItem()]).replace('<head>',`<head><meta http-equiv="refresh" content="0;url=https://other.example/">`);
  const context=raindropTesting.parsePublicContext(page,new Headers(),PUBLIC);
  assert.equal(raindropTesting.visibleMatch(context,receipt),undefined);
});

test('unsafe numeric collection ids are rejected before Number conversion or network access',async()=>{
  const f=fixture();f.account.raindrop!.collectionId='90071992547409931234';let requests=0;
  await assert.rejects(runRaindropTask(f.context,{fetch:async()=>{requests++;return json({result:true})}}),/连接本人 Raindrop/);assert.equal(requests,0);
});

test('publisher rechecks root ownership, write access, public state and public-page binding immediately before POST',async()=>{
  for(const changed of [collectionItem({public:false}),collectionItem({parent:{$id:9}}),collectionItem({access:{level:2}}),collectionItem({user:{$id:99}})]){
    const f=fixture();let posts=0;const fetch:RaindropTransport=async(url,init)=>{const path=new URL(url).pathname;if(path===`/rest/v1/raindrops/${COLLECTION}`)return json({result:true,items:[]});if(path===`/rest/v1/collection/${COLLECTION}`)return json({result:true,item:changed});if(init.method==='POST')posts++;throw Error(`unexpected ${url}`)};
    await assert.rejects(runRaindropTask(f.context,{fetch}),/Raindrop/);assert.equal(posts,0);assert.equal(f.task.raindrop,undefined);
  }
});

test('known receipt reconciliation rejects an API object with a different item id even when content matches',async()=>{
  const f=fixture();const receipt={operationId:`raindrop_${TASK_ID.replaceAll('-','')}`,ownerId:OWNER,collectionId:COLLECTION,tokenVersion:1,target:TARGET,title:TITLE,excerpt:EXCERPT,payloadHash:raindropTesting.payloadHash(TARGET,TITLE,EXCERPT,COLLECTION),createdAt:NOW,baselineItemIds:[],baselineComplete:true,stage:'api_receipt' as const,itemId:'900',remoteCreatedAt:NOW};Object.assign(f.task,{raindrop:receipt,submittedAt:NOW,publicUrl:PUBLIC,checkpoint:'raindrop_api_receipt'});
  const result=await reconcileRaindropTask(f.context,{fetch:async()=>json({result:true,item:remoteItem('901')})});assert.deepEqual(result,{status:'unknown'});
});

test('unknown outcome never adopts a matching item created outside the fixed intent window',async()=>{
  const f=fixture(),intentAt='2026-10-01T12:00:00.000Z';
  const receipt={operationId:`raindrop_${TASK_ID.replaceAll('-','')}`,ownerId:OWNER,collectionId:COLLECTION,tokenVersion:1,target:TARGET,title:TITLE,excerpt:EXCERPT,payloadHash:raindropTesting.payloadHash(TARGET,TITLE,EXCERPT,COLLECTION),createdAt:intentAt,baselineItemIds:[],baselineComplete:true,stage:'submitting' as const};
  Object.assign(f.task,{raindrop:receipt,submittedAt:intentAt,checkpoint:'raindrop_submitting'});
  const result=await reconcileRaindropTask(f.context,{fetch:async()=>json({result:true,items:[remoteItem('900',{created:NOW})]})});
  assert.deepEqual(result,{status:'unknown'});
});
