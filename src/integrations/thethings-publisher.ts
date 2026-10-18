import type {ExecutionContext,ExecutionResult,LinkResult,Site,Task,TheThingsTaskReceipt} from '../shared/types';
import {createTheThingsPage,parseTheThingsCreated,theThingsPublicUrl,type TheThingsCreated,type TheThingsIntent} from './thethings';
import {verifyTheThingsPage} from './thethings-public';
import {parseTheThingsSecret,theThingsIntentOf,theThingsTaskIdentity} from '../main/thethings-publication';

export type TheThingsReconcileResult={status:'found';publicUrl:string;theThings:TheThingsTaskReceipt;verification:LinkResult}|{status:'unknown'};

function hydrate(context:ExecutionContext){
  const hidden=context.secrets as typeof context.secrets&{theThingsPersistence?:ExecutionContext['theThingsPersistence'];theThingsDependencies?:ExecutionContext['theThingsDependencies']};
  context.theThingsPersistence??=hidden.theThingsPersistence;
  context.theThingsDependencies??=hidden.theThingsDependencies;
  return context;
}
function matches(context:ExecutionContext){
  return context.channel.id==='thethings'&&context.channel.domain==='thethings.ai'&&context.channel.kind==='article'&&context.channel.automation==='api'&&context.channel.articleRequired&&!context.channel.accountRequired&&!context.channel.emailRequired&&context.task.channelId==='thethings'&&context.task.sourceDomain==='thethings.ai'&&!context.task.accountId;
}
function operationId(taskId:string){return `thethings_${taskId.replaceAll('-','').toLowerCase()}`}
function sameIntent(saved:TheThingsTaskReceipt,intent:TheThingsIntent){return saved.operationId===intent.operationId&&saved.sourceHash===intent.sourceHash&&saved.requestHash===intent.requestHash&&saved.createdAt===intent.createdAt}
function checkpoint(stage:TheThingsTaskReceipt['stage']){return stage==='submitting'?'thethings_submitting':stage==='opaque_response'?'thethings_opaque_response':stage==='api_receipt'?'thethings_api_receipt':'thethings_published'}
function target(task:Pick<Task,'topicUrl'>,site:Pick<Site,'url'>){return task.topicUrl??site.url}

export function theThingsDraftError(task:Pick<Task,'draft'|'topicUrl'>,site:Pick<Site,'url'|'language'>){return theThingsTaskIdentity(task,site)?undefined:'TheThings 需要审核后的标题、摘要、完整 HTML 正文和唯一目标链接'}

async function recoverCreated(context:ExecutionContext,saved:TheThingsTaskReceipt):Promise<{saved:TheThingsTaskReceipt;created:TheThingsCreated}|undefined>{
  const raw=await context.theThingsPersistence!.loadPriorRaw(),secret=raw&&parseTheThingsSecret(raw);
  if(!secret||!sameIntent(saved,secret.intent)||!secret.opaque)return;
  const created=parseTheThingsCreated(secret.opaque,secret.intent);if(!created)return;
  if(saved.stage==='opaque_response')try{await context.theThingsPersistence!.persistCreated(created)}catch{return}
  return {saved:{...theThingsIntentOf(saved),stage:'api_receipt',slug:created.receipt.slug},created};
}

export async function reconcileTheThingsTask(rawContext:ExecutionContext,deps=rawContext.theThingsDependencies??{}):Promise<TheThingsReconcileResult>{
  const context=hydrate(rawContext);if(!matches(context)||!context.theThingsPersistence||!context.task.theThings)return {status:'unknown'};
  let saved=context.task.theThings;const identity=theThingsTaskIdentity(context.task,context.site);
  if(!identity||saved.sourceHash!==identity.sourceHash||saved.requestHash!==identity.requestHash||context.task.submittedAt!==saved.createdAt)return {status:'unknown'};
  if(saved.stage==='opaque_response'){
    const recovered=await recoverCreated(context,saved);if(!recovered)return {status:'unknown'};
    saved=recovered.saved;context.task.theThings=saved;context.task.publicUrl=recovered.created.receipt.publicUrl;
  }
  if(!['api_receipt','published'].includes(saved.stage)||!saved.slug||context.task.publicUrl!==theThingsPublicUrl(saved.slug))return {status:'unknown'};
  try{
    const evidence=await verifyTheThingsPage({slug:saved.slug,title:identity.title,body:identity.body,targetUrl:identity.targetUrl},{...deps,signal:context.signal});
    const verification:LinkResult={found:true,outcome:'found',url:evidence.url,rel:evidence.rel,reason:'TheThings 匿名公开页的完整原稿、唯一原生目标链接和抓取策略已核验；页面公开可发现且不可编辑。'};
    return {status:'found',publicUrl:evidence.url,theThings:{...saved,stage:'published'},verification};
  }catch{return {status:'unknown'}}
}

export async function verifyTheThingsPublication(task:Task,site:Site,deps:NonNullable<ExecutionContext['theThingsDependencies']>={}):Promise<LinkResult>{
  const url=task.publicUrl??'https://thethings.ai/';
  if(task.channelId!=='thethings'||task.sourceDomain!=='thethings.ai'||task.accountId||!task.theThings||!['api_receipt','published'].includes(task.theThings.stage)||!task.theThings.slug||task.publicUrl!==theThingsPublicUrl(task.theThings.slug))return {found:false,outcome:'invalid',url,rel:'unknown',reason:'TheThings 缺少与审核原稿绑定的匿名公开回执'};
  const identity=theThingsTaskIdentity(task,site);if(!identity||identity.sourceHash!==task.theThings.sourceHash||identity.requestHash!==task.theThings.requestHash)return {found:false,outcome:'invalid',url,rel:'unknown',reason:'TheThings 原稿与公开回执不一致'};
  try{const result=await verifyTheThingsPage({slug:task.theThings.slug,title:identity.title,body:identity.body,targetUrl:target(task,site)},deps);return {found:true,outcome:'found',url:result.url,rel:result.rel,reason:'TheThings 匿名公开页的完整原稿、唯一原生目标链接和抓取策略仍一致；页面公开可发现且不可编辑。'}}catch{return {found:false,outcome:'unreachable',url,rel:'unknown',reason:'TheThings 公开页尚未通过原生只读验收'}}
}

export async function runTheThingsTask(rawContext:ExecutionContext,deps=rawContext.theThingsDependencies??{}):Promise<ExecutionResult>{
  const context=hydrate(rawContext);if(!matches(context)||!context.theThingsPersistence)return {status:'needs_input',message:'当前任务未绑定 TheThings 安全持久化'};
  const error=theThingsDraftError(context.task,context.site);if(error)return {status:'needs_input',message:error};
  const identity=theThingsTaskIdentity(context.task,context.site)!,prior=context.task.theThings;
  if(prior){
    if(prior.sourceHash!==identity.sourceHash||prior.requestHash!==identity.requestHash||context.task.submittedAt!==prior.createdAt)return {status:'needs_input',message:'TheThings 原稿或原意图不一致，禁止重发',theThings:prior};
    const recovered=await reconcileTheThingsTask(context,deps),saved=context.task.theThings;
    return recovered.status==='found'?{status:'review',message:'TheThings 原匿名公开页已只读找回并核验，没有重发',publicUrl:recovered.publicUrl,theThings:recovered.theThings,checkpoint:'thethings_published',submittedAt:prior.createdAt}:{status:'review',message:'TheThings 单次公开发布记录已保留；原始响应或公开全文尚未验收，不会重发',theThings:saved,checkpoint:checkpoint(saved?.stage??prior.stage),submittedAt:prior.createdAt,...(saved?.slug?{publicUrl:theThingsPublicUrl(saved.slug)}:{})};
  }
  if(context.task.submittedAt||context.task.publicUrl||/^thethings_/.test(context.task.checkpoint??''))return {status:'needs_input',message:'TheThings 提交痕迹缺少完整意图，禁止重发'};
  const result=await createTheThingsPage({operationId:operationId(context.task.id),reviewed:true,title:identity.title,summary:identity.summary,html:identity.html},context.theThingsPersistence,{...deps,signal:context.signal});
  if(result.status==='not_started')return {status:'needs_input',message:'TheThings 意图未安全持久化或发布授权已改变，未发送'};
  if(result.status==='prior_intent')return {status:'needs_input',message:'TheThings 已有加密发布记录但当前任务缺少完整意图，禁止重发'};
  if(result.status==='created'){const receipt=result.receipt;return {status:'review',message:'TheThings 公开回执与 claim_url 已在原始响应中加密保留；等待公开全文、目标链接和抓取策略核验',publicUrl:receipt.publicUrl,theThings:{version:1,operationId:receipt.operationId,sourceHash:receipt.sourceHash,requestHash:receipt.requestHash,createdAt:receipt.createdAt,stage:'api_receipt',slug:receipt.slug},checkpoint:'thethings_api_receipt',submittedAt:receipt.createdAt}}
  const raw=await context.theThingsPersistence.loadPriorRaw().catch(()=>undefined),secret=raw?parseTheThingsSecret(raw):undefined,intent=result.intent;
  let stage:TheThingsTaskReceipt['stage']=secret?.opaque?'opaque_response':'submitting',slug:string|undefined;
  if(secret?.opaque){const created=parseTheThingsCreated(secret.opaque,secret.intent);if(created)try{await context.theThingsPersistence.persistCreated(created);stage='api_receipt';slug=created.receipt.slug}catch{}}
  return {status:'review',message:'TheThings 单次发布结果不明；原意图和可能的加密原始响应已保留，不会重发',theThings:{...intent,stage,...(slug?{slug}:{})},checkpoint:checkpoint(stage),submittedAt:intent.createdAt,...(slug?{publicUrl:theThingsPublicUrl(slug)}:{})};
}
