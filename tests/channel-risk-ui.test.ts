import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PlatformDetail} from '../src/ui/pages/PlatformsPage';
import {emptyState} from '../src/main/store';
import {platformRows} from '../src/ui/platforms-model';
import type {Snapshot} from '../src/shared/types';
import {HackmdConnection} from '../src/ui/pages/HackmdConnection';
import {CHANNELS} from '../src/integrations/catalog';

test('WordPress.com platform details render the machine-generated SEO and affiliate policy risk',()=>{
 const render=(id:string)=>{
  const data={...emptyState(),channels:[CHANNELS.find(channel=>channel.id===id)!],accounts:[],accountBindings:[],tasks:[]} as unknown as Snapshot;
  return renderToStaticMarkup(createElement(PlatformDetail,{row:platformRows(data,undefined,[])[0],data,links:[],disabled:true,onAction:async()=>undefined,onTask:()=>{},onConnect:()=>{},onClose:()=>{}}));
 };
 const wordpress=render('wordpress-com');
 assert.match(wordpress,/<dt>条款风险<\/dt>/);
 assert.match(wordpress,/machine-generated content/);
 assert.match(wordpress,/提升 SEO/);
 assert.doesNotMatch(render('yeetmd'),/<dt>条款风险<\/dt>/);
});

test('HackMD connection presents current platform wording without a technical eyebrow',()=>{
 const markup=renderToStaticMarkup(createElement(HackmdConnection,{
  data:null,disabled:false,onClose:()=>{},onAction:async()=>undefined,
 }));
 assert.match(markup,/连接 HackMD/);
 assert.match(markup,/本人密钥/);
 assert.match(markup,/检查链接/);
 assert.doesNotMatch(markup,/HACKMD \/|API token|API 设置|渠道|核验|独立审核|额度|系统推进|只加密保存在本机/);
});
