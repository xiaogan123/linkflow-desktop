import { spawn } from 'node:child_process';
import { mkdtemp,mkdir,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electron from 'electron';
await mkdir('.evidence',{recursive:true});
for(const entry of ['scripts/smoke-entry.cjs','scripts/smoke-manual-channel.cjs']){
  const dir=await mkdtemp(join(tmpdir(),'linkflow-smoke-'));
  const child=spawn(electron,[entry],{cwd:process.cwd(),env:{...process.env,LINKFLOW_DATA_DIR:dir,ELECTRON_DISABLE_SECURITY_WARNINGS:'false'},stdio:'inherit'});
  const code=await new Promise(resolve=>{let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;child.kill()},90000);child.on('error',()=>{clearTimeout(timeout);resolve(1)});child.on('exit',code=>{clearTimeout(timeout);resolve(timedOut?1:code??1)})});
  if(code!==0){process.exitCode=code;break}
}
