import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { analyzeWebsiteHtml, createPinnedLookup, fetchPublicHtml, findDirectLink, isProxyFakeDnsAddress, isPublicIpAddress, nextHtmlByteCount, normalizePublicUrl, parsePublicDnsResponse, verifyLink } from '../src/integrations/web.js';

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
  assert.equal(isProxyFakeDnsAddress('198.18.0.1'), true);
  assert.equal(isProxyFakeDnsAddress('198.19.255.254'), true);
  assert.equal(isProxyFakeDnsAddress('198.20.0.1'), false);
});

test('encrypted public DNS parser validates every address answer', () => {
  const answers = parsePublicDnsResponse(Buffer.from(JSON.stringify({
    Status: 0,
    Answer: [
      { type: 5, data: 'alias.example.' },
      { type: 1, data: '8.8.8.8' },
      { type: 28, data: '2606:4700:4700::1111' },
    ],
  })));
  assert.deepEqual(answers, [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]);
  assert.throws(() => parsePublicDnsResponse(Buffer.from(JSON.stringify({
    Status: 0,
    Answer: [{ type: 1, data: '8.8.8.8' }, { type: 1, data: '10.0.0.1' }],
  }))), /private, reserved, or malformed/);
  assert.throws(() => parsePublicDnsResponse(Buffer.from('null')), /malformed response/);
  assert.throws(() => parsePublicDnsResponse(Buffer.from(JSON.stringify({ Status: 2 }))), /status 2/);
  assert.throws(() => parsePublicDnsResponse(Buffer.from(JSON.stringify({ Status: 0, TC: true }))), /truncated/);
});

test('pinned lookup supports the all-address shape used by native HTTP requests', async () => {
  const server = http.createServer((_request, response) => response.end('native-ok'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const listening = server.address();
    assert.ok(listening && typeof listening === 'object');
    let allAddressesRequested = false;
    const pinnedLookup = createPinnedLookup({ address: '127.0.0.1', family: 4 });
    const body = await new Promise<string>((resolve, reject) => {
      const request = http.get({
        hostname: 'native-request.example',
        port: listening.port,
        lookup: (host, options, callback) => {
          allAddressesRequested ||= Boolean(options.all);
          pinnedLookup(host, options, callback);
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', reject);
      });
      request.on('error', reject);
    });
    assert.equal(body, 'native-ok');
    assert.equal(allAddressesRequested, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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

test('all fake-DNS answers use encrypted public resolution and pin a validated address', async () => {
  const calls: string[] = [];
  const result = await fetchPublicHtml('https://example.com/path', undefined, {
    resolve: async (host) => {
      calls.push(`system:${host}`);
      return [{ address: '198.18.0.1', family: 4 }, { address: '198.19.255.254', family: 4 }];
    },
    resolvePublic: async (host) => {
      calls.push(`public:${host}`);
      return [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
    },
    request: async (url, pinned) => {
      calls.push(`request:${url.hostname}:${pinned.address}`);
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<title>OK</title>') };
    },
  });
  assert.equal(result.html, '<title>OK</title>');
  assert.deepEqual(calls, ['system:example.com', 'public:example.com', 'request:example.com:8.8.8.8']);
});

test('mixed fake-DNS and private or public answers never trigger fallback', async () => {
  let fallbacks = 0;
  let requests = 0;
  const base = {
    resolvePublic: async () => { fallbacks++; return [{ address: '8.8.8.8', family: 4 }]; },
    request: async () => { requests++; return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('ok') }; },
  };
  await assert.rejects(fetchPublicHtml('https://example.com/', undefined, {
    ...base,
    resolve: async () => [{ address: '198.18.0.1', family: 4 }, { address: '10.0.0.1', family: 4 }],
  }), /private or reserved/);
  await assert.rejects(fetchPublicHtml('https://example.com/', undefined, {
    ...base,
    resolve: async () => [{ address: '198.18.0.1', family: 4 }, { address: '8.8.8.8', family: 4 }],
  }), /private or reserved/);
  assert.equal(fallbacks, 0);
  assert.equal(requests, 0);
});

test('DNS fallback, requests, and cancellation have bounded deterministic failures', async () => {
  const never = () => new Promise<never>(() => undefined);
  const response = async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('ok') });
  await assert.rejects(fetchPublicHtml('https://example.com/', undefined, {
    resolve: never,
    request: response,
    timeoutMs: 5,
  }), /DNS lookup timed out/);
  await assert.rejects(fetchPublicHtml('https://example.com/', undefined, {
    resolve: async () => [{ address: '198.18.0.1', family: 4 }],
    resolvePublic: never,
    request: response,
    timeoutMs: 5,
  }), /Encrypted public DNS timed out/);
  await assert.rejects(fetchPublicHtml('https://example.com/', undefined, {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    request: never,
    timeoutMs: 5,
  }), /Request timed out/);
  const controller = new AbortController();
  const pending = fetchPublicHtml('https://example.com/', controller.signal, {
    resolve: never,
    request: response,
    timeoutMs: 100,
  });
  controller.abort();
  await assert.rejects(pending, /Request aborted/);
});

test('redirects are resolved and pinned independently at every hop', async () => {
  const resolved: string[] = [];
  const pinned: string[] = [];
  const result = await fetchPublicHtml('https://start.example/first', undefined, {
    resolve: async (host) => {
      resolved.push(host);
      return [{ address: host === 'start.example' ? '8.8.8.8' : '9.9.9.9', family: 4 }];
    },
    request: async (url, address) => {
      pinned.push(`${url.hostname}:${address.address}`);
      if (url.hostname === 'start.example') {
        return { status: 302, headers: { location: 'https://finish.example/final' }, body: Buffer.alloc(0) };
      }
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('done') };
    },
  });
  assert.equal(result.url, 'https://finish.example/final');
  assert.deepEqual(resolved, ['start.example', 'finish.example']);
  assert.deepEqual(pinned, ['start.example:8.8.8.8', 'finish.example:9.9.9.9']);
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
  assert.equal(direct.outcome, 'found');
  assert.equal(direct.rel, 'nofollow sponsored');
  const absent = findDirectLink('<a href="/out?url=https%3A%2F%2Fmyproduct.example">Visit</a>', page, target);
  assert.equal(absent.found, false);
  assert.equal(absent.outcome, 'absent');
  assert.equal(findDirectLink('<a href="https://fake-myproduct.example">Visit</a>', page, target).found, false);
  assert.equal(findDirectLink('<template><a href="https://myproduct.example">hidden</a></template>', page, target).found, false);
});

test('verifier rejects an unrelated source before any fetch', async () => {
  const result = await verifyLink('https://unrelated.example/a', 'https://myproduct.example/', 'github.com');
  assert.equal(result.found, false);
  assert.equal(result.outcome, 'invalid');
  assert.match(result.reason, /expected channel/);
});

test('verifier distinguishes an unreachable page from an absent link', async () => {
  const unreachable = await verifyLink('https://source.example/page', 'https://target.example/', undefined, undefined, {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => { throw new Error('TLS handshake failed'); },
  });
  assert.equal(unreachable.found, false);
  assert.equal(unreachable.outcome, 'unreachable');
  assert.match(unreachable.reason, /TLS handshake failed/);

  const absent = await verifyLink('https://source.example/page', 'https://target.example/', undefined, undefined, {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<p>No link</p>') }),
  });
  assert.equal(absent.found, false);
  assert.equal(absent.outcome, 'absent');
});
