import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {build} from 'esbuild';

const require=createRequire(import.meta.url),root=process.cwd(),dir=mkdtempSync(path.join(tmpdir(),'linkflow-agentboard-native-'));
const helperSha256=createHash('sha256').update(readFileSync(path.join(root,'src/main/native-readability.ts'))).digest('hex');
const contents=`
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {app,BrowserWindow,session} from 'electron';
import {marked} from 'marked';
import {renderAgentboardPage} from ${JSON.stringify(path.join(root,'src/main/agentboard-renderer.ts'))};
import {requireReadableText} from ${JSON.stringify(path.join(root,'src/main/native-readability.ts'))};
import {inspectAgentboardNativePublication} from ${JSON.stringify(path.join(root,'src/integrations/agentboard-public.ts'))};
import {AGENTBOARD_ORIGIN,agentboardAgentUrl,agentboardFirstRequest,agentboardThreadApi,agentboardThreadUrl} from ${JSON.stringify(path.join(root,'src/integrations/agentboard.ts'))};
import {AGENTBOARD_NATIVE_STYLESHEET_URLS} from ${JSON.stringify(path.join(root,'src/integrations/agentboard-native-policy.ts'))};

const target='https://synthetic.example.org/guide',threadId='thr_1111111111111111',agentId='agt_2222222222222222',boardId='brd_3333333333333333',handle='synthetic-fixture';
const url=agentboardThreadUrl(threadId),forbiddenActionUrl=AGENTBOARD_ORIGIN+'/api/threads?publish=SYNTHETIC_NEVER_SENT';
const draft={agent:{name:'Synthetic Fixture Project',description:'A maintained synthetic developer tool used only by the native release fixture.',homepage:target,operatorName:'Synthetic human operator'},board:'introductions' as const,title:'Synthetic bounded recovery discussion',body:'This synthetic discussion keeps publication evidence separate from later observation. Read the [synthetic recovery guide]('+target+') before reconciling an interrupted request. Never repeat a write whose result is unknown.'};
const requestKey='agentboard_synthetic_native_fixture_v1',expectedSourceHash='__SOURCE_HASH__';
const agent={id:agentId,handle,name:draft.agent.name,description:draft.agent.description,homepage:draft.agent.homepage,operatorName:draft.agent.operatorName,publicUrl:agentboardAgentUrl(handle)};
const thread={id:threadId,boardId,agentId,title:draft.title,body:draft.body,createdAt:'2026-10-18T00:00:00.000Z',publicUrl:url,apiUrl:agentboardThreadApi(threadId)};
const spec={credential:'agb_'+ 'a'.repeat(64),agent,thread,board:'introductions',title:draft.title,body:draft.body,targetUrl:target};
const baseCss='html,body{margin:0;background:rgb(255,255,255);color:rgb(25,25,25);font:16px/1.55 Arial,sans-serif}main{max-width:760px;margin:32px auto;padding:0 24px}.meta{margin:20px 0}.thread-body{margin-top:24px;padding-bottom:48px}.status{pointer-events:auto}.status::before{content:"";display:inline-block;width:7px;height:7px;vertical-align:0px;margin:0 6px 0 0;background:rgb(37,145,82)}';
const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const renderedBody=String(marked.parse(draft.body,{async:false,gfm:true})).replace('<a href="'+target+'"','<a rel="ugc nofollow noopener" href="'+target+'"');
const html=(options:{forbiddenAction?:boolean}={})=>'<!doctype html><html><head><meta charset="utf-8"><title>'+escape(draft.title)+' · AgentBoard</title><link rel="canonical" href="'+url+'">'+AGENTBOARD_NATIVE_STYLESHEET_URLS.map(value=>'<link rel="stylesheet" href="'+value+'">').join('')+(options.forbiddenAction?'<link rel="stylesheet" href="'+forbiddenActionUrl+'">':'')+'</head><body><main id="main-content"><p class="meta board-crumb"><a href="/b/introductions">Introductions</a></p><h1>'+escape(draft.title)+'</h1><p class="meta author-meta">by <a href="/a/'+handle+'">'+handle+'</a> · <span class="status">Active</span></p><div class="thread-body card">'+renderedBody+'</div></main></body></html>';
const paintHtml=(kind:'vertical'|'scale'|'zoom',paint:'transparent'|'white')=>{const geometry=kind==='vertical'?'#required{top:254.25px}#owner-wrap{left:100px;top:220px;font:32px/32px Arial}.status::before{width:64px;height:7px;vertical-align:-16px}':kind==='scale'?'#required{top:302px}#owner-wrap{left:100px;top:300px;font:1px/1px Arial;transform-origin:0 0;transform:scale(20)}.status::before{width:7px;height:7px;vertical-align:0px}':'#required{top:302px}#owner-wrap{left:5px;top:15px;font:1px/1px Arial;zoom:20}.status::before{width:7px;height:7px;vertical-align:0px}';return '<!doctype html><html><head><style>html,body{margin:0;background:white;color:black;font:16px Arial}#required{position:absolute;left:100px;font:10px Arial;line-height:12px;width:600px}#owner-wrap{position:absolute;pointer-events:none}.status{pointer-events:auto}.status::before{content:"";display:inline-block;background:'+paint+'}'+geometry+'</style></head><body><article id="required">This required sentence has a hidden beginning and a visible end.</article><div id="owner-wrap"><span class="status">Active</span></div></body></html>'};
const physicalRequests:string[]=[];
const fixture=(body:string)=>({responses:{[url]:{body,headers:{'content-type':'text/html','content-length':String(Buffer.byteLength(body))}},...Object.fromEntries(AGENTBOARD_NATIVE_STYLESHEET_URLS.map(value=>[value,{body:baseCss,headers:{'content-type':'text/css','content-length':String(Buffer.byteLength(baseCss))}}])),[forbiddenActionUrl]:{body:'/* synthetic action route must never dispatch */',headers:{'content-type':'text/css'}}},onRequest:(requestUrl:string)=>physicalRequests.push(requestUrl)});
const render=(body:string,hooks={})=>renderAgentboardPage(url,new AbortController().signal,hooks,fixture(body));
const inspect=(page:Awaited<ReturnType<typeof renderAgentboardPage>>)=>inspectAgentboardNativePublication(page,spec);
const directReadable=async(name:string,body:string)=>{const directUrl='https://fixture.invalid/agentboard-native-smoke/'+name,part=session.fromPartition('agentboard-native-smoke-'+name);let protocolRequests=0,blockedRequests=0;part.webRequest.onBeforeRequest((request,callback)=>{if(request.url!==directUrl)blockedRequests++;callback({cancel:request.url!==directUrl})});await part.protocol.handle('https',request=>{protocolRequests++;return request.url===directUrl?new Response(body,{headers:{'content-type':'text/html','content-length':String(Buffer.byteLength(body))}}):new Response('',{status:403})});const win=new BrowserWindow({show:false,width:900,height:600,webPreferences:{session:part,javascript:false,sandbox:true,nodeIntegration:false,contextIsolation:true,images:false}});let accepted=false,error='';try{await win.loadURL(directUrl);win.webContents.debugger.attach('1.3');const value=await win.webContents.debugger.sendCommand('Runtime.evaluate',{expression:'(()=>{try{return {accepted:true,count:('+requireReadableText.toString()+')(document.querySelector("#required"))}}catch(error){return {accepted:false,error:error instanceof Error?error.message:"unknown"}}})()',returnByValue:true});accepted=value.result.value.accepted;error=value.result.value.error??''}finally{try{win.webContents.debugger.detach()}catch{}if(!win.isDestroyed())win.destroy();try{part.protocol.unhandle('https')}catch{}await part.clearStorageData().catch(()=>undefined)}return {name,accepted,error,protocolRequests,blockedRequests,externalRequests:0}};
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{try{
  let checks=0;
  assert.equal(agentboardFirstRequest(draft,target,requestKey).sourceHash,expectedSourceHash);checks++;
  const positiveStart=physicalRequests.length,positive=await render(html());assert.equal(inspect(positive),'ugc nofollow noopener');assert.deepEqual(positive.nativeRequests.map(value=>[value.method,value.resourceType,value.url]),[['GET','mainFrame',url],...AGENTBOARD_NATIVE_STYLESHEET_URLS.map(value=>['GET','stylesheet',value])]);assert.deepEqual(new Set(physicalRequests.slice(positiveStart)),new Set([url,...AGENTBOARD_NATIVE_STYLESHEET_URLS]));checks++;
  const directResults=[];for(const kind of ['vertical','scale','zoom'] as const)for(const paint of ['transparent','white'] as const){const item=await directReadable(kind+'-'+paint,paintHtml(kind,paint));const expected=paint==='transparent';directResults.push({...item,expected,matched:item.accepted===expected});checks++}
  assert.ok(directResults.every(value=>value.matched),'AgentBoard paint regression changed: '+JSON.stringify(directResults.filter(value=>!value.matched)));assert.ok(directResults.every(value=>value.protocolRequests===1&&value.blockedRequests===0&&value.externalRequests===0));
  let acceptedForbidden=0;const beforeForbidden=physicalRequests.filter(value=>value===forbiddenActionUrl).length;await assert.rejects(()=>render(html({forbiddenAction:true}),{onBeforeRequest:(request:{url:string})=>{if(request.url===forbiddenActionUrl)acceptedForbidden++}}));const forbiddenActionProtocolDispatches=physicalRequests.filter(value=>value===forbiddenActionUrl).length-beforeForbidden;assert.equal(acceptedForbidden,0);assert.equal(forbiddenActionProtocolDispatches,0);checks++;
  const result={passed:true,checks,directResults,externalRequests:0,externalWrites:0,forbiddenActionAcceptedRequests:acceptedForbidden,forbiddenActionProtocolDispatches,fixtureProtocolRequests:physicalRequests.length+directResults.reduce((sum,value)=>sum+value.protocolRequests,0),platform:process.platform,windowsNative:process.platform==='win32',fixtureContract:'synthetic-agentboard-native-v2',sourceHash:expectedSourceHash,helperSha256:${JSON.stringify(helperSha256)}};
  writeFileSync(${JSON.stringify(path.join(dir,'result.json'))},JSON.stringify(result));console.log(JSON.stringify(result));app.exit(0);
}catch(error){console.error(error);app.exit(1)}});
`;
const sourceHash='f68c0e5c0da1dabeeefebbd2769228746e3411f1b8380f7d78684978e4bd285b',bundledContents=contents.replace('__SOURCE_HASH__',sourceHash);
try{
  await build({stdin:{contents:bundledContents,resolveDir:root,sourcefile:'agentboard-native-fixture.ts',loader:'ts'},outfile:path.join(dir,'entry.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node22'});
  const child=spawn(require('electron'),[path.join(dir,'entry.cjs'),'--user-data-dir='+path.join(dir,'profile')],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
  let expired=false;const timer=setTimeout(()=>{expired=true;child.kill()},60000),code=await new Promise(resolve=>child.once('exit',resolve));clearTimeout(timer);
  if(!expired&&code===0){const result=JSON.parse(readFileSync(path.join(dir,'result.json'),'utf8'));if(result.passed!==true||result.checks!==9||result.directResults?.length!==6||!result.directResults.every(value=>value.matched)||result.externalRequests!==0||result.externalWrites!==0||result.forbiddenActionAcceptedRequests!==0||result.forbiddenActionProtocolDispatches!==0||result.sourceHash!==sourceHash||result.helperSha256!==helperSha256)throw Error('AgentBoard native assertions did not complete')}
  process.exitCode=expired?1:code??1;
}finally{rmSync(dir,{recursive:true,force:true})}
