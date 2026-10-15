import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {z} from 'zod';
import {isPublicIpAddress} from './web';

export const PRODUCT_INDEX_ORIGIN='https://index.percall.dev';
export const PRODUCT_INDEX_REGISTRY=`${PRODUCT_INDEX_ORIGIN}/api/index.json`;
export const PRODUCT_INDEX_GITHUB_ORIGIN='https://api.github.com';
export const PRODUCT_INDEX_ISSUES_API=`${PRODUCT_INDEX_GITHUB_ORIGIN}/repos/110kc3/seo/issues`;
export const PRODUCT_INDEX_REPOSITORY='https://github.com/110kc3/seo';
export const PRODUCT_INDEX_MAX_GITHUB_RESPONSE=2*1024*1024;
export const PRODUCT_INDEX_MAX_PUBLIC_RESPONSE=8*1024*1024;

const clean=(max:number)=>z.string().min(1).max(max).refine(value=>value===value.trim()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
const publicUrl=clean(300).refine(value=>{try{const url=new URL(value),host=url.hostname.toLowerCase().replace(/^\[|\]$/g,''),ip=isIP(host);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.hash&&url.href===value&&(ip?isPublicIpAddress(host):host.includes('.')&&!/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host))}catch{return false}});
const endpointSchema=z.object({llms_txt:publicUrl.optional(),openapi:publicUrl.optional(),mcp:publicUrl.optional()}).strict().refine(value=>Object.keys(value).length>0);
export const productIndexListingSchema=z.object({
  slug:clean(64).regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/),
  name:clean(80),
  url:publicUrl,
  description:clean(500),
  category:z.enum(['api','app','agent','mcp','other']),
  pricing:z.enum(['free','freemium','paid']),
  machine_endpoints:endpointSchema.optional(),
  tags:z.array(clean(30).regex(/^[a-z0-9-]{1,30}$/)).max(5).refine(value=>value.length===new Set(value).size).optional(),
  submitted_by:clean(120).optional(),
}).strict();
export type ProductIndexListing=z.infer<typeof productIndexListingSchema>;

export interface ProductIndexIntent {operationId:string;accountId:string;githubUser:string;slug:string;sourceHash:string;requestHash:string;createdAt:string}
export interface ProductIndexOpaque extends ProductIndexIntent {version:1;kind:'product_index_issue_response';status:number;contentType:string;responseUrl:string;redirected:boolean;bodyBase64:string;bodySha256:string;complete:boolean}
export interface ProductIndexIssueReceipt extends ProductIndexIntent {issueNumber:number;issueApiUrl:string;issueHtmlUrl:string}
export interface ProductIndexPersistence {
  persistIntent(intent:ProductIndexIntent):Promise<void>;
  assertReadyToSubmit(intent:ProductIndexIntent):true;
  persistOpaqueResponse(response:ProductIndexOpaque):Promise<void>;
  promoteIssue(receipt:ProductIndexIssueReceipt):Promise<void>;
}
export interface ProductIndexDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}
export interface ProductIndexNativeRequest {url:string;method:string;resourceType:string}
export interface ProductIndexRenderedPage {url:string;status:number;contentType:string;bodyBytes:number;encodedBodyBytes:number;html:string;allListingTextVisible:boolean;visibleLinks:Array<{href:string;rel:string[];text:string;visible:boolean}>;httpCanonicals:string[];httpRobots:string[];screenshotPng:Uint8Array;nativeRequests:ProductIndexNativeRequest[]}
export interface ProductIndexRenderHooks {onBeforeRequest?:(request:ProductIndexNativeRequest)=>void}
export interface ProductIndexPublisherDependencies extends ProductIndexDependencies {renderPage?:(url:string,signal:AbortSignal)=>Promise<ProductIndexRenderedPage>}
export type ProductIndexCreateResult={status:'not_started';reason:'invalid_content'|'intent_not_persisted'|'authorization_changed'}|{status:'unknown';intent:ProductIndexIntent;opaqueSaved:boolean}|{status:'created';receipt:ProductIndexIssueReceipt};

export const productIndexHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function productIndexListingUrl(slug:string){if(!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug))throw Error('AI Product Index slug 无效');return `${PRODUCT_INDEX_ORIGIN}/listings/${slug}.json`}
export function productIndexPublicUrl(slug:string){if(!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug))throw Error('AI Product Index slug 无效');return `${PRODUCT_INDEX_ORIGIN}/l/${slug}.html`}

export function parseReviewedProductIndexBody(body:string):ProductIndexListing|undefined{
  if(Buffer.byteLength(body)>18*1024)return;
  try{
    const parsed=productIndexListingSchema.parse(JSON.parse(body));
    const compact=JSON.stringify(parsed),pretty=JSON.stringify(parsed,null,2);
    if(![compact,pretty,pretty+'\n'].includes(body))return;
    return parsed;
  }catch{return}
}

export function productIndexIssueRequest(body:string,listing:ProductIndexListing){
  const exact=parseReviewedProductIndexBody(body);if(!exact||JSON.stringify(exact)!==JSON.stringify(listing))throw Error('AI Product Index 审核稿无效');
  const title=`[register] ${listing.name}`,issueBody=`\`\`\`json\n${body}\n\`\`\``,wire=JSON.stringify({title,body:issueBody});
  if(Buffer.byteLength(wire)>=20*1024)throw Error('AI Product Index issue 正文超限');
  return {title,issueBody,wire,sourceHash:productIndexHash(body),requestHash:productIndexHash(`POST\n${PRODUCT_INDEX_ISSUES_API}\naccept:application/vnd.github+json\ncontent-type:application/json\n\n${wire}`)};
}
export function validProductIndexIntent(value:ProductIndexIntent){return /^product_index_[a-f0-9]{32}$/.test(value.operationId)&&/^[0-9a-f-]{36}$/i.test(value.accountId)&&/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value.githubUser)&&/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(value.slug)&&/^[a-f0-9]{64}$/.test(value.sourceHash)&&/^[a-f0-9]{64}$/.test(value.requestHash)&&Number.isFinite(Date.parse(value.createdAt))&&new Date(value.createdAt).toISOString()===value.createdAt}
export function sameProductIndexIntent(a:ProductIndexIntent,b:ProductIndexIntent){return ['operationId','accountId','githubUser','slug','sourceHash','requestHash','createdAt'].every(key=>a[key as keyof ProductIndexIntent]===b[key as keyof ProductIndexIntent])}
export function productIndexListingMatches(value:unknown,listing:ProductIndexListing,owner?:string){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const record=value as Record<string,unknown>;
  for(const [key,expected] of Object.entries(listing))if(JSON.stringify(record[key])!==JSON.stringify(expected))return false;
  if(owner&&(record.github_user!==owner||record.origin!=='self-registered'))return false;
  return true;
}

function abortable<T>(promise:Promise<T>,signal:AbortSignal,late?:(value:T)=>void){return new Promise<T>((resolve,reject)=>{let done=false;const stop=()=>{if(!done){done=true;reject(Error('request interrupted'))}};signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();void promise.then(value=>{signal.removeEventListener('abort',stop);if(done){late?.(value);return}done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(!done){done=true;reject(Error('request failed'))}})})}
async function responseBytes(response:Response,signal:AbortSignal,max=PRODUCT_INDEX_MAX_GITHUB_RESPONSE){const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>max))throw Error('response too large');const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);const parts:Buffer[]=[];let size=0;try{for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.length;if(size>max)throw Error('response too large');parts.push(Buffer.from(next.value))}return Buffer.concat(parts)}finally{if(signal.aborted||size>max)void reader.cancel().catch(()=>undefined);reader.releaseLock()}}
function discard(response:Response){if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
function githubHeaders(token:string,accept='application/vnd.github+json'){return {accept,authorization:`Bearer ${token}`,'x-github-api-version':'2022-11-28','user-agent':'Linkflow-Desktop'}}
function exactGithubResponse(response:Response,url:string){return !response.redirected&&(!response.url||response.url===url)&&!(response.status>=300&&response.status<400)}
function safeJson(bytes:Uint8Array){return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown}

export async function validateProductIndexToken(token:string,deps:ProductIndexDependencies={}):Promise<{login:string;tokenFingerprint:string;checkedAt:string}>{
  if(token.length<8||token.length>512||/[\r\n]/.test(token))throw Error('GitHub 令牌格式无效');
  const url=`${PRODUCT_INDEX_GITHUB_ORIGIN}/user`,controller=new AbortController(),stop=()=>controller.abort();deps.signal?.addEventListener('abort',stop,{once:true});if(deps.signal?.aborted)stop();const timer=setTimeout(stop,Math.min(30000,Math.max(50,deps.timeoutMs??15000)));timer.unref?.();let response:Response|undefined;
  try{response=await (deps.fetch??fetch)(url,{method:'GET',headers:githubHeaders(token),redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal});if(!exactGithubResponse(response,url)||response.status!==200||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')throw Error('无法验证 GitHub 身份');const value=safeJson(await responseBytes(response,controller.signal));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('GitHub 身份响应无效');const login=(value as Record<string,unknown>).login;if(typeof login!=='string'||!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login))throw Error('GitHub 身份响应无效');return {login,tokenFingerprint:productIndexHash(token),checkedAt:(deps.now?.()??new Date()).toISOString()}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',stop);if(response)discard(response)}
}

export function parseProductIndexIssueResponse(value:ProductIndexOpaque,intent:ProductIndexIntent,body:string,listing:ProductIndexListing):ProductIndexIssueReceipt|undefined{
  const request=productIndexIssueRequest(body,listing),bytes=Buffer.from(value.bodyBase64,'base64');
  if(!sameProductIndexIntent(value,intent)||request.sourceHash!==intent.sourceHash||request.requestHash!==intent.requestHash||intent.slug!==listing.slug||!value.complete||bytes.length>PRODUCT_INDEX_MAX_GITHUB_RESPONSE||bytes.toString('base64')!==value.bodyBase64||productIndexHash(bytes)!==value.bodySha256||value.status!==201||value.redirected||value.responseUrl!==PRODUCT_INDEX_ISSUES_API||value.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return;
  try{const record=safeJson(bytes);if(!record||typeof record!=='object'||Array.isArray(record))return;const v=record as Record<string,unknown>,number=v.number;if(!Number.isSafeInteger(number)||Number(number)<1||v.title!==request.title||v.body!==request.issueBody||v.state!=='open'||v.url!==`${PRODUCT_INDEX_ISSUES_API}/${number}`||v.html_url!==`${PRODUCT_INDEX_REPOSITORY}/issues/${number}`||v.repository_url!==`${PRODUCT_INDEX_GITHUB_ORIGIN}/repos/110kc3/seo`)return;const user=v.user;if(!user||typeof user!=='object'||Array.isArray(user)||(user as Record<string,unknown>).login!==intent.githubUser)return;return {...intent,issueNumber:Number(number),issueApiUrl:String(v.url),issueHtmlUrl:String(v.html_url)}}catch{return}
}

export async function createProductIndexIssue(input:{operationId:string;accountId:string;githubUser:string;token:string;body:string;listing:ProductIndexListing;reviewed:true},persistence:ProductIndexPersistence,deps:ProductIndexDependencies={}):Promise<ProductIndexCreateResult>{
  if(deps.signal?.aborted)return {status:'not_started',reason:'authorization_changed'};let request:ReturnType<typeof productIndexIssueRequest>;
  try{request=productIndexIssueRequest(input.body,input.listing)}catch{return {status:'not_started',reason:'invalid_content'}}
  if(input.reviewed!==true)return {status:'not_started',reason:'invalid_content'};
  const intent:ProductIndexIntent={operationId:input.operationId,accountId:input.accountId,githubUser:input.githubUser,slug:input.listing.slug,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};if(!validProductIndexIntent(intent))return {status:'not_started',reason:'invalid_content'};
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started',reason:'intent_not_persisted'}}
  const controller=new AbortController(),stop=()=>controller.abort();deps.signal?.addEventListener('abort',stop,{once:true});if(deps.signal?.aborted)stop();const timer=setTimeout(stop,Math.min(60000,Math.max(50,deps.timeoutMs??25000)));timer.unref?.();let response:Response|undefined,opaqueSaved=false;
  try{
    try{if(controller.signal.aborted||persistence.assertReadyToSubmit(intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
    response=await abortable(Promise.resolve((deps.fetch??fetch)(PRODUCT_INDEX_ISSUES_API,{method:'POST',body:request.wire,headers:{...githubHeaders(input.token),'content-type':'application/json'},redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal})),controller.signal,discard);
    const bytes=await responseBytes(response,controller.signal),opaque:ProductIndexOpaque={...intent,version:1,kind:'product_index_issue_response',status:response.status,contentType:response.headers.get('content-type')??'',responseUrl:response.url||PRODUCT_INDEX_ISSUES_API,redirected:response.redirected,bodyBase64:bytes.toString('base64'),bodySha256:productIndexHash(bytes),complete:true};await persistence.persistOpaqueResponse(opaque);opaqueSaved=true;const receipt=parseProductIndexIssueResponse(opaque,intent,input.body,input.listing);if(!receipt)return {status:'unknown',intent,opaqueSaved};await persistence.promoteIssue(receipt);return {status:'created',receipt};
  }catch{return {status:'unknown',intent,opaqueSaved}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',stop);if(response)discard(response)}
}

export const productIndexTesting={githubHeaders,exactGithubResponse,responseBytes};
