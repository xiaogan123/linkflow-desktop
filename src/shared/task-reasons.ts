import {BATCH9B_MESSAGES} from './batch9b-messages';
import {AI_REVIEW_MESSAGES} from './ai-review-messages';

export const TASK_REASON_CODES = [
  'ai_daily_limit',
  'analysis_daily_limit',
  'ai_rate_limited',
  'ai_task_limit',
  'content_rejected',
  'duplicate_content',
  'diversity_deferred',
  'platform_capacity',
  'schedule_missed',
  'review_changes_requested',
  'evidence_insufficient',
  'evidence_truncated',
  'format_invalid',
  'format_repair_exhausted',
  'platform_rejected',
  'platform_rate_limited',
  'temporary_failure',
  'email_code_pending',
  'human_required',
  'captcha_required',
  'phone_required',
  'agreement_required',
  'account_handoff',
  'manual_review',
  'human_timeout',
  'channel_disabled',
  'channel_ineligible',
  'referral_blocked',
  'user_skipped',
  'submission_unknown',
  'invalid_topic',
  'unknown',
] as const;

export type TaskReasonCode = typeof TASK_REASON_CODES[number];

const TASK_REASON_CODE_SET: ReadonlySet<string> = new Set(TASK_REASON_CODES);

export const TASK_REASON_MESSAGES: Record<TaskReasonCode, string> = {
  analysis_daily_limit: BATCH9B_MESSAGES.analysisLimit,
  ai_daily_limit: '今天的 AI 次数用完了',
  ai_rate_limited: 'AI 服务暂时限流',
  ai_task_limit: '这篇的 AI 次数用完了',
  content_rejected: '内容未通过审核',
  duplicate_content: '内容或选题重复',
  diversity_deferred: '内容重复，已换角度顺延',
  platform_capacity: '可用平台不足，已统一降低本月目标',
  schedule_missed: '错过排期，已分散安排',
  review_changes_requested: '审核要求局部修改',
  evidence_insufficient: '审核证据不足',
  evidence_truncated: '审核证据不完整',
  format_invalid: '内容格式不符合要求',
  format_repair_exhausted: AI_REVIEW_MESSAGES.formatRepairExhausted,
  platform_rejected: '平台拒绝了本次提交',
  platform_rate_limited: '平台暂时限制了提交频率',
  temporary_failure: '服务暂时不可用',
  email_code_pending: '等待验证邮件',
  human_required: '需要人工处理',
  captcha_required: '需要人工完成验证码',
  phone_required: '需要人工完成手机验证',
  agreement_required: '需要人工确认平台协议',
  account_handoff: '需要人工接管账号',
  manual_review: '等待人工审核',
  human_timeout: '等待人工处理已超时',
  channel_disabled: '这个平台已停用，已改用其他平台。',
  channel_ineligible: '这个平台不适合这个站，已改用其他平台。',
  referral_blocked: '内容含推荐信息，等待修改',
  user_skipped: '用户已跳过该任务',
  submission_unknown: '提交结果尚未确认',
  invalid_topic: '选题不可用',
  unknown: '任务未能完成',
};

export const TASK_WAIT_MESSAGES = {
  reviewReminderTitle: '稿件等待审核',
  reviewReminder: '稿件已等待一天，请查看审核。',
};

export const TASK_FLOW_MESSAGES = {
  dailyAiWait: '今天的 AI 次数用完了，明天自动继续。',
  temporaryRetry: '公开证据或 AI 服务暂时不可用，已安排有限次数的自动重试。',
  recoveryExhausted: '这项任务已达到自动重试或 AI 处理次数上限；稿件和进度已保留，不再安排自动恢复。',
  humanTimeout: '等待本人处理已超过两天，已暂时搁置并保留稿件和账号；其他可执行任务继续。',
  registrationTimeout: '账号注册等你处理已超过两天，这篇的名额先让出；原账号和注册记录保留，验证同一账号后继续，不会重新注册。',
};

/** Fixed planning cooldowns. Transient and human-wait reasons intentionally have no entry. */
// Draft-side failures (duplicate, evidence, format, topic) say nothing about the platform,
// so they never lock the site × platform pair; the slot simply moves on with a new draft.
export const TASK_COOLDOWN_DAYS: Partial<Record<TaskReasonCode, number>> = {
  ai_task_limit: 7,
  content_rejected: 45,
  platform_rejected: 30,
  human_timeout: 14,
  user_skipped: 30,
  unknown: 30,
};

const HUMAN_TASK_REASONS: ReadonlySet<TaskReasonCode> = new Set([
  'human_required',
  'captcha_required',
  'phone_required',
  'agreement_required',
  'account_handoff',
  'manual_review',
]);

export function isTaskReasonCode(value: unknown): value is TaskReasonCode {
  return typeof value === 'string' && TASK_REASON_CODE_SET.has(value);
}

export function taskReasonMessage(code: TaskReasonCode): string {
  return TASK_REASON_MESSAGES[code];
}

export function taskCooldownUntil(
  code: TaskReasonCode,
  at: Date | string | number,
): string | undefined {
  const days = TASK_COOLDOWN_DAYS[code];
  if (days === undefined) return undefined;
  const time = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time + days * 86_400_000).toISOString();
}

export function isHumanTaskReason(code: TaskReasonCode | undefined): boolean {
  return code !== undefined && HUMAN_TASK_REASONS.has(code);
}

export interface TaskReasonErrorOptions extends ErrorOptions {
  retryAfterMs?: number;
}

export class TaskReasonError extends Error {
  readonly reasonCode: TaskReasonCode;
  readonly code: TaskReasonCode;
  readonly retryAfterMs?: number;

  constructor(code: TaskReasonCode, message: string, options: TaskReasonErrorOptions = {}) {
    super(message, options);
    this.name = 'TaskReasonError';
    this.reasonCode = code;
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

function objectProperty(value: object, property: 'reasonCode' | 'code' | 'cause'): unknown {
  try {
    return (value as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

/** Reads typed error metadata only. Legacy message parsing belongs to the one-time store migration. */
export function errorReasonCode(error: unknown): TaskReasonCode | undefined {
  const seen = new Set<object>();
  let current: unknown = error;
  while ((typeof current === 'object' && current !== null) || typeof current === 'function') {
    const object = current as object;
    if (seen.has(object)) return undefined;
    seen.add(object);
    const reasonCode = objectProperty(object, 'reasonCode');
    if (isTaskReasonCode(reasonCode)) return reasonCode;
    const code = objectProperty(object, 'code');
    if (isTaskReasonCode(code)) return code;
    current = objectProperty(object, 'cause');
  }
  return undefined;
}
