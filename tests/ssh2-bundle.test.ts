import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
// @ts-expect-error Build scripts intentionally remain standalone JavaScript modules.
import {portableSsh2Plugin} from '../scripts/lib/ssh2-bundle.mjs';

const require = createRequire(import.meta.url);
const constantsPath = require.resolve('ssh2/lib/protocol/constants.js');
const constantsRequire = createRequire(constantsPath);
type Load = (args: {path: string}) => Promise<{contents: string}>;
function loader() {
  let load!: Load;
  let filter!: RegExp;
  portableSsh2Plugin().setup({onLoad(options: {filter: RegExp}, handler: Load) {filter = options.filter; load = handler;}});
  return {load, filter};
}
function evaluate(contents: string, provider: typeof crypto) {
  const module = {exports: {} as {eddsaSupported: boolean}};
  runInNewContext(contents, {module, Buffer, require: (id: string) => id === 'crypto' ? provider : constantsRequire(id)});
  return module.exports;
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
