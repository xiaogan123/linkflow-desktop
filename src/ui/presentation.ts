import {BATCH9B_MESSAGES} from '../shared/batch9b-messages';
import {displayParts} from './display-time';
import type {Account,ArticleReviewMode,Category,Channel,Site,Snapshot,Task} from '../shared/types';
import {reservesSlot,hasRecoverablePublisherDraftReceipt} from '../shared/publication';
import {hasLegacyPublicIdentityMarker} from '../shared/public-identity-policy';
import {TASK_AI_BUDGET} from '../main/task-recovery';
import {firstIdentitySite,liveOwnerSiteId} from '../main/account-retirement';
import {isHumanAuthoredOnlyChannel} from '../shared/human-authored-only';
import {bloggerBlogIdConflict} from '../shared/blogger-ownership';
import {isTaskReasonCode,type TaskReasonCode} from '../shared/task-reasons';
export const categoryText:Record<Category,string>={software:'软件工具',ai:'AI 产品',developer:'开发者',design:'设计作品',business:'商业服务',content:'内容创作',education:'教育学习',finance:'金融内容',general:'综合网站'};
export const kindText:Record<Channel['kind'],string>={directory:'产品目录',profile:'品牌资料',article:'内容发布',community:'社区分享'};
export const dateLabel=(value?:string)=>{if(!value)return '—';const date=new Date(value);if(Number.isNaN(date.getTime()))return '—';const parts=displayParts(date);return `${parts.month}月${parts.day}日`};
export const languageLabel=(value:string)=>({en:'英语',zh:'中文',ja:'日语',de:'德语',fr:'法语',es:'西班牙语',any:'不限',all:'多语言','*':'不限'}[value]??value);

export type TaskWorkKind='progress'|'user_action'|'system_retry'|'channel_wait'|'deferred'|'result'|'closed';
export type TaskTone='green'|'blue'|'amber'|'red'|'muted';
export type ChannelReadiness='ready'|'autocreate'|'handoff_required'|'manual';
export interface TaskPresentation {kind:TaskWorkKind;label:string;tone:TaskTone}

export type TaskDisplayStateName='scheduled'|'in_progress'|'action_required'|'published'|'published_recheck'|'failed';
export interface TaskDisplayState {state:TaskDisplayStateName;label:string;detail:string;action?:string;deadlineText?:string}
export interface TaskDisplayInput extends Task {
  platformName?:string;
}
export type TaskHumanActionGroup='verification'|'account'|'review'|'manual_write'|'manual_publish';

/** Approved user-facing copy. Saved messages remain available only as technical details. */
export const taskDisplayCopy={
  labels:{scheduled:'已排期',in_progress:'进行中',action_required:'要你处理',published:'已发布',published_recheck:'已发布·待复查',failed:'没做成'},
  stages:{writing:'写稿中',reviewing:'AI 复核中',publishing:'发布中',waiting:'等平台结果',email:'等验证邮件'},
  actions:{human_required:'去处理',captcha_required:'去验证',agreement_required:'去确认',account_handoff:'去连接',manual_review:'看稿',human_timeout:'恢复',user_skipped:'恢复',unknown:'看原因'},
  humanInstructions:{verification:'在打开的窗口里勾选「我不是机器人」，大约 30 秒',account:'连接发布账号',review:'看一下写好的稿件',manual_publish:'把写好的稿件发到平台',agreement:'确认平台条款',other:'按提示完成这一步'},
  reasonTemplates:{
    analysis_daily_limit:BATCH9B_MESSAGES.analysisLimit,
    ai_daily_limit:'今天的 AI 次数用完了，这篇改到 {日期} 写。',
    ai_rate_limited:'AI 服务暂时限制请求频率，{时间} 后再试。',
    ai_task_limit:'这篇用了 {n} 次 AI 仍没通过复核，先放弃，换一篇重写。',
    content_rejected:'AI 复核没通过：{一句原因}。这个平台 45 天内不再给这个站发。',
    duplicate_content:'和已发过的文章太像，已换一个角度重写。',
    evidence_insufficient:'网站资料不够支撑这篇文章，已换一篇。',
    evidence_truncated:'这次没读全网站内容，不是稿件的问题，稍后重试。',
    format_repair_exhausted:BATCH9B_MESSAGES.formatStopped,
    format_invalid:'稿件格式不符合这个平台的要求，已重新整理。',
    platform_rejected:'平台拒绝了这篇文章。这个平台 30 天内不再给这个站发。',
    platform_rate_limited:'平台暂时限制发布频率，{时间} 后再试。',
    temporary_failure:'网络或服务暂时不可用，稍后自动重试。',
    human_required:'这一步需要你来完成：{说明}。',
    captcha_required:'注册需要你过一次人机验证，大约 30 秒。',
    phone_required:'这个平台注册要手机号验证，已跳过，改用其他平台。',
    agreement_required:'需要你确认一次平台条款。',
    account_handoff:'需要你连接一次{平台}账号。',
    manual_review:'稿子写好了，等你看一眼。',
    email_code_pending:'等验证邮件',
    human_timeout:'2 天没处理，已先跳过，改用其他平台；14 天后可再用这个平台。',
    channel_disabled:'这个平台已停用，已改用其他平台。',
    channel_ineligible:'这个平台不适合这个站，已改用其他平台。',
    user_skipped:'你跳过了这篇；30 天后可再用这个平台。',
    submission_unknown:'不确定这篇有没有发出去，外链助手正在检查原来的提交，不会重发。',
    invalid_topic:'选的文章页不适合写稿（比如注册页），已换一篇。',
    referral_blocked:'稿件里有邀请码或推荐链接，已删除；删不干净的这篇不发。',
    diversity_deferred:'今天同类文章已经够多，这篇改到之后发。',
    unknown:'这篇没做成，已改用其他平台。',
    platform_capacity:'平台不够用，这篇改到之后发。',
    schedule_missed:'错过了发布时间，已自动改期。',
    review_changes_requested:'AI 复核要求修改，正在重新整理稿件。',
  } satisfies Record<TaskReasonCode,string>,
  rejectionReason:'内容不符合要求',
  retryStopped:'暂时性故障重试几次仍没成功，这篇已停下。',
  workStopped:'这篇已停下，不会再自动处理。',
  platformPending:'发布前确定平台',
  lost:'外链找不到了',
  expired:'外链已到期',
  recoverable:'可以恢复',
  replaced:'已改用其他平台',
  weight:{follow:'可传权重',nofollow:'不传权重',unknown:'属性待查'},
  scheduled:'{时间} 发',
  recheck:'这次没检查到链接，{日期}再查',
  recheckPending:'这次没检查到链接，等待下次检查',
  remaining:'还剩 {时间}，到期自动换平台',
  remainingReview:'还剩 {时间}，到期放弃这篇',
};

const legacyDisplayReasons:Record<string,TaskReasonCode>={
  evidence_fetch_failed:'temporary_failure',ai_unavailable:'temporary_failure',evidence_invalid:'evidence_insufficient',
  policy_unknown:'channel_ineligible',policy_not_found:'channel_ineligible',input_too_long:'evidence_truncated',
  user_policy_decision:'agreement_required',submission_uncertain:'submission_unknown',manual_submission:'human_required',
  account_registration_submitted:'captcha_required',verification_required:'captcha_required',
};
const humanKindReasons:Record<string,TaskReasonCode>={
  captcha:'captcha_required',captcha_required:'captcha_required',verification:'captcha_required',verify:'captcha_required',human_verification:'captcha_required',
  phone:'phone_required',
  agreement:'agreement_required',agreement_required:'agreement_required',terms:'agreement_required',consent:'agreement_required',
  account:'account_handoff',account_handoff:'account_handoff',connect_account:'account_handoff',account_connection:'account_handoff',account_login:'account_handoff',
  review:'manual_review',manual_review:'manual_review',article_review:'manual_review',review_draft:'manual_review',
  manual_publish:'human_required',manual_submission:'human_required',publish:'human_required',human_required:'human_required',
  email_code_ambiguous:'human_required',email_confirmation:'human_required',selector_drift:'human_required',
};
const displayHumanReasons=new Set<TaskReasonCode>(['human_required','captcha_required','agreement_required','account_handoff','manual_review']);
const dayMs=86_400_000;
const minuteMs=60_000;

function displayTime(value:Date|string|number):number{
  const time=value instanceof Date?value.getTime():typeof value==='number'?value:Date.parse(value);
  return Number.isFinite(time)?time:0;
}
function validDisplayTime(value?:string):number|undefined{
  if(!value)return undefined;
  const time=Date.parse(value);
  return Number.isFinite(time)?time:undefined;
}
function displayDate(time:number,withTime=false):string{
  const date=displayParts(new Date(time));
  const day=`${date.month}月${date.day}日`;
  return withTime?`${day} ${String(date.hour).padStart(2,'0')}:${String(date.minute).padStart(2,'0')}`:day;
}
function displayDuration(milliseconds:number):string{
  const minutes=Math.max(0,Math.ceil(milliseconds/minuteMs));
  if(minutes<60)return `${minutes} 分钟`;
  const hours=Math.ceil(minutes/60);
  return hours<24?`${hours} 小时`:`${Math.floor(hours/24)} 天${hours%24?` ${hours%24} 小时`:''}`;
}
function humanKind(task:TaskDisplayInput):string|undefined{return task.humanAction?.kind.toLowerCase().replaceAll('-','_')}
function displayReasonCode(task:TaskDisplayInput):TaskReasonCode{
  const reason:unknown=task.reasonCode;
  if(isTaskReasonCode(reason))return reason;
  if(typeof reason==='string'&&legacyDisplayReasons[reason])return legacyDisplayReasons[reason];
  if(task.status==='needs_input'&&task.checkpoint==='waiting_email'&&task.emailWait&&!task.humanAction)return 'email_code_pending';
  const action=humanKind(task);
  if(action&&humanKindReasons[action])return humanKindReasons[action];
  if(task.status==='needs_input'){
    if(task.checkpoint==='account_handoff')return 'account_handoff';
    if(task.checkpoint==='account_registration_submitted')return 'captcha_required';
  }
  // Old data has structured review reasons and checkpoints but no task-level reason code.
  const oldReason=task.articleReview?.reasonCode;
  if(oldReason&&oldReason!=='passed')return isTaskReasonCode(oldReason)?oldReason:legacyDisplayReasons[oldReason]??'unknown';
  if(task.status==='needs_input'){
    if(task.checkpoint==='article_review')return 'manual_review';
    if(task.checkpoint==='account_handoff')return 'account_handoff';
    if(task.checkpoint==='account_registration_submitted')return 'captcha_required';
    return 'human_required';
  }
  return 'unknown';
}
function displayActionReason(task:TaskDisplayInput):TaskReasonCode{
  const kind=humanKind(task);
  return kind&&humanKindReasons[kind]||displayReasonCode(task);
}
function oldHumanActionDate(task:TaskDisplayInput,key:'deadlineAt'|'createdAt'):number|undefined{
  const action=task.humanAction;
  if(!action)return undefined;
  const value:unknown=Object.getOwnPropertyDescriptor(action,key)?.value;
  return typeof value==='string'?validDisplayTime(value):undefined;
}
export function taskHumanActionDeadline(task:TaskDisplayInput):number{
  const explicit=validDisplayTime(task.humanAction?.deadline)??oldHumanActionDate(task,'deadlineAt')??validDisplayTime(task.humanAction?.expiresAt)??validDisplayTime(task.waitingDeadlineAt);
  if(explicit!==undefined)return explicit;
  const start=oldHumanActionDate(task,'createdAt')??validDisplayTime(task.waitingSince)??validDisplayTime(task.updatedAt)??validDisplayTime(task.createdAt)??0;
  return start+(displayActionReason(task)==='captcha_required'?10*minuteMs:2*dayMs);
}
export function taskReasonForDisplay(task:TaskDisplayInput,now:Date|string|number):string{
  const code=displayReasonCode(task),current=displayTime(now);
  if(code==='unknown'&&!task.reasonCode&&!['failed','skipped','expired'].includes(task.status))return '';
  const next=validDisplayTime(task.nextCheckAt)??validDisplayTime(task.scheduledAt)??current+dayMs;
  const kind=humanKind(task);
  const explanation=kind&&['manual_publish','manual_submission','publish'].includes(kind)?taskDisplayCopy.humanInstructions.manual_publish:taskDisplayCopy.humanInstructions.other;
  return taskDisplayCopy.reasonTemplates[code]
    .replace('{日期}',displayDate(next))
    .replace('{n}',String(Math.max(0,task.cost?.aiCalls??0)))
    .replace('{一句原因}',taskDisplayCopy.rejectionReason)
    .replace('{说明}',explanation)
    .replace('{平台}',task.platformName||task.sourceDomain||'平台')
    .replace('{时间}',displayDuration(next-current));
}

/** The six display states never authorize publishing or change recovery eligibility. */
export function taskDisplayState(task:TaskDisplayInput,now:Date|string|number):TaskDisplayState{
  const current=displayTime(now),reason=displayReasonCode(task),label=taskDisplayCopy.labels;
  const published=task.status==='live'||!!task.firstLiveAt;
  if(published){
    if(task.status==='expired'||task.checkpoint==='yourwebs_expired')return {state:'failed',label:label.failed,detail:taskDisplayCopy.expired};
    const missing=task.health==='unknown'||task.health==='missing'||task.linkCheck!=='found'&&(task.linkCheck==='absent'||task.linkCheck==='unreachable'||task.linkCheck==='invalid'||task.reviewKind==='lost_link'||!!task.lostAt);
    if(missing&&(task.consecutiveMissing??0)>=3)return {state:'failed',label:label.failed,detail:taskDisplayCopy.lost};
    if(missing){
      const next=validDisplayTime(task.nextCheckAt);
      return {state:'published_recheck',label:label.published_recheck,detail:next===undefined?taskDisplayCopy.recheckPending:taskDisplayCopy.recheck.replace('{日期}',displayDate(next))};
    }
    const date=validDisplayTime(task.firstLiveAt)??validDisplayTime(task.verifiedAt)??validDisplayTime(task.updatedAt)??current;
    const weight=task.linkRel===undefined?taskDisplayCopy.weight.unknown:/\b(?:nofollow|ugc|sponsored)\b/i.test(task.linkRel)?taskDisplayCopy.weight.nofollow:taskDisplayCopy.weight.follow;
    return {state:'published',label:label.published,detail:`${task.platformName||task.sourceDomain||'平台'} · ${displayDate(date)} · ${weight}`};
  }
  // An existing submission stays visible as pending; it never becomes a generic retry.
  if(reason==='submission_unknown'||taskHasUnconfirmedSubmission(task)&&!hasRecoverablePublisherDraftReceipt(task))return {state:'in_progress',label:label.in_progress,detail:taskDisplayCopy.stages.waiting};
  const recoveryAt=taskCanAutoRecover(task)?validDisplayTime(task.nextCheckAt):undefined;
  if(recoveryAt!==undefined)return {state:'scheduled',label:label.scheduled,detail:taskDisplayCopy.scheduled.replace('{时间}',displayDate(recoveryAt,true))};
  if(['failed','skipped','expired'].includes(task.status)||['phone_required','human_timeout','user_skipped','channel_disabled','channel_ineligible'].includes(reason)){
    const recoverable=reason!=='human_timeout'&&task.status==='skipped'&&canResumeDeferredTask(task)&&(task.cost?.aiCalls??0)<TASK_AI_BUDGET;
    const action=reason==='user_skipped'&&recoverable?taskDisplayCopy.actions.user_skipped:reason==='unknown'?taskDisplayCopy.actions.unknown:undefined;
    // A stopped task is never described as about to retry, whatever its last temporary reason was.
    const promisedRetry=['temporary_failure','platform_rate_limited','evidence_truncated','ai_rate_limited'].includes(reason);
    // Reasons that describe work still to come ("改到之后发", "正在重新整理") are wrong once the task has stopped.
    const promisedWork=['ai_daily_limit','format_invalid','diversity_deferred','platform_capacity','schedule_missed','review_changes_requested'].includes(reason);
    return {state:'failed',label:label.failed,detail:promisedRetry?taskDisplayCopy.retryStopped:promisedWork?taskDisplayCopy.workStopped:taskReasonForDisplay(task,now),...(action?{action}:{}),deadlineText:action==='恢复'?taskDisplayCopy.recoverable:taskDisplayCopy.replaced};
  }
  const actionReason=displayActionReason(task);
  if(task.humanAction||displayHumanReasons.has(reason)){
    const action=taskDisplayCopy.actions[actionReason as keyof typeof taskDisplayCopy.actions]??taskDisplayCopy.actions.human_required;
    return {state:'action_required',label:label.action_required,detail:taskReasonForDisplay({...task,reasonCode:actionReason},now),action,deadlineText:(actionReason==='manual_review'?taskDisplayCopy.remainingReview:taskDisplayCopy.remaining).replace('{时间}',displayDuration(taskHumanActionDeadline(task)-current))};
  }
  const scheduled=validDisplayTime(task.scheduledAt);
  if(task.status==='queued'&&scheduled!==undefined&&scheduled>current){
    const selectionAt=validDisplayTime(task.scheduling?.selectionAt);
    const selected=!!task.channelId&&!!task.sourceDomain&&!['auto','pending','unassigned'].includes(task.channelId)&&(selectionAt===undefined||selectionAt<=current);
    return {state:'scheduled',label:label.scheduled,detail:taskDisplayCopy.scheduled.replace('{时间}',displayDate(scheduled,true))+(selected?'':` · ${taskDisplayCopy.platformPending}`)};
  }
  let detail:string=taskDisplayCopy.stages.writing;
  if(task.status==='review')detail=taskDisplayCopy.stages.waiting;
  else if(task.checkpoint?.includes('mail')||task.checkpoint?.includes('email'))detail=taskDisplayCopy.stages.email;
  else if(task.articleReview?.status==='running'||task.checkpoint==='article_review')detail=taskDisplayCopy.stages.reviewing;
  else if(task.articleReview?.status==='passed'||task.checkpoint?.includes('publish')||task.checkpoint?.includes('submitt'))detail=taskDisplayCopy.stages.publishing;
  return {state:'in_progress',label:label.in_progress,detail};
}
export function taskHumanActionGroup(task:TaskDisplayInput,now:Date|string|number):TaskHumanActionGroup|undefined{
  if(taskDisplayState(task,now).state!=='action_required')return undefined;
  if(['email_confirmation','email_code_ambiguous'].includes(humanKind(task)??''))return 'verification';
  const reason=displayActionReason(task);
  if(reason==='captcha_required'||reason==='agreement_required')return 'verification';
  if(reason==='account_handoff')return 'account';
  if(reason==='manual_review')return 'review';
  // These platforms take only text the owner writes; the software does not prepare it.
  if(isHumanAuthoredOnlyChannel(task.channelId))return 'manual_write';
  return 'manual_publish';
}
export function taskHumanActionUrgent(task:TaskDisplayInput,now:Date|string|number):boolean{
  return taskDisplayState(task,now).state==='action_required'&&taskHumanActionDeadline(task)-displayTime(now)<=10*minuteMs;
}
export function compareHumanActionTasks(left:TaskDisplayInput,right:TaskDisplayInput,now:Date|string|number):number{
  return Number(taskHumanActionUrgent(right,now))-Number(taskHumanActionUrgent(left,now))||taskHumanActionDeadline(left)-taskHumanActionDeadline(right)||left.id.localeCompare(right.id);
}

const transientReviewCodes=new Set(['evidence_fetch_failed','evidence_invalid','ai_unavailable','format_invalid']);
const channelWaitReviewCodes=new Set(['policy_unknown','policy_not_found','input_too_long','content_rejected','invalid_topic']);
const publicationCheckpoints=new Set(['submitting','submitted','submission_uncertain','telegraph_publish_submitting','telegraph_publish_uncertain','telegraph_published','gist_published','blogger_insert_submitting','blogger_draft_created','blogger_publish_submitting','blogger_published','leaflet_create_submitting','leaflet_create_accepted','leaflet_published','bluesky_create_submitting','bluesky_create_accepted','bluesky_published','paragraph_insert_submitting','paragraph_draft_created','paragraph_publish_submitting','paragraph_published','nostr_publish_submitting','nostr_published','paper_publish_submitting','paper_published','hive_publish_submitting','hive_published','mataroa_publish_submitting','mataroa_published','verbose_publish_submitting','verbose_published','rentry_publish_submitting','rentry_published','lucid_publish_submitting','lucid_published','betterthanhtml_publish_submitting','betterthanhtml_published','supanote_publish_submitting','supanote_api_receipt','supanote_published','docs_md_share_submitting','docs_md_api_receipt','docs_md_published','katbin_create_submitting','katbin_opaque_response','katbin_api_receipt','katbin_published','mdshare_create_submitting','mdshare_opaque_response','mdshare_api_receipt','mdshare_published','pstrs_create_submitting','pstrs_opaque_response','pstrs_partial_response','pstrs_api_receipt','pstrs_published','slugpost_create_submitting','slugpost_opaque_response','slugpost_ui_receipt','slugpost_published','brewpage_owner_token_pending','brewpage_owner_token_opaque','brewpage_owner_ready','brewpage_create_submitting','brewpage_opaque_response','brewpage_api_receipt','brewpage_published','memorywiki_create_submitting','memorywiki_opaque_response','memorywiki_api_receipt','memorywiki_published','nextgenSlides_create_submitting','nextgenSlides_opaque_response','nextgenSlides_api_receipt','nextgenSlides_published','yourwebs_create_submitting','yourwebs_opaque_response','yourwebs_api_receipt','yourwebs_published','yourwebs_expired','totpage_create_submitting','totpage_opaque_response','totpage_api_receipt','totpage_published','mdview_create_submitting','mdview_opaque_response','mdview_api_receipt','mdview_published','txtsbs_create_submitting','txtsbs_opaque_response','txtsbs_api_receipt','txtsbs_published','pastyx_create_submitting','pastyx_opaque_response','pastyx_api_receipt','pastyx_published','agentdrop_create_submitting','agentdrop_opaque_response','agentdrop_api_receipt','agentdrop_published','listed_startups_submitting','listed_startups_opaque_response','listed_startups_api_receipt','listed_startups_published','product_index_submitting','product_index_opaque_response','product_index_issue_open','product_index_rejected','product_index_published','shippage_create_submitting','shippage_opaque_response','shippage_readback_only','shippage_api_receipt','shippage_published','pastemyst_create_submitting','pastemyst_opaque_response','pastemyst_api_receipt','pastemyst_published','markdownpaste_create_submitting','markdownpaste_opaque_response','markdownpaste_api_receipt','markdownpaste_published','html_app_create_submitting','html_app_api_receipt','html_app_published','deed_page_create_submitting','deed_page_opaque_response','deed_page_api_receipt','deed_page_published','shiply_submitting','shiply_create_unknown','shiply_opaque_response','shiply_staged','shiply_upload_unknown','shiply_uploaded','shiply_finalize_unknown','shiply_api_receipt','shiply_published']);
const telegraphUncertainCheckpoints=new Set(['telegraph_publish_submitting','telegraph_publish_uncertain']);
const bloggerUncertainCheckpoints=new Set(['blogger_insert_submitting','blogger_publish_submitting','blogger_draft_created']);
const telegraphReconcileLimit=3;
const normalize=(value:string)=>value.trim().toLowerCase();
const consumedMigrationRecoveryMessage='一次性网站迁移恢复已结束；累计记录保留，不会再次自动恢复或重置重试次数。';

export function taskMessageForDisplay(task:Task){
  if(task.checkpoint!=='site_origin_migration_recovery_consumed')return task.message;
  const reason=task.message.replace(/独立审核发现可修订内容，AI 将自动修稿一次并重新审核。/,'AI 复核发现可修改内容；自动改稿已停止。').replaceAll(consumedMigrationRecoveryMessage,'').trim();
  return [reason,consumedMigrationRecoveryMessage].filter(Boolean).join(' ');
}

export function taskHasArticleReview(task:Task){return (!task.submittedAt||hasRecoverablePublisherDraftReceipt(task))&&task.status!=='live'&&(task.checkpoint==='article_review'||!!task.articleReview)}

export function taskHasSubmissionEvidence(task:Task){return !!(task.submittedAt||task.publicUrl||task.firstLiveAt||task.leaflet||task.wordpress||task.paper||task.hive||task.mataroa||task.verbose||task.rentry||task.lucid||task.betterthanhtml||task.supanote||task.docsMd||task.katbin||task.mdshare||task.pstrs||task.slugPost||task.brewPage||task.memoryWiki||task.nextgenSlides||task.yourwebs||task.totpage||task.mdview||task.txtsbs||task.pastyx||task.agentdrop||task.listedStartups||task.productIndex||task.shipPage||task.pastemyst||task.markdownPaste||task.htmlApp||task.deedPage||task.shiply)||publicationCheckpoints.has(task.checkpoint??'')}
export function taskHasUnconfirmedSubmission(task:Task){const unresolvedUrl=!task.publicUrl||task.channelId==='leaflet'&&task.leaflet?.stage==='creating'&&task.publicUrl===task.leaflet.url||task.channelId==='betterthanhtml'&&task.betterthanhtml?.stage==='submitting'&&!!task.betterthanhtml.id&&task.publicUrl===`https://betterthanhtml.com/workshop/${task.betterthanhtml.id}`||task.channelId==='supanote'&&task.supanote?.stage==='api_receipt'&&!!task.supanote.publicId&&task.publicUrl===`https://supanote.app/n/${task.supanote.publicId}`||task.channelId==='katbin'&&task.katbin?.stage==='api_receipt'&&!!task.katbin.id&&task.publicUrl===`https://katb.in/${task.katbin.id}.md`||task.channelId==='mdshare'&&task.mdshare?.stage==='api_receipt'&&!!task.mdshare.slug&&task.publicUrl===`https://mdshare.org/s/${task.mdshare.slug}`||task.channelId==='pstrs'&&task.pstrs?.stage==='api_receipt'&&!!task.pstrs.id&&task.publicUrl==='https://paster.abhicracker.com/'+task.pstrs.id+'.md'||task.channelId==='slugpost'&&task.slugPost?.stage==='ui_receipt'&&task.publicUrl===`https://slugpost.com/${task.slugPost.slug}`||task.channelId==='brewpage'&&task.brewPage?.stage==='api_receipt'&&!!task.brewPage.publicUrl&&task.publicUrl===task.brewPage.publicUrl||task.channelId==='memorywiki'&&task.memoryWiki?.stage==='api_receipt'&&!!task.memoryWiki.id&&task.publicUrl===`https://memory.wiki/${task.memoryWiki.id}`||task.channelId==='nextgen-slides'&&task.nextgenSlides?.stage==='api_receipt'&&!!task.nextgenSlides.id&&task.publicUrl===`https://nextgenslides.dev/s/${task.nextgenSlides.id}`||task.channelId==='yourwebs'&&task.yourwebs?.stage==='api_receipt'&&!!task.yourwebs.subdomain&&task.publicUrl===`https://${task.yourwebs.subdomain}.yourwebs.app/`||task.channelId==='totpage'&&task.totpage?.stage==='api_receipt'&&!!task.totpage.id&&task.publicUrl===`https://tot.page/${task.totpage.id}`||task.channelId==='mdview'&&task.mdview?.stage==='api_receipt'&&!!task.mdview.shortId&&task.publicUrl===`https://mdview.io/s/${task.mdview.shortId}`||task.channelId==='txtsbs'&&task.txtsbs?.stage==='api_receipt'&&!!task.txtsbs.id&&task.publicUrl===`https://txt.sbs/${task.txtsbs.id}`||task.channelId==='pastyx'&&task.pastyx?.stage==='api_receipt'&&!!task.pastyx.id&&task.publicUrl===`https://pastyx.pages.dev/${task.pastyx.id}`||task.channelId==='listed-startups'&&task.listedStartups?.stage==='api_receipt'&&task.publicUrl===`https://listedstartups.com/products/${task.listedStartups.slug}`||task.channelId==='product-index'&&task.productIndex?.stage==='published'&&task.publicUrl===`https://index.percall.dev/l/${task.productIndex.slug}.html`||task.channelId==='agentdrop'&&task.agentdrop?.stage==='api_receipt'&&!!task.agentdrop.id&&task.publicUrl===`https://www.agent-drop.co/${task.agentdrop.id}`||task.channelId==='shippage'&&task.shipPage?.stage==='api_receipt'&&!!task.shipPage.publicUrl&&task.publicUrl===task.shipPage.publicUrl||task.channelId==='pastemyst'&&task.pastemyst?.stage==='api_receipt'&&!!task.pastemyst.id&&task.publicUrl===`https://paste.myst.rs/${task.pastemyst.id}`||task.channelId==='markdownpaste'&&task.markdownPaste?.stage==='api_receipt'&&!!task.markdownPaste.id&&task.publicUrl===`https://markdownpasteit.vercel.app/p/${task.markdownPaste.id}`||task.channelId==='docs-md'&&task.docsMd?.stage==='api_receipt'&&!!task.docsMd.id&&task.publicUrl===`https://docs-md.com/${task.docsMd.id}`||task.channelId==='html-app'&&task.htmlApp?.stage==='api_receipt'&&!!task.htmlApp.siteId&&task.publicUrl===`https://${task.htmlApp.siteId}.ht-ml.app/`||task.channelId==='deed-page'&&task.deedPage?.stage==='api_receipt'&&task.publicUrl===`https://${task.deedPage.slug}.deed.page/`||task.channelId==='shiply'&&task.shiply?.stage==='api_receipt'&&!!task.shiply.slug&&task.publicUrl===`https://${task.shiply.slug}.shiply.now/`;return unresolvedUrl&&!task.firstLiveAt&&(!!task.submittedAt||!!task.leaflet||!!task.wordpress||!!task.paper||!!task.hive||!!task.mataroa||!!task.verbose||!!task.rentry||!!task.lucid||!!task.betterthanhtml||!!task.supanote||!!task.docsMd||!!task.katbin||!!task.mdshare||!!task.pstrs||!!task.slugPost||!!task.brewPage||!!task.memoryWiki||!!task.nextgenSlides||!!task.yourwebs||!!task.totpage||!!task.mdview||!!task.txtsbs||!!task.pastyx||!!task.agentdrop||!!task.listedStartups||!!task.productIndex||!!task.shipPage||!!task.pastemyst||!!task.markdownPaste||!!task.htmlApp||!!task.deedPage||!!task.shiply||publicationCheckpoints.has(task.checkpoint??''))}

export function taskCanAutoRecover(task:Task,channelEnabled=true){
  const recoverableReason=task.recoveryEligible===true||transientReviewCodes.has(task.articleReview?.reasonCode??'');
  return channelEnabled&&task.status==='failed'&&task.checkpoint==='system_wait'&&recoverableReason&&!!task.nextCheckAt&&(task.recoveryAttempts??0)<1&&(task.cost?.aiCalls??0)<TASK_AI_BUDGET&&(!taskHasSubmissionEvidence(task)||hasRecoverablePublisherDraftReceipt(task))&&!task.deferredAt;
}

export function taskNeedsTelegraphReconciliation(task:Task,channelEnabled=true){
if(['slugpost','brewpage','memorywiki','shiply','pastyx'].includes(task.channelId)&&['skipped','expired'].includes(task.status))return false;
  const pending=task.channelId==='telegraph'&&telegraphUncertainCheckpoints.has(task.checkpoint??'')
    ||task.channelId==='wordpress-com'&&!!task.wordpress&&task.checkpoint==='wordpress_publish_submitting'
    ||task.channelId==='leaflet'&&!!task.leaflet&&['leaflet_create_submitting','leaflet_create_accepted'].includes(task.checkpoint??'')
    ||task.channelId==='blogger'&&(bloggerUncertainCheckpoints.has(task.checkpoint??'')||task.blogger?.stage==='draft'&&task.status==='needs_input'&&task.articleReview?.status==='passed')
    ||task.channelId==='paragraph'&&!!task.paragraph&&['paragraph_insert_submitting','paragraph_draft_created','paragraph_publish_submitting'].includes(task.checkpoint??'')
    ||task.channelId==='nostr'&&!!task.nostr&&task.checkpoint==='nostr_publish_submitting'
    ||task.channelId==='paper-wf'&&!!task.paper&&task.checkpoint==='paper_publish_submitting'
    ||task.channelId==='mataroa'&&!!task.mataroa&&task.checkpoint==='mataroa_publish_submitting'
    ||task.channelId==='verbose'&&!!task.verbose&&task.checkpoint==='verbose_publish_submitting'
    ||task.channelId==='rentry'&&!!task.rentry&&task.checkpoint==='rentry_publish_submitting'
    ||task.channelId==='lucid-page'&&!!task.lucid?.slug&&task.checkpoint==='lucid_publish_submitting'
    ||task.channelId==='betterthanhtml'&&!!task.betterthanhtml?.id&&task.checkpoint==='betterthanhtml_publish_submitting'
    ||task.channelId==='supanote'&&!!task.supanote?.publicId&&task.supanote.stage==='api_receipt'&&task.checkpoint==='supanote_api_receipt'
    ||task.channelId==='katbin'&&!!task.katbin?.id&&task.katbin.stage==='api_receipt'&&task.checkpoint==='katbin_api_receipt'
    ||task.channelId==='mdshare'&&!!task.mdshare?.slug&&task.mdshare.stage==='api_receipt'&&task.checkpoint==='mdshare_api_receipt'
    ||task.channelId==='pstrs'&&!!task.pstrs&&['submitting','opaque_response','partial_response','api_receipt'].includes(task.pstrs.stage)&&['pstrs_create_submitting','pstrs_opaque_response','pstrs_partial_response','pstrs_api_receipt'].includes(task.checkpoint??'')
    ||task.channelId==='slugpost'&&!!task.slugPost&&['submitting','opaque_response','ui_receipt'].includes(task.slugPost.stage)
    ||task.channelId==='brewpage'&&!!task.brewPage&&['owner_token_pending','owner_token_opaque','submitting','opaque_response','api_receipt'].includes(task.brewPage.stage)&&['brewpage_owner_token_pending','brewpage_owner_token_opaque','brewpage_create_submitting','brewpage_opaque_response','brewpage_api_receipt'].includes(task.checkpoint??'')
    ||task.channelId==='memorywiki'&&!!task.memoryWiki&&['submitting','opaque_response','api_receipt'].includes(task.memoryWiki.stage)&&['memorywiki_create_submitting','memorywiki_opaque_response','memorywiki_api_receipt'].includes(task.checkpoint??'')
    ||task.channelId==='nextgen-slides'&&!!task.nextgenSlides&&['opaque_response','api_receipt'].includes(task.nextgenSlides.stage)&&['nextgenSlides_opaque_response','nextgenSlides_api_receipt'].includes(task.checkpoint??'')
    ||task.channelId==='yourwebs'&&!!task.yourwebs&&['opaque_response','api_receipt'].includes(task.yourwebs.stage)&&['yourwebs_opaque_response','yourwebs_api_receipt'].includes(task.checkpoint??'')
    ||task.channelId==='totpage'&&!!task.totpage&&['opaque_response','api_receipt'].includes(task.totpage.stage)&&['totpage_opaque_response','totpage_api_receipt'].includes(task.checkpoint??'')
    ||task.channelId==='mdview'&&!!task.mdview&&['opaque_response','api_receipt'].includes(task.mdview.stage)&&['mdview_opaque_response','mdview_api_receipt'].includes(task.checkpoint??'')
    ||task.channelId==='txtsbs'&&!!task.txtsbs&&['opaque_response','api_receipt'].includes(task.txtsbs.stage)&&['txtsbs_opaque_response','txtsbs_api_receipt'].includes(task.checkpoint??'')
    ||task.channelId==='pastyx'&&!!task.pastyx&&['opaque_response','api_receipt'].includes(task.pastyx.stage)&&['pastyx_opaque_response','pastyx_api_receipt'].includes(task.checkpoint??'')
    ||task.channelId==='agentdrop'&&!!task.agentdrop&&['opaque_response','api_receipt'].includes(task.agentdrop.stage)&&['agentdrop_opaque_response','agentdrop_api_receipt'].includes(task.checkpoint??'')
    ||task.channelId==='listed-startups'&&!!task.listedStartups&&['submitting','opaque_response','api_receipt'].includes(task.listedStartups.stage)&&['listed_startups_submitting','listed_startups_opaque_response','listed_startups_api_receipt'].includes(task.checkpoint??'')
    ||task.channelId==='product-index'&&!!task.productIndex&&['submitting','opaque_response','issue_open'].includes(task.productIndex.stage)&&['product_index_submitting','product_index_opaque_response','product_index_issue_open'].includes(task.checkpoint??'')
    ||task.channelId==='shippage'&&!!task.shipPage&&['submitting','opaque_response','api_receipt'].includes(task.shipPage.stage)&&['shippage_create_submitting','shippage_opaque_response','shippage_api_receipt'].includes(task.checkpoint??'')
    ||task.channelId==='pastemyst'&&!!task.pastemyst&&['submitting','opaque_response','api_receipt'].includes(task.pastemyst.stage)&&['pastemyst_create_submitting','pastemyst_opaque_response','pastemyst_api_receipt'].includes(task.checkpoint??'')
    ||task.channelId==='markdownpaste'&&!!task.markdownPaste&&['submitting','opaque_response','api_receipt'].includes(task.markdownPaste.stage)&&['markdownpaste_create_submitting','markdownpaste_opaque_response','markdownpaste_api_receipt'].includes(task.checkpoint??'')
    ||task.channelId==='docs-md'&&!!task.docsMd?.id&&task.docsMd.stage==='api_receipt'&&task.checkpoint==='docs_md_api_receipt'
    ||task.channelId==='html-app'&&!!task.htmlApp?.siteId&&task.htmlApp.stage==='api_receipt'&&task.checkpoint==='html_app_api_receipt'
    ||task.channelId==='deed-page'&&!!task.deedPage&&['submitting','opaque_response','api_receipt'].includes(task.deedPage.stage)&&['deed_page_create_submitting','deed_page_opaque_response','deed_page_api_receipt'].includes(task.checkpoint??'')
    ||task.channelId==='shiply'&&!!task.shiply&&['opaque_response','staged','upload_unknown','uploaded','finalize_unknown','api_receipt'].includes(task.shiply.stage)&&['shiply_opaque_response','shiply_staged','shiply_upload_unknown','shiply_uploaded','shiply_finalize_unknown','shiply_api_receipt'].includes(task.checkpoint??'')
    ||task.channelId==='hive'&&!!task.hive&&task.checkpoint==='hive_publish_submitting'
    ||task.channelId==='bluesky'&&!!task.bluesky&&['bluesky_create_submitting','bluesky_create_accepted'].includes(task.checkpoint??'');
const unresolvedUrl=!task.publicUrl||task.channelId==='wordpress-com'&&task.wordpress?.stage==='submitting'&&task.publicUrl===task.wordpress.url||task.channelId==='leaflet'&&task.leaflet?.stage==='creating'&&task.publicUrl===task.leaflet.url||task.channelId==='betterthanhtml'&&task.betterthanhtml?.stage==='submitting'&&!!task.betterthanhtml.id&&task.publicUrl===`https://betterthanhtml.com/workshop/${task.betterthanhtml.id}`||task.channelId==='supanote'&&task.supanote?.stage==='api_receipt'&&!!task.supanote.publicId&&task.publicUrl===`https://supanote.app/n/${task.supanote.publicId}`||task.channelId==='katbin'&&task.katbin?.stage==='api_receipt'&&!!task.katbin.id&&task.publicUrl===`https://katb.in/${task.katbin.id}.md`||task.channelId==='mdshare'&&task.mdshare?.stage==='api_receipt'&&!!task.mdshare.slug&&task.publicUrl===`https://mdshare.org/s/${task.mdshare.slug}`||task.channelId==='pstrs'&&task.pstrs?.stage==='api_receipt'&&!!task.pstrs.id&&task.publicUrl==='https://paster.abhicracker.com/'+task.pstrs.id+'.md'||task.channelId==='slugpost'&&task.slugPost?.stage==='ui_receipt'&&task.publicUrl===`https://slugpost.com/${task.slugPost.slug}`||task.channelId==='brewpage'&&task.brewPage?.stage==='api_receipt'&&!!task.brewPage.publicUrl&&task.publicUrl===task.brewPage.publicUrl||task.channelId==='memorywiki'&&task.memoryWiki?.stage==='api_receipt'&&!!task.memoryWiki.id&&task.publicUrl===`https://memory.wiki/${task.memoryWiki.id}`||task.channelId==='nextgen-slides'&&task.nextgenSlides?.stage==='api_receipt'&&!!task.nextgenSlides.id&&task.publicUrl===`https://nextgenslides.dev/s/${task.nextgenSlides.id}`||task.channelId==='yourwebs'&&task.yourwebs?.stage==='api_receipt'&&!!task.yourwebs.subdomain&&task.publicUrl===`https://${task.yourwebs.subdomain}.yourwebs.app/`||task.channelId==='totpage'&&task.totpage?.stage==='api_receipt'&&!!task.totpage.id&&task.publicUrl===`https://tot.page/${task.totpage.id}`||task.channelId==='mdview'&&task.mdview?.stage==='api_receipt'&&!!task.mdview.shortId&&task.publicUrl===`https://mdview.io/s/${task.mdview.shortId}`||task.channelId==='txtsbs'&&task.txtsbs?.stage==='api_receipt'&&!!task.txtsbs.id&&task.publicUrl===`https://txt.sbs/${task.txtsbs.id}`||task.channelId==='pastyx'&&task.pastyx?.stage==='api_receipt'&&!!task.pastyx.id&&task.publicUrl===`https://pastyx.pages.dev/${task.pastyx.id}`||task.channelId==='listed-startups'&&task.listedStartups?.stage==='api_receipt'&&task.publicUrl===`https://listedstartups.com/products/${task.listedStartups.slug}`||task.channelId==='product-index'&&task.productIndex?.stage==='published'&&task.publicUrl===`https://index.percall.dev/l/${task.productIndex.slug}.html`||task.channelId==='agentdrop'&&task.agentdrop?.stage==='api_receipt'&&!!task.agentdrop.id&&task.publicUrl===`https://www.agent-drop.co/${task.agentdrop.id}`||task.channelId==='shippage'&&task.shipPage?.stage==='api_receipt'&&!!task.shipPage.publicUrl&&task.publicUrl===task.shipPage.publicUrl||task.channelId==='pastemyst'&&task.pastemyst?.stage==='api_receipt'&&!!task.pastemyst.id&&task.publicUrl===`https://paste.myst.rs/${task.pastemyst.id}`||task.channelId==='markdownpaste'&&task.markdownPaste?.stage==='api_receipt'&&!!task.markdownPaste.id&&task.publicUrl===`https://markdownpasteit.vercel.app/p/${task.markdownPaste.id}`||task.channelId==='docs-md'&&task.docsMd?.stage==='api_receipt'&&!!task.docsMd.id&&task.publicUrl===`https://docs-md.com/${task.docsMd.id}`||task.channelId==='html-app'&&task.htmlApp?.stage==='api_receipt'&&!!task.htmlApp.siteId&&task.publicUrl===`https://${task.htmlApp.siteId}.ht-ml.app/`||task.channelId==='deed-page'&&task.deedPage?.stage==='api_receipt'&&task.publicUrl===`https://${task.deedPage.slug}.deed.page/`||task.channelId==='shiply'&&task.shiply?.stage==='api_receipt'&&!!task.shiply.slug&&task.publicUrl===`https://${task.shiply.slug}.shiply.now/`;
  return channelEnabled&&unresolvedUrl&&!!task.submittedAt&&pending&&(task.reconcileAttempts??0)<telegraphReconcileLimit;
}

export function taskAutomaticFollowupAt(task:Task,channelEnabled=true):string|undefined{
  if(taskNeedsTelegraphReconciliation(task,channelEnabled))return task.reconcileAfter;
  if(taskCanAutoRecover(task,channelEnabled))return task.nextCheckAt;
  if(task.status==='queued'&&channelEnabled)return task.scheduledAt;
  if(task.publicUrl&&task.nextCheckAt&&['review','expired','live','needs_input'].includes(task.status))return task.nextCheckAt;
  return undefined;
}

export function canResumeDeferredTask(task:Task){return !!task.deferredAt&&!taskHasSubmissionEvidence(task)}

// No identity was returned for this already-submitted document, so there is
// neither a safe result query nor a safe second submission to schedule.
export function taskHasStoppedUnknownDocsMdSubmission(task:Task,channelEnabled=true){
  return ['review','needs_input','failed'].includes(task.status)&&(
    task.channelId==='docs-md'&&task.checkpoint==='docs_md_share_submitting'&&task.docsMd?.stage==='submitting'&&!task.docsMd.id
    ||task.channelId==='nextgen-slides'&&task.checkpoint==='nextgenSlides_create_submitting'&&task.nextgenSlides?.stage==='submitting'&&!task.nextgenSlides.id
    ||task.channelId==='yourwebs'&&task.checkpoint==='yourwebs_create_submitting'&&task.yourwebs?.stage==='submitting'&&!task.yourwebs.id
    ||task.channelId==='totpage'&&task.checkpoint==='totpage_create_submitting'&&task.totpage?.stage==='submitting'&&!task.totpage.id
    ||task.channelId==='mdview'&&task.checkpoint==='mdview_create_submitting'&&task.mdview?.stage==='submitting'&&!task.mdview.shortId
    ||task.channelId==='txtsbs'&&task.checkpoint==='txtsbs_create_submitting'&&task.txtsbs?.stage==='submitting'&&!task.txtsbs.id
    ||task.channelId==='pastyx'&&task.checkpoint==='pastyx_create_submitting'&&task.pastyx?.stage==='submitting'&&!task.pastyx.id
    ||task.channelId==='agentdrop'&&task.checkpoint==='agentdrop_create_submitting'&&task.agentdrop?.stage==='submitting'&&!task.agentdrop.id
    ||task.channelId==='listed-startups'&&task.checkpoint==='listed_startups_submitting'&&task.listedStartups?.stage==='submitting'&&!task.listedStartups.requestId
    ||task.channelId==='product-index'&&['product_index_submitting','product_index_opaque_response','product_index_issue_open'].includes(task.checkpoint??'')&&!!task.productIndex&&['submitting','opaque_response','issue_open'].includes(task.productIndex.stage)
    ||task.channelId==='shippage'&&task.checkpoint==='shippage_create_submitting'&&task.shipPage?.stage==='submitting'&&!task.shipPage.publicUrl
    ||task.channelId==='shiply'&&['shiply_submitting','shiply_create_unknown'].includes(task.checkpoint??'')&&!!task.shiply&&['submitting','create_unknown'].includes(task.shiply.stage)&&!task.shiply.slug
    ||task.channelId==='html-app'&&task.checkpoint==='html_app_create_submitting'&&task.htmlApp?.stage==='submitting'&&!task.htmlApp.siteId
  )&&!task.publicUrl&&!task.firstLiveAt&&!taskHasAutomaticFollowup(task,channelEnabled);
}

export function taskHasSkippedUnknownPublication(task:Task){
  return task.status==='skipped'&&!!task.submittedAt&&Number.isFinite(Date.parse(task.submittedAt))
    &&taskHasUnconfirmedSubmission(task)&&!task.firstLiveAt;
}

export function taskWorkKind(task:Task,reviewMode:ArticleReviewMode='manual',channelEnabled=true):TaskWorkKind{
  const failedReview=task.articleReview?.status==='failed',reasonCode=task.articleReview?.reasonCode;
  if(task.status==='live')return 'result';
  if(taskHasSkippedUnknownPublication(task))return 'deferred';
  if(task.deferredAt&&!taskHasSubmissionEvidence(task))return 'deferred';
  if(taskNeedsTelegraphReconciliation(task,channelEnabled)||taskCanAutoRecover(task,channelEnabled))return 'system_retry';
  if(taskHasStoppedUnknownDocsMdSubmission(task,channelEnabled))return 'channel_wait';
  if(taskHasUnconfirmedSubmission(task)&&['needs_input','failed','skipped'].includes(task.status))return 'user_action';
  if(task.status==='skipped')return 'closed';
  // The current task state is authoritative. A previous review failure must not
  // hide a later account, verification, or uncertain-submission handoff.
  if(task.status==='needs_input')return 'user_action';
  if(task.status==='failed'&&(!!task.submittedAt||!!task.leaflet||!!task.wordpress||!!task.paper||!!task.hive||!!task.mataroa||!!task.verbose||!!task.rentry||!!task.lucid||!!task.betterthanhtml||!!task.supanote||!!task.docsMd||publicationCheckpoints.has(task.checkpoint??'')))return 'user_action';
  if(['channel_wait','invalid_topic','article_rejected','topic_recovery_budget'].includes(task.checkpoint??'')||task.status==='expired'||failedReview&&!!reasonCode&&channelWaitReviewCodes.has(reasonCode))return 'channel_wait';
  if(task.checkpoint==='system_wait'||failedReview&&!!reasonCode&&transientReviewCodes.has(reasonCode))return 'system_retry';
  if(task.status==='failed')return 'user_action';
  return 'progress';
}

export function taskPresentation(task:Task,reviewMode:ArticleReviewMode='manual',channelEnabled=true):TaskPresentation{
  const kind=taskWorkKind(task,reviewMode,channelEnabled),review=task.articleReview,reasonCode=review?.reasonCode;
  if(kind==='deferred')return {kind,label:taskHasSkippedUnknownPublication(task)?'没做成 · 结果待确认':'没做成',tone:'muted'};
  if(kind==='channel_wait'){
    if(taskHasStoppedUnknownDocsMdSubmission(task,channelEnabled))return {kind,label:'提交结果未知',tone:'amber'};
    if(task.checkpoint==='topic_recovery_budget')return {kind,label:'AI 次数用完了',tone:'muted'};
    if(task.checkpoint==='invalid_topic'||reasonCode==='invalid_topic')return {kind,label:'需要新的文章选题',tone:'muted'};
    if(task.checkpoint==='article_rejected')return {kind,label:'稿件核对未通过',tone:'amber'};
    if(reasonCode==='content_rejected')return {kind,label:'稿件核对未通过',tone:'amber'};
    if(reasonCode==='policy_unknown'||reasonCode==='policy_not_found')return {kind,label:'等待平台条款资料',tone:'muted'};
    if(task.status==='expired')return {kind,label:task.channelId==='shippage'?'临时页面已到期':task.channelId==='nextgen-slides'?'匿名网页已到期':task.channelId==='yourwebs'?'匿名网页已到期':task.channelId==='totpage'?'匿名网页已到期':task.channelId==='mdview'?'30 天页面已到期':task.channelId==='agentdrop'?'匿名网页已到期':'等平台结果',tone:'muted'};
    return {kind,label:'等待新资料或平台',tone:'muted'};
  }
  if(kind==='system_retry'){
    if(taskNeedsTelegraphReconciliation(task,channelEnabled))return {kind,label:'自动查询发布结果',tone:'blue'};
    if(task.status==='queued')return {kind,label:'外链助手会重试',tone:'blue'};
    if(taskCanAutoRecover(task,channelEnabled))return {kind,label:'等待最后一次自动恢复',tone:'blue'};
    return {kind,label:'自动处理已停止',tone:'muted'};
  }
  if(kind==='user_action'){
    const label=task.checkpoint==='account_handoff'?'需要连接账号'
      :task.checkpoint==='ai_setup_required'?'需要连接 AI'
      :task.checkpoint==='system_vault_unavailable'?'需要电脑授权'
      :task.checkpoint==='manual_submission'?'需要人工提交'
      :task.checkpoint==='account_registration_submitted'?'需要完成账号验证'
      :task.checkpoint==='article_review'&&reviewMode==='manual'?'稿件待人工审核'
      :task.submittedAt||publicationCheckpoints.has(task.checkpoint??'')?'需要确认发布结果'
      :'任务需要处理';
    return {kind,label,tone:task.status==='failed'?'red':'amber'};
  }
  if(kind==='result')return {kind,label:task.health==='unknown'?'待重新确认':'当前有效',tone:'green'};
  if(kind==='closed')return {kind,label:'已跳过',tone:'muted'};
  if(review?.status==='running')return {kind,label:'AI 复核中',tone:'blue'};
  if(review?.status==='passed'&&task.status==='running')return {kind,label:'审核通过，发布中',tone:'blue'};
  if(task.status==='review')return {kind,label:'等待平台结果',tone:'blue'};
  if(task.status==='running')return {kind,label:'执行中',tone:'blue'};
  if(review?.status==='passed'&&task.status==='queued'&&channelEnabled)return {kind,label:'已审核，等待发布前检查',tone:'blue'};
  if(task.status==='queued'&&task.checkpoint==='article_review')return {kind,label:'等待 AI 复核',tone:'blue'};
  if(task.status==='queued')return {kind,label:'等待执行',tone:'muted'};
  return {kind,label:'继续推进',tone:'blue'};
}

// This describes the saved draft's publication history. It does not decide whether
// an old article review still authorizes another submission.
export function draftStatusLabel(task:Task,reviewMode:ArticleReviewMode='manual',channelEnabled=true){
  if(task.status==='live'&&(task.publicUrl||task.firstLiveAt))return `已发布 · ${taskPresentation(task,reviewMode,channelEnabled).label}`;
  if(taskHasSkippedUnknownPublication(task))return '没做成 · 结果待确认';
  if(task.firstLiveAt)return '曾发布 · 当前待复核';
  if(task.publicUrl)return '已有公开地址 · 等待检查链接';
  if(taskHasStoppedUnknownDocsMdSubmission(task,channelEnabled))return '已提交 · 结果未知';
  if(task.channelId==='nostr'&&task.submittedAt&&task.nostr&&['nostr_publish_submitting','nostr_published'].includes(task.checkpoint??''))return '已提交 · 等待检查链接';
  const presentation=taskPresentation(task,reviewMode,channelEnabled);
  if(task.articleApprovedAt)return '已确认';
  if(presentation.kind==='channel_wait')return '等待新资料或平台';
  if(presentation.kind==='system_retry')return presentation.label;
  if(task.articleReview?.status==='passed'&&task.status==='queued'&&channelEnabled)return '已审核 · 等待发布前检查';
  return reviewMode==='ai'?'等待 AI 复核':'待人工确认';
}

export function taskCanManuallyRecoverNostr(task:Task,channelEnabled=true,siteReady=true){
  return channelEnabled&&siteReady&&task.channelId==='nostr'&&task.nostr?.stage==='submitting'
    &&!!task.submittedAt&&Number.isFinite(Date.parse(task.submittedAt))&&task.checkpoint==='nostr_publish_submitting'
    &&['needs_input','review','failed'].includes(task.status)&&!task.firstLiveAt&&!task.reconcileAfter
    &&(task.reconcileAttempts??0)>=3;
}

export function articleReviewTitle(task:Task,reviewMode:ArticleReviewMode='manual',channelEnabled=true){
  const review=task.articleReview,presentation=taskPresentation(task,reviewMode,channelEnabled);
  if(presentation.kind==='channel_wait'||presentation.kind==='system_retry')return presentation.label;
  if(review?.status==='running')return 'AI 复核中';
  if(review?.status==='passed'&&task.status==='queued'&&channelEnabled)return '已有 AI 复核记录，等待发布前检查';
  if(review?.status==='passed')return review.reasonCode==='user_policy_decision'?'AI 复核通过 · 已确认使用平台':'AI 复核通过，正在继续发布';
  if(review?.status==='failed')return 'AI 复核未通过';
  return reviewMode==='ai'?'等待 AI 复核':'稿件等待人工审核';
}

export function articleReviewDetail(task:Task,reviewMode:ArticleReviewMode='manual',channelEnabled=true){
  const review=task.articleReview,kind=taskWorkKind(task,reviewMode,channelEnabled);
  if(review?.reasonCode==='policy_unknown')return '现有内容政策证据的适用范围尚未确认，任务未发布；当前平台已暂停使用，出现新证据后可重新评估。';
  if(review?.reasonCode==='policy_not_found')return '现有公开资料中尚未找到适用的内容政策，任务未发布；当前平台已暂停使用，出现新证据后可重新评估。';
  if(canUseOneReviewRetry(task,reviewMode,channelEnabled))return `${review?.reason||'审核未通过。'} AI 次数已用完，原 ${task.cost?.aiCalls??0} 次记录已保留；可在明确确认后追加唯一一次 AI 复核，最多新增 1 次可能付费调用。`;
  if(reviewMode==='ai'&&review?.status==='failed'&&(task.cost?.aiCalls??0)>=TASK_AI_BUDGET)return `${review.reason||'审核未通过。'} 当前任务 AI 次数已用完，无法重新 AI 复核；稿件和审核记录已保留。`;
  if(kind==='system_retry')return task.message||review?.reason||(taskNeedsTelegraphReconciliation(task,channelEnabled)?'已提交的结果正在自动查询，查询期间不会重复发布。':task.status==='queued'||taskCanAutoRecover(task,channelEnabled)?'公开证据或 AI 服务暂时不可用，外链助手会按已保存的计划再次检查。':'自动重试已停止，当前未安排再次检查；其他可执行平台仍会继续。');
  if(kind==='channel_wait')return review?.reason||task.message||'当前平台等待新资料或发布结果，其他可执行任务会继续。';
  if(review?.status==='running')return 'AI 正在复核稿件与发布要求。';
  if(review?.status==='passed'&&task.status==='queued'&&channelEnabled)return '已有一次审核通过记录。计划执行时会重新检查稿件与平台等条件是否仍一致；必要时重新审核，满足发布条件后才会提交。';
  if(review?.status==='passed')return review.reasonCode==='user_policy_decision'?review.reason:'AI 复核通过后才会发布，发布后还会检查链接。';
  if(review?.status==='failed')return review.reason||'证据不足或审核未通过。';
  return reviewMode==='ai'?'保存的稿件将经过 AI 复核；通过后才继续发布。':'请核对稿件并确认，确认前不会发布。';
}

export const isUserActionTask=(task:Task,reviewMode:ArticleReviewMode='manual',channelEnabled=true)=>taskWorkKind(task,reviewMode,channelEnabled)==='user_action';
export const canRetryTaskManually=(task:Task,reviewMode:ArticleReviewMode='manual',channelEnabled=true)=>isUserActionTask(task,reviewMode,channelEnabled)&&!taskHasArticleReview(task)&&!taskHasSubmissionEvidence(task)&&['needs_input','failed'].includes(task.status);
export const canRestartArticleReview=(task:Task,reviewMode:ArticleReviewMode='manual',channelEnabled=true)=>!canUseOneReviewRetry(task,reviewMode,channelEnabled)&&reviewMode==='ai'&&(task.cost?.aiCalls??0)<TASK_AI_BUDGET&&isUserActionTask(task,reviewMode,channelEnabled)&&taskHasArticleReview(task)&&task.articleReview?.status!=='running';
export const canUseOneReviewRetry=(task:Task,reviewMode:ArticleReviewMode='manual',channelEnabled=true)=>channelEnabled&&reviewMode==='ai'&&['failed','needs_input'].includes(task.status)&&['article_review','system_wait','channel_wait'].includes(task.checkpoint??'')&&!!task.draft&&task.articleReview?.status==='failed'&&(task.cost?.aiCalls??0)===TASK_AI_BUDGET-1&&!task.oneReviewRetry&&!taskHasSubmissionEvidence(task);
export function oneReviewRetryLabel(task:Task){const retry=task.oneReviewRetry;return !retry?undefined:retry.status==='granted'?'已授权，正在开始':retry.status==='consumed'?'已使用':'未使用，无法再用'}
export function taskResultStatusLabel(task:Task,channelEnabled=true){
  if(task.publicUrl)return '外链助手发布';
  if(task.checkpoint==='account_registration_submitted')return '等待发布';
  if(task.channelId==='nostr'&&task.submittedAt&&task.nostr&&['nostr_publish_submitting','nostr_published'].includes(task.checkpoint??''))return '已提交 · 等待检查链接';
  if(taskHasStoppedUnknownDocsMdSubmission(task,channelEnabled)||taskHasUnconfirmedSubmission(task))return '已提交 · 结果未知';
  if(task.submittedAt&&taskHasSubmissionEvidence(task))return '已提交 · 等待检查链接';
  return '等待发布';
}

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

function generatedIdentityConflict(data:Snapshot,account:Account,siteId:string){
  if(account.channelId==='rentry')return false;
  if(account.source!=='generated'&&!['telegraph','nostr'].includes(account.channelId))return false;
  const owner=liveOwnerSiteId(data,account);
  if(owner&&!['telegraph','nostr'].includes(account.channelId))return owner!==siteId;
  const sites=new Set([
    ...data.accountBindings.filter(item=>item.accountId===account.id&&item.channelId===account.channelId).map(item=>item.siteId),
    ...data.tasks.filter(item=>item.accountId===account.id&&item.channelId===account.channelId).map(item=>item.siteId),
  ]);
  if(sites.size>1&&!['telegraph','nostr'].includes(account.channelId))return firstIdentitySite(data,account.id,account.channelId)!==siteId;
  return sites.size>1||sites.size===1&&!sites.has(siteId);
}

function otherSiteGeneratedIdentity(data:Snapshot,siteId:string,channelId:string){
  return data.accounts.some(account=>account.channelId===channelId&&account.source==='generated'&&generatedIdentityConflict(data,account,siteId));
}

function brandedGeneratedIdentityForNewWork(data:Snapshot,siteId:string,channelId:string,selected?:Account){
  if(selected)return hasLegacyPublicIdentityMarker(selected);
  return data.accounts.some(account=>{
    if(account.channelId!==channelId||!hasLegacyPublicIdentityMarker(account))return false;
    const sites=new Set([
      ...data.accountBindings.filter(item=>item.accountId===account.id&&item.channelId===channelId).map(item=>item.siteId),
      ...data.tasks.filter(item=>item.accountId===account.id&&item.channelId===channelId).map(item=>item.siteId),
    ]);
    return sites.size===0||sites.has(siteId);
  });
}

function candidateAccounts(data:Snapshot,site:Site,channelId:string){
  if(['telegraph','nostr','hive'].includes(channelId))return [];
  const available=(account:Account)=>account.channelId===channelId&&!generatedIdentityConflict(data,account,site.id);
  if(channelId==='wordpress-com'||channelId==='leaflet')return data.accounts.filter(available);
  if(['mataroa','paper-wf','verbose'].includes(channelId))return data.accounts.filter(account=>available(account)&&!(channelId==='mataroa'&&account.mataroaExcludedSiteIds?.includes(site.id))&&!(channelId==='verbose'&&account.verboseExcludedSiteIds?.includes(site.id)));
  return data.accounts.filter(account=>available(account)&&(channelId==='github-gist'||normalize(account.email)===normalize(site.publicEmail||site.email)));
}

function accountForSiteChannel(data:Snapshot,site:Site,channel:Channel):Account|undefined{
  const binding=data.accountBindings.find(item=>item.siteId===site.id&&item.channelId===channel.id);
  if(binding)return data.accounts.find(account=>account.id===binding.accountId);
  if(channel.id==='wordpress-com'||channel.id==='leaflet')return;
  const candidates=candidateAccounts(data,site,channel.id);
  if(['mataroa','paper-wf','verbose'].includes(channel.id))return candidates.length===1?candidates[0]:undefined;
  const usableCandidates=['telegraph','github-gist'].includes(channel.id)?candidates.filter(account=>account.credentialKind==='api_token'):candidates;
  return usableCandidates.find(account=>account.status==='registered'&&account.hasPassword)
    ??usableCandidates.find(account=>account.status==='unknown'&&account.hasPassword)
    ??usableCandidates[0];
}

export function channelReadinessForDisplay(data:Snapshot,site:Site,channel:Channel):ChannelReadiness{
  if(channel.automation==='manual')return 'manual';
  if(channel.accountRequired){
    const binding=data.accountBindings.find(item=>item.siteId===site.id&&item.channelId===channel.id);
    const selected=data.accounts.find(item=>item.id===binding?.accountId&&item.channelId===channel.id);
    if(brandedGeneratedIdentityForNewWork(data,site.id,channel.id,selected))return 'handoff_required';
    if(selected&&generatedIdentityConflict(data,selected,site.id)){
      const unresolved=data.tasks.some(task=>task.siteId===site.id&&task.channelId===channel.id&&task.accountId===selected.id&&!task.firstLiveAt&&!task.publicUrl&&(!!task.submittedAt||channel.id==='nostr'&&!!task.nostr||channel.id==='telegraph'&&['telegraph_account_create_pending','account_registration_submitted','telegraph_publish_submitting','telegraph_publish_uncertain'].includes(task.checkpoint??'')));
      return ['telegraph','nostr'].includes(channel.id)&&!unresolved?'autocreate':'handoff_required';
    }
    if(!selected&&!['telegraph','nostr'].includes(channel.id)&&otherSiteGeneratedIdentity(data,site.id,channel.id))return 'handoff_required';
  }
  if(channel.id==='wordpress-com'){
    const binding=data.accountBindings.find(item=>item.siteId===site.id&&item.channelId==='wordpress-com');
    const account=data.accounts.find(item=>item.id===binding?.accountId&&item.channelId==='wordpress-com');
    if(!binding||!account||account.credentialKind!=='oauth'||account.status!=='registered'||!account.hasPassword||!/^[1-9][0-9]{0,19}$/.test(account.username)||!account.publicationUrl)return 'handoff_required';
    try{const url=new URL(account.publicationUrl),host=url.hostname.toLowerCase();return url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/'&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.wordpress\.com$/.test(host)?'ready':'handoff_required'}catch{return 'handoff_required'}
  }
  if(channel.id==='leaflet'){
    const binding=data.accountBindings.find(item=>item.siteId===site.id&&item.channelId==='leaflet');
    const account=data.accounts.find(item=>item.id===binding?.accountId&&item.channelId==='leaflet');
    if(!binding||!account||account.credentialKind!=='api_token'||account.status!=='registered'||!account.hasPassword||account.source!=='imported'||account.email!==''||account.username.length<3||account.username.length>253||account.username!==account.username.toLowerCase()||!account.publicationUrl)return 'handoff_required';
    const labels=account.username.split('.'),validHandle=labels.length>=2&&labels.every((label,index)=>label.length>=1&&label.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)&&(index!==labels.length-1||/[a-z]/.test(label)));
    return validHandle&&/^https:\/\/leaflet\.pub\/p\/did:(?:plc|web):[A-Za-z0-9:._%-]{1,240}$/.test(account.publicationUrl)?'ready':'handoff_required';
  }
  if(channel.id==='rentry'){
    const binding=data.accountBindings.find(item=>item.siteId===site.id&&item.channelId==='rentry');
    const accounts=data.accounts.filter(item=>item.channelId==='rentry');
    const account=binding?accounts.find(item=>item.id===binding.accountId):accounts.length===1?accounts[0]:undefined;
    if(!binding&&!accounts.length)return 'autocreate';
    return account?.status==='registered'&&account.source==='generated'&&account.username==='anonymous'&&account.credentialKind==='api_token'&&account.hasPassword&&!account.rentryExcludedSiteIds?.includes(site.id)?'ready':'handoff_required';
  }
  if(['mataroa','paper-wf','hive','verbose'].includes(channel.id)){
    const binding=data.accountBindings.find(item=>item.siteId===site.id&&item.channelId===channel.id);
    const account=accountForSiteChannel(data,site,channel);
    if(channel.id==='mataroa'&&account?.mataroaExcludedSiteIds?.includes(site.id))return 'handoff_required';
    if(channel.id==='verbose'&&account?.verboseExcludedSiteIds?.includes(site.id))return 'handoff_required';
    let valid=false;
    if(account?.credentialKind==='api_token'&&account.status==='registered'&&account.hasPassword&&account.publicationUrl){
      try{const url=new URL(account.publicationUrl),username=account.username.trim().toLowerCase();valid=!!username&&url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&(channel.id==='mataroa'?/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(username)&&url.hostname===`${username}.mataroa.blog`&&url.pathname==='/':channel.id==='paper-wf'?url.hostname==='paper.wf'&&url.pathname.replace(/\/$/,'')===`/${username}`:channel.id==='verbose'?/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(username)&&username.length>=3&&username.length<=32&&url.hostname==='verbose.blog'&&url.pathname===`/${username}`:url.hostname==='hive.blog'&&url.pathname.replace(/\/$/,'')===`/@${username}`)}catch{}
    }
    if(valid&&(!binding||binding.accountId===account?.id))return 'ready';
    if(['mataroa','paper-wf'].includes(channel.id)&&!binding&&account?.source==='generated'&&account.credentialKind==='api_token'&&account.hasPassword&&['draft','unknown'].includes(account.status)&&(account.registrationAttempts??0)<=1)return 'autocreate';
    if(channel.id==='verbose'&&!binding&&account?.source==='generated'&&(account.status==='draft'&&(account.registrationAttempts??0)===0||account.status==='unknown'&&account.registrationAttempts===1&&account.hasPassword))return 'autocreate';
    if(['mataroa','paper-wf','verbose'].includes(channel.id)&&!binding&&data.accounts.every(item=>item.channelId!==channel.id))return 'autocreate';
    return 'handoff_required';
  }

  if(['bluesky','paragraph'].includes(channel.id)){const binding=data.accountBindings.find(item=>item.siteId===site.id&&item.channelId===channel.id),account=data.accounts.find(item=>item.id===binding?.accountId&&item.channelId===channel.id);return (channel.id!=='paragraph'||site.paragraph?.publicationId===account?.username)&&account?.credentialKind==='api_token'&&account.status==='registered'&&account.hasPassword?'ready':'handoff_required'}
  if(channel.id==='blogger'){const binding=data.accountBindings.find(item=>item.siteId===site.id&&item.channelId==='blogger'),account=data.accounts.find(item=>item.id===binding?.accountId&&item.channelId==='blogger');return site.blogger&&account?.credentialKind==='oauth'&&account.status==='registered'&&account.hasPassword&&!bloggerBlogIdConflict(data,site.id,site.blogger.blogId)?'ready':'handoff_required'}
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
      if(!binding&&['telegraph','nostr'].includes(channel.id)&&channel.automation==='api')return 'autocreate';
      return 'handoff_required';
    }
    if(channel.kind==='profile'&&profileAccountConflict(data,account.id,site.id,channel.id))return 'handoff_required';
    if(['telegraph','nostr'].includes(channel.id)&&channel.automation==='api'&&account.status==='draft'&&account.source==='generated'&&account.credentialKind==='api_token'&&(account.registrationAttempts??0)<1)return 'autocreate';
    const apiReady=channel.automation==='api'&&account.status==='registered'&&account.hasPassword&&account.credentialKind==='api_token';
    const browserReady=channel.automation==='browser'&&account.hasPassword&&['registered','unknown'].includes(account.status);
    return apiReady||browserReady?'ready':'handoff_required';
  }
  return ['telegraph','nostr'].includes(channel.id)&&channel.automation==='api'?'autocreate':'handoff_required';
}

export const channelReadinessLabel:Record<ChannelReadiness,string>={
  ready:'账号与执行条件已就绪',autocreate:'外链助手会自动准备发布账号',handoff_required:'需先连接并验证已有账号',manual:'需人工准备并提交',
};
