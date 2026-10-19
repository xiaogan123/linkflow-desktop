import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {FirstRunWizard} from '../src/ui/pages/FirstRunWizard';
import {CHANNELS} from '../src/integrations/catalog';
import {emptyState} from '../src/main/store';
import type {Snapshot} from '../src/shared/types';

const snapshot=(aiReady:boolean)=>({...emptyState(),channels:CHANNELS,accounts:[],accountBindings:[],tasks:[],sites:[],runtime:{aiReady,busy:false,vaultReady:true,mailReady:false,version:'0',platform:'darwin',dataPath:'',aiCallsToday:0}}) as unknown as Snapshot;
const props=(data:Snapshot)=>({data,disabled:false,onAction:async()=>undefined,onClose:()=>{},onSettings:()=>{},onConnect:()=>{},onOverview:()=>{}});

test('the first-run guide starts with AI when it is not connected, and skips straight to sites when it is',()=>{
  const fresh=renderToStaticMarkup(createElement(FirstRunWizard,props(snapshot(false))));
  assert.match(fresh,/外链助手用 AI 写稿和复核。/);
  assert.match(fresh,/用本机 Codex/);
  assert.match(fresh,/其他 AI 服务/);
  for(const title of ['连接 AI','添加网站','选择发布方式','值得连一次的平台'])assert.match(fresh,new RegExp(title));
  const ready=renderToStaticMarkup(createElement(FirstRunWizard,props(snapshot(true))));
  assert.match(ready,/每行一个，可以一次粘贴很多个/);
  // The publishing mode is its own step, so the site form does not ask for it here.
  assert.doesNotMatch(ready,/48 小时没看就放弃这篇/);
});
