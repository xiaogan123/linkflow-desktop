import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import {applyDeclaredArticleVisibility,pageRobotsDirectives,publicPagePolicy} from './article-visibility';
import {inspectRenderedArticle} from './article-rendering';
import {renderShareYourHtmlArticle,type ShareYourHtmlArticleDraft} from './shareyourhtml-article';

export const HART_ORIGIN='https://hart.intrane.fr';
export const HART_PUBLISH_URL=`${HART_ORIGIN}/v1/publish`;
export const HART_ROBOTS_URL=`${HART_ORIGIN}/robots.txt`;
export const HART_MAX_RESPONSE_BYTES=256*1024;
export const HART_MAX_PAGE_BYTES=512*1024;
const SEG=/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const OP=/^hart_[a-f0-9]{32}$/;
const HASH=/^[a-f0-9]{64}$/;

export interface HartArticle{fragment:string;markdown:string;title:string;targetUrl:string;sourceHash:string;byteLength:number}
export interface HartIntent{operationId:string;owner:string;artifact:string;publicUrl:string;sourceHash:string;requestHash:string;createdAt:string}
export interface HartReceipt extends HartIntent{version:number;latestUrl:string;pinnedUrl:string;visibility:'public';format:'html';cspMode:'strict'}
export interface HartOpaqueResponse extends HartIntent{version:1;kind:'hart_opaque_response';status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;bodySha256:string}
export interface HartPersistence{
  readonly secretStorage:'encrypted';
  persistIntent(value:{intent:HartIntent;ownerKey:string}):Promise<void>;
  assertReadyToSubmit(intent:HartIntent):true;
  persistOpaqueResponse(value:HartOpaqueResponse):Promise<void>;
  loadOpaqueResponse():Promise<HartOpaqueResponse|undefined>;
  promoteReceipt(value:HartReceipt):Promise<void>;
}
export interface HartDependencies{fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date;allowExternalWrite?:boolean}
export type HartDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'schema'|'redirect'|'media_type'|'http_status';
export type HartCreateResult=
  |{status:'not_started';reason:'external_write_disabled'|'invalid_input'|'intent_not_persisted'|'authorization_changed'}
  |{status:'blocked';intent:HartIntent;reason:'prior_submission'}
  |{status:'unknown';intent:HartIntent;diagnostic:HartDiagnostic;opaqueResponseSaved:boolean}
  |{status:'created';receipt:HartReceipt};
export type HartVerification=
  |{status:'usable';receipt:HartReceipt;rel:string;pageSha256:string;rawSha256:string;robots:'allowed'|'not_declared'}
  |{status:'invalid'|'unavailable';reason:'binding'|'response'|'raw'|'versions'|'content'|'indexing'|'canonical'|'robots'|'network'};
export type HartRecovery=
  |{status:'accepted';receipt:HartReceipt;verification:Extract<HartVerification,{status:'usable'}>}
  |{status:'published_unverified';receipt:HartReceipt;verification:Exclude<HartVerification,{status:'usable'}>}
  |{status:'present_unknown';publicUrl:string;rawHash:string}
  |{status:'unknown'};

const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function hartPublicUrl(owner:string,artifact:string){if(!SEG.test(owner)||!SEG.test(artifact))throw Error('Hart owner/artifact 无效');return `${HART_ORIGIN}/a/${owner}/${artifact}`}
export function hartRawUrl(owner:string,artifact:string){return `${HART_ORIGIN}/v1/artifacts/${owner}/${artifact}/html`}
export function hartVersionsUrl(owner:string,artifact:string){return `${HART_ORIGIN}/v1/artifacts/${owner}/${artifact}/versions`}
function publishUrl(owner:string,artifact:string,title:string){const q=new URLSearchParams({owner,artifact,visibility:'public',title,no_chrome:'1'});return `${HART_PUBLISH_URL}?${q}`}
export function hartRequestHash(owner:string,artifact:string,title:string,fragment:string){return sha(`POST ${publishUrl(owner,artifact,title)}\ncontent-type:text/html\nsha256:${sha(fragment)}\nbytes:${Buffer.byteLength(fragment)}`)}
export function validHartIntent(value:HartIntent){return OP.test(value.operationId)&&SEG.test(value.owner)&&SEG.test(value.artifact)&&value.publicUrl===hartPublicUrl(value.owner,value.artifact)&&HASH.test(value.sourceHash)&&HASH.test(value.requestHash)&&Number.isFinite(Date.parse(value.createdAt))&&new Date(value.createdAt).toISOString()===value.createdAt}

export function renderHartArticle(input:{draft:ShareYourHtmlArticleDraft;targetUrl:string;language:string}):HartArticle{
  const rendered=renderShareYourHtmlArticle({...input,slug:'hart-publication'}),$=load(rendered.html),fragment=$('body').html()??'';
  if(!fragment||/<\/?(?:!doctype|html|head|body)\b/i.test(fragment)||/<(?:script|iframe|img|object|embed|base|link)\b/i.test(fragment)||/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/i.test(fragment))throw Error('Hart 文章片段不符合自包含 HTML 合约');
  return Object.freeze({fragment,markdown:input.draft.body,title:input.draft.title,targetUrl:rendered.targetUrl,sourceHash:sha(fragment),byteLength:Buffer.byteLength(fragment)});
}

function sameIntent(a:HartIntent,b:HartIntent){return a.operationId===b.operationId&&a.owner===b.owner&&a.artifact===b.artifact&&a.publicUrl===b.publicUrl&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}
function validOwnerKey(value:string){return value.length>=24&&value.length<=256&&!/[\s\u0000-\u001f\u007f]/u.test(value)}
function strictBase64(value:string,max=HART_MAX_RESPONSE_BYTES){const bytes=Buffer.from(value,'base64');return bytes.length<=max&&bytes.toString('base64')===value}
function receiptFrom(value:unknown,intent:HartIntent):HartReceipt|undefined{
  if(!value||typeof value!=='object'||Array.isArray(value))return;const v=value as Record<string,unknown>,version=v.version;
  if(v.ok!==true||v.id!==`${intent.owner}/${intent.artifact}`||v.owner!==intent.owner||v.artifact!==intent.artifact||!Number.isInteger(version)||Number(version)<1||v.format!=='html'||v.visibility!=='public'||v.csp_mode!=='strict'||v.url!==intent.publicUrl||v.latest_url!==`${intent.publicUrl}/latest`||v.pinned_url!==`${intent.publicUrl}/v${version}`||!Array.isArray(v.lint))return;
  return {...intent,version:Number(version),latestUrl:v.latest_url as string,pinnedUrl:v.pinned_url as string,visibility:'public',format:'html',cspMode:'strict'};
}
export function parseHartOpaqueResponse(opaque:HartOpaqueResponse,intent:HartIntent):HartReceipt|{diagnostic:HartDiagnostic}{
  if(!sameIntent(opaque,intent)||!HASH.test(opaque.bodySha256)||!strictBase64(opaque.bodyBase64)||sha(Buffer.from(opaque.bodyBase64,'base64'))!==opaque.bodySha256)return {diagnostic:'schema'};
  if(opaque.redirected||opaque.responseType==='opaqueredirect'||opaque.status>=300&&opaque.status<400)return {diagnostic:'redirect'};
  try{if(opaque.responseUrl&&opaque.responseUrl!==publishUrl(intent.owner,intent.artifact,new URL(opaque.responseUrl).searchParams.get('title')??''))return {diagnostic:'redirect'}}catch{return {diagnostic:'redirect'}}
  if(opaque.status!==200)return {diagnostic:'http_status'};if(opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return {diagnostic:'media_type'};
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(opaque.bodyBase64,'base64'))}catch{return {diagnostic:'decode'}}
  let value:unknown;try{value=JSON.parse(text)}catch{return {diagnostic:'json'}}const receipt=receiptFrom(value,intent);return receipt??{diagnostic:'schema'};
}

class ReadError extends Error{constructor(readonly kind:'invalid'|'unavailable'|'absent'){super(kind)}}
class BodyLimitError extends Error{}
function discard(r:Response){if(r.body&&!r.body.locked)void r.body.cancel().catch(()=>undefined)}
async function bounded(response:Response,max:number,signal:AbortSignal){const n=response.headers.get('content-length');if(n!==null&&(!/^\d+$/.test(n)||Number(n)>max)){discard(response);throw new BodyLimitError()}if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){if(signal.aborted)throw Error('abort');const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>max){void reader.cancel().catch(()=>undefined);throw new BodyLimitError()}parts.push(next.value)}}finally{reader.releaseLock()}return Buffer.concat(parts.map(value=>Buffer.from(value)))}
async function request(url:string,init:RequestInit,deps:HartDependencies,max:number,allow404=false){const c=new AbortController(),external=()=>c.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)c.abort();const timer=setTimeout(()=>c.abort(),Math.min(60_000,Math.max(50,deps.timeoutMs??20_000)));timer.unref?.();let r:Response|undefined;try{const transport=deps.fetch??((u:string,i:RequestInit)=>fetch(u,i));r=await transport(url,{...init,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:c.signal});if(r.redirected||r.type==='opaqueredirect'||r.status>=300&&r.status<400||r.url&&r.url!==url)throw new ReadError('invalid');if(r.status===404&&allow404)return {response:r,bytes:new Uint8Array()};if(r.status!==200)throw new ReadError(r.status===404?'absent':r.status>=500||[408,429].includes(r.status)?'unavailable':'invalid');return {response:r,bytes:await bounded(r,max,c.signal)}}catch(error){if(r&&!r.bodyUsed)discard(r);if(error instanceof ReadError||error instanceof BodyLimitError)throw error;throw new ReadError('unavailable')}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external)}}

export async function createHartPublication(input:{operationId:string;owner:string;artifact:string;ownerKey:string;article:HartArticle;priorIntent?:HartIntent},persistence:HartPersistence,deps:HartDependencies={}):Promise<HartCreateResult>{
  if(deps.allowExternalWrite!==true)return {status:'not_started',reason:'external_write_disabled'};
  if(persistence.secretStorage!=='encrypted'||!OP.test(input.operationId)||!SEG.test(input.owner)||!SEG.test(input.artifact)||!validOwnerKey(input.ownerKey)||sha(input.article.fragment)!==input.article.sourceHash)return {status:'not_started',reason:'invalid_input'};
  if(input.priorIntent)return validHartIntent(input.priorIntent)?{status:'blocked',intent:{...input.priorIntent},reason:'prior_submission'}:{status:'not_started',reason:'invalid_input'};
  const intent:HartIntent={operationId:input.operationId,owner:input.owner,artifact:input.artifact,publicUrl:hartPublicUrl(input.owner,input.artifact),sourceHash:input.article.sourceHash,requestHash:hartRequestHash(input.owner,input.artifact,input.article.title,input.article.fragment),createdAt:(deps.now?.()??new Date()).toISOString()};
  try{await persistence.persistIntent({intent,ownerKey:input.ownerKey})}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  const url=publishUrl(input.owner,input.artifact,input.article.title),controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const timer=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(50,deps.timeoutMs??25_000)));timer.unref?.();let response:Response|undefined;
  try{const transport=deps.fetch??((u:string,i:RequestInit)=>fetch(u,i));response=await transport(url,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json','content-type':'text/html','x-hart-owner-key':input.ownerKey},body:input.article.fragment});const bytes=await bounded(response,HART_MAX_RESPONSE_BYTES,controller.signal);const opaque:HartOpaqueResponse={...intent,version:1,kind:'hart_opaque_response',status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:sha(bytes)};try{await persistence.persistOpaqueResponse(opaque)}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:false}}const parsed=parseHartOpaqueResponse(opaque,intent);if('diagnostic'in parsed)return {status:'unknown',intent,diagnostic:parsed.diagnostic,opaqueResponseSaved:true};try{await persistence.promoteReceipt(parsed);return {status:'created',receipt:parsed}}catch{return {status:'unknown',intent,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}}catch(error){controller.abort();if(response)discard(response);return {status:'unknown',intent,diagnostic:error instanceof BodyLimitError?'body_limit':'transport',opaqueResponseSaved:false}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external)}
}

function httpCanonicalMatches(header:string|null,url:string){if(!header)return true;for(const part of header.split(/,(?=\s*<)/)){const target=part.match(/^\s*<([^>]*)>/),relation=part.match(/;\s*rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;,\s]+))/i);if(!relation||!(relation[1]??relation[2]??relation[3]).toLowerCase().split(/\s+/).includes('canonical'))continue;try{if(!target||new URL(target[1],url).href!==url)return false}catch{return false}}return true}
function robotsAllows(text:string,path:string){let active=false,allowed=true;for(const raw of text.split(/\r?\n/)){const m=raw.replace(/#.*$/,'').trim().match(/^([^:]+):\s*(.*)$/);if(!m)continue;const k=m[1].toLowerCase(),v=m[2].trim();if(k==='user-agent')active=v==='*'||['googlebot','bingbot'].includes(v.toLowerCase());else if(active&&k==='disallow'&&v&&path.startsWith(v))allowed=false;else if(active&&k==='allow'&&v&&path.startsWith(v))allowed=true}return allowed}
async function readJson(url:string,deps:HartDependencies,max=HART_MAX_PAGE_BYTES){const r=await request(url,{method:'GET',headers:{accept:'application/json'}},deps,max);if(r.response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')throw new ReadError('invalid');try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(r.bytes)) as unknown}catch{throw new ReadError('invalid')}}
export async function verifyHartPublication(receipt:HartReceipt,article:HartArticle,deps:HartDependencies={}):Promise<HartVerification>{
  if(!validHartIntent(receipt)||receipt.publicUrl!==hartPublicUrl(receipt.owner,receipt.artifact)||receipt.sourceHash!==article.sourceHash||receipt.requestHash!==hartRequestHash(receipt.owner,receipt.artifact,article.title,article.fragment))return {status:'invalid',reason:'binding'};
  try{const [page,raw,versions,robots]=await Promise.all([request(receipt.publicUrl,{method:'GET',headers:{accept:'text/html'}},deps,HART_MAX_PAGE_BYTES),readJson(hartRawUrl(receipt.owner,receipt.artifact),deps),readJson(hartVersionsUrl(receipt.owner,receipt.artifact),deps),request(HART_ROBOTS_URL,{method:'GET',headers:{accept:'text/plain'}},deps,64*1024,true)]);const rv=raw as Record<string,unknown>,vv=versions as Record<string,unknown>;if(rv.ok!==true||rv.id!==`${receipt.owner}/${receipt.artifact}`||rv.version!==receipt.version||rv.format!=='html'||rv.html!==article.fragment)return {status:'invalid',reason:'raw'};if(vv.ok!==true||vv.id!==rv.id||!Array.isArray(vv.versions)||!vv.versions.some(item=>!!item&&typeof item==='object'&&(item as Record<string,unknown>).version===receipt.version))return {status:'invalid',reason:'versions'};if(!httpCanonicalMatches(page.response.headers.get('link'),receipt.publicUrl))return {status:'invalid',reason:'canonical'};const html=new TextDecoder('utf-8',{fatal:true}).decode(page.bytes),$=load(html);applyDeclaredArticleVisibility($);if(page.response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='text/html'||!publicPagePolicy($,receipt.publicUrl,page.response.headers.get('x-robots-tag')??'').valid)return {status:'invalid',reason:'indexing'};const canonical=$('link[rel]').toArray().filter(node=>($(node).attr('rel')??'').toLowerCase().split(/\s+/).includes('canonical'));if(canonical.some(node=>{try{return new URL($(node).attr('href')??'',receipt.publicUrl).href!==receipt.publicUrl}catch{return true}}))return {status:'invalid',reason:'canonical'};let robotsState:'allowed'|'not_declared'='not_declared';if(robots.response.status===200){const text=new TextDecoder('utf-8',{fatal:true}).decode(robots.bytes);if(!robotsAllows(text,new URL(receipt.publicUrl).pathname))return {status:'invalid',reason:'robots'};robotsState='allowed'}const inspected=inspectRenderedArticle(html,article.markdown,article.targetUrl,'main > article > section',{pageUrl:receipt.publicUrl,robotsHeader:page.response.headers.get('x-robots-tag')??''});if(!inspected.found)return {status:'invalid',reason:'content'};return {status:'usable',receipt,rel:inspected.rel,pageSha256:sha(page.bytes),rawSha256:sha(article.fragment),robots:robotsState}}catch(error){return {status:error instanceof ReadError&&error.kind==='invalid'?'invalid':'unavailable',reason:error instanceof ReadError&&error.kind==='invalid'?'response':'network'}}
}

export async function recoverHartPublication(intent:HartIntent,article:HartArticle,persistence:HartPersistence,deps:HartDependencies={}):Promise<HartRecovery>{
  const opaque=await persistence.loadOpaqueResponse();if(opaque){const parsed=parseHartOpaqueResponse(opaque,intent);if(!('diagnostic'in parsed)){try{await persistence.promoteReceipt(parsed)}catch{/* a durable receipt may already exist */}const verification=await verifyHartPublication(parsed,article,deps);return verification.status==='usable'?{status:'accepted',receipt:parsed,verification}:{status:'published_unverified',receipt:parsed,verification}}}
  try{const [page,raw,versions]=await Promise.all([request(intent.publicUrl,{method:'GET',headers:{accept:'text/html'}},deps,HART_MAX_PAGE_BYTES),readJson(hartRawUrl(intent.owner,intent.artifact),deps),readJson(hartVersionsUrl(intent.owner,intent.artifact),deps)]);const rv=raw as Record<string,unknown>,vv=versions as Record<string,unknown>,text=new TextDecoder('utf-8',{fatal:true}).decode(page.bytes);if(rv.ok===true&&rv.id===`${intent.owner}/${intent.artifact}`&&rv.html===article.fragment&&vv.ok===true&&vv.id===rv.id&&text.includes(article.targetUrl))return {status:'present_unknown',publicUrl:intent.publicUrl,rawHash:sha(article.fragment)}}catch{/* The permanent latch remains even when all reads are absent. */}return {status:'unknown'};
}

export async function runHartAcceptance(input:{operationId:string;owner:string;artifact:string;ownerKey:string;draft:ShareYourHtmlArticleDraft;targetUrl:string;language:string;priorIntent?:HartIntent},persistence:HartPersistence,deps:HartDependencies={}):Promise<{article:HartArticle;create?:HartCreateResult;recovery?:HartRecovery;verification?:HartVerification}>{const article=renderHartArticle(input);if(input.priorIntent)return {article,recovery:await recoverHartPublication(input.priorIntent,article,persistence,deps)};const create=await createHartPublication({...input,article},persistence,deps);if(create.status!=='created')return {article,create};const verification=await verifyHartPublication(create.receipt,article,deps);return {article,create,verification}}
export const hartTesting={SEG,OP,sameIntent,receiptFrom,publishUrl,robotsAllows,pageRobotsDirectives};
