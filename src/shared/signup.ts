/** Persisted registration progress contains references and counters only, never mail codes or API keys. */
export type SignupHumanReason = 'policy_unverified'|'existing_identity'|'consent_required'|'captcha'|'phone'|'manual_review'|'selector_drift'|'irreversible_unknown'|'window_lost'|'circuit_open'|'script_changed'|'human_step'|'execution_failed';
export type SignupStatus = 'running'|'waiting_email'|'human'|'irreversible'|'done'|'failed';
export interface SignupCondition {css?:string;text?:string;url?:string}
export interface SignupTaskState {
  version:1;
  scriptId:string;
  scriptVersion:number;
  identityId:string;
  stepIndex:number;
  status:SignupStatus;
  runtimeId:string;
  updatedAt:string;
  irreversible?:{stepId:string;at:string;completed?:true};
  aiLocateCalls:0|1|2;
  aiLocatedStepIds:string[];
  failure?:'selector_missing'|'execution_failed';
  humanReason?:SignupHumanReason;
  /** Static, allowlisted success condition declared by the local script. */
  successCondition?:SignupCondition;
}
export interface SignupEmailRequest {kind:'link'|'code';stepId:string;scriptId:string;allowedHosts:string[];subjectIncludes?:string}
export interface SignupLocateRequest {stepId:string;selector:string;page:{controls:Array<{tag:string;type:string;id:string;name:string;label:string}>}}
export interface SignupExecutionHooks {
  /** Resolve only after the checkpoint is durable. Rejection must prevent dispatch. */
  persist(state:SignupTaskState):Promise<void>;
  listPlatformStates?():SignupTaskState[];
  /** Fresh account lookup for the same platform, excluding this task's current identity. */
  hasOtherPlatformIdentity?():boolean;
  /** Fresh, persisted site-owner decision for this platform's first registration. */
  hasSiteOwnerSignupConsent?():boolean;
  /** A completed registration for this site owner and platform allows later identities. */
  hasSuccessfulRegistrationRecord?():boolean;
  awaitEmail?(request:SignupEmailRequest,signal:AbortSignal):Promise<string|undefined>;
  /** Fresh read after awaitEmail returns pending; absence must not masquerade as an active wait. */
  emailWaitRegistered?():boolean;
  /** Another live wait owns the same recipient; retry admission without a browser action. */
  emailWaitQueued?():boolean;
  /** Selector-only fallback: at most two successful calls here; controller charges each AI request to task and daily budgets. */
  locate?(request:SignupLocateRequest,signal:AbortSignal):Promise<string|undefined>;
}
export {SIGNUP_MESSAGES} from './registration-messages';
