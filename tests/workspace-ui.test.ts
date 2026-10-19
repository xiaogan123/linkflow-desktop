import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {demoSnapshot} from '../src/ui/demo';
import {parseSiteInput, overviewNumbers, todoTasks, siteState, passesWeight, uniquePublications} from '../src/ui/dashboard-model';
import {OverviewPage, WebsitesPage, SiteDetailPage} from '../src/ui/pages/WorkspacePages';
import {TaskCenter} from '../src/ui/pages/TaskCenter';
import {AddSitesForm} from '../src/ui/pages/AddSitesForm';
import type {Snapshot, Task} from '../src/shared/types';
const now=new Date(),noop=()=>{},onAction=async<T,>():Promise<T|undefined>=>undefined;
function snapshot(){return structuredClone(demoSnapshot)}
const props=(data:Snapshot)=>({data,now,disabled:true,onAction,onSite:noop});

test('website import accepts multiline URLs and real CSV escaping, headings and CRLF',()=>{
 assert.deepEqual(parseSiteInput('example.com\r\nhttps://two.example.com/'),['example.com','https://two.example.com/']);
 assert.deepEqual(parseSiteInput('\uFEFFname,网址\r\n"example, one",https://one.example.com/\r\n"two\nlines",two.example.com'),['https://one.example.com/','two.example.com']);
 assert.deepEqual(parseSiteInput(''),[]);
 assert.deepEqual(parseSiteInput('网址\n'),[]);
});
test('overview counts actual published links and never counts unknown link attributes as passing weight',()=>{
 const data=snapshot(),task=data.tasks.find(t=>t.firstLiveAt&&t.health==='healthy'&&t.linkCheck==='found')!;
 data.tasks=[task,{...task,id:'duplicate',updatedAt:new Date(now.getTime()+1000).toISOString()}];
 assert.equal(uniquePublications(data.tasks).length,1);
 assert.equal(overviewNumbers(data,now).current,1);
 assert.equal(passesWeight({...task,linkRel:undefined}),false);
 assert.equal(passesWeight({...task,linkRel:'UGC nofollow'}),false);
 assert.equal(passesWeight({...task,linkRel:''}),true);
});
test('dashboard has exactly four defined metrics and no technical task message',()=>{
 const data=snapshot();data.tasks.forEach(t=>t.message='TECHNICAL_SENTINEL');
 // Only a ready site's capacity can be short; the demo's unreadable site is shown as a failed analysis instead.
 data.sites=data.sites.map(site=>site.status==='attention'?{...site,status:'ready' as const}:site);
 const html=renderToStaticMarkup(createElement(OverviewPage,{...props(data),onAdd:noop,onTodos:noop,onSettings:noop,onPlatforms:noop,onTask:noop}));
 for(const label of ['本月新增外链','现在有效','可传权重','Google 报告里出现'])assert.ok(html.includes(label));
 assert.equal((html.match(/class="stat panel"/g)??[]).length,4);
 assert.doesNotMatch(html,/TECHNICAL_SENTINEL/);
 assert.match(html,/平台不够用/);assert.match(html,/aria-sort="ascending"/);
});
test('empty dashboard and website list offer the specified batch entry',()=>{
 const data=snapshot();data.sites=[];data.tasks=[];
 const html=renderToStaticMarkup(createElement(OverviewPage,{...props(data),onAdd:noop,onTodos:noop,onSettings:noop,onPlatforms:noop,onTask:noop}));
 assert.match(html,/还没有网站/);assert.match(html,/粘贴网址，外链助手会自动分析每个站，并把外链分散排进每个月。/);
 const sites=renderToStaticMarkup(createElement(WebsitesPage,{...props(data),onAdd:noop}));assert.match(sites,/0 个网站/);
});
test('website list hides archived records while keeping historical data available',()=>{
 const data=snapshot();data.sites[0].archivedAt=now.toISOString();data.sites[0].status='paused';
 const html=renderToStaticMarkup(createElement(WebsitesPage,{...props(data),onAdd:noop}));assert.match(html,/14 个网站/);assert.ok(!html.includes(data.sites[0].domain));
 assert.equal(data.sites.length,15);assert.equal(siteState(data.sites[0],data,now),'已暂停');
});
test('todos render all four groups, urgency and action buttons with technical text only in disclosure',()=>{
 const data=snapshot();data.tasks.forEach(t=>t.message='TECHNICAL_SENTINEL');
 const html=renderToStaticMarkup(createElement(TaskCenter,{data,now,disabled:true,status:'all',onStatusChange:noop,onAction,onEditDraft:noop,onSetUrl:noop,onSite:noop}));
 for(const label of ['要你验证','要你连接账号','要你看稿','软件写好、等你发','马上过期','去验证','跳过'])assert.ok(html.includes(label),label);
 assert.equal((html.match(/class="technical-details"/g)??[]).length,todoTasks(data,now).length);
 assert.doesNotMatch(html.replace(/<details[\s\S]*?<\/details>/g,''),/TECHNICAL_SENTINEL/);
});
test('site details expose five tabs and published links with report state',()=>{
 const data=snapshot(),site=data.sites.find(s=>data.tasks.some(t=>t.siteId===s.id&&t.firstLiveAt))!;
 const html=renderToStaticMarkup(createElement(SiteDetailPage,{site,data,now,disabled:true,onAction,onEdit:noop,onMigrate:noop,onBack:noop,renderTask:()=>null,tools:null}));
 assert.match(html,/role="group" aria-label="网站详情">(?:<button[^>]*aria-pressed="(?:true|false)"[^>]*>[^<]*<\/button>){5}<\/div>/);
 for(const label of ['写作风格','推广内容','Google 报告','发布日期'])assert.ok(html.includes(label));
});
test('batch import defaults to two links and recommended automatic publishing without requiring email',()=>{
 const html=renderToStaticMarkup(createElement(AddSitesForm,{disabled:false,onAction,onClose:noop}));
 assert.match(html,/value="2"/);assert.match(html,/value="ai" selected=""/);assert.match(html,/每篇我先看：稿子写好后等你确认，48 小时没看就放弃这篇。/);
 const email=html.match(/<input[^>]+type="email"[^>]*>/)?.[0];assert.ok(email);assert.doesNotMatch(email,/required/);
});


test('site link table never labels stale positive checks as currently valid',()=>{
 for(const extra of [{status:'live' as const,health:'unknown' as const},{status:'expired' as const,health:'pending' as const}]){
  const data=snapshot(),task=data.tasks.find(t=>t.firstLiveAt)!,site=data.sites.find(s=>s.id===task.siteId)!;
  data.tasks=[{...task,...extra,linkCheck:'found'}];
  const html=renderToStaticMarkup(createElement(SiteDetailPage,{site,data,now,disabled:true,onAction,onEdit:noop,onMigrate:noop,onBack:noop,renderTask:()=>null,tools:null}));
  assert.doesNotMatch(html,/>有效</);
  assert.match(html,extra.status==='expired'?/找不到了/:/页面打不开/);
 }
});
