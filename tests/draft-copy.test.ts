import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {copyDraftValue,DraftCopyActions} from '../src/ui/pages/DraftCopyActions';
import {createDraftClipboardHandler} from '../src/main/draft-clipboard';
import type {Task} from '../src/shared/types';

const TASK_ID='11111111-1111-4111-8111-111111111111';
const task=(patch:Partial<Task>={}):Task=>({
  id:TASK_ID,siteId:'22222222-2222-4222-8222-222222222222',channelId:'manual-fixture',sourceDomain:'publisher.example',status:'needs_input',createdAt:'2026-10-10T00:00:00.000Z',scheduledAt:'2026-10-10T00:00:00.000Z',updatedAt:'2026-10-10T00:00:00.000Z',attempts:0,message:'Synthetic draft',draft:{title:'Saved title',description:'Saved summary',body:'Saved body'},...patch,
});

function clipboardFixture(tasks:Task[]=[task()]){
  const expectedURL='file:///app/index.html',mainFrame={url:expectedURL},webContents={mainFrame},window={isDestroyed:()=>false,webContents},writes:string[]=[];
  const handler=createDraftClipboardHandler({getWindow:()=>window,getRenderURL:()=>expectedURL,getTasks:()=>tasks,writeText:value=>{writes.push(value)}});
  return {handler,writes,event:{sender:webContents,senderFrame:mainFrame},mainFrame,webContents};
}

test('draft copy actions expose one explicit button for each editable field',()=>{
  const markup=renderToStaticMarkup(createElement(DraftCopyActions,{taskId:TASK_ID,title:'Edited title',description:'Edited summary',body:'Edited body'}));
  assert.match(markup,/aria-label="复制稿件内容"/);
  assert.match(markup,/复制标题/);
  assert.match(markup,/复制简介/);
  assert.match(markup,/复制正文/);
});

test('successful copy writes the exact current edit and reports the selected field',async()=>{
  const writes:string[]=[],feedback:unknown[]=[];
  await copyDraftValue('body','  Current edited body\n',async value=>{writes.push(value)},value=>feedback.push(value));
  assert.deepEqual(writes,['  Current edited body\n']);
  assert.deepEqual(feedback,[{kind:'success',message:'正文已复制。'}]);
});

test('empty fields and unavailable Clipboard API fail clearly without attempting a write',async()=>{
  let writes=0;
  const empty:unknown[]=[],unsupported:unknown[]=[];
  await copyDraftValue('title',' \n ',async()=>{writes+=1},value=>empty.push(value));
  await copyDraftValue('description','Edited summary',undefined,value=>unsupported.push(value));
  assert.equal(writes,0);
  assert.deepEqual(empty,[{kind:'error',message:'标题为空，暂无内容可复制。'}]);
  assert.deepEqual(unsupported,[{kind:'error',message:'当前环境不支持复制，请手动选中内容。'}]);
});

test('clipboard rejection reports a safe message without exposing the raw error',async()=>{
  const feedback:unknown[]=[];
  await copyDraftValue('title','Edited title',async()=>{throw new Error('account-secret-from-runtime')},value=>feedback.push(value));
  assert.deepEqual(feedback,[{kind:'error',message:'标题复制失败，请手动选中内容。'}]);
  assert.doesNotMatch(JSON.stringify(feedback),/account-secret-from-runtime/);
});

test('a stale completion cannot replace feedback from the latest copy request',async()=>{
  let releaseFirst!:()=>void,latest=1;
  const firstWrite=new Promise<void>(resolve=>{releaseFirst=resolve}),feedback:unknown[]=[];
  const first=copyDraftValue('title','First edit',()=>firstWrite,value=>feedback.push(value),()=>latest===1);
  latest=2;
  await copyDraftValue('body','Second edit',async()=>{},value=>feedback.push(value),()=>latest===2);
  releaseFirst();
  await first;
  assert.deepEqual(feedback,[{kind:'success',message:'正文已复制。'}]);
});

test('completion after the view is disposed does not commit feedback',async()=>{
  let active=true,release!:()=>void;
  const write=new Promise<void>(resolve=>{release=resolve}),feedback:unknown[]=[];
  const pending=copyDraftValue('description','Edited summary',()=>write,value=>feedback.push(value),()=>active);
  active=false;
  release();
  await pending;
  assert.deepEqual(feedback,[]);
});

test('trusted main-frame draft copy accepts an unsaved current edit and reaches only the injected OS write boundary',async()=>{
  const fixture=clipboardFixture();
  assert.deepEqual(await fixture.handler(fixture.event,{id:TASK_ID,field:'body',value:'Unsaved current edit\nline 2'}),{ok:true});
  assert.deepEqual(fixture.writes,['Unsaved current edit\nline 2']);
});

test('unknown senders, non-main frames, and unexpected renderer URLs are denied without writes',async()=>{
  const unknown=clipboardFixture();
  assert.equal((await unknown.handler({sender:{},senderFrame:unknown.mainFrame},{id:TASK_ID,field:'title',value:'Edited title'})).ok,false);
  assert.deepEqual(unknown.writes,[]);
  const subframe=clipboardFixture();
  assert.equal((await subframe.handler({sender:subframe.webContents,senderFrame:fixtureFrame('file:///app/index.html')},{id:TASK_ID,field:'title',value:'Edited title'})).ok,false);
  assert.deepEqual(subframe.writes,[]);
  const navigated=clipboardFixture();
  navigated.mainFrame.url='https://remote.example/frame';
  assert.equal((await navigated.handler(navigated.event,{id:TASK_ID,field:'title',value:'Edited title'})).ok,false);
  assert.deepEqual(navigated.writes,[]);
});

test('malformed, non-string, oversized, and unknown-task payloads never reach the OS write boundary',async()=>{
  const invalid=[
    {id:TASK_ID,field:'title',value:123},
    {id:TASK_ID,field:'title',value:'x'.repeat(151)},
    {id:TASK_ID,field:'description',value:'x'.repeat(3001)},
    {id:TASK_ID,field:'body',value:'x'.repeat(30001)},
    {id:'33333333-3333-4333-8333-333333333333',field:'body',value:'Unknown task'},
    {id:TASK_ID,field:'body',value:'   '},
  ];
  const fixture=clipboardFixture();
  for(const payload of invalid)assert.equal((await fixture.handler(fixture.event,payload)).ok,false);
  assert.deepEqual(fixture.writes,[]);
});

test('draft copy rejects tasks without a persisted editable draft or with remote work',async()=>{
  for(const blocked of [task({draft:undefined}),task({status:'running'}),task({submittedAt:'2026-10-10T00:01:00.000Z'})]){
    const fixture=clipboardFixture([blocked]);
    assert.equal((await fixture.handler(fixture.event,{id:TASK_ID,field:'body',value:'Edited body'})).ok,false);
    assert.deepEqual(fixture.writes,[]);
  }
});

test('an OS write failure is reduced to a safe response and does not expose runtime details',async()=>{
  const mainFrame={url:'file:///app/index.html'},webContents={mainFrame},window={isDestroyed:()=>false,webContents};
  const handler=createDraftClipboardHandler({getWindow:()=>window,getRenderURL:()=>mainFrame.url,getTasks:()=>[task()],writeText:()=>{throw Error('secret-runtime-detail')}});
  const response=await handler({sender:webContents,senderFrame:mainFrame},{id:TASK_ID,field:'title',value:'Edited title'});
  assert.deepEqual(response,{ok:false,error:'复制请求无效'});
  assert.doesNotMatch(JSON.stringify(response),/secret-runtime-detail/);
});

function fixtureFrame(url:string){return {url}}

test('the draft modal passes live editor state to copy actions and preserves save wiring',async()=>{
  const source=await readFile(new URL('../src/ui/App.tsx',import.meta.url),'utf8');
  assert.match(source,/<DraftCopyActions taskId=\{chosenTask\.id\} title=\{draftTitle\} description=\{draftDescription\} body=\{draftBody\}\/\>/);
  assert.match(source,/task:update-draft.*title:draftTitle,description:draftDescription,body:draftBody/);
  assert.match(source,/<Button variant="primary" type="submit" disabled=\{pending\}>保存草稿<\/Button>/);
});

test('production keeps the global permission deny and routes copy only through the narrow main-process writer',async()=>{
  const [main,preload,actions]=await Promise.all([
    readFile(new URL('../src/main/main.ts',import.meta.url),'utf8'),
    readFile(new URL('../src/main/preload.ts',import.meta.url),'utf8'),
    readFile(new URL('../src/ui/pages/DraftCopyActions.tsx',import.meta.url),'utf8'),
  ]);
  assert.match(main,/setPermissionRequestHandler\(\(_wc,_permission,callback\)=>callback\(false\)\)/);
  assert.doesNotMatch(main,/setPermissionCheckHandler/);
  assert.match(main,/ipcMain\.handle\('linkflow:draft-copy',createDraftClipboardHandler/);
  assert.match(main,/writeText:value=>clipboard\.writeText\(value\)/);
  assert.match(preload,/ipcRenderer\.invoke\('linkflow:draft-copy',payload\)/);
  assert.doesNotMatch(actions,/navigator\.clipboard/);
});
