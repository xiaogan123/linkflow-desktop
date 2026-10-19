import {createHash} from 'node:crypto';
import {z} from 'zod';

export const COLONY_ORIGIN='https://thecolony.ai';
export const COLONY_API=`${COLONY_ORIGIN}/api/v1`;
export const COLONY_COMMUNITY='build-in-public';
const clean=(maximum:number)=>z.string().min(1).max(maximum).refine(value=>value===value.trim()&&!/[\u0000-\u001f\u007f]/u.test(value));
const secret=clean(4096).refine(value=>!/[\s]/u.test(value));
const uuid=z.string().uuid();
const username=clean(32).min(3).regex(/^[a-z0-9_]+$/);
const timestamp=z.string().datetime({offset:true});
export const colonyHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');

export const colonyRegistrationSchema=z.object({
  username,
  display_name:clean(100),
  bio:clean(1000),
  registered_via:z.enum(['site-publisher','linkflow-desktop']),
}).strict();
export type ColonyRegistration=z.infer<typeof colonyRegistrationSchema>;

// Responses may add informational metadata. Validate the identity and credentials
// we actually use, rather than discarding a one-time key for a new warning field.
const pendingSchema=z.object({
  status:z.literal('pending').default('pending'),
  api_key:secret.min(16),
  claim_token:secret.max(120),
  id:uuid,
  username,
  expires_at:timestamp,
  key_persistence_required:z.literal(true).default(true),
});
export type ColonyPendingIdentity=z.infer<typeof pendingSchema>;
const activeSchema=z.object({status:z.literal('active').default('active'),id:uuid,username});
const tokenSchema=z.object({access_token:secret.min(16),token_type:z.literal('bearer').default('bearer')});

export function parseColonyPendingIdentity(value:unknown,expected:ColonyRegistration,now:Date):ColonyPendingIdentity|undefined {
  const parsed=pendingSchema.safeParse(value);
  if(!parsed.success||parsed.data.username!==expected.username)return;
  const remaining=Date.parse(parsed.data.expires_at)-now.getTime();
  if(!Number.isFinite(remaining)||remaining<=0||remaining>20*60*1000)return;
  return parsed.data;
}
export function parseColonyActiveIdentity(value:unknown,pending:ColonyPendingIdentity){
  const parsed=activeSchema.safeParse(value);
  return parsed.success&&parsed.data.id===pending.id&&parsed.data.username===pending.username?parsed.data:undefined;
}
export function parseColonyToken(value:unknown){
  const parsed=tokenSchema.safeParse(value);
  return parsed.success?parsed.data.access_token:undefined;
}

export interface ColonyIdentityPersistence {
  // The Store implementation atomically refuses a second begin or confirm intent.
  persistBeginIntent(input:ColonyRegistration):Promise<void>;
  persistBeginResponse(value:unknown):Promise<void>;
  persistPendingIdentity(value:ColonyPendingIdentity):Promise<void>;
  readPendingIdentity():Promise<ColonyPendingIdentity|undefined>;
  persistConfirmIntent(value:ColonyPendingIdentity):Promise<void>;
  persistConfirmResponse(value:unknown):Promise<void>;
  persistActiveIdentity(value:{id:string;username:string}):Promise<void>;
  assertMayRegister():true;
}
export interface ColonyIdentityTransport {
  begin(input:ColonyRegistration):Promise<unknown>;
  confirm(input:{claim_token:string;key_fingerprint:string}):Promise<unknown>;
}
export type ColonyRegistrationResult=
  | {status:'not_started'}
  | {status:'unknown';phase:'begin'|'confirm'}
  | {status:'pending';reason:'persistence_mismatch'|'expired'|'paused'}
  | {status:'active';id:string;username:string};

// This function performs at most the two documented registration calls. It has
// no retry, random-name fallback, email flow, or implicit token refresh.
export async function beginColonyIdentity(input:ColonyRegistration,persistence:ColonyIdentityPersistence,transport:ColonyIdentityTransport,now=()=>new Date()):Promise<ColonyRegistrationResult>{
  const parsed=colonyRegistrationSchema.safeParse(input);
  if(!parsed.success)return {status:'not_started'};
  try{await persistence.persistBeginIntent(parsed.data)}catch{return {status:'not_started'}}
  try{if(persistence.assertMayRegister()!==true)return {status:'not_started'}}catch{return {status:'not_started'}}
  let pending:ColonyPendingIdentity|undefined;
  try{
    const response=await transport.begin(parsed.data);
    // Production implementation must encrypt this before parsing the credentials.
    await persistence.persistBeginResponse(response);
    pending=parseColonyPendingIdentity(response,parsed.data,now());
    if(!pending)return {status:'unknown',phase:'begin'};
    await persistence.persistPendingIdentity(pending);
  }catch{return {status:'unknown',phase:'begin'}}
  return confirmColonyIdentity(pending,persistence,transport,now);
}

export async function confirmColonyIdentity(expected:ColonyPendingIdentity,persistence:ColonyIdentityPersistence,transport:ColonyIdentityTransport,now=()=>new Date()):Promise<ColonyRegistrationResult>{
  let saved:ColonyPendingIdentity|undefined;
  try{saved=await persistence.readPendingIdentity()}catch{return {status:'pending',reason:'persistence_mismatch'}}
  if(!saved||!pendingSchema.safeParse(saved).success||Object.keys(expected).some(key=>expected[key as keyof ColonyPendingIdentity]!==saved![key as keyof ColonyPendingIdentity]))return {status:'pending',reason:'persistence_mismatch'};
  if(Date.parse(saved.expires_at)<=now().getTime())return {status:'pending',reason:'expired'};
  try{await persistence.persistConfirmIntent(saved)}catch{return {status:'unknown',phase:'confirm'}}
  try{if(persistence.assertMayRegister()!==true)return {status:'pending',reason:'paused'}}catch{return {status:'pending',reason:'paused'}}
  try{
    const response=await transport.confirm({claim_token:saved.claim_token,key_fingerprint:saved.api_key.slice(-6)});
    await persistence.persistConfirmResponse(response);
    const active=parseColonyActiveIdentity(response,saved);
    if(!active)return {status:'unknown',phase:'confirm'};
    await persistence.persistActiveIdentity(active);
    return {status:'active',id:active.id,username:active.username};
  }catch{return {status:'unknown',phase:'confirm'}}
}

export const colonyPostSchema=z.object({
  colony:z.literal(COLONY_COMMUNITY),post_type:z.literal('analysis'),
  title:clean(300).min(3),body:z.string().min(1).max(50000),
  language:z.literal('en'),tags:z.array(clean(50)).max(10),
  client:z.enum(['site-publisher','linkflow-desktop']),bridge_to_nostr:z.literal(false),confirm_duplicate:z.literal(false),
}).strict();
export type ColonyPostInput=z.infer<typeof colonyPostSchema>;
const postSchema=z.object({
  id:uuid,author:z.object({id:uuid,username,user_type:z.literal('agent')}),
  colony_name:z.literal(COLONY_COMMUNITY),post_type:z.literal('analysis'),
  title:z.string(),body:z.string(),language:z.literal('en'),tags:z.array(z.string()).nullable(),
  status:z.string(),held:z.boolean().default(false),cognition:z.unknown().optional(),
});
export function colonyPostUrl(id:string){return `${COLONY_ORIGIN}/post/${uuid.parse(id)}`}
export function matchColonyPost(value:unknown,input:ColonyPostInput,identity:{id:string;username:string}):{id:string;publicUrl:string;state:'public_candidate'|'held'}|undefined{
  const parsed=postSchema.safeParse(value);
  if(!parsed.success)return;
  const post=parsed.data;
  if(post.author.id!==identity.id||post.author.username!==identity.username||post.title!==input.title||post.body!==input.body||post.tags?.length!==input.tags.length||input.tags.some(tag=>!post.tags?.includes(tag)))return;
  // Authenticated API visibility never proves anonymous publication. A held or
  // challenged post must wait on its original identity and cannot be reposted.
  return {id:post.id,publicUrl:colonyPostUrl(post.id),state:post.status==='open'&&!post.held&&post.cognition==null?'public_candidate':'held'};
}

export const COLONY_BEGIN_URL=`${COLONY_API}/auth/register/begin`;
export const COLONY_CONFIRM_URL=`${COLONY_API}/auth/register/confirm`;
export const COLONY_TOKEN_URL=`${COLONY_API}/auth/token`;
export const COLONY_ME_URL=`${COLONY_API}/users/me`;
export const COLONY_POSTS_URL=`${COLONY_API}/posts`;
export const COLONY_COMMUNITY_URL=`${COLONY_API}/colonies/by-name/${COLONY_COMMUNITY}`;
export const COLONY_INSTRUCTIONS_URL=`${COLONY_API}/instructions`;
export const COLONY_ROBOTS_URL=`${COLONY_ORIGIN}/robots.txt`;
export const COLONY_MAX_RESPONSE_BYTES=512*1024;
const SHA=/^[a-f0-9]{64}$/;
const pendingOperations=new Set<Promise<unknown>>();

export interface ColonyOpaqueResponse {version:1;capturedAt:string;requestUrl:string;status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;headers:Array<[string,string]>;bodyBase64:string;bodySha256:string;bodyComplete:boolean}
export interface ColonyAccountSecret {version:1;kind:'colony_account';operationId:string;requestHash:string;username:string;displayName:string;createdAt:string;apiKey?:string;claimToken?:string;pendingId?:string;expiresAt?:string;beginOpaque?:ColonyOpaqueResponse;confirmArmedAt?:string;confirmRequestHash?:string;confirmOpaque?:ColonyOpaqueResponse}
export interface ColonySessionSecret {version:1;kind:'colony_session';accountId:string;apiKeyFingerprint:string;accessToken:string;capturedAt:string;opaqueResponse:ColonyOpaqueResponse}
export interface ColonyPublicationSecret {version:1;kind:'colony_publication';operationId:string;idempotencyKey:string;requestHash:string;sourceHash:string;createdAt:string;body:string;armedAt?:string;opaqueResponse?:ColonyOpaqueResponse}
export interface ColonyNativeRequest {url:string;method:'GET';resourceType:'mainFrame'|'stylesheet'}
export interface ColonyRenderedPage {url:string;documentTitle:string;headings:Array<{text:string;visible:boolean}>;candidates:Array<{selector:string;html:string;text:string;allTextVisible:boolean;links:Array<{href:string;rel:string[];text:string;visible:boolean}>}>;robots:Array<{name:string;content:string}>;canonicals:string[];hasRefresh:boolean;hasPasswordGate:boolean;hasLoginGate:boolean;responseRobots:string[];responseLinks:string[];responseStatus:number;responseMediaType:string;responseBodyBytes:number;responseEncodedBodyBytes:number;nativeRequests:ColonyNativeRequest[]}
export interface ColonyRenderHooks {onBeforeRequest?:(request:ColonyNativeRequest)=>void;onResponseHeaders?:(headers:Record<string,string[]>)=>void|Promise<void>;onScreenshot?:(png:Uint8Array)=>void|Promise<void>}
export interface ColonyMutationIdentity {kind:'registration_begin'|'registration_confirm'|'token'|'publication';operationId:string;requestHash:string;accountId:string;sourceHash?:string;idempotencyKey?:string}
export interface ColonyDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;renderPage?:(url:string,signal:AbortSignal,hooks?:ColonyRenderHooks)=>Promise<ColonyRenderedPage>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}
export interface ColonyMe {id:string;username:string;displayName:string;userType:'agent';createdAt:string}

export function colonyPublicUrl(id:string){return `${COLONY_ORIGIN}/post/${uuid.parse(id)}`}
export function colonyPostApiUrl(id:string){return `${COLONY_POSTS_URL}/${uuid.parse(id)}`}
export function colonyPostSearchUrl(authorId:string,title:string){const url=new URL(COLONY_POSTS_URL);url.searchParams.set('author_id',uuid.parse(authorId));url.searchParams.set('colony',COLONY_COMMUNITY);url.searchParams.set('q',title.slice(0,200));url.searchParams.set('sort','newest');url.searchParams.set('limit','100');return url.href}
export function trackColonyPending<T>(promise:Promise<T>):Promise<T>{let tracked:Promise<T>;tracked=Promise.resolve(promise).then(value=>{pendingOperations.delete(tracked);return value},error=>{pendingOperations.delete(tracked);throw error});pendingOperations.add(tracked);return tracked}
export async function drainColonyPendingOperations(){while(pendingOperations.size)await Promise.allSettled([...pendingOperations])}
export function colonyPendingOperationCount(){return pendingOperations.size}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
function dateValue(value:unknown):value is string{return typeof value==='string'&&Number.isFinite(Date.parse(value))}
function safeText(value:unknown,min:number,max:number):value is string{return typeof value==='string'&&value.length>=min&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)}
export function parseColonyMe(value:unknown):ColonyMe|undefined{if(!record(value)||!uuid.safeParse(value.id).success||!username.safeParse(value.username).success||!safeText(value.display_name,1,100)||value.user_type!=='agent'||!dateValue(value.created_at))return;return {id:value.id as string,username:value.username as string,displayName:value.display_name,userType:'agent',createdAt:new Date(value.created_at).toISOString()}}
export function colonyRegistrationRequest(identity?:{username:string;displayName:string}){const input:ColonyRegistration={username:identity?.username??'site_agent',display_name:identity?.displayName??'Site publishing assistant',bio:'AI-assisted contributor for the site operator.',registered_via:'site-publisher'};const body=JSON.stringify(input);return {input,body,requestHash:colonyHash(`POST\n${COLONY_BEGIN_URL}\ncontent-type:application/json\n\n${body}`)}}
export function colonyConfirmRequest(pending:ColonyPendingIdentity){const body=JSON.stringify({claim_token:pending.claim_token,key_fingerprint:pending.api_key.slice(-6)});return {body,requestHash:colonyHash(`POST\n${COLONY_CONFIRM_URL}\ncontent-type:application/json\n\n${body}`)}}
export function colonyTokenRequest(apiKey:string){const body=JSON.stringify({api_key:apiKey});return {body,requestHash:colonyHash(`POST\n${COLONY_TOKEN_URL}\ncontent-type:application/json\n\n${body}`)}}
export function colonyPostRequest(input:ColonyPostInput,idempotencyKey:string){const body=JSON.stringify(colonyPostSchema.parse(input));return {body,sourceHash:colonyHash(input.body),requestHash:colonyHash(`POST\n${COLONY_POSTS_URL}\nidempotency-key:${idempotencyKey}\ncontent-type:application/json\n\n${body}`)}}
class PartialBody extends Error{constructor(readonly bytes:Uint8Array,readonly limit=false){super(limit?'body_limit':'transport')}}
async function bounded(response:Response,signal:AbortSignal){const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>COLONY_MAX_RESPONSE_BYTES))throw new PartialBody(new Uint8Array(),true);if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Buffer[]=[];let size=0;try{for(;;){const next=await reader.read();if(signal.aborted)throw new PartialBody(Buffer.concat(parts));if(next.done)break;const chunk=Buffer.from(next.value);if(size+chunk.length>COLONY_MAX_RESPONSE_BYTES)throw new PartialBody(Buffer.concat(parts),true);parts.push(chunk);size+=chunk.length}return Buffer.concat(parts)}catch(error){if(error instanceof PartialBody)throw error;throw new PartialBody(Buffer.concat(parts))}finally{try{reader.releaseLock()}catch{}}}
function opaque(response:Response,bytes:Uint8Array,url:string,now:()=>Date,complete=true):ColonyOpaqueResponse{return {version:1,capturedAt:now().toISOString(),requestUrl:url,status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,headers:[...response.headers.entries()].map(([k,v])=>[k.toLowerCase(),v] as [string,string]).sort(),bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:colonyHash(bytes),bodyComplete:complete}}
function validOpaque(value:unknown):value is ColonyOpaqueResponse{if(!record(value)||value.version!==1||!dateValue(value.capturedAt)||typeof value.requestUrl!=='string'||!Number.isSafeInteger(value.status)||typeof value.contentType!=='string'||typeof value.responseUrl!=='string'||typeof value.redirected!=='boolean'||typeof value.responseType!=='string'||!Array.isArray(value.headers)||value.headers.length>128||value.headers.some(item=>!Array.isArray(item)||item.length!==2||typeof item[0]!=='string'||typeof item[1]!=='string')||typeof value.bodyBase64!=='string'||typeof value.bodySha256!=='string'||!SHA.test(value.bodySha256)||typeof value.bodyComplete!=='boolean')return false;try{const bytes=Buffer.from(value.bodyBase64,'base64');return bytes.length<=COLONY_MAX_RESPONSE_BYTES&&bytes.toString('base64')===value.bodyBase64&&colonyHash(bytes)===value.bodySha256}catch{return false}}
export function parseColonyOpaque(value:ColonyOpaqueResponse,expectedUrl:string,statuses:number[]):unknown|undefined{if(value.requestUrl!==expectedUrl||!statuses.includes(value.status)||!value.bodyComplete||value.redirected||value.responseType==='opaqueredirect'||value.responseUrl&&value.responseUrl!==expectedUrl||value.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return;const bytes=Buffer.from(value.bodyBase64,'base64');if(colonyHash(bytes)!==value.bodySha256)return;try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{return}}
export function validColonyAccountSecret(value:unknown):value is ColonyAccountSecret{return record(value)&&value.version===1&&value.kind==='colony_account'&&typeof value.operationId==='string'&&/^colony_register_[a-f0-9]{32}$/.test(value.operationId)&&typeof value.requestHash==='string'&&SHA.test(value.requestHash)&&username.safeParse(value.username).success&&safeText(value.displayName,1,100)&&dateValue(value.createdAt)&&(value.apiKey===undefined||secret.safeParse(value.apiKey).success)&&(value.claimToken===undefined||secret.max(120).safeParse(value.claimToken).success)&&(value.pendingId===undefined||uuid.safeParse(value.pendingId).success)&&(value.expiresAt===undefined||dateValue(value.expiresAt))&&(value.beginOpaque===undefined||validOpaque(value.beginOpaque))&&(value.confirmArmedAt===undefined||dateValue(value.confirmArmedAt))&&(value.confirmRequestHash===undefined||typeof value.confirmRequestHash==='string'&&SHA.test(value.confirmRequestHash))&&(value.confirmOpaque===undefined||validOpaque(value.confirmOpaque))&&((value.confirmArmedAt===undefined&&value.confirmRequestHash===undefined)||(value.confirmArmedAt!==undefined&&value.confirmRequestHash!==undefined))}
export function validColonySessionSecret(value:unknown):value is ColonySessionSecret{return record(value)&&value.version===1&&value.kind==='colony_session'&&uuid.safeParse(value.accountId).success&&typeof value.apiKeyFingerprint==='string'&&SHA.test(value.apiKeyFingerprint)&&secret.safeParse(value.accessToken).success&&dateValue(value.capturedAt)&&validOpaque(value.opaqueResponse)}
export function validColonyPublicationSecret(value:unknown):value is ColonyPublicationSecret{return record(value)&&value.version===1&&value.kind==='colony_publication'&&typeof value.operationId==='string'&&/^colony_post_[a-f0-9]{32}$/.test(value.operationId)&&value.idempotencyKey===value.operationId&&typeof value.requestHash==='string'&&SHA.test(value.requestHash)&&typeof value.sourceHash==='string'&&SHA.test(value.sourceHash)&&dateValue(value.createdAt)&&typeof value.body==='string'&&value.body.length<=50000&&(value.armedAt===undefined||dateValue(value.armedAt))&&(value.opaqueResponse===undefined||validOpaque(value.opaqueResponse))}
export async function readColonyJson(url:string,token:string|undefined,deps:ColonyDependencies={}):Promise<unknown>{const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(100,deps.timeoutMs??25_000)));timer.unref?.();deps.signal?.addEventListener('abort',abort,{once:true});try{const headers:Record<string,string>={accept:'application/json'};if(token)headers.authorization=`Bearer ${token}`;const response=await (deps.fetch??((u:string,i:RequestInit)=>fetch(u,i)))(url,{method:'GET',headers,signal:controller.signal,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});if(response.status!==200||response.redirected||response.url&&response.url!==url||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')throw Error('invalid readback');const bytes=await bounded(response,controller.signal);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort)}}
export async function assertColonyCommunity(deps:ColonyDependencies={}):Promise<void>{const value=await readColonyJson(COLONY_COMMUNITY_URL,undefined,deps);if(!record(value)||value.name!==COLONY_COMMUNITY||value.community_type!=='public'||value.is_sandbox!==false||value.crowd_control_level!=='off')throw Error('Colony selected community contract changed')}
export async function colonyMutation(url:string,init:RequestInit,persist:(value:ColonyOpaqueResponse)=>Promise<void>,authorize:()=>true,deps:ColonyDependencies={}):Promise<ColonyOpaqueResponse|undefined>{const now=deps.now??(()=>new Date()),controller=new AbortController(),timeout=Math.min(60_000,Math.max(100,deps.timeoutMs??25_000)),abort=()=>controller.abort();deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)controller.abort();const timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.();let response:Response|undefined;const preserve=async(value:Response)=>{try{const late=new AbortController(),lateTimer=setTimeout(()=>late.abort(),timeout);lateTimer.unref?.();try{const bytes=await bounded(value,late.signal);await persist(opaque(value,bytes,url,now))}catch(error){if(error instanceof PartialBody)await persist(opaque(value,error.bytes,url,now,false)).catch(()=>undefined)}finally{clearTimeout(lateTimer)}}catch{}};try{if(url===COLONY_POSTS_URL)await assertColonyCommunity({...deps,signal:controller.signal});const transport=deps.fetch??((u:string,i:RequestInit)=>fetch(u,i));if(authorize()!==true)throw Error('Colony mutation authorization changed');const request=Promise.resolve(transport(url,{...init,signal:controller.signal,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'}));response=await Promise.race([trackColonyPending(request),new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('abort')),{once:true}))]).catch(error=>{void trackColonyPending(request.then(value=>preserve(value))).catch(()=>undefined);throw error});const bytes=await bounded(response,controller.signal);const result=opaque(response,bytes,url,now);await persist(result);return result}catch(error){controller.abort();if(response&&error instanceof PartialBody){const result=opaque(response,error.bytes,url,now,false);await persist(result).catch(()=>undefined);return result}return undefined}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort)}}
