import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {marked} from 'marked';
import {
  GITBOOK_API_ROOT,
  GITBOOK_AUTHENTICATED_USER_URL,
  gitBookChangeRequestsUrl,
  gitBookOrganizationMembersUrl,
  gitBookOrganizationUrl,
  gitBookPageReadUrl,
  gitBookSitePublishUrl,
  gitBookSiteSpacesUrl,
  gitBookSiteUrl,
  gitBookSpaceUrl,
  probeGitBookBinding,
  type GitBookBinding,
} from '../src/integrations/gitbook';
import {runGitBookTask,type GitBookExecutionContext} from '../src/integrations/gitbook-publisher';
import {ARTICLE_REVIEW_CONTRACT_VERSION,articleContentHash,articleReviewBindingHash} from '../src/main/article-review';
import {decryptBackup,encryptBackup} from '../src/main/backup';
import {validateBackup} from '../src/main/backup-validation';
import {
  createGitBookPublicationPersistence,
  gitBookAccountVaultKey,
  gitBookPublicationVaultKey,
  gitBookTaskSlug,
  loadGitBookAccountAccess,
  parseGitBookAccountSecret,
  parseGitBookPublicationSecret,
  saveVerifiedGitBookAccount,
  type GitBookProductTask,
} from '../src/main/gitbook-publication';
import {emptyState,Store} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import type {Channel,Site,Task} from '../src/shared/types';

const at='2026-10-24T08:00:00.000Z';
const firstTaskId='11111111-1111-4111-8111-111111111111';
const secondTaskId='11111111-1111-4111-8111-222222222222';
const siteLocalId='22222222-2222-4222-8222-222222222222';
const accountId='33333333-3333-4333-8333-333333333333';
const organizationId='org_fixture';
const remoteSiteId='site_fixture';
const siteSpaceId='site_space_fixture';
const spaceId='space_fixture';
const token=`gb_${'a'.repeat(40)}`;
const target='https://docs.example.com/releases';
const publicOrigin='https://docs.example.com';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');

const channel={
  id:'gitbook',name:'GitBook',domain:'gitbook.com',url:'https://gitbook.com',submitUrl:'https://api.gitbook.com/v1',
  categories:['software'],languages:['en'],kind:'article',emailRequired:false,accountRequired:true,articleRequired:true,
  free:'yes',freeNote:'fixture',automation:'api',quality:'C',qualityReason:'fixture',provenance:'built-in',
  evidenceStatus:'rules_checked',rulesUrl:'https://www.gitbook.com/legal/terms',checkedAt:at,notes:'fixture',
  allowedHosts:['gitbook.com'],enabled:true,
  termsCache:{version:1,reviewVersion:2,channelId:'gitbook',sourceHash:'1'.repeat(64),conclusionHash:'2'.repeat(64),checkedAt:at,summary:'fixture',finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown',sources:[]},
} as Channel;

const site={
  id:siteLocalId,domain:'docs.example.com',url:`${publicOrigin}/`,email:'editor@example.com',name:'Documentation Lab',
  description:'Independent software documentation.',category:'software',language:'en',monthlyTarget:2,articleReviewMode:'ai',
  status:'ready',createdAt:at,topics:[{url:target,discoveredAt:at}],qualifications:{software:target,developer:target},
} as Site;

interface RemotePage{id:string;path:string;title:string;type:'document';markdown:string}
interface RemoteChangeRequest{id:string;subject:string;status:'draft'|'merged';revision?:string;pages:RemotePage[]}
interface RequestRecord{method:string;url:string;body?:string}

function response(value:unknown,status=200,contentType='application/json'){
  return new Response(contentType==='application/json'?JSON.stringify(value):String(value),{status,headers:{'content-type':contentType}});
}

class FakeGitBookRemote{
  revisionNumber=0;
  published=false;
  pageNumber=0;
  changeRequestNumber=0;
  readonly requests:RequestRecord[]=[];
  readonly changeRequests=new Map<string,RemoteChangeRequest>();
  livePages:RemotePage[]=[{id:'page_template',path:'page',title:'Page',type:'document',markdown:'# Page\n\n'}];

  private siteValue(){
    return {id:remoteSiteId,type:'basic',appliedType:'basic',visibility:'public',published:this.published,permissions:{admin:true,create:true},...(this.published?{urls:{published:`${publicOrigin}/`}}:{})};
  }

  private siteSpacesValue(){
    return {items:[{id:siteSpaceId,space:{id:spaceId},draft:false,default:true,...(this.published?{urls:{published:`${publicOrigin}/`}}:{})}],count:1};
  }

  private spaceValue(){return {id:spaceId,organization:organizationId,revision:`revision_${this.revisionNumber}`,permissions:{edit:true,merge:true}}}
  private pageValue(page:RemotePage){return {object:'page',id:page.id,title:page.title,type:page.type,slug:page.path,path:page.path,markdown:page.markdown}}
  private pageMetadata(pages:RemotePage[]){return {pages:pages.map(({markdown:_,...page})=>page)}}
  private findByPath(pages:RemotePage[],path:string){return pages.find(page=>page.path===path||page.path.endsWith(`/${path}`))}
  private findById(pages:RemotePage[],id:string){return pages.find(page=>page.id===id)}

  readonly fetch=async(url:string,init:RequestInit):Promise<Response>=>{
    const method=(init.method??'GET').toUpperCase(),body=typeof init.body==='string'?init.body:undefined;
    this.requests.push({method,url,...(body!==undefined?{body}:{})});
    const parsed=new URL(url),path=parsed.pathname;

    if(method==='GET'){
      if(url===GITBOOK_AUTHENTICATED_USER_URL)return response({object:'user',id:'user_fixture'});
      if(url===gitBookOrganizationMembersUrl(organizationId))return response({items:[{object:'member',id:'member_fixture',role:'admin',disabled:false,user:{object:'user',id:'user_fixture'}}],count:1});
      if(url===gitBookOrganizationUrl(organizationId))return response({id:organizationId,plan:'free_2024',trial:{status:'ended'}});
      if(url===gitBookSiteUrl(organizationId,remoteSiteId))return response(this.siteValue());
      if(url===gitBookSpaceUrl(spaceId))return response(this.spaceValue());
      if(url===gitBookSiteSpacesUrl(organizationId,remoteSiteId))return response(this.siteSpacesValue());
      if(url===`${gitBookChangeRequestsUrl(spaceId,'draft')}`){
        const items=[...this.changeRequests.values()].filter(value=>value.status==='draft').map(value=>({id:value.id,subject:value.subject,status:value.status}));
        return response({items,count:items.length});
      }
      const crMatch=new RegExp(`^/v1/spaces/${spaceId}/change-requests/([^/]+)$`,'u').exec(path);
      if(crMatch){const cr=this.changeRequests.get(decodeURIComponent(crMatch[1]));return cr?response({id:cr.id,subject:cr.subject,status:cr.status,revision:cr.revision}):response({},404)}
      const pathMatch=new RegExp(`^/v1/spaces/${spaceId}(?:/change-requests/([^/]+))?/content/path/([^/]+)$`,'u').exec(path);
      if(pathMatch){
        const cr=pathMatch[1]?this.changeRequests.get(decodeURIComponent(pathMatch[1])):undefined;
        const pages=pathMatch[1]?cr?.pages:this.livePages,page=pages&&this.findByPath(pages,decodeURIComponent(pathMatch[2]));
        return page?response(this.pageValue(page)):response({},404);
      }
      const pagesMatch=new RegExp(`^/v1/spaces/${spaceId}(?:/change-requests/([^/]+))?/content/pages$`,'u').exec(path);
      if(pagesMatch){
        const pages=pagesMatch[1]?this.changeRequests.get(decodeURIComponent(pagesMatch[1]))?.pages:this.livePages;
        return pages?response(this.pageMetadata(pages)):response({},404);
      }
      const pageMatch=new RegExp(`^/v1/spaces/${spaceId}(?:/change-requests/([^/]+))?/content/page/([^/]+)$`,'u').exec(path);
      if(pageMatch){
        const pages=pageMatch[1]?this.changeRequests.get(decodeURIComponent(pageMatch[1]))?.pages:this.livePages;
        const page=pages&&this.findById(pages,decodeURIComponent(pageMatch[2]));
        return page?response({markdown:page.markdown}):response({},404);
      }
      if(url===`${publicOrigin}/robots.txt`)return response('User-agent: *\nAllow: /\n',200,'text/plain');
      if(parsed.origin===publicOrigin&&method==='GET'){
        const slug=decodeURIComponent(parsed.pathname.replace(/^\//u,'')),page=this.findByPath(this.livePages,slug);
        if(!page)return response('',404,'text/html');
        const rendered=marked.parse(page.markdown,{async:false,gfm:true});
        return response(`<!doctype html><html><head><title>${page.title}</title></head><body><main><article>${rendered}</article></main></body></html>`,200,'text/html');
      }
      throw Error(`unexpected GET ${url}`);
    }

    if(method!=='POST'||body===undefined)throw Error(`unexpected ${method} ${url}`);
    if(url===gitBookChangeRequestsUrl(spaceId)){
      const input=JSON.parse(body) as {subject:string},id=`cr_${++this.changeRequestNumber}`;
      this.changeRequests.set(id,{id,subject:input.subject,status:'draft',pages:structuredClone(this.livePages)});
      return response({id,status:'draft',subject:input.subject},201);
    }
    const contentMatch=new RegExp(`^/v1/spaces/${spaceId}/change-requests/([^/]+)/content$`,'u').exec(path);
    if(contentMatch){
      const cr=this.changeRequests.get(decodeURIComponent(contentMatch[1]));
      assert.ok(cr,'fixture change request missing');
      const input=JSON.parse(body) as {changes:Array<{operation:string;document:{markdown:string};title:string;slug:string;ref:string}>};
      assert.equal(input.changes.length,1);const change=input.changes[0];assert.equal(change.operation,'insert_page');
      const page:RemotePage={id:`page_${++this.pageNumber}`,path:change.slug,title:change.title,type:'document',markdown:change.document.markdown};
      cr.pages.push(page);
      return response({changes:[{object:'created_page',ref:change.ref,page:{id:page.id,urls:{location:`${GITBOOK_API_ROOT}/spaces/${spaceId}/content/page/${page.id}`}}}]});
    }
    const mergeMatch=new RegExp(`^/v1/spaces/${spaceId}/change-requests/([^/]+)/merge$`,'u').exec(path);
    if(mergeMatch){
      const cr=this.changeRequests.get(decodeURIComponent(mergeMatch[1]));assert.ok(cr,'fixture merge change request missing');
      this.livePages=structuredClone(cr.pages);cr.status='merged';cr.revision=`revision_${++this.revisionNumber}`;
      return response({revision:cr.revision,result:'merge'});
    }
    if(url===gitBookSitePublishUrl(organizationId,remoteSiteId)){
      this.published=true;
      return response(this.siteValue());
    }
    throw Error(`unexpected POST ${url}`);
  };
}

function fakeVault(store:Store){
  return {
    ready:true,
    available:()=>true,
    get:async(key:string)=>{const cipher=store.getCipher(key);return cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():undefined},
    set:async()=>{},delete:async()=>{},
    encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`])),
  } as unknown as Vault;
}

function draft(number:number){
  return {title:`Durable GitBook publication ${number}`,description:`Recovery-safe article ${number}.`,body:`Article ${number} keeps one durable intent before every remote write.\n\nSee the [release notes](${target}) for the tested behavior.`};
}

function reviewedTask(id:string,number:number):GitBookProductTask{
  const value={id,siteId:siteLocalId,channelId:'gitbook',accountId,sourceDomain:'gitbook.com',status:'running',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'fixture',draft:draft(number),topicUrl:target,draftRevision:1,articleApprovedAt:at} as GitBookProductTask;
  const bindingHash=articleReviewBindingHash(value,site,channel);
  value.articleReview={status:'passed',reason:'Fixture review passed.',reasonCode:'passed',reviewContractVersion:ARTICLE_REVIEW_CONTRACT_VERSION,bindingVersion:2,bindingHash,targetUrl:target,termsHash:channel.termsCache!.conclusionHash,checks:{factualAccuracy:'pass',authorRelationship:'pass',affiliateDisclosure:'pass',independentValue:'pass',financialSafety:'pass',channelRules:'pass'},reviewedAt:at,evidenceUrls:[target],draftRevision:1,contentHash:articleContentHash(value),contextHash:bindingHash};
  return value;
}

async function fixture(){
  const remote=new FakeGitBookRemote(),store=new Store(':memory:'),vault=fakeVault(store),state=emptyState(),first=reviewedTask(firstTaskId,1);
  state.sites=[site];state.tasks=[first];state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides.gitbook=true;
  store.update(current=>Object.assign(current,state));
  const probed=await probeGitBookBinding({organizationId,siteId:remoteSiteId,spaceId,token},{fetch:remote.fetch});
  assert.equal(probed.status,'usable');if(probed.status!=='usable')throw Error('fixture binding failed');
  const baseline=[{id:'page_template',path:'page',title:'Page',markdownHash:sha('# Page\n\n'),documentId:null}];
  saveVerifiedGitBookAccount(store,vault,{accountId,binding:probed.binding,token,approvedBaseline:baseline,siteIds:[siteLocalId],channel,checkedAt:at});
  return {remote,store,vault,initialBinding:probed.binding};
}

function execution(f:Awaited<ReturnType<typeof fixture>>,taskId:string,fetch=f.remote.fetch){
  const state=f.store.read(),task=state.tasks.find(value=>value.id===taskId) as GitBookProductTask,slug=gitBookTaskSlug(task,site);
  const persistence=createGitBookPublicationPersistence(f.store,f.vault,{taskId,siteId:siteLocalId,accountId,slug,resolveChannel:()=>channel,assertSubmissionAuthorized:()=>true,now:()=>new Date(at)});
  const context={site:state.sites[0],channel,task,settings:state.settings,signal:new AbortController().signal,secrets:f.vault,getAccount:()=>f.store.read().accounts.find(value=>value.id===accountId),gitbookPersistence:persistence} as GitBookExecutionContext;
  return {context,persistence,slug,deps:{fetch,allowExternalWrite:true,now:()=>new Date(at)}};
}

async function plainSecrets(f:Awaited<ReturnType<typeof fixture>>,taskIds:string[]){
  const keys=[gitBookAccountVaultKey(accountId),...taskIds.map(gitBookPublicationVaultKey)],entries=await Promise.all(keys.map(async key=>[key,await f.vault.get(key)] as const));
  return Object.fromEntries(entries.map(([key,value])=>{assert.ok(value,`missing ${key}`);return [key,value]}));
}

test('two real-shape publications tolerate revision changes, advance one baseline, and restore from backup',async()=>{
  const f=await fixture();
  try{
    const firstRun=execution(f,firstTaskId),firstResult=await runGitBookTask(firstRun.context,firstRun.deps);
    assert.equal(firstResult.status,'live',JSON.stringify(firstResult));
    assert.equal(f.remote.revisionNumber,1);
    assert.equal(f.remote.requests.filter(value=>value.method==='POST').length,4);

    const firstJournal=parseGitBookPublicationSecret(await f.vault.get(gitBookPublicationVaultKey(firstTaskId)));
    assert.ok(firstJournal);
    assert.deepEqual(Object.keys(firstJournal.stages),['change_request','page','merge','site_publish']);
    assert.equal(firstJournal.stages.change_request!.binding.spaceRevision,'revision_0');
    assert.equal(firstJournal.stages.page!.binding.spaceRevision,'revision_0');
    assert.equal(firstJournal.stages.merge!.binding.spaceRevision,'revision_0');
    assert.equal(firstJournal.stages.site_publish!.binding.spaceRevision,'revision_1');
    assert.notEqual(firstJournal.stages.merge!.binding.bindingHash,firstJournal.stages.site_publish!.binding.bindingHash);
    assert.equal(firstResult.gitbook?.bindingHash,f.initialBinding.bindingHash);

    let access=await loadGitBookAccountAccess(f.store,f.vault,accountId);
    assert.equal(access.account.gitbook.bindingHash,f.initialBinding.bindingHash);
    assert.equal(access.approvedBaseline.length,2);
    assert.equal(access.approvedBaseline.some(page=>page.path===firstRun.slug),true);

    f.store.update(state=>{state.tasks.push(reviewedTask(secondTaskId,2))});
    const secondRun=execution(f,secondTaskId),secondResult=await runGitBookTask(secondRun.context,secondRun.deps);
    assert.equal(secondResult.status,'live',JSON.stringify(secondResult));
    assert.equal(f.remote.revisionNumber,2);
    assert.equal(f.remote.requests.filter(value=>value.method==='POST').length,7);
    assert.equal(f.remote.requests.filter(value=>value.url===gitBookSitePublishUrl(organizationId,remoteSiteId)&&value.method==='POST').length,1);

    const secondJournal=parseGitBookPublicationSecret(await f.vault.get(gitBookPublicationVaultKey(secondTaskId)));
    assert.ok(secondJournal);
    assert.deepEqual(Object.keys(secondJournal.stages),['change_request','page','merge']);
    for(const stage of ['change_request','page','merge'] as const)assert.equal(secondJournal.stages[stage]!.binding.spaceRevision,'revision_1');
    assert.notEqual(secondJournal.stages.change_request!.binding.bindingHash,f.initialBinding.bindingHash);
    assert.equal(secondResult.gitbook?.bindingHash,f.initialBinding.bindingHash);

    access=await loadGitBookAccountAccess(f.store,f.vault,accountId);
    assert.equal(access.account.gitbook.bindingHash,f.initialBinding.bindingHash);
    assert.equal(access.approvedBaseline.length,3);
    assert.deepEqual(new Set(access.approvedBaseline.map(page=>page.path)),new Set(['page',firstRun.slug,secondRun.slug]));

    const secrets=await plainSecrets(f,[firstTaskId,secondTaskId]),validated=validateBackup({state:f.store.read(),secrets});
    const encrypted=encryptBackup(validated,'synthetic-gitbook-product-flow-passphrase'),restored=validateBackup(decryptBackup(encrypted,'synthetic-gitbook-product-flow-passphrase'));
    assert.equal(restored.state.tasks.filter(value=>value.channelId==='gitbook'&&value.status==='live').length,2);
    const restoredAccount=parseGitBookAccountSecret(restored.secrets[gitBookAccountVaultKey(accountId)]);
    assert.equal(restoredAccount?.approvedBaseline.length,3);
    for(const id of [firstTaskId,secondTaskId])assert.ok(parseGitBookPublicationSecret(restored.secrets[gitBookPublicationVaultKey(id)]));
  }finally{f.store.close()}
});

test('a lost change-request response recovers by GET and never repeats that POST',async()=>{
  const f=await fixture();let lost=false;
  try{
    const lossy=async(url:string,init:RequestInit)=>{
      if(!lost&&url===gitBookChangeRequestsUrl(spaceId)&&(init.method??'GET').toUpperCase()==='POST'){
        lost=true;await f.remote.fetch(url,init);throw Error('synthetic connection loss after remote commit');
      }
      return f.remote.fetch(url,init);
    };
    const first=execution(f,firstTaskId,lossy),unknown=await runGitBookTask(first.context,first.deps);
    assert.equal(unknown.status,'review');
    assert.equal(f.remote.requests.filter(value=>value.url===gitBookChangeRequestsUrl(spaceId)&&value.method==='POST').length,1);
    const pending=parseGitBookPublicationSecret(await f.vault.get(gitBookPublicationVaultKey(firstTaskId)));
    assert.ok(pending?.stages.change_request);
    assert.equal(pending.stages.change_request.receipt,undefined);
    assert.equal(pending.stages.change_request.recovered,undefined);

    const resumed=execution(f,firstTaskId),live=await runGitBookTask(resumed.context,resumed.deps);
    assert.equal(live.status,'live',JSON.stringify(live));
    assert.equal(f.remote.requests.filter(value=>value.url===gitBookChangeRequestsUrl(spaceId)&&value.method==='POST').length,1);
    assert.equal(f.remote.requests.filter(value=>value.method==='POST').length,4);
    const recovered=parseGitBookPublicationSecret(await f.vault.get(gitBookPublicationVaultKey(firstTaskId)));
    assert.ok(recovered?.stages.change_request?.recovered);
    assert.equal(recovered.stages.change_request.receipt,undefined);
    assert.equal(recovered.stages.change_request.recovered?.evidence.changeRequestId,'cr_1');
  }finally{f.store.close()}
});
