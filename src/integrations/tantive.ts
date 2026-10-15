import {createHash,randomUUID} from 'node:crypto';

export const TANTIVE_ORIGIN='https://tantive.space';
export const TANTIVE_PREVIEW_URL=`${TANTIVE_ORIGIN}/write/preview`;
export const TANTIVE_PUBLISH_URL=`${TANTIVE_ORIGIN}/write/publish`;
export const TANTIVE_ROBOTS_URL=`${TANTIVE_ORIGIN}/robots.txt`;
export const TANTIVE_MAX_RESPONSE_BYTES=8*1024;
export const TANTIVE_MAX_PUBLIC_BYTES=2*1024*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const ROOMS=new Set(['lobby','findings','questions','workshop']);

export interface TantiveDraft {name:string;title:string;room:'lobby'|'findings'|'questions'|'workshop';body:string}
export interface TantiveIntent extends TantiveDraft {requestId:string;bodyHash:string;bodyBytes:number;requestHash:string;createdAt:string}
export interface TantiveOpaqueResponse {version:1;capturedAt:string;requestUrl:string;status:number;contentType:string;responseUrl:string;redirected:boolean;responseType:string;headers:Array<[string,string]>;bodyBase64:string;bodySha256:string;bodyComplete:boolean}
export interface TantivePreview {ticket:string;challenge:string;answer:string;expiresInSeconds:600;publishRequestHash:string}
export interface TantiveReceipt {messageId:number;rootId:number;requestId:string;readUrl:string;publicUrl:string;status:'published'|'already_published'}
export interface TantivePublicationSecret {version:1;kind:'tantive_publication';intent:TantiveIntent;previewResponse?:TantiveOpaqueResponse;publish?:{requestHash:string;dispatchedAt:string;response?:TantiveOpaqueResponse}}
export interface TantiveNativeRequest {url:string;method:'GET';resourceType:'mainFrame'|'stylesheet'}
export interface TantiveRejectedRequest {url:string;method:string;resourceType:string;reason:'outside_allowlist'|'total_request_limit'|'stylesheet_request_limit';acceptedRequests:number;acceptedStylesheets:number}
export interface TantiveRenderedPage {url:string;documentTitle:string;titleText:string;titleVisible:boolean;authorText:string;articleHtml:string;articleText:string;allArticleTextVisible:boolean;links:Array<{href:string;rel:string[];text:string;visible:boolean}>;robots:Array<{name:string;content:string}>;canonicals:string[];hasRefresh:boolean;hasPasswordGate:boolean;hasLoginGate:boolean;responseRobots:string[];responseLinks:string[];responseStatus:number;responseMediaType:string;responseBodyBytes:number;responseEncodedBodyBytes:number;nativeRequests:TantiveNativeRequest[]}
export interface TantiveRenderHooks {onBeforeRequest?:(request:TantiveNativeRequest)=>void;onRejectedRequest?:(request:TantiveRejectedRequest)=>void;onResponseHeaders?:(headers:Record<string,string[]>)=>void|Promise<void>;onScreenshot?:(png:Uint8Array)=>void|Promise<void>}
export interface TantivePersistence {loadSecret():Promise<TantivePublicationSecret|undefined>;persistIntent(intent:TantiveIntent):Promise<void>;assertAuthorized(intent:TantiveIntent,phase:'preview'|'publish'):true;persistPreviewResponse(intent:TantiveIntent,response:TantiveOpaqueResponse):Promise<void>;loadPreviewForPublish(intent:TantiveIntent,now:Date):Promise<TantivePreview|undefined>;persistPublishIntent(intent:TantiveIntent,requestHash:string,dispatchedAt:string):Promise<void>;assertDispatchAuthorized(intent:TantiveIntent,requestHash:string,ticket:string,now:Date):true;persistPublishResponse(intent:TantiveIntent,response:TantiveOpaqueResponse):Promise<void>;persistReceipt(intent:TantiveIntent,receipt:TantiveReceipt):Promise<void>}
export interface TantiveDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;renderPage?:(url:string,signal:AbortSignal,hooks?:TantiveRenderHooks)=>Promise<TantiveRenderedPage>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date;randomUUID?:()=>string}

export const tantiveHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const tantiveRequestUrl=(requestId:string)=>{if(!UUID.test(requestId))throw Error('Tantive request ID 无效');return `${TANTIVE_ORIGIN}/api/requests/${requestId}`};
export const tantivePublicUrl=(rootId:number)=>{if(!Number.isSafeInteger(rootId)||rootId<1)throw Error('Tantive root ID 无效');return `${TANTIVE_ORIGIN}/t/${rootId}`};
export const tantiveReadUrl=(messageId:number)=>{if(!Number.isSafeInteger(messageId)||messageId<1)throw Error('Tantive message ID 无效');return `${TANTIVE_ORIGIN}/api/messages/${messageId}`};
export const tantiveApiMessageUrl=(messageId:number,rootId:number)=>`${tantivePublicUrl(rootId)}?message=${messageId}#m${messageId}`;

function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
function exact(value:unknown,keys:string[]):value is Record<string,unknown>{return object(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',')}
function date(value:unknown):value is string{if(typeof value!=='string')return false;const time=Date.parse(value);return Number.isFinite(time)&&new Date(time).toISOString()===value}
function clean(value:unknown,max:number,multiline=false):value is string{return typeof value==='string'&&value.length>0&&[...value].length<=max&&!value.includes('\u0000')&&(multiline||!/[\r\n\u0000-\u001f\u007f]/.test(value))}
export function validTantiveIntent(value:unknown):value is TantiveIntent{if(!object(value)||!UUID.test(String(value.requestId??''))||!clean(value.name,48)||!clean(value.title,180)||!ROOMS.has(String(value.room??''))||!clean(value.body,4000,true)||!SHA.test(String(value.bodyHash??''))||!Number.isSafeInteger(value.bodyBytes)||Number(value.bodyBytes)<1||!SHA.test(String(value.requestHash??''))||!date(value.createdAt))return false;const payload=JSON.stringify({name:value.name,title:value.title,room:value.room,body:value.body,request_id:value.requestId});return value.bodyHash===tantiveHash(String(value.body))&&value.bodyBytes===Buffer.byteLength(String(value.body),'utf8')&&value.requestHash===tantiveHash(`POST\n${TANTIVE_PREVIEW_URL}\ncontent-type:application/json\n\n${payload}`)}
function validOpaque(value:unknown):value is TantiveOpaqueResponse{if(!object(value)||value.version!==1||!date(value.capturedAt)||typeof value.requestUrl!=='string'||value.requestUrl.length>2048||!Number.isSafeInteger(value.status)||typeof value.contentType!=='string'||value.contentType.length>512||typeof value.responseUrl!=='string'||value.responseUrl.length>2048||typeof value.redirected!=='boolean'||typeof value.responseType!=='string'||value.responseType.length>64||!Array.isArray(value.headers)||value.headers.length>128||value.headers.some(item=>!Array.isArray(item)||item.length!==2||typeof item[0]!=='string'||item[0].length>256||typeof item[1]!=='string'||item[1].length>8192)||typeof value.bodyBase64!=='string'||!SHA.test(String(value.bodySha256??''))||typeof value.bodyComplete!=='boolean')return false;try{const bytes=Buffer.from(value.bodyBase64,'base64');return bytes.length<=TANTIVE_MAX_RESPONSE_BYTES&&bytes.toString('base64')===value.bodyBase64&&tantiveHash(bytes)===value.bodySha256}catch{return false}}
export function validTantivePublicationSecret(value:unknown):value is TantivePublicationSecret{return object(value)&&value.version===1&&value.kind==='tantive_publication'&&validTantiveIntent(value.intent)&&(value.previewResponse===undefined||validOpaque(value.previewResponse))&&(value.publish===undefined||object(value.publish)&&SHA.test(String(value.publish.requestHash??''))&&date(value.publish.dispatchedAt)&&(value.publish.response===undefined||validOpaque(value.publish.response)))}

// JSON.parse accepts duplicate object keys. Tantive receipts are state transitions,
// so duplicate keys are rejected before parsing instead of accepting the last value.
function strictJson(text:string):unknown|undefined{let index=0,duplicate=false;const whitespace=()=>{while(/[\s]/u.test(text[index]??''))index++};const stringValue=()=>{if(text[index++]!=='"')throw 0;const start=index-1;for(;;){const char=text[index++];if(char===undefined||/[\u0000-\u001f]/.test(char))throw 0;if(char==='"')break;if(char==='\\'){const escaped=text[index++];if(!escaped||!/^["\\/bfnrtu]$/.test(escaped))throw 0;if(escaped==='u'){const hex=text.slice(index,index+4);if(!/^[a-f0-9]{4}$/i.test(hex))throw 0;index+=4}}}return JSON.parse(text.slice(start,index)) as string};const value=():void=>{whitespace();const char=text[index];if(char==='"'){stringValue();return}if(char==='{'){index++;whitespace();const keys=new Set<string>();if(text[index]==='}'){index++;return}for(;;){whitespace();const key=stringValue();if(keys.has(key))duplicate=true;keys.add(key);whitespace();if(text[index++]!==':')throw 0;value();whitespace();if(text[index]===','){index++;continue}if(text[index++]!=='}')throw 0;return}}if(char==='['){index++;whitespace();if(text[index]===']'){index++;return}for(;;){value();whitespace();if(text[index]===','){index++;continue}if(text[index++]!==']')throw 0;return}}const match=text.slice(index).match(/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/);if(!match)throw 0;index+=match[0].length};try{value();whitespace();if(index!==text.length||duplicate)return;return JSON.parse(text) as unknown}catch{return}}

export function makeTantiveIntent(draft:TantiveDraft,deps:Pick<TantiveDependencies,'now'|'randomUUID'>={}):{intent:TantiveIntent;body:string}{
  if(!clean(draft.name,48)||!clean(draft.title,180)||!ROOMS.has(draft.room)||!clean(draft.body,4000,true))throw Error('Tantive 原稿无效');
  const requestId=(deps.randomUUID??randomUUID)();if(!UUID.test(requestId))throw Error('Tantive request ID 无效');
  const payload={name:draft.name,title:draft.title,room:draft.room,body:draft.body,request_id:requestId},body=JSON.stringify(payload),bodyHash=tantiveHash(draft.body),bodyBytes=Buffer.byteLength(draft.body,'utf8');
  return {intent:{...draft,requestId,bodyHash,bodyBytes,requestHash:tantiveHash(`POST\n${TANTIVE_PREVIEW_URL}\ncontent-type:application/json\n\n${body}`),createdAt:(deps.now?.()??new Date()).toISOString()},body};
}

export function solveTantiveChallenge(value:string):string{
  if(typeof value!=='string'||value.length>300)throw Error('Tantive challenge 超出有界语法');
  const match=value.match(/^Add ([0-9]{1,7}) and ([0-9]{1,7})\. Append a hyphen and the word ([a-z]{1,32})\. Reply only with that result \(format: NUMBER-([a-z]{1,32})\)\.$/);
  if(!match||match[3]!==match[4])throw Error('Tantive challenge 超出有界语法');
  const left=Number(match[1]),right=Number(match[2]),sum=left+right;if(!Number.isSafeInteger(sum)||left>1_000_000||right>1_000_000)throw Error('Tantive challenge 整数越界');
  return `${sum}-${match[3]}`;
}

export function parseTantivePreview(value:unknown,intent:TantiveIntent):TantivePreview|undefined{
  if(!exact(value,['status','request_id','public_message','body_sha256','body_bytes','challenge','expires_in_seconds','publish'])||value.status!=='preview_only_nothing_published'||value.request_id!==intent.requestId||value.body_sha256!==intent.bodyHash||value.body_bytes!==intent.bodyBytes||value.expires_in_seconds!==600||typeof value.challenge!=='string')return;
  const message=value.public_message;if(!exact(message,['room','title','body','author','reply_to'])||message.room!==intent.room||message.title!==intent.title||message.body!==intent.body||message.author!==intent.name||message.reply_to!==null)return;
  const publish=value.publish;if(!exact(publish,['method','url','json_template'])||publish.method!=='POST'||publish.url!==TANTIVE_PUBLISH_URL)return;
  const template=publish.json_template;if(!exact(template,['ticket','answer','confirm'])||typeof template.ticket!=='string'||!template.ticket||template.ticket.length>16_384||template.answer!=='YOUR_ANSWER'||template.confirm!=='publish-publicly')return;
  let answer:string;try{answer=solveTantiveChallenge(value.challenge)}catch{return}
  const body=JSON.stringify({ticket:template.ticket,answer,confirm:'publish-publicly'});
  return {ticket:template.ticket,challenge:value.challenge,answer,expiresInSeconds:600,publishRequestHash:tantiveHash(`POST\n${TANTIVE_PUBLISH_URL}\ncontent-type:application/json\n\n${body}`)};
}

export function parseTantiveReceipt(value:unknown,intent:TantiveIntent):TantiveReceipt|undefined{
  if(!exact(value,['status','message','read_url','url'])||!['published','already_published'].includes(String(value.status))||!exact(value.message,['id','root_id','request_id']))return;
  const message=value.message as Record<string,unknown>,id=Number(message.id),rootId=Number(message.root_id);if(!Number.isSafeInteger(id)||id<1||rootId!==id||message.request_id!==intent.requestId||value.read_url!==tantiveReadUrl(id)||![tantivePublicUrl(rootId),tantiveApiMessageUrl(id,rootId)].includes(String(value.url)))return;
  return {messageId:id,rootId,requestId:intent.requestId,readUrl:String(value.read_url),publicUrl:tantivePublicUrl(rootId),status:value.status as TantiveReceipt['status']};
}

export function parseTantiveReadback(value:unknown,intent:TantiveIntent):TantiveReceipt|undefined{
  if(!object(value)||!object(value.message)||value.content_trust!=='untrusted_public_data')return;
  const message=value.message,id=Number(message.id),rootId=Number(message.root_id);if(!Number.isSafeInteger(id)||id<1||rootId!==id||message.reply_to!==null||message.room!==intent.room||message.author!==intent.name||message.title!==intent.title||message.body!==intent.body||(Object.hasOwn(message,'request_id')&&message.request_id!==intent.requestId)||value.url!==tantiveApiMessageUrl(id,rootId))return;
  // A request lookup may put the request ID only in its publication receipt.
  // Without that receipt, the message itself must still bind the original ID.
  if(!Object.hasOwn(message,'request_id')&&value.receipt===undefined)return;
  const receipt=value.receipt!==undefined?parseTantiveReceipt(value.receipt,intent):{messageId:id,rootId,requestId:intent.requestId,readUrl:tantiveReadUrl(id),publicUrl:tantivePublicUrl(rootId),status:'published' as const};
  if(!receipt||receipt.messageId!==id||receipt.rootId!==rootId)return;
  return receipt;
}

class ResponseFailure extends Error{constructor(readonly kind:'unknown'|'invalid'){super(`Tantive response ${kind}`)}}
async function bounded(response:Response,limit=TANTIVE_MAX_RESPONSE_BYTES):Promise<Uint8Array>{const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>limit))throw new ResponseFailure('invalid');if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Buffer[]=[];let size=0;try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>limit)throw new ResponseFailure('invalid');parts.push(Buffer.from(next.value))}return Buffer.concat(parts)}catch(error){void reader.cancel().catch(()=>undefined);throw error}finally{reader.releaseLock()}}
function opaque(response:Response,bytes:Uint8Array,url:string,now:()=>Date):TantiveOpaqueResponse{return {version:1,capturedAt:now().toISOString(),requestUrl:url,status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url,redirected:response.redirected,responseType:response.type,headers:[...response.headers.entries()].map(([key,item])=>[key.toLowerCase(),item] as [string,string]).sort(),bodyBase64:Buffer.from(bytes).toString('base64'),bodySha256:tantiveHash(bytes),bodyComplete:true}}
function decode(saved:TantiveOpaqueResponse,url:string,statuses:number[]):unknown|undefined{if(!validOpaque(saved)||saved.requestUrl!==url||!statuses.includes(saved.status)||saved.redirected||saved.responseType==='opaqueredirect'||saved.responseUrl&&saved.responseUrl!==url||saved.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return;const bytes=Buffer.from(saved.bodyBase64,'base64');try{return strictJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{return}}
export function parseStoredTantivePreview(saved:TantiveOpaqueResponse,intent:TantiveIntent,now:Date):TantivePreview|undefined{const captured=Date.parse(saved.capturedAt),current=now.getTime();if(!Number.isFinite(current)||current<captured||current>=captured+600_000)return;return parseTantivePreview(decode(saved,TANTIVE_PREVIEW_URL,[200]),intent)}
async function request(url:string,init:RequestInit,deps:TantiveDependencies):Promise<{response:TantiveOpaqueResponse;parsed:unknown|undefined}>{const controller=new AbortController(),abort=()=>controller.abort();deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)controller.abort();let timeout=false;const timer=setTimeout(()=>{timeout=true;controller.abort()},Math.min(60_000,Math.max(100,deps.timeoutMs??15_000)));timer.unref?.();try{const raw=await (deps.fetch??fetch)(url,{...init,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'application/json',...(init.method==='POST'?{'content-type':'application/json'}:{})}});if(raw.redirected||raw.status>=300&&raw.status<400||raw.url&&raw.url!==url)throw new ResponseFailure('invalid');const bytes=await bounded(raw),saved=opaque(raw,bytes,url,deps.now??(()=>new Date()));return {response:saved,parsed:decode(saved,url,[200,201])}}catch(error){if(deps.signal?.aborted||timeout||!(error instanceof ResponseFailure))throw new ResponseFailure('unknown');throw error}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort)}}

export async function previewTantive(intent:TantiveIntent,persistence:TantivePersistence,deps:TantiveDependencies={}):Promise<{status:'previewed';preview:TantivePreview}|{status:'unknown'|'invalid'}>{
  if(!validTantiveIntent(intent))throw Error('Tantive 提交意图无效');const body=JSON.stringify({name:intent.name,title:intent.title,room:intent.room,body:intent.body,request_id:intent.requestId});
  persistence.assertAuthorized(intent,'preview');let observed;try{observed=await request(TANTIVE_PREVIEW_URL,{method:'POST',body},deps)}catch{return {status:'unknown'}}await persistence.persistPreviewResponse(intent,observed.response);const preview=parseTantivePreview(observed.parsed,intent);return preview?{status:'previewed',preview}:{status:'invalid'};
}

export async function publishTantive(intent:TantiveIntent,preview:TantivePreview,persistence:TantivePersistence,deps:TantiveDependencies={}):Promise<{status:'published';receipt:TantiveReceipt}|{status:'unknown'|'invalid'}>{
  const now=deps.now?.()??new Date(),trusted=await persistence.loadPreviewForPublish(intent,now);if(!trusted||trusted.ticket!==preview.ticket||trusted.challenge!==preview.challenge||trusted.answer!==preview.answer||trusted.expiresInSeconds!==preview.expiresInSeconds||trusted.publishRequestHash!==preview.publishRequestHash)return {status:'invalid'};const body=JSON.stringify({ticket:trusted.ticket,answer:trusted.answer,confirm:'publish-publicly'}),requestHash=tantiveHash(`POST\n${TANTIVE_PUBLISH_URL}\ncontent-type:application/json\n\n${body}`);if(requestHash!==trusted.publishRequestHash)return {status:'invalid'};persistence.assertAuthorized(intent,'publish');const dispatchedAt=now.toISOString();await persistence.persistPublishIntent(intent,requestHash,dispatchedAt);persistence.assertDispatchAuthorized(intent,requestHash,trusted.ticket,deps.now?.()??new Date());let observed;try{observed=await request(TANTIVE_PUBLISH_URL,{method:'POST',body},deps)}catch{return {status:'unknown'}}await persistence.persistPublishResponse(intent,observed.response);const receipt=parseTantiveReceipt(observed.parsed,intent);if(!receipt)return {status:'invalid'};await persistence.persistReceipt(intent,receipt);return {status:'published',receipt};
}

export async function recoverTantive(intent:TantiveIntent,deps:TantiveDependencies={}):Promise<TantiveReceipt|undefined>{try{const observed=await request(tantiveRequestUrl(intent.requestId),{method:'GET'},deps);return observed.response.status===200?parseTantiveReadback(observed.parsed,intent):undefined}catch{return}}

export const tantiveTesting={strictJson,decode,validIntent:validTantiveIntent,validOpaque,UUID};
