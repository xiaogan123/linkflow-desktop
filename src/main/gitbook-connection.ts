import {createHash,randomUUID} from 'node:crypto';
import {
  GITBOOK_API_ROOT,GITBOOK_MAX_PAGE_BYTES,GITBOOK_MAX_RESPONSE_BYTES,probeGitBookBinding,validGitBookToken,
  type GitBookDependencies,
} from '../integrations/gitbook';
import {CHANNELS} from '../integrations/catalog';
import {saveVerifiedGitBookAccount,type GitBookBaselinePage} from './gitbook-publication';
import type {Store} from './store';
import type {Vault} from './vault';

const ID=/^[A-Za-z0-9_-]{1,255}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const DEFAULT_CONNECTION_TIMEOUT_MS=60_000,MAX_CONNECTION_TIMEOUT_MS=300_000,DEFAULT_GET_TIMEOUT_MS=15_000;
type StateStore=Pick<Store,'read'|'updateWithCiphers'|'getCipher'>;
type SecureVault=Pick<Vault,'encryptSecrets'>;
export interface GitBookConnectionInput {token:string;siteIds:string[];accountId?:string;organizationId?:string;siteId?:string;spaceId?:string}

async function bounded(response:Response,maximum:number){
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/u.test(declared)||Number(declared)>maximum)){
    if(response.body&&!response.body.locked)await response.body.cancel().catch(()=>undefined);
    throw Error('GitBook connection response too large');
  }
  if(!response.body)return new Uint8Array();
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maximum){await reader.cancel().catch(()=>undefined);throw Error('GitBook connection response too large')}chunks.push(next.value)}}finally{reader.releaseLock()}
  return Buffer.concat(chunks.map(value=>Buffer.from(value)));
}

async function getJson(url:string,token:string,deps:GitBookDependencies,maximum=GITBOOK_MAX_RESPONSE_BYTES){
  const controller=new AbortController(),abort=()=>controller.abort(deps.signal?.reason),timeout=Math.max(1,Math.min(deps.timeoutMs??DEFAULT_GET_TIMEOUT_MS,DEFAULT_GET_TIMEOUT_MS)),timer=setTimeout(()=>controller.abort(Error('GitBook connection GET timed out')),timeout);deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)abort();
  try{
    const response=await (deps.fetch??((target:string,init:RequestInit)=>fetch(target,init)))(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json',authorization:`Bearer ${token}`}});
    if(response.redirected||response.status!==200||response.url&&response.url!==url||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json'){
      if(response.body&&!response.body.locked)await response.body.cancel().catch(()=>undefined);
      throw Error('GitBook connection GET invalid');
    }
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await bounded(response,maximum))) as unknown}
    catch(error){if(error instanceof SyntaxError)throw Error('GitBook connection JSON invalid');throw error}
  }finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort)}
}

async function allItems(base:string,token:string,deps:GitBookDependencies){
  const output:unknown[]=[],seen=new Set<string>();let page:string|undefined,total:number|undefined;
  for(let index=0;index<10;index++){
    const url=new URL(base);url.searchParams.set('limit','1000');if(page)url.searchParams.set('page',page);
    const value=await getJson(url.href,token,deps);if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray((value as {items?:unknown}).items))throw Error('GitBook discovery list invalid');
    const count=(value as {count?:unknown}).count;if(count!==undefined&&(!Number.isSafeInteger(count)||Number(count)<0||total!==undefined&&count!==total))throw Error('GitBook discovery count invalid');if(count!==undefined)total=Number(count);output.push(...(value as {items:unknown[]}).items);if(output.length>5000||total!==undefined&&output.length>total)throw Error('GitBook discovery result too large');
    const next=(value as {next?:unknown}).next;if(next===undefined){if(total!==undefined&&output.length!==total)throw Error('GitBook discovery pagination incomplete');return output}
    if(total!==undefined&&output.length>=total)throw Error('GitBook discovery pagination exceeds count');
    if(!next||typeof next!=='object'||Array.isArray(next)||typeof (next as {page?:unknown}).page!=='string'||!(next as {page:string}).page||seen.has((next as {page:string}).page))throw Error('GitBook discovery cursor invalid');
    page=(next as {page:string}).page;seen.add(page);
  }
  throw Error('GitBook discovery pagination exceeded');
}

function identified(value:unknown):value is Record<string,unknown>&{id:string}{return !!value&&typeof value==='object'&&!Array.isArray(value)&&typeof (value as {id?:unknown}).id==='string'&&ID.test((value as {id:string}).id)}
function eligibleLinked(value:unknown,organizationId:string):value is Record<string,unknown>&{id:string;space:{id:string;organization?:unknown}}{return identified(value)&&value.default===true&&value.draft===false&&!!value.space&&typeof value.space==='object'&&!Array.isArray(value.space)&&ID.test(String((value.space as {id?:unknown}).id??''))&&((value.space as {organization?:unknown}).organization===undefined||(value.space as {organization?:unknown}).organization===organizationId)}
function select(items:unknown[],wanted:string|undefined,label:string){const valid=items.filter(identified);if(valid.length!==items.length)throw Error(`GitBook ${label} discovery item invalid`);const matches=wanted?valid.filter(value=>value.id===wanted):valid;if(matches.length!==1)throw Error(wanted?`GitBook ${label} selection not found`:`GitBook ${label} selection is not unique`);return matches[0]}
interface TreePage{id:string;path:string;title:string}
function flatten(values:unknown[]):TreePage[]{const result:TreePage[]=[];for(const value of values){if(!identified(value)||typeof value.path!=='string'||value.path.length>1024||typeof value.title!=='string'||!value.title||value.title.length>500||value.type!=='document'||value.noIndex===true||value.noRobotsIndex===true)throw Error('GitBook baseline page metadata invalid');result.push({id:value.id,path:value.path,title:value.title});if(value.pages!==undefined){if(!Array.isArray(value.pages))throw Error('GitBook baseline nested pages invalid');result.push(...flatten(value.pages))}}return result}
const pagesUrl=(spaceId:string)=>`${GITBOOK_API_ROOT}/spaces/${encodeURIComponent(spaceId)}/content/pages?metadata=false&computed=false`;
const pageUrl=(spaceId:string,pageId:string)=>`${GITBOOK_API_ROOT}/spaces/${encodeURIComponent(spaceId)}/content/page/${encodeURIComponent(pageId)}?format=markdown&format.markdown.refs=stable&computed=false`;

/** Uses documented GETs only. Auto-selection is allowed only for one complete candidate chain. */
export async function connectGitBookAccount(store:StateStore,vault:SecureVault,input:GitBookConnectionInput,deps:GitBookDependencies={}){
  const controller=new AbortController(),abort=()=>controller.abort(deps.signal?.reason),timeout=Math.max(1,Math.min(deps.timeoutMs??DEFAULT_CONNECTION_TIMEOUT_MS,MAX_CONNECTION_TIMEOUT_MS)),timer=setTimeout(()=>controller.abort(Error('GitBook connection timed out')),timeout);deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)abort();
  try{return await connectGitBookAccountWithinDeadline(store,vault,input,{...deps,signal:controller.signal,timeoutMs:Math.min(timeout,DEFAULT_GET_TIMEOUT_MS)})}
  finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort)}
}

async function connectGitBookAccountWithinDeadline(store:StateStore,vault:SecureVault,input:GitBookConnectionInput,deps:GitBookDependencies){
  const token=input.token.trim(),before=store.read(),localSiteIds=[...new Set(input.siteIds)];
  if(!validGitBookToken(token)||!localSiteIds.length||localSiteIds.some(value=>!UUID.test(value)||!before.sites.some(site=>site.id===value)))throw Error('GitBook connection input invalid');
  for(const value of [input.organizationId,input.siteId,input.spaceId])if(value!==undefined&&!ID.test(value))throw Error('GitBook advanced selector invalid');
  const organization=select(await allItems(`${GITBOOK_API_ROOT}/orgs`,token,deps),input.organizationId,'organization'),organizationId=organization.id;
  const remoteSite=select(await allItems(`${GITBOOK_API_ROOT}/orgs/${encodeURIComponent(organizationId)}/sites`,token,deps),input.siteId,'site'),remoteSiteId=remoteSite.id;
  const linked=await allItems(`${GITBOOK_API_ROOT}/orgs/${encodeURIComponent(organizationId)}/sites/${encodeURIComponent(remoteSiteId)}/site-spaces?default=true`,token,deps);
  const eligible=linked.filter(value=>eligibleLinked(value,organizationId));
  const choices=input.spaceId?eligible.filter(value=>(value.space as {id:string}).id===input.spaceId):eligible;if(choices.length!==1)throw Error(input.spaceId?'GitBook default space selection not found':'GitBook default space selection is not unique');const spaceId=(choices[0].space as {id:string}).id;
  const probed=await probeGitBookBinding({organizationId,siteId:remoteSiteId,spaceId,token},{...deps,allowExternalWrite:false});if(probed.status!=='usable')throw Error(`GitBook Basic binding unavailable: ${probed.status}`);
  const tree=await getJson(pagesUrl(spaceId),token,deps,GITBOOK_MAX_PAGE_BYTES);if(!tree||typeof tree!=='object'||Array.isArray(tree)||!Array.isArray((tree as {pages?:unknown}).pages))throw Error('GitBook baseline tree invalid');const pages=flatten((tree as {pages:unknown[]}).pages);if(pages.length>1000||new Set(pages.map(value=>value.id)).size!==pages.length)throw Error('GitBook baseline tree is too large or ambiguous');
  const approvedBaseline:GitBookBaselinePage[]=[],baselineMarkdown:string[]=[];for(const page of pages){const body=await getJson(pageUrl(spaceId,page.id),token,deps,GITBOOK_MAX_PAGE_BYTES);if(!body||typeof body!=='object'||Array.isArray(body)||typeof (body as {markdown?:unknown}).markdown!=='string')throw Error('GitBook baseline body invalid');const markdown=(body as {markdown:string}).markdown,documentId=(body as {documentId?:unknown}).documentId;if(documentId!==undefined&&documentId!==null&&!ID.test(String(documentId)))throw Error('GitBook baseline document id invalid');baselineMarkdown.push(markdown);approvedBaseline.push({id:page.id,path:page.path,title:page.title,markdownHash:sha(markdown),documentId:documentId===undefined||documentId===null?null:String(documentId)})}
  if(!probed.binding.sitePublished&&!(approvedBaseline.length===0||approvedBaseline.length===1&&baselineMarkdown[0]==='# Page\n\n'&&approvedBaseline[0].documentId===null))throw Error('GitBook unpublished site contains content that has not been approved for public release');
  const existing=input.accountId?before.accounts.find(value=>value.id===input.accountId&&value.channelId==='gitbook'):before.accounts.find(value=>!value.retiredAt&&value.channelId==='gitbook');if(input.accountId&&!existing)throw Error('GitBook connection not found');
  if(existing?.gitbook&&(existing.gitbook.organizationId!==organizationId||existing.gitbook.remoteSiteId!==remoteSiteId||existing.gitbook.spaceId!==spaceId||existing.gitbook.authenticatedUserIdHash!==probed.binding.authenticatedUserIdHash||existing.gitbook.organizationMemberIdHash!==probed.binding.organizationMemberIdHash))throw Error('GitBook token belongs to a different binding');
  const channel=CHANNELS.find(value=>value.id==='gitbook');if(!channel)throw Error('GitBook channel unavailable');
  return saveVerifiedGitBookAccount(store,vault,{accountId:existing?.id??randomUUID(),binding:probed.binding,token,approvedBaseline,siteIds:localSiteIds,channel,checkedAt:(deps.now?.()??new Date()).toISOString()});
}
