import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {load} from 'cheerio';
import {assertBatch5ReadablePage,batch5ExtractionSource,batch5PublicChannel,batch5RenderedBodySelectors,ignoredDropDeployResource,ignoredMarkedShareResource,ignoredClawprintResource,ignoredLeafmillResource,ignoredOpenDocsResource,leafmillFontFaceOnly,leafmillFontStylesheet,opendocsFontStylesheet,
  inspectBatch5RenderedBody,type Batch5RenderedBody} from '../src/main/batch5-renderer';

const url='https://hackmd.io/example-note',target='https://example.com/guide';
const markdown='# Example Guide\n\n## Verify the source\n\nRead the [source guide](https://example.com/guide) before publishing.\n\nA "quoted" note -- with an ellipsis... and example.com.\n';
const fixture=readFileSync(join(import.meta.dirname,'fixtures','hackmd-public-page.html'),'utf8');

test('Clawprint ignores only the cancelled analytics script, never navigation or challenge requests',()=>{
  const beacon='https://static.cloudflareinsights.com/beacon.min.js/v'+'a'.repeat(32);
  assert.equal(ignoredClawprintResource(beacon,'script','GET'),true);
  for(const [url,type,method] of [
    [beacon,'mainFrame','GET'],[beacon,'script','POST'],[beacon+'?x=1','script','GET'],
    [beacon.replace('https:','http:'),'script','GET'],[beacon.replace('.com/','.com.evil.example/'),'script','GET'],
    ['https://clawprint.org/cdn-cgi/challenge-platform/','script','GET'],
    ['https://static.cloudflareinsights.com/other.js','script','GET'],
  ])assert.equal(ignoredClawprintResource(url,type,method),false);
});

/** Minimal DOM bridge around Cheerio, enough to run Electron's actual extraction script. */
function extract(html:string,pageUrl=url,channel:'hackmd'|'leafmill'|'clawprint'|'marked-share'|'publishmarkdown'|'dropdeploy'|'mdpage'='hackmd'):Batch5RenderedBody{
  const $=load(html);
  class HTMLElement {
    constructor(readonly node:any,readonly scope:ReturnType<typeof load>=$){}
    get parentElement():HTMLElement|null{return this.node.parent?.type==='tag'?new HTMLElement(this.node.parent,this.scope):null}
    get hidden():boolean{return Object.hasOwn(this.node.attribs??{},'hidden')}
    get outerHTML():string{return this.scope.html(this.node)}
    getBoundingClientRect(){return {width:100,height:100}}
    getAttribute(name:string):string|null{return this.scope(this.node).attr(name)??null}
    setAttribute(name:string,value:string):void{this.scope(this.node).attr(name,value)}
    querySelectorAll(selector:string):HTMLElement[]{return this.scope(this.node).find(selector).toArray().map(node=>new HTMLElement(node,this.scope))}
    cloneNode():HTMLElement{
      const copied=load(this.outerHTML,undefined,false),node=copied.root().children().get(0);
      assert.ok(node);return new HTMLElement(node,copied);
    }
  }
  const wrap=(nodes:unknown[])=>nodes.map(node=>new HTMLElement(node));
  const document={
    querySelectorAll:(selector:string)=>wrap($(selector).toArray()),
    head:{querySelectorAll:(selector:string)=>wrap($('head').find(selector).toArray())},
  };
  const getComputedStyle=(element:HTMLElement)=>{
    const declarations=Object.fromEntries((element.getAttribute('style')??'').split(';').map(part=>part.split(':').map(value=>value.trim())).filter(parts=>parts.length===2));
    const cssHidesArticle=channel==='leafmill'&&((element.node.name==='article'&&/article\s*\{\s*display\s*:\s*none/i.test($('style').text()))
      ||element.getAttribute('class')?.split(/\s+/).includes('body')&&/\.body\s*\{\s*display\s*:\s*none/i.test($('style').text()));
    const cssHidesClawprint=channel==='clawprint'&&element.getAttribute('class')?.split(/\s+/).includes('entry')&&/\.entry\s*\{\s*display\s*:\s*none/i.test($('style').text());
    return {display:cssHidesArticle||cssHidesClawprint?'none':declarations.display??'block',visibility:declarations.visibility??'visible',opacity:declarations.opacity??'1',
      contentVisibility:declarations['content-visibility']??'visible',pointerEvents:declarations['pointer-events']??'auto'};
  };
  return runInNewContext(batch5ExtractionSource(channel),{document,HTMLElement,getComputedStyle,location:{href:pageUrl}},{timeout:1000}) as Batch5RenderedBody;
}

test('Electron extraction source selects the live HackMD body, then accepts punctuation and auto-links',()=>{
  const page=extract(fixture);assertBatch5ReadablePage(page,url);
  assert.match(page.bodyHtml,/data-batch5-article/);
  assert.match(page.bodyHtml,/class="anchor hidden-xs"/);
  assert.equal(inspectBatch5RenderedBody(page,target,'Example Guide',markdown).found,true);
});

test('Electron extraction source treats missing or ambiguous body and same-site canonical variants as unreadable',()=>{
  const $=load(fixture),body=$('.ui-view-area #doc.markdown-body').first();
  body.after(body.clone());
  const ambiguous=extract($.html());assert.equal(ambiguous.bodyHtml,'');
  assert.throws(()=>assertBatch5ReadablePage(ambiguous,url));
  body.remove();$('.ui-view-area #doc.markdown-body').remove();
  const missing=extract($.html());assert.equal(missing.bodyHtml,'');
  assert.throws(()=>assertBatch5ReadablePage(missing,url));
  const changedCanonical=extract(fixture.replace('https://hackmd.io/example-note','https://hackmd.io/other-note'));
  assert.throws(()=>assertBatch5ReadablePage(changedCanonical,url));
  assert.throws(()=>assertBatch5ReadablePage(extract(fixture,'https://hackmd.io/example-note?view'),url));
});

test('HackMD still requires the reviewed target link after ignoring generated auto-links',()=>{
  const $=load(fixture);$('.ui-view-area #doc a[href="https://example.com/guide"]').remove();
  const page=extract($.html());assertBatch5ReadablePage(page,url);
  assert.equal(inspectBatch5RenderedBody(page,target,'Example Guide',markdown).found,false);
});

test('Leafmill renderer accepts only the unique computed-visible body from its observed public layout',()=>{
  const leafUrl='https://leafmill.net/useful-guide-1234';
  const body=`## Verify the source\n\nRead the [source guide](${target}) before publishing.`;
  // Sanitized DOM shape from the real public page: header and footer are outside .container > .body.
  const article=`<div class="body"><h2>Verify the source</h2><p>Read the <a rel="nofollow ugc" href="${target}">source guide</a> before publishing.</p></div>`;
  const html=`<!doctype html><html><head><style>.body { color: inherit }</style></head><body><div class="header"><a href="${target}">chrome</a></div><div class="container">${article}<div class="footer"><a href="${target}">footer</a></div></div></body></html>`;
  assert.equal(batch5PublicChannel(leafUrl),'leafmill');
  assert.equal(batch5PublicChannel('https://leafmill.net.evil.example/useful-guide-1234'),undefined);
  assert.equal(batch5PublicChannel('https://leafmill.net/useful-guide-1234?view=1'),undefined);
  assert.deepEqual(batch5RenderedBodySelectors('leafmill'),['.container > .body','article']);
  const page=extract(html,leafUrl,'leafmill');assertBatch5ReadablePage(page,leafUrl);
  assert.ok(!page.bodyHtml.includes('chrome')&&!page.bodyHtml.includes('footer'));
  const checked=inspectBatch5RenderedBody(page,target,'Leafmill guide',body);
  assert.equal(checked.found,true);assert.equal(checked.rel,'nofollow ugc');
  const hidden=extract(html.replace('color: inherit','display: none'),leafUrl,'leafmill');
  assert.equal(hidden.bodyHtml,'');assert.throws(()=>assertBatch5ReadablePage(hidden,leafUrl));
  const duplicate=extract(html.replace(article,article+article),leafUrl,'leafmill');
  assert.equal(duplicate.bodyHtml,'');assert.throws(()=>assertBatch5ReadablePage(duplicate,leafUrl));
});

test('Clawprint renderer requires the unique visible complete entry on its own public URL',()=>{
  const pageUrl='https://clawprint.org/p/checked-note',body='## Check the source\n\nRead the [software guide](https://example.com/guide) before editing.';
  const article='<div class="entry"><h2>Check the source</h2><p>Read the <a href="https://example.com/guide">software guide</a> before editing.</p></div>';
  const html=`<html><head></head><body><div class="post">${article}</div></body></html>`;
  assert.equal(batch5PublicChannel(pageUrl),'clawprint');
  assert.equal(batch5PublicChannel('https://clawprint.org/p/checked-note?view=1'),undefined);
  assert.deepEqual(batch5RenderedBodySelectors('clawprint'),['.post .entry']);
  const page=extract(html,pageUrl,'clawprint');assertBatch5ReadablePage(page,pageUrl);
  assert.equal(inspectBatch5RenderedBody(page,target,'Checked note',body).found,true);
  const hidden=extract(html.replace('<head>','<head><style>.entry{display:none}</style>'),pageUrl,'clawprint');
  assert.equal(hidden.bodyHtml,'');assert.throws(()=>assertBatch5ReadablePage(hidden,pageUrl));
  const hiddenParagraph=extract(html.replace('<p>Read','<p hidden>Read'),pageUrl,'clawprint');
  assert.equal(inspectBatch5RenderedBody(hiddenParagraph,target,'Checked note',body).found,false);
  const duplicate=extract(html.replace(article,article+article),pageUrl,'clawprint');
  assert.equal(duplicate.bodyHtml,'');assert.throws(()=>assertBatch5ReadablePage(duplicate,pageUrl));
  const canonical=extract(html.replace('<head>','<head><link rel="canonical" href="https://clawprint.org/p/other-note">'),pageUrl,'clawprint');
  assert.throws(()=>assertBatch5ReadablePage(canonical,pageUrl));
});

test('Leafmill cancels only observed nonessential third-party resources without weakening unknown-resource denial',()=>{
  assert.equal(leafmillFontStylesheet('https://fonts.googleapis.com/css2?family=Inter:wght@400','stylesheet','GET'),true);
  assert.equal(ignoredLeafmillResource('https://fonts.gstatic.com/s/inter/example.woff2','font','GET'),true);
  assert.equal(ignoredLeafmillResource('https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092','script','GET'),true);
  assert.equal(leafmillFontStylesheet('https://fonts.googleapis.com/evil.css','stylesheet','GET'),false);
  assert.equal(leafmillFontStylesheet('https://fonts.googleapis.com/css2?family=Inter','stylesheet','POST'),false);
  assert.equal(ignoredLeafmillResource('https://static.cloudflareinsights.com/unknown.js','script','GET'),false);
  assert.equal(ignoredLeafmillResource('https://fonts.googleapis.com/evil.css','stylesheet','GET'),false);
  assert.equal(ignoredLeafmillResource('https://fonts.googleapis.com/css2?family=Inter','stylesheet','POST'),false);
  assert.equal(ignoredLeafmillResource('http://fonts.googleapis.com/css2?family=Inter','stylesheet','GET'),false);
});

test('OpenDocs verifies only the exact observed font stylesheet before cancelling it',()=>{
  const fontUrl='https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
  assert.equal(opendocsFontStylesheet(fontUrl,'stylesheet','GET'),true);
  for(const [url,type,method] of [
    [fontUrl,'mainFrame','GET'],[fontUrl,'script','GET'],[fontUrl,'stylesheet','POST'],
    [fontUrl+'&extra=1','stylesheet','GET'],[fontUrl+'#fragment','stylesheet','GET'],
    [fontUrl.replace('400;500;600;700','400'),'stylesheet','GET'],
    [fontUrl.replace('https:','http:'),'stylesheet','GET'],
    [fontUrl.replace('googleapis.com','googleapis.com.evil.example'),'stylesheet','GET'],
    [fontUrl.replace('/css2?','/evil.css?'),'stylesheet','GET'],
    [fontUrl.replace('family=Inter:wght@400;500;600;700&display=swap','display=swap&family=Inter:wght@400;500;600;700'),'stylesheet','GET'],
    ['https://fonts.gstatic.com/s/inter/example.woff2','font','GET'],
  ])assert.equal(opendocsFontStylesheet(url,type,method),false);
});

test('OpenDocs cancels only its three observed advertising scripts without allowing tracking or navigation',()=>{
  for(const url of ['https://connect.facebook.net/en_US/fbevents.js','https://www.redditstatic.com/ads/pixel.js','https://static.ads-twitter.com/uwt.js']){
    assert.equal(ignoredOpenDocsResource(url,'script','GET'),true);
    for(const [changed,type,method] of [
      [url,'mainFrame','GET'],[url,'xhr','GET'],[url,'script','POST'],
      [url+'?event=pageview','script','GET'],[url+'#x','script','GET'],
      [url.replace('https:','http:'),'script','GET'],[url.replace(/(\.com|\.net)\//,'$1.evil.example/'),'script','GET'],
      [url.replace(/[^/]+$/,'unknown.js'),'script','GET'],
    ])assert.equal(ignoredOpenDocsResource(changed,type,method),false);
  }
  assert.equal(ignoredOpenDocsResource('https://www.facebook.com/tr/?event=PageView','image','GET'),false);
});

test('Leafmill and OpenDocs font CSS must contain only bounded font-face rules for the observed font host',()=>{
  const font=`/* latin */\n@font-face { font-family: 'Inter'; font-style: normal; font-weight: 400 700; font-display: swap; src: url(https://fonts.gstatic.com/s/inter/v1/example.woff2) format('woff2'); unicode-range: U+0000-00FF; }`;
  assert.equal(leafmillFontFaceOnly(font),true);
  assert.equal(leafmillFontFaceOnly(font+'\n.body { display:none }'),false);
  assert.equal(leafmillFontFaceOnly('@import url(https://evil.example/a.css);'+font),false);
  assert.equal(leafmillFontFaceOnly(font.replace('fonts.gstatic.com','evil.example')),false);
  assert.equal(leafmillFontFaceOnly(font.replace("format('woff2')","format('woff2'); color:red")),false);
  assert.equal(leafmillFontFaceOnly(font.replace('font-family:', '@media screen { font-family:')),false);
});


test('Marked Share requires its observed unique visible document body and exact public URL',()=>{
 const u='https://markedb.in/Example_42';
 assert.equal(batch5PublicChannel(u),'marked-share');
 assert.equal(batch5PublicChannel('https://share.markedapp.com/Example_42'),'marked-share');
 for(const alias of ['https://share.markedapp.com/session/bridge?return_to=%2FExample_42','https://share.markedapp.com/Example_42?x=1','https://share.markedapp.com/Example_42#x','https://share.markedapp.com.evil.example/Example_42'])assert.equal(batch5PublicChannel(alias),undefined);
 for(const changed of [u+'/',u+'?x=1',u+'#fragment',u.replace('https:','http:'),u.replace('markedb.in','markedb.in.evil.example')])assert.equal(batch5PublicChannel(changed),undefined);
 assert.deepEqual(batch5RenderedBodySelectors('marked-share'),['article .document-body']);
 const html='<article><h1>Example Guide</h1><nav>Platform controls</nav><div class="document-body"><p>Read the <a href="https://example.com/guide">source guide</a>.</p></div></article>';
 const page=extract(html,u,'marked-share');assertBatch5ReadablePage(page,u);
 assert.equal(inspectBatch5RenderedBody(page,target,'Example Guide','Read the [source guide](https://example.com/guide).').found,true);
 for(const body of [html+html,html.replace('<article>','<article hidden>'),html.replace('<article>','<main>').replace('</article>','</main>')])assert.equal(extract(body,u,'marked-share').bodyHtml,'');
});


test('Marked Share cancels only its observed analytics script without allowing navigation or other resources',()=>{
 const url='https://analytics.brettterpstra.com/script.js';assert.equal(ignoredMarkedShareResource(url,'script','GET'),true);
 for(const [u,type,method] of [[url,'mainFrame','GET'],[url,'script','POST'],[url+'?x=1','script','GET'],[url.replace('https:','http:'),'script','GET'],[url.replace('/script.js','/other.js'),'script','GET'],['https://evil.example/script.js','script','GET']])assert.equal(ignoredMarkedShareResource(u,type,method),false);
});


test('Publish Markdown and DropDeploy renderers require bounded provider URLs and unique original content roots',()=>{
 assert.equal(batch5PublicChannel('https://publishmarkdown.com/example_123'),'publishmarkdown');assert.equal(batch5PublicChannel('https://example-guide.ddploy.com/'),'dropdeploy');
 for(const value of ['https://publishmarkdown.com/example_123?view=1','https://publishmarkdown.com/api/private','https://publishmarkdown.com.evil.example/example_123','https://app.ddploy.com/','https://example-guide.ddploy.com/changed','https://evil.example.ddploy.com/','https://example-guide.ddploy.com/?x=1'])assert.equal(batch5PublicChannel(value),undefined);
 assert.deepEqual(batch5RenderedBodySelectors('publishmarkdown'),['article']);assert.deepEqual(batch5RenderedBodySelectors('dropdeploy'),['main > article > section']);
 const paragraph='<p>Read the <a href="https://example.com/guide">source guide</a>.</p>',body='Read the [source guide](https://example.com/guide).';
 for(const channel of ['publishmarkdown','dropdeploy'] as const){const pageUrl=channel==='dropdeploy'?'https://example-guide.ddploy.com/':'https://publishmarkdown.com/example_123',html=channel==='dropdeploy'?'<main><article><header><h1>Example Guide</h1></header><section>'+paragraph+'</section></article></main>':'<article>'+paragraph+'</article>';
  const page=extract(html,pageUrl,channel);assertBatch5ReadablePage(page,pageUrl);assert.equal(inspectBatch5RenderedBody(page,target,'Example Guide',body).found,true);assert.equal(extract(html+html,pageUrl,channel).bodyHtml,'');assert.equal(inspectBatch5RenderedBody(extract(html.replace('<p>','<p hidden>'),pageUrl,channel),target,'Example Guide',body).found,false);
 }
});


test('DropDeploy cancels only the exact observed beacon script, not navigation or arbitrary analytics',()=>{
 const beacon='https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092';
 assert.equal(ignoredDropDeployResource(beacon,'script','GET'),true);
 for(const [url,type,method] of [[beacon,'mainFrame','GET'],[beacon,'script','POST'],[beacon+'?x=1','script','GET'],[beacon+'#x','script','GET'],[beacon.replace('https:','http:'),'script','GET'],[beacon.replace('.com/','.com.evil.example/'),'script','GET'],[beacon.replace('ce701','00000'),'script','GET'],['https://static.cloudflareinsights.com/other.js','script','GET'],['https://synthetic-example.ddploy.com/cdn-cgi/challenge-platform/','script','GET']])assert.equal(ignoredDropDeployResource(url,type,method),false);
 const source=readFileSync(join(import.meta.dirname,'../src/main/batch5-renderer.ts'),'utf8');
 assert.ok(source.includes("channel==='dropdeploy'&&!ignoredDropDeployResource(details.url,details.resourceType,details.method)"));
 assert.ok(source.includes('callback({cancel:!allowed})'));
});


test('MD.page renderer binds original task path and one visible document root',()=>{
 const url='https://synthetic-owner.md.page/task-'+'a'.repeat(24);
 assert.equal(batch5PublicChannel(url),'mdpage');
 for(const bad of [url+'?edit=1',url+'#x',url.replace('https:','http:'),'https://md.page/task-'+'a'.repeat(24),'https://synthetic-owner.md.page/welcome'])assert.equal(batch5PublicChannel(bad),undefined);
 const html='<html><head></head><body><div class="container"><p>Original content</p></div></body></html>';
 assert.ok(extract(html,url,'mdpage').bodyHtml.includes('Original content'));
 assert.equal(extract(html.replace('</body>','<div class="container">Other</div></body>'),url,'mdpage').bodyHtml,'');
 assert.throws(()=>assertBatch5ReadablePage({...extract(html,url,'mdpage'),headHtml:'<link rel="canonical" href="https://synthetic-owner.md.page/">'},url));
});
