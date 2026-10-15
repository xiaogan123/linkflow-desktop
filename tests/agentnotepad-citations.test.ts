import test from 'node:test';
import assert from 'node:assert/strict';
import {agentNotepadPublisherTesting} from '../src/integrations/agentnotepad-publisher';
import type {AgentNotepadRenderedPage} from '../src/integrations/agentnotepad';
const citations=[{url:'https://example.org/reference',title:'Reference'},{url:'https://example.com/tool',title:'Tool context'}];
const body='Read the [tool](https://example.com/tool).';
function page(){return {articleText:'Read the [2].',articleHtml:'<div class="markdown"><p>Read the <sup class="citation-ref" id="cite-2-1"><a href="#source-2" title="Tool context">[2]</a></sup>.</p></div>',citationSources:citations.map((c,i)=>({id:`source-${i+1}`,href:c.url,text:c.title,rel:['nofollow','ugc'],visible:true,backlinks:i?['#cite-2-1']:[]}))} as AgentNotepadRenderedPage}
const verify=(value:AgentNotepadRenderedPage)=>agentNotepadPublisherTesting.exactRenderedArticle(value,body,citations);
test('provider citation substitution binds original ordered source title URL and backlinks',()=>{assert.equal(verify(page()),true)});
test('wrong source URL/title, invisible source or missing return link is rejected',()=>{for(const change of [{href:'https://example.net/wrong'},{text:'other'},{visible:false},{backlinks:[]},{rel:['ugc']}]){const p=page();Object.assign(p.citationSources![1],change);assert.equal(verify(p),false)}});
test('duplicate, reassigned and fabricated inline citation nodes are rejected',()=>{for(const html of [page().articleHtml.replace('cite-2-1','cite-2-2'),page().articleHtml.replace('#source-2','#source-1'),page().articleHtml.replace('Tool context','Other'),page().articleHtml.replace('[2]','[1]'),page().articleHtml.replace('</sup>','<span>hiddenextra</span></sup>')]){const p=page();p.articleHtml=html;assert.equal(verify(p),false)}});
test('changed article and omitted source cannot be masked by valid citation metadata',()=>{let p=page();p.articleText='Changed [2].';assert.equal(verify(p),false);p=page();p.articleHtml=p.articleHtml.replace('Read the','Changed');assert.equal(verify(p),false);p=page();p.citationSources!.pop();assert.equal(verify(p),false)});
