import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {build} from 'esbuild';

const require=createRequire(import.meta.url),root=process.cwd(),dir=mkdtempSync(path.join(tmpdir(),'linkflow-synthfolk-native-'));
const contents=`
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {app} from 'electron';
import {renderSynthfolkPage} from ${JSON.stringify(path.join(root,'src/main/synthfolk-renderer.ts'))};
import {inspectSynthfolkNativeProfile} from ${JSON.stringify(path.join(root,'src/integrations/synthfolk-public.ts'))};
import {synthfolkRegistrationRequest} from ${JSON.stringify(path.join(root,'src/integrations/synthfolk.ts'))};

const url='https://synthfolk.ai/agents/alpha-recovery-native',cssUrl='https://synthfolk.ai/_next/static/immutable/chunks/fixture123.css',target='https://alpha.example.org/docs/recovery';
const draft={handle:'alpha-recovery-native',name:'Alpha Recovery Assistant',headline:'Human-controlled assistant for bounded recovery documentation',about:'This AI assistant is controlled by a human. Its Website field points to Alpha Recovery, and this profile documents a bounded recovery workflow without claiming ownership, employment, client work, endorsement, ranking, or independent third-party status.',operator:'Human operator',website:target,availability:'closed' as const,skills:['Software','Documentation']};
const expectedSourceHash='__SOURCE_HASH__';
const baseCss='body{margin:0;background:rgb(255,255,255);color:rgb(25,25,25);font:16px/1.55 sans-serif}main{max-width:760px;margin:32px auto;padding:0 24px}section{padding:8px 0}';
const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
type Field='identity'|'heading'|'operator'|'about'|'skills'|'website';
const html=(options:{faultCss?:string;name?:string;handle?:string;headline?:string;operator?:string;availability?:string;about?:string;website?:string;skills?:string[];metaRobots?:string;mainExtra?:string;bodyExtra?:string;websiteExtra?:string;aboutExtra?:string;stylesheet?:string;attrs?:Partial<Record<Field,string>>}={})=>{
  const attrs=options.attrs??{},name=options.name??draft.name,skills=options.skills??draft.skills,jsonLd=JSON.stringify({'@context':'https://schema.org','@type':'ProfilePage',name});
  return '<!doctype html><html><head><title>'+escape(name)+' | Synthfolk</title><link rel="canonical" href="'+url+'"><link rel="stylesheet" href="'+(options.stylesheet??new URL(cssUrl).pathname)+'">'+(options.metaRobots?'<meta name="robots" content="'+options.metaRobots+'">':'')+(options.faultCss?'<style>'+options.faultCss+'</style>':'')+'</head><body><main><div class="profile-shell"><nav aria-label="Breadcrumb"><a href="/agents">Agents</a><span aria-hidden="true">/</span><span>'+escape(name)+'</span></nav><section data-field="identity"'+(attrs.identity??'')+'><div><h1'+(attrs.heading??'')+'>'+escape(name)+'</h1><span>Agent</span></div><p>@'+escape(options.handle??draft.handle)+'</p><p>'+escape(options.headline??draft.headline)+'</p><div><span>'+escape(options.availability??'Not taking work')+'</span></div><p'+(attrs.operator??'')+'>Works for <span>'+escape(options.operator??draft.operator)+'</span> <span>(self-reported)</span></p></section><a data-field="website" href="'+escape(options.website??draft.website)+'" rel="ugc nofollow noopener"'+(attrs.website??'')+'>Website'+(options.websiteExtra??'')+'</a><section data-field="about"'+(attrs.about??'')+'><h2>About</h2><p>'+escape(options.about??draft.about)+'</p>'+(options.aboutExtra??'')+'</section><section data-field="skills"'+(attrs.skills??'')+'><h2>Skills</h2><ul>'+skills.map(skill=>'<li><a href="/skills/'+escape(skill.toLowerCase())+'">'+escape(skill)+'</a></li>').join('')+'</ul></section><script type="application/ld+json" style="display:none">'+jsonLd+'</script>'+(options.mainExtra??'')+'</div></main>'+(options.bodyExtra??'')+'</body></html>';
};
const fixture=(body:string,headers:Record<string,string>={})=>({responses:{[url]:{body,headers:{'content-type':'text/html',...headers}},[cssUrl]:{body:baseCss,headers:{'content-type':'text/css'}}}});
const render=(body:string,headers:Record<string,string>={})=>renderSynthfolkPage(url,new AbortController().signal,{},fixture(body,headers));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{try{
  let checks=0;
  assert.equal(synthfolkRegistrationRequest(draft,target).sourceHash,expectedSourceHash);checks++;
  const positive=await render(html());assert.equal(inspectSynthfolkNativeProfile(positive,draft),'ugc nofollow noopener');assert.equal(positive.requiredProfileFieldsVisible,true);assert.equal(positive.candidates[0].allTextVisible,false);assert.deepEqual(positive.nativeRequests.map(value=>[value.method,value.resourceType,value.url]),[['GET','mainFrame',url],['GET','stylesheet',cssUrl]]);checks++;
  const cover='<span style="position:absolute;inset:0;background:white;z-index:2"></span>';
  for(const [label,body] of [
    ['stylesheet',html({stylesheet:'/api/v1/me'})],
    ['generated overlay',html({faultCss:'body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:2147483647;box-shadow:inset 0 0 0 9999px white}'})],
    ['painted overlay',html({bodyExtra:'<div style="position:fixed;inset:0;pointer-events:none;z-index:2147483647;box-shadow:inset 0 0 0 9999px white"></div>'})],
    ['about display none',html({attrs:{about:' style="display:none"'}})],
    ['website display none',html({attrs:{website:' style="display:none"'}})],
    ['about aria hidden',html({attrs:{about:' aria-hidden="true"'}})],
    ['website aria hidden',html({attrs:{website:' aria-hidden="true"'}})],
    ['operator transparent',html({attrs:{operator:' style="opacity:0"'}})],
    ['website transparent',html({attrs:{website:' style="opacity:0"'}})],
    ['about occluded',html({attrs:{about:' style="position:relative"'},aboutExtra:cover})],
    ['website occluded',html({attrs:{website:' style="position:relative;display:inline-block"'},websiteExtra:cover})],
    ['duplicate main',html({bodyExtra:'<main><h1>Decoy</h1></main>'})],
    ['duplicate heading',html({mainExtra:'<h1>Decoy</h1>'})],
    ['duplicate about',html({mainExtra:'<section><h2>About</h2><p>Decoy</p></section>'})],
    ['duplicate skills',html({mainExtra:'<section><h2>Skills</h2><ul><li>Decoy</li></ul></section>'})],
  ] as const){await assert.rejects(()=>render(body),undefined,label);checks++}
  for(const [label,body,headers] of [
    ['robots header',html(),{'x-robots-tag':'noindex'}],
    ['robots meta',html({metaRobots:'noindex'}),{}],
    ['name',html({name:'Changed assistant'}),{}],
    ['handle',html({handle:'changed-handle'}),{}],
    ['headline',html({headline:'Changed headline'}),{}],
    ['availability',html({availability:'Taking work'}),{}],
    ['operator',html({operator:'Changed operator'}),{}],
    ['about',html({about:draft.about+' Changed.'}),{}],
    ['website',html({website:'https://example.org/changed'}),{}],
    ['skills',html({skills:['Software','Changed']}),{}],
    ['duplicate website',html({mainExtra:'<a href="'+target+'" rel="ugc nofollow noopener">Website</a>'}),{}],
    ['unbound decoy',html({headline:'Changed headline',mainExtra:'<p>'+escape(draft.headline)+'</p>'}),{}],
  ] as const){const page=await render(body,headers);assert.throws(()=>inspectSynthfolkNativeProfile(page,draft),label);checks++}
  const result={passed:true,checks,externalRequests:0,externalWrites:0,fixtureRequests:2,platform:process.platform,fixtureContract:'synthetic-reviewed-v1',sourceHash:expectedSourceHash};writeFileSync(${JSON.stringify(path.join(dir,'result.json'))},JSON.stringify(result));console.log(JSON.stringify(result));app.exit(0);
}catch(error){console.error(error);app.exit(1)}});
`;
const sourceHash='07a730063cc5163fdb8c82bb7322c3f77c3ef9550c3f1a6449ef376f0e68629b';
const bundledContents=contents.replace('__SOURCE_HASH__',sourceHash);
await build({stdin:{contents:bundledContents,resolveDir:root,sourcefile:'synthfolk-native-fixture.ts',loader:'ts'},outfile:path.join(dir,'entry.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node22'});
const child=spawn(require('electron'),[path.join(dir,'entry.cjs'),'--user-data-dir='+path.join(dir,'profile')],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
let expired=false;const timer=setTimeout(()=>{expired=true;child.kill()},60000),code=await new Promise(resolve=>child.once('exit',resolve));clearTimeout(timer);
if(!expired&&code===0){const result=JSON.parse(readFileSync(path.join(dir,'result.json'),'utf8'));if(result.passed!==true||result.checks!==29||result.externalRequests!==0||result.externalWrites!==0)throw Error('Synthfolk native assertions did not complete')}
rmSync(dir,{recursive:true,force:true});process.exitCode=expired?1:code??1;
