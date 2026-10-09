import {load} from 'cheerio';
import {inspectRenderedArticle} from './article-rendering';
import {applyDeclaredArticleVisibility,elementConcealed} from './article-visibility';
import type {ExecutionContext,ExecutionResult,LinkResult,SupanoteTaskReceipt,Task} from '../shared/types';
import {
  publishSupanote,
  verifySupanote,
  type SupanoteDependencies,
  type SupanoteIntent,
  type SupanoteReceipt,
} from './supanote';

const ORIGIN='https://supanote.app';
const PUBLIC_ID=/^[A-Za-z0-9_-]{1,200}$/;
const MAX_PUBLIC_HTML_BYTES=3_000_000;
const MAX_ROBOTS_BYTES=256_000;
const RENDERED_SELECTOR='#note-view-container [data-tab-content="tab-rendered"].prose-content';
const REQUIRED_LINK_REL=new Set(['ugc','nofollow','noopener','noreferrer']);

export interface SupanoteExecutionResult extends ExecutionResult{supanote?:SupanoteTaskReceipt}
export type SupanoteReconcileResult={status:'found';publicUrl:string;supanote:SupanoteTaskReceipt}|{status:'unknown'};

function contextMatches(context:ExecutionContext):boolean{
  return context.channel.id==='supanote'&&context.channel.domain==='supanote.app'&&context.channel.kind==='article'
    &&context.channel.automation==='api'&&context.channel.articleRequired&&!context.channel.accountRequired
    &&context.task.channelId==='supanote'&&context.task.sourceDomain==='supanote.app'&&!context.task.accountId;
}

export function supanoteDraftError(draft:Task['draft']):string|undefined{
  if(!draft||typeof draft.title!=='string'||draft.title!==draft.title.trim()||!draft.title
    ||draft.title.length>200||/[\u0000-\u001f\u007f]/.test(draft.title))return 'Supanote 标题须为 1–200 个字符的单行文字';
  if(typeof draft.description!=='string'||draft.description.length>30000||typeof draft.body!=='string'
    ||draft.body!==draft.body.trim()||!draft.body||draft.body.length>30000
    ||Buffer.byteLength(draft.body,'utf8')>499999||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draft.body))
    return 'Supanote 需要未截断、可备份且不超过 30,000 字符的 Markdown 全文';
}

function operationId(taskId:string):string{return `supanote_${taskId.toLowerCase().replace(/[^a-f0-9]/g,'')}`}
function publicUrl(publicId:string):string{
  if(!PUBLIC_ID.test(publicId))throw Error('Supanote 公开文章身份无效');
  return `${ORIGIN}/n/${publicId}`;
}
function intent(saved:SupanoteTaskReceipt):SupanoteIntent{
  return {operationId:saved.operationId,contentHash:saved.contentHash,createdAt:saved.createdAt};
}
function receipt(saved:SupanoteTaskReceipt):SupanoteReceipt|undefined{
  if(!saved.publicId)return;
  return {publicId:saved.publicId,publicUrl:publicUrl(saved.publicId),contentHash:saved.contentHash};
}

class PublicReadError extends Error{constructor(readonly kind:'unavailable'|'invalid'){super(`Supanote public read ${kind}`)}}
async function abortable<T>(pending:Promise<T>,signal:AbortSignal,disposeLate?:(value:T)=>void):Promise<T>{
  if(signal.aborted){void pending.then(value=>disposeLate?.(value),()=>undefined);throw new PublicReadError('unavailable')}
  return new Promise<T>((resolve,reject)=>{
    let settled=false;
    const aborted=()=>{if(settled)return;settled=true;reject(new PublicReadError('unavailable'))};
    signal.addEventListener('abort',aborted,{once:true});
    void pending.then(value=>{if(settled){disposeLate?.(value);return}settled=true;signal.removeEventListener('abort',aborted);resolve(value)},error=>{if(settled)return;settled=true;signal.removeEventListener('abort',aborted);reject(error)});
  });
}
const normal=(value:string)=>value.normalize('NFC').replace(/\s+/gu,' ').trim();
async function publicHtml(publicId:string,deps:SupanoteDependencies):Promise<{html:string;headers:Headers}>{
  const url=publicUrl(publicId),controller=new AbortController(),externalAbort=()=>controller.abort();
  deps.signal?.addEventListener('abort',externalAbort,{once:true});if(deps.signal?.aborted)controller.abort();
  let timedOut=false,response:Response|undefined;
  const timer=setTimeout(()=>{timedOut=true;controller.abort()},Math.min(60_000,Math.max(50,deps.timeoutMs??15_000)));timer.unref?.();
  try{
    response=await abortable((deps.fetch??fetch)(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'text/html'}}),controller.signal,value=>{void value.body?.cancel().catch(()=>undefined)});
    if(controller.signal.aborted)throw new PublicReadError('unavailable');
    if(response.redirected||response.url&&response.url!==url||response.status>=300&&response.status<400)throw new PublicReadError('invalid');
    if(response.status===404||response.status===410||response.status===451)throw new PublicReadError('invalid');
    if(response.status!==200||!response.headers.get('content-type')?.toLowerCase().includes('text/html'))throw new PublicReadError(response.status>=500||response.status===408||response.status===429?'unavailable':'invalid');
    const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>MAX_PUBLIC_HTML_BYTES)throw new PublicReadError('invalid');
    const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
    if(reader)try{for(;;){const next=await abortable(reader.read(),controller.signal);if(next.done)break;size+=next.value.byteLength;if(size>MAX_PUBLIC_HTML_BYTES)throw new PublicReadError('invalid');chunks.push(next.value)}}catch(error){void reader.cancel().catch(()=>undefined);throw error}finally{reader.releaseLock()}
    let html='';try{html=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks.map(value=>Buffer.from(value))))}catch{throw new PublicReadError('invalid')}
    return {html,headers:response.headers};
  }catch(error){controller.abort();void response?.body?.cancel().catch(()=>undefined);if(error instanceof PublicReadError)throw error;if(timedOut||deps.signal?.aborted)throw new PublicReadError('unavailable');throw new PublicReadError('unavailable')}
  finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',externalAbort)}
}

async function robotsText(deps:SupanoteDependencies):Promise<string>{
  const url=`${ORIGIN}/robots.txt`,controller=new AbortController(),externalAbort=()=>controller.abort();
  deps.signal?.addEventListener('abort',externalAbort,{once:true});if(deps.signal?.aborted)controller.abort();
  let timedOut=false,response:Response|undefined;
  const timer=setTimeout(()=>{timedOut=true;controller.abort()},Math.min(60_000,Math.max(50,deps.timeoutMs??15_000)));timer.unref?.();
  try{
    response=await abortable((deps.fetch??fetch)(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'text/plain'}}),controller.signal,value=>{void value.body?.cancel().catch(()=>undefined)});
    if(controller.signal.aborted)throw new PublicReadError('unavailable');
    if(response.redirected||response.url&&response.url!==url||response.status>=300&&response.status<400)throw new PublicReadError('invalid');
    if(response.status!==200)throw new PublicReadError(response.status>=500||response.status===408||response.status===429?'unavailable':'invalid');
    const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>MAX_ROBOTS_BYTES)throw new PublicReadError('invalid');
    const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
    if(reader)try{for(;;){const next=await abortable(reader.read(),controller.signal);if(next.done)break;size+=next.value.byteLength;if(size>MAX_ROBOTS_BYTES)throw new PublicReadError('invalid');chunks.push(next.value)}}catch(error){void reader.cancel().catch(()=>undefined);throw error}finally{reader.releaseLock()}
    try{return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks.map(value=>Buffer.from(value))))}catch{throw new PublicReadError('invalid')}
  }catch(error){controller.abort();void response?.body?.cancel().catch(()=>undefined);if(error instanceof PublicReadError)throw error;if(timedOut||deps.signal?.aborted)throw new PublicReadError('unavailable');throw new PublicReadError('unavailable')}
  finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',externalAbort)}
}

function robotsAllows(text:string,path:string):boolean{
  type Rule={allow:boolean;pattern:string};type Group={agents:string[];rules:Rule[]};
  const groups:Group[]=[],push=(group:Group)=>{if(group.agents.length)groups.push(group)};let group:Group={agents:[],rules:[]};
  for(const raw of text.split(/\r?\n/)){
    const line=raw.replace(/#.*$/,'').trim(),match=line.match(/^([^:]+):\s*(.*)$/);if(!match)continue;
    const key=match[1].trim().toLowerCase(),value=match[2].trim();
    if(key==='user-agent'){if(group.rules.length){push(group);group={agents:[],rules:[]}}group.agents.push(value.toLowerCase());continue}
    if((key==='allow'||key==='disallow')&&group.agents.length&&value)group.rules.push({allow:key==='allow',pattern:value});
  }
  push(group);
  const scored=groups.map(value=>({value,specificity:Math.max(...value.agents.map(agent=>agent==='*'?0:'linkflow'.includes(agent)?agent.length:-1))})).filter(value=>value.specificity>=0);
  if(!scored.length)return true;const specificity=Math.max(...scored.map(value=>value.specificity)),rules=scored.filter(value=>value.specificity===specificity).flatMap(value=>value.value.rules);
  let winner:{allow:boolean;length:number}|undefined;
  for(const rule of rules){
    const anchored=rule.pattern.endsWith('$'),source=rule.pattern.replace(/\$$/,'').split('*').map(value=>value.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*');
    const match=path.match(new RegExp(`^${source}${anchored?'$':''}`));if(!match)continue;
    const candidate={allow:rule.allow,length:match[0].length};if(!winner||candidate.length>winner.length||candidate.length===winner.length&&candidate.allow)winner=candidate;
  }
  return winner?.allow??true;
}

function rendered(html:string,task:Task,url:string,target:string,headers:Headers):string|undefined{
  try{
    if(!task.draft)return;
    const $=load(html);applyDeclaredArticleVisibility($);
    const canonical=$('link[rel]').filter((_,node)=>($(node).attr('rel')??'').toLowerCase().split(/\s+/).includes('canonical'));
    if(canonical.length!==1||new URL(canonical.attr('href')??'',url).href!==url)return;
    const robots=$('meta[name]').filter((_,node)=>($(node).attr('name')??'').trim().toLowerCase()==='robots');
    if(robots.length!==1){return}
    const robotsTokens=new Set((robots.attr('content')??'').toLowerCase().split(/[,;\s]+/).filter(Boolean));
    if(robotsTokens.size!==2||!robotsTokens.has('index')||!robotsTokens.has('follow'))return;
    const root=$(RENDERED_SELECTOR);if(root.length!==1||$('#note-view-container').length!==1||root.toArray().some(node=>elementConcealed($,node)))return;
    for(let parent=root.parent();parent.length;parent=parent.parent())if(elementConcealed($,parent[0]))return;
    const first=root.children().first(),heading=root.children('h1');
    if(!first.is('h1')||heading.length!==1||elementConcealed($,heading[0])||normal(heading.text())!==normal(task.draft.title))return;
    heading.remove();
    const inspected=inspectRenderedArticle($.html(),task.draft.body,target,RENDERED_SELECTOR,{title:task.draft.title,pageUrl:url,robotsHeader:headers.get('x-robots-tag')??''});
    if(!inspected.found)return;
    const links=$(RENDERED_SELECTOR).find('a[href]').toArray();
    if(!links.length||links.some(node=>{const rel=new Set(($(node).attr('rel')??'').toLowerCase().split(/\s+/).filter(Boolean));return [...REQUIRED_LINK_REL].some(value=>!rel.has(value))}))return;
    return inspected.rel;
  }catch{return}
}

async function found(task:Task,target:string,deps:SupanoteDependencies):Promise<{url:string;rel:string}|undefined>{
  const saved=task.supanote,known=saved&&receipt(saved);if(!known||!task.draft)return;
  const api=await verifySupanote(known,{title:task.draft.title,markdown:task.draft.body},deps);if(!api.verified)return;
  const robots=await robotsText(deps);if(!robotsAllows(robots,new URL(known.publicUrl).pathname))return;
  const page=await publicHtml(known.publicId,deps),expectedTarget=task.topicUrl??target;
  const rel=rendered(page.html,task,known.publicUrl,expectedTarget,page.headers);return rel===undefined?undefined:{url:known.publicUrl,rel};
}

/** API readback is necessary but never sufficient for a public-page result. */
export async function reconcileSupanoteTask(context:ExecutionContext,deps:SupanoteDependencies={}):Promise<SupanoteReconcileResult>{
  if(!contextMatches(context)||!context.task.supanote||!context.task.draft)return {status:'unknown'};
  const saved=context.task.supanote,known=receipt(saved);
  if(!known||context.task.publicUrl!==known.publicUrl)return {status:'unknown'};
  try{
    const match=await found(context.task,context.site.url,{...deps,signal:context.signal});
    return match?{status:'found',publicUrl:match.url,supanote:{...saved,stage:'published'}}:{status:'unknown'};
  }catch{return {status:'unknown'}}
}

export async function verifySupanotePublication(task:Task,_target:string,deps:SupanoteDependencies={}):Promise<LinkResult>{
  const failed=(outcome:LinkResult['outcome'],reason:string):LinkResult=>({found:false,outcome,reason,url:task.publicUrl??ORIGIN,rel:'unknown'});
  const saved=task.supanote,known=saved&&receipt(saved);
  if(task.channelId!=='supanote'||task.sourceDomain!=='supanote.app'||!saved||!known||!task.draft
    ||!['api_receipt','published'].includes(saved.stage)||task.publicUrl!==known.publicUrl)
    return failed('invalid','Supanote 缺少一致的 API 回执');
  const api=await verifySupanote(known,{title:task.draft.title,markdown:task.draft.body},deps);
  if(!api.verified)return failed(api.reason==='unavailable'?'unreachable':'invalid','Supanote 原文 API 对账未通过');
  try{
    const robots=await robotsText(deps);
    if(!robotsAllows(robots,new URL(known.publicUrl).pathname))return failed('invalid','Supanote robots.txt 不允许抓取原公开文章');
    const page=await publicHtml(known.publicId,deps),rel=rendered(page.html,task,known.publicUrl,task.topicUrl??_target,page.headers);
    if(rel===undefined)return failed('invalid','Supanote 公开页标题、可见全文、链接或索引规则与原稿不一致');
    return {found:true,outcome:'found',url:known.publicUrl,rel,reason:'Supanote API 原文与公开页可见全文、全部链接及索引规则一致；不代表已被搜索引擎收录'};
  }catch(error){return failed(error instanceof PublicReadError&&error.kind==='invalid'?'invalid':'unreachable','Supanote 公开页只读核验未完成')}
}

export async function runSupanoteTask(context:ExecutionContext,deps:SupanoteDependencies={}):Promise<SupanoteExecutionResult>{
  if(!contextMatches(context)||!context.supanotePersistence)return {status:'needs_input',message:'当前任务未绑定 Supanote 安全持久化'};
  const format=supanoteDraftError(context.task.draft);if(format)return {status:'needs_input',message:format};
  const draft=context.task.draft!;
  const prior=context.task.supanote;
  if(prior){
    const known=receipt(prior),checkpoint=prior.stage==='published'?'supanote_published':prior.stage==='api_receipt'?'supanote_api_receipt':'supanote_publish_submitting';
    if(known&&context.task.publicUrl!==known.publicUrl)return {status:'needs_input',message:'Supanote 原回执与公开地址不一致，禁止重发',supanote:prior,checkpoint,submittedAt:context.task.submittedAt};
    const recovered=await reconcileSupanoteTask(context,deps);
    return recovered.status==='found'?{status:'review',message:'Supanote 原稿已通过公开页核验，没有重发',publicUrl:recovered.publicUrl,supanote:recovered.supanote,checkpoint:'supanote_published',submittedAt:context.task.submittedAt}
      :{status:'review',message:known?'Supanote 原 API 回执已保留；公开可见全文未核验，不计入成果':'Supanote 单次提交结果不明；缺少公开 ID，已停止自动请求且不会重发',supanote:prior,checkpoint,submittedAt:context.task.submittedAt,...(known?{publicUrl:known.publicUrl}:{})};
  }
  if(context.task.submittedAt||context.task.publicUrl||/^supanote_/.test(context.task.checkpoint??''))return {status:'needs_input',message:'Supanote 提交痕迹缺少完整原意图，禁止重发'};
  const result=await publishSupanote({operationId:operationId(context.task.id),reviewed:true,title:draft.title,markdown:draft.body},context.supanotePersistence,{...deps,signal:context.signal});
  if(result.status==='not_started')return {status:'queued',message:'Supanote 提交意图未持久化，未发送'};
  if(result.status==='blocked'||result.status==='uncertain')return {status:'review',message:'Supanote 单次提交已保留；结果不明且不会重发',supanote:{...result.intent,stage:'submitting'},checkpoint:'supanote_publish_submitting',submittedAt:result.intent.createdAt};
  // Persistence owns the exact operation timestamp and receipt. Returning a stale
  // reconstructed receipt here could overwrite the durable callback state.
  return {status:'review',message:result.status==='published_manage_pending'?'已保留 Supanote 公开地址；管理令牌未能安全保存，不会重发获取':'Supanote API 回执已保留；等待公开页可见全文核验',publicUrl:result.receipt.publicUrl,checkpoint:'supanote_api_receipt'};
}

export const supanotePublisherTesting={contextMatches,operationId,receipt,intent,rendered,robotsAllows};
