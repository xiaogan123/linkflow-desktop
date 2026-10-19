import type {ArticleReview, Task, TaskReasonCode} from '../shared/types';
import {isHumanTaskReason, taskCooldownUntil, TaskReasonError, TASK_REASON_MESSAGES} from '../shared/task-reasons';
import {hasRecoverablePublisherDraftReceipt, hasUnresolvedExternalAttempt, safelyUnsentBatch5Task} from '../shared/publication';
import {createHumanAction, humanActionKind, humanActionReason} from '../shared/human-action';

/** Translate structured review outcomes at the state transition, never display text. */
export function reviewTaskReason(review: ArticleReview): TaskReasonCode {
  switch (review.reasonCode) {
    case 'review_changes_requested': return 'review_changes_requested';
    case 'analysis_daily_limit': return 'analysis_daily_limit';
    case 'format_repair_exhausted': return 'format_repair_exhausted';
    case 'ai_daily_limit': return 'ai_daily_limit';
    case 'ai_task_limit': return 'ai_task_limit';
    case 'ai_unavailable':
    case 'evidence_fetch_failed': return 'temporary_failure';
    case 'input_too_long':
    case 'evidence_truncated': return 'evidence_truncated';
    case 'evidence_invalid': return 'evidence_insufficient';
    case 'format_invalid': return 'format_invalid';
    case 'invalid_topic': return 'invalid_topic';
    case 'policy_unknown':
    case 'policy_not_found': return 'channel_ineligible';
    default: return 'content_rejected';
  }
}

/** Default classifications at the execution boundary for existing publisher contracts. */
function stateReason(task: Task): TaskReasonCode | undefined {
  if (['live', 'running', 'queued'].includes(task.status)) return undefined;
  if (task.status === 'needs_input' && task.checkpoint === 'waiting_email' && task.emailWait) return undefined;
  // Only adapters that really queued a mail wait write this checkpoint. Other
  // post-registration stops (Telegraph, unexpected pages) stay human waits.
  if (task.status === 'needs_input' && !task.humanAction && task.checkpoint === 'email_code_pending') return 'email_code_pending';
  if (task.checkpoint === 'referral_guard') return 'referral_blocked';
  if (['gist_rejected','telegraph_publish_rejected','product_index_rejected'].includes(task.checkpoint ?? '')) return 'platform_rejected';
  if (hasUnresolvedExternalAttempt(task)) return 'submission_unknown';
  if (task.checkpoint === 'eligibility_wait') return 'channel_ineligible';
  if (task.status === 'needs_input' && task.humanAction) return humanActionReason(task.humanAction.kind);
  switch (task.checkpoint) {
    case 'account_handoff': return 'account_handoff';
    case 'manual_submission': return 'human_required';
    case 'html_app_public_notice': return 'agreement_required';
    case 'invalid_topic': return 'invalid_topic';
    case 'topic_recovery_budget': return 'ai_task_limit';
    case 'article_rejected': return 'content_rejected';
    case 'ai_setup_required':
    case 'system_vault_unavailable': return 'temporary_failure';
  }
  if (task.articleReview?.status === 'failed') return reviewTaskReason(task.articleReview);
  if (task.status === 'needs_input') return task.checkpoint === 'article_review' ? 'manual_review' : 'human_required';
  return task.status === 'skipped' ? 'user_skipped' : task.status === 'failed' ? 'unknown' : undefined;
}

/** Mail work can only survive while waiting, or while a consumed link resumes registration. */
export function activeEmailWait(task: Task): boolean {
  if (!task.emailWait || task.humanAction) return false;
  if (task.status === 'needs_input' && task.checkpoint === 'waiting_email') return task.reasonCode === undefined;
  // A delivered link survives retries and deferrals (temporary_failure, AI limits);
  // its message id is already in the ledger, so dropping it would strand the signup.
  return ['queued', 'running'].includes(task.status)
    && ['account_registration_submitted', 'signup_resume'].includes(task.checkpoint ?? '')
    && task.emailWait.continuation !== 'shiply';
}

export function assertHumanWaitOpen(task: Task, now = new Date()): void {
  if (task.reasonCode === 'human_timeout' ||
      task.status === 'needs_input' && (!!task.humanAction || isHumanTaskReason(task.reasonCode) && !hasUnresolvedExternalAttempt(task)) &&
      !!(task.humanAction?.deadline ?? task.waitingDeadlineAt) && Date.parse(task.humanAction?.deadline ?? task.waitingDeadlineAt!) <= now.getTime()) {
    throw new TaskReasonError('human_timeout', TASK_REASON_MESSAGES.human_timeout);
  }
}

/** Apply metadata alongside the state it describes. Repeated observations never extend a wait. */
export function taskTransition(task: Task, partial: Partial<Task>, now = new Date(), humanResolved = false): Partial<Task> {
  if (partial.lastCheckedAt !== undefined) partial = {...partial, linkRecheckAt: undefined};
  if (task.reasonCode === 'human_timeout' && (partial.status === 'queued' || partial.status === 'running')) assertHumanWaitOpen(task, now);
  if (task.reasonCode === 'submission_unknown' && (partial.status === 'queued' || partial.status === 'running') && !hasRecoverablePublisherDraftReceipt(task) && !safelyUnsentBatch5Task(task)) {
    throw new TaskReasonError('submission_unknown', TASK_REASON_MESSAGES.submission_unknown);
  }
  // AI setup is a system wait for this transition, not a sticky exemption for
  // later account, credential or captcha stops.
  if (task.checkpoint === 'ai_setup_required' && (partial.status === 'running'
    || partial.status === 'needs_input' && partial.checkpoint !== 'ai_setup_required')) {
    partial = {...partial, checkpoint: partial.checkpoint === 'ai_setup_required' ? undefined : partial.checkpoint};
  }
  const projected = {...task, ...partial};
  const registrationCompleted = partial.signup?.status === 'done' && task.signup?.status !== 'done'
    || partial.checkpoint === 'account_verified' && task.checkpoint !== 'account_verified';
  const reviewApproved = !!partial.articleApprovedAt && partial.articleApprovedAt !== task.articleApprovedAt;
  const changed = registrationCompleted || partial.status !== undefined || partial.checkpoint !== undefined || Object.prototype.hasOwnProperty.call(partial, 'reasonCode')
    || Object.prototype.hasOwnProperty.call(partial, 'humanAction') || Object.prototype.hasOwnProperty.call(partial, 'emailWait');
  if (!changed) return partial;
  const sameState = task.status === projected.status && task.checkpoint === projected.checkpoint;
  const explicit = Object.prototype.hasOwnProperty.call(partial, 'reasonCode');
  // Some old records retained only this code. A skip is not proof that the write
  // did not happen; preserve that evidence until a verified live result exists.
  // A typed negative POST response resolves uncertainty, but its immutable
  // submission journal still prevents any repeat submission of this attempt.
  const definiteBatch5Rejection = projected.status === 'failed' && projected.checkpoint === 'batch5_rejected'
    && !!projected.batch5 && ['submitting','opaque_response'].includes(projected.batch5.stage)
    && !projected.publicUrl && !projected.firstLiveAt && explicit
    && ['platform_rejected','platform_rate_limited','format_invalid','account_handoff'].includes(partial.reasonCode ?? '');
  let reasonCode = task.reasonCode === 'submission_unknown' && projected.status !== 'live' && !definiteBatch5Rejection && !safelyUnsentBatch5Task(task)
    ? 'submission_unknown'
    : explicit ? partial.reasonCode
      : partial.humanAction && projected.status === 'needs_input' && !hasUnresolvedExternalAttempt(projected) ? humanActionReason(partial.humanAction.kind)
        : sameState ? task.reasonCode ?? stateReason(projected) : stateReason(projected);
  const externalAttempt=hasUnresolvedExternalAttempt({...projected,reasonCode});
  if(projected.status==='needs_input'&&!externalAttempt){
    if(reasonCode==='referral_blocked')projected.status='failed';
    else if(reasonCode==='channel_ineligible'||projected.checkpoint==='eligibility_wait')projected.status='skipped';
    else if(partial.checkpoint==='ai_setup_required'){
      projected.status='queued';
      reasonCode=undefined;
    }
  }
  if(projected.status==='needs_input'&&!reasonCode&&!projected.emailWait&&projected.checkpoint!=='email_code_pending')reasonCode='human_required';
  // A confirmed refusal without a remote receipt is a finished attempt, not a
  // human wait. Keep adapter result contracts intact while retiring the task.
  const rejectedWithoutSubmission = projected.status === 'needs_input' && reasonCode === 'platform_rejected' && !hasUnresolvedExternalAttempt(projected);
  if (rejectedWithoutSubmission) projected.status = 'failed';
  const result: Partial<Task> = {...partial, reasonCode, ...(projected.status!==partial.status ? {status:projected.status} : {})};
  const terminal = projected.status === 'failed' || projected.status === 'skipped';
  result.cooldownUntil = terminal && reasonCode
    ? sameState && reasonCode === task.reasonCode && task.cooldownUntil
      ? task.cooldownUntil : taskCooldownUntil(reasonCode, now)
    : undefined;
  const humanStop=projected.status==='needs_input'&&!externalAttempt&&reasonCode!=='email_code_pending'
    &&projected.checkpoint!=='waiting_email'||projected.status==='needs_input'&&reasonCode==='referral_blocked'&&externalAttempt;
  if (humanStop) {
    if (projected.articleReview?.status === 'failed' && !['article_review', 'channel_wait'].includes(projected.checkpoint ?? '')) {
      result.articleReview = undefined;
      result.articleApprovedAt = undefined;
    }
    const continuing = task.status === 'needs_input' && !!task.humanAction;
    const previousAction = projected.humanAction;
    const kind = partial.humanAction?.kind ?? (reasonCode !== task.reasonCode ? humanActionKind(reasonCode) : previousAction?.kind);
    const newExpiry = partial.humanAction?.expiresAt !== undefined && partial.humanAction.expiresAt !== task.humanAction?.expiresAt;
    const humanAction = createHumanAction({...projected, reasonCode, waitingSince: task.waitingSince ?? task.humanAction?.since ?? projected.waitingSince}, {
      ...previousAction,
      ...(kind ? {kind, ...(previousAction?.kind !== kind ? {instruction: kind} : {})} : {}),
      ...(continuing ? {since: task.humanAction?.since ?? task.waitingSince, notifiedAt: newExpiry ? undefined : task.humanAction?.notifiedAt ?? task.waitingReminderAt} : {}),
    }, now);
    result.humanAction = humanAction;
    result.waitingSince = humanAction.since;
    result.waitingDeadlineAt = humanAction.deadline;
    result.waitingReminderAt = humanAction.notifiedAt;
  } else if (!terminal || reasonCode !== 'human_timeout' && reasonCode !== 'user_skipped') {
    result.humanAction = undefined;
    // Requeueing is not evidence that the human gate was resolved. Keep the
    // original clock so a task that returns to a human stop reuses its deadline;
    // queued work itself never times out, only the stop it comes back to.
    const resuming = ['queued','running'].includes(projected.status) && !humanResolved && !registrationCompleted && !reviewApproved;
    const registration = projected.checkpoint === 'account_registration_submitted';
    const since = task.humanAction?.since ?? task.waitingSince ?? (registration ? now.toISOString() : undefined);
    const deadline = task.humanAction?.deadline ?? task.waitingDeadlineAt;
    result.waitingSince = resuming ? since : undefined;
    result.waitingDeadlineAt = resuming && since ? deadline ?? createHumanAction(projected,{since},now).deadline : undefined;
    result.waitingReminderAt = resuming ? task.humanAction?.notifiedAt ?? task.waitingReminderAt : undefined;
  }
  if (projected.emailConfirmation && !(projected.status === 'needs_input' && projected.humanAction?.kind === 'email_confirmation' && projected.checkpoint === 'email_confirmation')) result.emailConfirmation = undefined;
  if ((task.emailWait || partial.emailWait) && !activeEmailWait({...task, ...result})) result.emailWait = undefined;
  return result;
}
