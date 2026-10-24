import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CHANNELS} from '../src/integrations/catalog';
import type {Account,Snapshot} from '../src/shared/types';
import {accountNextStep,accountReadiness,activateGuideSelection,connectionAction,groupConnections,needsDedicatedConnection} from '../src/ui/account-guidance';
import {connectionOverview} from '../src/ui/channel-connections';
import {AccountConnectionGuide} from '../src/ui/pages/AccountConnectionGuide';
import {AccountsPage} from '../src/ui/pages/AccountsPage';
import {ArticleConnection} from '../src/ui/pages/ArticleConnection';
import {HereNowConnection} from '../src/ui/pages/HereNowConnection';
import {ShiplyConnection} from '../src/ui/pages/ShiplyConnection';

const stamp='2026-10-10T00:00:00.000Z';
function snapshot(accounts:Account[]=[],sites:Snapshot['sites']=[]):Snapshot{
  return {sites,tasks:[],channels:CHANNELS,accounts,accountBindings:[],mailboxes:[],events:[],settings:{provider:'codex',codexPath:'codex',model:'',articleReviewMode:'ai',apiBase:'',hasApiKey:false,autoRun:true,launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:false,version:'fixture',platform:'darwin-arm64',dataPath:'fixture',aiCallsToday:0}};
}
function account(channelId:string,extra:Partial<Account>={}):Account{
  return {id:`${channelId}-account`,channelId,email:'owner@example.test',username:'owner',credentialKind:'password',status:'registered',hasPassword:true,source:'imported',createdAt:stamp,...extra};
}
const noop=<T,>(_command:string,_payload?:unknown)=>Promise.resolve(undefined as T|undefined);

test('account guide groups actionable, automatic, and read-only or disabled channels separately',()=>{
  const groups=groupConnections(connectionOverview(snapshot()));
  assert.ok(groups.connectable.some(row=>row.id==='paper-wf'));
  assert.ok(groups.automatic.some(row=>row.id==='telegraph'));
  assert.ok(groups.secondary.some(row=>row.id==='deno'));
  assert.ok(groups.secondary.some(row=>row.id==='markest'));
  assert.ok(groups.secondary.some(row=>row.id==='rentry'));
  assert.ok(!groups.connectable.some(row=>row.id==='deno'||row.id==='markest'));
  assert.deepEqual(groupConnections(connectionOverview(snapshot()),'paper').connectable.map(row=>row.id),['paper-wf']);
});

test('platform selection preserves dedicated routes and never turns automatic channels into generic imports',()=>{
  const rows=connectionOverview(snapshot());
  const byId=(id:string)=>{const row=rows.find(item=>item.id===id);assert.ok(row);return row};
  assert.deepEqual(connectionAction(byId('paper-wf')),{kind:'connect',label:'连接 Paper.wf'});
  assert.deepEqual(connectionAction(byId('github-gist')),{kind:'connect',label:'连接 GitHub Gist'});
  assert.deepEqual(connectionAction(byId('deno')),{kind:'connect',label:'只读验证专用应用'});
  assert.equal(byId('plopino').state,'no_setup');
  assert.deepEqual(connectionAction(byId('plopino')),{kind:'connect',label:'连接 Plopino'});
  assert.deepEqual(connectionAction(byId('telegraph')),{kind:'none'});
  assert.deepEqual(connectionAction(byId('rentry')),{kind:'none'});
  for(const id of ['mataroa','paper-wf','hive','prose','markest','deno','here-now','plopino','github-gist','blogger','wordpress-com','leaflet','paragraph','bluesky'])assert.equal(needsDedicatedConnection(id),true,id);
  assert.equal(needsDedicatedConnection('product-hunt'),false);
});

test('guide actions preserve the original account and expose locate for exceptional automatic identities',()=>{
  const base=connectionOverview(snapshot()).find(row=>row.id==='mataroa');assert.ok(base);
  const repair={...base,state:'attention' as const,attentionAccountId:'original-account'};
  const calls:string[]=[];
  activateGuideSelection(repair,{close:()=>calls.push('close'),connect:(id,accountId)=>calls.push(`connect:${id}:${accountId}`),locate:()=>calls.push('locate')});
  assert.deepEqual(calls,['close','connect:mataroa:original-account']);
  const automatic={...base,id:'telegraph' as const,name:'Telegraph',state:'attention' as const,attentionAccountId:'telegraph-account'};
  const located:string[]=[];
  activateGuideSelection(automatic,{close:()=>located.push('close'),connect:()=>located.push('connect'),locate:row=>located.push(`locate:${row.attentionAccountId}`)});
  assert.deepEqual(located,['close','locate:telegraph-account']);
});

test('attention and reusable state use secret, diagnostic, and required-binding readiness together',()=>{
  const missingSecret=accountReadiness(account('product-hunt',{hasPassword:false}),0,true);
  const diagnosed=accountReadiness(account('product-hunt',{diagnostic:{code:'password_missing',message:'fixture',at:stamp,retryable:true}}),0,true);
  const unbound=accountReadiness(account('hive',{credentialKind:'api_token'}),0,true);
  assert.deepEqual(missingSecret,{needsAttention:true,reusable:false});
  assert.deepEqual(diagnosed,{needsAttention:true,reusable:false});
  assert.deepEqual(unbound,{needsAttention:true,reusable:false});
  assert.deepEqual(accountReadiness(account('hive',{credentialKind:'api_token'}),1,true),{needsAttention:false,reusable:true});
  assert.deepEqual(accountReadiness(account('product-hunt'),0,false),{needsAttention:false,reusable:false});
});

test('saved, connected, bound, disabled, and read-only identities expose distinct next steps',()=>{
  assert.equal(accountNextStep(account('product-hunt',{status:'unknown'}),0,true),'已保存 · 下一步：确认平台账号状态');
  assert.equal(accountNextStep(account('hive'),0,true),'下一步：关联至少一个网站');
  assert.equal(accountNextStep(account('hive'),2,true),'已连接 · 已关联 2 个网站，待任务检查');
  assert.equal(accountNextStep(account('paragraph'),1,false),'连接已保存 · 平台当前未启用');
  assert.equal(accountNextStep(account('product-hunt',{hasPassword:false}),0,true),'下一步：恢复或重新连接发布账号');
  assert.equal(accountNextStep(account('product-hunt',{status:'credentials_invalid',hasPassword:false,diagnostic:{code:'password_missing',message:'fixture',at:stamp,retryable:true}}),0,true),'下一步：处理原连接或平台限制');
  assert.equal(accountNextStep(account('product-hunt',{status:'credentials_invalid',hasPassword:false,diagnostic:{code:'password_missing',message:'fixture',at:stamp,retryable:true}}),0,false),'连接需处理 · 平台当前未启用');
  assert.equal(accountNextStep(account('product-hunt',{hasPassword:false}),0,false),'发布账号需恢复 · 平台当前未启用');
  const deno=account('deno',{status:'unknown',credentialKind:'api_token',username:'11111111-1111-4111-8111-111111111111',denoReadAccess:{version:1,checkedAt:stamp,appId:'11111111-1111-4111-8111-111111111111',appSlug:'fixture',declaredOrgSlug:'owner',tokenFingerprint:'a'.repeat(64),identity:'app_verified_org_declared'}});
  assert.equal(accountNextStep(deno,1,false),'只读验证完成 · 发布未启用');
});

test('empty accounts page keeps a no-account path and labels secondary channels as non-publishing',()=>{
  const markup=renderToStaticMarkup(createElement(AccountsPage,{data:snapshot(),disabled:false,onImport:()=>{},onEdit:()=>{},onDelete:()=>{},onAction:noop,onSetup:()=>{}}));
  assert.match(markup,/连接账号/);
  // Which platforms need a first connection is shown on the platforms tab and in the connection guide.
  assert.match(markup,/不必先注册所有平台/);
  assert.match(markup,/先添加网站/);
  assert.doesNotMatch(markup,/逐项连接发布账号/);
});

test('a saved here.now identity has explicit management actions and summary routing to that account',()=>{
  const localId='33333333-3333-4333-8333-333333333333',remoteId='55555555-5555-4555-8555-555555555555';
  const saved=account('here-now',{id:localId,credentialKind:'api_token',username:remoteId,displayName:'here.now owner',hereNow:{version:1,checkedAt:stamp,accountId:remoteId,keyFingerprint:'a'.repeat(64),identity:'verified_personal'}});
  const data=snapshot([saved]),row=connectionOverview(data).find(item=>item.id==='here-now');assert.ok(row);assert.equal(row.state,'connected');assert.equal(row.attentionAccountId,localId);assert.deepEqual(connectionAction(row),{kind:'connect',label:'管理现有连接'});
  const markup=renderToStaticMarkup(createElement(AccountsPage,{data,disabled:false,onImport:()=>{},onEdit:()=>{},onDelete:()=>{},onAction:noop,onSetup:()=>{}}));
  assert.match(markup,/管理 here\.now 页面与网站关联/);assert.match(markup,/使用已保存 key 重新验证 here\.now/);
  const drawer=renderToStaticMarkup(createElement(HereNowConnection,{data,disabled:false,account:saved,onClose:()=>{},onAction:noop}));assert.match(drawer,/用已保存 key 验证并更新/);assert.doesNotMatch(drawer,/disabled=""[^>]*>用已保存 key 验证并更新/);
});

test('email connection drawers retain the original pending identity and unknown requests cannot resend',()=>{
  for(const stage of ['code_sent','request_unknown','verify_unknown'] as const){
    const original=account('here-now',{status:'needs_verification',hasPassword:false,hereNowEmail:{version:1,emailHash:'a'.repeat(64),requestedAt:stamp,keyName:'site-publishing',stage}});
    const markup=renderToStaticMarkup(createElement(HereNowConnection,{data:snapshot([original]),disabled:false,account:original,onClose:()=>{},onAction:noop}));
    assert.doesNotMatch(markup,/>请求一次验证码</);
    assert.match(markup,/<input(?=[^>]*aria-label="here.now 收件邮箱")(?=[^>]*disabled="")(?=[^>]*value="owner@example.test")[^>]*>/);
    if(stage==='code_sent'){
      assert.equal(accountNextStep(original,0,true),'验证码已发送 · 等待原邮箱验证');
      assert.match(markup,/本机本轮等待已结束/);
      assert.match(markup,/为原账号重新取码/);
    }else {
      assert.equal(accountNextStep(original,0,true),'原连接待核对 · 不会重复请求验证码');
      assert.doesNotMatch(markup,/为原账号重新取码/);
    }
  }
  const shiply=renderToStaticMarkup(createElement(ShiplyConnection,{data:snapshot(),disabled:false,onClose:()=>{},onAction:noop}));
  assert.doesNotMatch(shiply,/当前平台停用/);
  assert.match(shiply,/收信邮箱通过测试/);
});

test('a saved Plopino identity exposes account-row management and email-password revalidation',()=>{
  const localId='66666666-6666-4666-8666-666666666666';
  const saved=account('plopino',{id:localId,credentialKind:'api_token',username:'publisher_1',displayName:'Plopino publisher',publicationUrl:'https://plopino.com/b'});
  const data=snapshot([saved]),row=connectionOverview(data).find(item=>item.id==='plopino');assert.ok(row);assert.equal(row.state,'connected');assert.equal(row.attentionAccountId,localId);assert.deepEqual(connectionAction(row),{kind:'connect',label:'管理现有连接'});
  const markup=renderToStaticMarkup(createElement(AccountsPage,{data,disabled:false,onImport:()=>{},onEdit:()=>{},onDelete:()=>{},onAction:noop,onSetup:()=>{}}));
  assert.match(markup,/管理 Plopino 网站关联/);assert.match(markup,/用邮箱和密码重新验证 Plopino/);assert.doesNotMatch(markup,/更新 Plopino 令牌/);
});

test('connection guide starts with platform search and contains no credential field',()=>{
  const markup=renderToStaticMarkup(createElement(AccountConnectionGuide,{connections:connectionOverview(snapshot()),disabled:false,hasSites:false,onClose:()=>{},onConnect:()=>{},onLocate:()=>{},onImport:()=>{},onAddSite:()=>{}}));
  assert.match(markup,/aria-label="搜索连接平台"/);
  assert.match(markup,/role="listbox"/);
  assert.match(markup,/导入普通账号/);
  assert.match(markup,/保存后仍需确认平台状态/);
  assert.doesNotMatch(markup,/type="password"/);
});

test('Hive connector contains only Hive credentials after platform selection',()=>{
  const markup=renderToStaticMarkup(createElement(ArticleConnection,{data:snapshot(),disabled:false,initialChannel:'hive',onClose:()=>{},onAction:noop}));
  assert.match(markup,/aria-label="Hive 发布专用密钥"/);
  assert.doesNotMatch(markup,/aria-label="Paper\.wf 发布账号"/);
});


test('an account shared by three websites is marked without changing its connections',()=>{
 const owner=account('product-hunt');
 const sites=Array.from({length:3},(_,index)=>({id:`site-${index}`,domain:`site-${index}.example.com`,url:`https://site-${index}.example.com/`,email:'owner@example.com',name:`Site ${index}`,description:'fixture',category:'general' as const,language:'zh',monthlyTarget:2,status:'ready' as const,createdAt:stamp}));
 const data=snapshot([owner],sites);
 data.accountBindings=sites.map(site=>({id:`binding-${site.id}`,accountId:owner.id,channelId:owner.channelId,siteId:site.id,createdAt:stamp,updatedAt:stamp}));
 const render=()=>renderToStaticMarkup(createElement(AccountsPage,{data,disabled:false,onImport:()=>{},onEdit:()=>{},onDelete:()=>{},onAction:noop,onSetup:()=>{}}));
 assert.match(render(),/class="account-shared-warning"/);
 assert.match(render(),/这个账号用于 3 个网站，容易被平台关联/);
 data.accountBindings=data.accountBindings.slice(0,2);
 assert.doesNotMatch(render(),/class="account-shared-warning"/);
 assert.equal(data.accounts[0].id,owner.id);
});
