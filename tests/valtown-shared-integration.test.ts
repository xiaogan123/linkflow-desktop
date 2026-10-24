import assert from 'node:assert/strict';
import test from 'node:test';
import {CHANNELS} from '../src/integrations/catalog';
import {publisherFor} from '../src/integrations/publishers';
import {channelExecutionReadiness,unbindAccount} from '../src/main/account-bindings';
import {emptyState} from '../src/main/store';
import {VALTOWN_IPC_COMMANDS,type Account,type Site,type Task} from '../src/shared/types';
import {connectionOverview,isValTownConnectionAccount} from '../src/ui/channel-connections';
import {channelAutomationKind,channelAutomationView} from '../src/ui/channel-automation';
import {channelOnboardingView} from '../src/ui/channel-onboarding';

const at='2026-10-24T10:00:00.000Z',siteId='11111111-1111-4111-8111-111111111111',accountId='22222222-2222-4222-8222-222222222222',bindingId='33333333-3333-4333-8333-333333333333',hash='a'.repeat(64);
const site={id:siteId,domain:'docs.example.com',url:'https://docs.example.com/',email:'editor@example.com',name:'Docs',description:'Software documentation',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:at} as Site;
const account:Account={id:accountId,channelId:'valtown',email:'',username:'fixtureuser',displayName:'fixtureuser',credentialKind:'api_token',status:'registered',hasPassword:true,source:'imported',createdAt:at,updatedAt:at,registeredAt:at,verifiedAt:at,valtown:{version:1,stage:'ready',ownerIdHash:hash,username:'fixtureuser',tier:'free',tokenFingerprint:'b'.repeat(64),valRead:'confirmed',valWrite:'not_proven_by_read_api',tokenExpiry:'not_exposed_by_api',checkedAt:at}};

test('shared catalog, publisher, IPC and onboarding maps expose a connected-only Val Town path without claiming automatic signup',()=>{const channel=CHANNELS.find(value=>value.id==='valtown');assert.ok(channel);
  // Off by default until a real reviewed draft publishes end to end; the connected path stays intact.
  assert.equal(channel.enabled,false);assert.equal(channel.free,'yes');assert.equal(channel.emailRequired,false);assert.ok(publisherFor(channel));assert.deepEqual(VALTOWN_IPC_COMMANDS,['account:connect-valtown']);assert.equal(channelAutomationKind(channel),'disabled');assert.equal(channelAutomationKind({...channel,enabled:true}),'connected_auto');assert.match(channelAutomationView({...channel,enabled:true}).setup??'',/本人|token/);const onboarding=channelOnboardingView(channel);assert.equal(onboarding.kind,'existing_account');assert.match(onboarding.setup,/Google 登录或人机验证/);assert.match(channel.notes,/完成前不宣称/);assert.doesNotMatch(channel.notes,/已完成.*验收/)});

test('verified Free personal account is ready only through its exact site binding and pending intent pins that binding',()=>{const channel=CHANNELS.find(value=>value.id==='valtown')!,state=emptyState();state.sites=[site];state.accounts=[account];state.accountBindings=[{id:bindingId,siteId,channelId:'valtown',accountId,createdAt:at,updatedAt:at}];assert.equal(isValTownConnectionAccount(account),true);assert.equal(channelExecutionReadiness(state,siteId,channel,accountId).kind,'ready');const task:Task={id:'44444444-4444-4444-8444-444444444444',siteId,channelId:'valtown',accountId,sourceDomain:'val.town',status:'review',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'pending',submittedAt:at,checkpoint:'valtown_val_submitting',valtown:{version:1,accountId,valName:'Docs_44444444',sourceHash:hash,htmlHash:'c'.repeat(64),targetUrlHash:'d'.repeat(64),ownerHash:'e'.repeat(64),createdAt:at,stage:'val_submitting'}};state.tasks=[task];assert.throws(()=>unbindAccount(state,accountId,siteId,'valtown'),/待检查/);assert.equal(state.accountBindings.length,1)});

test('connection overview reports the imported Val Town identity as connected and bound',()=>{const channel=CHANNELS.find(value=>value.id==='valtown')!,state=emptyState();state.sites=[site];state.accounts=[account];state.accountBindings=[{id:bindingId,siteId,channelId:'valtown',accountId,createdAt:at,updatedAt:at}];const row=connectionOverview({...state,channels:[{...channel,enabled:true}]}).find(value=>value.id==='valtown');assert.equal(row?.state,'connected');assert.equal(row?.connectedCount,1);assert.equal(row?.boundSiteCount,1)});
