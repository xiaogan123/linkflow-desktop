import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';

/** Standalone Electron + loopback fixture; never imports or starts the production client. */
test('native local registration preserves manual completion and rejects clobbered external form actions',{timeout:60000},async t=>{
  const html=`<!doctype html><html><body>
  <form id="signup"><input id="email" type="email"><button id="register">Register</button></form>
  <form id="verify-form" hidden><input id="code"><button id="verify">Verify</button></form>
  <script>
  window.dispatches=0;window.verifications=0;
  document.querySelector('#signup').onsubmit=e=>{e.preventDefault();window.dispatches++;document.querySelector('#signup').hidden=true;document.querySelector('#verify-form').hidden=false;};
  document.querySelector('#verify-form').onsubmit=e=>{e.preventDefault();window.verifications++;if(document.querySelector('#code').value==='123456'){document.querySelector('#verify-form').hidden=true;document.body.insertAdjacentHTML('beforeend','<div id="success">Ready</div><pre id="key">mock-local-api-key</pre>');}};
  </script></body></html>`;
  const server=createServer((_request,response)=>{response.writeHead(200,{'Content-Type':'text/html'});response.end(html);});
  const bound=await new Promise<Error|undefined>(resolve=>{server.once('error',resolve);server.listen(0,'127.0.0.1',()=>resolve(undefined));});
  if(bound){server.close();if(['EPERM','EACCES'].includes((bound as NodeJS.ErrnoException).code??'')){t.skip('Sandbox denies loopback HTTP listen; native local-server evidence unavailable. Deterministic executor and DOM adapter tests run separately.');return;}throw bound;}
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();assert(address&&typeof address==='object');
  const dir=await mkdtemp(path.join(tmpdir(),'linkflow-signup-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const root=process.cwd(),entry=path.join(dir,'entry.cjs'),resultPath=path.join(dir,'result.json');
  // The only emitted code is a private temporary standalone fixture.
  await build({entryPoints:[path.join(root,'tests/fixtures/signup-native.ts')],outfile:entry,bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node22',logLevel:'silent'});
  const require=createRequire(import.meta.url);let output='';
  const child=spawn(require('electron'),[entry,JSON.stringify({dir,origin:`http://127.0.0.1:${address.port}`,resultPath})],{env:{...process.env,ELECTRON_RUN_AS_NODE:undefined},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',value=>{output+=String(value);});child.stderr.on('data',value=>{output+=String(value);});
  const timer=setTimeout(()=>child.kill(),45000);const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timer);
  assert.equal(code,0,output.slice(-6000));
  const {readFile}=await import('node:fs/promises');assert.deepEqual(JSON.parse(await readFile(resultPath,'utf8')),{passed:true,externalRequests:0,scenarios:6});
});
