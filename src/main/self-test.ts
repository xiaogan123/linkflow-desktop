import { app, BrowserWindow, safeStorage } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import type { Controller } from './controller';

// Explicit command-line diagnostics use fresh disposable data, never the user's profile.
export function prepareSelfTest():boolean {
  if(!process.argv.includes('--linkflow-self-test'))return false;
  app.setPath('userData',mkdtempSync(join(tmpdir(),'linkflow-packaged-test-')));
  return true;
}
export async function runPackagedSelfTest(win:BrowserWindow, controller:Controller):Promise<void>{
  const checks:string[]=[];
  const check=(label:string,value:unknown)=>{assert(value,label);checks.push(label)};
  const deadline=setTimeout(()=>{console.error('PACKAGED_SELF_TEST_TIMEOUT');app.exit(1)},45000);
  try{
    if(win.webContents.isLoading())await new Promise<void>((resolve,reject)=>{
      win.webContents.once('did-finish-load',()=>resolve());
      win.webContents.once('did-fail-load',()=>reject(Error('packaged page failed to load')));
    });
    let ready=false;
    for(let i=0;i<80;i++){
      ready=await win.webContents.executeJavaScript('!!window.linkflow && !!document.querySelector("h1")').catch(()=>false);
      if(ready)break;
      await new Promise(r=>setTimeout(r,100));
    }
    check('executable is packaged',app.isPackaged);
    check('packaged window and bridge render',ready);
    check('renderer Node integration remains disabled',await win.webContents.executeJavaScript('typeof require === "undefined" && typeof process === "undefined"'));
    const snapshot=await win.webContents.executeJavaScript('window.linkflow.invoke("snapshot")');
    check('isolated profile contains no websites or accounts',snapshot.sites.length===0&&snapshot.accounts.length===0);
    check('diagnostics never start the scheduler',snapshot.settings.autoRun===false&&!controller.runtime.busy);
    check('first render does not access keychain',snapshot.runtime.vaultReady===false);
    check('reported version matches package',snapshot.runtime.version===app.getVersion());
    await win.webContents.executeJavaScript('window.linkflow.invoke("settings:save",{notify:false,dailyAiLimit:8})');
    check('packaged IPC persists settings',controller.store.read().settings.dailyAiLimit===8);
    check('private domains rejected by packaged IPC',await win.webContents.executeJavaScript('window.linkflow.invoke("site:add",{domain:"127.0.0.1",email:"test@example.com",monthlyTarget:2}).then(()=>false,()=>true)'));
    check('foreign protocols rejected',await win.webContents.executeJavaScript('window.linkflow.invoke("external:open",{url:"file:///test"}).then(()=>false,()=>true)'));
    if(process.platform==='win32'){
      const synthetic='Linkflow-native-fixture-only-7!';
      check('Windows OS encryption is available',safeStorage.isEncryptionAvailable());
      await controller.vault.set('self-test',synthetic);
      check('Windows encrypted secret roundtrip',await controller.vault.get('self-test')===synthetic);
      check('Windows encrypted secret absent from state',!JSON.stringify(controller.store.read()).includes(synthetic));
      await controller.vault.delete('self-test');
    }
    const nonce=process.env.LINKFLOW_SELF_TEST_NONCE;
    assert(nonce&&/^[a-f0-9]{32}$/.test(nonce),'test invocation nonce required');
    const result={passed:true,nonce,platform:process.platform,arch:process.arch,version:app.getVersion(),checks};
    const destination=process.env.LINKFLOW_SELF_TEST_REPORT;
    if(destination)writeFileSync(destination,JSON.stringify(result,null,2),{mode:0o600});
    console.log('PACKAGED_SELF_TEST_PASSED '+checks.length);
    clearTimeout(deadline);controller.stop();app.exit(0);
  }catch{
    clearTimeout(deadline);console.error('PACKAGED_SELF_TEST_FAILED after '+checks.length+' checks');controller.stop();app.exit(1);
  }
}
