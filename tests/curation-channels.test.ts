import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS} from '../src/integrations/catalog';
import {channelDiscoveryFor} from '../src/integrations/channel-discovery';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {emptyState} from '../src/main/store';
import {channelAutomationKind} from '../src/ui/channel-automation';
import {channelOnboardingView} from '../src/ui/channel-onboarding';
import {belongsToSource,verifyLink} from '../src/integrations/web';
import type {Site} from '../src/shared/types';

const ids=['carrd','wakelet','padlet'];
const site:Site={id:'site',domain:'publisher.example',url:'https://publisher.example/',email:'owner@publisher.example',name:'安全教育',description:'原创钱包安全知识和有来源的工具指南',category:'finance',language:'zh',monthlyTarget:2,status:'ready',createdAt:'2026-10-10'};
const resolve=async()=>[{address:'8.8.8.8',family:4}];
const page={status:200,headers:{'content-type':'text/html'},body:Buffer.from('<a href="https://publisher.example/guide" rel="nofollow ugc">Guide</a>')};

test('resource channels permit relevant material preparation without granting automatic execution',()=>{
  const state=emptyState();state.sites=[site];
  for(const id of ids){
    const channel=CHANNELS.find(c=>c.id===id)!;
    assert(channel,id);
    const discovery=channelDiscoveryFor(site,channel);
    assert.equal(discovery.canQueue,true,id);
    assert.equal(discovery.executionReady,false,id);
    assert.equal(channelExecutionReadiness(state,site.id,channel).kind,'manual',id);
    assert.equal(channelAutomationKind(channel),'manual',id);
    const setup=channelOnboardingView(channel);
    assert.equal(setup.kind,'existing_account',id);
    assert.match(setup.setup,/本人/);
    assert.equal(channelOnboardingView({...channel,provenance:'custom'}).kind,'unknown');
    assert.equal(channelDiscoveryFor(site,{...channel,enabled:false}).canQueue,false,id);
  }
});

test('free manual guidance keeps policy and verification gaps visible',()=>{
  const channel=(id:string)=>CHANNELS.find(c=>c.id===id)!;
  assert.match(channel('padlet').notes,/禁止程序化或系统化注册、发帖及主要返佣营销/);
  assert.match(channel('carrd').notes,/禁止薄返佣页/);
  assert.match(channel('raindrop').notes,/连接入口已经准备好.*保持停用/);
  for(const id of ['carrd','wakelet','padlet'])assert.match(channel(id).notes,/HTTP 核验/);
  assert.match(channel('wakelet').freeNote,/3 个合集、每合集 50 项/);
  assert.match(channel('padlet').freeNote,/API 属于付费/);
});

test('Raindrop exposes a real connection path without claiming live acceptance',()=>{
  const channel=CHANNELS.find(item=>item.id==='raindrop')!;
  assert.equal(channel.automation,'api');
  assert.equal(channel.enabled,false);
  assert.equal(channel.contentFormat,'social');
  assert.equal(channelAutomationKind(channel),'disabled');
  assert.equal(channelOnboardingView(channel).kind,'existing_account');
  assert.match(channelOnboardingView(channel).setup,/开启描述\/摘要.*Test token/);
  assert.match(channel.notes,/首篇实发.*匿名读回验收/);
  assert.match(channel.notes,/不会自动注册、改变合集公开性/);
});

test('public hosting domains are distinct from builder entry URLs and accept their actual subdomains',async()=>{
  for(const [id,host,home] of [['carrd','carrd.co','carrd.com'],['raindrop','raindrop.page','raindrop.io']]){
    const channel=CHANNELS.find(c=>c.id===id)!;
    assert.equal(channel.domain,host);
    assert.equal(new URL(channel.url).hostname,home);
    assert(channel.allowedHosts.includes(new URL(channel.submitUrl).hostname));
    const url=`https://publisher.${host}/resources`;
    assert.equal(belongsToSource(url,channel.domain),true);
    const result=await verifyLink(url,site.url,channel.domain,undefined,{resolve,request:async()=>page});
    assert.equal(result.found,true,id);assert.equal(result.rel,'nofollow ugc');
  }
});

test('public source additions do not accept lookalikes, unrelated hosts, or cross-service redirects',async()=>{
  for(const host of ['carrd.co','raindrop.page']){
    for(const url of [`https://publisher.${host}.evil.example/`,`https://evil${host}/`,'https://publisher.example/']){
      let calls=0;
      const result=await verifyLink(url,site.url,host,undefined,{resolve,request:async()=>{calls++;return page}});
      assert.equal(result.outcome,'invalid',url);assert.equal(calls,0);
    }
    let calls=0;
    const result=await verifyLink(`https://publisher.${host}/resources`,site.url,host,undefined,{resolve,request:async()=>++calls===1?{status:302,headers:{location:'https://other.example/resources'},body:Buffer.alloc(0)}:page});
    assert.equal(result.found,false);assert.equal(result.outcome,'invalid');
  }
});
