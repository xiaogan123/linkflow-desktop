import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createPrivateKey, generateKeyPairSync} from 'node:crypto';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const privacyKeysPath = require.resolve('../scripts/lib/privacy-keys.mjs');
const {hasPrivateKeyMaterial} = require(privacyKeysPath);
const header = (kind = '') => '-----BEGIN ' + kind + 'PRIVATE KEY-----';

test('key detection catches real plain and encrypted private material in source representations', () => {
  const rsa = generateKeyPairSync('rsa', {modulusLength: 1024}).privateKey;
  const ec = generateKeyPairSync('ec', {namedCurve: 'prime256v1'}).privateKey;
  const ed = generateKeyPairSync('ed25519').privateKey;
  const keys = [
    rsa.export({type: 'pkcs1', format: 'pem'}).toString(),
    ec.export({type: 'sec1', format: 'pem'}).toString(),
    ed.export({type: 'pkcs8', format: 'pem'}).toString(),
    ed.export({type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'test-only'}).toString(),
    rsa.export({type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'test-only'}).toString(),
  ];
  for (const key of keys) {
    const lines = key.trim().split('\n');
    for (const encoded of [key, JSON.stringify(key), JSON.stringify(JSON.stringify(key)), key.replaceAll('\n', '\\u000a'), key.replaceAll('\n', '\\x0a'), lines.map(line => JSON.stringify(line + '\n')).join(' /* fragment */ +\n ')]) {
      assert.equal(hasPrivateKeyMaterial(encoded), true, 'Private material must block without echoing it');
    }
  }
});

test('key detection retains short truncated bodies and extra private-key formats', () => {
  for (const kind of ['', 'RSA ', 'EC ', 'DSA ', 'OPENSSH ', 'ENCRYPTED ']) {
    assert.equal(hasPrivateKeyMaterial(header(kind) + '\nAbCd'), true);
    assert.equal(hasPrivateKeyMaterial(JSON.stringify(header(kind) + '\nAbCd')), true);
  }
});

test('format-only regexes and dynamic output templates do not contain private material', () => {
  for (const value of [header(), 'let output = ' + JSON.stringify(header('OPENSSH ') + '\n') + ';', 'const key = ' + JSON.stringify(header() + '\n') + ' + encodedBody;', 'const parser = /^' + header('OPENSSH ') + '(?:\\r\\n|\\n)([\\s\\S]+)$/;']) {
    assert.equal(hasPrivateKeyMaterial(value), false);
  }
});

test('legal JSON slash escapes and narrow PEM lines retain private-key detection', () => {
  let key = '';
  for (let attempt = 0; attempt < 64; attempt++) {
    key = generateKeyPairSync('ed25519').privateKey.export({type: 'pkcs8', format: 'pem'}).toString();
    if (key.split('\n')[1].includes('/')) break;
  }
  assert(key.split('\n')[1].includes('/'));
  const escaped = JSON.stringify(key).replaceAll('/', '\\/');
  assert.equal(JSON.parse(escaped), key);
  assert.equal(hasPrivateKeyMaterial(escaped), true);
  assert.equal(hasPrivateKeyMaterial(JSON.stringify(escaped)), true);
  const lines = key.trim().split('\n');
  const body = lines.slice(1, -1).join('');
  for (const width of [1, 2, 3]) {
    const chunks = body.match(new RegExp('.{1,' + width + '}', 'g'))!;
    const narrow = [lines[0], ...chunks, lines.at(-1)].join('\n');
    assert.equal(createPrivateKey(narrow).asymmetricKeyType, 'ed25519');
    assert.equal(hasPrivateKeyMaterial(narrow), true);
  }
});

test('key detection stays bounded after many closed comments and reaches later private material', () => {
  const script = `const {hasPrivateKeyMaterial}=require(${JSON.stringify(privacyKeysPath)});`
    + `const input='"'+'/*x*/'.repeat(64)+'x'+${JSON.stringify(header() + '\nAbCd')};`
    + `process.stdout.write(String(hasPrivateKeyMaterial(input)));`;
  const result = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 2_000});
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'true');
});
