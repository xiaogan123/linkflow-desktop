import {load} from 'cheerio';
import {publicPagePolicy,withPageNofollow} from './article-visibility';
import {inspectRenderedArticle} from './article-rendering';
import type {OpenAgentChatDependencies,OpenAgentChatRenderedPage} from './openagentchat';
import {THETHINGS_ORIGIN,theThingsPublicUrl} from './thethings';

export function inspectTheThingsNativePage(page:OpenAgentChatRenderedPage,input:{slug:string;title:string;body:string;targetUrl:string}):string {
 const url=theThingsPublicUrl(input.slug),root=page.candidates[0];
 if((page as OpenAgentChatRenderedPage&{occlusionClear?:boolean}).occlusionClear!==true||page.url!==url||page.responseStatus!==200||page.responseMediaType!=='text/html'||page.responseBodyBytes<1||page.responseBodyBytes>2*1024*1024||page.responseEncodedBodyBytes>2*1024*1024||page.hasRefresh||page.hasLoginGate||page.hasPasswordGate||page.canonicals.length!==1||page.canonicals[0]!==url||page.headings.length!==1||!page.headings[0].visible||page.headings[0].text.trim()!==input.title||page.candidates.length!==1||root?.selector!=='article > section'||!root.allTextVisible)throw Error('TheThings 原生文章被遮挡或不可完整核验');
 const main=page.nativeRequests.filter(value=>value.resourceType==='mainFrame');
 if(main.length!==1||main[0].url!==url||page.nativeRequests.some(value=>value.method!=='GET'||new URL(value.url).origin!==THETHINGS_ORIGIN||!['mainFrame','stylesheet'].includes(value.resourceType))||page.nativeRequests.filter(value=>value.resourceType==='stylesheet').length>8)throw Error('TheThings 公开页请求范围已改变');
 const $=load(root.html),policy=publicPagePolicy($,url,page.responseRobots.join(','));
 const metaRobots=page.robots.map(value=>value.content).join(',');
 if(!policy.valid||/(?:^|[,\s])(?:noindex|none)(?:$|[,\s])/i.test(metaRobots))throw Error('TheThings 不允许搜索引擎抓取');
 if($('article > section').length!==1)throw Error('TheThings 原文区块不唯一');
 const inspected=inspectRenderedArticle(root.html,input.body,input.targetUrl,'article > section',{pageUrl:url,robotsHeader:page.responseRobots.join(',')});
 const links=root.links.filter(value=>value.href===input.targetUrl&&value.visible);
 if(!inspected.found||links.length!==1)throw Error('TheThings 公开正文或原生目标链接不一致');
 // Link headers are interpreted alongside the HTML canonical, never ignored.
 for(const header of page.responseLinks)for(const item of header.split(','))if(/\brel\s*=\s*["']?canonical\b/i.test(item)&&!item.trim().startsWith('<'+url+'>'))throw Error('TheThings HTTP canonical 不一致');
 return withPageNofollow(links[0].rel.join(' '),policy.nofollow);
}

export async function readTheThingsRobots(deps:OpenAgentChatDependencies={}):Promise<string>{
  const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,Math.min(60000,Math.max(100,deps.timeoutMs??25000)));
  deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)abort();
  const wait=<T>(promise:Promise<T>)=>new Promise<T>((resolve,reject)=>{const stop=()=>{controller.signal.removeEventListener('abort',stop);reject(Error('TheThings robots 请求已取消'))};if(controller.signal.aborted){void promise.catch(()=>{});stop();return}controller.signal.addEventListener('abort',stop,{once:true});promise.then(value=>{controller.signal.removeEventListener('abort',stop);resolve(value)},error=>{controller.signal.removeEventListener('abort',stop);reject(error)})});
  let response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    if(controller.signal.aborted)throw Error('TheThings robots 请求已取消');
    const url=THETHINGS_ORIGIN+'/robots.txt';response=await wait((deps.fetch??fetch)(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'text/plain'}}));
    if(response.redirected||response.url&&response.url!==url)throw Error('TheThings robots 路径已改变');
    if(response.status===404)return '';
    if(response.status!==200||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='text/plain')throw Error('TheThings robots 不可读取');
    const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>256000))throw Error('TheThings robots 过大');
    reader=response.body?.getReader();if(!reader)return '';const parts:Buffer[]=[];let size=0;
    for(;;){const next=await wait(reader.read());if(next.done)break;size+=next.value.length;if(size>256000)throw Error('TheThings robots 过大');parts.push(Buffer.from(next.value))}
    return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts));
  }finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort);if(reader)void reader.cancel().catch(()=>{});else if(response?.body&&!response.body.locked)void response.body.cancel().catch(()=>{})}
}

export function theThingsRobotsAllows(text:string,path:string,agent:string):boolean{
  const groups:Array<{agents:string[];rules:Array<{allow:boolean;path:string}>}>=[];let current={agents:[] as string[],rules:[] as Array<{allow:boolean;path:string}>};
  for(const line of text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/)){const match=line.replace(/#.*$/,'').trim().match(/^([^:]+):\s*(.*)$/);if(!match)continue;const key=match[1].trim().toLowerCase(),value=match[2].trim();if(key==='user-agent'){if(current.rules.length){groups.push(current);current={agents:[],rules:[]}}current.agents.push(value.toLowerCase())}else if((key==='allow'||key==='disallow')&&current.agents.length&&value)current.rules.push({allow:key==='allow',path:value})}groups.push(current);
  const matches=groups.map(group=>({...group,score:Math.max(-1,...group.agents.map(value=>value==='*'?0:agent.toLowerCase().startsWith(value)?value.length:-1))})).filter(group=>group.score>=0);if(!matches.length)return true;
  const score=Math.max(...matches.map(group=>group.score));let winner:{allow:boolean;length:number}|undefined;
  for(const rule of matches.filter(group=>group.score===score).flatMap(group=>group.rules)){const end=rule.path.endsWith('$'),expression=rule.path.replace(/\$$/,'').split('*').map(value=>value.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*');if(!new RegExp('^'+expression+(end?'$':'')).test(path))continue;const length=Buffer.byteLength(rule.path.replace(/[*$]/g,''));if(!winner||length>winner.length||length===winner.length&&rule.allow)winner={allow:rule.allow,length}}
  return winner?.allow??true;
}

export async function verifyTheThingsPage(input:{slug:string;title:string;body:string;targetUrl:string},deps:OpenAgentChatDependencies={}):Promise<{url:string;rel:string}> {
 if(!deps.renderPage)throw Error('TheThings 原生核验未连接');
 const url=theThingsPublicUrl(input.slug),robots=await readTheThingsRobots(deps);
 if(!['*','googlebot','bingbot'].every(agent=>theThingsRobotsAllows(robots,new URL(url).pathname,agent)))throw Error('TheThings robots 阻止抓取');
 const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,Math.min(60000,Math.max(100,deps.timeoutMs??25000)));
 deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)abort();
 try{if(controller.signal.aborted)throw Error('TheThings 核验已取消');return {url,rel:inspectTheThingsNativePage(await deps.renderPage(url,controller.signal),input)}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort)}
}
