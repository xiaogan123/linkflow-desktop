import type {Account,ArticleReviewMode,Category,Channel,Site,Snapshot,Task} from '../shared/types';
import {reservesSlot,hasBloggerDraftReceipt} from '../shared/publication';
export const categoryText:Record<Category,string>={software:'软件工具',ai:'AI 产品',developer:'开发者',design:'设计作品',business:'商业服务',content:'内容创作',education:'教育学习',finance:'金融内容',general:'综合网站'};
export const kindText:Record<Channel['kind'],string>={directory:'产品目录',profile:'品牌资料',article:'内容发布',community:'社区分享'};
export const dateLabel=(value?:string)=>{if(!value)return '—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric'}).format(date)};
export const languageLabel=(value:string)=>({en:'英语',zh:'中文',ja:'日语',de:'德语',fr:'法语',es:'西班牙语',any:'不限',all:'多语言','*':'不限'}[value]??value);

export type TaskWorkKind='progress'|'user_action'|'system_retry'|'channel_wait'|'deferred'|'result'|'closed';
export type TaskTone='green'|'blue'|'amber'|'red'|'muted';
export type ChannelReadiness='ready'|'autocreate'|'handoff_required'|'manual';
export interface TaskPresentation {kind:TaskWorkKind;label:string;tone:TaskTone}

const transientReviewCodes=new Set(['evidence_fetch_failed','evidence_invalid','ai_unavailable','format_invalid']);
const channelWaitReviewCodes=new Set(['policy_unknown','policy_not_found','input_too_long','content_rejected']);
const publicationCheckpoints=new Set(['submitting','submitted','submission_uncertain','telegraph_publish_submitting','telegraph_publish_uncertain','telegraph_published','gist_published']);
const telegraphUncertainCheckpoints=new Set(['telegraph_publish_submitting','telegraph_publish_uncertain']);
const taskAiBudget=6,telegraphReconcileLimit=3;
const normalize=(value:string)=>value.trim().toLowerCase();

export function taskHasArticleReview(task:Task){return (!task.submittedAt||hasBloggerDraftReceipt(task))&&task.status!=='live'&&(task.checkpoint==='article_review'||!!task.articleReview)}

export function taskHasSubmissionEvidence(task:Task){return !!(task.submittedAt||task.publicUrl||task.firstLiveAt)||publicationCheckpoints.has(task.checkpoint??'')}
export function taskHasUnconfirmedSubmission(task:Task){return !task.publicUrl&&!task.firstLiveAt&&(!!task.submittedAt||publicationCheckpoints.has(task.checkpoint??''))}

export function taskCanAutoRecover(task:Task,channelEnabled=true){
  const recoverableReason=task.recoveryEligible===true||transientReviewCodes.has(task.articleReview?.reasonCode??'');
  return channelEnabled&&task.status==='failed'&&task.checkpoint==='system_wait'&&recoverableReason&&!!task.nextCheckAt&&(task.recoveryAttempts??0)<1&&(task.cost?.aiCalls??0)<taskAiBudget&&(!taskHasSubmissionEvidence(task)||hasBloggerDraftReceipt(task))&&!task.deferredAt;
}

export function taskNeedsTelegraphReconciliation(task:Task,channelEnabled=true){
  return channelEnabled&&task.channelId==='telegraph'&&!task.publicUrl&&!!task.submittedAt&&telegraphUncertainCheckpoints.has(task.checkpoint??'')&&(task.reconcileAttempts??0)<telegraphReconcileLimit;
}

export function taskAutomaticFollowupAt(task:Task,channelEnabled=true):string|undefined{
  if(taskNeedsTelegraphReconciliation(task,channelEnabled))return task.reconcileAfter;
  if(taskCanAutoRecover(task,channelEnabled))return task.nextCheckAt;
  if(task.status==='queued'&&channelEnabled)return task.scheduledAt;
  if(task.publicUrl&&task.nextCheckAt&&['review','expired','live','needs_input'].includes(task.status))return task.nextCheckAt;
  return undefined;
}

export function canResumeDeferredTask(task:Task){return !!task.deferredAt&&!taskHasSubmissionEvidence(task)}

export function taskWorkKind(task:Task,reviewMode:ArticleReviewMode='manual',channelEnabled=true):TaskWorkKind{
  const failedReview=task.articleReview?.status==='failed',reasonCode=task.articleReview?.reasonCode;
  if(task.status==='live')return 'result';
  if(task.deferredAt&&!taskHasSubmissionEvidence(task))return 'deferred';
  if(taskNeedsTelegraphReconciliation(task,channelEnabled)||taskCanAutoRecover(task,channelEnabled))return 'system_retry';
  if(taskHasUnconfirmedSubmission(task)&&['needs_input','failed','skipped'].includes(task.status))return 'user_action';
  if(task.status==='skipped')return 'closed';
  // The current task state is authoritative. A previous review failure must not
  // hide a later account, verification, or uncertain-submission handoff.
  if(task.status==='needs_input')return 'user_action';
  if(task.status==='failed'&&(!!task.submittedAt||publicationCheckpoints.has(task.checkpoint??'')))return 'user_action';
  if(task.checkpoint==='channel_wait'||task.status==='expired'||failedReview&&!!reasonCode&&channelWaitReviewCodes.has(reasonCode))return 'channel_wait';
  if(task.checkpoint==='system_wait'||failedReview&&!!reasonCode&&transientReviewCodes.has(reasonCode))return 'system_retry';
  if(task.status==='failed')return 'user_action';
  return 'progress';
}

export function taskPresentation(task:Task,reviewMode:ArticleReviewMode='manual',channelEnabled=true):TaskPresentation{
  const kind=taskWorkKind(task,reviewMode,channelEnabled),review=task.articleReview,reasonCode=review?.reasonCode;
  if(kind==='deferred')return {kind,label:'已搁置',tone:'muted'};
  if(kind==='channel_wait'){
    if(reasonCode==='policy_unknown'||reasonCode==='policy_not_found')return {kind,label:'等待渠道许可证据',tone:'muted'};
    if(task.status==='expired')return {kind,label:'等待渠道结果',tone:'muted'};
    return {kind,label:'等待新证据或渠道',tone:'muted'};
  }
  if(kind==='system_retry'){
    if(taskNeedsTelegraphReconciliation(task,channelEnabled))return {kind,label:'自动查询发布结果',tone:'blue'};
    if(task.status==='queued')return {kind,label:'系统将自动重试',tone:'blue'};
    if(taskCanAutoRecover(task,channelEnabled))return {kind,label:'等待最后一次自动恢复',tone:'blue'};
    return {kind,label:'系统处理已暂停',tone:'muted'};
  }
  if(kind==='user_action'){
    const label=task.checkpoint==='account_handoff'?'需要连接账号'
      :task.checkpoint==='ai_setup_required'?'需要连接 AI'
      :task.checkpoint==='system_vault_unavailable'?'需要系统授权'
      :task.checkpoint==='manual_submission'?'需要人工提交'
      :task.checkpoint==='account_registration_submitted'?'需要完成账号验证'
      :task.checkpoint==='article_review'&&reviewMode==='manual'?'稿件待人工审核'
      :task.submittedAt||publicationCheckpoints.has(task.checkpoint??'')?'需要确认发布结果'
      :'任务需要处理';
    return {kind,label,tone:task.status==='failed'?'red':'amber'};
  }
  if(kind==='result')return {kind,label:task.health==='unknown'?'待重新确认':'当前有效',tone:'green'};
  if(kind==='closed')return {kind,label:'已跳过',tone:'muted'};
  if(review?.status==='running')return {kind,label:'AI 审核中',tone:'blue'};
  if(review?.status==='passed'&&task.status==='running')return {kind,label:'审核通过，发布中',tone:'blue'};
  if(task.status==='review')return {kind,label:'等待平台结果',tone:'blue'};
  if(task.status==='running')return {kind,label:'执行中',tone:'blue'};
  if(task.status==='queued'&&task.checkpoint==='article_review')return {kind,label:'等待 AI 审核',tone:'blue'};
  if(task.status==='queued')return {kind,label:'等待执行',tone:'muted'};
  return {kind,label:'继续推进',tone:'blue'};
}

export function articleReviewTitle(task:Task,reviewMode:ArticleReviewMode='manual',channelEnabled=true){
  const review=task.articleReview,presentation=taskPresentation(task,reviewMode,channelEnabled);
  if(presentation.kind==='channel_wait'||presentation.kind==='system_retry')return presentation.label;
  if(review?.status==='running')return 'AI 正在独立审核稿件';
  if(review?.status==='passed')return review.reasonCode==='user_policy_decision'?'AI 内容审核通过 · 已有渠道使用确认':'AI 审核通过，正在继续发布';
  if(review?.status==='failed')return 'AI 审核未通过';
  return reviewMode==='ai'?'稿件等待独立 AI 审核':'稿件等待人工审核';
}

export function articleReviewDetail(task:Task,reviewMode:ArticleReviewMode='manual',channelEnabled=true){
  const review=task.articleReview,kind=taskWorkKind(task,reviewMode,channelEnabled);
  if(review?.reasonCode==='policy_unknown')return '现有内容政策证据的适用范围尚未确认，任务未发布；当前来源已停止，出现新证据后可重新评估。';
  if(review?.reasonCode==='policy_not_found')return '现有公开资料中尚未找到适用的内容政策，任务未发布；当前来源已停止，出现新证据后可重新评估。';
  if(kind==='system_retry')return task.message||review?.reason||(taskNeedsTelegraphReconciliation(task,channelEnabled)?'已提交的结果正在自动查询，查询期间不会重复发布。':task.status==='queued'||taskCanAutoRecover(task,channelEnabled)?'公开证据或 AI 服务暂时不可用，系统会按已保存的计划再次检查。':'自动重试已停止，当前未安排再次检查；其他可执行渠道仍会继续。');
  if(kind==='channel_wait')return review?.reason||task.message||'当前来源等待新证据或渠道结果，其他可执行任务会继续。';
  if(review?.status==='running')return '系统正在独立核对稿件与任务要求。';
  if(review?.status==='passed')return review.reasonCode==='user_policy_decision'?review.reason:'审核通过后才进入发布流程，公开结果仍需另行核验。';
  if(review?.status==='failed')return review.reason||'证据不足或审核未通过。';
  return reviewMode==='ai'?'保存的稿件将由独立 AI 审核；通过后才继续发布。':'请核对稿件并确认，确认前不会发布。';
}

export const isUserActionTask=(task:Task,reviewMode:ArticleReviewMode='manual',channelEnabled=true)=>taskWorkKind(task,reviewMode,channelEnabled)==='user_action';
export const canRetryTaskManually=(task:Task,reviewMode:ArticleReviewMode='manual',channelEnabled=true)=>isUserActionTask(task,reviewMode,channelEnabled)&&!taskHasArticleReview(task)&&!taskHasSubmissionEvidence(task)&&['needs_input','failed'].includes(task.status);
export const canRestartArticleReview=(task:Task,reviewMode:ArticleReviewMode='manual',channelEnabled=true)=>reviewMode==='ai'&&isUserActionTask(task,reviewMode,channelEnabled)&&taskHasArticleReview(task)&&task.articleReview?.status!=='running';

export function taskHasAutomaticFollowup(task:Task,channelEnabled=true){
  return taskNeedsTelegraphReconciliation(task,channelEnabled)||taskCanAutoRecover(task,channelEnabled)||!!taskAutomaticFollowupAt(task,channelEnabled);
}

export function taskSortRank(task:Task,reviewMode:ArticleReviewMode='manual',channelEnabled=true){
  const kind=taskWorkKind(task,reviewMode,channelEnabled);
  if(task.status==='running')return 0;
  if(task.status==='queued')return 1;
  if(kind==='user_action')return 2;
  if(task.status==='review')return 3;
  if(kind==='system_retry')return 4;
  if(kind==='channel_wait')return 5;
  if(kind==='deferred')return 6;
  if(kind==='result')return 7;
  return 8;
}

export function taskReservesPlanningSlot(task:Task,now=new Date()){return reservesSlot(task,now)}

function reservesSingleProfile(task:Task){
  return !!task.publicUrl||!!task.submittedAt||task.checkpoint==='account_registration_submitted'||publicationCheckpoints.has(task.checkpoint??'');
}

function profileAccountConflict(data:Snapshot,accountId:string,siteId:string,channelId:string){
  const historical=data.tasks.some(task=>task.accountId===accountId&&task.channelId===channelId&&task.siteId!==siteId&&reservesSingleProfile(task));
  return historical||data.accountBindings.some(binding=>binding.accountId===accountId&&binding.channelId===channelId&&binding.siteId!==siteId&&data.tasks.some(task=>task.siteId===binding.siteId&&task.channelId===channelId&&reservesSingleProfile(task)));
}

function candidateAccounts(data:Snapshot,site:Site,channelId:string){
  return data.accounts.filter(account=>account.channelId===channelId&&(channelId==='github-gist'||normalize(account.email)===normalize(site.publicEmail||site.email)));
}

function accountForSiteChannel(data:Snapshot,site:Site,channel:Channel):Account|undefined{
  const binding=data.accountBindings.find(item=>item.siteId===site.id&&item.channelId===channel.id);
  if(binding)return data.accounts.find(account=>account.id===binding.accountId);
  const candidates=candidateAccounts(data,site,channel.id);
  const usableCandidates=['telegraph','github-gist'].includes(channel.id)?candidates.filter(account=>account.credentialKind==='api_token'):candidates;
  return usableCandidates.find(account=>account.status==='registered'&&account.hasPassword)
    ??usableCandidates.find(account=>account.status==='unknown'&&account.hasPassword)
    ??usableCandidates[0];
}

export function channelReadinessForDisplay(data:Snapshot,site:Site,channel:Channel):ChannelReadiness{
  if(channel.automation==='manual')return 'manual';
  if(channel.id==='blogger'){const binding=data.accountBindings.find(item=>item.siteId===site.id&&item.channelId==='blogger'),account=data.accounts.find(item=>item.id===binding?.accountId&&item.channelId==='blogger');return site.blogger&&account?.credentialKind==='oauth'&&account.status==='registered'&&account.hasPassword?'ready':'handoff_required'}
  if(!channel.accountRequired)return 'ready';
  const binding=data.accountBindings.find(item=>item.siteId===site.id&&item.channelId===channel.id);
  const compatible=(candidate:Account)=>channel.automation==='api'?candidate.credentialKind==='api_token':candidate.credentialKind!=='api_token';
  let account=accountForSiteChannel(data,site,channel);
  if(!binding){
    const candidates=candidateAccounts(data,site,channel.id).filter(compatible);
    account=candidates.find(candidate=>candidate.status==='registered'&&candidate.hasPassword)
      ??candidates.find(candidate=>candidate.status==='unknown'&&candidate.hasPassword)
      ??candidates[0]
      ??account;
  }
  if(account){
    if(!compatible(account)){
      if(!binding&&channel.id==='telegraph'&&channel.automation==='api')return 'autocreate';
      return 'handoff_required';
    }
    if(channel.kind==='profile'&&profileAccountConflict(data,account.id,site.id,channel.id))return 'handoff_required';
    if(channel.id==='telegraph'&&channel.automation==='api'&&account.status==='draft'&&account.source==='generated'&&account.credentialKind==='api_token'&&(account.registrationAttempts??0)<1)return 'autocreate';
    const apiReady=channel.automation==='api'&&account.status==='registered'&&account.hasPassword&&account.credentialKind==='api_token';
    const browserReady=channel.automation==='browser'&&account.hasPassword&&['registered','unknown'].includes(account.status);
    return apiReady||browserReady?'ready':'handoff_required';
  }
  return channel.id==='telegraph'&&channel.automation==='api'?'autocreate':'handoff_required';
}

export const channelReadinessLabel:Record<ChannelReadiness,string>={
  ready:'账号与执行条件已就绪',autocreate:'任务会自动创建官方 API 身份',handoff_required:'需先连接并验证已有账号',manual:'需人工准备并提交',
};
