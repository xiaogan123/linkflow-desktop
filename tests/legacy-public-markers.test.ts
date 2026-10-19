import assert from 'node:assert/strict';
import test from 'node:test';
import {scanLegacyPublicMarkers} from '../src/shared/legacy-public-markers';

test('read-only scan lists old publishing markers without changing the page',()=>{
  const html='<article data-linkflow="published">Site publishing assistant</article>';
  const input={html,url:'https://linkflow-page.example.com/post'};
  assert.deepEqual(scanLegacyPublicMarkers(input),['blogger_data_linkflow','legacy_author','legacy_subdomain']);
  assert.equal(input.html,html);
  assert.deepEqual(scanLegacyPublicMarkers({text:'Site content publisher'}),['legacy_author']);
  assert.deepEqual(scanLegacyPublicMarkers({html:'<article data-name="LinkFlow"><p>Neutral text</p></article>'}),[]);
  assert.deepEqual(scanLegacyPublicMarkers({html:'<p>Published by LinkFlow</p>'}),['legacy_brand_token']);
  assert.deepEqual(scanLegacyPublicMarkers({html:'<script>{"softwareName":"LinkFlow"}</script>'}),['legacy_brand_token','agentriot_software_name']);
  assert.deepEqual(scanLegacyPublicMarkers({html:'<pre>{"app":"linkflow/1.0"}</pre>',url:'https://example.com/@author/linkflow-article-aabbccddeeff'}),['legacy_brand_token','hive_legacy_app','hive_legacy_permalink']);
  assert.deepEqual(scanLegacyPublicMarkers({html:'<article>Ordinary article text</article>',url:'https://example.com/post'}),[]);
});

test('early lf- slugs are recognised only at a path segment start', () => {
  for (const url of ['https://example-blog.wordpress.com/lf-1234abcd-0123456789ab/', 'https://verbose.blog/user/lf-1234abcd-0123456789ab', 'https://user.prose.sh/lf-1234abcd'])
    assert.ok(scanLegacyPublicMarkers({url}).includes('legacy_lf_slug'), url);
  for (const url of ['https://example.com/golf-tips', 'https://example.com/self-custody-guide'])
    assert.equal(scanLegacyPublicMarkers({url}).includes('legacy_lf_slug'), false, url);
});

test('a neutral author name is a legacy byline only on the platforms that used it as one', () => {
  assert.deepEqual(scanLegacyPublicMarkers({text: 'Submitted as Site publishing assistant (agent).'}, 'agentswiki'), []);
  assert.deepEqual(scanLegacyPublicMarkers({text: 'Operator: Site publishing assistant'}, 'agentboard'), []);
  assert.deepEqual(scanLegacyPublicMarkers({text: 'By Site publishing assistant'}, 'txtsbs'), ['legacy_author']);
  assert.deepEqual(scanLegacyPublicMarkers({text: 'Site content publisher'}, 'pastyx'), ['legacy_author']);
  assert.deepEqual(scanLegacyPublicMarkers({text: 'Linkflow promotional content publisher'}, 'agentswiki'), ['legacy_author', 'legacy_brand_token']);
});
