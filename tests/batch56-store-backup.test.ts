import assert from 'node:assert/strict';
import test from 'node:test';
import {CHANNELS} from '../src/integrations/catalog';
import {validateBackup} from '../src/main/backup-validation';
import {claimChannelTrial} from '../src/main/channel-trials';
import {mailConsumptionIds} from '../src/main/email-waits';
import {Store} from '../src/main/store';
import type {Task} from '../src/shared/types';

const at='2026-10-18T00:00:00.000Z';
const siteId='11111111-1111-4111-8111-111111111111';
const trialTaskId='22222222-2222-4222-8222-222222222222';
const mailTaskId='33333333-3333-4333-8333-333333333333';
const trialChannel=CHANNELS.find(channel=>channel.id==='yeetmd')!;
const mailChannel=CHANNELS.find(channel=>channel.id==='bluesky')!;
const recipient='owner@example.com';

function task(id:string,channelId:string,sourceDomain:string,partial:Partial<Task>={}):Task{
  return {id,siteId,channelId,sourceDomain,status:'running',createdAt:at,updatedAt:at,scheduledAt:at,attempts:1,message:'fixture',...partial};
}

test('one cipher transaction settles a channel trial and a mail wait, and both survive backup validation',()=>{
  const store=new Store(':memory:');
  try{
    store.update(state=>{
      state.settings.appearance='dark';
      state.sites=[{id:siteId,domain:'example.com',url:'https://example.com/',email:recipient,name:'Example',description:'Fixture',category:'general',language:'en',monthlyTarget:1,status:'ready',createdAt:at}];
      state.tasks=[
        task(trialTaskId,trialChannel.id,trialChannel.domain),
        task(mailTaskId,mailChannel.id,mailChannel.domain,{
          status:'needs_input',checkpoint:'waiting_email',attempts:0,
          emailWait:{kind:'link',recipient,since:at,nextPollAt:'2026-10-18T00:01:00.000Z',expiresAt:'2026-10-18T01:00:00.000Z',consumedMessageIds:['used-message'],continuation:'browser'},
        }),
      ];
      assert.equal(claimChannelTrial(state,trialChannel,state.tasks[0]),true);
    });
    assert.equal(store.read().settings.channelTrials?.yeetmd.activeTaskId,trialTaskId);
    assert.equal(store.read().tasks[1].emailWaitRegisteredAt,at);
    const waitingBackup=validateBackup({state:store.read(),secrets:{}}).state;
    assert.equal(waitingBackup.tasks[1].emailWait?.since,at);
    assert.equal(waitingBackup.settings.channelTrials?.yeetmd.activeTaskId,trialTaskId);
    store.setCipher(`signup:${mailTaskId}:email`,'synthetic-email-delivery');

    store.updateWithCiphers(state=>{
      Object.assign(state.tasks[0],{status:'failed',reasonCode:'platform_rejected',trialFailure:'fixture rejection'});
      Object.assign(state.tasks[1],{status:'skipped',reasonCode:'user_skipped'});
    },{});

    const saved=store.read();
    assert.equal(saved.settings.channelTrials?.yeetmd.failures,1);
    assert.equal(saved.settings.channelTrials?.yeetmd.activeTaskId,undefined);
    assert.equal(saved.tasks[1].emailWait,undefined);
    assert.equal(saved.tasks[1].emailWaitRegisteredAt,at);
    assert.deepEqual(mailConsumptionIds(saved,mailChannel.id,recipient),['used-message']);
    assert.equal(store.getCipher(`signup:${mailTaskId}:email`),undefined);

    const restored=validateBackup({state:saved,secrets:{}}).state;
    assert.equal(restored.settings.appearance,'dark');
    assert.deepEqual(restored.settings.channelTrials,saved.settings.channelTrials);
    assert.deepEqual(restored.emailConsumptions,saved.emailConsumptions);
    assert.equal(restored.tasks[1].emailWaitRegisteredAt,at);
    const badTrial=structuredClone(saved);
    badTrial.settings.channelTrials!.yeetmd.failures=-1;
    assert.throws(()=>validateBackup({state:badTrial,secrets:{}}));
  }finally{store.close()}
});
