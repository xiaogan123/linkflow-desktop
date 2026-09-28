import * as nodeFs from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';

let cached:typeof nodeFs|undefined;

/** Bypass Electron's ASAR virtualization for real bundle replacement/copy/cleanup. */
export function updateRawFs():typeof nodeFs{
  if(cached)return cached;
  try{
    const runtimeRequire=createRequire(join(process.cwd(),'.linkflow-update-loader.cjs'));
    const original=runtimeRequire('original-fs') as typeof nodeFs;
    if(original?.promises&&typeof original.createReadStream==='function')return cached=original;
  }catch{}
  return cached=nodeFs;
}
