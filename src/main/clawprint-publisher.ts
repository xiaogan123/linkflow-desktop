import {randomUUID} from 'node:crypto';
import {load} from 'cheerio';
import {marked} from 'marked';
import {articleReviewStillValid} from './article-review';
import {inspectRenderedArticle} from '../integrations/article-rendering';
import type {Account,ExecutionResult,LinkResult,Task} from '../shared/types';
import type {Batch5Dependencies,Batch5Intent,Batch5OpaqueResponse,Batch5Receipt,Batch5TaskState} from '../integrations/batch5-contract';
import {batch5State,connectedDependencies,connectedRequest,hashBatch5,parseConnectedJson,
  persistBatch5Receipt,persistBatch5Response,stateFromIntent,type ConnectedContext} from '../integrations/batch5-connected';

const ORIGIN='https://clawprint.org';
const CHANNEL='clawprint';
const NAME=/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOKEN=/^[^\s\u0000-\u001f\u007f]{16,8192}$/;
interface Article {title:string;content:string;target:string;sourceHash:string;requestHash:string}
interface Post {id:number;slug:string;url:string;rawResponse:string}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const headers=(token:string):HeadersInit=>({authorization:`Bearer ${token}`,accept:'application/json'});
const unknown=(message:string):ExecutionResult=>({status:'review',reasonCode:'submission_unknown',message});

function account(context:ConnectedContext):Account|undefined{
  const value=context.getAccount();
  return value?.channelId===CHANNEL&&value.id===context.task.accountId&&value.status==='registered'
    &&value.credentialKind==='api_token'&&value.hasPassword&&value.ownerSiteId===context.site.id
    &&typeof value.username==='string'&&NAME.test(value.username)?value:undefined;
}
function postUrl(value:unknown,slug:unknown):string|undefined{
  if(typeof slug!=='string'||!SLUG.test(slug)||typeof value!=='string')return;
  try{const url=new URL(value);return url.origin===ORIGIN&&url.protocol==='https:'&&url.pathname===`/p/${slug}`
    &&!url.search&&!url.hash&&!url.username&&!url.password?url.href:undefined}catch{return}
}
function post(value:Record<string,unknown>|undefined,rawResponse:string):Post|undefined{
  if(!value||!Number.isSafeInteger(value.id)||Number(value.id)<=0)return;
  const url=postUrl(value.url,value.slug);
  return url?{id:value.id as number,slug:value.slug as string,url,rawResponse}:undefined;
}

/** Read-only identity check for the existing token connector. */
export async function probeClawprintToken(token:string,deps:Batch5Dependencies={},signal:AbortSignal=new AbortController().signal):Promise<{name:string;userId?:number}>{
  if(!TOKEN.test(token))throw Error('clawprint_token_invalid');
  const response=await connectedRequest(`${ORIGIN}/api/me`,{method:'GET',headers:headers(token)},deps,signal,16_384);
  const value=parseConnectedJson(response);
  if(response.status!==200||!value||typeof value.name!=='string'||!NAME.test(value.name))throw Error('clawprint_identity_unverified');
  const id=value.user_id??value.id;
  return {name:value.name,...(Number.isSafeInteger(id)&&Number(id)>0?{userId:id as number}:{})};
}

function article(context:ConnectedContext):Article{
  const draft=context.task.draft,targetRaw=context.task.topicUrl;
  if(context.site.category!=='software'||!draft||!targetRaw||context.channel.id!==CHANNEL)throw Error('clawprint_document_invalid');
  const target=new URL(targetRaw),source=new URL(context.site.url);
  if(target.protocol!=='https:'||source.protocol!=='https:'||target.hostname!==source.hostname||target.username||target.password
    ||target.href.length>2048)throw Error('clawprint_target_invalid');
  const title=draft.title.trim(),content=draft.body;
  if(!title||title.length>200||!content||Buffer.byteLength(content,'utf8')>120_000)throw Error('clawprint_document_invalid');
  const rendered=load(marked.parse(content,{async:false}) as string);
  const links=rendered('a[href]').toArray();
  if(links.length!==1||rendered(links[0]).attr('href')!==target.href)throw Error('clawprint_target_count');
  const request=JSON.stringify({title,content,tags:['software']});
  return {title,content,target:target.href,sourceHash:hashBatch5(JSON.stringify({title,content,target:target.href})),requestHash:hashBatch5(request)};
}
function exactArticle(context:ConnectedContext,intent:Batch5Intent):Article|undefined{
  if(intent.channelId!==CHANNEL||intent.siteId!==context.site.id)return;
  try{const value=article(context);return value.sourceHash===intent.sourceHash&&value.requestHash===intent.requestHash?value:undefined}catch{return}
}
function fromOpaque(value:Batch5OpaqueResponse|undefined,intent:Batch5Intent):Post|undefined{
  if(!value||value.status!==200||value.responseUrl!==`${ORIGIN}/api/posts`||!value.bodyComplete
    ||!/^application\/json\b/i.test(value.contentType)||JSON.stringify(value.intent)!==JSON.stringify(intent)
    ||typeof value.bodyBase64!=='string'||value.bodyBase64.length>65_536||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bodyBase64))return;
  const bytes=Buffer.from(value.bodyBase64,'base64');if(bytes.toString('base64')!==value.bodyBase64)return;
  const raw=bytes.toString('utf8');try{const parsed:unknown=JSON.parse(raw);return post(object(parsed)?parsed:undefined,raw)}catch{return}
}
function robotsAllows(body:string,path:string):boolean{
  if(body.length>16_384||!path.startsWith('/'))return false;
  type Rule={allow:boolean;pattern:string};type Group={agents:string[];rules:Rule[]};
  const groups:Group[]=[];let group:Group={agents:[],rules:[]};
  const push=()=>{if(group.agents.length)groups.push(group);group={agents:[],rules:[]}};
  for(const raw of body.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/)){
    const line=raw.replace(/#.*$/,'').trim();if(!line)continue;
    const match=/^([^:]+):\s*(.*)$/.exec(line);if(!match)continue;
    const kind=match[1].trim().toLowerCase(),value=match[2].trim();
    if(kind==='user-agent'&&/^(?:\*|[a-z_-]+)$/i.test(value)){
      if(group.rules.length)push();group.agents.push(value.toLowerCase());
    }else if((kind==='allow'||kind==='disallow')&&group.agents.length&&value){
      if(!value.startsWith('/')||value.length>512)return false;
      group.rules.push({allow:kind==='allow',pattern:value});
    }
  }
  push();
  for(const agent of ['*','googlebot','bingbot']){
    const matching=groups.map(value=>({value,score:Math.max(...value.agents.map(item=>item==='*'?0:agent.startsWith(item)?item.length:-1))}))
      .filter(value=>value.score>=0);
    if(!matching.length)continue;
    const score=Math.max(...matching.map(value=>value.score));
    let winner:{allow:boolean;specificity:number}|undefined;
    for(const rule of matching.filter(value=>value.score===score).flatMap(value=>value.value.rules)){
      const anchored=rule.pattern.endsWith('$'),source=rule.pattern.replace(/\$$/,'').split('*')
        .map(value=>value.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*');
      if(!new RegExp(`^${source}${anchored?'$':''}`).test(path))continue;
      const specificity=Buffer.byteLength(rule.pattern.replace(/[\*$]/g,''));
      if(!winner||specificity>winner.specificity||specificity===winner.specificity&&rule.allow)winner={allow:rule.allow,specificity};
    }
    if(winner&&!winner.allow)return false;
  }
  return true;
}
async function publicAccepted(url:string,doc:Article,deps:Batch5Dependencies,signal:AbortSignal):Promise<{rel:string}|undefined>{
  const page=await connectedRequest(url,{method:'GET',headers:{accept:'text/html'}},deps,signal,256_000);
  if(page.status!==200||!/^text\/html\b/i.test(page.contentType)||!deps.renderPage)return;
  const staticCheck=inspectRenderedArticle(page.body,doc.content,doc.target,'.post .entry',
    {pageUrl:url,title:doc.title,robotsHeader:page.robotsHeader});
  if(!staticCheck.found)return;
  const robots=await connectedRequest(`${ORIGIN}/robots.txt`,{method:'GET',headers:{accept:'text/plain'}},deps,signal,4096);
  if(robots.status!==200||!robotsAllows(robots.body,new URL(url).pathname))return;
  const rendered=await deps.renderPage(url,doc.target,doc.title,doc.content,signal);
  if(!rendered.found||!rendered.indexable||typeof rendered.rel!=='string')return;
  return {rel:rendered.rel};
}
async function readBack(context:ConnectedContext,doc:Article,entry:Post,deps:Batch5Dependencies):Promise<{rel:string}|undefined>{
  const response=await connectedRequest(`${ORIGIN}/api/posts/${entry.slug}`,{method:'GET',headers:{accept:'application/json'}},deps,context.signal,256_000);
  const value=parseConnectedJson(response);
  if(response.status!==200||value?.id!==entry.id||value.slug!==entry.slug||value.title!==doc.title
    ||value.content!==doc.content||value.author_name!==account(context)?.username)return;
  return publicAccepted(entry.url,doc,deps,context.signal);
}
export async function reconcileClawprintTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<{status:'found';publicUrl:string;rel:string;batch5:Batch5TaskState}|{status:'unknown'}>{
  const persistence=context.batch5Persistence,owner=account(context);if(!persistence||!owner)return {status:'unknown'};
  const intent=await persistence.loadIntent();if(!intent)return {status:'unknown'};
  const doc=exactArticle(context,intent);if(!doc)return {status:'unknown'};
  const token=await context.secrets.get(`account:${owner.id}`);if(!token||!TOKEN.test(token))return {status:'unknown'};
  try{
    const deps=connectedDependencies(context,overrides),identity=await probeClawprintToken(token,deps,context.signal);
    if(identity.name!==owner.username)return {status:'unknown'};
    const existing=await persistence.loadReceipt();if(existing&&JSON.stringify(existing.intent)!==JSON.stringify(intent))return {status:'unknown'};
    const opaque=existing?undefined:fromOpaque(await persistence.loadOpaqueResponse(),intent);
    const raw=existing?.rawResponse??opaque?.rawResponse;if(!raw)return {status:'unknown'};
    let decoded:unknown;try{decoded=JSON.parse(raw)}catch{return {status:'unknown'}}
    const entry=post(object(decoded)?decoded:undefined,raw);
    if(!entry||existing&&(existing.publicUrl!==entry.url||existing.remoteId!==String(entry.id)))return {status:'unknown'};
    const accepted=await readBack(context,doc,entry,deps);if(!accepted)return {status:'unknown'};
    const receipt=existing??{version:1,intent,publicUrl:entry.url,remoteId:String(entry.id),rawResponse:raw};
    const state=await persistBatch5Receipt(context,receipt,owner.id,String(entry.id));
    return {status:'found',publicUrl:entry.url,rel:accepted.rel,batch5:state};
  }catch{return {status:'unknown'}}
}
export async function runClawprintTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<ExecutionResult>{
  if(context.channel.id!==CHANNEL||context.task.channelId!==CHANNEL||context.channel.automation!=='api')return {status:'needs_input',message:'Clawprint 任务类型无效'};
  const persistence=context.batch5Persistence,owner=account(context);
  if(!persistence?.reserveIntent||!persistence.markSending||!persistence.assertReadyToSubmit||!owner)return {status:'needs_input',message:'Clawprint 缺少已验证账号或持久化写前闸'};
  if(await persistence.loadIntent()||batch5State(context)||context.task.submittedAt||context.task.publicUrl){
    const found=await reconcileClawprintTask(context,overrides);
    return found.status==='found'?{status:'review',message:'Clawprint 原事务只读验收完成',publicUrl:found.publicUrl,batch5:found.batch5}
      :unknown('Clawprint 原发布结果不明；不会再次 POST');
  }
  const token=await context.secrets.get(`account:${owner.id}`);if(!token||!TOKEN.test(token))return {status:'needs_input',message:'Clawprint 授权令牌无效'};
  const deps=connectedDependencies(context,overrides);
  let identity:{name:string;userId?:number};
  try{identity=await probeClawprintToken(token,deps,context.signal)}catch{return {status:'needs_input',message:'Clawprint /api/me 未核实当前账号'}}
  if(identity.name!==owner.username)return {status:'needs_input',message:'Clawprint 令牌所属账号与本地账号不符'};
  let doc:Article;
  try{if(!articleReviewStillValid(context.task,context.site,context.channel,context.settings,owner,context.getArticlePublicationContext?.()))throw Error('review_invalid');doc=article(context)}
  catch{return {status:'needs_input',reasonCode:'format_invalid',message:'Clawprint 仅接受当前单独审核通过且含唯一目标的软件原创文章'}}
  const intent:Batch5Intent={version:1,channelId:CHANNEL,operationId:randomUUID(),siteId:context.site.id,sourceHash:doc.sourceHash,
    requestHash:doc.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};
  try{await persistence.reserveIntent(intent);context.checkpoint({batch5:stateFromIntent(intent,'reserved',owner.id),checkpoint:'batch5_reserved'} as Partial<Task>)}
  catch{return {status:'needs_input',message:'Clawprint 加密发布意图未保存'}}
  try{await persistence.assertReadyToSubmit(intent);await persistence.markSending(intent);
    context.checkpoint({batch5:stateFromIntent(intent,'submitting',owner.id),checkpoint:'batch5_submitting',submittedAt:intent.createdAt} as Partial<Task>)}
  catch{return unknown('Clawprint 写前权限变化；意图已保存，仅可只读对账')}
  let response;
  try{response=await connectedRequest(`${ORIGIN}/api/posts`,{method:'POST',headers:{...headers(token),'content-type':'application/json'},
    body:JSON.stringify({title:doc.title,content:doc.content,tags:['software']})},deps,context.signal,65_536);
    await persistBatch5Response(persistence,intent,response)}
  catch{return unknown('Clawprint 发布结果不明；不会再次 POST')}
  if(response.status===429)return {status:'failed',reasonCode:'platform_rate_limited',message:'Clawprint 发布频率受限；不会重发'};
  if(response.status>=400&&response.status<500&&response.status!==408)return {status:'failed',reasonCode:'platform_rejected',message:'Clawprint 拒绝发布；不会重发'};
  if(response.status!==200)return unknown('Clawprint 发布响应状态不明；不会再次 POST');
  const entry=post(parseConnectedJson(response),response.body);if(!entry)return unknown('Clawprint 收据缺少可核对的文章标识；不会再次 POST');
  const receipt:Batch5Receipt={version:1,intent,publicUrl:entry.url,remoteId:String(entry.id),rawResponse:response.body};
  try{const state=await persistBatch5Receipt(context,receipt,owner.id,String(entry.id));
    return {status:'review',message:'Clawprint 文章收据已加密保存，待公开页验收',publicUrl:entry.url,batch5:state}}
  catch{return unknown('Clawprint 收据保存不明；不会再次 POST')}
}
export async function verifyClawprintPublication(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<LinkResult>{
  const fallback=context.task.publicUrl??ORIGIN;
  try{const found=await reconcileClawprintTask(context,overrides);
    return found.status==='found'?{found:true,outcome:'found',url:found.publicUrl,rel:found.rel,reason:'Clawprint 原创全文、账号、唯一原生目标链接及抓取条件已匿名核对',indexable:true}
      :{found:false,outcome:'unreachable',url:fallback,rel:'',reason:'Clawprint 原事务或公开页尚未通过只读验收'};
  }catch{return {found:false,outcome:'unreachable',url:fallback,rel:'',reason:'Clawprint 只读验收暂不可用'}}
}

export const clawprintTesting={postUrl,article,robotsAllows};
