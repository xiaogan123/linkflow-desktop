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
 const evaluate=js=>win.webContents.executeJavaScript(js,true),check=(label,ok)=>{assert(ok,label);checks.push(label)};
 const click=async text=>{assert(await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`),'click '+text);await delay(100)};
 const emit=async next=>{state={currentVersion:'1.2.29',...next};win.webContents.send('fixture-update',state);await delay(100)};
 ipcMain.handle('fixture',async(_e,name)=>{calls.push(name);if(name==='snapshot')return evaluate('window.fixtureSnapshot()');if(name==='app:update-status'){if(holdNext){holdNext=false;const old={...state};return new Promise(resolve=>{pendingStatus=()=>resolve(old)})}return state;}throw Error('Unexpected fixture mutation '+name)});
 app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:1100,height:820,show:false,webPreferences:{preload:join(dir,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});await win.loadFile(join(dir,'index.html'));await delay(250);
 check('initial render reads local status without issuing update mutations',calls.includes('app:update-status')&&calls.every(n=>['snapshot','app:update-status'].includes(n)));
 await emit({phase:'available',targetVersion:'1.2.30'});check('new version appears above the current page and in sidebar',await evaluate('document.querySelector(".update-reminder").innerText.includes("1.2.30")&&document.querySelector(".update-nav-badge").innerText==="有更新"'));
 const output=join(process.cwd(),'.evidence/update-reminder-race');mkdirSync(output,{recursive:true});writeFileSync(join(output,'available.png'),(await win.webContents.capturePage()).toPNG());
 await click('本次暂时收起更新提醒');check('dismiss hides banner but keeps persistent sidebar reminder',await evaluate('!document.querySelector(".update-reminder")&&!!document.querySelector(".update-nav-badge")'));
 await emit({phase:'available',targetVersion:'1.2.30'});check('same version does not nag after dismissal',await evaluate('!document.querySelector(".update-reminder")'));
 await emit({phase:'available',targetVersion:'1.2.31'});check('later version shows a new reminder',await evaluate('document.querySelector(".update-reminder").innerText.includes("1.2.31")'));
 holdNext=true;await click('查看更新');assert(pendingStatus);await emit({phase:'prepared',targetVersion:'1.2.31'});const eventStateVisible=await evaluate('document.querySelector(".update-center-page").innerText.includes("更新已下载并验证")');pendingStatus();await delay(150);const staleReadOverwroteEvent=await evaluate('document.querySelector(".update-center-page").innerText.includes("新版本可以下载")'),sidebarStillPrepared=await evaluate('document.querySelector(".update-nav-badge").innerText==="待安装"');const result={eventStateVisible,staleReadOverwroteEvent,sidebarStillPrepared,externalRequests:0,externalWrites:0};assert(eventStateVisible&&!staleReadOverwroteEvent&&sidebarStillPrepared,'late initial snapshot must not overwrite newer event');
 await emit({phase:'downloading',targetVersion:'1.2.31'});holdNext=true;pendingStatus=undefined;await delay(850);assert(pendingStatus,'active polling request captured');await emit({phase:'prepared',targetVersion:'1.2.31'});pendingStatus();await delay(100);assert(await evaluate('document.querySelector(".update-center-page").innerText.includes("更新已下载并验证")'),'late polling snapshot must not overwrite prepared event');
 writeFileSync(join(output,'race-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));app.exit(0);
 }catch(e){console.error(e.message);app.exit(1)}});
}
