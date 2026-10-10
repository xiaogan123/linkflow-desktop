import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Account,Channel,Snapshot} from '../src/shared/types';
import {connectionOverview} from '../src/ui/channel-connections';
import {channelOnboardingView} from '../src/ui/channel-onboarding';
import {AccountsPage,MarkestConnection,markestConnectionPayload} from '../src/ui/pages/AccountsPage';

const checkedAt='2026-10-09T12:00:00.000Z';
const fingerprint='a'.repeat(64);

function channel(id:string,enabled:boolean,automation:Channel['automation']='manual'):Channel{
  return {id,name:id==='markest'?'Markest':id,domain:`${id}.example`,url:`https://${id}.example/`,submitUrl:`https://${id}.example/submit`,categories:['general'],languages:['zh','en'],kind:'article',emailRequired:false,accountRequired:true,articleRequired:true,free:'unknown',freeNote:'待核实',automation,quality:'C',qualityReason:'fixture',provenance:'built-in',evidenceStatus:'source_checked',rulesUrl:`https://${id}.example/rules`,checkedAt,notes:'fixture',allowedHosts:[`${id}.example`],enabled};
}

function snapshot(accounts:Account[]=[],accountBindings:Snapshot['accountBindings']=[]):Snapshot{
  return {
    sites:[{id:'site-1',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'fixture',category:'general',language:'zh',monthlyTarget:2,status:'ready',createdAt:checkedAt}],
    tasks:[],
    channels:[channel('markest',false),channel('github-gist',true,'api'),channel('telegraph',true,'api')],
    accounts,accountBindings,mailboxes:[],events:[],
    settings:{provider:'codex',codexPath:'codex',model:'',articleReviewMode:'ai',apiBase:'',hasApiKey:false,autoRun:true,launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},
    runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:false,version:'fixture',platform:'darwin-arm64',dataPath:'fixture',aiCallsToday:0},
  };
}

function validMarkestAccount():Account{
  return {id:'markest-account',channelId:'markest',email:'declared@example.com',displayName:'个人发布账户',username:`local-key:${fingerprint}`,source:'imported',credentialKind:'api_token',status:'unknown',hasPassword:true,createdAt:checkedAt,updatedAt:checkedAt,markestReadAccess:{version:1,checkedAt,keyFingerprint:fingerprint,identity:'user_declared'}};
}

const noopAction=<T,>(_command:string,_payload?:unknown,_success?:string)=>Promise.resolve(undefined as T|undefined);
const pageProps={disabled:false,onImport:()=>{},onEdit:()=>{},onDelete:()=>{},onAction:noopAction,onSetup:()=>{}};

test('Markest onboarding is an existing-account flow with dated official evidence',()=>{
  const view=channelOnboardingView(channel('markest',false));
  assert.equal(view.kind,'existing_account');
  assert.match(view.setup,/邮箱注册.*邮件验证/);
  assert.match(view.setup,/create_paste、list_own、read_own/);
  assert.match(view.setup,/不证明远端身份或发布权限/);
  assert.deepEqual(view.verification,{checkedAt:'2026-10-09',sourceUrl:'https://marke.st/api'});
});

test('disabled Markest directory still exposes the read-only connection entry',()=>{
  const data=snapshot();
  const row=connectionOverview(data).find(item=>item.id==='markest');
  assert.ok(row);
  assert.equal(row.state,'first_connection');
  assert.equal(row.connectedCount,0);
  assert.match(row.detail,/仅验证读取，发布未启用/);
  const markup=renderToStaticMarkup(createElement(AccountsPage,{...pageProps,data}));
  assert.match(markup,/Markest/);
  assert.match(markup,/只读验证个人 key/);
  assert.match(markup,/发布未启用/);
  assert.match(markup,/只读验证不代表远端身份、个人或工作区归属、免费计划或公开写入权限/);
});

test('only the dedicated Markest read proof produces a read-only state and its fingerprint never reaches SSR',()=>{
  const account=validMarkestAccount();
  const data=snapshot([account],[{id:'binding-1',siteId:'site-1',channelId:'markest',accountId:account.id,createdAt:checkedAt,updatedAt:checkedAt}]);
  const row=connectionOverview(data).find(item=>item.id==='markest');
  assert.ok(row);
  assert.equal(row.state,'read_only');
  assert.equal(row.connectedCount,1);
  assert.equal(row.boundSiteCount,1);
  assert.match(row.detail,/仅验证读取，发布未启用.*邮箱和身份由你声明/);
  const page=renderToStaticMarkup(createElement(AccountsPage,{...pageProps,data}));
  assert.match(page,/只读已验证/);
  assert.match(page,/用户声明身份，发布未启用/);
  assert.doesNotMatch(page,/已连接的 API 身份/);
  assert.doesNotMatch(page,new RegExp(fingerprint));
  assert.doesNotMatch(page,/local-key:/);
  const drawer=renderToStaticMarkup(createElement(MarkestConnection,{data,disabled:false,account,onClose:()=>{},onAction:noopAction}));
  assert.match(drawer,/create_paste、list_own、read_own/);
  assert.match(drawer,/aria-label="Markest 个人 API key"[^>]*type="password"[^>]*autoComplete="new-password"/);
  assert.match(drawer,/换 key 会建立新连接/);
  assert.doesNotMatch(drawer,new RegExp(fingerprint));
  assert.doesNotMatch(drawer,/local-key:/);
});

test('registered status and forged remote-identity fields cannot make Markest look automatic or usable',()=>{
  const valid=validMarkestAccount();
  const candidates:Account[]=[
    {...valid,id:'registered',status:'registered'},
    {...valid,id:'verified',verifiedAt:checkedAt},
    {...valid,id:'publication',publicationUrl:'https://marke.st/p/claimed'},
    {...valid,id:'mismatch',username:`local-key:${'b'.repeat(64)}`},
  ];
  for(const account of candidates){
    const data=snapshot([account]);
    const row=connectionOverview(data).find(item=>item.id==='markest');
    assert.ok(row,account.id);
    assert.equal(row.state,'attention',account.id);
    assert.equal(row.connectedCount,0,account.id);
    assert.doesNotMatch(row.detail,/自动可用|已连接|自动发布/,account.id);
    assert.match(row.detail,/发布仍未启用/,account.id);
    if(account.id==='registered'){
      const markup=renderToStaticMarkup(createElement(AccountsPage,{...pageProps,data}));
      assert.match(markup,/<strong>0<\/strong> 已验证身份/);
      assert.match(markup,/只读连接待检查/);
    }
  }
});

test('Markest payload is minimal while established Telegraph and Gist behavior stays unchanged',()=>{
  assert.deepEqual(markestConnectionPayload('  mk_live_'+('f'.repeat(48))+'  ',' declared@example.com ',' 个人连接 ',['site-1','site-1'],'account-1'),{apiKey:'mk_live_'+('f'.repeat(48)),declaredEmail:'declared@example.com',label:'个人连接',siteIds:['site-1'],accountId:'account-1'});
  assert.deepEqual(markestConnectionPayload('mk_live_'+('e'.repeat(48)),'a@example.com','新增连接',[]),{apiKey:'mk_live_'+('e'.repeat(48)),declaredEmail:'a@example.com',label:'新增连接',siteIds:[]});
  const gist:Account={id:'gist',channelId:'github-gist',email:'',username:'owner',credentialKind:'api_token',status:'registered',hasPassword:true,source:'imported',createdAt:checkedAt};
  const rows=connectionOverview(snapshot([gist],[{id:'gist-binding',siteId:'site-1',channelId:'github-gist',accountId:gist.id,createdAt:checkedAt,updatedAt:checkedAt}]));
  assert.equal(rows.find(item=>item.id==='github-gist')?.state,'connected');
  assert.equal(rows.find(item=>item.id==='telegraph')?.state,'no_setup');
});
