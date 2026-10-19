import assert from 'node:assert/strict';
import test from 'node:test';
import {inspectRecheckedLinkHtml,recheckLink} from '../src/integrations/web';
import {applyLinkResult} from '../src/main/planner';
import type {Task} from '../src/shared/types';

const stamp='2026-10-01T00:00:00.000Z';
const pageUrl='https://telegra.ph/Example-Guide-10-01';
function publishedTask():Task{
  return {id:'example-task',siteId:'example-site',channelId:'telegraph',sourceDomain:'telegra.ph',
    status:'live',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'verified',
    submittedAt:stamp,publicUrl:pageUrl,firstLiveAt:stamp,verifiedAt:stamp,health:'healthy',linkRel:'nofollow'};
}

test('applying a legacy-origin recheck preserves its migration explanation and acceptance history',()=>{
  const task=publishedTask(),checkedAt=new Date('2026-10-18T00:00:00.000Z');
  const result=inspectRecheckedLinkHtml('<article><a href="https://old-site.example.com/">Guide</a></article>',
    pageUrl,'https://example-site.com/',['https://old-site.example.com/']);
  applyLinkResult(task,result,checkedAt);
  assert.equal(task.status,'live');
  assert.equal(task.health,'healthy');
  assert.equal(task.linkCheckReason,'legacy_origin');
  assert.equal(task.linkUsesLegacyOrigin,true);
  assert.equal(task.linkMatchedOrigin,'https://old-site.example.com');
  assert.equal(task.message,result.reason);
  assert.equal(task.firstLiveAt,stamp);
  assert.equal(task.nextCheckAt,'2026-10-31T00:00:00.000Z');
});

test('a mismatched redirect saves its checked destination while preserving the original accepted URL and rel',()=>{
  const task=publishedTask(),destination='https://telegra.ph/Another-Guide-10-18';
  applyLinkResult(task,{found:false,outcome:'invalid',url:destination,rel:'',
    reasonCode:'source_redirect_mismatch',reason:'公开地址发生变化。'},new Date('2026-10-18T00:00:00.000Z'));
  assert.equal(task.linkCheckFinalUrl,destination);
  assert.equal(task.publicUrl,pageUrl);
  assert.equal(task.linkRel,'nofollow');
  assert.equal(task.status,'live');
  assert.equal(task.health,'unknown');
  assert.equal(task.reviewKind,undefined);
  assert.equal(task.lostAt,undefined);
});


test('periodic readback records 404/410 as lost, and keeps other HTTP failures unknown',async()=>{
  for(const status of [404,410,403,503]){
    const result=await recheckLink(pageUrl,'https://target.example/',[],undefined,undefined,{
      resolve:async()=>[{address:'8.8.8.8',family:4}],request:async()=>({status,headers:{'content-type':'text/html'},body:Buffer.alloc(0)})});
    assert.equal(result.outcome,[404,410].includes(status)?'absent':'unreachable');
    const task=publishedTask();applyLinkResult(task,result,new Date('2026-10-18T00:00:00.000Z'));
    assert.equal(!!task.lostAt,[404,410].includes(status));assert.equal(task.status,'live');assert.equal(task.humanAction,undefined);
  }
});
