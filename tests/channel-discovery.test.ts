import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS,matchChannels} from '../src/integrations/catalog';
import {channelDiscoveryFor,discoverChannels} from '../src/integrations/channel-discovery';
import {eligibilityFor,requirementsFor} from '../src/integrations/eligibility';
import {channelExecutionReadiness} from '../src/main/account-bindings';
import {emptyState} from '../src/main/store';
import type {Site} from '../src/shared/types';

const channel=(id:string)=>CHANNELS.find(item=>item.id===id)!;
const site=(description='面向中文读者的原创加密风险科普与入门指南'):Site=>({id:'site',domain:'publisher.example',url:'https://publisher.example/',email:'owner@publisher.example',name:'原创科普站',description,category:'finance',language:'zh-hans',monthlyTarget:2,status:'ready',createdAt:'2026-10-01'});

test('finance publication without qualification form gets several honest candidates',()=>{
 const rows=discoverChannels(site(),CHANNELS),byId=new Map(rows.map(item=>[item.channel.id,item]));
 for(const id of ['telegraph','blogger','gravatar','linktree'])assert.notEqual(byId.get(id)?.status,'blocked',id);
 assert.equal(byId.get('telegraph')?.executionReady,true);
 assert.equal(byId.get('blogger')?.channel.automation,'api');
 assert.equal(byId.get('blogger')?.canQueue,true);
 assert.equal(byId.get('gravatar')?.status,'worth_trying');
 assert.equal(byId.get('linktree')?.status,'worth_trying');
 for(const id of ['gravatar','linktree','blogger'])assert.deepEqual(requirementsFor(channel(id)),[],id);
});

test('Blogger stays a base candidate but requires OAuth identity and blog binding before execution',()=>{
 const s=site(),blogger=channel('blogger'),state=emptyState();
 state.sites=[s];
 assert.equal(channelDiscoveryFor(s,blogger).canQueue,true);
 assert.equal(channelExecutionReadiness(state,s.id,blogger).kind,'handoff_required');
 state.accounts.push({id:'account',channelId:'blogger',email:'owner@gmail.com',username:'google-subject',createdAt:'2026-10-01',status:'registered',hasPassword:true,credentialKind:'oauth'});
 assert.equal(channelExecutionReadiness(state,s.id,blogger).kind,'handoff_required','OAuth without a site binding is not ready');
 state.accountBindings.push({id:'binding',siteId:s.id,channelId:'blogger',accountId:'account',createdAt:'2026-10-01',updatedAt:'2026-10-01'});
 assert.equal(channelExecutionReadiness(state,s.id,blogger).kind,'handoff_required','an account binding without a selected blog is not ready');
 s.blogger={blogId:'123456789',url:'https://fixture.blogspot.com/'};
 assert.equal(channelExecutionReadiness(state,s.id,blogger).kind,'ready');
});

test('real developer proof stays visible for a finance tool while topic only affects ranking',()=>{
 const s=site('提供公开浏览器计算工具、技术说明与风险教育');
 s.qualifications={developer:'https://publisher.example/tools'};
 const github=channelDiscoveryFor(s,channel('github'));
 assert.equal(github.status,'worth_trying');
 assert.equal(github.executionReady,true);
 assert.equal(github.canQueue,true);
 assert.equal(matchChannels(s,[channel('github')]).length,1,'real qualification permits adjacent topics; relevance only affects ranking');
});

test('tool wording never invents package or product qualification',()=>{
 const s=site('提供公开浏览器手续费计算工具和操作指南');
 const product=channelDiscoveryFor(s,channel('product-hunt'));
 const npm=channelDiscoveryFor(s,channel('npm'));
 assert.equal(product.status,'needs_preparation');
 assert.equal(product.executionReady,false);
 assert.equal(product.canQueue,true);
 assert.equal(eligibilityFor(s,channel('product-hunt')).eligible,false);
 assert.equal(npm.status,'blocked');
 assert.equal(npm.canQueue,false);
 assert.equal(eligibilityFor(s,channel('npm')).eligible,false);
});

test('affiliate signals keep hosted publication conditions visible without keyword-only rejection',()=>{
 const s=site('提供交易所邀请码、手续费减免和推荐佣金说明');
 for(const id of ['wordpress-com','paragraph']){
  const result=channelDiscoveryFor(s,channel(id));
  assert.equal(result.status,'needs_preparation',id);
  assert.equal(result.canQueue,id!=='paragraph',id);if(id==='paragraph')assert.match(result.nextStep,/账号页连接本人 Paragraph/);
  assert.equal(result.executionReady,false,id);
  assert.match(result.reason,/联盟导流为主要目的/,id);
  assert.match(result.reason,/仅凭网站简介不能判定/,id);
 }
});

test('disabled channels and missing hard business facts remain blocked',()=>{
 assert.equal(channelDiscoveryFor(site(),channel('publish0x')).status,'blocked');
 const company=channelDiscoveryFor(site(),channel('linkedin-company'));
 assert.equal(company.status,'blocked');
 assert.equal(company.canQueue,false);
});

test('translation is a ranking note and paid manual work never becomes automatic',()=>{
 const translatedSite=site();translatedSite.qualifications={techContent:'https://publisher.example/guide'};
 const translated=channelDiscoveryFor(translatedSite,channel('hackernoon'));
 assert.equal(translated.channel.automation,'manual');
 assert.equal(translated.status,'worth_trying');
 assert.equal(translated.canQueue,true);
 assert.equal(translated.executionReady,false);
 assert.match(translated.reason,/语言.*不同/);
 const paid=channelDiscoveryFor(site(),channel('ghost-pro'));
 assert.equal(paid.channel.free,'paid');
 assert.equal(paid.channel.automation,'manual');
 assert.equal(paid.executionReady,false);
});
