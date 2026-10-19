import type {Account,ExecutionContext, Task} from '../shared/types';
import type {EmailWait, VerificationResult} from '../shared/mail-automation';
import {mailboxAutomationReady} from '../shared/mail-automation';
import {isMailAuthenticationError} from '../integrations/mail';
import {createHumanAction, humanActionReason,HUMAN_ACTION_MESSAGES} from '../shared/human-action';
import {REGISTRATION_MESSAGES as M} from '../shared/registration-messages';
import type {Store} from './store';
import {safeMessage} from './validation';

export const EMAIL_POLL_MS = 60_000;
export const EMAIL_CODE_TTL_MS = 10 * 60_000;
export const EMAIL_FIRST_POLL_DELAY_MS = 45_000;
export const emailValueKey = (taskId:string) => `signup:${taskId}:email`;

export interface MailConsumption {channelId:string;recipient:string;messageIds:string[]}
type MailConsumptionState={emailConsumptions?:MailConsumption[]};
function consumptionKey(channelId:string,recipient:string):string{return `${channelId.toLowerCase()}\u0000${recipient.trim().toLowerCase()}`}
export function mailConsumptionIds(state:MailConsumptionState,channelId:string,recipient:string):string[] {
  const key=consumptionKey(channelId,recipient);
  return [...new Set((state.emailConsumptions??[]).filter(entry=>consumptionKey(entry.channelId,entry.recipient)===key).flatMap(entry=>entry.messageIds))];
}
/** No eviction: a consumed message must not reappear when a wait is removed. */
export function recordMailConsumption(state:MailConsumptionState,channelId:string,recipient:string,messageId:string):boolean {
  if(!messageId||mailConsumptionIds(state,channelId,recipient).includes(messageId))return false;
  state.emailConsumptions??=[];
  let entry=state.emailConsumptions.find(item=>consumptionKey(item.channelId,item.recipient)===consumptionKey(channelId,recipient));
  if(!entry){entry={channelId,recipient:recipient.trim().toLowerCase(),messageIds:[]};state.emailConsumptions.push(entry)}
  if(entry.messageIds.length>=10_000)throw Error(M.emailUncertain);
  entry.messageIds.push(messageId);
  return true;
}
export function mailIdentityConflict(state:{accounts:Account[]},accountId:string|undefined,channelId:string,recipient:string):boolean {
  return state.accounts.some(account=>account.id!==accountId&&account.channelId===channelId&&account.email.trim().toLowerCase()===recipient.trim().toLowerCase()
    &&(account.status==='registered'||(account.registrationAttempts??0)>0));
}

export interface EmailWaitServices {
  context(task:Task, signal:AbortSignal):ExecutionContext;
  patch(id:string, partial:Partial<Task>):void;
  scan(context:ExecutionContext):Promise<VerificationResult>;
  scanBatch?(contexts:ExecutionContext[]):Promise<Map<string,VerificationResult>>;
  recordConsumed(task:Task,messageId:string,signal:AbortSignal):boolean;
  consume(task:Task, result:Extract<VerificationResult,{kind:'code'|'link'}>, signal:AbortSignal):Promise<void>;
  confirm?(task:Task, result:Extract<VerificationResult,{kind:'confirmation_required'}>, signal:AbortSignal):Promise<void>;
  onAuthenticationFailure?(mailboxId:string,errorMessage:string):void;
  recover?(task:Task):Promise<boolean>;
  now?:()=>Date;
}

/** Mail has its own bounded work queue. The publication executor never awaits it. */
export class EmailWaitCoordinator {
  private active?:AbortController;
  private work?:Promise<void>;
  constructor(private readonly store:Pick<Store,'read'>, private readonly services:EmailWaitServices) {}

  register(task:Task, input:Pick<EmailWait,'kind'|'recipient'|'continuation'|'mailboxId'> & {since?:string}):EmailWait|undefined {
    if(task.emailWait&&task.status==='needs_input'&&task.checkpoint==='waiting_email')return task.emailWait;
    if(task.humanAction||task.reasonCode&&task.reasonCode!=='email_code_pending')return;
    if(!['running','needs_input'].includes(task.status))return;
    const state=this.store.read();
    if(mailIdentityConflict(state,task.accountId,task.channelId,input.recipient))return;
    const busy=state.tasks.some(other=>other.id!==task.id&&other.channelId===task.channelId&&other.status==='needs_input'&&other.checkpoint==='waiting_email'&&!other.humanAction&&!other.reasonCode&&!!other.emailWait&&consumptionKey(other.channelId,other.emailWait.recipient)===consumptionKey(task.channelId,input.recipient));
    if(busy){
      // Occupancy is observed every scheduler tick; only the first observation
      // changes the task. Rewriting an identical stop would rewrite the store.
      if(task.status!=='needs_input'||task.checkpoint!=='email_code_pending'||task.reasonCode!=='email_code_pending'){
        this.services.patch(task.id,{status:'needs_input',checkpoint:'email_code_pending',reasonCode:'email_code_pending',message:M.waitingEmail});
      }
      return;
    }
    const now=this.services.now?.()??new Date();
    const since=input.since??now.toISOString();
    const expiresAt=new Date(Date.parse(since)+(input.kind==='code'?EMAIL_CODE_TTL_MS:48*3_600_000));
    const nextPollAt=new Date(Math.min(now.getTime()+EMAIL_FIRST_POLL_DELAY_MS,expiresAt.getTime()));
    const wait:EmailWait={...input,since,nextPollAt:nextPollAt.toISOString(),expiresAt:expiresAt.toISOString(),consumedMessageIds:mailConsumptionIds(this.store.read(),task.channelId,input.recipient).slice(-100)};
    this.services.patch(task.id,{status:'needs_input',checkpoint:'waiting_email',reasonCode:undefined,emailWait:wait,emailWaitRegisteredAt:now.toISOString(),message:M.waitingEmail});
    return wait;
  }

  /** Returns immediately to a caller that does not await the returned bookkeeping promise. */
  poll():Promise<void> {
    if(this.work)return this.work;
    const state=this.store.read(),now=this.services.now?.()??new Date();
    if(!state.settings.autoRun)return Promise.resolve();
    const due=state.tasks.filter(task=>task.status==='needs_input'&&!!task.emailWait&&task.checkpoint==='waiting_email'&&state.settings.channelOverrides[task.channelId]!==false&&Date.parse(task.emailWait.nextPollAt)<=now.getTime()&&state.sites.some(site=>site.id===task.siteId&&site.status==='ready'));
    if(!due.length)return Promise.resolve();
    const abort=new AbortController();this.active=abort;
    this.work=this.scanDue(due,abort.signal).finally(()=>{if(this.active===abort)this.active=undefined;this.work=undefined});
    return this.work;
  }
  stop():void {this.active?.abort()}

  private current(original:Task, signal:AbortSignal):Task|undefined {
    if(signal.aborted)return;
    const state=this.store.read(),task=state.tasks.find(value=>value.id===original.id);
    if(!state.settings.autoRun||state.settings.channelOverrides[original.channelId]===false||!task||task.status!=='needs_input'||task.checkpoint!=='waiting_email'||task.accountId!==original.accountId||task.emailWait?.since!==original.emailWait?.since||task.emailWait?.recipient!==original.emailWait?.recipient||task.emailWait?.mailboxId!==original.emailWait?.mailboxId||!state.sites.some(site=>site.id===task.siteId&&site.status==='ready'))return;
    return task;
  }
  private handoff(task:Task, ambiguous=false, snippet?:string):void {
    const now=this.services.now?.()??new Date(),kind=ambiguous?'email_code_ambiguous':'account_login';
    const expiresAt=task.emailWait?.expiresAt;
    this.services.patch(task.id,{status:'needs_input',checkpoint:'email_verification_human',emailWait:undefined,reasonCode:humanActionReason(kind),humanAction:createHumanAction(task,{kind,snippet,...(expiresAt&&Date.parse(expiresAt)>=now.getTime()?{expiresAt}:{})},now),message:ambiguous?HUMAN_ACTION_MESSAGES.email_code_ambiguous:M.emailExpired});
  }
  private resume(task:Task,messageId?:string):void {
    const wait=task.emailWait;
    if(!wait)return;
    const consumedMessageIds=[...wait.consumedMessageIds,...(messageId?[messageId]:[])].slice(-100);
    this.services.patch(task.id,{status:'queued',checkpoint:task.signup?'signup_resume':wait.continuation==='browser'?'account_registration_submitted':undefined,emailWait:wait.continuation==='shiply'?undefined:{...wait,consumedMessageIds},humanAction:undefined,reasonCode:undefined,scheduledAt:(this.services.now?.()??new Date()).toISOString(),message:M.emailReceived});
  }
  private async scanDue(tasks:Task[],signal:AbortSignal):Promise<void> {
    const groups=new Map<string,Array<{original:Task;context:ExecutionContext}>>();
    for(const original of tasks){
      const task=this.current(original,signal);if(!task?.emailWait)continue;
      const now=this.services.now?.()??new Date();
      if(mailIdentityConflict(this.store.read(),task.accountId,task.channelId,task.emailWait.recipient)){this.handoff(task);continue}
      try{if(this.services.recover&&await this.services.recover(task)){const current=this.current(original,signal);if(current)this.resume(current);continue}}catch{continue}
      if(Date.parse(task.emailWait.expiresAt)<=now.getTime()){this.handoff(task);continue}
      this.services.patch(task.id,{emailWait:{...task.emailWait,nextPollAt:new Date(Math.min(now.getTime()+EMAIL_POLL_MS,Date.parse(task.emailWait.expiresAt))).toISOString()}});
      let context:ExecutionContext;
      try{context=this.services.context(task,signal)}catch{continue}
      if(!mailboxAutomationReady(context.mailbox)){this.handoff(task);continue}
      const ids=mailConsumptionIds(this.store.read(),task.channelId,task.emailWait.recipient);
      context={...context,task:{...context.task,emailWait:{...task.emailWait,consumedMessageIds:[...new Set([...task.emailWait.consumedMessageIds,...ids])]}}};
      const key=context.mailbox!.id;
      const group=groups.get(key)??[];group.push({original,context});groups.set(key,group);
    }
    for(const [mailboxId,group] of groups){
      if(signal.aborted)return;
      let results:Map<string,VerificationResult>;
      try{
        if(this.services.scanBatch)results=await this.services.scanBatch(group.map(item=>item.context));
        else results=new Map(await Promise.all(group.map(async item=>[item.original.id,await this.services.scan(item.context)] as const)));
      }catch(error){
        if(signal.aborted)return;
        if(isMailAuthenticationError(error)){
          this.services.onAuthenticationFailure?.(mailboxId,safeMessage(error));
          for(const {original} of group){const current=this.current(original,signal);if(current)this.handoff(current)}
        }
        continue;
      }
      for(const {original,context} of group){
        let task=this.current(original,signal);const result=results.get(original.id);
        if(!task?.emailWait||!result||result.kind==='none')continue;
        const fresh=this.store.read(),account=fresh.accounts.find(value=>value.id===task!.accountId);
        if(account?.diagnostic?.code==='email_exists'||mailIdentityConflict(fresh,task.accountId,task.channelId,task.emailWait.recipient)){this.handoff(task);continue}
        const mailbox=context.mailbox,latestMailbox=mailbox&&this.store.read().mailboxes.find(value=>value.id===mailbox.id);
        if(!latestMailbox||latestMailbox.updatedAt!==mailbox?.updatedAt||latestMailbox.host!==mailbox.host||latestMailbox.user!==mailbox.user)continue;
        if(Date.parse(task.emailWait.expiresAt)<=(this.services.now?.()??new Date()).getTime()){this.handoff(task);continue}
        if(result.kind==='ambiguous'){this.handoff(task,true,result.snippet);continue}
        const candidateKind=result.kind==='confirmation_required'?result.candidate.kind:result.kind;
        if(candidateKind!==task.emailWait.kind||!result.messageId)continue;
        if(result.kind==='confirmation_required'&&!this.services.confirm){this.handoff(task,true,result.snippet);continue}
        let claimed:boolean;
        try{claimed=this.services.recordConsumed(task,result.messageId,signal)}catch{this.handoff(task);continue}
        if(!claimed)continue;
        try{
          if(result.kind==='confirmation_required')await this.services.confirm!(task,result,signal);
          else await this.services.consume(task,result,signal);
        }catch{
          const current=this.current(original,signal);if(current)this.handoff(current);
          continue;
        }
        // Confirmation has its own resumable handoff; receiving a message is
        // not permission to submit its code or open its verification link.
        if(result.kind==='confirmation_required')continue;
        task=this.current(original,signal);if(task)this.resume(task,result.messageId);
      }
    }
  }
}
