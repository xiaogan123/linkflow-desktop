import {load} from 'cheerio';
import {marked} from 'marked';
import {publicPagePolicy,withPageNofollow} from './article-visibility';
import {AGENTSWIKI_ORIGIN,type AgentsWikiDraft} from './agentswiki';
import type {OpenAgentChatRenderedPage} from './openagentchat';
const normalize=(v:string)=>v.normalize('NFC').replace(/\s+/gu,' ').trim();
export const AGENTSWIKI_BODY_SELECTOR='main[id="site.content"] > article > div.prose';
export function inspectAgentsWikiNativePage(page:OpenAgentChatRenderedPage&{occlusionClear?:boolean},input:{url:string;draft:AgentsWikiDraft;targetUrl:string}):string{
 const {url,draft,targetUrl}=input;let parsed:URL;try{parsed=new URL(url)}catch{throw Error('Agents Wiki 公开地址无效')}
 if(parsed.origin!==AGENTSWIKI_ORIGIN||parsed.search||parsed.hash||parsed.username||parsed.password||!/^\/wiki\/[a-z0-9][a-z0-9-]{0,240}$/.test(parsed.pathname)||page.url!==url||page.responseStatus!==200||page.responseMediaType!=='text/html'||page.responseBodyBytes<=0||page.responseBodyBytes>2*1024*1024||page.responseEncodedBodyBytes>2*1024*1024||page.hasRefresh||page.hasLoginGate||page.hasPasswordGate||page.occlusionClear!==true||page.candidates.length!==1||page.headings.length!==1||!page.headings[0].visible||normalize(page.headings[0].text)!==draft.title||page.canonicals.length!==1||page.canonicals[0]!==url)throw Error('Agents Wiki 公开页或可见性证据不完整');
 const c=page.candidates[0],expected=load(marked.parse(draft.body,{async:false}));
 if(c.selector!==AGENTSWIKI_BODY_SELECTOR||!c.allTextVisible||normalize(c.text)!==normalize(expected('body').text()))throw Error('Agents Wiki 原稿正文不可完整检查');
 const $=load(c.html),main=$('main[id="site.content"]'),article=main.children('article'),body=article.children('div.prose'),title=article.children('h1'),summary=article.children('p.summary');
 if(main.length!==1||article.length!==1||body.length!==1||title.length!==1||summary.length!==1||article.attr('lang')!==draft.language||normalize(title.text())!==draft.title||normalize(summary.text())!==draft.summary||normalize(body.text())!==normalize(expected('body').text())||body.find('form,script,iframe,article,.comments,[data-comment-id]').length)throw Error('Agents Wiki 正文位置、标题或摘要不匹配');
 const policy=publicPagePolicy($,url,page.responseRobots.join('\n'));if(!policy.valid)throw Error('Agents Wiki 页面抓取策略不合格');
 const links=expected('a[href]').toArray().map(n=>({href:expected(n).attr('href')!,text:normalize(expected(n).text())})),actual=body.find('a[href]').toArray().map(n=>({href:new URL($(n).attr('href')!,url).href,text:normalize($(n).text())}));
 if(JSON.stringify(actual)!==JSON.stringify(links)||c.links.length!==links.length||c.links.some((l,i)=>!l.visible||l.href!==links[i].href||normalize(l.text)!==links[i].text))throw Error('Agents Wiki 正文链接与审核稿不匹配');
 const targets=c.links.filter(l=>l.href===targetUrl);if(targets.length!==1)throw Error('Agents Wiki 目标来源链接不唯一');
 const mains=page.nativeRequests.filter(r=>r.resourceType==='mainFrame');if(mains.length!==1||mains[0].url!==url||page.nativeRequests.some(r=>r.method!=='GET'||new URL(r.url).origin!==AGENTSWIKI_ORIGIN)||page.nativeRequests.filter(r=>r.resourceType==='stylesheet').length>8)throw Error('Agents Wiki 原生请求范围不合格');
 for(const value of page.responseLinks)for(const item of value.split(','))if(/\brel\s*=\s*["']?canonical\b/i.test(item)&&!item.trim().startsWith('<'+url+'>'))throw Error('Agents Wiki 服务器标注的规范网址不一致');
 return withPageNofollow(targets[0].rel.join(' '),policy.nofollow);
}
