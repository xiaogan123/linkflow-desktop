import type {Task} from '../shared/types';
import {
  isHumanTaskReason,
  isTaskReasonCode,
  taskCooldownUntil,
  type TaskReasonCode,
} from '../shared/task-reasons';
import {hasUnresolvedExternalAttempt} from '../shared/publication';
import {REFERRAL_BLOCK_REASON} from '../shared/referral-policy';
import {createHumanAction, HUMAN_ACTION_TIMEOUT_MS, humanActionKind, type HumanActionKind} from '../shared/human-action';

export const HUMAN_TASK_TIMEOUT_MS = HUMAN_ACTION_TIMEOUT_MS;

function reviewReasonCode(task: Task): TaskReasonCode | undefined {
  switch (task.articleReview?.reasonCode) {
    case 'ai_daily_limit': return 'ai_daily_limit';
    case 'ai_task_limit': return 'ai_task_limit';
    case 'evidence_truncated': return 'evidence_truncated';
    case 'content_rejected': return 'content_rejected';
    case 'policy_unknown':
    case 'policy_not_found': return 'channel_ineligible';
    case 'evidence_fetch_failed': return 'temporary_failure';
    case 'evidence_invalid': return 'evidence_insufficient';
    case 'input_too_long': return 'evidence_truncated';
    case 'invalid_topic': return 'invalid_topic';
    case 'format_invalid': return 'format_invalid';
    case 'ai_unavailable': return 'temporary_failure';
    default: return undefined;
  }
}

function legacyText(task: Task): string {
  return [task.checkpoint, task.message, task.articleReview?.reason]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

/**
 * This is the sole compatibility parser for pre-reason-code task text. Runtime
 * transitions must provide a reasonCode instead of adding message patterns here.
 */
export function inferLegacyTaskReasonCode(task: Task): TaskReasonCode | undefined {
  if (isTaskReasonCode(task.reasonCode)) return task.reasonCode;
  // This is an automated transport wait. Display text must never make it a human wait.
  if (task.emailWait) return undefined;
  if (task.checkpoint === 'existing_link' || task.firstLiveAt || task.status === 'live') return undefined;
  if (task.checkpoint === 'referral_guard' || task.reason === REFERRAL_BLOCK_REASON) return 'referral_blocked';
  const text = legacyText(task);
  if (/渠道[\s\S]{0,12}(?:停用|禁用|关闭)|channel[_\s-]*disabled/i.test(text)) return 'channel_disabled';
  if (/等待(?:本人|人工)处理[\s\S]{0,12}(?:已超过两天|超过两天|超时|过期)|human[_\s-]*timeout/i.test(text)) return 'human_timeout';
  if (task.status === 'needs_input' && hasUnresolvedExternalAttempt(task)) return 'submission_unknown';
  if (['system_vault_unavailable', 'ai_setup_required'].includes(task.checkpoint ?? '')) return 'temporary_failure';
  if (['gist_rejected', 'telegraph_publish_rejected'].includes(task.checkpoint ?? '') && !hasUnresolvedExternalAttempt(task)) {
    if (task.checkpoint === 'gist_rejected' && /(?:令牌|凭据)[\s\S]{0,12}(?:无效|失效)/.test(text)) return 'account_handoff';
    return 'platform_rejected';
  }
  if (task.articleReview?.reasonCode === 'ai_unavailable') {
    if (/今日\s*AI[\s\S]{0,20}(?:上限|用完)|AI[\s\S]{0,20}每日[\s\S]{0,12}(?:额度|上限)/i.test(text)) return 'ai_daily_limit';
    if (/当前任务[\s\S]{0,20}AI[\s\S]{0,20}(?:预算|额度|上限)|AI\s*调用预算已用完/i.test(text)) return 'ai_task_limit';
  }

  if (/\bAI\b|模型列表|模型请求|\bLLM\b/i.test(text)&&/限流|频率限制|请求过于频繁|too\s+many\s+requests|rate[_\s-]*limit|\b429\b/i.test(text)) return 'ai_rate_limited';

  const fromReview = reviewReasonCode(task);
  if (fromReview) return fromReview;

  if (/今日\s*AI[\s\S]{0,20}(?:上限|用完)|AI[\s\S]{0,20}每日[\s\S]{0,12}(?:额度|上限)/i.test(text)) return 'ai_daily_limit';
  if (/当前任务[\s\S]{0,20}AI[\s\S]{0,20}(?:预算|额度|上限)|AI\s*调用预算已用完/i.test(text)) return 'ai_task_limit';
  if (/验证码|captcha/i.test(text)) return 'captcha_required';
  if (/手机(?:号)?验证|绑定手机|phone\s*(?:number|verification)/i.test(text)) return 'phone_required';
  if (/(?:同意|确认|接受)[\s\S]{0,12}(?:协议|条款)|agreement|terms\s+accept/i.test(text)) return 'agreement_required';
  if (/提交结果[\s\S]{0,12}(?:待确认|不明|未知)|(?:发布|投稿|提交)[\s\S]{0,12}(?:结果未知|无法确认)|submission[\s_-]*unknown/i.test(text)) return 'submission_unknown';
  if (/证据[\s\S]{0,12}(?:截断|不完整|过长)|(?:输入|上下文)[\s\S]{0,12}(?:过长|截断)|input[_\s-]*too[_\s-]*long/i.test(text)) return 'evidence_truncated';
  if (/(?:证据|材料|规则|政策)[\s\S]{0,16}(?:不足|缺少|无法获取|未找到|未知|无效)|evidence[_\s-]*(?:insufficient|invalid)/i.test(text)) return 'evidence_insufficient';
  if (/选题[\s\S]{0,16}(?:不可用|无效|不是.*正文|读取失败)|invalid[_\s-]*topic/i.test(text) || task.checkpoint === 'invalid_topic') return 'invalid_topic';
  if (/(?:内容|新稿|稿件|选题)[\s\S]{0,16}(?:重复|高度相似)|duplicate[_\s-]*content/i.test(text)) return 'duplicate_content';
  if (/(?:内容|稿件|独立审核|AI\s*核对)[\s\S]{0,16}(?:未通过|拒绝)|content[_\s-]*rejected/i.test(text)) return 'content_rejected';
  if (/格式[\s\S]{0,16}(?:不正确|不符合|无效|错误)|format[_\s-]*invalid/i.test(text)) return 'format_invalid';
  if (/平台[\s\S]{0,16}(?:限流|频率限制)|请求过于频繁|too\s+many\s+requests|rate[_\s-]*limit|\b429\b/i.test(text)) return 'platform_rate_limited';
  if (/(?:平台|投稿|发布|issue)[\s\S]{0,16}(?:拒绝|驳回)|platform[_\s-]*rejected/i.test(text)) return 'platform_rejected';
  if (/(?:站点|网站|任务)[\s\S]{0,20}(?:不适合|不符合)[\s\S]{0,12}渠道|channel[_\s-]*ineligible/i.test(text)) return 'channel_ineligible';
  if (/人工[\s\S]{0,12}(?:接管|登录|账号)|账号[\s\S]{0,12}(?:接管|人工)|account[_\s-]*handoff/i.test(text)) return 'account_handoff';
  if (/人工[\s\S]{0,12}(?:审核|核对)|manual[_\s-]*review/i.test(text)) return 'manual_review';
  if (/需要人工|人工处理|human[_\s-]*required/i.test(text)) return 'human_required';
  if (/临时故障|暂时不可用|网络错误|连接超时|timed?\s*out|timeout|network|ECONN|ETIMEDOUT/i.test(text)) return 'temporary_failure';

  if (task.status === 'needs_input') {
    if (/_account_create_pending$/.test(task.checkpoint ?? '')) return 'account_handoff';
    return 'human_required';
  }
  if (task.status === 'skipped') return 'user_skipped';
  if (task.status === 'failed') return 'unknown';
  return undefined;
}

function validDate(value: string | undefined): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function legacyHumanActionKind(task: Task): HumanActionKind {
  if (task.humanAction) return task.humanAction.kind;
  if (task.reasonCode === 'human_required') {
    const text = legacyText(task);
    if (/邮件[\s\S]{0,16}(?:不明确|歧义|多封)|ambiguous[\s\S]{0,16}(?:email|code)/i.test(text)) return 'email_code_ambiguous';
    if (/选择器|页面结构[\s\S]{0,12}(?:变化|改变)|selector[_\s-]*(?:drift|missing)/i.test(text)) return 'selector_drift';
  }
  return humanActionKind(task.reasonCode);
}

export function migrateTaskReason(task: Task, observedAt: Date = new Date()): boolean {
  let changed = false;
  const reasonCode = inferLegacyTaskReasonCode(task);
  if (task.reason === REFERRAL_BLOCK_REASON) {
    task.reason = undefined;
    changed = true;
  } else if (task.reason && task.suitabilityReason === undefined) {
    task.suitabilityReason = task.reason;
    changed = true;
  }

  if (reasonCode && task.reasonCode !== reasonCode) {
    task.reasonCode = reasonCode;
    changed = true;
  }

  if (task.status === 'needs_input' && reasonCode === 'platform_rejected' && !hasUnresolvedExternalAttempt(task)) {
    task.status = 'failed';
    task.waitingSince = undefined;
    task.waitingDeadlineAt = undefined;
    task.waitingReminderAt = undefined;
    task.humanAction = undefined;
    changed = true;
  }

  if (reasonCode && ['failed', 'skipped'].includes(task.status) && task.cooldownUntil === undefined) {
    const base = validDate(task.updatedAt) ? task.updatedAt : observedAt;
    const cooldownUntil = taskCooldownUntil(reasonCode, base);
    if (cooldownUntil) {
      task.cooldownUntil = cooldownUntil;
      changed = true;
    }
  }

  if (task.status === 'needs_input' && isHumanTaskReason(reasonCode) && !hasUnresolvedExternalAttempt(task)) {
    let waitingSince = validDate(task.waitingSince) ? task.waitingSince : undefined;
    if (!waitingSince) {
      waitingSince = observedAt.toISOString();
      task.waitingSince = waitingSince;
      changed = true;
    }
    const action = createHumanAction(task, {...task.humanAction, kind: legacyHumanActionKind(task)}, observedAt);
    if (JSON.stringify(action) !== JSON.stringify(task.humanAction)) {
      task.humanAction = action;
      changed = true;
    }
    if (task.waitingSince !== action.since) {task.waitingSince = action.since; changed = true;}
    if (task.waitingDeadlineAt !== action.deadline) {task.waitingDeadlineAt = action.deadline; changed = true;}
  }
  return changed;
}

export function migrateTaskReasons(tasks: Task[], observedAt: Date = new Date()): boolean {
  let changed = false;
  for (const task of tasks) changed = migrateTaskReason(task, observedAt) || changed;
  return changed;
}
