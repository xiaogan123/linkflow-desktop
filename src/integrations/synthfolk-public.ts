import {load} from 'cheerio';
import {publicPagePolicy,withPageNofollow} from './article-visibility';
import type {OpenAgentChatDependencies,OpenAgentChatRenderedPage} from './openagentchat';
import {SYNTHFOLK_ORIGIN,exactSynthfolkStylesheetUrl,synthfolkProfileUrl,synthfolkRegistrationRequest,readSynthfolkOwnProfile,type SynthfolkProfileDraft} from './synthfolk';

const normalize=(value:string)=>value.replace(/\s+/g,' ').trim();
export function inspectSynthfolkNativeProfile(page:OpenAgentChatRenderedPage,draft:SynthfolkProfileDraft):string{
  const url=synthfolkProfileUrl(draft.handle),root=page.candidates[0],visibility=page as OpenAgentChatRenderedPage&{occlusionClear?:boolean;requiredProfileFieldsVisible?:boolean};
  if(visibility.occlusionClear!==true||visibility.requiredProfileFieldsVisible!==true||page.url!==url||page.responseStatus!==200||page.responseMediaType!=='text/html'||page.responseBodyBytes<1||page.responseBodyBytes>2*1024*1024||page.responseEncodedBodyBytes>2*1024*1024||page.hasRefresh||page.hasLoginGate||page.hasPasswordGate||page.canonicals.length!==1||page.canonicals[0]!==url||page.headings.length!==1||!page.headings[0].visible||normalize(page.headings[0].text)!==draft.name||page.candidates.length!==1||root?.selector!=='main')throw Error('Synthfolk 原生公开资料不可完整检查');
  const mainRequests=page.nativeRequests.filter(value=>value.resourceType==='mainFrame');
  if(mainRequests.length!==1||mainRequests[0].url!==url||page.nativeRequests.some(value=>value.method!=='GET'||new URL(value.url).origin!==SYNTHFOLK_ORIGIN||value.resourceType==='stylesheet'&&!exactSynthfolkStylesheetUrl(value.url))||page.nativeRequests.filter(value=>value.resourceType==='stylesheet').length>8)throw Error('Synthfolk 公开资料请求范围已改变');
  const $=load(root.html),main=$('main'),heading=main.find('h1'),identity=heading.parent().parent();
  const policy=publicPagePolicy($,url,page.responseRobots.join('\n'));
  if(!policy.valid||main.length!==1||heading.length!==1||normalize(heading.text())!==draft.name)throw Error('Synthfolk 公开资料标题或抓取策略不匹配');
  // Bind each public field to the profile card, not an unrelated footer or sidebar.
  const paragraphs=identity.children('p').toArray().map(value=>normalize($(value).text()));
  if(!paragraphs.includes('@'+draft.handle)||!paragraphs.includes(draft.headline)||!paragraphs.includes(`Works for ${draft.operator} (self-reported)`)||!identity.find('span').toArray().some(value=>normalize($(value).text())==='Not taking work'))throw Error('Synthfolk 发布账号、负责人披露或工作状态不一致');
  const about=main.find('h2').filter((_i,value)=>normalize($(value).text())==='About');
  if(about.length!==1||about.parent().children('p').length!==1||normalize(about.parent().children('p').text())!==normalize(draft.about))throw Error('Synthfolk 公开介绍不完整或已改变');
  const skills=main.find('h2').filter((_i,value)=>normalize($(value).text())==='Skills');
  const shownSkills=skills.parent().find('li a').toArray().map(value=>normalize($(value).text())).sort();
  if(skills.length!==1||JSON.stringify(shownSkills)!==JSON.stringify([...draft.skills].sort()))throw Error('Synthfolk 公开技能与审核资料不一致');
  const links=root.links.filter(value=>value.href===draft.website&&normalize(value.text)==='Website');
  if(links.length!==1||!links[0].visible)throw Error('Synthfolk 原生 Website 链接不可见或不唯一');
  const htmlLinks=main.find('a[href]').filter((_i,value)=>$(value).attr('href')===draft.website&&normalize($(value).text())==='Website');
  if(htmlLinks.length!==1)throw Error('Synthfolk 目标地址不一致');
  for(const header of page.responseLinks){for(const item of header.split(',')){if(/\brel\s*=\s*["']?canonical\b/i.test(item)&&!item.trim().startsWith('<'+url+'>'))throw Error('Synthfolk 服务器标注的规范网址不一致')}}
  return withPageNofollow(links[0].rel.join(' '),policy.nofollow);
}

// This profile route is public. A 404 robots response means no robots rules;
// transport failures and unexpected redirects must not be treated as permission.
export async function readSynthfolkRobots(deps:OpenAgentChatDependencies={}):Promise<string>{
  const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,Math.min(60000,Math.max(100,deps.timeoutMs??25000)));
  deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)abort();
  const wait=<T>(promise:Promise<T>)=>new Promise<T>((resolve,reject)=>{const stop=()=>{controller.signal.removeEventListener('abort',stop);reject(Error('Synthfolk 抓取规则请求已取消'))};if(controller.signal.aborted){void promise.catch(()=>{});stop();return}controller.signal.addEventListener('abort',stop,{once:true});promise.then(value=>{controller.signal.removeEventListener('abort',stop);resolve(value)},error=>{controller.signal.removeEventListener('abort',stop);reject(error)})});
  let response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    if(controller.signal.aborted)throw Error('Synthfolk 抓取规则请求已取消');
    const url=SYNTHFOLK_ORIGIN+'/robots.txt';response=await wait((deps.fetch??fetch)(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'text/plain'}}));
    if(response.redirected||response.url&&response.url!==url)throw Error('Synthfolk 抓取规则路径已改变');
    if(response.status===404)return '';
    if(response.status!==200||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='text/plain')throw Error('Synthfolk 抓取规则不可读取');
    const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>256000))throw Error('Synthfolk 抓取规则过大');
    reader=response.body?.getReader();if(!reader)return '';const parts:Buffer[]=[];let size=0;
    for(;;){const next=await wait(reader.read());if(next.done)break;size+=next.value.length;if(size>256000)throw Error('Synthfolk 抓取规则过大');parts.push(Buffer.from(next.value))}
    return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts));
  }finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort);if(reader)void reader.cancel().catch(()=>{});else if(response?.body&&!response.body.locked)void response.body.cancel().catch(()=>{})}
}

export function synthfolkRobotsAllows(text:string,path:string,agent:string):boolean{
  const groups:Array<{agents:string[];rules:Array<{allow:boolean;path:string}>}>=[];let current={agents:[] as string[],rules:[] as Array<{allow:boolean;path:string}>};
  for(const line of text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/)){const match=line.replace(/#.*$/,'').trim().match(/^([^:]+):\s*(.*)$/);if(!match)continue;const key=match[1].trim().toLowerCase(),value=match[2].trim();if(key==='user-agent'){if(current.rules.length){groups.push(current);current={agents:[],rules:[]}}current.agents.push(value.toLowerCase())}else if((key==='allow'||key==='disallow')&&current.agents.length&&value)current.rules.push({allow:key==='allow',path:value})}groups.push(current);
  const matches=groups.map(group=>({...group,score:Math.max(-1,...group.agents.map(value=>value==='*'?0:agent.toLowerCase().startsWith(value)?value.length:-1))})).filter(group=>group.score>=0);if(!matches.length)return true;
  const score=Math.max(...matches.map(group=>group.score));let winner:{allow:boolean;length:number}|undefined;
  for(const rule of matches.filter(group=>group.score===score).flatMap(group=>group.rules)){const end=rule.path.endsWith('$'),expression=rule.path.replace(/\$$/,'').split('*').map(value=>value.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*');if(!new RegExp('^'+expression+(end?'$':'')).test(path))continue;const length=Buffer.byteLength(rule.path.replace(/[*$]/g,''));if(!winner||length>winner.length||length===winner.length&&rule.allow)winner={allow:rule.allow,length}}
  return winner?.allow??true;
}

export async function verifySynthfolkProfile(draft:SynthfolkProfileDraft,key:string,deps:OpenAgentChatDependencies={}):Promise<{url:string;rel:string;claimed:boolean}>{
  synthfolkRegistrationRequest(draft,draft.website);
  if(!deps.renderPage)throw Error('Synthfolk 原生公开页面检查未连接');
  const own=await readSynthfolkOwnProfile(draft,key,deps),robots=await readSynthfolkRobots(deps),url=synthfolkProfileUrl(draft.handle);
  if(!['*','googlebot','bingbot'].every(agent=>synthfolkRobotsAllows(robots,new URL(url).pathname,agent)))throw Error('Synthfolk 抓取规则阻止抓取资料');
  const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,Math.min(60000,Math.max(100,deps.timeoutMs??25000)));deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)abort();
  try{return {url,rel:inspectSynthfolkNativeProfile(await deps.renderPage(url,controller.signal),draft),claimed:own.claimed}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort)}
}
