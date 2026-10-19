import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import type {OneReviewRetry,Task} from '../src/shared/types';

const taskId='11111111-1111-4111-8111-111111111111',siteId='22222222-2222-4222-8222-222222222222',stamp='2026-10-17T01:00:00.000Z';
const task=():Task=>({id:taskId,siteId,channelId:'synthetic-review',sourceDomain:'review.example.net',status:'failed',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:3,message:'synthetic failed review',cost:{aiCalls:2},checkpoint:'article_review'});
const grant=():OneReviewRetry=>({version:1,purpose:'independent_article_review',status:'granted',operationTokenHash:'a'.repeat(64),siteId,channelId:'synthetic-review',accountId:null,draftRevision:2,contentHash:'b'.repeat(64),contextHash:'c'.repeat(64),provider:'codex',model:'synthetic-model',grantedAt:stamp});

test('Store keeps a consumed one-review grant and call three monotonic across every write path and restore',()=>{
  const store=new Store(':memory:');try{
    store.update(state=>state.tasks=[task()]);const beforeGrant=store.read();
    store.update(state=>{state.tasks[0].oneReviewRetry=grant()});
    store.update(state=>{state.tasks[0].oneReviewRetry={...grant(),status:'consumed',consumedAt:'2026-10-17T01:01:00.000Z'};state.tasks[0].cost={aiCalls:3}});
    const consumed=store.read();
    assert.throws(()=>store.update(state=>{delete state.tasks[0].oneReviewRetry}),/不能删除/);
    assert.throws(()=>store.update(state=>{state.tasks[0].cost={aiCalls:2}}),/不能.*回退|保存记录无效/);
    assert.throws(()=>store.updateWithCiphers(state=>{delete state.tasks[0].oneReviewRetry},{synthetic:'cipher'}),/不能删除/);
    assert.throws(()=>store.restore(beforeGrant,{}),/不能删除/);
    assert.deepEqual(store.read(),consumed);
    const fresh=new Store(':memory:');try{fresh.restore(consumed,{});assert.deepEqual(fresh.read().tasks[0].oneReviewRetry,consumed.tasks[0].oneReviewRetry)}finally{fresh.close()}
  }finally{store.close()}
});

test('ordinary Store updates cannot manufacture a terminal retry without a persisted grant',()=>{
  const store=new Store(':memory:');try{
    store.update(state=>state.tasks=[task()]);
    assert.throws(()=>store.update(state=>{state.tasks[0].oneReviewRetry={...grant(),status:'consumed',consumedAt:'2026-10-17T01:01:00.000Z'};state.tasks[0].cost={aiCalls:3}}),/必须先保存授权/);
  }finally{store.close()}
});
