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

test('Markdrop no-signup filter reaches general finance content after the policy review',()=>{
  const markdrop=channel('markdrop'),view=channelOnboardingView(markdrop);
  assert.equal(view.kind,'no_signup');
  assert.match(view.setup,/无需账号或邮箱.*一次性编辑密钥.*不保证长期/);
  assert.equal(view.verification?.sourceUrl,'https://api.markdrop.in/openapi.json');
  assert.equal(channelMatchesDirectoryFilters(markdrop,{automation:'ai_auto',onboarding:'no_signup',freeOnly:true,category:'software',siteVisible:true}),true);
  assert.equal(channelMatchesDirectoryFilters(markdrop,{automation:'ai_auto',onboarding:'no_signup',freeOnly:true,category:'finance',siteVisible:true}),true);
  assert.equal(channelMatchesDirectoryFilters({...markdrop,enabled:false},{automation:'ai_auto',onboarding:'no_signup',freeOnly:true,category:'software',siteVisible:true}),false);
  assert.equal(channelOnboardingKind({...markdrop,provenance:'custom'}),'unknown');
});

test('Draftmark is an enabled no-signup channel with per-document credentials',()=>{
  const value=channel('draftmark'),view=channelOnboardingView(value);assert.equal(value.enabled,true);assert.equal(view.kind,'no_signup');
  assert.match(view.setup,/无需账号或邮箱.*magic token.*密钥.*不重复提交/);
  assert.equal(view.verification?.sourceUrl,'https://draftmark.app/terms');
  assert.equal(channelMatchesDirectoryFilters(value,{automation:'all',onboarding:'no_signup',freeOnly:true,category:'software',siteVisible:true}),true);
  assert.equal(channelMatchesDirectoryFilters(value,{automation:'ai_auto',onboarding:'no_signup',freeOnly:true,category:'software',siteVisible:true}),true);
  assert.equal(channelMatchesDirectoryFilters(value,{automation:'ai_auto',onboarding:'no_signup',freeOnly:true,category:'finance',siteVisible:true}),true);
});

test('accepted anonymous publishers expose their current no-signup access without stale hold copy',()=>{
  const slugpost=channel('slugpost'),slugpostView=channelOnboardingView(slugpost);
  const tantive=channel('tantive');assert.equal(channelOnboardingView(tantive).kind,'no_signup');assert.match(channelOnboardingView(tantive).setup,/无需账号.*逐字预览.*原 request ID/);
  assert.equal(slugpostView.kind,'no_signup');
  assert.match(slugpostView.setup,/无需账号或邮箱.*官方网页.*本人验证.*未知结果不重发.*没有长期保留/);
  assert.equal(slugpostView.verification?.sourceUrl,'https://slugpost.com/publish');
  assert.equal(channelMatchesDirectoryFilters(slugpost,{automation:'ai_auto',onboarding:'no_signup',freeOnly:true,category:'software',siteVisible:true}),true);
  assert.equal(channelOnboardingKind({...slugpost,provenance:'custom'}),'unknown');
  for(const id of ['mdshare','txtsbs']){
    const value=channel(id),view=channelOnboardingView(value);
    assert.equal(value.enabled,true,id);
    assert.equal(view.kind,'no_signup',id);
    assert.match(view.setup,/已完成一次真实匿名发布/,id);
    assert.match(view.setup,/结果不明不重发/,id);
    assert.match(view.setup,/不保证永久保存|不能视为永久保存/,id);
    assert.doesNotMatch(view.setup,/验收前|保持停用|首次真实验收前/,id);
    assert.match(value.notes??'',/已完成.*实发|已完成一次真实匿名发布/,id);
  }
});

test('verified no-signup and automatic identity flows stay distinct',()=>{
  for(const id of ['lucid-page','rentry','betterthanhtml','supanote','docs-md'])assert.equal(channelOnboardingKind(builtIn(id)),'no_signup',id);
  assert.deepEqual(CHANNELS.filter(item=>channelMatchesOnboarding(item,'ai_account')).map(item=>item.id).sort(),['agentboard','agenthow','agentnotepad','agentriot','agentswiki','beacon','carcinus','here-now','large-language','mataroa','nostr','notebin','openagentchat','paper-wf','plopino','shellbook','shiply','shippage','swarmmemo','synthfolk','telegraph','verbose','vibedrop','wordcell']);
  assert.match(channelOnboardingView(channel('telegraph')).setup,/自动创建发布账号/);
  assert.match(channelOnboardingView(channel('nostr')).setup,/本机创建作者密钥/);
  assert.match(channelOnboardingView(channel('nostr')).setup,/不是钱包连接/);
  assert.match(channelOnboardingView(channel('paper-wf')).setup,/人机验证/);
  assert.match(channelOnboardingView(builtIn('betterthanhtml')).setup,/无需账号.*不承诺编辑或删除/);
  assert.match(channelOnboardingView(builtIn('docs-md')).setup,/无需账号.*保持停用.*真实托管公开页验收/);
});

test('accepted agent identities and directory access expose verified onboarding without stale hold copy',()=>{
  const sources={agenthow:'https://agenthow.to/reference/register',agentnotepad:'https://agentnotepad.com/skill.md',openagentchat:'https://openagentchat.net/for-agents','large-language':'https://large-language.ai/for-agents'};
  for(const [id,sourceUrl] of Object.entries(sources)){
    const value=channel(id),view=channelOnboardingView(value);assert.equal(value.enabled,true,id);assert.equal(view.kind,'ai_account',id);assert.equal(view.verification?.sourceUrl,sourceUrl,id);
    assert.match(view.setup,/首次任务自动建立.*无邮箱.*未知结果.*不重试/,id);
    assert.equal(channelMatchesDirectoryFilters(value,{automation:'ai_auto',onboarding:'ai_account',freeOnly:true,category:'software',siteVisible:true}),true,id);
    assert.equal(channelMatchesDirectoryFilters(value,{automation:'ai_auto',onboarding:'ai_account',freeOnly:true,category:'software',siteVisible:false}),false,id);
    assert.equal(channelMatchesDirectoryFilters({...value,enabled:false},{automation:'ai_auto',onboarding:'ai_account',freeOnly:true,category:'software',siteVisible:true}),false,id);
    assert.equal(channelOnboardingKind({...value,provenance:'custom'}),'unknown',id);
  }
  const pastyx=channelOnboardingView(channel('pastyx'));assert.equal(pastyx.kind,'no_signup');assert.match(pastyx.setup,/已完成一次真实匿名创建/);assert.match(pastyx.setup,/未知结果不重发/);assert.match(pastyx.setup,/不等于永久保存/);assert.doesNotMatch(pastyx.setup,/停用|尚待|验收前/);
  const wordcell=channelOnboardingView(channel('wordcell'));assert.equal(wordcell.kind,'ai_account');assert.match(wordcell.setup,/已完成一次真实令牌建立.*不重复 PUT.*不保证永久/);assert.doesNotMatch(wordcell.setup,/停用|尚待|验收前/);
  assert.equal(channelOnboardingKind(channel('listed-startups')),'no_signup');assert.equal(channelOnboardingKind(channel('product-index')),'existing_account');
});

test('wallet classification only covers a wallet-required flow, not publication keys or posting keys',()=>{
  for(const id of ['sigle','nuance'])assert.equal(channelOnboardingKind(builtIn(id)),'wallet',id);
  assert.equal(CHANNELS.filter(item=>channelMatchesOnboarding(item,'wallet')).every(item=>['sigle','nuance'].includes(item.id)),true);
  const paragraph=channelOnboardingView(channel('paragraph'));
  assert.equal(paragraph.kind,'existing_account');
  assert.match(paragraph.setup,/邮箱免密码.*不要求钱包/);
  assert.match(paragraph.setup,/密钥/);
  assert.deepEqual(paragraph.aliases,['Mirror']);
  assert.equal(CHANNELS.filter(item=>item.id==='paragraph').length,1);
  assert.match(channelOnboardingView(builtIn('sigle')).setup,/Leather \/ Stacks.*逐篇签名.*未接无人值守/);
  assert.match(channelOnboardingView(builtIn('nuance')).setup,/NFID、Plug 或 Internet Identity.*委托有期限.*未接无人值守/);
  assert.equal(channelOnboardingKind(channel('hive')),'existing_account');
  assert.match(channelOnboardingView(channel('hive')).setup,/posting key/);
  assert.match(channelOnboardingView(channel('hive')).setup,/不调用钱包弹窗/);
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
  assert.deepEqual(select('connected_auto','wallet'),[]);
  assert.deepEqual(select('ai_auto','no_signup'),['betterthanhtml','brewpage','deed-page','docs-md','draftmark','html-app','katbin','lucid-page','markdrop','memorywiki','nextgen-slides','pastemyst','pastyx','pstrs','supanote','thethings','txtsbs','yourwebs']);
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

test('email publishers require an authorized tested inbox before automatic registration',()=>{
  const plopino=channel('plopino'),here=channel('here-now');
  assert.equal(channelOnboardingKind(plopino),'ai_account');
  assert.equal(channelOnboardingKind(here),'ai_account');
  assert.match(channelOnboardingView(plopino).setup,/已授权邮箱.*自动建立.*不会重复注册/);
  for(const value of [here,channel('shiply')]){
    assert.equal(value.accessClass,'email_auto');
    assert.match(channelOnboardingView(value).setup,/已授权.*测试通过.*到期任务自动请求并读取.*验证码/);
    assert.doesNotMatch(channelOnboardingView(value).setup,/验收前停用|验证码仍需本人/);
  }
  assert.equal(channelMatchesDirectoryFilters(plopino,{automation:'ai_auto',onboarding:'ai_account',freeOnly:true,category:'software',siteVisible:true}),true);
  assert.equal(channelMatchesDirectoryFilters(here,{automation:'connected_auto',onboarding:'ai_account',freeOnly:true,category:'software',siteVisible:true}),true);
});
