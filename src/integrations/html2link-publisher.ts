import {
  createHtml2LinkPublication,
  html2LinkPublicUrl,
  parseHtml2LinkPublicUrl,
  parseStoredHtml2LinkCreateResponse,
  type Html2LinkCreateDependencies,
  type Html2LinkDiagnostic,
  type Html2LinkIntent,
  type Html2LinkReceipt,
} from './html2link';
import {verifyHtml2LinkPublication, type Html2LinkVerification, type Html2LinkVerifyDependencies} from './html2link-verifier';
import {
  html2LinkTaskIdentity,
  type Html2LinkExecutionContext,
  type Html2LinkExecutionResult,
  type Html2LinkTask,
  type Html2LinkTaskReceipt,
} from '../main/html2link-publication';
import type {LinkResult,Site} from '../shared/types';

export interface Html2LinkPublisherDependencies extends Html2LinkCreateDependencies,Omit<Html2LinkVerifyDependencies,'evidence'> {}
export type Html2LinkReconcileResult=
  |{status:'found';publicUrl:string;html2link:Html2LinkTaskReceipt;verification:Extract<Html2LinkVerification,{status:'usable'}>}
  |{status:'unknown';html2link?:Html2LinkTaskReceipt;verification?:Exclude<Html2LinkVerification,{status:'usable'}>};

const DIAGNOSTIC:Record<Html2LinkDiagnostic,string>={
  transport:'网络传输或超时失败',
  body_limit:'响应体超出 64 KiB 安全上限',
  opaque_persistence:'完整原始响应未能先行加密保存',
  decode:'响应不是有效 UTF-8',
  json:'响应不是有效 JSON',
  duplicate_field:'响应包含重复字段',
  schema:'响应字段与已冻结契约不一致',
  redirect:'响应发生重定向或来源不一致',
  media_type:'响应媒体类型不是 JSON',
  http_status:'响应状态不是 200 或 201',
};

function matches(context:Html2LinkExecutionContext){return context.channel.id==='html2link'&&context.channel.domain==='html2link.dev'&&context.channel.kind==='article'&&context.channel.automation==='api'&&context.channel.articleRequired&&!context.channel.accountRequired&&context.task.channelId==='html2link'&&context.task.sourceDomain==='html2link.dev'&&!context.task.accountId}
function operationId(taskId:string){return `html2link_${taskId.toLowerCase().replace(/[^a-f0-9]/g,'')}`}
function intent(saved:Html2LinkIntent):Html2LinkIntent{return {operationId:saved.operationId,sourceHash:saved.sourceHash,requestHash:saved.requestHash,createdAt:saved.createdAt}}
function receipt(saved:Html2LinkTaskReceipt):Html2LinkReceipt|undefined{if(!saved.slug)return;try{if(saved.publicUrl){const parsed=parseHtml2LinkPublicUrl(saved.publicUrl);if(!parsed||parsed.slug!==saved.slug)return;return {...intent(saved),slug:saved.slug,publicUrl:parsed.publicUrl}}return {...intent(saved),slug:saved.slug,publicUrl:html2LinkPublicUrl(saved.slug)}}catch{return}}

export function html2LinkDraftError(task:Pick<Html2LinkTask,'draft'|'topicUrl'>,site:Pick<Site,'url'|'language'>){return html2LinkTaskIdentity(task,site)?undefined:'HTML2Link 仅支持 1 MB 内、含精确审核目标链接且无脚本/图片的完整 Markdown 文章'}

async function verifyReceipt(context:Html2LinkExecutionContext,saved:Html2LinkTaskReceipt,deps:Html2LinkPublisherDependencies):Promise<Html2LinkVerification|undefined>{
  const known=receipt(saved),identity=html2LinkTaskIdentity(context.task,context.site);if(!known||!identity)return;
  return verifyHtml2LinkPublication(known,identity.article,{fetch:deps.fetch,signal:context.signal,timeoutMs:deps.timeoutMs,now:deps.now,evidence:context.html2LinkPersistence});
}

/** Recovery only decrypts the captured first response and performs bounded GETs. */
export async function reconcileHtml2LinkTask(context:Html2LinkExecutionContext,deps:Html2LinkPublisherDependencies={}):Promise<Html2LinkReconcileResult>{
  if(!matches(context)||!context.html2LinkPersistence||!context.task.html2link)return {status:'unknown'};
  let saved=context.task.html2link;
  const identity=html2LinkTaskIdentity(context.task,context.site);
  if(!identity||saved.sourceHash!==identity.sourceHash||saved.requestHash!==identity.requestHash||context.task.submittedAt!==saved.createdAt)return {status:'unknown',html2link:saved};
  if(saved.stage==='opaque_response'){
    const opaque=await context.html2LinkPersistence.loadOpaqueResponse();
    if(opaque){
      const parsed=parseStoredHtml2LinkCreateResponse(opaque,intent(saved),identity.article);
      if(!('diagnostic' in parsed)){
        try{
          await context.html2LinkPersistence.promoteReceipt(parsed);
          saved={...saved,slug:parsed.receipt.slug,publicUrl:parsed.receipt.publicUrl,stage:'api_receipt'};
          context.task.html2link=saved;
          context.task.publicUrl=parsed.receipt.publicUrl;
        }catch{return {status:'unknown',html2link:saved}}
      }
    }
  }
  if(!['api_receipt','published'].includes(saved.stage)||!saved.slug)return {status:'unknown',html2link:saved};
  const verification=await verifyReceipt(context,saved,deps);if(!verification)return {status:'unknown',html2link:saved};
  return verification.status==='usable'
    ?{status:'found',publicUrl:verification.publicUrl,html2link:{...saved,stage:'published'},verification}
    :{status:'unknown',html2link:saved,verification};
}

export async function verifyHtml2LinkTaskPublication(task:Html2LinkTask,site:Site,target:string,deps:Html2LinkVerifyDependencies={}):Promise<LinkResult>{
  const fail=(outcome:'invalid'|'unreachable',reason:string):LinkResult=>({found:false,outcome,url:task.publicUrl??'https://html2link.dev/',rel:'unknown',reason});
  const saved=task.html2link,known=saved&&receipt(saved),identity=html2LinkTaskIdentity(task,site);
  if(task.channelId!=='html2link'||task.sourceDomain!=='html2link.dev'||task.accountId||!saved||!known||!identity||!['api_receipt','published'].includes(saved.stage)||task.submittedAt!==saved.createdAt||identity.targetUrl!==new URL(target).href||task.publicUrl!==known.publicUrl)return fail('invalid','HTML2Link 缺少与原稿绑定的平台返回记录');
  const result=await verifyHtml2LinkPublication(known,identity.article,deps);
  return result.status==='usable'
    ?{found:true,outcome:'found',url:result.publicUrl,rel:result.rel,reason:'HTML2Link 公开全文、目标链接、索引指令与 robots 规则均匹配；不代表搜索收录或长期保留'}
    :fail(result.status==='invalid'?'invalid':'unreachable',result.status==='invalid'?'HTML2Link 公开内容、抓取规则或原稿绑定不一致':'HTML2Link 只读验收暂未完成');
}

export async function runHtml2LinkTask(context:Html2LinkExecutionContext,deps:Html2LinkPublisherDependencies={}):Promise<Html2LinkExecutionResult>{
  if(!matches(context)||!context.html2LinkPersistence)return {status:'needs_input',message:'当前任务缺少 HTML2Link 的加密安全保存位置'};
  const identity=html2LinkTaskIdentity(context.task,context.site);if(!identity)return {status:'needs_input',message:html2LinkDraftError(context.task,context.site)??'HTML2Link 原稿无效'};
  const prior=context.task.html2link;
  if(prior){
    if(prior.sourceHash!==identity.sourceHash||prior.requestHash!==identity.requestHash||context.task.submittedAt!==prior.createdAt)return {status:'needs_input',message:'HTML2Link 原记录或原稿不一致，禁止重发',html2link:prior,submittedAt:context.task.submittedAt};
    const recovered=await reconcileHtml2LinkTask(context,deps),saved=recovered.html2link??prior;
    if(recovered.status==='found')return {status:'review',message:'HTML2Link 原公开页已用只读请求找回，没有重发',publicUrl:recovered.publicUrl,html2link:recovered.html2link,checkpoint:'html2link_published',submittedAt:prior.createdAt};
    const publicUrl=receipt(saved)?.publicUrl;
    return {status:'review',message:saved.stage==='opaque_response'?'HTML2Link 完整原响应已加密保留，但固定契约尚不能确认公开地址；停止且不重发':saved.stage==='api_receipt'||saved.stage==='published'?'HTML2Link 平台返回记录已保留；公开页只读验收尚未通过':'HTML2Link 单次上传结果不明；永久提交闩锁已保留且不会重发',html2link:saved,checkpoint:saved.stage==='opaque_response'?'html2link_opaque_response':saved.stage==='api_receipt'||saved.stage==='published'?'html2link_api_receipt':'html2link_create_submitting',submittedAt:prior.createdAt,...(publicUrl?{publicUrl}:{})};
  }
  if(context.task.submittedAt||context.task.publicUrl||/^html2link_/.test(context.task.checkpoint??''))return {status:'needs_input',message:'HTML2Link 提交痕迹缺少完整提交信息，禁止重发'};
  const result=await createHtml2LinkPublication({operationId:operationId(context.task.id),reviewed:true,article:identity.article},context.html2LinkPersistence,{...deps,signal:context.signal});
  if(result.status==='not_started')return {status:'needs_input',message:result.reason==='external_write_disabled'?'HTML2Link 外部写入默认关闭，未发送':result.reason==='invalid_content'?'HTML2Link 稿件格式或大小无效，未发送':result.reason==='authorization_changed'?'HTML2Link 提交前授权已改变；永久提交信息已保留且不会重发':'HTML2Link 提交信息未安全保存，未发送'};
  if(result.status==='blocked')return {status:'review',message:'HTML2Link 已有永久提交闩锁，停止且不重发',html2link:{...result.intent,stage:'submitting'},checkpoint:'html2link_create_submitting',submittedAt:result.intent.createdAt};
  if(result.status==='unknown')return {status:'review',message:`HTML2Link 单次上传结果不明（${DIAGNOSTIC[result.diagnostic]}）；${result.opaqueResponseSaved?'完整原响应已加密保留':'永久提交闩锁已保留'}，不会重发`,html2link:{...result.intent,stage:result.opaqueResponseSaved?'opaque_response':'submitting'},checkpoint:result.opaqueResponseSaved?'html2link_opaque_response':'html2link_create_submitting',submittedAt:result.intent.createdAt};
  const saved:Html2LinkTaskReceipt={...intent(result.receipt),slug:result.receipt.slug,publicUrl:result.receipt.publicUrl,stage:'api_receipt'};
  const verification=await verifyHtml2LinkPublication(result.receipt,identity.article,{fetch:deps.fetch,signal:context.signal,timeoutMs:deps.timeoutMs,now:deps.now,evidence:context.html2LinkPersistence});
  return verification.status==='usable'
    ?{status:'review',message:'HTML2Link 完整原响应与更新密钥已加密保存，公开全文只读验收通过',publicUrl:result.receipt.publicUrl,html2link:{...saved,stage:'published'},checkpoint:'html2link_published',submittedAt:result.receipt.createdAt}
    :{status:'review',message:'HTML2Link 完整原响应与更新密钥已加密保存；公开页只读验收尚未通过',publicUrl:result.receipt.publicUrl,html2link:saved,checkpoint:'html2link_api_receipt',submittedAt:result.receipt.createdAt};
}

export const html2LinkPublisherTesting={matches,operationId,intent,receipt};
