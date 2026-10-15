import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {portableSsh2Plugin} from './lib/ssh2-bundle.mjs';

const require=createRequire(import.meta.url),root=process.cwd(),dir=mkdtempSync(path.join(tmpdir(),'linkflow-notepad-registration-'));
const contents=`import assert from 'node:assert/strict';
import path from 'node:path';
import {app} from 'electron';
import {Store,emptyState} from ${JSON.stringify(path.join(root,'src/main/store.ts'))};
import {Vault} from ${JSON.stringify(path.join(root,'src/main/vault.ts'))};
import {Controller} from ${JSON.stringify(path.join(root,'src/main/controller.ts'))};
import {CHANNELS} from ${JSON.stringify(path.join(root,'src/integrations/catalog.ts'))};
import {prepareAgentNotepadIdentity} from ${JSON.stringify(path.join(root,'src/integrations/agentnotepad-publisher.ts'))};
globalThis.fetch=async()=>{throw Error('External network forbidden')};
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{let checks=0;
for(const scenario of ['allowed','channel-disabled','site-paused','auto-run-disabled','task-skipped','abort','cipher-changed']){
 const store=new Store(path.join(${JSON.stringify(dir)},scenario+'.sqlite')),vault=new Vault(store),catalog=CHANNELS.map(value=>({...value,enabled:value.id==='agentnotepad'})),stamp=new Date().toISOString();
 const state=emptyState();state.settings.autoRun=true;state.settings.notify=false;state.settings.channelOverrides={agentnotepad:true};
 state.sites=[{id:'00000000-0000-4000-8000-000000000001',domain:'example.com',url:'https://example.com/tool',email:'owner@example.com',name:'Example tool',description:'Software tool',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp,analyzedAt:stamp,qualifications:{software:'https://example.com/tool',developer:'https://example.com/tool'}}];
 state.tasks=[{id:'00000000-0000-4000-8000-000000000002',siteId:state.sites[0].id,channelId:'agentnotepad',sourceDomain:'agentnotepad.com',status:'running',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:''}];store.update(value=>Object.assign(value,state));
 const controller=new Controller(store,vault,${JSON.stringify(dir)},{channelCatalog:catalog}),abort=new AbortController();let calls=0;store.update(value=>{value.tasks[0].status='running'});
 try{const context=(controller as any).context(store.read().tasks[0],abort.signal),save=context.saveAccount;
 context.saveAccount=async(...args:any[])=>{await save(...args);if(scenario==='abort')abort.abort();else if(scenario==='cipher-changed')await vault.set('account:'+args[0].id,'changed local intent');else store.update(value=>{if(scenario==='channel-disabled')value.settings.channelOverrides.agentnotepad=false;if(scenario==='site-paused')value.sites[0].status='paused';if(scenario==='auto-run-disabled')value.settings.autoRun=false;if(scenario==='task-skipped')value.tasks[0].status='skipped'})};
 await prepareAgentNotepadIdentity(context,{fetch:async()=>{calls++;throw Error('Synthetic lost response')}});
 assert.equal(calls,scenario==='allowed'?1:0,scenario);assert.equal(store.read().accounts.length,1);assert.equal(store.read().accounts[0].agentNotepad?.stage,'intent');checks++;
 }finally{controller.stop();store.close()}
}
console.log(JSON.stringify({passed:true,checks,physicalExternalRequests:0,platform:process.platform}));app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});`;
await build({stdin:{contents,resolveDir:root,sourcefile:'agentnotepad-registration-fixture.ts',loader:'ts'},outfile:path.join(dir,'entry.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron','cpu-features'],plugins:[portableSsh2Plugin()],target:'node22'});
const child=spawn(require('electron'),[path.join(dir,'entry.cjs'),'--user-data-dir='+path.join(dir,'profile')],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
let expired=false;const timer=setTimeout(()=>{expired=true;child.kill()},60000),code=await new Promise(resolve=>child.once('exit',resolve));clearTimeout(timer);rmSync(dir,{recursive:true,force:true});process.exitCode=expired?1:code??1;
