import {randomUUID} from 'node:crypto';
import {load} from 'cheerio';
import {inspectRenderedArticle} from './article-rendering';
import type {Account,ExecutionContext,ExecutionResult,LinkResult,ShellbookTaskReceipt,Site,Task} from '../shared/types';
import {
  SHELLBOOK_ME,
  SHELLBOOK_ORIGIN,
  SHELLBOOK_POSTS,
  SHELLBOOK_REGISTER,
  SHELLBOOK_ROBOTS,
  parseShellbookAgent,
  parseShellbookCreateReceipt,
  parseShellbookOpaque,
  parseShellbookPost,
  parseShellbookRegistration,
  parseShellbookSearchCandidates,
  readShellbookJson,
  readShellbookStatus,
  shellbookHash,
  shellbookMutation,
  shellbookPostApiUrl,
  shellbookPostRequest,
  shellbookProfileUrl,
  shellbookRecoveryEvidenceMatches,
  shellbookRegistrationRequest,
  shellbookSearchUrl,
  validShellbookAccountSecret,
  validShellbookPageSecret,
  type ShellbookAccountSecret,
  type ShellbookCreateReceipt,
  type ShellbookCreateRecoveryEvidence,
  type ShellbookDependencies,
  type ShellbookPageSecret,
  type ShellbookPost,
  type ShellbookRecoveryBinding,
  type ShellbookRecoveryEvidence,
  type ShellbookSearchCandidate,
  type ShellbookSearchRecoveryEvidence,
} from './shellbook';

const DESCRIPTION='Human-operated AI assistant for the LinkFlow maintainer. Shares practical engineering notes and discloses project affiliations. No autonomous financial activity.';
const SUBSHELL='agents';
const JSON_HEADERS={accept:'application/json','content-type':'application/json'};
const operation=(prefix:string,id:string)=>`${prefix}_${id.replace(/-/g,'').toLowerCase()}`;
const exactTarget=(task:Pick<Task,'topicUrl'>,site:Pick<Site,'url'>)=>task.topicUrl??site.url;

function identity(task:Pick<Task,'draft'|'topicUrl'>,site:Pick<Site,'url'>){
  if(!task.draft)return;const {title,body}=task.draft,targetUrl=exactTarget(task,site);
  if(title!==title.trim()||title.length<1||title.length>300||body!==body.trimStart()||body.replace(/\n$/,'')!==body.trimEnd()||body.trimEnd().length<10||body.length>40_000)return;
  try{const target=new URL(targetUrl);if(target.protocol!=='https:'||target.username||target.password||target.port||target.hash)return}catch{return}
  const links=[...body.matchAll(/\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/g)].map(match=>match[1]);if(links.filter(value=>value===targetUrl).length!==1)return;
  const request=shellbookPostRequest(title,body,targetUrl,SUBSHELL);return {title,body,targetUrl,sourceHash:request.sourceHash,requestHash:request.requestHash};
}

export function shellbookTaskIdentity(task:Pick<Task,'draft'|'topicUrl'>,site:Pick<Site,'url'>){return identity(task,site)}
function matches(context:ExecutionContext){return context.channel.id==='shellbook'&&context.channel.domain==='shellbook.io'&&context.channel.automation==='api'&&context.channel.kind==='article'&&context.channel.accountRequired&&context.channel.articleRequired&&context.task.channelId==='shellbook'&&context.task.sourceDomain==='shellbook.io'}
function accountValid(account:Account|undefined){const proof=account?.shellbook;return !!account&&account.channelId==='shellbook'&&account.credentialKind==='api_token'&&account.status==='registered'&&account.hasPassword&&account.email===''&&account.source==='generated'&&account.registrationAttempts===1&&!!proof&&proof.stage==='ready'&&proof.agentName===account.username&&!!proof.agentId&&!!proof.tokenFingerprint}
export function validShellbookAccount(account:Account|undefined):boolean{return !!accountValid(account)}
const tokenFingerprint=(token:string)=>shellbookHash(token);
function parseAccountSecret(raw:string|undefined):ShellbookAccountSecret|undefined{if(!raw)return;try{const value=JSON.parse(raw);return validShellbookAccountSecret(value)?value:undefined}catch{return}}
function parsePageSecret(raw:string|undefined):ShellbookPageSecret|undefined{if(!raw)return;try{const value=JSON.parse(raw);return validShellbookPageSecret(value)?value:undefined}catch{return}}
function authorize(context:ExecutionContext,value:Parameters<NonNullable<ExecutionContext['authorizeShellbookMutation']>>[0]):true{if(!context.authorizeShellbookMutation)throw Error('Shellbook mutation guard unavailable');return context.authorizeShellbookMutation(value)}
function accountShape(id:string,name:string,createdAt:string,requestHash:string,stage:'intent'|'opaque_response'|'ready',extra:Partial<NonNullable<Account['shellbook']>>={}):Account{return {id,channelId:'shellbook',email:'',username:name,displayName:'LinkFlow human-operated assistant',createdAt,status:stage==='ready'?'registered':stage==='intent'?'draft':'unknown',hasPassword:true,source:'generated',credentialKind:'api_token',registrationAttempts:1,shellbook:{version:1,stage,operationId:operation('shellbook_register',id),requestHash,agentName:name,description:DESCRIPTION,...extra}}}

export async function prepareShellbookIdentity(context:ExecutionContext,deps:ShellbookDependencies=context.shellbookDependencies??{}):Promise<ExecutionResult|undefined>{
  if(!matches(context))return {status:'needs_input',message:'当前渠道规格不支持 Shellbook'};let account=context.getAccount();if(accountValid(account))return;if(account&&account.channelId!=='shellbook')return {status:'needs_input',message:'Shellbook 任务绑定了不相容账号'};
  let secret:ShellbookAccountSecret|undefined;
  if(account){secret=parseAccountSecret(await context.secrets.get(`account:${account.id}`));if(!secret||secret.operationId!==account.shellbook?.operationId||secret.requestHash!==account.shellbook.requestHash||secret.name!==account.username)return {status:'needs_input',checkpoint:'account_handoff',message:'Shellbook 原注册事务缺少可核对的本机加密记录；不会创建第二个身份。'};if(!secret.opaqueResponse)return {status:'needs_input',checkpoint:'account_handoff',message:'Shellbook 单次注册结果未知；固定身份已保留，不会重试注册或换名。'}}
  else{
    const id=deps.fixedAccountId??randomUUID();if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))throw Error('Shellbook 固定本机身份 ID 无效');const name=`linkflow-${id.replace(/-/g,'').slice(0,16)}`,createdAt=(deps.now?.()??new Date()).toISOString(),request=shellbookRegistrationRequest(name,DESCRIPTION),profile=await readShellbookStatus(shellbookProfileUrl(name),undefined,{...deps,signal:context.signal});
    if(profile.status!==404)return {status:'needs_input',checkpoint:'account_handoff',message:'Shellbook 固定名称已存在，但本机没有对应凭据；不会接管、换名或注册第二个身份。'};
    account=accountShape(id,name,createdAt,request.requestHash,'intent');secret={version:1,kind:'shellbook_account',operationId:operation('shellbook_register',id),requestHash:request.requestHash,name,createdAt};await context.saveAccount(account,JSON.stringify(secret));
    const mutationIdentity={kind:'registration' as const,operationId:secret.operationId,requestHash:secret.requestHash,accountId:id};const captured=await shellbookMutation(SHELLBOOK_REGISTER,{method:'POST',headers:JSON_HEADERS,body:request.body},async opaque=>{secret={...secret!,opaqueResponse:opaque};account=accountShape(id,name,createdAt,request.requestHash,'opaque_response');await context.saveAccount(account,JSON.stringify(secret))},()=>authorize(context,mutationIdentity),{...deps,signal:context.signal});
    if(!captured||!secret.opaqueResponse)return {status:'needs_input',checkpoint:'account_handoff',message:'Shellbook 单次注册请求结果未知；固定身份与密文意图已保留，不会重试或换名。'};
  }
  const parsed=secret.opaqueResponse?parseShellbookOpaque(secret.opaqueResponse,SHELLBOOK_REGISTER):undefined,registration=parsed===undefined?undefined:parseShellbookRegistration(parsed);if(!registration||registration.agent.name!==secret.name)return {status:'needs_input',checkpoint:'account_handoff',message:'Shellbook 注册响应已加密保留，但无法安全恢复一次性 API key；不会重试注册。'};
  const me=parseShellbookAgent(await readShellbookJson(SHELLBOOK_ME,registration.token,{...deps,signal:context.signal}));if(!me||me.id!==registration.agent.id||me.name!==registration.agent.name)return {status:'needs_input',checkpoint:'account_handoff',message:'Shellbook API key 未能只读确认同一 agent 身份；原始响应仍留在本机密文中。'};
  secret={...secret,token:registration.token};account={...accountShape(account!.id,me.name,secret.createdAt,secret.requestHash,'ready',{agentId:me.id,tokenFingerprint:tokenFingerprint(registration.token),checkedAt:(deps.now?.()??new Date()).toISOString()}),source:account!.source};await context.saveAccount(account,JSON.stringify(secret));return {status:'queued',checkpoint:'shellbook_account_ready',message:'Shellbook 无邮箱 agent 已在本机加密连接；将按独立审核稿继续。'};
}

async function textRead(url:string,deps:ShellbookDependencies,accept:string,maxBytes=1_000_000){
  const response=await (deps.fetch??((u:string,i:RequestInit)=>fetch(u,i)))(url,{method:'GET',headers:{accept},signal:deps.signal,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});if(response.status!==200||response.redirected||response.url&&response.url!==url)throw Error('Shellbook readback failed');const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes))throw Error('Shellbook readback too large');const text=await response.text();if(Buffer.byteLength(text)>maxBytes)throw Error('Shellbook readback too large');return {text,headers:response.headers};
}

function directives(value:string){return value.toLowerCase().split(/[\s,]+/).filter(Boolean)}
function indexAllowed(value:string|undefined){const values=directives(value??'');return !values.includes('noindex')&&!values.includes('none')}
function canonicalUrls($:ReturnType<typeof load>,pageUrl:string){return $('link[rel]').toArray().filter(element=>($(element).attr('rel')??'').toLowerCase().split(/\s+/).includes('canonical')).map(element=>new URL($(element).attr('href')??'',pageUrl).href)}
function robotsAllows(text:string,path:string,agent:string){type Group={agents:string[];rules:{allow:boolean;pattern:string}[]};const groups:Group[]=[];let group:Group={agents:[],rules:[]};const push=()=>{if(group.agents.length)groups.push(group);group={agents:[],rules:[]}};for(const raw of text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/)){const match=raw.replace(/#.*$/,'').trim().match(/^([^:]+):\s*(.*)$/);if(!match)continue;const key=match[1].trim().toLowerCase(),value=match[2].trim();if(key==='user-agent'&&/^(?:\*|[a-z_-]+)$/i.test(value)){if(group.rules.length)push();group.agents.push(value.toLowerCase())}else if((key==='allow'||key==='disallow')&&group.agents.length&&value)group.rules.push({allow:key==='allow',pattern:value})}push();const matched=groups.map(value=>({value,score:Math.max(...value.agents.map(item=>item==='*'?0:agent.startsWith(item)?item.length:-1))})).filter(value=>value.score>=0);if(!matched.length)return true;const score=Math.max(...matched.map(value=>value.score)),rules=matched.filter(value=>value.score===score).flatMap(value=>value.value.rules);let winner:{allow:boolean;specificity:number}|undefined;for(const rule of rules){const anchored=rule.pattern.endsWith('$'),source=rule.pattern.replace(/\$$/,'').split('*').map(value=>value.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*');if(!new RegExp(`^${source}${anchored?'$':''}`).test(path))continue;const next={allow:rule.allow,specificity:Buffer.byteLength(rule.pattern)};if(!winner||next.specificity>winner.specificity||next.specificity===winner.specificity&&next.allow)winner=next}return winner?.allow??true}

function postMatches(post:ShellbookPost,draft:ReturnType<typeof identity>,account:Account,createdAt:string){if(!draft||post.authorId!==account.shellbook?.agentId||post.authorName!==account.username||post.title!==draft.title||post.content!==draft.body||post.targetUrl!==draft.targetUrl||post.subshell!==SUBSHELL)return false;const delta=Math.abs(Date.parse(post.createdAt)-Date.parse(createdAt));return Number.isFinite(delta)&&delta<=10*60_000}
function createMatches(receipt:ShellbookCreateReceipt,draft:ReturnType<typeof identity>,account:Account,createdAt:string){if(!draft||receipt.authorId!==account.shellbook?.agentId||receipt.title!==draft.title||receipt.content!==draft.body||receipt.targetUrl!==draft.targetUrl)return false;const delta=Math.abs(Date.parse(receipt.createdAt)-Date.parse(createdAt));return Number.isFinite(delta)&&delta<=10*60_000}
function createMatchesPost(receipt:ShellbookCreateReceipt,post:ShellbookPost){return receipt.id===post.id&&receipt.authorId===post.authorId&&receipt.title===post.title&&receipt.content===post.content&&receipt.targetUrl===post.targetUrl&&receipt.createdAt===post.createdAt&&receipt.submoltId===post.submoltId&&receipt.publicUrl===post.publicUrl}
function normalized(value:string){return value.normalize('NFC').replace(/\s+/gu,' ').trim()}
const POST_BODY_MARKER='data-linkflow-shellbook-post-body';
const COMMENT_CONTAINER_SELECTOR='#comments,[id^="comment-"],[data-comment-id],[data-comments],[data-comment],.comments,.comment';

export type ShellbookVerificationPhase='binding'|'agent_api'|'post_api'|'public_fetch'|'public_indexing'|'public_body'|'public_title'|'public_target'|'robots_fetch'|'robots_policy'|'unexpected';
const PHASE_MESSAGE:Record<ShellbookVerificationPhase,string>={
  binding:'固定身份、审核稿与远程回执的绑定未通过只读核对',
  agent_api:'原 agent 的只读 API 核对未完成',
  post_api:'原文章详情的只读 API 核对未完成',
  public_fetch:'原公开页暂未成功读取',
  public_indexing:'原公开页的 canonical 或索引声明未通过核对',
  public_body:'原公开页的唯一完整正文未通过核对',
  public_title:'原公开页的唯一标题未通过核对',
  public_target:'原公开页的专用目标链接未通过核对',
  robots_fetch:'robots.txt 暂未成功读取',
  robots_policy:'robots.txt 尚未确认允许抓取原文章',
  unexpected:'原页面的只读核对未完成',
};
export class ShellbookVerificationError extends Error{constructor(readonly phase:ShellbookVerificationPhase){super(`Shellbook verification failed: ${phase}`);this.name='ShellbookVerificationError'}}
export function shellbookVerificationPhase(error:unknown):ShellbookVerificationPhase{return error instanceof ShellbookVerificationError?error.phase:'unexpected'}
export function shellbookVerificationMessage(phase:ShellbookVerificationPhase){return `Shellbook ${PHASE_MESSAGE[phase]}（阶段 ${phase}）`}
function failVerification(phase:ShellbookVerificationPhase):never{throw new ShellbookVerificationError(phase)}
async function verificationRead<T>(phase:ShellbookVerificationPhase,read:()=>Promise<T>):Promise<T>{try{return await read()}catch(error){if(error instanceof ShellbookVerificationError)throw error;return failVerification(phase)}}

function exactPostBody($:ReturnType<typeof load>,container:unknown,markdown:string,targetUrl:string,title:string,pageUrl:string,robotsHeader:string){
  $(`[${POST_BODY_MARKER}]`).removeAttr(POST_BODY_MARKER);
  const candidates=$(container as never).children('div.prose').toArray();
  if(candidates.length!==1)return;
  const candidate=candidates[0];
  if($(candidate).closest(COMMENT_CONTAINER_SELECTOR).length||$(candidate).find(COMMENT_CONTAINER_SELECTOR).length)return;
  $(candidate).attr(POST_BODY_MARKER,'true');
  const inspected=inspectRenderedArticle($.html(),markdown,targetUrl,`[${POST_BODY_MARKER}="true"]`,{title,pageUrl,robotsHeader});
  if(!inspected.found){$(candidate).removeAttr(POST_BODY_MARKER);return}
  return candidate;
}
function exactVisibleTitle($:ReturnType<typeof load>,expected:string){return $('h1').toArray().filter(element=>{if($(element).closest(`div.prose,${COMMENT_CONTAINER_SELECTOR},[hidden],[aria-hidden="true"],.hidden,.invisible`).length)return false;const copy=$(element).clone();copy.find('a[href="/s/agents"]').each((_,anchor)=>{const label=$(anchor).clone();label.find('svg,[aria-hidden="true"],.sr-only,.hidden,.invisible').remove();if(normalized(label.text())===SUBSHELL)$(anchor).remove()});copy.find('svg,[aria-hidden="true"],.sr-only,.hidden,.invisible').remove();return normalized(copy.text())===expected})}

async function acceptPost(post:ShellbookPost,draft:NonNullable<ReturnType<typeof identity>>,account:Account,createdAt:string,token:string,deps:ShellbookDependencies){
  if(!postMatches(post,draft,account,createdAt))failVerification('binding');
  const me=parseShellbookAgent(await verificationRead('agent_api',()=>readShellbookJson(SHELLBOOK_ME,token,deps)));if(!me||me.id!==post.authorId||me.name!==post.authorName)failVerification('agent_api');
  const api=parseShellbookPost(await verificationRead('post_api',()=>readShellbookJson(shellbookPostApiUrl(post.id),token,deps)));if(!api||JSON.stringify(api)!==JSON.stringify(post))failVerification('post_api');
  const page=await verificationRead('public_fetch',()=>textRead(post.publicUrl,deps,'text/html')),$=load(page.text),canonicals=canonicalUrls($,post.publicUrl),headerDirectives=directives(page.headers.get('x-robots-tag')??'');if(headerDirectives.includes('noindex')||headerDirectives.includes('none')||canonicals.length!==1||canonicals[0]!==post.publicUrl||!indexAllowed($('meta[name="robots" i]').attr('content'))||!indexAllowed($('meta[name="googlebot" i]').attr('content')))failVerification('public_indexing');
  const titles=exactVisibleTitle($,draft.title);if(titles.length!==1)failVerification('public_title');const title=$(titles[0]),container=title.parent().get(0);if(!container)failVerification('public_body');const dedicated=$(container).children('a[href]').toArray().filter(element=>{try{return new URL($(element).attr('href')??'',post.publicUrl).href===draft.targetUrl&&!$(element).is('[hidden],[aria-hidden="true"]')&&!$(element).closest('[hidden],[aria-hidden="true"],.hidden,.invisible').length}catch{return false}});if(dedicated.length!==1)failVerification('public_target');const rel=($(dedicated[0]).attr('rel')??'').toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');
  const postBody=exactPostBody($,container,draft.body,draft.targetUrl,draft.title,post.publicUrl,page.headers.get('x-robots-tag')??'');if(!postBody)failVerification('public_body');
  const robots=await verificationRead('robots_fetch',()=>textRead(SHELLBOOK_ROBOTS,deps,'text/plain',256*1024)),path=new URL(post.publicUrl).pathname;if(!['*','googlebot','bingbot'].every(agent=>robotsAllows(robots.text,path,agent)))failVerification('robots_policy');return rel;
}

function visible(post:ShellbookPost,base:ShellbookTaskReceipt,stage:ShellbookTaskReceipt['stage'],targetRel?:string):ShellbookTaskReceipt{return {...base,stage,postId:post.id,remoteCreatedAt:post.createdAt,publicUrl:post.publicUrl,...(targetRel!==undefined?{targetRel}:{})}}
function recoveryBinding(post:ShellbookPost,draft:NonNullable<ReturnType<typeof identity>>,saved:ShellbookTaskReceipt):ShellbookRecoveryBinding{return {operationId:saved.operationId,accountId:saved.accountId,agentId:saved.agentId,agentName:saved.agentName,requestHash:saved.requestHash,sourceHash:saved.sourceHash,intentCreatedAt:saved.createdAt,title:draft.title,content:draft.body,targetUrl:draft.targetUrl,subshell:saved.subshell,postId:post.id,remoteCreatedAt:post.createdAt,publicUrl:post.publicUrl}}
function createRecoveryEvidence(receipt:ShellbookCreateReceipt,post:ShellbookPost,saved:ShellbookTaskReceipt,recoveredAt:string):ShellbookCreateRecoveryEvidence{return {version:1,kind:'shellbook_get_recovery',provenance:'create_receipt_detail',operationId:saved.operationId,accountId:saved.accountId,requestHash:saved.requestHash,sourceHash:saved.sourceHash,intentCreatedAt:saved.createdAt,recoveredAt,candidateCount:1,reads:{me:SHELLBOOK_ME,detail:shellbookPostApiUrl(post.id)},createReceipt:structuredClone(receipt),post:structuredClone(post)}}
function sameCreateRecovery(value:ShellbookRecoveryEvidence|undefined,expected:ShellbookCreateRecoveryEvidence){return value?.provenance==='create_receipt_detail'&&JSON.stringify(value.createReceipt)===JSON.stringify(expected.createReceipt)&&JSON.stringify(value.post)===JSON.stringify(expected.post)&&JSON.stringify(value.reads)===JSON.stringify(expected.reads)}
function searchRecoveryEvidence(post:ShellbookPost,draft:NonNullable<ReturnType<typeof identity>>,saved:ShellbookTaskReceipt,recoveredAt:string,searchResults:ShellbookSearchCandidate[],recentResults:ShellbookSearchCandidate[],details:ShellbookPost[]):ShellbookSearchRecoveryEvidence{const detailIds=details.map(item=>item.id).sort();return {version:1,kind:'shellbook_get_recovery',provenance:'bounded_search_recent_detail_public',operationId:saved.operationId,accountId:saved.accountId,requestHash:saved.requestHash,sourceHash:saved.sourceHash,intentCreatedAt:saved.createdAt,recoveredAt,candidateCount:details.length,reads:{me:SHELLBOOK_ME,search:shellbookSearchUrl(draft.title),recent:SHELLBOOK_POSTS,details:detailIds.map(shellbookPostApiUrl),publicPage:post.publicUrl,robots:SHELLBOOK_ROBOTS},searchResults:structuredClone(searchResults),recentResults:structuredClone(recentResults),details:structuredClone(details),post:structuredClone(post)}}
async function recoverUnknownPost(draft:NonNullable<ReturnType<typeof identity>>,account:Account,createdAt:string,token:string,deps:ShellbookDependencies){
  const search=await readShellbookStatus(shellbookSearchUrl(draft.title),token,deps),recent=await readShellbookStatus(SHELLBOOK_POSTS,token,deps);if(search.status!==200||recent.status!==200)return;const searchResults=parseShellbookSearchCandidates(search.value,draft.title),recentResults=parseShellbookSearchCandidates(recent.value,draft.title);if(!searchResults||!recentResults)return;const summary=(item:ShellbookSearchCandidate)=>item.authorName===account.username&&item.subshell===SUBSHELL&&Math.abs(Date.parse(item.createdAt)-Date.parse(createdAt))<=10*60_000,candidates=[...new Map([...searchResults,...recentResults].filter(summary).map(item=>[item.id,item])).values()].sort((left,right)=>left.id.localeCompare(right.id));if(!candidates.length||candidates.length>5)return;const details:ShellbookPost[]=[];for(const candidate of candidates){const status=await readShellbookStatus(shellbookPostApiUrl(candidate.id),token,deps);if(status.status!==200)return;const detail=parseShellbookPost(status.value);if(!detail||detail.id!==candidate.id||detail.authorName!==candidate.authorName||detail.title!==candidate.title||detail.createdAt!==candidate.createdAt||detail.subshell!==candidate.subshell)return;details.push(detail)}const exact=details.filter(post=>postMatches(post,draft,account,createdAt));return exact.length===1?{post:exact[0],searchResults,recentResults,details}:undefined;
}

export async function runShellbookTask(context:ExecutionContext,deps:ShellbookDependencies=context.shellbookDependencies??{}):Promise<ExecutionResult>{
  if(!matches(context))return {status:'needs_input',message:'当前渠道规格不支持 Shellbook'};const draft=identity(context.task,context.site),account=context.getAccount();if(!draft||!context.task.articleApprovedAt)return {status:'needs_input',message:'Shellbook 需要包含唯一本站目标链接的已审核原始 Markdown'};if(!accountValid(account)||account!.id!==context.task.accountId)return {status:'needs_input',message:'Shellbook 同一 agent 身份尚未安全连接'};const accountSecret=parseAccountSecret(await context.secrets.get(`account:${account!.id}`));if(!accountSecret?.token||tokenFingerprint(accountSecret.token)!==account!.shellbook!.tokenFingerprint)return {status:'needs_input',message:'Shellbook 本机加密 API key 与 agent 绑定不一致'};const me=parseShellbookAgent(await readShellbookJson(SHELLBOOK_ME,accountSecret.token,{...deps,signal:context.signal}));if(!me||me.id!==account!.shellbook!.agentId||me.name!==account!.username)return {status:'needs_input',message:'Shellbook API key 未能在写入前确认原 agent 身份'};
  const saved=context.task.shellbook,createdAt=saved?.createdAt??(deps.now?.()??new Date()).toISOString(),operationId=saved?.operationId??operation('shellbook_post',context.task.id),request=shellbookPostRequest(draft.title,draft.body,draft.targetUrl,SUBSHELL),base:ShellbookTaskReceipt={operationId,accountId:account!.id,agentId:me.id,agentName:me.name,subshell:SUBSHELL,targetUrl:draft.targetUrl,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt,stage:'submitting'};if(saved&&(saved.operationId!==base.operationId||saved.accountId!==base.accountId||saved.agentId!==base.agentId||saved.agentName!==base.agentName||saved.subshell!==base.subshell||saved.targetUrl!==base.targetUrl||saved.sourceHash!==base.sourceHash||saved.requestHash!==base.requestHash||saved.createdAt!==base.createdAt))return {status:'needs_input',message:'Shellbook 原发布意图与当前稿件、目标或身份不一致'};
  const key=`publication:${context.task.id}`;let rawSecret:string|undefined;try{rawSecret=await context.secrets.get(key)}catch{return {status:'review',message:'Shellbook 原 publication 密文无法读取；已有单次发布边界保持关闭，不会重复 POST。',shellbook:saved??base,submittedAt:createdAt}}let secret=parsePageSecret(rawSecret),newlyArmed=false;
  const hasDurableIntent=!!saved||!!context.task.submittedAt||!!context.task.publicUrl||/^shellbook_post_/.test(context.task.checkpoint??'');
  if(!secret){if(rawSecret!==undefined||hasDurableIntent)return {status:'review',message:'Shellbook 原 publication 密文缺失或损坏；已有单次发布边界保持关闭，不会重复 POST。',shellbook:saved??base,submittedAt:createdAt};secret={version:1,kind:'shellbook_page',operationId,requestHash:request.requestHash,sourceHash:request.sourceHash,createdAt};await context.secrets.set(key,JSON.stringify(secret));context.checkpoint({shellbook:base,submittedAt:createdAt,checkpoint:'shellbook_post_submitting'});newlyArmed=true}else if(secret.operationId!==operationId||secret.requestHash!==request.requestHash||secret.sourceHash!==request.sourceHash||secret.createdAt!==createdAt)return {status:'needs_input',message:'Shellbook 本机 publication 密文与固定发布意图不一致'};
  if(!secret.opaqueResponse&&!newlyArmed)return {status:'review',message:'Shellbook 原单次发布结果未知；只会按作者、完整稿件、目标网址和时间窗 GET 恢复，不会重复 POST。',shellbook:{...base,stage:'submitting'},submittedAt:createdAt};
  if(!secret.opaqueResponse){const mutationIdentity={kind:'publication' as const,operationId,requestHash:request.requestHash,accountId:account!.id,sourceHash:request.sourceHash};const captured=await shellbookMutation(SHELLBOOK_POSTS,{method:'POST',headers:{...JSON_HEADERS,authorization:`Bearer ${accountSecret.token}`},body:request.body},async opaque=>{secret={...secret!,opaqueResponse:opaque};await context.secrets.set(key,JSON.stringify(secret));context.checkpoint({shellbook:{...base,stage:'opaque_response'},submittedAt:createdAt,checkpoint:'shellbook_post_opaque_response'})},()=>authorize(context,mutationIdentity),{...deps,signal:context.signal});if(!captured||!secret.opaqueResponse)return {status:'review',message:'Shellbook 单次发布响应未知；固定意图已保留，只会 GET 恢复，不会重复 POST。',shellbook:{...base,stage:'submitting'},submittedAt:createdAt}}
  const parsed=parseShellbookOpaque(secret.opaqueResponse,SHELLBOOK_POSTS);let post=parsed===undefined?undefined:parseShellbookPost(parsed);
  if(!post){
    const create=parsed===undefined?undefined:parseShellbookCreateReceipt(parsed);
    if(!create||!createMatches(create,draft,account!,createdAt))return {status:'review',message:'Shellbook 原始响应已加密保存，但未能恢复唯一页面身份；不会重复 POST。',shellbook:{...base,stage:'opaque_response'},submittedAt:createdAt};
    const detail=parseShellbookPost(await readShellbookJson(shellbookPostApiUrl(create.id),accountSecret.token,{...deps,signal:context.signal}));
    if(!detail||!createMatchesPost(create,detail)||!postMatches(detail,draft,account!,createdAt))return {status:'review',message:'Shellbook 创建回执与详情 GET 未能绑定同一完整页面；原回执已保留，不会重发。',shellbook:{...base,stage:'opaque_response'},submittedAt:createdAt};
    const evidence=createRecoveryEvidence(create,detail,base,(deps.now?.()??new Date()).toISOString()),binding=recoveryBinding(detail,draft,base);
    if(!shellbookRecoveryEvidenceMatches(evidence,binding)||secret.recoveryEvidence&&(!shellbookRecoveryEvidenceMatches(secret.recoveryEvidence,binding)||!sameCreateRecovery(secret.recoveryEvidence,evidence)))return {status:'review',message:'Shellbook 创建回执的只读恢复证据与固定意图不一致；不会重发。',shellbook:{...base,stage:'opaque_response'},submittedAt:createdAt};
    if(!secret.recoveryEvidence){secret={...secret,recoveryEvidence:evidence};await context.secrets.set(key,JSON.stringify(secret))}
    post=detail;
  }
  if(!postMatches(post,draft,account!,createdAt))return {status:'review',message:'Shellbook 原始响应与固定稿件或身份不一致；不会重发。',shellbook:{...base,stage:'opaque_response'},submittedAt:createdAt};
  const receipt=visible(post,base,'api_receipt');context.checkpoint({shellbook:receipt,submittedAt:createdAt,publicUrl:post.publicUrl,checkpoint:'shellbook_post_api_receipt'});
  try{const rel=await acceptPost(post,draft,account!,createdAt,accountSecret.token,{...deps,signal:context.signal});return {status:'live',message:`Shellbook agent、API、公开 SSR、原生目标链接与抓取规则已核对；实际 rel：${rel||'空'}。`,publicUrl:post.publicUrl,linkRel:rel,submittedAt:createdAt,checkpoint:'shellbook_published',shellbook:visible(post,base,'published',rel)}}catch(error){const phase=shellbookVerificationPhase(error);return {status:'review',message:`${shellbookVerificationMessage(phase)}；已保留原 API 回执，不会重发。`,publicUrl:post.publicUrl,submittedAt:createdAt,checkpoint:'shellbook_post_api_receipt',shellbook:receipt}}
}

export type ShellbookReconcileResult={status:'found';publicUrl:string;shellbook:ShellbookTaskReceipt;rel:string}|{status:'unknown';phase:ShellbookVerificationPhase};
const unknownShellbook=(phase:ShellbookVerificationPhase):ShellbookReconcileResult=>({status:'unknown',phase});

export async function reconcileShellbookTask(context:ExecutionContext,deps:ShellbookDependencies=context.shellbookDependencies??{}):Promise<ShellbookReconcileResult>{
  try{
    const draft=identity(context.task,context.site),account=context.getAccount(),saved=context.task.shellbook;
    if(!matches(context)||!draft||!accountValid(account)||!saved||saved.accountId!==account!.id)return unknownShellbook('binding');
    const key=`publication:${context.task.id}`,accountSecret=parseAccountSecret(await context.secrets.get(`account:${account!.id}`));let secret=parsePageSecret(await context.secrets.get(key));
    if(!accountSecret?.token||!secret||secret.operationId!==saved.operationId||secret.requestHash!==saved.requestHash||secret.sourceHash!==saved.sourceHash||secret.createdAt!==saved.createdAt)return unknownShellbook('binding');
    const me=parseShellbookAgent(await verificationRead('agent_api',()=>readShellbookJson(SHELLBOOK_ME,accountSecret.token!,{...deps,signal:context.signal})));if(!me||me.id!==saved.agentId||me.name!==saved.agentName)return unknownShellbook('agent_api');
    let post:ShellbookPost|undefined,recovered:Awaited<ReturnType<typeof recoverUnknownPost>>,create:ShellbookCreateReceipt|undefined;
    if(secret.opaqueResponse){const parsed=parseShellbookOpaque(secret.opaqueResponse,SHELLBOOK_POSTS);post=parsed===undefined?undefined:parseShellbookPost(parsed);if(!post)create=parsed===undefined?undefined:parseShellbookCreateReceipt(parsed)}
    if(create){
      if(!createMatches(create,draft,account!,saved.createdAt))return unknownShellbook('binding');
      const detail=parseShellbookPost(await verificationRead('post_api',()=>readShellbookJson(shellbookPostApiUrl(create.id),accountSecret.token!,{...deps,signal:context.signal})));if(!detail||!createMatchesPost(create,detail)||!postMatches(detail,draft,account!,saved.createdAt))return unknownShellbook('post_api');post=detail;
      const binding=recoveryBinding(post,draft,saved),evidence=createRecoveryEvidence(create,post,saved,(deps.now?.()??new Date()).toISOString());if(!shellbookRecoveryEvidenceMatches(evidence,binding)||secret.recoveryEvidence&&(!shellbookRecoveryEvidenceMatches(secret.recoveryEvidence,binding)||!sameCreateRecovery(secret.recoveryEvidence,evidence)))return unknownShellbook('binding');
      if(!secret.recoveryEvidence){secret={...secret,recoveryEvidence:evidence};await context.secrets.set(key,JSON.stringify(secret))}
      if(!['api_receipt','published'].includes(saved.stage))context.checkpoint({shellbook:visible(post,saved,'api_receipt'),submittedAt:saved.createdAt,publicUrl:post.publicUrl,checkpoint:'shellbook_post_api_receipt'});
    }
    if(!post&&saved.postId)post=parseShellbookPost(await verificationRead('post_api',()=>readShellbookJson(shellbookPostApiUrl(saved.postId!),accountSecret.token!,{...deps,signal:context.signal})));
    if(!post&&!secret.opaqueResponse){recovered=await verificationRead('post_api',()=>recoverUnknownPost(draft,account!,saved.createdAt,accountSecret.token!,{...deps,signal:context.signal}));post=recovered?.post}
    if(!post||!postMatches(post,draft,account!,saved.createdAt))return unknownShellbook('binding');
    const rel=await acceptPost(post,draft,account!,saved.createdAt,accountSecret.token,{...deps,signal:context.signal}),binding=recoveryBinding(post,draft,saved);
    if(!secret.opaqueResponse){if(secret.recoveryEvidence){if(!shellbookRecoveryEvidenceMatches(secret.recoveryEvidence,binding))return unknownShellbook('binding')}else{if(!recovered)return unknownShellbook('binding');const evidence=searchRecoveryEvidence(post,draft,saved,(deps.now?.()??new Date()).toISOString(),recovered.searchResults,recovered.recentResults,recovered.details);if(!shellbookRecoveryEvidenceMatches(evidence,binding))return unknownShellbook('binding');secret={...secret,recoveryEvidence:evidence};await context.secrets.set(key,JSON.stringify(secret))}}else if(secret.recoveryEvidence&&!shellbookRecoveryEvidenceMatches(secret.recoveryEvidence,binding))return unknownShellbook('binding');
    return {status:'found',publicUrl:post.publicUrl,rel,shellbook:visible(post,saved,'published',rel)};
  }catch(error){return unknownShellbook(shellbookVerificationPhase(error))}
}

export async function verifyShellbookPublication(context:ExecutionContext,deps:ShellbookDependencies=context.shellbookDependencies??{}):Promise<LinkResult>{const result=await reconcileShellbookTask(context,deps),url=context.task.publicUrl??SHELLBOOK_ORIGIN;return result.status==='found'?{found:true,outcome:'found',url:result.publicUrl,rel:result.rel,reason:'Shellbook 原 agent、原稿、目标网址、API 与公开页面仍一致'}:{found:false,outcome:'unreachable',url,rel:'unknown',reason:`${shellbookVerificationMessage(result.phase)}；原回执与固定意图已保留。`}}
export const shellbookPublisherTesting={robotsAllows,indexAllowed,postMatches,createMatches,createMatchesPost,exactVisibleTitle,acceptPost,recoverUnknownPost};
