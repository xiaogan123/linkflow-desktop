import {createHash} from 'node:crypto';
import {marked} from 'marked';

export const AGENTNOTEPAD_ORIGIN='https://agentnotepad.com';
export const AGENTNOTEPAD_API=`${AGENTNOTEPAD_ORIGIN}/api/v1`;
export const AGENTNOTEPAD_AGENTS_URL=`${AGENTNOTEPAD_API}/agents`;
export const AGENTNOTEPAD_PUBLISH_URL=`${AGENTNOTEPAD_API}/commands/publish`;
export const AGENTNOTEPAD_ROBOTS_URL=`${AGENTNOTEPAD_ORIGIN}/robots.txt`;
export const AGENTNOTEPAD_MAX_RESPONSE_BYTES=1024*1024;
export const AGENTNOTEPAD_IDEMPOTENCY_KEY=/^[A-Za-z0-9_-]{8,128}$/;
export const AGENTNOTEPAD_REMOTE_ID=/^[A-Za-z0-9_-]{8,200}$/;
export const AGENTNOTEPAD_SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA=/^[a-f0-9]{64}$/;
const pending=new Set<Promise<unknown>>();

export interface AgentNotepadCitation {url:string;title:string;quote?:string}
export interface AgentNotepadAgent {id:string;name:string;slug:string}
export interface AgentNotepadOpaqueResponse {version:1;capturedAt:string;requestUrl:string;status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;headers:Array<[string,string]>;bodyBase64:string;bodySha256:string;bodyComplete:boolean}
export interface AgentNotepadRegistrationIntent {version:1;kind:'agentnotepad_registration';operationId:string;requestHash:string;createdAt:string;capabilities:['research'];topics:['engineering'];opaqueResponse?:AgentNotepadOpaqueResponse;apiKey?:string;agent?:AgentNotepadAgent}
export interface AgentNotepadPublicationIntent {version:1;kind:'agentnotepad_publication';operationId:string;idempotencyKey:string;accountId:string;agentId:string;requestHash:string;sourceHash:string;citationsHash:string;createdAt:string;opaqueResponse?:AgentNotepadOpaqueResponse}
export interface AgentNotepadPublishReceipt {id:string;revisionId:string;slug:string;status:'published'}
export interface AgentNotepadResource {id:string;kind:'note';title:string;body:string;topic:string;authorId:string;revisionId:string;canonicalUrl:string;revisionUrl:string;citations:AgentNotepadCitation[]}
export interface AgentNotepadNativeRequest {url:string;method:'GET';resourceType:'mainFrame'|'stylesheet'}
export interface AgentNotepadRenderedPage {url:string;documentTitle:string;heading:string;articleText:string;articleHtml:string;allTextVisible:boolean;citationSources?:Array<{id:string;href:string;text:string;rel:string[];visible:boolean;backlinks:string[]}>;links:Array<{href:string;rel:string[];text:string;visible:boolean}>;robots:Array<{name:string;content:string}>;responseRobots:string[];responseLinks:string[];canonicals:string[];hasRefresh:boolean;hasPasswordGate:boolean;hasLoginGate:boolean;responseStatus:number;responseMediaType:string;responseBodyBytes:number;responseEncodedBodyBytes:number;nativeRequests:AgentNotepadNativeRequest[]}
export interface AgentNotepadRenderHooks {onBeforeRequest?:(request:AgentNotepadNativeRequest)=>void;onResponseHeaders?:(headers:Record<string,string[]>)=>void;onScreenshot?:(png:Uint8Array)=>void}
export interface AgentNotepadDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date;citations?:AgentNotepadCitation[];renderPage?:(url:string,signal:AbortSignal,hooks?:AgentNotepadRenderHooks)=>Promise<AgentNotepadRenderedPage>}
export interface AgentNotepadPublicationPersistence {
  persistIntent(intent:AgentNotepadPublicationIntent):Promise<void>;
  assertReadyToSubmit(intent:AgentNotepadPublicationIntent):true;
  persistOpaqueResponse(response:AgentNotepadOpaqueResponse):Promise<void>;
  loadIntent():Promise<AgentNotepadPublicationIntent|undefined>;
  promoteResource(resource:AgentNotepadResource):Promise<void>;
}

export const agentNotepadHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const agentNotepadAgentUrl=(slug:string)=>`${AGENTNOTEPAD_AGENTS_URL}/${encodeURIComponent(slug)}`;
export const agentNotepadResourceUrl=(id:string)=>`${AGENTNOTEPAD_API}/resources/${encodeURIComponent(id)}`;
export const agentNotepadHistoryUrl=(id:string)=>`${agentNotepadResourceUrl(id)}/history`;
export const agentNotepadResourceListUrl=(authorId:string)=>`${AGENTNOTEPAD_API}/resources?kind=note&authorId=${encodeURIComponent(authorId)}&limit=50`;
export function trackAgentNotepadPending<T>(promise:Promise<T>):Promise<T>{let tracked:Promise<T>;tracked=Promise.resolve(promise).then(value=>{pending.delete(tracked);return value},error=>{pending.delete(tracked);throw error});pending.add(tracked);return tracked}
export async function drainAgentNotepadPendingOperations(timeoutMs=30_000){const deadline=Date.now()+timeoutMs;while(pending.size){const left=deadline-Date.now();if(left<=0)return false;await Promise.race([Promise.allSettled([...pending]),new Promise(resolve=>setTimeout(resolve,Math.min(left,50)))])}return true}
export function agentNotepadPendingOperationCount(){return pending.size}

function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
function clean(value:unknown,min:number,max:number):value is string{return typeof value==='string'&&value.length>=min&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)}
function exactDate(value:unknown):value is string{return typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value}
function data(value:unknown):Record<string,unknown>|undefined{return object(value)&&object(value.data)?value.data:undefined}
function exactCitation(value:unknown):value is AgentNotepadCitation{return object(value)&&Object.keys(value).every(key=>['url','title','quote'].includes(key))&&clean(value.url,1,2048)&&(()=>{try{const url=new URL(value.url);return url.protocol==='https:'||url.protocol==='http:'}catch{return false}})()&&clean(value.title,1,200)&&(value.quote===undefined||clean(value.quote,0,4000))}
export function validAgentNotepadCitations(value:unknown):value is AgentNotepadCitation[]{return Array.isArray(value)&&value.length<=30&&value.every(exactCitation)}
export function sameAgentNotepadCitations(left:AgentNotepadCitation[],right:AgentNotepadCitation[]):boolean{return left.length===right.length&&left.every((value,index)=>value.url===right[index].url&&value.title===right[index].title&&value.quote===right[index].quote)}
export function reviewedAgentNotepadCitations(_title:string,body:string,override?:AgentNotepadCitation[]){
  // Source titles and URLs come from the same draft that the existing AI review
  // approves. Never bake an acceptance article or operator identity into the app.
  const sources:AgentNotepadCitation[]=[];
  marked.walkTokens(marked.lexer(body,{gfm:true}),token=>{
    if(token.type!=='link'||sources.some(value=>value.url===token.href))return;
    const title=token.text.replace(/\s+/g,' ').trim();
    sources.push({url:token.href,title:title||token.href});
  });
  const selected=override??sources;
  return validAgentNotepadCitations(selected)?structuredClone(selected):undefined;
}

export function parseAgentNotepadRegistration(value:unknown):{agent:AgentNotepadAgent;apiKey:string}|undefined{const root=data(value);if(!root)return;const id=root.agentId??root.id;if(root.agentId!==undefined&&root.id!==undefined&&root.agentId!==root.id)return;if(!clean(id,8,200)||!clean(root.name,1,200)||!clean(root.slug,2,80)||!AGENTNOTEPAD_SLUG.test(root.slug)||!clean(root.apiKey,16,8192)||/[\s]/.test(root.apiKey))return;return {agent:{id,name:root.name,slug:root.slug},apiKey:root.apiKey}}
export function parseAgentNotepadAgent(value:unknown):AgentNotepadAgent|undefined{const root=data(value);if(!root||!clean(root.id,8,200)||!clean(root.name,1,200)||!clean(root.slug,2,80)||!AGENTNOTEPAD_SLUG.test(root.slug))return;return {id:root.id,name:root.name,slug:root.slug}}
export function parseAgentNotepadResource(value:unknown):AgentNotepadResource|undefined{
  const root=data(value);if(!root||!clean(root.id,8,200)||root.kind!=='note'||!clean(root.title,1,200)||!clean(root.topic,0,80)||!clean(root.slug,2,80)||!AGENTNOTEPAD_SLUG.test(root.slug)||!clean(root.revisionId,8,200)||!clean(root.canonicalUrl,1,2048)||!clean(root.revisionUrl,1,2048))return;
  let authorId:unknown=root.authorId,body:unknown=root.body,citations:unknown=root.citations;
  if(root.revision!==undefined){
    if(!object(root.author)||!clean(root.author.id,8,200)||!object(root.revision)||!clean(root.revision.id,8,200)||!object(root.revision.author)||!clean(root.revision.author.id,8,200)||root.revision.status!=='published'||root.revision.id!==root.revisionId||root.author.id!==root.revision.author.id)return;
    authorId=root.author.id;body=root.revision.body;citations=root.revision.citations;
    if(root.authorId!==undefined&&root.authorId!==authorId||root.body!==undefined&&root.body!==body||root.citations!==undefined&&(!validAgentNotepadCitations(root.citations)||!validAgentNotepadCitations(citations)||!sameAgentNotepadCitations(root.citations,citations))||root.status!==undefined&&root.status!=='published')return;
  }
  if(!clean(authorId,8,200)||typeof body!=='string'||body.length<1||body.length>100_000||!validAgentNotepadCitations(citations))return;
  try{const canonical=new URL(root.canonicalUrl),revision=new URL(root.revisionUrl),expectedPath=`/notebooks/${root.slug}`;if(canonical.origin!==AGENTNOTEPAD_ORIGIN||revision.origin!==AGENTNOTEPAD_ORIGIN||canonical.protocol!=='https:'||revision.protocol!=='https:'||canonical.username||canonical.password||canonical.port||canonical.hash||canonical.search||revision.username||revision.password||revision.port||revision.hash||canonical.pathname!==expectedPath||revision.pathname!==expectedPath||revision.searchParams.size!==1||revision.searchParams.get('revision')!==root.revisionId)return}catch{return}
  return {id:root.id,kind:'note',title:root.title,body,topic:root.topic,authorId,revisionId:root.revisionId,canonicalUrl:root.canonicalUrl,revisionUrl:root.revisionUrl,citations:structuredClone(citations)};
}
export function parseAgentNotepadPublishReceipt(value:unknown):AgentNotepadPublishReceipt|undefined{
  const root=data(value);if(!root||Object.keys(root).sort().join(',')!=='id,revisionId,slug,status'||!clean(root.id,8,200)||!AGENTNOTEPAD_REMOTE_ID.test(root.id)||!clean(root.revisionId,8,200)||!AGENTNOTEPAD_REMOTE_ID.test(root.revisionId)||!clean(root.slug,2,80)||!AGENTNOTEPAD_SLUG.test(root.slug)||root.status!=='published')return;
  return {id:root.id,revisionId:root.revisionId,slug:root.slug,status:'published'};
}
export function parseAgentNotepadReceiptBoundResource(value:unknown,receipt:AgentNotepadPublishReceipt):AgentNotepadResource|undefined{
  const root=data(value),resource=parseAgentNotepadResource(value);if(!root||!resource||root.slug!==receipt.slug||resource.id!==receipt.id||resource.revisionId!==receipt.revisionId)return;return resource;
}
export function parseAgentNotepadResourceList(value:unknown):AgentNotepadResource[]{const root=data(value);if(!root||!Array.isArray(root.items))return [];const out:AgentNotepadResource[]=[];for(const item of root.items){const parsed=parseAgentNotepadResource({data:item});if(parsed)out.push(parsed)}return out}
export function parseAgentNotepadHistoryHasRevision(value:unknown,resource:AgentNotepadResource):boolean{const root=data(value);if(!root||!Array.isArray(root.items))return false;return root.items.some(item=>object(item)&&(item.id===resource.revisionId||item.revisionId===resource.revisionId))}
export function agentNotepadRegistrationRequest(){const value={capabilities:['research'] as ['research'],topics:['engineering'] as ['engineering']};const body=JSON.stringify(value);return {value,body,requestHash:agentNotepadHash(`POST\n${AGENTNOTEPAD_AGENTS_URL}\ncontent-type:application/json\n\n${body}`)}}
export function agentNotepadPublishRequest(title:string,bodyText:string,citations:AgentNotepadCitation[],idempotencyKey:string){const value={kind:'note' as const,title,body:bodyText,topic:'engineering',citations};const body=JSON.stringify(value);return {value,body,sourceHash:agentNotepadHash(bodyText),citationsHash:agentNotepadHash(JSON.stringify(citations)),requestHash:agentNotepadHash(`POST\n${AGENTNOTEPAD_PUBLISH_URL}\nauthorization:bearer <secret>\nidempotency-key:${idempotencyKey}\ncontent-type:application/json\n\n${body}`)}}

class PartialBody extends Error{constructor(readonly bytes:Uint8Array,readonly limit=false){super(limit?'body_limit':'transport')}}
async function bounded(response:Response,signal:AbortSignal){const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>AGENTNOTEPAD_MAX_RESPONSE_BYTES))throw new PartialBody(new Uint8Array(),true);if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Buffer[]=[];let size=0;const cancel=()=>{void reader.cancel().catch(()=>undefined)};signal.addEventListener('abort',cancel,{once:true});try{for(;;){if(signal.aborted)throw new PartialBody(Buffer.concat(parts));const next=await reader.read();if(signal.aborted)throw new PartialBody(Buffer.concat(parts));if(next.done)break;const chunk=Buffer.from(next.value);if(size+chunk.length>AGENTNOTEPAD_MAX_RESPONSE_BYTES)throw new PartialBody(Buffer.concat(parts),true);parts.push(chunk);size+=chunk.length}return Buffer.concat(parts)}catch(error){if(error instanceof PartialBody)throw error;throw new PartialBody(Buffer.concat(parts))}finally{signal.removeEventListener('abort',cancel);try{reader.releaseLock()}catch{}}}
function opaque(response:Response,bytes:Uint8Array,url:string,now:()=>Date,complete=true):AgentNotepadOpaqueResponse{return {version:1,capturedAt:now().toISOString(),requestUrl:url,status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,headers:[...response.headers.entries()].map(([key,value])=>[key.toLowerCase(),value] as [string,string]).sort(),bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:agentNotepadHash(bytes),bodyComplete:complete}}
export function validAgentNotepadOpaque(value:unknown):value is AgentNotepadOpaqueResponse{if(!object(value)||value.version!==1||!exactDate(value.capturedAt)||typeof value.requestUrl!=='string'||!Number.isSafeInteger(value.status)||typeof value.contentType!=='string'||typeof value.responseUrl!=='string'||typeof value.redirected!=='boolean'||typeof value.responseType!=='string'||!Array.isArray(value.headers)||value.headers.length>128||value.headers.some(item=>!Array.isArray(item)||item.length!==2||typeof item[0]!=='string'||typeof item[1]!=='string')||typeof value.bodyBase64!=='string'||typeof value.bodySha256!=='string'||!SHA.test(value.bodySha256)||typeof value.bodyComplete!=='boolean')return false;try{const bytes=Buffer.from(value.bodyBase64,'base64');return bytes.length<=AGENTNOTEPAD_MAX_RESPONSE_BYTES&&bytes.toString('base64')===value.bodyBase64&&agentNotepadHash(bytes)===value.bodySha256}catch{return false}}
export function parseAgentNotepadOpaque(value:AgentNotepadOpaqueResponse,expectedUrl:string,expectedStatus:number):unknown|undefined{if(!validAgentNotepadOpaque(value)||value.requestUrl!==expectedUrl||value.status!==expectedStatus||!value.bodyComplete||value.redirected||value.responseType==='opaqueredirect'||value.responseUrl&&value.responseUrl!==expectedUrl||value.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return;try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(value.bodyBase64,'base64')))}catch{return}}
export async function agentNotepadMutation(url:string,init:RequestInit,persist:(value:AgentNotepadOpaqueResponse)=>Promise<void>,assertReady:()=>true,deps:AgentNotepadDependencies={}):Promise<AgentNotepadOpaqueResponse|undefined>{
  const now=deps.now??(()=>new Date()),controller=new AbortController(),timeout=Math.min(60_000,Math.max(100,deps.timeoutMs??25_000)),abort=()=>controller.abort();deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)controller.abort();const timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.();let response:Response|undefined;
  const preserve=async(value:Response)=>{try{const late=new AbortController(),lateTimer=setTimeout(()=>late.abort(),timeout);lateTimer.unref?.();try{const bytes=await bounded(value,late.signal);await persist(opaque(value,bytes,url,now))}catch(error){if(error instanceof PartialBody)await persist(opaque(value,error.bytes,url,now,false)).catch(()=>undefined)}finally{clearTimeout(lateTimer)}}catch{}};
  try{if(assertReady()!==true)throw Error('authorization changed');const transport=deps.fetch??((requestUrl:string,requestInit:RequestInit)=>fetch(requestUrl,requestInit));const request=Promise.resolve(transport(url,{...init,signal:controller.signal,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'}));response=await Promise.race([trackAgentNotepadPending(request),new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('abort')),{once:true}))]).catch(error=>{void trackAgentNotepadPending(request.then(value=>preserve(value))).catch(()=>undefined);throw error});const bytes=await bounded(response,controller.signal),result=opaque(response,bytes,url,now);await persist(result);return result}catch(error){controller.abort();if(response&&error instanceof PartialBody){const result=opaque(response,error.bytes,url,now,false);await persist(result).catch(()=>undefined);return result}return undefined}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort)}
}
export function validAgentNotepadRegistrationIntent(value:unknown):value is AgentNotepadRegistrationIntent{return object(value)&&value.version===1&&value.kind==='agentnotepad_registration'&&typeof value.operationId==='string'&&/^agentnotepad_register_[a-f0-9]{32}$/.test(value.operationId)&&typeof value.requestHash==='string'&&SHA.test(value.requestHash)&&exactDate(value.createdAt)&&JSON.stringify(value.capabilities)===JSON.stringify(['research'])&&JSON.stringify(value.topics)===JSON.stringify(['engineering'])&&(value.opaqueResponse===undefined||validAgentNotepadOpaque(value.opaqueResponse))&&(value.apiKey===undefined||clean(value.apiKey,16,8192)&&!/[\s]/.test(value.apiKey))&&(value.agent===undefined||!!parseAgentNotepadAgent({data:value.agent}))}
export function validAgentNotepadPublicationIntent(value:unknown):value is AgentNotepadPublicationIntent{return object(value)&&value.version===1&&value.kind==='agentnotepad_publication'&&typeof value.operationId==='string'&&/^agentnotepad_publish_[a-f0-9]{32}$/.test(value.operationId)&&typeof value.idempotencyKey==='string'&&AGENTNOTEPAD_IDEMPOTENCY_KEY.test(value.idempotencyKey)&&typeof value.accountId==='string'&&typeof value.agentId==='string'&&typeof value.requestHash==='string'&&SHA.test(value.requestHash)&&typeof value.sourceHash==='string'&&SHA.test(value.sourceHash)&&typeof value.citationsHash==='string'&&SHA.test(value.citationsHash)&&exactDate(value.createdAt)&&(value.opaqueResponse===undefined||validAgentNotepadOpaque(value.opaqueResponse))}
export async function readAgentNotepadJson(url:string,deps:AgentNotepadDependencies={},token?:string):Promise<unknown>{const parsed=new URL(url);if(parsed.origin!==AGENTNOTEPAD_ORIGIN||!parsed.pathname.startsWith('/api/v1/')||parsed.username||parsed.password||parsed.port||parsed.hash)throw Error('Agent Notepad 只读路由无效');const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(100,deps.timeoutMs??25_000)));timer.unref?.();deps.signal?.addEventListener('abort',abort,{once:true});try{const headers:Record<string,string>={accept:'application/json'};if(token)headers.authorization=`Bearer ${token}`;const response=await (deps.fetch??((requestUrl:string,init:RequestInit)=>fetch(requestUrl,init)))(url,{method:'GET',headers,signal:controller.signal,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});if(response.status!==200||response.redirected||response.url&&response.url!==url||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')throw Error('Agent Notepad 只读响应无效');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bounded(response,controller.signal)))}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort)}}

export async function readAgentNotepadRobots(deps:AgentNotepadDependencies={}):Promise<string>{
 const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,Math.min(60_000,Math.max(100,deps.timeoutMs??25_000)));timer.unref?.();deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)abort();
 try{const response=await(deps.fetch??fetch)(AGENTNOTEPAD_ROBOTS_URL,{method:'GET',headers:{accept:'text/plain'},signal:controller.signal,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});if(response.status!==200||response.redirected||response.url&&response.url!==AGENTNOTEPAD_ROBOTS_URL)throw Error('Agent Notepad 抓取规则响应无效');return new TextDecoder('utf-8',{fatal:true}).decode(await bounded(response,controller.signal))}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort)}
}
