import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS} from '../src/integrations/catalog';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {claimPublicationExecution,taskPlatformIdentityAvailable} from '../src/main/planner';
import {emptyState} from '../src/main/store';
import type {Account,Site,Snapshot,Task} from '../src/shared/types';
import {channelReadinessForDisplay} from '../src/ui/presentation';

const at='2026-10-19T10:00:00.000Z';
const publishAt='2026-10-19T10:17:00.000Z';
const siteA='11111111-1111-4111-8111-111111111111';
const siteB='22222222-2222-4222-8222-222222222222';
const accountId='33333333-3333-4333-8333-333333333333';
const channel=CHANNELS.find(item=>item.id==='blogger')!;

function site(id:string,blogId:string):Site{return {id,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Original guides',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:at,blogger:{blogId,url:`https://${blogId}.blogspot.com/`}}}
function task(siteId=siteA):Task{return {id:'44444444-4444-4444-8444-444444444444',siteId,channelId:'blogger',accountId,sourceDomain:'blogger.com',status:'queued',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:''}}
function fixture(){
  const state=emptyState(),account:Account={id:accountId,channelId:'blogger',email:'owner@example.com',username:'google-subject',createdAt:at,status:'registered',hasPassword:true,credentialKind:'oauth',source:'imported'};
  state.settings.timezone='UTC';state.sites=[site(siteA,'100'),site(siteB,'200')];state.accounts=[account];
  state.accountBindings=[siteA,siteB].map((siteId,index)=>({id:`${index+5}5555555-5555-4555-8555-555555555555`,siteId,channelId:'blogger',accountId,createdAt:at,updatedAt:at}));
  return state;
}
function display(state:ReturnType<typeof fixture>,siteId:string){return channelReadinessForDisplay({...state,channels:[channel]} as unknown as Snapshot,state.sites.find(site=>site.id===siteId)!,channel)}

test('one Google OAuth identity may publish distinct Blogger blogs for two sites',()=>{
  const state=fixture();
  for(const id of [siteA,siteB]){
    assert.equal(channelExecutionReadiness(state,id,channel).kind,'ready');
    assert.equal(display(state,id),'ready');
  }
  const candidate=task();state.tasks=[candidate];
  assert.equal(taskPlatformIdentityAvailable(state,candidate,channel),true);
  assert.equal(claimPublicationExecution(state,candidate,new Date(publishAt),()=>0),true);
});

test('legacy duplicate blogId across sites requires handoff and cannot claim publication',()=>{
  const state=fixture();state.sites[1].blogger={...state.sites[1].blogger!,blogId:'100'};
  for(const id of [siteA,siteB]){
    assert.equal(channelExecutionReadiness(state,id,channel).kind,'handoff_required');
    assert.equal(display(state,id),'handoff_required');
  }
  const candidate=task();state.tasks=[candidate];
  assert.equal(taskPlatformIdentityAvailable(state,candidate,channel),false);
  assert.equal(claimPublicationExecution(state,candidate,new Date(publishAt),()=>0),false);
});

test('a historical Blogger task still reserves its blogId after the other site changes its current selection',()=>{
  const state=fixture(),historical=task(siteB);
  historical.id='55555555-5555-4555-8555-555555555555';
  historical.blogger={blogId:'100',operationId:'blogger-historical',contentHash:'a'.repeat(64),stage:'published'};
  historical.status='live';historical.firstLiveAt=at;state.tasks=[historical];
  assert.equal(channelExecutionReadiness(state,siteA,channel).kind,'handoff_required');
  assert.equal(display(state,siteA),'handoff_required');
  const candidate=task();state.tasks.push(candidate);
  assert.equal(taskPlatformIdentityAvailable(state,candidate,channel),false);
  assert.equal(claimPublicationExecution(state,candidate,new Date(publishAt),()=>0),false);
});

test('a blog two sites shared before stays with a site that has its own posts there once the other site moves on',()=>{
  const state=fixture();state.sites[1]={...state.sites[1],blogger:{...state.sites[1].blogger!,blogId:'100'}};
  state.tasks=[{...task(siteA),id:'66666666-6666-4666-8666-666666666666',blogger:{blogId:'100'} as Task['blogger']},{...task(siteB),id:'77777777-7777-4777-8777-777777777777',blogger:{blogId:'100'} as Task['blogger']}];
  // Both still bound to the shared blog: neither may start new posts there.
  assert.equal(channelExecutionReadiness(state,siteA,channel).kind,'handoff_required');
  // Site B picks its own blog; site A keeps the blog it has posted to, B's old posts notwithstanding.
  state.sites[1]={...state.sites[1],blogger:{...state.sites[1].blogger!,blogId:'200'}};
  assert.equal(channelExecutionReadiness(state,siteA,channel).kind,'ready');
  // A site with no posts there still cannot take a blog another site has posted to.
  state.sites[1]={...state.sites[1],blogger:{...state.sites[1].blogger!,blogId:'100'}};state.tasks=[state.tasks[0]];
  assert.equal(channelExecutionReadiness(state,siteB,channel).kind,'handoff_required');
});
