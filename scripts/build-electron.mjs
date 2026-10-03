import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {chmodSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
await build({entryPoints:['src/main/main.ts'],outfile:'dist-electron/main.cjs',bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron'],sourcemap:false});
await build({entryPoints:['src/main/preload.ts'],outfile:'dist-electron/preload.cjs',bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron']});

await build({entryPoints:['src/main/update-helper.ts'],outfile:'dist-electron/update-helper.cjs',bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron']});

if(process.platform==='darwin'){
  if(process.arch!=='arm64')throw Error('The macOS update quarantine helper must be built natively on Apple Silicon.');
  const directory='dist-native',output=join(directory,'linkflow-update-quarantine-probe');
  mkdirSync(directory,{recursive:true});rmSync(output,{force:true});
  execFileSync('/usr/bin/clang',['-Os','-Wall','-Wextra','-Werror','-arch','arm64','-mmacosx-version-min=14.0','-Wl,-dead_strip','src/native/update-quarantine-probe.c','-o',output],{stdio:'inherit'});
  chmodSync(output,0o755);
}
