import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {load} from 'cheerio';
import {GitBookConnection,gitBookConnectionPayload} from '../src/ui/pages/GitBookConnection';
import {CHANNELS} from '../src/integrations/catalog';
import type {Snapshot,Site} from '../src/shared/types';
const site:Site={id:'11111111-1111-4111-8111-111111111111',url:'https://software.example/',domain:'software.example',name:'Software',email:'owner@example.com',description:'Original software documentation',category:'software',language:'en',monthlyTarget:2,status:'ready',createdAt:'2026-10-24T01:00:00.000Z'};
const data={sites:[site],channels:CHANNELS,accountBindings:[]} as unknown as Snapshot;
const noop=<T,>()=>Promise.resolve(undefined as T|undefined);
test('GitBook default connection asks for a protected token and website, not three remote IDs',()=>{
 const html=renderToStaticMarkup(createElement(GitBookConnection,{data,disabled:false,onClose:()=>{},onAction:noop})), $=load(html);
 assert.equal($('input[type=password]').length,1);assert.equal($('input[aria-label="GitBook 组织 ID"]').length,0);
 assert.equal($('input[aria-label="GitBook 文档站 ID"]').length,0);assert.equal($('input[aria-label="GitBook 内容空间 ID"]').length,0);
 assert.equal($('input[type=radio]').attr('name'),'gitbook-site');
 assert.equal($('button').filter((_,el)=>$(el).text()==='连接并保存').attr('disabled')!==undefined,true);
 assert.match(html,/检查不会发文或开通付费方案/);assert.match(html,/稿件仍须通过检查并按计划发布/);
});
test('GitBook payload uses discovery by default and separates local website from remote site',()=>{
 assert.deepEqual(gitBookConnectionPayload(' synthetic-token ',site.id),{token:'synthetic-token',siteIds:[site.id]});
 assert.deepEqual(gitBookConnectionPayload(' synthetic-token ',site.id,'existing-account',{organizationId:' org1 ',siteId:' remote-site ',spaceId:' space1 '}),{token:'synthetic-token',siteIds:[site.id],accountId:'existing-account',organizationId:'org1',siteId:'remote-site',spaceId:'space1'});
 assert.throws(()=>gitBookConnectionPayload(' ',site.id));assert.throws(()=>gitBookConnectionPayload('token',''));
 assert.throws(()=>gitBookConnectionPayload('token',site.id,undefined,{organizationId:'org1',siteId:'',spaceId:'space1'}));
});
