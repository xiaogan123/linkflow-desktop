import {BATCH5_ADAPTER_MESSAGES,BATCH5_MESSAGES} from '../shared/batch5-messages';
import {createHash} from 'node:crypto';
import {marked} from 'marked';
import {inspectRenderedArticle} from './article-rendering';
import {containsPublicationReferralInformation} from '../shared/referral-policy';
import type {ExecutionContext,ExecutionResult,LinkResult,Site,Task} from '../shared/types';
import type {Batch5Dependencies,Batch5Intent,Batch5OpaqueResponse,Batch5Persistence,Batch5Receipt,Batch5TaskState} from './batch5-contract';

type DirectChannel='yeetmd'|'markdownpage';
type DirectContext=ExecutionContext&{batch5Persistence?:Batch5Persistence;batch5Dependencies?:Batch5Dependencies};
type DirectTask=Task&{batch5?:Batch5TaskState};
export interface Batch5DirectResult extends ExecutionResult{batch5?:Batch5TaskState;failureKind?:'rate_limited'|'provider_rejected'|'format_invalid'|'account_handoff'|'unknown'|'verification_failed'}
interface DirectConfig{channelId:DirectChannel;domain:string;origin:string;createPath:string;maximum:number;minimum:number;raw:boolean;body:(markdown:string)=>string;contentType:string}
const CONFIG:Record<DirectChannel,DirectConfig>={
  yeetmd:{channelId:'yeetmd',domain:'yeet.md',origin:'https://yeet.md',createPath:'/api/share',maximum:500_000,minimum:3,raw:false,body:markdown=>JSON.stringify({content:markdown}),contentType:'application/json'},
  markdownpage:{channelId:'markdownpage',domain:'markdown.page',origin:'https://markdown.page',createPath:'/api/publish',maximum:1_000_000,minimum:3,raw:true,body:markdown=>markdown,contentType:'text/markdown; charset=utf-8'},
};
/** Exposes the exact anonymous POST body for offline public-payload guards. */
export const batch5DirectTesting={publicBody:(channelId:DirectChannel,markdown:string)=>CONFIG[channelId].body(markdown)};
const MAX_JSON=64_000,MAX_HTML=2_000_000,MAX_ROBOTS=128_000;
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fail=(url:string,reason:string,outcome:LinkResult['outcome']='invalid'):LinkResult=>({found:false,outcome,url,rel:'unknown',reason,indexable:false});
function config(channelId:string):DirectConfig|undefined{return Object.hasOwn(CONFIG,channelId)?CONFIG[channelId as DirectChannel]:undefined}
function targetUrl(value:string):string|undefined{try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')return;url.hash='';return url.toString()}catch{return}}
function unsafeMarkdown(value:unknown):boolean{if(Array.isArray(value))return value.some(unsafeMarkdown);if(!object(value))return false;if(value.type==='html'||value.type==='image')return true;if(value.type==='link'&&(typeof value.href!=='string'||!/^https:\/\//.test(value.href)))return true;return Object.values(value).some(unsafeMarkdown)}
function draft(task:Task,site:Site,spec:DirectConfig):{markdown:string;target:string}|undefined{
  if(!task.articleApprovedAt||!Number.isFinite(Date.parse(task.articleApprovedAt))||!task.draft)return;
  const {title,description,body}=task.draft,target=targetUrl(task.topicUrl??site.url);
  if(!target||typeof title!=='string'||!title.trim()||title!==title.trim()||title.length>300
    ||typeof description!=='string'||description.length>1000||typeof body!=='string'||body!==body.trim()||body.length<100
    ||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(`${title}${description}${body}`)||!body.includes(target))return;
  if(spec.channelId==='markdownpage'&&containsPublicationReferralInformation(task,site))return;
  const markdown=`# ${title}\n\n${description?`${description}\n\n`:''}${body}\n`;
  if(Buffer.byteLength(markdown,'utf8')<spec.minimum||Buffer.byteLength(markdown,'utf8')>spec.maximum)return;
  try{if(unsafeMarkdown(marked.lexer(markdown,{gfm:true})))return}catch{return}
  return {markdown,target};
}
function taskState(intent:Batch5Intent,stage:Batch5TaskState['stage'],receipt?:Batch5Receipt):Batch5TaskState{return {version:1,channelId:intent.channelId,operationId:intent.operationId,sourceHash:intent.sourceHash,requestHash:intent.requestHash,createdAt:intent.createdAt,stage,...(receipt?.publicUrl?{publicUrl:receipt.publicUrl}:{}),...(receipt?.remoteId?{remoteId:receipt.remoteId}:{})}}
function sameIntent(left:Batch5Intent,right:Batch5Intent):boolean{return left.version===1&&right.version===1&&left.channelId===right.channelId&&left.operationId===right.operationId&&left.siteId===right.siteId&&left.sourceHash===right.sourceHash&&left.requestHash===right.requestHash&&left.createdAt===right.createdAt}
function matchesState(intent:Batch5Intent,state:Batch5TaskState|undefined):boolean{return !state||state.version===1&&state.channelId===intent.channelId&&state.operationId===intent.operationId&&state.sourceHash===intent.sourceHash&&state.requestHash===intent.requestHash&&state.createdAt===intent.createdAt}
function makeIntent(context:DirectContext,spec:DirectConfig,markdown:string):Batch5Intent{return {version:1,channelId:spec.channelId,operationId:`b5_${hash(`${spec.channelId}:${context.task.id}`).slice(0,32)}`,siteId:context.site.id,sourceHash:hash(markdown),requestHash:hash(spec.body(markdown)),createdAt:(context.batch5Dependencies?.now?.()??new Date()).toISOString()}}
function publicUrl(spec:DirectConfig,id:string):string|undefined{if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))return;return spec.channelId==='yeetmd'?`${spec.origin}/s/${id}`:`${spec.origin}/${id}`}
function parseReceipt(spec:DirectConfig,intent:Batch5Intent,raw:string):Batch5Receipt|undefined{
  let value:unknown;try{value=JSON.parse(raw)}catch{return}
  if(!object(value))return;
  const id=spec.channelId==='yeetmd'?value.id:value.slug,url=typeof id==='string'?publicUrl(spec,id):undefined;
  if(!url||value.url!==url)return;
  let secret:string|undefined;
  if(spec.channelId==='yeetmd'){
    if(typeof value.deleteToken!=='string'||value.deleteToken.length<8||value.deleteToken.length>4096||/\s/.test(value.deleteToken))return;
    secret=value.deleteToken;
  }else if(value.raw_url!==`${url}.md`)return;
  return {version:1,intent,publicUrl:url,remoteId:id as string,rawResponse:raw,...(secret?{secret}:{})};
}
function timeoutSignal(external:AbortSignal|undefined,ms:number|undefined){const controller=new AbortController(),stop=()=>controller.abort();external?.addEventListener('abort',stop,{once:true});if(external?.aborted)controller.abort();const timer=setTimeout(stop,Math.max(100,Math.min(60_000,ms??15_000)));timer.unref?.();return {signal:controller.signal,close:()=>{clearTimeout(timer);external?.removeEventListener('abort',stop)}}}
async function bounded(response:Response,max:number,signal:AbortSignal):Promise<string>{
  const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>max))throw Error('body_limit');
  if(!response.body)throw Error('body_missing');const reader=response.body.getReader(),chunks:Buffer[]=[];let size=0;
  try{for(;;){if(signal.aborted)throw Error('aborted');const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>max)throw Error('body_limit');chunks.push(Buffer.from(next.value))}}finally{reader.releaseLock()}
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks));
}
async function request(url:string,init:RequestInit,deps:Batch5Dependencies,signal?:AbortSignal):Promise<{response:Response;body:string}>{
  const timer=timeoutSignal(signal,deps.timeoutMs);try{
    const response=await (deps.fetch??fetch)(url,{...init,signal:timer.signal,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
    if(timer.signal.aborted)throw Error('aborted');
    const body=await bounded(response,init.method==='POST'?MAX_JSON:init.headers&&new Headers(init.headers).get('accept')==='text/html'?MAX_HTML:MAX_ROBOTS,timer.signal);
    return {response,body};
  }finally{timer.close()}
}
function exactResponse(response:Response,url:string):boolean{return !response.redirected&&response.type!=='opaqueredirect'&&!(response.status>=300&&response.status<400)&&(!response.url||response.url===url)}
function responseMedia(response:Response):string{return response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()??''}
function robotsAllows(text:string,path:string):boolean{
  let applies=false,best=0,allow=true;
  for(const source of text.split(/\r?\n/)){
    const match=/^\s*(user-agent|allow|disallow)\s*:\s*([^#]*)/i.exec(source);if(!match)continue;
    const key=match[1].toLowerCase(),value=match[2].trim();if(key==='user-agent'){applies=value==='*';continue}
    if(!applies||!value)continue;
    const prefix=value.replace(/\*.*$/,'').replace(/\$$/,'');if(path.startsWith(prefix)&&prefix.length>=best){best=prefix.length;allow=key==='allow'}
  }
  return allow;
}
async function verified(receipt:Batch5Receipt,markdown:string,target:string,deps:Batch5Dependencies,signal?:AbortSignal):Promise<LinkResult>{
  const spec=config(receipt.intent.channelId),url=receipt.publicUrl;if(!spec||!receipt.remoteId||url!==publicUrl(spec,receipt.remoteId))return fail(url,BATCH5_ADAPTER_MESSAGES.direct.receiptUrlInvalid);
  try{
    if(spec.raw){const rawUrl=`${url}.md`,raw=await request(rawUrl,{method:'GET',headers:{accept:'text/markdown'}},deps,signal);if(!exactResponse(raw.response,rawUrl)||[403,408,429].includes(raw.response.status)||raw.response.status>=500)return fail(url,BATCH5_ADAPTER_MESSAGES.direct.publicReadUnavailable,'unreachable');if(raw.response.status===404||raw.response.status===410)return fail(url,BATCH5_ADAPTER_MESSAGES.direct.rawMismatch,'absent');if(raw.response.status!==200||!['text/markdown','text/plain'].includes(responseMedia(raw.response))||raw.body!==markdown)return fail(url,BATCH5_ADAPTER_MESSAGES.direct.rawMismatch)}
    const html=await request(url,{method:'GET',headers:{accept:'text/html'}},deps,signal);
    if(html.response.status===404||html.response.status===410)return fail(url,BATCH5_ADAPTER_MESSAGES.direct.publicUnavailable,'absent');
    if(!exactResponse(html.response,url)||html.response.status!==200||responseMedia(html.response)!=='text/html')return fail(url,BATCH5_ADAPTER_MESSAGES.direct.publicUnavailable,'unreachable');
    const robotUrl=`${spec.origin}/robots.txt`,robot=await request(robotUrl,{method:'GET',headers:{accept:'text/plain'}},deps,signal);
    if(!exactResponse(robot.response,robotUrl)||robot.response.status!==200||responseMedia(robot.response)!=='text/plain')return fail(url,BATCH5_ADAPTER_MESSAGES.direct.publicReadUnavailable,'unreachable');
    if(!robotsAllows(robot.body,new URL(url).pathname))return fail(url,BATCH5_ADAPTER_MESSAGES.direct.robotsBlocked);
    for(const selector of spec.raw?['article.prose','article']:['article','[data-snapshot-content]','.markdown-body','main .prose']){
      const check=inspectRenderedArticle(html.body,markdown,target,selector,{pageUrl:url,robotsHeader:html.response.headers.get('x-robots-tag')??''});
      if(check.found)return {found:true,outcome:'found',url,rel:check.rel,reason:BATCH5_ADAPTER_MESSAGES.direct.verified,indexable:true};
    }
    return fail(url,BATCH5_ADAPTER_MESSAGES.direct.contentMismatch);
  }catch{return fail(url,BATCH5_ADAPTER_MESSAGES.direct.publicReadUnavailable,'unreachable')}
}
async function recoverReceipt(intent:Batch5Intent,persistence:Batch5Persistence,spec:DirectConfig):Promise<Batch5Receipt|undefined>{
  const saved=await persistence.loadReceipt();if(saved&&sameIntent(saved.intent,intent)&&saved.publicUrl===publicUrl(spec,saved.remoteId??''))return saved;
  const opaque=await persistence.loadOpaqueResponse();if(!opaque||!sameIntent(opaque.intent,intent)||!opaque.bodyComplete||opaque.status!==201||opaque.contentType!=='application/json'||opaque.responseUrl&&opaque.responseUrl!==`${spec.origin}${spec.createPath}`)return;
  const raw=Buffer.from(opaque.bodyBase64,'base64').toString('utf8'),parsed=parseReceipt(spec,intent,raw);if(!parsed)return;
  await persistence.saveReceipt(parsed);return parsed;
}
export async function reconcileBatch5DirectTask(context:DirectContext):Promise<{status:'found';publicUrl:string;batch5:Batch5TaskState;verification:LinkResult}|{status:'unknown';batch5?:Batch5TaskState}>{
  const spec=config(context.task.channelId),persistence=context.batch5Persistence;if(!spec||!persistence)return {status:'unknown'};
  const article=draft(context.task,context.site,spec),intent=await persistence.loadIntent();if(!article||!intent||intent.channelId!==spec.channelId||intent.siteId!==context.site.id||intent.sourceHash!==hash(article.markdown)||intent.requestHash!==hash(spec.body(article.markdown))||!matchesState(intent,(context.task as DirectTask).batch5))return {status:'unknown'};
  let receipt:Batch5Receipt|undefined;try{receipt=await recoverReceipt(intent,persistence,spec)}catch{return {status:'unknown',batch5:taskState(intent,'opaque_response')}}
  if(!receipt)return {status:'unknown',batch5:taskState(intent,'submitting')};
  const verification=await verified(receipt,article.markdown,article.target,context.batch5Dependencies??{},context.signal);
  const accepted=(context.task as DirectTask).batch5?.stage==='published';
  return verification.found?{status:'found',publicUrl:receipt.publicUrl,batch5:taskState(intent,accepted?'published':'api_receipt',receipt),verification}:{status:'unknown',batch5:taskState(intent,accepted?'published':'api_receipt',receipt)};
}
export async function verifyBatch5DirectPublication(task:DirectTask,site:Site,target:string,persistence:Batch5Persistence,deps:Batch5Dependencies={},signal?:AbortSignal):Promise<LinkResult>{
  const unavailable=(reason:string)=>fail(task.publicUrl??'',reason,'unreachable');
  const spec=config(task.channelId),article=spec&&draft(task,site,spec);let intent:Batch5Intent|undefined;
  try{intent=await persistence.loadIntent()}catch{return unavailable(BATCH5_ADAPTER_MESSAGES.direct.intentMismatch)}
  if(!spec||!article||!intent||intent.channelId!==spec.channelId||intent.siteId!==site.id||intent.sourceHash!==hash(article.markdown)||intent.requestHash!==hash(spec.body(article.markdown))||!matchesState(intent,task.batch5))return unavailable(BATCH5_ADAPTER_MESSAGES.direct.intentMismatch);
  let receipt:Batch5Receipt|undefined;try{receipt=await recoverReceipt(intent,persistence,spec)}catch{return unavailable(BATCH5_ADAPTER_MESSAGES.direct.receiptMissing)}
  if(!receipt||task.publicUrl&&task.publicUrl!==receipt.publicUrl)return unavailable(BATCH5_ADAPTER_MESSAGES.direct.receiptMissing);
  return verified(receipt,article.markdown,target,deps,signal);
}
export async function runBatch5DirectTask(context:DirectContext):Promise<Batch5DirectResult>{
  const spec=config(context.channel.id),persistence=context.batch5Persistence,deps=context.batch5Dependencies??{};
  if(!spec||context.task.channelId!==spec.channelId||context.task.sourceDomain!==spec.domain||context.channel.domain!==spec.domain||context.task.accountId||context.channel.accountRequired||context.channel.automation!=='api'||!persistence)return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.direct.configMissing};
  const article=draft(context.task,context.site,spec);if(!article)return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.direct.draftInvalid};
  const prior=await persistence.loadIntent();
  if(prior){const recovered=await reconcileBatch5DirectTask(context);if(recovered.status==='found'){const suffix=recovered.batch5.stage==='published'?'published':'api_receipt';return {status:'review',message:BATCH5_ADAPTER_MESSAGES.direct.priorVerified,publicUrl:recovered.publicUrl,batch5:recovered.batch5,linkRel:recovered.verification.rel,checkpoint:`batch5_${spec.channelId}_${suffix}`,submittedAt:prior.createdAt}}const restored=recovered.batch5??taskState(prior,'submitting');return {status:'review',message:BATCH5_ADAPTER_MESSAGES.direct.priorUnknown,batch5:restored,checkpoint:`batch5_${spec.channelId}_${restored.stage}`,submittedAt:prior.createdAt,failureKind:'unknown'}}
  if(context.task.submittedAt||context.task.publicUrl||(context.task as DirectTask).batch5||/^batch5_/.test(context.task.checkpoint??''))return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.direct.unboundSubmission};
  if(context.signal.aborted)return {status:'queued',message:BATCH5_ADAPTER_MESSAGES.direct.paused};
  const intent=makeIntent(context,spec,article.markdown),state=taskState(intent,'submitting');
  try{await persistence.saveIntent(intent);context.checkpoint({batch5:state,submittedAt:intent.createdAt,checkpoint:`batch5_${spec.channelId}_submitting`} as Partial<Task>)}catch{return {status:'queued',message:BATCH5_ADAPTER_MESSAGES.direct.intentSaveFailed}}
  try{await persistence.assertReadyToSubmit?.(intent)}catch{return {status:'review',message:BATCH5_MESSAGES.authorizationChanged,batch5:state,submittedAt:intent.createdAt,failureKind:'unknown'}}
  const url=`${spec.origin}${spec.createPath}`;let response:Response,body:string;
  try{const result=await request(url,{method:'POST',headers:{accept:'application/json','content-type':spec.contentType},body:spec.body(article.markdown)},deps,context.signal);response=result.response;body=result.body}catch{return {status:'review',message:BATCH5_ADAPTER_MESSAGES.direct.submissionUnknown,batch5:state,submittedAt:intent.createdAt,failureKind:'unknown'}}
  if(!exactResponse(response,url))return {status:'review',message:BATCH5_ADAPTER_MESSAGES.direct.redirectUnknown,batch5:state,submittedAt:intent.createdAt,failureKind:'unknown'};
  if(response.status===429)return {status:'failed',message:BATCH5_ADAPTER_MESSAGES.direct.rateLimited,batch5:state,checkpoint:'batch5_rejected',submittedAt:intent.createdAt,failureKind:'rate_limited'};
  if([400,413,415,422].includes(response.status))return {status:'failed',message:BATCH5_ADAPTER_MESSAGES.direct.formatInvalid,batch5:state,checkpoint:'batch5_rejected',submittedAt:intent.createdAt,failureKind:'format_invalid'};
  if(response.status===401)return {status:'failed',message:BATCH5_ADAPTER_MESSAGES.direct.accountHandoff,batch5:state,checkpoint:'batch5_rejected',submittedAt:intent.createdAt,failureKind:'account_handoff'};
  if(response.status>=400&&response.status<500&&response.status!==408)return {status:'failed',message:BATCH5_ADAPTER_MESSAGES.direct.rejected,batch5:state,checkpoint:'batch5_rejected',submittedAt:intent.createdAt,failureKind:'provider_rejected'};
  const opaque:Batch5OpaqueResponse={version:1,intent,status:response.status,contentType:responseMedia(response),responseUrl:response.url||url,bodyBase64:Buffer.from(body,'utf8').toString('base64'),bodyComplete:true};
  try{await persistence.saveOpaqueResponse(opaque)}catch{return {status:'review',message:BATCH5_ADAPTER_MESSAGES.direct.opaqueSaveFailed,batch5:state,submittedAt:intent.createdAt,failureKind:'unknown'}}
  const opaqueState=taskState(intent,'opaque_response');try{context.checkpoint({batch5:opaqueState,checkpoint:`batch5_${spec.channelId}_opaque_response`} as Partial<Task>)}catch{/* Vault copy remains available. */}
  if(response.status!==201||opaque.contentType!=='application/json')return {status:'review',message:BATCH5_ADAPTER_MESSAGES.direct.unexpectedResponse,batch5:opaqueState,submittedAt:intent.createdAt,failureKind:'unknown'};
  const receipt=parseReceipt(spec,intent,body);if(!receipt)return {status:'review',message:BATCH5_ADAPTER_MESSAGES.direct.receiptParseFailed,batch5:opaqueState,submittedAt:intent.createdAt,failureKind:'unknown'};
  try{await persistence.saveReceipt(receipt)}catch{return {status:'review',message:BATCH5_ADAPTER_MESSAGES.direct.receiptSaveFailed,batch5:opaqueState,submittedAt:intent.createdAt,failureKind:'unknown'}}
  const savedState=taskState(intent,'api_receipt',receipt);try{context.checkpoint({batch5:savedState,publicUrl:receipt.publicUrl,checkpoint:`batch5_${spec.channelId}_api_receipt`} as Partial<Task>)}catch{/* Encrypted receipt remains recoverable. */}
  const verification=await verified(receipt,article.markdown,article.target,deps,context.signal);
  if(!verification.found)return {status:'review',message:BATCH5_ADAPTER_MESSAGES.direct.awaitingPublic,batch5:savedState,publicUrl:receipt.publicUrl,checkpoint:`batch5_${spec.channelId}_api_receipt`,submittedAt:intent.createdAt,...(verification.outcome==='invalid'?{failureKind:'verification_failed' as const}:{})};
  return {status:'review',message:BATCH5_ADAPTER_MESSAGES.direct.firstVerified,batch5:savedState,publicUrl:receipt.publicUrl,linkRel:verification.rel,checkpoint:`batch5_${spec.channelId}_api_receipt`,submittedAt:intent.createdAt};
}
