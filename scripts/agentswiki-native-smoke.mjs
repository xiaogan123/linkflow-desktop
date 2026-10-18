import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {build} from 'esbuild';

const require=createRequire(import.meta.url),root=process.cwd(),dir=mkdtempSync(path.join(tmpdir(),'linkflow-agentswiki-native-'));
const contents=`
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {app} from 'electron';
import {marked} from 'marked';
import {renderAgentsWikiPage} from ${JSON.stringify(path.join(root,'src/main/agentswiki-renderer.ts'))};
import {inspectAgentsWikiNativePage} from ${JSON.stringify(path.join(root,'src/integrations/agentswiki-public.ts'))};
import {agentsWikiDraftRequest,agentsWikiHash} from ${JSON.stringify(path.join(root,'src/integrations/agentswiki.ts'))};

const url='https://agents-wiki.com/wiki/opaque-response-journal',cssUrl='https://agents-wiki.com/static/style.css?v=42b735a8c1';
const target='https://alpha.example.org/docs/recovery';
const draft={title:'Bounded Recovery for Interrupted Writes',summary:'A neutral method for preserving evidence and avoiding duplicate remote writes.',language:'en',type:'article' as const,tags:[],body:'## Preserve the intent\\n\\nRecord the account, request hash, and exact content before a remote write.\\n\\n## Reconcile safely\\n\\nUse the [public recovery guide]('+target+') to compare the saved identity and current remote state. Never repeat a write whose outcome is unknown.\\n\\n## Stop on mismatch\\n\\nIf ownership, content, or revision differs, preserve the evidence and request review.',sources:[{title:'Public recovery guide',url:target,attribution:'Primary public page cited by this contribution.'}],basis:'Original contribution based on the cited public source and limited to its recoverable workflow.',attribution:['Prepared with AI assistance for an isolated native fixture. Original prose is offered under CC BY 4.0; the cited source retains its own terms.'],change_notice:'Changes require a new review and fixture revision.',related:[],applies_to:['Alpha Recovery'],content_as_of:'2026-10-17T00:00:00.000Z'};
const expectedBodySha256='b9dafb631c41eecc0eec6bab0dbbd60408fef59b46b9be4c7f5b81f868d8b0bc',expectedDraftSha256='e6f16deca6ee1db24c50748c53cc82b21dc864d34bc4d2ab9279411426afe84f';
const baseCss='body{margin:0;background:rgb(255,255,255);color:rgb(25,25,25);font:16px/1.55 sans-serif}main{max-width:760px;margin:32px auto;padding:0 24px}.summary{font-size:18px}.prose{padding-bottom:40px}';
const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const html=(options:{faultCss?:string;metaRobots?:string;title?:string;summary?:string;bodyHtml?:string;extra?:string}={})=>'<!doctype html><html><head><title>'+escape(options.title??draft.title)+'</title><link rel="canonical" href="'+url+'"><link rel="stylesheet" href="/static/style.css?v=42b735a8c1">'+(options.metaRobots?'<meta name="robots" content="'+options.metaRobots+'">':'')+(options.faultCss?'<style>'+options.faultCss+'</style>':'')+'</head><body><main id="site.content"><article lang="en"><h1>'+escape(options.title??draft.title)+'</h1><p class="summary">'+escape(options.summary??draft.summary)+'</p><div class="prose">'+(options.bodyHtml??marked.parse(draft.body,{async:false}))+'</div></article></main>'+(options.extra??'')+'</body></html>';
const fixture=(body:string,headers:Record<string,string>={})=>({responses:{[url]:{body,headers:{'content-type':'text/html',...headers}},[cssUrl]:{body:baseCss,headers:{'content-type':'text/css'}}}});
const render=(body:string,headers:Record<string,string>={})=>renderAgentsWikiPage(url,new AbortController().signal,{},fixture(body,headers));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{try{
  let checks=0;
  assert.equal(agentsWikiHash(draft.body),expectedBodySha256);checks++;
  assert.equal(agentsWikiDraftRequest(draft,target).sourceHash,expectedDraftSha256);checks++;
  const positive=await render(html());
  assert.equal(inspectAgentsWikiNativePage(positive,{url,draft,targetUrl:target}),'');
  assert.deepEqual(positive.nativeRequests.map(value=>[value.method,value.resourceType,value.url]),[['GET','mainFrame',url],['GET','stylesheet',cssUrl]]);checks++;
  await assert.rejects(()=>render(html({faultCss:'body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:2147483647;box-shadow:inset 0 0 0 9999px white}'})));checks++;
  await assert.rejects(()=>render(html({extra:'<div style="position:fixed;left:0;top:0;width:100vw;height:360px;pointer-events:none;z-index:2147483647;box-shadow:inset 0 0 0 9999px white"></div>'})));checks++;
  for(const [label,body,headers] of [
    ['robots header',html(),{'x-robots-tag':'noindex'}],
    ['robots meta',html({metaRobots:'noindex'}),{}],
    ['title',html({title:'Changed title'}),{}],
    ['summary',html({summary:'Changed summary that no longer matches the reviewed article.'}),{}],
    ['target',html({bodyHtml:marked.parse(draft.body.replace(target,'https://example.org/changed-target'),{async:false})}),{}],
    ['body',html({bodyHtml:marked.parse(draft.body+'\\nUnreviewed addition.\\n',{async:false})}),{}],
  ] as const){const page=await render(body,headers);assert.throws(()=>inspectAgentsWikiNativePage(page,{url,draft,targetUrl:target}),label);checks++}
  const opaque='position:fixed;inset:0;background:white;z-index:2147483647;pointer-events:none';
  await render(html({extra:'<details><summary>Contents</summary><a style="'+opaque+'">Collapsed link</a></details>'}));checks++;
  for(const visibility of ['visible']){await assert.rejects(()=>render(html({faultCss:'details::details-content{content-visibility:'+visibility+' !important}',extra:'<details><summary>Contents</summary><a style="'+opaque+'">Forced visible overlay</a></details>'})), 'Forced '+visibility+' details overlay');checks++}
  await assert.rejects(()=>render(html({faultCss:'details::details-content{content-visibility:visible !important;display:contents !important}',extra:'<details><summary>Contents</summary><div style="'+opaque+'">Visible display-contents overlay</div></details>'})));checks++;
  await assert.rejects(()=>render(html({faultCss:'details::details-content{content-visibility:visible !important;display:block !important}',extra:'<details><summary>Contents</summary><div style="'+opaque+'">Visible overlay</div></details>'})));checks++;
  await assert.rejects(()=>render(html({extra:'<details open><summary>Contents</summary><a style="'+opaque+'">Visible overlay</a></details>'})));checks++;
  await assert.rejects(()=>render(html({extra:'<details><summary style="'+opaque+'">Visible summary overlay</summary><p>Hidden content</p></details>'})));checks++;
  await render(html({extra:'<details><summary>Contents</summary><summary style="'+opaque+'">Hidden second summary</summary></details>'}));checks++;
  await render(html({extra:'<details><summary>Outer</summary><details open><summary style="'+opaque+'">Hidden nested summary</summary></details></details>'}));checks++;
  await assert.rejects(()=>render(html().replace('<div class="prose">','<details><summary>Hidden article</summary><div class="prose">').replace('</div></article>','</div></details></article>')));checks++;
  let apiDispatches=0;await assert.rejects(()=>renderAgentsWikiPage(url,new AbortController().signal,{onBeforeRequest(r){if(r.url.includes('/api/'))apiDispatches++}},fixture(html().replace('/static/style.css?v=42b735a8c1','/api/v1/meta'))));assert.equal(apiDispatches,0);checks++;
  const result={passed:true,checks,externalRequests:0,externalWrites:0,fixtureRequests:2,platform:process.platform,windowsNative:process.platform==='win32',fixtureContract:'synthetic-reviewed-v2',draftSha256:agentsWikiHash(JSON.stringify(draft)),bodySha256:agentsWikiHash(draft.body)};
  writeFileSync(${JSON.stringify(path.join(dir,'result.json'))},JSON.stringify(result));console.log(JSON.stringify(result));app.exit(0);
}catch(error){console.error(error);app.exit(1)}});
`;
await build({stdin:{contents,resolveDir:root,sourcefile:'agentswiki-native-fixture.ts',loader:'ts'},outfile:path.join(dir,'entry.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node22'});
const child=spawn(require('electron'),[path.join(dir,'entry.cjs'),'--user-data-dir='+path.join(dir,'profile')],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
let expired=false;const timer=setTimeout(()=>{expired=true;child.kill()},60000);const code=await new Promise(resolve=>child.once('exit',resolve));clearTimeout(timer);
if(!expired&&code===0){const result=JSON.parse(readFileSync(path.join(dir,'result.json'),'utf8'));if(result.passed!==true||result.checks!==21||result.externalRequests!==0||result.externalWrites!==0)throw Error('Agents Wiki native assertions did not complete')}
rmSync(dir,{recursive:true,force:true});process.exitCode=expired?1:code??1;
