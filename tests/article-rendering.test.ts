import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRenderedArticle, inspectRenderedArticle } from '../src/integrations/article-rendering';

const TARGET = 'https://example.com/research/source';

test('rendered article comparison preserves every literal operator and numeric delimiter', async t => {
  const markdown = `The return was -5%, the inequality was 1 < 2, the expression was 2*3=6, and the ratio was 1/2. [Source](${TARGET})`;
  const visible = 'The return was -5%, the inequality was 1 &lt; 2, the expression was 2*3=6, and the ratio was 1/2.';
  const page = (text: string) => `<article><p>${text} <a href="${TARGET}">Source</a></p></article>`;

  assert.deepEqual(
    verifyRenderedArticle(page(visible), markdown, TARGET, 'article'),
    { found: true, rel: '' },
  );

  for (const [name, changed] of [
    ['return sign', visible.replace('-5%', '+5%')],
    ['percentage marker', visible.replace('-5%', '-5')],
    ['comparison direction', visible.replace('1 &lt; 2', '1 &gt; 2')],
    ['multiplication operator', visible.replace('2*3=6', '2/3=6')],
    ['fraction delimiter', visible.replace('1/2', '1:2')],
  ] as const) {
    await t.test(name, () => {
      assert.equal(verifyRenderedArticle(page(changed), markdown, TARGET, 'article'), false);
    });
  }
});

test('standard GFM tables, entities, and whitespace render without semantic loss', () => {
  const markdown = `| Asset | Return |
| --- | --- |
| ETH | -5% |

Research &amp; development. [Source](${TARGET})`;
  const html = `<article>
    <table><thead><tr><th>Asset</th><th>Return</th></tr></thead>
    <tbody><tr><td>ETH</td><td>-5%</td></tr></tbody></table>
    <p>Research &amp; development. <a href="${TARGET}" rel="ugc">Source</a></p>
  </article>`;

  assert.deepEqual(
    verifyRenderedArticle(html, markdown, TARGET, 'article'),
    { found: true, rel: 'ugc' },
  );
  assert.equal(
    verifyRenderedArticle(html.replace('Research &amp; development', 'Research and development'), markdown, TARGET, 'article'),
    false,
  );
});

test('raw Markdown HTML is parsed as inert data and non-rendered script text is excluded', () => {
  const state = globalThis as typeof globalThis & { __articleRenderingScriptProbe?: boolean };
  delete state.__articleRenderingScriptProbe;
  const markdown = `Visible reviewed evidence.<script>globalThis.__articleRenderingScriptProbe=true</script> [Source](${TARGET})`;
  const html = `<article><p>Visible reviewed evidence. <a href="${TARGET}">Source</a></p></article>`;

  assert.deepEqual(
    verifyRenderedArticle(html, markdown, TARGET, 'article'),
    { found: true, rel: '' },
  );
  assert.equal(state.__articleRenderingScriptProbe, undefined);
});


test('unicode exponents and digit separators retain meaning while inline sentence punctuation tolerates spacing',()=>{
  const target='https://example.com/guide';
  const check=(markdown:string,body:string)=>inspectRenderedArticle(`<article><p>${body} <a href="${target}">source</a></p></article>`,`${markdown} [source](${target})`,target,'article');
  assert.equal(check('Limit is 10⁶ units.','Limit is 106 units.').found,false);
  assert.equal(check('Value is 1.2 units.','Value is 1 .2 units.').found,false);
  assert.equal(check('Documentation at example.com/mcp.','Documentation at example.com/mcp .').found,true);
});

test('closed, clipped, stylesheet-hidden articles and empty target links cannot count as visible results',()=>{
 const markdown=`Reviewed information with a [Source](${TARGET}).`,body=`<p>Reviewed information with a <a href="${TARGET}">Source</a>.</p>`;
 for(const page of [
  `<details><article>${body}</article></details>`,
  `<article style="height:1px;overflow:hidden">${body}</article>`,
  `<style>.blocked { display: none }</style><article class="blocked">${body}</article>`,
  `<style>article a {font-size:0}</style><article>${body}</article>`,
  `<article><p>Reviewed information with a Source.<a href="${TARGET}"></a></p></article>`,
 ])assert.equal(verifyRenderedArticle(page,markdown,TARGET,'article'),false);
 assert.notEqual(verifyRenderedArticle(`<details open><article>${body}</article></details>`,markdown,TARGET,'article'),false);
 assert.notEqual(verifyRenderedArticle(`<style>.unrelated{display:none}</style><article>${body}</article>`,markdown,TARGET,'article'),false);
});
