import {load} from 'cheerio';
import {marked} from 'marked';
import {publicPagePolicy,withPageNofollow} from './article-visibility';
import {readOpenAgentChatJson,type OpenAgentChatDependencies,type OpenAgentChatRenderedPage} from './openagentchat';
import {AGENTBOARD_ME,AGENTBOARD_ORIGIN,agentboardThreadApi,agentboardThreadUrl,parseAgentboardAgent,parseAgentboardThread,readAgentboardOwnedThread,type AgentboardAgent,type AgentboardFirstDraft,type AgentboardFirstReceipt,type AgentboardThread} from './agentboard';
import {AGENTBOARD_NATIVE_STYLESHEET_URLS,exactAgentboardStylesheetUrl} from './agentboard-native-policy';
import {readAgentboardRobots,agentboardRobotsAllows} from './agentboard-robots';

const normalize=(value:string)=>value.replace(/\s+/g,' ').trim();
const selector='main#main-content > div.thread-body';
export interface AgentboardPublicationSpec {credential:string;agent:AgentboardAgent;thread:AgentboardThread;board:string;title:string;body:string;targetUrl:string}

export function inspectAgentboardNativePublication(page:OpenAgentChatRenderedPage,spec:AgentboardPublicationSpec):string{
  const url=agentboardThreadUrl(spec.thread.id),candidate=page.candidates[0];
  if((page as OpenAgentChatRenderedPage&{occlusionClear?:boolean}).occlusionClear!==true||page.url!==url||page.responseStatus!==200||page.responseMediaType!=='text/html'||page.responseBodyBytes<1||page.responseBodyBytes>2*1024*1024||page.responseEncodedBodyBytes>2*1024*1024||page.hasRefresh||page.hasLoginGate||page.hasPasswordGate||page.canonicals.length!==1||page.canonicals[0]!==url||page.headings.length!==1||!page.headings[0].visible||normalize(page.headings[0].text)!==spec.title||page.candidates.length!==1||candidate?.selector!==selector||!candidate.allTextVisible)throw Error('Agentboard 主帖正文被遮挡或不可完整检查');
  const mainRequests=page.nativeRequests.filter(v=>v.resourceType==='mainFrame'),stylesheets=page.nativeRequests.filter(v=>v.resourceType==='stylesheet');
  if(mainRequests.length!==1||mainRequests[0].url!==url||page.nativeRequests.length!==mainRequests.length+stylesheets.length||page.nativeRequests.some(v=>v.method!=='GET')||stylesheets.length>AGENTBOARD_NATIVE_STYLESHEET_URLS.length||new Set(stylesheets.map(v=>v.url)).size!==stylesheets.length||stylesheets.some(v=>!exactAgentboardStylesheetUrl(v.url)))throw Error('Agentboard 匿名页面请求范围已改变');
  const $=load(candidate.html),main=$('main#main-content'),article=$(selector),heading=main.children('h1'),expected=load(marked.parse(spec.body,{async:false}));
  const policy=publicPagePolicy($,url,page.responseRobots.join('\n'));
  if(!policy.valid||main.length!==1||heading.length!==1||normalize(heading.text())!==spec.title||article.length!==1||normalize(article.text())!==normalize(expected('body').text())||normalize(candidate.text)!==normalize(expected('body').text()))throw Error('Agentboard 主帖正文、标题或抓取策略不匹配');
  const authorLinks=main.children('p.meta').not('.board-crumb').find('a[href]').filter((_i,e)=>{try{return new URL($(e).attr('href')!,url).href===spec.agent.publicUrl&&normalize($(e).text())===spec.agent.handle}catch{return false}});
  const boardLinks=main.children('.board-crumb').find('a[href]').filter((_i,e)=>{try{return new URL($(e).attr('href')!,url).href===AGENTBOARD_ORIGIN+'/b/'+spec.board}catch{return false}});
  if(authorLinks.length!==1||boardLinks.length!==1)throw Error('Agentboard 主帖作者或版块未匹配');
  const expectedLinks=expected('a[href]').toArray().map(e=>({href:expected(e).attr('href')!,text:normalize(expected(e).text())}));
  const htmlLinks=article.find('a[href]').toArray().map(e=>({href:new URL($(e).attr('href')!,url).href,text:normalize($(e).text())}));
  if(JSON.stringify(htmlLinks)!==JSON.stringify(expectedLinks)||candidate.links.length!==expectedLinks.length||candidate.links.some((v,i)=>!v.visible||v.href!==expectedLinks[i].href||normalize(v.text)!==expectedLinks[i].text))throw Error('Agentboard 主帖原生链接与审核稿不一致');
  const target=candidate.links.filter(v=>v.href===spec.targetUrl);
  if(target.length!==1)throw Error('Agentboard 主帖目标链接不唯一');
  for(const header of page.responseLinks)for(const item of header.split(','))if(/\brel\s*=\s*["']?canonical\b/i.test(item)&&!item.trim().startsWith('<'+url+'>'))throw Error('Agentboard 服务器标注的规范网址不一致');
  return withPageNofollow(target[0].rel.join(' '),policy.nofollow);
}

export function inspectAgentboardNativeThread(page:OpenAgentChatRenderedPage,receipt:AgentboardFirstReceipt,draft:AgentboardFirstDraft):string{
  return inspectAgentboardNativePublication(page,{credential:receipt.credential,agent:{id:receipt.thread.agentId,handle:receipt.handle,name:draft.agent.name,description:draft.agent.description,homepage:draft.agent.homepage,operatorName:draft.agent.operatorName,publicUrl:receipt.agentUrl},thread:receipt.thread,board:'introductions',title:draft.title,body:draft.body,targetUrl:draft.agent.homepage});
}

export async function readAgentboardPublication(spec:AgentboardPublicationSpec,deps:OpenAgentChatDependencies={}){
  const own=parseAgentboardAgent(await readOpenAgentChatJson(AGENTBOARD_ME,spec.credential,deps));
  if(!own||JSON.stringify(own)!==JSON.stringify(spec.agent)||own.id!==spec.thread.agentId)throw Error('Agentboard 原账号未匹配');
  const thread=parseAgentboardThread(await readOpenAgentChatJson(agentboardThreadApi(spec.thread.id),undefined,deps));
  if(!thread||JSON.stringify(thread)!==JSON.stringify(spec.thread)||thread.agentId!==own.id)throw Error('Agentboard 原主帖回读未匹配');
  return {agent:own,thread};
}

export async function verifyAgentboardPublication(spec:AgentboardPublicationSpec,deps:OpenAgentChatDependencies={}):Promise<{url:string;rel:string;agent:AgentboardAgent;thread:AgentboardThread}>{
  if(!deps.renderPage)throw Error('Agentboard 原生公开页面检查未连接');
  const owned=await readAgentboardPublication(spec,deps),robots=await readAgentboardRobots(deps),url=agentboardThreadUrl(spec.thread.id);
  if(!['*','googlebot','bingbot'].every(a=>agentboardRobotsAllows(robots,new URL(url).pathname,a)))throw Error('Agentboard 抓取规则阻止抓取主帖');
  const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,Math.min(60000,Math.max(100,deps.timeoutMs??25000)));deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)abort();
  try{return {url,rel:inspectAgentboardNativePublication(await deps.renderPage(url,controller.signal),spec),...owned}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort)}
}

export async function verifyAgentboardThread(receipt:AgentboardFirstReceipt,draft:AgentboardFirstDraft,boardId:string,deps:OpenAgentChatDependencies={}):Promise<{url:string;rel:string}>{
  if(!deps.renderPage)throw Error('Agentboard 原生公开页面检查未连接');
  await readAgentboardOwnedThread(receipt,draft,boardId,deps);
  const spec:AgentboardPublicationSpec={credential:receipt.credential,agent:{id:receipt.thread.agentId,handle:receipt.handle,name:draft.agent.name,description:draft.agent.description,homepage:draft.agent.homepage,operatorName:draft.agent.operatorName,publicUrl:receipt.agentUrl},thread:receipt.thread,board:'introductions',title:draft.title,body:draft.body,targetUrl:draft.agent.homepage};
  const robots=await readAgentboardRobots(deps),url=agentboardThreadUrl(receipt.thread.id);
  if(!['*','googlebot','bingbot'].every(a=>agentboardRobotsAllows(robots,new URL(url).pathname,a)))throw Error('Agentboard 抓取规则阻止抓取主帖');
  const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,Math.min(60000,Math.max(100,deps.timeoutMs??25000)));deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)abort();
  try{return {url,rel:inspectAgentboardNativePublication(await deps.renderPage(url,controller.signal),spec)}}finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',abort)}
}
