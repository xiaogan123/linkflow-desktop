import {build} from 'esbuild';
await build({entryPoints:['src/main/main.ts'],outfile:'dist-electron/main.cjs',bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron'],sourcemap:false});
await build({entryPoints:['src/main/preload.ts'],outfile:'dist-electron/preload.cjs',bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron']});

