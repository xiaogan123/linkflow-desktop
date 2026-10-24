import assert from 'node:assert/strict';
import test from 'node:test';
import {GITBOOK_API_ROOT,GITBOOK_AUTHENTICATED_USER_URL,gitBookOrganizationMembersUrl,gitBookOrganizationUrl,gitBookSiteSpacesUrl,gitBookSiteUrl,gitBookSpaceUrl} from '../src/integrations/gitbook';
import {connectGitBookAccount} from '../src/main/gitbook-connection';
import {gitBookAccountVaultKey,loadGitBookAccountAccess} from '../src/main/gitbook-publication';
import {emptyState,Store} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import type {Site} from '../src/shared/types';

const at='2026-10-24T08:00:00.000Z',localSiteId='22222222-2222-4222-8222-222222222222',organizationId='org_fixture',remoteSiteId='site_fixture',siteSpaceId='site_space_relation',spaceId='space_fixture',token=`gb_${'a'.repeat(40)}`;
const localSite={id:localSiteId,domain:'example.test',url:'https://example.test/',email:'editor@example.test',name:'Example docs',description:'Synthetic fixture.',category:'software',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:at,topics:[],qualifications:{}} as Site;
const json=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
function fakeVault(store:Store){return {ready:true,available:()=>true,get:async(key:string)=>{const cipher=store.getCipher(key);return cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():undefined},set:async()=>{},delete:async()=>{},encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))} as unknown as Vault}
function fixture(){const store=new Store(':memory:'),state=emptyState();state.sites=[localSite];store.update(current=>Object.assign(current,state));return {store,vault:fakeVault(store)}}
function connectionFetch(options:{organizations?:unknown[];markdown?:string;omitDiscoveryCount?:boolean}={}){let posts=0;const fetch=async(url:string,init:RequestInit)=>{if(init.method==='POST')posts++;assert.equal(init.method,'GET');
    if(url===`${GITBOOK_API_ROOT}/orgs?limit=1000`)return json({items:options.organizations??[{id:organizationId}],...(options.omitDiscoveryCount?{}:{count:(options.organizations??[1]).length})});
    if(url===`${GITBOOK_API_ROOT}/orgs/${organizationId}/sites?limit=1000`)return json({items:[{id:remoteSiteId}],...(options.omitDiscoveryCount?{}:{count:1})});
    if(url===`${GITBOOK_API_ROOT}/orgs/${organizationId}/sites/${remoteSiteId}/site-spaces?default=true&limit=1000`)return json({items:[{id:siteSpaceId,default:true,draft:false,space:{id:spaceId,organization:organizationId}}],...(options.omitDiscoveryCount?{}:{count:1})});
    if(url===GITBOOK_AUTHENTICATED_USER_URL)return json({object:'user',id:'user_fixture'});
    if(url===gitBookOrganizationMembersUrl(organizationId))return json({items:[{object:'member',id:'member_fixture',role:'admin',disabled:false,user:{object:'user',id:'user_fixture'}}],count:1});
    if(url===gitBookOrganizationUrl(organizationId))return json({id:organizationId,plan:'pro_2024',trial:{status:'active'}});
    if(url===gitBookSiteUrl(organizationId,remoteSiteId))return json({id:remoteSiteId,type:'basic',appliedType:'basic',visibility:'public',published:false,permissions:{admin:true}});
    if(url===gitBookSpaceUrl(spaceId))return json({id:spaceId,organization:organizationId,revision:'revision_fixture',permissions:{edit:true,merge:true}});
    if(url===gitBookSiteSpacesUrl(organizationId,remoteSiteId))return json({items:[{id:siteSpaceId,space:{id:spaceId},draft:false,default:true}],count:1});
    if(url===`${GITBOOK_API_ROOT}/spaces/${spaceId}/content/pages?metadata=false&computed=false`)return json({pages:[{id:'page_template',path:'page',title:'Page',type:'document'}]});
    if(url===`${GITBOOK_API_ROOT}/spaces/${spaceId}/content/page/page_template?format=markdown&format.markdown.refs=stable&computed=false`)return json({id:'page_template',title:'Page',markdown:options.markdown??'# Page\n\n'});
    throw Error(`unexpected ${url}`);
  };return {fetch,posts:()=>posts}}

test('token-only connection discovers one complete organization/site/default-space chain and stores only the nested content space id',async()=>{const f=fixture(),remote=connectionFetch();try{const account=await connectGitBookAccount(f.store,f.vault,{token,siteIds:[localSiteId]},{fetch:remote.fetch,now:()=>new Date(at)});assert.equal(account.gitbook?.organizationId,organizationId);assert.equal(account.gitbook?.remoteSiteId,remoteSiteId);assert.equal(account.gitbook?.siteSpaceId,siteSpaceId);assert.equal(account.gitbook?.spaceId,spaceId);assert.equal(remote.posts(),0);assert.match(f.store.getCipher(gitBookAccountVaultKey(account.id))??'',/^enc:/);const access=await loadGitBookAccountAccess(f.store,f.vault,account.id);assert.equal(access.approvedBaseline.length,1);assert.equal(access.binding.spaceId,spaceId)}finally{f.store.close()}});

test('token discovery never guesses the first organization when the complete list has multiple candidates',async()=>{const f=fixture(),remote=connectionFetch({organizations:[{id:organizationId},{id:'org_second'}]});try{await assert.rejects(connectGitBookAccount(f.store,f.vault,{token,siteIds:[localSiteId]},{fetch:remote.fetch}),/not unique/);assert.equal(f.store.read().accounts.length,0);assert.equal(remote.posts(),0)}finally{f.store.close()}});

test('an unpublished site with non-template private content is not silently approved for first public release',async()=>{const f=fixture(),remote=connectionFetch({markdown:'# Private draft\n\nNot reviewed.'});try{await assert.rejects(connectGitBookAccount(f.store,f.vault,{token,siteIds:[localSiteId]},{fetch:remote.fetch}),/not been approved/);assert.equal(f.store.read().accounts.length,0);assert.equal(remote.posts(),0)}finally{f.store.close()}});

test('reconnecting cannot replace the PAT or historical account proof used by pending and published journals',async()=>{const f=fixture(),remote=connectionFetch();try{const account=await connectGitBookAccount(f.store,f.vault,{token,siteIds:[localSiteId]},{fetch:remote.fetch,now:()=>new Date(at)}),beforeCipher=f.store.getCipher(gitBookAccountVaultKey(account.id)),before=structuredClone(account);await assert.rejects(connectGitBookAccount(f.store,f.vault,{token:`gb_${'b'.repeat(40)}`,accountId:account.id,siteIds:[localSiteId]},{fetch:remote.fetch,now:()=>new Date('2026-10-25T08:00:00.000Z')}),/preserving the original publication history/);assert.equal(f.store.getCipher(gitBookAccountVaultKey(account.id)),beforeCipher);assert.deepEqual(f.store.read().accounts.find(value=>value.id===account.id),before)}finally{f.store.close()}});

test('official lists without count or next are accepted as complete terminal pages',async()=>{const f=fixture(),remote=connectionFetch({omitDiscoveryCount:true});try{const account=await connectGitBookAccount(f.store,f.vault,{token,siteIds:[localSiteId]},{fetch:remote.fetch,now:()=>new Date(at)});assert.equal(account.gitbook?.organizationId,organizationId);assert.equal(account.gitbook?.spaceId,spaceId);assert.equal(remote.posts(),0)}finally{f.store.close()}});

test('a declared count still rejects a truncated terminal page',async()=>{const f=fixture();try{await assert.rejects(connectGitBookAccount(f.store,f.vault,{token,siteIds:[localSiteId]},{fetch:async(url,init)=>{assert.equal(init.method,'GET');assert.equal(url,`${GITBOOK_API_ROOT}/orgs?limit=1000`);return json({items:[{id:organizationId}],count:2})}}),/pagination incomplete/);assert.equal(f.store.read().accounts.length,0)}finally{f.store.close()}});

test('connection GETs inherit a bounded abort deadline and leave no partial account behind',async()=>{const f=fixture();try{await assert.rejects(connectGitBookAccount(f.store,f.vault,{token,siteIds:[localSiteId]},{timeoutMs:10,fetch:async(_url,init)=>await new Promise<Response>((_resolve,reject)=>{const signal=init.signal as AbortSignal;signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})}),/timed out|abort/i);assert.equal(f.store.read().accounts.length,0);assert.equal(f.store.read().accountBindings.length,0)}finally{f.store.close()}});
