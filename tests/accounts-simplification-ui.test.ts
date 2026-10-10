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
  assert.deepEqual(connectionAction(byId('telegraph')),{kind:'none'});
  assert.deepEqual(connectionAction(byId('rentry')),{kind:'none'});
  for(const id of ['mataroa','paper-wf','hive','prose','markest','deno','github-gist','blogger','wordpress-com','leaflet','paragraph','bluesky'])assert.equal(needsDedicatedConnection(id),true,id);
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
  assert.equal(accountNextStep(account('paragraph'),1,false),'连接已保存 · 渠道当前未启用');
  assert.equal(accountNextStep(account('product-hunt',{hasPassword:false}),0,true),'下一步：恢复或重新连接凭据');
  assert.equal(accountNextStep(account('product-hunt',{status:'credentials_invalid',hasPassword:false,diagnostic:{code:'password_missing',message:'fixture',at:stamp,retryable:true}}),0,true),'下一步：处理原连接或平台限制');
  assert.equal(accountNextStep(account('product-hunt',{status:'credentials_invalid',hasPassword:false,diagnostic:{code:'password_missing',message:'fixture',at:stamp,retryable:true}}),0,false),'连接需处理 · 渠道当前未启用');
  assert.equal(accountNextStep(account('product-hunt',{hasPassword:false}),0,false),'凭据需恢复 · 渠道当前未启用');
  const deno=account('deno',{status:'unknown',credentialKind:'api_token',username:'11111111-1111-4111-8111-111111111111',denoReadAccess:{version:1,checkedAt:stamp,appId:'11111111-1111-4111-8111-111111111111',appSlug:'fixture',declaredOrgSlug:'owner',tokenFingerprint:'a'.repeat(64),identity:'app_verified_org_declared'}});
  assert.equal(accountNextStep(deno,1,false),'只读验证完成 · 发布未启用');
});

test('empty accounts page keeps a no-account path and labels secondary channels as non-publishing',()=>{
  const markup=renderToStaticMarkup(createElement(AccountsPage,{data:snapshot(),disabled:false,onImport:()=>{},onEdit:()=>{},onDelete:()=>{},onAction:noop,onSetup:()=>{}}));
  assert.match(markup,/添加 \/ 连接账号/);
  assert.match(markup,/现在不用注册所有平台/);
  assert.match(markup,/需要本人首次连接/);
  assert.match(markup,/任务会自动准备/);
  assert.match(markup,/只读验证或当前未启用/);
  assert.match(markup,/这里的连接不代表可发布/);
  assert.match(markup,/先添加网站/);
  assert.doesNotMatch(markup,/逐项连接发布身份/);
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
  assert.match(markup,/aria-label="Hive 凭据"/);
  assert.doesNotMatch(markup,/aria-label="Paper\.wf 凭据"/);
});
