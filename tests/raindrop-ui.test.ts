import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CHANNELS} from '../src/integrations/catalog';
import {connectionAction} from '../src/ui/account-guidance';
import {connectionOverview,isRaindropConnectionAccount} from '../src/ui/channel-connections';
import {channelAutomationKind,channelAutomationView} from '../src/ui/channel-automation';
import {channelOnboardingView} from '../src/ui/channel-onboarding';
import {eligibleRaindropCollections,raindropConnectionPayload,raindropPublicUrlError} from '../src/ui/pages/RaindropConnection';
import type {Account,Snapshot} from '../src/shared/types';

const at='2026-10-10T00:00:00.000Z';

test('collection selection admits only public owner-level collections bound to the same owner',()=>{
  const result={ownerId:'90071992547409931234',collections:[
    {id:'101',title:'Public',public:true,accessLevel:4,ownerId:'90071992547409931234'},
    {id:'102',title:'Private',public:false,accessLevel:4,ownerId:'90071992547409931234'},
    {id:'103',title:'Shared',public:true,accessLevel:3,ownerId:'90071992547409931234'},
    {id:'104',title:'Other owner',public:true,accessLevel:4,ownerId:'42'},
    {id:'105',title:'Child',public:true,accessLevel:4,ownerId:'90071992547409931234',parentId:'101'},
    {id:'0',title:'Invalid',public:true,accessLevel:4,ownerId:'90071992547409931234'},
  ]};
  assert.deepEqual(eligibleRaindropCollections(result).map(item=>item.id),['101']);
});

test('public URL validation rejects credentials, HTTP and unrelated hosts',()=>{
  assert.equal(raindropPublicUrlError('https://reading.raindrop.page/resources'),'');
  assert.match(raindropPublicUrlError('https://raindrop.io/collection/123'),/Public Page/);
  assert.match(raindropPublicUrlError('https://reading.raindrop.page/'),/合集路径/);
  assert.match(raindropPublicUrlError('https://reading.raindrop.page:444/resources'),/端口/);
  assert.match(raindropPublicUrlError('https://reading.raindrop.page/resources?view=list'),/查询参数/);
  assert.match(raindropPublicUrlError('http://reading.raindrop.page/resources'),/HTTPS/);
  assert.match(raindropPublicUrlError('https://token@reading.raindrop.page/resources'),/用户名或密码/);
  assert.match(raindropPublicUrlError('https://raindrop.page.example/resources'),/Public Page/);
});

test('stored connection proof matches the backend identity and canonical URL boundary',()=>{
  const account:Account={id:'rain-1',channelId:'raindrop',email:'',username:'41',credentialKind:'api_token',status:'registered',hasPassword:true,source:'imported',publicationUrl:'https://reading.raindrop.page/resources',createdAt:at,raindrop:{version:1,ownerId:'41',collectionId:'73',publicUrl:'https://reading.raindrop.page/resources',tokenFingerprint:'a'.repeat(64),tokenVersion:1,connectedAt:at}};
  assert.equal(isRaindropConnectionAccount(account),true);
  assert.equal(isRaindropConnectionAccount({...account,username:'42'}),false);
  assert.equal(isRaindropConnectionAccount({...account,publicationUrl:'https://reading.raindrop.page/resources?list=1',raindrop:{...account.raindrop!,publicUrl:'https://reading.raindrop.page/resources?list=1'}}),false);
});

test('connection payload trims secrets, de-duplicates sites and preserves large string IDs',()=>{
  assert.deepEqual(raindropConnectionPayload(' secret ','90071992547409931234',' https://reading.raindrop.page/resources ',['a','a','b'],'old'),{
    token:'secret',collectionId:'90071992547409931234',publicUrl:'https://reading.raindrop.page/resources',siteIds:['a','b'],accountId:'old',
  });
});

test('catalog and connection directory expose setup while live acceptance remains disabled',()=>{
  const channel=CHANNELS.find(item=>item.id==='raindrop');assert.ok(channel);
  assert.equal(channel.automation,'api');assert.equal(channel.enabled,false);assert.equal(channel.contentFormat,'social');
  assert.equal(channelAutomationKind(channel),'disabled');
  assert.match(channelAutomationView({...channel,enabled:true}).setup??'',/Test token.*Public Page/);
  assert.match(channelOnboardingView(channel).setup,/开启描述\/摘要/);
  const snapshot={accounts:[],accountBindings:[],sites:[],tasks:[],channels:[channel]} as unknown as Snapshot;
  const row=connectionOverview(snapshot).find(item=>item.id==='raindrop');assert.ok(row);
  assert.equal(row.state,'unavailable');assert.match(row.detail,/平台目前停用.*记录都会保留/);
  assert.deepEqual(connectionAction(row),{kind:'connect',label:'连接 Raindrop'});
});

test('drawer keeps the secret in a password field and cancels backend work on close or unmount',()=>{
  const source=readFileSync(new URL('../src/ui/pages/RaindropConnection.tsx',import.meta.url),'utf8');
  assert.match(source,/type="password"/);
  assert.match(source,/account:raindrop-collections/);
  assert.match(source,/account:connect-raindrop/);
  assert.equal((source.match(/account:cancel-raindrop-connect/g)??[]).length>=2,true);
  assert.match(source,/useEffect\(\(\)=>\{\s*alive\.current=true/);
  assert.match(source,/不会替你注册账号/);
  assert.match(source,/不会.*改变合集公开性/);
  assert.match(source,/首次真实发布、匿名读回.*另行验收/);
  assert.doesNotMatch(source,/navigator\.clipboard|type="text"[^>]*Test token/);
});
