import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {load} from 'cheerio';
import {marked} from 'marked';
import {rentryPostSlug} from '../shared/publication';
import {normalizePublicUrl} from './web';
import {applyDeclaredArticleVisibility,styleConcealsArticle,pageRobotsDirectives} from './article-visibility';
import type {Account,ExecutionContext,ExecutionResult,LinkResult,RentryReceipt,Task} from '../shared/types';

const ORIGIN='https://rentry.co';
const AUTHOR='anonymous';
const SLUG=/^lf-[a-z0-9]{1,32}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const MAX_HTML=2_000_000;
const MAX_API=128_000;
type Json=Record<string,unknown>;
export type RentryTransport=(url:string,init:RequestInit)=>Promise<Response>;
export interface RentryDependencies {fetch?:RentryTransport;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}
export interface RentryExecutionResult extends ExecutionResult {rentry?:RentryReceipt}
export type RentryReconcileResult={status:'found';publicUrl:string;rentry:RentryReceipt}|{status:'unknown'};

class RentryError extends Error {
  constructor(readonly code:'network'|'timeout'|'cancelled'|'challenge'|'rate'|'absent'|'invalid'){
    super(`Rentry request failed (${code})`);this.name='RentryError';
  }
}
const object=(value:unknown):value is Json=>!!value&&typeof value==='object'&&!Array.isArray(value);
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const stamp=(deps:RentryDependencies)=>(deps.now?.()??new Date()).toISOString();
const pageUrl=(slug:string)=>{if(!SLUG.test(slug))throw new RentryError('invalid');return `${ORIGIN}/${slug}`};
function targetUrl(value:string):string{
  try{
    if(!/^https:\/\//i.test(value.trim()))throw Error('Absolute HTTPS required');
    const url=normalizePublicUrl(value);
    if(url.protocol!=='https:')throw Error('HTTPS required');
    return url.toString();
  }catch{throw new RentryError('invalid')}
}
function receipt(value:unknown):value is RentryReceipt{
  return object(value)&&typeof value.slug==='string'&&SLUG.test(value.slug)
    &&typeof value.contentHash==='string'&&HASH.test(value.contentHash)
    &&(value.stage==='submitting'||value.stage==='published');
}
function article(task:Task,target:string,requireApproval=true){
  const draft=task.draft;
  if(!draft||requireApproval&&!Number.isFinite(Date.parse(task.articleApprovedAt??'')))
    throw Error('Rentry 全文须先通过当前稿件核对');
  if(typeof draft.title!=='string'||!draft.title.trim()||draft.title!==draft.title.trim()
    ||draft.title.length>200||/[\u0000-\u001f\u007f<>\[\]`]/.test(draft.title))
    throw Error('Rentry 标题须为不含标记的单行文字');
  if(typeof draft.body!=='string'||draft.body!==draft.body.trim()
    ||/[\u0000-\u0008\u000b-\u001f\u007f]|<[^>]*>/.test(draft.body))
    throw Error('Rentry 全文必须是未截断、无 HTML 的 Markdown');
  const href=targetUrl(task.topicUrl??target),body=draft.body;
  const text=`# ${draft.title}\n\n${body}`;
  if(text.length>200_000||Buffer.byteLength(text,'utf8')>500_000)throw Error('Rentry 全文超出安全长度');
  const parsed=load(String(marked.parse(text,{async:false,gfm:true})));
  const paragraphs=body.split(/\n\s*\n/).filter(Boolean);
  const links=parsed('a[href]').toArray().map(el=>{
    const label=parsed(el).text().trim();
    return {label,href:targetUrl(parsed(el).attr('href')??'')};
  });
  if(parsed('h1').first().text()!==draft.title||paragraphs.length<2||parsed.root().text().replace(/\s/g,'').length<200
    ||parsed('img').length||links.some(link=>!link.label)||!links.some(link=>link.href===href))
    throw Error('Rentry 需要有独立信息价值的全文、公开 HTTPS 链接及相关目标链接');
  const contentHash=sha(JSON.stringify({title:draft.title,body,target:href}));
  const slug=rentryPostSlug(task.id,contentHash);
  if(!SLUG.test(slug))throw new RentryError('invalid');
  return {title:draft.title,body,text,target:href,contentHash,slug};
}
type Article=ReturnType<typeof article>;
function masterKey(value:string|undefined):Buffer{
  try{
    const parsed:unknown=JSON.parse(value??'null');
    if(!object(parsed)||parsed.version!==1||typeof parsed.key!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(parsed.key))
      throw Error('invalid');
    const key=Buffer.from(parsed.key,'base64url');
    if(key.length!==32||key.toString('base64url')!==parsed.key)throw Error('invalid');
    return key;
  }catch{throw new RentryError('invalid')}
}
function editCode(key:Buffer,taskId:string,contentHash:string):string{
  return createHmac('sha256',key).update(`rentry-edit-v1:\0${taskId}\0${contentHash}`).digest('base64url');
}
function contextMatches(context:ExecutionContext):boolean{
  return context.channel.id==='rentry'&&context.channel.domain==='rentry.co'
    &&context.channel.kind==='article'&&context.channel.automation==='api'&&context.channel.articleRequired
    &&context.task.channelId==='rentry'&&context.task.sourceDomain==='rentry.co';
}
async function ready(context:ExecutionContext,deps:RentryDependencies):Promise<{account:Account;key:Buffer}|ExecutionResult>{
  let account=context.getAccount();
  if(!account){
    if(context.task.accountId||context.task.rentry||context.task.submittedAt||context.task.publicUrl||context.signal.aborted)
      return {status:'needs_input',message:'Rentry 原本机身份或投稿状态待核对，不会生成替代身份'};
    const at=stamp(deps);
    account={id:randomUUID(),channelId:'rentry',email:'',username:AUTHOR,
      displayName:'本机匿名发布身份',credentialKind:'api_token',status:'registered',hasPassword:true,
      source:'generated',createdAt:at,updatedAt:at};
    const key=randomBytes(32);
    try{await context.saveAccount(account,JSON.stringify({version:1,key:key.toString('base64url')}))}
    catch{return {status:'queued',message:'Rentry 本机身份未加密保存，尚未投稿'}}
    return {account,key};
  }
  if(context.task.accountId&&context.task.accountId!==account.id||account.channelId!=='rentry'
    ||account.username!==AUTHOR||account.publicationUrl||account.credentialKind!=='api_token'
    ||account.source!=='generated'||account.status!=='registered'||!account.hasPassword)
    return {status:'needs_input',message:'Rentry 原本机发布身份不一致，其他渠道可继续'};
  try{return {account,key:masterKey(await context.secrets.get(`account:${account.id}`))}}
  catch{return {status:'needs_input',message:'Rentry 原本机密钥不可用，不能换身份投稿'}}
}
export async function prepareRentryIdentity(context:ExecutionContext,deps:RentryDependencies={}):Promise<ExecutionResult|undefined>{
  if(!contextMatches(context))return {status:'needs_input',message:'当前任务不属于 Rentry 全文发布渠道'};
  const access=await ready(context,deps);
  return 'status' in access?access:undefined;
}
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted){void promise.catch(()=>undefined);return Promise.reject(new RentryError('cancelled'))}
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(new RentryError('cancelled'))};
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value)},error=>{signal.removeEventListener('abort',abort);reject(error)});
  });
}
async function request(path:string,deps:RentryDependencies,form?:URLSearchParams):Promise<{response:Response;text:string}>{
  if(path!=='/api/new'&&(!/^\/lf-[a-z0-9]{1,32}-[a-f0-9]{12}$/.test(path)||form))
    throw new RentryError('invalid');
  if(path==='/api/new'&&!form)throw new RentryError('invalid');
  if(deps.signal?.aborted)throw new RentryError('cancelled');
  const controller=new AbortController(),abort=()=>controller.abort();
  deps.signal?.addEventListener('abort',abort,{once:true});
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort()},Math.min(60_000,Math.max(100,deps.timeoutMs??15_000)));
  timer.unref?.();
  let response:Response|undefined;
  try{
    const url=`${ORIGIN}${path}`;
    response=await abortable((deps.fetch??fetch)(url,{
      method:form?'POST':'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',
      signal:controller.signal,headers:{accept:form?'application/json':'text/html',
        'user-agent':'Linkflow (original-article publisher)',
        ...(form?{'content-type':'application/x-www-form-urlencoded'}:{})},
      ...(form?{body:form.toString()}:{})
    }),controller.signal);
    if(response.redirected||response.url&&response.url!==url||response.status>=300&&response.status<400)
      throw new RentryError('invalid');
    const maximum=form?MAX_API:MAX_HTML,declared=Number(response.headers.get('content-length'));
    if(Number.isFinite(declared)&&declared>maximum)throw new RentryError('invalid');
    const chunks:Uint8Array[]=[];let size=0;
    const reader=response.body?.getReader();
    if(reader){
      try{
        for(;;){
          const next=await abortable(reader.read(),controller.signal);
          if(next.done)break;
          size+=next.value.byteLength;
          if(size>maximum)throw new RentryError('invalid');
          chunks.push(next.value);
        }
      }catch(error){void reader.cancel().catch(()=>undefined);throw error}
      finally{reader.releaseLock()}
    }
    const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
    if(response.headers.get('cf-mitigated')==='challenge'||/cf-chl-|g-recaptcha|h-captcha|cf-turnstile/i.test(text))
      throw new RentryError('challenge');
    if(response.status===404)throw new RentryError('absent');
    if(response.status===429)throw new RentryError('rate');
    if(response.status===408||response.status>=500)throw new RentryError('network');
    if(response.status!==200)throw new RentryError('invalid');
    return {response,text};
  }catch(error){
    // Dispose bodies rejected before reader acquisition without awaiting cleanup.
    controller.abort();
    void response?.body?.cancel().catch(()=>undefined);
    if(deps.signal?.aborted)throw new RentryError('cancelled');
    if(timedOut)throw new RentryError('timeout');
    throw error instanceof RentryError?error:new RentryError('network');
  }finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort)}
}
async function createPage(expected:Article,code:string,deps:RentryDependencies):Promise<void>{
  const form=new URLSearchParams({text:expected.text,url:expected.slug,edit_code:code});
  const {response,text}=await request('/api/new',deps,form);
  if(!response.headers.get('content-type')?.includes('application/json'))throw new RentryError('invalid');
  let parsed:unknown;
  try{parsed=JSON.parse(text)}catch{throw new RentryError('invalid')}
  if(!object(parsed))throw new RentryError('invalid');
  if(parsed.captcha_url)throw new RentryError('challenge');
  if(String(parsed.status)==='429')throw new RentryError('rate');
  if(String(parsed.status)==='503')throw new RentryError('network');
  if(String(parsed.status)!=='200')throw new RentryError('invalid');
  // The official CLI reads new-page fields at the top level; keep support for
  // the documented nested envelope without weakening the original URL binding.
  const content=object(parsed.content)?parsed.content:parsed;
  if(content.url!==pageUrl(expected.slug)||content.url_short!==undefined&&content.url_short!==expected.slug
    ||content.edit_code!==undefined&&content.edit_code!==code)throw new RentryError('invalid');
}
const normal=(value:string)=>value.normalize('NFC').replace(/\s+/g,' ').trim();
function blocks(html:string,actual:boolean):{tag:string;text:string;links:{href:string;text:string}[];code:string[]}[]|undefined{
  try{
    const $=load(html);
    if(actual)applyDeclaredArticleVisibility($);
    const root=actual?$('.entry-text article > div'):$('body');
    if(actual&&(root.length!==1||$('.entry-text article').length!==1))return;
    if((actual?$('.entry-text article'):root).find('script,style,iframe,object,embed,form,input,button,img,svg,canvas,video,audio,link').length)return;
    const concealed=(node:Parameters<typeof $>[0])=>$(node).is('[hidden],[inert],[aria-hidden="true"],dialog:not([open]),details:not([open])')
      ||styleConcealsArticle($(node).attr('style')??'');
    if(actual)root.find('a.headerlink[href^="#"]').remove();
    if(actual&&(root.toArray().some(node=>concealed(node)||$(node).parents().toArray().some(concealed))
      ||root.find('*').toArray().some(node=>concealed(node))))return;
    if(root.contents().toArray().some(node=>node.type==='text'&&normal($(node).text())))return;
    const items:ReturnType<typeof blocks>=[];
    for(const node of root.children().toArray()){
      const element=$(node),tag=node.type==='tag'?node.tagName.toLowerCase():'';
      if(!/^(?:h[1-6]|p|ul|ol|blockquote|pre|table|hr)$/.test(tag)){
        if(normal(element.text()))return;
        continue;
      }
      if(!normal(element.text())&&!element.find('a').length&&tag!=='hr')continue;
      const links=element.find('a[href]').toArray().map(link=>({href:$(link).attr('href')??'',text:normal($(link).text())}));
      const code=element.find('code').toArray().map(node=>$(node).text().normalize('NFC').replace(/\r\n?/g,'\n'));
      items.push({tag,text:normal(element.text()),links,code});
    }
    return items;
  }catch{return}
}
function rendered(html:string,expected:Article,url:string,headers:Headers):{rel:string;noindex:boolean}|undefined{
  try{
    const $=load(html);
    if($('link[rel="canonical"]').length!==1||$('link[rel="canonical"]').attr('href')!==url)return;
    const expectedBlocks=blocks(String(marked.parse(expected.text,{async:false,gfm:true})),false);
    const actualBlocks=blocks(html,true);
    if(!expectedBlocks||!actualBlocks||expectedBlocks.length<3||JSON.stringify(expectedBlocks)!==JSON.stringify(actualBlocks)
      ||actualBlocks[0].tag!=='h1'||actualBlocks[0].text!==normal(expected.title))return;
    const article=$('.entry-text article > div');
    article.find('a.headerlink[href^="#"]').remove();
    const targetLinks=article.find('a[href]').filter((_,node)=>{
      try{return targetUrl($(node).attr('href')??'')===expected.target}catch{return false}
    });
    if(!targetLinks.length)return;
    const robots=pageRobotsDirectives($,headers.get('x-robots-tag')??'');
    const rel=new Set<string>();
    targetLinks.each((_,node)=>{
      for(const value of ($(node).attr('rel')??'').toLowerCase().split(/\s+/).filter(Boolean))rel.add(value);
    });
    if(robots.has('nofollow')||robots.has('none'))rel.add('nofollow');
    return {rel:[...rel].join(' ')||'follow',noindex:robots.has('noindex')||robots.has('none')};
  }catch{return}
}
async function found(expected:Article,deps:RentryDependencies):Promise<{url:string;rel:string;noindex:boolean}>{
  const url=pageUrl(expected.slug),{response,text}=await request(`/${expected.slug}`,deps);
  if(!response.headers.get('content-type')?.includes('text/html'))throw new RentryError('invalid');
  const result=rendered(text,expected,url,response.headers);
  if(!result)throw new RentryError('invalid');
  return {url,...result};
}
export async function reconcileRentryTask(context:ExecutionContext,deps:RentryDependencies={}):Promise<RentryReconcileResult>{
  const saved=context.task.rentry;
  if(!contextMatches(context)||!receipt(saved)
    ||context.task.publicUrl&&context.task.publicUrl!==pageUrl(saved.slug))return {status:'unknown'};
  try{
    const expected=article(context.task,context.site.url,false);
    if(saved.contentHash!==expected.contentHash||saved.slug!==expected.slug)return {status:'unknown'};
    const result=await found(expected,{...deps,signal:context.signal});
    return {status:'found',publicUrl:result.url,rentry:{...saved,stage:'published'}};
  }catch{return {status:'unknown'}}
}
export async function verifyRentryPublication(task:Task,target:string,deps:RentryDependencies={}):Promise<LinkResult>{
  const fail=(outcome:LinkResult['outcome'],reason:string,rel='unknown'):LinkResult=>({
    found:false,outcome,reason,url:task.publicUrl??ORIGIN,rel
  });
  try{
    const saved=task.rentry;
    if(task.channelId!=='rentry'||task.sourceDomain!=='rentry.co'||!receipt(saved)||saved.stage!=='published'
      ||task.publicUrl!==pageUrl(saved.slug))return fail('invalid','Rentry 缺少一致的已发布回执');
    const expected=article(task,target,false);
    if(saved.contentHash!==expected.contentHash||saved.slug!==expected.slug)
      return fail('invalid','Rentry 原文摘要与回执不符');
    const result=await found(expected,deps);
    if(result.noindex)return fail('invalid','Rentry 页面标记 noindex，不能作为可索引来源计数',result.rel);
    return {found:true,outcome:'found',url:result.url,rel:result.rel,
      reason:'Rentry 匿名公开页的标题、完整正文及目标链接一致；链接属性如实记录，不代表搜索收录或第三方背书'};
  }catch(error){
    return fail(error instanceof RentryError&&error.code==='absent'?'absent'
      :error instanceof RentryError&&['network','timeout','cancelled','challenge','rate'].includes(error.code)
        ?'unreachable':'invalid','Rentry 原公开全文暂未核验通过');
  }
}
export async function runRentryTask(context:ExecutionContext,deps:RentryDependencies={}):Promise<RentryExecutionResult>{
  if(!contextMatches(context))return {status:'needs_input',message:'当前渠道不支持 Rentry 全文 API'};
  const prior=context.task.rentry;
  let expected:Article;
  try{expected=article(context.task,context.site.url,!prior)}
  catch(error){return {status:'needs_input',message:error instanceof Error?error.message:'Rentry 原稿无效'}}
  if(prior){
    const priorUrl=receipt(prior)?pageUrl(prior.slug):undefined;
    const priorCheckpoint=receipt(prior)&&prior.stage==='published'?'rentry_published':'rentry_publish_submitting';
    if(priorUrl&&context.task.publicUrl&&context.task.publicUrl!==priorUrl)
      return {status:'needs_input',message:'Rentry 原回执与公开地址不一致，禁止重发',rentry:prior,
        checkpoint:priorCheckpoint,submittedAt:context.task.submittedAt};
    const result=await reconcileRentryTask(context,deps);
    if(result.status==='found'){
      try{context.checkpoint({rentry:result.rentry,checkpoint:'rentry_published',publicUrl:result.publicUrl,
        submittedAt:context.task.submittedAt})}catch{/* Original pending intent remains durable. */}
    }
    return result.status==='found'
      ?{status:'review',message:'Rentry 原投稿已找到，未再次发送',publicUrl:result.publicUrl,
        rentry:result.rentry,checkpoint:'rentry_published',submittedAt:context.task.submittedAt}
      :{status:'review',message:'Rentry 原投稿结果不明，只读核验且不会重发',
        checkpoint:priorCheckpoint,rentry:prior,submittedAt:context.task.submittedAt,
        ...(priorUrl?{publicUrl:priorUrl}:{})};
  }
  if(context.task.submittedAt||context.task.publicUrl
    ||['rentry_publish_submitting','rentry_published'].includes(context.task.checkpoint??''))
    return {status:'needs_input',message:'Rentry 投稿痕迹缺少回执，禁止重发'};
  const original=context.getAccount(),access=await ready(context,deps);
  if('status' in access)return access;
  if(!original||original.status!=='registered'||context.task.accountId!==access.account.id
    ||original.id!==access.account.id)return {status:'queued',message:'Rentry 本机身份已就绪，请先以此身份独立核对稿件'};
  if(context.signal.aborted)return {status:'queued',message:'任务已暂停，尚未投稿'};
  const saved:RentryReceipt={slug:expected.slug,contentHash:expected.contentHash,stage:'submitting'};
  const submittedAt=stamp(deps);
  try{context.checkpoint({rentry:saved,checkpoint:'rentry_publish_submitting',submittedAt})}
  catch{return {status:'queued',message:'Rentry 投稿意图未保存，未提交'}}
  try{
    await createPage(expected,editCode(access.key,context.task.id,expected.contentHash),{...deps,signal:context.signal});
  }catch(error){
    if(error instanceof RentryError&&['challenge','rate'].includes(error.code))
      return {status:'review',message:'Rentry 要求验证或限流，保留原投稿意图并停止请求；其他渠道可继续',
        rentry:saved,checkpoint:'rentry_publish_submitting',submittedAt};
    // A failed or lost response cannot prove whether the write happened.
  }
  try{
    const result=await found(expected,{...deps,signal:context.signal});
    const published:RentryReceipt={...saved,stage:'published'};
    try{context.checkpoint({rentry:published,checkpoint:'rentry_published',publicUrl:result.url,submittedAt})}
    catch{/* Pending original receipt is durable for later read-only recovery. */}
    return {status:'review',message:'Rentry 全文与匿名公开页已核验',publicUrl:result.url,
      rentry:published,checkpoint:'rentry_published',submittedAt};
  }catch{
    return {status:'review',message:'Rentry 投稿结果仍待只读核验，不会重发',
      rentry:saved,checkpoint:'rentry_publish_submitting',submittedAt};
  }
}
export const rentryTesting={article,blocks,rendered,receipt,masterKey,editCode,pageUrl,createPage};
