import {load} from 'cheerio';
import {marked} from 'marked';
import {applyDeclaredArticleVisibility,elementConcealed} from './article-visibility';
import {inspectRenderedArticle} from './article-rendering';
import {
  compareDocsMdRawSource,
  createDocsMdShare,
  type DocsMdDependencies,
  type DocsMdIntent,
  type DocsMdReceipt,
  type DocsMdUnknownDiagnostic,
} from './docs-md';
import {docsMdTaskIdentity} from '../main/docs-md-publication';
import type {DocsMdTaskReceipt,ExecutionContext,ExecutionResult,LinkResult,Task} from '../shared/types';

const ORIGIN='https://docs-md.com';
const PUBLIC_ID=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PUBLIC_HTML_BYTES=3_000_000;
const MAX_ROBOTS_BYTES=256_000;
const REQUIRED_LINK_REL=new Set(['nofollow','ugc','noopener','noreferrer']);
const ARTICLE_SELECTOR='#markdown-content > .markdown-content';

const UNKNOWN_CREATE_MESSAGES:Record<DocsMdUnknownDiagnostic,string>={
  transport_failure:'Docs MD 单次提交已保留；传输或响应读取未完成，结果不明且不会重发',
  redirect_or_response_url:'Docs MD 单次提交已保留；响应跳转或最终地址不符合固定接口，结果不明且不会重发',
  http_status:'Docs MD 单次提交已保留；HTTP 状态未通过创建成功契约，结果不明且不会重发',
  response_body_size_or_decode:'Docs MD 单次提交已保留；响应正文大小或 UTF-8 解码未通过安全校验，结果不明且不会重发',
  response_media_type:'Docs MD 单次提交已保留；响应媒体类型不是要求的 JSON，结果不明且不会重发',
  response_json:'Docs MD 单次提交已保留；响应不是可接受的 JSON 对象，结果不明且不会重发',
  schema_success:'Docs MD 单次提交已保留；响应 success 字段不符合契约，结果不明且不会重发',
  schema_id:'Docs MD 单次提交已保留；响应 id 字段不符合契约，结果不明且不会重发',
  schema_expiry:'Docs MD 单次提交已保留；响应 expiresAt 字段不符合契约，结果不明且不会重发',
  schema_edit_token:'Docs MD 单次提交已保留；响应 editToken 字段不符合契约，结果不明且不会重发',
  schema_rate_limit:'Docs MD 单次提交已保留；响应 rateLimit.remaining 字段不符合契约，结果不明且不会重发',
  schema_url:'Docs MD 单次提交已保留；响应 url 或 rawUrl 字段不符合契约，结果不明且不会重发',
};

export interface DocsMdExecutionResult extends ExecutionResult{docsMd?:DocsMdTaskReceipt}
export type DocsMdReconcileResult={status:'found';publicUrl:string;docsMd:DocsMdTaskReceipt}|{status:'unknown'};

function contextMatches(context:ExecutionContext):boolean{
  return context.channel.id==='docs-md'&&context.channel.domain==='docs-md.com'
    &&context.channel.kind==='article'&&context.channel.automation==='api'
    &&context.channel.articleRequired&&!context.channel.accountRequired
    &&context.task.channelId==='docs-md'&&context.task.sourceDomain==='docs-md.com'
    &&!context.task.accountId;
}

function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
function unsupportedMarkdownToken(value:unknown):boolean{
  if(Array.isArray(value))return value.some(unsupportedMarkdownToken);
  if(!object(value))return false;
  if(value.type==='html'||value.type==='image')return true;
  if(value.type==='code'&&typeof value.lang==='string'&&/^mermaid(?:\s|$)/i.test(value.lang.trim()))return true;
  if(value.type==='link'&&(typeof value.href!=='string'||!/^(?:https?:\/\/|\/|#|mailto:)/i.test(value.href)))return true;
  return Object.values(value).some(unsupportedMarkdownToken);
}

export function docsMdDraftError(draft:Task['draft']):string|undefined{
  const identity=docsMdTaskIdentity({draft});
  if(!draft||!identity||draft.title.length>30000||draft.description.length>30000||draft.body.length>30000)
    return 'Docs MD 需要可备份的单行标题和完整 Markdown 正文';
  try{
    if(unsupportedMarkdownToken(marked.lexer(identity.source,{gfm:true})))
      return 'Docs MD 自动核验仅支持普通 Markdown；不接受原始 HTML、图片、Mermaid 或无法绑定的相对链接';
  }catch{return 'Docs MD Markdown 无法按固定渲染契约解析'}
}

function operationId(taskId:string):string{return `docs_md_${taskId.toLowerCase().replace(/[^a-f0-9]/g,'')}`}
function publicUrl(id:string):string{
  if(id.length>128||!PUBLIC_ID.test(id))throw Error('Docs MD 公开文章身份无效');
  return `${ORIGIN}/${id}`;
}
function rawUrl(id:string):string{return `${ORIGIN}/raw/${id}`}
function intent(saved:DocsMdTaskReceipt):DocsMdIntent{
  return {operationId:saved.operationId,sourceHash:saved.sourceHash,requestHash:saved.requestHash,createdAt:saved.createdAt};
}
function receipt(saved:DocsMdTaskReceipt):DocsMdReceipt|undefined{
  if(!saved.id)return;
  const url=publicUrl(saved.id);
  return {operationId:saved.operationId,id:saved.id,publicUrl:url,rawUrl:rawUrl(saved.id),sourceHash:saved.sourceHash,requestHash:saved.requestHash,expiresAt:0};
}

class PublicReadError extends Error{constructor(readonly kind:'unavailable'|'invalid'){super(`Docs MD public read ${kind}`)}}
function discard(response:Response):void{if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
async function abortable<T>(pending:Promise<T>,signal:AbortSignal,disposeLate?:(value:T)=>void):Promise<T>{
  if(signal.aborted){void pending.then(value=>disposeLate?.(value),()=>undefined);throw new PublicReadError('unavailable')}
  return new Promise<T>((resolve,reject)=>{
    let settled=false;
    const aborted=()=>{if(settled)return;settled=true;reject(new PublicReadError('unavailable'))};
    signal.addEventListener('abort',aborted,{once:true});
    void pending.then(value=>{if(settled){disposeLate?.(value);return}settled=true;signal.removeEventListener('abort',aborted);resolve(value)},error=>{if(settled)return;settled=true;signal.removeEventListener('abort',aborted);reject(error)});
  });
}
function safeTimeout(value:number|undefined):number{return typeof value==='number'&&Number.isFinite(value)?Math.min(60_000,Math.max(50,Math.floor(value))):15_000}
async function readBounded(response:Response,maximum:number,signal:AbortSignal):Promise<string>{
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum)){discard(response);throw new PublicReadError('invalid')}
  if(!response.body)return '';
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>maximum)throw new PublicReadError('invalid');chunks.push(next.value)}}
  catch{void reader.cancel().catch(()=>undefined);throw new PublicReadError(signal.aborted?'unavailable':'invalid')}
  finally{reader.releaseLock()}
  try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks.map(value=>Buffer.from(value))))}
  catch{throw new PublicReadError('invalid')}
}

async function fixedPublicGet(url:string,kind:'html'|'robots',deps:DocsMdDependencies):Promise<{text:string;headers:Headers}>{
  const expected=kind==='robots'?`${ORIGIN}/robots.txt`:url;
  try{
    const parsed=new URL(url);
    if(url!==expected||parsed.origin!==ORIGIN||parsed.username||parsed.password||parsed.port||parsed.search||parsed.hash
      ||kind==='html'&&!/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parsed.pathname))throw new PublicReadError('invalid');
  }catch(error){if(error instanceof PublicReadError)throw error;throw new PublicReadError('invalid')}
  const controller=new AbortController(),externalAbort=()=>controller.abort();
  deps.signal?.addEventListener('abort',externalAbort,{once:true});if(deps.signal?.aborted)controller.abort();
  const timer=setTimeout(()=>controller.abort(),safeTimeout(deps.timeoutMs));timer.unref?.();let response:Response|undefined,handled=false;
  try{
    const transport=deps.fetch??((input:string,init:RequestInit)=>fetch(input,init));
    let pending:Promise<Response>;try{pending=Promise.resolve(transport(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:kind==='html'?'text/html':'text/plain'}}))}catch{throw new PublicReadError('unavailable')}
    response=await abortable(pending,controller.signal,discard);
    if(controller.signal.aborted)throw new PublicReadError('unavailable');
    if(response.redirected||response.type==='opaqueredirect'||response.status>=300&&response.status<400||response.url&&response.url!==url)throw new PublicReadError('invalid');
    if(response.status===404||response.status===410||response.status===451)throw new PublicReadError('invalid');
    if(response.status!==200)throw new PublicReadError(response.status>=500||response.status===408||response.status===429?'unavailable':'invalid');
    const mediaType=response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase();
    if(mediaType!==(kind==='html'?'text/html':'text/plain'))throw new PublicReadError('invalid');
    handled=true;return {text:await readBounded(response,kind==='html'?MAX_PUBLIC_HTML_BYTES:MAX_ROBOTS_BYTES,controller.signal),headers:response.headers};
  }catch(error){controller.abort();if(error instanceof PublicReadError)throw error;throw new PublicReadError('unavailable')}
  finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',externalAbort);if(response&&!handled)discard(response)}
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
  const scored=groups.map(value=>({value,specificity:Math.max(...value.agents.map(agent=>agent==='*'?0:-1))})).filter(value=>value.specificity>=0);
  if(!scored.length)return true;const specificity=Math.max(...scored.map(value=>value.specificity)),rules=scored.filter(value=>value.specificity===specificity).flatMap(value=>value.value.rules);let winner:{allow:boolean;length:number}|undefined;
  for(const rule of rules){const anchored=rule.pattern.endsWith('$'),source=rule.pattern.replace(/\$$/,'').split('*').map(value=>value.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*'),match=path.match(new RegExp(`^${source}${anchored?'$':''}`));if(!match)continue;const candidate={allow:rule.allow,length:match[0].length};if(!winner||candidate.length>winner.length||candidate.length===winner.length&&candidate.allow)winner=candidate}
  return winner?.allow??true;
}

const normal=(value:string)=>value.normalize('NFC').replace(/\s+/gu,' ').trim();
function visibleWithAncestors($:ReturnType<typeof load>,value:unknown):boolean{
  let node=$(value as Parameters<typeof $>[0]);
  while(node.length){if(elementConcealed($,node[0]))return false;node=node.parent()}
  return true;
}
function visibleText($:ReturnType<typeof load>,value:unknown):string{
  const root=$(value as Parameters<typeof $>[0]);
  if(root.length!==1||!visibleWithAncestors($,root[0]))return '';
  const copy=root.clone();
  copy.find('*').each((_,node)=>{if(elementConcealed($,node))$(node).remove()});
  return normal(copy.text());
}
function exactResolvedUrl(value:string|undefined,base:string,expected:string):boolean{
  if(!value)return false;try{return new URL(value,base).href===expected}catch{return false}
}

function rendered(html:string,task:Task,url:string,expectedRawUrl:string,target:string,headers:Headers):string|undefined{
  try{
    const identity=docsMdTaskIdentity(task);if(!identity||!task.draft)return;
    const $=load(html);applyDeclaredArticleVisibility($);
    const canonical=$('link[rel]').filter((_,node)=>($(node).attr('rel')??'').toLowerCase().split(/\s+/).includes('canonical'));
    if(canonical.length!==1||!exactResolvedUrl(canonical.attr('href'),url,url))return;
    const outer=$('#markdown-content'),article=$(ARTICLE_SELECTOR);
    if(outer.length!==1||article.length!==1||outer.children('.markdown-content').length!==1
      ||!visibleWithAncestors($,outer[0])||!visibleWithAncestors($,article[0]))return;
    const blocks=article.children().toArray().filter(node=>visibleText($,node).length>0),headings=article.find('h1').toArray();
    if(!blocks.length||!$(blocks[0]).is('h1')||headings.length!==1||!visibleWithAncestors($,headings[0])
      ||visibleText($,headings[0])!==normal(task.draft.title.trim()))return;
    const card=outer.parent(),row=card.parent(),header=row.prev(),footer=row.next(),fileBar=outer.prev();
    if(card.length!==1||row.length!==1||header.length!==1||footer.length!==1||fileBar.length!==1
      ||![card[0],row[0],header[0],footer[0],fileBar[0]].every(node=>visibleWithAncestors($,node)))return;
    const badge=header.children('div'),footerText=footer.children('p');
    if(badge.length!==1||visibleText($,badge[0])!=='Permanent link'
      ||footerText.length!==1||visibleText($,footerText[0])!=='This link does not expire.')return;
    const filename=fileBar.find('h1'),rawLinks=fileBar.find('a[href]').toArray().filter(node=>visibleText($,node)==='Raw');
    if(filename.length!==1||visibleText($,filename[0])!=='publication.md'
      ||rawLinks.length!==1||!visibleWithAncestors($,rawLinks[0])
      ||!exactResolvedUrl($(rawLinks[0]).attr('href'),url,expectedRawUrl))return;
    const inspected=inspectRenderedArticle(html,identity.source,target,ARTICLE_SELECTOR,{pageUrl:url,robotsHeader:headers.get('x-robots-tag')??''});
    if(!inspected.found)return;
    for(const anchor of article.find('a[href]').toArray()){
      const href=$(anchor).attr('href')??'';if(!/^https?:\/\//i.test(href))continue;
      const rel=new Set(($(anchor).attr('rel')??'').toLowerCase().split(/\s+/).filter(Boolean));
      if([...REQUIRED_LINK_REL].some(value=>!rel.has(value)))return;
    }
    const targetRel=new Set(inspected.rel.toLowerCase().split(/\s+/).filter(Boolean));
    if([...REQUIRED_LINK_REL].some(value=>!targetRel.has(value)))return;
    return inspected.rel;
  }catch{return}
}

async function accepted(task:Task,target:string,deps:DocsMdDependencies):Promise<{status:'found';url:string;rel:string}|{status:'invalid'|'unavailable'}>{
  const saved=task.docsMd,known=saved&&receipt(saved),identity=docsMdTaskIdentity(task);
  if(!saved||!known||!identity||saved.sourceHash!==identity.sourceHash||saved.requestHash!==identity.requestHash
    ||task.submittedAt!==saved.createdAt||task.publicUrl!==known.publicUrl)return {status:'invalid'};
  const raw=await compareDocsMdRawSource(known,identity.source,deps);
  if(raw.status==='source_mismatch')return {status:'invalid'};
  if(raw.status==='source_unavailable')return {status:'unavailable'};
  try{
    const robots=await fixedPublicGet(`${ORIGIN}/robots.txt`,'robots',deps);
    if(!robotsAllows(robots.text,new URL(known.publicUrl).pathname))return {status:'invalid'};
    const page=await fixedPublicGet(known.publicUrl,'html',deps),rel=rendered(page.text,task,known.publicUrl,known.rawUrl,target,page.headers);
    return rel===undefined?{status:'invalid'}:{status:'found',url:known.publicUrl,rel};
  }catch(error){return {status:error instanceof PublicReadError?error.kind:'unavailable'}}
}

export async function reconcileDocsMdTask(context:ExecutionContext,deps:DocsMdDependencies={}):Promise<DocsMdReconcileResult>{
  if(!contextMatches(context)||!context.task.docsMd||!context.task.draft)return {status:'unknown'};
  const saved=context.task.docsMd,known=receipt(saved);
  if(!known||context.task.publicUrl!==known.publicUrl)return {status:'unknown'};
  const match=await accepted(context.task,context.task.topicUrl??context.site.url,{...deps,signal:context.signal});
  return match.status==='found'?{status:'found',publicUrl:match.url,docsMd:{...saved,stage:'published'}}:{status:'unknown'};
}

export async function verifyDocsMdPublication(task:Task,target:string,deps:DocsMdDependencies={}):Promise<LinkResult>{
  const failed=(outcome:LinkResult['outcome'],reason:string):LinkResult=>({found:false,outcome,reason,url:task.publicUrl??ORIGIN,rel:'unknown'});
  const saved=task.docsMd,known=saved&&receipt(saved);
  if(task.channelId!=='docs-md'||task.sourceDomain!=='docs-md.com'||task.accountId||!saved||!known||!task.draft
    ||!['api_receipt','published'].includes(saved.stage)||task.publicUrl!==known.publicUrl)
    return failed('invalid','Docs MD 缺少与原稿绑定的 API 回执');
  const match=await accepted(task,task.topicUrl??target,deps);
  if(match.status!=='found')return failed(match.status==='invalid'?'invalid':'unreachable',match.status==='invalid'?'原文、公开 HTML 或永久页标记与回执不一致':'Docs MD 公开页只读核验暂未完成');
  return {found:true,outcome:'found',url:match.url,rel:match.rel,reason:'Docs MD 原始 Markdown 与公开页可见全文、永久页外壳及目标链接一致；不代表已被搜索引擎收录'};
}

export async function runDocsMdTask(context:ExecutionContext,deps:DocsMdDependencies={}):Promise<DocsMdExecutionResult>{
  if(!contextMatches(context)||!context.docsMdPersistence)return {status:'needs_input',message:'当前任务未绑定 Docs MD 安全持久化'};
  const format=docsMdDraftError(context.task.draft);if(format)return {status:'needs_input',message:format};
  const identity=docsMdTaskIdentity(context.task)!;const prior=context.task.docsMd;
  if(prior){
    const known=receipt(prior),checkpoint=prior.stage==='published'?'docs_md_published':prior.stage==='api_receipt'?'docs_md_api_receipt':'docs_md_share_submitting';
    if(prior.sourceHash!==identity.sourceHash||prior.requestHash!==identity.requestHash||context.task.submittedAt!==prior.createdAt
      ||known&&context.task.publicUrl!==known.publicUrl)return {status:'needs_input',message:'Docs MD 原回执、原稿或公开地址已不一致，禁止重发',docsMd:prior,checkpoint,submittedAt:context.task.submittedAt};
    const recovered=await reconcileDocsMdTask(context,deps);
    return recovered.status==='found'?{status:'review',message:'Docs MD 原稿已通过原文与公开 HTML 核验，没有重发',publicUrl:recovered.publicUrl,docsMd:recovered.docsMd,checkpoint:'docs_md_published',submittedAt:context.task.submittedAt}
      :{status:'review',message:known?'Docs MD API 回执已保留；公开可见全文未核验，不计入成果':'Docs MD 单次提交结果不明；缺少公开 ID，已停止自动请求且不会重发',docsMd:prior,checkpoint,submittedAt:context.task.submittedAt,...(known?{publicUrl:known.publicUrl}:{})};
  }
  if(context.task.submittedAt||context.task.publicUrl||/^docs_md_/.test(context.task.checkpoint??''))return {status:'needs_input',message:'Docs MD 提交痕迹缺少完整原意图，禁止重发'};
  let submittedIntent:DocsMdIntent|undefined;
  const persistence={
    persistIntent:async(value:DocsMdIntent)=>{submittedIntent={...value};await context.docsMdPersistence!.persistIntent(value)},
    persistReceipt:(value:DocsMdReceipt)=>context.docsMdPersistence!.persistReceipt(value),
    persistEditTokenAtomically:(value:{operationId:string;id:string;editToken:string})=>context.docsMdPersistence!.persistEditTokenAtomically(value),
  };
  const result=await createDocsMdShare({operationId:operationId(context.task.id),reviewed:true,markdown:identity.source},persistence,{...deps,signal:context.signal});
  if(result.status==='not_started')return {status:'queued',message:'Docs MD 提交意图未持久化，未发送'};
  if(result.status==='blocked')return {status:'review',message:'Docs MD 单次提交已保留；结果不明且不会重发',docsMd:{...result.intent,stage:'submitting'},checkpoint:'docs_md_share_submitting',submittedAt:result.intent.createdAt};
  if(result.status==='unknown')return {status:'review',message:UNKNOWN_CREATE_MESSAGES[result.diagnostic],docsMd:{...result.intent,stage:'submitting'},checkpoint:'docs_md_share_submitting',submittedAt:result.intent.createdAt};
  if(!submittedIntent)throw Error('Docs MD API 回执缺少本地提交意图');
  return {status:'review',message:result.status==='created_persistence_unknown'?'已保留 Docs MD 公开回执；编辑令牌或持久化结果未完全确认，不会重发获取':'Docs MD API 回执已保留；等待原文与公开 HTML 核验',publicUrl:result.receipt.publicUrl,docsMd:{...submittedIntent,stage:'api_receipt',id:result.receipt.id},checkpoint:'docs_md_api_receipt',submittedAt:submittedIntent.createdAt};
}

export const docsMdPublisherTesting={contextMatches,operationId,receipt,intent,rendered,robotsAllows,unsupportedMarkdownToken};
