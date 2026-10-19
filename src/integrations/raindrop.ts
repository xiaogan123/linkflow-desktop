import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import {articleReviewStillValid} from '../main/article-review';
import {getArticleReviewMode} from '../shared/article-review-mode';
import type {
  Account,ExecutionContext,ExecutionResult,LinkResult,RaindropCollectionOption,
  RaindropCollectionResult,RaindropReceipt,Task,
} from '../shared/types';
import {applyDeclaredArticleVisibility,elementConcealed} from './article-visibility';
import {raindropDraftError} from '../shared/raindrop-content';
export {raindropDraftError} from '../shared/raindrop-content';

const API_ORIGIN='https://api.raindrop.io';
const SOURCE_DOMAIN='raindrop.page';
const CHANNEL_ID='raindrop';
const MAX_JSON_BYTES=2_000_000;
const MAX_HTML_BYTES=4_000_000;
const DEFAULT_TIMEOUT_MS=15_000;
const DEFAULT_MAX_PAGES=5;
const PER_PAGE=50;
const ID=/^[1-9][0-9]*$/;
const HASH=/^[a-f0-9]{64}$/;

type Json=Record<string,unknown>;
export type RaindropTransport=(input:string,init:RequestInit)=>Promise<Response>;
export interface RaindropDependencies {fetch?:RaindropTransport;now?:()=>Date|string;timeoutMs?:number;maxPages?:number;signal?:AbortSignal}
export interface RaindropExecutionResult extends ExecutionResult {raindrop?:RaindropReceipt}
export type RaindropReconcileResult={status:'found';publicUrl:string;raindrop:RaindropReceipt}|{status:'unknown'};

export class RaindropError extends Error{
  constructor(readonly code:'auth'|'restricted'|'rate_limited'|'timeout'|'network'|'cancelled'|'invalid_response'|'public_mismatch'|'display_hidden',message?:string){super(message??`Raindrop request failed (${code})`);this.name='RaindropError'}
}

function object(value:unknown):value is Json{return !!value&&typeof value==='object'&&!Array.isArray(value)}
function text(value:unknown):string|undefined{return typeof value==='string'?value:undefined}
function remoteId(value:unknown):string|undefined{
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)return String(value);
  if(typeof value==='string'&&safeId(value))return value;
}
function safeId(value:string):boolean{const numeric=Number(value);return ID.test(value)&&Number.isSafeInteger(numeric)&&numeric>0&&String(numeric)===value}
function iso(value:unknown):string|undefined{
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))return;
  const normalized=new Date(value).toISOString();return normalized===value?value:normalized;
}
function normal(value:string):string{return value.normalize('NFC').replace(/\s+/gu,' ').trim()}
function stamp(deps?:RaindropDependencies):string{
  const supplied=deps?.now?.(),date=supplied instanceof Date?supplied:typeof supplied==='string'?new Date(supplied):new Date();
  return (Number.isFinite(date.getTime())?date:new Date()).toISOString();
}
function sha256(value:string):string{return createHash('sha256').update(value,'utf8').digest('hex')}
export function raindropTokenFingerprint(token:string):string{return sha256(validateToken(token))}
function validateToken(value:string):string{
  if(typeof value!=='string'||value!==value.trim()||value.length<16||Buffer.byteLength(value,'utf8')>8192||/[\s\u0000-\u001f\u007f]/u.test(value))throw new RaindropError('auth','Raindrop Test token 格式无效');
  return value;
}
export function canonicalRaindropPublicUrl(value:string):string{
  const url=new URL(value.trim()),host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||url.port||url.username||url.password||url.search||url.hash||!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.raindrop\.page$/.test(host)||url.pathname==='/'||!/^[\x21-\x7e]+$/.test(url.pathname))throw new RaindropError('public_mismatch','请粘贴选定公开根合集的 raindrop.page HTTPS 分享地址');
  url.hostname=host;url.pathname=url.pathname.replace(/\/+$/,'');return url.href;
}
function canonicalTarget(value:string):string{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||url.hash)throw Error('Raindrop 目标必须是无账号密码和片段的 HTTPS 地址');
  if(url.port==='443')url.port='';return url.href;
}
function operationId(taskId:string):string{return `raindrop_${taskId.toLowerCase().replace(/[^a-f0-9]/g,'')}`}
function stable(value:unknown):unknown{
  if(Array.isArray(value))return value.map(stable);if(!object(value))return value;
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])) as Json;
}
function payloadHash(target:string,title:string,excerpt:string,collectionId:string):string{return sha256(JSON.stringify(stable({link:target,title,excerpt,collection:{$id:collectionId},type:'link'})))}

async function readLimited(response:Response,max:number,signal:AbortSignal):Promise<Uint8Array>{
  const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>max)throw new RaindropError('invalid_response');
  const reader=response.body?.getReader();if(!reader)return new Uint8Array();
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){if(signal.aborted)throw new RaindropError('cancelled');const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>max)throw new RaindropError('invalid_response');chunks.push(item.value)}}catch(error){void reader.cancel().catch(()=>undefined);throw error}finally{reader.releaseLock()}
  return Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)));
}
async function boundedFetch(url:string,init:RequestInit,deps:RaindropDependencies,max:number):Promise<{response:Response;bytes:Uint8Array}>{
  const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort()},Math.min(60_000,Math.max(100,deps.timeoutMs??DEFAULT_TIMEOUT_MS)));timer.unref?.();let response:Response|undefined;
  try{
    response=await (deps.fetch??fetch)(url,{...init,signal:controller.signal});
    if(controller.signal.aborted)throw new RaindropError(deps.signal?.aborted?'cancelled':timedOut?'timeout':'network');
    const bytes=await readLimited(response,max,controller.signal);return {response,bytes};
  }catch(error){controller.abort();void response?.body?.cancel().catch(()=>undefined);if(error instanceof RaindropError)throw error;if(deps.signal?.aborted)throw new RaindropError('cancelled');if(timedOut)throw new RaindropError('timeout');throw new RaindropError('network')}
  finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external)}
}
function statusError(status:number):never{
  if(status===401||status===403)throw new RaindropError('auth');if(status===429)throw new RaindropError('rate_limited');if(status===451)throw new RaindropError('restricted');
  throw new RaindropError(status>=500||status===408?'network':'invalid_response');
}
async function api(path:string,token:string,init:RequestInit,deps:RaindropDependencies={}):Promise<Json>{
  validateToken(token);if(!path.startsWith('/rest/v1/'))throw new RaindropError('invalid_response');
  const url=API_ORIGIN+path,{response,bytes}=await boundedFetch(url,{...init,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{accept:'application/json',authorization:`Bearer ${token}`,...(init.body?{'content-type':'application/json'}:{}),...(init.headers??{})}},deps,MAX_JSON_BYTES);
  if(response.redirected||response.url&&response.url!==url||response.status<200||response.status>=300)statusError(response.status);
  if(!response.headers.get('content-type')?.toLowerCase().includes('application/json'))throw new RaindropError('invalid_response');
  let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw new RaindropError('invalid_response')}
  if(!object(value)||value.result!==true)throw new RaindropError('invalid_response');return value;
}

function collectionOption(value:unknown,parentHint?:string):RaindropCollectionOption{
  if(!object(value))throw new RaindropError('invalid_response');
  const id=remoteId(value._id),owner=object(value.user)?remoteId(value.user.$id):undefined,access=object(value.access)&&typeof value.access.level==='number'?value.access.level:undefined,title=text(value.title),parent=object(value.parent)?remoteId(value.parent.$id):value.parent===null?undefined:parentHint;
  if(!id||!owner||typeof access!=='number'||!Number.isInteger(access)||access<0||access>9||typeof value.public!=='boolean'||!title||title.length>1000)throw new RaindropError('invalid_response');
  return {id,title,public:value.public,accessLevel:access,ownerId:owner,...(parent?{parentId:parent}:{})};
}

/** Authenticated discovery only; the token is never returned or persisted here. */
export async function listRaindropCollections(token:string,deps:RaindropDependencies={}):Promise<RaindropCollectionResult>{
  const roots=await api('/rest/v1/collections',token,{method:'GET'},deps),children=await api('/rest/v1/collections/childrens',token,{method:'GET'},deps);
  if(!Array.isArray(roots.items)||!Array.isArray(children.items))throw new RaindropError('invalid_response');
  const collections=[...roots.items.map(item=>collectionOption(item)),...children.items.map(item=>{const parsed=collectionOption(item,'unknown');return {...parsed,parentId:parsed.parentId??'unknown'}})];
  const ids=new Set<string>();for(const item of collections)if(ids.has(item.id))throw new RaindropError('invalid_response');else ids.add(item.id);
  const owners=[...new Set(collections.filter(item=>item.accessLevel===4).map(item=>item.ownerId))];if(owners.length!==1)throw new RaindropError('invalid_response','Raindrop 本人合集的账号无法唯一核对');
  return {ownerId:owners[0],collections};
}

interface PublicContext {collectionId:string;ownerId:string;view:string;title:string;items:Json[];hide:Set<string>;html:string;headers:Headers}
function parsePublicContext(html:string,headers:Headers,expectedUrl:string):PublicContext{
  const $=load(html);applyDeclaredArticleVisibility($);
  const scripts=$('script#vike_pageContext[type="application/json"]');if(scripts.length!==1)throw new RaindropError('public_mismatch');
  let root:unknown;try{root=JSON.parse(scripts.text())}catch{throw new RaindropError('public_mismatch')}
  if(!object(root)||root.pageId!=='/src/pages/collection/view/index'||!object(root.routeParams)||!object(root.data))throw new RaindropError('public_mismatch');
  const collection=root.data.collection,user=root.data.user,options=root.data.options,raindrops=root.data.raindrops;
  if(!object(collection)||!object(user)||!object(options)||!object(raindrops)||!Array.isArray(raindrops.items))throw new RaindropError('public_mismatch');
  const collectionId=remoteId(collection._id),ownerId=object(collection.user)?remoteId(collection.user.$id):undefined,userId=remoteId(user._id),routeId=remoteId(root.routeParams.id),view=text(collection.view),title=text(collection.title);
  if(!collectionId||collectionId!==routeId||!ownerId||ownerId!==userId||collection.public!==true||collection.parent!==null||!view||!['list','simple','grid','masonry'].includes(view)||!title)throw new RaindropError('public_mismatch');
  const canonical=$('link[rel]').filter((_,node)=>($(node).attr('rel')??'').toLowerCase().split(/\s+/).includes('canonical'));
  if(canonical.length!==1||new URL(canonical.attr('href')??'',expectedUrl).href!==expectedUrl)throw new RaindropError('public_mismatch');
  const configured=object(user.config)&&Array.isArray(user.config.raindrops_hide)?user.config.raindrops_hide.filter((item):item is string=>typeof item==='string'&&item.startsWith(`${view}_`)).map(item=>item.slice(view.length+1)):[];
  const optionHide=typeof options.hide==='string'?options.hide.split(',').map(item=>item.trim()).filter(Boolean):[];
  return {collectionId,ownerId,view,title,items:raindrops.items.filter(object),hide:new Set([...configured,...optionHide]),html,headers};
}
async function publicPage(publicUrl:string,deps:RaindropDependencies,page?:number):Promise<PublicContext>{
  const base=canonicalRaindropPublicUrl(publicUrl),url=page===undefined?base:`${base}/view/?sort=-created&perpage=${PER_PAGE}&page=${page}`;
  const {response,bytes}=await boundedFetch(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{accept:'text/html'}},deps,MAX_HTML_BYTES);
  if(response.redirected||response.url&&response.url!==url||response.status!==200||!response.headers.get('content-type')?.toLowerCase().includes('text/html'))throw new RaindropError(response.status>=500||response.status===408||response.status===429?'network':'public_mismatch');
  let html:string;try{html=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw new RaindropError('public_mismatch')}
  return parsePublicContext(html,response.headers,base);
}

/** Fail closed on the observed public-page binding; this format is not treated as an API guarantee. */
export async function verifyRaindropPublicCollection(publicUrl:string,collectionId:string,ownerId:string,deps:RaindropDependencies={}):Promise<{title:string;view:string}>{
  const page=await publicPage(publicUrl,deps);
  if(page.collectionId!==collectionId||page.ownerId!==ownerId)throw new RaindropError('public_mismatch','公开页与选定合集或所有者不一致');
  if(page.hide.has('title')||page.hide.has('excerpt'))throw new RaindropError('display_hidden',`该公开合集的 ${page.view} 视图隐藏了标题或摘要；请本人在 Raindrop 启用显示后再连接`);
  return {title:page.title,view:page.view};
}

export async function readRaindropCollection(token:string,collectionId:string,deps:RaindropDependencies={}):Promise<RaindropCollectionOption>{
  if(!ID.test(collectionId))throw new RaindropError('invalid_response');const value=await api(`/rest/v1/collection/${collectionId}`,token,{method:'GET'},deps);
  const item=collectionOption(value.item);if(item.id!==collectionId)return Promise.reject(new RaindropError('invalid_response'));return item;
}

interface RemoteItem {id:string;ownerId:string;collectionId:string;link:string;title:string;excerpt:string;created:string}
function remoteItem(value:unknown):RemoteItem|undefined{
  if(!object(value))return;const id=remoteId(value._id),ownerId=object(value.user)?remoteId(value.user.$id):undefined,collectionId=object(value.collection)?remoteId(value.collection.$id):undefined,link=text(value.link),title=text(value.title),excerpt=text(value.excerpt),created=iso(value.created);
  if(!id||!ownerId||!collectionId||!link||title===undefined||excerpt===undefined||!created)return;return {id,ownerId,collectionId,link,title,excerpt,created};
}
async function listItems(token:string,collectionId:string,deps:RaindropDependencies):Promise<{items:RemoteItem[];complete:boolean}>{
  const items:RemoteItem[]=[];const seen=new Set<string>(),max=Math.min(10,Math.max(1,deps.maxPages??DEFAULT_MAX_PAGES));
  for(let page=0;page<max;page++){
    const value=await api(`/rest/v1/raindrops/${collectionId}?sort=-created&perpage=${PER_PAGE}&page=${page}`,token,{method:'GET'},deps);if(!Array.isArray(value.items))throw new RaindropError('invalid_response');
    const parsed=value.items.map(remoteItem);if(parsed.some(item=>!item))throw new RaindropError('invalid_response');
    for(const item of parsed as RemoteItem[]){if(seen.has(item.id))throw new RaindropError('invalid_response');seen.add(item.id);items.push(item)}
    if(value.items.length<PER_PAGE)return {items,complete:true};
  }
  return {items,complete:false};
}

export function validRaindropAccount(account:Account|undefined):account is Account&{raindrop:NonNullable<Account['raindrop']>}{
  if(!account?.raindrop||account.channelId!==CHANNEL_ID||account.credentialKind!=='api_token'||account.status!=='registered'||!account.hasPassword||account.email!==''||account.source!=='imported'||account.publicationUrl!==account.raindrop.publicUrl)return false;
  const binding=account.raindrop;return binding.version===1&&safeId(binding.ownerId)&&safeId(binding.collectionId)&&HASH.test(binding.tokenFingerprint)&&Number.isSafeInteger(binding.tokenVersion)&&binding.tokenVersion>0&&Number.isFinite(Date.parse(binding.connectedAt));
}
type BoundPayload={target:string;title:string;excerpt:string;account:Account&{raindrop:NonNullable<Account['raindrop']>}};
function boundPayload(context:ExecutionContext):BoundPayload{
  const account=context.getAccount();if(!validRaindropAccount(account))throw Error('请先连接本人 Raindrop 公开根合集');
  if(context.channel.id!==CHANNEL_ID||context.channel.domain!==SOURCE_DOMAIN||context.channel.automation!=='api'||context.task.channelId!==CHANNEL_ID||context.task.sourceDomain!==SOURCE_DOMAIN||context.task.accountId!==account.id)throw Error('Raindrop 任务与连接发布账号不一致');
  if(!context.task.draft)throw Error('Raindrop 标题、目标和摘要不完整');
  const target=canonicalTarget(context.task.topicUrl??''),site=new URL(context.site.url);if(new URL(target).hostname!==site.hostname)throw Error('Raindrop 只能收藏当前站点已审核的选题地址');
  const title=context.task.draft.title,excerpt=context.task.draft.body,format=raindropDraftError(context.task.draft);if(format)throw Error(format);
  return {target,title,excerpt,account};
}
function approvedPayload(context:ExecutionContext):BoundPayload{
  const payload=boundPayload(context),mode=getArticleReviewMode(context.site,context.settings);
  const approved=mode==='ai'?articleReviewStillValid(context.task,context.site,context.channel,context.settings,payload.account):!!context.task.articleApprovedAt;
  if(!approved)throw Error(mode==='ai'?'Raindrop 标题、目标和摘要尚未通过当前 AI 复核':'Raindrop 标题、目标和摘要尚未获得当前人工批准');
  return payload;
}
export function raindropTaskPayload(context:ExecutionContext){return approvedPayload(context)}
export function raindropReceiptMatchesTask(task:Task,account:Account|undefined,receipt:RaindropReceipt):boolean{
  if(!validRaindropAccount(account)||task.channelId!==CHANNEL_ID||task.sourceDomain!==SOURCE_DOMAIN||task.accountId!==account.id||!task.draft)return false;
  let target:string;try{target=canonicalTarget(task.topicUrl??'')}catch{return false}
  const binding=account.raindrop;
  const tokenVersionMatches=Number.isSafeInteger(receipt.tokenVersion)&&receipt.tokenVersion>0&&(receipt.tokenVersion===binding.tokenVersion||!!task.firstLiveAt&&receipt.stage==='published'&&receipt.tokenVersion<binding.tokenVersion);
  return receipt.operationId===operationId(task.id)&&receipt.ownerId===binding.ownerId&&receipt.collectionId===binding.collectionId&&tokenVersionMatches
    &&receipt.target===target&&receipt.title===task.draft.title&&receipt.excerpt===task.draft.body
    &&receipt.payloadHash===payloadHash(target,task.draft.title,task.draft.body,binding.collectionId)
    &&Number.isFinite(Date.parse(receipt.createdAt))&&new Date(receipt.createdAt).toISOString()===receipt.createdAt
    &&receipt.baselineItemIds.length===new Set(receipt.baselineItemIds).size&&receipt.baselineItemIds.every(id=>ID.test(id))
    &&(!receipt.itemId||ID.test(receipt.itemId)&&!receipt.baselineItemIds.includes(receipt.itemId))
    &&(!receipt.remoteCreatedAt||Number.isFinite(Date.parse(receipt.remoteCreatedAt)));
}
function matches(item:RemoteItem,receipt:RaindropReceipt):boolean{return item.ownerId===receipt.ownerId&&item.collectionId===receipt.collectionId&&item.link===receipt.target&&item.title===receipt.title&&item.excerpt===receipt.excerpt}

function visibleMatch(page:PublicContext,receipt:RaindropReceipt):{rel:string;robots:string}|undefined{
  const item=page.items.map(remoteItem).find(value=>value?.id===receipt.itemId);if(!item||!matches(item,receipt)||page.collectionId!==receipt.collectionId||page.ownerId!==receipt.ownerId)return;
  const $=load(page.html);applyDeclaredArticleVisibility($);
  if($('meta[http-equiv]').toArray().some(node=>($(node).attr('http-equiv')??'').trim().toLowerCase()==='refresh'))return;
  const anchors=$('article a[href]').toArray().filter(node=>{try{return new URL($(node).attr('href')??'',page.headers.get('content-location')??'https://invalid.local').href===receipt.target}catch{return false}});
  if(anchors.length!==1)return;const anchor=$(anchors[0]),article=anchor.closest('article');if(article.length!==1||concealedByAncestor($,article[0])||concealedByAncestor($,anchors[0],article[0]))return;
  const visibleArticle=article.clone();visibleArticle.find('*').each((_,node)=>{if(elementConcealed($,node))visibleArticle.find(node).remove()});
  const visible=normal(visibleArticle.text());if(!visible.includes(normal(receipt.title))||!visible.includes(normal(receipt.excerpt)))return;
  const rel=[...new Set((anchor.attr('rel')??'').toLowerCase().split(/\s+/).filter(Boolean))].sort().join(' '),meta=$('meta[name]').filter((_,node)=>($(node).attr('name')??'').toLowerCase()==='robots').map((_,node)=>$(node).attr('content')??'').get().join(','),header=page.headers.get('x-robots-tag')??'';
  return {rel,robots:[meta,header].filter(Boolean).join(',')||'none'};
}
function concealedByAncestor($:ReturnType<typeof load>,element:Parameters<ReturnType<typeof load>>[0],stop?:Parameters<ReturnType<typeof load>>[0]):boolean{
  let current=$(element);while(current.length){const node=current[0];if(elementConcealed($,node))return true;if(stop&&node===stop)break;current=current.parent()}return false;
}
async function verifyPublic(receipt:RaindropReceipt,account:Account&{raindrop:NonNullable<Account['raindrop']>},deps:RaindropDependencies):Promise<{url:string;rel:string;robots:string}|undefined>{
  if(!receipt.itemId)return;const max=Math.min(10,Math.max(1,deps.maxPages??DEFAULT_MAX_PAGES));
  for(let page=0;page<max;page++){const context=await publicPage(account.raindrop.publicUrl,deps,page);if(context.collectionId!==receipt.collectionId||context.ownerId!==receipt.ownerId)return;const found=visibleMatch(context,receipt);if(found)return {url:account.raindrop.publicUrl,...found};if(context.items.length<PER_PAGE)return}
}

async function knownReceipt(context:ExecutionContext,receipt:RaindropReceipt,deps:RaindropDependencies):Promise<RaindropReconcileResult>{
  let payload:BoundPayload;try{payload=boundPayload(context)}catch{return {status:'unknown'}}const account=payload.account;if(!raindropReceiptMatchesTask(context.task,account,receipt)||!receipt.itemId)return {status:'unknown'};
  let value:Json;try{value=await api(`/rest/v1/raindrop/${receipt.itemId}`,await context.secrets.get(`account:${account.id}`)??'',{method:'GET'},{...deps,signal:context.signal})}catch{return {status:'unknown'}}
  const item=remoteItem(value.item);if(!item||item.id!==receipt.itemId||!matches(item,receipt))return {status:'unknown'};
  const bound={...receipt,remoteCreatedAt:item.created,stage:'api_receipt' as const};try{const page=await verifyPublic(bound,account,{...deps,signal:context.signal});return page?{status:'found',publicUrl:page.url,raindrop:{...bound,stage:'published'}}:{status:'unknown'}}catch{return {status:'unknown'}}
}

/** Known-ID and unknown-ID recovery are reads only. This function never creates a second item. */
export async function reconcileRaindropTask(context:ExecutionContext,deps:RaindropDependencies={}):Promise<RaindropReconcileResult>{
  const receipt=context.task.raindrop;if(!receipt)return {status:'unknown'};let payload:BoundPayload;try{payload=boundPayload(context)}catch{return {status:'unknown'}}if(!raindropReceiptMatchesTask(context.task,payload.account,receipt))return {status:'unknown'};
  if(receipt.itemId)return knownReceipt(context,receipt,deps);
  if(receipt.stage!=='submitting'||!receipt.baselineComplete)return {status:'unknown'};
  const token=await context.secrets.get(`account:${payload.account.id}`);if(!token)return {status:'unknown'};
  let listing:{items:RemoteItem[];complete:boolean};try{listing=await listItems(token,receipt.collectionId,{...deps,signal:context.signal})}catch{return {status:'unknown'}}if(!listing.complete)return {status:'unknown'};
  const intentAt=Date.parse(receipt.createdAt),baseline=new Set(receipt.baselineItemIds),started=intentAt-5*60000,ended=intentAt+5*60000,candidates=listing.items.filter(item=>!baseline.has(item.id)&&matches(item,receipt)&&Date.parse(item.created)>=started&&Date.parse(item.created)<=ended);
  if(candidates.length!==1)return {status:'unknown'};return knownReceipt(context,{...receipt,itemId:candidates[0].id,remoteCreatedAt:candidates[0].created,stage:'api_receipt'},deps);
}

export async function verifyRaindropPublication(task:Task,_target:string,deps:RaindropDependencies={}):Promise<LinkResult>{
  const fail=(outcome:LinkResult['outcome'],reason:string):LinkResult=>({found:false,outcome,url:task.publicUrl??'https://raindrop.io/',rel:'unknown',reason});
  const receipt=task.raindrop;if(task.channelId!==CHANNEL_ID||task.sourceDomain!==SOURCE_DOMAIN||!receipt||receipt.stage!=='published'||!receipt.itemId||!task.publicUrl)return fail('invalid','Raindrop 缺少已绑定的公开回读证据');
  return fail('unreachable','Raindrop 公开检查必须使用原账号和合集绑定');
}

export async function verifyRaindropTask(context:ExecutionContext,deps:RaindropDependencies={}):Promise<LinkResult>{
  const result=await reconcileRaindropTask(context,deps);if(result.status!=='found')return {found:false,outcome:'unreachable',url:context.task.publicUrl??context.getAccount()?.publicationUrl??'https://raindrop.io/',rel:'unknown',reason:'Raindrop API 与公开页的原条目还未同时核对'};
  const account=context.getAccount();if(!validRaindropAccount(account))return {found:false,outcome:'invalid',url:result.publicUrl,rel:'unknown',reason:'Raindrop 原合集绑定已失效'};
  const page=await verifyPublic(result.raindrop,account,{...deps,signal:context.signal});if(!page)return {found:false,outcome:'invalid',url:result.publicUrl,rel:'unknown',reason:'Raindrop 公开页未显示原标题、摘要和直达链接'};
  return {found:true,outcome:'found',url:page.url,rel:page.rel,reason:`Raindrop 原合集公开页可见标题、摘要与直达链接；抓取规则=${page.robots}，不代表搜索收录`};
}

export async function runRaindropTask(context:ExecutionContext,deps:RaindropDependencies={}):Promise<RaindropExecutionResult>{
  const prior=context.task.raindrop;
  if(prior){
    const account=context.getAccount();if(!raindropReceiptMatchesTask(context.task,account,prior))return {status:'needs_input',message:'Raindrop 原提交信息、账号或合集已改变，禁止重发',raindrop:prior,checkpoint:`raindrop_${prior.stage}`,submittedAt:prior.createdAt};
    const recovered=await reconcileRaindropTask(context,deps);return recovered.status==='found'?{status:'review',message:'Raindrop 原条目已通过 API 和公开页找回，没有重发',publicUrl:recovered.publicUrl,raindrop:recovered.raindrop,checkpoint:'raindrop_published',submittedAt:prior.createdAt}:{status:'review',message:'Raindrop 原提交仍未能唯一确认；保留完整提交信息且不会重发',...(prior.itemId?{publicUrl:account!.raindrop!.publicUrl}:{}),raindrop:prior,checkpoint:`raindrop_${prior.stage}`,submittedAt:prior.createdAt};
  }
  if(context.task.submittedAt||context.task.publicUrl||/^raindrop_/.test(context.task.checkpoint??''))return {status:'needs_input',message:'Raindrop 已有不完整提交痕迹，不会重发'};
  const payload=approvedPayload(context),binding=payload.account.raindrop;
  const token=await context.secrets.get(`account:${payload.account.id}`);if(!token)throw Error('Raindrop 加密 Test token 不可用');
  const baseline=await listItems(token,binding.collectionId,{...deps,signal:context.signal});
  const existing=baseline.items.filter(item=>item.link===payload.target);if(existing.length)return {status:'needs_input',message:'Raindrop 该合集已有相同目标；可接回现有项，不计为新发布'};
  const selected=await readRaindropCollection(token,binding.collectionId,{...deps,signal:context.signal});
  if(selected.ownerId!==binding.ownerId||selected.parentId!==undefined||!selected.public||selected.accessLevel!==4)throw Error('Raindrop 原合集已非本人公开根合集，未发送');
  await verifyRaindropPublicCollection(binding.publicUrl,binding.collectionId,binding.ownerId,{...deps,signal:context.signal});
  const createdAt=stamp(deps),prepared:RaindropReceipt={operationId:operationId(context.task.id),ownerId:binding.ownerId,collectionId:binding.collectionId,tokenVersion:binding.tokenVersion,target:payload.target,title:payload.title,excerpt:payload.excerpt,payloadHash:payloadHash(payload.target,payload.title,payload.excerpt,binding.collectionId),createdAt,baselineItemIds:baseline.items.map(item=>item.id),baselineComplete:baseline.complete,stage:'prepared'};
  context.checkpoint({raindrop:prepared,checkpoint:'raindrop_prepared',submittedAt:createdAt});
  if(!baseline.complete)return {status:'needs_input',message:'Raindrop 合集基线超过有界读取范围，未发送；请换用专用空根合集',raindrop:prepared,checkpoint:'raindrop_prepared',submittedAt:createdAt};
  const submitting={...prepared,stage:'submitting' as const};context.checkpoint({raindrop:submitting,checkpoint:'raindrop_submitting',submittedAt:createdAt});
  let value:Json;try{value=await api('/rest/v1/raindrop',token,{method:'POST',body:JSON.stringify({link:payload.target,title:payload.title,excerpt:payload.excerpt,collection:{$id:Number(binding.collectionId)},type:'link'})},{...deps,signal:context.signal})}catch{return {status:'review',message:'Raindrop 单次创建结果不明；已保留基线与原提交信息，只会读取核对',raindrop:submitting,checkpoint:'raindrop_submitting',submittedAt:createdAt}}
  const item=remoteItem(value.item);if(!item||!matches(item,submitting)||baseline.items.some(existing=>existing.id===item.id))return {status:'review',message:'Raindrop 返回内容无法绑定原账号、合集或内容；不会重发',raindrop:submitting,checkpoint:'raindrop_submitting',submittedAt:createdAt};
  const accepted={...submitting,stage:'api_receipt' as const,itemId:item.id,remoteCreatedAt:item.created};context.checkpoint({raindrop:accepted,checkpoint:'raindrop_api_receipt',submittedAt:createdAt,publicUrl:binding.publicUrl});
  const verified=await reconcileRaindropTask({...context,task:{...context.task,raindrop:accepted,submittedAt:createdAt,publicUrl:binding.publicUrl}},deps);
  return verified.status==='found'?{status:'review',message:'Raindrop 平台返回记录及公开页标题、摘要和链接已一致',publicUrl:verified.publicUrl,raindrop:verified.raindrop,checkpoint:'raindrop_published',submittedAt:createdAt}:{status:'review',message:'Raindrop 平台返回记录已保留；公开页尚未同时显示标题、摘要和链接，暂不计数',publicUrl:binding.publicUrl,raindrop:accepted,checkpoint:'raindrop_api_receipt',submittedAt:createdAt};
}

export const raindropTesting={api,collectionOption,parsePublicContext,remoteItem,payloadHash,visibleMatch,validAccount:validRaindropAccount};
