import {randomUUID} from 'node:crypto';
import {load} from 'cheerio';
import {articleReviewStillValid} from '../main/article-review';
import type {Account,ExecutionResult,LinkResult,Task} from '../shared/types';
import type {Batch5Dependencies,Batch5Intent,Batch5OpaqueResponse,Batch5TaskState} from './batch5-contract';
import {batch5State,connectedDependencies,connectedRequest,hashBatch5,parseConnectedJson,persistBatch5Receipt,persistBatch5Response,stateFromIntent,type ConnectedContext} from './batch5-connected';
import {renderShareYourHtmlArticle} from './shareyourhtml-article';

export const DROPDEPLOY_API='https://app.ddploy.com/api';
const CHANNEL='dropdeploy',KEY=/^[A-Za-z0-9_-]{16,512}$/,SLUG=/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const ROBOTS='User-agent: *\nAllow: /\n';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const noindex=(value:string)=>/(?:^|[:,\s])(?:noindex|none)(?=$|[,;\s])/i.test(value);
const unknown=(message:string):ExecutionResult=>({status:'review',reasonCode:'submission_unknown',message});
export interface DropDeployCredential {version:1;apiKey:string}
interface Document {title:string;html:string;target:string;rel:string;bytes:number;request:string;contentType:string;sourceHash:string;requestHash:string}
interface Published {slug:string;url:string;rawResponse:string}
export function parseDropDeployCredential(raw:string|undefined):DropDeployCredential|undefined {
 try{const v:unknown=JSON.parse(raw??'null');if(object(v)&&v.version===1&&typeof v.apiKey==='string'&&KEY.test(v.apiKey))return {version:1,apiKey:v.apiKey}}catch{/* untrusted credential */}
}
/** Authentication proves this key can read its account. The username is a local fingerprint. */
export function dropDeployKeyIdentity(apiKey:string):string{if(!KEY.test(apiKey))throw Error('dropdeploy_key_invalid');return `dropdeploy-key:${hashBatch5(apiKey)}`}
const auth=(secret:DropDeployCredential):HeadersInit=>({authorization:`Bearer ${secret.apiKey}`,accept:'application/json'});
function account(context:ConnectedContext,secret?:DropDeployCredential):Account|undefined {
 const a=context.getAccount();return a?.channelId===CHANNEL&&a.id===context.task.accountId&&a.status==='registered'&&!a.retiredAt&&a.hasPassword&&a.credentialKind==='api_token'
  &&a.email===''&&/^dropdeploy-key:[a-f0-9]{64}$/.test(a.username)&&(!secret||a.username===dropDeployKeyIdentity(secret.apiKey))?a:undefined;
}
async function ownerSites(secret:DropDeployCredential,deps:Batch5Dependencies,signal:AbortSignal):Promise<Record<string,unknown>[]>{
 if(!parseDropDeployCredential(JSON.stringify(secret)))throw Error('dropdeploy_credential_invalid');
 const r=await connectedRequest(DROPDEPLOY_API+'/sites',{method:'GET',headers:auth(secret)},deps,signal,1_000_000),v=parseConnectedJson(r);
 if(r.status!==200||!Array.isArray(v?.sites)||v.sites.length>1000||v.sites.some(s=>!object(s)||typeof s.slug!=='string'||!SLUG.test(s.slug)))throw Error('dropdeploy_owner_sites_unproven');
 return v.sites as Record<string,unknown>[];
}
export async function probeDropDeployFreeAccount(secret:DropDeployCredential,deps:Batch5Dependencies={},signal:AbortSignal=new AbortController().signal,uploadBytes=0):Promise<{authenticated:true;identitySource:'local_key_fingerprint';username:string;tier:'free';totalSites:number;storedBytes:number;remainingBytes:number}>{
 if(!parseDropDeployCredential(JSON.stringify(secret))||!integer(uploadBytes))throw Error('dropdeploy_credential_or_size_invalid');
 const r=await connectedRequest(DROPDEPLOY_API+'/stats',{method:'GET',headers:auth(secret)},deps,signal,64_000),v=parseConnectedJson(r);
 if(r.status!==200||v?.tier!=='free'||!object(v.limits)||v.limits.sites!==3||v.limits.storage_per_site!==10*1024*1024||v.limits.total_storage!==50*1024*1024
  ||!integer(v.total_sites)||!integer(v.active_sites)||!integer(v.total_size)||Number(v.active_sites)>Number(v.total_sites)
  ||Number(v.total_sites)>=3||Number(v.total_size)+uploadBytes>Number(v.limits.total_storage)||uploadBytes>Number(v.limits.storage_per_site))throw Error('dropdeploy_free_capacity_unproven');
 const sites=await ownerSites(secret,deps,signal);if(sites.length!==v.total_sites)throw Error('dropdeploy_owner_count_changed');
 return {authenticated:true,identitySource:'local_key_fingerprint',username:dropDeployKeyIdentity(secret.apiKey),tier:'free',totalSites:sites.length,storedBytes:Number(v.total_size),remainingBytes:Number(v.limits.total_storage)-Number(v.total_size)};
}
export function dropDeployDocument(context:ConnectedContext):Document {
 const a=account(context),draft=context.task.draft;if(!a||!draft||!context.task.topicUrl||context.site.category!=='software')throw Error('dropdeploy_document_invalid');
 const target=new URL(context.task.topicUrl),home=new URL(context.site.url);if(home.protocol!=='https:'||target.protocol!=='https:'||home.hostname!==target.hostname||target.username||target.password||target.hash)throw Error('dropdeploy_target_invalid');
 const title=draft.title.trim();if(!title||title.length>200||/[\r\n]/.test(title))throw Error('dropdeploy_title_invalid');
 const {html}=renderShareYourHtmlArticle({draft,targetUrl:target.href,language:context.site.language,slug:'dropdeploy-docs'}),$=load(html),links=$('a[href]');
 if(links.length!==1||links.attr('href')!==target.href)throw Error('dropdeploy_single_target_required');
 const sourceHash=hashBatch5(JSON.stringify({taskId:context.task.id,siteId:context.site.id,accountId:a.id,keyIdentity:a.username,html,target:target.href}));
 const boundary='----dropdeploy-'+sourceHash.slice(0,32),files=[{name:'index.html',content:html},{name:'robots.txt',content:ROBOTS}];
 if(files.some(f=>f.content.includes(boundary))||title.includes(boundary))throw Error('dropdeploy_multipart_boundary');
 // The official MCP submits repeated files + optional name. No paid slug/password options.
 const request=files.map(f=>`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n${f.content}\r\n`).join('')
  +`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${title}\r\n--${boundary}--\r\n`;
 if(Buffer.byteLength(request)>200_000)throw Error('dropdeploy_document_too_large');
 return {title,html,target:target.href,rel:links.attr('rel')??'',bytes:files.reduce((n,f)=>n+Buffer.byteLength(f.content),0),request,contentType:`multipart/form-data; boundary=${boundary}`,sourceHash,requestHash:hashBatch5(request)};
}
export function dropDeployPublicUrl(slug:unknown):string|undefined {
 return typeof slug==='string'&&SLUG.test(slug)&&!['app','www','api','mcp','admin','mail','cdn','static'].includes(slug)?`https://${slug}.ddploy.com/`:undefined;
}
function permanent(value:Record<string,unknown>):boolean {
 return !('claim_token'in value)&&!('claimToken'in value)&&!('claimUrl'in value)&&!('expires_in'in value)&&!('expiresIn'in value)
  &&['expires_at','expiresAt','deactivates_at'].every(k=>!(k in value)||value[k]===null)&&(!('anonymous'in value)||value.anonymous===false);
}
function published(v:unknown,doc:Document,rawResponse:string):Published|undefined {
 if(!object(v)||!permanent(v)||v.file_count!==2||v.size!==doc.bytes||v.has_password!==false)return;
 const url=dropDeployPublicUrl(v.slug);if(!url||'url'in v&&v.url!==url&&v.url!==url.slice(0,-1))return;
 return {slug:v.slug as string,url,rawResponse};
}
export function dropDeployOriginalReceipt(value:Batch5OpaqueResponse|undefined,intent:Batch5Intent,doc:Document):Published|undefined {
 if(!value||![200,201].includes(value.status)||value.responseUrl!==DROPDEPLOY_API+'/sites'||!value.bodyComplete||!/^application\/json\b/i.test(value.contentType)
  ||JSON.stringify(value.intent)!==JSON.stringify(intent)||value.bodyBase64.length>100_000)return;
 try{const b=Buffer.from(value.bodyBase64,'base64');if(b.toString('base64')!==value.bodyBase64)return;const raw=new TextDecoder('utf-8',{fatal:true}).decode(b);return published(JSON.parse(raw),doc,raw)}catch{return}
}
function owned(value:Record<string,unknown>,entry:Published,doc:Document,intent:Batch5Intent,now:number):boolean {
 const updated=typeof value.updated_at==='string'?Date.parse(value.updated_at):NaN;
 return value.slug===entry.slug&&value.name===doc.title&&value.file_count===2&&value.size===doc.bytes&&value.has_password===false&&value.active===true
  &&value.deactivates_at===null&&permanent(value)&&(!('url'in value)||value.url===entry.url||value.url===entry.url.slice(0,-1))
  &&Number.isFinite(updated)&&updated>=Date.parse(intent.createdAt)-60_000&&updated<=now+60_000;
}
async function publicAccepted(entry:Published,doc:Document,deps:Batch5Dependencies,signal:AbortSignal,body:string):Promise<boolean>{
 const page=await connectedRequest(entry.url,{method:'GET',headers:{accept:'text/html'}},deps,signal,750_000);
 if(page.status!==200||!/^text\/html\b/i.test(page.contentType)||noindex(page.robotsHeader))return false;
 const $=load(page.body),original=load(doc.html),main=$('main'),expected=original('main');
 if(main.length!==1||expected.length!==1||main.html()!==expected.html()||$('iframe,frame,base').length
  ||$('meta[http-equiv]').toArray().some(e=>($(e).attr('http-equiv')??'').toLowerCase()==='refresh')
  ||$('meta[name]').toArray().some(e=>/^(?:robots|googlebot|bingbot)$/i.test($(e).attr('name')??'')&&noindex($(e).attr('content')??''))
  ||$('link[rel~="canonical"]').toArray().some(e=>$(e).attr('href')!==entry.url))return false;
 const links=$('a[href]').toArray().filter(e=>$(e).attr('href')===doc.target);if(links.length!==1||($(links[0]).attr('rel')??'')!==doc.rel)return false;
 const robots=await connectedRequest(entry.url+'robots.txt',{method:'GET',headers:{accept:'text/plain'}},deps,signal,4096);
 if(robots.status!==200||!/^text\/plain\b/i.test(robots.contentType)||robots.body.replace(/\r\n/g,'\n')!==ROBOTS||!deps.renderPage)return false;
 const proof=await deps.renderPage(entry.url,doc.target,doc.title,body,signal);return proof.found&&proof.indexable&&proof.rel===doc.rel;
}
export async function reconcileDropDeployTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<{status:'found';publicUrl:string;rel:string;batch5:Batch5TaskState}|{status:'unknown'}>{
 try{const p=context.batch5Persistence,owner=account(context);if(!p||!owner)return {status:'unknown'};
  const secret=parseDropDeployCredential(await context.secrets.get(`account:${owner.id}`));if(!secret||!account(context,secret))return {status:'unknown'};
  const intent=await p.loadIntent();if(!intent||intent.channelId!==CHANNEL||intent.siteId!==context.site.id)return {status:'unknown'};
  const doc=dropDeployDocument(context);if(doc.sourceHash!==intent.sourceHash||doc.requestHash!==intent.requestHash)return {status:'unknown'};
  const entry=dropDeployOriginalReceipt(await p.loadOpaqueResponse(),intent,doc);if(!entry)return {status:'unknown'};
  const receipt=await p.loadReceipt();if(receipt&&(JSON.stringify(receipt.intent)!==JSON.stringify(intent)||receipt.publicUrl!==entry.url||receipt.remoteId!==entry.slug||receipt.rawResponse!==entry.rawResponse))return {status:'unknown'};
  const deps=connectedDependencies(context,overrides),sites=await ownerSites(secret,deps,context.signal),matching=sites.filter(v=>v.slug===entry.slug);
  if(matching.length!==1||!owned(matching[0],entry,doc,intent,(deps.now?.()??new Date()).getTime())||!await publicAccepted(entry,doc,deps,context.signal,context.task.draft!.body))return {status:'unknown'};
  const state=await persistBatch5Receipt(context,receipt??{version:1,intent,publicUrl:entry.url,remoteId:entry.slug,rawResponse:entry.rawResponse},owner.id,entry.slug);
  return {status:'found',publicUrl:entry.url,rel:doc.rel,batch5:state};
 }catch{return {status:'unknown'}}
}
export async function runDropDeployTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<ExecutionResult>{
 if(context.channel.id!==CHANNEL||context.task.channelId!==CHANNEL||context.task.siteId!==context.site.id||!context.channel.enabled||context.channel.automation!=='api')return {status:'needs_input',message:'DropDeploy 平台或任务账号无效'};
 const p=context.batch5Persistence,owner=account(context);if(!p?.reserveIntent||!p.markSending||!p.assertReadyToSubmit||!owner)return {status:'needs_input',message:'DropDeploy 缺少账号或持久化写前闸'};
 if(await p.loadIntent()||batch5State(context)||context.task.submittedAt||context.task.publicUrl){const found=await reconcileDropDeployTask(context,overrides);return found.status==='found'?{status:'review',publicUrl:found.publicUrl,batch5:found.batch5,message:'DropDeploy 原所属站点和公开原文已只读核对'}:unknown('DropDeploy 原事务待核对，不重复 POST')}
 const secret=parseDropDeployCredential(await context.secrets.get(`account:${owner.id}`));if(!secret||!account(context,secret))return {status:'needs_input',message:'DropDeploy 本地密钥指纹不符'};
 const deps=connectedDependencies(context,overrides);let doc:Document;
 const reviewValid=()=>context.task.articleReview?.bindingVersion===2&&context.task.articleReview.reviewContractVersion===5&&articleReviewStillValid(context.task,context.site,context.channel,context.settings,context.getAccount(),context.getArticlePublicationContext?.());
 try{if(!reviewValid())throw Error('review');doc=dropDeployDocument(context);await probeDropDeployFreeAccount(secret,deps,context.signal,doc.bytes)}
 catch{return {status:'needs_input',message:'DropDeploy 当前 V5 原稿审核、Free 账号或容量尚未满足'}}
 const intent:Batch5Intent={version:1,channelId:CHANNEL,operationId:randomUUID(),siteId:context.site.id,sourceHash:doc.sourceHash,requestHash:doc.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};
 try{await p.reserveIntent(intent);context.checkpoint({batch5:stateFromIntent(intent,'reserved',owner.id),checkpoint:'batch5_reserved'} as Partial<Task>);
  await p.assertReadyToSubmit(intent);await p.markSending(intent);context.checkpoint({batch5:stateFromIntent(intent,'submitting',owner.id),checkpoint:'batch5_submitting',submittedAt:intent.createdAt} as Partial<Task>);
  const current=parseDropDeployCredential(await context.secrets.get(`account:${owner.id}`)),currentDoc=dropDeployDocument(context);
  if(!current||JSON.stringify(current)!==JSON.stringify(secret)||!account(context,current)||!reviewValid()||currentDoc.requestHash!==intent.requestHash||currentDoc.sourceHash!==intent.sourceHash)throw Error('late_change');
  await p.assertReadyToSubmit(intent);
 }catch{return unknown('DropDeploy 写前权限或原稿变化；保留意图，后续只读对账')}
 try{const response=await connectedRequest(DROPDEPLOY_API+'/sites',{method:'POST',headers:{...auth(secret),'content-type':doc.contentType},body:doc.request},deps,context.signal,75_000);await persistBatch5Response(p,intent,response);
  if(response.status===429)return {status:'failed',reasonCode:'platform_rate_limited',message:'DropDeploy 请求配额受限，原请求不重发'};
  if(response.status>=400&&response.status<500&&response.status!==408)return {status:'failed',reasonCode:'platform_rejected',message:'DropDeploy 拒绝发布，原请求不重发'};
  const entry=[200,201].includes(response.status)?published(parseConnectedJson(response),doc,response.body):undefined;if(!entry)return unknown('DropDeploy 创建响应不明，不重发');
  const state=await persistBatch5Receipt(context,{version:1,intent,publicUrl:entry.url,remoteId:entry.slug,rawResponse:entry.rawResponse},owner.id,entry.slug);
  return {status:'review',publicUrl:entry.url,batch5:state,message:'DropDeploy 原收据已加密保存，待所属站点、原文和公开页核对'};
 }catch{return unknown('DropDeploy 发布响应不明，保留原事务，不重发')}
}
export async function verifyDropDeployPublication(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<LinkResult>{
 const found=await reconcileDropDeployTask(context,overrides);return found.status==='found'?{found:true,outcome:'found',url:found.publicUrl,rel:found.rel,indexable:true,reason:'原收据、所属站点、无到期无密码、原生原文链接及 robots 已核对；不保证搜索收录或服务存续'}
  :{found:false,outcome:'unreachable',url:context.task.publicUrl??'https://www.ddploy.com/',rel:'',reason:'DropDeploy 原事务或匿名公开页尚未通过核对'};
}
