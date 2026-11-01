import {createHash,randomUUID} from 'node:crypto';
import {load} from 'cheerio';
import {articleReviewStillValid} from '../main/article-review';
import type {Account,ExecutionResult,LinkResult,Task} from '../shared/types';
import type {Batch5Dependencies,Batch5Intent,Batch5OpaqueResponse,Batch5Receipt,Batch5TaskState} from './batch5-contract';
import {batch5State,connectedDependencies,connectedRequest,hashBatch5,noIndex,parseConnectedJson,
  persistBatch5Receipt,persistBatch5Response,stateFromIntent,type ConnectedContext} from './batch5-connected';
import {renderShareYourHtmlArticle} from './shareyourhtml-article';

const API='https://api.netlify.com/api/v1';
const CHANNEL='netlify';
const MAX_ZIP=200_000;
const IDENTIFIER=/^[A-Za-z0-9._~-]{1,256}$/;
const TOKEN=/^[^\s\u0000-\u001f\u007f]{8,8192}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

interface Credential {version:1;accessToken:string;userId:string}
interface Probe {userId:string;displayName?:string;teamId:string}
interface Document {html:string;zip:Buffer;target:string;sourceHash:string;requestHash:string}

function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
function credential(value:string|undefined):Credential|undefined{
  try{const parsed:unknown=JSON.parse(value??'null');if(!object(parsed)||parsed.version!==1||typeof parsed.accessToken!=='string'||!TOKEN.test(parsed.accessToken)
    ||typeof parsed.userId!=='string'||!IDENTIFIER.test(parsed.userId))return;
    return {version:1,accessToken:parsed.accessToken,userId:parsed.userId};
  }catch{return}
}
function account(context:ConnectedContext):Account|undefined{
  const value=context.getAccount();
  return value?.channelId===CHANNEL&&value.id===context.task.accountId&&value.status==='registered'
    &&value.hasPassword&&value.credentialKind==='api_token'&&value.username&&IDENTIFIER.test(value.username)?{...value}:undefined;
}
function apiHeaders(token:string):HeadersInit{return {accept:'application/json',authorization:`Bearer ${token}`}}
function netlifyUrl(name:unknown):string|undefined{
  if(typeof name!=='string'||! /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))return;
  return `https://${name}.netlify.app/`;
}
function siteReceipt(value:Record<string,unknown>|undefined,teamId:string):{id:string;url:string}|undefined{
  if(!value||typeof value.id!=='string'||!UUID.test(value.id))return;
  if(typeof value.account_id==='string'&&value.account_id!==teamId)return;
  const url=netlifyUrl(value.name);if(!url)return;
  if(typeof value.ssl_url==='string'&&value.ssl_url.replace(/\/$/,'')!==url.slice(0,-1))return;
  return {id:value.id,url};
}
/** ZIP creation returns a deployment-shaped receipt; only a subsequent owned-site GET can confirm it. */
function zipReceipt(value:Record<string,unknown>|undefined):{id:string;url:string;deployId:string}|undefined{
  if(!value||typeof value.id!=='string'||!UUID.test(value.id)||typeof value.deploy_id!=='string'
    ||!/^[A-Za-z0-9_-]{6,128}$/.test(value.deploy_id))return;
  const url=netlifyUrl(value.subdomain);if(!url)return;
  return {id:value.id,url,deployId:value.deploy_id};
}

/** Read-only connection probe. A single, explicitly Free team is required because ZIP create uses the default team. */
export async function probeNetlifyPublisherConnection(accessToken:string,deps:Batch5Dependencies={},signal:AbortSignal=new AbortController().signal):Promise<Probe>{
  if(!TOKEN.test(accessToken))throw Error('netlify_credential_invalid');
  const userResponse=await connectedRequest(`${API}/user`,{method:'GET',headers:apiHeaders(accessToken)},deps,signal,64_000);
  if(userResponse.status!==200)throw Error('netlify_user_unavailable');
  const user=parseConnectedJson(userResponse);
  if(!user||typeof user.id!=='string'||!IDENTIFIER.test(user.id))throw Error('netlify_user_invalid');
  const teamsResponse=await connectedRequest(`${API}/accounts`,{method:'GET',headers:apiHeaders(accessToken)},deps,signal,128_000);
  if(teamsResponse.status!==200||!/^application\/json\b/i.test(teamsResponse.contentType))throw Error('netlify_teams_unavailable');
  let teams:unknown;try{teams=JSON.parse(teamsResponse.body)}catch{throw Error('netlify_teams_invalid')}
  if(!Array.isArray(teams)||teams.length!==1||!object(teams[0]))throw Error('netlify_requires_one_team');
  const team=teams[0];
  // Verified Free accounts expose explicit card/top-up booleans. Missing billing
  // fields are not evidence that an account cannot incur charges.
  if(typeof team.id!=='string'||!IDENTIFIER.test(team.id)||team.type_name!=='Free'
    ||team.has_stripe_payment_method!==false||team.auto_topup_enabled!==false
    ||team.payment_method_id!==null&&team.payment_method_id!==undefined
    ||!Array.isArray(team.owner_ids)||!team.owner_ids.includes(user.id))throw Error('netlify_free_team_unproven');
  const displayName=typeof user.full_name==='string'&&user.full_name.length<=160?user.full_name:undefined;
  return {userId:user.id,...(displayName?{displayName}:{}),teamId:team.id};
}

function crc32(bytes:Buffer):number{
  let crc=0xffffffff;
  for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
  return (crc^0xffffffff)>>>0;
}
/** Minimal uncompressed ZIP, two UTF-8 files, with no platform shell or extra dependency. */
function zipFiles(files:Array<{name:string;data:Buffer}>):Buffer{
  const locals:Buffer[]=[],centrals:Buffer[]=[];let offset=0;
  for(const file of files){
    const name=Buffer.from(file.name,'utf8'),crc=crc32(file.data);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc,14);
    local.writeUInt32LE(file.data.length,18);local.writeUInt32LE(file.data.length,22);local.writeUInt16LE(name.length,26);
    locals.push(local,name,file.data);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);
    central.writeUInt16LE(0x800,8);central.writeUInt32LE(crc,16);central.writeUInt32LE(file.data.length,20);
    central.writeUInt32LE(file.data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
    centrals.push(central,name);offset+=local.length+name.length+file.data.length;
  }
  const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);
  end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}

function document(context:ConnectedContext):Document{
  if(!['software','developer','ai'].includes(context.site.category)||!context.task.draft||!context.task.topicUrl)throw Error('netlify_document_invalid');
  const target=new URL(context.task.topicUrl),source=new URL(context.site.url);
  if(target.protocol!=='https:'||source.protocol!=='https:'||target.hostname!==source.hostname)throw Error('netlify_target_invalid');
  const rendered=renderShareYourHtmlArticle({draft:{title:context.task.draft.title,description:context.task.draft.description,
    body:context.task.draft.body},targetUrl:target.href,language:context.site.language,slug:'netlify-docs'});
  const $=load(rendered.html);if($('a').filter((_index,element)=>$(element).attr('href')===target.href).length!==1)throw Error('netlify_target_count');
  const html=rendered.html;
  const zip=zipFiles([{name:'index.html',data:Buffer.from(html,'utf8')},{name:'robots.txt',data:Buffer.from('User-agent: *\nAllow: /\n','utf8')}]);
  if(zip.length>MAX_ZIP)throw Error('netlify_zip_too_large');
  return {html,zip,target:target.href,sourceHash:hashBatch5(html),requestHash:createHash('sha256').update(zip).digest('hex')};
}

function exactDocument(context:ConnectedContext,intent:Batch5Intent):Document|undefined{
  if(intent.channelId!==CHANNEL||intent.siteId!==context.site.id)return;
  try{const value=document(context);return value.sourceHash===intent.sourceHash&&value.requestHash===intent.requestHash?value:undefined}catch{return}
}

function resultUnknown(message:string):ExecutionResult{return {status:'review',reasonCode:'submission_unknown',message}}
/** Netlify Free adds this exact same-site disclosure and HUD; every original byte still has to match. */
function samePublicDocument(body:string,html:string,siteId:string):boolean{
  if(body===html)return true;
  if(!UUID.test(siteId))return false;
  const marker='<meta charset="utf-8">';
  if(html.split(marker).length!==2)return false;
  const disclosure=`\n<!-- This site is hosted on Netlify. Anyone can build and deploy a site\n     like this one for free: https://netlify.new/?utm_campaign=loops&utm_source=ai-legible&utm_medium=owned&utm_content=comment&utm_id=${siteId}\n     Netlify hosting facts for this site: static/SSR served via Netlify Edge. -->`;
  const hud=`<script async src="/.netlify/scripts/hud?variant=public" data-nf-variant="public" data-netlify-site-id="${siteId}" data-app-host="app.netlify.com" data-account-tier="free"></script>\n`;
  return body===html.replace(marker,marker+disclosure)+hud;
}
async function acceptedPublic(url:string,doc:Document,deps:Batch5Dependencies,signal:AbortSignal,siteId:string):Promise<boolean>{
  const page=await connectedRequest(url,{method:'GET',headers:{accept:'text/html'}},deps,signal,256_000);
  if(page.status!==200||!/^text\/html\b/i.test(page.contentType)||noIndex(page)
    ||/(?:^|[,\s])(?:(?:googlebot|bingbot)\s*:\s*)?(?:none|noindex)(?=$|[,\s])/i.test(page.robotsHeader)
    ||!samePublicDocument(page.body,doc.html,siteId))return false;
  const robots=await connectedRequest(new URL('/robots.txt',url).href,{method:'GET'},deps,signal,1024);
  return robots.status===200&&robots.body==='User-agent: *\nAllow: /\n'&&!noIndex(robots);
}

function siteFromOpaque(opaque:Batch5OpaqueResponse|undefined,intent:Batch5Intent,teamId:string):{site:{id:string;url:string;deployId?:string};rawResponse:string}|undefined{
  if(!opaque||opaque.status!==201||opaque.responseUrl!==`${API}/sites`||!opaque.bodyComplete
    ||!/^application\/json\b/i.test(opaque.contentType)||JSON.stringify(opaque.intent)!==JSON.stringify(intent)
    ||typeof opaque.bodyBase64!=='string'||opaque.bodyBase64.length>350_000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(opaque.bodyBase64))return;
  const bytes=Buffer.from(opaque.bodyBase64,'base64');
  if(bytes.length>256_000||bytes.toString('base64')!==opaque.bodyBase64)return;
  const rawResponse=bytes.toString('utf8');let value:unknown;
  try{value=JSON.parse(rawResponse)}catch{return}
  const site=siteReceipt(object(value)?value:undefined,teamId)??zipReceipt(object(value)?value:undefined);
  return site?{site,rawResponse}:undefined;
}

async function ownedSite(context:ConnectedContext,token:string,teamId:string,deps:Batch5Dependencies,record:{id:string;url:string;deployId?:string}){
  if(!UUID.test(record.id))return;
  const response=await connectedRequest(`${API}/sites/${encodeURIComponent(record.id)}`,{method:'GET',headers:apiHeaders(token)},deps,context.signal);
  if(response.status!==200)return;
  const value=parseConnectedJson(response),site=siteReceipt(value,teamId);
  if(value?.account_id!==teamId)return;
  if(record.deployId&&(!object(value.published_deploy)
    ||value.published_deploy.id!==record.deployId||value.published_deploy.state!=='ready'))return;
  if(site?.id===record.id&&site.url===record.url)return {site,value};
}

async function priorSite(context:ConnectedContext,token:string,teamId:string,doc:Document,deps:Batch5Dependencies,record:{id:string;url:string;deployId?:string}):Promise<{id:string;url:string}|undefined>{
  const owned=await ownedSite(context,token,teamId,deps,record);
  if(owned&&await acceptedPublic(owned.site.url,doc,deps,context.signal,owned.site.id))return owned.site;
}

function visibilityReviewValid(context:ConnectedContext,intent:Batch5Intent,owner:Account):boolean{
  const current=account(context);
  return !context.signal.aborted&&current?.id===owner.id&&current.username===owner.username&&!!exactDocument(context,intent)
    &&articleReviewStillValid(context.task,context.site,context.channel,context.settings,current,context.getArticlePublicationContext?.());
}

/** Called at most once in a fresh creation stack; re-entry into runNetlifyTask is always GET-only. */
async function makeCreatedSitePublic(context:ConnectedContext,intent:Batch5Intent,owner:Account,token:string,teamId:string,
  deps:Batch5Dependencies,record:{id:string;url:string;deployId?:string},authorize?:()=>Promise<void>){
  const owned=await ownedSite(context,token,teamId,deps,record);if(!owned)return;
  if(owned.value.sso_login===true){
    // Only the exact ready deployment returned by ZIP creation can be exposed.
    if(!record.deployId||owned.value.sso_login_context!=='all'||!visibilityReviewValid(context,intent,owner))return;
    if(authorize)await authorize();
    if(!visibilityReviewValid(context,intent,owner))return;
    const response=await connectedRequest(`${API}/sites/${record.id}`,{method:'PATCH',
      headers:{...apiHeaders(token),'content-type':'application/json'},body:JSON.stringify({sso_login:false})},deps,context.signal,256_000);
    if(response.status!==200)return;
    // A successful PATCH response alone does not prove that the setting took effect.
    const after=await ownedSite(context,token,teamId,deps,record);
    if(!after||after.value.sso_login!==false)return;
  }else if(owned.value.sso_login!==false&&record.deployId)return;
  return owned.site;
}

export interface NetlifyVisibilityBinding {intent:Batch5Intent;siteId:string;deployId:string;publicUrl:string}
/** Explicit recovery only. The caller must durably reserve a separate, never-reset single-PATCH latch. */
export async function continueNetlifyVisibility(context:ConnectedContext,reserveVisibilityChange:(binding:NetlifyVisibilityBinding)=>Promise<void>,
  overrides:Batch5Dependencies={}):Promise<{status:'updated';publicUrl:string}|{status:'unknown'}>{
  try{
    const owner=account(context),persistence=context.batch5Persistence;
    if(!owner||!persistence||context.channel.id!==CHANNEL||context.task.channelId!==CHANNEL||context.channel.automation!=='api')return {status:'unknown'};
    const intent=await persistence.loadIntent();if(!intent||!visibilityReviewValid(context,intent,owner))return {status:'unknown'};
    const secret=credential(await context.secrets.get(`account:${owner.id}`));if(!secret||secret.userId!==owner.username)return {status:'unknown'};
    const deps=connectedDependencies(context,overrides),probe=await probeNetlifyPublisherConnection(secret.accessToken,deps,context.signal);
    if(probe.userId!==secret.userId)return {status:'unknown'};
    const original=siteFromOpaque(await persistence.loadOpaqueResponse(),intent,probe.teamId);
    if(!original?.site.deployId)return {status:'unknown'};
    const {site}=original;
    const found=await makeCreatedSitePublic(context,intent,owner,secret.accessToken,probe.teamId,deps,site,
      ()=>reserveVisibilityChange({intent,siteId:site.id,deployId:site.deployId!,publicUrl:site.url}));
    return found?{status:'updated',publicUrl:found.url}:{status:'unknown'};
  }catch{return {status:'unknown'}}
}

export async function reconcileNetlifyTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<{status:'found';publicUrl:string;batch5:Batch5TaskState}|{status:'unknown'}>{
  const persistence=context.batch5Persistence,owner=account(context);if(!persistence||!owner)return {status:'unknown'};
  const intent=await persistence.loadIntent();if(!intent)return {status:'unknown'};
  const doc=exactDocument(context,intent);if(!doc)return {status:'unknown'};
  const secret=credential(await context.secrets.get(`account:${owner.id}`));if(!secret||secret.userId!==owner.username)return {status:'unknown'};
  try{
    const deps=connectedDependencies(context,overrides),probe=await probeNetlifyPublisherConnection(secret.accessToken,deps,context.signal);
    if(probe.userId!==secret.userId)return {status:'unknown'};
    const existing=await persistence.loadReceipt();if(existing&&JSON.stringify(existing.intent)!==JSON.stringify(intent))return {status:'unknown'};
    const opaque=existing?undefined:siteFromOpaque(await persistence.loadOpaqueResponse(),intent,probe.teamId);
    const original=existing?.remoteId&&existing.publicUrl?{id:existing.remoteId,url:existing.publicUrl}:opaque?.site;
    if(!original)return {status:'unknown'};
    const found=await priorSite(context,secret.accessToken,probe.teamId,doc,deps,original);if(!found)return {status:'unknown'};
    const receipt=existing??{version:1,intent,publicUrl:found.url,remoteId:found.id,rawResponse:opaque!.rawResponse};
    if(receipt.publicUrl!==found.url||receipt.remoteId!==found.id)return {status:'unknown'};
    const state=await persistBatch5Receipt(context,receipt,owner.id,found.id);
    return {status:'found',publicUrl:found.url,batch5:state};
  }catch{return {status:'unknown'}}
}

export async function runNetlifyTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<ExecutionResult>{
  if(context.channel.id!==CHANNEL||context.task.channelId!==CHANNEL||context.channel.automation!=='api')return {status:'needs_input',message:'Netlify 任务类型无效'};
  const persistence=context.batch5Persistence,owner=account(context);
  if(!persistence?.reserveIntent||!persistence.markSending||!persistence.assertReadyToSubmit||!owner)
    return {status:'needs_input',message:'Netlify 缺少账号或持久化写前闸'};
  if(await persistence.loadIntent()||batch5State(context)||context.task.submittedAt||context.task.publicUrl){
    const found=await reconcileNetlifyTask(context,overrides);
    return found.status==='found'?{status:'review',message:'Netlify 原事务只读对账成功，待公开页验收',publicUrl:found.publicUrl,batch5:found.batch5}
      :resultUnknown('Netlify 原建站结果不明；只会继续 GET 对账，不会再次创建');
  }
  const secret=credential(await context.secrets.get(`account:${owner.id}`));
  if(!secret||secret.userId!==owner.username)return {status:'needs_input',message:'Netlify 授权账号绑定无效'};
  const deps=connectedDependencies(context,overrides);
  let probe:Probe;
  try{probe=await probeNetlifyPublisherConnection(secret.accessToken,deps,context.signal)}
  catch{return {status:'needs_input',message:'Netlify /user 或唯一 Free 团队未获官方响应确认；未发送建站请求'}}
  if(probe.userId!==secret.userId)return {status:'needs_input',message:'Netlify /user 与本地账号不符'};
  const operationId=randomUUID();let doc:Document;
  try{
    if(!articleReviewStillValid(context.task,context.site,context.channel,context.settings,owner,context.getArticlePublicationContext?.()))throw Error('netlify_review_invalid');
    doc=document(context);
  }catch{return {status:'needs_input',reasonCode:'format_invalid',message:'Netlify 只接受当前审核通过、唯一目标链接的软件文档'}}
  const intent:Batch5Intent={version:1,channelId:CHANNEL,operationId,siteId:context.site.id,sourceHash:doc.sourceHash,requestHash:doc.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};
  try{await persistence.reserveIntent(intent);context.checkpoint({batch5:stateFromIntent(intent,'reserved',owner.id),checkpoint:'batch5_reserved'} as Partial<Task>)}
  catch{return {status:'needs_input',message:'Netlify 加密建站意图未保存'}}
  try{await persistence.assertReadyToSubmit(intent);await persistence.markSending(intent);
    context.checkpoint({batch5:stateFromIntent(intent,'submitting',owner.id),checkpoint:'batch5_submitting',submittedAt:intent.createdAt} as Partial<Task>)}
  catch{return resultUnknown('Netlify 写前权限变化；意图已保存，后续只读对账')}
  let response;
  try{response=await connectedRequest(`${API}/sites`,{method:'POST',headers:{...apiHeaders(secret.accessToken),'content-type':'application/zip'},body:new Uint8Array(doc.zip)},deps,context.signal,256_000);
    await persistBatch5Response(persistence,intent,response)}
  catch{return resultUnknown('Netlify 建站结果不明；只会 GET 对账')}
  if(response.status===429)return {status:'failed',reasonCode:'platform_rate_limited',message:'Netlify 创建频率受限；不会重发'};
  if(response.status>=400&&response.status<500&&response.status!==408)return {status:'failed',reasonCode:'platform_rejected',message:'Netlify 拒绝建站请求；不会重发'};
  if(response.status!==201)return resultUnknown('Netlify 建站响应状态不明；只会 GET 对账');
  const value=parseConnectedJson(response),direct=siteReceipt(value,probe.teamId),zip=direct?undefined:zipReceipt(value);
  const record=zip??direct;
  const site=record?await makeCreatedSitePublic(context,intent,owner,secret.accessToken,probe.teamId,deps,record).catch(()=>undefined):undefined;
  if(!site)return resultUnknown('Netlify 建站响应缺少可核对的站点标识；只会 GET 对账');
  const receipt:Batch5Receipt={version:1,intent,publicUrl:site.url,remoteId:site.id,rawResponse:response.body};
  try{const state=await persistBatch5Receipt(context,receipt,owner.id,site.id);
    return {status:'review',message:'Netlify 新站收据已加密保存，待公开 HTML 验收',publicUrl:site.url,batch5:state}}
  catch{return resultUnknown('Netlify 新站已创建但收据保存不明；只会 GET 对账')}
}

export async function verifyNetlifyPublication(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<LinkResult>{
  const fallback=context.task.publicUrl??'https://www.netlify.com/';
  try{const found=await reconcileNetlifyTask(context,overrides);
    if(found.status!=='found')return {found:false,outcome:'unreachable',url:fallback,rel:'',reason:'Netlify 原事务或公开内容尚未通过只读验收'};
    return {found:true,outcome:'found',url:found.publicUrl,rel:'nofollow ugc noopener noreferrer',reason:'Netlify 独立文档、唯一原生目标链接及抓取权限已核对',indexable:true};
  }catch{return {found:false,outcome:'unreachable',url:fallback,rel:'',reason:'Netlify 只读验收暂不可用'}}
}

export const netlifyPublisherTesting={zipFiles,document,siteReceipt,samePublicDocument};
