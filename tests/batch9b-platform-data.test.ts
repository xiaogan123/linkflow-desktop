import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS} from '../src/integrations/catalog';
import {channelAccessClassForSite,channelAccessSnapshot} from '../src/integrations/channel-access-class';
import {channelDrSnapshotView} from '../src/integrations/channel-authority-snapshots';
import {AHREFS_DR_ENDPOINT} from '../src/integrations/ahrefs-dr';
import {normalizeChannelLinkRel} from '../src/shared/channel-rel';
import {composeChannels,CustomChannelInput,importChannelMetrics} from '../src/integrations/channel-library';
import {validateBackup} from '../src/main/backup-validation';
import {emptyState} from '../src/main/store';
import type {ChannelMetric,Site} from '../src/shared/types';

const site:Site={id:'site',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Example',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:'2026-10-19'};
const byId=(id:string)=>{const channel=CHANNELS.find(value=>value.id===id);assert.ok(channel,id);return channel};

test('every built-in has a setup class, while the eighth class follows site eligibility',()=>{
  const classes=new Set(['direct_submit','auto_account','email_auto','human_verify_once','connect_once','wallet','manual']);
  for(const channel of CHANNELS){assert.ok(channel.accessClass&&classes.has(channel.accessClass),channel.id);assert.notEqual(channel.accessClass,'unqualified')}
  for(const [id,expected] of [['yeetmd','direct_submit'],['rant','auto_account'],['plopino','email_auto'],['paper-wf','human_verify_once'],['hackmd','connect_once'],['paragraph','connect_once'],['hive','connect_once'],['agentswiki','auto_account'],['shiply','email_auto'],['brewpage','direct_submit'],['deed-page','direct_submit'],['padlet','manual']] as const)assert.equal(byId(id).accessClass,expected,id);
  const qualified={...site,qualifications:{publication:'https://example.com/publication'}};
  assert.equal(channelAccessClassForSite(qualified,byId('paragraph')),'connect_once');
  assert.equal(channelAccessClassForSite(site,byId('paragraph')),'unqualified');
  assert.equal(channelAccessClassForSite(site,byId('slopit')),'unqualified');
  const before=structuredClone(CHANNELS),snapshot=channelAccessSnapshot(site,[byId('yeetmd'),byId('paragraph')]);
  assert.deepEqual(snapshot,[{channelId:'yeetmd',accessClass:'direct_submit'},{channelId:'paragraph',accessClass:'unqualified'}]);
  assert.deepEqual(CHANNELS,before);
});

test('no evidence source remains unverified even when old defaults claimed a policy check',()=>{
  const missing=CHANNELS.filter(channel=>!channel.evidenceSources?.length);
  assert.ok(missing.length>0);
  assert.ok(missing.every(channel=>channel.evidenceStatus==='unverified'));
  assert.equal(byId('yeetmd').evidenceStatus,'rules_checked');
});

test('DR provenance distinguishes snapshots, actual API responses, imports and pending dates',()=>{
  const builtin=channelDrSnapshotView(byId('github').metrics,'2026-10-19');
  assert.equal(builtin.source,'built_in');assert.equal(builtin.value,97);assert.equal(builtin.asOf,'2026-10');
  const api:ChannelMetric={provider:'ahrefs-dr',value:42,target:'example.com',linkScope:'same-host',asOf:'2026-10',version:'dr3',source:AHREFS_DR_ENDPOINT,apiProvenance:'ahrefs_api'};
  assert.deepEqual(channelDrSnapshotView([byId('github').metrics![0],api],'2026-10-19'),{value:42,source:'ahrefs',asOf:'2026-10',linkScope:'same-host',target:'example.com'});
  assert.equal(channelDrSnapshotView([{...api,apiProvenance:undefined}],'2026-10-19').source,'user_import');
  assert.equal(channelDrSnapshotView([{...api,source:'https://example.com/report'}],'2026-10-19').source,'user_import');
  assert.equal(channelDrSnapshotView([{...api,version:'',source:'https://ahrefstop.com/websites/example.com'}],'2026-10-19').source,'built_in');
  assert.deepEqual(channelDrSnapshotView([], '2026-10-19'),{source:'pending',asOf:'2026-10-19'});
  assert.equal(channelDrSnapshotView(byId('telegraph').metrics,'2026-10-19').asOf,'');
});

test('a metrics import cannot forge Ahrefs API provenance, while an API result survives backup restore',()=>{
  const api:ChannelMetric={provider:'ahrefs-dr',value:42,target:'github.com',linkScope:'same-host',asOf:'2026-10',version:'dr3',source:AHREFS_DR_ENDPOINT,apiProvenance:'ahrefs_api'};
  const {apiProvenance:_apiProvenance,...spoof}=api;
  const imported=importChannelMetrics({},[{channelId:'github',metrics:[spoof]}],CHANNELS);
  assert.equal(channelDrSnapshotView(composeChannels(CHANNELS,[],imported).find(channel=>channel.id==='github')!.metrics,'2026-10-19').source,'user_import');
  assert.throws(()=>importChannelMetrics({},[{channelId:'github',metrics:[api]}],CHANNELS));
  const state=emptyState();state.channelMetrics={github:{metrics:[api]}};
  const restored=validateBackup({state,secrets:{}}).state;
  assert.deepEqual(restored.channelMetrics?.github.metrics?.[0],api);
  assert.equal(channelDrSnapshotView(restored.channelMetrics?.github.metrics,'2026-10-19').source,'ahrefs');
});

test('legacy rel combinations normalize before display and custom entries cannot add sponsored',()=>{
  assert.equal(normalizeChannelLinkRel('nofollow ugc sponsored'),'nofollow');
  assert.equal(normalizeChannelLinkRel('sponsored'),'nofollow');
  assert.equal(normalizeChannelLinkRel('ugc noopener'),'ugc');
  assert.equal(normalizeChannelLinkRel('noopener noreferrer'),'follow');
  assert.equal(normalizeChannelLinkRel(''),'follow');
  assert.equal(normalizeChannelLinkRel(undefined),undefined);
  assert.equal(normalizeChannelLinkRel('unrecognized'),'unknown');
  const legacy={...byId('padlet'),id:'custom-11111111-1111-4111-8111-111111111111',automation:'manual' as const,linkRel:'sponsored' as never};
  assert.equal(composeChannels([], [legacy])[0].linkRel,'nofollow');
  const input={name:'Example',domain:'example.com',submitUrl:'https://example.com/submit',categories:['content'],languages:['en'],kind:'profile',free:'yes',freeNote:'Example',rulesUrl:'https://example.com/terms',notes:'Example',linkRel:'sponsored'};
  assert.equal(CustomChannelInput.safeParse(input).success,false);
});
