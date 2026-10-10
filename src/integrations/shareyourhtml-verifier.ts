import {load, type CheerioAPI} from 'cheerio';
import {applyDeclaredArticleVisibility, elementConcealed, pageRobotsDirectives} from './article-visibility';
import {renderShareYourHtmlArticle, type RenderedShareYourHtmlArticle} from './shareyourhtml-article';
import {shareYourHtmlDraftHash, shareYourHtmlSiteIdentityHash} from '../main/shareyourhtml-publication';
import {isArticleTopicUrl} from '../shared/topic-policy';
import {fetchPublicResourceBytes, type PublicFetchDependencies} from './web';
import type {Site, Task} from '../shared/types';

/** Local verifier budgets; they are not statements about ShareYourHTML service limits. */
export const SHAREYOURHTML_READBACK_MAX_HTML_BYTES=500_000;
export const SHAREYOURHTML_READBACK_MAX_ROBOTS_BYTES=128_000;
export const SHAREYOURHTML_READBACK_MAX_TARGET_LINKS=32;
export const SHAREYOURHTML_READBACK_MAX_REL_TOKENS=32;
export const SHAREYOURHTML_READBACK_MAX_TOKEN_LENGTH=64;
export const SHAREYOURHTML_READBACK_MAX_DIRECTIVES=64;
export const SHAREYOURHTML_READBACK_MAX_DIRECTIVE_LENGTH=128;

const SLUG=/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const OPERATION_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const HASH=/^[a-f0-9]{64}$/;

export interface ShareYourHtmlVerifierDependencies{
  /** Deterministic Response seam; production callers leave this undefined. */
  fetch?:(url:string,init:RequestInit)=>Promise<Response>;
  /** Deterministic DNS/native-request seam that still runs every public-fetch guard. */
  publicFetchDependencies?:PublicFetchDependencies;
  signal?:AbortSignal;
  timeoutMs?:number;
}

export type ShareYourHtmlReadbackStatus=
  'visible_match'|'invalid_binding'|'unreachable'|'invalid_response'
  |'content_mismatch'|'content_hidden'|'visibility_unknown';

export interface ShareYourHtmlReadbackResult{
  status:ShareYourHtmlReadbackStatus;
  message:string;
  publicUrl?:string;
  content:'visible'|'mismatch'|'hidden'|'unknown';
  targetLinks:Array<{href:string;rel:string[]}>;
  indexing:{
    page:'not_restricted'|'restricted'|'unknown';
    directives:string[];
    robots:'allowed'|'disallowed'|'unknown';
  };
}

interface BoundPublication{publicUrl:string;requestUrl:string;robotsUrl:string;rendered:RenderedShareYourHtmlArticle}
interface PageRead{text:string;headers:Headers}
class ReadError extends Error{constructor(readonly kind:'unreachable'|'invalid_response'){super(kind)}}

const emptyIndexing=():ShareYourHtmlReadbackResult['indexing']=>({page:'unknown',directives:[],robots:'unknown'});
function failed(status:ShareYourHtmlReadbackStatus,message:string,publicUrl?:string):ShareYourHtmlReadbackResult{
  return {status,message,...(publicUrl?{publicUrl}:{}),content:status==='content_mismatch'?'mismatch':status==='content_hidden'?'hidden':'unknown',targetLinks:[],indexing:emptyIndexing()};
}
function exactTimestamp(value:string|undefined):boolean{
  if(!value)return false;const parsed=new Date(value);return Number.isFinite(parsed.getTime())&&parsed.toISOString()===value;
}
function expectedUrl(slug:string):string{return `https://${slug}.shareyourhtml.com`}

function bind(task:Task,site:Site):BoundPublication|undefined{
  const claim=task.shareYourHtml;
  if(task.channelId!=='shareyourhtml'||task.sourceDomain!=='shareyourhtml.com'||task.accountId
    ||task.siteId!==site.id||!claim||claim.stage!=='api_receipt'||!task.draft
    ||!SLUG.test(claim.slug)||!OPERATION_ID.test(claim.operationId)
    ||!HASH.test(claim.sourceHash)||!HASH.test(claim.requestHash)
    ||!HASH.test(claim.reviewedDraftHash)||!HASH.test(claim.siteIdentityHash)
    ||!exactTimestamp(claim.createdAt)||claim.requestedExpiry!=='never'
    ||claim.publicVerification!=='pending'||claim.siteId!==site.id
    ||claim.siteIdentityHash!==shareYourHtmlSiteIdentityHash(site)
    ||claim.reviewedDraftRevision!==(task.draftRevision??0)
    ||claim.reviewedDraftHash!==shareYourHtmlDraftHash(task.draft)
    ||task.submittedAt!==claim.createdAt
    ||task.checkpoint!=='shareyourhtml_api_receipt'||task.publicUrl!==expectedUrl(claim.slug))return;
  const target=task.topicUrl??site.url;
  if(task.topicUrl&&(!isArticleTopicUrl(task.topicUrl,site)
    ||!site.topics?.some(topic=>topic.url===task.topicUrl)))return;
  try{
    const rendered=renderShareYourHtmlArticle({draft:task.draft,targetUrl:target,language:site.language,slug:claim.slug});
    if(rendered.sourceHash!==claim.sourceHash||rendered.requestHash!==claim.requestHash)return;
    const requestUrl=new URL(task.publicUrl).href;
    return {publicUrl:task.publicUrl,requestUrl,robotsUrl:new URL('/robots.txt',requestUrl).href,rendered};
  }catch{return}
}

function discard(response:Response):void{if(response.body&&!response.body.locked)void response.body.cancel().catch(()=>undefined)}
function safeTimeout(value:number|undefined):number{return typeof value==='number'&&Number.isFinite(value)?Math.min(60_000,Math.max(50,Math.floor(value))):10_000}
async function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{
  if(signal.aborted){void pending.then(value=>late?.(value),()=>undefined);throw new ReadError('unreachable')}
  return new Promise<T>((resolve,reject)=>{
    let settled=false;
    const aborted=()=>{if(settled)return;settled=true;reject(new ReadError('unreachable'))};
    signal.addEventListener('abort',aborted,{once:true});
    void pending.then(value=>{if(settled){late?.(value);return}settled=true;signal.removeEventListener('abort',aborted);resolve(value)},()=>{if(settled)return;settled=true;signal.removeEventListener('abort',aborted);reject(new ReadError('unreachable'))});
  });
}
async function boundedText(response:Response,maximum:number,signal:AbortSignal):Promise<string>{
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum)){discard(response);throw new ReadError('invalid_response')}
  if(!response.body)return '';
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{
    for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>maximum)throw new ReadError('invalid_response');chunks.push(next.value)}
  }catch(error){void reader.cancel().catch(()=>undefined);if(error instanceof ReadError)throw error;throw new ReadError(signal.aborted?'unreachable':'invalid_response')}
  finally{reader.releaseLock()}
  try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks.map(value=>Buffer.from(value))))}
  catch{throw new ReadError('invalid_response')}
}

async function fixedGet(url:string,kind:'html'|'robots',deps:ShareYourHtmlVerifierDependencies):Promise<PageRead>{
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||parsed.search||parsed.hash
    ||!SLUG.test(parsed.hostname.slice(0,-'.shareyourhtml.com'.length))
    ||!parsed.hostname.endsWith('.shareyourhtml.com')
    ||parsed.pathname!==(kind==='html'?'/':'/robots.txt'))throw new ReadError('invalid_response');
  const controller=new AbortController(),external=()=>controller.abort();
  deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();
  const timer=setTimeout(()=>controller.abort(),safeTimeout(deps.timeoutMs));timer.unref?.();
  let response:Response|undefined,handled=false;
  try{
    if(controller.signal.aborted)throw new ReadError('unreachable');
    if(!deps.fetch){
      const maximum=kind==='html'?SHAREYOURHTML_READBACK_MAX_HTML_BYTES:SHAREYOURHTML_READBACK_MAX_ROBOTS_BYTES;
      let resource:Awaited<ReturnType<typeof fetchPublicResourceBytes>>;
      try{resource=await fetchPublicResourceBytes(url,controller.signal,deps.publicFetchDependencies,{maxBytes:maximum,accept:kind==='html'?'text/html,application/xhtml+xml':'text/plain',mediaTypes:kind==='html'?['text/html','application/xhtml+xml']:['text/plain'],redirect:'error'})}
      catch(error){const message=error instanceof Error?error.message:'';if(/(?:Redirect|media type|size|Compressed|malformed)/i.test(message))throw new ReadError('invalid_response');throw error}
      if(resource.url!==url)throw new ReadError('invalid_response');
      if(resource.status!==200)throw new ReadError(resource.status>=500||resource.status===408||resource.status===429?'unreachable':'invalid_response');
      let decoded:string;try{decoded=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(resource.body)}catch{throw new ReadError('invalid_response')}
      handled=true;return {text:decoded,headers:new Headers(resource.headers)};
    }
    const transport=deps.fetch;let pending:Promise<Response>;
    try{pending=Promise.resolve(transport(url,{method:'GET',redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:kind==='html'?'text/html,application/xhtml+xml':'text/plain'}}))}
    catch{throw new ReadError('unreachable')}
    response=await abortable(pending,controller.signal,discard);
    if(controller.signal.aborted)throw new ReadError('unreachable');
    if(response.redirected||response.type==='opaqueredirect'||response.url!==url
      ||response.status>=300&&response.status<400)throw new ReadError('invalid_response');
    if(response.status!==200)throw new ReadError(response.status>=500||response.status===408||response.status===429?'unreachable':'invalid_response');
    const media=response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase();
    if(kind==='html'?!['text/html','application/xhtml+xml'].includes(media??''):media!=='text/plain')throw new ReadError('invalid_response');
    handled=true;
    return {text:await boundedText(response,kind==='html'?SHAREYOURHTML_READBACK_MAX_HTML_BYTES:SHAREYOURHTML_READBACK_MAX_ROBOTS_BYTES,controller.signal),headers:response.headers};
  }catch(error){controller.abort();if(error instanceof ReadError)throw error;throw new ReadError('unreachable')}
  finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external);if(response&&!handled)discard(response)}
}

type CanonicalNode={type:'text';value:string}|{type:'element';name:string;attributes:Record<string,string>;children:CanonicalNode[]};
type LooseNode={type?:string;name?:string;tagName?:string;data?:string;attribs?:Record<string,string>;children?:LooseNode[]};
const visibilityAttributes=new Set(['hidden','inert','aria-hidden','style','id']);
const inlineElements=new Set(['a','br','code','del','em','strong']);
const inertScriptTypes=new Set(['application/json','application/ld+json','text/plain']);
const htmlWhitespace=/[\t\n\f\r ]+/gu;
function hasInlineContent(node:LooseNode):boolean{
  if(node.type==='text')return !!(node.data??'').replace(htmlWhitespace,'');
  if(node.type!=='tag')return false;
  const name=(node.name??node.tagName??'').toLowerCase();
  return inlineElements.has(name)&&(name==='br'||(node.children??[]).some(hasInlineContent));
}
function canonical(node:LooseNode,inCode=false,siblings?:LooseNode[],index?:number):CanonicalNode|undefined{
  if(node.type==='text'){
    const value=(node.data??'').normalize('NFC');
    if(inCode)return {type:'text',value};
    const collapsed=value.replace(htmlWhitespace,' ');
    if(!collapsed.replaceAll(' ','')){
      if(!collapsed)return;
      if(siblings===undefined||index===undefined)return;
      const previous=siblings.slice(0,index).reverse().find(item=>item.type!=='comment');
      const next=siblings.slice(index+1).find(item=>item.type!=='comment');
      return previous&&next&&hasInlineContent(previous)&&hasInlineContent(next)
        ?{type:'text',value:' '}:undefined;
    }
    // Collapse HTML whitespace without trimming it from each separate text
    // node: the boundary around an inline element can change visible words.
    return {type:'text',value:collapsed};
  }
  if(node.type!=='tag')return;
  const name=(node.name??node.tagName??'').toLowerCase(),source=node.attribs??{},attributes:Record<string,string>={};
  const semantic=name==='a'?new Set(['href','title']):name==='ol'?new Set(['start']):name==='code'?new Set(['class']):(name==='th'||name==='td')?new Set(['align']):new Set<string>();
  for(const [key,value] of Object.entries(source)){
    if(semantic.has(key)){attributes[key]=value;continue}
    if(key==='rel'&&name==='a')continue;
    if(visibilityAttributes.has(key)||(key==='class'&&name!=='code'))continue;
    throw new Error('unsupported authored attribute');
  }
  const rawChildren=node.children??[];
  const children=rawChildren.map((child,childIndex)=>canonical(child,inCode||name==='pre'||name==='code',rawChildren,childIndex)).filter((value):value is CanonicalNode=>!!value);
  return {type:'element',name,attributes,children};
}
function canonicalArticle(element:unknown):string|undefined{
  try{return JSON.stringify(canonical(element as LooseNode))}catch{return}
}
function visibleWithAncestors($:CheerioAPI,element:unknown):boolean{
  let node=$(element as Parameters<CheerioAPI>[0]);
  while(node.length){if(elementConcealed($,node[0]))return false;node=node.parent()}
  return true;
}
function hasUnsupportedVisibility($:CheerioAPI,article:unknown):boolean{
  if($('*').toArray().some(node=>Object.keys($(node).attr()??{}).some(name=>/^on/i.test(name))))return true;
  if($('script').toArray().some(node=>{
    if($(node).attr('src'))return true;
    const type=($(node).attr('type')??'').trim().toLowerCase();
    // Only a small, format-defined data-block allowlist is treated as inert.
    // Unknown and legacy executable aliases remain outside static verification.
    return !inertScriptTypes.has(type);
  }))return true;
  if($('link[rel]').toArray().some(node=>($(node).attr('rel')??'').toLowerCase().split(/\s+/).includes('stylesheet'))||$('style').length)return true;
  const relevant=$(article as Parameters<CheerioAPI>[0]).add($(article as Parameters<CheerioAPI>[0]).parents()).add($(article as Parameters<CheerioAPI>[0]).find('*'));
  if(relevant.toArray().some(node=>!!($(node).attr('style')??'').trim()&&!elementConcealed($,node)))return true;
  // An unsupported inline-styled sibling may cover the article. Hidden helper
  // markup cannot, so it remains safe to ignore.
  return $('[style]').toArray().some(node=>!!($(node).attr('style')??'').trim()
    &&!elementConcealed($,node)&&!relevant.toArray().includes(node));
}

function robotsDecision(text:string,path:string):'allowed'|'disallowed'|'unknown'{
  type Rule={allow:boolean;pattern:string};type Group={agents:string[];rules:Rule[]};
  const groups:Group[]=[],push=(group:Group)=>{if(group.agents.length)groups.push(group)};let group:Group={agents:[],rules:[]};
  for(const raw of text.split(/\r?\n/)){
    const line=raw.replace(/#.*$/,'').trim();if(!line)continue;
    const match=line.match(/^([^:]+):\s*(.*)$/);if(!match)return 'unknown';
    const key=match[1].trim().toLowerCase(),value=match[2].trim();
    if(key==='user-agent'){if(!value)return 'unknown';if(group.rules.length){push(group);group={agents:[],rules:[]}}group.agents.push(value.toLowerCase());continue}
    if((key==='allow'||key==='disallow')&&group.agents.length){if(value)group.rules.push({allow:key==='allow',pattern:value});continue}
  }
  push(group);const applicable=groups.filter(value=>value.agents.includes('*'));
  if(!applicable.length)return 'allowed';let winner:{allow:boolean;length:number}|undefined;
  for(const rule of applicable.flatMap(value=>value.rules)){
    const anchored=rule.pattern.endsWith('$'),source=rule.pattern.replace(/\$$/,'').split('*').map(value=>value.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*');
    let match:RegExpMatchArray|null;try{match=path.match(new RegExp(`^${source}${anchored?'$':''}`))}catch{return 'unknown'}
    if(!match)continue;const candidate={allow:rule.allow,length:match[0].length};if(!winner||candidate.length>winner.length||candidate.length===winner.length&&candidate.allow)winner=candidate;
  }
  return winner?.allow===false?'disallowed':'allowed';
}

function inspectPage(page:PageRead,bound:BoundPublication):Omit<ShareYourHtmlReadbackResult,'publicUrl'> {
  try{
    const $=load(page.text);applyDeclaredArticleVisibility($);
    if($('meta[http-equiv]').toArray().some(node=>($(node).attr('http-equiv')??'').trim().toLowerCase()==='refresh'))
      return failed('invalid_response','ShareYourHTML 公开页包含不允许的客户端跳转');
    const blockers=$('input[type="password"],iframe,dialog[open],[role="dialog"][aria-modal="true"]').toArray();
    if(blockers.some(node=>visibleWithAncestors($,node)))
      return failed('content_mismatch','ShareYourHTML 公开页显示登录、挑战或遮挡内容');
    const canonicalLinks=$('link[rel]').toArray().filter(node=>($(node).attr('rel')??'').toLowerCase().split(/\s+/).includes('canonical'));
    if(canonicalLinks.length>1||canonicalLinks.some(node=>{try{return new URL($(node).attr('href')??'',bound.requestUrl).href!==bound.requestUrl}catch{return true}}))
      return failed('invalid_response','ShareYourHTML 公开页规范地址与回执不一致');
    const expected=load(bound.rendered.html),expectedArticle=expected('article').get(0),expectedCanonical=canonicalArticle(expectedArticle);
    if(!expectedArticle||!expectedCanonical)return failed('invalid_binding','ShareYourHTML 本地审核稿无法重建');
    if($('title').length!==1||$('title').text()!==expected('title').text()
      ||$('meta[name="description"]').length!==1
      ||$('meta[name="description"]').attr('content')!==expected('meta[name="description"]').attr('content'))
      return failed('content_mismatch','ShareYourHTML 公开页标题或摘要与审核稿不一致');
    const matches=$('article').toArray().filter(node=>canonicalArticle(node)===expectedCanonical);
    if(matches.length!==1)return failed('content_mismatch',matches.length?'ShareYourHTML 公开页包含重复审核正文':'ShareYourHTML 公开页正文与审核稿不一致');
    const article=matches[0],authored=$(article).add($(article).find('*')).toArray();
    if(!visibleWithAncestors($,article)||authored.some(node=>!visibleWithAncestors($,node)))
      return failed('content_hidden','ShareYourHTML 审核正文或其组成部分不可见');
    if(hasUnsupportedVisibility($,article))
      return failed('visibility_unknown','ShareYourHTML 页面样式超出静态可见性核验范围');
    const targetLinks=$(article).find('a[href]').toArray().filter(node=>$(node).attr('href')===bound.rendered.targetUrl).map(node=>({
      href:bound.rendered.targetUrl,
      rel:[...new Set(($(node).attr('rel')??'').toLowerCase().split(/\s+/).filter(Boolean))].sort(),
    }));
    if(!targetLinks.length)return failed('content_mismatch','ShareYourHTML 公开页缺少审核目标链接');
    const uniqueLinks=[...new Map(targetLinks.map(link=>[JSON.stringify(link),link])).values()];
    if(uniqueLinks.length>SHAREYOURHTML_READBACK_MAX_TARGET_LINKS||uniqueLinks.some(link=>link.rel.length>SHAREYOURHTML_READBACK_MAX_REL_TOKENS||link.rel.some(token=>token.length>SHAREYOURHTML_READBACK_MAX_TOKEN_LENGTH||!/^[a-z0-9_-]+$/.test(token))))
      return failed('visibility_unknown','ShareYourHTML 链接属性超出本地静态证据范围，当前可见性未知');
    const directives=[...new Set([...pageRobotsDirectives($,page.headers.get('x-robots-tag')??'')].filter(Boolean))].sort();
    if(directives.length>SHAREYOURHTML_READBACK_MAX_DIRECTIVES||directives.some(value=>value.length>SHAREYOURHTML_READBACK_MAX_DIRECTIVE_LENGTH))
      return failed('visibility_unknown','ShareYourHTML 页面索引指令超出本地静态证据范围，当前可见性未知');
    const indexing={page:directives.includes('noindex')||directives.includes('none')?'restricted' as const:'not_restricted' as const,directives,robots:'unknown' as const};
    return {status:'visible_match',message:'ShareYourHTML 公开页可见正文、结构和目标链接与审核稿一致；这不代表搜索引擎已收录或页面会永久保留',content:'visible',targetLinks:uniqueLinks,indexing};
  }catch{return failed('invalid_response','ShareYourHTML 公开 HTML 无法安全解析')}
}

/**
 * Reads only the exact receipt-derived public origin. A visible match is local
 * readback evidence; this function does not mutate a task or mark it live.
 */
export async function verifyShareYourHtmlReadback(task:Task,site:Site,deps:ShareYourHtmlVerifierDependencies={}):Promise<ShareYourHtmlReadbackResult>{
  const bound=bind(task,site);
  if(!bound)return failed('invalid_binding','ShareYourHTML API 回执、站点或审核稿绑定无效');
  const deadline=new AbortController(),external=()=>deadline.abort();
  deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)deadline.abort();
  const timer=setTimeout(()=>deadline.abort(),safeTimeout(deps.timeoutMs));timer.unref?.();
  const boundedDeps={...deps,signal:deadline.signal};
  try{
    let page:PageRead;
    try{page=await fixedGet(bound.requestUrl,'html',boundedDeps)}catch(error){const kind=error instanceof ReadError?error.kind:'unreachable';return failed(kind,kind==='unreachable'?'ShareYourHTML 公开页暂时无法完成只读核验':'ShareYourHTML 公开页响应未通过固定地址与格式校验',bound.publicUrl)}
    const inspected=inspectPage(page,bound) as ShareYourHtmlReadbackResult;inspected.publicUrl=bound.publicUrl;
    if(inspected.status!=='visible_match')return inspected;
    try{
      const robots=await fixedGet(bound.robotsUrl,'robots',boundedDeps);
      inspected.indexing.robots=robotsDecision(robots.text,'/');
    }catch{inspected.indexing.robots='unknown'}
    return inspected;
  }finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external)}
}

export const shareYourHtmlVerifierTesting={bind,canonicalArticle,robotsDecision};
