import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS} from '../src/integrations/catalog';
import {channelAudience,eligibilityFor} from '../src/integrations/eligibility';
import {channelDiscoveryFor} from '../src/integrations/channel-discovery';
import {countFinanceAutomaticPlatforms} from '../src/shared/channel-metrics';
import {saveCustomChannel} from '../src/integrations/channel-library';
import {emptyState} from '../src/main/store';
import {runtimeFinancePlatformCount,schedulableTaskMatches} from '../src/main/planner';
import {matchChannels} from '../src/integrations/catalog';
import type {Channel,Site} from '../src/shared/types';

const site:Site={id:'site',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'独立金融风险科普',category:'finance',language:'zh-hans',monthlyTarget:3,status:'ready',createdAt:'2026-10-18'};
const channel=(id:string)=>CHANNELS.find(value=>value.id===id)!;

test('static finance directory metric is an explicitly scoped capability count',()=>{
 const count=countFinanceAutomaticPlatforms(site,CHANNELS);
 const groups=count.groupedChannelIds!;
 assert.deepEqual(Object.keys(groups),['no_signup','auto_account','email_auto','one_time_verification','connected_auto','wallet_login','manual_publish','ineligible']);
 const grouped=Object.values(groups).flat();
 assert.equal(grouped.length,CHANNELS.length,'every channel has exactly one top-level class');
 assert.deepEqual(new Set(grouped),new Set(CHANNELS.map(value=>value.id)));
 assert.ok(groups.one_time_verification.includes('html-app'));
 assert.ok(groups.one_time_verification.includes('paper-wf'));
 assert.ok(groups.auto_account.includes('rant'));
 assert.equal(groups.email_auto.includes('rant'),false);
 assert.ok(groups.auto_account.includes('telegraph'));
 assert.ok(groups.connected_auto.includes('hackmd'));
 assert.ok(groups.ineligible.includes('agentsgather'),'site-ineligible channels remain visible');
 assert.equal(count.trialCount,11);
 assert.equal(count.acceptedCount,0,'catalog status is not proof of an accepted publication');
 assert.equal(count.pendingAcceptanceCount,7);
 assert.equal(count.count,count.channelIds.length);
 assert.ok(count.count>=15);
 assert.equal(count.channelIds.includes('whitewind'),false);
 assert.equal(count.channelIds.includes('slopit'),false);
 assert.equal(count.channelIds.includes('paper-wf'),false,'known registration challenge requires an existing connection');
 for(const id of ['txtsbs','pastyx','totpage','markdownpaste','mdshare','slugpost','tantive'])assert.equal(count.channelIds.includes(id),false,id);
 for(const id of ['pstrs','yourwebs','brewpage','nextgen-slides'])assert.ok(count.temporaryIds.includes(id),id);
 assert.ok(count.connectionRequiredIds.includes('hackmd'));
 assert.ok(count.confirmationRequiredIds?.includes('html-app'),'public notice acknowledgement is a human prerequisite');
 assert.ok(count.verificationRequiredIds?.includes('paper-wf'),'Paper.wf first registration requires human verification');
});

test('real registry and account readiness narrow the pure capability count',()=>{
 const count=countFinanceAutomaticPlatforms(site,CHANNELS,{supported:value=>['yeetmd','hackmd'].includes(value.id),readiness:value=>value.id==='hackmd'?'handoff_required':'ready'});
 assert.deepEqual(count.channelIds,['yeetmd']);
 assert.deepEqual(count.connectionRequiredIds,['hackmd']);
 const connected=countFinanceAutomaticPlatforms(site,CHANNELS,{supported:value=>value.id==='hackmd',readiness:()=> 'ready'});
 assert.deepEqual(connected.channelIds,['hackmd']);
 assert.equal(countFinanceAutomaticPlatforms({...site,category:'software'},CHANNELS).count,0);
});

test('finance repeatable projection follows the same-site scheduler through trial occupancy and promotion',()=>{
 const state=emptyState(),first={...site,topics:[{url:'https://example.com/guide',discoveredAt:'2026-10-18T00:00:00.000Z'}]},second={...first,id:'site-two',domain:'example-site.com',url:'https://example-site.com/',email:'owner@example-site.com',topics:[{url:'https://example-site.com/guide',discoveredAt:'2026-10-18T00:00:00.000Z'}]};
 state.sites=[first,second];state.settings.timezone='UTC';
 const now=new Date('2026-10-20T12:17:00.000Z');
 const snapshot=(value:Site)=>{
  const task={id:`reservation-${value.id}`,siteId:value.id,channelId:'',sourceDomain:'',status:'queued' as const,createdAt:now.toISOString(),updatedAt:now.toISOString(),scheduledAt:now.toISOString(),attempts:0,message:'fixture'};
  const ids=new Set(schedulableTaskMatches(state,task,matchChannels(value,CHANNELS),now).map(item=>item.match.channel.id));
  const counted=runtimeFinancePlatformCount(state,value,CHANNELS,now);
  const projected=runtimeFinancePlatformCount(state,value,CHANNELS,now,{
    matches:matchChannels(value,CHANNELS),
    acceptedChannelIds:new Set(state.tasks.filter(task=>task.firstLiveAt&&task.linkCheck==='found'&&task.linkIndexable===true).map(task=>task.channelId)),
  });
  assert.deepEqual(projected,counted,'snapshot reuse preserves the scheduler projection exactly');
  return {ids,counted};
 };
 const {ids:firstIds,counted:firstCount}=snapshot(first);
 const expectedFirstIds=['yeetmd','markdownpage','rant','thethings','memorywiki','katbin','pastemyst','deed-page','markdrop','draftmark','docs-md','supanote','betterthanhtml','lucid-page','verbose','mataroa','nostr','telegraph'];
 assert.ok(firstIds.has('yeetmd'));
 assert.equal(firstIds.has('html-app'),false);
 assert.equal(firstIds.has('paper-wf'),false);
 assert.deepEqual(new Set(firstCount.runtimeSchedulableIds),firstIds);
 const grouped=Object.values(firstCount.groupedChannelIds!).flat();
 assert.equal(grouped.length,CHANNELS.length,'runtime inventory retains disabled and unsuitable channels');
 assert.deepEqual(new Set(grouped),new Set(CHANNELS.map(value=>value.id)));
 assert.deepEqual(new Set(firstCount.channelIds),new Set(expectedFirstIds));
 assert.equal(firstCount.count,18,'the initial finance site has eighteen automatic repeatable platforms');
 assert.deepEqual(new Set(firstCount.channelIds),firstIds,'the no-human count equals the complete actual automatic scheduler set');
 assert.deepEqual(firstCount.confirmationRequiredIds,['html-app']);
 assert.deepEqual(firstCount.verificationRequiredIds,['paper-wf']);
 assert.equal(firstCount.acceptedCount,0);
 assert.equal(firstCount.pendingAcceptanceCount,7);
 assert.equal(firstCount.runtimeSchedulableIds.includes('txtsbs'),false);
 assert.equal(firstCount.runtimeSchedulableIds.includes('pastyx'),false);
 state.settings.channelTrials={yeetmd:{trial:true,activeTaskId:'trial-first',failures:0,evaluatedTaskIds:[]}};
 state.tasks.push({id:'trial-first',siteId:first.id,channelId:'yeetmd',sourceDomain:'yeet.md',status:'running',createdAt:now.toISOString(),scheduledAt:now.toISOString(),updatedAt:now.toISOString(),attempts:1,message:'trial'});
 const {ids:secondIds,counted:secondCount}=snapshot(second);
 assert.equal(secondIds.has('yeetmd'),false);
 assert.deepEqual(new Set(secondCount.runtimeSchedulableIds),secondIds);
 state.settings.channelTrials.yeetmd={trial:false,failures:0,evaluatedTaskIds:['trial-first'],promotedAt:now.toISOString()};
 const {ids:promotedIds,counted:promoted}=snapshot(second);
 assert.equal(promotedIds.has('yeetmd'),true);
 assert.deepEqual(new Set(promoted.runtimeSchedulableIds),promotedIds);
 assert.equal(promoted.acceptedCount,secondCount.acceptedCount,'promotion without a real page is not acceptance evidence');
 state.tasks.push({id:'accepted-proof',siteId:second.id,channelId:'telegraph',sourceDomain:'telegra.ph',status:'live',createdAt:'2026-08-01T00:00:00.000Z',scheduledAt:'2026-08-01T00:00:00.000Z',updatedAt:'2026-08-01T00:00:00.000Z',firstLiveAt:'2026-08-01T00:00:00.000Z',linkCheck:'found',linkIndexable:true,attempts:1,message:'accepted'});
 assert.equal(runtimeFinancePlatformCount(state,second,CHANNELS,now).acceptedCount,1);
});

test('an exhausted account preparation blocks only its site from new automatic reservations',()=>{
 const state=emptyState(),first={...site,topics:[{url:'https://example.com/guide',discoveredAt:'2026-10-18T00:00:00.000Z'}]},second={...site,id:'second',domain:'example-site.com',url:'https://example-site.com/',topics:[{url:'https://example-site.com/guide',discoveredAt:'2026-10-18T00:00:00.000Z'}]};
 state.sites=[first,second];state.settings.timezone='UTC';
 const now=new Date('2026-10-20T12:17:00.000Z');
 state.tasks=[{id:'exhausted',siteId:first.id,channelId:'rant',sourceDomain:'rant.li',status:'skipped',checkpoint:'batch5_prepare_exhausted',createdAt:'2026-10-18T00:00:00.000Z',scheduledAt:'2026-10-18T00:00:00.000Z',updatedAt:'2026-10-18T00:00:00.000Z',attempts:3,message:'preparation exhausted'}];
 const candidates=(value:Site)=>schedulableTaskMatches(state,{id:`candidate-${value.id}`,siteId:value.id,channelId:'',sourceDomain:'',status:'queued',createdAt:now.toISOString(),scheduledAt:now.toISOString(),updatedAt:now.toISOString(),attempts:0,message:'candidate'},matchChannels(value,CHANNELS),now).map(item=>item.match.channel.id);
 assert.equal(candidates(first).includes('rant'),false);
 assert.equal(candidates(second).includes('rant'),true);
 state.tasks[0].updatedAt='2026-10-13T12:17:00.000Z';
 assert.equal(candidates(first).includes('rant'),true,'cooldown ends after seven days without a remote submission');
});

test('single-site identity prevents sharing without making same-site blog articles one-shot',()=>{
 const rant=channel('rant');
 assert.equal(rant.singleSiteOnly,true);
 assert.equal(countFinanceAutomaticPlatforms(site,[rant],{identitySiteIds:{rant:['other']}}).count,0);
 assert.equal(countFinanceAutomaticPlatforms(site,[rant],{identitySiteIds:{rant:[site.id]}}).count,0,'an existing account is not presumed registered');
 assert.equal(countFinanceAutomaticPlatforms(site,[rant],{identitySiteIds:{rant:[site.id]},readiness:()=> 'ready'}).count,1);
 assert.equal(countFinanceAutomaticPlatforms(site,[rant],{existingAccountChannelIds:['rant']}).count,0);
});

test('finance audience is a hard gate even when product proof and finance categories exist',()=>{
 const product:Channel={...channel('telegraph'),audience:['software'],categories:['finance','general'],requirements:[]};
 const financialTool={...site,qualifications:{software:'https://example.com/tool',developer:'https://example.com/docs'}};
 assert.equal(eligibilityFor(financialTool,product).eligible,false);
 assert.equal(channelDiscoveryFor(financialTool,product).canQueue,false);
 for(const id of ['agentsgather','tantive','agentnotepad','openagentchat','shellbook','listed-startups','github-gist'])assert.equal(eligibilityFor(financialTool,channel(id)).eligible,false,id);
});

test('promotion forbidden and language mismatch cannot create preparation tasks',()=>{
 for(const value of [{...channel('telegraph'),promotionPolicy:'forbidden' as const},{...channel('telegraph'),languages:['en']}]){
  assert.equal(eligibilityFor(site,value).eligible,false);
  const discovery=channelDiscoveryFor(site,value);assert.equal(discovery.status,'blocked');assert.equal(discovery.canQueue,false);
 }
 assert.equal(eligibilityFor({...site,language:'zh-CN'},{...channel('telegraph'),languages:['zh-Hans']}).eligible,true);
});

test('unknown policy remains explicit and does not invent a software-only restriction',()=>{
 for(const id of ['katbin','markdrop','thethings']){
  assert.equal(channel(id).promotionPolicy,'unknown');
  assert.equal(eligibilityFor(site,channel(id)).eligible,true,id);
  assert.equal(channel(id).trial,true);
 }
 for(const id of ['memorywiki','draftmark','deed-page','html-app']){
  const value=channel(id);assert.equal(value.promotionPolicy,'allowed');assert.equal(eligibilityFor(site,value).eligible,true);
  assert.equal(value.requirements,undefined);
  assert.doesNotMatch(value.notes,/仅发布与本站真实软件|只用于与本站真实软件|只允许与本站真实软件/);
 }
 assert.equal(channel('pastemyst').promotionPolicy,'unknown');
 assert.equal(eligibilityFor(site,channel('pastemyst')).eligible,true);
});

test('temporary and unindexable pages cannot inflate monthly platform totals',()=>{
 const base=channel('yeetmd');
 assert.equal(countFinanceAutomaticPlatforms(site,[{...base,retentionDays:1}]).count,0);
 assert.equal(countFinanceAutomaticPlatforms(site,[{...base,indexable:'no'}]).count,0);
 assert.equal(eligibilityFor(site,{...base,retentionDays:1}).eligible,true,'temporary supplemental publishing is still eligible');
 for(const [id,days] of [['mdview',30],['agentdrop',30],['shippage',14],['pstrs',365],['nextgen-slides',90]] as const)assert.equal(channel(id).retentionDays,days);
});

test('legacy field omissions retain compatibility while new structured fields take precedence',()=>{
 const legacy={...channel('telegraph')};delete legacy.audience;delete legacy.promotionPolicy;delete legacy.indexable;delete legacy.linkRel;delete legacy.trial;delete legacy.singleSiteOnly;
 assert.equal(eligibilityFor(site,legacy).eligible,true);
 assert.deepEqual(channelAudience({...legacy,categories:['finance'],requirements:['software']}),['software']);
 assert.equal(eligibilityFor(site,{...legacy,audience:['ai_agent']}).eligible,false);
});

test('new catalog capabilities preserve policy and irreversible restrictions',()=>{
 for(const id of ['yeetmd','markdownpage','slopit','rant','whitewind','hackmd','docs-md','leaflet','wordpress-com'])assert.equal(channel(id).trial,true,id);
 assert.equal(channel('markdownpage').irreversible,true);
 assert.equal(channel('rant').linkRel,'nofollow');
 assert.equal(channel('whitewind').promotionPolicy,'forbidden');assert.equal(channel('whitewind').enabled,false);
 assert.equal(channel('rentry').enabled,false);assert.equal(channel('rentry').indexable,'partial');
 assert.equal(channel('wordpress-com').promotionPolicy,'disclosed');
});

test('custom channel parser accepts structured fields and rejects unsafe policy sources',()=>{
 const input={name:'Example channel',domain:'channel.example.com',submitUrl:'https://channel.example.com/new',categories:['general'],languages:['*'],kind:'article',free:'yes',freeNote:'公开',rulesUrl:'https://channel.example.com/terms',notes:'测试条款',audience:['general','finance'],promotionPolicy:'disclosed',promotionPolicySource:'https://channel.example.com/terms',linkRel:'ugc',indexable:'partial',retentionDays:0.5,trial:true,singleSiteOnly:true,irreversible:true};
 const [saved]=saveCustomChannel([],input,CHANNELS);
 assert.equal(saved.retentionDays,0.5);assert.deepEqual(saved.audience,['general','finance']);assert.equal(saved.automation,'manual');
 assert.throws(()=>saveCustomChannel([],{...input,promotionPolicySource:'https://channel.example.com/terms?token=secret'},CHANNELS));
 assert.throws(()=>saveCustomChannel([],{...input,retentionDays:0},CHANNELS));
});
