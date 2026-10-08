import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {build, type BuildOptions, type Plugin} from 'esbuild';
// @ts-expect-error Build scripts intentionally remain standalone JavaScript modules.
import {portableSsh2Plugin} from '../scripts/lib/ssh2-bundle.mjs';

const require = createRequire(import.meta.url);
const constantsPath = require.resolve('ssh2/lib/protocol/constants.js');
const constantsRequire = createRequire(constantsPath);
const installedSsh2Root = dirname(require.resolve('ssh2/package.json'));
const dependencyRoot = dirname(installedSsh2Root);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type Load = (args: {path: string}) => Promise<{contents: string}>;
function loader() {
  const registrations: Array<{filter: RegExp; namespace?: string; load: Load}> = [];
  portableSsh2Plugin().setup({
    onResolve() {},
    onLoad(options: {filter: RegExp; namespace?: string}, handler: Load) {
      registrations.push({filter: options.filter, namespace: options.namespace, load: handler});
    }
  });
  const registration = registrations.find(({filter, namespace}) => !namespace && filter.test(constantsPath));
  assert(registration);
  return registration;
}
function evaluate(contents: string, provider: typeof crypto) {
  const module = {exports: {} as {eddsaSupported: boolean}};
  runInNewContext(contents, {module, Buffer, require: (id: string) => id === 'crypto' ? provider : constantsRequire(id)});
  return module.exports;
}

interface CryptoFixture {
  dir: string;
  entry: string;
  outfile: string;
  addon: string;
}

async function cryptoFixture(withAddon: boolean): Promise<CryptoFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'linkflow-ssh-crypto-'));
  const ssh2Root = join(dir, 'node_modules', 'ssh2');
  await cp(installedSsh2Root, ssh2Root, {recursive: true});
  const addon = join(ssh2Root, 'lib', 'protocol', 'crypto', 'build', 'Release', 'sshcrypto.node');
  if (withAddon) {
    await mkdir(dirname(addon), {recursive: true});
    await writeFile(addon, 'not-a-real-native-addon');
  }
  const entry = join(dir, 'entry.cjs');
  await writeFile(entry, `module.exports = require(${JSON.stringify(join(ssh2Root, 'lib', 'protocol', 'crypto.js'))});\n`);
  return {dir, entry, outfile: join(dir, 'bundle.cjs'), addon};
}

function cryptoBuildOptions(fixture: CryptoFixture, plugins: Plugin[] = []): BuildOptions {
  return {
    entryPoints: [fixture.entry],
    outfile: fixture.outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['cpu-features'],
    nodePaths: [dependencyRoot],
    plugins,
    metafile: true,
    logLevel: 'silent'
  };
}

async function assertPortableCryptoBundle(withAddon: boolean): Promise<void> {
  const fixture = await cryptoFixture(withAddon);
  try {
    const result = await build(cryptoBuildOptions(fixture, [portableSsh2Plugin()]));
    assert(result.metafile);
    assert(!Object.keys(result.metafile.inputs).some((path) => path.endsWith('.node')));
    const artifact = await readFile(fixture.outfile, 'utf8');
    assert(!artifact.includes('sshcrypto.node'));
    const bundledCrypto = require(fixture.outfile) as {
      bindingAvailable: boolean;
      init: Promise<void>;
      CIPHER_INFO: Record<string, unknown>;
      createCipher: unknown;
      createDecipher: unknown;
    };
    assert.equal(bundledCrypto.bindingAvailable, false);
    await bundledCrypto.init;
    assert(bundledCrypto.CIPHER_INFO['aes256-gcm@openssh.com']);
    assert.equal(typeof bundledCrypto.createCipher, 'function');
    assert.equal(typeof bundledCrypto.createDecipher, 'function');
  } finally {
    await rm(fixture.dir, {recursive: true, force: true});
  }
}

test('portable SSH probe removes the embedded test key and still checks real Ed25519 signing', async () => {
  const {load, filter} = loader();
  assert(filter.test('/node_modules/ssh2/lib/protocol/constants.js'));
  assert(filter.test('C:\\node_modules\\ssh2\\lib\\protocol\\constants.js'));
  assert(!filter.test('/unrelated/protocol/constants.js'));
  const marker = new RegExp('-----BEGIN ' + '(?:RSA |EC |OPENSSH )?PRIVATE KEY-----');
  assert(marker.test(await readFile(constantsPath, 'utf8')));
  const {contents} = await load({path: constantsPath});
  assert(!marker.test(contents));
  assert.equal(evaluate(contents, crypto).eddsaSupported, true);
  const failedProvider = {...crypto, generateKeyPairSync() {throw new Error('Unavailable');}} as typeof crypto;
  assert.equal(evaluate(contents, failedProvider).eddsaSupported, false);
});

test('portable SSH build rejects an unreviewed dependency change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linkflow-ssh-probe-'));
  try {
    const path = join(dir, 'constants.js');
    await writeFile(path, (await readFile(constantsPath, 'utf8')) + '\n// dependency changed\n');
    await assert.rejects(loader().load({path}), /capability probe changed/);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('portable SSH build rejects the addon-present fixture before the targeted fallback', async () => {
  const fixture = await cryptoFixture(true);
  try {
    await assert.rejects(build(cryptoBuildOptions(fixture)), (error: unknown) => {
      const errors = (error as {errors?: Array<{text: string}>}).errors ?? [];
      assert.equal(errors.length, 1);
      assert.match(errors[0].text, /No loader is configured for "\.node" files/);
      assert.match(errors[0].text, /sshcrypto\.node/);
      return true;
    });
  } finally {
    await rm(fixture.dir, {recursive: true, force: true});
  }
});

test('portable SSH build uses the JavaScript crypto path with and without the optional addon', async () => {
  await assertPortableCryptoBundle(true);
  await assertPortableCryptoBundle(false);
});

test('portable SSH build does not hide native addons outside the exact ssh2 crypto importer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linkflow-unrelated-addon-'));
  try {
    const addon = join(dir, 'crypto', 'build', 'Release', 'sshcrypto.node');
    await mkdir(dirname(addon), {recursive: true});
    await writeFile(addon, 'not-a-real-native-addon');
    const entry = join(dir, 'other.js');
    await writeFile(entry, "module.exports = require('./crypto/build/Release/sshcrypto.node');\n");
    await assert.rejects(build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      plugins: [portableSsh2Plugin()],
      logLevel: 'silent'
    }), /No loader is configured for "\.node" files/);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('portable SSH plugin builds the real Prose transport without a native crypto dependency', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linkflow-prose-transport-bundle-'));
  try {
    const outfile = join(dir, 'prose-transport.cjs');
    const result = await build({
      entryPoints: [join(repoRoot, 'src', 'integrations', 'prose-transport.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['cpu-features'],
      plugins: [portableSsh2Plugin()],
      metafile: true,
      logLevel: 'silent'
    });
    assert(result.metafile);
    assert(!Object.keys(result.metafile.inputs).some((path) => path.endsWith('.node')));
    assert(!(await readFile(outfile, 'utf8')).includes('sshcrypto.node'));
    const transport = require(outfile) as Record<string, unknown>;
    assert.equal(typeof transport.createProseTransport, 'function');
    assert.equal(typeof transport.createProseTransportForTests, 'function');
    assert.equal(typeof transport.ProseTransportError, 'function');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
