import assert from 'node:assert/strict';
import test from 'node:test';
import {exactMDSharePublicUrl,mdshareProductionAllowlist} from '../src/integrations/mdshare-native-policy';

const publicUrl='https://mdshare.org/s/Ab3dEf6hIj9K';
const exactV8Scripts=[
  '/assets/Collapse-BgrPcfu1.js',
  '/assets/Controls-CkwmlZkF.js',
  '/assets/EmbedModal-CTRLpDHS.js',
  '/assets/Layout-BpoWnYcX.js',
  '/assets/Preview-DN7QZBZv.js',
  '/assets/ReadingMenu-Di2S-GkJ.js',
  '/assets/Reveal-BoX4Igcg.js',
  '/assets/StatTile-BdpWnsPs.js',
  '/assets/SwapFade-serKlBfv.js',
  '/assets/Tabs-ygrpMWxd.js',
  '/assets/TiltCard-BfQomT8r.js',
  '/assets/TruncatedText-CRoeQeE3.js',
  '/assets/UserPicker-BZnzRRrJ.js',
  '/assets/ViewerPage-BuZTxUFZ.js',
  '/assets/dist-j6OMAjqb.js',
  '/assets/wasm-BnjxR4X6.js',
  '/assets/github-dark-C-LZuMrd.js',
  '/assets/github-light-EUqPIrTm.js',
  '/assets/json-DAgxKhMr.js',
  '/assets/languages-BxbZXZE_.js',
  '/assets/markdown-L84MfFBT.js',
  '/assets/stateKind-BnTMIeJ2.js',
  '/assets/syntax-B0KuvG8F.js',
  '/assets/workspaceIcons-CDwFvAr7.js',
];
const exactV8Styles=[
  '/assets/Tabs-Bhz15TE7.css',
  '/assets/Layout-yp_jWhVI.css',
  '/assets/Controls-BwCdiLCz.css',
  '/assets/Preview-B_HojRFr.css',
  '/assets/StatTile-CYcLRw30.css',
  '/assets/ReadingMenu-Cf-hGyFx.css',
  '/assets/EmbedModal-Dk8599h-.css',
  '/assets/ViewerPage-DVLxKoAi.css',
  '/assets/Workspaces-C9RTTlTv.css',
];

test('V8 admits the exact viewer closure without an origin or asset wildcard',()=>{
  const allowlist=mdshareProductionAllowlist(publicUrl,'https://mdshare.org');
  const urls=allowlist.map(value=>value.url);
  assert.equal(allowlist.length,55);
  assert.equal(new Set(urls).size,allowlist.length);
  for(const pathname of exactV8Scripts){
    const item=allowlist.find(value=>value.url===`https://mdshare.org${pathname}`);
    assert.deepEqual(item?.resourceTypes,['script','other']);
  }
  for(const pathname of exactV8Styles){
    const item=allowlist.find(value=>value.url===`https://mdshare.org${pathname}`);
    assert.deepEqual(item?.resourceTypes,['stylesheet','other']);
  }
  assert.equal(urls.some(value=>value.includes('*')),false);
  assert.equal(urls.some(value=>value.startsWith('http://')),false);
  assert.deepEqual(allowlist.filter(value=>new URL(value.url).pathname.startsWith('/api/')).map(value=>value.url),[
    'https://mdshare.org/api/v1/status',
    'https://mdshare.org/api/v1/auth/me',
    'https://mdshare.org/api/v1/theme-effects',
    'https://mdshare.org/api/v1/snippets/Ab3dEf6hIj9K',
    'https://mdshare.org/api/v1/snippets/Ab3dEf6hIj9K/comments',
    'https://mdshare.org/api/v1/snippets/Ab3dEf6hIj9K/revisions',
    'https://mdshare.org/api/v1/snippets/Ab3dEf6hIj9K/stats',
    'https://mdshare.org/api/v1/snippets/Ab3dEf6hIj9K/related',
  ]);
});

test('V8 still rejects route drift, query strings and wrong resource types',()=>{
  const allowlist=mdshareProductionAllowlist(publicUrl,'https://mdshare.org');
  const viewer=allowlist.find(value=>value.url.endsWith('/ViewerPage-BuZTxUFZ.js'));
  assert.ok(viewer);
  assert.equal(allowlist.some(value=>value.url.endsWith('/ViewerPage-BuZTxUFZ.js?changed=1')),false);
  assert.equal(allowlist.some(value=>value.url.endsWith('/ViewerPage-unknown.js')),false);
  assert.equal(viewer.resourceTypes.includes('xhr'),false);
  assert.equal(exactMDSharePublicUrl(`${publicUrl}?changed=1`),false);
});
