import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CHANNELS} from '../src/integrations/catalog';
import {connectionOverview} from '../src/ui/channel-connections';
import {AccountsPage} from '../src/ui/pages/AccountsPage';
import {DenoConnection,denoConnectionPayload} from '../src/ui/pages/DenoConnection';
import type {Account,Snapshot,Site} from '../src/shared/types';

const stamp='2026-10-10T00:00:00.000Z',appId='11111111-1111-4111-8111-111111111111';
const site:Site={id:'33333333-3333-4333-8333-333333333333',url:'https://site.example/',domain:'site.example',name:'Fixture',email:'owner@example.com',description:'Fixture',category:'content',language:'en',monthlyTarget:2,status:'ready',createdAt:stamp};
function snapshot(accounts:Account[]=[]):Snapshot{return {sites:[site],tasks:[],channels:CHANNELS,accounts,accountBindings:[],mailboxes:[],events:[],settings:{provider:'codex',codexPath:'codex',model:'',articleReviewMode:'ai',apiBase:'',hasApiKey:false,autoRun:true,launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:false,version:'fixture',platform:'darwin-arm64',dataPath:'fixture',aiCallsToday:0}}}
const noop=<T,>(_cmd:string,_payload?:unknown)=>Promise.resolve(undefined as T|undefined);
const pageProps={disabled:false,onImport:()=>{},onEdit:()=>{},onDelete:()=>{},onAction:noop,onSetup:()=>{}};
const account:Account={id:'44444444-4444-4444-8444-444444444444',channelId:'deno',email:'',displayName:'Dedicated publication',username:appId,source:'imported',credentialKind:'api_token',status:'unknown',hasPassword:true,createdAt:stamp,updatedAt:stamp,denoReadAccess:{version:1,checkedAt:stamp,appId,appSlug:'owner-publication',declaredOrgSlug:'owner-org',tokenFingerprint:'a'.repeat(64),identity:'app_verified_org_declared'}};

test('Deno appears as disabled first-connection route with clear owner steps',()=>{
  const row=connectionOverview(snapshot()).find(item=>item.id==='deno');assert.equal(row?.state,'first_connection');
  const page=renderToStaticMarkup(createElement(AccountsPage,{...pageProps,data:snapshot()}));
  assert.match(page,/Deno Deploy/);assert.match(page,/只读验证专用应用/);assert.match(page,/发布未启用/);
  assert.doesNotMatch(page,/已核实应用 UUID 可读取/);
  assert.match(page,/先由本人登录 Deno，创建专用组织和应用/);
  const drawer=renderToStaticMarkup(createElement(DenoConnection,{data:snapshot(),disabled:false,onClose:()=>{},onAction:noop}));
  assert.match(drawer,/GitHub 或 Google/);assert.match(drawer,/Settings/);assert.match(drawer,/Access Tokens/);
  assert.match(drawer,/应用 API 不返回组织归属证明/);assert.match(drawer,/Deno 组织令牌"[^>]*type="password"/);
  assert.match(drawer,/专为本工具准备的应用/);
});

test('Deno valid account remains read-only and forged ready account is not presented as connected',()=>{
  const row=connectionOverview(snapshot([account])).find(item=>item.id==='deno');assert.equal(row?.state,'read_only');assert.equal(row?.connectedCount,1);
  const page=renderToStaticMarkup(createElement(AccountsPage,{...pageProps,data:snapshot([account])}));
  assert.match(page,/应用 UUID 已只读验证/);assert.match(page,/组织由你声明/);assert.doesNotMatch(page,/已连接的 API 身份/);assert.doesNotMatch(page,/a{64}/);
  const forged={...account,status:'registered'} as Account;
  const issue=connectionOverview(snapshot([forged])).find(item=>item.id==='deno');assert.equal(issue?.state,'attention');assert.equal(issue?.connectedCount,0);
  const invalidPage=renderToStaticMarkup(createElement(AccountsPage,{...pageProps,data:snapshot([forged])}));
  assert.doesNotMatch(invalidPage,/已核实应用 UUID 可读取/);
  assert.match(invalidPage,/本机 Deno 只读连接需重新验证/);
});

test('Deno payload preserves exact selected UUID and explicit dedicated-app confirmation',()=>{
  assert.deepEqual(denoConnectionPayload(' token-1234567890123456 ',appId,' owner-org ',' My app ',[site.id,site.id],account.id),{token:'token-1234567890123456',appId,declaredOrgSlug:'owner-org',label:'My app',siteIds:[site.id],dedicatedAppAcknowledged:true,accountId:account.id});
});
