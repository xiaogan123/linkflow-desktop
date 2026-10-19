import test from 'node:test';
import assert from 'node:assert/strict';
import type {Site,Task,SearchReport} from '../src/shared/types';
import {buildTrackingRows,matchesTrackingRow,pageLinkLabel,reportSampleLabel,trackingUrl,trackingDetailUrls,reportSourcesEmptyLabel} from '../src/ui/search-tracking';

const stamp='2026-01-01T00:00:00.000Z',a='https://outside.example/a',b='https://outside.example/b';
const site=(id:string,reports:Site['searchReports']={}):Site=>({id,domain:id+'.example',url:'https://'+id+'.example',email:'owner@example.test',name:id,description:'Fixture',category:'software',language:'en',monthlyTarget:2,status:'ready',createdAt:stamp,searchReports:reports});
const task=(id:string,siteId:string,url:string,extra:Partial<Task>={}):Task=>({id,siteId,channelId:'fixture',sourceDomain:'outside.example',status:'live',publicUrl:url,createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'Fixture',...extra});
const report=(sources:string[],extra:Partial<SearchReport>={}):SearchReport=>({method:'csv',checkedAt:stamp,sources,complete:false,message:'Fixture',...extra});

test('report state separates missing, empty, current matches and historical confirmations',()=>{
  const rows=buildTrackingRows([site('missing'),site('empty',{gsc:report([])}),site('current',{gsc:report([a])}),site('history',{gsc:report([],{firstSeenAt:{[a]:stamp}})})],['missing','empty','current','history'].map(id=>task(id,id,a)));
  assert.equal(reportSampleLabel(rows[0].gsc,a),'尚未导入 / 检查');
  assert.equal(reportSampleLabel(rows[1].gsc,a),'本次样本未出现');
  assert.equal(rows[2].gscMatches,1);assert.equal(reportSampleLabel(rows[2].gsc,a),'本次样本出现');
  assert.equal(rows[3].gscMatches,1);assert.equal(reportSampleLabel(rows[3].gsc,a),'本次样本未出现');assert.equal(rows[3].gsc.history.get(a),stamp);
});
test('failed Bing attempts cannot turn retained sources into current matches',()=>{
  const row=buildTrackingRows([site('one',{bing:report([a],{method:'api',error:true})})],[task('1','one',a)])[0];
  assert.equal(row.bingMatches,0);assert.equal(row.bing.current.size,0);assert.equal(reportSampleLabel(row.bing,a),'本次检查失败');assert(matchesTrackingRow(row,'','all','bing','error'));assert(!matchesTrackingRow(row,'','all','bing','discovered'));
});
test('exact normalized URLs remain scoped to the owning site and duplicate tasks do not inflate counts',()=>{
  const rows=buildTrackingRows([site('one',{gsc:report([a,b])}),site('two',{gsc:report([b])})],[task('1','one',a+'#part'),task('2','one',a,{updatedAt:'2026-01-02',linkCheck:'absent'}),task('3','two',a)]);
  assert.equal(rows[0].publications.size,1);assert.equal(rows[0].gscMatches,1);assert.equal(rows[0].publications.get(a)?.id,'2');assert.equal(rows[1].gscMatches,0);
  assert.equal(trackingUrl('javascript:alert(1)'),undefined);assert.equal(trackingUrl('https://name:secret@example.test/'),undefined);assert.notEqual(trackingUrl(a+'?x=1'),trackingUrl(a+'?x=2'));
});
test('source URL search works even without published hits and respects engine/site/status filters',()=>{
  const row=buildTrackingRows([site('one',{gsc:report([a]),bing:report([b])})],[])[0];
  assert(matchesTrackingRow(row,'/a','one','gsc','all'));assert(!matchesTrackingRow(row,'/a','two','gsc','all'));assert(!matchesTrackingRow(row,'/a','one','bing','all'));assert(!matchesTrackingRow(row,'','one','all','discovered'));assert(!matchesTrackingRow(row,'','one','all','missing'));
});
test('current page verification failure remains distinct from historical or search-report evidence',()=>{
  assert.equal(pageLinkLabel(task('1','one',a,{verifiedAt:stamp,linkCheck:'absent'})),'找不到了');
  assert.equal(pageLinkLabel(task('1','one',a,{verifiedAt:stamp,linkCheck:'unreachable'})),'页面打不开');
  assert.equal(pageLinkLabel(task('1','one',a,{verifiedAt:stamp})),'待复查');
  assert.equal(pageLinkLabel(task('1','one',a,{linkCheck:'found'})),'有效');
});
test('100 sites and a maximum 20000-source report retain exact counts without changing snapshots',()=>{
  const sites=Array.from({length:100},(_,i)=>site('s'+i,{gsc:report(i===0?Array.from({length:20000},(_,j)=>a+'/'+j):[a])}));
  const tasks=sites.map(s=>task(s.id,s.id,s.id==='s0'?a+'/19999':a)),before=JSON.stringify({sites,tasks});
  const rows=buildTrackingRows(sites,tasks);assert.equal(rows.length,100);assert.equal(rows[0].gsc.current.size,20000);assert.equal(rows.reduce((n,row)=>n+row.gscMatches,0),100);assert.equal(JSON.stringify({sites,tasks}),before);
});

test('a source search exposes the matching URL inside details without paging through unrelated entries',()=>{
  const row=buildTrackingRows([site('one',{gsc:report(Array.from({length:20000},(_,i)=>a+'/'+i))})],[])[0];
  assert.deepEqual(trackingDetailUrls(row,'sources','/19999'),[a+'/19999']);
  assert.equal(trackingDetailUrls(row,'sources','one.example').length,20000);
});
test('no-report and failed-report detail empty states never claim a successful empty sample',()=>{
  assert.match(reportSourcesEmptyLabel(buildTrackingRows([site('missing')],[])[0]),/尚未导入/);
  assert.match(reportSourcesEmptyLabel(buildTrackingRows([site('failed',{bing:report([a],{error:true})})],[])[0]),/检查失败/);
  assert.match(reportSourcesEmptyLabel(buildTrackingRows([site('empty',{gsc:report([])})],[])[0]),/当前成功报告没有/);
});
