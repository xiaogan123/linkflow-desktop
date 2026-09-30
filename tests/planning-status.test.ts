import test from 'node:test';
import assert from 'node:assert/strict';
import {hasShortageMessage, monthlyReset, planningStatus} from '../src/ui/planning-status';
import type {Site, Task} from '../src/shared/types';

const site:Site={id:'site-1',domain:'example.com',url:'https://example.com',email:'hello@example.com',name:'Example',description:'Example',category:'software',language:'zh',monthlyTarget:2,status:'ready',createdAt:'2026-09-01T00:00:00Z'};
const task=(status:Task['status'],scheduledAt='2026-09-30T02:00:00Z'):Task=>({id:'task-1',siteId:site.id,channelId:'channel-1',sourceDomain:'source.example',status,createdAt:'2026-09-30T00:00:00Z',scheduledAt,updatedAt:'2026-09-30T00:00:00Z',attempts:0,message:''});
const context=(autoRun=true)=>({autoRun,now:new Date('2026-09-30T01:00:00Z'),timeZone:'Asia/Singapore'});

test('September 30 keeps the configured timezone when displaying a future task',()=>assert.equal(planningStatus(site,[task('queued')],context()).next,'今天 10:00'));
test('global pause is explicit even when work is already queued',()=>assert.equal(planningStatus(site,[task('queued')],context(false)).state,'global_paused'));
test('site pause remains distinct from global pause',()=>assert.equal(planningStatus({...site,status:'paused'},[task('queued')],context()).state,'site_paused'));
test('running task is surfaced before its schedule',()=>assert.equal(planningStatus(site,[task('running')],context()).state,'running'));
test('needs-input task is surfaced before its schedule',()=>assert.equal(planningStatus(site,[task('needs_input')],context()).state,'needs_input'));
test('article review uses the real needs-input status and makes confirmation explicit',()=>{const review={...task('needs_input'),checkpoint:'article_review'};assert.equal(planningStatus(site,[review],context()).label,'等待审核稿件')});
test('a queued task keeps its real next time when another task needs attention',()=>{const blocked={...task('needs_input'),checkpoint:'article_review'};const queued={...task('queued'),id:'task-2',sourceDomain:'second.example'};const result=planningStatus(site,[blocked,queued],context());assert.deepEqual([result.label,result.next],['有待审核稿件','今天 10:00'])});
test('a queued task due today is ready to execute',()=>assert.equal(planningStatus(site,[task('queued','2026-09-30T00:30:00Z')],context()).state,'due'));
test('source shortage is separate from a task failure',()=>{const result=planningStatus({...site,error:'当前渠道来源不足'},[],context());assert.deepEqual([result.state,result.next],['source_shortage','暂无可排渠道'])});
test('monthly target completion counts first-live work from earlier in the same month',()=>{const live={...task('live'),firstLiveAt:'2026-09-02T00:20:00Z'};const second={...task('live'),id:'task-2',sourceDomain:'second.example',firstLiveAt:'2026-09-20T00:20:00Z'};assert.equal(planningStatus(site,[live,second],context()).state,'target_met')});
test('monthly reset is a timezone-aware statistic boundary, not a start date',()=>assert.deepEqual(monthlyReset('Asia/Singapore',new Date('2026-09-30T15:30:00Z')),{date:'2026年10月1日',label:'月度目标重置',detail:'这是月度统计的重置时间；新网站分析完成并有任务后会立即开始，无需等到这一天。'}));

for(const blocked of ['failed','expired','review'] as const)test(`${blocked} does not hide a separate queued task`,()=>{
 const waiting={...task(blocked),id:'other'},queued=task('queued');
 const result=planningStatus(site,[waiting,queued],context());
 assert.equal(result.next,'今天 10:00');assert.match(result.detail,/已排任务仍会/);
});
test('source shortage classification remains independent of paused or review status',()=>{
 const s={...site,error:'适合的自动渠道不足，还缺1个来源'};
 assert.equal(planningStatus(s,[task('needs_input')],context(false)).state,'global_paused');
 assert.equal(hasShortageMessage(s.error),true);assert.equal(hasShortageMessage('网站暂时无法读取'),false);
});
