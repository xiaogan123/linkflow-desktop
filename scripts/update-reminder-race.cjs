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
 const {app,BrowserWindow,ipcMain}=require('electron');const dir=process.argv[2];app.setPath('userData',join(dir,'profile'));let win,state={phase:'idle',currentVersion:'1.2.29'},calls=[],holdNext=false,pendingStatus;const checks=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
 // Read-only IPC the shell may issue: the first snapshot, the local update status, and the one-time renderer readiness acknowledgement ('app:ready', answered true like main.ts does).
 const readOnly=['snapshot','app:update-status','app:ready'],mutations=()=>calls.filter(n=>!readOnly.includes(n));
 const evaluate=js=>win.webContents.executeJavaScript(js,true),check=(label,ok)=>{assert(ok,label);checks.push(label)};
 const click=async(text,scope='body')=>{assert(await evaluate(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.innerText.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`),'click '+text+' in '+scope);await delay(100)};
 const emit=async next=>{state={currentVersion:'1.2.29',...next};win.webContents.send('fixture-update',state);await delay(100)};
 // The redesigned shell shows update news as a compact sidebar notice ".sidebar-update"; its "查看" opens the update center embedded under 设置 → 更新.
 const notice='document.querySelector(".sidebar-update")',noticeText=`(${notice}?.innerText??"")`,centerText='(document.querySelector(".update-center-page")?.innerText??"")';
 ipcMain.handle('fixture',async(_e,name)=>{calls.push(name);if(name==='snapshot')return evaluate('window.fixtureSnapshot()');if(name==='app:ready')return true;if(name==='app:update-status'){if(holdNext){holdNext=false;const old={...state};return new Promise(resolve=>{pendingStatus=()=>resolve(old)})}return state;}throw Error('Unexpected fixture mutation '+name)});
 app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:1100,height:820,show:false,webPreferences:{preload:join(dir,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});await win.loadFile(join(dir,'index.html'));await delay(250);
 // Slow CI runners may not have issued the first status read or ready acknowledgement yet; wait for both, up to 5 s.
 for(let waited=0;waited<50&&!(calls.includes('app:update-status')&&calls.includes('app:ready'));waited++)await delay(100);
 check('initial render reads local status without issuing update mutations',calls.includes('app:update-status')&&!mutations().length&&calls.filter(n=>n==='app:ready').length===1);
 await emit({phase:'available',targetVersion:'1.2.30'});check('new version appears in the sidebar notice',await evaluate(`${noticeText}.includes("1.2.30")`));
 const output=join(process.cwd(),'.evidence/update-reminder-race');mkdirSync(output,{recursive:true});writeFileSync(join(output,'available.png'),(await win.webContents.capturePage()).toPNG());
 await emit({phase:'available',targetVersion:'1.2.31'});check('later version replaces the notice version',await evaluate(`${noticeText}.includes("1.2.31")&&!${noticeText}.includes("1.2.30")`));
 // Race 1: the update center's initial status read resolves after a newer pushed event.
 holdNext=true;pendingStatus=undefined;await click('查看','.sidebar-update');assert(pendingStatus,'update center initial status read captured');await emit({phase:'prepared',targetVersion:'1.2.31'});const eventStateVisible=await evaluate(`${centerText}.includes("更新已下载并验证")`);pendingStatus();await delay(150);const staleReadOverwroteEvent=await evaluate(`${centerText}.includes("新版本可以下载")`),sidebarStillAnnounced=await evaluate(`${noticeText}.includes("1.2.31")`);
 assert(eventStateVisible&&!staleReadOverwroteEvent&&sidebarStillAnnounced,'late initial snapshot must not overwrite newer event');
 // Race 2: the shell's own status read (re-read on window focus) resolves after a newer event cleared the notice; the stale read must not bring the notice back.
 holdNext=true;pendingStatus=undefined;await evaluate('window.dispatchEvent(new Event("focus"))');await delay(100);assert(pendingStatus,'shell focus status read captured');await emit({phase:'up-to-date',targetVersion:'1.2.29'});const shellClearedByEvent=await evaluate(`!${notice}`);pendingStatus();await delay(150);const shellStaleReadResurrected=await evaluate(`!!${notice}`);
 assert(shellClearedByEvent&&!shellStaleReadResurrected,'late shell status read must not overwrite newer event');
 // Race 3: an active-phase polling read resolves after a newer pushed event.
 await emit({phase:'downloading',targetVersion:'1.2.31'});holdNext=true;pendingStatus=undefined;await delay(850);assert(pendingStatus,'active polling request captured');await emit({phase:'prepared',targetVersion:'1.2.31'});pendingStatus();await delay(100);const pollingStaleOverwrote=!await evaluate(`${centerText}.includes("更新已下载并验证")`);assert(!pollingStaleOverwrote,'late polling snapshot must not overwrite prepared event');
 const writes=mutations();assert(!writes.length,'race flows never issue update mutations: '+writes.join(','));
 const result={eventStateVisible,staleReadOverwroteEvent,sidebarStillAnnounced,shellClearedByEvent,shellStaleReadResurrected,pollingStaleOverwrote,checks,ipcCalls:calls.length,externalRequests:writes.length,externalWrites:writes.length};
 writeFileSync(join(output,'race-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));app.exit(0);
 }catch(e){console.error(e.message);app.exit(1)}});
}
