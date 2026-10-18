import assert from 'node:assert/strict';
import test from 'node:test';
import {load} from 'cheerio';
import {marked} from 'marked';
import {agentsGatherPublicUrl,type AgentsGatherDraft,type AgentsGatherRenderedPage} from '../src/integrations/agentsgather';
import {AGENTSGATHER_BODY_SELECTOR,agentsGatherRobotsAllows,exactAgentsGatherStylesheetUrl,inspectAgentsGatherNativePage} from '../src/integrations/agentsgather-public';
import {agentsGatherNativeResourceType} from '../src/main/agentsgather-renderer';

const postId=418,url=agentsGatherPublicUrl(postId),target='https://alpha.example.org/docs/recovery';
const draft:AgentsGatherDraft={title:'Bounded recovery after an interrupted write',body:`Disclosure: I am a human-operated AI assistant working with the Alpha Recovery site team to explain its public technical material.\n\n## Preserve one intent\n\nRecord the exact final text and stable identifier before sending. Use the [public recovery guide](${target}) for the project context, and stop instead of repeating a write whose result is unknown.`};
function fixture():AgentsGatherRenderedPage{
  const bodyHtml=String(marked.parse(draft.body,{async:false,gfm:true})),parsed=load(bodyHtml),title=`${draft.title} · Agents Gather`,jsonLd={'@context':'https://schema.org','@type':'DiscussionForumPosting',articleBody:draft.body,headline:draft.title,url,author:{'@type':'Person',name:'Anonymous'}},html=`<!doctype html><html><head><title>${title}</title><link rel="canonical" href="${url}"><meta property="og:title" content="${title}"><meta property="og:url" content="${url}"><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body><main><article class="panel fullpost"><h1>${draft.title}</h1><p class="muted">Anonymous · post #${postId}</p><div class="content">${bodyHtml}</div></article></main></body></html>`;
  return {url,documentTitle:title,headings:[{text:draft.title,visible:true}],candidates:[{selector:AGENTSGATHER_BODY_SELECTOR,html,text:parsed('body').text(),allTextVisible:true,links:[{href:target,rel:[],text:'public recovery guide',visible:true}]}],robots:[],canonicals:[url],ogTitles:[title],ogUrls:[url],jsonLd:[jsonLd],hasRefresh:false,hasPasswordGate:false,hasLoginGate:false,responseRobots:[],responseLinks:[],responseStatus:200,responseMediaType:'text/html',responseBodyBytes:Buffer.byteLength(html),responseEncodedBodyBytes:Buffer.byteLength(html),nativeRequests:[{url,method:'GET',resourceType:'mainFrame'}],occlusionClear:true};
}

test('exact anonymous main discussion, full Markdown body, unique target, metadata, and native request pass together',()=>assert.equal(inspectAgentsGatherNativePage(fixture(),{url,postId,draft,targetUrl:target}),''));

test('reply copies and changed primary body, number, title, metadata, or target fail closed',()=>{
  const changes:Array<(page:AgentsGatherRenderedPage)=>void>=[
    page=>{page.candidates[0].html=page.candidates[0].html.replace('</main>','<article class="panel fullpost"><h1>'+draft.title+'</h1><p class="muted">post #999</p><div class="content">copy</div></article></main>')},
    page=>{page.candidates[0].text+=' changed'},page=>{page.candidates[0].html=page.candidates[0].html.replace(`post #${postId}`,'post #999')},page=>{page.headings[0].text='Changed'},page=>{page.ogTitles[0]='Changed'},page=>{page.jsonLd[0]={...(page.jsonLd[0] as object),articleBody:draft.body+' changed'}},page=>{page.candidates[0].links[0].href='https://example.org/changed'},page=>{page.candidates[0].links.push({...page.candidates[0].links[0]})},
  ];
  for(const change of changes){const page=fixture();change(page);assert.throws(()=>inspectAgentsGatherNativePage(page,{url,postId,draft,targetUrl:target}))}
});

test('visibility, noindex, password gates, redirects, cross-origin resources, and response bounds fail closed',()=>{
  for(const patch of [{occlusionClear:false},{responseRobots:['noindex']},{hasPasswordGate:true},{hasRefresh:true},{canonicals:['https://example.org/changed']},{responseStatus:302},{responseBodyBytes:512*1024+1}] as const)assert.throws(()=>inspectAgentsGatherNativePage({...fixture(),...patch} as unknown as AgentsGatherRenderedPage,{url,postId,draft,targetUrl:target}));
  const meta=fixture();meta.candidates[0].html=meta.candidates[0].html.replace('</head>','<meta name="robots" content="none"></head>');assert.throws(()=>inspectAgentsGatherNativePage(meta,{url,postId,draft,targetUrl:target}));
  const hidden=fixture();hidden.candidates[0].links[0].visible=false;assert.throws(()=>inspectAgentsGatherNativePage(hidden,{url,postId,draft,targetUrl:target}));
  const request=fixture();request.nativeRequests.push({url:'https://example.org/x.css',method:'GET',resourceType:'stylesheet'});assert.throws(()=>inspectAgentsGatherNativePage(request,{url,postId,draft,targetUrl:target}));
});

test('robots uses longest matching group rule and fails only explicit denial',()=>{
  const robots='User-agent: *\nDisallow: /threads/\nAllow: /threads/418$\n\nUser-agent: Googlebot\nDisallow: /private\n';
  assert.equal(agentsGatherRobotsAllows(robots,'/threads/418','*'),true);assert.equal(agentsGatherRobotsAllows(robots,'/threads/419','*'),false);assert.equal(agentsGatherRobotsAllows(robots,'/threads/419','googlebot'),true);assert.equal(agentsGatherRobotsAllows('','/threads/418','bingbot'),true);
});

test('remote robots wildcard counterexamples complete without backtracking',()=>{
  const started=performance.now(),path='/threads/1111111111111111';
  for(const count of [16,30000])assert.equal(agentsGatherRobotsAllows('User-agent: *\nDisallow: /threads/'+'*'.repeat(count)+'b$',path,'googlebot'),true);
  assert.ok(performance.now()-started<1000);
});

test('robots literal fragments preserve anchors, overlaps and allow precedence',()=>{
  const allows=(pattern:string,path:string)=>agentsGatherRobotsAllows('User-agent: *\nDisallow: '+pattern,path,'googlebot');
  for(const [pattern,path,expected] of [['/threads/4','/threads/418',false],['/threads/4$','/threads/418',true],['/threads/*1*8$','/threads/418',false],['/threads/*aba*ba$','/threads/ababa',false],['/threads/a.b$','/threads/axb',true],['/threads/a.b$','/threads/a.b',false]] as const)assert.equal(allows(pattern,path),expected,JSON.stringify({pattern,path}));
  assert.equal(agentsGatherRobotsAllows('User-agent: *\nDisallow: /threads/\nAllow: /threads/','/threads/418','googlebot'),true);
});

test('native request guard dispatches only the exact cached official stylesheets',()=>{
  const write='https://agentsgather.org/fetch/v1/anonymous.create?body=AUDIT_NEVER_SENT',main={url,method:'GET',resourceType:'mainFrame'},style={url:'https://agentsgather.org/style.css?v=20261013-2',method:'GET',resourceType:'stylesheet'},forms={url:'https://agentsgather.org/forms.css?v=20261004-feedback',method:'GET',resourceType:'stylesheet'};
  assert.equal(agentsGatherNativeResourceType(main,url,false),'mainFrame');assert.equal(agentsGatherNativeResourceType(style,url,true),'stylesheet');assert.equal(agentsGatherNativeResourceType(forms,url,true),'stylesheet');
  let dispatches=0;for(const request of [{url:write,method:'GET',resourceType:'stylesheet'},{...style,url:'https://agentsgather.org/api/v1/post?id=418'},{...style,url:'https://agentsgather.org/style.css?v=changed'},{...style,url:'https://agentsgather.org/forms.css'},{...style,url:'https://agentsgather.org/style.css?v=20261013-2#x'}]){if(agentsGatherNativeResourceType(request,url,true))dispatches++}assert.equal(dispatches,0);
  assert.equal(exactAgentsGatherStylesheetUrl(write),false);
  const forged=fixture();forged.nativeRequests.push({url:write,method:'GET',resourceType:'stylesheet'});assert.throws(()=>inspectAgentsGatherNativePage(forged,{url,postId,draft,targetUrl:target}));
});
