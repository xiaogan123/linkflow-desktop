import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {IPC_COMMANDS} from '../src/shared/types';

const mainSource=readFileSync(fileURLToPath(new URL('../src/main/main.ts',import.meta.url)),'utf8');
const messageSource=readFileSync(fileURLToPath(new URL('../src/shared/batch9b-messages.ts',import.meta.url)),'utf8');

test('the one-shot review is an allowlisted IPC command with an explicit paid-call confirmation and cancellation path',()=>{
  assert.equal(IPC_COMMANDS.includes('task:review-once'),true);
  assert.match(mainSource,/case 'task:review-once'/);
  assert.match(mainSource,/title:'追加一次 AI 复核'/);
  assert.match(mainSource,/BATCH9B_MESSAGES\.reviewRetryDetail\(summary\.draftRevision\)/);
  assert.match(messageSource,/原有 2 次调用记录会保留/);
  assert.match(messageSource,/请求开始即计为第 3 次/);
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
