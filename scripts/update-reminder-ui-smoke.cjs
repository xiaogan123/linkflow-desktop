const {join}=require('node:path');
const {mkdtempSync,writeFileSync,mkdirSync}=require('node:fs');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
if(!process.versions.electron){
 (async()=>{const dir=mkdtempSync(join(tmpdir(),'linkflow-reminder-ui-')),root=process.cwd();
 await require('esbuild').build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import App from ${JSON.stringify(join(root,'src/ui/App.tsx'))};import {demoSnapshot} from ${JSON.stringify(join(root,'src/ui/demo.ts'))};import ${JSON.stringify(join(root,'src/ui/styles.css'))};window.fixtureSnapshot=()=>({...demoSnapshot,demo:false,runtime:{...demoSnapshot.runtime,platform:'win32',version:'1.2.29',busy:false},settings:{...demoSnapshot.settings,autoRun:false}});createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:root,loader:'tsx'},outfile:join(dir,'ui.js'),bundle:true,platform:'browser',jsx:'automatic'});
 writeFileSync(join(dir,'index.html'),'<html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
 writeFileSync(join(dir,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('linkflow',{invoke:(name)=>ipcRenderer.invoke('fixture',name),onChange:()=>()=>{},onUpdate:callback=>{const listener=(_e,state)=>callback(state);ipcRenderer.on('fixture-update',listener);return()=>ipcRenderer.removeListener('fixture-update',listener)}});`);
 const child=require('node:child_process').spawn(require('electron'),[__filename,dir],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});const timer=setTimeout(()=>child.kill(),60000);child.once('exit',code=>{clearTimeout(timer);process.exitCode=code??1});
 })().catch(e=>{console.error(e.message);process.exitCode=1});
}else{
 const {app,BrowserWindow,ipcMain}=require('electron');const dir=process.argv[2];app.setPath('userData',join(dir,'profile'));let win,state={phase:'idle',currentVersion:'1.2.29'},calls=[];const checks=[],failures=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
 // Read-only IPC the shell may issue: the first snapshot, the local update status, and the one-time renderer readiness acknowledgement ('app:ready', answered true like main.ts does).
 const readOnly=['snapshot','app:update-status','app:ready'],onlyReads=()=>calls.every(n=>readOnly.includes(n))&&calls.filter(n=>n==='app:ready').length===1;
 // Every check runs; a failed check is recorded and the run exits non-zero at the end, so one product regression does not hide the rest.
 const evaluate=js=>win.webContents.executeJavaScript(js,true),check=(label,ok)=>{if(ok)checks.push(label);else{failures.push(label);console.error('FAILED: '+label)}};
 const click=async(text,scope='body')=>{assert(await evaluate(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.innerText.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`),'click '+text+' in '+scope);await delay(100)};
 const emit=async next=>{state={currentVersion:'1.2.29',...next};win.webContents.send('fixture-update',state);await delay(100)};
 // The redesigned shell (batch 7a) shows update news as a compact sidebar notice ".sidebar-update" with a "查看" button; the update center now lives under 设置 → 更新.
 const notice='document.querySelector(".sidebar-update")',noticeText=`(${notice}?.innerText??"")`,centerText='(document.querySelector(".update-center-page")?.innerText??"")';
 ipcMain.handle('fixture',async(_e,name)=>{calls.push(name);if(name==='snapshot')return evaluate('window.fixtureSnapshot()');if(name==='app:update-status')return state;if(name==='app:ready')return true;throw Error('Unexpected fixture mutation '+name)});
 app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:1100,height:820,show:false,webPreferences:{preload:join(dir,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});await win.loadFile(join(dir,'index.html'));await delay(250);
 check('initial render reads local status without issuing update mutations',calls.includes('app:update-status')&&onlyReads()&&!await evaluate(`!!${notice}`));
 await emit({phase:'available',targetVersion:'1.2.30'});check('new version appears in the persistent sidebar notice with a way to open it',await evaluate(`${noticeText}.includes("1.2.30")&&[...${notice}.querySelectorAll("button")].some(b=>b.innerText.trim()==="查看")`));
 const output=join(process.cwd(),'.evidence/update-reminder');mkdirSync(output,{recursive:true});writeFileSync(join(output,'available.png'),(await win.webContents.capturePage()).toPNG());
 await click('网站','.sidebar nav');check('sidebar notice stays visible while browsing other pages',await evaluate(`!!document.querySelector(".page.sites-page")&&!document.querySelector(".update-center-page")&&${noticeText}.includes("1.2.30")`));
 await emit({phase:'available',targetVersion:'1.2.30'});check('same version re-announced keeps a single notice',await evaluate(`document.querySelectorAll(".sidebar-update").length===1&&${noticeText}.includes("1.2.30")`));
 await emit({phase:'available',targetVersion:'1.2.31'});check('later version replaces the notice version',await evaluate(`${noticeText}.includes("1.2.31")&&!${noticeText}.includes("1.2.30")`));
 await click('查看','.sidebar-update');check('notice opens the real update center (设置 → 更新) without auto downloading',await evaluate(`!!document.querySelector(".settings-update-content .update-center-page")&&document.querySelector("#setting-tab-update")?.getAttribute("aria-selected")==="true"&&${centerText}.includes("1.2.31")&&${centerText}.includes("新版本可以下载")`)&&onlyReads());
 await emit({phase:'prepared',targetVersion:'1.2.31'});check('update center receives authoritative progress events',await evaluate(`${centerText}.includes("更新已下载并验证")&&${noticeText}.includes("1.2.31")`));
 await click('总览','.sidebar nav');check('prepared update stays announced across app navigation',await evaluate(`!!document.querySelector(".page.overview")&&!document.querySelector(".update-center-page")&&${noticeText}.includes("1.2.31")`));
 await emit({phase:'failed',targetVersion:'1.2.31',retryable:true,error:'private diagnostic not copied to banner'});check('failure keeps the notice without copying the private diagnostic outside the update center',await evaluate(`${noticeText}.includes("1.2.31")&&!document.body.innerText.includes("private diagnostic")`));
 await click('查看','.sidebar-update');check('update center explains the failure and offers a retry',await evaluate(`${centerText}.includes("这次更新没有完成")&&[...document.querySelectorAll(".update-center-page button")].some(b=>b.innerText.includes("再试一次"))`));await click('总览','.sidebar nav');
 // Real updater state for a locked recovery (src/main/update-manager.ts lockRecovery): phase failed, recoveryPending, targetVersion = the version whose install did not complete.
 await emit({phase:'failed',recoveryPending:true,retryable:false,targetVersion:'1.2.30'});check('recovery is surfaced in the app shell without claiming a new version',await evaluate(`(()=>{const side=document.querySelector(".sidebar")?.innerText??"";return /恢复|需处理/.test(side)&&!side.includes("有新版本")})()`));
 await emit({phase:'up-to-date',targetVersion:'1.2.29'});check('completed state clears the sidebar notice',await evaluate(`!${notice}`));
 await emit({phase:'available',targetVersion:'1.2.31'});await click('预览演示');check('demo hides actual update notice',await evaluate(`!!document.querySelector(".demo-exit")&&!${notice}`));await click('演示模式 · 返回真实数据');await delay(100);check('returning to actual mode reloads the notice state',await evaluate(`${noticeText}.includes("1.2.31")`));
 check('reminders never trigger download, install, registration, or publication',onlyReads());
 writeFileSync(join(output,'result.json'),JSON.stringify({passed:failures.length===0,checks,failures,calls,platform:process.platform,windowsNative:process.platform==='win32'},null,2));
 if(failures.length){console.error(`Update reminder real App UI: ${failures.length} failed, ${checks.length} passed`);app.exit(1)}else{console.log('Update reminder real App UI checks: '+checks.length);app.exit(0)}
 }catch(e){console.error(e.message);app.exit(1)}});
}
