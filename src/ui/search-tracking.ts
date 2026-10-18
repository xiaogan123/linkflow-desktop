import type {SearchReport,Site,Task} from '../shared/types';

export type TrackingEngine='all'|'gsc'|'bing';
export type TrackingStatus='all'|'missing'|'error'|'discovered';
export function trackingUrl(value:string|undefined):string|undefined{
  if(!value)return;
  try{const url=new URL(value.trim());if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return;url.hash='';return url.href}catch{return}
}
export interface ReportIndex {report?:SearchReport;current:Set<string>;history:Map<string,string>}
export function indexReport(report?:SearchReport):ReportIndex{
  const current=new Set<string>(),history=new Map<string,string>();
  if(report&&!report.error)for(const value of report.sources){const url=trackingUrl(value);if(url)current.add(url)}
  for(const [value,at] of Object.entries(report?.firstSeenAt??{})){const url=trackingUrl(value);if(url)history.set(url,at)}
  return {report,current,history};
}
export interface TrackingRow {site:Site;publications:Map<string,Task>;gsc:ReportIndex;bing:ReportIndex;gscMatches:number;bingMatches:number}
export function buildTrackingRows(sites:Site[],tasks:Task[]):TrackingRow[]{
  const grouped=new Map<string,Map<string,Task>>();
  for(const task of tasks){const url=trackingUrl(task.publicUrl);if(!url)continue;let map=grouped.get(task.siteId);if(!map){map=new Map();grouped.set(task.siteId,map)}const previous=map.get(url);if(!previous||task.updatedAt>previous.updatedAt)map.set(url,task)}
  return sites.map(site=>{
    const publications=grouped.get(site.id)??new Map<string,Task>(),gsc=indexReport(site.searchReports?.gsc),bing=indexReport(site.searchReports?.bing);
    let gscMatches=0,bingMatches=0;
    for(const url of publications.keys()){if(gsc.current.has(url)||gsc.history.has(url))gscMatches++;if(bing.current.has(url))bingMatches++}
    return {site,publications,gsc,bing,gscMatches,bingMatches};
  });
}
export function matchesTrackingRow(row:TrackingRow,query:string,siteId:string,engine:TrackingEngine,status:TrackingStatus):boolean{
  if(siteId!=='all'&&row.site.id!==siteId)return false;
  const indexes=engine==='all'?[row.gsc,row.bing]:[row[engine]];
  if(status==='missing'&&!indexes.some(index=>!index.report))return false;
  if(status==='error'&&!indexes.some(index=>index.report?.error))return false;
  if(status==='discovered'&&!(engine==='gsc'?row.gscMatches:engine==='bing'?row.bingMatches:row.gscMatches+row.bingMatches))return false;
  const q=query.trim().toLowerCase();if(!q)return true;
  if(`${row.site.domain} ${row.site.name}`.toLowerCase().includes(q))return true;
  for(const url of row.publications.keys())if(url.toLowerCase().includes(q))return true;
  return indexes.some(index=>[...index.current,...index.history.keys()].some(url=>url.toLowerCase().includes(q)));
}
export function reportSampleLabel(index:ReportIndex,url:string):string{
  if(!index.report)return '尚未导入 / 检查';
  if(index.report.error)return '本次检查失败';
  return index.current.has(url)?'本次样本出现':'本次样本未出现';
}
export function pageLinkLabel(task:Task):string{
  if(task.linkCheck==='found')return '公开页链接已核验';
  if(task.linkCheck==='absent')return '本次网页未发现链接';
  if(task.linkCheck==='unreachable')return '本次网页暂不可达';
  if(task.linkCheck==='invalid')return '地址不符合渠道要求';
  return task.verifiedAt?'曾核验存在，当前待检查':'尚未核验';
}

export function trackingDetailUrls(row:TrackingRow,view:'published'|'sources',query:string):string[]{
  const urls=view==='published'?[...row.publications.keys()]:[...new Set([...row.gsc.current,...row.bing.current])];
  const q=query.trim().toLowerCase();
  return !q||`${row.site.domain} ${row.site.name}`.toLowerCase().includes(q)?urls:urls.filter(url=>url.toLowerCase().includes(q));
}
export function reportSourcesEmptyLabel(row:TrackingRow):string{
  const reports=[row.gsc.report,row.bing.report];
  if(reports.every(report=>!report))return '尚未导入 GSC 或检查 Bing，暂无可展示的报告来源。';
  if(!reports.some(report=>report&&!report.error))return '报告检查失败，保留的旧样本不会作为本次结果展示。';
  return '当前成功报告没有来源记录；空样本不代表全网没有外链。';
}
