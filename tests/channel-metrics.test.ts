import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {load} from 'cheerio';
import {buildChannelMetricRow,channelMetricView,authorityNameKind,financePlatformRuntimeSummary,metricImportLinkScope} from '../src/ui/channel-metrics';
import {PlatformDetail,PlatformsPage} from '../src/ui/pages/PlatformsPage';
import {platformRows} from '../src/ui/platforms-model';
import {emptyState} from '../src/main/store';
import type {Snapshot} from '../src/shared/types';
import {importChannelMetrics} from '../src/integrations/channel-library';
import {CHANNELS} from '../src/integrations/catalog';
import type {Channel,ChannelMetric} from '../src/shared/types';

const authority={name:'DR',value:0,source:'https://metrics.example.com/report',asOf:'2026-09-01',scope:'domain' as const,target:'example.com'};
const form={channelId:'telegraph',authorityChoice:'ahrefs_dr' as const,otherName:'',authorityValue:'0',scope:'domain' as const,target:'example.com',traffic:'',source:authority.source,asOf:authority.asOf,estimated:true};
const metric:ChannelMetric={provider:'ahrefs-dr',value:94,target:'example.com',linkScope:'same-host',asOf:'2026-10',version:'dr3',source:'https://metrics.example.com/report'};
const fixture=(metrics?:ChannelMetric[]):Channel=>({id:'fixture',name:'Example',domain:'example.com',url:'https://example.com',submitUrl:'https://example.com/new',categories:['general'],languages:['*'],kind:'article',emailRequired:false,accountRequired:false,articleRequired:true,free:'yes',freeNote:'fixture',automation:'manual',quality:'C',qualityReason:'fixture',rulesUrl:'https://example.com/rules',checkedAt:'2026-10-18',notes:'fixture',allowedHosts:['example.com'],enabled:true,...(metrics?{metrics}:{})});
const renderTable=(channel:Channel)=>{
 const data={...emptyState(),channels:[channel],accounts:[],accountBindings:[],tasks:[]} as unknown as Snapshot;
 const html=renderToStaticMarkup(createElement(PlatformsPage,{data,tab:'platforms',onTab:()=>{},disabled:true,onAction:async()=>undefined,onTask:()=>{},onImport:()=>{},onEditAccount:()=>{},onDeleteAccount:()=>{},onSetup:()=>{}}));
 return load(html);
};

for(const [name,metrics,main,subtitle] of [
 ['same-host DR',[metric],'DR 94','Ahrefs · 2026-10'],
 ['platform-root DR',[{...metric,value:95,linkScope:'platform-root' as const}],'DR 95','平台分 · 你的页面不继承'],
 ['missing DR',undefined,'DR —','待查'],
] as const){
 test(`channel table renders ${name} with its required scope label`,()=>{
  const $=renderTable(fixture(metrics?[...metrics]:undefined));
  assert.equal($('.metric-cell strong').text(),main);
  assert.equal($('.metric-cell small').text(),subtitle);
  assert.equal($('.metric-cell').children().length,2);
  assert.ok($('thead th').toArray().some(cell=>$(cell).clone().find('[aria-hidden]').remove().end().text()==='权重'));
  assert.doesNotMatch($('table').text(),/Google PR|流量未知/);
  assert.equal($('.table-footnote a').text(),'Domain Rating by Ahrefs');
  assert.equal($('.table-footnote a').attr('href'),'https://ahrefs.com/');
  assert.match($('.table-footnote').text(),/权重数据：Domain Rating by Ahrefs/);
 });
}

test('DR preserves raw decimals and zero, and unknown months are explicit',()=>{
 const view=channelMetricView({metrics:[{...metric,value:0,asOf:'',note:'月份不明'}]});
 assert.equal(view.dr,'DR 0');assert.equal(view.subtitle,'Ahrefs · 月份不明');
 assert.equal(channelMetricView({metrics:[{...metric,value:94.75}]}).dr,'DR 94.75');
 const $=renderTable(fixture([{...metric,asOf:'',note:'月份不明'}]));
 assert.equal($('.metric-cell small').text(),'Ahrefs · 月份不明');
});

test('legacy authority remains readable while current metric arrays take precedence',()=>{
 const legacy=channelMetricView({domain:'example.com',authority});
 assert.equal(legacy.dr,'DR 0');assert.equal(legacy.subtitle,'Ahrefs · 2026-09');
 assert.equal(channelMetricView({domain:'example.com',authority,metrics:[]}).dr,'DR —');
 assert.equal(channelMetricView({authority:{...authority,scope:undefined,target:undefined}}).subtitle,'平台分 · 你的页面不继承');
 assert.equal(channelMetricView({authority:{...authority,name:'Other provider DR',value:80}}).dr,'DR —');
 assert.equal(channelMetricView({authority:{...authority,scope:'page'}}).dr,'DR —');
 assert.equal(authorityNameKind('Ahrefs Domain Rating'),'ahrefs_dr');
});

test('historic PR cannot be imported as current PR and OpenPageRank is kept distinct',()=>{
 for(const name of ['PR','GooglePR','PageRank','Google Page Rank']){
  const view=channelMetricView({authority:{...authority,name,value:6}});
  assert.equal(view.dr,'DR —');assert.equal(view.authorityDetail,'待查');
  assert.throws(()=>buildChannelMetricRow({...form,authorityChoice:'other',otherName:name}),/无当前公开值/);
 }
 const view=channelMetricView({authority:{...authority,name:'OpenPageRank',value:6}});
 assert.equal(view.dr,'DR —');assert.match(view.authorityDetail,/OpenPageRank 6/);
 assert.throws(()=>buildChannelMetricRow({...form,authorityChoice:'other',otherName:'OpenPageRank',authorityValue:'11'}),/0 到 10/);
});

test('form imports metrics, preserves zero, and a traffic-only update retains existing scores',()=>{
 const row=buildChannelMetricRow(form);
 assert.equal(row.metrics?.[0].value,0);assert.equal(row.metrics?.[0].target,'example.com');
 assert.equal(row.metrics?.[0].asOf,'2026-09');assert.equal(row.metrics?.[0].provider,'ahrefs-dr');
 assert.equal(row.traffic,undefined);
 const stored=importChannelMetrics({},[row],CHANNELS);
 const trafficOnly=buildChannelMetricRow({...form,authorityValue:'',otherName:'PR',authorityChoice:'other',traffic:'0'});
 assert.equal(trafficOnly.metrics,undefined);
 const updated=importChannelMetrics(stored,[trafficOnly],CHANNELS);
 assert.deepEqual(updated.telegraph.metrics,stored.telegraph.metrics);assert.equal(updated.telegraph.traffic?.monthly,0);
 assert.throws(()=>buildChannelMetricRow({...form,authorityValue:' '}),/请填写/);
 assert.throws(()=>buildChannelMetricRow({...form,scope:'page'}),/只适用于/);
 assert.throws(()=>buildChannelMetricRow({...form,target:' '}),/测量对象/);
 assert.equal(buildChannelMetricRow({...form,linkScope:'platform-root'}).metrics?.[0].linkScope,'platform-root');
});

test('monthly evidence imports without fabricating a day, including its traffic period',()=>{
 const row=buildChannelMetricRow({...form,datePrecision:'month',asOf:'',dataMonth:'2026-09',checkedAt:'2026-09-28',traffic:'0'});
 const stored=importChannelMetrics({},[row],CHANNELS).telegraph;
 assert.equal(stored.metrics?.[0].asOf,'2026-09');assert.match(stored.metrics?.[0].note??'',/核查：2026-09-28/);
 assert.equal(stored.traffic?.asOf,'2026-09-28');assert.equal(stored.traffic?.period,'2026-09');
 assert.match(channelMetricView(stored).trafficDetail!,/数据月份：2026-09 · 核查：2026-09-28/);
 assert.throws(()=>buildChannelMetricRow({...form,datePrecision:'month'}),/仅提供月份/);
 assert.throws(()=>buildChannelMetricRow({...form,asOf:''}),/数据日期/);
});

test('detail retains imported traffic and omits an empty traffic explanation',()=>{
 const channel=fixture([metric]);
 const renderDetail=(value:Channel)=>{const data={...emptyState(),channels:[value],accounts:[],accountBindings:[],tasks:[]} as unknown as Snapshot;
  return load(renderToStaticMarkup(createElement(PlatformDetail,{row:platformRows(data,undefined,[])[0],data,links:[],disabled:true,onAction:async()=>undefined,onTask:()=>{},onConnect:()=>{},onClose:()=>{}})))};
 const empty=renderDetail(channel);
 assert.doesNotMatch(empty('.channel-evidence').text(),/访问指标|Google PR|流量未知/);
 const withTraffic={...channel,traffic:{monthly:1234,source:'https://metrics.example.com/traffic',asOf:'2026-10-18',estimated:true}};
 assert.match(renderDetail(withTraffic)('.channel-evidence').text(),/访问指标1,234 访问 \/ 月/);
 assert.doesNotMatch(renderTable(withTraffic)('.metric-cell').text(),/1,234/);
});


test('metric import keeps unmeasured hosted platform roots separate from the user page',()=>{
 for(const id of ['notion','wix','mataroa']){
  const channel={...fixture(),id,metrics:[],authority:undefined};
  const linkScope=metricImportLinkScope(channel,channel.domain);
  const row=buildChannelMetricRow({...form,channelId:id,target:channel.domain,linkScope});
  assert.equal(row.metrics?.[0].linkScope,'platform-root',id);
  assert.equal(channelMetricView({metrics:row.metrics}).subtitle,'平台分 · 你的页面不继承',id);
 }
});

test('metric import uses same-host only for the matching ordinary host or an existing actual-host metric',()=>{
 const channel=fixture();
 assert.equal(metricImportLinkScope(channel,' example.com '),'same-host');
 assert.equal(metricImportLinkScope(channel,'EXAMPLE.COM'),'same-host');
 assert.equal(metricImportLinkScope(channel,'elsewhere.example.com'),'platform-root');
 assert.equal(metricImportLinkScope(undefined,'example.com'),'platform-root');
 const measured={...fixture([{...metric,target:'author.example.com',linkScope:'same-host'}]),id:'notion'};
 assert.equal(metricImportLinkScope(measured,'author.example.com'),'same-host');
});

test('runtime finance platform summary reports the planner snapshot rather than a catalog constant',()=>{
 const summary=financePlatformRuntimeSummary({count:6,channelIds:['a','b','c','d','e','f'],runtimeSchedulableIds:['a','b','c','d','e','f','one-shot'],trialCount:2,acceptedCount:1,pendingAcceptanceCount:3,confirmationRequiredIds:['html-app'],verificationRequiredIds:['paper-wf'],connectionRequiredIds:[],temporaryIds:[]});
 assert.match(summary,/免人工全自动平台 6 个/);
 assert.match(summary,/已转正 1，试运行 2，待首篇验收 3/);
 assert.match(summary,/要你确认一次 1 个，要你过一次验证 1 个/);
});
