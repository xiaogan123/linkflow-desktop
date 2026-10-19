import {load} from 'cheerio';
import {applyDeclaredArticleVisibility,publicPagePolicy} from './article-visibility';
import {inspectRenderedArticle} from './article-rendering';
import {createShiplySite,fetchShiplyBounded,finalizeShiplySite,shiplySiteUrl,uploadShiplySite,validShiplyApiKey,SHIPLY_ORIGIN,type ShiplyCreateReceipt,type ShiplyDependencies} from './shiply';
import {shiplyStoredReceipt,shiplyTaskIdentity} from '../main/shiply-publication';
import {validShiplyAccount} from '../main/shiply-management';
import type {ExecutionContext,ExecutionResult,ShiplyTaskReceipt,LinkResult,Task} from '../shared/types';

const MAX_JSON=256*1024,MAX_HTML=5*1024*1024,MAX_ROBOTS=128*1024;
type ReadResult={response:Response;text:string};
class ReadError extends Error{constructor(readonly kind:'invalid'|'unavailable'){super(kind)}}
async function get(url:string,headers:Record<string,string>,maximum:number,deps:ShiplyDependencies,allow404=false):Promise<ReadResult>{try{const {response,bytes}=await fetchShiplyBounded(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers},deps,maximum);if(response.redirected||response.url!==url||response.status!==200&&!(allow404&&response.status===404))throw new ReadError(response.status>=500||response.status===408||response.status===429?'unavailable':'invalid');return {response,text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}}catch(error){if(error instanceof ReadError)throw error;throw new ReadError('unavailable')}}
function robotsAllows(text:string,path:string,agent:string){type Group={agents:string[];rules:{allow:boolean;pattern:string}[]};const groups:Group[]=[];let group:Group={agents:[],rules:[]};const push=()=>{if(group.agents.length)groups.push(group);group={agents:[],rules:[]}};for(const raw of text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/)){const match=raw.replace(/#.*$/,'').trim().match(/^([^:]+):\s*(.*)$/);if(!match)continue;const key=match[1].trim().toLowerCase(),value=match[2].trim();if(key==='user-agent'&&/^(?:\*|[a-z_-]+)$/i.test(value)){if(group.rules.length)push();group.agents.push(value.toLowerCase())}else if((key==='allow'||key==='disallow')&&group.agents.length&&value)group.rules.push({allow:key==='allow',pattern:value})}push();const matched=groups.map(value=>({value,score:Math.max(...value.agents.map(item=>item==='*'?0:agent.startsWith(item)?item.length:-1))})).filter(value=>value.score>=0);if(!matched.length)return true;const score=Math.max(...matched.map(value=>value.score)),rules=matched.filter(value=>value.score===score).flatMap(value=>value.value.rules);let winner:{allow:boolean;specificity:number}|undefined;for(const rule of rules){const anchored=rule.pattern.endsWith('$'),source=rule.pattern.replace(/\$$/,'').split('*').map(value=>value.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*');if(!new RegExp(`^${source}${anchored?'$':''}`).test(path))continue;const next={allow:rule.allow,specificity:Buffer.byteLength(rule.pattern)};if(!winner||next.specificity>winner.specificity||next.specificity===winner.specificity&&next.allow)winner=next}return winner?.allow??true}
// Shiply documents a free-tier badge injected on serve. Cloudflare documents
// its module beacon with SRI. These are a narrowly identified body suffix, not
// permission to accept arbitrary changes to the reviewed document.
const SHIPLY_BADGE_STYLE='position:fixed;bottom:8px;right:8px;z-index:2147483646;background:rgba(23,23,23,.85);color:#fff;font:12px/1 -apple-system,sans-serif;padding:6px 10px;border-radius:6px;text-decoration:none';
function validShiplyBodySuffix(suffix:string){
  if(!suffix.trim())return true;
  let malformed=false;
  const $=load(suffix,{sourceCodeLocationInfo:true,onParseError:()=>{malformed=true}},false),nodes=$.root().contents().toArray();
  if(malformed)return false;
  let badge=0,beacon=0,cursor=0;
  for(const node of nodes){
    // HTML's fragment parser silently drops document tags. Require complete
    // source coverage and explicit closing tags so discarded input cannot pass.
    const loc=(node as unknown as {sourceCodeLocation?:{startOffset:number;endOffset:number;startTag?:{startOffset:number;endOffset:number};endTag?:{startOffset:number;endOffset:number}}}).sourceCodeLocation;
    if(!loc||loc.startOffset<cursor||suffix.slice(cursor,loc.startOffset).trim())return false;
    cursor=loc.endOffset;
    if(node.type==='text'&&!node.data.trim())continue;
    if(node.type==='comment')return false;
    if(!('name' in node)||!('attribs' in node))return false;
    if(!loc.startTag||!loc.endTag||loc.startTag.startOffset!==loc.startOffset||loc.endTag.endOffset!==loc.endOffset)return false;
    const contents=suffix.slice(loc.startTag.endOffset,loc.endTag.startOffset);
    const attrs=node.attribs,keys=Object.keys(attrs).sort().join(',');
    if(node.name==='a'){
      if(contents!=='Published with shiply →'||++badge!==1||beacon||keys!=='href,rel,style,target'||attrs.href!=='https://shiply.now/?ref=badge'||attrs.target!=='_blank'||attrs.rel!=='noopener'||attrs.style!==SHIPLY_BADGE_STYLE||$(node).contents().toArray().some(child=>child.type!=='text')||$(node).text()!=='Published with shiply →')return false;
    }else if(node.name==='script'){
      if(contents!==''||++beacon!==1||keys!=='crossorigin,data-cf-beacon,integrity,src,type'||attrs.type!=='module'||attrs.crossorigin!=='anonymous'||$(node).text()!==''||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(attrs.integrity)||!/^https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js(?:\/v[a-f0-9]{32,64})?$/.test(attrs.src))return false;
      let config:unknown;try{config=JSON.parse(attrs['data-cf-beacon'])}catch{return false}
      if(!config||typeof config!=='object'||Array.isArray(config))return false;
      const value=config as Record<string,unknown>;
      if(Object.keys(value).sort().join(',')!=='r,spa,token,version'||value.r!==1||value.spa!==2||typeof value.token!=='string'||! /^[a-f0-9]{32}$/.test(value.token)||typeof value.version!=='string'||!/^\d{4}\.\d{2}\.\d{1,2}$/.test(value.version))return false;
    }else return false;
  }
  return badge+beacon>0&&!suffix.slice(cursor).trim();
}
function exactPublicHtmlWithShiplyHead(actual:string,expected:string){
  const body=(value:string)=>{const matches=[...value.matchAll(/<body(?:\s[^>]*)?>[\s\S]*?<\/body>/gi)];return matches.length===1?matches[0][0]:undefined};
  const actualBody=body(actual),expectedBody=body(expected);
  if(!actualBody||!expectedBody||!actual.trimStart().toLowerCase().startsWith('<!doctype html>')||!actual.trimEnd().toLowerCase().endsWith('</html>'))return false;
  const prefix=expectedBody.slice(0,-7);
  if(!actualBody.startsWith(prefix)||!validShiplyBodySuffix(actualBody.slice(prefix.length,-7)))return false;
  // Preserve exact original body bytes. Only identified additions are removed
  // from the static comparison; the real page remains unchanged.
  const actualDocument=load(actual),wanted=load(expected);
  // A duplicate document tag outside the body slice can merge attributes into
  // the real html/body node. Check the actual full document before replacing it.
  for(const tag of ['html','body']){
    const attributes=(document:ReturnType<typeof load>)=>{const node=document(tag).get(0);return Object.entries(node&&'attribs' in node?node.attribs:{}).sort(([a],[b])=>a.localeCompare(b))};
    if(JSON.stringify(attributes(actualDocument))!==JSON.stringify(attributes(wanted)))return false;
  }
  const found=load(actual.replace(actualBody,expectedBody));
  return !found('script,style,link,base,iframe,object,embed,head > :not(title):not(meta),head meta[http-equiv]').length&&found('head > title').text()===wanted('head > title').text()&&found('head > meta[name="description"]').attr('content')===wanted('head > meta[name="description"]').attr('content');
}
function matches(context:ExecutionContext){return context.channel.id==='shiply'&&context.channel.domain==='shiply.now'&&context.channel.automation==='api'&&context.channel.articleRequired&&context.channel.accountRequired&&context.task.channelId==='shiply'&&context.task.sourceDomain==='shiply.now'}
function operationId(taskId:string){return `shiply_${taskId.toLowerCase().replace(/[^a-f0-9]/g,'')}`}
async function token(context:ExecutionContext){const account=context.getAccount();if(!validShiplyAccount(account)||account.id!==context.task.accountId)return;const value=await context.secrets.get(`account:${account.id}`);return validShiplyApiKey(value)?value:undefined}
function receipt(value:ShiplyCreateReceipt,stage:ShiplyTaskReceipt['stage']):ShiplyTaskReceipt{return {operationId:value.operationId,accountId:value.accountId,emailHash:value.emailHash,sourceHash:value.sourceHash,requestHash:value.requestHash,createdAt:value.createdAt,slug:value.slug,versionId:value.versionId,stage}}

type OwnerDetail={state:'live'|'pending'|'invalid'|'unavailable';displayName?:string};
function finalizedOwnerSummary(body:Record<string,unknown>,value:ShiplyCreateReceipt,sourceBytes:number){
  if(body.slug!==value.slug||body.status!=='live'||body.currentVersionId!==value.versionId||!Array.isArray(body.versions)||body.versions.length!==1)return false;
  const version=body.versions[0];
  return !!version&&typeof version==='object'&&!Array.isArray(version)
    &&(version as Record<string,unknown>).id===value.versionId
    &&(version as Record<string,unknown>).status==='finalized'
    &&(version as Record<string,unknown>).fileCount===1
    &&(version as Record<string,unknown>).totalBytes===sourceBytes
    &&typeof (version as Record<string,unknown>).finalizedAt==='string'
    &&Number.isFinite(Date.parse((version as Record<string,unknown>).finalizedAt as string));
}
async function ownerDetail(value:ShiplyCreateReceipt,apiKey:string,sourceHtml:string,deps:ShiplyDependencies):Promise<OwnerDetail>{
  try{const headers={accept:'application/json',authorization:`Bearer ${apiKey}`},listUrl=`${SHIPLY_ORIGIN}/api/v1/publishes`,list=await get(listUrl,headers,MAX_JSON,deps),listBody=JSON.parse(list.text) as unknown;
    const records=Array.isArray(listBody)?listBody:listBody&&typeof listBody==='object'&&!Array.isArray(listBody)?(listBody as Record<string,unknown>).sites??(listBody as Record<string,unknown>).publishes:undefined;
    if(!Array.isArray(records)||records.filter(item=>item&&typeof item==='object'&&(item as Record<string,unknown>).slug===value.slug).length!==1)return {state:'invalid'};
    const url=`${SHIPLY_ORIGIN}/api/v1/publish/${value.slug}`,result=await get(url,headers,MAX_JSON,deps);if(result.response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')return {state:'invalid'};const body=JSON.parse(result.text) as Record<string,unknown>;
    return {state:finalizedOwnerSummary(body,value,Buffer.byteLength(sourceHtml,'utf8'))?'live':'invalid'}
  }catch(error){return {state:error instanceof ReadError?error.kind:'invalid'}}
}
async function ownerState(value:ShiplyCreateReceipt,apiKey:string,sourceHtml:string,deps:ShiplyDependencies){return (await ownerDetail(value,apiKey,sourceHtml,deps)).state}
async function accepted(task:Task,context:Pick<ExecutionContext,'site'>,target:string,apiKey:string,deps:ShiplyDependencies):Promise<{status:'found';url:string;rel:string}|{status:'invalid'|'unavailable'}>{const saved=task.shiply,identity=shiplyTaskIdentity(task,context.site);if(!saved?.slug||!saved.versionId||!identity||task.accountId!==saved.accountId||task.submittedAt!==saved.createdAt||saved.sourceHash!==identity.sourceHash||saved.requestHash!==identity.requestHash||task.publicUrl!==shiplySiteUrl(saved.slug))return {status:'invalid'};const staged:ShiplyCreateReceipt={operationId:saved.operationId,accountId:saved.accountId,emailHash:saved.emailHash,sourceHash:saved.sourceHash,requestHash:saved.requestHash,createdAt:saved.createdAt,slug:saved.slug,siteUrl:task.publicUrl,versionId:saved.versionId,finalizeUrl:`${SHIPLY_ORIGIN}/api/v1/publish/${saved.slug}/finalize`,expiresAt:new Date(Date.parse(saved.createdAt)+3600_000).toISOString(),upload:{path:'index.html',method:'PUT',url:'https://placeholder.r2.cloudflarestorage.com/x?x=1',headers:{}}};const owner=await ownerDetail(staged,apiKey,identity.html,deps);if(owner.state!=='live')return {status:owner.state==='unavailable'?'unavailable':'invalid'};try{const url=task.publicUrl,robots=await get(`${url}robots.txt`,{accept:'text/plain'},MAX_ROBOTS,deps,true);if(robots.response.status===200&&(!robots.response.headers.get('content-type')?.toLowerCase().startsWith('text/plain')||!(['*','googlebot','bingbot'].every(agent=>robotsAllows(robots.text,'/',agent)))))return {status:'invalid'};const page=await get(url,{accept:'text/html'},MAX_HTML,deps);if(!page.response.headers.get('content-type')?.toLowerCase().startsWith('text/html')||!exactPublicHtmlWithShiplyHead(page.text,identity.html))return {status:'invalid'};const $=load(page.text);applyDeclaredArticleVisibility($);if(!publicPagePolicy($,url,page.response.headers.get('x-robots-tag')??'').valid)return {status:'invalid'};const checked=inspectRenderedArticle(page.text,task.draft!.body,target,'article > section',{pageUrl:url,robotsHeader:page.response.headers.get('x-robots-tag')??''});return checked.found?{status:'found',url,rel:checked.rel}:{status:'invalid'}}catch(error){return {status:error instanceof ReadError?error.kind:'unavailable'}}}

async function continueReceipt(context:ExecutionContext,value:ShiplyCreateReceipt,apiKey:string,deps:ShiplyDependencies,knownStage:ShiplyTaskReceipt['stage']=context.task.shiply?.stage??'staged'):Promise<ExecutionResult>{
  const identity=shiplyTaskIdentity(context.task,context.site)!;
  if(knownStage==='opaque_response'){await context.shiplyPersistence!.markStage(value,'staged');knownStage='staged'}
  if(knownStage==='staged'){
    const uploaded=await uploadShiplySite(value,identity.html,context.shiplyPersistence!,{...deps,signal:context.signal});
    if(uploaded!=='uploaded')return {status:uploaded==='expired'?'needs_input':'review',message:uploaded==='expired'?'shiply.now 上传时限已过；保留原提交信息':'shiply.now 原版本上传结果不明；不会重新上传',shiply:receipt(value,uploaded==='expired'?'staged':'upload_unknown'),submittedAt:value.createdAt};
    knownStage='uploaded';
  }
  if(knownStage==='uploaded'){
    const finalized=await finalizeShiplySite(value,apiKey,context.shiplyPersistence!,{...deps,signal:context.signal});
    if(finalized==='finalized')return {status:'review',message:'shiply.now 原版本已完成发布；等待所有权与公开全文验收',publicUrl:value.siteUrl,shiply:receipt(value,'api_receipt'),checkpoint:'shiply_api_receipt',submittedAt:value.createdAt};
    return {status:finalized==='expired'?'needs_input':'review',message:finalized==='expired'?'shiply.now 完成发布的时限已过；先检查原版本':'shiply.now 完成发布结果不明；不会重发',shiply:receipt(value,finalized==='expired'?'uploaded':'finalize_unknown'),submittedAt:value.createdAt};
  }
  const state=await ownerState(value,apiKey,identity.html,{...deps,signal:context.signal});
  if(state==='live'){await context.shiplyPersistence!.markStage(value,'api_receipt');return {status:'review',message:'shiply.now 同一 key 的原版本已由 owner detail 找回',publicUrl:value.siteUrl,shiply:receipt(value,'api_receipt'),checkpoint:'shiply_api_receipt',submittedAt:value.createdAt}}
  return {status:state==='unavailable'?'review':'needs_input',message:'shiply.now 原版本检查未完成；不重发写请求',shiply:receipt(value,knownStage),submittedAt:value.createdAt};
}

export async function runShiplyTask(context:ExecutionContext,deps:ShiplyDependencies={}):Promise<ExecutionResult>{if(!matches(context)||!context.shiplyPersistence)return {status:'needs_input',message:'当前任务缺少 shiply.now 的安全保存位置'};const identity=shiplyTaskIdentity(context.task,context.site),apiKey=await token(context);if(!identity)return {status:'needs_input',message:'shiply.now 仅支持带审核目标链接的完整安全静态文章'};if(!apiKey){
    const account=context.getAccount();
    const pending=account?.shiply?.stage==='code_sent'&&account.shiply.siteId===context.site.id;
    return {status:'needs_input',...(pending?{reasonCode:'email_code_pending' as const,checkpoint:'email_code_pending'}:{}),message:'请先在账号页连接已验证邮箱的 shiply.now 命名 API key'};
  }if(context.task.shiply){if(context.task.shiply.sourceHash!==identity.sourceHash||context.task.shiply.requestHash!==identity.requestHash||context.task.submittedAt!==context.task.shiply.createdAt)return {status:'needs_input',message:'shiply.now 原稿或提交信息已改变，禁止重发',shiply:context.task.shiply};if(context.task.shiply.stage==='create_unknown')return {status:'needs_input',message:'shiply.now 创建结果不明且没有可核对 slug；禁止重发或猜测',shiply:context.task.shiply,submittedAt:context.task.shiply.createdAt};const stored=await shiplyStoredReceipt(context.task,context.shiplyPersistence,deps.now?.()??new Date());if(!stored)return {status:'needs_input',message:'shiply.now 加密创建记录缺失或不符合当前契约；禁止继续写入',shiply:context.task.shiply,submittedAt:context.task.shiply.createdAt};return continueReceipt(context,stored,apiKey,deps,context.task.shiply.stage)}
  if(context.task.submittedAt||context.task.publicUrl||/^shiply_/.test(context.task.checkpoint??''))return {status:'needs_input',message:'shiply.now 提交痕迹缺少完整提交信息，禁止重发'};const account=context.getAccount();if(!validShiplyAccount(account))return {status:'needs_input',message:'请先连接稳定的 shiply.now 个人账户'};const created=await createShiplySite({operationId:operationId(context.task.id),accountId:account.id,emailHash:account.shiply.emailHash,apiKey,html:identity.html,title:context.task.draft!.title,description:context.task.draft!.description},context.shiplyPersistence,{...deps,signal:context.signal});if(created.status==='unknown')return {status:created.stage==='opaque_response'?'review':'needs_input',message:`shiply.now 创建未完成（${created.diagnostic}）；提交信息已保留且不会重发`,shiply:{...created.intent,stage:created.stage},checkpoint:`shiply_${created.stage}`,submittedAt:created.intent.createdAt};return continueReceipt(context,created.receipt,apiKey,deps)}

export async function reconcileShiplyTask(context:ExecutionContext,deps:ShiplyDependencies={}){if(!matches(context)||!context.shiplyPersistence||!context.task.shiply||context.task.shiply.stage==='create_unknown')return {status:'unknown' as const};const identity=shiplyTaskIdentity(context.task,context.site),apiKey=await token(context);if(!identity||!apiKey||context.task.shiply.sourceHash!==identity.sourceHash||context.task.shiply.requestHash!==identity.requestHash||context.task.submittedAt!==context.task.shiply.createdAt)return {status:'unknown' as const};const stored=await shiplyStoredReceipt(context.task,context.shiplyPersistence,deps.now?.()??new Date());if(!stored||await ownerState(stored,apiKey,identity.html,{...deps,signal:context.signal})!=='live')return {status:'unknown' as const};await context.shiplyPersistence.markStage(stored,'api_receipt');return {status:'found' as const,publicUrl:stored.siteUrl,shiply:receipt(stored,'api_receipt')}}
export async function verifyShiplyPublication(task:Task,site:ExecutionContext['site'],target:string,secrets:ExecutionContext['secrets'],deps:ShiplyDependencies={}):Promise<LinkResult>{const fail=(outcome:'invalid'|'unreachable',reason:string):LinkResult=>({found:false,outcome,url:task.publicUrl??SHIPLY_ORIGIN,rel:'unknown',reason});if(task.channelId!=='shiply'||task.sourceDomain!=='shiply.now'||!task.accountId||!task.shiply?.slug||!task.shiply.versionId||!['api_receipt','published'].includes(task.shiply.stage))return fail('invalid','shiply.now 缺少与个人账号和原稿绑定的认证记录');const apiKey=await secrets.get(`account:${task.accountId}`);if(!validShiplyApiKey(apiKey))return fail('invalid','shiply.now 命名 API key 不可用');const result=await accepted(task,{site},target,apiKey,deps);return result.status==='found'?{found:true,outcome:'found',url:result.url,rel:result.rel,reason:'shiply.now 个人所有权、原版本完成发布、公开全文、目标链接与抓取策略均匹配；不代表搜索收录或服务永久可用'}:fail(result.status==='unavailable'?'unreachable':'invalid',result.status==='unavailable'?'shiply.now 只读验收暂不可用':'shiply.now 账号详情里的原版本、公开内容或抓取策略不匹配')}

export const shiplyPublisherTesting={robotsAllows,exactPublicHtmlWithShiplyHead,finalizedOwnerSummary,matches,operationId,ownerState,accepted};
