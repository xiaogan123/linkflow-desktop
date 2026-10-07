import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS,matchChannels} from '../src/integrations/catalog';
import {eligibilityFor} from '../src/integrations/eligibility';
import {composeChannels,saveCustomChannel,deleteCustomChannel,importChannelMetrics} from '../src/integrations/channel-library';
import type {Site} from '../src/shared/types';
const site:Site={id:'site',domain:'example.com',url:'https://example.com',email:'owner@example.com',name:'Recipes',description:'Cooking and recipes',category:'content',language:'en',monthlyTarget:2,status:'ready',createdAt:'2026-01-01'};
const channel=(id:string)=>CHANNELS.find(c=>c.id===id)!;
const draft={name:'Example directory',domain:'directory.example.com',submitUrl:'https://directory.example.com/submit',categories:['software'],languages:['en'],kind:'directory',free:'unknown',freeNote:'需要向平台确认',rulesUrl:'https://directory.example.com/rules',notes:'仅提交本人真实的软件产品'};

test('one general software URL never grants incompatible package or extension qualifications',()=>{
 const s={...site,category:'software' as const,qualifications:{software:'https://example.com/product'}};
 for(const id of ['fdroid','firefox-addons','vscode-marketplace','jetbrains-marketplace','npm','pypi','pub-dev','wordpress-plugins'])assert.equal(eligibilityFor(s,channel(id)).eligible,false,id);
 assert.equal(eligibilityFor(s,channel('product-hunt')).eligible,true);
 s.qualifications={...s.qualifications,firefoxExtension:'https://example.com/firefox'} as typeof s.qualifications;
 assert.equal(eligibilityFor(s,channel('firefox-addons')).eligible,true);
 assert.equal(eligibilityFor(s,channel('vscode-marketplace')).eligible,false);
});
test('general content does not match technology editorial channels without a declaration',()=>{
 assert.equal(matchChannels(site,CHANNELS).some(x=>x.channel.id==='hashnode'),false);
 assert.equal(eligibilityFor(site,channel('hackernoon')).eligible,false);
 const technical={...site,category:'developer' as const,qualifications:{techContent:'https://example.com/tutorial'}};
 assert.equal(eligibilityFor(technical,channel('hashnode')).eligible,true);
});
test('custom channels stay manual and cannot replace built-in destinations',()=>{
 const saved=saveCustomChannel([],draft,CHANNELS);const c=saved[0];
 assert.match(c.id,/^custom-/);assert.equal(c.automation,'manual');assert.equal(c.evidenceStatus,'user_added');assert.equal(c.checkedAt,'');
 assert.throws(()=>saveCustomChannel([], {...draft,automation:'browser'},CHANNELS));
 assert.throws(()=>saveCustomChannel([], {...draft,domain:'github.com',submitUrl:'https://github.com/profile'},CHANNELS));
 assert.throws(()=>saveCustomChannel([], {...draft,submitUrl:'https://other.example.com/submit'},CHANNELS));
 assert.throws(()=>saveCustomChannel([], {...draft,rulesUrl:'https://user:secret@directory.example.com/rules'},CHANNELS));
 assert.equal(composeChannels(CHANNELS,saved).length,CHANNELS.length+1);
 assert.throws(()=>deleteCustomChannel(saved,c.id,[c.id]));assert.equal(deleteCustomChannel(saved,c.id).length,0);
});
test('metrics require source, real date, correct scope and known channel; partial imports preserve other metrics',()=>{
 const a={name:'Example provider score',value:42,source:'https://metrics.example.com/domain',asOf:'2026-09-01',scope:'domain' as const};
 let m=importChannelMetrics({},[{channelId:'telegraph',authority:a}],CHANNELS);
 m=importChannelMetrics(m,[{channelId:'telegraph',traffic:{monthly:0,source:'https://metrics.example.com/traffic',asOf:'2026-09-01',period:'2026-08',metric:'visits'}}],CHANNELS);
 assert.equal(m.telegraph.authority?.value,42);assert.equal(m.telegraph.traffic?.monthly,0);assert.equal(m.telegraph.traffic?.estimated,true);
 assert.throws(()=>importChannelMetrics({},[{channelId:'unknown',authority:a}],CHANNELS));
 assert.throws(()=>importChannelMetrics({},[{channelId:'telegraph',authority:{...a,source:''}}],CHANNELS));
 assert.throws(()=>importChannelMetrics({},[{channelId:'telegraph',authority:{...a,asOf:'2026-02-30'}}],CHANNELS));
 assert.throws(()=>importChannelMetrics({},[{channelId:'telegraph',authority:a},{channelId:'telegraph',authority:a}],CHANNELS));
 m=importChannelMetrics(m,[{channelId:'telegraph',authority:null}],CHANNELS);assert.equal(m.telegraph.authority,undefined);assert.equal(m.telegraph.traffic?.monthly,0);
 assert.equal(composeChannels(CHANNELS,[],m).find(c=>c.id==='telegraph')?.traffic?.monthly,0);
 assert.equal(composeChannels(CHANNELS).find(c=>c.id==='telegraph')?.traffic,undefined);
});
test('new publishing candidates are explicit about automation, qualification and paid submission',()=>{
 for(const id of ['uneed','wordpress-plugins','drupal','packagist','pub-dev','rubygems','hackernoon','betalist']){
  assert.equal(channel(id).automation,'manual',id);assert.equal(channel(id).checkedAt,'2026-09-28');
 }
 const blogger=channel('blogger');assert.equal(blogger.automation,'api');assert.equal(blogger.checkedAt,'2026-10-04');assert.match(blogger.notes,/OAuth/);assert.match(blogger.notes,/绑定.*博客/);
 assert.equal(channel('paragraph').automation,'api');assert.equal(channel('paragraph').checkedAt,'2026-10-07');assert.equal(channel('betalist').free,'paid');assert.match(channel('paragraph').notes,/禁止以第三方促销/);
});


test('metrics reject encoded credentials and future measurement periods',()=>{
 const base={channelId:CHANNELS[0].id,traffic:{monthly:100,source:'https://example.com/metrics',asOf:'2026-09-01',period:'2026-08'}};
 assert.throws(()=>importChannelMetrics({},[{...base,traffic:{...base.traffic,period:'9999-12'}}],CHANNELS));
 assert.throws(()=>importChannelMetrics({},[{...base,traffic:{...base.traffic,source:'https://example.com/?%74oken=synthetic-canary'}}],CHANNELS));
});
