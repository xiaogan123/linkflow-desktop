import {randomUUID} from 'node:crypto';
import {blake3} from '@noble/hashes/blake3.js';
import {load} from 'cheerio';
import {articleReviewStillValid} from '../main/article-review';
import type {Account,ExecutionResult,LinkResult,Task} from '../shared/types';
import type {Batch5Dependencies,Batch5Intent,Batch5OpaqueResponse,Batch5Receipt,Batch5TaskState} from './batch5-contract';
import {batch5State,connectedDependencies,connectedRequest,hashBatch5,noIndex,parseConnectedJson,
  persistBatch5Receipt,persistBatch5Response,stateFromIntent,type ConnectedContext,type ConnectedResponse} from './batch5-connected';
import {renderShareYourHtmlArticle} from './shareyourhtml-article';

const API='https://api.cloudflare.com/client/v4';
const CHANNEL='cloudflare-pages';
const ID=/^[a-f0-9]{32}$/i;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PROJECT=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TOKEN=/^[^\s\u0000-\u001f\u007f]{8,8192}$/;
const ROBOTS='User-agent: *\nAllow: /\n';
const MAX_HTML=200_000;

export interface CloudflarePagesBinding {version:1;apiToken:string;accountId:string;projectName:string;projectId:string;tokenId:string;productionBranch:string}
export interface CloudflarePagesProbe {tokenId:string;projectId:string;projectName:string;productionBranch:string;publicUrl:string;empty:boolean}
interface Document {html:string;target:string;sourceHash:string;requestHash:string;manifest:string;assets:Array<{base64:true;key:string;metadata:{contentType:string};value:string}>}

function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
function exactJson(response:ConnectedResponse):Record<string,unknown>|undefined{
  const envelope=parseConnectedJson(response);return envelope?.success===true&&object(envelope.result)?envelope.result:undefined;
}
function apiHeaders(token:string):HeadersInit{return {accept:'application/json',authorization:`Bearer ${token}`}}
function binding(raw:string|undefined):CloudflarePagesBinding|undefined{
  try{const value:unknown=JSON.parse(raw??'null');if(!object(value)||value.version!==1||typeof value.apiToken!=='string'||!TOKEN.test(value.apiToken)
    ||typeof value.accountId!=='string'||!ID.test(value.accountId)||typeof value.projectName!=='string'||!PROJECT.test(value.projectName)
    ||typeof value.projectId!=='string'||!UUID.test(value.projectId)||typeof value.tokenId!=='string'||!ID.test(value.tokenId)
    ||typeof value.productionBranch!=='string'||!value.productionBranch||value.productionBranch.length>100)return;
    return value as unknown as CloudflarePagesBinding;
  }catch{return}
}
function ownerAccount(context:ConnectedContext):Account|undefined{
  const value=context.getAccount();return value?.channelId===CHANNEL&&value.id===context.task.accountId&&value.ownerSiteId===context.site.id
    &&value.status==='registered'&&value.hasPassword&&value.credentialKind==='api_token'&&typeof value.username==='string'&&ID.test(value.username)
    &&typeof value.publicationUrl==='string'?value:undefined;
}
function projectPath(value:CloudflarePagesBinding):string{return `${API}/accounts/${value.accountId}/pages/projects/${value.projectName}`}
function publicUrl(name:string):string{return `https://${name}.pages.dev/`}
function projectRecord(value:Record<string,unknown>,name:string,id?:string):{id:string;branch:string;url:string;empty:boolean}|undefined{
  if(typeof value.id!=='string'||!UUID.test(value.id)||id&&value.id!==id||value.name!==name
    ||typeof value.production_branch!=='string'||!value.production_branch||value.production_branch.length>100)return;
  const url=publicUrl(name);if(value.subdomain!==`${name}.pages.dev`)return;
  if(value.source!==null&&value.source!==undefined)return;
  // Both deployment slots must be absent. A separate list GET is required before mutation.
  const empty=(value.canonical_deployment===null||value.canonical_deployment===undefined)
    &&(value.latest_deployment===null||value.latest_deployment===undefined);
  return {id:value.id,branch:value.production_branch,url,empty};
}
async function projectAndDeploymentList(token:string,accountId:string,projectName:string,deps:Batch5Dependencies,signal:AbortSignal){
  const base=`${API}/accounts/${accountId}/pages/projects/${projectName}`;
  const response=await connectedRequest(base,{method:'GET',headers:apiHeaders(token)},deps,signal,128_000);
  if(response.status!==200)throw Error('cloudflare_project_unavailable');
  const project=exactJson(response);if(!project)throw Error('cloudflare_project_invalid');
  const list=await connectedRequest(`${base}/deployments?per_page=1&page=1`,{method:'GET',headers:apiHeaders(token)},deps,signal,128_000);
  if(list.status!==200)throw Error('cloudflare_deployments_unavailable');
  const envelope=parseConnectedJson(list);if(envelope?.success!==true||!Array.isArray(envelope.result))throw Error('cloudflare_deployments_invalid');
  return {project,deployments:envelope.result as unknown[]};
}

/** Read-only probe for one manually prepared dedicated Direct Upload project. */
export async function probeCloudflarePagesConnection(apiToken:string,accountId:string,projectName:string,deps:Batch5Dependencies={},signal:AbortSignal=new AbortController().signal):Promise<CloudflarePagesProbe>{
  if(!TOKEN.test(apiToken)||!ID.test(accountId)||!PROJECT.test(projectName))throw Error('cloudflare_binding_invalid');
  const tokenResponse=await connectedRequest(`${API}/user/tokens/verify`,{method:'GET',headers:apiHeaders(apiToken)},deps,signal,16_000);
  const token=exactJson(tokenResponse);if(tokenResponse.status!==200||!token||token.status!=='active'||typeof token.id!=='string'||!ID.test(token.id))throw Error('cloudflare_token_unverified');
  const {project,deployments}=await projectAndDeploymentList(apiToken,accountId,projectName,deps,signal);
  const record=projectRecord(project,projectName);if(!record)throw Error('cloudflare_project_binding_invalid');
  return {tokenId:token.id,projectId:record.id,projectName,productionBranch:record.branch,publicUrl:record.url,
    empty:record.empty&&deployments.length===0};
}

function document(context:ConnectedContext,requireCurrentReview=true):Document{
  if(!['software','developer','ai'].includes(context.site.category)||!context.task.draft||!context.task.topicUrl
    ||requireCurrentReview&&!articleReviewStillValid(context.task,context.site,context.channel,context.settings,ownerAccount(context)))throw Error('cloudflare_review_invalid');
  const target=new URL(context.task.topicUrl),source=new URL(context.site.url);
  if(target.protocol!=='https:'||source.protocol!=='https:'||target.hostname!==source.hostname)throw Error('cloudflare_target_invalid');
  const rendered=renderShareYourHtmlArticle({draft:{title:context.task.draft.title,description:context.task.draft.description,
    body:context.task.draft.body},targetUrl:target.href,language:context.site.language,slug:'cloudflare-docs'});
  const $=load(rendered.html);if($('a').filter((_i,el)=>$(el).attr('href')===target.href).length!==1)throw Error('cloudflare_target_count');
  const html=rendered.html;if(Buffer.byteLength(html)>MAX_HTML)throw Error('cloudflare_html_too_large');
  const files=[{path:'/index.html',content:html,mime:'text/html'},{path:'/robots.txt',content:ROBOTS,mime:'text/plain'}];
  const assets=files.map(file=>{
    const value=Buffer.from(file.content,'utf8').toString('base64');
    // Cloudflare's Wrangler hash: BLAKE3(base64(bytes) + extension), first 32 hex digits.
    const key=Buffer.from(blake3(Buffer.from(value+file.path.split('.').at(-1)!,'utf8'))).toString('hex').slice(0,32);
    return {path:file.path,base64:true as const,key,metadata:{contentType:file.mime},value};
  });
  const manifest=JSON.stringify(Object.fromEntries(assets.map(({path,key})=>[path,key])));
  return {html,target:target.href,sourceHash:hashBatch5(html),requestHash:hashBatch5(manifest),manifest,
    assets:assets.map(({path:_path,...asset})=>asset)};
}
function exactDocument(context:ConnectedContext,intent:Batch5Intent):Document|undefined{
  if(intent.channelId!==CHANNEL||intent.siteId!==context.site.id)return;
  try{const value=document(context,false);return value.sourceHash===intent.sourceHash&&value.requestHash===intent.requestHash?value:undefined}catch{return}
}
function deploymentRecord(value:Record<string,unknown>|undefined,projectId:string,projectName:string):string|undefined{
  if(!value||typeof value.id!=='string'||!UUID.test(value.id)||value.project_id!==projectId||value.project_name!==projectName||value.environment!=='production')return;
  return value.id;
}
function deploymentFromOpaque(opaque:Batch5OpaqueResponse|undefined,intent:Batch5Intent,path:string,projectId:string,projectName:string):{id:string;raw:string}|undefined{
  if(!opaque||opaque.status!==200&&opaque.status!==201||opaque.responseUrl!==`${path}/deployments`||!opaque.bodyComplete
    ||!/^application\/json\b/i.test(opaque.contentType)||JSON.stringify(opaque.intent)!==JSON.stringify(intent)
    ||opaque.bodyBase64.length>350_000)return;
  const bytes=Buffer.from(opaque.bodyBase64,'base64');if(bytes.length>256_000||bytes.toString('base64')!==opaque.bodyBase64)return;
  const raw=bytes.toString('utf8');let parsed:unknown;try{parsed=JSON.parse(raw)}catch{return}
  if(!object(parsed)||parsed.success!==true)return;
  const id=deploymentRecord(object(parsed.result)?parsed.result:undefined,projectId,projectName);
  return id?{id,raw}:undefined;
}
function deniedRobots(response:ConnectedResponse):boolean{
  if(noIndex(response)||/(?:^|[,\s])(?:(?:googlebot|bingbot)\s*:\s*)?(?:none|noindex)(?=$|[,\s])/i.test(response.robotsHeader))return true;
  const $=load(response.body);return $('meta[name]').toArray().some(el=>/^(robots|googlebot|bingbot)$/i.test($(el).attr('name')??'')
    &&/(?:^|[,\s])(?:none|noindex)(?=$|[,\s])/i.test($(el).attr('content')??''));
}
async function acceptedPublic(url:string,doc:Document,deps:Batch5Dependencies,signal:AbortSignal):Promise<boolean>{
  const page=await connectedRequest(url,{method:'GET',headers:{accept:'text/html'}},deps,signal,256_000);
  if(page.status!==200||!/^text\/html\b/i.test(page.contentType)||deniedRobots(page)||page.body!==doc.html)return false;
  const $=load(page.body);if($('a').filter((_i,el)=>$(el).attr('href')===doc.target).length!==1)return false;
  const robots=await connectedRequest(new URL('/robots.txt',url).href,{method:'GET'},deps,signal,1024);
  return robots.status===200&&robots.body===ROBOTS&&!deniedRobots(robots);
}
async function originalDeployment(context:ConnectedContext,secret:CloudflarePagesBinding,id:string,doc:Document,deps:Batch5Dependencies):Promise<boolean>{
  const path=projectPath(secret);const response=await connectedRequest(`${path}/deployments/${id}`,{method:'GET',headers:apiHeaders(secret.apiToken)},deps,context.signal,128_000);
  const found=deploymentRecord(exactJson(response),secret.projectId,secret.projectName);if(response.status!==200||found!==id)return false;
  const details=exactJson(response)!;if(!object(details.latest_stage)||details.latest_stage.name!=='deploy'||details.latest_stage.status!=='success'||details.is_skipped===true)return false;
  const projectResponse=await connectedRequest(path,{method:'GET',headers:apiHeaders(secret.apiToken)},deps,context.signal,128_000);
  const project=exactJson(projectResponse),record=project&&projectRecord(project,secret.projectName,secret.projectId);
  if(projectResponse.status!==200||!record||record.branch!==secret.productionBranch||!object(project?.canonical_deployment)
    ||project.canonical_deployment.id!==id)return false;
  return acceptedPublic(record.url,doc,deps,context.signal);
}
function resultUnknown(message:string):ExecutionResult{return {status:'review',reasonCode:'submission_unknown',message}}

export async function reconcileCloudflarePagesTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<{status:'found';publicUrl:string;batch5:Batch5TaskState}|{status:'unknown'}>{
  const persistence=context.batch5Persistence,owner=ownerAccount(context);if(!persistence||!owner)return {status:'unknown'};
  const intent=await persistence.loadIntent();if(!intent)return {status:'unknown'};
  const doc=exactDocument(context,intent);if(!doc)return {status:'unknown'};
  const secret=binding(await context.secrets.get(`account:${owner.id}`));if(!secret||secret.accountId!==owner.username||owner.publicationUrl!==publicUrl(secret.projectName))return {status:'unknown'};
  try{const deps=connectedDependencies(context,overrides);
    const probe=await probeCloudflarePagesConnection(secret.apiToken,secret.accountId,secret.projectName,deps,context.signal);
    if(probe.tokenId!==secret.tokenId||probe.projectId!==secret.projectId||probe.productionBranch!==secret.productionBranch)return {status:'unknown'};
    const receipt=await persistence.loadReceipt();if(receipt&&JSON.stringify(receipt.intent)!==JSON.stringify(intent))return {status:'unknown'};
    const opaque=receipt?undefined:deploymentFromOpaque(await persistence.loadOpaqueResponse(),intent,projectPath(secret),secret.projectId,secret.projectName);
    const id=receipt?.remoteId??opaque?.id;if(!id||!UUID.test(id)||receipt&&receipt.publicUrl!==probe.publicUrl)return {status:'unknown'};
    if(!await originalDeployment(context,secret,id,doc,deps))return {status:'unknown'};
    const saved=receipt??{version:1,intent,publicUrl:probe.publicUrl,remoteId:id,rawResponse:opaque!.raw};
    const state=await persistBatch5Receipt(context,saved,owner.id,id);
    return {status:'found',publicUrl:probe.publicUrl,batch5:state};
  }catch{return {status:'unknown'}}
}

export async function runCloudflarePagesTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<ExecutionResult>{
  if(context.channel.id!==CHANNEL||context.task.channelId!==CHANNEL||context.channel.automation!=='api')return {status:'needs_input',message:'Cloudflare Pages 任务类型无效'};
  const persistence=context.batch5Persistence,owner=ownerAccount(context);
  if(!persistence?.reserveIntent||!persistence.markSending||!persistence.assertReadyToSubmit||!owner)return {status:'needs_input',message:'Cloudflare Pages 缺少专用账号或持久化写前闸'};
  if(await persistence.loadIntent()||batch5State(context)||context.task.submittedAt||context.task.publicUrl){
    const found=await reconcileCloudflarePagesTask(context,overrides);
    return found.status==='found'?{status:'review',message:'Cloudflare Pages 原事务只读对账成功，待公开页验收',publicUrl:found.publicUrl,batch5:found.batch5}
      :resultUnknown('Cloudflare Pages 原部署结果不明；后续只读对账，不会再次 POST');
  }
  const secret=binding(await context.secrets.get(`account:${owner.id}`));
  if(!secret||secret.accountId!==owner.username||owner.publicationUrl!==publicUrl(secret.projectName))return {status:'needs_input',message:'Cloudflare Pages 项目账号绑定无效'};
  const deps=connectedDependencies(context,overrides);let probe:CloudflarePagesProbe;
  try{probe=await probeCloudflarePagesConnection(secret.apiToken,secret.accountId,secret.projectName,deps,context.signal)}
  catch{return {status:'needs_input',message:'Cloudflare Pages 令牌或专用项目只读核对失败'}}
  if(probe.tokenId!==secret.tokenId||probe.projectId!==secret.projectId||probe.productionBranch!==secret.productionBranch||!probe.empty)
    return {status:'needs_input',message:'Cloudflare Pages 项目已非绑定的空白 Direct Upload 项目；不会覆盖'};
  let doc:Document;try{doc=document(context)}catch{return {status:'needs_input',reasonCode:'format_invalid',message:'Cloudflare Pages 只接受当前审核通过、唯一目标链接的软件文档'}}
  const tokenResponse=await connectedRequest(`${projectPath(secret)}/upload-token`,{method:'GET',headers:apiHeaders(secret.apiToken)},deps,context.signal,16_000).catch(()=>undefined);
  const jwt=tokenResponse&&exactJson(tokenResponse)?.jwt;if(tokenResponse?.status!==200||typeof jwt!=='string'||!TOKEN.test(jwt))return {status:'needs_input',message:'Cloudflare Pages 上传令牌不可用'};
  const intent:Batch5Intent={version:1,channelId:CHANNEL,operationId:randomUUID(),siteId:context.site.id,sourceHash:doc.sourceHash,
    requestHash:doc.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};
  try{await persistence.reserveIntent(intent);context.checkpoint({batch5:stateFromIntent(intent,'reserved',owner.id),checkpoint:'batch5_reserved'} as Partial<Task>)}
  catch{return {status:'needs_input',message:'Cloudflare Pages 加密部署意图未保存'}}
  try{await persistence.assertReadyToSubmit(intent);await persistence.markSending(intent);
    context.checkpoint({batch5:stateFromIntent(intent,'submitting',owner.id),checkpoint:'batch5_submitting',submittedAt:intent.createdAt} as Partial<Task>)}
  catch{return resultUnknown('Cloudflare Pages 写前状态变化；只读对账')}
  let upload:ConnectedResponse;
  try{upload=await connectedRequest(`${API}/pages/assets/upload`,{method:'POST',headers:{...apiHeaders(jwt),'content-type':'application/json'},
    body:JSON.stringify(doc.assets)},deps,context.signal,32_000)}catch{return resultUnknown('Cloudflare Pages 资产上传结果不明；不会重发')}
  if(upload.status!==200||parseConnectedJson(upload)?.success!==true)return resultUnknown('Cloudflare Pages 资产上传未获成功确认；不会重发');
  try{await persistence.assertReadyToSubmit(intent);
    const recheck=await probeCloudflarePagesConnection(secret.apiToken,secret.accountId,secret.projectName,deps,context.signal);
    if(!recheck.empty||recheck.projectId!==secret.projectId||recheck.tokenId!==secret.tokenId||recheck.productionBranch!==secret.productionBranch)throw Error('project_changed');
    await persistence.assertReadyToSubmit(intent);
  }catch{return resultUnknown('Cloudflare Pages 部署前空项目检查失败；不会重发')}
  const form=new FormData();form.set('manifest',doc.manifest);form.set('branch',secret.productionBranch);
  let response:ConnectedResponse;
  try{response=await connectedRequest(`${projectPath(secret)}/deployments`,{method:'POST',headers:apiHeaders(secret.apiToken),body:form},deps,context.signal,256_000);
    await persistBatch5Response(persistence,intent,response)}catch{return resultUnknown('Cloudflare Pages 部署结果不明；只读对账')}
  if(response.status!==200&&response.status!==201)return resultUnknown('Cloudflare Pages 部署未获成功状态；不会重发');
  const id=deploymentRecord(exactJson(response),secret.projectId,secret.projectName);
  if(!id)return resultUnknown('Cloudflare Pages 部署回执缺少绑定标识；只读对账');
  const receipt:Batch5Receipt={version:1,intent,publicUrl:probe.publicUrl,remoteId:id,rawResponse:response.body};
  try{const state=await persistBatch5Receipt(context,receipt,owner.id,id);
    return {status:'review',message:'Cloudflare Pages 部署回执已加密保存，待公开 HTML 验收',publicUrl:probe.publicUrl,batch5:state}}
  catch{return resultUnknown('Cloudflare Pages 部署已响应但回执保存不明；只读对账')}
}

export async function verifyCloudflarePagesPublication(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<LinkResult>{
  const fallback=context.task.publicUrl??'https://pages.cloudflare.com/';
  try{const found=await reconcileCloudflarePagesTask(context,overrides);
    if(found.status!=='found')return {found:false,outcome:'unreachable',url:fallback,rel:'',reason:'Cloudflare Pages 原事务或公开内容尚未通过只读验收'};
    return {found:true,outcome:'found',url:found.publicUrl,rel:'nofollow ugc noopener noreferrer',reason:'Cloudflare Pages 独立文档、唯一原生目标链接及抓取权限已核对',indexable:true};
  }catch{return {found:false,outcome:'unreachable',url:fallback,rel:'',reason:'Cloudflare Pages 只读验收暂不可用'}}
}

export const cloudflarePagesTesting={document,projectRecord,deniedRobots,deploymentRecord};
