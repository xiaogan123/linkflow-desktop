import type {ExecutionContext,ExecutionResult,LinkResult,Task} from '../shared/types';
import {recoverAgentelPublication,runAgentelPublication,verifyAgentelPublic,validateAgentelArticle,type AgentelArticle} from '../integrations/agentel';
import {parseAgentelCredential} from './agentel-publication';

export function agentelTaskArticle(task:Task,siteUrl:string):AgentelArticle{
  if(!task.draft||!task.topicUrl)throw Error('agentel_original_draft_missing');
  return validateAgentelArticle({title:task.draft.title,content:task.draft.body,targetUrl:task.topicUrl,siteUrl});
}
async function connected(context:ExecutionContext){
  const account=context.getAccount();if(!account||account.channelId!=='agentel'||account.id!==context.task.accountId||account.ownerSiteId!==context.site.id
    ||account.status!=='registered'||!account.hasPassword||account.retiredAt||!context.agentelJournalFactory)return;
  const credential=parseAgentelCredential(await context.secrets.get(`account:${account.id}`));
  if(!credential||credential.slug!==account.username)return;
  let article:AgentelArticle;try{article=agentelTaskArticle(context.task,context.site.url)}catch{return}
  return {credential,article,journal:context.agentelJournalFactory(credential,article)};
}
export async function runAgentelConnectedTask(context:ExecutionContext):Promise<ExecutionResult>{
  const identity=await connected(context);if(!identity||!context.assertAgentelAuthorized)return {status:'needs_input',message:'Agentel 原账号、原创稿或加密事务未就绪'};
  const result=await runAgentelPublication(identity.article,identity.credential,{journal:identity.journal,siteId:context.site.id,taskId:context.task.id,
    authorize:context.assertAgentelAuthorized,dependencies:context.batch5Dependencies,signal:context.signal});
  if(result.status==='verified')return {status:'review',publicUrl:result.publicUrl,message:'Agentel 原创软件技术笔记已公开，待独立验收'};
  if(result.status==='unknown')return {status:'review',reasonCode:'submission_unknown',message:'Agentel 原请求结果不明；已保留加密事务，只会 GET 核对，不会重发'};
  return {status:'needs_input',message:'Agentel 原账号或公开页核对未通过；未提交新笔记'};
}
export async function reconcileAgentelConnectedTask(context:ExecutionContext):Promise<{status:'found';publicUrl:string;batch5:NonNullable<Task['batch5']>}|{status:'unknown'}>{
  const identity=await connected(context),journal=await identity?.journal.load(),url=context.task.publicUrl,summary=context.task.batch5;
  // A saved response is promoted by GET only, atomically with its journal. No path here can send the original POST again.
  if(identity&&journal?.stage==='opaque'&&summary?.stage==='opaque_response'&&!url){
    const recovered=await recoverAgentelPublication(identity.article,identity.credential,{journal:identity.journal,siteId:context.site.id,taskId:context.task.id,dependencies:context.batch5Dependencies,signal:context.signal}).catch(()=>undefined);
    return recovered?.status==='verified'&&recovered.publicUrl?{status:'found',publicUrl:recovered.publicUrl,batch5:{...summary,stage:'api_receipt',publicUrl:recovered.publicUrl}}:{status:'unknown'};
  }
  if(!identity||!journal||journal.stage!=='verified'||!url||!summary||!['api_receipt','published'].includes(summary.stage))return {status:'unknown'};
  return await verifyAgentelPublic(url,identity.article,context.batch5Dependencies,context.signal).catch(()=>false)
    ?{status:'found',publicUrl:url,batch5:summary}:{status:'unknown'};
}
export async function verifyAgentelConnectedPublication(context:ExecutionContext):Promise<LinkResult>{
  const identity=await connected(context),url=context.task.publicUrl;
  if(!identity||!url)return {found:false,outcome:'unreachable',url:url??'https://agentel.tech/',rel:'',reason:'Agentel 原账号或发布事务未就绪'};
  const found=await verifyAgentelPublic(url,identity.article,context.batch5Dependencies,context.signal).catch(()=>false);
  return found?{found:true,outcome:'found',url,rel:'',reason:'Agentel 原生正文和目标链接已核对'}:{found:false,outcome:'unreachable',url,rel:'',reason:'Agentel 公开原生正文或唯一链接未通过核对'};
}
