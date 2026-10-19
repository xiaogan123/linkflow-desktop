import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/main/store';
import {batch5LocalAccountId} from '../src/main/batch5-publication';
import {applyTemporaryRetryState,incrementalTaskCost,temporaryRetry,totalActualTaskCost} from '../src/main/temporary-retry';
import type {Site,Task} from '../src/shared/types';
import {validateBackup} from '../src/main/backup-validation';
import {clearOtherChannelInputs} from '../src/main/channel-inputs';

const NOW=new Date('2026-10-20T12:00:00Z');
test('channel input cleanup retains Agentboard subject only for Agentboard',()=>{
  assert.equal(Object.hasOwn(clearOtherChannelInputs('agentboard'),'agentboardSubject'),false);
  for(const destination of ['telegraph',undefined]){
    const patch=clearOtherChannelInputs(destination);
    assert.equal(Object.hasOwn(patch,'agentboardSubject'),true);assert.equal(patch.agentboardSubject,undefined);
    assert.equal(Object.hasOwn(patch,'agentboardInput'),true);assert.equal(patch.agentboardInput,undefined);
  }
});
function fixtureSite(siteId:string):Site{return {id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Guides',category:'software',language:'en',status:'ready',monthlyTarget:4,createdAt:'2026-09-01T00:00:00Z'}}
function fixture(stage:'registered'|'sending'='registered'){
  const store=new Store(':memory:'),siteId=randomUUID(),taskId=randomUUID(),accountId=batch5LocalAccountId('rant',siteId);
  const site=fixtureSite(siteId);
  const task:Task={id:taskId,siteId,channelId:'rant',sourceDomain:'rant.li',accountId,status:'running',createdAt:'2026-10-01T00:00:00Z',scheduledAt:'2026-10-20T10:00:00Z',updatedAt:'2026-10-20T10:00:00Z',attempts:2,temporaryRetryCount:2,message:'fixture',
    cost:{aiCalls:2,inputTokens:100,outputTokens:200,durationMs:3000,amount:.02,currency:'USD'},
    batch5Registration:{version:1,channelId:'rant',operationId:'example-operation',createdAt:'2026-10-01T00:00:00Z',stage,sendGuardVersion:1}};
  const identityKey=`batch5:identity:rant:${siteId}`,accountKey=`account:${accountId}`;
  store.setCipher(identityKey,'enc:example-journal');store.setCipher(accountKey,'enc:example-account');
  store.update(state=>{state.sites=[site];state.tasks=[task];state.accounts=[{id:accountId,channelId:'rant',username:'example-author',email:'owner@example.com',status:'registered',createdAt:'2026-10-01T00:00:00Z',registeredAt:'2026-10-01T00:00:00Z',hasPassword:true,credentialKind:'password'}]});
  return {store,siteId,taskId,accountId,identityKey,accountKey};
}

test('registered account journal stays on skipped task while an independent queued replacement inherits its budget',()=>{
  const f=fixture();try{
    const original=f.store.read().tasks[0],cipher=f.store.getCipher(f.identityKey),accountCipher=f.store.getCipher(f.accountKey);
    assert.equal(temporaryRetry(original,'temporary_failure',NOW),undefined,'unsafe in-place channel clearing is rejected');
    let outcome:ReturnType<typeof applyTemporaryRetryState>|undefined;
    assert.doesNotThrow(()=>f.store.update(state=>{outcome=applyTemporaryRetryState(state,f.taskId,'temporary_failure',NOW)}));
    assert.equal(outcome?.kind,'replaced');
    const state=f.store.read(),old=state.tasks.find(item=>item.id===f.taskId)!,replacement=state.tasks.find(item=>item.id===outcome?.taskId)!;
    assert.equal(state.tasks.length,2);assert.equal(old.status,'skipped');assert.equal(old.channelId,'rant');assert.equal(old.accountId,f.accountId);
    assert.deepEqual(old.batch5Registration,original.batch5Registration);assert.equal(f.store.getCipher(f.identityKey),cipher);assert.equal(f.store.getCipher(f.accountKey),accountCipher);
    assert.equal(old.replacementTaskId,replacement.id);assert.equal(replacement.replacesTaskId,old.id);
    assert.equal(replacement.status,'queued');assert.equal(replacement.channelId,'');assert.equal(replacement.accountId,undefined);assert.equal(replacement.batch5Registration,undefined);
    assert.deepEqual(replacement.failedPlatformIds,['rant']);assert.equal(replacement.cost?.aiCalls,2);assert.equal(replacement.scheduling?.month,'2026-10');
    assert.equal(incrementalTaskCost(replacement,state.tasks)?.aiCalls,0);assert.deepEqual(totalActualTaskCost(state.tasks),{aiCalls:2,durationMs:3000,inputTokens:100,outputTokens:200,amountsByCurrency:{USD:.02}});
    f.store.update(next=>{const value=next.tasks.find(item=>item.id===replacement.id)!;value.cost={aiCalls:3,inputTokens:150,outputTokens:250,durationMs:3500,amount:.03,currency:'USD'}});
    const total=totalActualTaskCost(f.store.read().tasks);
    assert.equal(total.aiCalls,3);assert.equal(total.inputTokens,150);assert.equal(total.amountsByCurrency.USD,.03);
    const before=f.store.read();f.store.update(next=>{outcome=applyTemporaryRetryState(next,f.taskId,'temporary_failure',NOW)});
    assert.equal(outcome?.kind,'already_replaced');assert.deepEqual(f.store.read(),before,'second invocation does not create another task');
  }finally{f.store.close()}
});

test('ambiguous registration stage cannot be switched or retried by the temporary failure helper',()=>{
  const f=fixture('sending');try{
    const before=f.store.read(),cipher=f.store.getCipher(f.identityKey);
    let outcome:ReturnType<typeof applyTemporaryRetryState>|undefined;
    f.store.update(state=>{outcome=applyTemporaryRetryState(state,f.taskId,'temporary_failure',NOW)});
    assert.equal(outcome?.kind,'blocked');assert.deepEqual(f.store.read(),before);assert.equal(f.store.getCipher(f.identityKey),cipher);
  }finally{f.store.close()}
});

test('ordinary switch without a registration summary keeps its task and gets scheduling metadata',()=>{
  const store=new Store(':memory:'),siteId=randomUUID(),taskId=randomUUID();try{
    store.update(state=>{state.sites=[fixtureSite(siteId)];state.tasks=[{id:taskId,siteId,channelId:'telegraph',sourceDomain:'telegra.ph',status:'running',createdAt:'2026-10-01T00:00:00Z',scheduledAt:NOW.toISOString(),updatedAt:NOW.toISOString(),attempts:2,temporaryRetryCount:2,message:'fixture'}]});
    let outcome:ReturnType<typeof applyTemporaryRetryState>|undefined;
    store.update(state=>{const task=state.tasks[0],since='2026-10-18T12:00:00.000Z',deadline='2026-10-20T12:00:00.000Z';Object.assign(task,{
      humanAction:{kind:'consent',since,deadline,instruction:'consent',url:'https://telegra.ph/',platform:'telegraph'},waitingSince:since,waitingDeadlineAt:deadline,waitingReminderAt:'2026-10-19T12:00:00.000Z',
      cooldownUntil:deadline,deferredAt:deadline,reviewUntil:deadline,reconcileAfter:deadline,
      emailWaitRegisteredAt:since,emailWait:{kind:'link',recipient:'owner@example.com',since,nextPollAt:since,expiresAt:deadline,consumedMessageIds:[],continuation:'browser'},
      emailConfirmation:{wait:{kind:'link',recipient:'owner@example.com',since,nextPollAt:since,expiresAt:deadline,consumedMessageIds:[],continuation:'browser'},messageId:'example-message'},
      temporaryPage:true,articleReviewMigration:{} as never,agentboardSubject:{} as never,
      carcinusInput:{} as never,synthfolkInput:{} as never,berrryInput:{} as never,agentboardInput:{} as never,swarmMemoInput:{} as never,agentriotInput:{} as never,agentHowInput:{} as never,agentsWikiInput:{} as never,agentsGatherInput:{} as never,
    });outcome=applyTemporaryRetryState(state,taskId,'temporary_failure',NOW)});
    assert.equal(outcome?.kind,'switched');const state=store.read();assert.equal(state.tasks.length,1);
    const switched=state.tasks[0];assert.equal(switched.channelId,'');assert.equal(switched.scheduling?.month,'2026-10');assert.deepEqual(switched.failedPlatformIds,['telegraph']);
    for(const field of ['humanAction','waitingSince','waitingDeadlineAt','waitingReminderAt','cooldownUntil','deferredAt','reviewUntil','reconcileAfter','emailWaitRegisteredAt','emailWait','emailConfirmation','signup','temporaryPage','articleReviewMigration','agentboardSubject','carcinusInput','synthfolkInput','berrryInput','agentboardInput','swarmMemoInput','agentriotInput','agentHowInput','agentsWikiInput','agentsGatherInput'] as const)assert.equal(switched[field],undefined,field);
    assert.doesNotThrow(()=>validateBackup({state,secrets:{}}));
  }finally{store.close()}
});

test('Carcinus and Synthfolk frozen inputs are removed inside the same durable replacement write',()=>{
  for(const channelId of ['carcinus','synthfolk'] as const){
    const store=new Store(':memory:'),siteId=randomUUID(),taskId=randomUUID();try{
      let outcome:ReturnType<typeof applyTemporaryRetryState>|undefined;
      assert.doesNotThrow(()=>store.update(state=>{const task:Task={id:taskId,siteId,channelId,sourceDomain:channelId==='carcinus'?'carcinus.org':'synthfolk.ai',status:'running',createdAt:'2026-10-01T00:00:00Z',scheduledAt:NOW.toISOString(),updatedAt:NOW.toISOString(),attempts:2,temporaryRetryCount:2,message:'fixture',...(channelId==='carcinus'?{carcinusInput:{} as never}:{synthfolkInput:{} as never})};state.sites=[fixtureSite(siteId)];state.tasks=[task];outcome=applyTemporaryRetryState(state,taskId,'temporary_failure',NOW)}));
      const saved=store.read().tasks[0];assert.equal(outcome?.kind,'switched');assert.equal(saved.channelId,'');assert.equal(saved.carcinusInput,undefined);assert.equal(saved.synthfolkInput,undefined);assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets:{}}));
    }finally{store.close()}
  }
});

test('durable signup and one-review ledgers keep their original task during platform replacement',()=>{
  for(const ledger of ['signup','oneReviewRetry'] as const){
    const store=new Store(':memory:'),siteId=randomUUID(),taskId=randomUUID(),accountId=randomUUID();try{
      store.update(state=>{
        state.sites=[fixtureSite(siteId)];state.accounts=ledger==='signup'?[{id:accountId,channelId:'telegraph',email:'owner@example.com',username:'fixture',status:'registered',hasPassword:false,createdAt:NOW.toISOString()}]:[];state.tasks=[{id:taskId,siteId,accountId:ledger==='signup'?accountId:undefined,channelId:'telegraph',sourceDomain:'telegra.ph',status:'running',
          createdAt:NOW.toISOString(),scheduledAt:NOW.toISOString(),updatedAt:NOW.toISOString(),attempts:3,temporaryRetryCount:2,message:'fixture',cost:{aiCalls:ledger==='oneReviewRetry'?2:3},
          ...(ledger==='signup'?{signup:{version:1,scriptId:'fixture',scriptVersion:1,identityId:accountId,stepIndex:1,status:'done',runtimeId:'fixture',updatedAt:NOW.toISOString(),aiLocateCalls:1,aiLocatedStepIds:['step']}}:
            {oneReviewRetry:{version:1,purpose:'independent_article_review',status:'granted',operationTokenHash:'a'.repeat(64),grantedAt:NOW.toISOString(),siteId,channelId:'telegraph',accountId:null,draftRevision:1,contentHash:'b'.repeat(64),contextHash:'c'.repeat(64),provider:'api',model:'fixture'}})}];
      });
      if(ledger==='oneReviewRetry')store.update(state=>{const value=state.tasks[0];value.cost={aiCalls:3};value.oneReviewRetry={...value.oneReviewRetry!,status:'consumed',consumedAt:NOW.toISOString()}});
      const original=store.read().tasks[0];assert.equal(temporaryRetry(original,'temporary_failure',NOW),undefined);
      let outcome:ReturnType<typeof applyTemporaryRetryState>|undefined;
      store.update(state=>{outcome=applyTemporaryRetryState(state,taskId,'temporary_failure',NOW)});
      const state=store.read(),old=state.tasks.find(value=>value.id===taskId)!,replacement=state.tasks.find(value=>value.id===outcome?.taskId)!;
      assert.equal(outcome?.kind,'replaced');assert.equal(state.tasks.length,2);assert.equal(old.status,'skipped');assert.equal(old.channelId,'telegraph');
      assert.deepEqual(old[ledger],original[ledger]);assert.equal(old.replacementTaskId,replacement.id);assert.equal(replacement.replacesTaskId,old.id);
      assert.equal(replacement.channelId,'');assert.equal(replacement.signup,undefined);assert.equal(replacement.oneReviewRetry,undefined);
      assert.equal(replacement.cost?.aiCalls,3);assert.equal(totalActualTaskCost(state.tasks).aiCalls,3);
      assert.doesNotThrow(()=>validateBackup({state,secrets:{}}));
      store.update(next=>{outcome=applyTemporaryRetryState(next,taskId,'temporary_failure',NOW)});
      assert.equal(outcome?.kind,'already_replaced');assert.equal(store.read().tasks.length,2);
    }finally{store.close()}
  }
});
