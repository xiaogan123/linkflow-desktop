import {createHash} from 'node:crypto';

export const OPENAGENTCHAT_ORIGIN='https://openagentchat.net';
export const OPENAGENTCHAT_API=`${OPENAGENTCHAT_ORIGIN}/api/v1`;
export const OPENAGENTCHAT_AGENTS_URL=`${OPENAGENTCHAT_API}/agents`;
export const OPENAGENTCHAT_ME_URL=`${OPENAGENTCHAT_API}/me`;
export const OPENAGENTCHAT_PAGES_URL=`${OPENAGENTCHAT_API}/pages`;
export const OPENAGENTCHAT_MAX_RESPONSE_BYTES=512*1024;
export const OPENAGENTCHAT_AGENT_NAME=/^[a-z][a-z0-9_-]{2,31}$/;
export const OPENAGENTCHAT_IDEMPOTENCY_KEY=/^[A-Za-z0-9_-]{8,100}$/;
const SHA=/^[a-f0-9]{64}$/;
const pending=new Set<Promise<unknown>>();

export interface OpenAgentChatAgent {id:number;name:string;displayName:string;kind:'agent';bio:string}
export interface OpenAgentChatOpaqueResponse {version:1;capturedAt:string;requestUrl:string;status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;headers:Array<[string,string]>;bodyBase64:string;bodySha256:string;bodyComplete:boolean}
export interface OpenAgentChatAccountSecret {version:1;kind:'openagentchat_account';operationId:string;requestHash:string;name:string;createdAt:string;token?:string;opaqueResponse?:OpenAgentChatOpaqueResponse}
export interface OpenAgentChatPageSecret {version:1;kind:'openagentchat_page';operationId:string;idempotencyKey:string;requestHash:string;sourceHash:string;createdAt:string;opaqueResponse?:OpenAgentChatOpaqueResponse}
export interface OpenAgentChatPage {id:number;slug:string;title:string;body:string;kind:'note';category:'engineering';revision:number;createdAt:string;updatedAt:string;updatedAtRaw:string;author:string;url:string;hasSafetyFlags:false;contentMode:'safe'}
export interface OpenAgentChatNativeRequest {url:string;method:'GET';resourceType:'mainFrame'|'stylesheet'}
export interface OpenAgentChatRenderedPage {url:string;documentTitle:string;headings:Array<{text:string;visible:boolean}>;candidates:Array<{selector:string;html:string;text:string;allTextVisible:boolean;links:Array<{href:string;rel:string[];text:string;visible:boolean}>}>;robots:Array<{name:string;content:string}>;canonicals:string[];hasRefresh:boolean;hasPasswordGate:boolean;hasLoginGate:boolean;responseRobots:string[];responseLinks:string[];responseStatus:number;responseMediaType:string;responseBodyBytes:number;responseEncodedBodyBytes:number;nativeRequests:OpenAgentChatNativeRequest[]}
export interface OpenAgentChatRenderHooks {onBeforeRequest?:(request:OpenAgentChatNativeRequest)=>void;onResponseHeaders?:(headers:Record<string,string[]>)=>void|Promise<void>;onScreenshot?:(png:Uint8Array)=>void|Promise<void>}
export interface OpenAgentChatMutationIdentity {kind:'registration'|'publication';operationId:string;requestHash:string;accountId:string;sourceHash?:string;idempotencyKey?:string}
export interface OpenAgentChatDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;renderPage?:(url:string,signal:AbortSignal,hooks?:OpenAgentChatRenderHooks)=>Promise<OpenAgentChatRenderedPage>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}

export const openAgentChatHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const openAgentChatPublicUrl=(slug:string)=>`${OPENAGENTCHAT_ORIGIN}/p/${slug}`;
export const openAgentChatPageApiUrl=(id:number)=>`${OPENAGENTCHAT_PAGES_URL}/${id}`;
export function trackOpenAgentChatPending<T>(promise:Promise<T>):Promise<T>{let tracked:Promise<T>;tracked=Promise.resolve(promise).then(value=>{pending.delete(tracked);return value},error=>{pending.delete(tracked);throw error});pending.add(tracked);return tracked}
export async function drainOpenAgentChatPendingOperations(timeoutMs?:number):Promise<boolean>{
  const deadline=timeoutMs===undefined?Infinity:Date.now()+Math.min(60_000,Math.max(0,Number.isFinite(timeoutMs)?timeoutMs:0));
  while(pending.size){
    if(Date.now()>=deadline)return false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([Promise.allSettled([...pending]),...(deadline===Infinity?[]:[new Promise<void>(resolve=>{timer=setTimeout(resolve,Math.max(0,deadline-Date.now()))})])])}
    finally{if(timer)clearTimeout(timer)}
  }
  return true;
}
export function openAgentChatPendingOperationCount(){return pending.size}

function exactObject(value:unknown,required:string[],optional:string[]=[]):value is Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))return false;const keys=Object.keys(value);return required.every(key=>keys.includes(key))&&keys.every(key=>required.includes(key)||optional.includes(key))}
function clean(value:unknown,min:number,max:number):value is string{return typeof value==='string'&&value.length>=min&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)}
function exactDate(value:unknown):value is string{return typeof value==='string'&&Number.isFinite(Date.parse(value))}
function integer(value:unknown):value is number{return Number.isSafeInteger(value)&&Number(value)>0}
function envelope(value:unknown,key:string):Record<string,unknown>|undefined{if(exactObject(value,[key]))return value[key] as Record<string,unknown>;return exactObject(value,['data'])&&exactObject(value.data,[key])?(value.data as Record<string,unknown>)[key] as Record<string,unknown>:undefined}
export function parseOpenAgentChatAgent(value:unknown):OpenAgentChatAgent|undefined{
  const agent=envelope(value,'agent')??(exactObject(value,['id','name','display_name','kind','bio'],['created_at','updated_at'])?value:undefined);if(!agent)return;
  if(!exactObject(agent,['id','name','display_name','kind','bio'],['created_at','updated_at'])||!integer(agent.id)||typeof agent.name!=='string'||!OPENAGENTCHAT_AGENT_NAME.test(agent.name)||!clean(agent.display_name,1,80)||agent.kind!=='agent'||typeof agent.bio!=='string'||agent.bio.length>500)return;
  return {id:agent.id as number,name:agent.name,displayName:agent.display_name,kind:'agent',bio:agent.bio};
}
export function parseOpenAgentChatRegistration(value:unknown):{agent:OpenAgentChatAgent;token:string}|undefined{
  const root=exactObject(value,['agent','token'],['warning'])?value:exactObject(value,['data'])&&exactObject(value.data,['agent','token'],['warning'])?value.data as Record<string,unknown>:undefined;if(!root||root.warning!==undefined&&typeof root.warning!=='string'||!clean(root.token,16,4096)||/[\s]/.test(root.token))return;const agent=parseOpenAgentChatAgent({agent:root.agent});return agent?{agent,token:root.token}:undefined;
}
export function parseOpenAgentChatPage(value:unknown):OpenAgentChatPage|undefined{
  const page=envelope(value,'page')??(exactObject(value,['id','slug','title','body','kind','category','revision','created_at','updated_at','author','url','has_safety_flags','content_mode'],['source_url'])?value:undefined);if(!page)return;
  if(!exactObject(page,['id','slug','title','body','kind','category','revision','created_at','updated_at','author','url','has_safety_flags','content_mode'],['source_url'])||!integer(page.id)||!clean(page.slug,1,200)||!clean(page.title,3,160)||typeof page.body!=='string'||page.body.length<10||page.body.length>20_000||/[\u0000\u000b\u000c\u000e-\u001f\u007f]/.test(page.body)||page.kind!=='note'||page.category!=='engineering'||!integer(page.revision)||!exactDate(page.created_at)||!exactDate(page.updated_at)||typeof page.author!=='string'||!OPENAGENTCHAT_AGENT_NAME.test(page.author)||page.has_safety_flags!==false||page.content_mode!=='safe')return;
  const url=openAgentChatPublicUrl(page.slug as string);if(page.url!==url)return;
  return {id:page.id as number,slug:page.slug as string,title:page.title,body:page.body,kind:'note',category:'engineering',revision:page.revision as number,createdAt:new Date(page.created_at as string).toISOString(),updatedAt:new Date(page.updated_at as string).toISOString(),updatedAtRaw:page.updated_at as string,author:page.author,url,hasSafetyFlags:false,contentMode:'safe'};
}
export function openAgentChatRegistrationRequest(name:string,displayName:string,bio:string){const body=JSON.stringify({name,display_name:displayName,kind:'agent',bio});return {body,requestHash:openAgentChatHash(`POST\n${OPENAGENTCHAT_AGENTS_URL}\ncontent-type:application/json\n\n${body}`)}}
export function openAgentChatPageRequest(title:string,bodyText:string,idempotencyKey:string){const body=JSON.stringify({title,body:bodyText,kind:'note',category:'engineering'});return {body,sourceHash:openAgentChatHash(bodyText),requestHash:openAgentChatHash(`POST\n${OPENAGENTCHAT_PAGES_URL}\nidempotency-key:${idempotencyKey}\ncontent-type:application/json\n\n${body}`)}}
class PartialBody extends Error{constructor(readonly bytes:Uint8Array,readonly limit=false){super(limit?'body_limit':'transport')}}
async function bounded(response:Response,signal:AbortSignal){const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>OPENAGENTCHAT_MAX_RESPONSE_BYTES))throw new PartialBody(new Uint8Array(),true);if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Buffer[]=[];let size=0;try{for(;;){const next=await reader.read();if(signal.aborted)throw new PartialBody(Buffer.concat(parts));if(next.done)break;const chunk=Buffer.from(next.value);if(size+chunk.length>OPENAGENTCHAT_MAX_RESPONSE_BYTES)throw new PartialBody(Buffer.concat(parts),true);parts.push(chunk);size+=chunk.length}return Buffer.concat(parts)}catch(error){if(error instanceof PartialBody)throw error;throw new PartialBody(Buffer.concat(parts))}finally{try{reader.releaseLock()}catch{}}}
function opaque(response:Response,bytes:Uint8Array,url:string,now:()=>Date,complete=true):OpenAgentChatOpaqueResponse{return {version:1,capturedAt:now().toISOString(),requestUrl:url,status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,headers:[...response.headers.entries()].map(([k,v])=>[k.toLowerCase(),v] as [string,string]).sort(),bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:openAgentChatHash(bytes),bodyComplete:complete}}
export function parseOpenAgentChatOpaque(opaqueResponse:OpenAgentChatOpaqueResponse,expectedUrl:string,expectedStatus:number):unknown|undefined{if(opaqueResponse.requestUrl!==expectedUrl||opaqueResponse.status!==expectedStatus||!opaqueResponse.bodyComplete||opaqueResponse.redirected||opaqueResponse.responseType==='opaqueredirect'||opaqueResponse.responseUrl&&opaqueResponse.responseUrl!==expectedUrl||opaqueResponse.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return;const bytes=Buffer.from(opaqueResponse.bodyBase64,'base64');if(openAgentChatHash(bytes)!==opaqueResponse.bodySha256)return;try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{return}}
function validOpaque(value:unknown):value is OpenAgentChatOpaqueResponse{if(!exactObject(value,['version','capturedAt','requestUrl','status','contentType','responseUrl','redirected','responseType','headers','bodyBase64','bodySha256','bodyComplete'])||value.version!==1||!exactDate(value.capturedAt)||typeof value.requestUrl!=='string'||typeof value.status!=='number'||!Number.isSafeInteger(value.status)||typeof value.contentType!=='string'||typeof value.responseUrl!=='string'||typeof value.redirected!=='boolean'||typeof value.responseType!=='string'||!Array.isArray(value.headers)||value.headers.length>128||value.headers.some(item=>!Array.isArray(item)||item.length!==2||typeof item[0]!=='string'||typeof item[1]!=='string')||typeof value.bodyBase64!=='string'||typeof value.bodySha256!=='string'||!SHA.test(value.bodySha256)||typeof value.bodyComplete!=='boolean')return false;try{const bytes=Buffer.from(value.bodyBase64,'base64');return bytes.length<=OPENAGENTCHAT_MAX_RESPONSE_BYTES&&bytes.toString('base64')===value.bodyBase64&&openAgentChatHash(bytes)===value.bodySha256}catch{return false}}
export async function openAgentChatMutation(url:string,init:RequestInit,persist:(value:OpenAgentChatOpaqueResponse)=>Promise<void>,authorize:()=>true,deps:OpenAgentChatDependencies={}):Promise<OpenAgentChatOpaqueResponse|undefined>{
  const now=deps.now??(()=>new Date()),controller=new AbortController(),timeout=Math.min(60_000,Math.max(100,deps.timeoutMs??25_000)),abort=()=>controller.abort();deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)controller.abort();const timer=setTimeout(()=>controller.abort(),timeout);timer.unref?.();let response:Response|undefined;
  const preserve=async(value:Response)=>{try{const late=new AbortController(),lateTimer=setTimeout(()=>late.abort(),timeout);lateTimer.unref?.();try{const bytes=await bounded(value,late.signal);await persist(opaque(value,bytes,url,now))}catch(error){if(error instanceof PartialBody)await persist(opaque(value,error.bytes,url,now,false)).catch(()=>undefined)}finally{clearTimeout(lateTimer)}}catch{}};
  try{const transport=deps.fetch??((u:string,i:RequestInit)=>fetch(u,i));if(authorize()!==true)throw Error('OpenAgentChat mutation authorization changed');const request=Promise.resolve(transport(url,{...init,signal:controller.signal,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'}));response=await Promise.race([trackOpenAgentChatPending(request),new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('abort')),{once:true}))]).catch(error=>{void trackOpenAgentChatPending(request.then(value=>preserve(value))).catch(()=>undefined);throw error});const bytes=await bounded(response,controller.signal);const result=opaque(response,bytes,url,now);await persist(result);return result}catch(error){controller.abort();if(response&&error instanceof PartialBody){const result=opaque(response,error.bytes,url,now,false);await persist(result).catch(()=>undefined);return result}return undefined}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort)}
}

/** Only opt-in journals may replace an incomplete response with its longer prefix.
 * Completed receipts and every response identity/header are immutable. */
export function isOpenAgentChatOpaqueProgress(previous:OpenAgentChatOpaqueResponse,next:OpenAgentChatOpaqueResponse):boolean{
  if(!validOpaque(previous)||!validOpaque(next))return false;
  const {bodyBase64:oldBody,bodySha256:oldHash,bodyComplete:oldComplete,...oldIdentity}=previous;
  const {bodyBase64:newBody,bodySha256:newHash,bodyComplete:newComplete,...newIdentity}=next;
  if(JSON.stringify(oldIdentity)!==JSON.stringify(newIdentity))return false;
  const a=Buffer.from(oldBody,'base64'),b=Buffer.from(newBody,'base64');
  if(oldComplete)return newComplete&&oldHash===newHash&&oldBody===newBody;
  return b.length>=a.length&&b.subarray(0,a.length).equals(a);
}

/** Opt-in streaming capture. persist must atomically encrypt/save every snapshot,
 * permit only isOpenAgentChatOpaqueProgress, and keep a durable submit intent.
 * Legacy immutable-receipt callers must keep using openAgentChatMutation. */
export async function openAgentChatStreamingMutation(url:string,init:RequestInit,persist:(value:OpenAgentChatOpaqueResponse)=>Promise<void>,authorize:()=>true,deps:OpenAgentChatDependencies={}):Promise<OpenAgentChatOpaqueResponse|undefined>{
  if(deps.signal?.aborted)return;
  const timeout=Math.min(60_000,Math.max(100,Number.isFinite(deps.timeoutMs)?deps.timeoutMs!:25_000));
  const controller=new AbortController(),abort=()=>controller.abort();
  deps.signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,timeout);
  let stop:()=>void=()=>{};
  const stopped=new Promise<undefined>(resolve=>{stop=()=>resolve(undefined);controller.signal.addEventListener('abort',stop,{once:true})});
  const capture=async(response:Response,signal:AbortSignal)=>{
    const capturedAt=(deps.now?.()??new Date()).toISOString();
    const make=(bytes:Uint8Array,complete:boolean)=>opaque(response,bytes,url,()=>new Date(capturedAt),complete);
    let latest=make(new Uint8Array(),false),reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    const parts:Buffer[]=[];let size=0;
    const save=async(bytes:Uint8Array,complete:boolean)=>{const next=make(bytes,complete);await persist(next);latest=next;return next};
    try{
      // Even a stalled body leaves the received status and headers recoverable.
      await persist(latest);
      if(signal.aborted)return latest;
      const declared=response.headers.get('content-length');
      if(declared!==null&&(!/^\d+$/.test(declared)||!Number.isSafeInteger(Number(declared))||Number(declared)>OPENAGENTCHAT_MAX_RESPONSE_BYTES))return latest;
      // Fetch exposes decoded body bytes; Content-Length describes the encoded
      // representation. Only identity responses can be compared byte-for-byte.
      const encodings=(response.headers.get('content-encoding')??'identity').toLowerCase().split(',').map(value=>value.trim());
      if(!encodings.length||encodings.some(value=>!['identity','gzip','deflate','br'].includes(value)))return latest;
      const identityEncoding=encodings.every(value=>value==='identity');
      if(!response.body)return declared!==null&&Number(declared)!==0?latest:await save(new Uint8Array(),true);
      reader=response.body.getReader();
      for(;;){
        if(signal.aborted)return latest;
        let onAbort:()=>void=()=>{};
        try{
          const stoppedRead=new Promise<never>((_,reject)=>{onAbort=()=>reject(Error('capture_aborted'));signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort()});
          const next=await Promise.race([reader.read(),stoppedRead]);
          if(next.done){
            // A declared oversize/inconsistent body is evidence, never a receipt.
            if(identityEncoding&&declared!==null&&Number(declared)!==size)return latest;
            return await save(Buffer.concat(parts,size),true);
          }
          const chunk=Buffer.from(next.value),remaining=OPENAGENTCHAT_MAX_RESPONSE_BYTES-size;
          const kept=chunk.subarray(0,remaining);
          if(kept.length){parts.push(kept);size+=kept.length;await save(Buffer.concat(parts,size),false)}
          if(chunk.length>remaining)return latest;
        }finally{signal.removeEventListener('abort',onAbort)}
      }
    }catch{return undefined}
    finally{
      // A non-cooperative cancel must not block shutdown or lose the last prefix.
      if(reader){if(!latest.bodyComplete)void reader.cancel().catch(()=>undefined);try{reader.releaseLock()}catch{}}
      else if(response.body&&!latest.bodyComplete)void response.body.cancel().catch(()=>undefined);
    }
  };
  const work=trackOpenAgentChatPending((async()=>{
    try{
      if(controller.signal.aborted||authorize()!==true)return;
      const response=await (deps.fetch??((u:string,i:RequestInit)=>fetch(u,i)))(url,{...init,signal:controller.signal,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
      if(!controller.signal.aborted)return await capture(response,controller.signal);
      // A transport may deliver its one-time reply after ignoring cancellation.
      // Capture that same reply only; never send another request.
      const late=new AbortController(),lateTimer=setTimeout(()=>late.abort(),timeout);
      try{return await capture(response,late.signal)}finally{clearTimeout(lateTimer)}
    }catch{return undefined}
  })());
  try{return await Promise.race([work,stopped])}
  finally{clearTimeout(timer);controller.signal.removeEventListener('abort',stop);deps.signal?.removeEventListener('abort',abort)}
}
export function validOpenAgentChatAccountSecret(value:unknown):value is OpenAgentChatAccountSecret{if(!exactObject(value,['version','kind','operationId','requestHash','name','createdAt'],['token','opaqueResponse'])||value.version!==1||value.kind!=='openagentchat_account'||typeof value.operationId!=='string'||!/^oac_register_[a-f0-9]{32}$/.test(value.operationId)||typeof value.requestHash!=='string'||!SHA.test(value.requestHash)||typeof value.name!=='string'||!OPENAGENTCHAT_AGENT_NAME.test(value.name)||!exactDate(value.createdAt)||value.token!==undefined&&!clean(value.token,16,4096)||value.opaqueResponse!==undefined&&!validOpaque(value.opaqueResponse))return false;return true}
export function validOpenAgentChatPageSecret(value:unknown):value is OpenAgentChatPageSecret{return exactObject(value,['version','kind','operationId','idempotencyKey','requestHash','sourceHash','createdAt'],['opaqueResponse'])&&value.version===1&&value.kind==='openagentchat_page'&&typeof value.operationId==='string'&&/^oac_page_[a-f0-9]{32}$/.test(value.operationId)&&typeof value.idempotencyKey==='string'&&OPENAGENTCHAT_IDEMPOTENCY_KEY.test(value.idempotencyKey)&&typeof value.requestHash==='string'&&SHA.test(value.requestHash)&&typeof value.sourceHash==='string'&&SHA.test(value.sourceHash)&&exactDate(value.createdAt)&&(value.opaqueResponse===undefined||validOpaque(value.opaqueResponse))}
export async function readOpenAgentChatJson(url:string,token:string|undefined,deps:OpenAgentChatDependencies={}):Promise<unknown>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(100,deps.timeoutMs??25_000)));timer.unref?.();const abort=()=>controller.abort();deps.signal?.addEventListener('abort',abort,{once:true});try{const headers:Record<string,string>={accept:'application/json'};if(token)headers.authorization=`Bearer ${token}`;const response=await (deps.fetch??((u:string,i:RequestInit)=>fetch(u,i)))(url,{method:'GET',headers,signal:controller.signal,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});if(response.status!==200||response.redirected||response.url&&response.url!==url||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')throw Error('invalid readback');const bytes=await bounded(response,controller.signal);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort)}}
export {validOpaque as validOpenAgentChatOpaqueResponse};
