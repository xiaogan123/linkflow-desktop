import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleArticlePublicationContext} from '../src/main/article-publication-context';
import type {Task} from '../src/shared/types';

test('review context counts visible channel/site/account use without disclosing other sites or assuming permission',()=>{
  const rows=[
    {channelId:'one',siteId:'a',accountId:'first'},
    {channelId:'one',siteId:'a',accountId:'first'},
    {channelId:'one',siteId:'b',accountId:'second'},
    {channelId:'two',siteId:'c',accountId:'third'},
  ] as Task[];
  assert.deepEqual(visibleArticlePublicationContext(rows,rows[0]),{scope:'visible_workspace_only',sameChannelTasks:3,sameAccountTasks:2,distinctSites:2,publicationIntent:'unknown'});
  assert.deepEqual(visibleArticlePublicationContext(rows,{channelId:'one'}),{scope:'visible_workspace_only',sameChannelTasks:3,distinctSites:2,publicationIntent:'unknown'});
});
