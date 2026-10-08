import assert from 'node:assert/strict';
import test from 'node:test';
import {CHANNELS,matchChannels} from '../src/integrations/catalog.js';
import type {Site} from '../src/shared/types.js';

const addedIds=['linkedin-company','crunchbase-company','trustpilot-business','bluesky-domain','beehiiv','kit-newsletter','vocus','flipboard-publisher','tradingview-profile'];

function financeSite(language='en'):Site{return {id:'publisher',domain:'publisher.example',url:'https://publisher.example/',email:'owner@publisher.example',name:'Publisher',description:'Original exchange fee and risk education',category:'finance',language,monthlyTarget:2,status:'ready',createdAt:'2026-09-30'}}

test('publisher and brand expansion is evidence-backed and remains manual',()=>{
 assert.equal(CHANNELS.length,80);
 for(const id of addedIds){const channel=CHANNELS.find(item=>item.id===id);assert(channel,id);assert.equal(channel.automation,'manual',id);assert.equal(channel.checkedAt,'2026-09-30',id);assert.equal(channel.evidenceStatus,'rules_checked',id);assert.equal(channel.authority,undefined,id);assert.equal(channel.traffic,undefined,id);assert(channel.rulesUrl.startsWith('https://'),id)}
 const blogger=CHANNELS.find(channel=>channel.id==='blogger');assert(blogger);assert.equal(blogger.automation,'api');assert.match(blogger.notes,/OAuth/);assert.match(blogger.notes,/绑定.*博客/);
 assert.equal(CHANNELS.filter(channel=>channel.automation==='api').length,16);
 const prose=CHANNELS.find(channel=>channel.id==='prose');assert(prose);assert.equal(prose.enabled,false);assert.equal(prose.evidenceStatus,'source_checked');
 assert.equal(CHANNELS.filter(channel=>channel.automation==='browser').length,4);
});

test('new profiles require an owned publication or real business before matching',()=>{
 const plain=financeSite();
 assert.equal(matchChannels(plain,CHANNELS).some(({channel})=>addedIds.includes(channel.id)),false);
 plain.qualifications={publication:'https://publisher.example/about'};
 const publicationMatches=matchChannels(plain,CHANNELS).map(({channel})=>channel.id);
 for(const id of ['beehiiv','kit-newsletter','flipboard-publisher','tradingview-profile'])assert(publicationMatches.includes(id),id);
 assert.equal(publicationMatches.includes('bluesky-domain'),false);
 for(const id of ['linkedin-company','crunchbase-company','trustpilot-business'])assert(!publicationMatches.includes(id),id);
 plain.qualifications.business='https://publisher.example/company';
 const businessMatches=matchChannels(plain,CHANNELS).map(({channel})=>channel.id);
 for(const id of ['linkedin-company','crunchbase-company','trustpilot-business'])assert(businessMatches.includes(id),id);
});

test('native Chinese publishing is scoped to Chinese sites and carries financial safeguards',()=>{
 const english=financeSite('en');english.qualifications={publication:'https://publisher.example/about'};
 assert.equal(matchChannels(english,CHANNELS).some(({channel})=>channel.id==='vocus'),false);
 const chinese=financeSite('zh-Hant');chinese.qualifications={publication:'https://publisher.example/about'};
 assert.equal(matchChannels(chinese,CHANNELS).some(({channel})=>channel.id==='vocus'),false);
 const vocus=CHANNELS.find(channel=>channel.id==='vocus')!;
 assert.match(vocus.notes,/投资理财/);
 assert.match(vocus.notes,/联盟披露/);
 assert.equal(vocus.enabled,false);assert.match(vocus.notes,/不使用本工具生成整篇稿件/);
});

test('affiliate and financial restrictions stay visible in channel notes',()=>{
 assert.match(CHANNELS.find(channel=>channel.id==='beehiiv')!.notes,/禁止推广不受监管的金融服务/);
 assert.match(CHANNELS.find(channel=>channel.id==='beehiiv')!.notes,/以联盟转化或导流为主要目的/);
 assert.match(CHANNELS.find(channel=>channel.id==='kit-newsletter')!.notes,/70–80%/);
 assert.match(CHANNELS.find(channel=>channel.id==='tradingview-profile')!.notes,/不得放广告、站外链接、交易所邀请码/);
 assert.match(CHANNELS.find(channel=>channel.id==='trustpilot-business')!.notes,/不得制造、购买或诱导好评/);
});
