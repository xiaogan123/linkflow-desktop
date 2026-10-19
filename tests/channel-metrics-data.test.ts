import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS} from '../src/integrations/catalog';
import {channelMetricSnapshot,channelMetricLinkScope} from '../src/integrations/channel-authority-snapshots';
import {channelMetrics} from '../src/shared/channel-metrics';
import {ChannelMetricInput,composeChannels,importChannelMetrics,saveCustomChannel} from '../src/integrations/channel-library';
import {emptyState,migrateState} from '../src/main/store';
import {validateBackup} from '../src/main/backup-validation';
import type {ChannelMetric} from '../src/shared/types';

const metric:ChannelMetric={provider:'ahrefs-dr',value:94.625,target:'example.com',linkScope:'same-host',asOf:'2026-10',version:'dr3',source:'https://metrics.example.com/report'};
const score=(id:string)=>CHANNELS.find(value=>value.id===id)!.metrics![0];

test('snapshot rows use the measured host, preserve unknown months and never substitute Tranco ranks',()=>{
 for(const [id,target,value]of [['pastyx','pages.dev',93],['markdownpaste','vercel.app',93],['github-gist','github.com',97],['docker-hub','docker.com',92],['firefox-addons','mozilla.org',96],['vscode-marketplace','visualstudio.com',92],['jetbrains-marketplace','jetbrains.com',91],['show-hn','ycombinator.com',91]] as const){
  assert.equal(score(id).target,target,id);assert.equal(score(id).value,value,id);assert.equal(score(id).linkScope,'platform-root',id);assert.equal(channelMetricLinkScope(id),'platform-root',id);
 }
 for(const id of ['blogger','tumblr','substack','itch-io','carrd','hashnode','beehiiv','kit-newsletter'])assert.equal(score(id).linkScope,'platform-root',id);
 for(const id of ['telegraph','hive','gravatar','hashnode','betalist']){assert.equal(score(id).asOf,'',id);assert.match(score(id).note!,/月份不明/,id)}
 assert.equal(score('github').linkScope,'same-host');assert.equal(score('github').asOf,'2026-10');
 for(const id of ['google-business','bing-places','apple-business']){assert.equal(score(id).linkScope,'platform-root');assert.match(score(id).note!,/非普通网页外链/)}
 for(const id of ['agentsgather','slugpost','mataroa','nostr','paragraph','snap-store','packagist','pub-dev','rubygems','flipboard-publisher'])assert.deepEqual(CHANNELS.find(value=>value.id===id)?.metrics,[],id);
 for(const channel of CHANNELS)for(const value of channel.metrics??[]){assert.equal(value.provider,'built-in-dr');assert(value.value>=0&&value.value<=100);assert.doesNotMatch(value.source,/tranco/i);assert.notEqual(value.asOf,'1970-01');assert.equal(value.version,'')}
 assert.deepEqual(channelMetricSnapshot('unmeasured.example.com'),[]);
 assert.equal(channelMetricLinkScope('blogger'),'platform-root');assert.equal(channelMetricLinkScope('github'),'same-host');
});

test('all source rows explicitly describing anonymous pages, user subdomains or gateways stay platform-root',()=>{
 // IDs from all 24 publishOn rows containing 匿名 / 用户子域 / 第三方网关
 // in the supplied 2026-10-18 source table, including channels without a DR yet.
 const hostedOrAnonymous=[
  'agentsgather','tantive','thethings','nextgen-slides','txtsbs','pastyx',
  'yourwebs','markdownpaste','deed-page','html-app','mataroa','nostr',
  'vibedrop','blogger','here-now','shiply','carrd','itch-io','hashnode',
  'substack','ghost-pro','tumblr','beehiiv','kit-newsletter',
 ];
 for(const channelId of hostedOrAnonymous)assert.equal(channelMetricLinkScope(channelId),'platform-root',channelId);
});

test('legacy state migration is additive and never relabels PR, another provider or page scores as DR',()=>{
 const state=emptyState();state.channelMetrics={
  github:{authority:{name:'Ahrefs DR',value:94.625,target:'github.com',scope:'domain',dataMonth:'2026-09',source:metric.source}},
  telegraph:{authority:{name:'Google PR',value:6,asOf:'2026-09-01',source:metric.source}},
  blogger:{authority:{name:'DR',value:95,target:'blogspot.com',scope:'domain',source:metric.source}},
  'github-gist':{authority:{name:'DR',value:80,scope:'page',target:'https://example.com/post',asOf:'2026-09-01',source:metric.source}},
 };
 const migrated=migrateState(state);assert.equal(migrated.channelMetrics?.github.metrics?.[0].value,94.625);assert.equal(migrated.channelMetrics?.github.metrics?.[0].asOf,'2026-09');assert.equal(migrated.channelMetrics?.github.metrics?.[0].linkScope,'same-host');
 assert.equal(migrated.channelMetrics?.telegraph.metrics?.[0].provider,'legacy:Google PR');assert.equal(migrated.channelMetrics?.telegraph.metrics?.[0].target,'');
 assert.equal(migrated.channelMetrics?.blogger.metrics?.[0].linkScope,'platform-root');assert.match(migrated.channelMetrics?.blogger.metrics?.[0].note!,/月份不明/);
 assert.equal(migrated.channelMetrics?.['github-gist'].metrics?.[0].provider,'legacy:DR');assert(migrated.channelMetrics?.github.authority);
 const before=structuredClone(migrated);assert.deepEqual(migrateState(migrated),before);
 assert.equal(channelMetrics({authority:{name:'Other provider DR',value:10,source:metric.source}})[0].provider,'legacy:Other provider DR');
});

test('metric arrays preserve decimals, providers and user traffic across import, composition and backup',()=>{
 const state=emptyState();const other={...metric,provider:'OpenPageRank',value:6.375};
 state.channelMetrics=importChannelMetrics({},[{channelId:'github',metrics:[metric,other]}],CHANNELS);
 state.channelMetrics=importChannelMetrics(state.channelMetrics,[{channelId:'github',traffic:{monthly:0,source:metric.source,asOf:'2026-10-01'}}],CHANNELS);
 assert.deepEqual(composeChannels(CHANNELS,[],state.channelMetrics).find(value=>value.id==='github')?.metrics,[metric,other]);
 const restored=validateBackup({state,secrets:{}}).state;assert.deepEqual(restored.channelMetrics,state.channelMetrics);assert.equal(restored.channelMetrics?.github.traffic?.monthly,0);
 assert.equal(ChannelMetricInput.safeParse({...metric,asOf:''}).success,false);assert(ChannelMetricInput.safeParse({...metric,asOf:'',note:'月份不明'}).success);
 for(const patch of [{value:NaN},{value:1000},{target:'https://user:password@example.com/'},{asOf:'1970-00'},{version:'dr5'},{target:'',note:'测量对象不明',linkScope:'same-host'}])assert.equal(ChannelMetricInput.safeParse({...metric,...patch}).success,false);
});

test('custom channel metrics and Ahrefs vault secret survive backup while key metadata is recalculated',()=>{
 const state=emptyState();state.customChannels=saveCustomChannel([],{name:'Example channel',domain:'community.example.com',submitUrl:'https://community.example.com/submit',categories:['content'],languages:['en'],kind:'community',free:'unknown',freeNote:'Unknown',rulesUrl:'https://community.example.com/rules',notes:'Example fixture'},CHANNELS);
 state.customChannels[0].metrics=[metric];state.settings.hasAhrefsKey=false;state.settings.ahrefsStatus='connected';state.settings.ahrefsLastUpdatedAt='2026-10-18T01:00:00Z';
 const restored=validateBackup({state,secrets:{ahrefsApiKey:'synthetic-test-key'}});assert.deepEqual(restored.state.customChannels?.[0].metrics,[metric]);assert.equal(restored.secrets.ahrefsApiKey,'synthetic-test-key');assert.equal(restored.state.settings.hasAhrefsKey,true);
 const noSecret=validateBackup({state,secrets:{}});assert.equal(noSecret.state.settings.hasAhrefsKey,false);assert.equal(noSecret.state.settings.ahrefsStatus,undefined);assert.equal(noSecret.state.settings.ahrefsLastUpdatedAt,undefined);
});

test('task measurements retain the actual queried host and version through local migration and backup',()=>{
 const state=emptyState(),siteId='11111111-1111-4111-8111-111111111111',at='2026-10-18T01:00:00Z';
 state.sites=[{id:siteId,domain:'example.com',url:'https://example.com',email:'owner@example.com',name:'Example',description:'Fixture',category:'content',language:'en',monthlyTarget:2,status:'ready',createdAt:at}];
 const actualHostMetric={...metric,target:'example-site.blogspot.com'};
 state.tasks=[{id:'22222222-2222-4222-8222-222222222222',siteId,channelId:'blogger',sourceDomain:'blogspot.com',status:'queued',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'',metrics:[actualHostMetric]}];
 assert.deepEqual(migrateState(structuredClone(state)).tasks[0].metrics,[actualHostMetric]);
 const restored=validateBackup({state,secrets:{}}).state;assert.deepEqual(restored.tasks[0].metrics,[actualHostMetric]);assert.equal(restored.tasks[0].attempts,0);assert.equal(restored.tasks[0].channelId,'blogger');
});
