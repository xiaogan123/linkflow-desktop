import test from 'node:test';
import assert from 'node:assert/strict';
import {unusedSources} from '../src/shared/source-capacity';
import type {Channel,Task} from '../src/shared/types';
const channel=(domain:string,automation:Channel['automation']='manual',free:Channel['free']='yes')=>({domain,automation,free,enabled:true} as Channel);
test('multiple channel entries for one platform count as one unused source',()=>{
 assert.deepEqual(unusedSources('site',[],[channel('linkedin.com'),channel('www.LinkedIn.com.')]),{total:1,automatic:0,manual:1});
});
test('automatic and manual capabilities of one source do not double count',()=>{
 assert.deepEqual(unusedSources('site',[],[channel('example.com'),channel('example.com','api'),channel('other.example')]),{total:2,automatic:1,manual:1});
});
test('used, disabled, paid and unknown sources are not unused capacity',()=>{
 const tasks=[{siteId:'site',sourceDomain:'www.example.com.'},{siteId:'other',sourceDomain:'other.example'}] as Task[];
 assert.deepEqual(unusedSources('site',tasks,[channel('example.com'),channel('other.example'),channel('paid.example','manual','paid'),channel('unknown.example','manual','unknown'),{...channel('disabled.example'),enabled:false}]),{total:1,automatic:0,manual:1});
});
test('failed and skipped work without submission evidence releases the source',()=>{
 const base={siteId:'site',sourceDomain:'example.com',createdAt:'2026-01-01',scheduledAt:'2026-01-01',updatedAt:'2026-01-01',attempts:1,message:'stopped'};
 const tasks=[{...base,id:'failed',channelId:'one',status:'failed'},{...base,id:'skipped',channelId:'two',status:'skipped'}] as Task[];
 assert.deepEqual(unusedSources('site',tasks,[channel('example.com','api')]),{total:1,automatic:1,manual:0});
});
test('submission evidence and existing links continue to occupy one-time sources',()=>{
 const base={siteId:'site',createdAt:'2026-01-01',scheduledAt:'2026-01-01',updatedAt:'2026-01-01',attempts:1,message:'stopped'};
 const tasks=[{...base,id:'submitted',channelId:'one',sourceDomain:'example.com',status:'failed',submittedAt:'2026-01-01'},{...base,id:'existing',channelId:'two',sourceDomain:'other.example',status:'skipped',checkpoint:'existing_link'}] as Task[];
 assert.deepEqual(unusedSources('site',tasks,[channel('example.com','api'),channel('other.example','api')]),{total:0,automatic:0,manual:0});
});
