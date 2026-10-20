import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {remoteContentTodos} from '../src/shared/batch9b-policy';
import {demoSnapshot} from '../src/ui/demo';
import {OverviewPage} from '../src/ui/pages/WorkspacePages';
import type {Snapshot, Task} from '../src/shared/types';

const live=(id:string,channelId:string,extra:Partial<Task>={})=>({...structuredClone(demoSnapshot.tasks[0]),id,channelId,publicUrl:`https://example.test/${id}`,remoteContentScan:{version:1,checkedAt:'2026-10-20T00:00:00.000Z',referral:true,legacyMarkers:[]},...extra}) as Task;

test('a finding the owner chose to stop being reminded of leaves the to-do list',()=>{
  const open=live('open','telegraph'),quiet=live('quiet','supanote',{remoteContentScan:{version:1,checkedAt:'2026-10-20T00:00:00.000Z',referral:true,legacyMarkers:[],acknowledgedAt:'2026-10-20T01:00:00.000Z'}});
  assert.deepEqual(remoteContentTodos([open,quiet]).map(item=>item.taskId),['open']);
});

test('a Telegraph page offers to remove the coded sentence; an anonymous page offers to stop reminding',()=>{
  const data={...structuredClone(demoSnapshot),tasks:[live('tg','telegraph'),live('sn','supanote')]} as Snapshot;
  data.remoteContentTodos=remoteContentTodos(data.tasks);
  const noop=()=>{};
  const html=renderToStaticMarkup(createElement(OverviewPage,{data,now:new Date(),disabled:false,onAction:async()=>undefined,onSite:noop,onAdd:noop,onTodos:noop,onSettings:noop,onPlatforms:noop,onTask:noop}));
  assert.equal((html.match(/>删掉带码的句子<\/button>/g)??[]).length,1);
  assert.equal((html.match(/>不再提醒<\/button>/g)??[]).length,2);
  assert.match(html,/软件不能修改这个平台上已发布的文章/);
});

import {migrateState,emptyState} from '../src/main/store';
test('Telegraph referral reminders dismissed while ownership could not be confirmed come back once',()=>{
  const state=emptyState();delete (state as {telegraphReminderReset?:1}).telegraphReminderReset;
  const scan=(acknowledgedAt?:string)=>({version:1 as const,checkedAt:'2026-10-20T00:00:00.000Z',referral:true,legacyMarkers:[],...(acknowledgedAt?{acknowledgedAt}:{})});
  state.tasks=[live('tg','telegraph',{remoteContentScan:scan('2026-10-20T05:40:00.000Z')}),live('sn','supanote',{remoteContentScan:scan('2026-10-20T05:41:00.000Z')})];
  const migrated=migrateState(state);
  assert.equal(migrated.tasks.find(task=>task.id==='tg')!.remoteContentScan!.acknowledgedAt,undefined);
  assert.equal(migrated.tasks.find(task=>task.id==='sn')!.remoteContentScan!.acknowledgedAt,'2026-10-20T05:41:00.000Z');
  // Later dismissals stay dismissed.
  migrated.tasks.find(task=>task.id==='tg')!.remoteContentScan!.acknowledgedAt='2026-10-21T00:00:00.000Z';
  assert.equal(migrateState(migrated).tasks.find(task=>task.id==='tg')!.remoteContentScan!.acknowledgedAt,'2026-10-21T00:00:00.000Z');
});
