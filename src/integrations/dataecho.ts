import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import {agentboardRobotsAllows} from './agentboard-robots';
import {articleReviewStillValid} from '../main/article-review';
import type {Account,ArticlePublicationContext,Channel,ExecutionContext,ExecutionResult,LinkResult,Settings,Site,Task} from '../shared/types';
import {connectedRequest,parseConnectedJson,type ConnectedResponse} from './batch5-connected';
import {renderShareYourHtmlArticle} from './shareyourhtml-article';

export const DATAECHO_API='https://dataecho.ai/api/v1';
const ROBOTS='User-agent: *\nAllow: /\n';
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const slugPattern=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export type DataEchoStep='create'|'upload_index'|'upload_robots'|'finalize';
export interface DataEchoIntent {version:1;taskId:string;siteId:string;accountId:string;email:string;username:string;name:string;sourceHash:string;requestHash:string;createdAt:string}
export interface DataEchoJournalSnapshot {intent:DataEchoIntent;steps:Partial<Record<DataEchoStep,{stage:'sending'|'response';response?:ConnectedResponse}>>}
export interface DataEchoJournal {
  load():Promise<DataEchoJournalSnapshot|undefined>;
  reserve(intent:DataEchoIntent):Promise<void>;
  arm(intent:DataEchoIntent,step:DataEchoStep):Promise<void>;
  saveResponse(intent:DataEchoIntent,step:DataEchoStep,response:ConnectedResponse):Promise<void>;
  markAccepted?(intent:DataEchoIntent,url:string):Promise<void>;
}
export interface DataEchoDependencies {
  site:Site;task:Task;channel:Channel;account:Account;settings:Settings;publicationContext:ArticlePublicationContext;
  apiKey:string;signal:AbortSignal;fetch:(url:string,init:RequestInit)=>Promise<Response>;journal:DataEchoJournal;
  /** Off until the candidate and its execution path have independent approval. */
  executionEnabled?:boolean;
  /** Re-read live task, account, article review, site pause and user authorization before EACH mutation. */
  assertAuthorized:(intent:DataEchoIntent,step:DataEchoStep)=>void|Promise<void>;
  now?:()=>Date;
}
export interface DataEchoDocument {
  html:string;target:string;sourceHash:string;requestHash:string;request:string;
  files:{path:'index.html'|'robots.txt';size:number;hash:string;contentType:string;bytes:Buffer}[];
}
export interface DataEchoReceipt {slug:string;siteUrl:string;versionId:string;finalizeUrl:string;uploads:{path:'index.html'|'robots.txt';url:string;contentType:string}[]}
export function dataEchoDocument(site:Site,task:Task):DataEchoDocument {
  if(site.category!=='software'||!task.draft||!task.topicUrl
    ||!/(?:\bAI[- ](?:assisted|authored|written|author|assistant)\b|\b(?:written|authored) by (?:an? )?AI\b|AI[ -]?辅助(?:代理|助手|撰写)|由[\s\S]{0,16}AI[ -]?辅助(?:代理|助手)?(?:撰写|完成))/i.test(task.draft.body))throw Error('dataecho_original_software_document_required');
  const source=new URL(site.url),target=new URL(task.topicUrl);
  if(source.protocol!=='https:'||target.protocol!=='https:'||source.hostname!==target.hostname||target.username||target.password||target.hash)throw Error('dataecho_target_invalid');
  const rendered=renderShareYourHtmlArticle({draft:task.draft,targetUrl:target.href,language:site.language,slug:'dataecho-docs'}),$=load(rendered.html);
  if($('a[href]').filter((_i,element)=>$(element).attr('href')===target.href).length!==1)throw Error('dataecho_target_count');
  const files=[{path:'index.html' as const,bytes:Buffer.from(rendered.html),contentType:'text/html; charset=utf-8'},
    {path:'robots.txt' as const,bytes:Buffer.from(ROBOTS),contentType:'text/plain; charset=utf-8'}].map(file=>({...file,size:file.bytes.length,hash:hash(file.bytes)}));
  if(files.some(file=>file.size>200_000))throw Error('dataecho_document_too_large');
  const request=JSON.stringify({files:files.map(({path,size,hash,contentType})=>({path,size,hash,contentType})),spaMode:false,ttlSeconds:null,viewer:{title:task.draft.title.slice(0,100),description:task.draft.description.slice(0,300)}});
  return {html:rendered.html,target:target.href,sourceHash:hash(rendered.html),requestHash:hash(request),request,files};
}
/** Only service storage endpoints, never arbitrary URLs returned by a remote body. No bearer is sent to storage. */
export function dataEchoUploadUrl(value:unknown):value is string {
  if(typeof value!=='string'||value.length>8192)return false;
  try{const u=new URL(value);if(u.origin==='https://dataecho.ai'&&!u.username&&!u.password&&!u.port&&!u.hash&&!u.search&&/^\/upload\/[A-Za-z0-9_-]{31}$/.test(u.pathname))return true;return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash
    &&/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(u.hostname)
    &&u.searchParams.get('X-Amz-Algorithm')==='AWS4-HMAC-SHA256'
    &&/^[a-f0-9]{64}$/.test(u.searchParams.get('X-Amz-Signature')??'')
    &&Number(u.searchParams.get('X-Amz-Expires'))>0&&Number(u.searchParams.get('X-Amz-Expires'))<=3600;
  }catch{return false}
}
export function parseDataEchoCreate(response:ConnectedResponse,doc:DataEchoDocument):DataEchoReceipt|undefined {
  const v=parseConnectedJson(response);
  if(response.status!==201||response.url!==`${DATAECHO_API}/publish`||!v||typeof v.slug!=='string'||!slugPattern.test(v.slug)
    ||v.siteUrl!==`https://${v.slug}.dataecho.ai/`||v.claimToken!==undefined||v.claimUrl!==undefined||v.expiresAt!=null||!object(v.upload))return;
  const upload=v.upload;
  if(typeof upload.versionId!=='string'||!/^[A-Za-z0-9_-]{6,128}$/.test(upload.versionId)
    ||upload.finalizeUrl!==`${DATAECHO_API}/publish/${v.slug}/finalize`||!Array.isArray(upload.uploads)||upload.uploads.length!==2
    ||!Array.isArray(upload.skipped)||upload.skipped.length!==0)return;
  const entries:DataEchoReceipt['uploads']=[];
  for(const file of doc.files){
    const matches=upload.uploads.filter(value=>object(value)&&value.path===file.path);
    if(matches.length!==1)return;const item=matches[0];
    if(!object(item)||item.method!=='PUT'||!dataEchoUploadUrl(item.url)||!object(item.headers)
      ||Object.keys(item.headers).length!==1||item.headers['Content-Type']!==file.contentType)return;
    entries.push({path:file.path,url:item.url,contentType:file.contentType});
  }
  if(new Set(entries.map(entry=>entry.url)).size!==2)return;
  return {slug:v.slug,siteUrl:String(v.siteUrl),versionId:upload.versionId,finalizeUrl:upload.finalizeUrl,uploads:entries};
}
function headers(key:string):Record<string,string>{
  if(!/^[A-Za-z0-9_-]{16,512}$/.test(key))throw Error('dataecho_key_invalid');
  return {accept:'application/json',authorization:`Bearer ${key}`};
}
export async function probeDataEchoConnection(apiKey:string,deps:{fetch?:(url:string,init:RequestInit)=>Promise<Response>}={},signal=new AbortController().signal):Promise<{username:string;profileUrl:string}>{
  const response=await connectedRequest(`${DATAECHO_API}/profile`,{method:'GET',headers:headers(apiKey)},{fetch:deps.fetch??fetch},signal,64_000),value=parseConnectedJson(response);
  if(response.status!==200||!value||typeof value.username!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value.username)
    ||value.profileUrl!==`/@${value.username}`&&value.profileUrl!==`https://dataecho.ai/@${value.username}`)throw Error('dataecho_profile_identity_unconfirmed');
  return {username:value.username,profileUrl:`https://dataecho.ai/@${value.username}`};
}
function identity(deps:DataEchoDependencies):DataEchoDocument {
  const {site,task,channel,account,publicationContext:context}=deps;
  if(channel.id!=='dataecho'||task.channelId!=='dataecho'||account.channelId!=='dataecho'||!channel.enabled||channel.automation!=='api'
    ||task.siteId!==site.id||task.accountId!==account.id||account.status!=='registered'||account.retiredAt||!account.hasPassword
    ||account.credentialKind!=='api_token'||!/^[A-Za-z0-9_-]{1,100}$/.test(account.username)||!/^\S+@\S+\.\S+$/.test(account.email)
    ||context.publicationIntent!=='single_original_article'||context.sameChannelTasks!==1||context.distinctSites!==1||context.knownContentPattern!=='unknown'
    ||task.articleReview?.bindingVersion!==2||task.articleReview.reviewContractVersion!==5
    ||!articleReviewStillValid(task,site,channel,deps.settings,account,context))throw Error('dataecho_identity_or_review_invalid');
  headers(deps.apiKey);return dataEchoDocument(site,task);
}
function sameIntent(deps:DataEchoDependencies,intent:DataEchoIntent,doc:DataEchoDocument):boolean {
  return intent.taskId===deps.task.id&&intent.siteId===deps.site.id&&intent.accountId===deps.account.id&&intent.email===deps.account.email&&intent.username===deps.account.username
    &&intent.name===deps.task.draft!.title.slice(0,100)&&intent.sourceHash===doc.sourceHash&&intent.requestHash===doc.requestHash;
}
const responseAt=(s:DataEchoJournalSnapshot,step:DataEchoStep)=>s.steps[step]?.stage==='response'?s.steps[step]?.response:undefined;
const unknown=():ExecutionResult=>({status:'review',reasonCode:'submission_unknown',message:'DataEcho 原事务状态未确认；保留加密收据，只读核对，不重发写请求'});
async function write(deps:DataEchoDependencies,intent:DataEchoIntent,step:DataEchoStep,url:string,init:RequestInit):Promise<ConnectedResponse>{
  await deps.journal.arm(intent,step);
  if(deps.executionEnabled!==true||!sameIntent(deps,intent,identity(deps)))throw Error('dataecho_frozen_identity_changed');
  await deps.assertAuthorized(intent,step);
  const response=await connectedRequest(url,init,{fetch:deps.fetch},deps.signal,128_000);
  await deps.journal.saveResponse(intent,step,response);return response;
}
/** Only the observed immutable Cloudflare module may differ from the exact generated HTML. */
export function dataEchoPublicHtmlMatches(actual:string,expected:string):boolean{
  if(actual===expected)return true;
  const scripts=[...actual.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi)];if(scripts.length!==1)return false;
  const match=scripts[0],$=load(match[0],null,false),script=$('script');if(script.length!==1||script.text()!=='')return false;
  const attrs=script[0].attribs;
  if(Object.keys(attrs).sort().join(',')!==['type','src','integrity','data-cf-beacon','crossorigin'].sort().join(',')
    ||attrs.type!=='module'||attrs.crossorigin!=='anonymous'
    ||attrs.src!=='https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092'
    ||attrs.integrity!=='sha512-UKNk8GbxkABxKcXYuLkO16EleLGUkcvJWtpSNmExE0Too3ZaFAxTscNWEc1OdAv5/BikHawapSCaiD2XCmp+Bw==')return false;
  let beacon:unknown;try{beacon=JSON.parse(attrs['data-cf-beacon'])}catch{return false}
  if(!object(beacon)||Object.keys(beacon).sort().join(',')!=='r,spa,token,version'||beacon.version!=='2024.11.0'||beacon.r!==1||beacon.spa!==2
    ||typeof beacon.token!=='string'||!/^[a-f0-9]{32}$/.test(beacon.token))return false;
  // The observed module is inserted immediately before the closing body, followed by exactly one LF.
  return actual.slice(match.index!+match[0].length)==='\n</body></html>'&&actual.replace(match[0]+'\n','')===expected;
}
export function dataEchoRobotsAllows(text:string,path:string):boolean{
  if(!text.trim()||text.split(/\r\n|\r|\n/).some(raw=>{const line=raw.replace(/#.*/,'').trim(),match=/^content-signal\s*:\s*(.*)$/i.exec(line);return !!match&&/(?:^|[,;\s])search\s*=\s*no(?:$|[,;\s])/i.test(match[1])}))return false;
  return ['*','googlebot','bingbot'].every(agent=>agentboardRobotsAllows(text,path,agent));
}
/** GET-only recovery. Unknown metadata shapes fail closed until verified against a real encrypted receipt. */
export async function reconcileDataEchoTask(deps:DataEchoDependencies):Promise<{status:'found';publicUrl:string}|{status:'unknown'}>{
  try{
    const snapshot=await deps.journal.load();if(!snapshot)return {status:'unknown'};
    const doc=identity(deps);if(!sameIntent(deps,snapshot.intent,doc))return {status:'unknown'};
    const created=responseAt(snapshot,'create'),receipt=created&&parseDataEchoCreate(created,doc),final=responseAt(snapshot,'finalize');
    if(!receipt||!final||final.status!==200||final.url!==receipt.finalizeUrl||!parseConnectedJson(final)
      ||(['upload_index','upload_robots'] as const).some(step=>{const r=responseAt(snapshot,step),path=step==='upload_index'?'index.html':'robots.txt';return !r||![200,201,204].includes(r.status)||r.url!==receipt.uploads.find(file=>file.path===path)?.url}))return {status:'unknown'};
    const meta=await connectedRequest(`${DATAECHO_API}/publish/${receipt.slug}`,{method:'GET',headers:headers(deps.apiKey)},{fetch:deps.fetch},deps.signal,128_000),detail=parseConnectedJson(meta);
    if(meta.status!==200||!detail||detail.slug!==receipt.slug||detail.siteUrl!==receipt.siteUrl||detail.currentVersionId!==receipt.versionId||detail.pendingVersionId!==null||detail.anonymous!==false||detail.passwordProtected!==false||detail.payGated!==false||detail.spaMode!==false||detail.kind!=='static'
      ||detail.expiresAt!==null||!Array.isArray(detail.files)||detail.files.length!==2
      ||doc.files.some(file=>detail.files instanceof Array&&detail.files.filter((v:unknown)=>object(v)&&v.path===file.path&&v.size===file.size&&v.hash===file.hash&&v.contentType===file.contentType).length!==1))return {status:'unknown'};
    const page=await connectedRequest(receipt.siteUrl,{method:'GET',headers:{accept:'text/html'}},{fetch:deps.fetch},deps.signal,220_000);
    if(page.status!==200||!/^text\/html\b/i.test(page.contentType)||!dataEchoPublicHtmlMatches(page.body,doc.html)||/(?:^|[:,\s])(?:none|noindex)(?=$|[,\s])/i.test(page.robotsHeader))return {status:'unknown'};
    const $=load(page.body);if($('meta[name]').toArray().some(el=>/^(?:robots|googlebot|bingbot)$/i.test($(el).attr('name')??'')&&/(?:^|[,\s])(?:none|noindex)(?=$|[,\s])/i.test($(el).attr('content')??'')))return {status:'unknown'};
    const robots=await connectedRequest(`${receipt.siteUrl}robots.txt`,{method:'GET',headers:{accept:'text/plain'}},{fetch:deps.fetch},deps.signal,64_000);
    return robots.status===200&&/^text\/plain\b/i.test(robots.contentType)&&dataEchoRobotsAllows(robots.body,new URL(receipt.siteUrl).pathname)?{status:'found',publicUrl:receipt.siteUrl}:{status:'unknown'};
  }catch{return {status:'unknown'}}
}
export async function runDataEchoTask(deps:DataEchoDependencies):Promise<ExecutionResult>{
  let doc:DataEchoDocument;try{doc=identity(deps)}catch{return {status:'needs_input',message:'DataEcho 原创软件文档、作者披露或单独审核未通过'}}
  if(await deps.journal.load()||deps.task.submittedAt||deps.task.publicUrl){const found=await reconcileDataEchoTask(deps);return found.status==='found'?{status:'review',publicUrl:found.publicUrl,message:'DataEcho 原公开页已只读核对，待验收'}:unknown()}
  if(deps.executionEnabled!==true)return {status:'needs_input',message:'DataEcho 实发尚未获独立执行审核放行'};
  const intent:DataEchoIntent={version:1,taskId:deps.task.id,siteId:deps.site.id,accountId:deps.account.id,email:deps.account.email,username:deps.account.username,name:deps.task.draft!.title.slice(0,100),sourceHash:doc.sourceHash,requestHash:doc.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};
  try{const profile=await probeDataEchoConnection(deps.apiKey,{fetch:deps.fetch},deps.signal);if(profile.username!==deps.account.username)return {status:'needs_input',message:'DataEcho 原远端用户账号已改变'};}catch{return {status:'needs_input',message:'DataEcho 只读账号核对失败'}}
  try{
    await deps.journal.reserve(intent);
    const created=await write(deps,intent,'create',`${DATAECHO_API}/publish`,{method:'POST',headers:{...headers(deps.apiKey),'content-type':'application/json'},body:doc.request}),receipt=parseDataEchoCreate(created,doc);
    if(!receipt)return unknown();
    return finishDataEchoCreated(deps,intent,doc,receipt);
  }catch{return unknown()}
}

async function finishDataEchoCreated(deps:DataEchoDependencies,intent:DataEchoIntent,doc:DataEchoDocument,receipt:DataEchoReceipt):Promise<ExecutionResult>{
  try{
    for(const file of doc.files){const upload=receipt.uploads.find(entry=>entry.path===file.path)!;
      const response=await write(deps,intent,file.path==='index.html'?'upload_index':'upload_robots',upload.url,{method:'PUT',headers:{'content-type':upload.contentType},body:new Uint8Array(file.bytes)});
      if(![200,201,204].includes(response.status))return unknown();
    }
    const final=await write(deps,intent,'finalize',receipt.finalizeUrl,{method:'POST',headers:{...headers(deps.apiKey),'content-type':'application/json'},body:JSON.stringify({versionId:receipt.versionId})});
    if(final.status!==200||!parseConnectedJson(final))return unknown();
    const found=await reconcileDataEchoTask(deps);if(found.status!=='found')return unknown();
    await deps.journal.markAccepted?.(intent,found.publicUrl);
    return {status:'review',publicUrl:found.publicUrl,message:'DataEcho 公开文档已只读核对，待浏览器验收'};
  }catch{return unknown()}
}
/** Explicit continuation of the exact original create, only before either upload was armed. */
export async function resumeDataEchoCreatedPublication(deps:DataEchoDependencies):Promise<ExecutionResult>{
  try{
    if(deps.executionEnabled!==true)return {status:'needs_input',message:'DataEcho 原事务继续上传尚未获独立执行审核'};
    const doc=identity(deps),snapshot=await deps.journal.load();
    if(!snapshot||!sameIntent(deps,snapshot.intent,doc)||Object.keys(snapshot.steps).length!==1||snapshot.steps.create?.stage!=='response')return unknown();
    const created=snapshot.steps.create.response!,receipt=parseDataEchoCreate(created,doc),raw=parseConnectedJson(created),upload=raw?.upload;
    if(!receipt||!object(upload)||!Number.isInteger(upload.expiresInSeconds)||Number(upload.expiresInSeconds)<=0||Number(upload.expiresInSeconds)>3600
      ||(deps.now?.()??new Date()).getTime()>=Date.parse(snapshot.intent.createdAt)+Number(upload.expiresInSeconds)*1000)return unknown();
    const profile=await probeDataEchoConnection(deps.apiKey,{fetch:deps.fetch},deps.signal);if(profile.username!==snapshot.intent.username)return unknown();
    const response=await connectedRequest(`${DATAECHO_API}/publish/${receipt.slug}`,{method:'GET',headers:headers(deps.apiKey)},{fetch:deps.fetch},deps.signal,128_000),detail=parseConnectedJson(response);
    if(response.status!==200||!detail||detail.slug!==receipt.slug||detail.siteUrl!==receipt.siteUrl||detail.status!=='pending'
      ||detail.currentVersionId!==null||detail.pendingVersionId!==receipt.versionId||detail.expiresAt!==null||detail.anonymous!==false
      ||detail.passwordProtected!==false||detail.payGated!==false||detail.spaMode!==false||detail.kind!=='static'
      ||!Array.isArray(detail.files)||detail.files.length!==0||detail.filesCount!==0||!object(detail.viewer)
      ||detail.viewer.title!==deps.task.draft!.title.slice(0,100)||detail.viewer.description!==deps.task.draft!.description.slice(0,300))return unknown();
    return finishDataEchoCreated(deps,snapshot.intent,doc,receipt);
  }catch{return unknown()}
}

async function connected(context:ExecutionContext):Promise<DataEchoDependencies|undefined>{
  const account=context.getAccount(),publicationContext=context.getArticlePublicationContext?.(),journal=context.dataEchoJournal;
  if(!account||!publicationContext||!journal)return;
  let secret:unknown;try{secret=JSON.parse(await context.secrets.get(`account:${account.id}`)??'null')}catch{return}
  if(!object(secret)||secret.version!==1||typeof secret.apiKey!=='string'||secret.email!==account.email||secret.username!==account.username)return;
  try{headers(secret.apiKey)}catch{return}
  return {site:context.site,channel:context.channel,task:context.task,account,settings:context.settings,publicationContext,
    apiKey:secret.apiKey,signal:context.signal,fetch:context.batch5Dependencies?.fetch??fetch,journal,executionEnabled:context.dataEchoExecutionEnabled===true,
    assertAuthorized:context.assertDataEchoAuthorized??(()=>{throw Error('dataecho_live_authorization_missing')})};
}
export async function runDataEchoConnectedTask(context:ExecutionContext):Promise<ExecutionResult>{
  const deps=await connected(context);return deps?runDataEchoTask(deps):{status:'needs_input',message:'DataEcho 原账号密钥、单篇用途或加密日志未就绪'};
}
export async function reconcileDataEchoConnectedTask(context:ExecutionContext):Promise<{status:'found';publicUrl:string;batch5:NonNullable<Task['batch5']>}|{status:'unknown'}>{
  const deps=await connected(context);if(!deps||!context.task.batch5)return {status:'unknown'};
  const result=await reconcileDataEchoTask(deps);
  return result.status==='found'?{...result,batch5:{...context.task.batch5,stage:'api_receipt',publicUrl:result.publicUrl}}:{status:'unknown'};
}
export async function verifyDataEchoConnectedPublication(context:ExecutionContext):Promise<LinkResult>{
  const deps=await connected(context),found=deps?await reconcileDataEchoTask(deps):{status:'unknown' as const};
  return found.status==='found'?{found:true,outcome:'found',url:found.publicUrl,rel:'nofollow ugc noopener noreferrer',indexable:true,reason:'DataEcho 原文档、目标链接和抓取许可已只读核对'}
    :{found:false,outcome:'unreachable',url:context.task.publicUrl??'https://dataecho.ai/',rel:'',reason:'DataEcho 原事务或公开页未通过核对'};
}
