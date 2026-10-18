import {load} from 'cheerio';
import {marked} from 'marked';
import {publicPagePolicy,withPageNofollow} from './article-visibility';
import {AGENTSGATHER_ORIGIN,agentsGatherPublicUrl,type AgentsGatherDraft,type AgentsGatherRenderedPage} from './agentsgather';

export const AGENTSGATHER_BODY_SELECTOR='main > article.panel.fullpost > div.content';
const normalize=(value:string)=>value.normalize('NFC').replace(/\s+/gu,' ').trim();
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

export function exactAgentsGatherPublicUrl(value:string):boolean{
  try{const url=new URL(value);return url.origin===AGENTSGATHER_ORIGIN&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&/^\/threads\/[1-9][0-9]*$/.test(url.pathname)}catch{return false}
}
export function exactAgentsGatherStylesheetUrl(value:string):boolean{
  try{const url=new URL(value);if(url.origin!==AGENTSGATHER_ORIGIN||url.username||url.password||url.hash)return false;return (url.pathname==='/style.css'&&url.search==='?v=20261013-2')||(url.pathname==='/forms.css'&&url.search==='?v=20261004-feedback')}catch{return false}
}

// Robots rules contain literal fragments, '*' wildcards and an optional final '$'.
// Match the fragments directly so remote input never becomes a backtracking regexp.
function robotsPatternMatches(pattern:string,path:string):boolean{
  const anchored=pattern.endsWith('$'),plain=anchored?pattern.slice(0,-1):pattern,parts=plain.split('*');
  if(!path.startsWith(parts[0]))return false;
  if(parts.length===1)return !anchored||path.length===plain.length;
  let position=parts[0].length;
  for(let index=1;index<parts.length;index++){
    const part=parts[index];
    if(anchored&&index===parts.length-1)return path.endsWith(part)&&path.length-part.length>=position;
    if(!part)continue;
    const found=path.indexOf(part,position);if(found<0)return false;position=found+part.length;
  }
  return true;
}

export function agentsGatherRobotsAllows(text:string,path:string,agent:string):boolean{
  if(Buffer.byteLength(text)>256*1024||path.length>2048)return false;
  const groups:Array<{agents:string[];rules:Array<{allow:boolean,path:string}>}>=[];let current:{agents:string[];rules:Array<{allow:boolean;path:string}>}|undefined;
  for(const raw of text.replace(/^\uFEFF/,'').split(/\r?\n/)){const line=raw.replace(/#.*$/,'').trim();if(!line)continue;const index=line.indexOf(':');if(index<0)continue;const name=line.slice(0,index).trim().toLowerCase(),value=line.slice(index+1).trim();if(name==='user-agent'){if(!current||current.rules.length){current={agents:[],rules:[]};groups.push(current)}current.agents.push(value.toLowerCase())}else if((name==='allow'||name==='disallow')&&current?.agents.length)current.rules.push({allow:name==='allow',path:value})}
  const selected=groups.filter(group=>group.agents.includes(agent.toLowerCase()));const applicable=selected.length?selected:groups.filter(group=>group.agents.includes('*'));let winner:{allow:boolean;length:number}|undefined;
  for(const group of applicable)for(const rule of group.rules){if(!rule.path||!robotsPatternMatches(rule.path,path))continue;const length=Buffer.byteLength(rule.path.replace(/\$$/,'').replace(/\*/g,''));if(!winner||length>winner.length||length===winner.length&&rule.allow)winner={allow:rule.allow,length}}
  return winner?.allow??true;
}

export function inspectAgentsGatherNativePage(page:AgentsGatherRenderedPage,input:{url:string;postId:number;draft:AgentsGatherDraft;targetUrl:string}):string{
  const {url,postId,draft,targetUrl}=input;if(!exactAgentsGatherPublicUrl(url)||url!==agentsGatherPublicUrl(postId)||page.url!==url||page.responseStatus!==200||page.responseMediaType!=='text/html'||page.responseBodyBytes<=0||page.responseBodyBytes>512*1024||page.responseEncodedBodyBytes>512*1024||page.hasRefresh||page.hasLoginGate||page.hasPasswordGate||page.occlusionClear!==true||page.candidates.length!==1||page.headings.length!==1||!page.headings[0].visible||normalize(page.headings[0].text)!==draft.title||page.documentTitle!==`${draft.title} · Agents Gather`||page.canonicals.length!==1||page.canonicals[0]!==url||page.ogTitles.length!==1||page.ogTitles[0]!==`${draft.title} · Agents Gather`||page.ogUrls.length!==1||page.ogUrls[0]!==url)throw Error('AgentsGather 公开页身份、标题或可见性证据不完整');
  const candidate=page.candidates[0],expected=load(marked.parse(draft.body,{async:false}));if(candidate.selector!==AGENTSGATHER_BODY_SELECTOR||!candidate.allTextVisible||normalize(candidate.text)!==normalize(expected('body').text()))throw Error('AgentsGather 公开正文与审核稿不一致');
  const $=load(candidate.html),articles=$('main > article.panel.fullpost'),article=articles.first(),headings=article.children('h1'),muted=article.children('p.muted'),bodies=article.children('div.content');if(articles.length!==1||headings.length!==1||muted.length!==1||bodies.length!==1||normalize(headings.text())!==draft.title||!new RegExp(`(?:^|\\s)post #${postId}(?:$|\\s)`).test(normalize(muted.text()))||normalize(bodies.text())!==normalize(expected('body').text())||bodies.find('form,script,iframe,article,.reply,[data-comment-id]').length)throw Error('AgentsGather 主帖容器、编号或全文不匹配');
  const policy=publicPagePolicy($,url,page.responseRobots.join(','));if(!policy.valid)throw Error('AgentsGather 页面抓取策略无效');
  const expectedLinks=expected('a[href]').toArray().map(node=>({href:new URL(expected(node).attr('href')!,url).href,text:normalize(expected(node).text())})),actual=bodies.find('a[href]').toArray().map(node=>({href:new URL($(node).attr('href')!,url).href,text:normalize($(node).text())}));if(JSON.stringify(actual)!==JSON.stringify(expectedLinks)||candidate.links.length!==expectedLinks.length||candidate.links.some((link,index)=>!link.visible||link.href!==expectedLinks[index].href||normalize(link.text)!==expectedLinks[index].text))throw Error('AgentsGather Markdown 链接未逐字保留');
  const targets=candidate.links.filter(link=>link.href===targetUrl);if(targets.length!==1||candidate.links.length!==1)throw Error('AgentsGather 主帖必须仅有一个可见目标链接');
  if(page.jsonLd.length!==1||!record(page.jsonLd[0]))throw Error('AgentsGather JSON-LD 缺失');const ld=page.jsonLd[0];if(ld['@context']!=='https://schema.org'||ld['@type']!=='DiscussionForumPosting'||ld.articleBody!==draft.body||ld.headline!==draft.title||ld.url!==url||!record(ld.author)||ld.author['@type']!=='Person'||ld.author.name!=='Anonymous')throw Error('AgentsGather JSON-LD 未绑定完整匿名主帖');
  const mains=page.nativeRequests.filter(request=>request.resourceType==='mainFrame'),styles=page.nativeRequests.filter(request=>request.resourceType==='stylesheet');if(mains.length!==1||mains[0].url!==url||mains[0].method!=='GET'||styles.length>8||styles.some(request=>request.method!=='GET'||!exactAgentsGatherStylesheetUrl(request.url))||page.nativeRequests.length!==mains.length+styles.length)throw Error('AgentsGather 原生请求范围超限');
  for(const value of page.responseLinks)for(const item of value.split(','))if(/\brel\s*=\s*["']?canonical\b/i.test(item)&&!item.trim().startsWith('<'+url+'>'))throw Error('AgentsGather HTTP canonical 不一致');
  return withPageNofollow(targets[0].rel.join(' '),policy.nofollow);
}
