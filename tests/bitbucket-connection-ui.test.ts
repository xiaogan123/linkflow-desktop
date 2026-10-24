import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {load} from 'cheerio';
import {BitbucketConnection,bitbucketConnectionPayload} from '../src/ui/pages/BitbucketConnection';
import type {Snapshot} from '../src/shared/types';

const siteId='11111111-1111-4111-8111-111111111111',workspaceSlug='example-tools',projectUuid='{22222222-2222-4222-8222-222222222222}',checkedAt='2026-10-24T12:00:00.000Z';
const freePlanEvidence={version:1 as const,workspaceId:workspaceSlug,plan:'Free' as const,users:1,paymentAdded:false as const,paidTrialSelected:false as const,checkedAt,stateSha256:'a'.repeat(64),screenshotSha256:'b'.repeat(64)};
const snapshot={sites:[{id:siteId,domain:'docs.example.com'}],channels:[{id:'bitbucket',enabled:false}],accountBindings:[]} as unknown as Snapshot;

test('Bitbucket connection accepts an exact existing Free evidence JSON without exposing internal hash inputs',()=>{
  const payload=bitbucketConnectionPayload({token:'fixture-token-1234567890',workspaceSlug,projectUuid,siteId,evidenceText:JSON.stringify({freePlanEvidence})});
  assert.deepEqual(payload,{token:'fixture-token-1234567890',workspaceSlug,projectUuid,freePlanEvidence,siteIds:[siteId]});
  const $=load(renderToStaticMarkup(createElement(BitbucketConnection,{data:snapshot,disabled:false,onClose:()=>{},onAction:async()=>undefined})));
  assert.equal($('input[type=password][aria-label="Bitbucket API token"]').length,1);
  assert.equal($('input[type=file][accept="application/json,.json"]').length,1);
  assert.equal($('textarea[aria-label="Bitbucket Free 计划证据 JSON"]').length,1);
  assert.match($.text(),/24 小时/);
  assert.doesNotMatch($.text(),/stateSha256|screenshotSha256/);
});

test('Bitbucket connection rejects fabricated, mismatched or extra Free evidence fields',()=>{
  const base={token:'fixture-token-1234567890',workspaceSlug,projectUuid,siteId};
  assert.throws(()=>bitbucketConnectionPayload({...base,evidenceText:JSON.stringify({...freePlanEvidence,workspaceId:'other-tools'})}),/不完整或不一致/);
  assert.throws(()=>bitbucketConnectionPayload({...base,evidenceText:JSON.stringify({...freePlanEvidence,extra:'forged'})}),/不完整或不一致/);
  assert.throws(()=>bitbucketConnectionPayload({...base,evidenceText:'not-json'}),/无法读取/);
});

test('renderer preload and main process both allow the exact Bitbucket connection command',async()=>{
  const [preload,main,accounts]=await Promise.all([
    readFile(new URL('../src/main/preload.ts',import.meta.url),'utf8'),
    readFile(new URL('../src/main/main.ts',import.meta.url),'utf8'),
    readFile(new URL('../src/ui/pages/AccountsPage.tsx',import.meta.url),'utf8'),
  ]);
  assert.match(preload,/\.\.\.BITBUCKET_IPC_COMMANDS/);
  assert.match(main,/\.\.\.BITBUCKET_IPC_COMMANDS/);
  assert.match(accounts,/id==='bitbucket'\)setBitbucketDrawer/);
  assert.match(accounts,/<BitbucketConnection/);
});
