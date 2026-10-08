import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS} from '../src/integrations/catalog';
import {channelAutomationKind,channelAutomationView} from '../src/ui/channel-automation';
import {connectionOverview} from '../src/ui/channel-connections';
import {channelReadinessForDisplay,taskHasSubmissionEvidence,taskHasUnconfirmedSubmission} from '../src/ui/presentation';
import type {Account,Site,Snapshot,Task} from '../src/shared/types';
const at='2026-10-08T00:00:00.000Z';
const site:Site={id:'site',domain:'example.test',url:'https://example.test/',email:'owner@example.test',name:'Example',description:'Research methods',language:'en',category:'education',monthlyTarget:2,status:'ready',createdAt:at};
const snap=()=>({sites:[site],tasks:[],accounts:[],accountBindings:[],channels:CHANNELS} as unknown as Snapshot);
const channel=(id:string)=>({...CHANNELS.find(c=>c.id===id)!,enabled:true});
test('anonymous publishers distinguish enabled software capability from incomplete live acceptance',()=>{
  for(const id of ['rentry','lucid-page']){
    assert.equal(channelAutomationKind(channel(id)),'ai_auto');
    assert.equal(channelAutomationKind({...channel(id),enabled:false}),'disabled');
    const s=snap();s.channels=s.channels.map(c=>({...c,enabled:c.id!==id}));
    assert.equal(connectionOverview(s).find(r=>r.id===id)?.state,'unavailable');
    s.channels=s.channels.map(c=>c.id===id?{...c,enabled:true}:c);
    assert.equal(connectionOverview(s).find(r=>r.id===id)?.state,'no_setup');
  }
  assert.match(channelAutomationView(channel('lucid-page')).setup??'',/修改或删除需先认领/);
});
test('Rentry needs no manual registration but never hides a revoked or damaged local key',()=>{
  const s=snap();assert.equal(channelReadinessForDisplay(s,site,channel('rentry')),'autocreate');
  const a:Account={id:'key',channelId:'rentry',username:'anonymous',email:'',source:'generated',status:'registered',credentialKind:'api_token',hasPassword:true,createdAt:at};
  s.accounts=[a];assert.equal(channelReadinessForDisplay(s,site,channel('rentry')),'ready');
  a.rentryExcludedSiteIds=[site.id];assert.equal(channelReadinessForDisplay(s,site,channel('rentry')),'handoff_required');
  a.rentryExcludedSiteIds=[];a.hasPassword=false;assert.equal(channelReadinessForDisplay(s,site,channel('rentry')),'handoff_required');
});
test('Lucid never routes an account-free task into an account import flow',()=>{
  assert.equal(channelReadinessForDisplay(snap(),site,channel('lucid-page')),'ready');
});
test('anonymous publication intents remain visible as unconfirmed submissions',()=>{
  for(const id of ['rentry','lucid-page']){
    const t={id:'task',channelId:id,siteId:site.id,sourceDomain:channel(id).domain,status:'needs_input',createdAt:at,scheduledAt:at,updatedAt:at,attempts:1,message:'pending',...(id==='rentry'?{rentry:{slug:'lf-'+ 'a'.repeat(32)+'-'+ 'b'.repeat(12),contentHash:'b'.repeat(64),stage:'submitting'}}:{lucid:{contentHash:'b'.repeat(64),stage:'submitting'}})} as Task;
    assert.equal(taskHasSubmissionEvidence(t),true);assert.equal(taskHasUnconfirmedSubmission(t),true);
    t.publicUrl='https://'+channel(id).domain+'/original';assert.equal(taskHasUnconfirmedSubmission(t),false);
  }
});
