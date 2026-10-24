import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import type {SecretStore} from '../shared/types';
import {inspectRenderedArticle} from './article-rendering';

export const YAP_API_ORIGIN='https://api.letyap.com';
export const YAP_REGISTER_URL=`${YAP_API_ORIGIN}/api/v1/agents`;
export const YAP_PAGES_URL=`${YAP_API_ORIGIN}/api/v1/pages`;
export const YAP_PUBLISH_URL=`${YAP_API_ORIGIN}/api/v1/publish`;
export const YAP_STATS_URL=`${YAP_API_ORIGIN}/api/v1/me/stats`;
export const YAP_MAX_RESPONSE_BYTES=256*1024;
export const YAP_MAX_PAGE_BYTES=1024*1024;

const HANDLE=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OP=/^yap_[a-f0-9]{32}_(?:register|page|publish)$/;
const HASH=/^[a-f0-9]{64}$/;
const KEY=/^[^\s\u0000-\u001f\u007f]{16,8192}$/u;

export type YapStage='register'|'page'|'publish';
export interface YapIdentity{name:string;apiKey:string}
export interface YapPage{handle:string;title:string;type:'creator'}
export interface YapArticle{title:string;body:string;targetUrl:string;bodySha256:string;byteLength:number}
export interface YapIntent{operationId:string;stage:YapStage;requestUrl:string;requestHash:string;createdAt:string;handle?:string;title?:string;bodySha256?:string}
export interface YapOpaqueResponse extends YapIntent{version:1;kind:'yap_opaque_response';status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;bodyBase64:string;responseSha256:string}
export interface YapReceipt extends YapIntent{publicUrl:string}

/** Implementations must encrypt every value, because registration responses contain the API key. */
export interface YapPersistence{
  readonly secretStorage:'encrypted';
  loadIdentity():Promise<YapIdentity|undefined>;
  loadPage():Promise<YapPage|undefined>;
  loadIntent(stage:YapStage):Promise<YapIntent|undefined>;
  loadOpaqueResponse(stage:YapStage):Promise<YapOpaqueResponse|undefined>;
  persistIntent(intent:YapIntent):Promise<void>;
  assertReadyToSubmit(intent:YapIntent):true;
  persistOpaqueResponse(response:YapOpaqueResponse):Promise<void>;
  promoteIdentity(identity:YapIdentity):Promise<void>;
  promotePage(page:YapPage):Promise<void>;
  promoteReceipt(receipt:YapReceipt):Promise<void>;
}
export interface YapDependencies{fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date;allowExternalWrite?:boolean}
export type YapDiagnostic='transport'|'body_limit'|'opaque_persistence'|'decode'|'json'|'schema'|'redirect'|'media_type'|'http_status';
export type YapStepResult<T>=
  |{status:'not_started';reason:'external_write_disabled'|'invalid_input'|'intent_not_persisted'|'authorization_changed'}
  |{status:'blocked';intent:YapIntent;reason:'prior_submission'}
  |{status:'unknown';intent:YapIntent;diagnostic:YapDiagnostic;opaqueResponseSaved:boolean}
  |{status:'created';value:T};
export type YapVerification=
  |{status:'usable';publicUrl:string;pageSha256:string;rel:string;robots:'allowed'}
  |{status:'invalid'|'unavailable';reason:'url'|'response'|'content'|'indexing'|'canonical'|'robots'|'link'|'network'};
export type YapReconciliation=
  |{status:'found';receipt:YapReceipt;verification:Extract<YapVerification,{status:'usable'}>}
  |{status:'published_unverified';receipt:YapReceipt;verification:Exclude<YapVerification,{status:'usable'}>}
  |{status:'unknown';checkedUrls:string[]};

const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const json=(value:unknown)=>JSON.stringify(value);
function record(value:string|undefined):unknown{if(value===undefined)return;try{return JSON.parse(value)}catch{return}}
const secretStoreStageClaims=new WeakMap<SecretStore,Set<string>>();
function claimSecretStoreStage(store:SecretStore,key:string){let claims=secretStoreStageClaims.get(store);if(!claims){claims=new Set();secretStoreStageClaims.set(store,claims)}if(claims.has(key))throw Error('Yap in-process stage claim 已存在');claims.add(key)}

/** Uses the existing keychain-backed SecretStore; no live credential is written to evidence or ordinary files. */
export class YapSecretStorePersistence implements YapPersistence{
  readonly secretStorage='encrypted' as const;private active?:YapIntent;
  constructor(private readonly secrets:SecretStore,private readonly namespace='default'){if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(namespace))throw Error('Yap secret namespace 无效')}
  private key(name:string){return `yap:${this.namespace}:${name}`}
  private async read<T>(name:string){return record(await this.secrets.get(this.key(name))) as T|undefined}
  private write(name:string,value:unknown){return this.secrets.set(this.key(name),json(value))}
  async loadIdentity(){const value=await this.read<YapIdentity>('identity');return value&&validIdentity(value)?value:undefined}
  async loadPage(){const value=await this.read<YapPage>('page');return value&&validPage(value)?value:undefined}
  async loadIntent(stage:YapStage){const value=await this.read<YapIntent>(`intent:${stage}`);return value&&validIntent(value)&&value.stage===stage?value:undefined}
  async loadOpaqueResponse(stage:YapStage){const value=await this.read<YapOpaqueResponse>(`opaque:${stage}`);return value?.kind==='yap_opaque_response'&&value.stage===stage?value:undefined}
  async persistIntent(value:YapIntent){if(!validIntent(value))throw Error('Yap permanent latch 无效');const name=`${this.namespace}:${value.stage}`;claimSecretStoreStage(this.secrets,name);if(await this.secrets.get(this.key(`intent:${value.stage}`))!==undefined)throw Error('Yap permanent latch 已存在');await this.write(`intent:${value.stage}`,value);const saved=await this.loadIntent(value.stage);if(!saved||!sameIntent(saved,value))throw Error('Yap permanent latch 未能回读');this.active=value}
  assertReadyToSubmit(value:YapIntent):true{if(!this.active||!sameIntent(this.active,value))throw Error('Yap 提交授权与持久化意图不一致');return true}
  async persistOpaqueResponse(value:YapOpaqueResponse){if(!this.active||!sameIntent(this.active,value))throw Error('Yap 原响应与当前意图不一致');await this.write(`opaque:${value.stage}`,value)}
  async promoteIdentity(value:YapIdentity){if(!validIdentity(value)||!await this.loadOpaqueResponse('register'))throw Error('Yap 注册原响应尚未加密保存');await this.write('identity',value)}
  async promotePage(value:YapPage){if(!validPage(value)||!await this.loadOpaqueResponse('page'))throw Error('Yap 页面原响应尚未加密保存');await this.write('page',value)}
  async promoteReceipt(value:YapReceipt){if(!validIntent(value)||value.stage!=='publish'||!await this.loadOpaqueResponse('publish'))throw Error('Yap 发布原响应尚未加密保存');await this.write('receipt',value)}
}
export function yapPageOrigin(handle:string){if(!HANDLE.test(handle))throw Error('Yap handle 无效');return `https://${handle}.letyap.com`}
export function prepareYapArticle(input:{title:string;body:string;targetUrl:string}):YapArticle{
  const title=input.title.trim(),body=input.body.trim(),targetUrl=new URL(input.targetUrl).href;
  if(title.length<8||title.length>180||body.length<300||Buffer.byteLength(body)>500*1024||!body.includes(targetUrl))throw Error('Yap 稿件缺少标题、正文或精确目标链接');
  return Object.freeze({title,body,targetUrl,bodySha256:sha(body),byteLength:Buffer.byteLength(body)});
}
function validIdentity(value:YapIdentity){return value.name.trim()===value.name&&value.name.length>=2&&value.name.length<=120&&KEY.test(value.apiKey)}
function validPage(value:YapPage){return HANDLE.test(value.handle)&&value.title.trim()===value.title&&value.title.length>=2&&value.title.length<=120&&value.type==='creator'}
function validIntent(value:YapIntent){return OP.test(value.operationId)&&['register','page','publish'].includes(value.stage)&&value.requestUrl===[YAP_REGISTER_URL,YAP_PAGES_URL,YAP_PUBLISH_URL][['register','page','publish'].indexOf(value.stage)]&&HASH.test(value.requestHash)&&Number.isFinite(Date.parse(value.createdAt))&&new Date(value.createdAt).toISOString()===value.createdAt}
function sameIntent(a:YapIntent,b:YapIntent){return a.operationId===b.operationId&&a.stage===b.stage&&a.requestUrl===b.requestUrl&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt&&a.handle===b.handle&&a.title===b.title&&a.bodySha256===b.bodySha256}
function requestHash(url:string,payload:unknown){const body=json(payload);return sha(`POST ${url}\ncontent-type:application/json\nsha256:${sha(body)}\nbytes:${Buffer.byteLength(body)}`)}
function operationId(seed:string,stage:YapStage){const clean=seed.toLowerCase().replace(/[^a-f0-9]/g,'');if(clean.length!==32)throw Error('Yap 单次操作编号必须包含 32 位十六进制字符');return `yap_${clean}_${stage}`}
function intent(seed:string,stage:YapStage,payload:unknown,now:Date,extra:Partial<YapIntent>={}):YapIntent{const requestUrl=stage==='register'?YAP_REGISTER_URL:stage==='page'?YAP_PAGES_URL:YAP_PUBLISH_URL;return {operationId:operationId(seed,stage),stage,requestUrl,requestHash:requestHash(requestUrl,payload),createdAt:now.toISOString(),...extra}}

class BodyLimitError extends Error{}
function discard(response:Response){if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
function timedSignal(deps:YapDependencies){const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const timer=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(50,deps.timeoutMs??20_000)));timer.unref?.();return {signal:controller.signal,close(){clearTimeout(timer);deps.signal?.removeEventListener('abort',external)}}}
async function bounded(response:Response,max:number,signal?:AbortSignal){const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>max))throw new BodyLimitError();if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){if(signal?.aborted)throw Error('abort');const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>max)throw new BodyLimitError();parts.push(next.value)}}finally{reader.releaseLock()}return Buffer.concat(parts.map(part=>Buffer.from(part)))}
function opaque(response:Response,bytes:Uint8Array,value:YapIntent):YapOpaqueResponse{return {...value,version:1,kind:'yap_opaque_response',status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,bodyBase64:Buffer.from(bytes).toString('base64'),responseSha256:sha(bytes)}}
function parseOpaque(value:YapOpaqueResponse,expected:YapIntent):unknown|YapDiagnostic{
  if(!sameIntent(value,expected)||!HASH.test(value.responseSha256))return 'schema';let bytes:Buffer;
  try{bytes=Buffer.from(value.bodyBase64,'base64');if(bytes.toString('base64')!==value.bodyBase64||sha(bytes)!==value.responseSha256)return 'schema'}catch{return 'decode'}
  if(value.redirected||value.responseType==='opaqueredirect'||value.status>=300&&value.status<400||value.responseUrl&&value.responseUrl!==expected.requestUrl)return 'redirect';
  if(![200,201].includes(value.status))return 'http_status';if(value.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return 'media_type';
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}catch{return 'decode'}try{return JSON.parse(text)}catch{return 'json'}
}
function strings(value:unknown,out:string[]=[],depth=0):string[]{if(depth>5||out.length>200)return out;if(typeof value==='string')out.push(value);else if(Array.isArray(value))for(const item of value)strings(item,out,depth+1);else if(value&&typeof value==='object')for(const item of Object.values(value))strings(item,out,depth+1);return out}
function apiKey(value:unknown){if(!value||typeof value!=='object'||Array.isArray(value))return;const key=(value as Record<string,unknown>).api_key;return typeof key==='string'&&KEY.test(key)?key:undefined}
function confirmsPage(value:unknown,page:YapPage){return strings(value).some(item=>item===page.handle||item===yapPageOrigin(page.handle)||item.startsWith(`${yapPageOrigin(page.handle)}/`))}
function publicUrl(value:unknown,handle:string){for(const item of strings(value)){try{const url=new URL(item);if(url.protocol==='https:'&&url.hostname===`${handle}.letyap.com`&&url.pathname!=='/'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash)return url.href}catch{/* not a URL */}}}

async function postOnce<T>(value:YapIntent,payload:unknown,apiKeyValue:YapIdentity['apiKey']|undefined,persistence:YapPersistence,deps:YapDependencies,parse:(jsonValue:unknown)=>T|undefined):Promise<YapStepResult<T>>{
  if(deps.allowExternalWrite!==true)return {status:'not_started',reason:'external_write_disabled'};
  const prior=await persistence.loadIntent(value.stage);if(prior)return {status:'blocked',intent:prior,reason:'prior_submission'};
  try{await persistence.persistIntent(value)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  try{if(persistence.assertReadyToSubmit(value)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
  let response:Response|undefined;const timed=timedSignal(deps);
  try{const transport=deps.fetch??((url:string,init:RequestInit)=>fetch(url,init));const headers:Record<string,string>={accept:'application/json','content-type':'application/json'};if(apiKeyValue)headers.authorization=`Bearer ${apiKeyValue}`;response=await transport(value.requestUrl,{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:timed.signal,headers,body:json(payload)});const raw=opaque(response,await bounded(response,YAP_MAX_RESPONSE_BYTES,timed.signal),value);try{await persistence.persistOpaqueResponse(raw)}catch{return {status:'unknown',intent:value,diagnostic:'opaque_persistence',opaqueResponseSaved:false}}const parsed=parseOpaque(raw,value);if(typeof parsed==='string')return {status:'unknown',intent:value,diagnostic:parsed as YapDiagnostic,opaqueResponseSaved:true};const result=parse(parsed);return result===undefined?{status:'unknown',intent:value,diagnostic:'schema',opaqueResponseSaved:true}:{status:'created',value:result}}catch(error){if(response)discard(response);return {status:'unknown',intent:value,diagnostic:error instanceof BodyLimitError?'body_limit':'transport',opaqueResponseSaved:false}}finally{timed.close()}
}

export async function ensureYapIdentity(input:{operationSeed:string;name:string},persistence:YapPersistence,deps:YapDependencies={}):Promise<YapStepResult<YapIdentity>>{
  if(persistence.secretStorage!=='encrypted')return {status:'not_started',reason:'invalid_input'};const reused=await persistence.loadIdentity();if(reused)return validIdentity(reused)?{status:'created',value:reused}:{status:'not_started',reason:'invalid_input'};
  const name=input.name.trim();if(name.length<2||name.length>120)return {status:'not_started',reason:'invalid_input'};const payload={name},prior=await persistence.loadIntent('register');if(prior){const raw=await persistence.loadOpaqueResponse('register');if(raw&&prior.requestHash===requestHash(YAP_REGISTER_URL,payload)){const parsed=parseOpaque(raw,prior),key=typeof parsed==='string'?undefined:apiKey(parsed);if(key){const recovered={name,apiKey:key};try{await persistence.promoteIdentity(recovered);return {status:'created',value:recovered}}catch{return {status:'unknown',intent:prior,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}}}return {status:'blocked',intent:prior,reason:'prior_submission'}}const value=intent(input.operationSeed,'register',payload,deps.now?.()??new Date());
  const result=await postOnce(value,payload,undefined,persistence,deps,body=>{const key=apiKey(body);return key?{name,apiKey:key}:undefined});if(result.status==='created'){try{await persistence.promoteIdentity(result.value)}catch{return {status:'unknown',intent:value,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}return result}return result;
}
export async function ensureYapPage(input:{operationSeed:string;identity:YapIdentity;page:YapPage},persistence:YapPersistence,deps:YapDependencies={}):Promise<YapStepResult<YapPage>>{
  if(persistence.secretStorage!=='encrypted'||!validIdentity(input.identity)||!validPage(input.page))return {status:'not_started',reason:'invalid_input'};const reused=await persistence.loadPage();if(reused)return validPage(reused)&&reused.handle===input.page.handle?{status:'created',value:reused}:{status:'not_started',reason:'invalid_input'};
  const payload=input.page,prior=await persistence.loadIntent('page');if(prior){const raw=await persistence.loadOpaqueResponse('page');if(raw&&prior.requestHash===requestHash(YAP_PAGES_URL,payload)){const parsed=parseOpaque(raw,prior);if(typeof parsed!=='string'&&confirmsPage(parsed,input.page)){try{await persistence.promotePage(input.page);return {status:'created',value:input.page}}catch{return {status:'unknown',intent:prior,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}}}return {status:'blocked',intent:prior,reason:'prior_submission'}}const value=intent(input.operationSeed,'page',payload,deps.now?.()??new Date(),{handle:input.page.handle,title:input.page.title});const result=await postOnce(value,payload,input.identity.apiKey,persistence,deps,body=>confirmsPage(body,input.page)?input.page:undefined);if(result.status==='created'){try{await persistence.promotePage(result.value)}catch{return {status:'unknown',intent:value,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}return result}return result;
}
export async function publishYapOnce(input:{operationSeed:string;identity:YapIdentity;page:YapPage;article:YapArticle},persistence:YapPersistence,deps:YapDependencies={}):Promise<YapStepResult<YapReceipt>>{
  if(persistence.secretStorage!=='encrypted'||!validIdentity(input.identity)||!validPage(input.page)||sha(input.article.body)!==input.article.bodySha256||Buffer.byteLength(input.article.body)!==input.article.byteLength)return {status:'not_started',reason:'invalid_input'};
  const payload={page:input.page.handle,title:input.article.title,format:'guide',body:input.article.body,visibility:'public'},value=intent(input.operationSeed,'publish',payload,deps.now?.()??new Date(),{handle:input.page.handle,title:input.article.title,bodySha256:input.article.bodySha256});const result=await postOnce(value,payload,input.identity.apiKey,persistence,deps,body=>{const url=publicUrl(body,input.page.handle);return url?{...value,publicUrl:url}:undefined});if(result.status==='created'){try{await persistence.promoteReceipt(result.value)}catch{return {status:'unknown',intent:value,diagnostic:'opaque_persistence',opaqueResponseSaved:true}}return result}return result;
}

function robotsAllows(text:string,path:string,agent:string){type Group={agents:string[];rules:{allow:boolean;pattern:string}[]};const groups:Group[]=[];let group:Group={agents:[],rules:[]};const push=()=>{if(group.agents.length)groups.push(group);group={agents:[],rules:[]}};for(const raw of text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/)){const match=raw.replace(/#.*$/,'').trim().match(/^([^:]+):\s*(.*)$/);if(!match)continue;const key=match[1].trim().toLowerCase(),value=match[2].trim();if(key==='user-agent'&&/^(?:\*|[a-z0-9_-]+)$/i.test(value)){if(group.rules.length)push();group.agents.push(value.toLowerCase())}else if((key==='allow'||key==='disallow')&&group.agents.length&&value)group.rules.push({allow:key==='allow',pattern:value})}push();const name=agent.toLowerCase(),ranked=groups.map(value=>({value,score:Math.max(...value.agents.map(item=>item==='*'?0:name.startsWith(item)?item.length:-1))})).filter(value=>value.score>=0);if(!ranked.length)return true;const score=Math.max(...ranked.map(value=>value.score)),rules=ranked.filter(value=>value.score===score).flatMap(value=>value.value.rules);let winner:{allow:boolean;specificity:number}|undefined;for(const rule of rules){const anchored=rule.pattern.endsWith('$'),source=rule.pattern.replace(/\$$/,'').split('*').map(value=>value.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*');if(!new RegExp(`^${source}${anchored?'$':''}`).test(path))continue;const next={allow:rule.allow,specificity:Buffer.byteLength(rule.pattern.replace(/[\*$]/g,''))};if(!winner||next.specificity>winner.specificity||next.specificity===winner.specificity&&next.allow)winner=next}return winner?.allow??true}
async function get(url:string,deps:YapDependencies,max=YAP_MAX_PAGE_BYTES){const transport=deps.fetch??((u:string,i:RequestInit)=>fetch(u,i)),timed=timedSignal(deps);let response:Response|undefined;try{response=await transport(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:timed.signal,headers:{accept:'text/html, text/plain;q=0.9, application/json;q=0.8'}});if(response.redirected||response.type==='opaqueredirect'||response.status>=300&&response.status<400||response.url&&response.url!==url)throw Error('invalid');return {response,bytes:await bounded(response,max,timed.signal)}}catch(error){if(response)discard(response);throw error}finally{timed.close()}}
export async function verifyYapPublication(receipt:YapReceipt,article:YapArticle,deps:YapDependencies={}):Promise<YapVerification>{
  let url:URL;try{url=new URL(receipt.publicUrl);if(url.protocol!=='https:'||!receipt.handle||url.hostname!==`${receipt.handle}.letyap.com`||url.pathname==='/')return {status:'invalid',reason:'url'}}catch{return {status:'invalid',reason:'url'}}
  try{const [page,robots]=await Promise.all([get(url.href,deps),get(`${url.origin}/robots.txt`,deps,64*1024)]);if(page.response.status!==200||page.response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='text/html')return {status:'invalid',reason:'response'};const html=new TextDecoder('utf-8',{fatal:true}).decode(page.bytes),$=load(html),directives=[$('meta[name="robots" i]').attr('content')??'',page.response.headers.get('x-robots-tag')??''].join(',').toLowerCase();if(/(?:^|[,\s])noindex(?:$|[,\s])/.test(directives))return {status:'invalid',reason:'indexing'};const canon=$('link[rel~="canonical" i]').toArray();if(canon.length!==1||new URL($(canon[0]).attr('href')??'',url.href).href!==url.href)return {status:'invalid',reason:'canonical'};if($('h1').first().text().trim()!==article.title)return {status:'invalid',reason:'content'};const inspected=inspectRenderedArticle(html,article.body,article.targetUrl,'.art-body',{title:article.title,pageUrl:url.href,robotsHeader:page.response.headers.get('x-robots-tag')??''});if(!inspected.found)return {status:'invalid',reason:inspected.reason==='target'?'link':'content'};const robotsText=new TextDecoder('utf-8',{fatal:true}).decode(robots.bytes);if(robots.response.status!==200||!['*','googlebot','bingbot'].every(agent=>robotsAllows(robotsText,url.pathname,agent)))return {status:'invalid',reason:'robots'};return {status:'usable',publicUrl:url.href,pageSha256:sha(page.bytes),rel:inspected.rel||'follow',robots:'allowed'}}catch{return {status:'unavailable',reason:'network'}}
}
function candidateUrls(value:unknown,origin:string){const result=new Set<string>();for(const item of strings(value)){try{const url=new URL(item,origin);if(url.origin===origin&&url.pathname!=='/'&&!url.search&&!url.hash)result.add(url.href)}catch{/* ignore */}}return [...result].slice(0,30)}
export async function reconcileYapPublication(intentValue:YapIntent,article:YapArticle,identity:YapIdentity,deps:YapDependencies={}):Promise<YapReconciliation>{
  if(intentValue.stage!=='publish'||!validIntent(intentValue)||intentValue.title!==article.title||intentValue.bodySha256!==article.bodySha256||!intentValue.handle||!validIdentity(identity))return {status:'unknown',checkedUrls:[]};const origin=yapPageOrigin(intentValue.handle),checked:string[]=[];try{const [home,stats]=await Promise.allSettled([get(`${origin}/`,deps),get(YAP_STATS_URL,{...deps,fetch:async(url,init)=>(deps.fetch??fetch)(url,{...init,headers:{...Object.fromEntries(new Headers(init.headers).entries()),authorization:`Bearer ${identity.apiKey}`,accept:'application/json'}})},YAP_MAX_RESPONSE_BYTES)]);const candidates=new Set<string>();if(home.status==='fulfilled'&&home.value.response.status===200){const html=new TextDecoder('utf-8',{fatal:true}).decode(home.value.bytes),$=load(html);for(const node of $('a[href]').toArray())for(const url of candidateUrls($(node).attr('href'),origin))candidates.add(url)}if(stats.status==='fulfilled'&&stats.value.response.status===200){try{for(const url of candidateUrls(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(stats.value.bytes)),origin))candidates.add(url)}catch{/* list remains usable */}}for(const url of [...candidates].slice(0,30)){checked.push(url);const receipt:YapReceipt={...intentValue,publicUrl:url},verification=await verifyYapPublication(receipt,article,deps);if(verification.status==='usable')return {status:'found',receipt,verification}}}catch{/* permanent publish latch stays closed */}return {status:'unknown',checkedUrls:checked};
}

export async function runYapAcceptance(input:{operationSeed:string;name:string;page:YapPage;article:YapArticle},persistence:YapPersistence,deps:YapDependencies={}):Promise<{identity:YapStepResult<YapIdentity>;page?:YapStepResult<YapPage>;publish?:YapStepResult<YapReceipt>;reconciliation?:YapReconciliation;verification?:YapVerification}>{
  const identityResult=await ensureYapIdentity({operationSeed:input.operationSeed,name:input.name},persistence,deps);if(identityResult.status!=='created')return {identity:identityResult};const pageResult=await ensureYapPage({operationSeed:input.operationSeed,identity:identityResult.value,page:input.page},persistence,deps);if(pageResult.status!=='created')return {identity:identityResult,page:pageResult};const prior=await persistence.loadIntent('publish');if(prior){const raw=await persistence.loadOpaqueResponse('publish');if(raw){const parsed=parseOpaque(raw,prior),url=typeof parsed==='string'||!prior.handle?undefined:publicUrl(parsed,prior.handle);if(url){const receipt={...prior,publicUrl:url};try{await persistence.promoteReceipt(receipt)}catch{/* read verification remains safe */}const verification=await verifyYapPublication(receipt,input.article,deps),reconciliation:YapReconciliation=verification.status==='usable'?{status:'found',receipt,verification}:{status:'published_unverified',receipt,verification};return {identity:identityResult,page:pageResult,reconciliation}}}return {identity:identityResult,page:pageResult,reconciliation:await reconcileYapPublication(prior,input.article,identityResult.value,deps)}}const publishResult=await publishYapOnce({operationSeed:input.operationSeed,identity:identityResult.value,page:pageResult.value,article:input.article},persistence,deps);if(publishResult.status!=='created')return {identity:identityResult,page:pageResult,publish:publishResult};return {identity:identityResult,page:pageResult,publish:publishResult,verification:await verifyYapPublication(publishResult.value,input.article,deps)};
}

export const yapTesting={HANDLE,OP,HASH,KEY,sha,validIntent,sameIntent,requestHash,operationId,intent,parseOpaque,apiKey,confirmsPage,publicUrl,robotsAllows,candidateUrls};
