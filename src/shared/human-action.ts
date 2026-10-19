import {HUMAN_ACTION_MESSAGES} from './registration-messages';
import type {Task, TaskReasonCode} from './types';

export const HUMAN_ACTION_TIMEOUT_MS = 48 * 3_600_000;
export const HUMAN_ACTION_KINDS = ['captcha', 'phone', 'consent', 'email_code_ambiguous', 'email_confirmation', 'selector_drift', 'account_login', 'other'] as const;
export type HumanActionKind = typeof HUMAN_ACTION_KINDS[number];
export const HUMAN_ACTION_IPC_COMMANDS = ['human-action:open', 'human-action:done', 'human-action:skip'] as const;

/** All new handoff copy lives here; persisted actions may store its key or text. */
export {HUMAN_ACTION_MESSAGES} from './registration-messages';

export type HumanActionInstruction = HumanActionKind | typeof HUMAN_ACTION_MESSAGES[HumanActionKind];
export interface HumanAction {
  kind: HumanActionKind;
  since: string;
  deadline: string;
  expiresAt?: string;
  instruction: HumanActionInstruction;
  url: string;
  platform: string;
  snippet?: string;
  notifiedAt?: string;
}

const HUMAN_REASON_BY_KIND: Record<HumanActionKind, TaskReasonCode> = {
  captcha: 'captcha_required',
  phone: 'phone_required',
  consent: 'agreement_required',
  email_code_ambiguous: 'human_required',
  email_confirmation: 'human_required',
  selector_drift: 'human_required',
  account_login: 'account_handoff',
  other: 'human_required',
};

export function humanActionReason(kind: HumanActionKind): TaskReasonCode {
  return HUMAN_REASON_BY_KIND[kind];
}

export function humanActionKind(reason: TaskReasonCode | undefined): HumanActionKind {
  switch (reason) {
    case 'captcha_required': return 'captcha';
    case 'phone_required': return 'phone';
    case 'agreement_required': return 'consent';
    case 'account_handoff': return 'account_login';
    default: return 'other';
  }
}

/** A handoff location is navigation context, never a mailbox token container. */
export function safeHumanActionUrl(value: string | undefined): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return ''; }
}

export function redactHumanActionSnippet(value: string): string {
  return value.replace(/https?:\/\/[^\s<>]+/gi, HUMAN_ACTION_MESSAGES.redacted)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, HUMAN_ACTION_MESSAGES.redacted)
    .replace(/\b(?:bearer\s+\S+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+)/gi, HUMAN_ACTION_MESSAGES.redacted)
    .slice(0, 300);
}

export function createHumanAction(
  task: Pick<Task, 'channelId' | 'sourceDomain' | 'reasonCode' | 'waitingSince' | 'waitingReminderAt'>,
  input: Partial<HumanAction> = {},
  now = new Date(),
): HumanAction {
  const kind = input.kind ?? humanActionKind(task.reasonCode);
  const starts = [input.since, task.waitingSince].filter(validHumanActionDate);
  // Legacy timestamps remain readable by older callers. An earlier timestamp may
  // shorten the wait, while a repeated observation can never extend it.
  const since = starts.sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? now.toISOString();
  const fallbackUrl = task.sourceDomain ? `https://${task.sourceDomain}/` : '';
  const notifiedAt = Object.prototype.hasOwnProperty.call(input, 'notifiedAt') ? input.notifiedAt : task.waitingReminderAt;
  return {
    kind,
    since,
    deadline: new Date(Date.parse(since) + HUMAN_ACTION_TIMEOUT_MS).toISOString(),
    instruction: input.instruction ?? kind,
    url: safeHumanActionUrl(input.url ?? fallbackUrl),
    platform: input.platform ?? task.channelId,
    ...(input.expiresAt ? {expiresAt: input.expiresAt} : {}),
    ...(input.snippet ? {snippet: redactHumanActionSnippet(input.snippet)} : {}),
    ...(notifiedAt ? {notifiedAt} : {}),
  };
}

export function validHumanActionDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validHumanAction(action: HumanAction): boolean {
  return HUMAN_ACTION_KINDS.includes(action.kind) && validHumanActionDate(action.since)
    && validHumanActionDate(action.deadline)
    && Date.parse(action.deadline) === Date.parse(action.since) + HUMAN_ACTION_TIMEOUT_MS
    && (action.expiresAt === undefined || validHumanActionDate(action.expiresAt) && Date.parse(action.expiresAt) >= Date.parse(action.since))
    && (action.notifiedAt === undefined || validHumanActionDate(action.notifiedAt) && Date.parse(action.notifiedAt) >= Date.parse(action.since))
    && (action.instruction === action.kind || action.instruction === HUMAN_ACTION_MESSAGES[action.kind])
    && typeof action.url === 'string' && action.url.length <= 2048 && safeHumanActionUrl(action.url) === action.url
    && typeof action.platform === 'string' && action.platform.length > 0 && action.platform.length <= 100
    && (action.snippet === undefined || typeof action.snippet === 'string' && action.snippet.length <= 300);
}

export interface HumanActionNotifications {immediate: Task[]; daily: Task[]}

/** Mutates only reminder stamps. Call once per scheduler observation, then aggregate daily rows. */
export function collectHumanActionNotifications(tasks: Task[], now = new Date(), timezone?: string): HumanActionNotifications {
  const result: HumanActionNotifications = {immediate: [], daily: []};
  const calendarDay = (date: Date): string => {
    try {
      return new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(date);
    } catch { return date.toISOString().slice(0, 10); }
  };
  const today = calendarDay(now);
  for (const task of tasks) {
    const action = task.humanAction;
    if (task.status !== 'needs_input' || !action || Date.parse(action.deadline) <= now.getTime()) continue;
    const expired = action.expiresAt !== undefined && Date.parse(action.expiresAt) <= now.getTime();
    if (action.expiresAt && !expired) {
      if (!action.notifiedAt) result.immediate.push(task);
    } else if (!action.notifiedAt ||
      expired && Date.parse(action.notifiedAt) < Date.parse(action.expiresAt!) ||
      calendarDay(new Date(action.notifiedAt)) !== today) result.daily.push(task);
    else continue;
    if (result.immediate.at(-1) !== task && result.daily.at(-1) !== task) continue;
    action.notifiedAt = now.toISOString();
    task.waitingReminderAt = action.notifiedAt;
  }
  return result;
}
