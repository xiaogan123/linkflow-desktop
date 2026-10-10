import type {Channel, ShareYourHtmlReadbackEvidence, Site, Task} from '../shared/types';
import {SHAREYOURHTML_READBACK_MAX_DIRECTIVES,SHAREYOURHTML_READBACK_MAX_DIRECTIVE_LENGTH,SHAREYOURHTML_READBACK_MAX_REL_TOKENS,SHAREYOURHTML_READBACK_MAX_TARGET_LINKS,SHAREYOURHTML_READBACK_MAX_TOKEN_LENGTH,verifyShareYourHtmlReadback, type ShareYourHtmlReadbackResult, type ShareYourHtmlVerifierDependencies} from '../integrations/shareyourhtml-verifier';
import {parseShareYourHtmlPublicationSecret, shareYourHtmlDraftHash, shareYourHtmlSiteIdentityHash} from './shareyourhtml-publication';
import type {State, Store} from './store';
import type {Vault} from './vault';

type VerificationStore=Pick<Store,'read'|'update'|'getCipher'>;
type DecryptingVault=Pick<Vault,'get'>;

export interface ShareYourHtmlVerificationOptions{
  taskId:string;
  resolveChannel:(state:State,channelId:string)=>Channel|undefined;
  signal?:AbortSignal;
  now?:()=>Date;
}
export interface ShareYourHtmlVerificationDependencies extends ShareYourHtmlVerifierDependencies{
  verifyReadback?:typeof verifyShareYourHtmlReadback;
  now?:()=>Date;
}
export type ShareYourHtmlVerificationOutcome={status:'verified'|'pending'|'stale';message:string;result?:ShareYourHtmlReadbackResult};

const publicationKey=(taskId:string)=>`publication:${taskId}`;
const publicUrl=(slug:string)=>`https://${slug}.shareyourhtml.com`;
const exactDate=(value:string|undefined)=>!!value&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const nextCheck=(now:Date)=>new Date(now.getTime()+2*86400000).toISOString();
const relValue=(result:ShareYourHtmlReadbackResult)=>[...new Set(result.targetLinks.flatMap(link=>link.rel))].sort().join(' ');

function fixedMessage(status:ShareYourHtmlReadbackResult['status']):string{
  if(status==='visible_match')return 'ShareYourHTML 公开页的静态正文和目标链接与审核稿一致；链接属性与索引限制已分别记录，这不代表搜索引擎已收录或页面会永久保留。';
  if(status==='content_mismatch')return 'ShareYourHTML 公开页未找到与审核稿一致的正文或目标链接；永久回执与编辑凭据已保留。';
  if(status==='content_hidden')return 'ShareYourHTML 公开页的审核正文当前不可见；永久回执与编辑凭据已保留。';
  if(status==='visibility_unknown')return 'ShareYourHTML 页面包含静态核验无法判断的脚本或样式，当前可见性未知；不会据此标记生效。';
  if(status==='unreachable')return 'ShareYourHTML 公开页暂时无法完成只读核验；永久回执与编辑凭据已保留。';
  return 'ShareYourHTML 公开响应未通过固定地址与格式校验；不会据此标记生效。';
}

function bound(state:State,taskId:string,cipher:string|undefined,requireRunnable=true):{task:Task;site:Site;channel:Channel}|undefined{
  const task=state.tasks.find(item=>item.id===taskId),site=task&&state.sites.find(item=>item.id===task.siteId);
  if(!task||!site||task.channelId!=='shareyourhtml'||task.sourceDomain!=='shareyourhtml.com'||task.accountId
    ||task.shareYourHtml?.stage!=='api_receipt'||!task.draft||!cipher
    ||task.shareYourHtml.siteId!==site.id||task.shareYourHtml.siteIdentityHash!==shareYourHtmlSiteIdentityHash(site)
    ||task.shareYourHtml.reviewedDraftRevision!==(task.draftRevision??0)
    ||task.shareYourHtml.reviewedDraftHash!==shareYourHtmlDraftHash(task.draft)
    ||task.submittedAt!==task.shareYourHtml.createdAt||task.publicUrl!==publicUrl(task.shareYourHtml.slug)
    ||task.checkpoint!=='shareyourhtml_api_receipt')return;
  if(requireRunnable&&(site.status!=='ready'||['running','queued','failed','skipped','expired'].includes(task.status)))return;
  return {task,site,channel:undefined as unknown as Channel};
}

function snapshot(state:State,task:Task,site:Site,channel:Channel,cipher:string):string{
  return JSON.stringify({task,site:{id:site.id,domain:site.domain,url:site.url,status:site.status,language:site.language,topics:site.topics},channel:{id:channel.id,domain:channel.domain,enabled:channel.enabled},settings:state.settings,cipher});
}

function secretMatches(task:Task,site:Site,plaintext:string|undefined):boolean{
  const secret=plaintext&&parseShareYourHtmlPublicationSecret(plaintext),claim=task.shareYourHtml;
  return !!secret&&!!claim&&secret.taskId===task.id&&secret.operationId===claim.operationId
    &&secret.slug===claim.slug&&secret.publicUrl===task.publicUrl&&secret.sourceHash===claim.sourceHash
    &&secret.requestHash===claim.requestHash&&secret.reviewedDraftHash===claim.reviewedDraftHash
    &&secret.reviewedDraftRevision===claim.reviewedDraftRevision&&secret.siteId===site.id
    &&secret.siteIdentityHash===claim.siteIdentityHash;
}

function boundedResult(result:ShareYourHtmlReadbackResult,task:Task,site:Site):ShareYourHtmlReadbackResult{
  if(result.status==='invalid_binding'||result.publicUrl!==task.publicUrl)return {status:'invalid_binding',message:'ShareYourHTML 核验绑定无效',content:'unknown',targetLinks:[],indexing:{page:'unknown',directives:[],robots:'unknown'}};
  const target=task.topicUrl??site.url,links=[...new Map(result.targetLinks.map(link=>[JSON.stringify(link),{href:link.href,rel:[...new Set(link.rel)].sort()}])).values()];
  const invalid=links.length>SHAREYOURHTML_READBACK_MAX_TARGET_LINKS||links.some(link=>link.href!==target||link.rel.length>SHAREYOURHTML_READBACK_MAX_REL_TOKENS||link.rel.some(token=>token.length>SHAREYOURHTML_READBACK_MAX_TOKEN_LENGTH||!/^[a-z0-9_-]+$/.test(token)))
    ||result.indexing.directives.length>SHAREYOURHTML_READBACK_MAX_DIRECTIVES||result.indexing.directives.some(value=>value.length>SHAREYOURHTML_READBACK_MAX_DIRECTIVE_LENGTH);
  if(invalid)return {status:'visibility_unknown',message:'ShareYourHTML 公开证据超出本地静态范围',publicUrl:task.publicUrl,content:'unknown',targetLinks:[],indexing:{page:'unknown',directives:[],robots:'unknown'}};
  return {...result,targetLinks:links,indexing:{...result.indexing,directives:[...new Set(result.indexing.directives)].sort()}};
}

function toEvidence(result:ShareYourHtmlReadbackResult,checkedAt:string):ShareYourHtmlReadbackEvidence{
  if(result.status==='invalid_binding')throw Error('ShareYourHTML 核验绑定无效');
  return {checkedAt,status:result.status,content:result.content,targetLinks:result.targetLinks.map(link=>({href:link.href,rel:[...link.rel]})),indexing:{page:result.indexing.page,directives:[...result.indexing.directives],robots:result.indexing.robots}};
}

export async function verifyStoredShareYourHtmlPublication(store:VerificationStore,vault:DecryptingVault,options:ShareYourHtmlVerificationOptions,deps:ShareYourHtmlVerificationDependencies={}):Promise<ShareYourHtmlVerificationOutcome>{
  if(options.signal?.aborted)return {status:'stale',message:'ShareYourHTML 核验已取消，未更改任务状态。'};
  const initialState=store.read(),initialCipher=store.getCipher(publicationKey(options.taskId)),initial=bound(initialState,options.taskId,initialCipher);
  const channel=initial&&options.resolveChannel(initialState,initial.task.channelId);
  if(!initial||!channel?.enabled)return {status:'stale',message:'ShareYourHTML 当前任务、站点、渠道或永久回执绑定无效，未发起公开请求。'};
  const initialSnapshot=snapshot(initialState,initial.task,initial.site,channel,initialCipher!);
  let plaintext:string|undefined;
  try{plaintext=await vault.get(publicationKey(options.taskId))}catch{return {status:'stale',message:'ShareYourHTML 编辑凭据当前无法安全读取，未发起公开请求。'}}
  if(!secretMatches(initial.task,initial.site,plaintext))return {status:'stale',message:'ShareYourHTML 加密凭据与永久回执绑定无效，未发起公开请求。'};
  if(options.signal?.aborted)return {status:'stale',message:'ShareYourHTML 核验已取消，未更改任务状态。'};
  const beforeState=store.read(),beforeCipher=store.getCipher(publicationKey(options.taskId)),before=bound(beforeState,options.taskId,beforeCipher),beforeChannel=before&&options.resolveChannel(beforeState,before.task.channelId);
  if(!before||!beforeChannel?.enabled||snapshot(beforeState,before.task,before.site,beforeChannel,beforeCipher!)!==initialSnapshot)return {status:'stale',message:'ShareYourHTML 核验前任务或设置已改变，未发起公开请求。'};
  const verify=deps.verifyReadback??verifyShareYourHtmlReadback;
  const result=boundedResult(await verify(before.task,before.site,{...deps,signal:options.signal}),before.task,before.site);
  if(options.signal?.aborted)return {status:'stale',message:'ShareYourHTML 核验已取消，忽略迟到结果。'};
  if(result.status==='invalid_binding')return {status:'stale',message:'ShareYourHTML 核验结果与永久回执绑定无效，未更改任务状态。'};
  const checkedAt=(options.now??(()=>new Date()))().toISOString(),evidence=toEvidence(result,checkedAt);
  let committed=false;
  store.update(state=>{
    const cipher=store.getCipher(publicationKey(options.taskId)),current=bound(state,options.taskId,cipher),currentChannel=current&&options.resolveChannel(state,current.task.channelId);
    if(!current||!currentChannel?.enabled||snapshot(state,current.task,current.site,currentChannel,cipher!)!==initialSnapshot)return;
    const task=current.task,wasLive=!!task.firstLiveAt;
    task.shareYourHtmlReadback=evidence;task.lastCheckedAt=checkedAt;task.nextCheckAt=nextCheck(new Date(checkedAt));task.updatedAt=checkedAt;task.message=fixedMessage(result.status);
    if(result.status==='visible_match'){
      task.status='live';task.health='healthy';task.linkCheck='found';task.linkRel=relValue(result);task.publicationMethod='client';
      task.firstLiveAt??=checkedAt;task.verifiedAt=checkedAt;task.lostAt=undefined;task.reviewKind=undefined;task.consecutiveMissing=0;
    }else if(wasLive){
      task.publicationMethod='client';
      if(result.status==='content_mismatch'||result.status==='content_hidden'){
        task.status='needs_input';task.health='missing';task.linkCheck='absent';task.lostAt??=checkedAt;task.reviewKind='lost_link';task.consecutiveMissing=(task.consecutiveMissing??0)+1;
      }else{task.health='unknown';task.linkCheck=result.status==='unreachable'?'unreachable':'invalid';}
    }else{
      task.status='review';task.health=result.status==='unreachable'||result.status==='visibility_unknown'||result.status==='invalid_response'?'unknown':'pending';
      task.linkCheck=result.status==='content_mismatch'||result.status==='content_hidden'?'absent':result.status==='unreachable'?'unreachable':'invalid';
    }
    committed=true;
  });
  if(!committed)return {status:'stale',message:'ShareYourHTML 核验期间任务或设置已改变，忽略迟到结果。'};
  return {status:result.status==='visible_match'?'verified':'pending',message:fixedMessage(result.status),result};
}
