import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS} from '../src/integrations/catalog';
import type {Channel} from '../src/shared/types';
import {channelAutomationKind,channelMatchesAutomation} from '../src/ui/channel-automation';
import {channelMatchesDirectoryFilters,channelMatchesOnboarding,channelOnboardingKind,channelOnboardingView} from '../src/ui/channel-onboarding';

const channel=(id:string)=>{
  const found=CHANNELS.find(item=>item.id===id);
  assert.ok(found,`missing ${id}`);
  return found;
};
const builtIn=(id:string):Channel=>CHANNELS.find(item=>item.id===id)??{...channel('telegraph'),id,provenance:'built-in'};

test('verified no-signup and automatic identity flows stay distinct',()=>{
  for(const id of ['lucid-page','rentry','betterthanhtml'])assert.equal(channelOnboardingKind(builtIn(id)),'no_signup',id);
  assert.deepEqual(CHANNELS.filter(item=>channelMatchesOnboarding(item,'ai_account')).map(item=>item.id).sort(),['mataroa','nostr','paper-wf','telegraph','verbose']);
  assert.match(channelOnboardingView(channel('telegraph')).setup,/自动创建作者身份/);
  assert.match(channelOnboardingView(channel('nostr')).setup,/本机创建作者密钥/);
  assert.match(channelOnboardingView(channel('nostr')).setup,/不是钱包连接/);
  assert.match(channelOnboardingView(channel('paper-wf')).setup,/人机验证/);
  assert.match(channelOnboardingView(builtIn('betterthanhtml')).setup,/无需账号.*不承诺编辑或删除/);
});

test('wallet means the platform setup while Linkflow states the credential it actually uses',()=>{
  for(const id of ['paragraph','sigle','nuance','hive'])assert.equal(channelOnboardingKind(builtIn(id)),'wallet',id);
  assert.equal(CHANNELS.filter(item=>channelMatchesOnboarding(item,'wallet')).every(item=>['paragraph','sigle','nuance','hive'].includes(item.id)),true);
  const paragraph=channelOnboardingView(channel('paragraph'));
  assert.match(paragraph.setup,/钱包或邮箱/);
  assert.match(paragraph.setup,/API key/);
  assert.deepEqual(paragraph.aliases,['Mirror']);
  assert.equal(CHANNELS.filter(item=>item.id==='paragraph').length,1);
  assert.match(channelOnboardingView(builtIn('sigle')).setup,/Leather \/ Stacks.*逐篇签名.*未接无人值守/);
  assert.match(channelOnboardingView(builtIn('nuance')).setup,/NFID、Plug 或 Internet Identity.*委托有期限.*未接无人值守/);
  assert.equal(channelOnboardingKind(channel('hive')),'wallet');
  assert.match(channelOnboardingView(channel('hive')).setup,/posting key/);
  assert.match(channelOnboardingView(channel('hive')).setup,/未接钱包签名流程/);
  assert.deepEqual(channelOnboardingView(channel('hive')).aliases,['PeakD','Ecency']);
});

test('trusted connection and browser-profile entries require an existing account',()=>{
  for(const id of ['github-gist','blogger','wordpress-com','leaflet','bluesky','github','gitlab','behance','artstation']){
    assert.equal(channelOnboardingKind(channel(id)),'existing_account',id);
  }
  assert.deepEqual(CHANNELS.filter(item=>channelMatchesAutomation(item,'profile')&&channelMatchesOnboarding(item,'existing_account')).map(item=>item.id).sort(),['artstation','behance','github','gitlab']);
});

test('custom and unmapped rows remain unknown even when they reuse a trusted id or API shape',()=>{
  const customSpoof={...channel('telegraph'),provenance:'custom' as const};
  const unmarkedSpoof={...channel('telegraph'),provenance:undefined};
  const unknownBuiltIn={...channel('telegraph'),id:'unverified-api',provenance:'built-in' as const};
  for(const item of [customSpoof,unmarkedSpoof,unknownBuiltIn]){
    assert.equal(channelOnboardingKind(item),'unknown');
    assert.equal(channelMatchesOnboarding(item,'ai_account'),false);
    assert.equal(channelMatchesOnboarding(item,'unknown'),true);
  }
  assert.match(channelOnboardingView(customSpoof).setup,/用户添加.*待核实/);
  assert.match(channelOnboardingView(unknownBuiltIn).setup,/尚未确认/);
});

test('setup combines with capability, free, finance and selected-site visibility using AND',()=>{
  const select=(automation:Parameters<typeof channelMatchesAutomation>[1],setup:Parameters<typeof channelMatchesOnboarding>[1],siteVisible=true)=>CHANNELS.filter(item=>channelMatchesDirectoryFilters(item,{automation,onboarding:setup,freeOnly:true,category:'finance',siteVisible})).map(item=>item.id).sort();
  assert.deepEqual(select('connected_auto','wallet'),['paragraph']);
  assert.deepEqual(select('ai_auto','no_signup'),['betterthanhtml','lucid-page']);
  assert.deepEqual(select('ai_auto','existing_account'),[]);
  assert.deepEqual(select('connected_auto','ai_account'),[]);
  assert.deepEqual(select('connected_auto','wallet',false),[]);
});

test('a setup filter never enables a disabled catalog candidate',()=>{
  const rentry=channel('rentry');
  assert.equal(rentry.enabled,false);
  assert.equal(channelMatchesOnboarding(rentry,'no_signup'),true);
  assert.equal(channelOnboardingKind(rentry),'no_signup');
  assert.equal(channelAutomationKind(rentry),'disabled');
  assert.equal(channelMatchesAutomation(rentry,'ai_auto'),false);
  assert.equal(channelMatchesAutomation(rentry,'all'),true);
  const disabledBetterThanHtml={...channel('betterthanhtml'),enabled:false};
  assert.equal(channelMatchesOnboarding(disabledBetterThanHtml,'no_signup'),true);
  assert.equal(channelAutomationKind(disabledBetterThanHtml),'disabled');
  assert.equal(channelMatchesAutomation(disabledBetterThanHtml,'ai_auto'),false);
});
