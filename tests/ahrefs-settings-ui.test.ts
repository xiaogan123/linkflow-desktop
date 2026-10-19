import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {load} from 'cheerio';
import {AhrefsSettingsCard,ahrefsStatusText,saveAhrefsSettings} from '../src/ui/ahrefs-settings';
import {SettingsPage} from '../src/ui/pages/SettingsPage';
import {emptyState} from '../src/main/store';

const action=async<T,>():Promise<T|undefined>=>undefined;

test('Ahrefs status reflects missing, tested, and failed credentials using the required text',()=>{
 assert.equal(ahrefsStatusText({}),'未填写 · 使用内置数据（2026-10）');
 assert.equal(ahrefsStatusText({hasAhrefsKey:true,ahrefsStatus:'connected',ahrefsLastUpdatedAt:new Date(2026,9,18,12).toISOString()}),'已连接 · 上次更新 10月18日');
 assert.equal(ahrefsStatusText({hasAhrefsKey:true,ahrefsStatus:'error'}),'密钥无效或查询次数已用完');
 assert.equal(ahrefsStatusText({hasAhrefsKey:true,ahrefsStatus:'connected',ahrefsLastUpdatedAt:'invalid'}),'密钥无效或查询次数已用完');
});

test('Ahrefs card renders a blank password field, exact instructions, and its own test button',()=>{
 const $=load(renderToStaticMarkup(createElement(AhrefsSettingsCard,{settings:{hasAhrefsKey:true,ahrefsStatus:'error'},disabled:false,onAction:action})));
 assert.equal($('h2').text(),'Ahrefs 密钥（免费）');
 assert.equal($('.settings-heading p').text(),'用来自动查询平台权重（DR）。在 Ahrefs 免费账号的「Account settings → API keys」里生成。不填也能用，会显示内置数据。');
 assert.equal($('input').attr('type'),'password');assert.equal($('input').attr('value'),'');
 assert.equal($('button').text(),'保存并测试');assert.equal($('button').attr('type'),'button');
 assert.equal($('[role="status"]').text(),'密钥无效或查询次数已用完');
});

test('Ahrefs card follows the existing AI settings and obeys the disabled state',()=>{
 const $=load(renderToStaticMarkup(createElement(SettingsPage,{settings:emptyState().settings,setSettings:()=>{},snapshot:null,apiKey:'',setApiKey:()=>{},mailPassword:'',setMailPassword:()=>{},disabled:true,onSave:async()=>true,onAction:action,onResult:()=>{},onBackup:()=>{},onOpenUpdate:()=>{}})));
 const cards=$('.settings-main > .settings-card');
 assert.equal(cards.eq(0).find('h2').text(),'AI');
 assert.equal(cards.eq(1).find('h2').text(),'Ahrefs 密钥（免费）');
 assert.equal(cards.eq(1).find('button').text(),'保存并测试');
 assert.equal(cards.eq(1).find('button').is('[disabled]'),true);
 assert.equal(cards.eq(1).find('input').is('[disabled]'),true);
});


test('empty Ahrefs settings remain unconfigured without invoking a query',async()=>{
 let calls=0;
 const result=await saveAhrefsSettings('   ',{},async()=>{calls++;return undefined});
 assert.equal(result,'unconfigured');assert.equal(calls,0);
});

test('Ahrefs settings submit a new key or retest the saved key through the dedicated command',async()=>{
 const calls:{command:string;payload:unknown}[]=[];
 const onAction=async<T,>(command:string,payload?:unknown):Promise<T|undefined>=>{
  calls.push({command,payload});return {ok:true} as T;
 };
 assert.equal(await saveAhrefsSettings('  sample-key  ',{},onAction),'connected');
 assert.equal(await saveAhrefsSettings('',{hasAhrefsKey:true},onAction),'connected');
 assert.deepEqual(calls,[{command:'ahrefs.saveAndTest',payload:{apiKey:'sample-key'}},{command:'ahrefs.saveAndTest',payload:{apiKey:''}}]);
});

test('failed results, swallowed command errors, and rejected commands report an Ahrefs test failure',async()=>{
 const failed=async<T,>():Promise<T|undefined>=>({ok:false} as T);
 assert.equal(await saveAhrefsSettings('sample-key',{},failed),'error');
 assert.equal(await saveAhrefsSettings('sample-key',{},action),'error');
 assert.equal(await saveAhrefsSettings('sample-key',{},async()=>{throw Error('fixture failure')}),'error');
});
