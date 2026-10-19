import test from 'node:test';
import assert from 'node:assert/strict';
import {decorateManagedDraft,profileDraftInstruction,managedPublicationSite} from '../src/main/draft-contract';
import {ensureWritingProfile} from '../src/shared/writing-profile';
import {CHANNELS} from '../src/integrations/catalog';
import {socialDraftError} from '../src/shared/social-content';
import {raindropDraftError} from '../src/shared/raindrop-content';
import {agentHowDraftError} from '../src/integrations/agenthow-publisher';
import {txtsbsDraftError} from '../src/integrations/txtsbs-publisher';
import {agentsGatherDraftError,agentsGatherPublisherTesting} from '../src/integrations/agentsgather-publisher';
import {swarmMemoDraftError} from '../src/integrations/swarmmemo-publisher';
import {SWARMMEMO_DISCLOSURE} from '../src/integrations/swarmmemo';
import {DRAFT_CONTRACT_PUBLIC_MESSAGES} from '../src/main/draft-contract-messages';
import {fixtureTerms} from './writing-fixture';
import type {Site,Task} from '../src/shared/types';
const site:Site={id:'site',domain:'example.com',url:'https://example.com/',name:'Example',description:'Technical guidance',email:'owner@example.com',language:'en',category:'developer',status:'ready',monthlyTarget:2,createdAt:'2026-10-01T10:17:00Z'};
site.writingProfile=ensureWritingProfile(site,[]);
function task(channelId:string):Task{return {id:'task',siteId:site.id,channelId,sourceDomain:CHANNELS.find(channel=>channel.id===channelId)!.domain,topicUrl:'https://example.com/guide',createdAt:site.createdAt,scheduledAt:site.createdAt,updatedAt:site.createdAt,status:'queued',attempts:0,message:''}}
const draft={title:'Working with source material',description:'Documenting sources and their boundaries',body:'A reader can record the source and compare its wording before relying on a statement. The documentation describes its scope.'};
test('social and structured-source publishers get a complete program-composed envelope',()=>{
 for(const id of ['bluesky','raindrop','agenthow']){
  const channel=CHANNELS.find(value=>value.id===id)!;const current=task(id);const raw=id==='bluesky'?{...draft,body:'Keep source wording available.'}:draft;
  const prepared=decorateManagedDraft(raw,site,channel,current);assert.ok(prepared.envelope);assert.ok(prepared.draft.body.includes(prepared.envelope.disclosure));
  if(id==='bluesky')assert.equal(socialDraftError({...current,draft:prepared.draft},site,channel),undefined,prepared.draft.body);
  if(id==='raindrop')assert.equal(raindropDraftError(prepared.draft),undefined);
  if(id==='agenthow')assert.equal(agentHowDraftError({...current,draft:prepared.draft},site),undefined);
 }
});
test('HTML fragment publishers get one escaped native target link before review',()=>{
 const channel=CHANNELS.find(value=>value.id==='txtsbs')!,current=task(channel.id);
 const prepared=decorateManagedDraft({...draft,body:'<h2>Sources</h2><p>'+draft.body.repeat(5)+'</p>'},site,channel,current);
 assert.equal(txtsbsDraftError({...current,draft:prepared.draft},site),undefined);
 assert.equal((prepared.draft.body.match(/href=/g)??[]).length,1);assert.ok(prepared.draft.body.includes('<p>Example</p>'));
});
test('local rewrites reuse the saved final envelope without mutation or nested decoration',()=>{
 for(const id of ['agentsgather','swarmmemo','txtsbs','berrry']){
  const channel=CHANNELS.find(value=>value.id===id)!,current=task(id);
  const raw=id==='berrry'?{...draft,body:'<!doctype html><html><body><p>Source material</p></body></html>'}:draft;
  const first=decorateManagedDraft(raw,site,channel,current),before=structuredClone(first.envelope);
  const second=decorateManagedDraft(raw,site,channel,{...current,writingEnvelope:first.envelope});
  assert.deepEqual(first.envelope,before,id);assert.deepEqual(second,first,id);
 }
});
test('AgentsGather retains a site-specific opening identity while placing the site disclosure at the reviewed end',()=>{
 const base=CHANNELS.find(value=>value.id==='agentsgather')!;
 const channel={...base,termsCache:{...fixtureTerms(base),disclosurePlacement:'end' as const}};
 const text={...draft,body:draft.body.repeat(4)};
 const first=decorateManagedDraft(text,site,channel,task('agentsgather'));
 const other:Site={...site,id:'other-site',name:'Other Research',domain:'other.example.net',url:'https://other.example.net/',writingProfile:undefined};
 other.writingProfile=ensureWritingProfile(other,[site]);
 const second=decorateManagedDraft(text,other,channel,{...task('agentsgather'),id:'other-task',siteId:other.id,topicUrl:'https://other.example.net/guide'});
 const leading=(body:string)=>body.split(/\n\s*\n/,1)[0];
 // Each site keeps one of several wordings; every wording passes the platform's disclosure rule.
 for(const body of [first.draft.body,second.draft.body])assert.equal(agentsGatherPublisherTesting.disclosure(body),true);
 assert.ok(leading(first.draft.body).startsWith('Disclosure:')&&leading(first.draft.body).includes(site.domain));
 assert.notEqual(leading(first.draft.body),leading(second.draft.body));
 assert.equal(first.draft.body.trimEnd().split(/\n\s*\n/).at(-1),first.envelope!.disclosure.split(/\n\s*\n/).at(-1));
 assert.equal(agentsGatherDraftError({...task('agentsgather'),draft:first.draft},site),undefined);
 assert.deepEqual(decorateManagedDraft(text,site,channel,{...task('agentsgather'),writingEnvelope:first.envelope}),first);
});
test('new SwarmMemo drafts disclose the distinct site identity in every program-added sentence',()=>{
 const channel=CHANNELS.find(value=>value.id==='swarmmemo')!,text={...draft,body:draft.body.repeat(5)};
 const other:Site={...site,id:'second-site',name:'Second Research',domain:'second.example.net',url:'https://second.example.net/',writingProfile:undefined};
 other.writingProfile=ensureWritingProfile(other,[site]);
 const current={...task('swarmmemo'),topicUrl:undefined},secondTask={...task('swarmmemo'),id:'second-task',siteId:other.id,topicUrl:undefined};
 const first=decorateManagedDraft(text,site,channel,current),second=decorateManagedDraft(text,other,channel,secondTask);
 const firstIdentity=DRAFT_CONTRACT_PUBLIC_MESSAGES.swarmMemoIdentity(site.name,site.domain);
 const secondIdentity=DRAFT_CONTRACT_PUBLIC_MESSAGES.swarmMemoIdentity(other.name,other.domain);
 assert.notEqual(firstIdentity,secondIdentity);
 assert.ok(firstIdentity.includes(site.name)&&firstIdentity.includes(site.domain));
 assert.ok(secondIdentity.includes(other.name)&&secondIdentity.includes(other.domain));
 for(const [value,local,currentTask,identity] of [[first,site,current,firstIdentity],[second,other,secondTask,secondIdentity]] as const){
  assert.ok(value.envelope!.disclosure.startsWith(identity+'\n\n'));
  assert.equal(value.draft.body.split(identity).length-1,1);
  assert.ok(!value.draft.body.includes(SWARMMEMO_DISCLOSURE));
  assert.equal(swarmMemoDraftError({...currentTask,draft:value.draft},local),undefined,value.draft.body);
 }
 assert.ok(swarmMemoDraftError({...current,draft:{...first.draft,body:first.draft.body.replace(firstIdentity,secondIdentity)}},site));
});
test('an English-only publisher receives English disclosure and risk for a Chinese site',()=>{
 const local:Site={...site,language:'zh',writingProfile:undefined};local.writingProfile=ensureWritingProfile(local,[]);
 const channel={...CHANNELS.find(value=>value.id==='agentsgather')!,languages:['en']};
 const result=decorateManagedDraft(draft,local,channel,task(channel.id));
 assert.ok(!/[\p{Script=Han}]/u.test(result.envelope!.disclosure+result.envelope!.risk));
 assert.ok(result.envelope!.signature===site.name);
});
test('home versus article ratio controls the exact legacy publication target without changing the evidence topic',()=>{
 for(const id of ['telegraph','github-gist'])for(const homeLinkRatio of [0,1]){
  const local={...site,writingProfile:{...site.writingProfile!,homeLinkRatio}},current=task(id),channel=CHANNELS.find(value=>value.id===id)!;
  const managed=decorateManagedDraft(draft,local,channel,current),expected=homeLinkRatio?site.url:current.topicUrl;
  assert.equal(managed.envelope!.targetUrl,expected);
  assert.equal(managedPublicationSite(local,{...current,writingEnvelope:managed.envelope}).url,expected);
  assert.equal(current.topicUrl,'https://example.com/guide');assert.equal(local.url,site.url);
 }
});
test('format-specific instructions preserve mechanical constraints without example disclosure sentences',()=>{
 for(const id of ['leaflet','nextgen-slides','betterthanhtml','agentriot','berrry']){
  const channel=CHANNELS.find(value=>value.id===id)!;const instruction=profileDraftInstruction(site,channel,task(id),'tutorial');
  assert.ok(instruction.includes('facts'));assert.ok(instruction.includes('不得写邀请码'));assert.ok(!instruction.includes('核验'));assert.ok(!instruction.includes('本文由'));
 }
});
