import test from 'node:test';
import assert from 'node:assert/strict';
import {shiplyPublisherTesting} from '../src/integrations/shiply-publisher';
const original='<!doctype html><html><head><title>Guide</title><meta name="description" content="Original guide"></head><body><main><article><h1>Guide</h1><section><p>Read the <a href="https://example.com/guide" rel="ugc nofollow">guide</a>.</p></section></article></main></body></html>';
const badge='<a href="https://shiply.now/?ref=badge" target="_blank" rel="noopener" style="position:fixed;bottom:8px;right:8px;z-index:2147483646;background:rgba(23,23,23,.85);color:#fff;font:12px/1 -apple-system,sans-serif;padding:6px 10px;border-radius:6px;text-decoration:none">Published with shiply →</a>';
const beacon=`<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/v${'a'.repeat(40)}" integrity="sha512-${'A'.repeat(86)}==" data-cf-beacon='{"version":"2024.11.0","token":"${'a'.repeat(32)}","r":1,"spa":2}' crossorigin="anonymous"></script>`;
const append=(suffix:string)=>original.replace('</body>',suffix+'</body>');
test('unchanged body accepts documented separate badge and module beacon, with safe metadata',()=>{for(const suffix of ['',badge,beacon,badge+'\n'+beacon])assert.equal(shiplyPublisherTesting.exactPublicHtmlWithShiplyHead(append(suffix).replace('</head>','<meta property="og:title" content="Guide"></head>'),original),true)});
test('unchanged exact article bytes remain mandatory despite known hosting additions',()=>{for(const changed of [append(badge+beacon).replace('Read the','Altered text: read the'),append(badge+beacon).replace('https://example.com/guide','https://other.example/'),append(badge+beacon).replace('<main>','<main hidden>'),append(badge+beacon).replace('</section>','<p>New text</p></section>')])assert.equal(shiplyPublisherTesting.exactPublicHtmlWithShiplyHead(changed,original),false)});
test('arbitrary scripts, executable badge attributes and unknown additions are rejected',()=>{const invalid=[badge+beacon+beacon,badge+badge,beacon+badge,badge.replace('ref=badge','ref=other'),badge.replace('noopener','opener'),badge.replace('bottom:8px','top:0;height:100vh;width:100vw'),badge.replace('target="_blank"','onclick="fetch(\'/secret\')" target="_blank"'),badge.replace('Published with shiply →','<span>Published with shiply →</span>'),beacon.replace('static.cloudflareinsights.com','static.cloudflareinsights.com.evil.example'),beacon.replace('</script>','alert(1)</script>'),beacon.replace('type="module"','type="module" onload="alert(1)"'),beacon.replace('"r":1','"r":2'),beacon.replace('"spa":2','"spa":2,"extra":"x"'),beacon.replace('crossorigin="anonymous"','crossorigin="use-credentials"'),beacon.replace('beacon.min.js/','beacon.min.js?x=/'),beacon.replace('sha512-','sha256-'),'<div>Extra content</div>','<!-- unexpected -->',badge+'extra visible text'];for(const suffix of invalid)assert.equal(shiplyPublisherTesting.exactPublicHtmlWithShiplyHead(append(suffix),original),false,suffix.slice(0,120))});
test('known beacon cannot hide in head, original body, or replace original close boundary',()=>{for(const changed of [original.replace('</head>',beacon+'</head>'),original.replace('<main>',beacon+'<main>'),original.replace('</main>',beacon+'</main>'),append(badge+beacon).replace('</body>','</body><script></script>')])assert.equal(shiplyPublisherTesting.exactPublicHtmlWithShiplyHead(changed,original),false)});

test('discarded document tags, duplicate attributes and incomplete closing tags cannot evade suffix validation',()=>{
  const invalid=[
    '<body onload="alert(1)">'+badge+beacon,
    '<html onload="alert(1)">'+badge+beacon,
    '<body style="filter:blur(10px)">'+badge+beacon,
    '<head>'+badge+beacon,
    badge.replace('Published with shiply →','<body onload="alert(1)">Published with shiply →'),
    badge.replace('target="_blank"','target="_blank" target="_self"'),
    badge.replace('</a>',''),
    beacon.replace('</script>',''),
    badge+beacon+'</html>',
  ];
  for(const suffix of invalid)assert.equal(shiplyPublisherTesting.exactPublicHtmlWithShiplyHead(append(suffix),original),false,suffix.slice(0,100));
  for(const tag of ['body','html'])assert.equal(shiplyPublisherTesting.exactPublicHtmlWithShiplyHead(append(badge+beacon).replace('</html>','<'+tag+' onload="alert(1)"></html>'),original),false);
});
