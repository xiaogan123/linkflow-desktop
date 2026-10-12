import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChannelMetricRow,channelMetricView,authorityNameKind} from '../src/ui/channel-metrics';
import {channelAuthoritySnapshot} from '../src/integrations/channel-authority-snapshots';
import {importChannelMetrics} from '../src/integrations/channel-library';
import {CHANNELS} from '../src/integrations/catalog';

const authority={name:'DR',value:0,source:'https://metrics.example.com/report',asOf:'2026-09-01',scope:'domain' as const,target:'example.com'};
const form={channelId:'telegraph',authorityChoice:'ahrefs_dr' as const,otherName:'',authorityValue:'0',scope:'domain' as const,target:'example.com',traffic:'',source:authority.source,asOf:authority.asOf,estimated:true};

test('DR zero, unknown, legacy missing scope and another providers score remain distinguishable',()=>{
 assert.equal(channelMetricView({}).dr,'DR 未知');
 assert.equal(channelMetricView({authority}).dr,'DR 0');
 assert.match(channelMetricView({authority:{...authority,scope:undefined,target:undefined}}).dr,/口径待补、测量对象待补/);
 const other=channelMetricView({authority:{...authority,name:'Other provider DR',value:80}});
 assert.equal(other.dr,'DR 未知');assert.equal(other.other,'Other provider DR 80');
 assert.equal(authorityNameKind('Ahrefs Domain Rating'),'ahrefs_dr');
 assert.match(channelMetricView({authority:{...authority,scope:'page'}}).other!,/不作 DR/);
});

test('public month snapshots show month and inspection date, without inventing a measurement day',()=>{
 const view=channelMetricView({authority:channelAuthoritySnapshot('github.com')});
 assert.equal(view.dr,'DR 97');assert.match(view.authorityDetail,/官方公开快照，非实时查询/);
 assert.match(view.authorityDetail,/数据月份：2026-10 · 核查：2026-10-12/);
 assert.match(view.authorityDetail,/具体测量日及算法版本未披露/);assert.doesNotMatch(view.authorityDetail,/undefined|数据日期/);
 assert.equal(view.measurement,'域名 · github.com · 2026-10');
 assert.match(channelMetricView({authority}).origin,/用户导入/);
});

test('Google PR history is not presented as current PR or confused with OpenPageRank',()=>{
 for(const name of ['PR','GooglePR','PageRank','Google Page Rank']){
  const view=channelMetricView({authority:{...authority,name,value:6}});
  assert.match(view.pr,/无当前公开值.*历史导入/);assert.match(view.authorityDetail,/不能作为当前 Google PR/);
  assert.throws(()=>buildChannelMetricRow({...form,authorityChoice:'other',otherName:name}),/无当前公开值/);
 }
 const view=channelMetricView({authority:{...authority,name:'OpenPageRank',value:6}});
 assert.equal(view.other,'OpenPageRank 6');assert.equal(view.pr,'Google PR 无当前公开值');
 assert.match(view.authorityDetail,/OpenPageRank 与 Google PR 不同/);
 assert.throws(()=>buildChannelMetricRow({...form,authorityChoice:'other',otherName:'OpenPageRank',authorityValue:'11'}),/0 到 10/);
});

test('form submission preserves zero and leaves omitted scores unchanged through the real importer',()=>{
 const row=buildChannelMetricRow(form);
 assert.equal(row.authority?.value,0);assert.equal(row.authority?.target,'example.com');
 assert.equal(row.traffic,undefined);
 const stored=importChannelMetrics({},[row],CHANNELS);
 const trafficOnly=buildChannelMetricRow({...form,authorityValue:'',otherName:'PR',authorityChoice:'other',traffic:'0'});
 assert.equal(trafficOnly.authority,undefined);
 const updated=importChannelMetrics(stored,[trafficOnly],CHANNELS);
 assert.deepEqual(updated.telegraph.authority,stored.telegraph.authority);assert.equal(updated.telegraph.traffic?.monthly,0);
 assert.throws(()=>buildChannelMetricRow({...form,authorityValue:' '}),/请填写/);
 assert.throws(()=>buildChannelMetricRow({...form,scope:'page'}),/只适用于/);
 assert.throws(()=>buildChannelMetricRow({...form,target:' '}),/测量对象/);
});

test('monthly evidence imports without fabricating a day, including its traffic period',()=>{
 const row=buildChannelMetricRow({...form,datePrecision:'month',asOf:'',dataMonth:'2026-09',checkedAt:'2026-09-28',traffic:'0'});
 const stored=importChannelMetrics({},[row],CHANNELS).telegraph;
 assert.equal(stored.authority?.asOf,undefined);assert.equal(stored.authority?.dataMonth,'2026-09');
 assert.equal(stored.authority?.checkedAt,'2026-09-28');
 assert.equal(stored.traffic?.asOf,'2026-09-28');assert.equal(stored.traffic?.period,'2026-09');
 assert.match(channelMetricView(stored).trafficDetail,/数据月份：2026-09 · 核查：2026-09-28/);
 assert.throws(()=>buildChannelMetricRow({...form,datePrecision:'month'}),/仅提供月份/);
 assert.throws(()=>buildChannelMetricRow({...form,asOf:''}),/数据日期/);
});
