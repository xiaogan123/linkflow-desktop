import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {load} from 'cheerio';
import {assertBatch5ReadablePage,batch5ExtractionSource,inspectBatch5RenderedBody,type Batch5RenderedBody} from '../src/main/batch5-renderer';

const url='https://hackmd.io/example-note',target='https://example.com/guide';
const markdown='# Example Guide\n\n## Verify the source\n\nRead the [source guide](https://example.com/guide) before publishing.\n\nA "quoted" note -- with an ellipsis... and example.com.\n';
const fixture=readFileSync(join(import.meta.dirname,'fixtures','hackmd-public-page.html'),'utf8');

/** Minimal DOM bridge around Cheerio, enough to run Electron's actual extraction script. */
function extract(html:string,pageUrl=url):Batch5RenderedBody{
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
    return {display:declarations.display??'block',visibility:declarations.visibility??'visible',opacity:declarations.opacity??'1',
      contentVisibility:declarations['content-visibility']??'visible',pointerEvents:declarations['pointer-events']??'auto'};
  };
  return runInNewContext(batch5ExtractionSource('hackmd'),{document,HTMLElement,getComputedStyle,location:{href:pageUrl}},{timeout:1000}) as Batch5RenderedBody;
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
