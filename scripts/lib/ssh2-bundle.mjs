import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {dirname} from 'node:path';

// ssh2 1.17.0 embeds a public test key in its Ed25519 capability probe.
// Generate an ephemeral probe key instead so distributed code contains no private keys.
// Fail closed when the dependency changes: this transformation must be reviewed again.
const constantsSha256 = 'a3894fdd8e294109b55f06fbda69e467741f15a250801b744b6b0487bbf32529';
const probe = `const eddsaSupported = (() => {
  if (typeof crypto.sign === 'function'
      && typeof crypto.verify === 'function'
      && typeof crypto.generateKeyPairSync === 'function') {
    const data = Buffer.from('a');
    let sig;
    let verified;
    try {
      const {privateKey, publicKey} = crypto.generateKeyPairSync('ed25519');
      sig = crypto.sign(null, data, privateKey);
      verified = crypto.verify(null, data, publicKey, sig);
    } catch {}
    return (Buffer.isBuffer(sig) && sig.length === 64 && verified === true);
  }
  return false;
})();`;

export function portableSsh2Plugin() {
  return {
    name: 'portable-ssh2-probe',
    setup(build) {
      build.onLoad({filter: /[\\/]ssh2[\\/]lib[\\/]protocol[\\/]constants\.js$/}, async ({path}) => {
        const source = await readFile(path, 'utf8');
        if (createHash('sha256').update(source).digest('hex') !== constantsSha256) {
          throw new Error('ssh2 capability probe changed; review the portable bundle transformation.');
        }
        const start = source.indexOf('const eddsaSupported = (() => {');
        const end = source.indexOf('\n})();', start) + '\n})();'.length;
        if (start < 0 || end <= start) throw new Error('ssh2 capability probe not found.');
        return {contents: source.slice(0, start) + probe + source.slice(end), loader: 'js', resolveDir: dirname(path)};
      });
    },
  };
}
