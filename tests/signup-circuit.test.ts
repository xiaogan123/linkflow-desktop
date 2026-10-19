import test from 'node:test';
import assert from 'node:assert/strict';
import {maintainSignupCircuits} from '../src/main/signup-circuit';
import {createHumanAction} from '../src/shared/human-action';
import type {Task} from '../src/shared/types';
import type {SignupTaskState} from '../src/shared/signup';

const now=new Date('2026-10-18T00:00:00.000Z');
function signup(id:string,offset:number):SignupTaskState{return {version:1,scriptId:'mock-local-signup',scriptVersion:1,identityId:id,stepIndex:2,status:'human',runtimeId:'runtime',updatedAt:new Date(now.getTime()-offset*1000).toISOString(),aiLocateCalls:0,aiLocatedStepIds:[],humanReason:'selector_drift',failure:'selector_missing'};}
function task(id:string,state?:SignupTaskState):Task{
  const base={id,siteId:'site',channelId:'mock-local',sourceDomain:'example.com',status:state?'needs_input':'queued',createdAt:now.toISOString(),scheduledAt:now.toISOString(),updatedAt:now.toISOString(),attempts:0,message:'fixture',recoveryAttempts:0,signup:state,reasonCode:state?'human_required':undefined} as Task;
  if(state)base.humanAction=createHumanAction(base,{kind:'selector_drift'},now);
  return base;
}

test('selector circuit preserves an unresolved registration intent and defers queued work',()=>{
  const failures=[0,1,2].map(offset=>task(`selector-${offset}`,signup(`identity-${offset}`,offset)));
  const unresolvedState={...signup('unresolved',5),humanReason:'irreversible_unknown' as const,failure:'execution_failed' as const,irreversible:{stepId:'submit',at:new Date(now.getTime()-5000).toISOString()}};
  const unresolved=task('unresolved',unresolvedState),queued=task('queued');
  const originalAction=unresolved.humanAction;
  const state={tasks:[...failures,unresolved,queued],accounts:[]};
  maintainSignupCircuits(state,now);
  assert.equal(unresolved.status,'needs_input');assert.deepEqual(unresolved.humanAction,originalAction);
  assert.equal(unresolved.signup?.humanReason,'irreversible_unknown');assert.equal(unresolved.signup?.irreversible?.completed,undefined);
  assert.equal(queued.scheduledAt,'2026-10-25T00:00:00.000Z');
  assert.equal(failures.filter(item=>item.status==='needs_input').length,1);
});

test('legacy circuit human card returns to the queue until the circuit expires',()=>{
  const failures=[0,1,2].map(offset=>task(`selector-${offset}`,signup(`identity-${offset}`,offset)));
  const legacy=task('legacy',{...signup('legacy',4),humanReason:'circuit_open',failure:undefined});
  const state={tasks:[...failures,legacy],accounts:[]};
  maintainSignupCircuits(state,now);
  assert.equal(legacy.status,'queued');assert.equal(legacy.humanAction,undefined);
  assert.equal(legacy.signup?.humanReason,undefined);assert.equal(legacy.scheduledAt,'2026-10-25T00:00:00.000Z');
});

test('a registration already submitted retains its human stop when a later selector drifts',()=>{
  const failures=[0,1,2].map(offset=>task(`selector-${offset}`,signup(`identity-${offset}`,offset)));
  const submittedState={...signup('submitted',4),irreversible:{stepId:'submit',at:now.toISOString(),completed:true as const}};
  const submitted=task('submitted',submittedState),originalAction=submitted.humanAction;
  const state={tasks:[...failures,submitted],accounts:[]};
  maintainSignupCircuits(state,now);
  assert.equal(submitted.status,'needs_input');assert.deepEqual(submitted.humanAction,originalAction);
  assert.equal(submitted.signup?.irreversible?.completed,true);
});
