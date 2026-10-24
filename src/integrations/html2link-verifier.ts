import {load} from 'cheerio';
import {inspectRenderedArticle} from './article-rendering';
import {pageRobotsDirectives} from './article-visibility';
import {html2LinkHash,html2LinkRobotsUrl,parseHtml2LinkPublicUrl,trackHtml2LinkPendingOperation,type Html2LinkReceipt} from './html2link';
import type {Html2LinkRenderedArticle} from './html2link-article';

export const HTML2LINK_MAX_PUBLIC_HTML_BYTES=1_100_000;
export const HTML2LINK_MAX_ROBOTS_BYTES=256_000;

export interface Html2LinkPublicEvidence {
  version:1;
  kind:'html2link_public_evidence';
  checkedAt:string;
  publicUrl:string;
  pageStatus:number;
  pageContentType:string;
  pageHeaders:Array<[string,string]>;
  pageBodyBase64:string;
  pageBodySha256:string;
  robotsUrl:string;
  robotsStatus:number;
  robotsContentType:string;
  robotsHeaders:Array<[string,string]>;
  robotsBodyBase64:string;
  robotsBodySha256:string;
}

export interface Html2LinkPublicEvidencePersistence {persistPublicEvidence(value:Html2LinkPublicEvidence):Promise<void>}
export interface Html2LinkVerifyDependencies {
  fetch?:(url:string,init:RequestInit)=>Promise<Response>;
  signal?:AbortSignal;
  timeoutMs?:number;
  now?:()=>Date;
  evidence?:Html2LinkPublicEvidencePersistence;
}

export type Html2LinkVerification=
  |{status:'usable';publicUrl:string;rel:string;evidence:{checkedAt:string;pageBytes:number;pageSha256:string;robotsStatus:number;robotsDisposition:'declared'|'not_declared';robotsSha256:string;xRobotsTag:string;metaRobots:string[];canonical:string|null;robotsAllowed:true}}
  |{status:'invalid'|'unavailable';publicUrl:string;reason:'binding'|'page_response'|'content'|'indexing'|'canonical'|'robots'|'evidence_persistence'|'network'};

class ReadError extends Error{constructor(readonly kind:'invalid'|'unavailable'){super(kind)}}
function discard(response:Response){if(response.body&&!response.body.locked)void trackHtml2LinkPendingOperation(response.body.cancel()).catch(()=>undefined)}
function abortable<T>(pending:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T>{const tracked=trackHtml2LinkPendingOperation(pending);if(signal.aborted){void tracked.then(value=>late?.(value),()=>undefined);return Promise.reject(new ReadError('unavailable'))}return new Promise((resolve,reject)=>{let done=false;const stop=()=>{if(done)return;done=true;signal.removeEventListener('abort',stop);reject(new ReadError('unavailable'))};signal.addEventListener('abort',stop,{once:true});void tracked.then(value=>{signal.removeEventListener('abort',stop);if(done){late?.(value);return}done=true;resolve(value)},()=>{signal.removeEventListener('abort',stop);if(done)return;done=true;reject(new ReadError('unavailable'))})})}
async function bounded(response:Response,max:number,signal:AbortSignal):Promise<Uint8Array>{const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>max))throw new ReadError('invalid');if(!response.body)return new Uint8Array();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>max)throw new ReadError('invalid');parts.push(next.value)}}finally{reader.releaseLock()}return Buffer.concat(parts.map(value=>Buffer.from(value)))}
function selectedHeaders(headers:Headers):Array<[string,string]>{return ['content-type','content-length','x-robots-tag','link','cache-control','etag','last-modified'].flatMap(name=>{const value=headers.get(name);return value===null?[]:[[name,value] as [string,string]]})}
async function get(url:string,kind:'page'|'robots',expectedPublicUrl:string,deps:Html2LinkVerifyDependencies):Promise<{status:number;contentType:string;headers:Headers;bytes:Uint8Array}>{
  const page=parseHtml2LinkPublicUrl(expectedPublicUrl),expected=kind==='page'?page?.publicUrl:html2LinkRobotsUrl(expectedPublicUrl);if(!page||!expected||url!==expected)throw new ReadError('invalid');
  const controller=new AbortController(),external=()=>controller.abort();deps.signal?.addEventListener('abort',external,{once:true});if(deps.signal?.aborted)controller.abort();const timer=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(50,deps.timeoutMs??20_000)));timer.unref?.();let response:Response|undefined;
  try{const transport=deps.fetch??((input:string,init:RequestInit)=>fetch(input,init));response=await abortable(Promise.resolve(transport(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:kind==='page'?'text/html,application/xhtml+xml':'text/plain'}})),controller.signal,discard);if(response.redirected||response.type==='opaqueredirect'||response.status>=300&&response.status<400||response.url&&response.url!==url)throw new ReadError('invalid');const robotsNotDeclared=kind==='robots'&&(response.status===404||response.status===410);if(response.status!==200&&!robotsNotDeclared)throw new ReadError(response.status>=500||response.status===408||response.status===429?'unavailable':'invalid');const contentType=response.headers.get('content-type')??'',media=contentType.split(';',1)[0].trim().toLowerCase();if(!robotsNotDeclared&&(kind==='page'?!['text/html','application/xhtml+xml'].includes(media):media!=='text/plain'))throw new ReadError('invalid');return {status:response.status,contentType,headers:response.headers,bytes:await bounded(response,kind==='page'?HTML2LINK_MAX_PUBLIC_HTML_BYTES:HTML2LINK_MAX_ROBOTS_BYTES,controller.signal)}}catch(error){controller.abort();if(response)discard(response);throw error instanceof ReadError?error:new ReadError('unavailable')}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',external)}
}

function robotsAllows(text:string,path:string,agent:string):boolean{
  type Group={agents:string[];rules:{allow:boolean;pattern:string}[]};const groups:Group[]=[];let group:Group={agents:[],rules:[]};const push=()=>{if(group.agents.length)groups.push(group);group={agents:[],rules:[]}};
  for(const raw of text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/)){const line=raw.replace(/#.*$/,'').trim();if(!line)continue;const match=line.match(/^([^:]+):\s*(.*)$/);if(!match)return false;const key=match[1].trim().toLowerCase(),value=match[2].trim();if(key==='user-agent'){if(!/^(?:\*|[a-z0-9_-]+)$/i.test(value))return false;if(group.rules.length)push();group.agents.push(value.toLowerCase())}else if(key==='allow'||key==='disallow'){if(!group.agents.length)return false;if(value)group.rules.push({allow:key==='allow',pattern:value})}}push();
  const matched=groups.map(value=>({value,score:Math.max(...value.agents.map(item=>item==='*'?0:agent.startsWith(item)?item.length:-1))})).filter(value=>value.score>=0);if(!matched.length)return true;const score=Math.max(...matched.map(value=>value.score));let winner:{allow:boolean;specificity:number}|undefined;
  for(const rule of matched.filter(value=>value.score===score).flatMap(value=>value.value.rules)){const anchored=rule.pattern.endsWith('$'),source=rule.pattern.replace(/\$$/,'').split('*').map(value=>value.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*');let hit=false;try{hit=new RegExp(`^${source}${anchored?'$':''}`).test(path)}catch{return false}if(!hit)continue;const next={allow:rule.allow,specificity:Buffer.byteLength(rule.pattern.replace(/\*|\$$/g,''))};if(!winner||next.specificity>winner.specificity||next.specificity===winner.specificity&&next.allow)winner=next}return winner?.allow!==false;
}

export async function verifyHtml2LinkPublication(receipt:Html2LinkReceipt,article:Html2LinkRenderedArticle,deps:Html2LinkVerifyDependencies={}):Promise<Html2LinkVerification>{
  const known=parseHtml2LinkPublicUrl(receipt.publicUrl);if(!known||known.slug!==receipt.slug||receipt.sourceHash!==article.sourceHash||receipt.requestHash!==article.requestHash)return {status:'invalid',publicUrl:receipt.publicUrl,reason:'binding'};
  const robotsUrl=html2LinkRobotsUrl(receipt.publicUrl)!;let page:Awaited<ReturnType<typeof get>>,robots:Awaited<ReturnType<typeof get>>;try{[page,robots]=await Promise.all([get(receipt.publicUrl,'page',receipt.publicUrl,deps),get(robotsUrl,'robots',receipt.publicUrl,deps)])}catch(error){return {status:error instanceof ReadError&&error.kind==='invalid'?'invalid':'unavailable',publicUrl:receipt.publicUrl,reason:error instanceof ReadError&&error.kind==='invalid'?'page_response':'network'}}
  let html:string,robotsText='';try{html=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(page.bytes);if(robots.status===200)robotsText=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(robots.bytes)}catch{return {status:'invalid',publicUrl:receipt.publicUrl,reason:'page_response'}}
  const checkedAt=(deps.now?.()??new Date()).toISOString(),evidence:Html2LinkPublicEvidence={version:1,kind:'html2link_public_evidence',checkedAt,publicUrl:receipt.publicUrl,pageStatus:page.status,pageContentType:page.contentType,pageHeaders:selectedHeaders(page.headers),pageBodyBase64:Buffer.from(page.bytes).toString('base64'),pageBodySha256:html2LinkHash(page.bytes),robotsUrl,robotsStatus:robots.status,robotsContentType:robots.contentType,robotsHeaders:selectedHeaders(robots.headers),robotsBodyBase64:Buffer.from(robots.bytes).toString('base64'),robotsBodySha256:html2LinkHash(robots.bytes)};
  if(deps.evidence)try{await deps.evidence.persistPublicEvidence(evidence)}catch{return {status:'unavailable',publicUrl:receipt.publicUrl,reason:'evidence_persistence'}}
  const $=load(html),directives=[...pageRobotsDirectives($,page.headers.get('x-robots-tag')??'')].sort(),metaRobots=$('meta[name]').toArray().filter(node=>['robots','googlebot','bingbot'].includes(($(node).attr('name')??'').trim().toLowerCase())).map(node=>`${($(node).attr('name')??'').trim().toLowerCase()}:${$(node).attr('content')??''}`),canonicals=$('link[rel]').toArray().filter(node=>($(node).attr('rel')??'').toLowerCase().split(/\s+/).includes('canonical')).map(node=>{try{return new URL($(node).attr('href')??'',receipt.publicUrl).href}catch{return ''}});
  // This adapter publishes passive documents. Static checks cannot validate a
  // script or fetched stylesheet that later removes or conceals the article.
  const activeContent=$('script,style,iframe,object,embed,base,svg,math,template').length>0
    ||$('link[rel]').toArray().some(node=>($(node).attr('rel')??'').toLowerCase().split(/\s+/).includes('stylesheet'))
    ||$('*').toArray().some(node=>Object.keys((node as {attribs?:Record<string,string>}).attribs??{}).some(name=>/^on/i.test(name)||['srcdoc','style'].includes(name.toLowerCase())));
  if(activeContent)return {status:'invalid',publicUrl:receipt.publicUrl,reason:'content'};
  const headerCanonical:string[]=[];
  for(const item of (page.headers.get('link')??'').split(',')){
    const relation=item.match(/;\s*rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s,]+))/i);
    if(!relation||!(relation[1]??relation[2]??relation[3]).toLowerCase().split(/\s+/).includes('canonical'))continue;
    const href=item.trim().match(/^<([^>]+)>/);
    try{headerCanonical.push(href?new URL(href[1],receipt.publicUrl).href:'')}catch{headerCanonical.push('')}
  }
  if(headerCanonical.some(value=>value!==receipt.publicUrl))return {status:'invalid',publicUrl:receipt.publicUrl,reason:'canonical'};
  if(directives.includes('noindex')||directives.includes('none'))return {status:'invalid',publicUrl:receipt.publicUrl,reason:'indexing'};
  if(canonicals.length>1||canonicals.some(value=>value!==receipt.publicUrl))return {status:'invalid',publicUrl:receipt.publicUrl,reason:'canonical'};
  const robotsDisposition=robots.status===200?'declared':'not_declared';
  if(robotsDisposition==='declared'&&!['*','googlebot','bingbot'].every(agent=>robotsAllows(robotsText,new URL(receipt.publicUrl).pathname,agent)))return {status:'invalid',publicUrl:receipt.publicUrl,reason:'robots'};
  const inspected=inspectRenderedArticle(html,article.markdown,article.targetUrl,'main > article > section',{pageUrl:receipt.publicUrl,robotsHeader:page.headers.get('x-robots-tag')??''});if(!inspected.found)return {status:'invalid',publicUrl:receipt.publicUrl,reason:'content'};
  return {status:'usable',publicUrl:receipt.publicUrl,rel:inspected.rel,evidence:{checkedAt,pageBytes:page.bytes.byteLength,pageSha256:evidence.pageBodySha256,robotsStatus:robots.status,robotsDisposition,robotsSha256:evidence.robotsBodySha256,xRobotsTag:page.headers.get('x-robots-tag')??'',metaRobots,canonical:canonicals[0]??headerCanonical[0]??null,robotsAllowed:true}};
}

export const html2LinkVerifierTesting={robotsAllows,selectedHeaders};
