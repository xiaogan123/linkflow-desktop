import {marked} from 'marked';
import {load} from 'cheerio';
import {inspectRenderedArticle} from './article-rendering';
import {fetchPublicResourceBytes,fetchPublicText,type PublicFetchDependencies} from './web';
import {submitSlugPostUi,type SlugPostBrowserDependencies} from './slugpost-browser';
import {SLUGPOST_ORIGIN,slugPostPublicUrl,parseSlugPostOpaque,type SlugPostIntent} from './slugpost';
import {slugPostTaskIdentity} from '../main/slugpost-publication';
import type {ExecutionContext,ExecutionResult,LinkResult,Site,Task,SlugPostTaskReceipt} from '../shared/types';

export interface SlugPostDependencies extends SlugPostBrowserDependencies {publicFetch?:PublicFetchDependencies;now?:()=>Date}
export type SlugPostReconcileResult={status:'found';publicUrl:string;slugPost:SlugPostTaskReceipt;verification:LinkResult}|{status:'unknown'};
function matches(c:ExecutionContext){return c.channel.id==='slugpost'&&c.channel.domain==='slugpost.com'&&c.channel.automation==='browser'&&c.channel.articleRequired&&!c.channel.accountRequired&&c.task.channelId==='slugpost'&&c.task.sourceDomain==='slugpost.com'&&!c.task.accountId}
function unsupported(value:unknown):boolean{if(Array.isArray(value))return value.some(unsupported);if(!value||typeof value!=='object')return false;const node=value as Record<string,unknown>;if(node.type==='html'||node.type==='image'||node.type==='code'&&typeof node.lang==='string'&&/^mermaid(?:\s|$)/i.test(node.lang.trim()))return true;if(node.type==='link'&&(typeof node.href!=='string'||!/^https:\/\//i.test(node.href)))return true;return Object.values(node).some(unsupported)}
export function slugPostDraftError(task:Pick<Task,'id'|'draft'|'topicUrl'>,site:Pick<Site,'url'>):string|undefined{const identity=slugPostTaskIdentity(task,site);if(!identity||!task.draft||!task.draft.title.trim()||task.draft.title.includes('\n'))return 'SlugPost 需要已审核的原创软件文档全文、标题和精确目标链接';try{if(unsupported(marked.lexer(identity.content,{gfm:true})))return 'SlugPost 仅支持普通 Markdown，不接受原始 HTML、图片、Mermaid 或相对链接'}catch{return 'SlugPost Markdown 无法解析'}}
function intent(value:SlugPostTaskReceipt):SlugPostIntent{return {operationId:value.operationId,slug:value.slug,sourceHash:value.sourceHash,requestHash:value.requestHash,createdAt:value.createdAt}}
function failure(task:Task,outcome:'invalid'|'unreachable',reason:string):LinkResult{return {found:false,outcome,url:task.publicUrl??SLUGPOST_ORIGIN,rel:'unknown',reason}}
function robotsAllows(text:string,path:string,agent:string){type Group={agents:string[];rules:{allow:boolean;pattern:string}[]};const groups:Group[]=[];let group:Group={agents:[],rules:[]};const push=()=>{if(group.agents.length)groups.push(group);group={agents:[],rules:[]}};for(const raw of text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/)){const match=raw.replace(/#.*$/,'').trim().match(/^([^:]+):\s*(.*)$/);if(!match)continue;const key=match[1].trim().toLowerCase(),value=match[2].trim();if(key==='user-agent'&&/^(?:\*|[a-z_-]+)$/i.test(value)){if(group.rules.length)push();group.agents.push(value.toLowerCase())}else if((key==='allow'||key==='disallow')&&group.agents.length&&value)group.rules.push({allow:key==='allow',pattern:value})}push();const matched=groups.map(value=>({value,score:Math.max(...value.agents.map(item=>item==='*'?0:agent.startsWith(item)?item.length:-1))})).filter(value=>value.score>=0);if(!matched.length)return true;const score=Math.max(...matched.map(value=>value.score)),rules=matched.filter(value=>value.score===score).flatMap(value=>value.value.rules);let winner:{allow:boolean;specificity:number}|undefined;for(const rule of rules){const anchored=rule.pattern.endsWith('$'),source=rule.pattern.replace(/\$$/,'').split('*').map(value=>value.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*');if(!new RegExp(`^${source}${anchored?'$':''}`).test(path))continue;const next={allow:rule.allow,specificity:Buffer.byteLength(rule.pattern)};if(!winner||next.specificity>winner.specificity||next.specificity===winner.specificity&&next.allow)winner=next}return winner?.allow??true}
export async function verifySlugPostPublication(task:Task,site:Site,target:string,deps:SlugPostDependencies={},hasOwnerReceipt=false):Promise<LinkResult>{
  const identity=slugPostTaskIdentity(task,site),saved=task.slugPost;
  if(task.channelId!=='slugpost'||!identity||!saved||saved.stage!=='ui_receipt'&&saved.stage!=='published'||saved.slug!==identity.slug||saved.sourceHash!==identity.sourceHash||saved.requestHash!==identity.requestHash||task.submittedAt!==saved.createdAt||task.publicUrl!==slugPostPublicUrl(saved.slug)||!hasOwnerReceipt)return failure(task,'invalid','SlugPost 缺少与原稿绑定的加密网页提交记录');
  try{
    const page=await fetchPublicText(task.publicUrl,deps.signal,deps.publicFetch,{allowRedirect:()=>false});if(page.url!==task.publicUrl)return failure(task,'invalid','SlugPost 公开地址被重定向');
    const robots=await fetchPublicResourceBytes(`${SLUGPOST_ORIGIN}/robots.txt`,deps.signal,deps.publicFetch,{maxBytes:64*1024,accept:'text/plain',mediaTypes:['text/plain'],redirect:'error'});
    const path=new URL(task.publicUrl).pathname;
    if(robots.status!==200||!['*','googlebot','bingbot'].every(agent=>robotsAllows(robots.body.toString('utf8'),path,agent)))return failure(task,'invalid','SlugPost 公开路径被抓取规则排除');
    const $=load(page.text);if($('div.prose').length!==1)return failure(task,'invalid','SlugPost 公开正文结构变化');
    const result=inspectRenderedArticle(page.text,identity.content,target,'div.prose',{title:task.draft?.title,pageUrl:task.publicUrl,robotsHeader:page.robotsHeader});
    return result.found?{found:true,outcome:'found',url:task.publicUrl,rel:result.rel,reason:'SlugPost 原加密记录、公开页面原文、原生目标链接与抓取规则一致；不代表搜索收录或长期保留'}:failure(task,'invalid',`SlugPost 公开全文或链接不一致：${result.reason}`);
  }catch{return failure(task,'unreachable','SlugPost 公开页检查暂未完成')}
}
export async function reconcileSlugPostTask(context:ExecutionContext,deps:SlugPostDependencies={}):Promise<SlugPostReconcileResult>{
  if(!matches(context)||!context.slugPostPersistence||!context.task.slugPost)return {status:'unknown'};
  const saved=context.task.slugPost,identity=slugPostTaskIdentity(context.task,context.site);if(!identity||saved.slug!==identity.slug||saved.sourceHash!==identity.sourceHash||saved.requestHash!==identity.requestHash||context.task.submittedAt!==saved.createdAt)return {status:'unknown'};
  const opaque=await context.slugPostPersistence.loadOpaqueResponse();if(!opaque){
    // Public text can inform a human review but never proves ownership.
    try{await fetchPublicText(slugPostPublicUrl(saved.slug),context.signal,deps.publicFetch,{allowRedirect:()=>false})}catch{}
    return {status:'unknown'};
  }
  const receipt=parseSlugPostOpaque(opaque,intent(saved),identity.content);if(!receipt){try{await fetchPublicText(slugPostPublicUrl(saved.slug),context.signal,deps.publicFetch,{allowRedirect:()=>false})}catch{}return {status:'unknown'}}
  if(saved.stage==='opaque_response'){try{await context.slugPostPersistence.promoteReceipt(receipt);context.task.slugPost={...saved,stage:'ui_receipt'};context.task.publicUrl=receipt.publicUrl}catch{return {status:'unknown'}}}
  if(!['ui_receipt','published'].includes(context.task.slugPost.stage)||context.task.publicUrl!==receipt.publicUrl)return {status:'unknown'};
  const result=await verifySlugPostPublication(context.task,context.site,identity.targetUrl,deps,true);
  return result.found?{status:'found',publicUrl:receipt.publicUrl,slugPost:{...context.task.slugPost,stage:'published'},verification:result}:{status:'unknown'};
}
/** Only the newer durable journal can prove the official editor has never been armed. */
export function slugPostPreflightNeverArmed(task:Task):boolean{return task.slugPost?.stage==='submitting'&&Array.isArray(task.slugPost.boundaryJournal)&&task.slugPost.boundaryJournal.length===0&&!task.publicUrl&&!task.firstLiveAt&&!task.verifiedAt&&task.status==='review'}
export async function runSlugPostTask(context:ExecutionContext,deps:SlugPostDependencies={}):Promise<ExecutionResult>{
  if(!matches(context)||!context.slugPostPersistence)return {status:'needs_input',message:'SlugPost 安全保存不可用'};
  const error=slugPostDraftError(context.task,context.site);if(error)return {status:'needs_input',message:error};
  const identity=slugPostTaskIdentity(context.task,context.site)!,saved=context.task.slugPost;
  if(saved&&!slugPostPreflightNeverArmed(context.task)){const recovered=await reconcileSlugPostTask(context,deps);return recovered.status==='found'?{status:'review',message:'SlugPost 原文章已凭加密记录找回',slugPost:{...context.task.slugPost!,stage:'ui_receipt'},publicUrl:recovered.publicUrl,checkpoint:'slugpost_ui_receipt',submittedAt:saved.createdAt}:{status:'review',message:'SlugPost 单次发布计划已保留；结果不明时不会再次点击',slugPost:context.task.slugPost,submittedAt:saved.createdAt,checkpoint:context.task.checkpoint,publicUrl:context.task.publicUrl}}
  if(!saved&&(context.task.submittedAt||context.task.publicUrl||/^slugpost_/.test(context.task.checkpoint??'')))return {status:'needs_input',message:'SlugPost 已有提交痕迹却缺少原提交信息，禁止重发'};
  const newIntent:SlugPostIntent=saved?intent(saved):{operationId:`slugpost_${context.task.id.replace(/-/g,'').toLowerCase()}`,slug:identity.slug,sourceHash:identity.sourceHash,requestHash:identity.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};
  try{if(saved){if(saved.slug!==identity.slug||saved.sourceHash!==identity.sourceHash||saved.requestHash!==identity.requestHash||context.task.submittedAt!==saved.createdAt||await context.slugPostPersistence.loadOpaqueResponse())throw Error('preflight intent changed');context.slugPostPersistence.assertReadyToSubmit(newIntent)}else await context.slugPostPersistence.persistIntent(newIntent)}catch{return {status:'needs_input',message:'SlugPost 原稿或审核资格未能安全保存，未点击发布'}}
  const submission=await submitSlugPostUi({intent:newIntent,content:identity.content},context.slugPostPersistence,deps);
  if(submission.status==='captured'){const receipt=parseSlugPostOpaque(submission.opaque!,newIntent,identity.content);if(receipt){try{await context.slugPostPersistence.promoteReceipt(receipt);return {status:'review',message:'SlugPost 网页提交记录已加密，等待公开页检查',slugPost:{...newIntent,stage:'ui_receipt'},publicUrl:receipt.publicUrl,checkpoint:'slugpost_ui_receipt',submittedAt:newIntent.createdAt}}catch{}}
    return {status:'review',message:'SlugPost 网页响应已加密，但结果未能确认；不会重发',slugPost:{...newIntent,stage:'opaque_response'},checkpoint:'slugpost_opaque_response',submittedAt:newIntent.createdAt};
  }
  const preflightReasons:Record<string,string>={editor_loading_timeout:'编辑器加载未完成',editor_unavailable_or_challenge:'页面要求验证或编辑器不可用',editor_changed:'编辑器页面发生变化',editor_not_ready:'编辑器尚未接受稿件',authorization_changed:'发布授权已变化',evidence_unavailable:'提交记录无法安全保存',browser_error:'编辑器打开或检查失败'};
  const preflightReason=preflightReasons[submission.reason??'']??'编辑器或授权未就绪';
  return {status:'review',message:submission.status==='not_started'?`SlugPost ${preflightReason}；未点击发布，原稿和单次提交信息保留`:'SlugPost 单次网页提交结果不明；不会重发',slugPost:{...newIntent,stage:'submitting'},checkpoint:'slugpost_create_submitting',submittedAt:newIntent.createdAt};
}
