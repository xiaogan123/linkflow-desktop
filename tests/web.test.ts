import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeWebsiteHtml, fetchPublicHtml, findDirectLink, isPublicIpAddress, nextHtmlByteCount, normalizePublicUrl, verifyLink } from '../src/integrations/web.js';

test('public URL parser rejects SSRF primitives and credentials', () => {
  for (const address of [
    'http://127.0.0.1/', 'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/', 'http://[fc00::1]/', 'http://2130706433/',
    'http://localhost/', 'http://host.local/', 'https://user:pass@example.com/',
    'file:///etc/passwd', 'https://example.com:8443/',
  ]) assert.throws(() => normalizePublicUrl(address), address);
  assert.equal(normalizePublicUrl('example.com/path#frag').href, 'https://example.com/path');
});

test('IP classifier rejects private and transition addresses', () => {
  for (const ip of ['0.0.0.0','10.0.0.1','100.64.0.1','127.0.0.1','169.254.1.1','172.31.1.1','192.168.0.1','198.18.0.1','203.0.113.1','::1','fc00::1','fe80::1','2001:db8::1','2001:0db8::1','2001:0000::1','2002:c0a8:0101::1','::ffff:192.168.1.1']) {
    assert.equal(isPublicIpAddress(ip), false, ip);
  }
  assert.equal(isPublicIpAddress('8.8.8.8'), true);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
});

test('HTML size cap stops at one million bytes', () => {
  assert.equal(nextHtmlByteCount(999_999, 1), 1_000_000);
  assert.throws(() => nextHtmlByteCount(999_999, 2), /size limit/);
});

test('injected transport still enforces DNS, redirect and body guards', async () => {
  let requests = 0;
  const safe = {
    resolve: async () => [{ address:'8.8.8.8', family:4 }],
    request: async () => { requests++; return { status:200, headers:{'content-type':'text/html'}, body:Buffer.from('<title>OK</title>') }; },
  };
  assert.equal((await fetchPublicHtml('https://example.com/', undefined, safe)).html, '<title>OK</title>');
  await assert.rejects(fetchPublicHtml('https://example.com/', undefined, { ...safe, resolve: async () => [{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}] }), /private or reserved/);
  assert.equal(requests, 1);
  await assert.rejects(fetchPublicHtml('https://example.com/', undefined, { ...safe, request: async () => ({ status:302, headers:{location:'http://127.0.0.1/'}, body:Buffer.alloc(0) }) }), /Private or reserved/);
  await assert.rejects(fetchPublicHtml('https://example.com/', undefined, { ...safe, request: async () => ({ status:200, headers:{'content-type':'text/html'}, body:Buffer.alloc(1_000_001) }) }), /size limit/);
  await assert.rejects(fetchPublicHtml('https://example.com/', undefined, { ...safe, request: async () => ({ status:200, headers:{'content-type':'application/json'}, body:Buffer.from('{}') }) }), /not HTML/);
});

test('metadata analysis is deterministic and falls back honestly', () => {
  const analyzed = analyzeWebsiteHtml('<html lang="en-US"><head><title>Pixel Studio | Portfolio</title><meta name="description" content="UX design for teams"></head></html>', 'https://www.pixel.example/');
  assert.equal(analyzed.name, 'Pixel Studio');
  assert.equal(analyzed.category, 'design');
  assert.equal(analyzed.language, 'en-us');
  assert.equal(analyzed.domain, 'pixel.example');
  assert.equal(analyzeWebsiteHtml('<html></html>', 'https://example.com/').language, 'und');
});

test('link parser requires a direct anchor to the exact target host', () => {
  const page = 'https://directory.example/product/1';
  const target = 'https://www.myproduct.example/';
  const direct = findDirectLink('<a rel="nofollow sponsored" href="https://myproduct.example/start">Visit</a>', page, target);
  assert.equal(direct.found, true);
  assert.equal(direct.rel, 'nofollow sponsored');
  assert.equal(findDirectLink('<a href="/out?url=https%3A%2F%2Fmyproduct.example">Visit</a>', page, target).found, false);
  assert.equal(findDirectLink('<a href="https://fake-myproduct.example">Visit</a>', page, target).found, false);
  assert.equal(findDirectLink('<template><a href="https://myproduct.example">hidden</a></template>', page, target).found, false);
});

test('verifier rejects an unrelated source before any fetch', async () => {
  const result = await verifyLink('https://unrelated.example/a', 'https://myproduct.example/', 'github.com');
  assert.equal(result.found, false);
  assert.match(result.reason, /expected channel/);
});
