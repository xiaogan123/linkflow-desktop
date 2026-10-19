import type {State} from './store';
import {signupCircuitUntil} from '../integrations/signup-executor';
import {createHumanAction} from '../shared/human-action';
import {REGISTRATION_MESSAGES} from '../shared/registration-messages';
import {taskTransition} from './task-state';

function unresolvedRegistration(task:State['tasks'][number]):boolean {
  return !!task.signup?.irreversible&&task.signup.status!=='done'||task.signup?.humanReason==='irreversible_unknown';
}

/** Only confirmed selector drift opens the platform circuit. Uncertain submissions retain their own handoff. */
export function maintainSignupCircuits(state:Pick<State,'tasks'|'accounts'>,now=new Date()):void {
  const groups=new Map<string,typeof state.tasks>();
  for(const task of state.tasks){
    if(!task.signup)continue;
    const key=JSON.stringify([task.channelId,task.signup.scriptId]);
    const group=groups.get(key)??[];group.push(task);groups.set(key,group);
  }
  for(const tasks of groups.values()){
    const until=signupCircuitUntil(tasks[0].signup!.scriptId,tasks.map(task=>task.signup!),now);
    for(const task of tasks){
      if(task.signup?.humanReason!=='circuit_open'||task.status!=='needs_input'||unresolvedRegistration(task))continue;
      const scheduledAt=until??now.toISOString();
      Object.assign(task,taskTransition(task,{status:'queued',reasonCode:undefined,humanAction:undefined,checkpoint:'signup_resume',scheduledAt,nextCheckAt:scheduledAt,message:REGISTRATION_MESSAGES.platformDrift},now));
      task.signup={...task.signup,status:'running',humanReason:undefined,failure:undefined,updatedAt:now.toISOString()};
    }
    if(!until)continue;
    const failed=tasks.filter(task=>task.signup?.failure==='selector_missing'&&!unresolvedRegistration(task)).sort((a,b)=>Date.parse(b.signup!.updatedAt)-Date.parse(a.signup!.updatedAt));
    const representative=failed[0];if(!representative)continue;
    for(const task of failed){
      if(task.status!=='needs_input')continue;
      if(task===representative){
        Object.assign(task,taskTransition(task,{status:'needs_input',reasonCode:'human_required',humanAction:createHumanAction(task,{...task.humanAction,kind:'selector_drift',instruction:'selector_drift'}),message:REGISTRATION_MESSAGES.platformDrift},now));
      }else{
        Object.assign(task,taskTransition(task,{status:'failed',reasonCode:'temporary_failure',checkpoint:'signup_circuit',humanAction:undefined,message:REGISTRATION_MESSAGES.platformDrift},now));
      }
      task.cooldownUntil=until;
    }
    for(const task of state.tasks){
      if(task.channelId!==representative.channelId||task.status!=='queued')continue;
      const identity=state.accounts.find(account=>account.id===task.accountId);
      if(identity?.status==='registered'&&(!task.signup||task.signup.status==='done'))continue;
      if(Date.parse(task.scheduledAt)<Date.parse(until))task.scheduledAt=until;
    }
  }
}
