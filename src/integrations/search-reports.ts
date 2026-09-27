import https from 'node:https';
import type {SearchReport} from '../shared/types';

export function canonicalSource(value:string):string|undefined{
 try{const u=new URL(value.trim());if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return;u.hash='';return u.href}catch{return}
}
export function sourceReported(report:SearchReport|undefined,url:string|undefined):'reported'|'not_reported'|'unknown'{
 if(!report||report.error||!url)return 'unknown';
 const source=canonicalSource(url);return source&&report.sources.includes(source)?'reported':report.complete?'not_reported':'unknown';
}
// CSV exports are snapshots, not a live Google API and not proof of indexing.
export function parseGscLinksCsv(csv:string,now=new Date()):SearchReport{
 if(Buffer.byteLength(csv,'utf8')>2_000_000)throw Error('CSV 文件超过 2 MB');
 const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
 const input=csv.replace(/^\uFEFF/,'');
 for(let i=0;i<input.length;i++){
  const c=input[i];if(c==='"'){if(quoted&&input[i+1]==='"'){cell+='"';i++}else quoted=!quoted}
  else if(c===','&&!quoted){row.push(cell);cell=''}
  else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&input[i+1]==='\n')i++;row.push(cell);if(row.some(Boolean))rows.push(row);row=[];cell=''}
  else cell+=c;
 }
 if(quoted)throw Error('CSV 引号不完整');row.push(cell);if(row.some(Boolean))rows.push(row);
 const headers=rows.shift()?.map(x=>x.trim().toLowerCase())??[];
 const column=headers.findIndex(h=>['linking page','linking pages','source url','source','链接页面','链接网页','引荐网页','最常见的引荐网页','链接页','来源网址'].includes(h));
 if(column<0)throw Error('请选择 GSC 导出的外部链接来源网页 CSV；目标网页或来源域名汇总不能核验具体外链');
 const values=rows.map(r=>r[column]?.trim()).filter(Boolean);
 const sources=[...new Set(values.map(canonicalSource).filter((s):s is string=>!!s))];
 if(values.length&&!sources.length)throw Error('CSV 中没有完整的来源网页 URL');
 if(sources.length>20000)throw Error('来源记录超过 20000 条，请拆分导出');
 return {checkedAt:now.toISOString(),method:'csv',sources,complete:false,message:`导入 ${sources.length} 条 GSC 来源网页记录。报告仅为样本；未出现的链接不能认定不存在。`};
}
export type BingCall=(method:'GetUserSites'|'GetUrlLinks',params:Record<string,string|number>,key:string,signal?:AbortSignal)=>Promise<unknown>;
export const callBing:BingCall=async(method,params,key,signal)=>{
 const url=new URL('https://ssl.bing.com/webmaster/api.svc/json/'+method);
 for(const [name,value]of Object.entries(params))url.searchParams.set(name,String(value));url.searchParams.set('apikey',key);
 // Official endpoint requires the key as a query field. Never log a request URL or native error.
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(Error('搜索报告检查已取消'));return}
  let finished=false;const done=(error?:Error,value?:unknown)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value)};
  const req=https.get(url,{headers:{accept:'application/json'},agent:false},res=>{
   if(res.statusCode!==200){res.resume();done(Error(`Bing 报告请求未成功（HTTP ${res.statusCode??0}）`));return}
   const chunks:Buffer[]=[];let bytes=0;
   res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>2_000_000){done(Error('Bing 报告响应过大'));req.destroy();return}chunks.push(chunk)});
   res.on('error',()=>done(Error('Bing 响应中断')));
   res.on('end',()=>{try{done(undefined,JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{done(Error('Bing 返回了无法解析的报告'))}});
  });
  const abort=()=>{done(Error('搜索报告检查已取消'));req.destroy()};
  const timer=setTimeout(()=>{done(Error('Bing 报告请求超时'));req.destroy()},15000);
  signal?.addEventListener('abort',abort,{once:true});req.on('error',()=>done(Error('Bing 报告连接失败，请检查网络与凭据')));
 });
};
function unwrap(value:unknown):unknown{if(!value||typeof value!=='object'||!('d'in value)||'ErrorCode'in value)throw Error('Bing 拒绝报告请求，请检查 API Key 和网站权限');return (value as {d:unknown}).d}
export async function readBingLinks(siteUrl:string,key:string,signal?:AbortSignal,call:BingCall=callBing):Promise<SearchReport>{
 if(!key.trim())throw Error('请先连接 Bing API Key');
 const target=new URL(siteUrl);if(target.protocol!=='https:'||target.username||target.password)throw Error('网站地址无效');
 const sites=unwrap(await call('GetUserSites',{},key,signal));if(!Array.isArray(sites))throw Error('Bing 网站权限响应异常');
 const resource=sites.find(s=>{try{return typeof s.Url==='string'&&new URL(s.Url).hostname.toLowerCase().replace(/^www\./,'')===target.hostname.toLowerCase().replace(/^www\./,'')&&s.IsVerified===true}catch{return false}});
 if(!resource)throw Error('当前 Bing Key 下没有该网站的已验证资源');
 const sources:string[]=[];let totalPages=1,page=0;
 // Bounded pagination; one homepage target only, explicitly recorded as such.
 do{
  if(signal?.aborted)throw Error('搜索报告检查已取消');
  const value=unwrap(await call('GetUrlLinks',{siteUrl:resource.Url,link:target.href,page},key,signal)) as {Details?:unknown;TotalPages?:unknown};
  if(!value||!Array.isArray(value.Details)||typeof value.TotalPages!=='number'||!Number.isInteger(value.TotalPages)||value.TotalPages<0)throw Error('Bing 外链报告格式异常');
  totalPages=value.TotalPages;
  for(const detail of value.Details){const u=canonicalSource(detail?.Url??'');if(u)sources.push(u)}
  if(sources.length>20000)throw Error('Bing 报告记录过多');page++;
 }while(page<totalPages&&page<10);
 return {checkedAt:new Date().toISOString(),method:'api',targetUrl:target.href,sources:[...new Set(sources)],complete:false,message:sources.length?`Bing 已报告 ${new Set(sources).size} 条指向该首页的来源网页${totalPages>10?'（仅取前 10 页）':''}；报告可能不完整。`:'Bing 暂无可报告的首页外链数据；不代表全网没有外链。'};
}
