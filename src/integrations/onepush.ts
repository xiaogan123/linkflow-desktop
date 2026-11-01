import {randomUUID} from 'node:crypto';
import {load} from 'cheerio';
import {articleReviewStillValid} from '../main/article-review';
import type {Account,ExecutionResult,LinkResult,Task} from '../shared/types';
import type {Batch5Dependencies,Batch5Intent,Batch5OpaqueResponse,Batch5Receipt,Batch5TaskState} from './batch5-contract';
import {batch5State,connectedDependencies,connectedRequest,hashBatch5,noIndex,parseConnectedJson,
  persistBatch5Receipt,persistBatch5Response,stateFromIntent,type ConnectedContext} from './batch5-connected';
import {renderShareYourHtmlArticle} from './shareyourhtml-article';

const ORIGIN='https://www.onepu.sh',CHANNEL='onepush';
const KEY=/^sk_[A-Za-z0-9_-]{8,512}$/;
const SLUG=/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const IDENTITY=/^onepush-key:[a-f0-9]{64}$/;
const ROBOTS='User-agent: *\nAllow: /\n';
const MAX_REQUEST=200_000;
const STORAGE='https://bujjdijsowgzgaegrvau.supabase.co/storage/v1/object/public/sites/';
// Exact platform additions observed on the original publication; no DOM rewriting or arbitrary script removal.
const HOST_HEAD="<link rel=\"icon\" type=\"image/svg+xml\" href=\"data:image/svg+xml,%3Csvg width='32' height='32' viewBox='0 0 32 32' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='32' height='32' rx='6' fill='white'/%3E%3Crect x='11' y='11' width='10' height='10' rx='2.5' fill='%2322c55e'/%3E%3C/svg%3E\" />\n\n    <meta property=\"og:title\" content=\"ONEPUSH_SLUG — OnePush\" />\n    <meta property=\"og:description\" content=\"Published with OnePush — instant web hosting\" />\n    <meta property=\"og:url\" content=\"https://onepu.sh/s/ONEPUSH_SLUG\" />\n    <meta property=\"og:type\" content=\"website\" />\n    <meta name=\"twitter:card\" content=\"summary\" />\n  ";
const HOST_TAIL="<script>\n    try {\n      var d = JSON.stringify({\n        slug: 'ONEPUSH_SLUG',\n        path: window.location.pathname,\n        referrer: document.referrer,\n        userAgent: navigator.userAgent\n      });\n      if (navigator.sendBeacon) {\n        navigator.sendBeacon('https://onepu.sh/api/v1/analytics/event', d);\n      } else {\n        fetch('https://onepu.sh/api/v1/analytics/event', {\n          method: 'POST',\n          body: d,\n          keepalive: true\n        }).catch(function(){});\n      }\n    } catch(e) {}\n  </script><div id=\"op-powered\" style=\"position:fixed;bottom:0;left:0;right:0;display:flex;align-items:center;justify-content:center;padding:12px 0;background:rgba(255,255,255,0.92);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-top:1px solid rgba(0,0,0,0.06);z-index:99999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;\"><a href=\"https://onepu.sh?ref=powered-by\" target=\"_blank\" rel=\"noopener\" style=\"display:inline-flex;align-items:center;gap:8px;text-decoration:none;color:#888;font-size:13px;font-weight:500;letter-spacing:0.01em;transition:color 0.2s;\" onmouseover=\"this.style.color='#1a1a1a'\" onmouseout=\"this.style.color='#888'\"><span>Powered by</span><span style=\"font-weight:700;font-size:16px;letter-spacing:-0.4px;color:#1a1a1a;\">onepu<span style=\"color:#22c55e;\">.</span>sh</span></a></div>";
function hostedHtml(html:string,slug:string):string{
  return html.replace('</head>',HOST_HEAD.replaceAll('ONEPUSH_SLUG',slug)+'</head>')
    .replace('</body>',HOST_TAIL.replaceAll('ONEPUSH_SLUG',slug)+'</body>');
}
export interface OnePushCredential {version:1;apiKey:string}
interface Document {html:string;request:string;target:string;rel:string;sourceHash:string;requestHash:string}
interface Published {slug:string;url:string;updateToken:string}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const auth=(apiKey:string):HeadersInit=>({authorization:`Bearer ${apiKey}`,accept:'application/json'});
const unknown=(message:string):ExecutionResult=>({status:'review',reasonCode:'submission_unknown',message});

function credential(raw:string|undefined):OnePushCredential|undefined{
  try{const value:unknown=JSON.parse(raw??'null');if(!object(value)||value.version!==1||typeof value.apiKey!=='string'||!KEY.test(value.apiKey))return;
    return {version:1,apiKey:value.apiKey};}catch{return}
}
/** This is a local key identity, not a remotely verified user ID or email. */
export function onePushKeyIdentity(apiKey:string):string{
  if(!KEY.test(apiKey))throw Error('onepush_key_invalid');
  return `onepush-key:${hashBatch5(apiKey)}`;
}
function account(context:ConnectedContext):Account|undefined{
  const value=context.getAccount();
  return value?.channelId===CHANNEL&&value.id===context.task.accountId&&value.status==='registered'&&value.hasPassword
    &&value.credentialKind==='api_token'&&IDENTITY.test(value.username)?{...value}:undefined;
}
function publicationUrl(value:unknown,slug:unknown):string|undefined{
  if(typeof slug!=='string'||!SLUG.test(slug)||['www','api','dashboard'].includes(slug)||typeof value!=='string'||value!==value.trim())return;
  try{const url=new URL(value);return url.protocol==='https:'&&url.hostname===`${slug}.onepu.sh`&&url.pathname==='/'
    &&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash?url.href:undefined}catch{return}
}
function permanent(value:Record<string,unknown>):boolean{
  return !('claimUrl'in value)&&!('expiresIn'in value)
    &&['expiresAt','expires_at'].every(key=>!(key in value)||value[key]===null);
}
function published(value:Record<string,unknown>|undefined):Published|undefined{
  if(!value||!permanent(value)||'updated'in value&&value.updated!==false||'version'in value&&value.version!==1
    ||typeof value.updateToken!=='string'||!/^[^\s\u0000-\u001f\u007f]{8,2048}$/.test(value.updateToken))return;
  const url=publicationUrl(value.url,value.slug);return url?{slug:value.slug as string,url,updateToken:value.updateToken}:undefined;
}
async function ownerSites(apiKey:string,deps:Batch5Dependencies,signal:AbortSignal):Promise<Record<string,unknown>[]>{
  if(!KEY.test(apiKey))throw Error('onepush_key_invalid');
  const response=await connectedRequest(`${ORIGIN}/api/v1/publish`,{method:'GET',headers:auth(apiKey)},deps,signal,256_000);
  const value=parseConnectedJson(response);
  if(response.status!==200||!Array.isArray(value?.sites)||value.sites.length>10
    ||!value.sites.every(row=>object(row)&&typeof row.slug==='string'&&SLUG.test(row.slug)))throw Error('onepush_owner_sites_unverified');
  return value.sites as Record<string,unknown>[];
}
/** The authenticated owner list proves key acceptance only; OnePush does not document /me. */
export async function probeOnePushConnection(apiKey:string,deps:Batch5Dependencies={},signal:AbortSignal=new AbortController().signal):Promise<{username:string;siteCount:number}>{
  const sites=await ownerSites(apiKey,deps,signal);return {username:onePushKeyIdentity(apiKey),siteCount:sites.length};
}
function document(context:ConnectedContext):Document{
  const owner=account(context),draft=context.task.draft;
  if(!owner||!draft||!context.task.topicUrl||!['software','developer','ai'].includes(context.site.category))throw Error('onepush_document_invalid');
  const target=new URL(context.task.topicUrl),source=new URL(context.site.url);
  if(target.protocol!=='https:'||source.protocol!=='https:'||target.hostname!==source.hostname)throw Error('onepush_target_invalid');
  const rendered=renderShareYourHtmlArticle({draft,targetUrl:target.href,language:context.site.language,slug:'onepush-docs'});
  const $=load(rendered.html),links=$('a[href]');
  if(links.length!==1||links.attr('href')!==target.href)throw Error('onepush_target_count');
  // Omit slug, url, updateToken and baseVersion: this request can only create a fresh site.
  const request=JSON.stringify({files:{'index.html':rendered.html,'robots.txt':ROBOTS},name:draft.title.trim()});
  if(Buffer.byteLength(request,'utf8')>MAX_REQUEST)throw Error('onepush_document_too_large');
  return {html:rendered.html,request,target:target.href,rel:links.attr('rel')??'',
    sourceHash:hashBatch5(JSON.stringify({html:rendered.html,keyIdentity:owner.username})),requestHash:hashBatch5(request)};
}
function exactDocument(context:ConnectedContext,intent:Batch5Intent):Document|undefined{
  if(intent.channelId!==CHANNEL||intent.siteId!==context.site.id)return;
  try{const doc=document(context);return doc.sourceHash===intent.sourceHash&&doc.requestHash===intent.requestHash?doc:undefined}catch{return}
}
function fromOpaque(value:Batch5OpaqueResponse|undefined,intent:Batch5Intent):{entry:Published;rawResponse:string}|undefined{
  if(!value||![200,201].includes(value.status)||value.responseUrl!==`${ORIGIN}/api/v1/push`||!value.bodyComplete
    ||!/^application\/json\b/i.test(value.contentType)||JSON.stringify(value.intent)!==JSON.stringify(intent)
    ||typeof value.bodyBase64!=='string'||value.bodyBase64.length>65_536||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bodyBase64))return;
  const bytes=Buffer.from(value.bodyBase64,'base64');if(bytes.toString('base64')!==value.bodyBase64)return;
  try{const rawResponse=new TextDecoder('utf-8',{fatal:true}).decode(bytes),parsed:unknown=JSON.parse(rawResponse);
    const entry=published(object(parsed)?parsed:undefined);return entry?{entry,rawResponse}:undefined}catch{return}
}
function matchingSite(value:Record<string,unknown>|undefined,entry:Published,owned?:Record<string,unknown>):boolean{
  if(!value||value.slug!==entry.slug||!permanent(value)||value.access_level!=='public'||value.expires_at!==null
    ||value.current_version!==1||('version'in value&&value.version!==1)||('status'in value&&value.status!=='live')
    ||typeof value.id!=='string'||!UUID.test(value.id)||!Array.isArray(value.site_versions)||value.site_versions.length!==1)return false;
  const version=value.site_versions[0];
  if(!object(version)||version.version!==1||typeof version.pushed_by!=='string'||!UUID.test(version.pushed_by))return false;
  if(!owned)return publicationUrl(value.url,entry.slug)===entry.url;
  const ownerVersion=(owned.site_versions as Record<string,unknown>[])[0];
  return value.url==='https://onepu.sh/s/'+entry.slug&&value.id===owned.id&&value.current_version===owned.current_version
    &&value.user_id===ownerVersion.pushed_by&&version.pushed_by===ownerVersion.pushed_by
    &&value.team_id===null&&value.password_hash===null;
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
async function publicRobots(entry:Published,deps:Batch5Dependencies,signal:AbortSignal):Promise<boolean>{
  const url=new URL('/robots.txt',entry.url).href,storage=STORAGE+entry.slug+'/v1/robots.txt';
  let location:string|null=null;
  const response=await connectedRequest(url,{method:'GET'},{...deps,fetch:async(target,init)=>{
    const result=await (deps.fetch??fetch)(target,{...init,redirect:'manual'});
    if(result.redirected||result.url&&result.url!==target)throw Error('redirect');
    if(result.status!==302)return result;
    location=result.headers.get('location');
    await result.body?.cancel();
    if(location!==storage)throw Error('robots_redirect_unverified');
    return new Response('',{status:302,headers:{'x-robots-tag':result.headers.get('x-robots-tag')??''}});
  }},signal,1024);
  const final=response.status===302&&location===storage
    ?await connectedRequest(storage,{method:'GET'},deps,signal,1024):response;
  // X-Robots-Tag on robots.txt governs that resource, not indexing of the article.
  return final.status===200&&final.body===ROBOTS;
}
async function acceptedPublic(entry:Published,doc:Document,deps:Batch5Dependencies,signal:AbortSignal):Promise<boolean>{
  const page=await connectedRequest(entry.url,{method:'GET',headers:{accept:'text/html'}},deps,signal,256_000);
  if(page.status!==200||!/^text\/html\b/i.test(page.contentType)||(page.body!==doc.html&&page.body!==hostedHtml(doc.html,entry.slug))||noIndex(page)
    ||/(?:^|[,\s])(?:[a-z0-9_*_-]+\s*:\s*)?(?:none|noindex)(?=$|[,\s])/i.test(page.robotsHeader))return false;
  return publicRobots(entry,deps,signal);
}
export async function reconcileOnePushTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<{status:'found';publicUrl:string;rel:string;batch5:Batch5TaskState}|{status:'unknown'}>{
  try{
    const owner=account(context),persistence=context.batch5Persistence;if(!owner||!persistence)return {status:'unknown'};
    const intent=await persistence.loadIntent();if(!intent)return {status:'unknown'};
    const doc=exactDocument(context,intent),secret=credential(await context.secrets.get(`account:${owner.id}`));
    if(!doc||!secret||onePushKeyIdentity(secret.apiKey)!==owner.username)return {status:'unknown'};
    const receipt=await persistence.loadReceipt();if(receipt&&JSON.stringify(receipt.intent)!==JSON.stringify(intent))return {status:'unknown'};
    let original:{entry:Published;rawResponse:string}|undefined;
    if(receipt){
      const parsed:unknown=JSON.parse(receipt.rawResponse),entry=published(object(parsed)?parsed:undefined);
      if(!entry||entry.slug!==receipt.remoteId||entry.url!==receipt.publicUrl||receipt.secret!==entry.updateToken)return {status:'unknown'};
      original={entry,rawResponse:receipt.rawResponse};
    }else original=fromOpaque(await persistence.loadOpaqueResponse(),intent);
    if(!original)return {status:'unknown'};
    const {entry}=original,deps=connectedDependencies(context,overrides),sites=await ownerSites(secret.apiKey,deps,context.signal);
    const owned=sites.filter(value=>value.slug===entry.slug);
    if(owned.length!==1||!matchingSite(owned[0],entry))return {status:'unknown'};
    const detail=await connectedRequest(`${ORIGIN}/api/v1/publish/${entry.slug}`,{method:'GET',headers:{accept:'application/json'}},deps,context.signal,64_000);
    if(detail.status!==200||!matchingSite(parseConnectedJson(detail),entry,owned[0])||!await acceptedPublic(entry,doc,deps,context.signal))return {status:'unknown'};
    const state=await persistBatch5Receipt(context,receipt??{version:1,intent,publicUrl:entry.url,remoteId:entry.slug,rawResponse:original.rawResponse,secret:entry.updateToken},owner.id,entry.slug);
    return {status:'found',publicUrl:entry.url,rel:doc.rel,batch5:state};
  }catch{return {status:'unknown'}}
}
export async function runOnePushTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<ExecutionResult>{
  if(context.channel.id!==CHANNEL||context.task.channelId!==CHANNEL||context.channel.automation!=='api')return {status:'needs_input',message:'OnePush 任务类型无效'};
  const owner=account(context),persistence=context.batch5Persistence;
  if(!owner||!persistence?.reserveIntent||!persistence.markSending||!persistence.assertReadyToSubmit)return {status:'needs_input',message:'OnePush 缺少专用 key 绑定或持久化写前闸'};
  if(await persistence.loadIntent()||batch5State(context)||context.task.submittedAt||context.task.publicUrl){
    const found=await reconcileOnePushTask(context,overrides);
    return found.status==='found'?{status:'review',message:'OnePush 原事务已只读核对',publicUrl:found.publicUrl,batch5:found.batch5}:unknown('OnePush 原发布结果不明；不会再次 POST');
  }
  const secret=credential(await context.secrets.get(`account:${owner.id}`));
  if(!secret||onePushKeyIdentity(secret.apiKey)!==owner.username)return {status:'needs_input',message:'OnePush 专用 key 指纹与本地账号不符'};
  const deps=connectedDependencies(context,overrides);
  try{const probe=await probeOnePushConnection(secret.apiKey,deps,context.signal);if(probe.siteCount>=10)throw Error('capacity')}
  catch{return {status:'needs_input',message:'OnePush 认证站点列表或免费站点余额未获确认；未发送发布请求'}}
  let doc:Document;
  try{if(!articleReviewStillValid(context.task,context.site,context.channel,context.settings,owner,context.getArticlePublicationContext?.()))throw Error('review_invalid');doc=document(context)}
  catch{return {status:'needs_input',reasonCode:'format_invalid',message:'OnePush 仅接受当前审核通过、唯一目标链接的软件文档'}}
  const intent:Batch5Intent={version:1,channelId:CHANNEL,operationId:randomUUID(),siteId:context.site.id,sourceHash:doc.sourceHash,requestHash:doc.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};
  try{await persistence.reserveIntent(intent);context.checkpoint({batch5:stateFromIntent(intent,'reserved',owner.id),checkpoint:'batch5_reserved'} as Partial<Task>)}
  catch{return {status:'needs_input',message:'OnePush 加密发布意图未保存'}}
  try{
    await persistence.assertReadyToSubmit(intent);await persistence.markSending(intent);
    context.checkpoint({batch5:stateFromIntent(intent,'submitting',owner.id),checkpoint:'batch5_submitting',submittedAt:intent.createdAt} as Partial<Task>);
    const current=account(context),currentSecret=credential(await context.secrets.get(`account:${owner.id}`));
    if(current?.username!==owner.username||!currentSecret||currentSecret.apiKey!==secret.apiKey||!exactDocument(context,intent)
      ||!articleReviewStillValid(context.task,context.site,context.channel,context.settings,current,context.getArticlePublicationContext?.()))throw Error('review_changed');
  }catch{return unknown('OnePush 写前授权变化；意图已保存，后续只读对账')}
  let response;
  try{response=await connectedRequest(`${ORIGIN}/api/v1/push`,{method:'POST',headers:{...auth(secret.apiKey),'content-type':'application/json'},body:doc.request},deps,context.signal,32_768);
    await persistBatch5Response(persistence,intent,response)}catch{return unknown('OnePush 发布结果不明；不会再次 POST')}
  if(response.status===429)return {status:'failed',reasonCode:'platform_rate_limited',message:'OnePush 发布频率受限；不会重发'};
  if(response.status>=400&&response.status<500&&response.status!==408)return {status:'failed',reasonCode:'platform_rejected',message:'OnePush 拒绝发布；不会重发'};
  if(![200,201].includes(response.status))return unknown('OnePush 发布响应状态不明；不会再次 POST');
  const entry=published(parseConnectedJson(response));if(!entry)return unknown('OnePush 未返回可核对的永久新站收据；不会再次 POST');
  const receipt:Batch5Receipt={version:1,intent,publicUrl:entry.url,remoteId:entry.slug,rawResponse:response.body,secret:entry.updateToken};
  try{const state=await persistBatch5Receipt(context,receipt,owner.id,entry.slug);
    return {status:'review',message:'OnePush 新站收据已加密保存，待所属列表及公开 HTML 验收',publicUrl:entry.url,batch5:state}}
  catch{return unknown('OnePush 收据保存不明；不会再次 POST')}
}
export async function verifyOnePushPublication(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<LinkResult>{
  const found=await reconcileOnePushTask(context,overrides);
  return found.status==='found'?{found:true,outcome:'found',url:found.publicUrl,rel:found.rel,indexable:true,reason:'OnePush 原收据、所属站点、匿名原文及抓取权限已核对'}
    :{found:false,outcome:'unreachable',url:context.task.publicUrl??ORIGIN,rel:'',reason:'OnePush 原事务或公开内容尚未通过只读验收'};
}

export const onePushTesting={credential,publicationUrl,document,published,matchingSite,hostedHtml};
