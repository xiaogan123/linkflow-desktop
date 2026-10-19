import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {findDirectLink, inspectRecheckedLinkHtml, PublicFetchError, recheckLink} from '../src/integrations/web';

const PAGE_URL = 'https://telegra.ph/Example-Fee-Guide-10-04';
const SITE_URL = 'https://example-site.com/';
const OLD_URL = 'https://old-site.example.com/';
const html = readFileSync(new URL('./fixtures/telegraph-live-sample.sanitized.html', import.meta.url), 'utf8');
const link = 'href="https://example-site.com/" target="_blank" rel="nofollow"';
assert.ok(html.includes(link), 'sanitized Telegraph fixture must include the site link');

function inspect(page: string, legacy: readonly string[] = [], robotsHeader = '') {
  return inspectRecheckedLinkHtml(page, PAGE_URL, SITE_URL, legacy, robotsHeader);
}

test('sanitized Telegraph page keeps the visible nofollow link and explicit index state', () => {
  const result = inspect(html);
  assert.equal(result.outcome, 'found');
  assert.equal(result.found, true);
  assert.equal(result.rel, 'nofollow');
  assert.equal(result.reasonCode, 'link_found');
  assert.equal(result.matchedOrigin, 'https://example-site.com');
  assert.equal(result.usesLegacyOrigin, false);
  assert.equal(result.indexable, true);
});

test('periodic inspection tolerates edited article text, title, language, and canonical', () => {
  const changed = html
    .replace('示例正文', '发布后更新的正文')
    .replace('<html>', '<html lang="en">')
    .replace('<title>示例标题 – Telegraph</title>', '<title>Another heading</title>')
    .replace(`<link rel="canonical" href="${PAGE_URL}"`, '<link rel="canonical" href="https://telegra.ph/another-page"');
  assert.equal(inspect(changed).found, true);
  assert.equal(findDirectLink(changed, PAGE_URL, SITE_URL).outcome, 'invalid');
});

test('missing, hidden, and head-only links have distinct results', () => {
  const without = html.replace(link, 'href="https://other-site.example.com/" target="_blank" rel="nofollow"');
  assert.equal(inspect(without).reasonCode, 'link_absent');
  const invalidAnchor = html.replace('<article id="_tl_editor"', '<a href="https://example-site.com:9999/">invalid</a><article id="_tl_editor"');
  assert.equal(inspect(invalidAnchor).reasonCode, 'link_found');
  const headOnly = without.replace('</head>', `<template><a href="${SITE_URL}">Header link</a></template></head>`);
  assert.equal(inspect(headOnly).reasonCode, 'link_absent');
  for (const hidden of [
    html.replace('<article id="_tl_editor" class="tl_article_content">', '<article id="_tl_editor" class="tl_article_content" hidden>'),
    html.replace(link, `${link} style="display: none"`),
    html.replace(link, `${link} aria-hidden="TRUE"`),
    html.replace('</head>', '<style>#_tl_editor a { display: none !important }</style></head>'),
    html.replace('>Example Site</a>', '></a>'),
  ]) {
    const result = inspect(hidden);
    assert.equal(result.found, false);
    assert.equal(result.outcome, 'invalid');
    assert.equal(result.reasonCode, 'link_hidden');
    assert.equal(result.indexable, true);
    assert.equal(result.rel, 'nofollow');
  }
  const pseudoOnly = html.replace('</head>', '<style>#_tl_editor a::before { display: none }</style></head>');
  assert.equal(inspect(pseudoOnly).found, true);
});

test('periodic visibility keeps screen-visible layouts while first-publication checks remain strict', () => {
  const fixtures = [
    html.replace(link, `${link} style="width:100%;overflow:hidden"`),
    html.replace('</head>', '<style>@media print { #_tl_editor a { display:none } }</style></head>'),
    html.replace('</head>', '<style media="print">#_tl_editor a { display:none }</style></head>'),
    html.replace(link, `${link} style="position:fixed;top:20px;left:20px"`),
  ];
  for (const page of fixtures) {
    const result = inspect(page);
    assert.equal(result.found, true);
    assert.equal(result.reasonCode, 'link_found');
    assert.equal(result.rel, 'nofollow');
    assert.equal(result.matchedOrigin, 'https://example-site.com');
    assert.equal(findDirectLink(page, PAGE_URL, SITE_URL).found, false);
  }
});

test('unrelated or harmless hover rules do not make a screen-visible link uncertain', () => {
  for (const rule of [
    'button:hover { color:red }', '#_tl_editor a:hover { color:red }',
    '#_tl_editor a:hover { opacity:.8 }', '#_tl_editor a:hover { transform:translateY(-1px) }',
    '#_tl_editor a:focus { display:inline; visibility:visible; transform:scale(1) }',
  ]) {
    const result = inspect(html.replace('</head>', `<style>${rule}</style></head>`));
    assert.equal(result.reasonCode, 'link_found');
    assert.equal(result.rel, 'nofollow');
  }
});

test('dynamic rules that hide a link remain uncertain instead of proving loss', () => {
  for (const declaration of ['opacity:0%', 'font-size:0rem', 'color:rgba(0,0,0,0)', 'display:none', 'transform:translateX(-100vw)']) {
    const result=inspect(html.replace('</head>', `<style>#_tl_editor a:hover { ${declaration} }</style></head>`));
    assert.equal(result.found,false,declaration);
    assert.equal(result.reasonCode,'visibility_unknown',declaration);
    assert.equal(result.rel,'nofollow');
  }
});

test('zero font sizes, zero alpha colors and zero percent opacity are hidden in both checks', () => {
  const declarations=[
    'font-size:0ch', 'font-size:0vw', 'font-size:.0ex', 'font-size:0.00%', 'font-size:0Q',
    'opacity:0%', 'opacity:0.00%',
    'color:rgb(12,34,56,0)', 'color:rgb(12,34,56,0%)', 'color:hsl(120,50%,50%,0)', 'color:hsl(120,50%,50%,0%)', 'color:rgba(12,34,56,0)', 'color:rgba(12,34,56,0%)', 'color:rgb(12 34 56 / 0%)',
    'color:hsla(120,50%,50%,0)', 'color:hsl(120 50% 50% / 0)',
    'color:oklch(50% .2 120 / 0)', 'color:#1230', 'color:#12345600',
    '-webkit-text-fill-color:rgb(12 34 56 / 0)',
  ];
  for(const declaration of declarations){
    const page=html.replace(link,`${link} style="${declaration}"`);
    assert.equal(inspect(page).reasonCode,'link_hidden',declaration);
    assert.equal(findDirectLink(page,PAGE_URL,SITE_URL).found,false,declaration);
  }
});

test('tiny fonts and offscreen text geometry need confirmation without becoming lost links', () => {
  for(const declaration of [
    'font-size:.5px', 'font-size:1px', 'text-indent:-999px', 'text-indent:-1000.5px',
    'transform:translateX(-1000px)', 'transform:translate(100vw,0)',
    'transform:translate3d(0,-100vh,0)', 'translate:-1000px 0',
  ]){
    const page=html.replace(link,`${link} style="${declaration}"`),result=inspect(page);
    assert.equal(result.found,false,declaration);
    assert.equal(result.reasonCode,'visibility_unknown',declaration);
    assert.equal(result.rel,'nofollow');
    assert.equal(findDirectLink(page,PAGE_URL,SITE_URL).found,false,declaration);
  }
  for(const declaration of ['color:rgb(0,0,0)', 'color:hsl(0,0%,0%)', 'font-size:1.01px','text-indent:-998px','transform:translateY(-1px)','opacity:.8','color:rgba(0,0,0,.5)']){
    assert.equal(inspect(html.replace(link,`${link} style="${declaration}"`)).reasonCode,'link_found',declaration);
  }
});

test('closed details hide body links but preserve a link in their summary', () => {
  const bodyLink = `<details><summary>Toggle</summary><a ${link}>Example Site</a></details>`;
  const summaryLink = `<details><summary><a ${link}>Example Site</a></summary><p>Details</p></details>`;
  assert.equal(inspect(html.replace(`<a ${link}>Example Site</a>`, bodyLink)).reasonCode, 'link_hidden');
  assert.equal(inspect(html.replace(`<a ${link}>Example Site</a>`, summaryLink)).reasonCode, 'link_found');
});

test('uncertain conditional CSS stays unknown; proven zero-sized clipping stays hidden', () => {
  const conditional = html.replace('</head>', '<style>@media (max-width:600px) { #_tl_editor a { display:none } }</style></head>');
  const uncertain = inspect(conditional);
  assert.equal(uncertain.reasonCode, 'visibility_unknown');
  assert.equal(uncertain.rel, 'nofollow');
  assert.equal(uncertain.matchedOrigin, 'https://example-site.com');
  const clipped = inspect(html.replace(link, `${link} style="height:0;overflow:hidden"`));
  assert.equal(clipped.reasonCode, 'link_hidden');
  assert.equal(clipped.rel, 'nofollow');
  const noindex = inspect(conditional.replace('content="index, follow"', 'content="noindex, follow"'));
  assert.equal(noindex.reasonCode, 'page_noindex');
  assert.equal(noindex.rel, 'nofollow');
  assert.equal(noindex.matchedOrigin, 'https://example-site.com');
});

test('inline CSS comments cannot conceal a hidden declaration; functional pseudo selectors stay uncertain', () => {
  const inline = inspect(html.replace(link, `${link} style="display:/**/none"`));
  assert.equal(inline.reasonCode, 'link_hidden');
  assert.equal(inline.rel, 'nofollow');
  const functional = inspect(html.replace('</head>', '<style>#_tl_editor a:is(a,::before) { display:none }</style></head>'));
  assert.equal(functional.reasonCode, 'visibility_unknown');
  assert.equal(functional.rel, 'nofollow');
  assert.equal(functional.matchedOrigin, 'https://example-site.com');
});

test('noindex in meta or X-Robots-Tag invalidates the periodic result', () => {
  const meta = inspect(html.replace('content="index, follow"', 'content="noindex, follow"'));
  assert.equal(meta.found, false);
  assert.equal(meta.reasonCode, 'page_noindex');
  assert.equal(meta.indexable, false);
  assert.equal(meta.rel, 'nofollow');
  assert.equal(meta.matchedOrigin, 'https://example-site.com');
  const header = inspect(html, [], 'googlebot: noindex');
  assert.equal(header.reasonCode, 'page_noindex');
  assert.equal(header.indexable, false);
});

test('X-Robots-Tag agent clauses apply only to Googlebot and Bingbot', () => {
  const noRel=html.replace(' rel="nofollow">Example Site</a>','>Example Site</a>');
  for(const header of ['gptbot: noindex','gptbot: none','googlebot-image: noindex','GPTBot: nofollow','max-snippet: 0','gptbot: index, noindex','gptbot: noindex, nofollow']){
    const result=inspect(noRel,[],header);
    assert.equal(result.reasonCode,'link_found',header);
    assert.equal(result.rel,'follow',header);
    assert.equal(findDirectLink(noRel,PAGE_URL,SITE_URL,header).found,true,header);
  }
  for(const header of ['googlebot: noindex','BingBot: none','noindex']){
    assert.equal(inspect(noRel,[],header).reasonCode,'page_noindex',header);
    assert.equal(findDirectLink(noRel,PAGE_URL,SITE_URL,header).found,false,header);
  }
  assert.equal(inspect(noRel,[],'gptbot: noindex, bingbot: nofollow').rel,'nofollow');
  assert.equal(inspect(noRel,[],'gptbot: noindex, nofollow').rel,'follow');
});

test('empty rel means follow; page-wide nofollow changes the effective rel', () => {
  const noRel = html.replace(' rel="nofollow">Example Site</a>', '>Example Site</a>');
  assert.equal(inspect(noRel).rel, 'follow');
  const pageNofollow = noRel.replace('content="index, follow"', 'content="index, nofollow"');
  assert.equal(inspect(pageNofollow).rel, 'nofollow');
});

test('migration origin remains a valid match and current origin takes priority', () => {
  const old = html.replace('href="https://example-site.com/"', `href="${OLD_URL}"`);
  assert.equal(inspect(old).reasonCode, 'link_absent');
  const accepted = inspect(old, [OLD_URL]);
  assert.equal(accepted.found, true);
  assert.equal(accepted.reasonCode, 'legacy_origin');
  assert.equal(accepted.usesLegacyOrigin, true);
  assert.equal(accepted.matchedOrigin, 'https://old-site.example.com');
  const both = old.replace('</article>', `<a href="${SITE_URL}">New site</a></article>`);
  const preferred = inspect(both, [OLD_URL]);
  assert.equal(preferred.reasonCode, 'link_found');
  assert.equal(preferred.usesLegacyOrigin, false);
  assert.equal(preferred.rel, 'follow');
});

test('guarded network check separates HTTP, media, transport, and source errors', async () => {
  const base = {resolve: async () => [{address: '8.8.8.8', family: 4}]};
  const request = async (status: number, contentType: string, body: string, robots?: string) => recheckLink(
    PAGE_URL, SITE_URL, [], 'telegra.ph', undefined,
    {...base, request: async () => ({status, headers: {'content-type': contentType, ...(robots ? {'x-robots-tag': robots} : {})}, body: Buffer.from(body)})},
  );
  assert.equal((await request(200, 'text/html', html)).reasonCode, 'link_found');
  assert.equal((await request(200, 'text/html', html, 'noindex')).reasonCode, 'page_noindex');
  assert.equal((await request(404, 'text/html', '')).reasonCode, 'link_absent');
  assert.equal((await request(200, 'application/json', '{}')).reasonCode, 'page_not_html');
  const transport = await recheckLink(PAGE_URL, SITE_URL, [], 'telegra.ph', undefined,
    {...base, request: async () => {throw Error('TLS handshake failed')}});
  assert.equal(transport.reasonCode, 'page_unreachable');
  let requests = 0;
  const mismatch = await recheckLink(PAGE_URL, SITE_URL, [], 'unrelated.example.com', undefined,
    {...base, request: async () => {requests++; throw Error('unexpected fetch')}});
  assert.equal(mismatch.reasonCode, 'source_mismatch');
  assert.equal(requests, 0);
});

test('periodic fetch failure classification uses typed codes rather than display wording',async()=>{
  for(const [error,expected] of [
    [new PublicFetchError('http_status','Translated HTTP failure',503),'page_http_error'],
    [new PublicFetchError('media_type','Translated media failure'),'page_not_html'],
    [new Error('Public page returned HTTP 404'),'page_unreachable'],
    [new Error('Public page is not HTML'),'page_unreachable'],
  ] as const){
    const result=await recheckLink(PAGE_URL,SITE_URL,[],'telegra.ph',undefined,{
      resolve:async()=>[{address:'8.8.8.8',family:4}],request:async()=>{throw error},
    });
    assert.equal(result.reasonCode,expected);assert.equal(result.found,false);
  }
});

test('periodic network checks accept only same-path scheme and trailing-slash normalization', async () => {
  const source='http://telegra.ph/Example-Fee-Guide-10-04';
  const requested:string[]=[];
  const result=await recheckLink(source,SITE_URL,[],'telegra.ph',undefined,{
    resolve:async()=>[{address:'8.8.8.8',family:4}],
    request:async url=>{
      requested.push(url.href);
      if(url.protocol==='http:')return {status:301,headers:{location:PAGE_URL},body:Buffer.alloc(0)};
      if(!url.pathname.endsWith('/'))return {status:308,headers:{location:PAGE_URL+'/'},body:Buffer.alloc(0)};
      return {status:200,headers:{'content-type':'text/html'},body:Buffer.from(html)};
    },
  });
  assert.equal(result.reasonCode,'link_found');
  assert.equal(result.url,PAGE_URL+'/');
  assert.deepEqual(requested,[source,PAGE_URL,PAGE_URL+'/']);
});

test('redirects to a different page are rejected before fetching and retain their destination', async () => {
  for(const destination of [
    'https://telegra.ph/Another-Guide-10-04', PAGE_URL+'?different=1',
    'https://other.example.com/Example-Fee-Guide-10-04',
    PAGE_URL.replace('https:','http:'),
  ]){
    let requests=0;
    const result=await recheckLink(PAGE_URL,SITE_URL,[],'telegra.ph',undefined,{
      resolve:async()=>[{address:'8.8.8.8',family:4}],
      request:async()=>{requests++;return {status:302,headers:{location:destination},body:Buffer.alloc(0)}},
    });
    assert.equal(result.found,false,destination);
    assert.equal(result.outcome,'invalid',destination);
    assert.equal(result.reasonCode,'source_redirect_mismatch',destination);
    assert.equal(result.url,destination);
    assert.equal(requests,1,'a different page must not be fetched or adopted');
  }
});

test('a Telegraph author byline linking to the site does not count as the article link', () => {
  // New pages are created with author_url = site homepage; Telegraph renders it in the header address.
  const withAuthor = html.replace('<address>Example Site site owner<br></address>', '<address><a rel="author" href="https://example-site.com/">Example Site</a><br></address>');
  assert.notEqual(withAuthor, html, 'fixture must contain the header address to patch');
  const both = inspect(withAuthor);
  assert.equal(both.outcome, 'found');
  assert.equal(both.rel, 'nofollow', 'rel must come from the body link, not the byline');
  const bylineOnly = inspect(withAuthor.replace(` <a ${link}>Example Site</a>`, '').replace(`<a ${link}>Example Site</a>`, ''));
  assert.equal(bylineOnly.found, false);
  assert.equal(bylineOnly.outcome, 'absent');
});

test('links in navigation, footer and comment areas do not count when the page has no article container', () => {
  const page = '<!doctype html><html><body><nav><a href="https://example-site.com/">站点</a></nav><main><p>正文没有链接</p></main><div class="comments"><a href="https://example-site.com/x">评论</a></div><footer><a href="https://example-site.com/">页脚</a></footer></body></html>';
  assert.equal(inspect(page).found, false);
  const withBody = page.replace('<p>正文没有链接</p>', '<p>见 <a href="https://example-site.com/guide">这里</a></p>');
  assert.equal(inspect(withBody).found, true);
});

test('inherited visibility styles use the nearest declaration at readable text',()=>{
 for(const [ancestor,anchor] of [['visibility:hidden','visibility:visible'],['font-size:0','font-size:16px'],['color:transparent','color:#123456'],['-webkit-text-fill-color:transparent','-webkit-text-fill-color:#123456']]){
  const restored=`<div style="${ancestor}"><a href="${SITE_URL}" style="${anchor}">Readable</a></div>`;
  assert.equal(inspect(restored).reasonCode,'link_found',restored);
  assert.equal(inspect(`<div style="${ancestor}"><a href="${SITE_URL}">Hidden</a></div>`).reasonCode,'link_hidden',ancestor);
  assert.equal(inspect(`<a href="${SITE_URL}" style="${ancestor}"><span style="${anchor}">Readable</span></a>`).reasonCode,'link_found',anchor);
 }
 for(const ancestor of ['display:none','opacity:0'])assert.equal(inspect(`<div style="${ancestor}"><a href="${SITE_URL}" style="display:block;opacity:1;color:black">Hidden</a></div>`).reasonCode,'link_hidden',ancestor);
 assert.equal(inspect(`<style>article{visibility:hidden}a{visibility:visible}</style><article><a href="${SITE_URL}">Readable</a></article>`).reasonCode,'link_found');
});

test('raw X-Robots-Tag headers reset agent scope separately',async()=>{
 const result=await recheckLink('https://pages.example.com/guide',SITE_URL,[],'pages.example.com',undefined,{
  resolve:async()=>[{address:'93.184.216.34',family:4}],
  request:async()=>({status:200,headers:{'content-type':'text/html','x-robots-tag':'gptbot: noindex, nofollow, noindex'},rawHeaders:['Content-Type','text/html','X-Robots-Tag','gptbot: noindex, nofollow','X-Robots-Tag','noindex'],body:Buffer.from(`<a href="${SITE_URL}">Example</a>`)}),
 });
 assert.equal(result.reasonCode,'page_noindex');assert.equal(result.rel,'follow');
 assert.equal(inspect(`<a href="${SITE_URL}">Example</a>`,[],'gptbot: noindex, nofollow\nindex, follow').reasonCode,'link_found');
});

test('periodic recheck accepts same-path www normalization and refuses other host or path changes',async()=>{
 for(const [destination,allowed] of [['https://www.pages.example.com/guide',true],['https://pages.example.com/guide/',true],['https://other.pages.example.com/guide',false],['https://www.pages.example.com/other',false]] as const){
  let reads=0;
  const result=await recheckLink('https://pages.example.com/guide',SITE_URL,[],'pages.example.com',undefined,{
   resolve:async()=>[{address:'93.184.216.34',family:4}],
   request:async()=>++reads===1?{status:301,headers:{location:destination},body:Buffer.alloc(0)}:{status:200,headers:{'content-type':'text/html'},body:Buffer.from(`<a href="${SITE_URL}">Example</a>`)},
  });
  assert.equal(result.found,allowed,destination);assert.equal(reads,allowed?2:1,destination);
 }
});

test('relative text properties cannot falsely restore hidden inherited text',()=>{
 assert.equal(inspect(`<div style="color:transparent;-webkit-text-fill-color:currentColor"><a href="${SITE_URL}" style="color:black">Readable</a></div>`).found,true);
 for(const child of ['1em','100%','calc(1em)','var(--font)','larger']){
  const result=inspect(`<div style="font-size:0"><a href="${SITE_URL}" style="font-size:${child}">Hidden</a></div>`);
  assert.equal(result.found,false,child);assert.equal(result.reasonCode,'visibility_unknown',child);
 }
 for(const value of ['revert','revert-layer'])assert.equal(inspect(`<div style="visibility:hidden"><a href="${SITE_URL}" style="visibility:${value}">Hidden</a></div>`).found,false,value);
 for(const property of ['color','-webkit-text-fill-color']){
  const result=inspect(`<div style="color:transparent"><a href="${SITE_URL}" style="${property}:currentColor">Hidden</a></div>`);
  assert.equal(result.found,false,property);
 }
});

test('relative font sizes under a visible page are ordinary theme styles, not hidden or unknown text', () => {
  const page = (style: string, anchorStyle = '') => `<html><head><style>${style}</style></head><body><article><p>See <a href="${SITE_URL}"${anchorStyle ? ` style="${anchorStyle}"` : ''}>the guide</a>.</p></article></body></html>`;
  for (const [style, anchor] of [['html{font-size:62.5%}body{font-size:1.6rem}', ''], ['article{font-size:clamp(1rem,2vw,1.25rem)}', ''], ['p{font-size:1.1em}', 'font-size:90%'], ['p{font-size:larger}', 'font-size:revert']] as const) {
    assert.equal(inspect(page(style, anchor)).outcome, 'found', `${style} ${anchor}`);
  }
  // Under a zero-size ancestor a relative size cannot prove the text came back.
  assert.notEqual(inspect(`<div style="font-size:0"><a href="${SITE_URL}" style="font-size:1.2em">Hidden</a></div>`).outcome, 'found');
});

test('tiny relative font sizes and calculations with a zero term cannot prove a link visible',async()=>{
  const {articleTextStyleVisibility}=await import('../src/integrations/article-visibility');
  for(const value of ['0.01em','1%','0.15rem','calc(0px)','min(0px, 1em)'])assert.equal(articleTextStyleVisibility('font-size',value),'unknown',value);
  for(const value of ['0.875em','85%','calc(1rem + 0.5vw)','clamp(0.875rem, 0.8rem + 0.5vw, 1rem)','calc(100% - 2px)'])assert.equal(articleTextStyleVisibility('font-size',value),'visible',value);
});
