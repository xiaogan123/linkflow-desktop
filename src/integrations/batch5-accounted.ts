import {BATCH5_ADAPTER_MESSAGES,BATCH5_MESSAGES} from '../shared/batch5-messages';
import {createHash,randomBytes} from 'node:crypto';
import {inspectRenderedArticle} from './article-rendering';
import {inspectPaperRenderedArticle} from './paper-rendering';
import {publicIdentitySlug} from './public-identity';
import {writeFreelyCollectionPostsPath,writeFreelyEnvelope,writeFreelyPost,writeFreelyPostMatches,writeFreelyPostPayload,writeFreelyPublicPostUrl,WRITEFREELY_SIGNUP_PATH} from './writefreely-protocol';
import {containsPublicationReferralInformation} from '../shared/referral-policy';
import type {ExecutionContext,ExecutionResult,LinkResult,Site,Task} from '../shared/types';
import {Batch5IdentitySingleSiteError,Batch5RegistrationLimitError} from './batch5-contract';
import type {Batch5AccountIntent,Batch5AccountOpaqueResponse,Batch5AccountPersistence,Batch5AccountReceipt,Batch5Dependencies,Batch5Intent,Batch5OpaqueResponse,Batch5Persistence,Batch5Receipt,Batch5RegistrationState,Batch5TaskState} from './batch5-contract';

type AccountedId='slopit'|'rant';
type Context=ExecutionContext&{batch5Persistence?:Batch5Persistence;batch5AccountPersistence?:Batch5AccountPersistence;batch5Dependencies?:Batch5Dependencies};
type AccountedTask=Task&{batch5?:Batch5TaskState};
export interface Batch5AccountedResult extends ExecutionResult{batch5?:Batch5TaskState;failureKind?:'rate_limited'|'provider_rejected'|'format_invalid'|'account_handoff'|'unknown'|'verification_failed'}
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const outcome=(url:string,reason:string,kind:LinkResult['outcome']='invalid'):LinkResult=>({found:false,outcome:kind,url,rel:'unknown',reason,indexable:false});
function id(value:string):AccountedId|undefined{return value==='slopit'||value==='rant'?value:undefined}
function targetUrl(value:string):string|undefined{try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')return;url.hash='';return url.toString()}catch{return}}
function source(task:Task,site:Site,channelId:AccountedId):{title:string;body:string;target:string;slug:string}|undefined{
  const article=task.draft,target=targetUrl(task.topicUrl??site.url);if(!article||!target||!task.articleApprovedAt||!Number.isFinite(Date.parse(task.articleApprovedAt))||containsPublicationReferralInformation(task,site))return;
  const {title,body}=article;if(!title||title!==title.trim()||title.length>200||!body||body!==body.trim()||Buffer.byteLength(body)>256_000||!body.includes(target)||/\r|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body))return;
  if(channelId==='slopit'&&/https?:\/\/[a-z0-9-]+\.slopit\.io\b/i.test(body))return;
  const stem=title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,45).replace(/-+$/,'')||'article';
  const slug=`${stem}-${hash(`${task.id}:${title}:${body}`).slice(0,12)}`;
  return {title,body,target,slug};
}
export function slopitSignupEmail(baseAddress:string,siteId:string,aliases:readonly string[]=[]):string|undefined{
  const base=baseAddress.trim().toLowerCase();if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(base))return;
  const [local,domain]=base.split('@'),candidate=`${local.split('+')[0]}+site-${hash(siteId).slice(0,8)}@${domain}`;
  if(domain==='gmail.com'||domain==='googlemail.com')return candidate;
  return aliases.some(value=>value.toLowerCase()===candidate)?candidate:base;
}
function emailFor(context:Context):string|undefined{return slopitSignupEmail(context.mailbox?.user??context.settings.mail.user,context.site.id,context.mailbox?.aliases)}
function accountIntent(context:Context,channelId:AccountedId):Batch5AccountIntent|undefined{
  const username=publicIdentitySlug(context.site,context.site.id,32),email=channelId==='slopit'?emailFor(context):undefined;
  if(channelId==='slopit'&&!email)return;
  const password=channelId==='rant'?randomBytes(32).toString('base64url'):undefined;
  const body=channelId==='slopit'?JSON.stringify({name:username,title:context.site.name.slice(0,80),email,language:context.site.language}):JSON.stringify({alias:username,pass:password});
  return {version:1,channelId,siteId:context.site.id,operationId:`b5_account_${hash(`${channelId}:${context.site.id}`).slice(0,32)}`,requestHash:hash(body),createdAt:(context.batch5Dependencies?.now?.()??new Date()).toISOString(),username,...(email?{email}:{}),...(password?{password}:{})};
}
function registerBody(intent:Batch5AccountIntent,context:Context):string{
  return intent.channelId==='slopit'?JSON.stringify({name:intent.username,title:context.site.name.slice(0,80),email:intent.email,language:context.site.language}):JSON.stringify({alias:intent.username,pass:intent.password});
}
function accountReceipt(intent:Batch5AccountIntent,responseText:string):Batch5AccountReceipt|undefined{
  let raw:unknown;try{raw=JSON.parse(responseText)}catch{return}
  if(!object(raw))return;
  if(intent.channelId==='slopit'){
    const {api_key,blog_id,blog_url}=raw;if(typeof api_key!=='string'||api_key.length<12||typeof blog_id!=='string'||!/^[a-zA-Z0-9_-]{2,128}$/.test(blog_id)||typeof blog_url!=='string')return;
    try{const url=new URL(blog_url);if(url.protocol!=='https:'||url.username||url.password||url.port||!url.pathname.endsWith('/')||!(url.hostname==='slopit.io'||url.hostname.endsWith('.slopit.io')))return}catch{return}
    return {version:1,intent,accountId:blog_id,publicUrl:blog_url,secret:api_key,rawResponse:responseText};
  }
  const data=writeFreelyEnvelope(raw)?.data;if(!object(data)||typeof data.access_token!=='string'||data.access_token.length<8||object(data.user)&&data.user.username!==intent.username||!intent.username||!intent.password)return;
  return {version:1,intent,accountId:intent.username,publicUrl:`https://rant.li/${intent.username}/`,secret:JSON.stringify({password:intent.password,token:data.access_token}),rawResponse:responseText};
}
function timeoutSignal(external:AbortSignal|undefined,ms:number|undefined){const controller=new AbortController(),stop=()=>controller.abort();external?.addEventListener('abort',stop,{once:true});if(external?.aborted)controller.abort();const timer=setTimeout(stop,Math.max(100,Math.min(60_000,ms??15_000)));timer.unref?.();return {signal:controller.signal,close:()=>{clearTimeout(timer);external?.removeEventListener('abort',stop)}}}
async function readBody(response:Response,max:number,signal:AbortSignal):Promise<string>{
  const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>max))throw Error('response too large');
  if(!response.body)throw Error('missing body');const reader=response.body.getReader(),parts:Buffer[]=[];let size=0;
  try{for(;;){if(signal.aborted)throw Error('cancelled');const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>max)throw Error('response too large');parts.push(Buffer.from(item.value))}}finally{reader.releaseLock()}
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(parts));
}
async function request(url:string,init:RequestInit,deps:Batch5Dependencies,signal?:AbortSignal,max=128_000,allowIncompleteRejection=false):Promise<{response:Response;text:string;bodyComplete:boolean}>{
  const clock=timeoutSignal(signal,deps.timeoutMs);try{
    const response=await (deps.fetch??fetch)(url,{...init,signal:clock.signal,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
    if(clock.signal.aborted&&!(allowIncompleteRejection&&[401,403,409,429].includes(response.status)&&exact(response,url)))throw Error('cancelled');
    try{return {response,text:await readBody(response,max,clock.signal),bodyComplete:true}}
    catch{if(allowIncompleteRejection&&[401,403,409,429].includes(response.status)&&exact(response,url))return {response,text:'',bodyComplete:false};throw Error('response incomplete')}
  }finally{clock.close()}
}
const media=(response:Response)=>response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()??'';
const exact=(response:Response,url:string)=>!response.redirected&&response.type!=='opaqueredirect'&&!(response.status>=300&&response.status<400)&&(!response.url||response.url===url);
function taskState(intent:Batch5Intent,stage:Batch5TaskState['stage'],receipt?:Batch5Receipt):Batch5TaskState{return {version:1,channelId:intent.channelId,operationId:intent.operationId,sourceHash:intent.sourceHash,requestHash:intent.requestHash,createdAt:intent.createdAt,stage,...(receipt?.publicUrl?{publicUrl:receipt.publicUrl}:{}),...(receipt?.remoteId?{remoteId:receipt.remoteId}:{})}}
function sameIntent(left:Batch5Intent,right:Batch5Intent){return JSON.stringify(left)===JSON.stringify(right)}
function postInput(context:Context,channelId:AccountedId,article:NonNullable<ReturnType<typeof source>>,account:Batch5AccountReceipt):{url:string;body:string;publicUrl:string;rawUrl?:string;readUrl:string;token:string}|undefined{
  if(channelId==='slopit'){
    const blogId=account.accountId,url=`https://slopit.io/api/blogs/${encodeURIComponent(blogId)}/posts`,publicUrl=`${account.publicUrl}${article.slug}/`;
    return {url,body:JSON.stringify({title:article.title,body:article.body,slug:article.slug,status:'published',tags:[],language:context.site.language}),publicUrl,rawUrl:`${account.publicUrl}${article.slug}.md`,readUrl:`${url}/${article.slug}`,token:account.secret};
  }
  let secret:unknown;try{secret=JSON.parse(account.secret)}catch{return}
  if(!object(secret)||typeof secret.token!=='string'||secret.token.length<8)return;
  const username=account.accountId,path=writeFreelyCollectionPostsPath(username),readPath=writeFreelyCollectionPostsPath(username,article.slug),publicUrl=writeFreelyPublicPostUrl('https://rant.li',username,article.slug);
  if(!path||!readPath||!publicUrl)return;
  return {url:`https://rant.li${path}`,body:JSON.stringify(writeFreelyPostPayload(article.title,article.body,article.slug)),publicUrl,readUrl:`https://rant.li${readPath}`,token:secret.token};
}
function postIntent(context:Context,channelId:AccountedId,article:NonNullable<ReturnType<typeof source>>,post:NonNullable<ReturnType<typeof postInput>>):Batch5Intent{return {version:1,channelId,operationId:`b5_${hash(`${channelId}:${context.task.id}`).slice(0,32)}`,siteId:context.site.id,sourceHash:hash(article.body),requestHash:hash(post.body),createdAt:(context.batch5Dependencies?.now?.()??new Date()).toISOString()}}
function parsePostReceipt(intent:Batch5Intent,channelId:AccountedId,post:NonNullable<ReturnType<typeof postInput>>,text:string):Batch5Receipt|undefined{
  let raw:unknown;try{raw=JSON.parse(text)}catch{return}
  if(!object(raw))return;
  if(channelId==='slopit'){
    const candidate=raw.post_url??(object(raw._links)?raw._links.view:undefined);if(candidate!==undefined&&candidate!==post.publicUrl)return;
    if(raw.error!==undefined)return;
  }else{
    const sent=JSON.parse(post.body) as {title:string;body:string;slug:string},username=new URL(post.publicUrl).pathname.split('/')[1],created=writeFreelyPost(writeFreelyEnvelope(raw)?.data);
    if(!created||!writeFreelyPostMatches(created,{title:sent.title,markdown:sent.body,slug:sent.slug},username))return;
  }
  return {version:1,intent,publicUrl:post.publicUrl,remoteId:post.publicUrl.split('/').filter(Boolean).at(-1),rawResponse:text};
}
function robotsAllows(text:string,path:string):boolean{let active=false,best=-1,allowed=true;for(const line of text.split(/\r?\n/)){const match=/^\s*(user-agent|allow|disallow)\s*:\s*([^#]*)/i.exec(line);if(!match)continue;const key=match[1].toLowerCase(),value=match[2].trim();if(key==='user-agent'){active=value==='*';continue}if(active&&value&&path.startsWith(value.replace(/\*.*$/,''))&&value.length>=best){best=value.length;allowed=key==='allow'}}return allowed}
async function publicVerification(channelId:AccountedId,post:NonNullable<ReturnType<typeof postInput>>,article:NonNullable<ReturnType<typeof source>>,deps:Batch5Dependencies,signal?:AbortSignal):Promise<LinkResult>{
  try{
    if(channelId==='slopit'){
      const raw=await request(post.rawUrl!,{method:'GET',headers:{accept:'text/markdown'}},deps,signal,300_000);
      if(raw.response.status===404||raw.response.status===410)return outcome(post.publicUrl,BATCH5_ADAPTER_MESSAGES.accounted.rawUnavailable,'absent');
      if(!exact(raw.response,post.rawUrl!)||raw.response.status!==200||!['text/markdown','text/plain'].includes(media(raw.response)))return outcome(post.publicUrl,BATCH5_ADAPTER_MESSAGES.accounted.rawUnavailable,'unreachable');
      const end=raw.text.indexOf('\n---\n',4);if(!raw.text.startsWith('---\n')||end<0||raw.text.slice(end+5).trimEnd()!==article.body)return outcome(post.publicUrl,BATCH5_ADAPTER_MESSAGES.accounted.rawMismatch);
    }else{
      const api=await request(post.readUrl,{method:'GET',headers:{accept:'application/json'}},deps,signal);
      if(api.response.status===404||api.response.status===410)return outcome(post.publicUrl,BATCH5_ADAPTER_MESSAGES.accounted.apiUnavailable,'absent');
      if(!exact(api.response,post.readUrl)||api.response.status!==200||media(api.response)!=='application/json')return outcome(post.publicUrl,BATCH5_ADAPTER_MESSAGES.accounted.apiUnavailable,'unreachable');
      let value:unknown;try{value=JSON.parse(api.text)}catch{return outcome(post.publicUrl,BATCH5_ADAPTER_MESSAGES.accounted.apiNotJson)}
      const read=writeFreelyPost(writeFreelyEnvelope(value)?.data),username=new URL(post.publicUrl).pathname.split('/')[1];
      if(!read||!writeFreelyPostMatches(read,{title:article.title,markdown:article.body,slug:article.slug},username))return outcome(post.publicUrl,BATCH5_ADAPTER_MESSAGES.accounted.apiMismatch);
    }
    const html=await request(post.publicUrl,{method:'GET',headers:{accept:'text/html'}},deps,signal,2_000_000);
    if(html.response.status===404||html.response.status===410)return outcome(post.publicUrl,BATCH5_ADAPTER_MESSAGES.accounted.publicUnavailable,'absent');
    if(!exact(html.response,post.publicUrl)||html.response.status!==200||media(html.response)!=='text/html')return outcome(post.publicUrl,BATCH5_ADAPTER_MESSAGES.accounted.publicUnavailable,'unreachable');
    const robotsUrl=`${new URL(post.publicUrl).origin}/robots.txt`,robots=await request(robotsUrl,{method:'GET',headers:{accept:'text/plain'}},deps,signal,128_000);
    if(!exact(robots.response,robotsUrl)||robots.response.status!==200||media(robots.response)!=='text/plain')return outcome(post.publicUrl,BATCH5_ADAPTER_MESSAGES.accounted.publicReadUnavailable,'unreachable');
    if(!robotsAllows(robots.text,new URL(post.publicUrl).pathname))return outcome(post.publicUrl,BATCH5_ADAPTER_MESSAGES.accounted.robotsBlocked);
    const checked=channelId==='rant'?inspectPaperRenderedArticle(html.text,article.body,article.target,{pageUrl:post.publicUrl,robotsHeader:html.response.headers.get('x-robots-tag')??''}):inspectRenderedArticle(html.text,article.body,article.target,'.post-body',{pageUrl:post.publicUrl,robotsHeader:html.response.headers.get('x-robots-tag')??''});
    return checked.found?{found:true,outcome:'found',url:post.publicUrl,rel:checked.rel,reason:BATCH5_ADAPTER_MESSAGES.accounted.verified,indexable:true}:outcome(post.publicUrl,BATCH5_ADAPTER_MESSAGES.accounted.contentMismatch);
  }catch{return outcome(post.publicUrl,BATCH5_ADAPTER_MESSAGES.accounted.publicReadUnavailable,'unreachable')}
}
function accountResponseFailure(status:number,operationId:string):Batch5AccountedResult|undefined {
  const checkpoint='batch5_account_rejected';
  if([400,413,415,422].includes(status))return {status:'failed',checkpoint,message:BATCH5_ADAPTER_MESSAGES.accounted.registrationFormatInvalid,failureKind:'format_invalid',trialFailureOperationId:operationId};
  if([401,403].includes(status))return {status:'failed',checkpoint,message:BATCH5_ADAPTER_MESSAGES.accounted.registrationRefused,failureKind:'provider_rejected',trialFailureOperationId:operationId};
  if(status===409)return {status:'failed',checkpoint,message:BATCH5_ADAPTER_MESSAGES.accounted.registrationCredentialOrCollision,failureKind:'account_handoff'};
  if(status>=400&&status<500&&status!==408&&status!==429)return {status:'failed',checkpoint,message:BATCH5_ADAPTER_MESSAGES.accounted.registrationNoReceipt,failureKind:'provider_rejected',trialFailureOperationId:operationId};
}
async function markRegistration(persistence:Batch5AccountPersistence,intent:Batch5AccountIntent,stage:Batch5RegistrationState['stage']):Promise<boolean>{try{await persistence.markAccountRegistration(intent,stage);return true}catch{return false}}
const retry429=(registration:Batch5RegistrationState,now:Date)=>!!registration.lastRateLimitedAt&&now.getTime()-Date.parse(registration.lastRateLimitedAt)>=86_400_000;
const rateLimitedResult=():Batch5AccountedResult=>({status:'queued',checkpoint:'batch5_account_rate_limited',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationRateLimited});
const notSentResult=():Batch5AccountedResult=>({status:'queued',checkpoint:'batch5_account_not_sent',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationNotSent});
async function ensureAccount(context:Context,channelId:AccountedId,readOnlyRecovery=false):Promise<{receipt:Batch5AccountReceipt}|Batch5AccountedResult>{
  const persistence=context.batch5AccountPersistence;if(!persistence)return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.accountJournalMissing};
  let prior=await persistence.loadAccountIntent(channelId,context.site.id),saved=await persistence.loadAccountReceipt(channelId,context.site.id);
  let registration=await persistence.loadAccountRegistration(channelId,context.site.id)??context.task.batch5Registration;
  if(saved&&prior&&JSON.stringify(saved.intent)===JSON.stringify(prior)){await markRegistration(persistence,prior,'registered');return {receipt:saved};}
  const url=channelId==='slopit'?'https://slopit.io/api/signup':`https://rant.li${WRITEFREELY_SIGNUP_PATH}`;
  if(prior){
    const matches=registration?.channelId===prior.channelId&&registration.operationId===prior.operationId&&registration.createdAt===prior.createdAt;
    if(!registration||!matches)return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationUnknown,failureKind:'unknown',trialFailureOperationId:prior.operationId};
    if(registration.stage==='reserved'&&registration.sendGuardVersion===1){
      if(!await markRegistration(persistence,prior,'not_sent'))return notSentResult();
      registration=await persistence.loadAccountRegistration(channelId,context.site.id);
    }
    if(registration?.stage==='not_sent'){
      if(readOnlyRecovery)return notSentResult();
      if(!persistence.replaceUnsentAccountIntent)return notSentResult();
      const body=registerBody(prior,context);if(hash(body)!==prior.requestHash)return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationUnknown,failureKind:'account_handoff'};
      const now=context.batch5Dependencies?.now?.()??new Date(),next:Batch5AccountIntent={...prior,operationId:`b5_account_${randomBytes(16).toString('hex')}`,createdAt:now.toISOString()};
      try{await persistence.replaceUnsentAccountIntent(prior,next)}catch{return notSentResult()}
      prior=next;registration=await persistence.loadAccountRegistration(channelId,context.site.id);
    }
    const opaque=await persistence.loadAccountOpaqueResponse(channelId,context.site.id);
    if(registration?.stage==='rejected'&&registration.sendGuardVersion!==1&&opaque?.status===429&&persistence.reviveLegacyRateLimit){
      if(hash(registerBody(prior,context))!==prior.requestHash)return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationUnknown,failureKind:'account_handoff'};
      try{
        await persistence.reviveLegacyRateLimit(prior,(context.batch5Dependencies?.now?.()??new Date()).toISOString());
        registration=await persistence.loadAccountRegistration(channelId,context.site.id);
      }catch{
        // An old terminal 429 is read-only unless its encrypted reply proves
        // that the platform definitely did not accept this exact signup.
        return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationUnknown,failureKind:'unknown'};
      }
    }
    if(registration?.stage==='rate_limited'){
      if(hash(registerBody(prior,context))!==prior.requestHash)return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationUnknown,failureKind:'account_handoff'};
      const now=context.batch5Dependencies?.now?.()??new Date();
      if(readOnlyRecovery||!retry429(registration,now))return rateLimitedResult();
    }
    if(opaque&&JSON.stringify(opaque.intent)===JSON.stringify(prior)&&opaque.responseUrl===url&&opaque.responseExact!==false&&registration?.stage!=='rate_limited'){
      if(opaque.status===429)return registration?.stage==='rejected'&&registration.sendGuardVersion===1&&registration.rateLimitCount===3
        ?{status:'failed',checkpoint:'batch5_account_rejected',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationCredentialOrCollision,failureKind:'account_handoff'}
        :registration?.stage==='rejected'?{status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationUnknown,failureKind:'unknown'}:rateLimitedResult();
      if(!opaque.bodyComplete&&!(registration?.sendGuardVersion===1&&[401,403,409].includes(opaque.status)))return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationUnknown,failureKind:'unknown',trialFailureOperationId:prior.operationId};
      const failure=accountResponseFailure(opaque.status,prior.operationId);if(failure){await markRegistration(persistence,prior,'rejected');return failure;}
      if([200,201].includes(opaque.status)&&opaque.contentType==='application/json'){
        const recovered=accountReceipt(prior,Buffer.from(opaque.bodyBase64,'base64').toString('utf8'));
        if(!recovered){await markRegistration(persistence,prior,'request_unknown');return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationReceiptInvalid,failureKind:'unknown',trialFailureOperationId:prior.operationId};}
        try{await persistence.saveAccountReceipt(recovered);return {receipt:recovered}}
        catch{await markRegistration(persistence,prior,'request_unknown');return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationReceiptSaveFailed,failureKind:'unknown',trialFailureOperationId:prior.operationId}}
      }
    }
    // Only a guarded reservation (proven unsent) or a due 429 retry may send again;
    // an unguarded reservation could predate a crash in the middle of its POST.
    const sendable=registration?.stage==='rate_limited'||registration?.stage==='reserved'&&registration.sendGuardVersion===1;
    if(!sendable){
      await markRegistration(persistence,prior,'request_unknown');
      return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationUnknown,failureKind:'unknown',trialFailureOperationId:prior.operationId};
    }
  }
  if(readOnlyRecovery)return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationUnknown,failureKind:'unknown'};
  const intent=prior??accountIntent(context,channelId);if(!intent)return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.emailMissing};
  if(context.signal.aborted)return {status:'queued',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationPaused};
  if(!prior){try{await persistence.saveAccountIntent(intent)}catch(error){
    if(error instanceof Batch5IdentitySingleSiteError)return {status:'needs_input',checkpoint:'account_handoff',message:BATCH5_MESSAGES.identitySingleSite,failureKind:'account_handoff'};
    return {status:'queued',message:error instanceof Batch5RegistrationLimitError?BATCH5_MESSAGES.registrationLimit:BATCH5_ADAPTER_MESSAGES.accounted.registrationIntentSaveFailed};
  }}
  try{await persistence.assertReadyToRegister?.(intent)}catch{
    if(registration?.stage==='rate_limited')return rateLimitedResult();
    await markRegistration(persistence,intent,'not_sent');
    return notSentResult();
  }
  try{await persistence.markAccountRegistration(intent,'sending',(context.batch5Dependencies?.now?.()??new Date()).toISOString())}catch{return {status:'queued',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationIntentSaveFailed}}
  let response:Response,text:string,bodyComplete:boolean;try{({response,text,bodyComplete}=await request(url,{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:registerBody(intent,context)},context.batch5Dependencies??{},context.signal,128_000,true))}catch{await markRegistration(persistence,intent,'request_unknown');return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationResponseUnknown,failureKind:'unknown',trialFailureOperationId:intent.operationId}}
  const opaque:Batch5AccountOpaqueResponse={version:1,intent,status:response.status,contentType:media(response),responseUrl:response.url||url,bodyBase64:Buffer.from(text).toString('base64'),bodyComplete,responseExact:exact(response,url),receivedAt:(context.batch5Dependencies?.now?.()??new Date()).toISOString()};
  try{await persistence.saveAccountOpaqueResponse(opaque)}catch{await markRegistration(persistence,intent,'request_unknown');return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationOpaqueSaveFailed,failureKind:'unknown',trialFailureOperationId:intent.operationId}}
  if(!exact(response,url))return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationUnknown,failureKind:'unknown',trialFailureOperationId:intent.operationId};
  if(response.status===429){
    const state=await persistence.loadAccountRegistration(channelId,context.site.id);
    return state?.stage==='rejected'?{status:'failed',checkpoint:'batch5_account_rejected',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationCredentialOrCollision,failureKind:'account_handoff'}:rateLimitedResult();
  }
  const failure=accountResponseFailure(response.status,intent.operationId);if(failure){await markRegistration(persistence,intent,'rejected');return failure;}
  if(![200,201].includes(response.status)||media(response)!=='application/json')return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationNoReceipt,failureKind:'unknown',trialFailureOperationId:intent.operationId};
  const receipt=accountReceipt(intent,text);if(!receipt)return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationReceiptInvalid,failureKind:'unknown',trialFailureOperationId:intent.operationId};
  try{await persistence.saveAccountReceipt(receipt)}catch{return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.registrationReceiptSaveFailed,failureKind:'unknown',trialFailureOperationId:intent.operationId}}
  return {receipt};
}
export async function prepareBatch5Account(context:Context):Promise<Batch5AccountedResult|undefined>{
  const channelId=id(context.task.channelId);if(!channelId||context.channel.id!==channelId)return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.accountChannelMismatch};
  const ready=await ensureAccount(context,channelId);return 'receipt' in ready?undefined:ready;
}
/** Scheduler recovery path: load the original encrypted signup only; never create a new intent or send a request. */
export async function recoverBatch5Account(context:Context):Promise<{ready:true}|{ready:false;result:Batch5AccountedResult}>{
  const channelId=id(context.task.channelId);
  if(!channelId||context.channel.id!==channelId)return {ready:false,result:{status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.accountChannelMismatch}};
  const recovered=await ensureAccount(context,channelId,true);
  return 'receipt' in recovered?{ready:true}:{ready:false,result:recovered};
}
async function recoveredReceipt(intent:Batch5Intent,persistence:Batch5Persistence,channelId:AccountedId,post:NonNullable<ReturnType<typeof postInput>>):Promise<Batch5Receipt|undefined>{
  const existing=await persistence.loadReceipt();if(existing&&sameIntent(existing.intent,intent)&&existing.publicUrl===post.publicUrl)return existing;
  const opaque=await persistence.loadOpaqueResponse();if(!opaque||!sameIntent(opaque.intent,intent)||!opaque.bodyComplete||![200,201].includes(opaque.status)||opaque.contentType!=='application/json'||opaque.responseUrl!==post.url)return;
  const parsed=parsePostReceipt(intent,channelId,post,Buffer.from(opaque.bodyBase64,'base64').toString('utf8'));if(!parsed)return;
  await persistence.saveReceipt(parsed);return parsed;
}
export async function reconcileBatch5AccountedTask(context:Context):Promise<{status:'found';publicUrl:string;batch5:Batch5TaskState;verification:LinkResult}|{status:'unknown';batch5?:Batch5TaskState}>{
  const channelId=id(context.task.channelId),persistence=context.batch5Persistence,accounts=context.batch5AccountPersistence;if(!channelId||!persistence||!accounts)return {status:'unknown'};
  const account=await accounts.loadAccountReceipt(channelId,context.site.id),intent=await persistence.loadIntent(),article=source(context.task,context.site,channelId);if(!account||!intent||!article)return {status:'unknown'};
  const post=postInput(context,channelId,article,account);if(!post||intent.channelId!==channelId||intent.siteId!==context.site.id||intent.sourceHash!==hash(article.body)||intent.requestHash!==hash(post.body))return {status:'unknown'};
  let receipt:Batch5Receipt|undefined;try{receipt=await recoveredReceipt(intent,persistence,channelId,post)}catch{return {status:'unknown',batch5:taskState(intent,'opaque_response')}}
  if(!receipt)return {status:'unknown',batch5:taskState(intent,'submitting')};
  const verification=await publicVerification(channelId,post,article,context.batch5Dependencies??{},context.signal);
  const acceptedStage=(context.task as AccountedTask).batch5?.stage==='published'?'published':'api_receipt';
  return verification.found?{status:'found',publicUrl:receipt.publicUrl,batch5:taskState(intent,acceptedStage,receipt),verification}:{status:'unknown',batch5:taskState(intent,'api_receipt',receipt)};
}
export async function verifyBatch5AccountedPublication(context:Context,target:string):Promise<LinkResult>{
  const localFailure=(reason:string)=>outcome(context.task.publicUrl??'',reason,'unreachable');
  const channelId=id(context.task.channelId),persistence=context.batch5Persistence,accounts=context.batch5AccountPersistence;if(!channelId||!persistence||!accounts)return localFailure(BATCH5_ADAPTER_MESSAGES.accounted.publicationJournalMissing);
  try{
    const account=await accounts.loadAccountReceipt(channelId,context.site.id),article=source(context.task,context.site,channelId),intent=await persistence.loadIntent();if(!account||!article||!intent)return localFailure(BATCH5_ADAPTER_MESSAGES.accounted.accountOrDraftMissing);
    const post=postInput(context,channelId,article,account);
    const receipt=post&&await recoveredReceipt(intent,persistence,channelId,post);if(!post||!receipt||receipt.publicUrl!==context.task.publicUrl||target!==article.target)return localFailure(BATCH5_ADAPTER_MESSAGES.accounted.receiptTargetMismatch);
    return publicVerification(channelId,post,article,context.batch5Dependencies??{},context.signal);
  }catch{return localFailure(BATCH5_ADAPTER_MESSAGES.accounted.publicationJournalMissing)}
}
export async function runBatch5AccountedTask(context:Context):Promise<Batch5AccountedResult>{
  const channelId=id(context.channel.id),persistence=context.batch5Persistence;if(!channelId||context.task.channelId!==channelId||context.task.sourceDomain!==(channelId==='rant'?'rant.li':'slopit.io')||context.channel.automation!=='api'||!persistence)return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.configMissing};
  const article=source(context.task,context.site,channelId);if(!article)return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.draftInvalid};
  const ready=await ensureAccount(context,channelId);if(!('receipt' in ready))return ready;
  const post=postInput(context,channelId,article,ready.receipt);if(!post)return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.accountInvalid};
  const prior=await persistence.loadIntent(),reserved=!!prior&&(context.task as AccountedTask).batch5?.stage==='reserved'&&!context.task.submittedAt;
  if(prior&&!reserved){const found=await reconcileBatch5AccountedTask(context);return found.status==='found'?{status:'review',message:BATCH5_ADAPTER_MESSAGES.accounted.priorVerified,publicUrl:found.publicUrl,batch5:found.batch5,linkRel:found.verification.rel,submittedAt:prior.createdAt}:{status:'review',message:BATCH5_ADAPTER_MESSAGES.accounted.priorUnknown,batch5:found.batch5??taskState(prior,'submitting'),submittedAt:prior.createdAt,failureKind:'unknown'}}
  if(!prior&&(context.task.submittedAt||context.task.publicUrl||(context.task as AccountedTask).batch5))return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.unboundSubmission};
  if(context.signal.aborted)return {status:'queued',message:BATCH5_ADAPTER_MESSAGES.accounted.paused};
  if(!prior){
    // A deterministic slug is checked before reserving a one-shot create intent.
    const preflightUrl=channelId==='slopit'?post.rawUrl!:post.readUrl;
    try{const priorRead=await request(preflightUrl,{method:'GET',headers:{accept:channelId==='slopit'?'text/markdown':'application/json',...(channelId==='rant'?{authorization:`Token ${post.token}`}:{})}},context.batch5Dependencies??{},context.signal);if(!exact(priorRead.response,preflightUrl)||priorRead.response.status!==404)return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.slugUnavailable}}catch{return {status:'queued',message:BATCH5_ADAPTER_MESSAGES.accounted.slugReadUnavailable}}
  }
  const intent=prior??postIntent(context,channelId,article,post),state=taskState(intent,'submitting');
  if(intent.channelId!==channelId||intent.siteId!==context.site.id||intent.sourceHash!==hash(article.body)||intent.requestHash!==hash(post.body))return {status:'needs_input',message:BATCH5_ADAPTER_MESSAGES.accounted.unboundSubmission};
  if(!prior){
    if(!persistence.reserveIntent)return {status:'queued',message:BATCH5_ADAPTER_MESSAGES.accounted.intentSaveFailed};
    try{await persistence.reserveIntent(intent);context.checkpoint({batch5:taskState(intent,'reserved'),checkpoint:'batch5_reserved'} as Partial<Task>)}catch{return {status:'queued',message:BATCH5_ADAPTER_MESSAGES.accounted.intentSaveFailed}}
  }
  try{await persistence.assertReadyToSubmit?.(intent)}catch{return {status:'queued',message:BATCH5_MESSAGES.authorizationChanged,batch5:taskState(intent,'reserved')}}
  try{if(!persistence.markSending)throw Error('missing durable send guard');await persistence.markSending(intent)}catch{return {status:'queued',message:BATCH5_MESSAGES.authorizationChanged,batch5:taskState(intent,'reserved')}}
  try{context.checkpoint({batch5:state,submittedAt:intent.createdAt,checkpoint:'batch5_submitting'} as Partial<Task>)}catch{return {status:'review',message:BATCH5_ADAPTER_MESSAGES.accounted.submissionUnknown,batch5:state,submittedAt:intent.createdAt,failureKind:'unknown'}}
  let response:Response,text:string;try{({response,text}=await request(post.url,{method:'POST',headers:{accept:'application/json','content-type':'application/json',authorization:channelId==='slopit'?`Bearer ${post.token}`:`Token ${post.token}`,...(channelId==='slopit'?{'idempotency-key':intent.operationId}:{})},body:post.body},context.batch5Dependencies??{},context.signal))}catch{return {status:'review',message:BATCH5_ADAPTER_MESSAGES.accounted.submissionUnknown,batch5:state,submittedAt:intent.createdAt,failureKind:'unknown'}}
  if(!exact(response,post.url))return {status:'review',message:BATCH5_ADAPTER_MESSAGES.accounted.redirectUnknown,batch5:state,submittedAt:intent.createdAt,failureKind:'unknown'};
  if(response.status===429)return {status:'failed',message:BATCH5_ADAPTER_MESSAGES.accounted.rateLimited,batch5:state,checkpoint:'batch5_rejected',submittedAt:intent.createdAt,failureKind:'rate_limited'};
  if([400,413,415,422].includes(response.status))return {status:'failed',message:BATCH5_ADAPTER_MESSAGES.accounted.formatInvalid,batch5:state,checkpoint:'batch5_rejected',submittedAt:intent.createdAt,failureKind:'format_invalid'};
  if(response.status===401||response.status===403)return {status:'failed',message:BATCH5_ADAPTER_MESSAGES.accounted.accountHandoff,batch5:state,checkpoint:'batch5_rejected',submittedAt:intent.createdAt,failureKind:'account_handoff'};
  if(response.status>=400&&response.status<500&&response.status!==408)return {status:'failed',message:BATCH5_ADAPTER_MESSAGES.accounted.rejected,batch5:state,checkpoint:'batch5_rejected',submittedAt:intent.createdAt,failureKind:'provider_rejected'};
  const opaque:Batch5OpaqueResponse={version:1,intent,status:response.status,contentType:media(response),responseUrl:response.url||post.url,bodyBase64:Buffer.from(text).toString('base64'),bodyComplete:true};
  try{await persistence.saveOpaqueResponse(opaque)}catch{return {status:'review',message:BATCH5_ADAPTER_MESSAGES.accounted.opaqueSaveFailed,batch5:state,submittedAt:intent.createdAt,failureKind:'unknown'}}
  if(![200,201].includes(response.status)||media(response)!=='application/json')return {status:'review',message:BATCH5_ADAPTER_MESSAGES.accounted.unexpectedResponse,batch5:taskState(intent,'opaque_response'),submittedAt:intent.createdAt,failureKind:'unknown'};
  const receipt=parsePostReceipt(intent,channelId,post,text);if(!receipt)return {status:'review',message:BATCH5_ADAPTER_MESSAGES.accounted.receiptParseFailed,batch5:taskState(intent,'opaque_response'),submittedAt:intent.createdAt,failureKind:'unknown'};
  try{await persistence.saveReceipt(receipt)}catch{return {status:'review',message:BATCH5_ADAPTER_MESSAGES.accounted.receiptSaveFailed,batch5:taskState(intent,'opaque_response'),submittedAt:intent.createdAt,failureKind:'unknown'}}
  const saved=taskState(intent,'api_receipt',receipt),verification=await publicVerification(channelId,post,article,context.batch5Dependencies??{},context.signal);
  const acceptedStage=(context.task as AccountedTask).batch5?.stage==='published'?'published':'api_receipt';
  return verification.found?{status:'review',message:BATCH5_ADAPTER_MESSAGES.accounted.firstVerified,publicUrl:receipt.publicUrl,batch5:taskState(intent,acceptedStage,receipt),linkRel:verification.rel,submittedAt:intent.createdAt}:{status:'review',message:BATCH5_ADAPTER_MESSAGES.accounted.awaitingPublic,publicUrl:receipt.publicUrl,batch5:saved,submittedAt:intent.createdAt,...(verification.outcome==='invalid'?{failureKind:'verification_failed' as const}:{})};
}
