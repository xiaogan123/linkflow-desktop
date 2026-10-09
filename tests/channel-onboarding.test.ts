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
  for(const id of ['lucid-page','rentry','betterthanhtml','supanote'])assert.equal(channelOnboardingKind(builtIn(id)),'no_signup',id);
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
  for(const id of ['github-gist','blogger','wordpress-com','leaflet','bluesky','github','gitlab','behance','artstation','prose']){
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
  assert.deepEqual(select('ai_auto','no_signup'),['betterthanhtml','lucid-page','supanote']);
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

test('verified account setup does not turn manual or disabled publishers into automatic channels',()=>{
  for(const id of ['hashnode','medium','substack','dev','hackernoon','tumblr','ghost-pro','beehiiv','kit-newsletter','product-hunt','alternativeto','vocus','publish0x','flipboard-publisher','gravatar','linktree','linkedin-articles','youtube-channel','x-profile','tradingview-profile','pinterest','linkedin-company','bluesky-domain','crunchbase-company','trustpilot-business','bing-places','g2','capterra','clutch','google-business','apple-business','yelp-business','codeberg','huggingface','sourceforge','itch-io','show-hn','npm','pypi','nuget','crates-io','packagist','pub-dev','uneed','betalist','wellfound','docker-hub','firefox-addons','vscode-marketplace','jetbrains-marketplace','flathub','fdroid','snap-store','wordpress-plugins','drupal','rubygems']){
    const item=channel(id),view=channelOnboardingView(item);
    assert.equal(view.kind,'existing_account',id);
    assert.equal(channelMatchesOnboarding(item,'unknown'),false,id);
    assert.equal(channelMatchesAutomation(item,'ai_auto'),false,id);
    assert.equal(channelMatchesAutomation(item,'connected_auto'),false,id);
    assert.equal(channelAutomationKind(item),['medium','dev','vocus','publish0x','pinterest','bluesky-domain','flathub'].includes(id)?'disabled':'manual',id);
    assert.equal(view.verification?.checkedAt,'2026-10-09',id);
    assert.ok(view.verification?.sourceUrl.startsWith('https://'),id);
    // Login-only evidence must not refresh policy dates; Show HN and Tumblr had separate policy research.
    if(!['show-hn','tumblr'].includes(id))assert.notEqual(item.checkedAt,view.verification?.checkedAt,id);
  }
});

test('user-added copies cannot inherit built-in onboarding evidence',()=>{
  for(const id of ['medium','uneed','betalist','wellfound','docker-hub','firefox-addons','vscode-marketplace','jetbrains-marketplace','flathub','fdroid','snap-store','wordpress-plugins','drupal','rubygems']){
    const verified=channel(id);
    assert.ok(channelOnboardingView(verified).verification,id);
    for(const provenance of ['custom',undefined] as const){
      const view=channelOnboardingView({...verified,provenance});
      assert.equal(view.kind,'unknown',id);
      assert.equal(view.verification,undefined,id);
    }
  }
});


test('partially checked setup preserves a concrete gap and remains unknown',()=>{
  const item=channel('saashub'),view=channelOnboardingView(item);
  assert.equal(view.kind,'unknown');
  assert.equal(channelMatchesOnboarding(item,'unknown'),true);
  assert.equal(channelAutomationKind(item),'manual');
  assert.equal(channelMatchesAutomation(item,'ai_auto'),false);
  assert.equal(channelMatchesAutomation(item,'connected_auto'),false);
  assert.match(view.setup,/账号及最终提交条件待核实/);
  assert.ok(view.verification?.sourceUrl.startsWith('https://www.saashub.com/'));
  assert.notEqual(item.checkedAt,view.verification?.checkedAt);
  assert.equal(channelOnboardingView({...item,provenance:'custom'}).verification,undefined);
});


test('business onboarding keeps company and local-service eligibility separate from account access',()=>{
  const crunchbase=channelOnboardingView(channel('crunchbase-company'));
  assert.match(crunchbase.setup,/Google 或 LinkedIn 社交认证/);
  assert.match(crunchbase.setup,/符合收录范围的真实公司/);
  const trustpilot=channelOnboardingView(channel('trustpilot-business'));
  assert.match(trustpilot.setup,/邮箱激活.*按需验证域名/);
  assert.match(trustpilot.setup,/有权管理的真实业务/);
  const bing=channelOnboardingView(channel('bing-places'));
  assert.match(bing.setup,/真实本地商家/);
  assert.match(bing.setup,/纯线上内容站不适用/);
});
