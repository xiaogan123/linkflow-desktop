import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import {articleReviewStillValid} from '../main/article-review';
import type {Account,ArticlePublicationContext,Channel,ExecutionContext,ExecutionResult,LinkResult,Settings,Site,Task} from '../shared/types';
import {connectedRequest,noIndex,parseConnectedJson,type ConnectedResponse} from './batch5-connected';
import {renderShareYourHtmlArticle} from './shareyourhtml-article';

export const HOST0_API='https://host0.ai/api/v1';
const ROBOTS='User-agent: *\nAllow: /\n';
const KEY=/^h0_[^\s\u0000-\u001f\u007f]{12,512}$/;
const ID=/^[A-Za-z0-9_-]{6,128}$/;
const SHA=/^[a-f0-9]{64}$/;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const json=(response:ConnectedResponse)=>parseConnectedJson(response);
const unknown=(message:string):ExecutionResult=>({status:'review',reasonCode:'submission_unknown',message});
const publicUrl=(slug:string)=>`https://${slug}.host0.app/`;
export type Host0Step='create_app'|'create_deployment'|'upload_index'|'upload_robots'|'finalize'|'publicize';
export interface Host0Intent {version:1;taskId:string;siteId:string;accountId:string;slug:string;name:string;email:string;sourceHash:string;requestHash:string;createdAt:string}
export interface Host0JournalSnapshot {intent:Host0Intent;steps:Partial<Record<Host0Step,{stage:'sending'|'response';response?:ConnectedResponse}>>}
/** Backed by one encrypted, compare-and-swap journal. A response is stored in full before its body is parsed. */
export interface Host0Journal {
  load():Promise<Host0JournalSnapshot|undefined>;
  reserve(intent:Host0Intent):Promise<void>;
  arm(intent:Host0Intent,step:Host0Step):Promise<void>;
  saveResponse(intent:Host0Intent,step:Host0Step,response:ConnectedResponse):Promise<void>;
  markAccepted?(intent:Host0Intent,url:string):Promise<void>;
}
export interface Host0Dependencies {
  site:Site;channel:Channel;task:Task;account:Account;settings:Settings;publicationContext:ArticlePublicationContext;
  apiKey:string;signal:AbortSignal;fetch:(url:string,init:RequestInit)=>Promise<Response>;journal:Host0Journal;
  /** Must re-read live task, account, review, trial and user settings immediately before each remote write. */
  assertAuthorized:(intent:Host0Intent,step:Host0Step)=>void|Promise<void>;
  now?:()=>Date;
}
interface Host0Document {html:string;target:string;files:readonly {path:'index.html'|'robots.txt';bytes:Buffer;size:number;sha256:string;contentType:string}[];sourceHash:string;requestHash:string}

export function host0ReservedSlug(taskId:string):string{
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(taskId))throw Error('host0_task_id_invalid');
  return `software-doc-${taskId.replaceAll('-','').toLowerCase().slice(0,24)}`;
}
export function host0Document(site:Site,task:Task):Host0Document{
  if(site.category!=='software'||!task.draft||!task.topicUrl||!/(?:\bAI[- ](?:assisted|authored|written|author|assistant)\b|\b(?:written|authored) by (?:an? )?AI\b|AI[ -]?辅助(?:代理|助手|撰写)|由[\s\S]{0,16}AI[ -]?辅助(?:代理|助手)?(?:撰写|完成))/i.test(task.draft.body))throw Error('host0_original_software_document_required');
  const source=new URL(site.url),target=new URL(task.topicUrl);
  if(source.protocol!=='https:'||target.protocol!=='https:'||source.hostname!==target.hostname||target.hash)throw Error('host0_target_invalid');
  const rendered=renderShareYourHtmlArticle({draft:task.draft,targetUrl:target.href,language:site.language,slug:'host0-docs'});
  const $=load(rendered.html);
  if($('a[href]').filter((_index,element)=>$(element).attr('href')===target.href).length!==1)throw Error('host0_target_count');
  const files=[{path:'index.html' as const,bytes:Buffer.from(rendered.html),contentType:'text/html; charset=utf-8'},
    {path:'robots.txt' as const,bytes:Buffer.from(ROBOTS),contentType:'text/plain; charset=utf-8'}].map(file=>({...file,size:file.bytes.length,sha256:hash(file.bytes)}));
  return {html:rendered.html,target:target.href,files,sourceHash:hash(rendered.html),requestHash:hash(JSON.stringify(files.map(({path,size,sha256})=>({path,size,sha256}))))};
}
function headers(key:string):HeadersInit {if(!KEY.test(key))throw Error('host0_key_invalid');return {accept:'application/json',authorization:`Bearer ${key}`}}
function transport(deps:Host0Dependencies){return {fetch:deps.fetch};}
async function get(deps:Host0Dependencies,path:string,max=64_000):Promise<ConnectedResponse>{return connectedRequest(path,{method:'GET',headers:headers(deps.apiKey)},transport(deps),deps.signal,max)}
function app(value:unknown,expected:Host0Intent,requireOwner=true):{id:string;url:string;visibility:string}|undefined{
  if(!object(value))return;
  const id=value.id??value.app_id;
  if(typeof id!=='string'||!ID.test(id)||value.slug!==expected.slug||value.name!==expected.name
    ||requireOwner&&value.owner_email!==expected.email||!['private','link','public'].includes(String(value.visibility)))return;
  if(value.url!==undefined&&value.url!==publicUrl(expected.slug)&&value.url!==publicUrl(expected.slug).slice(0,-1))return;
  return {id,url:publicUrl(expected.slug),visibility:String(value.visibility)};
}
function appId(value:unknown):string|undefined {const id=object(value)?value.app_id??value.id:undefined;return typeof id==='string'&&ID.test(id)?id:undefined}
function deploymentId(value:unknown):string|undefined {const id=object(value)?value.deployment_id??value.id:undefined;return typeof id==='string'&&ID.test(id)?id:undefined}
function responseOf(snapshot:Host0JournalSnapshot,step:Host0Step):ConnectedResponse|undefined{return snapshot.steps[step]?.stage==='response'?snapshot.steps[step]?.response:undefined}
function blocked(response:ConnectedResponse){
  if(noIndex(response)||/(?:^|[:,\s])(?:none|noindex)(?=$|[,\s])/i.test(response.robotsHeader))return true;
  const $=load(response.body);
  return $('meta[name]').toArray().some(node=>/^(?:robots|googlebot|bingbot)$/i.test($(node).attr('name')??'')
    &&/(?:^|[,\s])(?:none|noindex)(?=$|[,\s])/i.test($(node).attr('content')??''));
}
async function acceptedPublic(deps:Host0Dependencies,url:string,doc:Host0Document,appId:string):Promise<boolean>{
  const original=await get(deps,`${HOST0_API}/apps/${appId}/files/index.html`,220_000);
  if(original.status!==200||hash(original.body)!==doc.sourceHash||original.body!==doc.html)return false;
  const page=await connectedRequest(url,{method:'GET',headers:{accept:'text/html'}},transport(deps),deps.signal,220_000);
  if(page.status!==200||!/^text\/html\b/i.test(page.contentType)||blocked(page))return false;
  const expected=load(doc.html),actual=load(page.body),expectedMain=expected('main'),actualMain=actual('main');
  if(expectedMain.length!==1||actualMain.length!==1||actualMain.html()!==expectedMain.html()
    ||actual('a[href]').filter((_i,element)=>actual(element).attr('href')===doc.target).length!==1
    ||actual('iframe,frame,base,meta[http-equiv="refresh"]').length>0
    ||actual('script').toArray().some(element=>{const src=actual(element).attr('src');if(!src||actual(element).text().trim())return true;
      try{const parsed=new URL(src,url);if(parsed.origin===new URL(url).origin)return false;
        return src!=='https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092'
          ||actual(element).attr('integrity')!=='sha512-UKNk8GbxkABxKcXYuLkO16EleLGUkcvJWtpSNmExE0Too3ZaFAxTscNWEc1OdAv5/BikHawapSCaiD2XCmp+Bw=='
          ||actual(element).attr('type')!=='module'||actual(element).attr('crossorigin')!=='anonymous';}catch{return true}}))return false;
  const robots=await connectedRequest(new URL('/robots.txt',url).href,{method:'GET'},transport(deps),deps.signal,1024);
  // A noindex header on robots.txt applies to that file, not the HTML page.
  // host0 serves an equivalent empty Disallow policy instead of the uploaded Allow.
  return robots.status===200&&[ROBOTS,'User-agent: *\nDisallow:\n'].includes(robots.body.replace(/\r\n/g,'\n'));
}
export async function probeHost0FreeAccount(deps:Pick<Host0Dependencies,'apiKey'|'signal'|'fetch'>,email?:string,totalBytes=0):Promise<{email:string;maxApps:number;publicSlots:number}>{
  const response=await connectedRequest(`${HOST0_API}/account`,{method:'GET',headers:headers(deps.apiKey)},{fetch:deps.fetch},deps.signal,64_000),value=json(response);
  if(response.status!==200||!value||typeof value.email!=='string'||!/^\S+@\S+\.\S+$/.test(value.email)||(email!==undefined&&value.email!==email)||!object(value.plan)||value.plan.id!=='free'||!object(value.limits)||!object(value.limits.account)||!object(value.limits.upload)||!object(value.usage))throw Error('host0_free_account_unproven');
  const a=value.limits.account,u=value.usage,upload=value.limits.upload;
  if(!Number.isSafeInteger(a.max_apps)||Number(a.max_apps)<1||!Number.isSafeInteger(a.max_public_apps)||Number(a.max_public_apps)<1
    ||!Number.isSafeInteger(u.public_apps)||Number(u.public_apps)<0||!Number.isSafeInteger(u.max_public_apps)||u.max_public_apps!==a.max_public_apps
    ||!Number.isSafeInteger(u.stored_bytes)||Number(u.stored_bytes)<0||!Number.isSafeInteger(u.storage_quota_bytes)||Number(u.storage_quota_bytes)<1
    ||u.over_visit_limit!==false||!Number.isSafeInteger(upload.max_files)||Number(upload.max_files)<2
    ||!Number.isSafeInteger(upload.max_file_bytes)||Number(upload.max_file_bytes)<1||!Number.isSafeInteger(upload.max_total_bytes)||Number(upload.max_total_bytes)<1
    ||Number(u.public_apps)>=Number(a.max_public_apps)||Number(u.stored_bytes)+totalBytes>Number(u.storage_quota_bytes)
    ||totalBytes>Number(upload.max_total_bytes)||totalBytes>2*Number(upload.max_file_bytes))throw Error('host0_free_capacity_unproven');
  return {email:value.email as string,maxApps:Number(a.max_apps),publicSlots:Number(a.max_public_apps)-Number(u.public_apps)};
}
async function preflight(deps:Host0Dependencies,intent:Host0Intent,doc:Host0Document):Promise<void>{
  const free=await probeHost0FreeAccount(deps,intent.email,doc.files.reduce((sum,file)=>sum+file.size,0));
  const apps=await get(deps,`${HOST0_API}/apps`,128_000),parsed=apps.status===200?JSON.parse(apps.body) as unknown:undefined;
  const list=Array.isArray(parsed)?parsed:object(parsed)&&Array.isArray(parsed.apps)?parsed.apps:undefined;
  if(!list||list.length>=free.maxApps||list.some(value=>object(value)&&value.slug===intent.slug))throw Error('host0_app_capacity_or_collision');
  const slug=await get(deps,`${HOST0_API}/slugs/${intent.slug}`),available=json(slug);
  if(slug.status!==200||available?.slug!==intent.slug||available.available!==true)throw Error('host0_slug_unavailable');
  if((await get(deps,`${HOST0_API}/apps/${intent.slug}`)).status!==404)throw Error('host0_app_already_exists');
}
async function write(deps:Host0Dependencies,intent:Host0Intent,step:Host0Step,url:string,init:RequestInit):Promise<ConnectedResponse>{
  await deps.journal.arm(intent,step);
  const current=correctIdentity(deps);
  if(intent.taskId!==deps.task.id||intent.siteId!==deps.site.id||intent.accountId!==deps.account.id||intent.email!==deps.account.email
    ||intent.name!==deps.task.draft?.title.slice(0,100)||intent.slug!==host0ReservedSlug(deps.task.id)
    ||intent.sourceHash!==current.sourceHash||intent.requestHash!==current.requestHash)throw Error('host0_frozen_identity_changed');
  await deps.assertAuthorized(intent,step);
  const response=await connectedRequest(url,init,transport(deps),deps.signal,128_000);
  await deps.journal.saveResponse(intent,step,response);
  return response;
}
function correctIdentity(deps:Host0Dependencies):Host0Document{
  if(deps.channel.id!=='host0'||deps.task.channelId!=='host0'||deps.channel.enabled!==true||deps.channel.automation!=='api'
    ||deps.account.channelId!=='host0'||deps.task.accountId!==deps.account.id||deps.account.status!=='registered'
    ||!deps.account.hasPassword||deps.account.credentialKind!=='api_token'||deps.account.username!==deps.account.email
    ||!/^\S+@\S+\.\S+$/.test(deps.account.email)
    ||!KEY.test(deps.apiKey)||deps.publicationContext.publicationIntent!=='single_original_article'
    ||deps.publicationContext.sameChannelTasks!==1||deps.publicationContext.distinctSites!==1
    ||deps.publicationContext.knownContentPattern!=='unknown'||deps.task.articleReview?.bindingVersion!==2
    ||deps.task.articleReview.reviewContractVersion!==5
    ||!articleReviewStillValid(deps.task,deps.site,deps.channel,deps.settings,deps.account,deps.publicationContext))throw Error('host0_identity_or_review_invalid');
  return host0Document(deps.site,deps.task);
}
/** A prior transaction is read-only. Even a proved successful POST is never replayed from here. */
export async function reconcileHost0Task(deps:Host0Dependencies):Promise<{status:'found';publicUrl:string}|{status:'unknown'}>{
  const snapshot=await deps.journal.load();if(!snapshot)return {status:'unknown'};
  let doc:Host0Document;try{doc=correctIdentity(deps)}catch{return {status:'unknown'}}
  const intent=snapshot.intent;
  if(intent.taskId!==deps.task.id||intent.siteId!==deps.site.id||intent.accountId!==deps.account.id||intent.email!==deps.account.email
    ||intent.slug!==host0ReservedSlug(deps.task.id)||intent.sourceHash!==doc.sourceHash||intent.requestHash!==doc.requestHash)return {status:'unknown'};
  try{const detail=await get(deps,`${HOST0_API}/apps/${intent.slug}`),owned=app(json(detail),intent);
    if(detail.status!==200||!owned||owned.visibility!=='public')return {status:'unknown'};
    const created=responseOf(snapshot,'create_app'),deploy=responseOf(snapshot,'create_deployment'),final=responseOf(snapshot,'finalize'),publicized=responseOf(snapshot,'publicize');
    const deployment=deploy?deploymentId(json(deploy)):undefined,finish=final?json(final):undefined;
    if(!created||!deploy||!final||!publicized||![200,201].includes(created.status)||![200,201].includes(deploy.status)
      ||![200,201].includes(final.status)||![200,201].includes(publicized.status)
      ||appId(json(created))!==owned.id||!deployment||finish?.deployment_id!==deployment
      ||!Number.isSafeInteger(finish.version)||Number(finish.version)<1||finish.previous_version!==null
      ||finish.url!==owned.url&&finish.url!==owned.url.slice(0,-1))return {status:'unknown'};
    return await acceptedPublic(deps,owned.url,doc,owned.id)?{status:'found',publicUrl:owned.url}:{status:'unknown'};
  }catch{return {status:'unknown'}}
}
export async function runHost0Task(deps:Host0Dependencies):Promise<ExecutionResult>{
  let doc:Host0Document;try{doc=correctIdentity(deps)}catch{return {status:'needs_input',message:'host0 原创软件文档、AI 作者披露或单独审核未通过'}}
  if(await deps.journal.load()||deps.task.submittedAt||deps.task.publicUrl){const found=await reconcileHost0Task(deps);return found.status==='found'
    ?{status:'review',publicUrl:found.publicUrl,message:'host0 原公开页已只读核对，待验收'}
    :unknown('host0 原事务状态未确认；只会 GET 核对，不会重发写请求')}
  const slug=host0ReservedSlug(deps.task.id),name=deps.task.draft!.title.slice(0,100),intent:Host0Intent={version:1,taskId:deps.task.id,siteId:deps.site.id,accountId:deps.account.id,slug,name,email:deps.account.email,
    sourceHash:doc.sourceHash,requestHash:doc.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};
  try{await preflight(deps,intent,doc);await deps.journal.reserve(intent)}catch{return {status:'needs_input',message:'host0 Free 配额、预留 slug 或加密意图未通过预检'}}
  const h=headers(deps.apiKey);let created:{id:string;url:string;visibility:string};
  try{
    const response=await write(deps,intent,'create_app',`${HOST0_API}/apps`,{method:'POST',headers:{...h,'content-type':'application/json'},body:JSON.stringify({name,slug})});
    if(![200,201].includes(response.status))throw Error('app_response');
    const id=appId(json(response));if(!id)throw Error('app_id');
    const detail=await get(deps,`${HOST0_API}/apps/${id}`);const value=app(json(detail),intent);
    if(detail.status!==200||!value||value.id!==id||value.visibility!=='private')throw Error('app_readback');created=value;
  }catch{return unknown('host0 建站结果不明；原意图已保留，只读核对，不重复创建')}
  return finishCreatedHost0(deps,intent,doc,created);
}
/** Explicit repair of a proved private app only; never replays creation or any armed deployment step. */
export async function resumeHost0CreatedApp(deps:Host0Dependencies):Promise<ExecutionResult>{
  let doc:Host0Document;try{doc=correctIdentity(deps)}catch{return unknown('host0 原稿或账号已变化')}
  const snapshot=await deps.journal.load(),intent=snapshot?.intent;
  if(!snapshot||!intent||Object.keys(snapshot.steps).length!==1||snapshot.steps.create_app?.stage!=='response'
    ||intent.taskId!==deps.task.id||intent.siteId!==deps.site.id||intent.accountId!==deps.account.id
    ||intent.email!==deps.account.email||intent.name!==deps.task.draft!.title.slice(0,100)||intent.slug!==host0ReservedSlug(deps.task.id)
    ||intent.sourceHash!==doc.sourceHash||intent.requestHash!==doc.requestHash)return unknown('host0 不满足原私有应用继续部署条件');
  const response=responseOf(snapshot,'create_app'),id=response&&appId(json(response));
  if(!response||![200,201].includes(response.status)||response.url!==`${HOST0_API}/apps`||!id)return unknown('host0 原建站收据无效');
  try{const detail=await get(deps,`${HOST0_API}/apps/${id}`),raw=json(detail),owned=app(raw,intent);
    if(detail.status!==200||!owned||owned.id!==id||owned.visibility!=='private'||raw?.live_deployment_id!==null)return unknown('host0 原应用已有部署或账号不匹配');
    return finishCreatedHost0(deps,intent,doc,owned);
  }catch{return unknown('host0 原私有应用读取失败')}
}
async function finishCreatedHost0(deps:Host0Dependencies,intent:Host0Intent,doc:Host0Document,created:{id:string;url:string;visibility:string}):Promise<ExecutionResult>{
  const h=headers(deps.apiKey);let deployment:string;
  try{
    await probeHost0FreeAccount(deps,intent.email,doc.files.reduce((sum,file)=>sum+file.size,0));
    const files=doc.files.map(({path,size,sha256,contentType})=>({path,size,sha256,content_type:contentType}));
    const response=await write(deps,intent,'create_deployment',`${HOST0_API}/apps/${created.id}/deployments`,{method:'POST',headers:{...h,'content-type':'application/json'},body:JSON.stringify({files,message:'Original software documentation'})});
    if(![200,201].includes(response.status))throw Error('deploy_response');
    const id=deploymentId(json(response));if(!id)throw Error('deploy_id');deployment=id;
  }catch{return unknown('host0 部署意图或响应不明；不会重发创建请求')}
  for(const file of doc.files){
    const step:Host0Step=file.path==='index.html'?'upload_index':'upload_robots';
    try{const response=await write(deps,intent,step,`${HOST0_API}/deployments/${deployment}/files/${file.path}`,
      {method:'PUT',headers:{...h,'content-type':file.contentType},body:new Uint8Array(file.bytes)});
      if(![200,201,204].includes(response.status))throw Error('upload_response');
    }catch{return unknown('host0 文件写入结果不明；不会重传，等待只读核对')}
  }
  try{
    const response=await write(deps,intent,'finalize',`${HOST0_API}/deployments/${deployment}/finalize`,{method:'POST',headers:{...h,'content-type':'application/json'},body:'{}'});
    const value=json(response);if(![200,201].includes(response.status)||!value||value.deployment_id!==deployment||!Number.isSafeInteger(value.version)||Number(value.version)<1
      ||value.previous_version!==null||value.url!==created.url&&value.url!==created.url.slice(0,-1))throw Error('finalize_response');
  }catch{return unknown('host0 finalize 结果不明；不会重发，等待只读核对')}
  try{
    const response=await write(deps,intent,'publicize',`${HOST0_API}/apps/${created.id}`,{method:'PATCH',headers:{...h,'content-type':'application/json'},body:JSON.stringify({visibility:'public'})});
    if(![200,201].includes(response.status))throw Error('visibility_response');
    const found=await reconcileHost0Task(deps);
    if(found.status==='found'){
      await deps.journal.markAccepted?.(intent,found.publicUrl);
      return {status:'review',publicUrl:found.publicUrl,message:'host0 单篇原创文档已公开并只读核对，待正式验收'};
    }
    return unknown('host0 公开状态或抓取许可未核实；不计可用外链');
  }catch{return unknown('host0 公开状态写入结果不明；只会 GET 核对')}
}
export async function verifyHost0Publication(deps:Host0Dependencies):Promise<LinkResult>{
  const found=await reconcileHost0Task(deps);return found.status==='found'
    ?{found:true,outcome:'found',url:found.publicUrl,rel:'nofollow ugc noopener noreferrer',indexable:true,reason:'host0 原创文档、原生目标链接和抓取许可已核对'}
    :{found:false,outcome:'unreachable',url:deps.task.publicUrl??'https://host0.ai/',rel:'',reason:'host0 原事务或公开页面尚未通过只读验收'};
}

async function connected(context:ExecutionContext):Promise<Host0Dependencies|undefined>{
  const account=context.getAccount(),publicationContext=context.getArticlePublicationContext?.(),journal=context.host0Journal;
  if(!account||!publicationContext||!journal)return;
  let secret:unknown;try{secret=JSON.parse(await context.secrets.get(`account:${account.id}`)??'null')}catch{return}
  if(!object(secret)||secret.version!==1||typeof secret.apiKey!=='string'||!KEY.test(secret.apiKey)||secret.email!==account.email)return;
  return {site:context.site,channel:context.channel,task:context.task,account,settings:context.settings,publicationContext,
    apiKey:secret.apiKey,signal:context.signal,fetch:context.batch5Dependencies?.fetch??fetch,journal,
    assertAuthorized:context.assertHost0Authorized??(()=>{throw Error('host0_live_authorization_missing')})};
}
export async function runHost0ConnectedTask(context:ExecutionContext):Promise<ExecutionResult>{
  const deps=await connected(context);return deps?runHost0Task(deps):{status:'needs_input',message:'host0 原账号密钥、单篇用途或加密日志未就绪'};
}
export async function reconcileHost0ConnectedTask(context:ExecutionContext):Promise<{status:'found';publicUrl:string;batch5:NonNullable<Task['batch5']>}|{status:'unknown'}>{
  const deps=await connected(context);if(!deps||!context.task.batch5)return {status:'unknown'};
  const result=await reconcileHost0Task(deps);
  return result.status==='found'?{...result,batch5:{...context.task.batch5,stage:'api_receipt',publicUrl:result.publicUrl}}:{status:'unknown'};
}
export async function verifyHost0ConnectedPublication(context:ExecutionContext):Promise<LinkResult>{
  const deps=await connected(context);return deps?verifyHost0Publication(deps):{found:false,outcome:'unreachable',url:context.task.publicUrl??'https://host0.ai/',rel:'',reason:'host0 原加密账号或事务未就绪'};
}
