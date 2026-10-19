import type {SignupCondition,SignupEmailRequest,SignupExecutionHooks,SignupHumanReason,SignupTaskState} from '../shared/signup';
import {SIGNUP_MESSAGES} from '../shared/signup';
import {errorReasonCode} from '../shared/task-reasons';

export interface SignupPolicy {
  allowAutoRegistration:boolean;
  allowMultipleAccounts:boolean;
  allowFinancialContent:boolean;
  sourceUrl:string;
  checkedAt:string;
  verified:boolean;
}
export type SignupRef = 'identity.username'|'identity.email'|'identity.password'|'identity.displayName'|'email.code';
export type SignupStep = {id:string}&(
  |{action:'open';url:string}
  |{action:'wait';condition:SignupCondition;timeoutMs?:number}
  |{action:'fill';selector:string;ref:SignupRef}
  |{action:'click';selector:string}
  |{action:'check';selector:string}
  |{action:'await_email_link';subjectIncludes?:string}
  |{action:'await_email_code';subjectIncludes?:string}
  |{action:'extract';selector:string;attribute?:'value'|'textContent';target:'api_key'|'token'}
  |{action:'assert_url';url:string}
  |{action:'human';reason?:SignupHumanReason}
  |{action:'irreversible';selector:string}
  |{action:'done'}
);
export interface SignupScript {
  id:string;
  version:number;
  platformId:string;
  allowedHosts:string[];
  /** Exact captcha hosts; no implicit provider list and no subdomain inheritance. */
  captchaDomains?:string[];
  mockOnly?:true;
  policy:SignupPolicy;
  success:SignupCondition;
  steps:SignupStep[];
}
export interface SignupPage {
  captcha:boolean;
  phone:boolean;
  manualReview:boolean;
  controls:Array<{tag:string;type:string;id:string;name:string;label:string}>;
}
export type SignupIrreversibleProbe = 'ready'|'captcha'|'disabled'|'missing'|'unsafe';
export interface SignupBrowserPort {
  runtimeId:string;
  isClosed():boolean;
  url():string;
  canOpen(url:string):boolean;
  open(url:string):Promise<void>;
  inspect():Promise<SignupPage>;
  matches(condition:SignupCondition):Promise<boolean>;
  /** click must reject submit/form controls; only irreversible may submit. */
  /** Same selector and safety checks as irreversible act, without dispatch. */
  probeIrreversible(selector:string):Promise<SignupIrreversibleProbe>;
  act(action:'fill'|'click'|'check'|'irreversible'|'extract',selector:string,value?:string,attribute?:'value'|'textContent',ref?:SignupRef):Promise<boolean|string|undefined>;
  pause(ms:number,signal:AbortSignal):Promise<void>;
  show():void;
  close():void;
}
export interface SignupExecutionInput {
  taskId:string;
  identity:{id:string;username:string;email:string;displayName?:string;existingAccount?:boolean;password:()=>Promise<string|undefined>};
  financialContent:boolean;
  browser:SignupBrowserPort;
  hooks:SignupExecutionHooks;
  secrets:{set(key:string,value:string):Promise<void>};
  signal:AbortSignal;
  state?:SignupTaskState;
  now?:()=>Date;
  /** Test-only loopback opt-in; no real script registry enables this. */
  allowLocalMock?:boolean;
}
export interface SignupExecutionResult {status:'done'|'waiting_email'|'human'|'cancelled'|'deferred';state:SignupTaskState;message:string;scheduledAt?:string}
const IDENTIFIER=/^[a-z0-9][a-z0-9_-]{0,79}$/i;
const HUMAN_REASONS=new Set<SignupHumanReason>(['policy_unverified','existing_identity','consent_required','captcha','phone','manual_review','selector_drift','irreversible_unknown','window_lost','circuit_open','script_changed','human_step','execution_failed']);
const ACTIONS=new Set(['open','wait','fill','click','check','await_email_link','await_email_code','extract','assert_url','human','irreversible','done']);
const REFS=new Set<SignupRef>(['identity.username','identity.email','identity.password','identity.displayName','email.code']);
function validCondition(value:unknown):value is SignupCondition {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const entries=Object.entries(value);
  return entries.length>0&&entries.length<=3&&entries.every(([key,item])=>['css','text','url'].includes(key)&&typeof item==='string'&&item.length>0&&item.length<=1000);
}
export function isSignupScript(value:unknown):value is SignupScript {
  if(!value||typeof value!=='object')return false;
  const s=value as SignupScript;
  if(!IDENTIFIER.test(s.id??'')||!IDENTIFIER.test(s.platformId??'')||!Number.isSafeInteger(s.version)||s.version<1||!Array.isArray(s.allowedHosts)||!s.allowedHosts.length||!s.allowedHosts.every(validHost)||!validCondition(s.success)||!Array.isArray(s.steps)||!s.steps.length||s.steps.length>80)return false;
  if(s.captchaDomains!==undefined&&(!Array.isArray(s.captchaDomains)||!s.captchaDomains.every(validHost)))return false;
  if(s.mockOnly!==undefined&&s.mockOnly!==true)return false;
  const ids=new Set<string>();
  for(const step of s.steps){
    if(!step||!IDENTIFIER.test(step.id??'')||ids.has(step.id)||!ACTIONS.has(step.action))return false;
    ids.add(step.id);
    if('selector' in step&&(typeof step.selector!=='string'||!step.selector||step.selector.length>1000))return false;
    if(['fill','click','check','extract','irreversible'].includes(step.action)&&!('selector' in step))return false;
    if((step.action==='open'||step.action==='assert_url')&&(typeof step.url!=='string'||!step.url))return false;
    if(step.action==='wait'&&(!validCondition(step.condition)||(step.timeoutMs!==undefined&&(!Number.isFinite(step.timeoutMs)||step.timeoutMs<0||step.timeoutMs>60000))))return false;
    if(step.action==='fill'&&!REFS.has(step.ref))return false;
    if(step.action==='extract'&&(!['api_key','token'].includes(step.target)||(step.attribute!==undefined&&!['value','textContent'].includes(step.attribute))))return false;
    if(step.action==='human'&&step.reason!==undefined&&!HUMAN_REASONS.has(step.reason))return false;
    if('subjectIncludes' in step&&(typeof step.subjectIncludes!=='string'||step.subjectIncludes.length>200))return false;
  }
  return s.steps[s.steps.length-1].action==='done';
}
function validHost(value:unknown):value is string {return typeof value==='string'&&/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(value)&&value.length<=253;}
function safeUrl(value:string,script:SignupScript,localMock=false):boolean {
  try{
    const u=new URL(value),host=u.hostname.toLowerCase();
    if(u.username||u.password)return false;
    if(localMock&&script.mockOnly&&u.protocol==='http:'&&host==='127.0.0.1')return true;
    return u.protocol==='https:'&&(!u.port||u.port==='443')&&script.allowedHosts.some(allowed=>host===allowed.toLowerCase()||host.endsWith(`.${allowed.toLowerCase()}`));
  }catch{return false;}
}
function policyAllows(script:SignupScript,financial:boolean):boolean {
  const p=script.policy;
  if(!p||p.verified!==true||p.allowAutoRegistration!==true||typeof p.allowMultipleAccounts!=='boolean'||typeof p.allowFinancialContent!=='boolean'||financial&&!p.allowFinancialContent||typeof p.sourceUrl!=='string'||typeof p.checkedAt!=='string'||!Number.isFinite(Date.parse(p.checkedAt)))return false;
  return safeUrl(p.sourceUrl,script);
}
function signupConsentSatisfied(hooks:SignupExecutionHooks):boolean {
  return hooks.hasSuccessfulRegistrationRecord?.()===true||hooks.hasSiteOwnerSignupConsent?.()===true;
}
/** Read only. False means no final success; null means success is visible but a required output is missing. */
export async function readSignupCompletion(script:SignupScript,browser:SignupBrowserPort,stepIndex:number,allowLocalMock=false):Promise<Array<{target:'api_key'|'token';value:string}>|false|null> {
  if(browser.isClosed()||!safeUrl(browser.url(),script,allowLocalMock)||!await browser.matches(script.success))return false;
  const outputs:Array<{target:'api_key'|'token';value:string}>=[];
  for(const step of script.steps.slice(stepIndex)){
    if(step.action!=='extract')continue;
    const value=await browser.act('extract',step.selector,undefined,step.attribute);
    if(typeof value!=='string'||!value.trim()||value.length>32768)return null;
    outputs.push({target:step.target,value});
  }
  return outputs;
}
/** Three latest platform outcomes must all be failures; a success or ordinary handoff breaks the streak. */
export function signupCircuitUntil(scriptId:string,records:SignupTaskState[],now=new Date()):string|undefined {
  const recent=records.filter(state=>state.scriptId===scriptId&&state.humanReason!=='circuit_open'&&['human','failed','done'].includes(state.status)).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).slice(0,3);
  if(recent.length!==3||!recent.every(state=>!state.irreversible&&state.failure==='selector_missing'))return undefined;
  const until=Date.parse(recent[0].updatedAt)+7*24*60*60*1000;
  return Number.isFinite(until)&&until>now.getTime()?new Date(until).toISOString():undefined;
}

/** Only public scripts whose current registration and policy pages pass review are opted in. */
export const SIGNUP_SCRIPTS:ReadonlyMap<string,SignupScript>=new Map();
export function signupScriptFor(platformId:string):SignupScript|undefined {return SIGNUP_SCRIPTS.get(platformId);}

export async function runSignupScript(script:SignupScript,input:SignupExecutionInput):Promise<SignupExecutionResult> {
  if(!isSignupScript(script))throw Error(SIGNUP_MESSAGES.invalid_script);
  const {browser,hooks,signal}=input,now=()=>input.now?.()??new Date();
  let state:SignupTaskState=input.state?structuredClone(input.state):{version:1,scriptId:script.id,scriptVersion:script.version,identityId:input.identity.id,stepIndex:0,status:'running',runtimeId:browser.runtimeId,updatedAt:now().toISOString(),aiLocateCalls:0,aiLocatedStepIds:[],successCondition:structuredClone(script.success)};
  const save=async(patch:Partial<SignupTaskState>)=>{
    const next={...state,...patch,updatedAt:now().toISOString()};
    try{await hooks.persist(structuredClone(next));}catch(error){throw new SignupPersistenceError(error);}
    state=next;
  };
  const human=async(reason:SignupHumanReason,failure?:SignupTaskState['failure']):Promise<SignupExecutionResult>=>{
    // An attempted registration is never a platform selector failure. Keep its
    // identity and human handoff even if a later verification selector drifts.
    await save({status:'human',humanReason:reason,failure:state.irreversible?undefined:failure,successCondition:structuredClone(script.success)});
    if(!browser.isClosed())browser.show();
    return {status:'human',state,message:SIGNUP_MESSAGES[reason]};
  };
  const defer=async(until:string,message:string=SIGNUP_MESSAGES.execution_failed):Promise<SignupExecutionResult>=>{
    await save({status:'running',humanReason:undefined,failure:undefined});
    return {status:'deferred',state,message,scheduledAt:until};
  };
  if(state.status==='done')return {status:'done',state,message:SIGNUP_MESSAGES.done};
  if(state.scriptId!==script.id||state.scriptVersion!==script.version||state.identityId!==input.identity.id||!Number.isSafeInteger(state.stepIndex)||state.stepIndex<0||state.stepIndex>=script.steps.length)return human('script_changed');
  // A person may have completed verification while the task was waiting for
  // email. Check the final page before any replay or window identity decision.
  const resumeStep=script.steps[state.stepIndex];
  if(input.state&&state.status==='waiting_email'&&(resumeStep.action==='await_email_link'||resumeStep.action==='await_email_code')){
    const outputs=await readSignupCompletion(script,browser,state.stepIndex,input.allowLocalMock);
    if(outputs===null)return human('human_step');
    if(outputs!==false){
      for(const output of outputs)await input.secrets.set(`signup:${input.taskId}:${output.target}`,output.value);
      await save({status:'done',stepIndex:script.steps.length-1,humanReason:undefined,failure:undefined,successCondition:structuredClone(script.success),...(state.irreversible?{irreversible:{...state.irreversible,completed:true}}:{})});
      browser.close();
      return {status:'done',state,message:SIGNUP_MESSAGES.done};
    }
  }
  if(state.irreversible&&!state.irreversible.completed)return human('irreversible_unknown');
  const consentResumable=state.status==='human'&&state.humanReason==='consent_required'&&!state.irreversible&&signupConsentSatisfied(hooks);
  if(state.runtimeId!==browser.runtimeId&&(state.irreversible||state.status==='human'&&!consentResumable||state.status==='failed'))return human('window_lost');
  if(browser.isClosed())return human('window_lost');
  // Form contents and navigation are ephemeral. A new window may replay only while no mutation intent exists.
  if(state.runtimeId!==browser.runtimeId)await save({stepIndex:0,runtimeId:browser.runtimeId,successCondition:structuredClone(script.success)});
  if(state.status==='human'||state.status==='failed'){
    if(state.humanReason!=='circuit_open'&&!consentResumable)return human(state.humanReason??'human_step');
    await save({status:'running',humanReason:undefined,failure:undefined});
  }
  if(input.identity.existingAccount)return human('existing_identity');
  if(!policyAllows(script,input.financialContent))return human('policy_unverified');
  const otherIdentityExists=()=>script.policy.allowMultipleAccounts===false&&(
    hooks.hasOtherPlatformIdentity?.()===true||
    (hooks.listPlatformStates?.()??[]).some(prior=>prior.identityId!==input.identity.id&&(prior.status==='done'||prior.irreversible!==undefined))
  );
  if(otherIdentityExists())return human('existing_identity');
  const circuitUntil=state.irreversible?undefined:signupCircuitUntil(script.id,hooks.listPlatformStates?.()??[],now());
  if(circuitUntil)return defer(circuitUntil,SIGNUP_MESSAGES.circuit_deferred);
  await save({runtimeId:browser.runtimeId,status:'running'});
  let emailCode:string|undefined;
  const redactions=new Set([input.identity.email,input.identity.username,input.identity.displayName??''].filter(Boolean));
  const inspect=async()=>{
    const page=await browser.inspect();
    // Fallback receives static control descriptors only; never field values or page URLs.
    return {...page,controls:page.controls.slice(0,80).map(control=>Object.fromEntries(Object.entries(control).map(([key,value])=>[key,[...redactions].reduce((text,secret)=>text.split(secret).join('[redacted]'),value).slice(0,160)])) as unknown as SignupPage['controls'][number])};
  };
  const hazard=async()=>{const p=await inspect();return p.captcha?'captcha':p.phone?'phone':p.manualReview?'manual_review':undefined;};
  const ensureActive=()=>{if(signal.aborted)throw new Error('aborted');if(browser.isClosed())throw new Error('closed');};
  const targetAction=async(step:Extract<SignupStep,{selector:string}>,value?:string):Promise<boolean|string|undefined>=>{
    let result=await browser.act(step.action as 'fill'|'click'|'check'|'irreversible'|'extract',step.selector,value,step.action==='extract'?step.attribute:undefined,step.action==='fill'?step.ref:undefined);
    if(result!==undefined&&result!==false)return result;
    // A failed irreversible dispatch is never located/replayed: the checkpoint already treats its effect as unknown.
    if(step.action==='irreversible'||step.action==='click'||!hooks.locate||state.aiLocateCalls>=2||state.aiLocatedStepIds.includes(step.id))return undefined;
    const selector=await hooks.locate({stepId:step.id,selector:step.selector,page:{controls:(await inspect()).controls}},signal);
    ensureActive();
    if(!selector||selector.length>1000)return undefined;
    await save({aiLocateCalls:(state.aiLocateCalls+1) as 1|2,aiLocatedStepIds:[...state.aiLocatedStepIds,step.id]});
    const reason=await hazard();if(reason)throw new SignupHazard(reason);
    result=await browser.act(step.action as 'fill'|'check'|'extract',selector,value,step.action==='extract'?step.attribute:undefined,step.action==='fill'?step.ref:undefined);
    return result;
  };
  try{
    for(let index=state.stepIndex;index<script.steps.length;index++){
      ensureActive();
      const step=script.steps[index];
      if(step.action!=='open'){
        if(!safeUrl(browser.url(),script,input.allowLocalMock))return human('execution_failed');
        const reason=await hazard();if(reason)return human(reason);
      }
      if(step.action==='open'){
        if(!safeUrl(step.url,script,input.allowLocalMock)||!browser.canOpen(step.url))return human('execution_failed');
        await browser.open(step.url);ensureActive();
        const reason=await hazard();if(reason)return human(reason);
      }else if(step.action==='wait'){
        const deadline=now().getTime()+(step.timeoutMs??10000);
        while(!await browser.matches(step.condition)){
          ensureActive();const reason=await hazard();if(reason)return human(reason);
          if(now().getTime()>=deadline)return human('selector_drift','selector_missing');
          await browser.pause(1250,signal);
        }
      }else if(step.action==='fill'){
        const values:Partial<Record<SignupRef,string>>={'identity.username':input.identity.username,'identity.email':input.identity.email,'identity.displayName':input.identity.displayName,'email.code':emailCode};
        const value=step.ref==='identity.password'?await input.identity.password():values[step.ref];
        if(!value)return human('human_step');redactions.add(value);
        if(await targetAction(step,value)!==true)return human('selector_drift','selector_missing');
      }else if(step.action==='click'||step.action==='check'){
        if(await targetAction(step)!==true)return human('selector_drift','selector_missing');
      }else if(step.action==='irreversible'){
        if(!signupConsentSatisfied(hooks))return human('consent_required');
        if(otherIdentityExists())return human('existing_identity');
        let selector=step.selector;
        if(!await browser.matches({css:selector})){
          if(!hooks.locate||state.aiLocateCalls>=2||state.aiLocatedStepIds.includes(step.id))return human('selector_drift','selector_missing');
          const found=await hooks.locate({stepId:step.id,selector:step.selector,page:{controls:(await inspect()).controls}},signal);
          ensureActive();
          if(found&&found.length<=1000)await save({aiLocateCalls:(state.aiLocateCalls+1) as 1|2,aiLocatedStepIds:[...state.aiLocatedStepIds,step.id]});
          if(!found||found.length>1000||!await browser.matches({css:found}))return human('selector_drift','selector_missing');
          selector=found;
        }
        const reason=await hazard();if(reason)return human(reason);
        let probe=await browser.probeIrreversible(selector);
        for(let attempt=0;['disabled','missing'].includes(probe)&&attempt<3;attempt++){
          await browser.pause(1250,signal);ensureActive();
          const pendingHazard=await hazard();if(pendingHazard)return human(pendingHazard);
          probe=await browser.probeIrreversible(selector);
        }
        if(probe==='captcha')return human('captcha');
        if(probe==='unsafe')return human('execution_failed');
        if(probe==='disabled')return human('selector_drift');
        if(probe!=='ready')return human('selector_drift','selector_missing');
        if(!signupConsentSatisfied(hooks))return human('consent_required');
        // This awaited write is the dispatch boundary. No rollback even if click/load later fails.
        await save({status:'irreversible',irreversible:{stepId:step.id,at:now().toISOString()}});
        ensureActive();
        if(otherIdentityExists())return human('existing_identity');
        // A false return means the injected guard did not click. The durable
        // intent is retained so a later run cannot spend this identity again.
        if(await browser.act('irreversible',selector)!==true)return human('irreversible_unknown');
        await save({status:'running',irreversible:{...state.irreversible!,completed:true}});
      }else if(step.action==='await_email_link'||step.action==='await_email_code'){
        await save({status:'waiting_email',stepIndex:index});
        const request:SignupEmailRequest={kind:step.action==='await_email_link'?'link':'code',stepId:step.id,scriptId:script.id,allowedHosts:[...script.allowedHosts],...(step.subjectIncludes?{subjectIncludes:step.subjectIncludes}:{})};
        const value=await hooks.awaitEmail?.(request,signal);ensureActive();
        if(!value)return {status:'waiting_email',state,message:SIGNUP_MESSAGES.waiting_email};
        redactions.add(value);
        if(request.kind==='link'){
          if(!safeUrl(value,script,input.allowLocalMock)||!browser.canOpen(value))return human('execution_failed');
          if(otherIdentityExists())return human('existing_identity');
          // Consuming a one-time mail link is also irreversible and gets the same restart guarantee.
          await save({status:'irreversible',irreversible:{stepId:step.id,at:now().toISOString()}});
          ensureActive();if(otherIdentityExists())return human('existing_identity');await browser.open(value);
          await save({status:'running',irreversible:{...state.irreversible!,completed:true}});
        }else emailCode=value;
      }else if(step.action==='extract'){
        const secret=await targetAction(step);
        if(typeof secret!=='string'||!secret.trim()||secret.length>32768)return human('selector_drift','selector_missing');
        redactions.add(secret);
        await input.secrets.set(`signup:${input.taskId}:${step.target}`,secret);
      }else if(step.action==='assert_url'){
        if(!safeUrl(step.url,script,input.allowLocalMock)||browser.url()!==step.url)return human('human_step');
      }else if(step.action==='human')return human(step.reason??'human_step');
      else if(step.action==='done'){
        if(!await browser.matches(script.success))return human('human_step');
        await save({status:'done',stepIndex:index,humanReason:undefined,failure:undefined});
        browser.close();
        return {status:'done',state,message:SIGNUP_MESSAGES.done};
      }
      await save({stepIndex:index+1,status:'running'});
    }
    return human('execution_failed');
  }catch(error){
    if(signal.aborted)return {status:'cancelled',state,message:SIGNUP_MESSAGES.cancelled};
    if(error instanceof SignupPersistenceError)throw error.cause;
    if(isAiLimit(error)){
      if(state.irreversible)return human('execution_failed');
      throw error;
    }
    if(error instanceof SignupHazard)return human(error.reason);
    if(browser.isClosed())return human('window_lost');
    if(state.irreversible)return human(state.irreversible.completed?'execution_failed':'irreversible_unknown');
    return defer(new Date(now().getTime()+15*60*1000).toISOString());
  }
}
class SignupHazard extends Error {constructor(readonly reason:SignupHumanReason){super(reason);}}
class SignupPersistenceError extends Error {constructor(readonly cause:unknown){super('Signup progress persistence failed');}}
function isAiLimit(error:unknown):boolean {return ['ai_daily_limit','ai_task_limit'].includes(errorReasonCode(error)??'');}
