import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS} from '../src/integrations/catalog';
import type {Account,Channel,Site,Snapshot} from '../src/shared/types';
import {channelAutomationKind,channelAutomationView,channelDiscoveryCopy,channelMatchesAutomation,channelSourceLabels} from '../src/ui/channel-automation';
import {channelReadinessForDisplay,channelReadinessLabel} from '../src/ui/presentation';

const channel=(id:string)=>{
  const found=CHANNELS.find(item=>item.id===id);
  assert.ok(found,`missing ${id}`);
  return found;
};

test('enabled built-in publisher capabilities follow the real first-step contract',()=>{
  assert.deepEqual(CHANNELS.filter(item=>channelAutomationKind(item)==='ai_auto').map(item=>item.id).sort(),['betterthanhtml','lucid-page','mataroa','nostr','supanote','telegraph','verbose']);
  assert.deepEqual(CHANNELS.filter(item=>channelAutomationKind(item)==='connected_auto').map(item=>item.id).sort(),['blogger','bluesky','github-gist','hive','paragraph']);
  assert.deepEqual(CHANNELS.filter(item=>channelAutomationKind(item)==='registration_pending').map(item=>item.id),['paper-wf']);
  assert.match(channelAutomationView(channel('nostr')).setup,/本机建立作者身份/);
  assert.match(channelAutomationView(channel('paper-wf')).setup,/人机验证/);
  assert.match(channelAutomationView(channel('bluesky')).method??'',/短帖/);
  assert.match(channelAutomationView(channel('blogger')).setup,/本人完成 Google 授权/);
});

test('disabled, custom and unknown API rows do not inflate automatic capability counts',()=>{
  const disabled={...channel('mataroa'),enabled:false};
  const custom={...channel('telegraph'),provenance:'custom' as const};
  const unknown={...channel('telegraph'),id:'custom-api',provenance:'built-in' as const};
  const disguised={...channel('bluesky'),contentFormat:undefined};
  for(const item of [disabled,custom,unknown,disguised]){
    assert.equal(channelMatchesAutomation(item,'ai_auto'),false,item.id);
    assert.equal(channelMatchesAutomation(item,'connected_auto'),false,item.id);
  }
  assert.equal(channelAutomationKind(disabled),'disabled');
  assert.equal(channelAutomationKind(custom),'manual');
  assert.equal(channelAutomationKind(unknown),'manual');
  assert.equal(channelAutomationKind(disguised),'manual');
  assert.equal(channelAutomationView(unknown).method,undefined);
  assert.match(channelAutomationView(custom).setup,/API 字段不代表/);
  const wordpress=channel('wordpress-com');
  assert.equal(wordpress.enabled,false);
  assert.equal(channelAutomationKind(wordpress),'disabled');
  assert.equal(channelMatchesAutomation(wordpress,'connected_auto'),false);
  assert.equal(channelAutomationKind({...wordpress,enabled:true}),'connected_auto');
  assert.match(channelAutomationView({...wordpress,enabled:true}).setup??'',/WordPress\.com.*浏览器授权.*已公开博客/);
});

test('Leaflet is a distinct full article connection and excluded until live acceptance',()=>{
  const leaflet=channel('leaflet');assert.equal(leaflet.enabled,false);assert.equal(channelAutomationKind(leaflet),'disabled');
  assert.equal(channelMatchesAutomation(leaflet,'ai_auto'),false);assert.equal(channelMatchesAutomation(leaflet,'connected_auto'),false);
  const enabled={...leaflet,enabled:true};assert.equal(channelAutomationKind(enabled),'connected_auto');assert.match(channelAutomationView(enabled).method??'',/全文/);assert.match(channelAutomationView(enabled).setup??'',/首次连接本人.*应用专用密码/);
});

test('Verbose is automatic after live acceptance and keeps experimental guidance limits visible',()=>{
  const verbose=channel('verbose');
  assert.equal(verbose.enabled,true);
  assert.equal(channelAutomationKind(verbose),'ai_auto');
  assert.equal(channelMatchesAutomation(verbose,'registration_pending'),false);
  assert.equal(channelMatchesAutomation(verbose,'ai_auto',true,'finance'),true);
  assert.match(channelAutomationView(verbose).setup,/自动建立作者身份.*实验平台/);
  assert.match(verbose.name,/实验/);
  assert.match(verbose.qualityReason,/nofollow\/ugc.*不保证搜索收录/);
  assert.equal(verbose.authority,undefined);
  assert.equal(verbose.traffic,undefined);
  assert.equal(channelAutomationKind({...verbose,enabled:false}),'disabled');
  assert.deepEqual(channelSourceLabels('verbose'),{checked:'接口与公开资料核查',open:'官方公开说明'});
  assert.deepEqual(channelSourceLabels('mataroa'),{checked:'规则核查',open:'官方规则'});
});

test('Verbose site readiness respects an explicit exclusion and a lost one-time token',()=>{
  const verbose={...channel('verbose'),enabled:true},stamp='2026-10-08T00:00:00.000Z';
  const site:Site={id:'site',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Example',category:'finance',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp};
  const account:Account={id:'author',channelId:'verbose',email:'',username:'reading-notes',publicationUrl:'https://verbose.blog/reading-notes',createdAt:stamp,status:'registered',source:'generated',registrationAttempts:1,hasPassword:true,credentialKind:'api_token',verboseExcludedSiteIds:[site.id]};
  const snapshot={accounts:[account],accountBindings:[],tasks:[]} as unknown as Snapshot;
  assert.equal(channelReadinessForDisplay(snapshot,site,verbose),'handoff_required');
  assert.match(channelAutomationView(verbose,channelReadinessLabel.handoff_required).siteReadiness??'',/本网站：需先连接/);
  account.verboseExcludedSiteIds=[];account.status='unknown';account.hasPassword=false;
  assert.equal(channelReadinessForDisplay(snapshot,site,verbose),'handoff_required');
  account.hasPassword=true;
  assert.equal(channelReadinessForDisplay(snapshot,site,verbose),'autocreate');
});

test('free and finance filters combine with capability rather than replacing it',()=>{
  assert.deepEqual(CHANNELS.filter(item=>channelMatchesAutomation(item,'connected_auto',true,'finance')).map(item=>item.id).sort(),['bluesky','github-gist','paragraph']);
  assert.deepEqual(CHANNELS.filter(item=>channelMatchesAutomation(item,'ai_auto',true,'finance')).map(item=>item.id).sort(),['betterthanhtml','lucid-page','mataroa','nostr','supanote','telegraph','verbose']);
  assert.equal(channelMatchesAutomation(channel('paper-wf'),'registration_pending',true,'finance'),false);
  assert.equal(channelMatchesAutomation(channel('paper-wf'),'registration_pending',false,'finance'),true);
  assert.equal(channelMatchesAutomation({...channel('telegraph'),enabled:false},'all',true,'finance'),true);
});

test('selected-site readiness remains visible beside static software capability',()=>{
  const mataroa=channel('mataroa');
  const stamp='2026-10-07T00:00:00.000Z';
  const site:Site={id:'site',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Example',category:'finance',language:'zh',monthlyTarget:2,status:'ready',createdAt:stamp};
  const account:Account={id:'author',channelId:'mataroa',email:'',username:'exampleauthor',publicationUrl:'https://exampleauthor.mataroa.blog/',createdAt:stamp,status:'registered',source:'generated',hasPassword:true,credentialKind:'api_token',mataroaExcludedSiteIds:[site.id]};
  const snapshot={accounts:[account],accountBindings:[],tasks:[]} as unknown as Snapshot;
  const readiness=channelReadinessForDisplay(snapshot,site,mataroa);
  assert.equal(readiness,'handoff_required');
  const view=channelAutomationView(mataroa,channelReadinessLabel[readiness]);
  assert.equal(view.label,'AI全自动 · 免首连');
  assert.equal(view.siteReadiness,'本网站：需先连接并验证已有账号');
  assert.equal(channelAutomationView(mataroa).siteReadiness,undefined);
  const discovery={status:'recommended' as const,reason:'与金融内容相关。',nextStep:'已具备本地执行条件；加入后仍按稿件审核和平台规则推进。'};
  const blockedCopy=channelDiscoveryCopy(discovery,channelAutomationKind(mataroa),readiness);
  assert.match(blockedCopy,/本网站需先连接或恢复可用账号/);
  assert.doesNotMatch(blockedCopy,/已具备本地执行条件/);
  assert.equal(channelDiscoveryCopy(discovery,channelAutomationKind(mataroa),'ready'),`${discovery.reason} ${discovery.nextStep}`);
  assert.equal(channelDiscoveryCopy({...discovery,status:'blocked'},channelAutomationKind(mataroa),readiness),`${discovery.reason} ${discovery.nextStep}`);
  assert.equal(channelDiscoveryCopy(discovery,'manual',readiness),`${discovery.reason} ${discovery.nextStep}`);
});

test('invalid Telegraph credentials replace generic locally-ready copy with account recovery',()=>{
  const telegraph=channel('telegraph');
  const stamp='2026-10-07T00:00:00.000Z';
  const site:Site={id:'site',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Example',category:'finance',language:'zh',monthlyTarget:2,status:'ready',createdAt:stamp};
  const account:Account={id:'old',channelId:'telegraph',email:site.email,username:'Example',createdAt:stamp,status:'credentials_invalid',hasPassword:true,credentialKind:'api_token'};
  const snapshot={accounts:[account],accountBindings:[{id:'bind',siteId:site.id,channelId:'telegraph',accountId:account.id,createdAt:stamp,updatedAt:stamp}],tasks:[]} as unknown as Snapshot;
  const readiness=channelReadinessForDisplay(snapshot,site,telegraph);
  assert.equal(readiness,'handoff_required');
  const copy=channelDiscoveryCopy({status:'recommended',reason:'主题相关。',nextStep:'已具备本地执行条件。'},channelAutomationKind(telegraph),readiness);
  assert.equal(copy,'主题相关。 本网站需先连接或恢复可用账号；之后仍按稿件审核与排期条件执行。');
});
