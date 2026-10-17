import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {IPC_COMMANDS} from '../src/shared/types';

const mainSource=readFileSync(fileURLToPath(new URL('../src/main/main.ts',import.meta.url)),'utf8');

test('the one-shot review is an allowlisted IPC command with an explicit paid-call confirmation and cancellation path',()=>{
  assert.equal(IPC_COMMANDS.includes('task:review-once'),true);
  assert.match(mainSource,/case 'task:review-once'/);
  assert.match(mainSource,/title:'追加一次独立 AI 审核'/);
  assert.match(mainSource,/原有 6 次 AI 调用记录会完整保留/);
  assert.match(mainSource,/最多新增 1 次可能产生费用的 AI 调用/);
  assert.match(mainSource,/buttons:\['取消','确认追加 1 次审核'\]/);
  assert.match(mainSource,/if\(confirm\.response!==1\)return \{cancelled:true\}/);
});

test('the IPC entry rejects overlapping clicks before and after confirmation and calls only the dedicated review action',()=>{
  const entry=mainSource.slice(mainSource.indexOf("case 'task:review-once'"),mainSource.indexOf("case 'task:retry'"));
  assert.equal((entry.match(/activeCommands\.size>1/g)??[]).length,2);
  assert.match(entry,/return controller\.reviewArticleOnce\(id\)/);
  assert.doesNotMatch(entry,/controller\.tick\(/);
  assert.doesNotMatch(entry,/task:generate|task:retry|task:approve/);
});
