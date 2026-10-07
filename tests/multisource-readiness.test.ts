import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS} from '../src/integrations/catalog';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {makePlan} from '../src/main/planner';
import {emptyState} from '../src/main/store';
import {channelReadinessForDisplay} from '../src/ui/presentation';
import type {AccountStatus,Site,Snapshot} from '../src/shared/types';

const stamp='2026-10-07T00:00:00.000Z';
const now=new Date(stamp);
const nostr=CHANNELS.find(channel=>channel.id==='nostr')!;

function fixture(accountStatus:AccountStatus){
  const state=emptyState();
  const site:Site={id:'site-a',domain:'a.example.com',url:'https://a.example.com',email:'owner@example.com',name:'Example A',description:'Original educational guides',category:'content',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:stamp,topics:[{url:'https://a.example.com/guides/verification',discoveredAt:stamp}]};
  const other:Site={...site,id:'site-b',domain:'b.example.com',url:'https://b.example.com'};
  const account={id:'nostr-account',channelId:'nostr',email:site.email,username:'a'.repeat(64),createdAt:stamp,status:accountStatus,hasPassword:true,credentialKind:'api_token' as const,source:'generated' as const};
  state.settings.timezone='UTC';state.settings.autoRun=true;
  state.sites=[site,other];state.accounts=[account];
  state.accountBindings=[{id:'binding-b',siteId:other.id,channelId:'nostr',accountId:account.id,createdAt:stamp,updatedAt:stamp}];
  const snapshot:Snapshot={...state,channels:[nostr],runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:true,version:'test',platform:'test',dataPath:'',aiCallsToday:0}};
  return {state,site,account,snapshot};
}

for(const status of ['registered','restricted'] as const){
  test(`unbound Nostr site creates its own identity despite another same-email ${status} account`,()=>{
    const {state,site,snapshot}=fixture(status);
    assert.equal(channelExecutionReadiness(state,site.id,nostr).kind,'autocreate');
    assert.equal(channelReadinessForDisplay(snapshot,site,nostr),'autocreate');
    const [task]=makePlan(state,site,[{channel:nostr,score:100,reason:'qualified'}],now);
    assert.ok(task);
    assert.equal(task.accountId,undefined);
    assert.equal(task.channelId,'nostr');
  });

  test(`explicit Nostr binding retains ${status} identity readiness in display and planner`,()=>{
    const {state,site,account,snapshot}=fixture(status);
    state.accountBindings.push({id:'binding-a',siteId:site.id,channelId:'nostr',accountId:account.id,createdAt:stamp,updatedAt:stamp});
    const expected=status==='registered'?'ready':'handoff_required';
    assert.equal(channelExecutionReadiness(state,site.id,nostr).kind,expected);
    assert.equal(channelReadinessForDisplay(snapshot,site,nostr),expected);
    const tasks=makePlan(state,site,[{channel:nostr,score:100,reason:'qualified'}],now);
    if(status==='registered')assert.equal(tasks[0]?.accountId,account.id);
    else assert.deepEqual(tasks,[]);
  });
}
