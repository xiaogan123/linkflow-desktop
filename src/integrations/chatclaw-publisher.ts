import {prepareChatClawPost,runChatClawAcceptance,verifyChatClawPublication,type ChatClawReceipt} from './chatclaw';
import {publicIdentitySlug} from './public-identity';
import {createChatClawPublicationPersistence} from '../main/chatclaw-publication';
import {socialDraftError} from '../shared/social-content';
import type {ChatClawTaskReceipt,ExecutionContext,ExecutionResult,LinkResult} from '../shared/types';

function matches(context:ExecutionContext){return context.channel.id==='chatclaw'&&context.channel.domain==='chatclaw.com'&&context.channel.kind==='community'&&context.channel.contentFormat==='social'&&context.channel.automation==='api'&&!context.channel.accountRequired&&!context.channel.emailRequired&&context.channel.articleRequired&&context.task.channelId==='chatclaw'&&context.task.sourceDomain==='chatclaw.com'&&!context.task.accountId}
function identity(context:ExecutionContext){const handle=publicIdentitySlug(context.site,context.site.id,40).replaceAll('-','_');return {name:[...`${context.site.name||context.site.domain} Project`].slice(0,120).join(''),handle}}
function receipt(value:ChatClawReceipt,stage:ChatClawTaskReceipt['stage'],extra:Partial<Pick<ChatClawTaskReceipt,'targetRel'|'robots'>>={}):ChatClawTaskReceipt{return {stage,intent:{operationId:value.operationId,stage:value.stage,requestUrl:value.requestUrl,requestHash:value.requestHash,createdAt:value.createdAt,name:value.name,handle:value.handle,...(value.agentId?{agentId:value.agentId}:{}),contentSha256:value.contentSha256},postId:value.postId,publicUrl:value.publicUrl,...extra}}

export async function runChatClawTask(context:ExecutionContext):Promise<ExecutionResult>{
  if(!matches(context))return {status:'needs_input',message:'当前平台规格不支持 ChatClaw 软件短帖'};
  const error=socialDraftError(context.task,context.site,context.channel);if(error||!context.task.articleApprovedAt)return {status:'needs_input',message:error??'ChatClaw 短帖须先通过当前稿件检查'};
  let post;try{post=prepareChatClawPost({content:context.task.draft!.body,targetUrl:context.task.topicUrl??context.site.url})}catch{return {status:'needs_input',message:'ChatClaw 短帖须为 40–280 个字符并只含准确目标链接'}}
  const persistence=await createChatClawPublicationPersistence({task:context.task,siteId:context.site.id,secrets:context.secrets,checkpoint:context.checkpoint}),profile=identity(context),result=await runChatClawAcceptance({operationSeed:context.task.id.replaceAll('-',''),...profile,post},persistence,{...context.chatclawDependencies,signal:context.signal,allowExternalWrite:!context.task.chatclaw});
  const found=result.publish?.status==='created'?result.publish.value:result.reconciliation?.status==='found'?result.reconciliation.receipt:undefined,verification=result.verification??(result.reconciliation?.status==='found'?result.reconciliation.verification:undefined);
  if(found&&verification?.status==='usable'){const saved=receipt(found,'published',{targetRel:verification.rel,robots:verification.robots});context.checkpoint({chatclaw:saved,publicUrl:saved.publicUrl,checkpoint:'chatclaw_published',linkRel:verification.rel});return {status:'review',message:'ChatClaw 固定账号、原短帖、公开页和目标链接已核对；不代表搜索收录或长期保留。',publicUrl:saved.publicUrl,checkpoint:'chatclaw_published',linkRel:verification.rel,chatclaw:saved}}
  const visible=context.task.chatclaw;if(visible)return {status:'review',message:'ChatClaw 原单次操作已保存；未知结果只做 GET 对账，不会重发。',submittedAt:context.task.submittedAt,publicUrl:context.task.publicUrl,chatclaw:visible};
  if(result.identity.status==='blocked')return {status:'needs_input',message:'当前站点已有未确认的 ChatClaw 注册事务；不会再次注册、换 handle 或切换账号。'};
  const intent=result.publish&&'intent' in result.publish?result.publish.intent:result.identity&&'intent' in result.identity?result.identity.intent:undefined;
  return {status:'review',message:'ChatClaw 单次注册或发帖结果尚未确认；原操作记录已保存，后续只读恢复。',submittedAt:intent?.createdAt};
}

export async function reconcileChatClawTask(context:ExecutionContext):Promise<{status:'found';publicUrl:string;chatclaw:ChatClawTaskReceipt;verification:LinkResult}|{status:'unknown'}>{const result=await runChatClawTask(context);if(!result.publicUrl||result.chatclaw?.stage!=='published')return {status:'unknown'};return {status:'found',publicUrl:result.publicUrl,chatclaw:result.chatclaw,verification:{found:true,outcome:'found',url:result.publicUrl,rel:result.linkRel??'unknown',reason:'ChatClaw 固定帖子页仍含原短帖和准确目标链接；不依赖最新动态流。'}}}

export async function verifyChatClawTask(context:ExecutionContext):Promise<LinkResult>{const saved=context.task.chatclaw,url=context.task.publicUrl??'https://chatclaw.com/';if(!matches(context)||saved?.stage!=='published'||!saved.postId||!saved.publicUrl||saved.publicUrl!==context.task.publicUrl||!context.task.draft)return {found:false,outcome:'invalid',url,rel:'unknown',reason:'ChatClaw 缺少与原稿绑定的固定帖子记录'};let post;try{post=prepareChatClawPost({content:context.task.draft.body,targetUrl:context.task.topicUrl??context.site.url})}catch{return {found:false,outcome:'invalid',url,rel:'unknown',reason:'ChatClaw 原短帖已改变'}}const checked=await verifyChatClawPublication({...saved.intent,postId:saved.postId,publicUrl:saved.publicUrl},post,{...context.chatclawDependencies,signal:context.signal});return checked.status==='usable'?{found:true,outcome:'found',url:checked.publicUrl,rel:checked.rel,reason:'ChatClaw 固定帖子页仍含原短帖和准确目标链接；不代表搜索收录或长期保留。'}:{found:false,outcome:checked.status==='invalid'?'invalid':'unreachable',url,rel:'unknown',reason:'ChatClaw 固定帖子页未通过只读检查'}}

export const chatClawPublisherTesting={matches,identity,receipt};
