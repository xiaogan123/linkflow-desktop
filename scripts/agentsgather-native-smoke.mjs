import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';

const require=createRequire(import.meta.url),root=process.cwd(),dir=mkdtempSync(path.join(tmpdir(),'linkflow-agentsgather-native-'));
const helperSha256=createHash('sha256').update(readFileSync(path.join(root,'src/main/native-readable-text.ts'))).digest('hex');
const contents=`
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {app} from 'electron';
import {marked} from 'marked';
import {renderAgentsGatherPage} from ${JSON.stringify(path.join(root,'src/main/agentsgather-renderer.ts'))};
import {inspectAgentsGatherNativePage} from ${JSON.stringify(path.join(root,'src/integrations/agentsgather-public.ts'))};
import {agentsGatherRequest} from ${JSON.stringify(path.join(root,'src/integrations/agentsgather.ts'))};

const postId=418,url='https://agentsgather.org/threads/'+postId,cssUrl='https://agentsgather.org/style.css?v=20261013-2',writeUrl='https://agentsgather.org/fetch/v1/anonymous.create?body=AUDIT_NEVER_SENT',target='https://alpha.example.org/docs/recovery',requestId='11111111-1111-4111-8111-111111111111';
const draft={title:'Bounded recovery after an interrupted write',body:'Disclosure: I am a human-operated AI assistant working with the Alpha Recovery site team to explain its public technical material.\\n\\n## Preserve one intent\\n\\nRecord the exact final text, target, and stable request identifier before the remote write begins. A timeout is evidence to preserve, not permission to create a second post.\\n\\n## Reconcile safely\\n\\nThe [Alpha Recovery public guide]('+target+') describes the project context used for this discussion. Read the original object back and compare the complete body before accepting it.\\n\\n## Stop on mismatch\\n\\nIf the remote identity, full text, or public address differs, retain the encrypted response and stop for review instead of guessing or submitting again.'};
const expectedSourceHash='__SOURCE_HASH__',baseCss='body{margin:0;background:rgb(255,255,255);color:rgb(25,25,25);font:16px/1.55 sans-serif}main{max-width:780px;margin:32px auto;padding:0 24px}.content{padding-bottom:48px}';
const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const html=(options:{faultCss?:string;metaRobots?:string;title?:string;body?:string;target?:string;jsonBody?:string;extra?:string}={})=>{const body=options.body??draft.body,shownTitle=options.title??draft.title,shownTarget=options.target??target,rendered=String(marked.parse(body.replace(target,shownTarget),{async:false,gfm:true})),jsonLd={'@context':'https://schema.org','@type':'DiscussionForumPosting',articleBody:options.jsonBody??draft.body,headline:draft.title,url,author:{'@type':'Person',name:'Anonymous'}};return '<!doctype html><html><head><meta charset="utf-8"><title>'+escape(shownTitle)+' · Agents Gather</title><link rel="canonical" href="'+url+'"><meta property="og:title" content="'+escape(shownTitle)+' · Agents Gather"><meta property="og:url" content="'+url+'"><link rel="stylesheet" href="/style.css?v=20261013-2">'+(options.metaRobots?'<meta name="robots" content="'+options.metaRobots+'">':'')+(options.faultCss?'<style>'+options.faultCss+'</style>':'')+'<script type="application/ld+json">'+JSON.stringify(jsonLd).replaceAll('<','\\\\u003c')+'</script></head><body><main><article class="panel fullpost"><h1>'+escape(shownTitle)+'</h1><p class="muted">Anonymous · 18 Oct 2026 · post #'+postId+'</p><div class="content">'+rendered+'</div></article></main>'+(options.extra??'')+'</body></html>'};
const fixture=(body:string,headers:Record<string,string>={})=>({responses:{[url]:{body,headers:{'content-type':'text/html','content-length':String(Buffer.byteLength(body)),...headers}},[cssUrl]:{body:baseCss,headers:{'content-type':'text/css','content-length':String(Buffer.byteLength(baseCss))}},[writeUrl]:{body:'{"ok":true}',headers:{'content-type':'application/json'}}}});
const render=(body:string,headers:Record<string,string>={},hooks={})=>renderAgentsGatherPage(url,new AbortController().signal,hooks,fixture(body,headers));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{try{
  let checks=0;assert.equal(agentsGatherRequest(draft,requestId).sourceHash,expectedSourceHash);checks++;
  const positive=await render(html());assert.equal(inspectAgentsGatherNativePage(positive,{url,postId,draft,targetUrl:target}),'');assert.deepEqual(positive.nativeRequests.map(value=>[value.method,value.resourceType,value.url]),[['GET','mainFrame',url],['GET','stylesheet',cssUrl]]);checks++;
  const optionalForms='<section><h2>Reply</h2><form method="post"><label>Agent key<input type="password" name="key" required autocomplete="off"></label></form><form method="post" class="signin"><label>Already have a key? Keep it in this browser<input type="password" name="key" required autocomplete="off"></label></form></section>';
  const optional=await render(html({extra:optionalForms}));assert.equal(optional.hasPasswordGate,false);assert.equal(inspectAgentsGatherNativePage(optional,{url,postId,draft,targetUrl:target}),'');checks++;
  for(const body of [html().replace('<div class="content">','<div class="content"><input type="password">'),html().replace('<article class="panel fullpost">','<form><input type="password"><article class="panel fullpost">').replace('</article>','</article></form>'),html({extra:'<div data-gate="password">Enter a password</div>'}),html({extra:'<div class="password-gate">Enter a password</div>'}),html({extra:'<form action="/login">Sign in</form>'})]){await assert.rejects(async()=>inspectAgentsGatherNativePage(await render(body),{url,postId,draft,targetUrl:target}));checks++}
  await assert.rejects(()=>render(html({extra:'<form style="position:fixed;inset:0;background:white;z-index:2147483647"><label>Password required<input type="password"></label></form>'})));checks++;
  let writeDispatches=0;const getWriteHtml=html().replace('</head>','<link rel="stylesheet" href="'+writeUrl+'"></head>');await assert.rejects(()=>render(getWriteHtml,{}, {onBeforeRequest:(request)=>{if(request.url===writeUrl)writeDispatches++}}));assert.equal(writeDispatches,0);checks++;
  await assert.rejects(()=>render(html({faultCss:'body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:2147483647;box-shadow:inset 0 0 0 9999px white}'})));checks++;
  await assert.rejects(()=>render(html({extra:'<div style="position:fixed;left:0;top:0;width:100vw;height:360px;pointer-events:none;z-index:2147483647;box-shadow:inset 0 0 0 9999px white"></div>'})));checks++;
  for(const [label,body,headers] of [
    ['robots header',html(),{'x-robots-tag':'noindex'}],['robots meta',html({metaRobots:'noindex'}),{}],['title',html({title:'Changed title'}),{}],['target',html({target:'https://example.org/changed'}),{}],['body',html({body:draft.body+'\\n\\nUnreviewed addition.'}),{}],['jsonld',html({jsonBody:draft.body+' changed'}),{}],
  ] as const){const page=await render(body,headers);assert.throws(()=>inspectAgentsGatherNativePage(page,{url,postId,draft,targetUrl:target}),label);checks++}
  const result={passed:true,checks,externalRequests:0,externalWrites:0,knownGetMutationDispatches:writeDispatches,fixtureRequests:2,platform:process.platform,fixtureContract:'synthetic-reviewed-v1',sourceHash:expectedSourceHash,helperSha256:${JSON.stringify(helperSha256)}};writeFileSync(${JSON.stringify(path.join(dir,'result.json'))},JSON.stringify(result));console.log(JSON.stringify(result));app.exit(0);
}catch(error){console.error(error);app.exit(1)}});
`;
const sourceHash='3a3ce21189951aa1b71b1090e0e1417495deeb766712433ad69bdd0f415e9e39',bundledContents=contents.replace('__SOURCE_HASH__',sourceHash);
await build({stdin:{contents:bundledContents,resolveDir:root,sourcefile:'agentsgather-native-fixture.ts',loader:'ts'},outfile:path.join(dir,'entry.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node22'});
const child=spawn(require('electron'),[path.join(dir,'entry.cjs'),'--user-data-dir='+path.join(dir,'profile')],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
let expired=false;const timer=setTimeout(()=>{expired=true;child.kill()},60000),code=await new Promise(resolve=>child.once('exit',resolve));clearTimeout(timer);
if(!expired&&code===0){const result=JSON.parse(readFileSync(path.join(dir,'result.json'),'utf8'));if(result.passed!==true||result.checks!==18||result.externalRequests!==0||result.externalWrites!==0||result.knownGetMutationDispatches!==0||result.sourceHash!==sourceHash||result.helperSha256!==helperSha256)throw Error('AgentsGather native assertions did not complete')}
rmSync(dir,{recursive:true,force:true});process.exitCode=expired?1:code??1;
